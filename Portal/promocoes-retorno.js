// Portal/promocoes-retorno.js
// Tela "Promoções ML" — somente leitura.
// Consome GET /automacoes/promocoes-retorno/preview e exibe a análise de
// promoções com retorno do Mercado Livre. Não altera nada no ML nem no banco.

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

// ─── Estado ───────────────────────────────────────────────────────────────
let ALL_CLIENTES = [];
let ALL_BASES = [];
let PROMO_ROWS = [];
let PROMO_FILTER = "todos";
let PROMO_CAMPANHA_FILTER = "todas";

// ─── Estado do diagnóstico / snapshot ───────────────────────────────────────
// "preview"    = fluxo antigo de análise paginada (botão Analisar).
// "diagnostico" = fluxo novo (varredura + snapshot), renderiza na mesma tabela.
let PROMO_MODE = "preview";
let PROMO_DIAGNOSTICO_ROWS = [];
let PROMO_DIAGNOSTICO_META = null;
let PROMO_SNAPSHOT_ID = null;
let PROMO_SNAPSHOT_EXISTE = false;
let PROMO_ORIGEM_FILTER = "todas";
let PROMO_SNAPSHOT_CHECK_KEY = "";
// Job assíncrono em andamento (polling).
let PROMO_JOB_ID = null;
let PROMO_POLL_TIMER = null;
const PROMO_POLL_INTERVAL = 2500;
const PROMO_RENDER_LIMIT = 50;

const PROMO_FILTERS = [
  { key: "todos", label: "Todos" },
  { key: "entrar_seguro", label: "Entrar seguro" },
  { key: "entrar_com_tolerancia", label: "Entrar com tolerância" },
  { key: "baixo_mesmo_com_rebate", label: "Baixo mesmo com rebate" },
  { key: "nao_entrar", label: "Não entrar" },
  { key: "sem_relatorio", label: "Sem relatório" },
  { key: "dados_incompletos", label: "Dados incompletos" },
];

// Filtro de origem (exclusivo do diagnóstico).
const PROMO_ORIGEM_FILTERS = [
  { key: "todas", label: "Todas as promoções" },
  { key: "criadas_por_mim", label: "Criadas por mim" },
  { key: "com_retorno_ml", label: "Com retorno ML" },
  { key: "sem_retorno_ml", label: "Sem retorno ML" },
];

const DECISAO_BADGE = {
  entrar_seguro:          { label: "Entrar seguro",          cls: "vf-mini-badge-success" },
  entrar_com_tolerancia:  { label: "Entrar com tolerância",  cls: "vf-mini-badge-tolerancia" },
  baixo_mesmo_com_rebate: { label: "Baixo mesmo com rebate", cls: "vf-mini-badge-warning" },
  nao_entrar:             { label: "Não entrar",             cls: "vf-mini-badge-danger" },
  sem_relatorio:          { label: "Sem relatório",          cls: "vf-mini-badge-neutral" },
  dados_incompletos:      { label: "Dados incompletos",      cls: "vf-mini-badge-neutral" },
};

// ─── Helpers ──────────────────────────────────────────────────────────────
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

