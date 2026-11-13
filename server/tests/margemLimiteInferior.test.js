// server/tests/margemLimiteInferior.test.js
// Margem sobre preço promocional com composição NÃO comprovada é LIMITE
// INFERIOR: nunca "Prejuízo"/"Margem baixa" confirmados — nem na linha, nem no
// placar, nem no filtro por status, nem no LC em prejuízo. Sem banco real, sem ML.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://127.0.0.1:1/dead";

const assert = require("assert");
const core = require("../services/motorMargem/core");
const read = require("../services/motorMargem/marginSnapshotReadService");
const { margemAtualComRebate, reclassificarStatus, MOTIVO_LIMITE_INFERIOR } = require("../services/motorMargem/margemAtualRebate");
const snapshotRepository = require("../services/motorMargem/marginSnapshotRepository");
const runRepository = require("../services/motorMargem/marginSnapshotRunRepository");
const runService = require("../services/motorMargem/marginSnapshotRunService");
const { makeMarginSnapshotFakeDb } = require("./helpers/marginSnapshotFakeDb");
const { clienteContaServiceFake } = require("./helpers/marginSnapshotContasFake");

const casos = [];
function cenario(nome, fn) { casos.push({ nome, fn }); }

const LOSS = { price: 90, listPrice: 120, cost: 60, taxRate: 0.1, fixedFee: 0, commission: 12.1, freight: 15 };
const LOW = { price: 90, listPrice: 120, cost: 45, taxRate: 0.1, fixedFee: 0, commission: 12.1, freight: 15 };
const OK = { price: 90, listPrice: 120, cost: 20, taxRate: 0.1, fixedFee: 0, commission: 12.1, freight: 15 };
const calc = (i) => core.computeMargin(i);
const RUN = { runId: 41, snapshotAt: "2026-11-12T18:44:00Z" };

function linha(insumos, status, o = {}) {
  const c = calc(insumos);
  return { itemId: o.itemId || "MLB1", ...insumos, profit: c.profit, margin: c.margin, status, confidenceLevel: "HIGH",
    missing: [], assumed: [], quality: { targetMargin: 0.1 }, calculatedAt: "2026-11-12T18:40:00Z" };
}
const promo = (o) => ({ promotionId: o.id, tipo: o.tipo, nome: o.tipo, status: o.status || "started", ativa: o.ativa ?? true,
  precoFinal: 90, precoOriginal: 120, meliPercentage: o.meli ?? null, sellerPercentage: o.seller ?? null,
  subsidioMl: o.meli != null ? Math.round(120 * o.meli) / 100 : null, observedAt: "2026-11-12T18:44:00Z" });

cenario("premissa: os insumos dão Prejuízo, Margem baixa e Saudável na meta de 10%", () => {
  assert.ok(calc(LOSS).margin < 0);
  assert.ok(calc(LOW).margin > 0 && calc(LOW).margin < 0.1);
  assert.ok(calc(OK).margin >= 0.1);
});

cenario("DEAL sem participação do ML: Prejuízo/Margem baixa viram 'Revisar preço/promoção' (Dado suspeito); Saudável continua (o limite inferior já está na meta)", () => {
  const deal = { linhas: [promo({ id: "P-8", tipo: "DEAL" })], promocoes: 0 };
  for (const [insumos, status] of [[LOSS, "LOSS"], [LOW, "LOW_MARGIN"]]) {
    const l = linha(insumos, status);
    const novo = reclassificarStatus(l, margemAtualComRebate(l, deal, null, { promoSnapshot: RUN }));
    assert.strictEqual(novo.status, "SUSPECT_DATA", status);
    assert.strictEqual(novo.label, "Revisar preço/promoção");
    assert.strictEqual(novo.motivo, MOTIVO_LIMITE_INFERIOR);
    assert.strictEqual(novo.de, status);
  }
  const ok = linha(OK, "HEALTHY");
  assert.strictEqual(reclassificarStatus(ok, margemAtualComRebate(ok, deal, null, { promoSnapshot: RUN })), null);
});

cenario("relâmpago sem participação do ML continua pendente (REVISAR), e não reclassifica com retorno", () => {
  const l = linha(LOSS, "LOSS");
  const atual = margemAtualComRebate(l, { linhas: [promo({ id: "L-1", tipo: "LIGHTNING" })], promocoes: 0 }, null, { promoSnapshot: RUN });
  assert.strictEqual(atual.precoVigente.status, "REVISAR");
  assert.strictEqual(atual.precoVigente.motivo, "PARTICIPACAO_ML_NAO_INFORMADA");
  assert.strictEqual(atual.rebate, null);
  assert.strictEqual(reclassificarStatus(l, atual).status, "SUSPECT_DATA");
});

