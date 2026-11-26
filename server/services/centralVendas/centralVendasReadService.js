// server/services/centralVendas/centralVendasReadService.js
//
// M7 — Read API canônica e paginada.
//
// Não é um segundo motor de leitura: reaproveita integralmente
// `centralVendasService.resolveRangeContext` (seleção published/candidate/
// legacy do M4, account-awareness do M1, cobertura do M4) e
// `buildPayloadFromRange` (motor/summary/completude — M3/M4 — e o contrato
// de pedido por item/componente — M5/M6), exatamente como o GET legado.
//
// O que este arquivo adiciona é só leitura: filtro, busca, ordenação
// determinística e paginação sobre a lista de pedidos JÁ CALCULADA pelo
// motor canônico — nenhuma fórmula financeira nova, nenhuma seleção de
// snapshot paralela.

const pool = require("../../config/database");
const { detalharPedido } = require("./centralVendasDetalheFinanceiro");
const { assinaturaBaseCustos, compararAssinatura } = require("./centralVendasBaseCustosAssinatura");

function getRepository() {
  return require("./centralVendasRepository");
}

const {
  createCentralVendasService,
  buildPayloadFromRange,
  buildContextoPayload,
  buildResumoFromRange,
  buildDiario,
  buildAbcProdutos,
} = require("./centralVendasService");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// M10 — instrumentação condicional (seção 13): só mede/loga quando
// CENTRAL_VENDAS_PERF_LOG=1 — nunca poluição permanente em produção.
// `resolveContextMs` cobre identidade+seleção M4+carga do período (uma
// chamada atômica a base.resolveRangeContext — não dá pra separar DB de
// resolve-de-identidade sem reabrir esse contrato, que várias suítes já
// mockam diretamente); `buildMs` é buildPayloadFromRange (contrato
// canônico M5/M6 por pedido); `aggregationMs` é filtro/ordenação/paginação
// + diário/ABC quando aplicável. Nunca loga token/Authorization/payload
// financeiro — só ms e contagens.
const PERF_LOG_ENABLED = String(process.env.CENTRAL_VENDAS_PERF_LOG || "") === "1";

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function round1(ms) {
  return Math.round(ms * 10) / 10;
}

function logPerf(endpoint, timings, counts) {
  if (!PERF_LOG_ENABLED) return;
  console.log(`[centralVendas][perf] ${endpoint}`, { ...timings, ...counts });
}

