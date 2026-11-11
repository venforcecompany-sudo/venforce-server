// server/services/centralVendas/centralVendasMpPaymentsRepository.js
// MP1 — Persistência de Payments/charges do Mercado Pago (Central de Vendas V3).
//
// Único lugar que grava central_vendas_mp_payments/central_vendas_mp_payment_charges
// — o collector (centralVendasMpPaymentsService) só coleta e normaliza, nunca
// toca no banco. Idempotente dentro do MESMO sync_run_id (UPSERT por
// (sync_run_id, payment_id) + replace das charges do payment); runs
// diferentes do mesmo payment_id viram linhas separadas (auditoria por run —
// ver comentário no schema).
//
// Nunca persiste access_token/refresh_token/Authorization/client_secret —
// sanitizeRawSubObject remove esses campos de refund_charges/update_charges
// (os únicos trechos que ecoam estrutura bruta da API) antes de gravar.

const pool = require("../../config/database");

const CAMPOS_SENSIVEIS = new Set([
  "access_token", "refresh_token", "api_key", "apikey", "password",
  "authorization", "token", "secret", "client_secret", "bearer",
]);

function sanitizeRawSubObject(value) {
  if (Array.isArray(value)) return value.map(sanitizeRawSubObject);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (CAMPOS_SENSIVEIS.has(String(key).toLowerCase())) continue;
      out[key] = sanitizeRawSubObject(val);
    }
    return out;
  }
  return value;
}

function asJson(value) {
  return value === null || value === undefined ? null : JSON.stringify(sanitizeRawSubObject(value));
}

async function upsertMpPayment({
  syncRunId, clienteId, clienteContaId, externalAccountId, orderId, orderIds, paymentId, payment,
}, db = pool) {
  const result = await db.query(
    `INSERT INTO central_vendas_mp_payments (
       sync_run_id, cliente_id, cliente_conta_id, external_account_id, order_id, order_ids_json, payment_id,
       status, status_detail, transaction_amount, transaction_amount_refunded, net_received_amount,
       total_paid_amount, shipping_amount, money_release_date, money_release_status, currency_id,
       date_created, date_approved, date_last_updated, refund_count, refund_ids_json, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,NOW())
     ON CONFLICT (sync_run_id, payment_id) DO UPDATE SET
       cliente_id = EXCLUDED.cliente_id,
       cliente_conta_id = EXCLUDED.cliente_conta_id,
       external_account_id = EXCLUDED.external_account_id,
       order_id = EXCLUDED.order_id,
       order_ids_json = EXCLUDED.order_ids_json,
       status = EXCLUDED.status,
       status_detail = EXCLUDED.status_detail,
       transaction_amount = EXCLUDED.transaction_amount,
       transaction_amount_refunded = EXCLUDED.transaction_amount_refunded,
       net_received_amount = EXCLUDED.net_received_amount,
       total_paid_amount = EXCLUDED.total_paid_amount,
       shipping_amount = EXCLUDED.shipping_amount,
       money_release_date = EXCLUDED.money_release_date,
       money_release_status = EXCLUDED.money_release_status,
       currency_id = EXCLUDED.currency_id,
       date_created = EXCLUDED.date_created,
       date_approved = EXCLUDED.date_approved,
       date_last_updated = EXCLUDED.date_last_updated,
       refund_count = EXCLUDED.refund_count,
       refund_ids_json = EXCLUDED.refund_ids_json,
       updated_at = NOW()
     RETURNING id`,
    [
      syncRunId,
      clienteId,
      clienteContaId,
      externalAccountId,
      orderId,
      JSON.stringify(orderIds || []),
      paymentId,
      payment.status,
      payment.statusDetail,
      payment.transactionAmount,
      payment.transactionAmountRefunded,
      payment.netReceivedAmount,
      payment.totalPaidAmount,
      payment.shippingAmount,
      payment.moneyReleaseDate,
      payment.moneyReleaseStatus,
      payment.currencyId,
      payment.dateCreated,
      payment.dateApproved,
      payment.dateLastUpdated,
      payment.refundCount,
      JSON.stringify(payment.refundIds ?? null),
    ]
  );
  return result.rows[0].id;
}

