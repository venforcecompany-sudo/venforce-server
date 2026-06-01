// Portal/metricas.js — Métricas de Mercado Livre

const API_BASE    = "https://venforce-server.onrender.com";
const STORAGE_KEY = "vf-token";

function getToken() {
  const t = localStorage.getItem(STORAGE_KEY);
  if (!t) { window.location.replace("index.html"); return null; }
  return t;
}
getToken();
initLayout();

// ─── Helpers de formatação ────────────────────────────────────────────────────

function fmtBRL(n) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0);
}
function fmtInt(n) {
  return (Number(n) || 0).toLocaleString("pt-BR");
}
function fmtDataCurta(iso) {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  return `${d}/${m}`;
}
function fmtDataLonga(iso) {
  if (!iso) return "";
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}
function esc(s) {
  const el = document.createElement("div");
  el.textContent = String(s ?? "");
  return el.innerHTML;
}
function trunc(s, max) {
  s = String(s || "");
  max = max || 55;
  return s.length > max ? s.slice(0, max) + "…" : s;
}
// Formato compacto para eixo Y nos gráficos
function fmtBRLChart(n) {
  const v = Number(n) || 0;
  if (v >= 1000000) return "R$" + (v / 1000000).toFixed(1).replace(".", ",") + "M";
  if (v >= 1000)    return "R$" + (v / 1000).toFixed(0) + "k";
  return "R$" + v.toFixed(0);
}
function fmtIntChart(n) {
  const v = Number(n) || 0;
  if (v >= 1000) return (v / 1000).toFixed(1).replace(".", ",") + "k";
  return String(v);
}

// ─── Cálculo de período ───────────────────────────────────────────────────────

