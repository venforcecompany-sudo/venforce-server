// server/services/centralVendas/retencao/centralVendasRetencaoExecutor.js
// Retenção da Central de Vendas — EXECUÇÃO (dry-run por padrão).
//
// Fluxo:
//   1. gate: só APLICA com apply=true E CENTRAL_VENDAS_RETENCAO_APPLY=true E
//      host local ou --confirm-host igual ao host (padrão do
//      sentinel-run-once). O gate roda ANTES de qualquer query. A retenção
//      automática pós-publicação usa o gate próprio (autorizacao "auto" ⇒
//      CENTRAL_VENDAS_RETENCAO_AUTO=true) — ver centralVendasRetencaoAuto.
//   2. plano numa transação READ ONLY (planner puro sobre o que o repository
//      leu). Dry-run termina aqui: nenhuma escrita.
//   3. lotes de imports (padrão 20), cada um numa transação curta:
//        SELECT … FOR UPDATE NOWAIT de TODAS as linhas de cada tupla do lote
//        → relê runs e refs → REPLANEJA a tupla → DELETE só de quem continua
//        elegível (pedidos/itens/componentes caem por ON DELETE CASCADE).
//      Lock: a publicação (promoverCandidatesDoRun) e o sync não usam
//      advisory lock por tupla — a publicação é um UPDATE atômico que trava
//      as linhas candidate. O FOR UPDATE nas linhas da tupla serializa contra
//      ele. NOWAIT: a retenção nunca espera; tupla ocupada ⇒ lote adiado
//      (próxima execução pega), e nunca entra num ciclo de espera em que o
//      detector de deadlock poderia abortar a PUBLICAÇÃO.
//   4. mp_payments: um run por transação; trava o run, confere que nenhum
//      import ainda aponta para ele, que é terminal e antigo, e DELETE por
//      sync_run_id (charges em cascata). sync_runs/sync_sources ficam.
// Limites: limiteLotes, limiteTempoMs, statement_timeout por lote; `sinal`
// ({ interrompido }) é checado ENTRE lotes (SIGINT termina após o corrente).
// Idempotente: uma 2ª execução replaneja do zero e encontra 0 elegíveis.

const { planejarRetencao, lerPolitica, chaveTupla, RUN_TERMINAIS } = require("./centralVendasRetencaoPlanner");
const repo = require("./centralVendasRetencaoRepository");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function hostDaUrl(url) {
  try { return new URL(url).hostname || null; } catch (_) { return null; }
}

