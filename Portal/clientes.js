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

const { classificarStatusConta, resumirContasMarketplace, criarExpansaoUnica } = window.VF_CLIENTES_CONTAS_RESUMO;

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

function filtrarClientes() {
  const termo = (document.getElementById("busca-cliente")?.value || "").toLowerCase().trim();
  const linhas = document.querySelectorAll("#clientes-tbody > tr.vf-clientes-row");
  let visiveis = 0;
  linhas.forEach((tr) => {
    const texto = tr.textContent.toLowerCase();
    const bate = !termo || texto.includes(termo);
    tr.style.display = bate ? "" : "none";
    // A linha de expansão é a próxima irmã — acompanha a visibilidade do cliente dono.
    const expandRow = tr.nextElementSibling;
    if (expandRow && expandRow.classList.contains("vf-clientes-expand-row")) {
      expandRow.style.display = bate ? "" : "none";
    }
    if (bate) visiveis++;
  });
  const badge = document.getElementById("clientes-count");
  if (badge && badge.style.display !== "none") badge.textContent = String(visiveis);
}

// Link account-scoped (Fundação de Contas): identifica a cliente_conta
// específica, nunca o cliente genérico — necessário para diferenciar
// ML1/ML2/ML3 do mesmo cliente. O link legado /ml/conectar/:clienteSlug
// continua existindo no backend por compatibilidade, mas /clientes.html
// usa exclusivamente este.
function getMlConectarContaLink(contaId) {
  return `${API_BASE}/ml/conectar-conta/${contaId}`;
}

async function copiarLinkConta(link, btn) {
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(link);
    btn.textContent = "✓ Link copiado";
  } catch (err) {
    setClientesFeedback(`Não foi possível copiar automaticamente. Link: ${link}`, "danger");
    return;
  }
  setTimeout(() => { btn.textContent = original; }, 1800);
}

