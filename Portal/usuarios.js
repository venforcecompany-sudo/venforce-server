/* ================================================================
   usuarios.js — VenForce · Gestão de Usuários
   ----------------------------------------------------------------
   Exibe usuários separados em 3 seções: Admins, Membros, Sellers.
   Admin pode alterar role (admin/membro/seller) e ativar/remover.
   Role "user" (legado) é exibida como "membro" mas gravada como-está.
   ================================================================ */

const STORAGE_KEY = "vf-token";
const API_BASE    = "https://venforce-server.onrender.com";

function getToken() {
  const t = localStorage.getItem(STORAGE_KEY);
  if (!t) { window.location.replace("index.html"); return null; }
  return t;
}
const TOKEN = getToken();

const self = JSON.parse(localStorage.getItem("vf-user") || "{}");
if (self.role !== "admin") window.location.replace("dashboard.html");
initLayout();

/* ── ESC ─────────────────────────────────────────────────── */
function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

/* ── TOAST ───────────────────────────────────────────────── */
let _toastTimer = null;
function toast(msg, tipo = "ok") {
  const el = document.getElementById("vu-toast");
  if (!el) return;
  el.textContent = msg;
  el.className = `vu-toast vu-toast-${tipo} vu-toast-show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = "vu-toast"; }, 3200);
}

/* ── FEEDBACK INLINE ─────────────────────────────────────── */
function setFeedback(msg, tipo = "neutral") {
  const el = document.getElementById("usuarios-feedback");
  if (!el) return;
  el.classList.remove("show", "vf-alert-success", "vf-alert-danger");
  el.textContent = "";
  if (!msg) return;
  if (tipo === "success") el.classList.add("vf-alert-success");
  if (tipo === "danger")  el.classList.add("vf-alert-danger");
  el.classList.add("show");
  el.textContent = msg;
}

/* ── ESTADOS DA TELA ─────────────────────────────────────── */
function showLoading() {
  document.getElementById("state-loading").style.display = "flex";
  document.getElementById("state-error").style.display   = "none";
  document.getElementById("state-empty").style.display   = "none";
  document.getElementById("vu-sections").style.display   = "none";
}
function showSections() {
  document.getElementById("state-loading").style.display = "none";
  document.getElementById("state-error").style.display   = "none";
  document.getElementById("state-empty").style.display   = "none";
  document.getElementById("vu-sections").style.display   = "block";
}
function showEmpty() {
  document.getElementById("state-loading").style.display = "none";
  document.getElementById("state-error").style.display   = "none";
  document.getElementById("state-empty").style.display   = "block";
  document.getElementById("vu-sections").style.display   = "none";
  const badge = document.getElementById("usuarios-count");
  if (badge) badge.style.display = "none";
}
function showError(msg) {
  document.getElementById("state-loading").style.display = "none";
  document.getElementById("state-error").style.display   = "block";
  document.getElementById("state-empty").style.display   = "none";
  document.getElementById("vu-sections").style.display   = "none";
  const el = document.getElementById("error-message");
  if (el) el.textContent = msg;
  const badge = document.getElementById("usuarios-count");
  if (badge) badge.style.display = "none";
}

/* ── CARREGAR DADOS ──────────────────────────────────────── */
async function loadUsuarios() {
  if (!TOKEN) return;
  showLoading();
  setFeedback("");

  try {
    // Carrega usuários + vínculos seller em paralelo
    const [resU, resV] = await Promise.all([
      fetch(`${API_BASE}/usuarios`, { headers: { Authorization: "Bearer " + TOKEN } }),
      fetch(`${API_BASE}/seller/vinculos`, { headers: { Authorization: "Bearer " + TOKEN } })
        .catch(() => null),
    ]);

    if (resU.status === 401) { clearSession(); return; }
    if (!resU.ok) throw new Error(`HTTP ${resU.status}`);

    const dataU = await resU.json().catch(() => ({}));
    const lista = Array.isArray(dataU.usuarios) ? dataU.usuarios
                : Array.isArray(dataU) ? dataU : [];

    // Mapa userId → lista de vínculos (pode não existir se endpoint retornar erro)
    const vinculoMap = new Map();
    if (resV && resV.ok) {
      const dataV = await resV.json().catch(() => ({}));
      (dataV.vinculos || []).forEach(v => {
        const uid = v.user?.id;
        if (!uid) return;
        if (!vinculoMap.has(uid)) vinculoMap.set(uid, []);
        vinculoMap.get(uid).push(v);
      });
    }

    renderSections(lista, vinculoMap);
  } catch (err) {
    showError("Não foi possível carregar os usuários. Tente novamente.");
  }
}

/* ── AGRUPAR POR ROLE ────────────────────────────────────── */
function grupoDeRole(role) {
  if (role === "admin")            return "admin";
  if (role === "seller")           return "seller";
  if (role === "shopee_reviewer")  return "shopee_reviewer";
  return "membro"; // inclui "user" legado e "membro"
}

/* ── BADGE DE STATUS ─────────────────────────────────────── */
function statusBadge(ativo) {
  return ativo
    ? `<span class="vf-status-pill vf-status-pill-success">Ativo</span>`
    : `<span class="vf-status-pill vf-status-pill-warning">Inativo</span>`;
}

/* ── BADGE DE ROLE ───────────────────────────────────────── */
function roleBadge(role) {
  const cls = role === "admin"           ? "is-admin"
            : role === "seller"          ? "is-seller"
            : role === "shopee_reviewer" ? "is-shopee"
            : "";
  const label = role === "admin"           ? "admin"
              : role === "seller"          ? "seller"
              : role === "shopee_reviewer" ? "shopee reviewer"
              : "membro";
  return `<span class="vf-role-pill ${cls}">${label}</span>`;
}

/* ── SELECT DE ROLE ──────────────────────────────────────── */
function roleSelect(u) {
  const grupo = grupoDeRole(u.role);
  return `
    <select class="vu-role-select" data-uid="${esc(u.id)}" aria-label="Alterar role de ${esc(u.nome)}">
      <option value="admin"           ${grupo === "admin"           ? "selected" : ""}>Admin</option>
      <option value="membro"          ${grupo === "membro"          ? "selected" : ""}>Membro</option>
      <option value="seller"          ${grupo === "seller"          ? "selected" : ""}>Seller</option>
      <option value="shopee_reviewer" ${grupo === "shopee_reviewer" ? "selected" : ""}>Shopee Reviewer</option>
    </select>`;
}

/* ── CHIP DE VÍNCULO SELLER ──────────────────────────────── */
function vinculoChip(vinculos) {
  if (!vinculos || !vinculos.length) {
    return `<span class="vu-sem-vinculo">sem cliente vinculado</span>`;
  }
  const ativos = vinculos.filter(v => v.ativo);
  if (!ativos.length) {
    return `<span class="vu-sem-vinculo">vínculo inativo</span>`;
  }
  return ativos.map(v =>
    `<span class="vu-vinculo-chip" title="${esc(v.marketplace)}">${esc(v.cliente?.nome || v.cliente?.slug || "—")}</span>`
  ).join(" ");
}

/* ── RENDERIZAR UMA SEÇÃO ────────────────────────────────── */
function renderSecao(grupo, lista, vinculoMap, bodyId, countId) {
  const countEl = document.getElementById(countId);
  const bodyEl  = document.getElementById(bodyId);
  if (!bodyEl) return;

  if (countEl) countEl.textContent = String(lista.length);

  if (!lista.length) {
    bodyEl.innerHTML = `<p class="vu-vazio">Nenhum usuário neste grupo.</p>`;
    return;
  }

  const isSeller = grupo === "seller";

  const cabecalho = isSeller
    ? `<tr>
         <th>Nome</th><th>E-mail</th><th>Vínculo</th>
         <th style="width:90px;">Status</th>
         <th style="width:130px;">Criado em</th>
         <th style="width:210px;">Role / Ações</th>
       </tr>`
    : `<tr>
         <th>Nome</th><th>E-mail</th><th>Role</th>
         <th style="width:90px;">Status</th>
         <th style="width:130px;">Criado em</th>
         <th style="width:210px;">Ações</th>
       </tr>`;

  const linhas = lista.map(u => {
    const id     = u.id ?? u._id ?? u.user_id;
    const nome   = u.nome || "—";
    const email  = u.email || "—";
    const ativo  = u.ativo === true;
    const criado = u.created_at || u.createdAt || u.criado_em;
    const criadoTxt = criado ? new Date(criado).toLocaleDateString("pt-BR") : "—";
    const isSelf = self?.id != null && String(self.id) === String(id);

    const vinculos = vinculoMap.get(id) || null;
    const sellerInfo = isSeller
      ? `<td>${vinculoChip(vinculos)}</td>`
      : `<td>${roleBadge(u.role)}</td>`;

    const toggleLabel = ativo ? "Desativar" : "Ativar";
    const toggleCls   = ativo ? "vf-action-btn" : "vf-action-btn vf-action-btn-secondary";

    return `
      <tr class="animate-fade-up">
        <td><strong>${esc(nome)}</strong></td>
        <td style="color:var(--vf-text-m);">${esc(email)}</td>
        ${sellerInfo}
        <td>${statusBadge(ativo)}</td>
        <td style="color:var(--vf-text-m);font-family:var(--vf-mono);font-size:.78rem;">${esc(criadoTxt)}</td>
        <td>
          <div class="vf-table-actions vu-actions">
            ${roleSelect(u)}
            <button type="button" class="${toggleCls}" data-action="toggle"
                    data-id="${esc(id)}" data-ativo="${ativo ? '1' : '0'}">
              ${toggleLabel}
            </button>
            <button type="button" class="vf-action-btn vf-action-btn-danger" data-action="delete"
                    data-id="${esc(id)}" data-nome="${esc(nome)}" data-email="${esc(email)}"
                    ${isSelf ? "disabled" : ""}>
              Remover
            </button>
          </div>
        </td>
      </tr>`;
  }).join("");

  bodyEl.innerHTML = `
    <div class="vu-table-wrap">
      <table class="vf-table vu-table">
        <thead>${cabecalho}</thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>`;

  // Role select — confirma antes de salvar
  bodyEl.querySelectorAll(".vu-role-select").forEach(sel => {
    const uid = sel.dataset.uid;
    const u   = lista.find(x => String(x.id) === String(uid));
    const grupoAtual = grupoDeRole(u?.role);

    sel.addEventListener("change", () => {
      const novoGrupo = sel.value;
      if (novoGrupo === grupoAtual) return;
      const msg = `Alterar role de ${u?.email || uid} para "${novoGrupo}"?`;
      if (!confirm(msg)) {
        sel.value = grupoAtual; // reverte
        return;
      }
      patchRole(uid, novoGrupo, sel, grupoAtual);
    });
  });

  // Toggle ativo/inativo
  bodyEl.querySelectorAll('button[data-action="toggle"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const id    = btn.getAttribute("data-id");
      const ativo = btn.getAttribute("data-ativo") === "1";
      toggleAtivo(id, ativo, btn);
    });
  });

  // Delete — abre modal
  bodyEl.querySelectorAll('button[data-action="delete"]').forEach(btn => {
    btn.addEventListener("click", () => {
      const id    = btn.getAttribute("data-id");
      const nome  = btn.getAttribute("data-nome");
      const email = btn.getAttribute("data-email");
      if (!id || (self?.id != null && String(self.id) === String(id))) return;
      abrirModalRemoverUsuario({ id, btn, nome, email });
    });
  });
}

/* ── RENDERIZAR AS 4 SEÇÕES ──────────────────────────────── */
function renderSections(lista, vinculoMap) {
  if (!lista.length) { showEmpty(); return; }

  const grupos = { admin: [], membro: [], seller: [], shopee_reviewer: [] };
  lista.forEach(u => {
    const g = grupoDeRole(u.role);
    grupos[g].push(u);
  });

  const total = lista.length;
  const badge = document.getElementById("usuarios-count");
  if (badge) { badge.textContent = String(total); badge.style.display = "inline-block"; }

  renderSecao("admin",           grupos.admin,           vinculoMap, "vu-body-admin",  "vu-count-admin");
  renderSecao("membro",          grupos.membro,          vinculoMap, "vu-body-membro", "vu-count-membro");
  renderSecao("seller",          grupos.seller,          vinculoMap, "vu-body-seller", "vu-count-seller");
  renderSecao("shopee_reviewer", grupos.shopee_reviewer, vinculoMap, "vu-body-shopee", "vu-count-shopee");

  showSections();
}

/* ── PATCH ROLE ──────────────────────────────────────────── */
async function patchRole(id, novaRole, selectEl, grupoOriginal) {
  selectEl.disabled = true;

  try {
    const res  = await fetch(`${API_BASE}/usuarios/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ role: novaRole }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);

    toast(`Role atualizada para "${novaRole}" com sucesso.`, "ok");
    loadUsuarios();
  } catch (err) {
    toast(`Erro: ${err.message}`, "danger");
    selectEl.value    = grupoOriginal;
    selectEl.disabled = false;
  }
}

