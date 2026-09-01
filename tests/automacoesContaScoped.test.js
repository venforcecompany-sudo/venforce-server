// server/tests/automacoesContaScoped.test.js
//
// Correção do bug confirmado: um cliente com 2+ contas Mercado Livre podia
// ter a MESMA conta usada pelas Automações independente de qual conta o
// Shell V3 tinha selecionado, porque contextoPrecificacaoService.js chamava
// resolveMlGrant({ clienteId, requireUsable: true }) sem `mlUserId` —
// escolha silenciosa de grant (principal/fallback).
//
// A correção reusa o resolvedor canônico existente
// (resolveMarketplaceAccountContext, em clienteContaService.js) para que
// clienteContaId → valide pertencimento ao cliente → resolva o ml_user_id
// daquela conta → só então resolveMlGrant({ clienteId, mlUserId,
// requireUsable }). Este teste prova esse fio inteiro com o cenário pedido:
//
//   Cliente wbs_2 (id 90)
//     Conta A — clienteContaId 101, ml_user_id 710361722, is_primary=false
//     Conta B — clienteContaId 102, ml_user_id 234836231, is_primary=true
//
// Não usa DI: mlTokenService/clienteContaService/contextoPrecificacaoService
// usam o `pool` singleton — mesmo padrão de mock das outras suítes
// (clienteContaService.test.js, mlFetchAccountScoped.test.js).

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}
async function rejeitaCom(label, promise, verificar) {
  let erro = null;
  try {
    await promise;
  } catch (e) {
    erro = e;
  }
  assert.ok(erro, `FALHOU (não rejeitou): ${label}`);
  if (verificar) {
    assert.ok(verificar(erro), `FALHOU (erro inesperado): ${label} — statusCode=${erro.statusCode} code=${erro.code} msg=${erro.message}`);
  }
  checks += 1;
  console.log(`  ok  ${label}`);
}

const pool = require("../config/database");

const FAR_FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000);

const CLIENTE_WBS2 = { id: 90, nome: "WBS 2", slug: "wbs-2", ativo: true };
const CLIENTE_OUTRO = { id: 91, nome: "Outro Cliente", slug: "outro-cliente", ativo: true };

const CONTA_A = { id: 101, cliente_id: 90, marketplace: "meli", nome: "Mercado Livre 1", slug: "wbs-2-meli-1", external_account_id: "710361722", is_primary: false, ativo: true, metadata_json: {}, created_at: new Date(), updated_at: new Date() };
const CONTA_B = { id: 102, cliente_id: 90, marketplace: "meli", nome: "Mercado Livre 2", slug: "wbs-2-meli-2", external_account_id: "234836231", is_primary: true, ativo: true, metadata_json: {}, created_at: new Date(), updated_at: new Date() };
const CONTA_C_SHOPEE = { id: 103, cliente_id: 90, marketplace: "shopee", nome: "Shopee", slug: "wbs-2-shopee-1", external_account_id: "999", is_primary: true, ativo: true, metadata_json: {}, created_at: new Date(), updated_at: new Date() };

function grant({ id, cliente_id, cliente_conta_id, ml_user_id, is_primary, token_status = "valid" }) {
  return {
    id, cliente_id, cliente_conta_id, ml_user_id,
    access_token: `access-${ml_user_id}`, refresh_token: `refresh-${ml_user_id}`,
    expires_at: FAR_FUTURE, created_at: new Date(), updated_at: new Date(),
    is_primary, token_status, refresh_failures: 0,
    last_refresh_error_at: null, next_refresh_attempt_at: null,
    _has_is_primary: true, _has_refresh_metadata: true,
  };
}

