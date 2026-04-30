const STORAGE_KEY = "vf-token";
const API_BASE = "https://venforce-server.onrender.com";

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

let TODOS_RELATORIOS = [];
let RELATORIOS_FILTRADOS = [];
let RELATORIO_DETALHE_ATUAL_ID = null;
let CLIENTES_CACHE = [];
let PASTAS = [];
let PASTA_SELECIONADA = "todos";
let DETALHE_ITENS = [];
let DETALHE_FILTRO_ATIVO = "todos";
let DETALHE_BUSCA = "";
const DETALHE_FILTROS_RAPIDOS = [
  { key: "todos", label: "Todos" },
  { key: "critico", label: "Críticos" },
  { key: "atencao", label: "Atenção" },
  { key: "saudavel", label: "Saudáveis" },
  { key: "sem_base", label: "Sem base" },
  { key: "sem_frete", label: "Sem frete" },
  { key: "sem_comissao", label: "Sem comissão" },
];

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

function setFeedback(message, color = "var(--vf-text-m)") {
  const el = document.getElementById("relatorios-feedback");
  if (!el) return;
  el.textContent = message || "";
  el.style.color = color;
  el.style.display = message ? "block" : "none";
}

function formatarDataRelatorio(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch (_) {
    return String(iso);
  }
}

function formatarMargemAlvo(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return `${(n * 100).toFixed(2)}%`;
}

