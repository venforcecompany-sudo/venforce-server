// server/tests/meliAnunciosStatusAtivoPromocao.test.js
//
// Anúncio reativado no ML precisa refletir no portal, e promoção não pode ser
// enviada para anúncio pausado. Regras protegidas:
//
//  1. participar de promoção (POST de preço e aceite) lê o status AO VIVO no ML
//     e recusa pausado/encerrado ANTES de qualquer POST (zero escrita);
//  2. a mensagem distingue pausado por falta de estoque;
//  3. status ausente/ilegível ou falha de leitura não bloqueia (o ML decide);
//  4. alterar (PUT) uma participação existente não é bloqueado por esse status;
//  5. o sync "novos" rebusca os já gravados que não estão ativos (reativação);
//  6. o webhook do tópico `items` atualiza só /items/MLB… do vendedor, com
//     debounce, e ignora os demais tópicos e recursos fora do formato.
//
// Sem PostgreSQL: o banco e o mlFetch são substituídos.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const Module = require("module");

let mlChamadas = [];
let mlHandler = null;

const originalLoad = Module._load;
Module._load = function loadWithMlFetchStub(request, parent, isMain) {
  if (request === "../../utils/mlClient" || request === "../utils/mlClient") {
    return {
      async mlFetch(clienteId, path, options = {}) {
        mlChamadas.push({ clienteId, path, metodo: options.method || "GET", mlUserId: options.mlUserId, body: options.body ? JSON.parse(options.body) : null });
        return mlHandler(mlChamadas[mlChamadas.length - 1]);
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { aplicarPromocao, participarPromocaoAceite } = require("../services/meliAnuncios/meliPromocoesEscritaService");
const anunciosService = require("../services/meliAnuncios/meliAnunciosService");
const syncService = require("../services/meliAnuncios/meliSyncService");
const familiaService = require("../services/meliAnuncios/meliFamiliaService");
const { processarNotificacao, itemIdDaNotificacao } = require("../controllers/mlWebhookController");

Module._load = originalLoad;

let checks = 0;
function ok(label) { checks += 1; console.log(`  ✓ ${label}`); }

const escritas = () => mlChamadas.filter((c) => c.metodo === "POST" || c.metodo === "PUT");

const promoAceite = {
  id: "P-1", type: "MARKETPLACE_CAMPAIGN", status: "candidate", ref_id: "CANDIDATE-MLB1-P-1",
  original_price: 100, suggested_discounted_price: 90, meli_percentage: 0, seller_percentage: 0,
  start_date: "2026-11-01T03:00:00Z", finish_date: "2026-12-01T02:59:00Z",
};
const dealCandidata = { id: "D-1", type: "DEAL", status: "candidate", original_price: 100, suggested_discounted_price: 90 };
const dealIniciada = { id: "D-2", type: "DEAL", status: "started", original_price: 100, price: 90 };

// ML simulado: /items/{id} devolve `item`; promoções devolvem `promos`.
function ml({ item, promos }) {
  return (c) => {
    if (/^\/items\//.test(c.path)) return item;
    if (/\/sale_price/.test(c.path)) return { ok: true, status: 200, data: {} };
    if (c.metodo === "GET") return { ok: true, status: 200, data: promos };
    return { ok: true, status: 201, data: { price: 90 } };
  };
}
const itemML = (data) => ({ ok: true, status: 200, data });

const aceitar = () => participarPromocaoAceite({ clienteId: 1, itemId: "MLB1", mlUserId: "111", promotionId: "P-1", tipo: "MARKETPLACE_CAMPAIGN" });
const aplicar = (promotionId) => aplicarPromocao({ clienteId: 1, itemId: "MLB1", mlUserId: "111", promotionId, precoNovo: 90 });

async function run() {
  // 1+2. aceite: pausado por falta de estoque → ANUNCIO_NAO_ATIVO, zero POST.
  mlChamadas = [];
  mlHandler = ml({ item: itemML({ id: "MLB1", status: "paused", sub_status: ["out_of_stock"], available_quantity: 0 }), promos: [promoAceite] });
  let r = await aceitar();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.codigo, "ANUNCIO_NAO_ATIVO");
  assert.match(r.motivo, /falta de estoque/);
  assert.strictEqual(escritas().length, 0);
  ok("aceite: anúncio pausado sem estoque → ANUNCIO_NAO_ATIVO (com motivo de estoque), zero POST");

  // pausado manualmente → mensagem sem estoque.
  mlChamadas = [];
  mlHandler = ml({ item: itemML({ id: "MLB1", status: "paused", sub_status: [], available_quantity: 5 }), promos: [promoAceite] });
  r = await aceitar();
  assert.strictEqual(r.codigo, "ANUNCIO_NAO_ATIVO");
  assert.doesNotMatch(r.motivo, /falta de estoque/);
  assert.strictEqual(escritas().length, 0);
  ok("aceite: pausado manualmente → ANUNCIO_NAO_ATIVO, zero POST");

  // encerrado.
  mlChamadas = [];
  mlHandler = ml({ item: itemML({ id: "MLB1", status: "closed" }), promos: [promoAceite] });
  r = await aceitar();
  assert.strictEqual(r.codigo, "ANUNCIO_NAO_ATIVO");
  assert.match(r.motivo, /closed/);
  assert.strictEqual(escritas().length, 0);
  ok("aceite: anúncio encerrado → ANUNCIO_NAO_ATIVO, zero POST");

  // ativo → participa.
  mlChamadas = [];
  mlHandler = ml({ item: itemML({ id: "MLB1", status: "active", available_quantity: 3 }), promos: [promoAceite] });
  r = await aceitar();
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(escritas().length, 1);
  ok("aceite: anúncio ativo participa normalmente (1 POST)");

  // 3. leitura falhou / status ausente → não bloqueia.
  for (const [rotulo, item] of [["leitura com erro", { ok: false, status: 500, data: null }], ["sem status", itemML({ id: "MLB1" })]]) {
    mlChamadas = [];
    mlHandler = ml({ item, promos: [promoAceite] });
    r = await aceitar();
    assert.strictEqual(r.ok, true, `${rotulo}: ${JSON.stringify(r)}`);
    assert.strictEqual(escritas().length, 1);
  }
  ok("aceite: falha de leitura ou status ausente não bloqueia (o ML decide)");

  // 1. POST de preço (DEAL candidate) em anúncio pausado → bloqueado.
  mlChamadas = [];
  mlHandler = ml({ item: itemML({ id: "MLB1", status: "paused", sub_status: ["out_of_stock"], available_quantity: 0 }), promos: [dealCandidata] });
  r = await aplicar("D-1");
  assert.strictEqual(r.codigo, "ANUNCIO_NAO_ATIVO");
  assert.strictEqual(escritas().length, 0);
  ok("preço (DEAL candidate): anúncio pausado → ANUNCIO_NAO_ATIVO, zero POST");

  // DEAL candidate em anúncio ativo → POST.
  mlChamadas = [];
  mlHandler = ml({ item: itemML({ id: "MLB1", status: "active" }), promos: [dealCandidata] });
  r = await aplicar("D-1");
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.metodo, "POST");
  ok("preço (DEAL candidate): anúncio ativo → POST");

  // 4. PUT numa participação existente não consulta nem é barrado pelo status.
  mlChamadas = [];
  mlHandler = ml({ item: itemML({ id: "MLB1", status: "paused" }), promos: [dealIniciada] });
  mlHandler = (c) => {
    if (/\/sale_price/.test(c.path)) return { ok: true, status: 200, data: { metadata: { promotion_id: "D-2" } } };
    return ml({ item: itemML({ id: "MLB1", status: "paused" }), promos: [dealIniciada] })(c);
  };
  r = await aplicar("D-2");
  assert.ok(!(r.codigo === "ANUNCIO_NAO_ATIVO"), "alterar participação existente não é barrado pelo status do anúncio");
  assert.ok(!mlChamadas.some((c) => /^\/items\/[^/?]+\?attributes=/.test(c.path)), "PUT não consulta o status do item");
  assert.ok(mlChamadas.some((c) => c.metodo === "PUT"), "o PUT foi enviado");
  ok("alterar (PUT) participação existente não depende do status do anúncio");

  // 5. sync "novos" rebusca os não ativos já gravados.
  anunciosService.ensureSchema = async () => {};
  anunciosService.resolverContextoConta = async () => ({ mlUserId: "111", contaId: 9 });
  anunciosService.itemIdsExistentes = async () => new Set(["MLB1", "MLB2", "MLB3"]);
  anunciosService.itemIdsNaoAtivos = async () => new Set(["MLB2"]);
  let salvos = [];
  anunciosService.upsertAnuncios = async (regs) => { salvos = regs; return regs.length; };
  familiaService.registrarUserProducts = async () => 0;
  mlChamadas = [];
  mlHandler = (c) => {
    if (/search_type=scan/.test(c.path)) return { ok: true, status: 200, data: { results: c.path.includes("scroll_id") ? [] : ["MLB1", "MLB2", "MLB3", "MLB4"], scroll_id: c.path.includes("scroll_id") ? null : "s1" } };
    const ids = decodeURIComponent(c.path.split("ids=")[1]).split(",");
    return { ok: true, status: 200, data: ids.map((id) => ({ code: 200, body: { id, title: "t", status: "active", available_quantity: 4, attributes: [], pictures: [] } })) };
  };
  const sync = await syncService.sincronizar({ clienteId: 30, clienteSlug: "dm1", modo: "novos" });
  assert.strictEqual(sync.ok, true);
  assert.deepStrictEqual(salvos.map((s) => s.item_id).sort(), ["MLB2", "MLB4"]);
  assert.strictEqual(salvos.find((s) => s.item_id === "MLB2").status, "active");
  ok('sync "novos": traz o anúncio novo (MLB4) e rebusca o não ativo já gravado (MLB2); ativos intactos');

  // atualizarItensConhecidos: só itens que o portal já tem.
  anunciosService.contextoDosItens = async () => [{ cliente_id: 30, cliente_slug: "dm1", cliente_conta_id: 9, ml_user_id: "111", item_id: "MLB2" }];
  salvos = [];
  mlChamadas = [];
  const up = await syncService.atualizarItensConhecidos({ clienteId: 30, itemIds: ["MLB2", "MLB999", "../x"] });
  assert.strictEqual(up.atualizados, 1);
  assert.deepStrictEqual(salvos.map((s) => s.item_id), ["MLB2"]);
  assert.strictEqual(mlChamadas.length, 1);
  assert.ok(!mlChamadas[0].path.includes("../x"));
  ok("atualizarItensConhecidos: relê só o que o portal já tem; id fora do formato é descartado");

  // 6. webhook.
  assert.strictEqual(itemIdDaNotificacao({ topic: "items", resource: "/items/MLB123", userId: 111 }), "MLB123");
  for (const n of [
    { topic: "orders_v2", resource: "/orders/1", userId: 1 },
    { topic: "items", resource: "https://evil/items/MLB1", userId: 1 },
    { topic: "items", resource: "/items/MLB1/../x", userId: 1 },
    { topic: "items", resource: "/items/MLB1", userId: null },
  ]) assert.strictEqual(itemIdDaNotificacao(n), null);
  ok("webhook: só topic items com /items/MLB… e user_id viram atualização");

  const chamadas = [];
  const deps = (t) => ({ atualizarItem: async (a) => { chamadas.push(a); }, agora: () => t });
  await processarNotificacao({ topic: "items", resource: "/items/MLB77", userId: 111 }, deps(1000));
  await processarNotificacao({ topic: "items", resource: "/items/MLB77", userId: 111 }, deps(2000)); // dentro da janela
  await processarNotificacao({ topic: "items", resource: "/items/MLB77", userId: 111 }, deps(9000)); // fora da janela
  await processarNotificacao({ topic: "orders_v2", resource: "/orders/5", userId: 111 }, deps(9000));
  assert.deepStrictEqual(chamadas, [{ itemId: "MLB77", mlUserId: "111" }, { itemId: "MLB77", mlUserId: "111" }]);
  ok("webhook: debounce por item; orders_v2 não dispara atualização");

  const erro = console.error;
  let logado = false;
  console.error = () => { logado = true; };
  await processarNotificacao({ topic: "items", resource: "/items/MLB88", userId: 111 }, { atualizarItem: async () => { throw new Error("boom"); }, agora: () => 50000 });
  console.error = erro;
  assert.ok(logado);
  ok("webhook: falha na atualização é registrada e não propaga");
}

run()
  .then(() => { console.log(`\n✓ ${checks} verificações de status ativo × promoção e atualização por webhook`); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