// Apaga e reinsere as charges do payment — idempotente dentro do mesmo run
// (não há chave estável por charge para UPSERT individual; ver schema).
async function replaceMpPaymentCharges({ mpPaymentRowId, syncRunId, paymentId, charges }, db = pool) {
  await db.query(`DELETE FROM central_vendas_mp_payment_charges WHERE mp_payment_row_id = $1`, [mpPaymentRowId]);

  for (const charge of charges || []) {
    await db.query(
      `INSERT INTO central_vendas_mp_payment_charges (
         mp_payment_row_id, sync_run_id, payment_id, charge_id, name, type,
         amount_original, amount_refunded, account_from, account_to,
         metadata_shipment_id, metadata_source, metadata_source_detail,
         refund_charges_json, update_charges_json
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)`,
      [
        mpPaymentRowId,
        syncRunId,
        paymentId,
        charge.chargeId,
        charge.name,
        charge.type,
        charge.amountOriginal,
        charge.amountRefunded,
        charge.accountFrom,
        charge.accountTo,
        charge.metadataShipmentId,
        charge.metadataSource,
        charge.metadataSourceDetail,
        asJson(charge.refundCharges),
        asJson(charge.updateCharges),
      ]
    );
  }
}

// Persiste todos os payments COLETADOS com sucesso (resultsMap.collected ===
// true) de um coletarPaymentsMp(...). Payments não coletados (404/erro/etc.)
// nunca viram linha — ficam só na metadata de completude da fonte. Falha ao
// persistir UM payment não derruba os demais (seção 14 do spec MP1): cada
// payment é persistido em sua própria tentativa, e o loop continua mesmo se
// uma delas lançar.
async function persistMpPayments({
  syncRunId, clienteId, clienteContaId, externalAccountId, paymentsLote,
}, db = pool) {
  let persistedCount = 0;
  const failedToPersist = [];

  for (const paymentId of paymentsLote.paymentIdsUnique) {
    const r = paymentsLote.resultsMap.get(paymentId);
    if (!r || !r.collected || !r.payment) continue;

    const orderIds = paymentsLote.paymentIdToOrderIds.get(paymentId) || [];
    const orderId = orderIds[0] || null;

    try {
      const rowId = await upsertMpPayment({
        syncRunId, clienteId, clienteContaId, externalAccountId,
        orderId, orderIds, paymentId, payment: r.payment,
      }, db);
      await replaceMpPaymentCharges({
        mpPaymentRowId: rowId, syncRunId, paymentId, charges: r.payment.charges,
      }, db);
      persistedCount += 1;
    } catch (err) {
      failedToPersist.push({ paymentId, error: err?.message || String(err) });
      console.error(`[centralVendas][mp] falha ao persistir payment ${paymentId}:`, err?.message);
    }
  }

  return { persistedCount, failedToPersist };
}

// MP2 — leitura read-only dos Payments persistidos de um run, com o total de
// charges já somado (evidência auxiliar de feeExplanationMatch — seção 20 do
// spec MP2). Aditivo: não altera nenhuma escrita do MP1. `charges_total` usa
// COALESCE(SUM(...),0) só para o caso "0 charges" virar zero real (nunca
// null) — o mesmo payment sem NENHUMA charge é uma soma vazia genuína.
//
// MP3 preflight (seção 1.1 do spec MP3): expõe também status/statusDetail/
// moneyReleaseStatus/moneyReleaseDate/transactionAmountRefunded/refundCount —
// necessários para mpStatus e para distinguir liberação de conciliação
// (seção 9) sem uma segunda query por Payment. Ausência continua NULL, nunca
// convertida em zero/string vazia (mesma garantia do MP1/MP2).
function sanitizePaymentRow(row) {
  return {
    id: Number(row.id),
    syncRunId: Number(row.sync_run_id),
    clienteContaId: row.cliente_conta_id != null ? Number(row.cliente_conta_id) : null,
    orderId: row.order_id || null,
    orderIds: Array.isArray(row.order_ids_json) ? row.order_ids_json : [],
    paymentId: row.payment_id,
    status: row.status ?? null,
    statusDetail: row.status_detail ?? null,
    transactionAmount: row.transaction_amount === null ? null : Number(row.transaction_amount),
    transactionAmountRefunded: row.transaction_amount_refunded === null ? null : Number(row.transaction_amount_refunded),
    netReceivedAmount: row.net_received_amount === null ? null : Number(row.net_received_amount),
    moneyReleaseStatus: row.money_release_status ?? null,
    moneyReleaseDate: row.money_release_date ?? null,
    refundCount: row.refund_count === null || row.refund_count === undefined ? null : Number(row.refund_count),
    chargesTotal: row.charges_total === null ? 0 : Number(row.charges_total),
  };
}

