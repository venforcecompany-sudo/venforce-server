// Portal/financeiro-debug.js
// Debug Financeiro (Fechamento Inspector) — ADMIN ONLY.
// Chama POST /fechamentos/financeiro/debug e só RENDERIZA o que o backend
// devolve. Nenhuma fórmula financeira é recalculada aqui.

if (typeof window.initLayout === "function") window.initLayout();

const TOKEN = localStorage.getItem("vf-token");
if (!TOKEN) window.location.replace("index.html");
const API_BASE = "https://venforce-server.onrender.com";

function getUserSafe() {
  try {
    return JSON.parse(localStorage.getItem("vf-user") || "{}") || {};
  } catch (_) {
    return {};
  }
}

function escapeHTML(s) {
  const d = document.createElement("div");
  d.textContent = s === null || s === undefined ? "" : String(s);
  return d.innerHTML;
}

// Diferencia AUSENTE (null/undefined) de ZERO REAL — regra dura do pedido.
function fmtValue(v, { money = false } = {}) {
  if (v === null || v === undefined) return '<span class="fdbg-absent">ausente</span>';
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return '<span class="fdbg-absent">inválido</span>';
    const text = money
      ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v)
      : new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 4 }).format(v);
    return `<span class="${v === 0 ? "fdbg-zero-real" : ""}">${text}${v === 0 ? " (zero real)" : ""}</span>`;
  }
  if (Array.isArray(v)) {
    if (!v.length) return '<span class="fdbg-absent">[]</span>';
    return escapeHTML(v.map(String).join(" | "));
  }
  if (typeof v === "object") return `<code class="fdbg-mono">${escapeHTML(JSON.stringify(v))}</code>`;
  const text = String(v).trim();
  if (text === "") return '<span class="fdbg-absent">""</span>';
  return escapeHTML(text);
}

function badge(kind, label) {
  return `<span class="fdbg-badge ${kind}">${escapeHTML(label)}</span>`;
}

function resultBadge(result) {
  if (result === "hit") return badge("hit", "✓ HIT");
  if (result === "miss") return badge("miss", "× MISS");
  if (result === "skip") return badge("skip", "— SKIP");
  if (result === "ambiguous") return badge("warning", "≠ AMBÍGUO");
  return badge("info", String(result || "?"));
}

// cost_lookup = match direto (comportamento de sempre);
// cost_bridge_* = ponte SKU → ID vinda da planilha de performance.
function stageLabel(stage) {
  if (stage === "cost_lookup") return "direto";
  if (stage === "cost_bridge_sku") return "ponte: SKU";
  if (stage === "cost_bridge_variation") return "ponte: variação";
  if (stage === "cost_bridge_item") return "ponte: item";
  return String(stage || "—");
}

function severityBadge(sev) {
  if (sev === "error") return badge("error", "ERROR");
  if (sev === "warning") return badge("warning", "WARNING");
  return badge("info", "INFO");
}

function statusDot(status) {
  return `<span class="fdbg-dot ${escapeHTML(status)}"></span>`;
}

// ── Estado ───────────────────────────────────────────────────────────────
const state = {
  payload: null,
  activeTab: "arquivos",
  activePipelineFilter: null,
};

// ── Elementos ────────────────────────────────────────────────────────────
const els = {};

document.addEventListener("DOMContentLoaded", init);

function init() {
  const user = getUserSafe();
  const isAdmin = String(user.role || "").toLowerCase() === "admin";

  els.denied = document.getElementById("fdbg-denied");
  els.app = document.getElementById("fdbg-app");

  if (!isAdmin) {
    els.denied.hidden = false;
    els.app.hidden = true;
    return;
  }

  els.denied.hidden = true;
  els.app.hidden = false;

  els.filesInput = document.getElementById("fdbg-files");
  els.ads = document.getElementById("fdbg-ads");
  els.venforce = document.getElementById("fdbg-venforce");
  els.affiliates = document.getElementById("fdbg-affiliates");
  els.fullCost = document.getElementById("fdbg-fullcost");
  els.additional = document.getElementById("fdbg-additional");
  els.runBtn = document.getElementById("fdbg-run");
  els.uploadStatus = document.getElementById("fdbg-upload-status");
  els.pipelineCard = document.getElementById("fdbg-pipeline-card");
  els.pipeline = document.getElementById("fdbg-pipeline");
  els.tabs = document.getElementById("fdbg-tabs");
  els.panels = document.getElementById("fdbg-panels");

  els.runBtn.addEventListener("click", runDebug);
  els.tabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-tab]");
    if (!btn) return;
    setActiveTab(btn.dataset.tab);
  });

  initIncidentes();
}

// ── Incidentes de suporte (caixa-preta do fechamento) ──────────────────────
// Só CONSOME a API admin (GET /fechamentos/incidentes*) — não reprocessa
// nada, não recalcula fórmula nenhuma. Mesmo padrão de fetch/erro do resto
// desta página.

function fmtDataHora(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("pt-BR");
}

function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "—";
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

const TRIGGER_LABEL = {
  identidade_ambigua: "Identidade ambígua / IDs conflitantes",
  custo_nao_encontrado: "Custo não encontrado",
  receita_sem_custo: "Receita sem custo",
  cobertura_incompleta: "Cobertura incompleta",
  excecao_processamento: "Exceção durante o processamento",
};

