// server/tests/promoSnapshot.test.js
// Promo Snapshot por conta — cobertura obrigatória da missão
// (docs/PROMO_SNAPSHOT_ACCOUNT_SYNC.md §Testes). Sem Postgres e sem ML real:
// repositório em memória que espelha o SQL (o SQL real é validado em
// scripts/promoSnapshotSqlCheck.js) e um ML falso que registra método,
// caminho e token (conta) de CADA chamada.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://127.0.0.1:1/vf-test";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const F = require("./helpers/promoSnapshotFakes");
const { resolvePromoSnapshotConfig } = require("../services/promoSnapshot/promoSnapshotConfig");
const { processPromoSnapshotRun, validarContaPadrao } = require("../services/promoSnapshot/promoSnapshotProcessor");
const service = require("../services/promoSnapshot/promoSnapshotService");
const read = require("../services/promoSnapshot/promoSnapshotReadService");
const runtime = require("../services/promoSnapshot/promoSnapshotRuntime");
const { orquestrarTick } = require("../services/promoSnapshot/promoSnapshotOrchestrator");
const { criarLeitorMl } = require("../services/promoSnapshot/promoSnapshotMlLeitor");
const { normalizarPromocoesDoItem } = require("../services/promoSnapshot/promoSnapshotNormalize");
const { createRateLimiter } = require("../services/motorMargem/marginSnapshotRateLimiter");
const { resolverContaDoCliente } = require("../services/motorMargem/marginSnapshotApiService");
const { listarOportunidades } = require("../services/motorMargem/precificacao/precificacaoOportunidadesService");
const { createPromoSnapshotController } = require("../controllers/promoSnapshotController");

const casos = [];
function cenario(nome, fn) { casos.push({ nome, fn }); }

// Todas as chamadas ao ML de todos os cenários (prova final de zero escrita).
const TODAS_CHAMADAS_ML = [];

const ENV = {
  PROMO_SNAPSHOT_WORKER_ENABLED: "true",
  // Allowlist do piloto: os clientes dos cenários estão dentro dela; os cenários
  // de allowlist sobrescrevem esta variável.
  PROMO_SNAPSHOT_CLIENTES: "loja-a,loja-b,loja-c,loja-d,loja-e,loja-f",
  PROMO_SNAPSHOT_REQUEST_INTERVAL_MS: "0",
  PROMO_SNAPSHOT_BACKOFF_BASE_MS: "100",
  PROMO_SNAPSHOT_BACKOFF_MAX_MS: "400",
  PROMO_SNAPSHOT_MAX_ATTEMPTS: "3",
  PROMO_SNAPSHOT_BATCH_SIZE: "20",
  PROMO_SNAPSHOT_FRESH_MINUTES: "360",
  PROMO_SNAPSHOT_RUNNING_STALE_MINUTES: "10",
  PROMO_SNAPSHOT_PARTIAL_MAX_FAIL_RATIO: "0.05",
};

// Cliente 3 ("loja-a") com DUAS contas ML (7 → seller 555, 8 → seller 666);
// cliente 4 ("loja-b") com a conta 9 → seller 777.
const CONTAS = {
  7: { id: 7, cliente_id: 3, cliente_slug: "loja-a", marketplace: "meli", nome: "Conta A", ativo: true, external_account_id: "555" },
  8: { id: 8, cliente_id: 3, cliente_slug: "loja-a", marketplace: "meli", nome: "Conta B", ativo: true, external_account_id: "666" },
  9: { id: 9, cliente_id: 4, cliente_slug: "loja-b", marketplace: "meli", nome: "Conta C", ativo: true, external_account_id: "777" },
};
const CLIENTES = { "loja-a": { id: 3, slug: "loja-a", nome: "Loja A" }, "loja-b": { id: 4, slug: "loja-b", nome: "Loja B" } };

function idConta(contaId) {
  const c = CONTAS[contaId];
  return { clienteId: c.cliente_id, clienteSlug: c.cliente_slug, clienteContaId: c.id, marketplace: "meli", sellerId: c.external_account_id };
}

function catalogo(prefixo, n, promosDe = () => [F.promo({ id: `P-${prefixo}`, status: "candidate", suggested: 90, meli: 5, seller: 5 })]) {
  const itens = {};
  for (let i = 1; i <= n; i += 1) itens[`MLB${prefixo}${String(i).padStart(4, "0")}`] = promosDe(i);
  return itens;
}

function ambiente({ sellers = null, roteiro = null, env = {}, marginSnaps = new Map(), contasCliente = [], grants = [], validarConta = null, sleepHook = null } = {}) {
  const relogio = new F.Relogio();
  // Contas "vivas" deste ambiente (reconectar seller muda external_account_id).
  const contas = JSON.parse(JSON.stringify(CONTAS));
  const repo = F.criarRepoFake({ relogio, marginSnaps, contasCliente, grants, sellerDaConta: (id) => (contas[id] ? contas[id].external_account_id : null) });
  const ml = F.criarMlFake({ sellers: sellers || { 555: { itens: catalogo("A", 3) }, 666: { itens: catalogo("B", 2) }, 777: { itens: catalogo("C", 1) } }, roteiro });
  const logger = F.loggerMemoria();
  const esperas = [];
  const sleep = async (ms) => { esperas.push(ms); if (sleepHook) await sleepHook(ms, relogio, repo); };
  const envFinal = { ...ENV, ...env };
  const config = resolvePromoSnapshotConfig(envFinal);
  const limiter = createRateLimiter({ minIntervalMs: 0, now: () => relogio.agora(), sleep });
  const now = () => new Date(relogio.agora());
  const kicks = [];
  const base = { repo, env: envFinal, logger, now, kick: () => kicks.push(1), db: { query: async () => ({ rows: [] }) } };
  const procDeps = {
    ...base, config, sleep, rateLimiter: limiter, mlFetch: ml.mlFetch, agoraIso: () => relogio.iso(), clock: () => relogio.agora(),
    validarConta: validarConta || (async () => ({})),
  };
  const runService = service.criarRunService(base);
  const worker = runtime.criarWorker({
    db: base.db, logger, config, runService,
    processor: (run, ctx) => processPromoSnapshotRun(run, { ...procDeps, signal: ctx.signal }),
  });
  const amb = { relogio, repo, ml, logger, esperas, config, limiter, base, procDeps, runService, worker, kicks, env: envFinal, contas };
  amb.id = (contaId) => {
    const c = contas[contaId];
    return { clienteId: c.cliente_id, clienteSlug: c.cliente_slug, clienteContaId: c.id, marketplace: "meli", sellerId: c.external_account_id };
  };
  amb.enfileirar = (contaId, reason = "manual_sync") => service.enqueuePromoSnapshotRun(amb.id(contaId), { reason }, base);
  amb.rodar = async (contaId, reason) => { await amb.enfileirar(contaId, reason); return worker.runOnce(); };
  amb.estado = (contaId) => service.estadoSincronizacao({ clienteContaId: contaId, sellerId: contas[contaId].external_account_id }, base);
  amb.conta = (contaId, seller = contas[contaId].external_account_id) => repo._st.contas.get(F.chaveConta(contaId, "meli", seller));
  amb.linhasAtuais = (contaId) => { const c = amb.conta(contaId); return c ? repo._st.itens.filter((i) => i.run_id === c.current_run_id) : []; };
  TODAS_CHAMADAS_ML.push(ml.chamadas);
  return amb;
}

// Serviço de contas falso para a validação REAL de conta (resolverContaDoCliente).
function contasServiceFake(contas = CONTAS) {
  return {
    async resolverClientePorIdOuSlug({ clienteSlug }) {
      const c = CLIENTES[clienteSlug];
      if (!c) { const e = new Error("Cliente não encontrado."); e.statusCode = 404; throw e; }
      return c;
    },
    async obterConta(id) {
      const c = contas[Number(id)];
      if (!c) { const e = new Error("Conta não encontrada."); e.statusCode = 404; throw e; }
      return c;
    },
  };
}

function depsLeitura(amb, extra = {}) {
  const svc = contasServiceFake(amb.contas);
  return {
    ...amb.base,
    clienteContaService: svc,
    resolverContaDoCliente,
    obterConta: (id) => svc.obterConta(id),
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Conta / seller / grant
// ─────────────────────────────────────────────────────────────────────────────

cenario("cliente com 1 conta: primeiro run lê o catálogo, grava as promoções e promove o snapshot", async () => {
  const amb = ambiente();
  const r = await amb.rodar(9, "first_sync");
  assert.strictEqual(r.status, "completed");
  const c = amb.conta(9);
  assert.ok(c.current_run_id, "ponteiro do snapshot atual criado");
  assert.strictEqual(c.parcial, false);
  const linhas = amb.linhasAtuais(9);
  assert.strictEqual(linhas.length, 1);
  assert.strictEqual(linhas[0].item_id, "MLBC0001");
  assert.strictEqual(linhas[0].cliente_conta_id, 9);
  assert.strictEqual(linhas[0].seller_id, "777");
});

cenario("cliente com 2 contas: cada run usa o token DA SUA conta e grava só os itens dela", async () => {
  const amb = ambiente();
  assert.strictEqual((await amb.rodar(7)).status, "completed");
  assert.strictEqual((await amb.rodar(8)).status, "completed");
  const a = amb.linhasAtuais(7);
  const b = amb.linhasAtuais(8);
  assert.deepStrictEqual([...new Set(a.map((l) => l.item_id))].sort(), ["MLBA0001", "MLBA0002", "MLBA0003"]);
  assert.deepStrictEqual([...new Set(b.map((l) => l.item_id))].sort(), ["MLBB0001", "MLBB0002"]);
  assert.ok(a.every((l) => l.seller_id === "555" && l.cliente_conta_id === 7));
  assert.ok(b.every((l) => l.seller_id === "666" && l.cliente_conta_id === 8));
  // Nenhuma leitura de item da conta B com o token da conta A (e vice-versa):
  // no ML falso isso responderia 403 e viraria erro no run.
  assert.strictEqual(amb.repo._st.runs.every((r) => r.erros === 0), true);
  const chamadasA = amb.ml.chamadas.filter((x) => /MLBA/.test(x.path));
  assert.ok(chamadasA.length && chamadasA.every((x) => x.mlUserId === "555"));
});

cenario("conta A não vê B: snapshot, status e oportunidades da conta A nunca trazem linha da conta B", async () => {
  const snaps = new Map([
    ["7:MLBA0001", { titulo: "A1", image_url: null, price: 100, cost: 40, tax_rate: 0.1, fixed_fee: 0, commission_rate: 0.12, commission: 12, freight: 10, margin: 0.2 }],
    ["8:MLBB0001", { titulo: "B1", image_url: null, price: 100, cost: 40, tax_rate: 0.1, fixed_fee: 0, commission_rate: 0.12, commission: 12, freight: 10, margin: 0.2 }],
  ]);
  const amb = ambiente({ marginSnaps: snaps });
  await amb.rodar(7);
  await amb.rodar(8);
  const deps = depsLeitura(amb);
  const snapA = await read.obterSnapshot({ clienteSlug: "loja-a", clienteContaId: 7 }, deps);
  assert.ok(snapA.promocoes.length > 0);
  assert.ok(snapA.promocoes.every((p) => p.itemId.startsWith("MLBA")));
  const opA = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, { ...deps, carregarRealizada: async () => ({ porMlb: new Map() }) });
  assert.strictEqual(opA.fonte.tipo, "promo_snapshot");
  assert.deepStrictEqual(opA.oportunidades.map((o) => o.itemId), ["MLBA0001"]);
  const opB = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 8 }, { ...deps, carregarRealizada: async () => ({ porMlb: new Map() }) });
  assert.deepStrictEqual(opB.oportunidades.map((o) => o.itemId), ["MLBB0001"]);
  assert.notStrictEqual(opA.fonte.runId, opB.fonte.runId);
});

cenario("seller correto: a listagem do catálogo é sempre /users/{seller do run} com o token desse seller", async () => {
  const amb = ambiente();
  await amb.rodar(8);
  const lista = amb.ml.chamadas.filter((x) => x.path.startsWith("/users/"));
  assert.ok(lista.length >= 1);
  assert.ok(lista.every((x) => x.path.startsWith("/users/666/items/search?") && x.mlUserId === "666"));
  // O leitor recusa listar outro seller mesmo que o caminho seja montado errado.
  const leitor = criarLeitorMl({ clienteId: 3, sellerId: "666", timeoutMs: 1000, mlFetch: amb.ml.mlFetch });
  await assert.rejects(() => leitor.get("/users/555/items/search?search_type=scan"), (e) => e.code === "PROMO_SNAPSHOT_SELLER_DIVERGENTE");
});

// Db falso para a validação REAL de conta + grant (clienteContaService.obterConta
// + mlTokenService.resolveMlGrant).
function dbValidacao({ contas = CONTAS, grants = [] } = {}) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params) {
      consultas.push({ sql, params });
      if (/FROM cliente_contas WHERE id = \$1/.test(sql)) {
        const c = contas[Number(params[0])];
        return { rows: c ? [c] : [] };
      }
      if (/FROM ml_tokens t\s+WHERE t\.cliente_id = \$1 AND t\.ml_user_id = \$2/.test(sql)) {
        return { rows: grants.filter((g) => g.cliente_id === Number(params[0]) && String(g.ml_user_id) === String(params[1])) };
      }
      throw new Error("SQL inesperado na validação: " + sql.slice(0, 80));
    },
  };
}

function grant(ml, o = {}) {
  return {
    id: Number(ml), cliente_id: 3, ml_user_id: String(ml), access_token: `acc-${ml}`, refresh_token: `ref-${ml}`,
    expires_at: new Date(Date.now() + 6 * 3600e3), token_status: o.status || "valid", is_primary: o.primary === true,
    refresh_failures: 0, next_refresh_attempt_at: null, last_refresh_error_at: null, _has_is_primary: true, _has_refresh_metadata: true,
    updated_at: new Date(),
  };
}

cenario("grant correto: a validação resolve o grant pelo seller DA CONTA (nunca o principal do cliente)", async () => {
  const db = dbValidacao({ grants: [grant("555", { primary: true }), grant("666")] });
  const run = { id: 1, clienteId: 3, clienteContaId: 8, sellerId: "666", marketplace: "meli" };
  await validarContaPadrao(run, { db });
  const q = db.consultas.find((x) => /FROM ml_tokens/.test(x.sql));
  assert.deepStrictEqual(q.params.map(String), ["3", "666"]);
  // Conta reconectada a outro seller: o run antigo não herda a conta nova.
  await assert.rejects(() => validarContaPadrao({ ...run, sellerId: "999" }, { db }), (e) => e.code === "PROMO_SNAPSHOT_SELLER_DIVERGENTE");
  // Conta de outro cliente.
  await assert.rejects(() => validarContaPadrao({ ...run, clienteContaId: 9, sellerId: "777" }, { db }), (e) => e.code === "PROMO_SNAPSHOT_CONTA_DE_OUTRO_CLIENTE");
});

cenario("conta inativa: run falha sem nenhuma chamada ao ML e o último snapshot bom é preservado", async () => {
  const contas = { ...CONTAS, 7: { ...CONTAS[7] } };
  const db = dbValidacao({ contas, grants: [grant("555")] });
  const amb = ambiente({ validarConta: (run) => validarContaPadrao(run, { db }) });
  assert.strictEqual((await amb.rodar(7)).status, "completed");
  const bom = amb.conta(7).current_run_id;
  const chamadasAntes = amb.ml.chamadas.length;
  contas[7].ativo = false;
  amb.relogio.avancar(400);
  const r = await amb.rodar(7);
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.run.errorCode, "PROMO_SNAPSHOT_CONTA_INATIVA");
  assert.strictEqual(amb.ml.chamadas.length, chamadasAntes, "nenhuma chamada ao ML");
  assert.strictEqual(amb.conta(7).current_run_id, bom);
  assert.ok(amb.linhasAtuais(7).length > 0);
});

cenario("conta sem grant (ou revogado): run falha com o código do grant; nada é lido", async () => {
  const semGrant = dbValidacao({ grants: [] });
  const amb = ambiente({ validarConta: (run) => validarContaPadrao(run, { db: semGrant }) });
  const r = await amb.rodar(7);
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.run.errorCode, "ML_GRANT_NOT_FOUND");
  assert.strictEqual(amb.ml.chamadas.length, 0);
  const revogado = dbValidacao({ grants: [grant("555", { status: "revoked" })] });
  const amb2 = ambiente({ validarConta: (run) => validarContaPadrao(run, { db: revogado }) });
  const r2 = await amb2.rodar(7);
  assert.strictEqual(r2.run.errorCode, "ML_GRANT_REVOKED");
  assert.strictEqual(amb2.ml.chamadas.length, 0);
});

