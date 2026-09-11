// server/tests/fechamentoFinanceiroShopeeBridgeTituloVariacao.test.js
// FIN-21: último fallback da ponte de identidade Shopee — variação EXATA +
// evidência de título, só tentado quando SKU e produto+variação exatos já
// falharam. Cobre a causa raiz do FIN-21 (~R$ 1.392,10): o título do anúncio
// mudou/foi reordenado entre Order.all e a performance, mas a variação e o
// produto continuam sendo os mesmos.
//
// Fixtures mínimas e anônimas — NÃO usam as planilhas reais do caso FIN-21
// (essas ficam fora do repositório, em ~/Documentos/venforce_financeiro_cases).
//
// Regras protegidas aqui:
//  - variação diferente NUNCA resolve pelo título ("Preto,G" != "Preto,GG");
//  - candidato único e seguro -> resolve como bridge_title_variation;
//  - candidatos empatados com custo/imposto divergentes -> AMBIGUOUS, sem custo;
//  - candidatos empatados com custo/imposto iguais -> equivalência financeira
//    (bridge_title_variation_equivalent), nunca afirma qual Model ID é o certo;
//  - Model ID/SKU direto no Order.all continuam vencendo, sem nunca chegar
//    neste fallback;
//  - custo #N/A ou 0 na base nunca vira custo — e o diagnóstico preserva o
//    valor bruto original (rawCost/costValid) para diferenciar os dois casos.

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
} = require("../services/fechamentoFinanceiro/shopeePerformanceService");
const {
  processShopeeFinancialOrders,
} = require("../services/fechamentoFinanceiro/shopeeOrderAllService");

Module._load = originalLoad;

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

function linhaOrderAll(overrides) {
  return {
    "ID do pedido": "PED-1",
    "Status do pedido": "Concluído",
    "Status da Devolução / Reembolso": "",
    "Nome do Produto": "Produto",
    "Nome da variação": "",
    "Nº de referência do SKU principal": "",
    "Número de referência SKU": "",
    Quantidade: 1,
    "Preço acordado": 0,
    "Subtotal do produto": 0,
    "Taxa de transação": "",
    "Taxa de comissão líquida": "",
    "Taxa de serviço líquida": "",
    "Valor estimado do frete": "",
    Imposto: "",
    CMV: "",
    ...overrides,
  };
}

function linhaPerformance(overrides) {
  return {
    "ID do Item": "",
    Produto: "Produto",
    "Status Atual do Item": "Normal",
    "ID da Variação": "-",
    "Nome da Variação": "-",
    "Status Atual da Variação": "-",
    "SKU da Variação": "-",
    "SKU Principle": "",
    "Vendas (Pedido pago) (BRL)": 0,
    "Unidades (Pedido pago)": 0,
    "Impressão do Produto": 0,
    "Cliques Por Produto": 0,
    CTR: "0%",
    ...overrides,
  };
}

// ── Caso A — título reordenado/editado, candidato único ───────────────────
console.log("\n▸ Caso A — mesma variação, título reordenado, candidato único → resolve");
{
  const orderAll = [
    linhaOrderAll({
      "ID do pedido": "CASE-A",
      "Nome do Produto": "Capa Protetora Anti Impacto Silicone Reforçada Universal Celular Kit",
      "Nome da variação": "Azul,M",
      "Subtotal do produto": 40,
      "Preço acordado": 40,
      "Taxa de comissão líquida": 4,
    }),
  ];
  const performance = [
    linhaPerformance({
      "ID do Item": "ITEM-A",
      "ID da Variação": "MODEL-A1",
      "Nome da Variação": "Azul,M",
      // Mesmas palavras do Order.all, reordenadas e com "Kit" movido —
      // simula o anúncio otimizado pela Shopee entre as duas planilhas.
      Produto: "Kit Capa Silicone Reforçada Anti Impacto Universal Protetora Celular",
    }),
  ];
  const costRows = [{ id: "ITEM-A", "model id": "MODEL-A1", Custo: 12, imposto: 5 }];

  const r = processShopee(performance, costRows, 0, 0, 0, orderAll);
  const linha = r.detailedRows[0];
  eq("origem é bridge_title_variation", linha["Match de custo"], "bridge_title_variation");
  eq("Model ID resolvido é o único candidato", linha["ID resolvido pela ponte"], "MODEL-A1");
  eq("CMV vem do custo da base", linha.CMV, 12);
  eq("nenhuma ambiguidade", r.summary.bridgeAmbiguousCount, 0);
  eq("contador de match por título é incrementado", r.summary.bridgeTitleVariationMatchCount, 1);
  ok(
    "nota executiva do novo fallback aparece",
    r.summary.executiveNotes.some((note) => note.includes("COST_BRIDGE_TITLE_VARIATION"))
  );
}