cenario("comprovados continuam como resultado: campanha do vendedor em Prejuízo é Prejuízo; sem promoção também", () => {
  const vend = linha(LOSS, "LOSS");
  assert.strictEqual(reclassificarStatus(vend, margemAtualComRebate(vend, { linhas: [promo({ id: "C-1", tipo: "SELLER_CAMPAIGN" })], promocoes: 0 }, null, { promoSnapshot: RUN })), null);
  const semPromo = linha({ ...LOSS, listPrice: 90 }, "LOSS");
  assert.strictEqual(reclassificarStatus(semPromo, margemAtualComRebate(semPromo, null, null, { promoSnapshot: RUN })), null);
});

cenario("falha momentânea de leitura das promoções: status persistido (nunca meio-corrigido)", () => {
  const l = linha(LOSS, "LOSS");
  assert.strictEqual(reclassificarStatus(l, margemAtualComRebate(l, undefined, "PROMO_SNAPSHOT_INDISPONIVEL")), null);
});

// ── Conta inteira: placar, filtro e LC em prejuízo ──────────────────────────
async function conta({ promoSnapshot, promocoesPorItem }) {
  const db = makeMarginSnapshotFakeDb();
  const base = { clienteId: 1, clienteContaId: 5, marketplace: "meli", baseId: 9, confidenceLevel: "HIGH", quality: { targetMargin: 0.1 }, missing: [], assumed: [], divergences: [],
    observedAt: new Date("2026-11-12T18:40:00Z"), calculatedAt: new Date("2026-11-12T18:40:05Z"), runId: 1, refreshStatus: "fresh", lastError: null };
  const add = async (itemId, insumos, status) => {
    const c = calc(insumos);
    await snapshotRepository.upsertProjectionSnapshot({ ...base, itemId, sku: itemId, titulo: itemId, ...insumos, profit: c.profit, margin: c.margin, marginPercent: Math.round(c.margin * 10000) / 100, status }, db);
  };
  await add("MLB1", LOSS, "LOSS");                         // promocional, composição não comprovada
  await add("MLB2", { ...LOSS, listPrice: 90 }, "LOSS");   // sem promoção: Prejuízo comprovado
  await add("MLB3", LOW, "LOW_MARGIN");                    // promocional, não comprovada
  await add("MLB4", OK, "HEALTHY");                        // promocional, mas já saudável
  await add("MLB5", LOSS, "LOSS");                         // promocional
  const { run } = await runService.enqueueMarginSnapshotRun({ clienteId: 1, clienteSlug: "loja-a", clienteContaId: 5, reason: "manual_refresh", db });
  await runRepository.updateRunStatus({ runId: run.id, status: "running", db });
  await runRepository.updateRunStatus({ runId: run.id, status: "completed", db });
  const mapa = (ids) => {
    const m = new Map();
    Object.defineProperty(m, "promoSnapshot", { value: promoSnapshot, enumerable: false });
    // Como o repositório real: modo conta (ids = null) só traz itens com iniciada subsidiada.
    for (const [id, linhas] of Object.entries(promocoesPorItem || {})) {
      const subsidiadas = linhas.filter((l) => l.subsidioMl > 0).length;
      if (ids ? ids.includes(id) : subsidiadas > 0) m.set(id, { linhas, promocoes: subsidiadas });
    }
    return m;
  };
  const consultas = { porItem: 0 };
  const deps = {
    db,
    env: { MARGIN_SNAPSHOT_READ_ENABLED: "true" },
    now: new Date("2026-11-13T15:00:00Z"),
    clienteContaService: { ...clienteContaServiceFake, obterConta: async (id) => ({ ...(await clienteContaServiceFake.obterConta(id)), external_account_id: "555" }) },
    contarContasAtivas: async () => 2,
    carregarVendas: async () => ({ sincronizado: true, pedidos: [], pedidosTodos: [], itens: [], componentes: [], imports: [{ id: 1 }], competencias: [] }),
    promoRepository: {
      mapRebatesAtivosDaConta: async () => mapa(null),
      mapRebatesAtivosPorItem: async ({ itemIds }) => { consultas.porItem += 1; return mapa(itemIds); },
    },
  };
  return { deps, consultas };
}

