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
const canAccessAutomacoes =
  role === "admin" || role === "user" || role === "membro";
if (!canAccessAutomacoes) window.location.replace("dashboard.html");
initLayout();

let ALL_CLIENTES = [];
let ALL_BASES = [];
let PREVIEW_ML_PAGE = 1;
const PREVIEW_ML_LIMIT = 20;
let PREVIEW_ML_ROWS = [];
let PREVIEW_ML_FILTER = "todos";
let PREVIEW_ML_SEARCH = "";
let DIAG_POLL_TIMER = null;
let DIAG_RELATORIO_ID = null;
let DIAG_ULTIMO_RELATORIO = null;
let RELATORIO_DETALHE_ATUAL_ID = null;
const PREVIEW_ML_FILTERS = [
  { key: "todos", label: "Todos" },
  { key: "critico", label: "Críticos" },
  { key: "atencao", label: "Atenção" },
  { key: "saudavel", label: "Saudáveis" },
  { key: "sem_base", label: "Sem base" },
  { key: "sem_frete", label: "Sem frete" },
  { key: "sem_comissao", label: "Sem comissão" },
];

function abrirModalCalculo(r) {
  const modal = document.getElementById("vf-calc-modal");
  const body = document.getElementById("vf-calc-modal-body");
  if (!modal || !body) return;
  const brl = (n) => Number.isFinite(Number(n)) ? new Intl.NumberFormat("pt-BR",{style:"currency",currency:"BRL"}).format(Number(n)) : "—";
  const pct = (n) => Number.isFinite(Number(n)) ? `${(Number(n)*100).toFixed(2)}%` : "—";
  const preco = Number(r.precoEfetivo);
  const imp = Number(r.impostoPercentual);
  const impAliq = Number.isFinite(imp) ? (imp > 1 ? imp/100 : imp) : 0;
  const valorImposto = Number.isFinite(preco) ? preco * impAliq : null;
  body.innerHTML = `
    <div style="font-family:var(--vf-mono);font-size:.85rem;line-height:1.8;">
      <div><strong>Item:</strong> ${escapeHTML(r.item_id || "—")}</div>
      <hr style="margin:.75rem 0;opacity:.3;">
      <div>Preço efetivo: <strong>${brl(r.precoEfetivo)}</strong></div>
      <div>(−) Imposto (${pct(impAliq)}): ${brl(valorImposto)}</div>
      <div>(−) Comissão ML: ${brl(r.comissaoMarketplace)}</div>
      <div>(−) Frete: ${brl(r.frete)}</div>
      <div>(−) Taxa fixa: ${brl(r.taxaFixa)}</div>
      <div>(−) Custo produto: ${brl(r.custoProduto)}</div>
      <hr style="margin:.75rem 0;opacity:.3;">
      <div><strong>= Lucro de Contribuição: ${brl(r.lucroContribuicao)}</strong></div>
      <div><strong>Margem de Contribuição: ${pct(r.margemContribuicao)}</strong></div>
      ${r.precoAlvo != null ? `<hr style="margin:.75rem 0;opacity:.3;"><div><strong>Preço Alvo (margem desejada): ${brl(r.precoAlvo)}</strong></div>` : ""}
    </div>
  `;
  modal.style.display = "flex";
}

document.getElementById("vf-calc-modal-close")?.addEventListener("click", () => {
  document.getElementById("vf-calc-modal").style.display = "none";
});
document.getElementById("vf-calc-modal")?.addEventListener("click", (e) => {
  if (e.target.id === "vf-calc-modal") e.target.style.display = "none";
});

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

