// server/services/ads/mlAdsService.js
const { mlFetch } = require("../../utils/mlClient");
const pool = require("../../config/database");

// ─── Códigos de erro para o frontend ─────────────────────────────────────────
// NO_TOKEN           – cliente não tem token ML configurado
// NO_ADVERTISER_FOUND – nenhum advertiser_id resolvido
// NO_ADS_PERMISSION  – ML retornou 401/403 nos endpoints de Ads
// ML_ADS_API_ERROR   – outro erro HTTP da API ML
// NO_DATA_FOR_PERIOD – advertiser encontrado mas sem dados no período

function semDados(codigo, motivo) {
  return { semDados: true, codigo, motivo };
}

// ─── Utilitários ──────────────────────────────────────────────────────────────

function mesRefToDateRange(mesRef) {
  const [year, month] = mesRef.split("-").map(Number);
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

function logMlCall(path, status, body) {
  // Nunca imprime access_token; trunca body longo
  const snippet = body ? JSON.stringify(body).slice(0, 300) : "(sem corpo)";
  console.log(`[mlAds] GET ${path} → HTTP ${status} | body: ${snippet}`);
}

// ─── Resolver cliente + ml_user_id direto do banco ───────────────────────────

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
    // Verifica se o cliente existe mas não tem token
    const c = await pool.query(
      "SELECT id FROM clientes WHERE slug = $1 AND ativo = true",
      [clienteSlug]
    );
    if (!c.rows.length) throw new Error(`Cliente "${clienteSlug}" não encontrado.`);
    const err = new Error("Cliente sem token Mercado Livre configurado.");
    err.adsCodigo = "NO_TOKEN";
    throw err;
  }

  return {
    clienteId: result.rows[0].cliente_id,
    mlUserId:  String(result.rows[0].ml_user_id),
  };
}

// ─── Descobrir advertiser_ids via API ML ──────────────────────────────────────

async function descobrirAdvertiserIds(clienteId, mlUserId) {
  const path = `/advertising/advertisers?user_id=${mlUserId}`;
  let ok, status, data;
  try {
    ({ ok, status, data } = await mlFetch(clienteId, path));
  } catch (err) {
    console.warn(`[mlAds] Erro de rede em ${path}:`, err.message);
    return { ids: [], httpStatus: null, apiData: null };
  }

  logMlCall(path, status, data);

  if (!ok) {
    return { ids: [], httpStatus: status, apiData: data };
  }

  const list =
    data?.results ||
    data?.advertisers ||
    (Array.isArray(data) ? data : []);

  const ids = list
    .map((a) => String(a.advertiser_id || a.id || "").trim())
    .filter(Boolean);

  console.log(`[mlAds] Anunciantes via API: [${ids.join(", ") || "nenhum"}]`);
  return { ids, httpStatus: status, apiData: data };
}

// ─── Normalizar métricas (diferentes formatos de resposta da ML) ─────────────

function normalizeMetrics(data) {
  const items = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data)
    ? data
    : [];

  if (items.length) {
    return items.reduce(
      (acc, item) => {
        acc.cost    += Number(item.cost    || item.spend           || item.total_cost    || 0);
        acc.clicks  += Number(item.clicks  || item.total_clicks    || 0);
        acc.prints  += Number(item.prints  || item.impressions     || item.total_prints  || 0);
        acc.revenue += Number(item.amount  || item.revenue         || item.direct_revenue || item.total_amount || 0);
        acc.sales   += Number(item.quantity || item.orders         || item.units_sold    || 0);
        return acc;
      },
      { cost: 0, clicks: 0, prints: 0, revenue: 0, sales: 0 }
    );
  }

  // Resposta já agregada no nível raiz
  return {
    cost:    Number(data?.cost    || data?.total_cost  || 0),
    clicks:  Number(data?.clicks  || 0),
    prints:  Number(data?.prints  || data?.impressions || 0),
    revenue: Number(data?.amount  || data?.revenue     || 0),
    sales:   Number(data?.orders  || data?.quantity    || 0),
  };
}

// ─── Buscar stats de um advertiser (com log explícito) ────────────────────────

async function fetchAdvertiserStats(clienteId, advertiserId, from, to) {
  const qs = `date_from=${from}&date_to=${to}`;
  const endpoints = [
    `/advertising/advertisers/${advertiserId}/ads_cost?${qs}`,
    `/advertising/advertisers/${advertiserId}/campaigns/stats?${qs}`,
  ];

  let lastStatus = null;
  let permissionDenied = false;

  for (const path of endpoints) {
    let ok, status, data;
    try {
      ({ ok, status, data } = await mlFetch(clienteId, path));
    } catch (err) {
      console.warn(`[mlAds] Erro de rede em ${path}:`, err.message);
      continue;
    }

    logMlCall(path, status, data);
    lastStatus = status;

    if (status === 401 || status === 403) {
      permissionDenied = true;
      continue;
    }

    if (ok && data != null) {
      console.log(`[mlAds] ✓ dados obtidos de ${path.split("?")[0]} para advertiser ${advertiserId}`);
      return { metrics: normalizeMetrics(data), permissionDenied: false };
    }
  }

  return { metrics: null, permissionDenied, lastStatus };
}

