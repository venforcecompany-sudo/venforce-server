// server/services/meliAnuncios/meliSyncService.js
// -----------------------------------------------------------------------------
// Módulo: Anúncios Meli — sincronização com a API do Mercado Livre.
//
// Estratégia (read-only, não altera nada no Mercado Livre):
//  1. lista os item_ids do vendedor via /users/{userId}/items/search (scan/scroll);
//  2. no modo "novos", descarta os ids que já existem no banco;
//  3. lê os itens em grupos de 20 (o mlFetch faz um GET /items/{id} por item —
//     o multiget do ML passou a recusar lotes), contando as falhas por item;
//  4. calcula o Score VenForce de cada anúncio;
//  5. faz upsert na tabela meli_anuncios.
//
// A descrição NÃO é buscada aqui (1 request por item é pesado para 1500+
// anúncios). Ela é carregada sob demanda no endpoint de detalhe.
//
// Reaproveita server/utils/mlClient.js (mlFetch) — não mexe em token/refresh.
// -----------------------------------------------------------------------------

const { mlFetch } = require("../../utils/mlClient");
const anunciosService = require("./meliAnunciosService");
const familiaService = require("./meliFamiliaService");

// family_id do Mercado Livre estoura Number.MAX_SAFE_INTEGER. Todo multiget
// precisa pedir o parsing que preserva o valor como string — ver
// parseJsonPreservingIds em utils/mlClient.js.
const CAMPOS_ID_GRANDE = ["family_id"];

// Limites de segurança para não pesar o servidor / a API.
const SCAN_LIMIT = 100; // itens por página do search scan
const MAX_PAGINAS = 120; // 120 * 100 = até 12.000 ids
const LOTE_MULTIGET = 20; // máximo aceito pelo multiget de /items
const MAX_ITENS = 6000; // teto de itens processados por sincronização

// -----------------------------------------------------------------------------
// Score VenForce — nota simples de qualidade (0 a 100).
// Critérios disponíveis sem custo (custo entra numa etapa futura):
//   título (32) · fotos (26) · marca (14) · modelo (14) · ficha técnica (14)
// -----------------------------------------------------------------------------
function calcularScore(item, attrsMap, picturesCount) {
  let pontos = 0;
  const problemas = [];

  const titulo = String(item.title || "").trim();
  if (!titulo) {
    problemas.push("Sem título");
  } else if (titulo.length < 20) {
    pontos += 12;
    problemas.push("Título muito curto");
  } else if (titulo.length > 60) {
    pontos += 22;
    problemas.push("Título acima de 60 caracteres");
  } else {
    pontos += 32;
  }

  if (picturesCount === 0) {
    problemas.push("Sem fotos");
  } else if (picturesCount < 3) {
    pontos += 10;
    problemas.push("Menos de 3 fotos");
  } else if (picturesCount < 6) {
    pontos += 20;
  } else {
    pontos += 26;
  }

  if (attrsMap.BRAND) pontos += 14;
  else problemas.push("Marca não preenchida");

  if (attrsMap.MODEL) pontos += 14;
  else problemas.push("Modelo não preenchido");

  const attrs = Array.isArray(item.attributes) ? item.attributes : [];
  const total = attrs.length;
  const preenchidos = attrs.filter((a) => a && valorAtributo(a)).length;
  const ratio = total ? preenchidos / total : 0;
  pontos += Math.round(14 * ratio);
  if (total && ratio < 0.6) problemas.push("Ficha técnica incompleta");

  return {
    score: Math.max(0, Math.min(100, pontos)),
    motivo: problemas[0] || "Anúncio saudável",
  };
}

