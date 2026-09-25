// server/tests/centralVendasNoturno.test.js
//
// Orquestrador da sincronização noturna da Central de Vendas
// (centralVendasNoturnoService): períodos (dia 1, dias 2–5, dia normal, virada
// de ano, data inválida), backfill, contas elegíveis, concorrência limitada,
// falha isolada por conta, run reaproveitado/observado, snapshot só depois de
// run publicado, resumo final, exit code e ausência de segredos em log.
//
// Todas as dependências (criarSyncRun, executarSyncRun, db, adaptador, relógio,
// sleep, logger) são injetadas. NENHUM banco real: DATABASE_URL aponta para uma
// porta morta ANTES de qualquer require, então uma query acidental falharia
// em vez de alcançar um banco de verdade.

process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/teste-sem-banco";

const assert = require("assert");
const svc = require("../services/centralVendas/centralVendasNoturnoService");

let checks = 0;
// Uma promise pendurada esvazia o event loop e o Node sai com 0 sem terminar
// o teste — aqui isso vira falha.
let concluido = false;
process.on("exit", () => {
  if (!concluido) {
    console.error(`centralVendasNoturno.test.js: NÃO concluiu (parou após ${checks} verificações)`);
    process.exitCode = 1;
  }
});
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `FALHOU: ${label} — recebido ${JSON.stringify(actual)}`);
  checks += 1;
}
function lanca(label, fn) {
  let lancou = false;
  try { fn(); } catch (_) { lancou = true; }
  ok(label, lancou);
}

const faixas = (periodos) => periodos.map((p) => `${p.competencia}:${p.dateFrom}..${p.dateTo}`);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function contaRow({ contaId, clienteId, slug, marketplace = "meli", ext = `ML${contaId}`, contaAtiva = true, clienteAtivo = true }) {
  return {
    cliente_conta_id: contaId,
    cliente_id: clienteId,
    marketplace,
    external_account_id: ext,
    conta_ativa: contaAtiva,
    conta_nome: `Conta ${contaId}`,
    cliente_slug: slug,
    cliente_nome: slug.toUpperCase(),
    cliente_ativo: clienteAtivo,
  };
}

const SEGREDO_TOKEN = "APP_USR-9988776655-segredo";
const SEGREDO_REFRESH = "TG-refresh-segredo-123";

