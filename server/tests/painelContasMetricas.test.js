// server/tests/painelContasMetricas.test.js
// Testes puros de painelContasMetricas.js — sem banco. Cobre a derivação
// LC=fat*mc, a normalização de escala de mc_media (Auditoria §8 ressalva 2 +
// mesma ambiguidade que cliente360DiagnosticoEngine.mcParaPercent normaliza),
// TACoS recalculado (nunca lido da coluna persistida, que está em escala
// 0-100) e ACOS derivado nunca fabricando 0 (Auditoria §26 "Dados").

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const {
  normalizarMcFracao,
  calcularAcos,
  deriveResumo,
} = require("../services/painelContas/painelContasMetricas");

let checks = 0;
function ok(label, cond) {
  assert.ok(cond, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

// ── normalizarMcFracao ──
ok("mc já em fração (0.18) permanece 0.18", normalizarMcFracao(0.18) === 0.18);
ok("mc em percentual (18) normaliza para fração (0.18)", normalizarMcFracao(18) === 0.18);
ok("mc negativo em percentual (-22) normaliza para fração (-0.22)", normalizarMcFracao(-22) === -0.22);
ok("mc negativo já em fração (-0.05) permanece -0.05", normalizarMcFracao(-0.05) === -0.05);
ok("mc null -> null", normalizarMcFracao(null) === null);
ok("mc string vazia -> null", normalizarMcFracao("") === null);

// ── calcularAcos ──
ok("ACOS = investimento/gmv (fração)", calcularAcos(410, 10000) === 0.041);
ok("ACOS com gmv ausente -> null (nunca 0)", calcularAcos(410, null) === null);
ok("ACOS com gmv = 0 -> null (nunca 0)", calcularAcos(410, 0) === null);
ok("ACOS com investimento ausente -> null", calcularAcos(null, 10000) === null);

// ── deriveResumo ──
const r1 = deriveResumo({ faturamento: 118400.50, mcMedia: 0.179, adsInvestido: 4100, gmvAds: 100000 });
ok("deriveResumo: fat repassado", r1.fat === 118400.50);
ok("deriveResumo: mc repassado (já fração)", r1.mc === 0.179);
ok("deriveResumo: lc = round2(fat*mc)", r1.lc === Math.round(118400.50 * 0.179 * 100) / 100);
ok("deriveResumo: ads repassado", r1.ads === 4100);
ok("deriveResumo: tacos = ads/fat (fração)", Math.abs(r1.tacos - 4100 / 118400.50) < 1e-9);
ok("deriveResumo: acos = ads/gmv (fração)", r1.acos === 4100 / 100000);
ok("deriveResumo: com/atv/nps sempre null (gap de produto, §10)", r1.com === null && r1.atv === null && r1.nps === null);

const r2 = deriveResumo({ faturamento: null, mcMedia: null, adsInvestido: null, gmvAds: null });
ok("deriveResumo sem nenhum dado: tudo null, NUNCA 0 fabricado", Object.values(r2).every((v) => v === null));

const r3 = deriveResumo({ faturamento: 50000, mcMedia: 22, adsInvestido: 0, gmvAds: null });
ok("deriveResumo: mc em escala percentual (22) normaliza antes de calcular LC", r3.mc === 0.22);
ok("deriveResumo: LC usa mc já normalizado (fat*0.22, não fat*22)", r3.lc === Math.round(50000 * 0.22 * 100) / 100);
ok("deriveResumo: ads=0 é dado real, não ausência — tacos calculável (0)", r3.tacos === 0);

const novoCentral = deriveResumo({
  faturamento: 1000,
  mcMedia: 0.20,
  lucroContribuicao: 150,
  lucroContribuicaoPresente: true,
});
ok("LC novo: usa lucroContribuicao real da Central", novoCentral.lc === 150);
ok("LC novo: não recalcula FAT × MC", novoCentral.lc !== 200);

const legado = deriveResumo({ faturamento: 1000, mcMedia: 0.20 });
ok("LC legado: sem campo no payload mantém fallback FAT × MC", legado.lc === 200);

const centralSemLc = deriveResumo({
  faturamento: 1000,
  mcMedia: 0.20,
  lucroContribuicao: null,
  lucroContribuicaoPresente: true,
});
ok("LC Central explicitamente ausente: não fabrica fallback", centralSemLc.lc === null);

console.log(`\npainelContasMetricas.test.js: ${checks} verificações passaram.`);