function setStatus(msg, color) {
  const el = document.getElementById("promo-status");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = color || "var(--vf-text-m)";
  el.style.display = msg ? "block" : "none";
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const NUM2 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Moeda BRL, null/NaN → "—"
function brl(n) {
  const v = Number(n);
  return Number.isFinite(v) ? BRL.format(v) : "—";
}

// Fração decimal (0.114) → "11,4%". null/NaN → "—"
function pctFrac(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${NUM2.format(v * 100)}%` : "—";
}

// Percentual já em escala 0..100 (ex.: meli %, seller %). null/NaN → "—"
function pctRaw(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${NUM2.format(v)}%` : "—";
}

// Diferença em pontos percentuais: -0.015 → "-1,5 p.p." null/NaN → "—"
function pp(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${NUM2.format(v * 100)} p.p.` : "—";
}

// Texto puro com fallback "—"
function txt(s) {
  return (s === null || s === undefined || s === "") ? "—" : String(s);
}

// ─── Clientes / bases ─────────────────────────────────────────────────────
function setClientesOptions(select, clientes) {
  if (!select) return;
  select.innerHTML = "";
  select.appendChild(new Option("Selecione um cliente…", ""));
  (Array.isArray(clientes) ? clientes : []).forEach((c) => {
    const slug = c.slug || "";
    const nome = c.nome || slug || "—";
    select.appendChild(new Option(`${nome} (${slug})`, slug));
  });
}

function setBasesOptions(select, bases) {
  if (!select) return;
  select.innerHTML = "";
  select.appendChild(new Option("Selecione uma base…", ""));
  (Array.isArray(bases) ? bases : []).forEach((b) => {
    const slug = b.slug || "";
    const nome = b.nome || slug || "—";
    select.appendChild(new Option(`${nome} (${slug})`, slug));
  });
}

function applyClienteSearchFilter() {
  const input = document.getElementById("promo-cliente-search");
  const select = document.getElementById("promo-cliente");
  if (!select) return;
  const q = (input?.value || "").trim().toLowerCase();
  const filtered = !q ? ALL_CLIENTES : ALL_CLIENTES.filter((c) => {
    const nome = (c?.nome || "").toString().toLowerCase();
    const slug = (c?.slug || "").toString().toLowerCase();
    return nome.includes(q) || slug.includes(q);
  });
  const current = select.value || "";
  setClientesOptions(select, filtered);
  if (current && filtered.some((c) => (c?.slug || "") === current)) select.value = current;
}

function applyBaseSearchFilter() {
  const input = document.getElementById("promo-base-search");
  const select = document.getElementById("promo-base");
  if (!select) return;
  const q = (input?.value || "").trim().toLowerCase();
  const filtered = !q ? ALL_BASES : ALL_BASES.filter((b) => {
    const nome = (b?.nome || "").toString().toLowerCase();
    const slug = (b?.slug || "").toString().toLowerCase();
    return nome.includes(q) || slug.includes(q);
  });
  const current = select.value || "";
  setBasesOptions(select, filtered);
  if (current && filtered.some((b) => (b?.slug || "") === current)) select.value = current;
}

async function loadClientes() {
  if (!TOKEN) return;
  const select = document.getElementById("promo-cliente");
  if (select) { select.disabled = true; select.innerHTML = `<option value="">Carregando...</option>`; }
  try {
    const res = await fetch(`${API_BASE}/automacoes/clientes`, { headers: { Authorization: "Bearer " + TOKEN } });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    ALL_CLIENTES = Array.isArray(data.clientes) ? data.clientes : (Array.isArray(data) ? data : []);
    applyClienteSearchFilter();
    if (select) select.disabled = false;
    if (!ALL_CLIENTES.length) setStatus("Nenhum cliente encontrado.", "var(--vf-text-m)");
  } catch (_) {
    ALL_CLIENTES = [];
    if (select) { select.disabled = true; select.innerHTML = `<option value="">Erro ao carregar clientes</option>`; }
    setStatus("Não foi possível carregar os clientes.", "var(--vf-danger)");
  }
}

async function loadBases() {
  if (!TOKEN) return;
  const select = document.getElementById("promo-base");
  if (select) { select.disabled = true; select.innerHTML = `<option value="">Carregando...</option>`; }
  try {
    const res = await fetch(`${API_BASE}/bases`, { headers: { Authorization: "Bearer " + TOKEN } });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    ALL_BASES = Array.isArray(data.bases) ? data.bases : (Array.isArray(data) ? data : []);
    applyBaseSearchFilter();
    if (select) select.disabled = false;
  } catch (_) {
    ALL_BASES = [];
    if (select) { select.disabled = true; select.innerHTML = `<option value="">Erro ao carregar bases</option>`; }
    setStatus("Não foi possível carregar as bases.", "var(--vf-danger)");
  }
}

// ─── Análise ──────────────────────────────────────────────────────────────
function lerPercentInput(id) {
  const v = Number(document.getElementById(id)?.value);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

async function analisar() {
  const clienteSlug = document.getElementById("promo-cliente")?.value || "";
  const baseSlug = document.getElementById("promo-base")?.value || "";
  if (!clienteSlug) { setStatus("Selecione um cliente.", "var(--vf-danger)"); return; }
  if (!baseSlug) { setStatus("Selecione uma base.", "var(--vf-danger)"); return; }

  const margem = lerPercentInput("promo-margem");
  const tolerancia = lerPercentInput("promo-tolerancia");
  const limitRaw = Number(document.getElementById("promo-limit")?.value);
  const pageRaw = Number(document.getElementById("promo-page")?.value);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.trunc(limitRaw)), 50) : 20;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  const campanha = (document.getElementById("promo-campanha")?.value || "").trim();
  // "Apenas com retorno ML" (default) vs "Todas as promoções".
  const apenasComRetorno = (document.getElementById("promo-tipo")?.value ?? "true") !== "false";

  const qs = new URLSearchParams();
  qs.set("clienteSlug", clienteSlug);
  qs.set("baseSlug", baseSlug);
  if (margem !== null) qs.set("margemAlvo", String(margem));
  if (tolerancia !== null) qs.set("tolerancia", String(tolerancia));
  qs.set("page", String(page));
  qs.set("limit", String(limit));
  if (campanha) qs.set("campanha", campanha);
  qs.set("apenasComRetorno", apenasComRetorno ? "true" : "false");

  const btn = document.getElementById("btn-promo-analisar");
  if (btn) { btn.disabled = true; btn.textContent = "Analisando…"; }
  setStatus("Buscando promoções no Mercado Livre… isso pode levar alguns segundos.", "var(--vf-text-m)");

  try {
    const res = await fetch(`${API_BASE}/automacoes/promocoes-retorno/preview?${qs.toString()}`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      const msg = data?.erro || `Erro ao analisar (HTTP ${res.status}).`;
      setStatus(msg, "var(--vf-danger)");
      return;
    }

    PROMO_MODE = "preview";
    hideDiagnosticoUI();
    PROMO_ROWS = Array.isArray(data.linhas) ? data.linhas : [];
    PROMO_FILTER = "todos";
    PROMO_CAMPANHA_FILTER = "todas";
    renderResumo(data);
    renderFiltros();
    renderTabela();

    const clienteLabel = data?.cliente?.nome || clienteSlug;
    const baseLabel = data?.base?.nome || baseSlug;
    setStatus(
      `${PROMO_ROWS.length} promoção(ões) encontrada(s) — ${clienteLabel} · ${baseLabel} · página ${data.page} · ${data.totalItensMl} anúncios ativos.`,
      "var(--vf-text-m)"
    );
  } catch (_) {
    setStatus("Falha de rede ao analisar promoções. Tente novamente.", "var(--vf-danger)");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Analisar promoções disponíveis"; }
  }
}

// ─── Render: resumo ───────────────────────────────────────────────────────
function renderResumo(data) {
  const empty = document.getElementById("promo-resumo-empty");
  const bar = document.getElementById("promo-resumo-bar");
  const badge = document.getElementById("promo-total-ml");
  const r = data?.resumo || {};

  if (badge) { badge.style.display = "inline-block"; badge.textContent = String(data?.totalItensMl ?? 0); }
  if (empty) empty.style.display = "none";
  if (!bar) return;

  const pill = (label, value, cls = "") =>
    `<span class="vf-resumo-pill ${cls}">${escapeHTML(label)} <strong>${escapeHTML(value)}</strong></span>`;

  const n = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : "0");

  bar.innerHTML = [
    pill("Promoções encontradas", n(r.ofertasEncontradas)),
    pill("Ofertas com retorno ML", n(r.ofertasComRetornoMl), "vf-resumo-success"),
    pill("Ofertas encontradas (total)", n(r.ofertasEncontradasTotal)),
    pill("Produtos com relatório", n(r.produtosComSnapshot), "vf-resumo-success"),
    pill("Entrar seguro", n(r.entrarSeguro), "vf-resumo-success"),
    pill("Entrar com tolerância", n(r.entrarComTolerancia), "vf-resumo-success"),
    pill("Baixo mesmo com rebate", n(r.baixoMesmoComRebate), "vf-resumo-warning"),
    pill("Não entrar", n(r.naoEntrar), "vf-resumo-danger"),
    pill("Sem relatório", n(r.semRelatorio)),
    pill("Dados incompletos", n(r.dadosIncompletos)),
    pill("Retorno ML total", brl(r.retornoMlTotal)),
    pill("Lucro total estimado", brl(r.lucroTotalEstimado),
      Number(r.lucroTotalEstimado) < 0 ? "vf-resumo-danger" : "vf-resumo-success"),
    pill("MC média em promoção", pctFrac(r.mcMediaPromocao)),
  ].join("");
  bar.style.display = "flex";

  const nota = document.getElementById("promo-resumo-nota");
  if (nota) {
    if (r.filtroApenasComRetorno) {
      nota.textContent = "Exibindo apenas promoções com retorno ML.";
      nota.style.display = "block";
    } else {
      nota.style.display = "none";
    }
  }
}

// ─── Render: filtros rápidos ──────────────────────────────────────────────
function getPromoCampanhaLabel(linha) {
  return txt(
    linha?.campanha ||
    linha?.campaignName ||
    linha?.nomeCampanha ||
    linha?.promotionName ||
    linha?.promocao ||
    linha?.promotionId ||
    linha?.campaignId ||
    linha?.offerId
  );
}

function getPromoCampanhaKey(linha) {
  const label = String(getPromoCampanhaLabel(linha) || "—").trim();
  return label || "—";
}

function getPromoCampanhasDisponiveis() {
  const map = new Map();

  (Array.isArray(PROMO_ROWS) ? PROMO_ROWS : []).forEach((linha) => {
    const key = getPromoCampanhaKey(linha);
    map.set(key, (map.get(key) || 0) + 1);
  });

  return Array.from(map.entries())
    .map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR", { sensitivity: "base" }));
}

function contarPorDecisao(key) {
  let rows = Array.isArray(PROMO_ROWS) ? PROMO_ROWS : [];

  if (PROMO_CAMPANHA_FILTER !== "todas") {
    rows = rows.filter((linha) => getPromoCampanhaKey(linha) === PROMO_CAMPANHA_FILTER);
  }

  if (key === "todos") return rows.length;
  return rows.filter((linha) => linha.decisao === key).length;
}

function renderFiltros() {
  const box = document.getElementById("promo-filtros");
  if (!box) return;

  if (!Array.isArray(PROMO_ROWS) || !PROMO_ROWS.length) {
    PROMO_CAMPANHA_FILTER = "todas";
    box.innerHTML = "";
    box.style.display = "none";
    return;
  }

  const campanhas = getPromoCampanhasDisponiveis();
  const campanhaAindaExiste =
    PROMO_CAMPANHA_FILTER === "todas" ||
    campanhas.some((c) => c.key === PROMO_CAMPANHA_FILTER);

  if (!campanhaAindaExiste) PROMO_CAMPANHA_FILTER = "todas";

  const options = [
    `<option value="todas">Todas as promoções/campanhas (${PROMO_ROWS.length})</option>`,
    ...campanhas.map((c) => `
      <option value="${escapeHTML(c.key)}"${c.key === PROMO_CAMPANHA_FILTER ? " selected" : ""}>
        ${escapeHTML(c.label)} (${c.count})
      </option>
    `),
  ].join("");

  const decisionButtons = PROMO_FILTERS.map((f) => {
    const count = contarPorDecisao(f.key);
    const active = f.key === PROMO_FILTER ? " active" : "";
    return `<button type="button" class="vf-ml-filter-btn${active}" data-filter="${escapeHTML(f.key)}">${escapeHTML(f.label)} (${count})</button>`;
  }).join("");

  box.innerHTML = `
    <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;width:100%;margin-bottom:10px;">
      <div class="vf-form-group" style="margin:0;min-width:280px;max-width:460px;flex:1;">
        <label for="promo-campanha-dinamica">Filtrar por promoção/campanha encontrada</label>
        <select id="promo-campanha-dinamica" class="vf-input">
          ${options}
        </select>
        <small style="display:block;margin-top:6px;color:var(--vf-text-m);font-size:.75rem;line-height:1.4;">
          Esse filtro aparece depois da análise e mostra as promoções/campanhas retornadas na lista atual.
        </small>
      </div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;width:100%;">
      ${decisionButtons}
    </div>
  `;

  box.style.display = "flex";
  box.style.flexDirection = "column";
  box.style.alignItems = "stretch";

  document.getElementById("promo-campanha-dinamica")?.addEventListener("change", (event) => {
    PROMO_CAMPANHA_FILTER = event.target.value || "todas";
    PROMO_FILTER = "todos";
    renderFiltros();
    renderTabela();
  });

  box.querySelectorAll(".vf-ml-filter-btn").forEach((button) => {
    button.addEventListener("click", () => {
      PROMO_FILTER = button.getAttribute("data-filter") || "todos";
      renderFiltros();
      renderTabela();
    });
  });
}

// ─── Render: tabela ───────────────────────────────────────────────────────
function linhasFiltradas() {
  let rows = Array.isArray(PROMO_ROWS) ? PROMO_ROWS : [];

  if (PROMO_CAMPANHA_FILTER !== "todas") {
    rows = rows.filter((linha) => getPromoCampanhaKey(linha) === PROMO_CAMPANHA_FILTER);
  }

  if (PROMO_FILTER !== "todos") {
    rows = rows.filter((linha) => linha.decisao === PROMO_FILTER);
  }

  return rows;
}

function badgeDecisao(decisao) {
  const cfg = DECISAO_BADGE[decisao] || { label: txt(decisao), cls: "vf-mini-badge-neutral" };
  return `<span class="vf-mini-badge ${cfg.cls}">${escapeHTML(cfg.label)}</span>`;
}

function numCell(value, { money = false, frac = false, raw = false, points = false, signColor = false } = {}) {
  let formatted;
  if (money) formatted = brl(value);
  else if (frac) formatted = pctFrac(value);
  else if (raw) formatted = pctRaw(value);
  else if (points) formatted = pp(value);
  else formatted = Number.isFinite(Number(value)) ? NUM2.format(Number(value)) : "—";

  let cls = "vf-promo-num";
  if (signColor && Number.isFinite(Number(value))) {
    cls += Number(value) < 0 ? " vf-promo-neg" : " vf-promo-pos";
  }
  return `<td class="${cls}">${formatted}</td>`;
}

// Página oficial de promoções do ML, filtrada pelo número do anúncio (sem prefixo MLB).
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

// Monta o innerHTML de uma <tr> da tabela de promoções. Compartilhado entre o
// fluxo de análise paginada e o de diagnóstico (mesmas colunas).
function promoRowInnerHtml(l) {
  return [
    `<td style="font-family:var(--vf-mono);font-size:.78rem;">${escapeHTML(txt(l.itemId))}</td>`,
    `<td class="vf-promo-titulo">${escapeHTML(txt(l.titulo))}</td>`,
    `<td>${escapeHTML(txt(l.campanha))}${l.origemPromocao ? `<br><small style="color:var(--vf-text-m);">${escapeHTML(l.origemPromocao)}</small>` : ""}</td>`,
    numCell(l.precoOriginal, { money: true }),
    numCell(l.precoPromocao, { money: true }),
    numCell(l.descontoTotal, { money: true }),
    numCell(l.sellerPercentage, { raw: true }),
    numCell(l.meliPercentage, { raw: true }),
    numCell(l.retornoMl, { money: true }),
    numCell(l.comissaoPercentual, { raw: true }),
    numCell(l.comissaoValor, { money: true }),
    numCell(l.frete, { money: true }),
    numCell(l.custo, { money: true }),
    numCell(l.impostoPercentual, { raw: true }),
    numCell(l.lcComRetorno, { money: true, signColor: true }),
    numCell(l.mcComRetorno, { frac: true, signColor: true }),
    numCell(l.margemAlvo, { frac: true }),
    numCell(l.diferencaPp, { points: true, signColor: true }),
    `<td>${badgeDecisao(l.decisao)}</td>`,
    `<td class="vf-promo-motivo">${escapeHTML(txt(l.motivo))}</td>`,
    `<td>
      <div class="vf-promo-actions">
        <button type="button" class="vf-action-btn" data-act="calc" title="Ver cálculo">Cálculo</button>
        <button type="button" class="vf-action-btn vf-action-btn-secondary" data-act="copy" title="Copiar MLB">Copiar</button>
        ${getMlPromosUrl(l.itemId)
          ? `<button type="button" class="vf-action-btn vf-action-btn-neutral" data-act="ml" title="Gerenciar promoção no Mercado Livre">Gerenciar no ML</button>`
          : `<button type="button" class="vf-action-btn vf-action-btn-neutral" disabled title="MLB inválido">MLB inválido</button>`}
      </div>
    </td>`,
  ].join("");
}

// Preenche o tbody com as linhas fornecidas e liga os handlers por linha
// (o modal recebe o objeto da linha diretamente, sem depender de índice global).
function preencherTbody(tbody, rows) {
  tbody.innerHTML = "";
  rows.forEach((l) => {
    const tr = document.createElement("tr");
    tr.innerHTML = promoRowInnerHtml(l);
    tr.querySelector('[data-act="calc"]')?.addEventListener("click", () => abrirModalCalculo(l));
    tr.querySelector('[data-act="copy"]')?.addEventListener("click", (e) => copiarMlb(l.itemId, e.currentTarget));
    tr.querySelector('[data-act="ml"]')?.addEventListener("click", () => abrirGerenciarNoMl(l.itemId));
    tbody.appendChild(tr);
  });
}

function renderTabela() {
  const empty = document.getElementById("promo-tabela-empty");
  const wrapper = document.getElementById("promo-tabela-wrapper");
  const badge = document.getElementById("promo-tabela-total");
  const tbody = document.getElementById("promo-tbody");
  if (!tbody) return;

  const rows = linhasFiltradas();

  if (badge) { badge.style.display = "inline-block"; badge.textContent = String(rows.length); }

  if (!PROMO_ROWS.length) {
    if (empty) { empty.style.display = "block"; empty.querySelector("p").textContent = "Nenhuma promoção encontrada para esta análise."; }
    if (wrapper) wrapper.style.display = "none";
    tbody.innerHTML = "";
    return;
  }

  if (empty) empty.style.display = "none";
  if (wrapper) wrapper.style.display = "block";

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="21" style="color:var(--vf-text-m);text-align:center;padding:1rem;">Nenhuma linha neste filtro.</td></tr>`;
    return;
  }

  preencherTbody(tbody, rows);
}

