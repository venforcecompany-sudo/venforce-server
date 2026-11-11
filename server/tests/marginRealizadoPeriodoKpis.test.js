// server/tests/marginRealizadoPeriodoKpis.test.js
// Realizado da Central de Margem: PERÍODO (padrão até ontem, `periodo` do
// Shell, personalizado), COBERTURA por competência (R-01), KPIs da conta
// (ponderados, pedidos distintos, cobertura) e o endpoint /snapshot/realizado
// (conta explícita, 1 query de projeções, freshness). Sem banco real, sem ML.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://127.0.0.1:1/dead";

const assert = require("assert");
const repo = require("../services/centralVendas/centralVendasRepository");
const periodo = require("../services/motorMargem/marginRealizadoPeriodo");
const { agregarKpisRealizados } = require("../services/motorMargem/marginRealizadoKpis");
const cv = require("../services/motorMargem/adapters/centralVendasEvidenceAdapter");
const read = require("../services/motorMargem/marginSnapshotReadService");
const snapshotRepository = require("../services/motorMargem/marginSnapshotRepository");
const { makeMarginSnapshotFakeDb } = require("./helpers/marginSnapshotFakeDb");
const { clienteContaServiceFake } = require("./helpers/marginSnapshotContasFake");

const casos = [];
function cenario(nome, fn) {
  casos.push({ nome, fn });
}

const LIGADO = { MARGIN_SNAPSHOT_READ_ENABLED: "true" };

// ═══════════════════════════════════════════════════════════════════════════
// Período
// ═══════════════════════════════════════════════════════════════════════════

cenario("padrão: últimos 30 dias ATÉ ONTEM no fuso de São Paulo", () => {
  const p = periodo.resolverPeriodoRealizado({ now: new Date("2026-09-28T15:00:00Z") });
  assert.strictEqual(p.modo, "ultimos30");
  assert.strictEqual(p.dateTo, "2026-09-27");
  assert.strictEqual(p.dateFrom, "2026-08-29");
  assert.strictEqual(p.referencia.fuso, "America/Sao_Paulo");
  assert.ok(p.rotulo.includes("27/09/2026"), p.rotulo);

  // 01:30 UTC de 28/09 ainda é 27/09 em São Paulo → ontem = 26/09.
  const madrugada = periodo.resolverPeriodoRealizado({ now: new Date("2026-09-28T01:30:00Z") });
  assert.strictEqual(madrugada.dateTo, "2026-09-26");
});

cenario("periodo=YYYY-MM (parâmetro global do Shell): mês fechado inteiro; mês corrente até ontem", () => {
  const now = new Date("2026-09-28T15:00:00Z");
  const fechado = periodo.resolverPeriodoRealizado({ periodo: "2026-08", now });
  assert.deepStrictEqual([fechado.modo, fechado.dateFrom, fechado.dateTo], ["mes", "2026-08-01", "2026-08-31"]);
  assert.strictEqual(fechado.rotulo, "agosto/2026");

  const corrente = periodo.resolverPeriodoRealizado({ periodo: "2026-09", now });
  assert.deepStrictEqual([corrente.dateFrom, corrente.dateTo], ["2026-09-01", "2026-09-27"]);
  assert.ok(corrente.rotulo.includes("até 27/09/2026"), corrente.rotulo);

  // Dia 1: o mês ainda não tem dia fechado — período de 1 dia, nunca invertido.
  const dia1 = periodo.resolverPeriodoRealizado({ periodo: "2026-10", now: new Date("2026-10-01T15:00:00Z") });
  assert.deepStrictEqual([dia1.dateFrom, dia1.dateTo], ["2026-10-01", "2026-10-01"]);

  // Borda de ano e mês inválido.
  const dezembro = periodo.resolverPeriodoRealizado({ periodo: "2025-12", now });
  assert.deepStrictEqual([dezembro.dateFrom, dezembro.dateTo], ["2025-12-01", "2025-12-31"]);
  assert.strictEqual(periodo.resolverPeriodoRealizado({ periodo: "2026-13", now }).modo, "ultimos30");
});

