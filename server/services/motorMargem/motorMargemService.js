// server/services/motorMargem/motorMargemService.js
// ORQUESTRADOR do Motor de Margem — junta as fontes, chama o núcleo puro e
// devolve o contrato que a Central de Margem consome.
//
//   Bases (custos)          ─┐
//   Mercado Livre API       ─┤
//   Central de Vendas       ─┼→ camada de evidências → núcleo → item de margem
//   Mercado Pago (ausente)  ─┤
//   Extensão (sem canal)    ─┘
//
// SOMENTE LEITURA em tudo: SELECT no Postgres, GET no Mercado Livre. Nenhuma
// escrita de preço, promoção, custo ou base.
//
// REÚSO: `exigirContextoPronto` (contextoPrecificacaoService) é a MESMA
// resolução de cliente + grant ML + base MELI vinculada usada pelo Otimizador
// de Precificação. O Motor não refaz consulta em `base_cliente_vinculos`.

const {
  exigirContextoPronto,
  resolverContextoPrecificacao,
  contarContasMeliAtivas,
} = require("../automacoes/contextoPrecificacaoService");
const { createEvidenceBag, FIELDS } = require("./core/marginEvidence");
const { buildMarginItem } = require("./core/marginItem");
const { LEVELS } = require("./core/marginConfidence");
const { STATUS, DEFAULT_TARGET_MARGIN } = require("./core/marginStatus");
const baseCustos = require("./adapters/baseCustosEvidenceAdapter");
const meliApi = require("./adapters/meliApiEvidenceAdapter");
const centralVendas = require("./adapters/centralVendasEvidenceAdapter");
const settlement = require("./adapters/settlementEvidenceAdapter");
const extensao = require("./adapters/extensionEvidenceAdapter");
const { resolverPeriodoRealizado } = require("./marginRealizadoPeriodo");

const MARKETPLACE = "meli";
const PAGE_LIMIT_DEFAULT = 20;
const PAGE_LIMIT_MAX = 20; // teto do multiget /items?ids= do Mercado Livre
const RESUMO_MAX_ITENS_DEFAULT = 60;
const RESUMO_MAX_ITENS_TETO = 200;
const CONCURRENCY = 5;

