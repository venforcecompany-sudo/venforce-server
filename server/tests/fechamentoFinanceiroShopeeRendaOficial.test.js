// server/tests/fechamentoFinanceiroShopeeRendaOficial.test.js
// Referência financeira: pedidos reais do Order.all (nov/2026) cuja "Renda do
// pedido" foi conferida diretamente na Central do Vendedor da Shopee.
//
// IDs anonimizados (o repositório é público); os valores das colunas são os do
// arquivo original. A Renda oficial inclui duas deduções que NÃO existem no
// Order.all e, portanto, ficam fora do líquido do motor:
//   • Taxa de Devolução Fácil: R$ 0,49 por PEDIDO (uma única cobrança mesmo no
//     pedido com 2 produtos / 3 unidades — REF-D);
//   • comissão de afiliados do pedido (REF-A: R$ 3,12), que o fechamento trata
//     pelo campo manual "Afiliados", fora do LC.
// Logo: líquido do motor = Renda oficial + 0,49 (+ afiliado, quando houver).
//
// Regras que estes casos provam:
//   1. cupom do vendedor, Cupom e PIX saem do Subtotal; a Shopee compensa
//      Cupom + PIX pela redução das taxas ("Ajuste por participação em ação
//      comercial" = bruta − líquida) e, quando o ajuste não cobre tudo, pelo
//      "Incentivo de cupom" creditado direto na Renda (REF-A, REF-C);
//   2. moedas Shopee e desconto de cartão saem do Total global, mas não do
//      líquido do vendedor (REF-B, REF-C, REF-F);
//   3. Total global acima dos componentes (AMP — acréscimo por método de
//      pagamento, deduzido na própria Renda) não é receita (REF-G);
//   4. Total global abaixo dos componentes sem coluna explicativa (vale-presente)
//      não reduz o líquido (REF-E).

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

