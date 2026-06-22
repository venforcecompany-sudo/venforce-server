// server/services/automacoes/promocoesRetornoService.js
// Service MVP (somente leitura) da tela "Promoções com Retorno ML".
//
// Cruza anúncios ativos do Mercado Livre com a base de custo do cliente e as
// promoções oficiais disponíveis (GET /seller-promotions/items/{MLB}?app_version=v2)
// para decidir se vale a pena entrar na promoção considerando o retorno do ML.
//
// IMPORTANTE:
//   - Não persiste nada no banco.
//   - Não altera preço, estoque, anúncio ou campanha.
//   - Não entra em promoções: apenas LÊ.
//   - Refresh de token OAuth é permitido (via mlFetch) só para não quebrar por
//     expiração do access_token — isso não altera dados do cliente.

const pool = require("../../config/database");
const { mlFetch } = require("../../utils/mlClient");

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// Aceita margem/tolerância em duas convenções: 0.10 (fração) ou 10 (percentual).
// > 1  → trata como percentual e divide por 100.
// 0..1 → usa direto.
function toAliquota(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n > 1) return n / 100;
  return n;
}

// Retorna o número se for finito; caso contrário null (nunca NaN no JSON).
function fin(n) {
  return Number.isFinite(n) ? n : null;
}

