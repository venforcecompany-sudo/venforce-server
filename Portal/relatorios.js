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
let DETALHE_RELATORIO_ATUAL = null;
let BASE_EDITOR_ITEM_ATUAL = null;
let BASE_EDITOR_BASE_SLUG_ATUAL = null;
let BASE_EDITOR_PADRAO_CACHE = new Map(); // baseSlug -> { imposto_percentual, taxa_fixa }
let BASE_EDITOR_TAXA_FIXA_ATUAL = 0;
let MOVER_RELATORIO_ID_ATUAL = null;

function setMoverRelatorioFeedback(msg, color = "var(--vf-text-m)") {
  const el = document.getElementById("vf-mover-relatorio-feedback");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = color;
  el.style.display = msg ? "block" : "none";
}

function abrirModalMoverRelatorio(relatorioId) {
  const modal = document.getElementById("vf-mover-relatorio-modal");
  const select = document.getElementById("vf-mover-relatorio-select");
  const sub = document.getElementById("vf-mover-relatorio-sub");
  if (!modal || !select) return;

  MOVER_RELATORIO_ID_ATUAL = relatorioId;
  setMoverRelatorioFeedback("");

  if (sub) sub.textContent = `#${relatorioId}`;

  const pastas = Array.isArray(PASTAS) ? PASTAS : [];
  const optHtml = [
    `<option value="">Sem pasta</option>`,
    ...pastas.map((p) => `<option value="${escapeHTML(String(p.id))}">${escapeHTML(p.nome || `Pasta ${p.id}`)}</option>`),
  ];
  select.innerHTML = optHtml.join("");

  const rel = (Array.isArray(TODOS_RELATORIOS) ? TODOS_RELATORIOS : []).find((r) => String(r.id) === String(relatorioId));
  const pastaAtual = Number(rel?.pasta_id);
  if (Number.isFinite(pastaAtual) && pastaAtual > 0) select.value = String(pastaAtual);
  else select.value = "";

  modal.style.display = "flex";
}

function fecharModalMoverRelatorio() {
  const modal = document.getElementById("vf-mover-relatorio-modal");
  if (modal) modal.style.display = "none";
  setMoverRelatorioFeedback("");
  MOVER_RELATORIO_ID_ATUAL = null;
}

async function confirmarMoverRelatorio() {
  if (!TOKEN || !MOVER_RELATORIO_ID_ATUAL) return;
  const select = document.getElementById("vf-mover-relatorio-select");
  const saveBtn = document.getElementById("vf-mover-relatorio-save");
  const id = MOVER_RELATORIO_ID_ATUAL;
  const pastaIdValor = select?.value ? Number(select.value) : null;

  try {
    setMoverRelatorioFeedback("");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = `<span class="btn-spinner" style="border-color:rgba(255,255,255,.35);border-top-color:#fff;"></span> Movendo...`;
    }
    await moverRelatorioParaPasta(id, pastaIdValor);
    fecharModalMoverRelatorio();
  } catch (err) {
    setMoverRelatorioFeedback(`Erro ao mover: ${err?.message || "desconhecido"}`, "var(--vf-danger)");
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Mover";
    }
  }
}

function renderDash(v) {
  return `<span class="vf-num vf-dash">—</span>`;
}

function renderMoney(v, extraClass = "") {
  const n = Number(v);
  if (!Number.isFinite(n)) return renderDash();
  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<span class="vf-num vf-money ${extraClass}">${escapeHTML(brl.format(n))}</span>`;
}

function renderPercentFromFraction(v, extraClass = "") {
  const n = Number(v);
  if (!Number.isFinite(n)) return renderDash();
  const pct = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<span class="vf-num vf-percent ${extraClass}">${escapeHTML(`${pct.format(n * 100)}%`)}</span>`;
}

function renderPercentFromNumber(v, extraClass = "") {
  const n = Number(v);
  if (!Number.isFinite(n)) return renderDash();
  const pct = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `<span class="vf-num vf-percent ${extraClass}">${escapeHTML(`${pct.format(n)}%`)}</span>`;
}
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