function setIncStatus(msg, kind) {
  if (!els.incStatus) return;
  els.incStatus.textContent = msg || "";
  els.incStatus.className = `fdbg-status-line ${kind === "error" ? "is-error" : kind === "ok" ? "is-ok" : ""}`;
}

async function baixarArquivoIncidente(codigo, arquivoId, nomeOriginal) {
  try {
    const resp = await fetch(`${API_BASE}/fechamentos/incidentes/${encodeURIComponent(codigo)}/arquivos/${encodeURIComponent(arquivoId)}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!resp.ok) {
      const json = await resp.json().catch(() => ({}));
      setIncStatus(json.erro || `Erro HTTP ${resp.status} ao baixar o arquivo.`, "error");
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nomeOriginal || "arquivo";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    setIncStatus(`Falha de rede ao baixar: ${error.message}`, "error");
  }
}

function renderIncidenteDetalhe(incidente) {
  const arquivos = Array.isArray(incidente.arquivos) ? incidente.arquivos : [];
  const triggers = Array.isArray(incidente.resumo_json?.triggers) ? incidente.resumo_json.triggers : [];

  const arquivosHtml = arquivos.length
    ? arquivos.map((a) => `
        <div class="fdbg-inc-arquivo">
          <span class="fdbg-mono">${escapeHTML(a.tipo_arquivo)}</span>
          <span>${escapeHTML(a.nome_original)}</span>
          <span class="fdbg-hint">${fmtBytes(a.tamanho_bytes)}</span>
          <span class="fdbg-mono fdbg-hint" title="SHA-256">${escapeHTML(String(a.sha256 || "").slice(0, 16))}…</span>
          ${a.conteudo_truncado
            ? '<span class="fdbg-badge warning">conteúdo excedeu o limite — não preservado</span>'
            : `<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-inc-baixar="${escapeHTML(String(a.id))}" data-inc-nome="${escapeHTML(a.nome_original)}">Baixar</button>`}
        </div>
      `).join("")
    : '<p class="fdbg-hint">Nenhum arquivo preservado para este incidente.</p>';

  els.incDetalhe.innerHTML = `
    <div class="fdbg-inc-detalhe">
      <div class="fdbg-inc-detalhe__head">
        <strong class="fdbg-mono">${escapeHTML(incidente.codigo)}</strong>
        ${badge(incidente.status === "resolvido" ? "hit" : "warning", incidente.status || "aberto")}
      </div>
      <div class="fdbg-inc-grid">
        <div><span class="fdbg-hint">Cliente</span><br>${escapeHTML(incidente.cliente_slug || "—")}</div>
        <div><span class="fdbg-hint">Conta</span><br>${escapeHTML(incidente.cliente_conta_id ?? "—")}</div>
        <div><span class="fdbg-hint">Marketplace</span><br>${escapeHTML(incidente.marketplace)}</div>
        <div><span class="fdbg-hint">Período</span><br>${escapeHTML(incidente.periodo || "—")}</div>
        <div><span class="fdbg-hint">Usuário</span><br>${escapeHTML(incidente.usuario_id ?? "—")}</div>
        <div><span class="fdbg-hint">Criado em</span><br>${fmtDataHora(incidente.created_at)}</div>
        <div><span class="fdbg-hint">Expira em</span><br>${fmtDataHora(incidente.expires_at)}</div>
      </div>
      <div class="fdbg-inc-triggers">
        ${triggers.map((t) => badge("warning", TRIGGER_LABEL[t] || t)).join("") || badge("info", incidente.trigger_tipo || "—")}
      </div>
      <p class="fdbg-hint">${escapeHTML(incidente.resumo_json?.message || "")}</p>
      <div class="fdbg-card__head"><h2>Arquivos preservados</h2></div>
      ${arquivosHtml}
      <details>
        <summary class="fdbg-hint">Diagnóstico técnico (JSON)</summary>
        <code class="fdbg-mono fdbg-diag-json">${escapeHTML(JSON.stringify(incidente.diagnostico_json || {}, null, 2))}</code>
      </details>
    </div>
  `;

  els.incDetalhe.querySelectorAll("[data-inc-baixar]").forEach((btn) => {
    btn.addEventListener("click", () => {
      baixarArquivoIncidente(incidente.codigo, btn.getAttribute("data-inc-baixar"), btn.getAttribute("data-inc-nome"));
    });
  });
}

async function buscarIncidente(codigoBruto) {
  const codigo = String(codigoBruto || "").trim().toUpperCase();
  if (!codigo) {
    setIncStatus("Informe um código (ex.: FIN-184).", "error");
    return;
  }
  els.incDetalhe.innerHTML = "";
  setIncStatus(`Buscando ${codigo}…`, "");
  try {
    const resp = await fetch(`${API_BASE}/fechamentos/incidentes/${encodeURIComponent(codigo)}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.ok) {
      setIncStatus(json.erro || `Incidente ${codigo} não encontrado (pode ter expirado).`, "error");
      return;
    }
    setIncStatus("", "");
    renderIncidenteDetalhe(json.incidente);
  } catch (error) {
    setIncStatus(`Falha de rede: ${error.message}`, "error");
  }
}

