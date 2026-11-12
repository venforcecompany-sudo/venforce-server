// server/services/motorMargem/margemConfiavel.js
//
// P0 04/11/2026 — UMA regra para "esta margem projetada pode ser exibida,
// ordenada ou usada para decidir?". O núcleo (marginEngine.computeMargin)
// continua assumindo 0 para comissão/frete ausentes e marcando `assumed` —
// isso sustenta o status "Dado suspeito". O que muda é o NÚMERO: com custo do
// marketplace ausente por falha de leitura (ex.: R$ 50 → 46% sem comissão e
// frete), ele não chega à tela, à ordenação, aos KPIs, ao "Você recebe" nem à
// simulação.
//
// Comissão ausente é SEMPRE falha (toda venda no ML paga tarifa). Frete
// ausente só é falha quando o frete se aplica: logística combinável
// (not_specified/custom) não tem frete previsto pelo ML — ausência legítima,
// a margem continua valendo. Aplicabilidade desconhecida (linha antiga, sem
// `freteAplicavel` gravado) NÃO esconde a margem: o status do Motor ("Dado
// suspeito") continua avisando, e o próximo run grava a informação.

const { LOGISTICA_SEM_FRETE_PREVISTO } = require("./margemCotacaoEmP");
const { FIELDS } = require("./core/marginEvidence");

// P0 10/11/2026 — linhas ANTIGAS de uma conta liberada para a correção do frete
// `proximity` (Alianza Jeans 2: conta 87 = seller 2433262404). Uma linha sem
// `quality_json.freteQualidade` (objeto) foi gravada ANTES da avaliação e pode ter
// frete subestimado: enquanto não for recalculada, a margem dela não é confiável.
// Recalculada com frete válido, a linha ganha `freteQualidade` e volta sozinha.
// Escopo EXCLUSIVO: contas listadas em FRETE_LEGADO_BLOQUEAR_CONTAS (ids; sem
// curinga; ausente = nenhuma). Lido na carga do processo (mudar exige restart).
function contasFreteLegadoBloqueado(env = process.env) {
  return String(env.FRETE_LEGADO_BLOQUEAR_CONTAS || "").split(",")
    .map((x) => x.trim()).filter((x) => /^[0-9]+$/.test(x)).map(Number);
}
const CONTAS_FRETE_LEGADO = contasFreteLegadoBloqueado();

/** Linha de conta liberada, gravada antes da avaliação do frete (sem freteQualidade objeto). */
function freteLegadoNaoVerificado({ clienteContaId, freteQualidade }, contas = CONTAS_FRETE_LEGADO) {
  if (!contas.includes(Number(clienteContaId))) return false;
  return !(freteQualidade && typeof freteQualidade === "object");
}

/**
 * A mesma regra em SQL, para quem lê `margin_projection_snapshots` direto
 * (ranking de Promoções). `alias` = alias da tabela. Sem contas: FALSE.
 */
function sqlFreteLegadoNaoVerificado(alias, contas = CONTAS_FRETE_LEGADO) {
  if (!contas.length) return "FALSE";
  return `(${alias}.cliente_conta_id IN (${contas.join(",")}) AND COALESCE(jsonb_typeof(${alias}.quality_json->'freteQualidade'), '') <> 'object')`;
}

/** true/false pela logística do anúncio; null quando a logística é desconhecida. */
function freteAplicavelDaLogistica(logisticType) {
  if (logisticType === undefined) return null;
  return !LOGISTICA_SEM_FRETE_PREVISTO.has(logisticType || "");
}

/** Pela lista `assumed` do núcleo (variáveis que entraram como 0). */
function custoMarketplaceAusente({ assumed = [], freteAplicavel = null } = {}) {
  const a = Array.isArray(assumed) ? assumed : [];
  if (a.includes(FIELDS.COMMISSION)) return true;
  return a.includes(FIELDS.FREIGHT) && freteAplicavel === true;
}

/** Pelos VALORES (simulação / "Você recebe"): comissão/frete null = ausente. */
function custoMarketplaceAusenteNosValores({ commission = null, freight = null, freteAplicavel = null } = {}) {
  if (commission === null || commission === undefined) return true;
  return (freight === null || freight === undefined) && freteAplicavel !== false;
}

