// Janela da Orders API × data LITERAL do pedido (fecha a edge documentada em
// centralVendasTimezoneFronteira.test.js).
//
// Antes: busca ${dia}T00:00−03:00..T23:59−03:00 e agrupamento pela string do ML
// (−04:00). Um pedido às 23:30−04:00 de 30/09 (= 00:30−03:00 de 01/10) ficava fora
// do run de setembro e, no run de outubro, virava um import 2026-09 com cobertura
// 2026-10-01..2026-09-30 — publicado, nunca selecionável, e o pedido sumia de todo
// fechamento vigente (produção, 29/10/2026: 515 imports assim, 449 published).
//
// Prova: a janela tem folga de ±3h; o run só mantém pedidos com dia literal no
// intervalo; competência com cobertura vazia nunca é gravada; e o pedido da virada
// cai no run do mês dele.

const assert = require("assert");
const Module = require("module");

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `FALHOU: ${label} — recebido ${JSON.stringify(actual)}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const cliente = { id: 1, nome: "Loja Fuso", slug: "loja-fuso" };
const ACCOUNT_CONTEXT = { mlUserId: "111", base: null };

function carregarComHandlers(handlers, capturas) {
  const originalLoad = Module._load;
  Module._load = function loadWithStub(request, parent, isMain) {
    if (request === "../../utils/mlClient") {
      return {
        async mlFetch(clienteId, path, options = {}) {
          capturas.push(path);
          for (const [prefix, handler] of handlers) {
            if (path.startsWith(prefix)) return handler(path, options);
          }
          return { ok: true, status: 200, data: {} };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    for (const m of ["centralVendasSyncService", "centralVendasClaimsService", "centralVendasFreteService"]) {
      delete require.cache[require.resolve(`../services/centralVendas/${m}`)];
    }
    return require("../services/centralVendas/centralVendasSyncService");
  } finally {
    Module._load = originalLoad;
  }
}

function pedidoApi(id, dateCreated) {
  return {
    id, date_created: dateCreated, status: "paid", tags: [], payments: [],
    shipping: { id: `SHIP-${id}`, logistic_type: "cross_docking" },
    order_items: [{ item: { id: "MLB111", seller_sku: "SKU-1", title: "Produto" }, quantity: 1, unit_price: 100, sale_fee: 10 }],
  };
}

function fakeRepo() {
  return {
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
}

async function silencioso(fn) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
}

// O ML falso devolve só o que está na janela pedida (comparação por instante, como a API).
const VIRADA = pedidoApi("VIRADA", "2026-09-30T23:30:00.000-04:00"); // 01/10 00:30 em Brasília
const OUTUBRO = pedidoApi("OUT", "2026-10-15T10:00:00.000-04:00");
const INICIO_SET = pedidoApi("INI_SET", "2026-08-31T23:30:00.000-04:00"); // 01/09 00:30 em Brasília
const SETEMBRO = pedidoApi("SET", "2026-09-10T10:00:00.000-04:00");

async function sincronizar(dateFrom, dateTo, resultados) {
  const capturas = [];
  const repo = fakeRepo();
  const svc = carregarComHandlers([
    ["/orders/search", (path) => {
      const qs = new URLSearchParams(path.split("?")[1]);
      const de = Date.parse(qs.get("order.date_created.from"));
      const ate = Date.parse(qs.get("order.date_created.to"));
      const naJanela = resultados.filter((o) => Date.parse(o.date_created) >= de && Date.parse(o.date_created) <= ate);
      return { ok: true, status: 200, data: { results: naJanela, paging: { total: naJanela.length } } };
    }],
  ], capturas);
  const { sincronizarVendasMeli } = svc.createCentralVendasSyncService(repo, {});
  await silencioso(() => sincronizarVendasMeli({ clienteSlug: cliente.slug, marketplace: "meli", accountContext: ACCOUNT_CONTEXT, dateFrom, dateTo }));
  const busca = new URLSearchParams(capturas.find((p) => p.startsWith("/orders/search")).split("?")[1]);
  return { repo, busca };
}

async function run() {
  const svc = carregarComHandlers([], []);

  // ── janela com folga de ±3h, inclusive na virada de ano ──
  eq("janela de outubro", svc.janelaBuscaOrders("2026-10-01", "2026-10-28"),
    { from: "2026-09-30T21:00:00.000-03:00", to: "2026-10-29T02:59:59.999-03:00" });
  eq("janela na virada de ano", svc.janelaBuscaOrders("2027-01-01", "2027-01-31"),
    { from: "2026-12-31T21:00:00.000-03:00", to: "2027-02-01T02:59:59.999-03:00" });
  eq("janela fevereiro bissexto", svc.janelaBuscaOrders("2028-02-01", "2028-02-29").to, "2028-03-01T02:59:59.999-03:00");

  // ── filtro pela data literal ──
  const f = svc.filtrarPorDataLiteral([VIRADA, OUTUBRO, { id: "SEM_DATA" }], "2026-10-01", "2026-10-31");
  eq("run de outubro descarta o pedido de 30/09 literal", f.orders.map((o) => o.id), ["OUT", "SEM_DATA"]);
  eq("conta o que ficou fora", f.foraDaJanelaLiteral, 1);
  eq("run de setembro mantém o pedido de 30/09 literal",
    svc.filtrarPorDataLiteral([VIRADA, SETEMBRO], "2026-09-01", "2026-09-30").orders.map((o) => o.id), ["VIRADA", "SET"]);

  // ── cobertura de competência fora do run é vazia ──
  const cob = svc.coverageParaCompetencia("2026-09", "2026-10-01", "2026-10-28");
  eq("cobertura de 2026-09 num run de outubro é invertida", cob.coverageFrom > cob.coverageTo, true);

  // ── sync de verdade (só o mlFetch é falso) ──
  const out = await sincronizar("2026-10-01", "2026-10-28", [VIRADA, OUTUBRO]);
  eq("busca de outubro usa a janela com folga (from)", out.busca.get("order.date_created.from"), "2026-09-30T21:00:00.000-03:00");
  eq("busca de outubro usa a janela com folga (to)", out.busca.get("order.date_created.to"), "2026-10-29T02:59:59.999-03:00");
  eq("run de outubro grava só a competência 2026-10 (nada de 2026-09 com cobertura vazia)",
    out.repo.persistedCalls.map((c) => c.competencia), ["2026-10"]);
  eq("pedido da virada não entra no fechamento de outubro",
    out.repo.persistedCalls[0].motorPayload.pedidos.map((p) => String(p.pedidoId || p.pedido_id || p.id)), ["OUT"]);

  const set = await sincronizar("2026-09-01", "2026-09-30", [INICIO_SET, SETEMBRO, VIRADA]);
  eq("run de setembro grava só 2026-09 (o pedido de 31/08 literal não vira import 2026-08)",
    set.repo.persistedCalls.map((c) => c.competencia), ["2026-09"]);
  eq("pedido da virada (30/09 literal) entra no fechamento de setembro",
    set.repo.persistedCalls[0].motorPayload.pedidos.map((p) => String(p.pedidoId || p.pedido_id || p.id)).sort(), ["SET", "VIRADA"]);
  eq("cobertura gravada de setembro é o mês inteiro",
    [set.repo.persistedCalls[0].coverageDateFrom, set.repo.persistedCalls[0].coverageDateTo], ["2026-09-01", "2026-09-30"]);

  // ── run vazio continua gravando o snapshot vazio de cada competência do intervalo (M4 §8) ──
  // Sem a folga, a janela antiga (T00:00..T23:59 −03:00) não traria o pedido da virada:
  const antiga = { de: Date.parse("2026-09-01T00:00:00.000-03:00"), ate: Date.parse("2026-09-30T23:59:59.999-03:00") };
  eq("a janela antiga não alcançava o pedido de 30/09 23:30 −04:00",
    Date.parse(VIRADA.date_created) <= antiga.ate, false);

  const vazio = await sincronizar("2026-09-01", "2026-09-30", []);
  eq("run sem pedidos ainda grava snapshot vazio de 2026-09", vazio.repo.persistedCalls.map((c) => c.competencia), ["2026-09"]);

  console.log(`\ncentralVendasJanelaDataLiteral.test.js: ${checks} verificações passaram.`);
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