function renderIncidentesLista(rows) {
  if (!rows.length) {
    els.incLista.innerHTML = '<p class="fdbg-hint">Nenhum incidente recente.</p>';
    return;
  }
  els.incLista.innerHTML = rows.map((r) => `
    <button type="button" class="fdbg-inc-lista__item" data-inc-codigo="${escapeHTML(r.codigo)}">
      <span class="fdbg-mono">${escapeHTML(r.codigo)}</span>
      <span>${escapeHTML(r.cliente_slug || "—")} · ${escapeHTML(r.marketplace)} · ${escapeHTML(r.periodo || "—")}</span>
      <span class="fdbg-hint">${fmtDataHora(r.created_at)}</span>
    </button>
  `).join("");
  els.incLista.querySelectorAll("[data-inc-codigo]").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.incBusca.value = btn.getAttribute("data-inc-codigo");
      buscarIncidente(btn.getAttribute("data-inc-codigo"));
    });
  });
}

async function carregarIncidentesRecentes() {
  try {
    const resp = await fetch(`${API_BASE}/fechamentos/incidentes?limit=20`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || !json.ok) return;
    renderIncidentesLista(json.incidentes || []);
  } catch (_) {
    // Lista de recentes é conveniência — falha aqui não bloqueia a busca por código.
  }
}

function initIncidentes() {
  els.incBusca = document.getElementById("fdbg-inc-busca");
  els.incBuscarBtn = document.getElementById("fdbg-inc-buscar");
  els.incStatus = document.getElementById("fdbg-inc-status");
  els.incDetalhe = document.getElementById("fdbg-inc-detalhe");
  els.incLista = document.getElementById("fdbg-inc-lista");

  els.incBuscarBtn.addEventListener("click", () => buscarIncidente(els.incBusca.value));
  els.incBusca.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") buscarIncidente(els.incBusca.value);
  });

  carregarIncidentesRecentes();

  // Banner do Financeiro (legado ou V3) linka para cá com ?incidente=FIN-xxx.
  const codigoDaUrl = new URLSearchParams(window.location.search).get("incidente");
  if (codigoDaUrl) {
    els.incBusca.value = codigoDaUrl;
    buscarIncidente(codigoDaUrl);
  }
}

async function runDebug() {
  const files = els.filesInput.files;
  if (!files || !files.length) {
    setUploadStatus("Selecione ao menos um arquivo.", "error");
    return;
  }

  const formData = new FormData();
  for (const f of files) formData.append("files", f);
  formData.append("ads", els.ads.value || "0");
  formData.append("venforce", els.venforce.value || "0");
  formData.append("affiliates", els.affiliates.value || "0");
  formData.append("fullCost", els.fullCost.value || "0");
  formData.append("additionalCosts", els.additional.value || "0");

  els.runBtn.disabled = true;
  els.runBtn.classList.add("is-loading");
  setUploadStatus(`Processando ${files.length} arquivo(s)…`, "");

  try {
    const resp = await fetch(`${API_BASE}/fechamentos/financeiro/debug`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: formData,
    });
    const json = await resp.json();
    if (!resp.ok || !json.ok) {
      setUploadStatus(json.error || `Erro HTTP ${resp.status}.`, "error");
      return;
    }
    state.payload = json;
    setUploadStatus(
      `OK — ${json.debug.files.length} arquivo(s), ${Object.values(json.result.engines).filter(Boolean).length} motor(es) rodaram.`,
      "ok"
    );
    els.pipelineCard.hidden = false;
    els.tabs.hidden = false;
    renderPipeline();
    setActiveTab(state.activeTab || "arquivos");
  } catch (error) {
    setUploadStatus(`Falha de rede: ${error.message}`, "error");
  } finally {
    els.runBtn.disabled = false;
    els.runBtn.classList.remove("is-loading");
  }
}

function setUploadStatus(msg, kind) {
  els.uploadStatus.textContent = msg;
  els.uploadStatus.className = `fdbg-status-line ${kind === "error" ? "is-error" : kind === "ok" ? "is-ok" : ""}`;
}

// ── Pipeline ─────────────────────────────────────────────────────────────

function renderPipeline() {
  const pipeline = state.payload?.debug?.pipeline || [];
  els.pipeline.innerHTML = pipeline
    .map(
      (p) => `
      <div class="fdbg-pipeline-stage" data-stage="${escapeHTML(p.stage)}">
        <div class="fdbg-pipeline-stage__label">${statusDot(p.status)} ${escapeHTML(p.stage)}</div>
        <div class="fdbg-pipeline-stage__detail" title="${escapeHTML(p.detail)}">${escapeHTML(p.detail)}</div>
      </div>`
    )
    .join("");
}

// ── Tabs ─────────────────────────────────────────────────────────────────

const TAB_RENDERERS = {
  arquivos: renderArquivos,
  colunas: renderColunas,
  match: renderMatchExplorer,
  trace: renderMatchTrace,
  bridge: renderBridge,
  raw: renderRaw,
  resultado: renderResultado,
  warnings: renderWarnings,
};

function setActiveTab(tab) {
  state.activeTab = tab;
  els.tabs.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.tab === tab);
  });
  if (!state.payload) {
    els.panels.innerHTML = '<p class="fdbg-hint">Rode o diagnóstico para ver os dados.</p>';
    return;
  }
  const renderer = TAB_RENDERERS[tab];
  els.panels.innerHTML = '<div class="fdbg-panel is-active" id="fdbg-panel-active"></div>';
  const panel = document.getElementById("fdbg-panel-active");
  if (renderer) renderer(panel);
}

// ── Aba: Arquivos ────────────────────────────────────────────────────────

