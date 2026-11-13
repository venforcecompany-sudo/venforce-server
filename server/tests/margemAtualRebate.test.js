// server/tests/margemAtualRebate.test.js
// Margem ATUAL de anúncio em promoção com retorno ML (rebate): o preço atual já
// é o promocional, mas o snapshot calcula a margem sem o retorno. A correção é
// na LEITURA e é a mesma na tabela, no drawer (mesmo item) e nas Oportunidades.
// Sem banco real, sem ML.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://127.0.0.1:1/dead";

const assert = require("assert");
const core = require("../services/motorMargem/core");
const read = require("../services/motorMargem/marginSnapshotReadService");
const { margemAtualComRebate, carregarRebatesAtivos, reclassificarStatus, MOTIVO_REBATE } = require("../services/motorMargem/margemAtualRebate");
const promoRepo = require("../services/promoSnapshot/promoSnapshotRepository");
const { listarOportunidades } = require("../services/motorMargem/precificacao/precificacaoOportunidadesService");
const { elegiveisReferencia } = require("./helpers/oportunidadesReferencia");
const snapshotRepository = require("../services/motorMargem/marginSnapshotRepository");
const runRepository = require("../services/motorMargem/marginSnapshotRunRepository");
const runService = require("../services/motorMargem/marginSnapshotRunService");
const { makeMarginSnapshotFakeDb } = require("./helpers/marginSnapshotFakeDb");
const { clienteContaServiceFake } = require("./helpers/marginSnapshotContasFake");

const casos = [];
function cenario(nome, fn) {
  casos.push({ nome, fn });
}

// Caso da rodada: preço atual (promocional) 89,77, retorno ML 3,30.
const INSUMOS = { price: 89.77, cost: 40, taxRate: 0.1, fixedFee: 0, commission: 12.1, freight: 15 };
const SEM_REBATE = core.computeMargin(INSUMOS);
const COM_REBATE = core.computeMargin({ ...INSUMOS, rebate: 3.3 });

function linha() {
  return {
    itemId: "MLB1", sku: "S", titulo: "P", marketplace: "meli", imageUrl: null,
    ...INSUMOS, profit: SEM_REBATE.profit, margin: SEM_REBATE.margin, marginPercent: Math.round(SEM_REBATE.margin * 10000) / 100,
    status: "HEALTHY", confidenceLevel: "HIGH", assumed: [], missing: [], refreshStatus: "fresh",
    calculatedAt: "2026-10-13T06:00:00Z", observedAt: "2026-10-13T06:00:00Z", runId: 7,
    quality: { targetMargin: 0.1, evidencias: {} },
  };
}
const SEM_VENDAS = { porMlb: new Map(), reembolsoPorMlb: new Map(), fallbackObservedAt: null };

cenario("a premissa: o rebate muda a margem (3,30 sobre 89,77) — senão o teste não prova nada", () => {
  assert.ok(COM_REBATE.margin > SEM_REBATE.margin);
  assert.ok(Math.abs(COM_REBATE.profit - SEM_REBATE.profit - 3.3) < 0.011);
});

cenario("margemAtualComRebate: uma promoção com retorno → margem pelo MESMO motor, rebate exposto", () => {
  const r = margemAtualComRebate(linha(), { promocoes: 1, rebate: 3.3 });
  assert.strictEqual(r.margin, COM_REBATE.margin);
  assert.strictEqual(r.profit, COM_REBATE.profit);
  assert.strictEqual(r.rebate, 3.3);
  assert.strictEqual(r.rebateMotivo, null);
});

cenario("sem promoção em andamento: margem do snapshot, intacta", () => {
  for (const info of [undefined, null]) {
    const r = margemAtualComRebate(linha(), info);
    assert.strictEqual(r.margin, SEM_REBATE.margin);
    assert.strictEqual(r.rebate, null);
    assert.strictEqual(r.rebateMotivo, null);
  }
});

