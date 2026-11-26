-- server/sql/observabilidade/central_vendas_componentes_v2_medicao.sql
--
-- Medição da persistência dos componentes da Central de Vendas — SOMENTE LEITURA.
-- Base de evidência da proposta "componentes v2" (docs/banco-de-dados/10_*).
-- Rodar com a role de leitura (raiox_ro), nunca com o usuário da aplicação:
--
--   psql "$URL_RAIOX_RO" -v ON_ERROR_STOP=1 -f central_vendas_componentes_v2_medicao.sql > medicao_componentes_v2.out
--
-- Seguro para produção:
--   - cada consulta em sua própria transação READ ONLY (default_transaction_read_only),
--     statement_timeout 60 s, lock_timeout 2 s: uma seção que estoure o tempo
--     falha sozinha e as demais seguem;
--   - nas tabelas grandes, só AMOSTRA (TABLESAMPLE SYSTEM, ~1% das páginas,
--     REPEATABLE p/ reprodutibilidade) ou catálogo; nenhuma varredura completa
--     de central_vendas_componentes (2,5 GB em 05/11);
--   - a única contagem completa é DISTINCT em central_vendas_pedidos (~0,7 mi
--     linhas; se estourar o timeout, a seção falha sozinha e o resto segue).

\set ON_ERROR_STOP 0
SET default_transaction_read_only = on;
SET statement_timeout = '60s';
SET lock_timeout = '2s';
SHOW default_transaction_read_only;

\echo === 1. Tamanho físico (heap / TOAST / índices) das tabelas da Central
SELECT c.relname AS tabela, pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       pg_relation_size(c.oid) AS heap_b,
       COALESCE(pg_total_relation_size(NULLIF(c.reltoastrelid, 0)), 0) AS toast_b,
       pg_indexes_size(c.oid) AS indices_b, c.reltuples::bigint AS linhas_est,
       s.n_live_tup, s.n_dead_tup, s.n_tup_ins, s.n_tup_del
  FROM pg_class c LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
 WHERE c.relkind = 'r' AND c.relname LIKE 'central_vendas_%'
 ORDER BY pg_total_relation_size(c.oid) DESC;

\echo === 2. Índices de central_vendas_componentes (tamanho e uso)
SELECT i.indexrelname AS indice, pg_relation_size(i.indexrelid) AS bytes, i.idx_scan, i.last_idx_scan
  FROM pg_stat_user_indexes i WHERE i.relname = 'central_vendas_componentes' ORDER BY 2 DESC;

\echo === 3. Bytes médios por linha e por coluna (amostra ~1%)
SELECT COUNT(*) AS amostra,
       AVG(pg_column_size(c.*))::numeric(10,1) AS linha,
       AVG(pg_column_size(c.payload_json))::numeric(10,1) AS payload_json,
       AVG(COALESCE(pg_column_size(c.obs), 0))::numeric(10,1) AS obs,
       AVG(pg_column_size(c.cliente_slug) + pg_column_size(c.marketplace) + pg_column_size(c.competencia)
           + pg_column_size(c.pedido_id) + COALESCE(pg_column_size(c.item_id), 0) + pg_column_size(c.import_id)
           + COALESCE(pg_column_size(c.cliente_id), 0) + pg_column_size(c.created_at) + pg_column_size(c.updated_at))::numeric(10,1) AS identificacao,
       AVG(COALESCE(pg_column_size(c.escopo), 0) + COALESCE(pg_column_size(c.efeito), 0) + 1)::numeric(10,1) AS classificacao,
       AVG(pg_column_size(c.tipo) + COALESCE(pg_column_size(c.fonte), 0) + pg_column_size(c.confianca))::numeric(10,1) AS textos_curtos,
       COUNT(*) FILTER (WHERE c.payload_json = '{}'::jsonb) AS payload_vazio
  FROM central_vendas_componentes c TABLESAMPLE SYSTEM (1) REPEATABLE (42);

\echo === 4. Componentes por tipo/fonte/confiança (amostra ~1%) — inclui valor NULL × zero
SELECT tipo, fonte, confianca, item_id IS NOT NULL AS por_item, COUNT(*) AS n,
       COUNT(*) FILTER (WHERE valor IS NULL) AS valor_null, COUNT(*) FILTER (WHERE valor = 0) AS valor_zero
  FROM central_vendas_componentes TABLESAMPLE SYSTEM (1) REPEATABLE (42)
 GROUP BY 1, 2, 3, 4 ORDER BY n DESC;

\echo === 5. Textos de obs distintos (amostra ~1%) — viabilidade do dicionário
SELECT COUNT(DISTINCT obs) AS obs_distintos, COUNT(obs) AS com_obs, AVG(length(obs))::numeric(10,1) AS obs_len_medio,
       COUNT(DISTINCT fonte) AS fontes, COUNT(DISTINCT confianca) AS confiancas, COUNT(DISTINCT tipo) AS tipos
  FROM central_vendas_componentes TABLESAMPLE SYSTEM (1) REPEATABLE (42);

