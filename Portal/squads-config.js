/* ================================================================
   squads-config.js — VenForce · Configuração de Squads (admin)
   ----------------------------------------------------------------
   Consome exclusivamente a API /squads/* já existente (backend do
   P2.9). Não cria API paralela. Squad é propriedade do CLIENTE —
   mover cliente de squad nunca toca ClienteConta/Grant/Base/token;
   isso é garantido pelo backend (cliente_squad_history), esta tela
   só chama os endpoints administrativos já auditados/gate-ados.
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
// Admin-only na tela (conveniência de UX) — a segurança real é o
// requireAdmin/requireSquadAdmin do backend em cada endpoint de escrita.
if (self.role !== "admin") window.location.replace("carteira.html");
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
  const el = document.getElementById("sq-toast");
  if (!el) return;
  el.textContent = msg;
  el.className = `sq-toast sq-toast-${tipo} sq-toast-show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = "sq-toast"; }, 3200);
}

/* ── FEEDBACK INLINE ─────────────────────────────────────── */
function setFeedback(msg, tipo = "neutral") {
  const el = document.getElementById("sq-feedback");
  if (!el) return;
  el.className = "vf-banner";
  el.textContent = "";
  if (!msg) { el.hidden = true; return; }
  if (tipo === "success") el.classList.add("is-success");
  if (tipo === "danger")  el.classList.add("is-danger");
  el.hidden = false;
  el.textContent = msg;
}

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("vf-user");
  window.location.replace("index.html");
}

/* ── FETCH HELPER ────────────────────────────────────────── */
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + TOKEN,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { clearSession(); throw new Error("Sessão expirada."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.erro || `HTTP ${res.status}`);
  return data;
}

/* ── ESTADO EM MEMÓRIA ───────────────────────────────────── */
const STATE = {
  squads: [],           // [{id,nome,slug,ativo,membros_ativos,clientes_ativos}]
  membrosPorSquad: {},  // squadId -> membros[]
  clientesPorSquad: {}, // squadId -> clientes[]
  usuarios: null,       // cache de GET /usuarios
  squadAbertoId: null,
};

function isLegado(squad) {
  return String(squad.slug || "").includes("legado");
}

/* ── ESTADOS DA LISTA ────────────────────────────────────── */
function showListLoading() {
  document.getElementById("sq-state-loading").style.display = "flex";
  document.getElementById("sq-state-error").style.display   = "none";
  document.getElementById("sq-list").style.display          = "none";
}
function showListContent() {
  document.getElementById("sq-state-loading").style.display = "none";
  document.getElementById("sq-state-error").style.display   = "none";
  document.getElementById("sq-list").style.display          = "flex";
}
function showListError(msg) {
  document.getElementById("sq-state-loading").style.display = "none";
  document.getElementById("sq-state-error").style.display   = "block";
  document.getElementById("sq-list").style.display          = "none";
  const el = document.getElementById("sq-error-message");
  if (el) el.textContent = msg;
}

/* ── CARREGAR SQUADS ─────────────────────────────────────── */
async function loadSquads() {
  if (!TOKEN) return;
  showListLoading();
  setFeedback("");
  try {
    const data = await api("/squads");
    STATE.squads = Array.isArray(data.squads) ? data.squads : [];

    // Coordenador(es) por squad exige os membros de cada squad — só 7
    // squads, então busca tudo em paralelo e guarda em cache (reaproveitado
    // ao abrir o detalhe, sem refetch).
    await Promise.all(STATE.squads.map(async (s) => {
      try {
        const r = await api(`/squads/${s.id}/membros`);
        STATE.membrosPorSquad[s.id] = Array.isArray(r.membros) ? r.membros : [];
      } catch { STATE.membrosPorSquad[s.id] = []; }
    }));

    renderSquadList();
    const badge = document.getElementById("sq-list-count");
    if (badge) { badge.textContent = String(STATE.squads.length); badge.style.display = "inline-block"; }
    showListContent();

    // Mantém o detalhe aberto sincronizado após qualquer recarga.
    if (STATE.squadAbertoId != null) await abrirSquad(STATE.squadAbertoId, { skipScroll: true });
  } catch (err) {
    showListError("Não foi possível carregar os squads. Tente novamente.");
  }
}

