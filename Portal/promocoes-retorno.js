// Portal/promocoes-retorno.js
// Tela "Promoções ML" — somente leitura, cockpit de decisão.
// Consome GET /automacoes/clientes (prontidão), GET /automacoes/promocoes-retorno/preview
// (consulta rápida), POST/GET diagnóstico e GET snapshot. Não altera nada no ML nem no banco.
//
// A base MELI do cliente é resolvida automaticamente pelo backend
// (contextoPrecificacaoService). Esta tela nunca envia baseSlug no fluxo novo —
// o backend aceita baseSlug por compatibilidade, mas o frontend não usa mais.

const STORAGE_KEY = "vf-token";
const API_BASE = "https://venforce-server.onrender.com";

function getToken() {
  const t = localStorage.getItem(STORAGE_KEY);
  if (!t) { window.location.replace("index.html"); return null; }
  return t;
}

const TOKEN = getToken();
const user = JSON.parse(localStorage.getItem("vf-user") || "{}");
const role = String(user.role || "").toLowerCase();
const canAccess = role === "admin" || role === "user" || role === "membro";
if (!canAccess) window.location.replace("dashboard.html");
initLayout();

// ─── Fronteira arquitetural para futura ação PUT (não implementada) ────────
// Nenhum endpoint de escrita existe hoje. Quando uma operação PUT de
// entrada/alteração de promoção for implementada, ativar aqui (enabled:true,
// endpoint:"...") — a UI (drawer footer) já está preparada para isso.
const PROMO_WRITE_CAPABILITY = { enabled: false, endpoint: null };

function buildPromotionActionIntent(row) {
  return {
    itemId: row?.itemId || null,
    promotionId: row?.promotionId || null,
    promotionType: row?.promotionType || null,
    promotionStatus: row?.promotionStatus || null,
    offerRefId: row?.offerRefId || null,
    campaignName: row?.campanha || null,
  };
}

function canApplyPromotion(row) {
  return Boolean(
    PROMO_WRITE_CAPABILITY.enabled &&
    row?.itemId &&
    row?.promotionId
  );
}

// ─── Estado ─────────────────────────────────────────────────────────────────
const COLUMNS_STORAGE_KEY = "vf-promo-colunas-v2";
const PROMO_RENDER_LIMIT = 50;
const PROMO_POLL_INTERVAL_MS = 3000;
const PROMO_POLL_SLOW_MS = 5000;
const PROMO_POLL_SLOW_AFTER_MS = 2 * 60 * 1000;

const PromoState = {
  clientes: [],
  clienteSlug: null,
  contexto: { grant: null, base: null, pronto: false, motivo: null, raw: null },
  mode: "idle", // idle | quick | diagnostico
  snapshot: { exists: false, id: null, meta: null, checking: false },
  job: { id: null, startedAt: null, timer: null },
  data: { rows: [], meta: null, origem: null },
  table: { search: "", decision: "todos", origin: "todas", campaign: "todas", columns: [] },
  ui: { advancedOpen: false, quickOpen: false, drawerRow: null, lastFocusedEl: null },
};

// ─── Colunas ────────────────────────────────────────────────────────────────
const PROMO_COLUMNS = [
  { key: "mlbsku", label: "MLB / SKU", required: true },
  { key: "titulo", label: "Título", required: true },
  { key: "campanha", label: "Promoção / campanha", default: true },
  { key: "origem", label: "Origem", default: true },
  { key: "precoOriginal", label: "Preço original", default: true, num: true },
  { key: "precoPromocao", label: "Preço promocional", default: true, num: true },
  { key: "retornoMl", label: "Retorno ML", default: true, num: true },
  { key: "mcComRetorno", label: "MC com retorno", required: true, num: true },
  { key: "diferencaPp", label: "Dif. para o alvo", default: true, num: true },
  { key: "decisao", label: "Decisão", required: true },
  { key: "descontoTotal", label: "Desconto total", num: true },
  { key: "sellerPercentage", label: "Seller %", num: true },
  { key: "meliPercentage", label: "Meli %", num: true },
  { key: "comissaoPercentual", label: "Comissão %", num: true },
  { key: "comissaoValor", label: "Comissão R$", num: true },
  { key: "frete", label: "Frete", num: true },
  { key: "custo", label: "Custo", num: true },
  { key: "impostoPercentual", label: "Imposto %", num: true },
  { key: "lcComRetorno", label: "LC com retorno", num: true },
  { key: "margemAlvo", label: "Margem alvo", num: true },
  { key: "motivo", label: "Motivo" },
  { key: "acoes", label: "Ações", required: true },
];

function colunasVisiveisPadrao() {
  return PROMO_COLUMNS.filter((c) => !c.required && c.default).map((c) => c.key);
}

function carregarColunasVisiveis() {
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (!raw) return colunasVisiveisPadrao();
    const salvas = JSON.parse(raw);
    if (!Array.isArray(salvas)) return colunasVisiveisPadrao();
    const validas = new Set(PROMO_COLUMNS.map((c) => c.key));
    return salvas.filter((k) => validas.has(k));
  } catch (_) {
    return colunasVisiveisPadrao();
  }
}

function salvarColunasVisiveis() {
  try { localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(PromoState.table.columns)); }
  catch (_) { /* localStorage indisponível — segue em memória */ }
}

function colunasVisiveis() {
  const set = new Set(PromoState.table.columns);
  return PROMO_COLUMNS.filter((c) => c.required || set.has(c.key));
}

// ─── Decisão / filtros ──────────────────────────────────────────────────────
const DECISAO_INFO = {
  entrar_seguro:          { label: "Entrar seguro",        tone: "success" },
  entrar_com_tolerancia:  { label: "Dentro da tolerância", tone: "info" },
  baixo_mesmo_com_rebate: { label: "Margem baixa",         tone: "warning" },
  nao_entrar:             { label: "Não recomendado",      tone: "danger" },
  sem_relatorio:          { label: "Sem relatório",        tone: "neutral" },
  dados_incompletos:      { label: "Dados incompletos",    tone: "neutral" },
};

// Grupos de decisão usados nos filtros. "sem_dados" e "nao_recomendadas" são
// chaves sintéticas (agrupam mais de um valor de `decisao`) — não alteram a
// classificação original, só a forma de filtrar/exibir na UI.
const DECISION_FILTER_GROUPS = {
  todos: null,
  entrar_seguro: ["entrar_seguro"],
  entrar_com_tolerancia: ["entrar_com_tolerancia"],
  baixo_mesmo_com_rebate: ["baixo_mesmo_com_rebate"],
  nao_entrar: ["nao_entrar"],
  nao_recomendadas: ["baixo_mesmo_com_rebate", "nao_entrar"],
  sem_dados: ["sem_relatorio", "dados_incompletos"],
};

const DECISION_FILTER_LABELS = {
  todos: "Todos",
  entrar_seguro: "Entrar seguro",
  entrar_com_tolerancia: "Em tolerância",
  baixo_mesmo_com_rebate: "Margem baixa",
  nao_entrar: "Não entrar",
  nao_recomendadas: "Não recomendadas",
  sem_dados: "Sem dados",
};

const PROMO_QUICKCHIPS = ["todos", "entrar_seguro", "entrar_com_tolerancia", "baixo_mesmo_com_rebate", "nao_entrar", "sem_dados"];

const ORIGEM_FILTERS = [
  { key: "todas", label: "Todas as origens" },
  { key: "criadas_por_mim", label: "Criadas por mim" },
  { key: "com_retorno_ml", label: "Com retorno ML" },
  { key: "sem_retorno_ml", label: "Sem retorno ML" },
];

