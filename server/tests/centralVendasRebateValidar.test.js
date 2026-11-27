// server/tests/centralVendasRebateValidar.test.js
//
// Núcleo da validação real do rebate (scripts/central-vendas-rebate-validar.js)
// com um ML FALSO: ordem e teto das chamadas, parada em 429 (inclusive embrulhado
// em 400), /discounts só onde há desconto, composição pela mesma função do motor e
// as conferências (invariantes anti-dupla-contagem, tarifa da Central × pedido).
const test = require("node:test");
const assert = require("node:assert/strict");
const { validar, planejarChamadas, lerPedidos } = require("../scripts/central-vendas-rebate-validar");

const SELLER = 9001;
const CONTA = { clienteContaId: 41, sellerId: SELLER };
const order = (id, itens) => ({ id: Number(id), status: "paid", seller: { id: SELLER }, currency_id: "BRL", order_items: itens, payments: [{ id: 7000 + Number(id) % 100, status: "approved" }] });
const ORDERS = {
  5000001: order(5000001, [{ item: { id: "MLB100" }, quantity: 1, unit_price: 57.54, sale_fee: 5.47, gross_price: 78 }]),
  5000002: order(5000002, [{ item: { id: "MLB200" }, quantity: 1, unit_price: 54, sale_fee: 6.21, gross_price: 54 }]),
  5000003: order(5000003, [{ item: { id: "MLB300" }, quantity: 2, unit_price: 52, sale_fee: 5, gross_price: 159.8 }]),
};
const cob = (pid, item, sub, v) => ({ charge_info: { detail_id: Number(`${pid % 1000}${sub.length}${Math.round(v * 100)}`), detail_amount: v, detail_type: "CHARGE", detail_sub_type: sub, status: null, charge_bonified_id: null, legal_document_status: "PROCESSED" },
  sales_info: [{ order_id: pid }], items_info: [{ item_id: item, order_id: pid }], marketplace_info: { marketplace: "CORE" } });
const BILLING = [
  { order_id: 5000001, payment_info: [{ payment_id: 7001, status: "approved" }], sale_fee: { gross: 6.62, net: 5.47, rebate: 1.15, discount: 0 }, details: [cob(5000001, "MLB100", "CVVML", 5.42), cob(5000001, "MLB100", "CVVPRC", 0.05)] },
  { order_id: 5000002, payment_info: [{ payment_id: 7002, status: "approved" }], sale_fee: { gross: 6.21, net: 6.21, rebate: 0, discount: 0 }, details: [cob(5000002, "MLB200", "CVVML", 6.16), cob(5000002, "MLB200", "CVVPRC", 0.05)] },
  { order_id: 5000003, payment_info: [{ payment_id: 7003, status: "approved" }], sale_fee: { gross: 10, net: 10, rebate: 0, discount: 0 }, details: [cob(5000003, "MLB300", "CVVML", 10)] },
];
const DISCOUNTS = {
  5000001: { details: [{ type: "discount", supplier: { funding_mode: "sale_fee" }, items: [{ id: "MLB100", quantity: 1, amounts: { total: 20.46, seller: 19.31 } }] }] },
  5000003: { details: [{ type: "discount", supplier: { funding_mode: "seller" }, items: [{ id: "MLB300", quantity: 2, amounts: { total: 55.8, seller: 55.8 } }] }] },
};
function fakeMl({ billingResp = null } = {}) {
  const chamadas = [];
  const fetchMl = async (path) => {
    chamadas.push(path);
    let m;
    if ((m = /^\/orders\/(\d+)$/.exec(path))) return ORDERS[m[1]] ? { status: 200, data: ORDERS[m[1]] } : { status: 404, data: null };
    if ((m = /^\/orders\/(\d+)\/discounts$/.exec(path))) return DISCOUNTS[m[1]] ? { status: 200, data: DISCOUNTS[m[1]] } : { status: 404, data: null };
    if (/^\/billing\/integration\/group\/ML\/order\/details\?order_ids=/.test(path)) {
      if (billingResp) return billingResp;
      const ids = path.split("=")[1].split(",");
      return { status: 200, data: { results: BILLING.filter((b) => ids.includes(String(b.order_id))), errors: [] } };
    }
    throw new Error(`chamada inesperada ${path}`);
  };
  return { fetchMl, chamadas };
}