/* ── RENDERIZAR LISTA DE SQUADS ──────────────────────────── */
function renderSquadList() {
  const wrap = document.getElementById("sq-list");
  if (!wrap) return;

  if (!STATE.squads.length) {
    wrap.innerHTML = `<p class="sq-vazio">Nenhum squad cadastrado.</p>`;
    return;
  }

  wrap.innerHTML = STATE.squads.map((s) => {
    const membros = STATE.membrosPorSquad[s.id] || [];
    const coords = membros.filter((m) => m.funcao === "coordenador").map((m) => m.user_nome);
    const coordTxt = coords.length ? coords.join(", ") : "sem coordenador";
    const legadoBadge = isLegado(s) ? `<span class="sq-badge-legado">Legado</span>` : "";
    const inativoTxt = s.ativo === false ? `<span class="sq-row__inativo">(inativo)</span>` : "";
    const selecionado = STATE.squadAbertoId === s.id ? "is-selected" : "";

    return `
      <div class="sq-row ${selecionado}" data-id="${s.id}">
        <div class="sq-row__main">
          <span class="sq-row__nome">${esc(s.nome)}</span>
          ${legadoBadge}
          ${inativoTxt}
        </div>
        <div class="sq-row__stats">
          <span>${s.clientes_ativos ?? 0} clientes</span>
          <span>${s.membros_ativos ?? 0} membros</span>
        </div>
        <div class="sq-row__coord" title="${esc(coordTxt)}">Coordenador(es): ${esc(coordTxt)}</div>
        <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-action="abrir" data-id="${s.id}">
          ${STATE.squadAbertoId === s.id ? "Fechar" : "Abrir"}
        </button>
      </div>`;
  }).join("");

  wrap.querySelectorAll('button[data-action="abrir"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = Number(btn.getAttribute("data-id"));
      if (STATE.squadAbertoId === id) { fecharDetalhe(); return; }
      abrirSquad(id);
    });
  });
}

/* ── ABRIR / FECHAR DETALHE DO SQUAD ─────────────────────── */
async function abrirSquad(squadId, { skipScroll = false } = {}) {
  STATE.squadAbertoId = squadId;
  try {
    const [membrosResp, clientesResp] = await Promise.all([
      api(`/squads/${squadId}/membros`),
      api(`/squads/${squadId}/clientes`),
    ]);
    STATE.membrosPorSquad[squadId]  = Array.isArray(membrosResp.membros) ? membrosResp.membros : [];
    STATE.clientesPorSquad[squadId] = Array.isArray(clientesResp.clientes) ? clientesResp.clientes : [];
  } catch (err) {
    toast(`Erro ao carregar squad: ${err.message}`, "danger");
    return;
  }

  renderSquadList();
  renderDetalhe(squadId);

  const detalhe = document.getElementById("sq-detail");
  detalhe.style.display = "block";
  if (!skipScroll) detalhe.scrollIntoView({ behavior: "smooth", block: "start" });
}

function fecharDetalhe() {
  STATE.squadAbertoId = null;
  document.getElementById("sq-detail").style.display = "none";
  renderSquadList();
}

/* ── RENDERIZAR DETALHE (MEMBROS + CLIENTES) ─────────────── */
function squadPorId(id) {
  return STATE.squads.find((s) => s.id === Number(id));
}

function renderDetalhe(squadId) {
  const squad = squadPorId(squadId);
  if (!squad) return;

  const membros  = STATE.membrosPorSquad[squadId]  || [];
  const clientes = STATE.clientesPorSquad[squadId] || [];
  const principais = membros.filter((m) => m.is_primary).length;

  document.getElementById("sq-detail-title").innerHTML =
    `${esc(squad.nome)} ${isLegado(squad) ? '<span class="sq-badge-legado">Legado</span>' : ""}`;
  document.getElementById("sq-detail-subtitle").textContent =
    `${membros.length} membro(s) · ${principais} com este squad como principal · ${clientes.length} cliente(s)`;

  renderMembrosTable(squadId, membros);
  renderClientesTable(squadId, clientes);
}

