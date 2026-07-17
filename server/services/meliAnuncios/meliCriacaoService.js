// server/services/meliAnuncios/meliCriacaoService.js
// -----------------------------------------------------------------------------
// Módulo: Criação de Anúncios Mercado Livre
//
// Publica itens via API oficial (POST /items) reutilizando mlFetch + tokens
// já armazenados em ml_tokens. A descrição é enviada em etapa separada
// (POST /items/{id}/description), conforme documentação do ML.
// -----------------------------------------------------------------------------

const { mlFetch } = require("../../utils/mlClient");
const anunciosService = require("./meliAnunciosService");

const _dbModule = require("../../config/database");
const db =
  _dbModule && typeof _dbModule.query === "function"
    ? _dbModule
    : _dbModule.pool || _dbModule.default || _dbModule;

const SITE_ID = "MLB";
const TITLE_MAX = 60;

// -----------------------------------------------------------------------------
// Schema de auditoria das publicações criadas pelo VenForce
// -----------------------------------------------------------------------------
let _schemaPronto = false;

async function ensureSchema() {
  if (_schemaPronto) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS meli_anuncio_publicacoes (
      id              SERIAL PRIMARY KEY,
      cliente_id      INTEGER NOT NULL,
      cliente_slug    TEXT NOT NULL,
      ml_user_id      TEXT,
      item_id         TEXT,
      permalink       TEXT,
      status          TEXT,
      titulo          TEXT,
      category_id     TEXT,
      payload_json    JSONB,
      resposta_json   JSONB,
      erro_json       JSONB,
      created_by      INTEGER,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_meli_pub_cliente
       ON meli_anuncio_publicacoes (cliente_id);`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_meli_pub_item
       ON meli_anuncio_publicacoes (item_id);`
  );

  _schemaPronto = true;
}

// -----------------------------------------------------------------------------
// Mapeamento amigável de erros da API ML
// -----------------------------------------------------------------------------
const ERROS_CONHECIDOS = {
  "item.category_id.invalid": {
    campo: "category_id",
    mensagem: "A categoria informada é inválida ou não aceita publicação.",
    sugestao: "Busque novamente a categoria e selecione uma opção válida na lista.",
  },
  "item.attributes.missing_required": {
    campo: "attributes",
    mensagem: "Faltam atributos obrigatórios da categoria.",
    sugestao: "Preencha todos os atributos marcados como obrigatórios.",
  },
  "item.attribute.invalid": {
    campo: "attributes",
    mensagem: "Um ou mais atributos possuem valor inválido.",
    sugestao: "Confira os valores permitidos de cada atributo da categoria.",
  },
  "item.pictures.invalid": {
    campo: "pictures",
    mensagem: "As imagens enviadas são inválidas ou inacessíveis.",
    sugestao: "Use URLs públicas HTTPS de imagens JPG, PNG ou WEBP.",
  },
  "item.price.invalid": {
    campo: "price",
    mensagem: "O preço informado é inválido.",
    sugestao: "Informe um preço maior que zero, no formato numérico.",
  },
  "item.title.invalid": {
    campo: "title",
    mensagem: "O título do anúncio é inválido.",
    sugestao: "Use até 60 caracteres, sem caracteres especiais proibidos.",
  },
  "body.invalid_fields": {
    campo: null,
    mensagem: "Um ou mais campos do anúncio estão inválidos.",
    sugestao: "Revise os campos destacados e tente publicar novamente.",
  },
  "seller.unable_to_list": {
    campo: null,
    mensagem: "Esta conta não tem permissão para publicar anúncios.",
    sugestao: "Verifique o status da conta no Mercado Livre e as permissões do aplicativo.",
  },
  "forbidden": {
    campo: null,
    mensagem: "Acesso negado pela API do Mercado Livre.",
    sugestao: "Reconecte a conta ML do cliente e confirme o escopo de escrita.",
  },
  "unauthorized": {
    campo: null,
    mensagem: "Token do Mercado Livre inválido ou expirado.",
    sugestao: "Reconecte a conta ML em Clientes → Conectar ML.",
  },
};

