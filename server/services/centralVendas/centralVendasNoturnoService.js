// server/services/centralVendas/centralVendasNoturnoService.js
// Orquestrador da sincronização automática da Central de Vendas (cron
// noturno e backfill manual). NÃO é um motor novo: para cada conta elegível
// chama as MESMAS portas do sync manual —
//   centralVendasSyncRunService.criarSyncRun   (identidade + dedupe + lock do banco)
//   centralVendasSyncWorker.executarSyncRun    (coleta + persistência + publicação)
// — e, depois, o adaptador centralVendasCliente360Adapter (snapshot do Painel
// a partir do que a Central persistiu, sem nova chamada à Orders API).
//
// Auditoria: venforce_md/Auditorias/Sync_Central_Vendas_Noturno/
//   §8  unidade = CONTA (cliente_id + cliente_conta_id + marketplace + período)
//   §9  elegíveis = cliente_contas meli ativas de clientes ativos
//   §10 só Mercado Livre (é o contrato de criarSyncRun, não uma escolha daqui)
//   §11 período = mês corrente (dia 1 → ontem) + mês anterior completo nos
//       primeiros dias do mês
//   §12 concorrência pequena e explícita, própria do orquestrador
//   §13 idempotência = a do sync_run (índice único parcial), sem lock novo
//
// Por que chamar executarSyncRun direto (e não enfileirar): o Render Cron Job
// é outro processo; a fila in-process do worker web não existe aqui (§6).

const pool = require("../../config/database");
const { comRetryTransitorio } = require("./centralVendasTransientRetry");
const { comPrazo } = require("../../utils/comPrazo");
const { prazos } = require("./centralVendasPrazos");

const TIMEZONE = "America/Sao_Paulo";
const MARKETPLACE = "meli";
// §11: nos primeiros dias do mês o mês anterior ainda muda (status/ajustes de
// virada) — reprocessa-o completo até este dia (inclusive).
const DIAS_REPROCESSO_MES_ANTERIOR = 5;
// Depois do dia 5 o mês anterior só volta a ser sincronizado para as contas
// cujo import publicado NÃO cobre o mês inteiro (rodadas dos dias 1..5
// perdidas — scheduler desligado/preso, restart, conta que falhou). Até este
// dia (inclusive); CENTRAL_VENDAS_NOTURNO_COMPLETAR_MES_ANTERIOR_ATE_DIA
// ajusta (0..28; <= 5 desliga).
const COMPLETAR_MES_ANTERIOR_ATE_DIA_PADRAO = 15;
// Janela da retomada no boot: só pendências noturnas criadas nas últimas N
// horas são retomadas; as mais antigas viram SYNC_RUN_ORPHAN_EXPIRED.
// CENTRAL_VENDAS_NOTURNO_RECUPERACAO_HORAS ajusta (1..168).
const RECUPERACAO_HORAS_PADRAO = 24;
const CONCORRENCIA_PADRAO = 3; // §12: "3 a 5, começar conservador"
const CONCORRENCIA_MAXIMA = 10;
// Run equivalente já em execução por OUTRO processo (clique manual no
// serviço web): o cron observa até o estado final em vez de rodar de novo.
const OBSERVAR_INTERVALO_MS = 10000;
const OBSERVAR_TIMEOUT_MS = 20 * 60 * 1000;

const LOG = "[cron-central]";

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

function resolverInteiro(valor, padrao, min, max) {
  const n = Number.parseInt(valor, 10);
  if (!Number.isFinite(n) || n < min) return padrao;
  return Math.min(n, max);
}

function resolverCompletarAteDia(valor) {
  return resolverInteiro(valor, COMPLETAR_MES_ANTERIOR_ATE_DIA_PADRAO, 0, 28);
}

function resolverRecuperacaoHoras(valor) {
  return resolverInteiro(valor, RECUPERACAO_HORAS_PADRAO, 1, 168);
}

function resolverConcorrencia(valor, padrao = CONCORRENCIA_PADRAO) {
  const n = Number.parseInt(valor, 10);
  if (!Number.isFinite(n) || n < 1) return padrao;
  return Math.min(n, CONCORRENCIA_MAXIMA);
}

// ---------------------------------------------------------------------------
// Datas (sempre no fuso de negócio, nunca no fuso do container — Render é UTC)
// ---------------------------------------------------------------------------

function hojeNoFuso(agora = new Date(), timeZone = TIMEZONE) {
  // en-CA formata como YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(agora);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ultimoDiaDoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

function periodoDoMes(ano, mes) {
  const competencia = `${ano}-${pad2(mes)}`;
  return { competencia, dateFrom: `${competencia}-01`, dateTo: `${competencia}-${pad2(ultimoDiaDoMes(ano, mes))}` };
}

function mesAnterior(ano, mes) {
  return mes === 1 ? { ano: ano - 1, mes: 12 } : { ano, mes: mes - 1 };
}

// Data de calendário REAL (não só o formato): "2026-13-40" casa com a regex
// mas geraria o período 2026-13-01..2026-13-39.
function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [ano, mes, dia] = value.split("-").map(Number);
  return mes >= 1 && mes <= 12 && dia >= 1 && dia <= ultimoDiaDoMes(ano, mes);
}

// §11 — janela determinística (mesma tupla toda vez para o mesmo dia, para o
// dedupe por tupla do sync_run casar com um clique manual equivalente):
//   dia 1       → só o mês anterior completo (o "mês corrente até ontem" É ele)
//   dias 2..5   → mês corrente [dia 1, ontem] + mês anterior completo
//   dias 6..fim → mês corrente [dia 1, ontem]
function calcularPeriodosNoturnos(hoje) {
  if (!isIsoDate(hoje)) throw new Error(`Data de referencia invalida: ${hoje}`);
  const [ano, mes, dia] = hoje.split("-").map(Number);
  const anterior = mesAnterior(ano, mes);
  const periodoAnterior = periodoDoMes(anterior.ano, anterior.mes);

  if (dia === 1) return [periodoAnterior];

  const competencia = `${ano}-${pad2(mes)}`;
  const correnteAteOntem = { competencia, dateFrom: `${competencia}-01`, dateTo: `${competencia}-${pad2(dia - 1)}` };
  return dia <= DIAS_REPROCESSO_MES_ANTERIOR ? [periodoAnterior, correnteAteOntem] : [correnteAteOntem];
}

