-- server/sql/observabilidade/pg_armazenamento.sql
--
-- Métricas de armazenamento e crescimento do PostgreSQL — SOMENTE LEITURA.
-- Só catálogos/estatísticas nativas (pg_class, pg_stat_*, pg_stats) e
-- agregações pequenas em tabelas pequenas (imports, sync_runs). Nenhuma
-- varredura de tabela grande: contagens das tabelas grandes vêm de reltuples /
-- n_live_tup (estimativas do próprio PG, atualizadas por ANALYZE/autovacuum).
--
-- Uso manual:   psql "$URL" -v ON_ERROR_STOP=1 -f pg_armazenamento.sql
-- Uso pelo script: server/scripts/pg-relatorio-armazenamento.js (cada bloco
-- "-- @nome" vira uma seção do relatório; roda em BEGIN READ ONLY com
-- statement_timeout).

-- @banco
SELECT current_database() AS banco,
       pg_database_size(current_database())::bigint AS bytes_total,
       (SELECT setting FROM pg_settings WHERE name = 'server_version') AS versao,
       NOW() AS medido_em;

-- @tabelas
SELECT c.relname AS tabela,
       pg_total_relation_size(c.oid)::bigint AS bytes_total,
       pg_relation_size(c.oid)::bigint AS bytes_heap,
       COALESCE(pg_total_relation_size(NULLIF(c.reltoastrelid, 0)), 0)::bigint AS bytes_toast,
       pg_indexes_size(c.oid)::bigint AS bytes_indices,
       c.reltuples::bigint AS linhas_estimadas,
       s.n_live_tup::bigint AS linhas_vivas,
       s.n_dead_tup::bigint AS linhas_mortas,
       s.n_tup_ins::bigint AS ins_acumulado,
       s.n_tup_upd::bigint AS upd_acumulado,
       s.n_tup_del::bigint AS del_acumulado,
       s.last_autovacuum, s.last_vacuum, s.last_autoanalyze,
       s.autovacuum_count::bigint AS autovacuum_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
 ORDER BY pg_total_relation_size(c.oid) DESC
 LIMIT 60;

-- @indices
SELECT i.relname AS indice, t.relname AS tabela,
       pg_relation_size(i.oid)::bigint AS bytes,
       s.idx_scan::bigint AS usos_acumulados
  FROM pg_class i
  JOIN pg_index x ON x.indexrelid = i.oid
  JOIN pg_class t ON t.oid = x.indrelid
  JOIN pg_namespace n ON n.oid = i.relnamespace
  LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.oid
 WHERE n.nspname = 'public'
 ORDER BY pg_relation_size(i.oid) DESC
 LIMIT 40;

-- @espaco_morto
-- ESTIMATIVA: fração de linhas mortas × heap. Espaço "reutilizável" depois do
-- (auto)vacuum é reaproveitado pela própria tabela, não devolvido ao disco.
SELECT c.relname AS tabela,
       s.n_dead_tup::bigint AS linhas_mortas,
       s.n_live_tup::bigint AS linhas_vivas,
       CASE WHEN s.n_live_tup + s.n_dead_tup > 0
            THEN ROUND(pg_relation_size(c.oid) * s.n_dead_tup::numeric / (s.n_live_tup + s.n_dead_tup))
       END::bigint AS bytes_mortos_estimados
  FROM pg_stat_user_tables s
  JOIN pg_class c ON c.oid = s.relid
 WHERE s.n_dead_tup > 0
 ORDER BY 4 DESC NULLS LAST
 LIMIT 20;

-- @central_imports
-- Tabela pequena (milhares de linhas): agregação direta.
SELECT publication_status, fonte,
       (sync_run_id IS NOT NULL) AS do_sync,
       COUNT(*)::int AS imports,
       COALESCE(SUM(NULLIF(resumo_json->>'pedidosTotal', '')::bigint), 0)::bigint AS pedidos_declarados,
       COALESCE(SUM(pg_column_size(payload_json)), 0)::bigint AS bytes_payload_import,
       MIN(created_at) AS mais_antigo, MAX(created_at) AS mais_recente
  FROM central_vendas_imports
 GROUP BY 1, 2, 3
 ORDER BY 4 DESC;