function formatarMcMedia(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(2)}%`;
}

function classeStatus(status) {
  switch (String(status || "").toLowerCase()) {
    case "concluido":
      return "vf-ml-badge-success";
    case "processando":
      return "vf-ml-badge-warning";
    case "erro":
      return "vf-ml-badge-danger";
    default:
      return "vf-ml-badge-neutral";
  }
}

function diagnosticoItemSalvo(item) {
  const temBase = item?.tem_base === true || item?.tem_base === 1 || item?.tem_base === "1";
  const freteNum = Number(item?.frete);
  const comissaoNum = Number(item?.comissao);

  if (!temBase) return { key: "sem_base", label: "Sem base", tone: "neutral" };
  if (!Number.isFinite(freteNum)) return { key: "sem_frete", label: "Sem frete", tone: "warning" };
  if (!Number.isFinite(comissaoNum)) return { key: "sem_comissao", label: "Sem comissão", tone: "warning" };

  const raw = String(item?.diagnostico || "").toLowerCase();
  if (raw === "critico") return { key: "critico", label: "Crítico", tone: "danger" };
  if (raw === "atencao") return { key: "atencao", label: "Atenção", tone: "warning" };
  if (raw === "saudavel") return { key: "saudavel", label: "Saudável", tone: "success" };

  return { key: raw || "sem_dados", label: raw || "Sem dados", tone: "neutral" };
}

function setListState(state, message = "") {
  const loading = document.getElementById("relatorios-loading");
  const error = document.getElementById("relatorios-erro");
  const empty = document.getElementById("relatorios-vazio");
  const wrapper = document.getElementById("relatorios-wrapper");
  const badge = document.getElementById("relatorios-total");
  if (!loading || !error || !empty || !wrapper || !badge) return;

  loading.style.display = state === "loading" ? "block" : "none";
  error.style.display = state === "error" ? "block" : "none";
  empty.style.display = state === "empty" ? "block" : "none";
  wrapper.style.display = state === "table" ? "block" : "none";

  if (state === "error" && message) {
    error.innerHTML = `<p style="color:var(--vf-danger);">${escapeHTML(message)}</p>`;
  }
  if (state === "empty" && message) {
    empty.innerHTML = `<p>${escapeHTML(message)}</p>`;
  }

  if (state === "loading" || state === "error") {
    badge.style.display = "none";
  }
}

function getContagemRelatoriosPorPasta() {
  const mapa = new Map();
  let semPasta = 0;
  (Array.isArray(TODOS_RELATORIOS) ? TODOS_RELATORIOS : []).forEach((r) => {
    const pastaId = Number(r?.pasta_id);
    if (Number.isFinite(pastaId) && pastaId > 0) {
      mapa.set(pastaId, (mapa.get(pastaId) || 0) + 1);
    } else {
      semPasta += 1;
    }
  });
  return { mapa, semPasta, total: TODOS_RELATORIOS.length };
}

function selecionarPasta(pastaId) {
  PASTA_SELECIONADA = pastaId;
  renderPastas();
  filtrarRelatorios();
}

function renderPastas() {
  const container = document.getElementById("relatorios-pastas-lista");
  if (!container) return;

  const { mapa, semPasta, total } = getContagemRelatoriosPorPasta();
  const pastas = Array.isArray(PASTAS) ? PASTAS : [];

  const htmlItens = [];
  htmlItens.push(`
    <button type="button" class="vf-relatorio-pasta-item ${PASTA_SELECIONADA === "todos" ? "is-active" : ""}" data-pasta-filter="todos">
      <span>Todos</span>
      <span class="vf-relatorio-pasta-count">${total}</span>
    </button>
  `);
  htmlItens.push(`
    <button type="button" class="vf-relatorio-pasta-item ${PASTA_SELECIONADA === "sem_pasta" ? "is-active" : ""}" data-pasta-filter="sem_pasta">
      <span>Sem pasta</span>
      <span class="vf-relatorio-pasta-count">${semPasta}</span>
    </button>
  `);

  pastas.forEach((pasta) => {
    const id = Number(pasta.id);
    const active = PASTA_SELECIONADA === id ? "is-active" : "";
    const count = mapa.get(id) || 0;
    htmlItens.push(`
      <div class="vf-relatorio-pasta-row ${active}">
        <button type="button" class="vf-relatorio-pasta-item" data-pasta-filter="${id}">
          <span>${escapeHTML(pasta.nome || "Pasta")}</span>
          <span class="vf-relatorio-pasta-count">${count}</span>
        </button>
        <div class="vf-relatorio-pasta-actions">
          <button type="button" class="vf-relatorio-pasta-action" data-pasta-rename="${id}" title="Renomear">✎</button>
          <button type="button" class="vf-relatorio-pasta-action" data-pasta-delete="${id}" title="Excluir">🗑</button>
        </div>
      </div>
    `);
  });

  container.innerHTML = htmlItens.join("");

  container.querySelectorAll("[data-pasta-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const raw = btn.getAttribute("data-pasta-filter");
      if (raw === "todos" || raw === "sem_pasta") {
        selecionarPasta(raw);
        return;
      }
      const id = Number(raw);
      if (Number.isFinite(id) && id > 0) selecionarPasta(id);
    });
  });

  container.querySelectorAll("[data-pasta-rename]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = Number(btn.getAttribute("data-pasta-rename"));
      if (!Number.isFinite(id) || id <= 0) return;
      renomearPasta(id);
    });
  });

  container.querySelectorAll("[data-pasta-delete]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = Number(btn.getAttribute("data-pasta-delete"));
      if (!Number.isFinite(id) || id <= 0) return;
      excluirPasta(id);
    });
  });
}

function preencherFiltroCliente() {
  const select = document.getElementById("filtro-cliente");
  if (!select) return;

  const valorAtual = select.value;
  const slugsDaLista = new Set(
    (Array.isArray(TODOS_RELATORIOS) ? TODOS_RELATORIOS : [])
      .map((r) => String(r.cliente_slug || "").trim())
      .filter(Boolean)
  );

  const baseClientes = Array.isArray(CLIENTES_CACHE) ? CLIENTES_CACHE : [];
  const mapaClientes = new Map();
  baseClientes.forEach((c) => {
    const slug = String(c.slug || "").trim();
    if (!slug) return;
    mapaClientes.set(slug, c.nome || slug);
  });
  slugsDaLista.forEach((slug) => {
    if (!mapaClientes.has(slug)) mapaClientes.set(slug, slug);
  });

  const itens = Array.from(mapaClientes.entries())
    .map(([slug, nome]) => ({ slug, nome }))
    .sort((a, b) => a.slug.localeCompare(b.slug, "pt-BR"));

  select.innerHTML = `<option value="">Todos</option>`;
  itens.forEach((item) => {
    const opt = new Option(`${item.nome} (${item.slug})`, item.slug);
    select.appendChild(opt);
  });

  if (valorAtual && itens.some((i) => i.slug === valorAtual)) {
    select.value = valorAtual;
  }
}

async function carregarClientesParaFiltro() {
  if (!TOKEN) return;

  try {
    const res = await fetch(`${API_BASE}/automacoes/clientes`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });

    if (res.status === 401) {
      clearSession();
      return;
    }
    if (res.status === 403) {
      window.location.replace("dashboard.html");
      return;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json().catch(() => ({}));
    CLIENTES_CACHE = Array.isArray(json.clientes)
      ? json.clientes
      : (Array.isArray(json) ? json : []);
  } catch (_) {
    CLIENTES_CACHE = [];
  } finally {
    preencherFiltroCliente();
  }
}

async function carregarPastas() {
  if (!TOKEN) return;
  try {
    const res = await fetch(`${API_BASE}/relatorios/pastas`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) {
      clearSession();
      return;
    }
    if (res.status === 403) {
      window.location.replace("dashboard.html");
      return;
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    PASTAS = Array.isArray(json.pastas) ? json.pastas : [];
    if (typeof PASTA_SELECIONADA === "number") {
      const existe = PASTAS.some((p) => Number(p.id) === PASTA_SELECIONADA);
      if (!existe) PASTA_SELECIONADA = "todos";
    }
    renderPastas();
  } catch (err) {
    PASTAS = [];
    renderPastas();
    setFeedback(`Erro ao carregar pastas: ${err?.message || "desconhecido"}`, "var(--vf-danger)");
  }
}

async function criarPasta() {
  if (!TOKEN) return;
  const nome = window.prompt("Nome da nova pasta:");
  if (nome == null) return;
  const nomeTrim = String(nome).trim();
  if (!nomeTrim) {
    setFeedback("O nome da pasta é obrigatório.", "var(--vf-danger)");
    return;
  }
  const descricaoInput = window.prompt("Descrição da pasta (opcional):", "");
  if (descricaoInput == null) return;
  const descricaoTrim = String(descricaoInput).trim();

  try {
    const res = await fetch(`${API_BASE}/relatorios/pastas`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        nome: nomeTrim,
        descricao: descricaoTrim || null,
      }),
    });
    if (res.status === 401) {
      clearSession();
      return;
    }
    if (res.status === 403) {
      window.location.replace("dashboard.html");
      return;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }
    setFeedback(`Pasta "${nomeTrim}" criada com sucesso.`, "var(--vf-success)");
    await carregarPastas();
  } catch (err) {
    setFeedback(`Erro ao criar pasta: ${err?.message || "desconhecido"}`, "var(--vf-danger)");
  }
}

async function renomearPasta(id) {
  if (!TOKEN) return;
  const pasta = (Array.isArray(PASTAS) ? PASTAS : []).find((p) => Number(p.id) === Number(id));
  if (!pasta) return;

  const novoNome = window.prompt("Novo nome da pasta:", pasta.nome || "");
  if (novoNome == null) return;
  const nomeTrim = String(novoNome).trim();
  if (!nomeTrim) {
    setFeedback("O nome da pasta é obrigatório.", "var(--vf-danger)");
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/relatorios/pastas/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer " + TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nome: nomeTrim }),
    });
    if (res.status === 401) {
      clearSession();
      return;
    }
    if (res.status === 403) {
      window.location.replace("dashboard.html");
      return;
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }
    setFeedback("Pasta renomeada com sucesso.", "var(--vf-success)");
    await carregarPastas();
  } catch (err) {
    setFeedback(`Erro ao renomear pasta: ${err?.message || "desconhecido"}`, "var(--vf-danger)");
  }
}

async function excluirPasta(id) {
  if (!TOKEN) return;
  const pasta = (Array.isArray(PASTAS) ? PASTAS : []).find((p) => Number(p.id) === Number(id));
  const nome = pasta?.nome || `#${id}`;

  const confirmar = window.confirm(`Excluir a pasta "${nome}"?`);
  if (!confirmar) return;

  try {
    const res = await fetch(`${API_BASE}/relatorios/pastas/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) {
      clearSession();
      return;
    }
    if (res.status === 403) {
      window.location.replace("dashboard.html");
      return;
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      const msg = String(json?.erro || `HTTP ${res.status}`);
      if (msg.includes("Não é possível excluir uma pasta com relatórios")) {
        throw new Error("Essa pasta ainda possui relatórios. Mova ou remova os relatórios antes de excluir.");
      }
      throw new Error(msg);
    }

    if (PASTA_SELECIONADA === Number(id)) {
      PASTA_SELECIONADA = "todos";
    }
    setFeedback("Pasta excluída com sucesso.", "var(--vf-success)");
    await carregarPastas();
    filtrarRelatorios();
  } catch (err) {
    setFeedback(`Erro ao excluir pasta: ${err?.message || "desconhecido"}`, "var(--vf-danger)");
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

    if (res.status === 401) {
      clearSession();
      return;
    }
    if (res.status === 403) {
      window.location.replace("dashboard.html");
      return;
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    TODOS_RELATORIOS = Array.isArray(json.relatorios) ? json.relatorios : [];
    preencherFiltroCliente();
    renderPastas();
    filtrarRelatorios();
  } catch (err) {
    TODOS_RELATORIOS = [];
    RELATORIOS_FILTRADOS = [];
    renderPastas();
    setListState("error", `Erro ao carregar relatórios: ${err?.message || "desconhecido"}`);
  }
}

function filtrarRelatorios() {
  const busca = (document.getElementById("filtro-busca")?.value || "").trim().toLowerCase();
  const cliente = (document.getElementById("filtro-cliente")?.value || "").trim().toLowerCase();
  const escopo = (document.getElementById("filtro-escopo")?.value || "").trim().toLowerCase();
  const status = (document.getElementById("filtro-status")?.value || "").trim().toLowerCase();

  RELATORIOS_FILTRADOS = TODOS_RELATORIOS.filter((r) => {
    const idTxt = String(r.id || "");
    const clienteSlug = String(r.cliente_slug || "").toLowerCase();
    const baseSlug = String(r.base_slug || "").toLowerCase();
    const escopoTxt = String(r.escopo || "").toLowerCase();
    const statusTxt = String(r.status || "").toLowerCase();
    const pastaIdNum = Number(r.pasta_id);

    if (PASTA_SELECIONADA === "sem_pasta") {
      if (Number.isFinite(pastaIdNum) && pastaIdNum > 0) return false;
    } else if (typeof PASTA_SELECIONADA === "number" && Number.isFinite(PASTA_SELECIONADA)) {
      if (!Number.isFinite(pastaIdNum) || pastaIdNum !== PASTA_SELECIONADA) return false;
    }

    if (cliente && clienteSlug !== cliente) return false;
    if (escopo && escopoTxt !== escopo) return false;
    if (status && statusTxt !== status) return false;

    if (busca) {
      const haystack = `${idTxt} ${clienteSlug} ${baseSlug} ${escopoTxt}`;
      if (!haystack.includes(busca)) return false;
    }

    return true;
  });

  renderRelatorios();
}

function renderRelatorios() {
  const tbody = document.getElementById("relatorios-tbody");
  const badge = document.getElementById("relatorios-total");
  if (!tbody || !badge) return;

  tbody.innerHTML = "";
  badge.style.display = "inline-block";
  badge.textContent = String(RELATORIOS_FILTRADOS.length);

  if (!RELATORIOS_FILTRADOS.length) {
    setListState("empty", "Nenhum relatório encontrado");
    return;
  }

  setListState("table");

  const opcoesPastasHtml = (Array.isArray(PASTAS) ? PASTAS : [])
    .map((p) => `<option value="${escapeHTML(String(p.id))}">${escapeHTML(p.nome || `Pasta ${p.id}`)}</option>`)
    .join("");

  RELATORIOS_FILTRADOS.forEach((r) => {
    const mcNum = Number(r.mc_media);
    const mcStyle = Number.isFinite(mcNum)
      ? (mcNum < 0 ? "color:var(--vf-danger);" : (mcNum > 0 ? "color:var(--vf-success);" : ""))
      : "";
    const pastaAtual = Number(r.pasta_id);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-family:var(--vf-mono);font-size:.8rem;">#${escapeHTML(String(r.id || "—"))}</td>
      <td>${escapeHTML(formatarDataRelatorio(r.created_at))}</td>
      <td>${escapeHTML(r.cliente_slug || "—")}</td>
      <td>${escapeHTML(r.base_slug || "—")}</td>
      <td>${escapeHTML(r.escopo || "—")}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(formatarMargemAlvo(r.margem_alvo))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(r.total_itens ?? 0))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;color:var(--vf-danger);">${escapeHTML(String(r.itens_criticos ?? 0))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;color:var(--vf-warning, #d97706);">${escapeHTML(String(r.itens_atencao ?? 0))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;color:var(--vf-success);">${escapeHTML(String(r.itens_saudaveis ?? 0))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(r.itens_sem_base ?? 0))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;${mcStyle}">${escapeHTML(formatarMcMedia(r.mc_media))}</td>
      <td><span class="vf-ml-badge ${classeStatus(r.status)}">${escapeHTML(r.status || "—")}</span></td>
      <td>
        <select class="vf-input relatorio-pasta-select" data-id="${escapeHTML(String(r.id || ""))}" style="margin:0;padding:.32rem .5rem;font-size:.78rem;min-width:140px;">
          <option value="">Sem pasta</option>
          ${opcoesPastasHtml}
        </select>
      </td>
      <td>
        <button type="button" class="vf-btn-secondary btn-detalhe" data-id="${escapeHTML(String(r.id || ""))}" style="margin:0;padding:.25rem .6rem;font-size:.75rem;">Detalhes</button>
      </td>
      <td>
        <div style="display:flex;gap:6px;align-items:center;white-space:nowrap;">
          <button type="button" class="vf-btn-secondary btn-exportar" data-formato="xlsx" data-id="${escapeHTML(String(r.id || ""))}" style="margin:0;padding:.25rem .6rem;font-size:.75rem;">XLSX</button>
          <button type="button" class="vf-btn-secondary btn-exportar" data-formato="csv" data-id="${escapeHTML(String(r.id || ""))}" style="margin:0;padding:.25rem .6rem;font-size:.75rem;">CSV</button>
        </div>
      </td>
      <td>
        <button type="button" class="vf-btn-secondary btn-excluir" data-id="${escapeHTML(String(r.id || ""))}" style="margin:0;padding:.25rem .6rem;font-size:.75rem;">Excluir</button>
      </td>
    `;
    tbody.appendChild(tr);

    const selectPasta = tr.querySelector(".relatorio-pasta-select");
    if (selectPasta) {
      if (Number.isFinite(pastaAtual) && pastaAtual > 0) {
        selectPasta.value = String(pastaAtual);
      } else {
        selectPasta.value = "";
      }
    }
  });

  tbody.querySelectorAll(".btn-detalhe").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      abrirDetalheRelatorio(id);
    });
  });

  tbody.querySelectorAll(".btn-exportar").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const formato = btn.getAttribute("data-formato");
      if (!id) return;
      baixarRelatorio(id, formato);
    });
  });

  tbody.querySelectorAll(".btn-excluir").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      excluirRelatorio(id);
    });
  });

  tbody.querySelectorAll(".relatorio-pasta-select").forEach((select) => {
    select.addEventListener("change", async () => {
      const id = select.getAttribute("data-id");
      if (!id) return;
      const pastaIdValor = select.value ? Number(select.value) : null;
      select.disabled = true;
      await moverRelatorioParaPasta(id, pastaIdValor);
      select.disabled = false;
    });
  });
}

