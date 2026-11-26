// server/tests/promocoesRetornoContaScoped.test.js
//
// Mesma classe de bug do modeloBaseCustos/planilhaPrecificacaoSemBase/
// precificacaoService: gerarPreviewPromocoesRetorno monta o path do ML com
// o mlUserId da conta selecionada (`/users/${mlUserId}/items/search`) mas
// chamava `mlFetch` sem `{ mlUserId }` — a escolha do TOKEN caía no
// fallback/principal do cliente. Cliente com 2 contas ML e a Conta 1 como
// principal: pedir a Conta 2 usaria o seller 222 no path só que autenticado
// com o token da Conta 1 (111), e o ML responde 403 "Searching another user
// items is restricted."
//
// Não usa DI: mlTokenService/clienteContaService/contextoPrecificacaoService/
// mlClient usam o `pool`/`fetch` globais — mesmo padrão de mock das outras
// suítes (automacoesContaScoped.test.js, mlFetchAccountScoped.test.js).

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const pool = require("../config/database");

const FAR_FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000);

const CLIENTE = { id: 90, nome: "Cliente X", slug: "cliente-x", ativo: true };

const CONTA_1 = { id: 101, cliente_id: 90, marketplace: "meli", nome: "ML Conta 1", slug: "cliente-x-meli-1", external_account_id: "111", is_primary: true, ativo: true, metadata_json: {}, created_at: new Date(), updated_at: new Date() };
const CONTA_2 = { id: 102, cliente_id: 90, marketplace: "meli", nome: "ML Conta 2", slug: "cliente-x-meli-2", external_account_id: "222", is_primary: false, ativo: true, metadata_json: {}, created_at: new Date(), updated_at: new Date() };

const BASE = { id: 501, slug: "base-1", nome: "Base 1", ativo: true, created_at: new Date(), updated_at: new Date() };
const VINCULO = { id: 601, cliente_id: 90, cliente_conta_id: 101, base_id: 501, marketplace: "meli", ativo: true, updated_at: new Date() };

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
    if (q.includes("FROM ml_tokens t") && q.includes("WHERE t.cliente_id = $1") && !q.includes("ml_user_id = $2")) {
      return { rows: this.grants.filter((x) => x.cliente_id === Number(params[0])).map((g) => ({ ...g })) };
    }

    if (q.includes("FROM base_cliente_vinculos v") && q.includes("v.cliente_conta_id = $1")) {
      return { rows: [] };
    }
    if (q.includes("FROM base_cliente_vinculos v") && q.includes("JOIN bases b ON b.id = v.base_id")) {
      if (Number(params[0]) !== CLIENTE.id) return { rows: [] };
      return {
        rows: [{
          id: BASE.id, vinculo_id: VINCULO.id, base_id: BASE.id,
          cliente_id: VINCULO.cliente_id, cliente_conta_id: VINCULO.cliente_conta_id,
          marketplace: "meli", vinculo_marketplace: "meli", vinculo_ativo: true,
          slug: BASE.slug, nome: BASE.nome, ativo: BASE.ativo,
          created_at: BASE.created_at, updated_at: BASE.updated_at,
        }, { ...BASE, id: 502, slug: "base-2", cliente_id: 90, cliente_conta_id: 102, marketplace: "meli", vinculo_marketplace: "meli", vinculo_ativo: true }],
      };
    }

    if (q.startsWith("SELECT produto_id, custo_produto, imposto_percentual, taxa_fixa FROM custos WHERE base_id = $1")) {
      return { rows: [] };
    }

    // relatorio_itens/relatorios: fica de fora do escopo desta correção —
    // carregarContextoFinanceiro já engole erro de query aqui (try/catch).
    if (q.includes("FROM relatorio_itens ri")) {
      throw new Error("relatorio_itens não mockado neste teste (fora de escopo)");
    }

    throw new Error(`Query não mapeada no mock: ${q}`);
  }
}