cenario("duas promoções em andamento com retorno: ambíguo — não soma nem escolhe, e diz por quê", () => {
  const r = margemAtualComRebate(linha(), { promocoes: 2, rebate: null });
  assert.strictEqual(r.margin, SEM_REBATE.margin);
  assert.strictEqual(r.rebate, null);
  assert.strictEqual(r.rebateMotivo, MOTIVO_REBATE.AMBIGUO);
});

cenario("Promo Snapshot ilegível: margem do snapshot + motivo; a falha vai ao log e não derruba a leitura", async () => {
  const logs = [];
  const repo = { mapRebatesAtivosPorItem: async () => { throw new Error("db fora (access_token=APP_USR-9)"); } };
  const r = await carregarRebatesAtivos({ clienteContaId: 5, sellerId: "555", itemIds: ["MLB1"], db: {}, promoRepo: repo, logger: { error: (l) => logs.push(l) } });
  assert.strictEqual(r.indisponivel, MOTIVO_REBATE.PROMO_SNAPSHOT_INDISPONIVEL);
  assert.ok(logs.length === 1 && !logs[0].includes("APP_USR-9"), logs[0]);
  const m = margemAtualComRebate(linha(), undefined, r.indisponivel);
  assert.strictEqual(m.margin, SEM_REBATE.margin);
  assert.strictEqual(m.rebateMotivo, MOTIVO_REBATE.PROMO_SNAPSHOT_INDISPONIVEL);
  // Tabela inexistente (conta nunca teve Promo Snapshot) não é falha.
  const semTabela = await carregarRebatesAtivos({ clienteContaId: 5, sellerId: "555", itemIds: ["MLB1"], db: {}, promoRepo: { mapRebatesAtivosPorItem: async () => { const e = new Error("x"); e.code = "42P01"; throw e; } } });
  assert.strictEqual(semTabela.indisponivel, null);
  assert.strictEqual(semTabela.porItem.size, 0);
});

cenario("repositório: UMA consulta para o lote (conta + promoções do run atual); a decisão do retorno é do classificador", async () => {
  const chamadas = [];
  const smart = { current_run_id: 41, snapshot_at: "2026-11-12T18:44:00Z", item_id: "MLB1", promotion_id: "P-1", ref_id: "OFFER-MLB1-1", promotion_type: "SMART",
    nome: "Impulsione", status: "started", ativa: true, preco_final: "89.77", preco_original: "100", meli_percentage: "3.3", seller_percentage: "6.93", subsidio_ml: "3.30", observed_at: "2026-11-12T18:44:00Z", herdado: false };
  const rows = [smart, { ...smart, item_id: "MLB2", promotion_id: "P-2", ativa: null }, { ...smart, item_id: "MLB2", promotion_id: "P-3", ativa: null }];
  const db = { query: async (sql, params) => { chamadas.push({ sql, params }); return { rows }; } };
  const mapa = await promoRepo.mapRebatesAtivosPorItem({ clienteContaId: 5, sellerId: "555", itemIds: ["MLB1", "MLB1", "MLB2", "MLB3"] }, db);
  assert.strictEqual(chamadas.length, 1, "UMA consulta");
  assert.ok(/FROM promo_snapshot_contas c/.test(chamadas[0].sql) && /current_run_id/.test(chamadas[0].sql) && /IN \('started', 'active'\)/.test(chamadas[0].sql));
  assert.deepStrictEqual(chamadas[0].params, [5, "meli", "555", ["MLB1", "MLB2", "MLB3"]]);
  assert.deepStrictEqual(mapa.promoSnapshot, { runId: 41, snapshotAt: "2026-11-12T18:44:00Z" });
  assert.strictEqual(mapa.get("MLB1").linhas.length, 1);
  assert.strictEqual(mapa.get("MLB1").linhas[0].ativa, true);
  assert.strictEqual(mapa.get("MLB1").linhas[0].subsidioMl, 3.3);
  assert.strictEqual(mapa.get("MLB2").promocoes, 2);
  // Conta sem linha em promo_snapshot_contas = sem leitura de promoções (null, ≠ desconhecido).
  const vazia = await promoRepo.mapRebatesAtivosPorItem({ clienteContaId: 5, sellerId: "555", itemIds: ["MLB1"] }, { query: async () => ({ rows: [] }) });
  assert.strictEqual(vazia.size, 0);
  assert.strictEqual(vazia.promoSnapshot, null);
  assert.strictEqual((await promoRepo.mapRebatesAtivosPorItem({ clienteContaId: 5, sellerId: null, itemIds: ["MLB1"] }, db)).size, 0, "sem seller não consulta");
  assert.strictEqual(chamadas.length, 1);
});

