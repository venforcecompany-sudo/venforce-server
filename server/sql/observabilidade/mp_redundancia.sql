-- server/sql/observabilidade/mp_redundancia.sql
--
-- Mercado Pago Payments/charges: o que é único, o que é cópia por run e o que
-- tem consumidor. SOMENTE LEITURA. Não apaga nada.
--
-- Consumidor efetivo (código): a Conciliação MP lê Payments SÓ dos
-- sync_run_ids dos imports que a seleção canônica escolheu para o período
-- (centralVendasMp3ReadService.deriveSyncRunIds). Payment de run cujo import
-- foi superado não é lido por nenhuma tela.
--
-- "Runs a manter" (conservador): runs de imports published mais recentes de
-- cada tupla (cliente, conta, marketplace, competência) + runs de qualquer
-- import dos últimos 7 dias (carência; candidates incluídos) + runs que têm
-- Settlement Report (MP2) + runs sem import nenhum dos últimos 7 dias.
--
-- Custo: COUNT(DISTINCT) e agregações sobre ~1 M / ~4,6 M linhas — rodar
-- fora de horário de pico, em sessão read-only, com statement_timeout:
--   psql "$URL" -v ON_ERROR_STOP=1 -c "SET default_transaction_read_only=on" \
--        -c "SET statement_timeout='120s'" -f mp_redundancia.sql

-- @mp_unicos_x_copias
SELECT COUNT(*)::bigint AS linhas_payments,
       COUNT(DISTINCT payment_id)::bigint AS payments_unicos,
       COUNT(DISTINCT sync_run_id)::bigint AS runs,
       ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT payment_id), 0), 2) AS copias_por_payment
  FROM central_vendas_mp_payments;

-- @mp_runs_a_manter
WITH ult AS (
  SELECT sync_run_id,
         ROW_NUMBER() OVER (PARTITION BY cliente_slug, cliente_conta_id, marketplace, competencia
                            ORDER BY published_at DESC NULLS LAST, id DESC) AS rn
    FROM central_vendas_imports
   WHERE publication_status = 'published' AND sync_run_id IS NOT NULL
), manter AS (
  SELECT sync_run_id FROM ult WHERE rn = 1
  UNION SELECT sync_run_id FROM central_vendas_imports
         WHERE sync_run_id IS NOT NULL AND created_at >= NOW() - INTERVAL '7 days'
  UNION SELECT sync_run_id FROM central_vendas_mp_settlement_reports
  UNION SELECT id FROM central_vendas_sync_runs r
         WHERE r.created_at >= NOW() - INTERVAL '7 days'
)
SELECT (p.sync_run_id IN (SELECT sync_run_id FROM manter)) AS tem_consumidor,
       COUNT(*)::bigint AS linhas_payments,
       COUNT(DISTINCT p.payment_id)::bigint AS payments_distintos,
       COALESCE(SUM(pg_column_size(p.*)), 0)::bigint AS bytes_payments_aprox,
       COALESCE(SUM(c.n), 0)::bigint AS linhas_charges,
       COALESCE(SUM(c.bytes), 0)::bigint AS bytes_charges_aprox
  FROM central_vendas_mp_payments p
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS n, SUM(pg_column_size(ch.*)) AS bytes
      FROM central_vendas_mp_payment_charges ch WHERE ch.mp_payment_row_id = p.id
  ) c ON true
 GROUP BY 1
 ORDER BY 1 DESC;

-- @mp_payments_sem_nenhuma_copia_mantida
-- Payments que só existem em runs SEM consumidor (apagar o run perderia o
-- único registro daquele payment). Esperado ~0: o run vigente costuma ter
-- coletado o mesmo payment de novo. O que aparecer aqui deve ser preservado
-- (ou recoletado) antes de qualquer retenção.
WITH ult AS (
  SELECT sync_run_id,
         ROW_NUMBER() OVER (PARTITION BY cliente_slug, cliente_conta_id, marketplace, competencia
                            ORDER BY published_at DESC NULLS LAST, id DESC) AS rn
    FROM central_vendas_imports
   WHERE publication_status = 'published' AND sync_run_id IS NOT NULL
), manter AS (
  SELECT sync_run_id FROM ult WHERE rn = 1
  UNION SELECT sync_run_id FROM central_vendas_imports
         WHERE sync_run_id IS NOT NULL AND created_at >= NOW() - INTERVAL '7 days'
  UNION SELECT sync_run_id FROM central_vendas_mp_settlement_reports
  UNION SELECT id FROM central_vendas_sync_runs r WHERE r.created_at >= NOW() - INTERVAL '7 days'
)
SELECT COUNT(DISTINCT payment_id)::bigint AS payments_so_em_runs_sem_consumidor
  FROM central_vendas_mp_payments p
 WHERE p.sync_run_id NOT IN (SELECT sync_run_id FROM manter)
   AND NOT EXISTS (SELECT 1 FROM central_vendas_mp_payments q
                    WHERE q.payment_id = p.payment_id AND q.sync_run_id IN (SELECT sync_run_id FROM manter));