// Mês anterior COMPLETO a completar nesta data (dias 6..ateDia), ou null.
// Dias 1..5 já o incluem para todas as contas (calcularPeriodosNoturnos).
function periodoMesAnteriorACompletar(hoje, ateDia = COMPLETAR_MES_ANTERIOR_ATE_DIA_PADRAO) {
  if (!isIsoDate(hoje)) throw new Error(`Data de referencia invalida: ${hoje}`);
  const [ano, mes, dia] = hoje.split("-").map(Number);
  if (dia <= DIAS_REPROCESSO_MES_ANTERIOR || dia > ateDia) return null;
  const anterior = mesAnterior(ano, mes);
  return periodoDoMes(anterior.ano, anterior.mes);
}

// §23 — backfill: N meses COMPLETOS anteriores ao mês corrente (o mês
// corrente fica com o cron diário). Nunca "todo o histórico" por padrão.
function calcularPeriodosBackfill(hoje, meses) {
  if (!isIsoDate(hoje)) throw new Error(`Data de referencia invalida: ${hoje}`);
  const n = Number.parseInt(meses, 10);
  if (!Number.isFinite(n) || n < 1 || n > 12) {
    throw new Error("--meses e obrigatorio no backfill e deve estar entre 1 e 12.");
  }
  let [ano, mes] = hoje.split("-").map(Number);
  const periodos = [];
  for (let i = 0; i < n; i++) {
    ({ ano, mes } = mesAnterior(ano, mes));
    periodos.push(periodoDoMes(ano, mes));
  }
  return periodos.reverse(); // do mais antigo para o mais recente
}

// ---------------------------------------------------------------------------
// Contas elegíveis (§9) — fonte única: cliente_contas. Independe de Squad/
// carteira: o cron não é um usuário e não passa por autorização de carteira.
// Lê TODAS as contas para poder contar as ignoradas e dizer por quê.
// ---------------------------------------------------------------------------

function motivoInelegibilidade(row) {
  if (row.cliente_ativo === false) return "cliente_inativo";
  if (row.conta_ativa === false) return "conta_inativa";
  if (String(row.marketplace || "").toLowerCase() !== MARKETPLACE) return "marketplace_nao_suportado";
  // Conta ML cadastrada mas nunca conectada (OAuth "aguardando"): sem seller
  // não há o que sincronizar — criarSyncRun recusaria com GRANT_UNAVAILABLE.
  if (!String(row.external_account_id || "").trim()) return "conta_sem_mercado_livre_conectado";
  return null;
}

function classificarContas(rows, { clientes = null } = {}) {
  const filtro = Array.isArray(clientes) && clientes.length
    ? new Set(clientes.map((s) => String(s).trim().toLowerCase()))
    : null;
  const escopo = filtro ? rows.filter((r) => filtro.has(String(r.cliente_slug).toLowerCase())) : rows;

  const elegiveis = [];
  const ignoradas = [];
  for (const row of escopo) {
    const conta = {
      clienteId: Number(row.cliente_id),
      clienteSlug: row.cliente_slug,
      clienteNome: row.cliente_nome,
      clienteContaId: Number(row.cliente_conta_id),
      contaNome: row.conta_nome || null,
      marketplace: row.marketplace,
    };
    const motivo = motivoInelegibilidade(row);
    if (motivo) ignoradas.push({ ...conta, motivo });
    else elegiveis.push(conta);
  }
  return { total: escopo.length, elegiveis, ignoradas };
}

async function listarContas(db = pool) {
  const { rows } = await db.query(
    `SELECT cc.id AS cliente_conta_id, cc.cliente_id, cc.marketplace, cc.external_account_id,
            cc.ativo AS conta_ativa, cc.nome AS conta_nome,
            c.slug AS cliente_slug, c.nome AS cliente_nome, c.ativo AS cliente_ativo
       FROM cliente_contas cc
       JOIN clientes c ON c.id = cc.cliente_id
      ORDER BY c.nome ASC, cc.id ASC`
  );
  return rows;
}

// Contas cujo import PUBLICADO da competência não cobre o mês inteiro (ou que
// não têm import publicado). Só leitura. A elegibilidade (ML, ativa, conectada)
// continua sendo decidida por classificarContas.
async function listarContasComMesIncompleto({ competencia, dateFrom, dateTo }, db = pool) {
  const { rows } = await db.query(
    `/* cv:noturno-mes-incompleto */
     SELECT cc.id AS cliente_conta_id
       FROM cliente_contas cc
      WHERE NOT EXISTS (
              SELECT 1 FROM central_vendas_imports i
               WHERE i.cliente_conta_id = cc.id
                 AND i.competencia = $1
                 AND i.publication_status = 'published'
                 AND i.coverage_date_from <= $2::date
                 AND i.coverage_date_to >= $3::date
            )`,
    [competencia, dateFrom, dateTo]
  );
  return new Set(rows.map((r) => Number(r.cliente_conta_id)));
}

// ---------------------------------------------------------------------------
// Pool de concorrência simples (sem dependência externa): no máximo
// `limite` tarefas em voo; uma rejeição nunca derruba as demais.
// ---------------------------------------------------------------------------

async function executarComConcorrencia(itens, limite, tarefa) {
  const resultados = new Array(itens.length);
  let proximo = 0;
  async function trabalhador() {
    while (proximo < itens.length) {
      const indice = proximo++;
      try {
        resultados[indice] = { ok: true, valor: await tarefa(itens[indice], indice) };
      } catch (err) {
        resultados[indice] = { ok: false, erro: err };
      }
    }
  }
  const n = Math.max(1, Math.min(limite, itens.length));
  await Promise.all(Array.from({ length: n }, trabalhador));
  return resultados;
}