// ── Os TRÊS pontos mostram a mesma margem atual ──────────────────────────────

cenario("promo started com subsídio 3,30: tabela, drawer e Oportunidades têm a MESMA margem atual, com o rebate", async () => {
  // 1) Tabela e drawer: o drawer lê o mesmo item.projected da tabela.
  const item = read.comporItem(linha(), SEM_VENDAS, {}, { promocoes: 1, rebate: 3.3 });
  assert.strictEqual(item.projected.margin, COM_REBATE.margin, "tabela/drawer");
  assert.strictEqual(item.margin.projected.margin, COM_REBATE.margin);
  assert.strictEqual(item.projected.rebate, 3.3);
  assert.notStrictEqual(item.projected.margin, SEM_REBATE.margin);
  // O painel Projetado × Realizado usa a MESMA margem do header (com o retorno ML),
  // e expõe o retorno como linha própria — nunca dois números de "projetada" no mesmo drawer.
  assert.strictEqual(item.projectedVsRealized.projected.margin, COM_REBATE.margin);
  assert.strictEqual(item.projectedVsRealized.projected.rebate, 3.3);
  assert.strictEqual(item.projectedVsRealized.projected.rebateMotivo, null);

  // 2) Oportunidades: a MESMA função, com a mesma promoção em andamento.
  const snapRow = { item_id: "MLB1", titulo: "P", image_url: null, price: 89.77, cost: 40, tax_rate: 0.1, fixed_fee: 0, commission_rate: 0.12, freight: 15, margin: SEM_REBATE.margin, commission: 12.1, profit: SEM_REBATE.profit };
  const db = {
    queries: [],
    async query(sql, params) {
      this.queries.push(sql);
      if (/FROM promocoes_diagnosticos\b/.test(sql)) return { rows: [{ id: 11, created_at: new Date().toISOString(), parcial: false, itens_scaneados: 1 }] };
      if (/FROM promo_snapshot_contas c/.test(sql)) {
        return { rows: [{ current_run_id: 41, snapshot_at: "2026-10-13T06:00:00Z", item_id: "MLB1", promotion_id: "P-1", ref_id: "OFFER-MLB1-1", promotion_type: "SMART",
          status: "started", ativa: true, preco_final: "89.77", preco_original: "100", meli_percentage: "3.3", seller_percentage: "6.93", subsidio_ml: "3.30", observed_at: "2026-10-13T06:00:00Z" }] };
      }
      if (/WITH promos AS/.test(sql)) {
        // Candidata: outra promoção, ainda não ativa, com preço menor que o atual (89,77).
        const promos = [{ item_id: "MLB1", chave: "000001", preco_promo: 80, retorno: 0, promo_status: "candidate", promo_id: "P2" }];
        return elegiveisReferencia({ promos, snapPorItem: new Map([["MLB1", snapRow]]) });
      }
      throw new Error("SQL inesperado: " + sql);
    },
  };
  const deps = {
    db,
    resolverContaDoCliente: async () => ({ cliente: { id: 3, slug: "loja-a" }, conta: { id: 7, nome: "Conta A" } }),
    obterConta: async () => ({ id: 7, external_account_id: "555" }),
    carregarRealizada: async () => ({ porMlb: new Map(), periodo: { dateFrom: "2026-08-31", dateTo: "2026-09-29" } }),
    now: () => new Date(),
    promo: {
      estadoComAutoTrigger: async () => ({ estado: { state: "never_synced", hasSnapshot: false, workerEnabled: false }, gatilho: { acao: "worker_desabilitado" } }),
      syncPublico: (e) => e,
    },
  };
  const r = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, deps);
  assert.strictEqual(r.oportunidades.length, 1);
  assert.strictEqual(r.oportunidades[0].margemAtual, COM_REBATE.margin, "Oportunidades");
  assert.strictEqual(r.oportunidades[0].margemAtual, item.projected.margin, "mesma margem atual nos três pontos");
  assert.strictEqual(r.oportunidades[0].margemAtualRebate, 3.3);
});

