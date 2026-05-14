// Portal/ads.js — Página de Mercado Ads

const API_BASE    = "https://venforce-server.onrender.com";
const STORAGE_KEY = "vf-token";

function getToken() {
  const t = localStorage.getItem(STORAGE_KEY);
  if (!t) { window.location.replace("index.html"); return null; }
  return t;
}
getToken();
initLayout();

// ─── Mock fallback (usado apenas se a API ML falhar) ──────────────────────────

const ADS_MOCK_FALLBACK = [
  { mes: 1,  label: "Janeiro",   investimentoAds: 6100,  gmvAds: 140900, roas: 23.10, cliques: 0, impressoes: 0, vendas: 0 },
  { mes: 2,  label: "Fevereiro", investimentoAds: 4700,  gmvAds: 108800, roas: 23.15, cliques: 0, impressoes: 0, vendas: 0 },
  { mes: 3,  label: "Março",     investimentoAds: 7700,  gmvAds: 117900, roas: 15.31, cliques: 0, impressoes: 0, vendas: 0 },
  { mes: 4,  label: "Abril",     investimentoAds: 7700,  gmvAds: 146300, roas: 19.00, cliques: 0, impressoes: 0, vendas: 0 },
  { mes: 5,  label: "Maio",      investimentoAds: 2300,  gmvAds:  43600, roas: 18.96, cliques: 0, impressoes: 0, vendas: 0 },
  { mes: 6,  label: "Junho",     investimentoAds: 0,     gmvAds: 0,      roas: 0,     cliques: 0, impressoes: 0, vendas: 0 },
  { mes: 7,  label: "Julho",     investimentoAds: 0,     gmvAds: 0,      roas: 0,     cliques: 0, impressoes: 0, vendas: 0 },
  { mes: 8,  label: "Agosto",    investimentoAds: 0,     gmvAds: 0,      roas: 0,     cliques: 0, impressoes: 0, vendas: 0 },
  { mes: 9,  label: "Setembro",  investimentoAds: 0,     gmvAds: 0,      roas: 0,     cliques: 0, impressoes: 0, vendas: 0 },
  { mes: 10, label: "Outubro",   investimentoAds: 0,     gmvAds: 0,      roas: 0,     cliques: 0, impressoes: 0, vendas: 0 },
  { mes: 11, label: "Novembro",  investimentoAds: 0,     gmvAds: 0,      roas: 0,     cliques: 0, impressoes: 0, vendas: 0 },
  { mes: 12, label: "Dezembro",  investimentoAds: 0,     gmvAds: 0,      roas: 0,     cliques: 0, impressoes: 0, vendas: 0 },
];

