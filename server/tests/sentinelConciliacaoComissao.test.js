// Conciliador de comissão por pedido (S1-B1): função PURA. Fixtures SINTÉTICAS (ids fictícios) que reproduzem os
// seis cenários observados no S1-A (3 cofinanciados com funding_mode "sale_fee" + 3 controles do vendedor).
const test = require("node:test");
const assert = require("node:assert/strict");
const { conciliarComissaoPedido, CONCILIACAO_CONTRATO_VERSAO, MOTIVOS } = require("../services/sentinel/sentinelConciliacaoComissao");
const { ESTADOS_CONCILIACAO, CONTRATO_VERSAO } = require("../services/sentinel/sentinelEvidenciaFinanceira");

const SELLER = 9001;
const CONTA = { id: 41, sellerId: SELLER };

// ── construtores de fixtures ───────────────────────────────────────────────────────────────────────
const pedido = (o = {}) => ({
  id: 5000001, status: "paid", seller: { id: SELLER }, pack_id: null,
  order_items: [{ item: { id: "MLB100", variation_id: null }, quantity: 1, unit_price: 57.54, sale_fee: 5.47, gross_price: 78, currency_id: "BRL", discounts: null }],
  payments: [{ id: 7001, status: "approved", transaction_amount: 57.54 }],
  ...o,
});
const descontos = ({ total = 20.46, seller = 19.31, fm = "sale_fee", itemId = "MLB100", q = 1, extra = [] } = {}) => ({
  details: [{ type: "discount", supplier: { funding_mode: fm, offer_id: "OFF1" }, items: [{ id: itemId, quantity: q, amounts: { total, seller } }] }, ...extra],
});
const cobranca = (sub, valor, o = {}) => ({
  charge_info: { detail_id: o.detail_id ?? Number(`9${sub.length}${Math.round(valor * 100)}`), transaction_detail: sub, detail_amount: valor, detail_type: o.detail_type || "CHARGE", detail_sub_type: sub, status: o.status ?? null, charge_bonified_id: o.bonif ?? null, legal_document_status: o.doc || "PROCESSING" },
  discount_info: { charge_amount_without_discount: null, discount_amount: null, discount_reason: null, rebate: null },
  sales_info: [{ order_id: o.order_id ?? 5000001, operation_id: 7001, transaction_amount: 57.54 }],
  items_info: [{ item_id: o.item_id ?? "MLB100", item_amount: 1, item_price: 57.54, order_id: o.order_id ?? 5000001 }],
  marketplace_info: { marketplace: o.mkt || "CORE" },
});
const registro = ({ gross = 6.62, net = 5.47, rebate = 1.15, discount = 0, order_id = 5000001, details, payment_id = 7001, pagamentos } = {}) => ({
  order_id,
  payment_info: pagamentos || [{ payment_id, status: "approved", money_release_status: "pending" }],
  sale_fee: { gross, net, rebate, discount, discount_reason: null },
  details: details || [cobranca("CVVML", 5.42), cobranca("CVVPRC", 0.05)],
});
const billing = (...regs) => ({ offset: 0, limit: 250, total: regs.length, last_id: 0, results: regs, errors: [] });

// cenário 1 (cofinanciado, net 5,47) — os demais variam dele
const cenarioCofinanciado = (o = {}) => ({ pedido: pedido(), descontos: descontos(), billing: billing(registro()), conta: CONTA, ...o });
const r = (entrada) => conciliarComissaoPedido(entrada);
const tem = (res, m) => assert.ok(res.motivos.includes(m), `esperava motivo ${m}; veio ${JSON.stringify(res.motivos)}`);