function atualizarBotoesExportModal() {
  const csvBtn = document.getElementById("btn-relatorio-detalhe-csv");
  const xlsxBtn = document.getElementById("btn-relatorio-detalhe-xlsx");
  const habilitar = Boolean(RELATORIO_DETALHE_ATUAL_ID);
  if (csvBtn) csvBtn.disabled = !habilitar;
  if (xlsxBtn) xlsxBtn.disabled = !habilitar;
}

function renderDetalheResumo(relatorio) {
  const container = document.getElementById("vf-relatorio-detalhe-resumo");
  const meta = document.getElementById("vf-relatorio-detalhe-meta");
  if (!container || !relatorio) return;

  container.innerHTML = `
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Total</div><div class="vf-ml-insight-value">${escapeHTML(String(relatorio.total_itens ?? 0))}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Com base</div><div class="vf-ml-insight-value">${escapeHTML(String(relatorio.itens_com_base ?? 0))}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Sem base</div><div class="vf-ml-insight-value">${escapeHTML(String(relatorio.itens_sem_base ?? 0))}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Críticos</div><div class="vf-ml-insight-value">${escapeHTML(String(relatorio.itens_criticos ?? 0))}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Atenção</div><div class="vf-ml-insight-value">${escapeHTML(String(relatorio.itens_atencao ?? 0))}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Saudáveis</div><div class="vf-ml-insight-value">${escapeHTML(String(relatorio.itens_saudaveis ?? 0))}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">MC média</div><div class="vf-ml-insight-value">${escapeHTML(formatarMcMedia(relatorio.mc_media))}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Margem alvo</div><div class="vf-ml-insight-value">${escapeHTML(formatarMargemAlvo(relatorio.margem_alvo))}</div></div>
  `;

  if (meta) {
    const partes = [
      `<strong>#${escapeHTML(String(relatorio.id || "—"))}</strong>`,
      `Cliente: <strong>${escapeHTML(relatorio.cliente_slug || "—")}</strong>`,
      `Base: <strong>${escapeHTML(relatorio.base_slug || "—")}</strong>`,
      `Escopo: <strong>${escapeHTML(relatorio.escopo || "—")}</strong>`,
      `Status: <strong>${escapeHTML(relatorio.status || "—")}</strong>`,
      `Data: <strong>${escapeHTML(formatarDataRelatorio(relatorio.created_at))}</strong>`,
    ];
    if (relatorio.observacoes) {
      partes.push(`Observações: <em>${escapeHTML(relatorio.observacoes)}</em>`);
    }
    meta.innerHTML = partes.join(" · ");
  }
}

