-- server/sql/observabilidade/central_vendas_rollout_estado.raiox_ro.sql
--
-- Estado do rollout (reuso de pedidos → componentes compactos) — SOMENTE
-- LEITURA, feito para rodar com a role `raiox_ro` COMO ELA É HOJE (SELECT só
-- nas colunas concedidas por criar_raiox_ro.sql: imports com resumo_json,
-- sync_runs, pedidos(id, import_id), import_pedidos(import_id, pedido_row_id)).
-- Não lê payload_json, valores de pedido, itens nem componentes.
--
--   psql "$RO_URL" -X -v conta=<cliente_conta_id> -f central_vendas_rollout_estado.raiox_ro.sql > estado_<conta>.txt
--
-- Cada bloco é independente (ON_ERROR_ROLLBACK): falta de permissão num
-- bloco não derruba os outros.

\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';

\echo '== E1. Migrations aplicadas? (NULL = ausente) =='
SELECT to_regclass('public.central_vendas_import_pedidos') AS reuso_vinculos,
       to_regclass('public.central_vendas_pedido_componentes') AS componentes_compactos,
       to_regclass('public.central_vendas_componente_textos') AS dicionario;

\echo '== E2. Reuso em uso? Vínculos gravados no total e por conta (0 = reuso nunca gravou) =='
SELECT CASE WHEN to_regclass('public.central_vendas_import_pedidos') IS NULL
         THEN $q$SELECT 'tabela de vínculos ausente'::text AS situacao, NULL::bigint AS conta, 0::bigint AS vinculos, 0::bigint AS imports_com_vinculo$q$
       ELSE $q$SELECT 'vinculos'::text AS situacao, i.cliente_conta_id AS conta, count(*) AS vinculos, count(DISTINCT v.import_id) AS imports_com_vinculo
                 FROM central_vendas_import_pedidos v JOIN central_vendas_imports i ON i.id = v.import_id
                GROUP BY i.cliente_conta_id ORDER BY 3 DESC LIMIT 20$q$ END \gexec

\echo '== E3. Componentes compactos gravados? (sem permissão na tabela = ver proposta de concessão) =='
SELECT CASE WHEN to_regclass('public.central_vendas_pedido_componentes') IS NULL
         THEN $q$SELECT 'tabela compacta ausente (migration 20261126 não aplicada)'::text AS situacao, 0::bigint AS linhas$q$
       WHEN NOT has_table_privilege(current_user, 'public.central_vendas_pedido_componentes', 'SELECT')
         THEN $q$SELECT 'tabela existe; raiox_ro sem SELECT (só tamanho abaixo)'::text AS situacao, NULL::bigint AS linhas$q$
       ELSE $q$SELECT 'tabela existe'::text AS situacao, count(*) AS linhas FROM central_vendas_pedido_componentes$q$ END \gexec

\echo '== E4. Tamanho físico das tabelas da Central (catálogo; sem ler dados) =='
SELECT c.relname AS tabela, pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       pg_total_relation_size(c.oid) AS bytes, c.reltuples::bigint AS linhas_est
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'central_vendas_%'
 ORDER BY 3 DESC;

\echo '== E5. Formato de gravação dos imports do Sync da conta (últimos 14 dias): manifesto enxuto? reuso? compacto? =='
-- formato do payload sem ler o JSON: bytes por pedido (manifesto ≈ dezenas; completo ≈ centenas+).
-- Reuso: vínculos do import. Compacto: só visível com a concessão (E3).
SELECT i.id AS import_id, i.competencia, i.publication_status, i.created_at::date AS dia,
       (i.resumo_json->>'pedidosTotal')::int AS pedidos_motor,
       (SELECT count(*) FROM central_vendas_pedidos p WHERE p.import_id = i.id) AS pedidos_proprios,
       raiox.payload_bytes(i.id) / NULLIF((i.resumo_json->>'pedidosTotal')::numeric, 0) AS bytes_payload_por_pedido
  FROM central_vendas_imports i
 WHERE i.cliente_conta_id = :'conta' AND i.fonte = 'orders_api' AND i.created_at >= now() - interval '14 days'
 ORDER BY i.id DESC LIMIT 30;