// ── 1. os seis cenários observados ────────────────────────────────────────────────────────────────
test("C1 cofinanciado (sale_fee): TARIFA_LIQUIDA_COMPROVADA, rebate incorporado comprovado, sem efeito na margem", () => {
  const x = r(cenarioCofinanciado());
  assert.equal(x.estado, "TARIFA_LIQUIDA_COMPROVADA");
  assert.equal(x.rebate_incorporado, "comprovado");
  assert.equal(x.efeito_na_margem, "nenhum");
  assert.equal(x.escopo_validado, true);
  assert.deepEqual(x.centavos.billing, { gross: 662, net: 547, rebate: 115, discount: 0 });
  assert.equal(x.centavos.sale_fee_pedido, 547);
  assert.equal(x.centavos.cobrancas_tarifa, 547);
  assert.deepEqual(x.rebate, { billing_centavos: 115, calculado_descontos_centavos: 115, concordam: true, origem: "billing_observado" });
  assert.equal(x.vinculo.pedido_billing, "confere");
  assert.equal(x.vinculo.item, "confere");
  assert.equal(x.vinculo.pagamento, "confere");
  assert.equal(x.vinculo.conta, "verificado");
});

test("C2 os outros dois cofinanciados reais (2,20 e 0,69) também fecham", () => {
  for (const [net, gross, rebate, total, seller, c1, c2] of [[10.48, 12.68, 2.2, 39.64, 37.44, 10.39, 0.09], [5.77, 6.46, 0.69, 13.74, 13.05, 5.72, 0.05]]) {
    const x = r({ pedido: pedido({ order_items: [{ item: { id: "MLB100" }, quantity: 1, unit_price: 56.16, sale_fee: net, gross_price: 69.9 }] }),
      descontos: descontos({ total, seller }), billing: billing(registro({ gross, net, rebate, details: [cobranca("CVVML", c1), cobranca("CVVPRC", c2)] })), conta: CONTA });
    assert.equal(x.estado, "TARIFA_LIQUIDA_COMPROVADA");
    assert.equal(x.rebate_incorporado, "comprovado");
  }
});

test("C3 controle do vendedor (rebate 0, gross = net): líquida e rebate 'nao_aplicavel'", () => {
  const x = r({ pedido: pedido({ order_items: [{ item: { id: "MLB100" }, quantity: 1, unit_price: 54, sale_fee: 6.21 }] }),
    descontos: descontos({ total: 25.9, seller: 25.9, fm: "seller" }),
    billing: billing(registro({ gross: 6.21, net: 6.21, rebate: 0, details: [cobranca("CVVML", 6.16), cobranca("CVVPRC", 0.05)] })), conta: CONTA });
  assert.equal(x.estado, "TARIFA_LIQUIDA_COMPROVADA");
  assert.equal(x.rebate_incorporado, "nao_aplicavel");
  assert.deepEqual(x.rebate, { billing_centavos: 0, calculado_descontos_centavos: 0, concordam: true, origem: "billing_observado" });
});

test("C4 taxa de recebimento (CVVFNU) entra na tarifa; parcelamento (CFONPN) e frete (CXDE) ficam de fora", () => {
  const x = r({ pedido: pedido({ order_items: [{ item: { id: "MLB100" }, quantity: 1, unit_price: 57.9, sale_fee: 6.66 }] }),
    descontos: descontos({ total: 12, seller: 12, fm: "seller" }),
    billing: billing(registro({ gross: 6.66, net: 6.66, rebate: 0, details: [cobranca("CVVFNU", 0.17), cobranca("CVVPRC", 1.59), cobranca("CVVML", 4.9), cobranca("CFONPN", 12.54, { mkt: "MP" }), cobranca("CXDE", 16.15, { mkt: "SHIPPING" })] })), conta: CONTA });
  assert.equal(x.estado, "TARIFA_LIQUIDA_COMPROVADA");
  assert.equal(x.centavos.cobrancas_tarifa, 666);
  assert.equal(x.cobrancas.filter((c) => c.na_tarifa).length, 3);
  assert.equal(x.cobrancas.length, 5);
});

// ── 2. documento / faturamento ───────────────────────────────────────────────────────────────────
test("C5 documento PROCESSING: concilia a cobrança observada, mas NÃO é definitivo", () => {
  const x = r(cenarioCofinanciado());
  assert.equal(x.estado, "TARIFA_LIQUIDA_COMPROVADA");
  assert.deepEqual(x.faturamento, { documento: "PROCESSING", definitivo: false });
  tem(x, MOTIVOS.DOCUMENTO_EM_PROCESSAMENTO);
});