// ── Status acompanha a margem exibida (tabela, drawer e KPIs) ────────────────

// Anúncio que o snapshot persistiu como Prejuízo (custo 60 sobre preço 89,77).
const INSUMOS_LOSS = { price: 89.77, cost: 60, taxRate: 0.1, fixedFee: 0, commission: 12.1, freight: 15 };
const LOSS_CALC = core.computeMargin(INSUMOS_LOSS);

function linhaLoss(extra = {}) {
  return {
    ...linha(), ...INSUMOS_LOSS, profit: LOSS_CALC.profit, margin: LOSS_CALC.margin, marginPercent: Math.round(LOSS_CALC.margin * 10000) / 100,
    status: "LOSS", ...extra,
  };
}

cenario("premissa: sem rebate o anúncio é Prejuízo; 8,00 de retorno deixa a margem > 0 mas abaixo da meta; 20,00 deixa saudável", () => {
  assert.ok(LOSS_CALC.margin < 0);
  assert.ok(core.computeMargin({ ...INSUMOS_LOSS, rebate: 8 }).margin > 0 && core.computeMargin({ ...INSUMOS_LOSS, rebate: 8 }).margin < 0.1);
  assert.ok(core.computeMargin({ ...INSUMOS_LOSS, rebate: 20 }).margin >= 0.1);
});

cenario("reclassificarStatus: LOSS persistido + rebate que deixa margem > 0 → não é mais Prejuízo (mesma classifyStatus do núcleo)", () => {
  const l = linhaLoss();
  const baixo = reclassificarStatus(l, margemAtualComRebate(l, { promocoes: 1, rebate: 8 }));
  assert.strictEqual(baixo.status, "LOW_MARGIN");
  assert.strictEqual(baixo.de, "LOSS");
  assert.deepStrictEqual(baixo.reasons, core.classifyStatus({ margin: core.computeMargin({ ...INSUMOS_LOSS, rebate: 8 }).margin, computable: true, confidenceLevel: "HIGH", targetMargin: 0.1 }).reasons, "o motivo vem do núcleo");
  const ok = reclassificarStatus(l, margemAtualComRebate(l, { promocoes: 1, rebate: 20 }));
  assert.strictEqual(ok.status, "HEALTHY");
  // Rebate insuficiente: continua Prejuízo (nada a reclassificar).
  assert.strictEqual(reclassificarStatus(l, margemAtualComRebate(l, { promocoes: 1, rebate: 1 })), null);
  // Sem rebate / ambíguo / indisponível: nunca reclassifica.
  assert.strictEqual(reclassificarStatus(l, margemAtualComRebate(l, undefined)), null);
  assert.strictEqual(reclassificarStatus(l, margemAtualComRebate(l, { promocoes: 2, rebate: null })), null);
  assert.strictEqual(reclassificarStatus(l, margemAtualComRebate(l, { promocoes: 1, rebate: 8 }, "PROMO_SNAPSHOT_INDISPONIVEL")), null);
  // Status que não dependem da margem não mudam com o retorno.
  for (const status of ["UNVALIDATED", "SUSPECT_DATA", "RECONCILING"]) {
    const x = linhaLoss({ status });
    assert.strictEqual(reclassificarStatus(x, margemAtualComRebate(x, { promocoes: 1, rebate: 20 })), null, status);
  }
  // Confiança baixa persistida: o dado continua suspeito (status SUSPECT_DATA já seria o persistido, mas a regra do núcleo se mantém).
  const baixaConf = linhaLoss({ status: "LOSS", confidenceLevel: "LOW" });
  assert.strictEqual(reclassificarStatus(baixaConf, margemAtualComRebate(baixaConf, { promocoes: 1, rebate: 20 })).status, "SUSPECT_DATA");
});

