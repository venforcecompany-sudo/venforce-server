// server/services/motorMargem/marginSnapshotReadService.js
// Margin Snapshot — leitura da Central de Margem pelo snapshot (M5).
//
//   GET .../snapshot/resumo  → estado da leitura da conta (missing/ready),
//                              run ativo/último run, contagens
//   GET .../snapshot/itens   → página de itens: PROJETADA do snapshot +
//                              REALIZADA da Central de Vendas no período
//
// Regras (não negociáveis):
//   - Nenhuma chamada ao Mercado Livre e nenhum recálculo da projetada: os
//     números projetados saem da linha persistida pelo worker. Este módulo
//     não importa mlClient, meliApiEvidenceAdapter nem enrichBatch.
//   - A REALIZADA continua vindo da Central de Vendas (mesmo adapter e mesma
//     política de import legado do Motor ao vivo) e é calculada pelo MESMO
//     núcleo (resolveField + valueForKind + computeMargin), só para a página.
//   - Sempre por conta explícita, validada contra o cliente.
//   - Conta sem snapshot NUNCA vira "0 itens": estado `missing` + ação.
//
// Feature flag (rollout): MARGIN_SNAPSHOT_READ_ENABLED=true liga para todos;
// MARGIN_SNAPSHOT_READ_CLIENTES=slug-a,slug-b liga só para esses clientes.
// Desligada, a tela usa o caminho legado (/workspace ao vivo) e as rotas de
// leitura por snapshot respondem que o modo está desabilitado.

const pool = require("../../config/database");
const snapshotRepository = require("./marginSnapshotRepository");
const runRepository = require("./marginSnapshotRunRepository");
const api = require("./marginSnapshotApiService");
const core = require("./core");
const margemConfiavel = require("./margemConfiavel");
const centralVendas = require("./adapters/centralVendasEvidenceAdapter");
const settlement = require("./adapters/settlementEvidenceAdapter");
const { flagLigada } = require("./marginSnapshotConfig");
const { redigirSegredos } = require("./marginSnapshotSanitize");
const { logEvento } = require("./marginSnapshotLog");
const { carregarRebatesDaConta, carregarRebatesAtivos, calcularStatusOverrides, margemAtualComRebate, reclassificarStatus } = require("./margemAtualRebate");
const { STATUS: STATUS_PRECO } = require("./precoVigenteComposicao");
const { resumoDoFrete } = require("../shared/freteCotacaoConfiavel");
const periodoRealizado = require("./marginRealizadoPeriodo");
const { agregarKpisRealizados } = require("./marginRealizadoKpis");

const MARKETPLACE = "meli";
const LIMIT_PADRAO = 50;
const LIMIT_MAX = 200; // teto de UMA página da API (nunca o catálogo inteiro)

function leituraHabilitada({ clienteSlug } = {}, env = process.env) {
  if (flagLigada(env.MARGIN_SNAPSHOT_READ_ENABLED)) return true;
  const lista = String(env.MARGIN_SNAPSHOT_READ_CLIENTES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return Boolean(clienteSlug) && lista.includes(String(clienteSlug).trim().toLowerCase());
}

function erroDesabilitado() {
  return api.criarErroHttp(
    404,
    "Leitura da Central de Margem por snapshot desabilitada para este cliente.",
    "MARGIN_SNAPSHOT_READ_DISABLED"
  );
}

function paginacao({ page, limit }) {
  const limitNum = Math.min(Math.max(parseInt(limit, 10) || LIMIT_PADRAO, 1), LIMIT_MAX);
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  return { page: pageNum, limit: limitNum, offset: (pageNum - 1) * limitNum };
}

// ---------------------------------------------------------------------------
// Filtros e ordenação da lista (M6) — validados aqui, montados no builder do
// repository. Valor fora do enum/whitelist = 400 explícito, nunca ignorado
// em silêncio (um filtro ignorado mostraria "tudo" como se fosse o filtro).
// ---------------------------------------------------------------------------

const BUSCA_MAX = 100;

function listaDeEnum(raw, validos, { maiusculo = true, nome }) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const valores = String(raw).split(",").map((v) => v.trim()).filter(Boolean).map((v) => (maiusculo ? v.toUpperCase() : v.toLowerCase()));
  const invalidos = valores.filter((v) => !validos.includes(v));
  if (invalidos.length) {
    throw api.criarErroHttp(400, `Filtro "${nome}" inválido. Aceitos: ${validos.join(", ")}.`, "FILTRO_INVALIDO");
  }
  return Array.from(new Set(valores));
}

function lerFiltros(params = {}, repo = snapshotRepository) {
  const buscaBruta = params.busca ?? params.q ?? null;
  const busca = typeof buscaBruta === "string" ? buscaBruta.trim().slice(0, BUSCA_MAX) : null;
  return {
    status: listaDeEnum(params.status, repo.STATUS_VALIDOS, { nome: "status" }),
    refreshStatus: listaDeEnum(params.refreshStatus, repo.REFRESH_STATUS_VALIDOS, { maiusculo: false, nome: "refreshStatus" }),
    confianca: listaDeEnum(params.confianca, repo.CONFIANCA_VALIDOS, { nome: "confianca" }),
    statusAnuncio: listaDeEnum(params.statusAnuncio, repo.STATUS_ANUNCIO_VALIDOS, { maiusculo: false, nome: "statusAnuncio" }),
    busca: busca || null,
  };
}