function valorAtributo(a) {
  if (!a) return null;
  if (a.value_name) return a.value_name;
  if (Array.isArray(a.values) && a.values[0] && a.values[0].name) {
    return a.values[0].name;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Mapeia o JSON cru de um item do ML para o registro da tabela meli_anuncios.
// -----------------------------------------------------------------------------
function mapearItem(body, clienteId, clienteSlug, contaId = null, mlUserId = null) {
  const attrs = Array.isArray(body.attributes) ? body.attributes : [];

  const attrsMap = {};
  for (const a of attrs) {
    if (a && a.id) attrsMap[a.id] = valorAtributo(a);
  }

  const pictures = (Array.isArray(body.pictures) ? body.pictures : [])
    .map((p) => p && (p.secure_url || p.url))
    .filter(Boolean);

  const sku = attrsMap.SELLER_SKU || body.seller_custom_field || null;
  const logisticType =
    (body.shipping && body.shipping.logistic_type) || null;

  const { score, motivo } = calcularScore(body, attrsMap, pictures.length);

  return {
    cliente_id: clienteId,
    cliente_slug: clienteSlug,
    cliente_conta_id: contaId,
    ml_user_id: mlUserId != null ? String(mlUserId) : null,
    item_id: body.id,
    sku,
    titulo: body.title || null,
    marca: attrsMap.BRAND || null,
    modelo: attrsMap.MODEL || null,
    preco: body.price != null ? body.price : null,
    preco_original: body.original_price != null ? body.original_price : null,
    moeda: body.currency_id || null,
    estoque:
      body.available_quantity != null ? body.available_quantity : null,
    vendidos: body.sold_quantity != null ? body.sold_quantity : null,
    status: body.status || null,
    sub_status: Array.isArray(body.sub_status)
      ? body.sub_status.join(",")
      : body.sub_status || null,
    listing_type_id: body.listing_type_id || null,
    category_id: body.category_id || null,
    permalink: body.permalink || null,
    thumbnail: body.secure_thumbnail || body.thumbnail || null,
    pictures_count: pictures.length,
    pictures_json: pictures,
    logistic_type: logisticType,
    is_full: logisticType === "fulfillment",
    attributes_json: attrs.map((a) => ({
      id: a.id,
      name: a.name,
      value: valorAtributo(a),
    })),
    health: typeof body.health === "number" ? body.health : null,
    score_venforce: score,
    score_motivo: motivo,
    catalog_listing: typeof body.catalog_listing === "boolean" ? body.catalog_listing : null,
    catalog_product_id: body.catalog_product_id || null,
    family_name: body.family_name || null,
    // Chave estável do ML (User Product) — persistida em meli_anuncios.
    user_product_id: body.user_product_id || null,

    // Campos do User Product. NÃO são colunas de meli_anuncios: viajam no
    // registro e são consumidos por meliFamiliaService.registrarUserProducts().
    // upsertAnuncios() tem lista de colunas explícita, então os ignora.
    //
    // family_id só existe quando o item está no modelo UP; item legado
    // (multivariante não migrado) não traz nenhum dos dois, e nada é inferido.
    // Chega como string via bigIntFields — String() aqui é só defesa de tipo,
    // não conserta um valor que já tenha sido parseado como Number.
    family_id: body.family_id != null ? String(body.family_id) : null,
    site_id: body.site_id || null,
    domain_id: body.domain_id || null,

    // Sinal do modelo LEGADO (item_id -> variations[]), independente do
    // sinal do modelo novo acima. Os dois convivem no mesmo registro porque
    // são fatos do payload, não uma decisão de qual "vale" — quem decide
    // isso é a leitura agrupada (meliFamiliaService), nunca o mapeamento.
    // Já vem no multiget que esta sincronização já faz: zero chamada extra.
    variations_count: Array.isArray(body.variations) ? body.variations.length : 0,
  };
}

// -----------------------------------------------------------------------------
// Coleta todos os item_ids do vendedor usando o search scan/scroll.
// -----------------------------------------------------------------------------
async function coletarItemIds(clienteId, mlUserId) {
  const ids = [];
  let scrollId = null;
  let pagina = 0;

  do {
    const qs = scrollId
      ? `search_type=scan&limit=${SCAN_LIMIT}&scroll_id=${encodeURIComponent(
          scrollId
        )}`
      : `search_type=scan&limit=${SCAN_LIMIT}`;

    const resp = await mlFetch(
      clienteId,
      `/users/${mlUserId}/items/search?${qs}`,
      { mlUserId }
    );

    if (!resp || !resp.ok) {
      return {
        ok: false,
        status: resp && resp.status,
        ids,
      };
    }

    const results =
      (resp.data && Array.isArray(resp.data.results) && resp.data.results) ||
      [];
    ids.push(...results);
    scrollId = resp.data && resp.data.scroll_id;
    pagina++;

    if (results.length === 0) break;
  } while (scrollId && pagina < MAX_PAGINAS);

  return { ok: true, ids };
}

// -----------------------------------------------------------------------------
// Lê os itens no ML (o mlFetch faz uma leitura por item; ver mlClient) e separa
// o que virou registro do que falhou, item a item — nunca descarta em silêncio.
// `contexto(id)` devolve { slug, contaId, mlUserId } do item.
// -----------------------------------------------------------------------------
async function lerRegistros({ clienteId, ids, mlUserId = null, contexto }) {
  const registros = [];
  const falhas = [];
  for (let i = 0; i < ids.length; i += LOTE_MULTIGET) {
    const lote = ids.slice(i, i + LOTE_MULTIGET);
    const resp = await mlFetch(
      clienteId,
      `/items?ids=${lote.join(",")}`,
      { ...(mlUserId ? { mlUserId } : {}), bigIntFields: CAMPOS_ID_GRANDE }
    );
    if (!resp || !resp.ok || !Array.isArray(resp.data)) {
      const motivo = `Mercado Livre respondeu ${(resp && resp.status) || "sem resposta"}`;
      for (const id of lote) falhas.push({ itemId: String(id), motivo });
      continue;
    }
    const vistos = new Set();
    for (const entry of resp.data) {
      const body = entry && entry.body;
      const id = body && body.id ? String(body.id) : null;
      if (entry && entry.code === 200 && id) {
        vistos.add(id);
        const c = contexto(id);
        registros.push(mapearItem(body, clienteId, c.slug, c.contaId, c.mlUserId));
      } else if (id) {
        vistos.add(id);
        falhas.push({ itemId: id, motivo: `Mercado Livre respondeu ${(entry && entry.code) || "sem código"}` });
      }
    }
    for (const id of lote) {
      if (!vistos.has(String(id))) falhas.push({ itemId: String(id), motivo: "Mercado Livre não devolveu o item" });
    }
  }
  return { registros, falhas };
}

// -----------------------------------------------------------------------------
// Sincronização principal.
// modo: "novos"    -> apenas anúncios ainda não gravados (uso diário, rápido)
//       "completo" -> reprocessa todos os anúncios (manutenção, mais lento)
//
// Retorno padronizado (sempre com `ok`), no mesmo espírito do módulo Ads:
//   { ok:true, codigo:"OK", modo, totalEncontrados, totalProcessados,
//     totalSalvos, limitado }
//   { ok:false, codigo:"NO_TOKEN"|"ML_API_ERROR", motivo }
// -----------------------------------------------------------------------------
async function sincronizar({ clienteId, clienteSlug, modo, clienteContaId = null }) {
  const modoFinal = modo === "completo" ? "completo" : "novos";

  await anunciosService.ensureSchema();

  let contexto;
  try {
    contexto = await anunciosService.resolverContextoConta({ clienteId, clienteContaId, requireUsableGrant: true });
  } catch (err) {
    if (err.statusCode) throw err; // 409 MULTIPLE_MARKETPLACE_ACCOUNTS propaga intacto
    contexto = null;
  }
  const mlUserId = contexto?.mlUserId || null;
  if (!mlUserId) {
    return {
      ok: false,
      codigo: "NO_TOKEN",
      motivo:
        "Este cliente ainda não tem uma conta do Mercado Livre conectada.",
    };
  }
  const { contaId } = contexto;

  // 1. coletar ids
  const coleta = await coletarItemIds(clienteId, mlUserId);
  if (!coleta.ok) {
    return {
      ok: false,
      codigo: "ML_API_ERROR",
      motivo: `Não foi possível listar os anúncios na API do Mercado Livre (HTTP ${
        coleta.status || "?"
      }).`,
    };
  }

  const totalEncontrados = coleta.ids.length;
  let ids = coleta.ids.slice();

  // 2. modo novos -> remove os já existentes
  // Os já gravados que NÃO estão ativos (pausado, em revisão…) voltam junto:
  // reativar no Mercado Livre não faz o anúncio "novo", e sem isso o status
  // gravado ficava pausado para sempre.
  if (modoFinal === "novos") {
    const existentes = await anunciosService.itemIdsExistentes(clienteId);
    const naoAtivos = await anunciosService.itemIdsNaoAtivos(clienteId);
    ids = ids.filter((id) => !existentes.has(String(id)) || naoAtivos.has(String(id)));
  }

  if (ids.length === 0) {
    return {
      ok: true,
      codigo: "OK",
      modo: modoFinal,
      totalEncontrados,
      totalProcessados: 0,
      totalSalvos: 0,
      limitado: false,
      mensagem:
        modoFinal === "novos"
          ? "Nenhum anúncio novo encontrado."
          : "Nenhum anúncio retornado pela conta.",
    };
  }

  // teto de segurança
  let limitado = false;
  if (ids.length > MAX_ITENS) {
    ids = ids.slice(0, MAX_ITENS);
    limitado = true;
  }

  // 3. leitura item a item (via mlFetch), com as falhas contadas
  const { registros, falhas } = await lerRegistros({
    clienteId,
    ids,
    mlUserId,
    contexto: () => ({ slug: clienteSlug, contaId, mlUserId }),
  });
  if (registros.length === 0) {
    return {
      ok: false,
      codigo: "ML_API_ERROR",
      motivo: `Não foi possível ler nenhum dos ${ids.length} anúncios no Mercado Livre (${falhas[0] ? falhas[0].motivo : "sem resposta"}). Tente de novo em alguns minutos.`,
    };
  }

  // 4. upsert
  const totalSalvos = await anunciosService.upsertAnuncios(registros);

  // 5. espelha os User Products do lote. Zero chamada extra ao Mercado Livre —
  // family_id/site_id/domain_id já vieram no multiget acima. A tabela de UP é
  // derivada: se falhar, o anúncio (que é o dado) continua salvo e a próxima
  // sincronização reconstrói a linha.
  let userProducts = 0;
  try {
    userProducts = await familiaService.registrarUserProducts(registros);
  } catch (error) {
    console.error(JSON.stringify({
      event: "meli_user_products_falhou",
      cliente_id: clienteId,
      conta_id: contaId,
      error: error && error.message,
    }));
  }

  return {
    ok: true,
    codigo: "OK",
    modo: modoFinal,
    contaId,
    mlUserId,
    totalEncontrados,
    totalProcessados: ids.length,
    totalSalvos,
    userProducts,
    limitado,
    totalFalhas: falhas.length,
    falhas: falhas.slice(0, 20),
    ...(falhas.length
      ? { mensagem: `${falhas.length} anúncio(s) não puderam ser lidos no Mercado Livre agora e ficaram como estavam. Sincronize de novo para tentar outra vez.` }
      : {}),
  };
}

// -----------------------------------------------------------------------------
// Atualiza só os itens informados (que o portal JÁ conhece) relendo-os no ML.
// Usado pelo webhook de `items`: status/estoque/preço mudam no ML e o portal
// acompanha sem esperar um sync manual. Itens desconhecidos são ignorados — a
// entrada de anúncio novo continua sendo do sync.
// -----------------------------------------------------------------------------
async function atualizarItensConhecidos({ clienteId, itemIds }) {
  const unicos = [...new Set((itemIds || []).map((i) => String(i)).filter((i) => /^MLB\d+$/.test(i)))];
  if (unicos.length === 0) return { ok: true, atualizados: 0, falhas: [] };

  await anunciosService.ensureSchema();
  const contexto = await anunciosService.contextoDosItens(clienteId, unicos);
  if (contexto.length === 0) return { ok: true, atualizados: 0, falhas: [] };

  const porId = new Map(contexto.map((c) => [String(c.item_id), c]));
  // Um cliente pode ter mais de uma conta do ML: cada item é lido com o token
  // da conta a que pertence (ler com a conta errada dá 403 access_denied).
  const porConta = new Map();
  for (const c of contexto) {
    const k = c.ml_user_id ? String(c.ml_user_id) : "";
    if (!porConta.has(k)) porConta.set(k, []);
    porConta.get(k).push(String(c.item_id));
  }
  const registros = [];
  const falhas = [];
  for (const [mlUserId, ids] of porConta) {
    const lido = await lerRegistros({
      clienteId,
      ids,
      mlUserId: mlUserId || null,
      contexto: (id) => {
        const c = porId.get(id);
        return { slug: c.cliente_slug, contaId: c.cliente_conta_id, mlUserId: c.ml_user_id };
      },
    });
    registros.push(...lido.registros);
    falhas.push(...lido.falhas);
  }

  const atualizados = await anunciosService.upsertAnuncios(registros);
  try {
    await familiaService.registrarUserProducts(registros);
  } catch (error) {
    console.error(JSON.stringify({
      event: "meli_user_products_falhou",
      cliente_id: clienteId,
      error: error && error.message,
    }));
  }
  return { ok: true, atualizados, falhas };
}

module.exports = {
  sincronizar,
  atualizarItensConhecidos,
  calcularScore,
  mapearItem,
};
