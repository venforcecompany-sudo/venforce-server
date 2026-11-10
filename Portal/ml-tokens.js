const STORAGE_KEY = "vf-token";
const API_BASE = "https://venforce-server.onrender.com";

function getToken() {
  const t = localStorage.getItem(STORAGE_KEY);
  if (!t) { window.location.replace("index.html"); return null; }
  return t;
}
const TOKEN = getToken();

const user = JSON.parse(localStorage.getItem("vf-user") || "{}");
if (user.role !== "admin") window.location.replace("painel-contas.html");
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
  return dt.toLocaleString("pt-BR");
}

function deriveConnectionStatus(row) {
  const tokenStatus = String(row.token_status || "").trim().toLowerCase();
  if (["error", "invalid", "expired", "revoked"].includes(tokenStatus)) {
    return { key: "erro", label: "Requer revisão", tier: "err" };
  }
  if (!row.has_access_token && !row.has_refresh_token) {
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

// Área dev-admin explícita (ver server/controllers/mlController.js
// revelarCredenciaisGrantController): esta tela é admin-only (checado no
// topo do arquivo) e pode revelar access_token/refresh_token sob demanda,
// mas nunca por padrão — mascarado até o clique, nunca em localStorage/
// sessionStorage, cache só em memória (CRED_CACHE) e perdido ao recarregar.
const CRED_CACHE = new Map(); // tokenId -> { access_token, refresh_token }
const CRED_REVEALED = new Set(); // `${tokenId}:${campo}`

async function fetchCredenciais(tokenId) {
  if (CRED_CACHE.has(tokenId)) return CRED_CACHE.get(tokenId);
  const res = await fetch(`${API_BASE}/admin/ml-tokens/${tokenId}/credentials`, {
    headers: { Authorization: "Bearer " + TOKEN },
  });
  if (res.status === 401) { clearSession(); throw new Error("Sessão expirada."); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.erro || `HTTP ${res.status}`);
  }
  const data = await res.json();
  const creds = { access_token: data.access_token || "", refresh_token: data.refresh_token || "" };
  CRED_CACHE.set(tokenId, creds);
  return creds;
}

function credentialFieldHtml(row, campo, label) {
  const has = campo === "access_token" ? row.has_access_token : row.has_refresh_token;
  if (!has) return `<div class="vf-mlt-action-muted">${label}: sem credencial</div>`;

  const key = `${row.id}:${campo}`;
  const cache = CRED_CACHE.get(row.id);
  const revelado = CRED_REVEALED.has(key) && cache;

  if (revelado) {
    const valor = cache[campo] || "";
    return `
      <div class="vf-mlt-cred-row" data-token-id="${row.id}" data-campo="${campo}">
        <span class="vf-mlt-mono" style="word-break:break-all;">${escapeHTML(valor)}</span>
        <button type="button" class="vf-mlt-copy-btn" data-cred-action="ocultar">Ocultar</button>
        <button type="button" class="vf-mlt-copy-btn" data-cred-action="copiar">Copiar</button>
      </div>`;
  }

  return `
    <div class="vf-mlt-cred-row" data-token-id="${row.id}" data-campo="${campo}">
      <span class="vf-mlt-mask">${label}: ••••••••</span>
      <button type="button" class="vf-mlt-copy-btn" data-cred-action="revelar">Revelar</button>
    </div>`;
}

function credentialsCellHtml(row) {
  return `<div class="vf-mlt-actions" aria-label="Credenciais">
    ${credentialFieldHtml(row, "access_token", "Access")}
    ${credentialFieldHtml(row, "refresh_token", "Refresh")}
  </div>`;
}

function rerenderCredentialsCell(tokenId) {
  const row = allTokens.find((t) => t.id === tokenId);
  const cell = document.getElementById(`mlt-cred-${tokenId}`);
  if (!row || !cell) return;
  cell.innerHTML = credentialsCellHtml(row);
}

tokensTbody?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-cred-action]");
  if (!btn) return;
  const wrap = btn.closest("[data-token-id]");
  if (!wrap) return;
  const tokenId = Number(wrap.getAttribute("data-token-id"));
  const campo = wrap.getAttribute("data-campo");
  const acao = btn.getAttribute("data-cred-action");
  const key = `${tokenId}:${campo}`;

  if (acao === "revelar") {
    btn.disabled = true;
    btn.textContent = "Carregando…";
    try {
      await fetchCredenciais(tokenId);
      CRED_REVEALED.add(key);
      rerenderCredentialsCell(tokenId);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Revelar";
      vfAvisar("Não foi possível revelar", err.message);
    }
    return;
  }

  if (acao === "ocultar") {
    CRED_REVEALED.delete(key);
    rerenderCredentialsCell(tokenId);
    return;
  }

  if (acao === "copiar") {
    const cache = CRED_CACHE.get(tokenId);
    const valor = cache ? cache[campo] : "";
    if (!valor) return;
    try {
      await navigator.clipboard.writeText(valor);
      const prev = btn.textContent;
      btn.textContent = "Copiado!";
      btn.classList.add("vf-mlt-copy-done-state");
      setTimeout(() => {
        btn.textContent = prev;
        btn.classList.remove("vf-mlt-copy-done-state");
      }, 1500);
    } catch {
      vfAvisar("Não foi possível copiar para a área de transferência.");
    }
  }
});

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
    if (res.status === 403) { window.location.replace("painel-contas.html"); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const tokens = Array.isArray(data.tokens) ? data.tokens : [];
    renderTokens(tokens);
  } catch {
    showError("Não foi possível carregar os tokens. Tente novamente.");
  }
}

