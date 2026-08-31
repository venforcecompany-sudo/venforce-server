-- P2.9 PRE-FLIGHT — d4_classificacao.sql
-- SOMENTE LEITURA. Classifica os grupos duplicados de fechamento_mensal.
--
-- A: nenhum grupo duplicado (query de contagem = 0)            -> indice D4 seguro
-- B: grupo duplicado, 0 publicadas                             -> decisao humana simples
-- C: grupo duplicado, exatamente 1 publicada                   -> decisao humana
-- D: grupo duplicado, 2+ publicadas                            -> BLOQUEIA o indice; cada caso vai para a gestao

\echo '=== CONTAGEM POR CLASSE (modo cru — o que o indice D4 enxerga) ==='
WITH g AS (
  SELECT cliente_id, cliente_conta_id, periodo,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE publicado) AS publicadas
  FROM entregas_cliente
  WHERE tipo='fechamento_mensal' AND periodo IS NOT NULL AND cliente_id IS NOT NULL
  GROUP BY cliente_id, cliente_conta_id, periodo
  HAVING COUNT(*) > 1
)
SELECT
  (SELECT COUNT(*) FROM g)                                  AS grupos_duplicados,
  (SELECT COUNT(*) FROM g WHERE publicadas = 0)             AS classe_B_nenhuma_publicada,
  (SELECT COUNT(*) FROM g WHERE publicadas = 1)             AS classe_C_uma_publicada,
  (SELECT COUNT(*) FROM g WHERE publicadas >= 2)            AS classe_D_multiplas_publicadas,
  CASE WHEN (SELECT COUNT(*) FROM g) = 0 THEN 'A — indice D4 seguro de aplicar'
       WHEN (SELECT COUNT(*) FROM g WHERE publicadas >= 2) > 0 THEN 'D presente — indice D4 BLOQUEADO ate decisao humana'
       ELSE 'B/C — decisao humana simples, sem link publico ambiguo'
  END AS veredito;

\echo ''
\echo '=== CLASSE D — cada linha vai INDIVIDUALMENTE para a gestao (ids + datas) ==='
WITH g AS (
  SELECT cliente_id, cliente_conta_id, periodo,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE publicado) AS publicadas
  FROM entregas_cliente
  WHERE tipo='fechamento_mensal' AND periodo IS NOT NULL AND cliente_id IS NOT NULL
  GROUP BY cliente_id, cliente_conta_id, periodo
  HAVING COUNT(*) FILTER (WHERE publicado) >= 2
)
SELECT e.cliente_id, c.slug AS cliente_slug, e.cliente_conta_id, e.periodo,
       e.id AS entrega_id, e.publicado, e.created_at,
       (e.token_publico IS NOT NULL) AS tem_token_publico
FROM entregas_cliente e
JOIN g ON g.cliente_id = e.cliente_id
     AND g.cliente_conta_id IS NOT DISTINCT FROM e.cliente_conta_id
     AND g.periodo = e.periodo
LEFT JOIN clientes c ON c.id = e.cliente_id
ORDER BY c.slug, e.periodo, e.publicado DESC, e.created_at DESC;

\echo ''
\echo '=== CLASSE B/C — resumo (a gestao confirma qual entrega fica) ==='
WITH g AS (
  SELECT cliente_id, cliente_conta_id, periodo,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE publicado) AS publicadas,
         ARRAY_AGG(id ORDER BY created_at DESC) AS ids
  FROM entregas_cliente
  WHERE tipo='fechamento_mensal' AND periodo IS NOT NULL AND cliente_id IS NOT NULL
  GROUP BY cliente_id, cliente_conta_id, periodo
  HAVING COUNT(*) > 1
)
SELECT g.cliente_id, c.slug AS cliente_slug, g.cliente_conta_id, g.periodo,
       g.total, g.publicadas,
       CASE WHEN g.publicadas = 0 THEN 'B' WHEN g.publicadas = 1 THEN 'C' ELSE 'D' END AS classe,
       g.ids
FROM g
LEFT JOIN clientes c ON c.id = g.cliente_id
WHERE g.publicadas <= 1
ORDER BY classe, c.slug, g.periodo;
