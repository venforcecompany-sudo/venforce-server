CREATE TABLE IF NOT EXISTS central_vendas_imports (
  id BIGSERIAL PRIMARY KEY,
  cliente_id BIGINT,
  cliente_slug TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'meli',
  competencia CHAR(7) NOT NULL,
  fonte TEXT NOT NULL DEFAULT 'planilha_vendas',
  status TEXT NOT NULL DEFAULT 'processado',
  confianca TEXT,
  resumo_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS central_vendas_pedidos (
  id BIGSERIAL PRIMARY KEY,
  import_id BIGINT REFERENCES central_vendas_imports(id) ON DELETE CASCADE,
  cliente_id BIGINT,
  cliente_slug TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'meli',
  competencia CHAR(7) NOT NULL,
  pedido_id TEXT NOT NULL,
  pack_id TEXT,
  shipment_id TEXT,
  data_pedido DATE,
  status TEXT,
  confianca TEXT NOT NULL,
  quantidade_itens NUMERIC(14,4),
  faturamento NUMERIC(14,2),
  lucro_contribuicao NUMERIC(14,2),
  resultado NUMERIC(14,2),
  margem_contribuicao_percentual NUMERIC(10,4),
  pendencias_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (import_id, pedido_id)
);

CREATE TABLE IF NOT EXISTS central_vendas_pedido_itens (
  id BIGSERIAL PRIMARY KEY,
  import_id BIGINT REFERENCES central_vendas_imports(id) ON DELETE CASCADE,
  pedido_row_id BIGINT REFERENCES central_vendas_pedidos(id) ON DELETE CASCADE,
  cliente_id BIGINT,
  cliente_slug TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'meli',
  competencia CHAR(7) NOT NULL,
  pedido_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  mlb TEXT,
  sku TEXT,
  titulo TEXT,
  quantidade NUMERIC(14,4),
  valor_unitario NUMERIC(14,2),
  receita_produto NUMERIC(14,2),
  custo_produto NUMERIC(14,2),
  imposto_interno NUMERIC(14,2),
  lucro_contribuicao NUMERIC(14,2),
  resultado NUMERIC(14,2),
  margem_contribuicao_percentual NUMERIC(10,4),
  confianca TEXT NOT NULL,
  pendencias_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (import_id, item_id)
);

CREATE TABLE IF NOT EXISTS central_vendas_componentes (
  id BIGSERIAL PRIMARY KEY,
  import_id BIGINT REFERENCES central_vendas_imports(id) ON DELETE CASCADE,
  pedido_row_id BIGINT REFERENCES central_vendas_pedidos(id) ON DELETE CASCADE,
  item_row_id BIGINT REFERENCES central_vendas_pedido_itens(id) ON DELETE CASCADE,
  cliente_id BIGINT,
  cliente_slug TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'meli',
  competencia CHAR(7) NOT NULL,
  pedido_id TEXT NOT NULL,
  item_id TEXT,
  tipo TEXT NOT NULL,
  valor NUMERIC(14,2),
  fonte TEXT,
  confianca TEXT NOT NULL,
  obs TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Identidade da execução (Fundação Cliente/Contas — M1 da Central de Vendas
-- V3). Aditivo e nullable: snapshots antigos ficam com esses campos NULL
-- ("account_context = unresolved" para efeitos de auditoria), nunca
-- atribuídos retroativamente por adivinhação.
ALTER TABLE central_vendas_imports
  ADD COLUMN IF NOT EXISTS cliente_conta_id BIGINT REFERENCES cliente_contas(id) ON DELETE SET NULL;
ALTER TABLE central_vendas_imports
  ADD COLUMN IF NOT EXISTS base_id BIGINT REFERENCES bases(id) ON DELETE SET NULL;
ALTER TABLE central_vendas_imports
  ADD COLUMN IF NOT EXISTS base_resolution_mode TEXT;
ALTER TABLE central_vendas_imports
  ADD COLUMN IF NOT EXISTS grant_id BIGINT REFERENCES ml_tokens(id) ON DELETE SET NULL;
ALTER TABLE central_vendas_imports
  ADD COLUMN IF NOT EXISTS external_account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_central_vendas_imports_cliente_conta
  ON central_vendas_imports (cliente_conta_id, competencia);

CREATE INDEX IF NOT EXISTS idx_central_vendas_imports_cliente_comp
  ON central_vendas_imports (cliente_slug, competencia, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_central_vendas_pedidos_import
  ON central_vendas_pedidos (import_id, data_pedido, pedido_id);

CREATE INDEX IF NOT EXISTS idx_central_vendas_itens_import
  ON central_vendas_pedido_itens (import_id, pedido_id);

CREATE INDEX IF NOT EXISTS idx_central_vendas_componentes_import
  ON central_vendas_componentes (import_id, pedido_id, item_id);

-- M10 — os índices acima cobrem (import_id, ...), mas o padrão de query real
-- da Read API (centralVendasRepository.loadPedidosByImportIds/
-- getPedidoDetailByRowId) filtra itens/componentes por `pedido_row_id`
-- (WHERE pedido_row_id = ANY(...) na carga do período inteiro, WHERE
-- pedido_row_id = $1 no detalhe de 1 pedido) — nenhum índice existente cobre
-- essa coluna, forçando seq scan nas duas tabelas em toda leitura. Evidência
-- é o padrão de query (auditado no código, não EXPLAIN ANALYZE real — sem
-- Postgres vivo neste ambiente); índice puro, não muda nenhuma semântica.
CREATE INDEX IF NOT EXISTS idx_central_vendas_itens_pedido_row
  ON central_vendas_pedido_itens (pedido_row_id);

CREATE INDEX IF NOT EXISTS idx_central_vendas_componentes_pedido_row
  ON central_vendas_componentes (pedido_row_id);

-- FK item_row_id (ON DELETE CASCADE) sem índice: cada item apagado fazia um seq
-- scan em componentes (3,4 mi linhas, 2 GB). Derrubou por statement_timeout o
-- 1º lote da retenção em produção (30/10/2026, 186 itens, nada removido).
-- Em produção, criar ANTES pela migration 20261030 (CONCURRENTLY); aqui vira no-op.
CREATE INDEX IF NOT EXISTS idx_central_vendas_componentes_item_row
  ON central_vendas_componentes (item_row_id);

-- ---------------------------------------------------------------------------
-- M2 — Sync Run persistido (Central de Vendas V3)
--
-- Uma linha = uma tentativa de sincronizar UMA conta de marketplace em UM
-- intervalo. Não é o snapshot nem o fechamento — é a execução que produziu ou
-- tentou produzir dados. Identidade (cliente_conta_id/grant_id/base_id/
-- external_account_id) é resolvida uma única vez na criação e nunca
-- re-resolvida durante o processamento (ver centralVendasSyncRunService).
--
-- status: queued -> running -> (completed | failed). Nunca volta de um
-- estado final para running. published/partial/truncated pertencem a M3/M4 e
-- não são usados aqui.
CREATE TABLE IF NOT EXISTS central_vendas_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  cliente_id BIGINT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  cliente_slug TEXT NOT NULL,
  cliente_conta_id BIGINT REFERENCES cliente_contas(id) ON DELETE SET NULL,
  marketplace TEXT NOT NULL DEFAULT 'meli',
  external_account_id TEXT,
  grant_id BIGINT REFERENCES ml_tokens(id) ON DELETE SET NULL,
  base_id BIGINT REFERENCES bases(id) ON DELETE SET NULL,
  base_resolution_mode TEXT,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  requested_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Impede dois runs queued/running simultâneos para a mesma
-- conta+marketplace+período — proteção real contra corrida de dois cliques.
--
-- BUG corrigido no hardening M1/M2: um índice único padrão do Postgres
-- trata NULL como distinto de NULL, então o índice original (sem COALESCE)
-- NÃO protegia dois runs legados com cliente_conta_id = NULL para o mesmo
-- cliente/marketplace/período — eles podiam coexistir mesmo com o índice
-- "único" no ar. COALESCE(cliente_conta_id, 0) fecha esse buraco (0 é
-- impossível como id de cliente_conta: BIGSERIAL começa em 1).
--
-- Antes de recriar o índice, saneia com segurança eventuais duplicatas que
-- o bug possa ter deixado ativas: mantém só o run mais recente de cada
-- grupo como queued/running e marca os demais como failed (nunca deleta —
-- o histórico continua auditável). Idempotente: sem duplicatas, é um
-- no-op. Roda toda vez que ensureCentralVendasTables() é chamado, mas o
-- custo é proporcional ao número de runs ativos (tabela pequena).
WITH duplicados_legado AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY cliente_id, COALESCE(cliente_conta_id, 0), marketplace, date_from, date_to
           ORDER BY id DESC
         ) AS rn
    FROM central_vendas_sync_runs
   WHERE status IN ('queued', 'running')
)
UPDATE central_vendas_sync_runs r
   SET status = 'failed', finished_at = NOW(), updated_at = NOW(),
       error_code = 'SYNC_RUN_DEDUPE_LEGACY_NULL',
       error_message = 'Run duplicado (indice unico anterior nao cobria cliente_conta_id NULL); superado por um run mais recente equivalente.'
  FROM duplicados_legado d
 WHERE r.id = d.id AND d.rn > 1;

DROP INDEX IF EXISTS uq_central_vendas_sync_runs_ativo;

CREATE UNIQUE INDEX IF NOT EXISTS uq_central_vendas_sync_runs_ativo_v2
  ON central_vendas_sync_runs (cliente_id, COALESCE(cliente_conta_id, 0), marketplace, date_from, date_to)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_central_vendas_sync_runs_cliente
  ON central_vendas_sync_runs (cliente_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_central_vendas_sync_runs_conta_status
  ON central_vendas_sync_runs (cliente_conta_id, marketplace, status);

ALTER TABLE central_vendas_imports
  ADD COLUMN IF NOT EXISTS sync_run_id BIGINT REFERENCES central_vendas_sync_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_central_vendas_imports_sync_run
  ON central_vendas_imports (sync_run_id);

-- ---------------------------------------------------------------------------
-- M3 — Completude por fonte (Central de Vendas V3)
--
-- Uma linha = o resultado da coleta de UMA fonte (orders/shipments/claims/
-- returns/base) dentro de UMA execução (central_vendas_sync_runs). Isto é um
-- eixo SEPARADO do status técnico do run (M2): um run pode terminar
-- 'completed' e ainda assim ter uma fonte 'incomplete'/'failed' — ver
-- centralVendasSyncSourceService e docs/CENTRAL_VENDAS_V3_ARQUITETURA.md.
--
-- status: pending -> running -> (complete | incomplete | failed |
-- not_applicable). Guarda de transição no service: nunca terminal ->
-- terminal silenciosamente (mesmo espírito do M2). `complete` NÃO é
-- sinônimo de "dado financeiro presente" — ver seção 7 da spec do M3.
CREATE TABLE IF NOT EXISTS central_vendas_sync_sources (
  id BIGSERIAL PRIMARY KEY,
  sync_run_id BIGINT NOT NULL REFERENCES central_vendas_sync_runs(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  complete BOOLEAN,
  expected_count INTEGER,
  received_count INTEGER,
  pages_expected INTEGER,
  pages_received INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error_code TEXT,
  http_status INTEGER,
  error_message TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sync_run_id, source)
);

CREATE INDEX IF NOT EXISTS idx_central_vendas_sync_sources_run
  ON central_vendas_sync_sources (sync_run_id);

-- Cache de conveniência: SEMPRE derivado de central_vendas_sync_sources via
-- calcularCompletudeDoRun (nunca escrito de outro lugar). run.status
-- continua queued/running/completed/failed (M2, inalterado) — este é o eixo
-- separado: um run completed pode ter completeness_status = 'partial'.
ALTER TABLE central_vendas_sync_runs
  ADD COLUMN IF NOT EXISTS completeness_status TEXT;

-- ---------------------------------------------------------------------------
-- M4 — Candidate / Published (Central de Vendas V3)
--
-- Separa "dado produzido por uma sincronização" de "dado oficial que a
-- Central pode exibir". Todo import nasce candidate (via sync_run) ou legacy
-- (planilha, ou qualquer import pré-M4); só vira published quando promovido
-- por centralVendasPublicationService.publicarRun — nunca dentro do
-- collector. Ver docs/CENTRAL_VENDAS_V3_ARQUITETURA.md seção 12.
--
-- DEFAULT 'legacy' aplica-se retroativamente a TODAS as linhas já existentes
-- na tabela — deliberado (seção 1 da spec M4): snapshots antigos nunca são
-- marcados published por adivinhação, viram legacy explicitamente e seguem
-- elegíveis para o fallback (nunca para o caminho "oficial published").
ALTER TABLE central_vendas_imports
  ADD COLUMN IF NOT EXISTS publication_status TEXT NOT NULL DEFAULT 'legacy';

-- Cobertura REAL do snapshot (seção 5) — nunca a competência inteira quando
-- o sync só cobriu um pedaço dela. NULL em linhas legadas (nunca inferido
-- por adivinhação); toda linha nova produzida por sync_run grava a
-- interseção do intervalo do run com o mês da competência.
ALTER TABLE central_vendas_imports
  ADD COLUMN IF NOT EXISTS coverage_date_from DATE;
ALTER TABLE central_vendas_imports
  ADD COLUMN IF NOT EXISTS coverage_date_to DATE;

ALTER TABLE central_vendas_imports
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_central_vendas_imports_publicacao
  ON central_vendas_imports (cliente_slug, marketplace, competencia, publication_status);

-- ---------------------------------------------------------------------------
-- M6 — Ledger financeiro auditável (Central de Vendas V3)
--
-- central_vendas_componentes já era, desde antes do M1, a evidência
-- item-a-item do resultado. M6 auditou e confirmou que essa tabela é a
-- estrutura canônica do ledger — não cria tabela paralela. Três colunas
-- aditivas tornam a natureza de cada componente EXPLÍCITA (nunca inferida só
-- pelo sinal de `valor`):
--
--   escopo                 'item' | 'pedido'    — deriva de item_id (fato já
--                          persistido, nunca reinterpretado)
--   efeito                 'credito' | 'debito'  — natureza conceitual do
--                          tipo, fixa e igual nas duas origens (API/planilha)
--   incluido_no_resultado  BOOLEAN — se este componente entra na fórmula do
--                          Resultado Parcial DAQUELE motor que o produziu
--
-- IMPORTANTE (achado do M6, auditado empiricamente contra os dois motores —
-- ver docs/CENTRAL_VENDAS_V3_ARQUITETURA.md seção 14 e
-- centralVendasComponenteLedger.js): incluido_no_resultado É uma função pura
-- de `tipo`, igual nas duas origens (API-first e planilha) — os cinco tipos
-- do item (receita_produto/tarifa_venda/custo_produto/imposto_interno/
-- frete_seller) somam exatamente ao resultado_item nos dois motores quando o
-- item é calculável. Gap documentado (não corrigido aqui): no motor de
-- planilha, um pedido com a pendência pré-existente `ajuste_plataforma_presente`
-- tem um resíduo que nenhum componente persistido captura — a soma deixa de
-- bater com resultado_item exatamente por esse valor. Ver o teste que
-- reproduz isso em server/tests/centralVendasComponenteLedger.test.js.
ALTER TABLE central_vendas_componentes ADD COLUMN IF NOT EXISTS escopo TEXT;
ALTER TABLE central_vendas_componentes ADD COLUMN IF NOT EXISTS efeito TEXT;
ALTER TABLE central_vendas_componentes ADD COLUMN IF NOT EXISTS incluido_no_resultado BOOLEAN;

-- Backfill idempotente das linhas legadas (anteriores ao M6): só toca linhas
-- ainda não classificadas (escopo IS NULL) — nunca reescreve valor/tipo/
-- fonte/confianca, e não roda de novo depois da primeira classificação.
-- Mesma regra determinística de classificarComponenteFinanceiro() — nunca
-- duplicada com lógica diferente. Segura para dado legado: escopo e tipo já
-- são fatos persistidos, nunca uma adivinhação nova criada aqui.
UPDATE central_vendas_componentes c
   SET escopo = CASE WHEN c.item_id IS NULL THEN 'pedido' ELSE 'item' END,
       efeito = CASE c.tipo
                  WHEN 'receita_produto' THEN 'credito'
                  WHEN 'receita_envio' THEN 'credito'
                  WHEN 'tarifa_venda' THEN 'debito'
                  WHEN 'custo_produto' THEN 'debito'
                  WHEN 'imposto_interno' THEN 'debito'
                  WHEN 'frete_seller' THEN 'debito'
                  WHEN 'cancelamento_reembolso' THEN 'debito'
                  ELSE NULL
                END,
       incluido_no_resultado = CASE
                  WHEN c.tipo IN ('receita_produto', 'tarifa_venda', 'custo_produto', 'imposto_interno', 'frete_seller') THEN TRUE
                  WHEN c.tipo IN ('receita_envio', 'cancelamento_reembolso') THEN FALSE
                  ELSE NULL
                END
 WHERE c.escopo IS NULL;

-- ---------------------------------------------------------------------------
-- MP1 — Ingestão canônica de Mercado Pago Payments + charges_details
-- (Central de Vendas V3).
--
-- Ver docs/mercado_pago/HANDOFF_MERCADO_PAGO_LIQUIDACAO_REAL_COMPLETO.md —
-- evidência primária. MP1 é INGESTÃO: persiste o Payment normalizado e seus
-- charges_details, auditável por Sync Run. NÃO altera Resultado Parcial,
-- margem, ledger M6, confiança do fechamento ou podeConcluir — ver
-- centralVendasMpPaymentsService/centralVendasMpPaymentsRepository.
--
-- Uma linha = UM Payment observado em UM Sync Run. UNIQUE (sync_run_id,
-- payment_id) garante idempotência dentro do mesmo run (reprocessamento faz
-- UPSERT, nunca duplica) e, ao mesmo tempo, preserva auditoria por run:
-- sincronizações diferentes do MESMO payment_id (ex.: money_release_status
-- mudou de pending para released entre dois runs) viram linhas SEPARADAS,
-- nunca uma sobrescrita silenciosa de uma observação histórica de outro run
-- (seção 7 do spec MP1). "Solução mais simples que preserve auditoria por
-- run" — sem tabela de "estado atual" separada, que só o Settlement (fora
-- do escopo MP1) justificaria.
CREATE TABLE IF NOT EXISTS central_vendas_mp_payments (
  id BIGSERIAL PRIMARY KEY,
  sync_run_id BIGINT NOT NULL REFERENCES central_vendas_sync_runs(id) ON DELETE CASCADE,
  cliente_id BIGINT,
  cliente_conta_id BIGINT REFERENCES cliente_contas(id) ON DELETE SET NULL,
  external_account_id TEXT,
  order_id TEXT,
  order_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  payment_id TEXT NOT NULL,
  status TEXT,
  status_detail TEXT,
  transaction_amount NUMERIC(14,2),
  transaction_amount_refunded NUMERIC(14,2),
  net_received_amount NUMERIC(14,2),
  total_paid_amount NUMERIC(14,2),
  shipping_amount NUMERIC(14,2),
  money_release_date TIMESTAMPTZ,
  money_release_status TEXT,
  currency_id TEXT,
  date_created TIMESTAMPTZ,
  date_approved TIMESTAMPTZ,
  date_last_updated TIMESTAMPTZ,
  refund_count INTEGER,
  refund_ids_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sync_run_id, payment_id)
);