// ---------------------------------------------------------------------------
// Execução de UMA unidade (conta × período)
// ---------------------------------------------------------------------------

function defaultDeps() {
  const runService = require("./centralVendasSyncRunService");
  const worker = require("./centralVendasSyncWorker");
  const adapter = require("./centralVendasCliente360Adapter");
  const adsSync = require("./centralVendasAdsSyncService");
  const adsJanela = require("./centralVendasAdsJanela");
  const repository = require("./centralVendasRepository");
  return {
    db: pool,
    listarContas,
    ensureCentralVendasTables: repository.ensureCentralVendasTables,
    criarSyncRun: runService.criarSyncRun,
    obterSyncRun: runService.obterSyncRun,
    marcarRunFailed: runService.marcarRunFailed,
    executarSyncRun: worker.executarSyncRun,
    sincronizarAdsCliente: adsSync.sincronizarAdsCliente,
    adsDaJanelaHabilitado: (c) => adsJanela.isAdsDaJanelaHabilitado(c),
    gravarAdsDaJanela: adsJanela.gravarAdsDaJanela,
    reconstruirSnapshotMensal: adapter.reconstruirSnapshotMensal,
    listarPeriodosNoturnosPendentes: runService.listarPeriodosNoturnosPendentes,
    reconciliarRunsNoturnosInterrompidos: runService.reconciliarRunsNoturnosInterrompidos,
    expirarRunsNoturnosOrfaos: runService.expirarRunsNoturnosOrfaos,
    listarContasComMesIncompleto: (p, db) => listarContasComMesIncompleto(p, db),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: Math.random,
    agora: () => Date.now(),
    observarIntervaloMs: OBSERVAR_INTERVALO_MS,
    observarTimeoutMs: OBSERVAR_TIMEOUT_MS,
    // Prazos (incidente P0 2026-10-02): sem eles, 3 unidades presas ocupam as 3 vagas da rodada até um restart.
    unidadeTimeoutMs: prazos().unidadeMs,
    fechamentoTimeoutMs: prazos().fechamentoMs,
    logger: console,
  };
}

// Ads POR CONTA na janela do run (centralVendasAdsJanela), flag desligada por
// padrão. Só depois do Ads do grupo dar certo; erro aqui nunca muda o
// resultado da rodada (só log) e nada é gravado em ads_resumos_mensais.
async function registrarAdsDaJanelaDoGrupo(grupo, rotulo, deps) {
  const porConta = Array.isArray(grupo.ads?.porConta) ? grupo.ads.porConta : [];
  if (!porConta.length || typeof deps.adsDaJanelaHabilitado !== "function" || typeof deps.gravarAdsDaJanela !== "function") return;
  for (const r of grupo.resultados) {
    let habilitado = false;
    try { habilitado = !!deps.adsDaJanelaHabilitado({ clienteContaId: r?.clienteContaId }); } catch (_) { habilitado = false; }
    if (!r || !r.publicado || !r.runId || !habilitado) continue;
    const ads = porConta.find((x) => Number(x.clienteContaId) === Number(r.clienteContaId));
    if (!ads || ads.dateFrom !== r.dateFrom || ads.dateTo !== r.dateTo) continue;
    try {
      const ok = await deps.gravarAdsDaJanela(deps.db, { runId: r.runId, ...ads });
      deps.logger.log(`${LOG} ads da janela ${rotulo} conta=${r.clienteContaId} run=#${r.runId} ${ok ? "gravado" : "nao gravado (run/janela nao conferem)"}`);
    } catch (err) {
      const e = resumirErro(err);
      deps.logger.warn(`${LOG} ads da janela ${rotulo} conta=${r.clienteContaId} nao gravado: ${e.code ? `${e.code} ` : ""}${e.message}`);
    }
  }
}

async function listarImportsPublicadosDoRun(runId, db) {
  const { rows } = await db.query(
    `SELECT id, competencia FROM central_vendas_imports
      WHERE sync_run_id = $1 AND publication_status = 'published'`,
    [runId]
  );
  return rows;
}

// Mensagem de erro para log/resumo: só code + mensagem curta e sanitizada.
// Nunca o objeto inteiro (um erro de rede pode carregar request/headers).
// sanitizeErrorMessage (mlTokenService) já remove Bearer/access_token/
// refresh_token/client_secret/APP_USR-*; aqui só completa com password/
// secret/authorization genéricos.
function resumirErro(err) {
  const { sanitizeErrorMessage } = require("../mlTokenService");
  const code = err?.code != null ? String(err.code) : null;
  const msg = sanitizeErrorMessage(String(err?.message || "erro desconhecido"))
    .replace(/\b(password|secret|authorization)\b\s*[=:]\s*[^\s,;&]+/gi, "$1=[redacted]")
    .slice(0, 300);
  return { code, message: msg };
}

function rotuloConta(conta) {
  return `${conta.clienteSlug}#${conta.clienteContaId}`;
}

async function aguardarRunFinal({ runId, clienteSlug }, deps) {
  const inicio = deps.agora();
  for (;;) {
    const run = await deps.obterSyncRun({ runId, clienteSlug, db: deps.db });
    if (run.status === "completed" || run.status === "failed") return run;
    if (deps.agora() - inicio >= deps.observarTimeoutMs) return run;
    await deps.sleep(deps.observarIntervaloMs);
  }
}