async function run() {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  console.warn = () => {}; // silencia o warning esperado de relatorio_itens não mockado
  const db = new MemoryDb();
  pool.query = (sql, params) => db.query(sql, params);
  pool.connect = () => db.connect();

  const chamadasFetch = [];
  // A conta 2 tem 1 anúncio ativo: o preview lê o detalhe (multiget) e as
  // promoções DO ITEM — todas essas leituras precisam do token da conta 2.
  global.fetch = async (url, options) => {
    const u = String(url);
    chamadasFetch.push({ url: u, authorization: options.headers.Authorization });
    let corpo = { results: [], paging: { total: 0 } };
    if (u.includes("/users/222/items/search")) corpo = { results: ["MLB2220001"], paging: { total: 1 } };
    // O multiget /items?ids= é feito pelo mlFetch como um GET /items/{id} por item.
    else if (/mercadolibre\.com\/items\/MLB2220001(\?|$)/.test(u)) corpo = { id: "MLB2220001", seller_id: 222, title: "Item conta 2" };
    else if (u.includes("/seller-promotions/items/")) corpo = [];
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => corpo,
    };
  };

  try {
    delete require.cache[require.resolve("../services/mlTokenService")];
    delete require.cache[require.resolve("../services/clienteContas/clienteContaService")];
    delete require.cache[require.resolve("../services/automacoes/contextoPrecificacaoService")];
    delete require.cache[require.resolve("../utils/mlClient")];
    delete require.cache[require.resolve("../services/automacoes/promocoesRetornoService")];
    const { gerarPreviewPromocoesRetorno } = require("../services/automacoes/promocoesRetornoService");

    // ── Conta 2 (não principal): nunca pode cair no token da Conta 1 ─────
    chamadasFetch.length = 0;
    await gerarPreviewPromocoesRetorno({ clienteSlugRaw: "cliente-x", clienteContaId: 102 });
    const buscaConta2 = chamadasFetch.find((c) => c.url.includes("/users/222/items/search"));
    ok("Conta 2 — path usa o seller 222", Boolean(buscaConta2));
    ok("Conta 2 — usa o access_token de 222 (não o principal 111)", buscaConta2.authorization === "Bearer access-222");
    ok("Conta 2 — nenhuma chamada usou o token principal (access-111)", !chamadasFetch.some((c) => c.authorization === "Bearer access-111"));
    const multiget = chamadasFetch.find((c) => /mercadolibre\.com\/items\/MLB2220001(\?|$)/.test(c.url));
    ok("Conta 2 — detalhe do item (multiget) com o token de 222", multiget && multiget.authorization === "Bearer access-222");
    const promosItem = chamadasFetch.find((c) => c.url.includes("/seller-promotions/items/MLB2220001"));
    ok("Conta 2 — promoções DO ITEM lidas com o token de 222 (antes caíam no principal)", promosItem && promosItem.authorization === "Bearer access-222");

    // ── Conta 1 (principal): comportamento existente continua funcionando ─
    chamadasFetch.length = 0;
    await gerarPreviewPromocoesRetorno({ clienteSlugRaw: "cliente-x", clienteContaId: 101 });
    const buscaConta1 = chamadasFetch.find((c) => c.url.includes("/users/111/items/search"));
    ok("Conta 1 — path usa o seller 111", Boolean(buscaConta1));
    ok("Conta 1 — usa o access_token de 111", buscaConta1.authorization === "Bearer access-111");

    // ── Regressão conceitual: seller do path === mlUserId usado p/ o token ─
    for (const { conta, resp } of [{ conta: 102, resp: buscaConta2 }, { conta: 101, resp: buscaConta1 }]) {
      const sellerNoPath = resp.url.match(/\/users\/([^/]+)\/items\/search/)?.[1];
      const grantDoSeller = db.grants.find((g) => g.ml_user_id === sellerNoPath);
      ok(
        `conta ${conta} — seller do path (${sellerNoPath}) e token usado (${resp.authorization}) pertencem ao mesmo grant`,
        grantDoSeller && resp.authorization === `Bearer ${grantDoSeller.access_token}`
      );
    }

    console.log(`\n✓ promocoesRetornoContaScoped: ${checks} verificações`);
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    global.fetch = originalFetch;
    console.warn = originalWarn;
    delete require.cache[require.resolve("../services/mlTokenService")];
    delete require.cache[require.resolve("../services/clienteContas/clienteContaService")];
    delete require.cache[require.resolve("../services/automacoes/contextoPrecificacaoService")];
    delete require.cache[require.resolve("../utils/mlClient")];
    delete require.cache[require.resolve("../services/automacoes/promocoesRetornoService")];
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
