// server/tests/mlAdsTotalCampanhasExcluidas.test.js
//
// O painel do Mercado Ads inclui as campanhas EXCLUÍDAS no investimento do
// período, mas campaigns/search só lista as ativas. O resumo precisa usar o
// maior total entre as fontes (caso Rikam, out/2026: 617,19 vs 795,28).

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const { calcularResumoMetricas } = require("../services/ads/mlAdsService");

const m = (cost, total_amount) => ({ metrics: { cost, total_amount, clicks: 0, prints: 0 } });

// 1) anúncios de campanha excluída → total dos anúncios vence a soma das campanhas
{
  const campanhas = [m(320.56, 3577.3), m(295.82, 1802.48), m(0.81, 0)];
  const itens = [m(303.08, 3000), m(183.09, 1500), m(307.54, 1416.98)];
  const r = calcularResumoMetricas(itens, campanhas, "2026-10");
  assert.strictEqual(r.investimentoAds, 793.71);
  assert.strictEqual(r.fonteTotal, "ads_search");
  assert.deepStrictEqual(r.candidatasTotal.map((c) => c.fonte), ["campaigns_search", "ads_search"]);
}

// 2) sem campanhas excluídas → continua a soma das campanhas (empate não troca a fonte)
{
  const campanhas = [m(100, 500), m(50, 100)];
  const itens = [m(100, 500), m(50, 100)];
  const r = calcularResumoMetricas(itens, campanhas, "2026-10");
  assert.strictEqual(r.investimentoAds, 150);
  assert.strictEqual(r.fonteTotal, "campaigns_search");
}

// 3) metrics_summary da API maior que as listas → vale o summary
{
  const r = calcularResumoMetricas([m(10, 0)], [m(10, 0)], "2026-10", [{ cost: 40, total_amount: 200 }]);
  assert.strictEqual(r.investimentoAds, 40);
  assert.strictEqual(r.fonteTotal, "metrics_summary");
}

// 4) sem nada → zero, sem quebrar
{
  const r = calcularResumoMetricas([], [], "2026-10", [null, undefined]);
  assert.strictEqual(r.investimentoAds, 0);
  assert.strictEqual(r.roas, 0);
}

console.log("mlAdsTotalCampanhasExcluidas.test.js: 4 cenários OK");