// ─── Diagnóstico de promoções (varredura + snapshot) ────────────────────────
function hideDiagnosticoUI() {
  const info = document.getElementById("promo-diagnostico-info");
  const aviso = document.getElementById("promo-diagnostico-aviso");
  if (info) info.style.display = "none";
  if (aviso) aviso.style.display = "none";
}

function diagQsBase() {
  return {
    clienteSlug: document.getElementById("promo-cliente")?.value || "",
    baseSlug: document.getElementById("promo-base")?.value || "",
  };
}

function setBtnDisabled(id, disabled) {
  const b = document.getElementById(id);
  if (b) b.disabled = !!disabled;
}

function updateSnapshotButtons() {
  const { clienteSlug, baseSlug } = diagQsBase();
  const both = !!clienteSlug && !!baseSlug;
  const busy = !!PROMO_JOB_ID; // job de varredura em andamento
  setBtnDisabled("btn-promo-diagnostico", busy);
  setBtnDisabled("btn-promo-snapshot-atualizar", busy || !both);
  setBtnDisabled("btn-promo-snapshot-usar", busy || !PROMO_SNAPSHOT_EXISTE);
}

// Predicados de filtro do diagnóstico.
function matchOrigem(l, key) {
  if (key === "todas") return true;
  const comRetorno = l.temRetornoMl || Number(l.meliPercentage) > 0;
  if (key === "criadas_por_mim") return l.criadaPorMim === true;
  if (key === "com_retorno_ml") return comRetorno;
  if (key === "sem_retorno_ml") return !comRetorno;
  return true;
}

