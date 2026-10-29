// server/services/centralVendas/retencao/centralVendasRetencaoAuto.js
// Retenção automática pós-publicação (prevenção do crescimento).
//
// Desligada por padrão: só age com CENTRAL_VENDAS_RETENCAO_AUTO=true. Quando
// ligada, depois de um publicarRun bem-sucedido roda o executor SÓ para as
// tuplas dos imports publicados, fora do caminho da publicação (agendado
// com setImmediate). Nunca lança, nunca atrasa a publicação: qualquer erro
// vira log. Política (minIdadeHoras, manterUltimos…) = a mesma do CLI, via
// env — com o padrão de 72 h, o que sai aqui são os substituídos com mais
// de 3 dias, nunca o import recém-substituído.

const { executarRetencao } = require("./centralVendasRetencaoExecutor");

function retencaoAutoLigada(env = process.env) {
  return env.CENTRAL_VENDAS_RETENCAO_AUTO === "true";
}

function isPoolLike(db) {
  return typeof db?.connect === "function" && typeof db?.release !== "function";
}

async function rodarParaImports({ importIds, db, env, logger, executar }) {
  const { rows: tuplas } = await db.query(
    `SELECT DISTINCT cliente_slug, marketplace, competencia, cliente_conta_id
       FROM central_vendas_imports
      WHERE id = ANY($1::bigint[])`,
    [importIds.map(Number)]
  );
  for (const tupla of tuplas) {
    const r = await executar({
      pool: db, escopo: { tupla }, apply: true, autorizacao: "auto", env, logger,
      limiteLotes: 10, limiteTempoMs: 2 * 60 * 1000,
    });
    logger.log(
      `[retencao-auto] ${tupla.cliente_slug}/${tupla.marketplace}/${String(tupla.competencia).trim()}/conta=${tupla.cliente_conta_id ?? "NULL"}: `
      + `imports removidos=${r.totais.importsRemovidos} mp runs=${r.totais.mpRunsLimpos} (${r.motivoParada})`
    );
    if (r.erro) logger.error(`[retencao-auto] erro: ${r.erro.code || ""} ${r.erro.message}`);
  }
}

function agendarRetencaoAposPublicacao({
  importIds = [], db, env = process.env, logger = console, executar = executarRetencao, agendar = setImmediate,
} = {}) {
  try {
    if (!retencaoAutoLigada(env)) return { agendado: false, motivo: "desligado" };
    if (!Array.isArray(importIds) || !importIds.length) return { agendado: false, motivo: "sem_imports" };
    if (!isPoolLike(db)) return { agendado: false, motivo: "db_sem_pool" };
    agendar(() => rodarParaImports({ importIds, db, env, logger, executar })
      .catch((err) => logger.error(`[retencao-auto] falhou (publicação não afetada): ${err?.code || ""} ${err?.message}`)));
    return { agendado: true, motivo: null };
  } catch (err) {
    try { logger.error(`[retencao-auto] não agendada: ${err?.message}`); } catch (_) { /* nunca propaga */ }
    return { agendado: false, motivo: "erro" };
  }
}

module.exports = { agendarRetencaoAposPublicacao, retencaoAutoLigada };