// Preparação/criação/reuso do sync_run de UMA unidade. Repete SÓ 40P01/40001
// (deadlock/serialização do PostgreSQL), no máximo 3 tentativas totais, com
// backoff curto + jitter. É seguro repetir: criarSyncRun deduplica pelo run
// ativo/publicado equivalente e pelo índice único, então a 2ª tentativa acha o
// run da 1ª (se ela chegou a inserir) em vez de criar outro. Não envolve nenhuma
// chamada à API do Mercado Livre — só o trabalho de banco da preparação.
function criarSyncRunDaUnidade(conta, periodo, deps) {
  return comRetryTransitorio(
    () => deps.criarSyncRun({
      clienteSlug: conta.clienteSlug,
      clienteContaId: conta.clienteContaId,
      marketplace: MARKETPLACE,
      dateFrom: periodo.dateFrom,
      dateTo: periodo.dateTo,
      requestedBy: null,
      reutilizarCompletedPublicado: true,
      db: deps.db,
    }),
    {
      sleep: deps.sleep,
      random: deps.random,
      onRetry: ({ tentativa, maxTentativas, err }) => {
        deps.logger.warn(
          `${LOG} preparação retry ${tentativa}/${maxTentativas} cliente=${conta.clienteSlug} conta=${conta.clienteContaId} erro=${err.code}`
        );
      },
    }
  );
}

async function processarUnidade(unidade, deps) {
  const { conta, periodo } = unidade;
  const rotulo = `${rotuloConta(conta)} ${periodo.dateFrom}..${periodo.dateTo}`;
  const base = {
    clienteId: conta.clienteId,
    clienteSlug: conta.clienteSlug,
    clienteContaId: conta.clienteContaId,
    competencia: periodo.competencia,
    dateFrom: periodo.dateFrom,
    dateTo: periodo.dateTo,
    runId: null,
    reaproveitado: false,
    executadoPor: null,
    publicado: false,
  };
  deps.logger.log(`${LOG} conta ${rotulo} iniciada`);

  let criado = unidade.criado || null;
  try {
    if (unidade.preparacaoErro) throw unidade.preparacaoErro;
    if (!criado) criado = await criarSyncRunDaUnidade(conta, periodo, deps);
  } catch (err) {
    const erro = resumirErro(err);
    deps.logger.error(`${LOG} conta ${rotulo} erro: ${erro.code ? `${erro.code} ` : ""}${erro.message}`);
    return { ...base, status: "falha", erro };
  }

  const { run, context, reaproveitado } = criado;
  base.runId = run.id;
  base.reaproveitado = !!reaproveitado;
  deps.logger.log(`${LOG} conta ${rotulo} runId=${run.id}${reaproveitado ? " (reaproveitado)" : ""}`);

  // Run 'queued' (novo, ou reaproveitado ainda na fila de outro processo):
  // executarSyncRun reivindica atomicamente (UPDATE ... WHERE status='queued').
  // Se outro executor ganhou, devolve null e o cron só observa.
  let execErro = null;
  let executouAqui = false;
  if (run.status === "queued") {
    try {
      // Prazo por unidade: devolve a VAGA de concorrência se a coleta/gravação ficar sem resposta. Além disso o
      // run vira failed (abaixo) e a publicação exige run completed (publicarRun), então nada é publicado tarde.
      // O trabalho abandonado recebe um AbortSignal: ao estourar o prazo ele aborta o HTTP em voo e para nos
      // próximos pontos seguros (antes de cada etapa e de toda gravação) — não segue gravando "por baixo".
      const cancelador = new AbortController();
      const resultado = await comPrazo(deps.executarSyncRun({
        run,
        context,
        params: { clienteSlug: conta.clienteSlug, dateFrom: periodo.dateFrom, dateTo: periodo.dateTo, marketplace: MARKETPLACE },
        db: deps.db,
        signal: cancelador.signal,
      }), deps.unidadeTimeoutMs, {
        code: "UNIDADE_TIMEOUT",
        message: `Unidade ${rotulo} sem concluir em ${Math.round((deps.unidadeTimeoutMs || 0) / 60000)} min; vaga liberada.`,
        onTimeout: () => cancelador.abort(),
      });
      executouAqui = resultado !== null && resultado !== undefined;
    } catch (err) {
      execErro = err;
      executouAqui = true;
      if (err && err.code === "UNIDADE_TIMEOUT") {
        deps.logger.error(`${LOG} conta ${rotulo} run #${run.id}: ${err.message}`);
        if (typeof deps.marcarRunFailed === "function") {
          try {
            await comPrazo(
              deps.marcarRunFailed(run.id, { code: "SYNC_RUN_UNIT_TIMEOUT", message: err.message }, deps.db),
              15000, { code: "FECHAR_RUN_TIMEOUT" }
            );
          } catch (fecharErr) {
            deps.logger.warn(`${LOG} conta ${rotulo} run #${run.id}: não foi possível fechar o run preso (${fecharErr.code || fecharErr.message})`);
          }
        }
      }
    }
  }
  base.executadoPor = executouAqui ? "cron" : "outro_processo";

  let final;
  try {
    final = executouAqui
      ? await deps.obterSyncRun({ runId: run.id, clienteSlug: conta.clienteSlug, db: deps.db })
      : await aguardarRunFinal({ runId: run.id, clienteSlug: conta.clienteSlug }, deps);
  } catch (err) {
    const erro = resumirErro(execErro || err);
    deps.logger.error(`${LOG} conta ${rotulo} erro: ${erro.code ? `${erro.code} ` : ""}${erro.message}`);
    return { ...base, status: "falha", erro };
  }

  if (final.status === "failed" || execErro) {
    const erro = resumirErro(execErro || { code: final.error?.code || null, message: final.error?.message || "run failed" });
    deps.logger.error(`${LOG} conta ${rotulo} erro: ${erro.code ? `${erro.code} ` : ""}${erro.message}`);
    return { ...base, status: "falha", runStatus: final.status, erro };
  }

  if (final.status !== "completed") {
    deps.logger.warn(`${LOG} conta ${rotulo} run #${run.id} ainda ${final.status} em outro processo — ignorada nesta rodada`);
    return { ...base, status: "ignorado", motivo: "RUN_EM_ANDAMENTO_EM_OUTRO_PROCESSO", runStatus: final.status };
  }

  const publicados = await listarImportsPublicadosDoRun(run.id, deps.db);
  base.publicado = publicados.length > 0;
  const completo = final.completenessStatus === "complete";
  const status = base.publicado && completo ? "sucesso" : "parcial";
  const motivo = !base.publicado ? "NAO_PUBLICADO_ORDERS_INCOMPLETO" : (!completo ? `COMPLETUDE_${String(final.completenessStatus || "desconhecida").toUpperCase()}` : null);

  deps.logger.log(
    `${LOG} conta ${rotulo} ${status === "sucesso" ? "ok" : `parcial (${motivo})`}`
      + ` run=#${run.id} completude=${final.completenessStatus || "?"} publicado=${base.publicado ? "sim" : "nao"}`
  );
  return { ...base, status, motivo, runStatus: final.status, completenessStatus: final.completenessStatus || null };
}