function slugify(nome) {
  return String(nome || "").toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

const stateLoading = document.getElementById("state-loading");
const stateTable = document.getElementById("state-table");
const stateEmpty = document.getElementById("state-empty");
const stateError = document.getElementById("state-error");
const clientesCount = document.getElementById("clientes-count");
const clientesTbody = document.getElementById("clientes-tbody");
const clientesFeedback = document.getElementById("clientes-feedback");

let CLIENTES_LISTA = [];
let CLIENTES_CONFIRM_OPEN = false;
let CLIENTES_CONFIRM_ACTION = null;
let CLIENTE_DELETE_PENDENTE = null; // { slug, btn }
const EXPANSAO = criarExpansaoUnica(); // controla qual linha está aberta (só uma por vez)
const EXPANDIDO_CONTAS = new Map(); // slug -> contas cruas da última carga (cache p/ sugestão de nome "+Conta")
let BASE_PICKER_CONTA = null; // conta sendo editada no modal "Definir/Trocar base"

function setClientesFeedback(message, type = "neutral") {
  if (!clientesFeedback) return;
  clientesFeedback.classList.remove("is-success", "is-danger", "is-info");
  clientesFeedback.textContent = "";
  clientesFeedback.style.display = "none";
  if (!message) return;
  const cls = type === "success" ? "is-success" : (type === "danger" ? "is-danger" : "is-info");
  clientesFeedback.classList.add(cls);
  clientesFeedback.style.display = "block";
  clientesFeedback.textContent = message;
}

function abrirModalConfirmacaoClientes({ title, subtitle = "", description, confirmLabel = "Confirmar", danger = false, onConfirm }) {
  const modal = document.getElementById("vf-clientes-confirm-modal");
  const t = document.getElementById("vf-clientes-confirm-title");
  const sub = document.getElementById("vf-clientes-confirm-subtitle");
  const desc = document.getElementById("vf-clientes-confirm-desc");
  const ok = document.getElementById("vf-clientes-confirm-ok");
  const dangerBox = document.getElementById("vf-clientes-confirm-danger");
  if (!modal || !ok || !desc || !t) return;

  CLIENTES_CONFIRM_OPEN = true;
  CLIENTES_CONFIRM_ACTION = typeof onConfirm === "function" ? onConfirm : null;

  t.textContent = title || "Confirmar";
  if (sub) sub.textContent = subtitle || "";
  desc.textContent = description || "";

  ok.textContent = confirmLabel || "Confirmar";
  ok.classList.remove("vf-btn--secondary", "vf-btn--danger");
  ok.classList.add(danger ? "vf-btn--danger" : "vf-btn--secondary");

  if (dangerBox) { dangerBox.style.display = "none"; dangerBox.textContent = ""; }
  modal.classList.add("is-open");
}

function fecharModalConfirmacaoClientes() {
  document.getElementById("vf-clientes-confirm-modal")?.classList.remove("is-open");
  CLIENTES_CONFIRM_OPEN = false;
  CLIENTES_CONFIRM_ACTION = null;
  CLIENTE_DELETE_PENDENTE = null;
}

async function confirmarModalClientes() {
  const ok = document.getElementById("vf-clientes-confirm-ok");
  const dangerBox = document.getElementById("vf-clientes-confirm-danger");
  if (!CLIENTE_DELETE_PENDENTE && !CLIENTES_CONFIRM_ACTION) return;

  if (dangerBox) { dangerBox.style.display = "none"; dangerBox.textContent = ""; }
  if (ok) { ok.disabled = true; ok.textContent = CLIENTE_DELETE_PENDENTE ? "Excluindo..." : "Processando…"; }

  try {
    if (CLIENTE_DELETE_PENDENTE) {
      const { slug, btn } = CLIENTE_DELETE_PENDENTE;
      if (!slug) throw new Error("Cliente inválido.");
      await deleteCliente(slug, btn);
      CLIENTE_DELETE_PENDENTE = null;
    } else {
      await CLIENTES_CONFIRM_ACTION();
    }
    fecharModalConfirmacaoClientes();
  } catch (err) {
    const msg = err?.message || "Não foi possível concluir a ação.";
    const dependencias = err?.dependencias;
    if (dangerBox) {
      dangerBox.style.display = "block";
      dangerBox.textContent = dependencias?.length
        ? `${msg} (${dependencias.map((d) => `${d.label}: ${d.total}`).join(", ")})`
        : msg;
    } else {
      setClientesFeedback(msg, "danger");
    }
    if (ok) { ok.disabled = false; ok.textContent = CLIENTE_DELETE_PENDENTE ? "Excluir cliente" : "Confirmar"; }
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
  clientesCount.style.display = "none";
}
function showError(msg) {
  stateError.style.display = "block";
  stateLoading.style.display = stateTable.style.display = stateEmpty.style.display = "none";
  document.getElementById("error-message").textContent = msg;
}

function setCreateLoading(on) {
  const btn = document.getElementById("btn-criar-cliente");
  const text = document.getElementById("btn-criar-cliente-text");
  const sp = document.getElementById("btn-criar-cliente-spinner");
  btn.disabled = on;
  text.textContent = on ? "Criando…" : "Criar cliente";
  sp.style.display = on ? "inline-block" : "none";
}

function setFormStatus(msg, isError) {
  const el = document.getElementById("cliente-status");
  el.textContent = msg || "";
  el.style.color = isError ? "var(--vf-danger)" : "var(--vf-success)";
  el.style.display = msg ? "block" : "none";
}

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { Authorization: "Bearer " + TOKEN, ...(options.headers || {}) },
  });
  if (res.status === 401) { clearSession(); throw new Error("Sessão expirada."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.erro || data?.error || `HTTP ${res.status}`);
    err.code = data?.code;
    err.dependencias = data?.dependencias;
    err.contas = data?.contas;
    throw err;
  }
  return data;
}

async function loadClientes() {
  if (!TOKEN) return;
  showLoading();
  EXPANSAO.fechar();
  EXPANDIDO_CONTAS.clear();
  try {
    const data = await apiFetch("/clientes");
    const clientes = Array.isArray(data.clientes) ? data.clientes : [];
    CLIENTES_LISTA = clientes;
    renderClientes(clientes);
  } catch (err) {
    showError("Não foi possível carregar os clientes. Tente novamente.");
  }
}

