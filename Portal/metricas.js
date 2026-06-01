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

// ─── Date Picker state ────────────────────────────────────────────────────────

let _calFrom  = null;  // "YYYY-MM-DD"
let _calTo    = null;  // "YYYY-MM-DD"
let _calStep  = 0;     // 0 = aguardando 1º clique, 1 = aguardando 2º clique
let _calYear  = new Date().getFullYear();
let _calMonth = new Date().getMonth();

const CAL_MONTHS = [
  "Janeiro","Fevereiro","Março","Abril","Maio","Junho",
  "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"
];

function calOpen() {
  if (_calFrom) {
    const d = new Date(_calFrom + "T00:00:00");
    _calYear  = d.getFullYear();
    _calMonth = d.getMonth();
  } else {
    const now = new Date();
    _calYear  = now.getFullYear();
    _calMonth = now.getMonth();
  }
  calRender();

  const pop = document.getElementById("metricas-calendar-popover");
  pop.style.visibility = "hidden";
  pop.style.display    = "";
  _calPosition(pop);
  pop.style.visibility = "";
}

function _calPosition(pop) {
  const btn  = document.getElementById("metricas-date-picker-btn");
  const rect = btn.getBoundingClientRect();
  const W    = pop.offsetWidth  || 314;
  const H    = pop.offsetHeight || 360;
  const gap  = 8;
  const vpW  = window.innerWidth;
  const vpH  = window.innerHeight;

  // Horizontal: alinha à esquerda do botão, mas não sai da viewport
  let left = rect.left;
  if (left + W > vpW - gap) left = vpW - W - gap;
  if (left < gap) left = gap;

  // Vertical: prefere acima se couber, senão abre abaixo
  const spaceAbove = rect.top  - gap;
  const spaceBelow = vpH - rect.bottom - gap;
  let top;
  if (spaceAbove >= H || spaceAbove >= spaceBelow) {
    top = rect.top - H - gap;
    if (top < gap) top = gap;
  } else {
    top = rect.bottom + gap;
    if (top + H > vpH - gap) top = Math.max(gap, vpH - H - gap);
  }

  pop.style.left = left + "px";
  pop.style.top  = top  + "px";
}

function calClose() {
  const el = document.getElementById("metricas-calendar-popover");
  if (el) el.style.display = "none";
}

function calRender() {
  document.getElementById("metricas-cal-label").textContent =
    `${CAL_MONTHS[_calMonth]} ${_calYear}`;

  const firstDow  = new Date(_calYear, _calMonth, 1).getDay();
  const daysCount = new Date(_calYear, _calMonth + 1, 0).getDate();
  const todayIso  = new Date().toISOString().slice(0, 10);

  const lo = _calFrom && _calTo
    ? (_calFrom <= _calTo ? _calFrom : _calTo)
    : _calFrom;
  const hi = _calFrom && _calTo
    ? (_calFrom <= _calTo ? _calTo : _calFrom)
    : null;

  let html = "";
  for (let i = 0; i < firstDow; i++) {
    html += `<div class="metricas-calendar-day metricas-calendar-day--empty"></div>`;
  }
  for (let d = 1; d <= daysCount; d++) {
    const m   = String(_calMonth + 1).padStart(2, "0");
    const day = String(d).padStart(2, "0");
    const iso = `${_calYear}-${m}-${day}`;
    let cls   = "metricas-calendar-day";

    if (iso === todayIso) cls += " metricas-calendar-day--today";

    if (lo && hi) {
      if (lo === hi && iso === lo)        cls += " metricas-calendar-day--single";
      else if (iso === lo)               cls += " metricas-calendar-day--start";
      else if (iso === hi)               cls += " metricas-calendar-day--end";
      else if (iso > lo && iso < hi)     cls += " metricas-calendar-day--in-range";
    } else if (lo && iso === lo) {
      cls += " metricas-calendar-day--start";
    }

    html += `<div class="${cls}" data-date="${iso}">${d}</div>`;
  }
  document.getElementById("metricas-calendar-days").innerHTML = html;

  const hint = document.getElementById("metricas-calendar-hint");
  if (hint) {
    hint.textContent = _calStep === 1
      ? "Clique para definir a data final"
      : "Clique para definir a data inicial";
  }
}

function calHandleDay(iso) {
  if (_calStep === 0) {
    _calFrom = iso;
    _calTo   = null;
    _calStep = 1;
  } else {
    _calTo   = iso;
    _calStep = 0;
    if (_calFrom > _calTo) { const t = _calFrom; _calFrom = _calTo; _calTo = t; }
  }
  calRender();
  calUpdateBtnLabel();
}

function calUpdateBtnLabel() {
  const span = document.getElementById("metricas-date-picker-label");
  const btn  = document.getElementById("metricas-date-picker-btn");
  if (!span || !btn) return;
  if (_calFrom && _calTo) {
    span.textContent = `${fmtDataLonga(_calFrom)} até ${fmtDataLonga(_calTo)}`;
    btn.classList.add("metricas-date-picker-btn--has-value");
  } else if (_calFrom) {
    span.textContent = `${fmtDataLonga(_calFrom)} → …`;
    btn.classList.remove("metricas-date-picker-btn--has-value");
  } else {
    span.textContent = "Selecione as datas";
    btn.classList.remove("metricas-date-picker-btn--has-value");
  }
}

