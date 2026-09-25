// server/services/cliente360/cliente360SyncService.js
// ÚNICO fluxo pesado do Cliente 360. Só chamado pelo POST /sincronizar (admin).
// Consolida métricas (Orders API ao vivo), Ads e fechamentos do mês e grava
// o snapshot em cliente_360_resumos_mensais. Protegido por lock de job.

const repo = require("./cliente360Repository");
const { buscarResumo } = require("../metricasService");
const adsService = require("../adsService");
const { competenciaAtual, parseCompetencia, rangeFromCompetencia } = require("../../utils/periodoUtils");

function criarErroHttp(statusCode, mensagem) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  return err;
}

const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));

// TACoS = ads_investido / faturamento * 100. Null se faltar dado.
function calcularTacos(faturamento, adsInvestido) {
  // Ausência de Ads NUNCA vira TACoS 0. Number(null) === 0 (finito), por isso
  // checamos null/undefined explicitamente antes de qualquer cálculo.
  if (adsInvestido === null || adsInvestido === undefined) return null;
  if (faturamento === null || faturamento === undefined) return null;
  const f = Number(faturamento);
  const a = Number(adsInvestido);
  if (!Number.isFinite(f) || f <= 0) return null;
  if (!Number.isFinite(a)) return null;
  return Math.round((a / f) * 10000) / 100;
}

// Consolida métricas do mês via Orders API (pesado). Pode retornar null
// (cliente sem grant / token inválido / erro de API) sem derrubar o sync.
async function consolidarMetricasMes(clienteId, dateFrom, dateTo, clienteSlug) {
  const res = await buscarResumo({ clienteSlug, dateFrom, dateTo, compare: null });
  if (!res || res.semToken || res.notFound || res.tokenInvalido || res.erroApi || res.multiplasContas) {
    const motivo = res?.tokenInvalido ? "token_invalido" : (res?.multiplasContas ? "multiplas_contas_sem_selecao" : "sem_metricas");
    return { ok: false, motivo, resumo: null, topProdutos: null, porDia: null };
  }
  const r = res.resumo || {};
  // Faturamento por produto: já vem na MESMA resposta (agregarTopProdutos),
  // nenhuma chamada extra à Orders API. Persistido no snapshot para a
  // cobertura da base por faturamento (lida depois sem tocar o ML).
  const topProdutos = Array.isArray(res.topProdutos)
    ? res.topProdutos.map((p) => ({
        mlb: p.itemId || null,
        sku: p.sku || null,
        titulo: p.titulo || null,
        unidades: numOrNull(p.unidades) ?? 0,
        faturamento: numOrNull(p.faturamento) ?? 0,
      }))
    : null;
  // Série diária: também já vem na mesma resposta (agregarPorDia). Persistida
  // no snapshot para o gráfico da Visão Geral respeitar o período salvo,
  // sem chamar Orders API na leitura.
  const porDia = Array.isArray(res.porDia)
    ? res.porDia.map((d) => ({
        data: d.data,
        vendasBrutas: numOrNull(d.vendasBrutas) ?? 0,
        quantidadeVendas: numOrNull(d.quantidadeVendas) ?? 0,
      }))
    : null;
  return {
    ok: true,
    resumo: {
      faturamento: numOrNull(r.vendasBrutas),
      pedidos: numOrNull(r.quantidadeVendas),
      cancelados: numOrNull(r.quantidadeCanceladasAjustada),
    },
    topProdutos,
    porDia,
  };
}

// Consolida Ads do mês a partir de ads_resumos_mensais.
async function consolidarAdsMes(clienteSlug, competencia) {
  try {
    await adsService.ensureAdsResumoTables();
  } catch (_) { /* ignora */ }
  const ads = await adsService.buscarResumoMensalAds({ clienteSlug, mes: competencia, lojaCampanha: "todas" });
  // updatedAt distingue ausencia de linha de um zero real persistido pela API.
  // O status gerencial "sem_dados" tambem pode ocorrer numa linha valida com
  // investimento/GMV exatamente zero e, por isso, nao e usado como sentinela.
  if (!ads || !ads.updatedAt) {
    return { disponivel: false, adsInvestido: null, gmvAds: null, roas: null, faturamentoAds: null, updatedAt: null };
  }
  return {
    disponivel: true,
    adsInvestido: numOrNull(ads.investimentoAds),
    gmvAds: numOrNull(ads.gmvAds),
    roas: numOrNull(ads.roas),
    faturamentoAds: numOrNull(ads.faturamentoTotal),
    updatedAt: ads.updatedAt,
  };
}