// `comportamento[contaId]`:
//   erroCriar   → criarSyncRun lança (ex.: grant revogado)
//   erroExec    → executarSyncRun lança (run vira failed)
//   completude  → completenessStatus final (padrão "complete")
//   naoPublica  → run completed sem import publicado (orders incompleto)
//   reaproveitado: "running" | "queued-outro" → run equivalente de outro processo
//   observarPolls → nº de polls até o run de outro processo terminar
//   nuncaTermina → run de outro processo nunca sai de running (timeout)
function makeDeps({ rows, comportamento = {}, execDelayMs = 5, adaptador = null } = {}) {
  const logs = [];
  const logger = {
    log: (...a) => logs.push(a.join(" ")),
    warn: (...a) => logs.push(a.join(" ")),
    error: (...a) => logs.push(a.join(" ")),
  };
  let clock = 1_000_000;
  let nextRunId = 100;
  const runs = new Map();
  const chamadas = { criar: [], executar: [], obter: 0, ads: [], snapshot: [], sleeps: 0 };
  let emVoo = 0;
  let maxEmVoo = 0;
  let criadosAoPrimeiroExec = null;

  const deps = {
    db: {
      async query(sql, params) {
        if (sql.includes("FROM central_vendas_imports") && sql.includes("sync_run_id = $1")) {
          const run = runs.get(params[0]);
          return { rows: run && run.publicado ? [{ id: run.id * 10, competencia: run.competencia }] : [] };
        }
        throw new Error(`SQL inesperado no teste: ${sql.slice(0, 80)}`);
      },
    },
    async listarContas() { return rows; },
    async criarSyncRun(p) {
      chamadas.criar.push(p);
      const c = comportamento[p.clienteContaId] || {};
      if (c.erroCriar) {
        const err = new Error(`Grant revogado. Authorization: Bearer ${SEGREDO_TOKEN} refresh_token=${SEGREDO_REFRESH}`);
        err.code = "ML_GRANT_REVOKED";
        err.statusCode = 422;
        throw err;
      }
      const id = nextRunId++;
      const run = {
        id,
        status: c.reaproveitado === "running" ? "running" : "queued",
        clienteSlug: p.clienteSlug,
        competencia: p.dateFrom.slice(0, 7),
        completenessStatus: null,
        publicado: false,
        polls: 0,
        comportamento: c,
      };
      runs.set(id, run);
      return {
        run: { id, status: run.status },
        // O contexto real carrega o grant — nunca pode aparecer em log.
        context: { grant: { access_token: SEGREDO_TOKEN, refresh_token: SEGREDO_REFRESH }, conta: { id: p.clienteContaId } },
        reaproveitado: !!c.reaproveitado,
      };
    },
    async executarSyncRun({ run }) {
      if (criadosAoPrimeiroExec === null) criadosAoPrimeiroExec = chamadas.criar.length;
      chamadas.executar.push(run.id);
      const r = runs.get(run.id);
      const c = r.comportamento;
      if (c.reaproveitado === "queued-outro") {
        // Outro processo reivindicou o run antes (marcarRunRunning → null).
        r.status = "running";
        return null;
      }
      emVoo += 1;
      maxEmVoo = Math.max(maxEmVoo, emVoo);
      try {
        await new Promise((resolve) => setTimeout(resolve, execDelayMs));
        if (c.erroExec) {
          r.status = "failed";
          r.error = { code: "ORDERS_HTTP_ERROR", message: `Falhou com access_token=${SEGREDO_TOKEN}` };
          const err = new Error(`Nao foi possivel carregar os pedidos (Bearer ${SEGREDO_TOKEN})`);
          err.code = "ORDERS_HTTP_ERROR";
          throw err;
        }
        r.status = "completed";
        r.completenessStatus = c.completude || "complete";
        r.publicado = !c.naoPublica;
        return { ok: true };
      } finally {
        emVoo -= 1;
      }
    },
    async obterSyncRun({ runId }) {
      chamadas.obter += 1;
      const r = runs.get(runId);
      const c = r.comportamento;
      if (r.status === "running" && c.reaproveitado && !c.nuncaTermina) {
        r.polls += 1;
        if (r.polls > (c.observarPolls ?? 1)) {
          r.status = "completed";
          r.completenessStatus = c.completude || "complete";
          r.publicado = !c.naoPublica;
        }
      }
      return { id: r.id, status: r.status, completenessStatus: r.completenessStatus, error: r.error || null };
    },
    async sincronizarAdsCliente(p) {
      chamadas.ads.push(p);
      return { atualizado: true, contas: p.contas.length, investimentoAds: 10, gmvAds: 50 };
    },
    async reconstruirSnapshotMensal(p) {
      chamadas.snapshot.push(p);
      if (adaptador) return adaptador(p);
      return { atualizado: true, motivo: null, sincronizadoEm: new Date(clock).toISOString() };
    },
    sleep: async (ms) => { chamadas.sleeps += 1; clock += ms; },
    agora: () => clock,
    observarIntervaloMs: 1000,
    observarTimeoutMs: 5000,
    logger,
  };
  return {
    deps, logs, chamadas, runs,
    maxEmVoo: () => maxEmVoo,
    criadosAoPrimeiroExec: () => criadosAoPrimeiroExec,
    avancar: (ms) => { clock += ms; },
  };
}

const PERIODO_SET = [{ competencia: "2026-09", dateFrom: "2026-09-01", dateTo: "2026-09-23" }];