function lerOrdenacao(params = {}, repo = snapshotRepository) {
  const ordem = repo.resolverOrdenacao({ ordenacao: params.ordenacao, direcao: params.direcao });
  if (!ordem) {
    throw api.criarErroHttp(
      400,
      "Ordenação inválida. Aceitas: margin_percent, profit, status, updated_at, calculated_at, titulo (ASC|DESC) e worklist (prejuízo → abaixo da meta → maior receita).",
      "ORDENACAO_INVALIDA"
    );
  }
  return ordem;
}

// ---------------------------------------------------------------------------
// Estado da leitura da conta
// ---------------------------------------------------------------------------

async function carregarEstado({ cliente, conta }, deps = {}) {
  const db = deps.db || pool;
  const repo = deps.snapshotRepository || snapshotRepository;
  const runs = deps.runRepository || runRepository;

  const filtro = repo.montarFiltroSnapshots({ clienteId: cliente.id, clienteContaId: conta.id, marketplace: MARKETPLACE });
  const [contagem, runAtivo, ultimoRun, ultimoCompleto] = await Promise.all([
    repo.countProjectionSnapshotsFiltrado({ filtro, db }),
    runs.findActiveRunForAccount({ clienteId: cliente.id, clienteContaId: conta.id, marketplace: MARKETPLACE, db }),
    runs.findLatestFinishedRunForAccount({ clienteId: cliente.id, clienteContaId: conta.id, marketplace: MARKETPLACE, db }),
    runs.findLatestCompletedRunForAccount({ clienteId: cliente.id, clienteContaId: conta.id, marketplace: MARKETPLACE, db }),
  ]);

  // `ready`: existe leitura persistida (linhas), OU um run já completou com
  // catálogo vazio (vazio de verdade, não "nunca calculado").
  const estado = contagem.total > 0 || ultimoCompleto ? "ready" : "missing";
  return { estado, contagem, runAtivo, ultimoRun, filtro };
}

function mensagemEstado(estado, runAtivo) {
  if (estado === "ready") return null;
  return runAtivo
    ? "A primeira leitura desta conta está sendo calculada. Os itens aparecem ao final da atualização."
    : "Esta conta ainda não tem leitura de margem calculada. Clique em \"Atualizar leitura\" para calcular.";
}

async function obterResumo({ clienteSlug, clienteContaId }, deps = {}) {
  const env = deps.env || process.env;
  if (!leituraHabilitada({ clienteSlug }, env)) {
    return { ok: true, habilitado: false, modo: "legacy" };
  }
  const db = deps.db || pool;
  const repo = deps.snapshotRepository || snapshotRepository;
  const { cliente, conta } = await api.resolverContaDoCliente({ clienteSlug, clienteContaId }, deps);
  const { estado, contagem, runAtivo, ultimoRun, filtro } = await carregarEstado({ cliente, conta }, deps);

  // KPIs: agregação no banco sobre a conta inteira (independe de página ou
  // filtro da lista). `missing` → null: nunca placar zerado fingindo leitura.
  let kpis = null;
  let foraDoCatalogo = null;
  if (estado === "ready") {
    const filtroFora = repo.montarFiltroSnapshots({
      clienteId: cliente.id, clienteContaId: conta.id, marketplace: MARKETPLACE, somenteForaDoCatalogo: true,
    });
    // Placar por status EFETIVO: o anúncio que o retorno ML tirou de "Prejuízo"
    // não conta como Prejuízo (mesma reclassificação dos itens da tabela).
    const efetivo = await statusEfetivoDaConta({ cliente, conta, deps, db });
    const filtroEfetivo = repo.montarFiltroSnapshots({
      clienteId: cliente.id, clienteContaId: conta.id, marketplace: MARKETPLACE, statusOverrides: efetivo.overrides,
    });
    const [agregado, fora] = await Promise.all([
      repo.summarizeProjectionSnapshots({ filtro: filtroEfetivo, db }),
      repo.countProjectionSnapshotsFiltrado({ filtro: filtroFora, db }),
    ]);
    const { ultimoCalculoEm, lcPrejuizo, ...placar } = agregado;
    kpis = {
      ...placar,
      // LC/un somado dos anúncios em Prejuízo, já com o retorno ML dos que seguem em prejuízo.
      lcPrejuizo: Math.round((lcPrejuizo + efetivo.overrides.rebateEmPrejuizo + Number.EPSILON) * 100) / 100,
      // Prejuízo/Margem baixa sobre preço promocional NÃO comprovado: contados
      // à parte (status efetivo "Dado suspeito"), nunca como resultado comprovado.
      limiteInferior: efetivo.overrides.limiteInferior || { total: 0, LOSS: 0, LOW_MARGIN: 0 },
    };
    foraDoCatalogo = fora.total;
  }

  return {
    ok: true,
    habilitado: true,
    modo: "snapshot",
    cliente,
    conta,
    marketplace: MARKETPLACE,
    estado,
    acao: estado === "missing" && !runAtivo ? "refresh" : null,
    mensagem: mensagemEstado(estado, runAtivo),
    snapshot: {
      totalItens: estado === "missing" ? null : contagem.total,
      ultimoCalculoEm: contagem.ultimoCalculoEm,
      foraDoCatalogo,
    },
    kpis,
    refresh: {
      runAtivo: api.runPublico(runAtivo),
      ultimoRun: api.runPublico(ultimoRun),
    },
  };
}