const ADS_MESES_LABELS = [
  "", "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

const ADS_CAMPANHAS = ["Todas", "Campanha Geral", "Produtos Premium", "Liquidação"];

const ADS_CHECKLIST_ITEMS = [
  "Dados de Ads conferidos",
  "ROAS analisado",
  "TACOS analisado",
  "Cancelados / devolvidos revisados",
  "Feedback enviado ao cliente",
  "Cliente respondeu",
];

const ADS_CHECKLIST_KEYS = [
  "dadosConferidos",
  "roasAnalisado",
  "tacosAnalisado",
  "canceladosRevisados",
  "feedbackEnviado",
  "clienteRespondeu",
];

// ─── Estado ───────────────────────────────────────────────────────────────────

let ADS_CLIENTES_LISTA       = [];
let ADS_ACOMPANHAMENTO_ATUAL = null;
let ADS_CHECKLIST_ATUAL      = { semana1: {}, semana2: {}, semana3: {}, semana4: {} };
let ADS_FEEDBACK_ATUAL       = "";
let ADS_HAS_UNSAVED_CHANGES  = false;
let ADS_SAVING               = false;

// "idle" | "loading" | "loaded" | "sem_dados" | "fallback" | "error"
let ADS_PERFORMANCE_ESTADO = "idle";
let ADS_PERFORMANCE_ATUAL  = null; // dados reais da API

// ─── Helpers de formatação ────────────────────────────────────────────────────

function adsFmtBRL(n) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0);
}
function adsFmtNum(n, decimals = 2) {
  return Number(n).toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function adsFmtPct(n, decimals = 2) {
  return adsFmtNum(n, decimals) + "%";
}
function adsFmtInt(n) {
  return Number(n).toLocaleString("pt-BR");
}
function adsEscape(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}

// ─── Status baseado em ROAS ───────────────────────────────────────────────────

function adsStatusRoas(roas) {
  if (roas >= 20) return { label: "Saudável", cls: "ads-badge-success" };
  if (roas >= 15) return { label: "Atenção",  cls: "ads-badge-warning" };
  if (roas >   0) return { label: "Crítico",  cls: "ads-badge-danger"  };
  return                  { label: "—",        cls: ""                  };
}

// ─── Filtros ──────────────────────────────────────────────────────────────────

function adsGetFiltroMes() {
  const sel = document.getElementById("ads-filtro-mes");
  return sel ? Number(sel.value) || 0 : 0;
}

function adsGetFiltroMesRef() {
  const mesNum = adsGetFiltroMes();
  if (!mesNum) return null;
  const ano = new Date().getFullYear();
  return `${ano}-${String(mesNum).padStart(2, "0")}`;
}

function adsGetClienteSlug() {
  const sel = document.getElementById("ads-filtro-cliente");
  return sel ? (sel.value || "").trim() : "";
}

function adsGetLojaCampanha() {
  const sel = document.getElementById("ads-filtro-campanha");
  return (sel && sel.value) ? sel.value.trim() : "todas";
}

// ─── API fetch ────────────────────────────────────────────────────────────────

async function adsFetch(path, options = {}) {
  const token = localStorage.getItem(STORAGE_KEY);
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
    ...(options.headers || {}),
  };
  return fetch(`${API_BASE}${path}`, { ...options, headers });
}

// ─── Carregar clientes ────────────────────────────────────────────────────────

async function adsCarregarClientes() {
  const sel = document.getElementById("ads-filtro-cliente");
  if (!sel) return;
  try {
    const res  = await adsFetch("/ads/clientes");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.clientes)) throw new Error("Resposta inválida");
    ADS_CLIENTES_LISTA = data.clientes;
    sel.innerHTML = `<option value="">Selecione o cliente</option>` +
      data.clientes.map((c) =>
        `<option value="${adsEscape(c.slug)}">${adsEscape(c.nome)}</option>`
      ).join("");
  } catch (err) {
    console.warn("[ads] falha ao carregar clientes:", err.message);
    sel.innerHTML = `<option value="">Todos</option>`;
  }
}

// ─── Carregar performance via API ML ─────────────────────────────────────────

async function adsCarregarPerformance() {
  const clienteSlug = adsGetClienteSlug();
  const mes         = adsGetFiltroMesRef();

  if (!clienteSlug || !mes) {
    ADS_PERFORMANCE_ATUAL  = null;
    ADS_PERFORMANCE_ESTADO = "idle";
    adsRenderPerformance();
    return;
  }

  ADS_PERFORMANCE_ESTADO = "loading";
  adsRenderPerformance();

  try {
    const params = new URLSearchParams({ clienteSlug, mes });
    const res    = await adsFetch(`/ads/performance?${params}`);
    const data   = await res.json();

    if (!res.ok || !data.ok) throw new Error(data.erro || `HTTP ${res.status}`);

    if (data.semDados) {
      ADS_PERFORMANCE_ATUAL  = null;
      ADS_PERFORMANCE_ESTADO = "sem_dados";
      const motEl = document.getElementById("ads-sem-dados-motivo");
      if (motEl) motEl.textContent = data.motivo || "";
    } else {
      ADS_PERFORMANCE_ATUAL  = data.performance;
      ADS_PERFORMANCE_ESTADO = "loaded";
    }
  } catch (err) {
    console.warn("[ads] falha ao carregar performance, usando fallback:", err.message);
    ADS_PERFORMANCE_ATUAL  = null;
    ADS_PERFORMANCE_ESTADO = "fallback";
  }

  adsRenderPerformance();
}