function renderMembrosTable(squadId, membros) {
  const wrap = document.getElementById("sq-membros-wrap");
  if (!membros.length) {
    wrap.innerHTML = `<p class="sq-vazio">Nenhum membro neste squad.</p>`;
    return;
  }

  const linhas = membros.map((m) => {
    const principalTxt = m.is_primary
      ? `<span class="sq-star">★ Principal</span>`
      : `<button type="button" class="sq-principal-btn" data-action="principal" data-uid="${m.user_id}" data-nome="${esc(m.user_nome)}">Definir como principal</button>`;

    return `
      <tr>
        <td><strong>${esc(m.user_nome)}</strong></td>
        <td class="vu-cell-muted">${esc(m.user_email || "")}</td>
        <td>
          <select class="vf-select vf-select--sm sq-funcao-select" data-uid="${m.user_id}" data-nome="${esc(m.user_nome)}" aria-label="Função de ${esc(m.user_nome)}">
            <option value="membro" ${m.funcao === "membro" ? "selected" : ""}>Membro</option>
            <option value="coordenador" ${m.funcao === "coordenador" ? "selected" : ""}>Coordenador</option>
          </select>
        </td>
        <td>${principalTxt}</td>
        <td class="sq-col-actions">
          <div class="sq-actions">
            <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-action="remover" data-uid="${m.user_id}" data-nome="${esc(m.user_nome)}">
              Remover
            </button>
          </div>
        </td>
      </tr>`;
  }).join("");

  wrap.innerHTML = `
    <div class="sq-table-wrap">
      <table class="vf-table vf-table--compact sq-table">
        <thead><tr><th>Nome</th><th>E-mail</th><th>Função</th><th>Principal</th><th class="sq-col-actions">Ações</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>`;

  wrap.querySelectorAll(".sq-funcao-select").forEach((sel) => {
    const original = sel.value;
    sel.addEventListener("change", () => {
      const nome = sel.getAttribute("data-nome");
      const nova = sel.value;
      if (!confirm(`Alterar função de ${nome} para "${nova}" no squad?`)) {
        sel.value = original;
        return;
      }
      patchFuncao(squadId, sel.getAttribute("data-uid"), nova, sel, original);
    });
  });

  wrap.querySelectorAll('button[data-action="principal"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid  = btn.getAttribute("data-uid");
      const nome = btn.getAttribute("data-nome");
      const squad = squadPorId(squadId);
      abrirConfirmacao({
        titulo: "Definir squad principal",
        corpo: `Definir ${squad.nome} como principal de ${nome}?`,
        acao: () => patchPrincipal(squadId, uid),
      });
    });
  });

  wrap.querySelectorAll('button[data-action="remover"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const uid  = btn.getAttribute("data-uid");
      const nome = btn.getAttribute("data-nome");
      const squad = squadPorId(squadId);
      abrirConfirmacao({
        titulo: "Remover membro",
        corpo: `Remover ${nome} do ${squad.nome}?`,
        acaoBtnLabel: "Remover",
        acaoBtnClasse: "vf-btn vf-btn--danger",
        acao: () => removerMembro(squadId, uid),
      });
    });
  });
}