function renderArquivos(panel) {
  const files = state.payload.debug.files || [];
  const rows = files
    .map((f) => {
      const c = f.classification;
      const sheetsIgnored = (c.sheetsIgnored || [])
        .map((s) => `${escapeHTML(s.name)} (${s.totalRows}L)`)
        .join(", ");
      return `
      <tr>
        <td class="fdbg-mono">${escapeHTML(f.originalName)}</td>
        <td>${(f.sizeBytes / 1024).toFixed(1)} KB</td>
        <td>${badge(typeBadgeKind(c.type), c.type)}</td>
        <td>${escapeHTML(c.confidence || "—")}</td>
        <td class="fdbg-mono">${escapeHTML(c.sheetUsed || "—")}</td>
        <td>${sheetsIgnored ? `<span class="fdbg-muted">${sheetsIgnored}</span>` : "—"}</td>
        <td>${c.headerRow1Based ?? "—"}</td>
        <td>${c.rowCount ?? (c.headers ? c.headers.length : "—")}</td>
        <td>${f.roleNote ? `<span class="fdbg-badge warning">duplicado</span> ${escapeHTML(f.roleNote)}` : c.note ? escapeHTML(c.note) : c.error ? `<span class="fdbg-badge error">${escapeHTML(c.error)}</span>` : "—"}</td>
      </tr>`;
    })
    .join("");

  panel.innerHTML = `
    <div class="fdbg-table-wrap">
      <table class="fdbg-table">
        <thead><tr>
          <th>Nome</th><th>Tamanho</th><th>Tipo detectado</th><th>Confiança</th>
          <th>Aba lida</th><th>Abas ignoradas</th><th>Linha cabeçalho</th><th>Linhas</th><th>Observação</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="9" class="fdbg-muted">Nenhum arquivo.</td></tr>'}</tbody>
      </table>
    </div>`;
}

function typeBadgeKind(type) {
  if (type === "DESCONHECIDO") return "error";
  if (String(type).includes("AMBIGUO") || type === "SHOPEE_MASS_UPDATE") return "warning";
  return "info";
}

// ── Aba: Colunas ─────────────────────────────────────────────────────────

