// Portal/relatorios.js
// Relatórios — Fundação Global V2.
//   Sidebar de organização (visões rápidas + pastas) · tabela principal ·
//   modal-workspace de detalhe com TODOS os itens carregados (sem paginação),
//   busca por MLB/SKU/título, filtros, ordenação e seletor de colunas.
//
// Nenhum cálculo é feito aqui: LC, MC, preço-alvo, diagnóstico e ação
// recomendada vêm prontos do relatório salvo (dados históricos).

const STORAGE_KEY = "vf-token";
const API_BASE = "https://venforce-server.onrender.com";
const COLUNAS_STORAGE_KEY = "vf-relatorios-colunas-v1";

function getToken() {
  const token = localStorage.getItem(STORAGE_KEY);
  if (!token) {
    window.location.replace("index.html");
    return null;
  }
  return token;
}

const TOKEN = getToken();
const user = JSON.parse(localStorage.getItem("vf-user") || "{}");
const role = String(user.role || "").toLowerCase();
const canAccessAutomacoes =
  role === "admin" || role === "user" || role === "membro";
if (!canAccessAutomacoes) window.location.replace("dashboard.html");
initLayout();

// ═══════════════════════════════════════════════════════════════
// ESTADO
// ═══════════════════════════════════════════════════════════════

let TODOS_RELATORIOS = [];
let RELATORIOS_FILTRADOS = [];
let PASTAS = [];
let CLIENTES_CACHE = [];

// Organização selecionada: visão rápida ou pasta real
let ORG = { tipo: "visao", chave: "todos" };

const HUB_STATE = {
  busca: "",
  cliente: "",
  status: "",
  periodo: "",
  escopo: "",
  margemMin: null,   // fração (0.30)
  margemMax: null,
  mcMin: null,       // fração
  mcMax: null,
  soCriticos: false,
  soSemBase: false,
  sortBy: "data",
  sortOrder: "desc",
  renderToken: 0,
};

// Detalhe do relatório aberto
let RELATORIO_DETALHE_ATUAL_ID = null;
let DETALHE_RELATORIO_ATUAL = null;
let DETALHE_ITENS = [];

const DETALHE_STATE = {
  search: "",
  diagnostico: "todos",
  temBase: "todos",
  statusAnuncio: "todos",
  promocao: "todos",
  mcMin: null,       // fração
  mcMax: null,
  lc: "todos",
  temAlvo: false,
  temAcao: false,
  semFrete: false,
  semComissao: false,
  sortBy: "prioridade",
  sortOrder: "asc",
  visibleColumns: [],
  renderToken: 0,
};

// Modais auxiliares
let BASE_EDITOR_ITEM_ATUAL = null;
let BASE_EDITOR_BASE_SLUG_ATUAL = null;
const BASE_EDITOR_PADRAO_CACHE = new Map(); // baseSlug -> { imposto_percentual, taxa_fixa }
let BASE_EDITOR_TAXA_FIXA_ATUAL = 0;
const ITENS_SALVOS_NA_BASE = new Set();     // item_ids salvos nesta sessão
let MOVER_RELATORIO_ID_ATUAL = null;
let PASTA_MODAL_MODO = null;
let PASTA_MODAL_ID = null;
let PASTA_DELETE_ID = null;
let RELATORIO_DELETE_ID = null;
let DEEPLINK_ABERTO = false;

// ═══════════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════════

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("vf-user");
  window.location.replace("index.html");
}