function renderDetalheFiltros() {
  const wrap = document.getElementById("vf-relatorio-detalhe-filter-buttons");
  if (!wrap) return;

  wrap.innerHTML = DETALHE_FILTROS_RAPIDOS.map((f) => {
    const active = f.key === DETALHE_FILTRO_ATIVO ? "active" : "";
    return `<button type="button" class="vf-ml-filter-btn ${active}" data-filter="${escapeHTML(f.key)}">${escapeHTML(f.label)}</button>`;
  }).join("");

  wrap.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      DETALHE_FILTRO_ATIVO = btn.getAttribute("data-filter") || "todos";
      renderDetalheFiltros();
      renderDetalheItens();
    });
  });
}

function getItensDetalheFiltrados() {
  const busca = DETALHE_BUSCA.trim().toLowerCase();
  return (Array.isArray(DETALHE_ITENS) ? DETALHE_ITENS : []).filter((it) => {
    const diag = diagnosticoItemSalvo(it);
    if (DETALHE_FILTRO_ATIVO !== "todos" && diag.key !== DETALHE_FILTRO_ATIVO) {
      return false;
    }
    if (!busca) return true;
    const haystack = `${it?.item_id || ""} ${it?.sku || ""} ${it?.titulo || ""}`.toLowerCase();
    return haystack.includes(busca);
  });
}

