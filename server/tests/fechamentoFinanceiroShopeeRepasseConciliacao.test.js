// server/tests/fechamentoFinanceiroShopeeRepasseConciliacao.test.js
// Conciliação do líquido do pedido Shopee SEM coluna Repasse (caso out/2026).
//
// Fatos conferidos num Order.all real (886 pedidos de out/2026), sem versionar
// a planilha:
//  • não existe coluna "Repasse";
//  • Total global = Subtotal − Cupom do vendedor − Cupom − Ajuste PIX
//    − Compensar Moedas/100 + Taxa de envio paga pelo comprador;
//  • "Ajuste por participação em ação comercial" = (comissão bruta − líquida)
//    + (serviço bruto − líquido): as taxas LÍQUIDAS já embutem a compensação
//    da Shopee, então cupom/PIX precisam ser deduzidos junto.
//
// Pedido de referência (ID sintético): Subtotal 299,90 | Cupom vendedor 1,00 |
// Cupom 14,95 | PIX 14,19 | Total global 269,76 | comissão 37,66→20,42 |
// serviço 30,18→18,28. Líquido reconstruível = 269,76 − 38,70 = 231,06.
// O demonstrativo da Shopee mostra 230,57 (taxa adicional de 0,49 que NÃO
// existe no arquivo). Antes da correção o Portal mostrava 261,20.

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

// Pedido de referência com os nomes reais das colunas do Order.all.
function pedidoReal(overrides) {
  return {
    "ID do pedido": "PED-SINTETICO-1",
    "Status do pedido": "Concluído",
    "Status da Devolução / Reembolso": "",
    "Nome do Produto": "Jogo de Panelas Cerâmica 5 Peças",
    "Número de referência SKU": "PAN-5",
    Quantidade: 1,
    "Preço acordado": 299.9,
    "Subtotal do produto": 299.9,
    "Cupom do vendedor": 1.0,
    Cupom: 14.95,
    "Ajuste por pagamento via PIX": 14.19,
    "Ajuste por participação em ação comercial": 29.14,
    "Taxa de comissão bruta": 37.66,
    "Taxa de comissão líquida": 20.42,
    "Taxa de serviço bruta": 30.18,
    "Taxa de serviço líquida": 18.28,
    "Total global": 269.76,
    "Valor estimado do frete": 18.11,
    CMV: 155,
    Imposto: 29.99,
    ...overrides,
  };
}

// Pedido simples, sem descontos (regressão do caminho já correto).
function pedidoSimples(overrides) {
  return {
    "ID do pedido": "PED-SINTETICO-2",
    "Status do pedido": "Concluído",
    "Nome do Produto": "Item simples",
    "Número de referência SKU": "ITEM-1",
    Quantidade: 1,
    "Preço acordado": 100,
    "Subtotal do produto": 100,
    "Taxa de comissão bruta": 14,
    "Taxa de comissão líquida": 14,
    "Taxa de serviço bruta": 6,
    "Taxa de serviço líquida": 6,
    "Total global": 100,
    "Valor estimado do frete": 10,
    CMV: 40,
    Imposto: 10,
    ...overrides,
  };
}

function run(rows) {
  return processShopeeFinancialOrders({
    salesRowsRaw: rows,
    costMap: buildShopeeCostMap([{ sku: "OUTRO-SKU", custo: 1 }]),
  });
}

