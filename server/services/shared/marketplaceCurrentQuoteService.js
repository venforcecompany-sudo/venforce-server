// server/services/shared/marketplaceCurrentQuoteService.js
// COTAÇÃO CORRENTE do marketplace — preço vigente, promoção, comissão prevista
// e frete previsto de UM anúncio, num contrato único.
//
// Por que este arquivo existe: a auditoria arquitetural da Central de Margem
// (docs/AUDITORIA_ARQUITETURAL_CENTRAL_MARGEM.md) encontrou a MESMA consulta a
// `/sites/MLB/listing_prices` e `/users/{seller}/shipping_options/free`
// implementada de forma independente em:
//   - server/services/motorMargem/adapters/meliApiEvidenceAdapter.js (Motor)
//   - server/services/automacoes/precificacaoService.js (Automações/preview)
//   - server/services/automacoes/diagnosticoService.js (Diagnóstico)
//
// Esta é a extração da MENOR abstração compartilhada segura: só a cotação
// corrente (preço + comissão + frete previstos), reaproveitando
// `precoItemService.resolverPrecosItem` (que já era compartilhado) para o
// preço. Desde o P0 de 12/11/2026 os TRÊS consumidores acima usam
// `buscarComissaoEFrete`: não existe mais consulta de comissão/frete fora
// deste arquivo (teste `freteFonteUnica.test.js` trava isso).
//
// SOMENTE LEITURA: toda chamada ao Mercado Livre aqui é GET.

const { mlFetch } = require("../../utils/mlClient");
const { resolverPrecosItem } = require("../automacoes/precoItemService");
const { freteConfiavelHabilitado, avaliarFrete } = require("./freteCotacaoConfiavel");
// Motivos por componente: a MESMA tabela da cotação em P' (Simular/Promoções).
const {
  MOTIVOS_COTACAO, motivoDaResposta, LOGISTICA_SEM_FRETE_PREVISTO,
} = require("../motorMargem/margemCotacaoEmP");

function numOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Comissão + frete previstos de UM item, no preço efetivo informado.
 * Qualquer falha vira `null` (ausente) — nunca 0.
 *
 * LIMITAÇÃO CONHECIDA (auditoria de observabilidade de 429, ver
 * meliApiEvidenceAdapter.criarErroMeliApi): `mlFetch` NÃO lança em resposta
 * HTTP não-2xx — devolve `{ok:false, status, retryAfter}` normalmente — então
 * um 429 de listing_prices/shipping_options cai direto no `?.ok` abaixo e
 * vira `null`, indistinguível de qualquer outro motivo de ausência (404,
 * item sem categoria, timeout). Decisão desta auditoria: NÃO alterar este
 * caminho para lançar em 429. Esta função é chamada 1x por ITEM (via
 * `aplicarEvidenciasProjetadas` → `mapWithConcurrency`, sem try/catch por
 * item) — fazer um único 429 de comissão/frete de 1 item virar exceção
 * abortaria o `enrichBatch` inteiro (toda a conta) por uma falha que hoje só
 * degrada a qualidade de 1 item. Diferente das chamadas abortivas de
 * `buscarItensAtivos`/`buscarDetalhesItens` (2-3 chamadas por LOTE de 20,
 * onde abortar já era o comportamento existente): aqui o raio de impacto de
 * "passar a abortar" seria desproporcional ao problema. Fica documentado
 * como gap conhecido, não escondido — ver ENTREGA da missão de observabilidade
 * de 429 para o racional completo.
 */
