// server/services/fechamentoFinanceiro/incidente/detectarIncidenteFechamento.js
// Função PURA: decide se um resultado de fechamento (o mesmo objeto que
// processFechamentoFinanceiro devolve) representa uma anomalia que merece
// virar um incidente de suporte. Só lê campos REAIS já produzidos pelos
// motores (meliFinanceiroService, shopeePerformanceService,
// shopeeOrderAllService, tiktokFinanceiroService) — nunca inventa campo novo
// nem recalcula nada do motor financeiro.

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function detectarIncidenteFechamento(result) {
  if (!result || typeof result !== "object") return null;

  const summary = result.summary || {};
  const unmatchedIds = safeArray(result.unmatchedIds);
  const unmatchedCosts = safeArray(result.unmatchedCosts);
  const ambiguousItems = unmatchedCosts.filter((item) => item?.type === "ambiguous_ids");

  const triggers = [];

  if (ambiguousItems.length > 0) triggers.push("identidade_ambigua");
  if (unmatchedIds.length > 0 || unmatchedCosts.length > 0) triggers.push("custo_nao_encontrado");
  if (summary.financialConfidence && summary.financialConfidence !== "confiavel") triggers.push("cobertura_incompleta");
  if (safeNumber(summary.revenueWithoutCost) > 0) triggers.push("receita_sem_custo");

  if (triggers.length === 0) return null;

  // Ordem de prioridade para o trigger "principal" (o que melhor descreve o
  // problema para quem vai ler o código FIN-xxx pela primeira vez).
  const prioridade = ["identidade_ambigua", "custo_nao_encontrado", "receita_sem_custo", "cobertura_incompleta"];
  const triggerPrincipal = prioridade.find((t) => triggers.includes(t)) || triggers[0];

  return {
    triggers,
    triggerPrincipal,
    resumo: {
      unmatchedIdsCount: unmatchedIds.length,
      unmatchedCostsCount: unmatchedCosts.length,
      ambiguousCount: ambiguousItems.length,
      revenueWithoutCost: safeNumber(summary.revenueWithoutCost),
      financialConfidence: summary.financialConfidence || null,
      coveragePercent: summary.calculatedCoveragePercent ?? null,
      message: result.message || null,
    },
  };
}

module.exports = { detectarIncidenteFechamento };
