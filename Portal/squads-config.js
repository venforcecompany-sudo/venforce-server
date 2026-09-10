/* VenForce · Gestão de Squads. Vanilla, sem alterações de domínio.
 * Mutações: exclusivamente /squads/*. Os catálogos GET /usuarios e
 * GET /clientes são as consultas já existentes nesta tela.
 * O servidor decide autorização, principal único e atribuição/transferência.
 */
"use strict";
const STORAGE_KEY = "vf-token";
const API_BASE = "https://venforce-server.onrender.com";
const $ = (id) => document.getElementById(id);
const TOKEN = localStorage.getItem(STORAGE_KEY);
let SELF = {};
try { SELF = JSON.parse(localStorage.getItem("vf-user") || "{}"); } catch { /* sessão inválida */ }
const ADMIN = SELF.role === "admin";
const STATE = {
  squads: [], membrosPorSquad: {}, clientesPorSquad: {}, errors: {}, allowed: {},
  squadAbertoId: null, usuarios: null, todosClientes: null, catalogsReady: false,
  refreshing: false, busy: false, selection: 0, modal: null, returnFocus: null, initialSelection: false,
};
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const normal = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const matches = (query, ...values) => normal(values.join(" ")).includes(normal(query));
const squadPorId = id => STATE.squads.find(s => String(s.id) === String(id));
const isLegado = s => Number(s.id) === 8 || normal(s.slug).includes("legado");
const canManage = id => !!STATE.allowed[id];
const people = id => STATE.membrosPorSquad[id];
const clients = id => STATE.clientesPorSquad[id];
const squadName = id => squadPorId(id)?.nome || "Squad";
const personName = (sid, uid) => people(sid)?.find(m => String(m.user_id) === String(uid))?.user_nome || `Pessoa #${uid}`;
const count = (s, kind) => s[kind === "people" ? "membros_ativos" : "clientes_ativos"] ?? (kind === "people" ? people(s.id)?.length : clients(s.id)?.length) ?? "—";
function feedback(message, type = "success") {
  $("sq-feedback").hidden = !message;
  $("sq-feedback").className = `vf-banner is-${type}`;
  $("sq-feedback").innerHTML = message ? `<span>${esc(message)}</span><button type="button" class="sq-feedback-close" data-action="dismiss" aria-label="Dispensar mensagem">×</button>` : "";
}
async function api(path, { method = "GET", body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method, signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401) {
      localStorage.removeItem(STORAGE_KEY); localStorage.removeItem("vf-user");
      window.location.replace("index.html");
    }
    const data = await res.json();
    if (!res.ok || data.ok === false) throw Object.assign(new Error(data.erro || `Não foi possível concluir (HTTP ${res.status}).`), { status: res.status });
    return data;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("A resposta demorou demais. Tente novamente.");
    throw err;
  } finally { clearTimeout(timeout); }
}
function listFrom(data, key) {
  if (!Array.isArray(data[key])) throw new Error("Resposta incompleta. Tente atualizar.");
  return data[key];
}
// Limita o fan-out; catálogo e detalhe compartilham o mesmo cache de leitura.
async function eachLimited(items, task) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (index < items.length) { const item = items[index++]; await task(item); }
  }));
}
async function readSquad(s) {
  STATE.errors[s.id] = {};
  try {
    STATE.membrosPorSquad[s.id] = listFrom(await api(`/squads/${s.id}/membros`), "membros");
    STATE.allowed[s.id] = true; // requireSquadAdmin confirmou este escopo.
  } catch (err) {
    STATE.errors[s.id].people = err;
    STATE.allowed[s.id] = false;
    if (err.status === 403) { delete STATE.membrosPorSquad[s.id]; delete STATE.clientesPorSquad[s.id]; return; }
  }
  try { STATE.clientesPorSquad[s.id] = listFrom(await api(`/squads/${s.id}/clientes`), "clientes"); }
  catch (err) {
    STATE.errors[s.id].clients = err;
    if (err.status === 403) { delete STATE.clientesPorSquad[s.id]; STATE.allowed[s.id] = false; }
  }
}
let refreshTask = null;
function loadSquads() {
  if (!TOKEN) return Promise.resolve();
  if (!refreshTask) refreshTask = refreshSquads().finally(() => { refreshTask = null; });
  return refreshTask;
}
async function refreshSquads() {
  STATE.refreshing = true;
  STATE.catalogsReady = false;
  $("sq-refresh").disabled = true;
  $("sq-refresh").textContent = "Atualizando…";
  $("sq-state-error").style.display = "none";
  if (!STATE.squads.length) $("sq-state-loading").style.display = "block";
  $("sq-detail-status").textContent = STATE.squadAbertoId ? "Atualizando equipe e carteira…" : "";
  try {
    STATE.squads = listFrom(await api("/squads"), "squads");
    await eachLimited(STATE.squads, readSquad);
    $("sq-list-count").textContent = STATE.squads.length;
    $("sq-list").style.display = "flex";
    renderSquadList();
    if (STATE.squadAbertoId && !squadPorId(STATE.squadAbertoId)) fecharDetalhe();
    if (!STATE.initialSelection && STATE.squads.length) {
      STATE.initialSelection = true;
      if (!window.matchMedia("(max-width: 700px)").matches) {
        const first = STATE.squads.find(s => canManage(s.id)) || STATE.squads[0];
        await abrirSquad(first.id);
      }
    }
    if (STATE.squadAbertoId) renderDetalhe(STATE.squadAbertoId);
    if (ADMIN) {
      try {
        STATE.todosClientes = listFrom(await api("/clientes"), "clientes");
        STATE.catalogsReady = STATE.squads.every(s => !STATE.errors[s.id]?.clients && Array.isArray(clients(s.id)));
      } catch { STATE.catalogsReady = false; }
    }
    renderUnassigned();
  } catch (err) {
    $("sq-state-error").style.display = "block";
    $("sq-error-message").textContent = `${err.message} ${STATE.squads.length ? "Os dados anteriores foram mantidos." : ""}`;
    $("sq-detail-status").textContent = STATE.squadAbertoId ? "Não foi possível atualizar. Os dados exibidos são da última leitura." : "";
  } finally {
    STATE.refreshing = false;
    $("sq-state-loading").style.display = "none";
    $("sq-refresh").disabled = false;
    $("sq-refresh").textContent = "Atualizar";
    if (!$("sq-state-error").offsetHeight && STATE.squadAbertoId) renderDetailStatus();
  }
}
function coordinators(s) {
  if (STATE.errors[s.id]?.people) return STATE.errors[s.id].people.status === 403 ? "Gestão restrita à coordenação" : "Coordenação indisponível";
  const names = (people(s.id) || []).filter(m => m.funcao === "coordenador").map(m => m.user_nome);
  return names.length ? names.join(", ") : "Sem coordenador";
}
function renderSquadList() {
  const query = $("sq-search").value;
  const filtered = STATE.squads.filter(s => matches(query, s.nome, s.slug,
    ...(people(s.id) || []).flatMap(m => [m.user_nome, m.user_email]),
    ...(clients(s.id) || []).flatMap(c => [c.nome, c.slug])));
  $("sq-search-status").textContent = query ? `${filtered.length} de ${STATE.squads.length} Squads · busca nos dados disponíveis` : "";
  $("sq-list").innerHTML = filtered.map(s => {
    const selected = String(STATE.squadAbertoId) === String(s.id);
    return `<button type="button" class="sq-row ${selected ? "is-selected" : ""}" data-action="abrir" data-id="${esc(s.id)}" aria-current="${selected ? "true" : "false"}" aria-controls="sq-detail">
      <span class="sq-row__main"><strong>${esc(s.nome)}</strong>${isLegado(s) ? '<span class="sq-badge-legado">Legado</span>' : ""}${s.ativo === false ? '<span class="sq-tag">Inativo</span>' : ""}</span>
      <span class="sq-row__stats"><span><b>${count(s, "clients")}</b> ${Number(count(s, "clients")) === 1 ? "cliente" : "clientes"}</span><span><b>${count(s, "people")}</b> ${Number(count(s, "people")) === 1 ? "pessoa" : "pessoas"}</span></span>
      <span class="sq-row__coord">${esc(coordinators(s))}</span></button>`;
  }).join("") || `<div class="sq-empty"><h3>${STATE.squads.length ? "Nenhum Squad encontrado" : "Nenhum Squad disponível"}</h3><p>${STATE.squads.length ? "Busque outro nome ou limpe a busca." : "Os Squads disponíveis para você aparecerão aqui."}</p></div>`;
}
async function abrirSquad(id) {
  if (STATE.busy) return;
  const changed = String(STATE.squadAbertoId) !== String(id);
  STATE.squadAbertoId = Number(id);
  const version = ++STATE.selection;
  if (changed) {
    ["sq-people-search", "sq-clients-search"].forEach(key => $(key).value = "");
    $("sq-people-filter").value = "all";
    $("sq-edit-form").hidden = true;
  }
  $("sq-detail").style.display = "block";
  $("sq-detail-placeholder").hidden = true;
  $("sq-workspace").classList.add("has-detail");
  renderSquadList(); renderDetalhe(id);
  if (!people(id) && !STATE.errors[id]?.people && !STATE.refreshing) {
    await readSquad(squadPorId(id));
    if (version !== STATE.selection) return;
    renderDetalhe(id); renderSquadList();
  }
  if (changed && window.matchMedia("(max-width: 700px)").matches) {
    $("sq-detail-title").focus({ preventScroll: true });
    $("sq-workspace").scrollIntoView({ block: "start" });
  }
}
function fecharDetalhe() {
  if (STATE.busy) return;
  const id = STATE.squadAbertoId;
  STATE.squadAbertoId = null; STATE.selection++;
  $("sq-detail").style.display = "none";
  $("sq-detail-placeholder").hidden = false;
  $("sq-workspace").classList.remove("has-detail");
  renderSquadList();
  document.querySelector(`.sq-row[data-id="${Number(id)}"]`)?.focus();
}
function renderDetailStatus() {
  const id = STATE.squadAbertoId;
  const errors = STATE.errors[id] || {};
  const denied = errors.people?.status === 403;
  $("sq-detail-status").innerHTML = denied
    ? "Você pode consultar o resumo. A equipe e a carteira são restritas ao coordenador deste Squad e aos administradores."
    : (errors.people || errors.clients) ? 'Parte dos dados não pôde ser atualizada. <button type="button" class="sq-text-button" data-action="retry">Tentar novamente</button>' : "";
}
function renderDetalhe(id) {
  const s = squadPorId(id); if (!s) return;
  $("sq-detail-title").textContent = s.nome;
  $("sq-detail-state").textContent = s.ativo === false ? "Inativo" : "Ativo";
  $("sq-detail-coord").textContent = `Coordenação · ${coordinators(s)}`;
  $("sq-legacy-note").hidden = !isLegado(s);
  $("sq-detail-subtitle").innerHTML = `<a href="#sq-people-section"><strong>${count(s, "people")}</strong> ${Number(count(s, "people")) === 1 ? "pessoa" : "pessoas"}</a><a href="#sq-clients-section"><strong>${count(s, "clients")}</strong> ${Number(count(s, "clients")) === 1 ? "cliente" : "clientes"}</a>${isLegado(s) ? '<span class="sq-badge-legado">Squad 8 · Legado</span>' : ""}`;
  $("sq-edit").hidden = !canManage(id);
  $("sq-btn-add-member").hidden = !canManage(id);
  $("sq-btn-add-cliente").hidden = !canManage(id);
  $("sq-people-count").textContent = count(s, "people");
  $("sq-clients-count").textContent = count(s, "clients");
  renderDetailStatus(); renderPeople(); renderClients();
}
function contentState(kind, rows) {
  const err = STATE.errors[STATE.squadAbertoId]?.[kind];
  if (err?.status === 403) return '<p class="sq-empty">Disponível para a coordenação deste Squad.</p>';
  if (!rows) return `<p class="sq-empty">${err ? "Não foi possível carregar esta seção. Use Tentar novamente acima." : "Carregando…"}</p>`;
  return "";
}
function renderPeople() {
  const id = STATE.squadAbertoId; if (!id) return;
  const rows = people(id); const state = contentState("people", rows);
  if (state) { $("sq-membros-wrap").innerHTML = state; return; }
  const q = $("sq-people-search").value, filter = $("sq-people-filter").value;
  const filtered = rows.filter(m => matches(q, m.user_nome, m.user_email) && (filter === "all" || (filter === "primary" ? m.is_primary : filter === "invalid" ? !["membro", "coordenador"].includes(m.funcao) : m.funcao === filter)))
    .sort((a,b) => Number(b.funcao === "coordenador") - Number(a.funcao === "coordenador") || String(a.user_nome).localeCompare(String(b.user_nome), "pt-BR"));
  $("sq-membros-wrap").innerHTML = filtered.length ? `<ul class="sq-people">${filtered.map(m => {
    const name = esc(m.user_nome), uid = esc(m.user_id), valid = ["membro", "coordenador"].includes(m.funcao);
    return `<li class="sq-person" data-person="${uid}"><div class="sq-person-identity"><strong>${name}</strong><span>${esc(m.user_email)}</span></div>
      <div class="sq-person-role">${ADMIN && canManage(id) ? `<label class="sq-sr-only" for="sq-role-${uid}">Função de ${name}</label><select id="sq-role-${uid}" class="vf-select sq-funcao-select" data-uid="${uid}" data-original="${esc(m.funcao)}">${!valid ? '<option value="" selected>Função não definida</option>' : ""}<option value="membro" ${m.funcao === "membro" ? "selected" : ""}>Membro</option><option value="coordenador" ${m.funcao === "coordenador" ? "selected" : ""}>Coordenador</option></select>` : `<span class="sq-role-label">${m.funcao === "coordenador" ? "Coordenador" : valid ? "Membro" : "Função não definida"}</span>`}</div>
      <div class="sq-person-primary">${m.is_primary ? '<span class="sq-primary">Squad principal</span>' : canManage(id) ? `<button type="button" class="sq-text-button" data-action="principal" data-uid="${uid}" aria-label="Definir este Squad como principal de ${name}">Definir principal</button>` : '<span class="sq-hint">Outro Squad principal</span>'}</div>
      ${canManage(id) ? `<button type="button" class="sq-remove" data-action="remover" data-uid="${uid}" aria-label="Remover ${name} deste Squad">Remover</button>` : ""}</li>`;
  }).join("")}</ul>` : `<div class="sq-empty"><h4>${rows.length ? "Nenhuma pessoa encontrada" : "A equipe começa aqui"}</h4><p>${rows.length ? "Ajuste a busca ou o filtro de função." : "Nenhum membro neste squad. Use Adicionar pessoa para compor a equipe."}</p></div>`;
}
function renderClients() {
  const id = STATE.squadAbertoId; if (!id) return;
  const rows = clients(id); const state = contentState("clients", rows);
  if (state) { $("sq-clientes-wrap").innerHTML = state; $("sq-clients-result").textContent = ""; return; }
  const filtered = rows.filter(c => matches($("sq-clients-search").value, c.nome, c.slug));
  $("sq-clients-result").textContent = `${filtered.length} de ${rows.length} clientes`;
  $("sq-clientes-wrap").innerHTML = filtered.length ? `<div class="sq-table-wrap"><table class="sq-table"><caption class="sq-sr-only">Clientes de ${esc(squadName(id))}</caption><thead><tr><th scope="col">Cliente</th><th scope="col" class="sq-col-actions">${ADMIN ? "Transferência" : "Estado"}</th></tr></thead><tbody>${filtered.map(c => `<tr><td><strong>${esc(c.nome || c.slug)}</strong><span class="sq-client-slug">${esc(c.slug)}${c.ativo === false ? " · Inativo" : ""}</span></td><td class="sq-col-actions">${ADMIN && canManage(id) && !STATE.errors[id]?.clients ? `<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-action="mover" data-cid="${esc(c.id)}" aria-label="Mover ${esc(c.nome || c.slug)} para outro Squad">Mover <span aria-hidden="true">→</span></button>` : esc(c.ativo === false ? "Inativo" : "Ativo")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="sq-empty"><h4>${rows.length ? "Nenhum cliente encontrado" : "Uma carteira para formar"}</h4><p>${rows.length ? "Tente outro nome ou identificador." : "Nenhum cliente neste squad. Adicione um cliente que aguarda atribuição."}</p></div>`;
}
function eligibleClients(query = "") {
  if (!STATE.catalogsReady) return [];
  const linked = new Set(STATE.squads.flatMap(s => (clients(s.id) || []).map(c => String(c.id))));
  return (STATE.todosClientes || []).filter(c => c.ativo !== false && !linked.has(String(c.id)) && matches(query, c.nome, c.slug));
}
function renderUnassigned() {
  const wrap = $("sq-unassigned"); wrap.hidden = !ADMIN;
  if (!ADMIN) return;
  if (!STATE.catalogsReady) { wrap.innerHTML = '<span>Clientes sem Squad · não foi possível verificar todas as carteiras.</span><button class="sq-text-button" type="button" data-action="retry">Tentar novamente</button>'; return; }
  const rows = eligibleClients(); wrap.hidden = !rows.length;
  wrap.innerHTML = `<div><strong>${rows.length} ${rows.length === 1 ? "cliente aguarda" : "clientes aguardam"} atribuição</strong><span>Clientes ativos que ainda não pertencem a um Squad.</span></div><button type="button" class="vf-btn vf-btn--secondary" data-action="assign">Atribuir clientes</button>`;
}
/* Dialogs: foco contido, retorno ao acionador, Esc e bloqueio durante escrita. */
function openModal(kind, sid) {
  STATE.modal = kind; STATE.returnFocus = document.activeElement;
  const modal = $(`sq-${kind}-modal`); modal.dataset.squadId = sid;
  modal.classList.add("is-open"); document.body.classList.add("vf-no-scroll");
  $("sq-workspace").inert = true;
  const danger = $(`sq-${kind}-danger`); danger.style.display = "none"; danger.textContent = "";
  requestAnimationFrame(() => {
    if (STATE.modal !== kind) return;
    const field = [...modal.querySelectorAll('input:not([type="checkbox"]), select')].find(el => !el.disabled && el.offsetParent !== null);
    (field || modal.querySelector("button"))?.focus();
  });
}
function closeModal() {
  if (STATE.busy || !STATE.modal) return;
  $(`sq-${STATE.modal}-modal`).classList.remove("is-open");
  STATE.modal = null; document.body.classList.remove("vf-no-scroll"); $("sq-workspace").inert = false;
  if (STATE.returnFocus?.isConnected) STATE.returnFocus.focus(); else $("sq-detail-title").focus({ preventScroll: true });
}
let confirmAction = null;
function confirmDialog({ title, text, label = "Confirmar", danger = false, action }) {
  $("sq-confirm-title").textContent = title; $("sq-confirm-body").textContent = text;
  $("sq-confirm-ok").textContent = label;
  $("sq-confirm-ok").className = `vf-btn vf-btn--${danger ? "danger" : "primary"}`;
  confirmAction = action; openModal("confirm", STATE.squadAbertoId);
}
async function mutate({ path, method, body, message, button, errorId, done }) {
  if (STATE.busy) return;
  STATE.busy = true;
  const text = button.textContent; button.textContent = "Salvando…";
  const scope = STATE.modal ? $(`sq-${STATE.modal}-modal`) : $("sq-detail");
  const controls = [...scope.querySelectorAll("button,input,select")].map(el => [el, el.disabled]);
  controls.forEach(([el]) => el.disabled = true);
  if (errorId) { $(errorId).textContent = ""; $(errorId).style.display = "none"; }
  let success = false;
  try {
    // Uma leitura anterior não pode sobrescrever o resultado desta escrita.
    if (refreshTask) await refreshTask;
    await api(path, { method, body }); success = true;
    feedback(message);
    // A escrita já foi confirmada. Falha de atualização nunca vira "falha ao salvar".
    await loadSquads();
  } catch (err) {
    const text = `${message.split(".")[0]} — alteração não concluída: ${err.message}`;
    if (errorId) { $(errorId).textContent = err.message; $(errorId).style.display = "block"; }
    else feedback(text, "danger");
  } finally {
    STATE.busy = false; controls.forEach(([el, disabled]) => el.disabled = disabled); button.textContent = text;
    if (success) { closeModal(); done?.(); }
  }
  return success;
}
function memberAction(action, uid) {
  const sid = STATE.squadAbertoId; if (!canManage(sid)) return;
  const name = personName(sid, uid), squad = squadName(sid);
  const remove = action === "remover";
  confirmDialog({ title: remove ? "Remover pessoa da equipe" : "Definir Squad principal", danger: remove,
    text: remove ? `${name} deixará a equipe de ${squad}. Se este for o Squad principal, outro vínculo ativo será escolhido automaticamente, quando existir.` : `${squad} será o Squad principal de ${name}, substituindo o principal atual. Os outros vínculos da pessoa serão mantidos.`,
    label: remove ? "Remover pessoa" : "Definir principal",
    action: () => mutate({ path: `/squads/${sid}/membros/${uid}${remove ? "" : "/principal"}`, method: remove ? "DELETE" : "PATCH", message: remove ? `${name} foi removido de ${squad}.` : `${squad} agora é o Squad principal de ${name}.`, button: $("sq-confirm-ok"), errorId: "sq-confirm-danger" }) });
}
async function changeRole(select) {
  const sid = STATE.squadAbertoId, uid = select.dataset.uid, value = select.value;
  if (!ADMIN || !canManage(sid) || !["membro", "coordenador"].includes(value)) return;
  const success = await mutate({ path: `/squads/${sid}/membros/${uid}/funcao`, method: "PATCH", body: { funcao: value }, message: `${personName(sid, uid)} agora tem a função de ${value} em ${squadName(sid)}.`, button: $("sq-btn-add-member") });
  if (!success) select.value = select.dataset.original;
}
function renderUserOptions() {
  const sid = $("sq-add-modal").dataset.squadId;
  const current = new Set((people(sid) || []).map(m => String(m.user_id)));
  const rows = (STATE.usuarios || []).filter(u => u.ativo !== false && !current.has(String(u.id)) && matches($("sq-add-search").value, u.nome, u.email));
  $("sq-add-user").innerHTML = '<option value="">Selecione uma pessoa</option>' + rows.map(u => `<option value="${esc(u.id)}">${esc(u.nome || u.email)} · ${esc(u.email)}</option>`).join("");
  if (!rows.length) $("sq-add-user").innerHTML = '<option value="">Nenhuma pessoa disponível para esta busca</option>';
  $("sq-add-confirm").disabled = true;
}
async function addPerson(sid) {
  if (!canManage(sid)) return;
  $("sq-add-subtitle").textContent = squadName(sid);
  $("sq-add-search").value = ""; $("sq-add-id").value = "";
  $("sq-add-funcao").value = "membro"; $("sq-add-principal").checked = false;
  $("sq-add-search-wrap").hidden = !ADMIN; $("sq-add-user-wrap").hidden = !ADMIN; $("sq-add-id-wrap").hidden = ADMIN;
  $("sq-add-confirm").disabled = true;
  $("sq-add-user").innerHTML = '<option value="">Carregando pessoas…</option>';
  openModal("add", sid);
  if (!ADMIN) { $("sq-add-id").focus(); return; }
  try {
    if (!STATE.usuarios) { const data = await api("/usuarios"); STATE.usuarios = Array.isArray(data) ? data : listFrom(data, "usuarios"); }
    if (STATE.modal === "add") renderUserOptions();
  } catch (err) {
    $("sq-add-danger").textContent = `Não foi possível carregar pessoas: ${err.message} Feche e tente novamente.`;
    $("sq-add-danger").style.display = "block";
  }
}
function confirmPerson() {
  const sid = $("sq-add-modal").dataset.squadId, uid = Number($(ADMIN ? "sq-add-user" : "sq-add-id").value);
  if (!Number.isInteger(uid) || uid <= 0 || !canManage(sid)) return;
  const name = STATE.usuarios?.find(u => Number(u.id) === uid)?.nome || `Pessoa #${uid}`;
  mutate({ path: `/squads/${sid}/membros`, method: "POST", body: { userId: uid, funcao: $("sq-add-funcao").value, isPrimary: $("sq-add-principal").checked }, message: `${name} foi adicionado a ${squadName(sid)}.`, button: $("sq-add-confirm"), errorId: "sq-add-danger" });
}
function clientOptions() {
  const rows = eligibleClients($("sq-addcliente-busca").value);
  $("sq-addcliente-select").innerHTML = rows.map(c => `<option value="${esc(c.id)}">${esc(c.nome || c.slug)} (${esc(c.slug)})</option>`).join("") || '<option value="">Nenhum cliente sem Squad encontrado</option>';
  $("sq-addcliente-select").selectedIndex = -1; clientPreview();
}
function clientPreview() {
  const sid = $("sq-addcliente-modal").dataset.squadId;
  const select = $("sq-addcliente-select");
  const label = ADMIN ? select.selectedOptions[0]?.textContent : `Cliente #${$("sq-addcliente-id").value}`;
  const value = $(ADMIN ? "sq-addcliente-select" : "sq-addcliente-id").value;
  $("sq-addcliente-preview").textContent = value ? `Adicionar Cliente ${label} ao ${squadName(sid)}?` : "Selecione o cliente para conferir a atribuição.";
  $("sq-addcliente-confirm").disabled = !value || (ADMIN && !STATE.catalogsReady);
}
async function addClient(sid) {
  if (!canManage(sid)) return;
  $("sq-addcliente-subtitle").textContent = `Destino · ${squadName(sid)}`;
  $("sq-addcliente-busca").value = ""; $("sq-addcliente-id").value = "";
  ["sq-addcliente-search-wrap", "sq-addcliente-select-wrap"].forEach(id => $(id).hidden = !ADMIN);
  $("sq-addcliente-id-wrap").hidden = ADMIN;
  openModal("addcliente", sid);
  if (ADMIN) {
    if (!STATE.catalogsReady) {
      $("sq-addcliente-confirm").disabled = true;
      $("sq-addcliente-select").innerHTML = '<option value="">Verificando carteiras…</option>';
      await loadSquads();
    }
    clientOptions();
    if (!STATE.catalogsReady) { $("sq-addcliente-danger").textContent = "A verificação de clientes sem Squad está incompleta. Feche e atualize para tentar novamente."; $("sq-addcliente-danger").style.display = "block"; }
  } else { clientPreview(); $("sq-addcliente-id").focus(); }
}
function confirmClient() {
  const sid = $("sq-addcliente-modal").dataset.squadId, cid = Number($(ADMIN ? "sq-addcliente-select" : "sq-addcliente-id").value);
  if (!Number.isInteger(cid) || cid <= 0 || !canManage(sid) || (ADMIN && !eligibleClients().some(c => Number(c.id) === cid))) return;
  const name = STATE.todosClientes?.find(c => Number(c.id) === cid)?.nome || `Cliente #${cid}`;
  mutate({ path: `/squads/${sid}/clientes`, method: "POST", body: { clienteId: cid }, message: `${name} foi atribuído a ${squadName(sid)}.`, button: $("sq-addcliente-confirm"), errorId: "sq-addcliente-danger" });
}
function openMove(cid) {
  const sid = STATE.squadAbertoId, client = clients(sid)?.find(c => String(c.id) === String(cid));
  if (!ADMIN || !canManage(sid) || !client) return;
  const modal = $("sq-move-modal"); modal.dataset.clienteId = cid; modal.dataset.clienteNome = client.nome || client.slug;
  $("sq-move-subtitle").textContent = `${client.nome || client.slug} · ${client.slug}`;
  $("sq-move-motivo").value = "";
  $("sq-move-destino").innerHTML = '<option value="">Selecione o destino</option>' + STATE.squads.filter(s => String(s.id) !== String(sid) && s.ativo !== false).map(s => `<option value="${esc(s.id)}">${esc(s.nome)}${isLegado(s) ? " · Legado" : ""}</option>`).join("");
  openModal("move", sid); movePreview();
}
function movePreview() {
  const modal = $("sq-move-modal"), sid = modal.dataset.squadId, dest = $("sq-move-destino").value;
  $("sq-move-preview").innerHTML = `<strong>${esc(modal.dataset.clienteNome)}</strong><span class="sq-transfer-route"><span><small>Origem</small>${esc(squadName(sid))}</span><span aria-hidden="true">→</span><span><small>Destino</small>${dest ? esc(squadName(dest)) : "Escolha um Squad"}</span></span>`;
  $("sq-move-confirm").disabled = !dest;
}
function confirmMove() {
  const modal = $("sq-move-modal"), sid = modal.dataset.squadId, cid = modal.dataset.clienteId, dest = $("sq-move-destino").value;
  if (!ADMIN || !canManage(sid) || !dest || dest === sid || squadPorId(dest)?.ativo === false) return;
  mutate({ path: `/squads/${dest}/clientes/${cid}/transferir`, method: "POST", body: { motivo: $("sq-move-motivo").value.trim() || null }, message: `${modal.dataset.clienteNome} foi movido de ${squadName(sid)} para ${squadName(dest)}.`, button: $("sq-move-confirm"), errorId: "sq-move-danger" });
}
function editSquad() {
  const s = squadPorId(STATE.squadAbertoId); if (!canManage(s?.id)) return;
  $("sq-edit-name").value = s.nome; $("sq-edit-state").value = String(s.ativo !== false);
  $("sq-edit-state-wrap").hidden = !ADMIN; $("sq-edit-form").hidden = false; $("sq-edit-error").textContent = ""; $("sq-edit-name").focus();
}
function saveSquad(event) {
  event.preventDefault();
  const s = squadPorId(STATE.squadAbertoId); if (!s || !canManage(s.id)) return;
  const body = { nome: $("sq-edit-name").value.trim() }; if (!body.nome) return;
  if (ADMIN) body.ativo = $("sq-edit-state").value === "true";
  const execute = (button, errorId) => mutate({ path: `/squads/${s.id}`, method: "PATCH", body, message: `${body.nome} foi atualizado${ADMIN ? ` e está ${body.ativo ? "ativo" : "inativo"}` : ""}.`, button, errorId, done: () => $("sq-edit-form").hidden = true });
  if (ADMIN && body.ativo === false && s.ativo !== false) confirmDialog({ title: "Desativar Squad", text: `${s.nome} ficará inativo. Um Squad inativo deixa de conceder acesso operacional pela carteira. Seus vínculos serão mantidos.`, label: "Desativar Squad", danger: true, action: () => execute($("sq-confirm-ok"), "sq-confirm-danger") });
  else execute(event.submitter, "sq-edit-error");
}
/* Eventos delegados: renderizar uma lista não multiplica listeners. */
document.addEventListener("click", event => {
  const target = event.target.closest("[data-action]"); if (!target || STATE.busy) return;
  const action = target.dataset.action;
  if (action === "dismiss") feedback("");
  if (action === "abrir") abrirSquad(target.dataset.id);
  if (action === "retry") loadSquads();
  if (action === "principal" || action === "remover") memberAction(action, target.dataset.uid);
  if (action === "mover") openMove(target.dataset.cid);
  if (action === "assign") {
    if (STATE.squadAbertoId && canManage(STATE.squadAbertoId)) addClient(STATE.squadAbertoId);
    else { feedback("Selecione o Squad que receberá os clientes e use Adicionar cliente.", "neutral"); $("sq-search").focus(); }
  }
});
$("sq-search").addEventListener("input", renderSquadList);
$("sq-people-search").addEventListener("input", renderPeople);
$("sq-people-filter").addEventListener("change", renderPeople);
$("sq-clients-search").addEventListener("input", renderClients);
$("sq-membros-wrap").addEventListener("change", e => { if (e.target.matches(".sq-funcao-select")) changeRole(e.target); });
$("sq-list").addEventListener("keydown", e => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const rows = [...$("sq-list").querySelectorAll("button")], i = rows.indexOf(document.activeElement); if (i < 0) return;
  e.preventDefault(); rows[e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
});
$("sq-refresh").addEventListener("click", () => { if (!STATE.busy) loadSquads(); });
$("sq-btn-retry").addEventListener("click", loadSquads);
$("sq-detail-close").addEventListener("click", fecharDetalhe);
$("sq-btn-add-member").addEventListener("click", () => addPerson(STATE.squadAbertoId));
$("sq-btn-add-cliente").addEventListener("click", () => addClient(STATE.squadAbertoId));
$("sq-edit").addEventListener("click", editSquad);
$("sq-edit-form").addEventListener("submit", saveSquad);
$("sq-edit-cancel").addEventListener("click", () => { $("sq-edit-form").hidden = true; $("sq-edit").focus(); });
$("sq-confirm-ok").addEventListener("click", () => { if (!STATE.busy) confirmAction?.(); });
$("sq-add-confirm").addEventListener("click", confirmPerson);
$("sq-add-search").addEventListener("input", renderUserOptions);
["sq-add-user", "sq-add-id"].forEach(id => $(id).addEventListener("input", () => $("sq-add-confirm").disabled = !$(id).value));
$("sq-addcliente-confirm").addEventListener("click", confirmClient);
$("sq-addcliente-busca").addEventListener("input", clientOptions);
$("sq-addcliente-select").addEventListener("change", clientPreview);
$("sq-addcliente-id").addEventListener("input", clientPreview);
$("sq-move-destino").addEventListener("change", movePreview);
$("sq-move-confirm").addEventListener("click", confirmMove);
["confirm", "add", "addcliente", "move"].forEach(kind => {
  ["close", "cancel"].forEach(action => $(`sq-${kind}-${action}`).addEventListener("click", closeModal));
  $(`sq-${kind}-modal`).addEventListener("click", e => { if (e.target.id === `sq-${kind}-modal`) closeModal(); });
});
document.addEventListener("keydown", e => {
  if (!STATE.modal) return;
  const modal = $(`sq-${STATE.modal}-modal`);
  if (e.key === "Escape") { e.preventDefault(); closeModal(); }
  if (e.key === "Tab") {
    const controls = [...modal.querySelectorAll("button,input,select,[tabindex]")].filter(el => !el.disabled && el.offsetParent !== null);
    const first = controls[0], last = controls.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
  if (e.key === "Enter" && e.target.tagName === "INPUT" && !STATE.busy) {
    const id = STATE.modal === "confirm" ? "sq-confirm-ok" : `sq-${STATE.modal}-confirm`;
    if (!$(id).disabled) { e.preventDefault(); $(id).click(); }
  }
});
$("sq-access-label").textContent = ADMIN ? "Administração global" : "Gestão dos seus Squads";
$("sq-list-scope").textContent = ADMIN ? "Todos" : "Seus vínculos";
if (!TOKEN) window.location.replace("index.html"); else loadSquads();