function atualizarContadorDetalheFiltrado(qtdFiltrados, qtdTotal) {
  const info = document.getElementById("vf-relatorio-detalhe-filtrados-info");
  if (!info) return;
  info.textContent = `${qtdFiltrados} de ${qtdTotal} itens`;
}

function renderDetalheItens() {
  const tbody = document.getElementById("vf-relatorio-detalhe-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const lista = getItensDetalheFiltrados();
  const total = Array.isArray(DETALHE_ITENS) ? DETALHE_ITENS.length : 0;
  atualizarContadorDetalheFiltrado(lista.length, total);

  if (!lista.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="14" style="color:var(--vf-text-m);">Nenhum item encontrado</td>`;
    tbody.appendChild(tr);
    return;
  }

  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtMoney = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? brl.format(n) : "—";
  };
  const fmtMcFraction = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? `${pct.format(n * 100)}%` : "—";
  };

  lista.forEach((it) => {
    const diag = diagnosticoItemSalvo(it);
    const lcN = Number(it.lc);
    const mcN = Number(it.mc);
    const lcColor = !Number.isFinite(lcN) ? "" : (lcN > 0 ? "color:var(--vf-success);" : (lcN < 0 ? "color:var(--vf-danger);" : ""));
    const mcColor = !Number.isFinite(mcN) ? "" : (mcN > 0 ? "color:var(--vf-success);" : (mcN < 0 ? "color:var(--vf-danger);" : ""));

    const precoOriginalN = Number(it.preco_original);
    const precoPromoN = Number(it.preco_promocional);
    const temPromo =
      Number.isFinite(precoPromoN) && precoPromoN > 0 &&
      Number.isFinite(precoOriginalN) && precoPromoN < precoOriginalN;
    const originalStyle = temPromo ? "text-decoration:line-through;color:var(--vf-text-m);" : "";
    const promoStyle = temPromo ? "color:var(--vf-success);font-weight:600;" : "color:var(--vf-text-m);";
    const promoFmt = temPromo ? fmtMoney(precoPromoN) : "—";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(it.item_id || "—")}</td>
      <td style="font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(it.sku || "—")}</td>
      <td style="white-space:normal;line-height:1.35;" title="${escapeHTML(it.titulo || "")}">${escapeHTML(it.titulo || "—")}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(fmtMoney(it.custo))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;${originalStyle}">${escapeHTML(fmtMoney(it.preco_original))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;${promoStyle}">${escapeHTML(promoFmt)}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(fmtMoney(it.preco_efetivo))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(fmtMoney(it.frete))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(fmtMoney(it.comissao))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;${lcColor}">${escapeHTML(fmtMoney(it.lc))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;${mcColor}">${escapeHTML(fmtMcFraction(it.mc))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(fmtMoney(it.preco_sugerido ?? it.preco_alvo))}</td>
      <td><span class="vf-ml-badge vf-ml-badge-${diag.tone}">${escapeHTML(diag.label)}</span></td>
      <td>${escapeHTML(it.acao_recomendada || "—")}</td>
    `;
    tbody.appendChild(tr);
  });
}

