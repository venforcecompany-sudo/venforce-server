"use strict";

const assert = require("assert");
const Module = require("module");
const itemId = "MLB4901811987";
const campaignId = "P-MLB18211012";
const offerId = "OFFER-MLB4901811987-14374790821";
const args = { clienteId: 133, itemId, mlUserId: "1587129755" };
let chamadas = [];
let lista;
let oferta;
let sale;
let falhaOferta;
let itensCampanha;
let falhaCampanha;

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "../../utils/mlClient") return { async mlFetch(clienteId, path, options = {}) {
    chamadas.push({ clienteId, path, ...options });
    if (options.method === "DELETE") return { ok: true, data: null };
    if (path.includes("/sale_price")) return { ok: true, data: sale };
    if (path.includes("/promotions/") && path.includes("/items?")) {
      if (falhaCampanha === "throw") throw new Error("rede indisponível");
      return falhaCampanha ? { ok: false, status: 429 } : { ok: true, data: { results: itensCampanha } };
    }
    if (path.includes("/offers/")) {
      if (falhaOferta === "throw") throw new Error("rede indisponível");
      return falhaOferta ? { ok: false, status: 404 } : { ok: true, data: oferta };
    }
    if (path.includes("/promotions/")) return { ok: true, data: {
      name: "Queima estoque", start_date: "2026-11-01T03:00:00Z", finish_date: "2026-12-01T02:00:00Z",
    } };
    return { ok: true, data: lista };
  } };
  if (request === "../automacoes/promocoesRetornoService") return { escolherPromocao: (ps) => ps[0] };
  if (request === "./meliConteudoService") return { codigoDoErroMl: () => "ERRO_ML", motivoDoErroMl: () => "Erro ML" };
  return originalLoad.call(this, request, parent, isMain);
};
const service = require("../services/meliAnuncios/meliPromocoesService");
const escrita = require("../services/meliAnuncios/meliPromocoesEscritaService");
Module._load = originalLoad;

function reset() {
  chamadas = [];
  falhaOferta = null;
  itensCampanha = [];
  falhaCampanha = null;
  lista = [{ id: campaignId, type: "SMART", ref_id: "CANDIDATE-MLB4901811987-77689780532",
    status: "candidate", price: 97, original_price: 139.99, name: "Queima estoque",
    meli_percentage: 4.6, seller_percentage: 26.1 }];
  oferta = { id: offerId, item_id: itemId, promotion_id: campaignId, type: "SMART", status: { id: "started" } };
  sale = { amount: 97, regular_amount: 139.99, metadata: { promotion_id: offerId, campaign_id: campaignId } };
}

