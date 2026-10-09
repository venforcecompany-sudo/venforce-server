// server/tests/automacoesProntidaoConta.test.js
//
// Hotfix — falsa duplicidade de bases no Otimizador ML (/automacoes.html).
// GET /automacoes/clientes conta TODAS as bases MELI do cliente: com Conta A
// → Base A e Conta B → Base B, devolvia baseStatus "multiplas" ("2 bases
// vinculadas") e bloqueava "Analisar loja" para qualquer conta. A prontidão
// agora vem de GET /automacoes/prontidao (prontidaoContaAutomacoesController),
// que passa pelo resolver canônico (resolverContextoPrecificacao). Cenários:
//
//   A. 2 contas, uma base cada, grants válidos → cada conta pronta com a SUA base.
//   B. Conta B sem base → "ausente", nunca reaproveita a Base A.
//   C. Mesma conta com 2 bases ativas → "multiplas" (duplicidade real).
//   D. Legado: sem cliente_contas, 1 base sem conta → pronto; 2+ contas sem
//      seleção → 409, nunca escolhe uma conta/base em silêncio.
//   E. Grant da conta B inválido → só B bloqueia; não herda o grant de A e a
//      linha de base continua escopada em B.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const pool = require("../config/database");
const Module = require("module");

let GRANTS_VALIDOS = new Set();
async function resolveMlGrantStub({ mlUserId }) {
  if (!mlUserId || !GRANTS_VALIDOS.has(String(mlUserId))) {
    const err = new Error("Grant indisponível.");
    err.code = "ML_GRANT_NOT_FOUND";
    throw err;
  }
  return { ml_user_id: String(mlUserId) };
}
const originalLoad = Module._load;
Module._load = function loadWithMlTokenStub(request, parent, isMain) {
  if (request === "../mlTokenService") {
    return {
      resolveMlGrant: resolveMlGrantStub,
      createMlTokenService: () => ({ resolveMlGrant: resolveMlGrantStub }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { prontidaoContaAutomacoesController } = require("../controllers/automacoesController");
const { exigirContextoGrantMl } = require("../services/automacoes/contextoPrecificacaoService");
Module._load = originalLoad;

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const cliente = { id: 1, nome: "Alianza Jeans", slug: "alianza_jeans", ativo: true };
const contaA = { id: 86, cliente_id: 1, marketplace: "meli", nome: "Alianza Jeans", slug: "a", external_account_id: "111", is_primary: true, ativo: true, metadata_json: {}, created_at: null, updated_at: null };
const contaB = { id: 87, cliente_id: 1, marketplace: "meli", nome: "Alianza Jeans 2", slug: "b", external_account_id: "222", is_primary: false, ativo: true, metadata_json: {}, created_at: null, updated_at: null };

const bases = {
  7001: { id: 7001, slug: "base-a", nome: "Base A", ativo: true, created_at: null, updated_at: "2026-10-01T00:00:00Z" },
  7002: { id: 7002, slug: "base-b", nome: "Base B", ativo: true, created_at: null, updated_at: "2026-10-02T00:00:00Z" },
  7003: { id: 7003, slug: "base-a2", nome: "Base A2", ativo: true, created_at: null, updated_at: "2026-10-03T00:00:00Z" },
  7009: { id: 7009, slug: "base-legado", nome: "Base Legado", ativo: true, created_at: null, updated_at: null },
};
const vinc = (id, contaId, baseId) => ({ id, cliente_id: 1, cliente_conta_id: contaId, base_id: baseId, marketplace: "meli", ativo: true });

function mockDb({ contas, vinculos }) {
  return async (sql, params = []) => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT id, nome, slug FROM clientes WHERE slug = $1") || q.startsWith("SELECT id, nome, slug, ativo FROM clientes WHERE slug = $1")) {
      return { rows: params[0] === cliente.slug ? [cliente] : [] };
    }
    if (q.startsWith("SELECT * FROM cliente_contas WHERE id = $1")) {
      const row = [...contas, { ...contaA, id: 999, cliente_id: 2 }].find((c) => c.id === Number(params[0]));
      return { rows: row ? [row] : [] };
    }
    if (q.startsWith("SELECT * FROM cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true")) {
      return { rows: contas.filter((c) => c.cliente_id === Number(params[0]) && c.marketplace === params[1]) };
    }
    if (q.startsWith("SELECT COUNT(*)::int AS total FROM cliente_contas")) {
      return { rows: [{ total: contas.filter((c) => c.cliente_id === Number(params[0])).length }] };
    }
    if (q.includes("v.cliente_conta_id = $1 AND v.ativo = true")) {
      const v = vinculos.find((x) => x.cliente_conta_id === Number(params[0]));
      return { rows: v ? [{ vinculo_id: v.id, base_id: v.base_id, slug: bases[v.base_id].slug, nome: bases[v.base_id].nome }] : [] };
    }
    if (q.includes("b.ativo = true") && q.includes("v.cliente_id = $1")) {
      return { rows: vinculos.filter((v) => v.cliente_id === Number(params[0])).map((v) => ({ ...bases[v.base_id], cliente_conta_id: v.cliente_conta_id })) };
    }
    if (q.includes("v.cliente_id = $1 AND v.marketplace = $2 AND v.ativo = true")) {
      const v = vinculos.find((x) => x.cliente_id === Number(params[0]));
      return { rows: v ? [{ vinculo_id: v.id, base_id: v.base_id, slug: bases[v.base_id].slug, nome: bases[v.base_id].nome }] : [] };
    }
    return { rows: [] };
  };
}

async function prontidao(db, grantsValidos, query) {
  const original = pool.query;
  GRANTS_VALIDOS = new Set(grantsValidos);
  pool.query = mockDb(db);
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  try {
    await prontidaoContaAutomacoesController({ query }, res);
  } finally {
    pool.query = original;
  }
  return res;
}

async function run() {
  const ambas = { contas: [contaA, contaB], vinculos: [vinc(1, 86, 7001), vinc(2, 87, 7002)] };

  // A — o caso do incidente: cada conta com sua base NÃO é duplicidade.
  let r = await prontidao(ambas, ["111", "222"], { clienteSlug: "alianza_jeans", clienteContaId: "87" });
  ok("A — conta 87: 200", r.statusCode === 200 && r.body.ok === true);
  ok("A — conta 87: baseStatus ok (não 'multiplas')", r.body.prontidao.baseStatus === "ok");
  ok("A — conta 87: basesMeliCount 1", r.body.prontidao.basesMeliCount === 1);
  ok("A — conta 87: usa Base B", r.body.prontidao.baseMeli === "base-b");
  ok("A — conta 87: grant da própria conta (222)", r.body.prontidao.mlUserId === "222");
  ok("A — conta 87: prontoParaAnalise", r.body.prontidao.prontoParaAnalise === true);
  r = await prontidao(ambas, ["111", "222"], { clienteSlug: "alianza_jeans", clienteContaId: "86" });
  ok("A — conta 86: usa Base A, pronta", r.body.prontidao.baseMeli === "base-a" && r.body.prontidao.prontoParaAnalise === true);
  ok("A — conta 86: grant 111", r.body.prontidao.mlUserId === "111");

  // B — conta sem base própria nunca reaproveita a base da outra.
  const soA = { contas: [contaA, contaB], vinculos: [vinc(1, 86, 7001)] };
  r = await prontidao(soA, ["111", "222"], { clienteSlug: "alianza_jeans", clienteContaId: "87" });
  ok("B — conta 87 sem base: ausente", r.body.prontidao.baseStatus === "ausente" && r.body.prontidao.baseMeli === null);
  ok("B — conta 87 sem base: análise bloqueada", r.body.prontidao.prontoParaAnalise === false);
  ok("B — conta 87 sem base: planilha liberada (grant válido)", r.body.prontidao.prontoParaExportacaoCrua === true && r.body.prontidao.hasGrantMl === true);

  // C — duplicidade real na MESMA conta continua bloqueando (e só ela).
  const dupA = { contas: [contaA, contaB], vinculos: [vinc(1, 86, 7001), vinc(3, 86, 7003), vinc(2, 87, 7002)] };
  r = await prontidao(dupA, ["111", "222"], { clienteSlug: "alianza_jeans", clienteContaId: "86" });
  ok("C — conta 86 com 2 bases: multiplas", r.body.prontidao.baseStatus === "multiplas" && r.body.prontidao.basesMeliCount === 2);
  ok("C — conta 86 com 2 bases: bloqueada", r.body.prontidao.prontoParaAnalise === false && r.body.prontidao.motivo === "MULTIPLAS_BASES_MELI");
  r = await prontidao(dupA, ["111", "222"], { clienteSlug: "alianza_jeans", clienteContaId: "87" });
  ok("C — conta 87 não é contaminada pela duplicidade da 86", r.body.prontidao.baseStatus === "ok" && r.body.prontidao.prontoParaAnalise === true);

  // D — legado.
  r = await prontidao({ contas: [], vinculos: [vinc(9, null, 7009)] }, [], { clienteSlug: "alianza_jeans" });
  ok("D — sem cliente_contas e sem grant: base legado exibida, bloqueia por grant", r.body.prontidao.baseMeli === "base-legado" && r.body.prontidao.motivo === "GRANT_ML_NAO_CONECTADO");
  r = await prontidao({ contas: [contaA], vinculos: [vinc(9, null, 7009)] }, ["111"], { clienteSlug: "alianza_jeans" });
  ok("D — 1 conta + vínculo legado: pronto com a base legado", r.body.prontidao.prontoParaAnalise === true && r.body.prontidao.baseMeli === "base-legado");
  r = await prontidao(ambas, ["111", "222"], { clienteSlug: "alianza_jeans" });
  ok("D — 2 contas sem clienteContaId: 409, nunca escolhe em silêncio", r.statusCode === 409 && r.body.code === "MULTIPLE_MARKETPLACE_ACCOUNTS");

  // E — grant inválido só da conta 87.
  r = await prontidao(ambas, ["111"], { clienteSlug: "alianza_jeans", clienteContaId: "87" });
  ok("E — conta 87 sem grant: hasGrantMl false, não herda o grant 111", r.body.prontidao.hasGrantMl === false && r.body.prontidao.mlUserId === null);
  ok("E — conta 87 sem grant: base exibida continua a da 87", r.body.prontidao.baseMeli === "base-b");
  ok("E — conta 87 sem grant: bloqueada por grant", r.body.prontidao.prontoParaAnalise === false && r.body.prontidao.motivo === "GRANT_ML_NAO_CONECTADO");
  r = await prontidao(soA, ["111"], { clienteSlug: "alianza_jeans", clienteContaId: "87" });
  ok("E — conta 87 sem grant e sem base: nunca mostra a Base A", r.body.prontidao.baseStatus === "ausente" && r.body.prontidao.baseMeli === null);
  r = await prontidao(ambas, ["111"], { clienteSlug: "alianza_jeans", clienteContaId: "86" });
  ok("E — conta 86 segue pronta", r.body.prontidao.prontoParaAnalise === true);

  // Estrutural: conta de outro cliente → 403, nunca cai em outra conta.
  r = await prontidao(ambas, ["111", "222"], { clienteSlug: "alianza_jeans", clienteContaId: "999" });
  ok("conta de outro cliente: 403 CONTA_NAO_PERTENCE_AO_CLIENTE", r.statusCode === 403 && r.body.code === "CONTA_NAO_PERTENCE_AO_CLIENTE");

  // Planilha sem base (exigirContextoGrantMl → planilhaPrecificacaoSemBaseService)
  // usa basesConta: com uma base por conta não é "multiplas", e a conta sem
  // base própria recebe 0 bases (antes: count 1 do cliente + base null → crash).
  const comDb = async (db, grants, fn) => {
    const original = pool.query;
    GRANTS_VALIDOS = new Set(grants);
    pool.query = mockDb(db);
    try { return await fn(); } finally { pool.query = original; }
  };
  let g = await comDb(ambas, ["111", "222"], () => exigirContextoGrantMl({ clienteSlugRaw: "alianza_jeans", clienteContaId: "87" }));
  ok("planilha — conta 87: 1 base da conta (Base B), não 2 do cliente", g.basesConta.length === 1 && g.base && g.base.id === 7002);
  g = await comDb(soA, ["111", "222"], () => exigirContextoGrantMl({ clienteSlugRaw: "alianza_jeans", clienteContaId: "87" }));
  ok("planilha — conta 87 sem base: 0 bases e base null (nunca Base A)", g.basesConta.length === 0 && g.base === null);

  console.log(`\nautomacoesProntidaoConta.test.js: ${checks} verificações passaram.`);
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