// ---------------------------------------------------------------------------
// Composição do item: projetada (snapshot) + realizada (Central de Vendas)
// ---------------------------------------------------------------------------

// Motivos pelos quais o realizado do período NÃO pode ser afirmado. Nos dois
// casos o contrato é `realizado: null` + `realizado_motivo`: receita, unidades,
// pedidos e lucro ficam null — "não sabemos" nunca vira "R$ 0 / 0 vendas".
const MOTIVO_REALIZADO = {
  CENTRAL_VENDAS_FALHOU: "CENTRAL_VENDAS_FALHOU",
  SEM_SINCRONIZACAO: "SEM_SINCRONIZACAO",
};

const MENSAGEM_REALIZADO = {
  CENTRAL_VENDAS_FALHOU:
    "A leitura de vendas da Central de Vendas falhou para este período. O realizado está indisponível — nenhum valor foi zerado.",
  SEM_SINCRONIZACAO:
    "Nenhuma sincronização de vendas cobre este período. O realizado está indisponível — não é zero.",
};

function realizadoIndisponivel(motivo) {
  return { motivo, mensagem: MENSAGEM_REALIZADO[motivo] };
}

async function carregarRealizadaDoPeriodo({ cliente, conta, dateFrom, dateTo, periodo = null }, deps = {}) {
  const db = deps.db || pool;
  // Lazy: motorMargemService carrega adapters do ML — só a política de
  // legado é usada aqui.
  const motor = require("./motorMargemService");
  // Período do REALIZADO: explícito, `periodo=YYYY-MM` (parâmetro global do
  // Shell) ou o padrão "últimos 30 dias até ontem" (marginRealizadoPeriodo).
  // Período inválido continua sendo erro do chamador (fora do try abaixo).
  const periodoResolvido = periodoRealizado.resolverPeriodoRealizado({ dateFrom, dateTo, periodo, now: deps.now || new Date() });

  let vendasRaw;
  let agregado;
  try {
    const includeLegacy = await motor.resolverIncludeLegacy({ clienteId: cliente.id, contaId: conta.id }, deps);
    vendasRaw = await (deps.carregarVendas || centralVendas.carregarVendasDoPeriodo)(
      {
        clienteSlug: cliente.slug,
        dateFrom: periodoResolvido.dateFrom,
        dateTo: periodoResolvido.dateTo,
        marketplace: MARKETPLACE,
        clienteContaId: conta.id,
        includeLegacy,
      },
      db
    );
    agregado = (deps.agregarPorMlb || centralVendas.agregarPorMlb)({
      pedidosTodos: vendasRaw.pedidosTodos || vendasRaw.pedidos,
      pedidosResultado: vendasRaw.pedidos,
      itens: vendasRaw.itens,
      componentes: vendasRaw.componentes,
    });
  } catch (err) {
    // A Central de Vendas falhou: o realizado fica INDISPONÍVEL (null +
    // motivo). Derrubar a leitura inteira esconderia o projetado, que não
    // depende dela; zerar mentiria.
    logEvento(deps.logger, "error", "margin_snapshot.realizado_indisponivel", {
      motivo: MOTIVO_REALIZADO.CENTRAL_VENDAS_FALHOU,
      clienteId: cliente.id,
      clienteContaId: conta.id,
      dateFrom: periodoResolvido.dateFrom,
      dateTo: periodoResolvido.dateTo,
      erro: err && err.message,
    });
    return {
      periodo: periodoResolvido,
      sincronizado: false,
      pedidosNoPeriodo: null,
      porMlb: new Map(),
      reembolsoPorMlb: new Map(),
      semMlb: null,
      reembolsos: null,
      cobertura: null,
      fallbackObservedAt: null,
      indisponivel: realizadoIndisponivel(MOTIVO_REALIZADO.CENTRAL_VENDAS_FALHOU),
    };
  }

  const sincronizado = vendasRaw.sincronizado === true;
  return {
    periodo: periodoResolvido,
    sincronizado,
    pedidosNoPeriodo: Array.isArray(vendasRaw.pedidos) ? vendasRaw.pedidos.length : 0,
    porMlb: agregado.porMlb,
    reembolsoPorMlb: agregado.reembolsoPorMlb,
    semMlb: agregado.semMlb || null,
    reembolsos: agregado.reembolsos || null,
    // Cobertura do período por competência (qual import respondeu cada mês e
    // o que ficou de fora) — nunca "sem venda" quando o mês não foi coberto.
    cobertura: periodoRealizado.resumirCobertura({ competencias: vendasRaw.competencias || [] }),
    fallbackObservedAt: vendasRaw.importSnapshotAt || null,
    // Nenhum import cobre o período: não há realizado para afirmar (≠ zero venda).
    indisponivel: sincronizado ? null : realizadoIndisponivel(MOTIVO_REALIZADO.SEM_SINCRONIZACAO),
  };
}

