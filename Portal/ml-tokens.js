const STORAGE_KEY = "vf-token";
const API_BASE = "https://venforce-server.onrender.com";

function getToken() {
  const t = localStorage.getItem(STORAGE_KEY);
  if (!t) { window.location.replace("index.html"); return null; }
  return t;
}
const TOKEN = getToken();

const user = JSON.parse(localStorage.getItem("vf-user") || "{}");
if (user.role !== "admin") window.location.replace("dashboard.html");
initLayout();

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("vf-user");
  window.location.replace("index.html");
}

function escapeHTML(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

/** Armazena tokens completos só em memória — não vai para atributos HTML */
const tokenCopyStore = new Map();
let copyIdCounter = 0;

function clearCopyStore() {
  tokenCopyStore.clear();
  copyIdCounter = 0;
}

function registerTokenForCopy(full) {
  const k = `c${++copyIdCounter}`;
  tokenCopyStore.set(k, full == null ? "" : String(full));
  return k;
}

function maskToken(tok) {
  const s = String(tok || "");
  if (!s) return "—";
  return `${s.slice(0, 10)}••••••••`;
}

function formatDateTimeBR(value) {
  if (!value) return "—";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "—";
  return dt.toLocaleString("pt-BR");
}

/**
 * Deriva status apenas do payload atual (sem token_status no servidor).
 */
function deriveConnectionStatus(row) {
  const access = String(row.access_token || "").trim();
  const refresh = String(row.refresh_token || "").trim();
  if (!access && !refresh) {
    return { key: "erro", label: "Sem credenciais", tier: "err" };
  }
  const expMs = new Date(row.expires_at).getTime();
  if (Number.isNaN(expMs)) {
    return { key: "desconhecido", label: "Indefinido", tier: "neutral" };
  }
  const now = Date.now();
  const fiveMin = 5 * 60 * 1000;
  if (expMs < now) {
    return { key: "expirado", label: "Expirado", tier: "warn" };
  }
  if (expMs - now < fiveMin) {
    return { key: "expirando", label: "Expirando", tier: "warn" };
  }
  return { key: "ativo", label: "Ativo", tier: "ok" };
}

function statusBadgeHtml(st) {
  const tier = st.tier || "neutral";
  const cls =
    tier === "ok"
      ? "vf-mlt-badge vf-mlt-badge--ok"
      : tier === "warn"
        ? "vf-mlt-badge vf-mlt-badge--warn"
        : tier === "err"
          ? "vf-mlt-badge vf-mlt-badge--err"
          : "vf-mlt-badge vf-mlt-badge--neutral";
  return `<span class="${cls}">${escapeHTML(st.label)}</span>`;
}

function computeSummary(tokens) {
  let active = 0;
  let warn = 0;
  let err = 0;
  const clients = new Set();

  (tokens || []).forEach((row) => {
    if (row.cliente_id != null) clients.add(row.cliente_id);
    const st = deriveConnectionStatus(row);
    if (st.key === "ativo") active++;
    else if (st.key === "expirando" || st.key === "expirado") warn++;
    else if (st.key === "erro") err++;
  });

  return {
    total: (tokens || []).length,
    active,
    warn,
    err,
    clients: clients.size,
  };
}

function updateSummaryCards(tokens) {
  const s = computeSummary(tokens);
  const el = (id) => document.getElementById(id);
  if (el("mlt-sum-total")) el("mlt-sum-total").textContent = String(s.total);
  if (el("mlt-sum-active")) el("mlt-sum-active").textContent = String(s.active);
  if (el("mlt-sum-warn")) el("mlt-sum-warn").textContent = String(s.warn);
  if (el("mlt-sum-err")) el("mlt-sum-err").textContent = String(s.err);
  if (el("mlt-sum-clients")) el("mlt-sum-clients").textContent = String(s.clients);
}

function setSummaryLoading() {
  ["mlt-sum-total", "mlt-sum-active", "mlt-sum-warn", "mlt-sum-err", "mlt-sum-clients"].forEach((id) => {
    const n = document.getElementById(id);
    if (n) n.textContent = "…";
  });
}

let allTokens = [];

const stateLoading = document.getElementById("state-loading");
const stateTable = document.getElementById("state-table");
const stateEmpty = document.getElementById("state-empty");
const stateError = document.getElementById("state-error");
const tokensCount = document.getElementById("tokens-count");
const tokensTbody = document.getElementById("tokens-tbody");
const mltFilterEmpty = document.getElementById("mlt-filter-empty");
const mltFilterQ = document.getElementById("mlt-filter-q");
const mltFilterStatus = document.getElementById("mlt-filter-status");

function showLoading() {
  setSummaryLoading();
  stateLoading.style.display = "flex";
  stateTable.style.display = stateEmpty.style.display = stateError.style.display = "none";
  if (mltFilterEmpty) mltFilterEmpty.style.display = "none";
}
function showTable() {
  stateTable.style.display = "block";
  stateLoading.style.display = stateEmpty.style.display = stateError.style.display = "none";
}
function showEmpty() {
  stateEmpty.style.display = "flex";
  stateLoading.style.display = stateTable.style.display = stateError.style.display = "none";
  tokensCount.style.display = "none";
  updateSummaryCards([]);
  if (mltFilterEmpty) mltFilterEmpty.style.display = "none";
}
function showError(msg) {
  stateError.style.display = "flex";
  stateLoading.style.display = stateTable.style.display = stateEmpty.style.display = "none";
  document.getElementById("error-message").textContent = msg;
  tokensCount.style.display = "none";
  setSummaryLoading();
  if (mltFilterEmpty) mltFilterEmpty.style.display = "none";
}

function bindCopyButtons(root) {
  root.querySelectorAll("button[data-copy-ref]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ref = btn.getAttribute("data-copy-ref");
      const value = ref ? tokenCopyStore.get(ref) : "";
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        const old = btn.innerHTML;
        btn.innerHTML = `<span class="vf-mlt-copy-done">Copiado!</span>`;
        btn.classList.add("vf-mlt-copy-done-state");
        setTimeout(() => {
          btn.innerHTML = old;
          btn.classList.remove("vf-mlt-copy-done-state");
        }, 1000);
      } catch {
        alert("Não foi possível copiar.");
      }
    });
  });
}

