// relatorio-publico-novo.js — VenForce Entrega ao Cliente
// Redesenhado: foco em dados visuais, sem blocos de texto desnecessários.
// Suporta MeLi e Shopee. Compatível com o payload existente de /public/entregas/:token

const API_BASE = "https://venforce-server.onrender.com";

// ── UTILS ────────────────────────────────────────────────────────────────────

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function brl(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(n);
}

function pct(v, decimals = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  // Aceita decimal (0.2361) ou porcentagem (23.61) — normaliza
  const dec = Math.abs(n) > 1 ? n / 100 : n;
  return (dec * 100).toFixed(decimals) + "%";
}

function num(v) {
  return new Intl.NumberFormat("pt-BR").format(Number(v) || 0);
}

function toN(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fmtDate(d) {
  try { return new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }); }
  catch { return "—"; }
}

function normalizeKey(k) {
  return String(k || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function pickVal(row, candidates) {
  if (!row || typeof row !== "object") return undefined;
  const entries = Object.entries(row);
  for (const cand of candidates) {
    const cn = normalizeKey(cand);
    const hit = entries.find(([k]) => normalizeKey(k) === cn);
    if (hit) return hit[1];
  }
  // fallback: includes
  for (const cand of candidates) {
    const cn = normalizeKey(cand);
    const hit = entries.find(([k]) => normalizeKey(k).includes(cn));
    if (hit) return hit[1];
  }
  return undefined;
}

function truncate(s, n = 36) {
  const str = String(s || "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

// ── PAYLOAD PARSING ──────────────────────────────────────────────────────────

function getPayloadData(payload) {
  const snap = payload?.snapshot || {};
  const rawSummary = snap?.summaryNormalized || payload?.summaryNormalized || payload?.summary || {};

  const marketplace = String(
    payload?.marketplace ||
    payload?.metadados?.marketplace ||
    snap?.marketplace ||
    rawSummary?.marketplace || ""
  ).toLowerCase();

  const s = rawSummary;
  const gross          = toN(s.grossRevenueTotal);
  const net            = toN(s.paidRevenueTotal);
  const lcTotal        = toN(s.contributionProfitTotal);
  const mcMedia        = toN(s.averageContributionMargin);   // decimal 0..1
  const finalResult    = toN(s.finalResult);
  const tacos          = toN(s.tacos);                       // decimal 0..1
  const refundsTotal   = toN(s.refundsTotal);
  const refundsCount   = toN(s.refundsCount);
  const lostRevenue    = toN(s.lostRevenueTotal);
  const cancelledCount = toN(s.cancelledCount);
  const cancelledLost  = toN(s.cancelledLostRevenue);
  const unpaidCount    = toN(s.unpaidCount);
  const unpaidLost     = toN(s.unpaidLostRevenue);

  const isShopee = marketplace.includes("shopee") ||
    cancelledCount > 0 || cancelledLost > 0 || unpaidCount > 0 || unpaidLost > 0;

  const rows = Array.isArray(snap?.detailedRows) && snap.detailedRows.length
    ? snap.detailedRows
    : (Array.isArray(payload?.detailedRows) ? payload.detailedRows : []);

  const unmatchedIds = Array.isArray(snap?.unmatchedIds)
    ? snap.unmatchedIds
    : (Array.isArray(payload?.unmatchedIds) ? payload.unmatchedIds : []);

  const meta = payload?.metadados || {};
  const cliente = payload?.cliente || {};
  const periodo = String(payload?.periodo || "");
  const geradoEm = meta?.geradoEm || snap?.dataGeracao || null;
  const ads = toN(meta?.ads ?? snap?.ads);
  const venforce = toN(meta?.venforce ?? snap?.venforce);
  const affiliates = toN(meta?.affiliates ?? snap?.affiliates);

  return {
    marketplace, isShopee,
    gross, net, lcTotal, mcMedia, finalResult, tacos,
    refundsTotal, refundsCount, lostRevenue,
    cancelledCount, cancelledLost, unpaidCount, unpaidLost,
    rows, unmatchedIds,
    periodo, geradoEm, cliente, ads, venforce, affiliates,
    ignoredRevenue: toN(snap?.ignoredRevenue ?? payload?.ignoredRevenue),
  };
}

// ── PRODUCT CLASSIFICATION ───────────────────────────────────────────────────

function classifyProduct(row, unmatchedIds) {
  const id = String(pickVal(row, ["# de anuncio", "# de anúncio", "mlb", "id", "sku"]) || "").trim();
  if (unmatchedIds.some(u => String(u).trim() === id)) return "sem_custo";
  const mc = getMcDecimal(row);
  if (mc === null) return "sem_custo";
  if (mc < 0)    return "critico";
  if (mc < 0.15) return "atencao";
  return "saudavel";
}

function getMcDecimal(row) {
  const raw = pickVal(row, ["mc", "MC", "margem", "margem_contribuicao"]);
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs <= 1) return n;
  if (abs <= 100) return n / 100;
  return n / 100;
}

function getLcValue(row) {
  const raw = pickVal(row, ["lc", "LC", "lucro", "contribution_profit", "contributionProfit"]);
  return toN(raw, null);
}

function getRevenueValue(row) {
  const raw = pickVal(row, [
    "venda total", "venda_total", "vendatotal",
    "receita", "productrevenue", "product_revenue",
    "total (brl)", "total_brl",
    "grossrevenue", "gross_revenue",
  ]);
  return toN(raw, null);
}

function getProductLabel(row) {
  const nome = pickVal(row, ["titulo do anuncio", "título do anúncio", "titulo", "title", "nome"]);
  if (nome && String(nome).trim()) return String(nome).trim();
  const id = pickVal(row, ["# de anuncio", "# de anúncio", "mlb", "id", "sku"]);
  if (id && String(id).trim()) return String(id).trim();
  return "—";
}

function getProductId(row) {
  const id = pickVal(row, ["# de anuncio", "# de anúncio", "mlb", "id", "sku"]);
  return String(id || "").trim();
}

// ── STATUS BADGE HELPERS ─────────────────────────────────────────────────────

function statusBadgeClass(status) {
  if (status === "positivo" || status === "saudavel") return "vp-sp-ok";
  if (status === "atencao" || status === "warn")      return "vp-sp-warn";
  if (status === "critico" || status === "crit")      return "vp-sp-crit";
  return "vp-sp-muted";
}

function statusBadgeLabel(status) {
  if (status === "saudavel") return "Saudável";
  if (status === "atencao")  return "Atenção";
  if (status === "critico")  return "Crítico";
  return "Sem custo";
}

// ── CHART DATA ────────────────────────────────────────────────────────────────

function buildChartData(rows, unmatchedIds) {
  // Top 10 por LC
  const rowsWithLc = rows
    .map(r => ({ label: getProductLabel(r), id: getProductId(r), lc: getLcValue(r), rev: getRevenueValue(r) }))
    .filter(r => r.lc !== null)
    .sort((a, b) => b.lc - a.lc);

  const topLc = rowsWithLc.slice(0, 10);

  // Distribuição de status
  const dist = { saudavel: 0, atencao: 0, critico: 0, sem_custo: 0 };
  for (const r of rows) {
    const cls = classifyProduct(r, unmatchedIds);
    dist[cls] = (dist[cls] || 0) + 1;
  }

  return { topLc, dist };
}

// ── CHARTS RENDERING ─────────────────────────────────────────────────────────

let _charts = {};

function destroyCharts() {
  Object.values(_charts).forEach(c => { try { c.destroy(); } catch {} });
  _charts = {};
}

function renderCharts(chartData) {
  destroyCharts();

  // Chart 1: Top 10 por LC (bar horizontal)
  const elBar = document.getElementById("vp-chart-bar");
  if (elBar && chartData.topLc.length > 0) {
    const labels = chartData.topLc.map(r => truncate(r.label, 28));
    const values = chartData.topLc.map(r => r.lc);
    _charts.bar = new window.Chart(elBar, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: "LC (R$)",
          data: values,
          backgroundColor: values.map(v => v >= 0
            ? "rgba(90,42,143,.55)"
            : "rgba(185,28,28,.45)"),
          borderColor: values.map(v => v >= 0
            ? "rgba(90,42,143,1)"
            : "rgba(185,28,28,1)"),
          borderWidth: 1,
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => chartData.topLc[items[0]?.dataIndex]?.label || "",
              label: ctx => ` LC: ${brl(ctx.parsed.x)}`,
            }
          }
        },
        scales: {
          x: {
            ticks: { color: "#6B7280", font: { size: 11 }, callback: v => brl(v) },
            grid: { color: "rgba(0,0,0,.05)" },
          },
          y: { ticks: { color: "#374151", font: { size: 11 } }, grid: { display: false } }
        }
      }
    });
  } else if (elBar) {
    elBar.closest(".vp-chart-card").innerHTML +=
      `<div class="vp-chart-note" style="text-align:center;padding:40px 0;">Dados insuficientes para o gráfico.</div>`;
  }

  // Chart 2: Donut de distribuição
  const elDonut = document.getElementById("vp-chart-donut");
  if (elDonut) {
    const d = chartData.dist;
    const total = d.saudavel + d.atencao + d.critico + d.sem_custo;
    if (total > 0) {
      _charts.donut = new window.Chart(elDonut, {
        type: "doughnut",
        data: {
          labels: ["Saudável", "Atenção", "Crítico", "Sem custo"],
          datasets: [{
            data: [d.saudavel, d.atencao, d.critico, d.sem_custo],
            backgroundColor: [
              "rgba(21,128,61,.65)",
              "rgba(180,83,9,.55)",
              "rgba(185,28,28,.55)",
              "rgba(107,114,128,.45)",
            ],
            borderColor: ["#15803D", "#B45309", "#B91C1C", "#6B7280"],
            borderWidth: 1,
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          cutout: "65%",
          plugins: {
            legend: { position: "bottom", labels: { color: "#374151", font: { size: 12 }, padding: 12 } },
            tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed} produto(s)` } }
          }
        }
      });
    } else {
      elDonut.closest(".vp-chart-card").querySelector(".vp-chart-wrap-donut").innerHTML =
        `<div style="text-align:center;padding:40px 0;color:#6B7280;font-size:13px;">Sem dados de produtos.</div>`;
    }
  }
}

// ── TABLE RENDERING ───────────────────────────────────────────────────────────

let _tableState = { q: "" };

function renderTable(rows, unmatchedIds) {
  const host = document.getElementById("vp-table-body");
  const footer = document.getElementById("vp-table-footer");
  if (!host) return;

  const q = _tableState.q.trim().toLowerCase();

  const enriched = rows.map(row => ({
    row,
    label: getProductLabel(row),
    id: getProductId(row),
    lc: getLcValue(row),
    mc: getMcDecimal(row),
    rev: getRevenueValue(row),
    cls: classifyProduct(row, unmatchedIds),
  }));

  const filtered = q
    ? enriched.filter(r => `${r.label} ${r.id}`.toLowerCase().includes(q))
    : enriched;

  // Sort: LC descending (nulls last)
  filtered.sort((a, b) => {
    if (a.lc === null && b.lc === null) return 0;
    if (a.lc === null) return 1;
    if (b.lc === null) return -1;
    return b.lc - a.lc;
  });

  const displayed = filtered.slice(0, 50);

  host.innerHTML = displayed.map(r => {
    const pillCls = statusBadgeClass(r.cls);
    const pillLabel = statusBadgeLabel(r.cls);
    const idStr = r.id && r.id !== r.label ? r.id : "";
    return `
      <tr>
        <td>
          <div class="vp-table-product-name">${esc(truncate(r.label, 50))}</div>
          ${idStr ? `<div class="vp-table-product-id">${esc(idStr)}</div>` : ""}
        </td>
        <td class="right">${r.rev !== null ? brl(r.rev) : "—"}</td>
        <td class="right">${r.lc !== null ? brl(r.lc) : "—"}</td>
        <td class="right">${r.mc !== null ? pct(r.mc) : "—"}</td>
        <td><span class="vp-status-pill ${pillCls}">${esc(pillLabel)}</span></td>
      </tr>
    `;
  }).join("") || `
    <tr><td colspan="5" style="text-align:center;padding:32px;color:#6B7280;">
      Nenhum produto encontrado.
    </td></tr>
  `;

  if (footer) {
    footer.textContent = `Exibindo ${displayed.length} de ${filtered.length} produto(s)${q ? " (filtrado)" : ""}.`;
  }
}

// ── MAIN RENDER ───────────────────────────────────────────────────────────────

function renderReport(payload) {
  const d = getPayloadData(payload);
  const root = document.getElementById("vp-root");
  if (!root) return;

  // Status geral
  let statusCls, statusLabel;
  if (d.finalResult < 0 || d.mcMedia < 0) {
    statusCls = "vp-status-crit"; statusLabel = "Resultado Crítico";
  } else if (d.mcMedia < 0.15 || d.unmatchedIds.length > 0 || d.refundsCount > 0 || d.lostRevenue > 0) {
    statusCls = "vp-status-warn"; statusLabel = "Atenção Necessária";
  } else {
    statusCls = "vp-status-pos"; statusLabel = "Resultado Positivo";
  }

  // KPI pill helper
  function kpiPill(value, type = "brl") {
    if (type === "mc") {
      const pctVal = d.mcMedia;
      if (pctVal >= 0.15) return `<span class="vp-kpi-pill vp-pill-pos">Saudável (≥15%)</span>`;
      if (pctVal < 0)     return `<span class="vp-kpi-pill vp-pill-crit">Crítico</span>`;
      return `<span class="vp-kpi-pill vp-pill-warn">Atenção (&lt;15%)</span>`;
    }
    if (type === "result") {
      if (value > 0) return `<span class="vp-kpi-pill vp-pill-pos">Positivo</span>`;
      if (value < 0) return `<span class="vp-kpi-pill vp-pill-crit">Negativo</span>`;
      return `<span class="vp-kpi-pill vp-pill-neut">Neutro</span>`;
    }
    return `<span class="vp-kpi-pill vp-pill-neut">—</span>`;
  }

  // Alerts (only meaningful ones)
  const alertItems = [];
  const cancelValue = d.isShopee
    ? (d.cancelledLost || 0) + (d.unpaidLost || 0)
    : Math.abs(d.refundsTotal || 0);
  const cancelCount = d.isShopee
    ? (d.cancelledCount || 0) + (d.unpaidCount || 0)
    : (d.refundsCount || 0);

  if (cancelCount > 0 || cancelValue > 0) {
    alertItems.push({
      icon: "⚠️",
      text: d.isShopee
        ? `<strong>${num(d.cancelledCount || 0)} cancelado(s)</strong> (${brl(d.cancelledLost || 0)}) + <strong>${num(d.unpaidCount || 0)} não pago(s)</strong> (${brl(d.unpaidLost || 0)})`
        : `<strong>${num(cancelCount)} cancelamento(s)/reembolso(s)</strong> com impacto de ${brl(Math.abs(d.refundsTotal))}`,
    });
  }
  if (d.lostRevenue > 0) {
    alertItems.push({
      icon: "📉",
      text: `<strong>Faturamento perdido:</strong> ${brl(d.lostRevenue)} em pedidos cancelados/devolvidos.`,
    });
  }
  if (d.unmatchedIds.length > 0) {
    alertItems.push({
      icon: "🔍",
      text: `<strong>${d.unmatchedIds.length} produto(s)</strong> sem custo cadastrado — receita de ${brl(d.ignoredRevenue)} não considerada.`,
      isCrit: true,
    });
  }

  const alertsHtml = alertItems.length
    ? `<div class="vp-alerts">
        ${alertItems.map(a =>
          `<div class="vp-alert${a.isCrit ? " vp-alert-crit" : ""}">
            <span class="vp-alert-icon">${a.icon}</span>
            <span>${a.text}</span>
          </div>`
        ).join("")}
      </div>`
    : "";

  // Meta chips
  const chips = [];
  if (d.marketplace) chips.push(`<span class="vp-chip">${esc(d.marketplace.toUpperCase())}</span>`);
  if (d.periodo)     chips.push(`<span class="vp-chip-plain">📅 ${esc(d.periodo)}</span>`);
  if (d.geradoEm)    chips.push(`<span class="vp-chip-plain">Gerado em ${esc(fmtDate(d.geradoEm))}</span>`);

  // Expenses footnote
  const expenseItems = [];
  if (d.ads > 0)        expenseItems.push(`ADS: ${brl(d.ads)}`);
  if (d.venforce > 0)   expenseItems.push(`VenForce: ${brl(d.venforce)}`);
  if (d.affiliates > 0) expenseItems.push(`Afiliados: ${brl(d.affiliates)}`);
  const expensesNote = expenseItems.length
    ? `<span>Despesas deduzidas: ${expenseItems.join(" · ")}</span>`
    : "";

  const html = `
    <!-- HEADER -->
    <div class="vp-header-card">
      <div class="vp-header-left">
        <div class="vp-chip-row">
          ${chips.join("")}
        </div>
        <div class="vp-header-title">Fechamento Financeiro</div>
        <div class="vp-header-meta">
          <span>Resultado por produto com base nas planilhas enviadas</span>
          ${expensesNote}
        </div>
      </div>
      <span class="vp-status-badge ${statusCls}">${esc(statusLabel)}</span>
    </div>

    <!-- KPIs LINHA 1: principais -->
    <div class="vp-kpi-grid">
      <div class="vp-kpi vp-kpi-featured">
        <div class="vp-kpi-label">Resultado Final</div>
        <div class="vp-kpi-value">${brl(d.finalResult)}</div>
        <div class="vp-kpi-sub">Após ADS, VenForce e Afiliados</div>
        ${kpiPill(d.finalResult, "result")}
      </div>
      <div class="vp-kpi">
        <div class="vp-kpi-label">Receita Bruta</div>
        <div class="vp-kpi-value">${brl(d.gross)}</div>
        <div class="vp-kpi-sub">Total vendido (Venda Total)</div>
        <span class="vp-kpi-pill vp-pill-neut">Neutro</span>
      </div>
      <div class="vp-kpi">
        <div class="vp-kpi-label">Receita Líquida</div>
        <div class="vp-kpi-value">${brl(d.net)}</div>
        <div class="vp-kpi-sub">Após tarifas e envio</div>
        <span class="vp-kpi-pill vp-pill-neut">Neutro</span>
      </div>
    </div>

    <!-- KPIs LINHA 2: margem / LC / ads -->
    <div class="vp-kpi-grid" style="margin-bottom:20px;">
      <div class="vp-kpi">
        <div class="vp-kpi-label">LC Total</div>
        <div class="vp-kpi-value">${brl(d.lcTotal)}</div>
        <div class="vp-kpi-sub">Lucro de contribuição</div>
        <span class="vp-kpi-pill ${d.lcTotal > 0 ? "vp-pill-pos" : "vp-pill-crit"}">${d.lcTotal > 0 ? "Positivo" : "Negativo"}</span>
      </div>
      <div class="vp-kpi">
        <div class="vp-kpi-label">MC Média</div>
        <div class="vp-kpi-value">${pct(d.mcMedia)}</div>
        <div class="vp-kpi-sub">Margem de contribuição</div>
        ${kpiPill(d.mcMedia, "mc")}
      </div>
      <div class="vp-kpi">
        <div class="vp-kpi-label">TACoS</div>
        <div class="vp-kpi-value">${pct(d.tacos)}</div>
        <div class="vp-kpi-sub">ADS como % da receita bruta</div>
        <span class="vp-kpi-pill vp-pill-neut">${d.tacos > 0 ? "Informativo" : "Sem ADS"}</span>
      </div>
    </div>

    <!-- ALERTAS -->
    ${alertsHtml}

    <!-- GRÁFICOS -->
    <div class="vp-charts-row">
      <div class="vp-chart-card">
        <div class="vp-chart-title">Top 10 Produtos por LC</div>
        <div class="vp-chart-wrap vp-chart-wrap-bar">
          <canvas id="vp-chart-bar"></canvas>
        </div>
        <div class="vp-chart-note">Ordenado por Lucro de Contribuição (maior para menor).</div>
      </div>
      <div class="vp-chart-card">
        <div class="vp-chart-title">Distribuição de Status</div>
        <div class="vp-chart-wrap vp-chart-wrap-donut">
          <canvas id="vp-chart-donut"></canvas>
        </div>
        <div class="vp-chart-note">Saudável = MC ≥ 15%. Atenção = 0–15%. Crítico = MC negativa.</div>
      </div>
    </div>

    <!-- TABELA DE PRODUTOS -->
    ${d.rows.length > 0 ? `
    <div class="vp-section-label">Detalhamento por produto</div>
    <div class="vp-table-card">
      <div class="vp-table-header">
        <span class="vp-table-title">Produtos</span>
        <input
          id="vp-search"
          class="vp-table-search no-print"
          type="search"
          placeholder="Buscar produto ou ID…"
        />
      </div>
      <div style="overflow-x:auto;">
        <table class="vp-table">
          <thead>
            <tr>
              <th style="min-width:220px;">Produto</th>
              <th class="right" style="width:120px;">Receita</th>
              <th class="right" style="width:120px;">LC</th>
              <th class="right" style="width:90px;">MC</th>
              <th style="width:90px;">Status</th>
            </tr>
          </thead>
          <tbody id="vp-table-body"></tbody>
        </table>
      </div>
      <div class="vp-table-footer" id="vp-table-footer"></div>
    </div>
    ` : ""}

  <!-- METODOLOGIA -->
  <div class="vp-section-label" style="margin-top:32px;">Como foi calculado</div>
  <div class="vp-table-card" style="padding:0;">

    <!-- Cabeçalho clicável para expandir/recolher -->
    <div id="vp-metod-toggle" style="
      padding:16px 20px;cursor:pointer;
      display:flex;align-items:center;justify-content:space-between;
      border-bottom:1px solid var(--border);
    " onclick="
      var b=document.getElementById('vp-metod-body');
      var i=document.getElementById('vp-metod-icon');
      var open=b.style.display!=='none';
      b.style.display=open?'none':'block';
      i.textContent=open?'▸':'▾';
    ">
      <span style="font-size:13px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px;">
        Metodologia e fórmulas
      </span>
      <span id="vp-metod-icon" style="color:var(--muted);font-size:12px;">▸</span>
    </div>

    <!-- Corpo (começa fechado) -->
    <div id="vp-metod-body" style="display:none;padding:20px 24px;">

      <!-- Passo 1 -->
      <div style="margin-bottom:20px;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--vp);margin-bottom:6px;">
          1 · Planilhas usadas
        </div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.7;">
          Planilha de vendas exportada do Mercado Livre/Shopee + base de custos com MLB, custo unitário e % de imposto.
          Os dados são cruzados pelo código do anúncio (MLB).
        </div>
      </div>

      <!-- Passo 2 -->
      <div style="margin-bottom:20px;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--vp);margin-bottom:6px;">
          2 · Linhas excluídas do cálculo de LC
        </div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.7;">
          Pedidos com estado contendo: <code style="background:var(--muted-bg);border-radius:4px;padding:1px 5px;font-size:12px;">cancelad</code>
          <code style="background:var(--muted-bg);border-radius:4px;padding:1px 5px;font-size:12px;">devolu</code>
          <code style="background:var(--muted-bg);border-radius:4px;padding:1px 5px;font-size:12px;">reembolso</code>
          <code style="background:var(--muted-bg);border-radius:4px;padding:1px 5px;font-size:12px;">mediacao</code>
          são excluídos do cálculo de LC/MC, mas
          <strong>contabilizados separadamente</strong> como cancelamentos e faturamento perdido.
        </div>
      </div>

      <!-- Passo 3: Receita Bruta -->
      <div style="margin-bottom:20px;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--vp);margin-bottom:6px;">
          3 · Receita Bruta
        </div>
        <div style="background:var(--bg);border-radius:8px;padding:12px 16px;font-size:13px;color:var(--text-2);line-height:1.8;">
          <strong>Receita Bruta</strong> = Σ (Preço unitário de venda × Unidades) de todos os pedidos válidos<br>
          <span style="color:var(--muted);font-size:12px;">
            Resultado neste fechamento: <strong>${brl(d.gross)}</strong>
          </span>
        </div>
      </div>

      <!-- Passo 4: Receita Líquida -->
      <div style="margin-bottom:20px;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--vp);margin-bottom:6px;">
          4 · Receita Líquida
        </div>
        <div style="background:var(--bg);border-radius:8px;padding:12px 16px;font-size:13px;color:var(--text-2);line-height:1.8;">
          <strong>Receita Líquida</strong> = Σ coluna "Total (BRL)" dos pedidos válidos<br>
          <span style="color:var(--muted);font-size:12px;">
            É o valor que o marketplace efetivamente depositou após tarifas, frete e descontos.<br>
            Resultado neste fechamento: <strong>${brl(d.net)}</strong>
          </span>
        </div>
      </div>

      <!-- Passo 5: LC -->
      <div style="margin-bottom:20px;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--vp);margin-bottom:6px;">
          5 · Lucro de Contribuição (LC) por produto
        </div>
        <div style="background:var(--bg);border-radius:8px;padding:12px 16px;font-size:13px;color:var(--text-2);line-height:1.8;">
          <code style="display:block;font-size:12px;background:var(--muted-bg);border-radius:6px;padding:10px 14px;line-height:2;white-space:pre-wrap;">
LC = Venda Total
   − (Venda Total × % Imposto)      ← tributos
   − (Venda Total − Total BRL)       ← tarifas e frete MeLi
   − (Custo unitário × Unidades)     ← custo do produto</code>
          <span style="color:var(--muted);font-size:12px;">
            LC Total neste fechamento: <strong>${brl(d.lcTotal)}</strong>
          </span>
        </div>
      </div>

      <!-- Passo 6: MC -->
      <div style="margin-bottom:20px;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--vp);margin-bottom:6px;">
          6 · Margem de Contribuição (MC)
        </div>
        <div style="background:var(--bg);border-radius:8px;padding:12px 16px;font-size:13px;color:var(--text-2);line-height:1.8;">
          <code style="display:block;font-size:12px;background:var(--muted-bg);border-radius:6px;padding:10px 14px;">
MC = LC / Venda Total × 100</code>
          <span style="color:var(--muted);font-size:12px;">
            MC Média neste fechamento: <strong>${pct(d.mcMedia)}</strong>
            — benchmark saudável é ≥ 15%.
          </span>
        </div>
      </div>

      <!-- Passo 7: Resultado Final -->
      <div style="margin-bottom:20px;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--vp);margin-bottom:6px;">
          7 · Resultado Final
        </div>
        <div style="background:var(--bg);border-radius:8px;padding:12px 16px;font-size:13px;color:var(--text-2);line-height:1.8;">
          <code style="display:block;font-size:12px;background:var(--muted-bg);border-radius:6px;padding:10px 14px;line-height:2;">
Resultado Final = LC Total
               − ADS (${brl(d.ads)})
               − VenForce (${brl(d.venforce)})
               − Afiliados (${brl(d.affiliates)})</code>
          <span style="color:var(--muted);font-size:12px;">
            Resultado neste fechamento: <strong>${brl(d.finalResult)}</strong>
          </span>
        </div>
      </div>

      <!-- Passo 8: TACoS -->
      <div style="margin-bottom:20px;">
        <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--vp);margin-bottom:6px;">
          8 · TACoS
        </div>
        <div style="background:var(--bg);border-radius:8px;padding:12px 16px;font-size:13px;color:var(--text-2);line-height:1.8;">
          <code style="display:block;font-size:12px;background:var(--muted-bg);border-radius:6px;padding:10px 14px;">
TACoS = ADS / Receita Bruta × 100</code>
          <span style="color:var(--muted);font-size:12px;">
            Mede o peso dos anúncios sobre o faturamento total.<br>
            TACoS neste fechamento: <strong>${pct(d.tacos)}</strong>
          </span>
        </div>
      </div>

      <!-- Nota sobre unmatchedIds -->
      ${d.unmatchedIds.length > 0 ? `
      <div style="background:var(--warn-bg);border:1px solid #FDE68A;border-radius:8px;padding:12px 16px;font-size:13px;color:var(--warn);line-height:1.7;">
        <strong>⚠️ ${d.unmatchedIds.length} produto(s) sem custo cadastrado</strong> foram excluídos do cálculo de LC/MC.
        A receita não considerada foi de ${brl(d.ignoredRevenue)}.
        Para incluir esses produtos, cadastre o custo na base e reprocesse o fechamento.
      </div>
      ` : `
      <div style="background:var(--ok-bg);border:1px solid #BBF7D0;border-radius:8px;padding:12px 16px;font-size:13px;color:var(--ok);">
        ✅ Todos os produtos foram cruzados com a base de custos — nenhuma receita excluída.
      </div>
      `}

    </div>
  </div>
  `;

  root.innerHTML = html;

  // Renderizar gráficos
  const chartData = buildChartData(d.rows, d.unmatchedIds);
  requestAnimationFrame(() => {
    renderCharts(chartData);
    if (d.rows.length > 0) {
      renderTable(d.rows, d.unmatchedIds);
      const searchEl = document.getElementById("vp-search");
      if (searchEl) {
        searchEl.addEventListener("input", e => {
          _tableState.q = e.target.value;
          renderTable(d.rows, d.unmatchedIds);
        });
      }
    }
  });
}

function renderError(msg) {
  const root = document.getElementById("vp-root");
  if (!root) return;
  root.innerHTML = `
    <div class="vp-error">
      <div class="vp-error-title">Não foi possível abrir o relatório</div>
      <div class="vp-error-text">${esc(msg || "Token inválido ou expirado.")}</div>
    </div>
  `;
}

// ── BOOT ──────────────────────────────────────────────────────────────────────

async function init() {
  const token = qs("token");
  if (!token) { renderError("Token não encontrado na URL."); return; }

  try {
    const res = await fetch(`${API_BASE}/public/entregas/${token}`);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      renderError(j?.erro || j?.error || `Erro ${res.status}.`);
      return;
    }
    const json = await res.json();
    const payload = json?.entrega?.payload_json || json?.payload_json || json;
    if (!payload || typeof payload !== "object") {
      renderError("Relatório inválido ou vazio.");
      return;
    }
    renderReport(payload);
  } catch (err) {
    renderError("Erro de conexão ao carregar o relatório.");
  }
}

// PDF
document.addEventListener("DOMContentLoaded", () => {
  init();
  const btnPdf = document.getElementById("btn-pdf");
  if (btnPdf) btnPdf.addEventListener("click", () => window.print());
});