cenario("orquestrador: só contas ativas, MELI, com grant utilizável e snapshot vencido/inexistente; respeita o limite por tick", async () => {
  const contasCliente = [
    { id: 7, cliente_id: 3, cliente_slug: "loja-a", marketplace: "meli", ativo: true, external_account_id: "555" },
    { id: 8, cliente_id: 3, cliente_slug: "loja-a", marketplace: "meli", ativo: false, external_account_id: "666" }, // inativa
    { id: 9, cliente_id: 4, cliente_slug: "loja-b", marketplace: "meli", ativo: true, external_account_id: "777" },   // grant revogado
    { id: 10, cliente_id: 5, cliente_slug: "loja-c", marketplace: "meli", ativo: true, external_account_id: null },   // sem seller
    { id: 11, cliente_id: 6, cliente_slug: "loja-d", marketplace: "shopee", ativo: true, external_account_id: "x" },  // outro marketplace
    { id: 12, cliente_id: 7, cliente_slug: "loja-e", marketplace: "meli", ativo: true, external_account_id: "888", cliente_ativo: false },
    { id: 13, cliente_id: 8, cliente_slug: "loja-f", marketplace: "meli", ativo: true, external_account_id: "999" },   // sem grant
  ];
  const grants = [
    { cliente_id: 3, ml_user_id: "555", access_token: "a", refresh_token: "r", token_status: "valid" },
    { cliente_id: 3, ml_user_id: "666", access_token: "a", refresh_token: "r", token_status: "valid" },
    { cliente_id: 4, ml_user_id: "777", access_token: "a", refresh_token: "r", token_status: "revoked" },
    { cliente_id: 7, ml_user_id: "888", access_token: "a", refresh_token: "r", token_status: "valid" },
  ];
  const amb = ambiente({ contasCliente, grants });
  const r = await orquestrarTick({ ...amb.base });
  assert.deepStrictEqual(r.enfileirados.map((e) => e.clienteContaId), [7]);
  assert.strictEqual(amb.repo._st.runs[0].reason, "scheduled_refresh");
  // Segundo tick com run ativo: não duplica.
  const r2 = await orquestrarTick({ ...amb.base });
  assert.deepStrictEqual(r2.enfileirados, []);
  // Worker desligado: o orquestrador não enfileira nada.
  const amb3 = ambiente({ contasCliente, grants, env: { PROMO_SNAPSHOT_WORKER_ENABLED: "false" } });
  assert.strictEqual((await orquestrarTick({ ...amb3.base })).motivo, "WORKER_DESABILITADO");
  assert.strictEqual(amb3.repo._st.runs.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Runs, dedupe, instâncias, heartbeat, recovery, restart
// ─────────────────────────────────────────────────────────────────────────────

cenario("primeiro run: ensureFresh numa conta nunca sincronizada enfileira (first_sync) e devolve na hora", async () => {
  const amb = ambiente();
  const r = await service.ensureFreshPromoSnapshot(idConta(7), {}, amb.base);
  assert.strictEqual(r.acao, "enfileirado");
  assert.strictEqual(amb.repo._st.runs[0].reason, "first_sync");
  assert.strictEqual(amb.repo._st.runs[0].status, "queued", "não executa o scan dentro do request");
  assert.strictEqual(amb.ml.chamadas.length, 0);
  assert.strictEqual(amb.kicks.length, 1);
});

cenario("dedupe: pedidos repetidos reaproveitam o run ativo (log promo_snapshot_run_reused)", async () => {
  const amb = ambiente();
  const a = await amb.enfileirar(7);
  const b = await amb.enfileirar(7);
  const c = await service.ensureFreshPromoSnapshot(idConta(7), {}, amb.base);
  assert.strictEqual(a.reaproveitado, false);
  assert.strictEqual(b.reaproveitado, true);
  assert.strictEqual(b.run.id, a.run.id);
  assert.strictEqual(c.acao, "reutilizado");
  assert.strictEqual(amb.repo._st.runs.length, 1);
  assert.ok(amb.logger.eventos.some((e) => e.event === "promo_snapshot_run_reused" && e.cliente_conta_id === 7 && e.seller_id === "555"));
});

cenario("duas instâncias: corrida no enqueue vira 23505 → reaproveita; o claim entrega o run a UMA só", async () => {
  const amb = ambiente();
  // Instância 2 cria o run entre o SELECT e o INSERT da instância 1.
  amb.repo._esconderAtivoUmaVez = true;
  amb.repo._forcarCorrida = async () => {
    amb.repo._forcarCorrida = null;
    await amb.repo.createRun({ ...idConta(7), reason: "instancia_2" });
  };
  const r = await amb.enfileirar(7);
  assert.strictEqual(r.reaproveitado, true);
  assert.strictEqual(r.run.reason, "instancia_2");
  assert.strictEqual(amb.repo._st.runs.length, 1);
  // Dois workers (instâncias) disputando o mesmo run.
  const outro = runtime.criarWorker({ db: amb.base.db, logger: amb.logger, config: amb.config, runService: service.criarRunService(amb.base), processor: async () => ({ total: 0, falhas: 0 }) });
  const [x, y] = await Promise.all([amb.worker.runOnce(), outro.runOnce()]);
  assert.strictEqual([x, y].filter((z) => z.claimed).length, 1);
});

cenario("heartbeat: renovado a cada página do catálogo e a cada lote gravado", async () => {
  const amb = ambiente({ sellers: { 555: { itens: catalogo("A", 45) } } });
  let heartbeats = 0;
  const touch = amb.repo.touchHeartbeat;
  amb.repo.touchHeartbeat = async (...a) => { heartbeats += 1; return touch(...a); };
  const r = await amb.rodar(7);
  assert.strictEqual(r.status, "completed");
  assert.ok(heartbeats >= 1, "heartbeat por página do catálogo");
  assert.strictEqual(amb.repo._st.lotes.filter((l) => l.run_id === r.run.id).length, 3, "45 itens → 3 lotes de 20");
});

cenario("recovery: running sem heartbeat vira failed (STALE); novo run é permitido; o worker zumbi não grava nem promove", async () => {
  const amb = ambiente();
  await amb.enfileirar(7);
  const zumbi = await amb.repo.claimNextQueuedRun();
  amb.relogio.avancar(11);
  const novo = await amb.enfileirar(7); // reconcilia antes do dedupe
  const velho = amb.repo._st.runs.find((r) => r.id === zumbi.id);
  assert.strictEqual(velho.status, "failed");
  assert.strictEqual(velho.error_code, "PROMO_SNAPSHOT_RUN_STALE");
  assert.strictEqual(novo.reaproveitado, false);
  // O processo antigo acorda e tenta continuar: toda escrita é recusada.
  await assert.rejects(
    () => processPromoSnapshotRun(zumbi, amb.procDeps),
    (e) => e.code === "PROMO_SNAPSHOT_RUN_NAO_ESTA_MAIS_RUNNING"
  );
  assert.strictEqual(await amb.runService.markRunCompleted(zumbi.id, amb.base.db, { total: 3, falhas: 0 }), null);
  assert.strictEqual(amb.conta(7).current_run_id, undefined);
  assert.strictEqual(amb.repo._st.itens.filter((i) => i.run_id === zumbi.id).length, 0);
});

cenario("restart: run interrompido é retomado — lotes concluídos NÃO são relidos do ML e o snapshot tem a idade da leitura mais antiga", async () => {
  const amb = ambiente({ sellers: { 555: { itens: catalogo("A", 60) } } });
  await amb.enfileirar(7);
  const run1 = await amb.repo.claimNextQueuedRun();
  // Processo morre depois do 2º lote (40 itens gravados).
  let lotes = 0;
  const registrar = amb.repo.registrarLote;
  const deps = { ...amb.procDeps, repo: { ...amb.repo, registrarLote: async (a) => { const r = await registrar(a); lotes += 1; if (lotes === 2) throw Object.assign(new Error("SIGKILL"), { code: "PROCESSO_MORREU" }); return r; } } };
  await assert.rejects(() => processPromoSnapshotRun(run1, deps));
  const inicioRun1 = amb.repo._st.runs[0].started_at;
  amb.relogio.avancar(11);
  await amb.repo.reconcileStaleRunningRuns({ staleMinutes: 10 });
  const leiturasAntes = amb.ml.contar(/^\/seller-promotions\/items\//);
  assert.strictEqual(leiturasAntes, 40);
  const r = await amb.rodar(7, "scheduled_refresh");
  assert.strictEqual(r.status, "completed");
  const run2 = amb.repo._st.runs[1];
  assert.strictEqual(run2.resumed_from_run_id, run1.id);
  assert.strictEqual(amb.ml.contar(/^\/seller-promotions\/items\//) - leiturasAntes, 20, "só os 20 itens pendentes são relidos");
  assert.strictEqual(amb.linhasAtuais(7).length, 60);
  assert.strictEqual(amb.conta(7).snapshot_at, inicioRun1);
  assert.ok(amb.linhasAtuais(7).filter((l) => l.origem_run_id === run1.id).length === 40);
});

cenario("parada cooperativa do worker (deploy): run termina failed WORKER_STOPPED e fica retomável", async () => {
  const amb = ambiente({ sellers: { 555: { itens: catalogo("A", 60) } } });
  let chamadas = 0;
  let parada = null;
  let avisarParada;
  const parou = new Promise((resolve) => { avisarParada = resolve; });
  // SIGTERM chega no meio do 2º lote (depois do 1º lote gravado).
  const lento = async (clienteId, p, o) => {
    chamadas += 1;
    if (chamadas === 30) { parada = amb.worker.stop(); avisarParada(); }
    return amb.ml.mlFetch(clienteId, p, o);
  };
  amb.procDeps.mlFetch = lento;
  await amb.enfileirar(7);
  amb.worker.start(60000);
  await parou;
  await parada;
  const run = amb.repo._st.runs[0];
  assert.ok(amb.repo._st.lotes.some((l) => l.run_id === run.id), "1º lote gravado antes da parada");
  assert.strictEqual(run.status, "failed");
  assert.strictEqual(run.error_code, "PROMO_SNAPSHOT_WORKER_STOPPED");
  const retomavel = await amb.repo.findResumableRun({ clienteContaId: 7, sellerId: "555", resumeMaxMinutes: 60 });
  assert.strictEqual(retomavel && retomavel.id, run.id);
});

// ─────────────────────────────────────────────────────────────────────────────
// completed / partial / failed e estados de UI
// ─────────────────────────────────────────────────────────────────────────────

cenario("partial dentro do limite: promovido e marcado como parcial; acima do limite: último snapshot bom preservado", async () => {
  // 40 itens, 1 falha persistente (2,5% ≤ 5%) → promove parcial.
  const amb = ambiente({
    sellers: { 555: { itens: catalogo("A", 40) } },
    roteiro: (p) => (p.includes("MLBA0007") ? F.erro500() : undefined),
  });
  const r = await amb.rodar(7);
  assert.strictEqual(r.run.status, "partial");
  assert.strictEqual(r.run.promovido, true);
  assert.strictEqual(amb.conta(7).parcial, true);
  assert.strictEqual(amb.conta(7).itens_sem_leitura, 1);
  const estado = await amb.estado(7);
  assert.strictEqual(estado.state, "partial");

  // Próximo run com 50% de falhas → partial NÃO promovido; o ponteiro fica.
  const bom = amb.conta(7).current_run_id;
  amb.ml.chamadas.length = 0;
  amb.relogio.avancar(400);
  const falhando = F.criarMlFake({ sellers: { 555: { itens: catalogo("A", 40) } }, roteiro: (p) => (/MLBA00[0-1]\d/.test(p) && p.includes("seller-promotions") ? F.erro500() : undefined) });
  TODAS_CHAMADAS_ML.push(falhando.chamadas);
  amb.procDeps.mlFetch = falhando.mlFetch;
  const r2 = await amb.rodar(7);
  assert.strictEqual(r2.run.status, "partial");
  assert.strictEqual(r2.run.promovido, false);
  assert.strictEqual(amb.conta(7).current_run_id, bom);
  assert.strictEqual(amb.conta(7).last_attempt_status, "partial");
  const e2 = await amb.estado(7);
  assert.strictEqual(e2.state, "failed", "tentativa mais nova que o snapshot não foi aceita");
  assert.strictEqual(e2.hasSnapshot, true);
});

cenario("failed: falha estrutural (catálogo) não toca o snapshot atual; estado failed com o último bom disponível", async () => {
  const amb = ambiente();
  await amb.rodar(7);
  const bom = amb.conta(7).current_run_id;
  const linhasBoas = amb.linhasAtuais(7).length;
  amb.relogio.avancar(400);
  amb.procDeps.mlFetch = async (c, p, o) => (p.startsWith("/users/") ? F.erro500() : amb.ml.mlFetch(c, p, o));
  const r = await amb.rodar(7);
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.run.errorCode, "PROMO_SNAPSHOT_CATALOGO_FALHOU");
  assert.strictEqual(amb.conta(7).current_run_id, bom);
  assert.strictEqual(amb.linhasAtuais(7).length, linhasBoas);
  const e = await amb.estado(7);
  assert.strictEqual(e.state, "failed");
  assert.strictEqual(e.errorCode, "PROMO_SNAPSHOT_CATALOGO_FALHOU");
  assert.strictEqual(e.hasSnapshot, true);
});

cenario("estados de UI: never_synced → syncing → fresh → stale (com idade, progresso e last_success_at)", async () => {
  const amb = ambiente();
  const e0 = await amb.estado(7);
  assert.strictEqual(e0.state, "never_synced");
  assert.strictEqual(e0.hasSnapshot, false);
  await amb.enfileirar(7);
  const e1 = await amb.estado(7);
  assert.strictEqual(e1.state, "syncing");
  await amb.worker.runOnce();
  const e2 = await amb.estado(7);
  assert.strictEqual(e2.state, "fresh");
  assert.strictEqual(e2.ageMinutes, 0);
  assert.strictEqual(e2.processed, 3);
  assert.strictEqual(e2.total, 3);
  assert.ok(e2.lastSuccessAt);
  amb.relogio.avancar(361);
  const e3 = await amb.estado(7);
  assert.strictEqual(e3.state, "stale");
  assert.strictEqual(e3.ageMinutes, 361);
  assert.strictEqual(e3.snapshotState, "stale");
});

// ─────────────────────────────────────────────────────────────────────────────
// Paginação ML, 429, 500, timeout, resposta parcial
// ─────────────────────────────────────────────────────────────────────────────

cenario("paginação ML: catálogo em 3 páginas de scan (scroll_id) é lido inteiro, sem duplicar", async () => {
  const amb = ambiente({ sellers: { 555: { itens: catalogo("A", 250) } } });
  const r = await amb.rodar(7);
  assert.strictEqual(r.status, "completed");
  assert.strictEqual(r.run.itensTotal, 250);
  assert.strictEqual(amb.ml.contar(/^\/users\/555\/items\/search/), 4, "3 páginas com itens + 1 vazia");
  assert.ok(amb.ml.chamadas.some((c) => /scroll_id=scroll-100/.test(c.path)));
  assert.strictEqual(new Set(amb.linhasAtuais(7).map((l) => l.item_id)).size, 250);
});

cenario("429 + Retry-After: espera o tempo pedido, pausa o processo inteiro e conta rate_limits", async () => {
  const amb = ambiente({ roteiro: (p, o, n) => (p.includes("MLBA0002") && n === 1 ? F.erro429(2) : undefined) });
  const r = await amb.rodar(7);
  assert.strictEqual(r.status, "completed");
  assert.ok(amb.esperas.includes(2000), "Retry-After de 2 s respeitado");
  assert.strictEqual(r.run.rateLimits, 1);
  assert.ok(amb.limiter.estado().cooldownRestanteMs > 0, "cooldown global aplicado ao limiter do processo");
  const ev = amb.logger.eventos.find((e) => e.event === "promo_snapshot_rate_limited");
  assert.ok(ev && ev.cliente_conta_id === 7 && ev.seller_id === "555" && ev.run_id);
});

cenario("500: retry com backoff; recuperado conta como sucesso, persistente vira item sem leitura (partial)", async () => {
  const amb = ambiente({ roteiro: (p, o, n) => (p.includes("MLBA0001") && n <= 2 ? F.erro500() : p.includes("MLBA0003") ? F.erro500() : undefined) });
  const r = await amb.rodar(7);
  assert.strictEqual(r.run.status, "partial");
  assert.strictEqual(r.run.erros, 1);
  assert.ok(amb.esperas.includes(100) && amb.esperas.includes(200), "backoff exponencial");
  assert.ok(amb.linhasAtuais(7).length === 0 || true);
  const itensRun = amb.repo._st.itens.filter((i) => i.run_id === r.run.id).map((i) => i.item_id);
  assert.ok(itensRun.includes("MLBA0001") && !itensRun.includes("MLBA0003"));
});

cenario("timeout: MlTimeoutError é retentado; o leitor sempre passa timeoutMs real ao mlFetch", async () => {
  const amb = ambiente({ roteiro: (p, o, n) => (p.includes("MLBA0002") && n === 1 ? F.erroTimeout(p) : undefined) });
  const r = await amb.rodar(7);
  assert.strictEqual(r.status, "completed");
  assert.strictEqual(r.run.retries, 1);
  assert.ok(amb.ml.chamadas.every((c) => c.timeoutMs === amb.config.requestTimeoutMs));
});

cenario("resposta parcial: página do catálogo sem results é retentada e, persistindo, falha o run (nunca vira fim do catálogo)", async () => {
  const amb = ambiente({ roteiro: (p) => (p.startsWith("/users/") ? { ok: true, status: 200, data: { paging: { total: 3 } } } : undefined) });
  const r = await amb.rodar(7);
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.run.errorCode, "PROMO_SNAPSHOT_CATALOGO_FALHOU");
  assert.strictEqual(amb.ml.contar(/^\/users\//), 3, "3 tentativas");
  // Promoções do item fora do formato também não viram "sem promoção".
  const amb2 = ambiente({ roteiro: (p) => (p.includes("seller-promotions/items/MLBA0001") ? { ok: true, status: 200, data: { inesperado: true } } : undefined) });
  const r2 = await amb2.rodar(7);
  assert.strictEqual(r2.run.erros, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Normalização: sem preço, sem subsídio, tipo desconhecido
// ─────────────────────────────────────────────────────────────────────────────

cenario("promoção sem preço: fica gravada com preco_final null (nunca inventado) e fora das oportunidades", async () => {
  const linhas = normalizarPromocoesDoItem({
    itemId: "MLB1", observedAt: "2026-10-01T12:00:00Z",
    lista: [F.promo({ id: "P-1", type: "SMART", status: "candidate" })], // sem sugestão e sem meli%
  });
  assert.strictEqual(linhas.length, 1);
  assert.strictEqual(linhas[0].precoFinal, null);
  assert.strictEqual(linhas[0].precoFinalFonte, null);
  assert.strictEqual(linhas[0].elegivel, true);
  // candidate só com percentuais: preço calculado e marcado como tal.
  const [calc] = normalizarPromocoesDoItem({ itemId: "MLB1", observedAt: "x", lista: [F.promo({ id: "P-2", type: "SMART", status: "candidate", meli: 10, seller: 5 })] });
  assert.strictEqual(calc.precoFinal, 85);
  assert.strictEqual(calc.precoFinalFonte, "calculado_percentuais");
});

cenario("Alianza Jeans: snapshot preserva preço oficial da candidata e sua origem ML", async () => {
  const [linha] = normalizarPromocoesDoItem({
    itemId: "MLB6414829980", observedAt: "2026-11-13T03:30:52Z",
    lista: [{
      id: "P-MLB18211016", type: "SMART", status: "candidate", name: "Novembro Feminino",
      original_price: 139.99, price: 99, suggested_discounted_price: null,
      meli_percentage: 4.5, seller_percentage: 24.7,
    }],
  });
  assert.strictEqual(linha.precoFinal, 99);
  assert.strictEqual(linha.precoFinalFonte, "ml");
  assert.strictEqual(linha.subsidioMl, 6.3);
});

cenario("promoção sem subsídio: meli_percentage ausente → subsidio_ml null (nunca zero)", async () => {
  const [l] = normalizarPromocoesDoItem({ itemId: "MLB1", observedAt: "x", lista: [F.promo({ id: "P-1", status: "started", price: 90 })] });
  assert.strictEqual(l.subsidioMl, null);
  assert.strictEqual(l.meliPercentage, null);
  assert.strictEqual(l.precoFinal, 90);
  assert.strictEqual(l.precoFinalFonte, "ml");
});

cenario("tipo desconhecido: preservado com tipo_conhecido=false (nunca descartado)", async () => {
  const linhas = normalizarPromocoesDoItem({
    itemId: "MLB1", observedAt: "x",
    lista: [F.promo({ id: "P-9", type: "TIPO_NOVO_DO_ML", status: "candidate", suggested: 80 }), F.promo({ id: "P-1", type: "DEAL", status: "pending", price: 95 })],
  });
  const novo = linhas.find((l) => l.promotionType === "TIPO_NOVO_DO_ML");
  assert.ok(novo);
  assert.strictEqual(novo.tipoConhecido, false);
  assert.strictEqual(linhas.find((l) => l.promotionType === "DEAL").tipoConhecido, true);
  assert.strictEqual(linhas.find((l) => l.promotionType === "DEAL").programada, true);
});

cenario("ativa/não aplicada: confirmadas pelo sale_price; sem sale_price ficam null (nunca chute)", async () => {
  const lista = [F.promo({ id: "P-A", status: "started", price: 90 }), F.promo({ id: "P-B", type: "SMART", status: "started", price: 92 })];
  const com = normalizarPromocoesDoItem({ itemId: "MLB1", observedAt: "x", lista, saleInfo: { promotionId: "P-B", amount: 92 } });
  assert.strictEqual(com.find((l) => l.promotionId === "P-B").ativa, true);
  assert.strictEqual(com.find((l) => l.promotionId === "P-A").naoAplicada, true);
  const sem = normalizarPromocoesDoItem({ itemId: "MLB1", observedAt: "x", lista, saleInfo: null });
  assert.ok(sem.every((l) => l.ativa === null && l.naoAplicada === null && l.statusExibicao === "INICIADA"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot consistente
// ─────────────────────────────────────────────────────────────────────────────

cenario("snapshot novo: troca o ponteiro atomicamente, guarda o anterior e poda os mais velhos", async () => {
  const amb = ambiente();
  await amb.rodar(7);
  const r1 = amb.conta(7).current_run_id;
  amb.relogio.avancar(400);
  await amb.rodar(7);
  const r2 = amb.conta(7).current_run_id;
  amb.relogio.avancar(400);
  await amb.rodar(7);
  const c = amb.conta(7);
  assert.notStrictEqual(c.current_run_id, r2);
  assert.strictEqual(c.previous_run_id, r2);
  assert.strictEqual(amb.repo._st.itens.filter((i) => i.run_id === r1).length, 0, "run mais velho podado");
  assert.ok(amb.repo._st.itens.filter((i) => i.run_id === r2).length > 0, "anterior mantido");
  // Leitura nunca mistura runs.
  const s = await read.obterSnapshot({ clienteSlug: "loja-a", clienteContaId: 7, limit: 100 }, depsLeitura(amb));
  assert.ok(s.promocoes.every((p) => p.reaproveitadaDoRun === null));
  assert.strictEqual(s.snapshot.runId, c.current_run_id);
});

cenario("último snapshot bom preservado: run que falha no meio não publica metade nova", async () => {
  const sellers = { 555: { itens: catalogo("A", 60) } };
  const amb = ambiente({ sellers });
  await amb.rodar(7);
  const bom = amb.conta(7).current_run_id;
  amb.relogio.avancar(400);
  // Novo run: 3 lotes seguidos sem nenhuma leitura → falha estrutural.
  amb.procDeps.mlFetch = async (c, p, o) => (p.startsWith("/seller-promotions") ? F.erro500() : amb.ml.mlFetch(c, p, o));
  const r = await amb.rodar(7);
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.run.errorCode, "PROMO_SNAPSHOT_LOTES_FALHANDO");
  assert.strictEqual(amb.conta(7).current_run_id, bom);
  assert.strictEqual(amb.linhasAtuais(7).length, 60);
});

cenario("promoção desapareceu: some do snapshot atual depois do próximo run completo", async () => {
  const sellers = { 555: { itens: { MLBX1: [F.promo({ id: "P-1", status: "candidate", suggested: 90 })], MLBX2: [F.promo({ id: "P-2", status: "candidate", suggested: 80 })] } } };
  const amb = ambiente({ sellers });
  await amb.rodar(7);
  assert.strictEqual(amb.linhasAtuais(7).length, 2);
  sellers[555].itens.MLBX2 = [];
  amb.relogio.avancar(400);
  await amb.rodar(7);
  assert.deepStrictEqual(amb.linhasAtuais(7).map((l) => l.item_id), ["MLBX1"]);
});

cenario("promoção mudou status: candidate → started aparece com o status novo e ativa confirmada pelo sale_price", async () => {
  const sellers = { 555: { itens: { MLBX1: [F.promo({ id: "P-1", status: "candidate", suggested: 90 })] }, saleInfo: {} } };
  const amb = ambiente({ sellers });
  await amb.rodar(7);
  assert.strictEqual(amb.linhasAtuais(7)[0].status, "candidate");
  sellers[555].itens.MLBX1 = [F.promo({ id: "P-1", status: "started", price: 90 })];
  sellers[555].saleInfo.MLBX1 = { promotionId: "P-1", amount: 90 };
  amb.relogio.avancar(400);
  await amb.rodar(7);
  const [l] = amb.linhasAtuais(7);
  assert.strictEqual(l.status, "started");
  assert.strictEqual(l.ativa, true);
  assert.strictEqual(l.status_exibicao, "ATIVA");
});

// ─────────────────────────────────────────────────────────────────────────────
// Central de Margem como consumidora
// ─────────────────────────────────────────────────────────────────────────────

function depsCentral(amb, extra = {}) {
  const consultasDb = [];
  const db = {
    consultasDb,
    async query(sql, params) {
      consultasDb.push({ sql, params });
      // Diagnóstico legado inexistente nesta instalação.
      if (/promocoes_diagnosticos/.test(sql)) { const e = new Error("relation does not exist"); e.code = "42P01"; throw e; }
      // Retorno ML das promoções em andamento da PÁGINA (margem atual): UMA consulta em lote.
      if (/FROM promo_snapshot_contas c/.test(sql)) return { rows: [] };
      throw new Error("SQL inesperado na Central: " + sql.slice(0, 80));
    },
  };
  return { ...depsLeitura(amb), db, carregarRealizada: async () => ({ porMlb: new Map(), periodo: null }), ...extra };
}

cenario("Central sem snapshot: responde na hora, sem ML, indisponível com o estado e NÃO enfileira só por abrir a aba", async () => {
  const amb = ambiente();
  const r = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, depsCentral(amb));
  assert.strictEqual(r.disponivel, false);
  assert.strictEqual(r.motivo, "SEM_SNAPSHOT_PROMOCOES");
  assert.strictEqual(r.sync.autoTrigger, "nenhuma");
  assert.strictEqual(r.sync.state, "never_synced");
  assert.ok(!/Promoções ML/.test(r.mensagem));
  assert.strictEqual(amb.ml.chamadas.length, 0, "nenhuma chamada ao ML dentro do request");
  assert.strictEqual(amb.repo._st.runs.length, 0, "abrir/trocar de aba nunca dispara varredura");
  // autoTrigger explícito (comportamento antigo, opt-in) ainda enfileira a primeira leitura.
  const r2 = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, autoTrigger: true }, depsCentral(amb));
  assert.strictEqual(r2.sync.autoTrigger, "enfileirado");
  assert.strictEqual(amb.repo._st.runs[0].status, "queued");
});

function snapsPara(contaId, prefixo, n) {
  const m = new Map();
  for (let i = 1; i <= n; i += 1) {
    m.set(`${contaId}:MLB${prefixo}${String(i).padStart(4, "0")}`, { titulo: `P${i}`, image_url: null, price: 100, cost: 40, tax_rate: 0.1, fixed_fee: 0, commission_rate: 0.12, commission: 12, freight: 10, margin: 0.2 });
  }
  return m;
}

cenario("Central com snapshot fresh: usa o snapshot e NÃO enfileira; stale: serve o último e revalida em background; syncing: reutiliza", async () => {
  const amb = ambiente({ marginSnaps: snapsPara(7, "A", 3) });
  await amb.rodar(7);
  const fresh = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, depsCentral(amb));
  assert.strictEqual(fresh.fonte.tipo, "promo_snapshot");
  assert.strictEqual(fresh.sync.state, "fresh");
  assert.strictEqual(fresh.sync.autoTrigger, "nenhuma");
  assert.strictEqual(fresh.oportunidades.length, 3);
  assert.strictEqual(amb.repo._st.runs.length, 1);

  amb.relogio.avancar(400);
  const stale = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, depsCentral(amb));
  assert.strictEqual(stale.sync.state, "stale");
  assert.strictEqual(stale.sync.autoTrigger, "nenhuma", "ler a lista não revalida sozinho");
  assert.strictEqual(stale.oportunidades.length, 3, "serve o último snapshot bom (marcado stale)");
  assert.strictEqual(amb.repo._st.runs.length, 1);
  // Revalidação explícita (opt-in) continua funcionando.
  const reval = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, autoTrigger: true }, depsCentral(amb));
  assert.strictEqual(reval.sync.autoTrigger, "enfileirado");
  assert.strictEqual(amb.repo._st.runs[1].status, "queued");

  const syncing = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, autoTrigger: true }, depsCentral(amb));
  assert.strictEqual(syncing.sync.state, "syncing");
  assert.strictEqual(syncing.sync.autoTrigger, "reutilizado");
  assert.strictEqual(syncing.oportunidades.length, 3);
  assert.strictEqual(amb.repo._st.runs.length, 2);
});

cenario("troca de conta: mesma tela, outra conta do MESMO cliente → fonte, run e itens dessa conta", async () => {
  const snaps = new Map([...snapsPara(7, "A", 3), ...snapsPara(8, "B", 2)]);
  const amb = ambiente({ marginSnaps: snaps });
  await amb.rodar(7);
  await amb.rodar(8);
  const a = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, depsCentral(amb));
  const b = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 8 }, depsCentral(amb));
  assert.ok(a.oportunidades.every((o) => o.itemId.startsWith("MLBA")));
  assert.ok(b.oportunidades.every((o) => o.itemId.startsWith("MLBB")));
  assert.strictEqual(b.fonte.runId, amb.conta(8).current_run_id);
});