cenario("personalizado: datas explícitas vencem, invertidas são corrigidas, inválidas caem no padrão", () => {
  const now = new Date("2026-09-28T15:00:00Z");
  const p = periodo.resolverPeriodoRealizado({ dateFrom: "2026-09-10", dateTo: "2026-09-01", periodo: "2026-08", now });
  assert.deepStrictEqual([p.modo, p.dateFrom, p.dateTo], ["personalizado", "2026-09-01", "2026-09-10"]);
  const invalido = periodo.resolverPeriodoRealizado({ dateFrom: "2026-02-30", dateTo: "2026-03-01", now });
  assert.strictEqual(invalido.modo, "ultimos30");
});

// ═══════════════════════════════════════════════════════════════════════════
// Cobertura (R-01)
// ═══════════════════════════════════════════════════════════════════════════

const IMPORTS_NOTURNO = [
  // Mês anterior fechado, publicado.
  { id: 10, competencia: "2026-08", publication_status: "published", coverage_date_from: "2026-08-01", coverage_date_to: "2026-08-31", published_at: "2026-09-05T06:00:00Z", created_at: "2026-09-05T05:00:00Z" },
  // Mês corrente publicado pelo noturno de hoje: ATÉ ONTEM.
  { id: 11, competencia: "2026-09", publication_status: "published", coverage_date_from: "2026-09-01", coverage_date_to: "2026-09-27", published_at: "2026-09-28T06:10:00Z", created_at: "2026-09-28T06:00:00Z" },
  // Candidate de um run que não publicou: nunca elegível.
  { id: 12, competencia: "2026-09", publication_status: "candidate", coverage_date_from: "2026-09-01", coverage_date_to: "2026-09-28", published_at: null, created_at: "2026-09-28T10:00:00Z" },
];
function dbImports(rows) {
  return { query: async (sql) => (sql.includes("FROM central_vendas_imports") ? { rows: rows.filter((r) => r.publication_status !== "candidate") } : { rows: [] }) };
}

cenario("R-01 (regressão): com o período PADRÃO, o import do mês corrente publicado até ontem é usado", async () => {
  const p = periodo.resolverPeriodoRealizado({ now: new Date("2026-09-28T15:00:00Z") });
  const sel = await repo.resolveImportsForRange({ clienteSlug: "x", dateFrom: p.dateFrom, dateTo: p.dateTo, clienteContaId: 5 }, dbImports(IMPORTS_NOTURNO));
  assert.deepStrictEqual(sel.importIds, [10, 11], "agosto E setembro");
  const cobertura = periodo.resumirCobertura({ competencias: sel.competencias });
  assert.strictEqual(cobertura.estado, periodo.ESTADOS_REALIZADO.ATUAL);
  assert.strictEqual(cobertura.sincronizadoAte, "2026-09-27");
  assert.strictEqual(cobertura.ultimaPublicacaoEm, "2026-09-28T06:10:00.000Z");
  assert.deepStrictEqual(cobertura.lacunas, []);
});

cenario("período até HOJE não usa o import até ontem — mas agora a lacuna é declarada, nunca 'sem venda'", async () => {
  const sel = await repo.resolveImportsForRange({ clienteSlug: "x", dateFrom: "2026-08-30", dateTo: "2026-09-28", clienteContaId: 5 }, dbImports(IMPORTS_NOTURNO));
  assert.deepStrictEqual(sel.importIds, [10], "a regra M4 não muda");
  const cobertura = periodo.resumirCobertura({ competencias: sel.competencias });
  assert.strictEqual(cobertura.estado, periodo.ESTADOS_REALIZADO.PARCIAL);
  assert.strictEqual(cobertura.lacunas.length, 1);
  assert.deepStrictEqual(cobertura.lacunas[0], {
    competencia: "2026-09",
    segmento: { dateFrom: "2026-09-01", dateTo: "2026-09-28" },
    motivo: "COBERTURA_INSUFICIENTE",
    publicadoDe: "2026-09-01",
    publicadoAte: "2026-09-27",
    publicadoEm: "2026-09-28T06:10:00.000Z",
  });
  assert.strictEqual(cobertura.sincronizadoAte, "2026-09-27");
});