// ---------------------------------------------------------------------------
// Rodada
// ---------------------------------------------------------------------------

function chaveGrupo(clienteId, competencia) {
  return `${clienteId}|${competencia}`;
}

/**
 * Executa uma rodada (cron noturno ou backfill).
 *
 * @param {object} opts
 * @param {Array<{competencia,dateFrom,dateTo}>} opts.periodos
 * @param {number} opts.concorrencia
 * @param {string[]|null} [opts.clientes]  filtro opcional por slug
 * @param {boolean} [opts.dryRun]  só lista contas/períodos, não sincroniza
 * @param {string} [opts.origem]   "cron-central" | "backfill-central"
 */
async function executarRodada(opts, depsOverride = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  const inicio = deps.agora();
  const {
    periodos, concorrencia, clientes = null, dryRun = false,
    origem = "cron-central", onProgresso = null,
    // (conta, periodo) => boolean — recorte por UNIDADE (ex.: mês anterior só
    // para as contas sem cobertura completa). Ausente = todas as unidades.
    filtroUnidade = null,
  } = opts;

  deps.logger.log(
    `${LOG} início origem=${origem} períodos=${periodos.map((p) => `${p.dateFrom}..${p.dateTo}`).join(",")}`
      + ` concorrência=${concorrencia}${clientes?.length ? ` clientes=${clientes.join(",")}` : ""}${dryRun ? " DRY-RUN" : ""}`
  );

  const rows = await deps.listarContas(deps.db);
  const { total, elegiveis, ignoradas } = classificarContas(rows, { clientes });
  deps.logger.log(`${LOG} contas: total=${total} elegíveis=${elegiveis.length} ignoradas=${ignoradas.length}`);
  deps.logger.log(`${LOG} contas elegíveis: ${elegiveis.length}`);
  for (const ig of ignoradas) {
    deps.logger.log(`${LOG} conta ${rotuloConta(ig)} ignorada: ${ig.motivo}`);
  }

  // Unidades = conta × período. Grupo de snapshot = cliente × competência
  // (o snapshot é por cliente): só reconstrói quando TODAS as unidades do
  // grupo terminaram.
  const unidades = [];
  const grupos = new Map();
  const contasPorCliente = new Map();
  for (const conta of elegiveis) {
    if (!contasPorCliente.has(conta.clienteId)) contasPorCliente.set(conta.clienteId, []);
    contasPorCliente.get(conta.clienteId).push(conta);
  }
  for (const periodo of periodos) {
    for (const conta of elegiveis) {
      if (typeof filtroUnidade === "function" && !filtroUnidade(conta, periodo)) continue;
      const chave = chaveGrupo(conta.clienteId, periodo.competencia);
      if (!grupos.has(chave)) {
        grupos.set(chave, {
          cliente: { id: conta.clienteId, slug: conta.clienteSlug },
          competencia: periodo.competencia,
          segmento: { dateFrom: periodo.dateFrom, dateTo: periodo.dateTo },
          contas: contasPorCliente.get(conta.clienteId),
          pendentes: 0,
          resultados: [],
          ads: null,
          snapshot: null,
        });
      }
      grupos.get(chave).pendentes += 1;
      unidades.push({ conta, periodo, chave });
    }
  }

  if (dryRun) {
    for (const u of unidades) deps.logger.log(`${LOG} [dry-run] ${rotuloConta(u.conta)} ${u.periodo.dateFrom}..${u.periodo.dateTo}`);
    const resumo = montarResumo({ total, elegiveis, ignoradas, execucoes: [], grupos: [], inicio, fim: deps.agora(), dryRun: true, unidades: unidades.length });
    deps.logger.log(`${LOG} resumo ${JSON.stringify(resumo)}`);
    return resumo;
  }

  // Schema da Central garantido UMA vez, ANTES de qualquer pool de
  // concorrência. O DDL do schema (ALTER/DROP INDEX/CREATE INDEX nas tabelas
  // globais) executado por várias contas em paralelo fechava um ciclo de locks
  // com o reuso de run (sync_runs → imports) e o PostgreSQL abortava contas
  // elegíveis com 40P01. Aqui o ensure é single-flight por processo e
  // serializado por advisory lock entre processos; falha dele é estrutural
  // (sem schema nenhuma unidade funcionaria), então sobe. Fora do dry-run, que
  // continua sem tocar o banco além da listagem.
  await deps.ensureCentralVendasTables(deps.db);

  if (typeof onProgresso === "function") {
    onProgresso({ concluidas: 0, total: unidades.length, unidade: null, fase: "preparacao" });
  }

  // Persiste a carteira inteira como runs queued ANTES de iniciar chamadas
  // externas. Se o processo cair depois de ocupar os primeiros workers, as
  // unidades restantes continuam visiveis e reaproveitaveis no banco.
  let preparadas = 0;
  const preparacoes = await executarComConcorrencia(unidades, concorrencia, async (unidade) => {
    let criado = null;
    let preparacaoErro = null;
    try {
      criado = await criarSyncRunDaUnidade(unidade.conta, unidade.periodo, deps);
    } catch (err) {
      preparacaoErro = err;
    }
    preparadas += 1;
    deps.logger.log(`${LOG} preparação ${preparadas}/${unidades.length} ${rotuloConta(unidade.conta)} ${unidade.periodo.dateFrom}..${unidade.periodo.dateTo}`);
    return { ...unidade, criado, preparacaoErro };
  });
  const unidadesPreparadas = preparacoes.map((r) => r.valor);

  async function fecharGrupoSePronto(grupo) {
    if (grupo.pendentes > 0) return;
    const algumPublicado = grupo.resultados.some((r) => r.publicado);
    const rotulo = `${grupo.cliente.slug} ${grupo.competencia}`;
    if (!algumPublicado) {
      grupo.snapshot = { atualizado: false, motivo: "NENHUM_RUN_PUBLICADO_NESTA_RODADA" };
      deps.logger.log(`${LOG} snapshot ${rotulo} não atualizado: ${grupo.snapshot.motivo}`);
      return;
    }
    const todasPublicadas = grupo.resultados.every((r) => r.publicado);
    if (todasPublicadas) {
      try {
        grupo.ads = await comPrazo(deps.sincronizarAdsCliente({
          cliente: grupo.cliente,
          competencia: grupo.competencia,
          contas: grupo.contas.map((c) => ({ clienteContaId: c.clienteContaId })),
          segmento: grupo.segmento,
        }), deps.fechamentoTimeoutMs, { code: "FECHAMENTO_TIMEOUT", message: `Ads de ${rotulo} sem resposta no prazo.` });
        deps.logger.log(
          `${LOG} ads ${rotulo} atualizado contas=${grupo.ads.contas}`
            + ` investimento=${grupo.ads.investimentoAds} gmv=${grupo.ads.gmvAds}`
        );
      } catch (err) {
        grupo.ads = { atualizado: false, motivo: "ADS_NAO_ATUALIZADO", erro: resumirErro(err) };
        deps.logger.warn(
          `${LOG} ads ${rotulo} não atualizado: ${grupo.ads.erro.code ? `${grupo.ads.erro.code} ` : ""}${grupo.ads.erro.message}`
        );
      }
      if (grupo.ads?.atualizado) await registrarAdsDaJanelaDoGrupo(grupo, rotulo, deps);
    } else {
      grupo.ads = { atualizado: false, motivo: "VENDAS_NAO_PUBLICADAS_PARA_TODAS_CONTAS" };
      deps.logger.log(`${LOG} ads ${rotulo} não atualizado: ${grupo.ads.motivo}`);
    }
    try {
      grupo.snapshot = await comPrazo(deps.reconstruirSnapshotMensal({
        cliente: grupo.cliente,
        competencia: grupo.competencia,
        contas: grupo.contas.map((c) => ({ clienteContaId: c.clienteContaId })),
        segmento: grupo.segmento,
        origem,
      }), deps.fechamentoTimeoutMs, { code: "FECHAMENTO_TIMEOUT", message: `Snapshot de ${rotulo} sem resposta no prazo.` });
    } catch (err) {
      grupo.snapshot = { atualizado: false, motivo: "ERRO_ADAPTADOR", erro: resumirErro(err) };
    }
    deps.logger.log(
      grupo.snapshot.atualizado
        ? `${LOG} snapshot ${rotulo} atualizado sincronizadoEm=${grupo.snapshot.sincronizadoEm ? new Date(grupo.snapshot.sincronizadoEm).toISOString() : "?"}`
        : `${LOG} snapshot ${rotulo} não atualizado: ${grupo.snapshot.motivo}${grupo.snapshot.erro ? ` — ${grupo.snapshot.erro.message}` : ""}`
    );
  }

  let concluidas = 0;
  const execucoes = await executarComConcorrencia(unidadesPreparadas, concorrencia, async (unidade) => {
    let resultado;
    try {
      resultado = await processarUnidade(unidade, deps);
    } catch (err) {
      // Rede de segurança: processarUnidade já captura os erros esperados;
      // qualquer outra exceção vira falha DESTA conta, nunca da rodada.
      const erro = resumirErro(err);
      deps.logger.error(`${LOG} conta ${rotuloConta(unidade.conta)} erro inesperado: ${erro.message}`);
      resultado = {
        clienteId: unidade.conta.clienteId, clienteSlug: unidade.conta.clienteSlug,
        clienteContaId: unidade.conta.clienteContaId, competencia: unidade.periodo.competencia,
        dateFrom: unidade.periodo.dateFrom, dateTo: unidade.periodo.dateTo,
        status: "falha", publicado: false, erro,
      };
    }
    const grupo = grupos.get(unidade.chave);
    grupo.resultados.push(resultado);
    grupo.pendentes -= 1;
    await fecharGrupoSePronto(grupo);
    concluidas += 1;
    const unidadeRotulo = `${rotuloConta(unidade.conta)} ${unidade.periodo.dateFrom}..${unidade.periodo.dateTo}`;
    deps.logger.log(`${LOG} progresso ${concluidas}/${unidades.length} ${unidadeRotulo} status=${resultado.status}`);
    if (typeof onProgresso === "function") {
      // `resultado` é aditivo: o scheduler só lê concluidas/total/unidade; a
      // atualização sob demanda do Painel de Contas precisa do desfecho POR
      // CONTA (o resumo final só lista as falhas).
      onProgresso({
        concluidas, total: unidades.length, unidade: unidadeRotulo, status: resultado.status, fase: "execucao",
        resultado,
      });
    }
    return resultado;
  });

  const resumo = montarResumo({
    total,
    elegiveis,
    ignoradas,
    execucoes: execucoes.map((e) => e.valor).filter(Boolean),
    grupos: [...grupos.values()],
    inicio,
    fim: deps.agora(),
  });
  deps.logger.log(`${LOG} resumo ${JSON.stringify(resumo)}`);
  return resumo;
}