function renderColunas(panel) {
  const columns = state.payload.debug.columns || [];
  const arquivos = Array.from(new Set(columns.map((c) => c.arquivo)));

  panel.innerHTML = `
    <div class="fdbg-toolbar">
      <select id="fdbg-col-arquivo" class="vf-input vf-input--sm">
        <option value="">Todos os arquivos</option>
        ${arquivos.map((a) => `<option value="${escapeHTML(a)}">${escapeHTML(a)}</option>`).join("")}
      </select>
      <input type="search" id="fdbg-col-search" placeholder="buscar coluna, campo, exemplo…" class="vf-input vf-input--sm">
      <label style="font-size:.75rem;display:flex;align-items:center;gap:4px;">
        <input type="checkbox" id="fdbg-col-only-unused"> só colunas não usadas
      </label>
      <span class="fdbg-hint" id="fdbg-col-count"></span>
    </div>
    <div class="fdbg-table-wrap">
      <table class="fdbg-table">
        <thead><tr>
          <th>Arquivo</th><th>Coluna original</th><th>Campo</th><th>Reconhecida</th>
          <th>Usada?</th><th>Onde</th><th>Não vazios</th><th>Exemplo</th><th>Observação</th>
        </tr></thead>
        <tbody id="fdbg-col-tbody"></tbody>
      </table>
    </div>`;

  const tbody = panel.querySelector("#fdbg-col-tbody");
  const arquivoSel = panel.querySelector("#fdbg-col-arquivo");
  const search = panel.querySelector("#fdbg-col-search");
  const onlyUnused = panel.querySelector("#fdbg-col-only-unused");
  const countEl = panel.querySelector("#fdbg-col-count");

  function draw() {
    const q = search.value.trim().toLowerCase();
    const arq = arquivoSel.value;
    const filtered = columns.filter((c) => {
      if (arq && c.arquivo !== arq) return false;
      if (onlyUnused.checked && c.usada && !String(c.usada).startsWith("N")) return false;
      if (!q) return true;
      return [c.colunaOriginal, c.campoNormalizado, c.exemplo, c.onde, c.observacao]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
    countEl.textContent = `${filtered.length}/${columns.length} coluna(s)`;
    tbody.innerHTML = filtered
      .map(
        (c) => `
      <tr>
        <td>${escapeHTML(c.arquivo)}</td>
        <td class="fdbg-mono">${escapeHTML(c.colunaOriginal ?? "—")}</td>
        <td class="fdbg-mono">${escapeHTML(c.campoNormalizado ?? "—")}</td>
        <td>${c.reconhecida ? badge("hit", "SIM") : badge("miss", "NÃO")}</td>
        <td>${escapeHTML(c.usada ?? "—")}</td>
        <td class="fdbg-mono fdbg-muted">${escapeHTML(c.onde ?? "—")}</td>
        <td>${c.valoresNaoVazios === null || c.valoresNaoVazios === undefined ? '<span class="fdbg-absent">—</span>' : c.valoresNaoVazios}</td>
        <td class="fdbg-mono">${c.exemplo === null || c.exemplo === undefined ? '<span class="fdbg-absent">ausente</span>' : escapeHTML(c.exemplo)}</td>
        <td class="fdbg-muted">${escapeHTML(c.observacao ?? "")}</td>
      </tr>`
      )
      .join("");
  }

  arquivoSel.addEventListener("change", draw);
  search.addEventListener("input", draw);
  onlyUnused.addEventListener("change", draw);
  draw();
}

// ── Aba: Match Explorer ──────────────────────────────────────────────────

function renderMatchExplorer(panel) {
  const byEngine = state.payload.debug.matchAttempts || {};
  const engines = Object.keys(byEngine).filter((k) => byEngine[k].totalCount > 0);

  panel.innerHTML = `
    <div class="fdbg-engine-tabs" id="fdbg-match-engines">
      ${engines
        .map((e, i) => `<button data-engine="${e}" class="${i === 0 ? "is-active" : ""}">${engineLabel(e)} (${byEngine[e].totalCount})</button>`)
        .join("") || '<span class="fdbg-muted">Nenhum motor com tentativas de match registradas.</span>'}
    </div>
    <div class="fdbg-toolbar">
      <input type="search" id="fdbg-match-search" placeholder="buscar pedido, SKU, MLB, ID…" class="vf-input vf-input--sm">
      <select id="fdbg-match-result" class="vf-input vf-input--sm">
        <option value="">todos os resultados</option>
        <option value="hit">só HIT</option>
        <option value="miss">só MISS</option>
        <option value="skip">só SKIP</option>
        <option value="ambiguous">só AMBÍGUO</option>
      </select>
      <span class="fdbg-hint" id="fdbg-match-count"></span>
      ${byEngine[engines[0]]?.truncated ? '<span class="fdbg-badge warning">amostra limitada</span>' : ""}
    </div>
    <div class="fdbg-table-wrap">
      <table class="fdbg-table">
        <thead><tr><th>Pedido/Venda</th><th>Etapa</th><th>Campo tentado</th><th>Valor bruto</th><th>Chave normalizada</th><th>Resultado</th></tr></thead>
        <tbody id="fdbg-match-tbody"></tbody>
      </table>
    </div>`;

  let currentEngine = engines[0] || null;
  const search = panel.querySelector("#fdbg-match-search");
  const resultSel = panel.querySelector("#fdbg-match-result");
  const tbody = panel.querySelector("#fdbg-match-tbody");
  const countEl = panel.querySelector("#fdbg-match-count");

  function draw() {
    if (!currentEngine) {
      tbody.innerHTML = '<tr><td colspan="6" class="fdbg-muted">Sem dados.</td></tr>';
      return;
    }
    const q = search.value.trim().toLowerCase();
    const wantResult = resultSel.value;
    const items = byEngine[currentEngine].items.filter((a) => {
      if (wantResult && a.result !== wantResult) return false;
      if (!q) return true;
      return [a.orderId, a.field, a.rawValue, a.normalizedKey].filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
    });
    countEl.textContent = `${items.length} tentativa(s)`;
    tbody.innerHTML = items
      .slice(0, 1000)
      .map(
        (a) => `
      <tr>
        <td class="fdbg-mono">${escapeHTML(a.orderId ?? "—")}</td>
        <td class="fdbg-mono fdbg-muted">${escapeHTML(stageLabel(a.stage))}</td>
        <td class="fdbg-mono">${escapeHTML(a.field)}</td>
        <td class="fdbg-mono">${a.rawValue === null || a.rawValue === undefined || a.rawValue === "" ? '<span class="fdbg-absent">ausente</span>' : escapeHTML(a.rawValue)}</td>
        <td class="fdbg-mono fdbg-muted">${escapeHTML(a.normalizedKey ?? "—")}</td>
        <td>${resultBadge(a.result)}</td>
      </tr>`
      )
      .join("");
  }

  panel.querySelector("#fdbg-match-engines").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-engine]");
    if (!btn) return;
    currentEngine = btn.dataset.engine;
    panel.querySelectorAll("#fdbg-match-engines button").forEach((b) => b.classList.toggle("is-active", b === btn));
    draw();
  });
  search.addEventListener("input", draw);
  resultSel.addEventListener("change", draw);
  draw();
}

function engineLabel(engine) {
  return { meli: "MELI", shopee_real: "Shopee real", shopee_performance: "Shopee performance", tiktok: "TikTok" }[engine] || engine;
}

// ── Aba: Match Trace (por pedido) ────────────────────────────────────────

