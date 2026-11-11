// server/tests/centralVendasMp1PaymentsIntegration.test.js
//
// MP1 — Ingestão canônica de Mercado Pago Payments, fim-a-fim através do
// worker real (executarSyncRun) sobre um sync_run real, estubando mlFetch
// (orders/shipments/claims) e mpFetch (v1/payments). Mesmo harness de
// centralVendasM3Completude.test.js, estendido com as tabelas
// central_vendas_mp_payments/central_vendas_mp_payment_charges.
//
// Prova os pontos que só aparecem na integração real:
//   - "payments" é fonte reconhecida mas NUNCA entra em REQUIRED_SOURCES_BASE
//     (falha de Payments não muda o completenessStatus global do run);
//   - isolamento de conta: duas contas ML do mesmo cliente nunca cruzam
//     grant/token na consulta ao Mercado Pago;
//   - Resultado Parcial/margem/ledger (central_vendas_componentes) do motor
//     continuam idênticos com MP1 ligado — nenhum componente novo "mp_*"
//     aparece no ledger, nenhum valor financeiro muda;
//   - Claims/Returns/Frete continuam intactos.

const assert = require("assert");
const Module = require("module");

const runService = require("../services/centralVendas/centralVendasSyncRunService");
const sourceService = require("../services/centralVendas/centralVendasSyncSourceService");
const worker = require("../services/centralVendas/centralVendasSyncWorker");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `FALHOU: ${label} — recebido ${JSON.stringify(actual)}`);
  checks += 1;
}

const cliente = { id: 1, nome: "Loja da Isa", slug: "loja-da-isa" };

function grantFixture({ id, cliente_id, ml_user_id }) {
  return {
    id, cliente_id, ml_user_id,
    access_token: `tok-secreto-${id}`, refresh_token: `ref-secreto-${id}`,
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    token_status: "valid", is_primary: false, refresh_failures: 0, updated_at: new Date().toISOString(),
  };
}