function matchCampanha(l, key) {
  return key === "todas" || getPromoCampanhaKey(l) === key;
}

function linhasDiagnosticoFiltradas() {
  return (Array.isArray(PROMO_DIAGNOSTICO_ROWS) ? PROMO_DIAGNOSTICO_ROWS : []).filter(
    (l) =>
      matchOrigem(l, PROMO_ORIGEM_FILTER) &&
      matchCampanha(l, PROMO_CAMPANHA_FILTER) &&
      (PROMO_FILTER === "todos" || l.decisao === PROMO_FILTER)
  );
}

// Campanhas presentes no diagnóstico (respeitando o filtro de origem atual).
function getCampanhasDoDiagnostico() {
  const map = new Map();
  (Array.isArray(PROMO_DIAGNOSTICO_ROWS) ? PROMO_DIAGNOSTICO_ROWS : [])
    .filter((l) => matchOrigem(l, PROMO_ORIGEM_FILTER))
    .forEach((l) => {
      const key = getPromoCampanhaKey(l);
      map.set(key, (map.get(key) || 0) + 1);
    });
  return Array.from(map.entries())
    .map(([key, count]) => ({ key, label: key, count }))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR", { sensitivity: "base" }));
}

function contarDiagnosticoPorDecisao(key) {
  const rows = (Array.isArray(PROMO_DIAGNOSTICO_ROWS) ? PROMO_DIAGNOSTICO_ROWS : []).filter(
    (l) => matchOrigem(l, PROMO_ORIGEM_FILTER) && matchCampanha(l, PROMO_CAMPANHA_FILTER)
  );
  if (key === "todos") return rows.length;
  return rows.filter((l) => l.decisao === key).length;
}

