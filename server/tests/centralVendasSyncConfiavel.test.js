// server/tests/centralVendasSyncConfiavel.test.js
//
// Sync automático confiável (branch fix/painel-contas-sync-confiavel). Sem
// banco e sem Mercado Livre reais:
//
//   A  RETURNS_UNRESOLVED de OUTRO período: devolução de shipment que não
//      pertence a nenhum pedido do período (orders completos) não é pendência
//      do mês; pack ambíguo, orders incompletos, índice vazio e resource
//      desconhecido continuam pendência
//   B  retomada no boot: só pendências recentes, só os clientes pendentes;
//      órfãos antigos fechados antes
//   C  mês anterior incompleto completado nos dias 6..15, só nas contas sem
//      cobertura completa; falha na consulta não derruba o mês corrente
//   D  scheduler: rodada que estoura o teto libera o agendamento; a rodada
//      antiga não sobrescreve o estado da nova
//   E  Painel: run parado aparece como interrompido, não "sincronizando"; o
//      modo manual (PR #227) não muda

process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/teste-sem-banco";

const assert = require("assert");

let checks = 0;
let concluido = false;
process.on("exit", () => {
  if (!concluido) {
    console.error(`centralVendasSyncConfiavel.test.js: NÃO concluiu (parou após ${checks} verificações)`);
    process.exitCode = 1;
  }
});
function ok(label, cond) {
  assert.ok(cond, `FALHOU: ${label}`);
  checks += 1;
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `FALHOU: ${label} — recebido ${JSON.stringify(actual)}`);
  checks += 1;
}
const silencioso = { log() {}, warn() {}, error() {} };
async function semLog(fn) {
  const original = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = original; }
}

// ───────────────────────────── A. returns ─────────────────────────────────
const { createCentralVendasClaimsService } = require("../services/centralVendas/centralVendasClaimsService");

function claimDevolucao(id, resource, resourceId) {
  return {
    id, resource, resource_id: resourceId, status: "closed", type: "returns", related_entities: ["return"],
    resolution: { reason: "item_returned", benefited: ["complainant"] },
  };
}

function servicoClaims(claims, { detalhe = () => ({ ok: true, status: 200, data: { status: "delivered", items: [] } }) } = {}) {
  return createCentralVendasClaimsService({
    sleepFn: async () => {},
    mlFetchFn: async (_cliente, path) => {
      if (path.startsWith("/post-purchase/v1/claims/search")) {
        return { ok: true, status: 200, data: { paging: { total: claims.length }, data: claims } };
      }
      if (path.startsWith("/post-purchase/v2/claims/")) return detalhe(path);
      return { ok: true, status: 200, data: {} };
    },
  });
}

const PEDIDOS = [
  { id: 1001, shipping: { id: 501 } },
  { id: 1002, shipping: { id: 502 } },
  { id: 1003, shipping: { id: 503 } }, // pack: 1003 e 1004 no mesmo shipment
  { id: 1004, shipping: { id: 503 } },
];

async function buscar(claims, { orders = PEDIDOS, ordersCompletos = true, detalhe } = {}) {
  return semLog(() => servicoClaims(claims, { detalhe }).buscarClaimsPorPeriodo({
    clienteId: 1, sellerId: "S", dateFrom: "2026-09-01", dateTo: "2026-09-30",
    orderIds: new Set(orders.map((o) => String(o.id))), orders, ordersCompletos,
    hoje: new Date("2026-10-06T12:00:00Z"),
  }));
}