function actionsCellHtml(access, refresh) {
  const hasAccess = !!String(access || "").trim();
  const hasRefresh = !!String(refresh || "").trim();
  const accessRef = hasAccess ? registerTokenForCopy(access) : "";
  const refreshRef = hasRefresh ? registerTokenForCopy(refresh) : "";

  const accessBtn = hasAccess
    ? `<button type="button" class="vf-mlt-copy-btn" data-copy-ref="${escapeHTML(accessRef)}" title="Copiar access token">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Access <span class="vf-mlt-mask">${escapeHTML(maskToken(access))}</span>
      </button>`
    : `<span class="vf-mlt-action-muted">Sem access</span>`;

  const refreshBtn = hasRefresh
    ? `<button type="button" class="vf-mlt-copy-btn" data-copy-ref="${escapeHTML(refreshRef)}" title="Copiar refresh token">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Refresh <span class="vf-mlt-mask">${escapeHTML(maskToken(refresh))}</span>
      </button>`
    : `<span class="vf-mlt-action-muted">Sem refresh</span>`;

  return `<div class="vf-mlt-actions">${accessBtn}${refreshBtn}</div>`;
}

function applyRowFilters() {
  const q = (mltFilterQ?.value || "").trim().toLowerCase();
  const stSel = (mltFilterStatus?.value || "").trim();
  const rows = tokensTbody.querySelectorAll("tr[data-mlt-status]");
  let visible = 0;
  rows.forEach((tr) => {
    const statusKey = tr.getAttribute("data-mlt-status") || "";
    const hay = (tr.getAttribute("data-mlt-search") || "").toLowerCase();
    const okStatus = !stSel || statusKey === stSel;
    const okQ = !q || hay.includes(q);
    const show = okStatus && okQ;
    tr.classList.toggle("vf-mlt-row-hidden", !show);
    if (show) visible++;
  });
  if (mltFilterEmpty) {
    mltFilterEmpty.style.display = allTokens.length > 0 && visible === 0 ? "block" : "none";
  }
}

let filterTimer;
function scheduleFilter() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(applyRowFilters, 100);
}

async function loadMlTokens() {
  if (!TOKEN) return;
  showLoading();
  try {
    const res = await fetch(`${API_BASE}/admin/ml-tokens`, {
      headers: { Authorization: "Bearer " + TOKEN }
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const tokens = Array.isArray(data.tokens) ? data.tokens : [];
    renderTokens(tokens);
  } catch {
    showError("Não foi possível carregar os tokens. Tente novamente.");
  }
}

function renderTokens(tokens) {
  clearCopyStore();
  tokensTbody.innerHTML = "";
  allTokens = tokens;

  if (!tokens.length) {
    showEmpty();
    return;
  }

  updateSummaryCards(tokens);

  tokensCount.textContent = String(tokens.length);
  tokensCount.style.display = "inline-block";

  tokens.forEach((row, i) => {
    const st = deriveConnectionStatus(row);
    const expStr = formatDateTimeBR(row.expires_at);
    const updatedAt = formatDateTimeBR(row.updated_at);
    const access = row.access_token || "";
    const refresh = row.refresh_token || "";

    const searchBlob = [
      row.cliente_nome,
      row.cliente_slug,
      row.ml_user_id,
      st.label,
      st.key,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const tr = document.createElement("tr");
    tr.classList.add("animate-fade-up");
    tr.style.animationDelay = `${i * 0.03}s`;
    tr.setAttribute("data-mlt-status", st.key);
    tr.setAttribute("data-mlt-search", searchBlob);
    tr.innerHTML = `
      <td class="vf-mlt-td-cliente"><strong>${escapeHTML(row.cliente_nome || "—")}</strong></td>
      <td class="vf-mlt-td-slug vf-mlt-mono">${escapeHTML(row.cliente_slug || "—")}</td>
      <td class="vf-mlt-td-ml vf-mlt-mono">${escapeHTML(String(row.ml_user_id ?? "—"))}</td>
      <td class="vf-mlt-td-status">${statusBadgeHtml(st)}</td>
      <td class="vf-mlt-td-exp"><span class="vf-mlt-date">${escapeHTML(expStr)}</span></td>
      <td class="vf-mlt-td-upd"><span class="vf-mlt-date">${escapeHTML(updatedAt)}</span></td>
      <td class="vf-mlt-td-act">${actionsCellHtml(access, refresh)}</td>
    `;
    tokensTbody.appendChild(tr);
  });

  bindCopyButtons(tokensTbody);
  applyRowFilters();
  showTable();
}

document.getElementById("btn-recarregar").addEventListener("click", loadMlTokens);
document.getElementById("btn-retry").addEventListener("click", loadMlTokens);

if (mltFilterQ) mltFilterQ.addEventListener("input", scheduleFilter);
if (mltFilterStatus) mltFilterStatus.addEventListener("change", applyRowFilters);

if (TOKEN) loadMlTokens();