// ─── Render: banner sem dados ─────────────────────────────────────────────────

function adsRenderBanner() {
  const banner = document.getElementById("ads-sem-dados-banner");
  if (!banner) return;
  banner.style.display = ADS_PERFORMANCE_ESTADO === "sem_dados" ? "flex" : "none";
}

// ─── Render: cards de resumo ──────────────────────────────────────────────────

function adsRenderSummary() {
  const grid = document.getElementById("ads-summary-grid");
  if (!grid) return;

  if (ADS_PERFORMANCE_ESTADO === "idle") {
    grid.innerHTML = `<div class="ads-performance-empty">Selecione um <strong>cliente</strong> e um <strong>mês</strong> para carregar a performance.</div>`;
    return;
  }
  if (ADS_PERFORMANCE_ESTADO === "loading") {
    grid.innerHTML = `<div class="ads-performance-empty">Carregando dados da API Mercado Livre Ads…</div>`;
    return;
  }
  if (ADS_PERFORMANCE_ESTADO === "sem_dados") {
    grid.innerHTML = "";
    return;
  }

  let d;
  if (ADS_PERFORMANCE_ESTADO === "loaded" && ADS_PERFORMANCE_ATUAL) {
    d = ADS_PERFORMANCE_ATUAL;
  } else {
    // fallback: mock para o mês selecionado
    const mesNum = adsGetFiltroMes();
    d = ADS_MOCK_FALLBACK.find((m) => m.mes === mesNum) || ADS_MOCK_FALLBACK[0];
  }

  const cards = [
    {
      label: "Investimento Ads",
      value: adsFmtBRL(d.investimentoAds),
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
      accent: "ads",
    },
    {
      label: "GMV Ads",
      value: adsFmtBRL(d.gmvAds),
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>`,
      accent: "ads",
    },
    {
      label: "ROAS",
      value: adsFmtNum(d.roas) + "x",
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>`,
      accent: d.roas >= 20 ? "success" : d.roas >= 15 ? "warning" : "danger",
    },
    {
      label: "Cliques",
      value: adsFmtInt(d.cliques),
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 15l-5-5M6.7 6.7A8 8 0 1 0 17.3 17.3"/></svg>`,
      accent: "neutral",
    },
    {
      label: "Impressões",
      value: adsFmtInt(d.impressoes),
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
      accent: "neutral",
    },
    {
      label: "Vendas via Ads",
      value: adsFmtInt(d.vendas),
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`,
      accent: "purple",
    },
  ];

  grid.innerHTML = cards.map((c) => `
    <div class="ads-summary-card ads-summary-card--${adsEscape(c.accent)}">
      <div class="ads-summary-icon">${c.icon}</div>
      <div class="ads-summary-body">
        <div class="ads-summary-value">${adsEscape(c.value)}</div>
        <div class="ads-summary-label">${adsEscape(c.label)}</div>
      </div>
    </div>`).join("");
}

// ─── Render: tabela mensal ────────────────────────────────────────────────────

function adsRenderTabela() {
  const tbody = document.getElementById("ads-table-body");
  const badge = document.getElementById("ads-table-total");
  if (!tbody) return;

  if (ADS_PERFORMANCE_ESTADO === "idle") {
    if (badge) badge.style.display = "none";
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--vf-text-m);">Selecione um cliente e mês para ver a performance.</td></tr>`;
    return;
  }
  if (ADS_PERFORMANCE_ESTADO === "loading") {
    if (badge) badge.style.display = "none";
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--vf-text-m);">Carregando…</td></tr>`;
    return;
  }
  if (ADS_PERFORMANCE_ESTADO === "sem_dados") {
    if (badge) badge.style.display = "none";
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--vf-text-m);">Sem dados de Ads para este cliente.</td></tr>`;
    return;
  }

  let rows;
  if (ADS_PERFORMANCE_ESTADO === "loaded" && ADS_PERFORMANCE_ATUAL) {
    const d   = ADS_PERFORMANCE_ATUAL;
    const mes = adsGetFiltroMes();
    const label = ADS_MESES_LABELS[mes] || d.mesRef || "—";
    const st  = adsStatusRoas(d.roas);
    rows = [`
      <tr>
        <td class="ads-td-mes"><strong>${adsEscape(label)}</strong></td>
        <td class="num ads-td-inv">${adsEscape(adsFmtBRL(d.investimentoAds))}</td>
        <td class="num">${adsEscape(adsFmtBRL(d.gmvAds))}</td>
        <td class="num ${d.roas >= 20 ? "ads-num-good" : d.roas >= 15 ? "" : "ads-num-warn"}">${adsEscape(adsFmtNum(d.roas))}x</td>
        <td class="num">${adsEscape(adsFmtInt(d.cliques))}</td>
        <td class="num">${adsEscape(adsFmtInt(d.impressoes))}</td>
        <td class="num">${d.vendas > 0 ? adsEscape(adsFmtInt(d.vendas)) : "—"}</td>
        <td class="center"><span class="ads-badge ${adsEscape(st.cls)}">${adsEscape(st.label)}</span></td>
      </tr>`];
  } else {
    // fallback mock: mês selecionado ou todos
    const mesNum = adsGetFiltroMes();
    const dados  = mesNum
      ? ADS_MOCK_FALLBACK.filter((d) => d.mes === mesNum)
      : ADS_MOCK_FALLBACK.filter((d) => d.investimentoAds > 0);
    rows = dados.map((d) => {
      const st = adsStatusRoas(d.roas);
      return `
        <tr>
          <td class="ads-td-mes"><strong>${adsEscape(d.label)}</strong></td>
          <td class="num ads-td-inv">${adsEscape(adsFmtBRL(d.investimentoAds))}</td>
          <td class="num">${adsEscape(adsFmtBRL(d.gmvAds))}</td>
          <td class="num ${d.roas >= 20 ? "ads-num-good" : d.roas >= 15 ? "" : "ads-num-warn"}">${adsEscape(adsFmtNum(d.roas))}x</td>
          <td class="num">—</td>
          <td class="num">—</td>
          <td class="num">—</td>
          <td class="center"><span class="ads-badge ${adsEscape(st.cls)}">${adsEscape(st.label)}</span></td>
        </tr>`;
    });
  }

  if (badge) { badge.textContent = String(rows.length); badge.style.display = "inline-block"; }
  tbody.innerHTML = rows.length
    ? rows.join("")
    : `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--vf-text-m);">Nenhum dado para o filtro selecionado.</td></tr>`;
}

