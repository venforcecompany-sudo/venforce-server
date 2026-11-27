/* Portal/fechamentos-api-detalhe-financeiro.test.js
 *
 * Drawer "Extrato financeiro do pedido" com o detalhamento financeiro
 * (composicaoFinanceira de GET /read/orders/:rowId). Roda o arquivo REAL da
 * página num vm.Context (mesmo padrão de fechamentos-api.test.js) e alimenta
 * o drawer com a composição gerada pelo BACKEND REAL (motor → contrato →
 * detalharPedido), sem fixture escrita à mão:
 *   · sem composicaoFinanceira: o drawer é exatamente o de antes;
 *   · conciliado: preço cheio, quem financiou, comissão bruta/líquida, rebate
 *     incorporado, cálculo do resultado e origem dos valores aparecem;
 *   · composição não coletada: "Não coletado", nunca "R$ 0,00" de desconto;
 *   · divergência e base alterada aparecem; texto do backend é escapado.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const server = path.join(__dirname, "..", "server");
const { buildMotorFromOrders, buildCostMap } = require(path.join(server, "services/centralVendas/centralVendasSyncService"));
const { buildPedidoContrato } = require(path.join(server, "services/centralVendas/centralVendasService"));
const { detalharPedido } = require(path.join(server, "services/centralVendas/centralVendasDetalheFinanceiro"));
const { compararAssinatura } = require(path.join(server, "services/centralVendas/centralVendasBaseCustosAssinatura"));

const src = fs.readFileSync(path.join(__dirname, "fechamentos-api.js"), "utf8");
const fakeEl = (id) => ({ id, hidden: true, innerHTML: "", value: "", disabled: false, dataset: {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  setAttribute() {}, removeAttribute() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
  closest() { return null; }, focus() {}, append() {} });
const sandbox = {
  window: { location: { replace() {}, hash: "" }, initLayout: undefined },
  document: { getElementById: fakeEl, querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {}, createElement() { return fakeEl("tmp"); },
    body: { classList: { add() {}, remove() {} }, appendChild() {}, removeChild() {} } },
  localStorage: { _s: { "vf-token": "T" }, getItem(k) { return this._s[k] ?? null; }, setItem(k, v) { this._s[k] = v; } },
  fetch: async () => { throw new Error("fetch nao deveria ser chamado"); },
  history: { replaceState() {} }, navigator: {}, CSS: { escape: (s) => s },
  AbortController: function () { this.signal = {}; this.abort = () => {}; }, requestAnimationFrame: (fn) => fn(),
  console, setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(`${src}\n;globalThis.__T__ = { buildOrderDrawerBody };`, sandbox, { filename: "fechamentos-api.js" });
const { buildOrderDrawerBody } = sandbox.__T__;

let checks = 0;
function ok(label, cond) { assert.ok(cond, `FALHOU: ${label}`); checks += 1; console.log(`  ✓ ${label}`); }

// ── pedidos pelo backend real ──
const SELLER = 9001;
const costMap = buildCostMap([{ produto_id: "MLB100", custo_produto: 20, imposto_percentual: 6 }]);
const cob = (sub, v) => ({ charge_info: { detail_id: Number(`8${sub.length}${Math.round(v * 100)}`), detail_amount: v, detail_type: "CHARGE", detail_sub_type: sub, status: null, charge_bonified_id: null, legal_document_status: "PROCESSED" }, sales_info: [{ order_id: 5000001 }], items_info: [{ item_id: "MLB100", order_id: 5000001 }], marketplace_info: { marketplace: "CORE" } });
const order = { id: 5000001, status: "paid", seller: { id: SELLER }, currency_id: "BRL", date_created: "2026-11-10T10:00:00.000-03:00", shipping: { id: "S1", logistic_type: "cross_docking" },
  payments: [{ id: 7001, status: "approved" }], order_items: [{ item: { id: "MLB100", seller_sku: "SKU-<b>1</b>", title: "Fone", variation_id: 555 }, quantity: 1, unit_price: 57.54, sale_fee: 5.47, gross_price: 78 }] };
const evid = new Map([["5000001", {
  descontos: { details: [{ type: "discount", supplier: { funding_mode: "sale_fee" }, items: [{ id: "MLB100", quantity: 1, amounts: { total: 20.46, seller: 19.31 } }] }] },
  billing: { results: [{ order_id: 5000001, payment_info: [{ payment_id: 7001, status: "approved" }], sale_fee: { gross: 6.62, net: 5.47, rebate: 1.15, discount: 0 }, details: [cob("CVVML", 5.42), cob("CVVPRC", 0.05)] }], errors: [] },
}]]);
const freteMap = new Map([["S1", { status: "real", valor: 10, receitaComprador: 0 }]]);
function montar(composicao) {
  const m = buildMotorFromOrders({ orders: [order], costMap, freteMap, clienteSlug: "loja", competencia: "2026-11", composicao });
  const p = buildPedidoContrato(m.pedidos[0], m.itens, m.componentes);
  return { m, p };
}

{
  const { p } = montar(null);
  const antes = buildOrderDrawerBody(p, null);
  ok("sem composicaoFinanceira o drawer é idêntico ao de antes", antes === buildOrderDrawerBody(p, null, null) && !antes.includes("Preço e descontos"));
}

{
  const { m, p } = montar({ clienteContaId: 41, sellerId: SELLER, evidenciasPorPedido: evid });
  const cf = detalharPedido(p, { variacoes: new Map([[m.itens[0].itemId, "555"]]), composicaoColetada: true, composicaoDoPedido: m.pedidos[0].composicaoPromocional,
    baseCustos: compararAssinatura({ baseId: "1", n: 1, hash: "a" }, { baseId: "1", n: 1, hash: "a" }) });
  const html = buildOrderDrawerBody(p, null, JSON.parse(JSON.stringify(cf)));
  for (const sec of ["Preço e descontos", "Comissão e rebate", "Como o resultado foi calculado", "Cancelamentos, reembolsos e ajustes", "Origem dos valores e conciliação"]) {
    ok(`seção "${sec}" presente`, html.includes(sec));
  }
  ok("preço cheio e quem financiou (vendedor e ML)", html.includes("R$ 78,00") && html.includes("R$ 19,31") && html.includes("R$ 1,15"));
  ok("comissão bruta e líquida comprovadas e rebate já incorporado", html.includes("R$ 6,62") && html.includes("Comprovado") && html.includes("Sim (comprovado)"));
  ok("conciliação comprovada e base igual", html.includes("Comissão comprovada no Billing") && html.includes("Base de custos igual à usada no cálculo"));
  ok("identidade do resultado declarada", html.includes("a soma dos componentes fecha com o resultado gravado"));
  ok("coluna de variação na tabela de itens", html.includes(">Variação<") && html.includes(">555<"));
  ok("ledger mostra os informativos com rótulo próprio", html.includes("Preço cheio (informativo)") && html.includes("Rebate do Mercado Livre (conciliação)"));
  ok("texto do backend é escapado", !html.includes("<b>1</b>") && html.includes("SKU-&lt;b&gt;1&lt;/b&gt;"));
  ok("nenhum undefined/NaN no HTML", !/undefined|NaN/.test(html));
}

{
  const { p } = montar(null);
  const cf = detalharPedido(p, {});
  const html = buildOrderDrawerBody(p, null, JSON.parse(JSON.stringify(cf)));
  ok("composição não coletada: 'Não coletado' e pendência explicada, sem desconto R$ 0,00 inventado",
    html.includes("Não coletado") && html.includes("Composição promocional não coletada") && html.includes("composição promocional não coletada neste import")
    && !/Desconto total<\/dt><dd>R\$ 0,00/.test(html));
}

{
  const { m, p } = montar({ clienteContaId: 41, sellerId: SELLER, evidenciasPorPedido: null });
  const cf = detalharPedido({ ...p, resultado: 1 }, { composicaoColetada: true, composicaoDoPedido: { estado: "DIVERGENTE", divergencias: ["sale_fee_pedido_difere_do_net"] },
    baseCustos: compararAssinatura({ baseId: "1", n: 1, hash: "a" }, { baseId: "1", n: 1, hash: "b" }) });
  const html = buildOrderDrawerBody(p, null, JSON.parse(JSON.stringify(cf)));
  ok("divergências financeiras em destaque", html.includes("Divergências financeiras") && html.includes("Comissão do pedido diferente da tarifa líquida do Billing") && html.includes("Resultado gravado difere"));
  ok("base alterada vira pendência explicada", html.includes("Base de custos alterada desde o cálculo") && html.includes("nada é recalculado automaticamente"));
  ok("m existe (motor rodou)", m.pedidos.length === 1);
}

console.log(`\nfechamentos-api-detalhe-financeiro.test.js: ${checks} verificações OK`);