function matchOrigem(l, key) {
  if (key === "todas") return true;
  const comRetorno = l.temRetornoMl || Number(l.meliPercentage) > 0;
  if (key === "criadas_por_mim") return l.criadaPorMim === true;
  if (key === "com_retorno_ml") return comRetorno;
  if (key === "sem_retorno_ml") return !comRetorno;
  return true;
}

function matchDecision(l, key) {
  const grupo = DECISION_FILTER_GROUPS[key];
  if (!grupo) return true;
  return grupo.includes(l.decisao);
}

// ─── Helpers ────────────────────────────────────────────────────────────────
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

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const NUM2 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function brl(n) {
  const v = Number(n);
  return Number.isFinite(v) ? BRL.format(v) : "—";
}
function pctFrac(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${NUM2.format(v * 100)}%` : "—";
}
function pctRaw(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${NUM2.format(v)}%` : "—";
}
function pp(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${NUM2.format(v * 100)} p.p.` : "—";
}
function txt(s) {
  return (s === null || s === undefined || s === "") ? "—" : String(s);
}
function fmtDataHora(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("pt-BR"); } catch (_) { return String(iso); }
}
function fmtIdadeBase(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const dataCurta = d.toLocaleDateString("pt-BR");
  const dias = Math.floor((Date.now() - d.getTime()) / 86400000);
  let idade;
  if (dias <= 0) idade = "hoje";
  else if (dias === 1) idade = "ontem";
  else if (dias < 30) idade = `há ${dias} dias`;
  else if (dias < 365) idade = `há ${Math.floor(dias / 30)} meses`;
  else idade = `há ${Math.floor(dias / 365)} ano(s)`;
  return `${dataCurta} · ${idade}`;
}
function fmtIdadeMinutos(min) {
  const n = Number(min);
  if (!Number.isFinite(n)) return "—";
  return n < 60 ? `${n} min` : `${Math.floor(n / 60)}h${n % 60 ? ` ${n % 60}min` : ""}`;
}
function sum(rows, pick) {
  return rows.reduce((acc, r) => { const v = Number(pick(r)); return acc + (Number.isFinite(v) ? v : 0); }, 0);
}
function avg(nums) {
  const vals = nums.filter((n) => Number.isFinite(n));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function isBusy() {
  return !!PromoState.job.id;
}

// ─── Feedback / banners ─────────────────────────────────────────────────────
function setFeedback(msg, tone) {
  const el = document.getElementById("promo-feedback");
  if (!el) return;
  if (!msg) { el.hidden = true; el.innerHTML = ""; return; }
  el.className = `vf-banner${tone ? " is-" + tone : ""}`;
  el.innerHTML = `<div class="vf-banner__content"><p class="vf-banner__description">${escapeHTML(msg)}</p></div>`;
  el.hidden = false;
}

function setReadinessBanner({ tone, titulo, descricao, linkBases = false } = {}) {
  const el = document.getElementById("promo-readiness-banner");
  if (!el) return;
  if (!titulo && !descricao) { el.hidden = true; el.innerHTML = ""; return; }
  el.className = `vf-banner${tone ? " is-" + tone : ""}`;
  el.innerHTML = `
    <div class="vf-banner__content">
      ${titulo ? `<p class="vf-banner__title">${escapeHTML(titulo)}</p>` : ""}
      ${descricao ? `<p class="vf-banner__description">${escapeHTML(descricao)}</p>` : ""}
      ${linkBases ? `<div class="vf-banner__actions"><a class="vf-btn vf-btn--secondary vf-btn--sm" href="bases.html">Ajustar em Bases de Custo</a></div>` : ""}
    </div>`;
  el.hidden = false;
}

// ─── Clientes ───────────────────────────────────────────────────────────────
async function loadClientes() {
  if (!TOKEN) return;
  const select = document.getElementById("promo-cliente");
  if (select) { select.disabled = true; select.innerHTML = `<option value="">Carregando…</option>`; }
  try {
    const res = await fetch(`${API_BASE}/automacoes/clientes`, { headers: { Authorization: "Bearer " + TOKEN } });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    PromoState.clientes = Array.isArray(data.clientes) ? data.clientes : [];
    renderClienteOptions(PromoState.clientes);
    if (select) select.disabled = false;
    if (!PromoState.clientes.length) setFeedback("Nenhum cliente ativo encontrado.", "warning");
  } catch (_) {
    PromoState.clientes = [];
    if (select) { select.disabled = true; select.innerHTML = `<option value="">Erro ao carregar clientes</option>`; }
    setFeedback("Não foi possível carregar os clientes. Tente novamente.", "danger");
  }
}

function renderClienteOptions(clientes) {
  const select = document.getElementById("promo-cliente");
  if (!select) return;
  const atual = select.value || "";
  select.innerHTML = "";
  select.appendChild(new Option("Selecione um cliente…", ""));
  (Array.isArray(clientes) ? clientes : []).forEach((c) => {
    const slug = c.slug || "";
    const nome = c.nome || slug || "—";
    select.appendChild(new Option(`${nome} (${slug})`, slug));
  });
  if (atual && clientes.some((c) => (c.slug || "") === atual)) select.value = atual;
}

function applyClienteSearch() {
  const q = (document.getElementById("promo-cliente-search")?.value || "").trim().toLowerCase();
  const filtrados = !q ? PromoState.clientes : PromoState.clientes.filter((c) => {
    const nome = String(c.nome || "").toLowerCase();
    const slug = String(c.slug || "").toLowerCase();
    return nome.includes(q) || slug.includes(q);
  });
  renderClienteOptions(filtrados);
}

function getClienteAtual() {
  const slug = document.getElementById("promo-cliente")?.value || "";
  if (!slug) return null;
  return PromoState.clientes.find((c) => (c.slug || "") === slug) || null;
}

// ─── Prontidão (grant + base MELI, resolvidos automaticamente) ─────────────
function pararPolling() {
  if (PromoState.job.timer) { clearTimeout(PromoState.job.timer); PromoState.job.timer = null; }
  PromoState.job.id = null;
}

function resetResultado() {
  pararPolling();
  PromoState.mode = "idle";
  PromoState.data = { rows: [], meta: null, origem: null };
  PromoState.table.search = "";
  PromoState.table.decision = "todos";
  PromoState.table.origin = "todas";
  PromoState.table.campaign = "todas";
  const searchInput = document.getElementById("promo-table-search");
  if (searchInput) searchInput.value = "";
  document.getElementById("promo-databar-card").hidden = true;
  document.getElementById("promo-resumo-section").hidden = true;
  document.getElementById("promo-workspace").hidden = true;
  document.getElementById("promo-empty-inicial").hidden = false;
  setFeedback("");
}

function onClienteChange() {
  resetResultado();
  PromoState.snapshot = { exists: false, id: null, meta: null, checking: false };
  const slug = document.getElementById("promo-cliente")?.value || "";
  PromoState.clienteSlug = slug || null;

  const statusRow = document.getElementById("promo-context-status");
  const ctx = getClienteAtual();

  if (!ctx) {
    if (statusRow) statusRow.hidden = true;
    setReadinessBanner({});
    PromoState.contexto = { grant: null, base: null, pronto: false, motivo: null, raw: null };
    updateActionButtons();
    return;
  }

  PromoState.contexto = {
    grant: ctx.hasGrantMl,
    base: ctx.baseStatus,
    pronto: ctx.prontoParaAnalise,
    motivo: ctx.baseStatus,
    raw: ctx,
  };

  renderContextStatus(ctx);
  updateActionButtons();

  if (ctx.prontoParaAnalise) verificarSnapshotDisponivel();
}

function renderContextStatus(ctx) {
  const statusRow = document.getElementById("promo-context-status");
  if (statusRow) statusRow.hidden = false;

  setStatusChip("promo-ctx-grant", ctx.hasGrantMl ? "success" : "danger", ctx.hasGrantMl ? "Conectado" : "Não conectado");

  const baseEl = document.getElementById("promo-ctx-base");
  const updEl = document.getElementById("promo-ctx-base-updated");
  if (ctx.baseStatus === "ok") {
    if (baseEl) baseEl.textContent = ctx.baseMeliNome || ctx.baseMeli || "—";
    if (updEl) updEl.textContent = fmtIdadeBase(ctx.baseMeliUpdatedAt);
  } else if (ctx.baseStatus === "multiplas") {
    if (baseEl) baseEl.textContent = `${ctx.basesMeliCount} bases vinculadas`;
    if (updEl) updEl.textContent = "—";
  } else {
    if (baseEl) baseEl.textContent = "Nenhuma vinculada";
    if (updEl) updEl.textContent = "—";
  }

  setStatusChip("promo-ctx-snapshot", "neutral", ctx.prontoParaAnalise ? "Verificando…" : "—");

  if (!ctx.hasGrantMl) {
    setReadinessBanner({
      tone: "danger",
      titulo: "Cliente sem conta ML conectada",
      descricao: "Conecte a conta do Mercado Livre deste cliente para habilitar a análise de promoções.",
    });
  } else if (ctx.baseStatus === "ausente") {
    setReadinessBanner({
      tone: "warning",
      titulo: "Cliente sem base MELI vinculada",
      descricao: "Vincule uma base de custo ao Mercado Livre para habilitar a análise.",
      linkBases: true,
    });
  } else if (ctx.baseStatus === "multiplas") {
    setReadinessBanner({
      tone: "warning",
      titulo: "Mais de uma base MELI vinculada",
      descricao: "O vínculo está ambíguo. Corrija em Bases de Custo para que apenas uma base MELI fique ativa.",
      linkBases: true,
    });
  } else {
    setReadinessBanner({});
  }
}

function setStatusChip(id, tone, texto) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `vf-status${tone ? " is-" + tone : ""}`;
  el.textContent = texto;
}

function updateDiagnosticoButtonLabel() {
  const btn = document.getElementById("btn-promo-diagnostico");
  if (!btn) return;
  btn.textContent = PromoState.snapshot.exists ? "Atualizar diagnóstico" : "Gerar diagnóstico";
}

function updateActionButtons() {
  const pronto = !!PromoState.contexto.pronto;
  const busy = isBusy();
  const diagBtn = document.getElementById("btn-promo-diagnostico");
  const snapBtn = document.getElementById("btn-promo-snapshot-usar");
  const quickBtn = document.getElementById("btn-promo-analisar");
  if (diagBtn) diagBtn.disabled = !pronto || busy;
  if (snapBtn) snapBtn.disabled = !pronto || busy || !PromoState.snapshot.exists;
  if (quickBtn) quickBtn.disabled = !pronto || busy;
  updateDiagnosticoButtonLabel();
}

async function verificarSnapshotDisponivel() {
  PromoState.snapshot.checking = true;
  const clienteSlug = PromoState.clienteSlug;
  if (!clienteSlug) return;
  try {
    const qs = new URLSearchParams({ clienteSlug });
    const res = await fetch(`${API_BASE}/automacoes/promocoes-retorno/snapshot?${qs.toString()}`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (PromoState.clienteSlug !== clienteSlug) return; // cliente trocou — resposta obsoleta
    PromoState.snapshot.exists = !!data.existe;
    PromoState.snapshot.checking = false;
    setStatusChip("promo-ctx-snapshot", PromoState.snapshot.exists ? "success" : "neutral", PromoState.snapshot.exists ? "Disponível" : "Nenhum");
    updateActionButtons();
  } catch (_) {
    PromoState.snapshot.checking = false;
  }
}

// ─── Origem (badge) ─────────────────────────────────────────────────────────
function origemBadge(l) {
  if (l.criadaPorMim === true) return `<span class="vf-tag is-success" title="${escapeHTML(txt(l.origemPromocao))}">Criada por mim</span>`;
  if (l.criadaPorMim === false) return `<span class="vf-tag is-info" title="${escapeHTML(txt(l.origemPromocao))}">Mercado Livre</span>`;
  return `<span class="vf-tag is-neutral" title="${escapeHTML(txt(l.origemPromocao))}">Não identificada</span>`;
}

function badgeDecisao(decisao) {
  const cfg = DECISAO_INFO[decisao] || { label: txt(decisao), tone: "neutral" };
  return `<span class="vf-tag is-${cfg.tone}">${escapeHTML(cfg.label)}</span>`;
}

// ─── Campanhas dinâmicas ────────────────────────────────────────────────────
function getPromoCampanhaLabel(l) {
  return txt(l?.campanha || l?.promotionId || l?.offerRefId);
}
function getPromoCampanhaKey(l) {
  return String(getPromoCampanhaLabel(l) || "—").trim() || "—";
}
function getCampanhasDisponiveis() {
  const map = new Map();
  PromoState.data.rows.forEach((l) => {
    if (!matchOrigem(l, PromoState.table.origin)) return;
    const key = getPromoCampanhaKey(l);
    map.set(key, (map.get(key) || 0) + 1);
  });
  return Array.from(map.entries())
    .map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR", { sensitivity: "base" }));
}

// ─── Filtro combinado (busca + origem + campanha + decisão) ────────────────
function textoDaLinha(l) {
  return [l.itemId, l.sku, l.titulo, l.campanha].filter(Boolean).join(" ").toLowerCase();
}

function linhasFiltradas() {
  const q = PromoState.table.search.trim().toLowerCase();
  return PromoState.data.rows.filter((l) =>
    matchOrigem(l, PromoState.table.origin) &&
    (PromoState.table.campaign === "todas" || getPromoCampanhaKey(l) === PromoState.table.campaign) &&
    matchDecision(l, PromoState.table.decision) &&
    (!q || textoDaLinha(l).includes(q))
  );
}

// Linhas respeitando busca + origem + campanha, mas SEM o filtro de decisão —
// usado para contar cada chip de decisão de forma independente.
function linhasParaContagemDecisao() {
  const q = PromoState.table.search.trim().toLowerCase();
  return PromoState.data.rows.filter((l) =>
    matchOrigem(l, PromoState.table.origin) &&
    (PromoState.table.campaign === "todas" || getPromoCampanhaKey(l) === PromoState.table.campaign) &&
    (!q || textoDaLinha(l).includes(q))
  );
}

// ─── Resumo executivo (calculado a partir das linhas — sem refazer fórmula) ─
function computeSummary(rows) {
  const porGrupo = (chaves) => rows.filter((r) => chaves.includes(r.decisao)).length;
  return {
    total: rows.length,
    comRetorno: rows.filter((r) => r.temRetornoMl).length,
    semRetorno: rows.filter((r) => !r.temRetornoMl).length,
    entrarSeguro: porGrupo(["entrar_seguro"]),
    entrarComTolerancia: porGrupo(["entrar_com_tolerancia"]),
    naoRecomendadas: porGrupo(["baixo_mesmo_com_rebate", "nao_entrar"]),
    semDados: porGrupo(["sem_relatorio", "dados_incompletos"]),
    criadasPorMim: rows.filter((r) => r.criadaPorMim === true).length,
    origemNaoIdentificada: rows.filter((r) => r.criadaPorMim !== true && r.criadaPorMim !== false).length,
    retornoMlTotal: sum(rows, (r) => r.retornoMl),
    lucroEstimado: sum(rows, (r) => (r.lcComRetorno ?? r.lcComRebate)),
    mcMedia: avg(rows.map((r) => r.mcComRetorno ?? r.mcComRebate)),
  };
}

function renderKpis() {
  const grid = document.getElementById("promo-kpis");
  const secGrid = document.getElementById("promo-kpis-secondary");
  if (!grid) return;
  const s = computeSummary(PromoState.data.rows);

  const kpi = (key, label, value, tone = "") => {
    const active = key === "todos"
      ? (PromoState.table.decision === "todos" && PromoState.table.origin === "todas")
      : (key === "com_retorno_ml" ? PromoState.table.origin === "com_retorno_ml" : PromoState.table.decision === key);
    return `
      <button type="button" class="vf-kpi vf-kpi--interactive${tone ? " vf-kpi--" + tone : ""}${active ? " is-active" : ""}" data-kpi="${key}" aria-pressed="${active}">
        <span class="vf-kpi__label">${escapeHTML(label)}</span>
        <span class="vf-kpi__value">${value}</span>
      </button>`;
  };

  grid.innerHTML = [
    kpi("todos", "Promoções encontradas", s.total),
    kpi("com_retorno_ml", "Com retorno ML", s.comRetorno),
    kpi("entrar_seguro", "Entrar seguro", s.entrarSeguro),
    kpi("entrar_com_tolerancia", "Em tolerância", s.entrarComTolerancia),
    kpi("nao_recomendadas", "Não recomendadas", s.naoRecomendadas, "warning"),
    kpi("sem_dados", "Sem dados suficientes", s.semDados),
  ].join("");

  const item = (label, value) => `
    <span class="vf-promo-kpis-secondary__item">
      <span class="vf-promo-kpis-secondary__label">${escapeHTML(label)}</span>
      <span class="vf-promo-kpis-secondary__value">${value}</span>
    </span>`;

  const itensScaneados = PromoState.data.meta?.itensScaneados;
  secGrid.innerHTML = [
    item("Criadas pelo seller", String(s.criadasPorMim)),
    item("Sem retorno ML", String(s.semRetorno)),
    item("Origem não identificada", String(s.origemNaoIdentificada)),
    item("Anúncios varridos", Number.isFinite(Number(itensScaneados)) ? String(itensScaneados) : "—"),
    item("Retorno ML total", brl(s.retornoMlTotal)),
    item("Lucro estimado", brl(s.lucroEstimado)),
    item("MC média", s.mcMedia != null ? pctFrac(s.mcMedia) : "—"),
  ].join("");

  grid.querySelectorAll("[data-kpi]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-kpi");
      if (key === "todos") {
        PromoState.table.decision = "todos";
        PromoState.table.origin = "todas";
        PromoState.table.campaign = "todas";
      } else if (key === "com_retorno_ml") {
        PromoState.table.origin = PromoState.table.origin === "com_retorno_ml" ? "todas" : "com_retorno_ml";
      } else {
        PromoState.table.decision = PromoState.table.decision === key ? "todos" : key;
      }
      renderAll();
    });
  });
}

// ─── Chips rápidos de decisão + filtros ativos removíveis ──────────────────
function renderQuickChips() {
  const box = document.getElementById("promo-quickchips");
  if (!box) return;
  const base = linhasParaContagemDecisao();
  box.innerHTML = PROMO_QUICKCHIPS.map((key) => {
    const count = key === "todos" ? base.length : base.filter((l) => matchDecision(l, key)).length;
    const active = PromoState.table.decision === key;
    return `<button type="button" class="vf-tag${active ? " is-primary" : " is-neutral"}" data-chip="${key}" aria-pressed="${active}">${escapeHTML(DECISION_FILTER_LABELS[key])} (${count})</button>`;
  }).join("");
  box.querySelectorAll("[data-chip]").forEach((btn) => {
    btn.addEventListener("click", () => {
      PromoState.table.decision = btn.getAttribute("data-chip") || "todos";
      renderAll();
    });
  });
}

function renderActiveFilters() {
  const box = document.getElementById("promo-activefilters");
  if (!box) return;
  const tags = [];
  if (PromoState.table.search.trim()) {
    tags.push({ label: `Busca: "${PromoState.table.search.trim()}"`, clear: () => { PromoState.table.search = ""; const i = document.getElementById("promo-table-search"); if (i) i.value = ""; } });
  }
  if (PromoState.table.origin !== "todas") {
    const info = ORIGEM_FILTERS.find((o) => o.key === PromoState.table.origin);
    tags.push({ label: `Origem: ${info?.label || PromoState.table.origin}`, clear: () => { PromoState.table.origin = "todas"; } });
  }
  if (PromoState.table.campaign !== "todas") {
    tags.push({ label: `Campanha: ${PromoState.table.campaign}`, clear: () => { PromoState.table.campaign = "todas"; } });
  }
  if (PromoState.table.decision !== "todos") {
    tags.push({ label: `Decisão: ${DECISION_FILTER_LABELS[PromoState.table.decision] || PromoState.table.decision}`, clear: () => { PromoState.table.decision = "todos"; } });
  }

  if (!tags.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = tags.map((t, i) => `<span class="vf-tag is-neutral" data-clear="${i}">${escapeHTML(t.label)} ✕</span>`).join("");
  box.querySelectorAll("[data-clear]").forEach((el) => {
    el.addEventListener("click", () => {
      const i = Number(el.getAttribute("data-clear"));
      tags[i]?.clear();
      renderAll();
    });
  });
}

// ─── Menu de filtros (origem + campanha) ───────────────────────────────────
function renderFiltersMenu() {
  const menu = document.getElementById("promo-filters-menu");
  if (!menu) return;
  const campanhas = getCampanhasDisponiveis();
  const campanhaOptions = [
    `<option value="todas">Todas as campanhas</option>`,
    ...campanhas.map((c) => `<option value="${escapeHTML(c.key)}"${c.key === PromoState.table.campaign ? " selected" : ""}>${escapeHTML(c.label)} (${c.count})</option>`),
  ].join("");
  const origemOptions = ORIGEM_FILTERS.map((o) => `<option value="${o.key}"${o.key === PromoState.table.origin ? " selected" : ""}>${escapeHTML(o.label)}</option>`).join("");

  menu.innerHTML = `
    <div class="vf-menu__label">Origem</div>
    <div class="vf-promo-menu-field">
      <select id="promo-filter-origem" class="vf-select vf-select--sm">${origemOptions}</select>
    </div>
    <div class="vf-menu__separator"></div>
    <div class="vf-menu__label">Campanha</div>
    <div class="vf-promo-menu-field">
      <select id="promo-filter-campanha" class="vf-select vf-select--sm">${campanhaOptions}</select>
    </div>
  `;

  menu.querySelector("#promo-filter-origem")?.addEventListener("change", (e) => {
    PromoState.table.origin = e.target.value || "todas";
    PromoState.table.campaign = "todas";
    renderAll();
  });
  menu.querySelector("#promo-filter-campanha")?.addEventListener("change", (e) => {
    PromoState.table.campaign = e.target.value || "todas";
    renderAll();
  });
}

// ─── Menu de colunas ────────────────────────────────────────────────────────
function renderColumnsMenu() {
  const menu = document.getElementById("promo-columns-menu");
  if (!menu) return;
  const set = new Set(PromoState.table.columns);
  const opcoes = PROMO_COLUMNS.filter((c) => !c.required);
  menu.innerHTML = `<div class="vf-menu__label">Colunas visíveis</div>` + opcoes.map((c) => `
    <label class="vf-check vf-promo-columns-menu__item">
      <input type="checkbox" data-coluna="${escapeHTML(c.key)}" ${set.has(c.key) ? "checked" : ""}>
      <span>${escapeHTML(c.label)}</span>
    </label>`).join("");

  menu.querySelectorAll("[data-coluna]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.getAttribute("data-coluna");
      const s = new Set(PromoState.table.columns);
      if (input.checked) s.add(key); else s.delete(key);
      PromoState.table.columns = PROMO_COLUMNS.map((c) => c.key).filter((k) => s.has(k));
      salvarColunasVisiveis();
      renderTable();
    });
  });
}

// ─── Tabela ─────────────────────────────────────────────────────────────────
function numCell(value, { money = false, frac = false, raw = false, points = false, signColor = false } = {}) {
  let formatted;
  if (money) formatted = brl(value);
  else if (frac) formatted = pctFrac(value);
  else if (raw) formatted = pctRaw(value);
  else if (points) formatted = pp(value);
  else formatted = Number.isFinite(Number(value)) ? NUM2.format(Number(value)) : "—";

  let cls = "num vf-mono";
  if (signColor && Number.isFinite(Number(value))) cls += Number(value) < 0 ? " vf-promo-neg" : " vf-promo-pos";
  return `<td class="${cls}">${formatted}</td>`;
}

function getMlPromosUrl(itemId) {
  const raw = String(itemId || "").trim();
  const numericId = raw.replace(/^MLB/i, "").replace(/\D/g, "");
  if (!numericId) return null;
  return `https://www.mercadolivre.com.br/anuncios/lista/promos?page=1&search=${encodeURIComponent(numericId)}`;
}