function renderClientesTable(squadId, clientes) {
  const wrap = document.getElementById("sq-clientes-wrap");
  if (!clientes.length) {
    wrap.innerHTML = `<p class="sq-vazio">Nenhum cliente neste squad.</p>`;
    return;
  }

  const linhas = clientes.map((c) => `
    <tr>
      <td><strong>${esc(c.nome || c.slug)}</strong></td>
      <td class="vu-cell-muted">${esc(c.slug || "")}</td>
      <td class="sq-col-actions">
        <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-action="mover" data-cid="${c.id}" data-nome="${esc(c.nome || c.slug)}">
          Mover
        </button>
      </td>
    </tr>`).join("");

  wrap.innerHTML = `
    <div class="sq-table-wrap">
      <table class="vf-table vf-table--compact sq-table">
        <thead><tr><th>Cliente</th><th>Slug</th><th class="sq-col-actions">Ações</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>`;

  wrap.querySelectorAll('button[data-action="mover"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      abrirModalMover({
        clienteId: btn.getAttribute("data-cid"),
        clienteNome: btn.getAttribute("data-nome"),
        squadOrigemId: squadId,
      });
    });
  });
}

/* ── PATCH FUNÇÃO ────────────────────────────────────────── */
async function patchFuncao(squadId, userId, funcao, selectEl, funcaoOriginal) {
  selectEl.disabled = true;
  try {
    await api(`/squads/${squadId}/membros/${userId}/funcao`, { method: "PATCH", body: { funcao } });
    toast(`Função atualizada para "${funcao}".`, "ok");
    await recarregarAtual();
  } catch (err) {
    toast(`Erro: ${err.message}`, "danger");
    selectEl.value = funcaoOriginal;
    selectEl.disabled = false;
  }
}

/* ── PATCH PRINCIPAL ─────────────────────────────────────── */
async function patchPrincipal(squadId, userId) {
  await api(`/squads/${squadId}/membros/${userId}/principal`, { method: "PATCH" });
  toast("Squad principal atualizado.", "ok");
  await recarregarAtual();
}

/* ── REMOVER MEMBRO ──────────────────────────────────────── */
async function removerMembro(squadId, userId) {
  await api(`/squads/${squadId}/membros/${userId}`, { method: "DELETE" });
  toast("Membro removido do squad.", "ok");
  await recarregarAtual();
}

async function recarregarAtual() {
  await loadSquads();
}

/* ── MODAL GENÉRICO DE CONFIRMAÇÃO ───────────────────────── */
let _confirmAcao = null;
function abrirConfirmacao({ titulo, corpo, acao, acaoBtnLabel = "Confirmar", acaoBtnClasse = "vf-btn vf-btn--primary" }) {
  document.getElementById("sq-confirm-title").textContent = titulo;
  document.getElementById("sq-confirm-body").textContent  = corpo;
  const danger = document.getElementById("sq-confirm-danger");
  danger.style.display = "none"; danger.textContent = "";
  const okBtn = document.getElementById("sq-confirm-ok");
  okBtn.className = acaoBtnClasse;
  okBtn.textContent = acaoBtnLabel;
  okBtn.disabled = false;
  _confirmAcao = acao;
  document.getElementById("sq-confirm-modal").classList.add("is-open");
  document.body.classList.add("vf-no-scroll");
}
function fecharConfirmacao() {
  document.getElementById("sq-confirm-modal").classList.remove("is-open");
  document.body.classList.remove("vf-no-scroll");
  _confirmAcao = null;
}
async function confirmarAcaoGenerica() {
  if (!_confirmAcao) return;
  const okBtn = document.getElementById("sq-confirm-ok");
  const danger = document.getElementById("sq-confirm-danger");
  okBtn.disabled = true;
  const txtOrig = okBtn.textContent;
  okBtn.textContent = "Salvando…";
  try {
    await _confirmAcao();
    fecharConfirmacao();
  } catch (err) {
    danger.style.display = "block";
    danger.textContent = err.message || "Não foi possível concluir a ação.";
    okBtn.disabled = false;
    okBtn.textContent = txtOrig;
  }
}

/* ── MODAL: ADICIONAR PESSOA ─────────────────────────────── */
async function carregarUsuarios() {
  if (STATE.usuarios) return STATE.usuarios;
  const data = await api("/usuarios");
  const lista = Array.isArray(data.usuarios) ? data.usuarios
              : Array.isArray(data) ? data : [];
  STATE.usuarios = lista;
  return lista;
}