test("caminho completo: ordem das chamadas, discounts só onde há desconto, rebate comprovado sem dupla contagem", async () => {
  const { fetchMl, chamadas } = fakeMl();
  const tarifas = new Map([["5000001", 547], ["5000002", 600], ["5000003", 1000]]);
  const r = await validar({ conta: CONTA, pedidoIds: ["5000001", "5000002", "5000003"], maxChamadas: 10, fetchMl, tarifasCentral: tarifas });
  assert.deepEqual(chamadas, [
    "/orders/5000001", "/orders/5000002", "/orders/5000003",
    "/billing/integration/group/ML/order/details?order_ids=5000001,5000002,5000003",
    "/orders/5000001/discounts", "/orders/5000003/discounts",
  ]);
  assert.deepEqual(r.chamadas, { orders: 3, billing: 1, discounts: 2, total: 6, maximo: 10 });
  assert.equal(r.parada, null);
  const [p1, p2, p3] = r.pedidos;
  assert.equal(p1.estado, "CONCILIADO");
  assert.equal(p1.natureza, "liquida_comprovada");
  assert.equal(p1.rebate.centavos, 115);
  assert.equal(p1.rebateIncorporado, "comprovado");
  assert.equal(p1.credito.centavos, 0);
  assert.equal(p1.tarifaCentralXPedido, "igual");
  assert.equal(p2.tarifaCentralXPedido, "difere", "tarifa gravada na Central (6,00) ≠ sale_fee atual (6,21)");
  assert.equal(p3.estado, "PARCIAL", "quantidade 2 fica fora do escopo validado");
  assert.equal(p3.vendedor.centavos, 5580);
  assert.ok(r.resumo.invariantesOk);
  assert.deepEqual(r.resumo.tarifaCentralDifere, ["5000002"]);
  assert.equal(r.resumo.rebateIncorporadoComprovadoCentavos, 115);
  assert.equal(r.resumo.creditoComprovadoCentavos, 0);
});

test("orçamento: nunca passa do teto; o que não coube fica 'não consultado'", async () => {
  const { fetchMl, chamadas } = fakeMl();
  const r = await validar({ conta: CONTA, pedidoIds: ["5000001", "5000002", "5000003"], maxChamadas: 2, fetchMl });
  assert.equal(chamadas.length, 2);
  assert.equal(r.parada, "orcamento");
  assert.equal(r.pedidos[2].consultado, false);
  assert.equal(r.pedidos[0].fontes.billing, "nao_consultado");
  assert.equal(r.pedidos[0].credito.centavos, null, "sem Billing nada é comprovado");
});

test("429 embrulhado em 400 no Billing: para tudo, nenhuma chamada depois", async () => {
  const { fetchMl, chamadas } = fakeMl({ billingResp: { status: 400, data: { status: 400, message: "Http status error with code 429" } } });
  const r = await validar({ conta: CONTA, pedidoIds: ["5000001", "5000003"], maxChamadas: 10, fetchMl });
  assert.equal(r.parada, "limite");
  assert.equal(chamadas.length, 3, "2 orders + 1 billing; nenhum /discounts depois do 429");
  assert.equal(r.pedidos[0].credito.centavos, null);
});

test("pedido inexistente vira falha registrada; planejamento e validação dos ids", async () => {
  const { fetchMl } = fakeMl();
  const r = await validar({ conta: CONTA, pedidoIds: ["5000009"], maxChamadas: 3, fetchMl });
  assert.deepEqual(r.pedidos[0], { pedidoId: "5000009", consultado: false, motivo: "orders_nao_encontrado" });
  assert.deepEqual(planejarChamadas(["1", "2"]), { orders: 2, billing: 1, discountsNoMaximo: 2, totalNoMaximo: 5 });
  assert.equal(lerPedidos("1,2,abc"), null);
  assert.equal(lerPedidos(Array.from({ length: 21 }, (_, i) => i + 1).join(",")), null);
  assert.deepEqual(lerPedidos("10,10,11"), ["10", "11"]);
});