function calcularPeriodo(preset) {
  const hoje = new Date();
  const fmt  = d => d.toISOString().slice(0, 10);
  const sub  = (d, n) => { const r = new Date(d); r.setDate(r.getDate() - n); return r; };

  switch (preset) {
    case "today":        return { from: fmt(hoje),           to: fmt(hoje) };
    case "yesterday":    return { from: fmt(sub(hoje, 1)),    to: fmt(sub(hoje, 1)) };
    case "last_7_days":  return { from: fmt(sub(hoje, 6)),    to: fmt(hoje) };
    case "last_30_days": return { from: fmt(sub(hoje, 29)),   to: fmt(hoje) };
    case "this_month":   return { from: fmt(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), to: fmt(hoje) };
    case "last_month": {
      const from = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
      const to   = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
      return { from: fmt(from), to: fmt(to) };
    }
    default: return null;
  }
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function apiFetch(path) {
  const token = getToken();
  if (!token) return null;
  const res = await fetch(API_BASE + path, {
    headers: { Authorization: "Bearer " + token }
  });
  return res.json();
}

// ─── Estado visual ────────────────────────────────────────────────────────────

function ocultarResultados() {
  ["metricas-cards-grid", "metricas-graficos", "metricas-card-pordia", "metricas-card-top"]
    .forEach(id => { document.getElementById(id).style.display = "none"; });
}

function mostrarResultados() {
  ["metricas-cards-grid", "metricas-graficos", "metricas-card-pordia", "metricas-card-top"]
    .forEach(id => { document.getElementById(id).style.display = ""; });
}

function ocultarEstado() {
  document.getElementById("metricas-estado").style.display = "none";
}

function mostrarEstado(tipo, msg) {
  const el = document.getElementById("metricas-estado");
  ocultarResultados();
  el.style.display = "";

  const ICONES = {
    idle:    `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--vf-text-l)"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
    loading: `<div class="metricas-estado-spinner"></div>`,
    empty:   `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color:var(--vf-text-l)"><circle cx="12" cy="12" r="10"/><path d="M8 15h8"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>`,
    error:   `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };
  const MSGS = {
    idle:    "Selecione um cliente e período para visualizar as métricas.",
    loading: "Carregando métricas…",
    empty:   "Nenhum dado encontrado no período selecionado.",
  };

  const txt = tipo === "error" ? esc(msg || "Não foi possível carregar as métricas.") : (MSGS[tipo] || "");
  el.innerHTML = `<div class="metricas-estado${tipo === "error" ? " metricas-estado--error" : ""}">
    ${ICONES[tipo] || ""}
    <p>${txt}</p>
  </div>`;
}

// ─── Clientes ─────────────────────────────────────────────────────────────────

async function carregarClientes() {
  const sel = document.getElementById("metricas-sel-cliente");
  try {
    const data = await apiFetch("/metricas/clientes");
    if (!data || !data.ok || !data.clientes.length) {
      sel.innerHTML = `<option value="">Nenhum cliente com ML conectado</option>`;
      return;
    }
    sel.innerHTML = `<option value="">Selecione o cliente</option>` +
      data.clientes.map(c => `<option value="${esc(c.slug)}">${esc(c.nome)}</option>`).join("");
  } catch {
    sel.innerHTML = `<option value="">Erro ao carregar clientes</option>`;
  }
}

// ─── Cards ───────────────────────────────────────────────────────────────────

const CARDS = [
  { id: "vendasBrutas",                 label: "Vendas brutas",         fmt: fmtBRL, cls: "--purple",  comp: "vendasBrutasPct",     inv: false },
  { id: "quantidadeVendas",             label: "Pedidos",               fmt: fmtInt, cls: "--success", comp: "quantidadeVendasPct", inv: false },
  { id: "unidadesVendidas",             label: "Unidades vendidas",     fmt: fmtInt, cls: "--success", comp: "unidadesVendidasPct", inv: false },
  { id: "precoMedioUnidade",            label: "Preço médio / unidade", fmt: fmtBRL, cls: "--neutral", comp: null,                  inv: false },
  { id: "ticketMedio",                  label: "Ticket médio",          fmt: fmtBRL, cls: "--purple",  comp: "ticketMedioPct",      inv: false },
  { id: "comissaoEstimada",             label: "Comissão estimada",     fmt: fmtBRL, cls: "--warning", comp: null,                  inv: false },
  { id: "descontoEstimado",             label: "Desconto estimado",     fmt: fmtBRL, cls: "--neutral", comp: null,                  inv: false },
  { id: "quantidadeCanceladasAjustada", label: "Vendas canceladas",     fmt: fmtInt, cls: "--danger",  comp: "valorCanceladoPct",   inv: true,
    hint: "Ajustado: buyer_cancel_express + mediations" },
  { id: "valorCanceladoAjustado",       label: "Valor cancelado",       fmt: fmtBRL, cls: "--danger",  comp: "valorCanceladoPct",   inv: true },
];

const ICONE_CARD = {
  "--purple":  `<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H6"/>`,
  "--success": `<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>`,
  "--warning": `<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>`,
  "--danger":  `<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>`,
  "--neutral": `<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>`,
};

function svgCard(cls) {
  const d = ICONE_CARD[cls] || ICONE_CARD["--neutral"];
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

function renderPct(val, invert) {
  if (val === null || val === undefined) return "";
  const v = Number(val);
  const isPositive = invert ? v < 0 : v >= 0;
  const sinal = v >= 0 ? "+" : "";
  const arrow = v >= 0 ? "▲" : "▼";
  const cls   = isPositive ? "metricas-pct--pos" : "metricas-pct--neg";
  return `<span class="metricas-pct ${cls}">${arrow} ${sinal}${v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</span>`;
}

function renderCards(resumo, comparativo) {
  document.getElementById("metricas-cards-grid").innerHTML = CARDS.map(cfg => {
    const valor = resumo[cfg.id];
    const comp  = comparativo && cfg.comp ? comparativo[cfg.comp] : null;
    return `<div class="ads-summary-card ads-summary-card${cfg.cls}">
      <div class="ads-summary-icon">${svgCard(cfg.cls)}</div>
      <div class="ads-summary-body">
        <div class="ads-summary-value">${cfg.fmt(valor)}</div>
        <div class="ads-summary-label">
          ${esc(cfg.label)}
          ${cfg.hint ? `<span class="metricas-hint">${esc(cfg.hint)}</span>` : ""}
        </div>
        ${renderPct(comp, cfg.inv)}
      </div>
    </div>`;
  }).join("");
}

// ─── Gráfico de linha (SVG puro) ──────────────────────────────────────────────

function criarLinhaChart(dados, campo, cor, fmtYFn) {
  if (!dados.length) return `<p class="metricas-chart-empty">Sem dados para exibir.</p>`;

  const W = 480, H = 160;
  const P = { t: 14, r: 12, b: 34, l: 58 };
  const iW = W - P.l - P.r;
  const iH = H - P.t - P.b;

  const vals = dados.map(d => Number(d[campo]) || 0);
  const maxV = Math.max(...vals, 1);

  const X = i => P.l + (dados.length > 1 ? (i / (dados.length - 1)) : 0.5) * iW;
  const Y = v => P.t + iH - (v / maxV) * iH;

  const pts    = dados.map((d, i) => ({ x: X(i), y: Y(vals[i]), d }));
  const poly   = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const area   = [
    `M ${pts[0].x.toFixed(1)} ${(P.t + iH).toFixed(1)}`,
    ...pts.map(p => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`),
    `L ${pts[pts.length - 1].x.toFixed(1)} ${(P.t + iH).toFixed(1)} Z`
  ].join(" ");

  const yTicks  = [0, maxV / 2, maxV];
  const step    = Math.max(1, Math.ceil(dados.length / 7));
  const xLabels = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  const showDots = dados.length <= 20;
  const gid     = `mg-${campo}-${Math.random().toString(36).slice(2, 7)}`;

  return `<svg viewBox="0 0 ${W} ${H}" class="metricas-chart-svg">
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${cor}" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="${cor}" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    ${yTicks.map(v => {
      const y = Y(v).toFixed(1);
      return `<line x1="${P.l}" y1="${y}" x2="${W - P.r}" y2="${y}" stroke="#e5e7eb" stroke-width="0.7"/>
              <text x="${(P.l - 5).toFixed(1)}" y="${(Number(y) + 4).toFixed(1)}" text-anchor="end" class="metricas-chart-label">${fmtYFn(v)}</text>`;
    }).join("")}
    <path d="${area}" fill="url(#${gid})"/>
    ${dados.length > 1 ? `<polyline points="${poly}" fill="none" stroke="${cor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : ""}
    ${showDots ? pts.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="${cor}"/>`).join("") : ""}
    ${xLabels.map(p => `<text x="${p.x.toFixed(1)}" y="${H - 4}" text-anchor="middle" class="metricas-chart-label">${fmtDataCurta(p.d.data)}</text>`).join("")}
  </svg>`;
}

// ─── Gráfico de barras (SVG puro) ─────────────────────────────────────────────

function criarBarrasChart(dados, campo, cor) {
  if (!dados.length) return `<p class="metricas-chart-empty">Sem dados para exibir.</p>`;

  const W = 480, H = 130;
  const P = { t: 8, r: 12, b: 32, l: 36 };
  const iW = W - P.l - P.r;
  const iH = H - P.t - P.b;

  const vals = dados.map(d => Number(d[campo]) || 0);
  const maxV = Math.max(...vals, 1);
  const bW   = iW / dados.length;
  const gap  = Math.max(1, bW * 0.2);
  const step = Math.max(1, Math.ceil(dados.length / 7));

  const bars = dados.map((d, i) => {
    const x  = P.l + i * bW + gap / 2;
    const bw = bW - gap;
    const bh = Math.max(vals[i] > 0 ? 1 : 0, (vals[i] / maxV) * iH);
    const y  = P.t + iH - bh;
    const showLabel = i % step === 0 || i === dados.length - 1;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${cor}" opacity="0.8"/>
      ${showLabel ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle" class="metricas-chart-label">${fmtDataCurta(d.data)}</text>` : ""}`;
  }).join("");

  return `<svg viewBox="0 0 ${W} ${H}" class="metricas-chart-svg">
    <line x1="${P.l}" y1="${P.t + iH}" x2="${W - P.r}" y2="${P.t + iH}" stroke="#e5e7eb" stroke-width="0.7"/>
    <text x="${(P.l - 4).toFixed(1)}" y="${(P.t + 4).toFixed(1)}" text-anchor="end" class="metricas-chart-label">${fmtIntChart(maxV)}</text>
    ${bars}
  </svg>`;
}

// ─── Top produtos: barras horizontais ────────────────────────────────────────

function renderTopProdutosBar(topProdutos) {
  const wrap  = document.getElementById("metricas-top-bar-wrap");
  const badge = document.getElementById("metricas-top-total");
  const items = topProdutos.slice(0, 10);

  if (!items.length) {
    wrap.innerHTML = `<p style="color:var(--vf-text-l);font-size:.875rem;margin:0;">Sem produtos para exibir.</p>`;
    return;
  }

  const maxV = Math.max(...items.map(p => p.faturamento), 1);
  wrap.innerHTML = items.map(p => {
    const pct = ((p.faturamento / maxV) * 100).toFixed(1);
    return `<div class="metricas-top-row">
      <span class="metricas-top-label" title="${esc(p.titulo)}">${esc(trunc(p.titulo, 40))}</span>
      <div class="metricas-top-bar-wrap"><div class="metricas-top-bar" style="width:${pct}%"></div></div>
      <span class="metricas-top-value">${fmtBRL(p.faturamento)}</span>
    </div>`;
  }).join("");

  if (badge) { badge.textContent = topProdutos.length; badge.style.display = ""; }
}

// ─── Tabelas ─────────────────────────────────────────────────────────────────

function renderTabelaPorDia(porDia) {
  const tbody = document.getElementById("metricas-tbody-pordia");
  if (!porDia.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--vf-text-l);padding:1.5rem 0;">Sem dados no período.</td></tr>`;
    return;
  }
  tbody.innerHTML = porDia.map(d => `<tr>
    <td style="white-space:nowrap;">${fmtDataLonga(d.data)}</td>
    <td class="num">${fmtBRL(d.vendasBrutas)}</td>
    <td class="num">${fmtInt(d.quantidadeVendas)}</td>
    <td class="num">${fmtInt(d.unidadesVendidas)}</td>
    <td class="num">${fmtBRL(d.ticketMedio)}</td>
    <td class="num">${fmtInt(d.quantidadeCanceladas)}</td>
    <td class="num">${fmtBRL(d.valorCancelado)}</td>
  </tr>`).join("");
}