class MemoryDb {
  constructor() {
    this.clientes = [CLIENTE_WBS2, CLIENTE_OUTRO];
    this.contas = [CONTA_A, CONTA_B, CONTA_C_SHOPEE];
    this.grants = [
      grant({ id: 201, cliente_id: 90, cliente_conta_id: 101, ml_user_id: "710361722", is_primary: false }),
      grant({ id: 202, cliente_id: 90, cliente_conta_id: 102, ml_user_id: "234836231", is_primary: true }),
    ];
    this.vinculos = []; // base_cliente_vinculos — nenhum vínculo nestes cenários
    this.bases = [];
    this.log = []; // toda query recebida, para provar ausência de UPDATE ml_tokens
  }

  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }

  async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, " ").trim();
    this.log.push({ sql: q, params });

    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(q) || q.includes("pg_advisory")) return { rows: [] };

    // clientes
    if (q.startsWith("SELECT id, nome, slug FROM clientes WHERE slug = $1 AND ativo = true")) {
      const c = this.clientes.find((x) => x.slug === params[0]);
      return { rows: c ? [c] : [] };
    }
    if (q.startsWith("SELECT id, nome, slug, ativo FROM clientes WHERE slug = $1")) {
      const c = this.clientes.find((x) => x.slug === params[0]);
      return { rows: c ? [c] : [] };
    }
    if (q.startsWith("SELECT id, nome, slug, ativo FROM clientes WHERE id = $1")) {
      const c = this.clientes.find((x) => x.id === Number(params[0]));
      return { rows: c ? [c] : [] };
    }

    // cliente_contas
    if (q.startsWith("SELECT * FROM cliente_contas WHERE id = $1")) {
      const c = this.contas.find((x) => x.id === Number(params[0]));
      return { rows: c ? [c] : [] };
    }
    if (q.startsWith("SELECT * FROM cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true")) {
      return { rows: this.contas.filter((c) => c.cliente_id === Number(params[0]) && c.marketplace === params[1] && c.ativo) };
    }
    if (q.startsWith("SELECT COUNT(*)::int AS total FROM cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true")) {
      const total = this.contas.filter((c) => c.cliente_id === Number(params[0]) && c.marketplace === params[1] && c.ativo).length;
      return { rows: [{ total }] };
    }

    // base_cliente_vinculos + bases — nenhum vínculo cadastrado nestes cenários
    if (q.includes("FROM base_cliente_vinculos v") && q.includes("JOIN bases b ON b.id = v.base_id")) {
      return { rows: [] };
    }
    if (q.includes("FROM base_cliente_vinculos v") && q.includes("JOIN bases b ON b.id = v.base_id AND b.ativo = true")) {
      return { rows: [] };
    }

    // ml_tokens — GRANT_PROJECTION (mlTokenService.js)
    if (q.includes("FROM ml_tokens t") && q.includes("t.cliente_id = $1 AND t.ml_user_id = $2")) {
      const g = this.grants.find((x) => x.cliente_id === Number(params[0]) && String(x.ml_user_id) === String(params[1]));
      return { rows: g ? [{ ...g }] : [] };
    }
    if (q.includes("FROM ml_tokens t") && q.includes("WHERE t.cliente_id = $1") && !q.includes("ml_user_id")) {
      return { rows: this.grants.filter((x) => x.cliente_id === Number(params[0])).map((g) => ({ ...g })) };
    }

    throw new Error(`Query não mapeada no mock: ${q}`);
  }
}