// ── Caso real: reproduz R$ 261,20 → corrige para R$ 231,06 ─────────────────
console.log("\n▸ Caso real — Total global − taxas líquidas");
{
  const r = run([pedidoReal()]);
  const row = r.detailedRows[0];
  eq("origem do líquido: componentes (sem Repasse)", row["Origem da receita líquida"], "componentes");
  eq("líquido = 269,76 − 20,42 − 18,28", row["Receita líquida"], 231.06);
  eq("LC = 231,06 − 155 − 29,99", r.summary.contributionProfitTotal, 46.07);
  eq("evidência: reconstruído (não comprovado)", row["Evidência do líquido"], "reconstruido");
  eq("confiança do líquido", r.summary.netRevenueConfidence, "reconstruida");
  eq("Total global fechou com a identidade", r.summary.totalGlobalVerifiedOrders, 1);
  eq("nenhum pedido estimado", r.summary.estimatedNetOrdersCount, 0);
  // O valor antigo vinha de ignorar cupom, PIX e cupom do vendedor.
  eq("o valor antigo (261,20) divergia em 30,14 do reconstruível", Math.round((261.2 - 231.06) * 100) / 100, 30.14);
  // Diferença residual para o demonstrativo da Shopee: taxa fora do arquivo.
  eq("resíduo vs. demonstrativo (230,57) = taxa não presente no arquivo", Math.round((231.06 - 230.57) * 100) / 100, 0.49);
  ok(
    "nota declara que não é o valor liquidado pela Shopee",
    r.summary.executiveNotes.some((n) => n.includes("NET_REVENUE_RECONSTRUCTED"))
  );
}

// ── 1. Repasse efetivo de R$ 230,57 (comprovado) ───────────────────────────
console.log("\n▸ 1 — repasse efetivo é a fonte comprovada");
{
  const r = run([pedidoReal({ Repasse: 230.57 })]);
  eq("líquido = repasse", r.summary.paidRevenueTotal, 230.57);
  eq("LC = 230,57 − 155 − 29,99", r.summary.contributionProfitTotal, 45.58);
  eq("evidência", r.detailedRows[0]["Evidência do líquido"], "comprovado");
  eq("confiança do líquido", r.summary.netRevenueConfidence, "comprovada");
}

// ── 2. Sem repasse, sem Total global: identidade pelas colunas ─────────────
console.log("\n▸ 2 — sem Total global, a identidade reconstrói o líquido");
{
  const r = run([pedidoReal({ "Total global": "" })]);
  eq("líquido = 299,90 − 1,00 − 14,95 − 14,19 − 38,70", r.detailedRows[0]["Receita líquida"], 231.06);
  eq("reconstruído", r.summary.netRevenueConfidence, "reconstruida");
}

// ── 3. Total global não fecha com as colunas (descontos desconhecidos) ─────
console.log("\n▸ 3 — Total global divergente: estimado e declarado");
{
  // Total global 8,00 acima do que as colunas sustentam (visto em ~77 pedidos de out/2026).
  const r = run([pedidoReal({ "Total global": 277.76 })]);
  eq("usa só o que a identidade sustenta", r.detailedRows[0]["Receita líquida"], 231.06);
  eq("evidência estimada", r.detailedRows[0]["Evidência do líquido"], "estimado");
  eq("confiança do líquido estimada", r.summary.netRevenueConfidence, "estimada");
  // Eixos separados: o custo está 100% coberto, então o custo segue confiável.
  eq("confiança do custo preservada", r.summary.costConfidence, "confiavel");
  eq("financialConfidence = eixo do custo", r.summary.financialConfidence, "confiavel");
  const motivo = r.summary.netRevenueEstimatedReasons.find((x) => x.reason === "total_global_divergente");
  eq("divergência declarada em R$", motivo && motivo.total, 8);
}

// ── 4. Cupom financiado pelo vendedor ──────────────────────────────────────
console.log("\n▸ 4 — cupom do vendedor reduz o líquido");
{
  const r = run([pedidoSimples({ "Cupom do vendedor": 3.99, "Total global": 96.01 })]);
  eq("100 − 3,99 − 20", r.detailedRows[0]["Receita líquida"], 76.01);
  eq("reconstruído", r.detailedRows[0]["Evidência do líquido"], "reconstruido");
  const neg = run([pedidoSimples({ "Cupom do vendedor": -3.99, "Total global": 96.01 })]);
  eq("sinal negativo na exportação dá o mesmo líquido", neg.detailedRows[0]["Receita líquida"], 76.01);
}