function resetDetalheFiltros() {
  DETALHE_FILTRO_ATIVO = "todos";
  DETALHE_BUSCA = "";
  const buscaEl = document.getElementById("vf-relatorio-detalhe-busca");
  if (buscaEl) buscaEl.value = "";
}

async function abrirDetalheRelatorio(id) {
  if (!id || !TOKEN) return;

  const modal = document.getElementById("vf-relatorio-detalhe-modal");
  const loading = document.getElementById("vf-relatorio-detalhe-loading");
  const content = document.getElementById("vf-relatorio-detalhe-content");
  const titulo = document.getElementById("vf-relatorio-detalhe-titulo");
  if (!modal || !loading || !content) return;

  RELATORIO_DETALHE_ATUAL_ID = id;
  atualizarBotoesExportModal();

  if (titulo) titulo.textContent = `Relatório #${id}`;
  modal.style.display = "flex";
  loading.style.display = "block";
  loading.textContent = "Carregando...";
  content.style.display = "none";

  try {
    const res = await fetch(`${API_BASE}/automacoes/relatorios/${encodeURIComponent(id)}`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });

    if (res.status === 401) {
      clearSession();
      return;
    }
    if (res.status === 403) {
      window.location.replace("dashboard.html");
      return;
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    const relatorio = json.relatorio || {};
    const itens = json.itens || [];
    if (titulo) {
      titulo.textContent = `Relatório #${relatorio.id || id} — ${relatorio.cliente_slug || "—"}`;
    }

    DETALHE_ITENS = Array.isArray(itens) ? itens : [];
    resetDetalheFiltros();
    renderDetalheResumo(relatorio);
    renderDetalheFiltros();
    renderDetalheItens();
    loading.style.display = "none";
    content.style.display = "block";
  } catch (err) {
    loading.style.display = "block";
    loading.innerHTML = `<span style="color:var(--vf-danger);">Erro ao carregar detalhe: ${escapeHTML(err?.message || "desconhecido")}</span>`;
    content.style.display = "none";
  }
}