function escapeHTML(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

const brlFmt = new Intl.NumberFormat("pt-BR", {
  style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const pctFmt = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat("pt-BR");

function fmtMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) ? brlFmt.format(n) : "—";
}
function fmtPctFraction(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${pctFmt.format(n * 100)}%` : "—";
}
function fmtPctNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? `${pctFmt.format(n)}%` : "—";
}
function formatarDataRelatorio(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("pt-BR"); }
  catch (_) { return String(iso); }
}
function formatarDataCurta(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.toLocaleDateString("pt-BR")} ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
}

function debounce(fn, waitMs) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), waitMs);
  };
}

// Percentual digitado (ex.: "25") → fração (0.25); vazio → null
function percentInputParaFracao(valor) {
  const raw = String(valor ?? "").trim();
  if (!raw) return null;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n / 100 : null;
}

function escopoLabel(escopo) {
  const e = String(escopo || "").toLowerCase();
  if (e === "loja_completa") return "Loja completa";
  if (e === "pagina_atual") return "Página atual";
  return escopo || "—";
}

function statusInfo(status) {
  const s = String(status || "").toLowerCase();
  if (s === "concluido") return { label: "Concluído", tone: "success" };
  if (s === "processando") return { label: "Processando", tone: "warning" };
  if (s === "erro") return { label: "Erro", tone: "danger" };
  return { label: status || "—", tone: "" };
}

function pastaIdDoRelatorio(r) {
  const n = Number(r?.pasta_id);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function nomeDaPasta(pastaId) {
  if (pastaId == null) return "Sem pasta";
  const pasta = (Array.isArray(PASTAS) ? PASTAS : []).find((p) => Number(p.id) === Number(pastaId));
  return pasta?.nome || `Pasta ${pastaId}`;
}

// Diagnóstico do item salvo (apenas apresentação — não recalcula nada)
function diagnosticoItemSalvo(item) {
  const temBase = item?.tem_base === true || item?.tem_base === 1 || item?.tem_base === "1";
  const freteNum = Number(item?.frete);
  const comissaoNum = Number(item?.comissao);

  if (!temBase) return { key: "sem_base", label: "Sem base", tone: "" };
  if (!Number.isFinite(freteNum)) return { key: "sem_frete", label: "Sem frete", tone: "warning" };
  if (!Number.isFinite(comissaoNum)) return { key: "sem_comissao", label: "Sem comissão", tone: "warning" };

  const raw = String(item?.diagnostico || "").toLowerCase();
  if (raw === "critico") return { key: "critico", label: "Crítico", tone: "danger" };
  if (raw === "atencao") return { key: "atencao", label: "Atenção", tone: "warning" };
  if (raw === "saudavel") return { key: "saudavel", label: "Saudável", tone: "success" };
  return { key: raw || "sem_dados", label: raw || "Sem dados", tone: "" };
}

const PRIORIDADE_RANK = {
  critico: 0, sem_base: 1, sem_frete: 2, sem_comissao: 3, atencao: 4, saudavel: 5,
};
function prioridadeDoItem(it) {
  const rank = PRIORIDADE_RANK[diagnosticoItemSalvo(it).key];
  return Number.isFinite(rank) ? rank : 6;
}

function itemTemBase(it) {
  return it?.tem_base === true || it?.tem_base === 1 || it?.tem_base === "1";
}

function itemTemPromo(it) {
  const promo = Number(it?.preco_promocional);
  const cheio = Number(it?.preco_original);
  return Number.isFinite(promo) && promo > 0 && Number.isFinite(cheio) && promo < cheio;
}

// ═══════════════════════════════════════════════════════════════
// FEEDBACK (banners)
// ═══════════════════════════════════════════════════════════════

function setBanner(elId, msg, tone) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!msg) { el.hidden = true; el.innerHTML = ""; return; }
  el.className = `vf-banner vf-banner--compact${tone ? " is-" + tone : ""}`;
  el.innerHTML = `<div class="vf-banner__content"><p class="vf-banner__description">${escapeHTML(msg)}</p></div>`;
  el.hidden = false;
}

function setFeedback(msg, tone) {
  const el = document.getElementById("relatorios-feedback");
  if (!el) return;
  if (!msg) { el.hidden = true; el.innerHTML = ""; return; }
  el.className = `vf-banner${tone ? " is-" + tone : ""}`;
  el.innerHTML = `<div class="vf-banner__content"><p class="vf-banner__description">${escapeHTML(msg)}</p></div>`;
  el.hidden = false;
}

// ═══════════════════════════════════════════════════════════════
// MODAIS V2 (overlay + foco + Escape + backdrop + scroll lock)
// ═══════════════════════════════════════════════════════════════

const OVERLAY_STACK = [];
const OVERLAY_FOCUS = new Map();

function abrirOverlay(id) {
  const ov = document.getElementById(id);
  if (!ov || ov.classList.contains("is-open")) return;
  OVERLAY_FOCUS.set(id, document.activeElement);
  ov.classList.add("is-open");
  OVERLAY_STACK.push(id);
  document.body.classList.add("vf-no-scroll");
  const foco = ov.querySelector(
    "input:not([readonly]):not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)"
  );
  if (foco) setTimeout(() => foco.focus(), 30);
}

function fecharOverlay(id) {
  const ov = document.getElementById(id);
  if (!ov || !ov.classList.contains("is-open")) return;
  ov.classList.remove("is-open");
  const idx = OVERLAY_STACK.lastIndexOf(id);
  if (idx >= 0) OVERLAY_STACK.splice(idx, 1);
  if (!OVERLAY_STACK.length) document.body.classList.remove("vf-no-scroll");
  const prev = OVERLAY_FOCUS.get(id);
  OVERLAY_FOCUS.delete(id);
  if (prev && typeof prev.focus === "function") prev.focus();
}

// Mapa: overlay id → função de fechamento (limpa o estado do modal)
const OVERLAY_CLOSERS = {
  "vf-relatorio-detalhe-modal": fecharModalDetalhe,
  "vf-base-custo-rapido-modal": fecharEditorCustoBase,
  "vf-mover-relatorio-modal": fecharModalMoverRelatorio,
  "vf-pasta-modal": fecharModalPasta,
  "vf-pasta-delete-modal": fecharModalExcluirPasta,
  "vf-relatorio-delete-modal": fecharModalExcluirRelatorio,
};

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // 1) fecha menus abertos; 2) fecha drawer de organização; 3) fecha o modal do topo
  if (fecharTodosMenus()) return;
  if (fecharOrgDrawer()) return;
  const topo = OVERLAY_STACK[OVERLAY_STACK.length - 1];
  if (topo) (OVERLAY_CLOSERS[topo] || (() => fecharOverlay(topo)))();
});

// Clique no backdrop fecha o modal correspondente
Object.keys(OVERLAY_CLOSERS).forEach((id) => {
  document.getElementById(id)?.addEventListener("click", (e) => {
    if (e.target?.id === id) OVERLAY_CLOSERS[id]();
  });
});

// ═══════════════════════════════════════════════════════════════
// MENUS "⋯" (uma delegação global — abre/fecha/flip/Escape)
// ═══════════════════════════════════════════════════════════════

function fecharTodosMenus() {
  let fechou = false;
  document.querySelectorAll(".vf-report-menuwrap .vf-menu:not([hidden])").forEach((menu) => {
    menu.hidden = true;
    menu.classList.remove("is-up");
    fechou = true;
  });
  document.querySelectorAll("[data-menu-trigger][aria-expanded='true']").forEach((t) => {
    t.setAttribute("aria-expanded", "false");
  });
  const colMenu = document.getElementById("rd-colunas-menu");
  if (colMenu && !colMenu.hidden) {
    colMenu.hidden = true;
    document.getElementById("rd-colunas-btn")?.setAttribute("aria-expanded", "false");
    fechou = true;
  }
  return fechou;
}

document.addEventListener("click", (e) => {
  const trigger = e.target.closest("[data-menu-trigger]");
  if (trigger) {
    const wrap = trigger.closest(".vf-report-menuwrap");
    const menu = wrap?.querySelector(".vf-menu");
    if (!menu) return;
    const estavaAberto = !menu.hidden;
    fecharTodosMenus();
    if (!estavaAberto) {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      // Não sair da viewport nem do wrapper rolável: abre para cima
      // quando falta espaço abaixo e sobra espaço acima.
      const rect = trigger.getBoundingClientRect();
      const alturaMenu = Math.min(menu.scrollHeight + 12, 280);
      const wrapRect = trigger.closest(".vf-table-wrap")?.getBoundingClientRect();
      const limiteInferior = Math.min(window.innerHeight, wrapRect ? wrapRect.bottom : Infinity);
      const limiteSuperior = wrapRect ? wrapRect.top : 0;
      if (rect.bottom + alturaMenu > limiteInferior && rect.top - alturaMenu > limiteSuperior) {
        menu.classList.add("is-up");
      }
      const primeiro = menu.querySelector(".vf-menu__item:not(:disabled)");
      if (primeiro) primeiro.focus();
    }
    return;
  }
  if (!e.target.closest(".vf-report-menuwrap .vf-menu")) fecharTodosMenus();
});

// ═══════════════════════════════════════════════════════════════
// RENDERIZAÇÃO EM LOTES (sem paginação, sem travar a tela)
// ═══════════════════════════════════════════════════════════════

const RENDER_CHUNK = 250;

function renderLinhasEmLotes({ tbody, linhas, buildRow, hintEl, token, tokenAtual }) {
  tbody.innerHTML = "";
  if (hintEl) hintEl.hidden = linhas.length <= 1000;
  let i = 0;
  const passo = () => {
    if (token !== tokenAtual()) return; // uma nova renderização cancelou esta
    const frag = document.createDocumentFragment();
    const fim = Math.min(i + RENDER_CHUNK, linhas.length);
    for (; i < fim; i++) frag.appendChild(buildRow(linhas[i], i));
    tbody.appendChild(frag);
    if (i < linhas.length) requestAnimationFrame(passo);
    else if (hintEl) hintEl.hidden = true;
  };
  passo();
}

// Comparador com "vazios sempre por último", independente da direção
function compararComVaziosNoFim(va, vb, ordem) {
  const aVazio = va == null || (typeof va === "number" && !Number.isFinite(va)) || va === "";
  const bVazio = vb == null || (typeof vb === "number" && !Number.isFinite(vb)) || vb === "";
  if (aVazio && bVazio) return 0;
  if (aVazio) return 1;
  if (bVazio) return -1;
  let cmp;
  if (typeof va === "string" || typeof vb === "string") {
    cmp = String(va).localeCompare(String(vb), "pt-BR", { numeric: true });
  } else {
    cmp = va < vb ? -1 : (va > vb ? 1 : 0);
  }
  return ordem === "desc" ? -cmp : cmp;
}

// ═══════════════════════════════════════════════════════════════
// SIDEBAR: VISÕES RÁPIDAS + PASTAS
// ═══════════════════════════════════════════════════════════════

const VISOES = [
  { key: "todos", label: "Todos", test: () => true },
  { key: "sem_pasta", label: "Sem pasta", test: (r) => pastaIdDoRelatorio(r) == null },
  { key: "criticos", label: "Com críticos", test: (r) => (Number(r.itens_criticos) || 0) > 0 },
  { key: "sem_base", label: "Com itens sem base", test: (r) => (Number(r.itens_sem_base) || 0) > 0 },
  { key: "processando", label: "Processando", test: (r) => String(r.status || "").toLowerCase() === "processando" },
  { key: "erro", label: "Com erro", test: (r) => String(r.status || "").toLowerCase() === "erro" },
];

function orgLabelAtual() {
  if (ORG.tipo === "pasta") return nomeDaPasta(ORG.chave);
  return VISOES.find((v) => v.key === ORG.chave)?.label || "Todos";
}

function renderSidebar() {
  const viewsNav = document.getElementById("rs-views-nav");
  const pastasNav = document.getElementById("rs-pastas-nav");
  if (!viewsNav || !pastasNav) return;

  const rels = Array.isArray(TODOS_RELATORIOS) ? TODOS_RELATORIOS : [];

  viewsNav.innerHTML = VISOES.map((v) => {
    const count = rels.filter(v.test).length;
    const ativo = ORG.tipo === "visao" && ORG.chave === v.key;
    return `
      <div class="vf-report-nav__row${ativo ? " is-active" : ""}">
        <button type="button" class="vf-report-nav__item" data-org="visao:${escapeHTML(v.key)}" aria-current="${ativo ? "true" : "false"}">
          <span class="vf-report-nav__label">${escapeHTML(v.label)}</span>
          <span class="vf-report-nav__count">${intFmt.format(count)}</span>
        </button>
      </div>`;
  }).join("");

  const contagem = new Map();
  rels.forEach((r) => {
    const pid = pastaIdDoRelatorio(r);
    if (pid != null) contagem.set(pid, (contagem.get(pid) || 0) + 1);
  });

  const pastas = Array.isArray(PASTAS) ? PASTAS : [];
  if (!pastas.length) {
    pastasNav.innerHTML = `<p class="vf-report-nav__empty">Nenhuma pasta criada.</p>`;
  } else {
    pastasNav.innerHTML = pastas.map((p) => {
      const id = Number(p.id);
      const ativo = ORG.tipo === "pasta" && ORG.chave === id;
      const count = contagem.get(id) || 0;
      return `
        <div class="vf-report-nav__row${ativo ? " is-active" : ""}">
          <button type="button" class="vf-report-nav__item" data-org="pasta:${id}" aria-current="${ativo ? "true" : "false"}" title="${escapeHTML(p.nome || "Pasta")}">
            <span class="vf-report-nav__label">${escapeHTML(p.nome || "Pasta")}</span>
            <span class="vf-report-nav__count">${intFmt.format(count)}</span>
          </button>
          <div class="vf-report-menuwrap vf-report-nav__menu">
            <button type="button" class="vf-btn vf-btn--ghost vf-btn--icon vf-btn--sm" data-menu-trigger aria-haspopup="true" aria-expanded="false" aria-label="Ações da pasta ${escapeHTML(p.nome || "")}">⋯</button>
            <div class="vf-menu" hidden>
              <button type="button" class="vf-menu__item" data-acao="pasta-renomear" data-id="${id}">Renomear</button>
              <button type="button" class="vf-menu__item is-danger" data-acao="pasta-excluir" data-id="${id}">Excluir</button>
            </div>
          </div>
        </div>`;
    }).join("");
  }
}

function selecionarOrg(tipo, chave) {
  ORG = { tipo, chave };
  renderSidebar();
  aplicarFiltrosHub();
  fecharOrgDrawer();
}

// Delegação da sidebar (seleção + menu de pasta)
document.getElementById("report-sidebar")?.addEventListener("click", (e) => {
  const acaoBtn = e.target.closest("[data-acao]");
  if (acaoBtn) {
    const id = Number(acaoBtn.getAttribute("data-id"));
    fecharTodosMenus();
    if (acaoBtn.getAttribute("data-acao") === "pasta-renomear") abrirModalPasta("renomear", id);
    if (acaoBtn.getAttribute("data-acao") === "pasta-excluir") abrirModalExcluirPasta(id);
    return;
  }
  const orgBtn = e.target.closest("[data-org]");
  if (!orgBtn) return;
  const [tipo, chave] = String(orgBtn.getAttribute("data-org") || "").split(":");
  if (tipo === "visao") selecionarOrg("visao", chave);
  if (tipo === "pasta") selecionarOrg("pasta", Number(chave));
});

// ─── Drawer de organização (mobile/tablet) ───
function abrirOrgDrawer() {
  const sidebar = document.getElementById("report-sidebar");
  const backdrop = document.getElementById("rs-backdrop");
  const btn = document.getElementById("btn-org-toggle");
  if (!sidebar) return;
  sidebar.classList.add("is-open");
  if (backdrop) { backdrop.hidden = false; backdrop.classList.add("is-open"); }
  if (btn) btn.setAttribute("aria-expanded", "true");
}

function fecharOrgDrawer() {
  const sidebar = document.getElementById("report-sidebar");
  const backdrop = document.getElementById("rs-backdrop");
  const btn = document.getElementById("btn-org-toggle");
  if (!sidebar || !sidebar.classList.contains("is-open")) return false;
  sidebar.classList.remove("is-open");
  if (backdrop) { backdrop.classList.remove("is-open"); backdrop.hidden = true; }
  if (btn) btn.setAttribute("aria-expanded", "false");
  return true;
}

document.getElementById("btn-org-toggle")?.addEventListener("click", () => {
  const sidebar = document.getElementById("report-sidebar");
  if (sidebar?.classList.contains("is-open")) fecharOrgDrawer();
  else abrirOrgDrawer();
});
document.getElementById("rs-backdrop")?.addEventListener("click", fecharOrgDrawer);

// ═══════════════════════════════════════════════════════════════
// CARREGAMENTO
// ═══════════════════════════════════════════════════════════════

function setListState(state, message = "") {
  const loading = document.getElementById("rh-loading");
  const erro = document.getElementById("rh-erro");
  const erroMsg = document.getElementById("rh-erro-msg");
  const vazio = document.getElementById("rh-vazio");
  const wrapper = document.getElementById("rh-wrapper");
  if (!loading || !erro || !vazio || !wrapper) return;

  loading.hidden = state !== "loading";
  erro.hidden = state !== "error";
  vazio.hidden = state !== "empty";
  wrapper.hidden = state !== "table";
  if (state === "error" && erroMsg) erroMsg.textContent = message || "";
}

async function carregarClientesParaFiltro() {
  if (!TOKEN) return;
  try {
    const res = await fetch(`${API_BASE}/automacoes/clientes`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json().catch(() => ({}));
    CLIENTES_CACHE = Array.isArray(json.clientes) ? json.clientes : [];
  } catch (_) {
    CLIENTES_CACHE = [];
  } finally {
    preencherFiltroCliente();
  }
}

function preencherFiltroCliente() {
  const select = document.getElementById("rh-cliente");
  if (!select) return;

  const valorAtual = select.value;
  const mapa = new Map();
  (Array.isArray(CLIENTES_CACHE) ? CLIENTES_CACHE : []).forEach((c) => {
    const slug = String(c.slug || "").trim();
    if (slug) mapa.set(slug, c.nome || slug);
  });
  (Array.isArray(TODOS_RELATORIOS) ? TODOS_RELATORIOS : []).forEach((r) => {
    const slug = String(r.cliente_slug || "").trim();
    if (slug && !mapa.has(slug)) mapa.set(slug, slug);
  });

  const itens = Array.from(mapa.entries())
    .map(([slug, nome]) => ({ slug, nome }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

  select.innerHTML = `<option value="">Cliente: todos</option>`;
  itens.forEach((item) => select.appendChild(new Option(item.nome, item.slug)));
  if (valorAtual && itens.some((i) => i.slug === valorAtual)) select.value = valorAtual;
}

async function carregarPastas() {
  if (!TOKEN) return;
  try {
    const res = await fetch(`${API_BASE}/relatorios/pastas`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) throw new Error(json?.erro || `HTTP ${res.status}`);

    PASTAS = Array.isArray(json.pastas) ? json.pastas : [];
    if (ORG.tipo === "pasta" && !PASTAS.some((p) => Number(p.id) === ORG.chave)) {
      ORG = { tipo: "visao", chave: "todos" };
    }
    renderSidebar();
  } catch (err) {
    PASTAS = [];
    renderSidebar();
    setFeedback(`Erro ao carregar pastas: ${err?.message || "desconhecido"}`, "danger");
  }
}

async function carregarRelatorios() {
  if (!TOKEN) return;
  setFeedback("");
  setListState("loading");

  try {
    const res = await fetch(`${API_BASE}/automacoes/relatorios`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) throw new Error(json?.erro || `HTTP ${res.status}`);

    TODOS_RELATORIOS = Array.isArray(json.relatorios) ? json.relatorios : [];
    preencherFiltroCliente();
    renderSidebar();
    aplicarFiltrosHub();
    abrirDeepLinkSeNecessario();
  } catch (err) {
    TODOS_RELATORIOS = [];
    RELATORIOS_FILTRADOS = [];
    renderSidebar();
    setListState("error", err?.message || "desconhecido");
  }
}

// ═══════════════════════════════════════════════════════════════
// FILTROS + ORDENAÇÃO DA TELA PRINCIPAL
// ═══════════════════════════════════════════════════════════════

function lerFiltrosHubDoDom() {
  HUB_STATE.busca = (document.getElementById("rh-busca")?.value || "").trim().toLowerCase();
  HUB_STATE.cliente = (document.getElementById("rh-cliente")?.value || "").trim().toLowerCase();
  HUB_STATE.status = (document.getElementById("rh-status")?.value || "").trim().toLowerCase();
  HUB_STATE.periodo = document.getElementById("rh-periodo")?.value || "";
  HUB_STATE.escopo = (document.getElementById("rh-adv-escopo")?.value || "").trim().toLowerCase();
  HUB_STATE.margemMin = percentInputParaFracao(document.getElementById("rh-margem-min")?.value);
  HUB_STATE.margemMax = percentInputParaFracao(document.getElementById("rh-margem-max")?.value);
  HUB_STATE.mcMin = percentInputParaFracao(document.getElementById("rh-mc-min")?.value);
  HUB_STATE.mcMax = percentInputParaFracao(document.getElementById("rh-mc-max")?.value);
  HUB_STATE.soCriticos = Boolean(document.getElementById("rh-so-criticos")?.checked);
  HUB_STATE.soSemBase = Boolean(document.getElementById("rh-so-sembase")?.checked);
}

const HUB_SORT_GETTERS = {
  id: (r) => Number(r.id) || 0,
  cliente: (r) => String(r.cliente_slug || ""),
  data: (r) => { const t = new Date(r.created_at || 0).getTime(); return Number.isFinite(t) ? t : null; },
  escopo: (r) => String(r.escopo || ""),
  status: (r) => String(r.status || ""),
  total: (r) => Number(r.total_itens) || 0,
  criticos: (r) => Number(r.itens_criticos) || 0,
  sem_base: (r) => Number(r.itens_sem_base) || 0,
  mc: (r) => { const n = Number(r.mc_media); return Number.isFinite(n) ? n : null; },
  pasta: (r) => nomeDaPasta(pastaIdDoRelatorio(r)),
};

function aplicarFiltrosHub() {
  lerFiltrosHubDoDom();
  const s = HUB_STATE;

  const testeOrg = ORG.tipo === "pasta"
    ? (r) => pastaIdDoRelatorio(r) === ORG.chave
    : (VISOES.find((v) => v.key === ORG.chave)?.test || (() => true));

  const limitePeriodo = s.periodo
    ? Date.now() - Number(s.periodo) * 86400000
    : null;

  RELATORIOS_FILTRADOS = (Array.isArray(TODOS_RELATORIOS) ? TODOS_RELATORIOS : []).filter((r) => {
    if (!testeOrg(r)) return false;
    if (s.cliente && String(r.cliente_slug || "").toLowerCase() !== s.cliente) return false;
    if (s.status && String(r.status || "").toLowerCase() !== s.status) return false;
    if (s.escopo && String(r.escopo || "").toLowerCase() !== s.escopo) return false;

    if (limitePeriodo != null) {
      const t = new Date(r.created_at || 0).getTime();
      if (!Number.isFinite(t) || t < limitePeriodo) return false;
    }

    const margem = Number(r.margem_alvo);
    if (s.margemMin != null && !(Number.isFinite(margem) && margem >= s.margemMin)) return false;
    if (s.margemMax != null && !(Number.isFinite(margem) && margem <= s.margemMax)) return false;

    const mc = Number(r.mc_media);
    if (s.mcMin != null && !(Number.isFinite(mc) && mc >= s.mcMin)) return false;
    if (s.mcMax != null && !(Number.isFinite(mc) && mc <= s.mcMax)) return false;

    if (s.soCriticos && !((Number(r.itens_criticos) || 0) > 0)) return false;
    if (s.soSemBase && !((Number(r.itens_sem_base) || 0) > 0)) return false;

    if (s.busca) {
      const haystack = [
        r.id, r.cliente_slug, r.base_slug, r.escopo,
        nomeDaPasta(pastaIdDoRelatorio(r)), r.observacoes,
      ].map((x) => String(x || "").toLowerCase()).join(" ");
      if (!haystack.includes(s.busca)) return false;
    }
    return true;
  });

  const getter = HUB_SORT_GETTERS[s.sortBy] || HUB_SORT_GETTERS.data;
  RELATORIOS_FILTRADOS.sort((a, b) => compararComVaziosNoFim(getter(a), getter(b), s.sortOrder));

  renderHub();
}

function contarFiltrosAvancadosHub() {
  const s = HUB_STATE;
  let n = 0;
  if (s.escopo) n++;
  if (s.margemMin != null) n++;
  if (s.margemMax != null) n++;
  if (s.mcMin != null) n++;
  if (s.mcMax != null) n++;
  if (s.soCriticos) n++;
  if (s.soSemBase) n++;
  return n;
}

function limparFiltrosHub() {
  ["rh-busca", "rh-margem-min", "rh-margem-max", "rh-mc-min", "rh-mc-max"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  ["rh-cliente", "rh-status", "rh-periodo", "rh-adv-escopo"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  ["rh-so-criticos", "rh-so-sembase"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.checked = false;
  });
  aplicarFiltrosHub();
}

function renderFiltrosAtivosHub() {
  const el = document.getElementById("rh-active-filters");
  const advBtn = document.getElementById("rh-adv-toggle");
  if (!el) return;

  const s = HUB_STATE;
  const chips = [];
  const add = (chave, label) => chips.push({ chave, label });

  if (s.busca) add("busca", `Busca: "${s.busca}"`);
  if (s.cliente) add("cliente", `Cliente: ${s.cliente}`);
  if (s.status) add("status", `Status: ${statusInfo(s.status).label}`);
  if (s.periodo) add("periodo", `Período: ${s.periodo === "1" ? "hoje" : `últimos ${s.periodo} dias`}`);
  if (s.escopo) add("escopo", `Escopo: ${escopoLabel(s.escopo)}`);
  if (s.margemMin != null) add("margem-min", `Margem ≥ ${pctFmt.format(s.margemMin * 100)}%`);
  if (s.margemMax != null) add("margem-max", `Margem ≤ ${pctFmt.format(s.margemMax * 100)}%`);
  if (s.mcMin != null) add("mc-min", `MC ≥ ${pctFmt.format(s.mcMin * 100)}%`);
  if (s.mcMax != null) add("mc-max", `MC ≤ ${pctFmt.format(s.mcMax * 100)}%`);
  if (s.soCriticos) add("so-criticos", "Somente com críticos");
  if (s.soSemBase) add("so-sembase", "Somente com itens sem base");

  const advCount = contarFiltrosAvancadosHub();
  if (advBtn) advBtn.textContent = advCount > 0 ? `Filtros avançados (${advCount})` : "Filtros avançados";

  if (!chips.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = chips.map((c) => `
    <span class="vf-active-filter">${escapeHTML(c.label)}
      <button type="button" class="vf-active-filter__remove" data-clear-hub="${escapeHTML(c.chave)}" aria-label="Remover filtro ${escapeHTML(c.label)}">✕</button>
    </span>`).join("") +
    `<button type="button" class="vf-clear-filters" data-clear-hub="__todos__">Limpar filtros</button>`;
}

document.getElementById("rh-active-filters")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-clear-hub]");
  if (!btn) return;
  const chave = btn.getAttribute("data-clear-hub");
  if (chave === "__todos__") { limparFiltrosHub(); return; }
  const mapa = {
    "busca": () => { document.getElementById("rh-busca").value = ""; },
    "cliente": () => { document.getElementById("rh-cliente").value = ""; },
    "status": () => { document.getElementById("rh-status").value = ""; },
    "periodo": () => { document.getElementById("rh-periodo").value = ""; },
    "escopo": () => { document.getElementById("rh-adv-escopo").value = ""; },
    "margem-min": () => { document.getElementById("rh-margem-min").value = ""; },
    "margem-max": () => { document.getElementById("rh-margem-max").value = ""; },
    "mc-min": () => { document.getElementById("rh-mc-min").value = ""; },
    "mc-max": () => { document.getElementById("rh-mc-max").value = ""; },
    "so-criticos": () => { document.getElementById("rh-so-criticos").checked = false; },
    "so-sembase": () => { document.getElementById("rh-so-sembase").checked = false; },
  };
  mapa[chave]?.();
  aplicarFiltrosHub();
});

// ═══════════════════════════════════════════════════════════════
// RESUMO COMPACTO + TABELA PRINCIPAL
// ═══════════════════════════════════════════════════════════════

function renderResumoHub() {
  const el = document.getElementById("rh-summary");
  if (!el) return;
  const rels = RELATORIOS_FILTRADOS;

  const concluidos = rels.filter((r) => String(r.status || "").toLowerCase() === "concluido").length;
  const processando = rels.filter((r) => String(r.status || "").toLowerCase() === "processando").length;
  const criticos = rels.reduce((acc, r) => acc + (Number(r.itens_criticos) || 0), 0);
  const semBase = rels.reduce((acc, r) => acc + (Number(r.itens_sem_base) || 0), 0);
  const mcVals = rels.map((r) => Number(r.mc_media)).filter(Number.isFinite);
  const mcMedia = mcVals.length ? mcVals.reduce((a, b) => a + b, 0) / mcVals.length : null;

  const item = (value, label, tone) => `
    <span class="vf-report-summary__item${tone ? " is-" + tone : ""}">
      <strong class="vf-report-summary__value">${escapeHTML(value)}</strong>
      <span class="vf-report-summary__label">${escapeHTML(label)}</span>
    </span>`;

  el.innerHTML = [
    item(intFmt.format(rels.length), rels.length === 1 ? "relatório" : "relatórios"),
    item(intFmt.format(concluidos), "concluídos"),
    item(intFmt.format(processando), "processando", processando > 0 ? "warning" : ""),
    item(intFmt.format(criticos), "críticos", criticos > 0 ? "danger" : ""),
    item(intFmt.format(semBase), "sem base", semBase > 0 ? "warning" : ""),
    item(mcMedia == null ? "—" : `${pctFmt.format(mcMedia * 100)}%`, "MC média"),
  ].join(`<span class="vf-report-summary__sep" aria-hidden="true">·</span>`);
}

const HUB_COLS = [
  { key: "id", label: "ID", sort: "id" },
  { key: "cliente", label: "Cliente / Base", sort: "cliente" },
  { key: "data", label: "Data", sort: "data" },
  { key: "escopo", label: "Escopo", sort: "escopo" },
  { key: "status", label: "Status", sort: "status" },
  { key: "total", label: "Total", sort: "total", num: true },
  { key: "criticos", label: "Críticos", sort: "criticos", num: true },
  { key: "sem_base", label: "Sem base", sort: "sem_base", num: true },
  { key: "mc", label: "MC média", sort: "mc", num: true },
  { key: "pasta", label: "Pasta", sort: "pasta" },
  { key: "acoes", label: "Ações" },
];

function renderHubHead() {
  const thead = document.getElementById("rh-thead");
  if (!thead) return;
  thead.innerHTML = `<tr>${HUB_COLS.map((c) => {
    const numCls = c.num ? " class=\"num\"" : "";
    if (!c.sort) return `<th${numCls}>${escapeHTML(c.label)}</th>`;
    const ativo = HUB_STATE.sortBy === c.sort;
    const dir = ativo ? (HUB_STATE.sortOrder === "asc" ? "is-asc" : "is-desc") : "";
    const ariaSort = ativo ? (HUB_STATE.sortOrder === "asc" ? "ascending" : "descending") : "none";
    return `<th${numCls} aria-sort="${ariaSort}"><button type="button" class="vf-table__sort ${dir}" data-sort-hub="${escapeHTML(c.sort)}">${escapeHTML(c.label)}</button></th>`;
  }).join("")}</tr>`;
}

document.getElementById("rh-thead")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-sort-hub]");
  if (!btn) return;
  const campo = btn.getAttribute("data-sort-hub");
  if (HUB_STATE.sortBy === campo) {
    HUB_STATE.sortOrder = HUB_STATE.sortOrder === "asc" ? "desc" : "asc";
  } else {
    HUB_STATE.sortBy = campo;
    HUB_STATE.sortOrder = campo === "cliente" || campo === "escopo" || campo === "status" || campo === "pasta" ? "asc" : "desc";
  }
  const select = document.getElementById("rh-ordenacao");
  if (select) {
    const alvo = `${HUB_STATE.sortBy}:${HUB_STATE.sortOrder}`;
    select.value = Array.from(select.options).some((o) => o.value === alvo) ? alvo : select.value;
  }
  aplicarFiltrosHub();
});

function buildHubRow(r) {
  const st = statusInfo(r.status);
  const mcNum = Number(r.mc_media);
  const mcCls = Number.isFinite(mcNum) ? (mcNum < 0 ? " is-neg" : (mcNum > 0 ? " is-pos" : "")) : "";
  const pastaId = pastaIdDoRelatorio(r);
  const idTxt = String(r.id || "");

  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td class="vf-mono">#${escapeHTML(idTxt)}</td>
    <td>
      <div class="vf-report-cellclient">
        <strong>${escapeHTML(r.cliente_slug || "—")}</strong>
        <span class="vf-mono vf-report-cellclient__base">${escapeHTML(r.base_slug || "—")}</span>
      </div>
    </td>
    <td class="vf-report-nowrap">${escapeHTML(formatarDataCurta(r.created_at))}</td>
    <td>${escapeHTML(escopoLabel(r.escopo))}</td>
    <td><span class="vf-status${st.tone ? " is-" + st.tone : ""}">${escapeHTML(st.label)}</span></td>
    <td class="num">${escapeHTML(intFmt.format(Number(r.total_itens) || 0))}</td>
    <td class="num${(Number(r.itens_criticos) || 0) > 0 ? " is-neg" : ""}">${escapeHTML(intFmt.format(Number(r.itens_criticos) || 0))}</td>
    <td class="num">${escapeHTML(intFmt.format(Number(r.itens_sem_base) || 0))}</td>
    <td class="num${mcCls}">${escapeHTML(fmtPctFraction(r.mc_media))}</td>
    <td class="vf-truncate vf-report-cellpasta" title="${escapeHTML(nomeDaPasta(pastaId))}">${escapeHTML(nomeDaPasta(pastaId))}</td>
    <td>
      <div class="vf-report-rowactions">
        <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-acao="abrir" data-id="${escapeHTML(idTxt)}">Abrir</button>
        <div class="vf-report-menuwrap">
          <button type="button" class="vf-btn vf-btn--ghost vf-btn--icon vf-btn--sm" data-menu-trigger aria-haspopup="true" aria-expanded="false" aria-label="Mais ações do relatório #${escapeHTML(idTxt)}">⋯</button>
          <div class="vf-menu" hidden>
            <button type="button" class="vf-menu__item" data-acao="xlsx" data-id="${escapeHTML(idTxt)}">Baixar XLSX</button>
            <button type="button" class="vf-menu__item" data-acao="csv" data-id="${escapeHTML(idTxt)}">Baixar CSV</button>
            <button type="button" class="vf-menu__item" data-acao="mover" data-id="${escapeHTML(idTxt)}">Mover para pasta</button>
            <div class="vf-menu__separator"></div>
            <button type="button" class="vf-menu__item is-danger" data-acao="excluir" data-id="${escapeHTML(idTxt)}">Excluir</button>
          </div>
        </div>
      </div>
    </td>`;
  return tr;
}

document.getElementById("rh-tbody")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-acao]");
  if (!btn) return;
  const id = btn.getAttribute("data-id");
  const acao = btn.getAttribute("data-acao");
  if (!id) return;
  if (acao !== "abrir") fecharTodosMenus();
  if (acao === "abrir") abrirDetalheRelatorio(id);
  if (acao === "xlsx") baixarRelatorio(id, "xlsx");
  if (acao === "csv") baixarRelatorio(id, "csv");
  if (acao === "mover") abrirModalMoverRelatorio(id);
  if (acao === "excluir") abrirModalExcluirRelatorio(id);
});