async function blocoA() {
  // Claims NOVOS a cada cenário: o serviço anota o vínculo no próprio objeto.
  const outroMes = () => [claimDevolucao("C1", "shipment", "999")];

  let r = await buscar(outroMes());
  eq("A1: shipment fora do índice completo → fora do período, não pendência",
    [r.returnsNaoResolvidos, r.returnsForaDoPeriodo, r.returnsPendentesTotal], [0, 1, 1]);
  eq("A1: diagnóstico diz por quê", r.returnsDiagnosticos.map((d) => d.classificacao), ["fora_do_periodo"]);

  r = await buscar(outroMes(), { ordersCompletos: false });
  eq("A2: orders INCOMPLETOS → nada afirmado, continua pendência", [r.returnsNaoResolvidos, r.returnsForaDoPeriodo], [1, 0]);

  r = await buscar([claimDevolucao("C2", "shipment", "503")]);
  eq("A3: pack ambíguo (2 pedidos do período) continua pendência", [r.returnsNaoResolvidos, r.returnsForaDoPeriodo], [1, 0]);

  r = await buscar([claimDevolucao("C3", "shipment", "502")]);
  eq("A4: shipment de 1 pedido do período resolve pelo índice", [r.returnsResolvidos, r.returnsNaoResolvidos], [1, 0]);

  r = await buscar([claimDevolucao("C4", "mediation", "77")]);
  eq("A5: resource desconhecido continua pendência", [r.returnsNaoResolvidos, r.returnsForaDoPeriodo], [1, 0]);

  r = await buscar(outroMes(), { orders: [{ id: 2001 }, { id: 2002 }] });
  eq("A6: pedidos sem shipping.id (índice vazio) → nada afirmado", [r.returnsNaoResolvidos, r.returnsForaDoPeriodo], [1, 0]);

  // Regressão (revisão do PR #229): índice PARCIAL. Pedido A tem shipping.id,
  // pedido B não — o claim pode ser do B. "O índice tem algum shipment" não
  // prova completude: continua não resolvido.
  r = await buscar(outroMes(), { orders: [{ id: 3001, shipping: { id: 801 } }, { id: 3002 }] });
  eq("A11: pedido do período sem shipping.id → NÃO afirma fora do período",
    [r.returnsNaoResolvidos, r.returnsForaDoPeriodo], [1, 0]);
  eq("A11: diagnóstico fica nao_resolvido", r.returnsDiagnosticos.map((d) => d.classificacao), ["nao_resolvido"]);
  r = await buscar(outroMes(), { orders: [{ id: 3001, shipping: { id: 801 } }, { id: 3002, shipping: {} }] });
  eq("A12: shipping sem id também conta como fora do índice", [r.returnsNaoResolvidos, r.returnsForaDoPeriodo], [1, 0]);
  r = await buscar(outroMes(), { orders: [{ id: 3001, shipping: { id: 801 } }, { shipping: { id: 802 } }] });
  eq("A13: pedido sem id também impede a afirmação", [r.returnsNaoResolvidos, r.returnsForaDoPeriodo], [1, 0]);

  r = await buscar(outroMes(), { orders: [] });
  eq("A7: período sem nenhum pedido (completo) → devolução é de outro período", [r.returnsNaoResolvidos, r.returnsForaDoPeriodo], [0, 1]);

  r = await buscar(outroMes(), { detalhe: () => ({ ok: true, status: 200, data: { order_id: 1001, items: [] } }) });
  eq("A8: detalhe com order_id do período resolve (prioridade sobre 'fora do período')", [r.returnsResolvidos, r.returnsForaDoPeriodo], [1, 0]);

  r = await buscar(outroMes(), { detalhe: () => ({ ok: false, status: 403, data: {} }) });
  eq("A9: detalhe 403 com shipment alheio ao período continua fora do período", [r.returnsNaoResolvidos, r.returnsForaDoPeriodo], [0, 1]);

  r = await buscar([...outroMes(), claimDevolucao("C2", "shipment", "503")]);
  eq("A10: mistura → só o pack conta como pendência", [r.returnsNaoResolvidos, r.returnsForaDoPeriodo, r.returnsPendentesTotal], [1, 1, 2]);
}

// ───────────────────────────── B/C. noturno ────────────────────────────────
const noturno = require("../services/centralVendas/centralVendasNoturnoService");

function contasRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    cliente_conta_id: i + 1, cliente_id: i + 1, marketplace: "meli",
    external_account_id: `ML${i + 1}`, conta_ativa: true, conta_nome: `Conta ${i + 1}`,
    cliente_slug: `cliente-${i + 1}`, cliente_nome: `Cliente ${i + 1}`, cliente_ativo: true,
  }));
}

