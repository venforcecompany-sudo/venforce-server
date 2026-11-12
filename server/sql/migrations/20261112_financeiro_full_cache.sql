-- server/sql/migrations/20261112_financeiro_full_cache.sql
-- Financeiro V3 — campo FULL do Fechamento preenchido pelo faturamento do ML.
--
-- Uma linha = o custo do Full (armazenagem, armazenamento prolongado, coleta,
-- retirada/descarte) de UMA conta ML (cliente_conta_id) numa competência
-- (mes_ref YYYY-MM), somado pela data de cada lançamento, como a API de
-- billing devolveu na última consulta. Existe para o drawer "Preparar
-- fechamento" abrir com o valor na hora: a leitura no ML pagina milhares de
-- lançamentos e passa de 20 s.
--
-- `componentes` guarda o total por grupo (armazenagem, coleta, ...) com os
-- subtipos do ML (CFWA, CFBA, ...) para a legenda e a auditoria; `faturas`
-- as faturas lidas ({ key, status }). `definitivo` = todas as faturas que
-- podem trazer lançamentos do mês já estavam fechadas na consulta.
--
-- Aditiva e idempotente: aplicada no boot por
-- schemaEnsure.ensureFinanceiroFullCacheSchema (serializada por advisory lock).
-- Nenhuma tabela existente é alterada.

CREATE TABLE IF NOT EXISTS financeiro_full_cache (
  cliente_conta_id  BIGINT NOT NULL,
  mes_ref           TEXT NOT NULL,
  cliente_slug      TEXT NOT NULL,
  custo_full        NUMERIC(14,2) NOT NULL DEFAULT 0,
  lancamentos       INTEGER NOT NULL DEFAULT 0,
  componentes       JSONB NOT NULL DEFAULT '[]'::jsonb,
  faturas           JSONB NOT NULL DEFAULT '[]'::jsonb,
  definitivo        BOOLEAN NOT NULL DEFAULT FALSE,
  consultado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cliente_conta_id, mes_ref)
);
