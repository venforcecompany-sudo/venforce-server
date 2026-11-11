-- server/sql/observabilidade/reuso_vinculos.sql
--
-- READ-ONLY. Lista os imports que participam do reuso de pedidos
-- (central_vendas_import_pedidos), por papel:
--   fornece    — é DONO de linhas que OUTRO import usa  → NÃO pode ser apagado;
--   referencia — tem vínculos para linhas de outros imports (apagá-lo apaga os
--                vínculos por CASCADE e o export CSV por import_id NÃO os leva);
--   ambos.
-- Vazio = nenhum import em modo reuso ⇒ a retenção atual não esbarra nele.
-- Se a tabela não existir (migration não aplicada) a consulta falha com
-- "relation ... does not exist": também significa "sem reuso".
--
-- Uso: BEGIN READ ONLY; \i reuso_vinculos.sql; ROLLBACK;  (ou psql -f, com
-- default_transaction_read_only=on). Não depende de parâmetros.

WITH usos AS (
  SELECT p.import_id AS dono, v.import_id AS usuario, COUNT(*) AS linhas
    FROM central_vendas_import_pedidos v
    JOIN central_vendas_pedidos p ON p.id = v.pedido_row_id
   WHERE p.import_id <> v.import_id
   GROUP BY 1, 2
), fornece AS (
  SELECT dono AS import_id, SUM(linhas)::bigint AS linhas_fornecidas,
         array_agg(usuario ORDER BY usuario) AS usado_por_imports
    FROM usos GROUP BY 1
), referencia AS (
  SELECT import_id, COUNT(*)::bigint AS vinculos FROM central_vendas_import_pedidos GROUP BY 1
)
SELECT i.id AS import_id, i.cliente_slug, i.marketplace, i.competencia, i.cliente_conta_id,
       i.publication_status,
       CASE WHEN f.import_id IS NOT NULL AND r.import_id IS NOT NULL THEN 'ambos'
            WHEN f.import_id IS NOT NULL THEN 'fornece' ELSE 'referencia' END AS papel,
       COALESCE(f.linhas_fornecidas, 0) AS linhas_fornecidas,
       f.usado_por_imports,
       COALESCE(r.vinculos, 0) AS vinculos
  FROM central_vendas_imports i
  LEFT JOIN fornece f ON f.import_id = i.id
  LEFT JOIN referencia r ON r.import_id = i.id
 WHERE f.import_id IS NOT NULL OR r.import_id IS NOT NULL
 ORDER BY i.cliente_slug, i.cliente_conta_id NULLS FIRST, i.competencia, i.id;