function renderClientes(clientes) {
  clientesTbody.innerHTML = "";
  if (!clientes.length) { showEmpty(); return; }

  setClientesFeedback("");
  clientesCount.textContent = String(clientes.length);
  clientesCount.style.display = "inline-block";

  clientes.forEach((c, i) => {
    const ativo = c.ativo !== false;
    const slug = c.slug || "";

    const tr = document.createElement("tr");
    tr.className = "vf-clientes-row animate-fade-up";
    tr.id = `cliente-row-${escapeHTML(slug)}`;
    tr.style.animationDelay = `${i * 0.04}s`;
    tr.dataset.slug = slug;

    tr.innerHTML = `
      <td class="vf-cli-cell-slug">${String(i + 1).padStart(2, "0")}</td>
      <td><strong>${escapeHTML(c.nome || "—")}</strong></td>
      <td class="vf-cli-cell-slug">${escapeHTML(slug || "—")}</td>
      <td>
        <span class="vf-status ${ativo ? "is-success" : ""}">${ativo ? "Ativo" : "Inativo"}</span>
      </td>
      <td id="resumo-contas-${escapeHTML(slug)}"><span class="vf-cli-cell-muted">…</span></td>
      <td>
        <div class="vf-table__actions">
          <button class="vf-btn vf-btn--sm vf-btn--secondary vf-clientes-toggle-btn" data-action="toggle-expand" data-slug="${escapeHTML(slug)}" aria-expanded="false" title="Detalhes">⌄</button>
          <button class="vf-btn vf-btn--sm vf-btn--secondary" data-action="delete" data-slug="${escapeHTML(slug)}">Excluir</button>
        </div>
      </td>
    `;

    // A linha inteira é clicável para expandir, exceto a célula de ações
    // (Excluir e o próprio botão de expandir têm seus próprios handlers).
    tr.addEventListener("click", (e) => {
      if (e.target.closest(".vf-table__actions")) return;
      toggleExpandCliente(slug);
    });

    clientesTbody.appendChild(tr);
  });

  clientesTbody.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const slug = btn.getAttribute("data-slug") || "";
      if (!slug) return;
      CLIENTE_DELETE_PENDENTE = { slug, btn };
      abrirModalConfirmacaoClientes({
        title: "Excluir cliente",
        subtitle: slug,
        description: `Esta ação remove o cliente "${slug}" do portal. Se houver contas, bases ou históricos vinculados, a exclusão será bloqueada.`,
        confirmLabel: "Excluir cliente",
        danger: true,
        onConfirm: null,
      });
    });
  });

  clientesTbody.querySelectorAll('button[data-action="toggle-expand"]').forEach((btn) => {
    btn.addEventListener("click", () => toggleExpandCliente(btn.getAttribute("data-slug") || ""));
  });

  showTable();
  const buscaAtiva = document.getElementById("busca-cliente");
  if (buscaAtiva) buscaAtiva.value = "";

  clientes.forEach((c) => carregarResumoContas(c.slug || ""));
}

async function carregarResumoContas(slug) {
  const celContas = document.getElementById(`resumo-contas-${slug}`);
  if (!celContas) return;
  try {
    const data = await apiFetch(`/clientes/${encodeURIComponent(slug)}/contas`);
    const contas = Array.isArray(data.contas) ? data.contas : [];
    renderResumoContasCelula(celContas, contas);
  } catch {
    celContas.innerHTML = `<span class="vf-cli-cell-muted">—</span>`;
  }
}

// Coluna "Contas": duas linhas compactas (ML / Shopee), cor de ESTADO — não
// de marketplace. verde=saudável · amarelo=pendência · vermelho=problema ·
// cinza=inexistente. Ver Portal/clientes-contas-resumo.js.
function linhaResumoHtml(marketplace, label, contas) {
  const r = resumirContasMarketplace(marketplace, contas);
  const clsPorEstado = { saudavel: "is-ok", pendencia: "is-warn", problema: "is-danger", vazio: "is-muted" };
  return `
    <div class="vf-clientes-resumo-linha ${clsPorEstado[r.state]}">
      <span class="vf-clientes-resumo-label">${escapeHTML(label)}</span>
      <span class="vf-clientes-resumo-dot">${r.symbol}</span>
      <span class="vf-clientes-resumo-texto">${escapeHTML(r.texto)}</span>
    </div>`;
}

function renderResumoContasCelula(el, contas) {
  const ml = contas.filter((c) => c.marketplace === "meli");
  const shopee = contas.filter((c) => c.marketplace === "shopee");
  el.innerHTML = `
    <div class="vf-clientes-resumo">
      ${linhaResumoHtml("meli", "ML", ml)}
      ${linhaResumoHtml("shopee", "Shopee", shopee)}
    </div>`;
}

async function deleteCliente(slug, btn) {
  btn.disabled = true;
  btn.textContent = "Excluindo…";
  try {
    await apiFetch(`/clientes/${encodeURIComponent(slug)}`, { method: "DELETE" });
    setClientesFeedback(`Cliente "${slug}" excluído com sucesso.`, "success");
    loadClientes();
    return true;
  } catch (err) {
    if (err.code !== "CLIENTE_COM_DEPENDENCIAS") setClientesFeedback(`Erro ao excluir: ${err.message}`, "danger");
    btn.disabled = false;
    btn.textContent = "Excluir";
    throw err;
  }
}

