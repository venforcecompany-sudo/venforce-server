// server/services/centralVendas/centralVendasSyncWorker.js
// Central de Vendas — execução do Sync Run (M2 da fundação V3).
//
// `executarSyncRun` é o ÚNICO caminho de execução: tanto o endpoint legado
// POST /sincronizar (que o aguarda inline, preservando a resposta síncrona
// de sempre) quanto o novo POST /sync-runs (que o enfileira e responde 202
// antes dele terminar) chamam esta mesma função. Não existem dois motores.
//
// Fila in-process (mesmo padrão de
// server/services/automacoes/promocoesDiagnosticoService.js): array em
// memória + setImmediate. LIMITAÇÃO CONHECIDA: não há fila externa (Redis/
// BullMQ/SQS) — se o processo Node reiniciar com um run em 'running', ele
// fica preso nesse estado dentro deste worker. Runs manuais continuam com a
// reconciliação preguiçosa ao criar uma tentativa equivalente; runs noturnos
// são reconciliados e retomados pelo scheduler no boot, reutilizando a mesma
// central_vendas_sync_runs (ver centralVendasNoturnoService). Trocar por fila
// externa no futuro continua sendo uma troca desta implementação sem mudar o
// contrato de central_vendas_sync_runs.

const pool = require("../../config/database");
const runService = require("./centralVendasSyncRunService");
const sourceService = require("./centralVendasSyncSourceService");
const { assertNaoCancelado } = require("../../utils/comPrazo");
const { isPgConnectionError } = require("./centralVendasTransientRetry");

const CONCORRENCIA = Number(process.env.CENTRAL_VENDAS_SYNC_CONCURRENCY) || 1;

// Fechar o run depois de perder a conexão: o PostgreSQL pode estar saindo de
// uma recuperação de crash (segundos). Repete SÓ erro de conexão, com espera
// curta e crescente (~0,5 + 1 + 2 + 4 s). UPDATEs idempotentes (só mexem em
// run 'running' / fontes pending|running), então repetir é seguro.
const FECHAR_RUN_TENTATIVAS = 5;
const FECHAR_RUN_BACKOFF_MS = 500;
const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fecharRunFalho(run, err, code, db, sleep) {
  for (let tentativa = 1; ; tentativa += 1) {
    try {
      // Rede de segurança (seção 54): fecha qualquer fonte ainda pending/
      // running deste run como failed antes de marcar o run como failed —
      // nunca deixa "run failed, sources todas running".
      await sourceService.falharFontesEmAndamento(run.id, { errorCode: code, errorMessage: err?.message }, db);
      // completenessStatus é SEMPRE derivado de calcularCompletudeDoRun, nunca
      // forçado — um run técnico failed pode ter fontes obrigatórias que
      // fecharam bem antes do erro (ex.: erro de persistência depois de
      // orders/shipments/claims/base completos) ou só uma fonte não-estrutural
      // falha (ex.: claims), o que dá completude `partial`, não `failed`. Só
      // falha estrutural (orders/base) força `failed` — ver STRUCTURAL_SOURCES
      // em centralVendasSyncSourceService. runStatus:"failed" aqui garante o
      // veredito estrito (nunca "unknown" por engano de run ainda em andamento).
      const completeness = await sourceService.calcularCompletudeDoRun(run.id, { runStatus: "failed", db });
      await runService.atualizarCompletenessRun(run.id, completeness.status, db);
      await runService.marcarRunFailed(run.id, { code, message: err?.message || "Erro desconhecido na sincronizacao." }, db);
      return;
    } catch (fecharErr) {
      if (!isPgConnectionError(fecharErr) || tentativa >= FECHAR_RUN_TENTATIVAS) {
        // O erro ORIGINAL continua sendo o que sobe; o run fica 'running' e é
        // fechado pela recuperação do próximo boot (noturno) ou pela
        // reconciliação de abandono ao criar uma tentativa equivalente.
        console.error(
          `[centralVendas] sync-run #${run.id} não foi possível marcar como failed (${code}):`
            + ` ${fecharErr?.code ? `${fecharErr.code} ` : ""}${fecharErr?.message}`
        );
        return;
      }
      await sleep(FECHAR_RUN_BACKOFF_MS * 2 ** (tentativa - 1));
    }
  }
}