function renderTokens(tokens) {
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

    const searchBlob = [
      row.cliente_nome,
      row.cliente_slug,
      row.cliente_conta_nome,
      row.cliente_conta_slug,
      row.ml_user_id,
      st.label,
      st.key,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    const contaHtml = row.cliente_conta_nome
      ? `${escapeHTML(row.cliente_conta_nome)}${row.is_primary ? ' <span class="vf-mlt-badge vf-mlt-badge--ok">Principal</span>' : ""}`
      : `<span class="vf-mlt-action-muted">Conta não definida${row.is_primary ? " · principal" : ""}</span>`;

    const tr = document.createElement("tr");
    tr.classList.add("animate-fade-up");
    tr.style.animationDelay = `${i * 0.03}s`;
    tr.setAttribute("data-mlt-status", st.key);
    tr.setAttribute("data-mlt-search", searchBlob);
    tr.innerHTML = `
      <td class="vf-mlt-td-cliente"><strong>${escapeHTML(row.cliente_nome || "—")}</strong></td>
      <td class="vf-mlt-td-slug vf-mlt-mono">${escapeHTML(row.cliente_slug || "—")}</td>
      <td class="vf-mlt-td-conta">${contaHtml}</td>
      <td class="vf-mlt-td-ml vf-mlt-mono">${escapeHTML(String(row.ml_user_id ?? "—"))}</td>
      <td class="vf-mlt-td-status">${statusBadgeHtml(st)}${row.refresh_failures ? `<div class="vf-mlt-action-muted">${row.refresh_failures}x falha de refresh</div>` : ""}</td>
      <td class="vf-mlt-td-exp"><span class="vf-mlt-date">${escapeHTML(expStr)}</span></td>
      <td class="vf-mlt-td-upd"><span class="vf-mlt-date">${escapeHTML(updatedAt)}</span></td>
      <td class="vf-mlt-td-act" id="mlt-cred-${row.id}">${credentialsCellHtml(row)}</td>
    `;
    tokensTbody.appendChild(tr);
  });

  applyRowFilters();
  showTable();
}

document.getElementById("btn-recarregar").addEventListener("click", loadMlTokens);
document.getElementById("btn-retry").addEventListener("click", loadMlTokens);

if (mltFilterQ) mltFilterQ.addEventListener("input", scheduleFilter);
if (mltFilterStatus) mltFilterStatus.addEventListener("change", applyRowFilters);

if (TOKEN) loadMlTokens();


// ── Confirmação e aviso da Fundação (Portal/vf-ui.js) ──────────────────────
// Modal e toast da V2 no lugar de confirm()/alert() do navegador. Sem o
// vf-ui.js (página antiga em cache, sandbox de teste) cai no nativo, com o
// mesmo texto.
function vfConfirmar(opcoes) {
  if (window.VF && typeof window.VF.confirm === "function") return window.VF.confirm(opcoes);
  return Promise.resolve(window.confirm([opcoes.title, opcoes.message].filter(Boolean).join("\n\n")));
}

function vfAvisar(titulo, descricao, tom) {
  if (window.VF && typeof window.VF.toast === "function") {
    window.VF.toast({ title: titulo, description: descricao, tone: tom || "danger" });
    return;
  }
  window.alert(descricao ? titulo + "\n\n" + descricao : titulo);
}
