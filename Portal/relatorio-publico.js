// relatorio-publico.js — VenForce Fechamento Financeiro
// Versão completa: visual Venforce + dados automáticos + campos manuais (destaques/prioridades)

const API_BASE = "https://venforce-server.onrender.com";

// ── UTILITÁRIOS ──────────────────────────────────────────────────────────────

function qs(k) { return new URLSearchParams(location.search).get(k); }

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

function pct(v, dec = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const real = Math.abs(n) > 1 ? n / 100 : n;
  return (real * 100).toFixed(dec) + "%";
}

function num(v) { return new Intl.NumberFormat("pt-BR").format(Number(v) || 0); }

function toN(v, fb = 0) { const n = Number(v); return Number.isFinite(n) ? n : fb; }

function truncate(s, n = 42) {
  const str = String(s || "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

function fmtDate(d) {
  try { return new Date(d).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" }); }
  catch { return ""; }
}

// Encontra valor num objeto por candidatos de chave (case-insensitive, normalizado)
function pickVal(obj, candidates) {
  if (!obj || typeof obj !== "object") return undefined;
  const norm = k => String(k).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  const entries = Object.entries(obj);
  for (const c of candidates) {
    const nc = norm(c);
    const hit = entries.find(([k]) => norm(k) === nc);
    if (hit !== undefined) return hit[1];
  }
  for (const c of candidates) {
    const nc = norm(c);
    const hit = entries.find(([k]) => norm(k).includes(nc));
    if (hit !== undefined) return hit[1];
  }
}

// ── EXTRAÇÃO DO PAYLOAD ───────────────────────────────────────────────────────

function extractData(payload) {
  const snap = payload?.snapshot || {};
  const rawS  = snap?.summaryNormalized || payload?.summaryNormalized || payload?.summary || {};

  const mp = String(
    payload?.marketplace || payload?.metadados?.marketplace ||
    snap?.marketplace || rawS?.marketplace || ""
  ).toLowerCase();

  const s = rawS;
  const gross    = toN(s.grossRevenueTotal);
  const net      = toN(s.paidRevenueTotal);
  const lc       = toN(s.contributionProfitTotal);
  const mc       = toN(s.averageContributionMargin);   // 0..1 decimal
  const result   = toN(s.finalResult);
  const tacos    = toN(s.tacos);                        // 0..1 decimal
  const refunds  = toN(s.refundsTotal);
  const refCnt   = toN(s.refundsCount);
  const lostRev  = toN(s.lostRevenueTotal);
  const cancCnt  = toN(s.cancelledCount);
  const cancLost = toN(s.cancelledLostRevenue);
  const unpaidCnt= toN(s.unpaidCount);
  const unpaidLost=toN(s.unpaidLostRevenue);

  const meta     = payload?.metadados || {};
  const periodo  = String(payload?.periodo || meta?.periodo || "");
  const geradoEm = meta?.geradoEm || snap?.dataGeracao;
  const cliente  = String(payload?.cliente?.nome || payload?.entrega?.cliente || "");
  const ads      = toN(meta?.ads ?? snap?.ads);
  const venforce = toN(meta?.venforce ?? snap?.venforce);
  const affiliates=toN(meta?.affiliates ?? snap?.affiliates);
  const ignoredRev=toN(snap?.ignoredRevenue ?? payload?.ignoredRevenue);

  // Campos manuais (preenchidos no formulário de entrega)
  const entrega  = payload?.entrega || {};
  const destaques= Array.isArray(entrega?.destaques) ? entrega.destaques.filter(Boolean) : [];
  const atencoes = Array.isArray(entrega?.atencoes)  ? entrega.atencoes.filter(Boolean)  : [];
  const prio     = entrega?.prioridades || null;

  const rows = Array.isArray(snap?.detailedRows) && snap.detailedRows.length
    ? snap.detailedRows
    : (Array.isArray(payload?.detailedRows) ? payload.detailedRows : []);

  const unmatched = Array.isArray(snap?.unmatchedIds)
    ? snap.unmatchedIds
    : (Array.isArray(payload?.unmatchedIds) ? payload.unmatchedIds : []);

  const isShopee = mp.includes("shopee") || cancCnt > 0 || unpaidCnt > 0;

  return {
    mp, isShopee, gross, net, lc, mc, result, tacos,
    refunds, refCnt, lostRev, cancCnt, cancLost, unpaidCnt, unpaidLost,
    periodo, geradoEm, cliente, ads, venforce, affiliates, ignoredRev,
    rows, unmatched, destaques, atencoes, prio,
  };
}

// ── PRODUCT HELPERS ───────────────────────────────────────────────────────────

function getProductLabel(row) {
  const v = pickVal(row, ["titulo do anuncio", "título do anúncio", "titulo", "title", "nome"]);
  if (v && String(v).trim()) return String(v).trim();
  return String(pickVal(row, ["# de anuncio", "# de anúncio", "mlb", "id", "sku"]) || "—").trim();
}

function getProductId(row) {
  return String(pickVal(row, ["# de anuncio", "# de anúncio", "mlb", "id", "sku"]) || "").trim();
}

function getMcDec(row) {
  const raw = pickVal(row, ["mc", "MC", "margem"]);
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n) > 1 ? n / 100 : n;
}

function getLcVal(row) {
  return toN(pickVal(row, ["lc", "LC", "lucro", "contributionProfit"]), null);
}

function getRevVal(row) {
  return toN(pickVal(row, ["venda total", "venda_total", "receita", "grossrevenue", "total (brl)"]), null);
}

function classifyProduct(row, unmatched) {
  const id = getProductId(row);
  if (unmatched.some(u => String(u).trim() === id)) return "sem_custo";
  const mc = getMcDec(row);
  if (mc === null) return "sem_custo";
  if (mc < 0)    return "critico";
  if (mc < 0.15) return "atencao";
  return "saudavel";
}

function pillHtml(cls) {
  const map = {
    saudavel: ["rp-sp-ok", "Saudável"],
    atencao:  ["rp-sp-warn", "Atenção"],
    critico:  ["rp-sp-crit", "Crítico"],
    sem_custo:["rp-sp-muted", "Sem custo"],
  };
  const [c, l] = map[cls] || map.sem_custo;
  return `<span class="rp-status-pill ${c}">${l}</span>`;
}

// ── CHARTS ────────────────────────────────────────────────────────────────────

let _charts = {};

function destroyCharts() {
  Object.values(_charts).forEach(c => { try { c.destroy(); } catch {} });
  _charts = {};
}

function renderBarChart(id, rows) {
  const el = document.getElementById(id);
  if (!el) return;
  const top = [...rows]
    .map(r => ({ label: truncate(getProductLabel(r), 28), lc: getLcVal(r) }))
    .filter(r => r.lc !== null)
    .sort((a, b) => b.lc - a.lc)
    .slice(0, 10);

  if (!top.length) { el.parentElement.innerHTML += `<p style="text-align:center;color:var(--text-3);padding:20px 0;font-size:13px;">Sem dados de LC.</p>`; return; }

  _charts[id] = new Chart(el, {
    type: "bar",
    data: {
      labels: top.map(r => r.label),
      datasets: [{
        data: top.map(r => r.lc),
        backgroundColor: top.map(r => r.lc >= 0 ? "rgba(185,87,240,.55)" : "rgba(248,113,113,.45)"),
        borderColor:     top.map(r => r.lc >= 0 ? "#b957f0" : "#f87171"),
        borderWidth: 1, borderRadius: 4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: "y",
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` LC: ${brl(ctx.parsed.x)}` } }
      },
      scales: {
        x: { ticks: { color: "#71717a", font: { size: 11 }, callback: v => brl(v) }, grid: { color: "rgba(255,255,255,.04)" } },
        y: { ticks: { color: "#a1a1aa", font: { size: 11 } }, grid: { display: false } }
      }
    }
  });
}

function renderDonutChart(id, rows, unmatched) {
  const el = document.getElementById(id);
  if (!el) return;
  const dist = { saudavel: 0, atencao: 0, critico: 0, sem_custo: 0 };
  for (const r of rows) dist[classifyProduct(r, unmatched)]++;
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  if (!total) return;

  _charts[id] = new Chart(el, {
    type: "doughnut",
    data: {
      labels: ["Saudável", "Atenção", "Crítico", "Sem custo"],
      datasets: [{
        data: [dist.saudavel, dist.atencao, dist.critico, dist.sem_custo],
        backgroundColor: ["rgba(74,222,128,.6)", "rgba(251,191,36,.55)", "rgba(248,113,113,.55)", "rgba(113,113,122,.45)"],
        borderColor:     ["#4ade80", "#fbbf24", "#f87171", "#71717a"],
        borderWidth: 1,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "65%",
      plugins: {
        legend: { position: "bottom", labels: { color: "#a1a1aa", font: { size: 12 }, padding: 14 } },
        tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed} produto(s)` } }
      }
    }
  });
}

// ── TABLE ─────────────────────────────────────────────────────────────────────

let _tableRows = [], _tableUnmatched = [], _tableQ = "";

function renderTable() {
  const tbody = document.getElementById("rp-tbody");
  const foot  = document.getElementById("rp-tfoot");
  if (!tbody) return;

  const q = _tableQ.toLowerCase();
  const filtered = q
    ? _tableRows.filter(r => `${getProductLabel(r)} ${getProductId(r)}`.toLowerCase().includes(q))
    : _tableRows;

  const sorted = [...filtered].sort((a, b) => {
    const la = getLcVal(a), lb = getLcVal(b);
    if (la === null && lb === null) return 0;
    if (la === null) return 1;
    if (lb === null) return -1;
    return lb - la;
  }).slice(0, 60);

  tbody.innerHTML = sorted.map(row => {
    const lbl = getProductLabel(row);
    const id  = getProductId(row);
    const lc  = getLcVal(row);
    const mc  = getMcDec(row);
    const rev = getRevVal(row);
    const cls = classifyProduct(row, _tableUnmatched);
    return `<tr>
      <td>
        <div class="rp-table-name">${esc(truncate(lbl, 52))}</div>
        ${id && id !== lbl ? `<div class="rp-table-id">${esc(id)}</div>` : ""}
      </td>
      <td class="r">${rev !== null ? brl(rev) : "—"}</td>
      <td class="r">${lc  !== null ? brl(lc)  : "—"}</td>
      <td class="r">${mc  !== null ? pct(mc)   : "—"}</td>
      <td>${pillHtml(cls)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-3);">Nenhum produto encontrado.</td></tr>`;

  if (foot) foot.textContent = `${sorted.length} de ${filtered.length} produto(s)${q ? " (filtrado)" : ""}.`;
}

// ── SEÇÃO METODOLOGIA ─────────────────────────────────────────────────────────

function buildMetodologia(d) {
  const expItems = [];
  if (d.ads > 0)        expItems.push(`ADS: ${brl(d.ads)}`);
  if (d.venforce > 0)   expItems.push(`VenForce: ${brl(d.venforce)}`);
  if (d.affiliates > 0) expItems.push(`Afiliados: ${brl(d.affiliates)}`);
  const expStr = expItems.join(" + ");

  return `
  <div class="rp-metod rp-section">
    <button class="rp-metod-toggle" aria-expanded="false" onclick="
      const b=this.nextElementSibling;
      const open=b.classList.toggle('open');
      this.setAttribute('aria-expanded',open);
    ">
      <span>Como foi calculado</span>
      <span class="rp-metod-icon">▼</span>
    </button>
    <div class="rp-metod-body">

      <div class="rp-metod-step">
        <div class="rp-metod-step-label">1 · Planilhas usadas</div>
        <div class="rp-metod-step-text">
          Planilha de vendas exportada do ${esc(d.mp.toUpperCase())} + base de custos com código do anúncio (MLB/SKU), custo unitário e % de imposto.
          O cruzamento é feito pelo código do anúncio.
        </div>
      </div>

      <div class="rp-metod-step">
        <div class="rp-metod-step-label">2 · Linhas excluídas do LC/MC</div>
        <div class="rp-metod-step-text">
          Pedidos com estado contendo
          <code>cancelad</code>, <code>devolu</code>, <code>reembolso</code>, <code>mediacao</code>
          são excluídos do cálculo de LC/MC, mas contabilizados em cancelamentos e faturamento perdido.
        </div>
      </div>

      <div class="rp-metod-step">
        <div class="rp-metod-step-label">3 · Receita Bruta</div>
        <div class="rp-metod-step-text">
          Σ (Preço unitário × Unidades) de todos os pedidos válidos.
          <strong>Neste fechamento: ${brl(d.gross)}</strong>
        </div>
      </div>

      <div class="rp-metod-step">
        <div class="rp-metod-step-label">4 · Receita Líquida</div>
        <div class="rp-metod-step-text">
          Σ coluna "Total (BRL)" dos pedidos válidos — o que o marketplace depositou após tarifas, frete e descontos.
          <strong>Neste fechamento: ${brl(d.net)}</strong>
        </div>
      </div>

      <div class="rp-metod-step">
        <div class="rp-metod-step-label">5 · Fórmula LC por produto</div>
        <div class="rp-metod-step-text">
          <div class="rp-formula">LC = Venda Total
   − (Venda Total × % Imposto)      ← tributos sobre a venda
   − (Venda Total − Total BRL)       ← tarifas + frete marketplace
   − (Custo unitário × Unidades)     ← custo do produto

MC = LC / Venda Total × 100</div>
          <strong>LC Total neste fechamento: ${brl(d.lc)}</strong> · MC Média: <strong>${pct(d.mc)}</strong>
        </div>
      </div>

      <div class="rp-metod-step">
        <div class="rp-metod-step-label">6 · Resultado Final</div>
        <div class="rp-metod-step-text">
          <div class="rp-formula">Resultado = LC Total ${expStr ? `\n   − ${expItems.join("\n   − ")}` : ""}</div>
          <strong>Resultado neste fechamento: ${brl(d.result)}</strong>
        </div>
      </div>

      <div class="rp-metod-step">
        <div class="rp-metod-step-label">7 · TACoS</div>
        <div class="rp-metod-step-text">
          <div class="rp-formula">TACoS = ADS / Receita Bruta × 100</div>
          Mede o peso dos anúncios sobre o faturamento total.
          <strong>TACoS neste fechamento: ${pct(d.tacos)}</strong>
        </div>
      </div>

      ${d.unmatched.length > 0
        ? `<div style="background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:8px;padding:12px 16px;font-size:13px;color:var(--warn);">
            ⚠ <strong>${d.unmatched.length} produto(s) sem custo cadastrado</strong> foram excluídos.
            Receita não considerada: ${brl(d.ignoredRev)}.
          </div>`
        : `<div style="background:var(--ok-bg);border:1px solid var(--ok-border);border-radius:8px;padding:12px 16px;font-size:13px;color:var(--ok);">
            ✓ Todos os produtos foram cruzados com a base de custos.
          </div>`
      }
    </div>
  </div>`;
}

// ── RENDER PRINCIPAL ──────────────────────────────────────────────────────────

function renderReport(payload) {
  destroyCharts();
  const d = extractData(payload);
  const root = document.getElementById("rp-root");
  if (!root) return;

  // Status geral
  let statusCls, statusLabel;
  if (d.result < 0 || d.mc < 0) { statusCls = "rp-status-crit"; statusLabel = "Resultado Crítico"; }
  else if (d.mc < 0.15 || d.unmatched.length > 0 || d.refCnt > 0)
    { statusCls = "rp-status-warn"; statusLabel = "Atenção Necessária"; }
  else { statusCls = "rp-status-pos"; statusLabel = "Resultado Positivo"; }

  // Alertas dinâmicos
  const alertItems = [];
  const cancelVal = d.isShopee ? (d.cancLost + d.unpaidLost) : Math.abs(d.refunds);
  const cancelCnt = d.isShopee ? (d.cancCnt + d.unpaidCnt) : d.refCnt;
  if (cancelCnt > 0)
    alertItems.push({ cls: "rp-alert-warn", icon: "⚠", text: d.isShopee
      ? `<strong>${num(d.cancCnt)} cancelado(s)</strong> (${brl(d.cancLost)}) + <strong>${num(d.unpaidCnt)} não pago(s)</strong> (${brl(d.unpaidLost)})`
      : `<strong>${num(cancelCnt)} cancelamento(s)/reembolso(s)</strong> com impacto de ${brl(Math.abs(d.refunds))}` });
  if (d.lostRev > 0)
    alertItems.push({ cls: "rp-alert-warn", icon: "📉", text: `<strong>Faturamento perdido:</strong> ${brl(d.lostRev)} em pedidos cancelados.` });
  if (d.unmatched.length > 0)
    alertItems.push({ cls: "rp-alert-crit", icon: "🔍", text: `<strong>${d.unmatched.length} produto(s)</strong> sem custo na base — ${brl(d.ignoredRev)} de receita não considerada.` });

  // Chips de meta
  const chips = [
    `<span class="rp-chip rp-chip-vp">${esc(d.mp.toUpperCase())}</span>`,
    d.periodo  ? `<span class="rp-chip rp-chip-plain">📅 ${esc(d.periodo)}</span>` : "",
    d.cliente  ? `<span class="rp-chip rp-chip-plain">👤 ${esc(d.cliente)}</span>` : "",
    d.geradoEm ? `<span class="rp-chip rp-chip-plain">Gerado em ${esc(fmtDate(d.geradoEm))}</span>` : "",
  ].filter(Boolean).join("");

  // KPI pill helper
  const kpiPill = (mcVal) => {
    if (mcVal >= 0.15) return `<span class="rp-kpi-pill rp-pill-ok">Saudável ≥15%</span>`;
    if (mcVal < 0)     return `<span class="rp-kpi-pill rp-pill-crit">Crítico</span>`;
    return `<span class="rp-kpi-pill rp-pill-warn">Atenção &lt;15%</span>`;
  };

  // Despesas detalhadas
  const expItems = [];
  if (d.ads > 0)        expItems.push(`ADS ${brl(d.ads)}`);
  if (d.venforce > 0)   expItems.push(`VenForce ${brl(d.venforce)}`);
  if (d.affiliates > 0) expItems.push(`Afiliados ${brl(d.affiliates)}`);

  // ── HTML ──────────────────────────────────────────────────────────────────

  root.innerHTML = `<div class="rp-page">

    <!-- HERO -->
    <div class="rp-hero rp-section">
      <div class="rp-hero-chips">${chips}</div>
      <div class="rp-hero-title">Fechamento Financeiro</div>
      <div class="rp-hero-meta">
        <span>Resultado por produto com base nas planilhas de ${esc(d.mp.toUpperCase())}</span>
        ${expItems.length ? `<span>Despesas: ${expItems.join(" · ")}</span>` : ""}
      </div>
      <span class="rp-hero-status ${statusCls}">${esc(statusLabel)}</span>
    </div>

    <!-- ALERTAS -->
    ${alertItems.length ? `<div class="rp-alerts rp-section">
      ${alertItems.map(a => `<div class="rp-alert ${a.cls}">
        <span class="rp-alert-icon">${a.icon}</span><span>${a.text}</span>
      </div>`).join("")}
    </div>` : ""}

    <!-- RESUMO EXECUTIVO -->
    <div class="rp-section">
      <div class="rp-section-head">
        <span class="rp-section-badge">Resumo Executivo</span>
      </div>
      <div class="rp-section-title">Visão geral do período</div>
      ${d.periodo ? `<div class="rp-section-sub">${esc(d.periodo)}</div>` : ""}

      <div style="margin-top:18px;">
        <div class="rp-kpi-grid">
          <div class="rp-kpi rp-kpi-featured">
            <div class="rp-kpi-label">Resultado Final</div>
            <div class="rp-kpi-value">${brl(d.result)}</div>
            <div class="rp-kpi-sub">Após ADS, VenForce e Afiliados</div>
            <span class="rp-kpi-pill ${d.result > 0 ? "rp-pill-ok" : d.result < 0 ? "rp-pill-crit" : "rp-pill-muted"}">${d.result > 0 ? "Positivo" : d.result < 0 ? "Negativo" : "Neutro"}</span>
          </div>
          <div class="rp-kpi rp-kpi-vp">
            <div class="rp-kpi-label">Receita Total</div>
            <div class="rp-kpi-value">${brl(d.gross)}</div>
            <div class="rp-kpi-sub">Total vendido no período</div>
          </div>
          <div class="rp-kpi rp-kpi-ok">
            <div class="rp-kpi-label">LC Total</div>
            <div class="rp-kpi-value">${brl(d.lc)}</div>
            <div class="rp-kpi-sub">Lucro de contribuição</div>
            <span class="rp-kpi-pill ${d.lc > 0 ? "rp-pill-ok" : "rp-pill-crit"}">${d.lc > 0 ? "Positivo" : "Negativo"}</span>
          </div>
          <div class="rp-kpi rp-kpi-blue">
            <div class="rp-kpi-label">MC Média</div>
            <div class="rp-kpi-value">${pct(d.mc)}</div>
            <div class="rp-kpi-sub">Margem de contribuição</div>
            ${kpiPill(d.mc)}
          </div>
          <div class="rp-kpi rp-kpi-muted">
            <div class="rp-kpi-label">Investimento ADS</div>
            <div class="rp-kpi-value">${brl(d.ads)}</div>
            <div class="rp-kpi-sub">Total investido no período</div>
          </div>
          <div class="rp-kpi rp-kpi-muted">
            <div class="rp-kpi-label">TACoS</div>
            <div class="rp-kpi-value">${pct(d.tacos)}</div>
            <div class="rp-kpi-sub">ADS como % da receita bruta</div>
            <span class="rp-kpi-pill rp-pill-muted">${d.tacos > 0 ? "Informativo" : "Sem ADS"}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- DESTAQUES DO MÊS (manual) -->
    ${(d.destaques.length > 0 || d.atencoes.length > 0) ? `
    <div class="rp-section">
      <div class="rp-section-head"><span class="rp-section-badge">Destaques</span></div>
      <div class="rp-section-title">Destaques do Mês</div>
      <div style="margin-top:16px;">
        <div class="rp-destaques-grid">
          ${d.destaques.map(t => `
            <div class="rp-destaque rp-destaque-ok">
              <span class="rp-destaque-icon">✅</span>
              <span>${esc(t)}</span>
            </div>`).join("")}
          ${d.atencoes.map(t => `
            <div class="rp-destaque rp-destaque-warn">
              <span class="rp-destaque-icon">⚠️</span>
              <span>${esc(t)}</span>
            </div>`).join("")}
        </div>
      </div>
    </div>` : ""}

    <!-- RECEITA & FATURAMENTO -->
    <div class="rp-section">
      <div class="rp-section-head"><span class="rp-section-badge">Receita / Faturamento</span></div>
      <div class="rp-section-title">Receita &amp; Faturamento</div>
      <div class="rp-section-sub">Resultado financeiro consolidado do período</div>

      <div style="margin-top:18px;">
        <div class="rp-charts-row">
          <div class="rp-card">
            <div class="rp-card-title">Top 10 Produtos por LC</div>
            <div class="rp-chart-wrap rp-chart-h240">
              <canvas id="rp-chart-bar"></canvas>
            </div>
            <p class="rp-chart-note">Ordenado por Lucro de Contribuição decrescente.</p>
          </div>
          <div class="rp-card">
            <div class="rp-card-title">Distribuição de Status</div>
            <div class="rp-chart-wrap rp-chart-h240">
              <canvas id="rp-chart-donut"></canvas>
            </div>
            <p class="rp-chart-note">Saudável = MC ≥ 15%. Atenção = 0–15%. Crítico = MC negativa.</p>
          </div>
        </div>

        <div class="rp-kpi-grid" style="grid-template-columns:repeat(3,1fr);">
          <div class="rp-kpi rp-kpi-vp">
            <div class="rp-kpi-label">Faturamento do Mês</div>
            <div class="rp-kpi-value">${brl(d.gross)}</div>
            <div class="rp-kpi-sub">Receita Bruta (Venda Total)</div>
          </div>
          <div class="rp-kpi rp-kpi-ok">
            <div class="rp-kpi-label">Lucro do Mês</div>
            <div class="rp-kpi-value">${brl(d.lc)}</div>
            <div class="rp-kpi-sub">LC Total · MC: ${pct(d.mc)}</div>
          </div>
          <div class="rp-kpi rp-kpi-blue">
            <div class="rp-kpi-label">Receita Líquida</div>
            <div class="rp-kpi-value">${brl(d.net)}</div>
            <div class="rp-kpi-sub">Após tarifas e envio</div>
          </div>
        </div>
      </div>
    </div>

    <!-- MÉTRICAS DE ADS -->
    ${(d.ads > 0 || d.affiliates > 0) ? `
    <div class="rp-section">
      <div class="rp-section-head"><span class="rp-section-badge">ADS</span></div>
      <div class="rp-section-title">Métricas de ADS</div>
      <div class="rp-section-sub">Investimento, retorno e afiliados · ${esc(d.periodo || "período")}</div>

      <div style="margin-top:18px;">
        <div class="rp-kpi-grid" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr));margin-bottom:12px;">
          <div class="rp-kpi rp-kpi-vp">
            <div class="rp-kpi-label">Investimento ADS</div>
            <div class="rp-kpi-value">${brl(d.ads)}</div>
            <div class="rp-kpi-sub">Total no período</div>
          </div>
          <div class="rp-kpi rp-kpi-warn">
            <div class="rp-kpi-label">TACoS</div>
            <div class="rp-kpi-value">${pct(d.tacos)}</div>
            <div class="rp-kpi-sub">Custo s/ receita total</div>
          </div>
          <div class="rp-kpi rp-kpi-muted">
            <div class="rp-kpi-label">Receita via Afiliados</div>
            <div class="rp-kpi-value">${brl(d.affiliates)}</div>
            <div class="rp-kpi-sub">Comissão paga</div>
          </div>
          <div class="rp-kpi rp-kpi-ok">
            <div class="rp-kpi-label">ROAS ADS</div>
            <div class="rp-kpi-value">${d.ads > 0 ? (d.gross / d.ads).toFixed(1) + "x" : "—"}</div>
            <div class="rp-kpi-sub">Retorno sobre verba</div>
          </div>
        </div>

        <div class="rp-card">
          <div class="rp-card-title">Afiliados &amp; Canais</div>
          <table class="rp-canais-table">
            <tr>
              <td><span class="rp-canais-label"><span class="rp-canais-dot" style="background:var(--vp)"></span> Investimento ADS</span></td>
              <td>${brl(d.ads)}</td>
            </tr>
            <tr>
              <td><span class="rp-canais-label"><span class="rp-canais-dot" style="background:var(--warn)"></span> TACoS</span></td>
              <td>${pct(d.tacos)}</td>
            </tr>
            <tr>
              <td><span class="rp-canais-label"><span class="rp-canais-dot" style="background:var(--ok)"></span> Comissão paga (Afiliados)</span></td>
              <td>${brl(d.affiliates)}</td>
            </tr>
            <tr>
              <td><span class="rp-canais-label"><span class="rp-canais-dot" style="background:var(--blue)"></span> ROAS ADS</span></td>
              <td>${d.ads > 0 ? (d.gross / d.ads).toFixed(1) + "x" : "—"}</td>
            </tr>
            <tr>
              <td><span class="rp-canais-label"><span class="rp-canais-dot" style="background:var(--text-3)"></span> VenForce</span></td>
              <td>${brl(d.venforce)}</td>
            </tr>
          </table>
        </div>
      </div>
    </div>` : ""}

    <!-- PLANO DE PRIORIDADES (manual) -->
    ${d.prio && (
      (d.prio.alta  || []).some(i => i.titulo) ||
      (d.prio.media || []).some(i => i.titulo) ||
      (d.prio.baixa || []).some(i => i.titulo)
    ) ? `
    <div class="rp-section">
      <div class="rp-section-head"><span class="rp-section-badge">Próximo Mês</span></div>
      <div class="rp-section-title">Plano de Prioridades</div>
      <div class="rp-section-sub">O que será feito no próximo período</div>
      <div style="margin-top:18px;">
        <div class="rp-prio-grid">
          ${[
            { key: "alta",  label: "Alta Prioridade",  dot: "#f87171", border: "rgba(248,113,113,0.3)" },
            { key: "media", label: "Média Prioridade", dot: "#fbbf24", border: "rgba(251,191,36,0.3)"  },
            { key: "baixa", label: "Baixa Prioridade", dot: "#60a5fa", border: "rgba(96,165,250,0.3)"  },
          ].map(col => {
            const items = (d.prio[col.key] || []).filter(i => i.titulo);
            return `<div class="rp-prio-col" style="border-color:${col.border}">
              <div class="rp-prio-col-head">
                <span class="rp-prio-dot" style="background:${col.dot}"></span>
                ${esc(col.label)}
              </div>
              <div class="rp-prio-items">
                ${items.length ? items.map(item => `
                  <div class="rp-prio-item">
                    <div class="rp-prio-item-title">${esc(item.titulo)}</div>
                    ${item.desc ? `<div class="rp-prio-item-desc">${esc(item.desc)}</div>` : ""}
                    ${item.data ? `<div class="rp-prio-item-date">📅 ${esc(item.data)}</div>` : ""}
                  </div>`).join("")
                : `<div style="font-size:12px;color:var(--text-3);padding:8px 0;">—</div>`}
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>
    </div>` : ""}

    <!-- DETALHAMENTO POR PRODUTO -->
    ${d.rows.length ? `
    <div class="rp-section">
      <div class="rp-section-head"><span class="rp-section-badge">Produtos</span></div>
      <div class="rp-section-title">Detalhamento por Produto</div>
      <div class="rp-section-sub">${num(d.rows.length)} produto(s) · ordenado por LC decrescente</div>
      <div style="margin-top:16px;">
        <div class="rp-table-card">
          <div class="rp-table-head">
            <span class="rp-table-title">Produtos</span>
            <input id="rp-search" class="rp-search no-print" type="search" placeholder="Buscar produto ou ID…" />
          </div>
          <div style="overflow-x:auto;">
            <table class="rp-table">
              <thead><tr>
                <th style="min-width:220px;">Produto</th>
                <th class="r" style="width:120px;">Receita</th>
                <th class="r" style="width:120px;">LC</th>
                <th class="r" style="width:90px;">MC</th>
                <th style="width:100px;">Status</th>
              </tr></thead>
              <tbody id="rp-tbody"></tbody>
            </table>
          </div>
          <div class="rp-table-foot" id="rp-tfoot"></div>
        </div>
      </div>
    </div>` : ""}

    <!-- METODOLOGIA -->
    ${buildMetodologia(d)}

  </div>`;

  // Inicializar gráficos e tabela
  _tableRows = d.rows;
  _tableUnmatched = d.unmatched;

  requestAnimationFrame(() => {
    renderBarChart("rp-chart-bar", d.rows);
    renderDonutChart("rp-chart-donut", d.rows, d.unmatched);
    renderTable();

    const searchEl = document.getElementById("rp-search");
    if (searchEl) searchEl.addEventListener("input", e => { _tableQ = e.target.value; renderTable(); });
  });
}

// ── RENDER ERROR ──────────────────────────────────────────────────────────────

function renderError(msg) {
  const root = document.getElementById("rp-root");
  if (!root) return;
  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:70vh;">
      <div class="rp-error">
        <div class="rp-error-icon">⚠️</div>
        <div class="rp-error-title">Não foi possível abrir o relatório</div>
        <div class="rp-error-msg">${esc(msg || "Token inválido ou expirado.")}</div>
      </div>
    </div>`;
}

// ── BOOT ──────────────────────────────────────────────────────────────────────

async function init() {
  const token = qs("token");
  if (!token) { renderError("Token não encontrado na URL."); return; }

  try {
    const res = await fetch(`${API_BASE}/public/entregas/${encodeURIComponent(token)}`);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      renderError(j?.erro || j?.error || `Erro ${res.status}.`);
      return;
    }
    const json = await res.json();
    const payload = json?.entrega?.payload_json || json?.payload_json || json;
    if (!payload || typeof payload !== "object") { renderError("Relatório inválido ou vazio."); return; }
    renderReport(payload);
  } catch (err) {
    renderError("Erro de conexão ao carregar o relatório.");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  init();
  document.getElementById("btn-pdf")?.addEventListener("click", () => window.print());
});
