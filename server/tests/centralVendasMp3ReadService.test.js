// server/tests/centralVendasMp3ReadService.test.js
//
// MP3 — GET .../read/mercado-pago/reconciliation (range-aware). Mesmo padrão
// de fake db de centralVendasM7Read.test.js: as funções REAIS de
// centralVendasRepository rodam contra uma fake db em memória; Payments/
// Settlement são fakes simples em memória (arrays), injetados diretamente no
// service (createCentralVendasMp3ReadService aceita os repositories MP1/MP2
// como parâmetros) — sem precisar duplicar toda a fake db de Postgres para
// 2 tabelas novas.
//
// Prova: reaproveita a MESMA seleção M4/account-aware do resto da Central
// (nunca "o último sync run"), deriva sync_run_ids do snapshot já resolvido
// (nunca uma query nova por pedido), nunca mistura conta A com conta B, e
// nunca dispara mais que 1 query bulk por fonte (Payments/Settlement/Report)
// independente do número de pedidos no período.

const assert = require("assert");
const repository = require("../services/centralVendas/centralVendasRepository");
const {
  createCentralVendasMp3ReadService,
  classificarMpReconciliationStatus,
} = require("../services/centralVendas/centralVendasMp3ReadService");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `FALHOU: ${label} — recebido ${JSON.stringify(actual)}`);
  checks += 1;
}

const cliente = { id: 1, nome: "Cliente A", slug: "cliente-a", ativo: true };

function realRepositoryComDb(db) {
  return {
    ensureCentralVendasTables: () => repository.ensureCentralVendasTables(db),
    getClienteBySlug: (slug) => repository.getClienteBySlug(slug, db),
    getCentralVendasByRange: (args) => repository.getCentralVendasByRange(args, db),
    resolveImportsForRange: (args) => repository.resolveImportsForRange(args, db),
    loadPedidosByImportIds: (args) => repository.loadPedidosByImportIds(args, db),
    getPedidoDetailByRowId: (args) => repository.getPedidoDetailByRowId(args, db),
  };
}

