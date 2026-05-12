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

function setImportLoading(on) {
  document.getElementById("btn-importar").disabled             = on;
  document.getElementById("btn-importar-text").textContent     = on ? "Processando…" : "Pré-visualizar";
  document.getElementById("btn-importar-spinner").style.display = on ? "inline-block" : "none";
}

// ─── Estados da tabela de bases ───
const stateLoading = document.getElementById("state-loading");
const stateTable   = document.getElementById("state-table");
const stateEmpty   = document.getElementById("state-empty");
const stateError   = document.getElementById("state-error");
const basesCount   = document.getElementById("bases-count");
const basesTbody   = document.getElementById("bases-tbody");

// ─── Estado (filtros frontend) ───
let TODAS_BASES = [];
let BASES_FILTRO_MARKETPLACE = "todos";
let BASES_BUSCA = "";

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

function detectarMarketplaceBase(base) {
  const norm = (v) =>
    String(v || "")
      .toLowerCase()
      .trim()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

  const rawMarketplace = norm(base?.marketplace);
  if (rawMarketplace) {
    if (rawMarketplace.includes("shopee")) return { key: "shopee", label: "Shopee" };
    if (rawMarketplace.includes("meli") || rawMarketplace.includes("mercado")) return { key: "meli", label: "Mercado Livre" };
  }

  const nome = norm(base?.nome);
  const slug = norm(base?.slug);
  const hay = `${nome} ${slug}`;

  // Shopee: detectar se contiver shopee/shop/shp/sp_
  // Prioridade só quando "shopee" aparece explicitamente e conflita com meli.
  const hasShopeeExplicit = hay.includes("shopee");
  const hasShopee = hasShopeeExplicit || hay.includes("shop") || hay.includes("shp") || hay.includes("sp_");

  // Mercado Livre: detectar se contiver meli, variações de "mercado livre", ml separado por _/- ou mlb
  const hasMeli =
    hay.includes("meli") ||                 // cobre jf_meli1, influencia_meli2, etc.
    hay.includes("mercado_livre") ||
    hay.includes("mercado-livre") ||
    hay.includes("mercadolivre") ||
    hay.includes("mercado livre") ||
    hay.includes("mlb") ||
    /(^|[_\-\s])ml([_\-\s]|$)/i.test(hay) || // _ml, ml_, -ml, ml-, etc.
    /(^|[_\-\s])mlb([_\-\s]|\d|$)/i.test(hay);

  // Regra: se tiver shopee e meli no mesmo texto, prioriza Shopee apenas se "shopee" explícito.
  if (hasShopeeExplicit) return { key: "shopee", label: "Shopee" };
  if (hasMeli) return { key: "meli", label: "Mercado Livre" };
  if (hasShopee) return { key: "shopee", label: "Shopee" };
  return { key: "outro", label: "Não identificado" };
}

function getBasesFiltradas() {
  const termo = String(BASES_BUSCA || "").toLowerCase().trim();
  return (Array.isArray(TODAS_BASES) ? TODAS_BASES : []).filter((b) => {
    const mp = detectarMarketplaceBase(b);
    if (BASES_FILTRO_MARKETPLACE !== "todos" && mp.key !== BASES_FILTRO_MARKETPLACE) return false;
    if (!termo) return true;
    const hay = `${b?.nome || ""} ${b?.slug || ""}`.toLowerCase();
    return hay.includes(termo);
  });
}

function renderBasesChips() {
  const wrap = document.getElementById("bases-filter-chips");
  if (!wrap) return;
  const chips = [
    { key: "todos", label: "Todos" },
    { key: "meli", label: "Mercado Livre" },
    { key: "shopee", label: "Shopee" },
    { key: "outro", label: "Não identificado" },
  ];
  wrap.innerHTML = chips.map((c) => {
    const active = c.key === BASES_FILTRO_MARKETPLACE ? "active" : "";
    return `<button type="button" class="vf-ml-filter-btn ${active}" data-base-filter="${escapeHTML(c.key)}">${escapeHTML(c.label)}</button>`;
  }).join("");
  wrap.querySelectorAll("[data-base-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      BASES_FILTRO_MARKETPLACE = btn.getAttribute("data-base-filter") || "todos";
      renderBasesChips();
      renderBases(getBasesFiltradas());
    });
  });
}

