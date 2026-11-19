#!/usr/bin/env node
// server/workers/sentinelWorker.js
// Sentinel — processo PRÓPRIO (node server/workers/sentinelWorker.js). NÃO é
// iniciado pelo Express (server/index.js não referencia o Sentinel).
//
// Dois agendamentos INDEPENDENTES no MESMO processo (S1.5 — contrato docs/sentinel/CONTRATO_S1_5_OPERACAO.md):
//
//   POLLING de pedidos (comportamento de sempre; lock vf:sentinel:polling, pool próprio, logs atuais intactos)
//     SENTINEL_WORKER_ENABLED        ausente/≠true ⇒ polling OFF
//     SENTINEL_CONTAS_ALLOWLIST      ids de cliente_contas separados por vírgula (ex.: "41"). Vazia ⇒ polling OFF.
//     SENTINEL_DB_POOL_MAX           pool PRÓPRIO do polling (padrão 2)
//     SENTINEL_STATEMENT_TIMEOUT_MS  statement_timeout das queries (padrão 30000)
//     SENTINEL_POLL_INTERVAL_MS / SENTINEL_OVERLAP_MS / SENTINEL_CICLO_MAX_MS /
//     SENTINEL_MAX_CHAMADAS_POR_CONTA / SENTINEL_MAX_TENTATIVAS — ver sentinelPollingWorker
//
//   BILLING agendado (conciliação da comissão; sentinelAgendaBilling + sentinelConciliacaoColetor)
//     SENTINEL_CONCILIACAO_AGENDADA_ENABLED=true E SENTINEL_CONCILIACAO_CONTAS (allowlist PRÓPRIA; nunca herda a do polling)
//     SENTINEL_CONCILIACAO_INTERVAL_MS (6 h; mín. 10 min) · SENTINEL_CONCILIACAO_DB_POOL_MAX (pool PRÓPRIO, padrão 1)
//     SENTINEL_CONCILIACAO_ADIAR_MAX_MS (espera do ciclo de polling em curso, padrão 120000) · SENTINEL_HEARTBEAT_MS
//
//   Os dois OFF ⇒ iniciar() devolve { iniciado:false } sem tocar banco/timer. main(): fora do Render sai com 0 (como
//   sempre); NO RENDER (env RENDER definido) fica OCIOSO — um Background Worker que termina é reiniciado em loop
//   (earlyExit visto em 28/10/2026).
//   Polling falha no boot (schema): com Billing ligado, o Billing segue e o heartbeat mostra polling.falhaBoot; sem
//   Billing, lança como antes (main: exit 1 fora do Render; ocioso no Render).
//
// Não carrega server/.env: o ambiente vem do processo (Render/shell). Nada inicia em require(): só `main()` quando
// executado direto.
//
// SIGTERM/SIGINT (UM handler para os dois): para os timers; o polling termina a conta corrente (checkpoint só avança
// por janela completa); o Billing para ENTRE chamadas ao ML; aguarda o que está em curso, grava o heartbeat
// `encerramento:"limpo"`, fecha os DOIS pools e sai.

const { Pool } = require("pg");
const { configConexao, lerMsPositivo, protegerConexoesDoPool } = require("../config/databaseConexao");
const { verificarSentinelSchema } = require("../services/sentinel/sentinelSchema");
const { executarCiclo, configWorker } = require("../services/sentinel/sentinelPollingWorker");
const agendaBilling = require("../services/sentinel/sentinelAgendaBilling");

const FLAGS_ON = new Set(["true", "1", "on", "yes"]);
const SHUTDOWN_FORCADO_MS = 90000;
const OCIOSO_LOG_MS = 3600 * 1000;
const HEARTBEAT_ENCERRAMENTO_MAX_MS = 5000;
// Render: ~30 s entre SIGTERM e SIGKILL. Espera o trabalho em curso até 20 s (uma chamada ao ML pode levar até 30 s;
// o checkpoint só avança por janela completa e as gravações do Billing são por pedido e idempotentes — abandonar é
// seguro), depois heartbeat (≤ 5 s) e pools (≤ 3 s cada, um client pendurado não segura o processo).
const ESPERA_TRABALHO_MAX_MS = 20000;
const FECHAR_POOL_MAX_MS = 3000;

