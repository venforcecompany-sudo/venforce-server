const STORAGE_KEY = "vf-token";
const API_BASE    = "https://venforce-server.onrender.com";
initLayout();

// ─── Sessão ───
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

// ─── Helpers ───
function escapeHTML(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function setImportStatus(msg, color) {
  const el = document.getElementById("import-status");
  el.textContent    = msg;
  el.style.color    = color || "var(--vf-text-m)";
  el.style.display  = msg ? "block" : "none";
}

function getImportMarketplace() {
  const el = document.getElementById("import-marketplace");
  return el ? el.value : "";
}

function atualizarBotaoImportarDisabled() {
  const btn = document.getElementById("btn-importar");
  if (!btn) return;
  const mp = getImportMarketplace();
  let ok = !!mp;
  if (mp === "meli") {
    const cli = document.getElementById("import-cliente");
    ok = ok && !!(cli && cli.value);
  }
  btn.disabled = !ok;
}

function setImportLoading(on) {
  const btn = document.getElementById("btn-importar");
  if (btn) btn.disabled = on ? true : btn.disabled;
  document.getElementById("btn-importar-text").textContent     = on ? "Processando…" : "Pré-visualizar";
  document.getElementById("btn-importar-spinner").style.display = on ? "inline-block" : "none";
  if (!on) atualizarBotaoImportarDisabled();
}

// ─── Estados da tabela de bases ───
const stateLoading  = document.getElementById("state-loading");
const stateSections = document.getElementById("state-sections");
const stateEmpty    = document.getElementById("state-empty");
const stateError    = document.getElementById("state-error");
const basesCount    = document.getElementById("bases-count");
const basesTbodyMeli   = document.getElementById("bases-tbody-meli");
const basesTbodyShopee = document.getElementById("bases-tbody-shopee");

// ─── Estado (filtros frontend) ───
let TODAS_BASES = [];
let BASES_BUSCA = "";
let BASES_FILTRO_MP = "";      // "", "meli", "shopee"
let BASES_FILTRO_ATUAL = "";   // "", "atualizada", "desatualizada"
let BASES_SORT = "attention";  // "attention", "oldest", "newest", "az"
const BASES_ALERTAS_IGNORADOS = new Set(); // slugs com alerta de desatualização ignorado (visual/local, não persiste)
let CLIENTES_DISPONIVEIS = [];
let CLIENTES_CARREGADOS = false;
let VINCULOS_EDITAVEIS = true;
let VINCULO_BASE_ATUAL = null;
let VINCULOS_AVISO_ATIVO = false;

// ─── Estado (exclusão) ───
let BASE_DELETE_PENDENTE = null; // { slug, nome, btn }

function setDashboardFeedback(msg, type = "neutral") {
  const el = document.getElementById("bases-feedback");
  if (!el) return;
  el.classList.remove("is-success", "is-danger", "is-warning", "is-info");
  el.textContent = "";
  if (!msg) { el.style.display = "none"; return; }
  if (type === "success") el.classList.add("is-success");
  else if (type === "danger") el.classList.add("is-danger");
  else if (type === "warning") el.classList.add("is-warning");
  else if (type === "info") el.classList.add("is-info");
  el.style.display = "flex";
  el.textContent = msg;
}

function normalizarMarketplaceKey(valor) {
  const raw = String(valor || "").toLowerCase().trim();
  if (raw.includes("shopee")) return "shopee";
  if (raw.includes("meli") || raw.includes("mercado")) return "meli";
  if (raw === "outro") return "outro";
  return "outro";
}

function marketplaceLabel(key) {
  const k = normalizarMarketplaceKey(key);
  if (k === "meli") return "Mercado Livre";
  if (k === "shopee") return "Shopee";
  return "Outro";
}

function getMarketplaceDisplay(base) {
  if (base?.vinculo?.marketplace) {
    const key = normalizarMarketplaceKey(base.vinculo.marketplace);
    return { key, label: marketplaceLabel(key), origem: "oficial" };
  }
  if (base?.sugestao?.marketplace) {
    const key = normalizarMarketplaceKey(base.sugestao.marketplace);
    if (key === "outro") return { key: "nao_definido", label: "Não definido", origem: "sugestao" };
    return { key, label: marketplaceLabel(key), origem: "sugestao" };
  }
  return { key: "nao_definido", label: "Não definido", origem: "nenhum" };
}

function detectarMarketplaceBase(base) {
  return getMarketplaceDisplay(base);
}

function formatDateTime(value) {
  if (!value) return "--";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "--";
  return d.toLocaleString("pt-BR");
}

function getClienteTexto(base) {
  const v = base?.vinculo || null;
  const s = base?.sugestao || null;
  return [
    v?.cliente_nome,
    v?.cliente_slug,
    s?.cliente_nome,
    s?.cliente_slug,
  ].filter(Boolean).join(" ");
}

// Marketplace intrínseco da base (definido na importação). Default 'meli'.
function getBaseMarketplaceKey(base) {
  const raw = String(base?.marketplace || "").toLowerCase().trim();
  return raw === "shopee" ? "shopee" : "meli";
}

// ─── Desatualização (COALESCE(updated_at, created_at) < hoje − 30d) ───
const DIAS_30_MS = 30 * 24 * 60 * 60 * 1000;
function getBaseTimestamp(base) {
  const v = base?.updated_at || base?.created_at;
  const d = v ? new Date(v) : null;
  return d && Number.isFinite(d.getTime()) ? d.getTime() : null;
}
function isBaseDesatualizada(base) {
  const t = getBaseTimestamp(base);
  if (t == null) return true; // sem data conhecida → tratar como desatualizada
  return (Date.now() - t) > DIAS_30_MS;
}

function diasDesdeAtualizacao(base) {
  const t = getBaseTimestamp(base);
  if (t == null) return null;
  return Math.max(0, Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000)));
}

function formatarIdadeBase(base) {
  const dias = diasDesdeAtualizacao(base);
  if (dias == null) return "Sem data";
  if (dias === 0) return "Hoje";
  if (dias === 1) return "1 dia";
  return `${dias} dias`;
}

function ordenarBases(bases) {
  const arr = Array.isArray(bases) ? [...bases] : [];
  const nomeOf = (b) => String(b?.nome || b?.slug || "").toLowerCase();
  const tsOf = (b) => {
    const t = getBaseTimestamp(b);
    return t == null ? -Infinity : t;
  };
  const emAtencao = (b) => isBaseDesatualizada(b) && !BASES_ALERTAS_IGNORADOS.has(b?.slug || "");

  switch (BASES_SORT) {
    case "oldest":
      return arr.sort((a, b) => tsOf(a) - tsOf(b));
    case "newest":
      return arr.sort((a, b) => tsOf(b) - tsOf(a));
    case "az":
      return arr.sort((a, b) => nomeOf(a).localeCompare(nomeOf(b)));
    case "attention":
    default:
      return arr.sort((a, b) => {
        const ea = emAtencao(a), eb = emAtencao(b);
        if (ea !== eb) return ea ? -1 : 1;
        return tsOf(a) - tsOf(b);
      });
  }
}

function hasFiltrosAtivos() {
  return !!(String(BASES_BUSCA || "").trim() || BASES_FILTRO_MP || BASES_FILTRO_ATUAL);
}

function getBasesFiltradas() {
  const termo = String(BASES_BUSCA || "").toLowerCase().trim();
  return (Array.isArray(TODAS_BASES) ? TODAS_BASES : []).filter((b) => {
    if (BASES_FILTRO_MP && getBaseMarketplaceKey(b) !== BASES_FILTRO_MP) return false;
    if (BASES_FILTRO_ATUAL === "atualizada" && isBaseDesatualizada(b)) return false;
    if (BASES_FILTRO_ATUAL === "desatualizada" && !isBaseDesatualizada(b)) return false;
    if (termo) {
      const hay = `${b?.nome || ""} ${b?.slug || ""} ${getClienteTexto(b)}`.toLowerCase();
      if (!hay.includes(termo)) return false;
    }
    return true;
  });
}

function renderBasesSummary() {
  const el = document.getElementById("bases-summary");
  if (!el) return;
  const bases = Array.isArray(TODAS_BASES) ? TODAS_BASES : [];
  const total = bases.length;
  const meli = bases.filter((b) => getBaseMarketplaceKey(b) === "meli").length;
  const shopee = bases.filter((b) => getBaseMarketplaceKey(b) === "shopee").length;
  const desatualizadas = bases.filter((b) => isBaseDesatualizada(b)).length;
  const atualizadas = total - desatualizadas;

  const cards = [
    { label: "Total de bases", value: String(total) },
    { label: "Mercado Livre", value: String(meli), filtro: { tipo: "mp", valor: "meli" } },
    { label: "Shopee", value: String(shopee), filtro: { tipo: "mp", valor: "shopee" } },
    { label: "Atualizadas", value: String(atualizadas), filtro: { tipo: "at", valor: "atualizada" } },
    { label: "Desatualizadas +30d", value: String(desatualizadas), warning: true, filtro: { tipo: "at", valor: "desatualizada" } },
  ];

  el.innerHTML = cards.map((c) => {
    const isAction = !!c.filtro;
    const active = isAction && (
      (c.filtro.tipo === "mp" && BASES_FILTRO_MP === c.filtro.valor) ||
      (c.filtro.tipo === "at" && BASES_FILTRO_ATUAL === c.filtro.valor)
    );
    const cls = ["vf-kpi"];
    if (c.warning) cls.push("vf-kpi--warning");
    if (isAction) cls.push("vf-kpi--interactive");
    if (active) cls.push("is-active");
    const foot = c.foot ? `<span class="vf-kpi__foot">${escapeHTML(c.foot)}</span>` : "";
    const inner = `
      <span class="vf-kpi__label">${escapeHTML(c.label)}</span>
      <span class="vf-kpi__value">${escapeHTML(c.value)}</span>
      ${foot}`;
    // KPIs clicáveis são <button> reais (teclado nativo); os demais, <div>.
    return isAction
      ? `<button type="button" class="${cls.join(" ")}" data-kpi-tipo="${c.filtro.tipo}" data-kpi-valor="${c.filtro.valor}">${inner}</button>`
      : `<div class="${cls.join(" ")}">${inner}</div>`;
  }).join("");
}

function renderChipsFiltros() {
  const el = document.getElementById("bases-chips");
  if (!el) return;
  const chips = [];
  if (BASES_FILTRO_MP) chips.push({ label: `Marketplace: ${marketplaceLabel(BASES_FILTRO_MP)}`, tipo: "mp" });
  if (BASES_FILTRO_ATUAL) chips.push({ label: BASES_FILTRO_ATUAL === "desatualizada" ? "Desatualizadas +30d" : "Atualizadas", tipo: "at" });
  const termo = String(BASES_BUSCA || "").trim();
  if (termo) chips.push({ label: `Busca: "${termo}"`, tipo: "busca" });

  el.innerHTML = chips.map((c) =>
    `<span class="vf-active-filter">${escapeHTML(c.label)} <button type="button" class="vf-active-filter__remove" data-chip-remove="${c.tipo}" aria-label="Remover filtro">✕</button></span>`
  ).join("");

  el.querySelectorAll("[data-chip-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.chipRemove;
      if (t === "mp") BASES_FILTRO_MP = "";
      else if (t === "at") BASES_FILTRO_ATUAL = "";
      else if (t === "busca") { BASES_BUSCA = ""; const bi = document.getElementById("bases-busca"); if (bi) bi.value = ""; }
      aplicarFiltros();
    });
  });
}

function sincronizarControlesFiltro() {
  const mpSel = document.getElementById("bases-filtro-marketplace");
  const atSel = document.getElementById("bases-filtro-atualizacao");
  if (mpSel && mpSel.value !== BASES_FILTRO_MP) mpSel.value = BASES_FILTRO_MP;
  if (atSel && atSel.value !== BASES_FILTRO_ATUAL) atSel.value = BASES_FILTRO_ATUAL;
  const sortSel = document.getElementById("bases-sort");
  if (sortSel && sortSel.value !== BASES_SORT) sortSel.value = BASES_SORT;
  const limpar = document.getElementById("bases-limpar-filtros");
  if (limpar) limpar.style.display = hasFiltrosAtivos() ? "" : "none";
}

function aplicarFiltros() {
  renderBasesTela();
}

function limparFiltros() {
  BASES_BUSCA = "";
  BASES_FILTRO_MP = "";
  BASES_FILTRO_ATUAL = "";
  const busca = document.getElementById("bases-busca");
  if (busca) busca.value = "";
  aplicarFiltros();
}

function aplicarKpiFiltro(tipo, valor) {
  if (tipo === "mp") BASES_FILTRO_MP = (BASES_FILTRO_MP === valor) ? "" : valor;
  else if (tipo === "at") BASES_FILTRO_ATUAL = (BASES_FILTRO_ATUAL === valor) ? "" : valor;
  aplicarFiltros();
}

function atualizarRodape(exibidas, total) {
  const el = document.getElementById("bases-count-footer");
  if (!el) return;
  if (!total) { el.textContent = ""; return; }
  const filtro = hasFiltrosAtivos() ? " · filtros ativos" : "";
  el.textContent = `Exibindo ${exibidas} de ${total} base${total !== 1 ? "s" : ""}${filtro}`;
}

function abrirModalExcluirBase({ slug, nome, btn }) {
  const modal = document.getElementById("vf-excluir-base-modal");
  const sub = document.getElementById("vf-excluir-base-subtitle");
  const danger = document.getElementById("vf-excluir-base-danger");
  const confirmBtn = document.getElementById("vf-excluir-base-confirm");
  if (!modal || !confirmBtn) return;

  BASE_DELETE_PENDENTE = { slug, nome, btn };
  if (sub) sub.textContent = nome || slug || "";
  if (danger) { danger.style.display = "none"; danger.textContent = ""; }
  confirmBtn.disabled = false;
  confirmBtn.textContent = "Excluir base";
  modal.style.removeProperty("display");
  modal.classList.add("is-open");
}

