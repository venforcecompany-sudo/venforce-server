const API_BASE = "https://venforce-server.onrender.com";
const TOKEN = localStorage.getItem("vf-token");
const user = JSON.parse(localStorage.getItem("vf-user") || "{}");
const role = String(user.role || "").toLowerCase();
const canAccessDesign = role === "admin" || role === "user" || role === "membro";

if (!TOKEN) window.location.replace("index.html");
if (!canAccessDesign) window.location.replace("dashboard.html");
initLayout();

let currentItemId = "";
let currentClienteSlug = "";

function clearSession() {
  localStorage.removeItem("vf-token");
  localStorage.removeItem("vf-user");
  window.location.replace("index.html");
}

function setStatus(msg, color = "var(--vf-text-m)") {
  const el = document.getElementById("design-status");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = color;
  el.style.display = msg ? "block" : "none";
}

function escapeHTML(value) {
  const d = document.createElement("div");
  d.textContent = value == null ? "" : String(value);
  return d.innerHTML;
}

function normalizeItemInput(value) {
  const text = String(value || "").trim().toUpperCase();
  const match = text.match(/MLB\d+|MLBU\d+/);
  return match ? match[0] : text;
}

async function loadClientes() {
  const select = document.getElementById("design-cliente");
  if (!select) return;
  select.disabled = true;
  select.innerHTML = `<option value="">Carregando...</option>`;

  try {
    const res = await fetch(`${API_BASE}/design/clientes`, {
      headers: { Authorization: "Bearer " + TOKEN }
    });

    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json().catch(() => ({}));
    const clientes = Array.isArray(json?.clientes) ? json.clientes : [];
    select.innerHTML = "";
    select.appendChild(new Option("Selecione um cliente…", ""));
    clientes.forEach((c) => {
      const slug = c.slug || "";
      const nome = c.nome || slug || "—";
      select.appendChild(new Option(`${nome} (${slug})`, slug));
    });
    select.disabled = false;
  } catch (err) {
    select.disabled = true;
    select.innerHTML = `<option value="">Erro ao carregar clientes</option>`;
    setStatus("Não foi possível carregar os clientes.", "var(--vf-danger)");
  }
}

function resetResults() {
  const empty = document.getElementById("design-empty");
  const results = document.getElementById("design-results");
  const grid = document.getElementById("design-grid");
  const badge = document.getElementById("design-total");
  const btnDownload = document.getElementById("btn-design-download");

  if (empty) empty.style.display = "block";
  if (results) results.style.display = "none";
  if (grid) grid.innerHTML = "";
  if (badge) badge.style.display = "none";
  if (btnDownload) btnDownload.disabled = true;
}

function renderResults(payload) {
  const empty = document.getElementById("design-empty");
  const results = document.getElementById("design-results");
  const grid = document.getElementById("design-grid");
  const badge = document.getElementById("design-total");
  const btnDownload = document.getElementById("btn-design-download");

  if (empty) empty.style.display = "none";
  if (results) results.style.display = "block";
  if (badge) {
    badge.style.display = "inline-block";
    badge.textContent = String(payload?.total ?? 0);
  }
  if (btnDownload) btnDownload.disabled = !(payload?.total > 0);

  const titleEl = document.getElementById("design-item-title");
  const idEl = document.getElementById("design-item-id");
  const statusEl = document.getElementById("design-item-status");
  if (titleEl) titleEl.textContent = payload?.item?.title || "—";
  if (idEl) idEl.textContent = payload?.item?.id || "—";
  if (statusEl) statusEl.textContent = payload?.item?.status || "—";

  if (!grid) return;
  grid.innerHTML = "";
  const imagens = Array.isArray(payload?.imagens) ? payload.imagens : [];
  imagens.forEach((img) => {
    const card = document.createElement("div");
    card.style.border = "1px solid var(--vf-border)";
    card.style.borderRadius = "12px";
    card.style.padding = "10px";
    card.style.background = "var(--vf-surface)";
    card.innerHTML = `
      <div style="aspect-ratio:1/1;border-radius:10px;overflow:hidden;background:#f7f7f8;display:flex;align-items:center;justify-content:center;">
        <img src="${escapeHTML(img.url)}" alt="Imagem ${escapeHTML(img.index)}" style="max-width:100%;max-height:100%;object-fit:cover;" />
      </div>
      <div style="margin-top:8px;font-size:.82rem;color:var(--vf-text-m);display:flex;justify-content:space-between;gap:8px;">
        <span>#${escapeHTML(img.index)}</span>
        <a href="${escapeHTML(img.url)}" target="_blank" rel="noopener noreferrer">Abrir original</a>
      </div>
    `;
    grid.appendChild(card);
  });
}

async function buscarImagens() {
  const clienteSlug = document.getElementById("design-cliente")?.value || "";
  const itemInput = document.getElementById("design-item")?.value || "";
  const itemId = normalizeItemInput(itemInput);
  const btnBuscar = document.getElementById("btn-design-buscar");

  if (!clienteSlug) {
    setStatus("Selecione um cliente.", "var(--vf-danger)");
    return;
  }
  if (!itemId) {
    setStatus("Informe um ID ou link de anúncio válido.", "var(--vf-danger)");
    return;
  }

  if (btnBuscar) {
    btnBuscar.disabled = true;
    btnBuscar.textContent = "Buscando...";
  }

  try {
    const url = `${API_BASE}/design/anuncios/${encodeURIComponent(itemId)}/imagens?clienteSlug=${encodeURIComponent(clienteSlug)}`;
    const res = await fetch(url, {
      headers: { Authorization: "Bearer " + TOKEN }
    });

    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    currentItemId = itemId;
    currentClienteSlug = clienteSlug;
    renderResults(json);
    setStatus(`Imagens carregadas: ${json.total || 0}.`, "var(--vf-success)");
  } catch (err) {
    resetResults();
    setStatus(err?.message ? `Erro: ${err.message}` : "Erro ao buscar imagens.", "var(--vf-danger)");
  } finally {
    if (btnBuscar) {
      btnBuscar.disabled = false;
      btnBuscar.textContent = "Buscar imagens";
    }
  }
}

async function baixarZip() {
  const btn = document.getElementById("btn-design-download");
  if (!currentItemId || !currentClienteSlug) {
    setStatus("Busque imagens antes de baixar o ZIP.", "var(--vf-danger)");
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Preparando ZIP...";
  }

  try {
    const url = `${API_BASE}/design/anuncios/${encodeURIComponent(currentItemId)}/imagens/download?clienteSlug=${encodeURIComponent(currentClienteSlug)}`;
    const res = await fetch(url, {
      headers: { Authorization: "Bearer " + TOKEN }
    });

    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok || !json?.downloadUrl) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    window.open(API_BASE + json.downloadUrl, "_blank");
    setStatus("ZIP gerado com sucesso.", "var(--vf-success)");
  } catch (err) {
    setStatus(err?.message ? `Erro: ${err.message}` : "Erro ao gerar ZIP.", "var(--vf-danger)");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Baixar ZIP";
    }
  }
}

document.getElementById("btn-design-buscar")?.addEventListener("click", buscarImagens);
document.getElementById("btn-design-download")?.addEventListener("click", baixarZip);

if (TOKEN && canAccessDesign) {
  resetResults();
  loadClientes();
}