cenario("comporItem (tabela e drawer): LOSS persistido + rebate → status exibido não é Prejuízo, com margem, motivo e rastro da reclassificação", () => {
  const item = read.comporItem(linhaLoss(), SEM_VENDAS, {}, { promocoes: 1, rebate: 8 });
  const margem = core.computeMargin({ ...INSUMOS_LOSS, rebate: 8 });
  assert.strictEqual(item.projected.margin, margem.margin);
  assert.ok(item.projected.margin > 0);
  assert.strictEqual(item.status, "LOW_MARGIN");
  assert.strictEqual(item.quality.status, "LOW_MARGIN");
  assert.strictEqual(item.quality.statusLabel, "Margem baixa");
  assert.deepStrictEqual(item.quality.statusReclassificado, { de: "LOSS", para: "LOW_MARGIN", motivo: "retorno_ml" });
  assert.ok(!/negativa/i.test(item.problema), item.problema);
  // Sem rebate: o status persistido segue valendo, sem rastro.
  const sem = read.comporItem(linhaLoss(), SEM_VENDAS, {}, null);
  assert.strictEqual(sem.status, "LOSS");
  assert.strictEqual(sem.quality.statusReclassificado, null);
});

// Conta com 5 anúncios; o snapshot persistiu 4 como Prejuízo.
async function contaComRebates({ rebates }) {
  const db = makeMarginSnapshotFakeDb();
  const base = { clienteId: 1, clienteContaId: 5, marketplace: "meli", baseId: 9, confidenceLevel: "HIGH", quality: { targetMargin: 0.1 }, missing: [], assumed: [], divergences: [],
    observedAt: new Date("2026-10-13T06:00:00Z"), calculatedAt: new Date("2026-10-13T06:00:05Z"), runId: 1, refreshStatus: "fresh", lastError: null };
  const loss = (itemId) => ({ ...base, itemId, sku: itemId, titulo: itemId, ...INSUMOS_LOSS, profit: LOSS_CALC.profit, margin: LOSS_CALC.margin, marginPercent: Math.round(LOSS_CALC.margin * 10000) / 100, status: "LOSS" });
  const sao = { ...base, itemId: "MLB5", sku: "MLB5", titulo: "MLB5", ...INSUMOS, profit: SEM_REBATE.profit, margin: SEM_REBATE.margin, marginPercent: Math.round(SEM_REBATE.margin * 10000) / 100, status: "HEALTHY" };
  for (const id of ["MLB1", "MLB2", "MLB3", "MLB4"]) await snapshotRepository.upsertProjectionSnapshot(loss(id), db);
  await snapshotRepository.upsertProjectionSnapshot(sao, db);
  const { run } = await runService.enqueueMarginSnapshotRun({ clienteId: 1, clienteSlug: "loja-a", clienteContaId: 5, reason: "manual_refresh", db });
  await runRepository.updateRunStatus({ runId: run.id, status: "running", db });
  await runRepository.updateRunStatus({ runId: run.id, status: "completed", db });
  const consultas = [];
  const deps = {
    db,
    env: { MARGIN_SNAPSHOT_READ_ENABLED: "true" },
    now: new Date("2026-09-28T15:00:00Z"),
    clienteContaService: { ...clienteContaServiceFake, obterConta: async (id) => ({ ...(await clienteContaServiceFake.obterConta(id)), external_account_id: "555" }) },
    contarContasAtivas: async () => 2,
    carregarVendas: async () => ({ sincronizado: true, pedidos: [], pedidosTodos: [], itens: [], componentes: [], imports: [{ id: 1 }], competencias: [] }),
    promoRepository: {
      mapRebatesAtivosDaConta: async (args) => { consultas.push(args); return new Map(rebates); },
    },
  };
  return { db, deps, consultas };
}