test("C6 todos os documentos PROCESSED: definitivo só quanto ao documento (liquidação segue não verificada)", () => {
  const x = r(cenarioCofinanciado({ billing: billing(registro({ details: [cobranca("CVVML", 5.42, { doc: "PROCESSED" }), cobranca("CVVPRC", 0.05, { doc: "PROCESSED" })] })) }));
  assert.deepEqual(x.faturamento, { documento: "PROCESSED", definitivo: true });
  assert.equal(x.liquidacao, "nao_verificada");
  assert.equal(x.motivos.includes(MOTIVOS.DOCUMENTO_EM_PROCESSAMENTO), false);
});

// ── 3. adversariais: divergência ─────────────────────────────────────────────────────────────────
test("A1 rebate contado duas vezes (sale_fee do pedido = net − rebate): DIVERGENTE, sem ajuste", () => {
  const x = r(cenarioCofinanciado({ pedido: pedido({ order_items: [{ item: { id: "MLB100" }, quantity: 1, unit_price: 57.54, sale_fee: 4.32 }] }) }));
  assert.equal(x.estado, "DIVERGENTE");
  tem(x, MOTIVOS.REBATE_POSSIVELMENTE_EM_DOBRO);
  tem(x, MOTIVOS.SALE_FEE_DIFERE_DO_NET);
  assert.equal(x.efeito_na_margem, "nenhum");
  assert.equal(x.centavos.sale_fee_pedido, 432); // valor preservado, não corrigido
});

test("A2 Billing com net diferente da tarifa do pedido: DIVERGENTE", () => {
  const x = r(cenarioCofinanciado({ billing: billing(registro({ gross: 6.8, net: 5.65, rebate: 1.15, details: [cobranca("CVVML", 5.6), cobranca("CVVPRC", 0.05)] })) }));
  assert.equal(x.estado, "DIVERGENTE");
  tem(x, MOTIVOS.SALE_FEE_DIFERE_DO_NET);
});

test("A3 cobranças não somam o net: DIVERGENTE", () => {
  const x = r(cenarioCofinanciado({ billing: billing(registro({ details: [cobranca("CVVML", 5.3), cobranca("CVVPRC", 0.05)] })) }));
  assert.equal(x.estado, "DIVERGENTE");
  tem(x, MOTIVOS.COBRANCAS_NAO_SOMAM_NET);
});

test("A4 identidade gross − net ≠ rebate + discount: DIVERGENTE", () => {
  const x = r(cenarioCofinanciado({ billing: billing(registro({ gross: 6.9 })) }));
  assert.equal(x.estado, "DIVERGENTE");
  tem(x, MOTIVOS.IDENTIDADE_GROSS_NET);
});

test("A5 rebate do Billing ≠ parte do ML calculada em /discounts (funding sale_fee): DIVERGENTE", () => {
  const x = r(cenarioCofinanciado({ descontos: descontos({ total: 20.46, seller: 18.5 }) })); // ML = 1,96 ≠ 1,15
  assert.equal(x.estado, "DIVERGENTE");
  tem(x, MOTIVOS.REBATE_DIFERE_DO_CALCULADO);
  assert.equal(x.rebate.concordam, false);
});

test("A6 Billing diz que houve rebate mas /discounts mostra 100% do vendedor: DIVERGENTE", () => {
  const x = r(cenarioCofinanciado({ descontos: descontos({ total: 20.46, seller: 20.46, fm: "seller" }) }));
  assert.equal(x.estado, "DIVERGENTE");
  tem(x, MOTIVOS.REBATE_DIFERE_DO_CALCULADO);
});

test("A7 tarifa do pedido é a BRUTA (rebate > 0 não incorporado): TARIFA_BRUTA_COMPROVADA, sem crédito", () => {
  const x = r(cenarioCofinanciado({ pedido: pedido({ order_items: [{ item: { id: "MLB100" }, quantity: 1, unit_price: 57.54, sale_fee: 6.62 }] }) }));
  assert.equal(x.estado, "TARIFA_BRUTA_COMPROVADA");
  assert.equal(x.rebate_incorporado, "nao");
  assert.equal(x.efeito_na_margem, "nenhum");
  tem(x, MOTIVOS.TARIFA_DO_PEDIDO_E_BRUTA);
});

