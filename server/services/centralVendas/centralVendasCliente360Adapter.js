// server/services/centralVendas/centralVendasCliente360Adapter.js
// Central de Vendas → snapshot mensal do Cliente 360 (cliente_360_resumos_mensais),
// que é a tabela lida pelo Painel de Contas.
//
// Auditoria Sync Noturno §16/§20/§21: a Central é a ÚNICA ingestão externa.
// Este adaptador só traduz o que a Central JÁ persistiu (imports PUBLISHED +
// pedidos/itens) para o contrato do snapshot. Ele NUNCA:
//   - chama a Orders API (nem mlFetch, nem metricasService.buscarResumo);
//   - chama endpoint HTTP interno;
//   - dispara sincronização.
//
// FAT/LC/MC vêm do cálculo oficial da Central (buildResumoCentralVendas, o
// mesmo que produziu resumo_json de cada import) — sem segunda matemática. Com
// 2+ contas ML no mesmo cliente, o snapshot (que é por cliente) é a soma das
// contas: FAT/faturamentoComCusto/MC são recalculados pelo MESMO
// buildResumoCentralVendas sobre a união dos pedidos persistidos, e o LC é a
// soma dos LCs já calculados por conta (null só se nenhuma conta tiver LC —
// a mesma regra do motor).
//
// Honestidade do snapshot:
//   - só reconstrói quando TODAS as contas informadas têm import PUBLISHED
//     cobrindo o período; faltando uma conta, o snapshot anterior fica
//     intacto (somar só as contas que deram certo esconderia faturamento);
//   - nunca sobrescreve um snapshot gravado DEPOIS da publicação dos imports
//     usados (proteção de ordem — Auditoria §30);
//   - `sincronizado_em` só muda quando o upsert acontece de fato;
//   - Ads continua vindo de ads_resumos_mensais (consolidarAdsMes): ausente
//     vira null, nunca 0 — este adaptador não atualiza Ads.
//
// Precedência de MC (Auditoria §18): o fechamento oficial DAQUELE MÊS vence a
// Central — um número revisado por humano nunca é sobrescrito por um número
// automático. "Fechamento oficial" = entregas_cliente tipo fechamento_mensal
// PUBLICADO da competência, cujo payload (gravado pela tela de Fechamento,
// Portal/financeiro.js) traz snapshot.metricasDerivadas.mcCalculada = LC /
// receita com custo (fração) — a MESMA definição do MC da Central. A escolha
// da entrega reaproveita selecionarFechamentoDoPeriodo (financeiroVisaoService:
// conta > publicada > mais recente > id). Só se aplica quando o escopo bate:
// cliente com UMA conta ML elegível e entrega dessa conta (ou sem conta
// registrada). Com 2+ contas, um fechamento por conta não representa o total
// do cliente, então o MC é o da Central (motivo registrado no payload).
// `relatorios.mc_media` (usado pelo fluxo manual) NÃO é fechamento: é o
// relatório do scanner de anúncios, sem competência. itensSemCusto/
// itensCriticos continuam vindo dele, exatamente como no fluxo manual (§20).
//
// Escala de mc_media: FRAÇÃO (0.1834 = 18,34%). Os leitores do snapshot
// (painelContasMetricas.normalizarMcFracao, cliente360DiagnosticoEngine
// .mcParaPercent) tratam |v| <= 1 como fração — gravar percentual faria uma
// MC real de 0,8% ser lida como 80%.

const pool = require("../../config/database");
const { buildResumoCentralVendas } = require("./centralVendasImportService");
const { normalizePedidoStatus, pedidoEntraNoResultado } = require("./centralVendasService");

const TOP_PRODUTOS_LIMITE = 50;
const LOCK_TIPO = "central_vendas_noturno";

function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function numOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function asJsonObject(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch (_) { return {}; }
  }
  return value;
}