function clampPage(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function clampLimit(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// Espelha QUICK_FILTERS de Portal/fechamentos-api.js — mesma semântica,
// mesmas chaves, calculada sobre o contrato de pedido já canônico
// (buildPedidoContrato), nunca recalculada a partir de dado bruto.
function pedidoMatchesQuick(o, q) {
  switch (q) {
    case "sem_custo": return !!o.mlb && o.custoStatus === "ausente";
    case "sem_frete": return o.entraNoResultado && o.frete == null;
    case "frete_real": return o.frete != null;
    case "calculavel": return o.resultado != null;
    case "bloqueados": return o.resultadoStatus === "bloqueado" && o.entraNoResultado;
    case "receita_bloqueada": return o.resultadoStatus === "bloqueado" && o.entraNoResultado;
    case "cancel_problema": return o.status === "cancelado" || o.status === "com_problema";
    case "full": return o.full === true;
    case "normal": return o.full !== true;
    default: return true;
  }
}

// Espelha o filtro avançado "status" de Portal/fechamentos-api.js.
function pedidoMatchesStatus(o, s) {
  switch (s) {
    case "valido": return o.status === "pago";
    case "cancelado": return o.status === "cancelado";
    case "problema": return o.status === "com_problema";
    case "bloqueado": return o.resultadoStatus === "bloqueado" && o.entraNoResultado;
    default: return true;
  }
}

// Espelha o filtro avançado "logistica" de Portal/fechamentos-api.js.
function pedidoMatchesLogistica(o, l) {
  if (l === "full") return o.full === true;
  if (l === "nao_full") return o.full !== true;
  return true;
}

// Espelha o filtro avançado "diagbase" de Portal/fechamentos-api.js — só as
// opções com_custo/sem_custo sobrevivem ao M9 (no_diag/fora_diag dependiam
// de `produtos[mlb].diag.presente`, que o motor real nunca preenche —
// sempre `false` — então essas duas opções eram inertes com dado real;
// removidas do frontend nesse marco, não portadas aqui).
function pedidoMatchesDiagbase(o, d) {
  if (d === "com_custo") return o.custoStatus === "real";
  if (d === "sem_custo") return o.custoStatus === "ausente";
  return true;
}

// Mesmos campos que a busca local de Portal/fechamentos-api.js
// (pedidoMatchesSearch) já usa.
function pedidoMatchesSearch(o, term) {
  if (!term) return true;
  return String(o.id || "").toLowerCase().includes(term)
    || String(o.mlb || "").toLowerCase().includes(term)
    || String(o.sku || "").toLowerCase().includes(term)
    || String(o.produto?.titulo || "").toLowerCase().includes(term)
    || String(o.status || "").toLowerCase().includes(term)
    || String(o.logistica || "").toLowerCase().includes(term);
}

// Ordenação determinística: cada critério compara primeiro pelo campo
// pedido, depois SEMPRE por rowId como desempate — nunca dois pedidos
// empatados podem trocar de página entre requisições (seção 12).
const CONF_RANK = { bloqueado: 0, parcial: 1, confiavel: 2 };
function compareByRowId(x, y) {
  return (Number(x.rowId) || 0) - (Number(y.rowId) || 0);
}
function sortPedidos(arr, key) {
  const a = arr.slice();
  const withTieBreak = (cmp) => (x, y) => { const r = cmp(x, y); return r !== 0 ? r : compareByRowId(x, y); };
  const desc = (f) => withTieBreak((x, y) => (Number(f(y)) || 0) - (Number(f(x)) || 0));
  const asc = (f) => withTieBreak((x, y) => (Number(f(x)) || 0) - (Number(f(y)) || 0));
  switch (key) {
    case "data_asc": a.sort(withTieBreak((x, y) => String(x.data || "").localeCompare(String(y.data || "")))); break;
    case "fat_desc": a.sort(desc((o) => o.valor)); break;
    case "fat_asc": a.sort(asc((o) => o.valor)); break;
    case "comissao_desc": a.sort(desc((o) => o.taxas)); break;
    case "frete_desc": a.sort(desc((o) => o.frete)); break;
    case "custo_desc": a.sort(desc((o) => o.custo)); break;
    case "resultado_desc": a.sort(desc((o) => o.resultado)); break;
    case "bloqueada_desc": a.sort(desc((o) => (o.resultadoStatus === "bloqueado" && o.entraNoResultado) ? (o.valor || 0) : 0)); break;
    case "confianca": a.sort(withTieBreak((x, y) => (CONF_RANK[x.confianca] ?? 9) - (CONF_RANK[y.confianca] ?? 9))); break;
    case "data_desc":
    default: a.sort(withTieBreak((x, y) => String(y.data || "").localeCompare(String(x.data || "")))); break;
  }
  return a;
}

function buildSnapshotMeta(snapshot) {
  if (!snapshot?.importacao) return null;
  const importacao = snapshot.importacao;
  return {
    importId: importacao.id,
    fonte: importacao.fonte || null,
    publicationStatus: importacao.publication_status || null,
    coverageDateFrom: importacao.coverage_date_from || null,
    coverageDateTo: importacao.coverage_date_to || null,
    publishedAt: importacao.published_at || null,
    geradoEm: importacao.created_at || null,
  };
}

// Campos "leves" da linha — sem itens/componentes (payload pesado fica só
// no detalhe sob demanda, seção 9 do M7).
function toListRow(pedido) {
  const { itens, componentes, ...resto } = pedido;
  return resto;
}

// M10, seção 8 (paginação) — decisão deliberada de NÃO empurrar filtro/
// ordenação/paginação para SQL nesta rodada: `filtro`/`status`/`diagbase`
// (sem_custo, bloqueados, resultadoStatus, custoStatus...) e todos os
// critérios de `sort` são campos DERIVADOS por buildPedidoContrato a partir
// de itens/componentes já em memória (sumComponents, confidenceToResultado
// Status) — não existem como coluna em central_vendas_pedidos. Reimplementar
// esses predicados em SQL seria uma SEGUNDA regra financeira (proibido pela
// seção 4 do marco: "nenhuma fórmula financeira nova dentro do repository").
// O ganho real do M10 já veio de outro lugar: a carga pesada (itens/
// componentes do período) passou a rodar 1x por request em vez de 3x
// (bootstrap) e o detalhe de 1 pedido parou de rodar essa carga inteira —
// ver getPedidoDetailByRowId. `rows` continua sendo slice em memória sobre
// o array já filtrado/ordenado; qualquer pushdown futuro exigiria persistir
// os campos derivados como colunas (fora de escopo deste marco).
//
// filtro+busca+ordenação+paginação+filteredSummary sobre um `payload` JÁ
// construído (buildPayloadFromRange já rodou). Extraído de
// getCentralVendasRead para ser reusado por getCentralVendasReadBootstrap
// sem reconstruir o período uma segunda vez — nenhuma regra nova, é
// literalmente o mesmo corpo que existia dentro de getCentralVendasRead.
function deriveListaEResumo(payload, params = {}) {
  const {
    page, limit, sort = "data_desc",
    filtro = "todos", status = "todos", logistica = "todos", diagbase = "todos", search = "",
    // M9 — refinamento de data DENTRO do período já selecionado (clique num
    // dia/linha de "Vendas por dia"). Nunca troca o período de análise
    // (dateFrom/dateTo, que continua definindo `summary`/`motor`/
    // `completude` — seção 10): só recorta quais pedidos entram nas
    // `rows` paginadas, igual ao antigo filtro local `modo:'intervalo'`.
    dataDe = null, dataAte = null,
    // M9 — recorte independente do "Fechamento do período" (Visão Geral):
    // mesmos valores de `filtro` (todos/sem_custo/sem_frete/bloqueados/
    // calculavel), mas nunca lido como o `filtro` das `rows` — ver seção
    // 10: dois conceitos, dois campos, nunca reaproveita `summary` com
    // outro significado.
    resumoFiltro = "todos",
  } = params;

  const termo = String(search || "").trim().toLowerCase();

  const dentroDoSubperiodo = (o) =>
    (!dataDe || (o.data && o.data >= dataDe)) && (!dataAte || (o.data && o.data <= dataAte));

  const filtrados = (payload.pedidos || [])
    .filter(dentroDoSubperiodo)
    .filter((o) => pedidoMatchesQuick(o, filtro))
    .filter((o) => pedidoMatchesStatus(o, status))
    .filter((o) => pedidoMatchesLogistica(o, logistica))
    .filter((o) => pedidoMatchesDiagbase(o, diagbase))
    .filter((o) => pedidoMatchesSearch(o, termo));

  const ordenados = sortPedidos(filtrados, sort);

  const limitClamped = clampLimit(limit);
  const total = ordenados.length;
  const totalPages = total ? Math.ceil(total / limitClamped) : 0;
  const pageClamped = clampPage(page);

  const inicio = (pageClamped - 1) * limitClamped;
  const rows = ordenados.slice(inicio, inicio + limitClamped).map(toListRow);

  const pedidosDoResumoFiltrado = (payload.pedidos || []).filter((o) => pedidoMatchesQuick(o, resumoFiltro));
  const filteredSummary = buildResumoFromRange({}, pedidosDoResumoFiltrado);
  // Pós-venda (claims) não verificado é um sinal do SNAPSHOT inteiro, não
  // de um recorte — nunca calculado por subconjunto. Mesmo ajuste que a
  // tela aplicava localmente após buildFechamentoResumo (seção 6 do M9).
  if (payload.resumo?.claimsIndisponivel && pedidosDoResumoFiltrado.length) {
    filteredSummary.confiancaFechamento = "parcial";
  }

  return { rows, pagination: { page: pageClamped, limit: limitClamped, total, totalPages }, filteredSummary };
}

function createCentralVendasReadService(repository = getRepository(), db = pool) {
  const base = createCentralVendasService(repository, db);

  async function getCentralVendasRead(clienteSlug, params = {}) {
    const { dateFrom, dateTo, marketplace = "meli", clienteContaId = null } = params;
    const t0 = nowMs();

    const { cliente, context, snapshot, dateFrom: from, dateTo: to } =
      await base.resolveRangeContext(clienteSlug, { dateFrom, dateTo, marketplace, clienteContaId });
    const t1 = nowMs();

    const payload = buildPayloadFromRange(cliente, { dateFrom: from, dateTo: to }, snapshot);
    const t2 = nowMs();
    const { rows, pagination, filteredSummary } = deriveListaEResumo(payload, params);
    const t3 = nowMs();

    logPerf("read", {
      resolveContextMs: round1(t1 - t0), buildMs: round1(t2 - t1), aggregationMs: round1(t3 - t2), totalMs: round1(t3 - t0),
    }, {
      pedidos: snapshot?.pedidos?.length || 0, itens: snapshot?.itens?.length || 0, componentes: snapshot?.componentes?.length || 0,
    });

    return {
      ok: true,
      cliente,
      periodo: payload.periodo,
      contexto: buildContextoPayload(context),
      snapshot: buildSnapshotMeta(snapshot),
      motor: payload.motor,
      completude: payload.completude,
      summary: payload.resumo,
      filteredSummary,
      rows,
      pagination,
    };
  }

  // M9 — agregado diário (Vendas por dia), período inteiro, independente de
  // página/filtro da tabela de pedidos. Mesmo snapshot/payload de
  // getCentralVendasRead — nenhuma segunda seleção de snapshot.
  async function getCentralVendasReadDaily(clienteSlug, params = {}) {
    const { dateFrom, dateTo, marketplace = "meli", clienteContaId = null } = params;
    const t0 = nowMs();
    const { cliente, context, snapshot, dateFrom: from, dateTo: to } =
      await base.resolveRangeContext(clienteSlug, { dateFrom, dateTo, marketplace, clienteContaId });
    const t1 = nowMs();
    const payload = buildPayloadFromRange(cliente, { dateFrom: from, dateTo: to }, snapshot);
    const t2 = nowMs();
    const dias = buildDiario(payload.pedidos || []);
    const t3 = nowMs();
    logPerf("read/daily", {
      resolveContextMs: round1(t1 - t0), buildMs: round1(t2 - t1), aggregationMs: round1(t3 - t2), totalMs: round1(t3 - t0),
    }, { pedidos: snapshot?.pedidos?.length || 0 });
    return {
      ok: true,
      cliente,
      periodo: payload.periodo,
      contexto: buildContextoPayload(context),
      snapshot: buildSnapshotMeta(snapshot),
      motor: payload.motor,
      dias,
    };
  }

  // M9 — Curva ABC / Produtos, período inteiro, independente de
  // página/filtro da tabela de pedidos. Mesmo snapshot/payload de
  // getCentralVendasRead — nenhuma segunda seleção de snapshot.
  async function getCentralVendasReadProducts(clienteSlug, params = {}) {
    const { dateFrom, dateTo, marketplace = "meli", clienteContaId = null } = params;
    const t0 = nowMs();
    const { cliente, context, snapshot, dateFrom: from, dateTo: to } =
      await base.resolveRangeContext(clienteSlug, { dateFrom, dateTo, marketplace, clienteContaId });
    const t1 = nowMs();
    const payload = buildPayloadFromRange(cliente, { dateFrom: from, dateTo: to }, snapshot);
    const t2 = nowMs();
    const { produtos, totalFat } = buildAbcProdutos(payload.pedidos || [], payload.produtos || {});
    const t3 = nowMs();
    logPerf("read/products", {
      resolveContextMs: round1(t1 - t0), buildMs: round1(t2 - t1), aggregationMs: round1(t3 - t2), totalMs: round1(t3 - t0),
    }, { pedidos: snapshot?.pedidos?.length || 0 });
    return {
      ok: true,
      cliente,
      periodo: payload.periodo,
      contexto: buildContextoPayload(context),
      snapshot: buildSnapshotMeta(snapshot),
      motor: payload.motor,
      produtos,
      totalFaturamento: totalFat,
    };
  }

  // M10 — não reconstrói mais o período inteiro para achar 1 pedido (era o
  // gargalo real medido: ~8.3s server-side para abrir 1 pedido num período
  // de ~415). resolveOrderDetail reusa a MESMA seleção M4 de snapshot
  // (resolveRangeImports) e só carrega o pedido pedido + seus itens/
  // componentes (centralVendasRepository.getPedidoDetailByRowId), montando
  // o mesmo contrato canônico via buildPedidoContrato — nenhuma fórmula
  // nova, nenhum campo a menos.
  async function getCentralVendasReadOrderDetail(clienteSlug, rowId, params = {}) {
    const { dateFrom, dateTo, marketplace = "meli", clienteContaId = null } = params;
    const rowIdNum = Number(rowId);

    // `pedido_row_id` é bigint no Postgres: o driver `pg` devolve bigint como
    // STRING (evita perda de precisão) — o rowId da URL precisa ser um
    // número válido antes de qualquer query (achado real do M9, preservado).
    if (!Number.isFinite(rowIdNum)) {
      const err = new Error("Pedido nao encontrado neste snapshot.");
      err.statusCode = 404;
      throw err;
    }

    // Nunca aceita rowId isolado: só existe resposta se o pedido pertencer a
    // um dos imports elegíveis para este cliente/conta/marketplace/range
    // (mesmo escopo account-aware que getCentralVendasByRange sempre
    // aplicou) — evita IDOR por construção, sem checagem extra de posse.
    const t0 = nowMs();
    const { pedido, linhaPedido, context } = await base.resolveOrderDetail(clienteSlug, rowIdNum, { dateFrom, dateTo, marketplace, clienteContaId });
    const composicaoFinanceira = pedido ? await montarComposicaoFinanceira(pedido, linhaPedido, context) : null;
    const t1 = nowMs();
    logPerf("read/orders/:rowId", { totalMs: round1(t1 - t0) }, {
      itens: pedido?.itens?.length || 0, componentes: pedido?.componentes?.length || 0,
    });
    if (!pedido) {
      const err = new Error("Pedido nao encontrado neste snapshot.");
      err.statusCode = 404;
      throw err;
    }

    return { ok: true, pedido, composicaoFinanceira };
  }

  // Detalhamento financeiro (aditivo, ao lado de `pedido`): leitura extra por
  // chave + assinatura da base atual. Falha de metadado nunca derruba o
  // detalhe: a composição sai com o que se sabe e a base fica "indisponível".
  async function montarComposicaoFinanceira(pedido, linhaPedido, context) {
    let meta = { variacoes: new Map(), composicaoColetada: false, baseCustos: null };
    let baseCustos = null;
    try {
      if (linhaPedido && typeof repository.getMetaFinanceiraDoPedido === "function") {
        meta = await repository.getMetaFinanceiraDoPedido({ pedidoRowId: linhaPedido.id, importId: linhaPedido.import_id }, db);
      }
      const baseAtualId = context?.base?.base_id ?? null;
      const atual = meta.baseCustos ? await assinaturaBaseCustos(db, baseAtualId) : null;
      baseCustos = compararAssinatura(meta.baseCustos, atual);
    } catch (_) {
      baseCustos = { estado: "indisponivel", gravada: meta.baseCustos || null, atual: null };
    }
    const payload = linhaPedido && linhaPedido.payload_json
      ? (typeof linhaPedido.payload_json === "string" ? JSON.parse(linhaPedido.payload_json) : linhaPedido.payload_json)
      : {};
    return detalharPedido(pedido, {
      variacoes: meta.variacoes,
      composicaoColetada: meta.composicaoColetada,
      composicaoDoPedido: payload.composicaoPromocional || null,
      baseCustos,
    });
  }

  // M10 — resolve contexto e constrói o payload do período UMA vez só e
  // deriva, no mesmo processo, tudo que a carga inicial da tela hoje busca
  // em 3 requests separados (/read + /read/daily + /read/products, cada um
  // rodando resolveRangeContext + buildPayloadFromRange do zero). Endpoints
  // antigos continuam existindo e inalterados (compat) — este é aditivo.
  async function getCentralVendasReadBootstrap(clienteSlug, params = {}) {
    const { dateFrom, dateTo, marketplace = "meli", clienteContaId = null } = params;
    const t0 = nowMs();

    const { cliente, context, snapshot, dateFrom: from, dateTo: to } =
      await base.resolveRangeContext(clienteSlug, { dateFrom, dateTo, marketplace, clienteContaId });
    const t1 = nowMs();

    const payload = buildPayloadFromRange(cliente, { dateFrom: from, dateTo: to }, snapshot);
    const t2 = nowMs();
    const { rows, pagination, filteredSummary } = deriveListaEResumo(payload, params);
    const { produtos, totalFat } = buildAbcProdutos(payload.pedidos || [], payload.produtos || {});
    const dias = buildDiario(payload.pedidos || []);
    const t3 = nowMs();

    logPerf("read/bootstrap", {
      resolveContextMs: round1(t1 - t0), buildMs: round1(t2 - t1), aggregationMs: round1(t3 - t2), totalMs: round1(t3 - t0),
    }, {
      pedidos: snapshot?.pedidos?.length || 0, itens: snapshot?.itens?.length || 0, componentes: snapshot?.componentes?.length || 0,
    });

    return {
      ok: true,
      cliente,
      periodo: payload.periodo,
      contexto: buildContextoPayload(context),
      snapshot: buildSnapshotMeta(snapshot),
      motor: payload.motor,
      completude: payload.completude,
      summary: payload.resumo,
      filteredSummary,
      rows,
      pagination,
      dias,
      produtos,
      totalFaturamento: totalFat,
    };
  }

  return {
    getCentralVendasRead,
    getCentralVendasReadOrderDetail,
    getCentralVendasReadDaily,
    getCentralVendasReadProducts,
    getCentralVendasReadBootstrap,
    resolveRangeContext: base.resolveRangeContext,
  };
}

module.exports = {
  createCentralVendasReadService,
  getCentralVendasRead: (...args) => createCentralVendasReadService().getCentralVendasRead(...args),
  getCentralVendasReadOrderDetail: (...args) => createCentralVendasReadService().getCentralVendasReadOrderDetail(...args),
  getCentralVendasReadDaily: (...args) => createCentralVendasReadService().getCentralVendasReadDaily(...args),
  getCentralVendasReadProducts: (...args) => createCentralVendasReadService().getCentralVendasReadProducts(...args),
  getCentralVendasReadBootstrap: (...args) => createCentralVendasReadService().getCentralVendasReadBootstrap(...args),
  // Exposto para teste direto das funções puras (filtro/ordenação).
  pedidoMatchesQuick,
  pedidoMatchesStatus,
  pedidoMatchesLogistica,
  pedidoMatchesDiagbase,
  pedidoMatchesSearch,
  sortPedidos,
  deriveListaEResumo,
};