// ── 4. adversariais: vínculo / dado ausente ─────────────────────────────────────────────────────
test("A8 pedido sem registro no Billing: NAO_CONCILIADO (ausência não é zero)", () => {
  for (const b of [billing(), null, undefined, { results: [], errors: [] }]) {
    const x = r(cenarioCofinanciado({ billing: b }));
    assert.equal(x.estado, "NAO_CONCILIADO");
    tem(x, MOTIVOS.SEM_REGISTRO_BILLING);
    assert.equal(x.centavos.billing, null);
    assert.equal(x.rebate_incorporado, "desconhecido");
  }
});

test("A9 registro de Billing de OUTRO pedido: NAO_CONCILIADO, nunca usa o valor", () => {
  const x = r(cenarioCofinanciado({ billing: billing(registro({ order_id: 5999999 })) }));
  assert.equal(x.estado, "NAO_CONCILIADO");
  tem(x, MOTIVOS.BILLING_DE_OUTRO_PEDIDO);
  assert.equal(x.centavos.billing, null);
});

test("A10 cobrança dentro do registro que aponta para outro pedido ou item: NAO_CONCILIADO", () => {
  const a = r(cenarioCofinanciado({ billing: billing(registro({ details: [cobranca("CVVML", 5.42, { order_id: 5999999 }), cobranca("CVVPRC", 0.05)] })) }));
  assert.equal(a.estado, "NAO_CONCILIADO"); tem(a, MOTIVOS.BILLING_DE_OUTRO_PEDIDO);
  const b = r(cenarioCofinanciado({ billing: billing(registro({ details: [cobranca("CVVML", 5.42, { item_id: "MLB999" }), cobranca("CVVPRC", 0.05)] })) }));
  assert.equal(b.estado, "NAO_CONCILIADO"); tem(b, MOTIVOS.ITEM_NAO_CONFERE);
});

test("A11 outra CONTA: Billing buscado com o grant de outra conta, ou pedido de outro seller", () => {
  const a = r(cenarioCofinanciado({ origem_billing: { contaId: 86 } }));
  assert.equal(a.estado, "NAO_CONCILIADO"); tem(a, MOTIVOS.BILLING_DE_OUTRA_CONTA);
  const b = r(cenarioCofinanciado({ pedido: pedido({ seller: { id: 777 } }) }));
  assert.equal(b.estado, "NAO_CONCILIADO"); tem(b, MOTIVOS.PEDIDO_DE_OUTRA_CONTA);
  const c = r(cenarioCofinanciado({ origem_billing: { contaId: 41 } }));
  assert.equal(c.estado, "TARIFA_LIQUIDA_COMPROVADA"); // mesma conta: ok
});

test("A12 conta não informada: concilia, mas o vínculo de conta fica 'nao_verificado' (visível)", () => {
  const x = r({ pedido: pedido(), descontos: descontos(), billing: billing(registro()) });
  assert.equal(x.estado, "TARIFA_LIQUIDA_COMPROVADA");
  assert.equal(x.vinculo.conta, "nao_verificado");
  tem(x, MOTIVOS.CONTA_NAO_VERIFICADA);
});

test("A13 pagamento do Billing não confere com o do pedido: NAO_CONCILIADO", () => {
  const x = r(cenarioCofinanciado({ billing: billing(registro({ payment_id: 123 })) }));
  assert.equal(x.estado, "NAO_CONCILIADO");
  tem(x, MOTIVOS.PAGAMENTO_NAO_CONFERE);
});

test("A14 mais de uma cobrança vinculada à venda: duplicada (mesmo detail_id) e múltipla (mesmo subtipo) são conservadoras", () => {
  const dup = cobranca("CVVML", 5.42, { detail_id: 1 });
  const a = r(cenarioCofinanciado({ billing: billing(registro({ details: [dup, dup, cobranca("CVVPRC", 0.05)] })) }));
  assert.equal(a.estado, "NAO_CONCILIADO"); tem(a, MOTIVOS.COBRANCA_DUPLICADA);
  const b = r(cenarioCofinanciado({ billing: billing(registro({ details: [cobranca("CVVML", 3, { detail_id: 1 }), cobranca("CVVML", 2.42, { detail_id: 2 }), cobranca("CVVPRC", 0.05)] })) }));
  assert.equal(b.estado, "NAO_CONCILIADO"); tem(b, MOTIVOS.COBRANCA_MULTIPLA_MESMO_TIPO);
});

