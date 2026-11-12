-- server/sql/migrations/20261112_venforce_resgate.sql
-- VenForce Resgate — resultados da auditoria financeira (somente o VenForce
-- escreve aqui; nada vai ao Mercado Livre). Aditiva e idempotente.
-- NÃO é aplicada no boot: aplicar manualmente, com autorização, antes de ligar
-- RESGATE_AUDITORIA_ENABLED. Sem estas tabelas as rotas /resgate respondem 503.

BEGIN;
SELECT pg_advisory_xact_lock(hashtext('venforce_resgate_migration'));

CREATE TABLE IF NOT EXISTS resgate_execucoes (
  id            BIGSERIAL PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'em_andamento'
                CHECK (status IN ('em_andamento','concluida','cancelada','erro')),
  parametros    JSONB NOT NULL DEFAULT '{}'::jsonb,
  resumo        JSONB,
  iniciada_por  BIGINT,
  cancelar      BOOLEAN NOT NULL DEFAULT FALSE,
  iniciada_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_em  TIMESTAMPTZ,
  finalizada_em TIMESTAMPTZ
);
-- No máximo UMA execução em andamento (sem jobs pesados simultâneos).
CREATE UNIQUE INDEX IF NOT EXISTS uq_resgate_execucoes_em_andamento ON resgate_execucoes ((true)) WHERE status = 'em_andamento';

CREATE TABLE IF NOT EXISTS resgate_contas_resultado (
  execucao_id      BIGINT NOT NULL REFERENCES resgate_execucoes(id) ON DELETE CASCADE,
  cliente_conta_id BIGINT NOT NULL,
  cliente_id       BIGINT,
  resumo           JSONB,
  matriz           JSONB,
  checkpoint       JSONB,
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (execucao_id, cliente_conta_id)
);

CREATE TABLE IF NOT EXISTS resgate_itens (
  execucao_id      BIGINT NOT NULL REFERENCES resgate_execucoes(id) ON DELETE CASCADE,
  cliente_conta_id BIGINT NOT NULL,
  item_id          TEXT NOT NULL,
  cliente_id       BIGINT,
  situacao         TEXT NOT NULL,
  acao             TEXT NOT NULL,
  origem           TEXT NOT NULL,
  prioridade       INTEGER NOT NULL DEFAULT 0,
  mudanca_recente  BOOLEAN NOT NULL DEFAULT FALSE,
  unidades_30d     NUMERIC(14,2),
  exposicao        NUMERIC(14,2),
  resultado        JSONB NOT NULL,
  revisao_status   TEXT NOT NULL DEFAULT 'PENDENTE'
                   CHECK (revisao_status IN ('PENDENTE','APROVADO','REJEITADO','AJUSTADO','INVALIDADO')),
  revisao_por      BIGINT,
  revisao_em       TIMESTAMPTZ,
  revisao_nota     TEXT,
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (execucao_id, cliente_conta_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_resgate_itens_prioridade ON resgate_itens (execucao_id, cliente_conta_id, prioridade DESC, item_id);
CREATE INDEX IF NOT EXISTS idx_resgate_itens_situacao ON resgate_itens (execucao_id, cliente_conta_id, situacao);

CREATE TABLE IF NOT EXISTS resgate_config_contas (
  cliente_conta_id BIGINT PRIMARY KEY,
  meta_margem      NUMERIC(6,4) CHECK (meta_margem IS NULL OR (meta_margem >= 0 AND meta_margem < 1)),
  limite_variacao  NUMERIC(6,4) CHECK (limite_variacao IS NULL OR (limite_variacao > 0 AND limite_variacao <= 1)),
  nota             TEXT,
  atualizado_por   BIGINT,
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