// Contrato público do período (o mesmo em /itens e /realizado).
function periodoPublico(realizada) {
  const p = realizada.periodo;
  return {
    dateFrom: p.dateFrom,
    dateTo: p.dateTo,
    modo: p.modo,
    periodo: p.periodo,
    rotulo: p.rotulo,
    referencia: p.referencia,
  };
}

function coberturaPublica(cobertura) {
  if (!cobertura) return null;
  const { competencias, ...resto } = cobertura;
  return resto;
}

const CAMPOS_MARGEM = [
  core.FIELDS.PRICE, core.FIELDS.COST, core.FIELDS.TAX_RATE,
  core.FIELDS.FIXED_FEE, core.FIELDS.COMMISSION, core.FIELDS.FREIGHT,
];

function percentual(margin) {
  return margin === null || margin === undefined ? null : Math.round(margin * 10000) / 100;
}

// Confiança da margem PROJETADA exibida — quatro estados, do pior para o melhor:
//   BLOQUEADA     falta componente obrigatório, ou a composição do preço não é
//                 comprovada (promoção não lida/identificada, participação do
//                 ML não informada): o número, se houver, é só limite inferior;
//   DESATUALIZADA a última atualização falhou para o item, ou preço do cálculo
//                 e promoção são leituras de momentos diferentes;
//   ESTIMADA      algum insumo é estimativa (frete por medidas/custo cobrado,
//                 frete não verificado, componente assumido, confiança baixa);
//   CONFIAVEL     todos os componentes medidos e a composição comprovada.
function confiancaDaMargem({ projected, precoVigente, row, freteResumo }) {
  const motivos = [];
  const quality = row.quality || {};
  if (projected.margin === null || projected.margin === undefined) {
    motivos.push(projected.incompletaMotivo || (row.missing && row.missing.length
      ? `Falta ${row.missing.join(", ")} para calcular a margem.`
      : "Margem projetada não calculável."));
    return { nivel: "BLOQUEADA", motivos };
  }
  if (precoVigente && (precoVigente.status === STATUS_PRECO.REVISAR || precoVigente.status === STATUS_PRECO.SEM_PRECO)) {
    motivos.push(precoVigente.texto);
    return { nivel: "BLOQUEADA", motivos, limiteInferior: precoVigente.status === STATUS_PRECO.REVISAR };
  }
  const refresh = row.refreshStatus;
  if (refresh === "failed" || refresh === "stale") {
    motivos.push(refresh === "failed"
      ? "A última atualização não recalculou este anúncio: o valor é da leitura anterior."
      : "Leitura anterior não revalidada.");
  }
  if (precoVigente && precoVigente.status === STATUS_PRECO.DESATUALIZADO) motivos.push(precoVigente.texto);
  if (motivos.length) return { nivel: "DESATUALIZADA", motivos };

  const aplicavel = typeof quality.freteAplicavel === "boolean" ? quality.freteAplicavel : true;
  if (aplicavel && freteResumo) {
    if (freteResumo.estimado) motivos.push(freteResumo.texto || "Frete estimado.");
    else if (!freteResumo.avaliado && row.freight !== null && row.freight !== undefined) {
      motivos.push("Frete cotado direto pelo Mercado Livre, sem verificação da modalidade logística (pode ser a tarifa de Envios Agora).");
    }
  }
  if ((row.assumed || []).length) motivos.push(`Assumido 0 para: ${row.assumed.join(", ")}.`);
  if (row.confidenceLevel === "LOW") motivos.push("Confiança baixa nas evidências do cálculo.");
  if (precoVigente && precoVigente.momentosDiferentes) motivos.push("Preço e promoção vêm de leituras com mais de 12 h de diferença (mesmo preço).");
  return { nivel: motivos.length ? "ESTIMADA" : "CONFIAVEL", motivos };
}

/**
 * Monta o item no mesmo contrato que a Central já consome (fields/quality/
 * projected/realized + aliases planos), com:
 *  - projected: os números da linha do snapshot; a ÚNICA correção é o retorno
 *    ML de promoção em andamento (margemAtualRebate), aplicado na leitura;
 *  - fields: evidências projetadas persistidas + evidências realizadas da
 *    Central de Vendas, resolvidas pelo núcleo (divergência previsto ×
 *    realizado incluída);
 *  - realized: núcleo (computeMargin) sobre as evidências REALIZADAS;
 *  - status/confiança: os do snapshot (classificação da PROJETADA —
 *    `statusBase: "projected"`).
 */
