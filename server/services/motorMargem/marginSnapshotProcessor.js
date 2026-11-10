// server/services/motorMargem/marginSnapshotProcessor.js
// Margin Snapshot — Processor real (M3, ver
// docs/AUDITORIA_WORKERS_E_PLANO_MARGIN_SNAPSHOT.md §5/§8/§9/§10).
//
// É o processor que o worker (marginSnapshotWorker) chama depois de
// reivindicar um run `running`:
//
//   run claimado (cliente_conta_id sempre presente, nunca auto-resolvido)
//     → prepareWorkspaceContext UMA VEZ (Motor de Margem), SEM fonte de vendas
//     → lista o catálogo inteiro da conta por scan (ativos + pausados)
//     → lotes SEQUENCIAIS de 20 itens → enrichBatch(prepared, { itemIds })
//       (o mesmo Motor da tela — ZERO fórmula nova de margem)
//     → retry por LOTE (backoff exponencial com teto + Retry-After)
//     → upsert do snapshot projetado por item; lote que falhou de vez marca
//       como `failed` só as linhas que já existiam (valores preservados)
//     → progresso + heartbeat persistidos a cada lote
//     → itens que saíram do catálogo são marcados (nunca apagados)
//
// DECISÕES (sustentadas por código, não inventadas):
//
// 1. Listagem por scan, não por offset. /users/{id}/items/search não aceita
//    offset > 1000 (doc do ML; o repo já usa scan em meliSyncService,
//    modeloBaseCustosService e planilhaPrecificacaoSemBaseService). Com offset
//    o worker quebraria exatamente nos catálogos grandes que motivam o
//    snapshot. O Motor continua sendo quem calcula: enrichBatch aceita
//    `itemIds` (mesmo caminho do detalhe de item).
//
// 2. Snapshot = margem PROJETADA pura. O Motor classifica status/confiança
//    pela margem EXIBIDA (realizada quando há venda no período). Persistir
//    isso congelaria o realizado de uma janela arbitrária (30 dias do momento
//    do run) dentro do snapshot — o que o plano §12 proíbe. Por isso o
//    contexto é preparado com a fonte de vendas VAZIA (injeção explícita):
//    preço/comissão/frete/custo/imposto/taxa e a margem projetada são
//    idênticos aos da leitura ao vivo; status/confiança passam a depender só
//    das fontes projetadas. A realizada é combinada na LEITURA, pelo período
//    pedido pela tela (M5).
//
// 3. Unidade de retry = lote. A cotação por item nunca lança (o Motor engole
//    e devolve null) — então nenhum item é "corrigido" aqui. Exceção: item
//    com comissão/frete ausentes por falha de leitura (cotacaoIncompleta)
//    ganha UMA repescagem no fim do run e, se continuar incompleto, não é
//    gravado (o núcleo assumiria 0 e a margem sairia inflada).

const pool = require("../../config/database");
const motorMargem = require("./motorMargemService");
const margemConfiavel = require("./margemConfiavel");
const snapshotRepository = require("./marginSnapshotRepository");
const runRepository = require("./marginSnapshotRunRepository");
const meliApi = require("./adapters/meliApiEvidenceAdapter");
const { FIELDS } = require("./core/marginEvidence");
const { resolveMarginSnapshotConfig } = require("./marginSnapshotConfig");
const { executarComRetry, esperar, MarginSnapshotStopError } = require("./marginSnapshotRetry");
const { redigirSegredos } = require("./marginSnapshotSanitize");
const { obterLimiterDoProcesso } = require("./marginSnapshotRateLimiter");
const { logEvento } = require("./marginSnapshotLog");

// Mesmo teto do multiget /items?ids= que rege enrichBatch (PAGE_LIMIT_MAX).
const BATCH_SIZE = motorMargem.PAGE_LIMIT_MAX;

const MARKETPLACES_SUPORTADOS = ["meli"];

// Teto de ids falhos guardados no metadado do run (cada id ~14 bytes).
const MAX_IDS_FALHOS_GUARDADOS = 5000;

// Escopo parcial do run: `metadata.escopo.itemIds` (gravado no INSERT por
// marginSnapshotApiService ao pedir "recalcular só os que falharam"). Só ids
// MLB válidos e sem repetição; lista vazia/ausente = catálogo inteiro.
function idsDoEscopo(run) {
  const bruto = run && run.metadata && run.metadata.escopo && run.metadata.escopo.itemIds;
  if (!Array.isArray(bruto)) return null;
  const ids = Array.from(new Set(bruto.map((x) => String(x || "").trim().toUpperCase()).filter((x) => /^MLB\d+$/.test(x))));
  return ids.length ? ids.slice(0, MAX_IDS_FALHOS_GUARDADOS) : null;
}