function abrirGerenciarNoMl(itemId) {
  const url = getMlPromosUrl(itemId);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

const COLUMN_RENDERERS = {
  mlbsku: (l) => `<td class="vf-mono"><div class="vf-promo-mlbsku"><span>${escapeHTML(txt(l.itemId))}</span>${l.sku ? `<span class="vf-promo-mlbsku__sku">${escapeHTML(l.sku)}</span>` : ""}</div></td>`,
  titulo: (l) => `<td class="vf-promo-titulo">${escapeHTML(txt(l.titulo))}</td>`,
  campanha: (l) => `<td class="vf-promo-campanha">${escapeHTML(txt(l.campanha))}</td>`,
  origem: (l) => `<td>${origemBadge(l)}</td>`,
  precoOriginal: (l) => numCell(l.precoOriginal, { money: true }),
  precoPromocao: (l) => numCell(l.precoPromocao, { money: true }),
  retornoMl: (l) => numCell(l.retornoMl, { money: true }),
  mcComRetorno: (l) => numCell(l.mcComRetorno ?? l.mcComRebate, { frac: true, signColor: true }),
  diferencaPp: (l) => numCell(l.diferencaPp, { points: true, signColor: true }),
  decisao: (l) => `<td>${badgeDecisao(l.decisao)}</td>`,
  descontoTotal: (l) => numCell(l.descontoTotal, { money: true }),
  sellerPercentage: (l) => numCell(l.sellerPercentage, { raw: true }),
  meliPercentage: (l) => numCell(l.meliPercentage, { raw: true }),
  comissaoPercentual: (l) => numCell(l.comissaoPercentual, { raw: true }),
  comissaoValor: (l) => numCell(l.comissaoValor, { money: true }),
  frete: (l) => numCell(l.frete, { money: true }),
  custo: (l) => numCell(l.custo, { money: true }),
  impostoPercentual: (l) => numCell(l.impostoPercentual, { raw: true }),
  lcComRetorno: (l) => numCell(l.lcComRetorno ?? l.lcComRebate, { money: true, signColor: true }),
  margemAlvo: (l) => numCell(l.margemAlvo, { frac: true }),
  motivo: (l) => `<td class="vf-promo-motivo">${escapeHTML(txt(l.motivo))}</td>`,
  acoes: (l) => `<td>
      <div class="vf-promo-row-actions">
        <button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-act="calc" title="Ver cálculo">Cálculo</button>
        <button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-act="copy" title="Copiar MLB">Copiar</button>
        ${getMlPromosUrl(l.itemId)
          ? `<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-act="ml" title="Gerenciar promoção no Mercado Livre">Gerenciar no ML</button>`
          : `<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" disabled title="MLB inválido">MLB inválido</button>`}
      </div>
    </td>`,
};

function renderTableHead() {
  const thead = document.getElementById("promo-thead");
  if (!thead) return;
  const cols = colunasVisiveis();
  thead.innerHTML = `<tr>${cols.map((c) => `<th${c.num ? ' class="num"' : ""}>${escapeHTML(c.label)}</th>`).join("")}</tr>`;
}

function preencherTbody(tbody, rows, cols) {
  tbody.innerHTML = "";
  rows.forEach((l) => {
    const tr = document.createElement("tr");
    tr.innerHTML = cols.map((c) => (COLUMN_RENDERERS[c.key] ? COLUMN_RENDERERS[c.key](l) : "<td>—</td>")).join("");
    tr.querySelector('[data-act="calc"]')?.addEventListener("click", () => abrirDrawerCalculo(l));
    tr.querySelector('[data-act="copy"]')?.addEventListener("click", (e) => copiarMlb(l.itemId, e.currentTarget));
    tr.querySelector('[data-act="ml"]')?.addEventListener("click", () => abrirGerenciarNoMl(l.itemId));
    tbody.appendChild(tr);
  });
}

function renderTable() {
  const empty = document.getElementById("promo-tabela-empty");
  const wrapper = document.getElementById("promo-tabela-wrapper");
  const aviso = document.getElementById("promo-aviso-limite");
  const countEl = document.getElementById("promo-count");
  const tbody = document.getElementById("promo-tbody");
  if (!tbody) return;

  renderTableHead();
  const cols = colunasVisiveis();
  const all = linhasFiltradas();
  const rows = all.slice(0, PROMO_RENDER_LIMIT);

  if (countEl) countEl.textContent = `${rows.length} de ${PromoState.data.rows.length}`;

  if (!all.length) {
    if (empty) empty.hidden = false;
    if (wrapper) wrapper.hidden = true;
    if (aviso) aviso.hidden = true;
    tbody.innerHTML = "";
    return;
  }

  if (empty) empty.hidden = true;
  if (wrapper) wrapper.hidden = false;

  if (aviso) {
    if (all.length > PROMO_RENDER_LIMIT) {
      aviso.hidden = false;
      aviso.innerHTML = `<div class="vf-banner__content"><p class="vf-banner__description">Mostrando ${PROMO_RENDER_LIMIT} de ${all.length} itens. Refine os filtros para ver menos itens.</p></div>`;
    } else {
      aviso.hidden = true;
    }
  }

  preencherTbody(tbody, rows, cols);
}

// Se a origem selecionada mudou e a campanha atual não existe mais nesse
// recorte, volta para "todas" (evita filtrar silenciosamente para zero linhas).
function sanitizeCampaignFilter() {
  if (PromoState.table.campaign === "todas") return;
  const existe = getCampanhasDisponiveis().some((c) => c.key === PromoState.table.campaign);
  if (!existe) PromoState.table.campaign = "todas";
}

function renderAll() {
  document.getElementById("promo-resumo-section").hidden = !PromoState.data.rows.length;
  document.getElementById("promo-workspace").hidden = !PromoState.data.rows.length;
  document.getElementById("promo-empty-inicial").hidden = !!PromoState.data.rows.length;
  if (!PromoState.data.rows.length) return;
  sanitizeCampaignFilter();
  renderKpis();
  renderQuickChips();
  renderActiveFilters();
  renderFiltersMenu();
  renderTable();
}

// ─── Copiar MLB ─────────────────────────────────────────────────────────────
function copiarMlb(mlb, btn) {
  const valor = String(mlb || "").trim();
  if (!valor || valor === "—") return;
  const ok = () => {
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = "Copiado!";
    setTimeout(() => { btn.textContent = original; }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(valor).then(ok).catch(() => fallbackCopy(valor, ok));
  } else {
    fallbackCopy(valor, ok);
  }
}
function fallbackCopy(valor, onOk) {
  try {
    const ta = document.createElement("textarea");
    ta.value = valor;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    if (onOk) onOk();
  } catch (_) { /* silencioso */ }
}

// ─── Estado dos dados (databar) ─────────────────────────────────────────────
function renderDatabar({ tone, statusText, metaText, progressPct = null } = {}) {
  const card = document.getElementById("promo-databar-card");
  const statusEl = document.getElementById("promo-databar-status");
  const metaEl = document.getElementById("promo-databar-meta");
  const progWrap = document.getElementById("promo-databar-progress");
  const progBar = document.getElementById("promo-databar-progress-bar");
  if (!card) return;
  if (!statusText) { card.hidden = true; return; }
  card.hidden = false;
  if (statusEl) { statusEl.className = `vf-status${tone ? " is-" + tone : ""}`; statusEl.textContent = statusText; }
  if (metaEl) metaEl.textContent = metaText || "";
  if (progWrap) {
    if (progressPct == null) { progWrap.hidden = true; }
    else { progWrap.hidden = false; if (progBar) progBar.style.width = `${Math.max(0, Math.min(100, progressPct))}%`; }
  }
}

function renderDatabarParaMeta() {
  const meta = PromoState.data.meta || {};
  const origem = PromoState.data.origem;

  if (origem === "quick") {
    renderDatabar({
      tone: "success",
      statusText: "Consulta rápida — gerado agora",
      metaText: `Página ${meta.page ?? "—"} de ${meta.limit ? Math.ceil((meta.totalItensMl || 0) / meta.limit) : "—"} · ${meta.totalItensMl ?? "—"} anúncios ativos na conta`,
    });
    return;
  }

  if (origem === "scan") {
    const parcial = meta.parcial ? ` · parcial (${meta.aviso || "varredura interrompida"})` : "";
    renderDatabar({
      tone: meta.parcial ? "warning" : "success",
      statusText: "Varredura recente — dados atuais",
      metaText: `Gerado em ${fmtDataHora(meta.geradoEm)} · seller ${meta.sellerId ?? "—"} · ${meta.itensScaneados ?? 0} anúncios varridos${parcial}`,
    });
    return;
  }

  if (origem === "snapshot") {
    const toneMap = { atual: "success", atencao: "warning", antigo: "danger" };
    const idade = fmtIdadeMinutos(meta.idadeMinutos);
    const frescorLabel = { atual: "atual", atencao: "com mais de 6h — considere atualizar", antigo: "antigo (mais de 24h) — recomendado atualizar" }[meta.frescor] || "";
    const parcial = meta.parcial ? ` · parcial (${meta.aviso || "varredura interrompida"})` : "";
    renderDatabar({
      tone: toneMap[meta.frescor] || "neutral",
      statusText: `Snapshot ${frescorLabel} (há ${idade})`,
      metaText: `Gerado em ${fmtDataHora(meta.geradoEm)} · seller ${meta.sellerId ?? "—"} · ${meta.itensScaneados ?? 0} anúncios varridos${parcial}`,
    });
    return;
  }

  renderDatabar({});
}

// ─── Consulta rápida ────────────────────────────────────────────────────────
function lerPercentInput(id) {
  const v = Number(document.getElementById(id)?.value);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

async function analisar() {
  if (!PromoState.clienteSlug || !PromoState.contexto.pronto) return;

  const margem = lerPercentInput("promo-margem");
  const tolerancia = lerPercentInput("promo-tolerancia");
  const limitRaw = Number(document.getElementById("promo-limit")?.value);
  const pageRaw = Number(document.getElementById("promo-page")?.value);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.trunc(limitRaw)), 50) : 20;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  const campanha = (document.getElementById("promo-campanha")?.value || "").trim();
  const apenasComRetorno = (document.getElementById("promo-escopo")?.value ?? "true") !== "false";

  const qs = new URLSearchParams();
  qs.set("clienteSlug", PromoState.clienteSlug);
  if (margem !== null) qs.set("margemAlvo", String(margem));
  if (tolerancia !== null) qs.set("tolerancia", String(tolerancia));
  qs.set("page", String(page));
  qs.set("limit", String(limit));
  if (campanha) qs.set("campanha", campanha);
  qs.set("apenasComRetorno", apenasComRetorno ? "true" : "false");

  const btn = document.getElementById("btn-promo-analisar");
  if (btn) { btn.disabled = true; btn.textContent = "Consultando…"; }
  setFeedback("Buscando promoções no Mercado Livre… isso pode levar alguns segundos.", "info");

  try {
    const res = await fetch(`${API_BASE}/automacoes/promocoes-retorno/preview?${qs.toString()}`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      setFeedback(data?.erro || `Erro ao consultar (HTTP ${res.status}).`, "danger");
      return;
    }

    PromoState.mode = "quick";
    PromoState.data = {
      rows: Array.isArray(data.linhas) ? data.linhas : [],
      meta: { page: data.page, limit: data.limit, totalItensMl: data.totalItensMl },
      origem: "quick",
    };
    PromoState.table.decision = "todos";
    PromoState.table.origin = "todas";
    PromoState.table.campaign = "todas";

    setFeedback("");
    renderDatabarParaMeta();
    renderAll();
  } catch (_) {
    setFeedback("Falha de rede ao consultar promoções. Tente novamente.", "danger");
  } finally {
    if (btn) { btn.disabled = !PromoState.contexto.pronto; btn.textContent = "Consultar página atual"; }
  }
}

// ─── Diagnóstico completo (varredura + snapshot) ───────────────────────────
function intervaloPolling() {
  const decorrido = Date.now() - PromoState.job.startedAt;
  return decorrido > PROMO_POLL_SLOW_AFTER_MS ? PROMO_POLL_SLOW_MS : PROMO_POLL_INTERVAL_MS;
}

async function iniciarDiagnosticoJob() {
  if (!PromoState.clienteSlug || !PromoState.contexto.pronto) return;
  const margem = lerPercentInput("promo-margem");
  const tolerancia = lerPercentInput("promo-tolerancia");
  const clienteSlug = PromoState.clienteSlug;

  pararPolling();
  setFeedback("Iniciando diagnóstico… varrendo as promoções da conta em segundo plano.", "info");
  renderDatabar({ tone: "info", statusText: "Iniciando diagnóstico…" });

  try {
    const res = await fetch(`${API_BASE}/automacoes/promocoes-retorno/diagnostico/start`, {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ clienteSlug, margemAlvo: margem, tolerancia }),
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    const data = await res.json().catch(() => ({}));

    if (res.status === 429 && data?.cooldown) {
      if (data.snapshot_id) PromoState.snapshot.exists = true;
      updateActionButtons();
      setStatusChip("promo-ctx-snapshot", "success", "Disponível");
      setFeedback(data.erro || "Conta varrida recentemente. Use o último snapshot.", "warning");
      renderDatabar({});
      return;
    }

    if (!res.ok || !data?.ok) {
      setFeedback(data?.erro || `Erro ao iniciar diagnóstico (HTTP ${res.status}).`, "danger");
      renderDatabar({});
      return;
    }

    if (PromoState.clienteSlug !== clienteSlug) return; // trocou de cliente enquanto aguardava

    PromoState.job.id = data.diagnostico_id;
    PromoState.job.startedAt = Date.now();
    updateActionButtons();
    if (data.jaEmAndamento) {
      setFeedback("Já havia um diagnóstico em andamento para este cliente — acompanhando o progresso…", "info");
    } else {
      setFeedback("Diagnóstico na fila de processamento…", "info");
    }
    renderDatabar({ tone: "info", statusText: "Aguardando na fila de diagnósticos…" });
    pollDiagnosticoStatus(clienteSlug);
  } catch (_) {
    setFeedback("Falha de rede ao iniciar diagnóstico. Tente novamente.", "danger");
    renderDatabar({});
  }
}

async function pollDiagnosticoStatus(clienteSlugNoInicio) {
  if (!PromoState.job.id) return;
  const jobId = PromoState.job.id;
  try {
    const res = await fetch(`${API_BASE}/automacoes/promocoes-retorno/diagnostico/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    const data = await res.json().catch(() => ({}));

    // Cliente trocado ou outro job assumiu enquanto a resposta chegava — ignora.
    if (PromoState.job.id !== jobId || PromoState.clienteSlug !== clienteSlugNoInicio) return;

    if (!res.ok || !data?.ok) {
      PromoState.job.id = null;
      updateActionButtons();
      setFeedback(data?.erro || `Erro ao consultar diagnóstico (HTTP ${res.status}).`, "danger");
      renderDatabar({});
      return;
    }

    const d = data.diagnostico || {};

    if (d.status === "aguardando") {
      const pos = Number(d.posicaoFila);
      const fila = Number.isFinite(pos) && pos > 0 ? ` (posição ${pos} na fila)` : "";
      setFeedback(`Aguardando na fila de diagnósticos${fila}… o servidor processa um por vez.`, "info");
      renderDatabar({ tone: "info", statusText: `Aguardando na fila${fila}…` });
      PromoState.job.timer = setTimeout(() => pollDiagnosticoStatus(clienteSlugNoInicio), intervaloPolling());
      return;
    }

    if (d.status === "processando") {
      const proc = Number(d.itensProcessados) || 0;
      const tot = Number(d.totalEstimado);
      const pct = Number.isFinite(tot) && tot > 0 ? Math.round((proc / tot) * 100) : null;
      const prog = Number.isFinite(tot) && tot > 0 ? `${proc}/${tot}` : `${proc}`;
      setFeedback(`Processando diagnóstico… ${prog} anúncios varridos.`, "info");
      renderDatabar({ tone: "info", statusText: "Processando diagnóstico…", metaText: `${prog} anúncios varridos`, progressPct: pct });
      PromoState.job.timer = setTimeout(() => pollDiagnosticoStatus(clienteSlugNoInicio), intervaloPolling());
      return;
    }

    // Estado terminal.
    PromoState.job.id = null;

    if (d.status === "erro") {
      updateActionButtons();
      setFeedback(`Diagnóstico falhou: ${d.aviso || "erro desconhecido"}.`, "danger");
      renderDatabar({});
      return;
    }

    PromoState.snapshot.exists = true;
    const ok = await carregarSnapshotComoResultado("scan");
    updateActionButtons();
    const parcial = d.parcial ? ` (parcial — ${d.aviso || ""})` : "";
    if (ok) {
      setFeedback(`Diagnóstico concluído${parcial}: ${d.totalPromocoes || 0} promoção(ões) em ${d.itensScaneados || 0} anúncios. Snapshot salvo.`, d.parcial ? "warning" : "success");
    } else {
      setFeedback(`Diagnóstico concluído${parcial}, mas não foi possível carregar o snapshot. Tente "Usar último snapshot".`, "danger");
    }
  } catch (_) {
    if (PromoState.job.id === jobId) PromoState.job.timer = setTimeout(() => pollDiagnosticoStatus(clienteSlugNoInicio), PROMO_POLL_SLOW_MS);
  }
}

