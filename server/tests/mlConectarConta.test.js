// server/tests/mlConectarConta.test.js
//
// Acabamento operacional da gestão de contas ML em /clientes.html:
// link OAuth account-scoped (GET /ml/conectar-conta/:clienteContaId) e a
// proteção de reconexão segura no callback (mlController.callbackMlController).
//
// Cobre a lista de testes obrigatórios pedida:
//  1/2. criar cliente_conta ML sem grant -> "aguardando grant" (grant=null
//       distinto de grant existente) já é verificado em clienteContaService.test.js
//       (criarConta) — aqui o foco é o fluxo OAuth account-scoped em si.
//  3/4. link de ML1 e ML2 apontam para clienteContaId diferentes.
//  5. primeira autorização de uma conta sem external_account_id grava o
//     seller retornado e liga o grant a ela.
//  6/7/8. reconectar com o seller certo funciona; reconectar com o seller
//     errado bloqueia com ML_ACCOUNT_MISMATCH e não salva/move nenhum token.
//  9. ML1 e ML2 continuam independentes (mismatch de ML1 não mexe em ML2).
//  15. nenhum access_token/refresh_token aparece na URL/redirect.
//
// Mesmo padrão de mock das demais suítes: `pool` é monkeypatchado com um
// banco em memória; `global.fetch` é mockado para a troca code -> token do
// Mercado Livre. Sem PostgreSQL real.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";
process.env.ML_CLIENT_ID = process.env.ML_CLIENT_ID || "test-ml-client-id";
process.env.ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || "test-ml-client-secret";
process.env.JWT_SECRET = process.env.JWT_SECRET || "venforce_secret_local";

const assert = require("assert");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const pool = require("../config/database");