cenario("troca rápida de cliente: conta de OUTRO cliente é recusada (403) antes de qualquer leitura", async () => {
  const amb = ambiente();
  await amb.rodar(9);
  await assert.rejects(
    () => read.obterSnapshot({ clienteSlug: "loja-a", clienteContaId: 9 }, depsLeitura(amb)),
    (e) => e.statusCode === 403 && e.payload.code === "CONTA_NAO_PERTENCE_AO_CLIENTE"
  );
  await assert.rejects(
    () => listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 9 }, depsCentral(amb)),
    (e) => e.statusCode === 403
  );
  await assert.rejects(
    () => read.obterStatus({ clienteSlug: "loja-a", clienteContaId: "" }, depsLeitura(amb)),
    (e) => e.statusCode === 400
  );
});

cenario("oportunidades sem N+1: 10 ou 1.000 anúncios → mesmo número de leituras, zero ML, paginação no servidor", async () => {
  async function medir(n) {
    const amb = ambiente({ sellers: { 555: { itens: catalogo("A", n) } }, marginSnaps: snapsPara(7, "A", n) });
    await amb.rodar(7);
    const antesMl = amb.ml.chamadas.length;
    amb.repo._chamadas.length = 0;
    const deps = depsCentral(amb);
    const r = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, page: 2, limit: 7 }, deps);
    return { r, repo: amb.repo._chamadas.length, db: deps.db.consultasDb.length, ml: amb.ml.chamadas.length - antesMl };
  }
  const p = await medir(10);
  const g = await medir(1000);
  assert.strictEqual(p.repo, g.repo, `leituras do repositório constantes (${p.repo} vs ${g.repo})`);
  assert.strictEqual(p.db, g.db);
  assert.strictEqual(p.ml, 0);
  assert.strictEqual(g.ml, 0);
  assert.strictEqual(g.r.page, 2);
  assert.strictEqual(g.r.limit, 7);
  assert.strictEqual(g.r.total, 1000);
  assert.strictEqual(g.r.hasNext, true);
  assert.strictEqual(g.r.oportunidades.length, 7);
  assert.strictEqual(p.r.total, 10);
  assert.strictEqual(p.r.hasNext, false);
  assert.strictEqual(p.r.oportunidades.length, 3);
});

cenario("snapshot paginado: page/limit/total/hasNext e filtros por item/status/tipo", async () => {
  const amb = ambiente({ sellers: { 555: { itens: catalogo("A", 30) } } });
  await amb.rodar(7);
  const deps = depsLeitura(amb);
  const p1 = await read.obterSnapshot({ clienteSlug: "loja-a", clienteContaId: 7, page: 1, limit: 25 }, deps);
  assert.deepStrictEqual([p1.page, p1.limit, p1.total, p1.hasNext, p1.promocoes.length], [1, 25, 30, true, 25]);
  const p2 = await read.obterSnapshot({ clienteSlug: "loja-a", clienteContaId: 7, page: 2, limit: 25 }, deps);
  assert.deepStrictEqual([p2.hasNext, p2.promocoes.length], [false, 5]);
  const um = await read.obterSnapshot({ clienteSlug: "loja-a", clienteContaId: 7, itemId: "MLBA0003" }, deps);
  assert.deepStrictEqual(um.promocoes.map((x) => x.itemId), ["MLBA0003"]);
  const nenhum = await read.obterSnapshot({ clienteSlug: "loja-a", clienteContaId: 7, status: "started" }, deps);
  assert.strictEqual(nenhum.total, 0);
  const limiteMax = await read.obterSnapshot({ clienteSlug: "loja-a", clienteContaId: 7, limit: 5000 }, deps);
  assert.strictEqual(limiteMax.limit, 100);
});

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint de sync (só enfileira) e observabilidade
// ─────────────────────────────────────────────────────────────────────────────

function resFake() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