function renderDiagnosticoInfo() {
  const el = document.getElementById("promo-diagnostico-info");
  if (!el) return;
  if (PROMO_MODE !== "diagnostico" || !PROMO_DIAGNOSTICO_META) { el.style.display = "none"; return; }
  const m = PROMO_DIAGNOSTICO_META;
  const ehSnapshot = m.origem === "snapshot";
  const dataFmt = m.geradoEm ? new Date(m.geradoEm).toLocaleString("pt-BR") : "—";
  const tag = ehSnapshot
    ? `<strong>📦 Dados de snapshot salvo</strong>`
    : `<strong>🔄 Dados recém-varridos no Mercado Livre</strong>`;
  const seller = m.sellerId ? ` · seller ${escapeHTML(String(m.sellerId))}` : "";
  const parcial = m.parcial
    ? ` · <span style="color:#92400e;font-weight:700;">parcial — varredura limitada a ${escapeHTML(String(m.itensScaneados || 0))} anúncios</span>`
    : "";
  const avisos = Array.isArray(m.avisos) && m.avisos.length
    ? `<br><span style="color:#92400e;">${m.avisos.map(escapeHTML).join(" · ")}</span>`
    : "";
  el.style.background = ehSnapshot ? "var(--vf-bg)" : "#ecfdf5";
  el.innerHTML = `${tag} · gerado em ${escapeHTML(dataFmt)}${seller}${parcial}${avisos}`;
  el.style.display = "block";
}

function renderDiagnosticoResumo() {
  const empty = document.getElementById("promo-resumo-empty");
  const bar = document.getElementById("promo-resumo-bar");
  const badge = document.getElementById("promo-total-ml");
  const nota = document.getElementById("promo-resumo-nota");
  const r = (PROMO_DIAGNOSTICO_META && PROMO_DIAGNOSTICO_META.resumo) || {};
  const m = PROMO_DIAGNOSTICO_META || {};

  if (badge) { badge.style.display = "inline-block"; badge.textContent = String(r.totalPromocoes ?? 0); }
  if (empty) empty.style.display = "none";
  if (nota) nota.style.display = "none";
  if (!bar) return;

  const pill = (label, value, cls = "") =>
    `<span class="vf-resumo-pill ${cls}">${escapeHTML(label)} <strong>${escapeHTML(String(value))}</strong></span>`;
  const n = (v) => (Number.isFinite(Number(v)) ? String(Number(v)) : "0");

  const pills = [
    pill("Promoções encontradas", n(r.totalPromocoes)),
    pill("Com retorno ML", n(r.totalComRetorno), "vf-resumo-success"),
    pill("Sem retorno ML", n(r.totalSemRetorno)),
    pill("Criadas por mim", n(r.totalCriadasPorMim), "vf-resumo-success"),
  ];
  if (Number(r.totalOrigemNaoIdentificada) > 0) {
    pills.push(pill("Origem não identificada", n(r.totalOrigemNaoIdentificada)));
  }
  pills.push(
    pill("Entrar seguro", n(r.entrarSeguro), "vf-resumo-success"),
    pill("Entrar com tolerância", n(r.entrarComTolerancia), "vf-resumo-success"),
    pill("Baixo mesmo com rebate", n(r.baixoMesmoComRebate), "vf-resumo-warning"),
    pill("Não entrar", n(r.naoEntrar), "vf-resumo-danger"),
    pill("Sem relatório / incompletos", n((Number(r.semRelatorio) || 0) + (Number(r.dadosIncompletos) || 0))),
    pill("Anúncios varridos", n(m.itensScaneados))
  );
  bar.innerHTML = pills.join("");
  bar.style.display = "flex";
}