test("A15 dois registros do mesmo pedido no Billing: NAO_CONCILIADO", () => {
  const x = r(cenarioCofinanciado({ billing: billing(registro(), registro()) }));
  assert.equal(x.estado, "NAO_CONCILIADO");
  tem(x, MOTIVOS.BILLING_REGISTRO_DUPLICADO);
});

test("A16 subtipo de cobrança desconhecido no CORE: NAO_CONCILIADO (não soma às cegas)", () => {
  const x = r(cenarioCofinanciado({ billing: billing(registro({ details: [cobranca("CVVML", 5.42), cobranca("CVVPRC", 0.05), cobranca("ZZZNOVO", 1)] })) }));
  assert.equal(x.estado, "NAO_CONCILIADO");
  tem(x, MOTIVOS.SUBTIPO_DESCONHECIDO);
});

test("A17 Billing com errors[] ou HTTP 206: parcial ⇒ NAO_CONCILIADO", () => {
  const a = r(cenarioCofinanciado({ billing: { ...billing(registro()), errors: [{ code: "x" }] } }));
  assert.equal(a.estado, "NAO_CONCILIADO"); tem(a, MOTIVOS.BILLING_PARCIAL);
  const b = r(cenarioCofinanciado({ meta: { billingHttpStatus: 206 } }));
  assert.equal(b.estado, "NAO_CONCILIADO"); tem(b, MOTIVOS.BILLING_PARCIAL);
});

test("A18 sem cobranças de tarifa nos details: NAO_CONCILIADO (não dá para verificar a soma)", () => {
  const x = r(cenarioCofinanciado({ billing: billing(registro({ details: [cobranca("CXDE", 16.15, { mkt: "SHIPPING" })] })) }));
  assert.equal(x.estado, "NAO_CONCILIADO");
  tem(x, MOTIVOS.SEM_COBRANCAS_DE_TARIFA);
});

// ── 5. valores ausentes / inconsistentes ─────────────────────────────────────────────────────────
test("A19 campo ausente ≠ zero: rebate, discount, gross ou net ausentes tornam NAO_CONCILIADO", () => {
  for (const campo of ["gross", "net", "rebate", "discount"]) {
    const reg = registro(); delete reg.sale_fee[campo];
    const x = r(cenarioCofinanciado({ billing: billing(reg) }));
    assert.equal(x.estado, "NAO_CONCILIADO", campo);
    tem(x, MOTIVOS.CAMPO_BILLING_AUSENTE);
    assert.equal(x.centavos.billing[campo], null, campo);
  }
  const semObjeto = registro(); delete semObjeto.sale_fee;
  assert.equal(r(cenarioCofinanciado({ billing: billing(semObjeto) })).estado, "NAO_CONCILIADO");
});

test("A20 sale_fee do pedido ausente ou inválido: NAO_CONCILIADO", () => {
  for (const sf of [undefined, null, "abc", 5.4723]) {
    const x = r(cenarioCofinanciado({ pedido: pedido({ order_items: [{ item: { id: "MLB100" }, quantity: 1, unit_price: 57.54, sale_fee: sf }] }) }));
    assert.equal(x.estado, "NAO_CONCILIADO", String(sf));
    tem(x, MOTIVOS.SALE_FEE_PEDIDO_INVALIDO);
  }
});

test("A21 valores monetários inválidos no Billing (string, fração de centavo, negativo): NAO_CONCILIADO, nunca arredonda", () => {
  for (const reg of [registro({ net: "5,47" }), registro({ net: 5.4749 }), registro({ rebate: -1.15, gross: 4.32 })]) {
    const x = r(cenarioCofinanciado({ billing: billing(reg) }));
    assert.equal(x.estado, "NAO_CONCILIADO");
    tem(x, MOTIVOS.VALOR_INVALIDO);
  }
});