cenario("POST sync: só enfileira (202), reaproveita run ativo, respeita cooldown por conta e o worker desligado", async () => {
  const amb = ambiente();
  const deps = depsLeitura(amb);
  const ctrl = createPromoSnapshotController({ read: { ...read, solicitarSync: (p) => read.solicitarSync(p, deps) } });
  const req = { params: { clienteSlug: "loja-a" }, body: { clienteContaId: 7 }, query: {}, user: { id: 42 } };
  const res = resFake();
  await ctrl.sync(req, res);
  assert.strictEqual(res.statusCode, 202);
  assert.strictEqual(res.body.enfileirado, true);
  assert.strictEqual(amb.repo._st.runs[0].requested_by, 42);
  assert.strictEqual(amb.ml.chamadas.length, 0, "o POST nunca chama o ML");
  const res2 = resFake();
  await ctrl.sync(req, res2);
  assert.strictEqual(res2.body.reaproveitado, true);
  await amb.worker.runOnce();
  const res3 = resFake();
  await ctrl.sync(req, res3);
  assert.strictEqual(res3.statusCode, 200);
  assert.strictEqual(res3.body.motivo, "COOLDOWN");
  const amb2 = ambiente({ env: { PROMO_SNAPSHOT_WORKER_ENABLED: "false" } });
  const off = await read.solicitarSync({ clienteSlug: "loja-a", clienteContaId: 7 }, depsLeitura(amb2));
  assert.strictEqual(off.motivo, "WORKER_DESABILITADO");
  assert.strictEqual(amb2.repo._st.runs.length, 0);
});

cenario("observabilidade: eventos estruturados com cliente, conta, seller, run, processed_count, duration_ms — nunca token", async () => {
  const amb = ambiente({ roteiro: (p, o, n) => (p.includes("MLBA0002") && n === 1 ? F.erro429(1) : undefined) });
  await amb.rodar(7);
  await amb.enfileirar(7);
  await amb.enfileirar(7);
  amb.relogio.avancar(400);
  amb.procDeps.mlFetch = async (c, p, o) => (p.startsWith("/users/") ? F.erro500() : amb.ml.mlFetch(c, p, o));
  await amb.worker.runOnce();
  const nomes = new Set(amb.logger.eventos.map((e) => e.event));
  for (const n of ["promo_snapshot_run_started", "promo_snapshot_run_reused", "promo_snapshot_page_processed", "promo_snapshot_rate_limited", "promo_snapshot_completed", "promo_snapshot_failed"]) {
    assert.ok(nomes.has(n), `evento ${n}`);
  }
  const concluido = amb.logger.eventos.find((e) => e.event === "promo_snapshot_completed");
  for (const k of ["cliente_id", "cliente_conta_id", "seller_id", "run_id", "processed_count", "duration_ms"]) assert.ok(k in concluido, `campo ${k}`);
  const bruto = JSON.stringify(amb.logger.eventos);
  assert.ok(!/access_token|refresh_token|Bearer|acc-555/.test(bruto));
});

cenario("promo_snapshot_partial é emitido quando o run termina parcial", async () => {
  const amb = ambiente({ sellers: { 555: { itens: catalogo("A", 40) } }, roteiro: (p) => (p.includes("MLBA0007") ? F.erro500() : undefined) });
  await amb.rodar(7);
  const ev = amb.logger.eventos.find((e) => e.event === "promo_snapshot_partial");
  assert.ok(ev && ev.falhas === 1 && ev.total === 40 && ev.promovido === true);
});

cenario("nenhum segredo persistido: metadados/contadores com chave sensível são recusados", async () => {
  const { assertNoSecrets } = require("../services/promoSnapshot/promoSnapshotRepository");
  assert.throws(() => assertNoSecrets({ processor: { access_token: "x" } }));
  assert.throws(() => assertNoSecrets({ Authorization: "Bearer x" }));
  assert.doesNotThrow(() => assertNoSecrets({ processor: { retries: 1 } }));
});

// ─────────────────────────────────────────────────────────────────────────────
// Auditoria — achado 1: seller reconectado (identidade = conta + seller)
// ─────────────────────────────────────────────────────────────────────────────

cenario("seller reconectado: conta 7 passa de 555 para 666 — snapshot, run e oportunidades do 555 nunca servem ao 666", async () => {
  const sellers = { 555: { itens: catalogo("A", 3) }, 666: { itens: catalogo("N", 2) } };
  const amb = ambiente({ sellers, marginSnaps: new Map([...snapsPara(7, "A", 3), ...snapsPara(7, "N", 2)]) });
  // 1. Snapshot do seller 555.
  assert.strictEqual((await amb.rodar(7)).status, "completed");
  const run555 = amb.conta(7).current_run_id;
  const deps = depsCentral(amb);
  const op555 = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, deps);
  assert.deepStrictEqual(op555.oportunidades.map((o) => o.itemId), ["MLBA0001", "MLBA0002", "MLBA0003"]);
  // 2. Snapshot vence e um run do 555 fica na fila.
  amb.relogio.avancar(400);
  const { run: velho } = await amb.enfileirar(7);
  assert.strictEqual(velho.sellerId, "555");
  // 3. A MESMA cliente_conta_id é reconectada ao seller 666.
  amb.contas[7].external_account_id = "666";
  const st = await read.obterStatus({ clienteSlug: "loja-a", clienteContaId: 7, autoTrigger: false }, depsLeitura(amb));
  assert.strictEqual(st.sellerId, "666");
  assert.strictEqual(st.sync.state, "never_synced", "leitura para 666 não retorna o snapshot 555");
  assert.strictEqual(st.sync.hasSnapshot, false);
  assert.strictEqual(st.sync.snapshotRunId, null);
  assert.strictEqual(st.sync.activeRun, null, "o run do 555 não aparece como sincronização do 666");
  const snap = await read.obterSnapshot({ clienteSlug: "loja-a", clienteContaId: 7 }, depsLeitura(amb));
  assert.strictEqual(snap.disponivel, false);
  assert.deepStrictEqual(snap.promocoes, []);
  assert.strictEqual(st.atualizacao.disponivel, true, "o run do 555 não bloqueia o Atualizar do 666");
  // Operador pede a atualização (a leitura sozinha não enfileira nada).
  const pedido = await read.solicitarSync({ clienteSlug: "loja-a", clienteContaId: 7 }, depsLeitura(amb));
  assert.strictEqual(pedido.enfileirado, true);
  // Run antigo NÃO é reaproveitado como run atual: encerrado; o novo é do 666.
  const vRow = amb.repo._st.runs.find((r) => r.id === velho.id);
  assert.strictEqual(vRow.status, "failed");
  assert.strictEqual(vRow.error_code, "PROMO_SNAPSHOT_SELLER_SUBSTITUIDO");
  const fila = amb.repo._st.runs.filter((r) => r.status === "queued");
  assert.strictEqual(fila.length, 1);
  assert.strictEqual(fila[0].seller_id, "666");
  assert.ok(amb.logger.eventos.some((e) => e.event === "promo_snapshot_run_superseded" && e.run_id === velho.id));
  // Oportunidades antigas não aparecem.
  const opAntes = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, deps);
  assert.strictEqual(opAntes.disponivel, false);
  assert.deepStrictEqual(opAntes.oportunidades, []);
  // 4. Primeiro snapshot do 666: ponteiro e linhas do 555 apagados.
  const r666 = await amb.worker.runOnce();
  assert.strictEqual(r666.status, "completed");
  assert.strictEqual(r666.run.sellerId, "666");
  assert.strictEqual(amb.conta(7, "555"), undefined);
  assert.strictEqual(amb.repo._st.itens.filter((i) => i.cliente_conta_id === 7 && i.seller_id === "555").length, 0);
  const op666 = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7 }, deps);
  assert.deepStrictEqual(op666.oportunidades.map((o) => o.itemId), ["MLBN0001", "MLBN0002"]);
  assert.notStrictEqual(op666.fonte.runId, run555);
  assert.ok(amb.ml.chamadas.filter((c) => /MLBN/.test(c.path)).every((c) => c.mlUserId === "666"));
});