// Promise com teto (nunca rejeita): o encerramento não pode ficar preso em banco/ML travado.
function comTeto(promessa, ms, timers = { setTimeout, clearTimeout }) {
  let t = null;
  return Promise.race([
    Promise.resolve(promessa).catch(() => {}),
    new Promise((r) => { t = timers.setTimeout(r, ms); }),
  ]).finally(() => { if (t) timers.clearTimeout(t); });
}
// Boot do polling falhou com o Billing ligado (o processo NÃO sai): nova tentativa periódica — sem isso, um banco fora
// do ar no boot deixaria o polling desligado até o próximo deploy.
const POLLING_BOOT_RETRY_MS = 5 * 60 * 1000;

function workerHabilitado(env = process.env) {
  return FLAGS_ON.has(String(env.SENTINEL_WORKER_ENABLED || "").trim().toLowerCase());
}

// "41, 52" → [41, 52]; ignora entradas inválidas.
function lerAllowlist(env = process.env) {
  return [...new Set(String(env.SENTINEL_CONTAS_ALLOWLIST || "")
    .split(",").map((x) => x.trim()).filter(Boolean)
    .map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0))];
}

function criarPoolSentinel(env = process.env) {
  const pool = new Pool({
    ...configConexao(),
    max: lerMsPositivo(env.SENTINEL_DB_POOL_MAX, 2),
    statement_timeout: lerMsPositivo(env.SENTINEL_STATEMENT_TIMEOUT_MS, 30000),
    connectionTimeoutMillis: lerMsPositivo(env.PG_POOL_CONNECTION_TIMEOUT_MS, 30000),
  });
  protegerConexoesDoPool(pool);
  return pool;
}

// Pool PRÓPRIO do Billing agendado (padrão 1 conexão) — mais a conexão dedicada do lock da conciliação.
function criarPoolConciliacao(env = process.env, cfg = agendaBilling.configAgenda(env)) {
  const pool = new Pool({
    ...configConexao(),
    max: cfg.poolMax,
    statement_timeout: lerMsPositivo(env.SENTINEL_STATEMENT_TIMEOUT_MS, 30000),
    connectionTimeoutMillis: lerMsPositivo(env.PG_POOL_CONNECTION_TIMEOUT_MS, 30000),
  });
  protegerConexoesDoPool(pool);
  return pool;
}

// Só as contas da allowlist que existem como conta ML ativa. Fora da allowlist
// nunca é processada, mesmo que esteja ativa.
async function selecionarContas(db, allowlist) {
  if (!allowlist.length) return [];
  const r = await db.query(
    `SELECT id FROM cliente_contas
      WHERE ativo = true AND marketplace = 'meli' AND external_account_id IS NOT NULL
        AND id = ANY($1::int[])
      ORDER BY id`,
    [allowlist]
  );
  return r.rows.map((row) => row.id);
}

// Um tick: seleciona contas da allowlist e roda um ciclo. Injetável para teste.
async function executarTick({ db, allowlist, deveParar, executar = executarCiclo, ...deps }) {
  const contaIds = await selecionarContas(db, allowlist);
  if (!contaIds.length) {
    console.log("[sentinel-worker] nenhuma conta da allowlist elegível (ativa/ML/seller) — nada a processar.");
    return { pulado: false, contas: [], semContas: true };
  }
  return executar({ contaIds, db, deveParar, ...deps });
}

