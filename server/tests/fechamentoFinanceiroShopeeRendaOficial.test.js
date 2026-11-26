// server/tests/fechamentoFinanceiroShopeeRendaOficial.test.js
// Referência financeira do líquido Shopee SEM coluna Repasse.
//
// Os casos reproduzem, com VALORES SINTÉTICOS, a estrutura de pedidos reais
// cuja "Renda do pedido" foi conferida na Central do Vendedor da Shopee
// (nov/2026). Os valores e IDs reais ficam fora do repositório (público);
// aqui só se preservam as mesmas identidades entre as colunas do Order.all.
//
// A Renda oficial inclui duas deduções que NÃO existem no Order.all e ficam
// fora do líquido do motor:
//   • Taxa de Devolução Fácil: R$ 0,49 por PEDIDO (uma única cobrança mesmo
//     em pedido com vários produtos/unidades — REF-D);
//   • comissão de afiliados do pedido, tratada pelo campo manual "Afiliados"
//     do fechamento, fora do LC.
// Logo: líquido do motor = Renda + 0,49 (+ afiliado, quando houver).
//
// Regras que estes casos provam:
//   1. cupom do vendedor, Cupom e PIX saem do Subtotal; a Shopee compensa
//      Cupom + PIX pela redução das taxas ("Ajuste por participação em ação
//      comercial" = bruta − líquida) e, quando o ajuste não cobre tudo, pelo
//      "Incentivo de cupom" creditado direto na Renda (ajuste + incentivo =
//      Cupom + PIX) — REF-A, REF-C;
//   2. moedas Shopee e desconto de cartão saem do Total global, mas não do
//      líquido do vendedor (REF-B, REF-C, REF-F, REF-L);
//   3. Total global acima dos componentes (AMP — acréscimo por método de
//      pagamento, deduzido na própria Renda) não é receita (REF-G);
//   4. Total global abaixo dos componentes sem coluna explicativa
//      (vale-presente) não reduz o líquido (REF-E);
//   5. redução de taxa além do PIX (outra ação comercial) já está nas taxas
//      líquidas e é creditada (REF-K).

