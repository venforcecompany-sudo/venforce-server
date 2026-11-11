// server/services/centralVendas/centralVendasMp3ReadService.js
// MP3 — Read API canônica e range-aware da conciliação Mercado Pago.
//
// Reaproveita integralmente `centralVendasService.resolveRangeContext`
// (mesma seleção M4/account-aware do resto da Central — nunca uma segunda
// implementação) e `buildPayloadFromRange` (contrato canônico de pedido,
// M5/M6). O que este arquivo adiciona é: derivar os sync_run_ids elegíveis
// daquele MESMO snapshot já resolvido (nunca "o último Sync Run do
// cliente" — seção 12 do spec MP3), carregar Payments/Settlement em BULK
// (1 query cada, nunca 1 por pedido — seção 13) e combinar com
// centralVendasMp3ResultadoConciliadoService (a fórmula financeira em si).
//
// mpReconciliationStatus é um eixo PRÓPRIO (seção 19 do spec MP3) — nunca
// entra em REQUIRED_SOURCES_BASE/completeness_status do run (M3).

const pool = require("../../config/database");

function getRepository() {
  return require("./centralVendasRepository");
}
function getMpPaymentsRepository() {
  return require("./centralVendasMpPaymentsRepository");
}
function getMpSettlementRepository() {
  return require("./centralVendasMpSettlementRepository");
}

const {
  createCentralVendasService,
  buildPayloadFromRange,
  buildContextoPayload,
} = require("./centralVendasService");
const { reconcilePayments } = require("./centralVendasMpReconciliationService");
const { computeResultadoConciliadoMp } = require("./centralVendasMp3ResultadoConciliadoService");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// Hardening final MP3 (ponto 1) — teto de segurança do modo `full` (índice
// completo do range para os drawers), coerente com o teto já usado pela
// Central para "todos os pedidos de um período" (centralVendasSyncService
// MAX_PAGINAS=100 * 50/página = 5.000 pedidos). Nunca um payload ilimitado.
const MAX_INDEX_ROWS = 5000;