// Rodada noturna PADRÃO (período do dia + concorrência do env). Ponto único
// usado pelo job CLI (jobs/syncCentralVendasNoturno.js — Render Cron/manual) e
// pelo scheduler interno do Web Service (centralVendasNoturnoScheduler), para
// os dois nunca divergirem de configuração.
async function executarRodadaNoturna(
  {
    env = process.env, dataReferencia = null, clientes = null, dryRun = false,
    origem = "cron-central", onProgresso = null,
  } = {},
  depsOverride = {}
) {
  const deps = { ...defaultDeps(), ...depsOverride };
  const hoje = dataReferencia || hojeNoFuso();
  const periodos = calcularPeriodosNoturnos(hoje);

  // Órfãos noturnos antigos (fora da janela de retomada) são fechados antes
  // de criar a rodada — nunca bloqueiam nem são retomados depois. Falha aqui
  // só é registrada: a rodada segue.
  if (!dryRun) await expirarOrfaosForaDaJanela(env, deps);

  // Mês anterior incompleto (dias 6..N): entra SÓ para as contas sem import
  // publicado cobrindo o mês inteiro. Falha na consulta não derruba a rodada
  // do mês corrente.
  let filtroUnidade = null;
  const anterior = periodoMesAnteriorACompletar(hoje, resolverCompletarAteDia(env.CENTRAL_VENDAS_NOTURNO_COMPLETAR_MES_ANTERIOR_ATE_DIA));
  if (anterior) {
    try {
      const incompletas = await deps.listarContasComMesIncompleto(anterior, deps.db);
      if (incompletas.size > 0) {
        periodos.unshift(anterior);
        filtroUnidade = (conta, periodo) => periodo !== anterior || incompletas.has(Number(conta.clienteContaId));
        deps.logger.log(`${LOG} mês anterior ${anterior.competencia} incompleto em ${incompletas.size} conta(s): completando ${anterior.dateFrom}..${anterior.dateTo}`);
      }
    } catch (err) {
      deps.logger.warn(`${LOG} não foi possível verificar o mês anterior ${anterior.competencia}: ${resumirErro(err).message}`);
    }
  }

  // Piloto por conta (CENTRAL_VENDAS_NOTURNO_CONTAS): vazio ou "*" = carteira
  // inteira (comportamento de sempre); lista de ids = só essas contas. Serve
  // para religar o noturno junto com o reuso sem que as demais contas
  // regravem o mês inteiro toda noite. Lista inválida ⇒ a rodada NÃO roda
  // (nunca cai para "todas" por engano de configuração).
  const contasPiloto = resolverContasPiloto(env.CENTRAL_VENDAS_NOTURNO_CONTAS);
  if (contasPiloto.invalida) {
    const err = new Error(`CENTRAL_VENDAS_NOTURNO_CONTAS inválida (${JSON.stringify(String(env.CENTRAL_VENDAS_NOTURNO_CONTAS))}) — rodada não executada`);
    err.code = "CONTAS_PILOTO_INVALIDAS";
    throw err;
  }
  if (contasPiloto.ids) {
    const filtroMes = filtroUnidade;
    filtroUnidade = (conta, periodo) => contasPiloto.ids.has(Number(conta.clienteContaId)) && (!filtroMes || filtroMes(conta, periodo));
    deps.logger.log(`${LOG} piloto: só as contas ${[...contasPiloto.ids].join(",")} (CENTRAL_VENDAS_NOTURNO_CONTAS)`);
  }

  return executarRodada({
    periodos,
    concorrencia: resolverConcorrencia(env.SYNC_CENTRAL_CONCURRENCY),
    clientes,
    dryRun,
    origem,
    onProgresso,
    filtroUnidade,
  }, deps);
}

