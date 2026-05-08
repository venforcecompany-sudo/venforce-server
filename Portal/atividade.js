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

function formatDateTimeBR(value) {
  if (!value) return "—";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "—";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = dt.getFullYear();
  const hh = String(dt.getHours()).padStart(2, "0");
  const min = String(dt.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

/** Texto único para busca / pré-visualização */
function detalhesPlainText(raw) {
  if (raw == null || raw === "") return "";
  if (typeof raw === "object") return JSON.stringify(raw);
  try {
    return JSON.stringify(JSON.parse(String(raw)));
  } catch {
    return String(raw);
  }
}

/** JSON formatado para bloco expansível */
function detalhesPrettyJson(raw) {
  if (raw == null || raw === "") return "—";
  if (typeof raw === "object") return JSON.stringify(raw, null, 2);
  try {
    return JSON.stringify(JSON.parse(String(raw)), null, 2);
  } catch {
    return String(raw);
  }
}

function truncatePreview(text, maxLen) {
  const t = text || "";
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen).trim() + "…";
}

let currentPage = 1;
let lastLogsLength = 0;

const stateLoading = document.getElementById("state-loading");
const stateTable = document.getElementById("state-table");
const stateEmpty = document.getElementById("state-empty");
const stateError = document.getElementById("state-error");
const tbody = document.getElementById("callbacks-tbody");
const pageText = document.getElementById("page-text");
const btnPrev = document.getElementById("btn-prev");
const btnNext = document.getElementById("btn-next");
const retryBtn = document.getElementById("btn-retry");
const countBadge = document.getElementById("callbacks-count");
const actRefinar = document.getElementById("act-refinar");
const actRefineEmpty = document.getElementById("act-refine-empty");

const elSumTotal = document.getElementById("act-sum-total");
const elSumOk = document.getElementById("act-sum-ok");
const elSumErr = document.getElementById("act-sum-err");
const elSumUsers = document.getElementById("act-sum-users");

function setSummaryLoading() {
  if (elSumTotal) elSumTotal.textContent = "…";
  if (elSumOk) elSumOk.textContent = "…";
  if (elSumErr) elSumErr.textContent = "…";
  if (elSumUsers) elSumUsers.textContent = "…";
}

function updateSummaryFromLogs(logs, totalFromApi) {
  let ok = 0;
  let err = 0;
  const users = new Set();
  (logs || []).forEach((l) => {
    const s = String(l.status || "").toLowerCase();
    if (s === "sucesso") ok++;
    else if (s === "falha") err++;
    const id = (l.user_email || l.user_nome || "").trim();
    if (id) users.add(id);
  });

  const total = Number.isFinite(Number(totalFromApi)) ? Number(totalFromApi) : (logs || []).length;

  if (elSumTotal) elSumTotal.textContent = String(total);
  if (elSumOk) elSumOk.textContent = String(ok);
  if (elSumErr) elSumErr.textContent = String(err);
  if (elSumUsers) elSumUsers.textContent = String(users.size);
}

function resetSummaryDash() {
  if (elSumTotal) elSumTotal.textContent = "—";
  if (elSumOk) elSumOk.textContent = "—";
  if (elSumErr) elSumErr.textContent = "—";
  if (elSumUsers) elSumUsers.textContent = "—";
}

function showLoading() {
  setSummaryLoading();
  stateLoading.style.display = "flex";
  stateTable.style.display = stateEmpty.style.display = stateError.style.display = "none";
  if (actRefineEmpty) actRefineEmpty.style.display = "none";
}
function showTable() {
  stateTable.style.display = "block";
  stateLoading.style.display = stateEmpty.style.display = stateError.style.display = "none";
}
function showEmpty() {
  stateEmpty.style.display = "flex";
  stateLoading.style.display = stateTable.style.display = stateError.style.display = "none";
  countBadge.style.display = "none";
  if (actRefineEmpty) actRefineEmpty.style.display = "none";
}
function showError(msg) {
  stateError.style.display = "flex";
  stateLoading.style.display = stateTable.style.display = stateEmpty.style.display = "none";
  document.getElementById("error-message").textContent = msg;
  countBadge.style.display = "none";
  resetSummaryDash();
  if (actRefineEmpty) actRefineEmpty.style.display = "none";
}

function statusBadgeHtml(statusRaw) {
  const s = String(statusRaw || "").toLowerCase();
  if (s === "sucesso") {
    return `<span class="vf-act-badge vf-act-badge--ok">Sucesso</span>`;
  }
  if (s === "falha") {
    return `<span class="vf-act-badge vf-act-badge--err">Erro</span>`;
  }
  return `<span class="vf-act-badge vf-act-badge--neutral">${escapeHTML(statusRaw || "—")}</span>`;
}

function getFilters() {
  const acaoPrefix = document.getElementById("filter-acao-prefix")?.value?.trim() || "";
  const acaoExata = document.getElementById("filter-acao-exata")?.value?.trim() || "";
  const status = document.getElementById("filter-status")?.value || "";
  const de = document.getElementById("filter-de")?.value || "";
  const ate = document.getElementById("filter-ate")?.value || "";
  const limit = document.getElementById("filter-limit")?.value || "50";
  return { acaoPrefix, acaoExata, status, de, ate, limit };
}

function applyRefineFilter() {
  const q = (actRefinar?.value || "").trim().toLowerCase();
  const rows = tbody.querySelectorAll("tr[data-act-search]");
  let visible = 0;
  rows.forEach((tr) => {
    if (!q) {
      tr.classList.remove("vf-act-row-hidden");
      visible++;
      return;
    }
    const hay = (tr.getAttribute("data-act-search") || "").toLowerCase();
    const match = hay.includes(q);
    tr.classList.toggle("vf-act-row-hidden", !match);
    if (match) visible++;
  });
  if (actRefineEmpty) {
    actRefineEmpty.style.display = lastLogsLength > 0 && visible === 0 ? "block" : "none";
  }
}

let refineTimer;
function scheduleRefine() {
  clearTimeout(refineTimer);
  refineTimer = setTimeout(applyRefineFilter, 120);
}

async function loadAtividade(page) {
  if (!TOKEN) return;
  showLoading();

  const { acaoPrefix, acaoExata, status, de, ate, limit } = getFilters();
  const qs = new URLSearchParams();
  if (acaoExata) qs.set("acao", acaoExata);
  else if (acaoPrefix) qs.set("acao_prefix", acaoPrefix);
  if (status) qs.set("status", status);
  if (de) qs.set("de", de);
  if (ate) qs.set("ate", ate);
  qs.set("page", String(page || 1));
  qs.set("limit", String(limit || "50"));

  try {
    const res = await fetch(`${API_BASE}/admin/logs?${qs.toString()}`, {
      headers: { Authorization: "Bearer " + TOKEN }
    });
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));

    const logs = Array.isArray(data.logs) ? data.logs : [];
    const total = Number(data.total || 0);
    const totalPages = Math.max(Number(data.totalPages || 1), 1);

    renderAtividade(logs, page, { total, hasPrev: page > 1, hasNext: page < totalPages, totalPages });
  } catch {
    showError("Não foi possível carregar os logs de atividade. Tente novamente.");
  }
}