function makeDb({ contas, grants }) {
  const runs = [];
  const sources = [];
  const mpPayments = [];
  const mpCharges = [];
  let nextRunId = 1;
  let nextSourceId = 1;
  let nextMpPaymentId = 1;

  function acharRunAtivo({ clienteId, clienteContaId, marketplace, dateFrom, dateTo }) {
    return runs.find((r) =>
      r.cliente_id === clienteId && (r.cliente_conta_id ?? null) === (clienteContaId ?? null) &&
      r.marketplace === marketplace && r.date_from === dateFrom && r.date_to === dateTo &&
      (r.status === "queued" || r.status === "running")
    ) || null;
  }

  return {
    runs, sources, mpPayments, mpCharges,
    async query(sql, params = []) {
      if (sql.includes("CREATE TABLE") || sql.includes("ALTER TABLE") || sql.includes("CREATE INDEX") || sql.includes("CREATE UNIQUE INDEX") || sql.includes("WITH duplicados_legado") || sql.includes("DROP INDEX") || sql.includes("UPDATE central_vendas_componentes c")) {
        return { rows: [] };
      }
      if (sql.includes("FROM clientes WHERE slug = $1 AND ativo = true")) {
        return { rows: params[0] === cliente.slug ? [cliente] : [] };
      }
      if (sql.includes("FROM clientes WHERE id")) {
        return { rows: params[0] === cliente.id ? [cliente] : [] };
      }
      if (sql.includes("cliente_contas WHERE id = $1")) {
        const row = contas.find((c) => c.id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true ORDER BY is_primary")) {
        return { rows: contas.filter((c) => c.cliente_id === params[0] && c.marketplace === params[1] && c.ativo !== false) };
      }
      if (sql.includes("COUNT(*)::int AS total FROM cliente_contas")) {
        const total = contas.filter((c) => c.cliente_id === params[0] && c.marketplace === params[1] && c.ativo !== false).length;
        return { rows: [{ total }] };
      }
      if (sql.includes("t.cliente_id = $1 AND t.ml_user_id = $2")) {
        const row = grants.find((g) => g.cliente_id === params[0] && String(g.ml_user_id) === String(params[1]));
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("FROM ml_tokens t") && sql.includes("WHERE t.cliente_id = $1")) {
        return { rows: grants.filter((g) => g.cliente_id === params[0]) };
      }
      if (sql.includes("v.cliente_conta_id = $1 AND v.ativo = true")) return { rows: [] };
      if (sql.includes("v.cliente_id = $1 AND v.marketplace = $2 AND v.ativo = true")) return { rows: [] };
      if (sql.includes("FROM custos WHERE base_id")) return { rows: [] };

      if (sql.includes("FROM central_vendas_sync_runs") && sql.includes("status IN ('queued','running')") && !sql.includes("JOIN clientes")) {
        const [clienteId, clienteContaId, marketplace, dateFrom, dateTo] = params;
        const row = acharRunAtivo({ clienteId, clienteContaId, marketplace, dateFrom, dateTo });
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("INSERT INTO central_vendas_sync_runs")) {
        const [clienteId, clienteSlug, clienteContaId, marketplace, externalAccountId, grantId, baseId, baseResolutionMode, dateFrom, dateTo, requestedBy] = params;
        const row = {
          id: nextRunId++, cliente_id: clienteId, cliente_slug: clienteSlug, cliente_conta_id: clienteContaId,
          marketplace, external_account_id: externalAccountId, grant_id: grantId, base_id: baseId,
          base_resolution_mode: baseResolutionMode, date_from: dateFrom, date_to: dateTo, status: "queued",
          requested_by: requestedBy, created_at: new Date().toISOString(), started_at: null, finished_at: null,
          error_code: null, error_message: null, metadata_json: {}, completeness_status: null,
          updated_at: new Date().toISOString(),
        };
        runs.push(row);
        return { rows: [row] };
      }
      if (sql.includes("SYNC_RUN_STALE_QUEUED") || sql.includes("SYNC_RUN_STALE_RUNNING")) return { rows: [] };
      if (sql.includes("UPDATE central_vendas_sync_runs") && sql.includes("status = 'running'") && sql.includes("started_at = NOW()")) {
        const row = runs.find((r) => r.id === params[0] && r.status === "queued");
        if (!row) return { rows: [] };
        Object.assign(row, { status: "running", started_at: new Date().toISOString() });
        return { rows: [row] };
      }
      if (sql.includes("UPDATE central_vendas_sync_runs") && sql.includes("status = 'completed'")) {
        const row = runs.find((r) => r.id === params[0] && r.status === "running");
        if (!row) return { rows: [] };
        Object.assign(row, { status: "completed", finished_at: new Date().toISOString(), metadata_json: JSON.parse(params[1]) });
        return { rows: [row] };
      }
      if (sql.includes("UPDATE central_vendas_sync_runs") && sql.includes("status = 'failed'")) {
        const row = runs.find((r) => r.id === params[0] && r.status === "running");
        if (!row) return { rows: [] };
        Object.assign(row, { status: "failed", finished_at: new Date().toISOString(), error_code: params[1], error_message: params[2] });
        return { rows: [row] };
      }
      if (sql.includes("UPDATE central_vendas_sync_runs") && sql.includes("completeness_status = $2")) {
        const row = runs.find((r) => r.id === params[0]);
        if (!row) return { rows: [] };
        row.completeness_status = params[1];
        return { rows: [row] };
      }
      if (sql.includes("JOIN clientes c ON c.id = r.cliente_id") && sql.includes("r.id = $1 AND c.slug = $2")) {
        const row = runs.find((r) => r.id === params[0] && r.cliente_id === cliente.id && params[1] === cliente.slug);
        return { rows: row ? [row] : [] };
      }

      if (sql.includes("INSERT INTO central_vendas_sync_sources")) {
        const [syncRunId, source] = params;
        const TERMINAL = new Set(["complete", "incomplete", "failed", "not_applicable"]);
        let row = sources.find((r) => r.sync_run_id === syncRunId && r.source === source);
        if (!row) {
          row = {
            id: nextSourceId++, sync_run_id: syncRunId, source, status: "running", complete: null,
            expected_count: null, received_count: null, pages_expected: null, pages_received: null,
            attempts: 1, started_at: new Date().toISOString(), finished_at: null,
            error_code: null, http_status: null, error_message: null, metadata_json: {},
          };
          sources.push(row);
          return { rows: [row] };
        }
        if (TERMINAL.has(row.status)) return { rows: [] };
        row.status = "running";
        row.attempts += 1;
        return { rows: [row] };
      }
      if (sql.includes("UPDATE central_vendas_sync_sources") && sql.includes("status = $3")) {
        const [
          syncRunId, source, status, complete, expectedCount, receivedCount,
          pagesExpected, pagesReceived, errorCode, httpStatus, errorMessage, metadataJson,
        ] = params;
        const TERMINAL = new Set(["complete", "incomplete", "failed", "not_applicable"]);
        const row = sources.find((r) => r.sync_run_id === syncRunId && r.source === source && !TERMINAL.has(r.status));
        if (!row) return { rows: [] };
        Object.assign(row, {
          status, complete, expected_count: expectedCount, received_count: receivedCount,
          pages_expected: pagesExpected, pages_received: pagesReceived, error_code: errorCode,
          http_status: httpStatus, error_message: errorMessage, metadata_json: JSON.parse(metadataJson),
        });
        return { rows: [row] };
      }
      if (sql.includes("status = 'failed', complete = false") && sql.includes("IN ('pending', 'running')")) {
        const [syncRunId, errorCode, errorMessage] = params;
        const afetadas = sources.filter((r) => r.sync_run_id === syncRunId && (r.status === "pending" || r.status === "running"));
        for (const row of afetadas) Object.assign(row, { status: "failed", complete: false, error_code: errorCode, error_message: errorMessage });
        return { rows: afetadas.map((r) => ({ source: r.source })) };
      }
      if (sql.includes("SELECT * FROM central_vendas_sync_sources WHERE sync_run_id = $1")) {
        return { rows: sources.filter((r) => r.sync_run_id === params[0]).sort((a, b) => a.id - b.id) };
      }

      if (sql.includes("SELECT * FROM central_vendas_sync_runs WHERE id = $1")) {
        const row = runs.find((r) => r.id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("UPDATE central_vendas_imports") && sql.includes("publication_status = 'published'")) {
        return { rows: [] };
      }

      // MP1 — central_vendas_mp_payments / central_vendas_mp_payment_charges.
      if (sql.includes("INSERT INTO central_vendas_mp_payments")) {
        const [
          syncRunId, clienteId, clienteContaId, externalAccountId, orderId, orderIdsJson, paymentId,
          status, statusDetail, transactionAmount, transactionAmountRefunded, netReceivedAmount,
          totalPaidAmount, shippingAmount, moneyReleaseDate, moneyReleaseStatus, currencyId,
          dateCreated, dateApproved, dateLastUpdated, refundCount, refundIdsJson,
        ] = params;
        let row = mpPayments.find((r) => r.sync_run_id === syncRunId && r.payment_id === paymentId);
        if (!row) {
          row = { id: nextMpPaymentId++, sync_run_id: syncRunId, payment_id: paymentId };
          mpPayments.push(row);
        }
        Object.assign(row, {
          cliente_id: clienteId, cliente_conta_id: clienteContaId, external_account_id: externalAccountId,
          order_id: orderId, order_ids_json: JSON.parse(orderIdsJson),
          status, status_detail: statusDetail, transaction_amount: transactionAmount,
          transaction_amount_refunded: transactionAmountRefunded, net_received_amount: netReceivedAmount,
          total_paid_amount: totalPaidAmount, shipping_amount: shippingAmount,
          money_release_date: moneyReleaseDate, money_release_status: moneyReleaseStatus,
          currency_id: currencyId, date_created: dateCreated, date_approved: dateApproved,
          date_last_updated: dateLastUpdated, refund_count: refundCount,
          refund_ids_json: JSON.parse(refundIdsJson),
        });
        return { rows: [{ id: row.id }] };
      }
      if (sql.includes("DELETE FROM central_vendas_mp_payment_charges")) {
        const [mpPaymentRowId] = params;
        for (let i = mpCharges.length - 1; i >= 0; i--) {
          if (mpCharges[i].mp_payment_row_id === mpPaymentRowId) mpCharges.splice(i, 1);
        }
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO central_vendas_mp_payment_charges")) {
        const [
          mpPaymentRowId, syncRunId, paymentId, chargeId, name, type,
          amountOriginal, amountRefunded, accountFrom, accountTo,
          metadataShipmentId, metadataSource, metadataSourceDetail,
        ] = params;
        mpCharges.push({
          mp_payment_row_id: mpPaymentRowId, sync_run_id: syncRunId, payment_id: paymentId,
          charge_id: chargeId, name, type, amount_original: amountOriginal, amount_refunded: amountRefunded,
          account_from: accountFrom, account_to: accountTo, metadata_shipment_id: metadataShipmentId,
          metadata_source: metadataSource, metadata_source_detail: metadataSourceDetail,
        });
        return { rows: [] };
      }

      throw new Error(`Fake db: SQL nao mapeado -> ${sql.slice(0, 160)}`);
    },
  };
}

// Estuba mlFetch (orders/shipments/claims) E mpFetch (v1/payments) via
// Module._load. `mpHandlers` mapeia prefixo -> handler(path, options).
function carregarComHandlers(handlers, mpHandlers, mpCalls) {
  const originalLoad = Module._load;
  Module._load = function loadWithStub(request, parent, isMain) {
    if (request === "../../utils/mlClient") {
      return {
        async mlFetch(clienteId, path, options = {}) {
          for (const [prefix, handler] of handlers) {
            if (path.startsWith(prefix)) return handler(path, options);
          }
          return { ok: true, status: 200, data: {} };
        },
      };
    }
    if (request === "../../utils/mercadoPagoClient") {
      return {
        async mpFetch(clienteId, path, options = {}) {
          if (mpCalls) mpCalls.push({ clienteId, path, mlUserId: options.mlUserId });
          for (const [prefix, handler] of (mpHandlers || [])) {
            if (path.startsWith(prefix)) return handler(path, options);
          }
          return { ok: true, status: 200, data: { id: 1, status: "approved" } };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../services/centralVendas/centralVendasSyncService")];
    delete require.cache[require.resolve("../services/centralVendas/centralVendasClaimsService")];
    delete require.cache[require.resolve("../services/centralVendas/centralVendasFreteService")];
    delete require.cache[require.resolve("../services/centralVendas/centralVendasMpPaymentsService")];
    return require("../services/centralVendas/centralVendasSyncService");
  } finally {
    Module._load = originalLoad;
  }
}

function pedido(id, shipmentId, paymentIds = []) {
  return {
    id, date_created: "2026-08-10T10:00:00.000-03:00", status: "paid", tags: [],
    payments: paymentIds.map((pid) => ({ id: pid, order_id: id })),
    shipping: { id: shipmentId },
    order_items: [{ item: { id: "MLB1", seller_sku: null, title: "Produto" }, quantity: 1, unit_price: 100, sale_fee: 10 }],
  };
}

async function novoRunFakeRepo() {
  const fakeRepo = {
    persistedCalls: [],
    async ensureCentralVendasTables() {},
    async getClienteBySlug(slug) { return slug === cliente.slug ? cliente : null; },
    async persistCentralVendasImport(args) {
      this.persistedCalls.push(args);
      return {
        importacao: { id: this.persistedCalls.length },
        pedidosPersistidos: args.motorPayload.pedidos.length,
        itensPersistidos: args.motorPayload.itens.length,
        componentesPersistidos: args.motorPayload.componentes.length,
      };
    },
  };
  return fakeRepo;
}

async function capturandoLogs(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, original); }
}

async function run() {
  const contaA = { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", slug: "loja-isa", external_account_id: "111", is_primary: true, ativo: true };
  const contaB = { id: 11, cliente_id: 1, marketplace: "meli", nome: "ML 2", slug: "loja-isa-2", external_account_id: "222", is_primary: false, ativo: true };
  const grants = [
    grantFixture({ id: 100, cliente_id: 1, ml_user_id: "111" }),
    grantFixture({ id: 101, cliente_id: 1, ml_user_id: "222" }),
  ];

  const orderHandlers = (results, total) => [
    ["/orders/search", () => ({ ok: true, status: 200, data: { results, paging: { total: total ?? results.length } } })],
    ["/shipments/", () => ({ ok: true, status: 200, data: { senders: [{ user_id: "111", cost: 12.5 }, { user_id: "222", cost: 12.5 }], receiver: { cost: 5 } } })],
    ["/post-purchase/v1/claims/search", () => ({ ok: true, status: 200, data: { data: [], paging: { total: 0 } } })],
  ];

  // ── CENÁRIO A: 1 payment coletado com sucesso — payments complete, e
  // claims/returns/shipments/base continuam intactos (caso 22). ───────────
  await capturandoLogs(async () => {
    const db = makeDb({ contas: [contaA], grants });
    const { run: r, context } = await runService.criarSyncRun({
      clienteSlug: cliente.slug, marketplace: "meli", dateFrom: "2026-08-01", dateTo: "2026-08-31", db,
    });
    const fakeRepo = await novoRunFakeRepo();

    const syncService = carregarComHandlers(
      orderHandlers([pedido("9001", "s1", ["PAY1"])]),
      [["/v1/payments/PAY1", () => ({ ok: true, status: 200, data: { id: "PAY1", status: "approved", transaction_amount: 100, transaction_details: { net_received_amount: 88 } } })]],
    );

    const sincronizarVendasMeli = syncService.createCentralVendasSyncService(fakeRepo, db).sincronizarVendasMeli;
    await worker.executarSyncRun({
      run: r, context, db, sincronizarVendasMeli,
      params: { clienteSlug: cliente.slug, dateFrom: "2026-08-01", dateTo: "2026-08-31", marketplace: "meli" },
    });

    const runFinal = await runService.obterSyncRun({ runId: r.id, clienteSlug: cliente.slug, db });
    eq("A: run completed", runFinal.status, "completed");
    eq("A: completude complete", runFinal.completenessStatus, "complete");

    const fontes = await sourceService.listarFontesDoRun(r.id, db);
    const porFonte = Object.fromEntries(fontes.map((f) => [f.source, f]));
    eq("A: payments e' fonte reconhecida e completa", porFonte.payments.status, "complete");
    eq("A: payments 1/1", [porFonte.payments.receivedCount, porFonte.payments.expectedCount], [1, 1]);
    // caso 22 — claims/returns/frete continuam intactos.
    eq("A(22): shipments continua complete", porFonte.shipments.status, "complete");
    eq("A(22): claims continua complete", porFonte.claims.status, "complete");
    eq("A(22): returns continua complete", porFonte.returns.status, "complete");
    eq("A(22): base continua complete", porFonte.base.status, "complete");

    eq("A: payment persistido no banco", db.mpPayments.length, 1);
    eq("A: payment_id correto", db.mpPayments[0].payment_id, "PAY1");
    eq("A: sync_run_id do payment == run", db.mpPayments[0].sync_run_id, r.id);
    eq("A: cliente_conta_id propagado", db.mpPayments[0].cliente_conta_id, 10);
  });

  // ── CENÁRIO B (caso 21): 1 dos 2 payments falha (404) — payments vira
  // incomplete, mas o completenessStatus GLOBAL continua complete (payments
  // NÃO está em REQUIRED_SOURCES_BASE). ───────────────────────────────────
  await capturandoLogs(async () => {
    const db = makeDb({ contas: [contaA], grants });
    const { run: r, context } = await runService.criarSyncRun({
      clienteSlug: cliente.slug, marketplace: "meli", dateFrom: "2026-08-01", dateTo: "2026-08-31", db,
    });
    const fakeRepo = await novoRunFakeRepo();

    const syncService = carregarComHandlers(
      orderHandlers([pedido("9002", "s2", ["PAY_OK", "PAY_404"])]),
      [
        ["/v1/payments/PAY_404", () => ({ ok: false, status: 404, data: null })],
        ["/v1/payments/PAY_OK", () => ({ ok: true, status: 200, data: { id: "PAY_OK", status: "approved", transaction_amount: 50 } })],
      ],
    );

    const sincronizarVendasMeli = syncService.createCentralVendasSyncService(fakeRepo, db).sincronizarVendasMeli;
    await worker.executarSyncRun({
      run: r, context, db, sincronizarVendasMeli,
      params: { clienteSlug: cliente.slug, dateFrom: "2026-08-01", dateTo: "2026-08-31", marketplace: "meli" },
    });

    const runFinal = await runService.obterSyncRun({ runId: r.id, clienteSlug: cliente.slug, db });
    eq("B(21): run tecnico completed", runFinal.status, "completed");
    eq("B(21): completude GLOBAL continua complete (payments nao e' obrigatoria)", runFinal.completenessStatus, "complete");

    const fontes = await sourceService.listarFontesDoRun(r.id, db);
    const porFonte = Object.fromEntries(fontes.map((f) => [f.source, f]));
    eq("B(21): payments fica incomplete", porFonte.payments.status, "incomplete");
    eq("B(21): payments 1/2", [porFonte.payments.receivedCount, porFonte.payments.expectedCount], [1, 2]);
    eq("B: apenas o payment coletado foi persistido", db.mpPayments.length, 1);
    eq("B: payment persistido e' o PAY_OK", db.mpPayments[0].payment_id, "PAY_OK");

    // podeConcluir/publicação não são afetados por MP1 — o run publica normal.
    ok("B: run nao entrou em failed por causa de payments", runFinal.status !== "failed");
  });

  // ── CENÁRIO C (caso 14): duas contas ML do mesmo cliente — isolamento
  // absoluto do token usado para consultar o Mercado Pago. ────────────────
  await capturandoLogs(async () => {
    const mpCalls = [];

    // Conta A (mlUserId=111)
    const dbA = makeDb({ contas: [contaA], grants });
    const { run: rA, context: ctxA } = await runService.criarSyncRun({
      clienteSlug: cliente.slug, marketplace: "meli", clienteContaId: 10, dateFrom: "2026-08-01", dateTo: "2026-08-31", db: dbA,
    });
    const repoA = await novoRunFakeRepo();
    const syncServiceA = carregarComHandlers(
      orderHandlers([pedido("A1", "sA1", ["PAY_A"])]),
      [["/v1/payments/PAY_A", () => ({ ok: true, status: 200, data: { id: "PAY_A", status: "approved", transaction_amount: 10 } })]],
      mpCalls,
    );
    await worker.executarSyncRun({
      run: rA, context: ctxA, db: dbA, sincronizarVendasMeli: syncServiceA.createCentralVendasSyncService(repoA, dbA).sincronizarVendasMeli,
      params: { clienteSlug: cliente.slug, dateFrom: "2026-08-01", dateTo: "2026-08-31", marketplace: "meli" },
    });

    // Conta B (mlUserId=222)
    const dbB = makeDb({ contas: [contaB], grants });
    const { run: rB, context: ctxB } = await runService.criarSyncRun({
      clienteSlug: cliente.slug, marketplace: "meli", clienteContaId: 11, dateFrom: "2026-08-01", dateTo: "2026-08-31", db: dbB,
    });
    const repoB = await novoRunFakeRepo();
    const syncServiceB = carregarComHandlers(
      orderHandlers([pedido("B1", "sB1", ["PAY_B"])]),
      [["/v1/payments/PAY_B", () => ({ ok: true, status: 200, data: { id: "PAY_B", status: "approved", transaction_amount: 20 } })]],
      mpCalls,
    );
    await worker.executarSyncRun({
      run: rB, context: ctxB, db: dbB, sincronizarVendasMeli: syncServiceB.createCentralVendasSyncService(repoB, dbB).sincronizarVendasMeli,
      params: { clienteSlug: cliente.slug, dateFrom: "2026-08-01", dateTo: "2026-08-31", marketplace: "meli" },
    });

    const chamadasPayments = mpCalls.filter((c) => c.path.startsWith("/v1/payments/"));
    const chamadaA = chamadasPayments.find((c) => c.path.includes("PAY_A"));
    const chamadaB = chamadasPayments.find((c) => c.path.includes("PAY_B"));
    eq("C(14): payment da conta A usa mlUserId=111", chamadaA.mlUserId, "111");
    eq("C(14): payment da conta B usa mlUserId=222", chamadaB.mlUserId, "222");
    ok("C(14): nenhuma chamada de payments da conta B usou o mlUserId da conta A",
      chamadasPayments.filter((c) => c.path.includes("PAY_B")).every((c) => c.mlUserId !== "111"));

    eq("C: payment A persistido com cliente_conta_id=10", dbA.mpPayments[0].cliente_conta_id, 10);
    eq("C: payment B persistido com cliente_conta_id=11", dbB.mpPayments[0].cliente_conta_id, 11);
  });

  // ── CENÁRIO D (caso 15, nível sync): 0 Orders -> payments 0/0 complete. ──
  await capturandoLogs(async () => {
    const db = makeDb({ contas: [contaA], grants });
    const { run: r, context } = await runService.criarSyncRun({
      clienteSlug: cliente.slug, marketplace: "meli", dateFrom: "2026-08-01", dateTo: "2026-08-31", db,
    });
    const fakeRepo = await novoRunFakeRepo();
    const syncService = carregarComHandlers(orderHandlers([], 0), []);
    await worker.executarSyncRun({
      run: r, context, db, sincronizarVendasMeli: syncService.createCentralVendasSyncService(fakeRepo, db).sincronizarVendasMeli,
      params: { clienteSlug: cliente.slug, dateFrom: "2026-08-01", dateTo: "2026-08-31", marketplace: "meli" },
    });

    const fontes = await sourceService.listarFontesDoRun(r.id, db);
    const porFonte = Object.fromEntries(fontes.map((f) => [f.source, f]));
    eq("D(15): payments 0/0 complete", [porFonte.payments.status, porFonte.payments.receivedCount, porFonte.payments.expectedCount], ["complete", 0, 0]);
    eq("D: nenhum payment persistido", db.mpPayments.length, 0);
  });

  // ── CENÁRIO E (caso 20): Resultado Parcial/margem/ledger idênticos com
  // MP1 ligado — nenhum componente novo, nenhum valor financeiro alterado. ─
  await capturandoLogs(async () => {
    const db = makeDb({ contas: [contaA], grants });
    const { run: r, context } = await runService.criarSyncRun({
      clienteSlug: cliente.slug, marketplace: "meli", dateFrom: "2026-08-01", dateTo: "2026-08-31", db,
    });
    const fakeRepo = await novoRunFakeRepo();
    const syncService = carregarComHandlers(
      orderHandlers([pedido("9003", "s3", ["PAY_E"])]),
      [["/v1/payments/PAY_E", () => ({
        ok: true, status: 200,
        data: {
          id: "PAY_E", status: "approved", transaction_amount: 100,
          transaction_details: { net_received_amount: 80 },
          charges_details: [{ amounts: { original: 20 }, name: "ml_sale_fee", type: "fee" }],
        },
      })]],
    );
    await worker.executarSyncRun({
      run: r, context, db, sincronizarVendasMeli: syncService.createCentralVendasSyncService(fakeRepo, db).sincronizarVendasMeli,
      params: { clienteSlug: cliente.slug, dateFrom: "2026-08-01", dateTo: "2026-08-31", marketplace: "meli" },
    });

    const call = fakeRepo.persistedCalls[0];
    const pedidoPersistido = call.motorPayload.pedidos[0];
    // Sem custo na base (fake db devolve [] para custos) -> item bloqueado,
    // resultado null (honestidade do dado, comportamento pré-MP1 preservado).
    eq("E(20): resultado do pedido inalterado (null, sem base vinculada)", pedidoPersistido.resultado, null);
    eq("E(20): faturamento inalterado (100, so' orders_api)", pedidoPersistido.faturamento, 100);

    const tiposComponentes = new Set(call.motorPayload.componentes.map((c) => c.tipo));
    ok("E(20): nenhum componente 'mp_*'/'charges_mp' no ledger", [...tiposComponentes].every((t) => !/^mp_|charges/i.test(t)));
    eq("E(20): tipos de componente sao exatamente os pré-MP1 (nenhum tipo novo derivado de charges_details)",
      [...tiposComponentes].sort(),
      ["custo_produto", "frete_seller", "imposto_interno", "receita_envio", "receita_produto", "tarifa_venda"].sort());

    ok("E: payment MP foi persistido de qualquer forma (evidencia, fora do ledger)", db.mpPayments.length === 1);
  });

  // ── CENÁRIO F: flag CENTRAL_VENDAS_MP_PAYMENTS_COLETA_ENABLED — coleta
  // ligada × desligada sobre os MESMOS orders. Desligada: zero chamadas ao
  // MP, zero linhas mp_*, fonte payments=not_applicable com motivo, e o
  // motorPayload (pedidos/itens/componentes) é IDÊNTICO ao da coleta ligada.
  const { ENV_NAME, MOTIVO_COLETA_DESLIGADA } = require("../services/centralVendas/centralVendasMpColetaFlag");
  const envAntes = process.env[ENV_NAME];
  async function rodarComFlag(valorFlag) {
    if (valorFlag === undefined) delete process.env[ENV_NAME];
    else process.env[ENV_NAME] = valorFlag;
    const mpCalls = [];
    const db = makeDb({ contas: [contaA], grants });
    const { run: r, context } = await runService.criarSyncRun({
      clienteSlug: cliente.slug, marketplace: "meli", dateFrom: "2026-08-01", dateTo: "2026-08-31", db,
    });
    const fakeRepo = await novoRunFakeRepo();
    const syncService = carregarComHandlers(
      orderHandlers([pedido("9100", "s100", ["PAY_F1"]), pedido("9101", "s101", ["PAY_F2"])]),
      [
        ["/v1/payments/PAY_F1", () => ({ ok: true, status: 200, data: { id: "PAY_F1", status: "approved", transaction_amount: 100, charges_details: [{ amounts: { original: 12 }, name: "ml_sale_fee", type: "fee" }] } })],
        ["/v1/payments/PAY_F2", () => ({ ok: true, status: 200, data: { id: "PAY_F2", status: "approved", transaction_amount: 100 } })],
      ],
      mpCalls,
    );
    let resultado;
    await worker.executarSyncRun({
      run: r, context, db,
      sincronizarVendasMeli: async (...args) => {
        resultado = await syncService.createCentralVendasSyncService(fakeRepo, db).sincronizarVendasMeli(...args);
        return resultado;
      },
      params: { clienteSlug: cliente.slug, dateFrom: "2026-08-01", dateTo: "2026-08-31", marketplace: "meli" },
    });
    const runFinal = await runService.obterSyncRun({ runId: r.id, clienteSlug: cliente.slug, db });
    const fontes = await sourceService.listarFontesDoRun(r.id, db);
    return { db, mpCalls, fakeRepo, runFinal, resultado, porFonte: Object.fromEntries(fontes.map((f) => [f.source, f])) };
  }

  await capturandoLogs(async () => {
    const ausente = await rodarComFlag(undefined);
    const ligada = await rodarComFlag("true");
    const desligada = await rodarComFlag("false");

    eq("F: flag ausente = coleta ligada (comportamento anterior)", ausente.db.mpPayments.length, 2);
    eq("F: flag true coleta 2 payments", ligada.db.mpPayments.length, 2);
    eq("F: flag true grava charges", ligada.db.mpCharges.length, 1);
    eq("F: flag true payments complete", ligada.porFonte.payments.status, "complete");

    eq("F: flag false NÃO chama o Mercado Pago", desligada.mpCalls.length, 0);
    eq("F: flag false NÃO grava mp_payments", desligada.db.mpPayments.length, 0);
    eq("F: flag false NÃO grava mp_payment_charges", desligada.db.mpCharges.length, 0);
    eq("F: flag false payments=not_applicable", desligada.porFonte.payments.status, "not_applicable");
    eq("F: flag false registra o motivo", desligada.porFonte.payments.metadata.motivo, MOTIVO_COLETA_DESLIGADA);
    eq("F: flag false run completed", desligada.runFinal.status, "completed");
    eq("F: flag false completude global inalterada", desligada.runFinal.completenessStatus, ligada.runFinal.completenessStatus);
    eq("F: flag false demais fontes inalteradas",
      ["orders", "shipments", "claims", "returns", "base"].map((f) => desligada.porFonte[f] && desligada.porFonte[f].status),
      ["orders", "shipments", "claims", "returns", "base"].map((f) => ligada.porFonte[f] && ligada.porFonte[f].status));

    const payloadLigada = ligada.fakeRepo.persistedCalls[0].motorPayload;
    const payloadDesligada = desligada.fakeRepo.persistedCalls[0].motorPayload;
    eq("F: pedidos idênticos ligada × desligada", payloadDesligada.pedidos, payloadLigada.pedidos);
    eq("F: itens idênticos ligada × desligada", payloadDesligada.itens, payloadLigada.itens);
    eq("F: componentes idênticos ligada × desligada", payloadDesligada.componentes, payloadLigada.componentes);
    ok("F: resumo do run declara a coleta desligada",
      desligada.resultado && desligada.resultado.pagamentosMp && desligada.resultado.pagamentosMp.coletaDesligada === true);
  });
  if (envAntes === undefined) delete process.env[ENV_NAME]; else process.env[ENV_NAME] = envAntes;

  console.log(`centralVendasMp1PaymentsIntegration.test.js: ${checks} verificacoes OK`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