function depsRodada({ rows = contasRows(3), incompletas = new Set(), falharIncompletas = false, pendentes = [], agoraMs = Date.parse("2026-10-10T06:00:00Z") } = {}) {
  const chamadas = { criar: [], expirar: [], listarPendentes: [], incompletas: 0 };
  let id = 1;
  const runs = new Map();
  const deps = {
    db: { async query(sql) { if (sql.includes("FROM central_vendas_imports")) return { rows: [{ id: 1, competencia: "x" }] }; throw new Error(`SQL inesperado: ${sql.slice(0, 60)}`); } },
    async listarContas() { return rows; },
    async ensureCentralVendasTables() {},
    async criarSyncRun(p) {
      chamadas.criar.push(`${p.clienteContaId}:${p.dateFrom}..${p.dateTo}`);
      const run = { id: id++, status: "queued" };
      runs.set(run.id, run);
      return { run, context: {}, reaproveitado: false };
    },
    async executarSyncRun({ run }) { run.status = "completed"; run.completenessStatus = "complete"; return { ok: true }; },
    async obterSyncRun({ runId }) { return runs.get(runId); },
    async marcarRunFailed() {},
    async sincronizarAdsCliente({ contas }) { return { atualizado: true, contas: contas.length, investimentoAds: 0, gmvAds: 0 }; },
    async reconstruirSnapshotMensal() { return { atualizado: true, sincronizadoEm: new Date(agoraMs) }; },
    async expirarRunsNoturnosOrfaos(p) { chamadas.expirar.push(p); return [{ id: 99 }]; },
    async listarPeriodosNoturnosPendentes(p) { chamadas.listarPendentes.push(p); return pendentes; },
    async reconciliarRunsNoturnosInterrompidos() { return []; },
    async listarContasComMesIncompleto() {
      chamadas.incompletas += 1;
      if (falharIncompletas) throw new Error("consulta falhou");
      return incompletas;
    },
    sleep: async () => {},
    random: () => 0,
    agora: () => agoraMs,
    observarIntervaloMs: 1,
    observarTimeoutMs: 5,
    unidadeTimeoutMs: 60000,
    fechamentoTimeoutMs: 60000,
    logger: silencioso,
  };
  return { deps, chamadas };
}