function renderAtividade(logs, page, meta) {
  tbody.innerHTML = "";
  lastLogsLength = logs.length;

  updateSummaryFromLogs(logs, meta?.total);

  if (!logs.length) {
    showEmpty();
    pageText.textContent = `Página ${page}`;
    btnPrev.disabled = page <= 1;
    btnNext.disabled = true;
    return;
  }

  countBadge.textContent = String(meta?.total ?? logs.length);
  countBadge.style.display = "inline-block";

  logs.forEach((l, i) => {
    const when = formatDateTimeBR(l.created_at);
    const nome = l.user_nome || "—";
    const email = l.user_email || "";
    const acao = l.acao || "—";
    const detPlain = detalhesPlainText(l.detalhes);
    const detPretty = detalhesPrettyJson(l.detalhes);
    const preview = truncatePreview(detPlain, 140);
    const hasDetail = detPlain.length > 0;
    const ip = l.ip || "—";

    const searchBlob = [nome, email, acao, detPlain].join(" ").toLowerCase();

    const userCell = email
      ? `<div class="vf-act-user"><strong>${escapeHTML(nome)}</strong><span class="vf-act-user-email">${escapeHTML(email)}</span></div>`
      : `<div class="vf-act-user"><strong>${escapeHTML(nome)}</strong></div>`;

    const detailCell = hasDetail
      ? `<div class="vf-act-detail">
          <p class="vf-act-detail-preview">${escapeHTML(preview)}</p>
          <details class="vf-act-json">
            <summary class="vf-act-json-sum">Ver detalhes</summary>
            <pre class="vf-act-json-pre" tabindex="0">${escapeHTML(detPretty)}</pre>
          </details>
        </div>`
      : `<span class="vf-act-muted">—</span>`;

    const tr = document.createElement("tr");
    tr.classList.add("animate-fade-up");
    tr.style.animationDelay = `${i * 0.03}s`;
    tr.setAttribute("data-act-search", searchBlob);
    tr.innerHTML = `
      <td class="vf-act-td-time">${escapeHTML(when)}</td>
      <td>${userCell}</td>
      <td class="vf-act-mono vf-act-td-action">${escapeHTML(acao)}</td>
      <td class="vf-act-td-status">${statusBadgeHtml(l.status)}</td>
      <td class="vf-act-mono vf-act-td-ip">${escapeHTML(ip)}</td>
      <td class="vf-act-td-detail">${detailCell}</td>
    `;
    tbody.appendChild(tr);
  });

  applyRefineFilter();

  pageText.textContent = `Página ${page} de ${meta?.totalPages || 1}`;
  btnPrev.disabled = page <= 1 || meta?.hasPrev === false;
  btnNext.disabled = meta?.hasNext === false;
  showTable();
}

document.getElementById("btn-filtrar").addEventListener("click", () => {
  currentPage = 1;
  loadAtividade(1);
});

document.getElementById("filter-limit")?.addEventListener("change", () => {
  currentPage = 1;
  loadAtividade(1);
});

btnPrev.addEventListener("click", () => {
  if (currentPage <= 1) return;
  currentPage -= 1;
  loadAtividade(currentPage);
});

btnNext.addEventListener("click", () => {
  currentPage += 1;
  loadAtividade(currentPage);
});

retryBtn.addEventListener("click", () => loadAtividade(currentPage));

if (actRefinar) {
  actRefinar.addEventListener("input", scheduleRefine);
}

if (TOKEN) {
  loadAtividade(currentPage);
}
