// server/tests/centralVendasComposicaoPromocional.test.js
//
// Composição promocional e de comissão da Central (contrato v1) sobre as funções
// puras do Sentinel. Fixtures SINTÉTICAS (ids fictícios) no formato dos testes do
// conciliador (sentinelConciliacaoComissao.test.js), que reproduzem os cenários
// observados no S1-A. Foco: valores comprováveis, ausente ≠ zero, divergência
// exposta, e REBATE NUNCA CONTADO DUAS VEZES.
const test = require("node:test");
const assert = require("node:assert/strict");
const { comporPedido, componentesInformativos } = require("../services/centralVendas/centralVendasComposicaoPromocional");

const SELLER = 9001;
const CONTA = { clienteContaId: 41, sellerId: SELLER };

const pedido = (o = {}) => ({
  id: 5000001, status: "paid", seller: { id: SELLER }, pack_id: null, currency_id: "BRL",
  order_items: [{ item: { id: "MLB100", variation_id: null, seller_sku: "SKU-1" }, quantity: 1, unit_price: 57.54, sale_fee: 5.47, gross_price: 78, currency_id: "BRL", discounts: null }],
  payments: [{ id: 7001, status: "approved", transaction_amount: 57.54 }],
  ...o,
});
const descontos = ({ total = 20.46, seller = 19.31, fm = "sale_fee", itemId = "MLB100", q = 1, extra = [] } = {}) => ({
  details: [{ type: "discount", supplier: { funding_mode: fm, offer_id: "OFF1" }, items: [{ id: itemId, quantity: q, amounts: { total, seller } }] }, ...extra],
});
const cobranca = (sub, valor, o = {}) => ({
  charge_info: { detail_id: o.detail_id ?? Number(`9${sub.length}${Math.round(valor * 100)}`), transaction_detail: sub, detail_amount: valor, detail_type: "CHARGE", detail_sub_type: sub, status: null, charge_bonified_id: null, legal_document_status: o.doc || "PROCESSING" },
  sales_info: [{ order_id: 5000001, operation_id: 7001, transaction_amount: 57.54 }],
  items_info: [{ item_id: o.item_id ?? "MLB100", item_amount: 1, item_price: 57.54, order_id: 5000001 }],
  marketplace_info: { marketplace: "CORE" },
});
const registro = ({ gross = 6.62, net = 5.47, rebate = 1.15, discount = 0, details } = {}) => ({
  order_id: 5000001,
  payment_info: [{ payment_id: 7001, status: "approved", money_release_status: "pending" }],
  sale_fee: { gross, net, rebate, discount, discount_reason: null },
  details: details || [cobranca("CVVML", 5.42), cobranca("CVVPRC", 0.05)],
});
const billing = (...regs) => ({ offset: 0, limit: 250, total: regs.length, results: regs, errors: [] });
const cofinanciado = (o = {}) => ({ pedido: pedido(), descontos: descontos(), billing: billing(registro()), conta: CONTA, ...o });

const ITEM_ID = (idx) => `5000001:MLB100:${idx}`;
const todas = [];
const compor = (entrada) => {
  const r = comporPedido(entrada);
  todas.push(r);
  return r;
};

test("cofinanciado (rebate já na comissão): tudo comprovado, crédito adicional 0", () => {
  const r = compor(cofinanciado());
  assert.equal(r.estado, "CONCILIADO");
  assert.deepEqual(r.fontes, { orders: "lido", discounts: "lido", billing: "lido" });
  assert.equal(r.totais.precoCheio.centavos, 7800);
  assert.equal(r.totais.precoEfetivo.centavos, 5754);
  assert.equal(r.totais.descontoTotal.centavos, 2046);
  assert.equal(r.totais.vendedorBancou.centavos, 1931);
  assert.equal(r.totais.marketplaceBancou.centavos, 115);
  assert.equal(r.totais.descontoTotal.estado, "observado");
  assert.equal(r.comissao.doPedido.centavos, 547);
  assert.equal(r.comissao.bruta.centavos, 662);
  assert.equal(r.comissao.liquida.centavos, 547);
  assert.equal(r.comissao.bruta.estado, "comprovado");
  assert.equal(r.comissao.naturezaNoMotor, "liquida_comprovada");
  assert.deepEqual(r.rebate.identificado, { centavos: 115, estado: "comprovado", fonte: "billing_api" });
  assert.equal(r.rebate.incorporadoNaComissao, "comprovado");
  assert.equal(r.rebate.descontosEBillingConcordam, true);
  assert.deepEqual(r.creditoAdicionalComprovado, { centavos: 0, estado: "comprovado", motivo: "rebate_ja_incorporado_na_comissao", fonte: "billing_api" });
  assert.equal(r.limiteSuperiorNaoComprovado, null, "a conciliação substitui o limite superior");
  assert.equal(r.efeitoNoResultadoOficial, "nenhum");
  assert.deepEqual(r.divergencias, []);
});

