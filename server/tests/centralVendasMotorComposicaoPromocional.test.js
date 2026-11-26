// server/tests/centralVendasMotorComposicaoPromocional.test.js
//
// Motor + composição promocional (flag CENTRAL_VENDAS_COMPOSICAO_PROMOCIONAL):
//   · desligada ⇒ saída do motor IDÊNTICA à de antes (deepEqual);
//   · ligada ⇒ só ACRESCENTA componentes informativos (fora do resultado) e a
//     variação do item; nenhum resultado, pendência, confiança ou total muda;
//   · com Discounts + Billing de um pedido ⇒ composição comprovada, rebate já na
//     comissão, crédito 0; estado e divergências ficam no pedido;
//   · falha do compositor nunca derruba o import.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMotorFromOrders, buildCostMap } = require("../services/centralVendas/centralVendasSyncService");
const { classificarComponenteFinanceiro } = require("../services/centralVendas/centralVendasComponenteLedger");
const cp = require("../services/centralVendas/centralVendasComposicaoPromocional");
const cc = require("../services/centralVendas/centralVendasComponentesCompactos");

const SELLER = 9001;
const costMap = buildCostMap([
  { produto_id: "MLB100", custo_produto: 20, imposto_percentual: 6 },
  { produto_id: "MLB200", custo_produto: 10, imposto_percentual: 6 },
]);
const pedido = (id, itens, o = {}) => ({
  id, status: "paid", seller: { id: SELLER }, pack_id: null, currency_id: "BRL", date_created: "2026-11-10T10:00:00.000-03:00",
  shipping: { id: `S${id}`, logistic_type: "cross_docking" }, payments: [{ id: 7000 + Number(String(id).slice(-2)), status: "approved" }],
  order_items: itens, ...o,
});
const item = (mlb, { q = 1, unit, fee, gross = null, variacao = null }) => ({
  item: { id: mlb, seller_sku: `SKU-${mlb}`, title: mlb, variation_id: variacao }, quantity: q, unit_price: unit, sale_fee: fee, gross_price: gross, currency_id: "BRL",
});
const orders = [
  pedido(5000001, [item("MLB100", { unit: 57.54, fee: 5.47, gross: 78, variacao: 1234567 })]),
  pedido(5000002, [item("MLB100", { unit: 60, fee: 7.2, gross: 60 }), item("MLB200", { q: 2, unit: 30, fee: 3.6, gross: 60 })]),
  pedido(5000003, [item("MLB200", { unit: 25, fee: 3, gross: 30 })], { status: "cancelled" }),
];
const freteMap = new Map([["S5000001", { status: "real", valor: 10, receitaComprador: 0 }], ["S5000002", { status: "real", valor: 12, receitaComprador: 5 }]]);
const base = { orders, costMap, freteMap, clienteSlug: "loja-exemplo", competencia: "2026-11" };
const conta = { clienteContaId: 41, sellerId: SELLER };

const cobranca = (sub, valor) => ({
  charge_info: { detail_id: Number(`9${sub.length}${Math.round(valor * 100)}`), detail_amount: valor, detail_type: "CHARGE", detail_sub_type: sub, status: null, charge_bonified_id: null, legal_document_status: "PROCESSED" },
  sales_info: [{ order_id: 5000001 }], items_info: [{ item_id: "MLB100", order_id: 5000001 }], marketplace_info: { marketplace: "CORE" },
});
const evidencias = new Map([["5000001", {
  descontos: { details: [{ type: "discount", supplier: { funding_mode: "sale_fee" }, items: [{ id: "MLB100", quantity: 1, amounts: { total: 20.46, seller: 19.31 } }] }] },
  billing: { results: [{ order_id: 5000001, payment_info: [{ payment_id: 7001, status: "approved" }], sale_fee: { gross: 6.62, net: 5.47, rebate: 1.15, discount: 0 }, details: [cobranca("CVVML", 5.42), cobranca("CVVPRC", 0.05)] }], errors: [] },
}]]);

const PROMO = new Set(cp.TIPOS_PROMOCIONAIS ? Object.keys(cp.TIPOS_PROMOCIONAIS) : []);

test("flag desligada: motor idêntico (composicao ausente ou null)", () => {
  const antes = buildMotorFromOrders(base);
  const depois = buildMotorFromOrders({ ...base, composicao: null });
  assert.deepEqual(depois, antes);
  assert.equal(antes.resumo.composicaoPromocional, undefined);
  assert.ok(antes.itens.every((i) => !("variacaoId" in i)));
  assert.ok(antes.componentes.every((c) => !PROMO.has(c.tipo)));
});