// MLB1: 8,00 → margem baixa · MLB2: 20,00 → saudável · MLB3: 1,00 → segue Prejuízo · MLB4: sem promoção · MLB5: saudável com 3,30.
const REBATES_CONTA = [
  ["MLB1", { promocoes: 1, rebate: 8 }], ["MLB2", { promocoes: 1, rebate: 20 }], ["MLB3", { promocoes: 1, rebate: 1 }], ["MLB5", { promocoes: 1, rebate: 3.3 }],
];

cenario("listarItens (a tabela de verdade): UMA consulta de rebates da conta; status efetivo só onde o retorno muda a classificação", async () => {
  const { deps, consultas } = await contaComRebates({ rebates: REBATES_CONTA });
  const r = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5 }, deps);
  assert.strictEqual(consultas.length, 1, "UMA consulta de rebates por requisição (nunca por item)");
  assert.deepStrictEqual([consultas[0].clienteContaId, consultas[0].sellerId], [5, "555"]);
  const porId = Object.fromEntries(r.itens.map((i) => [i.itemId, i]));
  assert.deepStrictEqual(
    Object.fromEntries(Object.entries(porId).map(([id, i]) => [id, i.status])),
    { MLB1: "LOW_MARGIN", MLB2: "HEALTHY", MLB3: "LOSS", MLB4: "LOSS", MLB5: "HEALTHY" }
  );
  assert.strictEqual(porId.MLB1.projected.margin, core.computeMargin({ ...INSUMOS_LOSS, rebate: 8 }).margin);
  assert.strictEqual(porId.MLB1.projected.rebate, 8);
  assert.strictEqual(porId.MLB3.projected.margin, core.computeMargin({ ...INSUMOS_LOSS, rebate: 1 }).margin, "rebate aplicado mesmo sem mudar o status");
  assert.strictEqual(porId.MLB4.projected.rebate, null);
  assert.strictEqual(porId.MLB5.projected.margin, COM_REBATE.margin);
});

cenario("KPIs (placar da conta): o anúncio que o retorno ML tirou de Prejuízo NÃO conta como Prejuízo", async () => {
  const { deps } = await contaComRebates({ rebates: REBATES_CONTA });
  const resumo = await read.obterResumo({ clienteSlug: "loja-a", clienteContaId: 5 }, deps);
  assert.strictEqual(resumo.estado, "ready");
  // Persistido: 4 Prejuízo + 1 Saudável. Efetivo: MLB1 → Margem baixa, MLB2 → Saudável.
  assert.deepStrictEqual(
    { LOSS: resumo.kpis.porStatus.LOSS, LOW_MARGIN: resumo.kpis.porStatus.LOW_MARGIN, HEALTHY: resumo.kpis.porStatus.HEALTHY },
    { LOSS: 2, LOW_MARGIN: 1, HEALTHY: 2 }
  );
  assert.strictEqual(resumo.kpis.total, 5);
  const somaStatus = Object.values(resumo.kpis.porStatus).reduce((a, b) => a + b, 0);
  assert.strictEqual(somaStatus, 5, "cada anúncio conta uma única vez");
});

cenario("KPI LC/un em prejuízo: soma só o que SEGUE em Prejuízo, já com o retorno ML dos que continuam nele", async () => {
  const { deps } = await contaComRebates({ rebates: REBATES_CONTA });
  const resumo = await read.obterResumo({ clienteSlug: "loja-a", clienteContaId: 5 }, deps);
  // Seguem em Prejuízo: MLB3 (retorno 1,00) e MLB4 (sem promoção). MLB1/MLB2 saíram e não entram na soma.
  const esperado = Math.round((2 * LOSS_CALC.profit + 1 + Number.EPSILON) * 100) / 100;
  assert.strictEqual(resumo.kpis.lcPrejuizo, esperado);
  assert.ok(resumo.kpis.lcPrejuizo < 0);
  // Sem retorno nenhum: soma do persistido dos 4 em Prejuízo.
  const sem = await contaComRebates({ rebates: [] });
  const resumoSem = await read.obterResumo({ clienteSlug: "loja-a", clienteContaId: 5 }, sem.deps);
  assert.strictEqual(resumoSem.kpis.lcPrejuizo, Math.round((4 * LOSS_CALC.profit + Number.EPSILON) * 100) / 100);
  // Conta ainda sem leitura: sem placar (null), nunca R$ 0 fingindo leitura.
  const vazia = makeMarginSnapshotFakeDb();
  const resumoVazio = await read.obterResumo({ clienteSlug: "loja-a", clienteContaId: 5 }, { ...sem.deps, db: vazia });
  assert.strictEqual(resumoVazio.kpis, null);
});