function renderTabelaTopProdutos(topProdutos) {
  const tbody = document.getElementById("metricas-tbody-top");
  const badge = document.getElementById("metricas-top-count");

  if (!topProdutos.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--vf-text-l);padding:1.5rem 0;">Sem produtos no período.</td></tr>`;
    return;
  }

  tbody.innerHTML = topProdutos.slice(0, 50).map(p => `<tr>
    <td title="${esc(p.titulo)}">${esc(trunc(p.titulo))}</td>
    <td><code style="font-size:.78rem;color:var(--vf-text-m);">${esc(p.itemId)}</code></td>
    <td style="font-size:.82rem;color:var(--vf-text-m);">${esc(p.sku || "—")}</td>
    <td class="num">${fmtInt(p.unidades)}</td>
    <td class="num">${fmtBRL(p.faturamento)}</td>
    <td class="num">${fmtBRL(p.ticketMedio)}</td>
    <td class="num">${fmtBRL(p.comissaoEstimada)}</td>
  </tr>`).join("");

  if (badge) { badge.textContent = topProdutos.length; badge.style.display = ""; }
}

// ─── Render principal ─────────────────────────────────────────────────────────

function renderResumo(data) {
  const resumo      = data.resumo      || {};
  const porDia      = data.porDia      || [];
  const topProdutos = data.topProdutos || [];
  const comparativo = data.comparativo || null;

  if (!resumo.quantidadeVendas) {
    mostrarEstado("empty");
    return;
  }

  ocultarEstado();
  mostrarResultados();

  renderCards(resumo, comparativo);

  document.getElementById("metricas-chart-vendas").innerHTML =
    criarLinhaChart(porDia, "vendasBrutas",     "#2563eb", fmtBRLChart);
  document.getElementById("metricas-chart-qtd").innerHTML =
    criarBarrasChart(porDia, "quantidadeVendas", "#5a2a8f");

  renderTopProdutosBar(topProdutos);
  renderTabelaPorDia(porDia);
  renderTabelaTopProdutos(topProdutos);
}