class MarginSnapshotMarketplaceNaoSuportadoError extends Error {
  constructor(marketplace) {
    super(
      `Margin Snapshot: marketplace "${marketplace}" não suportado pelo processor (só "meli" é implementado).`
    );
    this.name = "MarginSnapshotMarketplaceNaoSuportadoError";
    this.code = "MARGIN_SNAPSHOT_MARKETPLACE_NAO_SUPORTADO";
  }
}

function erroTipado(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// Fonte de vendas vazia (ver decisão 2 do cabeçalho). Mesmo formato que
// centralVendasEvidenceAdapter.carregarVendasDoPeriodo/agregarPorMlb devolvem.
async function carregarVendasVazias() {
  return { sincronizado: false, pedidos: [], pedidosTodos: [], itens: [], componentes: [], imports: [], importSnapshotAt: null };
}

function agregadoVazio() {
  return {
    porMlb: new Map(),
    reembolsoPorMlb: new Map(),
    naoAtribuido: { reembolso: 0 },
    reembolsos: { atribuidoMlb: 0, atribuidoPedido: 0, naoAtribuivel: 0 },
  };
}

function isoOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return value;
}

// Valor PROJETADO de uma variável — nunca `valor || 0`: ausente fica null.
function valorProjetado(item, fieldKey) {
  const field = item.fields[fieldKey];
  const projetado = field && field.projected ? field.projected.value : undefined;
  return projetado ?? null;
}

