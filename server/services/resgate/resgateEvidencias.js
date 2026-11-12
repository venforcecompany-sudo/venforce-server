// server/services/resgate/resgateEvidencias.js
//
// VenForce Resgate — ORDEM e CONFIABILIDADE das evidências de frete, num lugar
// só, para todas as contas. NÃO é um segundo cotador: o valor do frete sai
// sempre de `shared/marketplaceCurrentQuoteService.buscarComissaoEFrete` (que
// chama `shared/freteCotacaoConfiavel.avaliarFrete`, regras validadas no PR
// #402). Este módulo só DECLARA, de forma testável, o que cada nível vale e
// como ler o que já foi gravado (snapshot) ou cotado agora.
//
// Ordem de precedência para PROJETAR o frete de um anúncio (a primeira fonte
// válida vence; é exatamente a ordem de avaliarFrete):
//   1. cotado_ml                      — shipping_options/free?item_id, quando a
//                                       resposta é confiável (desconto mandatory
//                                       com taxa > 0, ou anúncio sem proximity).
//   2. estimado_dimensoes_historicas  — cotação pelas medidas de ≥2 envios
//                                       recentes (≤ 90 d) concordantes (≥ 60%).
//   3. estimado_custo_cobrado         — mediana do custo cobrado do vendedor em
//                                       ≥3 envios de item único, preço ±3%,
//                                       dispersão ≤ 10%.
//   4. estimado_dimensoes_declaradas  — cotação pelas SELLER_PACKAGE_* do anúncio.
//   5. histórico antigo (> 90 d)      — passos 2/3 com envios antigos (baixa).
//   6. desconhecido                   — nada acima: frete null, margem bloqueada.
// O REALIZADO (frete_seller da Central de Vendas, `shipments_api`) não projeta
// preço: é a régua usada para VALIDAR a projeção da conta (matriz de
// compatibilidade) e para comparar projetado × realizado.
//
// Nunca há constante de frete (R$ 7,75 / 13,85 / 21,75 …): todo valor vem de
// uma resposta do ML ou de um envio real. O teste resgateEvidencias.test.js
// trava isso.

const { NIVEIS, resumoDoFrete } = require("../shared/freteCotacaoConfiavel");
const { LOGISTICA_SEM_FRETE_PREVISTO } = require("../motorMargem/margemCotacaoEmP");

// Grau de confiança do COMPONENTE frete no contrato do Resgate.
const CONFIANCA = Object.freeze({
  ALTA: "alta",
  MEDIA: "media",
  BAIXA: "baixa",
  NAO_VERIFICADA: "nao_verificada", // valor do ML gravado sem a avaliação do PR #402
  NAO_APLICAVEL: "nao_aplicavel",   // frete a combinar: não existe frete previsto
  DESCONHECIDA: "desconhecida",
});

const ORDEM_EVIDENCIA_FRETE = Object.freeze([
  { nivel: NIVEIS.COTADO, confianca: CONFIANCA.ALTA, projeta: true },
  { nivel: NIVEIS.DIMENSOES, confianca: CONFIANCA.MEDIA, projeta: true },
  { nivel: NIVEIS.CUSTO_COBRADO, confianca: CONFIANCA.BAIXA, projeta: true },
  { nivel: NIVEIS.DECLARADAS, confianca: CONFIANCA.MEDIA, projeta: true },
  { nivel: "historico_antigo", confianca: CONFIANCA.BAIXA, projeta: true },
  { nivel: NIVEIS.DESCONHECIDO, confianca: CONFIANCA.DESCONHECIDA, projeta: false },
]);

// Modalidades de logística do anúncio (logistic_type do ML) → família usada
// na matriz de compatibilidade e no relatório. Desconhecida = "outra" (não
// adivinha).
const FAMILIA_LOGISTICA = Object.freeze({
  fulfillment: "full",
  cross_docking: "coleta",
  xd_drop_off: "agencia",
  drop_off: "agencia",
  self_service: "flex",
  default: "outra",
  not_specified: "a_combinar",
  custom: "a_combinar",
});

function familiaLogistica(logisticType) {
  if (logisticType === null || logisticType === undefined || logisticType === "") return "desconhecida";
  return FAMILIA_LOGISTICA[logisticType] || "outra";
}