// ── 5. Cupom/PIX financiado pela plataforma ────────────────────────────────
console.log("\n▸ 5 — cupom Shopee: dedução + compensação nas taxas (efeito já embutido)");
{
  // Cupom 10 deduzido do Total global; a Shopee compensa 10 reduzindo as taxas.
  const r = run([
    pedidoSimples({
      Cupom: 10,
      "Total global": 90,
      "Ajuste por participação em ação comercial": 10,
      "Taxa de comissão bruta": 20,
      "Taxa de comissão líquida": 14,
      "Taxa de serviço bruta": 10,
      "Taxa de serviço líquida": 6,
    }),
  ]);
  eq("90 − 14 − 6 (a compensação nas taxas devolve o cupom)", r.detailedRows[0]["Receita líquida"], 70);
  eq("sem divergência", r.detailedRows[0]["Evidência do líquido"], "reconstruido");
  // Sem a dedução (comportamento antigo) daria 100 − 14 − 6 = 80: superestimado em 10.
  eq("comportamento antigo superestimava em 10", 80 - r.detailedRows[0]["Receita líquida"], 10);
}

// ── 6. Taxa adicional de R$ 0,49 ───────────────────────────────────────────
console.log("\n▸ 6 — taxa sem coluna no arquivo não é inventada; com repasse não duplica");
{
  const comRepasse = run([pedidoReal({ Repasse: 230.57 })]);
  eq("repasse já contém a taxa (nenhum desconto extra)", comRepasse.detailedRows[0]["Receita líquida"], 230.57);
  const semRepasse = run([pedidoReal()]);
  ok("sem repasse o líquido não é declarado como comprovado", semRepasse.summary.netRevenueConfidence !== "comprovada");
  eq("e não presume a taxa de 0,49", semRepasse.detailedRows[0]["Receita líquida"], 231.06);
}

// ── 7. Rebate/subsídio nunca aplicado duas vezes ───────────────────────────
console.log("\n▸ 7 — com repasse, nenhum desconto/ajuste é reaplicado");
{
  const r = run([pedidoReal({ Repasse: 230.57 })]);
  eq("líquido permanece o repasse", r.detailedRows[0]["Receita líquida"], 230.57);
  eq("sem pedido estimado", r.summary.estimatedNetOrdersCount, 0);
  eq("descontos de nível pedido não aplicados", r.summary.orderLevelAdjustmentsAppliedTotal, 0);
  const rec = run([pedidoReal()]);
  eq("reconstrução aplica o desconto uma vez (1,00 + 14,95 + 14,19)", rec.summary.orderLevelAdjustmentsAppliedTotal, 30.14);
}

// ── 8. Sem nenhuma evidência de líquido ────────────────────────────────────
console.log("\n▸ 8 — sem repasse e sem taxas: não conciliado");
{
  const r = run([
    pedidoReal({
      "Taxa de comissão bruta": "",
      "Taxa de comissão líquida": "",
      "Taxa de serviço bruta": "",
      "Taxa de serviço líquida": "",
    }),
  ]);
  eq("origem", r.detailedRows[0]["Origem da receita líquida"], "ausente");
  eq("evidência", r.detailedRows[0]["Evidência do líquido"], "ausente");
  eq("confiança do líquido", r.summary.netRevenueConfidence, "nao_conciliada");
  eq("custo continua no seu próprio eixo", r.summary.costConfidence, "confiavel");
}

// ── 9. Pedido histórico: regras vêm da planilha, não das atuais ────────────
console.log("\n▸ 9 — taxas históricas da própria planilha");
{
  const r = run([
    pedidoSimples({
      "Taxa de comissão bruta": 12,
      "Taxa de comissão líquida": 12,
      "Taxa de serviço bruta": 4,
      "Taxa de serviço líquida": 4,
    }),
  ]);
  eq("líquido usa as taxas registradas no pedido", r.detailedRows[0]["Receita líquida"], 84);
}

