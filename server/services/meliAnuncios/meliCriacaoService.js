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
const PRECO_ATACADO_MAX_FAIXAS = 5;
const PRECO_ATACADO_CONTEXTOS = [
  "channel_marketplace",
  "user_type_business",
];

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
  await db.query(`
    ALTER TABLE meli_anuncio_publicacoes
      ADD COLUMN IF NOT EXISTS preco_atacado_status TEXT,
      ADD COLUMN IF NOT EXISTS preco_atacado_config_json JSONB,
      ADD COLUMN IF NOT EXISTS preco_atacado_erro_json JSONB;
  `);

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

  erros.push(...validarPrecoAtacado(d.precoAtacado, price));

  return erros;
}

function normalizarFaixasPrecoAtacado(precoAtacado) {
  if (!precoAtacado || !precoAtacado.habilitado) return [];
  return (Array.isArray(precoAtacado.faixas) ? precoAtacado.faixas : [])
    .map((faixa) => ({
      quantidadeMinima: Number(faixa && faixa.quantidadeMinima),
      precoUnitario: Number(faixa && faixa.precoUnitario),
    }))
    .sort((a, b) => a.quantidadeMinima - b.quantidadeMinima);
}

function validarPrecoAtacado(precoAtacado, precoNormal) {
  if (!precoAtacado || !precoAtacado.habilitado) return [];

  const erros = [];
  const faixasOriginais = Array.isArray(precoAtacado.faixas)
    ? precoAtacado.faixas
    : [];

  if (!faixasOriginais.length) {
    erros.push({
      campo: "precoAtacado.faixas",
      mensagem: "Adicione ao menos uma faixa de preço de atacado.",
      sugestao: "Informe a quantidade mínima e o preço por unidade.",
    });
    return erros;
  }

  if (faixasOriginais.length > PRECO_ATACADO_MAX_FAIXAS) {
    erros.push({
      campo: "precoAtacado.faixas",
      mensagem: `É permitido cadastrar no máximo ${PRECO_ATACADO_MAX_FAIXAS} faixas de preço de atacado.`,
      sugestao: "Remova as faixas excedentes.",
    });
  }

  const faixas = normalizarFaixasPrecoAtacado(precoAtacado);
  const quantidades = new Set();
  const precoBase = Number(precoNormal);

  faixas.forEach((faixa, index) => {
    if (
      !Number.isInteger(faixa.quantidadeMinima) ||
      faixa.quantidadeMinima <= 1
    ) {
      erros.push({
        campo: `precoAtacado.faixas.${index}.quantidadeMinima`,
        mensagem: "A quantidade mínima deve ser um número inteiro maior que 1.",
        sugestao: "Informe 2 ou mais unidades.",
      });
    } else if (quantidades.has(faixa.quantidadeMinima)) {
      erros.push({
        campo: `precoAtacado.faixas.${index}.quantidadeMinima`,
        mensagem: `A quantidade mínima ${faixa.quantidadeMinima} está repetida.`,
        sugestao: "Use uma quantidade mínima diferente em cada faixa.",
      });
    }
    quantidades.add(faixa.quantidadeMinima);

    if (!Number.isFinite(faixa.precoUnitario) || faixa.precoUnitario <= 0) {
      erros.push({
        campo: `precoAtacado.faixas.${index}.precoUnitario`,
        mensagem: "O preço por unidade deve ser maior que zero.",
        sugestao: "Informe um valor numérico positivo.",
      });
    } else if (
      Number.isFinite(precoBase) &&
      faixa.precoUnitario >= precoBase
    ) {
      erros.push({
        campo: `precoAtacado.faixas.${index}.precoUnitario`,
        mensagem: "O preço de atacado deve ser menor que o preço normal.",
        sugestao: "Reduza o preço por unidade desta faixa.",
      });
    }

    if (
      index > 0 &&
      Number.isFinite(faixa.precoUnitario) &&
      Number.isFinite(faixas[index - 1].precoUnitario) &&
      faixa.precoUnitario >= faixas[index - 1].precoUnitario
    ) {
      erros.push({
        campo: `precoAtacado.faixas.${index}.precoUnitario`,
        mensagem:
          "O preço por unidade deve diminuir conforme a quantidade aumenta.",
        sugestao: "Use preços estritamente decrescentes entre as faixas.",
      });
    }
  });

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
      precoAtacadoElegivel: false,
    };
  }

  let me = null;
  try {
    const resp = await mlFetch(
      clienteId,
      `/users/${encodeURIComponent(mlUserId)}`
    );
    if (!resp.ok) {
      return {
        ok: false,
        codigo: "TOKEN_INVALIDO",
        motivo: "Não foi possível validar o token do Mercado Livre.",
        mlConectado: true,
        tokenValido: false,
        podePublicar: false,
        precoAtacadoElegivel: false,
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
      precoAtacadoElegivel: false,
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
  const tags = Array.isArray(me && me.tags) ? me.tags.map(String) : [];

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
    precoAtacadoElegivel: tags.includes("business"),
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
// -----------------------------------------------------------------------------
// Preços por quantidade B2B
// -----------------------------------------------------------------------------
function obterPrecoStandardBase(data) {
  const prices = Array.isArray(data && data.prices) ? data.prices : [];
  return (
    prices.find((price) => {
      if (!price || price.type !== "standard" || !price.id) return false;
      const conditions = price.conditions || {};
      const contexts = Array.isArray(conditions.context_restrictions)
        ? conditions.context_restrictions
        : [];
      return (
        contexts.length === 0 &&
        (conditions.min_purchase_unit == null ||
          conditions.min_purchase_unit === "")
      );
    }) || null
  );
}

function obterFaixasB2B(data) {
  const prices = Array.isArray(data && data.prices) ? data.prices : [];
  return prices
    .filter((price) => {
      const conditions = (price && price.conditions) || {};
      const contexts = Array.isArray(conditions.context_restrictions)
        ? conditions.context_restrictions
        : [];
      return (
        price &&
        price.type === "standard" &&
        conditions.min_purchase_unit != null &&
        PRECO_ATACADO_CONTEXTOS.every((contexto) =>
          contexts.includes(contexto)
        )
      );
    })
    .map((price) => ({
      quantidadeMinima: Number(price.conditions.min_purchase_unit),
      precoUnitario: Number(price.amount),
      moeda: price.currency_id || null,
    }))
    .sort((a, b) => a.quantidadeMinima - b.quantidadeMinima);
}

function montarPayloadPrecoAtacado(precoStandardId, faixas, moeda) {
  return {
    prices: [
      { id: String(precoStandardId) },
      ...faixas.map((faixa) => ({
        amount: faixa.precoUnitario,
        currency_id: moeda,
        conditions: {
          context_restrictions: [...PRECO_ATACADO_CONTEXTOS],
          min_purchase_unit: faixa.quantidadeMinima,
        },
      })),
    ],
  };
}

function erroPrecoAtacado(codigo, motivo, extra) {
  return {
    ok: false,
    codigo,
    motivo,
    ...(extra || {}),
  };
}

function faixasConfirmadas(faixasEsperadas, faixasRecebidas, moeda) {
  if (faixasEsperadas.length !== faixasRecebidas.length) return false;
  return faixasEsperadas.every((esperada, index) => {
    const recebida = faixasRecebidas[index];
    return (
      recebida &&
      recebida.quantidadeMinima === esperada.quantidadeMinima &&
      recebida.precoUnitario === esperada.precoUnitario &&
      recebida.moeda === moeda
    );
  });
}

async function cadastrarPrecosAtacado({
  clienteId,
  itemId,
  precoAtacado,
  precoNormal,
  moeda,
}) {
  const id = String(itemId || "").trim();
  if (!id) {
    return erroPrecoAtacado(
      "ITEM_ID_AUSENTE",
      "O anúncio foi criado sem um ITEM_ID válido para cadastrar o preço de atacado."
    );
  }

  let pricesResp;
  try {
    pricesResp = await mlFetch(
      clienteId,
      `/items/${encodeURIComponent(id)}/prices`,
      { headers: { "show-all-prices": "true" } }
    );
  } catch (err) {
    return erroPrecoAtacado(
      "PRECO_ATACADO_CONSULTA",
      err.message || "Não foi possível consultar o preço padrão do anúncio."
    );
  }
  if (!pricesResp.ok) {
    const mapped = mapearErroMl(pricesResp.data, pricesResp.status);
    return erroPrecoAtacado(
      "PRECO_ATACADO_CONSULTA",
      "Não foi possível consultar o preço padrão do anúncio.",
      { statusMl: pricesResp.status, erros: mapped.erros }
    );
  }

  const standard = obterPrecoStandardBase(pricesResp.data);
  if (!standard) {
    return erroPrecoAtacado(
      "PRECO_STANDARD_NAO_ENCONTRADO",
      "O preço standard do anúncio não foi encontrado."
    );
  }

  const precoStandard = Number(standard.amount);
  const precoInformado = Number(precoNormal);
  const precoBase = Number.isFinite(precoStandard)
    ? precoStandard
    : precoInformado;
  const moedaStandard = String(standard.currency_id || "").trim();
  const moedaInformada = String(moeda || "").trim();
  const moedaBase = moedaStandard || moedaInformada;
  if (
    !moedaBase ||
    (moedaStandard && moedaInformada && moedaStandard !== moedaInformada)
  ) {
    return erroPrecoAtacado(
      "MOEDA_PRECO_ATACADO_INVALIDA",
      "O preço normal e as faixas de atacado devem usar a mesma moeda."
    );
  }

  const errosValidacao = validarPrecoAtacado(precoAtacado, precoBase);
  if (errosValidacao.length) {
    return erroPrecoAtacado(
      "VALIDACAO_PRECO_ATACADO",
      errosValidacao[0].mensagem,
      { erros: errosValidacao, http: 400 }
    );
  }

  const faixas = normalizarFaixasPrecoAtacado(precoAtacado);
  const payload = montarPayloadPrecoAtacado(standard.id, faixas, moedaBase);
  let postResp;
  try {
    postResp = await mlFetch(
      clienteId,
      `/items/${encodeURIComponent(id)}/prices/standard/quantity`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );
  } catch (err) {
    return erroPrecoAtacado(
      "PRECO_ATACADO_GRAVACAO",
      err.message || "Não foi possível cadastrar os preços de atacado.",
      { faixas }
    );
  }
  if (!postResp.ok) {
    const mapped = mapearErroMl(postResp.data, postResp.status);
    return erroPrecoAtacado(
      "PRECO_ATACADO_GRAVACAO",
      "Não foi possível cadastrar os preços de atacado.",
      {
        statusMl: postResp.status,
        erros: mapped.erros,
        faixas,
      }
    );
  }

  let confirmResp;
  try {
    confirmResp = await mlFetch(
      clienteId,
      `/items/${encodeURIComponent(id)}/prices`,
      { headers: { "show-all-prices": "true" } }
    );
  } catch (err) {
    return erroPrecoAtacado(
      "PRECO_ATACADO_CONFIRMACAO",
      err.message || "Não foi possível confirmar os preços de atacado.",
      { faixas }
    );
  }
  if (!confirmResp.ok) {
    return erroPrecoAtacado(
      "PRECO_ATACADO_CONFIRMACAO",
      "Não foi possível confirmar os preços de atacado cadastrados.",
      { statusMl: confirmResp.status, faixas }
    );
  }

  const confirmadas = obterFaixasB2B(confirmResp.data);
  if (!faixasConfirmadas(faixas, confirmadas, moedaBase)) {
    return erroPrecoAtacado(
      "PRECO_ATACADO_DIVERGENTE",
      "O Mercado Livre não confirmou todas as faixas de preço de atacado.",
      { faixas, faixasConfirmadas: confirmadas }
    );
  }

  return {
    ok: true,
    faixas: confirmadas.map(({ quantidadeMinima, precoUnitario }) => ({
      quantidadeMinima,
      precoUnitario,
    })),
    moeda: moedaBase,
  };
}

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
  precoAtacadoStatus,
  precoAtacadoConfig,
  precoAtacadoErro,
}) {
  await ensureSchema();
  const { rows } = await db.query(
    `INSERT INTO meli_anuncio_publicacoes (
       cliente_id, cliente_slug, ml_user_id, item_id, permalink, status,
       titulo, category_id, payload_json, resposta_json, erro_json, created_by,
       preco_atacado_status, preco_atacado_config_json, preco_atacado_erro_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
      precoAtacadoStatus || null,
      precoAtacadoConfig ? JSON.stringify(precoAtacadoConfig) : null,
      precoAtacadoErro ? JSON.stringify(precoAtacadoErro) : null,
    ]
  );
  return rows[0] || null;
}

async function atualizarPrecoAtacadoPublicacao({
  clienteId,
  itemId,
  status,
  config,
  erro,
}) {
  await ensureSchema();
  const { rows } = await db.query(
    `UPDATE meli_anuncio_publicacoes
        SET preco_atacado_status = $3,
            preco_atacado_config_json = $4,
            preco_atacado_erro_json = $5,
            updated_at = NOW()
      WHERE id = (
        SELECT id
          FROM meli_anuncio_publicacoes
         WHERE cliente_id = $1 AND item_id = $2
         ORDER BY created_at DESC
         LIMIT 1
      )
      RETURNING id;`,
    [
      clienteId,
      String(itemId),
      status,
      config ? JSON.stringify(config) : null,
      erro ? JSON.stringify(erro) : null,
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
  if (
    dados &&
    dados.precoAtacado &&
    dados.precoAtacado.habilitado &&
    !statusConta.precoAtacadoElegivel
  ) {
    return {
      ok: false,
      codigo: "PRECO_ATACADO_NAO_ELEGIVEL",
      motivo:
        "Esta conta não está habilitada para preços de atacado do Mercado Livre.",
      erros: [
        {
          codigo: "PRECO_ATACADO_NAO_ELEGIVEL",
          campo: "precoAtacado",
          mensagem:
            "O vendedor precisa possuir a tag business para oferecer preço de atacado.",
          sugestao:
            "Desative o preço de atacado ou use uma conta elegível para vendas B2B.",
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

  // 2) Preços por quantidade B2B, quando solicitados.
  const precoAtacadoSolicitado = !!(
    dados &&
    dados.precoAtacado &&
    dados.precoAtacado.habilitado
  );
  let precoAtacadoResultado = null;
  if (precoAtacadoSolicitado) {
    try {
      precoAtacadoResultado = await cadastrarPrecosAtacado({
        clienteId,
        itemId,
        precoAtacado: dados.precoAtacado,
        precoNormal: dados.price,
        moeda: dados.currency_id,
      });
    } catch (err) {
      precoAtacadoResultado = erroPrecoAtacado(
        "PRECO_ATACADO_ERRO_INTERNO",
        err.message || "Não foi possível cadastrar os preços de atacado."
      );
    }
  }

  // 3) Descrição em etapa separada
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
    precoAtacadoStatus: !precoAtacadoSolicitado
      ? "nao_solicitado"
      : precoAtacadoResultado && precoAtacadoResultado.ok
        ? "salvo"
        : "erro",
    precoAtacadoConfig: precoAtacadoSolicitado
      ? {
          habilitado: true,
          faixas: normalizarFaixasPrecoAtacado(dados.precoAtacado),
        }
      : null,
    precoAtacadoErro:
      precoAtacadoSolicitado &&
      precoAtacadoResultado &&
      !precoAtacadoResultado.ok
        ? {
            ...precoAtacadoResultado,
            motivo:
              "Anúncio criado, mas não foi possível cadastrar os preços de atacado.",
            detalhe: precoAtacadoResultado.motivo,
          }
        : null,
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
    precoAtacadoSolicitado,
    precoAtacadoSalvo: precoAtacadoSolicitado
      ? !!(precoAtacadoResultado && precoAtacadoResultado.ok)
      : null,
    precoAtacadoErro:
      precoAtacadoSolicitado &&
      precoAtacadoResultado &&
      !precoAtacadoResultado.ok
        ? {
            ...precoAtacadoResultado,
            motivo:
              "Anúncio criado, mas não foi possível cadastrar os preços de atacado.",
            detalhe: precoAtacadoResultado.motivo,
          }
        : null,
    precoAtacadoFaixas: precoAtacadoSolicitado
      ? (precoAtacadoResultado && precoAtacadoResultado.faixas) ||
        normalizarFaixasPrecoAtacado(dados.precoAtacado)
      : [],
    publicacaoId: registro && registro.id,
    item,
  };
}

async function retryPrecosAtacado({ clienteId, itemId, dados }) {
  await ensureSchema();

  const id = String(itemId || "").trim();
  if (!id) {
    return {
      ok: false,
      codigo: "ITEM_ID_AUSENTE",
      motivo: "Informe o ITEM_ID para cadastrar os preços de atacado.",
      http: 400,
    };
  }

  const recebido =
    dados && dados.precoAtacado
      ? dados.precoAtacado
      : {
          habilitado: true,
          faixas: dados && dados.faixas,
        };
  const config = {
    habilitado: true,
    faixas: normalizarFaixasPrecoAtacado({
      ...recebido,
      habilitado: true,
    }),
  };

  const statusConta = await obterStatusConta(clienteId);
  if (!statusConta.ok || !statusConta.tokenValido) {
    const falha = {
      ok: false,
      codigo: statusConta.codigo || "NO_TOKEN",
      motivo: statusConta.motivo || "Conta ML indisponível.",
      http: 400,
    };
    await atualizarPrecoAtacadoPublicacao({
      clienteId,
      itemId: id,
      status: "erro",
      config,
      erro: falha,
    });
    return falha;
  }
  if (!statusConta.precoAtacadoElegivel) {
    const falha = {
      ok: false,
      codigo: "PRECO_ATACADO_NAO_ELEGIVEL",
      motivo:
        "O vendedor precisa possuir a tag business para oferecer preço de atacado.",
      http: 403,
    };
    await atualizarPrecoAtacadoPublicacao({
      clienteId,
      itemId: id,
      status: "erro",
      config,
      erro: falha,
    });
    return falha;
  }

  const resultado = await cadastrarPrecosAtacado({
    clienteId,
    itemId: id,
    precoAtacado: config,
  });

  await atualizarPrecoAtacadoPublicacao({
    clienteId,
    itemId: id,
    status: resultado.ok ? "salvo" : "erro",
    config,
    erro: resultado.ok ? null : resultado,
  });

  if (!resultado.ok) {
    return {
      ...resultado,
      http: resultado.http || (resultado.statusMl >= 500 ? 502 : 400),
      item_id: id,
      precoAtacadoSalvo: false,
      precoAtacadoFaixas: resultado.faixas || config.faixas,
    };
  }

  return {
    ok: true,
    item_id: id,
    precoAtacadoSalvo: true,
    precoAtacadoErro: null,
    precoAtacadoFaixas: resultado.faixas,
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
  validarPrecoAtacado,
  normalizarFaixasPrecoAtacado,
  montarPayloadItem,
  montarPayloadPrecoAtacado,
  cadastrarPrecosAtacado,
  mapearErroMl,
  createMercadoLivreItem,
  retryPrecosAtacado,
  ERROS_CONHECIDOS,
  TITLE_MAX,
  PRECO_ATACADO_MAX_FAIXAS,
};