test("A22 aritmética em centavos inteiros (sem erro de ponto flutuante): 0,1 + 0,2 fecha 0,3", () => {
  const x = r({ pedido: pedido({ order_items: [{ item: { id: "MLB100" }, quantity: 1, unit_price: 50, sale_fee: 0.3 }] }),
    descontos: descontos({ total: 10, seller: 10, fm: "seller" }),
    billing: billing(registro({ gross: 0.3, net: 0.3, rebate: 0, details: [cobranca("CVVML", 0.1), cobranca("CVVPRC", 0.2)] })), conta: CONTA });
  assert.equal(x.estado, "TARIFA_LIQUIDA_COMPROVADA");
  assert.equal(x.centavos.cobrancas_tarifa, 30);
});

test("A23 pedido inválido ou sem itens: NAO_CONCILIADO (não lança)", () => {
  for (const p of [null, undefined, {}, { id: 1 }, { id: 5000001, order_items: [] }]) {
    const x = r({ pedido: p, descontos: null, billing: billing(registro()), conta: CONTA });
    assert.equal(x.estado, "NAO_CONCILIADO");
    tem(x, MOTIVOS.PEDIDO_INVALIDO);
  }
  assert.equal(r(undefined).estado, "NAO_CONCILIADO");
});

// ── 6. discount ≠ rebate ─────────────────────────────────────────────────────────────────────────
test("D1 discount do Billing fica SEPARADO do rebate e, por não ter sido observado em produção, é conservador", () => {
  // gross 7,62 − net 5,47 = 2,15 = rebate 1,15 + discount 1,00 (identidade fecha, mas discount > 0 não foi validado)
  const x = r(cenarioCofinanciado({ billing: billing(registro({ gross: 7.62, net: 5.47, rebate: 1.15, discount: 1 })) }));
  assert.equal(x.estado, "NAO_CONCILIADO");
  tem(x, MOTIVOS.DISCOUNT_BILLING_NAO_VALIDADO);
  assert.equal(x.centavos.billing.rebate, 115);
  assert.equal(x.centavos.billing.discount, 100);
  assert.equal(x.rebate.billing_centavos, 115); // o discount NÃO é contado como rebate
  assert.equal(x.motivos.includes(MOTIVOS.IDENTIDADE_GROSS_NET), false);
});

test("D2 discount > 0 sem fechar a identidade: escopo conservador prevalece e a violação fica registrada", () => {
  const x = r(cenarioCofinanciado({ billing: billing(registro({ discount: 1 })) }));
  assert.equal(x.estado, "NAO_CONCILIADO"); // escopo conservador prevalece…
  tem(x, MOTIVOS.DISCOUNT_BILLING_NAO_VALIDADO);
  tem(x, MOTIVOS.IDENTIDADE_GROSS_NET); // …mas a violação da identidade fica registrada
});

// ── 7. casos não validados: estado conservador com motivos explícitos ────────────────────────────
test("N1 cupom e cashback em /discounts: NAO_CONCILIADO", () => {
  const cupom = { type: "coupon", supplier: {}, items: [{ id: "MLB100", quantity: 1, amounts: { total: 2, seller: 2 } }] };
  const cash = { type: "cashback", supplier: {}, items: [{ id: "MLB100", quantity: 1, amounts: { total: 1, seller: 0 } }] };
  const a = r(cenarioCofinanciado({ descontos: descontos({ extra: [cupom] }) }));
  assert.equal(a.estado, "NAO_CONCILIADO"); tem(a, MOTIVOS.CUPOM_NAO_VALIDADO);
  const b = r(cenarioCofinanciado({ descontos: descontos({ extra: [cash] }) }));
  assert.equal(b.estado, "NAO_CONCILIADO"); tem(b, MOTIVOS.CASHBACK_NAO_VALIDADO);
  assert.equal(a.escopo_validado, false);
});

test("N2 quantidade maior que 1: NAO_CONCILIADO", () => {
  const x = r(cenarioCofinanciado({ pedido: pedido({ order_items: [{ item: { id: "MLB100" }, quantity: 2, unit_price: 57.54, sale_fee: 2.735 }] }) }));
  assert.equal(x.estado, "NAO_CONCILIADO");
  tem(x, MOTIVOS.QUANTIDADE_MAIOR_QUE_1);
});