function makeDb({ contas = [], imports = [], pedidos = [], itens = [], componentes = [] }) {
  return {
    async query(sql, params = []) {
      if (sql.includes("CREATE TABLE") || sql.includes("ALTER TABLE") || sql.includes("CREATE INDEX") || sql.includes("CREATE UNIQUE INDEX") || sql.includes("WITH duplicados")) {
        return { rows: [] };
      }
      if (sql.includes("FROM clientes") && sql.includes("slug = $1")) {
        return { rows: params[0] === cliente.slug ? [cliente] : [] };
      }
      if (sql.includes("FROM clientes") && sql.includes("WHERE id")) {
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
      if (sql.includes("FROM ml_tokens t")) return { rows: [] };
      if (sql.includes("v.cliente_conta_id = $1 AND v.ativo = true")) return { rows: [] };
      if (sql.includes("v.cliente_id = $1 AND v.marketplace = $2 AND v.ativo = true")) return { rows: [] };

      if (sql.includes("competencia BETWEEN $3 AND $4") && sql.includes("FROM central_vendas_imports")) {
        const [slug, marketplace, compFrom, compTo] = params;
        let candidatos = imports.filter((row) =>
          row.cliente_slug === slug && row.marketplace === marketplace &&
          row.competencia >= compFrom && row.competencia <= compTo &&
          (row.publication_status === "published" || row.publication_status === "legacy")
        );
        if (params.length >= 5) {
          const clienteContaId = params[4];
          if (sql.includes("OR cliente_conta_id IS NULL")) {
            candidatos = candidatos.filter((r) => r.cliente_conta_id === clienteContaId || r.cliente_conta_id == null);
          } else {
            candidatos = candidatos.filter((r) => r.cliente_conta_id === clienteContaId);
          }
        }
        return { rows: candidatos };
      }
      if (sql.includes("FROM central_vendas_pedidos") && sql.includes("LIMIT 1")) {
        const [rowId, importIds, dateFrom, dateTo] = params;
        const found = pedidos.find((p) => p.id === rowId && importIds.includes(p.import_id) && p.data_pedido >= dateFrom && p.data_pedido <= dateTo);
        return { rows: found ? [found] : [] };
      }
      if (sql.includes("FROM central_vendas_pedidos") && sql.includes("import_id = ANY")) {
        const [importIds, dateFrom, dateTo] = params;
        return { rows: pedidos.filter((p) => importIds.includes(p.import_id) && p.data_pedido >= dateFrom && p.data_pedido <= dateTo) };
      }
      if (sql.includes("FROM central_vendas_pedido_itens") && sql.includes("pedido_row_id = ANY")) {
        const [rowIds] = params;
        return { rows: itens.filter((i) => rowIds.includes(i.pedido_row_id)) };
      }
      if (sql.includes("FROM central_vendas_componentes") && sql.includes("pedido_row_id = ANY")) {
        const [rowIds] = params;
        return { rows: componentes.filter((c) => rowIds.includes(c.pedido_row_id)) };
      }

      // A tabela de vínculos não existe nesta fixture (reuso desligado).
      if (/to_regclass\('public\.central_vendas_import_pedidos'\)/.test(String(sql))) return { rows: [{ ok: false }] };
      throw new Error(`Fake db: SQL nao mapeado -> ${sql.slice(0, 160)}`);
    },
  };
}

function importRow({ id, competencia, publicationStatus, coverageFrom, coverageTo, publishedAt = null, contaId = null, syncRunId = null }) {
  return {
    id, cliente_slug: cliente.slug, marketplace: "meli", competencia,
    cliente_conta_id: contaId, publication_status: publicationStatus,
    coverage_date_from: coverageFrom, coverage_date_to: coverageTo, published_at: publishedAt,
    fonte: "orders_api", status: "processado", confianca: "confiavel",
    resumo_json: {}, payload_json: {}, created_at: "2026-08-01T00:00:00.000Z",
    sync_run_id: syncRunId,
  };
}

function pedidoRow({ id, importId, pedidoId, data, faturamento = 100, resultado = null, confianca = "confiavel", status = "paid" }) {
  return { id, import_id: importId, pedido_id: pedidoId, data_pedido: data, status, confianca, faturamento, resultado, pendencias_json: [], payload_json: {} };
}

function componenteRow({ id, importId, pedidoRowId, tipo, valor }) {
  return { id, import_id: importId, pedido_row_id: pedidoRowId, item_row_id: null, pedido_id: null, item_id: null, tipo, valor, confianca: "confiavel", escopo: "pedido", efeito: "debito", incluido_no_resultado: true };
}

// Fake dos repositories MP1/MP2 — arrays em memória filtrados por
// sync_run_id, com contador de chamadas para provar "1 query bulk" (nunca
// N+1 por pedido).
function makeMpRepos({ payments = [], movements = [], reports = [] }) {
  let paymentsCalls = 0, movementsCalls = 0, reportsCalls = 0;
  return {
    calls: { get payments() { return paymentsCalls; }, get movements() { return movementsCalls; }, get reports() { return reportsCalls; } },
    mpPaymentsRepository: {
      async listMpPaymentsWithChargesTotalByRunIds(ids) {
        paymentsCalls += 1;
        return payments.filter((p) => ids.includes(p.syncRunId));
      },
    },
    mpSettlementRepository: {
      async listSettlementMovementsByRunIds(ids) {
        movementsCalls += 1;
        return movements.filter((m) => ids.includes(m.syncRunId));
      },
      async listSettlementReportsByRunIds(ids) {
        reportsCalls += 1;
        return reports.filter((r) => ids.includes(r.syncRunId));
      },
    },
  };
}

function paymentFixture({ syncRunId, orderId, paymentId, transactionAmount, netReceivedAmount, moneyReleaseStatus = null }) {
  return { syncRunId, orderId, orderIds: [orderId], paymentId, transactionAmount, transactionAmountRefunded: 0, netReceivedAmount, moneyReleaseStatus, moneyReleaseDate: null, refundCount: 0, chargesTotal: 0 };
}
function movementFixture({ syncRunId, sourceId, orderId, transactionAmount, feeAmount, settlementNetAmount }) {
  return { syncRunId, sourceId, orderId, shippingId: null, transactionType: "SETTLEMENT", transactionAmount, feeAmount, settlementNetAmount, realAmount: settlementNetAmount, moneyReleaseDate: null };
}

async function run() {
  // 1 — fluxo feliz: 1 conta, 1 run, 1 pedido matched_clean.
  {
    const imp = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z", syncRunId: 501 });
    const pedidos = [pedidoRow({ id: 1, importId: 1, pedidoId: "O1", data: "2026-08-10", faturamento: 100, resultado: 60 })];
    const componentes = [
      componenteRow({ id: 1, importId: 1, pedidoRowId: 1, tipo: "custo_produto", valor: 30 }),
      componenteRow({ id: 2, importId: 1, pedidoRowId: 1, tipo: "imposto_interno", valor: 5 }),
    ];
    const db = makeDb({ imports: [imp], pedidos, componentes });
    const mp = makeMpRepos({
      payments: [paymentFixture({ syncRunId: 501, orderId: "O1", paymentId: "P1", transactionAmount: 100, netReceivedAmount: 80, moneyReleaseStatus: "released" })],
      movements: [movementFixture({ syncRunId: 501, sourceId: "P1", orderId: "O1", transactionAmount: 100, feeAmount: -20, settlementNetAmount: 80 })],
      reports: [{ syncRunId: 501, status: "imported", fileName: "x.csv", rowsCount: 1, errorCode: null }],
    });
    const svc = createCentralVendasMp3ReadService(realRepositoryComDb(db), db, mp.mpPaymentsRepository, mp.mpSettlementRepository);

    const resp = await svc.getMercadoPagoReconciliationForRange(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    eq("1: ok", resp.ok, true);
    eq("1: 1 row", resp.rows.length, 1);
    eq("1: mpStatus matched_clean", resp.rows[0].mpStatus, "matched_clean");
    eq("1: resultadoConciliadoMpBase = 80-30-5=45", resp.rows[0].resultadoConciliadoMpBase, 45);
    eq("1: mpReconciliationStatus complete (100% cobertura)", resp.mpReconciliationStatus, "complete");
    eq("1: report exposto", resp.reports, [{ syncRunId: 501, status: "imported", fileName: "x.csv", rowsCount: 1, errorCode: null }]);
    eq("1: 1 unica query bulk de payments", mp.calls.payments, 1);
    eq("1: 1 unica query bulk de movements", mp.calls.movements, 1);
  }

  // 2 — range com 2 sync_runs (2 meses, 2 imports diferentes) — Payments dos
  // 2 runs entram, nunca so o "ultimo run".
  {
    const imports = [
      importRow({ id: 1, competencia: "2026-07", publicationStatus: "published", coverageFrom: "2026-07-01", coverageTo: "2026-07-31", publishedAt: "2026-07-31T10:00:00Z", syncRunId: 601 }),
      importRow({ id: 2, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-31T10:00:00Z", syncRunId: 602 }),
    ];
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "OJUL", data: "2026-07-15", faturamento: 50, resultado: 40 }),
      pedidoRow({ id: 2, importId: 2, pedidoId: "OAGO", data: "2026-08-15", faturamento: 70, resultado: 60 }),
    ];
    const componentes = [
      componenteRow({ id: 1, importId: 1, pedidoRowId: 1, tipo: "custo_produto", valor: 5 }),
      componenteRow({ id: 2, importId: 1, pedidoRowId: 1, tipo: "imposto_interno", valor: 0 }),
      componenteRow({ id: 3, importId: 2, pedidoRowId: 2, tipo: "custo_produto", valor: 5 }),
      componenteRow({ id: 4, importId: 2, pedidoRowId: 2, tipo: "imposto_interno", valor: 0 }),
    ];
    const db = makeDb({ imports, pedidos, componentes });
    const mp = makeMpRepos({
      payments: [
        paymentFixture({ syncRunId: 601, orderId: "OJUL", paymentId: "PJUL", transactionAmount: 50, netReceivedAmount: 45 }),
        paymentFixture({ syncRunId: 602, orderId: "OAGO", paymentId: "PAGO", transactionAmount: 70, netReceivedAmount: 65 }),
      ],
      movements: [
        movementFixture({ syncRunId: 601, sourceId: "PJUL", orderId: "OJUL", transactionAmount: 50, feeAmount: -5, settlementNetAmount: 45 }),
        movementFixture({ syncRunId: 602, sourceId: "PAGO", orderId: "OAGO", transactionAmount: 70, feeAmount: -5, settlementNetAmount: 65 }),
      ],
      reports: [],
    });
    const svc = createCentralVendasMp3ReadService(realRepositoryComDb(db), db, mp.mpPaymentsRepository, mp.mpSettlementRepository);
    const resp = await svc.getMercadoPagoReconciliationForRange(cliente.slug, { dateFrom: "2026-07-01", dateTo: "2026-08-31" });
    eq("2: 2 rows (1 por mes/run)", resp.rows.length, 2);
    eq("2: OJUL conciliado (run 601)", resp.rows.find((r) => r.orderId === "OJUL").resultadoConciliadoMpBase, 40);
    eq("2: OAGO conciliado (run 602)", resp.rows.find((r) => r.orderId === "OAGO").resultadoConciliadoMpBase, 60);
    eq("2: ainda 1 unica query bulk (nunca 1 por run)", mp.calls.payments, 1);
  }

  // 2b — BLOCO 11A: um MESMO run/import cobre pedidos de Julho E Agosto (ex.:
  // sync que puxou um pedido datado em Agosto para uma competencia 2026-07).
  // Consulta so Julho: as `rows` ja respeitavam o mes, mas o `summary`
  // (paymentsUnique / totalPaymentGross|Net / postMovementsCount) respondia
  // pelo run inteiro. Agora o summary tambem e recortado ao periodo.
  {
    const imp = importRow({ id: 1, competencia: "2026-07", publicationStatus: "published", coverageFrom: "2026-07-01", coverageTo: "2026-07-31", publishedAt: "2026-07-31T10:00:00Z", syncRunId: 601 });
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "O-JUL", data: "2026-07-20", faturamento: 50, resultado: 40 }),
      pedidoRow({ id: 2, importId: 1, pedidoId: "O-AGO", data: "2026-08-03", faturamento: 70, resultado: 55 }),
    ];
    const componentes = [
      componenteRow({ id: 1, importId: 1, pedidoRowId: 1, tipo: "custo_produto", valor: 5 }),
      componenteRow({ id: 2, importId: 1, pedidoRowId: 1, tipo: "imposto_interno", valor: 0 }),
      componenteRow({ id: 3, importId: 1, pedidoRowId: 2, tipo: "custo_produto", valor: 5 }),
      componenteRow({ id: 4, importId: 1, pedidoRowId: 2, tipo: "imposto_interno", valor: 0 }),
    ];
    const db = makeDb({ imports: [imp], pedidos, componentes });
    const mp = makeMpRepos({
      payments: [
        paymentFixture({ syncRunId: 601, orderId: "O-JUL", paymentId: "P-JUL", transactionAmount: 50, netReceivedAmount: 45 }),
        paymentFixture({ syncRunId: 601, orderId: "O-AGO", paymentId: "P-AGO", transactionAmount: 70, netReceivedAmount: 65 }),
      ],
      movements: [
        movementFixture({ syncRunId: 601, sourceId: "P-JUL", orderId: "O-JUL", transactionAmount: 50, feeAmount: -5, settlementNetAmount: 45 }),
        movementFixture({ syncRunId: 601, sourceId: "P-AGO", orderId: "O-AGO", transactionAmount: 70, feeAmount: -5, settlementNetAmount: 65 }),
      ],
      reports: [],
    });
    const svc = createCentralVendasMp3ReadService(realRepositoryComDb(db), db, mp.mpPaymentsRepository, mp.mpSettlementRepository);

    const julho = await svc.getMercadoPagoReconciliationForRange(cliente.slug, { dateFrom: "2026-07-01", dateTo: "2026-07-31" });
    eq("2b: Julho — 1 row (so O-JUL)", julho.rows.length, 1);
    eq("2b: Julho — paymentsUnique = 1 (P-AGO fora do recorte)", julho.summary.paymentsUnique, 1);
    eq("2b: Julho — totalPaymentGross = 50 (nao 120)", julho.summary.totalPaymentGross, 50);
    eq("2b: Julho — totalPaymentNet = 45 (nao 110)", julho.summary.totalPaymentNet, 45);
    eq("2b: Julho — recorteTemporal declara o corte", julho.summary.recorteTemporal, { paymentsNoRun: 2, paymentsNoRange: 1, movimentosNoRun: 2, movimentosNoRange: 1 });

    const agosto = await svc.getMercadoPagoReconciliationForRange(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    // Agosto nao tem import com competencia 2026-08 → snapshot vazio → nada de MP.
    ok("2b: Agosto != Julho — nao herda os numeros de Julho", agosto.summary.paymentsUnique !== julho.summary.paymentsUnique || agosto.summary.totalPaymentGross === 0);
  }

  // 3 — account-aware: conta A nunca ve Payments/Settlement/pedidos da conta B.
  {
    const contas = [
      { id: 10, cliente_id: 1, marketplace: "meli", ativo: true, is_primary: true },
      { id: 20, cliente_id: 1, marketplace: "meli", ativo: true, is_primary: false },
    ];
    const imports = [
      importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z", contaId: 10, syncRunId: 701 }),
      importRow({ id: 2, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z", contaId: 20, syncRunId: 702 }),
    ];
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "O-CONTA-A", data: "2026-08-10", faturamento: 100, resultado: 60 }),
      pedidoRow({ id: 2, importId: 2, pedidoId: "O-CONTA-B", data: "2026-08-10", faturamento: 200, resultado: 100 }),
    ];
    const db = makeDb({ contas, imports, pedidos });
    const mp = makeMpRepos({
      payments: [
        paymentFixture({ syncRunId: 701, orderId: "O-CONTA-A", paymentId: "P-A", transactionAmount: 100, netReceivedAmount: 90 }),
        paymentFixture({ syncRunId: 702, orderId: "O-CONTA-B", paymentId: "P-B", transactionAmount: 200, netReceivedAmount: 190 }),
      ],
      movements: [],
      reports: [],
    });
    const svc = createCentralVendasMp3ReadService(realRepositoryComDb(db), db, mp.mpPaymentsRepository, mp.mpSettlementRepository);
    const resp = await svc.getMercadoPagoReconciliationForRange(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", clienteContaId: 10 });
    eq("3: so o pedido da conta A", resp.rows.map((r) => r.orderId), ["O-CONTA-A"]);
    ok("3: nenhuma referencia a P-B/O-CONTA-B na resposta", !JSON.stringify(resp).includes("P-B") && !JSON.stringify(resp).includes("O-CONTA-B"));
  }

  // 4 — sem nenhum sync_run (import legado, sem MP nunca sincronizado) ->
  // mpReconciliationStatus not_available, nunca crash.
  {
    const imp = importRow({ id: 1, competencia: "2026-08", publicationStatus: "legacy", coverageFrom: null, coverageTo: null, syncRunId: null });
    const pedidos = [pedidoRow({ id: 1, importId: 1, pedidoId: "O1", data: "2026-08-10", faturamento: 100, resultado: 60 })];
    const db = makeDb({ imports: [imp], pedidos });
    const mp = makeMpRepos({ payments: [], movements: [], reports: [] });
    const svc = createCentralVendasMp3ReadService(realRepositoryComDb(db), db, mp.mpPaymentsRepository, mp.mpSettlementRepository);
    const resp = await svc.getMercadoPagoReconciliationForRange(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    eq("4: mpReconciliationStatus not_available", resp.mpReconciliationStatus, "not_available");
    eq("4: pedido ainda aparece na row, so sem conciliacao", resp.rows[0].mpStatus, "payment_missing");
  }

  // 5 — paginação: rows fatiadas, mas summary/mpReconciliationStatus
  // continuam sobre o universo inteiro.
  {
    const imp = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z", syncRunId: 801 });
    const pedidos = Array.from({ length: 5 }, (_, i) => pedidoRow({ id: i + 1, importId: 1, pedidoId: `O${i + 1}`, data: "2026-08-10", faturamento: 10, resultado: 5 }));
    const db = makeDb({ imports: [imp], pedidos });
    const mp = makeMpRepos({ payments: [], movements: [], reports: [] });
    const svc = createCentralVendasMp3ReadService(realRepositoryComDb(db), db, mp.mpPaymentsRepository, mp.mpSettlementRepository);
    const resp = await svc.getMercadoPagoReconciliationForRange(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", page: 1, limit: 2 });
    eq("5: 2 rows na pagina", resp.rows.length, 2);
    eq("5: pagination.total = 5", resp.pagination.total, 5);
    eq("5: summary.ordersTotal = 5 (universo inteiro)", resp.summary.ordersTotal, 5);
  }

  // 6 — hardening final MP3 (ponto 1): modo full=1 devolve o RANGE INTEIRO
  // (>200 pedidos) numa unica execucao — summary correto, pedido alem da
  // posicao 200 disponivel, e nenhuma query extra (nunca N+1, nunca uma
  // segunda reconciliacao por pagina).
  {
    const TOTAL_PEDIDOS = 250;
    const imp = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z", syncRunId: 901 });
    const pedidos = Array.from({ length: TOTAL_PEDIDOS }, (_, i) => pedidoRow({ id: i + 1, importId: 1, pedidoId: `O${i + 1}`, data: "2026-08-10", faturamento: 10, resultado: 5 }));
    const componentes = pedidos.flatMap((_, i) => [
      componenteRow({ id: i * 2 + 1, importId: 1, pedidoRowId: i + 1, tipo: "custo_produto", valor: 2 }),
      componenteRow({ id: i * 2 + 2, importId: 1, pedidoRowId: i + 1, tipo: "imposto_interno", valor: 0 }),
    ]);
    const db = makeDb({ imports: [imp], pedidos, componentes });
    const payments = pedidos.map((_, i) => paymentFixture({ syncRunId: 901, orderId: `O${i + 1}`, paymentId: `P${i + 1}`, transactionAmount: 10, netReceivedAmount: 8 }));
    const movements = pedidos.map((_, i) => movementFixture({ syncRunId: 901, sourceId: `P${i + 1}`, orderId: `O${i + 1}`, transactionAmount: 10, feeAmount: -2, settlementNetAmount: 8 }));
    const mp = makeMpRepos({ payments, movements, reports: [{ syncRunId: 901, status: "imported" }] });
    const svc = createCentralVendasMp3ReadService(realRepositoryComDb(db), db, mp.mpPaymentsRepository, mp.mpSettlementRepository);

    const resp = await svc.getMercadoPagoReconciliationForRange(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", full: 1 });
    eq("6: full=1 devolve TODOS os rows (nao so 200)", resp.rows.length, TOTAL_PEDIDOS);
    eq("6: summary.ordersTotal cobre o range inteiro", resp.summary.ordersTotal, TOTAL_PEDIDOS);
    ok("6: pedido alem da posicao 200 esta no indice", resp.rows.some((r) => r.orderId === "O250"));
    eq("6: pagination.total = 250", resp.pagination.total, TOTAL_PEDIDOS);
    ok("6: pagination.full=true", resp.pagination.full === true);
    ok("6: nao truncado (250 < teto de seguranca)", resp.pagination.truncatedBySafetyLimit === false);
    eq("6: ainda 1 unica query bulk de payments (nunca N+1)", mp.calls.payments, 1);
    eq("6: ainda 1 unica query bulk de movements (nunca N+1)", mp.calls.movements, 1);
    eq("6: ainda 1 unica query bulk de reports (nunca N+1)", mp.calls.reports, 1);
  }

  // 7 — sem full: comportamento paginado de sempre, inalterado.
  {
    const imp = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z", syncRunId: 902 });
    const pedidos = Array.from({ length: 3 }, (_, i) => pedidoRow({ id: i + 1, importId: 1, pedidoId: `O${i + 1}`, data: "2026-08-10", faturamento: 10, resultado: 5 }));
    const db = makeDb({ imports: [imp], pedidos });
    const mp = makeMpRepos({ payments: [], movements: [], reports: [] });
    const svc = createCentralVendasMp3ReadService(realRepositoryComDb(db), db, mp.mpPaymentsRepository, mp.mpSettlementRepository);
    const resp = await svc.getMercadoPagoReconciliationForRange(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", page: 1, limit: 2 });
    eq("7: sem full, continua paginado (2 rows)", resp.rows.length, 2);
    ok("7: pagination.full ausente/falsy (comportamento antigo preservado)", !resp.pagination.full);
  }

  // 8 — classificarMpReconciliationStatus: correcao do status global do
  // Settlement pendente. 0% de cobertura com Payments em settlement_pending
  // NUNCA é "partial" (era o bug); 0% de cobertura por settlement_missing
  // definitivo NUNCA vira "pending" (nunca confundir os dois motivos).
  {
    const base = { syncRunIds: [1], summary: {
      ordersTotal: 425, paymentsUnique: 425, paymentsSettlementPending: 425,
      coveragePercent: 0, ordersDivergent: 0, ordersAmbiguous: 0,
    } };
    eq("8: 425 pending / 0 cobertos -> pending", classificarMpReconciliationStatus(base), "pending");

    const parcial = { syncRunIds: [1], summary: {
      ordersTotal: 425, paymentsUnique: 425, paymentsSettlementPending: 225,
      coveragePercent: 47.06, ordersDivergent: 0, ordersAmbiguous: 0,
    } };
    eq("8: 200 matched + 225 pending -> partial", classificarMpReconciliationStatus(parcial), "partial");

    const completo = { syncRunIds: [1], summary: {
      ordersTotal: 425, paymentsUnique: 425, paymentsSettlementPending: 0,
      coveragePercent: 100, ordersDivergent: 0, ordersAmbiguous: 0,
    } };
    eq("8: 425 matched / 100% -> complete", classificarMpReconciliationStatus(completo), "complete");

    const divergente = { syncRunIds: [1], summary: {
      ordersTotal: 425, paymentsUnique: 425, paymentsSettlementPending: 0,
      coveragePercent: 99, ordersDivergent: 1, ordersAmbiguous: 0,
    } };
    eq("8: 1 divergent -> divergent", classificarMpReconciliationStatus(divergente), "divergent");

    // 0% de cobertura por settlement_missing DEFINITIVO (nao pending) —
    // nunca chamar isso de "pending" (regra explicita do hardening).
    const missingDefinitivo = { syncRunIds: [1], summary: {
      ordersTotal: 10, paymentsUnique: 10, paymentsSettlementPending: 0,
      coveragePercent: 0, ordersDivergent: 0, ordersAmbiguous: 0,
    } };
    eq("8: 0% cobertura por settlement_missing (nao pending) -> partial", classificarMpReconciliationStatus(missingDefinitivo), "partial");
  }

  // 9 — coleta MP desligada pela flag: run sem Payments cuja fonte payments
  // foi registrada como not_applicable (motivo da flag) ⇒ "collection_disabled",
  // nunca "pending"; sem o registro, continua "pending" (comportamento antigo).
  for (const [runsDesligados, esperado] of [[[701], "collection_disabled"], [[], "pending"]]) {
    const imp = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z", syncRunId: 701 });
    const pedidos = [pedidoRow({ id: 1, importId: 1, pedidoId: "O9", data: "2026-08-10", faturamento: 100, resultado: 60 })];
    const db = makeDb({ imports: [imp], pedidos, componentes: [] });
    const mp = makeMpRepos({ payments: [], movements: [], reports: [] });
    let consultas = 0;
    mp.mpPaymentsRepository.listRunIdsComColetaPaymentsDesligada = async (ids) => {
      consultas += 1;
      return runsDesligados.filter((id) => ids.includes(id));
    };
    const svc = createCentralVendasMp3ReadService(realRepositoryComDb(db), db, mp.mpPaymentsRepository, mp.mpSettlementRepository);
    const resp = await svc.getMercadoPagoReconciliationForRange(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    eq(`9: status ${esperado}`, resp.mpReconciliationStatus, esperado);
    eq("9: 1 consulta extra só no caso sem payments", consultas, 1);
    eq("9: coletaPayments declarado só quando desligada",
      resp.coletaPayments || null,
      runsDesligados.length ? { desligada: true, runsSemColeta: [701] } : null);
  }

  console.log(`centralVendasMp3ReadService.test.js: ${checks} verificacoes OK`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
