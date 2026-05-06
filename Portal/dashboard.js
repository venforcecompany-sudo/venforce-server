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
  const raw = String(base?.marketplace || "").toLowerCase().trim();
  if (raw) {
    const key = raw.includes("shop") ? "shopee" : (raw.includes("meli") || raw.includes("ml") ? "meli" : "outro");
    if (key === "shopee") return { key: "shopee", label: "Shopee" };
    if (key === "meli") return { key: "meli", label: "Mercado Livre" };
    return { key: "outro", label: "Não identificado" };
  }

  const nome = String(base?.nome || "").toLowerCase();
  const slug = String(base?.slug || "").toLowerCase();
  const hay = `${nome} ${slug}`;

  if (/(shopee|\\bshop\\b|\\bspf\\b|seller\\s*shopee)/i.test(hay)) return { key: "shopee", label: "Shopee" };
  if (/(\\bmeli\\b|\\bml\\b|mercado[_\\-\\s]?livre|mercadolivre)/i.test(hay)) return { key: "meli", label: "Mercado Livre" };
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