-- 29/10/2026: idx_central_vendas_mp_payments_{run,payment,order} e
-- idx_central_vendas_mp_payment_charges_run saíram (nenhuma consulta da aplicação
-- usa; run é prefixo do UNIQUE (sync_run_id, payment_id)). Remoção em produção:
-- migrations/20261029_central_vendas_mp_indices_sem_uso.sql.
CREATE INDEX IF NOT EXISTS idx_central_vendas_mp_payments_cliente_conta
  ON central_vendas_mp_payments (cliente_conta_id);

-- Charges individuais de um Payment (shipping/fee/etc. — seção 6 do spec
-- MP1). `mp_payment_row_id` ancora a idempotência: reprocessar o mesmo run
-- apaga e reinsere as charges daquele payment (ver
-- centralVendasMpPaymentsRepository.replaceMpPaymentCharges) — nunca
-- duplica, porque não há chave estável por charge (a API nem sempre traz um
-- `id` de charge, ver payload real no handoff, seção 8).
CREATE TABLE IF NOT EXISTS central_vendas_mp_payment_charges (
  id BIGSERIAL PRIMARY KEY,
  mp_payment_row_id BIGINT NOT NULL REFERENCES central_vendas_mp_payments(id) ON DELETE CASCADE,
  sync_run_id BIGINT NOT NULL,
  payment_id TEXT NOT NULL,
  charge_id TEXT,
  name TEXT,
  type TEXT,
  amount_original NUMERIC(14,2),
  amount_refunded NUMERIC(14,2),
  account_from TEXT,
  account_to TEXT,
  metadata_shipment_id TEXT,
  metadata_source TEXT,
  metadata_source_detail TEXT,
  refund_charges_json JSONB,
  update_charges_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_central_vendas_mp_payment_charges_payment_row
  ON central_vendas_mp_payment_charges (mp_payment_row_id);

-- =============================================================================
-- MP2 — Settlement Report + conciliação Payment <-> Settlement.
--
-- Ver docs/mercado_pago/HANDOFF_MERCADO_PAGO_LIQUIDACAO_REAL_COMPLETO.md —
-- provou Payment.id = Settlement.SOURCE_ID com dado real. MP2 é ingestão +
-- conciliação, NÃO participa do ledger M6/Resultado Parcial/podeConcluir —
-- ver centralVendasMpSettlementReportService/centralVendasMpReconciliationService.
--
-- UNIQUE(sync_run_id): um report externo por run (seção 7/14 do spec MP2) —
-- reconsultar/retomar o MESMO run NUNCA gera um segundo report do Mercado
-- Pago. Runs diferentes (mesmo período reprocessado) preservam histórico:
-- cada um tem sua própria linha, nunca sobrescreve a de outro run.
--
-- report_external_id é NULLABLE: uma tentativa pode falhar ANTES de chegar a
-- gerar o report externo (ex.: SETTLEMENT_CONFIG_INCOMPATIBLE) e ainda assim
-- precisa de uma linha auditável (status='failed') para aquele run.
CREATE TABLE IF NOT EXISTS central_vendas_mp_settlement_reports (
  id BIGSERIAL PRIMARY KEY,
  sync_run_id BIGINT NOT NULL REFERENCES central_vendas_sync_runs(id) ON DELETE CASCADE,
  cliente_id BIGINT,
  cliente_conta_id BIGINT REFERENCES cliente_contas(id) ON DELETE SET NULL,
  external_account_id TEXT,
  report_external_id TEXT,
  begin_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'requested',
  report_type TEXT,
  format TEXT,
  currency_id TEXT,
  file_name TEXT,
  file_sha256 TEXT,
  rows_count INTEGER,
  error_code TEXT,
  error_message TEXT,
  requested_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  downloaded_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sync_run_id)
);

