// server/services/automacoes/precoItemService.js
// Helper único de resolução/normalização de preço por item ML.
// Usado por diagnosticoService.js e precificacaoService.js para evitar
// lógica duplicada de preço cheio/promocional/efetivo entre diagnóstico e preview.

const { mlFetch } = require("../../utils/mlClient");

function numOuNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Fallback legado: replica o comportamento anterior (preço do anúncio +
// GET /items/{id}/prices) para os casos em que /sale_price falhar. Mantido
// apenas como rede de segurança — não deve ser a fonte primária de preço.
async function resolverPrecosLegado({ clienteId, itemId, precoListaFallback, mlUserId = null, fetchFn = null }) {
  const ler = fetchFn || mlFetch;
  const precoBase = numOuNull(precoListaFallback);
  const precoCheioFallback = precoBase !== null && precoBase > 0 ? precoBase : null;

  let precoDePrices = null;
  try {
    if (itemId) {
      const r = await ler(clienteId, `/items/${encodeURIComponent(itemId)}/prices`, { mlUserId });
      const lista = Array.isArray(r?.data?.prices) ? r.data.prices : [];
      const promoEntry = lista.find((p) => p?.type === "promotion" && numOuNull(p?.amount) > 0);
      const standardEntry = lista.find((p) => p?.type === "standard" && numOuNull(p?.amount) > 0);
      if (promoEntry) {
        precoDePrices = numOuNull(promoEntry.amount);
      } else if (standardEntry) {
        precoDePrices = numOuNull(standardEntry.amount);
      } else {
        const valores = lista.map((p) => numOuNull(p?.amount)).filter((n) => n !== null && n > 0);
        if (valores.length > 0) precoDePrices = Math.min(...valores);
      }
    }
  } catch (_) {
    precoDePrices = null;
  }

  const temPromocao =
    precoDePrices !== null && precoCheioFallback !== null && precoDePrices < precoCheioFallback;

  const precoCheio = precoCheioFallback ?? precoDePrices;
  const precoPromocional = temPromocao ? precoDePrices : null;
  const precoEfetivo = precoPromocional ?? precoCheio;

  return { precoCheio, precoPromocional, precoEfetivo, fonte: "legado_prices" };
}

// Fonte primária: GET /items/{item_id}/sale_price?context=channel_marketplace
// - amount: preço efetivo cobrado (usado em todos os cálculos de lucro/margem).
// - regular_amount: preço cheio/original, presente quando há promoção ativa.
// Promoção só é considerada quando regular_amount > amount; caso contrário
// preço cheio = preço promocional = preço efetivo = amount.
// mlUserId (opcional): a conta ML já resolvida account-aware pelo chamador
// (contextoPrecificacaoService / motorMargem). Sem ele, o token cai no
// principal/fallback do cliente — o mesmo bug de "seller B + token A" que o
// fix de Automações corrigiu. Aditivo: chamador que não passa mantém o
// comportamento legado.
async function resolverPrecosItem({ clienteId, itemId, precoListaFallback = null, mlUserId = null, fetchFn = null }) {
  // `fetchFn` (opcional, VenForce Resgate): leitura injetável — a auditoria usa um
  // fetch SOMENTE GET sem renovação de token. Ausente = mlFetch, como sempre.
  const ler = fetchFn || mlFetch;
  const id = String(itemId || "").trim();
  if (!id) {
    return { precoCheio: null, precoPromocional: null, precoEfetivo: null, fonte: "sem_item_id" };
  }

  try {
    const resp = await ler(clienteId, `/items/${encodeURIComponent(id)}/sale_price?context=channel_marketplace`, { mlUserId });
    if (!resp.ok) throw new Error(`sale_price HTTP ${resp.status}`);

    const amount = numOuNull(resp.data?.amount);
    if (amount === null || amount <= 0) throw new Error("sale_price sem amount válido");

    const regularAmount = numOuNull(resp.data?.regular_amount);
    const temPromocao = regularAmount !== null && regularAmount > amount;

    // Promoção que o ML usa AGORA para formar o preço (metadata.promotion_id
    // — id da oferta, ex. OFFER-MLB…). Aditivo: só quem precisa casar com
    // /seller-promotions (rebate da lista de Anúncios) lê; null = sem promoção.
    const promotionId = resp.data?.metadata?.promotion_id;
    // campaign_id = id da promoção em /seller-promotions (C-…/P-…): é por ele
    // que se casa uma SELLER_CAMPAIGN, cujo ref_id vem nulo na listagem.
    // promotion_type ("campaign"/"custom"/…) é só informativo — não diz quem
    // financia. Aditivos: quem não lê continua idêntico.
    const campaignId = resp.data?.metadata?.campaign_id;
    const promotionType = resp.data?.metadata?.promotion_type;
    return {
      precoCheio: temPromocao ? regularAmount : amount,
      precoPromocional: temPromocao ? amount : null,
      precoEfetivo: amount,
      fonte: "sale_price",
      promotionIdAtivo: promotionId != null ? String(promotionId) : null,
      campaignIdAtivo: campaignId != null ? String(campaignId) : null,
      promotionTypeAtivo: promotionType != null ? String(promotionType) : null,
    };
  } catch (_) {
    // /sale_price indisponível para o item (erro de rede, 4xx/5xx ou payload
    // inesperado) — cai para a lógica legada em vez de deixar o item sem preço.
    return resolverPrecosLegado({ clienteId, itemId: id, precoListaFallback, mlUserId, fetchFn: ler });
  }
}

module.exports = { resolverPrecosItem };
