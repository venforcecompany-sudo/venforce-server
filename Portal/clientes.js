const STORAGE_KEY = "vf-token";
const API_BASE = "https://venforce-server.onrender.com";

function getToken() {
  const t = localStorage.getItem(STORAGE_KEY);
  if (!t) { window.location.replace("index.html"); return null; }
  return t;
}
const TOKEN = getToken();
initLayout();

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
  const termo = (document.getElementById("busca-cliente")?.value || "")
    .toLowerCase().trim();

  const linhas = document.querySelectorAll("#clientes-tbody tr");
  let visiveis = 0;

  linhas.forEach((tr) => {
    const texto = tr.textContent.toLowerCase();
    const bate = !termo || texto.includes(termo);
    tr.style.display = bate ? "" : "none";
    if (bate) visiveis++;
  });

  // Atualiza badge com total visível
  const badge = document.getElementById("clientes-count");
  if (badge && badge.style.display !== "none") {
    badge.textContent = String(visiveis);
  }
}

function getMlConectarLink(slug) {
  const base = "https://venforce-server.onrender.com";
  return `${base}/ml/conectar/${encodeURIComponent(slug)}`;
}

function slugify(nome) {
  return String(nome || "")
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

const stateLoading = document.getElementById("state-loading");
const stateTable = document.getElementById("state-table");
const stateEmpty = document.getElementById("state-empty");
const stateError = document.getElementById("state-error");
const clientesCount = document.getElementById("clientes-count");
const clientesTbody = document.getElementById("clientes-tbody");

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

function setFormStatus(msg, color) {
  const el = document.getElementById("cliente-status");
  el.textContent = msg || "";
  el.style.color = color || "var(--vf-text-m)";
  el.style.display = msg ? "block" : "none";
}

async function loadClientes() {
  if (!TOKEN) return;
  showLoading();
  try {
    const res = await fetch(`${API_BASE}/clientes`, {
      headers: { Authorization: "Bearer " + TOKEN }
    });
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json().catch(() => ({}));
    const clientes = Array.isArray(data.clientes) ? data.clientes : (Array.isArray(data) ? data : []);
    renderClientes(clientes);
  } catch (err) {
    showError("Não foi possível carregar os clientes. Tente novamente.");
  }
}

function renderClientes(clientes) {
  clientesTbody.innerHTML = "";
  if (!clientes.length) { showEmpty(); return; }

  clientesCount.textContent = String(clientes.length);
  clientesCount.style.display = "inline-block";

  clientes.forEach((c, i) => {
    const ativo = c.ativo !== false;
    const apiKey = c.apiKey || c.api_key || c.api_key_plain || c.key || "";
    const apiKeyMasked = apiKey ? `${String(apiKey).slice(0, 8)}••••••••` : "—";

    const tr = document.createElement("tr");
    tr.classList.add("animate-fade-up");
    tr.style.animationDelay = `${i * 0.04}s`;

    tr.innerHTML = `
      <td style="color:var(--vf-text-l);font-family:var(--vf-mono);font-size:.8rem;">${String(i + 1).padStart(2, "0")}</td>
      <td><strong>${escapeHTML(c.nome || "—")}</strong></td>
      <td style="color:var(--vf-text-m);font-size:.875rem;font-family:var(--vf-mono);">${escapeHTML(c.slug || "—")}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;">
          <span style="font-family:var(--vf-mono);font-size:.8rem;color:var(--vf-text-m);">${escapeHTML(apiKeyMasked)}</span>
          <button type="button" data-action="copy" data-apikey="${escapeHTML(apiKey)}"
            title="Copiar API key"
            style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;border:1px solid var(--vf-border);background:var(--vf-bg);color:var(--vf-text-m);cursor:pointer;">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
        </div>
      </td>
      <td style="text-align:center;">
        <span class="${ativo ? "base-status--active" : "base-status--inactive"}">${ativo ? "Ativo" : "Inativo"}</span>
      </td>
      <td id="ml-cell-${escapeHTML(c.slug || "")}" style="text-align:center;">
        <span style="color:var(--vf-text-l);font-size:.8rem;">…</span>
      </td>
      <td style="text-align:center;">
        <button class="vf-btn-danger-sm" data-action="delete" data-slug="${escapeHTML(c.slug || "")}">Excluir</button>
      </td>
    `;

    clientesTbody.appendChild(tr);
  });

  clientesTbody.querySelectorAll('button[data-action="copy"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const apiKey = btn.getAttribute("data-apikey") || "";
      if (!apiKey) return;
      try {
        await navigator.clipboard.writeText(apiKey);
        const old = btn.innerHTML;
        btn.innerHTML = `<span style="font-size:.75rem;font-weight:600;color:var(--vf-success);">Copiado!</span>`;
        btn.style.borderColor = "rgba(4,120,87,.25)";
        btn.style.background = "#f0fdf4";
        setTimeout(() => {
          btn.innerHTML = old;
          btn.style.borderColor = "var(--vf-border)";
          btn.style.background = "var(--vf-bg)";
        }, 900);
      } catch {
        alert("Não foi possível copiar.");
      }
    });
  });

  clientesTbody.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const slug = btn.getAttribute("data-slug") || "";
      if (!slug) return;
      if (confirm(`Excluir permanentemente o cliente "${slug}"?\n\nEsta ação não pode ser desfeita.`)) {
        deleteCliente(slug, btn);
      }
    });
  });


