const STORAGE_KEY = "vf-token";
const API_BASE = "https://venforce-server.onrender.com";

function getToken() {
  const t = localStorage.getItem(STORAGE_KEY);
  if (!t) { window.location.replace("index.html"); return null; }
  return t;
}
const TOKEN = getToken();
const user = JSON.parse(localStorage.getItem("vf-user") || "{}");
// F5/Bloco F — sem permissão volta para a CARTEIRA, não para
// dashboard.html. O dashboard é uma tela legada, fora da navegação V3 e
// ainda no layout.js: mandar para lá quem esbarrou num 403 dentro do
// Shell V3 troca a sidebar debaixo do usuário e o deixa num lugar de
// onde ele não sabe voltar. A Carteira é a home operacional do V3 e
// trata carteira vazia honestamente (NO_PORTFOLIO).
if (user.role !== "admin") window.location.replace("carteira.html");
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

let currentPage = 1;

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

function showLoading() {
  stateLoading.style.display = "flex";
  stateTable.style.display = stateEmpty.style.display = stateError.style.display = "none";
}
function showTable() {
  stateTable.style.display = "block";
  stateLoading.style.display = stateEmpty.style.display = stateError.style.display = "none";
}
function showEmpty() {
  stateEmpty.style.display = "block";
  stateLoading.style.display = stateTable.style.display = stateError.style.display = "none";
  countBadge.style.display = "none";
}
function showError(msg) {
  stateError.style.display = "block";
  stateLoading.style.display = stateTable.style.display = stateEmpty.style.display = "none";
  document.getElementById("error-message").textContent = msg;
  countBadge.style.display = "none";
}

function getFilters() {
  const base = document.getElementById("filter-base").value || "";
  const status = document.getElementById("filter-status").value || "";
  const de = document.getElementById("filter-de").value || "";
  const ate = document.getElementById("filter-ate").value || "";
  return { base, status, de, ate };
}

async function loadBases() {
  if (!TOKEN) return;
  try {
    const res = await fetch(`${API_BASE}/bases`, { headers: { Authorization: "Bearer " + TOKEN } });
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    const bases = Array.isArray(data.bases) ? data.bases : [];

    const select = document.getElementById("filter-base");
    const current = select.value;
    select.innerHTML = `<option value="">Todas as bases</option>`;
    bases.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b.slug || b.nome || "";
      opt.textContent = b.nome || b.slug || "—";
      select.appendChild(opt);
    });
    select.value = current;
  } catch {
    // silencioso: filtros continuam funcionando sem a lista dinâmica
  }
}

async function loadCallbacks(page) {
  if (!TOKEN) return;
  showLoading();

  const { base, status, de, ate } = getFilters();
  const qs = new URLSearchParams();
  qs.set("base", base);
  qs.set("status", status);
  qs.set("de", de);
  qs.set("ate", ate);
  qs.set("page", String(page || 1));

  try {
    const res = await fetch(`${API_BASE}/callbacks?${qs.toString()}`, {
      headers: { Authorization: "Bearer " + TOKEN }
    });
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));

    const logs = Array.isArray(data.callbacks) ? data.callbacks : (Array.isArray(data.logs) ? data.logs : (Array.isArray(data) ? data : []));
    const pagination = data.pagination || data.paginacao || {};
    const hasNext = Boolean(pagination.hasNext ?? pagination.temProxima ?? (pagination.page && pagination.totalPages ? pagination.page < pagination.totalPages : false));
    const hasPrev = Boolean(pagination.hasPrev ?? pagination.temAnterior ?? (page > 1));

    renderCallbacks(logs, page, { hasNext, hasPrev, total: data.total ?? logs.length });
  } catch (err) {
    showError("Não foi possível carregar os callbacks. Tente novamente.");
  }
}

function renderCallbacks(logs, page, meta) {
  tbody.innerHTML = "";
  if (!logs.length) { showEmpty(); pageText.textContent = `Página ${page}`; btnPrev.disabled = page <= 1; btnNext.disabled = true; return; }

  countBadge.textContent = String(meta?.total ?? logs.length);
  countBadge.style.display = "inline-block";

  logs.forEach((l, i) => {
    const ts = l.ts || l.timestamp || l.created_at || l.createdAt || l.data || l.datetime;
    const when = ts ? new Date(ts).toLocaleString("pt-BR") : "—";
    const base = l.base || l.base_slug || l.baseSlug || l.slug || "—";
    const endpoint = l.endpoint || l.path || l.url || "—";
    const status = Number(l.status || l.http_status || l.httpStatus || 0) || 0;
    const ip = l.ip || l.remote_ip || l.remoteIp || "—";
    const dur = l.duracao_ms ?? l.duration_ms ?? l.durationMs ?? l.ms ?? l.duracao ?? null;
    const durTxt = dur == null ? "—" : `${dur} ms`;

    const ok = status >= 200 && status <= 299;
    const statusHtml = ok
      ? `<span class="vf-status is-success">${status || "2xx"}</span>`
      : `<span class="vf-status is-danger">${status || "—"}</span>`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="vf-mono vf-cb-n">${String((page - 1) * logs.length + (i + 1)).padStart(2, "0")}</td>
      <td class="vf-cb-muted">${escapeHTML(when)}</td>
      <td><strong>${escapeHTML(base)}</strong></td>
      <td class="vf-mono vf-cb-muted">${escapeHTML(endpoint)}</td>
      <td>${statusHtml}</td>
      <td class="vf-mono vf-cb-muted">${escapeHTML(ip)}</td>
      <td class="num vf-cb-muted">${escapeHTML(durTxt)}</td>
    `;
    tbody.appendChild(tr);
  });

  pageText.textContent = `Página ${page}`;
  btnPrev.disabled = page <= 1 || meta?.hasPrev === false;
  btnNext.disabled = meta?.hasNext === false;
  showTable();
}

document.getElementById("btn-filtrar").addEventListener("click", () => {
  currentPage = 1;
  loadCallbacks(1);
});

btnPrev.addEventListener("click", () => {
  if (currentPage <= 1) return;
  currentPage -= 1;
  loadCallbacks(currentPage);
});

btnNext.addEventListener("click", () => {
  currentPage += 1;
  loadCallbacks(currentPage);
});

retryBtn.addEventListener("click", () => loadCallbacks(currentPage));

if (TOKEN) {
  loadBases();
  loadCallbacks(currentPage);
}