test("N3 pedido com múltiplos itens: NAO_CONCILIADO", () => {
  const x = r(cenarioCofinanciado({ pedido: pedido({ order_items: [
    { item: { id: "MLB100" }, quantity: 1, unit_price: 57.54, sale_fee: 3 }, { item: { id: "MLB200" }, quantity: 1, unit_price: 20, sale_fee: 2.47 }] }) }));
  assert.equal(x.estado, "NAO_CONCILIADO");
  tem(x, MOTIVOS.MULTIPLOS_ITENS);
});

test("N4 cancelamento e reembolso (pedido, pagamento ou Billing): NAO_CONCILIADO", () => {
  const a = r(cenarioCofinanciado({ pedido: pedido({ status: "cancelled" }) }));
  assert.equal(a.estado, "NAO_CONCILIADO"); tem(a, MOTIVOS.CANCELAMENTO_OU_REEMBOLSO);
  const b = r(cenarioCofinanciado({ pedido: pedido({ payments: [{ id: 7001, status: "approved", transaction_amount_refunded: 10 }] }) }));
  assert.equal(b.estado, "NAO_CONCILIADO"); tem(b, MOTIVOS.CANCELAMENTO_OU_REEMBOLSO);
  const c = r(cenarioCofinanciado({ billing: billing(registro({ details: [cobranca("CVVML", 5.42), cobranca("CVVPRC", 0.05), cobranca("CBONUS", 1, { detail_type: "BONUS" })] })) }));
  assert.equal(c.estado, "NAO_CONCILIADO"); tem(c, MOTIVOS.BILLING_COM_BONIFICACAO_OU_CREDITO);
  const d = r(cenarioCofinanciado({ billing: billing({ ...registro(), payment_info: [{ payment_id: 7001, status: "refunded" }] }) }));
  assert.equal(d.estado, "NAO_CONCILIADO"); tem(d, MOTIVOS.CANCELAMENTO_OU_REEMBOLSO);
});

test("N5 parte do ML em /discounts com funding_mode que não é sale_fee: NAO_CONCILIADO (semântica não validada)", () => {
  const x = r(cenarioCofinanciado({ descontos: descontos({ fm: "other_mode" }) }));
  assert.equal(x.estado, "NAO_CONCILIADO");
  tem(x, MOTIVOS.FUNDING_MODE_NAO_VALIDADO);
});

test("N6 /discounts NÃO consultado: NAO_CONCILIADO (sem o detalhe não se sabe se há cupom/cashback; ausência ≠ 'não há')", () => {
  for (const d of [null, undefined]) {
    const x = r(cenarioCofinanciado({ descontos: d }));
    assert.equal(x.estado, "NAO_CONCILIADO");
    tem(x, MOTIVOS.DESCONTOS_NAO_VERIFICADOS);
    assert.equal(x.rebate.billing_centavos, 115); // o que o Billing observou continua visível…
    assert.equal(x.rebate.calculado_descontos_centavos, null); // …mas nada foi calculado
    assert.equal(x.rebate_incorporado, "desconhecido");
  }
});

test("N6b /discounts consultado e SEM detalhes: concilia pelo Billing; o cruzamento do rebate fica indisponível (visível)", () => {
  const x = r(cenarioCofinanciado({ descontos: { details: [] } }));
  assert.equal(x.estado, "TARIFA_LIQUIDA_COMPROVADA");
  assert.equal(x.rebate.concordam, null);
  assert.equal(x.rebate.origem, "billing_observado");
  tem(x, MOTIVOS.CRUZAMENTO_DESCONTOS_INDISPONIVEL);
});

test("N8 todo motivo tem categoria; transitórios são um subconjunto conhecido", () => {
  const { CATEGORIA_MOTIVO, MOTIVOS_TRANSITORIOS } = require("../services/sentinel/sentinelConciliacaoComissao");
  for (const codigo of Object.values(MOTIVOS)) assert.ok(["bloqueio", "escopo", "divergencia", "aviso"].includes(CATEGORIA_MOTIVO[codigo]), codigo);
  assert.equal(Object.keys(CATEGORIA_MOTIVO).length, Object.values(MOTIVOS).length);
  for (const t of MOTIVOS_TRANSITORIOS) assert.ok(CATEGORIA_MOTIVO[t], t);
});