/* ── TOGGLE ATIVO ────────────────────────────────────────── */
async function toggleAtivo(id, ativoAtual, btn) {
  btn.disabled  = true;
  const txtOrig = btn.textContent;
  btn.textContent = "Salvando…";
  try {
    const res = await fetch(`${API_BASE}/usuarios/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ ativo: !ativoAtual }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);
    toast(`Usuário ${!ativoAtual ? "ativado" : "desativado"} com sucesso.`, "ok");
    loadUsuarios();
  } catch (err) {
    toast(`Erro ao salvar: ${err.message}`, "danger");
    btn.disabled  = false;
    btn.textContent = txtOrig;
  }
}

/* ── DELETE ──────────────────────────────────────────────── */
async function deleteUsuario(id, btn) {
  if (self?.id != null && String(self.id) === String(id)) return;
  if (btn) { btn.disabled = true; btn.textContent = "Removendo…"; }
  try {
    const res = await fetch(`${API_BASE}/usuarios/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + TOKEN },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);
    toast("Usuário removido com sucesso.", "ok");
    loadUsuarios();
    return true;
  } catch (err) {
    toast(`Erro ao remover: ${err.message}`, "danger");
    if (btn) { btn.disabled = false; btn.textContent = "Remover"; }
    throw err;
  }
}