CREATE INDEX IF NOT EXISTS idx_central_vendas_mp_settlement_reports_cliente_conta
  ON central_vendas_mp_settlement_reports (cliente_conta_id);

CREATE INDEX IF NOT EXISTS idx_central_vendas_mp_settlement_reports_status
  ON central_vendas_mp_settlement_reports (status);

-- Uma linha = UM movimento (uma linha do CSV) de UM Settlement Report. O
-- Settlement é fonte DA CONTA, não só dos Payments do run atual (seção 15 do
-- spec MP2) — movimentos sem Payment correspondente no run são preservados,
-- nunca descartados. UNIQUE(settlement_report_id, row_number) ancora a
-- idempotência: reimportar o MESMO report substitui as linhas daquele
-- report (ver centralVendasMpSettlementRepository.replaceSettlementMovements),
-- nunca duplica.
CREATE TABLE IF NOT EXISTS central_vendas_mp_settlement_movements (
  id BIGSERIAL PRIMARY KEY,
  settlement_report_id BIGINT NOT NULL REFERENCES central_vendas_mp_settlement_reports(id) ON DELETE CASCADE,
  sync_run_id BIGINT NOT NULL,
  cliente_conta_id BIGINT,
  row_number INTEGER NOT NULL,
  source_id TEXT,
  order_id TEXT,
  shipping_id TEXT,
  transaction_type TEXT,
  transaction_amount NUMERIC(14,2),
  fee_amount NUMERIC(14,2),
  settlement_net_amount NUMERIC(14,2),
  real_amount NUMERIC(14,2),
  money_release_date TIMESTAMPTZ,
  is_released BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (settlement_report_id, row_number)
);

CREATE INDEX IF NOT EXISTS idx_central_vendas_mp_settlement_movements_report
  ON central_vendas_mp_settlement_movements (settlement_report_id);

CREATE INDEX IF NOT EXISTS idx_central_vendas_mp_settlement_movements_source
  ON central_vendas_mp_settlement_movements (source_id);

CREATE INDEX IF NOT EXISTS idx_central_vendas_mp_settlement_movements_run
  ON central_vendas_mp_settlement_movements (sync_run_id);
