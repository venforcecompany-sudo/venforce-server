// server/tests/fechamentoFinanceiroShopee.test.js
// Regressões do fechamento financeiro da Shopee:
// motor real por pedido, contagem por pedido, cancelamentos × devoluções ×
// não pagos, TACoX com afiliados, receita sem custo e cupom/rebate sem
// duplicação.

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
  processShopee,
  buildShopeeCostMap,
  getShopeeFeesByTicket,
  parseShopeeOrderAllForStatus,
  buildShopeeStatusSummary,
  buildShopeePerfSkuBridge,
} = require("../services/fechamentoFinanceiro/shopeePerformanceService");
const {
  processShopeeFinancialOrders,
  collapseOrderLevelValue,
  resolveFeeComponent,
  isShopeeFinancialOrderSheet,
} = require("../services/fechamentoFinanceiro/shopeeOrderAllService");

Module._load = originalLoad;

const { round2 } = require("../utils/numberUtils");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, label);
  checks += 1;
  console.log(`  ok  ${label}`);
}
function eq(label, actual, expected) {
  assert.strictEqual(actual, expected, `${label}: ${actual} !== ${expected}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

// Linha da planilha financeira (Order.all) com os nomes reais das colunas.
function linhaFinanceira(overrides) {
  return {
    "ID do pedido": "",
    "Status do pedido": "Concluído",
    "Status da devolução / reembolso": "",
    "Nome do produto": "Produto",
    "SKU da variação": "",
    Quantidade: 1,
    "Preço acordado": 0,
    "Subtotal do produto": 0,
    Repasse: "",
    "Total global": "",
    "Taxa de transação": "",
    "Taxa de comissão líquida": "",
    "Taxa de comissão bruta": "",
    "Taxa de serviço líquida": "",
    "Taxa de serviço bruta": "",
    "Valor estimado do frete": "",
    Imposto: "",
    CMV: "",
    ...overrides,
  };
}

// ── Teste 1 — Shopee real calcula por pedido, não por ticket médio ─────────
console.log("\n▸ Teste 1 — motor real calcula por pedido");
{
  const rows = [
    linhaFinanceira({
      "ID do pedido": "A",
      "Nome do produto": "Item A",
      "SKU da variação": "SKU-A",
      "Subtotal do produto": 70,
      "Preço acordado": 70,
      // Taxas reais do pedido A
      "Taxa de comissão líquida": -14,
      "Taxa de transação": -1.4,
    }),
    linhaFinanceira({
      "ID do pedido": "B",
      "Nome do produto": "Item B",
      "SKU da variação": "SKU-B",
      "Subtotal do produto": 90,
      "Preço acordado": 90,
      // Taxas reais do pedido B — proporção diferente da do pedido A
      "Taxa de comissão líquida": -12.6,
      "Taxa de transação": -1.8,
    }),
  ];

  ok("planilha é reconhecida como financeira", isShopeeFinancialOrderSheet(rows));

  const costMap = buildShopeeCostMap([
    { sku: "SKU-A", custo: 10, imposto: 0 },
    { sku: "SKU-B", custo: 10, imposto: 0 },
  ]);
  const r = processShopeeFinancialOrders({ salesRowsRaw: rows, costMap, ads: 0 });

  eq("modo de cálculo é real", r.summary.calculationMode, "real_financial");

  const pedidoA = r.detailedRows.find((row) => row["ID do pedido"] === "A");
  const pedidoB = r.detailedRows.find((row) => row["ID do pedido"] === "B");

  eq("pedido A usa a própria comissão real", pedidoA["Taxa de comissão"], 14);
  eq("pedido B usa a própria comissão real", pedidoB["Taxa de comissão"], 12.6);
  eq("receita líquida do pedido A", pedidoA["Receita líquida"], 54.6);
  eq("receita líquida do pedido B", pedidoB["Receita líquida"], 75.6);
  eq("LC do pedido A", pedidoA.LC, 44.6);
  eq("LC do pedido B", pedidoB.LC, 65.6);

  // Uma única faixa sobre o ticket médio de R$ 80,00 daria 14% + R$ 16 fixos
  // para os dois pedidos — resultado bem diferente do real.
  const faixaTicketMedio = getShopeeFeesByTicket(80);
  const lcSeFosseFaixaUnica = round2(
    70 - 70 * (faixaTicketMedio.commissionPercent / 100) - faixaTicketMedio.fixedFeePerUnit - 10
  );
  ok(
    "não aplica faixa única do ticket médio (R$ 80,00)",
    pedidoA.LC !== lcSeFosseFaixaUnica
  );
  eq("faixa por ticket difere entre 70 e 90", getShopeeFeesByTicket(70).commissionPercent, 20);
  eq("faixa do ticket médio agregado seria outra", faixaTicketMedio.commissionPercent, 14);
}

// ── Teste 5 — contagem Shopee por pedido, não por linha ───────────────────
console.log("\n▸ Teste 5 — pedido cancelado com três produtos conta 1");
{
  const rows = [1, 2, 3].map((n) =>
    linhaFinanceira({
      "ID do pedido": "C-1",
      "Status do pedido": "Cancelado",
      "Nome do produto": `Produto ${n}`,
      "SKU da variação": `SKU-${n}`,
      "Subtotal do produto": 30,
      Repasse: 0,
    })
  );

  const costMap = buildShopeeCostMap([
    { sku: "SKU-1", custo: 5 },
    { sku: "SKU-2", custo: 5 },
    { sku: "SKU-3", custo: 5 },
  ]);
  const r = processShopeeFinancialOrders({ salesRowsRaw: rows, costMap });

  eq("cancelledCount = 1 (não 3)", r.summary.cancelledCount, 1);
  eq("faturamento perdido soma os 3 itens", r.summary.cancelledLostRevenue, 90);
  eq("pedido cancelado não entra na receita", r.summary.grossRevenueTotal, 0);
  eq("os 3 itens continuam na auditoria", r.auditRows.length, 3);
}

// A mesma regra vale na reconciliação Order.all do motor de performance.
{
  const orderAllRows = [1, 2, 3].map((n) => ({
    "ID do pedido": "C-9",
    "Status do pedido": "Cancelado",
    "Nome do produto": `Produto ${n}`,
    "Subtotal do produto": 20,
    "Nº de referência do SKU principal": `SKU-${n}`,
  }));
  const itens = parseShopeeOrderAllForStatus(orderAllRows);
  const resumo = buildShopeeStatusSummary(itens, new Map(), new Map());

  eq("Order.all: cancelledCount = 1", resumo.cancelledCount, 1);
  eq("Order.all: total de pedidos = 1", resumo.orderAllTotalCount, 1);
  eq("Order.all: faturamento soma os 3 itens", resumo.cancelledLostRevenue, 60);
}

// ── Teste 3.3 — cancelado × devolução × não pago ──────────────────────────
console.log("\n▸ Cancelamentos, devoluções e não pagos são separados");
{
  const rows = [
    linhaFinanceira({
      "ID do pedido": "P-OK",
      "Status do pedido": "Concluído",
      "SKU da variação": "SKU-A",
      "Subtotal do produto": 100,
      Repasse: 80,
      CMV: 30,
    }),
    linhaFinanceira({
      "ID do pedido": "P-CANC",
      "Status do pedido": "Cancelado",
      "SKU da variação": "SKU-A",
      "Subtotal do produto": 50,
      Repasse: 0,
    }),
    linhaFinanceira({
      "ID do pedido": "P-NAOPAGO",
      "Status do pedido": "Cancelado",
      "Cancelar Motivo": "Pedido não pago",
      "SKU da variação": "SKU-A",
      "Subtotal do produto": 40,
      Repasse: 0,
    }),
    linhaFinanceira({
      "ID do pedido": "P-DEV",
      "Status do pedido": "Entregue",
      "Status da devolução / reembolso": "Reembolso concluído",
      "SKU da variação": "SKU-A",
      "Subtotal do produto": 30,
      Repasse: 0,
    }),
  ];

  const costMap = buildShopeeCostMap([{ sku: "SKU-A", custo: 20 }]);
  const r = processShopeeFinancialOrders({ salesRowsRaw: rows, costMap });

  eq("cancelado confirmado = 1", r.summary.cancelledCount, 1);
  eq("receita do cancelado", r.summary.cancelledLostRevenue, 50);
  eq("não pago não vira cancelamento", r.summary.unpaidCount, 1);
  eq("receita do não pago", r.summary.unpaidLostRevenue, 40);
  eq("devolução não vira cancelamento", r.summary.returnRefundCount, 1);
  eq("receita da devolução", r.summary.returnRefundRevenue, 30);
  eq("entregue com devolução posterior é devolução", r.summary.orderAllDeliveredCount, 0);
  ok("refundsTotal não fica zerado quando há devolução", r.summary.refundsTotal !== 0);
  eq("refundsCount reflete as devoluções", r.summary.refundsCount, 1);
  eq("só o pedido válido entra na receita", r.summary.grossRevenueTotal, 100);
}

// ── Teste 8 — cupom/rebate sem duplicação e taxa líquida × bruta ──────────
console.log("\n▸ Teste 8 — cupom/rebate e taxas sem duplicação");
{
  eq(
    "líquida preferida quando presente",
    resolveFeeComponent(-5, true, -8, true).value,
    5
  );
  eq(
    "bruta só quando a líquida está ausente",
    resolveFeeComponent("", false, -8, true).value,
    8
  );
  eq(
    "líquida com valor zero ainda vence a bruta",
    resolveFeeComponent(0, true, -8, true).value,
    0
  );
  eq(
    "componente ausente vale zero e é marcado",
    resolveFeeComponent("", false, "", false).present,
    false
  );

  // Campo de nível pedido repetido em cada linha do item conta uma única vez.
  const repetido = collapseOrderLevelValue([
    { present: true, value: 80 },
    { present: true, value: 80 },
  ]);
  eq("repasse repetido conta uma vez", repetido.value, 80);
  eq("repasse repetido é de nível pedido", repetido.mode, "pedido");

  const porLinha = collapseOrderLevelValue([
    { present: true, value: 30 },
    { present: true, value: 50 },
  ]);
  eq("valores distintos somam", porLinha.value, 80);
  eq("valores distintos são por linha", porLinha.mode, "linha");

  const rows = [
    linhaFinanceira({
      "ID do pedido": "R-1",
      "Nome do produto": "Item 1",
      "SKU da variação": "SKU-A",
      "Subtotal do produto": 60,
      Quantidade: 1,
      // Campos de nível pedido, repetidos nas duas linhas:
      Repasse: 80,
      "Taxa de comissão líquida": -14,
      "Taxa de comissão bruta": -20,
      "Taxa de serviço líquida": -6,
      "Taxa de serviço bruta": -9,
      "Cupom do vendedor": -10,
      "Rebate Shopee": 5,
      CMV: 20,
    }),
    linhaFinanceira({
      "ID do pedido": "R-1",
      "Nome do produto": "Item 2",
      "SKU da variação": "SKU-B",
      "Subtotal do produto": 40,
      Quantidade: 1,
      Repasse: 80,
      "Taxa de comissão líquida": -14,
      "Taxa de comissão bruta": -20,
      "Taxa de serviço líquida": -6,
      "Taxa de serviço bruta": -9,
      "Cupom do vendedor": -10,
      "Rebate Shopee": 5,
      CMV: 12,
    }),
  ];

  const costMap = buildShopeeCostMap([
    { sku: "SKU-A", custo: 20 },
    { sku: "SKU-B", custo: 12 },
  ]);
  const r = processShopeeFinancialOrders({ salesRowsRaw: rows, costMap });

  eq("receita bruta do pedido", r.summary.grossRevenueTotal, 100);
  eq("repasse contado uma vez (não 160)", r.summary.paidRevenueTotal, 80);
  eq(
    "comissão registrada uma vez e pela líquida (não 14+20)",
    r.detailedRows[0]["Taxa de comissão"],
    14
  );
  eq(
    "serviço registrado uma vez e pela líquida",
    r.detailedRows[0]["Taxa de serviço"],
    6
  );

  const colunas = r.summary.detectedAdjustmentColumns;
  ok("cupom detectado", colunas.includes("Cupom do vendedor"));
  ok("rebate detectado", colunas.includes("Rebate Shopee"));
  ok(
    "cupom/rebate não reaplicados sobre o repasse",
    round2(
      r.detailedRows.reduce((sum, row) => sum + Number(row["Receita líquida"]), 0)
    ) === 80
  );

  // O resultado fecha com a soma dos componentes: repasse − CMV − imposto.
  eq("LC total fecha com os componentes", r.summary.contributionProfitTotal, 48);
  eq(
    "rateio do repasse é proporcional à receita (item 1)",
    r.detailedRows[0]["Receita líquida"],
    48
  );
  eq(
    "rateio do repasse é proporcional à receita (item 2)",
    r.detailedRows[1]["Receita líquida"],
    32
  );
}

// ── Teste 2 — receita sem custo (Shopee) ──────────────────────────────────
console.log("\n▸ Teste 2 — receita sem custo é preservada (Shopee)");
{
  const rows = [
    linhaFinanceira({
      "ID do pedido": "S-1",
      "SKU da variação": "SKU-A",
      "Nome do produto": "Produto A",
      "Subtotal do produto": 100,
      Repasse: 100,
    }),
    linhaFinanceira({
      "ID do pedido": "S-2",
      "SKU da variação": "SKU-SEM-CUSTO",
      "Nome do produto": "Produto B",
      "Subtotal do produto": 100,
      Repasse: 100,
    }),
  ];

  const costMap = buildShopeeCostMap([{ sku: "SKU-A", custo: 40 }]);
  const r = processShopeeFinancialOrders({ salesRowsRaw: rows, costMap, ads: 20 });

  eq("grossRevenueTotal = 200", r.summary.grossRevenueTotal, 200);
  eq("revenueWithCost = 100", r.summary.revenueWithCost, 100);
  eq("revenueWithoutCost = 100", r.summary.revenueWithoutCost, 100);
  eq("tacos = 0.10", round2(r.summary.tacos * 100) / 100, 0.1);
  eq("financialConfidence = parcial", r.summary.financialConfidence, "parcial");
  eq("sem FULL informado: fullCostTotal = 0", r.summary.fullCostTotal, 0);

  // FULL manual (Shopee): sai só do resultado final, como no Mercado Livre.
  const comFull = processShopeeFinancialOrders({ salesRowsRaw: rows, costMap, ads: 20, fullCost: 15.5 });
  eq("FULL desconta do resultado final", comFull.summary.finalResult, round2(r.summary.finalResult - 15.5));
  eq("fullCostTotal no resumo", comFull.summary.fullCostTotal, 15.5);
  eq("FULL não mexe no LC", comFull.summary.contributionProfitTotal, r.summary.contributionProfitTotal);
  eq("FULL não mexe no TACoX", comFull.summary.tacox, r.summary.tacox);

  const semCusto = r.detailedRows.find((row) => row["ID do pedido"] === "S-2");
  ok("Produto B não desaparece", !!semCusto);
  eq("LC do produto sem custo é null", semCusto.LC, null);
  eq("CMV do produto sem custo é null", semCusto.CMV, null);
  eq("receita bruta do produto B preservada", semCusto["Receita bruta"], 100);
}

// ── Teste 6 — TACoX inclui afiliados (Shopee) ────────────────────────────
console.log("\n▸ Teste 6 — TACoX inclui afiliados (Shopee)");
{
  const rows = [
    linhaFinanceira({
      "ID do pedido": "T-1",
      "SKU da variação": "SKU-A",
      "Subtotal do produto": 1000,
      Repasse: 800,
      Quantidade: 10,
    }),
  ];
  const costMap = buildShopeeCostMap([{ sku: "SKU-A", custo: 20 }]);
  const r = processShopeeFinancialOrders({
    salesRowsRaw: rows,
    costMap,
    ads: 50,
    venforce: 100,
    affiliates: 20,
  });

  eq("faturamento = 1000", r.summary.grossRevenueTotal, 1000);
  eq("TACoS = 5%", round2(r.summary.tacos * 100), 5);
  eq("TACoX = 17%", round2(r.summary.tacox * 100), 17);
}

// ── LC Total × Resultado Final ────────────────────────────────────────────
console.log("\n▸ LC Total e Resultado Final são grandezas distintas");
{
  const rows = [
    linhaFinanceira({
      "ID do pedido": "L-1",
      "SKU da variação": "SKU-A",
      "Subtotal do produto": 200,
      Repasse: 160,
      Quantidade: 1,
    }),
  ];
  const costMap = buildShopeeCostMap([{ sku: "SKU-A", custo: 60 }]);
  const r = processShopeeFinancialOrders({
    salesRowsRaw: rows,
    costMap,
    ads: 10,
    venforce: 20,
    affiliates: 5,
  });

  eq("LC Total antes de Ads/Venforce/Afiliados", r.summary.contributionProfitTotal, 100);
  eq("Resultado Final descontado de tudo", r.summary.finalResult, 65);
  ok(
    "LC Total e Resultado Final não são o mesmo número",
    r.summary.contributionProfitTotal !== r.summary.finalResult
  );
  eq("MC calculada = LC / receita com custo", r.summary.contributionMarginCalculated, 0.5);
  eq("MC final = Resultado / receita com custo", r.summary.finalMarginCalculated, 0.325);
}

// ── Motor de performance continua funcionando e marcado como estimativa ──
console.log("\n▸ Motor de performance segue disponível e marcado como estimado");
{
  const perfRows = [
    {
      "ID do item": "111",
      "ID da variação": "",
      Produto: "Produto A",
      "Vendas (Pedido pago) (BRL)": 200,
      "Unidades (Pedido pago)": 2,
      "Impressão do produto": 10,
      "Cliques por produto": 2,
      CTR: "20%",
    },
    {
      "ID do item": "999",
      "ID da variação": "",
      Produto: "Produto sem custo",
      "Vendas (Pedido pago) (BRL)": 100,
      "Unidades (Pedido pago)": 1,
      "Impressão do produto": 5,
      "Cliques por produto": 1,
      CTR: "20%",
    },
  ];
  const costRows = [{ id: "111", custo: 20, imposto: 0 }];

  const r = processShopee(perfRows, costRows, 30, 0, 0, null);

  eq("modo estimado", r.summary.calculationMode, "estimated_performance");
  eq("faturamento inclui a receita sem custo", r.summary.grossRevenueTotal, 300);
  eq("receita com custo", r.summary.revenueWithCost, 200);
  eq("receita sem custo", r.summary.revenueWithoutCost, 100);
  eq("confiança parcial", r.summary.financialConfidence, "parcial");
  eq("TACoS sobre o faturamento total", round2(r.summary.tacos * 100), 10);
  // FULL manual no motor de performance (8º argumento, opcional).
  const comFull = processShopee(perfRows, costRows, 30, 0, 0, null, null, 12);
  eq("performance: FULL desconta do resultado final", comFull.summary.finalResult, round2(r.summary.finalResult - 12));
  eq("performance: fullCostTotal no resumo", comFull.summary.fullCostTotal, 12);
  ok(
    "nota executiva avisa que é estimativa",
    r.summary.executiveNotes.some((note) => note.includes("Estimativa por performance"))
  );
  const semCusto = r.detailedRows.find((row) => row.ID === "999");
  ok("produto sem custo continua no detalhamento", !!semCusto);
  eq("LC do produto sem custo é null", semCusto.LC, null);
  ok(
    "nenhum campo numérico do summary é NaN/Infinity",
    Object.values(r.summary).every(
      (value) => typeof value !== "number" || Number.isFinite(value)
    )
  );
}

console.log(`\n${checks} verificações passaram. Fechamento Shopee OK.`);