function applyBaseSearchFilter({ keepValueIfPossible = true } = {}) {
  const input = document.getElementById("automacoes-base-search");
  const select = document.getElementById("automacoes-base");
  if (!select) return;

  const q = (input?.value || "").trim().toLowerCase();
  const filtered = !q
    ? ALL_BASES
    : ALL_BASES.filter((b) => {
        const nome = (b?.nome || "").toString().toLowerCase();
        const slug = (b?.slug || "").toString().toLowerCase();
        return nome.includes(q) || slug.includes(q);
      });

  const currentValue = select.value || "";
  setBasesOptions(select, filtered);

  if (keepValueIfPossible && currentValue) {
    const stillThere = filtered.some((b) => (b?.slug || "") === currentValue);
    if (stillThere) {
      select.value = currentValue;
    } else {
      select.value = "";
      setStatus("Base atual não está no filtro. Selecione uma base.", "var(--vf-text-m)");
    }
  }
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
    const res = await fetch(`${API_BASE}/automacoes/clientes`, {
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

    ALL_BASES = bases;
    applyBaseSearchFilter({ keepValueIfPossible: false });
    if (select) select.disabled = false;
  } catch (err) {
    ALL_BASES = [];
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

function getMargemAlvoDecimalAtual() {
  const input = document.getElementById("automacoes-margem");
  const raw = Number(input?.value);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw / 100;
}

function diagnosticarLinhaMl(r) {
  const mc = Number(r?.margemContribuicao);
  const margemAlvo = getMargemAlvoDecimalAtual();

  if (!r?.temBase) {
    return { key: "sem_base", label: "Sem base", tone: "neutral" };
  }
  if (r?.frete == null || !Number.isFinite(Number(r.frete))) {
    return { key: "sem_frete", label: "Sem frete", tone: "warning" };
  }
  if (r?.comissaoMarketplace == null || !Number.isFinite(Number(r.comissaoMarketplace))) {
    return { key: "sem_comissao", label: "Sem comissão", tone: "warning" };
  }
  if (!Number.isFinite(mc)) {
    return { key: "sem_dados", label: "Sem dados", tone: "neutral" };
  }
  if (mc < 0) {
    return { key: "critico", label: "Crítico", tone: "danger" };
  }
  if (margemAlvo !== null && mc < margemAlvo) {
    return { key: "atencao", label: "Atenção", tone: "warning" };
  }
  return { key: "saudavel", label: "Saudável", tone: "success" };
}

function renderDiagnosticoBadge(diag) {
  const cls = `vf-ml-badge vf-ml-badge-${diag?.tone || "neutral"}`;
  return `<span class="${cls}">${escapeHTML(diag?.label || "—")}</span>`;
}

function getPreviewMlFilteredRows() {
  const rows = Array.isArray(PREVIEW_ML_ROWS) ? PREVIEW_ML_ROWS : [];
  const q = PREVIEW_ML_SEARCH.trim().toLowerCase();

  return rows.filter((r) => {
    const diag = diagnosticarLinhaMl(r);
    if (PREVIEW_ML_FILTER !== "todos" && diag.key !== PREVIEW_ML_FILTER) {
      return false;
    }

    if (q) {
      const haystack = [
        r?.item_id,
        r?.titulo,
        r?.status,
        r?.tipoAnuncio,
        r?.listing_type_id,
      ].join(" ").toLowerCase();

      if (!haystack.includes(q)) return false;
    }

    return true;
  });
}

function renderPreviewMlInsights() {
  const container = document.getElementById("precificacao-ml-insights");
  if (!container) return;

  const rows = Array.isArray(PREVIEW_ML_ROWS) ? PREVIEW_ML_ROWS : [];
  if (!rows.length) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }

  let comBase = 0;
  let semBase = 0;
  let criticos = 0;
  let atencao = 0;
  let saudaveis = 0;
  let semFrete = 0;
  let semComissao = 0;
  let mcCount = 0;
  let mcSum = 0;

  rows.forEach((r) => {
    if (r?.temBase) comBase += 1;
    else semBase += 1;

    const diag = diagnosticarLinhaMl(r);
    if (diag.key === "critico") criticos += 1;
    if (diag.key === "atencao") atencao += 1;
    if (diag.key === "saudavel") saudaveis += 1;
    if (diag.key === "sem_frete") semFrete += 1;
    if (diag.key === "sem_comissao") semComissao += 1;

    const mc = Number(r?.margemContribuicao);
    if (Number.isFinite(mc)) {
      mcSum += mc;
      mcCount += 1;
    }
  });

  const mcMedia = mcCount > 0 ? (mcSum / mcCount) * 100 : null;
  const mcMediaTxt = mcMedia == null ? "—" : `${mcMedia.toFixed(2)}%`;

  container.style.display = "grid";
  container.innerHTML = `
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Página atual</div><div class="vf-ml-insight-value">${rows.length}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Com base</div><div class="vf-ml-insight-value">${comBase}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Sem base</div><div class="vf-ml-insight-value">${semBase}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Críticos</div><div class="vf-ml-insight-value">${criticos}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Atenção</div><div class="vf-ml-insight-value">${atencao}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Saudáveis</div><div class="vf-ml-insight-value">${saudaveis}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">MC média</div><div class="vf-ml-insight-value">${mcMediaTxt}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Sem frete</div><div class="vf-ml-insight-value">${semFrete}</div></div>
  `;
}

function renderPreviewMlControls() {
  const container = document.getElementById("precificacao-ml-controls");
  const buttonsWrap = document.getElementById("precificacao-ml-filter-buttons");
  if (!container || !buttonsWrap) return;

  const hasRows = Array.isArray(PREVIEW_ML_ROWS) && PREVIEW_ML_ROWS.length > 0;
  if (!hasRows) {
    container.style.display = "none";
    buttonsWrap.innerHTML = "";
    return;
  }

  container.style.display = "flex";
  buttonsWrap.innerHTML = PREVIEW_ML_FILTERS.map((f) => {
    const active = f.key === PREVIEW_ML_FILTER ? "active" : "";
    return `<button type="button" class="vf-ml-filter-btn ${active}" data-filter="${escapeHTML(f.key)}">${escapeHTML(f.label)}</button>`;
  }).join("");

  buttonsWrap.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      PREVIEW_ML_FILTER = btn.getAttribute("data-filter") || "todos";
      renderPreviewMlControls();
      renderPreviewMlTable();
    });
  });
}