const fila = [];
let ativos = 0;

function enfileirar(job) {
  fila.push(job);
  setImmediate(processarFila);
}

async function processarFila() {
  if (ativos >= CONCORRENCIA) return;
  const job = fila.shift();
  if (!job) return;

  ativos++;
  try {
    await executarSyncRun(job); // job pode incluir db/sincronizarVendasMeli (injeção de teste)
  } catch (err) {
    // executarSyncRun já tenta marcar o run como failed internamente; isto é
    // apenas uma rede de segurança para não deixar a fila travada.
    console.error(`[centralVendas] sync-run #${job?.run?.id} falhou na fila:`, err?.message);
  } finally {
    ativos--;
    setImmediate(processarFila);
  }
}

// Extrai só o essencial do payload de sincronizarVendasMeli para
// metadata_json — nunca o payload inteiro da Orders API (isso é M3).
function resumoDoResultado(resultado) {
  return {
    ordersEncontrados: resultado?.ordersEncontrados ?? null,
    pedidosPersistidos: resultado?.pedidosPersistidos ?? null,
    itensPersistidos: resultado?.itensPersistidos ?? null,
    componentesPersistidos: resultado?.componentesPersistidos ?? null,
    porCompetencia: Array.isArray(resultado?.porCompetencia)
      ? resultado.porCompetencia.map((c) => ({ competencia: c.competencia, importId: c.importId, pedidos: c.pedidos }))
      : [],
  };
}