/** Item ao vivo do Motor (buildMarginItem + diagnostico do enrichBatch). */
function margemProjetadaIncompleta(item) {
  if (!item || !item.margin || !item.margin.projected) return false;
  const diag = item.diagnostico || {};
  return custoMarketplaceAusente({
    assumed: item.margin.projected.assumed || [],
    freteAplicavel: freteAplicavelDaLogistica(diag.logisticType === undefined ? undefined : diag.logisticType),
  });
}

/**
 * Devolve o item com a margem PROJETADA neutralizada quando comissão/frete do
 * ML estão ausentes: margin/profit/marginPercent null, computable false,
 * `incompleta: true` — o `assumed` e o status do núcleo ("Dado suspeito")
 * ficam. Aplicada no enrichBatch: todo consumidor AO VIVO (Central — lista,
 * resumo, médias, exceções —, Anúncios, Cliente 360, Precificação) recebe o
 * item já seguro, em vez de cada um lembrar de checar.
 */
function neutralizarMargemIncompleta(item) {
  if (!margemProjetadaIncompleta(item)) return item;
  const p = item.margin.projected;
  const projected = {
    ...p, computable: false, margin: null, profit: null, marginPercent: null,
    incompleta: true, motivoIncompleta: MOTIVO_MARGEM_INCOMPLETA,
  };
  const margin = { ...item.margin, projected };
  // Erro de projeção (projetada × realizada) não existe sem a projetada.
  // Mantém o FORMATO (consumidores leem `.comparable`/`.deltaPp`).
  if (margin.projectionError && typeof margin.projectionError === "object") {
    margin.projectionError = { ...margin.projectionError, comparable: false, deltaPp: null, deltaRelative: null, motivo: MOTIVO_MARGEM_INCOMPLETA };
  }
  const saida = { ...item, margin };
  // Contrato projetada × realizada (Central: bloco de desvio). Mesmo efeito de
  // buildProjectedVsRealized com a projetada NÃO computável: status
  // PROJECTED_NOT_COMPUTABLE (se era comparável), sem lucro/margem projetados e
  // sem desvio de lucro/margem. Componentes e realizado ficam intactos.
  const pvr = item.projectedVsRealized;
  if (pvr && typeof pvr === "object") {
    saida.projectedVsRealized = {
      ...pvr,
      status: pvr.status === "COMPARABLE" ? "PROJECTED_NOT_COMPUTABLE" : pvr.status,
      projected: pvr.projected
        ? { ...pvr.projected, profit: null, margin: null, marginPercent: null, computable: false, incompleta: true }
        : pvr.projected,
      drift: pvr.drift ? { ...pvr.drift, profit: null, marginPercentagePoints: null } : pvr.drift,
    };
  }
  return saida;
}

// A mesma regra em SQL, sobre margin_projection_snapshots (assumed_json é
// sempre um array JSONB; quality_json.freteAplicavel gravado pelo processor).
const SQL_CUSTO_MARKETPLACE_AUSENTE =
  "(assumed_json ? 'commission' OR (assumed_json ? 'freight' AND COALESCE(quality_json->>'freteAplicavel' = 'true', false))" +
  (CONTAS_FRETE_LEGADO.length
    ? ` OR (cliente_conta_id IN (${CONTAS_FRETE_LEGADO.join(",")}) AND COALESCE(jsonb_typeof(quality_json->'freteQualidade'), '') <> 'object')`
    : "") + ")";

const MOTIVO_MARGEM_INCOMPLETA = "comissao_ou_frete_ausente";
const NOTA_MARGEM_INCOMPLETA =
  "Comissão e/ou frete do Mercado Livre não foram obtidos: margem não exibida até um recálculo completo.";

module.exports = {
  freteAplicavelDaLogistica,
  freteLegadoNaoVerificado,
  sqlFreteLegadoNaoVerificado,
  contasFreteLegadoBloqueado,
  custoMarketplaceAusente,
  custoMarketplaceAusenteNosValores,
  margemProjetadaIncompleta,
  neutralizarMargemIncompleta,
  SQL_CUSTO_MARKETPLACE_AUSENTE,
  MOTIVO_MARGEM_INCOMPLETA,
  NOTA_MARGEM_INCOMPLETA,
};