/* ── MODAL REMOVER ───────────────────────────────────────── */
let _MODAL_ABERTO = false, _REMOVER_ID = null, _REMOVER_BTN = null;

function abrirModalRemoverUsuario({ id, btn, nome, email }) {
  if (self?.id != null && String(self.id) === String(id)) return;

  _REMOVER_ID  = id;
  _REMOVER_BTN = btn || null;
  _MODAL_ABERTO = true;

  const subtitle = document.getElementById("vf-remover-usuario-subtitle");
  if (subtitle) subtitle.textContent = [nome, email].filter(Boolean).join(" · ") || `ID ${id}`;

  const danger = document.getElementById("vf-remover-usuario-danger");
  if (danger) { danger.style.display = "none"; danger.textContent = ""; }

  const confirmBtn = document.getElementById("vf-remover-usuario-confirm");
  if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = "Remover usuário"; }

  document.getElementById("vf-remover-usuario-modal").style.display = "flex";
}

function fecharModalRemoverUsuario() {
  document.getElementById("vf-remover-usuario-modal").style.display = "none";
  _MODAL_ABERTO = false; _REMOVER_ID = null; _REMOVER_BTN = null;
}

async function confirmarRemocaoUsuario() {
  if (!_REMOVER_ID) return;
  if (self?.id != null && String(self.id) === String(_REMOVER_ID)) return;

  const danger     = document.getElementById("vf-remover-usuario-danger");
  const confirmBtn = document.getElementById("vf-remover-usuario-confirm");
  if (danger) { danger.style.display = "none"; danger.textContent = ""; }
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = "Removendo…"; }

  try {
    await deleteUsuario(_REMOVER_ID, _REMOVER_BTN);
    fecharModalRemoverUsuario();
  } catch (err) {
    const msg = err?.message || "Não foi possível remover o usuário.";
    if (danger) { danger.style.display = "block"; danger.textContent = msg; }
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = "Remover usuário"; }
  }
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("vf-user");
  window.location.replace("index.html");
}

/* ── EVENTOS FIXOS ───────────────────────────────────────── */
document.getElementById("btn-retry")?.addEventListener("click", loadUsuarios);
document.getElementById("vf-remover-usuario-close")?.addEventListener("click", fecharModalRemoverUsuario);
document.getElementById("vf-remover-usuario-cancel")?.addEventListener("click", fecharModalRemoverUsuario);
document.getElementById("vf-remover-usuario-confirm")?.addEventListener("click", confirmarRemocaoUsuario);
document.getElementById("vf-remover-usuario-modal")?.addEventListener("click", e => {
  if (e.target?.id === "vf-remover-usuario-modal") fecharModalRemoverUsuario();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && _MODAL_ABERTO) fecharModalRemoverUsuario();
});

/* ── BOOT ────────────────────────────────────────────────── */
if (TOKEN) loadUsuarios();