cenario("mês sem nenhum import: SEM_SINCRONIZACAO; legado sem cobertura declarada: NAO_DECLARADA", async () => {
  const vazio = await repo.resolveImportsForRange({ clienteSlug: "x", dateFrom: "2026-07-01", dateTo: "2026-07-31", clienteContaId: 5 }, dbImports(IMPORTS_NOTURNO));
  const c1 = periodo.resumirCobertura({ competencias: vazio.competencias });
  assert.strictEqual(c1.estado, periodo.ESTADOS_REALIZADO.SEM_SINCRONIZACAO);
  assert.strictEqual(c1.lacunas[0].motivo, "SEM_IMPORT_PUBLICADO");
  assert.strictEqual(c1.sincronizadoAte, null);

  const legado = [{ id: 20, competencia: "2026-06", publication_status: "legacy", coverage_date_from: null, coverage_date_to: null, published_at: null, created_at: "2026-07-02T10:00:00Z" }];
  const sel = await repo.resolveImportsForRange({ clienteSlug: "x", dateFrom: "2026-06-01", dateTo: "2026-06-30", clienteContaId: 5 }, dbImports(legado));
  const c2 = periodo.resumirCobertura({ competencias: sel.competencias });
  assert.strictEqual(c2.estado, periodo.ESTADOS_REALIZADO.NAO_DECLARADA);
  assert.strictEqual(c2.origem, "legacy");
  assert.strictEqual(c2.sincronizadoAte, null, "legado não declara cobertura: nada é inventado");
  assert.strictEqual(c2.ultimoImportEm, "2026-07-02T10:00:00.000Z");
});

// ═══════════════════════════════════════════════════════════════════════════
// KPIs da conta
// ═══════════════════════════════════════════════════════════════════════════

let seq = 0;
function it(pedido, mlb, { qtd = 1, unit = 100, custo, imposto } = {}) {
  seq += 1;
  return { id: 5000 + seq, pedido_row_id: pedido, mlb, titulo: mlb, quantidade: qtd, valor_unitario: unit, receita_produto: unit * qtd, custo_produto: custo === undefined ? null : custo, imposto_interno: imposto === undefined ? null : imposto, resultado: null };
}
function tarifa(item, v) { return { item_row_id: item.id, pedido_row_id: item.pedido_row_id, tipo: "tarifa_venda", valor: -v }; }
function frete(item, v) { return { item_row_id: item.id, pedido_row_id: item.pedido_row_id, tipo: "frete_seller", valor: -v }; }

function cenarioVendas() {
  // A: 1 un a R$ 1000 com margem 40%; B: 10 un a R$ 10 com margem 10%.
  // Média simples das margens = 25%; margem ponderada correta ≈ 37,27%.
  const a = it(1, "MLB1", { qtd: 1, unit: 1000, custo: 500, imposto: 0 });
  const b1 = it(2, "MLB2", { qtd: 5, unit: 10, custo: 40, imposto: 0 });
  // Pedido 3 é multi-item (B + C): conta UMA vez em pedidos.
  const b2 = it(3, "MLB2", { qtd: 5, unit: 10, custo: 40, imposto: 0 });
  const c = it(3, "MLB3", { qtd: 2, unit: 50 }); // sem custo histórico
  const semMlb = it(4, null, { qtd: 1, unit: 20 });
  const pedidos = [1, 2, 3, 4].map((id) => ({ id, status: "paid", data_pedido: "2026-09-10" }));
  const itens = [a, b1, b2, c, semMlb];
  const componentes = [tarifa(a, 100), frete(a, 0), tarifa(b1, 5), frete(b1, 0), tarifa(b2, 5), frete(b2, 0), tarifa(c, 10), frete(c, 5)];
  return { pedidos, itens, componentes };
}

cenario("KPIs: margem da conta é Σlucro ÷ Σreceita dos calculáveis (ponderada), nunca média das margens", () => {
  const v = cenarioVendas();
  const agg = cv.agregarPorMlb({ pedidosTodos: v.pedidos, pedidosResultado: v.pedidos, itens: v.itens, componentes: v.componentes });
  const k = agregarKpisRealizados({ porMlb: agg.porMlb, semMlb: agg.semMlb, pedidosNoPeriodo: v.pedidos.length });

  assert.strictEqual(k.receita, 1220, "1000 + 100 + 100 + 20 (sem MLB)");
  assert.strictEqual(k.receitaSemMlb, 20);
  assert.strictEqual(k.unidades, 14);
  assert.strictEqual(k.pedidos, 4, "pedidos DISTINTOS (o multi-item conta 1 vez)");
  assert.strictEqual(k.produtosComVenda, 3);
  // A: 1000-100-500 = 400; B: 10 un × (10-1-8) = 10 → Σ 410 sobre Σ 1100.
  assert.strictEqual(k.lucro.valor, 410);
  assert.strictEqual(k.margem.percent, 37.27, "410/1100 (média simples daria 25%)");
  assert.strictEqual(k.margem.produtosCalculaveis, 2);
  assert.strictEqual(k.margem.produtosSemMargem, 1, "C vendeu sem custo histórico");
  assert.deepStrictEqual(k.margem.semMargemPorMotivo, { cost: 1 });
  assert.strictEqual(k.margem.estado, "parcial", "receita de C e a sem MLB não sustentam margem");
  assert.strictEqual(k.margem.coberturaReceita, 0.9016, "1100 / 1220");
  assert.ok(/taxa fixa|sem histórico/.test(k.margem.taxaFixa));
});