\echo === 6. Derivabilidade (amostra ~1%): identificação = linha do pedido? classificação = f(tipo, item)? payload só com chaves conhecidas?
SELECT COUNT(*) AS amostra,
       COUNT(*) FILTER (WHERE c.pedido_row_id IS NULL) AS sem_pedido_row,
       COUNT(*) FILTER (WHERE c.item_id IS NOT NULL AND c.item_row_id IS NULL) AS item_sem_linha,
       COUNT(*) FILTER (WHERE c.import_id IS DISTINCT FROM p.import_id OR c.cliente_id IS DISTINCT FROM p.cliente_id
                          OR c.cliente_slug IS DISTINCT FROM p.cliente_slug OR c.marketplace IS DISTINCT FROM p.marketplace
                          OR c.competencia IS DISTINCT FROM p.competencia OR c.pedido_id IS DISTINCT FROM p.pedido_id) AS identificacao_diverge,
       COUNT(*) FILTER (WHERE c.created_at IS DISTINCT FROM p.created_at) AS created_diverge,
       COUNT(*) FILTER (WHERE c.updated_at IS DISTINCT FROM p.updated_at) AS updated_diverge,
       COUNT(*) FILTER (WHERE c.item_id IS DISTINCT FROM i.item_id AND c.item_row_id IS NOT NULL) AS item_id_diverge,
       COUNT(*) FILTER (WHERE c.escopo IS DISTINCT FROM CASE WHEN c.item_id IS NOT NULL AND c.item_id <> '' THEN 'item' ELSE 'pedido' END) AS escopo_diverge,
       COUNT(*) FILTER (WHERE c.efeito IS DISTINCT FROM CASE WHEN c.tipo IN ('receita_produto','receita_envio') THEN 'credito'
                              WHEN c.tipo IN ('tarifa_venda','custo_produto','imposto_interno','frete_seller','cancelamento_reembolso') THEN 'debito' END) AS efeito_diverge,
       COUNT(*) FILTER (WHERE c.incluido_no_resultado IS DISTINCT FROM CASE WHEN c.tipo IN ('receita_produto','tarifa_venda','custo_produto','imposto_interno','frete_seller') THEN TRUE
                              WHEN c.tipo IN ('receita_envio','cancelamento_reembolso') THEN FALSE END) AS incluido_diverge,
       COUNT(*) FILTER (WHERE (c.payload_json - ARRAY['pedidoId','itemId','tipo','valor','fonte','confianca','obs']) <> '{}'::jsonb) AS payload_com_extras
  FROM central_vendas_componentes c TABLESAMPLE SYSTEM (1) REPEATABLE (42)
  LEFT JOIN central_vendas_pedidos p ON p.id = c.pedido_row_id
  LEFT JOIN central_vendas_pedido_itens i ON i.id = c.item_row_id;

\echo === 7. Componentes repetidos do MESMO tipo no mesmo item/pedido (amostra de pedidos ~1%)
SELECT COUNT(*) AS grupos_repetidos, COALESCE(MAX(n), 0) AS max_repeticao
  FROM (SELECT c.pedido_row_id, c.item_row_id, c.tipo, COUNT(*) AS n
          FROM central_vendas_pedidos p TABLESAMPLE SYSTEM (1) REPEATABLE (42)
          JOIN central_vendas_componentes c ON c.pedido_row_id = p.id
         GROUP BY 1, 2, 3 HAVING COUNT(*) > 1) s;

\echo === 8. Componentes por pedido e por item (amostra de pedidos ~1%)
SELECT COUNT(DISTINCT p.id) AS pedidos, COUNT(c.*) AS componentes,
       (COUNT(c.*)::numeric / NULLIF(COUNT(DISTINCT p.id), 0))::numeric(10,2) AS comp_por_pedido
  FROM central_vendas_pedidos p TABLESAMPLE SYSTEM (1) REPEATABLE (42)
  LEFT JOIN central_vendas_componentes c ON c.pedido_row_id = p.id;

\echo === 9. Redundância por snapshots: cópias do mesmo pedido (conta × competência × pedido_id)
SELECT COUNT(*) AS linhas_pedido,
       COUNT(DISTINCT (COALESCE(i.cliente_conta_id, -1), p.marketplace, p.competencia, p.pedido_id)) AS pedidos_distintos,
       (COUNT(*)::numeric / NULLIF(COUNT(DISTINCT (COALESCE(i.cliente_conta_id, -1), p.marketplace, p.competencia, p.pedido_id)), 0))::numeric(10,2) AS copias_por_pedido
  FROM central_vendas_pedidos p JOIN central_vendas_imports i ON i.id = p.import_id;

\echo === 10. Volume por conta (pedidos por import × imports; componentes estimados pela razão da seção 8)
SELECT i.cliente_conta_id, i.cliente_slug, i.marketplace, COUNT(DISTINCT i.id) AS imports,
       SUM(CASE WHEN i.publication_status = 'published' THEN 1 ELSE 0 END) AS imports_published,
       COUNT(p.id) AS linhas_pedido
  FROM central_vendas_imports i LEFT JOIN central_vendas_pedidos p ON p.import_id = i.id
 GROUP BY 1, 2, 3 ORDER BY linhas_pedido DESC LIMIT 40;

\echo === 11. Formatos em uso: persistência enxuta (manifesto) e reuso (vínculos)
-- payload_json dos imports mora no TOAST (176 MB em 05/11): só os imports recentes.
SELECT fonte, payload_json->>'formato' AS formato, COUNT(*) AS imports
  FROM central_vendas_imports WHERE created_at > NOW() - INTERVAL '3 days' GROUP BY 1, 2 ORDER BY 3 DESC;
SELECT to_regclass('public.central_vendas_import_pedidos') IS NOT NULL AS tabela_vinculos_existe;