test("N7 item do /discounts que não existe no pedido: NAO_CONCILIADO", () => {
  const x = r(cenarioCofinanciado({ descontos: descontos({ itemId: "MLB404" }) }));
  assert.equal(x.estado, "NAO_CONCILIADO");
  tem(x, MOTIVOS.DESCONTO_SEM_ITEM_CORRESPONDENTE);
});

// ── 8. contrato, pureza e compatibilidade ───────────────────────────────────────────────────────
test("K1 estados são SEMPRE um dos reservados pelo contrato v1; versão declarada", () => {
  assert.equal(CONCILIACAO_CONTRATO_VERSAO, 1);
  const casos = [cenarioCofinanciado(), cenarioCofinanciado({ billing: null }), cenarioCofinanciado({ descontos: descontos({ extra: [{ type: "coupon", items: [] }] }) }),
    cenarioCofinanciado({ pedido: pedido({ order_items: [{ item: { id: "MLB100" }, quantity: 1, unit_price: 57.54, sale_fee: 4.32 }] }) }), undefined];
  for (const c of casos) {
    const x = r(c);
    assert.ok(ESTADOS_CONCILIACAO.includes(x.estado), x.estado);
    assert.equal(x.contrato.versao, 1);
    assert.equal(x.contrato.evidencia_versao, CONTRATO_VERSAO);
    assert.equal(x.efeito_na_margem, "nenhum");
    assert.deepEqual(x.motivos, [...new Set(x.motivos)].sort()); // únicos e ordenados (determinístico)
  }
});

test("K2 PURA: não altera as entradas, é determinística e não depende de relógio", () => {
  const e = cenarioCofinanciado();
  const antes = JSON.stringify(e);
  const a = r(e), b = r(e);
  assert.equal(JSON.stringify(e), antes);
  assert.deepEqual(a, b);
});

test("K3 a saída é serializável e NÃO carrega dados pessoais do Billing (nickname, payer, endereço)", () => {
  const reg = registro();
  reg.details[0].sales_info[0].payer_nickname = "COMPRADOR_FICTICIO";
  reg.details[0].sales_info[0].state_name = "Estado X";
  reg.payment_info[0].payer_id = 424242;
  const s = JSON.stringify(r(cenarioCofinanciado({ billing: billing(reg) })));
  for (const proibido of ["COMPRADOR_FICTICIO", "Estado X", "424242", "payer", "nickname"]) assert.equal(s.includes(proibido), false, proibido);
});

test("K4 aceita o registro único (sem envelope results) e ids como string", () => {
  const x = r({ pedido: pedido({ id: "5000001" }), descontos: descontos(), billing: registro({ order_id: "5000001" }), conta: CONTA });
  assert.equal(x.estado, "TARIFA_LIQUIDA_COMPROVADA");
  assert.equal(x.pedido_id, "5000001");
});

test("K5 nunca devolve crédito/ajuste: nenhum campo de margem, lucro ou crédito na saída", () => {
  const x = r(cenarioCofinanciado());
  const s = JSON.stringify(Object.keys(x)) + JSON.stringify(Object.keys(x.centavos));
  for (const proibido of ["margem_ajustada", "lucro", "credito", "credito_max", "ajuste"]) assert.equal(s.includes(proibido), false, proibido);
});

test("K6 não toca no módulo de evidência existente (exports preservados)", () => {
  const m = require("../services/sentinel/sentinelEvidenciaFinanceira");
  assert.deepEqual([...m.ESTADOS_CONCILIACAO], ["NAO_CONCILIADO", "TARIFA_LIQUIDA_COMPROVADA", "TARIFA_BRUTA_COMPROVADA", "DIVERGENTE"]);
  assert.equal(typeof m.adaptarDetalheDescontos, "function");
  assert.equal(m.CONTRATO_VERSAO, 1);
});