test("tarifa do pedido é a BRUTA: crédito adicional comprovado = gross − net, rebate não incorporado", () => {
  const r = compor(cofinanciado({ pedido: pedido({ order_items: [{ item: { id: "MLB100" }, quantity: 1, unit_price: 57.54, sale_fee: 6.62, gross_price: 78 }] }) }));
  assert.equal(r.comissao.naturezaNoMotor, "bruta_comprovada");
  assert.equal(r.rebate.incorporadoNaComissao, "nao");
  assert.deepEqual(r.creditoAdicionalComprovado, { centavos: 115, estado: "comprovado", motivo: "tarifa_do_pedido_e_bruta", fonte: "billing_api" });
  assert.equal(r.estado, "CONCILIADO");
});

test("rebate possivelmente em dobro (pedido = net − rebate): DIVERGENTE, sem crédito, as duas pontas expostas", () => {
  const r = compor(cofinanciado({ pedido: pedido({ order_items: [{ item: { id: "MLB100" }, quantity: 1, unit_price: 57.54, sale_fee: 4.32, gross_price: 78 }] }) }));
  assert.equal(r.estado, "DIVERGENTE");
  assert.equal(r.comissao.naturezaNoMotor, "divergente");
  assert.equal(r.creditoAdicionalComprovado.centavos, null);
  const dobro = r.divergencias.find((d) => d.codigo === "rebate_possivelmente_contado_duas_vezes");
  assert.ok(dobro && dobro.entre === "orders×billing");
  const net = r.divergencias.find((d) => d.codigo === "sale_fee_pedido_difere_do_net");
  assert.deepEqual(net.detalhe, { pedidoCentavos: 432, billingNetCentavos: 547, billingGrossCentavos: 662 });
});

test("rebate do Billing difere do calculado pelos descontos: DIVERGENTE discounts×billing", () => {
  const r = compor(cofinanciado({ descontos: descontos({ total: 20.46, seller: 19.0 }) }));
  assert.equal(r.estado, "DIVERGENTE");
  assert.ok(r.divergencias.some((d) => d.codigo === "rebate_billing_difere_do_calculado" && d.entre === "discounts×billing"));
  assert.equal(r.rebate.calculadoPelosDescontos.centavos, 146);
  assert.equal(r.rebate.identificado.centavos, 115, "o valor do Billing é preservado, não corrigido");
  assert.equal(r.creditoAdicionalComprovado.centavos, null);
});

test("só Orders (sem /discounts e sem Billing): preço cheio observado, desconto inferido, quem bancou desconhecido", () => {
  const r = compor({ pedido: pedido(), conta: CONTA });
  assert.equal(r.estado, "NAO_VERIFICADO");
  assert.deepEqual(r.fontes, { orders: "lido", discounts: "nao_consultado", billing: "nao_consultado" });
  assert.equal(r.totais.precoCheio.centavos, 7800);
  assert.deepEqual(r.totais.descontoTotal, { centavos: 2046, estado: "inferido", fonte: "orders_api" });
  assert.deepEqual(r.totais.vendedorBancou, { centavos: null, estado: "desconhecido", fonte: null });
  assert.deepEqual(r.totais.marketplaceBancou, { centavos: null, estado: "desconhecido", fonte: null });
  assert.equal(r.comissao.bruta.centavos, null);
  assert.equal(r.rebate.identificado.centavos, null);
  assert.equal(r.creditoAdicionalComprovado.centavos, null);
  assert.ok(r.pendencias.includes("descontos_nao_verificados"));
  assert.ok(r.pendencias.includes("sem_registro_billing"));
});