async function createCliente() {
  const nomeEl = document.getElementById("cliente-nome");
  const slugEl = document.getElementById("cliente-slug");
  const nome = nomeEl.value.trim();
  const slug = slugEl.value.trim();

  setFormStatus("", false);
  if (!nome) { setFormStatus("Informe o nome do cliente.", true); return; }
  if (!slug) { setFormStatus("Informe o slug do cliente.", true); return; }

  setCreateLoading(true);
  try {
    await apiFetch("/clientes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome, slug }),
    });
    nomeEl.value = "";
    slugEl.value = "";
    setFormStatus("✓ Cliente criado com sucesso.", false);
    loadClientes();
  } catch (err) {
    setFormStatus("Erro ao criar: " + err.message, true);
  } finally {
    setCreateLoading(false);
  }
}

// ── EXPANSÃO INLINE DA LINHA (substitui o drawer) ─────────────────────────
// Só uma linha expandida por vez (EXPANSAO, Portal/clientes-contas-resumo.js).
// Abrir/fechar não recarrega a tabela inteira nem perde a busca ativa.

function expansaoTemplate(slug) {
  return `
    <div class="vf-clientes-expand__state" data-role="state">Carregando contas…</div>

    <section class="vf-clientes-mp-section" data-mp="meli">
      <div class="vf-clientes-mp-section__header">
        <h4><span class="vf-clientes-mp-dot vf-clientes-mp-dot--meli"></span>Mercado Livre</h4>
        <button type="button" class="vf-btn vf-btn--sm vf-btn--secondary" data-action="add-conta" data-mp="meli">+ Conta Mercado Livre</button>
      </div>
      <div class="vf-clientes-new-conta-form" data-form="meli" style="display:none;">
        <div class="vf-field">
          <label class="vf-field__label">Nome da conta</label>
          <input type="text" class="vf-input" data-input="nome" placeholder="ex: Mercado Livre 1">
        </div>
        <div class="vf-clientes-new-conta-actions">
          <button type="button" class="vf-btn vf-btn--sm vf-btn--secondary" data-action="cancelar-conta" data-mp="meli">Cancelar</button>
          <button type="button" class="vf-btn vf-btn--sm vf-btn--primary" data-action="salvar-conta" data-mp="meli">Criar conta</button>
        </div>
      </div>
      <div class="vf-clientes-conta-list" data-list="meli"></div>
      <p class="vf-clientes-mp-empty" data-empty="meli" style="display:none;">Nenhuma conta Mercado Livre cadastrada.</p>
    </section>

    <section class="vf-clientes-mp-section" data-mp="shopee">
      <div class="vf-clientes-mp-section__header">
        <h4><span class="vf-clientes-mp-dot vf-clientes-mp-dot--shopee"></span>Shopee</h4>
        <button type="button" class="vf-btn vf-btn--sm vf-btn--secondary" data-action="add-conta" data-mp="shopee">+ Conta Shopee</button>
      </div>
      <div class="vf-clientes-new-conta-form" data-form="shopee" style="display:none;">
        <div class="vf-field">
          <label class="vf-field__label">Nome da conta</label>
          <input type="text" class="vf-input" data-input="nome" placeholder="ex: Shopee 1">
        </div>
        <div class="vf-clientes-new-conta-actions">
          <button type="button" class="vf-btn vf-btn--sm vf-btn--secondary" data-action="cancelar-conta" data-mp="shopee">Cancelar</button>
          <button type="button" class="vf-btn vf-btn--sm vf-btn--primary" data-action="salvar-conta" data-mp="shopee">Criar conta</button>
        </div>
      </div>
      <div class="vf-clientes-conta-list" data-list="shopee"></div>
      <p class="vf-clientes-mp-empty" data-empty="shopee" style="display:none;">Nenhuma conta Shopee cadastrada.</p>
    </section>
  `;
}

function atualizarChevron(slug, aberto) {
  const btn = clientesTbody.querySelector(`button[data-action="toggle-expand"][data-slug="${CSS.escape(slug)}"]`);
  if (!btn) return;
  btn.textContent = aberto ? "︿" : "⌄";
  btn.setAttribute("aria-expanded", aberto ? "true" : "false");
}