function renderPreviewMlTable() {
  const tbody = document.getElementById("precificacao-ml-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const rows = getPreviewMlFilteredRows();
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="16" style="color:var(--vf-text-m);">Nenhum item encontrado com os filtros atuais.</td>`;
    tbody.appendChild(tr);
    return;
  }

  const brlFormatter = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const pctFormatter = new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  rows.forEach((r) => {
    const diag = diagnosticarLinhaMl(r);
    const comissaoFmt =
      r.comissaoMarketplace == null || !Number.isFinite(Number(r.comissaoMarketplace))
        ? "—"
        : brlFormatter.format(Number(r.comissaoMarketplace));
    const lcNumber = Number(r.lucroContribuicao);
    const lcFmt =
      r.lucroContribuicao == null || !Number.isFinite(lcNumber)
        ? "—"
        : brlFormatter.format(lcNumber);
    const mcNumber = Number(r.margemContribuicao);
    const mcFmt =
      r.margemContribuicao == null || !Number.isFinite(mcNumber)
        ? "—"
        : `${pctFormatter.format(mcNumber * 100)}%`;
    const precoAlvoFmt =
      r.precoAlvo == null || !Number.isFinite(Number(r.precoAlvo))
        ? "—"
        : brlFormatter.format(Number(r.precoAlvo));
    const precoOriginalFmt = r.precoOriginal == null || !Number.isFinite(Number(r.precoOriginal))
      ? "—" : brlFormatter.format(Number(r.precoOriginal));

    const temPromo = r.precoPromocionado != null && Number.isFinite(Number(r.precoPromocionado))
      && Number(r.precoPromocionado) < Number(r.precoOriginal);
    const precoPromoFmt = !temPromo ? "—" : brlFormatter.format(Number(r.precoPromocionado));
    const promoStyle = temPromo ? "color:var(--vf-success);font-weight:600;" : "color:var(--vf-text-m);";
    const originalStyle = temPromo ? "text-decoration:line-through;color:var(--vf-text-m);" : "";
    const precoAtualNum = Number(r.precoEfetivo);
    const precoAlvoNum = Number(r.precoAlvo);
    let ajusteFmt = "—";
    let ajusteColor = "";
    let ajusteIcon = "";
    if (Number.isFinite(precoAtualNum) && Number.isFinite(precoAlvoNum) && precoAtualNum > 0) {
      const delta = precoAlvoNum - precoAtualNum;
      const deltaPct = (delta / precoAtualNum) * 100;
      if (Math.abs(deltaPct) < 0.5) {
        ajusteFmt = "Manter";
        ajusteColor = "color:var(--vf-text-m);";
        ajusteIcon = "=";
      } else if (delta > 0) {
        ajusteFmt = `+${brlFormatter.format(delta)} (${pctFormatter.format(deltaPct)}%)`;
        ajusteColor = "color:var(--vf-success);";
        ajusteIcon = "↑";
      } else {
        ajusteFmt = `${brlFormatter.format(delta)} (${pctFormatter.format(deltaPct)}%)`;
        ajusteColor = "color:var(--vf-danger);";
        ajusteIcon = "↓";
      }
    }
    const freteFmt =
      r.frete == null || !Number.isFinite(Number(r.frete))
        ? "—"
        : brlFormatter.format(Number(r.frete));

    const lcColor =
      lcFmt === "—" ? "" : (lcNumber > 0 ? "color:var(--vf-success);" : (lcNumber < 0 ? "color:var(--vf-danger);" : ""));
    const mcColor =
      mcFmt === "—" ? "" : (mcNumber > 0 ? "color:var(--vf-success);" : (mcNumber < 0 ? "color:var(--vf-danger);" : ""));

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-family:var(--vf-mono);font-size:.8rem;">
        <button type="button" class="vf-calc-info-btn" data-idx="${PREVIEW_ML_ROWS.indexOf(r)}" style="border:none;background:transparent;cursor:pointer;color:var(--vf-primary);margin-right:4px;" title="Ver cálculo">ⓘ</button>
        ${escapeHTML(r.item_id ?? "—")}
      </td>
      <td style="white-space:normal;line-height:1.35;" title="${escapeHTML(r.titulo ?? "")}">${escapeHTML(r.titulo ?? "—")}</td>
      <td>${escapeHTML(r.status ?? "—")}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;${originalStyle}">${escapeHTML(precoOriginalFmt)}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;${promoStyle}">${escapeHTML(precoPromoFmt)}</td>
      <td style="font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(r.listing_type_id ?? r.tipoAnuncio ?? "—")}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(r.custoProduto ?? "—")}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(r.impostoPercentual ?? "—")}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(freteFmt)}</td>
      <td>${r.temBase ? "Sim" : "Não"}</td>
      <td>${renderDiagnosticoBadge(diag)}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(comissaoFmt)}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;${lcColor}">${escapeHTML(lcFmt)}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;${mcColor}">${escapeHTML(mcFmt)}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(precoAlvoFmt)}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;${ajusteColor}">${ajusteIcon} ${escapeHTML(ajusteFmt)}</td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll(".vf-calc-info-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.getAttribute("data-idx"), 10);
      const linha = PREVIEW_ML_ROWS[idx];
      if (linha) abrirModalCalculo(linha);
    });
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
  PREVIEW_ML_ROWS = Array.isArray(linhas) ? linhas : [];
  PREVIEW_ML_FILTER = "todos";
  PREVIEW_ML_SEARCH = "";
  const searchInput = document.getElementById("precificacao-ml-search");
  if (searchInput) searchInput.value = "";

  renderPreviewMlInsights();
  renderPreviewMlControls();
  renderPreviewMlTable();
  const btnSalvar = document.getElementById("btn-precificacao-ml-salvar");
  if (btnSalvar) {
    btnSalvar.disabled = !(Array.isArray(PREVIEW_ML_ROWS) && PREVIEW_ML_ROWS.length > 0);
  }
}

function resetPreviewMlUI() {
  const empty = document.getElementById("precificacao-ml-preview-empty");
  const box = document.getElementById("precificacao-ml-preview-box");
  const badge = document.getElementById("precificacao-ml-total");
  const pageEl = document.getElementById("precificacao-ml-page");
  const prevBtn = document.getElementById("btn-precificacao-ml-prev");
  const nextBtn = document.getElementById("btn-precificacao-ml-next");
  const tbody = document.getElementById("precificacao-ml-tbody");
  const insights = document.getElementById("precificacao-ml-insights");
  const controls = document.getElementById("precificacao-ml-controls");
  const searchInput = document.getElementById("precificacao-ml-search");
  const filterButtons = document.getElementById("precificacao-ml-filter-buttons");

  if (empty) empty.style.display = "block";
  if (box) box.style.display = "none";
  if (badge) badge.style.display = "none";
  if (pageEl) pageEl.textContent = "Página 1";
  if (prevBtn) prevBtn.disabled = true;
  if (nextBtn) nextBtn.disabled = true;
  if (tbody) tbody.innerHTML = "";
  if (insights) { insights.style.display = "none"; insights.innerHTML = ""; }
  if (controls) controls.style.display = "none";
  if (filterButtons) filterButtons.innerHTML = "";
  if (searchInput) searchInput.value = "";

  PREVIEW_ML_ROWS = [];
  PREVIEW_ML_FILTER = "todos";
  PREVIEW_ML_SEARCH = "";
  const btnSalvar = document.getElementById("btn-precificacao-ml-salvar");
  if (btnSalvar) btnSalvar.disabled = true;
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
  const margemInput = document.getElementById("automacoes-margem");
  const margemRaw = (margemInput?.value ?? "").toString().trim();

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
    if (margemRaw !== "") {
      const margemNumero = Number(margemRaw);
      if (Number.isFinite(margemNumero)) {
        qs.set("margemAlvo", String(margemNumero / 100));
      }
    }
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

async function salvarRelatorioAtual() {
  if (!TOKEN) return;

  const clienteSelect = document.getElementById("automacoes-cliente");
  const baseSelect = document.getElementById("automacoes-base");
  const clienteSlug = clienteSelect?.value || "";
  const baseSlug = baseSelect?.value || "";

  if (!clienteSlug) {
    setStatus("Selecione um cliente para salvar o relatório.", "var(--vf-danger)");
    return;
  }
  if (!baseSlug) {
    setStatus("Selecione uma base para salvar o relatório.", "var(--vf-danger)");
    return;
  }
  if (!Array.isArray(PREVIEW_ML_ROWS) || PREVIEW_ML_ROWS.length === 0) {
    setStatus("Gere uma prévia com dados ML antes de salvar.", "var(--vf-danger)");
    return;
  }

  const margemAlvo = getMargemAlvoDecimalAtual();

  const linhas = PREVIEW_ML_ROWS.map((r) => {
    const diag = diagnosticarLinhaMl(r);
    return {
      item_id: r.item_id ?? null,
      titulo: r.titulo ?? null,
      statusAnuncio: r.status ?? null,
      listingTypeId: r.listing_type_id ?? r.tipoAnuncio ?? null,
      precoOriginal: Number.isFinite(Number(r.precoOriginal)) ? Number(r.precoOriginal) : null,
      precoPromocional: Number.isFinite(Number(r.precoPromocionado)) ? Number(r.precoPromocionado) : null,
      precoEfetivo: Number.isFinite(Number(r.precoEfetivo)) ? Number(r.precoEfetivo) : null,
      custo: Number.isFinite(Number(r.custoProduto)) ? Number(r.custoProduto) : null,
      impostoPercentual: Number.isFinite(Number(r.impostoPercentual)) ? Number(r.impostoPercentual) : null,
      taxaFixa: Number.isFinite(Number(r.taxaFixa)) ? Number(r.taxaFixa) : null,
      frete: Number.isFinite(Number(r.frete)) ? Number(r.frete) : null,
      comissao: Number.isFinite(Number(r.comissaoMarketplace)) ? Number(r.comissaoMarketplace) : null,
      comissaoPercentual: Number.isFinite(Number(r.comissaoPercentual)) ? Number(r.comissaoPercentual) : null,
      lc: Number.isFinite(Number(r.lucroContribuicao)) ? Number(r.lucroContribuicao) : null,
      mc: Number.isFinite(Number(r.margemContribuicao)) ? Number(r.margemContribuicao) : null,
      precoAlvo: Number.isFinite(Number(r.precoAlvo)) ? Number(r.precoAlvo) : null,
      diagnostico: diag.key,
      temBase: !!r.temBase,
    };
  });

  const btn = document.getElementById("btn-precificacao-ml-salvar");
  const labelOriginal = btn ? btn.textContent : "Salvar relatório";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Salvando...";
  }

  try {
    const res = await fetch(`${API_BASE}/automacoes/relatorios`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + TOKEN,
      },
      body: JSON.stringify({
        clienteSlug,
        baseSlug,
        margemAlvo,
        escopo: "pagina_atual",
        linhas,
      }),
    });

    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    setStatus(`Relatório #${json.relatorio_id} salvo com sucesso (${linhas.length} itens).`, "var(--vf-success)");
    if (typeof carregarRelatoriosCliente === "function") {
      carregarRelatoriosCliente(clienteSlug);
    }
  } catch (err) {
    setStatus(err?.message ? `Erro ao salvar relatório: ${err.message}` : "Erro ao salvar relatório.", "var(--vf-danger)");
  } finally {
    if (btn) {
      btn.disabled = !(Array.isArray(PREVIEW_ML_ROWS) && PREVIEW_ML_ROWS.length > 0);
      btn.textContent = labelOriginal;
    }
  }
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

function renderRelatoriosLista(relatorios) {
  const tbody = document.getElementById("vf-relatorios-tbody");
  const wrapper = document.getElementById("vf-relatorios-wrapper");
  const empty = document.getElementById("vf-relatorios-empty");
  const badge = document.getElementById("vf-relatorios-total");
  if (!tbody || !wrapper || !empty || !badge) return;

  tbody.innerHTML = "";

  const lista = Array.isArray(relatorios) ? relatorios : [];
  badge.style.display = "inline-block";
  badge.textContent = String(lista.length);

  if (lista.length === 0) {
    wrapper.style.display = "none";
    empty.style.display = "block";
    empty.innerHTML = `<p>Nenhum relatório salvo para este cliente ainda.</p>`;
    return;
  }

  empty.style.display = "none";
  wrapper.style.display = "block";

  lista.forEach((r) => {
    const tr = document.createElement("tr");
    const mcStyle =
      Number.isFinite(Number(r.mc_media)) && Number(r.mc_media) < 0
        ? "color:var(--vf-danger);"
        : (Number.isFinite(Number(r.mc_media)) && Number(r.mc_media) > 0
            ? "color:var(--vf-success);"
            : "");

    tr.innerHTML = `
      <td style="font-family:var(--vf-mono);font-size:.8rem;">#${escapeHTML(String(r.id))}</td>
      <td>${escapeHTML(formatarDataRelatorio(r.created_at))}</td>
      <td>${escapeHTML(r.base_slug || "—")}</td>
      <td>${escapeHTML(r.escopo || "—")}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(formatarMargemAlvo(r.margem_alvo))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(r.total_itens ?? 0))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;color:var(--vf-danger);">${escapeHTML(String(r.itens_criticos ?? 0))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;color:var(--vf-warning, #d97706);">${escapeHTML(String(r.itens_atencao ?? 0))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;color:var(--vf-success);">${escapeHTML(String(r.itens_saudaveis ?? 0))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(String(r.itens_sem_base ?? 0))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;${mcStyle}">${escapeHTML(formatarMcMedia(r.mc_media))}</td>
      <td>${escapeHTML(r.status || "—")}</td>
      <td>
        <button type="button" class="vf-btn-secondary vf-relatorio-detalhes-btn" data-id="${escapeHTML(String(r.id))}" style="margin:0;padding:.25rem .6rem;font-size:.75rem;">Ver detalhes</button>
        <button type="button" class="vf-btn-secondary vf-relatorio-excluir-btn" data-id="${escapeHTML(String(r.id))}" style="margin:0 0 0 6px;padding:.25rem .6rem;font-size:.75rem;">Excluir</button>
        <button type="button" class="vf-btn-secondary vf-relatorio-csv-btn" data-id="${escapeHTML(String(r.id))}" style="margin:0 0 0 6px;padding:.25rem .6rem;font-size:.75rem;">CSV</button>
        <button type="button" class="vf-btn-secondary vf-relatorio-xlsx-btn" data-id="${escapeHTML(String(r.id))}" style="margin:0 0 0 6px;padding:.25rem .6rem;font-size:.75rem;">XLSX</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".vf-relatorio-detalhes-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      abrirRelatorioDetalhe(id);
    });
  });
  tbody.querySelectorAll(".vf-relatorio-excluir-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      excluirRelatorioSalvo(id);
    });
  });
  tbody.querySelectorAll(".vf-relatorio-csv-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      baixarRelatorioArquivo(id, "csv");
    });
  });
  tbody.querySelectorAll(".vf-relatorio-xlsx-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-id");
      if (!id) return;
      baixarRelatorioArquivo(id, "xlsx");
    });
  });
}

async function carregarRelatoriosCliente(clienteSlug) {
  const card = document.getElementById("vf-relatorios-card");
  const empty = document.getElementById("vf-relatorios-empty");
  const wrapper = document.getElementById("vf-relatorios-wrapper");
  const badge = document.getElementById("vf-relatorios-total");
  if (!card || !empty || !wrapper || !badge) return;

  if (!clienteSlug) {
    card.style.display = "none";
    return;
  }
  if (!TOKEN) return;

  card.style.display = "block";
  wrapper.style.display = "none";
  empty.style.display = "block";
  empty.innerHTML = `<p>Carregando relatórios...</p>`;
  badge.style.display = "none";

  try {
    const qs = new URLSearchParams({ clienteSlug });
    const res = await fetch(`${API_BASE}/automacoes/relatorios?${qs.toString()}`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });

    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    renderRelatoriosLista(json.relatorios || []);
  } catch (err) {
    wrapper.style.display = "none";
    empty.style.display = "block";
    empty.innerHTML = `<p style="color:var(--vf-danger);">Erro ao carregar relatórios: ${escapeHTML(err.message || "desconhecido")}</p>`;
    badge.style.display = "none";
  }
}

function pararPollingDiagnostico() {
  if (DIAG_POLL_TIMER) {
    clearInterval(DIAG_POLL_TIMER);
    DIAG_POLL_TIMER = null;
  }
}

function renderDiagnosticoCompletoEstado(relatorio) {
  const badge = document.getElementById("vf-diagnostico-status-badge");
  const statusText = document.getElementById("vf-diagnostico-status-text");
  const resumo = document.getElementById("vf-diagnostico-resumo");
  const finalBox = document.getElementById("vf-diagnostico-final");
  const progress = document.getElementById("vf-diagnostico-progress");
  const progressBar = document.getElementById("vf-diagnostico-progress-bar");
  const btn = document.getElementById("btn-diagnostico-completo-start");
  if (!badge || !statusText || !resumo || !finalBox || !progress || !progressBar || !btn) return;

  const r = relatorio || {};
  const status = String(r.status || "").toLowerCase();
  const isProcessando = status === "processando";
  const isConcluido = status === "concluido";
  const isErro = status === "erro";

  let tone = "neutral";
  if (isProcessando) tone = "warning";
  if (isConcluido) tone = "success";
  if (isErro) tone = "danger";

  badge.className = `vf-ml-badge vf-ml-badge-${tone}`;
  badge.textContent = isProcessando ? "Processando" : (isConcluido ? "Concluído" : (isErro ? "Erro" : "Aguardando"));

  const total = Number(r.total_itens ?? 0) || 0;
  const comBase = Number(r.itens_com_base ?? 0) || 0;
  const semBase = Number(r.itens_sem_base ?? 0) || 0;
  const criticos = Number(r.itens_criticos ?? 0) || 0;
  const atencao = Number(r.itens_atencao ?? 0) || 0;
  const saudaveis = Number(r.itens_saudaveis ?? 0) || 0;
  const mcMedia = formatarMcMedia(r.mc_media);

  resumo.innerHTML = `
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Total</div><div class="vf-ml-insight-value">${escapeHTML(String(total))}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Com base</div><div class="vf-ml-insight-value">${escapeHTML(String(comBase))}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Sem base</div><div class="vf-ml-insight-value">${escapeHTML(String(semBase))}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Críticos</div><div class="vf-ml-insight-value">${escapeHTML(String(criticos))}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Atenção</div><div class="vf-ml-insight-value">${escapeHTML(String(atencao))}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Saudáveis</div><div class="vf-ml-insight-value">${escapeHTML(String(saudaveis))}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">MC média</div><div class="vf-ml-insight-value">${escapeHTML(mcMedia)}</div></div>
    <div class="vf-ml-insight-card"><div class="vf-ml-insight-label">Relatório</div><div class="vf-ml-insight-value">#${escapeHTML(String(r.id ?? "—"))}</div></div>
  `;
  resumo.style.display = "grid";

  if (isProcessando) {
    const pct = Math.min(95, Math.round(15 + (Math.log10(total + 1) * 35)));
    progress.style.display = "block";
    progressBar.style.width = `${Math.max(8, pct)}%`;
    progressBar.style.background = "var(--vf-primary)";
    statusText.textContent = `Diagnóstico em andamento. Itens processados até agora: ${total}.`;
    finalBox.style.display = "none";
  } else if (isConcluido) {
    progress.style.display = "block";
    progressBar.style.width = "100%";
    progressBar.style.background = "var(--vf-success)";
    statusText.textContent = `Diagnóstico concluído em ${escapeHTML(formatarDataRelatorio(r.created_at))}.`;
    finalBox.style.display = "block";
    finalBox.innerHTML = `<p><strong>Concluído.</strong> Relatório #${escapeHTML(String(r.id || "—"))} finalizado com ${escapeHTML(String(total))} itens.</p>`;
  } else if (isErro) {
    progress.style.display = "block";
    progressBar.style.width = "100%";
    progressBar.style.background = "var(--vf-danger)";
    statusText.textContent = "O diagnóstico terminou com erro.";
    finalBox.style.display = "block";
    finalBox.innerHTML = `<p style="color:var(--vf-danger);"><strong>Erro:</strong> ${escapeHTML(r.observacoes || "Falha durante o processamento.")}</p>`;
  } else {
    progress.style.display = "none";
    progressBar.style.width = "0%";
    statusText.textContent = "Aguardando início do diagnóstico completo.";
    finalBox.style.display = "none";
  }

  btn.disabled = isProcessando;
}

function resetDiagnosticoCompletoUI() {
  pararPollingDiagnostico();
  DIAG_RELATORIO_ID = null;
  DIAG_ULTIMO_RELATORIO = null;

  const badge = document.getElementById("vf-diagnostico-status-badge");
  const statusText = document.getElementById("vf-diagnostico-status-text");
  const resumo = document.getElementById("vf-diagnostico-resumo");
  const finalBox = document.getElementById("vf-diagnostico-final");
  const progress = document.getElementById("vf-diagnostico-progress");
  const progressBar = document.getElementById("vf-diagnostico-progress-bar");
  const btn = document.getElementById("btn-diagnostico-completo-start");
  if (!badge || !statusText || !resumo || !finalBox || !progress || !progressBar || !btn) return;

  const clienteSlug = document.getElementById("automacoes-cliente")?.value || "";
  const baseSlug = document.getElementById("automacoes-base")?.value || "";
  const podeIniciar = Boolean(clienteSlug && baseSlug);

  badge.className = "vf-ml-badge vf-ml-badge-neutral";
  badge.textContent = "Aguardando";
  statusText.textContent = podeIniciar
    ? "Pronto para iniciar um novo diagnóstico completo."
    : "Selecione cliente e base para habilitar.";
  resumo.style.display = "none";
  resumo.innerHTML = "";
  finalBox.style.display = "none";
  finalBox.innerHTML = "";
  progress.style.display = "none";
  progressBar.style.width = "0%";
  progressBar.style.background = "var(--vf-primary)";
  btn.disabled = !podeIniciar;
}

async function carregarDiagnosticoCompleto(relatorioId) {
  if (!relatorioId || !TOKEN) return;

  const res = await fetch(`${API_BASE}/automacoes/diagnostico-completo/${encodeURIComponent(relatorioId)}`, {
    headers: { Authorization: "Bearer " + TOKEN },
  });

  if (res.status === 401) { clearSession(); return; }
  if (res.status === 403) { window.location.replace("dashboard.html"); return; }

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.ok) {
    throw new Error(json?.erro || `HTTP ${res.status}`);
  }

  const anteriorStatus = String(DIAG_ULTIMO_RELATORIO?.status || "").toLowerCase();
  const atual = json.relatorio || {};
  const atualStatus = String(atual.status || "").toLowerCase();

  DIAG_RELATORIO_ID = atual.id || relatorioId;
  DIAG_ULTIMO_RELATORIO = atual;
  renderDiagnosticoCompletoEstado(atual);

  if (atualStatus === "concluido") {
    pararPollingDiagnostico();
    if (anteriorStatus !== "concluido") {
      setStatus(`Diagnóstico completo concluído (relatório #${atual.id}).`, "var(--vf-success)");
      const slug = document.getElementById("automacoes-cliente")?.value || "";
      if (slug) carregarRelatoriosCliente(slug);
    }
  } else if (atualStatus === "erro") {
    pararPollingDiagnostico();
    if (anteriorStatus !== "erro") {
      setStatus("Diagnóstico completo finalizado com erro. Verifique as observações.", "var(--vf-danger)");
    }
  }
}

function iniciarPollingDiagnostico(relatorioId) {
  DIAG_RELATORIO_ID = relatorioId;
  pararPollingDiagnostico();
  carregarDiagnosticoCompleto(relatorioId).catch((err) => {
    setStatus(`Erro ao carregar diagnóstico: ${err.message}`, "var(--vf-danger)");
  });
  DIAG_POLL_TIMER = setInterval(() => {
    carregarDiagnosticoCompleto(relatorioId).catch((err) => {
      pararPollingDiagnostico();
      setStatus(`Erro no polling do diagnóstico: ${err.message}`, "var(--vf-danger)");
      const badge = document.getElementById("vf-diagnostico-status-badge");
      const statusText = document.getElementById("vf-diagnostico-status-text");
      if (badge) {
        badge.className = "vf-ml-badge vf-ml-badge-danger";
        badge.textContent = "Erro";
      }
      if (statusText) statusText.textContent = "Falha ao atualizar o andamento do diagnóstico.";
    });
  }, 3000);
}

async function iniciarDiagnosticoCompleto() {
  if (!TOKEN) return;

  const clienteSlug = document.getElementById("automacoes-cliente")?.value || "";
  const baseSlug = document.getElementById("automacoes-base")?.value || "";
  if (!clienteSlug) {
    setStatus("Selecione um cliente para gerar o diagnóstico completo.", "var(--vf-danger)");
    return;
  }
  if (!baseSlug) {
    setStatus("Selecione uma base para gerar o diagnóstico completo.", "var(--vf-danger)");
    return;
  }

  const btn = document.getElementById("btn-diagnostico-completo-start");
  const labelOriginal = btn ? btn.textContent : "Gerar diagnóstico completo";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Iniciando...";
  }

  try {
    const margemAlvo = getMargemAlvoDecimalAtual();
    const res = await fetch(`${API_BASE}/automacoes/diagnostico-completo/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + TOKEN,
      },
      body: JSON.stringify({
        clienteSlug,
        baseSlug,
        margemAlvo,
      }),
    });

    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }

    const json = await res.json().catch(() => ({}));
    if (res.status === 409) {
      const relatorioId = json?.relatorio_id;
      setStatus(json?.erro || "Já existe um diagnóstico completo em andamento para este cliente.", "var(--vf-text-m)");
      if (relatorioId) iniciarPollingDiagnostico(relatorioId);
      return;
    }
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    setStatus(`Diagnóstico completo iniciado (relatório #${json.relatorio_id}).`, "var(--vf-success)");
    iniciarPollingDiagnostico(json.relatorio_id);
  } catch (err) {
    setStatus(err?.message ? `Erro ao iniciar diagnóstico completo: ${err.message}` : "Erro ao iniciar diagnóstico completo.", "var(--vf-danger)");
  } finally {
    if (btn) btn.textContent = labelOriginal;
    if (!DIAG_ULTIMO_RELATORIO || String(DIAG_ULTIMO_RELATORIO.status || "").toLowerCase() !== "processando") {
      const clienteAtual = document.getElementById("automacoes-cliente")?.value || "";
      const baseAtual = document.getElementById("automacoes-base")?.value || "";
      if (btn) btn.disabled = !(clienteAtual && baseAtual);
    }
  }
}

function atualizarBotoesExportDetalhe() {
  const csvBtn = document.getElementById("btn-relatorio-detalhe-csv");
  const xlsxBtn = document.getElementById("btn-relatorio-detalhe-xlsx");
  const habilitar = Boolean(RELATORIO_DETALHE_ATUAL_ID);
  if (csvBtn) csvBtn.disabled = !habilitar;
  if (xlsxBtn) xlsxBtn.disabled = !habilitar;
}

async function baixarRelatorioArquivo(relatorioId, formato) {
  if (!TOKEN || !relatorioId) return;
  const fmt = formato === "xlsx" ? "xlsx" : "csv";
  try {
    const res = await fetch(`${API_BASE}/automacoes/relatorios/${encodeURIComponent(relatorioId)}/export/${fmt}`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });

    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    const blob = await res.blob();
    const disp = res.headers.get("content-disposition") || "";
    const nomeMatch = disp.match(/filename="?([^"]+)"?/i);
    const filename = nomeMatch?.[1] || `relatorio-${relatorioId}.${fmt}`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    setStatus(err?.message ? `Erro ao exportar relatório: ${err.message}` : "Erro ao exportar relatório.", "var(--vf-danger)");
  }
}