function renderDiagnosticoFiltros() {
  const box = document.getElementById("promo-filtros");
  if (!box) return;

  if (!Array.isArray(PROMO_DIAGNOSTICO_ROWS) || !PROMO_DIAGNOSTICO_ROWS.length) {
    box.innerHTML = "";
    box.style.display = "none";
    return;
  }

  // Origem: contagem respeita a campanha selecionada.
  const rowsCampanha = PROMO_DIAGNOSTICO_ROWS.filter((l) => matchCampanha(l, PROMO_CAMPANHA_FILTER));
  const origemButtons = PROMO_ORIGEM_FILTERS.map((f) => {
    const count = rowsCampanha.filter((l) => matchOrigem(l, f.key)).length;
    const active = f.key === PROMO_ORIGEM_FILTER ? " active" : "";
    return `<button type="button" class="vf-ml-filter-btn${active}" data-origem="${escapeHTML(f.key)}">${escapeHTML(f.label)} (${count})</button>`;
  }).join("");

  // Campanha: opções respeitam a origem selecionada.
  const campanhas = getCampanhasDoDiagnostico();
  const campanhaAindaExiste =
    PROMO_CAMPANHA_FILTER === "todas" || campanhas.some((c) => c.key === PROMO_CAMPANHA_FILTER);
  if (!campanhaAindaExiste) PROMO_CAMPANHA_FILTER = "todas";
  const totalOrigem = PROMO_DIAGNOSTICO_ROWS.filter((l) => matchOrigem(l, PROMO_ORIGEM_FILTER)).length;
  const options = [
    `<option value="todas">Todas as promoções/campanhas (${totalOrigem})</option>`,
    ...campanhas.map((c) => `
      <option value="${escapeHTML(c.key)}"${c.key === PROMO_CAMPANHA_FILTER ? " selected" : ""}>
        ${escapeHTML(c.label)} (${c.count})
      </option>
    `),
  ].join("");

  const decisionButtons = PROMO_FILTERS.map((f) => {
    const count = contarDiagnosticoPorDecisao(f.key);
    const active = f.key === PROMO_FILTER ? " active" : "";
    return `<button type="button" class="vf-ml-filter-btn${active}" data-filter="${escapeHTML(f.key)}">${escapeHTML(f.label)} (${count})</button>`;
  }).join("");

  box.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px;width:100%;">
      <div>
        <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.02em;color:var(--vf-text-m);margin-bottom:6px;">Origem / retorno</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">${origemButtons}</div>
      </div>
      <div class="vf-form-group" style="margin:0;min-width:280px;max-width:460px;">
        <label for="promo-campanha-dinamica">Filtrar por promoção/campanha encontrada</label>
        <select id="promo-campanha-dinamica" class="vf-input">${options}</select>
        <small style="display:block;margin-top:6px;color:var(--vf-text-m);font-size:.75rem;line-height:1.4;">
          Lista todas as promoções/campanhas do snapshot, mesmo que a tabela mostre só 50 linhas.
        </small>
      </div>
      <div>
        <div style="font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.02em;color:var(--vf-text-m);margin-bottom:6px;">Decisão</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">${decisionButtons}</div>
      </div>
    </div>
  `;

  box.style.display = "flex";
  box.style.flexDirection = "column";
  box.style.alignItems = "stretch";

  box.querySelectorAll("[data-origem]").forEach((b) => {
    b.addEventListener("click", () => {
      PROMO_ORIGEM_FILTER = b.getAttribute("data-origem") || "todas";
      PROMO_CAMPANHA_FILTER = "todas";
      PROMO_FILTER = "todos";
      renderDiagnosticoFiltros();
      renderDiagnosticoTabela();
    });
  });

  document.getElementById("promo-campanha-dinamica")?.addEventListener("change", (event) => {
    PROMO_CAMPANHA_FILTER = event.target.value || "todas";
    PROMO_FILTER = "todos";
    renderDiagnosticoFiltros();
    renderDiagnosticoTabela();
  });

  box.querySelectorAll("[data-filter]").forEach((b) => {
    b.addEventListener("click", () => {
      PROMO_FILTER = b.getAttribute("data-filter") || "todos";
      renderDiagnosticoFiltros();
      renderDiagnosticoTabela();
    });
  });
}

function renderDiagnosticoTabela() {
  const empty = document.getElementById("promo-tabela-empty");
  const wrapper = document.getElementById("promo-tabela-wrapper");
  const badge = document.getElementById("promo-tabela-total");
  const aviso = document.getElementById("promo-diagnostico-aviso");
  const tbody = document.getElementById("promo-tbody");
  if (!tbody) return;

  if (!Array.isArray(PROMO_DIAGNOSTICO_ROWS) || !PROMO_DIAGNOSTICO_ROWS.length) {
    if (empty) { empty.style.display = "block"; const p = empty.querySelector("p"); if (p) p.textContent = "Nenhuma promoção encontrada no diagnóstico."; }
    if (wrapper) wrapper.style.display = "none";
    if (aviso) aviso.style.display = "none";
    if (badge) { badge.style.display = "inline-block"; badge.textContent = "0"; }
    tbody.innerHTML = "";
    return;
  }

  const all = linhasDiagnosticoFiltradas();
  const rowsToRender = all.slice(0, PROMO_RENDER_LIMIT);

  if (badge) { badge.style.display = "inline-block"; badge.textContent = String(rowsToRender.length); }
  if (empty) empty.style.display = "none";
  if (wrapper) wrapper.style.display = "block";

  if (aviso) {
    if (all.length > PROMO_RENDER_LIMIT) {
      aviso.textContent = `Mostrando ${PROMO_RENDER_LIMIT} de ${all.length} itens. Refine os filtros para ver menos itens.`;
      aviso.style.display = "block";
    } else {
      aviso.style.display = "none";
    }
  }

  if (!all.length) {
    tbody.innerHTML = `<tr><td colspan="21" style="color:var(--vf-text-m);text-align:center;padding:1rem;">Nenhuma linha neste filtro.</td></tr>`;
    return;
  }

  preencherTbody(tbody, rowsToRender);
}

// Aplica um payload de diagnóstico (varredura, atualização ou snapshot) à tela.
function aplicarDiagnostico(payload) {
  PROMO_MODE = "diagnostico";
  PROMO_DIAGNOSTICO_ROWS = Array.isArray(payload.linhas) ? payload.linhas : [];
  PROMO_DIAGNOSTICO_META = {
    ...(payload.meta || {}),
    origem: payload.origem || (payload.meta && payload.meta.origem) || "scan",
    resumo: payload.resumo || {},
    cliente: payload.cliente || null,
    base: payload.base || null,
  };
  PROMO_SNAPSHOT_ID = payload.snapshot_id || null;
  PROMO_ORIGEM_FILTER = "todas";
  PROMO_CAMPANHA_FILTER = "todas";
  PROMO_FILTER = "todos";
  renderDiagnosticoInfo();
  renderDiagnosticoResumo();
  renderDiagnosticoFiltros();
  renderDiagnosticoTabela();
  updateSnapshotButtons();
}

function pararPolling() {
  if (PROMO_POLL_TIMER) { clearTimeout(PROMO_POLL_TIMER); PROMO_POLL_TIMER = null; }
}

// Inicia um job de diagnóstico (start) e passa a fazer polling do progresso.
// Usado por "Gerar diagnóstico" e "Atualizar snapshot" (mesma varredura).
async function iniciarDiagnosticoJob() {
  const { clienteSlug, baseSlug } = diagQsBase();
  if (!clienteSlug) { setStatus("Selecione um cliente.", "var(--vf-danger)"); return; }
  if (!baseSlug) { setStatus("Selecione uma base.", "var(--vf-danger)"); return; }

  const margem = lerPercentInput("promo-margem");
  const tolerancia = lerPercentInput("promo-tolerancia");

  pararPolling();
  setStatus("Iniciando diagnóstico… varrendo as promoções da conta em segundo plano.", "var(--vf-text-m)");

  try {
    const res = await fetch(`${API_BASE}/automacoes/promocoes-retorno/diagnostico/start`, {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ clienteSlug, baseSlug, margemAlvo: margem, tolerancia }),
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      setStatus(data?.erro || `Erro ao iniciar diagnóstico (HTTP ${res.status}).`, "var(--vf-danger)");
      return;
    }
    PROMO_JOB_ID = data.diagnostico_id;
    updateSnapshotButtons();
    if (data.jaEmAndamento) {
      setStatus("Já havia um diagnóstico em andamento para este cliente/base — acompanhando o progresso…", "var(--vf-text-m)");
    }
    pollDiagnosticoStatus();
  } catch (_) {
    setStatus("Falha de rede ao iniciar diagnóstico. Tente novamente.", "var(--vf-danger)");
  }
}

// Consulta o status do job atual e reagenda enquanto estiver "processando".
async function pollDiagnosticoStatus() {
  if (!PROMO_JOB_ID) return;
  const jobId = PROMO_JOB_ID;
  try {
    const res = await fetch(`${API_BASE}/automacoes/promocoes-retorno/diagnostico/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    const data = await res.json().catch(() => ({}));
    if (PROMO_JOB_ID !== jobId) return; // outro job assumiu

    if (!res.ok || !data?.ok) {
      PROMO_JOB_ID = null;
      updateSnapshotButtons();
      setStatus(data?.erro || `Erro ao consultar diagnóstico (HTTP ${res.status}).`, "var(--vf-danger)");
      return;
    }

    const d = data.diagnostico || {};

    if (d.status === "processando") {
      const proc = Number(d.itensProcessados) || 0;
      const tot = Number(d.totalEstimado);
      const prog = Number.isFinite(tot) && tot > 0 ? `${proc}/${tot}` : `${proc}`;
      setStatus(`Processando diagnóstico… ${prog} anúncios varridos.`, "var(--vf-text-m)");
      PROMO_POLL_TIMER = setTimeout(pollDiagnosticoStatus, PROMO_POLL_INTERVAL);
      return;
    }

    // Estado terminal.
    PROMO_JOB_ID = null;

    if (d.status === "erro") {
      updateSnapshotButtons();
      setStatus(`Diagnóstico falhou: ${d.aviso || "erro desconhecido"}.`, "var(--vf-danger)");
      return;
    }

    // Concluído (possivelmente parcial). Worker já salvou o snapshot → carrega.
    PROMO_SNAPSHOT_EXISTE = true;
    const ok = await carregarSnapshotComoResultado("scan");
    updateSnapshotButtons();
    const parcial = d.parcial ? ` (parcial — ${d.aviso || ""})` : "";
    if (ok) {
      setStatus(
        `Diagnóstico concluído${parcial}: ${d.totalPromocoes || 0} promoção(ões) em ${d.itensScaneados || 0} anúncios. Snapshot salvo.`,
        d.parcial ? "var(--vf-danger)" : "var(--vf-primary)"
      );
    } else {
      setStatus(`Diagnóstico concluído${parcial}, mas não foi possível carregar o snapshot. Tente "Usar último snapshot".`, "var(--vf-danger)");
    }
  } catch (_) {
    // Erro de rede transitório: reagenda mais devagar sem perder o job.
    if (PROMO_JOB_ID === jobId) PROMO_POLL_TIMER = setTimeout(pollDiagnosticoStatus, PROMO_POLL_INTERVAL * 2);
  }
}