cenario("KPIs: nenhum anúncio calculável → lucro e margem null (indisponível), nunca 0", () => {
  const c = it(9, "MLB9", { qtd: 1, unit: 50 });
  const pedidos = [{ id: 9, status: "paid", data_pedido: "2026-09-10" }];
  const agg = cv.agregarPorMlb({ pedidosTodos: pedidos, pedidosResultado: pedidos, itens: [c], componentes: [] });
  const k = agregarKpisRealizados({ porMlb: agg.porMlb, semMlb: agg.semMlb, pedidosNoPeriodo: 1 });
  assert.strictEqual(k.lucro.valor, null);
  assert.strictEqual(k.margem.percent, null);
  assert.strictEqual(k.margem.estado, "indisponivel");
  assert.strictEqual(k.receita, 50);

  const vazio = agregarKpisRealizados({ porMlb: new Map(), semMlb: { linhas: 0, unidades: 0, receita: 0 }, pedidosNoPeriodo: 0 });
  assert.strictEqual(vazio.receita, 0);
  assert.strictEqual(vazio.margem.coberturaReceita, null);
  assert.strictEqual(vazio.drift.disponivel, false);
});

cenario("KPIs: drift = margem realizada do mix − projetada do MESMO mix; piores anúncios listados", () => {
  const v = cenarioVendas();
  const agg = cv.agregarPorMlb({ pedidosTodos: v.pedidos, pedidosResultado: v.pedidos, itens: v.itens, componentes: v.componentes });
  const projecoes = new Map([
    // A projetava 45% (preço 1000, lucro 450) → realizou 40% (−5 p.p.).
    ["MLB1", { price: 1000, profit: 450, margin: 0.45, titulo: "A" }],
    // B projetava 10% → realizou 10%.
    ["MLB2", { price: 10, profit: 1, margin: 0.1, titulo: "B" }],
  ]);
  const k = agregarKpisRealizados({ porMlb: agg.porMlb, semMlb: agg.semMlb, pedidosNoPeriodo: 4, projecoes });
  assert.strictEqual(k.drift.disponivel, true);
  assert.strictEqual(k.drift.produtosComparados, 2);
  // Projetada do mix: (450×1 + 1×10) / (1000×1 + 10×10) = 460/1100 = 41,82%.
  assert.strictEqual(k.drift.margemProjetadaMixPercent, 41.82);
  assert.strictEqual(k.drift.margemRealizadaMixPercent, 37.27);
  assert.strictEqual(k.drift.pp, -4.55);
  assert.strictEqual(k.drift.produtosNegativos, 1);
  assert.strictEqual(k.drift.piores[0].itemId, "MLB1");
  assert.strictEqual(k.drift.piores[0].driftPp, -5);
});

// ═══════════════════════════════════════════════════════════════════════════
// Endpoint /snapshot/realizado + /itens
// ═══════════════════════════════════════════════════════════════════════════

function depsRealizado(db, { vendas = cenarioVendas(), competencias = [], contarContasAtivas = 2, extra = {} } = {}) {
  const chamadas = { carregarVendas: [], syncAtivo: 0 };
  return {
    chamadas,
    deps: {
      db,
      env: LIGADO,
      now: new Date("2026-09-28T15:00:00Z"),
      clienteContaService: clienteContaServiceFake,
      contarContasAtivas: async () => contarContasAtivas,
      carregarVendas: async (args) => {
        chamadas.carregarVendas.push(args);
        return { sincronizado: true, pedidos: vendas.pedidos, pedidosTodos: vendas.pedidos, itens: vendas.itens, componentes: vendas.componentes, imports: [{ id: 1 }], competencias, importSnapshotAt: null };
      },
      buscarSyncAtivo: async () => { chamadas.syncAtivo += 1; return null; },
      ...extra,
    },
  };
}

