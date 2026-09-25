// Sincronismo mensal de Mercado Ads acoplado a rodada noturna da Central de
// Vendas. Reutiliza a integracao ao vivo e a tabela mensal existentes; a
// unidade persistida continua sendo cliente + competencia + "todas".

const mlAdsService = require("../ads/mlAdsService");
const adsService = require("../adsService");

function numeroValido(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function agregarPerformances(performances) {
  let investimentoAds = 0;
  let gmvAds = 0;
  for (const performance of performances) {
    const investimento = numeroValido(performance?.investimentoAds);
    const gmv = numeroValido(performance?.gmvAds);
    if (investimento === null || gmv === null) {
      const err = new Error("Mercado Ads retornou metricas invalidas.");
      err.code = "ADS_METRICAS_INVALIDAS";
      throw err;
    }
    investimentoAds += investimento;
    gmvAds += gmv;
  }
  investimentoAds = round2(investimentoAds);
  gmvAds = round2(gmvAds);
  return {
    investimentoAds,
    gmvAds,
    roas: investimentoAds > 0 ? round2(gmvAds / investimentoAds) : 0,
  };
}

function defaultDeps() {
  return {
    buscarPerformanceML: mlAdsService.buscarPerformanceML,
    ensureAdsResumoTables: adsService.ensureAdsResumoTables,
    salvarResumoMensalAds: adsService.salvarResumoMensalAds,
  };
}

async function sincronizarAdsCliente({ cliente, competencia, contas, segmento }, depsOverride = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  const resultados = [];

  // Deliberadamente sequencial dentro do cliente: a concorrencia entre
  // clientes ja e limitada pelo orquestrador, sem rajada adicional na API.
  for (const conta of contas) {
    let performance;
    try {
      performance = await deps.buscarPerformanceML(
        cliente.slug,
        competencia,
        segmento ? { from: segmento.dateFrom, to: segmento.dateTo } : null,
        conta.clienteContaId
      );
    } catch (err) {
      err.clienteContaId = conta.clienteContaId;
      throw err;
    }
    if (!performance || performance.semDados) {
      const err = new Error(performance?.motivo || "Mercado Ads sem dados para a conta.");
      err.code = performance?.codigo || "ADS_SEM_DADOS";
      err.clienteContaId = conta.clienteContaId;
      throw err;
    }
    resultados.push(performance);
  }

  const agregado = agregarPerformances(resultados);
  await deps.ensureAdsResumoTables();
  const resumo = await deps.salvarResumoMensalAds({
    clienteSlug: cliente.slug,
    mes: competencia,
    lojaCampanha: "todas",
    dados: agregado,
    userId: null,
    somentePerformance: true,
  });

  return {
    atualizado: true,
    contas: contas.length,
    investimentoAds: agregado.investimentoAds,
    gmvAds: agregado.gmvAds,
    roas: agregado.roas,
    updatedAt: resumo?.updatedAt || null,
  };
}

module.exports = { sincronizarAdsCliente, agregarPerformances };