// Resultado de um tick de polling → resumo compacto (linha [sentinel-op] e heartbeat). Sem pedidos, sem payload.
function resumirCicloPolling({ r, erro, execucao, inicioMs, duracaoMs }) {
  const contas = (r && Array.isArray(r.contas) ? r.contas : []).map((c) => ({
    id: c.contaId, pedidos: c.processados ?? 0, chamadas: c.chamadasMl ?? 0,
    gravados: (c.porResultado && c.porResultado.gravado) || 0, atrasoS: c.atrasoSegundos ?? null,
    parada: null, erro: c.erro ? agendaBilling.codigoErro(c.erro) : null,
  }));
  const resultado = erro || !r ? "erro" : r.semContas ? "sem_contas" : r.pulado ? "pulado" : r.abortado ? "abortado" : "concluido";
  return {
    tarefa: "polling", execucao, inicio: new Date(inicioMs).toISOString(), duracaoMs,
    chamadas: contas.reduce((s, c) => s + c.chamadas, 0),
    pedidos: contas.reduce((s, c) => s + c.pedidos, 0),
    gravados: contas.reduce((s, c) => s + c.gravados, 0),
    resultado,
    erro: erro ? agendaBilling.codigoErro(`${erro.code || "ERRO"}`) : (r && r.abortado ? "SENTINEL_LOCK_PERDIDO" : null),
    contas,
  };
}