async function run() {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const db = new MemoryDb();
  pool.query = (sql, params) => db.query(sql, params);
  pool.connect = () => db.connect();

  try {
    delete require.cache[require.resolve("../services/mlTokenService")];
    delete require.cache[require.resolve("../services/clienteContas/clienteContaService")];
    delete require.cache[require.resolve("../services/automacoes/contextoPrecificacaoService")];
    const {
      resolverContextoPrecificacao,
      exigirContextoGrantMl,
    } = require("../services/automacoes/contextoPrecificacaoService");

    // ── TESTE 1: Conta A explicitamente selecionada ──────────────────────
    const ctxA = await resolverContextoPrecificacao({ clienteSlugRaw: "wbs-2", clienteContaId: 101 });
    ok("TESTE 1 — clienteContaId 101 (Conta A) resolve ml_user_id 710361722", ctxA.grant.ml_user_id === "710361722");
    ok("TESTE 1 — conta resolvida é a Conta A (id 101)", ctxA.conta && ctxA.conta.id === 101);

    // ── TESTE 2: troca para Conta B (sem reload — cada chamada é independente) ──
    const ctxB = await resolverContextoPrecificacao({ clienteSlugRaw: "wbs-2", clienteContaId: 102 });
    ok("TESTE 2 — clienteContaId 102 (Conta B) resolve ml_user_id 234836231", ctxB.grant.ml_user_id === "234836231");
    ok("TESTE 2 — conta resolvida é a Conta B (id 102)", ctxB.conta && ctxB.conta.id === 102);

    // ── TESTE 3 (regressão crítica): Conta B é is_primary; selecionar A
    //    explicitamente TEM QUE continuar resolvendo A, nunca B por causa
    //    do is_primary. ─────────────────────────────────────────────────
    ok("TESTE 3 — Conta B é is_primary no fixture", db.contas.find((c) => c.id === 102).is_primary === true);
    const ctxAdeNovo = await resolverContextoPrecificacao({ clienteSlugRaw: "wbs-2", clienteContaId: 101 });
    ok("TESTE 3 — clienteContaId 101 explícito ignora is_primary de B e resolve A (710361722)", ctxAdeNovo.grant.ml_user_id === "710361722");

    // ── TESTE 4: clienteContaId da Conta A + clienteSlug de OUTRO cliente ─
    await rejeitaCom(
      "TESTE 4 — Conta A + cliente errado → CONTA_NAO_PERTENCE_AO_CLIENTE, nunca acessa o grant",
      resolverContextoPrecificacao({ clienteSlugRaw: "outro-cliente", clienteContaId: 101 }),
      (err) => err.statusCode === 403 && err.code === "CONTA_NAO_PERTENCE_AO_CLIENTE"
    );

    // ── TESTE 5: conta existe mas é Shopee — Automações ML deve rejeitar ──
    await rejeitaCom(
      "TESTE 5 — conta Shopee informada em fluxo ML → MARKETPLACE_INCOMPATIVEL",
      resolverContextoPrecificacao({ clienteSlugRaw: "wbs-2", clienteContaId: 103 }),
      (err) => err.statusCode === 422 && err.code === "MARKETPLACE_INCOMPATIVEL"
    );

    // ── TESTE 6: grant da conta selecionada revogado — nunca cai para a
    //    outra conta do mesmo cliente. ────────────────────────────────────
    const grantA = db.grants.find((g) => g.cliente_conta_id === 101);
    grantA.token_status = "revoked";
    await rejeitaCom(
      "TESTE 6 — grant de A revogado → GRANT_ML_NAO_CONECTADO (424), não usa o grant de B",
      exigirContextoGrantMl({ clienteSlugRaw: "wbs-2", clienteContaId: 101 }),
      (err) => err.statusCode === 424 && err.payload && err.payload.codigo === "GRANT_ML_NAO_CONECTADO"
    );
    const ctxRevogado = await resolverContextoPrecificacao({ clienteSlugRaw: "wbs-2", clienteContaId: 101 });
    ok("TESTE 6 — mlUserId nulo (não herdou o de B) quando o grant da conta pedida está revogado", ctxRevogado.grant.ml_user_id === null);
    grantA.token_status = "valid"; // restaura para os testes seguintes

    // ── TESTE 7: 2 contas ML ativas, nenhuma informada → bloqueia, nunca
    //    escolhe a primeira em silêncio. ──────────────────────────────────
    await rejeitaCom(
      "TESTE 7 — 2 contas ML ativas sem clienteContaId → CONTA_AMBIGUA (409), nunca escolhe uma sozinha",
      resolverContextoPrecificacao({ clienteSlugRaw: "wbs-2" }),
      (err) => err.statusCode === 409 && err.code === "MULTIPLE_MARKETPLACE_ACCOUNTS"
    );

    // ── TESTE MUITO IMPORTANTE DO GRANT: selecionar uma conta explicitamente
    //    NUNCA escreve em ml_tokens (nenhum UPDATE/is_primary tocado). ────
    db.log.length = 0;
    await resolverContextoPrecificacao({ clienteSlugRaw: "wbs-2", clienteContaId: 101 });
    await resolverContextoPrecificacao({ clienteSlugRaw: "wbs-2", clienteContaId: 102 });
    const escritasEmMlTokens = db.log.filter((entry) => /ml_tokens/i.test(entry.sql) && /^(UPDATE|INSERT|DELETE)/i.test(entry.sql));
    ok("GRANT — nenhum UPDATE/INSERT/DELETE em ml_tokens só por selecionar a conta", escritasEmMlTokens.length === 0);
    ok(
      "GRANT — is_primary de A e B continuam como no fixture original (false / true)",
      db.grants.find((g) => g.cliente_conta_id === 101).is_primary === false &&
      db.grants.find((g) => g.cliente_conta_id === 102).is_primary === true
    );

    console.log(`\n✓ automacoesContaScoped: ${checks} verificações`);
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    delete require.cache[require.resolve("../services/mlTokenService")];
    delete require.cache[require.resolve("../services/clienteContas/clienteContaService")];
    delete require.cache[require.resolve("../services/automacoes/contextoPrecificacaoService")];
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