class MemoryDb {
  constructor() {
    this.clientes = [{ id: 1, nome: "Loja Eletrônico", slug: "loja-eletronico", ativo: true }];
    this.contas = [
      { id: 10, cliente_id: 1, marketplace: "meli", nome: "Mercado Livre 1", slug: "loja-eletronico-meli-1", external_account_id: null, is_primary: true, ativo: true, metadata_json: {} },
      { id: 11, cliente_id: 1, marketplace: "meli", nome: "Mercado Livre 2", slug: "loja-eletronico-meli-2", external_account_id: null, is_primary: false, ativo: true, metadata_json: {} },
    ];
    this.grants = [];
    this.nextGrantId = 900;
  }

  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }

  async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT id, nome, slug, ativo FROM clientes WHERE id = $1")) return { rows: this.clientes.filter(c => c.id === Number(params[0])) };
    if (q.startsWith("SELECT id, cliente_id FROM cliente_contas WHERE marketplace")) return { rows: this.contas.filter(c => c.marketplace === "meli" && String(c.external_account_id) === String(params[0])) };
    if (q.startsWith("SELECT id, cliente_id, cliente_conta_id, ml_user_id FROM ml_tokens")) return { rows: this.grants.filter(g => String(g.ml_user_id) === String(params[0])) };


    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q) || q.includes("pg_advisory")) return { rows: [] };

    if (q.startsWith("SELECT * FROM clientes WHERE id = $1 AND ativo = true")) {
      return { rows: this.clientes.filter((c) => c.id === Number(params[0]) && c.ativo) };
    }
    if (q.startsWith("SELECT id, slug, nome FROM clientes WHERE slug = $1 AND ativo = true")) {
      return { rows: this.clientes.filter((c) => c.slug === params[0] && c.ativo) };
    }

    if (q.startsWith("SELECT * FROM cliente_contas WHERE id = $1 FOR UPDATE")) {
      const c = this.contas.find((c) => c.id === Number(params[0]));
      return { rows: c ? [{ ...c }] : [] };
    }
    if (q.startsWith("SELECT * FROM cliente_contas WHERE id = $1")) {
      const c = this.contas.find((c) => c.id === Number(params[0]));
      return { rows: c ? [{ ...c }] : [] };
    }
    if (q.startsWith("UPDATE cliente_contas SET external_account_id = $1")) {
      const c = this.contas.find((c) => c.id === Number(params[1]));
      if (c) c.external_account_id = params[0];
      return { rows: [] };
    }
    if (q.startsWith("UPDATE cliente_contas SET metadata_json =")) {
      const c = this.contas.find((c) => c.id === Number(params[0]));
      if (c) c.metadata_json = { ...(c.metadata_json || {}), nickname: params[1] };
      return { rows: [] };
    }
    if (q.startsWith("UPDATE ml_tokens SET cliente_conta_id = $1 WHERE cliente_id = $2 AND ml_user_id = $3")) {
      this.grants.forEach((g) => {
        if (g.cliente_id === Number(params[1]) && String(g.ml_user_id) === String(params[2])) g.cliente_conta_id = Number(params[0]);
      });
      return { rows: [] };
    }

    // mlTokenService.saveMlToken
    if (q.includes("information_schema.columns") && q.includes("has_is_primary")) {
      return { rows: [{ has_is_primary: true, has_refresh_metadata: true }] };
    }
    if (q.startsWith("SELECT id FROM ml_tokens WHERE cliente_id = $1 AND is_primary = true")) {
      const g = this.grants.find((g) => g.cliente_id === Number(params[0]) && g.is_primary);
      return { rows: g ? [{ id: g.id }] : [] };
    }
    if (q.startsWith("SELECT id FROM ml_tokens WHERE cliente_id = $1 AND ml_user_id = $2")) {
      const g = this.grants.find((g) => g.cliente_id === Number(params[0]) && String(g.ml_user_id) === String(params[1]));
      return { rows: g ? [{ id: g.id }] : [] };
    }
    // mlTokenService.resolveMlGrant({ clienteId, mlUserId }) — usado por
    // mlFetch(clienteId, path, { mlUserId }) na captura de nickname.
    if (q.includes("FROM ml_tokens t") && q.includes("t.cliente_id = $1 AND t.ml_user_id = $2")) {
      const g = this.grants.find((g) => g.cliente_id === Number(params[0]) && String(g.ml_user_id) === String(params[1]));
      return { rows: g ? [{ ...g, refresh_failures: 0 }] : [] };
    }
    if (q.startsWith("INSERT INTO ml_tokens") && q.includes("ON CONFLICT (cliente_id, ml_user_id) DO UPDATE")) {
      const clienteId = Number(params[0]);
      const mlUserId = String(params[1]);
      let g = this.grants.find((g) => g.cliente_id === clienteId && String(g.ml_user_id) === mlUserId);
      if (g) {
        g.access_token = params[2];
        g.refresh_token = params[3];
        g.expires_at = params[4];
        g.is_primary = g.is_primary || params[5] === true;
        g.token_status = "valid";
      } else {
        g = {
          id: this.nextGrantId++,
          cliente_id: clienteId,
          ml_user_id: mlUserId,
          access_token: params[2],
          refresh_token: params[3],
          expires_at: params[4],
          is_primary: params[5] === true,
          token_status: "valid",
          cliente_conta_id: null,
        };
        this.grants.push(g);
      }
      return { rows: [{ ...g }] };
    }

    if (q.startsWith("INSERT INTO activity_logs")) return { rows: [] };

    throw new Error(`Query não mapeada no mock: ${q}`);
  }
}

function fakeReq(query) {
  return { query, headers: {}, socket: {} };
}

function fakeRes() {
  const res = { statusCode: null, body: null, redirectUrl: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (body) => { res.body = body; if (res.statusCode === null) res.statusCode = 200; return res; };
  res.json = (body) => { res.body = body; if (res.statusCode === null) res.statusCode = 200; return res; };
  res.redirect = (url) => { res.redirectUrl = url; res.statusCode = 302; return res; };
  return res;
}

function mockMlTokenExchange(mlUserIdBySellerCall) {
  // Simula a resposta de POST https://api.mercadolibre.com/oauth/token —
  // devolve sempre o mesmo user_id configurado para este "code" de teste.
  // Também responde /users/me (chamada única pós-conexão para capturar o
  // nickname/externalAccountLabel — V3 Master Spec §14.3).
  return async (url, options) => {
    if (String(url).includes("oauth/token")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: `APP_USR-access-${mlUserIdBySellerCall}`,
          refresh_token: `TG-refresh-${mlUserIdBySellerCall}`,
          user_id: mlUserIdBySellerCall,
          expires_in: 21600,
        }),
      };
    }
    if (String(url).includes("/users/me")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: Number(mlUserIdBySellerCall), nickname: `SELLER_${mlUserIdBySellerCall}` }),
      };
    }
    throw new Error(`fetch não mapeado no mock: ${url}`);
  };
}