// Carrega o último snapshot concluído e o exibe. `origemLabel` controla o banner
// ("scan" = recém-varrido, "snapshot" = snapshot salvo reaberto).
async function carregarSnapshotComoResultado(origemLabel) {
  const { clienteSlug, baseSlug } = diagQsBase();
  if (!clienteSlug || !baseSlug) return false;
  const qs = new URLSearchParams({ clienteSlug, baseSlug });
  const res = await fetch(`${API_BASE}/automacoes/promocoes-retorno/snapshot?${qs.toString()}`, {
    headers: { Authorization: "Bearer " + TOKEN },
  });
  if (res.status === 401) { clearSession(); return false; }
  if (res.status === 403) { window.location.replace("dashboard.html"); return false; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok || !data.existe) return false;
  aplicarDiagnostico({ ...data, origem: origemLabel || data.origem || "snapshot" });
  PROMO_SNAPSHOT_ID = data.snapshot_id;
  return true;
}

// Botão "Gerar diagnóstico de promoções" — inicia a varredura assíncrona.
async function gerarDiagnosticoPromocoes() {
  return iniciarDiagnosticoJob();
}

// Botão "Atualizar snapshot" — mesma varredura assíncrona (regera o snapshot).
async function atualizarSnapshotPromocoes() {
  return iniciarDiagnosticoJob();
}

// Botão "Usar último snapshot" — reabre o último snapshot concluído, sem varrer.
async function carregarUltimoSnapshotPromocoes() {
  const { clienteSlug, baseSlug } = diagQsBase();
  if (!clienteSlug || !baseSlug) { setStatus("Selecione cliente e base.", "var(--vf-danger)"); return; }

  const btn = document.getElementById("btn-promo-snapshot-usar");
  const orig = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Carregando…"; }
  setStatus("Carregando último snapshot salvo…", "var(--vf-text-m)");

  try {
    const ok = await carregarSnapshotComoResultado("snapshot");
    if (!ok) {
      PROMO_SNAPSHOT_EXISTE = false;
      updateSnapshotButtons();
      setStatus("Nenhum snapshot concluído para este cliente/base. Gere um diagnóstico primeiro.", "var(--vf-text-m)");
      return;
    }
    PROMO_SNAPSHOT_EXISTE = true;
    setStatus(`Snapshot #${PROMO_SNAPSHOT_ID} carregado (${PROMO_DIAGNOSTICO_ROWS.length} promoções).`, "var(--vf-text-m)");
  } catch (_) {
    setStatus("Falha de rede ao carregar snapshot.", "var(--vf-danger)");
  } finally {
    if (btn) { btn.textContent = orig || "Usar último snapshot"; }
    updateSnapshotButtons();
  }
}