function fecharModalExcluirBase() {
  const modal = document.getElementById("vf-excluir-base-modal");
  if (modal) {
    modal.classList.remove("is-open");
    modal.style.removeProperty("display");
  }
  BASE_DELETE_PENDENTE = null;
}

async function confirmarExclusaoBase() {
  const danger = document.getElementById("vf-excluir-base-danger");
  const confirmBtn = document.getElementById("vf-excluir-base-confirm");
  if (!BASE_DELETE_PENDENTE) return;
  const { slug, btn } = BASE_DELETE_PENDENTE;

  if (danger) { danger.style.display = "none"; danger.textContent = ""; }
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = "Excluindo..."; }

  try {
    await deleteBase(slug, btn);
    fecharModalExcluirBase();
  } catch (err) {
    const msg = err?.message || "Não foi possível excluir a base.";
    if (danger) { danger.style.display = "block"; danger.textContent = msg; }
    else setDashboardFeedback(msg, "danger");
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = "Excluir base"; }
  }
}

function showLoading() {
  stateLoading.style.display  = "flex";
  stateSections.style.display = stateEmpty.style.display = stateError.style.display = "none";
}
function showSections() {
  stateSections.style.display = "block";
  stateLoading.style.display  = stateEmpty.style.display = stateError.style.display = "none";
}
function showEmpty() {
  stateEmpty.style.display    = "block";
  stateLoading.style.display  = stateSections.style.display = stateError.style.display = "none";
  basesCount.style.display    = "none";
}
function showError(msg) {
  stateError.style.display    = "block";
  stateLoading.style.display  = stateSections.style.display = stateEmpty.style.display = "none";
  document.getElementById("error-message").textContent = msg;
}

async function carregarClientesParaVinculos(silencioso = false) {
  if (!TOKEN || CLIENTES_CARREGADOS || !VINCULOS_EDITAVEIS) return CLIENTES_DISPONIVEIS;
  try {
    const res = await fetch(`${API_BASE}/base-vinculos/clientes`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.status === 401) { clearSession(); return []; }
    if (res.status === 403) {
      setDashboardFeedback("Não foi possível carregar a lista de clientes para vínculo.", "danger");
      return [];
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);
    CLIENTES_DISPONIVEIS = Array.isArray(data.clientes)
      ? data.clientes
        .filter((c) => c.ativo !== false)
        .map((c) => ({ id: c.id, nome: c.nome, slug: c.slug, ativo: c.ativo }))
      : [];
    CLIENTES_CARREGADOS = true;
    return CLIENTES_DISPONIVEIS;
  } catch (err) {
    if (!silencioso) setDashboardFeedback("Não foi possível carregar os clientes para vínculo.", "danger");
    return CLIENTES_DISPONIVEIS;
  }
}

function normalizarBasePrincipal(base) {
  return {
    ...base,
    vinculo: base?.vinculo || null,
    sugestao: base?.sugestao || null,
  };
}

function chaveBasePorId(base) {
  const id = base?.id;
  return id == null || id === "" ? "" : String(id);
}

function chaveBasePorSlug(base) {
  const slug = String(base?.slug || "").trim().toLowerCase();
  return slug ? `slug:${slug}` : "";
}

function aplicarVinculosNasBases(bases, basesComVinculos) {
  const porId = new Map();
  const porSlug = new Map();
  (Array.isArray(basesComVinculos) ? basesComVinculos : []).forEach((b) => {
    const idKey = chaveBasePorId(b);
    const slugKey = chaveBasePorSlug(b);
    if (idKey) porId.set(idKey, b);
    if (slugKey) porSlug.set(slugKey, b);
  });

  return (Array.isArray(bases) ? bases : []).map((base) => {
    const enriquecida = porId.get(chaveBasePorId(base)) || porSlug.get(chaveBasePorSlug(base));
    if (!enriquecida) return { ...base, vinculo: null, sugestao: null };
    return {
      ...base,
      vinculo: enriquecida.vinculo || null,
      sugestao: enriquecida.sugestao || null,
    };
  });
}

async function carregarBasesPrincipais() {
  const res = await fetch(`${API_BASE}/bases`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (res.status === 401) { clearSession(); return null; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);
  const bases = Array.isArray(data?.bases) ? data.bases : (Array.isArray(data) ? data : []);
  return bases.map(normalizarBasePrincipal);
}

async function carregarVinculosComplementares() {
  const res = await fetch(`${API_BASE}/base-vinculos`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (res.status === 401) { clearSession(); return null; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);
  return Array.isArray(data?.bases) ? data.bases : [];
}

function renderBasesTela() {
  sincronizarControlesFiltro();
  renderChipsFiltros();
  renderBasesSummary();
  renderBases(ordenarBases(getBasesFiltradas()));
}

async function loadBases() {
  if (!TOKEN) return;
  showLoading();

  let basesPrincipais = [];
  try {
    basesPrincipais = await carregarBasesPrincipais();
    if (!basesPrincipais) return;
    TODAS_BASES = basesPrincipais;
    renderBasesTela();
  } catch (err) {
    showError("Não foi possível carregar as bases. Tente novamente.");
    return;
  }

  try {
    const basesComVinculos = await carregarVinculosComplementares();
    if (!basesComVinculos) return;
    TODAS_BASES = aplicarVinculosNasBases(basesPrincipais, basesComVinculos);
    if (VINCULOS_AVISO_ATIVO) {
      setDashboardFeedback("");
      VINCULOS_AVISO_ATIVO = false;
    }
    await carregarClientesParaVinculos(true);
    renderBasesTela();
  } catch (err) {
    VINCULOS_AVISO_ATIVO = true;
    setDashboardFeedback("Vínculos indisponíveis no momento. As bases continuam listadas normalmente.", "neutral");
  }
}

// ─── Status de atualização (idade + alerta) ───
const B_EDIT_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
// Lápis compacto para editar item dentro do drawer de custos
const B_EDIT_SM_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

function renderStatusTag(base) {
  const idade = escapeHTML(formatarIdadeBase(base));
  const slug = escapeHTML(base.slug || "");

  if (!isBaseDesatualizada(base)) {
    return `<div class="vf-bases-status">
      <span class="vf-status is-success">${idade}</span>
    </div>`;
  }

  const ignorada = BASES_ALERTAS_IGNORADOS.has(base.slug || "");
  const statusCls = ignorada ? "is-neutral" : "is-warning";
  const checked = ignorada ? "checked" : "";
  return `<div class="vf-bases-status">
    <span class="vf-status ${statusCls}">${idade}</span>
    <label class="vf-check vf-bases-ignore">
      <input type="checkbox" class="b-ignore-alert" data-slug="${slug}" ${checked}>
      <span>Ignorar</span>
    </label>
  </div>`;
}

// ─── Menu "⋯" de ações secundárias ───
function renderMenuBase(base) {
  const id = escapeHTML(String(base.id || ""));
  const slug = escapeHTML(base.slug || "");
  const nome = escapeHTML(base.nome || base.slug || "");
  const vinculoItens = VINCULOS_EDITAVEIS ? `
    <button class="vf-menu__item vf-btn-vincular-base" data-base-id="${id}">${base.vinculo ? "Alterar cliente/vínculo" : "Definir cliente/vínculo"}</button>
    ${base.vinculo ? `<button class="vf-menu__item vf-btn-remover-vinculo" data-base-id="${id}">Remover vínculo</button>` : ""}
  ` : "";
  return `
    <div class="b-menu">
      <button type="button" class="vf-btn vf-btn--ghost vf-btn--icon vf-btn--sm b-menu-trigger" aria-haspopup="true" aria-expanded="false" title="Mais ações" aria-label="Mais ações">⋯</button>
      <div class="b-menu-pop vf-menu">
        ${vinculoItens}
        <button class="vf-menu__item asst-btn-baixar-base" data-slug="${slug}" data-nome="${nome}">Baixar CSV</button>
        <button class="vf-menu__item is-danger btn-excluir-base" data-slug="${slug}" data-nome="${nome}">Excluir base</button>
      </div>
    </div>`;
}

// ─── Linha: Mercado Livre (Cliente/Grant ML → Base oficial) ───
function buildMeliRow(base) {
  const tr = document.createElement("tr");
  const v = base?.vinculo;
  const clienteCell = v
    ? `<div class="vf-bases-cliente"><strong>${escapeHTML(v.cliente_nome || v.cliente_slug || "—")}</strong></div>`
    : `<div class="vf-bases-muted">Sem cliente vinculado</div>`;
  tr.innerHTML = `
    <td>${clienteCell}</td>
    <td>
      <div class="vf-bases-basename"><span class="name-text">${escapeHTML(base.nome || "—")}</span></div>
    </td>
    <td>${renderStatusTag(base)}</td>
    <td>
      <div class="vf-bases-row-actions">
        <button class="vf-btn vf-btn--ghost vf-btn--icon vf-btn--sm b-btn-editar-base" data-slug="${escapeHTML(base.slug || "")}" data-mp="meli" title="Abrir e editar custos" aria-label="Abrir e editar custos">${B_EDIT_SVG}</button>
        ${renderMenuBase(base)}
      </div>
    </td>`;
  return tr;
}

// ─── Linha: Shopee (Base + Loja/apelido) ───
function buildShopeeRow(base) {
  const tr = document.createElement("tr");
  const v = base?.vinculo;
  const loja = v ? (v.cliente_nome || v.cliente_slug) : "";
  const lojaCell = loja
    ? `<span class="vf-bases-cliente"><strong>${escapeHTML(loja)}</strong></span>`
    : `<span class="vf-bases-muted">—</span>`;
  tr.innerHTML = `
    <td>
      <div class="vf-bases-basename"><span class="name-text">${escapeHTML(base.nome || "—")}</span></div>
    </td>
    <td>${lojaCell}</td>
    <td>${renderStatusTag(base)}</td>
    <td>
      <div class="vf-bases-row-actions">
        <button class="vf-btn vf-btn--ghost vf-btn--icon vf-btn--sm b-btn-editar-base" data-slug="${escapeHTML(base.slug || "")}" data-mp="shopee" title="Abrir e editar custos" aria-label="Abrir e editar custos">${B_EDIT_SVG}</button>
        ${renderMenuBase(base)}
      </div>
    </td>`;
  return tr;
}

// ─── Menu dropdown "⋯" (ações secundárias) ───
function fecharTodosMenus() {
  document.querySelectorAll(".vf-page-bases .b-menu-pop.is-open").forEach((p) => p.classList.remove("is-open"));
  document.querySelectorAll(".vf-page-bases .b-menu-trigger[aria-expanded='true']").forEach((t) => t.setAttribute("aria-expanded", "false"));
}
function togglePop(trigger, popSelector) {
  const pop = trigger.parentElement.querySelector(popSelector);
  if (!pop) return;
  const aberto = pop.classList.contains("is-open");
  fecharTodosMenus();
  if (!aberto) { pop.classList.add("is-open"); trigger.setAttribute("aria-expanded", "true"); }
}
function toggleRowMenu(trigger) { togglePop(trigger, ".b-menu-pop"); }

function bindBaseRowActions(tbody) {
  tbody.querySelectorAll(".asst-btn-baixar-base").forEach(btn => {
    btn.addEventListener("click", () => { const { slug, nome } = btn.dataset; asstBaixarBase(slug, nome, btn); });
  });
  tbody.querySelectorAll(".btn-excluir-base").forEach(btn => {
    btn.addEventListener("click", () => { const { slug, nome } = btn.dataset; abrirModalExcluirBase({ slug, nome, btn }); });
  });
  tbody.querySelectorAll(".vf-btn-vincular-base").forEach(btn => {
    btn.addEventListener("click", () => abrirModalVinculo(btn.dataset.baseId));
  });
  tbody.querySelectorAll(".vf-btn-remover-vinculo").forEach(btn => {
    btn.addEventListener("click", () => removerVinculoBase(btn.dataset.baseId, btn));
  });
  tbody.querySelectorAll(".b-btn-editar-base").forEach(btn => {
    btn.addEventListener("click", () => abrirDrawerCustos(btn.dataset.slug, btn.dataset.mp, btn));
  });
  tbody.querySelectorAll(".b-menu-trigger").forEach(btn => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); toggleRowMenu(btn); });
  });
  tbody.querySelectorAll(".vf-menu__item").forEach(item => {
    item.addEventListener("click", () => fecharTodosMenus());
  });
  tbody.querySelectorAll(".b-ignore-alert").forEach((input) => {
    input.addEventListener("change", () => {
      const slug = input.dataset.slug;
      if (!slug) return;
      if (input.checked) BASES_ALERTAS_IGNORADOS.add(slug);
      else BASES_ALERTAS_IGNORADOS.delete(slug);
      renderBasesTela();
    });
  });
}

function renderBases(bases) {
  basesTbodyMeli.innerHTML   = "";
  basesTbodyShopee.innerHTML = "";

  // Sem nenhuma base cadastrada (primeiro uso) → estado vazio dedicado
  if (!(Array.isArray(TODAS_BASES) && TODAS_BASES.length)) {
    atualizarRodape(0, 0);
    showEmpty();
    return;
  }

  const meli   = bases.filter((b) => getBaseMarketplaceKey(b) === "meli");
  const shopee = bases.filter((b) => getBaseMarketplaceKey(b) === "shopee");

  meli.forEach((base)   => basesTbodyMeli.appendChild(buildMeliRow(base)));
  shopee.forEach((base) => basesTbodyShopee.appendChild(buildShopeeRow(base)));

  document.getElementById("count-meli").textContent    = String(meli.length);
  document.getElementById("count-shopee").textContent  = String(shopee.length);
  document.getElementById("wrap-meli").style.display    = meli.length   ? "" : "none";
  document.getElementById("wrap-shopee").style.display  = shopee.length ? "" : "none";
  document.getElementById("empty-meli").style.display   = meli.length   ? "none" : "block";
  document.getElementById("empty-shopee").style.display = shopee.length ? "none" : "block";

  basesCount.textContent = String(bases.length);

  bindBaseRowActions(basesTbodyMeli);
  bindBaseRowActions(basesTbodyShopee);

  atualizarRodape(bases.length, TODAS_BASES.length);
  showSections();
}

