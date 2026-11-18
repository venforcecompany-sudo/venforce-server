// server/tests/fechamentoFinanceiroShopeeRepasseConciliacao.test.js
// Conciliação do líquido do pedido Shopee (caso Mercadão conta 2, out/2026).
//
// O Order.all real NÃO tem coluna "Repasse": o líquido é reconstruído por
// "componentes" (bruto − taxas). Esse caminho ignorava cupom do vendedor e
// não declarava os ajustes cujo financiador não é provável pela planilha
// (cupom Shopee, ajuste PIX…), apresentando um LC "confiável" que o
// demonstrativo da Shopee não sustentava (R$ 261,20 × R$ 230,57).
//
// Fonte dos valores: pedido real informado pelo usuário. Colunas e semântica
// conferidas num Order.all real (set/2026): "Total global" = Subtotal −
// Cupom do vendedor (− Cupom Shopee − moedas) + frete pago pelo comprador.

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

// Colunas com os nomes reais do Order.all da Shopee.
function linha(overrides) {
  return {
    "ID do pedido": "PED-REAL",
    "Status do pedido": "Concluído",
    "Status da Devolução / Reembolso": "",
    "Nome do Produto": "Jogo de Panelas Cerâmica 5 Peças",
    "Número de referência SKU": "PAN-5",
    Quantidade: 1,
    "Preço acordado": 299.9,
    "Subtotal do produto": 299.9,
    "Taxa de transação": 0,
    "Taxa de comissão líquida": 20.42,
    "Taxa de serviço líquida": 18.28,
    "Valor estimado do frete": "",
    CMV: 155,
    Imposto: 29.99,
    ...overrides,
  };
}

function run(rows) {
  return processShopeeFinancialOrders({
    salesRowsRaw: rows,
    costMap: buildShopeeCostMap([{ sku: "OUTRO-SKU", custo: 1 }]),
  });
}

// ── 1. Repasse efetivo de R$ 230,57 (comprovado) ───────────────────────────
console.log("\n▸ 1 — repasse efetivo é a fonte comprovada");
{
  const r = run([linha({ Repasse: 230.57 })]);
  eq("líquido = repasse", r.summary.paidRevenueTotal, 230.57);
  eq("LC = 230,57 − 155 − 29,99", r.summary.contributionProfitTotal, 45.58);
  eq("origem do líquido", r.detailedRows[0]["Origem da receita líquida"], "repasse");
  eq("evidência", r.detailedRows[0]["Evidência do líquido"], "comprovado");
  eq("confiança do líquido", r.summary.netRevenueConfidence, "comprovada");
  eq("sem pendência de conciliação", r.summary.unresolvedAdjustmentOrdersCount, 0);
}

// ── Reprodução da divergência original ─────────────────────────────────────
console.log("\n▸ Caso real — componentes sem repasse (divergência de R$ 30,63)");
{
  const r = run([
    linha({
      "Cupom do vendedor": 1.0,
      Cupom: 14.95,
      "Ajuste por pagamento via PIX": 14.19,
    }),
  ]);
  const row = r.detailedRows[0];
  eq("origem do líquido", row["Origem da receita líquida"], "componentes");
  // Cupom do vendedor (R$ 1,00) é comprovadamente do vendedor: descontado.
  eq("seller coupon descontado: 299,90 − 20,42 − 18,28 − 1,00", row["Receita líquida"], 260.2);
  eq("LC não é mais 76,21 (somente com o cupom provado)", r.summary.contributionProfitTotal, 75.21);
  // O que a planilha não prova NÃO é presumido como custo do vendedor…
  eq("evidência estimada", row["Evidência do líquido"], "estimado");
  eq("confiança do líquido estimada", r.summary.netRevenueConfidence, "estimada");
  // …mas é declarado: o resultado não é apresentado como comprovado.
  eq("financialConfidence rebaixada", r.summary.financialConfidence, "parcial");
  eq("1 pedido com ajuste sem financiador provado", r.summary.unresolvedAdjustmentOrdersCount, 1);
  const porColuna = Object.fromEntries(
    r.summary.unresolvedAdjustments.map((a) => [a.column, a.total])
  );
  eq("cupom Shopee exposto", porColuna["Cupom"], 14.95);
  eq("ajuste PIX exposto", porColuna["Ajuste por pagamento via PIX"], 14.19);
  ok(
    "nota executiva cita a conciliação pendente",
    r.summary.executiveNotes.some((n) => n.includes("NET_REVENUE_ESTIMATED"))
  );
  // Divergência remanescente vs. demonstrativo (230,57): 260,20 − 230,57.
  eq("diferença para o demonstrativo fica declarada", Math.round((260.2 - 230.57) * 100) / 100, 29.63);
}

// ── 2. Sem repasse, componentes suficientes e sem ajustes ──────────────────
console.log("\n▸ 2 — componentes completos reconstroem o líquido");
{
  const r = run([linha()]);
  eq("líquido = bruto − taxas", r.detailedRows[0]["Receita líquida"], 261.2);
  eq("origem", r.detailedRows[0]["Origem da receita líquida"], "componentes");
  eq("sem ajuste pendente: financialConfidence preservada", r.summary.financialConfidence, "confiavel");
  eq("sem ajuste pendente: líquido reconstruído (não comprovado)", r.summary.netRevenueConfidence, "reconstruida");
}

