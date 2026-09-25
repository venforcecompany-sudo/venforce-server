// server/services/painelContas/painelContasMetricas.js
// Derivação PURA dos números do Painel de Contas por Squad a partir do
// snapshot batch de cliente_360_resumos_mensais.
// Nenhuma query aqui — só matemática, testável sem banco (Auditoria §7/§8/§9).
//
// Snapshots da Central de Vendas carregam o LC oficial no payload. FAT * MC
// permanece apenas como fallback para snapshots legados sem esse campo.
//
// mc_media tem escala ambígua na base real — alguns registros a gravam como
// fração (0.18) e outros como percentual (18), a mesma ambiguidade que
// cliente360DiagnosticoEngine.mcParaPercent já precisa normalizar no sentido
// inverso. normalizarMcFracao() aplica a MESMA heurística (|valor| > 1 é
// percentual, então divide por 100) para nunca deixar essa ambiguidade
// vazar como um LC 100x errado.
//
// TACoS NUNCA é lido da coluna `tacos` persistida em cliente_360_resumos_mensais:
// ela é gravada por cliente360SyncService.calcularTacos em escala 0-100
// (percentual), incompatível com a fração 0-1 que o motor oficial
// (cliente360AdsService.calcularTacos) usa em produção e que esta auditoria
// adota como contrato (Auditoria §12/§19). Por isso é recalculado aqui, a
// partir de ads_investido/faturamento, reaproveitando a função oficial.
const { calcularTacos } = require("../cliente360/cliente360AdsService");

function asFiniteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : null;
}

function normalizarMcFracao(valor) {
  const n = asFiniteOrNull(valor);
  if (n === null) return null;
  return Math.abs(n) > 1 ? n / 100 : n;
}

// ACOS = investimento_ads / gmv_ads. Mesma convenção de fração de MC/TACoS
// (nunca escala 0-100 aqui). null se gmv_ads ausente ou <= 0 — nunca 0
// fabricado (Auditoria §9).
function calcularAcos(investimentoAds, gmvAds) {
  const ads = asFiniteOrNull(investimentoAds);
  const gmv = asFiniteOrNull(gmvAds);
  if (ads === null || gmv === null || gmv <= 0) return null;
  return ads / gmv;
}

// Deriva o bloco `resumo` de um cliente/competência a partir de UMA linha já
// lida em lote de cliente_360_resumos_mensais.
// com/atv/nps: sempre null nesta fase — GAP DE PRODUTO documentado (§10),
// nunca inventado.
function deriveResumo({
  faturamento, mcMedia, adsInvestido, gmvAds,
  lucroContribuicao, lucroContribuicaoPresente = false,
} = {}) {
  const fat = asFiniteOrNull(faturamento);
  const mc = normalizarMcFracao(mcMedia);
  const ads = asFiniteOrNull(adsInvestido);
  const lcCentral = asFiniteOrNull(lucroContribuicao);
  const lc = lucroContribuicaoPresente
    ? round2(lcCentral)
    : (fat !== null && mc !== null ? round2(fat * mc) : null);
  const tacos = calcularTacos(ads, fat);
  const acos = calcularAcos(ads, gmvAds);
  return {
    fat, lc, mc, ads, acos, tacos,
    com: null, atv: null, nps: null,
  };
}

module.exports = {
  asFiniteOrNull,
  round2,
  normalizarMcFracao,
  calcularAcos,
  deriveResumo,
};