function formatarPercentualInput(valorDecimal) {
  const n = Number(valorDecimal);
  if (!Number.isFinite(n)) return "";
  return String((n * 100));
}

function parsePercentualInput(valorUsuario) {
  const raw = String(valorUsuario ?? "").trim();
  if (!raw) return null;
  const n = Number(raw.replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

function setEditorBaseFeedback(msg, color = "var(--vf-text-m)") {
  const el = document.getElementById("vf-base-custo-rapido-feedback");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = color;
  el.style.display = msg ? "block" : "none";
}

async function carregarPadraoCustoBase(baseSlug) {
  const slug = String(baseSlug || "").trim();
  if (!slug || !TOKEN) return { imposto_percentual: 0, taxa_fixa: 0 };
  if (BASE_EDITOR_PADRAO_CACHE.has(slug)) return BASE_EDITOR_PADRAO_CACHE.get(slug);

  const res = await fetch(`${API_BASE}/bases/${encodeURIComponent(slug)}/custos/padrao`, {
    headers: { Authorization: "Bearer " + TOKEN },
  });

  if (res.status === 401) {
    clearSession();
    return { imposto_percentual: 0, taxa_fixa: 0 };
  }
  if (res.status === 403) {
    window.location.replace("dashboard.html");
    return { imposto_percentual: 0, taxa_fixa: 0 };
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.ok) {
    throw new Error(json?.erro || `HTTP ${res.status}`);
  }

  const padrao = {
    imposto_percentual: Number(json?.padrao?.imposto_percentual) || 0,
    taxa_fixa: Number(json?.padrao?.taxa_fixa) || 0,
  };
  BASE_EDITOR_PADRAO_CACHE.set(slug, padrao);
  return padrao;
}

async function abrirEditorCustoBase(item) {
  const modal = document.getElementById("vf-base-custo-rapido-modal");
  if (!modal) return;

  const baseSlug = String(DETALHE_RELATORIO_ATUAL?.base_slug || "").trim();
  if (!baseSlug) {
    setFeedback("Relatório sem base_slug. Não foi possível abrir o editor rápido.", "var(--vf-danger)");
    return;
  }

  BASE_EDITOR_ITEM_ATUAL = item || null;
  BASE_EDITOR_BASE_SLUG_ATUAL = baseSlug;

  setEditorBaseFeedback("");
  modal.style.display = "flex";

  const subtitulo = document.getElementById("vf-base-custo-rapido-subtitulo");
  if (subtitulo) subtitulo.textContent = `base=${baseSlug}`;

  const produtoIdEl = document.getElementById("vf-base-custo-produto-id");
  const skuEl = document.getElementById("vf-base-custo-sku");
  const tituloEl = document.getElementById("vf-base-custo-titulo");
  const custoEl = document.getElementById("vf-base-custo-custo-produto");
  const impostoEl = document.getElementById("vf-base-custo-imposto");

  if (produtoIdEl) produtoIdEl.value = String(item?.item_id || "");
  if (skuEl) skuEl.textContent = item?.sku ? String(item.sku) : "—";
  if (tituloEl) tituloEl.textContent = item?.titulo ? String(item.titulo) : "—";

  const custoNum = Number(item?.custo);
  if (custoEl) custoEl.value = Number.isFinite(custoNum) && custoNum > 0 ? String(custoNum) : "";

  if (impostoEl) impostoEl.value = "";
  BASE_EDITOR_TAXA_FIXA_ATUAL = 0;

  const saveBtn = document.getElementById("vf-base-custo-rapido-save");
  if (saveBtn) saveBtn.disabled = true;

  try {
    const padrao = await carregarPadraoCustoBase(baseSlug);
    if (impostoEl) impostoEl.value = formatarPercentualInput(padrao.imposto_percentual);
    BASE_EDITOR_TAXA_FIXA_ATUAL = Number(padrao.taxa_fixa) || 0;
  } catch (err) {
    setEditorBaseFeedback(
      `Não foi possível carregar o padrão da base. Você ainda pode salvar informando os campos manualmente. (${err?.message || "erro"})`,
      "var(--vf-danger)"
    );
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function fecharEditorCustoBase() {
  const modal = document.getElementById("vf-base-custo-rapido-modal");
  if (modal) modal.style.display = "none";
  setEditorBaseFeedback("");
  BASE_EDITOR_ITEM_ATUAL = null;
  BASE_EDITOR_BASE_SLUG_ATUAL = null;
}

async function salvarCustoBaseRapido() {
  if (!TOKEN) return;
  const baseSlug = String(BASE_EDITOR_BASE_SLUG_ATUAL || "").trim();
  if (!baseSlug) return;

  const produtoIdEl = document.getElementById("vf-base-custo-produto-id");
  const custoEl = document.getElementById("vf-base-custo-custo-produto");
  const impostoEl = document.getElementById("vf-base-custo-imposto");
  const saveBtn = document.getElementById("vf-base-custo-rapido-save");

  const produto_id = String(produtoIdEl?.value || "").trim();
  const custoRaw = String(custoEl?.value || "").trim();
  const custoNum = Number(custoRaw.replace(",", "."));

  if (!produto_id) {
    setEditorBaseFeedback("Produto ID / MLB é obrigatório.", "var(--vf-danger)");
    produtoIdEl?.classList.add("is-invalid");
    return;
  }
  produtoIdEl?.classList.remove("is-invalid");

  if (!custoRaw || !Number.isFinite(custoNum)) {
    setEditorBaseFeedback("Custo produto é obrigatório e numérico.", "var(--vf-danger)");
    custoEl?.classList.add("is-invalid");
    return;
  }
  custoEl?.classList.remove("is-invalid");

  const impostoDec = parsePercentualInput(impostoEl?.value);

  if (impostoEl?.value && impostoDec == null) {
    setEditorBaseFeedback("Imposto % deve ser numérico.", "var(--vf-danger)");
    impostoEl?.classList.add("is-invalid");
    return;
  }
  impostoEl?.classList.remove("is-invalid");

  const payload = {
    produto_id,
    custo_produto: custoNum,
  };

  // Se imposto/taxa estiverem vazios, não envia (service aplica padrão / mantém antigo)
  if (impostoDec != null) payload.imposto_percentual = impostoDec;
  payload.taxa_fixa = Number.isFinite(Number(BASE_EDITOR_TAXA_FIXA_ATUAL)) ? Number(BASE_EDITOR_TAXA_FIXA_ATUAL) : 0;

  try {
    setEditorBaseFeedback("");
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.innerHTML = `<span class="btn-spinner" style="border-color:rgba(255,255,255,.35);border-top-color:#fff;"></span> Salvando...`;
    }

    const res = await fetch(`${API_BASE}/bases/${encodeURIComponent(baseSlug)}/custos/upsert`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
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

    setEditorBaseFeedback(
      "Item salvo na base. Para atualizar este relatório, use a próxima etapa: Atualizar com base nova.",
      "var(--vf-success)"
    );

    // opcional: marcar botão da linha como salvo na base (sem alterar item visualmente)
    const itemId = String(BASE_EDITOR_ITEM_ATUAL?.item_id || "");
    const btnLinha = itemId
      ? document.querySelector(`button[data-base-editor-item="${CSS.escape(itemId)}"]`)
      : null;
    if (btnLinha) {
      btnLinha.textContent = "Salvo na base";
      btnLinha.disabled = true;
    }
  } catch (err) {
    setEditorBaseFeedback(`Erro ao salvar na base: ${err?.message || "desconhecido"}`, "var(--vf-danger)");
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Salvar na base";
    }
  }
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
  htmlItens.push(`<div class="vf-pastas-section-label">Fixas</div>`);
  htmlItens.push(`
    <button type="button" class="vf-relatorio-pasta-item vf-drive-folder ${PASTA_SELECIONADA === "todos" ? "is-active" : ""}" data-pasta-filter="todos">
      <span>Todos</span>
      <span class="vf-relatorio-pasta-count">${total}</span>
    </button>
  `);
  htmlItens.push(`
    <button type="button" class="vf-relatorio-pasta-item vf-drive-folder ${PASTA_SELECIONADA === "sem_pasta" ? "is-active" : ""}" data-pasta-filter="sem_pasta">
      <span>Sem pasta</span>
      <span class="vf-relatorio-pasta-count">${semPasta}</span>
    </button>
  `);

  htmlItens.push(`<div class="vf-pastas-sep"></div>`);
  htmlItens.push(`<div class="vf-pastas-section-label">Minhas pastas</div>`);

  if (!pastas.length) {
    htmlItens.push(`<div class="vf-pastas-vazio">Nenhuma pasta criada</div>`);
  } else {
    pastas.forEach((pasta) => {
      const id = Number(pasta.id);
      const active = PASTA_SELECIONADA === id ? "is-active" : "";
      const count = mapa.get(id) || 0;
      htmlItens.push(`
        <div class="vf-relatorio-pasta-row vf-drive-folder-row ${active}">
          <button type="button" class="vf-relatorio-pasta-item vf-drive-folder" data-pasta-filter="${id}">
            <span>${escapeHTML(pasta.nome || "Pasta")}</span>
            <span class="vf-relatorio-pasta-count">${count}</span>
          </button>
          <div class="vf-relatorio-pasta-actions vf-drive-folder-actions">
            <button type="button" class="vf-relatorio-pasta-action" data-pasta-rename="${id}" title="Renomear">Editar</button>
            <button type="button" class="vf-relatorio-pasta-action" data-pasta-delete="${id}" title="Excluir">Excluir</button>
          </div>
        </div>
      `);
    });
  }

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
  const list = document.getElementById("vf-relatorio-card-list");
  const summary = document.getElementById("vf-relatorios-summary-grid");
  const badge = document.getElementById("relatorios-total");
  if (!list || !summary || !badge) return;

  list.innerHTML = "";
  summary.innerHTML = "";
  badge.style.display = "inline-block";
  badge.textContent = String(RELATORIOS_FILTRADOS.length);

  if (!RELATORIOS_FILTRADOS.length) {
    setListState("empty", "Nenhum relatório encontrado");
    return;
  }

  setListState("table");

  // Métricas gerais (frontend) — baseado nos relatórios filtrados
  const rels = RELATORIOS_FILTRADOS;
  const total = rels.length;
  const lojaCompleta = rels.filter((r) => String(r.escopo || "").toLowerCase() === "loja_completa").length;
  const paginaAtual = rels.filter((r) => String(r.escopo || "").toLowerCase() === "pagina_atual").length;
  const criticosTot = rels.reduce((acc, r) => acc + (Number(r.itens_criticos) || 0), 0);
  const semBaseTot = rels.reduce((acc, r) => acc + (Number(r.itens_sem_base) || 0), 0);
  const mcVals = rels.map((r) => Number(r.mc_media)).filter((n) => Number.isFinite(n));
  const mcMediaGeral = mcVals.length ? (mcVals.reduce((a, b) => a + b, 0) / mcVals.length) : null;

  const mcFmt = mcMediaGeral == null ? "—" : `${(mcMediaGeral * 100).toFixed(2)}%`;
  const summaryCards = [
    { label: "Relatórios", value: String(total) },
    { label: "Loja completa", value: String(lojaCompleta) },
    { label: "Página atual", value: String(paginaAtual) },
    { label: "Críticos (total)", value: String(criticosTot) },
    { label: "Sem base (total)", value: String(semBaseTot) },
    { label: "MC média geral", value: mcFmt },
  ];
  summary.innerHTML = summaryCards.map((c) => `
    <div class="vf-relatorios-summary-card">
      <div class="vf-relatorios-summary-label">${escapeHTML(c.label)}</div>
      <div class="vf-relatorios-summary-value">${escapeHTML(c.value)}</div>
    </div>
  `).join("");

  RELATORIOS_FILTRADOS.forEach((r) => {
    const mcNum = Number(r.mc_media);
    const pastaAtual = Number(r.pasta_id);
    const pastaNome =
      Number.isFinite(pastaAtual) && pastaAtual > 0
        ? ((Array.isArray(PASTAS) ? PASTAS : []).find((p) => Number(p.id) === pastaAtual)?.nome || `Pasta ${pastaAtual}`)
        : "Sem pasta";

    const escopo = String(r.escopo || "—");
    const data = formatarDataRelatorio(r.created_at);
    const cliente = String(r.cliente_slug || "—");
    const base = String(r.base_slug || "—");
    const status = String(r.status || "—");

    const mcClass =
      Number.isFinite(mcNum) ? (mcNum > 0 ? "vf-good" : (mcNum < 0 ? "vf-bad" : "")) : "";
    const mcTxt = Number.isFinite(mcNum) ? `${(mcNum * 100).toFixed(2)}%` : "—";

    const card = document.createElement("div");
    card.className = "vf-relatorio-card vf-report-card";
    card.innerHTML = `
      <div class="vf-relatorio-card-header">
        <div class="vf-relatorio-card-title">
          <div class="vf-relatorio-card-id">#${escapeHTML(String(r.id || "—"))}</div>
          <div class="vf-relatorio-card-cliente">${escapeHTML(cliente)}</div>
        </div>
        <div class="vf-relatorio-card-status">
          <span class="vf-ml-badge ${classeStatus(status)}">${escapeHTML(status)}</span>
        </div>
      </div>

      <div class="vf-relatorio-card-meta">
        <span class="vf-relatorio-card-meta-item">Base: <strong>${escapeHTML(base)}</strong></span>
        <span class="vf-relatorio-card-meta-sep">·</span>
        <span class="vf-relatorio-card-meta-item">${escapeHTML(escopo)}</span>
        <span class="vf-relatorio-card-meta-sep">·</span>
        <span class="vf-relatorio-card-meta-item">${escapeHTML(data)}</span>
      </div>

      <div class="vf-relatorio-card-metrics">
        <div class="vf-pill-row vf-pill-row-metrics">
          <span class="vf-pill">${escapeHTML(String(r.total_itens ?? 0))} itens</span>
          <span class="vf-pill">${escapeHTML(String(r.itens_com_base ?? 0))} com base</span>
          <span class="vf-pill">${escapeHTML(String(r.itens_sem_base ?? 0))} sem base</span>
        </div>
        <div class="vf-pill-row vf-pill-row-metrics">
          <span class="vf-pill vf-pill-danger">Críticos ${escapeHTML(String(r.itens_criticos ?? 0))}</span>
          <span class="vf-pill vf-pill-warning">Atenção ${escapeHTML(String(r.itens_atencao ?? 0))}</span>
          <span class="vf-pill vf-pill-success">Saudáveis ${escapeHTML(String(r.itens_saudaveis ?? 0))}</span>
          <span class="vf-pill vf-pill-mc"><span class="vf-pill-prefix">MC</span><span class="vf-num ${mcClass}">${escapeHTML(mcTxt)}</span></span>
        </div>
      </div>

      <div class="vf-relatorio-card-actions vf-report-actions">
        <div class="vf-report-actions-main">
          <button type="button" class="vf-btn-secondary vf-btn-xs vf-btn-action-main btn-detalhe" data-id="${escapeHTML(String(r.id || ""))}">Detalhes</button>
          <button type="button" class="vf-btn-secondary vf-btn-xs btn-exportar" data-formato="xlsx" data-id="${escapeHTML(String(r.id || ""))}">XLSX</button>
          <button type="button" class="vf-btn-secondary vf-btn-xs btn-exportar" data-formato="csv" data-id="${escapeHTML(String(r.id || ""))}">CSV</button>
          <button type="button" class="vf-btn-secondary vf-btn-xs btn-mover" data-id="${escapeHTML(String(r.id || ""))}" data-pasta="${escapeHTML(String(pastaAtual || ""))}" data-pasta-nome="${escapeHTML(String(pastaNome))}">Mover</button>
        </div>
        <div class="vf-report-actions-danger">
          <button type="button" class="vf-btn-secondary vf-btn-xs vf-btn-action-danger btn-excluir" data-id="${escapeHTML(String(r.id || ""))}">Excluir</button>
        </div>
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll(".btn-detalhe").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      abrirDetalheRelatorio(id);
    });
  });

  list.querySelectorAll(".btn-exportar").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      const formato = btn.getAttribute("data-formato");
      if (!id) return;
      baixarRelatorio(id, formato);
    });
  });

  list.querySelectorAll(".btn-excluir").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      excluirRelatorio(id);
    });
  });

  list.querySelectorAll(".btn-mover").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      abrirModalMoverRelatorio(id);
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
    <div class="vf-resumo-bar">
      <span class="vf-resumo-pill"><strong>${escapeHTML(String(relatorio.total_itens ?? 0))}</strong> total</span>
      <span class="vf-resumo-pill">${escapeHTML(String(relatorio.itens_com_base ?? 0))} com base</span>
      <span class="vf-resumo-pill">${escapeHTML(String(relatorio.itens_sem_base ?? 0))} sem base</span>
      <span class="vf-resumo-pill vf-resumo-danger">Críticos ${escapeHTML(String(relatorio.itens_criticos ?? 0))}</span>
      <span class="vf-resumo-pill vf-resumo-warning">Atenção ${escapeHTML(String(relatorio.itens_atencao ?? 0))}</span>
      <span class="vf-resumo-pill vf-resumo-success">Saudáveis ${escapeHTML(String(relatorio.itens_saudaveis ?? 0))}</span>
      <span class="vf-resumo-pill">MC média ${escapeHTML(formatarMcMedia(relatorio.mc_media))}</span>
    </div>
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

function renderDetalheMetric(label, valueHtml) {
  return `
    <div class="vf-detail-metric">
      <div class="vf-detail-metric-label">${escapeHTML(label)}</div>
      <div class="vf-detail-metric-value">${valueHtml}</div>
    </div>
  `;
}

function renderDetalheItens() {
  const list = document.getElementById("vf-detail-item-list");
  if (!list) return;
  list.innerHTML = "";

  const lista = getItensDetalheFiltrados();
  const total = Array.isArray(DETALHE_ITENS) ? DETALHE_ITENS.length : 0;
  atualizarContadorDetalheFiltrado(lista.length, total);

  if (!lista.length) {
    list.innerHTML = `<div class="vf-detail-empty">Nenhum item encontrado</div>`;
    return;
  }

  const fmtMoneyHtml = (v, extra = "") => renderMoney(v, extra);
  const fmtPctHtml = (v, extra = "") => renderPercentFromFraction(v, extra);

  lista.forEach((it) => {
    const diag = diagnosticoItemSalvo(it);
    const temBase = it?.tem_base === true || it?.tem_base === 1 || it?.tem_base === "1";
    const baseBtnLabel = temBase ? "Atualizar custo" : "Adicionar à base";
    const baseBtnDisabled = false;

    const precoOriginalN = Number(it.preco_original);
    const precoPromoN = Number(it.preco_promocional);
    const temPromo =
      Number.isFinite(precoPromoN) && precoPromoN > 0 &&
      Number.isFinite(precoOriginalN) && precoPromoN < precoOriginalN;
    const temEfetivo = Number.isFinite(Number(it.preco_efetivo));
    const efetivoLinha = temEfetivo
      ? `<div class="vf-detail-metric-sub">Efetivo ${fmtMoneyHtml(it.preco_efetivo)}</div>`
      : "";

    const promoBloco = `
      ${temPromo ? fmtMoneyHtml(precoPromoN, "vf-good") : renderDash()}
      ${temPromo && efetivoLinha ? efetivoLinha : ""}
    `;
    const cheioBloco = `
      ${fmtMoneyHtml(it.preco_original, temPromo ? "vf-muted vf-strike" : "")}
      ${!temPromo && temEfetivo ? efetivoLinha : ""}
    `;

    const skuLinha = it?.sku
      ? `<div class="vf-detail-item-sku">SKU: ${escapeHTML(String(it.sku))}</div>`
      : "";

    const card = document.createElement("div");
    card.className = "vf-detail-item-card";
    card.innerHTML = `
      <div class="vf-detail-item-header">
        <div class="vf-detail-item-identity">
          <div class="vf-detail-item-mlb">${escapeHTML(it.item_id || "—")}</div>
          ${skuLinha}
        </div>
        <div class="vf-detail-item-title" title="${escapeHTML(it.titulo || "")}">${escapeHTML(it.titulo || "—")}</div>
        <div class="vf-detail-base-box">
          <span class="vf-base-badge ${temBase ? "is-ok" : "is-missing"}">${temBase ? "Com base" : "Sem base"}</span>
          <button
            type="button"
            class="vf-btn-secondary vf-btn-xs vf-btn-base-action btn-base-editor"
            data-base-editor-item="${escapeHTML(String(it.item_id || ""))}"
            ${baseBtnDisabled ? "disabled" : ""}
          >${escapeHTML(baseBtnLabel)}</button>
        </div>
      </div>
      <div class="vf-detail-metrics-grid">
        ${renderDetalheMetric("Custo", fmtMoneyHtml(it.custo))}
        ${renderDetalheMetric("Cheio", cheioBloco)}
        ${renderDetalheMetric("Promo", promoBloco)}
        ${renderDetalheMetric("Frete", fmtMoneyHtml(it.frete))}
        ${renderDetalheMetric("Comissão", renderPercentFromNumber(it.comissao_percentual))}
        ${renderDetalheMetric("LC", fmtMoneyHtml(it.lc, Number(it.lc) > 0 ? "vf-good" : (Number(it.lc) < 0 ? "vf-bad" : "")))}
        ${renderDetalheMetric("MC", fmtPctHtml(it.mc, Number(it.mc) > 0 ? "vf-good" : (Number(it.mc) < 0 ? "vf-bad" : "")))}
        ${renderDetalheMetric("Sugerido", fmtMoneyHtml(it.preco_sugerido ?? it.preco_alvo))}
      </div>
      <div class="vf-detail-item-footer">
        <span class="vf-ml-badge vf-ml-badge-sm ${diag.key === "sem_base" ? "vf-ml-badge-sembase" : `vf-ml-badge-${diag.tone}`}" title="${escapeHTML(diag.label)}">${escapeHTML(diag.label)}</span>
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll(".btn-base-editor").forEach((btn) => {
    btn.addEventListener("click", () => {
      const itemId = btn.getAttribute("data-base-editor-item");
      if (!itemId) return;
      const item = (Array.isArray(DETALHE_ITENS) ? DETALHE_ITENS : []).find((x) => String(x?.item_id || "") === String(itemId));
      if (!item) return;
      abrirEditorCustoBase(item);
    });
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

    DETALHE_RELATORIO_ATUAL = relatorio;
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
  DETALHE_RELATORIO_ATUAL = null;
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

document.getElementById("vf-base-custo-rapido-close")?.addEventListener("click", fecharEditorCustoBase);
document.getElementById("vf-base-custo-rapido-cancel")?.addEventListener("click", fecharEditorCustoBase);
document.getElementById("vf-base-custo-rapido-modal")?.addEventListener("click", (e) => {
  if (e.target?.id === "vf-base-custo-rapido-modal") fecharEditorCustoBase();
});
document.getElementById("vf-base-custo-rapido-save")?.addEventListener("click", salvarCustoBaseRapido);

document.getElementById("vf-mover-relatorio-close")?.addEventListener("click", fecharModalMoverRelatorio);
document.getElementById("vf-mover-relatorio-cancel")?.addEventListener("click", fecharModalMoverRelatorio);
document.getElementById("vf-mover-relatorio-modal")?.addEventListener("click", (e) => {
  if (e.target?.id === "vf-mover-relatorio-modal") fecharModalMoverRelatorio();
});
document.getElementById("vf-mover-relatorio-save")?.addEventListener("click", confirmarMoverRelatorio);

if (TOKEN) {
  carregarClientesParaFiltro();
  carregarPastas();
  carregarRelatorios();
}