async function blocoBC() {
  // Período do mês anterior a completar (função pura).
  const p = (d, ate) => noturno.periodoMesAnteriorACompletar(d, ate);
  eq("C: dia 5 → já coberto pela regra dos dias 1..5", p("2026-10-05"), null);
  eq("C: dia 6 → setembro completo", p("2026-10-06"), { competencia: "2026-09", dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  eq("C: dia 15 → ainda completa", p("2026-10-15")?.competencia, "2026-09");
  eq("C: dia 16 → fora da janela", p("2026-10-16"), null);
  eq("C: virada de ano", p("2027-01-08")?.competencia, "2026-12");
  eq("C: env 0 desliga", p("2026-10-08", noturno.resolverCompletarAteDia("0")), null);
  eq("C: env inválido → padrão 15", noturno.resolverCompletarAteDia("abc"), 15);
  eq("C: env acima de 28 é capado", noturno.resolverCompletarAteDia("40"), 28);

  // Dia 10: setembro só para a conta 2 (incompleta); outubro para todas.
  {
    const { deps, chamadas } = depsRodada({ incompletas: new Set([2]) });
    const resumo = await noturno.executarRodadaNoturna({ env: {}, dataReferencia: "2026-10-10" }, deps);
    eq("C: unidades = outubro × 3 contas + setembro só da conta 2", chamadas.criar.sort(), [
      "1:2026-10-01..2026-10-09", "2:2026-09-01..2026-09-30", "2:2026-10-01..2026-10-09", "3:2026-10-01..2026-10-09",
    ]);
    eq("C: rodada concluída", [resumo.execucoes, resumo.falha], [4, 0]);
    eq("B: órfãos antigos fechados antes da rodada (janela 24h)", chamadas.expirar.length, 1);
    eq("B: janela = agora − 24h", chamadas.expirar[0].desde, new Date(Date.parse("2026-10-10T06:00:00Z") - 24 * 3600e3).toISOString());
  }
  {
    const { deps, chamadas } = depsRodada({ incompletas: new Set() });
    await noturno.executarRodadaNoturna({ env: {}, dataReferencia: "2026-10-10" }, deps);
    eq("C: nenhuma conta incompleta → só o mês corrente", chamadas.criar.length, 3);
  }
  {
    const { deps, chamadas } = depsRodada({ falharIncompletas: true });
    const resumo = await noturno.executarRodadaNoturna({ env: {}, dataReferencia: "2026-10-10" }, deps);
    eq("C: falha na consulta não derruba o mês corrente", [chamadas.criar.length, resumo.falha], [3, 0]);
  }
  {
    const { deps, chamadas } = depsRodada({ incompletas: new Set([1, 2, 3]) });
    await noturno.executarRodadaNoturna({ env: {}, dataReferencia: "2026-10-20" }, deps);
    eq("C: depois do dia 15 nem consulta", [chamadas.incompletas, chamadas.criar.length], [0, 3]);
  }
  // Piloto por conta (CENTRAL_VENDAS_NOTURNO_CONTAS).
  {
    const { deps, chamadas } = depsRodada({ incompletas: new Set([2]) });
    await noturno.executarRodadaNoturna({ env: { CENTRAL_VENDAS_NOTURNO_CONTAS: "2, 3" }, dataReferencia: "2026-10-10" }, deps);
    eq("P: lista ⇒ só as contas do piloto (e o mês anterior só se incompleto)", chamadas.criar.sort(), [
      "2:2026-09-01..2026-09-30", "2:2026-10-01..2026-10-09", "3:2026-10-01..2026-10-09",
    ]);
  }
  for (const valor of [undefined, "", "*", "  "]) {
    const { deps, chamadas } = depsRodada({ incompletas: new Set() });
    await noturno.executarRodadaNoturna({ env: { CENTRAL_VENDAS_NOTURNO_CONTAS: valor }, dataReferencia: "2026-10-10" }, deps);
    eq(`P: ${JSON.stringify(valor)} ⇒ carteira inteira (como sempre)`, chamadas.criar.length, 3);
  }
  for (const valor of ["21;41", "abc", "1,,x"]) {
    const { deps, chamadas } = depsRodada({ incompletas: new Set() });
    let codigo = null;
    try { await noturno.executarRodadaNoturna({ env: { CENTRAL_VENDAS_NOTURNO_CONTAS: valor }, dataReferencia: "2026-10-10" }, deps); } catch (err) { codigo = err.code; }
    eq(`P: lista inválida ${JSON.stringify(valor)} ⇒ não roda nada (nunca cai para todas)`, [codigo, chamadas.criar.length], ["CONTAS_PILOTO_INVALIDAS", 0]);
  }
  {
    const { deps, chamadas } = depsRodada({ incompletas: new Set([1]) });
    await noturno.executarRodadaNoturna({ env: {}, dataReferencia: "2026-10-03" }, deps);
    eq("C: dias 2..5 seguem a regra antiga (setembro para todas, sem consultar)", [chamadas.incompletas, chamadas.criar.length], [0, 6]);
  }
  {
    const { deps, chamadas } = depsRodada({ incompletas: new Set([2]) });
    await noturno.executarRodadaNoturna({ env: {}, dataReferencia: "2026-10-10", dryRun: true }, deps);
    eq("B/C: dry-run não fecha órfãos nem cria runs", [chamadas.expirar.length, chamadas.criar.length], [0, 0]);
  }

  // Retomada no boot: só o cliente pendente, com a janela.
  {
    const { deps, chamadas } = depsRodada({
      pendentes: [{ competencia: "2026-10", dateFrom: "2026-10-01", dateTo: "2026-10-09", clientes: ["cliente-2"] }],
    });
    const inicio = new Date("2026-10-10T10:00:00Z");
    const rec = await noturno.recuperarRodadasPendentes({ env: { CENTRAL_VENDAS_NOTURNO_RECUPERACAO_HORAS: "12" }, iniciadoEm: inicio }, deps);
    eq("B: retomada só do cliente pendente (não a carteira inteira)", chamadas.criar, ["2:2026-10-01..2026-10-09"]);
    eq("B: órfãos fora da janela fechados ANTES de listar", [chamadas.expirar.length, rec.orfaosExpirados], [1, 1]);
    eq("B: listagem recebe a janela configurada (12h)", chamadas.listarPendentes[0].desde, new Date(inicio.getTime() - 12 * 3600e3).toISOString());
  }
  {
    // Regressão (revisão do PR #229): clientes POR PERÍODO, nunca o produto
    // cruzado. Setembro pendente só para A; outubro só para B.
    const { deps, chamadas } = depsRodada({
      pendentes: [
        { competencia: "2026-09", dateFrom: "2026-09-01", dateTo: "2026-09-30", clientes: ["cliente-1"] },
        { competencia: "2026-10", dateFrom: "2026-10-01", dateTo: "2026-10-09", clientes: ["cliente-2"] },
      ],
    });
    await noturno.recuperarRodadasPendentes({ env: {}, iniciadoEm: new Date("2026-10-10T10:00:00Z") }, deps);
    eq("B: setembro só × A e outubro só × B (sem setembro×B nem outubro×A)", chamadas.criar.sort(),
      ["1:2026-09-01..2026-09-30", "2:2026-10-01..2026-10-09"]);
  }
  {
    // Mesmo cliente pendente em dois períodos: os dois, e nada mais.
    const { deps, chamadas } = depsRodada({
      pendentes: [
        { competencia: "2026-09", dateFrom: "2026-09-01", dateTo: "2026-09-30", clientes: ["cliente-3"] },
        { competencia: "2026-10", dateFrom: "2026-10-01", dateTo: "2026-10-09", clientes: ["cliente-3", "cliente-1"] },
      ],
    });
    await noturno.recuperarRodadasPendentes({ env: {}, iniciadoEm: new Date("2026-10-10T10:00:00Z") }, deps);
    eq("B: cliente em dois períodos + outro só em outubro", chamadas.criar.sort(),
      ["1:2026-10-01..2026-10-09", "3:2026-09-01..2026-09-30", "3:2026-10-01..2026-10-09"]);
  }
  {
    // Sem a lista de clientes (banco antigo/mock): rodada completa, como antes.
    const { deps, chamadas } = depsRodada({ pendentes: [{ competencia: "2026-10", dateFrom: "2026-10-01", dateTo: "2026-10-09" }] });
    await noturno.recuperarRodadasPendentes({ env: {}, iniciadoEm: new Date("2026-10-10T10:00:00Z") }, deps);
    eq("B: sem clientes informados → carteira inteira (comportamento anterior)", chamadas.criar.length, 3);
  }
  {
    const { deps, chamadas } = depsRodada({ pendentes: [] });
    const rec = await noturno.recuperarRodadasPendentes({ env: {}, iniciadoEm: new Date() }, deps);
    eq("B: sem pendência recente → nada retomado", [rec.recuperada, chamadas.criar.length], [false, 0]);
  }
  {
    const { deps } = depsRodada({ pendentes: [{ competencia: "2026-10", dateFrom: "2026-10-01", dateTo: "2026-10-09", clientes: ["cliente-1"] }] });
    deps.expirarRunsNoturnosOrfaos = async () => { throw new Error("banco indisponível"); };
    const rec = await noturno.recuperarRodadasPendentes({ env: {}, iniciadoEm: new Date() }, deps);
    eq("B: falha ao fechar órfãos não impede a retomada recente", rec.recuperada, true);
  }
  eq("B: janela inválida → padrão 24h", noturno.resolverRecuperacaoHoras("x"), 24);
  eq("B: janela capada em 7 dias", noturno.resolverRecuperacaoHoras("1000"), 168);
}

// ───────────────────────────── D. scheduler ────────────────────────────────
const { createScheduler } = require("../services/centralVendas/centralVendasNoturnoScheduler");

async function blocoD() {
  const timers = [];
  let lockAtual = 0;
  const pendentes = [];
  const s = createScheduler({
    env: { CENTRAL_VENDAS_NOTURNO_ENABLED: "true", CENTRAL_VENDAS_NOTURNO_RODADA_TIMEOUT_MS: "1000" },
    agora: () => Date.parse("2026-10-10T06:00:00Z"),
    setTimeoutFn: (fn, ms) => { const t = { fn, ms, ativo: true }; timers.push(t); return t; },
    clearTimeoutFn: (t) => { if (t) t.ativo = false; },
    getPool: () => ({}),
    adquirirLockGlobal: async () => {
      if (lockAtual > 0) return { adquirido: false };
      lockAtual += 1;
      return { adquirido: true, async liberar() { lockAtual -= 1; } };
    },
    executarRodadaNoturna: () => new Promise((resolve) => pendentes.push(resolve)),
    logger: silencioso,
  });
  const primeira = s.dispararRodada();
  await new Promise((r) => setImmediate(r));
  eq("D: rodada em execução", s.estado().emExecucao, true);
  const teto = timers.find((t) => t.ms === 1000 && t.ativo);
  ok("D: teto da rodada agendado com o env", !!teto);
  teto.fn();
  const r1 = await primeira;
  eq("D: estouro do teto devolve RODADA_TIMEOUT", r1.motivo, "RODADA_TIMEOUT");
  eq("D: scheduler liberado (não fica preso)", s.estado().emExecucao, false);

  const segunda = s.dispararRodada();
  const r2 = await segunda;
  eq("D: próximo disparo não roda em paralelo — a rodada antiga ainda tem o lock", r2.motivo, "RODADA_EM_OUTRA_INSTANCIA");

  // A rodada antiga termina: solta o lock e NÃO mexe no estado de execuções novas.
  const terceira = s.dispararRodada(); // vai esperar lock → sai como outra instância
  await terceira;
  pendentes[0]({ total: 1 });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  eq("D: rodada antiga liberou o lock ao terminar", lockAtual, 0);
  const quarta = s.dispararRodada();
  await new Promise((r) => setImmediate(r));
  eq("D: depois disso uma rodada nova roda normalmente", s.estado().emExecucao, true);
  pendentes[1]({ total: 1 });
  const r4 = await quarta;
  eq("D: rodada nova conclui", r4.executada, true);
  eq("D: estado limpo no fim", s.estado().emExecucao, false);
}

// ───────────────────────────── E. Painel ───────────────────────────────────
const { resolverContas } = require("../services/painelContas/painelContasOperacional");

function blocoE() {
  const conta = { id: 7, cliente_id: 1, marketplace: "meli", nome: "X", external_account_id: "ML7", ativo: true };
  const comRun = (run, extra = {}) => resolverContas([conta], { runPorConta: new Map([[7, run]]), ...extra })[0];

  const travado = comRun({ id: 1, status: "running", travado: true, created_at: "2026-10-03T03:00:00Z" });
  eq("E: run parado → 'Erro de sync' com causa, não 'Sincronizando'", [travado.status.codigo, travado.status.erroCodigo], ["erro_sync", "SYNC_RUN_TRAVADO"]);
  ok("E: conta travada pede ação", travado.precisaAcao === true);
  eq("E: run em curso continua 'Sincronizando'", comRun({ id: 2, status: "queued", travado: false, created_at: "2026-10-10T03:00:00Z" }).status.codigo, "sincronizando");

  const imp = { id: 50, faturamento: 100, lucro_contribuicao: 10, faturamento_com_custo: 100, margem_contribuicao_percentual: 10, publication_status: "published", published_at: "2026-10-01T06:00:00Z", coverage_date_to: "2026-09-30", completeness_status: "complete" };
  const comImport = resolverContas([conta], {
    importPorConta: new Map([[7, imp]]),
    runPorConta: new Map([[7, { id: 3, status: "queued", travado: true, created_at: "2026-10-03T03:00:00Z" }]]),
  })[0];
  ok("E: com publicação anterior, avisa que a última sync parou", comImport.avisos.some((a) => /parada/.test(a)) && comImport.resumo.fat === 100);

  // Modo manual (PR #227) intocado: manual prevalece mesmo com run travado.
  const manual = { id: 9, cliente_conta_id: 7, competencia: "2026-10", faturamento: 555, lucro_contribuicao: null, margem_contribuicao: null, investimento_ads: null, gmv_ads: null, created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" };
  const mm = resolverContas([conta], {
    importPorConta: new Map([[7, imp]]), manualPorConta: new Map([[7, manual]]),
    runPorConta: new Map([[7, { id: 3, status: "queued", travado: true, created_at: "2026-10-03T03:00:00Z" }]]),
    manualPrevalece: true,
  })[0];
  eq("E: modo manual inalterado — manual prevalece", [mm.fonte.tipo, mm.resumo.fat, mm.status.codigo], ["manual", 555, "manual"]);
}

(async () => {
  await blocoA();
  await blocoBC();
  await blocoD();
  blocoE();
  concluido = true;
  console.log(`centralVendasSyncConfiavel.test.js: ${checks} verificações OK`);
})().catch((err) => { console.error(err); process.exit(1); });
