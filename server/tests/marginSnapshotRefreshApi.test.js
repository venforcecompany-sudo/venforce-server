// server/tests/marginSnapshotRefreshApi.test.js
// Margin Snapshot — M4: API de refresh (POST 202) e status do run (GET),
// sempre account-scoped. Fake db + fake de contas; nenhum ML, nenhum Postgres,
// nenhum processor executado pelo request.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const api = require("../services/motorMargem/marginSnapshotApiService");
const runService = require("../services/motorMargem/marginSnapshotRunService");
const runRepository = require("../services/motorMargem/marginSnapshotRunRepository");
const { createMarginSnapshotController } = require("../controllers/marginSnapshotController");
const { makeMarginSnapshotFakeDb } = require("./helpers/marginSnapshotFakeDb");
const { clienteContaServiceFake } = require("./helpers/marginSnapshotContasFake");

const casos = [];
function cenario(nome, fn) {
  casos.push({ nome, fn });
}

function deps(db, extra = {}) {
  return { db, clienteContaService: clienteContaServiceFake, kick: () => {}, ...extra };
}

async function esperaErro(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("era esperado um erro");
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

// ── POST refresh ───────────────────────────────────────────────────────────

cenario("POST refresh: cria run queued da conta e responde com runId (reaproveitado=false); acorda o worker", async () => {
  const db = makeMarginSnapshotFakeDb();
  let kicks = 0;
  const r = await api.solicitarRefresh({ clienteSlug: "loja-a", clienteContaId: 5, requestedBy: 3 }, deps(db, { kick: () => { kicks += 1; } }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reaproveitado, false);
  assert.strictEqual(typeof r.runId, "number");
  assert.strictEqual(r.run.status, "queued");
  assert.strictEqual(db.runs[0].reason, "manual_refresh");
  assert.strictEqual(db.runs[0].cliente_conta_id, 5);
  assert.strictEqual(db.runs[0].requested_by, 3);
  assert.strictEqual(kicks, 1);
});

cenario("POST refresh no controller: 202 Accepted, sem esperar cálculo (nenhum processor é chamado no request)", async () => {
  const db = makeMarginSnapshotFakeDb();
  const service = {
    ...api,
    solicitarRefresh: (args) => api.solicitarRefresh(args, deps(db)),
  };
  const controller = createMarginSnapshotController({ service });
  const res = fakeRes();
  const t0 = Date.now();
  await controller.solicitarRefresh({ params: { clienteSlug: "loja-a" }, body: { clienteContaId: 5 }, user: { id: 3 } }, res);
  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(res.body.ok, true);
  assert.ok(res.body.runId);
  assert.ok(Date.now() - t0 < 500, "request não bloqueia no cálculo");
  assert.strictEqual(db.runs[0].status, "queued", "o run continua queued: quem processa é o worker, fora do request");
});

cenario("dois refresh manuais simultâneos → UM run ativo (o 2º reaproveita)", async () => {
  const db = makeMarginSnapshotFakeDb();
  const [a, b] = await Promise.all([
    api.solicitarRefresh({ clienteSlug: "loja-a", clienteContaId: 5 }, deps(db)),
    api.solicitarRefresh({ clienteSlug: "loja-a", clienteContaId: 5 }, deps(db)),
  ]);
  assert.strictEqual(a.runId, b.runId);
  assert.deepStrictEqual([a.reaproveitado, b.reaproveitado].sort(), [false, true]);
  assert.strictEqual(db.runs.filter((r) => r.status === "queued" || r.status === "running").length, 1);
});

cenario("POST refresh valida a conta: obrigatória (400), de outro cliente (403), Shopee (422), inativa (409)", async () => {
  const db = makeMarginSnapshotFakeDb();
  const semConta = await esperaErro(() => api.solicitarRefresh({ clienteSlug: "loja-a" }, deps(db)));
  assert.strictEqual(semConta.statusCode, 400);
  assert.strictEqual(semConta.payload.code, "CLIENTE_CONTA_ID_OBRIGATORIO");

  const invalida = await esperaErro(() => api.solicitarRefresh({ clienteSlug: "loja-a", clienteContaId: "abc" }, deps(db)));
  assert.strictEqual(invalida.statusCode, 400);

  const outroCliente = await esperaErro(() => api.solicitarRefresh({ clienteSlug: "loja-a", clienteContaId: 7 }, deps(db)));
  assert.strictEqual(outroCliente.statusCode, 403);
  assert.strictEqual(outroCliente.payload.code, "CONTA_NAO_PERTENCE_AO_CLIENTE");

  const shopee = await esperaErro(() => api.solicitarRefresh({ clienteSlug: "loja-a", clienteContaId: 8 }, deps(db)));
  assert.strictEqual(shopee.statusCode, 422);

  const inativa = await esperaErro(() => api.solicitarRefresh({ clienteSlug: "loja-a", clienteContaId: 9 }, deps(db)));
  assert.strictEqual(inativa.statusCode, 409);

  assert.strictEqual(db.runs.length, 0, "nenhum run criado para conta inválida");
});

// ── GET status ─────────────────────────────────────────────────────────────

async function runDaConta(db, clienteContaId, clienteId = 1) {
  const { run } = await runService.enqueueMarginSnapshotRun({ clienteId, clienteSlug: "x", clienteContaId, reason: "manual_refresh", db });
  return run;
}

cenario("GET status devolve o progresso persistido do run da conta", async () => {
  const db = makeMarginSnapshotFakeDb();
  const run = await runDaConta(db, 5);
  await runRepository.updateRunStatus({ runId: run.id, status: "running", db });
  await runRepository.updateRunProgress({ runId: run.id, processedItems: 820, successItems: 815, failedItems: 5, cursorOffset: 820, totalItems: 5000, db });

  const r = await api.obterStatusRefresh({ clienteSlug: "loja-a", clienteContaId: 5, runId: run.id }, deps(db));
  assert.strictEqual(r.run.status, "running");
  assert.strictEqual(r.run.totalItems, 5000);
  assert.strictEqual(r.run.processedItems, 820);
  assert.strictEqual(r.run.successItems, 815);
  assert.strictEqual(r.run.failedItems, 5);
  assert.ok(r.run.startedAt && r.run.heartbeatAt);
  assert.strictEqual(r.run.reason, "manual_refresh");
  assert.ok(!("metadata" in r.run), "metadata interna não sai pela API");
});

cenario("GET status NUNCA vaza run de outra conta (404) nem de outro cliente (403)", async () => {
  const db = makeMarginSnapshotFakeDb();
  const run6 = await runDaConta(db, 6);
  const run7 = await runDaConta(db, 7, 2);

  const contaErrada = await esperaErro(() => api.obterStatusRefresh({ clienteSlug: "loja-a", clienteContaId: 5, runId: run6.id }, deps(db)));
  assert.strictEqual(contaErrada.statusCode, 404, "run da conta 6 consultado como conta 5 = inexistente");
  assert.strictEqual(contaErrada.payload.code, "RUN_NAO_ENCONTRADO");

  const outroCliente = await esperaErro(() => api.obterStatusRefresh({ clienteSlug: "loja-a", clienteContaId: 7, runId: run7.id }, deps(db)));
  assert.strictEqual(outroCliente.statusCode, 403);

  const semConta = await esperaErro(() => api.obterStatusRefresh({ clienteSlug: "loja-a", runId: run6.id }, deps(db)));
  assert.strictEqual(semConta.statusCode, 400);

  const runInvalido = await esperaErro(() => api.obterStatusRefresh({ clienteSlug: "loja-a", clienteContaId: 5, runId: "x" }, deps(db)));
  assert.strictEqual(runInvalido.statusCode, 400);
});

cenario("GET status: erro do run sai redigido (nenhum token) e truncado", async () => {
  const db = makeMarginSnapshotFakeDb();
  const run = await runDaConta(db, 5);
  await runRepository.updateRunStatus({ runId: run.id, status: "running", db });
  await runRepository.updateRunStatus({
    runId: run.id, status: "failed", errorCode: "X",
    errorMessage: "falhou com Authorization: Bearer APP_USR-123456-abcdef e refresh_token=TG-999 " + "y".repeat(3000),
    db,
  });
  const r = await api.obterStatusRefresh({ clienteSlug: "loja-a", clienteContaId: 5, runId: run.id }, deps(db));
  assert.ok(!/APP_USR-123456/.test(r.run.errorMessage));
  assert.ok(!/TG-999/.test(r.run.errorMessage));
  assert.ok(r.run.errorMessage.length <= 500);
});

cenario("controller: erro estruturado vira o status/código do service; erro inesperado vira 500 genérico", async () => {
  const controller = createMarginSnapshotController({
    service: {
      obterStatusRefresh: async () => { throw api.criarErroHttp(404, "Run de atualização não encontrado para esta conta.", "RUN_NAO_ENCONTRADO"); },
      solicitarRefresh: async () => { throw new Error("pool esgotado em 10.0.0.1 senha=abc"); },
    },
  });
  const r1 = fakeRes();
  await controller.obterStatusRefresh({ params: { clienteSlug: "loja-a", runId: "1" }, query: { clienteContaId: "5" } }, r1);
  assert.strictEqual(r1.statusCode, 404);
  assert.strictEqual(r1.body.code, "RUN_NAO_ENCONTRADO");

  const r2 = fakeRes();
  const { error } = console;
  console.error = () => {};
  try {
    await controller.solicitarRefresh({ params: { clienteSlug: "loja-a" }, body: { clienteContaId: 5 } }, r2);
  } finally {
    console.error = error;
  }
  assert.strictEqual(r2.statusCode, 500);
  assert.deepStrictEqual(r2.body, { ok: false, erro: "Erro interno." }, "detalhe interno nunca vaza");
});

// ── Recalcular só os que falharam ───────────────────────────────────────────

async function runConcluido(db, { clienteContaId = 5, clienteId = 1, falhas = [] } = {}) {
  const run = await runRepository.createRun({ clienteId, clienteSlug: "x", clienteContaId, reason: "manual_refresh", db });
  await runRepository.updateRunStatus({ runId: run.id, status: "running", db });
  if (falhas.length) {
    await runRepository.mergeRunMetadata({ runId: run.id, patch: { falhas: { total: falhas.length, itemIds: falhas } }, db });
  }
  return runRepository.updateRunStatus({ runId: run.id, status: "completed", db });
}

cenario("run concluído com falhas guardadas expõe podeRefazerFalhas; sem falhas, não", async () => {
  const db = makeMarginSnapshotFakeDb();
  const comFalhas = await runConcluido(db, { falhas: ["MLB1", "MLB2"] });
  assert.strictEqual(api.runPublico(comFalhas).podeRefazerFalhas, true);
  assert.strictEqual(api.runPublico(comFalhas).escopo, "catalogo");
  const semFalhas = await runConcluido(db, { clienteContaId: 6 });
  assert.strictEqual(api.runPublico(semFalhas).podeRefazerFalhas, false);
});

cenario("run 3808 (crash do PG): running sem heartbeat há 4+ min sai como parado; ativo normal e terminal não", async () => {
  const agora = Date.parse("2026-11-10T18:15:00Z");
  const base = { id: 3808, clienteContaId: 87, status: "running", startedAt: "2026-11-10T18:08:34Z", createdAt: "2026-11-10T18:08:34Z" };
  const parado = api.runPublico({ ...base, heartbeatAt: "2026-11-10T18:09:08Z" }, agora);
  assert.strictEqual(parado.parado, true);
  assert.strictEqual(parado.semProgressoMinutos, 5);
  assert.strictEqual(parado.status, "running", "o GET não muda o estado: quem encerra é o reconcile");
  const vivo = api.runPublico({ ...base, heartbeatAt: "2026-11-10T18:14:30Z" }, agora);
  assert.strictEqual(vivo.parado, false);
  assert.strictEqual(vivo.semProgressoMinutos, 0);
  // queued há muito tempo = nenhum worker pegou (ex.: MARGIN_SNAPSHOT_WORKER_ENABLED desligado).
  const fila = api.runPublico({ id: 1, clienteContaId: 87, status: "queued", createdAt: "2026-11-10T18:00:00Z" }, agora);
  assert.strictEqual(fila.parado, true);
  const fim = api.runPublico({ ...base, status: "failed", finishedAt: "2026-11-10T18:19:30Z" }, agora);
  assert.strictEqual(fim.parado, false);
  assert.strictEqual(fim.semProgressoMinutos, null);
});

cenario("POST refresh com refazerFalhasDoRun: cria run com escopo = ids que falharam no run de origem", async () => {
  const db = makeMarginSnapshotFakeDb();
  const origem = await runConcluido(db, { falhas: ["MLB1", "MLB2"] });
  const r = await api.solicitarRefresh({ clienteSlug: "loja-a", clienteContaId: 5, refazerFalhasDoRun: origem.id }, deps(db));
  assert.strictEqual(r.reaproveitado, false);
  assert.strictEqual(r.run.escopo, "falhas");
  const novo = db.runs.find((x) => x.id === r.runId);
  assert.deepStrictEqual(novo.metadata_json.escopo, { tipo: "falhas", origemRunId: origem.id, itemIds: ["MLB1", "MLB2"] });
  assert.strictEqual(novo.reason, "manual_refresh");
});

cenario("refazerFalhasDoRun: run sem falhas → 409; run de outra conta → 404; id inválido → 400", async () => {
  const db = makeMarginSnapshotFakeDb();
  const semFalhas = await runConcluido(db);
  const e409 = await esperaErro(() => api.solicitarRefresh({ clienteSlug: "loja-a", clienteContaId: 5, refazerFalhasDoRun: semFalhas.id }, deps(db)));
  assert.strictEqual(e409.statusCode, 409);
  assert.strictEqual(e409.payload.code, "SEM_FALHAS_PARA_REFAZER");

  const deOutra = await runConcluido(db, { clienteContaId: 6, falhas: ["MLB9"] });
  const e404 = await esperaErro(() => api.solicitarRefresh({ clienteSlug: "loja-a", clienteContaId: 5, refazerFalhasDoRun: deOutra.id }, deps(db)));
  assert.strictEqual(e404.statusCode, 404);

  const e400 = await esperaErro(() => api.solicitarRefresh({ clienteSlug: "loja-a", clienteContaId: 5, refazerFalhasDoRun: "abc" }, deps(db)));
  assert.strictEqual(e400.statusCode, 400);
  assert.strictEqual(db.runs.filter((x) => x.status === "queued").length, 0, "nenhum run criado nos erros");
});

cenario("pedido de catálogo inteiro durante um run PARCIAL em execução vira rerun completo", async () => {
  const db = makeMarginSnapshotFakeDb();
  const origem = await runConcluido(db, { falhas: ["MLB1"] });
  const r = await api.solicitarRefresh({ clienteSlug: "loja-a", clienteContaId: 5, refazerFalhasDoRun: origem.id }, deps(db));
  await runRepository.updateRunStatus({ runId: r.runId, status: "running", db });
  const completo = await api.solicitarRefresh({ clienteSlug: "loja-a", clienteContaId: 5 }, deps(db));
  assert.strictEqual(completo.reaproveitado, true);
  const parcial = db.runs.find((x) => x.id === r.runId);
  assert.ok(parcial.metadata_json.rerunSolicitado, "o worker re-enfileira o catálogo inteiro ao fim do parcial");
});

async function main() {
  let falhas = 0;
  for (const caso of casos) {
    try {
      await caso.fn();
      console.log(`  ✓ ${caso.nome}`);
    } catch (err) {
      falhas += 1;
      console.error(`  ✗ ${caso.nome}\n    ${err.stack || err.message}`);
    }
  }
  if (falhas > 0) {
    console.error(`marginSnapshotRefreshApi: ${falhas} de ${casos.length} cenários falharam`);
    process.exitCode = 1;
  } else {
    console.log(`marginSnapshotRefreshApi: ok (${casos.length} cenários)`);
  }
}

main();
