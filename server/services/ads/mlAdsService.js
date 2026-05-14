// server/services/ads/mlAdsService.js
const { mlFetch } = require("../../utils/mlClient");
const pool = require("../../config/database");

// ─── Códigos de retorno ───────────────────────────────────────────────────────
// NO_TOKEN                  – cliente não tem token ML configurado
// NO_ADVERTISER_FOUND       – /advertising/advertisers?product_id=PADS sem resultado
// NO_ADS_PERMISSION         – 401/403 na API de Ads
// ML_ADS_API_ERROR          – outro erro HTTP da API ML
// NO_METRICS_ENDPOINT_MAPPED – advertiser e anúncios encontrados, endpoint de métricas ainda não mapeado

// ─── Utilitários ──────────────────────────────────────────────────────────────

function mesRefToDateRange(mesRef) {
  const [year, month] = mesRef.split("-").map(Number);
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
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

// ─── A) Resolver advertiser_id via endpoint correto ───────────────────────────
// Endpoint confirmado: GET /advertising/advertisers?product_id=PADS
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

  // ── Logs diagnósticos (nunca imprime access_token) ──
  console.log("[mlAds][advertisers] path=", path);
  console.log("[mlAds][advertisers] status=", status);
  console.log("[mlAds][advertisers] bodyKeys=", Object.keys(data || {}));
  console.log(
    "[mlAds][advertisers] advertisersLength=",
    Array.isArray(data?.advertisers) ? data.advertisers.length : "not-array"
  );
  console.log(
    "[mlAds][advertisers] firstAdvertiser=",
    data?.advertisers?.[0]
      ? {
          advertiser_id:   data.advertisers[0].advertiser_id,
          site_id:         data.advertisers[0].site_id,
          advertiser_name: data.advertisers[0].advertiser_name,
          account_name:    data.advertisers[0].account_name,
        }
      : null
  );

  if (!ok) {
    if (status === 401 || status === 403) {
      return { advertiser: null, httpStatus: status, permissionDenied: true };
    }
    return { advertiser: null, httpStatus: status, apiData: data };
  }

  // Parser: suporta body.advertisers (confirmado), body.results, ou array direto
  const list =
    Array.isArray(data?.advertisers) ? data.advertisers :
    Array.isArray(data?.results)     ? data.results     :
    Array.isArray(data)              ? data              :
    [];

  if (!list.length) {
    console.warn(`[mlAds] ${path} → lista vazia após parse (bodyKeys=${Object.keys(data || {}).join(",")})`);
    return { advertiser: null, httpStatus: status };
  }

  // Preferir advertiser com site_id === "MLB"; fallback para o primeiro
  const chosen =
    list.find((a) => String(a.site_id).toUpperCase() === "MLB") || list[0];

  if (!chosen?.advertiser_id) {
    console.warn(`[mlAds] ${path} → item sem advertiser_id:`, JSON.stringify(chosen));
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

// ─── B) Listar campanhas ──────────────────────────────────────────────────────
// GET /marketplace/advertising/{site_id}/advertisers/{advertiser_id}/product_ads/campaigns/search

async function buscarCampanhas(clienteId, siteId, advertiserId, from, to) {
  const path =
    `/marketplace/advertising/${siteId}/advertisers/${advertiserId}/product_ads/campaigns/search` +
    `?limit=50&offset=0&date_from=${from}&date_to=${to}`;
  let ok, status, data;
  try {
    ({ ok, status, data } = await mlFetch(clienteId, path));
  } catch (err) {
    console.warn(`[mlAds] Erro de rede em campanhas:`, err.message);
    return [];
  }

  logMl(path, status, data);
  if (!ok) {
    console.warn(`[mlAds] Campanhas: HTTP ${status}`);
    return [];
  }

  const list =
    data?.results ||
    data?.campaigns ||
    (Array.isArray(data) ? data : []);

  console.log(`[mlAds] Campanhas encontradas: ${list.length}`);
  return list;
}

// ─── C) Listar itens/produtos anunciados ──────────────────────────────────────
// GET /advertising/advertisers/{advertiser_id}/product_ads/items

async function buscarItens(clienteId, advertiserId, from, to) {
  const path =
    `/advertising/advertisers/${advertiserId}/product_ads/items` +
    `?date_from=${from}&date_to=${to}&limit=50&offset=0`;
  let ok, status, data;
  try {
    ({ ok, status, data } = await mlFetch(clienteId, path));
  } catch (err) {
    console.warn(`[mlAds] Erro de rede em itens:`, err.message);
    return [];
  }

  logMl(path, status, data);
  if (!ok) {
    console.warn(`[mlAds] Itens: HTTP ${status}`);
    return [];
  }

  const list =
    data?.results ||
    data?.ads ||
    (Array.isArray(data) ? data : []);

  console.log(`[mlAds] Itens encontrados: ${list.length}`);
  return list;
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

  console.log(`[mlAds] cliente=${clienteSlug} clienteId=${clienteId} mlUserId=${mlUserId}`);

  const { from, to } = mesRefToDateRange(mesRef);
  console.log(`[mlAds] período: ${from} → ${to}`);

  // 2. Resolver advertiser_id via /advertising/advertisers?product_id=PADS
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

  // 3. Buscar campanhas e itens em paralelo
  const [campanhas, itens] = await Promise.all([
    buscarCampanhas(clienteId, siteId, advertiserId, from, to),
    buscarItens(clienteId, advertiserId, from, to),
  ]);

  // 4. Endpoint de métricas (investimento, GMV, ROAS, cliques, impressões)
  //    ainda não mapeado com confirmação real — não inventar dados.
  console.log(
    `[mlAds] NO_METRICS_ENDPOINT_MAPPED — advertiser=${advertiserId} campanhas=${campanhas.length} itens=${itens.length}`
  );

  return {
    advertiserId,
    siteId,
    advertiserName,
    mlUserId,
    periodo: { from, to },
    campanhas,
    itens,
    metricas: null,
    codigo: "NO_METRICS_ENDPOINT_MAPPED",
  };
}

module.exports = { buscarPerformanceML };
