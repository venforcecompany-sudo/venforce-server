// server/services/motorMargem/marginSnapshotApiService.js
// Margin Snapshot — serviço da API HTTP (M4: refresh + status do run).
//
// Toda operação é ACCOUNT-SCOPED: o cliente vem da rota (já autorizado por
// carteira), a conta vem explícita (`clienteContaId`) e é validada contra o
// cliente ANTES de qualquer leitura/escrita — conta de outro cliente, de
// outro marketplace ou inativa nunca passa. Nada aqui chama o Mercado Livre
// nem calcula margem: o refresh só enfileira um run persistido (202) e o
// worker processa em background.

const pool = require("../../config/database");
const clienteContaService = require("../clienteContas/clienteContaService");
const runService = require("./marginSnapshotRunService");
const { redigirSegredos } = require("./marginSnapshotSanitize");

function criarErroHttp(statusCode, erro, code) {
  const err = new Error(erro);
  err.statusCode = statusCode;
  err.payload = { ok: false, erro, code, codigo: code };
  return err;
}

function parseIdPositivo(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

/**
 * Cliente (pela rota) + conta explícita, validada. Mesmas regras de
 * resolveMarketplaceAccountContext (pertence ao cliente, marketplace MELI,
 * ativa), sem resolver grant/Base — a API de snapshot não fala com o ML.
 */
async function resolverContaDoCliente({ clienteSlug, clienteContaId }, deps = {}) {
  const db = deps.db || pool;
  const contas = deps.clienteContaService || clienteContaService;

  const contaId = parseIdPositivo(clienteContaId);
  if (contaId === null) {
    throw criarErroHttp(400, "clienteContaId é obrigatório: a leitura de margem é sempre por conta.", "CLIENTE_CONTA_ID_OBRIGATORIO");
  }
  if (Number.isNaN(contaId)) {
    throw criarErroHttp(400, "clienteContaId inválido.", "CLIENTE_CONTA_ID_INVALIDO");
  }

  const cliente = await contas.resolverClientePorIdOuSlug({ clienteSlug }, db);
  const conta = await contas.obterConta(contaId, db);
  if (Number(conta.cliente_id) !== Number(cliente.id)) {
    throw criarErroHttp(403, "Esta conta não pertence ao cliente informado.", "CONTA_NAO_PERTENCE_AO_CLIENTE");
  }
  if (String(conta.marketplace || "").toLowerCase() !== "meli") {
    throw criarErroHttp(422, "A Central de Margem só lê contas Mercado Livre.", "MARKETPLACE_INCOMPATIVEL");
  }
  if (conta.ativo === false) {
    throw criarErroHttp(409, `A conta "${conta.nome}" foi desativada.`, "CONTA_INATIVA");
  }

  return {
    cliente: { id: Number(cliente.id), slug: cliente.slug, nome: cliente.nome },
    conta: { id: Number(conta.id), nome: conta.nome || null },
  };
}

// Contrato público do run — só o que a UI precisa para progresso. Nunca
// metadata crua (contadores internos ficam no banco), erro sempre redigido.
// Ids que o run não conseguiu recalcular (gravados pelo processor no fim).
function idsFalhosDoRun(run) {
  const ids = run && run.metadata && run.metadata.falhas && run.metadata.falhas.itemIds;
  return Array.isArray(ids) ? ids : [];
}

// P0 10/11/2026 (run 3808, conta 87): com o PostgreSQL em crash-recovery o run
// ficou `running` sem heartbeat por 10 min (até o reconcile do worker marcá-lo
// failed) e a tela fez ~200 polls mostrando "Atualizando…". O heartbeat é
// renovado a cada lote (~2 s; com retry/Retry-After, no máximo ~2–3 min), então
// sem sinal há RUN_PARADO_MINUTOS o run é exibido como PARADO — sem mudar o
// estado no banco (quem encerra é o reconcile; um GET nunca escreve).
const RUN_PARADO_MINUTOS = 4;

function minutosSemProgresso(run, agora) {
  if (run.status !== "running" && run.status !== "queued") return null;
  const ref = run.status === "running" ? (run.heartbeatAt || run.startedAt || run.createdAt) : run.createdAt;
  const t = ref ? new Date(ref).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((agora - t) / 60000));
}