async function buscarComissaoEFrete(
  { clienteId, itemId, precoEfetivo, listingTypeId, categoryId, sellerId, logisticType, mlUserId = null, shippingTags = null, memoFrete = null, avaliarFreteSempre = false },
  fetchFn = mlFetch
) {
  // P0 04/11/2026 (Alianza Jeans 2): o resultado de cada GET fica registrado
  // (status HTTP / timeout / exceção) para o `diagnostico` dizer POR QUE um
  // componente ficou ausente — antes tudo virava um `null` mudo e 532 itens
  // falharam sem nenhuma pista. Valores continuam null quando ausentes: nunca 0.
  const registros = { listing: null, frete: null };
  const registrar = (chave, resp) => {
    registros[chave] = resp ? { ok: resp.ok === true, status: resp.status ?? null } : null;
    return resp;
  };
  const registrarErro = (chave, err) => {
    registros[chave] = {
      ok: false, status: null, timeout: Boolean(err && err.name === "MlTimeoutError"),
      erro: err && (err.code || err.name) ? String(err.code || err.name) : "erro",
    };
    return null;
  };
  // Mesma identidade de conta em TODAS as chamadas: sem mlUserId o mlFetch
  // cai no grant PRINCIPAL do cliente — numa conta secundária isso é ler o ML
  // com o token de outro vendedor.
  const opcoesConta = mlUserId ? { mlUserId } : undefined;

  const comissaoConsultavel = precoEfetivo !== null && Boolean(listingTypeId) && Boolean(categoryId);
  // Frete combinável (não especificado/custom) não tem custo previsto pelo
  // ML — pedir mesmo assim devolveria um número que não se aplica.
  const freteAplicavel = !LOGISTICA_SEM_FRETE_PREVISTO.has(logisticType || "");
  const freteConsultavel = freteAplicavel && precoEfetivo !== null && Boolean(sellerId) && Boolean(listingTypeId) && Boolean(itemId);

  const [listingPricesResp, shippingResp] = await Promise.all([
    (async () => {
      if (!comissaoConsultavel) return null;
      const query =
        `/sites/MLB/listing_prices?price=${encodeURIComponent(precoEfetivo)}` +
        `&listing_type_id=${encodeURIComponent(listingTypeId)}` +
        `&category_id=${encodeURIComponent(categoryId)}`;
      try {
        return registrar("listing", await fetchFn(clienteId, query, opcoesConta));
      } catch (err) {
        return registrarErro("listing", err);
      }
    })(),
    (async () => {
      if (!freteConsultavel) return null;
      const query =
        `/users/${encodeURIComponent(sellerId)}/shipping_options/free` +
        `?item_id=${encodeURIComponent(itemId)}&verbose=true` +
        `&item_price=${encodeURIComponent(precoEfetivo)}` +
        `&listing_type_id=${encodeURIComponent(listingTypeId)}&mode=me2`;
      try {
        // Path seller-scoped (/users/{seller}/…): sem mlUserId o token cai no
        // principal e o ML pode responder 403 quando a conta selecionada não
        // é a principal do cliente (mesmo bug do fix de Automações).
        return registrar("frete", await fetchFn(clienteId, query, opcoesConta));
      } catch (err) {
        return registrarErro("frete", err);
      }
    })(),
  ]);

  const listingPricesData = listingPricesResp && listingPricesResp.ok ? listingPricesResp.data : null;
  const root = Array.isArray(listingPricesData)
    ? listingPricesData[0]
    : Array.isArray(listingPricesData?.results)
      ? listingPricesData.results[0]
      : listingPricesData;

  const comissaoValor = numOrNull(root?.sale_fee_amount);
  const comissaoPercentualBruta = numOrNull(root?.sale_fee_details?.percentage_fee);

  let fretePrevisto =
    shippingResp && shippingResp.ok
      ? numOrNull(shippingResp.data?.coverage?.all_country?.list_cost)
      : null;

  // P0 10/11/2026: cotação por item_id comprovadamente subestimada (tag
  // `proximity` + desconto não obrigatório). Liberação gradual por seller
  // (FRETE_COTACAO_CONFIAVEL_SELLERS); fora dela este bloco não existe.
  // `avaliarFreteSempre` (VenForce Resgate, 12/11/2026): a AUDITORIA, que só lê,
  // avalia qualquer seller com as MESMAS regras para medir a compatibilidade da
  // conta antes da liberação. Nenhum consumidor de produção passa este parâmetro.
  let freteQualidade = null;
  let motivoFreteNaoConfiavel = null;
  if (fretePrevisto !== null && (avaliarFreteSempre === true || freteConfiavelHabilitado(sellerId))) {
    const av = await avaliarFrete({
      fetchFn, clienteId, sellerId, itemId, listingTypeId, precoEfetivo, logisticType,
      respostaMl: shippingResp, tags: shippingTags, opcoes: opcoesConta, memo: memoFrete,
    });
    if (av.qualidade) {
      freteQualidade = av.qualidade;
      fretePrevisto = av.fretePrevisto;
      motivoFreteNaoConfiavel = av.motivo;
    }
  }

  const motivoEntradaAusente = precoEfetivo === null ? "preco_ausente" : MOTIVOS_COTACAO.ANUNCIO_SEM_TIPO_OU_CATEGORIA;
  const diagnostico = {
    comissao: {
      status: registros.listing ? registros.listing.status : null,
      motivo: comissaoValor !== null
        ? null
        : !comissaoConsultavel ? motivoEntradaAusente : motivoDaResposta(registros.listing, MOTIVOS_COTACAO.ML_SEM_TARIFA),
    },
    frete: {
      aplicavel: freteAplicavel,
      status: registros.frete ? registros.frete.status : null,
      motivo: !freteAplicavel || fretePrevisto !== null
        ? null
        : motivoFreteNaoConfiavel ? motivoFreteNaoConfiavel
        : !freteConsultavel
          ? (precoEfetivo !== null && !sellerId ? MOTIVOS_COTACAO.CONTA_SEM_SELLER : motivoEntradaAusente)
          : motivoDaResposta(registros.frete, MOTIVOS_COTACAO.ML_SEM_FRETE),
    },
  };

  return {
    comissaoValor,
    // O ML devolve o percentual em escala 0–100; o resto do backend trabalha
    // em decimal (0.12 = 12%) — mesma convenção de `custos.imposto_percentual`.
    comissaoPercentual: comissaoPercentualBruta === null ? null : comissaoPercentualBruta / 100,
    // Como o ML devolve (0–100), para consumidores que já trabalham nessa escala.
    comissaoPercentualMl: comissaoPercentualBruta,
    fretePrevisto,
    freteQualidade,
    diagnostico,
  };
}

