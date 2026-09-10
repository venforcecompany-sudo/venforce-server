// server/tests/detectarIncidenteFechamento.test.js
const assert = require("assert");
const { detectarIncidenteFechamento } = require("../services/fechamentoFinanceiro/incidente/detectarIncidenteFechamento");

let checks = 0;
function ok(label, condition) { assert.ok(condition, label); checks += 1; console.log(`  ok  ${label}`); }

function baseResultOk() {
  return {
    summary: { financialConfidence: "confiavel", revenueWithoutCost: 0, calculatedCoveragePercent: 100 },
    unmatchedIds: [],
    unmatchedCosts: [],
    unmatchedCancelled: [],
  };
}

// 1. fechamento normal -> não cria incidente
ok("fechamento perfeito não gera incidente", detectarIncidenteFechamento(baseResultOk()) === null);

// 2. custo não identificado -> cria incidente
{
  const result = { ...baseResultOk(), unmatchedIds: ["MLB123", "MLB456"], summary: { ...baseResultOk().summary, financialConfidence: "parcial", revenueWithoutCost: 5414.42 } };
  const incidente = detectarIncidenteFechamento(result);
  ok("custo não encontrado gera incidente", incidente !== null);
  ok("trigger custo_nao_encontrado presente", incidente.triggers.includes("custo_nao_encontrado"));
  ok("resumo carrega revenueWithoutCost real", incidente.resumo.revenueWithoutCost === 5414.42);
}

// 3. identidade ambígua (Shopee, ordersAll) -> cria incidente
{
  const result = {
    ...baseResultOk(),
    unmatchedCosts: [{ type: "ambiguous_ids", value: "111, 222", sku: null, candidates: ["111", "222"], reason: "ambiguous_bridge_candidates" }],
  };
  const incidente = detectarIncidenteFechamento(result);
  ok("identidade ambígua gera incidente", incidente !== null);
  ok("trigger identidade_ambigua presente", incidente.triggers.includes("identidade_ambigua"));
}

// cobertura incompleta isolada também dispara
{
  const result = { ...baseResultOk(), summary: { ...baseResultOk().summary, financialConfidence: "insuficiente" } };
  const incidente = detectarIncidenteFechamento(result);
  ok("cobertura insuficiente gera incidente", incidente !== null);
  ok("trigger cobertura_incompleta presente", incidente.triggers.includes("cobertura_incompleta"));
}

// result nulo/indefinido não quebra
ok("result undefined não lança", detectarIncidenteFechamento(undefined) === null);

console.log(`\n${checks} checks ok`);
