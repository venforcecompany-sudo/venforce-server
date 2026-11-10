// server/services/motorMargem/adapters/meliApiEvidenceAdapter.js
// Fonte MELI_API — estado ATUAL do anúncio (margem projetada).
//
// SOMENTE LEITURA. Todas as chamadas são GET; nada de preço, promoção ou
// estoque é escrito no Mercado Livre nesta rodada.
//
// Endpoints usados (os mesmos que o Otimizador de Precificação já consome):
//   GET /users/{ml_user_id}/items/search?status=active|paused → ids dos anúncios
//   GET /items?ids=…                                     → título, listing_type, categoria
//   GET /items/{id}/sale_price                           → preço cheio/promo/efetivo
//   GET /sites/MLB/listing_prices                        → comissão (R$ e %)
//   GET /users/{seller}/shipping_options/free            → frete previsto
//
// REÚSO: a cotação corrente (preço vigente, promoção, comissão prevista e
// frete previsto) vem de `shared/marketplaceCurrentQuoteService`, extraído
// desta mesma lógica na refatoração estrutural da Central de Margem — ver
// docs/AUDITORIA_ARQUITETURAL_CENTRAL_MARGEM.md. Automações e Diagnóstico
// ainda têm suas próprias cópias (migração deles fica para a próxima rodada,
// por escopo — ver relatório de entrega da refatoração).

const { mlFetch } = require("../../../utils/mlClient");
const { obterCotacaoAtual } = require("../../shared/marketplaceCurrentQuoteService");
const { SOURCES, EVIDENCE_KINDS, EVIDENCE_QUALITY } = require("../core/marginSources");
const { FIELDS } = require("../core/marginEvidence");

const SEARCH_PAGE_LIMIT = 20; // teto do /items?ids= do ML

function numOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Erro de UMA chamada abortiva ao Mercado Livre (busca de ids / multiget de
// detalhes) — as únicas duas chamadas desta camada cujo erro hoje interrompe
// o lote inteiro (não há fallback "item sem dado", o Motor não tem IDs/corpo
// para seguir). ANTES desta função, resp.status===429 caía no `else: 502`
// genérico — a mesma etiqueta de "ML fora do ar"/erro estrutural qualquer,
// então quem chamava (job/orquestrador) não conseguia distinguir rate limit
// de qualquer outra falha. 401/403→422 e "qualquer outro status"→502
// continuam EXATAMENTE como antes; só 429 ganha um terceiro ramo, com o
// status HTTP real preservado (nunca reescrito) e `retryAfter` (já parseado
// por mlFetch a partir do header Retry-After) passado adiante sem
// reinterpretar — nenhum sleep/retry acontece aqui, é só preservação de
// informação para quem decidir o que fazer com ela.
function criarErroMeliApi(resp, mensagemPadrao) {
  const mlStatus = Number.isFinite(Number(resp.status)) ? Number(resp.status) : null;
  if (resp.status === 429) {
    const err = new Error(
      resp.data?.message
        ? `Rate limit do Mercado Livre (429): ${resp.data.message}`
        : "Rate limit do Mercado Livre (429)."
    );
    err.statusCode = 429;
    err.codigo = "MELI_RATE_LIMIT";
    err.mlStatus = mlStatus;
    err.retryAfter = resp.retryAfter ?? null;
    return err;
  }
  const err = new Error(resp.data?.message || mensagemPadrao);
  err.statusCode = resp.status === 401 || resp.status === 403 ? 422 : 502;
  err.mlStatus = mlStatus;
  err.retryAfter = resp.retryAfter ?? null;
  return err;
}

/**
 * Imagem do anúncio — extraída do MESMO `body` que `/items?ids=` já devolve.
 * ZERO chamada nova: é metadado de identidade/apresentação, não evidência
 * financeira. Defensivo porque o contrato do ML nem sempre traz as três
 * variantes; a primeira disponível vence.
 */
function extrairImagem(body) {
  const secureThumb = typeof body?.secure_thumbnail === "string" ? body.secure_thumbnail.trim() : "";
  if (secureThumb) return secureThumb;
  const thumb = typeof body?.thumbnail === "string" ? body.thumbnail.trim() : "";
  if (thumb) return thumb;
  const pictures = Array.isArray(body?.pictures) ? body.pictures : [];
  for (const picture of pictures) {
    const url = (picture && (picture.secure_url || picture.url) || "").trim();
    if (url) return url;
  }
  return null;
}

/** Uma página de `/items/search` filtrada por UM status. Somente leitura. */
async function buscarItensPorStatus({ clienteId, mlUserId, status, offset = 0, limit = SEARCH_PAGE_LIMIT }, fetchFn = mlFetch) {
  const resp = await fetchFn(
    clienteId,
    `/users/${mlUserId}/items/search?status=${status}&offset=${offset}&limit=${limit}`,
    // Path seller-scoped: sem mlUserId nas options o token cai no principal do
    // cliente e o ML responde 403 quando a conta selecionada não é a principal.
    { mlUserId }
  );
  if (!resp.ok) {
    throw criarErroMeliApi(resp, `Erro ao buscar itens (${status}) no Mercado Livre.`);
  }
  return {
    ids: Array.isArray(resp.data?.results) ? resp.data.results : [],
    total: resp.data?.paging?.total ?? 0,
  };
}

/**
 * Página combinada de anúncios ATIVOS + PAUSADOS do vendedor, na MESMA
 * paginação offset/limit que o Motor já usava só para ativos — pré-requisito
 * de `enrichBatch`/`carregarWorkspace`, que decidem quantos lotes encadear a
 * partir do `total` devolvido aqui.
 *
 * O Mercado Livre não tem um único `/items/search` que junte os dois status
 * com um offset contínuo (cada chamada filtra UM status), então esta função
 * concatena os dois universos numa ordem estável — ativos primeiro, pausados
 * depois — fazendo a MESMA conta de página que faria se fosse uma lista só:
 * a fatia [offset, offset+limit) nunca repete nem pula um id, e nunca vira
 * "página 1 de ativos + página 1 de pausados" (o bug que uma paginação
 * ingênua causaria). Sempre consulta os dois status, mesmo quando a página
 * sai inteira de um só: sem o `total` do outro, a varredura em lotes
 * (`carregarWorkspace`) pararia cedo demais e nunca chegaria aos pausados.
 *
 * Dedup por item_id como cinto de segurança: os dois status são mutuamente
 * exclusivos no Mercado Livre, então só colidiriam se um anúncio mudasse de
 * status EXATAMENTE entre as duas chamadas — cenário raro que, se acontecer,
 * não pode duplicar o item na lista.
 */
async function buscarItensAtivos({ clienteId, mlUserId, offset = 0, limit = SEARCH_PAGE_LIMIT }, fetchFn = mlFetch) {
  const ativos = await buscarItensPorStatus({ clienteId, mlUserId, status: "active", offset, limit }, fetchFn);

  const faltam = Math.max(0, limit - ativos.ids.length);
  const offsetPausados = Math.max(0, offset - ativos.total);
  const pausados = await buscarItensPorStatus(
    { clienteId, mlUserId, status: "paused", offset: offsetPausados, limit: Math.max(faltam, 1) },
    fetchFn
  );

  const vistos = new Set();
  const ids = [...ativos.ids, ...pausados.ids.slice(0, faltam)].filter((id) => {
    if (vistos.has(id)) return false;
    vistos.add(id);
    return true;
  });

  return {
    ids,
    total: ativos.total + pausados.total,
  };
}

// ---------------------------------------------------------------------------
// Catálogo INTEIRO por scan (Margin Snapshot Worker)
// ---------------------------------------------------------------------------
//
// `buscarItensAtivos` pagina por offset, e o Mercado Livre não aceita offset
// além de 1000 em /users/{id}/items/search — acima disso a doc exige
// `search_type=scan` + `scroll_id` (mesmo padrão já usado por
// meliSyncService.coletarItemIds, modeloBaseCustosService e
// planilhaPrecificacaoSemBaseService). O worker de snapshot precisa do
// catálogo inteiro (5.000+ itens), então lista os IDs por scan e entrega os
// lotes ao Motor via `enrichBatch(prepared, { itemIds })` — a leitura por
// offset da tela (teto 200) continua intocada.
//
// Mesma ordem de `buscarItensAtivos`: ativos primeiro, pausados depois, sem
// repetir id. Falha de página lança com o status REAL do ML (`mlStatus`) e o
// `retryAfter` em segundos (quando o ML mandou), para o worker decidir o
// retry — este adapter nunca dorme nem re-tenta sozinho.

const SCAN_PAGE_LIMIT = 100; // máximo aceito pelo ML por página de scan

function erroDeRespostaMl(resp, mensagemPadrao) {
  return criarErroMeliApi(resp, mensagemPadrao);
}

async function listarIdsPorStatusScan({ clienteId, mlUserId, status, maxItens }, fetchFn = mlFetch) {
  const ids = [];
  let scrollId = null;
  // Cada volta acrescenta >= 1 id ou encerra; o teto `maxItens` garante fim.
  for (;;) {
    const params = new URLSearchParams({ search_type: "scan", status, limit: String(SCAN_PAGE_LIMIT) });
    if (scrollId) params.set("scroll_id", scrollId);
    const resp = await fetchFn(clienteId, `/users/${mlUserId}/items/search?${params.toString()}`, { mlUserId });
    if (!resp.ok) throw erroDeRespostaMl(resp, `Erro ao listar anúncios (${status}) no Mercado Livre.`);

    const resultados = Array.isArray(resp.data?.results) ? resp.data.results : [];
    if (!resultados.length) break;
    ids.push(...resultados);
    if (ids.length > maxItens) {
      const err = new Error(`Catálogo maior que o teto de segurança do snapshot (${maxItens} itens).`);
      err.code = "MARGIN_SNAPSHOT_CATALOGO_EXCEDE_TETO";
      err.statusCode = 422;
      throw err;
    }
    const proximo = String(resp.data?.scroll_id || "").trim();
    if (!proximo) break;
    scrollId = proximo;
  }
  return ids;
}

async function listarIdsCatalogo({ clienteId, mlUserId, maxItens = 20000 }, fetchFn = mlFetch) {
  const ativos = await listarIdsPorStatusScan({ clienteId, mlUserId, status: "active", maxItens }, fetchFn);
  const pausados = await listarIdsPorStatusScan({ clienteId, mlUserId, status: "paused", maxItens }, fetchFn);

  const vistos = new Set();
  const ids = [];
  for (const bruto of [...ativos, ...pausados]) {
    const id = String(bruto ?? "").trim();
    if (!id || vistos.has(id)) continue;
    vistos.add(id);
    ids.push(id);
  }
  if (ids.length > maxItens) {
    const err = new Error(`Catálogo maior que o teto de segurança do snapshot (${maxItens} itens).`);
    err.code = "MARGIN_SNAPSHOT_CATALOGO_EXCEDE_TETO";
    err.statusCode = 422;
    throw err;
  }
  return { ids, totalAtivos: ativos.length, totalPausados: pausados.length };
}

/** Detalhes em lote. Devolve os `body` já desembrulhados do multiget. */
// Código por entrada do multiget: `code` em /items?ids=, `status_code` no
// substituto /items/bulk?ids= (doc itens-e-buscas: migração até 25/10/2026).
function codigoDaEntrada(entry) {
  const c = entry && (entry.code ?? entry.status_code);
  const n = Number(c);
  return Number.isFinite(n) ? n : null;
}

/**
 * Detalhes de até 20 anúncios (multiget). Devolve SÓ os corpos de entradas
 * HTTP 200 com `id` — o array carrega, numa propriedade não enumerável
 * `erros`, as entradas recusadas: [{ id, status, erro }].
 *
 * P0 04/11/2026 (Alianza Jeans 2, conta secundária): a chamada saía SEM
 * `mlUserId`, com o token do grant PRINCIPAL do cliente (outro vendedor), e o
 * ML respondia 403 por item. O corpo de erro (`{status:403, message, …}`) era
 * aceito como se fosse o anúncio: "Status: 403" na tela, sem categoria/tipo de
 * anúncio ⇒ comissão e frete nunca consultados ⇒ 532/532 cotações
 * "incompletas" sem motivo. Agora: identidade explícita da conta e o erro do
 * ML chega como erro, com o status HTTP.
 */
async function buscarDetalhesItens({ clienteId, ids, mlUserId = null }, fetchFn = mlFetch) {
  if (!ids || ids.length === 0) return [];
  const resp = await fetchFn(clienteId, `/items?ids=${ids.join(",")}`, mlUserId ? { mlUserId } : undefined);
  if (!resp.ok) {
    throw criarErroMeliApi(resp, "Erro ao buscar detalhes dos itens no Mercado Livre.");
  }
  const entries = Array.isArray(resp.data) ? resp.data : [];
  const bodies = [];
  const erros = [];
  for (const entry of entries) {
    const codigo = codigoDaEntrada(entry);
    const body = entry && entry.body;
    const id = (body && body.id) || (entry && entry.id) || null;
    // Entrada sem código (formato inesperado) com corpo de anúncio válido:
    // aceita como antes. Com código ≠ 200, ou corpo de erro: recusa.
    const corpoDeAnuncio = body && body.id && !(Number(body.status) >= 400);
    if ((codigo === 200 || codigo === null) && corpoDeAnuncio) {
      bodies.push(body);
    } else {
      erros.push({
        id: id ? String(id) : null,
        status: codigo ?? (body && Number(body.status) >= 400 ? Number(body.status) : null),
        erro: body && (body.error || body.message) ? String(body.error || body.message).slice(0, 120) : null,
      });
    }
  }
  Object.defineProperty(bodies, "erros", { value: erros, enumerable: false });
  return bodies;
}

/**
 * Coleta TODAS as evidências projetadas de um item e registra no bag.
 * Preço + comissão prevista + frete previsto vêm de
 * `shared/marketplaceCurrentQuoteService.obterCotacaoAtual` — nenhuma consulta
 * a `listing_prices`/`shipping_options` é reimplementada aqui.
 * @returns {Promise<object>} resumo do que foi observado (para diagnóstico)
 */
async function aplicarEvidenciasProjetadas(
  bag,
  { clienteId, body, observedAt = new Date(), mlUserId = null },
  deps = {}
) {
  const itemId = String(body?.id || "").trim();
  const listingTypeId = body?.listing_type_id || null;
  const categoryId = body?.category_id || null;
  const sellerId = body?.seller_id || null;
  const logisticType = body?.shipping?.logistic_type || "";
  const shippingTags = Array.isArray(body?.shipping?.tags) ? body.shipping.tags : null;

  const precoListaFallback =
    numOrNull(body?.price) !== null && numOrNull(body.price) > 0 ? numOrNull(body.price) : null;

  const cotarFn = deps.obterCotacaoAtualFn || obterCotacaoAtual;
  const cotacao = await cotarFn(
    { clienteId, itemId, precoListaFallback, listingTypeId, categoryId, sellerId, logisticType, mlUserId, shippingTags },
    { mlFetchFn: deps.mlFetchFn, resolverPrecosItemFn: deps.resolverPrecosItemFn }
  );

  const comum = {
    source: SOURCES.MELI_API,
    kind: EVIDENCE_KINDS.PROJECTED,
    quality: EVIDENCE_QUALITY.MEASURED,
    observedAt,
  };

  bag.add(FIELDS.PRICE, { ...comum, value: cotacao.precoEfetivo, note: `sale_price (${cotacao.fontePreco})` });
  bag.add(FIELDS.LIST_PRICE, { ...comum, value: cotacao.precoOriginal, note: `sale_price (${cotacao.fontePreco})` });
  bag.add(FIELDS.PROMO_PRICE, {
    ...comum,
    value: cotacao.precoPromocional,
    note: `sale_price (${cotacao.fontePreco})`,
  });
  bag.add(FIELDS.COMMISSION, {
    ...comum,
    value: cotacao.comissaoValor,
    note: "listing_prices.sale_fee_amount",
  });
  bag.add(FIELDS.COMMISSION_RATE, {
    ...comum,
    value: cotacao.comissaoPercentual,
    note: "listing_prices.sale_fee_details.percentage_fee",
  });
  bag.add(FIELDS.FREIGHT, {
    ...comum,
    value: cotacao.fretePrevisto,
    note: "shipping_options/free.coverage.all_country.list_cost",
  });

  return {
    itemId,
    titulo: body?.title || null,
    sku: body?.seller_custom_field || null,
    status: body?.status || null,
    image: extrairImagem(body),
    listingTypeId,
    categoryId,
    logisticType: logisticType || null,
    precoEfetivo: cotacao.precoEfetivo,
    precoCheio: cotacao.precoOriginal,
    precoPromocional: cotacao.precoPromocional,
    promotionIdAtivo: cotacao.promotionIdAtivo,
    commission: cotacao.comissaoValor,
    commissionRate: cotacao.comissaoPercentual,
    freight: cotacao.fretePrevisto,
    // Nível/fonte/confiança do frete (null = cotação direta do ML sem avaliação).
    freteQualidade: cotacao.freteQualidade || null,
    // Sinaliza para a Central por que uma variável ficou sem valor.
    faltantes: cotacao.faltantes,
    // Status HTTP + motivo por componente (comissão/frete) da cotação.
    cotacao: cotacao.diagnosticoCotacao || null,
  };
}

module.exports = {
  SEARCH_PAGE_LIMIT,
  SCAN_PAGE_LIMIT,
  buscarItensAtivos,
  listarIdsCatalogo,
  erroDeRespostaMl,
  buscarDetalhesItens,
  aplicarEvidenciasProjetadas,
  extrairImagem,
  criarErroMeliApi,
};