function contadorDeQueries(db) {
  const original = (db.query.__original || db.query).bind(db);
  const contagem = {};
  db.query = async (sql, params) => {
    const tag = (String(sql).match(/\/\* ([\w:-]+) \*\//) || [])[1] || "outra";
    contagem[tag] = (contagem[tag] || 0) + 1;
    return original(sql, params);
  };
  db.query.__original = original;
  return contagem;
}

cenario("GET realizado: conta explícita, período padrão até ontem, KPIs e 1 ÚNICA query de projeções", async () => {
  const db = makeMarginSnapshotFakeDb();
  const contagem = contadorDeQueries(db);
  const { deps, chamadas } = depsRealizado(db);
  const r = await read.obterRealizado({ clienteSlug: "loja-a", clienteContaId: 5 }, deps);

  assert.strictEqual(r.habilitado, true);
  assert.strictEqual(r.conta.id, 5);
  assert.strictEqual(chamadas.carregarVendas.length, 1, "a Central de Vendas é lida uma vez");
  assert.strictEqual(chamadas.carregarVendas[0].clienteContaId, 5, "nunca outra conta");
  assert.strictEqual(chamadas.carregarVendas[0].includeLegacy, false, "2 contas ativas: legado ambíguo fora");
  assert.deepStrictEqual([r.periodo.dateFrom, r.periodo.dateTo, r.periodo.modo], ["2026-08-29", "2026-09-27", "ultimos30"]);
  assert.strictEqual(contagem["ms:projecoes"], 1, "projeções dos anúncios vendidos em UMA query");
  assert.strictEqual(r.kpis.pedidos, 4);
  assert.strictEqual(r.kpis.margem.percent, 37.27);
  assert.strictEqual(r.freshness.syncEmAndamento, false);
  assert.strictEqual(chamadas.syncAtivo, 1);
});

cenario("GET realizado: periodo=YYYY-MM chega ao carregamento; sync em andamento aparece no freshness", async () => {
  const db = makeMarginSnapshotFakeDb();
  const sync = { runId: 77, status: "running", dateFrom: "2026-09-01", dateTo: "2026-09-27" };
  const { deps, chamadas } = depsRealizado(db, { extra: { buscarSyncAtivo: async () => sync } });
  const r = await read.obterRealizado({ clienteSlug: "loja-a", clienteContaId: 5, periodo: "2026-08" }, deps);
  assert.deepStrictEqual([chamadas.carregarVendas[0].dateFrom, chamadas.carregarVendas[0].dateTo], ["2026-08-01", "2026-08-31"]);
  assert.strictEqual(r.periodo.modo, "mes");
  assert.strictEqual(r.freshness.syncEmAndamento, true);
  assert.deepStrictEqual(r.freshness.syncAtivo, sync);
});

cenario("GET realizado: falha ao consultar sync ativo não derruba a leitura", async () => {
  const db = makeMarginSnapshotFakeDb();
  const { deps } = depsRealizado(db, { extra: { buscarSyncAtivo: async () => { throw new Error("db fora"); } } });
  const r = await read.obterRealizado({ clienteSlug: "loja-a", clienteContaId: 5 }, deps);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.freshness.syncEmAndamento, false);
});

cenario("GET realizado: conta de outro cliente → 403; sem conta → 400; flag desligada → modo legado", async () => {
  const db = makeMarginSnapshotFakeDb();
  const { deps } = depsRealizado(db);
  await assert.rejects(() => read.obterRealizado({ clienteSlug: "loja-a", clienteContaId: 7 }, deps), (err) => err.statusCode === 403);
  await assert.rejects(() => read.obterRealizado({ clienteSlug: "loja-a" }, deps), (err) => err.statusCode === 400);
  const desligado = await read.obterRealizado({ clienteSlug: "loja-a", clienteContaId: 5 }, { ...deps, env: {} });
  assert.deepStrictEqual(desligado, { ok: true, habilitado: false, modo: "legacy" });
});

cenario("GET itens: período e cobertura por competência voltam junto da página", async () => {
  const db = makeMarginSnapshotFakeDb();
  const comp = [{ competencia: "2026-09", segmento: { dateFrom: "2026-09-01", dateTo: "2026-09-28" }, selecionado: null,
    publicadoMaisRecente: { id: 11, publicationStatus: "published", coverageFrom: "2026-09-01", coverageTo: "2026-09-27", publishedAt: "2026-09-28T06:10:00.000Z", createdAt: null } }];
  const { deps } = depsRealizado(db, { competencias: comp });
  // Conta sem snapshot: responde `missing` antes de ler vendas; com snapshot
  // (1 run completo vazio) lê o período.
  const runRepository = require("../services/motorMargem/marginSnapshotRunRepository");
  const runService = require("../services/motorMargem/marginSnapshotRunService");
  const { run } = await runService.enqueueMarginSnapshotRun({ clienteId: 1, clienteSlug: "loja-a", clienteContaId: 5, reason: "manual_refresh", db });
  await runRepository.updateRunStatus({ runId: run.id, status: "running", db });
  await runRepository.updateRunStatus({ runId: run.id, status: "completed", db });
  const r = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5, dateFrom: "2026-09-01", dateTo: "2026-09-28" }, deps);
  assert.strictEqual(r.estado, "ready");
  assert.strictEqual(r.periodo.modo, "personalizado");
  assert.strictEqual(r.vendas.cobertura.estado, "PARCIAL");
  assert.strictEqual(r.vendas.cobertura.sincronizadoAte, "2026-09-27");
  assert.strictEqual(r.vendas.cobertura.lacunas[0].motivo, "COBERTURA_INSUFICIENTE");
  assert.strictEqual(r.vendas.cobertura.competencias, undefined, "diagnóstico detalhado só no /realizado");
});