// Receita realizada por MLB (a ordem worklist usa a receita REALIZADA): o agregador real do
// fixture, com a receita de cada MLB trocada pelo valor do teste.
function comReceitas(deps, receitas) {
  const motor = require("./helpers/motorMargemFixture").motorDeps({ comVendas: true });
  return {
    ...deps,
    carregarVendas: motor.carregarVendas,
    agregarPorMlb: (args) => {
      const real = motor.agregarPorMlb(args);
      const molde = real.porMlb.values().next().value;
      return { ...real, porMlb: new Map(Object.entries(receitas).map(([id, receita]) => [id, { ...molde, receita }])) };
    },
  };
}

cenario("ordenacao=worklist: prejuízo → abaixo da meta → resto, e dentro de cada grupo a MAIOR receita primeiro (status efetivo)", async () => {
  const { deps } = await contaComRebates({ rebates: REBATES_CONTA });
  const d = comReceitas(deps, { MLB1: 100, MLB2: 900, MLB3: 300, MLB4: 700, MLB5: 50 });
  const r = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5, ordenacao: "worklist" }, d);
  // MLB3/MLB4 seguem Prejuízo (700 > 300); MLB1 virou Margem baixa; MLB2/MLB5 saudáveis (900 > 50)
  assert.deepStrictEqual(r.itens.map((i) => i.itemId), ["MLB4", "MLB3", "MLB1", "MLB2", "MLB5"]);
  assert.deepStrictEqual(r.itens.map((i) => i.status), ["LOSS", "LOSS", "LOW_MARGIN", "HEALTHY", "HEALTHY"]);
  assert.deepStrictEqual(r.ordenacao, { chave: "worklist", direcao: "ASC" });
  // página estável: sem repetir nem pular
  const p1 = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5, ordenacao: "worklist", limit: 2, page: 1 }, d);
  const p2 = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5, ordenacao: "worklist", limit: 2, page: 2 }, d);
  const p3 = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5, ordenacao: "worklist", limit: 2, page: 3 }, d);
  assert.deepStrictEqual([...p1.itens, ...p2.itens, ...p3.itens].map((i) => i.itemId), ["MLB4", "MLB3", "MLB1", "MLB2", "MLB5"]);
  // sem retorno ML nenhum o grupo do prejuízo cresce (os 4 persistidos, por receita) e o saudável fica por último
  const sem = await contaComRebates({ rebates: [] });
  const r2 = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5, ordenacao: "worklist" }, comReceitas(sem.deps, { MLB1: 100, MLB2: 900, MLB3: 300, MLB4: 700, MLB5: 5000 }));
  assert.deepStrictEqual(r2.itens.map((i) => i.itemId), ["MLB2", "MLB4", "MLB3", "MLB1", "MLB5"], "os 4 persistidos em Prejuízo vêm antes do saudável MLB5, mesmo com ele tendo a maior receita");
});

cenario("ordenacao=worklist: realizado indisponível não derruba a lista (receita desconhecida = 0; desempate por item) e direção DESC é recusada", async () => {
  const { deps } = await contaComRebates({ rebates: REBATES_CONTA });
  const falha = { ...deps, carregarVendas: async () => { throw new Error("central fora"); }, logger: { error() {} } };
  const r = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5, ordenacao: "worklist" }, falha);
  assert.deepStrictEqual(r.itens.map((i) => i.itemId), ["MLB3", "MLB4", "MLB1", "MLB2", "MLB5"]);
  assert.strictEqual(r.vendas.realizado, null);
  assert.strictEqual(r.vendas.realizado_motivo, "CENTRAL_VENDAS_FALHOU");
  await assert.rejects(
    () => read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5, ordenacao: "worklist", direcao: "DESC" }, deps),
    (err) => err.statusCode === 400 && err.payload.codigo === "ORDENACAO_INVALIDA"
  );
});