function removerLinhaExpandida(slug) {
  document.getElementById(`cliente-expand-row-${slug}`)?.remove();
  EXPANDIDO_CONTAS.delete(slug);
}

function abrirLinhaExpandida(slug) {
  const rowCliente = document.getElementById(`cliente-row-${slug}`);
  if (!rowCliente) return;

  const tr = document.createElement("tr");
  tr.className = "vf-clientes-expand-row";
  tr.id = `cliente-expand-row-${slug}`;
  const colspan = rowCliente.children.length;
  tr.innerHTML = `<td colspan="${colspan}"><div class="vf-clientes-expand" id="cliente-expand-${slug}" data-slug="${escapeHTML(slug)}">${expansaoTemplate(slug)}</div></td>`;
  rowCliente.insertAdjacentElement("afterend", tr);

  const container = document.getElementById(`cliente-expand-${slug}`);
  wireExpansaoEstatica(container, slug);
  carregarContasExpandidas(slug);
}

function toggleExpandCliente(slug) {
  if (!slug) return;
  const anteriorAntes = EXPANSAO.atual();
  const novoAtual = EXPANSAO.toggle(slug);

  if (anteriorAntes && anteriorAntes !== novoAtual) {
    removerLinhaExpandida(anteriorAntes);
    atualizarChevron(anteriorAntes, false);
  }

  if (novoAtual === slug) {
    abrirLinhaExpandida(slug);
    atualizarChevron(slug, true);
  } else {
    removerLinhaExpandida(slug);
    atualizarChevron(slug, false);
  }
}

// Listeners do "esqueleto" da expansão (mini-form de + Conta) — ligados uma
// única vez quando a linha abre; o conteúdo dinâmico (cards de conta) é
// re-renderizado à parte por carregarContasExpandidas/renderContasMarketplace
// sem recriar este esqueleto (senão os listeners duplicariam a cada refresh).
function wireExpansaoEstatica(container, slug) {
  container.querySelectorAll('[data-action="add-conta"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const mp = btn.getAttribute("data-mp");
      const form = container.querySelector(`[data-form="${mp}"]`);
      const input = form.querySelector('[data-input="nome"]');
      if (mp === "meli") {
        const existentes = (EXPANDIDO_CONTAS.get(slug) || []).filter((c) => c.marketplace === "meli").length;
        input.value = `Mercado Livre ${existentes + 1}`;
      }
      form.style.display = "block";
      input.focus();
      input.select();
    });
  });
  container.querySelectorAll('[data-action="cancelar-conta"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const mp = btn.getAttribute("data-mp");
      container.querySelector(`[data-form="${mp}"]`).style.display = "none";
    });
  });
  container.querySelectorAll('[data-action="salvar-conta"]').forEach((btn) => {
    btn.addEventListener("click", () => criarContaNaExpansao(slug, btn.getAttribute("data-mp")));
  });
}

