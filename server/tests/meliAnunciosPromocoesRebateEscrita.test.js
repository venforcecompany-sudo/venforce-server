// server/tests/meliAnunciosPromocoesRebateEscrita.test.js
//
// "Promoções com rebate" — escrita REAL (participarPromocaoAceite) com o
// gancho opcional `antesDeEscrever`, e o mlFetch trocado por um stub.
//
//  1. sem o gancho, participar continua idêntico (POST com offer_id);
//  2. o gancho recebe a promoção E a lista relidas ao vivo, antes do POST;
//  3. a revalidação do rebate bloqueia sem enviar nada quando a referência
//     saiu, o preço da candidata deixou de ser menor ou ficou abaixo de
//     R$ 19,00 (o comprador perderia o frete grátis);
//  4. a referência nunca recebe PUT/DELETE/POST.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const Module = require("module");

let mlChamadas = [];
let promosAoVivo = [];

const originalLoad = Module._load;
Module._load = function loadWithMlFetchStub(request, parent, isMain) {
  if (request === "../../utils/mlClient" || request === "../utils/mlClient") {
    return {
      async mlFetch(clienteId, path, options = {}) {
        const c = { path, metodo: options.method || "GET", body: options.body ? JSON.parse(options.body) : null };
        mlChamadas.push(c);
        if (/\/sale_price/.test(path)) return { ok: true, status: 200, data: {} };
        if (/\/seller-promotions\/promotions\//.test(path)) return { ok: false, status: 404, data: {} };
        if (c.metodo === "GET") return { ok: true, status: 200, data: promosAoVivo };
        return { ok: true, status: 201, data: { price: 95 } };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { participarPromocaoAceite } = require("../services/meliAnuncios/meliPromocoesEscritaService");
const { listarPromocoesDoItemDetalhado, listarPromocoesDoItem } = require("../services/meliAnuncios/meliPromocoesService");
const { criarRevalidacao } = require("../services/meliAnuncios/meliPromocoesRebateService");
Module._load = originalLoad;

let checks = 0;
function ok(msg) { checks += 1; console.log(`  ✓ ${msg}`); }

const REF = { id: "C-MLB1", tipo: "SELLER_CAMPAIGN" };
const refBruta = (price = 100) => ({ id: "C-MLB1", type: "SELLER_CAMPAIGN", status: "started", price, original_price: 120, name: "Vendex - Outubro" });
const smartBruta = { id: "P-S", type: "SMART", status: "candidate", ref_id: "CANDIDATE-MLB1-1", original_price: 100, meli_percentage: 5, seller_percentage: 0 };
const escritas = () => mlChamadas.filter((c) => c.metodo !== "GET");

async function run() {
  // 1. Sem gancho: comportamento de antes.
  mlChamadas = [];
  promosAoVivo = [refBruta(), smartBruta];
  let r = await participarPromocaoAceite({ clienteId: 1, itemId: "MLB1", mlUserId: "111", promotionId: "P-S", tipo: "SMART" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.precoConfirmado, 95);
  assert.deepStrictEqual(escritas().map((c) => [c.metodo, c.body]), [["POST", { promotion_id: "P-S", promotion_type: "SMART", offer_id: "CANDIDATE-MLB1-1" }]]);
  ok("sem antesDeEscrever: POST idêntico ao de antes");

  // 2. Gancho recebe promo + lista relidas.
  mlChamadas = [];
  let recebido = null;
  r = await participarPromocaoAceite({
    clienteId: 1, itemId: "MLB1", mlUserId: "111", promotionId: "P-S", tipo: "SMART",
    antesDeEscrever: (arg) => { recebido = arg; return { ok: false, codigo: "X", motivo: "bloqueado" }; },
  });
  assert.deepStrictEqual(r, { ok: false, codigo: "X", motivo: "bloqueado" });
  assert.strictEqual(recebido.promo.id, "P-S");
  assert.strictEqual(recebido.acao, "PARTICIPAR");
  assert.ok(recebido.lista.some((p) => p.id === "C-MLB1"), "a lista relida inteira chega ao gancho");
  assert.strictEqual(escritas().length, 0, "gancho recusou: nada enviado");
  ok("antesDeEscrever recebe promo+lista e bloqueia antes do POST");

  // 3. Revalidação real do rebate.
  mlChamadas = [];
  r = await participarPromocaoAceite({ clienteId: 1, itemId: "MLB1", mlUserId: "111", promotionId: "P-S", tipo: "SMART", antesDeEscrever: criarRevalidacao(REF) });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(escritas().length, 1);

  mlChamadas = [];
  promosAoVivo = [refBruta(95), smartBruta];
  r = await participarPromocaoAceite({ clienteId: 1, itemId: "MLB1", mlUserId: "111", promotionId: "P-S", tipo: "SMART", antesDeEscrever: criarRevalidacao(REF) });
  assert.strictEqual(r.codigo, "PRECO_NAO_MENOR");
  assert.strictEqual(escritas().length, 0, "preço deixou de ser menor: nada enviado");

  mlChamadas = [];
  promosAoVivo = [{ ...refBruta(), status: "pending" }, smartBruta];
  r = await participarPromocaoAceite({ clienteId: 1, itemId: "MLB1", mlUserId: "111", promotionId: "P-S", tipo: "SMART", antesDeEscrever: criarRevalidacao(REF) });
  assert.strictEqual(r.codigo, "REFERENCIA_INATIVA");
  assert.strictEqual(escritas().length, 0);

  // Abaixo de R$ 19,00 o comprador perde o frete grátis: recusa na escrita real.
  mlChamadas = [];
  promosAoVivo = [refBruta(100), { ...smartBruta, suggested_discounted_price: 18.9 }];
  r = await participarPromocaoAceite({ clienteId: 1, itemId: "MLB1", mlUserId: "111", promotionId: "P-S", tipo: "SMART", antesDeEscrever: criarRevalidacao(REF) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.codigo, "ABAIXO_FRETE_GRATIS");
  assert.ok(/R\$ 18,90/.test(r.motivo), "preço formatado em reais com vírgula");
  assert.strictEqual(escritas().length, 0, "abaixo de R$ 19,00: nada enviado");
  ok("revalidação: referência inativa ou preço não menor bloqueiam sem enviar");

  // 4. Nunca uma escrita na referência.
  assert.ok(mlChamadas.every((c) => c.metodo === "GET" || (c.body && c.body.promotion_id !== "C-MLB1")));
  ok("referência nunca recebe escrita");

  // listarPromocoesDoItemDetalhado: falha do ML não é engolida; a versão antiga segue igual.
  promosAoVivo = [refBruta()];
  const det = await listarPromocoesDoItemDetalhado({ clienteId: 1, itemId: "MLB1", mlUserId: "111" });
  assert.strictEqual(det.ok, true);
  assert.strictEqual(det.promocoes.length, 1);
  assert.strictEqual((await listarPromocoesDoItem({ clienteId: 1, itemId: "MLB1", mlUserId: "111" })).length, 1);
  ok("listarPromocoesDoItemDetalhado devolve ok+lista; listarPromocoesDoItem inalterada");

  // 5. Relâmpago cofinanciada: só o radar escreve (permitirComEstoque) e o stock vai no POST.
  const luz = { id: "P-L", type: "SMART_LIGHTNING", status: "candidate", ref_id: "CANDIDATE-MLB1-9", original_price: 100, meli_percentage: 5, seller_percentage: 0, stock: { min: 5, max: 50 } };
  const base = { clienteId: 1, itemId: "MLB1", mlUserId: "111", promotionId: "P-L", tipo: "SMART_LIGHTNING" };
  mlChamadas = [];
  promosAoVivo = [luz];
  r = await participarPromocaoAceite(base);
  assert.strictEqual(r.codigo, "TIPO_SEM_ACEITE", "Central/Anúncios continuam sem escrever na relâmpago");
  r = await participarPromocaoAceite({ ...base, permitirComEstoque: true });
  assert.strictEqual(r.codigo, "ESTOQUE_OBRIGATORIO");
  r = await participarPromocaoAceite({ ...base, permitirComEstoque: true, estoque: 4 });
  assert.strictEqual(r.codigo, "ESTOQUE_FORA_DA_FAIXA");
  assert.strictEqual(escritas().length, 0, "estoque ausente ou fora da faixa: nada enviado");
  r = await participarPromocaoAceite({ ...base, permitirComEstoque: true, estoque: 20 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.estoque, 20);
  assert.deepStrictEqual(escritas().map((c) => c.body), [{ promotion_id: "P-L", promotion_type: "SMART_LIGHTNING", offer_id: "CANDIDATE-MLB1-9", stock: 20 }]);
  promosAoVivo = [{ ...luz, stock: undefined }];
  r = await participarPromocaoAceite({ ...base, permitirComEstoque: true, estoque: 20 });
  assert.strictEqual(r.codigo, "ESTOQUE_SEM_FAIXA");
  ok("relâmpago cofinanciada: stock obrigatório dentro da faixa, só com permitirComEstoque");

  console.log(`\nmeliAnunciosPromocoesRebateEscrita.test.js: ${checks} verificações passaram.`);
}

run().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