async function abrirModalAdicionarPessoa(squadId) {
  const squad = squadPorId(squadId);
  document.getElementById("sq-add-subtitle").textContent = squad ? squad.nome : "";
  const danger = document.getElementById("sq-add-danger");
  danger.style.display = "none"; danger.textContent = "";
  document.getElementById("sq-add-funcao").value = "membro";
  document.getElementById("sq-add-principal").checked = false;

  const selectUser = document.getElementById("sq-add-user");
  selectUser.innerHTML = `<option value="">Carregando…</option>`;
  document.getElementById("sq-add-modal").classList.add("is-open");
  document.body.classList.add("vf-no-scroll");

  try {
    const usuarios = await carregarUsuarios();
    const membrosAtuais = new Set((STATE.membrosPorSquad[squadId] || []).map((m) => String(m.user_id)));
    const disponiveis = usuarios.filter((u) => u.ativo !== false && !membrosAtuais.has(String(u.id)));
    if (!disponiveis.length) {
      selectUser.innerHTML = `<option value="">Nenhuma pessoa disponível</option>`;
      return;
    }
    selectUser.innerHTML = disponiveis
      .map((u) => `<option value="${esc(u.id)}">${esc(u.nome || u.email)} (${esc(u.email || "")})</option>`)
      .join("");
  } catch (err) {
    danger.style.display = "block";
    danger.textContent = `Erro ao carregar pessoas: ${err.message}`;
  }

  document.getElementById("sq-add-modal").dataset.squadId = squadId;
}

function fecharModalAdicionarPessoa() {
  document.getElementById("sq-add-modal").classList.remove("is-open");
  document.body.classList.remove("vf-no-scroll");
}

async function confirmarAdicionarPessoa() {
  const modal = document.getElementById("sq-add-modal");
  const squadId = Number(modal.dataset.squadId);
  const userId = document.getElementById("sq-add-user").value;
  const funcao = document.getElementById("sq-add-funcao").value;
  const isPrimary = document.getElementById("sq-add-principal").checked;
  const danger = document.getElementById("sq-add-danger");
  danger.style.display = "none"; danger.textContent = "";

  if (!userId) {
    danger.style.display = "block";
    danger.textContent = "Selecione uma pessoa.";
    return;
  }

  const confirmBtn = document.getElementById("sq-add-confirm");
  confirmBtn.disabled = true;
  const txtOrig = confirmBtn.textContent;
  confirmBtn.textContent = "Adicionando…";

  try {
    await api(`/squads/${squadId}/membros`, { method: "POST", body: { userId: Number(userId), funcao, isPrimary } });
    toast("Pessoa adicionada ao squad.", "ok");
    fecharModalAdicionarPessoa();
    await recarregarAtual();
  } catch (err) {
    danger.style.display = "block";
    danger.textContent = err.message || "Não foi possível adicionar.";
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = txtOrig;
  }
}

/* ── MODAL: MOVER CLIENTE ────────────────────────────────── */
function abrirModalMover({ clienteId, clienteNome, squadOrigemId }) {
  const modal = document.getElementById("sq-move-modal");
  modal.dataset.clienteId = clienteId;
  modal.dataset.squadOrigemId = squadOrigemId;

  const origem = squadPorId(squadOrigemId);
  document.getElementById("sq-move-subtitle").textContent = `${clienteNome} · atualmente em ${origem ? origem.nome : "—"}`;
  document.getElementById("sq-move-motivo").value = "";

  const select = document.getElementById("sq-move-destino");
  const opcoes = STATE.squads.filter((s) => s.id !== Number(squadOrigemId));
  select.innerHTML = opcoes
    .map((s) => `<option value="${s.id}">${esc(s.nome)}${isLegado(s) ? " · Legado" : ""}</option>`)
    .join("");

  const danger = document.getElementById("sq-move-danger");
  danger.style.display = "none"; danger.textContent = "";

  atualizarPreviewMover(clienteNome);
  select.onchange = () => atualizarPreviewMover(clienteNome);

  modal.classList.add("is-open");
  document.body.classList.add("vf-no-scroll");
}