function mapearErroMl(data, status) {
  const causes = Array.isArray(data && data.cause) ? data.cause : [];
  const erros = [];

  for (const cause of causes) {
    const code = String((cause && (cause.code || cause.error)) || "").trim();
    const known = ERROS_CONHECIDOS[code];
    erros.push({
      codigo: code || "ml_api_error",
      campo: known ? known.campo : inferirCampo(cause),
      mensagem:
        (known && known.mensagem) ||
        (cause && cause.message) ||
        "Erro retornado pela API do Mercado Livre.",
      sugestao:
        (known && known.sugestao) ||
        "Revise os dados do anúncio e tente novamente.",
      detalhe: cause && cause.message ? String(cause.message) : null,
    });
  }

  if (!erros.length) {
    const code = String((data && (data.error || data.code)) || "").trim();
    const known = ERROS_CONHECIDOS[code];
    erros.push({
      codigo: code || `http_${status || 400}`,
      campo: known ? known.campo : null,
      mensagem:
        (known && known.mensagem) ||
        (data && data.message) ||
        "Falha ao publicar o anúncio no Mercado Livre.",
      sugestao:
        (known && known.sugestao) ||
        "Revise os dados e tente novamente. Se persistir, reconecte a conta ML.",
      detalhe: data && data.message ? String(data.message) : null,
    });
  }

  return {
    ok: false,
    codigo: "ML_API_ERROR",
    motivo: erros[0].mensagem,
    erros,
    statusMl: status || null,
    respostaMl: data || null,
  };
}

function inferirCampo(cause) {
  const msg = String((cause && cause.message) || "").toLowerCase();
  if (msg.includes("category")) return "category_id";
  if (msg.includes("title")) return "title";
  if (msg.includes("price")) return "price";
  if (msg.includes("picture") || msg.includes("image")) return "pictures";
  if (msg.includes("quantity") || msg.includes("stock")) return "available_quantity";
  if (msg.includes("attribute")) return "attributes";
  if (msg.includes("condition")) return "condition";
  return null;
}

// -----------------------------------------------------------------------------
// Validações locais (antes de chamar a API)
// -----------------------------------------------------------------------------
function validarDadosPublicacao(dados) {
  const erros = [];
  const d = dados || {};

  const title = String(d.title || "").trim();
  if (!title) {
    erros.push({
      campo: "title",
      mensagem: "Título é obrigatório.",
      sugestao: "Informe um título descritivo do produto.",
    });
  } else if (title.length > TITLE_MAX) {
    erros.push({
      campo: "title",
      mensagem: `Título excede o limite recomendado de ${TITLE_MAX} caracteres.`,
      sugestao: `Reduza o título para no máximo ${TITLE_MAX} caracteres.`,
    });
  }

  if (!String(d.category_id || "").trim()) {
    erros.push({
      campo: "category_id",
      mensagem: "Categoria é obrigatória.",
      sugestao: "Busque e selecione uma categoria do Mercado Livre.",
    });
  }

  const price = Number(d.price);
  if (!Number.isFinite(price) || price <= 0) {
    erros.push({
      campo: "price",
      mensagem: "Preço deve ser maior que zero.",
      sugestao: "Informe um valor numérico positivo.",
    });
  }

  const qty = Number(d.available_quantity);
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
    erros.push({
      campo: "available_quantity",
      mensagem: "Estoque deve ser um número inteiro positivo.",
      sugestao: "Informe a quantidade disponível (mínimo 1).",
    });
  }

  if (!String(d.condition || "").trim()) {
    erros.push({
      campo: "condition",
      mensagem: "Condição do produto é obrigatória.",
      sugestao: "Selecione novo, usado ou recondicionado.",
    });
  }

  if (!String(d.currency_id || "").trim()) {
    erros.push({
      campo: "currency_id",
      mensagem: "Moeda é obrigatória.",
      sugestao: "Use BRL para o site MLB.",
    });
  }

  if (!String(d.buying_mode || "").trim()) {
    erros.push({
      campo: "buying_mode",
      mensagem: "Modo de compra é obrigatório.",
      sugestao: "Use buy_it_now (compra imediata).",
    });
  }

  if (!String(d.listing_type_id || "").trim()) {
    erros.push({
      campo: "listing_type_id",
      mensagem: "Tipo de anúncio é obrigatório.",
      sugestao: "Selecione gold_special, gold_pro ou outro tipo disponível.",
    });
  }

  const pictures = Array.isArray(d.pictures) ? d.pictures : [];
  if (!pictures.length) {
    erros.push({
      campo: "pictures",
      mensagem: "Pelo menos uma imagem é obrigatória.",
      sugestao: "Adicione ao menos uma URL pública de imagem do produto.",
    });
  } else {
    pictures.forEach((pic, idx) => {
      const src = String((pic && pic.source) || "").trim();
      if (!src || !/^https?:\/\//i.test(src)) {
        erros.push({
          campo: "pictures",
          mensagem: `Imagem #${idx + 1} possui URL inválida.`,
          sugestao: "Use uma URL completa iniciando com http:// ou https://.",
        });
      }
    });
  }

  const requiredAttrs = Array.isArray(d.requiredAttributeIds)
    ? d.requiredAttributeIds
    : [];
  const attributes = Array.isArray(d.attributes) ? d.attributes : [];
  const filled = new Set(
    attributes
      .filter((a) => {
        if (!a || !a.id) return false;
        const hasValueId = a.value_id != null && String(a.value_id).trim() !== "";
        const hasValueName =
          a.value_name != null && String(a.value_name).trim() !== "";
        return hasValueId || hasValueName;
      })
      .map((a) => String(a.id))
  );

  for (const attrId of requiredAttrs) {
    if (!filled.has(String(attrId))) {
      erros.push({
        campo: "attributes",
        mensagem: `Atributo obrigatório ausente: ${attrId}.`,
        sugestao: "Preencha todos os atributos obrigatórios da categoria.",
      });
    }
  }

  return erros;
}