async function criarContaNaExpansao(slug, marketplace) {
  const container = document.getElementById(`cliente-expand-${slug}`);
  if (!container) return;
  const form = container.querySelector(`[data-form="${marketplace}"]`);
  const input = form.querySelector('[data-input="nome"]');
  const nome = input.value.trim();
  const label = marketplace === "meli" ? "Mercado Livre" : "Shopee";
  if (!nome) { setClientesFeedback(`Informe o nome da conta ${label}.`, "danger"); return; }

  try {
    await apiFetch(`/clientes/${encodeURIComponent(slug)}/contas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marketplace, nome }),
    });
    input.value = "";
    form.style.display = "none";
    await carregarContasExpandidas(slug);
    carregarResumoContas(slug);
    setClientesFeedback(`Conta ${label} "${nome}" criada.`, "success");
  } catch (err) {
    setClientesFeedback(`Erro ao criar conta ${label}: ${err.message}`, "danger");
  }
}

async function carregarContasExpandidas(slug) {
  const container = document.getElementById(`cliente-expand-${slug}`);
  if (!container) return;
  const stateEl = container.querySelector('[data-role="state"]');
  try {
    const data = await apiFetch(`/clientes/${encodeURIComponent(slug)}/contas`);
    const contas = Array.isArray(data.contas) ? data.contas : [];
    EXPANDIDO_CONTAS.set(slug, contas);
    if (stateEl) stateEl.textContent = "";
    renderContasMarketplace(container, "meli", contas.filter((c) => c.marketplace === "meli"));
    renderContasMarketplace(container, "shopee", contas.filter((c) => c.marketplace === "shopee"));
  } catch (err) {
    if (stateEl) stateEl.textContent = `Não foi possível carregar as contas: ${err.message}`;
  }
}

// Recarrega o conteúdo já aberto (sem fechar/reabrir a linha) e a célula de
// resumo do cliente — usado depois de qualquer ação dentro da expansão
// (criar conta, vincular base, conectar/testar/desconectar grant).
async function atualizarAposAcao(slug) {
  await carregarContasExpandidas(slug);
  carregarResumoContas(slug);
}

function renderContasMarketplace(container, marketplace, contas) {
  const list = container.querySelector(`[data-list="${marketplace}"]`);
  const empty = container.querySelector(`[data-empty="${marketplace}"]`);
  if (!list || !empty) return;
  const slug = container.dataset.slug;
  list.innerHTML = "";
  if (!contas.length) { empty.style.display = "block"; return; }
  empty.style.display = "none";

  contas.forEach((conta) => {
    const card = document.createElement("div");
    card.className = "vf-clientes-conta-card";

    const tagPrincipal = conta.is_primary ? `<span class="vf-tag is-primary">Principal</span>` : "";
    const tagAtivo = conta.ativo === false ? `<span class="vf-tag is-danger">Inativa</span>` : "";

    let statusHtml = "";
    let metaHtml = "";
    if (marketplace === "meli") {
      const status = classificarStatusConta(conta);
      statusHtml = `
        <div class="vf-clientes-conta-card__status">
          <span class="vf-status ${status.cls}">${status.symbol} ${escapeHTML(status.label.toUpperCase())}</span>
        </div>`;

      const linhasMeta = [];
      if (conta.grant) {
        linhasMeta.push(`seller ${escapeHTML(conta.grant.ml_user_id || "—")}`);
        linhasMeta.push(`token_status: ${escapeHTML(conta.grant.token_status || "—")}`);
      } else if (conta.external_account_id) {
        // Conta já identificou um seller antes (ex: grant desconectado
        // manualmente), mas hoje não tem grant ativo — o seller esperado
        // continua valendo para a proteção de reconexão.
        linhasMeta.push(`seller ${escapeHTML(conta.external_account_id)} (grant ausente)`);
      }
      if (linhasMeta.length) {
        metaHtml = `<div class="vf-clientes-conta-card__meta">${linhasMeta.join(" · ")}</div>`;
      }
    } else if (conta.ativo !== false) {
      const semBase = !conta.base?.base_id;
      statusHtml = `
        <div class="vf-clientes-conta-card__status">
          <span class="vf-status ${semBase ? "is-warning" : "is-success"}">${semBase ? "⚠ BASE NÃO DEFINIDA" : "● CONFIGURADA"}</span>
        </div>`;
    }

    const baseHtml = conta.base?.base_id
      ? `<span class="vf-tag is-info">Base: ${escapeHTML(conta.base.nome || conta.base.slug || conta.base.base_id)}</span>`
      : `<span class="vf-tag is-neutral">Base não definida</span>`;

    card.innerHTML = `
      <div class="vf-clientes-conta-card__top">
        <span class="vf-clientes-conta-card__nome">${escapeHTML(conta.nome)}</span>
        <div class="vf-clientes-conta-card__tags">${tagPrincipal}${tagAtivo}</div>
      </div>
      ${statusHtml}
      ${metaHtml}
      <div class="vf-clientes-conta-card__base">${baseHtml}</div>
      <div class="vf-clientes-conta-card__actions"></div>
    `;

    const actions = card.querySelector(".vf-clientes-conta-card__actions");

    if (marketplace === "meli" && conta.ativo !== false) {
      const temGrant = !!conta.grant;
      const link = getMlConectarContaLink(conta.id);

      const btnConectar = document.createElement("a");
      btnConectar.className = "vf-btn vf-btn--sm vf-btn--secondary";
      btnConectar.textContent = temGrant ? "Reconectar" : "Conectar";
      btnConectar.href = link;
      btnConectar.target = "_blank";
      btnConectar.rel = "noopener";
      actions.appendChild(btnConectar);

      const btnCopiar = document.createElement("button");
      btnCopiar.className = "vf-btn vf-btn--sm vf-btn--secondary";
      btnCopiar.textContent = "Copiar link";
      btnCopiar.addEventListener("click", () => copiarLinkConta(link, btnCopiar));
      actions.appendChild(btnCopiar);

      if (temGrant) {
        const btnTestar = document.createElement("button");
        btnTestar.className = "vf-btn vf-btn--sm vf-btn--secondary";
        btnTestar.textContent = "Testar grant";
        btnTestar.addEventListener("click", () => testarGrantConta(slug, conta, btnTestar));
        actions.appendChild(btnTestar);
      }
    }

    if (conta.ativo !== false) {
      const btnBase = document.createElement("button");
      btnBase.className = "vf-btn vf-btn--sm vf-btn--secondary";
      btnBase.textContent = conta.base?.base_id ? "Trocar base" : "Definir base";
      btnBase.addEventListener("click", () => abrirBasePicker(slug, conta));
      actions.appendChild(btnBase);
    }

    if (!conta.is_primary && conta.ativo !== false) {
      const btnPrincipal = document.createElement("button");
      btnPrincipal.className = "vf-btn vf-btn--sm vf-btn--secondary";
      btnPrincipal.textContent = "Tornar principal";
      btnPrincipal.addEventListener("click", () => acaoConta(slug, () => apiFetch(`/cliente-contas/${conta.id}/principal`, { method: "PATCH" })));
      actions.appendChild(btnPrincipal);
    }

    const btnToggle = document.createElement("button");
    btnToggle.className = "vf-btn vf-btn--sm vf-btn--secondary";
    btnToggle.textContent = conta.ativo === false ? "Ativar" : "Desativar";
    btnToggle.addEventListener("click", () => acaoConta(slug, () =>
      apiFetch(`/cliente-contas/${conta.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ativo: conta.ativo === false }),
      })
    ));
    actions.appendChild(btnToggle);

    if (marketplace === "meli" && conta.grant) {
      const btnDesconectar = document.createElement("button");
      btnDesconectar.className = "vf-btn vf-btn--sm vf-btn--danger";
      btnDesconectar.textContent = "Desconectar";
      btnDesconectar.addEventListener("click", () => {
        abrirModalConfirmacaoClientes({
          title: "Desconectar conta Mercado Livre",
          subtitle: conta.nome,
          description: `Remove só o grant desta conta (${conta.nome}). As demais contas Mercado Livre deste cliente não são afetadas.`,
          confirmLabel: "Desconectar",
          danger: true,
          onConfirm: () => acaoConta(slug, () => apiFetch(`/cliente-contas/${conta.id}/ml-grant`, { method: "DELETE" })),
        });
      });
      actions.appendChild(btnDesconectar);
    }

    list.appendChild(card);
  });
}

