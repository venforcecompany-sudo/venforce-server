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

function parseDetalhes(raw) {
  if (raw == null || raw === "") return "—";
  if (typeof raw === "object") return JSON.stringify(raw, null, 2);
  try {
    return JSON.stringify(JSON.parse(String(raw)), null, 2);
  } catch {
    return String(raw);
  }
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

function ajustarFiltrosEColunas() {
  const baseWrap = document.getElementById("filter-base")?.closest(".vf-form-group");
  if (baseWrap) {
    baseWrap.innerHTML = `
      <label for="filter-acao">Ação</label>
      <input type="text" id="filter-acao" class="vf-input" placeholder="Ex.: admin.usuario">
    `;
  }

  const statusSelect = document.getElementById("filter-status");
  if (statusSelect) {
    statusSelect.innerHTML = `
      <option value="">Todos</option>
      <option value="sucesso">Sucesso</option>
      <option value="falha">Falha</option>
    `;
  }

  const tableHeadRow = document.querySelector(".vf-table thead tr");
  if (tableHeadRow) {
    tableHeadRow.innerHTML = `
      <th style="width:190px;">Data</th>
      <th style="width:220px;">Usuário</th>
      <th style="width:180px;">Ação</th>
      <th style="width:120px;text-align:center;">Status</th>
      <th style="width:150px;">IP</th>
      <th>Detalhes</th>
    `;
  }
}

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
  const acaoPrefix = document.getElementById("filter-acao")?.value || "";
  const status = document.getElementById("filter-status").value || "";
  const de = document.getElementById("filter-de").value || "";
  const ate = document.getElementById("filter-ate").value || "";
  return { acaoPrefix, status, de, ate };
}

async function loadAtividade(page) {
  if (!TOKEN) return;
  showLoading();

  const { acaoPrefix, status, de, ate } = getFilters();
  const qs = new URLSearchParams();
  if (acaoPrefix) qs.set("acao_prefix", acaoPrefix);
  if (status) qs.set("status", status);
  if (de) qs.set("de", de);
  if (ate) qs.set("ate", ate);
  qs.set("page", String(page || 1));

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
    const usuario = l.user_nome || l.user_email || "—";
    const acao = l.acao || "—";
    const statusRaw = (l.status || "").toLowerCase();
    const ip = l.ip || "—";
    const detalhes = parseDetalhes(l.detalhes);

    const statusHtml = statusRaw === "sucesso"
      ? `<span class="base-status--active">sucesso</span>`
      : `<span style="display:inline-flex;align-items:center;gap:.4rem;font-size:.8125rem;font-weight:500;color:var(--vf-danger);">
           <span style="width:6px;height:6px;border-radius:50%;background:var(--vf-danger);flex-shrink:0;"></span>
           falha
         </span>`;

    const tr = document.createElement("tr");
    tr.classList.add("animate-fade-up");
    tr.style.animationDelay = `${i * 0.03}s`;
    tr.innerHTML = `
      <td style="color:var(--vf-text-m);font-size:.875rem;">${escapeHTML(when)}</td>
      <td><strong>${escapeHTML(usuario)}</strong></td>
      <td style="color:var(--vf-text-m);font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(acao)}</td>
      <td style="text-align:center;">${statusHtml}</td>
      <td style="color:var(--vf-text-m);font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(ip)}</td>
      <td><pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-family:var(--vf-mono);font-size:.75rem;color:var(--vf-text-m);">${escapeHTML(detalhes)}</pre></td>
    `;
    tbody.appendChild(tr);
  });

  pageText.textContent = `Página ${page} de ${meta?.totalPages || 1}`;
  btnPrev.disabled = page <= 1 || meta?.hasPrev === false;
  btnNext.disabled = meta?.hasNext === false;
  showTable();
}

document.getElementById("btn-filtrar").addEventListener("click", () => {
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

if (TOKEN) {
  ajustarFiltrosEColunas();
  loadAtividade(currentPage);
}