function renderHub() {
  const scopeTitle = document.getElementById("rh-scope-title");
  const scopeCount = document.getElementById("rh-scope-count");
  if (scopeTitle) scopeTitle.textContent = orgLabelAtual();
  if (scopeCount) {
    scopeCount.hidden = false;
    scopeCount.textContent = intFmt.format(RELATORIOS_FILTRADOS.length);
  }

  renderResumoHub();
  renderFiltrosAtivosHub();

  if (!TODOS_RELATORIOS.length && !RELATORIOS_FILTRADOS.length) {
    setListState("empty");
    return;
  }
  if (!RELATORIOS_FILTRADOS.length) {
    setListState("empty");
    return;
  }

  setListState("table");
  renderHubHead();

  HUB_STATE.renderToken += 1;
  const token = HUB_STATE.renderToken;
  renderLinhasEmLotes({
    tbody: document.getElementById("rh-tbody"),
    linhas: RELATORIOS_FILTRADOS,
    buildRow: buildHubRow,
    hintEl: document.getElementById("rh-render-hint"),
    token,
    tokenAtual: () => HUB_STATE.renderToken,
  });
}

// ─── Listeners da toolbar principal ───
const aplicarFiltrosHubDebounced = debounce(aplicarFiltrosHub, 250);
document.getElementById("rh-busca")?.addEventListener("input", aplicarFiltrosHubDebounced);
["rh-cliente", "rh-status", "rh-periodo", "rh-adv-escopo"].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", aplicarFiltrosHub);
});
["rh-margem-min", "rh-margem-max", "rh-mc-min", "rh-mc-max"].forEach((id) => {
  document.getElementById(id)?.addEventListener("input", aplicarFiltrosHubDebounced);
});
["rh-so-criticos", "rh-so-sembase"].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", aplicarFiltrosHub);
});