async function deleteBase(slug, btn) {
  btn.disabled = true;
  btn.textContent = "Excluindo…";
  try {
    const res  = await fetch(`${API_BASE}/bases/${encodeURIComponent(slug)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (res.status === 401) { clearSession(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);
    setDashboardFeedback(`Base "${slug}" excluída com sucesso.`, "success");
    loadBases();
    return true;
  } catch (err) {
    setDashboardFeedback("Erro ao excluir: " + err.message, "danger");
    btn.disabled    = false;
    btn.textContent = "Excluir";
    throw err;
  }
}

function getBasePorId(baseId) {
  const id = String(baseId || "");
  return (Array.isArray(TODAS_BASES) ? TODAS_BASES : []).find((b) => String(b.id) === id) || null;
}

function setVinculoModalDanger(msg) {
  const el = document.getElementById("vf-vinculo-base-danger");
  if (!el) return;
  el.textContent = msg || "";
  el.style.display = msg ? "block" : "none";
}

function setVinculoModalLoading(on) {
  const save = document.getElementById("vf-vinculo-base-save");
  const cliente = document.getElementById("vf-vinculo-cliente");
  const marketplace = document.getElementById("vf-vinculo-marketplace");
  if (save) {
    save.disabled = on || !VINCULOS_EDITAVEIS;
    save.textContent = on ? "Salvando..." : "Salvar vínculo";
  }
  if (cliente) cliente.disabled = on || !VINCULOS_EDITAVEIS;
  if (marketplace) marketplace.disabled = on || !VINCULOS_EDITAVEIS;
}

function renderClientesOptions(clienteIdSelecionado) {
  const select = document.getElementById("vf-vinculo-cliente");
  if (!select) return;
  const selected = String(clienteIdSelecionado || "");
  const clientes = Array.isArray(CLIENTES_DISPONIVEIS) ? CLIENTES_DISPONIVEIS : [];
  if (!clientes.length) {
    select.innerHTML = `<option value="">Nenhum cliente disponível</option>`;
    return;
  }
  select.innerHTML = `<option value="">Selecione um cliente...</option>` + clientes.map((c) => {
    const id = String(c.id || "");
    const nome = c.nome || c.slug || "Cliente";
    const slug = c.slug ? ` (${c.slug})` : "";
    const sel = id === selected ? " selected" : "";
    return `<option value="${escapeHTML(id)}"${sel}>${escapeHTML(nome + slug)}</option>`;
  }).join("");
}

function setModalPermissaoVisivel(visivel) {
  const msg = document.getElementById("vf-vinculo-base-permissao");
  if (!msg) return;
  msg.textContent = visivel ? "Não foi possível carregar os dados de vínculo de bases." : "";
  msg.style.display = visivel ? "block" : "none";
}

function renderSugestaoModal(base) {
  const el = document.getElementById("vf-vinculo-base-sugestao");
  if (!el) return;
  const s = base?.sugestao;
  if (!s || base?.vinculo) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.classList.add("show");
  el.style.display = "flex";
  el.textContent = `Sugestão: ${s.cliente_nome || s.cliente_slug || "cliente sugerido"} — confirmar para tornar oficial (${marketplaceLabel(s.marketplace)}).`;
}

async function abrirModalVinculo(baseId) {
  const base = getBasePorId(baseId);
  if (!base) return;

  const modal = document.getElementById("vf-vinculo-base-modal");
  const title = document.getElementById("vf-vinculo-base-title");
  const sub = document.getElementById("vf-vinculo-base-subtitle");
  const marketplace = document.getElementById("vf-vinculo-marketplace");
  if (!modal) return;

  VINCULO_BASE_ATUAL = base;
  setVinculoModalDanger("");
  setModalPermissaoVisivel(false);
  renderSugestaoModal(base);

  if (title) title.textContent = base.vinculo ? "Alterar vínculo" : "Vincular base";
  if (sub) sub.textContent = `${base.nome || base.slug || "Base"} (${base.slug || "sem slug"})`;

  await carregarClientesParaVinculos(false);

  const clienteSugerido = base.vinculo?.cliente_id || base.sugestao?.cliente_id || "";
  const marketplaceSugerido = base.vinculo?.marketplace || base.sugestao?.marketplace || "outro";
  renderClientesOptions(clienteSugerido);
  if (marketplace) marketplace.value = normalizarMarketplaceKey(marketplaceSugerido);

  setModalPermissaoVisivel(!VINCULOS_EDITAVEIS);
  setVinculoModalLoading(false);
  modal.style.removeProperty("display");
  modal.classList.add("is-open");
}

function fecharModalVinculo() {
  const modal = document.getElementById("vf-vinculo-base-modal");
  if (modal) {
    modal.classList.remove("is-open");
    modal.style.removeProperty("display");
  }
  VINCULO_BASE_ATUAL = null;
  setVinculoModalDanger("");
}

async function salvarVinculoBase() {
  if (!VINCULO_BASE_ATUAL || !VINCULOS_EDITAVEIS) return;
  const clienteId = (document.getElementById("vf-vinculo-cliente") || {}).value || "";
  const marketplace = (document.getElementById("vf-vinculo-marketplace") || {}).value || "";
  if (!clienteId) {
    setVinculoModalDanger("Selecione um cliente.");
    return;
  }
  if (!marketplace) {
    setVinculoModalDanger("Selecione um marketplace.");
    return;
  }

  setVinculoModalLoading(true);
  setVinculoModalDanger("");
  try {
    const res = await fetch(`${API_BASE}/base-vinculos`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        base_id: VINCULO_BASE_ATUAL.id,
        cliente_id: Number(clienteId),
        marketplace,
      }),
    });
    if (res.status === 401) { clearSession(); return; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) throw new Error("Não foi possível salvar o vínculo desta base.");
    if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);

    fecharModalVinculo();
    setDashboardFeedback("Vínculo salvo com sucesso.", "success");
    await loadBases();
  } catch (err) {
    setVinculoModalDanger(err.message || "Não foi possível salvar o vínculo.");
  } finally {
    setVinculoModalLoading(false);
  }
}

async function removerVinculoBase(baseId, btn) {
  const base = getBasePorId(baseId);
  if (!base || !base.vinculo) return;
  const confirmou = confirm(`Remover o vínculo oficial da base "${base.nome || base.slug}"?`);
  if (!confirmou) return;

  const textoOriginal = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Removendo..."; }
  try {
    const res = await fetch(`${API_BASE}/base-vinculos/${encodeURIComponent(base.id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (res.status === 401) { clearSession(); return; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) throw new Error("Não foi possível remover o vínculo desta base.");
    if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);
    setDashboardFeedback("Vínculo removido com sucesso.", "success");
    await loadBases();
  } catch (err) {
    setDashboardFeedback("Erro ao remover vínculo: " + (err.message || "tente novamente."), "danger");
    if (btn) { btn.disabled = false; btn.textContent = textoOriginal; }
  }
}

// ─── File input label ───
document.getElementById("import-arquivo").addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  document.getElementById("file-label-text").textContent = f ? f.name : "Escolher arquivo…";
  document.getElementById("file-label").classList.toggle("has-file", !!f);
});

// ══════════════════════════════════════════════════════════════════════════════
// ─── MODAL "IMPORTAR NOVA BASE" ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
function abrirModalImportar(mp, nomePrefill) {
  const backdrop = document.getElementById("bases-import-backdrop");
  if (!backdrop) return;
  const collapse = document.getElementById("bases-assist-collapse");
  if (collapse) collapse.classList.remove("is-open");
  setImportStatus("", "");
  if (mp) {
    const sel = document.getElementById("import-marketplace");
    if (sel) sel.value = mp;
  }
  if (nomePrefill != null && nomePrefill !== "") {
    const nomeEl = document.getElementById("import-nome");
    if (nomeEl) nomeEl.value = nomePrefill;
  }
  onImportMarketplaceChange();
  popularClientesImport();
  backdrop.classList.add("is-open");
}

function fecharModalImportar() {
  const backdrop = document.getElementById("bases-import-backdrop");
  if (backdrop) backdrop.classList.remove("is-open");
}

function onImportMarketplaceChange() {
  const mp = getImportMarketplace();
  const field = document.getElementById("import-cliente-field");
  const req = document.getElementById("import-cliente-req");
  const hint = document.getElementById("import-cliente-hint");
  const desc = document.getElementById("bases-import-desc");
  if (mp === "meli") {
    if (field) field.style.display = "";
    if (req) req.style.display = "";
    if (hint) hint.textContent = "Obrigatório para Mercado Livre — a base nasce vinculada a este cliente.";
    if (desc) desc.textContent = "A base de Mercado Livre nasce associada ao cliente/grant escolhido.";
  } else if (mp === "shopee") {
    if (field) field.style.display = "";
    if (req) req.style.display = "none";
    if (hint) hint.textContent = "Opcional para Shopee — pode ser criada sem cliente por enquanto.";
    if (desc) desc.textContent = "Base Shopee: informe a loja/cliente se já houver (opcional).";
  } else {
    if (field) field.style.display = "none";
    if (desc) desc.textContent = "Envie uma planilha de custos. A pré-visualização aparece antes de confirmar.";
  }
  atualizarBotaoImportarDisabled();
}

async function popularClientesImport() {
  const sel = document.getElementById("import-cliente");
  if (!sel) return;
  await carregarClientesParaVinculos(true);
  const clientes = Array.isArray(CLIENTES_DISPONIVEIS) ? CLIENTES_DISPONIVEIS : [];
  const atual = sel.value;
  sel.innerHTML = `<option value="">Selecione o cliente/grant…</option>` + clientes.map((c) => {
    const id = String(c.id || "");
    const nome = c.nome || c.slug || "Cliente";
    const slug = c.slug ? ` · ${c.slug}` : "";
    return `<option value="${escapeHTML(id)}">${escapeHTML(nome + slug)}</option>`;
  }).join("");
  if (atual) sel.value = atual;
  atualizarBotaoImportarDisabled();
}

// Best-effort: vincula a base recém-importada ao cliente/grant escolhido
// usando o endpoint existente POST /base-vinculos. Falha silenciosa: a base
// já foi importada; o vínculo pode ser feito depois pelo menu "⋯".
async function tentarAutovinculoImport(nome, marketplace, clienteId) {
  try {
    if (!VINCULOS_EDITAVEIS || !clienteId) return;
    const mpKey = normalizarMarketplaceKey(marketplace);
    const alvo = (Array.isArray(TODAS_BASES) ? TODAS_BASES : []).find((b) =>
      String(b.nome || "").trim().toLowerCase() === String(nome).trim().toLowerCase() &&
      getBaseMarketplaceKey(b) === mpKey && !b.vinculo
    );
    if (!alvo || alvo.id == null) return;
    const res = await fetch(`${API_BASE}/base-vinculos`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ base_id: alvo.id, cliente_id: Number(clienteId), marketplace: mpKey }),
    });
    if (res.ok) await loadBases();
  } catch (_) { /* best-effort */ }
}

// ─── Marketplace / cliente: habilita "Pré-visualizar" e alterna campo cliente ───
document.getElementById("import-marketplace")?.addEventListener("change", onImportMarketplaceChange);
document.getElementById("import-cliente")?.addEventListener("change", atualizarBotaoImportarDisabled);
onImportMarketplaceChange();

function validarArquivoImportacao(file) {
  const name = String(file?.name || "").toLowerCase();
  return name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv");
}

function setArquivoSelecionado(file) {
  const input = document.getElementById("import-arquivo");
  if (!input || !file) return;
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  document.getElementById("file-label-text").textContent = file.name;
  document.getElementById("file-label").classList.add("has-file");
}

// Drag & drop (1 arquivo) na dropzone
const dropLabel = document.getElementById("file-label");
if (dropLabel) {
  ["dragenter", "dragover"].forEach((evt) => {
    dropLabel.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropLabel.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    dropLabel.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropLabel.classList.remove("is-dragging");
    });
  });
  dropLabel.addEventListener("drop", (e) => {
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    const file = files[0];
    if (files.length > 1) {
      setImportStatus("Nesta versão, é permitido apenas 1 arquivo. Usando o primeiro.", "var(--vf-text-m)");
    }
    if (!validarArquivoImportacao(file)) {
      setImportStatus("Arquivo inválido. Envie .xlsx, .xls ou .csv.", "var(--vf-danger)");
      return;
    }
    setImportStatus("", "");
    setArquivoSelecionado(file);
  });
}

// ─── Preview ───
let pendingPreviewData = null; // guarda payload para confirmar depois