// `db` e `sincronizarVendasMeli` são pontos de injeção só para teste (mesmo
// espírito de createCentralVendasSyncService(repo, db)) — em produção usam
// sempre os defaults reais (pool global, motor de sync real).
async function executarSyncRun({
  run, context, params, db = pool, sincronizarVendasMeli: syncFnOverride = null,
  marginSnapshotEnqueue: marginSnapshotEnqueueOverride = null, signal = null, sleep = dormir,
}) {
  const marcado = await runService.marcarRunRunning(run.id, db);
  if (!marcado) {
    // Já estava running/completed/failed (corrida entre a fila e uma chamada
    // inline, ou reprocessamento acidental) — nada a fazer, estado final não
    // volta para running.
    return null;
  }

  // Lazy require: evita qualquer ciclo de módulo em tempo de carga.
  const sincronizarVendasMeli = syncFnOverride
    || require("./centralVendasSyncService").createCentralVendasSyncService().sincronizarVendasMeli;

  try {
    const resultado = await sincronizarVendasMeli({
      clienteSlug: params.clienteSlug,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      marketplace: params.marketplace,
      accountContext: context, // identidade congelada — não re-resolvida aqui
      runId: run.id,
      ...(signal ? { signal } : {}),
    });
    // Prazo por unidade já estourado (o run foi fechado como failed por quem abandonou esta execução): não
    // calcula completude, não publica nem enfileira margem — o catch abaixo só fecha o que ficou aberto.
    assertNaoCancelado(signal, "fechar o run");

    // M3 — completude por fonte: eixo separado do status técnico (run.status
    // continua completed/failed exatamente como no M2). Nunca calculado no
    // frontend nem duplicado em outro lugar — sempre via
    // calcularCompletudeDoRun (verdade única em central_vendas_sync_sources).
    // runStatus:"completed" — o run está prestes a ser marcado completed
    // logo abaixo; uma fonte obrigatória que nunca foi registrada até aqui é
    // lacuna real (Hardening M3, P0 seção 1), não "ainda vai rodar".
    const completeness = await sourceService.calcularCompletudeDoRun(run.id, { runStatus: "completed", db });
    await runService.atualizarCompletenessRun(run.id, completeness.status, db);
    await runService.marcarRunCompleted(run.id, resumoDoResultado(resultado), db);

    const fontes = await sourceService.listarFontesDoRun(run.id, db);
    console.log(
      `[centralVendas] sync-run #${run.id} completeness`,
      Object.fromEntries(fontes.map((f) => [
        f.source,
        `${f.status}${f.expectedCount != null && f.receivedCount != null ? ` ${f.receivedCount}/${f.expectedCount}` : ""}`,
      ])),
      completeness.missingSources.length ? `missing=${completeness.missingSources.join(",")}` : "",
      `overall=${completeness.status}`
    );

    // M4 — publica automaticamente quando elegível (gate real é orders
    // completo + run completed, não o agregado acima — ver
    // centralVendasPublicationService). Nunca dentro do collector, sempre
    // depois do run já ter terminado completed. Try/catch PRÓPRIO
    // (deliberado, separado do catch de sincronização abaixo): o run já
    // terminou com sucesso técnico aqui — uma falha ao publicar nunca pode
    // reabrir/falhar o run nem virar um "throw" que o catch de baixo
    // reinterpretaria como sincronização quebrada. Se a promoção falhar, o
    // candidate simplesmente continua candidate e o published anterior (se
    // houver) continua sendo o oficial — nunca inventa publicação.
    try {
      const publicationService = require("./centralVendasPublicationService");
      const publicacao = await publicationService.publicarRun(run.id, { db });
      console.log(
        publicacao.published
          ? `[centralVendas] sync-run #${run.id} publicado — imports=${publicacao.importIds.join(",") || "nenhum"}`
          : `[centralVendas] sync-run #${run.id} nao publicado: ${publicacao.reason}`
      );
      // Retenção automática das tuplas publicadas — desligada sem
      // CENTRAL_VENDAS_RETENCAO_AUTO=true; agenda fora deste fluxo e nunca
      // lança (ver centralVendasRetencaoAuto).
      if (publicacao?.published && publicacao.importIds?.length) {
        require("./retencao/centralVendasRetencaoAuto").agendarRetencaoAposPublicacao({ importIds: publicacao.importIds, db });
      }
    } catch (publishErr) {
      console.error(`[centralVendas] sync-run #${run.id} erro ao tentar publicar:`, publishErr?.message);
    }

    // Margin Snapshot (M4) — SÓ enfileira um refresh de margem da conta; a
    // Central de Vendas nunca calcula margem. Depois do run completed e da
    // tentativa de publicação, em try/catch PRÓPRIO: uma falha aqui nunca
    // reabre/falha o sync já concluído (mesma disciplina da publicação).
    // Desligado sem MARGIN_SNAPSHOT_WORKER_ENABLED=true.
    try {
      const marginTriggers = require("../motorMargem/marginSnapshotTriggers");
      const enqueue = await (marginSnapshotEnqueueOverride || marginTriggers.enfileirarAposSyncCentralVendas)({ run }, { db });
      if (enqueue?.enfileirado) {
        console.log(
          `[centralVendas] sync-run #${run.id} → margin snapshot run #${enqueue.runId}${enqueue.reaproveitado ? " (reaproveitado)" : ""}`
        );
      }
    } catch (marginErr) {
      console.error(`[centralVendas] sync-run #${run.id} erro ao enfileirar margin snapshot (ignorado):`, marginErr?.message);
    }

    return resultado;
  } catch (err) {
    // Conexão com o PostgreSQL perdida no meio do sync (crash/restart do
    // servidor, rede): código explícito, distinto de erro de execução.
    const code = isPgConnectionError(err) ? "SYNC_DB_CONNECTION_LOST" : (err?.code || "SYNC_EXECUTION_ERROR");
    await fecharRunFalho(run, err, code, db, sleep);
    throw err;
  }
}

module.exports = {
  enfileirar,
  executarSyncRun,
};