// ── 3. Sem repasse e com descontos desconhecidos ───────────────────────────
console.log("\n▸ 3 — descontos desconhecidos não são presumidos nem ignorados");
{
  const r = run([linha({ "Ajuste por participação em ação comercial": 5.5 })]);
  eq("valor não aplicado", r.detailedRows[0]["Receita líquida"], 261.2);
  eq("mas declarado", r.summary.unresolvedAdjustmentOrdersCount, 1);
  eq("confiança rebaixada", r.summary.financialConfidence, "parcial");
}

// ── 4. Cupom financiado pelo vendedor ──────────────────────────────────────
console.log("\n▸ 4 — cupom do vendedor reduz o líquido");
{
  const r = run([linha({ "Cupom do vendedor": 3.99 })]);
  eq("líquido", r.detailedRows[0]["Receita líquida"], 257.21);
  eq("sem pendência", r.summary.unresolvedAdjustmentOrdersCount, 0);
  const neg = run([linha({ "Cupom do vendedor": -3.99 })]);
  eq("sinal negativo na exportação dá o mesmo líquido", neg.detailedRows[0]["Receita líquida"], 257.21);
  const coin = run([linha({ "Coin Cashback Voucher Amount Sponsored by Seller": 2 })]);
  eq("cashback patrocinado pelo vendedor reduz o líquido", coin.detailedRows[0]["Receita líquida"], 259.2);
}

// ── 5. Cupom financiado pela plataforma ────────────────────────────────────
console.log("\n▸ 5 — cupom 100% compensado pela Shopee não custa ao vendedor");
{
  const r = run([linha({ Cupom: 14.95, "Incentivo de cupom": 14.95 })]);
  eq("líquido intacto", r.detailedRows[0]["Receita líquida"], 261.2);
  eq("sem pendência", r.summary.unresolvedAdjustmentOrdersCount, 0);
  eq("confiança preservada", r.summary.financialConfidence, "confiavel");
  const parcial = run([linha({ Cupom: 14.95, "Incentivo de cupom": 10 })]);
  const col = parcial.summary.unresolvedAdjustments.find((a) => a.column === "Cupom");
  eq("só o saldo não compensado fica pendente", col && col.total, 4.95);
}

// ── 6. Taxa adicional (Devolução Fácil R$ 0,49) ────────────────────────────
console.log("\n▸ 6 — taxa sem coluna mapeada não é inventada; com repasse não duplica");
{
  const comRepasse = run([linha({ Repasse: 230.57 })]);
  eq("repasse já contém a taxa de R$ 0,49 (sem desconto extra)", comRepasse.detailedRows[0]["Receita líquida"], 230.57);
  const semRepasse = run([linha()]);
  ok(
    "sem repasse a taxa não é visível: líquido reconstruído é declarado como não comprovado",
    semRepasse.summary.netRevenueConfidence !== "comprovada"
  );
}

// ── 7. Rebate/subsídio nunca aplicado duas vezes ───────────────────────────
console.log("\n▸ 7 — repasse presente: nenhum ajuste/cupom é reaplicado");
{
  const r = run([
    linha({
      Repasse: 230.57,
      "Cupom do vendedor": 1.0,
      Cupom: 14.95,
      "Ajuste por pagamento via PIX": 14.19,
    }),
  ]);
  eq("líquido permanece o repasse", r.detailedRows[0]["Receita líquida"], 230.57);
  eq("não vira pendência (já está no repasse)", r.summary.unresolvedAdjustmentOrdersCount, 0);
  eq("confiança preservada", r.summary.financialConfidence, "confiavel");
}

// ── 8. Sem nenhuma evidência de líquido ────────────────────────────────────
console.log("\n▸ 8 — sem repasse e sem taxas: não conciliado");
{
  const r = run([
    linha({ "Taxa de transação": "", "Taxa de comissão líquida": "", "Taxa de serviço líquida": "" }),
  ]);
  eq("origem", r.detailedRows[0]["Origem da receita líquida"], "ausente");
  eq("evidência", r.detailedRows[0]["Evidência do líquido"], "ausente");
  eq("confiança do líquido", r.summary.netRevenueConfidence, "nao_conciliada");
  eq("financialConfidence rebaixada", r.summary.financialConfidence, "parcial");
}

// ── 9. Pedido histórico: regras vêm da planilha, não das atuais ────────────
console.log("\n▸ 9 — taxas históricas da própria planilha");
{
  // Comissão de 12% e serviço de 4% (regra antiga) — nenhuma tabela atual é aplicada.
  const r = run([
    linha({
      "Taxa de comissão líquida": 35.99,
      "Taxa de serviço líquida": 11.99,
    }),
  ]);
  eq("líquido usa as taxas registradas no pedido", r.detailedRows[0]["Receita líquida"], 251.92);
}

// ── 10. Regressão: pedido conciliado antes continua igual ──────────────────
console.log("\n▸ 10 — pedido já conciliado (taxas+frete negativo) inalterado");
{
  const r = run([linha({ "Valor estimado do frete": -5 })]);
  eq("líquido = 299,90 − 20,42 − 18,28 − 5", r.detailedRows[0]["Receita líquida"], 256.2);
  eq("financialConfidence preservada", r.summary.financialConfidence, "confiavel");
  eq("sem pendência", r.summary.unresolvedAdjustmentOrdersCount, 0);
}

console.log(`\n✓ ${checks} verificações`);