// Conta fechamentos do mês a partir das entregas.
async function consolidarFechamentosMes(clienteId, clienteSlug, competencia) {
  const entregas = await repo.findEntregasByCliente(clienteId, clienteSlug, { limit: 200 });
  const mes = String(competencia).split("-")[1] || "";
  return entregas.filter(
    (e) =>
      e.tipo === "fechamento_mensal" &&
      (String(e.periodo || "").includes(competencia) || (mes && String(e.periodo || "").includes(mes)))
  ).length;
}

// Sincroniza o resumo mensal e grava o snapshot.
async function sincronizarResumoMensal(slug, competenciaRaw, userId) {
  await repo.ensureCliente360Tables();

  const cliente = await repo.findClienteBySlug(slug);
  if (!cliente) throw criarErroHttp(404, "Cliente não encontrado.");

  const periodo = competenciaRaw
    ? (parseCompetencia(competenciaRaw) || competenciaAtual())
    : competenciaAtual();
  const { dateFrom, dateTo } = rangeFromCompetencia(periodo.competencia);

  // Lock: evita sync paralelo para o mesmo (cliente, competência).
  const lock = await repo.lockSyncJob(cliente.id, slug, periodo.competencia, "manual", userId);
  if (lock.conflito) {
    const err = criarErroHttp(409, "Sincronização já em andamento para este cliente/competência.");
    err.jobId = lock.conflito.id;
    throw err;
  }
  const jobId = lock.job.id;

  try {
    const [metricas, ads, fechamentosCount, relatorios, diagnosticosCount] = await Promise.all([
      consolidarMetricasMes(cliente.id, dateFrom, dateTo, slug),
      consolidarAdsMes(slug, periodo.competencia),
      consolidarFechamentosMes(cliente.id, slug, periodo.competencia),
      repo.findRelatoriosByCliente(slug, { limit: 1 }),
      repo.countDiagnosticos(slug, periodo.competencia),
    ]);

    const ultimoRel = relatorios[0] || null;
    const faturamento = metricas.ok ? metricas.resumo.faturamento : null;
    const adsInvestido = ads.adsInvestido;
    const tacos = calcularTacos(faturamento, adsInvestido);

    const resumoMes = {
      faturamento,
      mcMedia: ultimoRel ? numOrNull(ultimoRel.mc_media) : null,
      pedidos: metricas.ok ? metricas.resumo.pedidos : null,
      cancelados: metricas.ok ? metricas.resumo.cancelados : null,
      problemas: null,
      adsInvestido,
      tacos,
      fechamentosCount,
      diagnosticosCount,
      itensSemCusto: ultimoRel ? numOrNull(ultimoRel.itens_sem_base) : null,
      itensCriticos: ultimoRel ? numOrNull(ultimoRel.itens_criticos) : null,
      freteConfianca: "sem_amostra",
    };

    const snapshot = await repo.upsertResumoMensal({
      clienteId: cliente.id,
      clienteSlug: slug,
      competencia: periodo.competencia,
      ...resumoMes,
      payloadJson: {
        metricasOk: metricas.ok,
        motivoMetricas: metricas.motivo || null,
        ...(ads.disponivel
          ? {
              ads: {
                investimentoAds: ads.adsInvestido,
                gmvAds: ads.gmvAds,
                roas: ads.roas,
                resumoAtualizadoEm: ads.updatedAt ? new Date(ads.updatedAt).toISOString() : null,
              },
            }
          : {}),
        // Detalhe por produto só quando as métricas vieram OK; ausência da
        // chave = snapshot sem detalhamento (nunca lista vazia inventada).
        ...(metricas.ok && Array.isArray(metricas.topProdutos)
          ? {
              topProdutos: metricas.topProdutos,
              // agregarTopProdutos corta em 50 — lista cheia pode estar truncada.
              topProdutosTruncado: metricas.topProdutos.length >= 50,
              topProdutosEm: new Date().toISOString(),
            }
          : {}),
        // Série diária para o gráfico da Visão Geral (mesma regra: ausência
        // da chave = snapshot antigo sem série, nunca série vazia inventada).
        ...(metricas.ok && Array.isArray(metricas.porDia)
          ? { porDia: metricas.porDia }
          : {}),
      },
    });

    await repo.finalizeSyncJob(jobId, "ok", null, { metricasOk: metricas.ok });

    return {
      ok: true,
      mensagem: metricas.ok
        ? "Sincronização concluída"
        : "Sincronização parcial: cliente sem métricas ML",
      competencia: periodo.competencia,
      resumoMes,
      sincronizadoEm: snapshot.sincronizado_em,
      jobId,
    };
  } catch (err) {
    await repo.finalizeSyncJob(jobId, "erro", err.message, {}).catch(() => {});
    throw err;
  }
}

module.exports = {
  sincronizarResumoMensal,
  consolidarMetricasMes,
  consolidarAdsMes,
  consolidarFechamentosMes,
  calcularTacos,
};