function defaultDeps() {
  const centralRepo = require("./centralVendasRepository");
  const c360Repo = require("../cliente360/cliente360Repository");
  // Só as consolidações que já leem o BANCO (ads_resumos_mensais, entregas).
  // consolidarMetricasMes (Orders API) nunca é chamada daqui.
  const c360Sync = require("../cliente360/cliente360SyncService");
  return {
    db: pool,
    resolveImportsForRange: centralRepo.resolveImportsForRange,
    ensureCliente360Tables: c360Repo.ensureCliente360Tables,
    findResumoMensal: c360Repo.findResumoMensal,
    upsertResumoMensal: c360Repo.upsertResumoMensal,
    lockSyncJob: c360Repo.lockSyncJob,
    finalizeSyncJob: c360Repo.finalizeSyncJob,
    findRelatoriosByCliente: c360Repo.findRelatoriosByCliente,
    countDiagnosticos: c360Repo.countDiagnosticos,
    consolidarAdsMes: c360Sync.consolidarAdsMes,
    consolidarFechamentosMes: c360Sync.consolidarFechamentosMes,
    calcularTacos: c360Sync.calcularTacos,
    listarFechamentosPublicados,
    selecionarFechamentoDoPeriodo: require("../financeiroVisaoService").selecionarFechamentoDoPeriodo,
  };
}

// Fechamentos mensais PUBLICADOS do cliente — só o MC calculado sai do
// payload (nada do resto da estrutura livre da entrega).
async function listarFechamentosPublicados(clienteId, clienteSlug, db = pool) {
  const { rows } = await db.query(
    `SELECT id, periodo, status, publicado, cliente_conta_id, created_at, published_at,
            payload_json->'snapshot'->'metricasDerivadas'->>'mcCalculada' AS mc_calculada
       FROM entregas_cliente
      WHERE (cliente_id = $1 OR cliente_slug = $2)
        AND tipo = 'fechamento_mensal'
        AND (publicado = true OR status = 'publicado')`,
    [clienteId, clienteSlug]
  );
  return rows;
}

// Decide a fonte do MC (ver "Precedência de MC" no topo). Devolve sempre a
// fonte usada e, quando o fechamento não se aplica, por quê.
async function resolverMcComPrecedencia({ cliente, competencia, contas, mcCentralFracao }, deps) {
  if (contas.length !== 1) {
    return { mcMedia: mcCentralFracao, fonte: "central_vendas", motivo: "MULTIPLAS_CONTAS" };
  }
  const contaId = contas[0].clienteContaId;
  const publicados = (await deps.listarFechamentosPublicados(cliente.id, cliente.slug, deps.db))
    .filter((e) => e.cliente_conta_id == null || Number(e.cliente_conta_id) === Number(contaId));
  const { entrega } = deps.selecionarFechamentoDoPeriodo(publicados, competencia, contaId);
  const mc = entrega ? numOrNull(entrega.mc_calculada) : null;
  if (!entrega) return { mcMedia: mcCentralFracao, fonte: "central_vendas", motivo: "SEM_FECHAMENTO_PUBLICADO" };
  if (mc === null) {
    return { mcMedia: mcCentralFracao, fonte: "central_vendas", motivo: "FECHAMENTO_SEM_MC", fechamentoEntregaId: Number(entrega.id) };
  }
  return { mcMedia: Math.round(mc * 1e6) / 1e6, fonte: "fechamento_oficial", motivo: null, fechamentoEntregaId: Number(entrega.id) };
}

// Leitura enxuta dos pedidos/itens dos imports escolhidos — só as colunas que
// o snapshot usa (nada de payload_json por pedido).
async function carregarPedidosEItens(importIds, db) {
  const pedidosResult = await db.query(
    `SELECT id, import_id, data_pedido, status, confianca, faturamento
       FROM central_vendas_pedidos
      WHERE import_id = ANY($1::bigint[])`,
    [importIds]
  );
  const itensResult = await db.query(
    `SELECT pedido_row_id, mlb, sku, titulo, quantidade, receita_produto
       FROM central_vendas_pedido_itens
      WHERE import_id = ANY($1::bigint[])`,
    [importIds]
  );
  return { pedidos: pedidosResult.rows, itens: itensResult.rows };
}