\echo '== E6. COMPLETUDE por import publicado da conta: pedidos lidos (próprios ∪ vinculados, sem repetição) = pedidos do motor? =='
-- Com reuso, o import novo só grava novos/alterados; o resto chega por vínculo.
-- Esperado: lidos = pedidos_motor e repetidos = 0 em TODO import. Qualquer diferença = NO-GO.
SELECT CASE WHEN to_regclass('public.central_vendas_import_pedidos') IS NULL
  THEN format($q$SELECT i.id AS import_id, i.competencia, (i.resumo_json->>'pedidosTotal')::int AS pedidos_motor,
                        count(p.id) AS lidos, 0 AS vinculados, 0 AS repetidos,
                        CASE WHEN count(p.id) = (i.resumo_json->>'pedidosTotal')::int THEN 'OK' ELSE 'DIVERGE' END AS veredito
                   FROM central_vendas_imports i LEFT JOIN central_vendas_pedidos p ON p.import_id = i.id
                  WHERE i.cliente_conta_id = %s AND i.fonte = 'orders_api' AND i.publication_status = 'published'
                    AND i.created_at >= now() - interval '14 days'
                  GROUP BY i.id ORDER BY i.id DESC$q$, :'conta')
  ELSE format($q$WITH alvo AS (SELECT id, competencia, (resumo_json->>'pedidosTotal')::int AS pedidos_motor FROM central_vendas_imports
                               WHERE cliente_conta_id = %s AND fonte = 'orders_api' AND publication_status = 'published'
                                 AND created_at >= now() - interval '14 days'),
                      fonte AS (SELECT a.id AS import_id, p.id AS pedido_row_id, false AS vinculado FROM alvo a JOIN central_vendas_pedidos p ON p.import_id = a.id
                                UNION ALL
                                SELECT a.id, v.pedido_row_id, true FROM alvo a JOIN central_vendas_import_pedidos v ON v.import_id = a.id)
                 SELECT a.id AS import_id, a.competencia, a.pedidos_motor, count(f.pedido_row_id) AS lidos,
                        count(*) FILTER (WHERE f.vinculado) AS vinculados,
                        count(f.pedido_row_id) - count(DISTINCT f.pedido_row_id) AS repetidos,
                        CASE WHEN count(DISTINCT f.pedido_row_id) = a.pedidos_motor AND count(f.pedido_row_id) = count(DISTINCT f.pedido_row_id)
                             THEN 'OK' ELSE 'DIVERGE' END AS veredito
                   FROM alvo a LEFT JOIN fonte f ON f.import_id = a.id
                  GROUP BY a.id, a.competencia, a.pedidos_motor ORDER BY a.id DESC$q$, :'conta') END \gexec

\echo '== E7. Saúde do sync da conta (14 dias): concluídos, falhas, presos =='
SELECT count(*) FILTER (WHERE status = 'completed') AS concluidos,
       count(*) FILTER (WHERE status = 'failed') AS falhas,
       count(*) FILTER (WHERE status IN ('queued', 'running') AND created_at < now() - interval '6 hours') AS presos,
       max(finished_at) FILTER (WHERE status = 'completed') AS ultimo_ok,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at)) FILTER (WHERE status = 'completed') AS duracao_mediana_s
  FROM central_vendas_sync_runs
 WHERE cliente_conta_id = :'conta' AND created_at >= now() - interval '14 days';

\echo '== E8. Falhas recentes da conta (código do erro) =='
SELECT created_at, status, error_code FROM central_vendas_sync_runs
 WHERE cliente_conta_id = :'conta' AND status = 'failed' AND created_at >= now() - interval '14 days'
 ORDER BY created_at DESC LIMIT 10;

ROLLBACK;