// Verifica (silenciosamente) se há snapshot salvo para o cliente/base atual,
// habilitando/desabilitando os botões dependentes.
async function verificarSnapshotDisponivel() {
  updateSnapshotButtons();
  const { clienteSlug, baseSlug } = diagQsBase();
  if (!clienteSlug || !baseSlug) { PROMO_SNAPSHOT_EXISTE = false; updateSnapshotButtons(); return; }
  const key = clienteSlug + "|" + baseSlug;
  PROMO_SNAPSHOT_CHECK_KEY = key;
  try {
    const qs = new URLSearchParams({ clienteSlug, baseSlug });
    const res = await fetch(`${API_BASE}/automacoes/promocoes-retorno/snapshot?${qs.toString()}`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    if (PROMO_SNAPSHOT_CHECK_KEY !== key) return; // resposta obsoleta
    PROMO_SNAPSHOT_EXISTE = !!data.existe;
    updateSnapshotButtons();
  } catch (_) { /* silencioso */ }
}

// ─── Copiar MLB ───────────────────────────────────────────────────────────
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

// ─── Modal: ver cálculo ───────────────────────────────────────────────────
function abrirModalCalculo(l) {
  if (!l) return;
  const modal = document.getElementById("promo-calc-modal");
  const body = document.getElementById("promo-calc-modal-body");
  if (!modal || !body) return;

  const row = (label, value, strong = false, sep = false) =>
    (sep ? `<div class="vf-promo-calc-sep"></div>` : "") +
    `<div class="${strong ? "vf-promo-calc-strong" : ""}">${escapeHTML(label)}</div>` +
    `<div class="vf-promo-calc-val ${strong ? "vf-promo-calc-strong" : ""}">${value}</div>`;

  // Valores de rebate (com fallback aos nomes de compatibilidade).
  const lcSemR = l.lcSemRebate != null ? l.lcSemRebate : l.lcSemRetorno;
  const mcSemR = l.mcSemRebate != null ? l.mcSemRebate : l.mcSemRetorno;
  const lcComR = l.lcComRebate != null ? l.lcComRebate : l.lcComRetorno;
  const mcComR = l.mcComRebate != null ? l.mcComRebate : l.mcComRetorno;

  const relId = l.relatorioId ?? l.debug?.relatorioId ?? null;
  const relData = l.relatorioCreatedAt ?? l.debug?.relatorioCreatedAt ?? null;
  const relDataFmt = relData ? new Date(relData).toLocaleString("pt-BR") : "—";

  body.innerHTML = `
    <div style="margin-bottom:.75rem;font-size:.85rem;color:var(--vf-text-m);">
      <strong style="font-family:var(--vf-mono);">${escapeHTML(txt(l.itemId))}</strong>
      ${l.campanha ? `· ${escapeHTML(l.campanha)}` : ""}
    </div>
    <div style="margin-bottom:.9rem;padding:.6rem .75rem;background:var(--vf-bg);border:1px solid var(--vf-border);border-radius:8px;font-size:.78rem;color:var(--vf-text-m);line-height:1.5;">
      <strong>Fonte financeira:</strong> último relatório salvo
      ${relId ? `(Relatório #${escapeHTML(String(relId))} · ${escapeHTML(relDataFmt)})` : "— nenhum relatório encontrado"}<br>
      <strong>Fórmula (planilha):</strong>
      LC com retorno = preço − preço×imposto − preço×comissão − frete − taxa fixa − custo + taxa de retorno
    </div>
    <div class="vf-promo-calc-grid">
      ${row("Relatório usado", relId ? `#${escapeHTML(String(relId))}` : "—", true)}
      ${row("Data do relatório", escapeHTML(relDataFmt))}
      ${row("Preço promoção", brl(l.precoPromocao), true, true)}
      ${row("Custo (relatório)", brl(l.custo))}
      ${row("Frete (relatório)", brl(l.frete))}
      ${row("Imposto % (relatório)", pctRaw(l.impostoPercentual))}
      ${row("Imposto R$", brl(l.impostoValor))}
      ${row("Comissão % (relatório)", pctRaw(l.comissaoPercentual))}
      ${row("Comissão R$", brl(l.comissaoValor))}
      ${row("Taxa fixa (relatório)", brl(l.taxaFixa))}
      ${row("LC sem retorno", brl(lcSemR), true, true)}
      ${row("Taxa de retorno", brl(l.retornoMl), true)}
      ${row("LC com retorno = LC sem retorno + taxa de retorno", brl(lcComR), true)}
      ${row("MC com retorno = LC com retorno / preço promoção", pctFrac(mcComR), true)}
      ${row("Margem alvo", pctFrac(l.margemAlvo), false, true)}
      ${row("Diferença p.p. vs alvo", pp(l.diferencaPp))}
    </div>
    <div style="margin-top:1rem;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      ${badgeDecisao(l.decisao)}
      <span style="font-size:.82rem;color:var(--vf-text-m);">${escapeHTML(txt(l.motivo))}</span>
    </div>
    ${getMlPromosUrl(l.itemId)
      ? `<div style="margin-top:1rem;display:flex;justify-content:flex-end;">
           <button type="button" id="promo-calc-ml-btn" class="vf-btn-secondary" style="margin:0;">Gerenciar promoção no ML</button>
         </div>`
      : ""}
  `;
  modal.style.display = "flex";

  document.getElementById("promo-calc-ml-btn")?.addEventListener("click", () => abrirGerenciarNoMl(l.itemId));
}

function fecharModal() {
  const modal = document.getElementById("promo-calc-modal");
  if (modal) modal.style.display = "none";
}

// ─── Eventos ──────────────────────────────────────────────────────────────
document.getElementById("btn-promo-analisar")?.addEventListener("click", analisar);
document.getElementById("btn-promo-diagnostico")?.addEventListener("click", gerarDiagnosticoPromocoes);
document.getElementById("btn-promo-snapshot-atualizar")?.addEventListener("click", atualizarSnapshotPromocoes);
document.getElementById("btn-promo-snapshot-usar")?.addEventListener("click", carregarUltimoSnapshotPromocoes);
document.getElementById("promo-cliente-search")?.addEventListener("input", applyClienteSearchFilter);
document.getElementById("promo-base-search")?.addEventListener("input", applyBaseSearchFilter);
// Ao trocar cliente/base, reavalia botões de snapshot (habilita "Usar último snapshot").
document.getElementById("promo-cliente")?.addEventListener("change", verificarSnapshotDisponivel);
document.getElementById("promo-base")?.addEventListener("change", verificarSnapshotDisponivel);
document.getElementById("promo-calc-modal-close")?.addEventListener("click", fecharModal);
document.getElementById("promo-calc-modal")?.addEventListener("click", (e) => {
  if (e.target.id === "promo-calc-modal") fecharModal();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharModal(); });

// ─── Init ─────────────────────────────────────────────────────────────────
loadClientes();
loadBases();