function clampPage(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
function clampLimit(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}
function isFullModeRequested(value) {
  return value === true || value === "1" || value === 1 || value === "true";
}

// Deriva os sync_run_ids elegíveis do MESMO snapshot que a Read API já
// resolveu (snapshot.imports — seção 12 do spec MP3: nunca "o último run do
// cliente", sempre os imports/sync_runs realmente selecionados pelo M4 para
// o range/conta pedidos). Imports legados (pré-M2, sem sync_run_id) são
// ignorados aqui — nunca produzem Payment/Settlement, e isso é esperado.
function deriveSyncRunIds(snapshot) {
  const imports = (snapshot && snapshot.imports) || [];
  const ids = imports
    .map((row) => (row.sync_run_id != null ? Number(row.sync_run_id) : null))
    .filter((id) => Number.isFinite(id));
  return [...new Set(ids)];
}

// classificação simples e explícita (seção 8/19 do spec MP3) — nunca um
// booleano único escondendo o motivo.
//
// Correção (status global do Settlement pendente): coveragePercent === 0
// com Payments existentes NÃO é "partial" por si só — só é "pending" quando
// a causa é settlement ainda não importado (assíncrono, seção do hardening
// MP3). Zero cobertura por settlement_missing definitivo (nenhum Payment em
// settlement_pending) nunca vira "pending" — cai em "partial", igual a
// qualquer outra cobertura incompleta.
function classificarMpReconciliationStatus({ syncRunIds, summary }) {
  if (!syncRunIds.length || summary.ordersTotal === 0) return "not_available";
  if (summary.ordersDivergent > 0 || summary.ordersAmbiguous > 0) return "divergent";
  if (summary.paymentsUnique === 0) return "pending";
  if (summary.coveragePercent >= 99.995) return "complete";
  if (summary.coveragePercent === 0 && summary.paymentsSettlementPending > 0) return "pending";
  return "partial";
}

function createCentralVendasMp3ReadService(
  repository = getRepository(),
  db = pool,
  mpPaymentsRepository = getMpPaymentsRepository(),
  mpSettlementRepository = getMpSettlementRepository()
) {
  const base = createCentralVendasService(repository, db);

  async function getMercadoPagoReconciliationForRange(clienteSlug, params = {}) {
    const { dateFrom, dateTo, marketplace = "meli", clienteContaId = null, page, limit, full } = params;

    const { cliente, context, snapshot, dateFrom: from, dateTo: to } =
      await base.resolveRangeContext(clienteSlug, { dateFrom, dateTo, marketplace, clienteContaId });

    const payload = buildPayloadFromRange(cliente, { dateFrom: from, dateTo: to }, snapshot);
    const pedidos = payload.pedidos || [];
    const syncRunIds = deriveSyncRunIds(snapshot);

    // Bulk por construção (seção 13 do spec MP3): 3 queries no TOTAL,
    // nunca 1 por pedido/por run — mesmo espírito de performance do M10.
    // V3 P2.7 BLOCO H — a conta RESOLVIDA (nao a pedida) tambem vai para as
    // queries de MP. O isolamento entre contas era 100% transitivo pelo array
    // de runs; agora ha um segundo filtro, na propria tabela.
    const contaResolvidaId = context?.conta?.id || null;
    const escopoConta = { clienteContaId: contaResolvidaId };

    const [paymentsDoRun, movementsDoRun, reports] = await Promise.all([
      mpPaymentsRepository.listMpPaymentsWithChargesTotalByRunIds(syncRunIds, db, escopoConta),
      mpSettlementRepository.listSettlementMovementsByRunIds(syncRunIds, db, escopoConta),
      mpSettlementRepository.listSettlementReportsByRunIds(syncRunIds, db, escopoConta),
    ]);

    // V3 Pós-Convergência #2 — BLOCO 11A: recorte temporal do SUMMARY.
    // O range corta os PEDIDOS (M4/buildPayloadFromRange), mas Payments e
    // Settlement chegam por sync_run_id INTEIRO. Um run que cobre Julho E
    // Agosto fazia `summary.paymentsUnique` / `totalPaymentGross|Net` /
    // `postMovementsCount` responderem pelos dois meses enquanto as `rows`
    // (por pedido) respeitavam só o mês pedido — divergência silenciosa.
    // Aqui recortamos Payments/movimentos ao MESMO universo de pedidos que a
    // consulta resolveu. Isolamento por conta continua sendo dos runs +
    // escopoConta (inalterado); este filtro é só o recorte de PERÍODO.
    const orderIdsDoRange = new Set(pedidos.map((p) => String(p.id)));
    const pagamentoTocaOPedidoDoRange = (p) => {
      const ids = Array.isArray(p.orderIds) && p.orderIds.length
        ? p.orderIds
        : (p.orderId != null ? [p.orderId] : []);
      return ids.some((id) => orderIdsDoRange.has(String(id)));
    };
    const payments = paymentsDoRun.filter(pagamentoTocaOPedidoDoRange);
    const paymentIdsDoRange = new Set(payments.map((p) => p.paymentId));
    const movements = movementsDoRun.filter(
      (m) => m.sourceId != null && paymentIdsDoRange.has(m.sourceId)
    );
    const recorteRange = {
      paymentsNoRun: paymentsDoRun.length,
      paymentsNoRange: payments.length,
      movimentosNoRun: movementsDoRun.length,
      movimentosNoRange: movements.length,
    };

    // Hardening final MP3 (ponto 2) — reports já carregados em bulk acima
    // (1 query, nunca 1 por run); propagados para reconcilePayments
    // distinguir settlement_pending (report ainda nao "imported") de
    // settlement_missing (definitivo, so quando o report do run ja importou).
    const { rows: reconciliationRows, summary: mpSummary } = reconcilePayments({ payments, movements, reports });
    const { rows, summary } = computeResultadoConciliadoMp({
      pedidos,
      reconciliationRows,
      transactionTypeCounts: mpSummary.transactionTypeCounts,
    });

    let mpReconciliationStatus = classificarMpReconciliationStatus({ syncRunIds, summary });

    // Coleta MP desligada (centralVendasMpColetaFlag): sem Payments no range e
    // pelo menos um run do snapshot registrou payments=not_applicable pelo
    // motivo da flag ⇒ "collection_disabled". Nunca "pending" (não há nada a
    // chegar) e nunca zero. Consulta extra só neste caso (paymentsUnique 0).
    let coletaPayments = null;
    if (
      summary.paymentsUnique === 0
      && syncRunIds.length
      && mpReconciliationStatus !== "not_available"
      && typeof mpPaymentsRepository.listRunIdsComColetaPaymentsDesligada === "function"
    ) {
      const runsDesligados = await mpPaymentsRepository.listRunIdsComColetaPaymentsDesligada(syncRunIds, db);
      if (runsDesligados.length) {
        mpReconciliationStatus = "collection_disabled";
        coletaPayments = { desligada: true, runsSemColeta: runsDesligados };
      }
    }
    const total = rows.length;

    // Hardening final MP3 (ponto 1) — modo `full`: os `rows` já foram
    // computados UMA vez, para o range inteiro, na mesma execução acima
    // (nunca uma segunda reconciliação nem 1 query por página) — este modo
    // só decide NÃO fatiar o resultado, para servir de índice completo aos
    // drawers de pedido (nunca perder pedidos além da posição 200 nem
    // depender da paginação da tabela principal). Teto de segurança
    // MAX_INDEX_ROWS (mesmo espírito do MAX_PAGINAS do Sync) protege contra
    // ranges anormalmente grandes — nunca um payload ilimitado.
    let pageRows;
    let pagination;
    if (isFullModeRequested(full)) {
      const truncatedBySafetyLimit = total > MAX_INDEX_ROWS;
      pageRows = truncatedBySafetyLimit ? rows.slice(0, MAX_INDEX_ROWS) : rows;
      pagination = {
        page: 1, limit: pageRows.length, total, totalPages: 1,
        full: true, truncatedBySafetyLimit,
      };
    } else {
      const pageClamped = clampPage(page);
      const limitClamped = clampLimit(limit);
      const totalPages = total ? Math.ceil(total / limitClamped) : 0;
      const inicio = (pageClamped - 1) * limitClamped;
      pageRows = rows.slice(inicio, inicio + limitClamped);
      pagination = { page: pageClamped, limit: limitClamped, total, totalPages };
    }

    return {
      ok: true,
      cliente,
      periodo: payload.periodo,
      contexto: buildContextoPayload(context),
      mpReconciliationStatus,
      ...(coletaPayments ? { coletaPayments } : {}),
      // `recorteTemporal` DECLARA que Payments/movimentos foram recortados ao
      // período (nunca escondido): se `paymentsNoRun > paymentsNoRange`, o run
      // cobre mais que o mês pedido e o summary reflete só o mês.
      summary: { ...summary, recorteTemporal: recorteRange },
      reports: reports.map((r) => ({
        syncRunId: r.syncRunId, status: r.status, fileName: r.fileName,
        rowsCount: r.rowsCount, errorCode: r.errorCode,
      })),
      rows: pageRows,
      pagination,
    };
  }

  return { getMercadoPagoReconciliationForRange };
}

module.exports = {
  createCentralVendasMp3ReadService,
  getMercadoPagoReconciliationForRange: (...args) =>
    createCentralVendasMp3ReadService().getMercadoPagoReconciliationForRange(...args),
  deriveSyncRunIds,
  classificarMpReconciliationStatus,
  MAX_INDEX_ROWS,
};
