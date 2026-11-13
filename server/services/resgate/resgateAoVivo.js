// server/services/resgate/resgateAoVivo.js
//
// Leitura AO VIVO de um anúncio para o Resgate — SOMENTE GET, por construção:
//  · criarFetchSomenteLeitura recusa qualquer método ≠ GET e qualquer corpo;
//  · opcionalmente sem renovação de token (`noRefresh`) — obrigatório quando a
//    auditoria roda FORA do servidor (o processo local não pode renovar o
//    grant de produção: isso escreveria no banco e invalidaria o refresh token
//    do servidor);
//  · espaçamento + pausa global após 429 (Retry-After), reaproveitando o
//    limiter do Margin Snapshot; falhas parciais viram motivo, não exceção.
// Preço/comissão/frete saem do cotador compartilhado com `avaliarFreteSempre`.

const { mlFetch: mlFetchPadrao } = require("../../utils/mlClient");
const { buscarComissaoEFrete } = require("../shared/marketplaceCurrentQuoteService");
const { resolverPrecosItem } = require("../automacoes/precoItemService");
const { normalizarPromocoesDoItem } = require("../promoSnapshot/promoSnapshotNormalize");
const { createRateLimiter } = require("../motorMargem/marginSnapshotRateLimiter");
const { classificarFinanciamento, iniciadasDaResposta } = require("./resgatePromocaoFinanciamento");

class EscritaBloqueadaError extends Error {
  constructor(metodo, path) {
    super(`VenForce Resgate é somente leitura: ${metodo} ${String(path).split("?")[0]} recusado.`);
    this.name = "EscritaBloqueadaError";
    this.code = "RESGATE_SOMENTE_LEITURA";
  }
}

function esperarMs(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(Object.assign(new Error("cancelado"), { code: "RESGATE_CANCELADO" }));
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("cancelado"), { code: "RESGATE_CANCELADO" })); }, { once: true });
  });
}

/**
 * @param {object} o
 *  fetchFn       mlFetch (ou fake em teste)
 *  noRefresh     true = nunca renovar token
 *  minIntervalMs espaçamento mínimo entre chamadas do processo
 *  max429        tentativas após 429
 *  signal        AbortSignal (cancelamento)
 */
