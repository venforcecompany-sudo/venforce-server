// server/services/automacoes/precificacaoService.js
// Services de automações de precificação.
// Extraído de server/index.js sem alterar endpoints, payloads ou cálculos.

const pool = require("../../config/database");
const { mlFetch } = require("../../utils/mlClient");

function normalizarSlug(nome) {
  return String(nome || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function criarErroHttp(statusCode, payload) {
  const err = new Error(payload?.erro || "Erro");
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

async function gerarPreviewPrecificacao({ clienteSlugRaw, baseSlugRaw }) {
  const clienteSlugRawStr = String(clienteSlugRaw || "").trim();
  const baseSlugRawStr = String(baseSlugRaw || "").trim();

  if (!clienteSlugRawStr) throw criarErroHttp(400, { ok: false, erro: "clienteSlug é obrigatório" });
  if (!baseSlugRawStr) throw criarErroHttp(400, { ok: false, erro: "baseSlug é obrigatório" });

  const clienteSlug = normalizarSlug(clienteSlugRawStr);
  const baseSlug = normalizarSlug(baseSlugRawStr);

  const c = await pool.query(
    "SELECT id, nome, slug, ativo, created_at FROM clientes WHERE slug = $1",
    [clienteSlug]
  );
  if (!c.rows.length) throw criarErroHttp(404, { ok: false, erro: "Cliente não encontrado." });

  const b = await pool.query(
    "SELECT id, nome, slug, ativo, created_at, updated_at FROM bases WHERE slug = $1",
    [baseSlug]
  );
  if (!b.rows.length) throw criarErroHttp(404, { ok: false, erro: "Base não encontrada." });

  const base = b.rows[0];
  const custos = await pool.query(
    "SELECT produto_id, custo_produto, imposto_percentual, taxa_fixa FROM custos WHERE base_id = $1 ORDER BY produto_id ASC",
    [base.id]
  );

  const totalItens = custos.rows.length;
  const itensPreview = custos.rows.slice(0, 10).map((row) => ({
    produto_id: row.produto_id,
    custo_produto: Number(row.custo_produto),
    imposto_percentual: Number(row.imposto_percentual),
    taxa_fixa: Number(row.taxa_fixa),
  }));

  return {
    ok: true,
    cliente: c.rows[0],
    base: {
      id: base.id,
      nome: base.nome,
      slug: base.slug,
      ativo: base.ativo,
      created_at: base.created_at,
      updated_at: base.updated_at,
    },
    totalItens,
    itensPreview,
  };
}

async function gerarPreviewPrecificacaoMl({
  clienteSlugRaw,
  baseSlugRaw,
  pageRaw,
  limitRaw,
  margemAlvoRaw,
}) {
  const clienteSlugRawStr = String(clienteSlugRaw || "").trim();
  const baseSlugRawStr = String(baseSlugRaw || "").trim();

  if (!clienteSlugRawStr) throw criarErroHttp(400, { ok: false, erro: "clienteSlug é obrigatório" });
  if (!baseSlugRawStr) throw criarErroHttp(400, { ok: false, erro: "baseSlug é obrigatório" });

  const clienteSlug = normalizarSlug(clienteSlugRawStr);
  const baseSlug = normalizarSlug(baseSlugRawStr);

  const page = Math.max(1, parseInt(pageRaw) || 1);
  const limit = Math.min(Math.max(1, parseInt(limitRaw) || 20), 20);
  const offset = (page - 1) * limit;
  const parsedMargemAlvo = Number(margemAlvoRaw);
  const margemAlvo =
    Number.isFinite(parsedMargemAlvo) && parsedMargemAlvo >= 0.01 && parsedMargemAlvo <= 0.99
      ? parsedMargemAlvo
      : null;

  const c = await pool.query(
    "SELECT id, nome, slug, ativo, created_at FROM clientes WHERE slug = $1",
    [clienteSlug]
  );
  if (!c.rows.length) throw criarErroHttp(404, { ok: false, erro: "Cliente não encontrado." });
  const cliente = c.rows[0];

  const b = await pool.query(
    "SELECT id, nome, slug, ativo, created_at, updated_at FROM bases WHERE slug = $1",
    [baseSlug]
  );
  if (!b.rows.length) throw criarErroHttp(404, { ok: false, erro: "Base não encontrada." });
  const base = b.rows[0];

  const custosRes = await pool.query(
    "SELECT produto_id, custo_produto, imposto_percentual, taxa_fixa FROM custos WHERE base_id = $1",
    [base.id]
  );
  const custosMapExact = new Map();
  const custosMapNorm = new Map();
  const custosMapNumeric = new Map();
  custosRes.rows.forEach((row) => {
    const key = String(row.produto_id || "").trim();
    if (!key) return;
    const payload = {
      custoProduto: Number(row.custo_produto),
      impostoPercentual: Number(row.imposto_percentual),
      taxaFixa: Number(row.taxa_fixa),
    };
    custosMapExact.set(key, payload);
    custosMapNorm.set(key.toUpperCase(), payload);
    if (/^\d+$/.test(key)) custosMapNumeric.set(key, payload);
  });

  // ML (somente leitura): usar ml_user_id já vinculado ao cliente
  const tokenRow = await pool.query(
    "SELECT ml_user_id FROM ml_tokens WHERE cliente_id = $1",
    [cliente.id]
  );
  if (!tokenRow.rows.length) {
    throw criarErroHttp(404, { ok: false, erro: "Cliente sem conta ML vinculada." });
  }
  const mlUserId = tokenRow.rows[0].ml_user_id;

  // Somente leitura (anúncios/dados): esta rota faz apenas GET no ML.
  // Refresh OAuth é permitido aqui só para evitar quebra por expiração do access_token; isso não altera anúncios/preços/estoque/campanhas.
  // 1) Buscar ids de itens ativos do cliente (paginado)
  const search = await mlFetch(
    cliente.id,
    `/users/${mlUserId}/items/search?status=active&offset=${offset}&limit=${limit}`
  );
  if (!search.ok) {
    throw criarErroHttp(search.status, { ok: false, erro: search.data?.message || "Erro ao buscar itens no ML.", status: search.status, data: search.data });
  }

  const totalItensMl = search.data?.paging?.total ?? 0;
  const ids = Array.isArray(search.data?.results) ? search.data.results : [];

  // 2) Buscar detalhes de itens em lote (somente leitura)
  let details = [];
  if (ids.length > 0) {
    // Observação: o endpoint do ML espera ids separados por vírgula; não codificar vírgulas evita incompatibilidades.
    const batch = await mlFetch(cliente.id, `/items?ids=${ids.join(",")}`);
    if (!batch.ok) {
      throw criarErroHttp(batch.status, { ok: false, erro: batch.data?.message || "Erro ao buscar detalhes dos itens no ML.", status: batch.status, data: batch.data });
    }
    details = Array.isArray(batch.data) ? batch.data : [];
  }

  const linhas = await Promise.all(details.map(async (entry) => {
    const body = entry?.body || null;
    const itemId = String(body?.id || entry?.id || "").trim();
    const itemNorm = itemId.toUpperCase();

    // Matching conservador:
    // 1) match exato
    // 2) match normalizado (trim + uppercase)
    // 3) se item começar com MLB, tenta o número contra produto_id numérico da base
    // Observação: MLBU NÃO é tratado como equivalente automático a MLB numérico.
    let baseRow =
      custosMapExact.get(itemId) ||
      custosMapNorm.get(itemNorm) ||
      null;

    const observacoes = [];

    if (!baseRow && itemNorm.startsWith("MLBU")) {
      observacoes.push("item MLBU não é casado automaticamente com produto_id numérico da base");
    }

    if (!baseRow && itemNorm.startsWith("MLB") && !itemNorm.startsWith("MLBU")) {
      const num = itemNorm.slice(3).match(/^\d+/)?.[0] || "";
      if (num && custosMapNumeric.has(num)) {
        baseRow = custosMapNumeric.get(num);
        observacoes.push("match realizado pelo número do MLB (base sem prefixo)");
      }
    }

    const custoProduto = baseRow ? baseRow.custoProduto : null;
    const impostoPercentual = baseRow ? baseRow.impostoPercentual : null;
    const taxaFixa = baseRow ? baseRow.taxaFixa : null;

    // Campos ML disponíveis via leitura (GET /items e /users/.../items/search)
    const precoVendaAtual = (typeof body?.price === "number") ? body.price : (body?.price != null ? Number(body.price) : null);
    const listingTypeId = body?.listing_type_id || null;
    const categoryId = body?.category_id || null;
    const sellerId = body?.seller_id || null;
    const condition = body?.condition || "new";
    const logisticType = body?.shipping?.logistic_type || "xd_drop_off";
    const freeShipping = body?.shipping?.free_shipping ?? true;

    const precoOriginal =
      body?.price != null && Number.isFinite(Number(body.price)) && Number(body.price) > 0
        ? Number(body.price)
        : null;

    let precoPromocionado = null;
    try {
      if (itemId) {
        const pricesResp = await mlFetch(cliente.id, `/items/${encodeURIComponent(itemId)}/prices`);
        const pricesList = Array.isArray(pricesResp?.data?.prices) ? pricesResp.data.prices : [];
        const promoEntry = pricesList.find(p => p?.type === "promotion" && Number.isFinite(Number(p?.amount)) && Number(p.amount) > 0);
        const standardEntry = pricesList.find(p => p?.type === "standard" && Number.isFinite(Number(p?.amount)) && Number(p.amount) > 0);
        if (promoEntry) {
          precoPromocionado = Number(promoEntry.amount);
        } else if (standardEntry) {
          precoPromocionado = Number(standardEntry.amount);
        } else {
          const amounts = pricesList.map(p => Number(p?.amount)).filter(n => Number.isFinite(n) && n > 0);
          if (amounts.length > 0) precoPromocionado = Math.min(...amounts);
        }
      }
    } catch (_) {
      precoPromocionado = null;
    }

    const precoEfetivo = precoPromocionado ?? precoOriginal;

    const [listingPricesResp, shippingResp] = await Promise.all([
      (async () => {
        if (precoEfetivo === null || !listingTypeId || !categoryId) return null;
        const query = `/sites/MLB/listing_prices?price=${encodeURIComponent(precoEfetivo)}&listing_type_id=${encodeURIComponent(listingTypeId)}&category_id=${encodeURIComponent(categoryId)}`;
        try {
          return await mlFetch(cliente.id, query);
        } catch (_) {
          return null;
        }
      })(),
      (async () => {
        if (precoEfetivo === null || !sellerId || !listingTypeId || !itemId) return null;
        const query = `/users/${encodeURIComponent(sellerId)}/shipping_options/free?item_id=${encodeURIComponent(itemId)}&verbose=true&item_price=${encodeURIComponent(precoEfetivo)}&listing_type_id=${encodeURIComponent(listingTypeId)}&mode=me2&condition=${encodeURIComponent(condition)}&logistic_type=${encodeURIComponent(logisticType)}&free_shipping=${encodeURIComponent(freeShipping)}`;
        try {
          return await mlFetch(cliente.id, query);
        } catch (_) {
          return null;
        }
      })(),
    ]);

    const listingPricesData =
      listingPricesResp && listingPricesResp.ok ? listingPricesResp.data : null;
    const listingPriceRoot = Array.isArray(listingPricesData)
      ? listingPricesData[0]
      : (Array.isArray(listingPricesData?.results) ? listingPricesData.results[0] : listingPricesData);
    const comissaoMarketplace =
      listingPriceRoot?.sale_fee_amount != null ? Number(listingPriceRoot.sale_fee_amount) : null;
    const comissaoPercentual =
      listingPriceRoot?.sale_fee_details?.percentage_fee != null
        ? Number(listingPriceRoot.sale_fee_details.percentage_fee)
        : null;

    const frete =
      shippingResp && shippingResp.ok && shippingResp.data?.coverage?.all_country?.list_cost != null
        ? Number(shippingResp.data.coverage.all_country.list_cost)
        : null;
    const impostoNumero = Number(impostoPercentual);
    const impostoAliquota =
      Number.isFinite(impostoNumero) && impostoNumero >= 0
        ? (impostoNumero > 1 ? impostoNumero / 100 : impostoNumero)
        : null;

    const hasLcInputs =
      precoEfetivo !== null &&
      custoProduto !== null &&
      impostoAliquota !== null &&
      taxaFixa !== null &&
      comissaoMarketplace !== null &&
      frete !== null;

    const lucroContribuicao = hasLcInputs
      ? precoEfetivo -
        (precoEfetivo * impostoAliquota) -
        comissaoMarketplace -
        frete -
        taxaFixa -
        custoProduto
      : null;
    const margemContribuicao =
      lucroContribuicao !== null && precoEfetivo
        ? lucroContribuicao / precoEfetivo
        : null;

    let precoAlvo = null;
    let lucroAlvo = null;
    if (
      margemAlvo !== null &&
      custoProduto !== null &&
      frete !== null &&
      taxaFixa !== null &&
      impostoAliquota !== null &&
      comissaoPercentual !== null
    ) {
      const denominator =
        1 - impostoAliquota - (comissaoPercentual / 100) - margemAlvo;
      if (denominator > 0) {
        precoAlvo = (custoProduto + frete + taxaFixa) / denominator;
        lucroAlvo = precoAlvo * margemAlvo;
      }
    }

    const lucroContribuicaoPreview = lucroContribuicao;
    const margemContribuicaoPreview = margemContribuicao;

    if (!baseRow) observacoes.push("Sem correspondência na base (produto_id não encontrado).");
    if (comissaoMarketplace === null) observacoes.push("comissaoMarketplace=null (não foi possível obter no ML para este item).");
    if (frete === null) observacoes.push("frete=null (não foi possível obter no ML para este item).");
    if (lucroContribuicaoPreview === null || margemContribuicaoPreview === null) {
      observacoes.push("lucro/margem=null (faltam dados de custo/comissão/frete para este item).");
    }

    return {
      item_id: itemId || null,
      titulo: body?.title || null,
      status: body?.status || null,
      precoVendaAtual,
      tipoAnuncio: listingTypeId,
      listing_type_id: listingTypeId,
      custoProduto,
      impostoPercentual,
      taxaFixa,
      precoOriginal,
      precoPromocionado,
      precoBaseCalculo: precoEfetivo,
      precoEfetivo,
      comissaoMarketplace,
      comissaoPercentual,
      frete,
      lucroContribuicao,
      margemContribuicao,
      precoAlvo,
      lucroAlvo,
      lucroContribuicaoPreview,
      margemContribuicaoPreview,
      temBase: Boolean(baseRow),
      observacoes,
    };
  }));

  return {
    ok: true,
    cliente,
    base: {
      id: base.id,
      nome: base.nome,
      slug: base.slug,
      ativo: base.ativo,
      created_at: base.created_at,
      updated_at: base.updated_at,
    },
    page,
    limit,
    totalItensMl,
    linhas,
    fonteDados: {
      ml: {
        itens: "GET /users/{ml_user_id}/items/search?status=active",
        detalhes: "GET /items?ids=...",
      },
      base: "SELECT custos WHERE base_id = ... (produto_id = item_id/MLB)",
      camposNullPorSeguranca: ["lucroContribuicaoPreview", "margemContribuicaoPreview"],
    },
  };
}

module.exports = {
  gerarPreviewPrecificacao,
  gerarPreviewPrecificacaoMl,
};