function calApply() {
  if (!_calFrom || !_calTo) {
    mostrarEstado("error", "Selecione a data inicial e final.");
    return;
  }
  calClose();
  const slug = (document.getElementById("metricas-sel-cliente").value || "").trim();
  if (slug) filtrar();
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

const ICONE_METRICAS = {
  "vendasBrutas":                 `<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H6"/>`,
  "quantidadeVendas":             `<path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>`,
  "unidadesVendidas":             `<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>`,
  "precoMedioUnidade":            `<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>`,
  "ticketMedio":                  `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>`,
  "comissaoEstimada":             `<circle cx="12" cy="12" r="10"/><path d="M15 9h.01"/><path d="M9 15h.01"/><line x1="14.5" y1="9.5" x2="9.5" y2="14.5"/>`,
  "descontoEstimado":             `<line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>`,
  "quantidadeCanceladasAjustada": `<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
  "valorCanceladoAjustado":       `<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>`,
};

function svgCard(id) {
  const d = ICONE_METRICAS[id] || `<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>`;
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
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
  document.getElementById("metricas-cards-grid").innerHTML =
    `<div class="metricas-section-label">Resumo do período</div>` +
    CARDS.map(cfg => {
      const valor   = resumo[cfg.id];
      const comp    = comparativo && cfg.comp ? comparativo[cfg.comp] : null;
      const pctHtml = renderPct(comp, cfg.inv);
      return `<div class="metricas-kpi-card metricas-kpi-card${cfg.cls}">
        <div class="metricas-kpi-top">
          <div class="metricas-kpi-icon">${svgCard(cfg.id)}</div>
          ${pctHtml}
        </div>
        <div class="metricas-kpi-value">${cfg.fmt(valor)}</div>
        <div class="metricas-kpi-label">
          ${esc(cfg.label)}
          ${cfg.hint ? `<span class="metricas-hint">${esc(cfg.hint)}</span>` : ""}
        </div>
      </div>`;
    }).join("");
}

// ─── Gráfico de linha (SVG puro) ──────────────────────────────────────────────

function criarLinhaChart(dados, campo, cor, fmtYFn) {
  if (!dados.length) return `<p class="metricas-chart-empty">Sem dados para exibir.</p>`;

  const W = 480, H = 200;
  const P = { t: 16, r: 12, b: 36, l: 60 };
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

  const W = 480, H = 175;
  const P = { t: 10, r: 12, b: 34, l: 42 };
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
    <td class="metricas-table-date">${fmtDataLonga(d.data)}</td>
    <td class="num">${fmtBRL(d.vendasBrutas)}</td>
    <td class="num">${fmtInt(d.quantidadeVendas)}</td>
    <td class="num">${fmtInt(d.unidadesVendidas)}</td>
    <td class="num">${fmtBRL(d.ticketMedio)}</td>
    <td class="num metricas-table-cancel">${fmtInt(d.quantidadeCanceladas)}</td>
    <td class="num metricas-table-cancel">${fmtBRL(d.valorCancelado)}</td>
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
    <td class="metricas-table-produto" title="${esc(p.titulo)}">${esc(trunc(p.titulo))}</td>
    <td><span class="metricas-table-code">${esc(p.itemId)}</span></td>
    <td><span class="metricas-table-sku">${esc(p.sku || "—")}</span></td>
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
    mostrarEstado("error", "Selecione um cliente para filtrar as métricas.");
    return;
  }

  let dateFrom, dateTo;
  if (preset === "custom") {
    if (!_calFrom || !_calTo) {
      mostrarEstado("error", "Selecione a data inicial e final.");
      return;
    }
    dateFrom = _calFrom;
    dateTo   = _calTo;
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

  function syncCustomDates() {
    const isCustom = selPeriodo.value === "custom";
    const body = document.querySelector(".metricas-filters-body");
    body.classList.toggle("metricas-filters-body--has-picker", isCustom);
    if (!isCustom) {
      calClose();
      _calFrom = null;
      _calTo   = null;
      _calStep = 0;
      const span = document.getElementById("metricas-date-picker-label");
      const btn  = document.getElementById("metricas-date-picker-btn");
      if (span) span.textContent = "Selecione as datas";
      if (btn)  btn.classList.remove("metricas-date-picker-btn--has-value");
    }
  }
  selPeriodo.addEventListener("change", syncCustomDates);

  // Toggle popover ao clicar no botão
  document.getElementById("metricas-date-picker-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const pop = document.getElementById("metricas-calendar-popover");
    if (!pop.style.display || pop.style.display === "none") {
      calOpen();
    } else {
      calClose();
    }
  });

  // Clique nos dias
  document.getElementById("metricas-calendar-days").addEventListener("click", (e) => {
    const day = e.target.closest(".metricas-calendar-day:not(.metricas-calendar-day--empty)");
    if (day && day.dataset.date) calHandleDay(day.dataset.date);
  });

  // Navegação de meses
  document.getElementById("metricas-cal-prev").addEventListener("click", (e) => {
    e.stopPropagation();
    _calMonth--;
    if (_calMonth < 0) { _calMonth = 11; _calYear--; }
    calRender();
  });
  document.getElementById("metricas-cal-next").addEventListener("click", (e) => {
    e.stopPropagation();
    _calMonth++;
    if (_calMonth > 11) { _calMonth = 0; _calYear++; }
    calRender();
  });

  // Botão Aplicar
  document.getElementById("metricas-cal-apply").addEventListener("click", (e) => {
    e.stopPropagation();
    calApply();
  });

  // Impede que cliques dentro do popover fechem ele
  document.getElementById("metricas-calendar-popover").addEventListener("click", (e) => {
    e.stopPropagation();
  });

  // Fecha o popover ao clicar fora
  document.addEventListener("click", () => calClose());

  document.getElementById("metricas-btn-filtrar").addEventListener("click", filtrar);
  document.getElementById("metricas-btn-atualizar").addEventListener("click", filtrar);

  await carregarClientes();
});