async function carregarSnapshotComoResultado(origemLabel) {
  const clienteSlug = PromoState.clienteSlug;
  if (!clienteSlug) return false;
  const qs = new URLSearchParams({ clienteSlug });
  const res = await fetch(`${API_BASE}/automacoes/promocoes-retorno/snapshot?${qs.toString()}`, {
    headers: { Authorization: "Bearer " + TOKEN },
  });
  if (res.status === 401) { clearSession(); return false; }
  if (res.status === 403) { window.location.replace("dashboard.html"); return false; }
  const data = await res.json().catch(() => ({}));
  if (PromoState.clienteSlug !== clienteSlug) return false; // resposta obsoleta
  if (!res.ok || !data?.ok || !data.existe) return false;

  PromoState.mode = "diagnostico";
  PromoState.data = {
    rows: Array.isArray(data.linhas) ? data.linhas : [],
    meta: data.meta || {},
    origem: origemLabel || data.origem || "snapshot",
  };
  PromoState.snapshot.id = data.snapshot_id || null;
  PromoState.table.decision = "todos";
  PromoState.table.origin = "todas";
  PromoState.table.campaign = "todas";

  renderDatabarParaMeta();
  renderAll();
  return true;
}

async function carregarUltimoSnapshotPromocoes() {
  if (!PromoState.clienteSlug) { setFeedback("Selecione um cliente.", "danger"); return; }
  const btn = document.getElementById("btn-promo-snapshot-usar");
  const orig = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Carregando…"; }
  setFeedback("Carregando último snapshot salvo…", "info");

  try {
    const ok = await carregarSnapshotComoResultado("snapshot");
    if (!ok) {
      PromoState.snapshot.exists = false;
      updateActionButtons();
      setFeedback("Nenhum snapshot concluído para este cliente. Gere um diagnóstico primeiro.", "info");
      return;
    }
    PromoState.snapshot.exists = true;
    setStatusChip("promo-ctx-snapshot", "success", "Disponível");
    setFeedback(`Snapshot #${PromoState.snapshot.id} carregado (${PromoState.data.rows.length} promoções).`, "success");
  } catch (_) {
    setFeedback("Falha de rede ao carregar snapshot.", "danger");
  } finally {
    if (btn) btn.textContent = orig || "Usar último snapshot";
    updateActionButtons();
  }
}