function openPreview(payload) {
  pendingPreviewData = payload;

  document.getElementById("preview-meta").textContent =
    `${payload.total} linhas · ${payload.idsDetectados} IDs válidos`;

  const isShopee = String(payload.marketplace || "").toLowerCase() === "shopee";
  const thIdModel = document.getElementById("preview-th-idmodel");
  if (thIdModel) thIdModel.style.display = isShopee ? "" : "none";

  const tbody = document.getElementById("preview-tbody");
  tbody.innerHTML = "";
  (payload.preview || []).forEach(r => {
    const tr = document.createElement("tr");
    const idModelCell = isShopee
      ? `<td style="font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(r.id_model ?? "—"))}</td>`
      : "";
    tr.innerHTML = `
      <td style="font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(r.id ?? ""))}</td>
      ${idModelCell}
      <td style="text-align:right;">${r.custo_produto ?? 0}</td>
      <td style="text-align:right;">${r.imposto_percentual ?? 0}</td>
      <td style="text-align:right;">${r.taxa_fixa ?? 0}</td>`;
    tbody.appendChild(tr);
  });

  const overlay = document.getElementById("preview-overlay");
  overlay.style.display = "flex";
}

function closePreview() {
  document.getElementById("preview-overlay").style.display = "none";
  pendingPreviewData = null;
}

document.getElementById("preview-close").addEventListener("click",  closePreview);
document.getElementById("preview-cancel").addEventListener("click", closePreview);

// Fechar clicando fora do modal
document.getElementById("preview-overlay").addEventListener("click", (e) => {
  if (e.target === document.getElementById("preview-overlay")) closePreview();
});

// ─── Confirmar importação ───
document.getElementById("preview-confirm").addEventListener("click", async () => {
  const arquivo = document.getElementById("import-arquivo").files?.[0];
  const nome    = document.getElementById("import-nome").value.trim();
  const marketplace = getImportMarketplace();
  if (!arquivo || !nome || !marketplace) { closePreview(); return; }

  document.getElementById("preview-confirm").disabled                 = true;
  document.getElementById("preview-confirm-text").textContent        = "Importando…";
  document.getElementById("preview-confirm-spinner").style.display   = "inline-block";

  try {
    const fd = new FormData();
    fd.append("arquivo", arquivo);
    fd.append("nomeBase", nome);
    fd.append("marketplace", marketplace);
    fd.append("confirmar", "true");

    const res  = await fetch(`${API_BASE}/importar-base`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fd
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);

    const clienteIdSel = (document.getElementById("import-cliente") || {}).value || "";

    closePreview();
    fecharModalImportar();
    setDashboardFeedback(`✓ ${data.mensagem || "Base importada com sucesso."} (${data.total ?? 0} produtos)`, "success");

    // reset do formulário
    document.getElementById("import-nome").value    = "";
    document.getElementById("import-arquivo").value = "";
    document.getElementById("file-label-text").textContent = "Escolher arquivo…";
    document.getElementById("file-label").classList.remove("has-file");
    const mpSel = document.getElementById("import-marketplace");
    if (mpSel) mpSel.value = "";
    const cliSel = document.getElementById("import-cliente");
    if (cliSel) cliSel.value = "";
    onImportMarketplaceChange();

    await loadBases();
    await tentarAutovinculoImport(nome, marketplace, clienteIdSel);

  } catch (err) {
    closePreview();
    setImportStatus("Erro ao importar: " + err.message, "var(--vf-danger)");
  } finally {
    document.getElementById("preview-confirm").disabled                 = false;
    document.getElementById("preview-confirm-text").textContent        = "Confirmar importação";
    document.getElementById("preview-confirm-spinner").style.display   = "none";
  }
});

// ─── Botão importar (pré-visualizar) ───
document.getElementById("btn-importar").addEventListener("click", async () => {
  const arquivo = document.getElementById("import-arquivo").files?.[0];
  const nome    = document.getElementById("import-nome").value.trim();
  const marketplace = getImportMarketplace();

  setImportStatus("", "");
  if (!marketplace) { setImportStatus("Selecione o marketplace.", "var(--vf-danger)"); return; }
  if (marketplace === "meli") {
    const cli = document.getElementById("import-cliente");
    if (!cli || !cli.value) { setImportStatus("Selecione o cliente / grant ML (obrigatório para Mercado Livre).", "var(--vf-danger)"); return; }
  }
  if (!nome)    { setImportStatus("Informe o nome da base.", "var(--vf-danger)"); return; }
  if (!arquivo) { setImportStatus("Selecione um arquivo .xlsx ou .csv.", "var(--vf-danger)"); return; }

  setImportLoading(true);

  try {
    const fd = new FormData();
    fd.append("arquivo", arquivo);
    fd.append("nomeBase", nome);
    fd.append("marketplace", marketplace);
    // sem "confirmar" → preview

    const res  = await fetch(`${API_BASE}/importar-base`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fd
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);

    openPreview(data);

  } catch (err) {
    setImportStatus("Erro: " + err.message, "var(--vf-danger)");
  } finally {
    setImportLoading(false);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ─── DRAWER "BASE DE CUSTOS" (visualizar + editar/adicionar/planilha) ──────────
//  Central única de custos da base: lista (GET /bases/:slug), edição/adição de
//  item via upsert (POST /bases/:slug/custos/upsert) e atualização por planilha
//  (preview seguro — Opção B, sem fluxo destrutivo).
// ══════════════════════════════════════════════════════════════════════════════
let DRAWER_ITENS = [];
// Filtros nativos no cabeçalho da tabela de custos (client-side, sem API).
let DRAWER_FILTROS = { produto: "", custo: "todos", imposto: "todos", taxa: "todos" };
let DRAWER_IS_SHOPEE = false;
let DRAWER_BTN_ORIGEM = null;
let DRAWER_SLUG = "";
let DRAWER_BASE_ATUAL = null;       // objeto da base aberta no drawer
let DRAWER_ITEM_EDITANDO = null;    // item em edição (null = adicionar/planilha)
// Lote de linhas já classificadas do preview da planilha, aguardando confirmação.
// Formato: { marketplace, linhas: [{ id, id_model, custo, imposto, acao }] }.
let PLANILHA_STATE = null;
const DRAWER_LIMITE = 500;
const PLANILHA_PREVIEW_LIMITE = 300;

function abrirDrawer() {
  document.getElementById("bases-drawer-backdrop")?.classList.add("is-open");
  document.getElementById("bases-drawer")?.classList.add("is-open");
}
function fecharDrawer() {
  fecharPainelCusto();
  document.getElementById("bases-drawer-backdrop")?.classList.remove("is-open");
  document.getElementById("bases-drawer")?.classList.remove("is-open");
  if (DRAWER_BTN_ORIGEM && typeof DRAWER_BTN_ORIGEM.focus === "function") DRAWER_BTN_ORIGEM.focus();
  DRAWER_BTN_ORIGEM = null;
}

function setDrawerHint(msg, tipo) {
  const el = document.getElementById("bases-drawer-hint");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = tipo === "success" ? "var(--vf-success)"
    : tipo === "danger" ? "var(--vf-danger)" : "";
}

function abrirDrawerCustos(slug, mp, btnOrigem) {
  DRAWER_SLUG = slug || "";
  DRAWER_IS_SHOPEE = mp === "shopee";
  DRAWER_BTN_ORIGEM = btnOrigem || null;
  DRAWER_ITENS = [];
  resetarFiltrosDrawer();
  fecharPainelCusto();
  setDrawerHint("Clique no lápis de um item para editar, ou use “Adicionar item”.");

  const base = (Array.isArray(TODAS_BASES) ? TODAS_BASES : []).find((b) => String(b.slug) === String(slug));
  DRAWER_BASE_ATUAL = base || null;
  document.getElementById("bases-drawer-title").textContent = base?.nome || slug || "Base";
  const meta = document.getElementById("bases-drawer-meta");
  const mpLabel = DRAWER_IS_SHOPEE ? "Shopee" : "Mercado Livre";
  const donoLabel = DRAWER_IS_SHOPEE ? "Loja / apelido" : "Cliente / Grant ML";
  const dono = base?.vinculo ? (base.vinculo.cliente_nome || base.vinculo.cliente_slug || "—") : "—";
  if (meta) meta.innerHTML = `
    <span>Marketplace: <b>${escapeHTML(mpLabel)}</b></span>
    <span>${escapeHTML(donoLabel)}: <b>${escapeHTML(dono)}</b></span>
    <span>Idade: <b>${escapeHTML(base ? formatarIdadeBase(base) : "—")}</b></span>`;

  abrirDrawer();
  carregarCustosDrawer(slug);
}

// O cabeçalho da tabela (com os botões de filtro) é estático no HTML e nunca é
// recriado — só a mensagem de estado (loading/erro) ou o <tbody> são trocados.
function mostrarEstadoDrawer(html) {
  const table = document.getElementById("bases-costs-table");
  const state = document.getElementById("bases-drawer-state");
  if (table) table.style.display = "none";
  if (state) { state.style.display = ""; state.innerHTML = html; }
}
function mostrarTabelaCustos() {
  const table = document.getElementById("bases-costs-table");
  const state = document.getElementById("bases-drawer-state");
  if (table) table.style.display = "";
  if (state) { state.style.display = "none"; state.innerHTML = ""; }
}

async function carregarCustosDrawer(slug) {
  mostrarEstadoDrawer(`<div class="loading-dots"><span></span><span></span><span></span></div>
    <p>Carregando custos…</p>`);
  const countEl = document.getElementById("bases-drawer-count");
  if (countEl) countEl.textContent = "Carregando…";
  try {
    const res = await fetch(`${API_BASE}/bases/${encodeURIComponent(slug)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.status === 401) { clearSession(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.erro || `HTTP ${res.status}`);
    const dados = data.dados || {};
    DRAWER_ITENS = Object.entries(dados).map(([produtoId, v]) => ({
      id: produtoId,
      id_model: v.id_model ?? v.idModel ?? null,
      custo: v.custo_produto ?? v.custo ?? null,
      imposto: v.imposto_percentual ?? v.imposto ?? null,
      taxa: v.taxa_fixa ?? v.taxa ?? null,
    }));
    renderDrawerItens();
  } catch (err) {
    mostrarEstadoDrawer(`<p>Não foi possível carregar os custos desta base.</p>
      <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm b-drawer-retry">Tentar novamente</button>`);
    if (countEl) countEl.textContent = "—";
    const retry = document.querySelector("#bases-drawer-state .b-drawer-retry");
    if (retry) retry.addEventListener("click", () => carregarCustosDrawer(slug));
  }
}

function isValorPreenchido(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0;
}

// "todos": não filtra · "zerado": 0, vazio, null ou inválido · "preenchido": > 0
function passaFiltroNumerico(estado, valor) {
  if (estado !== "zerado" && estado !== "preenchido") return true;
  const preenchido = isValorPreenchido(valor);
  return estado === "preenchido" ? preenchido : !preenchido;
}

function drawerFiltrarItens() {
  const termo = String(DRAWER_FILTROS.produto || "").toLowerCase().trim();
  return DRAWER_ITENS.filter((it) => {
    if (!passaFiltroNumerico(DRAWER_FILTROS.custo, it.custo)) return false;
    if (!passaFiltroNumerico(DRAWER_FILTROS.imposto, it.imposto)) return false;
    if (!passaFiltroNumerico(DRAWER_FILTROS.taxa, it.taxa)) return false;
    if (termo) {
      const hay = `${it.id ?? ""} ${it.id_model ?? ""}`.toLowerCase();
      if (!hay.includes(termo)) return false;
    }
    return true;
  });
}

function fmtMoedaDrawer(v) {
  if (v == null || v === "" || !Number.isFinite(Number(v))) return "—";
  return "R$ " + Number(v).toFixed(2).replace(".", ",");
}
// Imposto é guardado como decimal (0.05 = 5%) — exibe em percentual.
function fmtPercentDrawer(v) {
  if (v == null || v === "" || !Number.isFinite(Number(v))) return "—";
  const pct = Math.round(Number(v) * 100 * 100) / 100;
  return String(pct).replace(".", ",") + "%";
}

// Reflete o estado dos filtros nos wrappers estáticos do cabeçalho (.is-filtered).
function atualizarEstadoFiltrosHeader() {
  const estados = {
    produto: String(DRAWER_FILTROS.produto || "").trim() !== "",
    custo: DRAWER_FILTROS.custo !== "todos",
    imposto: DRAWER_FILTROS.imposto !== "todos",
    taxa: DRAWER_FILTROS.taxa !== "todos",
  };
  Object.keys(estados).forEach((campo) => {
    document.getElementById(`cost-filter-wrap-${campo}`)?.classList.toggle("is-filtered", estados[campo]);
  });
}

// Zera o estado e os controles nativos do cabeçalho ao abrir uma nova base no drawer.
function resetarFiltrosDrawer() {
  DRAWER_FILTROS = { produto: "", custo: "todos", imposto: "todos", taxa: "todos" };
  const produtoEl = document.getElementById("cost-filter-produto");
  if (produtoEl) produtoEl.value = "";
  ["custo", "imposto", "taxa"].forEach((campo) => {
    const el = document.getElementById(`cost-filter-${campo}`);
    if (el) el.value = "todos";
  });
  atualizarEstadoFiltrosHeader();
}

function renderDrawerItens() {
  const filtrados = drawerFiltrarItens();
  const totalFiltrado = filtrados.length;
  const exibidos = filtrados.slice(0, DRAWER_LIMITE);

  const thIdModel = document.getElementById("bases-costs-th-idmodel");
  if (thIdModel) thIdModel.style.display = DRAWER_IS_SHOPEE ? "" : "none";

  const rows = exibidos.map((it, idx) => {
    const custoZero = Number(it.custo) === 0;
    const impostoZero = Number(it.imposto) === 0;
    const taxaZero = Number(it.taxa) === 0;
    const idModelTd = DRAWER_IS_SHOPEE ? `<td class="vf-mono">${escapeHTML(String(it.id_model ?? "—"))}</td>` : "";
    return `<tr class="b-cost-row" data-cost-idx="${idx}" tabindex="0">
      <td class="vf-mono">${escapeHTML(String(it.id ?? "—"))}</td>
      ${idModelTd}
      <td class="num vf-mono ${custoZero ? "vf-bases-zero" : ""}">${escapeHTML(fmtMoedaDrawer(it.custo))}</td>
      <td class="num vf-mono ${impostoZero ? "vf-bases-zero" : ""}">${escapeHTML(fmtPercentDrawer(it.imposto))}</td>
      <td class="num vf-mono ${taxaZero ? "vf-bases-zero" : ""}">${escapeHTML(fmtMoedaDrawer(it.taxa))}</td>
      <td class="vf-bases-cost-actions">
        <button type="button" class="vf-btn vf-btn--ghost vf-btn--icon vf-btn--sm b-cost-edit" data-cost-idx="${idx}" title="Editar item" aria-label="Editar item">${B_EDIT_SM_SVG}</button>
      </td>
    </tr>`;
  }).join("");

  // Cabeçalho com filtros continua visível mesmo sem resultados, para o
  // usuário conseguir trocar/limpar o filtro que zerou a lista.
  const colspan = (DRAWER_IS_SHOPEE ? 6 : 5);
  const rowsOuVazio = totalFiltrado
    ? rows
    : `<tr class="vf-table__empty"><td colspan="${colspan}">Nenhum item para os filtros atuais.</td></tr>`;

  const tbody = document.getElementById("bases-costs-tbody");
  if (tbody) tbody.innerHTML = rowsOuVazio;
  mostrarTabelaCustos();
  atualizarEstadoFiltrosHeader();

  tbody?.querySelectorAll(".b-cost-edit").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.costIdx);
      if (Number.isFinite(idx) && exibidos[idx]) abrirFormularioItem(exibidos[idx]);
    });
  });
  tbody?.querySelectorAll(".b-cost-row").forEach((tr) => {
    tr.addEventListener("click", () => {
      // Não dispara se o usuário está apenas selecionando texto da linha.
      const sel = window.getSelection && window.getSelection().toString();
      if (sel) return;
      const idx = Number(tr.dataset.costIdx);
      if (Number.isFinite(idx) && exibidos[idx]) abrirFormularioItem(exibidos[idx]);
    });
    tr.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const idx = Number(tr.dataset.costIdx);
      if (Number.isFinite(idx) && exibidos[idx]) abrirFormularioItem(exibidos[idx]);
    });
  });

  const totalBase = DRAWER_ITENS.length;
  const countEl = document.getElementById("bases-drawer-count");
  if (!countEl) return;
  if (exibidos.length < totalFiltrado) {
    countEl.textContent = `Mostrando ${exibidos.length} de ${totalFiltrado} itens (limite ${DRAWER_LIMITE}) · refine a busca`;
  } else {
    countEl.textContent = `Mostrando ${totalFiltrado} de ${totalBase} itens`;
  }
}