// Série diária no MESMO formato que o fluxo manual grava (payload_json.porDia:
// [{data, vendasBrutas, quantidadeVendas}]) — só pedidos que entram no
// resultado, para a soma da série bater com o FAT do snapshot.
function montarPorDia(pedidosValidos) {
  const porData = new Map();
  for (const p of pedidosValidos) {
    const data = isoDate(p.data_pedido);
    if (!data) continue;
    const dia = porData.get(data) || { data, vendasBrutas: 0, quantidadeVendas: 0 };
    dia.vendasBrutas += Number(p.faturamento || 0);
    dia.quantidadeVendas += 1;
    porData.set(data, dia);
  }
  return [...porData.values()]
    .sort((a, b) => a.data.localeCompare(b.data))
    .map((d) => ({ ...d, vendasBrutas: round2(d.vendasBrutas) }));
}

// Mesmo contrato de payload_json.topProdutos do fluxo manual
// ({mlb, sku, titulo, unidades, faturamento}), lido de central_vendas_pedido_itens
// (receita_produto) dos pedidos que entram no resultado.
function montarTopProdutos(itens, pedidoRowIdsValidos) {
  const porMlb = new Map();
  for (const item of itens) {
    if (!pedidoRowIdsValidos.has(String(item.pedido_row_id))) continue;
    const mlb = item.mlb || null;
    const chave = mlb || "desconhecido";
    const acc = porMlb.get(chave) || { mlb, sku: item.sku || null, titulo: item.titulo || null, unidades: 0, faturamento: 0 };
    acc.unidades += Number(item.quantidade || 0);
    acc.faturamento += Number(item.receita_produto || 0);
    porMlb.set(chave, acc);
  }
  const todos = [...porMlb.values()]
    .map((p) => ({ ...p, faturamento: round2(p.faturamento) }))
    .sort((a, b) => b.faturamento - a.faturamento);
  return { topProdutos: todos.slice(0, TOP_PRODUTOS_LIMITE), truncado: todos.length > TOP_PRODUTOS_LIMITE };
}

function somarLcNullAware(resumos) {
  const valores = resumos.map((r) => numOrNull(r.lucroContribuicao)).filter((v) => v !== null);
  return valores.length ? round2(valores.reduce((s, v) => s + v, 0)) : null;
}

// Consolida FAT/LC/MC + contagens a partir do que já está persistido.
// Exportada para teste direto (sem banco).
function consolidarCentral({ imports, pedidos, itens }) {
  const resumosImports = imports.map((imp) => asJsonObject(imp.resumo_json));
  const lucroContribuicao = somarLcNullAware(resumosImports);
  const resumo = buildResumoCentralVendas({ pedidos, resumo: { lucroContribuicao } });

  const pedidosValidos = pedidos.filter(pedidoEntraNoResultado);
  const cancelados = pedidos.filter((p) => normalizePedidoStatus(p.status) === "cancelado").length;
  const pedidoRowIdsValidos = new Set(pedidosValidos.map((p) => String(p.id)));
  const { topProdutos, truncado } = montarTopProdutos(itens, pedidoRowIdsValidos);

  return {
    faturamento: resumo.faturamento,
    faturamentoComCusto: resumo.faturamentoComCusto,
    receitaBloqueada: resumo.receitaBloqueada,
    lucroContribuicao: resumo.lucroContribuicao,
    margemContribuicaoPercentual: resumo.margemContribuicaoPercentual,
    confianca: resumo.confianca,
    pedidos: pedidosValidos.length,
    cancelados,
    porDia: montarPorDia(pedidosValidos),
    topProdutos,
    topProdutosTruncado: truncado,
  };
}

