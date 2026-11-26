// server/tests/planilhaPrecificacaoSemBaseContaScoped.test.js
//
// Regressão do bug real de produção: o search preservava a conta selecionada,
// mas o batch `/items?ids=...` perdia o mlUserId e caía no grant principal.
// Este teste percorre o pipeline real até o XLSX, incluindo sale_price,
// fallback /prices, listing_prices e shipping_options/free.
//
// Não usa DI: mlTokenService/clienteContaService/contextoPrecificacaoService/
// mlClient usam o `pool`/`fetch` globais — mesmo padrão de mock das outras
// suítes (automacoesContaScoped.test.js, mlFetchAccountScoped.test.js).

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const XLSX = require("xlsx");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const pool = require("../config/database");

const FAR_FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000);

const CLIENTE = { id: 90, nome: "Cliente X", slug: "cliente-x", ativo: true };

// Conta 1 é a principal — exatamente o cenário do bug real: se o mlUserId
// não for propagado, a Conta 2 cairia silenciosamente para este token.
const CONTA_1 = { id: 101, cliente_id: 90, marketplace: "meli", nome: "ML Conta 1", slug: "cliente-x-meli-1", external_account_id: "111", is_primary: true, ativo: true, metadata_json: {}, created_at: new Date(), updated_at: new Date() };
const CONTA_2 = { id: 102, cliente_id: 90, marketplace: "meli", nome: "ML Conta 2", slug: "cliente-x-meli-2", external_account_id: "222", is_primary: false, ativo: true, metadata_json: {}, created_at: new Date(), updated_at: new Date() };

function grant({ id, cliente_conta_id, ml_user_id, is_primary }) {
  return {
    id, cliente_id: 90, cliente_conta_id, ml_user_id,
    access_token: `access-${ml_user_id}`, refresh_token: `refresh-${ml_user_id}`,
    expires_at: FAR_FUTURE, created_at: new Date(), updated_at: new Date(),
    is_primary, token_status: "valid", refresh_failures: 0,
    last_refresh_error_at: null, next_refresh_attempt_at: null,
    _has_is_primary: true, _has_refresh_metadata: true,
  };
}

class MemoryDb {
  constructor() {
    this.contas = [CONTA_1, CONTA_2];
    this.grants = [
      grant({ id: 201, cliente_conta_id: 101, ml_user_id: "111", is_primary: true }),
      grant({ id: 202, cliente_conta_id: 102, ml_user_id: "222", is_primary: false }),
    ];
  }

  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }

  async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT id, cliente_id FROM cliente_contas WHERE marketplace")) {
      return { rows: this.contas.filter((c) => c.marketplace === "meli" && String(c.external_account_id) === String(params[0])) };
    }
    if (q.startsWith("SELECT id, cliente_id, cliente_conta_id, ml_user_id FROM ml_tokens")) {
      return { rows: this.grants.filter((g) => String(g.ml_user_id) === String(params[0])) };
    }

    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q) || q.includes("pg_advisory")) return { rows: [] };

    if (q.startsWith("SELECT id, nome, slug FROM clientes WHERE slug = $1 AND ativo = true")) {
      return { rows: params[0] === CLIENTE.slug ? [CLIENTE] : [] };
    }
    if (q.startsWith("SELECT id, nome, slug, ativo FROM clientes WHERE slug = $1")) {
      return { rows: params[0] === CLIENTE.slug ? [CLIENTE] : [] };
    }
    if (q.startsWith("SELECT id, nome, slug, ativo FROM clientes WHERE id = $1")) {
      return { rows: Number(params[0]) === CLIENTE.id ? [CLIENTE] : [] };
    }

    if (q.startsWith("SELECT * FROM cliente_contas WHERE id = $1")) {
      const c = this.contas.find((x) => x.id === Number(params[0]));
      return { rows: c ? [c] : [] };
    }
    if (q.startsWith("SELECT COUNT(*)::int AS total FROM cliente_contas")) {
      const total = this.contas.filter((c) => c.cliente_id === Number(params[0]) && c.marketplace === (params[1] || "meli") && c.ativo).length;
      return { rows: [{ total }] };
    }

    if (q.includes("FROM ml_tokens t") && q.includes("t.cliente_id = $1 AND t.ml_user_id = $2")) {
      const g = this.grants.find((x) => x.cliente_id === Number(params[0]) && String(x.ml_user_id) === String(params[1]));
      return { rows: g ? [{ ...g }] : [] };
    }
    // Fallback legado (sem mlUserId): usado quando um bug faz o consumidor
    // esquecer de propagar options.mlUserId ao mlFetch — devolve o grant
    // PRINCIPAL do cliente, nunca o da conta pedida. É essa a query que
    // provou o bug real de produção (Conta 2 caindo no token da Conta 1).
    if (q.includes("FROM ml_tokens t") && q.includes("WHERE t.cliente_id = $1") && !q.includes("ml_user_id = $2")) {
      return { rows: this.grants.filter((x) => x.cliente_id === Number(params[0])).map((g) => ({ ...g })) };
    }

    // base_cliente_vinculos: nenhum vínculo cadastrado (rota sem base) —
    // tanto o lookup por conta (obterBaseDaConta) quanto por cliente
    // (buscarBasesMeliDoCliente) devolvem vazio.
    if (q.includes("FROM base_cliente_vinculos v") && q.includes("JOIN bases b ON b.id = v.base_id")) {
      return { rows: [] };
    }

    throw new Error(`Query não mapeada no mock: ${q}`);
  }
}

