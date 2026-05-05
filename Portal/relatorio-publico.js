const API_BASE = "https://venforce-server.onrender.com";

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function escapeHTML(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function brl(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);
}

function formatDateTimePtBR(d) {
  try { return new Date(d).toLocaleString("pt-BR"); } catch { return ""; }
}

function safeNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeKey(k) {
  return String(k || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function pickKey(obj, candidates) {
  if (!obj || typeof obj !== "object") return null;
  const keys = Object.keys(obj);
  const map = keys.map((k) => ({ k, nk: normalizeKey(k) }));
  for (const c of candidates) {
    const nc = normalizeKey(c);
    const hit = map.find((x) => x.nk === nc);
    if (hit) return hit.k;
  }
  return null;
}

function pickKeyIncludes(obj, includesList) {
  if (!obj || typeof obj !== "object") return null;
  const keys = Object.keys(obj);
  const map = keys.map((k) => ({ k, nk: normalizeKey(k) }));
  for (const inc of includesList) {
    const ni = normalizeKey(inc);
    const hit = map.find((x) => x.nk.includes(ni));
    if (hit) return hit.k;
  }
  return null;
}

function getStatusGeral({ finalResult, mcMedia, unmatchedCount, refundsCount, lostRevenueTotal }) {
  if (finalResult != null && finalResult < 0) return { id: "critico", label: "Resultado crítico" };
  if (mcMedia != null && mcMedia < 0) return { id: "critico", label: "Margem crítica" };
  if ((mcMedia != null && mcMedia < 0.15) || (unmatchedCount || 0) > 0 || (refundsCount || 0) > 0 || (lostRevenueTotal || 0) > 0) {
    return { id: "atencao", label: "Atenção necessária" };
  }
  return { id: "positivo", label: "Resultado positivo" };
}

function statusIdToCss(id) {
  if (id === "positivo") return "rp-status-positive";
  if (id === "atencao") return "rp-status-attn";
  return "rp-status-critical";
}

function cardStatusToCss(id) {
  if (id === "positivo") return "rp-card-positive";
  if (id === "atencao") return "rp-card-attn";
  if (id === "critico") return "rp-card-critical";
  return "rp-card-neutral";
}

function getSummary(payload) {
  const snapshot = payload?.snapshot || {};
  return snapshot?.summary || payload?.summary || {};
}

function getNormalizedSummary(payload) {
  const raw = payload?.summaryNormalized || payload?.summary || {};
  const summary = {
    ...(payload?.summary || {}),
    ...(raw || {})
  };

  summary.marketplace = String(
    payload?.marketplace ||
    payload?.metadados?.marketplace ||
    payload?.snapshot?.marketplace ||
    summary?.marketplace ||
    ""
  ).toLowerCase();

  summary.grossRevenueTotal = toNumberSafe(summary.grossRevenueTotal);
  summary.paidRevenueTotal = toNumberSafe(summary.paidRevenueTotal);
  summary.contributionProfitTotal = toNumberSafe(summary.contributionProfitTotal);
  summary.averageContributionMargin = toNumberSafe(summary.averageContributionMargin);
  summary.finalResult = toNumberSafe(summary.finalResult);
  summary.tacos = toNumberSafe(summary.tacos);

  summary.refundsTotal = toNumberSafe(summary.refundsTotal);
  summary.refundsCount = toNumberSafe(summary.refundsCount);
  summary.lostRevenueTotal = toNumberSafe(summary.lostRevenueTotal);

  summary.cancelledCount = toNumberSafe(summary.cancelledCount);
  summary.cancelledLostRevenue = toNumberSafe(summary.cancelledLostRevenue);
  summary.unpaidCount = toNumberSafe(summary.unpaidCount);
  summary.unpaidLostRevenue = toNumberSafe(summary.unpaidLostRevenue);

  summary.hasShopeeStatusData =
    Number(summary.cancelledCount || 0) > 0 ||
    Number(summary.cancelledLostRevenue || 0) > 0 ||
    Number(summary.unpaidCount || 0) > 0 ||
    Number(summary.unpaidLostRevenue || 0) > 0;

  // fallback marketplace
  if (!summary.marketplace) {
    summary.marketplace = summary.hasShopeeStatusData ? "shopee" : "meli";
  }

  return summary;
}

function isShopeeReport(payload, summary) {
  const marketplace = String(
    payload?.marketplace ||
    payload?.metadados?.marketplace ||
    summary?.marketplace ||
    ""
  ).toLowerCase();

  return marketplace.includes("shopee") ||
    Number(summary?.cancelledCount || 0) > 0 ||
    Number(summary?.cancelledLostRevenue || 0) > 0 ||
    Number(summary?.unpaidCount || 0) > 0 ||
    Number(summary?.unpaidLostRevenue || 0) > 0;
}

function getRows(payload) {
  const snapshot = payload?.snapshot || {};
  if (Array.isArray(snapshot?.detailedRows) && snapshot.detailedRows.length) return snapshot.detailedRows;
  if (Array.isArray(payload?.detailedRows) && payload.detailedRows.length) return payload.detailedRows;
  const t0 = Array.isArray(payload?.tabelas) ? payload.tabelas[0] : null;
  if (t0 && Array.isArray(t0.linhas) && t0.linhas.length) return t0.linhas;
  return [];
}

function toNumberSafe(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = String(value).trim();
  if (!s) return null;
  let t = s.replace(/\s/g, "");
  t = t.replace(/[R$\u00A0]/g, "");
  t = t.replace(/%/g, "");
  if (t.includes(",") && t.includes(".")) t = t.replace(/\./g, "").replace(",", ".");
  else if (t.includes(",")) t = t.replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function pickValue(row, possibleKeys) {
  if (!row || typeof row !== "object") return null;
  for (const k of possibleKeys) {
    const kk = pickKey(row, [k]) || pickKeyIncludes(row, [k]);
    if (kk) return row?.[kk];
  }
  return null;
}

function normalizePercentToDecimal(value) {
  const n = toNumberSafe(value);
  if (n === null) return null;

  const abs = Math.abs(n);
  if (abs <= 1) return n;
  if (abs > 1 && abs <= 100) return n / 100;
  if (abs > 100 && abs <= 10000) return n / 10000;
  if (abs > 10000) return n / 10000;
  return n;
}

function formatPercentSmart(value) {
  const dec = normalizePercentToDecimal(value);
  if (dec === null) return "—";
  return (dec * 1e2).toFixed(2) + "%";
}

function getMcValue(row) {
  return pickValue(row, [
    "mc",
    "MC",
    "margem",
    "Margem",
    "margem_contribuicao",
    "margemContribuicao",
    "Margem de Contribuição",
    "MARGEM DE CONTRIBUIÇÃO",
    "averageContributionMargin",
    "contributionMargin",
  ]);
}

function getCostValue(row) {
  const raw = pickValue(row, [
    "custo",
    "Custo",
    "CUSTO",
    "custo_produto",
    "custoProduto",
    "Custo Produto",
    "CUSTO PRODUTO",
    "preço de custo",
    "preco de custo",
    "Preço de Custo",
    "PREÇO DE CUSTO",
    "preco_custo",
    "preço de custo total",
    "preco de custo total",
    "Preço de Custo Total",
    "PREÇO DE CUSTO TOTAL",
    "preco_custo_total",
    "cost",
    "unitCost",
    "totalCost",
  ]);
  return toNumberSafe(raw);
}

function normalizeIdentifier(v) {
  return String(v || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^\w\-#]/g, "");
}

function getProductLabel(row) {
  const name = pickValue(row, [
    "produto",
    "Produto",
    "productName",
    "nomeProduto",
    "nome_produto",
    "title",
    "Title",
    "titulo",
    "Titulo",
    "título",
    "Título",
    "TÍTULO DO ANÚNCIO",
    "Título do Anúncio",
    "titulo_anuncio",
    "anuncioTitulo",
    "name",
    "Nome",
    "item_name",
    "itemName",
  ]);
  const cleanedName = String(name || "").trim();
  if (cleanedName) return cleanedName;

  const id = pickValue(row, [
    "item_id",
    "itemId",
    "id",
    "ID",
    "# DE ANÚNCIO",
    "# de anúncio",
    "sku",
    "SKU",
  ]);
  const cleanedId = String(id || "").trim();
  return cleanedId || "Item";
}

function getRevenueValue(row) {
  const v = pickValue(row, [
    "receita",
    "Receita",
    "vendaTotal",
    "Venda Total",
    "VENDA TOTAL",
    "Valor vendido",
    "valorVendido",
    "vendas_pedido_pago",
    "VENDAS (PEDIDO PAGO) (BRL)",
    "Vendas (Pedido Pago) (BRL)",
    "vendasPedidoPago",
    "paidRevenue",
    "productRevenue",
    "total",
    "Total",
    "TOTAL (BRL)",
    "Total (BRL)",
  ]);
  return toNumberSafe(v);
}

function getRowIdentifiers(row) {
  const vals = [];
  [
    "item_id",
    "itemId",
    "produto_id",
    "produtoId",
    "id",
    "ID",
    "# de anúncio",
    "# DE ANÚNCIO",
    "anuncio",
    "anúncio",
    "Anúncio",
    "MLB",
    "mlb",
    "sku",
    "SKU",
  ].forEach((k) => {
    const v = pickValue(row, [k]);
    if (v !== null && v !== undefined && String(v).trim() !== "") vals.push(v);
  });
  return Array.from(new Set(vals.map(normalizeIdentifier).filter(Boolean)));
}

function classifyRow(row, unmatchedIds) {
  const unmatchedNorm = new Set(
    (Array.isArray(unmatchedIds) ? unmatchedIds : [])
      .map((x) => normalizeIdentifier(x))
      .filter(Boolean)
  );

  const ids = getRowIdentifiers(row);
  const isUnmatched = ids.some((id) => unmatchedNorm.has(id));

  const temBaseVal = pickValue(row, ["tem_base", "temBase", "hasBase"]);
  const temBaseExplicitFalse =
    temBaseVal === false || String(temBaseVal || "").trim().toLowerCase() === "false";

  const cost = getCostValue(row);
  if (!(cost !== null && cost > 0)) {
    if (isUnmatched || temBaseExplicitFalse) {
      return "sem_custo";
    }
    const lc = toNumberSafe(pickValue(row, ["LC", "lc", "Lucro", "lucro", "contributionProfit", "contribution_profit"]));
    const receita = toNumberSafe(pickValue(row, ["vendaTotal", "Receita", "receita", "total", "Total", "valor", "Valor", "productRevenue", "paidRevenue"]));
    const mcDec = normalizePercentToDecimal(getMcValue(row));
    const hasFinance = (lc !== null) || (receita !== null) || (mcDec !== null);
    const costKnownZeroOrInvalid = cost === null || cost === 0;
    if (costKnownZeroOrInvalid && !hasFinance) {
      return "sem_custo";
    }
  }

  const mc = normalizePercentToDecimal(getMcValue(row));
  const lc = toNumberSafe(pickValue(row, ["LC", "lc", "Lucro", "lucro", "contributionProfit", "contribution_profit"]));

  if (mc !== null) {
    if (mc < 0) return "critico";
    if (mc < 0.15) return "atencao";
    return "saudavel";
  }

  if (lc !== null && lc < 0) return "critico";
  return "atencao";
}

function buildChartData(payload) {
  const rows = getRows(payload);
  const normalized = getNormalizedSummary(payload);
  const snapshot = payload?.snapshot || {};

  const unmatchedIds = Array.isArray(snapshot?.unmatchedIds) ? snapshot.unmatchedIds : (Array.isArray(payload?.unmatchedIds) ? payload.unmatchedIds : []);

  const lcKeys = ["LC", "lc", "Lucro", "lucro", "contributionProfit", "contribution_profit"];

  const items = rows.map((r, idx) => {
    const label = getProductLabel(r) || `Item ${idx + 1}`;
    const lc = toNumberSafe(pickValue(r, lcKeys));
    const rev = getRevenueValue(r);
    const mc = normalizePercentToDecimal(getMcValue(r));
    const status = classifyRow(r, unmatchedIds);
    return { r, label, lc: lc ?? 0, rev: rev ?? 0, mc, status };
  });

  const topLc = [...items].sort((a, b) => (b.lc || 0) - (a.lc || 0)).slice(0, 10);
  const topRev = [...items].sort((a, b) => (b.rev || 0) - (a.rev || 0)).slice(0, 10);

  const counts = { saudavel: 0, atencao: 0, critico: 0, sem_custo: 0 };
  items.forEach((it) => { counts[it.status] = (counts[it.status] || 0) + 1; });

  const net = safeNumber(normalized?.paidRevenueTotal, safeNumber(snapshot?.metricasDerivadas?.net, null)) ?? 0;
  const finalResult = safeNumber(normalized?.finalResult, safeNumber(snapshot?.metricasDerivadas?.finalResult, null)) ?? 0;

  const isShopee = isShopeeReport(payload, normalized) || !!normalized?.hasShopeeStatusData;
  const lostRevenueMeli = safeNumber(normalized?.lostRevenueTotal, null) ?? 0;
  const refundsTotal = safeNumber(normalized?.refundsTotal, safeNumber(snapshot?.metricasDerivadas?.refundsTotal, null)) ?? 0;

  const cancelledLostRevenue = safeNumber(normalized?.cancelledLostRevenue, null) ?? 0;
  const unpaidLostRevenue = safeNumber(normalized?.unpaidLostRevenue, null) ?? 0;

  return {
    items,
    topLc,
    topRev,
    composicao: {
      labels: isShopee
        ? ["Receita líquida", "Resultado final", "Faturamento perdido (cancelados)", "Faturamento não pago"]
        : ["Receita líquida", "Resultado final", "Reembolsos/Cancelamentos", "Faturamento perdido"],
      valuesAbs: isShopee
        ? [Math.abs(net), Math.abs(finalResult), Math.abs(cancelledLostRevenue), Math.abs(unpaidLostRevenue)]
        : [Math.abs(net), Math.abs(finalResult), Math.abs(refundsTotal), Math.abs(lostRevenueMeli)],
      valuesSigned: isShopee
        ? [net, finalResult, cancelledLostRevenue, unpaidLostRevenue]
        : [net, finalResult, refundsTotal, lostRevenueMeli],
    },
    distrib: counts,
  };
}

function destroyChartSafe(instance) {
  try { instance?.destroy?.(); } catch (_) {}
}

function renderCharts(payload) {
  const host = document.getElementById("rp-charts-host");
  if (!host) return;

  const hasChart = typeof window.Chart !== "undefined";
  if (!hasChart) {
    host.innerHTML = `<div class="rp-muted-box">Biblioteca de gráficos indisponível no momento.</div>`;
    return;
  }

  const data = buildChartData(payload);
  const rows = getRows(payload);
  if (!rows.length) {
    host.innerHTML = `<div class="rp-muted-box">Dados insuficientes para exibir gráficos.</div>`;
    return;
  }

  host.innerHTML = `
    <div class="rp-charts-grid">
      <div class="rp-chart-card">
        <div class="rp-chart-title"><h3>Top produtos por LC</h3></div>
        <div class="rp-chart-canvas"><canvas id="rp-chart-lc"></canvas></div>
        <div class="rp-note" id="rp-chart-lc-note">Top 10 itens por lucro de contribuição. Passe o mouse para ver o nome completo.</div>
      </div>
      <div class="rp-chart-card">
        <div class="rp-chart-title"><h3>Top produtos por faturamento</h3></div>
        <div class="rp-chart-canvas"><canvas id="rp-chart-rev"></canvas></div>
        <div class="rp-note" id="rp-chart-rev-note">Top 10 itens por receita/faturamento. Labels longas são truncadas no eixo.</div>
      </div>
      <div class="rp-chart-card">
        <div class="rp-chart-title"><h3>Composição do fechamento</h3></div>
        <div class="rp-chart-canvas"><canvas id="rp-chart-comp"></canvas></div>
        <div class="rp-note">Valores absolutos no gráfico. Sinais e interpretação no resumo executivo.</div>
      </div>
      <div class="rp-chart-card">
        <div class="rp-chart-title"><h3>Distribuição dos produtos</h3></div>
        <div class="rp-chart-canvas"><canvas id="rp-chart-status"></canvas></div>
        <div class="rp-note">Classificação por MC e itens sem custo real (base incompleta).</div>
      </div>
    </div>
  `;

  if (!host._charts) host._charts = {};
  Object.values(host._charts).forEach(destroyChartSafe);
  host._charts = {};

  const elLc = document.getElementById("rp-chart-lc");
  const elRev = document.getElementById("rp-chart-rev");
  const elComp = document.getElementById("rp-chart-comp");
  const elStatus = document.getElementById("rp-chart-status");

  const fmtBrl = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(n);
  };

  const truncateLabel = (s, max = 24) => {
    const txt = String(s || "");
    return txt.length > max ? txt.slice(0, max - 1) + "…" : txt;
  };

  if (elLc && data.topLc.some((x) => (x.lc || 0) !== 0)) {
    const full = data.topLc.map((x) => x.label);
    host._charts.lc = new window.Chart(elLc, {
      type: "bar",
      data: {
        labels: full.map((x) => truncateLabel(x, 24)),
        datasets: [{ label: "LC", data: data.topLc.map((x) => x.lc), backgroundColor: "rgba(109,40,217,0.40)", borderColor: "rgba(109,40,217,1)", borderWidth: 1 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => full[items?.[0]?.dataIndex] || "Item",
              label: (ctx) => ` ${fmtBrl(ctx.parsed.x)}`
            }
          }
        },
        scales: {
          x: { ticks: { color: "#6b7280", callback: (v) => fmtBrl(v) }, grid: { color: "rgba(15,23,42,0.06)" } },
          y: { ticks: { color: "#334155" }, grid: { display: false } }
        }
      }
    });
  } else {
    const note = document.getElementById("rp-chart-lc-note");
    if (note) { note.textContent = "Dados insuficientes para este gráfico."; }
  }

  if (elRev && data.topRev.some((x) => (x.rev || 0) !== 0)) {
    const full = data.topRev.map((x) => x.label);
    host._charts.rev = new window.Chart(elRev, {
      type: "bar",
      data: {
        labels: full.map((x) => truncateLabel(x, 24)),
        datasets: [{ label: "Faturamento", data: data.topRev.map((x) => x.rev), backgroundColor: "rgba(22,163,74,0.36)", borderColor: "rgba(22,163,74,1)", borderWidth: 1 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => full[items?.[0]?.dataIndex] || "Item",
              label: (ctx) => ` ${fmtBrl(ctx.parsed.x)}`
            }
          }
        },
        scales: {
          x: { ticks: { color: "#6b7280", callback: (v) => fmtBrl(v) }, grid: { color: "rgba(15,23,42,0.06)" } },
          y: { ticks: { color: "#334155" }, grid: { display: false } }
        }
      }
    });
  } else {
    const note = document.getElementById("rp-chart-rev-note");
    if (note) { note.textContent = "Dados insuficientes para este gráfico."; }
  }

  if (elComp && data.composicao.valuesAbs.some((v) => v > 0)) {
    host._charts.comp = new window.Chart(elComp, {
      type: "doughnut",
      data: {
        labels: data.composicao.labels,
        datasets: [{
          data: data.composicao.valuesAbs,
          backgroundColor: ["rgba(2,132,199,0.55)", "rgba(124,58,237,0.55)", "rgba(245,158,11,0.55)", "rgba(220,38,38,0.55)"],
          borderColor: ["rgba(2,132,199,1)", "rgba(124,58,237,1)", "rgba(245,158,11,1)", "rgba(220,38,38,1)"],
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { color: "#374151" } },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${fmtBrl(ctx.parsed)}` } }
        }
      }
    });
  }

  if (elStatus) {
    const values = [data.distrib.saudavel, data.distrib.atencao, data.distrib.critico, data.distrib.sem_custo];
    host._charts.status = new window.Chart(elStatus, {
      type: "doughnut",
      data: {
        labels: ["Saudável", "Atenção", "Crítico", "Sem custo"],
        datasets: [{
          data: values,
          backgroundColor: ["rgba(22,163,74,0.55)", "rgba(245,158,11,0.55)", "rgba(220,38,38,0.55)", "rgba(124,58,237,0.55)"],
          borderColor: ["rgba(22,163,74,1)", "rgba(245,158,11,1)", "rgba(220,38,38,1)", "rgba(124,58,237,1)"],
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { color: "#374151" } },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.label}: ${ctx.parsed}` } }
        }
      }
    });
  }
}

