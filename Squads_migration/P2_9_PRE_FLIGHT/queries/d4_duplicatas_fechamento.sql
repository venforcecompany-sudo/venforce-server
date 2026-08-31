-- P2.9 PRE-FLIGHT — d4_duplicatas_fechamento.sql
-- SOMENTE LEITURA. NAO deleta, NAO cria indice. So relatorio.
--
-- Auditoria da unicidade D4 de entregas_cliente, exigida ANTES de aplicar
-- server/sql/migrations/20260828_entregas_cliente_unicidade_p26.sql.
--
-- entregas_cliente(id, cliente_id NULLABLE, cliente_conta_id NULLABLE,
--                  tipo, periodo TEXT LIVRE, publicado BOOL, created_at, ...)

\echo '============================================================'
\echo ' MODO CRU — exatamente o que o indice unico D4 enxerga'
\echo ' chave: (cliente_id, COALESCE(cliente_conta_id,0), periodo)  [periodo textual]'
\echo '============================================================'
SELECT e.cliente_id,
       c.slug AS cliente_slug,
       e.cliente_conta_id,
       e.periodo,
       COUNT(*)                              AS total,
       COUNT(*) FILTER (WHERE e.publicado)   AS publicadas,
       ARRAY_AGG(e.id ORDER BY e.created_at DESC) AS ids_recentes_primeiro,
       MIN(e.created_at)                     AS primeira,
       MAX(e.created_at)                     AS ultima
FROM entregas_cliente e
LEFT JOIN clientes c ON c.id = e.cliente_id
WHERE e.tipo = 'fechamento_mensal'
  AND e.periodo IS NOT NULL
  AND e.cliente_id IS NOT NULL
GROUP BY e.cliente_id, c.slug, e.cliente_conta_id, e.periodo
HAVING COUNT(*) > 1
ORDER BY publicadas DESC, total DESC, c.slug;

\echo ''
\echo '============================================================'
\echo ' MODO CANONICO — normaliza periodo para YYYY-MM antes de agrupar'
\echo ' (encontra duplicatas que o indice CRU nao pegaria: "Maio 2026" vs "2026-05")'
\echo ' heuristica minima: extrai YYYY-MM de "YYYY-MM..." ; nomes de mes PT ficam como estao'
\echo '============================================================'
WITH norm AS (
  SELECT e.*,
         c.slug AS cliente_slug,
         CASE
           WHEN e.periodo ~ '^\d{4}-\d{2}' THEN substring(e.periodo from '^(\d{4}-\d{2})')
           WHEN e.periodo ~ '^\d{4}/\d{2}' THEN replace(substring(e.periodo from '^(\d{4}/\d{2})'), '/', '-')
           ELSE lower(btrim(e.periodo))
         END AS periodo_canon
  FROM entregas_cliente e
  LEFT JOIN clientes c ON c.id = e.cliente_id
  WHERE e.tipo = 'fechamento_mensal'
    AND e.periodo IS NOT NULL
    AND e.cliente_id IS NOT NULL
)
SELECT cliente_id, cliente_slug, cliente_conta_id, periodo_canon,
       COUNT(*)                            AS total,
       COUNT(*) FILTER (WHERE publicado)   AS publicadas,
       ARRAY_AGG(DISTINCT periodo)         AS variacoes_de_texto,
       ARRAY_AGG(id ORDER BY created_at DESC) AS ids_recentes_primeiro
FROM norm
GROUP BY cliente_id, cliente_slug, cliente_conta_id, periodo_canon
HAVING COUNT(*) > 1
ORDER BY publicadas DESC, total DESC, cliente_slug;

\echo ''
\echo '=== DETALHE POR ENTREGA dos grupos duplicados (modo cru) — para decisao humana ==='
WITH grupos AS (
  SELECT cliente_id, cliente_conta_id, periodo
  FROM entregas_cliente
  WHERE tipo='fechamento_mensal' AND periodo IS NOT NULL AND cliente_id IS NOT NULL
  GROUP BY cliente_id, cliente_conta_id, periodo
  HAVING COUNT(*) > 1
)
SELECT e.id, e.cliente_id, c.slug AS cliente_slug, e.cliente_conta_id, e.periodo,
       e.publicado, (e.token_publico IS NOT NULL) AS tem_token_publico, e.created_at
FROM entregas_cliente e
JOIN grupos g
  ON g.cliente_id = e.cliente_id
 AND g.cliente_conta_id IS NOT DISTINCT FROM e.cliente_conta_id
 AND g.periodo = e.periodo
LEFT JOIN clientes c ON c.id = e.cliente_id
ORDER BY c.slug, e.periodo, e.publicado DESC, e.created_at DESC;
