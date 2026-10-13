-- server/sql/migrations/20261013_fechamento_snapshots.sql
-- Financeiro V3 — SNAPSHOT do fechamento (docs/financeiro/SNAPSHOT_FECHAMENTO_V3.md).
--
-- Um snapshot é "o estado financeiro calculado pelo motor naquele momento",
-- por conta × competência × revisão. Separa o HISTÓRICO FINANCEIRO da
-- APRESENTAÇÃO ao cliente (entregas_cliente), que passa a apontar para ele.
--
-- ADITIVA: cria 2 tabelas novas e 1 coluna NULLABLE em entregas_cliente.
-- Nenhuma linha existente é alterada; não há backfill (entrega antiga fica
-- com snapshot_id NULL — que é a verdade sobre ela).
-- FONTE do DDL (lida por schemaEnsure.ensureFechamentoSnapshotsSchema no
-- boot, numa transação com pg_advisory_xact_lock). Idempotente. NÃO executar
-- à mão em produção: o boot aplica.
--
-- Rollback (nenhuma tabela existente depende das novas):
--   ALTER TABLE entregas_cliente DROP COLUMN IF EXISTS snapshot_id;
--   DROP TABLE IF EXISTS fechamento_snapshot_itens, fechamento_snapshots;
--   DROP FUNCTION IF EXISTS fechamento_snapshot_recusar_update();