document.getElementById("rh-ordenacao")?.addEventListener("change", (e) => {
  const [campo, ordem] = String(e.target.value || "data:desc").split(":");
  HUB_STATE.sortBy = campo || "data";
  HUB_STATE.sortOrder = ordem === "asc" ? "asc" : "desc";
  aplicarFiltrosHub();
});

document.getElementById("rh-adv-toggle")?.addEventListener("click", () => {
  const panel = document.getElementById("rh-adv-panel");
  const btn = document.getElementById("rh-adv-toggle");
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (btn) btn.setAttribute("aria-expanded", String(!panel.hidden));
});

document.getElementById("rh-erro-retry")?.addEventListener("click", carregarRelatorios);
document.getElementById("btn-atualizar-relatorios")?.addEventListener("click", () => {
  carregarPastas();
  carregarRelatorios();
});
document.getElementById("btn-nova-pasta-header")?.addEventListener("click", () => abrirModalPasta("criar"));
document.getElementById("btn-nova-pasta")?.addEventListener("click", () => abrirModalPasta("criar"));

// ═══════════════════════════════════════════════════════════════
// EXPORTAÇÕES
// ═══════════════════════════════════════════════════════════════

async function baixarRelatorio(id, formato) {
  if (!TOKEN || !id) return;
  const fmt = formato === "xlsx" ? "xlsx" : "csv";
  try {
    const res = await fetch(`${API_BASE}/automacoes/relatorios/${encodeURIComponent(id)}/export/${fmt}`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const disp = res.headers.get("content-disposition") || "";
    const nomeMatch = disp.match(/filename="?([^"]+)"?/i);
    const filename = nomeMatch?.[1] || `relatorio-${id}.${fmt}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    setFeedback(`Erro ao exportar relatório: ${err?.message || "desconhecido"}`, "danger");
  }
}

// ═══════════════════════════════════════════════════════════════
// EXCLUIR RELATÓRIO (modal V2 no lugar de window.confirm)
// ═══════════════════════════════════════════════════════════════

function abrirModalExcluirRelatorio(id) {
  RELATORIO_DELETE_ID = id;
  setBanner("vf-relatorio-delete-feedback", "");
  const sub = document.getElementById("vf-relatorio-delete-sub");
  if (sub) sub.textContent = `#${id}`;
  abrirOverlay("vf-relatorio-delete-modal");
}

function fecharModalExcluirRelatorio() {
  fecharOverlay("vf-relatorio-delete-modal");
  setBanner("vf-relatorio-delete-feedback", "");
  RELATORIO_DELETE_ID = null;
}

async function confirmarExcluirRelatorio() {
  if (!TOKEN || !RELATORIO_DELETE_ID) return;
  const id = RELATORIO_DELETE_ID;
  const btn = document.getElementById("vf-relatorio-delete-confirm");
  const labelOriginal = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Excluindo…"; }

  try {
    const res = await fetch(`${API_BASE}/automacoes/relatorios/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) throw new Error(json?.erro || `HTTP ${res.status}`);

    fecharModalExcluirRelatorio();
    setFeedback(`Relatório #${id} excluído com sucesso.`, "success");
    await Promise.all([carregarPastas(), carregarRelatorios()]);
  } catch (err) {
    setBanner("vf-relatorio-delete-feedback", `Erro ao excluir: ${err?.message || "desconhecido"}`, "danger");
  } finally {
    if (btn) { btn.disabled = false; if (labelOriginal) btn.textContent = labelOriginal; }
  }
}

document.getElementById("vf-relatorio-delete-close")?.addEventListener("click", fecharModalExcluirRelatorio);
document.getElementById("vf-relatorio-delete-cancel")?.addEventListener("click", fecharModalExcluirRelatorio);
document.getElementById("vf-relatorio-delete-confirm")?.addEventListener("click", confirmarExcluirRelatorio);

// ═══════════════════════════════════════════════════════════════
// MOVER RELATÓRIO
// ═══════════════════════════════════════════════════════════════

function abrirModalMoverRelatorio(relatorioId) {
  const select = document.getElementById("vf-mover-relatorio-select");
  const sub = document.getElementById("vf-mover-relatorio-sub");
  if (!select) return;

  MOVER_RELATORIO_ID_ATUAL = relatorioId;
  setBanner("vf-mover-relatorio-feedback", "");
  if (sub) sub.textContent = `#${relatorioId}`;

  const pastas = Array.isArray(PASTAS) ? PASTAS : [];
  select.innerHTML = [
    `<option value="">Sem pasta</option>`,
    ...pastas.map((p) => `<option value="${escapeHTML(String(p.id))}">${escapeHTML(p.nome || `Pasta ${p.id}`)}</option>`),
  ].join("");

  const rel = (Array.isArray(TODOS_RELATORIOS) ? TODOS_RELATORIOS : []).find((r) => String(r.id) === String(relatorioId));
  const pastaAtual = pastaIdDoRelatorio(rel);
  select.value = pastaAtual != null ? String(pastaAtual) : "";

  abrirOverlay("vf-mover-relatorio-modal");
}

function fecharModalMoverRelatorio() {
  fecharOverlay("vf-mover-relatorio-modal");
  setBanner("vf-mover-relatorio-feedback", "");
  MOVER_RELATORIO_ID_ATUAL = null;
}

async function moverRelatorioParaPasta(relatorioId, pastaId) {
  if (!TOKEN || !relatorioId) return;
  const res = await fetch(`${API_BASE}/relatorios/${encodeURIComponent(relatorioId)}/pasta`, {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pastaId: pastaId == null ? null : pastaId }),
  });
  if (res.status === 401) { clearSession(); return; }
  if (res.status === 403) { window.location.replace("dashboard.html"); return; }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.ok) throw new Error(json?.erro || `HTTP ${res.status}`);
}

async function confirmarMoverRelatorio() {
  if (!TOKEN || !MOVER_RELATORIO_ID_ATUAL) return;
  const select = document.getElementById("vf-mover-relatorio-select");
  const saveBtn = document.getElementById("vf-mover-relatorio-save");
  const id = MOVER_RELATORIO_ID_ATUAL;
  const pastaIdValor = select?.value ? Number(select.value) : null;

  try {
    setBanner("vf-mover-relatorio-feedback", "");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Movendo…"; }
    await moverRelatorioParaPasta(id, pastaIdValor);
    fecharModalMoverRelatorio();
    setFeedback("Relatório movido com sucesso.", "success");
    await Promise.all([carregarPastas(), carregarRelatorios()]);
  } catch (err) {
    setBanner("vf-mover-relatorio-feedback", `Erro ao mover: ${err?.message || "desconhecido"}`, "danger");
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Mover"; }
  }
}

document.getElementById("vf-mover-relatorio-close")?.addEventListener("click", fecharModalMoverRelatorio);
document.getElementById("vf-mover-relatorio-cancel")?.addEventListener("click", fecharModalMoverRelatorio);
document.getElementById("vf-mover-relatorio-save")?.addEventListener("click", confirmarMoverRelatorio);

// ═══════════════════════════════════════════════════════════════
// PASTAS (criar / renomear / excluir)
// ═══════════════════════════════════════════════════════════════

function abrirModalPasta(modo, id = null) {
  const titulo = document.getElementById("vf-pasta-modal-titulo");
  const sub = document.getElementById("vf-pasta-modal-sub");
  const inputNome = document.getElementById("vf-pasta-modal-nome");
  const inputDesc = document.getElementById("vf-pasta-modal-descricao");
  const descWrap = document.getElementById("vf-pasta-modal-desc-wrap");
  const btnSave = document.getElementById("vf-pasta-modal-save");
  if (!inputNome) return;

  PASTA_MODAL_MODO = modo === "renomear" ? "renomear" : "criar";
  PASTA_MODAL_ID = PASTA_MODAL_MODO === "renomear" ? Number(id) : null;
  setBanner("vf-pasta-modal-feedback", "");

  if (PASTA_MODAL_MODO === "renomear") {
    const pasta = (Array.isArray(PASTAS) ? PASTAS : []).find((p) => Number(p.id) === PASTA_MODAL_ID);
    if (!pasta) return;
    if (titulo) titulo.textContent = "Renomear pasta";
    if (sub) sub.textContent = "Atualize o nome da pasta.";
    if (btnSave) btnSave.textContent = "Salvar alterações";
    if (descWrap) descWrap.hidden = true;
    inputNome.value = pasta.nome || "";
    if (inputDesc) inputDesc.value = "";
  } else {
    if (titulo) titulo.textContent = "Nova pasta";
    if (sub) sub.textContent = "Organize seus relatórios em pastas.";
    if (btnSave) btnSave.textContent = "Criar pasta";
    if (descWrap) descWrap.hidden = false;
    inputNome.value = "";
    if (inputDesc) inputDesc.value = "";
  }

  abrirOverlay("vf-pasta-modal");
}