// Para cada conta, o import PUBLISHED da competência que cobre o segmento —
// mesma regra de seleção M4 da leitura da Central (resolveImportsForRange),
// nunca uma segunda implementação. `legacy` não conta: não tem cobertura
// comprovada, e o snapshot só nasce de dado publicado.
async function selecionarImportsDasContas({ clienteSlug, competencia, contas, segmento }, deps) {
  const escolhidos = [];
  const faltando = [];
  for (const conta of contas) {
    const { imports } = await deps.resolveImportsForRange({
      clienteSlug,
      dateFrom: segmento.dateFrom,
      dateTo: segmento.dateTo,
      marketplace: "meli",
      clienteContaId: conta.clienteContaId,
      includeLegacy: false,
    }, deps.db);
    const imp = (imports || []).find((row) => row.competencia === competencia && row.publication_status === "published");
    if (imp) escolhidos.push({ conta, imp });
    else faltando.push(conta.clienteContaId);
  }
  return { escolhidos, faltando };
}

/**
 * Reconstrói o snapshot mensal de UM cliente/competência a partir da Central.
 *
 * @param {object} p
 * @param {{id:number, slug:string}} p.cliente
 * @param {string} p.competencia   YYYY-MM
 * @param {Array<{clienteContaId:number}>} p.contas  todas as contas ML elegíveis do cliente
 * @param {{dateFrom:string, dateTo:string}} p.segmento  trecho da competência que precisa estar coberto
 * @returns {Promise<{atualizado:boolean, motivo:string|null, sincronizadoEm?:string, detalhe?:object}>}
 */