async function testarGrantConta(slug, conta, btn) {
  if (!conta.grant) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Testando…";
  try {
    await apiFetch(`/admin/ml-tokens/${conta.grant.id}/testar`, { method: "POST" });
    setClientesFeedback(`Grant de "${conta.nome}" testado com sucesso.`, "success");
  } catch (err) {
    setClientesFeedback(`Falha ao testar grant de "${conta.nome}": ${err.message}`, "danger");
  } finally {
    await atualizarAposAcao(slug);
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function acaoConta(slug, fn) {
  try {
    await fn();
    await atualizarAposAcao(slug);
  } catch (err) {
    setClientesFeedback(err.message || "Não foi possível concluir a ação.", "danger");
    throw err;
  }
}

// ── MODAL "DEFINIR BASE" / "TROCAR BASE" (item 5 do Fechamento da Fase 1) ──
// Só lista bases do MESMO marketplace da conta (GET /cliente-contas/:id/
// bases-elegiveis, que reaproveita baseVinculosService — nunca duplica a
// regra de compatibilidade, que é validada de novo no backend ao salvar).

async function abrirBasePicker(slug, conta) {
  BASE_PICKER_CONTA = { slug, conta };
  const modal = document.getElementById("vf-base-picker-modal");
  const subtitle = document.getElementById("vf-base-picker-subtitle");
  const loading = document.getElementById("vf-base-picker-loading");
  const field = document.getElementById("vf-base-picker-field");
  const empty = document.getElementById("vf-base-picker-empty");
  const select = document.getElementById("vf-base-picker-select");
  const danger = document.getElementById("vf-base-picker-danger");
  const okBtn = document.getElementById("vf-base-picker-ok");

  document.getElementById("vf-base-picker-title").textContent = conta.base?.base_id ? "Trocar base" : "Definir base";
  subtitle.textContent = `${conta.nome} · ${conta.marketplace === "meli" ? "Mercado Livre" : "Shopee"}`;
  loading.style.display = "block";
  field.style.display = "none";
  empty.style.display = "none";
  danger.style.display = "none";
  danger.textContent = "";
  select.innerHTML = "";
  okBtn.disabled = true;
  modal.classList.add("is-open");

  try {
    const data = await apiFetch(`/cliente-contas/${conta.id}/bases-elegiveis`);
    const bases = Array.isArray(data.bases) ? data.bases : [];
    loading.style.display = "none";
    if (!bases.length) { empty.style.display = "block"; return; }

    field.style.display = "block";
    select.innerHTML = bases.map((b) => {
      const ocupada = b.vinculo && b.vinculo.cliente_slug && b.vinculo.cliente_slug !== slug;
      const rotulo = ocupada ? `${b.nome} (${b.slug}) — hoje em ${b.vinculo.cliente_nome || b.vinculo.cliente_slug}` : `${b.nome} (${b.slug})`;
      return `<option value="${b.id}">${escapeHTML(rotulo)}</option>`;
    }).join("");
    if (conta.base?.base_id) select.value = String(conta.base.base_id);
    okBtn.disabled = false;
  } catch (err) {
    loading.style.display = "none";
    danger.style.display = "block";
    danger.textContent = `Não foi possível carregar as bases elegíveis: ${err.message}`;
  }
}

function fecharBasePicker() {
  document.getElementById("vf-base-picker-modal")?.classList.remove("is-open");
  BASE_PICKER_CONTA = null;
}

async function confirmarBasePicker() {
  if (!BASE_PICKER_CONTA) return;
  const { slug, conta } = BASE_PICKER_CONTA;
  const select = document.getElementById("vf-base-picker-select");
  const okBtn = document.getElementById("vf-base-picker-ok");
  const danger = document.getElementById("vf-base-picker-danger");
  const baseId = select.value;
  if (!baseId) return;

  okBtn.disabled = true;
  okBtn.textContent = "Vinculando…";
  try {
    await apiFetch(`/cliente-contas/${conta.id}/base`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_id: Number(baseId) }),
    });
    setClientesFeedback(`Base vinculada à conta "${conta.nome}".`, "success");
    fecharBasePicker();
    await atualizarAposAcao(slug);
  } catch (err) {
    danger.style.display = "block";
    danger.textContent = err.message || "Não foi possível vincular a base.";
  } finally {
    okBtn.disabled = false;
    okBtn.textContent = "Vincular base";
  }
}