function resposta(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function sellerDoItem(itemId) {
  return String(itemId).match(/^MLB(111|222)/)?.[1] || null;
}

function criarFetchFake(chamadas) {
  return async (url, options) => {
    const urlStr = String(url);
    const parsed = new URL(urlStr);
    chamadas.push({ url: urlStr, authorization: options.headers.Authorization });

    const searchMatch = parsed.pathname.match(/^\/users\/(111|222)\/items\/search$/);
    if (searchMatch) {
      const seller = searchMatch[1];
      return resposta(200, {
        results: [`MLB${seller}001`, `MLB${seller}002`],
        scroll_id: null,
      });
    }

    // O multiget /items?ids= é feito pelo mlFetch como um GET /items/{id} por item.
    const itemMatch = parsed.pathname.match(/^\/items\/(MLB(?:111|222)\d+)$/);
    if (itemMatch) {
      const id = itemMatch[1];
      const seller = sellerDoItem(id);
      return resposta(200, {
        id,
        title: `Produto ${id}`,
        seller_id: Number(seller),
        seller_custom_field: `SKU-${id}`,
        status: "active",
        listing_type_id: "gold_special",
        category_id: "MLB1234",
        price: id.endsWith("002") ? 80 : 150,
        shipping: { logistic_type: "cross_docking" },
      });
    }

    const salePriceMatch = parsed.pathname.match(/^\/items\/(MLB(?:111|222)\d+)\/sale_price$/);
    if (salePriceMatch) {
      if (salePriceMatch[1].endsWith("002")) {
        return resposta(500, { message: "sale_price indisponível no fixture" });
      }
      return resposta(200, { amount: 120, regular_amount: 150 });
    }

    const pricesMatch = parsed.pathname.match(/^\/items\/(MLB(?:111|222)\d+)\/prices$/);
    if (pricesMatch) {
      return resposta(200, { prices: [{ type: "standard", amount: 80 }] });
    }

    if (parsed.pathname === "/sites/MLB/listing_prices") {
      return resposta(200, {
        sale_fee_amount: 12,
        sale_fee_details: { percentage_fee: 10 },
      });
    }

    if (/^\/users\/(111|222)\/shipping_options\/free$/.test(parsed.pathname)) {
      return resposta(200, { coverage: { all_country: { list_cost: 18 } } });
    }

    throw new Error(`URL ML não mapeada no fake: ${urlStr}`);
  };
}

function validarPipelineConta({ label, resultado, chamadas, seller, bearer }) {
  const buscar = (trecho) => chamadas.filter((c) => c.url.includes(trecho));

  const search = buscar(`/users/${seller}/items/search`);
  ok(`${label} — search usa ${bearer}`, search.length === 1 && search[0].authorization === bearer);

  // Uma leitura GET /items/{id} por anúncio (o multiget foi trocado no mlFetch).
  const batch = chamadas.filter((c) => /^\/items\/MLB\d+$/.test(new URL(c.url).pathname));
  ok(`${label} — leitura dos itens usa ${bearer}`, batch.length === 2 && batch.every((c) => c.authorization === bearer));

  const salePrice = buscar("/sale_price");
  ok(`${label} — sale_price usa ${bearer}`, salePrice.length === 2 && salePrice.every((c) => c.authorization === bearer));

  const prices = chamadas.filter((c) => /\/items\/[^/]+\/prices(?:\?|$)/.test(c.url));
  ok(`${label} — fallback /prices usa ${bearer}`, prices.length === 1 && prices[0].authorization === bearer);

  const listingPrices = buscar("/sites/MLB/listing_prices");
  ok(`${label} — listing_prices usa ${bearer}`, listingPrices.length === 2 && listingPrices.every((c) => c.authorization === bearer));

  const shipping = buscar(`/users/${seller}/shipping_options/free`);
  ok(`${label} — shipping_options/free usa ${bearer}`, shipping.length === 2 && shipping.every((c) => c.authorization === bearer));

  ok(`${label} — todas as chamadas autenticadas usam somente ${bearer}`, chamadas.length > 0 && chamadas.every((c) => c.authorization === bearer));

  const workbook = XLSX.read(resultado.buffer, { type: "buffer" });
  const sheet = workbook.Sheets["Matriz Mercado Livre"];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  ok(`${label} — workbook contém os dois IDs`, rows.some((row) => row[0] === `MLB${seller}001`) && rows.some((row) => row[0] === `MLB${seller}002`));
  ok(`${label} — workbook contém os títulos do fake`, rows.some((row) => row[4] === `Produto MLB${seller}001`) && rows.some((row) => row[4] === `Produto MLB${seller}002`));
}

async function run() {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const originalFetch = global.fetch;
  const db = new MemoryDb();
  pool.query = (sql, params) => db.query(sql, params);
  pool.connect = () => db.connect();

  const chamadasFetch = [];
  global.fetch = criarFetchFake(chamadasFetch);

  try {
    delete require.cache[require.resolve("../services/mlTokenService")];
    delete require.cache[require.resolve("../services/clienteContas/clienteContaService")];
    delete require.cache[require.resolve("../services/automacoes/contextoPrecificacaoService")];
    delete require.cache[require.resolve("../utils/mlClient")];
    delete require.cache[require.resolve("../services/automacoes/planilhaPrecificacaoSemBaseService")];
    const { gerarPlanilhaPrecificacaoSemBase } = require("../services/automacoes/planilhaPrecificacaoSemBaseService");

    // ── Conta 2 (não principal): nunca pode cair no token da Conta 1 ─────
    chamadasFetch.length = 0;
    const resultadoConta2 = await gerarPlanilhaPrecificacaoSemBase({ clienteSlugRaw: "cliente-x", clienteContaId: 102 });
    validarPipelineConta({
      label: "Conta 2",
      resultado: resultadoConta2,
      chamadas: chamadasFetch,
      seller: "222",
      bearer: "Bearer access-222",
    });
    ok("Conta 2 — nenhuma chamada usou o grant principal A", !chamadasFetch.some((c) => c.authorization === "Bearer access-111"));

    // ── Conta 1 (principal): comportamento existente continua funcionando ─
    chamadasFetch.length = 0;
    const resultadoConta1 = await gerarPlanilhaPrecificacaoSemBase({ clienteSlugRaw: "cliente-x", clienteContaId: 101 });
    validarPipelineConta({
      label: "Conta 1",
      resultado: resultadoConta1,
      chamadas: chamadasFetch,
      seller: "111",
      bearer: "Bearer access-111",
    });

    console.log(`\n✓ planilhaPrecificacaoSemBaseContaScoped: ${checks} verificações`);
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    global.fetch = originalFetch;
    delete require.cache[require.resolve("../services/mlTokenService")];
    delete require.cache[require.resolve("../services/clienteContas/clienteContaService")];
    delete require.cache[require.resolve("../services/automacoes/contextoPrecificacaoService")];
    delete require.cache[require.resolve("../utils/mlClient")];
    delete require.cache[require.resolve("../services/automacoes/planilhaPrecificacaoSemBaseService")];
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