function erroComCodigo(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function verificarPermissaoApply({ apply, env = process.env, host, confirmHost, autorizacao = "cli" } = {}) {
  if (apply !== true) return { permitido: false, motivo: "APPLY_NAO_SOLICITADO" };
  if (autorizacao === "auto") {
    return env.CENTRAL_VENDAS_RETENCAO_AUTO === "true"
      ? { permitido: true, motivo: null }
      : { permitido: false, motivo: "RETENCAO_AUTO_DESLIGADA" };
  }
  if (env.CENTRAL_VENDAS_RETENCAO_APPLY !== "true") return { permitido: false, motivo: "APPLY_ENV_AUSENTE" };
  if (!host) return { permitido: false, motivo: "HOST_DESCONHECIDO" };
  if (!LOCAL_HOSTS.has(host) && confirmHost !== host) return { permitido: false, motivo: "CONFIRM_HOST_INVALIDO" };
  return { permitido: true, motivo: null };
}

async function comTransacao(pool, fn, { readOnly = false, statementTimeoutMs = 60000, lockTimeoutMs = 5000 } = {}) {
  const client = await pool.connect();
  let descartar;
  try {
    await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(statementTimeoutMs))}`);
    await client.query(`SET LOCAL lock_timeout = ${Math.max(1, Math.floor(lockTimeoutMs))}`);
    const out = await fn(client);
    await client.query(readOnly ? "ROLLBACK" : "COMMIT");
    return out;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (rollbackErr) { descartar = rollbackErr; }
    throw err;
  } finally {
    client.release(descartar);
  }
}

function slugsDoEscopo(escopo) {
  if (escopo.tupla) return [escopo.tupla.cliente_slug];
  if (escopo.clienteSlug) return [escopo.clienteSlug];
  return null;
}

// Lê tudo do escopo e devolve o plano (sem escrever). `db` = client já dentro
// de uma transação (READ ONLY no dry-run).
async function planejarEscopo(db, { escopo = {}, cfg, incluirAuditoriaSyncJobs = true, comEstimativa = false } = {}) {
  const imports = await repo.carregarImports(db, { escopo });
  const runIdsImports = [...new Set(imports.filter((r) => r.sync_run_id != null).map((r) => Number(r.sync_run_id)))];
  const runs = await repo.carregarRuns(db, { runIds: runIdsImports, escopo });
  const runIdsMp = runs.filter((r) => r.tem_mp_payments).map((r) => Number(r.id));
  const refsRuns = await repo.carregarRunsReferenciadosForaDoEscopo(db, { runIds: runIdsMp, escopo });
  const { refs, fontesLidas } = await repo.carregarRefsProtegidas(db, { clienteSlugs: slugsDoEscopo(escopo), incluirAuditoriaSyncJobs });
  const plano = planejarRetencao({ imports, refsProtegidas: { imports: refs, runs: refsRuns }, runs, cfg });
  plano.fontesRefs = fontesLidas;
  if (comEstimativa) plano.espaco = await repo.estimarEspaco(db, plano);
  return { plano, imports };
}

// Agrupa os elegíveis por tupla (tuplas em ordem de chave) e corta em lotes de
// até `tamanhoLote` imports. Uma tupla maior que o lote é dividida.
function montarLotes(plano, imports, tamanhoLote) {
  const porId = new Map(imports.map((r) => [Number(r.id), r]));
  const porTupla = new Map();
  for (const id of plano.elegiveis) {
    const row = porId.get(id);
    const k = chaveTupla(row);
    if (!porTupla.has(k)) porTupla.set(k, { tupla: row, ids: [] });
    porTupla.get(k).ids.push(id);
  }
  const lotes = [];
  let atual = null;
  for (const k of [...porTupla.keys()].sort()) {
    const { tupla, ids } = porTupla.get(k);
    for (const id of ids) {
      if (!atual || atual.ids.length >= tamanhoLote) { atual = { ids: [], tuplas: new Map() }; lotes.push(atual); }
      atual.ids.push(id);
      atual.tuplas.set(k, {
        cliente_slug: tupla.cliente_slug, marketplace: tupla.marketplace,
        competencia: String(tupla.competencia).trim(), cliente_conta_id: tupla.cliente_conta_id,
      });
    }
  }
  return lotes;
}

async function aplicarLoteImports(client, lote, { cfg, incluirAuditoriaSyncJobs, exportDir, numero }) {
  const chaves = [...lote.tuplas.keys()].sort();
  const linhasTupla = [];
  for (const k of chaves) linhasTupla.push(...(await repo.carregarImports(client, { escopo: { tupla: lote.tuplas.get(k) }, forUpdate: true })));
  const runIds = [...new Set(linhasTupla.filter((r) => r.sync_run_id != null).map((r) => Number(r.sync_run_id)))];
  const runs = await repo.carregarRuns(client, { runIds, escopo: { tupla: true } });
  const slugs = [...new Set(chaves.map((k) => lote.tuplas.get(k).cliente_slug))];
  const { refs } = await repo.carregarRefsProtegidas(client, { clienteSlugs: slugs, incluirAuditoriaSyncJobs });
  const replano = planejarRetencao({ imports: linhasTupla, refsProtegidas: { imports: refs }, runs, cfg });
  const elegiveisAgora = new Set(replano.elegiveis);
  const alvo = lote.ids.filter((id) => elegiveisAgora.has(id));
  const desistidos = lote.ids.filter((id) => !elegiveisAgora.has(id)).map((id) => ({ id, motivos: replano.motivos[id]?.motivos || ["sumiu"] }));

  const contagem = await repo.contarFilhosPorImport(client, alvo);
  const linhas = { imports: 0, pedidos: 0, itens: 0, componentes: 0 };
  for (const c of contagem.values()) for (const k of Object.keys(linhas)) linhas[k] += c[k];

  let arquivos = null;
  if (exportDir && alvo.length) arquivos = await repo.exportarImportsCsv(client, alvo, { dir: exportDir, prefixo: `lote-${String(numero).padStart(4, "0")}` });
  const removidos = alvo.length
    ? (await client.query("DELETE FROM central_vendas_imports WHERE id = ANY($1::bigint[]) RETURNING id", [alvo])).rows.map((r) => Number(r.id))
    : [];
  linhas.imports = removidos.length;
  return { removidos, desistidos, linhas, arquivos };
}

async function aplicarRunMp(client, runId, { cfg }) {
  const run = await client.query(
    "SELECT id, status, created_at, finished_at FROM central_vendas_sync_runs WHERE id = $1 FOR UPDATE NOWAIT",
    [runId]
  );
  const r = run.rows[0];
  if (!r) return { removido: false, motivo: "run_inexistente", linhas: {} };
  if (!RUN_TERMINAIS.has(r.status)) return { removido: false, motivo: `run_${r.status}`, linhas: {} };
  const agora = cfg.agora != null ? new Date(cfg.agora).getTime() : Date.now();
  const idade = new Date(r.finished_at || r.created_at).getTime();
  if (!(idade <= agora - cfg.minIdadeHoras * 3600 * 1000)) return { removido: false, motivo: "run_recente", linhas: {} };
  const ref = await client.query("SELECT id FROM central_vendas_imports WHERE sync_run_id = $1 LIMIT 1", [runId]);
  if (ref.rows.length) return { removido: false, motivo: "run_de_import_retido", linhas: {} };
  const contagem = (await repo.contarMpPorRun(client, [runId])).get(Number(runId));
  await client.query("DELETE FROM central_vendas_mp_payments WHERE sync_run_id = $1", [runId]);
  return { removido: true, motivo: null, linhas: contagem };
}

async function executarRetencao({
  pool,
  escopo = {},
  cfg: cfgEntrada = null,
  apply = false,
  autorizacao = "cli",
  host = null,
  confirmHost = null,
  env = process.env,
  incluirAuditoriaSyncJobs = true,
  tamanhoLote = 20,
  limiteLotes = Infinity,
  limiteTempoMs = 15 * 60 * 1000,
  statementTimeoutMs = 60000,
  exportDir = null,
  comEstimativa = false,
  sinal = { interrompido: false },
  logger = console,
  depoisDoPlano = null, // injeção em teste: roda entre o plano e os lotes
} = {}) {
  const cfg = { ...lerPolitica(env), ...(cfgEntrada || {}) };
  if (apply) {
    const permissao = verificarPermissaoApply({ apply, env, host, confirmHost, autorizacao });
    if (!permissao.permitido) throw erroComCodigo(permissao.motivo, `Retenção recusada: ${permissao.motivo}`);
  }

  const inicio = Date.now();
  const { plano, imports } = await comTransacao(
    pool,
    (db) => planejarEscopo(db, { escopo, cfg, incluirAuditoriaSyncJobs, comEstimativa }),
    { readOnly: true, statementTimeoutMs: Math.max(statementTimeoutMs, 300000) }
  );
  const resultado = {
    modo: apply ? "apply" : "dry-run",
    plano,
    lotes: [],
    totais: { importsRemovidos: 0, mpRunsLimpos: 0, linhas: { imports: 0, pedidos: 0, itens: 0, componentes: 0, mp_payments: 0, mp_payment_charges: 0 } },
    interrompido: false,
    motivoParada: null,
    erro: null,
  };
  if (!apply) return resultado;
  if (depoisDoPlano) await depoisDoPlano(plano);

  const somar = (linhas) => { for (const [k, n] of Object.entries(linhas || {})) resultado.totais.linhas[k] += n; };
  const podeContinuar = () => {
    if (sinal.interrompido) { resultado.interrompido = true; resultado.motivoParada = "SIGINT"; return false; }
    if (resultado.lotes.length >= limiteLotes) { resultado.motivoParada = "LIMITE_LOTES"; return false; }
    if (Date.now() - inicio >= limiteTempoMs) { resultado.motivoParada = "LIMITE_TEMPO"; return false; }
    return true;
  };

  const lotes = montarLotes(plano, imports, Math.max(1, tamanhoLote));
  for (const lote of lotes) {
    if (!podeContinuar()) return resultado;
    const numero = resultado.lotes.length + 1;
    const t0 = Date.now();
    try {
      const r = await comTransacao(pool, (client) => aplicarLoteImports(client, lote, { cfg, incluirAuditoriaSyncJobs, exportDir, numero }), { statementTimeoutMs });
      somar(r.linhas);
      resultado.totais.importsRemovidos += r.removidos.length;
      resultado.lotes.push({ numero, tipo: "imports", ids: lote.ids, removidos: r.removidos, desistidos: r.desistidos, linhas: r.linhas, arquivos: r.arquivos, ms: Date.now() - t0 });
      logger.log(`[retencao] lote ${numero} imports: removidos=${r.removidos.length}/${lote.ids.length} pedidos=${r.linhas.pedidos} itens=${r.linhas.itens} componentes=${r.linhas.componentes}${r.desistidos.length ? ` desistidos=${r.desistidos.map((d) => d.id).join(",")}` : ""} (${Date.now() - t0} ms)`);
    } catch (err) {
      if (err && err.code === "55P03") {
        resultado.lotes.push({ numero, tipo: "imports", ids: lote.ids, adiado: "tupla_ocupada", removidos: [], linhas: {}, ms: Date.now() - t0 });
        logger.log(`[retencao] lote ${numero} adiado: tupla em uso (lock) — próxima execução reavalia`);
        continue;
      }
      resultado.erro = { lote: numero, code: err?.code || null, message: err?.message };
      resultado.motivoParada = "ERRO";
      logger.error(`[retencao] lote ${numero} falhou (nada deste lote foi removido): ${err?.code || ""} ${err?.message}`);
      return resultado;
    }
  }

  if (cfg.incluirMpPayments) {
    for (const runId of plano.mp.elegiveis) {
      if (!podeContinuar()) return resultado;
      const numero = resultado.lotes.length + 1;
      const t0 = Date.now();
      try {
        const r = await comTransacao(pool, (client) => aplicarRunMp(client, runId, { cfg }), { statementTimeoutMs });
        if (r.removido) { resultado.totais.mpRunsLimpos += 1; somar(r.linhas); }
        resultado.lotes.push({ numero, tipo: "mp_payments", runId, removido: r.removido, motivo: r.motivo, linhas: r.linhas, ms: Date.now() - t0 });
        logger.log(`[retencao] lote ${numero} mp run=${runId}: ${r.removido ? `payments=${r.linhas.mp_payments} charges=${r.linhas.mp_payment_charges}` : `mantido (${r.motivo})`}`);
      } catch (err) {
        if (err && err.code === "55P03") {
          resultado.lotes.push({ numero, tipo: "mp_payments", runId, removido: false, motivo: "run_ocupado", linhas: {}, ms: Date.now() - t0 });
          continue;
        }
        resultado.erro = { lote: numero, code: err?.code || null, message: err?.message };
        resultado.motivoParada = "ERRO";
        logger.error(`[retencao] lote ${numero} mp run=${runId} falhou: ${err?.code || ""} ${err?.message}`);
        return resultado;
      }
    }
  }
  resultado.motivoParada = "CONCLUIDO";
  return resultado;
}

module.exports = {
  executarRetencao,
  planejarEscopo,
  verificarPermissaoApply,
  montarLotes,
  hostDaUrl,
  LOCAL_HOSTS,
};
