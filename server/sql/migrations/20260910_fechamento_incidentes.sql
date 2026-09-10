-- Caixa-preta do fechamento financeiro: preserva, de forma temporária,
-- os arquivos e o diagnóstico de fechamentos MELI/Shopee/TikTok que
-- apresentaram anomalia (custo não encontrado, identidade ambígua,
-- cobertura incompleta) ou lançaram exceção.
--
-- Aditiva. Não altera nenhuma tabela existente.
-- Idempotente: pode ser executado mais de uma vez sem duplicar nada.
-- Aplicação: manual (mesmo padrão de 20260817_cliente_contas_foundation.sql).
-- O boot do servidor também garante estas tabelas via
-- repositories/fechamentoIncidenteRepository.js (ensureFechamentoIncidenteTables).

BEGIN;

CREATE TABLE IF NOT EXISTS fechamento_incidentes (
  id SERIAL PRIMARY KEY,
  codigo TEXT,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  cliente_slug TEXT,
  cliente_conta_id INTEGER REFERENCES cliente_contas(id) ON DELETE SET NULL,
  marketplace TEXT NOT NULL,
  periodo TEXT,
  usuario_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  trigger_tipo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'aberto',
  resumo_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  diagnostico_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  resolved_at TIMESTAMP
);

DO $$
BEGIN
  ALTER TABLE fechamento_incidentes ADD CONSTRAINT fechamento_incidentes_status_check
    CHECK (status IN ('aberto', 'em_analise', 'resolvido'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE fechamento_incidentes ADD CONSTRAINT fechamento_incidentes_marketplace_check
    CHECK (marketplace IN ('meli', 'shopee', 'tiktok'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_fechamento_incidentes_codigo
  ON fechamento_incidentes (codigo) WHERE codigo IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fechamento_incidentes_expires_at
  ON fechamento_incidentes (expires_at);
CREATE INDEX IF NOT EXISTS idx_fechamento_incidentes_cliente
  ON fechamento_incidentes (cliente_id);
CREATE INDEX IF NOT EXISTS idx_fechamento_incidentes_created_at
  ON fechamento_incidentes (created_at DESC);

CREATE TABLE IF NOT EXISTS fechamento_incidente_arquivos (
  id SERIAL PRIMARY KEY,
  incidente_id INTEGER NOT NULL REFERENCES fechamento_incidentes(id) ON DELETE CASCADE,
  tipo_arquivo TEXT NOT NULL,
  nome_original TEXT NOT NULL,
  mime_type TEXT,
  tamanho_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  conteudo BYTEA,
  conteudo_truncado BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fechamento_incidente_arquivos_incidente
  ON fechamento_incidente_arquivos (incidente_id);

COMMIT;

-- ============================================================
-- `codigo` é preenchido em uma segunda escrita (UPDATE codigo = 'FIN-' || id)
-- logo após o INSERT, dentro da mesma chamada de
-- fechamentoIncidenteRepository.createIncidente — por isso a coluna é
-- nullable no schema mas nunca fica NULL para quem lê pela API.
-- ============================================================