cenario("filtro e ordenação por status usam o status EFETIVO (a lista bate com o placar)", async () => {
  const { deps } = await contaComRebates({ rebates: REBATES_CONTA });
  const ids = (r) => r.itens.map((i) => i.itemId).sort();
  const loss = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5, status: "LOSS" }, deps);
  assert.deepStrictEqual(ids(loss), ["MLB3", "MLB4"], "MLB1/MLB2 saíram de Prejuízo");
  assert.strictEqual(loss.paginacao.total, 2, "a contagem acompanha o filtro");
  const baixa = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5, status: "LOW_MARGIN" }, deps);
  assert.deepStrictEqual(ids(baixa), ["MLB1"], "persistido como Prejuízo, efetivo Margem baixa");
  assert.ok(baixa.itens.every((i) => i.status === "LOW_MARGIN"), "o que o filtro mostra é o que a linha exibe");
  const saudavel = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5, status: "HEALTHY" }, deps);
  assert.deepStrictEqual(ids(saudavel), ["MLB2", "MLB5"]);
  const ordenado = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5, ordenacao: "status", direcao: "ASC" }, deps);
  assert.deepStrictEqual(ordenado.itens.map((i) => i.status), ["LOSS", "LOSS", "LOW_MARGIN", "HEALTHY", "HEALTHY"], "Prejuízo primeiro (precedência do núcleo), por status efetivo");
});

cenario("sem promoção em andamento com retorno: nenhum override — SQL, KPIs e itens idênticos ao snapshot", async () => {
  const { deps } = await contaComRebates({ rebates: [] });
  const resumo = await read.obterResumo({ clienteSlug: "loja-a", clienteContaId: 5 }, deps);
  assert.deepStrictEqual([resumo.kpis.porStatus.LOSS, resumo.kpis.porStatus.HEALTHY], [4, 1]);
  const filtro = snapshotRepository.montarFiltroSnapshots({ clienteId: 1, clienteContaId: 5 });
  assert.strictEqual(filtro.statusExpr, "status", "sem override o SQL é o de sempre");
  assert.strictEqual(filtro.params.length, 3);
});

cenario("Promo Snapshot ilegível: KPIs e itens ficam com o status persistido (nunca meio-corrigidos) e a falha vai ao log", async () => {
  const { deps } = await contaComRebates({ rebates: [] });
  const logs = [];
  deps.promoRepository = { mapRebatesAtivosDaConta: async () => { throw new Error("db fora"); } };
  deps.logger = { error: (l) => logs.push(l) };
  const resumo = await read.obterResumo({ clienteSlug: "loja-a", clienteContaId: 5 }, deps);
  assert.strictEqual(resumo.kpis.porStatus.LOSS, 4);
  const r = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5 }, deps);
  assert.ok(r.itens.every((i) => i.status === (i.itemId === "MLB5" ? "HEALTHY" : "LOSS")));
  assert.ok(r.itens.every((i) => i.projected.rebateMotivo === "PROMO_SNAPSHOT_INDISPONIVEL"));
  assert.ok(logs.length >= 1);
});

(async () => {
  let falhas = 0;
  for (const { nome, fn } of casos) {
    try {
      await fn();
      console.log(`  ✓ ${nome}`);
    } catch (err) {
      falhas += 1;
      console.log(`  ✗ ${nome}\n    ${err.message}\n    ${(err.stack.split("\n").find((l) => l.includes(".test.js")) || "").trim()}`);
    }
  }
  if (falhas) {
    console.log(`margemAtualRebate: ${falhas} de ${casos.length} cenários falharam`);
    process.exit(1);
  }
  console.log(`margemAtualRebate: ok (${casos.length} cenários)`);
})();