// -----------------------------------------------------------------------------
// Montagem do payload ML (genérico por categoria)
// -----------------------------------------------------------------------------
function montarAtributo(attr) {
  if (!attr || !attr.id) return null;
  const out = { id: String(attr.id) };
  if (attr.value_id != null && String(attr.value_id).trim() !== "") {
    out.value_id = String(attr.value_id);
  }
  if (attr.value_name != null && String(attr.value_name).trim() !== "") {
    out.value_name = String(attr.value_name).trim();
  }
  if (out.value_id == null && out.value_name == null) return null;
  return out;
}

function montarSaleTerm(term) {
  if (!term || !term.id) return null;
  const out = { id: String(term.id) };
  if (term.value_id != null && String(term.value_id).trim() !== "") {
    out.value_id = String(term.value_id);
  }
  if (term.value_name != null && String(term.value_name).trim() !== "") {
    out.value_name = String(term.value_name).trim();
  }
  if (out.value_id == null && out.value_name == null) return null;
  return out;
}

function montarVariacao(v) {
  if (!v || typeof v !== "object") return null;
  const out = {};

  if (v.price != null) out.price = Number(v.price);
  if (v.available_quantity != null) {
    out.available_quantity = Number(v.available_quantity);
  }
  if (Array.isArray(v.attribute_combinations)) {
    out.attribute_combinations = v.attribute_combinations
      .map(montarAtributo)
      .filter(Boolean);
  }
  if (Array.isArray(v.picture_ids)) {
    out.picture_ids = v.picture_ids.map(String);
  }
  if (Array.isArray(v.attributes)) {
    out.attributes = v.attributes.map(montarAtributo).filter(Boolean);
  }
  if (v.seller_custom_field) {
    out.seller_custom_field = String(v.seller_custom_field);
  }

  return Object.keys(out).length ? out : null;
}

function montarPayloadItem(dados) {
  const d = dados || {};
  const payload = {
    title: String(d.title || "").trim(),
    category_id: String(d.category_id || "").trim(),
    price: Number(d.price),
    currency_id: String(d.currency_id || "BRL").trim(),
    available_quantity: Number(d.available_quantity),
    buying_mode: String(d.buying_mode || "buy_it_now").trim(),
    condition: String(d.condition || "new").trim(),
    listing_type_id: String(d.listing_type_id || "").trim(),
    pictures: (Array.isArray(d.pictures) ? d.pictures : [])
      .map((p) => ({ source: String((p && p.source) || "").trim() }))
      .filter((p) => p.source),
  };

  const attributes = (Array.isArray(d.attributes) ? d.attributes : [])
    .map(montarAtributo)
    .filter(Boolean);
  if (attributes.length) payload.attributes = attributes;

  const saleTerms = (Array.isArray(d.sale_terms) ? d.sale_terms : [])
    .map(montarSaleTerm)
    .filter(Boolean);
  if (saleTerms.length) payload.sale_terms = saleTerms;

  const variations = (Array.isArray(d.variations) ? d.variations : [])
    .map(montarVariacao)
    .filter(Boolean);
  if (variations.length) {
    payload.variations = variations;
    // Com variações, o estoque/preço ficam nas variações (API ML).
    delete payload.available_quantity;
    if (variations.some((v) => v.price != null)) {
      delete payload.price;
    }
  }

  if (d.seller_custom_field) {
    payload.seller_custom_field = String(d.seller_custom_field).trim();
  }

  if (d.shipping && typeof d.shipping === "object") {
    payload.shipping = d.shipping;
  }

  return payload;
}