// ── Caso B — dois candidatos plausíveis, custos diferentes → AMBIGUOUS ────
console.log("\n▸ Caso B — mesma variação, dois candidatos com custos diferentes → sem custo");
{
  const orderAll = [
    linhaOrderAll({
      "ID do pedido": "CASE-B",
      "Nome do Produto": "Bolsa Térmica Fitness Impermeável Grande",
      "Nome da variação": "Cinza,Único",
      "Subtotal do produto": 60,
      "Preço acordado": 60,
      "Taxa de comissão líquida": 6,
    }),
  ];
  // Dois anúncios distintos do mesmo vendedor com o MESMO título (título não
  // desambigua) e a MESMA variação — mas custos diferentes na base.
  const performance = [
    linhaPerformance({
      "ID do Item": "ITEM-B1",
      "ID da Variação": "MODEL-B1",
      "Nome da Variação": "Cinza,Único",
      Produto: "Bolsa Termica Impermeavel Fitness Grande",
    }),
    linhaPerformance({
      "ID do Item": "ITEM-B2",
      "ID da Variação": "MODEL-B2",
      "Nome da Variação": "Cinza,Único",
      Produto: "Bolsa Termica Impermeavel Fitness Grande",
    }),
  ];
  const costRows = [
    { id: "ITEM-B1", "model id": "MODEL-B1", Custo: 25, imposto: 5 },
    { id: "ITEM-B2", "model id": "MODEL-B2", Custo: 40, imposto: 5 },
  ];

  const r = processShopee(performance, costRows, 0, 0, 0, orderAll);
  const linha = r.detailedRows[0];
  eq("custo diferente entre candidatos empatados mantém CMV nulo", linha.CMV, null);
  eq("LC fica desconhecido", linha.LC, null);
  eq("marcado como ambíguo", r.summary.bridgeAmbiguousCount, 1);
  eq("nenhum match por título é contabilizado como resolvido", r.summary.bridgeTitleVariationMatchCount, 0);
  eq("faturamento é preservado mesmo sem custo", r.summary.grossRevenueTotal, 60);

  const gap = r.unmatchedCosts[0];
  eq("diagnóstico tipado como ambiguous_ids", gap.type, "ambiguous_ids");
  ok(
    "os dois Model IDs conflitantes aparecem no diagnóstico",
    gap.candidates.includes("MODEL-B1") && gap.candidates.includes("MODEL-B2")
  );
}

// ── Caso C — múltiplos candidatos, custo e imposto iguais → equivalência ──
console.log("\n▸ Caso C — mesma variação, candidatos empatados com custo/imposto iguais → equivalência financeira");
{
  const orderAll = [
    linhaOrderAll({
      "ID do pedido": "CASE-C",
      "Nome do Produto": "Bolsa Térmica Fitness Impermeável Grande",
      "Nome da variação": "Cinza,Único",
      "Subtotal do produto": 60,
      "Preço acordado": 60,
      "Taxa de comissão líquida": 6,
    }),
  ];
  const performance = [
    linhaPerformance({
      "ID do Item": "ITEM-C1",
      "ID da Variação": "MODEL-C1",
      "Nome da Variação": "Cinza,Único",
      Produto: "Bolsa Termica Impermeavel Fitness Grande",
    }),
    linhaPerformance({
      "ID do Item": "ITEM-C2",
      "ID da Variação": "MODEL-C2",
      "Nome da Variação": "Cinza,Único",
      Produto: "Bolsa Termica Impermeavel Fitness Grande",
    }),
  ];
  const costRows = [
    { id: "ITEM-C1", "model id": "MODEL-C1", Custo: 25, imposto: 5 },
    { id: "ITEM-C2", "model id": "MODEL-C2", Custo: 25, imposto: 5 },
  ];

  const r = processShopee(performance, costRows, 0, 0, 0, orderAll);
  const linha = r.detailedRows[0];
  eq("origem é bridge_title_variation_equivalent", linha["Match de custo"], "bridge_title_variation_equivalent");
  eq("custo equivalente é aplicado", linha.CMV, 25);
  eq("identidade ambígua equivalente não bloqueia o cálculo", r.summary.bridgeAmbiguousCount, 0);
  eq("contabilizado como equivalência", r.summary.bridgeEquivalentCostMatchCount, 1);
}