function applyTableFilters(state, rows, unmatchedIds) {
  const q = String(state.q || "").trim().toLowerCase();
  const status = String(state.status || "all");

  const filtered = rows
    .map((row, idx) => {
      const label = getProductLabel(row) || `Item ${idx + 1}`;
      const lc = toNumberSafe(pickValue(row, ["LC", "lc", "Lucro", "lucro", "contributionProfit", "contribution_profit"])) ?? 0;
      const receita = getRevenueValue(row) ?? 0;
      const mc = normalizePercentToDecimal(getMcValue(row));
      const cls = classifyRow(row, unmatchedIds);
      const obs = pickValue(row, ["observacao", "observação", "diagnostico", "diagnóstico", "status"]) ?? "";
      const hay = `${label} ${JSON.stringify(row)}`.toLowerCase();
      return { row, label: String(label), lc, receita, mc, cls, obs: String(obs || ""), hay };
    })
    .filter((it) => {
      if (q && !it.hay.includes(q)) return false;
      if (status !== "all" && it.cls !== status) return false;
      return true;
    });

  const sort = String(state.sort || "lc_desc");
  filtered.sort((a, b) => {
    if (sort === "lc_desc") return (b.lc || 0) - (a.lc || 0);
    if (sort === "mc_asc") return ((a.mc ?? 999) - (b.mc ?? 999));
    if (sort === "rev_desc") return (b.receita || 0) - (a.receita || 0);
    if (sort === "name_az") return String(a.label).localeCompare(String(b.label), "pt-BR");
    return 0;
  });

  const limit = Math.max(1, Math.min(parseInt(state.limit, 10) || 20, 200));
  return filtered.slice(0, limit);
}