function renderMatchTrace(panel) {
  const byEngine = state.payload.debug.matchAttempts || {};
  const allOrderIds = new Set();
  Object.values(byEngine).forEach((e) => e.items.forEach((a) => a.orderId && allOrderIds.add(a.orderId)));
  const bridgeItems = state.payload.debug.bridges?.shopee?.items?.items || [];

  panel.innerHTML = `
    <div class="fdbg-toolbar">
      <input type="search" id="fdbg-trace-search" list="fdbg-trace-list" placeholder="digite o ID do pedido/venda…" class="vf-input">
      <datalist id="fdbg-trace-list">${Array.from(allOrderIds).slice(0, 500).map((id) => `<option value="${escapeHTML(id)}">`).join("")}</datalist>
      <span class="fdbg-hint">${allOrderIds.size} pedido(s)/venda(s) com trace disponível</span>
    </div>
    <div id="fdbg-trace-result"><p class="fdbg-hint">Digite ou escolha um pedido/venda para ver a ordem real de tentativas de lookupShopeeCost/resolveCostForItem.</p></div>`;

  const search = panel.querySelector("#fdbg-trace-search");
  const result = panel.querySelector("#fdbg-trace-result");

  function draw() {
    const id = search.value.trim();
    if (!id) {
      result.innerHTML = '<p class="fdbg-hint">Digite ou escolha um pedido/venda.</p>';
      return;
    }
    let html = "";
    for (const [engine, data] of Object.entries(byEngine)) {
      const steps = data.items.filter((a) => String(a.orderId) === id);
      if (!steps.length) continue;
      html += `<h3 style="font-size:.85rem;margin:14px 0 4px;">${engineLabel(engine)} — ${steps.length} tentativa(s)</h3>`;
      html += '<div class="fdbg-trace-steps">';
      steps.forEach((s, i) => {
        html += `
          <div class="fdbg-trace-step ${s.result}">
            <span class="fdbg-trace-step__idx">${i + 1}.</span>
            <span class="fdbg-trace-step__field">${escapeHTML(stageLabel(s.stage))} · ${escapeHTML(s.field)}</span>
            <span class="fdbg-trace-step__value">${s.rawValue ? escapeHTML(s.rawValue) : '<span class="fdbg-absent">—</span>'}${s.normalizedKey ? ` → <span class="fdbg-muted">${escapeHTML(s.normalizedKey)}</span>` : ""}</span>
            <span>${resultBadge(s.result)}</span>
          </div>`;
      });
      html += "</div>";
      const bridgeStep = steps.find((s) => s.result === "hit" && String(s.stage || "").startsWith("cost_bridge_") && s.stage !== "cost_bridge_sku");
      const directHit = steps.some((s) => s.result === "hit" && s.stage === "cost_lookup");
      const ambiguous = steps.some((s) => s.result === "ambiguous");
      const outcome = ambiguous
        ? "COST_BRIDGE_AMBIGUOUS (custo mantido em branco)"
        : directHit
          ? `COST_FOUND — ${steps.find((s) => s.result === "hit" && s.stage === "cost_lookup").field} (match direto)`
          : bridgeStep
            ? `COST_FOUND — ${bridgeStep.field} (ponte da performance)`
            : "COST_NOT_FOUND";
      html += `<p class="fdbg-hint">Resultado do motor real: <strong>${escapeHTML(outcome)}</strong></p>`;
    }

    const bridgeItem = bridgeItems.find((b) => String(b.orderId) === id);
    if (bridgeItem) {
      html += `<h3 style="font-size:.85rem;margin:14px 0 4px;">Ponte disponível (Order.all → Performance → Base)</h3>`;
      html += `
        <div class="fdbg-trace-steps">
          <div class="fdbg-trace-step ${bridgeItem.matchDireto ? "hit" : "miss"}">
            <span class="fdbg-trace-step__idx">1.</span>
            <span class="fdbg-trace-step__field">match direto</span>
            <span class="fdbg-trace-step__value">SKU ${escapeHTML(bridgeItem.skuUsado ?? "—")} → base de custos</span>
            <span>${resultBadge(bridgeItem.matchDireto ? "hit" : "miss")}</span>
          </div>
          <div class="fdbg-trace-step ${bridgeItem.bridgeDisponivel ? "hit" : "miss"}">
            <span class="fdbg-trace-step__idx">2.</span>
            <span class="fdbg-trace-step__field">SKU → performance</span>
            <span class="fdbg-trace-step__value">${bridgeItem.bridgeIds ? `idItem ${escapeHTML(bridgeItem.bridgeIds.idItem ?? "—")} / idVariação ${escapeHTML(bridgeItem.bridgeIds.idVariacao ?? "—")}` : "sem correspondência na performance"}</span>
            <span>${resultBadge(bridgeItem.bridgeDisponivel ? "hit" : "miss")}</span>
          </div>
          <div class="fdbg-trace-step ${bridgeItem.matchViaBridge ? "hit" : "miss"}">
            <span class="fdbg-trace-step__idx">3.</span>
            <span class="fdbg-trace-step__field">performance → base</span>
            <span class="fdbg-trace-step__value">${bridgeItem.custoViaBridge ? `custo ${fmtValue(bridgeItem.custoViaBridge.custo, { money: true })} / imposto ${bridgeItem.custoViaBridge.imposto}%` : "sem custo na base para este ID"}</span>
            <span>${resultBadge(bridgeItem.matchViaBridge ? "hit" : "miss")}</span>
          </div>
        </div>
        <p class="fdbg-hint">${bridgeItem.matchViaBridge && !bridgeItem.matchDireto ? "O motor atual NÃO executou esta ponte — o custo existe, mas fica de fora do fechamento real." : ""}</p>`;
    }

    result.innerHTML = html || '<p class="fdbg-muted">Nenhuma tentativa de match encontrada para este ID.</p>';
  }

  search.addEventListener("input", draw);
  search.addEventListener("change", draw);
}

// ── Aba: Ponte Shopee ────────────────────────────────────────────────────