async function baixarRelatorio(id, formato) {
  if (!TOKEN || !id) return;

  const fmt = formato === "xlsx" ? "xlsx" : "csv";
  try {
    const res = await fetch(`${API_BASE}/automacoes/relatorios/${encodeURIComponent(id)}/export/${fmt}`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });

    if (res.status === 401) {
      clearSession();
      return;
    }
    if (res.status === 403) {
      window.location.replace("dashboard.html");
      return;
    }
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
    setFeedback(
      err?.message
        ? `Erro ao exportar relatório: ${err.message}`
        : "Erro ao exportar relatório.",
      "var(--vf-danger)"
    );
  }
}

async function moverRelatorioParaPasta(relatorioId, pastaId) {
  if (!TOKEN || !relatorioId) return;
  try {
    const res = await fetch(`${API_BASE}/relatorios/${encodeURIComponent(relatorioId)}/pasta`, {
      method: "PATCH",
      headers: {
        Authorization: "Bearer " + TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pastaId: pastaId == null ? null : pastaId }),
    });

    if (res.status === 401) {
      clearSession();
      return;
    }
    if (res.status === 403) {
      window.location.replace("dashboard.html");
      return;
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    setFeedback("Relatório movido com sucesso.", "var(--vf-success)");
    await Promise.all([carregarPastas(), carregarRelatorios()]);
  } catch (err) {
    setFeedback(`Erro ao mover relatório: ${err?.message || "desconhecido"}`, "var(--vf-danger)");
  }
}

