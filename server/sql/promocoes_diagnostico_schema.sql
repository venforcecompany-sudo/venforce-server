-- server/sql/promocoes_diagnostico_schema.sql
-- Diagnóstico assíncrono de promoções (tela Promoções ML).
--
-- Segue o mesmo padrão do "diagnóstico completo" (tabela `relatorios`): o
-- cabeçalho `promocoes_diagnosticos` É o registro do JOB e também o snapshot.
-- Um POST /diagnostico/start cria a linha com status='processando'; um worker
-- em background varre as promoções, grava as linhas em lotes e atualiza o
-- progresso; ao terminar, marca status='concluido' (ou 'erro'). O último
-- registro 'concluido' por cliente/base é o snapshot reutilizável.
--
-- Não altera nada no ML: é apenas leitura do ML + gravação no nosso banco.
-- Aplicado de forma idempotente via ensurePromocoesDiagnosticoTables().

CREATE TABLE IF NOT EXISTS promocoes_diagnosticos (
  id                        BIGSERIAL PRIMARY KEY,
  user_id                   BIGINT,
  cliente_id                BIGINT,
  cliente_slug              TEXT NOT NULL,
  base_id                   BIGINT,
  base_slug                 TEXT NOT NULL,
  seller_id                 TEXT,
  margem_alvo               NUMERIC,
  tolerancia                NUMERIC,
  -- Estado do job: processando | concluido | erro.
  status                    TEXT NOT NULL DEFAULT 'processando',
  -- Progresso da varredura (para o polling do front).
  itens_processados         INTEGER NOT NULL DEFAULT 0,
  total_estimado            INTEGER,
  -- Totais do diagnóstico (preenchidos ao concluir).
  total_promocoes           INTEGER NOT NULL DEFAULT 0,
  total_com_retorno         INTEGER NOT NULL DEFAULT 0,
  total_sem_retorno         INTEGER NOT NULL DEFAULT 0,
  total_criadas_por_mim     INTEGER NOT NULL DEFAULT 0,
  total_entrar_seguro       INTEGER NOT NULL DEFAULT 0,
  total_entrar_tolerancia   INTEGER NOT NULL DEFAULT 0,
  total_nao_entrar          INTEGER NOT NULL DEFAULT 0,
  total_dados_incompletos   INTEGER NOT NULL DEFAULT 0,
  -- itens_scaneados = quantos anúncios ativos foram varridos.
  itens_scaneados           INTEGER NOT NULL DEFAULT 0,
  -- parcial = true quando a varredura terminou com erro parcial (guardou o que deu).
  parcial                   BOOLEAN NOT NULL DEFAULT false,
  aviso                     TEXT,
  origem                    TEXT NOT NULL DEFAULT 'scan',
  payload_resumo            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migração idempotente: se a tabela já existir de uma versão anterior sem as
-- colunas de job, adiciona-as sem quebrar dados existentes.
ALTER TABLE promocoes_diagnosticos ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'processando';
ALTER TABLE promocoes_diagnosticos ADD COLUMN IF NOT EXISTS itens_processados INTEGER NOT NULL DEFAULT 0;
ALTER TABLE promocoes_diagnosticos ADD COLUMN IF NOT EXISTS total_estimado INTEGER;
ALTER TABLE promocoes_diagnosticos ADD COLUMN IF NOT EXISTS aviso TEXT;

CREATE INDEX IF NOT EXISTS idx_promo_diag_cliente_base
  ON promocoes_diagnosticos (cliente_slug, base_slug, status, created_at DESC);

CREATE TABLE IF NOT EXISTS promocoes_diagnostico_itens (
  id                    BIGSERIAL PRIMARY KEY,
  diagnostico_id        BIGINT NOT NULL REFERENCES promocoes_diagnosticos(id) ON DELETE CASCADE,
  item_id               TEXT,
  titulo                TEXT,
  campanha              TEXT,
  campanha_id           TEXT,
  tipo_promocao         TEXT,
  criada_por_mim        BOOLEAN,
  origem_promocao       TEXT,
  preco_original        NUMERIC,
  preco_promocao        NUMERIC,
  desconto_total        NUMERIC,
  seller_percentage     NUMERIC,
  meli_percentage       NUMERIC,
  retorno_ml            NUMERIC,
  custo                 NUMERIC,
  frete                 NUMERIC,
  imposto_percentual    NUMERIC,
  taxa_fixa             NUMERIC,
  comissao_percentual   NUMERIC,
  comissao_valor        NUMERIC,
  lc_com_retorno        NUMERIC,
  mc_com_retorno        NUMERIC,
  margem_alvo           NUMERIC,
  diferenca_pp          NUMERIC,
  decisao               TEXT,
  motivo                TEXT,
  -- payload_raw guarda a "linha" completa como o frontend a consome, para que ao
  -- carregar o snapshot a tela renderize idêntico ao momento da varredura.
  payload_raw           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promo_diag_itens_diag
  ON promocoes_diagnostico_itens (diagnostico_id);