// Os dois agendamentos. Retorna { iniciado:false } sem tocar banco/timer quando nada está habilitado.
async function iniciar({
  env = process.env, logger = console, criarPool = criarPoolSentinel, executar = executarCiclo,
  criarPoolBilling = criarPoolConciliacao, executarBilling, depsBilling, depsPolling,
  agora = Date.now, timers = { setTimeout, clearTimeout }, identidade,
} = {}) {
  const aviso = typeof logger.warn === "function" ? logger.warn.bind(logger) : logger.log.bind(logger);
  const pollingFlag = workerHabilitado(env);
  const allowlist = lerAllowlist(env);
  const bcfg = agendaBilling.configAgenda(env);
  const billingAtivo = bcfg.habilitado && bcfg.contas.length > 0;
  if (bcfg.habilitado && !bcfg.contas.length) {
    logger.log("[sentinel-worker] SENTINEL_CONCILIACAO_AGENDADA_ENABLED=true mas SENTINEL_CONCILIACAO_CONTAS vazia — Billing agendado OFF.");
  }
  const pollingConfigurado = pollingFlag && allowlist.length > 0;
  let pollingAtivo = pollingConfigurado;
  if (!pollingAtivo && !billingAtivo) {
    if (!pollingFlag) {
      logger.log("[sentinel-worker] OFF (SENTINEL_WORKER_ENABLED != true) — saindo sem fazer nada.");
      return { iniciado: false, motivo: "flag_off" };
    }
    logger.log("[sentinel-worker] SENTINEL_CONTAS_ALLOWLIST vazia — não processa nenhuma conta; saindo.");
    return { iniciado: false, motivo: "allowlist_vazia" };
  }
  if (!pollingFlag) logger.log("[sentinel-worker] polling OFF (SENTINEL_WORKER_ENABLED != true) — processo só com o Billing agendado.");
  else if (!allowlist.length) logger.log("[sentinel-worker] SENTINEL_CONTAS_ALLOWLIST vazia — polling OFF; processo só com o Billing agendado.");

  const cfg = configWorker(env);
  let db = null;
  let falhaBoot = null;
  // Pool + verificação SOMENTE LEITURA do schema (o worker NUNCA aplica migration — etapa separada, com aprovação).
  const prepararPolling = async () => {
    const novo = criarPool(env);
    try {
      await verificarSentinelSchema(novo);
    } catch (err) {
      await novo.end().catch(() => {});
      throw err;
    }
    return novo;
  };
  if (pollingAtivo) {
    try {
      db = await prepararPolling();
    } catch (err) {
      if (!billingAtivo) throw err;
      pollingAtivo = false;
      falhaBoot = `${err.code || "ERRO"}: ${agendaBilling.sanitizar(err.message, 160)}`;
      logger.error(`[sentinel-worker] polling NÃO iniciou (${falhaBoot}); o Billing agendado segue e o boot do polling é retentado a cada ${POLLING_BOOT_RETRY_MS}ms.`);
    }
  }
  const dbBilling = billingAtivo ? criarPoolBilling(env, bcfg) : null;
  const ident = identidade || agendaBilling.identidadeProcesso(env);

  let parando = false;
  let timer = null;
  let timerHeartbeat = null;
  let timerBootPolling = null;
  let bootPollingEmCurso = null;
  let cicloEmCurso = null;
  let pararEmCurso = null;
  let resolverFim;
  const fim = new Promise((resolve) => { resolverFim = resolve; });
  let agendador = null;

  // Estado do processo (heartbeat `worker_processo`, contrato §2)
  const estado = {
    polling: {
      // habilitado = configurado (flag + allowlist); falhaBoot ≠ null ⇒ configurado mas NÃO rodando (boot falhou)
      habilitado: pollingConfigurado, contas: pollingConfigurado ? allowlist : [], intervaloMs: cfg.intervalMs,
      ultimoCicloEm: null, ultimoCicloMs: null, ultimoCicloPedidos: null, ultimoCicloEstado: null, ultimoCicloErro: null,
      falhasSeguidas: 0, falhaBoot,
    },
    billing: {
      habilitado: billingAtivo, contas: billingAtivo ? bcfg.contas : [], intervaloMs: bcfg.intervaloMs,
      get emExecucao() { return agendador ? agendador.estado.emExecucao : false; },
      get ultimaVerificacaoEm() { return agendador ? agendador.estado.ultimaVerificacaoEm : null; },
    },
  };
  const heartbeat = agendaBilling.criarHeartbeat({ db: db || dbBilling, identidade: ident, agora, logger, estado });
  heartbeat.boot();

  if (pollingAtivo) {
    logger.log(`[sentinel-worker] ON — contas ${allowlist.join(",")}, intervalo ${cfg.intervalMs}ms, pool max ${db.options?.max ?? "?"}`);
  }
  if (billingAtivo) {
    logger.log(`[sentinel-worker] Billing agendado ON — contas ${bcfg.contas.join(",")}, intervalo ${bcfg.intervaloMs}ms, `
      + `pool max ${dbBilling.options?.max ?? "?"} (+1 do lock), adiar até ${bcfg.adiarMaxMs}ms`);
  }

  const registrarCicloPolling = (resumo) => {
    const p = estado.polling;
    p.ultimoCicloEm = resumo.inicio;
    p.ultimoCicloMs = resumo.duracaoMs;
    p.ultimoCicloPedidos = resumo.pedidos;
    p.ultimoCicloEstado = resumo.resultado;
    const erroConta = resumo.contas.find((c) => c.erro);
    p.ultimoCicloErro = resumo.erro || (erroConta ? `conta ${erroConta.id}: ${erroConta.erro}` : null);
    // ciclos SEGUIDOS com erro (do ciclo ou de alguma conta); um ciclo limpo zera. pulado/sem_contas não mexem.
    if (resumo.resultado === "erro" || resumo.resultado === "abortado" || erroConta) p.falhasSeguidas += 1;
    else if (resumo.resultado === "concluido") p.falhasSeguidas = 0;
    // warn quando há problema: o filtro por nível do Render precisa achar os erros (hoje só aparecem como info)
    const linha = `[sentinel-op] ${JSON.stringify(resumo)}`;
    if (resumo.resultado !== "concluido" || erroConta) aviso(linha); else logger.log(linha);
    heartbeat.gravar();
  };

  const agendar = (ms) => {
    if (parando) return;
    timer = timers.setTimeout(tick, ms);
  };
  const tick = async () => {
    timer = null;
    const inicioMs = agora();
    let r = null;
    let erro = null;
    cicloEmCurso = (async () => {
      try {
        r = await executarTick({ db, allowlist, deveParar: () => parando, executar, ...(depsPolling || {}) });
      } catch (err) {
        erro = err;
        logger.error(`[sentinel-worker] ciclo falhou: ${err.message}`);
      }
    })();
    await cicloEmCurso;
    cicloEmCurso = null;
    try {
      registrarCicloPolling(resumirCicloPolling({ r, erro, execucao: `p-${inicioMs}`, inicioMs, duracaoMs: agora() - inicioMs }));
    } catch (_) { /* observabilidade nunca derruba o polling */ }
    agendar(cfg.intervalMs);
  };

  // Retentativa do boot do polling (só quando falhou com o Billing ligado). Sucesso ⇒ polling começa já.
  const agendarBootPolling = () => {
    if (parando) return;
    timerBootPolling = timers.setTimeout(() => {
      timerBootPolling = null;
      bootPollingEmCurso = (async () => {
        try {
          const novo = await prepararPolling();
          if (parando) { await novo.end().catch(() => {}); return; }
          db = novo;
          pollingAtivo = true;
          estado.polling.falhaBoot = null;
          logger.log(`[sentinel-worker] polling iniciado após falha de boot — contas ${allowlist.join(",")}, intervalo ${cfg.intervalMs}ms`);
          heartbeat.gravar();
          agendar(0);
        } catch (err) {
          estado.polling.falhaBoot = `${err.code || "ERRO"}: ${agendaBilling.sanitizar(err.message, 160)}`;
          logger.error(`[sentinel-worker] polling ainda não iniciou (${estado.polling.falhaBoot}); nova tentativa em ${POLLING_BOOT_RETRY_MS}ms.`);
          agendarBootPolling();
        }
      })();
      bootPollingEmCurso.finally(() => { bootPollingEmCurso = null; });
    }, POLLING_BOOT_RETRY_MS);
  };

  // Heartbeat periódico: worker só com Billing também parece vivo. Limpo no parar (e unref, por garantia).
  const agendarHeartbeat = () => {
    if (parando) return;
    timerHeartbeat = timers.setTimeout(() => {
      timerHeartbeat = null;
      heartbeat.periodico(bcfg.heartbeatMs);
      agendarHeartbeat();
    }, bcfg.heartbeatMs);
    if (timerHeartbeat && typeof timerHeartbeat.unref === "function") timerHeartbeat.unref();
  };

  const parar = (sinal) => {
    if (pararEmCurso) return pararEmCurso;
    parando = true;
    pararEmCurso = (async () => {
      logger.log(`[sentinel-worker] ${sinal}: terminando a conta corrente / a chamada ao ML corrente e encerrando.`);
      if (timer) { timers.clearTimeout(timer); timer = null; }
      if (timerHeartbeat) { timers.clearTimeout(timerHeartbeat); timerHeartbeat = null; }
      if (timerBootPolling) { timers.clearTimeout(timerBootPolling); timerBootPolling = null; }
      if (bootPollingEmCurso) await bootPollingEmCurso.catch(() => {});
      const forcado = setTimeout(() => {
        logger.error("[sentinel-worker] encerramento forçado (o trabalho corrente não terminou a tempo).");
        process.exit(1);
      }, SHUTDOWN_FORCADO_MS);
      if (typeof forcado.unref === "function") forcado.unref();
      await comTeto(Promise.all([
        cicloEmCurso ? cicloEmCurso.catch(() => {}) : null,
        agendador ? agendador.parar() : null,
      ]), ESPERA_TRABALHO_MAX_MS);
      // heartbeat de encerramento com teto: banco travado não pode segurar o shutdown (Render: ~30 s até o SIGKILL)
      await comTeto(heartbeat.encerrar(), HEARTBEAT_ENCERRAMENTO_MAX_MS);
      await Promise.all([db ? comTeto(db.end(), FECHAR_POOL_MAX_MS) : null, dbBilling ? comTeto(dbBilling.end(), FECHAR_POOL_MAX_MS) : null]);
      clearTimeout(forcado);
      resolverFim();
    })();
    return pararEmCurso;
  };

  // O polling é agendado PRIMEIRO: o Billing do boot já enxerga o ciclo em curso e espera por ele (adiamento).
  if (pollingAtivo) agendar(0);
  if (billingAtivo) {
    agendador = agendaBilling.criarAgendadorBilling({
      db: dbBilling, cfg: bcfg, instancia: ident.instancia, agora, timers, logger,
      executar: executarBilling, depsColeta: depsBilling,
      pollingEmCurso: () => cicloEmCurso, // o Billing espera o polling; o polling NUNCA espera o Billing
      aoTerminar: () => heartbeat.gravar(),
    });
    agendador.iniciar();
  }
  agendarHeartbeat();
  if (pollingConfigurado && !pollingAtivo) agendarBootPolling();
  return {
    iniciado: true, parar, fim, db, dbBilling, estado, heartbeat, agendador,
    get cicloEmCurso() { return cicloEmCurso; },
  };
}