// ─── Filtros nativos no cabeçalho da tabela de custos ───
// Controles fixos no HTML (nunca recriados) — listeners diretos, sem popover
// nem delegação: cada input/select já existe assim que a página carrega.
document.getElementById("cost-filter-produto")?.addEventListener("input", (e) => {
  DRAWER_FILTROS.produto = e.target.value || "";
  renderDrawerItens();
});
["custo", "imposto", "taxa"].forEach((campo) => {
  document.getElementById(`cost-filter-${campo}`)?.addEventListener("change", (e) => {
    DRAWER_FILTROS[campo] = e.target.value || "todos";
    renderDrawerItens();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ─── EDIÇÃO DE CUSTOS DENTRO DO DRAWER ─────────────────────────────────────────
//  · Editar item / Adicionar item → upsert REAL (POST /bases/:slug/custos/upsert).
//    Atualiza se o produto existe, adiciona se não. Nunca apaga itens ausentes.
//  · Atualizar por planilha → preview seguro (Opção B). NÃO chama /importar-base,
//    NÃO usa confirmar=true, NÃO substitui a base, NÃO apaga ausentes.
// ══════════════════════════════════════════════════════════════════════════════

// Imposto é digitado em % e persistido como decimal (5 → 0.05), igual ao editor
// rápido de relatorios.js. Mantém o contrato real do endpoint de upsert.
function parsePercentualUpdate(valorUsuario) {
  const raw = String(valorUsuario ?? "").trim();
  if (!raw) return { tem: false, valor: null, invalido: false };
  const n = Number(raw.replace(",", "."));
  if (!Number.isFinite(n)) return { tem: false, valor: null, invalido: true };
  return { tem: true, valor: n / 100, invalido: false };
}

function parseNumeroUpdate(valorUsuario) {
  const raw = String(valorUsuario ?? "").trim();
  if (!raw) return { tem: false, valor: null, invalido: false };
  const n = Number(raw.replace(",", "."));
  if (!Number.isFinite(n)) return { tem: false, valor: null, invalido: true };
  return { tem: true, valor: n, invalido: false };
}

function validarArquivoUpdate(file) {
  const name = String(file?.name || "").toLowerCase();
  return name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv");
}

// Feedback dentro do painel de edição/planilha (só há um painel aberto por vez).
function setCostFeedback(msg, tipo) {
  const el = document.querySelector("#bases-cost-panel .vf-bases-cost-feedback");
  if (!el) return;
  el.className = "vf-alert vf-bases-cost-feedback" + (tipo ? ` is-${tipo}` : "");
  el.textContent = msg || "";
  el.style.display = msg ? "flex" : "none";
}

function fecharPainelCusto() {
  const panel = document.getElementById("bases-cost-panel");
  if (panel) { panel.style.display = "none"; panel.innerHTML = ""; }
  DRAWER_ITEM_EDITANDO = null;
}

const B_FILE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

// ─── Formulário de item (editar existente ou adicionar novo) ───
function abrirFormularioItem(item = null) {
  const panel = document.getElementById("bases-cost-panel");
  if (!panel || !DRAWER_SLUG) return;

  DRAWER_ITEM_EDITANDO = item || null;
  const editando = !!item;
  const isShopee = DRAWER_IS_SHOPEE;
  const titulo = editando ? "Editar item da base" : "Adicionar item à base";
  const btnLabel = editando ? "Salvar alterações" : "Adicionar item";
  const microcopy = editando
    ? "As alterações sobrescrevem custo, imposto e taxa deste item."
    : "Se o produto já existir na base, os valores serão atualizados.";

  const produtoVal = editando ? escapeHTML(String(item.id ?? "")) : "";
  const idModelVal = editando ? escapeHTML(String(item.id_model ?? "")) : "";
  const custoVal = editando && Number.isFinite(Number(item.custo)) ? Number(item.custo) : "";
  const impostoVal = editando && Number.isFinite(Number(item.imposto))
    ? (Math.round(Number(item.imposto) * 100 * 1e6) / 1e6) : "";
  const taxaVal = editando && Number.isFinite(Number(item.taxa)) ? Number(item.taxa) : "";

  const idModelField = isShopee ? `
    <div class="vf-field vf-field--full">
      <label class="vf-field__label" for="cost-form-id-model">ID Model</label>
      <input type="text" class="vf-input" id="cost-form-id-model" value="${idModelVal}" placeholder="Opcional — usado principalmente para Shopee" autocomplete="off">
    </div>` : "";

  panel.innerHTML = `
    <div class="vf-bases-cost-form">
      <div class="vf-bases-cost-form-head">
        <strong>${escapeHTML(titulo)}</strong>
        <button type="button" class="vf-btn vf-btn--ghost vf-btn--icon vf-btn--sm" id="cost-form-close" aria-label="Fechar">✕</button>
      </div>
      <div class="vf-form-grid vf-bases-cost-grid">
        <div class="vf-field vf-field--full">
          <label class="vf-field__label" for="cost-form-produto">Produto / MLB / SKU <span class="vf-field__required">*</span></label>
          <input type="text" class="vf-input" id="cost-form-produto" value="${produtoVal}" placeholder="Ex.: MLB123456789 ou SKU" autocomplete="off"${editando ? " readonly" : ""}>
        </div>
        ${idModelField}
        <div class="vf-field">
          <label class="vf-field__label" for="cost-form-custo">Custo <span class="vf-field__required">*</span></label>
          <input type="number" class="vf-input" id="cost-form-custo" step="0.01" min="0" value="${custoVal}" placeholder="0.00">
        </div>
        <div class="vf-field">
          <label class="vf-field__label" for="cost-form-imposto">Imposto %</label>
          <input type="number" class="vf-input" id="cost-form-imposto" step="0.01" min="0" value="${impostoVal}" placeholder="0">
        </div>
        <div class="vf-field">
          <label class="vf-field__label" for="cost-form-taxa">Taxa fixa</label>
          <input type="number" class="vf-input" id="cost-form-taxa" step="0.01" min="0" value="${taxaVal}" placeholder="0.00">
        </div>
      </div>
      <p class="vf-field__hint vf-bases-microcopy">${escapeHTML(microcopy)}</p>
      <div class="vf-alert vf-bases-cost-feedback" id="cost-form-feedback" style="display:none;" aria-live="polite"></div>
      <div class="vf-form-actions">
        <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" id="cost-form-cancel">Cancelar</button>
        <button type="button" class="vf-btn vf-btn--primary vf-btn--sm" id="cost-form-save">${escapeHTML(btnLabel)}</button>
      </div>
    </div>`;
  panel.style.display = "block";

  document.getElementById("cost-form-close")?.addEventListener("click", fecharPainelCusto);
  document.getElementById("cost-form-cancel")?.addEventListener("click", fecharPainelCusto);
  document.getElementById("cost-form-save")?.addEventListener("click", salvarItemManual);
  ["cost-form-produto", "cost-form-id-model", "cost-form-custo", "cost-form-imposto", "cost-form-taxa"].forEach((id) => {
    document.getElementById(id)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); salvarItemManual(); }
    });
  });

  setTimeout(() => {
    const first = editando ? document.getElementById("cost-form-custo") : document.getElementById("cost-form-produto");
    first?.focus();
  }, 30);
  panel.scrollIntoView({ block: "nearest" });
}

async function salvarItemManual() {
  const slug = String(DRAWER_SLUG || "").trim();
  if (!slug) return;

  const produtoEl = document.getElementById("cost-form-produto");
  const idModelEl = document.getElementById("cost-form-id-model");
  const custoEl = document.getElementById("cost-form-custo");
  const impostoEl = document.getElementById("cost-form-imposto");
  const taxaEl = document.getElementById("cost-form-taxa");
  const saveBtn = document.getElementById("cost-form-save");

  const produto = String(produtoEl?.value || "").trim();
  if (!produto) { setCostFeedback("Informe o produto / MLB / SKU.", "danger"); produtoEl?.focus(); return; }

  const custo = parseNumeroUpdate(custoEl?.value);
  if (!custo.tem) { setCostFeedback("Informe o custo (pode ser 0).", "danger"); custoEl?.focus(); return; }
  if (custo.invalido) { setCostFeedback("Custo inválido — use apenas números.", "danger"); custoEl?.focus(); return; }

  const imposto = parsePercentualUpdate(impostoEl?.value);
  if (imposto.invalido) { setCostFeedback("Imposto % deve ser numérico.", "danger"); impostoEl?.focus(); return; }

  const taxa = parseNumeroUpdate(taxaEl?.value);
  if (taxa.invalido) { setCostFeedback("Taxa fixa deve ser numérica.", "danger"); taxaEl?.focus(); return; }

  const payload = { produto_id: produto, custo_produto: custo.valor };
  if (imposto.tem) payload.imposto_percentual = imposto.valor;
  if (taxa.tem) payload.taxa_fixa = taxa.valor;
  if (DRAWER_IS_SHOPEE) {
    const idModel = String(idModelEl?.value || "").trim();
    if (idModel) payload.id_model = idModel;
  }

  const editando = !!DRAWER_ITEM_EDITANDO;
  const textoOriginal = saveBtn ? saveBtn.textContent : "Salvar";
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Salvando..."; }
  setCostFeedback("", "");

  try {
    const res = await fetch(`${API_BASE}/bases/${encodeURIComponent(slug)}/custos/upsert`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { setCostFeedback("Você não tem permissão para ajustar esta base.", "danger"); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.erro || `HTTP ${res.status}`);

    // Recarrega os custos do drawer (drawer permanece aberto).
    await carregarCustosDrawer(slug);

    if (editando) {
      fecharPainelCusto();
      setDrawerHint("Item atualizado com sucesso.", "success");
    } else {
      // Mantém o formulário aberto p/ adicionar outro item; limpa os campos.
      if (produtoEl) produtoEl.value = "";
      if (idModelEl) idModelEl.value = "";
      if (custoEl) custoEl.value = "";
      if (impostoEl) impostoEl.value = "";
      if (taxaEl) taxaEl.value = "";
      setCostFeedback("Item adicionado. Se o produto já existia, os valores foram atualizados.", "success");
      produtoEl?.focus();
    }
  } catch (err) {
    setCostFeedback("Erro ao salvar item: " + (err?.message || "tente novamente."), "danger");
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = textoOriginal; }
  }
}

