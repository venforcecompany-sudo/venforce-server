-- Competências cujo fechamento VIGENTE da Central ainda tem frete de pack duplicado (publicado antes do
-- PR #362, 2026-10-28 17:38Z). SOMENTE LEITURA. Saída = fila de reprocessamento (1 run manual por linha).
-- Uso: \i server/sql/auditoria/central_vendas_historico_frete_pack.sql
\set ON_ERROR_STOP on
\pset pager off
BEGIN READ ONLY;
SET LOCAL statement_timeout = '300s';
WITH vig AS (
  -- mesma ordem de selecionarMelhorImportPorCompetencia para o mês inteiro (published, published_at DESC, id DESC)
  SELECT DISTINCT ON (cliente_slug, marketplace, competencia, COALESCE(cliente_conta_id, -1))
         id, cliente_slug, cliente_conta_id, competencia, published_at
    FROM central_vendas_imports
   WHERE publication_status = 'published'
     AND coverage_date_from <= (competencia || '-01')::date
     AND coverage_date_to >= ((competencia || '-01')::date + interval '1 month - 1 day')::date
   ORDER BY cliente_slug, marketplace, competencia, COALESCE(cliente_conta_id, -1), published_at DESC NULLS LAST, id DESC
), ped AS (
  SELECT v.id import_id, p.shipment_id,
         (SELECT ABS(SUM(c.valor)) FROM central_vendas_componentes c WHERE c.pedido_row_id = p.id AND c.tipo = 'frete_seller') frete
    FROM vig v JOIN central_vendas_pedidos p ON p.import_id = v.id
   WHERE v.published_at < '2026-10-28 17:38+00' AND p.shipment_id IS NOT NULL
), packs AS (
  SELECT import_id, COUNT(*) packs, SUM(n) pedidos, SUM(excesso) excesso
    FROM (SELECT import_id, shipment_id, COUNT(*) n, SUM(frete) - MAX(frete) excesso
            FROM ped WHERE frete IS NOT NULL GROUP BY 1, 2 HAVING COUNT(*) > 1) s
   GROUP BY 1
)
SELECT v.cliente_slug, v.cliente_conta_id, v.competencia, v.id import_vigente, v.published_at::timestamp(0),
       k.packs, k.pedidos, ROUND(k.excesso, 2) excesso_frete,
       v.competencia || '-01' AS "dateFrom",
       to_char((v.competencia || '-01')::date + interval '1 month - 1 day', 'YYYY-MM-DD') AS "dateTo"
  FROM vig v JOIN packs k ON k.import_id = v.id
 ORDER BY v.competencia, k.excesso DESC;
ROLLBACK;
