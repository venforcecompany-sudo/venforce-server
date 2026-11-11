-- server/sql/observabilidade/reuso_vinculos_cliente.sql
--
-- READ-ONLY. Versão do Raio-X de reuso_vinculos.sql: mesma saída, mas RESTRINGE
-- cliente (e conta) ANTES de qualquer agregação. A global (reuso_vinculos.sql)
-- continua sendo a consulta de observabilidade geral.
--
-- Parâmetros: $1 = cliente_id (bigint), $2 = cliente_slug (text), $3 = cliente_conta_id (bigint ou NULL = todas).
--
-- Por que é barata: parte dos imports do cliente (`alvo`, tabela pequena), entra em
-- central_vendas_import_pedidos pelo prefixo da PK (import_id; LATERAL força o index scan) e só
-- então busca o dono de cada linha por central_vendas_pedidos.id (PK). Não varre vínculos nem pedidos de
-- outros clientes. Dono e referenciador pertencem sempre à mesma tupla (cliente × conta ×
-- marketplace × competência), então partir dos referenciadores enxerga todos os fornecedores.

WITH alvo AS (
  SELECT id, cliente_slug, marketplace, competencia, cliente_conta_id, publication_status
    FROM central_vendas_imports
   WHERE (cliente_id = $1 OR cliente_slug = $2)
     AND ($3::bigint IS NULL OR cliente_conta_id = $3::bigint)
), vinc AS (
  -- LATERAL + OFFSET 0: um index scan pelo prefixo da PK (import_id) por import do cliente.
  -- Sem isso o planner escolhe hash semi join e varre central_vendas_import_pedidos inteira.
  SELECT a.id AS usuario, x.pedido_row_id
    FROM alvo a
   CROSS JOIN LATERAL (
     SELECT v.pedido_row_id FROM central_vendas_import_pedidos v WHERE v.import_id = a.id OFFSET 0
   ) x
), usos AS (
  SELECT p.import_id AS dono, vinc.usuario, COUNT(*) AS linhas
    FROM vinc
    JOIN central_vendas_pedidos p ON p.id = vinc.pedido_row_id
   WHERE p.import_id <> vinc.usuario
   GROUP BY 1, 2
), fornece AS (
  SELECT dono AS import_id, SUM(linhas)::bigint AS linhas_fornecidas,
         array_agg(usuario ORDER BY usuario) AS usado_por_imports
    FROM usos GROUP BY 1
), referencia AS (
  SELECT usuario AS import_id, COUNT(*)::bigint AS vinculos FROM vinc GROUP BY 1
)
SELECT i.id AS import_id, i.cliente_slug, i.marketplace, i.competencia, i.cliente_conta_id,
       i.publication_status,
       CASE WHEN f.import_id IS NOT NULL AND r.import_id IS NOT NULL THEN 'ambos'
            WHEN f.import_id IS NOT NULL THEN 'fornece' ELSE 'referencia' END AS papel,
       COALESCE(f.linhas_fornecidas, 0) AS linhas_fornecidas,
       f.usado_por_imports,
       COALESCE(r.vinculos, 0) AS vinculos
  FROM alvo i
  LEFT JOIN fornece f ON f.import_id = i.id
  LEFT JOIN referencia r ON r.import_id = i.id
 WHERE f.import_id IS NOT NULL OR r.import_id IS NOT NULL
 ORDER BY i.cliente_slug, i.cliente_conta_id NULLS FIRST, i.competencia, i.id;