function freteAplicavel(logisticType) {
  if (logisticType === null || logisticType === undefined) return null;
  return !LOGISTICA_SEM_FRETE_PREVISTO.has(logisticType || "");
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lê o componente frete a partir do que um consumidor tem em mãos:
 *  - `freteQualidade` (objeto gravado no snapshot ou devolvido pela cotação);
 *  - `valor` (frete previsto) e `logisticType`;
 *  - `avaliado`: true quando o valor passou pela avaliação do PR #402 nesta
 *    leitura (cotação forçada do Resgate ou conta liberada).
 * Devolve { valor, nivel, confianca, fonte, motivo, estimado, custosForaDaMargem, avaliadoEm, texto }.
 */
function componenteFrete({ valor = null, freteQualidade = null, logisticType = undefined, motivo = null, observadoEm = null } = {}) {
  const aplicavel = freteAplicavel(logisticType);
  if (aplicavel === false) {
    return {
      valor: null, nivel: "nao_aplicavel", confianca: CONFIANCA.NAO_APLICAVEL, fonte: "logistica_a_combinar",
      motivo: null, estimado: false, custosForaDaMargem: [], avaliadoEm: observadoEm, aplicavel: false,
      texto: "Frete a combinar com o comprador: o Mercado Livre não prevê frete para este anúncio.",
    };
  }
  const r = resumoDoFrete({ fretePrevisto: valor, freteQualidade, motivo });
  const q = freteQualidade && typeof freteQualidade === "object" ? freteQualidade : null;
  let confianca;
  if (r.valor === null) confianca = CONFIANCA.DESCONHECIDA;
  else if (!q) confianca = CONFIANCA.NAO_VERIFICADA;
  else if (q.historicoAntigo) confianca = CONFIANCA.BAIXA;
  else {
    const passo = ORDEM_EVIDENCIA_FRETE.find((x) => x.nivel === q.nivel);
    confianca = (q.confianca === "baixa" ? CONFIANCA.BAIXA : null) || (passo ? passo.confianca : CONFIANCA.DESCONHECIDA);
  }
  return {
    valor: r.valor,
    nivel: q ? q.nivel : (r.valor === null ? NIVEIS.DESCONHECIDO : "cotado_ml_nao_verificado"),
    confianca,
    fonte: r.fonte || (r.valor !== null ? "cotação do ML por anúncio (item_id), sem avaliação de confiabilidade" : null),
    motivo: r.valor === null ? (r.motivo || "frete_ausente") : null,
    estimado: r.estimado,
    custosForaDaMargem: r.custosForaDaMargem,
    avaliadoEm: r.avaliadoEm || observadoEm || null,
    aplicavel,
    modalidade: r.modalidade,
    cotacaoRejeitada: r.cotacaoRejeitada,
    texto: r.texto || (r.valor !== null
      ? "Frete cotado pelo Mercado Livre, ainda NÃO verificado contra as regras de confiabilidade (conta fora da liberação)."
      : "Frete desconhecido."),
  };
}

/**
 * Comparação de UM item: frete projetado × frete realmente cobrado em vendas
 * recentes de item único a preço comparável (±3%). Sem amostra → null.
 * `tolerancia` absoluta em R$ (0,05) e relativa (5%): a maior das duas.
 */
function compararComRealizado({ projetado, realizados = [], preco, toleranciaPreco = 0.03 }) {
  const p = num(projetado), pr = num(preco);
  if (p === null || pr === null || pr <= 0) return null;
  const comparaveis = (realizados || []).filter((r) => {
    const pu = num(r && r.precoUnitario), f = num(r && r.frete);
    return pu !== null && f !== null && Math.abs(pu - pr) <= pr * toleranciaPreco;
  });
  if (!comparaveis.length) return null;
  const fretes = comparaveis.map((r) => Math.abs(num(r.frete))).sort((a, b) => a - b);
  const m = fretes.length % 2 ? fretes[(fretes.length - 1) / 2] : (fretes[fretes.length / 2 - 1] + fretes[fretes.length / 2]) / 2;
  const tol = Math.max(0.05, m * 0.05);
  return {
    amostras: fretes.length,
    medianaRealizada: Math.round(m * 100) / 100,
    diferenca: Math.round((p - m) * 100) / 100,
    bate: Math.abs(p - m) <= tol,
    subestimado: p < m - tol,
    superestimado: p > m + tol,
  };
}

module.exports = {
  CONFIANCA,
  ORDEM_EVIDENCIA_FRETE,
  FAMILIA_LOGISTICA,
  familiaLogistica,
  freteAplicavel,
  componenteFrete,
  compararComRealizado,
};