// ─── Painel "Atualizar por planilha" (preview seguro — Opção B) ───
function abrirPainelPlanilha() {
  const panel = document.getElementById("bases-cost-panel");
  if (!panel || !DRAWER_SLUG) return;
  DRAWER_ITEM_EDITANDO = null;

  panel.innerHTML = `
    <div class="vf-bases-planilha-panel">
      <div class="vf-bases-cost-form-head">
        <strong>Atualizar por planilha</strong>
        <button type="button" class="vf-btn vf-btn--ghost vf-btn--icon vf-btn--sm" id="cost-planilha-close" aria-label="Fechar">✕</button>
      </div>
      <div class="vf-banner vf-banner--compact is-info">A atualização por planilha atualiza produtos existentes e adiciona novos, sem apagar itens ausentes da planilha.</div>
      <div class="vf-field">
        <label class="vf-field__label">Planilha (.xlsx, .xls, .csv)</label>
        <input class="vf-visually-hidden" type="file" id="cost-planilha-arquivo" accept=".xlsx,.xls,.csv">
        <label class="vf-dropzone" id="cost-planilha-label" for="cost-planilha-arquivo">
          <span class="vf-dropzone__icon" aria-hidden="true">${B_FILE_SVG}</span>
          <span class="vf-dropzone__title" id="cost-planilha-label-text">Escolher arquivo…</span>
          <span class="vf-dropzone__hint">.xlsx · .xls · .csv · clique para selecionar</span>
        </label>
      </div>
      <div class="vf-banner vf-banner--compact is-success">Nenhum item será apagado neste fluxo.</div>
      <div class="vf-alert vf-bases-cost-feedback" id="cost-planilha-feedback" style="display:none;" aria-live="polite"></div>
      <div class="vf-form-actions">
        <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" id="cost-planilha-cancel">Cancelar</button>
        <button type="button" class="vf-btn vf-btn--primary vf-btn--sm" id="cost-planilha-preview">Pré-visualizar atualização</button>
      </div>
      <div class="vf-bases-cost-preview" id="cost-planilha-preview-box" style="display:none;"></div>
    </div>`;
  panel.style.display = "block";

  document.getElementById("cost-planilha-close")?.addEventListener("click", fecharPainelCusto);
  document.getElementById("cost-planilha-cancel")?.addEventListener("click", fecharPainelCusto);
  document.getElementById("cost-planilha-preview")?.addEventListener("click", previewPlanilhaDrawer);
  document.getElementById("cost-planilha-arquivo")?.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    const text = document.getElementById("cost-planilha-label-text");
    const label = document.getElementById("cost-planilha-label");
    if (text) text.textContent = f ? f.name : "Escolher arquivo…";
    if (label) label.classList.toggle("has-file", !!f);
    const box = document.getElementById("cost-planilha-preview-box");
    if (box) { box.style.display = "none"; box.innerHTML = ""; }
  });
  panel.scrollIntoView({ block: "nearest" });
}

// Deduplica as linhas normalizadas do preview (mantém a ÚLTIMA ocorrência por ID,
// contando quantas foram sobrescritas) e classifica cada uma contra DRAWER_ITENS.
// A classificação usa apenas o produto_id — mesma chave do upsert no backend
// (base_id + produto_id), então "Atualizar/Adicionar" reflete o que de fato ocorre.
function dedupEClassificarPlanilha(rows) {
  const existentes = new Set(DRAWER_ITENS.map((it) => String(it.id)));
  const porId = new Map();
  let duplicadosSobrescritos = 0;

  for (const r of rows) {
    if (!r || r.id == null) continue;
    const id = String(r.id);
    if (porId.has(id)) duplicadosSobrescritos++;
    porId.set(id, r); // última ocorrência vence
  }

  const linhas = [];
  let nAtualizar = 0;
  let nAdicionar = 0;
  for (const r of porId.values()) {
    const existe = existentes.has(String(r.id));
    if (existe) nAtualizar++; else nAdicionar++;
    linhas.push({
      id: String(r.id),
      id_model: r.id_model ?? null,
      custo: r.custo,
      imposto: r.imposto,
      acao: existe ? "atualizar" : "adicionar",
    });
  }

  return { linhas, nAtualizar, nAdicionar, duplicadosSobrescritos };
}

function badgeAcaoPlanilha(acao) {
  if (acao === "atualizar") return `<span class="vf-tag is-info">Atualizar</span>`;
  if (acao === "adicionar") return `<span class="vf-tag is-success">Adicionar</span>`;
  return `<span class="vf-tag is-neutral">Ignorar</span>`;
}

// Preview REAL: parseia a planilha via endpoint seguro (não salva nada), classifica
// e mostra o resumo + tabela. Não chama /importar-base, não reimporta, não apaga.
async function previewPlanilhaDrawer() {
  const fileInput = document.getElementById("cost-planilha-arquivo");
  const file = fileInput?.files?.[0];
  const box = document.getElementById("cost-planilha-preview-box");
  const previewBtn = document.getElementById("cost-planilha-preview");

  PLANILHA_STATE = null;
  if (!file) { setCostFeedback("Selecione um arquivo .xlsx, .xls ou .csv.", "danger"); return; }
  if (!validarArquivoUpdate(file)) { setCostFeedback("Arquivo inválido. Envie .xlsx, .xls ou .csv.", "danger"); return; }

  const textoBtn = previewBtn ? previewBtn.textContent : "Pré-visualizar atualização";
  if (previewBtn) { previewBtn.disabled = true; previewBtn.textContent = "Processando…"; }
  setCostFeedback("Lendo e classificando a planilha…", "neutral");
  if (box) { box.style.display = "none"; box.innerHTML = ""; }

  try {
    const marketplace = DRAWER_IS_SHOPEE ? "shopee" : "meli";
    const fd = new FormData();
    fd.append("arquivo", file);
    // Preview seguro: o servidor apenas parseia/normaliza e devolve dados_importacao.
    // NÃO usa /importar-base e NÃO envia confirmar=true — nada é gravado aqui.
    fd.append("config", JSON.stringify({ marketplace }));

    const res = await fetch(`${API_BASE}/bases/assistente/preview`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fd,
    });
    if (res.status === 401) { clearSession(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.erro || `HTTP ${res.status}`);

    const dados = Array.isArray(data.dados_importacao) ? data.dados_importacao : [];
    const resumo = data.resumo || {};
    const { linhas, nAtualizar, nAdicionar, duplicadosSobrescritos } = dedupEClassificarPlanilha(dados);

    const idsPlanilha = new Set(linhas.map((l) => String(l.id)));
    const preservados = DRAWER_ITENS.filter((it) => !idsPlanilha.has(String(it.id))).length;
    const ignoradas = Number(resumo.linhas_ignoradas || 0);
    const lidas = Number(resumo.linhas_lidas || dados.length);

    PLANILHA_STATE = { marketplace, linhas };

    renderPreviewPlanilha({
      lidas, nAtualizar, nAdicionar, ignoradas, duplicadosSobrescritos, preservados,
    });
    setCostFeedback("", "");
  } catch (err) {
    PLANILHA_STATE = null;
    setCostFeedback("Erro ao processar a planilha: " + (err?.message || "tente novamente."), "danger");
  } finally {
    if (previewBtn) { previewBtn.disabled = false; previewBtn.textContent = textoBtn; }
  }
}

function renderPreviewPlanilha({ lidas, nAtualizar, nAdicionar, ignoradas, duplicadosSobrescritos, preservados }) {
  const box = document.getElementById("cost-planilha-preview-box");
  if (!box) return;

  const linhas = (PLANILHA_STATE && PLANILHA_STATE.linhas) || [];
  const validos = linhas.length;
  const isShopee = DRAWER_IS_SHOPEE;

  const resumoLinhas = [
    `${lidas} linha(s) lida(s)`,
    `${validos} item(ns) válido(s)`,
    `${nAtualizar} será(ão) atualizado(s)`,
    `${nAdicionar} será(ão) adicionado(s)`,
    ignoradas ? `${ignoradas} linha(s) ignorada(s)` : null,
    duplicadosSobrescritos ? `${duplicadosSobrescritos} duplicado(s) na planilha (mantida a última ocorrência)` : null,
    `${preservados} item(ns) atual(is) da base será(ão) preservado(s) se não vieram na planilha`,
  ].filter(Boolean);

  const exibidos = linhas.slice(0, PLANILHA_PREVIEW_LIMITE);
  const thIdModel = isShopee ? `<th>ID Model</th>` : "";
  const corpo = exibidos.map((l) => {
    const obs = l.acao === "adicionar"
      ? "Novo item"
      : (Number.isFinite(Number(l.imposto)) ? "Sobrescreve custo e imposto" : "Sobrescreve custo · imposto atual mantido");
    const idModelTd = isShopee ? `<td class="vf-mono">${escapeHTML(String(l.id_model ?? "—"))}</td>` : "";
    return `<tr>
      <td class="vf-mono">${escapeHTML(String(l.id))}</td>
      ${idModelTd}
      <td class="num vf-mono">${escapeHTML(fmtMoedaDrawer(l.custo))}</td>
      <td class="num vf-mono">${escapeHTML(fmtPercentDrawer(l.imposto))}</td>
      <td class="num vf-mono">—</td>
      <td>${badgeAcaoPlanilha(l.acao)}</td>
      <td>${escapeHTML(obs)}</td>
    </tr>`;
  }).join("");

  const truncado = linhas.length > exibidos.length
    ? `<p class="vf-field__hint" style="margin-top:6px;">Mostrando ${exibidos.length} de ${linhas.length} itens válidos. Todos serão salvos ao confirmar.</p>`
    : "";

  box.innerHTML = `
    <div class="vf-bases-preview-title">Preview da atualização incremental</div>
    <ul class="vf-bases-resumo">${resumoLinhas.map((t) => `<li>${escapeHTML(t)}</li>`).join("")}</ul>
    <p class="vf-field__hint" style="margin:0 0 8px;">Taxa fixa não vem nesta planilha: o valor atual de cada item é preservado.</p>
    <div class="vf-table-wrap vf-bases-planilha-wrap">
      <table class="vf-table vf-table--compact">
        <thead><tr>
          <th>Produto / MLB / SKU</th>${thIdModel}
          <th class="num">Custo</th><th class="num">Imposto</th><th class="num">Taxa fixa</th>
          <th>Ação</th><th>Observação</th>
        </tr></thead>
        <tbody>${corpo || `<tr class="vf-table__empty"><td colspan="${isShopee ? 7 : 6}">Nenhum item válido para salvar.</td></tr>`}</tbody>
      </table>
    </div>
    ${truncado}
    <div class="vf-alert vf-bases-cost-feedback" id="cost-planilha-result" style="display:none;" aria-live="polite"></div>
    <div class="vf-form-actions" style="margin-top:12px;">
      <button type="button" class="vf-btn vf-btn--primary vf-btn--sm" id="cost-planilha-confirm"${validos ? "" : " disabled"}>Confirmar atualização incremental</button>
    </div>`;
  box.style.display = "block";
  document.getElementById("cost-planilha-confirm")?.addEventListener("click", confirmarPlanilhaDrawer);
  box.scrollIntoView({ block: "nearest" });
}

function setPlanilhaResult(msg, tipo) {
  const el = document.getElementById("cost-planilha-result");
  if (!el) return;
  el.className = "vf-alert vf-bases-cost-feedback" + (tipo ? ` is-${tipo}` : "");
  el.textContent = msg || "";
  el.style.display = msg ? "flex" : "none";
}

// Atualização incremental: usa upsert por item para preservar produtos ausentes.
// Nunca chama /importar-base, nunca envia confirmar=true, nunca faz DELETE.
async function confirmarPlanilhaDrawer() {
  const slug = String(DRAWER_SLUG || "").trim();
  if (!slug || !PLANILHA_STATE || !Array.isArray(PLANILHA_STATE.linhas) || !PLANILHA_STATE.linhas.length) return;

  const linhas = PLANILHA_STATE.linhas;
  const marketplace = PLANILHA_STATE.marketplace;
  const confirmBtn = document.getElementById("cost-planilha-confirm");
  const previewBtn = document.getElementById("cost-planilha-preview");

  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = "Atualizando…"; }
  if (previewBtn) previewBtn.disabled = true;
  setCostFeedback("Atualizando itens… não feche o painel.", "neutral");
  setPlanilhaResult("", "");

  let atualizados = 0;
  let adicionados = 0;
  let falhas = 0;
  const errosDetalhe = [];

  for (const linha of linhas) {
    const payload = { produto_id: linha.id, custo_produto: linha.custo };
    // Imposto só é enviado quando veio na planilha; ausente preserva o valor atual
    // (item existente) ou usa o padrão da base (item novo). Nunca zera à força.
    if (Number.isFinite(Number(linha.imposto))) payload.imposto_percentual = Number(linha.imposto);
    // Taxa fixa não é extraída deste preview → omitida → preservada.
    if (marketplace === "shopee" && linha.id_model) payload.id_model = linha.id_model;

    try {
      const res = await fetch(`${API_BASE}/bases/${encodeURIComponent(slug)}/custos/upsert`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.status === 401) { clearSession(); return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        falhas++;
        if (errosDetalhe.length < 10) errosDetalhe.push(`${linha.id}: ${data.erro || `HTTP ${res.status}`}`);
        continue;
      }
      if (data.acao === "criado") adicionados++; else atualizados++;
    } catch (err) {
      falhas++;
      if (errosDetalhe.length < 10) errosDetalhe.push(`${linha.id}: ${err?.message || "erro de conexão"}`);
    }
  }

  // Recarrega os custos do drawer e a lista de bases (contagens/KPIs).
  await carregarCustosDrawer(slug);
  await loadBases();

  const houveSucesso = (atualizados + adicionados) > 0;
  const tipoFinal = falhas ? (houveSucesso ? "neutral" : "danger") : "success";
  const msgFinal = `Atualização concluída: ${atualizados} atualizados, ${adicionados} adicionados, ${falhas} falhas. Nenhum item ausente foi apagado.`;
  setCostFeedback(msgFinal, tipoFinal);

  const detalhe = falhas && errosDetalhe.length
    ? `<p class="vf-field__hint" style="margin:6px 0 0;">Falhas (até 10): ${escapeHTML(errosDetalhe.join(" · "))}</p>`
    : "";
  const resultTipo = falhas ? (houveSucesso ? "neutral" : "danger") : "success";
  setPlanilhaResult(msgFinal, resultTipo);
  const resultEl = document.getElementById("cost-planilha-result");
  if (resultEl && detalhe) resultEl.insertAdjacentHTML("beforeend", detalhe);

  // Evita reconfirmar o mesmo lote; painel permanece aberto com o resultado final.
  PLANILHA_STATE = null;
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = "Atualização concluída"; }
  if (previewBtn) previewBtn.disabled = false;
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── WIRING (toolbar, KPIs, chips, modal importar, drawer, menus) ─────────────
// ══════════════════════════════════════════════════════════════════════════════

