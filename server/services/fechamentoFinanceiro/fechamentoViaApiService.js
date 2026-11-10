// server/services/fechamentoFinanceiro/fechamentoViaApiService.js
//
// Fechamento financeiro do Mercado Livre a partir da API (Central de Vendas),
// sem planilha. Lê o import PUBLISHED vigente da competência (o que o sync já
// trouxe da API do ML) e devolve o MESMO formato que POST /fechamentos/financeiro
// devolve para planilha ML (summary, detailedRows, unmatchedIds, metadados),
// para o front reusar montarPayloadFechamento e o relatório público renderizar
// igual. Ver docs/FECHAMENTO_VIA_API.md para o mapeamento chave a chave.
//
// Regras deste serviço:
// - Nenhum cálculo novo de faturamento/LC/MC: tudo sai de buildResumoCentralVendas
//   (o mesmo cálculo que gravou resumo_json do import) e de buildCoverage. ADS,
//   Venforce, afiliados e custos fixos entram só na fórmula do Resultado Final e
//   nos índices (computeTacos/computeTacox), com os mesmos helpers da planilha.
// - Quando a API não traz a fonte de uma chave do summary da planilha, a chave
//   vai como null. Nunca 0 inventado (Master Spec M6).
// - Somente leitura: nada é gravado aqui. Salvar a entrega continua sendo do front.
// - Sync incompleto NÃO é erro: responde com sync.completo=false e o front pede
//   confirmação. Só a falta total de sync publicado vira 409 CENTRAL_SEM_SYNC.

const pool = require("../../config/database");
const {
  resolverClientePorIdOuSlug,
  obterConta,
  sanitizarConta,
} = require("../clienteContas/clienteContaService");
const centralVendasRepository = require("../centralVendas/centralVendasRepository");
const { buildResumoCentralVendas } = require("../centralVendas/centralVendasImportService");
const { pedidoEntraNoResultado } = require("../centralVendas/centralVendasService");
const {
  buildCoverage,
  safeRatio,
  computeTacos,
  computeTacox,
} = require("../../utils/fechamento/financeiroShared");
const { rangeDaCompetencia } = require("../../utils/competenciaCanonica");
const { compararCompetencias } = require("../../utils/competenciaDetectada");
const { parseMoneyValue } = require("../../utils/numberUtils");
const { CODIGOS_CANONICOS } = require("../../utils/erroContextoCanonico");

// Mesmo texto de aviso da planilha, mas com a regra REAL da API: sem tarifa de
// venda ou frete sincronizados, o LC não desconta esse componente (o motor da
// Central não inventa o valor). Por isso o aviso diz isso, e não "LC usa só
// vendas completas" como na planilha.
const AVISO_FINANCEIRO_PENDENTE =
  "Parte das vendas ainda não possui tarifa de venda ou frete sincronizados da API do " +
  "Mercado Livre. Nessas vendas o LC não desconta o componente ausente — confira antes de publicar.";

const AVISO_FONTE_API =
  "Fechamento calculado a partir da API do Mercado Livre (Central de Vendas). " +
  "As diferenças conhecidas em relação à planilha estão em docs/FECHAMENTO_VIA_API.md.";

// ─── utilidades ─────────────────────────────────────────────────────────────

function criarErro(statusCode, mensagem, extra = {}) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function numOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch (_) { return {}; }
  }
  return value;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