cenario("mapProjectionsForItems: lote vazio não consulta; lote com ids usa item_id = ANY", async () => {
  const chamadas = [];
  const db = { query: async (sql, params) => { chamadas.push({ sql, params }); return { rows: [{ item_id: "MLB1", price: "100", profit: "10", margin: "0.1", margin_percent: "10", status: "HEALTHY" }] }; } };
  const vazio = await snapshotRepository.mapProjectionsForItems({ clienteId: 1, clienteContaId: 5, itemIds: [], db });
  assert.strictEqual(vazio.size, 0);
  assert.strictEqual(chamadas.length, 0);
  const mapa = await snapshotRepository.mapProjectionsForItems({ clienteId: 1, clienteContaId: 5, itemIds: ["MLB1", "MLB1", "MLB2"], db });
  assert.strictEqual(chamadas.length, 1);
  assert.ok(chamadas[0].sql.includes("item_id = ANY($4::text[])"));
  assert.ok(chamadas[0].sql.includes("cliente_conta_id = $2"), "sempre escopado pela conta");
  assert.deepStrictEqual(chamadas[0].params[3], ["MLB1", "MLB2"], "ids deduplicados");
  assert.strictEqual(mapa.get("MLB1").price, 100);
});

cenario("página do snapshot: nº de queries e de leituras de vendas NÃO cresce com o tamanho da página (sem N+1)", async () => {
  const db = makeMarginSnapshotFakeDb();
  const runRepository = require("../services/motorMargem/marginSnapshotRunRepository");
  const runService = require("../services/motorMargem/marginSnapshotRunService");
  const { run } = await runService.enqueueMarginSnapshotRun({ clienteId: 1, clienteSlug: "loja-a", clienteContaId: 5, reason: "manual_refresh", db });
  await runRepository.updateRunStatus({ runId: run.id, status: "running", db });
  for (let i = 0; i < 120; i += 1) {
    await snapshotRepository.upsertProjectionSnapshot({
      clienteId: 1, clienteContaId: 5, marketplace: "meli", itemId: `MLB${1000 + i}`, sku: `S${i}`, titulo: `Produto ${i}`,
      price: 100, cost: 40, taxRate: 0.06, fixedFee: 0, commission: 14, freight: 20, profit: 20, margin: 0.2, marginPercent: 20,
      status: "HEALTHY", confidenceLevel: "HIGH", quality: { evidencias: {} }, missing: [], assumed: [], divergences: [], runId: run.id,
    }, db);
  }
  await runRepository.updateRunStatus({ runId: run.id, status: "completed", db });

  // Vendas para os 120 anúncios (1 pedido cada).
  const pedidos = [];
  const itens = [];
  for (let i = 0; i < 120; i += 1) {
    pedidos.push({ id: 900 + i, status: "paid", data_pedido: "2026-09-10" });
    itens.push({ id: 7000 + i, pedido_row_id: 900 + i, mlb: `MLB${1000 + i}`, quantidade: 1, valor_unitario: 100, receita_produto: 100, custo_produto: 40, imposto_interno: 6, resultado: 20 });
  }
  async function medir(limit) {
    const contagem = contadorDeQueries(db);
    const { deps, chamadas } = depsRealizado(db, { vendas: { pedidos, itens, componentes: [] } });
    const r = await read.listarItens({ clienteSlug: "loja-a", clienteContaId: 5, limit }, deps);
    db.query = db.query.__original || db.query;
    return { r, total: Object.values(contagem).reduce((a, b) => a + b, 0), vendas: chamadas.carregarVendas.length };
  }
  const pequeno = await medir(10);
  const grande = await medir(100);
  assert.strictEqual(pequeno.r.itens.length, 10);
  assert.strictEqual(grande.r.itens.length, 100);
  assert.ok(grande.r.itens.every((item) => item.projectedVsRealized.status === "COMPARABLE"), "todas as linhas com realizado composto");
  assert.strictEqual(pequeno.vendas, 1);
  assert.strictEqual(grande.vendas, 1, "a Central de Vendas é lida UMA vez por página, nunca por linha");
  assert.strictEqual(grande.total, pequeno.total, `queries por página constantes (${pequeno.total} × ${grande.total})`);
});