// ─── Drawer: detalhe do cálculo ─────────────────────────────────────────────
function renderPromoWriteAction(row) {
  const el = document.getElementById("promo-write-action");
  if (!el) return;
  // Fronteira arquitetural: enquanto PROMO_WRITE_CAPABILITY.enabled === false,
  // nenhum botão de ação é exibido — canApplyPromotion() sempre retorna false.
  if (!canApplyPromotion(row)) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;
  el.innerHTML = `<button type="button" class="vf-btn vf-btn--primary" id="promo-write-btn">Aplicar promoção</button>`;
}

function abrirDrawerCalculo(l) {
  if (!l) return;
  const backdrop = document.getElementById("promo-calc-backdrop");
  const drawer = document.getElementById("promo-calc-drawer");
  const body = document.getElementById("promo-calc-body");
  if (!backdrop || !drawer || !body) return;

  const row = (label, value, strong = false, sep = false) =>
    (sep ? `<div class="vf-promo-calc__sep"></div>` : "") +
    `<dt${strong ? ' class="vf-promo-calc__strong"' : ""}>${escapeHTML(label)}</dt><dd${strong ? ' class="vf-promo-calc__strong"' : ""}>${value}</dd>`;

  const lcSemR = l.lcSemRebate != null ? l.lcSemRebate : l.lcSemRetorno;
  const mcSemR = l.mcSemRebate != null ? l.mcSemRebate : l.mcSemRetorno;
  const lcComR = l.lcComRebate != null ? l.lcComRebate : l.lcComRetorno;
  const mcComR = l.mcComRebate != null ? l.mcComRebate : l.mcComRetorno;

  const relId = l.relatorioId ?? l.debug?.relatorioId ?? null;
  const relData = l.relatorioCreatedAt ?? l.debug?.relatorioCreatedAt ?? null;
  const relDataFmt = relData ? fmtDataHora(relData) : "—";

  body.innerHTML = `
    <div class="vf-promo-calc">
      <section>
        <div class="vf-promo-calc__section-title">Identificação</div>
        <dl class="vf-promo-calc__grid">
          ${row("MLB", `<span class="vf-mono">${escapeHTML(txt(l.itemId))}</span>`)}
          ${row("SKU", `<span class="vf-mono">${escapeHTML(txt(l.sku))}</span>`)}
          ${row("Título", escapeHTML(txt(l.titulo)))}
          ${row("Campanha", escapeHTML(txt(l.campanha)))}
          ${row("Origem", escapeHTML(txt(l.origemPromocao)))}
        </dl>
      </section>

      <section>
        <div class="vf-promo-calc__section-title">Fonte financeira</div>
        <div class="vf-promo-calc__source">
          <strong>Relatório usado:</strong>
          ${relId ? `#${escapeHTML(String(relId))} · ${escapeHTML(relDataFmt)}` : "— nenhum relatório encontrado"}<br>
          <strong>Forma de match:</strong> ${escapeHTML(txt(l.debug?.snapshotMatchedBy))}<br>
          <strong>Fórmula (planilha):</strong> LC com retorno = preço − preço×imposto − preço×comissão − frete − taxa fixa − custo + retorno ML
        </div>
      </section>

      <section>
        <div class="vf-promo-calc__section-title">Formação do resultado</div>
        <dl class="vf-promo-calc__grid">
          ${row("Preço original", brl(l.precoOriginal))}
          ${row("Preço promocional", brl(l.precoPromocao), true, true)}
          ${row("Custo", brl(l.custo))}
          ${row("Frete", brl(l.frete))}
          ${row("Imposto %", pctRaw(l.impostoPercentual))}
          ${row("Imposto R$", brl(l.impostoValor))}
          ${row("Comissão %", pctRaw(l.comissaoPercentual))}
          ${row("Comissão R$", brl(l.comissaoValor))}
          ${row("Taxa fixa", brl(l.taxaFixa))}
          ${row("Retorno ML", brl(l.retornoMl))}
        </dl>
      </section>

      <section>
        <div class="vf-promo-calc__section-title">Resultado</div>
        <dl class="vf-promo-calc__grid">
          ${row("LC sem retorno", brl(lcSemR), true, true)}
          ${row("MC sem retorno", pctFrac(mcSemR))}
          ${row("LC com retorno", brl(lcComR), true, true)}
          ${row("MC com retorno", pctFrac(mcComR), true)}
          ${row("Margem alvo", pctFrac(l.margemAlvo), false, true)}
          ${row("Diferença vs. alvo", pp(l.diferencaPp))}
        </dl>
      </section>

      <section>
        <div class="vf-promo-calc__section-title">Decisão</div>
        <div class="vf-promo-calc__decision">
          ${badgeDecisao(l.decisao)}
          <span>${escapeHTML(txt(l.motivo))}</span>
        </div>
      </section>

      ${getMlPromosUrl(l.itemId)
        ? `<div class="vf-promo-calc__ml-action">
             <button type="button" id="promo-calc-ml-btn" class="vf-btn vf-btn--secondary">Gerenciar promoção no ML</button>
           </div>`
        : ""}
    </div>
  `;

  document.getElementById("promo-calc-ml-btn")?.addEventListener("click", () => abrirGerenciarNoMl(l.itemId));
  renderPromoWriteAction(l);

  PromoState.ui.drawerRow = l;
  PromoState.ui.lastFocusedEl = document.activeElement;
  backdrop.classList.add("is-open");
  drawer.classList.add("is-open");
  document.body.style.overflow = "hidden";
  drawer.focus();
}

function fecharDrawerCalculo() {
  const backdrop = document.getElementById("promo-calc-backdrop");
  const drawer = document.getElementById("promo-calc-drawer");
  if (backdrop) backdrop.classList.remove("is-open");
  if (drawer) drawer.classList.remove("is-open");
  document.body.style.overflow = "";
  PromoState.ui.drawerRow = null;
  if (PromoState.ui.lastFocusedEl && typeof PromoState.ui.lastFocusedEl.focus === "function") {
    PromoState.ui.lastFocusedEl.focus();
  }
}

// ─── Eventos ────────────────────────────────────────────────────────────────
document.getElementById("promo-cliente-search")?.addEventListener("input", applyClienteSearch);
document.getElementById("promo-cliente")?.addEventListener("change", onClienteChange);

document.getElementById("btn-promo-diagnostico")?.addEventListener("click", iniciarDiagnosticoJob);
document.getElementById("btn-promo-snapshot-usar")?.addEventListener("click", carregarUltimoSnapshotPromocoes);
document.getElementById("btn-promo-analisar")?.addEventListener("click", analisar);

document.getElementById("promo-quickopts-toggle")?.addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const body = document.getElementById("promo-quickopts-body");
  const open = body.hidden;
  body.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
});

document.getElementById("promo-quick-toggle")?.addEventListener("click", (e) => {
  const btn = e.currentTarget;
  const body = document.getElementById("promo-quick-body");
  const open = body.hidden;
  body.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
});

document.getElementById("promo-table-search")?.addEventListener("input", (e) => {
  PromoState.table.search = e.target.value || "";
  renderAll();
});

document.getElementById("promo-filters-btn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = document.getElementById("promo-filters-menu");
  const btn = e.currentTarget;
  document.getElementById("promo-columns-menu").hidden = true;
  menu.hidden = !menu.hidden;
  btn.setAttribute("aria-expanded", String(!menu.hidden));
});
document.getElementById("promo-columns-btn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = document.getElementById("promo-columns-menu");
  const btn = e.currentTarget;
  document.getElementById("promo-filters-menu").hidden = true;
  menu.hidden = !menu.hidden;
  btn.setAttribute("aria-expanded", String(!menu.hidden));
});
document.getElementById("promo-filters-menu")?.addEventListener("click", (e) => e.stopPropagation());
document.getElementById("promo-columns-menu")?.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", (e) => {
  const fMenu = document.getElementById("promo-filters-menu");
  const cMenu = document.getElementById("promo-columns-menu");
  if (fMenu && !fMenu.hidden && !e.target.closest("#promo-filters-btn")) { fMenu.hidden = true; document.getElementById("promo-filters-btn")?.setAttribute("aria-expanded", "false"); }
  if (cMenu && !cMenu.hidden && !e.target.closest("#promo-columns-btn")) { cMenu.hidden = true; document.getElementById("promo-columns-btn")?.setAttribute("aria-expanded", "false"); }
});

document.getElementById("promo-calc-close")?.addEventListener("click", fecharDrawerCalculo);
document.getElementById("promo-calc-close-footer")?.addEventListener("click", fecharDrawerCalculo);
document.getElementById("promo-calc-backdrop")?.addEventListener("click", fecharDrawerCalculo);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharDrawerCalculo(); });

// ─── Init ───────────────────────────────────────────────────────────────────
PromoState.table.columns = carregarColunasVisiveis();
renderColumnsMenu();
loadClientes();