function renderBridge(panel) {
  const bridge = state.payload.debug.bridges?.shopee;
  if (!bridge || !bridge.available) {
    panel.innerHTML = '<p class="fdbg-hint">Envie o Order.all da Shopee para ver a ponte Order.all → Performance → Base.</p>';
    return;
  }

  const statCard = (label, stat) => `
    <div class="fdbg-stat-card">
      <div class="fdbg-stat-card__label">${escapeHTML(label)}</div>
      <div class="fdbg-stat-card__value">${stat.percent}%</div>
      <div class="fdbg-stat-card__sub">${stat.hit} / ${stat.total}</div>
    </div>`;

  panel.innerHTML = `
    <div class="fdbg-stats-row">
      ${statCard("Match direto (Order.all → Base)", bridge.directMatch)}
      ${statCard("Order.all → Performance", bridge.orderToPerformance)}
      ${statCard("Performance → Base", bridge.performanceToBase)}
      ${statCard("Completo via ponte", bridge.fullBridge)}
    </div>
    ${bridge.conclusion ? `<div class="fdbg-conclusion">${escapeHTML(bridge.conclusion)}</div>` : ""}
    <div class="fdbg-toolbar">
      <input type="search" id="fdbg-bridge-search" placeholder="buscar pedido, SKU, produto…" class="vf-input vf-input--sm">
      <select id="fdbg-bridge-filter" class="vf-input vf-input--sm">
        <option value="">todos</option>
        <option value="oportunidade">só oportunidade perdida (bridge resolveria, direto não)</option>
        <option value="semcusto">sem custo em nenhum caminho</option>
      </select>
      <span class="fdbg-hint" id="fdbg-bridge-count"></span>
    </div>
    <div class="fdbg-table-wrap">
      <table class="fdbg-table">
        <thead><tr>
          <th>Pedido</th><th>Produto</th><th>SKU usado</th><th>Match direto</th>
          <th>Ponte disponível</th><th>Match via ponte</th><th>Custo via ponte</th>
        </tr></thead>
        <tbody id="fdbg-bridge-tbody"></tbody>
      </table>
    </div>`;

  const items = bridge.items.items || [];
  const search = panel.querySelector("#fdbg-bridge-search");
  const filterSel = panel.querySelector("#fdbg-bridge-filter");
  const tbody = panel.querySelector("#fdbg-bridge-tbody");
  const countEl = panel.querySelector("#fdbg-bridge-count");

  function draw() {
    const q = search.value.trim().toLowerCase();
    const filter = filterSel.value;
    const filtered = items.filter((it) => {
      if (filter === "oportunidade" && !(it.matchViaBridge && !it.matchDireto)) return false;
      if (filter === "semcusto" && (it.matchDireto || it.matchViaBridge)) return false;
      if (!q) return true;
      return [it.orderId, it.product, it.skuUsado].filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
    });
    countEl.textContent = `${filtered.length}/${items.length}${bridge.items.truncated ? ` (amostra de ${bridge.items.totalCount})` : ""}`;
    tbody.innerHTML = filtered
      .slice(0, 500)
      .map(
        (it) => `
      <tr>
        <td class="fdbg-mono">${escapeHTML(it.orderId)}</td>
        <td>${escapeHTML((it.product || "").slice(0, 60))}</td>
        <td class="fdbg-mono">${escapeHTML(it.skuUsado ?? "—")}</td>
        <td>${resultBadge(it.matchDireto ? "hit" : "miss")}</td>
        <td>${resultBadge(it.bridgeDisponivel ? "hit" : "miss")}</td>
        <td>${resultBadge(it.matchViaBridge ? "hit" : "miss")}</td>
        <td>${it.custoViaBridge ? fmtValue(it.custoViaBridge.custo, { money: true }) : '<span class="fdbg-absent">—</span>'}</td>
      </tr>`
      )
      .join("");
  }

  search.addEventListener("input", draw);
  filterSel.addEventListener("change", draw);
  draw();
}

// ── Aba: Raw / Normalizado ───────────────────────────────────────────────

function renderRaw(panel) {
  const engines = state.payload.result.engines || {};
  const available = Object.keys(engines).filter((k) => engines[k]);

  panel.innerHTML = `
    <div class="fdbg-engine-tabs" id="fdbg-raw-engines">
      ${available.map((e, i) => `<button data-engine="${e}" class="${i === 0 ? "is-active" : ""}">${engineLabel(e)}</button>`).join("")}
    </div>
    <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm fdbg-copy-btn" id="fdbg-raw-copy">Copiar JSON</button>
    <p class="fdbg-sample-note" id="fdbg-raw-note"></p>
    <div class="fdbg-json" id="fdbg-raw-json"></div>`;

  let currentEngine = available[0] || null;
  const jsonEl = panel.querySelector("#fdbg-raw-json");
  const noteEl = panel.querySelector("#fdbg-raw-note");

  function draw() {
    const engineResult = engines[currentEngine];
    if (!engineResult) {
      jsonEl.textContent = "(motor não rodou)";
      return;
    }
    if (engineResult.error) {
      noteEl.textContent = "Este motor terminou com erro — ver aba Warnings.";
      jsonEl.textContent = JSON.stringify(engineResult, null, 2);
      return;
    }
    const sampleKeyMap = { meli: "meli", shopee_real: "shopeeReal", shopee_performance: "shopeePerformance", tiktok: "tiktok" };
    const sample = state.payload.debug.detailedRowsSample?.[sampleKeyMap[currentEngine]];
    noteEl.textContent = sample
      ? `detailedRows: mostrando ${sample.items.length} de ${sample.totalCount} linha(s)${sample.truncated ? " (amostra truncada)" : ""}.`
      : "";
    const view = {
      summary: engineResult.summary,
      unmatchedIds: engineResult.unmatchedIds,
      unmatchedCancelled: engineResult.unmatchedCancelled,
      ignoredRowsWithoutCost: engineResult.ignoredRowsWithoutCost,
      ignoredRevenue: engineResult.ignoredRevenue,
      parsingDiagnostics: engineResult.parsingDiagnostics,
      message: engineResult.message,
      detailedRowsSample: sample ? sample.items.slice(0, 20) : undefined,
      auditRowsSample: Array.isArray(engineResult.auditRows) ? engineResult.auditRows.slice(0, 20) : undefined,
    };
    jsonEl.textContent = JSON.stringify(view, null, 2);
  }

  panel.querySelector("#fdbg-raw-engines").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-engine]");
    if (!btn) return;
    currentEngine = btn.dataset.engine;
    panel.querySelectorAll("#fdbg-raw-engines button").forEach((b) => b.classList.toggle("is-active", b === btn));
    draw();
  });

  panel.querySelector("#fdbg-raw-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(jsonEl.textContent);
      setUploadStatus("JSON copiado.", "ok");
    } catch (_) {
      setUploadStatus("Não foi possível copiar (permissão do navegador).", "error");
    }
  });

  draw();
}

