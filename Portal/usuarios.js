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

const stateLoading = document.getElementById("state-loading");
const stateTable = document.getElementById("state-table");
const stateEmpty = document.getElementById("state-empty");
const stateError = document.getElementById("state-error");
const tbody = document.getElementById("usuarios-tbody");
const countBadge = document.getElementById("usuarios-count");
const usuariosFeedback = document.getElementById("usuarios-feedback");

let MODAL_REMOVER_ABERTO = false;
let REMOVER_USUARIO_ID = null;
let REMOVER_USUARIO_BTN = null;

function setUsuariosFeedback(message, type = "neutral") {
  if (!usuariosFeedback) return;
  usuariosFeedback.classList.remove("show", "vf-alert-success", "vf-alert-danger");
  usuariosFeedback.innerHTML = "";
  if (!message) return;

  const cls = type === "success" ? "vf-alert-success" : (type === "danger" ? "vf-alert-danger" : "");
  if (cls) usuariosFeedback.classList.add(cls);
  usuariosFeedback.classList.add("show");
  usuariosFeedback.textContent = message;
}

function abrirModalRemoverUsuario({ id, btn, nome, email }) {
  const modal = document.getElementById("vf-remover-usuario-modal");
  const subtitle = document.getElementById("vf-remover-usuario-subtitle");
  const danger = document.getElementById("vf-remover-usuario-danger");
  const confirmBtn = document.getElementById("vf-remover-usuario-confirm");
  if (!modal || !confirmBtn) return;

  if (user && user.id != null && String(user.id) === String(id)) return;

  REMOVER_USUARIO_ID = id;
  REMOVER_USUARIO_BTN = btn || null;
  MODAL_REMOVER_ABERTO = true;

  if (subtitle) {
    const sub = [nome, email].filter(Boolean).join(" · ");
    subtitle.textContent = sub || `ID ${id}`;
  }

  if (danger) {
    danger.style.display = "none";
    danger.textContent = "";
  }

  confirmBtn.disabled = false;
  confirmBtn.textContent = "Remover usuário";

  modal.style.display = "flex";
}

function fecharModalRemoverUsuario() {
  const modal = document.getElementById("vf-remover-usuario-modal");
  if (modal) modal.style.display = "none";
  MODAL_REMOVER_ABERTO = false;
  REMOVER_USUARIO_ID = null;
  REMOVER_USUARIO_BTN = null;
}

async function confirmarRemocaoUsuario() {
  const danger = document.getElementById("vf-remover-usuario-danger");
  const confirmBtn = document.getElementById("vf-remover-usuario-confirm");
  if (!REMOVER_USUARIO_ID) return;
  if (user && user.id != null && String(user.id) === String(REMOVER_USUARIO_ID)) return;

  if (danger) {
    danger.style.display = "none";
    danger.textContent = "";
  }

  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Removendo…";
  }

  try {
    await deleteUsuario(REMOVER_USUARIO_ID, REMOVER_USUARIO_BTN);
    fecharModalRemoverUsuario();
  } catch (err) {
    const msg = err?.message || "Não foi possível remover o usuário.";
    if (danger) {
      danger.style.display = "block";
      danger.textContent = msg;
    } else {
      setUsuariosFeedback(msg, "danger");
    }
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Remover usuário";
    }
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

async function loadUsuarios() {
  if (!TOKEN) return;
  showLoading();
  try {
    const res = await fetch(`${API_BASE}/usuarios`, {
      headers: { Authorization: "Bearer " + TOKEN }
    });
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const lista = Array.isArray(data.usuarios) ? data.usuarios : (Array.isArray(data) ? data : []);
    renderUsuarios(lista);
  } catch (err) {
    showError("Não foi possível carregar os usuários. Tente novamente.");
  }
}

function roleBadge(role) {
  const isAdmin = role === "admin";
  const label = isAdmin ? "admin" : "membro";
  return `<span class="vf-role-pill ${isAdmin ? "is-admin" : ""}">${label}</span>`;
}

function statusBadge(ativo) {
  if (ativo) return `<span class="vf-status-pill vf-status-pill-success">Ativo</span>`;
  return `<span class="vf-status-pill vf-status-pill-warning">Pendente</span>`;
}