test("flag ligada só com Orders: acrescenta informativos sem mudar nenhum resultado", () => {
  const antes = buildMotorFromOrders(base);
  const ligado = buildMotorFromOrders({ ...base, composicao: { ...conta, evidenciasPorPedido: null } });
  // resultados e totais idênticos
  assert.deepEqual(ligado.pedidos.map(({ composicaoPromocional, ...p }) => p), antes.pedidos);
  const { composicaoPromocional: est, ...resumoSem } = ligado.resumo;
  assert.deepEqual(resumoSem, antes.resumo);
  assert.deepEqual(ligado.itens.map(({ variacaoId, ...i }) => i), antes.itens);
  // os componentes antigos continuam lá, na mesma ordem relativa
  assert.deepEqual(ligado.componentes.filter((c) => !PROMO.has(c.tipo)), antes.componentes);
  // informativos: preço cheio só onde houve desconto (pedido 1 e item 2 do pedido 2)
  const promo = ligado.componentes.filter((c) => PROMO.has(c.tipo));
  assert.deepEqual(promo.map((c) => [c.pedidoId, c.itemId, c.tipo, c.valor, c.confianca]), [
    ["5000001", "5000001:MLB100:0", "preco_cheio", 78, "observado"],
    ["5000003", "5000003:MLB200:0", "preco_cheio", 30, "observado"],
  ]);
  for (const c of promo) {
    const k = classificarComponenteFinanceiro(c);
    assert.equal(k.incluidoNoResultado, false, `${c.tipo} nunca entra no resultado`);
    assert.equal(k.efeito, null);
  }
  assert.equal(ligado.itens[0].variacaoId, "1234567");
  assert.equal(est.pedidos, 3);
  assert.equal(est.falhas, 0);
  assert.deepEqual(est.porEstado, { NAO_VERIFICADO: 3 });
  assert.ok(ligado.pedidos.every((p) => p.composicaoPromocional === undefined), "só Orders: nada a guardar no pedido");
});

test("com Discounts + Billing: comprovado, rebate já na comissão, crédito 0; estado no pedido", () => {
  const r = buildMotorFromOrders({ ...base, composicao: { ...conta, evidenciasPorPedido: evidencias } });
  const doPedido = r.componentes.filter((c) => c.pedidoId === "5000001" && PROMO.has(c.tipo));
  assert.deepEqual(doPedido.map((c) => [c.tipo, c.valor, c.fonte, c.confianca, c.obs]), [
    ["preco_cheio", 78, "orders_api", "observado", null],
    ["desconto_vendedor", 19.31, "discounts_api", "observado", null],
    ["desconto_marketplace", 1.15, "discounts_api", "observado", null],
    ["comissao_bruta", 6.62, "billing_api", "comprovado", "natureza:liquida_comprovada"],
    ["rebate_marketplace", 1.15, "billing_api", "comprovado", "incorporado:comprovado"],
    ["credito_comissao_comprovado", 0, "billing_api", "comprovado", "rebate_ja_incorporado_na_comissao"],
  ]);
  assert.deepEqual(r.pedidos[0].composicaoPromocional, { estado: "CONCILIADO", divergencias: [] });
  // a tarifa do resultado continua a do pedido (líquida): nenhuma dupla contagem
  const tarifa = r.componentes.find((c) => c.pedidoId === "5000001" && c.tipo === "tarifa_venda");
  assert.equal(tarifa.valor, -5.47);
  assert.equal(r.pedidos[0].resultado, buildMotorFromOrders(base).pedidos[0].resultado);
});

test("compactos: pedidos com tipo promocional gravam formato 2; os demais, formato 1", () => {
  const r = buildMotorFromOrders({ ...base, composicao: { ...conta, evidenciasPorPedido: evidencias } });
  const a = cc.avaliarImport(r);
  assert.equal(a.elegivel, true);
  const textos = new Map(a.textos.map((t, i) => [t, i + 1]));
  const pedidoRowsById = new Map(r.pedidos.map((p, i) => [p.pedidoId, 10 + i]));
  const itemRowsById = new Map(r.itens.map((it, i) => [it.itemId, 100 + i]));
  const linhas = cc.montarLinhas({ componentes: r.componentes, pedidoRowsById, itemRowsById, textos, extrasDoComponente: () => null });
  assert.deepEqual(linhas.map((l) => l.f), [2, 1, 2]);
});

test("falha do compositor não derruba o import", () => {
  const quebrado = { ...base, orders: [{ ...orders[0], order_items: [{ ...orders[0].order_items[0], quantity: 1 }] }] };
  const original = cp.comporPedido;
  cp.comporPedido = () => { throw new Error("boom"); };
  try {
    const r = buildMotorFromOrders({ ...quebrado, composicao: { ...conta } });
    assert.equal(r.resumo.composicaoPromocional.falhas, 1);
    assert.equal(r.componentes.filter((c) => PROMO.has(c.tipo)).length, 0);
    assert.notEqual(r.pedidos[0].resultado, null);
  } finally {
    cp.comporPedido = original;
  }
});

test("flag: desligada por padrão, liga por conta ou '*'", () => {
  assert.equal(cp.isComposicaoPromocionalHabilitada({ clienteContaId: 41 }, {}), false);
  assert.equal(cp.isComposicaoPromocionalHabilitada({ clienteContaId: 41 }, { CENTRAL_VENDAS_COMPOSICAO_PROMOCIONAL: "true" }), false);
  assert.equal(cp.isComposicaoPromocionalHabilitada({ clienteContaId: 41 }, { CENTRAL_VENDAS_COMPOSICAO_PROMOCIONAL: "true", CENTRAL_VENDAS_COMPOSICAO_PROMOCIONAL_CONTAS: "21,41" }), true);
  assert.equal(cp.isComposicaoPromocionalHabilitada({ clienteContaId: 7 }, { CENTRAL_VENDAS_COMPOSICAO_PROMOCIONAL: "1", CENTRAL_VENDAS_COMPOSICAO_PROMOCIONAL_CONTAS: "*" }), true);
});
