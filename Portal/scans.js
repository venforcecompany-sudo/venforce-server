const STORAGE_KEY = "vf-token";
const API_BASE = "https://venforce-server.onrender.com";
initLayout();

function getToken() {
  const t = localStorage.getItem(STORAGE_KEY);
  if (!t) { window.location.replace("index.html"); return null; }
  return t;
}
const TOKEN = getToken();

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

const stateLoading = document.getElementById("state-loading");
const stateTable = document.getElementById("state-table");
const stateEmpty = document.getElementById("state-empty");
const stateError = document.getElementById("state-error");
const tbody = document.getElementById("scans-tbody");
const retryBtn = document.getElementById("btn-retry");
const countBadge = document.getElementById("scans-count");

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

function fmtPct(v) {
  const n = Number(v) || 0;
  return `${n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

function mcBadgeHtml(mcMedio) {
  const n = Number(mcMedio) || 0;
  const txt = fmtPct(n);

  if (n >= 20) {
    return `<span class="base-status--active">${escapeHTML(txt)}</span>`;
  }
  if (n >= 10) {
    return `<span style="display:inline-flex;align-items:center;gap:.4rem;font-size:.8125rem;font-weight:500;color:var(--vf-text-m);">
      <span style="width:6px;height:6px;border-radius:50%;background:#f59e0b;flex-shrink:0;"></span>
      ${escapeHTML(txt)}
    </span>`;
  }
  return `<span style="display:inline-flex;align-items:center;gap:.4rem;font-size:.8125rem;font-weight:500;color:var(--vf-danger);">
    <span style="width:6px;height:6px;border-radius:50%;background:var(--vf-danger);flex-shrink:0;"></span>
    ${escapeHTML(txt)}
  </span>`;
}

async function loadScans() {
  if (!TOKEN) return;
  showLoading();
  try {
    const res = await fetch(`${API_BASE}/scans`, {
      headers: { Authorization: "Bearer " + TOKEN }
    });
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const scans = Array.isArray(data.scans) ? data.scans : (Array.isArray(data) ? data : []);
    renderScans(scans);
  } catch (err) {
    showError("Não foi possível carregar os scans. Tente novamente.");
  }
}

function renderScans(scans) {
  tbody.innerHTML = "";
  if (!scans.length) { showEmpty(); return; }

  countBadge.textContent = String(scans.length);
  countBadge.style.display = "inline-block";

  scans.forEach((s, i) => {
    const when = s.created_at ? new Date(s.created_at).toLocaleString("pt-BR") : "—";
    const contaMl = s.conta_ml || "—";
    const baseSlug = s.base_slug || "—";
    const total = Number(s.total_anuncios ?? 0) || 0;
    const mcMedio = Number(s.mc_medio ?? 0) || 0;
    const saudaveis = Number(s.saudaveis ?? 0) || 0;
    const atencao = Number(s.atencao ?? 0) || 0;
    const criticos = Number(s.criticos ?? 0) || 0;

    const tr = document.createElement("tr");
    tr.classList.add("animate-fade-up");
    tr.style.animationDelay = `${i * 0.03}s`;
    tr.innerHTML = `
      <td style="color:var(--vf-text-l);font-family:var(--vf-mono);font-size:.8rem;">${String(i + 1).padStart(2, "0")}</td>
      <td style="color:var(--vf-text-m);font-size:.875rem;">${escapeHTML(when)}</td>
      <td><strong>${escapeHTML(contaMl)}</strong></td>
      <td style="color:var(--vf-text-m);font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(baseSlug)}</td>
      <td style="text-align:right;color:var(--vf-text-m);font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(total))}</td>
      <td style="text-align:center;">${mcBadgeHtml(mcMedio)}</td>
      <td style="text-align:right;color:var(--vf-text-m);font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(saudaveis))}</td>
      <td style="text-align:right;color:var(--vf-text-m);font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(atencao))}</td>
      <td style="text-align:right;color:var(--vf-text-m);font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(criticos))}</td>
    `;
    tbody.appendChild(tr);
  });

  showTable();
}

retryBtn.addEventListener("click", loadScans);

if (TOKEN) loadScans();

