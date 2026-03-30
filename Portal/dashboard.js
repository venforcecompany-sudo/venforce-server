const STORAGE_KEY = "vf-token";
const API_BASE = "https://venforce-server.onrender.com";

// ─── DOM ───
const btnLogout     = document.getElementById("btn-logout");
const btnRetry      = document.getElementById("btn-retry");
const basesCount    = document.getElementById("bases-count");
const basesTbody    = document.getElementById("bases-tbody");
const stateLoading  = document.getElementById("state-loading");
const stateTable    = document.getElementById("state-table");
const stateEmpty    = document.getElementById("state-empty");
const stateError    = document.getElementById("state-error");
const errorMessage  = document.getElementById("error-message");

// ─── Sessão ───
function getTokenOrRedirect() {
  const token = localStorage.getItem(STORAGE_KEY);
  if (!token) { window.location.replace("index.html"); return null; }
  return token;
}

const TOKEN = getTokenOrRedirect();

function clearSessionAndGoLogin() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("vf-user");
  window.location.replace("index.html");
}

// Preenche nome do usuário logado na navbar (se tiver o elemento)
const userNameEl = document.getElementById("user-name");
if (userNameEl) {
  try {
    const user = JSON.parse(localStorage.getItem("vf-user") || "{}");
    userNameEl.textContent = user.nome || user.email || "";
  } catch {}
}

// ─── Estados da UI ───
function showLoading() {
  stateLoading.style.display = "flex";
  stateTable.style.display   = "none";
  stateEmpty.style.display   = "none";
  stateError.style.display   = "none";
}
function showTable() {
  stateLoading.style.display = "none";
  stateTable.style.display   = "block";
  stateEmpty.style.display   = "none";
  stateError.style.display   = "none";
}
function showEmpty() {
  stateLoading.style.display = "none";
  stateTable.style.display   = "none";
  stateEmpty.style.display   = "block";
  stateError.style.display   = "none";
  basesCount.style.display   = "none";
}
function showError(message) {
  stateLoading.style.display = "none";
  stateTable.style.display   = "none";
  stateEmpty.style.display   = "none";
  stateError.style.display   = "block";
  errorMessage.textContent   = message;
}

// ─── Bases ───
async function loadBases() {
  if (!TOKEN) return;
  showLoading();

  try {
    const response = await fetch(`${API_BASE}/bases`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    if (response.status === 401) { clearSessionAndGoLogin(); return; }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const result = await response.json();
    const bases = result.bases;

    if (!Array.isArray(bases)) {
      showError("Resposta inválida da API.");
      return;
    }

    renderBases(bases);
  } catch (err) {
    console.error("Erro ao carregar bases:", err);
    showError("Não foi possível carregar as bases. Tente novamente.");
  }
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderBases(bases) {
  basesTbody.innerHTML = "";

  if (!bases.length) { showEmpty(); return; }

  basesCount.textContent     = String(bases.length);
  basesCount.style.display   = "inline-block";

  bases.forEach((base, index) => {
    const tr = document.createElement("tr");
    tr.classList.add("animate-fade-up");
    tr.style.animationDelay = `${index * 0.04}s`;

    // ← usa base.ativo (não base.ativa) e base.slug como ID
    const ativo       = base.ativo !== false;
    const statusLabel = ativo ? "Ativa" : "Inativa";
    const statusClass = ativo ? "base-status--active" : "base-status--inactive";

    tr.innerHTML = `
      <td style="color:var(--vf-text-l);font-family:var(--vf-mono);font-size:.8rem;">
        ${String(index + 1).padStart(2, "0")}
      </td>
      <td><strong>${escapeHTML(base.nome || "—")}</strong></td>
      <td style="color:var(--vf-text-m);font-size:.875rem;font-family:var(--vf-mono);">
        ${escapeHTML(base.slug || "—")}
      </td>
      <td style="text-align:center;">
        <span class="${statusClass}">${statusLabel}</span>
      </td>
      <td style="text-align:center;">
        <button
          class="vf-btn-danger-sm"
          data-slug="${escapeHTML(base.slug)}"
          data-nome="${escapeHTML(base.nome || base.slug)}"
        >Excluir</button>
      </td>
    `;

    basesTbody.appendChild(tr);
  });

  // Eventos dos botões de excluir
  basesTbody.querySelectorAll(".vf-btn-danger-sm").forEach(btn => {
    btn.addEventListener("click", () => {
      const slug = btn.dataset.slug;
      const nome = btn.dataset.nome;
      if (confirm(`Excluir permanentemente a base "${nome}"?\n\nEsta ação não pode ser desfeita.`)) {
        deleteBase(slug);
      }
    });
  });

  showTable();
}

async function deleteBase(slug) {
  try {
    const response = await fetch(`${API_BASE}/bases/${encodeURIComponent(slug)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    if (response.status === 401) { clearSessionAndGoLogin(); return; }

    const data = await response.json();
    if (!response.ok) throw new Error(data.erro || `HTTP ${response.status}`);

    loadBases(); // recarrega a lista
  } catch (err) {
    alert("Erro ao excluir base: " + err.message);
  }
}

// ─── Usuários (seção separada, se existir na página) ───
const usersTbody = document.getElementById("users-tbody");
const usersCount = document.getElementById("users-count");

async function loadUsers() {
  if (!usersTbody) return;

  try {
    const response = await fetch(`${API_BASE}/admin/users`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    if (response.status === 401) { clearSessionAndGoLogin(); return; }
    if (!response.ok) return;

    const result = await response.json();
    const users = result.users || [];

    if (usersCount) {
      usersCount.textContent   = String(users.length);
      usersCount.style.display = "inline-block";
    }

    usersTbody.innerHTML = "";
    users.forEach((user, index) => {
      const tr = document.createElement("tr");
      const ativo = user.ativo !== false;
      tr.innerHTML = `
        <td style="font-family:var(--vf-mono);font-size:.8rem;">${String(index + 1).padStart(2, "0")}</td>
        <td><strong>${escapeHTML(user.nome || "—")}</strong></td>
        <td style="font-size:.875rem;">${escapeHTML(user.email)}</td>
        <td style="text-align:center;">
          <span class="${ativo ? "base-status--active" : "base-status--inactive"}">${ativo ? "Ativo" : "Inativo"}</span>
        </td>
        <td style="font-size:.8rem;font-family:var(--vf-mono);">${escapeHTML(user.role || "user")}</td>
      `;
      usersTbody.appendChild(tr);
    });
  } catch (err) {
    console.error("Erro ao carregar usuários:", err);
  }
}

// ─── Ações ───
btnLogout.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("vf-user");
  window.location.replace("index.html");
});

btnRetry.addEventListener("click", () => loadBases());

// ─── Init ───
if (TOKEN) {
  loadBases();
  loadUsers();
}
