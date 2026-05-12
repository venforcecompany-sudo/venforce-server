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

// ─── Dados mockados de performance ───────────────────────────────────────────
// Performance mensal continua mockada até integração com API Mercado Livre

const ADS_DADOS_MENSAIS = [
  { mes:1, label:"Janeiro",   investimentoAds:6100,  gmvAds:140900, roas:23.10, faturamentoTotal:179519.29, canceladosValor:449.72,  canceladosPct:0.40, devolvidosValor:294.72, tacos:3.40 },
  { mes:2, label:"Fevereiro", investimentoAds:4700,  gmvAds:108800, roas:23.15, faturamentoTotal:122597.28, canceladosValor:2157.11, canceladosPct:1.80, devolvidosValor:188.59, tacos:3.83 },
  { mes:3, label:"Março",     investimentoAds:7700,  gmvAds:117900, roas:15.31, faturamentoTotal:143752.64, canceladosValor:2518.07, canceladosPct:1.80, devolvidosValor:169.74, tacos:5.36 },
  { mes:4, label:"Abril",     investimentoAds:7700,  gmvAds:146300, roas:19.00, faturamentoTotal:181729.05, canceladosValor:121.47,  canceladosPct:0.20, devolvidosValor:0,      tacos:4.24 },
  { mes:5, label:"Maio",      investimentoAds:2300,  gmvAds:43600,  roas:18.96, faturamentoTotal:51290.75,  canceladosValor:0,       canceladosPct:0,    devolvidosValor:0,      tacos:4.48 },
];

// Campanhas mockadas (sem vínculo com API ainda)
const ADS_CAMPANHAS = ["Todas", "Campanha Geral", "Produtos Premium", "Liquidação"];

const ADS_CHECKLIST_ITEMS = [
  "Dados de Ads conferidos",
  "ROAS analisado",
  "TACOS analisado",
  "Cancelados / devolvidos revisados",
  "Feedback enviado ao cliente",
  "Cliente respondeu",
];

// Chaves correspondentes no backend (JSONB)
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
function adsEscape(s) {
  const d = document.createElement("div");
  d.textContent = String(s ?? "");
  return d.innerHTML;
}

// ─── Status TACOS ─────────────────────────────────────────────────────────────

function adsStatusTacos(tacos) {
  if (tacos <= 4) return { label: "Saudável", cls: "ads-badge-success" };
  if (tacos <= 5) return { label: "Atenção",  cls: "ads-badge-warning" };
  return             { label: "Crítico",   cls: "ads-badge-danger"  };
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

function adsGetDadosFiltrados() {
  const mes = adsGetFiltroMes();
  if (!mes) return ADS_DADOS_MENSAIS;
  return ADS_DADOS_MENSAIS.filter((d) => d.mes === mes);
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

// ─── Carregar clientes reais ──────────────────────────────────────────────────

async function adsCarregarClientes() {
  const sel = document.getElementById("ads-filtro-cliente");
  if (!sel) return;
  try {
    const res = await adsFetch("/ads/clientes");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.clientes)) throw new Error("Resposta inválida");
    ADS_CLIENTES_LISTA = data.clientes;
    sel.innerHTML = `<option value="">Todos</option>` +
      data.clientes.map((c) =>
        `<option value="${adsEscape(c.slug)}">${adsEscape(c.nome)}</option>`
      ).join("");
  } catch (err) {
    console.warn("[ads] falha ao carregar clientes:", err.message);
    sel.innerHTML = `<option value="">Todos</option>`;
  }
}

// ─── Carregar acompanhamento do backend ───────────────────────────────────────