test("sem promoção (gross = unit): desconto 0 inferido, nada a creditar", () => {
  const p = pedido({ order_items: [{ item: { id: "MLB100" }, quantity: 1, unit_price: 54, sale_fee: 6.21, gross_price: 54 }] });
  const r = compor({ pedido: p, conta: CONTA, billing: billing(registro({ gross: 6.21, net: 6.21, rebate: 0, details: [cobranca("CVVML", 6.16), cobranca("CVVPRC", 0.05)] })), descontos: { details: [] } });
  assert.equal(r.totais.descontoTotal.centavos, 0);
  assert.equal(r.totais.descontoTotal.estado, "inferido");
  assert.equal(r.totais.marketplaceBancou.centavos, 0);
  // /discounts sem detalhe não prova "sem desconto" ⇒ a conciliação fica conservadora
  assert.notEqual(r.creditoAdicionalComprovado.centavos, 115);
});

test("vendedor bancou tudo (funding seller): ML 0 observado, sem rebate", () => {
  const p = pedido({ order_items: [{ item: { id: "MLB100" }, quantity: 1, unit_price: 54, sale_fee: 6.21, gross_price: 60 }] });
  const r = compor({
    pedido: p, conta: CONTA, descontos: descontos({ total: 6, seller: 6, fm: "seller" }),
    billing: billing(registro({ gross: 6.21, net: 6.21, rebate: 0, details: [cobranca("CVVML", 6.16), cobranca("CVVPRC", 0.05)] })),
  });
  assert.equal(r.totais.vendedorBancou.centavos, 600);
  assert.equal(r.totais.marketplaceBancou.centavos, 0);
  assert.equal(r.rebate.incorporadoNaComissao, "nao_aplicavel");
  assert.deepEqual(r.creditoAdicionalComprovado, { centavos: 0, estado: "comprovado", motivo: "sem_rebate", fonte: "billing_api" });
});

test("quantidade 2: valores do item multiplicados; conciliação fora do escopo validado ⇒ PARCIAL", () => {
  const p = pedido({ order_items: [{ item: { id: "MLB100" }, quantity: 2, unit_price: 52, sale_fee: 5, gross_price: 159.8 }] });
  const r = compor({ pedido: p, conta: CONTA, descontos: descontos({ total: 55.8, seller: 50, q: 2 }) });
  assert.equal(r.itens[0].precoCheio.centavos, 15980);
  assert.equal(r.itens[0].precoEfetivo.centavos, 10400);
  assert.equal(r.itens[0].descontoTotal.centavos, 5580);
  assert.equal(r.itens[0].descontoVendedor.centavos, 5000);
  assert.equal(r.itens[0].descontoMarketplace.centavos, 580);
  assert.equal(r.itens[0].comissaoDoPedido.centavos, 1000);
  assert.equal(r.estado, "PARCIAL");
  assert.equal(r.creditoAdicionalComprovado.centavos, null);
});

test("multi-item: composição por item, conciliação pendente (escopo não validado)", () => {
  const p = pedido({
    order_items: [
      { item: { id: "MLB100" }, quantity: 1, unit_price: 57.54, sale_fee: 5.47, gross_price: 78 },
      { item: { id: "MLB200" }, quantity: 1, unit_price: 30, sale_fee: 3.6, gross_price: 30 },
    ],
  });
  const r = compor({ pedido: p, conta: CONTA, descontos: descontos(), billing: billing(registro()) });
  assert.equal(r.itens.length, 2);
  assert.equal(r.itens[0].descontoMarketplace.centavos, 115);
  assert.equal(r.itens[1].descontoTotal.centavos, 0);
  assert.ok(r.pendencias.includes("multiplos_itens_nao_validado"));
  assert.equal(r.comissao.naturezaNoMotor, "nao_verificada");
  assert.equal(r.creditoAdicionalComprovado.centavos, null);
  assert.equal(r.totais.precoCheio.centavos, 10800);
});