function comporItem(row, realizada, deps = {}, rebateInfo = null, rebateIndisponivel = null, rebateCtx = {}) {
  const computeMargin = deps.computeMargin || core.computeMargin;
  const bag = core.createEvidenceBag();

  for (const [campo, lista] of Object.entries(row.quality?.evidencias || {})) {
    for (const e of lista || []) {
      bag.add(campo, {
        source: e.source, kind: core.EVIDENCE_KINDS.PROJECTED, quality: e.quality,
        value: e.value, observedAt: e.observedAt, note: e.note,
      });
    }
  }

  const agregado = realizada.porMlb.get(row.itemId) || null;
  const realizado = centralVendas.aplicarEvidenciasRealizadas(bag, { agregado, fallbackObservedAt: realizada.fallbackObservedAt });
  const reembolso = realizada.reembolsoPorMlb.get(row.itemId) || null;
  const reembolsoInfo = centralVendas.aplicarEvidenciaReembolso(bag, { reembolso, fallbackObservedAt: realizada.fallbackObservedAt });

  const fields = core.resolveAllFields(bag);
  const hasOrders = Boolean(realizado);
  const realizadoMotivo = realizada.indisponivel ? realizada.indisponivel.motivo : null;

  // Mesmo cálculo do realizado de buildMarginItem: só com venda; valores
  // REALIZED de cada variável — nunca caindo para o projetado.
  const realized = hasOrders
    ? computeMargin(Object.fromEntries(CAMPOS_MARGEM.map((k) => [k, core.valueForKind(fields[k], core.EVIDENCE_KINDS.REALIZED)])))
    : { computable: false, profit: null, margin: null, missing: ["order"], assumed: [], strict: false };

  const conciliacao = settlement.avaliarConciliacao({ hasOrders });
  const divergences = [];
  for (const key of Object.keys(fields)) {
    for (const d of fields[key].divergences) divergences.push({ field: key, ...d });
  }

  const quality = row.quality || {};
  // Margem atual com o retorno ML da promoção em andamento (mesmo módulo da
  // tabela, do drawer e das Oportunidades). Sem rebate = a linha do snapshot.
  const atual = margemAtualComRebate(row, rebateInfo, rebateIndisponivel, rebateCtx);
  const precoVigente = atual.precoVigente || null;
  // O status acompanha a margem exibida: reclassificado pela MESMA classifyStatus
  // do núcleo (null = o do snapshot continua valendo).
  const reclass = reclassificarStatus(row, atual);
  const statusItem = reclass ? reclass.status : row.status;
  // P0 04/11/2026: comissão ou frete ASSUMIDOS como 0 na linha gravada (antes
  // da trava de cotação incompleta) ⇒ margem inflada (ex.: R$ 50 com 45%). O
  // número não é exibido nem usado como margem; a linha e o status do Motor
  // ("Dado suspeito") continuam, com o motivo explícito.
  const custoMarketplaceAssumido = margemConfiavel.custoMarketplaceAusente({
    assumed: row.assumed || [],
    freteAplicavel: row.quality && typeof row.quality.freteAplicavel === "boolean" ? row.quality.freteAplicavel : null,
  }) || margemConfiavel.freteLegadoNaoVerificado({ clienteContaId: row.clienteContaId, freteQualidade: quality.freteQualidade });
  const projected = {
    profit: custoMarketplaceAssumido ? null : atual.profit,
    margin: custoMarketplaceAssumido ? null : atual.margin,
    marginPercent: custoMarketplaceAssumido ? null : (atual.rebate === null ? row.marginPercent : percentual(atual.margin)),
    computable: row.margin !== null && !custoMarketplaceAssumido,
    strict: (row.assumed || []).length === 0 && row.margin !== null,
    missing: row.missing || [],
    assumed: row.assumed || [],
  };
  const freteResumo = resumoDoFrete({ fretePrevisto: row.freight, freteQualidade: quality.freteQualidade || null });
  const confianca = confiancaDaMargem({
    projected: { ...projected, incompletaMotivo: custoMarketplaceAssumido ? margemConfiavel.NOTA_MARGEM_INCOMPLETA : null },
    precoVigente, row, freteResumo,
  });
  const realizedContrato = {
    profit: realized.profit,
    margin: realized.margin,
    marginPercent: percentual(realized.margin),
    computable: realized.computable,
    strict: realized.strict,
    missing: realized.missing,
    assumed: realized.assumed,
  };
  const sales = {
    hasOrders,
    unidades: realizado?.unidades ?? null,
    pedidos: realizado?.pedidos ?? null,
    receita: realizado?.receita ?? null,
    ultimaVendaEm: realizado?.ultimaVendaEm ?? null,
    precoMedio: realizado?.precoUnitarioMedio ?? null,
    // Contraprova (mesmo contrato do Motor ao vivo, marginItem.sales): o que
    // a Central de Vendas persistiu × o que o núcleo recalcula.
    resultadoPersistido: realizado?.resultadoPersistido ?? null,
    resultadoRecalculado:
      realized.profit === null || realized.profit === undefined || !realizado
        ? null
        : core.round2(realized.profit * (realizado.unidades || 0)),
    cobertura: realizado?.cobertura ?? null,
    // Reembolso é conciliação: fica visível, nunca entra na margem.
    reembolso: reembolsoInfo ? { total: reembolsoInfo.reembolsoTotal, pedidos: reembolsoInfo.pedidos } : null,
  };
  // O painel Projetado × Realizado usa a MESMA margem projetada do header
  // (atual, já com o retorno ML da promoção em andamento) — o retorno sai
  // como linha própria "Retorno ML" (ver buildProjectedVsRealized), então os
  // componentes exibidos + o retorno continuam fechando com o total mostrado.
  const projectedVsRealized = core.buildProjectedVsRealized({
    fields,
    projected,
    realized,
    sales,
    coverage: sales.cobertura,
    rebate: { value: atual.rebate, motivo: atual.rebateMotivo },
  });

  // Integridade do dado lida da linha (preço × custo PROJETADOS) pela mesma
  // regra do núcleo — vale também para linhas calculadas antes da regra
  // existir, sem reprocessar o snapshot. O STATUS persistido só muda no
  // próximo cálculo; a integridade já aparece.
  const integrity = core.detectIntegrityIssue({ price: row.price, cost: row.cost });

  return {
    identity: {
      clienteSlug: null, marketplace: row.marketplace, itemId: row.itemId,
      sku: row.sku, titulo: row.titulo, image: row.imageUrl,
    },
    fields,
    margin: {
      projected,
      realized: realizedContrato,
      target: { marginTarget: quality.targetMargin ?? null },
      // Mesmo erro de projeção do Motor ao vivo (marginItem.margin.projectionError) —
      // sobre a MESMA margem projetada do header/painel (atual, com o retorno ML).
      projectionError: core.compareMargins(projected.margin, realized.margin),
    },
    // Realizado indisponível: nada de "NO_SALES" (afirmaria que não vendeu).
    projectedVsRealized: realizadoMotivo ? null : projectedVsRealized,
    realizado: realizadoMotivo ? null : undefined,
    realizado_motivo: realizadoMotivo,
    quality: {
      confidence: row.confidenceLevel,
      confidenceByField: quality.confidenceByField || {},
      reasons: quality.reasons || [],
      divergences,
      hasConflict: quality.hasConflict === true,
      hasDrift: divergences.some((d) => d.type === "DRIFT"),
      status: statusItem,
      statusLabel: reclass ? reclass.label : quality.statusLabel || null,
      statusSeverity: reclass ? reclass.severity : quality.statusSeverity || null,
      statusReasons: reclass ? reclass.reasons : quality.statusReasons || [],
      // Transparência: o status persistido era outro; o retorno ML da promoção
      // em andamento mudou a margem e, com ela, a classificação.
      statusReclassificado: reclass ? { de: reclass.de, para: reclass.status, motivo: reclass.motivo || "retorno_ml" } : null,
      integrityCode: integrity ? integrity.code : null,
      integrityReason: integrity ? integrity.reason : null,
    },
    statusBase: "projected",
    sales,
    settlement: { available: conciliacao.available, motivo: conciliacao.motivo },
    snapshot: {
      refreshStatus: row.refreshStatus,
      calculatedAt: row.calculatedAt,
      observedAt: row.observedAt,
      runId: row.runId,
      lastError: row.lastError ? redigirSegredos(row.lastError, 300) : null,
    },
    diagnostico: {
      temCustoNaBase: quality.temCustoNaBase ?? null,
      faltantesMeliApi: quality.faltantesMeliApi || [],
      statusAnuncio: quality.statusAnuncio || null,
      // Nível do frete: estimado (dimensões/custo cobrado) nunca é "confirmado". null = cotação direta do ML.
      freteQualidade: quality.freteQualidade || null,
      // Resumo legível do frete considerado (mesmo texto do /anuncios).
      frete: {
        valor: freteResumo.valor,
        nivel: quality.freteQualidade ? quality.freteQualidade.nivel || null : null,
        estimado: freteResumo.estimado,
        verificado: freteResumo.avaliado,
        confianca: freteResumo.confianca,
        texto: freteResumo.texto,
        aplicavel: typeof quality.freteAplicavel === "boolean" ? quality.freteAplicavel : null,
      },
    },
    // Composição do preço vigente: preço cheio/comprador/vendedor, promoção,
    // financiador e retorno ML comprovado (precoVigenteComposicao).
    precoVigente,

    // Aliases planos que o frontend da Central já lê (mesmos de
    // motorMargemService.comAliasesDeCompatibilidade).
    itemId: row.itemId,
    sku: row.sku,
    title: row.titulo,
    titulo: row.titulo,
    image: row.imageUrl,
    marketplace: row.marketplace,
    status: statusItem,
    confidence: row.confidenceLevel,
    confianca: row.confidenceLevel,
    problema: (integrity && integrity.reason) || (reclass ? reclass.reasons : quality.statusReasons || [])[0] || null,
    targetMargin: quality.targetMargin ?? null,
    projected: {
      margin: projected.margin,
      profit: projected.profit,
      estimated: projected.margin !== null && projected.assumed.length > 0,
      // Comissão/frete do ML ausentes nesta linha: margem não exibida (≠ margem ruim).
      incompleta: custoMarketplaceAssumido,
      note: custoMarketplaceAssumido
        ? margemConfiavel.NOTA_MARGEM_INCOMPLETA
        : projected.assumed.length ? `Assumido 0 para: ${projected.assumed.join(", ")}.` : null,
      // Retorno ML da promoção em andamento já somado à margem acima (null = nenhum).
      rebate: atual.rebate,
      rebateMotivo: atual.rebateMotivo,
      // CONFIAVEL | ESTIMADA | DESATUALIZADA | BLOQUEADA (+ motivos). BLOQUEADA
      // com margem = limite inferior (sem o retorno ML não comprovado).
      confianca: confianca.nivel,
      confiancaMotivos: confianca.motivos,
      limiteInferior: confianca.limiteInferior === true,
    },
    realized: {
      margin: realizedContrato.margin,
      profit: realizedContrato.profit,
      pending: realizedContrato.computable === false,
    },
    divergences,
    conciliacao: conciliacao.available ? "Disponível" : "Pendente",
  };
}