// -----------------------------------------------------------------------------
// Status da conta / helpers de consulta
// -----------------------------------------------------------------------------
async function obterStatusConta(clienteId) {
  const mlUserId = await anunciosService.resolverMlUserId(clienteId);
  if (!mlUserId) {
    return {
      ok: false,
      codigo: "NO_TOKEN",
      motivo:
        "Cliente sem token Mercado Livre. Conecte a conta em Clientes → Conectar ML.",
      mlConectado: false,
      tokenValido: false,
      podePublicar: false,
    };
  }

  let me = null;
  try {
    const resp = await mlFetch(clienteId, "/users/me");
    if (!resp.ok) {
      return {
        ok: false,
        codigo: "TOKEN_INVALIDO",
        motivo: "Não foi possível validar o token do Mercado Livre.",
        mlConectado: true,
        tokenValido: false,
        podePublicar: false,
        mlUserId: String(mlUserId),
        statusMl: resp.status,
      };
    }
    me = resp.data;
  } catch (err) {
    return {
      ok: false,
      codigo: "TOKEN_INVALIDO",
      motivo: err.message || "Falha ao validar token ML.",
      mlConectado: true,
      tokenValido: false,
      podePublicar: false,
      mlUserId: String(mlUserId),
    };
  }

  const siteStatus = String(
    (me && me.status && me.status.site_status) || ""
  ).toLowerCase();
  const listAllow =
    me && me.status && me.status.list && typeof me.status.list.allow === "boolean"
      ? me.status.list.allow
      : true;
  // Conta apta quando site_status está ativo (ou ausente) e list.allow !== false.
  const podePublicar =
    (siteStatus === "active" || siteStatus === "") && listAllow !== false;

  return {
    ok: true,
    mlConectado: true,
    tokenValido: true,
    podePublicar,
    mlUserId: String(me.id || mlUserId),
    nickname: me.nickname || null,
    email: me.email || null,
    siteId: me.site_id || SITE_ID,
    statusConta: (me.status && me.status.site_status) || "unknown",
    listAllow,
    permalink: me.permalink || null,
  };
}

async function buscarCategorias(clienteId, q) {
  const termo = String(q || "").trim();
  if (!termo || termo.length < 2) {
    return { ok: false, motivo: "Informe ao menos 2 caracteres para buscar categorias." };
  }

  // domain_discovery sugere categorias a partir do título/termo do produto
  const path =
    `/sites/${SITE_ID}/domain_discovery/search?q=` +
    encodeURIComponent(termo) +
    `&limit=8`;

  const resp = await mlFetch(clienteId, path);
  if (!resp.ok) {
    return mapearErroMl(resp.data, resp.status);
  }

  const rows = Array.isArray(resp.data) ? resp.data : [];
  const categorias = rows.map((r) => ({
    category_id: r.category_id,
    category_name: r.category_name,
    domain_id: r.domain_id,
    domain_name: r.domain_name,
  }));

  return { ok: true, categorias };
}

async function obterAtributosCategoria(clienteId, categoryId) {
  const id = String(categoryId || "").trim();
  if (!id) {
    return { ok: false, motivo: "Informe categoryId." };
  }

  const resp = await mlFetch(
    clienteId,
    `/categories/${encodeURIComponent(id)}/attributes`
  );
  if (!resp.ok) {
    return mapearErroMl(resp.data, resp.status);
  }

  const attrs = Array.isArray(resp.data) ? resp.data : [];
  const atributos = attrs.map((a) => ({
    id: a.id,
    name: a.name,
    value_type: a.value_type,
    value_max_length: a.value_max_length || null,
    tags: a.tags || {},
    required: !!(a.tags && (a.tags.required || a.tags.catalog_required)),
    variationAttribute: !!(a.tags && a.tags.allow_variations),
    values: Array.isArray(a.values)
      ? a.values.map((v) => ({ id: v.id, name: v.name }))
      : [],
    allowed_units: Array.isArray(a.allowed_units) ? a.allowed_units : [],
    default_unit: a.default_unit || null,
  }));

  return {
    ok: true,
    category_id: id,
    atributos,
    obrigatorios: atributos.filter((a) => a.required).map((a) => a.id),
  };
}