// Valores do Order.all original, sem colunas zeradas além das de taxa.
const CASOS = [
  {
    id: "REF-A", renda: 134.95, afiliado: 3.12,
    nota: "incentivo de cupom 11,55 (ajuste 43,30 + incentivo 11,55 = Cupom 54,85)",
    linhas: [{
      Quantidade: 1, "Preço acordado": 184.89, "Subtotal do produto": 184.89,
      Cupom: 54.85, "Incentivo de cupom": 11.55,
      "Ajuste por participação em ação comercial": 43.30,
      "Taxa de comissão bruta": 23.30, "Taxa de comissão líquida": 0,
      "Taxa de serviço bruta": 23.03, "Taxa de serviço líquida": 3.03,
      "Total global": 130.04, "Valor estimado do frete": 14.48,
    }],
  },
  {
    id: "REF-B", renda: 67.70,
    nota: "cupom do vendedor 2,00 + moedas Shopee 19,98 repostas",
    linhas: [{
      Quantidade: 1, "Preço acordado": 99.90, "Subtotal do produto": 99.90,
      "Cupom do vendedor": 2.00, "Compensar Moedas Shopee": 1998,
      "Taxa de comissão bruta": 12.34, "Taxa de comissão líquida": 12.34,
      "Taxa de serviço bruta": 17.37, "Taxa de serviço líquida": 17.37,
      "Total global": 84.31, "Valor estimado do frete": 12.04,
    }],
  },
  {
    id: "REF-C", renda: 50.13,
    nota: "incentivo de cupom 15,99 (ajuste 17,31 + incentivo 15,99 = Cupom 33,30) + moedas",
    linhas: [{
      Quantidade: 1, "Preço acordado": 69.89, "Subtotal do produto": 69.89,
      "Cupom do vendedor": 1.00, Cupom: 33.30, "Incentivo de cupom": 15.99,
      "Compensar Moedas Shopee": 889,
      "Ajuste por participação em ação comercial": 17.31,
      "Taxa de comissão bruta": 12.81, "Taxa de comissão líquida": 0,
      "Taxa de serviço bruta": 5.46, "Taxa de serviço líquida": 0.96,
      "Total global": 26.70, "Valor estimado do frete": 9.62,
    }],
  },
  {
    id: "REF-D", renda: 277.49,
    nota: "2 produtos / 3 unidades, PIX 19,18, uma única Devolução Fácil",
    linhas: [199.80, 184.90].map((subtotal, i) => ({
      Quantidade: i === 0 ? 2 : 1, "Preço acordado": i === 0 ? 99.90 : 184.90,
      "Subtotal do produto": subtotal,
      "Cupom do vendedor": 1.00, "Ajuste por pagamento via PIX": 19.18,
      "Ajuste por participação em ação comercial": 19.18,
      "Taxa de comissão bruta": 48.35, "Taxa de comissão líquida": 39.11,
      "Taxa de serviço bruta": 57.37, "Taxa de serviço líquida": 47.43,
      "Total global": 364.52, "Valor estimado do frete": 32.37,
    })),
  },
  {
    id: "REF-E", renda: 34.92,
    nota: "Total global 7,23 (vale-presente sem coluna) não reduz o líquido",
    linhas: [{
      Quantidade: 1, "Preço acordado": 49.89, "Subtotal do produto": 49.89,
      "Taxa de comissão bruta": 9.28, "Taxa de comissão líquida": 9.28,
      "Taxa de serviço bruta": 5.20, "Taxa de serviço líquida": 5.20,
      "Total global": 7.23, "Valor estimado do frete": 9.62,
    }],
  },
  {
    id: "REF-F", renda: 73.16,
    nota: "desconto de cartão 10,88 reposto pela Shopee",
    linhas: [{
      Quantidade: 1, "Preço acordado": 109.89, "Subtotal do produto": 109.89,
      "Cupom do vendedor": 1.00, "Total descontado Cartão de Crédito": 10.88,
      "Taxa de comissão bruta": 13.72, "Taxa de comissão líquida": 13.72,
      "Taxa de serviço bruta": 21.52, "Taxa de serviço líquida": 21.52,
      "Total global": 98.01, "Valor estimado do frete": 25.07,
    }],
  },
  {
    id: "REF-G", renda: 133.36,
    nota: "AMP 30,40 no Total global (acréscimo e dedução na Renda) não é receita",
    linhas: [{
      Quantidade: 1, "Preço acordado": 179.89, "Subtotal do produto": 179.89,
      "Cupom do vendedor": 1.00, "Taxa de envio pagas pelo comprador": 6.03,
      "Taxa de comissão bruta": 22.54, "Taxa de comissão líquida": 22.54,
      "Taxa de serviço bruta": 22.50, "Taxa de serviço líquida": 22.50,
      "Total global": 215.32, "Valor estimado do frete": 36.03,
    }],
  },
  {
    id: "REF-K", renda: 64.32,
    nota: "PIX 4,45 com ajuste 9,34 (redução de taxa além do PIX, creditada)",
    linhas: [{
      Quantidade: 1, "Preço acordado": 90.08, "Subtotal do produto": 90.08,
      "Cupom do vendedor": 1.00, "Ajuste por pagamento via PIX": 4.45,
      "Ajuste por participação em ação comercial": 9.34,
      "Taxa de comissão bruta": 11.84, "Taxa de comissão líquida": 7.87,
      "Taxa de serviço bruta": 17.32, "Taxa de serviço líquida": 11.95,
      "Total global": 84.63, "Valor estimado do frete": 18.11,
    }],
  },
  {
    id: "REF-L", renda: 276.01, afiliado: 28.04,
    nota: "PIX + Cupom + cupom do vendedor + moedas; afiliado 28,04",
    linhas: [{
      Quantidade: 1, "Preço acordado": 389.90, "Subtotal do produto": 389.90,
      "Cupom do vendedor": 1.00, Cupom: 37.72, "Ajuste por pagamento via PIX": 17.55,
      "Compensar Moedas Shopee": 74,
      "Ajuste por participação em ação comercial": 55.27,
      "Taxa de comissão bruta": 49.00, "Taxa de comissão líquida": 12.89,
      "Taxa de serviço bruta": 35.36, "Taxa de serviço líquida": 16.20,
      "Total global": 332.89, "Valor estimado do frete": 23.87,
    }],
  },
  {
    id: "REF-M", renda: 308.82,
    nota: "PIX isolado (Renda ESTIMADA, pedido enviado)",
    linhas: [{
      "Status do pedido": "Enviado",
      Quantidade: 1, "Preço acordado": 389.90, "Subtotal do produto": 389.90,
      "Ajuste por pagamento via PIX": 19.49,
      "Ajuste por participação em ação comercial": 19.49,
      "Taxa de comissão bruta": 49.13, "Taxa de comissão líquida": 36.38,
      "Taxa de serviço bruta": 31.46, "Taxa de serviço líquida": 24.72,
      "Total global": 370.41, "Valor estimado do frete": 28.73,
    }],
  },
];

function run(rows) {
  return processShopeeFinancialOrders({
    salesRowsRaw: rows,
    costMap: buildShopeeCostMap([{ sku: "OUTRO-SKU", custo: 1 }]),
  });
}