// ── Caso D — variação diferente nunca resolve pelo título ─────────────────
console.log("\n▸ Caso D — mesmo título, variação diferente → nunca resolve pelo título");
{
  const orderAll = [
    linhaOrderAll({
      "ID do pedido": "CASE-D",
      "Nome do Produto": "Relógio Digital Esportivo À Prova D'água",
      "Nome da variação": "Preto,G",
      "Subtotal do produto": 90,
      "Preço acordado": 90,
      "Taxa de comissão líquida": 9,
    }),
  ];
  // Título praticamente idêntico, mas a variação é "Preto,GG" — outro tamanho.
  const performance = [
    linhaPerformance({
      "ID do Item": "ITEM-D",
      "ID da Variação": "MODEL-D",
      "Nome da Variação": "Preto,GG",
      Produto: "Relógio Digital Esportivo à Prova D'água",
    }),
  ];
  const costRows = [{ id: "ITEM-D", "model id": "MODEL-D", Custo: 30, imposto: 0 }];

  const r = processShopee(performance, costRows, 0, 0, 0, orderAll);
  eq("CMV continua nulo — variação diferente nunca cruza", r.detailedRows[0].CMV, null);
  eq("nenhum match por título registrado", r.summary.bridgeTitleVariationMatchCount, 0);
  eq("não é tratado como ambíguo (nem chega a ser candidato)", r.summary.bridgeAmbiguousCount, 0);
}

// ── Caso E — Model ID direto no Order.all: fallback nunca interfere ───────
console.log("\n▸ Caso E — ID da Variação direto disponível → estratégia de título não interfere");
{
  const directResult = processShopeeFinancialOrders({
    salesRowsRaw: [
      linhaOrderAll({
        "ID do pedido": "CASE-E",
        "ID da Variação": "MODEL-E-DIRETO",
        "Nome do Produto": "Produto qualquer, nome pode até mudar",
        "Nome da variação": "Único",
        "Subtotal do produto": 70,
        "Preço acordado": 70,
      }),
    ],
    costMap: buildShopeeCostMap([
      { id: "IRRELEVANTE", "model id": "MODEL-E-DIRETO", Custo: 22, imposto: 0 },
    ]),
    // Ponte existe e teria um candidato com título bem diferente — mas o
    // match direto nunca chega a consultá-la.
    costBridge: null,
  });
  eq("match direto pelo ID da variação", directResult.detailedRows[0]["Match de custo"], "direct_variation_id");
  eq("CMV vem do match direto", directResult.detailedRows[0].CMV, 22);
}