function atualizarPreviewMover(clienteNome) {
  const modal = document.getElementById("sq-move-modal");
  const origem = squadPorId(Number(modal.dataset.squadOrigemId));
  const destinoId = Number(document.getElementById("sq-move-destino").value);
  const destino = squadPorId(destinoId);
  document.getElementById("sq-move-preview").textContent =
    `Mover Cliente ${clienteNome} do ${origem ? origem.nome : "—"} para ${destino ? destino.nome : "—"}?`;
}

function fecharModalMover() {
  document.getElementById("sq-move-modal").classList.remove("is-open");
  document.body.classList.remove("vf-no-scroll");
}

async function confirmarMoverCliente() {
  const modal = document.getElementById("sq-move-modal");
  const clienteId = modal.dataset.clienteId;
  const destinoId = document.getElementById("sq-move-destino").value;
  const motivo = document.getElementById("sq-move-motivo").value.trim() || null;
  const danger = document.getElementById("sq-move-danger");
  danger.style.display = "none"; danger.textContent = "";

  if (!destinoId) {
    danger.style.display = "block";
    danger.textContent = "Selecione o squad de destino.";
    return;
  }

  const confirmBtn = document.getElementById("sq-move-confirm");
  confirmBtn.disabled = true;
  const txtOrig = confirmBtn.textContent;
  confirmBtn.textContent = "Movendo…";

  try {
    await api(`/squads/${destinoId}/clientes/${clienteId}/transferir`, { method: "POST", body: { motivo } });
    toast("Cliente movido de squad.", "ok");
    fecharModalMover();
    await recarregarAtual();
  } catch (err) {
    danger.style.display = "block";
    danger.textContent = err.message || "Não foi possível mover o cliente.";
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = txtOrig;
  }
}

/* ── EVENTOS FIXOS ───────────────────────────────────────── */
document.getElementById("sq-btn-retry")?.addEventListener("click", loadSquads);
document.getElementById("sq-detail-close")?.addEventListener("click", fecharDetalhe);

document.getElementById("sq-btn-add-member")?.addEventListener("click", () => {
  if (STATE.squadAbertoId != null) abrirModalAdicionarPessoa(STATE.squadAbertoId);
});

document.getElementById("sq-confirm-close")?.addEventListener("click", fecharConfirmacao);
document.getElementById("sq-confirm-cancel")?.addEventListener("click", fecharConfirmacao);
document.getElementById("sq-confirm-ok")?.addEventListener("click", confirmarAcaoGenerica);
document.getElementById("sq-confirm-modal")?.addEventListener("click", (e) => {
  if (e.target?.id === "sq-confirm-modal") fecharConfirmacao();
});

document.getElementById("sq-add-close")?.addEventListener("click", fecharModalAdicionarPessoa);
document.getElementById("sq-add-cancel")?.addEventListener("click", fecharModalAdicionarPessoa);
document.getElementById("sq-add-confirm")?.addEventListener("click", confirmarAdicionarPessoa);
document.getElementById("sq-add-modal")?.addEventListener("click", (e) => {
  if (e.target?.id === "sq-add-modal") fecharModalAdicionarPessoa();
});

document.getElementById("sq-move-close")?.addEventListener("click", fecharModalMover);
document.getElementById("sq-move-cancel")?.addEventListener("click", fecharModalMover);
document.getElementById("sq-move-confirm")?.addEventListener("click", confirmarMoverCliente);
document.getElementById("sq-move-modal")?.addEventListener("click", (e) => {
  if (e.target?.id === "sq-move-modal") fecharModalMover();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  fecharConfirmacao();
  fecharModalAdicionarPessoa();
  fecharModalMover();
});

/* ── BOOT ────────────────────────────────────────────────── */
if (TOKEN) loadSquads();