// ─── Função principal ─────────────────────────────────────────────────────────

async function buscarPerformanceML(clienteSlug, mesRef) {
  // 1. Resolver cliente e ml_user_id do banco (sem chamar /users/me)
  let clienteId, mlUserId;
  try {
    ({ clienteId, mlUserId } = await resolverClienteToken(clienteSlug));
  } catch (err) {
    if (err.adsCodigo === "NO_TOKEN") {
      return semDados("NO_TOKEN", err.message);
    }
    throw err;
  }

  console.log(`[mlAds] cliente=${clienteSlug} clienteId=${clienteId} mlUserId=${mlUserId}`);

  const { from, to } = mesRefToDateRange(mesRef);
  console.log(`[mlAds] período: ${from} → ${to}`);

  // 2. Tentar descobrir advertiser_ids via API ML
  const { ids: apiIds, httpStatus: advertisersStatus, apiData: advertisersData } =
    await descobrirAdvertiserIds(clienteId, mlUserId);

  // Montar lista de advertiser_ids a tentar:
  // – IDs descobertos via API (se houver)
  // – Fallback: mlUserId diretamente (no PAds do ML, seller_id == advertiser_id)
  let advertiserIds = [...apiIds];
  if (!advertiserIds.length) {
    console.log(
      `[mlAds] /advertising/advertisers retornou vazio (HTTP ${advertisersStatus}). ` +
      `Tentando mlUserId=${mlUserId} como advertiser_id (fallback PAds).`
    );
    advertiserIds = [mlUserId];
  }

  // 3. Buscar stats para cada advertiser_id
  const results = await Promise.all(
    advertiserIds.map((id) => fetchAdvertiserStats(clienteId, id, from, to))
  );

  let cost = 0, clicks = 0, prints = 0, revenue = 0, sales = 0;
  let hasData = false;
  let anyPermissionDenied = false;

  for (const r of results) {
    if (!r) continue;
    if (r.permissionDenied) anyPermissionDenied = true;
    if (!r.metrics) continue;
    hasData = true;
    cost    += r.metrics.cost;
    clicks  += r.metrics.clicks;
    prints  += r.metrics.prints;
    revenue += r.metrics.revenue;
    sales   += r.metrics.sales;
  }

  // 4. Interpretar resultado
  if (!hasData) {
    if (anyPermissionDenied) {
      const msg =
        advertisersStatus === 403 || advertisersStatus === 401
          ? "Token ML não tem permissão para acessar ML Ads (403/401). Verifique se o escopo 'advertising' foi autorizado no OAuth."
          : "Token ML sem permissão nos endpoints de performance de Ads.";
      console.warn(`[mlAds] NO_ADS_PERMISSION — ${msg}`);
      return semDados("NO_ADS_PERMISSION", msg);
    }

    // Se /advertising/advertisers retornou 4xx e não caiu em permissionDenied acima
    if (advertisersStatus && advertisersStatus >= 400 && advertisersData) {
      const msg = `API ML Ads retornou HTTP ${advertisersStatus} ao buscar anunciantes: ${JSON.stringify(advertisersData).slice(0, 200)}`;
      console.warn(`[mlAds] ML_ADS_API_ERROR — ${msg}`);
      return semDados("ML_ADS_API_ERROR", msg);
    }

    // API respondeu OK mas sem dados no período
    if (apiIds.length > 0) {
      return semDados("NO_DATA_FOR_PERIOD", `Anunciante(s) encontrado(s) mas sem dados no período ${from} → ${to}.`);
    }

    // Nenhum advertiser encontrado de jeito nenhum
    return semDados(
      "NO_ADVERTISER_FOUND",
      `Nenhum advertiser_id encontrado para mlUserId=${mlUserId}. ` +
      `Verifique se o cliente tem conta ativa no Mercado Ads.`
    );
  }

  console.log(`[mlAds] ✓ performance agregada — cost=${cost} revenue=${revenue} clicks=${clicks}`);

  return {
    source:          "ml_api",
    clienteSlug,
    mesRef,
    investimentoAds: cost,
    gmvAds:          revenue,
    roas:            cost > 0 ? revenue / cost : 0,
    cliques:         clicks,
    impressoes:      prints,
    vendas:          sales,
  };
}

module.exports = { buscarPerformanceML };