cenario("conta SEM leitura de promoções (caso conta 86): Prejuízo/Margem baixa promocionais saem do placar de resultado e são contados à parte", async () => {
  const { deps } = await conta({ promoSnapshot: null });
  const resumo = await read.obterResumo({ clienteSlug: "loja-a", clienteContaId: 5 }, deps);
  assert.deepStrictEqual(
    { LOSS: resumo.kpis.porStatus.LOSS, LOW_MARGIN: resumo.kpis.porStatus.LOW_MARGIN, HEALTHY: resumo.kpis.porStatus.HEALTHY, SUSPECT_DATA: resumo.kpis.porStatus.SUSPECT_DATA },
    { LOSS: 1, LOW_MARGIN: 0, HEALTHY: 1, SUSPECT_DATA: 3 }
  );
  assert.deepStrictEqual(resumo.kpis.limiteInferior, { total: 3, LOSS: 2, LOW_MARGIN: 1 });
  assert.strictEqual(resumo.kpis.lcPrejuizo, Math.round((calc({ ...LOSS, listPrice: 90 }).profit + Number.EPSILON) * 100) / 100, "LC em prejuízo só do comprovado");

  const r = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5 }, deps);
  const porId = Object.fromEntries(r.itens.map((i) => [i.itemId, i]));
  assert.strictEqual(porId.MLB1.status, "SUSPECT_DATA");
  assert.strictEqual(porId.MLB1.quality.statusLabel, "Revisar preço/promoção");
  assert.deepStrictEqual(porId.MLB1.quality.statusReclassificado, { de: "LOSS", para: "SUSPECT_DATA", motivo: MOTIVO_LIMITE_INFERIOR });
  assert.strictEqual(porId.MLB1.precoVigente.motivo, "PROMO_NAO_LIDA", "bloqueio da conta sem evidência preservado");
  assert.strictEqual(porId.MLB1.projected.confianca, "BLOQUEADA");
  assert.strictEqual(porId.MLB1.projected.limiteInferior, true);
  assert.ok(porId.MLB1.projected.margin < 0, "o número continua visível como limite inferior");
  assert.strictEqual(porId.MLB2.status, "LOSS");
  assert.strictEqual(porId.MLB3.status, "SUSPECT_DATA");
  assert.strictEqual(porId.MLB4.status, "HEALTHY");

  const soLoss = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5, status: "LOSS" }, deps);
  assert.deepStrictEqual(soLoss.itens.map((i) => i.itemId), ["MLB2"], "filtro Prejuízo traz só o comprovado");
});

cenario("conta COM leitura: DEAL pendente vira limite inferior; campanha do vendedor comprovada segue Prejuízo; promoções do lote lidas numa consulta", async () => {
  const { deps, consultas } = await conta({ promoSnapshot: { runId: 41, snapshotAt: "2026-11-12T18:44:00Z" }, promocoesPorItem: {
    MLB1: [promo({ id: "P-8", tipo: "DEAL" })],
    MLB3: [promo({ id: "L-1", tipo: "LIGHTNING" })],
    MLB5: [promo({ id: "C-1", tipo: "SELLER_CAMPAIGN" })],
  } });
  const resumo = await read.obterResumo({ clienteSlug: "loja-a", clienteContaId: 5 }, deps);
  assert.strictEqual(consultas.porItem, 1, "UMA consulta para os promocionais fora do mapa da conta");
  assert.deepStrictEqual(resumo.kpis.limiteInferior, { total: 2, LOSS: 1, LOW_MARGIN: 1 });
  assert.strictEqual(resumo.kpis.porStatus.LOSS, 2, "MLB2 (sem promoção) + MLB5 (vendedor 100%)");
  const r = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5 }, deps);
  const porId = Object.fromEntries(r.itens.map((i) => [i.itemId, i]));
  assert.strictEqual(porId.MLB5.status, "LOSS");
  assert.strictEqual(porId.MLB5.precoVigente.financiador, "VENDEDOR");
  assert.strictEqual(porId.MLB1.status, "SUSPECT_DATA");
  assert.strictEqual(porId.MLB3.precoVigente.motivo, "PARTICIPACAO_ML_NAO_INFORMADA");
});

async function main() {
  let falhas = 0;
  for (const c of casos) {
    try { await c.fn(); console.log(`  ✓ ${c.nome}`); } catch (err) { falhas += 1; console.log(`  ✗ ${c.nome}\n    ${err && err.stack ? err.stack.split("\n").slice(0, 8).join("\n    ") : err}`); }
  }
  if (falhas) { console.log(`margemLimiteInferior: ${falhas} de ${casos.length} cenários falharam`); process.exit(1); }
  console.log(`margemLimiteInferior: ok (${casos.length} cenários)`);
}
main();