async function excluirRelatorioSalvo(id) {
  if (!id || !TOKEN) return;

  const confirmar = window.confirm("Excluir este relatório salvo? Essa ação não pode ser desfeita.");
  if (!confirmar) return;

  try {
    const res = await fetch(`${API_BASE}/automacoes/relatorios/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + TOKEN },
    });

    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    setStatus(`Relatório #${id} excluído com sucesso.`, "var(--vf-success)");
    const slug = document.getElementById("automacoes-cliente")?.value || "";
    if (slug) carregarRelatoriosCliente(slug);
  } catch (err) {
    setStatus(err?.message ? `Erro ao excluir relatório: ${err.message}` : "Erro ao excluir relatório.", "var(--vf-danger)");
  }
}

function fecharRelatorioDetalheModal() {
  const modal = document.getElementById("vf-relatorio-detalhe-modal");
  if (modal) modal.style.display = "none";
  RELATORIO_DETALHE_ATUAL_ID = null;
  atualizarBotoesExportDetalhe();
}

function diagnosticoLabelDoSalvo(key) {
  switch ((key || "").toLowerCase()) {
    case "critico": return { label: "Crítico", tone: "danger" };
    case "atencao": return { label: "Atenção", tone: "warning" };
    case "saudavel": return { label: "Saudável", tone: "success" };
    case "sem_base": return { label: "Sem base", tone: "neutral" };
    case "sem_frete": return { label: "Sem frete", tone: "warning" };
    case "sem_comissao": return { label: "Sem comissão", tone: "warning" };
    case "sem_dados": return { label: "Sem dados", tone: "neutral" };
    default: return { label: key || "—", tone: "neutral" };
  }
}

function renderRelatorioDetalheResumo(relatorio) {
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
      `<strong>#${escapeHTML(String(relatorio.id))}</strong>`,
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

function renderRelatorioDetalheItens(itens) {
  const tbody = document.getElementById("vf-relatorio-detalhe-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const lista = Array.isArray(itens) ? itens : [];
  if (lista.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="14" style="color:var(--vf-text-m);">Este relatório não possui itens salvos.</td>`;
    tbody.appendChild(tr);
    return;
  }

  const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const fmtMoney = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? brl.format(n) : "—";
  };
  const fmtPctNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? `${pct.format(n)}` : "—";
  };
  const fmtMcFraction = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? `${pct.format(n * 100)}%` : "—";
  };

  lista.forEach((it) => {
    const diag = diagnosticoLabelDoSalvo(it.diagnostico);
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
      <td style="white-space:normal;line-height:1.35;" title="${escapeHTML(it.titulo || "")}">${escapeHTML(it.titulo || "—")}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;${originalStyle}">${escapeHTML(fmtMoney(it.preco_original))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;${promoStyle}">${escapeHTML(promoFmt)}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(fmtMoney(it.preco_efetivo))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(fmtMoney(it.custo))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(fmtPctNum(it.imposto_percentual))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(fmtMoney(it.frete))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(fmtMoney(it.comissao))}</td>
      <td>${it.tem_base ? "Sim" : "Não"}</td>
      <td><span class="vf-ml-badge vf-ml-badge-${diag.tone}">${escapeHTML(diag.label)}</span></td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;${lcColor}">${escapeHTML(fmtMoney(it.lc))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;${mcColor}">${escapeHTML(fmtMcFraction(it.mc))}</td>
      <td style="text-align:right;font-family:var(--vf-mono);font-size:.8rem;">${escapeHTML(fmtMoney(it.preco_alvo))}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function abrirRelatorioDetalhe(id) {
  if (!id || !TOKEN) return;

  const modal = document.getElementById("vf-relatorio-detalhe-modal");
  const loading = document.getElementById("vf-relatorio-detalhe-loading");
  const content = document.getElementById("vf-relatorio-detalhe-content");
  const titulo = document.getElementById("vf-relatorio-detalhe-titulo");
  if (!modal || !loading || !content) return;
  RELATORIO_DETALHE_ATUAL_ID = id;
  atualizarBotoesExportDetalhe();

  if (titulo) titulo.textContent = `Relatório #${id}`;
  modal.style.display = "flex";
  loading.style.display = "block";
  loading.textContent = "Carregando...";
  content.style.display = "none";

  try {
    const res = await fetch(`${API_BASE}/automacoes/relatorios/${encodeURIComponent(id)}`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });

    if (res.status === 401) { clearSession(); return; }
    if (res.status === 403) { window.location.replace("dashboard.html"); return; }

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.ok) {
      throw new Error(json?.erro || `HTTP ${res.status}`);
    }

    const relatorio = json.relatorio || {};
    const itens = json.itens || [];

    if (titulo) {
      titulo.textContent = `Relatório #${relatorio.id || id} — ${relatorio.cliente_slug || "—"}`;
    }

    renderRelatorioDetalheResumo(relatorio);
    renderRelatorioDetalheItens(itens);

    loading.style.display = "none";
    content.style.display = "block";
  } catch (err) {
    loading.style.display = "block";
    loading.innerHTML = `<span style="color:var(--vf-danger);">Erro ao carregar detalhe: ${escapeHTML(err.message || "desconhecido")}</span>`;
    content.style.display = "none";
  }
}

document.getElementById("automacoes-cliente")?.addEventListener("change", (e) => {
  const slug = e.target.value || "";
  resetDiagnosticoCompletoUI();
  if (!slug) {
    setStatus("Selecione um cliente para preparar o contexto.", "var(--vf-text-m)");
    const card = document.getElementById("vf-relatorios-card");
    if (card) card.style.display = "none";
    return;
  }
  setStatus(`Cliente selecionado: ${escapeHTML(slug)} (ações: em breve)`, "var(--vf-success)");
  carregarRelatoriosCliente(slug);
});
document.getElementById("automacoes-base")?.addEventListener("change", () => {
  resetDiagnosticoCompletoUI();
});

document.getElementById("automacoes-cliente-search")?.addEventListener("input", () => {
  applyClienteSearchFilter({ keepValueIfPossible: true });
});
document.getElementById("automacoes-base-search")?.addEventListener("input", () => {
  applyBaseSearchFilter({ keepValueIfPossible: true });
});
document.getElementById("precificacao-ml-search")?.addEventListener("input", (e) => {
  PREVIEW_ML_SEARCH = e.target.value || "";
  renderPreviewMlTable();
});
document.getElementById("automacoes-margem")?.addEventListener("input", () => {
  if (PREVIEW_ML_ROWS.length > 0) {
    renderPreviewMlInsights();
    renderPreviewMlControls();
    renderPreviewMlTable();
  }
});

document.getElementById("btn-precificacao-preview")?.addEventListener("click", previewPrecificacao);
document.getElementById("btn-precificacao-preview-ml")?.addEventListener("click", () => {
  PREVIEW_ML_PAGE = 1;
  previewPrecificacaoMl();
});
document.getElementById("btn-relatorios-refresh")?.addEventListener("click", () => {
  const slug = document.getElementById("automacoes-cliente")?.value || "";
  if (!slug) {
    setStatus("Selecione um cliente para listar relatórios.", "var(--vf-danger)");
    return;
  }
  carregarRelatoriosCliente(slug);
});
document.getElementById("btn-diagnostico-completo-start")?.addEventListener("click", iniciarDiagnosticoCompleto);
document.getElementById("btn-precificacao-ml-salvar")?.addEventListener("click", salvarRelatorioAtual);
document.getElementById("btn-precificacao-ml-prev")?.addEventListener("click", () => {
  PREVIEW_ML_PAGE = Math.max(1, PREVIEW_ML_PAGE - 1);
  previewPrecificacaoMl();
});
document.getElementById("btn-precificacao-ml-next")?.addEventListener("click", () => {
  PREVIEW_ML_PAGE = PREVIEW_ML_PAGE + 1;
  previewPrecificacaoMl();
});
document.getElementById("vf-relatorio-detalhe-close")?.addEventListener("click", fecharRelatorioDetalheModal);
document.getElementById("btn-relatorio-detalhe-csv")?.addEventListener("click", () => {
  if (!RELATORIO_DETALHE_ATUAL_ID) return;
  baixarRelatorioArquivo(RELATORIO_DETALHE_ATUAL_ID, "csv");
});
document.getElementById("btn-relatorio-detalhe-xlsx")?.addEventListener("click", () => {
  if (!RELATORIO_DETALHE_ATUAL_ID) return;
  baixarRelatorioArquivo(RELATORIO_DETALHE_ATUAL_ID, "xlsx");
});
document.getElementById("vf-relatorio-detalhe-modal")?.addEventListener("click", (e) => {
  if (e.target.id === "vf-relatorio-detalhe-modal") fecharRelatorioDetalheModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const modal = document.getElementById("vf-relatorio-detalhe-modal");
    if (modal && modal.style.display !== "none") fecharRelatorioDetalheModal();
  }
});

if (TOKEN) {
  loadClientes();
  loadBases();
  resetDiagnosticoCompletoUI();
}

