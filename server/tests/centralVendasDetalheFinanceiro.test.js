// server/tests/centralVendasDetalheFinanceiro.test.js
//
// Detalhamento financeiro do pedido, de ponta a ponta sem banco:
// pedidos do ML → buildMotorFromOrders (com e sem composição) → contrato do
// pedido (buildPedidoContrato) → detalharPedido. Prova que o detalhe explica o
// resultado do motor (identidade fecha), separa comprovado de inferido, diz
// "não coletado" quando a composição estava desligada e nunca transforma
// ausência em zero.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildMotorFromOrders, buildCostMap } = require("../services/centralVendas/centralVendasSyncService");
const { buildPedidoContrato } = require("../services/centralVendas/centralVendasService");
const { detalharPedido } = require("../services/centralVendas/centralVendasDetalheFinanceiro");
const { compararAssinatura } = require("../services/centralVendas/centralVendasBaseCustosAssinatura");

const SELLER = 9001;
const costMap = buildCostMap([{ produto_id: "MLB100", custo_produto: 20, imposto_percentual: 6 }, { produto_id: "MLB200", custo_produto: 10, imposto_percentual: 6 }]);
const order = (id, itens, o = {}) => ({
  id, status: "paid", seller: { id: SELLER }, pack_id: null, currency_id: "BRL", date_created: "2026-11-10T10:00:00.000-03:00",
  shipping: { id: `S${id}`, logistic_type: "fulfillment" }, payments: [{ id: 7001, status: "approved" }], order_items: itens, ...o,
});
const item = (mlb, { q = 1, unit, fee, gross = null, variacao = null }) => ({ item: { id: mlb, seller_sku: `SKU-${mlb}`, title: `Produto ${mlb}`, variation_id: variacao }, quantity: q, unit_price: unit, sale_fee: fee, gross_price: gross, currency_id: "BRL" });
const cob = (sub, v) => ({ charge_info: { detail_id: Number(`8${sub.length}${Math.round(v * 100)}`), detail_amount: v, detail_type: "CHARGE", detail_sub_type: sub, status: null, charge_bonified_id: null, legal_document_status: "PROCESSED" }, sales_info: [{ order_id: 5000001 }], items_info: [{ item_id: "MLB100", order_id: 5000001 }], marketplace_info: { marketplace: "CORE" } });
const EVID = new Map([["5000001", {
  descontos: { details: [{ type: "discount", supplier: { funding_mode: "sale_fee" }, items: [{ id: "MLB100", quantity: 1, amounts: { total: 20.46, seller: 19.31 } }] }] },
  billing: { results: [{ order_id: 5000001, payment_info: [{ payment_id: 7001, status: "approved" }], sale_fee: { gross: 6.62, net: 5.47, rebate: 1.15, discount: 0 }, details: [cob("CVVML", 5.42), cob("CVVPRC", 0.05)] }], errors: [] },
}]]);
const freteMap = new Map([["S5000001", { status: "real", valor: 10, receitaComprador: 4 }], ["S5000002", { status: "real", valor: 12, receitaComprador: 0 }]]);
const orders = [
  order(5000001, [item("MLB100", { unit: 57.54, fee: 5.47, gross: 78, variacao: 1234567 })]),
  order(5000002, [item("MLB100", { unit: 60, fee: 7.2, gross: 60 }), item("MLB200", { q: 2, unit: 30, fee: 3.6, gross: 66 })]),
  order(5000003, [item("MLB200", { unit: 25, fee: 3, gross: 25 })], { status: "cancelled", payments: [{ id: 7003, status: "refunded", transaction_amount_refunded: 25 }] }),
];
const motor = (composicao) => buildMotorFromOrders({ orders, costMap, freteMap, clienteSlug: "loja", competencia: "2026-11", composicao });
function contrato(m, pedidoId) {
  const p = m.pedidos.find((x) => x.pedidoId === pedidoId);
  return buildPedidoContrato(p, m.itens, m.componentes);
}
const variacoesDe = (m) => new Map(m.itens.filter((i) => i.variacaoId).map((i) => [i.itemId, i.variacaoId]));

test("conciliado (Orders + Discounts + Billing): preços, financiadores, comissão e rebate comprovados; identidade fecha", () => {
  const m = motor({ clienteContaId: 41, sellerId: SELLER, evidenciasPorPedido: EVID });
  const p = m.pedidos[0];
  const d = detalharPedido(contrato(m, "5000001"), { variacoes: variacoesDe(m), composicaoColetada: true, composicaoDoPedido: p.composicaoPromocional, baseCustos: compararAssinatura({ baseId: "9", n: 2, hash: "a" }, { baseId: "9", n: 2, hash: "a" }) });
  assert.equal(d.itens[0].variacaoId, "1234567");
  assert.equal(d.itens[0].sku, "SKU-MLB100");
  assert.deepEqual([d.precos.precoCheio, d.precos.precoEfetivo, d.precos.desconto, d.precos.vendedorBancou, d.precos.marketplaceBancou], [78, 57.54, 20.46, 19.31, 1.15]);
  assert.equal(d.comissao.doPedido.valor, 5.47);
  assert.deepEqual([d.comissao.bruta.valor, d.comissao.bruta.estado], [6.62, "comprovado"]);
  assert.deepEqual([d.comissao.liquida.valor, d.comissao.liquida.estado], [5.47, "comprovado"]);
  assert.equal(d.comissao.natureza, "liquida_comprovada");
  assert.deepEqual([d.comissao.rebate.valor, d.comissao.rebate.incorporadoNaComissao], [1.15, "comprovado"]);
  assert.equal(d.comissao.creditoAdicionalComprovado.valor, 0);
  assert.equal(d.evidencias.estadoConciliacao, "CONCILIADO");
  assert.deepEqual(d.composicao.linhas.map((l) => [l.id, l.valor, l.sinal]), [["receita_produto", 57.54, 1], ["comissao", 5.47, -1], ["frete_seller", 10, -1], ["cmv", 20, -1], ["imposto", 3.45, -1]]);
  assert.equal(d.composicao.linhas[1].estado, "comprovado");
  assert.equal(d.composicao.resultado, 18.62);
  assert.equal(d.composicao.identidade.fecha, true);
  assert.equal(d.composicao.margemPercentual, 32.36);
  assert.equal(d.conciliacao.receitaEnvio.valor, 4);
  assert.deepEqual(d.divergencias, []);
  assert.ok(!d.pendencias.some((x) => x.codigo === "comissao_nao_conciliada"));
});