function resolverContasPiloto(valor) {
  const bruto = String(valor ?? "").trim();
  if (!bruto || bruto === "*") return { ids: null, invalida: false };
  const partes = bruto.split(",").map((v) => v.trim()).filter(Boolean);
  if (!partes.length || partes.some((v) => !/^\d{1,9}$/.test(v))) return { ids: null, invalida: true };
  return { ids: new Set(partes.map(Number)), invalida: false };
}

async function expirarOrfaosForaDaJanela(env, deps, agoraMs = deps.agora()) {
  const horas = resolverRecuperacaoHoras(env.CENTRAL_VENDAS_NOTURNO_RECUPERACAO_HORAS);
  const desde = new Date(agoraMs - horas * 3600 * 1000).toISOString();
  try {
    const expirados = await deps.expirarRunsNoturnosOrfaos({ antesDe: new Date(agoraMs).toISOString(), desde, db: deps.db });
    if (expirados.length) {
      deps.logger.warn(`${LOG} ${expirados.length} run(s) noturno(s) órfão(s) com mais de ${horas}h fechado(s) como SYNC_RUN_ORPHAN_EXPIRED`);
    }
    return { desde, expirados: expirados.length };
  } catch (err) {
    deps.logger.warn(`${LOG} não foi possível fechar órfãos antigos: ${resumirErro(err).message}`);
    return { desde, expirados: 0, erro: true };
  }
}

