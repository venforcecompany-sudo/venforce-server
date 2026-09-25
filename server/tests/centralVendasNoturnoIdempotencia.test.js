// server/tests/centralVendasNoturnoIdempotencia.test.js
//
// Manual × cron concorrentes na MESMA conta/período: com o criarSyncRun REAL
// (dedupe + índice único parcial) e o marcarRunRunning REAL (reivindicação
// atômica queued → running), duas chamadas simultâneas nunca produzem duas
// ingestões independentes — o cron reaproveita/observa o run do manual (ou
// vice-versa).
//
// Fake db mínimo em memória: responde só às queries de criarSyncRun
// (clientes, cliente_contas, ml_tokens, vínculos de base, stale, dedupe,
// INSERT com conflito 23505), das transições de estado e de obterSyncRun.
// Cada query cede o event loop (setImmediate) para as corridas acontecerem de
// verdade. NENHUM banco real: DATABASE_URL aponta para porta morta.

process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/teste-sem-banco";

const assert = require("assert");
const runService = require("../services/centralVendas/centralVendasSyncRunService");
const svc = require("../services/centralVendas/centralVendasNoturnoService");

let checks = 0;
// Uma promise pendurada esvazia o event loop e o Node sai com 0 sem terminar
// o teste — aqui isso vira falha.
let concluido = false;
process.on("exit", () => {
  if (!concluido) {
    console.error(`centralVendasNoturnoIdempotencia.test.js: NÃO concluiu (parou após ${checks} verificações)`);
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

const cliente = { id: 1, nome: "Cliente A", slug: "cliente-a", ativo: true };
const conta = {
  id: 11, cliente_id: 1, marketplace: "meli", nome: "Conta A", slug: "cliente-a-meli",
  external_account_id: "5001", is_primary: true, ativo: true, metadata_json: {},
};
const grant = {
  id: 91, cliente_id: 1, ml_user_id: "5001", cliente_conta_id: 11,
  access_token: "tok-segredo", refresh_token: "ref-segredo",
  expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  token_status: "valid", is_primary: true, refresh_failures: 0, updated_at: new Date().toISOString(),
};

function makeDb() {
  const runs = [];
  let nextId = 1;
  const same = (a, b) => (a ?? null) === (b ?? null);
  const ativo = (p) => runs.find((r) =>
    r.cliente_id === p[0] && same(r.cliente_conta_id, p[1]) && r.marketplace === p[2]
    && r.date_from === p[3] && r.date_to === p[4] && (r.status === "queued" || r.status === "running")) || null;

  return {
    runs,
    publicados: new Set(),
    async query(sql, params = []) {
      await new Promise((resolve) => setImmediate(resolve));
      if (/CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|ALTER TABLE/.test(sql)) return { rows: [] };
      if (sql.includes("FROM clientes WHERE slug = $1 AND ativo = true")) return { rows: params[0] === cliente.slug ? [cliente] : [] };
      if (sql.includes("FROM clientes WHERE id = $1")) return { rows: params[0] === cliente.id ? [cliente] : [] };
      if (sql.includes("FROM cliente_contas WHERE id = $1")) return { rows: Number(params[0]) === conta.id ? [conta] : [] };
      if (sql.includes("COUNT(*)::int AS total FROM cliente_contas")) return { rows: [{ total: 1 }] };
      if (sql.includes("t.cliente_id = $1 AND t.ml_user_id = $2")) return { rows: [grant] };
      if (sql.includes("FROM base_cliente_vinculos")) return { rows: [] };
      if (sql.includes("SYNC_RUN_STALE_QUEUED") || sql.includes("SYNC_RUN_STALE_RUNNING")) return { rows: [] };
      if (sql.includes("FROM central_vendas_sync_runs") && sql.includes("status IN ('queued','running')") && !sql.includes("JOIN clientes")) {
        const row = ativo(params);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("FROM central_vendas_sync_runs r") && sql.includes("i.publication_status = 'published'")) {
        const row = runs.find((r) =>
          r.cliente_id === params[0] && same(r.cliente_conta_id, params[1]) && r.marketplace === params[2]
          && r.date_from === params[3] && r.date_to === params[4] && r.status === "completed"
          && this.publicados.has(r.id));
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("INSERT INTO central_vendas_sync_runs")) {
        const [clienteId, clienteSlug, clienteContaId, marketplace, ext, grantId, baseId, baseMode, dateFrom, dateTo, requestedBy] = params;
        if (ativo([clienteId, clienteContaId, marketplace, dateFrom, dateTo])) {
          const err = new Error("duplicate key value violates unique constraint \"uq_central_vendas_sync_runs_ativo_v2\"");
          err.code = "23505";
          throw err;
        }
        const row = {
          id: nextId++, cliente_id: clienteId, cliente_slug: clienteSlug, cliente_conta_id: clienteContaId,
          marketplace, external_account_id: ext, grant_id: grantId, base_id: baseId, base_resolution_mode: baseMode,
          date_from: dateFrom, date_to: dateTo, status: "queued", requested_by: requestedBy,
          created_at: new Date().toISOString(), started_at: null, finished_at: null, metadata_json: {},
        };
        runs.push(row);
        return { rows: [row] };
      }
      if (sql.includes("UPDATE central_vendas_sync_runs") && sql.includes("started_at = NOW()")) {
        const row = runs.find((r) => r.id === params[0] && r.status === "queued");
        if (!row) return { rows: [] };
        row.status = "running";
        row.started_at = new Date().toISOString();
        return { rows: [row] };
      }
      if (sql.includes("UPDATE central_vendas_sync_runs") && sql.includes("status = 'completed'")) {
        const row = runs.find((r) => r.id === params[0] && r.status === "running");
        if (!row) return { rows: [] };
        row.status = "completed";
        row.completeness_status = "complete";
        return { rows: [row] };
      }
      if (sql.includes("JOIN clientes c ON c.id = r.cliente_id") && sql.includes("r.id = $1 AND c.slug = $2")) {
        const row = runs.find((r) => r.id === params[0] && params[1] === cliente.slug);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("FROM central_vendas_imports") && sql.includes("sync_run_id = $1")) {
        return { rows: this.publicados.has(params[0]) ? [{ id: 700 + params[0], competencia: "2026-09" }] : [] };
      }
      throw new Error(`SQL inesperado no teste: ${sql.slice(0, 90)}`);
    },
  };
}

// Executor com a MESMA reivindicação atômica de executarSyncRun
// (marcarRunRunning real: UPDATE ... WHERE status='queued'). Conta ingestões:
// é exatamente o que não pode passar de 1 por run.
function makeExecutor(db, { duracaoMs = 20 } = {}) {
  const stats = { ingestoes: 0, porRun: new Map() };
  async function executarSyncRun({ run }) {
    const marcado = await runService.marcarRunRunning(run.id, db);
    if (!marcado) return null;
    stats.ingestoes += 1;
    stats.porRun.set(run.id, (stats.porRun.get(run.id) || 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, duracaoMs));
    await runService.marcarRunCompleted(run.id, { ordersEncontrados: 0 }, db);
    db.publicados.add(run.id);
    return { ok: true };
  }
  return { executarSyncRun, stats };
}

function depsCron(db, executarSyncRun) {
  return {
    db,
    criarSyncRun: runService.criarSyncRun,
    obterSyncRun: runService.obterSyncRun,
    executarSyncRun,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    agora: () => Date.now(),
    observarIntervaloMs: 5,
    observarTimeoutMs: 5000,
    logger: { log() {}, warn() {}, error() {} },
  };
}

const unidade = {
  conta: { clienteId: 1, clienteSlug: "cliente-a", clienteContaId: 11 },
  periodo: { competencia: "2026-09", dateFrom: "2026-09-01", dateTo: "2026-09-23" },
};

// Caminho manual = exatamente o do controller POST /:slug/sincronizar.
async function manual(db, executarSyncRun) {
  const { run, context } = await runService.criarSyncRun({
    clienteSlug: "cliente-a", clienteContaId: 11, marketplace: "meli",
    dateFrom: "2026-09-01", dateTo: "2026-09-23", requestedBy: 7, db,
  });
  const data = await executarSyncRun({ run, context, params: {}, db });
  return { run, data };
}

async function run() {
  // 1. Manual e cron disparados no MESMO instante.
  {
    const db = makeDb();
    const { executarSyncRun, stats } = makeExecutor(db);
    const [m, c] = await Promise.all([
      manual(db, executarSyncRun),
      svc.processarUnidade(unidade, depsCron(db, executarSyncRun)),
    ]);
    eq("corrida: um único run criado", db.runs.length, 1);
    eq("corrida: uma única ingestão", stats.ingestoes, 1);
    eq("corrida: manual e cron no mesmo run", c.runId, m.run.id);
    eq("corrida: run terminou completed", db.runs[0].status, "completed");
    eq("corrida: cron conclui com sucesso (ou observando)", c.status, "sucesso");
    ok("corrida: exatamente um dos dois executou", (m.data !== null) !== (c.executadoPor === "cron"));
  }

  // 2. Manual já rodando (clique às 02:59) → cron reaproveita e OBSERVA.
  {
    const db = makeDb();
    const { executarSyncRun, stats } = makeExecutor(db, { duracaoMs: 60 });
    const manualPromise = manual(db, executarSyncRun);
    await new Promise((resolve) => setTimeout(resolve, 15));
    ok("manual em andamento antes do cron", db.runs[0] && db.runs[0].status === "running");
    const c = await svc.processarUnidade(unidade, depsCron(db, executarSyncRun));
    await manualPromise;
    eq("observa: run reaproveitado", c.reaproveitado, true);
    eq("observa: cron não executou", c.executadoPor, "outro_processo");
    eq("observa: esperou o fim e reporta sucesso", c.status, "sucesso");
    eq("observa: publicado detectado", c.publicado, true);
    eq("observa: uma ingestão", stats.ingestoes, 1);
    eq("observa: um run", db.runs.length, 1);
  }

  // 3. Duas instâncias do cron sobrepostas (ex.: disparo manual do Cron Job
  //    enquanto o agendado roda) → mesmo run, uma ingestão.
  {
    const db = makeDb();
    const { executarSyncRun, stats } = makeExecutor(db);
    const [a, b] = await Promise.all([
      svc.processarUnidade(unidade, depsCron(db, executarSyncRun)),
      svc.processarUnidade(unidade, depsCron(db, executarSyncRun)),
    ]);
    eq("cron×cron: um run", db.runs.length, 1);
    eq("cron×cron: uma ingestão", stats.ingestoes, 1);
    eq("cron×cron: mesmo runId", a.runId, b.runId);
    ok("cron×cron: um executou, o outro reaproveitou", [a.reaproveitado, b.reaproveitado].filter(Boolean).length === 1);
    eq("cron×cron: ambos sucesso", [a.status, b.status], ["sucesso", "sucesso"]);
  }

  // 4. Depois de concluído/publicado, outra rodada automatica equivalente
  //    reaproveita o terminal; o fluxo manual continua podendo reprocessar.
  {
    const db = makeDb();
    const { executarSyncRun, stats } = makeExecutor(db, { duracaoMs: 1 });
    const primeiro = await svc.processarUnidade(unidade, depsCron(db, executarSyncRun));
    const segundo = await svc.processarUnidade(unidade, depsCron(db, executarSyncRun));
    eq("sequencial cron: mesmo run publicado reaproveitado", segundo.runId, primeiro.runId);
    eq("sequencial cron: uma unica ingestão", [...stats.porRun.values()], [1]);
    const manualNovo = await manual(db, executarSyncRun);
    ok("manual: reprocessamento explicito ainda cria novo run", manualNovo.run.id !== primeiro.runId);
    eq("sequencial: nenhum run preso em queued/running", db.runs.map((r) => r.status), ["completed", "completed"]);
  }

  // 5. Restart depois de ocupar os 3 primeiros workers: os 10 runs ja
  //    existem. A recuperacao fecha o running orfao, reaproveita os queued e
  //    nao executa/publica novamente os 2 completed.
  {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      cliente_conta_id: i + 1, cliente_id: i + 1, marketplace: "meli",
      external_account_id: `ML${i + 1}`, conta_ativa: true, conta_nome: `Conta ${i + 1}`,
      cliente_slug: `cliente-${i + 1}`, cliente_nome: `Cliente ${i + 1}`, cliente_ativo: true,
    }));
    const estados = new Map(rows.map((r, i) => [r.cliente_conta_id, {
      id: 100 + i,
      status: i < 2 ? "completed" : (i === 2 ? "running" : "queued"),
      completenessStatus: i < 2 ? "complete" : null,
      publicado: i < 2,
    }]));
    const executados = [];
    const publicacoesIniciais = [...estados.values()].filter((r) => r.publicado).length;
    let proximoId = 1000;
    const deps = {
      db: {
        async query(sql, params) {
          if (sql.includes("FROM central_vendas_imports")) {
            const run = [...estados.values()].find((r) => r.id === params[0]);
            return { rows: run?.publicado ? [{ id: run.id * 10, competencia: "2026-09" }] : [] };
          }
          throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
        },
      },
      async listarPeriodosNoturnosPendentes() { return [{ competencia: "2026-09", dateFrom: "2026-09-01", dateTo: "2026-09-24" }]; },
      async reconciliarRunsNoturnosInterrompidos() {
        const run = estados.get(3);
        run.status = "failed";
        return [{ id: run.id }];
      },
      async listarContas() { return rows; },
      async criarSyncRun(p) {
        let run = estados.get(p.clienteContaId);
        if (run.status === "failed") {
          run = { id: proximoId++, status: "queued", completenessStatus: null, publicado: false };
          estados.set(p.clienteContaId, run);
          return { run, context: {}, reaproveitado: false };
        }
        return { run, context: {}, reaproveitado: true };
      },
      async executarSyncRun({ run }) {
        executados.push(run.id);
        run.status = "completed";
        run.completenessStatus = "complete";
        run.publicado = true;
        return { ok: true };
      },
      async obterSyncRun({ runId }) {
        return [...estados.values()].find((r) => r.id === runId);
      },
      async sincronizarAdsCliente({ contas }) { return { atualizado: true, contas: contas.length, investimentoAds: 0, gmvAds: 0 }; },
      async reconstruirSnapshotMensal() { return { atualizado: true }; },
      sleep: async () => {},
      agora: () => Date.now(),
      observarIntervaloMs: 1,
      observarTimeoutMs: 5,
      logger: { log() {}, warn() {}, error() {} },
    };
    const recuperacao = await svc.recuperarRodadasPendentes({
      env: { SYNC_CENTRAL_CONCURRENCY: "3" },
      iniciadoEm: new Date(),
    }, deps);
    eq("restart: recuperacao executada", recuperacao.recuperada, true);
    eq("restart: running orfao explicitamente reconciliado", recuperacao.runningInterrompidos, 1);
    eq("restart: todos os 10 chegam a completed", recuperacao.resumo.completed, 10);
    eq("restart: 2 publicados anteriores nao sao reexecutados", executados.length, 8);
    eq("restart: publicacoes totais sem duplicar as 2 anteriores", [...estados.values()].filter((r) => r.publicado).length, publicacoesIniciais + 8);
  }

  concluido = true;
  console.log(`centralVendasNoturnoIdempotencia.test.js: ${checks} verificacoes OK`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
