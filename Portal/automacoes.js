const STORAGE_KEY = "vf-token";
const API_BASE = "https://venforce-server.onrender.com";

function getToken() {
  const t = localStorage.getItem(STORAGE_KEY);
  if (!t) { window.location.replace("index.html"); return null; }
  return t;
}

const TOKEN = getToken();
const user = JSON.parse(localStorage.getItem("vf-user") || "{}");
if (user.role !== "admin") window.location.replace("dashboard.html");
initLayout();

let ALL_CLIENTES = [];
let PREVIEW_ML_PAGE = 1;
const PREVIEW_ML_LIMIT = 20;

function clearSession() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem("vf-user");
  window.location.replace("index.html");
}

function setStatus(msg, color) {
  const el = document.getElementById("automacoes-status");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = color || "var(--vf-text-m)";
  el.style.display = msg ? "block" : "none";
}

function escapeHTML(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function setClientesOptions(select, clientes) {
  if (!select) return;
  select.innerHTML = "";
  select.appendChild(new Option("Selecione um cliente…", ""));

  (Array.isArray(clientes) ? clientes : []).forEach((c) => {
    const slug = c.slug || "";
    const nome = c.nome || slug || "—";
    const opt = new Option(`${nome} (${slug})`, slug);
    select.appendChild(opt);
  });
}

function applyClienteSearchFilter({ keepValueIfPossible = true } = {}) {
  const input = document.getElementById("automacoes-cliente-search");
  const select = document.getElementById("automacoes-cliente");
  if (!select) return;

  const q = (input?.value || "").trim().toLowerCase();
  const filtered = !q
    ? ALL_CLIENTES
    : ALL_CLIENTES.filter((c) => {
        const nome = (c?.nome || "").toString().toLowerCase();
        const slug = (c?.slug || "").toString().toLowerCase();
        return nome.includes(q) || slug.includes(q);
      });

  const currentValue = select.value || "";
  setClientesOptions(select, filtered);

  if (keepValueIfPossible && currentValue) {
    const stillThere = filtered.some((c) => (c?.slug || "") === currentValue);
    if (stillThere) {
      select.value = currentValue;
    } else {
      select.value = "";
      setStatus("Cliente atual não está no filtro. Selecione um cliente.", "var(--vf-text-m)");
    }
  }
}

function setBasesOptions(select, bases) {
  if (!select) return;
  select.innerHTML = "";
  select.appendChild(new Option("Selecione uma base…", ""));

  (Array.isArray(bases) ? bases : []).forEach((b) => {
    const slug = b.slug || "";
    const nome = b.nome || slug || "—";
    const opt = new Option(`${nome} (${slug})`, slug);
    select.appendChild(opt);
  });
}

async function loadClientes() {
  if (!TOKEN) return;

  const select = document.getElementById("automacoes-cliente");
  if (select) {
    select.disabled = true;
    select.innerHTML = `<option value="">Carregando...</option>`;
  }

  setStatus("", "");

  try {
    const res = await fetch(`${API_BASE}/clientes`, {
      headers: { Authorization: "Bearer " + TOKEN }
    });

    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json().catch(() => ({}));
    const clientes = Array.isArray(data.clientes) ? data.clientes : (Array.isArray(data) ? data : []);

    ALL_CLIENTES = clientes;
    applyClienteSearchFilter({ keepValueIfPossible: false });
    if (select) select.disabled = false;

    if (!clientes.length) {
      setStatus("Nenhum cliente encontrado.", "var(--vf-text-m)");
    }
  } catch (err) {
    ALL_CLIENTES = [];
    if (select) {
      select.disabled = true;
      select.innerHTML = `<option value="">Erro ao carregar clientes</option>`;
    }
    setStatus("Não foi possível carregar os clientes. Tente novamente.", "var(--vf-danger)");
  }
}

async function loadBases() {
  if (!TOKEN) return;

  const select = document.getElementById("automacoes-base");
  if (select) {
    select.disabled = true;
    select.innerHTML = `<option value="">Carregando...</option>`;
  }

  try {
    const res = await fetch(`${API_BASE}/bases`, {
      headers: { Authorization: "Bearer " + TOKEN }
    });

    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json().catch(() => ({}));
    const bases = Array.isArray(data.bases) ? data.bases : (Array.isArray(data) ? data : []);

    setBasesOptions(select, bases);
    if (select) select.disabled = false;
  } catch (err) {
    if (select) {
      select.disabled = true;
      select.innerHTML = `<option value="">Erro ao carregar bases</option>`;
    }
    setStatus("Não foi possível carregar as bases. Tente novamente.", "var(--vf-danger)");
  }
}

function setPreviewState({ clienteLabel, baseLabel, totalItens, itensPreview }) {
  const empty = document.getElementById("precificacao-preview-empty");
  const box = document.getElementById("precificacao-preview-box");
  const badge = document.getElementById("precificacao-total");

  if (empty) empty.style.display = "none";
  if (box) box.style.display = "block";
  if (badge) {
    badge.style.display = "inline-block";
    badge.textContent = String(totalItens ?? 0);
  }

  const clienteEl = document.getElementById("precificacao-cliente");
  const baseEl = document.getElementById("precificacao-base");
  if (clienteEl) clienteEl.textContent = clienteLabel || "—";
  if (baseEl) baseEl.textContent = baseLabel || "—";

  const tbody = document.getElementById("precificacao-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const rows = Array.isArray(itensPreview) ? itensPreview : [];
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4" style="color:var(--vf-text-m);">Base sem itens de custo.</td>`;
    tbody.appendChild(tr);
    return;
  }

  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(r.produto_id ?? r.id ?? "—")}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(r.custo_produto ?? 0))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(r.imposto_percentual ?? 0))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(r.taxa_fixa ?? 0))}</td>
    `;
    tbody.appendChild(tr);
  });
}

function setPreviewMlState({ page, totalItensMl, linhas }) {
  const empty = document.getElementById("precificacao-ml-preview-empty");
  const box = document.getElementById("precificacao-ml-preview-box");
  const badge = document.getElementById("precificacao-ml-total");
  const pageEl = document.getElementById("precificacao-ml-page");
  const prevBtn = document.getElementById("btn-precificacao-ml-prev");
  const nextBtn = document.getElementById("btn-precificacao-ml-next");

  if (empty) empty.style.display = "none";
  if (box) box.style.display = "block";

  const total = Number(totalItensMl ?? 0) || 0;
  const p = Number(page ?? 1) || 1;
  const totalPages = Math.max(1, Math.ceil(total / PREVIEW_ML_LIMIT));

  if (badge) {
    badge.style.display = "inline-block";
    badge.textContent = String(total);
  }
  if (pageEl) pageEl.textContent = `Página ${p} de ${totalPages}`;
  if (prevBtn) prevBtn.disabled = p <= 1;
  if (nextBtn) nextBtn.disabled = p >= totalPages;

  const tbody = document.getElementById("precificacao-ml-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const rows = Array.isArray(linhas) ? linhas : [];
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="9" style="color:var(--vf-text-m);">Nenhum item encontrado nesta página.</td>`;
    tbody.appendChild(tr);
    return;
  }

  rows.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(r.item_id ?? "—")}</td>
      <td style="max-width:420px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHTML(r.titulo ?? "")}">${escapeHTML(r.titulo ?? "—")}</td>
      <td>${escapeHTML(r.status ?? "—")}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(r.precoVendaAtual ?? "—")}</td>
      <td style="font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(r.listing_type_id ?? r.tipoAnuncio ?? "—")}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(r.custoProduto ?? "—")}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(r.impostoPercentual ?? "—")}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(r.taxaFixa ?? "—")}</td>
      <td>${r.temBase ? "Sim" : "Não"}</td>
    `;
    tbody.appendChild(tr);
  });
}

function resetPreviewMlUI() {
  const empty = document.getElementById("precificacao-ml-preview-empty");
  const box = document.getElementById("precificacao-ml-preview-box");
  const badge = document.getElementById("precificacao-ml-total");
  const pageEl = document.getElementById("precificacao-ml-page");
  const prevBtn = document.getElementById("btn-precificacao-ml-prev");
  const nextBtn = document.getElementById("btn-precificacao-ml-next");
  const tbody = document.getElementById("precificacao-ml-tbody");

  if (empty) empty.style.display = "block";
  if (box) box.style.display = "none";
  if (badge) badge.style.display = "none";
  if (pageEl) pageEl.textContent = "Página 1";
  if (prevBtn) prevBtn.disabled = true;
  if (nextBtn) nextBtn.disabled = true;
  if (tbody) tbody.innerHTML = "";
}

async function previewPrecificacao() {
  if (!TOKEN) return;

  const clienteSlug = document.getElementById("automacoes-cliente")?.value || "";
  const baseSlug = document.getElementById("automacoes-base")?.value || "";

  if (!clienteSlug) {
    setStatus("Selecione um cliente para pré-visualizar a precificação.", "var(--vf-danger)");
    return;
  }
  if (!baseSlug) {
    setStatus("Selecione uma base para pré-visualizar a precificação.", "var(--vf-danger)");
    return;
  }

  const btn = document.getElementById("btn-precificacao-preview");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Carregando...";
  }

  try {
    const qs = new URLSearchParams({ clienteSlug, baseSlug });
    const res = await fetch(`${API_BASE}/automacoes/precificacao/preview?${qs.toString()}`, {
      headers: { Authorization: "Bearer " + TOKEN }
    });

    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    const clienteLabel =
      (json?.cliente?.nome && json?.cliente?.slug)
        ? `${json.cliente.nome} (${json.cliente.slug})`
        : (json?.cliente?.slug || clienteSlug);
    const baseLabel =
      (json?.base?.nome && json?.base?.slug)
        ? `${json.base.nome} (${json.base.slug})`
        : (json?.base?.slug || baseSlug);

    setPreviewState({
      clienteLabel,
      baseLabel,
      totalItens: json.totalItens ?? 0,
      itensPreview: json.itensPreview ?? [],
    });

    setStatus(`Preview carregado. Itens na base: ${json.totalItens ?? 0}.`, "var(--vf-success)");
  } catch (err) {
    setStatus(err?.message ? `Erro: ${err.message}` : "Erro ao gerar preview.", "var(--vf-danger)");
    setPreviewState({
      clienteLabel: clienteSlug,
      baseLabel: baseSlug,
      totalItens: 0,
      itensPreview: [],
    });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Pré-visualizar";
    }
  }
}

async function previewPrecificacaoMl() {
  if (!TOKEN) return;

  const clienteSlug = document.getElementById("automacoes-cliente")?.value || "";
  const baseSlug = document.getElementById("automacoes-base")?.value || "";

  if (!clienteSlug) {
    setStatus("Selecione um cliente para gerar a prévia com dados do ML.", "var(--vf-danger)");
    return;
  }
  if (!baseSlug) {
    setStatus("Selecione uma base para gerar a prévia com dados do ML.", "var(--vf-danger)");
    return;
  }

  const btn = document.getElementById("btn-precificacao-preview-ml");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Carregando...";
  }

  try {
    const qs = new URLSearchParams({
      clienteSlug,
      baseSlug,
      page: String(PREVIEW_ML_PAGE),
      limit: String(PREVIEW_ML_LIMIT),
    });
    const res = await fetch(`${API_BASE}/automacoes/precificacao/preview-ml?${qs.toString()}`, {
      headers: { Authorization: "Bearer " + TOKEN }
    });

    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    setPreviewMlState({
      page: json.page ?? PREVIEW_ML_PAGE,
      totalItensMl: json.totalItensMl ?? 0,
      linhas: json.linhas ?? [],
    });

    setStatus("Prévia com dados do Mercado Livre carregada (somente leitura).", "var(--vf-success)");
  } catch (err) {
    resetPreviewMlUI();
    setStatus(err?.message ? `Erro: ${err.message}` : "Erro ao gerar prévia com dados do ML.", "var(--vf-danger)");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Prévia com dados ML";
    }
  }
}

document.getElementById("automacoes-cliente")?.addEventListener("change", (e) => {
  const slug = e.target.value || "";
  if (!slug) {
    setStatus("Selecione um cliente para preparar o contexto.", "var(--vf-text-m)");
    return;
  }
  setStatus(`Cliente selecionado: ${escapeHTML(slug)} (ações: em breve)`, "var(--vf-success)");
});

document.getElementById("automacoes-cliente-search")?.addEventListener("input", () => {
  applyClienteSearchFilter({ keepValueIfPossible: true });
});

document.getElementById("btn-precificacao-preview")?.addEventListener("click", previewPrecificacao);
document.getElementById("btn-precificacao-preview-ml")?.addEventListener("click", () => {
  PREVIEW_ML_PAGE = 1;
  previewPrecificacaoMl();
});
document.getElementById("btn-precificacao-ml-prev")?.addEventListener("click", () => {
  PREVIEW_ML_PAGE = Math.max(1, PREVIEW_ML_PAGE - 1);
  previewPrecificacaoMl();
});
document.getElementById("btn-precificacao-ml-next")?.addEventListener("click", () => {
  PREVIEW_ML_PAGE = PREVIEW_ML_PAGE + 1;
  previewPrecificacaoMl();
});

if (TOKEN) {
  loadClientes();
  loadBases();
}