// Retoma no boot periodos que possuam runs noturnos ativos. O proprio periodo
// persistido e a identidade da rodada; nao ha tabela/fila paralela. A chamada
// deve ocorrer sob o advisory lock global do scheduler.
async function recuperarRodadasPendentes(
  { env = process.env, iniciadoEm = new Date(), onProgresso = null } = {},
  depsOverride = {}
) {
  const deps = { ...defaultDeps(), ...depsOverride };
  const inicioMs = iniciadoEm instanceof Date ? iniciadoEm.getTime() : new Date(iniciadoEm).getTime();
  const antesDe = new Date(inicioMs).toISOString();
  // Só pendências recentes são retomadas; as antigas são fechadas (nunca uma
  // retomada em massa de períodos velhos × carteira inteira).
  const { desde, expirados } = await expirarOrfaosForaDaJanela(env, deps, inicioMs);
  const periodos = await deps.listarPeriodosNoturnosPendentes({ antesDe, desde, db: deps.db });
  if (!periodos.length) return { recuperada: false, motivo: "SEM_PENDENCIAS", orfaosExpirados: expirados };
  // Clientes com pendência POR PERÍODO (quando o banco informa): cada período
  // é retomado só para os SEUS clientes — setembro pendente só para A e
  // outubro só para B rodam setembro×A e outubro×B, nunca o produto cruzado.
  // Sem a informação, mantém a rodada completa (comportamento anterior).
  const chavePeriodo = (p) => `${p.dateFrom}..${p.dateTo}`;
  const porPeriodo = periodos.every((p) => Array.isArray(p.clientes))
    ? new Map(periodos.map((p) => [chavePeriodo(p), new Set(p.clientes.map((c) => String(c).toLowerCase()))]))
    : null;
  const clientes = porPeriodo ? [...new Set([...porPeriodo.values()].flatMap((set) => [...set]))] : null;
  const filtroUnidade = porPeriodo
    ? (conta, periodo) => porPeriodo.get(chavePeriodo(periodo))?.has(String(conta.clienteSlug).toLowerCase()) === true
    : null;

  const interrompidos = await deps.reconciliarRunsNoturnosInterrompidos({ antesDe, db: deps.db });
  deps.logger.warn(
    `${LOG} recuperação de restart períodos=${periodos.map((p) => `${p.dateFrom}..${p.dateTo}`).join(",")}`
      + ` runningInterrompidos=${interrompidos.length}`
  );
  const resumo = await executarRodada({
    periodos: periodos.map(({ competencia, dateFrom, dateTo }) => ({ competencia, dateFrom, dateTo })),
    concorrencia: resolverConcorrencia(env.SYNC_CENTRAL_CONCURRENCY),
    origem: "restart-central",
    onProgresso,
    ...(clientes && clientes.length ? { clientes, filtroUnidade } : {}),
  }, deps);
  return { recuperada: true, resumo, runningInterrompidos: interrompidos.length, orfaosExpirados: expirados };
}

function contarPor(lista, campo) {
  return lista.reduce((acc, item) => {
    const k = item[campo] || "desconhecido";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

function montarResumo({ total, elegiveis, ignoradas, execucoes, grupos, inicio, fim, dryRun = false, unidades = null }) {
  const porStatus = contarPor(execucoes, "status");
  const ignoradosExecucao = execucoes.filter((e) => e.status === "ignorado");
  const snapshots = grupos.map((g) => g.snapshot).filter(Boolean);
  const ads = grupos.map((g) => g.ads).filter(Boolean);
  return {
    total,
    elegiveis: elegiveis.length,
    execucoes: dryRun ? unidades : execucoes.length,
    sucesso: porStatus.sucesso || 0,
    parcial: porStatus.parcial || 0,
    falha: porStatus.falha || 0,
    completed: porStatus.sucesso || 0,
    partial: porStatus.parcial || 0,
    failed: porStatus.falha || 0,
    // Contas inelegíveis + execuções puladas (run equivalente preso em outro processo).
    ignorados: ignoradas.length + ignoradosExecucao.length,
    ignoradosPorMotivo: { ...contarPor(ignoradas, "motivo"), ...contarPor(ignoradosExecucao, "motivo") },
    snapshots: {
      atualizados: snapshots.filter((s) => s.atualizado).length,
      naoAtualizados: snapshots.filter((s) => !s.atualizado).length,
      porMotivo: contarPor(snapshots.filter((s) => !s.atualizado), "motivo"),
    },
    ads: {
      atualizados: ads.filter((a) => a.atualizado).length,
      naoAtualizados: ads.filter((a) => !a.atualizado).length,
      porMotivo: contarPor(ads.filter((a) => !a.atualizado), "motivo"),
    },
    falhas: execucoes
      .filter((e) => e.status === "falha")
      .map((e) => ({ cliente: e.clienteSlug, contaId: e.clienteContaId, periodo: `${e.dateFrom}..${e.dateTo}`, runId: e.runId || null, erro: e.erro })),
    duracaoMs: fim - inicio,
    ...(dryRun ? { dryRun: true } : {}),
  };
}

// Exit code (§16): falha individual não derruba o lote (exit 0). Exit != 0
// quando o job não conseguiu rodar (erro estrutural — tratado pelo entrypoint)
// ou quando TODAS as execuções falharam (sinal de problema sistêmico: ML fora,
// banco, credencial — o Render marca o cron como falho e pode alertar).
function exitCodeDoResumo(resumo) {
  if (!resumo || resumo.dryRun) return 0;
  if (resumo.execucoes > 0 && resumo.falha === resumo.execucoes) return 1;
  return 0;
}

module.exports = {
  resolverContasPiloto,
  executarRodada,
  executarRodadaNoturna,
  recuperarRodadasPendentes,
  processarUnidade,
  executarComConcorrencia,
  classificarContas,
  motivoInelegibilidade,
  listarContas,
  calcularPeriodosNoturnos,
  calcularPeriodosBackfill,
  periodoMesAnteriorACompletar,
  listarContasComMesIncompleto,
  resolverCompletarAteDia,
  resolverRecuperacaoHoras,
  hojeNoFuso,
  resolverConcorrencia,
  exitCodeDoResumo,
  montarResumo,
  CONCORRENCIA_PADRAO,
  CONCORRENCIA_MAXIMA,
  DIAS_REPROCESSO_MES_ANTERIOR,
  COMPLETAR_MES_ANTERIOR_ATE_DIA_PADRAO,
  RECUPERACAO_HORAS_PADRAO,
  TIMEZONE,
};