-- @central_copias_superadas
-- Aproximação barata (sem cobertura): por tupla, published além do mais
-- recente = cópia superada candidata à retenção. A retenção real usa a
-- seleção canônica completa (centralVendasRetencao*), não esta consulta.
WITH t AS (
  SELECT id, cliente_slug, cliente_conta_id, marketplace, competencia, fonte, sync_run_id,
         NULLIF(resumo_json->>'pedidosTotal', '')::bigint AS pedidos,
         ROW_NUMBER() OVER (PARTITION BY cliente_slug, cliente_conta_id, marketplace, competencia
                            ORDER BY published_at DESC NULLS LAST, id DESC) AS rn
    FROM central_vendas_imports
   WHERE publication_status = 'published'
)
SELECT COUNT(*) FILTER (WHERE rn > 1)::int AS imports_superados,
       COALESCE(SUM(pedidos) FILTER (WHERE rn > 1), 0)::bigint AS pedidos_em_copias,
       COUNT(*) FILTER (WHERE rn > 1 AND (fonte <> 'orders_api' OR sync_run_id IS NULL))::int AS superados_manuais_protegidos,
       COUNT(DISTINCT (cliente_slug, cliente_conta_id, marketplace, competencia))::int AS tuplas
  FROM t;

-- @central_imports_por_dia
SELECT created_at::date AS dia, COUNT(*)::int AS imports,
       COALESCE(SUM(NULLIF(resumo_json->>'pedidosTotal', '')::bigint), 0)::bigint AS pedidos_gravados
  FROM central_vendas_imports
 WHERE created_at >= NOW() - INTERVAL '14 days'
 GROUP BY 1 ORDER BY 1;

-- @mp_payments_duplicacao
-- n_distinct vem do ANALYZE (pg_stats): negativo = fração das linhas.
SELECT s.tablename AS tabela, c.reltuples::bigint AS linhas_estimadas,
       CASE WHEN s.n_distinct < 0 THEN ROUND(-s.n_distinct * c.reltuples)
            ELSE s.n_distinct END::bigint AS payments_distintos_estimados
  FROM pg_stats s
  JOIN pg_class c ON c.relname = s.tablename
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = s.schemaname
 WHERE s.schemaname = 'public' AND s.tablename = 'central_vendas_mp_payments' AND s.attname = 'payment_id';

-- @syncs_24h
SELECT status, COUNT(*)::int AS runs,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at)))
         FILTER (WHERE finished_at IS NOT NULL AND started_at IS NOT NULL) AS duracao_mediana_s,
       MAX(EXTRACT(EPOCH FROM (finished_at - started_at))) AS duracao_max_s
  FROM central_vendas_sync_runs
 WHERE created_at >= NOW() - INTERVAL '24 hours'
 GROUP BY status ORDER BY 2 DESC;

-- @syncs_escrita_24h
-- Volume gravado por sync (metadata_json.porCompetencia[].persistencia —
-- gravado a partir da Entrega 2; runs antigos não têm e não entram).
SELECT COUNT(*)::int AS imports_medidos,
       COALESCE(SUM((c->>'pedidos')::bigint), 0)::bigint AS pedidos_gravados,
       COALESCE(SUM((c->'persistencia'->>'bytesJsonEstimados')::bigint), 0)::bigint AS bytes_json_gravados,
       COALESCE(SUM((c->'persistencia'->'diff'->>'inalterados')::bigint), 0)::bigint AS pedidos_inalterados,
       COALESCE(SUM((c->'persistencia'->'diff'->>'alterados')::bigint), 0)::bigint AS pedidos_alterados,
       COALESCE(SUM((c->'persistencia'->'diff'->>'novos')::bigint), 0)::bigint AS pedidos_novos,
       COUNT(*) FILTER (WHERE c->'persistencia'->>'formato' = 'cv_sync_manifesto_v1')::int AS imports_enxutos
  FROM central_vendas_sync_runs r
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.metadata_json->'porCompetencia', '[]'::jsonb)) c
 WHERE r.created_at >= NOW() - INTERVAL '24 hours'
   AND c ? 'persistencia';

-- @wal_e_reset
-- stats_reset recente sem ação manual = forte indício de crash-recovery.
SELECT (SELECT stats_reset FROM pg_stat_wal) AS wal_stats_reset,
       (SELECT wal_bytes FROM pg_stat_wal)::bigint AS wal_bytes_acumulado,
       (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS db_stats_reset,
       (SELECT temp_bytes FROM pg_stat_database WHERE datname = current_database())::bigint AS temp_bytes_acumulado;