const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function loadWithXlsxStub(request, parent, isMain) {
  if (request === "xlsx") {
    return { utils: { aoa_to_sheet: () => ({}), json_to_sheet: () => ({}) } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const {
  processShopeeFinancialOrders,
} = require("../services/fechamentoFinanceiro/shopeeOrderAllService");
const { buildShopeeCostMap } = require("../services/fechamentoFinanceiro/shopeePerformanceService");
Module._load = originalLoad;

let checks = 0;
function eq(label, actual, expected) {
  assert.strictEqual(actual, expected, `${label}: ${actual} !== ${expected}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}
const r2 = (x) => Math.round(x * 100) / 100;
const DEVOLUCAO_FACIL = 0.49;

function linha(id, campos) {
  return {
    "ID do pedido": id,
    "Status do pedido": "Concluído",
    "Nome do Produto": "Produto " + id,
    "Número de referência SKU": "SKU-" + id,
    "Taxa de transação": 0,
    CMV: 10,
    Imposto: 1,
    ...campos,
  };
}

// "renda" = Renda do pedido no formato do demonstrativo (sintética, mesma
// composição do caso real correspondente).
const CASOS = [
  {
    id: "REF-A", renda: 147.51, afiliado: 3.00,
    nota: "incentivo de cupom 15,00 (ajuste 45,00 + incentivo 15,00 = Cupom 60,00)",
    linhas: [{
      Quantidade: 1, "Preço acordado": 200.00, "Subtotal do produto": 200.00,
      Cupom: 60.00, "Incentivo de cupom": 15.00,
      "Ajuste por participação em ação comercial": 45.00,
      "Taxa de comissão bruta": 25.00, "Taxa de comissão líquida": 0,
      "Taxa de serviço bruta": 24.00, "Taxa de serviço líquida": 4.00,
      "Total global": 140.00, "Valor estimado do frete": 15.00,
    }],
  },
  {
    id: "REF-B", renda: 67.51,
    nota: "cupom do vendedor 2,00 + moedas Shopee 20,00 repostas",
    linhas: [{
      Quantidade: 1, "Preço acordado": 100.00, "Subtotal do produto": 100.00,
      "Cupom do vendedor": 2.00, "Compensar Moedas Shopee": 2000,
      "Taxa de comissão bruta": 12.00, "Taxa de comissão líquida": 12.00,
      "Taxa de serviço bruta": 18.00, "Taxa de serviço líquida": 18.00,
      "Total global": 78.00, "Valor estimado do frete": 12.00,
    }],
  },
  {
    id: "REF-C", renda: 50.51,
    nota: "incentivo de cupom 14,00 (ajuste 16,00 + incentivo 14,00 = Cupom 30,00) + moedas",
    linhas: [{
      Quantidade: 1, "Preço acordado": 70.00, "Subtotal do produto": 70.00,
      "Cupom do vendedor": 1.00, Cupom: 30.00, "Incentivo de cupom": 14.00,
      "Compensar Moedas Shopee": 900,
      "Ajuste por participação em ação comercial": 16.00,
      "Taxa de comissão bruta": 12.00, "Taxa de comissão líquida": 0,
      "Taxa de serviço bruta": 6.00, "Taxa de serviço líquida": 2.00,
      "Total global": 30.00, "Valor estimado do frete": 10.00,
    }],
  },
  {
    id: "REF-D", renda: 270.51,
    nota: "2 produtos / 3 unidades, PIX 20,00, uma única Devolução Fácil",
    linhas: [200.00, 180.00].map((subtotal, i) => ({
      Quantidade: i === 0 ? 2 : 1, "Preço acordado": i === 0 ? 100.00 : 180.00,
      "Subtotal do produto": subtotal,
      "Cupom do vendedor": 1.00, "Ajuste por pagamento via PIX": 20.00,
      "Ajuste por participação em ação comercial": 20.00,
      "Taxa de comissão bruta": 50.00, "Taxa de comissão líquida": 40.00,
      "Taxa de serviço bruta": 58.00, "Taxa de serviço líquida": 48.00,
      "Total global": 359.00, "Valor estimado do frete": 32.00,
    })),
  },
  {
    id: "REF-E", renda: 35.51,
    nota: "Total global 8,00 (vale-presente sem coluna) não reduz o líquido",
    linhas: [{
      Quantidade: 1, "Preço acordado": 50.00, "Subtotal do produto": 50.00,
      "Taxa de comissão bruta": 9.00, "Taxa de comissão líquida": 9.00,
      "Taxa de serviço bruta": 5.00, "Taxa de serviço líquida": 5.00,
      "Total global": 8.00, "Valor estimado do frete": 10.00,
    }],
  },
  {
    id: "REF-F", renda: 73.51,
    nota: "desconto de cartão 11,00 reposto pela Shopee",
    linhas: [{
      Quantidade: 1, "Preço acordado": 110.00, "Subtotal do produto": 110.00,
      "Cupom do vendedor": 1.00, "Total descontado Cartão de Crédito": 11.00,
      "Taxa de comissão bruta": 14.00, "Taxa de comissão líquida": 14.00,
      "Taxa de serviço bruta": 21.00, "Taxa de serviço líquida": 21.00,
      "Total global": 98.00, "Valor estimado do frete": 25.00,
    }],
  },
  {
    id: "REF-G", renda: 133.51,
    nota: "AMP 30,00 no Total global (acréscimo e dedução na Renda) não é receita",
    linhas: [{
      Quantidade: 1, "Preço acordado": 180.00, "Subtotal do produto": 180.00,
      "Cupom do vendedor": 1.00, "Taxa de envio pagas pelo comprador": 6.00,
      "Taxa de comissão bruta": 22.00, "Taxa de comissão líquida": 22.00,
      "Taxa de serviço bruta": 23.00, "Taxa de serviço líquida": 23.00,
      "Total global": 215.00, "Valor estimado do frete": 36.00,
    }],
  },
  {
    id: "REF-K", renda: 64.01,
    nota: "PIX 4,50 com ajuste 9,50 (redução de taxa além do PIX, creditada)",
    linhas: [{
      Quantidade: 1, "Preço acordado": 90.00, "Subtotal do produto": 90.00,
      "Cupom do vendedor": 1.00, "Ajuste por pagamento via PIX": 4.50,
      "Ajuste por participação em ação comercial": 9.50,
      "Taxa de comissão bruta": 12.00, "Taxa de comissão líquida": 8.00,
      "Taxa de serviço bruta": 17.50, "Taxa de serviço líquida": 12.00,
      "Total global": 84.50, "Valor estimado do frete": 18.00,
    }],
  },
  {
    id: "REF-L", renda: 276.51, afiliado: 28.00,
    nota: "PIX + Cupom + cupom do vendedor + moedas; afiliado 28,00",
    linhas: [{
      Quantidade: 1, "Preço acordado": 390.00, "Subtotal do produto": 390.00,
      "Cupom do vendedor": 1.00, Cupom: 38.00, "Ajuste por pagamento via PIX": 17.00,
      "Compensar Moedas Shopee": 80,
      "Ajuste por participação em ação comercial": 55.00,
      "Taxa de comissão bruta": 49.00, "Taxa de comissão líquida": 13.00,
      "Taxa de serviço bruta": 35.00, "Taxa de serviço líquida": 16.00,
      "Total global": 333.20, "Valor estimado do frete": 24.00,
    }],
  },
  {
    id: "REF-M", renda: 309.51,
    nota: "PIX isolado (Renda ESTIMADA, pedido enviado)",
    linhas: [{
      "Status do pedido": "Enviado",
      Quantidade: 1, "Preço acordado": 390.00, "Subtotal do produto": 390.00,
      "Ajuste por pagamento via PIX": 19.50,
      "Ajuste por participação em ação comercial": 19.50,
      "Taxa de comissão bruta": 49.00, "Taxa de comissão líquida": 36.50,
      "Taxa de serviço bruta": 31.00, "Taxa de serviço líquida": 24.00,
      "Total global": 370.50, "Valor estimado do frete": 29.00,
    }],
  },
];

function run(rows) {
  return processShopeeFinancialOrders({
    salesRowsRaw: rows,
    costMap: buildShopeeCostMap([{ sku: "OUTRO-SKU", custo: 1 }]),
  });
}

console.log("\n▸ Renda × líquido do motor (pedido a pedido)");
for (const caso of CASOS) {
  const r = run(caso.linhas.map((l) => linha(caso.id, l)));
  const liquido = r2(r.detailedRows.reduce((t, row) => t + row["Receita líquida"], 0));
  const esperado = r2(caso.renda + DEVOLUCAO_FACIL + (caso.afiliado || 0));
  eq(`${caso.id} — ${caso.nota}: líquido ${esperado}`, liquido, esperado);
  eq(`${caso.id} — líquido do pedido = soma das linhas`, r.summary.paidRevenueTotal, esperado);
}

console.log("\n▸ Incentivo de cupom: somado uma vez, sem efeito visual");
{
  const a = run(CASOS[0].linhas.map((l) => linha("REF-A", l)));
  eq("REF-A sem incentivo seria 136,00 (subestimado em 15,00)", r2(a.summary.paidRevenueTotal - 15), 136.00);
  eq("compensação declarada no resumo: 1 pedido", a.summary.shopeeDirectCompensation.couponIncentive.orders, 1);
  eq("compensação declarada no resumo: R$ 15,00", a.summary.shopeeDirectCompensation.couponIncentive.total, 15.00);
  eq(
    "nenhuma nota executiva de incentivo (sem mudança visual)",
    a.summary.executiveNotes.some((n) => n.includes("SHOPEE_COUPON_INCENTIVE")),
    false
  );
  const semIncentivo = run(CASOS[0].linhas.map((l) => linha("REF-A0", { ...l, "Incentivo de cupom": 0 })));
  eq(
    "mesma quantidade de notas que o pedido idêntico sem incentivo",
    a.summary.executiveNotes.length,
    semIncentivo.summary.executiveNotes.length
  );
  // Sem Total global (identidade pelas colunas) o incentivo também entra.
  const semTg = run(CASOS[0].linhas.map((l) => {
    const { "Total global": _tg, ...resto } = l;
    return linha("REF-A2", resto);
  }));
  eq("sem Total global: mesmo líquido 151,00", semTg.summary.paidRevenueTotal, 151.00);

  // Pedido com 2 linhas: colunas de nível pedido repetidas em cada linha.
  const multi = run([60, 40].map((subtotal) => linha("REF-N", {
    Quantidade: 1, "Preço acordado": subtotal, "Subtotal do produto": subtotal,
    Cupom: 30.00, "Incentivo de cupom": 10.00,
    "Ajuste por participação em ação comercial": 20.00,
    "Taxa de comissão bruta": 15.00, "Taxa de comissão líquida": 5.00,
    "Taxa de serviço bruta": 14.00, "Taxa de serviço líquida": 4.00,
    "Total global": 70.00, "Valor estimado do frete": 10.00,
  })));
  eq("2 linhas: incentivo contado uma vez (100 − 30 + 10 − 9 = 71,00)", multi.summary.paidRevenueTotal, 71.00);
  eq("2 linhas: 1 pedido com incentivo", multi.summary.shopeeDirectCompensation.couponIncentive.orders, 1);
  eq("2 linhas: total do incentivo 10,00", multi.summary.shopeeDirectCompensation.couponIncentive.total, 10.00);
  eq("2 linhas: rateio 60/40 → 42,60 + 28,40",
    multi.detailedRows.map((x) => x["Receita líquida"]).join("|"), "42.6|28.4");

  // Com Repasse informado, o repasse já é o líquido: nada é somado.
  const comRepasse = run(CASOS[0].linhas.map((l) => linha("REF-A3", { ...l, Repasse: 150.00 })));
  eq("com Repasse: líquido = repasse (150,00), sem incentivo em duplicidade", comRepasse.summary.paidRevenueTotal, 150.00);
  eq("com Repasse: nenhum incentivo declarado", comRepasse.summary.shopeeDirectCompensation.couponIncentive.orders, 0);
  eq("com Repasse: evidência comprovada", comRepasse.detailedRows[0]["Evidência do líquido"], "comprovado");
}

// ── Devoluções (mesma estrutura de demonstrativos oficiais) ───────────────
//   REF-H 98,00 − 1,00 − 12,00 − 17,50 = 67,50 → Renda 67,01 (devolução
//         solicitada, sem ajuste);
//   REF-I mesmo pedido-tipo, reembolso APROVADO: ajuste −67,50 → valor final
//         −0,49 (a Devolução Fácil fica com o vendedor);
//   REF-J 70,00 − 1,00 − 13,00 − 5,50 = 50,50 → Renda 50,01 (sem ajuste).
// Regra ATUAL documentada aqui (não alterada): qualquer status de
// devolução/reembolso tira o pedido inteiro da receita (receita, taxas e CMV
// zero). O resíduo de −0,49 do reembolso não é representado (Devolução Fácil
// não existe no arquivo). Renda estimada não é tratada como realizada.
function pedidoDevolucao(id, campos, devolucao) {
  return linha(id, { "Status da Devolução / Reembolso": devolucao, ...campos });
}
const REF_H = {
  Quantidade: 1, "Preço acordado": 98.00, "Subtotal do produto": 98.00,
  "Cupom do vendedor": 1.00,
  "Taxa de comissão bruta": 12.00, "Taxa de comissão líquida": 12.00,
  "Taxa de serviço bruta": 17.50, "Taxa de serviço líquida": 17.50,
  "Total global": 106.00, "Valor estimado do frete": 12.00,
};
const REF_J = {
  Quantidade: 1, "Preço acordado": 70.00, "Subtotal do produto": 70.00,
  "Cupom do vendedor": 1.00,
  "Taxa de comissão bruta": 13.00, "Taxa de comissão líquida": 13.00,
  "Taxa de serviço bruta": 5.50, "Taxa de serviço líquida": 5.50,
  "Total global": 69.00, "Valor estimado do frete": 10.00,
};

console.log("\n▸ Devoluções: fórmula da Renda e regra atual de exclusão");
{
  eq("REF-H sem devolução: líquido 67,50 (Renda 67,01 + 0,49)", run([linha("REF-H", REF_H)]).summary.paidRevenueTotal, r2(67.01 + DEVOLUCAO_FACIL));
  eq("REF-J sem devolução: líquido 50,50 (Renda 50,01 + 0,49)", run([linha("REF-J", REF_J)]).summary.paidRevenueTotal, r2(50.01 + DEVOLUCAO_FACIL));
  eq("REF-I reembolso aprovado: resíduo = −Devolução Fácil", r2(67.01 - 67.50), -DEVOLUCAO_FACIL);
  for (const [rotulo, campos, status] of [
    ["REF-H devolução em andamento", REF_H, "Devolução em Andamento"],
    ["REF-I solicitação aprovada", REF_H, "Solicitação aprovada"],
    ["REF-J devolução concluída", REF_J, "Devolução Concluída"],
  ]) {
    const r = run([pedidoDevolucao(rotulo, campos, status)]);
    eq(`${rotulo}: fora da receita pela regra atual`, r.summary.paidRevenueTotal, 0);
    eq(`${rotulo}: contado como devolução`, r.summary.orderAllReturnRefundCount, 1);
  }
}

console.log(`\n✓ ${checks} verificações`);