async function obterSaleTermsCategoria(clienteId, categoryId) {
  const id = String(categoryId || "").trim();
  if (!id) {
    return { ok: false, motivo: "Informe categoryId." };
  }

  const resp = await mlFetch(
    clienteId,
    `/categories/${encodeURIComponent(id)}/sale_terms`
  );
  if (!resp.ok) {
    // Algumas categorias podem não expor sale_terms — não bloqueia o fluxo.
    return { ok: true, category_id: id, saleTerms: [] };
  }

  const terms = Array.isArray(resp.data) ? resp.data : [];
  return {
    ok: true,
    category_id: id,
    saleTerms: terms.map((t) => ({
      id: t.id,
      name: t.name,
      value_type: t.value_type,
      tags: t.tags || {},
      required: !!(t.tags && t.tags.required),
      values: Array.isArray(t.values)
        ? t.values.map((v) => ({ id: v.id, name: v.name }))
        : [],
      allowed_units: Array.isArray(t.allowed_units) ? t.allowed_units : [],
      default_unit: t.default_unit || null,
    })),
  };
}

async function obterTiposAnuncio(clienteId) {
  const resp = await mlFetch(clienteId, `/sites/${SITE_ID}/listing_types`);
  if (!resp.ok) {
    return mapearErroMl(resp.data, resp.status);
  }
  const types = Array.isArray(resp.data) ? resp.data : [];
  return {
    ok: true,
    listingTypes: types.map((t) => ({
      id: t.id,
      name: t.name,
    })),
  };
}

// -----------------------------------------------------------------------------
// Persistência
// -----------------------------------------------------------------------------
async function salvarPublicacao({
  clienteId,
  clienteSlug,
  mlUserId,
  itemId,
  permalink,
  status,
  titulo,
  categoryId,
  payload,
  resposta,
  erro,
  createdBy,
}) {
  await ensureSchema();
  const { rows } = await db.query(
    `INSERT INTO meli_anuncio_publicacoes (
       cliente_id, cliente_slug, ml_user_id, item_id, permalink, status,
       titulo, category_id, payload_json, resposta_json, erro_json, created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id, item_id, permalink, status, created_at;`,
    [
      clienteId,
      clienteSlug,
      mlUserId ? String(mlUserId) : null,
      itemId || null,
      permalink || null,
      status || null,
      titulo || null,
      categoryId || null,
      JSON.stringify(payload || {}),
      resposta ? JSON.stringify(resposta) : null,
      erro ? JSON.stringify(erro) : null,
      createdBy || null,
    ]
  );
  return rows[0] || null;
}

async function upsertCatalogoLocal(clienteId, clienteSlug, item) {
  if (!item || !item.id) return;
  try {
    const pictures = (Array.isArray(item.pictures) ? item.pictures : [])
      .map((p) => p && (p.secure_url || p.url || p.source))
      .filter(Boolean);

    await anunciosService.upsertAnuncios([
      {
        cliente_id: clienteId,
        cliente_slug: clienteSlug,
        item_id: item.id,
        sku: item.seller_custom_field || null,
        titulo: item.title || null,
        marca: null,
        modelo: null,
        preco: item.price != null ? item.price : null,
        preco_original: item.original_price != null ? item.original_price : null,
        moeda: item.currency_id || null,
        estoque:
          item.available_quantity != null ? item.available_quantity : null,
        vendidos: item.sold_quantity != null ? item.sold_quantity : 0,
        status: item.status || null,
        sub_status: Array.isArray(item.sub_status)
          ? item.sub_status.join(",")
          : item.sub_status || null,
        listing_type_id: item.listing_type_id || null,
        category_id: item.category_id || null,
        permalink: item.permalink || null,
        thumbnail: item.secure_thumbnail || item.thumbnail || pictures[0] || null,
        pictures_count: pictures.length,
        pictures_json: pictures,
        logistic_type:
          (item.shipping && item.shipping.logistic_type) || null,
        is_full:
          item.shipping && item.shipping.logistic_type === "fulfillment",
        attributes_json: Array.isArray(item.attributes) ? item.attributes : [],
        health: typeof item.health === "number" ? item.health : null,
        score_venforce: null,
        score_motivo: "Criado via VenForce",
      },
    ]);
  } catch (err) {
    console.warn(
      "[meli-criacao] falha ao upsert local (não bloqueia):",
      err.message
    );
  }
}