test("composição coletada só com Orders: desconto inferido, financiadores e comissão bruta desconhecidos", () => {
  const m = motor({ clienteContaId: 41, sellerId: SELLER, evidenciasPorPedido: null });
  const d = detalharPedido(contrato(m, "5000002"), { variacoes: variacoesDe(m), composicaoColetada: true });
  // item 1 sem desconto (cheio = efetivo, inferido); item 2 com desconto pelo gross
  assert.deepEqual(d.itens.map((i) => [i.precoCheio.valor, i.precoEfetivo.valor, i.desconto.valor, i.precoCheio.estado]), [[60, 60, 0, "inferido"], [66, 60, 6, "observado"]]);
  assert.equal(d.itens[1].descontoVendedor.valor, null);
  assert.equal(d.itens[1].descontoVendedor.estado, "desconhecido");
  assert.equal(d.precos.vendedorBancou, null, "soma com parte desconhecida não vira número");
  assert.equal(d.comissao.bruta.estado, "desconhecido");
  assert.equal(d.comissao.creditoAdicionalComprovado.valor, null);
  assert.equal(d.evidencias.estadoConciliacao, "NAO_VERIFICADO");
  assert.ok(d.pendencias.some((x) => x.codigo === "comissao_nao_conciliada"));
  assert.equal(d.identificacao.multiItem, true);
  assert.equal(d.composicao.identidade.fecha, true);
});

test("composição desligada no import: 'não coletado', nunca 'sem desconto'", () => {
  const m = motor(null);
  const d = detalharPedido(contrato(m, "5000001"), {});
  assert.equal(d.precos.coletado, false);
  assert.equal(d.precos.precoCheio, null);
  assert.equal(d.itens[0].precoCheio.estado, "nao_coletado");
  assert.equal(d.itens[0].desconto.estado, "nao_coletado");
  assert.equal(d.comissao.bruta.estado, "nao_coletado");
  assert.equal(d.evidencias.estadoConciliacao, "NAO_COLETADO");
  assert.ok(d.pendencias.some((x) => x.codigo === "composicao_promocional_nao_coletada"));
  // a composição do resultado continua completa (vem do ledger de sempre)
  assert.equal(d.composicao.identidade.fecha, true);
  assert.equal(d.composicao.resultado, contrato(m, "5000001").resultado);
});

test("cancelado com reembolso: fora do resultado, reembolso exposto e não descontado de novo", () => {
  const m = motor({ clienteContaId: 41, sellerId: SELLER });
  const d = detalharPedido(contrato(m, "5000003"), { composicaoColetada: true });
  assert.equal(d.conciliacao.cancelado, true);
  assert.equal(d.conciliacao.entraNoResultado, false);
  assert.equal(d.conciliacao.reembolso.valor, 25);
  assert.equal(d.composicao.linhas.find((l) => l.id === "receita_produto").valor, 25);
});

test("resíduo entre componentes e resultado vira divergência e ajuste (nunca escondido)", () => {
  const m = motor(null);
  const c = { ...contrato(m, "5000001"), resultado: 15 };
  const d = detalharPedido(c, {});
  assert.equal(d.composicao.identidade.fecha, false);
  assert.equal(d.composicao.identidade.residuo, -3.62);
  assert.ok(d.divergencias.some((x) => x.codigo === "resultado_nao_fecha_com_componentes"));
  assert.equal(d.conciliacao.ajustes.valor, -3.62);
});

test("base de custos alterada ou trocada desde o cálculo vira pendência; igual não", () => {
  const m = motor(null);
  const c = contrato(m, "5000001");
  const gravada = { baseId: "9", n: 2, hash: "a" };
  assert.ok(detalharPedido(c, { baseCustos: compararAssinatura(gravada, { baseId: "9", n: 2, hash: "b" }) }).pendencias.some((x) => x.codigo === "base_custos_alterada_desde_o_calculo"));
  assert.ok(detalharPedido(c, { baseCustos: compararAssinatura(gravada, { baseId: "10", n: 2, hash: "a" }) }).pendencias.some((x) => x.codigo === "base_custos_trocada_desde_o_calculo"));
  assert.ok(!detalharPedido(c, { baseCustos: compararAssinatura(gravada, { ...gravada }) }).pendencias.some((x) => x.origem === "base"));
  assert.equal(compararAssinatura(null, gravada).estado, "sem_registro");
  assert.equal(compararAssinatura(gravada, null).estado, "base_atual_indisponivel");
});

test("divergência gravada no pedido aparece com rótulo", () => {
  const m = motor(null);
  const d = detalharPedido(contrato(m, "5000001"), { composicaoColetada: true, composicaoDoPedido: { estado: "DIVERGENTE", divergencias: ["rebate_possivelmente_contado_duas_vezes"] } });
  assert.equal(d.evidencias.estadoConciliacao, "DIVERGENTE");
  assert.deepEqual(d.divergencias.map((x) => x.rotulo), ["Rebate possivelmente descontado duas vezes"]);
});
