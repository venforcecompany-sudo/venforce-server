-- 20261029 — remove 4 índices das tabelas do Mercado Pago que nenhuma consulta da aplicação usa.
-- NÃO EXECUTADA. Requer autorização. Rodar no psql FORA de transação (DROP INDEX CONCURRENTLY
-- não aceita BEGIN), um comando por vez; cada um é reversível recriando o índice (CREATE INDEX
-- CONCURRENTLY, definições no fim).
--
-- Evidência (código, main 1e279ca3): leitura = WHERE p.sync_run_id = ANY(...) [+ cliente_conta_id];
-- upsert = UNIQUE (sync_run_id, payment_id); charges = WHERE/JOIN mp_payment_row_id. Nenhum
-- WHERE/JOIN por mp_payments.order_id, mp_payments.payment_id isolado, nem charges.sync_run_id.
-- idx_central_vendas_mp_payments_run é o prefixo do UNIQUE (redundante).
-- As estatísticas de uso (pg_stat_user_indexes) foram zeradas pelo crash recovery: antes de
-- aplicar, confirme com a consulta abaixo depois de >= 7 dias de operação normal.
--
-- Ganho medido 29/10/2026: ~65 MB hoje + 4 atualizações de índice a menos por linha gravada
-- (≈ 7 linhas de payment e ≈ 30 de charge por payment distinto em cada sync).

-- Pré-checagem (somente leitura): idx_scan deve continuar 0 (ou só de consultas manuais).
-- SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
--   FROM pg_stat_user_indexes
--  WHERE indexrelname IN ('idx_central_vendas_mp_payments_run', 'idx_central_vendas_mp_payments_payment',
--                         'idx_central_vendas_mp_payments_order', 'idx_central_vendas_mp_payment_charges_run');

DROP INDEX CONCURRENTLY IF EXISTS idx_central_vendas_mp_payment_charges_run;
DROP INDEX CONCURRENTLY IF EXISTS idx_central_vendas_mp_payments_order;
DROP INDEX CONCURRENTLY IF EXISTS idx_central_vendas_mp_payments_payment;
DROP INDEX CONCURRENTLY IF EXISTS idx_central_vendas_mp_payments_run;

-- Rollback (se alguma consulta nova precisar):
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_central_vendas_mp_payments_run ON central_vendas_mp_payments (sync_run_id);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_central_vendas_mp_payments_payment ON central_vendas_mp_payments (payment_id);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_central_vendas_mp_payments_order ON central_vendas_mp_payments (order_id);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_central_vendas_mp_payment_charges_run ON central_vendas_mp_payment_charges (sync_run_id);