// ── Caso F — SKU direto disponível: fallback nunca interfere ──────────────
console.log("\n▸ Caso F — SKU direto disponível → estratégia de título não interfere");
{
  const orderAll = [
    linhaOrderAll({
      "ID do pedido": "CASE-F",
      "Nome do Produto": "Produto com SKU direto",
      "Nome da variação": "Único",
      "Nº de referência do SKU principal": "SKU-DIRETO-F",
      "Subtotal do produto": 50,
      "Preço acordado": 50,
      "Taxa de comissão líquida": 5,
    }),
  ];
  const costRows = [{ sku: "SKU-DIRETO-F", Custo: 18, imposto: 0 }];

  const semPonte = processShopee(orderAll, costRows, 0, 0, 0, null);
  eq("match direto pelo SKU", semPonte.detailedRows[0]["Match de custo"], "direct_sku");
  eq("CMV do match direto", semPonte.detailedRows[0].CMV, 18);

  // Mesmo com uma ponte disponível (que teria candidato de título plausível),
  // o match direto continua vencendo.
  const performance = [
    linhaPerformance({
      "ID do Item": "ITEM-F",
      "ID da Variação": "MODEL-F-PONTE",
      "Nome da Variação": "Único",
      Produto: "Produto com SKU direto",
    }),
  ];
  const costRowsAmbos = [
    { sku: "SKU-DIRETO-F", Custo: 18, imposto: 0 },
    { id: "ITEM-F", "model id": "MODEL-F-PONTE", Custo: 999, imposto: 0 },
  ];
  const comPonte = processShopee(orderAll, costRowsAmbos, 0, 0, 0, performance);
  eq("continua sendo match direto", comPonte.detailedRows[0]["Match de custo"], "direct_sku");
  eq("CMV não é substituído pela ponte de título", comPonte.detailedRows[0].CMV, 18);
}

// ── Caso G — custo #N/A na base: permanece sem custo, diagnóstico preserva o valor cru ──
console.log("\n▸ Caso G — CUSTO = #N/A na base → permanece sem custo, rawCost/costValid preservados");
{
  const orderAll = [
    linhaOrderAll({
      "ID do pedido": "CASE-G",
      "Nome do Produto": "Produto com custo inválido na base",
      "Nº de referência do SKU principal": "SKU-NA",
      "Subtotal do produto": 59.9,
      "Preço acordado": 59.9,
      "Taxa de comissão líquida": 5.99,
    }),
  ];
  const costRows = [{ sku: "SKU-NA", Custo: "#N/A", imposto: "4.00%" }];

  const r = processShopeeFinancialOrders({
    salesRowsRaw: orderAll,
    costMap: buildShopeeCostMap(costRows),
  });
  eq("CMV permanece nulo — #N/A nunca vira custo", r.detailedRows[0].CMV, null);
  eq("LC permanece desconhecido", r.detailedRows[0].LC, null);
  eq("receita sem custo preserva o valor da linha", r.summary.revenueWithoutCost, 59.9);

  const gap = r.unmatchedCosts[0];
  eq("motivo é custo zero/inválido na base", gap.reason, "zero_cost_in_base");
  eq("rawCost preserva o texto original", gap.rawCost, "#N/A");
  eq("costValid é false para #N/A", gap.costValid, false);
}

// ── Caso H — custo = 0 na base: permanece sem custo, mas é numérico válido ──
console.log("\n▸ Caso H — CUSTO = 0 na base → permanece sem custo, mas costValid é true");
{
  const orderAll = [
    linhaOrderAll({
      "ID do pedido": "CASE-H",
      "Nome do Produto": "Produto com custo zero na base",
      "Nº de referência do SKU principal": "SKU-ZERO",
      "Subtotal do produto": 40,
      "Preço acordado": 40,
      "Taxa de comissão líquida": 4,
    }),
  ];
  const costRows = [{ sku: "SKU-ZERO", Custo: 0, imposto: 0 }];

  const r = processShopeeFinancialOrders({
    salesRowsRaw: orderAll,
    costMap: buildShopeeCostMap(costRows),
  });
  eq("CMV permanece nulo — custo <= 0 nunca calcula LC/MC", r.detailedRows[0].CMV, null);
  eq("LC permanece desconhecido", r.detailedRows[0].LC, null);

  const gap = r.unmatchedCosts[0];
  eq("motivo é custo zero/inválido na base", gap.reason, "zero_cost_in_base");
  eq("rawCost preserva o texto original", gap.rawCost, "0");
  eq("costValid é true para 0 (é um número real, só não positivo)", gap.costValid, true);
}

console.log(`\n${checks} verificações passaram. Ponte Shopee — variação exata + título (FIN-21) OK.`);