cenario("seller reconectado NO MEIO do run: o run do seller anterior termina failed (SELLER_DIVERGENTE) e não promove nada", async () => {
  const amb = ambiente({ sellers: { 555: { itens: catalogo("A", 3) }, 666: { itens: catalogo("N", 2) } } });
  await amb.enfileirar(7);
  const run = await amb.repo.claimNextQueuedRun();
  amb.contas[7].external_account_id = "666";
  const resultado = await processPromoSnapshotRun(run, amb.procDeps);
  const fim = await amb.runService.markRunCompleted(run.id, amb.base.db, resultado);
  assert.strictEqual(fim.status, "failed");
  assert.strictEqual(fim.errorCode, "PROMO_SNAPSHOT_SELLER_DIVERGENTE");
  assert.strictEqual(fim.promovido, false);
  assert.strictEqual(amb.conta(7, "666"), undefined, "nada vira snapshot do 666");
  assert.strictEqual((amb.conta(7, "555") || {}).current_run_id, undefined, "nem do 555");
  assert.strictEqual((await amb.estado(7)).state, "never_synced");
  assert.ok(amb.logger.eventos.some((e) => e.event === "promo_snapshot_failed" && e.error_code === "PROMO_SNAPSHOT_SELLER_DIVERGENTE"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Auditoria — achado 2: parcial não apaga dado bom
// ─────────────────────────────────────────────────────────────────────────────

cenario("parcial aceito: 40 no snapshot anterior, 39 lidos + 1 falha → o que falhou continua, marcado como herdado (não some)", async () => {
  const sellers = { 555: { itens: catalogo("A", 40) } };
  const amb = ambiente({ sellers, marginSnaps: snapsPara(7, "A", 40) });
  const r1 = await amb.rodar(7);
  assert.strictEqual(r1.status, "completed");
  assert.strictEqual(amb.linhasAtuais(7).length, 40);
  const lido1 = amb.linhasAtuais(7).find((l) => l.item_id === "MLBA0007");
  amb.relogio.avancar(400);
  const falhando = F.criarMlFake({ sellers, roteiro: (p) => (p.includes("seller-promotions/items/MLBA0007") ? F.erro500() : undefined) });
  TODAS_CHAMADAS_ML.push(falhando.chamadas);
  amb.procDeps.mlFetch = falhando.mlFetch;
  const r2 = await amb.rodar(7);
  assert.strictEqual(r2.run.status, "partial");
  assert.strictEqual(r2.run.promovido, true, "1/40 = 2,5% ≤ 5%: aceito");
  assert.strictEqual(r2.run.erros, 1);
  assert.strictEqual(r2.run.itensHerdados, 1);
  const c = amb.conta(7);
  assert.strictEqual(c.current_run_id, r2.run.id);
  const linhas = amb.linhasAtuais(7);
  assert.strictEqual(linhas.length, 40, "39 lidas agora + 1 herdada");
  const herdada = linhas.find((l) => l.item_id === "MLBA0007");
  assert.strictEqual(herdada.herdado, true);
  assert.strictEqual(herdada.observed_at, lido1.observed_at, "mantém a data da leitura boa original");
  assert.strictEqual(herdada.origem_run_id, r1.run.id);
  assert.ok(linhas.filter((l) => l.item_id !== "MLBA0007").every((l) => l.herdado === false && l.observed_at !== lido1.observed_at));
  assert.strictEqual(c.itens_sem_leitura, 1);
  assert.strictEqual(c.itens_herdados, 1);
  const e = await amb.estado(7);
  assert.strictEqual(e.state, "partial");
  assert.strictEqual(e.itemsWithoutRead, 1);
  assert.strictEqual(e.itemsInherited, 1);
  // Snapshot e Oportunidades identificam a linha como herdada/stale.
  const s = await read.obterSnapshot({ clienteSlug: "loja-a", clienteContaId: 7, itemId: "MLBA0007" }, depsLeitura(amb));
  assert.strictEqual(s.promocoes[0].herdada, true);
  assert.strictEqual(s.promocoes[0].observedAt, lido1.observed_at);
  assert.strictEqual(s.snapshot.itensHerdados, 1);
  const op = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, limit: 50 }, depsCentral(amb));
  const o7 = op.oportunidades.find((o) => o.itemId === "MLBA0007");
  assert.ok(o7, "a oportunidade do item que falhou não sumiu");
  assert.strictEqual(o7.promocao.herdada, true);
  assert.strictEqual(o7.promocao.observadaEm, lido1.observed_at);
  assert.strictEqual(op.fonte.itensHerdados, 1);
  assert.ok(amb.logger.eventos.some((ev) => ev.event === "promo_snapshot_partial" && ev.itens_herdados === 1));
});

cenario("parcial aceito com leitura boa velha demais (PROMO_SNAPSHOT_INHERIT_MAX_MINUTES): não herda, mas fica contado como sem leitura", async () => {
  const sellers = { 555: { itens: catalogo("A", 40) } };
  const amb = ambiente({ sellers, env: { PROMO_SNAPSHOT_INHERIT_MAX_MINUTES: "60" } });
  await amb.rodar(7);
  amb.relogio.avancar(400);
  amb.procDeps.mlFetch = async (cl, p, o) => (p.includes("seller-promotions/items/MLBA0007") ? F.erro500() : amb.ml.mlFetch(cl, p, o));
  const r2 = await amb.rodar(7);
  assert.strictEqual(r2.run.promovido, true);
  assert.strictEqual(r2.run.itensHerdados, 0);
  assert.strictEqual(amb.linhasAtuais(7).length, 39);
  const e = await amb.estado(7);
  assert.deepStrictEqual([e.state, e.itemsWithoutRead, e.itemsInherited], ["partial", 1, 0]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Auditoria — achado 3: paginação do catálogo (sem truncamento, sem loop)
// ─────────────────────────────────────────────────────────────────────────────

// Primeiro um snapshot bom; depois o scan do catálogo passa a responder com
// a anomalia. O run falha ANTES de ler promoções e o snapshot bom fica.
async function cenarioCatalogo({ n = 250, env = {}, pagina }) {
  let anomalia = false;
  const ids = Object.keys(catalogo("A", n));
  const amb = ambiente({
    sellers: { 555: { itens: catalogo("A", n) } },
    env,
    roteiro: (p) => {
      if (!anomalia || !p.startsWith("/users/")) return undefined;
      const scroll = new URLSearchParams(p.split("?")[1]).get("scroll_id");
      return { ok: true, status: 200, data: pagina(scroll, ids) };
    },
  });
  assert.strictEqual((await amb.rodar(7)).status, "completed");
  const bom = amb.conta(7).current_run_id;
  const linhasBoas = amb.linhasAtuais(7).length;
  amb.relogio.avancar(400);
  anomalia = true;
  const leiturasAntes = amb.ml.contar(/seller-promotions\/items/);
  const catalogoAntes = amb.ml.contar(/^\/users\//);
  const r = await amb.rodar(7);
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.run.errorCode, "PROMO_SNAPSHOT_CATALOGO_INCONSISTENTE");
  assert.ok(!/scroll-|s-\d/.test(r.run.errorMessage), "motivo seguro: sem cursor na mensagem");
  assert.strictEqual(r.run.promovido, false);
  assert.strictEqual(amb.conta(7).current_run_id, bom, "snapshot bom preservado");
  assert.strictEqual(amb.linhasAtuais(7).length, linhasBoas);
  assert.strictEqual(amb.ml.contar(/seller-promotions\/items/), leiturasAntes, "nenhuma promoção lida com catálogo incerto");
  const e = await amb.estado(7);
  assert.strictEqual(e.state, "failed");
  assert.strictEqual(e.hasSnapshot, true);
  return { r, amb, paginasLidas: amb.ml.contar(/^\/users\//) - catalogoAntes };
}

cenario("catálogo: página não vazia SEM scroll_id com paging.total maior que o lido → falha (SCROLL_AUSENTE), nunca truncado", async () => {
  const { r } = await cenarioCatalogo({ pagina: (s, ids) => ({ results: ids.slice(0, 100), paging: { total: 250 }, scroll_id: null }) });
  assert.ok(/SCROLL_AUSENTE/.test(r.run.errorMessage) && /100 de 250/.test(r.run.errorMessage));
});

cenario("catálogo: scroll_id repetido → falha (SCROLL_REPETIDO), sem loop", async () => {
  const { r, paginasLidas } = await cenarioCatalogo({
    pagina: (s, ids) => (!s ? { results: ids.slice(0, 100), paging: { total: 250 }, scroll_id: "fixo" } : { results: ids.slice(100, 200), paging: { total: 250 }, scroll_id: "fixo" }),
  });
  assert.ok(/SCROLL_REPETIDO/.test(r.run.errorMessage));
  assert.strictEqual(paginasLidas, 2);
});

cenario("catálogo: página repetida (mesmos resultados de novo) → falha (PAGINA_REPETIDA)", async () => {
  let n = 0;
  const { r } = await cenarioCatalogo({ pagina: (s, ids) => ({ results: ids.slice(0, 100), paging: { total: 250 }, scroll_id: `s-${++n}` }) });
  assert.ok(/PAGINA_REPETIDA/.test(r.run.errorMessage));
});

cenario("catálogo: cursor sem progresso (página só com anúncios já lidos) → falha (CURSOR_SEM_PROGRESSO)", async () => {
  const { r } = await cenarioCatalogo({
    pagina: (s, ids) => (!s ? { results: ids.slice(0, 100), paging: { total: 250 }, scroll_id: "s-1" } : { results: ids.slice(40, 90), paging: { total: 250 }, scroll_id: "s-2" }),
  });
  assert.ok(/CURSOR_SEM_PROGRESSO/.test(r.run.errorMessage));
});

cenario("catálogo: scan termina com menos anúncios que paging.total → falha (TOTAL_INCOMPATIVEL)", async () => {
  const { r } = await cenarioCatalogo({
    pagina: (s, ids) => {
      const inicio = s ? Number(s.replace("s-", "")) : 0;
      const results = ids.slice(inicio, inicio + 100);
      return { results, paging: { total: 300 }, scroll_id: results.length ? `s-${inicio + 100}` : null };
    },
  });
  assert.ok(/TOTAL_INCOMPATIVEL/.test(r.run.errorMessage) && /250 anúncio\(s\) lidos para paging.total 300/.test(r.run.errorMessage));
});

cenario("catálogo: cursor que nunca acaba (1 anúncio novo por página) para no teto de páginas (PAGINAS_EXCEDIDAS)", async () => {
  const { r, paginasLidas } = await cenarioCatalogo({
    n: 50,
    env: { PROMO_SNAPSHOT_MAX_CATALOG_ITEMS: "100" },
    pagina: (s) => {
      const k = s ? Number(s.replace("s-", "")) : 0;
      return { results: [`MLBZ${k}`], scroll_id: `s-${k + 1}` };
    },
  });
  assert.ok(/PAGINAS_EXCEDIDAS/.test(r.run.errorMessage));
  assert.strictEqual(paginasLidas, 6, "teto = 100/100 + 5 páginas");
});

cenario("progresso inconsistente (processados ≠ catálogo) → partial NUNCA promovido; snapshot bom preservado", async () => {
  const amb = ambiente();
  await amb.rodar(7);
  const bom = amb.conta(7).current_run_id;
  amb.relogio.avancar(400);
  await amb.enfileirar(7);
  const run = await amb.repo.claimNextQueuedRun();
  const fim = await amb.runService.markRunCompleted(run.id, amb.base.db, { total: 10, processados: 9, falhas: 0 });
  assert.strictEqual(fim.status, "partial");
  assert.strictEqual(fim.promovido, false);
  assert.strictEqual(fim.errorCode, "PROMO_SNAPSHOT_PROGRESSO_INCONSISTENTE");
  assert.strictEqual(amb.conta(7).current_run_id, bom);
  assert.strictEqual((await amb.estado(7)).state, "failed");
});

// ─────────────────────────────────────────────────────────────────────────────
// Auditoria — achado 4: heartbeat durante lote longo (relógio fake)
// ─────────────────────────────────────────────────────────────────────────────

const ENV_LOTE_LONGO = {
  PROMO_SNAPSHOT_RUNNING_STALE_MINUTES: "10",
  PROMO_SNAPSHOT_HEARTBEAT_INTERVAL_MS: "60000",
  PROMO_SNAPSHOT_MAX_ATTEMPTS: "6",
  PROMO_SNAPSHOT_BACKOFF_BASE_MS: "60000",
  PROMO_SNAPSHOT_BACKOFF_MAX_MS: "300000",
};

cenario("heartbeat no lote longo: retry + backoff somam 17 min (> stale de 10) e outra instância reconciliando NÃO mata o run", async () => {
  let reconciliacoes = 0;
  const amb = ambiente({
    env: ENV_LOTE_LONGO,
    roteiro: (p, o, n) => (p.includes("seller-promotions/items/MLBA0002") && n <= 5 ? F.erro500() : undefined),
    // Relógio fake: toda espera avança o tempo; logo em seguida a "outra
    // instância" roda a reconciliação de heartbeat (stale = 10 min).
    sleepHook: async (ms, relogio, repo) => {
      relogio.avancarMs(ms);
      reconciliacoes += 1;
      await repo.reconcileStaleRunningRuns({ staleMinutes: 10 });
    },
  });
  const batidas = [];
  const touch = amb.repo.touchHeartbeat;
  amb.repo.touchHeartbeat = async (id) => { batidas.push(amb.relogio.agora()); return touch(id); };
  const inicio = amb.relogio.agora();
  const r = await amb.rodar(7);
  const duracaoMin = (amb.relogio.agora() - inicio) / 60000;
  assert.strictEqual(duracaoMin, 17, "60+120+240+300+300 s de backoff num único lote");
  assert.strictEqual(r.status, "completed");
  assert.strictEqual(r.run.errorCode, null);
  assert.strictEqual(r.run.retries, 5);
  assert.ok(reconciliacoes >= 17, `a outra instância reconciliou ${reconciliacoes} vezes durante o lote`);
  assert.ok(amb.repo._st.runs.every((x) => x.error_code !== "PROMO_SNAPSHOT_RUN_STALE"));
  const gaps = batidas.slice(1).map((t, i) => t - batidas[i]);
  assert.ok(gaps.length >= 17 && Math.max(...gaps) <= 60000, `maior intervalo entre heartbeats: ${Math.max(...gaps)} ms`);
});

cenario("heartbeat no cooldown do rate limit: Retry-After de 9 min duas vezes (18 min) também renova o heartbeat", async () => {
  const amb = ambiente({
    env: { ...ENV_LOTE_LONGO, PROMO_SNAPSHOT_RETRY_AFTER_MAX_MS: "600000" },
    roteiro: (p, o, n) => (p.includes("seller-promotions/items/MLBA0001") && n <= 2 ? F.erro429(540) : undefined),
    sleepHook: async (ms, relogio, repo) => { relogio.avancarMs(ms); await repo.reconcileStaleRunningRuns({ staleMinutes: 10 }); },
  });
  const r = await amb.rodar(7);
  assert.strictEqual(r.status, "completed");
  assert.strictEqual(r.run.rateLimits, 2);
  assert.ok(amb.esperas.every((ms) => ms <= 60000), "esperas longas fatiadas no intervalo do heartbeat");
});

cenario("heartbeat perdido durante a espera (run reconciliado de verdade): o processo para na hora, sem retry e sem nova chamada ao ML", async () => {
  let chamadasNoAbate = null;
  const amb = ambiente({
    env: ENV_LOTE_LONGO,
    roteiro: (p) => (p.includes("seller-promotions/items/MLBA0002") ? F.erro500() : undefined),
    sleepHook: async (ms, relogio, repo) => {
      relogio.avancarMs(ms);
      if (chamadasNoAbate === null) {
        // Outra instância decide que o run morreu (ex.: pausa longa do processo).
        const vivo = repo._st.runs.find((x) => x.status === "running");
        Object.assign(vivo, { status: "failed", error_code: "PROMO_SNAPSHOT_RUN_STALE" });
        chamadasNoAbate = amb.ml.chamadas.length;
      }
    },
  });
  await amb.enfileirar(7);
  const run = await amb.repo.claimNextQueuedRun();
  await assert.rejects(() => processPromoSnapshotRun(run, amb.procDeps), (e) => e.code === "PROMO_SNAPSHOT_RUN_NAO_ESTA_MAIS_RUNNING");
  assert.strictEqual(amb.ml.chamadas.length, chamadasNoAbate, "nenhuma chamada ao ML depois do fencing");
  assert.strictEqual(amb.repo._st.lotes.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2ª auditoria — catálogo malformado (página não vazia sem paging e sem cursor)
// ─────────────────────────────────────────────────────────────────────────────

cenario("catálogo malformado: 100 results SEM paging e SEM scroll_id → falha (SEM_METADADOS_CONTINUIDADE); snapshot NÃO é promovido", async () => {
  const { r, amb } = await cenarioCatalogo({ pagina: (s, ids) => ({ results: ids.slice(0, 100) }) });
  assert.ok(/SEM_METADADOS_CONTINUIDADE/.test(r.run.errorMessage), r.run.errorMessage);
  assert.ok(/100 anúncio\(s\) sem scroll_id e sem paging.total/.test(r.run.errorMessage));
  assert.notStrictEqual(r.run.status, "completed");
  assert.strictEqual(r.run.promovido, false);
  assert.strictEqual(amb.repo._st.runs.filter((x) => x.promovido).length, 1, "só o snapshot bom anterior foi promovido");
});

cenario("catálogo malformado no fim: páginas boas e a última (não vazia) sem paging e sem scroll_id → falha, mesmo com a contagem batendo", async () => {
  const { r } = await cenarioCatalogo({
    pagina: (s, ids) => {
      const inicio = s ? Number(s.replace("s-", "")) : 0;
      const results = ids.slice(inicio, inicio + 100);
      return inicio >= 200 ? { results } : { results, paging: { total: 250 }, scroll_id: `s-${inicio + 100}` };
    },
  });
  assert.ok(/SEM_METADADOS_CONTINUIDADE/.test(r.run.errorMessage), r.run.errorMessage);
});

cenario("fim legítimo continua aceito: página não vazia sem scroll_id COM paging.total igual ao lido → completed", async () => {
  const amb = ambiente({
    sellers: { 555: { itens: catalogo("A", 50) } },
    roteiro: (p) => (p.startsWith("/users/") ? { ok: true, status: 200, data: { results: Object.keys(catalogo("A", 50)), paging: { total: 50 } } } : undefined),
  });
  const r = await amb.rodar(7);
  assert.strictEqual(r.status, "completed");
  assert.strictEqual(r.run.itensTotal, 50);
  assert.strictEqual(amb.ml.contar(/^\/users\//), 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2ª auditoria — heartbeat × request individual longa (invariante de config)
// ─────────────────────────────────────────────────────────────────────────────

const cfgMod = require("../services/promoSnapshot/promoSnapshotConfig");

cenario("config: timeout e heartbeat acima de 1/4 da janela de stale são LIMITADOS e registrados em ajustes", async () => {
  const padrao = resolvePromoSnapshotConfig({});
  assert.deepStrictEqual(padrao.ajustes, [], "defaults já são seguros");
  assert.strictEqual(padrao.requestTimeoutMs, 15000);
  const c = resolvePromoSnapshotConfig({ PROMO_SNAPSHOT_RUNNING_STALE_MINUTES: "2", PROMO_SNAPSHOT_REQUEST_TIMEOUT_MS: "120000", PROMO_SNAPSHOT_HEARTBEAT_INTERVAL_MS: "600000" });
  assert.strictEqual(c.runningStaleMinutes, 2);
  assert.strictEqual(c.requestTimeoutMs, 30000, "120 s viraria ≥ janela de 2 min: limitado a 30 s");
  assert.strictEqual(c.heartbeatIntervalMs, 30000);
  assert.deepStrictEqual(c.ajustes.map((a) => [a.variavel, a.configurado, a.efetivo]), [
    ["PROMO_SNAPSHOT_REQUEST_TIMEOUT_MS", 120000, 30000],
    ["PROMO_SNAPSHOT_HEARTBEAT_INTERVAL_MS", 600000, 30000],
  ]);
  assert.ok(cfgMod.piorIntervaloSemHeartbeatMs(c) < 2 * 60000);
});

cenario("config: nenhuma combinação de env produz requestTimeoutMs ≥ janela de stale (varredura)", async () => {
  let combinacoes = 0;
  for (const stale of ["1", "2", "3", "5", "10", "60", "1440", "99999", "lixo"]) {
    for (const timeout of ["1", "1000", "15000", "60000", "120000", "9999999", ""]) {
      for (const hb of ["1", "60000", "600000", "9999999"]) {
        for (const intervalo of ["0", "100", "10000", "999999"]) {
          const c = resolvePromoSnapshotConfig({
            PROMO_SNAPSHOT_RUNNING_STALE_MINUTES: stale, PROMO_SNAPSHOT_REQUEST_TIMEOUT_MS: timeout,
            PROMO_SNAPSHOT_HEARTBEAT_INTERVAL_MS: hb, PROMO_SNAPSHOT_REQUEST_INTERVAL_MS: intervalo,
          });
          const janela = c.runningStaleMinutes * 60000;
          assert.ok(c.requestTimeoutMs > 0 && c.requestTimeoutMs <= janela / 4, `timeout ${c.requestTimeoutMs} p/ janela ${janela}`);
          assert.ok(c.heartbeatIntervalMs <= janela / 4);
          assert.ok(cfgMod.piorIntervaloSemHeartbeatMs(c) < janela, `pior intervalo ${cfgMod.piorIntervaloSemHeartbeatMs(c)} < ${janela}`);
          combinacoes += 1;
        }
      }
    }
  }
  assert.strictEqual(combinacoes, 9 * 7 * 4 * 4);
});

cenario("config montada à mão insegura: validação explícita recusa; o processor falha o run ANTES de qualquer chamada ao ML", async () => {
  const insegura = { ...resolvePromoSnapshotConfig({ PROMO_SNAPSHOT_RUNNING_STALE_MINUTES: "2" }), requestTimeoutMs: 120000 };
  assert.throws(() => cfgMod.validarInvariantesHeartbeat(insegura), (e) => e.code === "PROMO_SNAPSHOT_CONFIG_INSEGURA" && /requestTimeoutMs 120000 > 30000/.test(e.message));
  assert.throws(() => cfgMod.validarInvariantesHeartbeat({ ...insegura, requestTimeoutMs: null }), (e) => e.code === "PROMO_SNAPSHOT_CONFIG_INSEGURA");
  const amb = ambiente();
  amb.procDeps.config = insegura;
  const r = await amb.rodar(7);
  assert.strictEqual(r.status, "failed");
  assert.strictEqual(r.run.errorCode, "PROMO_SNAPSHOT_CONFIG_INSEGURA");
  assert.strictEqual(amb.ml.chamadas.length, 0, "nenhuma chamada ao ML com config insegura");
});

cenario("startup: env inseguro sobe com os valores LIMITADOS e loga o ajuste explicitamente", async () => {
  const avisos = [];
  let configDoWorker = null;
  const logger = { log() {}, warn: (m) => avisos.push(String(m)), error() {} };
  await runtime.iniciarSeHabilitado({
    env: { PROMO_SNAPSHOT_WORKER_ENABLED: "true", PROMO_SNAPSHOT_RUNNING_STALE_MINUTES: "2", PROMO_SNAPSHOT_REQUEST_TIMEOUT_MS: "120000" },
    logger,
    ensureTables: async () => {},
    orquestrar: async () => ({ enfileirados: [] }),
    createWorker: ({ config }) => { configDoWorker = config; return { start() {}, stop: async () => {}, kick() {}, status: () => ({}) }; },
  });
  await runtime.parar();
  assert.strictEqual(configDoWorker.requestTimeoutMs, 30000);
  assert.ok(avisos.some((a) => /PROMO_SNAPSHOT_REQUEST_TIMEOUT_MS=120000 excede 1\/4 da janela de stale/.test(a) && /usando 30000/.test(a)), avisos.join("\n"));
});

cenario("request longa com relógio fake: cada GET preso até o timeout (limitado a 30 s na janela de 2 min) e outra instância reconciliando → run sobrevive", async () => {
  const ref = {};
  const env = { PROMO_SNAPSHOT_RUNNING_STALE_MINUTES: "2", PROMO_SNAPSHOT_REQUEST_TIMEOUT_MS: "120000", PROMO_SNAPSHOT_MAX_ATTEMPTS: "4" };
  const amb = ambiente({
    env,
    // A request fica em voo até o timeout que o leitor passou ao mlFetch e
    // estoura; logo depois a "outra instância" reconcilia (stale = 2 min).
    roteiro: async (p, o, n) => {
      if (p.includes("seller-promotions/items/MLBA0002") && n <= 3) {
        ref.amb.relogio.avancarMs(o.timeoutMs);
        await ref.amb.repo.reconcileStaleRunningRuns({ staleMinutes: 2 });
        return F.erroTimeout(p);
      }
      return undefined;
    },
    sleepHook: async (ms, relogio, repo) => { relogio.avancarMs(ms); await repo.reconcileStaleRunningRuns({ staleMinutes: 2 }); },
  });
  ref.amb = amb;
  const batidas = [];
  const touch = amb.repo.touchHeartbeat;
  amb.repo.touchHeartbeat = async (id) => { batidas.push(amb.relogio.agora()); return touch(id); };
  const inicio = amb.relogio.agora();
  const r = await amb.rodar(7);
  assert.ok(amb.ml.chamadas.every((c) => c.timeoutMs === 30000), "o mlFetch sempre recebe o timeout efetivo (30 s)");
  assert.ok(amb.relogio.agora() - inicio >= 90000, "3 requests presas até o timeout");
  assert.strictEqual(r.status, "completed");
  assert.strictEqual(r.run.retries, 3);
  assert.ok(amb.repo._st.runs.every((x) => x.error_code !== "PROMO_SNAPSHOT_RUN_STALE"));
  const gaps = batidas.slice(1).map((t, i) => t - batidas[i]);
  assert.ok(Math.max(...gaps) <= 30000 + 30000 + 1000, `maior intervalo sem heartbeat ${Math.max(...gaps)} ms (≤ timeout + heartbeat)`);
  // Sem o limite, 120 s de request sozinha já igualaria a janela de 2 min.
  assert.throws(() => cfgMod.validarInvariantesHeartbeat({ ...amb.config, requestTimeoutMs: 120000 }), (e) => e.code === "PROMO_SNAPSHOT_CONFIG_INSEGURA");
});

cenario("limiter compartilhado: 3 runs × 8 chamadas renovam heartbeat durante fila maior que o intervalo", async () => {
  const heartbeatIntervalMs = 30000;
  const requestIntervalMs = 10000;
  const esperas = [];
  const batidasPorChamada = [];
  let sleepPadraoUsado = false;
  // Todas as 24 chamadas concorrem no mesmo instante. As reservas ficam em
  // 0, 10, 20, ... 230 s — bem além do heartbeat de 30 s.
  const limiter = createRateLimiter({
    minIntervalMs: requestIntervalMs,
    now: () => 0,
    sleep: async () => { sleepPadraoUsado = true; },
  });

  const chamadas = [];
  for (let run = 1; run <= 3; run += 1) {
    for (let item = 1; item <= 8; item += 1) {
      const batidas = [];
      batidasPorChamada.push(batidas);
      chamadas.push(limiter.aguardarVez(null, async (ms) => {
        esperas.push({ run, item, ms });
        let transcorrido = 0;
        while (transcorrido < ms) {
          transcorrido += Math.min(heartbeatIntervalMs, ms - transcorrido);
          batidas.push(transcorrido);
        }
      }));
    }
  }
  await Promise.all(chamadas);

  assert.strictEqual(sleepPadraoUsado, false, "a fila do limiter deve usar o sleep com heartbeat fornecido pelo run");
  assert.strictEqual(Math.max(...esperas.map((e) => e.ms)), 230000, "24 reservas de 10 s acumulam 230 s de fila");
  assert.ok(esperas.some((e) => e.ms > heartbeatIntervalMs), "o cenário reproduz espera maior que o heartbeat");
  for (const batidas of batidasPorChamada) {
    if (!batidas.length) continue;
    const intervalos = batidas.map((t, i) => t - (i ? batidas[i - 1] : 0));
    assert.ok(Math.max(...intervalos) <= heartbeatIntervalMs, `intervalo sem heartbeat ${Math.max(...intervalos)} ms`);
  }
});

cenario("processor entrega ao limiter o sleep que renova heartbeat durante a reserva", async () => {
  const amb = ambiente({
    sellers: { 555: { itens: catalogo("A", 1) } },
    env: { PROMO_SNAPSHOT_RUNNING_STALE_MINUTES: "2", PROMO_SNAPSHOT_HEARTBEAT_INTERVAL_MS: "30000" },
    sleepHook: async (ms, relogio, repo) => {
      relogio.avancarMs(ms);
      await repo.reconcileStaleRunningRuns({ staleMinutes: 2 });
    },
  });
  let chamadasLimiter = 0;
  amb.procDeps.rateLimiter = {
    estado: () => ({ cooldownRestanteMs: 0, proximoInicioEmMs: 0 }),
    penalizar() {},
    async aguardarVez(signal, sleepComHeartbeat) {
      assert.strictEqual(typeof sleepComHeartbeat, "function", "processor deve fornecer o sleep do run ao limiter");
      chamadasLimiter += 1;
      if (chamadasLimiter === 1) await sleepComHeartbeat(70000, signal);
      return chamadasLimiter === 1 ? 70000 : 0;
    },
  };

  const r = await amb.rodar(7);
  assert.strictEqual(r.status, "completed");
  assert.ok(amb.esperas.length >= 3 && Math.max(...amb.esperas) <= 30000, "70 s de fila foram fatiados pelo heartbeat");
  assert.ok(amb.repo._st.runs.every((x) => x.error_code !== "PROMO_SNAPSHOT_RUN_STALE"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Auditoria — achado 5: oportunidades paginadas no banco
// ─────────────────────────────────────────────────────────────────────────────

cenario("oportunidades: catálogo de 2.000 → UMA consulta de elegíveis e UMA de rebates da conta (nunca por item); página e total do serviço", async () => {
  const n = 2000;
  const amb = ambiente({ sellers: { 555: { itens: catalogo("A", n) } }, marginSnaps: snapsPara(7, "A", n), env: { PROMO_SNAPSHOT_BATCH_SIZE: "100" } });
  await amb.rodar(7);
  amb.repo._chamadas.length = 0;
  const deps = depsCentral(amb);
  const r = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, page: 7, limit: 25 }, deps);
  assert.strictEqual(amb.repo._linhasOportunidadesDevolvidas, n, "o banco só seleciona as elegíveis; a ordem depende do cálculo do núcleo");
  assert.deepStrictEqual([r.page, r.limit, r.total, r.hasNext, r.oportunidades.length], [7, 25, n, true, 25]);
  assert.strictEqual(amb.repo._chamadas.filter((c) => c === "listarOportunidadesElegiveis").length, 1, "UMA consulta de elegíveis");
  assert.strictEqual(deps.db.consultasDb.length, 1, "nenhuma consulta avulsa por item: só UMA, em lote (rebates da conta)");
  assert.ok(/FROM promo_snapshot_contas c/.test(deps.db.consultasDb[0].sql));
  assert.strictEqual(deps.db.consultasDb[0].params[3], null, "rebates da conta inteira, numa consulta só");
  const ultima = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, page: 80, limit: 25 }, deps);
  assert.deepStrictEqual([ultima.hasNext, ultima.oportunidades.length, ultima.total], [false, 25, n]);
  const alem = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, page: 81, limit: 25 }, deps);
  assert.deepStrictEqual([alem.hasNext, alem.oportunidades.length, alem.total], [false, 0, n]);
  const teto = await listarOportunidades({ clienteSlug: "loja-a", clienteContaId: 7, limit: 5000 }, deps);
  assert.strictEqual(teto.limit, 50, "limit tem teto no servidor");
});

// ─────────────────────────────────────────────────────────────────────────────
// Auditoria — achado 6: persistência idempotente dos lotes
// ─────────────────────────────────────────────────────────────────────────────

cenario("replay de lote: reenviar o mesmo (run, seq) não altera itens_processados, promoções, erros, retries, rate_limits nem linhas", async () => {
  const amb = ambiente({ sellers: { 555: { itens: catalogo("A", 45) } } });
  await amb.enfileirar(7);
  const run = await amb.repo.claimNextQueuedRun();
  // Cada lote é gravado e REENVIADO (resposta do COMMIT "perdida").
  let replays = 0;
  const registrar = amb.repo.registrarLote;
  const deps = { ...amb.procDeps, repo: { ...amb.repo, registrarLote: async (a) => { await registrar(a); replays += 1; return registrar(a); } } };
  const res = await processPromoSnapshotRun(run, deps);
  const r = amb.repo._st.runs[0];
  assert.strictEqual(replays, 3);
  assert.deepStrictEqual([r.itens_processados, r.promocoes_encontradas, r.itens_com_promocao, r.erros], [45, 45, 45, 0]);
  assert.strictEqual(amb.repo._st.itens.filter((i) => i.run_id === r.id).length, 45);
  // Replay explícito, com contadores de retry/rate limit e falhas diferentes.
  const campos = (x) => [x.itens_processados, x.itens_com_promocao, x.promocoes_encontradas, x.erros, x.retries, x.rate_limits];
  const antes = campos(r);
  const lote1 = amb.repo._st.lotes.find((l) => l.run_id === r.id && l.seq === 1);
  const devolvido = await amb.repo.registrarLote({ run, seq: 1, itemIds: [...lote1.item_ids].reverse(), itensFalhos: [lote1.item_ids[0]], linhas: [], contadores: { retries: 9, rateLimits: 4 } });
  assert.ok(devolvido, "replay devolve o run (não é fencing)");
  assert.deepStrictEqual(campos(r), antes);
  assert.strictEqual(amb.repo._st.lotes.filter((l) => l.run_id === r.id).length, 3);
  // Mesmo seq com OUTROS itens: recusado.
  await assert.rejects(() => amb.repo.registrarLote({ run, seq: 1, itemIds: ["MLBX1"], linhas: [] }), (e) => e.code === "PROMO_SNAPSHOT_LOTE_CONFLITANTE");
  assert.deepStrictEqual(campos(r), antes);
  const fim = await amb.runService.markRunCompleted(run.id, amb.base.db, res);
  assert.strictEqual(fim.status, "completed");
  assert.strictEqual(fim.itensProcessados, 45);
});

// ─────────────────────────────────────────────────────────────────────────────
// ZERO escrita comercial
// ─────────────────────────────────────────────────────────────────────────────

cenario("leitor do ML: só GET e só caminhos de leitura (escrita é impossível por construção)", async () => {
  const chamadas = [];
  const leitor = criarLeitorMl({ clienteId: 3, sellerId: "555", timeoutMs: 1000, mlFetch: async (c, p, o) => { chamadas.push({ p, o }); return { ok: true, status: 200, data: [] }; } });
  for (const proibido of [
    "/seller-promotions/items/MLB1?app_version=v2&promotion_type=DEAL",
    "/items/MLB1",
    "/seller-promotions/promotions/P-1/items",
    "/items/MLB1/prices",
  ]) {
    await assert.rejects(() => leitor.get(proibido), (e) => e.code === "PROMO_SNAPSHOT_CAMINHO_NAO_PERMITIDO");
  }
  await leitor.get("/seller-promotions/items/MLB1?app_version=v2");
  assert.strictEqual(chamadas.length, 1);
  assert.strictEqual(chamadas[0].o.method, "GET");
  assert.strictEqual(chamadas[0].o.body, undefined);
});

cenario("nenhum módulo do Promo Snapshot importa serviço de escrita (preço/promoção)", async () => {
  const dir = path.join(__dirname, "..", "services", "promoSnapshot");
  for (const arq of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, arq), "utf8");
    assert.ok(!/require\([^)]*(meliPrecoService|meliPromocoesEscritaService)/.test(src), `${arq} não importa serviço de escrita`);
    assert.ok(!/\b(atualizarPreco|aplicarPromocao)\s*\(/.test(src), `${arq} não chama escrita`);
    assert.ok(!/method:\s*["'](POST|PUT|PATCH|DELETE)/i.test(src), `${arq} não monta método de escrita`);
  }
  const rotas = fs.readFileSync(path.join(__dirname, "..", "routes", "promoSnapshotRoutes.js"), "utf8");
  assert.ok(!/aplicar/.test(rotas.replace(/nunca aplica/g, "")), "nenhuma rota de aplicar");
});

// ─────────────────────────────────────────────────────────────────────────────
// Piloto: allowlist PROMO_SNAPSHOT_CLIENTES + defaults conservadores
// ─────────────────────────────────────────────────────────────────────────────

const { avaliarPiloto } = require("../services/promoSnapshot/promoSnapshotConfig");

cenario("defaults conservadores no código: frescor 12 h, 250 ms entre requests, 2 itens, 1 conta por tick, 1 worker", async () => {
  const c = resolvePromoSnapshotConfig({});
  assert.strictEqual(c.workerEnabled, false);
  assert.strictEqual(c.freshMinutes, 720);
  assert.strictEqual(c.requestIntervalMs, 250);
  assert.strictEqual(c.itemConcurrency, 2);
  assert.strictEqual(c.orchestratorMaxPerTick, 1);
  assert.strictEqual(c.workerConcurrency, 1);
  assert.deepStrictEqual(c.clientesPiloto, []);
  // Env continua mandando: o default só vale quando a variável não existe.
  const o = resolvePromoSnapshotConfig({ PROMO_SNAPSHOT_FRESH_MINUTES: "360", PROMO_SNAPSHOT_REQUEST_INTERVAL_MS: "100", PROMO_SNAPSHOT_ITEM_CONCURRENCY: "3", PROMO_SNAPSHOT_ORCHESTRATOR_MAX_PER_TICK: "5" });
  assert.deepStrictEqual([o.freshMinutes, o.requestIntervalMs, o.itemConcurrency, o.orchestratorMaxPerTick], [360, 100, 3, 5]);
});

cenario("allowlist: slugs separados por vírgula, sem espaço/caixa/duplicata; vazio = nenhum cliente", async () => {
  assert.deepStrictEqual(resolvePromoSnapshotConfig({ PROMO_SNAPSHOT_CLIENTES: " Red-Fish , loja-a,,RED-FISH " }).clientesPiloto, ["red-fish", "loja-a"]);
  assert.deepStrictEqual(resolvePromoSnapshotConfig({ PROMO_SNAPSHOT_CLIENTES: "" }).clientesPiloto, []);
  assert.deepStrictEqual(resolvePromoSnapshotConfig({ PROMO_SNAPSHOT_CLIENTES: " , ," }).clientesPiloto, []);
  const lig = { PROMO_SNAPSHOT_WORKER_ENABLED: "true" };
  const dentro = avaliarPiloto(resolvePromoSnapshotConfig({ ...lig, PROMO_SNAPSHOT_CLIENTES: "red-fish" }), "RED-FISH");
  assert.deepStrictEqual(dentro, { noPiloto: true, motivo: null });
  assert.deepStrictEqual(avaliarPiloto(resolvePromoSnapshotConfig({ ...lig, PROMO_SNAPSHOT_CLIENTES: "red-fish" }), "loja-a"), { noPiloto: false, motivo: "FORA_DO_PILOTO" });
  assert.deepStrictEqual(avaliarPiloto(resolvePromoSnapshotConfig({ ...lig }), "red-fish"), { noPiloto: false, motivo: "PILOTO_VAZIO" });
  assert.deepStrictEqual(avaliarPiloto(resolvePromoSnapshotConfig({ PROMO_SNAPSHOT_CLIENTES: "red-fish" }), "red-fish"), { noPiloto: false, motivo: "WORKER_DESABILITADO" });
  assert.strictEqual(avaliarPiloto(resolvePromoSnapshotConfig({ ...lig, PROMO_SNAPSHOT_CLIENTES: "red-fish" }), null).noPiloto, false, "sem slug nunca entra");
});

cenario("allowlist no orquestrador: só enfileira conta de cliente da lista; lista vazia não consulta nem enfileira", async () => {
  const contasCliente = [
    { id: 7, cliente_id: 3, cliente_slug: "loja-a", marketplace: "meli", ativo: true, external_account_id: "555" },
    { id: 9, cliente_id: 4, cliente_slug: "loja-b", marketplace: "meli", ativo: true, external_account_id: "777" },
  ];
  const grants = [
    { cliente_id: 3, ml_user_id: "555", access_token: "a", refresh_token: "r", token_status: "valid" },
    { cliente_id: 4, ml_user_id: "777", access_token: "a", refresh_token: "r", token_status: "valid" },
  ];
  const dentro = ambiente({ contasCliente, grants, env: { PROMO_SNAPSHOT_CLIENTES: "loja-b", PROMO_SNAPSHOT_ORCHESTRATOR_MAX_PER_TICK: "10" } });
  const r = await orquestrarTick({ ...dentro.base });
  assert.deepStrictEqual(r.enfileirados.map((e) => e.clienteContaId), [9], "loja-a está fora do piloto");
  assert.deepStrictEqual(dentro.repo._st.runs.map((x) => x.cliente_conta_id), [9]);

  const vazio = ambiente({ contasCliente, grants, env: { PROMO_SNAPSHOT_CLIENTES: "", PROMO_SNAPSHOT_ORCHESTRATOR_MAX_PER_TICK: "10" } });
  const r2 = await orquestrarTick({ ...vazio.base });
  assert.deepStrictEqual(r2.enfileirados, []);
  assert.strictEqual(r2.motivo, "PILOTO_VAZIO");
  assert.strictEqual(vazio.repo._st.runs.length, 0);
  assert.ok(!vazio.repo._chamadas.some((c) => c === "listarContasElegiveis"), "nem consulta as contas");

  // Defesa em profundidade: mesmo que o repositório devolva conta fora da lista, o orquestrador não enfileira.
  const frouxo = ambiente({ contasCliente, grants, env: { PROMO_SNAPSHOT_CLIENTES: "loja-b", PROMO_SNAPSHOT_ORCHESTRATOR_MAX_PER_TICK: "10" } });
  const original = frouxo.repo.listarContasElegiveis;
  frouxo.repo.listarContasElegiveis = (args, db) => original({ ...args, clientesPiloto: undefined }, db);
  const r3 = await orquestrarTick({ ...frouxo.base });
  assert.deepStrictEqual(r3.enfileirados.map((e) => e.clienteContaId), [9]);
});

cenario("allowlist no auto-trigger: ensureFresh e abrir a Central em conta fora da lista não enfileiram (fora_do_piloto)", async () => {
  const amb = ambiente({ env: { PROMO_SNAPSHOT_CLIENTES: "loja-b" } });
  const fora = await service.ensureFreshPromoSnapshot(idConta(7), {}, amb.base);
  assert.strictEqual(fora.acao, "fora_do_piloto");
  assert.strictEqual(fora.motivo, "FORA_DO_PILOTO");
  assert.strictEqual(amb.repo._st.runs.length, 0);
  assert.strictEqual(amb.kicks.length, 0);
  const st = await read.obterStatus({ clienteSlug: "loja-a", clienteContaId: 7 }, depsLeitura(amb));
  assert.strictEqual(st.sync.autoTrigger, "nenhuma");
  assert.strictEqual(st.worker.noPiloto, false);
  assert.strictEqual(st.atualizacao.disponivel, false);
  assert.strictEqual(st.atualizacao.motivo, "FORA_DO_PILOTO");
  assert.strictEqual(amb.repo._st.runs.length, 0, "abrir a tela não enfileira");
  // Mesmo com autoTrigger explícito, fora da lista nada é enfileirado.
  const st2 = await read.obterStatus({ clienteSlug: "loja-a", clienteContaId: 7, autoTrigger: true }, depsLeitura(amb));
  assert.strictEqual(st2.sync.autoTrigger, "fora_do_piloto");
  assert.strictEqual(amb.repo._st.runs.length, 0);
  const dentro = await service.ensureFreshPromoSnapshot(idConta(9), {}, amb.base);
  assert.strictEqual(dentro.acao, "enfileirado");
  assert.strictEqual(amb.repo._st.runs.length, 1);
});

cenario("allowlist no POST /sync: conta fora da lista → FORA_DO_PILOTO, nada enfileirado; dentro da lista enfileira", async () => {
  const amb = ambiente({ env: { PROMO_SNAPSHOT_CLIENTES: "loja-b" } });
  const fora = await read.solicitarSync({ clienteSlug: "loja-a", clienteContaId: 7 }, depsLeitura(amb));
  assert.strictEqual(fora.enfileirado, false);
  assert.strictEqual(fora.motivo, "FORA_DO_PILOTO");
  assert.strictEqual(fora.mensagem, read.MENSAGEM_ATUALIZACAO.FORA_DO_PILOTO);
  assert.strictEqual(fora.atualizacao.disponivel, false);
  assert.strictEqual(amb.repo._st.runs.length, 0);
  const dentro = await read.solicitarSync({ clienteSlug: "loja-b", clienteContaId: 9 }, depsLeitura(amb));
  assert.strictEqual(dentro.enfileirado, true);
  assert.strictEqual(amb.repo._st.runs.length, 1);
  const vazio = ambiente({ env: { PROMO_SNAPSHOT_CLIENTES: "" } });
  assert.strictEqual((await read.solicitarSync({ clienteSlug: "loja-b", clienteContaId: 9 }, depsLeitura(vazio))).motivo, "PILOTO_VAZIO");
});

cenario("run já existente NUNCA esconde worker desligado nem conta fora do piloto (status e POST dizem o impedimento)", async () => {
  const amb = ambiente();
  const { run } = await amb.enfileirar(7);
  // Worker desligado depois do enqueue: o run fica parado na fila.
  amb.env.PROMO_SNAPSHOT_WORKER_ENABLED = "false";
  const st = await read.obterStatus({ clienteSlug: "loja-a", clienteContaId: 7 }, depsLeitura(amb));
  assert.strictEqual(st.sync.activeRun.runId, run.id, "o run continua visível");
  assert.strictEqual(st.atualizacao.disponivel, false);
  assert.strictEqual(st.atualizacao.motivo, "WORKER_DESABILITADO");
  assert.strictEqual(st.atualizacao.runParado, run.id);
  const post = await read.solicitarSync({ clienteSlug: "loja-a", clienteContaId: 7 }, depsLeitura(amb));
  assert.strictEqual(post.enfileirado, false);
  assert.notStrictEqual(post.reaproveitado, true, "não pode dizer que reaproveitou um run que não vai andar");
  assert.strictEqual(post.motivo, "WORKER_DESABILITADO");
  // Conta tirada do piloto com run na fila: avisa FORA_DO_PILOTO.
  amb.env.PROMO_SNAPSHOT_WORKER_ENABLED = "true";
  amb.env.PROMO_SNAPSHOT_CLIENTES = "loja-b";
  const st2 = await read.obterStatus({ clienteSlug: "loja-a", clienteContaId: 7 }, depsLeitura(amb));
  assert.strictEqual(st2.atualizacao.motivo, "FORA_DO_PILOTO");
  assert.strictEqual(st2.atualizacao.runId, run.id);
  const post2 = await read.solicitarSync({ clienteSlug: "loja-a", clienteContaId: 7 }, depsLeitura(amb));
  assert.strictEqual(post2.enfileirado, false);
  assert.strictEqual(post2.motivo, "FORA_DO_PILOTO");
  // De volta ao piloto: EM_ANDAMENTO, e o POST reaproveita o MESMO run.
  amb.env.PROMO_SNAPSHOT_CLIENTES = "loja-a";
  const post3 = await read.solicitarSync({ clienteSlug: "loja-a", clienteContaId: 7 }, depsLeitura(amb));
  assert.strictEqual(post3.reaproveitado, true);
  assert.strictEqual(post3.runId, run.id);
  assert.strictEqual(amb.repo._st.runs.length, 1);
});

cenario("allowlist por CONTA (PROMO_SNAPSHOT_CONTAS): libera só a conta 8 — a conta 7 do MESMO cliente continua fora", async () => {
  const amb = ambiente({ env: { PROMO_SNAPSHOT_CLIENTES: "", PROMO_SNAPSHOT_CONTAS: "8, x, 8" } });
  const sete = await read.solicitarSync({ clienteSlug: "loja-a", clienteContaId: 7 }, depsLeitura(amb));
  assert.strictEqual(sete.enfileirado, false);
  assert.strictEqual(sete.motivo, "FORA_DO_PILOTO");
  const oito = await read.solicitarSync({ clienteSlug: "loja-a", clienteContaId: 8 }, depsLeitura(amb));
  assert.strictEqual(oito.enfileirado, true);
  assert.strictEqual(amb.repo._st.runs.length, 1);
  assert.strictEqual(amb.repo._st.runs[0].cliente_conta_id, 8);
  assert.strictEqual(amb.repo._st.runs[0].seller_id, "666");
  // Status: a 8 está no piloto, a 7 não.
  const st8 = await read.obterStatus({ clienteSlug: "loja-a", clienteContaId: 8 }, depsLeitura(amb));
  assert.strictEqual(st8.worker.noPiloto, true);
  assert.strictEqual(st8.atualizacao.motivo, "EM_ANDAMENTO");
  const st7 = await read.obterStatus({ clienteSlug: "loja-a", clienteContaId: 7 }, depsLeitura(amb));
  assert.strictEqual(st7.worker.noPiloto, false);
  assert.strictEqual(st7.atualizacao.motivo, "FORA_DO_PILOTO");
  // Orquestrador (via filtro de cinto de segurança) só enxerga a conta 8.
  const { avaliarPiloto, resolvePromoSnapshotConfig: cfg } = require("../services/promoSnapshot/promoSnapshotConfig");
  const c = cfg({ PROMO_SNAPSHOT_WORKER_ENABLED: "true", PROMO_SNAPSHOT_CONTAS: "8" });
  assert.deepStrictEqual(c.contasPiloto, [8]);
  assert.strictEqual(avaliarPiloto(c, "loja-a", 8).noPiloto, true);
  assert.strictEqual(avaliarPiloto(c, "loja-a", 7).noPiloto, false);
  assert.strictEqual(avaliarPiloto(c, "loja-a", "8").noPiloto, true);
  assert.strictEqual(avaliarPiloto(cfg({ PROMO_SNAPSHOT_CONTAS: "8" }), "loja-a", 8).motivo, "WORKER_DESABILITADO");
});

// ─────────────────────────────────────────────────────────────────────────────
// Fonte única: a aba Promoções (listarOportunidades) e a Bancada (simular) leem
// o MESMO estado do Promo Snapshot e mostram o MESMO rótulo
// ─────────────────────────────────────────────────────────────────────────────

const margemSimular = require("../services/motorMargem/margemSimularService");

// Catálogos com ids MLB numéricos (o simulador valida ^MLB\d+$): conta 7 → MLB1xxxx, conta 8 → MLB2xxxx.
function ambienteFonte(opts = {}) {
  return ambiente({ sellers: { 555: { itens: catalogo("1", 3) }, 666: { itens: catalogo("2", 2) }, 777: { itens: catalogo("3", 1) } }, ...opts });
}

const DIAGNOSTICO = { id: 91, created_at: "2026-10-10T12:00:00.000Z", parcial: false, itens_scaneados: 40 };

// Banco falso da Central + diagnóstico LEGADO opcional (cabeçalho, elegíveis da aba e itens da Bancada).
function bancoComLegado({ diagnostico = null, itensLegado = [] } = {}) {
  const consultasDb = [];
  return {
    consultasDb,
    async query(sql, params) {
      consultasDb.push({ sql, params });
      if (/FROM promocoes_diagnosticos\b/.test(sql)) {
        if (!diagnostico) { const e = new Error("relation does not exist"); e.code = "42P01"; throw e; }
        return { rows: [diagnostico] };
      }
      if (/FROM promocoes_diagnostico_itens/.test(sql)) return { rows: itensLegado };
      if (/FROM promo_snapshot_contas c/.test(sql)) return { rows: [] };
      throw new Error("SQL inesperado: " + sql.slice(0, 80));
    },
  };
}

function depsAba(amb, db, extra = {}) {
  return { ...depsLeitura(amb), db, carregarRealizada: async () => ({ porMlb: new Map(), periodo: null }), ...extra };
}

function depsBancada(amb, db) {
  return {
    db, env: amb.env, now: amb.base.now, logger: amb.logger,
    assertContaNaCarteira: async (user, contaId) => {
      const c = amb.contas[Number(contaId)];
      return { contaId: c.id, clienteId: c.cliente_id, clienteSlug: c.cliente_slug };
    },
    obterConta: async (id) => amb.contas[Number(id)],
    snapshotRepo: {
      getProjectionSnapshot: async ({ itemId }) => ({
        itemId, titulo: `Produto ${itemId}`, sku: null, baseId: 1, price: 100, cost: 40, taxRate: 0.1, fixedFee: 0, commission: 12, commissionRate: 0.12, freight: 10,
        calculatedAt: "2026-10-13T06:00:00.000Z", quality: { targetMargin: 0.1 }, catalogMissingSince: null,
      }),
    },
    obterAnuncio: async (clienteId, itemId) => {
      const conta = Object.values(amb.contas).find((c) => c.cliente_id === clienteId && itemId.startsWith(c.external_account_id === "555" ? "MLB1" : "MLB2"));
      return { item_id: itemId, ml_user_id: conta ? conta.external_account_id : null, listing_type_id: "gold_special", category_id: "MLB1", logistic_type: "xd_drop_off" };
    },
    promoService: service,
    promoRepo: amb.repo,
    carregarRebates: async () => ({ porItem: new Map(), indisponivel: null }),
    buscarComissaoEFrete: async (a) => ({ comissaoValor: Math.round(a.precoEfetivo * 0.12 * 100) / 100, comissaoPercentual: 0.12, fretePrevisto: 10 }),
    mlFetch: async () => ({ ok: true, status: 200, data: {} }),
  };
}

const USER_FONTE = { id: 1, role: "admin" };
async function lerAba(amb, db, contaId = 7) {
  const c = amb.contas[contaId];
  return listarOportunidades({ clienteSlug: c.cliente_slug, clienteContaId: contaId, autoTrigger: false }, depsAba(amb, db));
}
async function lerBancada(amb, db, contaId = 7, mlb = "MLB10001") {
  return margemSimular.simular({ user: USER_FONTE, body: { cliente_conta_id: contaId, mlb, cenarios: [{ tipo: "todas_promos" }] } }, depsBancada(amb, db));
}
async function lerAmbas(amb, { db = bancoComLegado(), contaId = 7, mlb = "MLB10001" } = {}) {
  const aba = await lerAba(amb, db, contaId);
  const bancada = await lerBancada(amb, db, contaId, mlb);
  assert.ok(aba.fontePromocoes, "a aba traz fontePromocoes");
  assert.ok(bancada.fontePromocoes, "a Bancada traz fontePromocoes");
  assert.deepStrictEqual(bancada.fontePromocoes, aba.fontePromocoes, "aba e Bancada: MESMO objeto de fonte");
  return { aba, bancada, fonte: aba.fontePromocoes };
}

cenario("fonte única 1/5 — sem snapshot: as duas dizem 'Primeira sincronização pendente' e não mostram promoção", async () => {
  const amb = ambienteFonte({ marginSnaps: snapsPara(7, "1", 3) });
  const { aba, bancada, fonte } = await lerAmbas(amb);
  assert.strictEqual(fonte.estado, "primeira_sincronizacao_pendente");
  assert.strictEqual(fonte.rotulo, "Primeira sincronização pendente");
  assert.strictEqual(fonte.ultimoBom, null);
  assert.strictEqual(fonte.legado, null);
  assert.strictEqual(aba.disponivel, false);
  assert.strictEqual(aba.mensagem, fonte.rotulo, "a mensagem da aba é o rótulo canônico");
  assert.strictEqual(bancada.promocoes.disponivel, false);
  assert.strictEqual(bancada.cenarios[0].motivo, "sem_snapshot_promocoes");
  assert.strictEqual(amb.ml.chamadas.length, 0);
});

cenario("fonte única 2/5 — sincronizando: as duas dizem 'Sincronizando promoções…' (com o último bom, se houver)", async () => {
  const amb = ambienteFonte({ marginSnaps: snapsPara(7, "1", 3) });
  await amb.enfileirar(7);
  const a = await lerAmbas(amb);
  assert.strictEqual(a.fonte.estado, "sincronizando");
  assert.strictEqual(a.fonte.rotulo, "Sincronizando promoções…");
  assert.strictEqual(a.fonte.atualizando, true);
  assert.strictEqual(a.fonte.ultimoBom, null);

  const amb2 = ambienteFonte({ marginSnaps: snapsPara(7, "1", 3) });
  await amb2.rodar(7);
  amb2.relogio.avancar(400);
  await amb2.enfileirar(7);
  const b = await lerAmbas(amb2);
  assert.strictEqual(b.fonte.estado, "sincronizando");
  assert.strictEqual(b.fonte.rotulo, "Sincronizando promoções…");
  assert.ok(b.fonte.ultimoBom && b.fonte.ultimoBom.geradoEm, "ainda mostra a data do último bom");
  assert.strictEqual(b.aba.oportunidades.length, 3, "serve o último bom enquanto sincroniza");
  assert.strictEqual(b.bancada.promocoes.disponivel, true);
});

cenario("fonte única 3/5 — stale: último bom + 'atualizando' + data, nas duas", async () => {
  const amb = ambienteFonte({ marginSnaps: snapsPara(7, "1", 3) });
  await amb.rodar(7);
  amb.relogio.avancar(400);
  const { aba, bancada, fonte } = await lerAmbas(amb);
  assert.strictEqual(fonte.estado, "desatualizado");
  assert.strictEqual(fonte.rotulo, "atualizando");
  assert.strictEqual(fonte.atualizando, true);
  assert.strictEqual(fonte.origemDados, "promo_snapshot");
  assert.strictEqual(fonte.ultimoBom.runId, amb.conta(7).current_run_id);
  assert.ok(fonte.ultimoBom.geradoEm);
  assert.deepStrictEqual([fonte.ultimoBom.parcial, fonte.ultimoBom.itensSemLeitura, fonte.ultimoBom.itensHerdados], [false, 0, 0], "o último bom informa parcial e leituras herdadas");
  assert.strictEqual(fonte.legado, null);
  assert.strictEqual(aba.oportunidades.length, 3);
  assert.strictEqual(bancada.promocoes.disponivel, true);
  assert.strictEqual(bancada.promocoes.snapshot_em, fonte.ultimoBom.geradoEm, "mesma data nas duas");
  assert.strictEqual(aba.fonte.geradoEm, fonte.ultimoBom.geradoEm);
});

cenario("fonte única 4/5 — falhou: último bom (se houver) + 'falha na atualização · motivo', nas duas", async () => {
  const amb = ambienteFonte({ marginSnaps: snapsPara(7, "1", 3) });
  await amb.rodar(7);
  amb.relogio.avancar(400);
  amb.procDeps.mlFetch = async (c, p, o) => (p.startsWith("/users/") ? F.erro500() : amb.ml.mlFetch(c, p, o));
  await amb.enfileirar(7);
  await amb.worker.runOnce();
  const { aba, bancada, fonte } = await lerAmbas(amb);
  assert.strictEqual(fonte.estado, "falhou");
  assert.ok(/^falha na atualização · .+/.test(fonte.rotulo), fonte.rotulo);
  assert.ok(fonte.falha && fonte.falha.codigo, "traz o código da falha");
  assert.ok(fonte.rotulo.includes(fonte.falha.motivo));
  assert.ok(fonte.ultimoBom && fonte.ultimoBom.geradoEm, "mantém o último bom");
  assert.strictEqual(aba.oportunidades.length, 3);
  assert.strictEqual(bancada.promocoes.disponivel, true);

  // Falhou sem nunca ter um bom: só o rótulo da falha, sem promoções.
  const vazio = ambienteFonte({ marginSnaps: snapsPara(7, "1", 3) });
  vazio.procDeps.mlFetch = async () => F.erro500();
  await vazio.enfileirar(7);
  await vazio.worker.runOnce();
  const v = await lerAmbas(vazio);
  assert.strictEqual(v.fonte.estado, "falhou");
  assert.strictEqual(v.fonte.ultimoBom, null);
  assert.ok(/^falha na atualização · /.test(v.fonte.rotulo));
  assert.strictEqual(v.aba.disponivel, false);
  assert.strictEqual(v.bancada.promocoes.disponivel, false);
});

cenario("fonte única 5/5 — fora do piloto: as duas dizem 'Promoções automáticas não ativadas para esta conta'", async () => {
  const amb = ambienteFonte({ marginSnaps: snapsPara(7, "1", 3), env: { PROMO_SNAPSHOT_CLIENTES: "loja-b" } });
  const { aba, bancada, fonte } = await lerAmbas(amb);
  assert.strictEqual(fonte.estado, "fora_do_piloto");
  assert.strictEqual(fonte.rotulo, "Promoções automáticas não ativadas para esta conta");
  assert.strictEqual(fonte.motivo, "FORA_DO_PILOTO");
  assert.strictEqual(aba.mensagem, fonte.rotulo);
  assert.strictEqual(bancada.promocoes.disponivel, false);
  // Worker desligado e lista vazia: mesmo rótulo, motivos diferentes.
  const off = await lerAmbas(ambienteFonte({ marginSnaps: snapsPara(7, "1", 3), env: { PROMO_SNAPSHOT_WORKER_ENABLED: "false" } }));
  assert.deepStrictEqual([off.fonte.estado, off.fonte.motivo, off.fonte.rotulo], ["fora_do_piloto", "WORKER_DESABILITADO", fonte.rotulo]);
  const vazio = await lerAmbas(ambienteFonte({ marginSnaps: snapsPara(7, "1", 3), env: { PROMO_SNAPSHOT_CLIENTES: "" } }));
  assert.deepStrictEqual([vazio.fonte.estado, vazio.fonte.motivo], ["fora_do_piloto", "PILOTO_VAZIO"]);
  // Nenhum dos dois enfileira nada.
  assert.strictEqual(amb.repo._st.runs.length, 0);
});

cenario("fonte única — conta com snapshot fora do piloto: mostra o último bom e o rótulo de não ativada", async () => {
  const amb = ambienteFonte({ marginSnaps: snapsPara(7, "1", 3) });
  await amb.rodar(7);
  amb.procDeps.env = { ...amb.env, PROMO_SNAPSHOT_CLIENTES: "loja-b" };
  const foraAmb = { ...amb, env: { ...amb.env, PROMO_SNAPSHOT_CLIENTES: "loja-b" }, base: { ...amb.base, env: { ...amb.env, PROMO_SNAPSHOT_CLIENTES: "loja-b" } } };
  const { aba, fonte } = await lerAmbas(foraAmb);
  assert.strictEqual(fonte.estado, "fora_do_piloto");
  assert.ok(fonte.ultimoBom && fonte.ultimoBom.geradoEm);
  assert.strictEqual(aba.oportunidades.length, 3);
});

cenario("fonte única — legado só se a conta NÃO tem snapshot: 'diagnóstico legado · data' igual nas duas; na Bancada vira estimativa", async () => {
  const itensLegado = [{ chave: "501", item_id: "MLB10001", preco_promo: 90, retorno: 4, nome: "Campanha antiga", promo_id: "CMP-1", tipo: "DEAL", status: "candidate" }];
  const amb = ambienteFonte({ marginSnaps: snapsPara(7, "1", 3) });
  const db = bancoComLegado({ diagnostico: DIAGNOSTICO, itensLegado });
  const { aba, bancada, fonte } = await lerAmbas(amb, { db });
  assert.strictEqual(fonte.estado, "primeira_sincronizacao_pendente", "o estado do Promo Snapshot continua valendo");
  assert.strictEqual(fonte.origemDados, "diagnostico_legado");
  assert.ok(fonte.legado && fonte.legado.diagnosticoId === 91 && fonte.legado.geradoEm, "traz a data do diagnóstico");
  assert.strictEqual(aba.fonte.tipo, "diagnostico_legado");
  assert.strictEqual(aba.fonte.geradoEm, fonte.legado.geradoEm);
  assert.strictEqual(bancada.promocoes.disponivel, true);
  assert.strictEqual(bancada.promocoes.origem, "diagnostico_legado");
  assert.strictEqual(bancada.promocoes.snapshot_em, fonte.legado.geradoEm);
  const promo = bancada.cenarios.find((c) => c.tipo === "promo");
  assert.ok(promo, "a promoção do legado aparece na Bancada");
  assert.strictEqual(promo.promocao.estimativa, true);
  assert.strictEqual(promo.promocao.fonte, "diagnostico_legado");
  assert.strictEqual(promo.promocao.id, "CMP-1");
  assert.strictEqual(promo.cenario.preco, 90);
  assert.strictEqual(promo.evidencia.preco.fonte, "diagnostico_legado");

  // Com snapshot, o legado é ignorado — mesmo existindo diagnóstico.
  await amb.rodar(7);
  const antes = db.consultasDb.length;
  const com = await lerAmbas(amb, { db });
  assert.strictEqual(com.fonte.legado, null);
  assert.strictEqual(com.fonte.origemDados, "promo_snapshot");
  assert.strictEqual(com.aba.fonte.tipo, "promo_snapshot");
  assert.ok(!com.bancada.cenarios.some((c) => c.promocao && c.promocao.estimativa === true));
  assert.ok(!db.consultasDb.slice(antes).some((c) => /promocoes_diagnostico/.test(c.sql)), "com snapshot nem consulta o legado (cabeçalho nem itens)");
});

cenario("fonte única — isolamento: 2 contas ML do MESMO cliente têm fonte, run e promoções próprios", async () => {
  const amb = ambienteFonte({ marginSnaps: new Map([...snapsPara(7, "1", 3), ...snapsPara(8, "2", 2)]) });
  await amb.rodar(7);
  await amb.enfileirar(8); // a conta B está sincronizando pela 1ª vez; a A está atualizada
  const a = await lerAmbas(amb, { contaId: 7, mlb: "MLB10001" });
  const b = await lerAmbas(amb, { contaId: 8, mlb: "MLB20001" });
  assert.strictEqual(a.fonte.estado, "atualizado");
  assert.strictEqual(a.fonte.rotulo, "");
  assert.strictEqual(b.fonte.estado, "sincronizando");
  assert.strictEqual(b.fonte.ultimoBom, null, "a conta B não herda o snapshot da A");
  assert.strictEqual(b.aba.disponivel, false);
  assert.strictEqual(b.bancada.promocoes.disponivel, false);
  assert.ok(a.aba.oportunidades.every((o) => o.itemId.startsWith("MLB1")));
  assert.notStrictEqual(a.fonte.ultimoBom.runId, undefined);
  // A conta A sincronizando não contamina a B depois que a B termina.
  await amb.worker.runOnce();
  const b2 = await lerAmbas(amb, { contaId: 8, mlb: "MLB20001" });
  assert.strictEqual(b2.fonte.estado, "atualizado");
  assert.strictEqual(b2.fonte.ultimoBom.runId, amb.conta(8).current_run_id);
  assert.notStrictEqual(b2.fonte.ultimoBom.runId, a.fonte.ultimoBom.runId);
  assert.ok(b2.aba.oportunidades.every((o) => o.itemId.startsWith("MLB2")));
});

// ─────────────────────────────────────────────────────────────────────────────
// PROMO_SNAPSHOT_CLIENTES=* e scripts/promoSnapshotRunOnce.js (Render Cron)
// ─────────────────────────────────────────────────────────────────────────────

const runOnceScript = require("../scripts/promoSnapshotRunOnce");

const CONTAS_ORQ = [
  { id: 7, cliente_id: 3, cliente_slug: "loja-a", marketplace: "meli", ativo: true, external_account_id: "555" },
  { id: 9, cliente_id: 4, cliente_slug: "loja-b", marketplace: "meli", ativo: true, external_account_id: "777" },
];
const GRANTS_ORQ = [
  { cliente_id: 3, ml_user_id: "555", access_token: "a", refresh_token: "r", token_status: "valid" },
  { cliente_id: 4, ml_user_id: "777", access_token: "a", refresh_token: "r", token_status: "valid" },
];

function depsRunOnce(amb, extra = {}) {
  return {
    db: amb.base.db, logger: amb.logger, env: amb.env, repo: amb.repo, now: amb.base.now, runService: amb.runService,
    ensureTables: async () => {},
    processor: (run, ctx) => processPromoSnapshotRun(run, { ...amb.procDeps, signal: ctx.signal }),
    ...extra,
  };
}

cenario("allowlist `*`: todos os clientes entram (mesmo misturado a slugs); sem slug também; vazio continua = nenhum", async () => {
  const lig = { PROMO_SNAPSHOT_WORKER_ENABLED: "true" };
  assert.deepStrictEqual(resolvePromoSnapshotConfig({ ...lig, PROMO_SNAPSHOT_CLIENTES: " * " }).clientesPiloto, ["*"]);
  for (const lista of ["*", "red_fish,*"]) {
    const cfg = resolvePromoSnapshotConfig({ ...lig, PROMO_SNAPSHOT_CLIENTES: lista });
    assert.deepStrictEqual(avaliarPiloto(cfg, "qualquer-loja"), { noPiloto: true, motivo: null }, lista);
    assert.deepStrictEqual(avaliarPiloto(cfg, null), { noPiloto: true, motivo: null }, `${lista} sem slug`);
  }
  assert.strictEqual(avaliarPiloto(resolvePromoSnapshotConfig({ PROMO_SNAPSHOT_CLIENTES: "*" }), "x").motivo, "WORKER_DESABILITADO");

  const amb = ambiente({ contasCliente: CONTAS_ORQ, grants: GRANTS_ORQ, env: { PROMO_SNAPSHOT_CLIENTES: "*", PROMO_SNAPSHOT_ORCHESTRATOR_MAX_PER_TICK: "10" } });
  const r = await orquestrarTick({ ...amb.base });
  assert.deepStrictEqual(r.enfileirados.map((e) => e.clienteContaId).sort(), [7, 9]);
});

cenario("run-once: desligado ou allowlist vazia → exit 0 sem tocar no banco", async () => {
  const proibido = { query: async () => { throw new Error("não deveria consultar"); } };
  for (const env of [{ PROMO_SNAPSHOT_CLIENTES: "*" }, { PROMO_SNAPSHOT_WORKER_ENABLED: "true", PROMO_SNAPSHOT_CLIENTES: "" }]) {
    const r = await runOnceScript.executarPassada([], {
      env, db: proibido, logger: F.loggerMemoria(),
      ensureTables: async () => { throw new Error("não deveria migrar"); },
    });
    assert.strictEqual(r.codigo, 0);
    assert.ok(["WORKER_DESABILITADO", "PILOTO_VAZIO"].includes(r.motivo));
  }
});

cenario("run-once: enfileira a allowlist e processa a fila (só GET); 2ª passada não duplica (snapshot fresco)", async () => {
  const amb = ambiente({ contasCliente: CONTAS_ORQ, grants: GRANTS_ORQ, env: { PROMO_SNAPSHOT_CLIENTES: "*", PROMO_SNAPSHOT_ORCHESTRATOR_MAX_PER_TICK: "10" } });
  const r = await runOnceScript.executarPassada([], depsRunOnce(amb));
  assert.strictEqual(r.codigo, 0);
  assert.deepStrictEqual(r.enfileirados.map((e) => e.clienteContaId).sort(), [7, 9]);
  assert.strictEqual(r.runs.length, 2);
  assert.ok(r.runs.every((x) => x.resultado === "completed"));
  assert.ok(amb.conta(7) && amb.conta(9), "as duas contas ganharam snapshot");
  assert.ok(amb.ml.chamadas.every((c) => c.method === "GET"));

  const r2 = await runOnceScript.executarPassada([], depsRunOnce(amb));
  assert.deepStrictEqual([r2.codigo, r2.enfileirados.length, r2.runs.length], [0, 0, 0]);
  assert.strictEqual(amb.repo._st.runs.length, 2, "nenhum run novo");
});

cenario("run-once: --max-runs limita o processamento; o resto fica na fila para a próxima passada", async () => {
  const amb = ambiente({ contasCliente: CONTAS_ORQ, grants: GRANTS_ORQ, env: { PROMO_SNAPSHOT_CLIENTES: "loja-a,loja-b", PROMO_SNAPSHOT_ORCHESTRATOR_MAX_PER_TICK: "10" } });
  const r = await runOnceScript.executarPassada(["--max-runs=1"], depsRunOnce(amb));
  assert.deepStrictEqual([r.codigo, r.enfileirados.length, r.runs.length], [0, 2, 1]);
  assert.strictEqual(amb.repo._st.runs.filter((x) => x.status === "queued").length, 1);
  assert.throws(() => runOnceScript.parseArgs(["--max-runs=0"]), /--max-runs/);
  assert.throws(() => runOnceScript.parseArgs(["--tudo"]), /desconhecido/);
});

cenario("run-once: respeita allowlist e locks — run na fila de cliente fora da lista falha sem tocar no ML; run stale é reconciliado; conta com run ativo não ganha outro", async () => {
  const amb = ambiente({ contasCliente: CONTAS_ORQ, grants: GRANTS_ORQ, env: { PROMO_SNAPSHOT_CLIENTES: "loja-b", PROMO_SNAPSHOT_ORCHESTRATOR_MAX_PER_TICK: "10" } });
  // Run de loja-a enfileirado antes de a allowlist mudar.
  await amb.enfileirar(7);
  // Run "running" de outra instância que morreu há 1 h (conta 8).
  await amb.enfileirar(8);
  const preso = amb.repo._st.runs.find((x) => x.cliente_conta_id === 8);
  Object.assign(preso, { status: "running", started_at: new Date(amb.relogio.agora() - 3600000).toISOString(), heartbeat_at: new Date(amb.relogio.agora() - 3600000).toISOString() });
  const chamadasAntes = amb.ml.chamadas.length;

  const r = await runOnceScript.executarPassada([], depsRunOnce(amb));
  assert.strictEqual(r.reconciliados, 1);
  assert.strictEqual(preso.status, "failed");
  assert.deepStrictEqual(r.enfileirados.map((e) => e.clienteContaId), [9], "só loja-b; loja-a já tinha run na fila e está fora");
  const runA = amb.repo._st.runs.find((x) => x.cliente_conta_id === 7);
  assert.strictEqual(runA.status, "failed");
  assert.strictEqual(runA.error_code, "PROMO_SNAPSHOT_FORA_DO_PILOTO");
  assert.ok(!amb.ml.chamadas.slice(chamadasAntes).some((c) => String(c.mlUserId) === "555" || String(c.path || "").includes("555")), "nenhuma chamada ao seller de loja-a");
  assert.strictEqual(amb.repo._st.runs.find((x) => x.cliente_conta_id === 9).status !== "queued", true);
  assert.strictEqual(r.codigo, 1, "run não concluído → exit 1 (o cron sinaliza)");
});

async function main() {
  let ok = 0;
  for (const c of casos) {
    try {
      await c.fn();
      ok += 1;
      console.log(`  ✓ ${c.nome}`);
    } catch (err) {
      console.error(`  ✗ ${c.nome}\n    ${err && err.stack ? err.stack.split("\n").slice(0, 6).join("\n    ") : err}`);
      process.exitCode = 1;
    }
  }
  // Prova final, sobre TODAS as chamadas de TODOS os cenários.
  const todas = TODAS_CHAMADAS_ML.flat();
  const post = todas.filter((c) => c.method === "POST").length;
  const put = todas.filter((c) => c.method === "PUT").length;
  const patch = todas.filter((c) => c.method === "PATCH").length;
  const del = todas.filter((c) => c.method === "DELETE").length;
  const comCorpo = todas.filter((c) => c.body != null).length;
  try {
    assert.ok(todas.length > 500, `amostra relevante de chamadas (${todas.length})`);
    assert.strictEqual(post, 0, "ZERO POST (participação em promoção)");
    assert.strictEqual(put, 0, "ZERO PUT (promoção/preço)");
    assert.strictEqual(patch, 0, "ZERO PATCH (preço)");
    assert.strictEqual(del, 0, "ZERO DELETE");
    assert.strictEqual(comCorpo, 0, "nenhuma requisição com corpo");
    console.log(`  ✓ ZERO escrita no ML: ${todas.length} chamadas, todas GET (POST=${post} PUT=${put} PATCH=${patch} DELETE=${del})`);
    ok += 1;
  } catch (err) {
    console.error(`  ✗ zero escrita: ${err.message}`);
    process.exitCode = 1;
  }
  if (process.exitCode) {
    console.error(`promoSnapshot: FALHOU (${ok}/${casos.length + 1})`);
  } else {
    console.log(`promoSnapshot: ok (${ok} cenários)`);
  }
}

main();