// ---------------------------------------------------------------------------
// Lista paginada
// ---------------------------------------------------------------------------

// Seller ML da conta (identidade do Promo Snapshot = conta + seller). Sem
// seller não há promoção conhecida: a margem fica a do snapshot.
async function sellerDaConta(conta, deps, db) {
  try {
    const contas = deps.clienteContaService || require("../clienteContas/clienteContaService");
    const completa = await contas.obterConta(conta.id, db);
    return completa && completa.external_account_id ? String(completa.external_account_id) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Retorno ML das promoções em andamento da CONTA (uma consulta) e os status que
 * ele muda. Lido uma vez por requisição e usado por tudo que mostra status:
 * itens da página, filtro por status, ordenação e KPIs (obterResumo).
 *
 * @returns {Promise<{ rebates: {porItem: Map, indisponivel: string|null}, overrides: {itemIds: string[], statuses: string[]} }>}
 */
async function statusEfetivoDaConta({ cliente, conta, deps, db }) {
  const repo = deps.snapshotRepository || snapshotRepository;
  const seller = await sellerDaConta(conta, deps, db);
  const rebates = await carregarRebatesDaConta({
    clienteContaId: conta.id, sellerId: seller, db, promoRepo: deps.promoRepository, logger: deps.logger,
  });
  const repoPromo = deps.promoRepository || require("../promoSnapshot/promoSnapshotRepository");
  // Promoções completas dos anúncios em preço promocional fora do mapa da conta
  // (campanha do vendedor sem subsídio, DEAL…): UMA consulta para o lote.
  const carregarPromocoesDosItens = typeof repoPromo.mapRebatesAtivosPorItem === "function"
    ? (itemIds) => carregarRebatesAtivos({ clienteContaId: conta.id, sellerId: seller, itemIds, db, promoRepo: repoPromo, logger: deps.logger })
    : null;
  const overrides = rebates.indisponivel
    ? { itemIds: [], statuses: [], rebateEmPrejuizo: 0, limiteInferior: { total: 0, LOSS: 0, LOW_MARGIN: 0 } }
    : await calcularStatusOverrides({
      clienteId: cliente.id, clienteContaId: conta.id, rebates: rebates.porItem, snapshotRepo: repo, db, carregarPromocoesDosItens,
    });
  return { rebates, overrides, sellerId: seller };
}

async function listarItens(params = {}, deps = {}) {
  const env = deps.env || process.env;
  const { clienteSlug, clienteContaId } = params;
  if (!leituraHabilitada({ clienteSlug }, env)) throw erroDesabilitado();

  const db = deps.db || pool;
  const repo = deps.snapshotRepository || snapshotRepository;
  // Filtros/ordenação validados ANTES de qualquer consulta.
  const filtros = lerFiltros(params, repo);
  const ordem = lerOrdenacao(params, repo);
  const { cliente, conta } = await api.resolverContaDoCliente({ clienteSlug, clienteContaId }, deps);
  const pag = paginacao(params);
  const { estado, runAtivo, ultimoRun } = await carregarEstado({ cliente, conta }, deps);

  const base = {
    ok: true,
    modo: "snapshot",
    cliente,
    conta,
    marketplace: MARKETPLACE,
    estado,
    filtros,
    ordenacao: { chave: ordem.chave, direcao: ordem.direcao },
    refresh: { runAtivo: api.runPublico(runAtivo), ultimoRun: api.runPublico(ultimoRun) },
  };

  if (estado === "missing") {
    return {
      ...base,
      acao: runAtivo ? null : "refresh",
      mensagem: mensagemEstado(estado, runAtivo),
      // null, não 0: "não sabemos" nunca vira "nenhum item".
      paginacao: { page: pag.page, limit: pag.limit, total: null, totalPaginas: null },
      itens: [],
    };
  }

  // Status EFETIVO (com o retorno ML das promoções em andamento): o filtro por
  // status, a contagem, a ordenação e os itens da página usam o mesmo.
  const efetivo = await statusEfetivoDaConta({ cliente, conta, deps, db });
  const filtro = repo.montarFiltroSnapshots({
    clienteId: cliente.id, clienteContaId: conta.id, marketplace: MARKETPLACE, ...filtros, statusOverrides: efetivo.overrides,
  });

  // O realizado vem ANTES da página: a ordem `worklist` usa a receita realizada por MLB.
  const realizada = await carregarRealizadaDoPeriodo(
    { cliente, conta, dateFrom: params.dateFrom, dateTo: params.dateTo, periodo: params.periodo },
    deps
  );
  const receitas = {};
  for (const [mlb, venda] of realizada.porMlb || []) {
    const receita = venda && Number(venda.receita);
    if (Number.isFinite(receita)) receitas[mlb] = receita;
  }
  const [linhas, contagem] = await Promise.all([
    repo.queryProjectionSnapshotsPage({ filtro, orderBy: ordem.orderBy, limit: pag.limit, offset: pag.offset, receitas, db }),
    repo.countProjectionSnapshotsFiltrado({ filtro, db }),
  ]);

  // Promoções COMPLETAS dos itens da página (a da conta só traz os subsidiados):
  // a composição precisa ver também a campanha do vendedor que forma o preço.
  const repoPromo = deps.promoRepository || require("../promoSnapshot/promoSnapshotRepository");
  const rebates = efetivo.rebates.indisponivel || typeof repoPromo.mapRebatesAtivosPorItem !== "function"
    ? efetivo.rebates
    : await carregarRebatesAtivos({
      clienteContaId: conta.id, sellerId: efetivo.sellerId, itemIds: linhas.map((l) => String(l.itemId)),
      db, promoRepo: repoPromo, logger: deps.logger,
    });
  const rebateCtx = { promoSnapshot: rebates.porItem.promoSnapshot !== undefined ? rebates.porItem.promoSnapshot : efetivo.rebates.porItem.promoSnapshot };

  return {
    ...base,
    periodo: periodoPublico(realizada),
    vendas: {
      sincronizado: realizada.sincronizado,
      pedidosNoPeriodo: realizada.pedidosNoPeriodo,
      cobertura: coberturaPublica(realizada.cobertura),
      // Realizado indisponível: null + motivo (nunca 0 pedidos / "sem venda").
      ...(realizada.indisponivel
        ? { realizado: null, realizado_motivo: realizada.indisponivel.motivo, realizado_mensagem: realizada.indisponivel.mensagem }
        : {}),
    },
    paginacao: {
      page: pag.page,
      limit: pag.limit,
      total: contagem.total,
      totalPaginas: Math.max(Math.ceil(contagem.total / pag.limit), 1),
    },
    ultimoCalculoEm: contagem.ultimoCalculoEm,
    itens: linhas.map((row) => comporItem(row, realizada, deps, rebates.porItem.get(String(row.itemId)) || null, rebates.indisponivel, rebateCtx)),
  };
}

// ---------------------------------------------------------------------------
// Realizado da CONTA no período (KPIs + cobertura + freshness)
// ---------------------------------------------------------------------------
//
// Independe de página/filtro da lista. Lê a Central de Vendas UMA vez para o
// período, aplica o mesmo núcleo por anúncio (marginRealizadoKpis) e lê a
// projeção persistida só dos anúncios que venderam, em UMA query
// (mapProjectionsForItems) — nenhum N+1, nenhuma chamada ao ML.
async function obterRealizado(params = {}, deps = {}) {
  const env = deps.env || process.env;
  const { clienteSlug, clienteContaId } = params;
  if (!leituraHabilitada({ clienteSlug }, env)) {
    return { ok: true, habilitado: false, modo: "legacy" };
  }
  const db = deps.db || pool;
  const repo = deps.snapshotRepository || snapshotRepository;
  const { cliente, conta } = await api.resolverContaDoCliente({ clienteSlug, clienteContaId }, deps);

  const realizada = await carregarRealizadaDoPeriodo(
    { cliente, conta, dateFrom: params.dateFrom, dateTo: params.dateTo, periodo: params.periodo },
    deps
  );
  const projecoes = await (repo.mapProjectionsForItems
    ? repo.mapProjectionsForItems({ clienteId: cliente.id, clienteContaId: conta.id, marketplace: MARKETPLACE, itemIds: Array.from(realizada.porMlb.keys()), db })
    : new Map());
  // Realizado indisponível (Central de Vendas falhou / nada sincronizado):
  // sem KPIs. Agregar um período vazio devolveria receita 0, 0 pedidos e
  // 0 produtos com venda — afirmaria "não vendeu" sem saber.
  const kpis = realizada.indisponivel
    ? null
    : agregarKpisRealizados({
        porMlb: realizada.porMlb,
        semMlb: realizada.semMlb,
        pedidosNoPeriodo: realizada.pedidosNoPeriodo,
        projecoes,
      });

  let syncAtivo = null;
  try {
    const buscar = deps.buscarSyncAtivo || require("../centralVendas/centralVendasSyncRunService").buscarRunAtivoDaConta;
    syncAtivo = await buscar({ clienteId: cliente.id, clienteContaId: conta.id, marketplace: MARKETPLACE, db });
  } catch (err) {
    // Freshness é informativo: falhar aqui nunca derruba a leitura.
    syncAtivo = null;
  }

  const cobertura = coberturaPublica(realizada.cobertura);
  const indisponivel = realizada.indisponivel
    ? { realizado: null, realizado_motivo: realizada.indisponivel.motivo, realizado_mensagem: realizada.indisponivel.mensagem }
    : {};
  return {
    ...indisponivel,
    ok: true,
    habilitado: true,
    modo: "snapshot",
    cliente,
    conta,
    marketplace: MARKETPLACE,
    periodo: periodoPublico(realizada),
    cobertura: cobertura ? { ...cobertura, competencias: realizada.cobertura.competencias } : null,
    freshness: {
      estado: cobertura ? cobertura.estado : "INDISPONIVEL",
      sincronizadoAte: cobertura ? cobertura.sincronizadoAte : null,
      ultimaPublicacaoEm: cobertura ? cobertura.ultimaPublicacaoEm : null,
      ultimoImportEm: cobertura ? cobertura.ultimoImportEm : null,
      syncEmAndamento: Boolean(syncAtivo),
      syncAtivo,
    },
    kpis,
    reembolsos: realizada.reembolsos,
  };
}

module.exports = {
  confiancaDaMargem,
  sellerDaConta,
  statusEfetivoDaConta,
  obterRealizado,
  LIMIT_PADRAO,
  LIMIT_MAX,
  leituraHabilitada,
  obterResumo,
  listarItens,
  comporItem,
  carregarRealizadaDoPeriodo,
};