// ─── Filtrar ─────────────────────────────────────────────────────────────────

async function filtrar() {
  const slug    = (document.getElementById("metricas-sel-cliente").value || "").trim();
  const preset  = document.getElementById("metricas-sel-periodo").value;
  const compare = document.getElementById("metricas-sel-compare").value;

  if (!slug) {
    mostrarEstado("idle");
    return;
  }

  let dateFrom, dateTo;
  if (preset === "custom") {
    dateFrom = document.getElementById("metricas-input-from").value;
    dateTo   = document.getElementById("metricas-input-to").value;
    if (!dateFrom || !dateTo) {
      mostrarEstado("error", "Informe a data inicial e final para o período personalizado.");
      return;
    }
  } else {
    const p = calcularPeriodo(preset);
    if (!p) { mostrarEstado("error", "Período inválido."); return; }
    dateFrom = p.from;
    dateTo   = p.to;
  }

  mostrarEstado("loading");

  try {
    const qs = new URLSearchParams({ clienteSlug: slug, dateFrom, dateTo });
    if (compare !== "none") qs.set("compare", compare);

    const data = await apiFetch(`/metricas/resumo?${qs}`);

    if (!data) { mostrarEstado("error", "Não foi possível conectar ao servidor."); return; }
    if (!data.ok && data.semDados) { mostrarEstado("error", "Cliente sem Mercado Livre conectado."); return; }
    if (!data.ok) { mostrarEstado("error", data.motivo || "Erro ao carregar as métricas."); return; }

    renderResumo(data);
  } catch {
    mostrarEstado("error", "Erro inesperado ao carregar as métricas. Tente novamente.");
  }
}

// ─── Inicialização ────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  mostrarEstado("idle");

  const selPeriodo = document.getElementById("metricas-sel-periodo");
  const wrapFrom   = document.getElementById("metricas-wrap-from");
  const wrapTo     = document.getElementById("metricas-wrap-to");

  function syncCustomDates() {
    const custom = selPeriodo.value === "custom";
    wrapFrom.classList.toggle("is-visible", custom);
    wrapTo.classList.toggle("is-visible", custom);
    if (custom) {
      const p = calcularPeriodo("last_30_days");
      const inputFrom = document.getElementById("metricas-input-from");
      const inputTo   = document.getElementById("metricas-input-to");
      if (!inputFrom.value) inputFrom.value = p.from;
      if (!inputTo.value)   inputTo.value   = p.to;
    }
  }
  selPeriodo.addEventListener("change", syncCustomDates);

  document.getElementById("metricas-btn-filtrar").addEventListener("click", filtrar);
  document.getElementById("metricas-btn-atualizar").addEventListener("click", filtrar);

  await carregarClientes();
});