function criarFetchSomenteLeitura({ fetchFn = mlFetchPadrao, noRefresh = false, minIntervalMs = 120, max429 = 3, signal = null, sleep = esperarMs, limiter = null } = {}) {
  const lim = limiter || createRateLimiter({ minIntervalMs, sleep: (ms, s) => sleep(ms, s) });
  const metricas = { chamadas: 0, status429: 0, erros: 0, porStatus: {} };
  async function ler(clienteId, path, opcoes = {}) {
    const metodo = String((opcoes && opcoes.method) || "GET").toUpperCase();
    if (metodo !== "GET" || (opcoes && opcoes.body !== undefined)) throw new EscritaBloqueadaError(metodo, path);
    for (let tentativa = 0; ; tentativa++) {
      if (signal && signal.aborted) throw Object.assign(new Error("cancelado"), { code: "RESGATE_CANCELADO" });
      await lim.aguardarVez(signal);
      metricas.chamadas++;
      let resp;
      try {
        resp = await fetchFn(clienteId, path, { ...(opcoes || {}), method: "GET", body: undefined, noRefresh: noRefresh || undefined, timeoutMs: opcoes.timeoutMs || 15000 });
      } catch (err) {
        metricas.erros++;
        throw err;
      }
      const st = resp && resp.status;
      metricas.porStatus[st] = (metricas.porStatus[st] || 0) + 1;
      if (st === 429) {
        metricas.status429++;
        const espera = Math.min(60000, Math.max(1000, ((resp.retryAfter ?? 0) * 1000) || 2000 * 2 ** tentativa));
        lim.penalizar(espera);
        if (tentativa + 1 < max429) continue;
      }
      return resp;
    }
  }
  ler.metricas = metricas;
  return ler;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Rebate (subsídio ML/un) da ÚNICA promoção em andamento com subsídio — mesma regra de margemAtualRebate. */
function promocaoDoItem(normalizadas, brutas, promotionIdAtivo) {
  const emAndamento = (normalizadas || []).filter((p) => (p.status === "started" || p.status === "active"));
  const comSubsidio = emAndamento.filter((p) => num(p.subsidioMl) !== null && num(p.subsidioMl) > 0);
  const ativa = emAndamento.find((p) => p.ativa === true) || (promotionIdAtivo ? emAndamento.find((p) => p.promotionId === promotionIdAtivo) : null) || null;
  const boosted = (brutas || []).some((b) => b && Object.keys(b).some((k) => /boost/i.test(k) && b[k]));
  const camposBoost = (brutas || []).some((b) => b && Object.keys(b).some((k) => /boost/i.test(k)));
  return {
    ativa: emAndamento.length ? true : false,
    id: ativa ? ativa.promotionId : (emAndamento[0] ? emAndamento[0].promotionId : null),
    tipo: ativa ? ativa.promotionType : (emAndamento[0] ? emAndamento[0].promotionType : null),
    nome: ativa ? ativa.nome : null,
    // 1 promoção com subsídio > 0 → esse valor; nenhuma com subsídio e TODAS em andamento com
    // meli_percentage numérico (0) → zero comprovado; qualquer uma sem o campo → desconhecido.
    subsidioMl: comSubsidio.length === 1 ? num(comSubsidio[0].subsidioMl)
      : comSubsidio.length === 0 && emAndamento.length && emAndamento.every((p) => num(p.subsidioMl) === 0) ? 0 : null,
    ambigua: comSubsidio.length > 1,
    boostedOffer: camposBoost ? boosted : null,
    fonte: "seller-promotions/items (ao vivo)",
    emAndamento: emAndamento.length,
  };
}

/**
 * Com desconto VIGENTE (cheio > comprador), quem decide o subsídio é a promoção
 * que FORMA o preço do comprador (resgatePromocaoFinanciamento), não "a única
 * promoção em andamento com retorno" — uma SMART em andamento que não forma o
 * preço não paga nada, e uma campanha do vendedor sem meli_percentage tem
 * subsídio 0 comprovado. Sem comprovação: subsídio desconhecido (nunca zero).
 * Sem desconto vigente não há desconto a cofinanciar: subsídio 0.
 */
function aplicarFinanciamento(promocao, lista, precos) {
  const cheio = num(precos && precos.precoCheio), vigente = num(precos && precos.precoEfetivo);
  if (cheio === null || vigente === null) return promocao;
  if (!(cheio > vigente + 0.001)) return { ...promocao, subsidioMl: 0, ambigua: false, financiamento: { comprovado: true, subsidio: 0, financiamento: null, texto: "Sem desconto vigente: nada a cofinanciar." } };
  const f = classificarFinanciamento({
    iniciadas: iniciadasDaResposta(lista), vigente, cheio,
    salePrice: precos.promotionIdAtivo ? { amount: vigente, metadata: { campaign_id: precos.promotionIdAtivo } } : null,
    fonte: "seller-promotions/items (ao vivo)",
  });
  return { ...promocao, id: f.id || promocao.id, tipo: f.tipo || promocao.tipo, nome: f.nome || promocao.nome, subsidioMl: f.comprovado ? f.subsidio : null, ambigua: false, financiamento: f };
}

/**
 * Leitura ao vivo completa de UM anúncio da conta.
 * Recusa anúncio de OUTRO seller (isolamento entre contas).
 */
async function lerAnuncioAoVivo({ clienteId, sellerId, itemId, ler, agora = () => new Date() }) {
  const opc = { mlUserId: String(sellerId) };
  const observadoEm = agora().toISOString();
  const erros = [];
  const itemResp = await ler(clienteId, `/items/${encodeURIComponent(itemId)}?attributes=id,price,status,listing_type_id,category_id,shipping,seller_id,variations,title,seller_custom_field`, opc);
  if (!itemResp || !itemResp.ok || !itemResp.data) {
    return { ok: false, motivo: itemResp && itemResp.status === 429 ? "ml_rate_limit" : `item_http_${itemResp ? itemResp.status : "erro"}`, observadoEm };
  }
  const body = itemResp.data;
  if (String(body.seller_id) !== String(sellerId)) return { ok: false, motivo: "anuncio_de_outro_seller", observadoEm };

  const precos = await resolverPrecosItem({ clienteId, itemId, precoListaFallback: num(body.price), mlUserId: String(sellerId), fetchFn: ler });

  let precoBaseAtualizadoEm = null;
  try {
    const pr = await ler(clienteId, `/items/${encodeURIComponent(itemId)}/prices`, opc);
    const std = pr && pr.ok && pr.data && Array.isArray(pr.data.prices) ? pr.data.prices.find((p) => p && p.type === "standard") : null;
    precoBaseAtualizadoEm = std && std.last_updated ? new Date(std.last_updated).toISOString() : null;
  } catch (_) { erros.push("prices"); }

  let promocao = { ativa: null, subsidioMl: null, indisponivel: null };
  try {
    const pm = await ler(clienteId, `/seller-promotions/items/${encodeURIComponent(itemId)}?app_version=v2`, opc);
    if (pm && pm.ok) {
      const lista = Array.isArray(pm.data) ? pm.data : (pm.data && Array.isArray(pm.data.results) ? pm.data.results : []);
      const normalizadas = normalizarPromocoesDoItem({ itemId, lista, saleInfo: { promotionId: precos.promotionIdAtivo || null, amount: precos.precoEfetivo }, observedAt: observadoEm });
      promocao = { ...promocaoDoItem(normalizadas, lista, precos.promotionIdAtivo), observadoEm };
      promocao = aplicarFinanciamento(promocao, lista, precos);
    } else if (pm && pm.status === 404) {
      promocao = { ativa: false, subsidioMl: null, observadoEm };
    } else {
      promocao = { ativa: null, subsidioMl: null, indisponivel: `http_${pm ? pm.status : "erro"}` };
    }
  } catch (_) { promocao = { ativa: null, subsidioMl: null, indisponivel: "erro_leitura" }; }

  const memoFrete = {};
  const base = {
    clienteId, itemId, listingTypeId: body.listing_type_id || null, categoryId: body.category_id || null,
    sellerId: String(sellerId), logisticType: (body.shipping && body.shipping.logistic_type) || "", mlUserId: String(sellerId),
    shippingTags: body.shipping && Array.isArray(body.shipping.tags) ? body.shipping.tags : null, memoFrete, avaliarFreteSempre: true,
  };
  const cotarEmPreco = async (preco) => {
    const r = await buscarComissaoEFrete({ ...base, precoEfetivo: preco }, ler);
    return { ...r, observadoEm: agora().toISOString() };
  };
  const cotacao = precos.precoEfetivo !== null ? await cotarEmPreco(precos.precoEfetivo) : null;

  return {
    ok: true,
    observadoEm,
    anuncio: {
      itemId, titulo: body.title || null, sku: body.seller_custom_field || null, status: body.status || null,
      logisticType: (body.shipping && body.shipping.logistic_type) || null, listingTypeId: body.listing_type_id || null,
      tags: base.shippingTags, variacoes: Array.isArray(body.variations) ? body.variations.length : null,
    },
    precos: { cheio: precos.precoCheio, vigente: precos.precoEfetivo, promocional: precos.precoPromocional, fonte: precos.fonte, promotionIdAtivo: precos.promotionIdAtivo ?? null, observadoEm },
    precoBaseAtualizadoEm,
    promocao,
    cotacao,
    cotarEmPreco,
    erros,
  };
}

module.exports = { criarFetchSomenteLeitura, lerAnuncioAoVivo, promocaoDoItem, aplicarFinanciamento, EscritaBloqueadaError };
