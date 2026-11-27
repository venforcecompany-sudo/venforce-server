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

function ultimoDiaDaCompetencia(competencia) {
  const [a, m] = competencia.split("-").map(Number);
  return `${competencia}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`;
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
    resultados.push({ clienteContaId: conta.clienteContaId, performance, consultadoEm: new Date().toISOString() });
  }

  const agregado = agregarPerformances(resultados.map((r) => r.performance));
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
    // Por conta e com a janela consultada (para centralVendasAdsJanela). A soma
    // acima continua sendo o que vai para ads_resumos_mensais, sem mudança.
    porConta: resultados.map((r) => ({
      clienteContaId: r.clienteContaId,
      dateFrom: segmento ? segmento.dateFrom : `${competencia}-01`,
      dateTo: segmento ? segmento.dateTo : ultimoDiaDaCompetencia(competencia),
      investimentoAds: numeroValido(r.performance?.investimentoAds),
      gmvAds: numeroValido(r.performance?.gmvAds),
      consultadoEm: r.consultadoEm,
    })),
  };
}

module.exports = { sincronizarAdsCliente, agregarPerformances };
