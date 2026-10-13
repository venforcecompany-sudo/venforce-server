// server/services/ads/mlAdsService.js
const { mlFetch } = require("../../utils/mlClient");
const { resolveMarketplaceAccountContext } = require("../clienteContas/clienteContaService");

// ─── Códigos de retorno ───────────────────────────────────────────────────────
// NO_TOKEN              – cliente não tem token ML configurado
// NO_ADVERTISER_FOUND   – /advertising/advertisers?product_id=PADS sem resultado
// NO_ADS_PERMISSION     – 401/403 na API de Ads
// ML_ADS_API_ERROR      – outro erro HTTP da API ML
// OK                    – tudo certo (métricas + anúncios)

// ─── Configurações ────────────────────────────────────────────────────────────

const PAGE_SIZE = 50;
const MAX_PAGES = 60; // teto de segurança = 3000 anúncios por consulta
const ADS_API_OPTIONS = {
  headers: {
    "Api-Version": "2",
  },
};
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

function mlFetchOptions(mlUserId) {
  return { ...ADS_API_OPTIONS, mlUserId };
}

// ─── Resolver a conta ML exata do cliente (Cliente/Conta/Grant) ───────────────
// Nunca escolhe "a conta principal" silenciosamente: com 2+ contas ativas do
// marketplace sem clienteContaId explícito, propaga o 409 estrutural para o
// chamador decidir (UI pede a conta) em vez de misturar dado entre contas.

async function resolverContextoConta(clienteSlug, clienteContaId = null, { strictIdentity = false } = {}) {
  let context;
  try {
    context = await resolveMarketplaceAccountContext({
      clienteSlug,
      marketplace: "meli",
      clienteContaId: clienteContaId || null,
      requireUsableGrant: true,
      strictIdentity,
      resolveBase: !strictIdentity,
    });
  } catch (err) {
    if (err.statusCode) throw err; // erros estruturais (404, 409) propagam intactos
    const error = new Error("Cliente sem token Mercado Livre configurado.");
    error.adsCodigo = "NO_TOKEN";
    throw error;
  }

  if (!context.mlUserId) {
    const error = new Error("Cliente sem token Mercado Livre configurado.");
    error.adsCodigo = "NO_TOKEN";
    throw error;
  }

  return {
    clienteId: context.cliente.id,
    mlUserId: context.mlUserId,
    contaId: context.conta?.id ?? null,
    contaNome: context.conta?.nome ?? null,
  };
}

// ─── A) Resolver advertiser_id ────────────────────────────────────────────────
// GET /advertising/advertisers?product_id=PADS
// Retorna: { advertisers: [{ advertiser_id, site_id, advertiser_name, account_name }] }