function renderAdvancedTable(payload) {
  const host = document.getElementById("rp-table-host");
  if (!host) return;

  const rows = getRows(payload);
  const snapshot = payload?.snapshot || {};
  const unmatchedIds = Array.isArray(snapshot?.unmatchedIds) ? snapshot.unmatchedIds : (Array.isArray(payload?.unmatchedIds) ? payload.unmatchedIds : []);

  const state = host._state || { q: "", status: "all", limit: 20, sort: "lc_desc" };
  host._state = state;

  if (!rows.length) {
    host.innerHTML = `<div class="rp-muted-box">Dados insuficientes para montar o detalhamento (sem linhas no snapshot).</div>`;
    return;
  }

  const view = applyTableFilters(state, rows, unmatchedIds);

  const emptyHtml = `
    <div class="rp-muted-box">
      <div style="font-weight:950;margin-bottom:6px;">Nenhum item encontrado</div>
      <div class="rp-note">Ajuste busca/filtros para encontrar produtos específicos.</div>
    </div>
  `;

  host.innerHTML = `
    <div class="rp-table-tools no-print">
      <div class="rp-tools-left" style="flex:1;">
        <input id="rp-q" class="rp-input" type="search" placeholder="Buscar por produto, ID, SKU ou qualquer texto..." value="${escapeHTML(state.q)}" />
        <select id="rp-status" class="rp-select">
          <option value="all"${state.status === "all" ? " selected" : ""}>Todos</option>
          <option value="saudavel"${state.status === "saudavel" ? " selected" : ""}>Saudável</option>
          <option value="atencao"${state.status === "atencao" ? " selected" : ""}>Atenção</option>
          <option value="critico"${state.status === "critico" ? " selected" : ""}>Crítico</option>
          <option value="sem_custo"${state.status === "sem_custo" ? " selected" : ""}>Sem custo</option>
        </select>
      </div>
      <div class="rp-tools-right">
        <select id="rp-limit" class="rp-select" title="Quantidade">
          ${[10,20,30,50].map((n) => `<option value="${n}"${Number(state.limit) === n ? " selected" : ""}>${n}</option>`).join("")}
        </select>
        <select id="rp-sort" class="rp-select" title="Ordenação">
          <option value="lc_desc"${state.sort === "lc_desc" ? " selected" : ""}>Maior LC</option>
          <option value="mc_asc"${state.sort === "mc_asc" ? " selected" : ""}>Menor MC</option>
          <option value="rev_desc"${state.sort === "rev_desc" ? " selected" : ""}>Maior faturamento</option>
          <option value="name_az"${state.sort === "name_az" ? " selected" : ""}>Nome A-Z</option>
        </select>
      </div>
    </div>

    ${view.length ? `
      <div style="overflow:auto;margin-top:12px;">
        <table class="rp-table">
          <thead>
            <tr>
              <th>Produto / ID</th>
              <th>Receita</th>
              <th>LC</th>
              <th>MC</th>
              <th>Status</th>
              <th>Observação</th>
            </tr>
          </thead>
          <tbody>
            ${view.map((it) => {
              const badgeClass =
                it.cls === "saudavel" ? "rp-status-badge-inline rp-pill-healthy" :
                it.cls === "critico" ? "rp-status-badge-inline rp-pill-critical" :
                it.cls === "sem_custo" ? "rp-status-badge-inline rp-pill-nocost" :
                "rp-status-badge-inline rp-pill-attn";
              const badgeLabel =
                it.cls === "saudavel" ? "Saudável" :
                it.cls === "critico" ? "Crítico" :
                it.cls === "sem_custo" ? "Sem custo" :
                "Atenção";
              return `
                <tr>
                  <td>${escapeHTML(it.label || "—")}</td>
                  <td>${it.receita ? escapeHTML(brl(it.receita)) : "—"}</td>
                  <td>${it.lc ? escapeHTML(brl(it.lc)) : "—"}</td>
                  <td>${it.mc == null ? "—" : escapeHTML(formatPercentSmart(it.mc))}</td>
                  <td><span class="${badgeClass}">${escapeHTML(badgeLabel)}</span></td>
                  <td>${escapeHTML(it.obs || "")}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
      <div class="rp-note">Mostrando ${view.length} item(ns) com base nos filtros atuais.</div>
    ` : emptyHtml}
  `;

  const qEl = document.getElementById("rp-q");
  const stEl = document.getElementById("rp-status");
  const limEl = document.getElementById("rp-limit");
  const sortEl = document.getElementById("rp-sort");

  const rerender = () => renderAdvancedTable(payload);
  if (qEl) qEl.addEventListener("input", (e) => { state.q = e.target.value; rerender(); }, { once: true });
  if (stEl) stEl.addEventListener("change", (e) => { state.status = e.target.value; rerender(); }, { once: true });
  if (limEl) limEl.addEventListener("change", (e) => { state.limit = parseInt(e.target.value, 10) || 20; rerender(); }, { once: true });
  if (sortEl) sortEl.addEventListener("change", (e) => { state.sort = e.target.value; rerender(); }, { once: true });
}

function renderErro(msg) {
  const root = document.getElementById("rp-root");
  if (!root) return;
  root.innerHTML = `
    <div class="rp-error">
      <div style="font-weight:950;font-size:16px;margin-bottom:8px;">Não foi possível abrir o relatório</div>
      <div style="color:#7f1d1d;line-height:1.55;">${escapeHTML(msg || "Token inválido ou ausente.")}</div>
    </div>
  `;
}

function cardValueToText(card) {
  if (!card) return "—";
  if (card.tipoValor === "pct") return formatPercentSmart(card.raw);
  return String(card.valor || "—");
}

function buildResumoExecutivoMastigado({
  marketplace,
  finalResult,
  mcMedia,
  refundsCount,
  refundsTotal,
  lostRevenueTotal,
  cancelledCount,
  cancelledLostRevenue,
  unpaidCount,
  unpaidLostRevenue,
  unmatchedCount
}) {
  const linhas = [];

  if (finalResult == null) {
    linhas.push("Este relatório resume o desempenho financeiro do período com base nas planilhas enviadas.");
  } else if (finalResult > 0) {
    linhas.push("O fechamento do período apresentou resultado positivo, indicando boa eficiência operacional após as despesas.");
  } else if (finalResult < 0) {
    linhas.push("O fechamento do período apresentou resultado negativo. Recomendamos atenção aos principais custos e perdas do mês.");
  } else {
    linhas.push("O fechamento do período encerrou próximo do ponto de equilíbrio.");
  }

  if (mcMedia == null) {
    // nada
  } else if (mcMedia < 0) {
    linhas.push(`A margem média ficou em ${formatPercentSmart(mcMedia)}, o que caracteriza um cenário crítico (margem negativa).`);
  } else if (mcMedia < 0.15) {
    linhas.push(`A margem média ficou em ${formatPercentSmart(mcMedia)} — é uma faixa que exige atenção e ajustes finos em preço, frete, comissões e custo.`);
  } else {
    linhas.push(`A margem média ficou em ${formatPercentSmart(mcMedia)}, em um patamar saudável para o período.`);
  }

  const isShopee = String(marketplace || "").toLowerCase() === "shopee";
  if (isShopee) {
    if ((cancelledCount || 0) > 0) {
      linhas.push(`Foram identificados ${cancelledCount} pedido(s) cancelado(s) na Shopee, com impacto estimado de ${brl(cancelledLostRevenue)}.`);
    }
    if ((unpaidCount || 0) > 0) {
      linhas.push(`Houve ${unpaidCount} pedido(s) não pago(s), com faturamento não pago estimado de ${brl(unpaidLostRevenue)}.`);
    }
  } else {
    if ((refundsCount || 0) > 0) {
      linhas.push(`Foram identificados ${refundsCount} cancelamento(s)/reembolso(s), com impacto de ${brl(refundsTotal)} no período.`);
    }
    if ((lostRevenueTotal || 0) > 0) {
      linhas.push(`O faturamento perdido associado a pedidos cancelados somou ${brl(-lostRevenueTotal)}, reduzindo o potencial de receita do mês.`);
    }
  }

  if ((unmatchedCount || 0) > 0) {
    linhas.push("Há produtos sem custo cadastrado na base. Ao completar os custos e reprocessar, a precisão do fechamento tende a melhorar.");
  }

  const texto = linhas.join(" ");
  return texto || "—";
}

function renderEntrega(entrega) {
  const payload = entrega?.payload_json || {};
  const snapshot = payload?.snapshot || {};
  const summary = snapshot?.summary || payload?.summary || payload?.metadados?.summary || {};
  const normalized = getNormalizedSummary(payload);
  const metricas = snapshot?.metricasDerivadas || {};

  const titulo = payload?.titulo || entrega?.titulo || "Relatório";
  const periodo = payload?.periodo || entrega?.periodo || "";
  const cliente = payload?.cliente || {};
  const clienteNome = cliente?.nome || entrega?.cliente_nome || "";
  const clienteSlug = cliente?.slug || entrega?.cliente_slug || "";
  const marketplace =
    normalized?.marketplace ||
    payload?.marketplace ||
    payload?.metadados?.marketplace ||
    snapshot?.marketplace ||
    "";
  const geradoEm = payload?.metadados?.geradoEm || snapshot?.dataGeracao || entrega?.created_at || null;

  const detailedRows = Array.isArray(snapshot?.detailedRows) ? snapshot.detailedRows : (Array.isArray(payload?.detailedRows) ? payload.detailedRows : []);
  const unmatchedIds = Array.isArray(snapshot?.unmatchedIds) ? snapshot.unmatchedIds : (Array.isArray(payload?.unmatchedIds) ? payload.unmatchedIds : []);
  const unmatchedCancelled = Array.isArray(snapshot?.unmatchedCancelled) ? snapshot.unmatchedCancelled : [];
  const ignoredRevenue = safeNumber(snapshot?.ignoredRevenue, null);

  const cardsFromPayload = Array.isArray(payload?.cards) ? payload.cards : [];
  const secoesFromPayload = Array.isArray(payload?.secoes) ? payload.secoes : [];
  const tabelasFromPayload = Array.isArray(payload?.tabelas) ? payload.tabelas : [];

  const finalResult = safeNumber(metricas.finalResult, safeNumber(normalized?.finalResult, safeNumber(summary?.finalResult, null)));
  const mcMedia = safeNumber(metricas.mcMedia, safeNumber(normalized?.averageContributionMargin, safeNumber(summary?.averageContributionMargin, null)));
  const lcTotal = safeNumber(metricas.lcTotal, safeNumber(normalized?.contributionProfitTotal, safeNumber(summary?.contributionProfitTotal, null)));
  const gross = safeNumber(metricas.gross, safeNumber(normalized?.grossRevenueTotal, safeNumber(summary?.grossRevenueTotal, null)));
  const net = safeNumber(metricas.net, safeNumber(normalized?.paidRevenueTotal, safeNumber(summary?.paidRevenueTotal, null)));
  const tacos = safeNumber(metricas.tacos, safeNumber(normalized?.tacos, safeNumber(summary?.tacos, null)));

  const refundsTotal = safeNumber(metricas.refundsTotal, safeNumber(normalized?.refundsTotal, safeNumber(summary?.refundsTotal, null)));
  const refundsCount = safeNumber(metricas.refundsCount, safeNumber(normalized?.refundsCount, safeNumber(summary?.refundsCount, null)));
  const lostRevenueTotal = safeNumber(normalized?.lostRevenueTotal, safeNumber(summary?.lostRevenueTotal, null));

  const cancelledCount = safeNumber(normalized?.cancelledCount, safeNumber(summary?.cancelledCount, null)) || 0;
  const cancelledLostRevenue = safeNumber(normalized?.cancelledLostRevenue, safeNumber(summary?.cancelledLostRevenue, null)) || 0;
  const unpaidCount = safeNumber(normalized?.unpaidCount, safeNumber(summary?.unpaidCount, null)) || 0;
  const unpaidLostRevenue = safeNumber(normalized?.unpaidLostRevenue, safeNumber(summary?.unpaidLostRevenue, null)) || 0;
  const hasShopeeStatusData = !!normalized?.hasShopeeStatusData || cancelledCount > 0 || unpaidCount > 0 || cancelledLostRevenue > 0 || unpaidLostRevenue > 0;
  const isShopee = String(marketplace || "").toLowerCase() === "shopee" || hasShopeeStatusData;

  const statusGeral = getStatusGeral({
    finalResult,
    mcMedia,
    unmatchedCount: unmatchedIds.length,
    refundsCount: refundsCount || 0,
    lostRevenueTotal: isShopee ? (cancelledLostRevenue || 0) + (unpaidLostRevenue || 0) : (lostRevenueTotal || 0),
  });

  const resumoExecutivoMastigado =
    payload?.resumoExecutivoMastigado ||
    buildResumoExecutivoMastigado({
      marketplace,
      finalResult,
      mcMedia,
      refundsCount: refundsCount || 0,
      refundsTotal,
      lostRevenueTotal: lostRevenueTotal || 0,
      cancelledCount,
      cancelledLostRevenue,
      unpaidCount,
      unpaidLostRevenue,
      unmatchedCount: unmatchedIds.length,
    });

  const metaBits = [];
  if (marketplace) metaBits.push(`<span class="rp-chip"><strong>Marketplace</strong> ${escapeHTML(String(marketplace).toUpperCase())}</span>`);
  if (clienteNome || clienteSlug) metaBits.push(`<span class="rp-chip"><strong>Cliente</strong> ${escapeHTML(clienteNome || clienteSlug)}</span>`);
  if (periodo) metaBits.push(`<span class="rp-chip"><strong>Período</strong> ${escapeHTML(periodo)}</span>`);
  if (geradoEm) metaBits.push(`<span class="rp-chip"><strong>Data</strong> ${escapeHTML(formatDateTimePtBR(geradoEm))}</span>`);

  const coverSubtitle = "Uma apresentação executiva com os principais números, pontos de atenção, gráficos e recomendações práticas para o próximo período.";

  const cardsBase = isShopee
    ? [
    {
      titulo: "Resultado Final",
      valor: finalResult == null ? "—" : brl(finalResult),
      subtitulo: "Resultado após despesas (ADS/Venforce/Afiliados).",
      destaque: true,
      raw: finalResult,
      status: finalResult > 0 ? "positivo" : (finalResult < 0 ? "critico" : "neutro"),
    },
    { titulo: "Receita Bruta", valor: gross == null ? "—" : brl(gross), subtitulo: "Total vendido no período.", raw: gross, status: "neutro" },
    { titulo: "Receita Líquida", valor: net == null ? "—" : brl(net), subtitulo: "Receita recebida no período.", raw: net, status: "neutro" },
    { titulo: "LC Total", valor: lcTotal == null ? "—" : brl(lcTotal), subtitulo: "Lucro de contribuição total.", raw: lcTotal, status: lcTotal > 0 ? "positivo" : (lcTotal < 0 ? "critico" : "neutro") },
    { titulo: "MC Média", valor: mcMedia == null ? "—" : formatPercentSmart(mcMedia), subtitulo: "Margem de contribuição média.", raw: mcMedia, tipoValor: "pct", status: mcMedia >= 0.15 ? "positivo" : (mcMedia < 0 ? "critico" : "atencao") },
    { titulo: "TACoS", valor: tacos == null ? "—" : formatPercentSmart(tacos), subtitulo: "ADS como % da receita.", raw: tacos, tipoValor: "pct", status: "neutro" },
    { titulo: "Pedidos cancelados", valor: String(cancelledCount || 0), subtitulo: "Pedidos cancelados identificados na Shopee.", raw: cancelledCount, status: cancelledCount > 0 ? "atencao" : "neutro" },
    { titulo: "Faturamento perdido", valor: brl(-(cancelledLostRevenue || 0)), subtitulo: "Receita estimada de pedidos cancelados.", raw: cancelledLostRevenue, status: (cancelledLostRevenue || 0) > 0 ? "atencao" : "neutro" },
    { titulo: "Pedidos não pagos", valor: String(unpaidCount || 0), subtitulo: "Pedidos não pagos identificados na Shopee.", raw: unpaidCount, status: unpaidCount > 0 ? "atencao" : "neutro" },
    { titulo: "Faturamento não pago", valor: brl(-(unpaidLostRevenue || 0)), subtitulo: "Receita estimada de pedidos não pagos.", raw: unpaidLostRevenue, status: (unpaidLostRevenue || 0) > 0 ? "atencao" : "neutro" },
  ]
    : (cardsFromPayload.length ? cardsFromPayload : [
    {
      titulo: "Resultado Final",
      valor: finalResult == null ? "—" : brl(finalResult),
      subtitulo: "Resultado após despesas (ADS/Venforce/Afiliados).",
      destaque: true,
      raw: finalResult,
      status: finalResult > 0 ? "positivo" : (finalResult < 0 ? "critico" : "neutro"),
    },
    { titulo: "Receita Bruta", valor: gross == null ? "—" : brl(gross), subtitulo: "Total vendido no período.", raw: gross, status: "neutro" },
    { titulo: "Receita Líquida", valor: net == null ? "—" : brl(net), subtitulo: "Receita após taxas/reembolsos.", raw: net, status: "neutro" },
    { titulo: "LC Total", valor: lcTotal == null ? "—" : brl(lcTotal), subtitulo: "Lucro de contribuição total.", raw: lcTotal, status: lcTotal > 0 ? "positivo" : (lcTotal < 0 ? "critico" : "neutro") },
    { titulo: "MC Média", valor: mcMedia == null ? "—" : formatPercentSmart(mcMedia), subtitulo: "Margem de contribuição média.", raw: mcMedia, tipoValor: "pct", status: mcMedia >= 0.15 ? "positivo" : (mcMedia < 0 ? "critico" : "atencao") },
    { titulo: "TACoS", valor: tacos == null ? "—" : formatPercentSmart(tacos), subtitulo: "ADS como % da receita.", raw: tacos, tipoValor: "pct", status: "neutro" },
    { titulo: "Reembolsos / Cancelamentos", valor: refundsCount == null ? "—" : `${brl(refundsTotal)} (${refundsCount})`, subtitulo: "Impacto e volume de cancelamentos.", raw: refundsTotal, status: (refundsCount || 0) > 0 ? "atencao" : "neutro" },
    { titulo: "Faturamento Perdido", valor: lostRevenueTotal == null ? "—" : brl(-lostRevenueTotal), subtitulo: "Receita de pedidos cancelados.", raw: lostRevenueTotal, status: (lostRevenueTotal || 0) > 0 ? "atencao" : "neutro" },
  ]);

  const cardsHtml = cardsBase.length
    ? `<div class="rp-cards">${cardsBase.map((c) => {
        const featured = c.destaque ? "rp-card-featured" : "";
        const statusCss = cardStatusToCss(c.status);
        const statusLabel =
          c.status === "positivo" ? "Positivo" :
          c.status === "atencao" ? "Atenção" :
          c.status === "critico" ? "Crítico" : "Neutro";
        return `
          <div class="rp-card ${featured}">
            <div class="rp-card-title">${escapeHTML(c.titulo || "Indicador")}</div>
            <div class="rp-card-value">${escapeHTML(cardValueToText(c))}</div>
            <div class="rp-card-subtitle">${escapeHTML(c.subtitulo || "")}</div>
            <div class="rp-card-status ${statusCss}">${escapeHTML(statusLabel)}</div>
          </div>
        `;
      }).join("")}</div>`
    : `<p class="rp-lead">Sem indicadores disponíveis.</p>`;

  // Seções executivas dinâmicas
  const pontosPositivos = [];
  const pontosAtencao = [];
  const recomendacoes = [];
  const proximosPassos = [];

  if (finalResult != null && finalResult > 0) pontosPositivos.push("Resultado final positivo no período.");
    if (mcMedia != null && mcMedia >= 0.15) pontosPositivos.push(`Margem média saudável (${formatPercentSmart(mcMedia)}).`);
  if ((refundsCount || 0) === 0) pontosPositivos.push("Sem cancelamentos/reembolsos relevantes no período.");

  if (unmatchedIds.length > 0) pontosAtencao.push(`Base de custos incompleta: ${unmatchedIds.length} item(ns) sem custo cruzado.`);
  if ((refundsCount || 0) > 0) pontosAtencao.push(`Cancelamentos/reembolsos: ${refundsCount} ocorrência(s) com impacto de ${brl(refundsTotal)}.`);
  if ((lostRevenueTotal || 0) > 0) pontosAtencao.push(`Faturamento perdido: ${brl(-lostRevenueTotal)} em pedidos cancelados.`);
    if (mcMedia != null && mcMedia < 0) pontosAtencao.push(`Margem média negativa (${formatPercentSmart(mcMedia)}): revisar preços e custos é prioritário.`);
    else if (mcMedia != null && mcMedia < 0.15) pontosAtencao.push(`Margem média em faixa de atenção (${formatPercentSmart(mcMedia)}).`);

  if (unmatchedIds.length > 0) recomendacoes.push("Completar a base de custos dos itens pendentes e reprocessar o fechamento para maior precisão.");
  if ((refundsCount || 0) > 0) recomendacoes.push("Acompanhar motivos de cancelamento e revisar anúncios/estoque/prazo para reduzir perdas.");
  if ((lostRevenueTotal || 0) > 0) recomendacoes.push("Mapear os itens mais envolvidos em cancelamentos e atuar com melhorias (prazo, preço, qualidade, logística).");
  if (mcMedia != null && mcMedia < 0.15) recomendacoes.push("Priorizar itens com menor margem: ajustar preço, frete, comissões ou custo antes do próximo ciclo.");
  recomendacoes.push("Manter monitoramento dos itens saudáveis para preservar performance e evitar regressões.");

  proximosPassos.push("Atualizar custos e validar fretes/comissões nos itens críticos.");
  proximosPassos.push("Reprocessar o fechamento após ajustes e comparar evolução (resultado, MC, cancelamentos).");
  proximosPassos.push("Repetir o acompanhamento semanal dos indicadores principais.");

  // Produtos de destaque / em atenção (tolerante a colunas)
  const produtos = detailedRows;
  const firstRow = produtos[0] || {};
  const kId = pickKey(firstRow, ["item_id", "produto_id", "id", "sku"]) || pickKeyIncludes(firstRow, ["item", "produto", "sku", "id"]);
  const kNome = pickKey(firstRow, ["titulo", "title", "nome"]) || pickKeyIncludes(firstRow, ["titul", "nome", "descr"]);
  const kLc = pickKey(firstRow, ["lc"]) || pickKeyIncludes(firstRow, ["lc", "lucro", "contrib"]);
  const kMc = pickKey(firstRow, ["mc"]) || pickKeyIncludes(firstRow, ["mc", "margem"]);
  const kReceita = pickKey(firstRow, ["receita", "revenue", "paidrevenue", "grossrevenue"]) || pickKeyIncludes(firstRow, ["receita", "revenue", "fatur", "venda"]);

  function produtoLabel(row) {
    const nome = kNome ? row?.[kNome] : null;
    const id = kId ? row?.[kId] : null;
    const base = String(nome || "").trim() || String(id || "").trim();
    return base || "Item";
  }

  function asNum(row, key) {
    if (!key) return null;
    const n = Number(row?.[key]);
    return Number.isFinite(n) ? n : null;
  }

  const sortedByLc = [...produtos].sort((a, b) => (asNum(b, kLc) ?? -Infinity) - (asNum(a, kLc) ?? -Infinity));
  const sortedByMc = [...produtos].sort((a, b) => (asNum(b, kMc) ?? -Infinity) - (asNum(a, kMc) ?? -Infinity));
  const sortedByRevenue = kReceita ? [...produtos].sort((a, b) => (asNum(b, kReceita) ?? -Infinity) - (asNum(a, kReceita) ?? -Infinity)) : [];

  const destaque = [];
  if (sortedByLc.length) destaque.push(...sortedByLc.slice(0, 5).map((r) => ({ titulo: produtoLabel(r), pill: "Melhor LC", main: kLc ? brl(asNum(r, kLc)) : "—", sub: kMc ? `MC: ${formatPercentSmart(asNum(r, kMc))}` : "" })));
  if (!destaque.length && sortedByMc.length) destaque.push(...sortedByMc.slice(0, 5).map((r) => ({ titulo: produtoLabel(r), pill: "Melhor MC", main: kMc ? formatPercentSmart(asNum(r, kMc)) : "—", sub: kLc ? `LC: ${brl(asNum(r, kLc))}` : "" })));
  if (!destaque.length && sortedByRevenue.length) destaque.push(...sortedByRevenue.slice(0, 5).map((r) => ({ titulo: produtoLabel(r), pill: "Maior receita", main: brl(asNum(r, kReceita)), sub: kMc ? `MC: ${formatPercentSmart(asNum(r, kMc))}` : "" })));
  const destaqueUnique = destaque.slice(0, 5);

  const lcValueFromRow = (r) =>
    toNumberSafe(pickValue(r, ["LC", "lc", "Lucro", "lucro", "contributionProfit", "contribution_profit"])) ??
    (kLc ? asNum(r, kLc) : null);
  const mcDecFromRow = (r) => normalizePercentToDecimal(getMcValue(r));

  const classificados = produtos.map((r) => {
    const cls = classifyRow(r, unmatchedIds);
    return {
      r,
      cls,
      mc: mcDecFromRow(r),
      lc: lcValueFromRow(r),
    };
  });

  const prioridade = (cls) => (cls === "critico" ? 0 : cls === "sem_custo" ? 1 : cls === "atencao" ? 2 : 3);

  const produtosAtencaoLista = classificados
    .filter((x) => x.cls !== "saudavel")
    .sort((a, b) => {
      const pa = prioridade(a.cls);
      const pb = prioridade(b.cls);
      if (pa !== pb) return pa - pb;
      const amc = a.mc ?? 999;
      const bmc = b.mc ?? 999;
      if (amc !== bmc) return amc - bmc;
      const alc = a.lc ?? 0;
      const blc = b.lc ?? 0;
      return alc - blc;
    })
    .slice(0, 10);

  const saudaveisMenorMargem = classificados
    .filter((x) => x.cls === "saudavel" && x.mc !== null)
    .sort((a, b) => (a.mc ?? 999) - (b.mc ?? 999))
    .slice(0, 5);

  const produtosDestaqueHtml = destaqueUnique.length
    ? `
      <section class="rp-section">
        <h2 class="rp-section-title">Produtos de destaque</h2>
        <div class="rp-mini-cards">
          ${destaqueUnique.map((it) => `
            <div class="rp-mini">
              <div class="rp-mini-title">${escapeHTML(it.pill)}</div>
              <div class="rp-mini-main" style="font-size:14px;">${escapeHTML(it.titulo)}</div>
              <div class="rp-mini-main" style="font-size:18px;margin-top:6px;">${escapeHTML(it.main)}</div>
              ${it.sub ? `<div class="rp-mini-sub">${escapeHTML(it.sub)}</div>` : `<div class="rp-mini-sub">—</div>`}
            </div>
          `).join("")}
        </div>
      </section>
    ` : "";

  const produtosAtencaoHtml = `
    <section class="rp-section">
      <h2 class="rp-section-title">Produtos em atenção</h2>
      ${produtosAtencaoLista.length ? `
        <div style="overflow:auto;">
          <table class="rp-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>MC</th>
                <th>LC</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${produtosAtencaoLista.map((x) => {
                const tag =
                  x.cls === "critico" ? "Crítico" :
                  x.cls === "sem_custo" ? "Sem custo" :
                  "Atenção";
                const pillClass =
                  x.cls === "critico" ? "rp-pill rp-pill-critical" :
                  x.cls === "sem_custo" ? "rp-pill rp-pill-attn" :
                  "rp-pill rp-pill-attn";
                return `
                  <tr>
                    <td>${escapeHTML(produtoLabel(x.r))}</td>
                    <td>${x.mc == null ? "—" : escapeHTML(formatPercentSmart(x.mc))}</td>
                    <td>${x.lc == null ? "—" : escapeHTML(brl(x.lc))}</td>
                    <td><span class="${pillClass}">${escapeHTML(tag)}</span></td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      ` : `
        <div class="rp-muted-box">Nenhum produto crítico ou em atenção encontrado neste fechamento.</div>
      `}
    </section>
  `;

  const produtosMenorMargemHtml = saudaveisMenorMargem.length
    ? `
      <section class="rp-section">
        <h2 class="rp-section-title">Produtos de menor margem</h2>
        <p class="rp-lead">Itens saudáveis (MC ≥ 15%), mas que merecem acompanhamento por estarem entre as menores margens da amostra.</p>
        <div style="overflow:auto;">
          <table class="rp-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>MC</th>
                <th>LC</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${saudaveisMenorMargem.map((x) => `
                <tr>
                  <td>${escapeHTML(produtoLabel(x.r))}</td>
                  <td>${x.mc == null ? "—" : escapeHTML(formatPercentSmart(x.mc))}</td>
                  <td>${x.lc == null ? "—" : escapeHTML(brl(x.lc))}</td>
                  <td><span class="rp-pill rp-pill-muted">Saudável</span></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </section>
    `
    : "";

  // Seções "internas" do payload (ex.: unmatchedIds) - melhoradas e sem parecer erro técnico
  const secoesMelhoradas = [];

  if (isShopee) {
    if ((cancelledCount || 0) > 0 || (cancelledLostRevenue || 0) > 0) {
      secoesMelhoradas.push({
        tipo: "atencao",
        titulo: "Cancelamentos Shopee",
        texto: `No período, houve ${cancelledCount || 0} pedido(s) cancelado(s), com impacto estimado de ${brl(cancelledLostRevenue || 0)}. Recomendação: identificar causas e reduzir incidência.`,
        bullets: [],
      });
    }
    if ((unpaidCount || 0) > 0 || (unpaidLostRevenue || 0) > 0) {
      secoesMelhoradas.push({
        tipo: "atencao",
        titulo: "Pedidos não pagos Shopee",
        texto: `Foram identificados ${unpaidCount || 0} pedido(s) não pago(s), com faturamento não pago estimado de ${brl(unpaidLostRevenue || 0)}. Recomendação: revisar motivos e melhorar conversão/pagamento.`,
        bullets: [],
      });
    }
    if ((cancelledLostRevenue || 0) > 0 || (unpaidLostRevenue || 0) > 0) {
      secoesMelhoradas.push({
        tipo: "atencao",
        titulo: "Faturamento perdido Shopee",
        texto: `Impacto estimado: ${brl((cancelledLostRevenue || 0) + (unpaidLostRevenue || 0))} somando cancelados e não pagos.`,
        bullets: [],
      });
    }
  }

  for (const s of secoesFromPayload) {
    const titulo = String(s?.titulo || "").trim();
    const tipo = String(s?.tipo || "").toLowerCase() === "atencao" ? "atencao" : "nota";
    if (titulo.toLowerCase().includes("produtos sem custo")) {
      secoesMelhoradas.push({
        tipo,
        titulo: "Itens sem custo cadastrado",
        texto:
          `Alguns produtos não foram cruzados com a base de custos. Isso não é um erro do relatório — significa apenas que faltam custos cadastrados para esses itens. ` +
          `Ao completar os custos e reprocessar, o fechamento fica mais preciso. ` +
          (ignoredRevenue != null ? `Receita não considerada no cálculo: ${brl(ignoredRevenue)}.` : ""),
        bullets: Array.isArray(s?.bullets) ? s.bullets.slice(0, 30) : [],
      });
      continue;
    }
    if (!isShopee && (titulo.toLowerCase().includes("cancelamentos") || titulo.toLowerCase().includes("reembols"))) {
      secoesMelhoradas.push({
        tipo,
        titulo: "Cancelamentos e reembolsos",
        texto:
          `No período, houve ${refundsCount == null ? "—" : refundsCount} ocorrência(s), com impacto total de ${brl(refundsTotal)}. ` +
          `Recomendação: acompanhar motivos e atuar nos itens/fluxos com maior incidência.`,
        bullets: [],
      });
      continue;
    }
    if (!isShopee && titulo.toLowerCase().includes("faturamento perdido")) {
      secoesMelhoradas.push({
        tipo,
        titulo: "Faturamento perdido",
        texto:
          `Estimamos ${brl(lostRevenueTotal == null ? null : -lostRevenueTotal)} de faturamento perdido por cancelamentos. ` +
          `Recomendação: identificar os itens mais envolvidos e reduzir causas (prazo, estoque, qualidade, logística).`,
        bullets: [],
      });
      continue;
    }
    secoesMelhoradas.push({
      tipo,
      titulo: titulo || "Observação",
      texto: String(s?.texto || "").trim(),
      bullets: Array.isArray(s?.bullets) ? s.bullets.slice(0, 30) : [],
    });
  }

  const secoesHtml = secoesMelhoradas.length
    ? secoesMelhoradas.map((s) => {
        const isAttn = s.tipo === "atencao";
        const badge = isAttn ? `<span class="rp-badge rp-badge-attn">Atenção</span>` : `<span class="rp-badge">Nota</span>`;
        const bullets = Array.isArray(s.bullets) && s.bullets.length
          ? `<ul style="margin:10px 0 0;padding-left:18px;color:#374151;line-height:1.6;">${s.bullets.map((b) => `<li>${escapeHTML(String(b))}</li>`).join("")}</ul>`
          : "";
        return `
          <section class="rp-section">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
              <h2 class="rp-section-title">${escapeHTML(s.titulo)}</h2>
              ${badge}
            </div>
            <p class="rp-lead">${escapeHTML(s.texto || "—")}</p>
            ${bullets}
          </section>
        `;
      }).join("")
    : "";

  // Tabela amostra tolerante (preferir snapshot.detailedRows; fallback payload.tabelas)
  let tabelasHtml = "";
  if (Array.isArray(detailedRows) && detailedRows.length > 0) {
    const sample = detailedRows.slice(0, 30);

    const headerMap = (col) => {
      const k = normalizeKey(col);
      if (k === "lc") return "LC (R$)";
      if (k === "mc") return "MC (%)";
      if (k.includes("imposto")) return "Imposto (%)";
      if (k.includes("total") && k.includes("brl")) return "Total recebido";
      if (k.includes("venda") && k.includes("total")) return "Valor vendido";
      if (k.includes("#") && k.includes("anuncio")) return "Anúncio";
      if (k.includes("anuncio")) return "Anúncio";
      if (k.includes("preco") && k.includes("custo") && k.includes("total")) return "Custo total";
      if (k.includes("preco") && k.includes("custo")) return "Custo unit.";
      if (k.includes("titulo") || k.includes("title")) return "Produto";
      return col;
    };

    const isPercentCol = (col) => {
      const k = normalizeKey(col);
      return k === "mc" || k.includes("imposto") || k.includes("percent") || k.includes("%");
    };
    const isMoneyCol = (col) => {
      const k = normalizeKey(col);
      return k === "lc" || k.includes("custo") || k.includes("preco") || k.includes("valor") || k.includes("receita") || k.includes("total") || k.includes("brl") || k.includes("lucro");
    };
    const isQtyCol = (col) => {
      const k = normalizeKey(col);
      return k.includes("qtd") || k.includes("quant") || k.includes("unid") || k.includes("units") || k.includes("qty");
    };

    const formatCell = (col, value) => {
      if (value === null || value === undefined || String(value).trim() === "") return "—";
      const n = toNumberSafe(value);
      if (n === null) return String(value);
      if (isPercentCol(col)) {
        // para MC e imposto: aceitar escala 0-1, 0-100 ou bugada
        return formatPercentSmart(value);
      }
      if (isMoneyCol(col)) return brl(n);
      if (isQtyCol(col)) return new Intl.NumberFormat("pt-BR").format(n);
      return String(value);
    };

    // Colunas prioritárias (com fallback a colunas existentes)
    const first = sample[0] || {};
    const allCols = Object.keys(first);
    const pickFromAll = (cands) => allCols.find((c) => cands.includes(normalizeKey(c))) || null;
    const colsPreferred = [
      pickFromAll(["titulo", "title", "titulo_do_anuncio", "titulodoanuncio"]),
      pickFromAll(["item_id", "produto_id", "id", "sku", "mlb"]),
      pickFromAll(["venda_total", "vendatotal", "receita", "total", "valor", "paidrevenue", "productrevenue"]),
      pickFromAll(["lc", "lucro", "contributionprofit"]),
      pickFromAll(["mc", "margem", "margem_contribuicao"]),
      pickFromAll(["imposto", "imposto_percentual"]),
      pickFromAll(["preco_de_custo", "preco_custo", "custo", "custo_produto"]),
      pickFromAll(["preco_de_custo_total", "preco_custo_total", "custo_total", "totalcost"]),
      pickFromAll(["#_de_anuncio", "#deanuncio", "anuncio"]),
    ].filter(Boolean);

    const colsFallback = colsPreferred.length ? colsPreferred : allCols.slice(0, 10);
    const cols = Array.from(new Set(colsFallback)).slice(0, 10);

    const head = cols.map((c) => `<th>${escapeHTML(headerMap(c))}</th>`).join("");
    const body = sample.map((row) => {
      const tds = cols.map((c) => `<td>${escapeHTML(formatCell(c, row?.[c]))}</td>`).join("");
      return `<tr>${tds}</tr>`;
    }).join("");
    const totalOriginal = safeNumber(snapshot?.detailedRowsTotal, null);
    tabelasHtml = `
      <section class="rp-section">
        <h2 class="rp-section-title">Amostra de itens</h2>
        <p class="rp-lead">Para leitura rápida, exibimos uma amostra dos itens. O relatório completo permanece registrado no sistema.</p>
        <div style="overflow:auto;">
          <table class="rp-table">
            <thead><tr>${head}</tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
        ${totalOriginal != null && totalOriginal > sample.length
          ? `<div style="margin-top:10px;color:#6b7280;font-size:12.5px;">Exibindo ${sample.length} de ${totalOriginal} linha(s).</div>`
          : ""}
      </section>
    `;
  } else if (tabelasFromPayload.length) {
    tabelasHtml = tabelasFromPayload.map((t) => {
      const cols = Array.isArray(t.colunas) ? t.colunas : [];
      const linhas = Array.isArray(t.linhas) ? t.linhas : [];
      const head = cols.map((c) => `<th>${escapeHTML(c)}</th>`).join("");
      const body = linhas.map((row) => {
        const tds = cols.map((c) => `<td>${escapeHTML(row?.[c] ?? "")}</td>`).join("");
        return `<tr>${tds}</tr>`;
      }).join("");
      return `
        <section class="rp-section">
          <h2 class="rp-section-title">${escapeHTML(t.titulo || "Tabela")}</h2>
          ${t.descricao ? `<p class="rp-lead" style="margin-top:0;">${escapeHTML(t.descricao)}</p>` : ""}
          <div style="overflow:auto;">
            <table class="rp-table">
              <thead><tr>${head}</tr></thead>
              <tbody>${body}</tbody>
            </table>
          </div>
        </section>
      `;
    }).join("");
  }

  const conclusaoFechamento = (() => {
    const rowsAll = getRows(payload);
    const counts = { saudavel: 0, atencao: 0, critico: 0, sem_custo: 0 };
    rowsAll.forEach((r) => { const c = classifyRow(r, unmatchedIds); counts[c] = (counts[c] || 0) + 1; });

    const frases = [];
    if (finalResult != null && finalResult > 0) frases.push("O fechamento apresentou resultado positivo.");
    else if (finalResult != null && finalResult < 0) frases.push("O fechamento apresentou resultado negativo.");
    else frases.push("O fechamento ficou próximo do ponto de equilíbrio.");

    if (mcMedia != null) {
      if (mcMedia < 0) frases.push(`A margem média está crítica (${formatPercentSmart(mcMedia)}).`);
      else if (mcMedia < 0.15) frases.push(`A margem média exige atenção (${formatPercentSmart(mcMedia)}).`);
      else frases.push(`A margem média está saudável (${formatPercentSmart(mcMedia)}).`);
    }

    const pontos = [];
    if (isShopee) {
      if ((cancelledCount || 0) > 0) pontos.push("pedidos cancelados");
      if ((unpaidCount || 0) > 0) pontos.push("pedidos não pagos");
      if ((cancelledLostRevenue || 0) > 0 || (unpaidLostRevenue || 0) > 0) pontos.push("faturamento perdido (cancelados/não pagos)");
    } else {
      if ((refundsCount || 0) > 0) pontos.push("cancelamentos/reembolsos");
      if ((lostRevenueTotal || 0) > 0) pontos.push("faturamento perdido");
    }
    if ((counts.sem_custo || 0) > 0) pontos.push("itens sem custo cadastrado");
    if ((counts.critico || 0) > 0) pontos.push("produtos críticos");
    if ((counts.atencao || 0) > 0) pontos.push("produtos em atenção");

    if (pontos.length) {
      frases.push(`Os principais pontos de atenção foram: ${pontos.slice(0, 4).join(", ")}.`);
    }

    const recs = [];
    if ((counts.sem_custo || 0) > 0) recs.push("revisar a base de custos e reprocessar");
    if ((counts.critico || 0) > 0 || (counts.atencao || 0) > 0) recs.push("priorizar ajustes nos itens de menor margem");
    if (isShopee) {
      if ((cancelledCount || 0) > 0) recs.push("reduzir cancelamentos na Shopee");
      if ((unpaidCount || 0) > 0) recs.push("atuar para reduzir não pagos e melhorar conversão");
    } else {
      if ((refundsCount || 0) > 0) recs.push("acompanhar cancelamentos para reduzir perdas");
    }
    if (recs.length) {
      frases.push(`Recomendação: ${recs.slice(0, 3).join(", ")} antes do próximo período.`);
    }

    return frases.join(" ");
  })();

  const root = document.getElementById("rp-root");
  if (!root) return;
  root.innerHTML = `
    <article class="rp-sheet">
      <header class="rp-cover">
        <div class="rp-cover-grid">
          <div>
            <div class="rp-cover-brand">
              <div class="rp-cover-mark">V</div>
              <div class="rp-cover-brand-lines">
                <div class="rp-cover-brand-name">VenForce</div>
                <div class="rp-cover-brand-tagline">Relatório executivo · entrega para cliente</div>
              </div>
            </div>
            <div class="rp-kicker">FECHAMENTO FINANCEIRO</div>
            <div class="rp-title">${escapeHTML("Relatório de Fechamento Financeiro")}</div>
            <p class="rp-subtitle">${escapeHTML(coverSubtitle)}</p>
            <div class="rp-meta">${metaBits.join("")}</div>
          </div>
          <div class="rp-status-badge ${statusIdToCss(statusGeral.id)}">${escapeHTML(statusGeral.label)}</div>
        </div>
      </header>

      <section class="rp-section">
        <h2 class="rp-section-title">Resumo executivo</h2>
        <p class="rp-lead">${escapeHTML(resumoExecutivoMastigado)}</p>
      </section>

      <section class="rp-section">
        <h2 class="rp-section-title">Indicadores</h2>
        ${cardsHtml}
      </section>

      <section class="rp-section">
        <h2 class="rp-section-title">Análise visual</h2>
        <div id="rp-charts-host" class="rp-muted-box">Preparando gráficos…</div>
      </section>

      <section class="rp-section">
        <h2 class="rp-section-title">Visão geral do mês</h2>
        <div class="rp-grid-2">
          <div class="rp-callout">
            <div class="rp-callout-title">Pontos positivos</div>
            <p>${escapeHTML(pontosPositivos.length ? pontosPositivos.join(" ") : "Sem destaques positivos automáticos para este período.")}</p>
          </div>
          <div class="rp-callout">
            <div class="rp-callout-title">Pontos de atenção</div>
            <p>${escapeHTML(pontosAtencao.length ? pontosAtencao.join(" ") : "Nenhum ponto crítico identificado a partir do snapshot.")}</p>
          </div>
        </div>
      </section>

      <section class="rp-section">
        <h2 class="rp-section-title">Recomendações práticas</h2>
        <p class="rp-lead">${escapeHTML(recomendacoes.slice(0, 5).join(" "))}</p>
      </section>

      <section class="rp-section">
        <h2 class="rp-section-title">Próximos passos</h2>
        <ul style="margin:10px 0 0;padding-left:18px;color:#374151;line-height:1.6;">
          ${proximosPassos.slice(0, 5).map((x) => `<li>${escapeHTML(x)}</li>`).join("")}
        </ul>
      </section>

      ${produtosDestaqueHtml}
      ${produtosAtencaoHtml}
      ${produtosMenorMargemHtml}
      ${secoesHtml}
      ${tabelasHtml}

      <section class="rp-section rp-print-break">
        <h2 class="rp-section-title">Detalhamento dos produtos</h2>
        <div id="rp-table-host"></div>
      </section>

      <section class="rp-section">
        <h2 class="rp-section-title">Conclusão do fechamento</h2>
        <p class="rp-lead">${escapeHTML(conclusaoFechamento || "—")}</p>
      </section>
    </article>
  `;

  try { renderCharts(payload); } catch (_) {}
  try { renderAdvancedTable(payload); } catch (_) {}
}

async function main() {
  const token = String(qs("token") || "").trim();
  const btnPdf = document.getElementById("btn-rp-pdf");
  if (btnPdf) btnPdf.addEventListener("click", () => window.print());

  if (!token) {
    renderErro("Token ausente. Peça ao responsável o link completo do relatório.");
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/public/entregas/${encodeURIComponent(token)}`);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      renderErro(json?.erro || json?.error || "Relatório não encontrado ou expirado.");
      return;
    }
    renderEntrega(json?.entrega);

    if (String(qs("print") || "").trim() === "1") {
      setTimeout(() => window.print(), 350);
    }
  } catch (err) {
    renderErro(err?.message || "Erro ao carregar relatório.");
  }
}

main();