// -----------------------------------------------------------------------------
// Publicação principal
// -----------------------------------------------------------------------------
async function createMercadoLivreItem({
  clienteId,
  clienteSlug,
  dados,
  createdBy,
}) {
  await ensureSchema();

  const statusConta = await obterStatusConta(clienteId);
  if (!statusConta.ok || !statusConta.tokenValido) {
    return {
      ok: false,
      codigo: statusConta.codigo || "NO_TOKEN",
      motivo: statusConta.motivo || "Conta ML indisponível.",
      http: 400,
    };
  }
  if (!statusConta.podePublicar) {
    return {
      ok: false,
      codigo: "seller.unable_to_list",
      motivo: "Esta conta não está apta a publicar anúncios no Mercado Livre.",
      erros: [
        {
          codigo: "seller.unable_to_list",
          campo: null,
          mensagem: "Conta sem permissão de listagem.",
          sugestao:
            "Verifique o status da conta no Mercado Livre (site_status) e tente novamente.",
        },
      ],
      http: 403,
    };
  }

  const errosValidacao = validarDadosPublicacao(dados);
  if (errosValidacao.length) {
    return {
      ok: false,
      codigo: "VALIDACAO",
      motivo: errosValidacao[0].mensagem,
      erros: errosValidacao.map((e) => ({
        codigo: "validation",
        campo: e.campo,
        mensagem: e.mensagem,
        sugestao: e.sugestao,
      })),
      http: 400,
    };
  }

  const payload = montarPayloadItem(dados);
  const description = String((dados && dados.description) || "").trim();

  // 1) Cria o item (sem descrição)
  let createResp;
  try {
    createResp = await mlFetch(clienteId, "/items", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch (err) {
    await salvarPublicacao({
      clienteId,
      clienteSlug,
      mlUserId: statusConta.mlUserId,
      status: "error",
      titulo: payload.title,
      categoryId: payload.category_id,
      payload,
      erro: { message: err.message },
      createdBy,
    });
    return {
      ok: false,
      codigo: "ML_FETCH_ERROR",
      motivo: err.message || "Falha de comunicação com o Mercado Livre.",
      http: 502,
    };
  }

  if (!createResp.ok) {
    const mapped = mapearErroMl(createResp.data, createResp.status);
    await salvarPublicacao({
      clienteId,
      clienteSlug,
      mlUserId: statusConta.mlUserId,
      status: "error",
      titulo: payload.title,
      categoryId: payload.category_id,
      payload,
      erro: mapped,
      createdBy,
    });
    return { ...mapped, http: createResp.status || 400 };
  }

  const item = createResp.data || {};
  const itemId = item.id;
  const permalink = item.permalink || null;

  // 2) Descrição em etapa separada
  let descricaoOk = !description;
  let descricaoErro = null;
  if (description && itemId) {
    try {
      const descResp = await mlFetch(
        clienteId,
        `/items/${encodeURIComponent(itemId)}/description`,
        {
          method: "POST",
          body: JSON.stringify({ plain_text: description }),
        }
      );
      if (descResp.ok) {
        descricaoOk = true;
      } else {
        descricaoErro = mapearErroMl(descResp.data, descResp.status);
      }
    } catch (err) {
      descricaoErro = {
        ok: false,
        codigo: "DESCRIPTION_ERROR",
        motivo: err.message || "Falha ao salvar a descrição.",
      };
    }
  }

  const registro = await salvarPublicacao({
    clienteId,
    clienteSlug,
    mlUserId: statusConta.mlUserId,
    itemId,
    permalink,
    status: item.status || "active",
    titulo: item.title || payload.title,
    categoryId: item.category_id || payload.category_id,
    payload,
    resposta: item,
    createdBy,
  });

  await upsertCatalogoLocal(clienteId, clienteSlug, item);

  return {
    ok: true,
    item_id: itemId,
    permalink,
    status: item.status || null,
    listing_type_id: item.listing_type_id || payload.listing_type_id,
    category_id: item.category_id || payload.category_id,
    descricaoSalva: descricaoOk,
    descricaoErro: descricaoErro,
    publicacaoId: registro && registro.id,
    item,
  };
}

module.exports = {
  ensureSchema,
  obterStatusConta,
  buscarCategorias,
  obterAtributosCategoria,
  obterSaleTermsCategoria,
  obterTiposAnuncio,
  validarDadosPublicacao,
  montarPayloadItem,
  mapearErroMl,
  createMercadoLivreItem,
  ERROS_CONHECIDOS,
  TITLE_MAX,
};