/**
 * Cotação corrente completa de UM anúncio: preço vigente + promoção +
 * comissão prevista + frete previsto, num contrato único.
 *
 * @param {object} params
 *  - clienteId          id interno do cliente (para o token ML)
 *  - itemId              MLB do anúncio
 *  - precoListaFallback  preço de tabela conhecido (do /items?ids=), usado só
 *                        se /sale_price falhar (mesmo fallback de sempre)
 *  - listingTypeId, categoryId, sellerId, logisticType  metadados do anúncio,
 *                        necessários para consultar listing_prices/shipping
 * @returns {Promise<object>}
 */
async function obterCotacaoAtual(
  { clienteId, itemId, precoListaFallback = null, listingTypeId, categoryId, sellerId, logisticType, mlUserId = null, shippingTags = null, memoFrete = null, avaliarFreteSempre = false },
  deps = {}
) {
  const fetchFn = deps.mlFetchFn || mlFetch;
  const precosFn = deps.resolverPrecosItemFn || resolverPrecosItem;

  const { precoCheio, precoPromocional, precoEfetivo, fonte, promotionIdAtivo, campaignIdAtivo, promotionTypeAtivo } = await precosFn({
    clienteId,
    itemId,
    precoListaFallback,
    mlUserId,
  });

  const { comissaoValor, comissaoPercentual, fretePrevisto, freteQualidade, diagnostico } = await buscarComissaoEFrete(
    { clienteId, itemId, precoEfetivo, listingTypeId, categoryId, sellerId, logisticType, mlUserId, shippingTags, memoFrete, avaliarFreteSempre },
    fetchFn
  );

  const faltantes = [
    precoEfetivo === null ? "preco" : null,
    comissaoValor === null ? "comissao" : null,
    fretePrevisto === null ? "frete" : null,
  ].filter(Boolean);

  return {
    precoAtual: precoEfetivo,
    precoOriginal: precoCheio,
    precoPromocional,
    precoEfetivo,
    fontePreco: fonte,
    // undefined quando o preço não veio do sale_price (fallback legado): aí
    // não se sabe qual promoção forma o preço. null = sale_price sem promoção.
    promotionIdAtivo,
    // Mesma leitura do preço: campanha (/seller-promotions id) e tipo informado
    // pelo sale_price. undefined quando o preço não veio do sale_price.
    campaignIdAtivo,
    promotionTypeAtivo,
    comissaoValor,
    comissaoPercentual,
    fretePrevisto,
    freteQualidade: freteQualidade || null,
    listingType: listingTypeId || null,
    logisticType: logisticType || null,
    faltantes,
    // Por componente: status HTTP da leitura e motivo da ausência (null = ok).
    diagnosticoCotacao: diagnostico || null,
  };
}

module.exports = {
  obterCotacaoAtual,
  buscarComissaoEFrete,
};