// Busca
const basesBuscaInput = document.getElementById("bases-busca");
if (basesBuscaInput) {
  basesBuscaInput.addEventListener("input", (e) => {
    BASES_BUSCA = e.target.value || "";
    aplicarFiltros();
  });
}

// Filtros de toolbar (selects legados — mantidos como fallback caso reintroduzidos)
document.getElementById("bases-filtro-marketplace")?.addEventListener("change", (e) => { BASES_FILTRO_MP = e.target.value || ""; aplicarFiltros(); });
document.getElementById("bases-filtro-atualizacao")?.addEventListener("change", (e) => { BASES_FILTRO_ATUAL = e.target.value || ""; aplicarFiltros(); });
document.getElementById("bases-sort")?.addEventListener("change", (e) => { BASES_SORT = e.target.value || "attention"; renderBasesTela(); });
document.getElementById("bases-limpar-filtros")?.addEventListener("click", limparFiltros);
document.getElementById("bases-refresh")?.addEventListener("click", loadBases);

// KPIs clicáveis (marketplace / atualização)
const kpiGrid = document.getElementById("bases-summary");
if (kpiGrid) {
  kpiGrid.addEventListener("click", (e) => {
    const card = e.target.closest("[data-kpi-tipo]");
    if (!card) return;
    aplicarKpiFiltro(card.dataset.kpiTipo, card.dataset.kpiValor);
  });
  kpiGrid.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest("[data-kpi-tipo]");
    if (!card) return;
    e.preventDefault();
    aplicarKpiFiltro(card.dataset.kpiTipo, card.dataset.kpiValor);
  });
}

// Abrir modal de importação
document.getElementById("btn-abrir-importar")?.addEventListener("click", () => abrirModalImportar());
document.querySelectorAll("[data-import-open]").forEach((b) => b.addEventListener("click", () => abrirModalImportar()));
document.querySelectorAll(".mp-action[data-import-mp]").forEach((b) => b.addEventListener("click", () => abrirModalImportar(b.dataset.importMp)));
document.getElementById("bases-import-close")?.addEventListener("click", fecharModalImportar);
document.getElementById("bases-import-cancel")?.addEventListener("click", fecharModalImportar);
document.getElementById("bases-import-backdrop")?.addEventListener("click", (e) => {
  if (e.target?.id === "bases-import-backdrop") fecharModalImportar();
});

// Toggle do assistente dentro do modal
document.getElementById("bases-assist-toggle")?.addEventListener("click", () => {
  const c = document.getElementById("bases-assist-collapse");
  if (c) c.classList.toggle("is-open");
});

// Drawer "Base de custos"
document.getElementById("bases-drawer-close")?.addEventListener("click", fecharDrawer);
document.getElementById("bases-drawer-backdrop")?.addEventListener("click", fecharDrawer);
// Ações do drawer: adicionar item / atualizar por planilha (dentro do drawer)
document.getElementById("bases-drawer-add")?.addEventListener("click", () => abrirFormularioItem(null));
document.getElementById("bases-drawer-planilha")?.addEventListener("click", abrirPainelPlanilha);

// Fechar menus "⋯" ao clicar fora
document.addEventListener("click", (e) => {
  if (!e.target.closest(".b-menu")) fecharTodosMenus();
});
// Esc fecha menus, painel de custo, drawer e modal de importação
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  fecharTodosMenus();
  // Se um painel de edição/planilha está aberto no drawer, Esc fecha só o painel.
  const panel = document.getElementById("bases-cost-panel");
  if (panel && panel.style.display !== "none" && panel.innerHTML.trim()) { fecharPainelCusto(); return; }
  const drawer = document.getElementById("bases-drawer");
  if (drawer && drawer.classList.contains("is-open")) { fecharDrawer(); return; }
  const importBackdrop = document.getElementById("bases-import-backdrop");
  if (importBackdrop && importBackdrop.classList.contains("is-open")) fecharModalImportar();
});

// ─── Retry ───
document.getElementById("btn-retry").addEventListener("click", loadBases);

// Modal excluir base
document.getElementById("vf-excluir-base-close")?.addEventListener("click", fecharModalExcluirBase);
document.getElementById("vf-excluir-base-cancel")?.addEventListener("click", fecharModalExcluirBase);
document.getElementById("vf-excluir-base-confirm")?.addEventListener("click", confirmarExclusaoBase);
document.getElementById("vf-excluir-base-modal")?.addEventListener("click", (e) => {
  if (e.target?.id === "vf-excluir-base-modal") fecharModalExcluirBase();
});
document.getElementById("vf-vinculo-base-close")?.addEventListener("click", fecharModalVinculo);
document.getElementById("vf-vinculo-base-cancel")?.addEventListener("click", fecharModalVinculo);
document.getElementById("vf-vinculo-base-save")?.addEventListener("click", salvarVinculoBase);
document.getElementById("vf-vinculo-base-modal")?.addEventListener("click", (e) => {
  if (e.target?.id === "vf-vinculo-base-modal") fecharModalVinculo();
});
document.addEventListener("keydown", (e) => {
  const modalExcluir = document.getElementById("vf-excluir-base-modal");
  const modalVinculo = document.getElementById("vf-vinculo-base-modal");
  if (e.key !== "Escape") return;
  if (modalVinculo && modalVinculo.classList.contains("is-open")) fecharModalVinculo();
  if (modalExcluir && modalExcluir.classList.contains("is-open")) fecharModalExcluirBase();
});

// ─── Init ───
if (TOKEN) loadBases();

// ══════════════════════════════════════════════════════════════════════════════
// ─── ASSISTENTE DE BASE ───────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// ── Estado ────────────────────────────────────────────────────────────────────
let asstUltimoArquivo = null;
let asstUltimosDados  = null;

// ── Helpers de status e loading ───────────────────────────────────────────────
function asstSetStatus(msg, tipo) {
  const el = document.getElementById("asst-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "asst-status-msg" + (tipo ? ` asst-status-${tipo}` : "");
  el.style.display = msg ? "block" : "none";
}

function asstSetLoading(on) {
  const btn = document.getElementById("asst-btn-preview");
  const txt = document.getElementById("asst-btn-text");
  const spn = document.getElementById("asst-btn-spinner");
  if (btn) btn.disabled = on;
  if (txt) txt.textContent = on ? "Analisando…" : "Analisar planilha";
  if (spn) spn.style.display = on ? "inline-block" : "none";
}

function asstSetReanaliseLoading(on) {
  const btn = document.getElementById("asst-btn-reanalisar");
  const txt = document.getElementById("asst-btn-reanalisar-text");
  const spn = document.getElementById("asst-btn-reanalisar-spinner");
  if (btn) btn.disabled = on;
  if (txt) txt.textContent = on ? "Analisando…" : "Reanalisar com colunas selecionadas";
  if (spn) spn.style.display = on ? "inline-block" : "none";
}

function asstReset() {
  asstSetStatus("", "");
  asstUltimosDados = null;
  const el = document.getElementById("asst-preview");
  if (el) { el.innerHTML = ""; el.style.display = "none"; }
  const sec = document.getElementById("asst-import-section");
  if (sec) sec.style.display = "none";
  asstSetImportStatus("", "");
}

// ── Dropzone ──────────────────────────────────────────────────────────────────
function asstValidarExtensao(file) {
  const n = String(file && file.name || "").toLowerCase();
  return n.endsWith(".xlsx") || n.endsWith(".xls") || n.endsWith(".csv");
}

function asstMostrarArquivoDropzone(file) {
  const idle     = document.getElementById("asst-dz-idle");
  const fileEl   = document.getElementById("asst-dz-file");
  const filename = document.getElementById("asst-dz-filename");
  const dz       = document.getElementById("asst-dropzone");
  if (idle)     idle.style.display   = "none";
  if (fileEl)   fileEl.style.display = "flex";
  if (filename) filename.textContent = file ? file.name : "—";
  if (dz)       dz.classList.add("asst-dz-has-file");
}

function asstLimparDropzone() {
  const input = document.getElementById("asst-arquivo");
  const idle  = document.getElementById("asst-dz-idle");
  const fileEl = document.getElementById("asst-dz-file");
  const dz    = document.getElementById("asst-dropzone");
  if (input) { try { input.value = ""; } catch (_) {} }
  if (idle)   idle.style.display   = "";
  if (fileEl) fileEl.style.display = "none";
  if (dz)     dz.classList.remove("asst-dz-has-file", "asst-dz-active");
  asstUltimoArquivo = null;
  asstReset();
}

function asstDefinirArquivo(file) {
  if (!file) return;
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById("asst-arquivo");
    if (input) input.files = dt.files;
  } catch (_) {}
  asstUltimoArquivo = file;
  asstMostrarArquivoDropzone(file);
  asstReset();
}

(function asstInitDropzone() {
  const dz       = document.getElementById("asst-dropzone");
  const input    = document.getElementById("asst-arquivo");
  const clearBtn = document.getElementById("asst-dz-clear");
  if (!dz || !input) return;

  dz.addEventListener("click", (e) => {
    if (e.target.closest("#asst-dz-clear")) return;
    input.click();
  });
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  input.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (!asstValidarExtensao(f)) { asstSetStatus("Formato inválido. Envie .xlsx, .xls ou .csv.", "erro"); return; }
    asstUltimoArquivo = f;
    asstMostrarArquivoDropzone(f);
    asstReset();
  });
  ["dragenter", "dragover"].forEach((evt) => {
    dz.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); dz.classList.add("asst-dz-active"); });
  });
  ["dragleave", "dragend"].forEach((evt) => {
    dz.addEventListener(evt, (e) => { if (!dz.contains(e.relatedTarget)) dz.classList.remove("asst-dz-active"); });
  });
  dz.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation();
    dz.classList.remove("asst-dz-active");
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (!files.length) return;
    const file = files[0];
    if (!asstValidarExtensao(file)) { asstSetStatus("Formato inválido. Envie .xlsx, .xls ou .csv.", "erro"); return; }
    asstDefinirArquivo(file);
  });
  if (clearBtn) {
    clearBtn.addEventListener("click", (e) => { e.stopPropagation(); asstLimparDropzone(); });
  }
})();

// ── Confiança ─────────────────────────────────────────────────────────────────
function asstConfiancaClass(score) {
  if (score === null || score === undefined) return "asst-conf-none";
  if (score >= 80) return "asst-conf-high";
  if (score >= 60) return "asst-conf-med";
  return "asst-conf-low";
}

// ── Selects de colunas manuais ────────────────────────────────────────────────
function asstBuildSelectOptions(disponiveis, valorAtual) {
  const opts = ['<option value="">— Selecionar manualmente —</option>'];
  (Array.isArray(disponiveis) ? disponiveis : []).forEach((c) => {
    const v   = escapeHTML(String(c.coluna || ""));
    const lbl = escapeHTML(c.coluna + " — " + c.cabecalho);
    const sel = c.coluna === valorAtual ? " selected" : "";
    opts.push(`<option value="${v}"${sel}>${lbl}</option>`);
  });
  return opts.join("");
}

function asstRenderSelects(disponiveis, detectadas) {
  const valId      = (detectadas && detectadas.id      && detectadas.id.coluna)      || "";
  const valCusto   = (detectadas && detectadas.custo   && detectadas.custo.coluna)   || "";
  const valImposto = (detectadas && detectadas.imposto && detectadas.imposto.coluna) || "";

  const alertaId = !valId
    ? `<div class="asst-select-alerta">Não foi possível detectar a coluna de ID — selecione manualmente e reanalise.</div>`
    : "";

  return `
    <div class="asst-result-section asst-manual-section">
      <div class="asst-section-title">Ajuste de colunas</div>
      <div class="asst-selects-grid">
        <div class="asst-select-item${!valId ? " asst-select-item-needed" : ""}">
          <label class="asst-select-label" for="asst-sel-id">Coluna de ID</label>
          ${alertaId}
          <select id="asst-sel-id" class="vf-input asst-select">
            ${asstBuildSelectOptions(disponiveis, valId)}
          </select>
        </div>
        <div class="asst-select-item">
          <label class="asst-select-label" for="asst-sel-custo">Coluna de Custo</label>
          <select id="asst-sel-custo" class="vf-input asst-select">
            ${asstBuildSelectOptions(disponiveis, valCusto)}
          </select>
        </div>
        <div class="asst-select-item">
          <label class="asst-select-label" for="asst-sel-imposto">Coluna de Imposto</label>
          <select id="asst-sel-imposto" class="vf-input asst-select">
            ${asstBuildSelectOptions(disponiveis, valImposto)}
          </select>
        </div>
      </div>
      <div style="margin-top:14px;display:flex;justify-content:flex-end;">
        <button id="asst-btn-reanalisar" onclick="asstReanalisar()" class="vf-btn-secondary" style="width:auto;margin:0;">
          <span id="asst-btn-reanalisar-text">Reanalisar com colunas selecionadas</span>
          <span id="asst-btn-reanalisar-spinner" class="btn-spinner" style="display:none;"></span>
        </button>
      </div>
    </div>`;
}