console.log("\n▸ Renda oficial da Shopee × líquido do motor (pedido a pedido)");
for (const caso of CASOS) {
  const r = run(caso.linhas.map((l) => linha(caso.id, l)));
  const liquido = r2(r.detailedRows.reduce((t, row) => t + row["Receita líquida"], 0));
  const esperado = r2(caso.renda + DEVOLUCAO_FACIL + (caso.afiliado || 0));
  eq(`${caso.id} — ${caso.nota}: líquido ${esperado}`, liquido, esperado);
  eq(`${caso.id} — líquido do pedido = soma das linhas`, r.summary.paidRevenueTotal, esperado);
}

console.log("\n▸ Incentivo de cupom: somado uma vez e declarado");
{
  const a = run(CASOS[0].linhas.map((l) => linha("REF-A", l)));
  eq("REF-A sem incentivo seria 127,01 (subestimado em 11,55)", r2(a.summary.paidRevenueTotal - 11.55), 127.01);
  eq("compensação declarada: 1 pedido", a.summary.shopeeDirectCompensation.couponIncentive.orders, 1);
  eq("compensação declarada: R$ 11,55", a.summary.shopeeDirectCompensation.couponIncentive.total, 11.55);
  eq(
    "nota SHOPEE_COUPON_INCENTIVE presente",
    a.summary.executiveNotes.some((n) => n.includes("SHOPEE_COUPON_INCENTIVE")),
    true
  );
  // Sem Total global (identidade pelas colunas) o incentivo também entra.
  const semTg = run(CASOS[0].linhas.map((l) => {
    const { "Total global": _tg, ...resto } = l;
    return linha("REF-A2", resto);
  }));
  eq("sem Total global: mesmo líquido 138,56", semTg.summary.paidRevenueTotal, 138.56);
}

// ── Devoluções (demonstrativos oficiais, Shopee 1, nov/2026) ──────────────
// Mesmas colunas do Order.all. A Renda oficial fecha com a fórmula + 0,49:
//   REF-H 97,89 − 1,00 − 12,21 − 17,36 = 67,32 → Renda 66,83 (devolução
//         solicitada, sem ajuste até a conferência);
//   REF-I mesmo pedido-tipo, reembolso APROVADO: ajuste −67,32 em 23/11 →
//         valor final −0,49 (a Devolução Fácil fica com o vendedor);
//   REF-J 69,89 − 1,00 − 12,81 − 5,46 = 50,62 → Renda 50,13 (sem ajuste).
// Regra ATUAL documentada aqui (não alterada): qualquer status de
// devolução/reembolso tira o pedido inteiro da receita (receita, taxas e CMV
// zero). O resíduo de −0,49 do reembolso não é representado (Devolução Fácil
// não existe no arquivo). Renda estimada não é tratada como realizada.
function pedidoDevolucao(id, campos, devolucao) {
  return linha(id, { "Status da Devolução / Reembolso": devolucao, ...campos });
}
const REF_H = {
  Quantidade: 1, "Preço acordado": 97.89, "Subtotal do produto": 97.89,
  "Cupom do vendedor": 1.00,
  "Taxa de comissão bruta": 12.21, "Taxa de comissão líquida": 12.21,
  "Taxa de serviço bruta": 17.36, "Taxa de serviço líquida": 17.36,
  "Total global": 105.95, "Valor estimado do frete": 12.04,
};
const REF_J = {
  Quantidade: 1, "Preço acordado": 69.89, "Subtotal do produto": 69.89,
  "Cupom do vendedor": 1.00,
  "Taxa de comissão bruta": 12.81, "Taxa de comissão líquida": 12.81,
  "Taxa de serviço bruta": 5.46, "Taxa de serviço líquida": 5.46,
  "Total global": 68.89, "Valor estimado do frete": 9.62,
};

console.log("\n▸ Devoluções: fórmula da Renda e regra atual de exclusão");
{
  // Sem status de devolução, o líquido é a Renda + Devolução Fácil.
  eq("REF-H sem devolução: líquido 67,32 (Renda 66,83 + 0,49)", run([linha("REF-H", REF_H)]).summary.paidRevenueTotal, r2(66.83 + DEVOLUCAO_FACIL));
  eq("REF-J sem devolução: líquido 50,62 (Renda 50,13 + 0,49)", run([linha("REF-J", REF_J)]).summary.paidRevenueTotal, r2(50.13 + DEVOLUCAO_FACIL));
  // Reembolso aprovado: Renda 66,83 − ajuste 67,32 = −0,49 (resíduo).
  eq("REF-I reembolso aprovado: resíduo oficial = −Devolução Fácil", r2(66.83 - 67.32), -DEVOLUCAO_FACIL);
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
