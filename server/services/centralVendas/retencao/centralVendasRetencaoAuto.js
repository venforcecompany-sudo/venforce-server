// server/services/centralVendas/retencao/centralVendasRetencaoAuto.js
// Retenção automática pós-publicação (prevenção do crescimento).
//
// Desligada por padrão: só age com CENTRAL_VENDAS_RETENCAO_AUTO=true. Quando
// ligada, depois de um publicarRun bem-sucedido roda o executor SÓ para as
// tuplas dos imports publicados, fora do caminho da publicação (agendado
// com setImmediate). Nunca lança, nunca atrasa a publicação: qualquer erro
// vira log. Política (minIdadeHoras, manterUltimos…) = a mesma do CLI, via
// env — com o padrão de 72 h, o que sai aqui são os substituídos há mais de
// 3 dias, nunca o import recém-substituído.
//
// Proteção do pool do servidor (revisão de concorrência):
//   - fila SINGLE-FLIGHT por processo: no máximo UMA retenção rodando. Uma
//     publicação durante a execução só acrescenta seus imports ao conjunto
//     pendente, drenado em seguida pela mesma tarefa;
//   - rodada pulada quando o pool tem cliente esperando conexão
//     (pool.waitingCount > 0) — os pendentes ficam para a próxima publicação;
//   - statement_timeout 15 s e lock_timeout 2 s também no PLANEJAMENTO, e
//     limiteTempoMs checado entre as etapas (executor).

const { executarRetencao } = require("./centralVendasRetencaoExecutor");

const OPCOES_AUTO = Object.freeze({
  limiteLotes: 10,
  limiteTempoMs: 2 * 60 * 1000,
  statementTimeoutMs: 15000,
  statementTimeoutPlanoMs: 15000,
  lockTimeoutMs: 2000,
});

// Estado do processo. `pendentes` = imports publicados ainda não processados
// (as tuplas saem deles no início de cada rodada, deduplicadas).
const estado = { executando: false, pendentes: new Set(), ocioso: Promise.resolve(), contexto: null };

function retencaoAutoLigada(env = process.env) {
  return env.CENTRAL_VENDAS_RETENCAO_AUTO === "true";
}

function isPoolLike(db) {
  return typeof db?.connect === "function" && typeof db?.release !== "function";
}

function poolComEspera(db) {
  return Number(db?.waitingCount) > 0;
}

async function processarTupla(tupla, { db, env, logger, executar }) {
  const r = await executar({ pool: db, escopo: { tupla }, apply: true, autorizacao: "auto", env, logger, ...OPCOES_AUTO });
  logger.log(
    `[retencao-auto] ${tupla.cliente_slug}/${tupla.marketplace}/${String(tupla.competencia).trim()}/conta=${tupla.cliente_conta_id ?? "NULL"}: `
    + `imports removidos=${r.totais.importsRemovidos} mp runs=${r.totais.mpRunsLimpos} (${r.motivoParada})`
  );
  if (r.erro) logger.error(`[retencao-auto] erro: ${r.erro.code || ""} ${r.erro.message}`);
}

// Drena os pendentes, uma rodada por vez. Publicações que chegam durante a
// rodada entram em `pendentes` e são pegas pela rodada seguinte.
async function drenar() {
  const { db, env, logger, executar } = estado.contexto;
  while (estado.pendentes.size) {
    if (poolComEspera(db)) {
      logger.log(`[retencao-auto] adiada: pool com espera (waitingCount=${db.waitingCount}); ${estado.pendentes.size} imports pendentes`);
      return;
    }
    const ids = [...estado.pendentes];
    estado.pendentes.clear();
    const { rows: tuplas } = await db.query(
      `SELECT DISTINCT cliente_slug, marketplace, competencia, cliente_conta_id
         FROM central_vendas_imports
        WHERE id = ANY($1::bigint[])`,
      [ids]
    );
    for (const tupla of tuplas) {
      if (poolComEspera(db)) {
        logger.log("[retencao-auto] adiada: pool com espera");
        return;
      }
      try {
        await processarTupla(tupla, { db, env, logger, executar });
      } catch (err) {
        logger.error(`[retencao-auto] falhou (publicação não afetada): ${err?.code || ""} ${err?.message}`);
      }
    }
  }
}

function iniciar(agendar) {
  estado.executando = true;
  let sinalizarOcioso;
  estado.ocioso = new Promise((resolve) => { sinalizarOcioso = resolve; });
  const tarefa = () => drenar()
    .catch((err) => estado.contexto.logger.error(`[retencao-auto] falhou (publicação não afetada): ${err?.code || ""} ${err?.message}`))
    .finally(() => {
      estado.executando = false;
      sinalizarOcioso();
    });
  try {
    agendar(tarefa);
  } catch (err) {
    estado.executando = false;
    sinalizarOcioso();
    throw err;
  }
}

function agendarRetencaoAposPublicacao({
  importIds = [], db, env = process.env, logger = console, executar = executarRetencao, agendar = setImmediate,
} = {}) {
  try {
    if (!retencaoAutoLigada(env)) return { agendado: false, motivo: "desligado" };
    if (!Array.isArray(importIds) || !importIds.length) return { agendado: false, motivo: "sem_imports" };
    if (!isPoolLike(db)) return { agendado: false, motivo: "db_sem_pool" };
    for (const id of importIds) if (Number.isFinite(Number(id))) estado.pendentes.add(Number(id));
    if (estado.executando) return { agendado: true, motivo: "enfileirado" };
    estado.contexto = { db, env, logger, executar };
    iniciar(agendar);
    return { agendado: true, motivo: null };
  } catch (err) {
    try { logger.error(`[retencao-auto] não agendada: ${err?.message}`); } catch (_) { /* nunca propaga */ }
    return { agendado: false, motivo: "erro" };
  }
}

// Teste/diagnóstico: promise que resolve quando a fila esvaziar.
function aguardarOcioso() {
  return estado.ocioso;
}

module.exports = { agendarRetencaoAposPublicacao, retencaoAutoLigada, aguardarOcioso, OPCOES_AUTO };