function fecharModalPasta() {
  fecharOverlay("vf-pasta-modal");
  setBanner("vf-pasta-modal-feedback", "");
  PASTA_MODAL_MODO = null;
  PASTA_MODAL_ID = null;
}

async function salvarPastaModal() {
  if (!TOKEN || !PASTA_MODAL_MODO) return;
  const inputNome = document.getElementById("vf-pasta-modal-nome");
  const inputDesc = document.getElementById("vf-pasta-modal-descricao");
  const btnSave = document.getElementById("vf-pasta-modal-save");
  const nomeTrim = String(inputNome?.value || "").trim();
  if (!nomeTrim) {
    setBanner("vf-pasta-modal-feedback", "O nome da pasta é obrigatório.", "danger");
    inputNome?.focus();
    return;
  }

  const modo = PASTA_MODAL_MODO;
  const id = PASTA_MODAL_ID;
  const labelOriginal = btnSave?.textContent;
  if (btnSave) {
    btnSave.disabled = true;
    btnSave.textContent = modo === "renomear" ? "Salvando…" : "Criando…";
  }

  try {
    let res;
    if (modo === "renomear") {
      res = await fetch(`${API_BASE}/relatorios/pastas/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ nome: nomeTrim }),
      });
    } else {
      const descricaoTrim = String(inputDesc?.value || "").trim();
      res = await fetch(`${API_BASE}/relatorios/pastas`, {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ nome: nomeTrim, descricao: descricaoTrim || null }),
      });
    }
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) throw new Error(json?.erro || `HTTP ${res.status}`);

    fecharModalPasta();
    setFeedback(
      modo === "renomear" ? "Pasta renomeada com sucesso." : `Pasta "${nomeTrim}" criada com sucesso.`,
      "success"
    );
    await carregarPastas();
    aplicarFiltrosHub();
  } catch (err) {
    const acao = modo === "renomear" ? "renomear" : "criar";
    setBanner("vf-pasta-modal-feedback", `Erro ao ${acao} pasta: ${err?.message || "desconhecido"}`, "danger");
  } finally {
    if (btnSave) {
      btnSave.disabled = false;
      if (labelOriginal) btnSave.textContent = labelOriginal;
    }
  }
}

function abrirModalExcluirPasta(id) {
  const sub = document.getElementById("vf-pasta-delete-sub");
  const pasta = (Array.isArray(PASTAS) ? PASTAS : []).find((p) => Number(p.id) === Number(id));
  if (!pasta) return;
  PASTA_DELETE_ID = Number(id);
  setBanner("vf-pasta-delete-feedback", "");
  if (sub) sub.textContent = pasta.nome || `#${id}`;
  abrirOverlay("vf-pasta-delete-modal");
}

function fecharModalExcluirPasta() {
  fecharOverlay("vf-pasta-delete-modal");
  setBanner("vf-pasta-delete-feedback", "");
  PASTA_DELETE_ID = null;
}

async function confirmarExcluirPasta() {
  if (!TOKEN || !PASTA_DELETE_ID) return;
  const id = PASTA_DELETE_ID;
  const btn = document.getElementById("vf-pasta-delete-confirm");
  const labelOriginal = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Excluindo…"; }

  try {
    const res = await fetch(`${API_BASE}/relatorios/pastas/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      const msg = String(json?.erro || `HTTP ${res.status}`);
      if (msg.includes("Não é possível excluir uma pasta com relatórios")) {
        throw new Error("Essa pasta ainda possui relatórios. Mova ou remova os relatórios antes de excluir.");
      }
      throw new Error(msg);
    }

    if (ORG.tipo === "pasta" && ORG.chave === Number(id)) {
      ORG = { tipo: "visao", chave: "todos" };
    }
    fecharModalExcluirPasta();
    setFeedback("Pasta excluída com sucesso.", "success");
    await carregarPastas();
    aplicarFiltrosHub();
  } catch (err) {
    setBanner("vf-pasta-delete-feedback", `Erro ao excluir pasta: ${err?.message || "desconhecido"}`, "danger");
  } finally {
    if (btn) { btn.disabled = false; if (labelOriginal) btn.textContent = labelOriginal; }
  }
}

document.getElementById("vf-pasta-modal-close")?.addEventListener("click", fecharModalPasta);
document.getElementById("vf-pasta-modal-cancel")?.addEventListener("click", fecharModalPasta);
document.getElementById("vf-pasta-modal-save")?.addEventListener("click", salvarPastaModal);
document.getElementById("vf-pasta-modal-nome")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    salvarPastaModal();
  }
});
document.getElementById("vf-pasta-delete-close")?.addEventListener("click", fecharModalExcluirPasta);
document.getElementById("vf-pasta-delete-cancel")?.addEventListener("click", fecharModalExcluirPasta);
document.getElementById("vf-pasta-delete-confirm")?.addEventListener("click", confirmarExcluirPasta);

// ═══════════════════════════════════════════════════════════════
// DETALHE DO RELATÓRIO — COLUNAS
// ═══════════════════════════════════════════════════════════════

// required: sempre visível (não aparece no seletor)
// default:  visível por padrão, pode ser desligada
// (as demais começam desligadas)
const RD_COLS = [
  { key: "mlb", label: "MLB / SKU", required: true, sticky: true, sort: "item_id" },
  { key: "titulo", label: "Título", required: true, sort: "titulo" },
  { key: "diagnostico", label: "Diagnóstico", required: true },
  { key: "base", label: "Base", default: true },
  { key: "status_anuncio", label: "Status anúncio", default: false },
  { key: "listing_type_id", label: "Tipo anúncio", default: false },
  { key: "preco_original", label: "Preço cheio", default: false, num: true },
  { key: "preco_promocional", label: "Promocional", default: false, num: true },
  { key: "preco_efetivo", label: "Preço efetivo", default: true, num: true, sort: "preco_efetivo" },
  { key: "custo", label: "Custo", default: true, num: true, sort: "custo" },
  { key: "imposto_percentual", label: "Imposto", default: false, num: true },
  { key: "taxa_fixa", label: "Taxa fixa", default: false, num: true },
  { key: "frete", label: "Frete", default: true, num: true, sort: "frete" },
  { key: "comissao", label: "Comissão", default: true, num: true, sort: "comissao" },
  { key: "comissao_percentual", label: "Comissão %", default: false, num: true },
  { key: "lc", label: "LC", default: true, num: true, sort: "lc" },
  { key: "mc", label: "MC", required: true, num: true, sort: "mc" },
  { key: "preco_alvo", label: "Preço-alvo", default: true, num: true, sort: "preco_alvo" },
  { key: "diferenca_preco", label: "Dif. preço", default: false, num: true, sort: "diferenca_preco" },
  { key: "acao_recomendada", label: "Ação recomendada", default: true },
  { key: "explicacao_calculo", label: "Explicação do cálculo", default: false },
  { key: "acoes", label: "Ações", required: true },
];

function colunasVisiveisPadrao() {
  return RD_COLS.filter((c) => c.required || c.default).map((c) => c.key);
}

function carregarColunasVisiveis() {
  try {
    const raw = localStorage.getItem(COLUNAS_STORAGE_KEY);
    if (!raw) return colunasVisiveisPadrao();
    const salvas = JSON.parse(raw);
    if (!Array.isArray(salvas)) return colunasVisiveisPadrao();
    const validas = new Set(RD_COLS.map((c) => c.key));
    const visiveis = salvas.filter((k) => validas.has(k));
    RD_COLS.forEach((c) => { if (c.required && !visiveis.includes(c.key)) visiveis.push(c.key); });
    return visiveis;
  } catch (_) {
    return colunasVisiveisPadrao();
  }
}

function salvarColunasVisiveis() {
  try {
    localStorage.setItem(COLUNAS_STORAGE_KEY, JSON.stringify(DETALHE_STATE.visibleColumns));
  } catch (_) { /* localStorage indisponível — segue com o padrão em memória */ }
}

function colunasAtivas() {
  const set = new Set(DETALHE_STATE.visibleColumns);
  return RD_COLS.filter((c) => c.required || set.has(c.key));
}

function renderColunasMenu() {
  const menu = document.getElementById("rd-colunas-menu");
  if (!menu) return;
  const set = new Set(DETALHE_STATE.visibleColumns);
  const opcoes = RD_COLS.filter((c) => !c.required);
  menu.innerHTML = `<div class="vf-menu__label">Colunas visíveis</div>` + opcoes.map((c) => `
    <label class="vf-check vf-report-colmenu__item">
      <input type="checkbox" data-coluna="${escapeHTML(c.key)}" ${set.has(c.key) ? "checked" : ""}>
      <span>${escapeHTML(c.label)}</span>
    </label>`).join("");
}

document.getElementById("rd-colunas-btn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = document.getElementById("rd-colunas-menu");
  const btn = document.getElementById("rd-colunas-btn");
  if (!menu) return;
  menu.hidden = !menu.hidden;
  if (btn) btn.setAttribute("aria-expanded", String(!menu.hidden));
});

document.getElementById("rd-colunas-menu")?.addEventListener("click", (e) => e.stopPropagation());
document.getElementById("rd-colunas-menu")?.addEventListener("change", (e) => {
  const input = e.target.closest("[data-coluna]");
  if (!input) return;
  const key = input.getAttribute("data-coluna");
  const set = new Set(DETALHE_STATE.visibleColumns);
  if (input.checked) set.add(key);
  else set.delete(key);
  DETALHE_STATE.visibleColumns = RD_COLS.map((c) => c.key).filter((k) => set.has(k));
  salvarColunasVisiveis();
  renderDetalheTabela(); // não recarrega o endpoint — só re-renderiza
});

// Fecha o seletor de colunas ao clicar fora dele
document.addEventListener("click", (e) => {
  const menu = document.getElementById("rd-colunas-menu");
  const btn = document.getElementById("rd-colunas-btn");
  if (!menu || menu.hidden) return;
  if (e.target === btn || btn?.contains(e.target)) return;
  menu.hidden = true;
  btn?.setAttribute("aria-expanded", "false");
});

// ═══════════════════════════════════════════════════════════════
// DETALHE DO RELATÓRIO — FILTROS + BUSCA + ORDENAÇÃO
// ═══════════════════════════════════════════════════════════════

const DETALHE_FILTROS_RAPIDOS = [
  { key: "todos", label: "Todos" },
  { key: "critico", label: "Críticos" },
  { key: "atencao", label: "Atenção" },
  { key: "saudavel", label: "Saudáveis" },
  { key: "sem_base", label: "Sem base" },
  { key: "sem_frete", label: "Sem frete" },
  { key: "sem_comissao", label: "Sem comissão" },
];

// Busca priorizada: 0 = MLB exato · 1 = MLB parcial · 2 = SKU exato ·
// 3 = SKU parcial · 4 = título · -1 = não corresponde
function nivelDeCorrespondencia(it, q) {
  const mlb = String(it?.item_id || "").trim().toLowerCase();
  const sku = String(it?.sku || "").trim().toLowerCase();
  const titulo = String(it?.titulo || "").toLowerCase();
  if (mlb === q) return 0;
  if (mlb.includes(q)) return 1;
  if (sku === q) return 2;
  if (sku.includes(q)) return 3;
  if (titulo.includes(q)) return 4;
  return -1;
}

const RD_SORT_GETTERS = {
  prioridade: (it) => prioridadeDoItem(it),
  item_id: (it) => String(it.item_id || ""),
  sku: (it) => String(it.sku || "") || null,
  titulo: (it) => String(it.titulo || "") || null,
  status_anuncio: (it) => String(it.status_anuncio || "") || null,
  preco_efetivo: (it) => { const n = Number(it.preco_efetivo); return Number.isFinite(n) ? n : null; },
  custo: (it) => { const n = Number(it.custo); return Number.isFinite(n) ? n : null; },
  frete: (it) => { const n = Number(it.frete); return Number.isFinite(n) ? n : null; },
  comissao: (it) => { const n = Number(it.comissao); return Number.isFinite(n) ? n : null; },
  lc: (it) => { const n = Number(it.lc); return Number.isFinite(n) ? n : null; },
  mc: (it) => { const n = Number(it.mc); return Number.isFinite(n) ? n : null; },
  preco_alvo: (it) => { const n = Number(it.preco_alvo); return Number.isFinite(n) ? n : null; },
  diferenca_preco: (it) => { const n = Number(it.diferenca_preco); return Number.isFinite(n) ? n : null; },
};

function compararPrioridadePadrao(a, b) {
  // Ordem padrão: crítico → sem base → sem frete → sem comissão →
  // atenção → saudável; empate decidido por MC crescente.
  const ra = prioridadeDoItem(a);
  const rb = prioridadeDoItem(b);
  if (ra !== rb) return ra - rb;
  return compararComVaziosNoFim(RD_SORT_GETTERS.mc(a), RD_SORT_GETTERS.mc(b), "asc");
}

function itensDetalheFiltradosOrdenados() {
  const s = DETALHE_STATE;
  const q = s.search.trim().toLowerCase();
  const tiers = q ? new Map() : null;

  const filtrados = (Array.isArray(DETALHE_ITENS) ? DETALHE_ITENS : []).filter((it) => {
    const diag = diagnosticoItemSalvo(it);
    if (s.diagnostico !== "todos" && diag.key !== s.diagnostico) return false;

    if (s.temBase === "com" && !itemTemBase(it)) return false;
    if (s.temBase === "sem" && itemTemBase(it)) return false;

    if (s.statusAnuncio !== "todos" && String(it.status_anuncio || "").toLowerCase() !== s.statusAnuncio) return false;

    if (s.promocao === "com" && !itemTemPromo(it)) return false;
    if (s.promocao === "sem" && itemTemPromo(it)) return false;

    const mc = Number(it.mc);
    if (s.mcMin != null && !(Number.isFinite(mc) && mc >= s.mcMin)) return false;
    if (s.mcMax != null && !(Number.isFinite(mc) && mc <= s.mcMax)) return false;

    const lc = Number(it.lc);
    if (s.lc === "positivo" && !(Number.isFinite(lc) && lc > 0)) return false;
    if (s.lc === "negativo" && !(Number.isFinite(lc) && lc < 0)) return false;

    if (s.temAlvo && !Number.isFinite(Number(it.preco_alvo))) return false;
    if (s.temAcao && !String(it.acao_recomendada || "").trim()) return false;
    if (s.semFrete && Number.isFinite(Number(it.frete))) return false;
    if (s.semComissao && Number.isFinite(Number(it.comissao))) return false;

    if (q) {
      const tier = nivelDeCorrespondencia(it, q);
      if (tier < 0) return false;
      tiers.set(it, tier);
    }
    return true;
  });

  const cmpUsuario = s.sortBy === "prioridade"
    ? (a, b) => {
        const cmp = compararPrioridadePadrao(a, b);
        return s.sortOrder === "desc" ? -cmp : cmp;
      }
    : (a, b) => compararComVaziosNoFim(
        (RD_SORT_GETTERS[s.sortBy] || RD_SORT_GETTERS.prioridade)(a),
        (RD_SORT_GETTERS[s.sortBy] || RD_SORT_GETTERS.prioridade)(b),
        s.sortOrder
      );

  filtrados.sort((a, b) => {
    if (tiers) {
      const dt = (tiers.get(a) ?? 9) - (tiers.get(b) ?? 9);
      if (dt !== 0) return dt; // correspondências de MLB primeiro, depois SKU, depois título
    }
    return cmpUsuario(a, b);
  });

  return { filtrados, tiers };
}

function contarFiltrosAvancadosDetalhe() {
  const s = DETALHE_STATE;
  let n = 0;
  if (s.statusAnuncio !== "todos") n++;
  if (s.promocao !== "todos") n++;
  if (s.mcMin != null) n++;
  if (s.mcMax != null) n++;
  if (s.lc !== "todos") n++;
  if (s.temAlvo) n++;
  if (s.temAcao) n++;
  if (s.semFrete) n++;
  if (s.semComissao) n++;
  return n;
}

function lerFiltrosDetalheDoDom() {
  const s = DETALHE_STATE;
  s.search = document.getElementById("rd-busca")?.value || "";
  s.temBase = document.getElementById("rd-tembase")?.value || "todos";
  s.statusAnuncio = (document.getElementById("rd-status-anuncio")?.value || "todos").toLowerCase();
  s.promocao = document.getElementById("rd-promocao")?.value || "todos";
  s.mcMin = percentInputParaFracao(document.getElementById("rd-mc-min")?.value);
  s.mcMax = percentInputParaFracao(document.getElementById("rd-mc-max")?.value);
  s.lc = document.getElementById("rd-lc")?.value || "todos";
  s.temAlvo = Boolean(document.getElementById("rd-tem-alvo")?.checked);
  s.temAcao = Boolean(document.getElementById("rd-tem-acao")?.checked);
  s.semFrete = Boolean(document.getElementById("rd-sem-frete")?.checked);
  s.semComissao = Boolean(document.getElementById("rd-sem-comissao")?.checked);
}

function limparFiltrosDetalhe() {
  ["rd-busca", "rd-mc-min", "rd-mc-max"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const tb = document.getElementById("rd-tembase"); if (tb) tb.value = "todos";
  const sa = document.getElementById("rd-status-anuncio"); if (sa) sa.value = "todos";
  const pr = document.getElementById("rd-promocao"); if (pr) pr.value = "todos";
  const lc = document.getElementById("rd-lc"); if (lc) lc.value = "todos";
  ["rd-tem-alvo", "rd-tem-acao", "rd-sem-frete", "rd-sem-comissao"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.checked = false;
  });
  DETALHE_STATE.diagnostico = "todos";
  renderDetalheTabela();
}

function renderFiltrosAtivosDetalhe() {
  const el = document.getElementById("rd-active-filters");
  const advBtn = document.getElementById("rd-adv-toggle");
  if (!el) return;

  const s = DETALHE_STATE;
  const chips = [];
  const add = (chave, label) => chips.push({ chave, label });

  if (s.search.trim()) add("busca", `Busca: "${s.search.trim()}"`);
  if (s.diagnostico !== "todos") {
    const f = DETALHE_FILTROS_RAPIDOS.find((x) => x.key === s.diagnostico);
    add("diagnostico", `Diagnóstico: ${f?.label || s.diagnostico}`);
  }
  if (s.temBase !== "todos") add("tembase", s.temBase === "com" ? "Com base" : "Sem base");
  if (s.statusAnuncio !== "todos") add("status-anuncio", `Status: ${s.statusAnuncio}`);
  if (s.promocao !== "todos") add("promocao", s.promocao === "com" ? "Com promoção" : "Sem promoção");
  if (s.mcMin != null) add("mc-min", `MC ≥ ${pctFmt.format(s.mcMin * 100)}%`);
  if (s.mcMax != null) add("mc-max", `MC ≤ ${pctFmt.format(s.mcMax * 100)}%`);
  if (s.lc !== "todos") add("lc", s.lc === "positivo" ? "LC positivo" : "LC negativo");
  if (s.temAlvo) add("tem-alvo", "Possui preço-alvo");
  if (s.temAcao) add("tem-acao", "Possui ação recomendada");
  if (s.semFrete) add("sem-frete", "Frete ausente");
  if (s.semComissao) add("sem-comissao", "Comissão ausente");

  const advCount = contarFiltrosAvancadosDetalhe();
  if (advBtn) advBtn.textContent = advCount > 0 ? `Filtros avançados (${advCount})` : "Filtros avançados";

  if (!chips.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = chips.map((c) => `
    <span class="vf-active-filter">${escapeHTML(c.label)}
      <button type="button" class="vf-active-filter__remove" data-clear-rd="${escapeHTML(c.chave)}" aria-label="Remover filtro ${escapeHTML(c.label)}">✕</button>
    </span>`).join("") +
    `<button type="button" class="vf-clear-filters" data-clear-rd="__todos__">Limpar filtros</button>`;
}

document.getElementById("rd-active-filters")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-clear-rd]");
  if (!btn) return;
  const chave = btn.getAttribute("data-clear-rd");
  if (chave === "__todos__") { limparFiltrosDetalhe(); return; }
  const mapa = {
    "busca": () => { document.getElementById("rd-busca").value = ""; },
    "diagnostico": () => { DETALHE_STATE.diagnostico = "todos"; },
    "tembase": () => { document.getElementById("rd-tembase").value = "todos"; },
    "status-anuncio": () => { document.getElementById("rd-status-anuncio").value = "todos"; },
    "promocao": () => { document.getElementById("rd-promocao").value = "todos"; },
    "mc-min": () => { document.getElementById("rd-mc-min").value = ""; },
    "mc-max": () => { document.getElementById("rd-mc-max").value = ""; },
    "lc": () => { document.getElementById("rd-lc").value = "todos"; },
    "tem-alvo": () => { document.getElementById("rd-tem-alvo").checked = false; },
    "tem-acao": () => { document.getElementById("rd-tem-acao").checked = false; },
    "sem-frete": () => { document.getElementById("rd-sem-frete").checked = false; },
    "sem-comissao": () => { document.getElementById("rd-sem-comissao").checked = false; },
  };
  mapa[chave]?.();
  renderDetalheTabela();
});

// Chips de diagnóstico com contagem sobre TODOS os itens do relatório
function renderDetalheChips() {
  const wrap = document.getElementById("rd-chips");
  if (!wrap) return;
  const itens = Array.isArray(DETALHE_ITENS) ? DETALHE_ITENS : [];
  const contagens = { todos: itens.length };
  itens.forEach((it) => {
    const key = diagnosticoItemSalvo(it).key;
    contagens[key] = (contagens[key] || 0) + 1;
  });

  wrap.innerHTML = DETALHE_FILTROS_RAPIDOS.map((f) => {
    const ativo = f.key === DETALHE_STATE.diagnostico ? " is-active" : "";
    const count = contagens[f.key] || 0;
    return `<button type="button" class="vf-filter-chip${ativo}" data-diag="${escapeHTML(f.key)}" aria-pressed="${ativo ? "true" : "false"}">${escapeHTML(f.label)} <span class="vf-report-chipcount">${intFmt.format(count)}</span></button>`;
  }).join("");
}

document.getElementById("rd-chips")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-diag]");
  if (!btn) return;
  DETALHE_STATE.diagnostico = btn.getAttribute("data-diag") || "todos";
  renderDetalheChips();
  renderDetalheTabela();
});

// ═══════════════════════════════════════════════════════════════
// DETALHE DO RELATÓRIO — CABEÇALHO, RESUMO E TABELA
// ═══════════════════════════════════════════════════════════════

function renderDetalheResumo(relatorio) {
  const summary = document.getElementById("rd-summary");
  const meta = document.getElementById("rd-meta");
  if (!summary || !relatorio) return;

  const item = (value, label, tone) => `
    <span class="vf-report-summary__item${tone ? " is-" + tone : ""}">
      <strong class="vf-report-summary__value">${escapeHTML(value)}</strong>
      <span class="vf-report-summary__label">${escapeHTML(label)}</span>
    </span>`;

  const criticos = Number(relatorio.itens_criticos) || 0;
  const atencao = Number(relatorio.itens_atencao) || 0;
  const semBase = Number(relatorio.itens_sem_base) || 0;
  const margemAlvo = Number(relatorio.margem_alvo);

  summary.innerHTML = [
    item(intFmt.format(Number(relatorio.total_itens) || 0), "total"),
    item(intFmt.format(Number(relatorio.itens_com_base) || 0), "com base"),
    item(intFmt.format(semBase), "sem base", semBase > 0 ? "warning" : ""),
    item(intFmt.format(criticos), "críticos", criticos > 0 ? "danger" : ""),
    item(intFmt.format(atencao), "atenção", atencao > 0 ? "warning" : ""),
    item(intFmt.format(Number(relatorio.itens_saudaveis) || 0), "saudáveis"),
    item(fmtPctFraction(relatorio.mc_media), "MC média"),
    item(Number.isFinite(margemAlvo) && margemAlvo > 0 ? fmtPctFraction(margemAlvo) : "—", "margem-alvo"),
  ].join(`<span class="vf-report-summary__sep" aria-hidden="true">·</span>`);

  if (meta) {
    const partes = [
      `Cliente: <strong>${escapeHTML(relatorio.cliente_slug || "—")}</strong>`,
      `Base: <strong class="vf-mono">${escapeHTML(relatorio.base_slug || "—")}</strong>`,
      `Escopo: <strong>${escapeHTML(escopoLabel(relatorio.escopo))}</strong>`,
      `Pasta: <strong>${escapeHTML(nomeDaPasta(pastaIdDoRelatorio(relatorio)))}</strong>`,
      `Data: <strong>${escapeHTML(formatarDataRelatorio(relatorio.created_at))}</strong>`,
    ];
    if (relatorio.observacoes) partes.push(`Observações: <em>${escapeHTML(relatorio.observacoes)}</em>`);
    meta.innerHTML = partes.join(" · ");
  }
}

function renderDetalheHead() {
  const thead = document.getElementById("rd-thead");
  if (!thead) return;
  const cols = colunasAtivas();
  thead.innerHTML = `<tr>${cols.map((c) => {
    const classes = [c.num ? "num" : "", c.sticky ? "vf-table__sticky-cell" : ""].filter(Boolean).join(" ");
    const clsAttr = classes ? ` class="${classes}"` : "";
    if (!c.sort) return `<th${clsAttr}>${escapeHTML(c.label)}</th>`;
    const ativo = DETALHE_STATE.sortBy === c.sort;
    const dir = ativo ? (DETALHE_STATE.sortOrder === "asc" ? "is-asc" : "is-desc") : "";
    const ariaSort = ativo ? (DETALHE_STATE.sortOrder === "asc" ? "ascending" : "descending") : "none";
    return `<th${clsAttr} aria-sort="${ariaSort}"><button type="button" class="vf-table__sort ${dir}" data-sort-rd="${escapeHTML(c.sort)}">${escapeHTML(c.label)}</button></th>`;
  }).join("")}</tr>`;
}

document.getElementById("rd-thead")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-sort-rd]");
  if (!btn) return;
  const campo = btn.getAttribute("data-sort-rd");
  if (DETALHE_STATE.sortBy === campo) {
    DETALHE_STATE.sortOrder = DETALHE_STATE.sortOrder === "asc" ? "desc" : "asc";
  } else {
    DETALHE_STATE.sortBy = campo;
    DETALHE_STATE.sortOrder = ["item_id", "sku", "titulo", "status_anuncio"].includes(campo) ? "asc" : "desc";
  }
  const select = document.getElementById("rd-ordenacao");
  if (select) {
    const alvo = `${DETALHE_STATE.sortBy}:${DETALHE_STATE.sortOrder}`;
    if (Array.from(select.options).some((o) => o.value === alvo)) select.value = alvo;
  }
  renderDetalheTabela();
});

function celulaDetalhe(col, it) {
  switch (col.key) {
    case "mlb": {
      const sku = String(it.sku || "").trim();
      return `<div class="vf-report-cellmlb"><span class="vf-mono">${escapeHTML(it.item_id || "—")}</span>${sku ? `<span class="vf-mono vf-report-cellmlb__sku">${escapeHTML(sku)}</span>` : ""}</div>`;
    }
    case "titulo":
      return `<span class="vf-report-celltitulo" title="${escapeHTML(it.titulo || "")}">${escapeHTML(it.titulo || "—")}</span>`;
    case "diagnostico": {
      const diag = diagnosticoItemSalvo(it);
      return `<span class="vf-status${diag.tone ? " is-" + diag.tone : ""}">${escapeHTML(diag.label)}</span>`;
    }
    case "base":
      return itemTemBase(it) ? "Sim" : `<span class="vf-report-cellneg">Não</span>`;
    case "status_anuncio":
      return escapeHTML(it.status_anuncio || "—");
    case "listing_type_id":
      return `<span class="vf-mono">${escapeHTML(it.listing_type_id || "—")}</span>`;
    case "preco_original":
      return escapeHTML(fmtMoney(it.preco_original));
    case "preco_promocional":
      return itemTemPromo(it) ? escapeHTML(fmtMoney(it.preco_promocional)) : "—";
    case "preco_efetivo":
      return escapeHTML(fmtMoney(it.preco_efetivo));
    case "custo":
      return escapeHTML(fmtMoney(it.custo));
    case "imposto_percentual":
      return escapeHTML(fmtPctNumber(it.imposto_percentual));
    case "taxa_fixa":
      return escapeHTML(fmtMoney(it.taxa_fixa));
    case "frete":
      return escapeHTML(fmtMoney(it.frete));
    case "comissao":
      return escapeHTML(fmtMoney(it.comissao));
    case "comissao_percentual":
      return escapeHTML(fmtPctNumber(it.comissao_percentual));
    case "lc": {
      const n = Number(it.lc);
      const cls = Number.isFinite(n) ? (n < 0 ? " is-neg" : (n > 0 ? " is-pos" : "")) : "";
      return `<span class="${cls.trim()}">${escapeHTML(fmtMoney(it.lc))}</span>`;
    }
    case "mc": {
      const n = Number(it.mc);
      const cls = Number.isFinite(n) ? (n < 0 ? " is-neg" : (n > 0 ? " is-pos" : "")) : "";
      return `<span class="${cls.trim()}">${escapeHTML(fmtPctFraction(it.mc))}</span>`;
    }
    case "preco_alvo":
      return escapeHTML(fmtMoney(it.preco_alvo ?? it.preco_sugerido));
    case "diferenca_preco":
      return escapeHTML(fmtMoney(it.diferenca_preco));
    case "acao_recomendada":
      return `<span class="vf-report-cellacao" title="${escapeHTML(it.acao_recomendada || "")}">${escapeHTML(it.acao_recomendada || "—")}</span>`;
    case "explicacao_calculo":
      return `<span class="vf-report-cellacao" title="${escapeHTML(it.explicacao_calculo || "")}">${escapeHTML(it.explicacao_calculo || "—")}</span>`;
    case "acoes": {
      const itemId = String(it.item_id || "");
      if (ITENS_SALVOS_NA_BASE.has(itemId)) {
        return `<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" disabled>Salvo na base ✓</button>`;
      }
      const label = itemTemBase(it) ? "Atualizar custo" : "Adicionar à base";
      return `<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-base-editor="${escapeHTML(itemId)}">${label}</button>`;
    }
    default:
      return "—";
  }
}

function buildDetalheRow(it, cols, destaqueItemId) {
  const tr = document.createElement("tr");
  if (destaqueItemId && String(it.item_id || "") === destaqueItemId) {
    tr.className = "row--selected";
    tr.setAttribute("data-hit", "1");
  }
  tr.innerHTML = cols.map((c) => {
    const classes = [c.num ? "num" : "", c.sticky ? "vf-table__sticky-cell" : ""].filter(Boolean).join(" ");
    return `<td${classes ? ` class="${classes}"` : ""}>${celulaDetalhe(c, it)}</td>`;
  }).join("");
  return tr;
}

function renderDetalheTabela() {
  lerFiltrosDetalheDoDom();
  const { filtrados, tiers } = itensDetalheFiltradosOrdenados();
  const total = Array.isArray(DETALHE_ITENS) ? DETALHE_ITENS.length : 0;

  const contador = document.getElementById("rd-contador");
  if (contador) contador.textContent = `${intFmt.format(filtrados.length)} de ${intFmt.format(total)} itens`;

  renderFiltrosAtivosDetalhe();
  renderDetalheChips();
  renderDetalheHead();

  const tbody = document.getElementById("rd-tbody");
  if (!tbody) return;

  const cols = colunasAtivas();

  // Correspondência exata de MLB única → destacar e posicionar
  let destaqueItemId = null;
  if (tiers) {
    const exatos = filtrados.filter((it) => tiers.get(it) === 0);
    if (exatos.length === 1) destaqueItemId = String(exatos[0].item_id || "");
  }

  if (!filtrados.length) {
    DETALHE_STATE.renderToken += 1;
    tbody.innerHTML = `<tr class="vf-table__empty"><td colspan="${cols.length}">Nenhum item encontrado com os filtros atuais.</td></tr>`;
    const hint = document.getElementById("rd-render-hint");
    if (hint) hint.hidden = true;
    return;
  }

  DETALHE_STATE.renderToken += 1;
  const token = DETALHE_STATE.renderToken;
  renderLinhasEmLotes({
    tbody,
    linhas: filtrados,
    buildRow: (it) => buildDetalheRow(it, cols, destaqueItemId),
    hintEl: document.getElementById("rd-render-hint"),
    token,
    tokenAtual: () => DETALHE_STATE.renderToken,
  });

  // A ordenação por nível de correspondência coloca o MLB exato no topo:
  // basta reposicionar o scroll do wrapper na linha destacada.
  if (destaqueItemId) {
    requestAnimationFrame(() => {
      if (token !== DETALHE_STATE.renderToken) return;
      const wrap = tbody.closest(".vf-table-wrap");
      if (wrap) wrap.scrollTop = 0;
    });
  }
}

const renderDetalheTabelaDebounced = debounce(renderDetalheTabela, 200);

document.getElementById("rd-busca")?.addEventListener("input", renderDetalheTabelaDebounced);
["rd-tembase", "rd-status-anuncio", "rd-promocao", "rd-lc"].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", renderDetalheTabela);
});
["rd-mc-min", "rd-mc-max"].forEach((id) => {
  document.getElementById(id)?.addEventListener("input", renderDetalheTabelaDebounced);
});
["rd-tem-alvo", "rd-tem-acao", "rd-sem-frete", "rd-sem-comissao"].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", renderDetalheTabela);
});