showTable();
const buscaAtiva = document.getElementById("busca-cliente");
if (buscaAtiva) buscaAtiva.value = "";
// Disparar fetches de status ML em paralelo, sem bloquear a renderização
clientes.forEach(c => fetchMlStatus(c.slug || ""));
}
 
async function fetchMlStatus(slug) {
  const cell = document.getElementById(`ml-cell-${slug}`);
  if (!cell) return;
  try {
    const res = await fetch(`${API_BASE}/clientes/${encodeURIComponent(slug)}/ml-status`, {
      headers: { Authorization: "Bearer " + TOKEN }
    });
    if (!res.ok) {
      cell.innerHTML = `<span style="color:var(--vf-text-l);font-size:.8rem;">—</span>`;
      return;
    }
    const data = await res.json();
    if (data.conectado) {
      cell.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;justify-content:center;">
          <span class="base-status--active">Conectado</span>
          <button type="button" class="vf-btn-danger-sm" data-action="ml-desconectar"
            data-slug="${escapeHTML(slug)}" style="font-size:.7rem;padding:2px 8px;">Desvincular</button>
        </div>`;
      cell.querySelector('[data-action="ml-desconectar"]').addEventListener("click", () => {
        if (confirm(`Desvincular conta ML do cliente "${slug}"?`)) desvincularMl(slug, cell);
      });
    } else {
      const link = getMlConectarLink(slug);
      cell.innerHTML = `
  <div style="display:flex;align-items:center;gap:6px;justify-content:center;">
    <a href="${link}" target="_blank" class="vf-btn-secondary"
      style="font-size:.75rem;padding:4px 12px;text-decoration:none;display:inline-block;">
      Conectar ML
    </a>
    <button type="button"
      data-action="copy-ml-link"
      data-link="${escapeHTML(link)}"
      data-slug="${escapeHTML(slug)}"
      class="vf-btn-secondary"
      style="font-size:.75rem;padding:4px 10px;">
      Copiar link
    </button>
  </div>`;

// Bind do botão copiar imediatamente após setar innerHTML
const copyBtn = cell.querySelector('[data-action="copy-ml-link"]');
if (copyBtn) {
  copyBtn.addEventListener("click", async () => {
    const url = copyBtn.getAttribute("data-link") || "";
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      const prev = copyBtn.textContent;
      copyBtn.textContent = "Copiado!";
      copyBtn.style.color = "var(--vf-success)";
      copyBtn.style.borderColor = "rgba(4,120,87,.25)";
      setTimeout(() => {
        copyBtn.textContent = prev;
        copyBtn.style.color = "";
        copyBtn.style.borderColor = "";
      }, 2000);
    } catch {
      alert("Não foi possível copiar o link.");
    }
  });
}
    }
  } catch {
    cell.innerHTML = `<span style="color:var(--vf-text-l);font-size:.8rem;">—</span>`;
  }
}
 
async function desvincularMl(slug, cell) {
  cell.innerHTML = `<span style="color:var(--vf-text-l);font-size:.8rem;">Desvinculando…</span>`;
  try {
    const res = await fetch(`${API_BASE}/clientes/${encodeURIComponent(slug)}/ml-token`, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + TOKEN }
    });
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.erro || `HTTP ${res.status}`);
    }
    fetchMlStatus(slug);
  } catch (err) {
    alert("Erro ao desvincular: " + err.message);
    fetchMlStatus(slug);
  }
}
async function deleteCliente(slug, btn) {
  btn.disabled = true;
  btn.textContent = "Excluindo…";
  try {
    const res = await fetch(`${API_BASE}/clientes/${encodeURIComponent(slug)}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + TOKEN }
    });
    if (res.status === 401) { clearSession(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);
    loadClientes();
  } catch (err) {
    alert("Erro ao excluir: " + err.message);
    btn.disabled = false;
    btn.textContent = "Excluir";
  }
}

async function createCliente() {
  const nomeEl = document.getElementById("cliente-nome");
  const slugEl = document.getElementById("cliente-slug");
  const nome = nomeEl.value.trim();
  const slug = slugEl.value.trim();

  setFormStatus("", "");
  if (!nome) { setFormStatus("Informe o nome do cliente.", "var(--vf-danger)"); return; }
  if (!slug) { setFormStatus("Informe o slug do cliente.", "var(--vf-danger)"); return; }

  setCreateLoading(true);
  try {
    const res = await fetch(`${API_BASE}/clientes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + TOKEN
      },
      body: JSON.stringify({ nome, slug })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { clearSession(); return; }
    if (!res.ok) throw new Error(data.erro || `HTTP ${res.status}`);

    nomeEl.value = "";
    slugEl.value = "";
    setFormStatus("✓ Cliente criado com sucesso.", "var(--vf-success)");
    loadClientes();
  } catch (err) {
    setFormStatus("Erro ao criar: " + err.message, "var(--vf-danger)");
  } finally {
    setCreateLoading(false);
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

const buscaInput = document.getElementById("busca-cliente");
if (buscaInput) {
  let debounceTimer;
  buscaInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(filtrarClientes, 300);
  });
}

if (TOKEN) loadClientes();

