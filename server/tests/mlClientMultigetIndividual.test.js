// server/tests/mlClientMultigetIndividual.test.js
//
// Desde 2026-11-24 o ML recusa parte dos lotes de GET /items?ids= com 403
// ResourceDeprecated (o lote inteiro). O mlFetch passa a atender esse caminho
// com um GET /items/{id} por item, devolvendo o formato do multiget.
//
// Regras protegidas:
//  1. um GET /items?ids=a,b vira uma leitura por id, e a resposta mantém o
//     formato { ok, status:200, data:[{ code, body }] } na ordem pedida;
//  2. falha de um item (404/403 access_denied) não derruba os outros: vira
//     entrada com o code do ML e o id no corpo;
//  3. 403 ResourceDeprecated, 429 e 5xx são repetidos (até 3 tentativas);
//  4. o resto da query (attributes=…) é repassado a cada leitura;
//  5. 401 em todos os itens sobe como falha geral (sessão), como no multiget;
//  6. qualquer outro caminho ou método passa direto, sem ser reescrito.
//
// Sem rede e sem banco: token e fetch são simulados.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function stubToken(request, parent, isMain) {
  if (request === "../services/mlTokenService") {
    return {
      getValidMlGrantToken: async () => ({ accessToken: "tok", grant: { id: 1 } }),
      getValidMlTokenByCliente: async () => "tok",
      getMlGrantTokenNoRefresh: async () => ({ accessToken: "tok", grant: { id: 1 } }),
      refreshMlGrant: async () => ({ id: 1, access_token: "tok2" }),
      sanitizeErrorMessage: (e) => String(e && e.message),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { mlFetch } = require("../utils/mlClient");
Module._load = originalLoad;

let chamadas = [];
let responder = null;
const fetchOriginal = global.fetch;
global.fetch = async (url, init = {}) => {
  const path = String(url).replace("https://api.mercadolibre.com", "");
  chamadas.push({ path, metodo: init.method || "GET" });
  const { status, corpo } = responder(path, chamadas.filter((c) => c.path === path).length);
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => corpo, text: async () => JSON.stringify(corpo) };
};

let checks = 0;
const ok = (l) => { checks += 1; console.log(`  ✓ ${l}`); };

async function run() {
  // 1. vira uma leitura por id, formato do multiget preservado, ordem mantida.
  chamadas = [];
  responder = (path) => ({ status: 200, corpo: { id: path.split("/items/")[1], status: "active" } });
  let r = await mlFetch(1, "/items?ids=MLB1,MLB2,MLB3", { mlUserId: "9" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.data.map((e) => [e.code, e.body.id]), [[200, "MLB1"], [200, "MLB2"], [200, "MLB3"]]);
  assert.deepStrictEqual(chamadas.map((c) => c.path).sort(), ["/items/MLB1", "/items/MLB2", "/items/MLB3"]);
  assert.ok(!chamadas.some((c) => c.path.includes("ids=")), "nenhuma chamada usa o multiget");
  ok("multiget vira uma leitura por id, no formato e na ordem de sempre");

  // 2. falha de um não derruba os outros.
  chamadas = [];
  responder = (path) => {
    if (path === "/items/MLB2") return { status: 404, corpo: { error: "not_found", message: "Item not found" } };
    if (path === "/items/MLB3") return { status: 403, corpo: { error: "access_denied", message: "Access to the requested resource is forbidden" } };
    return { status: 200, corpo: { id: "MLB1", status: "paused" } };
  };
  r = await mlFetch(1, "/items?ids=MLB1,MLB2,MLB3", {});
  assert.deepStrictEqual(r.data.map((e) => e.code), [200, 404, 403]);
  assert.strictEqual(r.data[1].body.id, "MLB2", "erro carrega o id do item");
  assert.strictEqual(r.data[2].body.error, "access_denied");
  assert.strictEqual(chamadas.filter((c) => c.path === "/items/MLB2").length, 1, "404 não é repetido");
  assert.strictEqual(chamadas.filter((c) => c.path === "/items/MLB3").length, 1, "access_denied não é repetido");
  ok("falha de um item vira entrada com o code do ML, sem derrubar os outros nem repetir 404/access_denied");

  // 3. ResourceDeprecated / 429 / 5xx são repetidos.
  chamadas = [];
  responder = (path, n) => {
    if (path === "/items/MLB1") return n < 3 ? { status: 403, corpo: { error: "ResourceDeprecated", message: "Resource deprecated" } } : { status: 200, corpo: { id: "MLB1", status: "active" } };
    if (path === "/items/MLB2") return n < 2 ? { status: 503, corpo: { error: "unavailable" } } : { status: 200, corpo: { id: "MLB2", status: "active" } };
    return { status: 403, corpo: { error: "ResourceDeprecated" } };
  };
  r = await mlFetch(1, "/items?ids=MLB1,MLB2,MLB3", {});
  assert.deepStrictEqual(r.data.map((e) => e.code), [200, 200, 403]);
  assert.strictEqual(chamadas.filter((c) => c.path === "/items/MLB1").length, 3);
  assert.strictEqual(chamadas.filter((c) => c.path === "/items/MLB3").length, 3, "para depois de 3 tentativas");
  ok("ResourceDeprecated/5xx são repetidos até 3 vezes; esgotado, a falha vira entrada");

  // 4. attributes repassado.
  chamadas = [];
  responder = (path) => ({ status: 200, corpo: { id: "MLB1" } });
  await mlFetch(1, "/items?ids=MLB1&attributes=id,status", {});
  assert.deepStrictEqual(chamadas.map((c) => c.path), ["/items/MLB1?attributes=id,status"]);
  ok("o restante da query (attributes) vai em cada leitura");

  // 5. 401 geral sobe como falha geral.
  chamadas = [];
  responder = () => ({ status: 401, corpo: { message: "invalid token" } });
  r = await mlFetch(1, "/items?ids=MLB1,MLB2", {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 401);
  ok("401 em todos os itens volta como falha geral (sessão), não como lista de erros");

  // 6. outros caminhos/métodos passam direto.
  chamadas = [];
  responder = () => ({ status: 200, corpo: { ok: 1 } });
  await mlFetch(1, "/items/MLB1/sale_price?context=channel_marketplace", {});
  await mlFetch(1, "/users/9/items/search?search_type=scan&limit=100", {});
  await mlFetch(1, "/items?ids=MLB1", { method: "POST", body: "{}" });
  assert.deepStrictEqual(chamadas.map((c) => c.path), [
    "/items/MLB1/sale_price?context=channel_marketplace",
    "/users/9/items/search?search_type=scan&limit=100",
    "/items?ids=MLB1",
  ]);
  ok("outros caminhos e métodos não são reescritos");
}

run()
  .then(() => { global.fetch = fetchOriginal; console.log(`\n✓ ${checks} verificações do multiget individual no mlFetch`); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