// ── Render principal ──────────────────────────────────────────────────────────
function asstRenderColunas(colunas) {
  const tipos  = ["id", "custo", "imposto"];
  const labels = { id: "ID", custo: "Custo", imposto: "Imposto" };
  return tipos.map((t) => {
    const c = colunas && colunas[t];
    if (!c) {
      return `<div class="asst-col-item asst-col-missing">
        <span class="asst-col-label">${labels[t]}</span>
        <span class="asst-col-not-found">Não detectado</span>
      </div>`;
    }
    const cls = asstConfiancaClass(c.confianca);
    return `<div class="asst-col-item">
      <span class="asst-col-label">${labels[t]}</span>
      <span class="asst-col-value"><strong>${escapeHTML(String(c.coluna || "—"))}</strong>&nbsp;—&nbsp;${escapeHTML(String(c.cabecalho || "—"))}</span>
      <span class="asst-conf-badge ${cls}">${c.confianca != null ? c.confianca + "%" : "—"}</span>
    </div>`;
  }).join("");
}

function asstRenderAlertas(alertas) {
  if (!Array.isArray(alertas) || !alertas.length) return "";
  return alertas.map((a) => {
    const cls = a.nivel === "erro"    ? "asst-alerta-erro"
              : a.nivel === "warning" ? "asst-alerta-warning"
              : a.nivel === "aviso"   ? "asst-alerta-aviso"
              : "asst-alerta-info";
    return `<div class="asst-alerta-item ${cls}">${escapeHTML(String(a.mensagem || ""))}</div>`;
  }).join("");
}

function asstRenderPreview(data) {
  const el = document.getElementById("asst-preview");
  if (!el) return;

  const resumo      = data.resumo   || {};
  const alertas     = data.alertas  || [];
  const rows        = Array.isArray(data.preview) ? data.preview : [];
  const disponiveis = Array.isArray(data.colunas_disponiveis) ? data.colunas_disponiveis : [];

  // ── Resumo cards ──
  const summaryCards = [
    { label: "Linhas lidas",       value: resumo.linhas_lidas        != null ? resumo.linhas_lidas        : "—" },
    { label: "Linhas válidas",     value: resumo.linhas_validas      != null ? resumo.linhas_validas      : "—" },
    { label: "Importáveis",        value: resumo.linhas_importaveis  != null ? resumo.linhas_importaveis  : "—" },
    { label: "Ignoradas",          value: resumo.linhas_ignoradas    != null ? resumo.linhas_ignoradas    : "—" },
    { label: "Duplicados",         value: resumo.duplicados          != null ? resumo.duplicados          : "—" },
  ].map((c) => `
    <div class="asst-summary-card">
      <div class="asst-summary-label">${escapeHTML(String(c.label))}</div>
      <div class="asst-summary-value">${escapeHTML(String(c.value))}</div>
    </div>`).join("");

  // ── Detecção strip ──
  const linhaExibida = data.linha_cabecalho != null ? data.linha_cabecalho + 1 : "—";
  const confianca    = data.confianca_geral != null ? data.confianca_geral + "%" : "—";
  const detecHtml = `
    <div class="asst-detec-info">
      <span><strong>Aba:</strong> ${escapeHTML(String(data.aba_detectada || "—"))}</span>
      <span><strong>Cabeçalho na linha:</strong> ${linhaExibida}</span>
      <span><strong>Confiança geral:</strong> ${confianca}</span>
    </div>`;

  // ── Alertas ──
  const alertasRendered = asstRenderAlertas(alertas);
  const alertasHtml = alertasRendered
    ? `<div class="asst-result-section">
        <div class="asst-section-title">Alertas</div>
        <div class="asst-alertas-wrap">${alertasRendered}</div>
       </div>`
    : "";

  // ── Tabela de preview ──
  let tableHtml = "";
  if (rows.length) {
    const tbody = rows.map((r, i) => {
      const custo   = r.custo   != null ? Number(r.custo).toFixed(2)              : "—";
      const imposto = r.imposto != null ? (Number(r.imposto) * 100).toFixed(2) + "%" : "—";
      return `<tr>
        <td style="color:var(--vf-text-l);font-family:var(--vf-mono);font-size:.8rem;">${i + 1}</td>
        <td style="font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(r.id ?? "—"))}</td>
        <td style="text-align:right;">${escapeHTML(custo)}</td>
        <td style="text-align:right;">${escapeHTML(imposto)}</td>
      </tr>`;
    }).join("");
    tableHtml = `
      <div class="asst-preview-table-wrap">
        <div class="asst-preview-table-title">Prévia — até 50 linhas (${rows.length} exibida${rows.length !== 1 ? "s" : ""})</div>
        <table class="vf-table">
          <thead>
            <tr>
              <th style="width:40px;">#</th>
              <th>ID</th>
              <th style="text-align:right;width:120px;">Custo (R$)</th>
              <th style="text-align:right;width:120px;">Imposto</th>
            </tr>
          </thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>`;
  } else {
    tableHtml = `<div class="asst-empty-preview">Nenhuma linha válida encontrada na prévia.</div>`;
  }

  el.innerHTML = `
    <div class="vf-assistente-base-result">
      <div class="asst-result-section">
        <div class="asst-section-title">Resumo da análise</div>
        <div class="asst-summary-grid">${summaryCards}</div>
        ${detecHtml}
      </div>
      <div class="asst-result-section">
        <div class="asst-section-title">Colunas detectadas</div>
        <div class="asst-colunas-grid">${asstRenderColunas(data.colunas_detectadas)}</div>
      </div>
      ${asstRenderSelects(disponiveis, data.colunas_detectadas)}
      ${alertasHtml}
      ${tableHtml}
    </div>`;

  el.style.display = "block";

  const importSec = document.getElementById("asst-import-section");
  if (importSec) importSec.style.display = "block";
  asstAtualizarBotaoImportar();
}

// ── Reanálise ─────────────────────────────────────────────────────────────────
async function asstReanalisar() {
  const selId      = ((document.getElementById("asst-sel-id")      || {}).value || "").trim();
  const selCusto   = ((document.getElementById("asst-sel-custo")   || {}).value || "").trim();
  const selImposto = ((document.getElementById("asst-sel-imposto") || {}).value || "").trim();

  const config = { colunas: {} };
  if (selId)      config.colunas.id      = selId;
  if (selCusto)   config.colunas.custo   = selCusto;
  if (selImposto) config.colunas.imposto = selImposto;

  // Preservar aba e linha detectadas na análise anterior
  if (asstUltimosDados) {
    if (asstUltimosDados.aba_detectada)       config.aba             = asstUltimosDados.aba_detectada;
    if (asstUltimosDados.linha_cabecalho != null) config.linhaCabecalho = asstUltimosDados.linha_cabecalho;
  }

  await asstEnviarPreview(config);
}

// ── Envio principal ───────────────────────────────────────────────────────────
async function asstEnviarPreview(configOverride) {
  const fileInput = document.getElementById("asst-arquivo");
  const arquivo   = asstUltimoArquivo || (fileInput && fileInput.files && fileInput.files[0]);

  asstSetStatus("", "");

  if (!arquivo) {
    asstSetStatus("Selecione um arquivo .xlsx, .xls ou .csv.", "erro");
    return;
  }
  if (!asstValidarExtensao(arquivo)) {
    asstSetStatus("Formato inválido. Envie .xlsx, .xls ou .csv.", "erro");
    return;
  }

  const isReanalisar = !!configOverride;
  if (isReanalisar) {
    asstSetReanaliseLoading(true);
  } else {
    asstSetLoading(true);
    const el = document.getElementById("asst-preview");
    if (el) { el.innerHTML = ""; el.style.display = "none"; }
    const importSec = document.getElementById("asst-import-section");
    if (importSec) importSec.style.display = "none";
    asstSetImportStatus("", "");
  }

  try {
    const fd = new FormData();
    fd.append("arquivo", arquivo);
    if (configOverride && Object.keys(configOverride).length) {
      fd.append("config", JSON.stringify(configOverride));
    }

    const res = await fetch(`${API_BASE}/bases/assistente/preview`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fd,
    });

    if (res.status === 401) { clearSession(); return; }

    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      asstSetStatus(data.erro || `Erro ${res.status} ao analisar a planilha.`, "erro");
      return;
    }

    asstUltimoArquivo = arquivo;
    asstUltimosDados  = data;
    asstRenderPreview(data);

  } catch (err) {
    asstSetStatus("Erro de conexão: " + (err.message || "tente novamente."), "erro");
  } finally {
    asstSetLoading(false);
    asstSetReanaliseLoading(false);
  }
}

// ── Baixar base existente ─────────────────────────────────────────────────────
async function asstBaixarBase(slug, nome, btn) {
  const textoOriginal = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Aguarde…"; }

  try {
    const res = await fetch(`${API_BASE}/bases/${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (res.status === 401) { clearSession(); return; }
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.ok) {
      alert("Erro ao buscar base: " + (data.erro || `HTTP ${res.status}`));
      return;
    }

    const dados = data.dados || {};
    const entradas = Object.entries(dados);
    if (!entradas.length) {
      alert(`A base "${nome}" não possui itens cadastrados para baixar.`);
      return;
    }

    const linhas = entradas.map(([produtoId, v]) => {
      const id      = String(produtoId).replace(/"/g, '""');
      const custo   = v.custo_produto   != null ? Number(v.custo_produto).toFixed(2)  : "";
      const imposto = v.imposto_percentual != null ? Number(v.imposto_percentual).toFixed(6) : "";
      return `"${id}",${custo},${imposto}`;
    });
    const csv = "ID,Custo,Imposto\n" + linhas.join("\n");

    const nomeArquivo = "base-" + String(slug || nome).replace(/[^a-z0-9_\-]/gi, "_") + ".csv";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = nomeArquivo;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Erro ao baixar base: " + (err.message || "tente novamente."));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = textoOriginal; }
  }
}

// ── Importação final ──────────────────────────────────────────────────────────
function asstSetImportStatus(msg, tipo) {
  const el = document.getElementById("asst-import-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "asst-status-msg" + (tipo ? ` asst-status-${tipo}` : "");
  el.style.display = msg ? "block" : "none";
}

function asstSetImportLoading(on) {
  const btn = document.getElementById("asst-btn-importar-limpa");
  const txt = document.getElementById("asst-btn-importar-text");
  const spn = document.getElementById("asst-btn-importar-spinner");
  if (btn) btn.disabled = on;
  if (txt) txt.textContent = on ? "Importando…" : "Importar base limpa";
  if (spn) spn.style.display = on ? "inline-block" : "none";
}

function asstAtualizarBotaoImportar() {
  const btn = document.getElementById("asst-btn-importar-limpa");
  if (!btn) return;
  const nome = (document.getElementById("asst-nome-base") || {}).value || "";
  const temDados = asstUltimosDados &&
    Array.isArray(asstUltimosDados.dados_importacao) &&
    asstUltimosDados.dados_importacao.length > 0;
  btn.disabled = !(temDados && nome.trim().length > 0);
}

function asstGerarCsv(linhas) {
  const rows = linhas.filter(r => r.id != null && String(r.id).trim() !== "");
  const lines = rows.map(r => {
    const id      = String(r.id ?? "").replace(/"/g, '""');
    const custo   = r.custo   != null ? Number(r.custo).toFixed(2)   : "";
    const imposto = r.imposto != null ? Number(r.imposto).toFixed(6)  : "";
    return `"${id}",${custo},${imposto}`;
  });
  return "ID,Custo,Imposto\n" + lines.join("\n");
}

async function asstImportarBaseLimpa() {
  if (!asstUltimosDados) return;

  const nome = ((document.getElementById("asst-nome-base") || {}).value || "").trim();
  if (!nome) {
    asstSetImportStatus("Informe o nome da base antes de importar.", "erro");
    return;
  }

  if (!Array.isArray(asstUltimosDados.dados_importacao) || !asstUltimosDados.dados_importacao.length) {
    asstSetImportStatus("Não foi possível carregar todas as linhas normalizadas. Reanalise a planilha.", "erro");
    return;
  }

  const linhasImportaveis = asstUltimosDados.dados_importacao;

  const confirmou = confirm(
    `Importar "${nome}" com ${linhasImportaveis.length} linha(s) normalizada(s)?\n\nEsta ação substituirá a base existente com este nome.`
  );
  if (!confirmou) return;

  asstSetImportLoading(true);
  asstSetImportStatus("", "");

  try {
    const csv      = asstGerarCsv(linhasImportaveis);
    const blob     = new Blob([csv], { type: "text/csv" });
    const arquivo  = new File([blob], `${nome.replace(/[^a-z0-9_\-]/gi, "_")}.csv`, { type: "text/csv" });

    const fd = new FormData();
    fd.append("arquivo",   arquivo);
    fd.append("nomeBase",  nome);
    fd.append("marketplace", "meli");
    fd.append("confirmar", "true");

    const res = await fetch(`${API_BASE}/importar-base`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: fd,
    });

    if (res.status === 401) { clearSession(); return; }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      asstSetImportStatus(data.erro || data.message || `Erro ${res.status} ao importar.`, "erro");
      return;
    }

    asstSetImportStatus(`Base "${nome}" importada com sucesso!`, "ok");
    loadBases();

  } catch (err) {
    asstSetImportStatus("Erro de conexão: " + (err.message || "tente novamente."), "erro");
  } finally {
    asstSetImportLoading(false);
  }
}

(function asstInitImportacao() {
  const input = document.getElementById("asst-nome-base");
  if (input) input.addEventListener("input", asstAtualizarBotaoImportar);

  const btn = document.getElementById("asst-btn-importar-limpa");
  if (btn) btn.addEventListener("click", asstImportarBaseLimpa);
})();

// ── Botão analisar ────────────────────────────────────────────────────────────
(function () {
  const btn = document.getElementById("asst-btn-preview");
  if (btn) btn.addEventListener("click", () => asstEnviarPreview());
})();