// ── Aba: Resultado ───────────────────────────────────────────────────────

function renderResultado(panel) {
  const engines = state.payload.result.engines || {};
  const available = Object.keys(engines).filter((k) => engines[k]);

  panel.innerHTML = `
    <div class="fdbg-engine-tabs" id="fdbg-res-engines">
      ${available.map((e, i) => `<button data-engine="${e}" class="${i === 0 ? "is-active" : ""}">${engineLabel(e)}</button>`).join("") || '<span class="fdbg-muted">Nenhum motor rodou.</span>'}
    </div>
    <div id="fdbg-res-body"></div>`;

  let currentEngine = available[0] || null;
  const body = panel.querySelector("#fdbg-res-body");

  function draw() {
    const engineResult = engines[currentEngine];
    if (!engineResult) {
      body.innerHTML = '<p class="fdbg-muted">Motor não rodou.</p>';
      return;
    }
    if (engineResult.error) {
      body.innerHTML = `<div class="fdbg-conclusion">${escapeHTML(engineResult.error)}</div>`;
      return;
    }
    const summary = engineResult.summary || {};
    const money = new Set([
      "grossRevenueTotal", "revenueWithCost", "revenueWithoutCost", "paidRevenueTotal",
      "contributionProfitTotal", "finalResult", "refundsTotal", "cancelledRevenue",
      "lostRevenueTotal", "marketplaceFeesTotal", "shippingFeesTotal", "taxValueTotal",
      "cmvTotal", "adsTotal", "venforceTotal", "affiliatesTotal", "grossProfitTotal",
    ]);
    const entries = Object.entries(summary).filter(([k, v]) => typeof v !== "object" || v === null);
    body.innerHTML = `
      <div class="fdbg-summary-grid">
        ${entries
          .map(
            ([k, v]) => `
          <div class="fdbg-summary-item">
            <div class="fdbg-summary-item__k">${escapeHTML(k)}</div>
            <div class="fdbg-summary-item__v">${fmtValue(v, { money: money.has(k) })}</div>
          </div>`
          )
          .join("")}
      </div>
      <p class="fdbg-hint">${escapeHTML(engineResult.message || "")}</p>`;
  }

  panel.querySelector("#fdbg-res-engines").addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-engine]");
    if (!btn) return;
    currentEngine = btn.dataset.engine;
    panel.querySelectorAll("#fdbg-res-engines button").forEach((b) => b.classList.toggle("is-active", b === btn));
    draw();
  });

  draw();
}

// ── Aba: Warnings ────────────────────────────────────────────────────────

function renderWarnings(panel) {
  const warnings = state.payload.debug.warnings || [];
  const codes = Array.from(new Set(warnings.map((w) => w.code)));

  panel.innerHTML = `
    <div class="fdbg-toolbar">
      <select id="fdbg-warn-severity" class="vf-input vf-input--sm">
        <option value="">todas as severidades</option>
        <option value="error">error</option>
        <option value="warning">warning</option>
        <option value="info">info</option>
      </select>
      <select id="fdbg-warn-code" class="vf-input vf-input--sm">
        <option value="">todos os códigos</option>
        ${codes.map((c) => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join("")}
      </select>
      <span class="fdbg-hint" id="fdbg-warn-count"></span>
    </div>
    <div class="fdbg-table-wrap">
      <table class="fdbg-table">
        <thead><tr><th>Severidade</th><th>Código</th><th>Arquivo/Motor</th><th>Mensagem</th></tr></thead>
        <tbody id="fdbg-warn-tbody"></tbody>
      </table>
    </div>`;

  const sevSel = panel.querySelector("#fdbg-warn-severity");
  const codeSel = panel.querySelector("#fdbg-warn-code");
  const tbody = panel.querySelector("#fdbg-warn-tbody");
  const countEl = panel.querySelector("#fdbg-warn-count");

  function draw() {
    const sev = sevSel.value;
    const code = codeSel.value;
    const filtered = warnings.filter((w) => (!sev || w.severity === sev) && (!code || w.code === code));
    countEl.textContent = `${filtered.length}/${warnings.length}`;
    tbody.innerHTML = filtered
      .map(
        (w) => `
      <tr>
        <td>${severityBadge(w.severity)}</td>
        <td class="fdbg-mono">${escapeHTML(w.code)}</td>
        <td class="fdbg-mono">${escapeHTML(w.file || w.engine || "—")}</td>
        <td>${escapeHTML(w.message)}${w.rowsAffected !== undefined ? ` <span class="fdbg-muted">(${w.rowsAffected} linha(s))</span>` : ""}</td>
      </tr>`
      )
      .join("");
  }

  sevSel.addEventListener("change", draw);
  codeSel.addEventListener("change", draw);
  draw();
}