async function reconstruirSnapshotMensal({ cliente, competencia, contas, segmento, origem = "cron-central" }, depsOverride = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  if (!Array.isArray(contas) || !contas.length) {
    return { atualizado: false, motivo: "SEM_CONTAS" };
  }

  const { escolhidos, faltando } = await selecionarImportsDasContas(
    { clienteSlug: cliente.slug, competencia, contas, segmento }, deps
  );
  if (faltando.length) {
    return { atualizado: false, motivo: "CONTA_SEM_IMPORT_PUBLICADO", detalhe: { contasSemPublicacao: faltando } };
  }

  const imports = escolhidos.map((e) => e.imp);
  const publishedMax = imports
    .map((imp) => (imp.published_at ? new Date(imp.published_at).getTime() : 0))
    .reduce((a, b) => Math.max(a, b), 0);

  await deps.ensureCliente360Tables();

  // Ads e vendas formam juntos a versao do snapshot. Ler o resumo antes da
  // guarda de frescor evita ignorar um Ads recem-atualizado so porque os
  // imports de vendas ja tinham sido incorporados anteriormente.
  const ads = await deps.consolidarAdsMes(cliente.slug, competencia);
  const adsUpdatedAt = ads?.updatedAt ? new Date(ads.updatedAt).getTime() : 0;
  const fontesMax = Math.max(publishedMax, Number.isFinite(adsUpdatedAt) ? adsUpdatedAt : 0);

  // Proteção de ordem: um snapshot gravado depois da publicação mais recente
  // dos imports E do resumo Ads usados já é igual ou mais novo — não regrava
  // e, portanto, não mexe em sincronizado_em.
  const existente = await deps.findResumoMensal(cliente.id, competencia);
  if (existente?.sincronizado_em && new Date(existente.sincronizado_em).getTime() >= fontesMax) {
    return { atualizado: false, motivo: "SNAPSHOT_JA_ATUALIZADO", detalhe: { sincronizadoEm: existente.sincronizado_em } };
  }

  // Mesmo lock do sync manual do Cliente 360 (cliente, competência) — nunca
  // um lock paralelo.
  const lock = await deps.lockSyncJob(cliente.id, cliente.slug, competencia, LOCK_TIPO, null);
  if (lock.conflito) {
    return { atualizado: false, motivo: "SYNC_CLIENTE360_EM_ANDAMENTO", detalhe: { jobId: lock.conflito.id } };
  }
  const jobId = lock.job.id;

  try {
    const importIds = imports.map((imp) => Number(imp.id));
    const { pedidos, itens } = await carregarPedidosEItens(importIds, deps.db);
    const central = consolidarCentral({ imports, pedidos, itens });

    const [fechamentosCount, relatorios, diagnosticosCount] = await Promise.all([
      deps.consolidarFechamentosMes(cliente.id, cliente.slug, competencia),
      deps.findRelatoriosByCliente(cliente.slug, { limit: 1 }),
      deps.countDiagnosticos(cliente.slug, competencia),
    ]);
    const ultimoRel = relatorios?.[0] || null;
    const adsInvestido = ads?.adsInvestido ?? null;

    const mcCentralFracao = central.margemContribuicaoPercentual === null
      ? null
      : Math.round((central.margemContribuicaoPercentual / 100) * 1e6) / 1e6;
    const mc = await resolverMcComPrecedencia({ cliente, competencia, contas, mcCentralFracao }, deps);
    const mcMedia = mc.mcMedia;

    const dadosAte = escolhidos
      .map((e) => isoDate(e.imp.coverage_date_to))
      .filter(Boolean)
      .sort()[0] || null;

    const snapshot = await deps.upsertResumoMensal({
      clienteId: cliente.id,
      clienteSlug: cliente.slug,
      competencia,
      faturamento: central.faturamento,
      mcMedia,
      pedidos: central.pedidos,
      cancelados: central.cancelados,
      problemas: null,
      adsInvestido,
      tacos: deps.calcularTacos(central.faturamento, adsInvestido),
      fechamentosCount,
      diagnosticosCount,
      itensSemCusto: ultimoRel ? numOrNull(ultimoRel.itens_sem_base) : null,
      itensCriticos: ultimoRel ? numOrNull(ultimoRel.itens_criticos) : null,
      freteConfianca: "sem_amostra",
      payloadJson: {
        metricasOk: true,
        motivoMetricas: null,
        fonte: "central_vendas",
        topProdutos: central.topProdutos,
        topProdutosTruncado: central.topProdutosTruncado,
        topProdutosEm: new Date().toISOString(),
        porDia: central.porDia,
        ...(ads?.disponivel
          ? {
              ads: {
                investimentoAds: ads.adsInvestido,
                gmvAds: ads.gmvAds,
                roas: ads.roas,
                resumoAtualizadoEm: ads.updatedAt ? new Date(ads.updatedAt).toISOString() : null,
              },
            }
          : {}),
        centralVendas: {
          origem,
          dadosAte,
          faturamentoComCusto: central.faturamentoComCusto,
          receitaBloqueada: central.receitaBloqueada,
          lucroContribuicao: central.lucroContribuicao,
          margemContribuicaoPercentual: central.margemContribuicaoPercentual,
          confianca: central.confianca,
          mcFonte: mc.fonte,
          mcPrecedenciaMotivo: mc.motivo,
          fechamentoEntregaId: mc.fechamentoEntregaId ?? null,
          contas: escolhidos.map(({ conta, imp }) => ({
            clienteContaId: conta.clienteContaId,
            importId: Number(imp.id),
            syncRunId: imp.sync_run_id != null ? Number(imp.sync_run_id) : null,
            publishedAt: imp.published_at ? new Date(imp.published_at).toISOString() : null,
            coverageDateFrom: isoDate(imp.coverage_date_from),
            coverageDateTo: isoDate(imp.coverage_date_to),
          })),
        },
      },
    });

    await deps.finalizeSyncJob(jobId, "ok", null, { fonte: "central_vendas", importIds });

    return {
      atualizado: true,
      motivo: null,
      sincronizadoEm: snapshot?.sincronizado_em || null,
      detalhe: {
        importIds,
        faturamento: central.faturamento,
        lucroContribuicao: central.lucroContribuicao,
        margemContribuicaoPercentual: central.margemContribuicaoPercentual,
        mcMedia,
        mcFonte: mc.fonte,
        dadosAte,
      },
    };
  } catch (err) {
    await Promise.resolve(deps.finalizeSyncJob(jobId, "erro", err?.message, { fonte: "central_vendas" })).catch(() => {});
    throw err;
  }
}

module.exports = {
  reconstruirSnapshotMensal,
  consolidarCentral,
  montarPorDia,
  montarTopProdutos,
  resolverMcComPrecedencia,
  LOCK_TIPO,
};