async function run() {
  // =========================================================================
  // 1. Períodos noturnos
  // =========================================================================
  eq("período: dia 1 → só o mês anterior completo",
    faixas(svc.calcularPeriodosNoturnos("2026-10-01")), ["2026-09:2026-09-01..2026-09-30"]);
  eq("período: dia 2 → anterior completo + corrente até ontem",
    faixas(svc.calcularPeriodosNoturnos("2026-10-02")), ["2026-09:2026-09-01..2026-09-30", "2026-10:2026-10-01..2026-10-01"]);
  eq("período: dia 5 → ainda reprocessa o mês anterior",
    faixas(svc.calcularPeriodosNoturnos("2026-10-05")), ["2026-09:2026-09-01..2026-09-30", "2026-10:2026-10-01..2026-10-04"]);
  eq("período: dia 6 → só corrente até ontem",
    faixas(svc.calcularPeriodosNoturnos("2026-10-06")), ["2026-10:2026-10-01..2026-10-05"]);
  eq("período: dia normal (24/09)",
    faixas(svc.calcularPeriodosNoturnos("2026-09-24")), ["2026-09:2026-09-01..2026-09-23"]);
  eq("período: último dia do mês (31/10)",
    faixas(svc.calcularPeriodosNoturnos("2026-10-31")), ["2026-10:2026-10-01..2026-10-30"]);
  eq("período: virada de ano, 01/01 → dezembro anterior completo",
    faixas(svc.calcularPeriodosNoturnos("2027-01-01")), ["2026-12:2026-12-01..2026-12-31"]);
  eq("período: virada de ano, 03/01 → dezembro completo + janeiro até ontem",
    faixas(svc.calcularPeriodosNoturnos("2027-01-03")), ["2026-12:2026-12-01..2026-12-31", "2027-01:2027-01-01..2027-01-02"]);
  eq("período: 01/03 de ano bissexto → fevereiro até 29",
    faixas(svc.calcularPeriodosNoturnos("2028-03-01")), ["2028-02:2028-02-01..2028-02-29"]);
  eq("período: 01/03 de ano comum → fevereiro até 28",
    faixas(svc.calcularPeriodosNoturnos("2026-03-01")), ["2026-02:2026-02-01..2026-02-28"]);
  eq("DIAS_REPROCESSO_MES_ANTERIOR = 5", svc.DIAS_REPROCESSO_MES_ANTERIOR, 5);
  for (const invalida of ["2026-13-40", "2026-02-30", "2026-00-10", "2026-09-00", "24/09/2026", "abc", "", null, undefined]) {
    lanca(`período: data inválida ${JSON.stringify(invalida)} lança`, () => svc.calcularPeriodosNoturnos(invalida));
  }

  // hojeNoFuso: a data é a de São Paulo (UTC-3), não a do container (UTC).
  eq("fuso: 02:59Z ainda é o dia anterior em SP", svc.hojeNoFuso(new Date("2026-09-24T02:59:00Z")), "2026-09-23");
  eq("fuso: 03:00Z já é o dia em SP", svc.hojeNoFuso(new Date("2026-09-24T03:00:00Z")), "2026-09-24");
  eq("fuso: cron 06:00 UTC = 03:00 SP", svc.hojeNoFuso(new Date("2026-09-24T06:00:00Z")), "2026-09-24");
  eq("fuso: réveillon 01/01 01:00Z ainda é 31/12 em SP", svc.hojeNoFuso(new Date("2027-01-01T01:00:00Z")), "2026-12-31");

  // =========================================================================
  // 2. Backfill
  // =========================================================================
  eq("backfill: 3 meses completos, do mais antigo ao mais recente, sem o corrente",
    faixas(svc.calcularPeriodosBackfill("2026-02-10", 3)),
    ["2025-11:2025-11-01..2025-11-30", "2025-12:2025-12-01..2025-12-31", "2026-01:2026-01-01..2026-01-31"]);
  eq("backfill: 1 mês em janeiro → dezembro do ano anterior",
    faixas(svc.calcularPeriodosBackfill("2026-01-15", "1")), ["2025-12:2025-12-01..2025-12-31"]);
  eq("backfill: 12 meses é o teto", svc.calcularPeriodosBackfill("2026-09-24", 12).length, 12);
  for (const meses of [undefined, null, 0, -1, 13, "x", ""]) {
    lanca(`backfill: --meses=${JSON.stringify(meses)} recusado`, () => svc.calcularPeriodosBackfill("2026-09-24", meses));
  }
  lanca("backfill: data inválida recusada", () => svc.calcularPeriodosBackfill("2026-02-31", 2));

  // =========================================================================
  // 3. Concorrência configurada
  // =========================================================================
  eq("concorrência: ausente → padrão 3", svc.resolverConcorrencia(undefined), 3);
  eq("concorrência: '5' → 5", svc.resolverConcorrencia("5"), 5);
  eq("concorrência: '0' → padrão", svc.resolverConcorrencia("0"), 3);
  eq("concorrência: 'abc' → padrão", svc.resolverConcorrencia("abc"), 3);
  eq("concorrência: '50' → teto 10", svc.resolverConcorrencia("50"), svc.CONCORRENCIA_MAXIMA);
  eq("concorrência: padrão customizado (backfill)", svc.resolverConcorrencia(undefined, 1), 1);

  // =========================================================================
  // 4. Contas elegíveis
  // =========================================================================
  {
    const rows = [
      contaRow({ contaId: 1, clienteId: 10, slug: "alfa" }),
      contaRow({ contaId: 2, clienteId: 10, slug: "alfa" }), // 2ª conta do mesmo cliente
      contaRow({ contaId: 3, clienteId: 20, slug: "beta", clienteAtivo: false }),
      contaRow({ contaId: 4, clienteId: 30, slug: "gama", contaAtiva: false }),
      contaRow({ contaId: 5, clienteId: 40, slug: "delta", marketplace: "shopee" }),
      contaRow({ contaId: 6, clienteId: 50, slug: "eps", ext: null }),
      contaRow({ contaId: 7, clienteId: 60, slug: "zeta", ext: "   " }),
    ];
    const r = svc.classificarContas(rows);
    eq("elegíveis: total", r.total, 7);
    eq("elegíveis: 2 contas do mesmo cliente", r.elegiveis.map((c) => c.clienteContaId), [1, 2]);
    eq("elegíveis: motivos das ignoradas", r.ignoradas.map((c) => [c.clienteContaId, c.motivo]), [
      [3, "cliente_inativo"],
      [4, "conta_inativa"],
      [5, "marketplace_nao_suportado"],
      [6, "conta_sem_mercado_livre_conectado"],
      [7, "conta_sem_mercado_livre_conectado"],
    ]);
    const filtrado = svc.classificarContas(rows, { clientes: ["ALFA", "gama"] });
    eq("elegíveis: filtro --clientes (case-insensitive)", [filtrado.total, filtrado.elegiveis.length, filtrado.ignoradas.length], [3, 2, 1]);
  }

  // =========================================================================
  // 5. Rodada: múltiplas contas do mesmo cliente → um run por conta, um
  //    snapshot por cliente/competência, só depois das duas.
  // =========================================================================
  {
    const rows = [contaRow({ contaId: 1, clienteId: 10, slug: "alfa" }), contaRow({ contaId: 2, clienteId: 10, slug: "alfa" })];
    const { deps, chamadas } = makeDeps({ rows });
    const resumo = await svc.executarRodada({ periodos: PERIODO_SET, concorrencia: 3 }, deps);
    eq("multi-conta: 2 criarSyncRun", chamadas.criar.length, 2);
    eq("multi-conta: contas distintas", chamadas.criar.map((c) => c.clienteContaId).sort(), [1, 2]);
    ok("multi-conta: sempre marketplace meli + período do run", chamadas.criar.every((c) => c.marketplace === "meli" && c.dateFrom === "2026-09-01" && c.dateTo === "2026-09-23"));
    ok("multi-conta: requestedBy null (cron não é usuário)", chamadas.criar.every((c) => c.requestedBy === null));
    eq("multi-conta: 2 executarSyncRun (um por run)", chamadas.executar.length, 2);
    eq("multi-conta: 1 snapshot para o cliente", chamadas.snapshot.length, 1);
    eq("multi-conta: snapshot recebe as 2 contas", chamadas.snapshot[0].contas.map((c) => c.clienteContaId), [1, 2]);
    eq("multi-conta: snapshot com competência e segmento do período", [chamadas.snapshot[0].competencia, chamadas.snapshot[0].segmento],
      ["2026-09", { dateFrom: "2026-09-01", dateTo: "2026-09-23" }]);
    eq("multi-conta: resumo", [resumo.total, resumo.elegiveis, resumo.execucoes, resumo.sucesso], [2, 2, 2, 2]);
    eq("multi-conta: snapshots atualizados", resumo.snapshots.atualizados, 1);
  }

  // Dias 2–5: dois períodos → duas unidades por conta, dois snapshots.
  {
    const rows = [contaRow({ contaId: 1, clienteId: 10, slug: "alfa" })];
    const { deps, chamadas } = makeDeps({ rows });
    const resumo = await svc.executarRodada({ periodos: svc.calcularPeriodosNoturnos("2026-10-03"), concorrencia: 2 }, deps);
    eq("dias 2–5: 2 execuções para 1 conta", resumo.execucoes, 2);
    eq("dias 2–5: snapshots de setembro e outubro", chamadas.snapshot.map((s) => s.competencia).sort(), ["2026-09", "2026-10"]);
  }

  // =========================================================================
  // 6. Concorrência máxima respeitada
  // =========================================================================
  for (const limite of [1, 3]) {
    const rows = Array.from({ length: 10 }, (_, i) => contaRow({ contaId: i + 1, clienteId: i + 1, slug: `c${i + 1}` }));
    const { deps, chamadas, maxEmVoo, criadosAoPrimeiroExec } = makeDeps({ rows, execDelayMs: 15, comportamento: limite === 3 ? { 4: { erroExec: true } } : {} });
    await svc.executarRodada({ periodos: PERIODO_SET, concorrencia: limite }, deps);
    eq(`concorrência ${limite}: todas as 10 contas processadas apesar de falha isolada`, chamadas.executar.length, 10);
    eq(`concorrência ${limite}: no máximo ${limite} em voo`, maxEmVoo(), limite);
    eq(`concorrência ${limite}: 10 runs persistidos antes da primeira ingestão`, criadosAoPrimeiroExec(), 10);
  }
  {
    // Pool genérico: rejeição de uma tarefa não interrompe as outras.
    let emVoo = 0;
    let max = 0;
    const resultados = await svc.executarComConcorrencia(Array.from({ length: 20 }, (_, i) => i), 4, async (i) => {
      emVoo += 1; max = Math.max(max, emVoo);
      await new Promise((r) => setTimeout(r, 2));
      emVoo -= 1;
      if (i % 5 === 0) throw new Error(`falha ${i}`);
      return i * 2;
    });
    eq("pool: nunca passa do limite", max, 4);
    eq("pool: 20 resultados", resultados.length, 20);
    eq("pool: 4 rejeições isoladas", resultados.filter((r) => !r.ok).length, 4);
    eq("pool: resultado na posição certa", resultados[3], { ok: true, valor: 6 });
    eq("pool: lista vazia", await svc.executarComConcorrencia([], 3, async () => 1), []);
  }

  // =========================================================================
  // 7. Falha isolada: A ok, B ok, C erro, D ok
  // =========================================================================
  {
    const rows = ["a", "b", "c", "d"].map((s, i) => contaRow({ contaId: i + 1, clienteId: i + 1, slug: s }));
    const { deps, chamadas, logs } = makeDeps({ rows, comportamento: { 3: { erroCriar: true } } });
    const resumo = await svc.executarRodada({ periodos: PERIODO_SET, concorrencia: 2 }, deps);
    eq("isolamento: resumo", { sucesso: resumo.sucesso, falha: resumo.falha, parcial: resumo.parcial }, { sucesso: 3, parcial: 0, falha: 1 });
    ok("isolamento: conta D processada depois da falha de C", chamadas.criar.some((c) => c.clienteContaId === 4));
    eq("isolamento: falha listada com code", resumo.falhas.map((f) => [f.cliente, f.contaId, f.erro.code]), [["c", 3, "ML_GRANT_REVOKED"]]);
    eq("isolamento: exit code 0 com falha individual", svc.exitCodeDoResumo(resumo), 0);
    eq("isolamento: snapshot só para quem publicou", chamadas.snapshot.map((s) => s.cliente.slug).sort(), ["a", "b", "d"]);
    ok("isolamento: log de erro da conta C", logs.some((l) => l.includes("conta c#3") && l.includes("erro: ML_GRANT_REVOKED")));
  }

  // Erro durante a execução (run failed) → falha, snapshot NÃO reconstruído.
  {
    const rows = [contaRow({ contaId: 1, clienteId: 10, slug: "alfa" }), contaRow({ contaId: 2, clienteId: 20, slug: "beta" })];
    const { deps, chamadas, logs } = makeDeps({ rows, comportamento: { 1: { erroExec: true } } });
    const resumo = await svc.executarRodada({ periodos: PERIODO_SET, concorrencia: 2 }, deps);
    eq("run failed: 1 falha / 1 sucesso", [resumo.falha, resumo.sucesso], [1, 1]);
    eq("run failed: snapshot só do cliente beta", chamadas.snapshot.map((s) => s.cliente.slug), ["beta"]);
    eq("run failed: snapshot alfa não atualizado por falta de publicação", resumo.snapshots.porMotivo, { NENHUM_RUN_PUBLICADO_NESTA_RODADA: 1 });
    ok("run failed: log 'não atualizado'", logs.some((l) => l.includes("snapshot alfa 2026-09 não atualizado")));
  }

  // Todas falham → problema sistêmico → exit code 1.
  {
    const rows = [contaRow({ contaId: 1, clienteId: 10, slug: "alfa" }), contaRow({ contaId: 2, clienteId: 20, slug: "beta" })];
    const { deps } = makeDeps({ rows, comportamento: { 1: { erroCriar: true }, 2: { erroExec: true } } });
    const resumo = await svc.executarRodada({ periodos: PERIODO_SET, concorrencia: 2 }, deps);
    eq("todas falham: exit code 1", svc.exitCodeDoResumo(resumo), 1);
  }
  eq("exit: nenhuma conta elegível → 0", svc.exitCodeDoResumo({ execucoes: 0, falha: 0 }), 0);
  eq("exit: parcial não é falha", svc.exitCodeDoResumo({ execucoes: 2, falha: 0, parcial: 2 }), 0);
  eq("exit: dry-run → 0", svc.exitCodeDoResumo({ dryRun: true, execucoes: 3, falha: 3 }), 0);

  // =========================================================================
  // 8. Parcial
  // =========================================================================
  {
    const rows = [contaRow({ contaId: 1, clienteId: 10, slug: "alfa" }), contaRow({ contaId: 2, clienteId: 20, slug: "beta" })];
    const { deps, chamadas } = makeDeps({ rows, comportamento: { 1: { completude: "partial" }, 2: { naoPublica: true, completude: "partial" } } });
    const resumo = await svc.executarRodada({ periodos: PERIODO_SET, concorrencia: 1 }, deps);
    eq("parcial: 2 parciais", resumo.parcial, 2);
    eq("parcial: publicado com completude parcial ainda reconstrói snapshot", chamadas.snapshot.map((s) => s.cliente.slug), ["alfa"]);
  }

  // =========================================================================
  // 9. Run reaproveitado / idempotência com o sync manual
  // =========================================================================
  {
    // (a) reaproveitado ainda queued mas reivindicado por outro processo
    //     (executarSyncRun → null) → cron só observa até o fim.
    // (b) reaproveitado já running em outro processo → cron NEM chama
    //     executarSyncRun, só observa.
    const rows = [contaRow({ contaId: 1, clienteId: 10, slug: "alfa" }), contaRow({ contaId: 2, clienteId: 20, slug: "beta" })];
    const { deps, chamadas, logs } = makeDeps({
      rows,
      comportamento: {
        1: { reaproveitado: "queued-outro", observarPolls: 2 },
        2: { reaproveitado: "running", observarPolls: 1 },
      },
    });
    const resumo = await svc.executarRodada({ periodos: PERIODO_SET, concorrencia: 2 }, deps);
    eq("reaproveitado: executarSyncRun só tentado no run queued", chamadas.executar.length, 1);
    eq("reaproveitado: nenhuma segunda ingestão — 2 sucessos observados", resumo.sucesso, 2);
    ok("reaproveitado: esperou com sleep entre polls", chamadas.sleeps >= 1);
    ok("reaproveitado: log marca o run como reaproveitado", logs.filter((l) => l.includes("(reaproveitado)")).length === 2);
    eq("reaproveitado: snapshots dos dois clientes", chamadas.snapshot.length, 2);
  }
  {
    // Run de outro processo não termina dentro do teto → ignorado (não é
    // falha nossa, e não conta como sucesso nem reconstrói snapshot).
    const rows = [contaRow({ contaId: 1, clienteId: 10, slug: "alfa" })];
    const { deps, chamadas } = makeDeps({ rows, comportamento: { 1: { reaproveitado: "running", nuncaTermina: true } } });
    const resumo = await svc.executarRodada({ periodos: PERIODO_SET, concorrencia: 1 }, deps);
    eq("observação: timeout → ignorado", [resumo.ignorados, resumo.sucesso, resumo.falha], [1, 0, 0]);
    eq("observação: motivo", resumo.ignoradosPorMotivo, { RUN_EM_ANDAMENTO_EM_OUTRO_PROCESSO: 1 });
    eq("observação: sem snapshot", chamadas.snapshot.length, 0);
    ok("observação: limitada pelo timeout (5 polls de 1s)", chamadas.obter <= 7);
  }

  // =========================================================================
  // 10. Adaptador falha → rodada continua; resumo registra o motivo
  // =========================================================================
  {
    const rows = [contaRow({ contaId: 1, clienteId: 10, slug: "alfa" })];
    const { deps, chamadas, logs } = makeDeps({ rows });
    deps.sincronizarAdsCliente = async () => {
      const err = new Error("Mercado Ads indisponivel");
      err.code = "ML_ADS_API_ERROR";
      throw err;
    };
    const resumo = await svc.executarRodada({ periodos: PERIODO_SET, concorrencia: 1 }, deps);
    eq("ads falhou: vendas continuam sucesso", [resumo.sucesso, resumo.falha], [1, 0]);
    eq("ads falhou: snapshot financeiro ainda e reconstruido", chamadas.snapshot.length, 1);
    eq("ads falhou: resumo informa ausencia de atualizacao", resumo.ads, {
      atualizados: 0,
      naoAtualizados: 1,
      porMotivo: { ADS_NAO_ATUALIZADO: 1 },
    });
    ok("ads falhou: log explicito", logs.some((l) => l.includes("ads alfa 2026-09 não atualizado") && l.includes("ML_ADS_API_ERROR")));
  }
  {
    const rows = [contaRow({ contaId: 1, clienteId: 10, slug: "alfa" }), contaRow({ contaId: 2, clienteId: 20, slug: "beta" })];
    const { deps } = makeDeps({
      rows,
      adaptador: async (p) => {
        if (p.cliente.slug === "alfa") throw new Error(`falha de banco password=${SEGREDO_REFRESH}`);
        return { atualizado: false, motivo: "CONTA_SEM_IMPORT_PUBLICADO" };
      },
    });
    const resumo = await svc.executarRodada({ periodos: PERIODO_SET, concorrencia: 1 }, deps);
    eq("adaptador: execuções continuam sucesso", resumo.sucesso, 2);
    eq("adaptador: motivos", resumo.snapshots.porMotivo, { ERRO_ADAPTADOR: 1, CONTA_SEM_IMPORT_PUBLICADO: 1 });
    eq("adaptador: nenhum snapshot contado como atualizado", resumo.snapshots.atualizados, 0);
  }

  // =========================================================================
  // 11. Resumo, duração, dry-run e erro estrutural
  // =========================================================================
  {
    const rows = [
      contaRow({ contaId: 1, clienteId: 10, slug: "alfa" }),
      contaRow({ contaId: 2, clienteId: 20, slug: "beta", contaAtiva: false }),
    ];
    const { deps, avancar } = makeDeps({ rows });
    const originalCriar = deps.criarSyncRun;
    deps.criarSyncRun = async (p) => { avancar(1234); return originalCriar(p); };
    const resumo = await svc.executarRodada({ periodos: PERIODO_SET, concorrencia: 1 }, deps);
    for (const campo of ["total", "elegiveis", "sucesso", "parcial", "falha", "ignorados", "duracaoMs"]) {
      ok(`resumo: campo ${campo}`, typeof resumo[campo] === "number");
    }
    eq("resumo: valores", [resumo.total, resumo.elegiveis, resumo.sucesso, resumo.ignorados], [2, 1, 1, 1]);
    eq("resumo: ignorados por motivo", resumo.ignoradosPorMotivo, { conta_inativa: 1 });
    eq("resumo: duração pelo relógio injetado", resumo.duracaoMs, 1234);
  }
  {
    const rows = [contaRow({ contaId: 1, clienteId: 10, slug: "alfa" }), contaRow({ contaId: 2, clienteId: 20, slug: "beta" })];
    const { deps, chamadas, logs } = makeDeps({ rows });
    const resumo = await svc.executarRodada({ periodos: svc.calcularPeriodosNoturnos("2026-10-02"), concorrencia: 3, dryRun: true }, deps);
    eq("dry-run: nenhum run criado", chamadas.criar.length, 0);
    eq("dry-run: nenhum snapshot", chamadas.snapshot.length, 0);
    eq("dry-run: unidades listadas (2 contas × 2 períodos)", resumo.execucoes, 4);
    ok("dry-run: flag no resumo", resumo.dryRun === true);
    eq("dry-run: 4 linhas de plano no log", logs.filter((l) => l.includes("[dry-run]")).length, 4);
  }
  {
    const { deps } = makeDeps({ rows: [] });
    deps.listarContas = async () => { throw new Error("connect ECONNREFUSED"); };
    let lancou = false;
    try { await svc.executarRodada({ periodos: PERIODO_SET, concorrencia: 1 }, deps); } catch (_) { lancou = true; }
    ok("estrutural: falha ao listar contas propaga (entrypoint → exit 1)", lancou);
  }

  // =========================================================================
  // 12. Logs mínimos e nenhum segredo em log
  // =========================================================================
  {
    const rows = [contaRow({ contaId: 1, clienteId: 10, slug: "alfa" }), contaRow({ contaId: 2, clienteId: 20, slug: "beta" }), contaRow({ contaId: 3, clienteId: 30, slug: "gama" })];
    const { deps, logs } = makeDeps({ rows, comportamento: { 1: { erroCriar: true }, 2: { erroExec: true } } });
    const resumo = await svc.executarRodada({ periodos: PERIODO_SET, concorrencia: 1 }, deps);
    const texto = logs.join("\n") + JSON.stringify(resumo);
    ok("logs: início", logs.some((l) => l.startsWith("[cron-central] início")));
    ok("logs: contas elegíveis", logs.some((l) => l === "[cron-central] contas elegíveis: 3"));
    ok("logs: conta iniciada", logs.some((l) => l.includes("conta gama#3 2026-09-01..2026-09-23 iniciada")));
    ok("logs: runId", logs.some((l) => /conta gama#3 .* runId=\d+/.test(l)));
    ok("logs: conta ok", logs.some((l) => /conta gama#3 .* ok run=#\d+/.test(l)));
    ok("logs: conta erro", logs.some((l) => l.includes("conta alfa#1") && l.includes("erro:")));
    ok("logs: resumo", logs.some((l) => l.startsWith("[cron-central] resumo {")));
    ok("segredos: access token nunca aparece", !texto.includes(SEGREDO_TOKEN));
    ok("segredos: refresh token nunca aparece", !texto.includes(SEGREDO_REFRESH));
    ok("segredos: nenhum 'Bearer <valor>'", !/Bearer\s+(?!\[redacted\])\S/.test(texto));
    ok("segredos: mensagens redigidas", texto.includes("[redacted]"));
  }

  // =========================================================================
  // 13. Nenhuma ingestão Orders API fora do worker
  // =========================================================================
  {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async () => { fetches += 1; throw new Error("rede proibida no teste"); };
    try {
      const rows = [contaRow({ contaId: 1, clienteId: 10, slug: "alfa" }), contaRow({ contaId: 2, clienteId: 10, slug: "alfa" })];
      const { deps, chamadas } = makeDeps({ rows });
      await svc.executarRodada({ periodos: PERIODO_SET, concorrencia: 2 }, deps);
      eq("orders: nenhum fetch HTTP do orquestrador", fetches, 0);
      eq("orders: exatamente 1 executarSyncRun por unidade", chamadas.executar.length, 2);
      eq("orders: snapshot recebe só dados de escopo (sem cliente HTTP)",
        Object.keys(chamadas.snapshot[0]).sort(), ["cliente", "competencia", "contas", "origem", "segmento"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  concluido = true;
  console.log(`centralVendasNoturno.test.js: ${checks} verificacoes OK`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