test("cupom: exposto com a parte do vendedor, nunca entra no resultado", () => {
  const cupom = { type: "coupon", supplier: { funding_mode: "seller" }, items: [{ id: "MLB100", quantity: 1, amounts: { total: 5, seller: 5 } }] };
  const r = compor(cofinanciado({ descontos: descontos({ extra: [cupom] }) }));
  assert.deepEqual(r.cupom.total, { centavos: 500, estado: "observado", fonte: "discounts_api" });
  assert.deepEqual(r.cupom.vendedor, { centavos: 500, estado: "observado", fonte: "discounts_api" });
  assert.equal(r.cupom.modeladoNoResultado, false);
  assert.ok(r.pendencias.includes("cupom_nao_validado"));
  assert.equal(r.creditoAdicionalComprovado.centavos, null, "cupom bloqueia a conciliação: nada é creditado");
});

test("Orders × Discounts contraditórios (gross não fecha): valores nulos e divergência exposta", () => {
  const r = compor(cofinanciado({ descontos: descontos({ total: 10, seller: 9 }) }));
  assert.equal(r.estado, "DIVERGENTE");
  assert.equal(r.itens[0].descontoTotal.estado, "contraditorio");
  assert.equal(r.itens[0].descontoTotal.centavos, null);
  assert.ok(r.divergencias.some((d) => d.codigo === "gross_nao_reconcilia" && d.entre === "orders×discounts"));
});

test("/discounts 404 e Billing parcial: fontes marcadas, nunca 'sem desconto'", () => {
  const r = compor({ pedido: pedido(), conta: CONTA, descontos: { indisponivel_http: 404 }, billing: { results: [registro()], errors: [{ status: 500 }] } });
  assert.equal(r.fontes.discounts, "indisponivel");
  assert.equal(r.fontes.billing, "parcial");
  assert.equal(r.creditoAdicionalComprovado.centavos, null);
  assert.equal(r.totais.marketplaceBancou.centavos, null);
});

test("armazenamento: componentes informativos só com o que é conhecido, sem payload", () => {
  const r = comporPedido(cofinanciado());
  const comps = componentesInformativos(r, { pedidoId: "5000001", itemIdDoIdx: ITEM_ID });
  assert.deepEqual(comps.map((c) => [c.tipo, c.itemId, c.valor, c.fonte, c.confianca, c.obs]), [
    ["preco_cheio", "5000001:MLB100:0", 78, "orders_api", "observado", null],
    ["desconto_vendedor", "5000001:MLB100:0", 19.31, "discounts_api", "observado", null],
    ["desconto_marketplace", "5000001:MLB100:0", 1.15, "discounts_api", "observado", null],
    ["comissao_bruta", null, 6.62, "billing_api", "comprovado", "natureza:liquida_comprovada"],
    ["rebate_marketplace", null, 1.15, "billing_api", "comprovado", "incorporado:comprovado"],
    ["credito_comissao_comprovado", null, 0, "billing_api", "comprovado", "rebate_ja_incorporado_na_comissao"],
  ]);
  const soOrders = componentesInformativos(comporPedido({ pedido: pedido(), conta: CONTA }), { pedidoId: "5000001", itemIdDoIdx: ITEM_ID });
  assert.deepEqual(soOrders.map((c) => c.tipo), ["preco_cheio"], "desconhecido não vira componente (nem zero)");
  const tamanho = Buffer.byteLength(JSON.stringify(comps));
  assert.ok(tamanho < 1200, `componentes informativos pequenos (${tamanho} B em JSON; no compacto viram códigos + numeric)`);
});

test("invariantes em todos os cenários: rebate nunca conta duas vezes e o resultado oficial não muda", () => {
  assert.ok(todas.length >= 10);
  for (const r of todas) {
    assert.equal(r.efeitoNoResultadoOficial, "nenhum");
    const c = r.creditoAdicionalComprovado.centavos;
    if (c !== null && c > 0) {
      assert.equal(r.comissao.naturezaNoMotor, "bruta_comprovada", "crédito positivo só com tarifa bruta comprovada");
      assert.equal(c, r.comissao.bruta.centavos - r.comissao.liquida.centavos);
      assert.notEqual(r.rebate.incorporadoNaComissao, "comprovado");
    }
    if (r.rebate.incorporadoNaComissao === "comprovado") assert.equal(c, 0, "rebate incorporado ⇒ nenhum crédito adicional");
    if (c !== null) assert.equal(r.limiteSuperiorNaoComprovado, null, "conciliação substitui o limite, nunca soma");
    if (r.estado === "DIVERGENTE") assert.equal(c, null);
  }
});