function runPublico(run, agora = Date.now()) {
  if (!run) return null;
  const semProgresso = minutosSemProgresso(run, agora);
  return {
    runId: run.id,
    clienteContaId: run.clienteContaId,
    status: run.status,
    reason: run.reason,
    // "falhas" = run que recalculou só os anúncios que falharam num run anterior.
    escopo: run.metadata && run.metadata.escopo ? "falhas" : "catalogo",
    // A tela oferece "recalcular só os que falharam" quando há ids guardados.
    podeRefazerFalhas: run.status === "completed" && idsFalhosDoRun(run).length > 0,
    totalItems: run.totalItems,
    processedItems: run.processedItems,
    successItems: run.successItems,
    failedItems: run.failedItems,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    heartbeatAt: run.heartbeatAt,
    finishedAt: run.finishedAt,
    errorCode: run.errorCode || null,
    errorMessage: run.errorMessage ? redigirSegredos(run.errorMessage, 500) : null,
    // running: minutos desde o último heartbeat; queued: desde a criação (nenhum
    // worker pegou — ex.: MARGIN_SNAPSHOT_WORKER_ENABLED desligado). null = terminal.
    semProgressoMinutos: semProgresso,
    parado: semProgresso !== null && semProgresso >= RUN_PARADO_MINUTOS,
  };
}

/**
 * Escopo "só as falhas" de um run anterior DESTA conta: o run tem de ter
 * completado e guardado os ids que não recalculou. A lista vai no metadado
 * do run novo (o processor lê dali e não varre o catálogo).
 */
async function escopoDasFalhas({ refazerFalhasDoRun, conta, db, getRunStatus }) {
  const origemId = parseIdPositivo(refazerFalhasDoRun);
  if (origemId === null || Number.isNaN(origemId)) throw criarErroHttp(400, "refazerFalhasDoRun inválido.", "RUN_ID_INVALIDO");
  const origem = await getRunStatus({ runId: origemId, clienteContaId: conta.id, db });
  if (!origem) throw criarErroHttp(404, "Run de atualização não encontrado para esta conta.", "RUN_NAO_ENCONTRADO");
  const itemIds = idsFalhosDoRun(origem);
  if (origem.status !== "completed" || !itemIds.length) {
    throw criarErroHttp(409, "Este recálculo não tem anúncios com falha para refazer.", "SEM_FALHAS_PARA_REFAZER");
  }
  return { tipo: "falhas", origemRunId: origem.id, itemIds };
}

/** POST refresh: enfileira (ou reaproveita) — nunca espera o cálculo. */
async function solicitarRefresh({ clienteSlug, clienteContaId, requestedBy = null, refazerFalhasDoRun = null }, deps = {}) {
  const db = deps.db || pool;
  const enqueue = deps.enqueue || runService.enqueueMarginSnapshotRun;
  const kick = deps.kick || require("./marginSnapshotRuntime").kick;
  const getRunStatus = deps.getRunStatus || runService.getRunStatus;

  const { cliente, conta } = await resolverContaDoCliente({ clienteSlug, clienteContaId }, deps);
  const escopo = refazerFalhasDoRun != null && String(refazerFalhasDoRun).trim() !== ""
    ? await escopoDasFalhas({ refazerFalhasDoRun, conta, db, getRunStatus })
    : null;
  const { run, reaproveitado } = await enqueue({
    clienteId: cliente.id,
    clienteSlug: cliente.slug,
    clienteContaId: conta.id,
    marketplace: "meli",
    // Mesmo reason do clique manual (o CHECK do banco não tem outro); o que
    // distingue o run parcial é metadata.escopo.
    reason: "manual_refresh",
    requestedBy,
    ...(escopo ? { metadata: { escopo } } : {}),
    db,
  });
  kick();
  return { ok: true, runId: run.id, reaproveitado, run: runPublico(run) };
}

/** GET status: o run tem de ser DESTA conta (e a conta, deste cliente). */
async function obterStatusRefresh({ clienteSlug, clienteContaId, runId }, deps = {}) {
  const db = deps.db || pool;
  const getRunStatus = deps.getRunStatus || runService.getRunStatus;

  const id = parseIdPositivo(runId);
  if (id === null || Number.isNaN(id)) throw criarErroHttp(400, "runId inválido.", "RUN_ID_INVALIDO");

  const { conta } = await resolverContaDoCliente({ clienteSlug, clienteContaId }, deps);
  const run = await getRunStatus({ runId: id, clienteContaId: conta.id, db });
  // Run inexistente e run de OUTRA conta respondem igual (404): nunca
  // confirmar a existência de um run fora do escopo.
  if (!run) throw criarErroHttp(404, "Run de atualização não encontrado para esta conta.", "RUN_NAO_ENCONTRADO");
  return { ok: true, run: runPublico(run) };
}

module.exports = {
  criarErroHttp,
  parseIdPositivo,
  resolverContaDoCliente,
  runPublico,
  solicitarRefresh,
  obterStatusRefresh,
};