async function adsCarregarAcompanhamento() {
  const clienteSlug = adsGetClienteSlug();
  const mes         = adsGetFiltroMesRef();

  if (!clienteSlug || !mes) {
    ADS_CHECKLIST_ATUAL     = { semana1: {}, semana2: {}, semana3: {}, semana4: {} };
    ADS_FEEDBACK_ATUAL      = "";
    ADS_ACOMPANHAMENTO_ATUAL = null;
    ADS_HAS_UNSAVED_CHANGES  = false;
    adsAtualizarFeedbackTextarea();
    adsAtualizarUpdatedAt(null);
    adsRenderChecklist();
    adsAtualizarBotaoSalvar();
    return;
  }

  const loja = adsGetLojaCampanha();
  adsSetSaveStatus("Carregando...", "ads-save-loading");

  try {
    const params = new URLSearchParams({ clienteSlug, mes, lojaCampanha: loja });
    const res  = await adsFetch(`/ads/acompanhamento?${params}`);
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
  const data = new Date(updatedAt);
  const str  = data.toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  el.textContent  = `Última atualização: ${str}`;
  el.style.display = "block";
}

// ─── Status de salvamento ─────────────────────────────────────────────────────

function adsSetSaveStatus(msg, cls) {
  const el = document.getElementById("ads-save-status");
  if (!el) return;
  el.textContent = msg;
  el.className   = `ads-save-status${cls ? " " + cls : ""}`;
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
  if (btn) { btn.disabled = true; btn.textContent = "Salvando..."; }
  adsSetSaveStatus("Salvando...", "ads-save-loading");

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

// ─── Cards de resumo ──────────────────────────────────────────────────────────

function adsRenderSummary() {
  const grid = document.getElementById("ads-summary-grid");
  if (!grid) return;
  const dados = adsGetDadosFiltrados();

  const totalInv  = dados.reduce((a, d) => a + d.investimentoAds, 0);
  const totalGmv  = dados.reduce((a, d) => a + d.gmvAds, 0);
  const roasVals  = dados.map((d) => d.roas).filter((v) => v > 0);
  const roasMed   = roasVals.length ? roasVals.reduce((a, b) => a + b, 0) / roasVals.length : 0;
  const totalFat  = dados.reduce((a, d) => a + d.faturamentoTotal, 0);
  const tacosVals = dados.map((d) => d.tacos).filter((v) => v > 0);
  const tacosMed  = tacosVals.length ? tacosVals.reduce((a, b) => a + b, 0) / tacosVals.length : 0;

  const cards = [
    {
      label: "Investimento Ads",
      value: adsFmtBRL(totalInv),
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
      accent: "ads",
    },
    {
      label: "GMV Ads",
      value: adsFmtBRL(totalGmv),
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>`,
      accent: "ads",
    },
    {
      label: "ROAS médio",
      value: adsFmtNum(roasMed) + "x",
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>`,
      accent: "purple",
    },
    {
      label: "Faturamento Total",
      value: adsFmtBRL(totalFat),
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H6"/></svg>`,
      accent: "purple",
    },
    {
      label: "TACOS médio",
      value: adsFmtPct(tacosMed),
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73L13 2.27a2 2 0 0 0-2 0L4 6.27A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`,
      accent: tacosMed > 5 ? "danger" : tacosMed > 4 ? "warning" : "success",
    },
    {
      label: "Feedbacks enviados",
      value: String(dados.length * 4),
      icon: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
      accent: "neutral",
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

// ─── Tabela mensal ────────────────────────────────────────────────────────────

function adsRenderTabela() {
  const tbody = document.getElementById("ads-table-body");
  const badge = document.getElementById("ads-table-total");
  if (!tbody) return;

  const dados = adsGetDadosFiltrados();
  if (badge) { badge.textContent = String(dados.length); badge.style.display = "inline-block"; }

  if (!dados.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:2rem;color:var(--vf-text-m);">Nenhum dado para o filtro selecionado.</td></tr>`;
    return;
  }

  tbody.innerHTML = dados.map((d) => {
    const st = adsStatusTacos(d.tacos);
    const roasClass = d.roas >= 20 ? "ads-num-good" : d.roas >= 15 ? "" : "ads-num-warn";
    return `
      <tr>
        <td class="ads-td-mes"><strong>${adsEscape(d.label)}</strong></td>
        <td class="num ads-td-inv">${adsEscape(adsFmtBRL(d.investimentoAds))}</td>
        <td class="num">${adsEscape(adsFmtBRL(d.gmvAds))}</td>
        <td class="num ${roasClass}">${adsEscape(adsFmtNum(d.roas))}x</td>
        <td class="num">${adsEscape(adsFmtBRL(d.faturamentoTotal))}</td>
        <td class="num">
          <span>${adsEscape(adsFmtBRL(d.canceladosValor))}</span>
          ${d.canceladosPct > 0 ? `<span class="ads-td-pct">${adsEscape(adsFmtPct(d.canceladosPct))}</span>` : ""}
        </td>
        <td class="num">${adsEscape(adsFmtBRL(d.devolvidosValor))}</td>
        <td class="num"><strong>${adsEscape(adsFmtPct(d.tacos))}</strong></td>
        <td class="center"><span class="ads-badge ${adsEscape(st.cls)}">${adsEscape(st.label)}</span></td>
      </tr>`;
  }).join("");
}

// ─── Checklist semanal ────────────────────────────────────────────────────────

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
  const dados = adsGetDadosFiltrados();

  if (!dados.length) {
    const ta = document.getElementById("ads-feedback-textarea");
    if (ta) ta.value = "Nenhum dado disponível para o período selecionado.";
    ADS_FEEDBACK_ATUAL = ta ? ta.value : "";
    ADS_HAS_UNSAVED_CHANGES = true;
    adsAtualizarSaveStatus();
    return;
  }

  const d        = dados.length === 1 ? dados[0] : null;
  const mesLabel = d ? d.label : "período selecionado";

  const totalInv = dados.reduce((a, v) => a + v.investimentoAds, 0);
  const totalGmv = dados.reduce((a, v) => a + v.gmvAds, 0);
  const totalFat = dados.reduce((a, v) => a + v.faturamentoTotal, 0);
  const roasMed  = dados.reduce((a, v) => a + v.roas, 0) / dados.length;
  const tacosMed = dados.reduce((a, v) => a + v.tacos, 0) / dados.length;
  const st       = adsStatusTacos(tacosMed);

  const linhas = [
    `📊 Relatório de Mercado Ads — ${mesLabel}`,
    ``,
    `💰 Investimento em Ads: ${adsFmtBRL(totalInv)}`,
    `📈 GMV gerado pelos Ads: ${adsFmtBRL(totalGmv)}`,
    `🔁 ROAS médio: ${adsFmtNum(roasMed)}x`,
    `🏪 Faturamento total da loja: ${adsFmtBRL(totalFat)}`,
    `📌 TACOS médio: ${adsFmtPct(tacosMed)} (${st.label})`,
    ``,
    `✅ Análise:`,
  ];

  if (tacosMed <= 4) {
    linhas.push(`Os investimentos em Ads estão bem calibrados. O TACOS de ${adsFmtPct(tacosMed)} está dentro da faixa saudável (até 4%), indicando boa eficiência de custo.`);
  } else if (tacosMed <= 5) {
    linhas.push(`O TACOS de ${adsFmtPct(tacosMed)} está em zona de atenção. Recomendamos revisão das campanhas de menor ROAS para otimizar o retorno.`);
  } else {
    linhas.push(`O TACOS de ${adsFmtPct(tacosMed)} está acima do ideal. É importante revisar os lances e pausar campanhas com ROAS abaixo de 10x para reduzir o custo proporcional.`);
  }

  linhas.push(``, `📌 Próximos passos:`);
  linhas.push(`- Revisar campanhas com ROAS abaixo da média`);
  linhas.push(`- Acompanhar evolução dos cancelados e devolvidos`);
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
  // Campanhas (mockadas)
  const selCamp = document.getElementById("ads-filtro-campanha");
  if (selCamp) {
    selCamp.innerHTML = ADS_CAMPANHAS.map((c, i) =>
      `<option value="${i === 0 ? "" : c}">${adsEscape(c)}</option>`
    ).join("");
  }

  // Período do checklist
  const periodEl = document.getElementById("ads-checklist-period");
  if (periodEl) {
    const now = new Date();
    periodEl.textContent = now.toLocaleDateString("pt-BR", { month: "short", year: "numeric" })
      .replace(/^\w/, (c) => c.toUpperCase());
  }

  // Cliente: populado por adsCarregarClientes() via fetch
}

// ─── Render completo (performance mockada) ────────────────────────────────────

function adsRender() {
  adsRenderSummary();
  adsRenderTabela();
  adsRenderChecklist();
}

// ─── Event listeners ─────────────────────────────────────────────────────────

document.getElementById("ads-btn-atualizar")?.addEventListener("click", () => {
  adsRender();
  adsCarregarAcompanhamento();
});
document.getElementById("ads-filtro-mes")?.addEventListener("change", () => {
  adsRender();
  adsCarregarAcompanhamento();
});
document.getElementById("ads-filtro-cliente")?.addEventListener("change", () => {
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
adsRender();
adsCarregarClientes();