document.getElementById("rd-ordenacao")?.addEventListener("change", (e) => {
  const [campo, ordem] = String(e.target.value || "prioridade:asc").split(":");
  DETALHE_STATE.sortBy = campo || "prioridade";
  DETALHE_STATE.sortOrder = ordem === "desc" ? "desc" : "asc";
  renderDetalheTabela();
});

document.getElementById("rd-adv-toggle")?.addEventListener("click", () => {
  const panel = document.getElementById("rd-adv-panel");
  const btn = document.getElementById("rd-adv-toggle");
  if (!panel) return;
  panel.hidden = !panel.hidden;
  if (btn) btn.setAttribute("aria-expanded", String(!panel.hidden));
});

// Ações por linha (editor de custo) — uma única delegação
document.getElementById("rd-tbody")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-base-editor]");
  if (!btn) return;
  const itemId = btn.getAttribute("data-base-editor");
  const item = (Array.isArray(DETALHE_ITENS) ? DETALHE_ITENS : []).find(
    (x) => String(x?.item_id || "") === String(itemId)
  );
  if (item) abrirEditorCustoBase(item);
});

// ═══════════════════════════════════════════════════════════════
// DETALHE DO RELATÓRIO — ABERTURA / FECHAMENTO
// ═══════════════════════════════════════════════════════════════

