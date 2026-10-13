// server/tests/adsMetricasAccountContext.test.js
//
// Prova que os dois consumidores legados P0 (mlAdsService / metricasService)
// pararam de escolher "a conta principal" em silêncio e passaram a resolver
// a conta ML exata via resolveMarketplaceAccountContext (Cliente/Conta/Grant),
// igual ao padrão já validado na Central de Vendas
// (ver centralVendasAccountContext.test.js).
//
// mlAdsService/metricasService usam o `pool` singleton diretamente (não têm
// injeção de `queryable`), então aqui trocamos temporariamente pool.query
// por um banco em memória — mesmo padrão de clienteContaService.test.js.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const Module = require("module");

// mlFetch é destruturado no require-time por mlAdsService e metricasService —
// precisa ser interceptado ANTES desses módulos serem exigidos.
const originalLoad = Module._load;
let mlFetchCalls = [];
let ORDERS_BY_SELLER = {};
Module._load = function loadWithMlFetchStub(request, parent, isMain) {
  if (request === "../../utils/mlClient" || request === "../utils/mlClient") {
    return {
      async mlFetch(clienteId, path, options = {}) {
        mlFetchCalls.push({ clienteId, path, mlUserId: options.mlUserId });
        if (path.startsWith("/orders/search")) {
          const orders = ORDERS_BY_SELLER[String(options.mlUserId)] || [];
          return { ok: true, status: 200, data: { results: orders, paging: { total: orders.length } } };
        }
        if (path.startsWith("/advertising/advertisers")) {
          return { ok: true, status: 200, data: { advertisers: [{ advertiser_id: "adv-" + options.mlUserId, site_id: "MLB", advertiser_name: "Adv" }] } };
        }
        if (path.includes("/product_ads/campaigns/search")) {
          return { ok: true, status: 200, data: { results: [], paging: { total: 0 } } };
        }
        if (path.includes("/product_ads/ads/search")) {
          return { ok: true, status: 200, data: { results: [], paging: { total: 0 } } };
        }
        return { ok: true, status: 200, data: {} };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const pool = require("../config/database");
const { buscarPerformanceML } = require("../services/ads/mlAdsService");
const { buscarResumo } = require("../services/metricasService");
const cliente360SyncService = require("../services/cliente360/cliente360SyncService");

Module._load = originalLoad;

// ── fixtures ────────────────────────────────────────────────────────────────

const cliente = { id: 1, nome: "Cliente A", slug: "cliente-a", ativo: true };

function grantFixture({ id, cliente_id, ml_user_id, token_status = "valid" }) {
  return {
    id, cliente_id, ml_user_id,
    access_token: "tok", refresh_token: "ref",
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    token_status, is_primary: false,
    refresh_failures: 0, updated_at: new Date().toISOString(),
  };
}

function pedidoFixture(id, mlb, unitPrice = 100) {
  return {
    id,
    date_created: "2026-05-10T10:00:00.000-03:00",
    status: "paid",
    tags: [],
    order_items: [{ item: { id: mlb, seller_sku: null, title: "Produto" }, quantity: 1, unit_price: unitPrice, sale_fee: 10 }],
    payments: [],
  };
}

class MockDb {
  constructor({ contas = [], grants = [] } = {}) {
    this.contas = contas;
    this.grants = grants;
  }

  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }

  async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT id, cliente_id FROM cliente_contas WHERE marketplace")) return { rows: this.contas.filter(c => c.marketplace === "meli" && String(c.external_account_id) === String(params[0])) };
    if (q.startsWith("SELECT id, cliente_id, cliente_conta_id, ml_user_id FROM ml_tokens")) return { rows: this.grants.filter(g => String(g.ml_user_id) === String(params[0])) };


    if (q.includes("FROM clientes WHERE id = $1")) {
      return { rows: cliente.id === Number(params[0]) ? [cliente] : [] };
    }
    if (q.includes("FROM clientes WHERE slug = $1") || q.includes("FROM clientes c WHERE c.slug = $1")) {
      return { rows: cliente.slug === params[0] ? [cliente] : [] };
    }
    if (q.startsWith("SELECT * FROM cliente_contas WHERE id = $1")) {
      const conta = this.contas.find((c) => c.id === Number(params[0]));
      return { rows: conta ? [conta] : [] };
    }
    if (q.includes("FROM cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true ORDER BY is_primary")) {
      return { rows: this.contas.filter((c) => c.cliente_id === params[0] && c.marketplace === params[1] && c.ativo !== false) };
    }
    if (q.includes("COUNT(*)::int AS total FROM cliente_contas")) {
      const total = this.contas.filter((c) => c.cliente_id === params[0] && c.marketplace === params[1] && c.ativo !== false).length;
      return { rows: [{ total }] };
    }
    if (q.includes("t.cliente_id = $1 AND t.ml_user_id = $2")) {
      const row = this.grants.find((g) => g.cliente_id === params[0] && String(g.ml_user_id) === String(params[1]));
      return { rows: row ? [row] : [] };
    }
    if (q.includes("FROM ml_tokens t") && q.includes("WHERE t.cliente_id = $1")) {
      return { rows: this.grants.filter((g) => g.cliente_id === params[0]) };
    }
    // Vínculo de base (context.base) — não usado por Ads/Métricas, default vazio.
    if (q.includes("base_cliente_vinculos")) {
      return { rows: [] };
    }
    return { rows: [] };
  }
}

function withMockDb(dbOpts, fn) {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const db = new MockDb(dbOpts);
  pool.query = (sql, params) => db.query(sql, params);
  pool.connect = () => db.connect();
  return Promise.resolve()
    .then(() => fn(db))
    .finally(() => {
      pool.query = originalQuery;
      pool.connect = originalConnect;
    });
}

async function assertThrows(promise, matcher) {
  let errou = false;
  try {
    await promise;
  } catch (err) {
    errou = true;
    matcher(err);
  }
  assert.ok(errou, "esperava erro, mas a operação teve sucesso");
}

async function run() {
  // 1. Uma conta ML ativa (única) — mlAdsService e metricasService resolvem
  //    automaticamente e usam o mlUserId certo em toda chamada ao ML.
  await withMockDb(
    {
      contas: [{ id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", external_account_id: "111", is_primary: true, ativo: true }],
      grants: [grantFixture({ id: 100, cliente_id: 1, ml_user_id: "111" })],
    },
    async () => {
      mlFetchCalls = [];
      const perf = await buscarPerformanceML("cliente-a", "2026-05");
      assert.strictEqual(perf.codigo, "OK");
      assert.ok(mlFetchCalls.every((c) => c.mlUserId === "111"), "toda chamada de Ads deve usar o mlUserId da única conta");

      mlFetchCalls = [];
      ORDERS_BY_SELLER = { "111": [pedidoFixture("9001", "MLB111", 100)] };
      const met = await buscarResumo({ clienteSlug: "cliente-a", dateFrom: "2026-05-01", dateTo: "2026-05-31" });
      assert.ok(!met.multiplasContas);
      assert.strictEqual(met.resumo.quantidadeVendas, 1);
      assert.ok(mlFetchCalls.every((c) => c.mlUserId === "111"), "toda chamada de Métricas deve usar o mlUserId da única conta");
      console.log("  ✓ 1 conta ML ativa: Ads e Métricas resolvem automaticamente com o mlUserId certo");
    }
  );

  // 2. Duas contas ML sem clienteContaId — nunca escolhe sozinho.
  await withMockDb(
    {
      contas: [
        { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", external_account_id: "111", is_primary: true, ativo: true },
        { id: 11, cliente_id: 1, marketplace: "meli", nome: "ML 2", external_account_id: "222", is_primary: false, ativo: true },
      ],
      grants: [
        grantFixture({ id: 100, cliente_id: 1, ml_user_id: "111" }),
        grantFixture({ id: 101, cliente_id: 1, ml_user_id: "222" }),
      ],
    },
    async () => {
      mlFetchCalls = [];
      await assertThrows(buscarPerformanceML("cliente-a", "2026-05"), (err) => {
        assert.strictEqual(err.statusCode, 409);
        assert.strictEqual(err.code, "MULTIPLE_MARKETPLACE_ACCOUNTS");
        assert.strictEqual(err.contas.length, 2);
      });
      assert.strictEqual(mlFetchCalls.length, 0, "Ads não deve chamar a API ML sem saber de qual conta");

      mlFetchCalls = [];
      const met = await buscarResumo({ clienteSlug: "cliente-a", dateFrom: "2026-05-01", dateTo: "2026-05-31" });
      assert.strictEqual(met.multiplasContas, true, "Métricas deve RETORNAR ambiguidade, não lançar");
      assert.strictEqual(met.contas.length, 2);
      assert.strictEqual(mlFetchCalls.length, 0, "Métricas não deve chamar a Orders API sem saber de qual conta");
      console.log("  ✓ 2 contas ML sem clienteContaId: Ads lança 409, Métricas retorna multiplasContas, nenhuma API chamada");
    }
  );

  // 3. clienteContaId explícito isola a conta — nunca mistura mlUserId.
  await withMockDb(
    {
      contas: [
        { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", external_account_id: "111", is_primary: true, ativo: true },
        { id: 11, cliente_id: 1, marketplace: "meli", nome: "ML 2", external_account_id: "222", is_primary: false, ativo: true },
      ],
      grants: [
        grantFixture({ id: 100, cliente_id: 1, ml_user_id: "111" }),
        grantFixture({ id: 101, cliente_id: 1, ml_user_id: "222" }),
      ],
    },
    async () => {
      mlFetchCalls = [];
      await buscarPerformanceML("cliente-a", "2026-05", null, 10);
      assert.ok(mlFetchCalls.every((c) => c.mlUserId === "111"), "clienteContaId=10 deve usar apenas mlUserId=111");

      mlFetchCalls = [];
      await buscarPerformanceML("cliente-a", "2026-05", null, 11);
      assert.ok(mlFetchCalls.every((c) => c.mlUserId === "222"), "clienteContaId=11 deve usar apenas mlUserId=222, nunca 111");

      mlFetchCalls = [];
      ORDERS_BY_SELLER = { "111": [pedidoFixture("9001", "MLB111")], "222": [pedidoFixture("9002", "MLB222")] };
      await buscarResumo({ clienteSlug: "cliente-a", clienteContaId: 10, dateFrom: "2026-05-01", dateTo: "2026-05-31" });
      assert.ok(mlFetchCalls.every((c) => c.mlUserId === "111"));

      mlFetchCalls = [];
      await buscarResumo({ clienteSlug: "cliente-a", clienteContaId: 11, dateFrom: "2026-05-01", dateTo: "2026-05-31" });
      assert.ok(mlFetchCalls.every((c) => c.mlUserId === "222"), "conta 11 nunca deve usar o mlUserId da conta 10");
      console.log("  ✓ clienteContaId explícito isola a conta em Ads e Métricas, sem mistura entre contas");
    }
  );

  // 4. Safety net do Cliente 360: multiplasContas nunca vira snapshot fake.
  {
    const modPath = require.resolve("../services/metricasService");
    const original = require.cache[modPath].exports;
    require.cache[modPath].exports = {
      ...original,
      buscarResumo: async () => ({ multiplasContas: true, contas: [{ id: 10 }, { id: 11 }] }),
    };
    delete require.cache[require.resolve("../services/cliente360/cliente360SyncService")];
    const svc = require("../services/cliente360/cliente360SyncService");
    try {
      const res = await svc.consolidarMetricasMes(1, "2026-05-01", "2026-05-31", "cliente-a");
      assert.deepStrictEqual(res, { ok: false, motivo: "multiplas_contas_sem_selecao", resumo: null, topProdutos: null, porDia: null });
      console.log("  ✓ cliente360SyncService.consolidarMetricasMes nunca grava snapshot fake quando a conta é ambígua");
    } finally {
      require.cache[modPath].exports = original;
      delete require.cache[require.resolve("../services/cliente360/cliente360SyncService")];
    }
  }

  console.log("adsMetricasAccountContext.test.js passed");
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
