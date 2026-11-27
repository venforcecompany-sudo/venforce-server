-- docs/banco-de-dados/componentes-v2/raiox_ro_paridade_central.sql
--
-- PROPOSTA (não executada): concessão ADICIONAL e REVOGÁVEL à role raiox_ro
-- para a paridade de VALORES do rollout (server/scripts/central-vendas-validar-conta.js
-- e central-vendas-componentes-paridade.js). Roda como ADMIN, só com autorização.
--
-- Por que é preciso: a raiox_ro foi criada mínima (criar_raiox_ro.sql) — lê
-- só ids de pedidos e o resumo dos imports. A paridade compara valores,
-- componentes, fontes, confiança, observações, pedidos e itens, e usa os
-- leitores REAIS do repositório (que fazem SELECT p.* em pedidos).
--
-- O que passa a ser legível (decisão do responsável):
--   central_vendas_pedidos      inclui payload_json (logística, Full, pós-venda,
--                               claims; o motor não grava dado de comprador)
--   central_vendas_pedido_itens SKU, título, MLB, quantidades e valores
--   central_vendas_componentes  composição financeira (sem dado pessoal)
--   compactos + dicionário      idem, no formato v2 (se a migration existir)
-- Continua PROIBIDO: central_vendas_imports.payload_json, ml_tokens, shopee_grants.
--
-- Os limites da role (READ ONLY por padrão, statement_timeout 8s, 2 conexões)
-- continuam valendo; o validador usa 60s por consulta na própria sessão.
-- TEMPORÁRIA: aplicar só na janela da validação (R1/C0) e revogar no mesmo dia.
-- Revogar: o bloco REVOKE no fim (copie e rode depois da validação).
--
-- Estado de produção conferido em 27/11/2026 (leitura): a raiox_ro existe, é
-- READ ONLY, statement_timeout 8s, lock_timeout 2s, 2 conexões, e NÃO tem
-- privilégio de tabela inteira em nenhuma central_vendas_*; só colunas de
-- central_vendas_imports (sem payload_json), sync_runs, mp_* e
-- central_vendas_pedidos(id, import_id). Em central_vendas_import_pedidos
-- (existe) ela não tem nada — por isso a revogação NÃO devolve coluna ali.

BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT SELECT ON public.central_vendas_pedidos TO raiox_ro;
GRANT SELECT ON public.central_vendas_pedido_itens TO raiox_ro;
GRANT SELECT ON public.central_vendas_componentes TO raiox_ro;
DO $$ BEGIN
  IF to_regclass('public.central_vendas_import_pedidos') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON public.central_vendas_import_pedidos TO raiox_ro';
  END IF;
  IF to_regclass('public.central_vendas_pedido_componentes') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON public.central_vendas_pedido_componentes TO raiox_ro';
    EXECUTE 'GRANT SELECT ON public.central_vendas_componente_textos TO raiox_ro';
  END IF;
END $$;
-- Conferência: deve listar só SELECT nessas tabelas.
SELECT table_name, privilege_type FROM information_schema.role_table_grants
 WHERE grantee = 'raiox_ro' AND table_name LIKE 'central_vendas_%' ORDER BY 1, 2;
COMMIT;

-- ===== REVOGAR (depois da validação) =====
-- BEGIN;
-- REVOKE SELECT ON public.central_vendas_pedidos, public.central_vendas_pedido_itens, public.central_vendas_componentes FROM raiox_ro;
-- GRANT SELECT (id, import_id) ON public.central_vendas_pedidos TO raiox_ro;   -- volta ao concedido por criar_raiox_ro.sql
-- DO $$ BEGIN
--   IF to_regclass('public.central_vendas_import_pedidos') IS NOT NULL THEN
--     EXECUTE 'REVOKE SELECT ON public.central_vendas_import_pedidos FROM raiox_ro';  -- antes: nenhum privilégio
--   END IF;
--   IF to_regclass('public.central_vendas_pedido_componentes') IS NOT NULL THEN
--     EXECUTE 'REVOKE SELECT ON public.central_vendas_pedido_componentes, public.central_vendas_componente_textos FROM raiox_ro';
--   END IF;
-- END $$;
-- -- Conferência: deve voltar a listar só central_vendas_pedidos.id e .import_id (mais as colunas de imports/sync_runs/mp_*).
-- SELECT table_name, column_name FROM information_schema.column_privileges
--  WHERE grantee = 'raiox_ro' AND table_name IN ('central_vendas_pedidos','central_vendas_pedido_itens','central_vendas_componentes','central_vendas_import_pedidos') ORDER BY 1, 2;
-- COMMIT;