// Arredonda para 2 casas mantendo null quando não há valor.
function round2OrNull(n) {
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

// Arredonda para 4 casas (margens em fração) mantendo null.
function round4OrNull(n) {
  return Number.isFinite(n) ? Number(n.toFixed(4)) : null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Limitador de concorrência simples (mesmo padrão usado no diagnóstico).
function pLimit(concorrencia) {
  const fila = [];
  let ativos = 0;
  const proximo = () => {
    ativos--;
    if (fila.length > 0) fila.shift()();
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      const run = () => {
        ativos++;
        Promise.resolve()
          .then(fn)
          .then((v) => { proximo(); resolve(v); })
          .catch((e) => { proximo(); reject(e); });
      };
      if (ativos < concorrencia) run();
      else fila.push(run);
    });
}

// Extração de SKU do corpo do item (variação reduzida do diagnóstico).
function extrairSkuMl(body) {
  const direto = [body?.seller_custom_field, body?.sku]
    .map((v) => String(v || "").trim())
    .find(Boolean);
  if (direto) return direto;

  const nomeEhSku = (txt) => String(txt || "").toLowerCase().includes("sku");
  const attrs = Array.isArray(body?.attributes) ? body.attributes : [];
  for (const a of attrs) {
    const id = String(a?.id || "");
    const name = String(a?.name || "");
    if (!nomeEhSku(id) && !nomeEhSku(name)) continue;
    const val = a?.value_name ?? a?.value_id ?? a?.value_struct?.number ?? a?.value_struct?.unit ?? null;
    const sku = String(val || "").trim();
    if (sku) return sku;
  }
  return null;
}

const PROMO_ENRICH_CONCURRENCY = 4; // chamadas ML por item em paralelo controlado

// Seleciona a promoção relevante para o item, aplicando filtros opcionais.
function escolherPromocao(lista, { campanha, status }) {
  if (!Array.isArray(lista) || !lista.length) return null;

  let candidatos = lista.filter((p) => p && typeof p === "object");

  if (status) {
    const alvo = String(status).toLowerCase();
    const filtrado = candidatos.filter(
      (p) => String(p?.status || "").toLowerCase() === alvo
    );
    if (filtrado.length) candidatos = filtrado;
  }

  if (campanha) {
    const alvo = String(campanha).toLowerCase();
    const filtrado = candidatos.filter((p) => {
      const nome = String(p?.name || "").toLowerCase();
      const tipo = String(p?.type || "").toLowerCase();
      return nome.includes(alvo) || tipo.includes(alvo);
    });
    if (filtrado.length) candidatos = filtrado;
  }

  // Preferir promoções em andamento; senão a primeira disponível.
  const ativos = candidatos.filter((p) => {
    const st = String(p?.status || "").toLowerCase();
    return st === "started" || st === "active";
  });
  const pool_ = ativos.length ? ativos : candidatos;

  // Entre as candidatas, escolher a de maior meli_percentage (maior retorno ML).
  let escolhida = null;
  let melhorMeli = -Infinity;
  for (const p of pool_) {
    const meli = Number(p?.meli_percentage);
    const score = Number.isFinite(meli) ? meli : -1;
    if (score > melhorMeli) {
      melhorMeli = score;
      escolhida = p;
    }
  }
  return escolhida || pool_[0] || null;
}

// ─── Enriquecimento por item ─────────────────────────────────────────────────

async function enriquecerItem({
  clienteId,
  body,
  baseRow,
  margemAlvo,
  tolerancia,
  filtros,
}) {
  const itemId = String(body?.id || "").trim();
  const sku = extrairSkuMl(body);
  const listingTypeId = body?.listing_type_id || null;
  const categoryId = body?.category_id || null;
  const sellerId = body?.seller_id || null;
  const titulo = body?.title || null;

  // 1) Promoções oficiais do item (somente leitura).
  let promo = null;
  try {
    if (itemId) {
      const resp = await mlFetch(
        clienteId,
        `/seller-promotions/items/${encodeURIComponent(itemId)}?app_version=v2`
      );
      if (resp?.ok) {
        const lista = Array.isArray(resp.data)
          ? resp.data
          : Array.isArray(resp.data?.results)
            ? resp.data.results
            : [];
        promo = escolherPromocao(lista, filtros);
      }
    }
  } catch (err) {
    console.warn(`[promocoes-retorno] item ${itemId} — falha ao buscar promoções: ${err.message}`);
    promo = null;
  }

  // Sem promoção disponível → não vira oferta nesta tela.
  if (!promo) return null;

  const precoOriginal = fin(Number(promo?.original_price));
  const precoPromocao = fin(Number(promo?.price));
  if (precoPromocao === null || precoPromocao <= 0) return null;

  const meliPercentage = fin(Number(promo?.meli_percentage));
  const sellerPercentage = fin(Number(promo?.seller_percentage));
  const campanha = promo?.name || null;
  const promotionId = promo?.id || null;
  const promotionType = promo?.type || null;
  const promotionStatus = promo?.status || null;
  const offerRefId = promo?.ref_id || null;

  const descontoTotal =
    precoOriginal !== null && precoPromocao !== null
      ? precoOriginal - precoPromocao
      : null;

  // retornoMl = original_price * (meli_percentage / 100)
  const retornoMl =
    precoOriginal !== null && meliPercentage !== null
      ? precoOriginal * (meliPercentage / 100)
      : null;
  const retornoPctSobreFinal =
    retornoMl !== null && precoPromocao ? retornoMl / precoPromocao : null;

  // 2) Comissão cheia e frete usando o PREÇO DA PROMOÇÃO.
  const [listingPricesResp, shippingResp] = await Promise.all([
    (async () => {
      if (!listingTypeId || !categoryId) return null;
      try {
        return await mlFetch(
          clienteId,
          `/sites/MLB/listing_prices?price=${encodeURIComponent(precoPromocao)}&listing_type_id=${encodeURIComponent(listingTypeId)}&category_id=${encodeURIComponent(categoryId)}`
        );
      } catch (_) { return null; }
    })(),
    (async () => {
      const logisticType = body?.shipping?.logistic_type || "";
      const isCombinable = ["not_specified", "custom", ""].includes(logisticType);
      if (isCombinable) return null;
      if (!sellerId || !listingTypeId || !itemId) return null;
      try {
        return await mlFetch(
          clienteId,
          `/users/${encodeURIComponent(sellerId)}/shipping_options/free?item_id=${encodeURIComponent(itemId)}&verbose=true&item_price=${encodeURIComponent(precoPromocao)}&listing_type_id=${encodeURIComponent(listingTypeId)}&mode=me2`
        );
      } catch (_) { return null; }
    })(),
  ]);

  const lpData = listingPricesResp && listingPricesResp.ok ? listingPricesResp.data : null;
  const lpRoot = Array.isArray(lpData)
    ? lpData[0]
    : Array.isArray(lpData?.results) ? lpData.results[0] : lpData;
  const comissaoCheia =
    lpRoot?.sale_fee_amount != null ? fin(Number(lpRoot.sale_fee_amount)) : null;

  const frete =
    shippingResp && shippingResp.ok && shippingResp.data?.coverage?.all_country?.list_cost != null
      ? fin(Number(shippingResp.data.coverage.all_country.list_cost))
      : null;

  // 3) Dados de custo da base.
  const temBase = !!baseRow;
  const custoProduto = temBase ? fin(Number(baseRow.custoProduto)) : null;
  const impostoPercentual = temBase ? fin(Number(baseRow.impostoPercentual)) : null;
  const taxaFixa = temBase ? fin(Number(baseRow.taxaFixa)) : null;
  const impostoAliquota = temBase ? toAliquota(impostoPercentual) : null;

  // comissaoEfetiva = max(0, comissaoCheia - retornoMl)
  const comissaoEfetiva =
    comissaoCheia !== null && retornoMl !== null
      ? Math.max(0, comissaoCheia - retornoMl)
      : (comissaoCheia !== null ? comissaoCheia : null);

  // 4) Cálculos de LC/MC (só quando todos os insumos existem).
  const temInsumos =
    temBase &&
    custoProduto !== null &&
    impostoAliquota !== null &&
    taxaFixa !== null &&
    comissaoCheia !== null &&
    frete !== null;

  let impostoValor = null;
  let lcSemRetorno = null;
  let mcSemRetorno = null;
  let lcComRetorno = null;
  let mcComRetorno = null;
  let lucroAlvo = null;
  let retornoNecessario = null;
  let faltaRetorno = null;
  let diferencaPp = null;

  if (temInsumos) {
    impostoValor = precoPromocao * impostoAliquota;

    lcSemRetorno =
      precoPromocao - impostoValor - comissaoCheia - frete - taxaFixa - custoProduto;
    mcSemRetorno = precoPromocao ? lcSemRetorno / precoPromocao : null;

    const comEf = comissaoEfetiva !== null ? comissaoEfetiva : comissaoCheia;
    lcComRetorno =
      precoPromocao - impostoValor - comEf - frete - taxaFixa - custoProduto;
    mcComRetorno = precoPromocao ? lcComRetorno / precoPromocao : null;

    if (margemAlvo !== null) {
      lucroAlvo = precoPromocao * margemAlvo;
      retornoNecessario = lucroAlvo - lcSemRetorno;
      faltaRetorno =
        retornoNecessario !== null && retornoMl !== null
          ? retornoNecessario - retornoMl
          : null;
      diferencaPp = mcComRetorno !== null ? mcComRetorno - margemAlvo : null;
    }
  }

  // 5) Classificação / decisão.
  let decisao;
  let motivo;
  if (!temBase) {
    decisao = "sem_base";
    motivo = "Produto não encontrado na base de custo.";
  } else if (frete === null) {
    decisao = "sem_frete";
    motivo = "Não foi possível estimar o frete deste anúncio.";
  } else if (comissaoCheia === null) {
    decisao = "sem_comissao";
    motivo = "Não foi possível estimar a comissão deste anúncio.";
  } else if (mcComRetorno === null) {
    decisao = "depende";
    motivo = "Faltam dados para calcular a margem com segurança.";
  } else if (margemAlvo !== null && mcComRetorno >= margemAlvo) {
    decisao = "entrar_seguro";
    motivo = "Com o retorno do ML, a margem fica igual ou acima do alvo.";
  } else if (
    margemAlvo !== null &&
    tolerancia !== null &&
    mcComRetorno >= margemAlvo - tolerancia
  ) {
    decisao = "entrar_com_tolerancia";
    motivo = "Com o retorno do ML, a margem fica dentro da tolerância do alvo.";
  } else if (mcComRetorno >= 0) {
    decisao = "depende";
    motivo = "Margem positiva, porém abaixo do alvo mesmo com o retorno do ML.";
  } else {
    decisao = "nao_entrar";
    motivo = "Mesmo com retorno ML, a margem fica negativa.";
  }

  return {
    itemId: itemId || null,
    sku: sku || null,
    titulo,
    campanha,
    promotionId,
    promotionType,
    promotionStatus,
    offerRefId,
    precoOriginal: round2OrNull(precoOriginal),
    precoPromocao: round2OrNull(precoPromocao),
    descontoTotal: round2OrNull(descontoTotal),
    meliPercentage,
    sellerPercentage,
    retornoMl: round2OrNull(retornoMl),
    retornoPctSobreFinal: round4OrNull(retornoPctSobreFinal),
    comissaoCheia: round2OrNull(comissaoCheia),
    comissaoEfetiva: round2OrNull(comissaoEfetiva),
    frete: round2OrNull(frete),
    custo: round2OrNull(custoProduto),
    impostoPercentual,
    taxaFixa: round2OrNull(taxaFixa),
    lcSemRetorno: round2OrNull(lcSemRetorno),
    mcSemRetorno: round4OrNull(mcSemRetorno),
    lcComRetorno: round2OrNull(lcComRetorno),
    mcComRetorno: round4OrNull(mcComRetorno),
    margemAlvo,
    diferencaPp: round4OrNull(diferencaPp),
    retornoNecessario: round2OrNull(retornoNecessario),
    faltaRetorno: round2OrNull(faltaRetorno),
    decisao,
    motivo,
    temBase,
    debug: {
      fonteComissao: comissaoCheia !== null ? "listing_prices" : null,
      fonteFrete: frete !== null ? "shipping_options/free" : null,
    },
  };
}

// ─── Entrada principal ───────────────────────────────────────────────────────

async function gerarPreviewPromocoesRetorno({
  clienteSlugRaw,
  baseSlugRaw,
  margemAlvoRaw,
  toleranciaRaw,
  pageRaw,
  limitRaw,
  campanhaRaw,
  statusRaw,
}) {
  const clienteSlugRawStr = String(clienteSlugRaw || "").trim();
  const baseSlugRawStr = String(baseSlugRaw || "").trim();

  if (!clienteSlugRawStr) throw criarErroHttp(400, { ok: false, erro: "clienteSlug é obrigatório" });
  if (!baseSlugRawStr) throw criarErroHttp(400, { ok: false, erro: "baseSlug é obrigatório" });

  const clienteSlug = normalizarSlug(clienteSlugRawStr);
  const baseSlug = normalizarSlug(baseSlugRawStr);

  const page = Math.max(1, parseInt(pageRaw) || 1);
  const limit = Math.min(Math.max(1, parseInt(limitRaw) || 20), 50);
  const offset = (page - 1) * limit;

  const margemAlvo = toAliquota(margemAlvoRaw);
  const tolerancia = toAliquota(toleranciaRaw);

  const filtros = {
    campanha: String(campanhaRaw || "").trim() || null,
    status: String(statusRaw || "").trim() || null,
  };

  // 1) Cliente
  const c = await pool.query(
    "SELECT id, nome, slug, ativo, created_at FROM clientes WHERE slug = $1",
    [clienteSlug]
  );
  if (!c.rows.length) throw criarErroHttp(404, { ok: false, erro: "Cliente não encontrado." });
  const cliente = c.rows[0];

  // 2) Token ML do cliente (somente leitura: precisamos do ml_user_id vinculado)
  const tokenRow = await pool.query(
    "SELECT ml_user_id FROM ml_tokens WHERE cliente_id = $1",
    [cliente.id]
  );
  if (!tokenRow.rows.length || !tokenRow.rows[0].ml_user_id) {
    throw criarErroHttp(400, { ok: false, erro: "Cliente sem conta ML vinculada." });
  }
  const mlUserId = tokenRow.rows[0].ml_user_id;

  // 3) Base
  const b = await pool.query(
    "SELECT id, nome, slug, ativo, created_at, updated_at FROM bases WHERE slug = $1",
    [baseSlug]
  );
  if (!b.rows.length) throw criarErroHttp(404, { ok: false, erro: "Base não encontrada." });
  const base = b.rows[0];

  // 4) Custos da base → mapas de match (exato, normalizado, numérico)
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

  function matchBase(itemId, sku) {
    // Tenta por MLB (exato / normalizado / número do MLB).
    const id = String(itemId || "").trim();
    const upper = id.toUpperCase();
    let baseRow = custosMapExact.get(id) || custosMapNorm.get(upper) || null;
    if (!baseRow && upper.startsWith("MLB") && !upper.startsWith("MLBU")) {
      const num = upper.slice(3).match(/^\d+/)?.[0] || "";
      if (num && custosMapNumeric.has(num)) baseRow = custosMapNumeric.get(num);
    }
    // Tenta por SKU (exato / normalizado), se houver.
    if (!baseRow && sku) {
      const sk = String(sku).trim();
      baseRow = custosMapExact.get(sk) || custosMapNorm.get(sk.toUpperCase()) || null;
    }
    return baseRow;
  }

  // 5) Anúncios ativos do seller (paginado)
  const search = await mlFetch(
    cliente.id,
    `/users/${mlUserId}/items/search?status=active&offset=${offset}&limit=${limit}`
  );
  if (!search.ok) {
    throw criarErroHttp(search.status || 502, {
      ok: false,
      erro: search.data?.message || "Erro ao buscar itens no ML.",
      status: search.status,
    });
  }

  const totalItensMl = search.data?.paging?.total ?? 0;
  const ids = Array.isArray(search.data?.results) ? search.data.results : [];

  // 6) Detalhes dos itens em lote
  let details = [];
  if (ids.length > 0) {
    for (const lote of chunk(ids, 20)) {
      try {
        const batch = await mlFetch(cliente.id, `/items?ids=${lote.join(",")}`);
        if (batch.ok && Array.isArray(batch.data)) details.push(...batch.data);
      } catch (err) {
        console.warn(`[promocoes-retorno] falha ao buscar lote de detalhes: ${err.message}`);
      }
    }
  }

  // 7) Enriquecimento por item (concorrência limitada)
  const limitar = pLimit(PROMO_ENRICH_CONCURRENCY);
  const tarefas = details.map((entry) =>
    limitar(async () => {
      const body = entry?.body || null;
      if (!body?.id) return null;
      try {
        const sku = extrairSkuMl(body);
        const baseRow = matchBase(body.id, sku);
        return await enriquecerItem({
          clienteId: cliente.id,
          body,
          baseRow,
          margemAlvo,
          tolerancia,
          filtros,
        });
      } catch (err) {
        console.warn(`[promocoes-retorno] item ${body.id} falhou: ${err.message}`);
        return null;
      }
    })
  );

  const linhas = (await Promise.all(tarefas)).filter(Boolean);

  // 8) Resumo agregado (sobre as ofertas da página atual)
  const resumo = {
    ofertasEncontradas: linhas.length,
    produtosComBase: linhas.filter((l) => l.temBase).length,
    entrarSeguro: linhas.filter((l) => l.decisao === "entrar_seguro").length,
    entrarComTolerancia: linhas.filter((l) => l.decisao === "entrar_com_tolerancia").length,
    depende: linhas.filter((l) => l.decisao === "depende").length,
    naoEntrar: linhas.filter((l) => l.decisao === "nao_entrar").length,
    semBase: linhas.filter((l) => l.decisao === "sem_base").length,
    semFrete: linhas.filter((l) => l.decisao === "sem_frete").length,
    semComissao: linhas.filter((l) => l.decisao === "sem_comissao").length,
    retornoMlTotal: round2OrNull(
      linhas.reduce((acc, l) => acc + (Number.isFinite(l.retornoMl) ? l.retornoMl : 0), 0)
    ),
    lucroTotalEstimado: round2OrNull(
      linhas.reduce((acc, l) => acc + (Number.isFinite(l.lcComRetorno) ? l.lcComRetorno : 0), 0)
    ),
    mcMediaPromocao: (() => {
      const mcs = linhas
        .map((l) => l.mcComRetorno)
        .filter((n) => Number.isFinite(n));
      if (!mcs.length) return null;
      return round4OrNull(mcs.reduce((a, b) => a + b, 0) / mcs.length);
    })(),
  };

  return {
    ok: true,
    cliente: { id: cliente.id, slug: cliente.slug, nome: cliente.nome },
    base: { id: base.id, slug: base.slug, nome: base.nome },
    page,
    limit,
    totalItensMl,
    resumo,
    linhas,
  };
}

module.exports = {
  gerarPreviewPromocoesRetorno,
};