// Slug auto (editável)
let slugTouched = false;
const nomeInput = document.getElementById("cliente-nome");
const slugInput = document.getElementById("cliente-slug");
slugInput.addEventListener("input", () => { slugTouched = slugInput.value.trim().length > 0; });
nomeInput.addEventListener("input", () => {
  if (slugTouched) return;
  slugInput.value = slugify(nomeInput.value);
});

document.getElementById("btn-criar-cliente").addEventListener("click", createCliente);
document.getElementById("btn-retry").addEventListener("click", loadClientes);

document.getElementById("vf-clientes-confirm-close")?.addEventListener("click", fecharModalConfirmacaoClientes);
document.getElementById("vf-clientes-confirm-cancel")?.addEventListener("click", fecharModalConfirmacaoClientes);
document.getElementById("vf-clientes-confirm-ok")?.addEventListener("click", confirmarModalClientes);
document.getElementById("vf-clientes-confirm-modal")?.addEventListener("click", (e) => {
  if (e.target?.id === "vf-clientes-confirm-modal") fecharModalConfirmacaoClientes();
});

document.getElementById("vf-base-picker-close")?.addEventListener("click", fecharBasePicker);
document.getElementById("vf-base-picker-cancel")?.addEventListener("click", fecharBasePicker);
document.getElementById("vf-base-picker-ok")?.addEventListener("click", confirmarBasePicker);
document.getElementById("vf-base-picker-modal")?.addEventListener("click", (e) => {
  if (e.target?.id === "vf-base-picker-modal") fecharBasePicker();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (CLIENTES_CONFIRM_OPEN) fecharModalConfirmacaoClientes();
  else if (BASE_PICKER_CONTA) fecharBasePicker();
});

const buscaInput = document.getElementById("busca-cliente");
if (buscaInput) {
  let debounceTimer;
  buscaInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(filtrarClientes, 300);
  });
}

if (TOKEN) loadClientes();