async function listMpPaymentsWithChargesTotalByRun(syncRunId, db = pool) {
  const result = await db.query(
    `SELECT p.*, COALESCE(SUM(c.amount_original), 0)::numeric(14,2) AS charges_total
       FROM central_vendas_mp_payments p
       LEFT JOIN central_vendas_mp_payment_charges c ON c.mp_payment_row_id = p.id
      WHERE p.sync_run_id = $1
      GROUP BY p.id
      ORDER BY p.id ASC`,
    [syncRunId]
  );
  return result.rows.map(sanitizePaymentRow);
}

// V3 P2.7 BLOCO H — cinto de seguranca de CONTA na camada MP.
// Estas tabelas TEM `cliente_conta_id` (e indice dedicado), mas o WHERE
// filtrava so por `sync_run_id`: o isolamento entre contas era 100% transitivo
// pelo array de runs vindo do snapshot. Qualquer erro upstream em
// deriveSyncRunIds virava mistura de contas sem nenhuma deteccao.
// Quando a conta e conhecida, filtramos tambem por ela. Linhas legadas
// (cliente_conta_id NULL) continuam entrando — nao da para atribui-las a uma
// conta e exclui-las derrubaria dado historico; o que passa a ser impossivel e
// entrar linha de OUTRA conta identificada.
function condicaoContaMp(coluna, clienteContaId, params) {
  const id = Number(clienteContaId);
  if (!Number.isInteger(id) || id <= 0) return null;
  params.push(id);
  return `(${coluna} IS NULL OR ${coluna} = $${params.length})`;
}

// MP3 (seção 13 do spec MP3) — mesma leitura acima, mas para VÁRIOS runs de
// uma vez (range que cruza mais de um sync_run_id). Bulk por construção:
// nunca 1 query por Order/por run — quem chama já resolveu o array de
// syncRunIds via resolveRangeImports (M4/account-aware).
async function listMpPaymentsWithChargesTotalByRunIds(syncRunIds, db = pool, { clienteContaId = null } = {}) {
  const ids = Array.isArray(syncRunIds) ? syncRunIds.filter((id) => Number.isFinite(Number(id))) : [];
  if (!ids.length) return [];
  const params = [ids];
  const conta = condicaoContaMp("p.cliente_conta_id", clienteContaId, params);
  const result = await db.query(
    `SELECT p.*, COALESCE(SUM(c.amount_original), 0)::numeric(14,2) AS charges_total
       FROM central_vendas_mp_payments p
       LEFT JOIN central_vendas_mp_payment_charges c ON c.mp_payment_row_id = p.id
      WHERE p.sync_run_id = ANY($1::bigint[])${conta ? ` AND ${conta}` : ""}
      GROUP BY p.id
      ORDER BY p.id ASC`,
    params
  );
  return result.rows.map(sanitizePaymentRow);
}

// Runs (do conjunto dado) cuja fonte "payments" foi registrada como
// `not_applicable` porque a coleta automática estava desligada pela flag
// (centralVendasMpColetaFlag). 1 query, só sobre central_vendas_sync_sources
// (tabela pequena, índice por sync_run_id). Usada pela conciliação para
// distinguir "coleta desligada" de "pendente".
async function listRunIdsComColetaPaymentsDesligada(syncRunIds, db = pool) {
  const ids = Array.isArray(syncRunIds) ? syncRunIds.filter((id) => Number.isFinite(Number(id))) : [];
  if (!ids.length) return [];
  const { MOTIVO_COLETA_DESLIGADA } = require("./centralVendasMpColetaFlag");
  const result = await db.query(
    `SELECT DISTINCT sync_run_id
       FROM central_vendas_sync_sources
      WHERE sync_run_id = ANY($1::bigint[])
        AND source = 'payments'
        AND status = 'not_applicable'
        AND metadata_json->>'motivo' = $2`,
    [ids, MOTIVO_COLETA_DESLIGADA]
  );
  return result.rows.map((r) => Number(r.sync_run_id));
}

module.exports = {
  listRunIdsComColetaPaymentsDesligada,
  upsertMpPayment,
  replaceMpPaymentCharges,
  persistMpPayments,
  listMpPaymentsWithChargesTotalByRun,
  listMpPaymentsWithChargesTotalByRunIds,
};
