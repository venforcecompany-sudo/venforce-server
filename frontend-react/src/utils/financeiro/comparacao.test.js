import { describe, it, expect } from "vitest";
import { compararSnapshots, compararMetrica, frasesDaComparacao, formatarDelta, METRICAS_COMPETENCIA } from "./comparacao.js";

const v1 = { summary: { finalResult: 25000, contributionMarginCalculated: 0.15, calculatedCoveragePercent: 91, revenueWithoutCost: 12000, contributionProfitTotal: 40000, grossRevenueTotal: 200000 }, contagens: { pendencias: 17 } };
const v2 = { summary: { finalResult: 29500, contributionMarginCalculated: 0.182, calculatedCoveragePercent: 98, revenueWithoutCost: 3700, contributionProfitTotal: 44500, grossRevenueTotal: 200000 }, contagens: { pendencias: 3 } };

describe("comparação de revisões (v1 → v2)", () => {
  it("diferença de valor, p.p. para margem e cobertura, pendências antes → depois", () => {
    const l = Object.fromEntries(compararSnapshots(v1, v2).map((x) => [x.chave, x]));
    expect(l.finalResult.delta).toBe(4500);
    expect(l.finalResult.variacao).toBeCloseTo(0.18);
    expect(l.finalResult.tom).toBe("melhora");
    expect(l.mcCalculada.delta).toBe(3.2);
    expect(l.mcCalculada.unidade).toBe("p.p.");
    expect(l.cobertura.delta).toBe(7);
    expect(l.revenueWithoutCost.delta).toBe(-8300);
    expect(l.revenueWithoutCost.tom).toBe("melhora"); // cair é melhor
    expect(formatarDelta(l.pendencias)).toBe("17 → 3");
    expect(formatarDelta(l.mcCalculada)).toBe("+3,2 p.p.");
    expect(formatarDelta(l.revenueWithoutCost)).toMatch(/^−R\$\s?8\.300,00$/);
  });

  it("ausência de dado: '—' e 'sem dado', nunca 0; campo que nenhum lado tem não vira linha", () => {
    const semMc = { summary: { finalResult: 1 }, contagens: {} };
    const l = compararMetrica("finalResult", semMc, { summary: { finalResult: null } });
    expect(l.delta).toBeNull();
    expect(l.tom).toBe("sem_dado");
    expect(formatarDelta(l)).toBe("sem dado");
    expect(compararMetrica("tacos", semMc, semMc)).toBeNull();
    expect(compararMetrica("pendencias", { summary: {} }, { summary: {} })).toBeNull();
  });

  it("variação % só com anterior ≠ 0", () => {
    expect(compararMetrica("finalResult", { summary: { finalResult: 0 } }, { summary: { finalResult: 10 } }).variacao).toBeNull();
  });
});

describe("comparação entre competências (frases determinísticas)", () => {
  const set = { summary: { grossRevenueTotal: 100000, contributionMarginCalculated: 0.2, calculatedCoveragePercent: 91, cancelledLostRevenue: 1000, tacos: 0.05, adsTotal: 5000 }, contagens: { pendencias: 4 } };
  const out = { summary: { grossRevenueTotal: 112000, contributionMarginCalculated: 0.176, calculatedCoveragePercent: 98, cancelledLostRevenue: 4200, tacos: 0.05, adsTotal: 5600 }, contagens: { pendencias: 4 } };
  it("frases só do que mudou, na ordem das métricas", () => {
    const frases = frasesDaComparacao(compararSnapshots(set, out, METRICAS_COMPETENCIA), { maximo: 10 });
    expect(frases).toEqual([
      "Receita Bruta subiu 12,0%.",
      "MC Calculada caiu 2,4 p.p.",
      expect.stringMatching(/^ADS subiu R\$\s?600,00\.$/),
      "Cobertura melhorou de 91,0% para 98,0%.",
      expect.stringMatching(/^Cancelamentos subiram R\$\s?3\.200,00\.$/),
    ]);
  });
  it("eventos usam a chave do marketplace (MELI: refundsTotal)", () => {
    const l = compararMetrica("cancelamentos", { summary: { refundsTotal: 10 } }, { summary: { refundsTotal: 5 } });
    expect(l.delta).toBe(-5);
    expect(l.tom).toBe("melhora");
  });
});