function criarErroHttp(statusCode, payload) {
  const err = new Error(payload?.erro || "Erro");
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

function isValidIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Período padrão: últimos 30 dias encerrando ONTEM no fuso da operação
// (America/Sao_Paulo). O sync noturno da Central de Vendas publica o mês
// corrente só até ontem e a seleção M4 recusa um import que não cobre o
// trecho pedido inteiro — um padrão "até hoje" fazia o mês corrente sumir do
// realizado (e do % faturamento/Curva ABC de Anúncios ML, que usa este mesmo
// padrão). Ver marginRealizadoPeriodo e AUDITORIA_REALIZADO_MARGIN_SYNC R-01.
// A Central pode sobrescrever com datas explícitas.
function resolverPeriodo({ dateFrom, dateTo, now = new Date() }) {
  if (isValidIsoDate(dateFrom) && isValidIsoDate(dateTo)) {
    return dateFrom <= dateTo
      ? { dateFrom, dateTo }
      : { dateFrom: dateTo, dateTo: dateFrom };
  }
  const padrao = resolverPeriodoRealizado({ now });
  return { dateFrom: padrao.dateFrom, dateTo: padrao.dateTo };
}

function parseTargetMargin(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TARGET_MARGIN;
  // Aceita 0.12 e 12 — a Central pode mandar em qualquer das duas escalas.
  const fraction = n > 1 ? n / 100 : n;
  return fraction > 0 && fraction < 1 ? fraction : DEFAULT_TARGET_MARGIN;
}

// Executa `fn` sobre `items` com paralelismo limitado. Evita disparar 40
// requisições simultâneas ao Mercado Livre por página.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Contexto: quais fontes estão disponíveis para este cliente/período
// ---------------------------------------------------------------------------

// `includeLegacy` segue a MESMA política já usada pela Central de Vendas
// (centralVendasService.js:990-1004, replicada 3x lá): um import legado
// (cliente_conta_id IS NULL) só pode ser lido como fallback da conta
// resolvida quando essa conta é COMPROVADAMENTE a única ativa do cliente no
// marketplace. Com 2+ contas ativas, o legado é ambíguo — pode pertencer a
// QUALQUER uma delas — e nunca pode ser atribuído silenciosamente à conta
// selecionada (isso reabriria a mistura de contas que condicaoContaSql foi
// desenhada para impedir). Sem conta resolvida (cliente 100% legado, 0
// contas ativas), a pergunta não se aplica: condicaoContaSql cai direto em
// `cliente_conta_id IS NULL` incondicional, então `includeLegacy` é
// irrelevante e o padrão seguro é `true`.
async function resolverIncludeLegacy({ clienteId, contaId }, deps = {}) {
  if (!contaId) return true;
  const total = await (deps.contarContasAtivas || contarContasMeliAtivas)(clienteId);
  return total <= 1;
}

/**
 * Diagnóstico barato (nenhuma chamada de item ao ML). É o que a Central deve
 * consultar primeiro para explicar uma tela vazia em vez de mostrar zero.
 */
async function obterContextoMargem({ clienteSlug, dateFrom, dateTo }, deps = {}) {
  const db = deps.db;
  const periodo = resolverPeriodo({ dateFrom, dateTo });
  const contexto = await (deps.resolverContexto || resolverContextoPrecificacao)({
    clienteSlugRaw: clienteSlug,
  });

  // `contexto.conta` pode vir preenchida mesmo sem clienteContaId explícito
  // (resolveMarketplaceAccountContext auto-resolve quando o cliente tem
  // exatamente 1 conta ML ativa). Sem repassar esse id aqui, a leitura da
  // Central de Vendas cai em cliente_conta_id IS NULL e o diagnóstico reporta
  // MELI_ORDER indisponível mesmo com import válido da conta (ver
  // prepareWorkspaceContext, mesma causa).
  const clienteContaIdDiagnostico = contexto.conta?.id ?? null;
  const includeLegacyDiagnostico = await resolverIncludeLegacy(
    { clienteId: contexto.cliente.id, contaId: clienteContaIdDiagnostico },
    deps
  );
  let vendas = { sincronizado: false, pedidos: [], itens: [], componentes: [], imports: [] };
  try {
    vendas = await (deps.carregarVendas || centralVendas.carregarVendasDoPeriodo)(
      {
        clienteSlug,
        dateFrom: periodo.dateFrom,
        dateTo: periodo.dateTo,
        marketplace: MARKETPLACE,
        clienteContaId: clienteContaIdDiagnostico,
        includeLegacy: includeLegacyDiagnostico,
      },
      db
    );
  } catch (err) {
    // Central de Vendas indisponível não pode derrubar o diagnóstico: o Motor
    // reporta a fonte como indisponível e segue.
    vendas = { sincronizado: false, pedidos: [], itens: [], componentes: [], imports: [], erro: err.message };
  }

  let custosTotal = 0;
  if (contexto.base) {
    const custos = await (deps.carregarCustos || baseCustos.carregarCustosDaBase)(
      { baseId: contexto.base.id },
      db
    );
    custosTotal = custos.total;
  }

  return {
    ok: true,
    cliente: contexto.cliente,
    periodo,
    marketplace: MARKETPLACE,
    pronto: contexto.pronto,
    motivo: contexto.motivo,
    mensagem: contexto.mensagem,
    fontes: {
      MELI_API: {
        disponivel: contexto.grant.conectado,
        detalhe: contexto.grant.conectado
          ? `grant ML conectado (ml_user_id ${contexto.grant.ml_user_id})`
          : "cliente sem conta ML conectada",
      },
      VENFORCE_BASE: {
        disponivel: Boolean(contexto.base) && custosTotal > 0,
        detalhe: contexto.base
          ? `base "${contexto.base.slug}" vinculada · ${custosTotal} item(ns) com custo`
          : "nenhuma base MELI vinculada ao cliente",
        baseSlug: contexto.base?.slug || null,
        totalCustos: custosTotal,
      },
      MELI_ORDER: {
        disponivel: vendas.sincronizado && vendas.pedidos.length > 0,
        detalhe: vendas.sincronizado
          ? `${vendas.pedidos.length} pedido(s) sincronizado(s) no período pela Central de Vendas`
          : "nenhuma sincronização da Central de Vendas neste período",
        importes: vendas.imports?.length || 0,
      },
      MERCADO_PAGO: {
        disponivel: settlement.mercadoPagoDisponivel(),
        detalhe: settlement.MENSAGENS[settlement.MOTIVOS.NAO_INTEGRADO],
      },
      EXTENSION_DOM: {
        disponivel: false,
        detalhe:
          "a extensão só consome a base de custos; não há rota que receba observações do DOM.",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Preparação do contexto do workspace — UMA VEZ por requisição
// ---------------------------------------------------------------------------
//
// O contexto cliente/grant/Base, a Base financeira completa, a Central de
// Vendas do período e a agregação por MLB NÃO dependem de qual página/lote de
// anúncios está sendo enriquecida — só dependem de cliente + base + período.
// Antes, `montarItens` resolvia tudo isso a cada chamada, e `carregarWorkspace`
// chamava `montarItens` uma vez por lote de <=20 anúncios: um workspace de 87
// itens em 5 lotes lia a Base 5 vezes, a Central de Vendas 5 vezes etc.
//
// `prepareWorkspaceContext` isola exatamente essa parte (1 leitura, sempre).
// `enrichBatch` consome o contexto já pronto e faz só o que É por lote: buscar
// os IDs do catálogo (respeitando o teto de 20 do multiget do ML) e os
// detalhes desses itens. `montarItens` continua existindo com o MESMO
// contrato de sempre (usado por `listarItens`/`obterItem`, que são
// naturalmente de 1 lote só); `carregarWorkspace` passa a preparar uma vez e
// enriquecer N lotes sobre o mesmo contexto.
async function prepareWorkspaceContext({ clienteSlug, baseSlug, dateFrom, dateTo, clienteContaId = null }, deps = {}) {
  const db = deps.db;
  const now = deps.now || new Date();
  const periodo = resolverPeriodo({ dateFrom, dateTo, now });

  // clienteContaId: opcional, default null — preserva o comportamento de
  // sempre (resolução "automática" da conta) para todo chamador existente
  // (Central de Margem). Passar explicitamente é o que permite a um
  // consumidor multi-conta (Anúncios ML) calcular a margem da MESMA conta
  // que está selecionada na tela, em vez da conta "automática" do cliente.
  const { cliente, base, mlUserId, conta } = await (deps.exigirContexto || exigirContextoPronto)({
    clienteSlugRaw: clienteSlug,
    baseSlugRaw: baseSlug,
    clienteContaId,
  });

  const custos = await (deps.carregarCustos || baseCustos.carregarCustosDaBase)(
    { baseId: base.id },
    db
  );

  // `conta` é a resolução REAL feita por exigirContextoPronto — pode ser a
  // MESMA conta recebida em `clienteContaId`, ou uma conta AUTO-RESOLVIDA
  // quando `clienteContaId` chega null e o cliente tem exatamente 1 conta ML
  // ativa (resolveMarketplaceAccountContext, D-8). Usar o `clienteContaId` de
  // entrada aqui (em vez do id resolvido) reabre o bug real: cliente com 1
  // conta ativa resolve catálogo/grant/base para ela, mas a leitura de vendas
  // cai sempre em cliente_conta_id IS NULL porque o parâmetro de entrada
  // nunca chegou preenchido — o import da conta nunca é encontrado (ver
  // centralVendasEvidenceAdapter.carregarVendasDoPeriodo).
  // includeLegacy: calculado por resolverIncludeLegacy — decisão da
  // auditoria "Investigação backend — faturamento Anúncios ML retornando
  // null": prioriza o import da conta atual, aceita fallback para import
  // legado (cliente_conta_id NULL, dado anterior à fundação multi-conta)
  // SOMENTE quando a conta resolvida é a única ativa do cliente (mesma
  // política de centralVendasService.js — nunca fixo em true, senão um
  // legado ambíguo seria atribuído à conta escolhida num cliente
  // multi-conta). Nunca lê o import de outra conta (garantido por
  // condicaoContaSql, que nunca soma OR de outro id, independente disto).
  const clienteContaIdResolvido = conta?.id ?? clienteContaId;
  const includeLegacyResolvido = await resolverIncludeLegacy(
    { clienteId: cliente.id, contaId: clienteContaIdResolvido },
    deps
  );
  const vendasRaw = await (deps.carregarVendas || centralVendas.carregarVendasDoPeriodo)(
    { clienteSlug: cliente.slug, dateFrom: periodo.dateFrom, dateTo: periodo.dateTo, marketplace: MARKETPLACE, clienteContaId: clienteContaIdResolvido, includeLegacy: includeLegacyResolvido },
    db
  );

  const agregado = (deps.agregarPorMlb || centralVendas.agregarPorMlb)({
    pedidosTodos: vendasRaw.pedidosTodos || vendasRaw.pedidos,
    pedidosResultado: vendasRaw.pedidos,
    itens: vendasRaw.itens,
    componentes: vendasRaw.componentes,
  });

  return {
    now,
    cliente,
    base,
    mlUserId,
    // Conta MELI efetivamente resolvida por `exigirContextoPronto` (via
    // resolveMarketplaceAccountContext) — `null` só no modo legado (cliente
    // sem nenhuma cliente_contas cadastrada). Propagada tal-e-qual, nunca
    // re-resolvida: é o mesmo objeto que decidiu `mlUserId`/`base` acima.
    conta: conta || null,
    periodo,
    custos,
    vendasRaw,
    porMlb: agregado.porMlb,
    reembolsoPorMlb: agregado.reembolsoPorMlb,
    naoAtribuido: agregado.naoAtribuido,
    reembolsos: agregado.reembolsos,
    // Timestamp do snapshot (prioridade 3 do §Timestamp): só usado quando um
    // agregado não tem `ultimaVendaEm` seguro. Nunca é `new Date()`.
    fallbackObservedAt: vendasRaw.importSnapshotAt || null,
  };
}

// ---------------------------------------------------------------------------
// Enriquecimento de UM lote (<=20 anúncios) sobre o contexto já preparado
// ---------------------------------------------------------------------------
async function enrichBatch(prepared, { offset, limit, targetMargin, itemIds }, deps = {}) {
  const { cliente, base, mlUserId, custos, porMlb, reembolsoPorMlb, fallbackObservedAt, now } = prepared;

  // Lista de anúncios: ou os IDs pedidos explicitamente (detalhe de item), ou
  // uma página dos ativos + pausados do vendedor (ver buscarItensAtivos).
  let ids;
  let totalItensMl;
  if (Array.isArray(itemIds) && itemIds.length) {
    ids = itemIds.slice(0, PAGE_LIMIT_MAX);
    totalItensMl = ids.length;
  } else {
    const busca = await (deps.buscarItensAtivos || meliApi.buscarItensAtivos)({
      clienteId: cliente.id,
      mlUserId,
      offset,
      limit,
    });
    ids = busca.ids;
    totalItensMl = busca.total;
  }

  const bodies = await (deps.buscarDetalhesItens || meliApi.buscarDetalhesItens)({
    clienteId: cliente.id,
    ids,
  });

  const aplicarProjetadas = deps.aplicarEvidenciasProjetadas || meliApi.aplicarEvidenciasProjetadas;

  const itens = await mapWithConcurrency(bodies, CONCURRENCY, async (body) => {
    const bag = createEvidenceBag();

    // 1) Estado atual do anúncio (MELI_API).
    const observado = await aplicarProjetadas(bag, { clienteId: cliente.id, body, observedAt: now, mlUserId }, deps);

    // 2) Custo/imposto/taxa fixa declarados na Base ATUAL (VENFORCE_BASE,
    // PROJETADO). O realizado histórico vem do passo 3, nunca daqui.
    const temCusto = baseCustos.aplicarEvidenciasDeCusto(bag, {
      itemId: observado.itemId,
      index: custos.index,
      baseSlug: base.slug,
    });

    // 3) O que a venda entregou (MELI_ORDER/VENFORCE_BASE histórico, via
    // Central de Vendas). Preço/comissão/frete/custo/imposto realizados nunca
    // caem para o estado atual — ausente fica ausente (ver marginItem.js).
    const agregado = porMlb.get(observado.itemId) || null;
    const realizado = centralVendas.aplicarEvidenciasRealizadas(bag, { agregado, fallbackObservedAt });

    // 3b) Reembolso — independente de o MLB ter venda computável no período
    // (um pedido cancelado e reembolsado não passa pelo `agregado` acima).
    const reembolso = reembolsoPorMlb.get(observado.itemId) || null;
    const reembolsoInfo = centralVendas.aplicarEvidenciaReembolso(bag, { reembolso, fallbackObservedAt });

    // 4) Extensão: sem canal de ingestão hoje (registra nada, mantém o motivo).
    extensao.aplicarEvidenciasDom(bag, extensao.coletar());

    // 5) Conciliação financeira (MERCADO_PAGO — indisponível).
    const conciliacao = settlement.avaliarConciliacao({ hasOrders: Boolean(realizado) });

    const item = buildMarginItem({
      identity: {
        clienteSlug: cliente.slug,
        marketplace: MARKETPLACE,
        itemId: observado.itemId,
        sku: observado.sku || agregado?.sku || null,
        titulo: observado.titulo || agregado?.titulo || null,
        // Metadado de apresentação, não evidência financeira: vem do MESMO
        // body de /items?ids= já buscado — zero chamada nova ao ML.
        image: observado.image || null,
      },
      bag,
      sales: {
        hasOrders: Boolean(realizado),
        unidades: realizado?.unidades ?? null,
        pedidos: realizado?.pedidos ?? null,
        receita: realizado?.receita ?? null,
        ultimaVendaEm: realizado?.ultimaVendaEm ?? null,
        resultadoPersistido: realizado?.resultadoPersistido ?? null,
        cobertura: realizado?.cobertura ?? null,
      },
      settlement: { available: conciliacao.available, motivo: conciliacao.motivo },
      targetMargin,
      now,
    });

    // Anexos de diagnóstico — não fazem parte do cálculo, ajudam a Central a
    // explicar o item sem uma segunda chamada.
    item.diagnostico = {
      temCustoNaBase: temCusto,
      baseSlug: base.slug,
      listingTypeId: observado.listingTypeId,
      logisticType: observado.logisticType,
      statusAnuncio: observado.status,
      faltantesMeliApi: observado.faltantes,
      conciliacao: { ...conciliacao },
      realizado: realizado || null,
      reembolso: reembolsoInfo || null,
    };

    return item;
  });

  return { totalItensMl, itens };
}

// ---------------------------------------------------------------------------
// Montagem dos itens — 1 lote, contexto preparado inline (compat)
// ---------------------------------------------------------------------------

async function montarItens(
  { clienteSlug, baseSlug, dateFrom, dateTo, offset, limit, targetMargin, itemIds, clienteContaId = null },
  deps = {}
) {
  const prepared = await (deps.prepareWorkspaceContext || prepareWorkspaceContext)(
    { clienteSlug, baseSlug, dateFrom, dateTo, clienteContaId },
    deps
  );
  const { totalItensMl, itens } = await (deps.enrichBatch || enrichBatch)(
    prepared,
    { offset, limit, targetMargin, itemIds },
    deps
  );

  return {
    cliente: prepared.cliente,
    base: prepared.base,
    periodo: prepared.periodo,
    totalItensMl,
    itens,
    // Agregado do PERÍODO INTEIRO por MLB (não só o lote de `itemIds`) — já
    // montado por `prepareWorkspaceContext` para o cálculo de margem, e
    // reaproveitado por Anúncios ML para % faturamento/Curva ABC (que
    // precisam da receita de TODOS os anúncios do período, não só da página
    // pedida). Ver server/controllers/meliAnunciosController.js (performance).
    porMlb: prepared.porMlb,
    vendas: {
      sincronizado: prepared.vendasRaw.sincronizado,
      pedidosNoPeriodo: prepared.vendasRaw.pedidos.length,
      anunciosComVenda: prepared.porMlb.size,
      reembolsoNaoAtribuido: prepared.naoAtribuido.reembolso,
    },
  };
}

// ---------------------------------------------------------------------------
// Filtros / ordenação
// ---------------------------------------------------------------------------

const ORDENACOES = {
  margem_asc: (a, b) => valorOrdenacao(a) - valorOrdenacao(b),
  margem_desc: (a, b) => valorOrdenacao(b) - valorOrdenacao(a),
  titulo_asc: (a, b) => String(a.identity.titulo || "").localeCompare(String(b.identity.titulo || ""), "pt-BR"),
};

// Item sem margem vai para o fim de qualquer ordenação por margem: "não sei"
// não pode competir com "-5%".
function valorOrdenacao(item) {
  const displayed = item.margin.realized.computable ? item.margin.realized : item.margin.projected;
  return displayed.margin === null ? Number.POSITIVE_INFINITY : displayed.margin;
}

function aplicarFiltros(itens, { status, confianca, busca, comDivergencia, semCusto }) {
  let out = itens;

  if (status) {
    const alvos = new Set(String(status).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
    out = out.filter((item) => alvos.has(item.quality.status));
  }
  if (confianca) {
    const alvos = new Set(String(confianca).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
    out = out.filter((item) => alvos.has(item.quality.confidence));
  }
  if (comDivergencia === true) {
    out = out.filter((item) => item.quality.divergences.length > 0);
  }
  if (semCusto === true) {
    out = out.filter((item) => !item.costs.cost.value && item.costs.cost.status !== "available");
  }
  if (busca) {
    const termo = String(busca).trim().toLowerCase();
    out = out.filter(
      (item) =>
        String(item.identity.itemId || "").toLowerCase().includes(termo) ||
        String(item.identity.sku || "").toLowerCase().includes(termo) ||
        String(item.identity.titulo || "").toLowerCase().includes(termo)
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Endpoints de serviço
// ---------------------------------------------------------------------------

/** Lista paginada de itens de margem. */
async function listarItens(params = {}, deps = {}) {
  const page = Math.max(1, parseInt(params.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(params.limit, 10) || PAGE_LIMIT_DEFAULT), PAGE_LIMIT_MAX);
  const targetMargin = parseTargetMargin(params.margemAlvo);

  const montado = await montarItens(
    {
      clienteSlug: params.clienteSlug,
      baseSlug: params.baseSlug,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      offset: (page - 1) * limit,
      limit,
      targetMargin,
    },
    deps
  );

  const filtrados = aplicarFiltros(montado.itens, {
    status: params.status,
    confianca: params.confianca,
    busca: params.busca,
    comDivergencia: params.comDivergencia === true || params.comDivergencia === "true",
    semCusto: params.semCusto === true || params.semCusto === "true",
  });

  const ordenacao = ORDENACOES[params.ordenacao] || ORDENACOES.margem_asc;
  const itens = filtrados.slice().sort(ordenacao);

  return {
    ok: true,
    cliente: montado.cliente,
    base: { id: montado.base.id, slug: montado.base.slug, nome: montado.base.nome },
    periodo: montado.periodo,
    margemAlvo: targetMargin,
    paginacao: {
      page,
      limit,
      totalItensMl: montado.totalItensMl,
      // A paginação é do Mercado Livre; os filtros são aplicados DEPOIS, sobre
      // a página carregada. `itensNaPagina` é o que sobrou do filtro.
      itensNaPagina: itens.length,
      itensCarregados: montado.itens.length,
      filtroAplicadoNaPagina: filtrados.length !== montado.itens.length,
    },
    vendas: montado.vendas,
    itens,
  };
}

// ---------------------------------------------------------------------------
// Camada de compatibilidade com o frontend da Central
// ---------------------------------------------------------------------------

/**
 * Acrescenta ao item um punhado de ALIASES achatados.
 *
 * Motivo: `Portal/central-margem-api.js` (frontend da Central, construído em
 * paralelo) sonda `GET /operacao/central-margem/:slug` e lê o item por chaves
 * planas — `itemId`, `title`, `status`, `confidence`, `projected/realized`,
 * `fields`, `divergences` — caindo num adapter legado quando recebe 404.
 *
 * O contrato canônico (identity/pricing/costs/margin/quality) NÃO muda: os
 * aliases são acrescentados por cima, apontando para os mesmos valores. Se o
 * frontend mudar de ideia, basta apagar esta função — nada mais depende dela.
 */
function comAliasesDeCompatibilidade(item) {
  return {
    ...item,
    itemId: item.identity.itemId,
    sku: item.identity.sku,
    title: item.identity.titulo,
    titulo: item.identity.titulo,
    image: item.identity.image,
    marketplace: item.identity.marketplace,
    status: item.quality.status,
    confidence: item.quality.confidence,
    confianca: item.quality.confidence,
    problema: item.quality.statusReasons[0] || null,
    targetMargin: item.margin.target.marginTarget,
    projected: {
      margin: item.margin.projected.margin,
      profit: item.margin.projected.profit,
      // `estimated` = alguma variável entrou no cálculo assumida como 0.
      estimated: item.margin.projected.strict === false,
      note: item.margin.projected.assumed.length
        ? `Assumido 0 para: ${item.margin.projected.assumed.join(", ")}.`
        : null,
    },
    realized: {
      margin: item.margin.realized.margin,
      profit: item.margin.realized.profit,
      pending: item.margin.realized.computable === false,
    },
    divergences: item.quality.divergences,
    conciliacao: item.settlement.available ? "Disponível" : "Pendente",
  };
}

/**
 * Payload RAIZ da Central de Margem: resumo + lista na mesma resposta.
 * É a rota que o frontend chama primeiro. Read-only, como todas.
 */
async function obterCentralMargem(params = {}, deps = {}) {
  const lista = await listarItens(params, deps);
  const contagemPorStatus = {};
  for (const key of Object.keys(STATUS)) contagemPorStatus[key] = 0;
  for (const item of lista.itens) {
    contagemPorStatus[item.quality.status] = (contagemPorStatus[item.quality.status] || 0) + 1;
  }

  return {
    ...lista,
    itens: lista.itens.map(comAliasesDeCompatibilidade),
    // A lista é uma PÁGINA do catálogo do ML: o resumo abaixo descreve a página,
    // não o catálogo inteiro. O total do catálogo fica em paginacao.totalItensMl
    // e o placar completo (amostrado) vive em /resumo.
    parcial: lista.paginacao.itensCarregados < lista.paginacao.totalItensMl,
    resumo: {
      escopo: "pagina",
      porStatus: contagemPorStatus,
      itensNaPagina: lista.paginacao.itensNaPagina,
      totalItensMl: lista.paginacao.totalItensMl,
      itensComDivergencia: lista.itens.filter((i) => i.quality.divergences.length > 0).length,
    },
  };
}

/** Detalhe de um item — mesma montagem, escopo de 1 anúncio. */
async function obterItem(params = {}, deps = {}) {
  const itemId = String(params.itemId || "").trim().toUpperCase();
  if (!itemId) throw criarErroHttp(400, { ok: false, erro: "itemId é obrigatório." });

  const targetMargin = parseTargetMargin(params.margemAlvo);
  const montado = await montarItens(
    {
      clienteSlug: params.clienteSlug,
      baseSlug: params.baseSlug,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      offset: 0,
      limit: 1,
      targetMargin,
      itemIds: [itemId],
    },
    deps
  );

  const item = montado.itens[0];
  if (!item) {
    throw criarErroHttp(404, {
      ok: false,
      erro: "Anúncio não encontrado no Mercado Livre para este cliente.",
      codigo: "ITEM_NAO_ENCONTRADO",
    });
  }

  return {
    ok: true,
    cliente: montado.cliente,
    base: { id: montado.base.id, slug: montado.base.slug, nome: montado.base.nome },
    periodo: montado.periodo,
    margemAlvo: targetMargin,
    item,
  };
}

function resumoVazio() {
  const porStatus = {};
  for (const key of Object.keys(STATUS)) porStatus[key] = 0;
  const porConfianca = {};
  for (const key of Object.keys(LEVELS)) porConfianca[key] = 0;
  return { porStatus, porConfianca };
}

/**
 * WORKSPACE — varredura em batches do catálogo, reaproveitada por `obterResumo`
 * e `obterWorkspace`. Cada lote respeita PAGE_LIMIT_MAX (teto do multiget
 * `/items?ids=`); esta função só decide QUANTOS lotes encadear, nunca aumenta
 * o tamanho de um único lote.
 *
 * `offset 0, 20, 40…` até terminar o catálogo (`totalItensMl`) ou atingir
 * `maxItens` — o teto seguro de chamadas ao Mercado Livre nesta leitura.
 *
 * Contexto/Base/Central de Vendas/agregação são resolvidos UMA VEZ aqui via
 * `prepareWorkspaceContext`, ANTES do loop — não a cada lote. Cada lote só
 * chama `enrichBatch`, que reaproveita esse contexto e faz apenas o que
 * depende do lote: buscar os IDs da página e os detalhes desses itens.
 *
 * `clienteContaId` (opcional, default `null`): mesmo contrato de
 * `prepareWorkspaceContext` (linha 183) — antes desta correção, esta função
 * não o repassava, então um consumidor multi-conta (ex.: futuro job de
 * margem projetada, ver FASE 2 de
 * docs/AUDITORIA_ANUNCIOS_ML_MARGEM_PROJETADA_FASE2_JOB_MANUAL.md) não tinha
 * como pedir o workspace de UMA conta específica — `resolveMarketplaceAccountContext`
 * reabria a resolução "automática", que rejeita com 409
 * MULTIPLE_MARKETPLACE_ACCOUNTS qualquer cliente com 2+ contas ativas. Sem
 * `clienteContaId` informado o comportamento é idêntico a antes (resolução
 * automática, inalterada).
 */
async function carregarWorkspace(
  { clienteSlug, baseSlug, dateFrom, dateTo, targetMargin, maxItens, clienteContaId = null },
  deps = {}
) {
  const prepared = await (deps.prepareWorkspaceContext || prepareWorkspaceContext)(
    { clienteSlug, baseSlug, dateFrom, dateTo, clienteContaId },
    deps
  );
  const enrich = deps.enrichBatch || enrichBatch;

  const itens = [];
  let totalItensMl = 0;

  for (let offset = 0; offset < maxItens; offset += PAGE_LIMIT_MAX) {
    const limit = Math.min(PAGE_LIMIT_MAX, maxItens - offset);
    const resultado = await enrich(prepared, { offset, limit, targetMargin }, deps);

    totalItensMl = resultado.totalItensMl;
    itens.push(...resultado.itens);

    if (resultado.itens.length === 0 || offset + limit >= totalItensMl) break;
  }

  return {
    cliente: prepared.cliente,
    // Conta efetivamente USADA pelo Motor (auto-resolvida ou a pedida via
    // clienteContaId, tanto faz) — nunca o valor "pedido" no argv de um
    // chamador; vem pronta de `prepared.conta`, sem segunda resolução. `null`
    // só no modo legado (cliente sem cliente_contas cadastrada).
    clienteContaId: prepared.conta ? prepared.conta.id : null,
    base: prepared.base,
    periodo: prepared.periodo,
    vendas: {
      sincronizado: prepared.vendasRaw.sincronizado,
      pedidosNoPeriodo: prepared.vendasRaw.pedidos.length,
      anunciosComVenda: prepared.porMlb.size,
      reembolsoNaoAtribuido: prepared.naoAtribuido.reembolso,
    },
    totalItensMl,
    itens,
  };
}

/**
 * Resumo/placar do período.
 *
 * ⚠️ COBERTURA PARCIAL POR DESENHO: varre no máximo `maxItens` anúncios (padrão
 * 60). Cada anúncio custa 2 chamadas extras ao Mercado Livre (listing_prices +
 * shipping); varrer um catálogo inteiro estouraria o rate limit. O retorno
 * declara quantos foram analisados de quantos existem — a Central deve exibir
 * "amostra de X de Y", nunca apresentar isso como total do catálogo.
 */
async function obterResumo(params = {}, deps = {}) {
  const targetMargin = parseTargetMargin(params.margemAlvo);
  const maxItens = Math.min(
    Math.max(1, parseInt(params.maxItens, 10) || RESUMO_MAX_ITENS_DEFAULT),
    RESUMO_MAX_ITENS_TETO
  );

  const acumulado = resumoVazio();
  const workspace = await carregarWorkspace(
    {
      clienteSlug: params.clienteSlug,
      clienteContaId: params.clienteContaId ?? null,
      baseSlug: params.baseSlug,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      targetMargin,
      maxItens,
    },
    deps
  );
  const { cliente, base, periodo, vendas, totalItensMl, itens: itensAnalisados } = workspace;

  for (const item of itensAnalisados) {
    acumulado.porStatus[item.quality.status] = (acumulado.porStatus[item.quality.status] || 0) + 1;
    acumulado.porConfianca[item.quality.confidence] =
      (acumulado.porConfianca[item.quality.confidence] || 0) + 1;
  }

  const comMargem = itensAnalisados
    .map((item) => (item.margin.realized.computable ? item.margin.realized : item.margin.projected))
    .filter((m) => m.margin !== null);
  const margemMedia =
    comMargem.length > 0
      ? Math.round((comMargem.reduce((s, m) => s + m.margin, 0) / comMargem.length) * 1e6) / 1e6
      : null;

  const comErro = itensAnalisados.filter((item) => item.margin.projectionError.comparable);
  const erroProjecaoMedioPp =
    comErro.length > 0
      ? Math.round(
          (comErro.reduce((s, item) => s + item.margin.projectionError.deltaPp, 0) / comErro.length) * 100
        ) / 100
      : null;

  return {
    ok: true,
    cliente,
    base: base ? { id: base.id, slug: base.slug, nome: base.nome } : null,
    periodo,
    margemAlvo: targetMargin,
    cobertura: {
      itensAnalisados: itensAnalisados.length,
      totalItensMl,
      maxItens,
      parcial: itensAnalisados.length < totalItensMl,
      motivoParcial:
        itensAnalisados.length < totalItensMl
          ? "Amostra limitada pelo teto de chamadas ao Mercado Livre (parâmetro maxItens)."
          : null,
    },
    vendas,
    placar: {
      ...acumulado,
      margemMedia,
      margemMediaPercent: margemMedia === null ? null : Math.round(margemMedia * 10000) / 100,
      itensComMargem: comMargem.length,
      itensSemMargem: itensAnalisados.length - comMargem.length,
      erroProjecaoMedioPp,
      itensComDivergencia: itensAnalisados.filter((item) => item.quality.divergences.length > 0).length,
    },
    // Fila de exceções: o que precisa de ação, do mais urgente para o menos.
    excecoes: itensAnalisados
      .filter((item) => item.quality.status !== STATUS.HEALTHY)
      .sort((a, b) => valorOrdenacao(a) - valorOrdenacao(b))
      .slice(0, 20)
      .map((item) => ({
        itemId: item.identity.itemId,
        titulo: item.identity.titulo,
        status: item.quality.status,
        statusLabel: item.quality.statusLabel,
        confidence: item.quality.confidence,
        margemProjetadaPercent: item.margin.projected.marginPercent,
        margemRealizadaPercent: item.margin.realized.marginPercent,
        problemaPrincipal: item.quality.statusReasons[0] || null,
      })),
  };
}

/**
 * WORKSPACE da Central — uma única varredura que alimenta planilha, filtros,
 * KPIs e fila de divergências no frontend. Substitui o padrão antigo de
 * "20 itens → filtra a página": aqui filtro/busca/paginação visual acontecem
 * no cliente, sobre TODOS os itens deste workspace.
 *
 * Reaproveita `carregarWorkspace` (mesmo helper de `obterResumo`) e devolve
 * o catálogo carregado com os aliases de compatibilidade do frontend + a
 * cobertura explícita: quantos foram carregados de quantos existem no
 * catálogo do Mercado Livre. `maxItens` continua limitado por
 * RESUMO_MAX_ITENS_TETO nesta fase — catálogos maiores declaram cobertura
 * parcial em vez de fingir que carregaram tudo (ver proposta de Fase 2 no
 * relatório de entrega para snapshot/atualização progressiva).
 */
async function obterWorkspace(params = {}, deps = {}) {
  const targetMargin = parseTargetMargin(params.margemAlvo);
  const maxItens = Math.min(
    Math.max(1, parseInt(params.maxItens, 10) || RESUMO_MAX_ITENS_TETO),
    RESUMO_MAX_ITENS_TETO
  );

  const workspace = await carregarWorkspace(
    {
      clienteSlug: params.clienteSlug,
      baseSlug: params.baseSlug,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      targetMargin,
      maxItens,
    },
    deps
  );

  const itens = workspace.itens.map(comAliasesDeCompatibilidade);
  const contagemPorStatus = {};
  for (const key of Object.keys(STATUS)) contagemPorStatus[key] = 0;
  for (const item of itens) {
    contagemPorStatus[item.status] = (contagemPorStatus[item.status] || 0) + 1;
  }
  const parcial = itens.length < workspace.totalItensMl;

  return {
    ok: true,
    cliente: workspace.cliente,
    base: workspace.base ? { id: workspace.base.id, slug: workspace.base.slug, nome: workspace.base.nome } : null,
    periodo: workspace.periodo,
    margemAlvo: targetMargin,
    parcial,
    // Cobertura: o que a UI precisa para nunca apresentar uma amostra como
    // se fosse o catálogo inteiro (ver seção "Cobertura" do pedido).
    cobertura: {
      carregados: itens.length,
      totalItensMl: workspace.totalItensMl,
      maxItens,
      parcial,
      motivoParcial: parcial
        ? "Catálogo maior que o teto seguro desta leitura (parâmetro maxItens)."
        : null,
    },
    vendas: workspace.vendas,
    resumo: {
      escopo: "workspace",
      porStatus: contagemPorStatus,
      itensCarregados: itens.length,
      totalItensMl: workspace.totalItensMl,
      itensComDivergencia: itens.filter((i) => i.divergences.length > 0).length,
    },
    itens,
  };
}

module.exports = {
  MARKETPLACE,
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  RESUMO_MAX_ITENS_DEFAULT,
  RESUMO_MAX_ITENS_TETO,
  obterContextoMargem,
  obterCentralMargem,
  listarItens,
  obterItem,
  obterResumo,
  obterWorkspace,
  comAliasesDeCompatibilidade,
  prepareWorkspaceContext,
  enrichBatch,
  montarItens,
  carregarWorkspace,
  aplicarFiltros,
  resolverPeriodo,
  // Exportado para a leitura por snapshot (marginSnapshotReadService) seguir
  // a MESMA política de import legado da leitura ao vivo — nunca uma cópia.
  resolverIncludeLegacy,
  parseTargetMargin,
  mapWithConcurrency,
  criarErroHttp,
  FIELDS,
};