function resetDetalheFiltros() {
  DETALHE_STATE.search = "";
  DETALHE_STATE.diagnostico = "todos";
  DETALHE_STATE.sortBy = "prioridade";
  DETALHE_STATE.sortOrder = "asc";
  const busca = document.getElementById("rd-busca");
  if (busca) busca.value = "";
  const ord = document.getElementById("rd-ordenacao");
  if (ord) ord.value = "prioridade:asc";
  const tb = document.getElementById("rd-tembase");
  if (tb) tb.value = "todos";
  const pr = document.getElementById("rd-promocao");
  if (pr) pr.value = "todos";
  const lc = document.getElementById("rd-lc");
  if (lc) lc.value = "todos";
  ["rd-mc-min", "rd-mc-max"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  ["rd-tem-alvo", "rd-tem-acao", "rd-sem-frete", "rd-sem-comissao"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.checked = false;
  });
  const advPanel = document.getElementById("rd-adv-panel");
  if (advPanel) advPanel.hidden = true;
  document.getElementById("rd-adv-toggle")?.setAttribute("aria-expanded", "false");
}

function preencherStatusAnuncioSelect() {
  const select = document.getElementById("rd-status-anuncio");
  if (!select) return;
  const valores = new Set();
  (Array.isArray(DETALHE_ITENS) ? DETALHE_ITENS : []).forEach((it) => {
    const v = String(it.status_anuncio || "").trim().toLowerCase();
    if (v) valores.add(v);
  });
  select.innerHTML = `<option value="todos">Todos</option>` +
    Array.from(valores).sort().map((v) => `<option value="${escapeHTML(v)}">${escapeHTML(v)}</option>`).join("");
}

