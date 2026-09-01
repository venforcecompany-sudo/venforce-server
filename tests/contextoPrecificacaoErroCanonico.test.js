// server/tests/contextoPrecificacaoErroCanonico.test.js
//
// Unificação dos vocabulários de erro de contexto para o VenForce V3
// (VENFORCE_V3_MASTER_SPEC.md §3.4, §18.5, M5): contextoPrecificacaoService
// lançava `codigo` + HTTP 400/409, um vocabulário incompatível com o
// `code` + 409/403/422 do resto do backend. Prova que a migração é
// puramente ADITIVA: `codigo` continua com o mesmo valor de sempre
// (nenhum consumidor existente quebra); `code` canônico é novo; e as três
// falhas de integração (grant/base) agora respondem 424, não mais
// 400/409 — indistinguível de erro de validação ou de ambiguidade.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const pool = require("../config/database");
const Module = require("module");

// resolveMlGrant é destruturado no require-time — stub antes do require.
// contextoPrecificacaoService agora resolve conta/grant via
// resolveMarketplaceAccountContext (clienteContaService.js), que também
// requer "../mlTokenService" (mesma string, resolvida a partir de outro
// diretório) e chama `createMlTokenService({ db })` — o stub precisa
// devolver as duas formas para continuar interceptando as duas chamadas.
const originalLoad = Module._load;
let GRANT_CONECTADO = null; // null = sem grant; string = ml_user_id conectado
async function resolveMlGrantStub({ clienteId, requireUsable }) {
  if (!GRANT_CONECTADO) {
    const err = new Error("Cliente não possui grant Mercado Livre.");
    err.code = "ML_GRANT_NOT_FOUND";
    throw err;
  }
  return { ml_user_id: GRANT_CONECTADO };
}
Module._load = function loadWithMlTokenStub(request, parent, isMain) {
  if (request === "../mlTokenService") {
    return {
      resolveMlGrant: resolveMlGrantStub,
      createMlTokenService: () => ({ resolveMlGrant: resolveMlGrantStub }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  resolverContextoPrecificacao,
  exigirContextoPronto,
  exigirContextoGrantMl,
  MOTIVOS,
} = require("../services/automacoes/contextoPrecificacaoService");
const { CODIGOS_CANONICOS } = require("../utils/erroContextoCanonico");

Module._load = originalLoad;

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
  if (verificar) assert.ok(verificar(erro), `FALHOU (erro inesperado): ${label} — ${JSON.stringify(erro.payload || erro.message)}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const cliente = { id: 1, nome: "N97 Comercial", slug: "n97", ativo: true };

class MockDb {
  constructor({ basesMeli = [] } = {}) {
    this.basesMeli = basesMeli;
  }
  async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT id, nome, slug FROM clientes WHERE slug = $1 AND ativo = true")) {
      return { rows: cliente.slug === params[0] ? [cliente] : [] };
    }
    // resolveMarketplaceAccountContext (clienteContaService.js) resolve o
    // cliente de novo, por slug, com um SELECT ligeiramente diferente (sem
    // "AND ativo = true" no texto). Nenhuma cliente_conta cadastrada nestes
    // cenários → cai no caminho legado (mesmo comportamento de antes desta
    // integração): grant principal/fallback via mlTokenService.
    if (q.startsWith("SELECT id, nome, slug, ativo FROM clientes WHERE slug = $1")) {
      return { rows: cliente.slug === params[0] ? [cliente] : [] };
    }
    if (q.startsWith("SELECT id, nome, slug, ativo FROM clientes WHERE id = $1")) {
      return { rows: cliente.id === Number(params[0]) ? [cliente] : [] };
    }
    if (q.startsWith("SELECT * FROM cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true")) {
      return { rows: [] }; // nenhuma conta cadastrada → modo legado
    }
    if (q.includes("FROM base_cliente_vinculos v") && q.includes("JOIN bases b ON b.id = v.base_id AND b.ativo = true") && !q.includes("b.slug = $2")) {
      return { rows: this.basesMeli };
    }
    if (q.includes("AND b.slug = $2")) {
      return { rows: this.basesMeli.filter((b) => b.slug === params[1]) };
    }
    return { rows: [] };
  }
}

function withMockDb(dbOpts, grantConectado, fn) {
  const original = pool.query;
  GRANT_CONECTADO = grantConectado;
  pool.query = (sql, params) => new MockDb(dbOpts).query(sql, params);
  return Promise.resolve().then(fn).finally(() => { pool.query = original; GRANT_CONECTADO = null; });
}

async function run() {
  // 1. Sem grant conectado: codigo legado preservado, code canônico novo,
  //    e o status muda de 400 para 424 (falha de integração, não de
  //    validação nem de autorização).
  await withMockDb({}, null, async () => {
    await rejeitaCom(
      "exigirContextoGrantMl sem grant → codigo legado + code canônico + 424",
      exigirContextoGrantMl({ clienteSlugRaw: "n97" }),
      (err) =>
        err.statusCode === 424 &&
        err.payload.codigo === "GRANT_ML_NAO_CONECTADO" &&
        err.payload.code === CODIGOS_CANONICOS.GRANT_DESCONECTADO
    );
  });

  // 2. Grant conectado, 0 bases MELI vinculadas: BASE_AUSENTE, 424.
  await withMockDb({ basesMeli: [] }, "111", async () => {
    await rejeitaCom(
      "exigirContextoPronto sem base vinculada → BASE_AUSENTE canônico, 424",
      exigirContextoPronto({ clienteSlugRaw: "n97" }),
      (err) =>
        err.statusCode === 424 &&
        err.payload.codigo === "BASE_MELI_NAO_VINCULADA" &&
        err.payload.code === CODIGOS_CANONICOS.BASE_AUSENTE
    );
  });

  // 3. Grant conectado, 2+ bases MELI vinculadas: BASE_AMBIGUA, 424.
  await withMockDb(
    { basesMeli: [{ id: 1, slug: "a", nome: "A", ativo: true }, { id: 2, slug: "b", nome: "B", ativo: true }] },
    "111",
    async () => {
      await rejeitaCom(
        "exigirContextoPronto com 2+ bases → BASE_AMBIGUA canônico, 424",
        exigirContextoPronto({ clienteSlugRaw: "n97" }),
        (err) =>
          err.statusCode === 424 &&
          err.payload.codigo === "MULTIPLAS_BASES_MELI" &&
          err.payload.code === CODIGOS_CANONICOS.BASE_AMBIGUA
      );
    }
  );

  // 4. Cliente inexistente: continua 404, ganha code canônico igual ao valor legado.
  await withMockDb({}, "111", async () => {
    await rejeitaCom(
      "cliente inexistente → 404 preservado + code canônico",
      resolverContextoPrecificacao({ clienteSlugRaw: "nao-existe" }),
      (err) => err.statusCode === 404 && err.payload.code === CODIGOS_CANONICOS.CLIENTE_NAO_ENCONTRADO
    );
  });

  // 5. Caminho feliz: grant conectado + exatamente 1 base — nenhuma mudança
  //    de comportamento, nenhum erro lançado.
  await withMockDb({ basesMeli: [{ id: 1, slug: "a", nome: "A", ativo: true }] }, "111", async () => {
    const resultado = await exigirContextoPronto({ clienteSlugRaw: "n97" });
    ok("caminho feliz continua funcionando sem erro", resultado.base.slug === "a");
  });

  console.log(`\ncontextoPrecificacaoErroCanonico.test.js: ${checks} verificações passaram.`);
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