function renderUsuarios(lista) {
  tbody.innerHTML = "";
  if (!lista.length) { showEmpty(); return; }

  setUsuariosFeedback("");
  countBadge.textContent = String(lista.length);
  countBadge.style.display = "inline-block";

  lista.forEach((u, i) => {
    const id = u.id ?? u._id ?? u.user_id ?? u.usuario_id;
    const nome = u.nome || "—";
    const email = u.email || "—";
    const role = u.role || "membro";
    const ativo = u.ativo === true;
    const createdAt = u.created_at || u.createdAt || u.criado_em || u.criadoEm;
    const createdTxt = createdAt ? new Date(createdAt).toLocaleDateString("pt-BR") : "—";

    const isSelf = (user && (user.id != null) && String(user.id) === String(id));

    const tr = document.createElement("tr");
    tr.classList.add("animate-fade-up");
    tr.style.animationDelay = `${i * 0.04}s`;

    const toggleLabel = ativo ? "Desativar" : "Ativar";
    const toggleClass = ativo ? "vf-action-btn" : "vf-action-btn vf-action-btn-secondary";

    tr.innerHTML = `
      <td style="color:var(--vf-text-l);font-family:var(--vf-mono);font-size:.8rem;">${String(i + 1).padStart(2, "0")}</td>
      <td><strong>${escapeHTML(nome)}</strong></td>
      <td style="color:var(--vf-text-m);">${escapeHTML(email)}</td>
      <td>${roleBadge(role)}</td>
      <td style="text-align:center;">${statusBadge(ativo)}</td>
      <td style="color:var(--vf-text-m);font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(createdTxt)}</td>
      <td style="text-align:center;">
        <div class="vf-table-actions">
          <button type="button" data-action="toggle" data-id="${escapeHTML(id)}" data-ativo="${ativo ? "1" : "0"}"
            class="${toggleClass}">
            ${toggleLabel}
          </button>
          <button type="button" class="vf-action-btn vf-action-btn-danger" data-action="delete" data-id="${escapeHTML(id)}" ${isSelf ? "disabled" : ""}>
            Remover
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('button[data-action="toggle"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const ativoAtual = btn.getAttribute("data-ativo") === "1";
      toggleAtivo(id, ativoAtual, btn);
    });
  });

  tbody.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      if (user && user.id != null && String(user.id) === String(id)) return;
      const tr = btn.closest("tr");
      const nome = tr?.querySelector("td:nth-child(2)")?.textContent?.trim() || "";
      const email = tr?.querySelector("td:nth-child(3)")?.textContent?.trim() || "";
      abrirModalRemoverUsuario({ id, btn, nome, email });
    });
  });

  showTable();
}

async function toggleAtivo(id, ativoAtual, btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "Salvando…";
  try {
    const res = await fetch(`${API_BASE}/usuarios/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + TOKEN
      },
      body: JSON.stringify({ ativo: !ativoAtual })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);
    setUsuariosFeedback(`Usuário ${!ativoAtual ? "ativado" : "desativado"} com sucesso.`, "success");
    loadUsuarios();
  } catch (err) {
    setUsuariosFeedback(`Erro ao salvar: ${err.message}`, "danger");
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function deleteUsuario(id, btn) {
  if (user && user.id != null && String(user.id) === String(id)) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Removendo…";
  }
  try {
    const res = await fetch(`${API_BASE}/usuarios/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + TOKEN }
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);
    setUsuariosFeedback("Usuário removido com sucesso.", "success");
    loadUsuarios();
    return true;
  } catch (err) {
    setUsuariosFeedback(`Erro ao remover: ${err.message}`, "danger");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Remover";
    }
    throw err;
  }
}

document.getElementById("btn-retry").addEventListener("click", loadUsuarios);

document.getElementById("vf-remover-usuario-close")?.addEventListener("click", fecharModalRemoverUsuario);
document.getElementById("vf-remover-usuario-cancel")?.addEventListener("click", fecharModalRemoverUsuario);
document.getElementById("vf-remover-usuario-confirm")?.addEventListener("click", confirmarRemocaoUsuario);
document.getElementById("vf-remover-usuario-modal")?.addEventListener("click", (e) => {
  if (e.target?.id === "vf-remover-usuario-modal") fecharModalRemoverUsuario();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && MODAL_REMOVER_ABERTO) fecharModalRemoverUsuario();
});

if (TOKEN) loadUsuarios();