// ── 10. Regressão: pedido sem descontos permanece idêntico ─────────────────
console.log("\n▸ 10 — pedido sem descontos inalterado");
{
  const r = run([pedidoSimples()]);
  eq("100 − 14 − 6", r.detailedRows[0]["Receita líquida"], 80);
  eq("financialConfidence preservada", r.summary.financialConfidence, "confiavel");
  eq("sem pedido estimado", r.summary.estimatedNetOrdersCount, 0);
  const comFrete = run([pedidoSimples({ "Taxa de envio pagas pelo comprador": 9.14, "Total global": 109.14 })]);
  eq("frete pago pelo comprador não infla o líquido", comFrete.detailedRows[0]["Receita líquida"], 80);
  const neg = run([pedidoSimples({ "Valor estimado do frete": -5 })]);
  eq("frete negativo continua aplicado", neg.detailedRows[0]["Receita líquida"], 75);
  const moedas = run([pedidoSimples({ "Compensar Moedas Shopee": 93, "Total global": 99.07 })]);
  eq("moedas (centavos) deduzidas", moedas.detailedRows[0]["Receita líquida"], 79.07);
}

// ── 11. Desconto de cartão: Total global desconta, taxas não compensam ─────
console.log("\n▸ 11 — desconto de cartão segue o Total global e fica estimado");
{
  // Padrão real (7/7 em out/2026): Total global = esperado − cartão e o ajuste
  // de ação comercial cobre só o cupom.
  const r = run([
    pedidoReal({
      "Ajuste por pagamento via PIX": 0,
      "Total descontado Cartão de Crédito": 14.19,
      "Ajuste por participação em ação comercial": 14.95,
      "Taxa de comissão bruta": 30.0,
      "Taxa de comissão líquida": 20.42,
      "Taxa de serviço bruta": 23.65,
      "Taxa de serviço líquida": 18.28,
    }),
  ]);
  eq("líquido = 269,76 − 38,70 (Total global, valor menor)", r.detailedRows[0]["Receita líquida"], 231.06);
  eq("estimado", r.detailedRows[0]["Evidência do líquido"], "estimado");
  const motivo = r.summary.netRevenueEstimatedReasons.find((x) => x.reason === "desconto_cartao_sem_compensacao");
  eq("motivo declarado com o valor do cartão", motivo && motivo.total, 14.19);
  ok("cartão não duplica como coluna sem semântica",
    !r.summary.netRevenueEstimatedReasons.some((x) => x.reason.startsWith("coluna_sem_semantica")));
}

// ── 12. Pedido com múltiplos itens: nível pedido conta uma vez ─────────────
console.log("\n▸ 12 — múltiplos itens: Total global, descontos e taxas uma única vez");
{
  // Pedido real com 2 linhas: campos de nível pedido repetidos em cada linha.
  const comum = {
    "ID do pedido": "PED-MULTI",
    "Cupom do vendedor": 1.0,
    Cupom: 14.95,
    "Ajuste por pagamento via PIX": 14.19,
    "Ajuste por participação em ação comercial": 29.14,
    "Taxa de comissão bruta": 37.66,
    "Taxa de comissão líquida": 20.42,
    "Taxa de serviço bruta": 30.18,
    "Taxa de serviço líquida": 18.28,
    "Total global": 269.76,
  };
  const r = run([
    pedidoReal({ ...comum, "Número de referência SKU": "A", "Subtotal do produto": 199.9, "Preço acordado": 199.9, CMV: 100, Imposto: 19.99 }),
    pedidoReal({ ...comum, "Número de referência SKU": "B", "Subtotal do produto": 100, "Preço acordado": 100, CMV: 55, Imposto: 10 }),
  ]);
  const soma = Math.round(r.detailedRows.reduce((t, d) => t + d["Receita líquida"], 0) * 100) / 100;
  eq("líquido do pedido = 269,76 − 38,70 (não multiplicado por 2)", soma, 231.06);
  eq("reconstruído (identidade fechou com o subtotal somado)", r.summary.netRevenueConfidence, "reconstruida");
  eq("descontos aplicados uma vez", r.summary.orderLevelAdjustmentsAppliedTotal, 30.14);
  eq("rateio por receita (item A): 231,06 × 199,9/299,9", r.detailedRows[0]["Receita líquida"], 154.01);
  eq("rateio por receita (item B) recebe o resto", r.detailedRows[1]["Receita líquida"], 77.05);
  eq("taxa registrada uma vez na linha", r.detailedRows[0]["Taxa de comissão"], 20.42);
}

console.log(`\n✓ ${checks} verificações`);