function renderBasesSummary() {
  const el = document.getElementById("bases-summary");
  if (!el) return;
  const bases = getBasesFiltradas();
  const total = bases.length;
  const meli = bases.filter((b) => detectarMarketplaceBase(b).key === "meli").length;
  const shopee = bases.filter((b) => detectarMarketplaceBase(b).key === "shopee").length;
  const outro = bases.filter((b) => detectarMarketplaceBase(b).key === "outro").length;
  const cards = [
    { label: "Total de bases", value: String(total) },
    { label: "Mercado Livre", value: String(meli) },
    { label: "Shopee", value: String(shopee) },
    { label: "Não identificado", value: String(outro) },
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
  stateLoading.style.display = "flex";
  stateTable.style.display   = stateEmpty.style.display = stateError.style.display = "none";
}
function showTable() {
  stateTable.style.display   = "block";
  stateLoading.style.display = stateEmpty.style.display = stateError.style.display = "none";
}
function showEmpty() {
  stateEmpty.style.display   = "block";
  stateLoading.style.display = stateTable.style.display = stateError.style.display = "none";
  basesCount.style.display   = "none";
}
function showError(msg) {
  stateError.style.display   = "block";
  stateLoading.style.display = stateTable.style.display = stateEmpty.style.display = "none";
  document.getElementById("error-message").textContent = msg;
}

// ─── Carregar bases ───
async function loadBases() {
  if (!TOKEN) return;
  showLoading();
  try {
    const res = await fetch(`${API_BASE}/bases`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { bases } = await res.json();
    TODAS_BASES = Array.isArray(bases) ? bases : [];
    renderBasesChips();
    renderBasesSummary();
    renderBases(getBasesFiltradas());
  } catch (err) {
    showError("Não foi possível carregar as bases. Tente novamente.");
  }
}

function renderBases(bases) {
  basesTbody.innerHTML = "";
  if (!bases.length) { showEmpty(); return; }

  basesCount.textContent   = String(bases.length);
  basesCount.style.display = "inline-block";

  bases.forEach((base, i) => {
    const data = new Date(base.updated_at).toLocaleString();
    const ativo = base.ativo !== false;
    const mp = detectarMarketplaceBase(base);
    const tr    = document.createElement("tr");
    tr.classList.add("animate-fade-up");
    tr.style.animationDelay = `${i * 0.04}s`;
    tr.innerHTML = `
      <td style="color:var(--vf-text-l);font-family:var(--vf-mono);font-size:.8rem;">${String(i+1).padStart(2,"0")}</td>
      <td><strong>${escapeHTML(base.nome || "—")}</strong></td>
      <td style="color:var(--vf-text-m);font-size:.875rem;font-family:var(--vf-mono);">${escapeHTML(base.slug || "—")}</td>
      <td style="font-size:.8rem;color:#888;">
    ${data || "--"}
  </td>
      <td style="text-align:center;">
        <span class="vf-status-pill ${mp.key === "meli" ? "vf-status-pill-success" : (mp.key === "shopee" ? "vf-status-pill-warning" : "vf-status-pill-neutral")}">${escapeHTML(mp.label)}</span>
      </td>
      <td style="text-align:center;">
        <span class="vf-status-pill ${ativo ? "vf-status-pill-success" : "vf-status-pill-danger"}">${ativo ? "Ativa" : "Inativa"}</span>
      </td>
      <td style="text-align:center;">
        <div class="vf-table-actions">
          <button class="vf-action-btn vf-action-btn-danger" data-slug="${escapeHTML(base.slug)}" data-nome="${escapeHTML(base.nome || base.slug)}">Excluir</button>
        </div>
      </td>`;
    basesTbody.appendChild(tr);
  });

  basesTbody.querySelectorAll("button[data-slug]").forEach(btn => {
    btn.addEventListener("click", () => {
      const { slug, nome } = btn.dataset;
      abrirModalExcluirBase({ slug, nome, btn });
    });
  });

  showTable();
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

// ─── File input label ───
document.getElementById("import-arquivo").addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  document.getElementById("file-label-text").textContent = f ? f.name : "Escolher arquivo…";
  document.getElementById("file-label").classList.toggle("has-file", !!f);
});

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

  const tbody = document.getElementById("preview-tbody");
  tbody.innerHTML = "";
  (payload.preview || []).forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(r.id ?? ""))}</td>
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
  if (!arquivo || !nome) { closePreview(); return; }

  document.getElementById("preview-confirm").disabled                 = true;
  document.getElementById("preview-confirm-text").textContent        = "Importando…";
  document.getElementById("preview-confirm-spinner").style.display   = "inline-block";

  try {
    const fd = new FormData();
    fd.append("arquivo", arquivo);
    fd.append("nomeBase", nome);
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

  setImportStatus("", "");
  if (!nome)    { setImportStatus("Informe o nome da base.", "var(--vf-danger)"); return; }
  if (!arquivo) { setImportStatus("Selecione um arquivo .xlsx ou .csv.", "var(--vf-danger)"); return; }

  setImportLoading(true);

  try {
    const fd = new FormData();
    fd.append("arquivo", arquivo);
    fd.append("nomeBase", nome);
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
document.addEventListener("keydown", (e) => {
  const modal = document.getElementById("vf-excluir-base-modal");
  if (e.key === "Escape" && modal && modal.style.display !== "none") fecharModalExcluirBase();
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
    { label: "Linhas lidas",   value: resumo.linhas_lidas     != null ? resumo.linhas_lidas     : "—" },
    { label: "Linhas válidas", value: resumo.linhas_validas   != null ? resumo.linhas_validas   : "—" },
    { label: "Ignoradas",      value: resumo.linhas_ignoradas != null ? resumo.linhas_ignoradas : "—" },
    { label: "Duplicados",     value: resumo.duplicados       != null ? resumo.duplicados       : "—" },
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
        <div class="asst-preview-table-title">Prévia — ${rows.length} linha${rows.length !== 1 ? "s" : ""}</div>
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
    asstUltimosDados.colunas_detectadas &&
    asstUltimosDados.colunas_detectadas.id &&
    Array.isArray(asstUltimosDados.preview) &&
    asstUltimosDados.preview.some(r => r.id != null && String(r.id).trim() !== "");
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
  if (!asstUltimosDados || !Array.isArray(asstUltimosDados.preview)) return;

  const nome = ((document.getElementById("asst-nome-base") || {}).value || "").trim();
  if (!nome) {
    asstSetImportStatus("Informe o nome da base antes de importar.", "erro");
    return;
  }

  const linhasValidas = asstUltimosDados.preview.filter(
    r => r.id != null && String(r.id).trim() !== ""
  );
  if (!linhasValidas.length) {
    asstSetImportStatus("Nenhuma linha válida para importar.", "erro");
    return;
  }

  const confirmou = confirm(
    `Importar "${nome}" com ${linhasValidas.length} linha(s) normalizada(s)?\n\nEsta ação substituirá a base existente com este nome.`
  );
  if (!confirmou) return;

  asstSetImportLoading(true);
  asstSetImportStatus("", "");

  try {
    const csv      = asstGerarCsv(asstUltimosDados.preview);
    const blob     = new Blob([csv], { type: "text/csv" });
    const arquivo  = new File([blob], `${nome.replace(/[^a-z0-9_\-]/gi, "_")}.csv`, { type: "text/csv" });

    const fd = new FormData();
    fd.append("arquivo",   arquivo);
    fd.append("nomeBase",  nome);
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