async function resolverAdvertiser(clienteId, mlUserId) {
  const path = "/advertising/advertisers?product_id=PADS";
  let ok, status, data;
  try {
    ({ ok, status, data } = await mlFetch(clienteId, path, mlFetchOptions(mlUserId)));
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

// ─── B) Buscar TODOS os anúncios com métricas (paginação completa) ───────────
// GET /advertising/{site_id}/advertisers/{advertiser_id}/product_ads/ads/search
//     ?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
//     &limit=50&offset=0
//     &metrics=clicks,prints,cost,cpc,ctr,acos,roas,total_amount,direct_amount,indirect_amount
//     &aggregation=sum

async function buscarTodosAnunciosComMetricas(clienteId, siteId, advertiserId, from, to, mlUserId) {
  const todos = [];
  let offset = 0;
  let totalApi = null;
  let paginas = 0;
  let primeiroErro = null;

  while (paginas < MAX_PAGES) {
    const params = new URLSearchParams({
      date_from: from,
      date_to: to,
      limit: String(PAGE_SIZE),
      offset: String(offset),
      metrics: METRICS_PARAM,
      aggregation: "sum",
    });
    const path =
      `/advertising/${encodeURIComponent(siteId)}` +
      `/advertisers/${encodeURIComponent(advertiserId)}` +
      `/product_ads/ads/search?${params.toString()}`;

    let ok, status, data;
    try {
      ({ ok, status, data } = await mlFetch(clienteId, path, mlFetchOptions(mlUserId)));
    } catch (err) {
      console.warn(`[mlAds] Erro de rede em ads/search offset=${offset}:`, err.message);
      if (paginas === 0) primeiroErro = { erroRede: err.message };
      break;
    }

    logMl(path, status, data);

    if (!ok) {
      console.warn(`[mlAds] ads/search HTTP ${status} no offset=${offset}`);
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
    `[mlAds] ads/search concluído: paginas=${paginas} acumulado=${todos.length} totalApi=${totalApi}`
  );

  return {
    itens: todos,
    totalApi: totalApi ?? todos.length,
    paginas,
    primeiroErro,
  };
}

// ─── C) Buscar campanhas com métricas ─────────────────────────────────────────
// O custo agregado das campanhas é a fonte principal do investimento mensal.
// Isso evita depender do teto de anúncios para calcular o fechamento financeiro.

async function buscarTodasCampanhasComMetricas(clienteId, siteId, advertiserId, from, to, mlUserId) {
  const todas = [];
  let offset = 0;
  let totalApi = null;
  let paginas = 0;
  let primeiroErro = null;

  while (paginas < MAX_PAGES) {
    const params = new URLSearchParams({
      date_from: from,
      date_to: to,
      limit: String(PAGE_SIZE),
      offset: String(offset),
      metrics: METRICS_PARAM,
      aggregation: "sum",
    });
    const path =
      `/advertising/${encodeURIComponent(siteId)}` +
      `/advertisers/${encodeURIComponent(advertiserId)}` +
      `/product_ads/campaigns/search?${params.toString()}`;

    let ok, status, data;
    try {
      ({ ok, status, data } = await mlFetch(clienteId, path, mlFetchOptions(mlUserId)));
    } catch (err) {
      console.warn(`[mlAds] Erro de rede em campaigns/search offset=${offset}:`, err.message);
      if (paginas === 0) primeiroErro = { erroRede: err.message };
      break;
    }

    logMl(path, status, data);

    if (!ok) {
      console.warn(`[mlAds] campaigns/search HTTP ${status} no offset=${offset}`);
      if (paginas === 0) {
        primeiroErro = { httpStatus: status, apiData: data };
        if (status === 401 || status === 403) {
          return {
            permissionDenied: true,
            httpStatus: status,
            campanhas: [],
            totalApi: 0,
            paginas: 0,
          };
        }
      }
      break;
    }

    const lista =
      Array.isArray(data?.results)   ? data.results :
      Array.isArray(data?.campaigns) ? data.campaigns :
      Array.isArray(data)            ? data :
      [];

    if (totalApi === null && data?.paging?.total != null) {
      totalApi = Number(data.paging.total);
    }

    todas.push(...lista);
    paginas += 1;

    if (lista.length < PAGE_SIZE) break;
    if (totalApi != null && offset + PAGE_SIZE >= totalApi) break;
    offset += PAGE_SIZE;
  }

  console.log(
    `[mlAds] campaigns/search concluído: paginas=${paginas} acumulado=${todas.length} totalApi=${totalApi}`
  );

  return {
    campanhas: todas,
    totalApi: totalApi ?? todas.length,
    paginas,
    primeiroErro,
  };
}

// ─── D) Cálculo do resumo agregado ────────────────────────────────────────────

function somarMetricas(registros) {
  const totais = {
    cost: 0,
    totalAmount: 0,
    directAmount: 0,
    indirectAmount: 0,
    clicks: 0,
    prints: 0,
  };

  for (const registro of registros) {
    const m = registro?.metrics || {};
    totais.cost           += Number(m.cost)            || 0;
    totais.totalAmount    += Number(m.total_amount)    || 0;
    totais.directAmount   += Number(m.direct_amount)   || 0;
    totais.indirectAmount += Number(m.indirect_amount) || 0;
    totais.clicks         += Number(m.clicks)          || 0;
    totais.prints         += Number(m.prints)          || 0;
  }

  return totais;
}

function calcularResumoMetricas(itens, campanhas, mesRef) {
  // Campanhas são a fonte principal dos totais; anúncios são fallback.
  const fonteTotais = campanhas.length ? campanhas : itens;
  const {
    cost,
    totalAmount,
    directAmount,
    indirectAmount,
    clicks,
    prints,
  } = somarMetricas(fonteTotais);

  let vendas = 0;
  let anunciosAtivos = 0;
  let anunciosComInvest = 0;

  for (const it of itens) {
    const m = it.metrics || {};
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

// ─── E) Normalização dos anúncios para o frontend ─────────────────────────────

function normalizarAnuncios(itens) {
  return itens.map((it) => {
    const m = it.metrics || {};
    return {
      itemId:           it.item_id ?? it.id ?? null,
      campaignId:       it.campaign_id ?? it.campaignId ?? null,
      adGroupId:        it.ad_group_id ?? it.adGroupId ?? null,
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

// ─── F) Normalização das campanhas ────────────────────────────────────────────

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

function normalizarCampanhas(campanhasApi, itens) {
  if (!campanhasApi.length) return extrairCampanhasDosItens(itens);

  const totalAnunciosPorCampanha = new Map();
  for (const item of itens) {
    const campaignId = item.campaign_id ?? item.campaignId;
    if (campaignId == null) continue;
    const key = String(campaignId);
    totalAnunciosPorCampanha.set(key, (totalAnunciosPorCampanha.get(key) || 0) + 1);
  }

  return campanhasApi
    .map((campanha) => {
      const campaignId =
        campanha.campaign_id ??
        campanha.campaignId ??
        campanha.id;
      if (campaignId == null) return null;

      const key = String(campaignId);
      const m = campanha.metrics || {};
      const investimentoAds = round2(m.cost);
      const gmvAds = round2(m.total_amount);

      return {
        campaignId: key,
        nome: campanha.name || campanha.title || "",
        status: campanha.status || "",
        totalAnuncios:
          Number(campanha.ads_count ?? campanha.items_count) ||
          totalAnunciosPorCampanha.get(key) ||
          0,
        investimentoAds,
        gmvAds,
        cliques: Number(m.clicks) || 0,
        impressoes: Number(m.prints) || 0,
        roas: investimentoAds > 0 ? round2(gmvAds / investimentoAds) : 0,
      };
    })
    .filter(Boolean);
}

// ─── Função principal ─────────────────────────────────────────────────────────

// `janela` (opcional) permite consultar um INTERVALO PARCIAL dentro da competência
// — usado pela Cliente 360 quando o mês corrente ainda está aberto, para não
// comparar Ads parcial com mês anterior cheio. Sem `janela`, o comportamento é o
// de sempre: a competência inteira.
async function buscarPerformanceML(clienteSlug, mesRef, janela = null, clienteContaId = null, options = {}) {
  // 1. Resolver a conta ML exata (Cliente/Conta/Grant)
  let clienteId, mlUserId, contaId, contaNome;
  try {
    ({ clienteId, mlUserId, contaId, contaNome } = await resolverContextoConta(clienteSlug, clienteContaId, options));
  } catch (err) {
    if (err.adsCodigo === "NO_TOKEN") {
      return { semDados: true, codigo: "NO_TOKEN", motivo: err.message };
    }
    throw err;
  }

  const mesInteiro = mesRefToDateRange(mesRef);
  const from = janela?.from || mesInteiro.from;
  const to = janela?.to || mesInteiro.to;
  console.log(`[mlAds] cliente=${clienteSlug} clienteId=${clienteId} mlUserId=${mlUserId} período=${from}→${to}`);

  // 2. Resolver advertiser_id
  const { advertiser, httpStatus, permissionDenied, apiData } =
    await resolverAdvertiser(clienteId, mlUserId);

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

  // 3. Buscar campanhas (fonte principal do investimento) e anúncios (detalhamento)
  const campanhasResp = await buscarTodasCampanhasComMetricas(
    clienteId,
    siteId,
    advertiserId,
    from,
    to,
    mlUserId
  );

  if (campanhasResp.permissionDenied) {
    return {
      semDados: true,
      codigo: "NO_ADS_PERMISSION",
      motivo: `Sem permissão no endpoint campaigns/search (HTTP ${campanhasResp.httpStatus}).`,
    };
  }

  const itensResp = await buscarTodosAnunciosComMetricas(
    clienteId,
    siteId,
    advertiserId,
    from,
    to,
    mlUserId
  );

  if (itensResp.permissionDenied) {
    return {
      semDados: true,
      codigo: "NO_ADS_PERMISSION",
      motivo: `Sem permissão no endpoint ads/search (HTTP ${itensResp.httpStatus}).`,
    };
  }

  const campanhasApi = campanhasResp.campanhas || [];
  const itens = itensResp.itens || [];

  // Só interrompe se as duas fontes falharem e nenhuma devolver dados.
  const campanhasFalharam =
    !!campanhasResp.primeiroErro && campanhasApi.length === 0;
  const anunciosFalharam =
    !!itensResp.primeiroErro && itens.length === 0;

  if (campanhasFalharam && anunciosFalharam) {
    const pe = campanhasResp.primeiroErro || itensResp.primeiroErro;
    return {
      semDados: true,
      codigo: "ML_ADS_API_ERROR",
      motivo: pe.httpStatus
        ? `API ML Ads retornou HTTP ${pe.httpStatus}: ${JSON.stringify(pe.apiData).slice(0, 200)}`
        : `Erro de rede ao consultar Mercado Ads: ${pe.erroRede}`,
    };
  }

  // 4. Calcular agregados e normalizar
  const resumo = calcularResumoMetricas(itens, campanhasApi, mesRef);
  const anuncios = normalizarAnuncios(itens);
  const campanhas = normalizarCampanhas(campanhasApi, itens);
  const avisos = [];

  if (campanhasFalharam) {
    avisos.push("campaigns/search falhou; investimento calculado pelo fallback ads/search.");
  }
  if (anunciosFalharam) {
    avisos.push("ads/search falhou; resumo calculado pelas campanhas, sem detalhamento de anúncios.");
  }

  console.log(
    `[mlAds] OK — advertiser=${advertiserId} mes=${mesRef} anuncios=${anuncios.length} invest=${resumo.investimentoAds} gmv=${resumo.gmvAds} roas=${resumo.roas}`
  );

  return {
    advertiserId,
    siteId,
    advertiserName,
    mlUserId,
    contaId,
    contaNome,
    periodo:   { from, to },
    ...resumo,
    anuncios,
    campanhas,
    fonteInvestimento: campanhasApi.length ? "campaigns_search" : "ads_search_fallback",
    avisos,
    paginas:   itensResp.paginas,
    totalApi:  itensResp.totalApi,
    paginasCampanhas: campanhasResp.paginas,
    totalCampanhasApi: campanhasResp.totalApi,
    codigo:    "OK",
  };
}

module.exports = { buscarPerformanceML };