-- ─── Snapshot (1 linha por revisão) ─────────────────────────────────────────
-- Identidade: cliente_conta_id + periodo + revisao. A conta já implica o
-- cliente e o marketplace; cliente_id/cliente_slug/marketplace são cópias
-- para leitura, autorização e purge.
--
-- Sem FK para users de propósito: uma FK ON DELETE SET NULL viraria UPDATE
-- (recusado pelo trigger de imutabilidade) e travaria a remoção de usuário.
-- O e-mail fica copiado para a auditoria sobreviver à remoção.
--
-- FK para cliente_contas SEM ação (NO ACTION, checada no fim do comando):
-- apagar uma conta isolada com snapshots é recusado (histórico financeiro não
-- some por efeito colateral); no purge do cliente, conta e snapshots caem no
-- MESMO comando (CASCADE de clientes) e a checagem passa.
CREATE TABLE IF NOT EXISTS fechamento_snapshots (
  id                 BIGSERIAL PRIMARY KEY,
  cliente_id         INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  cliente_slug       VARCHAR(255) NOT NULL,
  cliente_conta_id   INTEGER NOT NULL,
  marketplace        VARCHAR(20) NOT NULL,
  periodo            VARCHAR(7) NOT NULL,
  revisao            INTEGER NOT NULL,
  -- O que o motor devolveu, como devolveu. Composição, cobertura e
  -- reconciliação são LEITURAS do summary (frontend), não cópias.
  summary_json       JSONB NOT NULL,
  -- costsSource ("base" | "upload"), base {id, slug, nome} e a impressão
  -- digital das linhas de custo usadas (linhas, sha256).
  origem_custos_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- ADS, Venforce, afiliados, FULL, custos adicionais — como o motor recebeu.
  ajustes_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Manifesto dos arquivos: [{tipo, nomeOriginal, sha256, tamanhoBytes,
  -- mimeType, origem}]. Sem binário (não existe storage persistente).
  arquivos_json      JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- competencia declarada, unmatchedIds/unmatchedCosts, avisos do motor…
  diagnostico_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Contagem das linhas por status (derivada na gravação; imutável).
  contagens_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_itens        INTEGER NOT NULL,
  -- HMAC do processamento (seloProcessamento.js): prova de que o conteúdo é
  -- a saída do motor, não um número montado no navegador.
  selo               VARCHAR(64) NOT NULL,
  origem             VARCHAR(40) NOT NULL DEFAULT 'financeiro-v3',
  processado_em      TIMESTAMPTZ NOT NULL,
  processado_por     INTEGER,
  criado_por         INTEGER,
  criado_por_email   TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_fechamento_snapshots_marketplace CHECK (marketplace IN ('meli', 'shopee', 'tiktok')),
  CONSTRAINT ck_fechamento_snapshots_periodo CHECK (periodo ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT ck_fechamento_snapshots_revisao CHECK (revisao >= 1),
  CONSTRAINT ck_fechamento_snapshots_total CHECK (total_itens >= 0),
  -- Também é o índice de "revisões de uma conta/competência" e do histórico
  -- da conta (prefixo cliente_conta_id).
  CONSTRAINT uq_fechamento_snapshots_revisao UNIQUE (cliente_conta_id, periodo, revisao)
);

-- FK do cascade de clientes precisa de índice (o purge varre por cliente_id).
CREATE INDEX IF NOT EXISTS idx_fechamento_snapshots_cliente ON fechamento_snapshots (cliente_id);

DO $$
BEGIN
  IF to_regclass('public.cliente_contas') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fechamento_snapshots_conta')
  THEN
    ALTER TABLE fechamento_snapshots
      ADD CONSTRAINT fk_fechamento_snapshots_conta
      FOREIGN KEY (cliente_conta_id) REFERENCES cliente_contas(id);
  END IF;
END
$$;

-- ─── Itens (TODAS as linhas do motor, sem o limite de 50) ──────────────────
-- `linha` é a linha do motor EXATA (é ela que a tela re-normaliza). As
-- colunas tipadas são extraídas na gravação só para paginar, filtrar e buscar
-- no backend — nenhum número é recalculado (fechamentoSnapshot/itemDoSnapshot.js).
CREATE TABLE IF NOT EXISTS fechamento_snapshot_itens (
  snapshot_id        BIGINT NOT NULL REFERENCES fechamento_snapshots(id) ON DELETE CASCADE,
  ordem              INTEGER NOT NULL,
  formato            VARCHAR(30) NOT NULL,
  titulo             TEXT,
  item_id            TEXT,
  model_id           TEXT,
  sku                TEXT,
  pedido_id          TEXT,
  receita            NUMERIC,
  lc                 NUMERIC,
  mc                 NUMERIC,
  status_custo       VARCHAR(20) NOT NULL,
  status_financeiro  VARCHAR(20) NOT NULL,
  status_principal   VARCHAR(30) NOT NULL,
  cancelado          BOOLEAN NOT NULL DEFAULT false,
  busca              TEXT NOT NULL DEFAULT '',
  linha              JSONB NOT NULL,
  PRIMARY KEY (snapshot_id, ordem)
);

-- Filtro por status dentro de um snapshot (contagens e "só sem custo").
CREATE INDEX IF NOT EXISTS idx_fechamento_snapshot_itens_status
  ON fechamento_snapshot_itens (snapshot_id, status_principal);

-- ─── Imutabilidade ───────────────────────────────────────────────────────────
-- O repositório só faz INSERT/SELECT; o trigger garante o mesmo no banco.
-- DELETE continua possível (CASCADE do purge de cliente).
CREATE OR REPLACE FUNCTION fechamento_snapshot_recusar_update() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'Snapshot de fechamento é imutável (%): crie uma nova revisão.', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END
$fn$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_fechamento_snapshots_imutavel') THEN
    CREATE TRIGGER trg_fechamento_snapshots_imutavel
      BEFORE UPDATE ON fechamento_snapshots
      FOR EACH ROW EXECUTE FUNCTION fechamento_snapshot_recusar_update();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_fechamento_snapshot_itens_imutavel') THEN
    CREATE TRIGGER trg_fechamento_snapshot_itens_imutavel
      BEFORE UPDATE ON fechamento_snapshot_itens
      FOR EACH ROW EXECUTE FUNCTION fechamento_snapshot_recusar_update();
  END IF;
END
$$;

-- ─── Entrega → snapshot ──────────────────────────────────────────────────────
-- A apresentação aponta para a revisão financeira que ela mostra. NULLABLE:
-- entrega antiga (anterior ao snapshot) continua lida pelo payload_json.
-- ON DELETE SET NULL: o snapshot só some no purge do cliente, e o purge não
-- pode ser bloqueado por uma entrega órfã.
-- Guardado por to_regclass: o boot aplica esta migration DEPOIS de
-- ensureEntregasClienteSchema, mas uma base sem entregas_cliente (teste) não
-- pode falhar aqui.
DO $$
BEGIN
  IF to_regclass('public.entregas_cliente') IS NOT NULL THEN
    ALTER TABLE entregas_cliente ADD COLUMN IF NOT EXISTS snapshot_id BIGINT;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_entregas_cliente_snapshot') THEN
      ALTER TABLE entregas_cliente
        ADD CONSTRAINT fk_entregas_cliente_snapshot
        FOREIGN KEY (snapshot_id) REFERENCES fechamento_snapshots(id) ON DELETE SET NULL;
    END IF;
    CREATE INDEX IF NOT EXISTS idx_entregas_cliente_snapshot ON entregas_cliente (snapshot_id);
  END IF;
END
$$;
