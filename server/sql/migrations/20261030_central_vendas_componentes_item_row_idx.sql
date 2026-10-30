-- 20261030 — índice da FK central_vendas_componentes.item_row_id (ON DELETE CASCADE).
-- NÃO aplicada no boot (não está em schemaEnsure.js). Rodar no psql FORA de transação
-- (CREATE INDEX CONCURRENTLY não aceita BEGIN), antes do deploy que traz a linha no
-- central_vendas_schema.sql — com o índice já criado, o boot vira no-op.
--
-- Por quê: sem índice, apagar um item faz seq scan em componentes para achar os
-- dependentes do CASCADE. Medido 30/10/2026: 3,4 mi linhas / 2 GB; o 1º lote da
-- retenção (conta 110, 6 imports, 186 itens) caiu por statement_timeout (60 s) e
-- não removeu nada. pedido_row_id e import_id já têm índice; só esta coluna não.
-- Custo: ~55 MB (mesmo tamanho de idx_central_vendas_componentes_pedido_row);
-- CONCURRENTLY não bloqueia escrita do sync. Puramente aditivo.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_central_vendas_componentes_item_row
  ON central_vendas_componentes (item_row_id);

-- Conferir (somente leitura): indisvalid deve ser true. Se a criação for interrompida,
-- sobra um índice INVALID: remova com DROP INDEX CONCURRENTLY e rode de novo.
-- SELECT c.relname, i.indisvalid, pg_size_pretty(pg_relation_size(c.oid))
--   FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--  WHERE c.relname = 'idx_central_vendas_componentes_item_row';

-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS idx_central_vendas_componentes_item_row;
