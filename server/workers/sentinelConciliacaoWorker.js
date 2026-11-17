#!/usr/bin/env node
// server/workers/sentinelConciliacaoWorker.js
// Sentinel — coletor de Billing / conciliação da comissão (S1). Processo PRÓPRIO
// (node server/workers/sentinelConciliacaoWorker.js), separado do polling (sentinelWorker.js). Não é iniciado pelo Express.
//
// DESLIGADO POR PADRÃO — sem a flag, sai sem abrir conexão e sem chamar o Mercado Livre:
//   SENTINEL_CONCILIACAO_ENABLED     ausente/≠true ⇒ OFF (loga e sai com código 0)
//   SENTINEL_CONCILIACAO_CONTAS      ids de cliente_contas separados por vírgula (allowlist PRÓPRIA; não herda a do polling).
//                                    Vazia ⇒ não processa nada.
//   SENTINEL_CONCILIACAO_INTERVAL_MS intervalo entre execuções (padrão 6 h; mínimo 10 min)
//   SENTINEL_CONCILIACAO_UMA_VEZ     "true" ⇒ uma execução e sai (ativação controlada)
//   SENTINEL_DB_POOL_MAX / SENTINEL_STATEMENT_TIMEOUT_MS — pool próprio (padrão 2 conexões + a do lock)
//   demais limites: sentinelConciliacaoColetor.configConciliacao
//
// Somente leitura de schema: NUNCA aplica migration. Sem as tabelas da 20261119, cada execução é suspensa sem chamadas.
// SIGTERM/SIGINT: termina a execução corrente (as gravações são por pedido e idempotentes), fecha o pool e sai.

const { criarPoolSentinel, lerAllowlist } = require("./sentinelWorker");
const { executarColeta } = require("../services/sentinel/sentinelConciliacaoColetor");

const FLAGS_ON = new Set(["true", "1", "on", "yes"]);
const INTERVALO_MIN_MS = 10 * 60 * 1000;
const SHUTDOWN_FORCADO_MS = 150000;

const ligado = (v) => FLAGS_ON.has(String(v || "").trim().toLowerCase());

function conciliacaoHabilitada(env = process.env) {
  return ligado(env.SENTINEL_CONCILIACAO_ENABLED);
}

function lerContasConciliacao(env = process.env) {
  return lerAllowlist({ SENTINEL_CONTAS_ALLOWLIST: env.SENTINEL_CONCILIACAO_CONTAS });
}

function intervaloMs(env = process.env) {
  const n = Number.parseInt(env.SENTINEL_CONCILIACAO_INTERVAL_MS, 10);
  return Number.isFinite(n) ? Math.max(INTERVALO_MIN_MS, n) : 6 * 3600 * 1000;
}

async function iniciar({ env = process.env, logger = console, criarPool = criarPoolSentinel, executar = executarColeta } = {}) {
  if (!conciliacaoHabilitada(env)) {
    logger.log("[sentinel-conciliacao] OFF (SENTINEL_CONCILIACAO_ENABLED != true) — saindo sem fazer nada.");
    return { iniciado: false, motivo: "flag_off" };
  }
  const contaIds = lerContasConciliacao(env);
  if (!contaIds.length) {
    logger.log("[sentinel-conciliacao] SENTINEL_CONCILIACAO_CONTAS vazia — não processa nenhuma conta; saindo.");
    return { iniciado: false, motivo: "allowlist_vazia" };
  }
  const umaVez = ligado(env.SENTINEL_CONCILIACAO_UMA_VEZ);
  const db = criarPool(env);
  let parando = false;
  let timer = null;
  let emCurso = null;
  let resolverFim;
  const fim = new Promise((r) => { resolverFim = r; });
  logger.log(`[sentinel-conciliacao] ON — contas ${contaIds.join(",")}, ${umaVez ? "execução única" : `intervalo ${intervaloMs(env)}ms`}`);

  const encerrar = async () => { await db.end().catch(() => {}); resolverFim(); };
  const tick = async () => {
    timer = null;
    emCurso = (async () => {
      try { await executar({ db, contaIds, deveParar: () => parando }); } catch (err) { logger.error(`[sentinel-conciliacao] execução falhou: ${err.message}`); }
    })();
    await emCurso;
    emCurso = null;
    if (umaVez) { parando = true; await encerrar(); return; }
    if (!parando) timer = setTimeout(tick, intervaloMs(env));
  };
  const parar = async (sinal) => {
    if (parando && !emCurso) return;
    parando = true;
    logger.log(`[sentinel-conciliacao] ${sinal}: terminando a execução corrente e encerrando.`);
    if (timer) clearTimeout(timer);
    const forcado = setTimeout(() => { logger.error("[sentinel-conciliacao] encerramento forçado."); process.exit(1); }, SHUTDOWN_FORCADO_MS);
    if (typeof forcado.unref === "function") forcado.unref();
    if (emCurso) await emCurso;
    clearTimeout(forcado);
    await encerrar();
  };
  timer = setTimeout(tick, 0);
  return { iniciado: true, parar, fim, db };
}

async function main() {
  const w = await iniciar();
  if (!w.iniciado) return;
  process.on("SIGTERM", () => w.parar("SIGTERM"));
  process.on("SIGINT", () => w.parar("SIGINT"));
  await w.fim;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(`[sentinel-conciliacao] falhou: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { conciliacaoHabilitada, lerContasConciliacao, intervaloMs, iniciar, main };