function atualizarBotoesExportModal() {
  const csvBtn = document.getElementById("btn-relatorio-detalhe-csv");
  const xlsxBtn = document.getElementById("btn-relatorio-detalhe-xlsx");
  const habilitar = Boolean(RELATORIO_DETALHE_ATUAL_ID);
  if (csvBtn) csvBtn.disabled = !habilitar;
  if (xlsxBtn) xlsxBtn.disabled = !habilitar;
}

async function abrirDetalheRelatorio(id) {
  if (!id || !TOKEN) return;

  const loading = document.getElementById("rd-loading");
  const content = document.getElementById("rd-content");
  const titulo = document.getElementById("vf-relatorio-detalhe-titulo");
  const statusChip = document.getElementById("rd-status-chip");
  const headMeta = document.getElementById("rd-head-meta");

  RELATORIO_DETALHE_ATUAL_ID = id;
  atualizarBotoesExportModal();

  if (titulo) titulo.textContent = `Relatório #${id}`;
  if (statusChip) statusChip.hidden = true;
  if (headMeta) headMeta.textContent = "";
  if (loading) {
    loading.hidden = false;
    loading.innerHTML = `<span class="vf-spinner" aria-hidden="true"></span> Carregando itens do relatório…`;
  }
  if (content) content.hidden = true;
  abrirOverlay("vf-relatorio-detalhe-modal");

  try {
    const res = await fetch(`${API_BASE}/automacoes/relatorios/${encodeURIComponent(id)}`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) throw new Error(json?.erro || `HTTP ${res.status}`);

    const relatorio = json.relatorio || {};
    // Todos os itens ficam em memória — a busca por MLB/SKU/título e os
    // filtros trabalham sempre sobre o conjunto completo, sem paginação.
    DETALHE_RELATORIO_ATUAL = relatorio;
    DETALHE_ITENS = Array.isArray(json.itens) ? json.itens : [];

    if (titulo) titulo.textContent = `Relatório #${relatorio.id || id} — ${relatorio.cliente_slug || "—"}`;
    const st = statusInfo(relatorio.status);
    if (statusChip) {
      statusChip.hidden = false;
      statusChip.className = `vf-status${st.tone ? " is-" + st.tone : ""}`;
      statusChip.textContent = st.label;
    }
    if (headMeta) headMeta.textContent = formatarDataCurta(relatorio.created_at);

    resetDetalheFiltros();
    preencherStatusAnuncioSelect();
    renderDetalheResumo(relatorio);
    renderColunasMenu();
    renderDetalheTabela();

    if (loading) loading.hidden = true;
    if (content) content.hidden = false;
  } catch (err) {
    if (loading) {
      loading.hidden = false;
      loading.innerHTML = `<span class="vf-report-cellneg">Erro ao carregar detalhe: ${escapeHTML(err?.message || "desconhecido")}</span>`;
    }
    if (content) content.hidden = true;
  }
}

function fecharModalDetalhe() {
  fecharOverlay("vf-relatorio-detalhe-modal");
  const colMenu = document.getElementById("rd-colunas-menu");
  if (colMenu) colMenu.hidden = true;
  document.getElementById("rd-colunas-btn")?.setAttribute("aria-expanded", "false");
  RELATORIO_DETALHE_ATUAL_ID = null;
  DETALHE_RELATORIO_ATUAL = null;
  DETALHE_ITENS = [];
  DETALHE_STATE.renderToken += 1; // cancela renderizações pendentes
  atualizarBotoesExportModal();
}

document.getElementById("vf-relatorio-detalhe-close")?.addEventListener("click", fecharModalDetalhe);
document.getElementById("btn-relatorio-detalhe-csv")?.addEventListener("click", () => {
  if (RELATORIO_DETALHE_ATUAL_ID) baixarRelatorio(RELATORIO_DETALHE_ATUAL_ID, "csv");
});
document.getElementById("btn-relatorio-detalhe-xlsx")?.addEventListener("click", () => {
  if (RELATORIO_DETALHE_ATUAL_ID) baixarRelatorio(RELATORIO_DETALHE_ATUAL_ID, "xlsx");
});

// ═══════════════════════════════════════════════════════════════
// EDITOR RÁPIDO DA BASE (upsert de custo — preservado)
// ═══════════════════════════════════════════════════════════════

function formatarPercentualInput(valorDecimal) {
  const n = Number(valorDecimal);
  if (!Number.isFinite(n)) return "";
  return String(n * 100);
}

async function carregarPadraoCustoBase(baseSlug) {
  const slug = String(baseSlug || "").trim();
  if (!slug || !TOKEN) return { imposto_percentual: 0, taxa_fixa: 0 };
  if (BASE_EDITOR_PADRAO_CACHE.has(slug)) return BASE_EDITOR_PADRAO_CACHE.get(slug);

  const res = await fetch(`${API_BASE}/bases/${encodeURIComponent(slug)}/custos/padrao`, {
    headers: { Authorization: "Bearer " + TOKEN },
  });
  if (res.status === 401) { clearSession(); return { imposto_percentual: 0, taxa_fixa: 0 }; }
  if (res.status === 403) { window.location.replace("dashboard.html"); return { imposto_percentual: 0, taxa_fixa: 0 }; }

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.ok) throw new Error(json?.erro || `HTTP ${res.status}`);

  const padrao = {
    imposto_percentual: Number(json?.padrao?.imposto_percentual) || 0,
    taxa_fixa: Number(json?.padrao?.taxa_fixa) || 0,
  };
  BASE_EDITOR_PADRAO_CACHE.set(slug, padrao);
  return padrao;
}

async function abrirEditorCustoBase(item) {
  const baseSlug = String(DETALHE_RELATORIO_ATUAL?.base_slug || "").trim();
  if (!baseSlug) {
    setFeedback("Relatório sem base_slug. Não foi possível abrir o editor rápido.", "danger");
    return;
  }

  BASE_EDITOR_ITEM_ATUAL = item || null;
  BASE_EDITOR_BASE_SLUG_ATUAL = baseSlug;
  setBanner("vf-base-custo-rapido-feedback", "");

  const subtitulo = document.getElementById("vf-base-custo-rapido-subtitulo");
  if (subtitulo) subtitulo.textContent = `base=${baseSlug}`;

  const produtoIdEl = document.getElementById("vf-base-custo-produto-id");
  const skuEl = document.getElementById("vf-base-custo-sku");
  const tituloEl = document.getElementById("vf-base-custo-titulo");
  const custoEl = document.getElementById("vf-base-custo-custo-produto");
  const impostoEl = document.getElementById("vf-base-custo-imposto");

  if (produtoIdEl) produtoIdEl.value = String(item?.item_id || "");
  if (skuEl) skuEl.value = item?.sku ? String(item.sku) : "—";
  if (tituloEl) tituloEl.value = item?.titulo ? String(item.titulo) : "—";

  const custoNum = Number(item?.custo);
  if (custoEl) custoEl.value = Number.isFinite(custoNum) && custoNum > 0 ? String(custoNum) : "";
  if (impostoEl) impostoEl.value = "";
  BASE_EDITOR_TAXA_FIXA_ATUAL = 0;

  abrirOverlay("vf-base-custo-rapido-modal");

  const saveBtn = document.getElementById("vf-base-custo-rapido-save");
  if (saveBtn) saveBtn.disabled = true;
  try {
    const padrao = await carregarPadraoCustoBase(baseSlug);
    if (impostoEl) impostoEl.value = formatarPercentualInput(padrao.imposto_percentual);
    BASE_EDITOR_TAXA_FIXA_ATUAL = Number(padrao.taxa_fixa) || 0;
  } catch (err) {
    setBanner(
      "vf-base-custo-rapido-feedback",
      `Não foi possível carregar o padrão da base. Você ainda pode salvar informando os campos manualmente. (${err?.message || "erro"})`,
      "warning"
    );
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function fecharEditorCustoBase() {
  fecharOverlay("vf-base-custo-rapido-modal");
  setBanner("vf-base-custo-rapido-feedback", "");
  BASE_EDITOR_ITEM_ATUAL = null;
  BASE_EDITOR_BASE_SLUG_ATUAL = null;
}

async function salvarCustoBaseRapido() {
  if (!TOKEN) return;
  const baseSlug = String(BASE_EDITOR_BASE_SLUG_ATUAL || "").trim();
  if (!baseSlug) return;

  const produtoIdEl = document.getElementById("vf-base-custo-produto-id");
  const custoEl = document.getElementById("vf-base-custo-custo-produto");
  const impostoEl = document.getElementById("vf-base-custo-imposto");
  const saveBtn = document.getElementById("vf-base-custo-rapido-save");

  const produto_id = String(produtoIdEl?.value || "").trim();
  const custoRaw = String(custoEl?.value || "").trim();
  const custoNum = Number(custoRaw.replace(",", "."));

  if (!produto_id) {
    setBanner("vf-base-custo-rapido-feedback", "Produto ID / MLB é obrigatório.", "danger");
    produtoIdEl?.classList.add("is-error");
    return;
  }
  produtoIdEl?.classList.remove("is-error");

  if (!custoRaw || !Number.isFinite(custoNum)) {
    setBanner("vf-base-custo-rapido-feedback", "Custo produto é obrigatório e numérico.", "danger");
    custoEl?.classList.add("is-error");
    return;
  }
  custoEl?.classList.remove("is-error");

  const impostoDec = percentInputParaFracao(impostoEl?.value);
  if (impostoEl?.value && impostoDec == null) {
    setBanner("vf-base-custo-rapido-feedback", "Imposto % deve ser numérico.", "danger");
    impostoEl?.classList.add("is-error");
    return;
  }
  impostoEl?.classList.remove("is-error");

  const payload = { produto_id, custo_produto: custoNum };
  // Se imposto estiver vazio, não envia (service aplica padrão / mantém antigo)
  if (impostoDec != null) payload.imposto_percentual = impostoDec;
  payload.taxa_fixa = Number.isFinite(Number(BASE_EDITOR_TAXA_FIXA_ATUAL)) ? Number(BASE_EDITOR_TAXA_FIXA_ATUAL) : 0;

  try {
    setBanner("vf-base-custo-rapido-feedback", "");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Salvando…"; }

    const res = await fetch(`${API_BASE}/bases/${encodeURIComponent(baseSlug)}/custos/upsert`, {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) throw new Error(json?.erro || `HTTP ${res.status}`);

    setBanner(
      "vf-base-custo-rapido-feedback",
      "Item salvo na base. Este relatório é histórico: os valores exibidos não são recalculados automaticamente.",
      "success"
    );

    // Marca visualmente como salvo (sem alterar os dados históricos do item)
    const itemId = String(BASE_EDITOR_ITEM_ATUAL?.item_id || "");
    if (itemId) {
      ITENS_SALVOS_NA_BASE.add(itemId);
      const btnLinha = document.querySelector(`#rd-tbody [data-base-editor="${CSS.escape(itemId)}"]`);
      if (btnLinha) {
        btnLinha.textContent = "Salvo na base ✓";
        btnLinha.disabled = true;
        btnLinha.removeAttribute("data-base-editor");
      }
    }
  } catch (err) {
    setBanner("vf-base-custo-rapido-feedback", `Erro ao salvar na base: ${err?.message || "desconhecido"}`, "danger");
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Salvar na base"; }
  }
}

document.getElementById("vf-base-custo-rapido-close")?.addEventListener("click", fecharEditorCustoBase);
document.getElementById("vf-base-custo-rapido-cancel")?.addEventListener("click", fecharEditorCustoBase);
document.getElementById("vf-base-custo-rapido-save")?.addEventListener("click", salvarCustoBaseRapido);

// ═══════════════════════════════════════════════════════════════
// DEEP LINK + INIT
// ═══════════════════════════════════════════════════════════════

// Deep-link: relatorios.html?relatorio=123 (vindo do Otimizador).
// Abre uma única vez, após a primeira carga — rerenders não reabrem.
function abrirDeepLinkSeNecessario() {
  if (DEEPLINK_ABERTO) return;
  const relatorioQuery = new URLSearchParams(window.location.search).get("relatorio");
  if (relatorioQuery && /^\d+$/.test(relatorioQuery)) {
    DEEPLINK_ABERTO = true;
    abrirDetalheRelatorio(relatorioQuery);
  } else {
    DEEPLINK_ABERTO = true;
  }
}

if (TOKEN) {
  DETALHE_STATE.visibleColumns = carregarColunasVisiveis();
  renderHubHead();
  carregarClientesParaFiltro();
  carregarPastas();
  carregarRelatorios();
}