// Ocioso (só no Render): nada habilitado ou boot falhou sem Billing. Sem trabalho, sem banco; um log por hora;
// SIGTERM encerra limpo.
function ficarOcioso({ motivo, logger = console, timers = { setInterval, clearInterval } } = {}) {
  logger.log(`[sentinel-worker] OCIOSO (motivo=${motivo}): nada a executar. No Render o processo fica vivo sem trabalho `
    + "(sair faria o Background Worker reiniciar em loop). SIGTERM encerra.");
  const t = timers.setInterval(() => logger.log(`[sentinel-worker] ocioso (motivo=${motivo}) — nenhum trabalho habilitado.`), OCIOSO_LOG_MS);
  let resolverFim;
  const fim = new Promise((r) => { resolverFim = r; });
  let parado = false;
  return {
    iniciado: false, ocioso: true, motivo, fim,
    parar: async () => { if (parado) return; parado = true; timers.clearInterval(t); resolverFim(); },
  };
}

function rodandoNoRender(env = process.env) {
  return String(env.RENDER || "").trim() !== "";
}

async function main({ env = process.env, iniciarFn = iniciar, processo = process, logger = console, timers, bootRetryMs = POLLING_BOOT_RETRY_MS } = {}) {
  const tm = timers || { setInterval, clearInterval, setTimeout, clearTimeout };
  const tentarIniciar = async () => {
    try {
      return await iniciarFn({ env, logger });
    } catch (err) {
      if (!rodandoNoRender(env)) throw err;
      logger.error(`[sentinel-worker] falha no boot (${err.code || "ERRO"}): ${agendaBilling.sanitizar(err.message, 200)}`);
      return { iniciado: false, motivo: "falha_boot" };
    }
  };
  let w = await tentarIniciar();
  if (!w.iniciado && !rodandoNoRender(env)) return w;
  let parado = false;
  let retry = null;
  const trocar = (novo) => { w = novo; };
  const onTerm = () => { parado = true; if (retry) { (tm.clearTimeout || clearTimeout)(retry); retry = null; } w.parar("SIGTERM"); };
  const onInt = () => { parado = true; if (retry) { (tm.clearTimeout || clearTimeout)(retry); retry = null; } w.parar("SIGINT"); };
  processo.on("SIGTERM", onTerm);
  processo.on("SIGINT", onInt);
  try {
    for (;;) {
      if (!w.iniciado) {
        const motivo = w.motivo;
        trocar(ficarOcioso({ motivo, logger, timers: tm }));
        // Boot FALHOU (banco fora no deploy, por exemplo): no Render o processo não sai mais (sairia em loop), então o
        // próprio main retenta — sem isto o polling ficaria parado até o próximo deploy. Tudo OFF: ocioso de verdade.
        if (motivo === "falha_boot") {
          const ocioso = w;
          retry = (tm.setTimeout || setTimeout)(async () => {
            retry = null;
            if (parado) return;
            const novo = await tentarIniciar();
            if (parado) { if (novo.iniciado) await novo.parar("SIGTERM"); return; }
            // troca ANTES de encerrar o ocioso: o laço do main acorda com o fim do ocioso e precisa já ver o novo estado
            // (novo ligado ⇒ aguarda o fim dele; nova falha ⇒ reabre um ocioso e agenda outra tentativa).
            trocar(novo);
            await ocioso.parar();
          }, bootRetryMs);
        }
      }
      const atual = w;
      await atual.fim;
      if (parado || w === atual) return w;
    }
  } finally {
    if (retry) { (tm.clearTimeout || clearTimeout)(retry); retry = null; }
    processo.removeListener("SIGTERM", onTerm);
    processo.removeListener("SIGINT", onInt);
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error(`[sentinel-worker] falhou: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  comTeto,
  workerHabilitado, lerAllowlist, criarPoolSentinel, criarPoolConciliacao, selecionarContas, executarTick,
  resumirCicloPolling, iniciar, ficarOcioso, rodandoNoRender, main,
};