cenario("allowlist: MARGIN_SNAPSHOT_READ_CLIENTES libera /realizado só para os clientes listados", async () => {
  const db = makeMarginSnapshotFakeDb();
  const { deps } = depsRealizado(db);
  const env = { MARGIN_SNAPSHOT_READ_CLIENTES: "loja-a" };
  const liberado = await read.obterRealizado({ clienteSlug: "loja-a", clienteContaId: 5 }, { ...deps, env });
  assert.strictEqual(liberado.habilitado, true);
  const bloqueado = await read.obterRealizado({ clienteSlug: "loja-b", clienteContaId: 7 }, { ...deps, env });
  assert.deepStrictEqual(bloqueado, { ok: true, habilitado: false, modo: "legacy" });
});

cenario("leitura do realizado é ENXUTA: sem payload_json/SELECT *, só os 3 tipos de componente usados", async () => {
  const chamadas = [];
  const db = {
    async query(sql, params) {
      chamadas.push({ sql, params });
      if (sql.includes("FROM central_vendas_imports")) {
        return { rows: [{ id: 11, competencia: "2026-09", publication_status: "published", coverage_date_from: "2026-09-01", coverage_date_to: "2026-09-27", published_at: "2026-09-28T06:00:00Z" }] };
      }
      if (sql.includes("FROM central_vendas_pedidos")) return { rows: [{ id: 1, pedido_id: "P1", data_pedido: "2026-09-10", status: "paid" }] };
      return { rows: [] };
    },
  };
  const vendas = await cv.carregarVendasDoPeriodo({ clienteSlug: "loja-a", dateFrom: "2026-09-01", dateTo: "2026-09-27", clienteContaId: 5 }, db);
  assert.strictEqual(vendas.sincronizado, true);
  assert.strictEqual(vendas.competencias.length, 1);
  // to_regclass = checagem de catálogo (cacheada) da tabela de vínculos do
  // reuso de pedidos — não é leitura de dados.
  const leitura = chamadas.filter((c) => !c.sql.includes("FROM central_vendas_imports") && !c.sql.includes("to_regclass"));
  assert.strictEqual(leitura.length, 3, "pedidos + itens + componentes");
  for (const c of leitura) {
    assert.ok(!/SELECT \*/.test(c.sql), "nunca SELECT * na leitura do realizado");
    assert.ok(!c.sql.includes("payload_json"), "payload_json nunca é transferido");
  }
  const comp = leitura.find((c) => c.sql.includes("FROM central_vendas_componentes"));
  assert.deepStrictEqual(comp.params[1], ["tarifa_venda", "frete_seller", "cancelamento_reembolso"]);
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
    console.log(`marginRealizadoPeriodoKpis: ${falhas} de ${casos.length} cenários falharam`);
    process.exit(1);
  }
  console.log(`marginRealizadoPeriodoKpis: ok (${casos.length} cenários)`);
})();