// Data de calendário sem deslocamento de fuso: pg devolve DATE como Date à
// meia-noite LOCAL, então leio com getters locais (toISOString deslocaria o dia).
function isoDay(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

function isoTimestamp(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function diaAnterior(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

// "Hoje" no fuso do negócio (America/Sao_Paulo), nunca o fuso do container.
function hojeSaoPaulo(agora = new Date()) {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(agora);
  const get = (type) => partes.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function temPendencia(row, nome) {
  return asArray(row?.pendencias_json).includes(nome);
}

// Pedido com tarifa de venda e frete sincronizados. Sem qualquer um dos dois,
// o financeiro dele ainda está pendente (mesmo conceito da planilha).
function financeiroCompleto(pedido) {
  return !temPendencia(pedido, "tarifa_venda_ausente") && !temPendencia(pedido, "frete_seller_ausente");
}

function somaFaturamento(pedidos) {
  return round2(pedidos.reduce((s, p) => s + Number(p.faturamento || 0), 0));
}

// ─── parâmetros ─────────────────────────────────────────────────────────────

// Ajustes do fechamento: texto pt-BR ou número. Campo vazio vale zero; valor
// ambíguo é erro (nunca chuta o separador decimal).
function parseAjustesFechamentoApi(body) {
  const campos = [
    ["ads", "ADS"],
    ["venforce", "Venforce"],
    ["affiliates", "Afiliados"],
    ["fullCost", "FULL"],
    ["additionalCosts", "Custos adicionais"],
  ];
  const out = {};
  for (const [campo, label] of campos) {
    const parsed = parseMoneyValue(body?.[campo]);
    if (!parsed.valid) {
      throw criarErro(
        400,
        `${label}: formato monetário inválido ou ambíguo. Use, por exemplo, 3011, 3011.00 ou 3.011,00.`,
        { code: "AJUSTE_INVALIDO" }
      );
    }
    out[campo] = parsed.value;
  }
  return out;
}

// Cliente + conta + competência, com as mesmas travas do Financeiro visão:
// conta obrigatória, pertencer ao cliente, ativa e Mercado Livre.
async function resolverContextoFechamentoApi({ clienteSlugRaw, clienteContaIdRaw, periodoRaw, hojeIso = null }, deps) {
  // Período primeiro: PERIODO_OBRIGATORIO / PERIODO_INVALIDO já vêm do canônico.
  const { competencia, dateFrom, dateTo } = rangeDaCompetencia(periodoRaw);

  const cliente = await deps.resolverClientePorIdOuSlug({ clienteSlug: clienteSlugRaw });

  const clienteContaId = Number(clienteContaIdRaw);
  if (!Number.isInteger(clienteContaId) || clienteContaId <= 0) {
    throw criarErro(400, "conta é obrigatória (clienteContaId da conta do Mercado Livre).", {
      code: "CONTA_OBRIGATORIA",
    });
  }

  const contaRaw = await deps.obterConta(clienteContaId);
  if (Number(contaRaw.cliente_id) !== Number(cliente.id)) {
    throw criarErro(403, "Esta conta não pertence ao cliente informado.", {
      code: CODIGOS_CANONICOS.CONTA_NAO_PERTENCE_AO_CLIENTE,
    });
  }
  if (contaRaw.ativo === false) {
    throw criarErro(409, `A conta "${contaRaw.nome}" foi desativada.`, {
      code: CODIGOS_CANONICOS.CONTA_INATIVA,
    });
  }
  if (String(contaRaw.marketplace || "").toLowerCase() !== "meli") {
    throw criarErro(400, "O fechamento pela API só existe para contas do Mercado Livre.", {
      code: "FECHAMENTO_API_SO_MELI",
    });
  }

  // "Esperado" = o que o sync deveria ter coberto: o mês inteiro, ou até ontem
  // no mês em andamento (mesma regra do noturno: nunca o dia de hoje).
  const hoje = hojeIso || deps.hojeIso || hojeSaoPaulo();
  const ontem = diaAnterior(hoje);
  const esperadoAte = dateTo <= ontem ? dateTo : ontem;

  return {
    cliente,
    conta: { id: Number(contaRaw.id), nome: contaRaw.nome, marketplace: "meli" },
    competencia,
    inicio: dateFrom,
    fim: dateTo,
    esperadoAte,
  };
}

// ─── seleção do import vigente ──────────────────────────────────────────────

async function buscarImportPublicadoPorId(id, ctx, deps) {
  const { rows } = await deps.db.query(
    `SELECT id, competencia, resumo_json, publication_status, coverage_date_from,
            coverage_date_to, published_at, sync_run_id
       FROM central_vendas_imports
      WHERE id = $1 AND cliente_slug = $2 AND cliente_conta_id = $3
        AND marketplace = 'meli' AND publication_status = 'published'`,
    [id, ctx.cliente.slug, ctx.conta.id]
  );
  return rows[0] || null;
}

// Import que a Central usaria para a competência, pela MESMA seleção M4
// (resolveImportsForRange). Primeiro tenta o trecho esperado completo; se
// nenhum publicado cobre, usa o publicado mais recente da competência que o
// próprio diagnóstico da seleção aponta, e o sync sai como incompleto.
// Legado nunca conta: não tem cobertura comprovada.
async function selecionarImportVigente(ctx, deps) {
  const segmentoAte = ctx.esperadoAte >= ctx.inicio ? ctx.esperadoAte : ctx.fim;
  const resolvido = await deps.resolveImportsForRange(
    {
      clienteSlug: ctx.cliente.slug,
      dateFrom: ctx.inicio,
      dateTo: segmentoAte,
      marketplace: "meli",
      clienteContaId: ctx.conta.id,
      includeLegacy: false,
    },
    deps.db
  );

  const cobre = (resolvido.imports || []).find(
    (row) => row.competencia === ctx.competencia && row.publication_status === "published"
  );
  if (cobre) return cobre;

  const diagnostico = (resolvido.competencias || []).find((c) => c.competencia === ctx.competencia);
  const publicadoMaisRecente = diagnostico?.publicadoMaisRecente;
  if (!publicadoMaisRecente?.id) return null;
  return buscarImportPublicadoPorId(publicadoMaisRecente.id, ctx, deps);
}

function montarSync(imp, ctx) {
  const coberturaDe = isoDay(imp.coverage_date_from);
  const coberturaAte = isoDay(imp.coverage_date_to);
  const motivos = [];
  if (coberturaDe && coberturaDe > ctx.inicio) {
    motivos.push(`A sincronização começa em ${coberturaDe}; o período começa em ${ctx.inicio}.`);
  }
  if (ctx.esperadoAte >= ctx.inicio && (!coberturaAte || coberturaAte < ctx.esperadoAte)) {
    motivos.push(
      `A sincronização cobre até ${coberturaAte || "—"}; o esperado é até ${ctx.esperadoAte}.`
    );
  }
  const completo = motivos.length === 0;
  return {
    disponivel: true,
    importId: Number(imp.id),
    publicadoEm: isoTimestamp(imp.published_at),
    coberturaDe,
    coberturaAte,
    completo,
    motivoIncompleto: completo ? null : motivos.join(" "),
  };
}

const SYNC_INDISPONIVEL = Object.freeze({
  disponivel: false,
  importId: null,
  publicadoEm: null,
  coberturaDe: null,
  coberturaAte: null,
  completo: false,
  motivoIncompleto: "Mês ainda não sincronizado.",
});

// Base de custos que o sync usou (central_vendas_sync_runs.base_id). Só
// documenta: se a base mudou depois, não recalcula — o usuário re-sincroniza.
async function buscarCostsBase(imp, deps) {
  if (!imp.sync_run_id) return null;
  const { rows } = await deps.db.query(
    `SELECT b.id, b.slug, b.nome
       FROM central_vendas_sync_runs r
       JOIN bases b ON b.id = r.base_id
      WHERE r.id = $1`,
    [imp.sync_run_id]
  );
  const base = rows[0];
  return base ? { id: Number(base.id), slug: base.slug ?? null, nome: base.nome ?? null } : null;
}

async function buscarRunEmAndamento(ctx, deps) {
  const { rows } = await deps.db.query(
    `SELECT id, status, created_at
       FROM central_vendas_sync_runs
      WHERE cliente_conta_id = $1 AND marketplace = 'meli' AND status IN ('queued','running')
      ORDER BY id DESC
      LIMIT 1`,
    [ctx.conta.id]
  );
  const run = rows[0];
  return run ? { id: Number(run.id), status: run.status, criadoEm: isoTimestamp(run.created_at) } : null;
}

// ─── consolidação (função pura, testável sem banco) ─────────────────────────

const TIPO_FINANCEIRO_PENDENTE = "financeiro pendente";

function coberturaDoItem(item) {
  if (temPendencia(item, "custo_produto_ausente")) return "sem custo";
  if (temPendencia(item, "tarifa_venda_ausente") || temPendencia(item, "frete_seller_ausente")) {
    return TIPO_FINANCEIRO_PENDENTE;
  }
  return "com custo";
}

// Mesma regra de agrupamento da planilha: o rótulo do grupo só fica "puro" se
// todos os itens do anúncio tiverem o mesmo estado; misturado vira "parcial".
function coberturaDoGrupo(coberturas) {
  const unicos = new Set(coberturas);
  if (unicos.size === 1) return [...unicos][0];
  return "parcial";
}

function agregarDetalhamento(itensValidos) {
  const porAnuncio = new Map();
  for (const item of itensValidos) {
    const id = item.mlb || "SEM_ID";
    if (!porAnuncio.has(id)) {
      porAnuncio.set(id, {
        "# de anúncio": id,
        "Título do anúncio": item.titulo || null,
        SKU: item.sku || null,
        Unidades: 0,
        "Preço unitário de venda do anúncio (BRL)": numOrNull(item.valor_unitario),
        "Venda Total": 0,
        "Total (BRL)": null,
        "Preço de custo total": null,
        "Ajuste plataforma (BRL)": null,
        LC: null,
        _coberturas: [],
      });
    }
    const acc = porAnuncio.get(id);
    acc.Unidades = round2(acc.Unidades + Number(item.quantidade || 0));
    acc["Venda Total"] = round2(acc["Venda Total"] + Number(item.receita_produto || 0));

    // null + null = null (desconhecido), null + número = número: um anúncio
    // inteiro sem custo não pode virar custo total 0.
    const custo = numOrNull(item.custo_produto);
    if (custo !== null) acc["Preço de custo total"] = round2((acc["Preço de custo total"] || 0) + custo);

    const lc = numOrNull(item.lucro_contribuicao);
    if (lc !== null) acc.LC = round2((acc.LC || 0) + lc);

    acc._coberturas.push(coberturaDoItem(item));
  }

  return [...porAnuncio.values()].map(({ _coberturas, ...row }) => ({
    ...row,
    "Cobertura de custo": coberturaDoGrupo(_coberturas),
    MC:
      row.LC === null
        ? null
        : row["Venda Total"] > 0
          ? round2((row.LC / row["Venda Total"]) * 100)
          : 0,
  }));
}

// Consolida o summary com as MESMAS chaves de processMeli (planilha). Função
// pura: recebe pedidos/itens/componentes já lidos do banco (linhas snake_case).
function consolidarFechamentoApi({ lucroContribuicaoImport, pedidos, itens, componentes, ajustes }) {
  const validos = pedidos.filter(pedidoEntraNoResultado);
  const foraDoResultado = pedidos.filter((p) => !pedidoEntraNoResultado(p));

  // FAT, com/sem custo, bloqueada e LC: o cálculo oficial da Central.
  const resumo = buildResumoCentralVendas({
    pedidos,
    resumo: { lucroContribuicao: numOrNull(lucroContribuicaoImport) },
  });
  const LC = resumo.lucroContribuicao;
  const grossRevenueTotal = resumo.faturamento;
  const revenueWithCost = resumo.faturamentoComCusto;
  const revenueWithoutCost = resumo.receitaBloqueada;
  const coverage = buildCoverage({ revenueWithCost, revenueWithoutCost });

  // Financeiro (tarifa/frete) disponível × pendente, por pedido válido.
  const completos = validos.filter(financeiroCompleto);
  const pendentes = validos.filter((p) => !financeiroCompleto(p));
  const revenueWithFinancialData = somaFaturamento(completos);
  const revenuePendingFinancial = somaFaturamento(pendentes);
  const financialDataCoveragePercent =
    grossRevenueTotal > 0 ? round2((revenueWithFinancialData / grossRevenueTotal) * 100) : null;

  // Base do LC: pedidos válidos com LC calculado (sem custo, o LC é null).
  const revenueCalculable = somaFaturamento(
    validos.filter((p) => p.lucro_contribuicao !== null && p.lucro_contribuicao !== undefined)
  );

  const ads = round2(ajustes.ads);
  const venforce = round2(ajustes.venforce);
  const affiliates = round2(ajustes.affiliates);
  const fullCost = round2(ajustes.fullCost);
  const additionalCosts = round2(ajustes.additionalCosts);

  // Resultado Final só existe com LC. LC null vira null, nunca 0.
  const finalResult =
    LC === null ? null : round2(LC - ads - venforce - affiliates - fullCost - additionalCosts);

  // Reembolsos: componente pedido-level (Orders API payments). A planilha
  // mede por linha; a API mede por pedido — diferença documentada.
  const reembolsos = componentes.filter((c) => c.tipo === "cancelamento_reembolso" && c.valor !== null);
  const refundsTotal = round2(reembolsos.reduce((s, c) => s + Number(c.valor || 0), 0));
  const pedidosComReembolso = new Set(reembolsos.map((c) => String(c.pedido_row_id)));
  const lostRevenueTotal = round2(
    itens
      .filter((i) => pedidosComReembolso.has(String(i.pedido_row_id)))
      .reduce((s, i) => s + Number(i.receita_produto || 0), 0)
  );

  const validosRowIds = new Set(validos.map((p) => String(p.id)));
  const itensValidos = itens.filter((i) => validosRowIds.has(String(i.pedido_row_id)));
  const detailedRows = agregarDetalhamento(itensValidos);

  const unmatchedIds = [
    ...new Set(
      itensValidos
        .filter((i) => temPendencia(i, "custo_produto_ausente"))
        .map((i) => i.mlb || "SEM_ID")
    ),
  ];

  const excludedStatusRevenue = somaFaturamento(foraDoResultado);

  const coberturaFinanceiraConfianca =
    revenuePendingFinancial > 0 && coverage.financialConfidence === "confiavel"
      ? "parcial"
      : coverage.financialConfidence;

  const executiveNotes = [];
  if (unmatchedIds.length > 0) {
    executiveNotes.push(
      `Fechamento parcial: ${unmatchedIds.length} anúncio(s) sem custo cadastrado. ` +
        "O faturamento total está completo; LC, MC e Resultado Final cobrem apenas a receita com custo identificado."
    );
  }
  if (revenuePendingFinancial > 0) executiveNotes.push(AVISO_FINANCEIRO_PENDENTE);
  if (foraDoResultado.length > 0) {
    executiveNotes.push(
      `${foraDoResultado.length} venda(s) fora do resultado por status (cancelado/devolvido/reembolsado/mediação). ` +
        "Não entram no faturamento do fechamento."
    );
  }
  executiveNotes.push(AVISO_FONTE_API);

  const summary = {
    grossRevenueTotal,
    refundsTotal,
    cancelledRevenue: refundsTotal,
    refundsCount: pedidosComReembolso.size,
    lostRevenueTotal,
    // Não gravado pelo motor da API (Total (BRL) do relatório de vendas): sem fonte honesta.
    paidRevenueTotal: null,
    contributionProfitTotal: LC,
    // Mesma função da planilha; sem LC a margem é null, nunca 0.
    averageContributionMargin: LC === null ? null : safeRatio(LC, revenueCalculable),
    finalResult,
    fullCostTotal: fullCost,
    additionalCostsTotal: additionalCosts,
    tacos: computeTacos(ads, grossRevenueTotal),
    tacox: computeTacox(ads, venforce, affiliates, grossRevenueTotal),
    // Ajuste de plataforma é só do motor da planilha; a API não o grava.
    platformAdjustmentTotal: null,
    platformAdjustmentRowsCount: null,
    calculationMode: "real_meli_vendas",
    revenueWithCost: coverage.revenueWithCost,
    revenueWithoutCost: coverage.revenueWithoutCost,
    calculatedCoveragePercent: coverage.calculatedCoveragePercent,
    financialConfidence: coberturaFinanceiraConfianca,
    revenueWithFinancialData,
    revenuePendingFinancial,
    revenueCalculable,
    financialDataCoveragePercent,
    salesWithFinancialDataCount: completos.length,
    salesPendingFinancialCount: pendentes.length,
    pendingFinancialWarning: revenuePendingFinancial > 0 ? AVISO_FINANCEIRO_PENDENTE : null,
    // Conflito de custo por MLB não é gravado pelo sync: null = não avaliado, não "sem conflito".
    costConflicts: null,
    costConflictWarnings: null,
    ambiguousCostIds: null,
    contributionMarginCalculated: LC === null ? null : safeRatio(LC, revenueCalculable),
    finalMarginCalculated: finalResult === null ? null : safeRatio(finalResult, revenueCalculable),
    profitCoversRevenue: revenueCalculable,
    excludedStatusRevenue,
    excludedStatusCount: foraDoResultado.length,
    adsTotal: ads,
    venforceTotal: venforce,
    affiliatesTotal: affiliates,
    executiveNotes,
  };

  return {
    summary,
    detailedRows,
    unmatchedIds,
    ignoredRowsWithoutCost: unmatchedIds.length,
    ignoredRevenue: revenueWithoutCost,
    emptySales: validos.length === 0,
    message:
      validos.length === 0
        ? "Sincronização válida sem vendas no período."
        : unmatchedIds.length > 0
          ? "Alguns anúncios do MELI não possuem custo cadastrado. O faturamento foi preservado; LC e MC cobrem apenas a receita com custo."
          : "OK",
  };
}

// ─── entradas públicas ──────────────────────────────────────────────────────

function defaultDeps() {
  return {
    db: pool,
    resolverClientePorIdOuSlug,
    obterConta,
    resolveImportsForRange: centralVendasRepository.resolveImportsForRange,
    loadPedidosByImportIds: centralVendasRepository.loadPedidosByImportIds,
    hojeIso: null,
  };
}

// GET /financeiro/:cliente/fechamento-api/status — o que a API tem para a
// competência, sem calcular nada.
async function obterStatusFechamentoViaApi({ clienteSlugRaw, clienteContaIdRaw, periodoRaw }, depsOverride = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  const ctx = await resolverContextoFechamentoApi({ clienteSlugRaw, clienteContaIdRaw, periodoRaw }, deps);
  const imp = await selecionarImportVigente(ctx, deps);
  const runEmAndamento = await buscarRunEmAndamento(ctx, deps);
  return {
    marketplace: "meli",
    periodo: ctx.competencia,
    sync: imp ? montarSync(imp, ctx) : { ...SYNC_INDISPONIVEL },
    runEmAndamento,
  };
}

// POST /financeiro/:cliente/fechamento-api — gera o resultado a partir do
// import publicado. Leitura pura: o front salva a entrega pelo fluxo atual.
async function gerarFechamentoViaApi({ clienteSlugRaw, clienteContaIdRaw, periodoRaw, ajustesRaw }, depsOverride = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  const ctx = await resolverContextoFechamentoApi({ clienteSlugRaw, clienteContaIdRaw, periodoRaw }, deps);
  const ajustes = parseAjustesFechamentoApi(ajustesRaw);

  const imp = await selecionarImportVigente(ctx, deps);
  if (!imp) {
    throw criarErro(
      409,
      "Não há sincronização da Central de Vendas para esta competência. Sincronize o mês antes de fechar pela API.",
      { code: "CENTRAL_SEM_SYNC" }
    );
  }

  const { pedidos, itens, componentes } = await deps.loadPedidosByImportIds(
    { importIds: [imp.id], dateFrom: ctx.inicio, dateTo: ctx.fim },
    deps.db
  );

  const consolidado = consolidarFechamentoApi({
    lucroContribuicaoImport: asObject(imp.resumo_json).lucroContribuicao,
    pedidos,
    itens,
    componentes,
    ajustes,
  });

  const sync = montarSync(imp, ctx);
  if (!sync.completo) consolidado.summary.executiveNotes.push(`Sincronização incompleta: ${sync.motivoIncompleto}`);

  return {
    ok: true,
    fonteVendas: "api",
    summary: consolidado.summary,
    competencia: compararCompetencias({
      periodoSolicitado: ctx.competencia,
      deteccao: { competencia: ctx.competencia, multiplasCompetencias: false, dataMin: null, dataMax: null },
    }),
    detailedRows: consolidado.detailedRows,
    unmatchedIds: consolidado.unmatchedIds,
    unmatchedCosts: [],
    ignoredRowsWithoutCost: consolidado.ignoredRowsWithoutCost,
    ignoredRevenue: consolidado.ignoredRevenue,
    emptySales: consolidado.emptySales,
    message: consolidado.message,
    costsSource: "base",
    costsBase: await buscarCostsBase(imp, deps),
    sync,
    runEmAndamento: await buscarRunEmAndamento(ctx, deps),
    // Planilha em Excel não é gerada pela API; o front monta o que precisar.
    excelBase64: null,
  };
}

module.exports = {
  obterStatusFechamentoViaApi,
  gerarFechamentoViaApi,
  consolidarFechamentoApi,
  parseAjustesFechamentoApi,
  resolverContextoFechamentoApi,
  selecionarImportVigente,
  montarSync,
  hojeSaoPaulo,
  financeiroCompleto,
  AVISO_FINANCEIRO_PENDENTE,
};
