// server/services/ads/mlAdsService.js
const { mlFetch } = require("../../utils/mlClient");
const pool = require("../../config/database");

// ─── Códigos de retorno ───────────────────────────────────────────────────────
// NO_TOKEN              – cliente não tem token ML configurado
// NO_ADVERTISER_FOUND   – /advertising/advertisers?product_id=PADS sem resultado
// NO_ADS_PERMISSION     – 401/403 na API de Ads
// ML_ADS_API_ERROR      – outro erro HTTP da API ML
// OK                    – tudo certo (métricas + anúncios)

// ─── Configurações ────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;
const MAX_PAGES = 60; // teto de segurança = 3000 anúncios por consulta
const METRICS_PARAM = [
  "clicks",
  "prints",
  "cost",
  "cpc",
  "ctr",
  "acos",
  "roas",
  "total_amount",
  "direct_amount",
  "indirect_amount",
].join(",");

// ─── Utilitários ──────────────────────────────────────────────────────────────

function mesRefToDateRange(mesRef) {
  const [year, month] = mesRef.split("-").map(Number);
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

function round4(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round(v * 10000) / 10000;
}

function logMl(path, status, body) {
  // Nunca imprime access_token; trunca body longo
  const snippet = body != null ? JSON.stringify(body).slice(0, 300) : "(sem corpo)";
  console.log(`[mlAds] GET ${path} → HTTP ${status} | ${snippet}`);
}

// ─── Resolver cliente + clienteId do banco ────────────────────────────────────

async function resolverClienteToken(clienteSlug) {
  const result = await pool.query(
    `SELECT c.id AS cliente_id, t.ml_user_id
     FROM clientes c
     INNER JOIN ml_tokens t ON t.cliente_id = c.id
     WHERE c.slug = $1 AND c.ativo = true
     LIMIT 1`,
    [clienteSlug]
  );

  if (!result.rows.length) {
    const existe = await pool.query(
      "SELECT id FROM clientes WHERE slug = $1 AND ativo = true",
      [clienteSlug]
    );
    if (!existe.rows.length) throw new Error(`Cliente "${clienteSlug}" não encontrado.`);
    const err = new Error("Cliente sem token Mercado Livre configurado.");
    err.adsCodigo = "NO_TOKEN";
    throw err;
  }

  return {
    clienteId: result.rows[0].cliente_id,
    mlUserId:  String(result.rows[0].ml_user_id),
  };
}

// ─── A) Resolver advertiser_id ────────────────────────────────────────────────
// GET /advertising/advertisers?product_id=PADS
// Retorna: { advertisers: [{ advertiser_id, site_id, advertiser_name, account_name }] }

async function resolverAdvertiser(clienteId) {
  const path = "/advertising/advertisers?product_id=PADS";
  let ok, status, data;
  try {
    ({ ok, status, data } = await mlFetch(clienteId, path));
  } catch (err) {
    console.warn(`[mlAds] Erro de rede em ${path}:`, err.message);
    return { advertiser: null, httpStatus: null, erro: err.message };
  }

  console.log("[mlAds][advertisers] status=", status);
  console.log(
    "[mlAds][advertisers] advertisersLength=",
    Array.isArray(data?.advertisers) ? data.advertisers.length : "not-array"
  );

  if (!ok) {
    if (status === 401 || status === 403) {
      return { advertiser: null, httpStatus: status, permissionDenied: true };
    }
    return { advertiser: null, httpStatus: status, apiData: data };
  }

  const list =
    Array.isArray(data?.advertisers) ? data.advertisers :
    Array.isArray(data?.results)     ? data.results     :
    Array.isArray(data)              ? data              :
    [];

  if (!list.length) {
    return { advertiser: null, httpStatus: status };
  }

  // Preferir advertiser com site_id === "MLB"; fallback para o primeiro
  const chosen =
    list.find((a) => String(a.site_id).toUpperCase() === "MLB") || list[0];

  if (!chosen?.advertiser_id) {
    return { advertiser: null, httpStatus: status };
  }

  const advertiser = {
    advertiserId:   String(chosen.advertiser_id),
    siteId:         String(chosen.site_id || "MLB"),
    advertiserName: chosen.advertiser_name || chosen.account_name || "",
  };
  console.log(
    `[mlAds] Advertiser resolvido: id=${advertiser.advertiserId} site=${advertiser.siteId} nome="${advertiser.advertiserName}"`
  );
  return { advertiser, httpStatus: status };
}

// ─── B) Buscar TODOS os itens com métricas (paginação completa) ──────────────
// GET /advertising/advertisers/{advertiser_id}/product_ads/items
//     ?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
//     &limit=50&offset=0
//     &metrics=clicks,prints,cost,cpc,ctr,acos,roas,total_amount,direct_amount,indirect_amount

async function buscarTodosItensComMetricas(clienteId, advertiserId, from, to) {
  const todos = [];
  let offset = 0;
  let totalApi = null;
  let paginas = 0;
  let primeiroErro = null;

  while (paginas < MAX_PAGES) {
    const path =
      `/advertising/advertisers/${advertiserId}/product_ads/items` +
      `?date_from=${from}&date_to=${to}` +
      `&limit=${PAGE_SIZE}&offset=${offset}` +
      `&metrics=${METRICS_PARAM}`;

    let ok, status, data;
    try {
      ({ ok, status, data } = await mlFetch(clienteId, path));
    } catch (err) {
      console.warn(`[mlAds] Erro de rede em items offset=${offset}:`, err.message);
      if (paginas === 0) primeiroErro = { erroRede: err.message };
      break;
    }

    logMl(path, status, data);

    if (!ok) {
      console.warn(`[mlAds] items HTTP ${status} no offset=${offset}`);
      if (paginas === 0) {
        primeiroErro = { httpStatus: status, apiData: data };
        if (status === 401 || status === 403) {
          return { permissionDenied: true, httpStatus: status, itens: [], totalApi: 0, paginas: 0 };
        }
      }
      break; // demais páginas falhando: para e devolve o que tem
    }

    const lista =
      Array.isArray(data?.results) ? data.results :
      Array.isArray(data?.ads)     ? data.ads     :
      Array.isArray(data)          ? data          :
      [];

    if (totalApi === null && data?.paging?.total != null) {
      totalApi = Number(data.paging.total);
    }

    todos.push(...lista);
    paginas += 1;

    if (lista.length < PAGE_SIZE) break;           // última página
    if (totalApi != null && offset + PAGE_SIZE >= totalApi) break;
    offset += PAGE_SIZE;
  }

  console.log(
    `[mlAds] items paginação concluída: paginas=${paginas} acumulado=${todos.length} totalApi=${totalApi}`
  );

  return {
    itens: todos,
    totalApi: totalApi ?? todos.length,
    paginas,
    primeiroErro,
  };
}

// ─── C) Cálculo do resumo agregado ────────────────────────────────────────────

function calcularResumoMetricas(itens, mesRef) {
  let cost = 0,
      totalAmount = 0,
      directAmount = 0,
      indirectAmount = 0,
      clicks = 0,
      prints = 0,
      vendas = 0,
      anunciosAtivos = 0,
      anunciosComInvest = 0;

  for (const it of itens) {
    const m = it.metrics || {};
    cost           += Number(m.cost)            || 0;
    totalAmount    += Number(m.total_amount)    || 0;
    directAmount   += Number(m.direct_amount)   || 0;
    indirectAmount += Number(m.indirect_amount) || 0;
    clicks         += Number(m.clicks)          || 0;
    prints         += Number(m.prints)          || 0;
    if ((Number(m.total_amount) || 0) > 0) vendas += 1;
    if (String(it.status || "").toLowerCase() === "active") anunciosAtivos += 1;
    if ((Number(m.cost) || 0) > 0) anunciosComInvest += 1;
  }

  const roas = cost > 0 ? totalAmount / cost : 0;
  const acos = totalAmount > 0 ? (cost / totalAmount) * 100 : 0;
  const ctr  = prints > 0 ? (clicks / prints) * 100 : 0;
  const cpc  = clicks > 0 ? cost / clicks : 0;

  return {
    mesRef,
    investimentoAds:    round2(cost),
    gmvAds:             round2(totalAmount),
    gmvDireto:          round2(directAmount),
    gmvIndireto:        round2(indirectAmount),
    roas:               round2(roas),
    acos:               round2(acos),
    ctr:                round4(ctr),
    cpc:                round2(cpc),
    cliques:            clicks,
    impressoes:         prints,
    vendas,
    totalAnuncios:      itens.length,
    anunciosAtivos,
    anunciosComInvest,
  };
}

// ─── D) Normalização dos anúncios para o frontend ─────────────────────────────

function normalizarAnuncios(itens) {
  return itens.map((it) => {
    const m = it.metrics || {};
    return {
      itemId:           it.item_id,
      campaignId:       it.campaign_id,
      adGroupId:        it.ad_group_id,
      title:            it.title || "",
      status:           it.status || "",
      price:            Number(it.price)     || 0,
      priceUsd:         Number(it.price_usd) || 0,
      thumbnail:        it.thumbnail || null,
      permalink:        it.permalink || null,
      brandValueId:     it.brand_value_id  || null,
      brandValueName:   it.brand_value_name || null,
      domainId:         it.domain_id || null,
      logisticType:     it.logistic_type || null,
      listingTypeId:    it.listing_type_id || null,
      catalogListing:   !!it.catalog_listing,
      buyBoxWinner:     !!it.buy_box_winner,
      condition:        it.condition || null,
      currentLevel:     it.current_level || null,
      hasDiscount:      !!it.has_discount,
      deferredStock:    !!it.deferred_stock,
      channel:          it.channel || null,
      dateCreated:      it.date_created || null,
      recommended:      !!it.recommended,
      imageQuality:     it.image_quality || null,
      advertiserId:     it.advertiser_id || null,
      originalAdvertiserId: it.original_advertiser_id || null,
      metrics: {
        clicks:         Number(m.clicks)          || 0,
        prints:         Number(m.prints)          || 0,
        cost:           round2(m.cost),
        cpc:            round2(m.cpc),
        ctr:            round4(m.ctr),
        acos:           round2(m.acos),
        roas:           round2(m.roas),
        directAmount:   round2(m.direct_amount),
        indirectAmount: round2(m.indirect_amount),
        totalAmount:    round2(m.total_amount),
      },
    };
  });
}

// ─── E) Lista de campanhas únicas (derivada dos itens) ────────────────────────

function extrairCampanhasDosItens(itens) {
  const map = new Map();
  for (const it of itens) {
    const cid = it.campaign_id;
    if (!cid) continue;
    const key = String(cid);
    if (!map.has(key)) {
      map.set(key, {
        campaignId: key,
        totalAnuncios: 0,
        investimentoAds: 0,
        gmvAds: 0,
        cliques: 0,
        impressoes: 0,
      });
    }
    const acc = map.get(key);
    const m = it.metrics || {};
    acc.totalAnuncios   += 1;
    acc.investimentoAds += Number(m.cost)         || 0;
    acc.gmvAds          += Number(m.total_amount) || 0;
    acc.cliques         += Number(m.clicks)       || 0;
    acc.impressoes      += Number(m.prints)       || 0;
  }
  return Array.from(map.values()).map((c) => ({
    ...c,
    investimentoAds: round2(c.investimentoAds),
    gmvAds:          round2(c.gmvAds),
    roas:            c.investimentoAds > 0 ? round2(c.gmvAds / c.investimentoAds) : 0,
  }));
}

// ─── Função principal ─────────────────────────────────────────────────────────

async function buscarPerformanceML(clienteSlug, mesRef) {
  // 1. Resolver clienteId do banco
  let clienteId, mlUserId;
  try {
    ({ clienteId, mlUserId } = await resolverClienteToken(clienteSlug));
  } catch (err) {
    if (err.adsCodigo === "NO_TOKEN") {
      return { semDados: true, codigo: "NO_TOKEN", motivo: err.message };
    }
    throw err;
  }

  const { from, to } = mesRefToDateRange(mesRef);
  console.log(`[mlAds] cliente=${clienteSlug} clienteId=${clienteId} mlUserId=${mlUserId} período=${from}→${to}`);

  // 2. Resolver advertiser_id
  const { advertiser, httpStatus, permissionDenied, apiData } =
    await resolverAdvertiser(clienteId);

  if (!advertiser) {
    if (permissionDenied) {
      return {
        semDados: true,
        codigo: "NO_ADS_PERMISSION",
        motivo: `Token ML sem permissão no endpoint de Ads (HTTP ${httpStatus}). Verifique se o escopo 'advertising' foi concedido no OAuth.`,
      };
    }
    if (httpStatus && httpStatus >= 400) {
      return {
        semDados: true,
        codigo: "ML_ADS_API_ERROR",
        motivo: `API ML Ads retornou HTTP ${httpStatus}: ${JSON.stringify(apiData).slice(0, 200)}`,
      };
    }
    return {
      semDados: true,
      codigo: "NO_ADVERTISER_FOUND",
      motivo: `Nenhum advertiser PAds encontrado para este cliente (mlUserId=${mlUserId}). Verifique se há conta ativa no Mercado Ads.`,
    };
  }

  const { advertiserId, siteId, advertiserName } = advertiser;

  // 3. Buscar TODOS os itens com métricas (paginação)
  const itensResp = await buscarTodosItensComMetricas(clienteId, advertiserId, from, to);

  if (itensResp.permissionDenied) {
    return {
      semDados: true,
      codigo: "NO_ADS_PERMISSION",
      motivo: `Sem permissão no endpoint de items (HTTP ${itensResp.httpStatus}).`,
    };
  }

  // Se erro logo na primeira página, devolver erro estruturado
  if (itensResp.primeiroErro && !itensResp.itens.length) {
    const pe = itensResp.primeiroErro;
    return {
      semDados: true,
      codigo: "ML_ADS_API_ERROR",
      motivo: pe.httpStatus
        ? `API ML Ads (items) retornou HTTP ${pe.httpStatus}: ${JSON.stringify(pe.apiData).slice(0, 200)}`
        : `Erro de rede ao chamar items: ${pe.erroRede}`,
    };
  }

  // 4. Calcular agregados e normalizar
  const itens     = itensResp.itens || [];
  const resumo    = calcularResumoMetricas(itens, mesRef);
  const anuncios  = normalizarAnuncios(itens);
  const campanhas = extrairCampanhasDosItens(itens);

  console.log(
    `[mlAds] OK — advertiser=${advertiserId} mes=${mesRef} anuncios=${anuncios.length} invest=${resumo.investimentoAds} gmv=${resumo.gmvAds} roas=${resumo.roas}`
  );

  return {
    advertiserId,
    siteId,
    advertiserName,
    mlUserId,
    periodo:   { from, to },
    ...resumo,
    anuncios,
    campanhas,
    paginas:   itensResp.paginas,
    totalApi:  itensResp.totalApi,
    codigo:    "OK",
  };
}

module.exports = { buscarPerformanceML };
