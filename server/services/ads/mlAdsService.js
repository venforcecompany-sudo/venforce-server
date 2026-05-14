// server/services/ads/mlAdsService.js
const { mlFetch } = require("../../utils/mlClient");
const pool = require("../../config/database");

function mesRefToDateRange(mesRef) {
  const [year, month] = mesRef.split("-").map(Number);
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

async function resolverClienteId(clienteSlug) {
  const result = await pool.query(
    "SELECT id FROM clientes WHERE slug = $1 AND ativo = true",
    [clienteSlug]
  );
  if (!result.rows.length) throw new Error(`Cliente "${clienteSlug}" não encontrado.`);
  return result.rows[0].id;
}

async function getMlUserId(clienteId) {
  const { ok, status, data } = await mlFetch(clienteId, "/users/me");
  if (!ok) throw new Error(`Falha ao obter usuário ML (HTTP ${status})`);
  if (!data?.id) throw new Error("ML não retornou user ID.");
  return data.id;
}

async function getAdvertiserIds(clienteId, userId) {
  const { ok, status, data } = await mlFetch(
    clienteId,
    `/advertising/advertisers?user_id=${userId}`
  );
  if (!ok) throw new Error(`Falha ao buscar anunciantes ML (HTTP ${status})`);
  const list =
    data?.results ||
    data?.advertisers ||
    (Array.isArray(data) ? data : []);
  return list.map((a) => String(a.advertiser_id || a.id)).filter(Boolean);
}

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
        acc.cost    += Number(item.cost    || item.spend          || item.total_cost    || 0);
        acc.clicks  += Number(item.clicks  || item.total_clicks   || 0);
        acc.prints  += Number(item.prints  || item.impressions    || item.total_prints  || 0);
        acc.revenue += Number(item.amount  || item.revenue        || item.direct_revenue || item.total_amount || 0);
        acc.sales   += Number(item.quantity || item.orders        || item.units_sold    || 0);
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

async function fetchAdvertiserStats(clienteId, advertiserId, from, to) {
  const q = `date_from=${from}&date_to=${to}`;

  // Endpoint primário de custo/performance do ML Ads
  {
    const { ok, data } = await mlFetch(
      clienteId,
      `/advertising/advertisers/${advertiserId}/ads_cost?${q}`
    );
    if (ok && data != null) return normalizeMetrics(data);
  }

  // Fallback: stats por campanha
  {
    const { ok, data } = await mlFetch(
      clienteId,
      `/advertising/advertisers/${advertiserId}/campaigns/stats?${q}`
    );
    if (ok && data != null) return normalizeMetrics(data);
  }

  return null;
}

async function buscarPerformanceML(clienteSlug, mesRef) {
  const clienteId = await resolverClienteId(clienteSlug);
  const { from, to } = mesRefToDateRange(mesRef);

  let userId;
  try {
    userId = await getMlUserId(clienteId);
  } catch (err) {
    if (/token ML/i.test(err.message)) {
      return { semDados: true, motivo: "Cliente sem token Mercado Livre configurado." };
    }
    throw err;
  }

  let advertiserIds;
  try {
    advertiserIds = await getAdvertiserIds(clienteId, userId);
  } catch (_err) {
    return { semDados: true, motivo: "Não foi possível localizar anunciantes ML Ads para este cliente." };
  }

  if (!advertiserIds.length) {
    return { semDados: true, motivo: "Nenhum anunciante ML Ads vinculado a este cliente." };
  }

  const statsArr = await Promise.all(
    advertiserIds.map((id) =>
      fetchAdvertiserStats(clienteId, id, from, to).catch(() => null)
    )
  );

  let cost = 0, clicks = 0, prints = 0, revenue = 0, sales = 0;
  let hasData = false;

  for (const s of statsArr) {
    if (!s) continue;
    hasData = true;
    cost    += s.cost;
    clicks  += s.clicks;
    prints  += s.prints;
    revenue += s.revenue;
    sales   += s.sales;
  }

  if (!hasData) {
    return { semDados: true, motivo: "API ML Ads não retornou dados para este período." };
  }

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
