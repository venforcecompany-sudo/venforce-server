// server/tests/centralVendasReembolsoParcialInvestigar.test.js
//
// Investigador do reembolso parcial (scripts/central-vendas-reembolso-parcial-investigar.js),
// com ML/MP falsos: orçamento, parada em limite/token, projeção sem dado de
// comprador e o que a evidência permite concluir (nada inferido de ausência).
process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/teste-sem-banco";
const test = require("node:test");
const assert = require("node:assert/strict");
const s = require("../scripts/central-vendas-reembolso-parcial-investigar");

const ORDER = {
  id: 9001, status: "paid", tags: ["paid"], total_amount: 176.48, paid_amount: 176.48, pack_id: null, shipping: { id: 77 },
  buyer: { id: 1, nickname: "COMPRADOR", first_name: "Fulano" },
  order_items: [{ item: { id: "MLB1", variation_id: 5 }, quantity: 1, unit_price: 176.48, full_unit_price: 189.9, sale_fee: 21.18, listing_type_id: "gold_special" }],
  payments: [{ id: 555, status: "approved", transaction_amount: 176.48, transaction_amount_refunded: 12.35, shipping_cost: 0, payer_id: 1 }],
};
const PAYMENT = { status: "approved", transaction_amount: 176.48, transaction_amount_refunded: 12.35, payer: { email: "x@y.z" },
  refunds: [{ id: 1, amount: 12.35, status: "approved", source: { id: "123", name: "loja", type: "collector" }, date_created: "2026-11-02" }],
  charges_details: [{ name: "meli_fee", type: "fee", accounts: { from: "collector", to: "marketplace_owner" }, amounts: { original: 21.18, refunded: 1.48 } }] };
const BILLING = { results: [{ order_id: "9001", sale_fee: { gross: 21.18, net: 19.7, rebate: 0, discount: 0 }, details: [] }] };

function falso(rotas, chamadas) {
  return async (path) => {
    chamadas.push(path);
    for (const [prefixo, resp] of rotas) if (path.startsWith(prefixo)) return typeof resp === "function" ? resp() : resp;
    return { status: 404, data: {} };
  };
}

test("um pedido: Orders, Payment com devolução, Claims, Shipment e Billing em lote; conclusões com evidência", async () => {
  const ch = [];
  const ml = falso([["/orders/9001", { status: 200, data: ORDER }], ["/post-purchase", { status: 200, data: { data: [] } }],
    ["/shipments/77", { status: 200, data: { logistic_type: "fulfillment", status: "delivered", tags: [] } }], ["/billing", { status: 200, data: BILLING }]], ch);
  const mp = falso([["/v1/payments/555", { status: 200, data: PAYMENT }]], ch);
  const central = new Map([["9001", { status: "partially_refunded", resultadoCentavos: 771, componentesCentavos: {}, reembolsoCentavos: 1235 }]]);
  const r = await s.investigar({ conta: { clienteContaId: 248 }, pedidoIds: ["9001"], maxChamadas: 10, fetchMl: ml, fetchMp: mp, central });
  assert.deepEqual(r.chamadas, { orders: 1, payments: 1, claims: 1, shipments: 1, billing: 1, total: 5, maximo: 10 });
  const p = r.pedidos[0];
  assert.equal(p.conclusao.devolvidoAoCompradorCentavos, 1235);
  assert.equal(p.conclusao.conferenciaReembolso, "igual");
  assert.deepEqual(p.conclusao.quemBancou, ["collector"]);
  assert.equal(p.conclusao.comissaoEstornada, "parcial_ou_total", "billing net 19,70 < sale_fee 21,18");
  assert.equal(p.conclusao.logistica, "fulfillment");
  assert.deepEqual(p.conclusao.claim, ["nenhum"]);
  const texto = JSON.stringify(r);
  assert.ok(!/COMPRADOR|Fulano|x@y\.z|payer/.test(texto), "nada de comprador no relatório");
});

test("sem informação de quem bancou ⇒ 'nao_informado_pela_api' (nunca assume vendedor)", () => {
  const c = s.concluir({ order: s.projetarOrder(ORDER), pagamentos: [{ refunds: [{ amount: 12.35 }] }], claims: [], shipment: null, billing: [], central: null });
  assert.deepEqual(c.quemBancou, ["nao_informado_pela_api"]);
  assert.equal(c.comissaoEstornada, "desconhecido");
  assert.equal(c.mercadoriaVoltou, "desconhecido");
  assert.equal(c.conferenciaReembolso, "desconhecido");
});

test("para no 1º limite (429 embrulhado em 400) e não chama mais nada", async () => {
  const ch = [];
  const ml = falso([["/orders/1", { status: 400, data: { message: "Http status error with code 429" } }]], ch);
  const r = await s.investigar({ conta: { clienteContaId: 1 }, pedidoIds: ["1", "2", "3"], maxChamadas: 30, fetchMl: ml, fetchMp: ml });
  assert.equal(r.parada, "limite");
  assert.equal(ch.length, 1);
});

test("orçamento: nunca passa do máximo", async () => {
  const ch = [];
  const ml = falso([["/orders/", { status: 200, data: ORDER }], ["/post-purchase", { status: 200, data: { data: [] } }], ["/shipments", { status: 200, data: {} }]], ch);
  const mp = falso([["/v1/payments", { status: 200, data: PAYMENT }]], ch);
  const r = await s.investigar({ conta: { clienteContaId: 1 }, pedidoIds: ["1", "2", "3"], maxChamadas: 6, fetchMl: ml, fetchMp: mp });
  assert.equal(ch.length, 6);
  assert.equal(r.parada, "orcamento");
});