async function run() {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const originalFetch = global.fetch;

  const db = new MemoryDb();
  pool.query = (sql, params) => db.query(sql, params);
  pool.connect = () => db.connect();

  try {
    delete require.cache[require.resolve("../services/mlApiService")];
    delete require.cache[require.resolve("../services/mlTokenService")];
    delete require.cache[require.resolve("../services/clienteContas/clienteContaService")];
    delete require.cache[require.resolve("../controllers/mlController")];
    delete require.cache[require.resolve("../routes/mlRoutes")];

    const mlRoutes = require("../routes/mlRoutes");
    const { iniciarConexaoContaMlController, callbackMlController } = require("../controllers/mlController");
    const { gerarMlState } = require("../services/mlApiService");

    // ── Rota registrada ────────────────────────────────────────────────
    const camada = mlRoutes.stack.find((c) => c.route && c.route.path === "/ml/conectar-conta/:clienteContaId");
    ok("GET /ml/conectar-conta/:clienteContaId está registrada", !!camada && !!camada.route.methods.get);
    ok("rota account-scoped não exige authMiddleware/requireAdmin (link compartilhável, igual ao legado)",
      camada.route.stack.length === 1 && camada.route.stack[0].handle === iniciarConexaoContaMlController);

    const legado = mlRoutes.stack.find((c) => c.route && c.route.path === "/ml/conectar/:clienteSlug");
    ok("rota legada /ml/conectar/:clienteSlug continua registrada (compatibilidade)", !!legado);

    // ── 3/4. Links de ML1 e ML2 identificam contas diferentes ──────────
    const resML1 = fakeRes();
    await iniciarConexaoContaMlController({ params: { clienteContaId: "10" } }, resML1);
    ok("Conectar ML1 redireciona para o authorize do Mercado Livre", resML1.statusCode === 302 && String(resML1.redirectUrl).includes("auth.mercadolivre.com.br/authorization"));
    ok("Nenhum access_token/refresh_token aparece na URL de autorização", !/access_token|refresh_token/i.test(resML1.redirectUrl));

    const resML2 = fakeRes();
    await iniciarConexaoContaMlController({ params: { clienteContaId: "11" } }, resML2);
    ok("Conectar ML2 também redireciona", resML2.statusCode === 302);

    const stateML1 = new URL(resML1.redirectUrl).searchParams.get("state");
    const stateML2 = new URL(resML2.redirectUrl).searchParams.get("state");
    ok("state de ML1 é diferente do state de ML2 (contas diferentes)", stateML1 !== stateML2);

    // conta inativa/inexistente nunca gera link
    const resInexistente = fakeRes();
    await iniciarConexaoContaMlController({ params: { clienteContaId: "999" } }, resInexistente);
    ok("clienteContaId inexistente não redireciona (404)", resInexistente.statusCode === 404);

    // ── 5. Primeira autorização de ML2: seller vira external_account_id ──
    global.fetch = mockMlTokenExchange("222");
    const resCallbackML2 = fakeRes();
    await callbackMlController(fakeReq({ code: "abc", state: stateML2 }), resCallbackML2);
    ok("primeira conexão de ML2 responde sucesso (200)", resCallbackML2.statusCode === 200 || resCallbackML2.statusCode === null);
    const ml2Depois = db.contas.find((c) => c.id === 11);
    ok("ML2.external_account_id gravado com o seller retornado", ml2Depois.external_account_id === "222");
    const grantML2 = db.grants.find((g) => g.ml_user_id === "222");
    ok("grant do seller 222 existe e está ligado à cliente_conta_id de ML2", !!grantML2 && grantML2.cliente_conta_id === 11);
    ok("externalAccountLabel (nickname) capturado no OAuth, sem chamada extra da Carteira",
      ml2Depois.metadata_json?.nickname === "SELLER_222");

    // ── 1ª conexão de ML1 (seller 111) para preparar os próximos testes ──
    global.fetch = mockMlTokenExchange("111");
    const resCallbackML1 = fakeRes();
    await callbackMlController(fakeReq({ code: "abc", state: stateML1 }), resCallbackML1);
    const ml1Depois = db.contas.find((c) => c.id === 10);
    ok("ML1.external_account_id gravado com o seller 111", ml1Depois.external_account_id === "111");
    const grantML1Antes = { ...db.grants.find((g) => g.ml_user_id === "111") };
    ok("grant do seller 111 ligado a ML1", grantML1Antes.cliente_conta_id === 10);

    // ── 6. Reconectar ML1 com o seller correto (111) funciona ───────────
    const resML1Reconectar = fakeRes();
    await iniciarConexaoContaMlController({ params: { clienteContaId: "10" } }, resML1Reconectar);
    const stateML1Reconectar = new URL(resML1Reconectar.redirectUrl).searchParams.get("state");
    global.fetch = mockMlTokenExchange("111");
    const resReconectarOk = fakeRes();
    await callbackMlController(fakeReq({ code: "xyz", state: stateML1Reconectar }), resReconectarOk);
    ok("reconectar ML1 com o seller certo (111) tem sucesso", resReconectarOk.statusCode === 200 || resReconectarOk.statusCode === null);
    ok("token de ML1 foi atualizado (novo access_token)", db.grants.find((g) => g.ml_user_id === "111").access_token === "APP_USR-access-111");

    // ── 7/8/9. Reconectar ML1 autorizando o seller de ML2 → bloqueia ────
    const resML1ReconectarErrado = fakeRes();
    await iniciarConexaoContaMlController({ params: { clienteContaId: "10" } }, resML1ReconectarErrado);
    const stateML1Errado = new URL(resML1ReconectarErrado.redirectUrl).searchParams.get("state");

    const grantML1AntesDoMismatch = { ...db.grants.find((g) => g.ml_user_id === "111") };
    const grantML2AntesDoMismatch = { ...db.grants.find((g) => g.ml_user_id === "222") };

    global.fetch = mockMlTokenExchange("222"); // ML aprova, mas devolve o seller de ML2
    const resMismatch = fakeRes();
    await callbackMlController(fakeReq({ code: "wrong", state: stateML1Errado }), resMismatch);
    ok("reconectar ML1 autorizando o seller de ML2 é bloqueado com HTTP 409", resMismatch.statusCode === 409);
    ok("mensagem do erro cita os dois sellers (111 esperado, 222 recebido)", /111/.test(resMismatch.body) && /222/.test(resMismatch.body));

    const grantML1DepoisDoMismatch = db.grants.find((g) => g.ml_user_id === "111");
    const grantML2DepoisDoMismatch = db.grants.find((g) => g.ml_user_id === "222");
    ok("mismatch NÃO modifica o token de ML1", grantML1DepoisDoMismatch.access_token === grantML1AntesDoMismatch.access_token);
    ok("mismatch NÃO modifica o token de ML2", grantML2DepoisDoMismatch.access_token === grantML2AntesDoMismatch.access_token);
    ok("mismatch NÃO move o grant do seller 222 para a cliente_conta de ML1", grantML2DepoisDoMismatch.cliente_conta_id === 11);
    ok("ML1 continua apontando só para o seu próprio grant (111)", db.contas.find((c) => c.id === 10).external_account_id === "111");
    ok("nenhum grant novo foi criado pelo mismatch", db.grants.filter((g) => g.ml_user_id === "111" || g.ml_user_id === "222").length === 2);

    console.log(`\n✓ mlConectarConta: ${checks} verificações`);
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    global.fetch = originalFetch;
    delete require.cache[require.resolve("../services/mlApiService")];
    delete require.cache[require.resolve("../services/mlTokenService")];
    delete require.cache[require.resolve("../services/clienteContas/clienteContaService")];
    delete require.cache[require.resolve("../controllers/mlController")];
    delete require.cache[require.resolve("../routes/mlRoutes")];
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