async function excluirRelatorio(id) {
  if (!id || !TOKEN) return;

  const confirmar = window.confirm("Excluir este relatório salvo? Essa ação não pode ser desfeita.");
  if (!confirmar) return;

  try {
    const res = await fetch(`${API_BASE}/automacoes/relatorios/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + TOKEN },
    });

    if (res.status === 401) {
      clearSession();
      return;
    }
    if (res.status === 403) {
      window.location.replace("dashboard.html");
      return;
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    setFeedback(`Relatório #${id} excluído com sucesso.`, "var(--vf-success)");
    await Promise.all([carregarPastas(), carregarRelatorios()]);
  } catch (err) {
    setFeedback(
      err?.message
        ? `Erro ao excluir relatório: ${err.message}`
        : "Erro ao excluir relatório.",
      "var(--vf-danger)"
    );
  }
}

function fecharModalDetalhe() {
  const modal = document.getElementById("vf-relatorio-detalhe-modal");
  if (modal) modal.style.display = "none";
  RELATORIO_DETALHE_ATUAL_ID = null;
  DETALHE_ITENS = [];
  resetDetalheFiltros();
  atualizarBotoesExportModal();
}

document.getElementById("filtro-busca")?.addEventListener("input", filtrarRelatorios);
document.getElementById("filtro-cliente")?.addEventListener("change", filtrarRelatorios);
document.getElementById("filtro-escopo")?.addEventListener("change", filtrarRelatorios);
document.getElementById("filtro-status")?.addEventListener("change", filtrarRelatorios);

document.getElementById("btn-atualizar-relatorios")?.addEventListener("click", () => {
  carregarRelatorios();
});
document.getElementById("btn-nova-pasta")?.addEventListener("click", () => {
  criarPasta();
});
document.getElementById("vf-relatorio-detalhe-busca")?.addEventListener("input", (e) => {
  DETALHE_BUSCA = e.target.value || "";
  renderDetalheItens();
});

document.getElementById("vf-relatorio-detalhe-close")?.addEventListener("click", fecharModalDetalhe);
document.getElementById("vf-relatorio-detalhe-modal")?.addEventListener("click", (e) => {
  if (e.target?.id === "vf-relatorio-detalhe-modal") fecharModalDetalhe();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const modal = document.getElementById("vf-relatorio-detalhe-modal");
    if (modal && modal.style.display !== "none") fecharModalDetalhe();
  }
});
document.getElementById("btn-relatorio-detalhe-csv")?.addEventListener("click", () => {
  if (!RELATORIO_DETALHE_ATUAL_ID) return;
  baixarRelatorio(RELATORIO_DETALHE_ATUAL_ID, "csv");
});
document.getElementById("btn-relatorio-detalhe-xlsx")?.addEventListener("click", () => {
  if (!RELATORIO_DETALHE_ATUAL_ID) return;
  baixarRelatorio(RELATORIO_DETALHE_ATUAL_ID, "xlsx");
});

if (TOKEN) {
  carregarClientesParaFiltro();
  carregarPastas();
  carregarRelatorios();
}