// Evidências projetadas do Motor, compactas, para a leitura reconstruir o
// mesmo contrato `fields` (fonte, qualidade, observedAt, nota) sem chamar o
// ML. Como o snapshot é preparado sem vendas, só há evidência PROJECTED.
function evidenciasProjetadas(item) {
  const out = {};
  for (const [key, field] of Object.entries(item.fields || {})) {
    const lista = (field && Array.isArray(field.evidences) ? field.evidences : [])
      .filter((e) => e && e.kind === "PROJECTED" && e.value !== null && e.value !== undefined)
      .map((e) => ({
        source: e.source,
        value: e.value,
        quality: e.quality,
        observedAt: e.observedAt || null,
        note: e.note || null,
      }));
    if (lista.length) out[key] = lista;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mapeamento item canônico do Motor -> snapshot
// ---------------------------------------------------------------------------
//
// Só a fotografia PROJETADA/atual. Nunca `pricing.sold`, `margin.realized`,
// `sales`, reembolso ou pedido — isso vive na Central de Vendas por período.
function mapItemParaSnapshot({ item, run, base, observedAt }) {
  return {
    clienteId: run.clienteId,
    // SEMPRE a conta explícita do run — nunca auto-resolvida.
    clienteContaId: run.clienteContaId,
    marketplace: run.marketplace,
    itemId: item.identity.itemId,
    sku: item.identity.sku,
    titulo: item.identity.titulo,
    baseId: base ? base.id : null,
    imageUrl: item.identity.image || null,

    price: valorProjetado(item, FIELDS.PRICE),
    listPrice: valorProjetado(item, FIELDS.LIST_PRICE),
    promoPrice: valorProjetado(item, FIELDS.PROMO_PRICE),
    cost: valorProjetado(item, FIELDS.COST),
    taxRate: valorProjetado(item, FIELDS.TAX_RATE),
    fixedFee: valorProjetado(item, FIELDS.FIXED_FEE),
    commission: valorProjetado(item, FIELDS.COMMISSION),
    commissionRate: valorProjetado(item, FIELDS.COMMISSION_RATE),
    freight: valorProjetado(item, FIELDS.FREIGHT),

    // Copiado do núcleo — nunca recalculado aqui.
    profit: item.margin.projected.profit,
    margin: item.margin.projected.margin,
    marginPercent: item.margin.projected.marginPercent,
    status: item.quality.status,

    confidenceLevel: item.quality.confidence,
    quality: {
      confidence: item.quality.confidence,
      confidenceByField: item.quality.confidenceByField,
      reasons: item.quality.reasons,
      hasConflict: item.quality.hasConflict,
      hasDrift: item.quality.hasDrift,
      statusLabel: item.quality.statusLabel,
      statusSeverity: item.quality.statusSeverity,
      statusReasons: item.quality.statusReasons,
      integrityCode: item.quality.integrityCode || null,
      invalidInputs: item.quality.invalidInputs || [],
      integrityReason: item.quality.integrityReason || null,
      // Meta usada na classificação — a leitura precisa saber com qual meta
      // o status projetado foi julgado.
      targetMargin: item.margin.target ? item.margin.target.marginTarget : null,
      evidencias: evidenciasProjetadas(item),
      faltantesMeliApi: item.diagnostico ? item.diagnostico.faltantesMeliApi || [] : [],
      temCustoNaBase: item.diagnostico ? item.diagnostico.temCustoNaBase === true : null,
      statusAnuncio: item.diagnostico ? item.diagnostico.statusAnuncio || null : null,
      // Para a leitura distinguir frete AUSENTE (falha) de NÃO APLICÁVEL
      // (logística combinável) — ver margemConfiavel. null = desconhecido.
      logisticType: item.diagnostico ? (item.diagnostico.logisticType ?? null) : null,
      freteAplicavel: item.diagnostico ? margemConfiavel.freteAplicavelDaLogistica(item.diagnostico.logisticType) : null,
      // null = frete cotado direto pelo ML sem avaliação (liberação gradual desligada ou linha antiga).
      freteQualidade: item.diagnostico ? (item.diagnostico.freteQualidade || null) : null,
    },
    missing: item.margin.projected.missing,
    assumed: item.margin.projected.assumed,
    divergences: item.quality.divergences,

    observedAt,
    // null → o repository preenche com NOW() (COALESCE) no momento do upsert.
    calculatedAt: null,
    // DECISÃO PENDENTE do plano (§8.2): o adapter não repassa `last_updated`
    // do ML no contrato; não inventar timestamp.
    sourceUpdatedAt: null,

    runId: run.id,
    refreshStatus: "fresh",
    lastError: null,
  };
}

// Cotação de comissão/frete INCOMPLETA por falha de leitura, não por fato.
// `obterCotacaoAtual` engole 429/timeout de listing_prices/shipping_options
// e devolve null (ver marketplaceCurrentQuoteService) — o núcleo então
// assume 0 e a margem sai "computável" e inflada (ex.: 48% gravado contra
// 22% real, comissão e frete zerados). Frete ausente é legítimo só quando o
// envio é combinável (o ML não cota) — mesma lista de buscarComissaoEFrete.
const LOGISTICAS_COMBINAVEIS = ["not_specified", "custom", ""];

function cotacaoIncompleta(item) {
  const diag = item && item.diagnostico;
  const faltantes = (diag && diag.faltantesMeliApi) || [];
  if (faltantes.includes("comissao")) return true;
  return faltantes.includes("frete") && !LOGISTICAS_COMBINAVEIS.includes((diag && diag.logisticType) || "");
}

// ── Motivo da falha, por item (P0 04/11/2026) ──────────────────────────────
// Antes, toda cotação incompleta virava a MESMA frase e o run só sabia "532
// incompletas". Agora o last_error diz o componente, o motivo e o HTTP status
// (códigos de margemCotacaoEmP.MOTIVOS_COTACAO), e o run guarda a contagem por
// motivo — sem payload do ML, sem token, sem valor financeiro.
const TEXTO_MOTIVO = {
  ml_sem_permissao: "o Mercado Livre recusou o acesso (sem permissão para esta conta)",
  ml_rate_limit: "limite de requisições do Mercado Livre (429)",
  ml_timeout: "tempo esgotado na consulta ao Mercado Livre",
  ml_indisponivel: "Mercado Livre indisponível ou erro na consulta",
  ml_nao_encontrado: "não encontrado no Mercado Livre (404)",
  ml_sem_tarifa: "resposta do Mercado Livre sem a tarifa",
  ml_sem_frete: "resposta do Mercado Livre sem o custo de frete",
  frete_cotacao_nao_confiavel: "cotação de frete do Mercado Livre não confiável para este anúncio (tag proximity sem desconto obrigatório) e sem dimensões/custo cobrado suficientes para estimar",
  anuncio_sem_tipo_ou_categoria: "anúncio sem tipo/categoria na leitura do detalhe",
  conta_sem_seller: "conta sem seller identificado",
  preco_ausente: "preço do anúncio não obtido",
};

function descreverComponente(nome, diag) {
  if (!diag || !diag.motivo) return null;
  const texto = TEXTO_MOTIVO[diag.motivo] || diag.motivo;
  return `${nome}: ${texto}${diag.status ? ` (HTTP ${diag.status})` : ""}`;
}

function motivoCotacaoIncompleta(item) {
  const cot = item && item.diagnostico && item.diagnostico.cotacao;
  const partes = [];
  if (cot) {
    const faltantes = (item.diagnostico.faltantesMeliApi) || [];
    if (faltantes.includes("comissao")) partes.push(descreverComponente("comissão", cot.comissao));
    if (cotacaoIncompleta(item) && faltantes.includes("frete")) partes.push(descreverComponente("frete", cot.frete));
  }
  const detalhe = partes.filter(Boolean).join("; ");
  return detalhe
    ? `Cotação incompleta — ${detalhe}. Margem não recalculada para não gravar valor sem esses custos.`
    : "Comissão ou frete não retornados pelo Mercado Livre nesta leitura; margem não recalculada para não gravar valor sem esses custos.";
}

function motivoNaoRetornado(erroDetalhe) {
  if (!erroDetalhe) return "Item listado no catálogo, mas não retornado pelo detalhe do Mercado Livre nesta leitura.";
  const s = erroDetalhe.status;
  const texto = s === 401 || s === 403
    ? "o Mercado Livre recusou o acesso ao anúncio (token sem permissão para esta conta)"
    : s === 404 ? "anúncio não encontrado no Mercado Livre" : "o Mercado Livre devolveu erro ao ler o anúncio";
  return `Detalhe do anúncio não obtido: ${texto}${s ? ` (HTTP ${s})` : ""}. Margem não recalculada.`;
}

function contarMotivo(mapa, chave) {
  if (!chave) return;
  mapa[chave] = (mapa[chave] || 0) + 1;
}

// Agrupa itemIds por mensagem: um UPDATE por motivo distinto (poucos).
function agruparPorMensagem(pares) {
  const grupos = new Map();
  for (const [id, msg] of pares) {
    if (!grupos.has(msg)) grupos.set(msg, []);
    grupos.get(msg).push(id);
  }
  return grupos;
}

// Vai para log, last_error e error_message: truncada e sem segredo.
function mensagemCurta(err) {
  return redigirSegredos(err?.message || "Erro desconhecido.", 500);
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------
//
// Assinatura compatível com marginSnapshotWorker: `processor(run, { db, signal,
// logger })`. `deps` aceita override de TODAS as peças (Motor, adapter,
// repositories, sleep, config) — é assim que os testes evitam ML/Postgres.
async function processMarginSnapshotRun(run, deps = {}) {
  if (!run || !run.id) {
    throw new Error("processMarginSnapshotRun: run é obrigatório.");
  }
  if (!run.clienteContaId) {
    throw new Error("processMarginSnapshotRun: run.clienteContaId é obrigatório (nunca auto-resolver).");
  }

  const marketplace = String(run.marketplace || "").trim().toLowerCase();
  if (!MARKETPLACES_SUPORTADOS.includes(marketplace)) {
    throw new MarginSnapshotMarketplaceNaoSuportadoError(run.marketplace);
  }

  const db = deps.db || pool;
  const logger = deps.logger || console;
  const signal = deps.signal || null;
  const config = deps.config || resolveMarginSnapshotConfig(deps.env);
  const sleep = deps.sleep || esperar;
  const clock = deps.clock || (() => Date.now());
  const prepareWorkspaceContext = deps.prepareWorkspaceContext || motorMargem.prepareWorkspaceContext;
  const enrichBatch = deps.enrichBatch || motorMargem.enrichBatch;
  const listarIdsCatalogo = deps.listarIdsCatalogo || meliApi.listarIdsCatalogo;
  const upsertProjectionSnapshot = deps.upsertProjectionSnapshot || snapshotRepository.upsertProjectionSnapshot;
  const markSnapshotsRefreshFailed = deps.markSnapshotsRefreshFailed || snapshotRepository.markSnapshotsRefreshFailed;
  const markSnapshotsOutsideCatalog = deps.markSnapshotsOutsideCatalog || snapshotRepository.markSnapshotsOutsideCatalog;
  const updateRunProgress = deps.updateRunProgress || runRepository.updateRunProgress;
  const mergeRunMetadata = deps.mergeRunMetadata || runRepository.mergeRunMetadata;

  // M8 — rate limit do PROCESSO (compartilhado por todos os runs): espaça os
  // inícios de lote e aplica cooldown global depois de 429/Retry-After.
  const limiter = deps.rateLimiter || obterLimiterDoProcesso(config);

  const inicio = clock();
  const stats = {
    retries: 0, rateLimitedRetries: 0, lotesFalhos: 0, itensNaoRetornados: 0, itensForaDoCatalogo: 0,
    cotacaoIncompleta: 0, cotacaoIncompletaRecuperada: 0,
    // Por que faltou: { comissao: { ml_sem_permissao: 532 }, frete: {…}, detalhe: { "403": 532 } }
    motivos: { comissao: {}, frete: {}, detalhe: {} },
  };
  // Último motivo de cotação incompleta por item (para o last_error).
  const motivoIncompletoPorItem = new Map();

  // Log estruturado: ids e contadores, mensagens redigidas (marginSnapshotLog).
  function evento(nivel, nome, campos = {}) {
    logEvento(logger, nivel, nome, { run_id: run.id, cliente_id: run.clienteId, cliente_conta_id: run.clienteContaId, ...campos });
  }

  function verificarParada() {
    if (signal?.aborted) throw new MarginSnapshotStopError();
  }

  // Toda chamada ao ML deste run passa pelo limiter; uma espera interrompida
  // pelo stop nunca dispara a chamada.
  async function comVez(fn) {
    await limiter.aguardarVez(signal);
    verificarParada();
    return fn();
  }

  function aoRetentar(etapa, extra = {}) {
    return ({ tentativa, delayMs, classificacao }) => {
      stats.retries += 1;
      if (classificacao.rateLimited) {
        stats.rateLimitedRetries += 1;
        // 429 é por aplicação: todos os runs do processo esperam.
        limiter.penalizar(delayMs);
      }
      evento("warn", "margin_snapshot_retry", {
        etapa, ...extra, tentativa: tentativa + 1, delay_ms: delayMs,
        status: classificacao.status ?? null, rate_limited: classificacao.rateLimited,
      });
    };
  }

  // Um run que deixou de estar `running` (reconciliado como stale por outra
  // instância, M8) não pode continuar escrevendo: updateRunProgress devolve
  // null quando o UPDATE ... WHERE status='running' não casa.
  async function registrarProgresso(dados) {
    const atualizado = await updateRunProgress({ runId: run.id, db, ...dados });
    if (atualizado === null) {
      throw erroTipado(
        "MARGIN_SNAPSHOT_RUN_NAO_ESTA_MAIS_RUNNING",
        "O run deixou de estar em execução (provável reconciliação por heartbeat); processamento interrompido."
      );
    }
    return atualizado;
  }

  // ── 1. Contexto UMA VEZ, sem vendas (decisão 2) ─────────────────────────
  // Conta explícita: exigirContextoPronto valida que ela pertence ao cliente,
  // é do marketplace e está ativa — erro estrutural propaga (run failed).
  const prepared = await prepareWorkspaceContext(
    { clienteSlug: run.clienteSlug, clienteContaId: run.clienteContaId },
    { ...deps, db, carregarVendas: carregarVendasVazias, agregarPorMlb: agregadoVazio }
  );
  verificarParada();
  const observedAt = isoOrNull(prepared.now);

  // ── 2. Catálogo inteiro (scan) com retry ────────────────────────────────
  // Run PARCIAL ("recalcular só os que falharam", ver idsDoEscopo): a lista
  // vem do metadado do run, sem varrer o catálogo de novo.
  const idsEscopo = idsDoEscopo(run);
  const inicioListagem = clock();
  const listagem = idsEscopo
    ? { ok: true, value: { ids: idsEscopo, totalAtivos: null, totalPausados: null } }
    : await executarComRetry(
      () => comVez(() => listarIdsCatalogo(
        { clienteId: prepared.cliente.id, mlUserId: prepared.mlUserId, maxItens: config.maxCatalogItems },
        deps.mlFetchCatalogo
      )),
      { config, sleep, signal, onRetry: aoRetentar("catalogo") }
    );
  if (!listagem.ok) {
    // Sem catálogo não existe lote para processar: falha estrutural do run.
    const err = erroTipado(
      listagem.error?.code || "MARGIN_SNAPSHOT_CATALOGO_FALHOU",
      `Falha ao listar o catálogo após ${listagem.attempts} tentativa(s): ${mensagemCurta(listagem.error)}`
    );
    throw err;
  }

  const ids = listagem.value.ids;
  const total = ids.length;
  const totalLotes = Math.ceil(total / BATCH_SIZE);
  // Progresso no log a cada ~5% (no máximo ~20 linhas por run), não a cada lote.
  const passoLogLotes = Math.max(1, Math.ceil(totalLotes / 20));
  evento("log", "margin_snapshot_catalog_listed", {
    total, ativos: listagem.value.totalAtivos ?? null, pausados: listagem.value.totalPausados ?? null,
    lotes: totalLotes, duracao_ms: clock() - inicioListagem, escopo: idsEscopo ? "falhas" : "catalogo",
  });

  // Ids que não puderam ser recalculados neste run — viram o escopo de um
  // "recalcular só os que falharam" pedido depois pela tela.
  const idsFalhos = new Set();
  function registrarFalhos(lista) {
    for (const id of lista) idsFalhos.add(String(id));
  }

  // Só contadores e ids — nunca payload do ML, token ou dado financeiro.
  function resumoMetadata() {
    return {
      processor: {
        catalogo: { total, ativos: listagem.value.totalAtivos ?? null, pausados: listagem.value.totalPausados ?? null },
        retries: stats.retries,
        rateLimitedRetries: stats.rateLimitedRetries,
        lotesFalhos: stats.lotesFalhos,
        itensNaoRetornados: stats.itensNaoRetornados,
        itensForaDoCatalogo: stats.itensForaDoCatalogo,
        cotacaoIncompleta: stats.cotacaoIncompleta,
        cotacaoIncompletaRecuperada: stats.cotacaoIncompletaRecuperada,
        motivos: stats.motivos,
        duracaoMs: clock() - inicio,
      },
      // Só ids de anúncio (nada financeiro). Teto para não inflar o jsonb.
      falhas: {
        total: idsFalhos.size,
        itemIds: Array.from(idsFalhos).slice(0, MAX_IDS_FALHOS_GUARDADOS),
      },
    };
  }

  let processedItems = 0;
  let successItems = 0;
  let failedItems = 0;
  let falhasConsecutivas = 0;
  // Itens com cotação incompleta (ver cotacaoIncompleta): nunca gravados com
  // comissão/frete assumidos 0 — vão para a repescagem no fim do run.
  const repescagem = [];

  async function gravarItem(item) {
    const itemId = String(item.identity.itemId);
    try {
      const dados = mapItemParaSnapshot({ item, run, base: prepared.base, observedAt });
      await upsertProjectionSnapshot(dados, db);
      successItems += 1;
    } catch (err) {
      // Falha técnica isolada de persistência: a linha anterior (se
      // existir) fica intocada — o UPSERT simplesmente não aconteceu.
      failedItems += 1;
      registrarFalhos([itemId]);
      evento("error", "margin_snapshot_item_persist_failed", { item_id: itemId, erro: mensagemCurta(err) });
    }
  }

  await registrarProgresso({ processedItems, successItems, failedItems, cursorOffset: 0, totalItems: total });

  // ── 3. Lotes sequenciais ────────────────────────────────────────────────
  // Nunca Promise.all de lotes; nunca teto de 200. Um lote termina (sucesso
  // ou falha definitiva) antes do próximo começar.
  for (let offset = 0; offset < total; offset += BATCH_SIZE) {
    verificarParada();
    const loteIds = ids.slice(offset, offset + BATCH_SIZE);

    const tentativa = await executarComRetry(
      () => comVez(() => enrichBatch(prepared, { itemIds: loteIds }, { ...deps, db })),
      { config, sleep, signal, onRetry: aoRetentar("lote", { offset }) }
    );

    if (tentativa.ok) {
      falhasConsecutivas = 0;
      const retornados = new Set();
      for (const item of tentativa.value.itens || []) {
        const itemId = item?.identity?.itemId ? String(item.identity.itemId) : "";
        // O multiget pode devolver entrada de erro sem id (item excluído entre
        // a listagem e o detalhe): não é snapshot, é "não retornado" abaixo.
        if (!itemId || !loteIds.includes(itemId) || retornados.has(itemId)) continue;
        retornados.add(itemId);
        if (cotacaoIncompleta(item)) {
          repescagem.push(itemId);
          const cot = item.diagnostico && item.diagnostico.cotacao;
          contarMotivo(stats.motivos.comissao, cot && cot.comissao && cot.comissao.motivo);
          contarMotivo(stats.motivos.frete, cot && cot.frete && cot.frete.motivo);
          motivoIncompletoPorItem.set(itemId, motivoCotacaoIncompleta(item));
          continue;
        }
        await gravarItem(item);
      }

      const naoRetornados = loteIds.filter((id) => !retornados.has(id));
      if (naoRetornados.length) {
        stats.itensNaoRetornados += naoRetornados.length;
        failedItems += naoRetornados.length;
        registrarFalhos(naoRetornados);
        const errosPorId = new Map((tentativa.value.errosDetalhe || []).filter((e) => e && e.id).map((e) => [String(e.id), e]));
        for (const id of naoRetornados) contarMotivo(stats.motivos.detalhe, String(errosPorId.get(id)?.status ?? "sem_status"));
        const grupos = agruparPorMensagem(naoRetornados.map((id) => [id, motivoNaoRetornado(errosPorId.get(id))]));
        if (errosPorId.size) {
          evento("warn", "margin_snapshot_detalhe_recusado", { itens: naoRetornados.length, por_status: { ...stats.motivos.detalhe } });
        }
        for (const [lastError, itemIds] of grupos) {
          await markSnapshotsRefreshFailed({
            clienteId: run.clienteId, clienteContaId: run.clienteContaId, marketplace,
            itemIds, runId: run.id, lastError, db,
          });
        }
      }
    } else {
      // Falha DEFINITIVA do lote: falha parcial do run, não exceção. As
      // linhas que já existiam ficam com valores anteriores + status failed.
      falhasConsecutivas += 1;
      stats.lotesFalhos += 1;
      failedItems += loteIds.length;
      registrarFalhos(loteIds);
      const motivo = `Lote não pôde ser recalculado (${tentativa.motivo}, ${tentativa.attempts} tentativa(s)): ${mensagemCurta(tentativa.error)}`;
      evento("error", "margin_snapshot_batch_failed", {
        offset, itens: loteIds.length, tentativas: tentativa.attempts, motivo: tentativa.motivo,
        status: tentativa.classificacao?.status ?? null, erro: mensagemCurta(tentativa.error),
        falhas_consecutivas: falhasConsecutivas,
      });
      await markSnapshotsRefreshFailed({
        clienteId: run.clienteId, clienteContaId: run.clienteContaId, marketplace,
        itemIds: loteIds, runId: run.id, lastError: motivo, db,
      });

      if (falhasConsecutivas >= config.maxConsecutiveBatchFailures) {
        processedItems += loteIds.length;
        await registrarProgresso({ processedItems, successItems, failedItems, cursorOffset: offset + loteIds.length, totalItems: total });
        await mergeRunMetadata({ runId: run.id, patch: resumoMetadata(), db });
        throw erroTipado(
          "MARGIN_SNAPSHOT_LOTES_FALHANDO",
          `${falhasConsecutivas} lote(s) seguidos falharam; run interrompido. Último erro: ${mensagemCurta(tentativa.error)}`
        );
      }
    }

    processedItems += loteIds.length;
    // Cursor só avança DEPOIS de todo o lote persistido/marcado. O mesmo
    // UPDATE renova heartbeat_at (é o heartbeat "por lote").
    await registrarProgresso({ processedItems, successItems, failedItems, cursorOffset: offset + loteIds.length, totalItems: total });

    const loteNumero = offset / BATCH_SIZE + 1;
    if (loteNumero % passoLogLotes === 0 || loteNumero === totalLotes) {
      evento("log", "margin_snapshot_batch_progress", {
        lote: loteNumero, lotes: totalLotes, processados: processedItems, total, sucesso: successItems, falhas: failedItems,
      });
    }
    // Espaçamento entre lotes: feito pelo limiter do processo (comVez), que
    // vale para TODOS os runs — não há mais pausa própria por run aqui.
  }

  // ── 3b. Repescagem da cotação incompleta ────────────────────────────────
  // Falha de comissão/frete costuma ser 429 momentâneo do ML: uma segunda
  // leitura, depois de uma pausa, normalmente traz os valores. O que
  // continuar incompleto NÃO é gravado — a linha anterior (se houver) fica
  // com os valores dela + refresh_status failed, como num lote que falhou.
  // Um número inflado na lista é pior que um número antigo ou "—".
  stats.cotacaoIncompleta = repescagem.length;
  if (repescagem.length) {
    await sleep(config.batchBackoffBaseMs, signal);
    const aindaIncompletos = [];
    for (let i = 0; i < repescagem.length; i += BATCH_SIZE) {
      verificarParada();
      const loteIds = repescagem.slice(i, i + BATCH_SIZE);
      const tentativa = await executarComRetry(
        () => comVez(() => enrichBatch(prepared, { itemIds: loteIds }, { ...deps, db })),
        { config, sleep, signal, onRetry: aoRetentar("repescagem_cotacao") }
      );
      const recuperados = new Set();
      if (tentativa.ok) {
        for (const item of tentativa.value.itens || []) {
          const itemId = item?.identity?.itemId ? String(item.identity.itemId) : "";
          if (!loteIds.includes(itemId) || recuperados.has(itemId)) continue;
          // Ainda incompleto: o motivo da 2ª leitura é o que vale no last_error.
          if (cotacaoIncompleta(item)) { motivoIncompletoPorItem.set(itemId, motivoCotacaoIncompleta(item)); continue; }
          recuperados.add(itemId);
          stats.cotacaoIncompletaRecuperada += 1;
          await gravarItem(item);
        }
      }
      for (const id of loteIds) if (!recuperados.has(id)) aindaIncompletos.push(id);
    }
    if (aindaIncompletos.length) {
      failedItems += aindaIncompletos.length;
      registrarFalhos(aindaIncompletos);
      evento("warn", "margin_snapshot_cotacao_incompleta", {
        itens: aindaIncompletos.length, recuperados: stats.cotacaoIncompletaRecuperada,
        motivos_comissao: { ...stats.motivos.comissao }, motivos_frete: { ...stats.motivos.frete },
      });
      const grupos = agruparPorMensagem(aindaIncompletos.map((id) => [id, motivoIncompletoPorItem.get(id) || motivoCotacaoIncompleta(null)]));
      for (const [lastError, itemIds] of grupos) {
        await markSnapshotsRefreshFailed({
          clienteId: run.clienteId, clienteContaId: run.clienteContaId, marketplace,
          itemIds, runId: run.id, lastError, db,
        });
      }
    }
    await registrarProgresso({ processedItems, successItems, failedItems, cursorOffset: total, totalItems: total });
  }

  // ── 4. Itens fora do catálogo (listagem completa e bem-sucedida) ────────
  // Run parcial não listou o catálogo: marcar "fora" tudo que não está na
  // lista dele seria apagar a conta inteira da leitura.
  if (!idsEscopo) {
    const foraDoCatalogo = await markSnapshotsOutsideCatalog({
      clienteId: run.clienteId, clienteContaId: run.clienteContaId, marketplace,
      catalogItemIds: ids, runId: run.id, db,
    });
    stats.itensForaDoCatalogo = foraDoCatalogo.length;
  }

  await mergeRunMetadata({ runId: run.id, patch: resumoMetadata(), db });

  // Nenhum item calculado num catálogo não vazio = nada foi atualizado: o
  // run não pode terminar "completed" fingindo sucesso. No run parcial o
  // resultado "todos falharam de novo" é informação (completed com
  // failedItems = total), e a tela oferece tentar outra vez.
  if (!idsEscopo && total > 0 && successItems === 0) {
    throw erroTipado(
      "MARGIN_SNAPSHOT_NENHUM_ITEM_CALCULADO",
      `Nenhum dos ${total} item(ns) do catálogo pôde ser recalculado neste run.`
    );
  }

  evento("log", "margin_snapshot_processed", {
    total, sucesso: successItems, falhas: failedItems, retries: stats.retries,
    retries_rate_limit: stats.rateLimitedRetries, lotes_falhos: stats.lotesFalhos,
    fora_do_catalogo: stats.itensForaDoCatalogo, duracao_ms: clock() - inicio,
  });

  return { processedItems, successItems, failedItems, totalItensMl: total, cursorOffset: total, stats };
}

module.exports = {
  BATCH_SIZE,
  MARKETPLACES_SUPORTADOS,
  MAX_IDS_FALHOS_GUARDADOS,
  idsDoEscopo,
  MarginSnapshotMarketplaceNaoSuportadoError,
  mapItemParaSnapshot,
  evidenciasProjetadas,
  carregarVendasVazias,
  agregadoVazio,
  processMarginSnapshotRun,
};
