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
  if (btn) btn.disabled = !getImportMarketplace();
}

function setImportLoading(on) {
  document.getElementById("btn-importar").disabled             = on ? true : !getImportMarketplace();
  document.getElementById("btn-importar-text").textContent     = on ? "Processando…" : "Pré-visualizar";
  document.getElementById("btn-importar-spinner").style.display = on ? "inline-block" : "none";
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
  el.classList.remove("show", "vf-alert-success", "vf-alert-danger");
  el.textContent = "";
  if (!msg) { el.style.display = "none"; return; }
  const cls = type === "success" ? "vf-alert-success" : (type === "danger" ? "vf-alert-danger" : "");
  if (cls) el.classList.add(cls);
  el.classList.add("show");
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

function getBasesFiltradas() {
  const termo = String(BASES_BUSCA || "").toLowerCase().trim();
  return (Array.isArray(TODAS_BASES) ? TODAS_BASES : []).filter((b) => {
    if (!termo) return true;
    const hay = `${b?.nome || ""} ${b?.slug || ""} ${getClienteTexto(b)}`.toLowerCase();
    return hay.includes(termo);
  });
}

function renderBasesSummary() {
  const el = document.getElementById("bases-summary");
  if (!el) return;
  const bases = Array.isArray(TODAS_BASES) ? TODAS_BASES : [];
  const total = bases.length;
  const comVinculo = bases.filter((b) => !!b?.vinculo).length;
  const semVinculo = bases.filter((b) => !b?.vinculo).length;
  const sugestoes = bases.filter((b) => !b?.vinculo && !!b?.sugestao).length;
  const cards = [
    { label: "Total de bases", value: String(total) },
    { label: "Com vínculo oficial", value: String(comVinculo) },
    { label: "Sem vínculo", value: String(semVinculo) },
    { label: "Sugestões pendentes", value: String(sugestoes) },
  ];
  el.innerHTML = cards.map((c) => `
    <div class="vf-relatorios-summary-card">
      <div class="vf-relatorios-summary-label">${escapeHTML(c.label)}</div>
      <div class="vf-relatorios-summary-value">${escapeHTML(c.value)}</div>
    </div>
  `).join("");
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
  modal.style.display = "flex";
}

function fecharModalExcluirBase() {
  const modal = document.getElementById("vf-excluir-base-modal");
  if (modal) modal.style.display = "none";
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
  renderBasesSummary();
  renderBases(getBasesFiltradas());
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

function renderClienteCell(base) {
  const v = base?.vinculo;
  const s = base?.sugestao;
  if (v) {
    return `
      <div><strong>${escapeHTML(v.cliente_nome || "—")}</strong></div>
      <div style="color:var(--vf-text-m);font-family:var(--vf-mono);font-size:.78rem;">${escapeHTML(v.cliente_slug || "—")}</div>
      <div style="margin-top:6px;"><span class="vf-status-pill vf-status-pill-success">Vínculo oficial</span></div>
    `;
  }
  const sugestaoHtml = s ? `
    <div style="margin-top:6px;color:var(--vf-text-m);font-size:.78rem;line-height:1.35;">
      Sugestão:
      <strong>${escapeHTML(s.cliente_nome || s.cliente_slug || "cliente sugerido")}</strong>
      <span style="font-family:var(--vf-mono);">${escapeHTML(s.cliente_slug ? `(${s.cliente_slug})` : "")}</span> — confirmar para tornar oficial
    </div>
  ` : "";
  return `
    <div><strong style="color:var(--vf-text-m);">Sem vínculo</strong></div>
    ${sugestaoHtml}
  `;
}

function renderMarketplaceCell(base) {
  const mp = getMarketplaceDisplay(base);
  if (mp.origem === "oficial") {
    const cls = mp.key === "meli" ? "vf-status-pill-success" : (mp.key === "shopee" ? "vf-status-pill-warning" : "vf-status-pill-neutral");
    return `<span class="vf-status-pill ${cls}">${escapeHTML(mp.label)}</span>`;
  }
  if (mp.origem === "sugestao") {
    return `
      <span class="vf-status-pill vf-status-pill-neutral">${escapeHTML(mp.label)}</span>
      <div style="margin-top:6px;color:var(--vf-text-m);font-size:.75rem;">Sugestão automática</div>
    `;
  }
  return `<span class="vf-status-pill vf-status-pill-neutral">Não definido</span>`;
}

function renderAcoesBase(base) {
  const id = escapeHTML(String(base.id || ""));
  const slug = escapeHTML(base.slug || "");
  const nome = escapeHTML(base.nome || base.slug || "");
  const vinculoBtns = VINCULOS_EDITAVEIS ? `
    <button class="vf-action-btn vf-action-btn-secondary vf-btn-vincular-base" data-base-id="${id}">${base.vinculo ? "Alterar vínculo" : "Vincular"}</button>
    ${base.vinculo ? `<button class="vf-action-btn vf-action-btn-neutral vf-btn-remover-vinculo" data-base-id="${id}">Remover vínculo</button>` : ""}
  ` : "";
  return `
    <div class="vf-table-actions" style="display:flex;flex-wrap:wrap;gap:6px;justify-content:center;">
      ${vinculoBtns}
      <button class="vf-action-btn vf-action-btn-neutral asst-btn-baixar-base" data-slug="${slug}" data-nome="${nome}">Baixar</button>
      <button class="vf-action-btn vf-action-btn-danger btn-excluir-base" data-slug="${slug}" data-nome="${nome}">Excluir</button>
    </div>
  `;
}

function buildBaseRow(base, i) {
  const data  = formatDateTime(base.updated_at || base.created_at);
  const ativo = base.ativo !== false;
  const tr    = document.createElement("tr");
  tr.classList.add("animate-fade-up");
  tr.style.animationDelay = `${i * 0.04}s`;
  tr.innerHTML = `
    <td style="color:var(--vf-text-l);font-family:var(--vf-mono);font-size:.8rem;">${String(i+1).padStart(2,"0")}</td>
    <td>
      <strong>${escapeHTML(base.nome || "—")}</strong>
      <div style="color:var(--vf-text-m);font-size:.78rem;font-family:var(--vf-mono);margin-top:3px;">${escapeHTML(base.slug || "—")}</div>
    </td>
    <td>${renderClienteCell(base)}</td>
    <td style="text-align:center;">${renderMarketplaceCell(base)}</td>
    <td style="font-size:.8rem;color:#888;">${escapeHTML(data)}</td>
    <td style="text-align:center;">
      <span class="vf-status-pill ${ativo ? "vf-status-pill-success" : "vf-status-pill-danger"}">${ativo ? "Ativa" : "Inativa"}</span>
    </td>
    <td style="text-align:center;">${renderAcoesBase(base)}</td>`;
  return tr;
}

function bindBaseRowActions(tbody) {
  tbody.querySelectorAll(".asst-btn-baixar-base").forEach(btn => {
    btn.addEventListener("click", () => {
      const { slug, nome } = btn.dataset;
      asstBaixarBase(slug, nome, btn);
    });
  });
  tbody.querySelectorAll(".btn-excluir-base").forEach(btn => {
    btn.addEventListener("click", () => {
      const { slug, nome } = btn.dataset;
      abrirModalExcluirBase({ slug, nome, btn });
    });
  });
  tbody.querySelectorAll(".vf-btn-vincular-base").forEach(btn => {
    btn.addEventListener("click", () => abrirModalVinculo(btn.dataset.baseId));
  });
  tbody.querySelectorAll(".vf-btn-remover-vinculo").forEach(btn => {
    btn.addEventListener("click", () => removerVinculoBase(btn.dataset.baseId, btn));
  });
}

function renderBases(bases) {
  basesTbodyMeli.innerHTML   = "";
  basesTbodyShopee.innerHTML = "";

  if (!bases.length) { showEmpty(); return; }

  const meli   = bases.filter((b) => getBaseMarketplaceKey(b) === "meli");
  const shopee = bases.filter((b) => getBaseMarketplaceKey(b) === "shopee");

  meli.forEach((base, i)   => basesTbodyMeli.appendChild(buildBaseRow(base, i)));
  shopee.forEach((base, i) => basesTbodyShopee.appendChild(buildBaseRow(base, i)));

  document.getElementById("count-meli").textContent    = String(meli.length);
  document.getElementById("count-shopee").textContent  = String(shopee.length);
  document.getElementById("wrap-meli").style.display    = meli.length   ? "" : "none";
  document.getElementById("wrap-shopee").style.display  = shopee.length ? "" : "none";
  document.getElementById("empty-meli").style.display   = meli.length   ? "none" : "block";
  document.getElementById("empty-shopee").style.display = shopee.length ? "none" : "block";

  basesCount.textContent   = String(bases.length);
  basesCount.style.display = "inline-block";

  bindBaseRowActions(basesTbodyMeli);
  bindBaseRowActions(basesTbodyShopee);

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
  modal.style.display = "flex";
}

function fecharModalVinculo() {
  const modal = document.getElementById("vf-vinculo-base-modal");
  if (modal) modal.style.display = "none";
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

// ─── Marketplace obrigatório: habilita "Pré-visualizar" só após seleção ───
document.getElementById("import-marketplace")?.addEventListener("change", atualizarBotaoImportarDisabled);
atualizarBotaoImportarDisabled();

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
      dropLabel.classList.add("vf-dropzone-dragover");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    dropLabel.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropLabel.classList.remove("vf-dropzone-dragover");
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

    closePreview();
    setImportStatus(`✓ ${data.mensagem || "Importado com sucesso!"} (${data.total ?? 0} produtos)`, "var(--vf-success)");
    document.getElementById("import-nome").value    = "";
    document.getElementById("import-arquivo").value = "";
    document.getElementById("file-label-text").textContent = "Escolher arquivo…";
    document.getElementById("file-label").classList.remove("has-file");
    const mpSel = document.getElementById("import-marketplace");
    if (mpSel) mpSel.value = "";
    atualizarBotaoImportarDisabled();
    loadBases();

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

// Busca + chips
const basesBuscaInput = document.getElementById("bases-busca");
if (basesBuscaInput) {
  basesBuscaInput.addEventListener("input", (e) => {
    BASES_BUSCA = e.target.value || "";
    renderBasesSummary();
    renderBases(getBasesFiltradas());
  });
}

// ─── Logout + Retry ───
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
  if (modalVinculo && modalVinculo.style.display !== "none") fecharModalVinculo();
  if (modalExcluir && modalExcluir.style.display !== "none") fecharModalExcluirBase();
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