// ─── Render unificado de performance ─────────────────────────────────────────

function adsRenderPerformance() {
  adsRenderBanner();
  adsRenderSummary();
  adsRenderTabela();
}

// ─── Checklist semanal ────────────────────────────────────────────────────────

async function adsCarregarAcompanhamento() {
  const clienteSlug = adsGetClienteSlug();
  const mes         = adsGetFiltroMesRef();

  if (!clienteSlug || !mes) {
    ADS_CHECKLIST_ATUAL      = { semana1: {}, semana2: {}, semana3: {}, semana4: {} };
    ADS_FEEDBACK_ATUAL       = "";
    ADS_ACOMPANHAMENTO_ATUAL = null;
    ADS_HAS_UNSAVED_CHANGES  = false;
    adsAtualizarFeedbackTextarea();
    adsAtualizarUpdatedAt(null);
    adsRenderChecklist();
    adsAtualizarBotaoSalvar();
    return;
  }

  const loja = adsGetLojaCampanha();
  adsSetSaveStatus("Carregando…", "ads-save-loading");

  try {
    const params = new URLSearchParams({ clienteSlug, mes, lojaCampanha: loja });
    const res    = await adsFetch(`/ads/acompanhamento?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok || !data.acompanhamento) throw new Error("Resposta inválida");

    const a = data.acompanhamento;
    ADS_ACOMPANHAMENTO_ATUAL = a;
    ADS_CHECKLIST_ATUAL = (a.checklist && typeof a.checklist === "object" && !Array.isArray(a.checklist))
      ? a.checklist
      : { semana1: {}, semana2: {}, semana3: {}, semana4: {} };
    ADS_FEEDBACK_ATUAL      = a.feedbackText || "";
    ADS_HAS_UNSAVED_CHANGES = false;

    adsAtualizarFeedbackTextarea();
    adsAtualizarUpdatedAt(a.updatedAt);
    adsRenderChecklist();
    adsSetSaveStatus("Carregado", "ads-save-ok");
    setTimeout(() => adsLimparSaveStatus("ads-save-ok"), 2500);
  } catch (err) {
    console.warn("[ads] falha ao carregar acompanhamento:", err.message);
    ADS_CHECKLIST_ATUAL     = { semana1: {}, semana2: {}, semana3: {}, semana4: {} };
    ADS_FEEDBACK_ATUAL      = "";
    ADS_HAS_UNSAVED_CHANGES = false;
    adsAtualizarFeedbackTextarea();
    adsAtualizarUpdatedAt(null);
    adsRenderChecklist();
    adsSetSaveStatus("Erro ao carregar", "ads-save-error");
    setTimeout(() => adsLimparSaveStatus("ads-save-error"), 3500);
  }

  adsAtualizarBotaoSalvar();
}

function adsAtualizarFeedbackTextarea() {
  const ta = document.getElementById("ads-feedback-textarea");
  if (ta) ta.value = ADS_FEEDBACK_ATUAL;
}

function adsAtualizarUpdatedAt(updatedAt) {
  const el = document.getElementById("ads-updated-at");
  if (!el) return;
  if (!updatedAt) { el.style.display = "none"; el.textContent = ""; return; }
  const str = new Date(updatedAt).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  el.textContent   = `Última atualização: ${str}`;
  el.style.display = "block";
}

// ─── Status de salvamento ─────────────────────────────────────────────────────

function adsSetSaveStatus(msg, cls) {
  const el = document.getElementById("ads-save-status");
  if (!el) return;
  el.textContent   = msg;
  el.className     = `ads-save-status${cls ? " " + cls : ""}`;
  el.style.display = "inline";
}

function adsLimparSaveStatus(onlyCls) {
  const el = document.getElementById("ads-save-status");
  if (!el) return;
  if (onlyCls && !el.classList.contains(onlyCls)) return;
  el.style.display = "none";
  el.textContent   = "";
  el.className     = "ads-save-status";
}

function adsAtualizarSaveStatus() {
  if (ADS_HAS_UNSAVED_CHANGES) {
    adsSetSaveStatus("Alterações não salvas", "ads-unsaved");
  } else {
    adsLimparSaveStatus();
  }
  adsAtualizarBotaoSalvar();
}

function adsCanSave() {
  return !!(adsGetClienteSlug() && adsGetFiltroMesRef() && !ADS_SAVING);
}

function adsAtualizarBotaoSalvar() {
  const btn = document.getElementById("ads-btn-salvar");
  if (!btn) return;
  btn.disabled = !adsCanSave();
}

// ─── Salvar acompanhamento ────────────────────────────────────────────────────

async function adsSalvarAcompanhamento() {
  if (!adsCanSave()) return;

  const clienteSlug  = adsGetClienteSlug();
  const mes          = adsGetFiltroMesRef();
  const lojaCampanha = adsGetLojaCampanha();

  ADS_SAVING = true;
  const btn  = document.getElementById("ads-btn-salvar");
  if (btn) { btn.disabled = true; btn.textContent = "Salvando…"; }
  adsSetSaveStatus("Salvando…", "ads-save-loading");

  try {
    const res = await adsFetch("/ads/acompanhamento", {
      method: "PUT",
      body: JSON.stringify({
        clienteSlug,
        mes,
        lojaCampanha,
        checklist:    ADS_CHECKLIST_ATUAL,
        feedbackText: ADS_FEEDBACK_ATUAL,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.erro || `HTTP ${res.status}`);

    ADS_HAS_UNSAVED_CHANGES  = false;
    ADS_ACOMPANHAMENTO_ATUAL = data.acompanhamento;
    adsAtualizarUpdatedAt(data.acompanhamento?.updatedAt);
    adsSetSaveStatus("Acompanhamento salvo", "ads-save-ok");
    setTimeout(() => adsLimparSaveStatus("ads-save-ok"), 2500);
  } catch (err) {
    console.warn("[ads] falha ao salvar:", err.message);
    adsSetSaveStatus(`Erro: ${err.message}`, "ads-save-error");
    setTimeout(() => adsLimparSaveStatus("ads-save-error"), 4000);
  } finally {
    ADS_SAVING = false;
    if (btn) { btn.textContent = "Salvar acompanhamento"; btn.disabled = !adsCanSave(); }
  }
}

// ─── Render: checklist semanal ────────────────────────────────────────────────

function adsGetCheck(sem, idx) {
  const semKey  = `semana${sem}`;
  const itemKey = ADS_CHECKLIST_KEYS[idx];
  const semObj  = ADS_CHECKLIST_ATUAL[semKey];
  return !!(semObj && semObj[itemKey]);
}

function adsSetCheck(sem, idx, value) {
  const semKey  = `semana${sem}`;
  const itemKey = ADS_CHECKLIST_KEYS[idx];
  if (!ADS_CHECKLIST_ATUAL[semKey]) ADS_CHECKLIST_ATUAL[semKey] = {};
  if (value) {
    ADS_CHECKLIST_ATUAL[semKey][itemKey] = true;
  } else {
    delete ADS_CHECKLIST_ATUAL[semKey][itemKey];
  }
  ADS_HAS_UNSAVED_CHANGES = true;
  adsAtualizarSaveStatus();
}

function adsRenderChecklist() {
  const grid = document.getElementById("ads-checklist-grid");
  if (!grid) return;

  const clienteSlug = adsGetClienteSlug();
  const mes         = adsGetFiltroMesRef();

  if (!clienteSlug || !mes) {
    grid.innerHTML = `
      <div class="ads-checklist-empty">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Selecione um <strong>cliente</strong> e um <strong>mês</strong> para carregar o checklist.
      </div>`;
    adsAtualizarBotaoSalvar();
    return;
  }

  const semanas = [1, 2, 3, 4];
  grid.innerHTML = semanas.map((sem) => {
    const checks = ADS_CHECKLIST_ITEMS.map((item, idx) => {
      const checked = adsGetCheck(sem, idx);
      return `
        <label class="ads-check-item ${checked ? "is-checked" : ""}">
          <input type="checkbox" class="ads-check-input" data-semana="${sem}" data-idx="${idx}" ${checked ? "checked" : ""}>
          <span class="ads-check-box" aria-hidden="true">
            ${checked ? `<svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 6 4.5 9.5 11 2"/></svg>` : ""}
          </span>
          <span class="ads-check-label">${adsEscape(item)}</span>
        </label>`;
    }).join("");

    const total   = ADS_CHECKLIST_ITEMS.length;
    const done    = ADS_CHECKLIST_ITEMS.filter((_, idx) => adsGetCheck(sem, idx)).length;
    const pct     = Math.round((done / total) * 100);
    const allDone = done === total;

    return `
      <div class="ads-week-card ${allDone ? "is-complete" : ""}">
        <div class="ads-week-header">
          <div class="ads-week-title">
            <span class="ads-week-num">Semana ${sem}</span>
            ${allDone ? `<svg class="ads-week-done-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` : ""}
          </div>
          <div class="ads-week-progress">
            <div class="ads-week-progress-bar" style="width:${pct}%"></div>
          </div>
          <span class="ads-week-progress-label">${done}/${total}</span>
        </div>
        <div class="ads-week-checks">${checks}</div>
      </div>`;
  }).join("");

  grid.querySelectorAll(".ads-check-input").forEach((input) => {
    input.addEventListener("change", () => {
      const sem = Number(input.dataset.semana);
      const idx = Number(input.dataset.idx);
      adsSetCheck(sem, idx, input.checked);
      adsRenderChecklist();
    });
  });

  adsAtualizarBotaoSalvar();
}

// ─── Feedback para o cliente ──────────────────────────────────────────────────

function adsGerarFeedback() {
  let inv = 0, gmv = 0, roas = 0, cliques = 0, impressoes = 0, mesLabel = "período selecionado";
  const mes = adsGetFiltroMes();

  if (ADS_PERFORMANCE_ESTADO === "loaded" && ADS_PERFORMANCE_ATUAL) {
    const d = ADS_PERFORMANCE_ATUAL;
    inv        = d.investimentoAds;
    gmv        = d.gmvAds;
    roas       = d.roas;
    cliques    = d.cliques;
    impressoes = d.impressoes;
    mesLabel   = ADS_MESES_LABELS[mes] || d.mesRef || mesLabel;
  } else if (mes) {
    const d  = ADS_MOCK_FALLBACK.find((m) => m.mes === mes);
    if (d) { inv = d.investimentoAds; gmv = d.gmvAds; roas = d.roas; mesLabel = d.label; }
  }

  if (!inv && !gmv) {
    const ta = document.getElementById("ads-feedback-textarea");
    if (ta) ta.value = "Nenhum dado disponível para o período selecionado.";
    ADS_FEEDBACK_ATUAL      = ta ? ta.value : "";
    ADS_HAS_UNSAVED_CHANGES = true;
    adsAtualizarSaveStatus();
    return;
  }

  const st = adsStatusRoas(roas);
  const linhas = [
    `📊 Relatório de Mercado Ads — ${mesLabel}`,
    ``,
    `💰 Investimento em Ads: ${adsFmtBRL(inv)}`,
    `📈 GMV gerado pelos Ads: ${adsFmtBRL(gmv)}`,
    `🔁 ROAS: ${adsFmtNum(roas)}x`,
  ];

  if (cliques > 0)    linhas.push(`🖱️  Cliques: ${adsFmtInt(cliques)}`);
  if (impressoes > 0) linhas.push(`👁️  Impressões: ${adsFmtInt(impressoes)}`);

  linhas.push(``, `✅ Análise:`);

  if (roas >= 20) {
    linhas.push(`Os investimentos em Ads estão com excelente retorno. O ROAS de ${adsFmtNum(roas)}x indica alta eficiência das campanhas.`);
  } else if (roas >= 15) {
    linhas.push(`O ROAS de ${adsFmtNum(roas)}x está em zona de atenção. Recomendamos revisar campanhas de menor performance para otimizar o retorno.`);
  } else if (roas > 0) {
    linhas.push(`O ROAS de ${adsFmtNum(roas)}x está abaixo do ideal. É importante revisar os lances e pausar campanhas de baixo retorno.`);
  }

  linhas.push(``, `📌 Próximos passos:`);
  linhas.push(`- Revisar campanhas com ROAS abaixo da média`);
  linhas.push(`- Acompanhar evolução do investimento vs. retorno`);
  linhas.push(`- Ajustar orçamento conforme sazonalidade`);

  const ta = document.getElementById("ads-feedback-textarea");
  if (ta) ta.value = linhas.join("\n");
  ADS_FEEDBACK_ATUAL      = ta ? ta.value : "";
  ADS_HAS_UNSAVED_CHANGES = true;
  adsAtualizarSaveStatus();
}

function adsCopiarFeedback() {
  const ta = document.getElementById("ads-feedback-textarea");
  const ok = document.getElementById("ads-copy-ok");
  if (!ta || !ta.value.trim()) return;
  navigator.clipboard.writeText(ta.value).then(() => {
    if (ok) { ok.style.display = "inline"; setTimeout(() => { ok.style.display = "none"; }, 2200); }
  }).catch(() => {
    ta.select();
    document.execCommand("copy");
  });
}

// ─── Preencher selects ────────────────────────────────────────────────────────

function adsFillSelects() {
  // Meses (todos os 12)
  const selMes = document.getElementById("ads-filtro-mes");
  if (selMes) {
    const anoAtual = new Date().getFullYear();
    selMes.innerHTML = `<option value="">Selecione o mês</option>` +
      ADS_MESES_LABELS.slice(1).map((label, i) =>
        `<option value="${i + 1}">${adsEscape(label)} / ${anoAtual}</option>`
      ).join("");
  }

  // Campanhas (mockadas — sem vínculo com API ainda)
  const selCamp = document.getElementById("ads-filtro-campanha");
  if (selCamp) {
    selCamp.innerHTML = ADS_CAMPANHAS.map((c, i) =>
      `<option value="${i === 0 ? "" : c}">${adsEscape(c)}</option>`
    ).join("");
  }

  // Período do checklist
  adsAtualizarPeriodoChecklist();

  // Cliente: populado por adsCarregarClientes() via fetch
}

function adsAtualizarPeriodoChecklist() {
  const periodEl = document.getElementById("ads-checklist-period");
  if (!periodEl) return;
  const mes = adsGetFiltroMes();
  const ano = new Date().getFullYear();
  if (!mes) {
    periodEl.textContent = `— / ${ano}`;
    return;
  }
  const d = new Date(ano, mes - 1, 1);
  periodEl.textContent = d.toLocaleDateString("pt-BR", { month: "short", year: "numeric" })
    .replace(/^\w/, (c) => c.toUpperCase());
}

// ─── Event listeners ─────────────────────────────────────────────────────────

document.getElementById("ads-btn-atualizar")?.addEventListener("click", () => {
  adsCarregarPerformance();
  adsCarregarAcompanhamento();
});

document.getElementById("ads-filtro-mes")?.addEventListener("change", () => {
  adsAtualizarPeriodoChecklist();
  adsCarregarPerformance();
  adsCarregarAcompanhamento();
});

document.getElementById("ads-filtro-cliente")?.addEventListener("change", () => {
  adsCarregarPerformance();
  adsCarregarAcompanhamento();
});

document.getElementById("ads-filtro-campanha")?.addEventListener("change", () => {
  adsCarregarAcompanhamento();
});

document.getElementById("ads-btn-gerar")?.addEventListener("click", adsGerarFeedback);
document.getElementById("ads-btn-copiar")?.addEventListener("click", adsCopiarFeedback);
document.getElementById("ads-btn-salvar")?.addEventListener("click", adsSalvarAcompanhamento);
document.getElementById("ads-feedback-textarea")?.addEventListener("input", (e) => {
  ADS_FEEDBACK_ATUAL      = e.target.value;
  ADS_HAS_UNSAVED_CHANGES = true;
  adsAtualizarSaveStatus();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

adsFillSelects();
adsRenderPerformance();
adsRenderChecklist();
adsCarregarClientes();