async function run() {
  reset();
  const candidatasOriginais = JSON.stringify(lista);
  let ps = await service.listarPromocoesDoItem(args);
  assert.strictEqual(ps.length, 1, "substitui a candidatura da mesma campanha sem duplicar a linha");
  assert.strictEqual(ps[0].nome, "Queima estoque");
  assert.strictEqual(ps[0].status, "started");
  assert.strictEqual(ps[0].statusExibicao, "ATIVA");
  assert.strictEqual(ps[0].precoFinal, 97, "preço exato do sale_price, sem derivar dos percentuais arredondados");
  assert.strictEqual(ps[0].precoOriginal, 139.99);
  assert.strictEqual(ps[0].refId, offerId);
  assert.strictEqual(ps[0].modoEscrita, "ACEITE");
  assert.strictEqual(ps[0].subsidioMl, null, "não atribui o subsídio de uma nova candidatura à oferta antiga");
  assert.strictEqual(JSON.stringify(lista), candidatasOriginais, "não altera a resposta original");
  assert.ok(chamadas.every((c) => c.mlUserId === args.mlUserId && c.clienteId === args.clienteId && !c.method));

  reset();
  lista = [];
  ps = await service.listarPromocoesDoItem(args);
  assert.strictEqual(ps[0].id, campaignId, "recupera promoção ausente da listagem");
  assert.strictEqual(ps[0].nome, "Queima estoque", "recupera nome pelo detalhe da campanha");
  assert.strictEqual(ps[0].statusExibicao, "ATIVA");

  for (const alterar of [
    () => { oferta.item_id = "MLB-OUTRO"; },
    () => { oferta.id = "OFFER-OUTRA"; },
    () => { oferta.status.id = "finished"; },
    () => { oferta.status.id = "candidate"; },
    () => { oferta.promotion_id = "OUTRA-CAMPANHA"; },
    () => { falhaOferta = "404"; },
    () => { falhaOferta = "throw"; },
  ]) {
    reset(); alterar();
    ps = await service.listarPromocoesDoItem(args);
    assert.strictEqual(ps.length, 1);
    assert.strictEqual(ps[0].status, "candidate", "sem confirmação mantém candidatura original");
    assert.strictEqual(ps[0].statusExibicao, "ELEGÍVEL");
  }

  reset();
  lista[0] = { ...lista[0], status: "started", ref_id: offerId };
  await service.listarPromocoesDoItem(args);
  assert.ok(!chamadas.some((c) => c.path.includes("/offers/")), "sem leitura adicional se já reconhece a oferta");
  reset();
  lista[0] = { ...lista[0], status: "started", ref_id: undefined, offer_id: offerId };
  ps = await service.listarPromocoesDoItem(args);
  assert.strictEqual(ps[0].statusExibicao, "ATIVA", "aceita offer_id além de ref_id");
  assert.ok(!chamadas.some((c) => c.path.includes("/offers/")));
  reset();
  sale.metadata = {};
  await service.listarPromocoesDoItem(args);
  assert.ok(!chamadas.some((c) => c.path.includes("/offers/")), "sem identificador não faz suposição por preço");

  reset();
  oferta.meli_percentage = 2;
  const rebate = await service.obterRebatePromocaoAtiva(args);
  assert.strictEqual(rebate.promocao.id, campaignId);
  assert.strictEqual(rebate.rebate, 2.8, "usa apenas percentual confirmado da oferta ativa");

  // Depois do aceite, /items pode continuar mostrando uma candidatura e
  // /offers só identifica a oferta. O subsídio vem dos itens da campanha.
  for (const jaReconhecida of [false, true]) {
    reset();
    if (jaReconhecida) lista[0] = { ...lista[0], status: "started", ref_id: offerId, meli_percentage: null, original_price: null };
    itensCampanha = [{ id: itemId, offer_id: offerId, status: "started", price: 97,
      original_price: 139.99, meli_percentage: 2, seller_percentage: 28.7 }];
    ps = await service.listarPromocoesDoItem(args);
    assert.strictEqual(ps[0].subsidioMl, 2.8, "recupera subsídio da mesma oferta após ativação");
    assert.strictEqual(ps[0].precoFinal, 97);
    assert.strictEqual(ps[0].statusExibicao, "ATIVA");
    const atual = await service.obterRebatePromocaoAtiva(args);
    assert.strictEqual(atual.rebate, 2.8, "composição e tabela usam o mesmo subsídio");
    assert.ok(chamadas.every((c) => c.mlUserId === args.mlUserId && c.clienteId === args.clienteId && !c.method));
  }

  for (const alterar of [
    () => { itensCampanha[0].offer_id = "CANDIDATE-NOVA"; },
    () => { itensCampanha[0].id = "MLB-OUTRO"; },
    () => { itensCampanha[0].status = "candidate"; },
    () => { itensCampanha[0].status = "finished"; },
    () => { falhaCampanha = "429"; },
    () => { falhaCampanha = "throw"; },
  ]) {
    reset();
    itensCampanha = [{ id: itemId, offer_id: offerId, status: "started", original_price: 139.99, meli_percentage: 2 }];
    alterar();
    ps = await service.listarPromocoesDoItem(args);
    assert.strictEqual(ps[0].subsidioMl, null, "não inventa subsídio nem usa outra oferta em falha");
    assert.strictEqual(ps[0].statusExibicao, "ATIVA");
  }

  reset();
  lista[0] = { ...lista[0], status: "started", ref_id: offerId, meli_percentage: 0 };
  ps = await service.listarPromocoesDoItem(args);
  assert.strictEqual(ps[0].subsidioMl, 0, "zero explícito é preservado");
  assert.ok(!chamadas.some((c) => c.path.includes("/items?promotion_type=")), "não consulta subsídio já informado");

  reset();
  const r = await escrita.sairPromocao({ ...args, promotionId: campaignId, tipo: "SMART" });
  assert.strictEqual(r.ok, true);
  const deletes = chamadas.filter((c) => c.method === "DELETE");
  assert.strictEqual(deletes.length, 1);
  assert.ok(deletes[0].path.includes(`offer_id=${offerId}`), "saída usa a oferta ativa confirmada");
  assert.ok(!deletes[0].path.includes("CANDIDATE"));

  reset();
  const participar = await escrita.participarPromocaoAceite({ ...args, promotionId: campaignId, tipo: "SMART" });
  assert.strictEqual(participar.codigo, "PROMOCAO_JA_PARTICIPA", "não reinscreve promoção recuperada como ativa");
  assert.ok(!chamadas.some((c) => c.method));
  console.log("meliPromocoesOfertaAtiva: recuperação, isolamento, falhas, rebate e saída passaram");
}
run().catch((err) => { console.error(err); process.exitCode = 1; });
