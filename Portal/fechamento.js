initLayout();

function brl(v) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v || 0);
}
function pct(v) {
  const val = v || 0;
  return (val * 100).toFixed(2) + "%";
}
function num(v) {
  return new Intl.NumberFormat("pt-BR").format(v || 0);
}
function getToken() {
  const t = localStorage.getItem("vf-token");
  if (!t) { window.location.replace("index.html"); return null; }
  return t;
}

const TOKEN = getToken();
const API_BASE = "https://venforce-server.onrender.com";
let dadosAtuais = null;
let abaAtiva = "abc";
let processamentoAtivo = false;

let marketplaceAtivo = "shopee"; // "shopee" | "meli"

// Estado do último resultado baixável
let _convBlobUrl  = null;
let _convFilename = null;

/** Paginação / busca — só afeta exibição */
let tablePage = 1;

// Tabs que NÃO têm dados na planilha Meli (ficam desabilitadas)
const TABS_SEM_DADOS_MELI = new Set(["impressoes", "cliques", "ctr", "conversao"]);

function atualizarTabsParaMarketplace() {
  document.querySelectorAll(".vf-tab[data-tab]").forEach((btn) => {
    const tab = btn.dataset.tab || "";
    const indisponivel = marketplaceAtivo === "meli" && TABS_SEM_DADOS_MELI.has(tab);
    btn.disabled = indisponivel;
    btn.title = indisponivel ? "Dado não disponível na planilha de vendas do Mercado Livre" : "";
    btn.classList.toggle("is-disabled", indisponivel);
    btn.setAttribute("aria-disabled", indisponivel ? "true" : "false");
  });

  if (marketplaceAtivo === "meli" && TABS_SEM_DADOS_MELI.has(abaAtiva)) {
    abaAtiva = "abc";
  }

  sincronizarTabs();
}

function sincronizarTabs() {
  const panel = document.getElementById("fc-tab-content");
  document.querySelectorAll(".vf-tab[data-tab]").forEach((btn) => {
    const ativo = btn.dataset.tab === abaAtiva;
    btn.classList.toggle("is-active", ativo);
    btn.setAttribute("aria-selected", ativo ? "true" : "false");
    btn.tabIndex = ativo && !btn.disabled ? 0 : -1;
    if (ativo && panel) panel.setAttribute("aria-labelledby", btn.id);
  });
}

function escapeHTML(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function ensureTabContentEl() {
  return document.getElementById("fc-tab-content");
}

function ensureFileLabelSpan(inputEl) {
  if (!inputEl) return null;
  const root = inputEl.closest(".vf-fechamento-upload") || inputEl.parentElement;
  if (!root) return null;

  let span = root.querySelector(".vf-file-item__name");
  if (!span) {
    span = document.createElement("p");
    span.className = "vf-file-item__name";
    span.textContent = "Nenhum arquivo selecionado";
    inputEl.insertAdjacentElement("afterend", span);
  }
  return span;
}

function isValidSpreadsheet(file) {
  return !!file && file.name.toLowerCase().endsWith(".xlsx");
}

function updateFilePresentation(input, message = "") {
  if (!input) return;
  const root = input.closest(".vf-fechamento-upload");
  const dropzone = root?.querySelector(".vf-dropzone");
  const fileItem = root?.querySelector(".vf-file-item");
  const nameEl = root?.querySelector(".vf-file-item__name");
  const infoEl = root?.querySelector(".vf-file-item__info");
  const files = Array.from(input.files || []);
  const hasFiles = files.length > 0;

  dropzone?.classList.toggle("has-file", hasFiles && !message);
  dropzone?.classList.toggle("is-error", !!message);
  fileItem?.classList.toggle("is-error", !!message);
  if (fileItem) fileItem.hidden = !hasFiles && !message;

  if (message) {
    if (nameEl) nameEl.textContent = "Arquivo inválido";
    if (infoEl) infoEl.textContent = message;
    return;
  }

  if (!hasFiles) {
    if (nameEl) nameEl.textContent = "Nenhum arquivo selecionado";
    if (infoEl) infoEl.textContent = input.multiple ? "Arquivos prontos para compilação" : "Arquivo pronto para análise";
    return;
  }

  if (nameEl) {
    nameEl.textContent = input.multiple
      ? `${files.length} arquivo(s) selecionado(s)`
      : files[0].name;
  }
  if (infoEl) {
    infoEl.textContent = input.multiple
      ? files.map((file) => file.name).join(" · ")
      : "Arquivo pronto para análise";
  }
}

function validateInputFiles(input) {
  const files = Array.from(input?.files || []);
  if (!files.length) {
    updateFilePresentation(input);
    return true;
  }
  if (files.some((file) => !isValidSpreadsheet(file))) {
    updateFilePresentation(input, "Apenas arquivos .xlsx são aceitos.");
    setStatus("Apenas arquivos .xlsx são aceitos.", "danger");
    return false;
  }
  if (input.multiple && files.length > 20) {
    updateFilePresentation(input, "Selecione no máximo 20 arquivos.");
    setStatus("A compilação aceita no máximo 20 arquivos.", "danger");
    return false;
  }
  updateFilePresentation(input);
  return true;
}

function initFechamentoDragDrop(inputId, acceptExt = ".xlsx") {
  const input = document.getElementById(inputId);
  if (!input) return;
  const dropzone = input.closest(".vf-fechamento-upload")?.querySelector(".vf-dropzone");
  if (!dropzone) return;

  dropzone.addEventListener("click", () => input.click());
  dropzone.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    input.click();
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dropzone.classList.add("is-dragging");
  });

  dropzone.addEventListener("dragleave", (e) => {
    if (!dropzone.contains(e.relatedTarget)) dropzone.classList.remove("is-dragging");
  });

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("is-dragging");
    const files = e.dataTransfer?.files;
    if (!files?.length) return;

    const valid = Array.from(files).every((f) => f.name.toLowerCase().endsWith(acceptExt));
    if (!valid || (input.multiple && files.length > 20)) {
      const message = !valid
        ? `Apenas arquivos ${acceptExt} são aceitos.`
        : "Selecione no máximo 20 arquivos.";
      updateFilePresentation(input, message);
      setStatus(message, "danger");
      return;
    }

    try {
      const dt = new DataTransfer();
      if (input.multiple) Array.from(files).forEach((f) => dt.items.add(f));
      else dt.items.add(files[0]);
      input.files = dt.files;
    } catch (_) {}
    input.dispatchEvent(new Event("change"));
  });

  input.addEventListener("change", () => {
    validateInputFiles(input);
  });
}

function rowSearchHaystack(r) {
  const parts = [
    r.id, r.productId, r.produtoId,
    r.produto, r.nome, r.titulo,
    r.motivo, r.reason,
  ];
  return parts.filter((x) => x != null && x !== "").map((x) => String(x)).join(" ").toLowerCase();
}

function getTabRows() {
  if (!dadosAtuais) return [];
  const d = dadosAtuais;
  switch (abaAtiva) {
    case "abc": return Array.isArray(d.curvaAbcCompleta) ? d.curvaAbcCompleta : [];
    case "impressoes": return Array.isArray(d.produtosMaisImpressoes) ? d.produtosMaisImpressoes : [];
    case "cliques": return Array.isArray(d.produtosMaisCliques) ? d.produtosMaisCliques : [];
    case "ctr": return Array.isArray(d.produtosMaiorCtr) ? d.produtosMaiorCtr : [];
    case "conversao": return Array.isArray(d.produtosMaiorConversao) ? d.produtosMaiorConversao : [];
    case "kits": return Array.isArray(d.sugestaoKits) ? d.sugestaoKits : [];
    case "adsObrigatorios": return Array.isArray(d.adsObrigatorios) ? d.adsObrigatorios : [];
    case "ads34": return Array.isArray(d.adsPrioridade34) ? d.adsPrioridade34 : [];
    case "ads24": return Array.isArray(d.adsPrioridade24) ? d.adsPrioridade24 : [];
    default: return [];
  }
}

function filterRows(rows, q) {
  const ql = (q || "").trim().toLowerCase();
  if (!ql) return rows.slice();
  return rows.filter((r) => rowSearchHaystack(r).includes(ql));
}

function paginateSlice(rows, page, pageSize) {
  const total = rows.length;
  if (total === 0) return { slice: [], total: 0, totalPages: 1, page: 1 };
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  let p = Math.min(Math.max(1, page), totalPages);
  const start = (p - 1) * pageSize;
  return {
    slice: rows.slice(start, start + pageSize),
    total,
    totalPages,
    page: p,
  };
}

function getPageSize() {
  const n = Number(document.getElementById("fc-page-size")?.value);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

function hideTableChrome() {
  const toolbar = document.getElementById("fc-table-toolbar");
  const pagination = document.getElementById("fc-pagination-wrap");
  if (toolbar) toolbar.hidden = true;
  if (pagination) pagination.hidden = true;
}

function showTableChrome() {
  const toolbar = document.getElementById("fc-table-toolbar");
  const pagination = document.getElementById("fc-pagination-wrap");
  if (toolbar) toolbar.hidden = false;
  if (pagination) pagination.hidden = false;
}

function updateTableChrome(filteredLen, page, totalPages, sliceLen, pageSize) {
  const counter = document.getElementById("fc-table-counter");
  const info = document.getElementById("fc-pagination-info");
  const prev = document.getElementById("fc-page-prev");
  const next = document.getElementById("fc-page-next");
  const start = (page - 1) * pageSize;
  if (counter) {
    counter.textContent =
      filteredLen === 0
        ? "0 produtos"
        : sliceLen > 0
          ? `Mostrando ${start + 1}–${start + sliceLen} de ${filteredLen} produtos`
          : `Mostrando 0 de ${filteredLen} produtos`;
  }
  if (info) info.textContent = `Página ${page} de ${totalPages}`;
  if (prev) prev.disabled = page <= 1;
  if (next) next.disabled = page >= totalPages;
}

function curvaBadge(valor) {
  const v = String(valor || "").toUpperCase();
  if (v === "A") return '<span class="vf-tag is-success">A</span>';
  if (v === "B") return '<span class="vf-tag is-warning">B</span>';
  if (v === "C") return '<span class="vf-tag is-danger">C</span>';
  return `<span>${escapeHTML(v || "—")}</span>`;
}

function setStatus(msg, tipo) {
  const el = document.getElementById("fechamento-status");
  if (!el) return;
  const description = el.querySelector(".vf-banner__description") || el;
  el.classList.remove("is-success", "is-danger", "is-info", "is-warning");
  if (!msg) {
    el.hidden = true;
    description.textContent = "";
    return;
  }
  description.textContent = msg;
  el.classList.add(tipo === "danger" ? "is-danger" : tipo === "success" ? "is-success" : "is-info");
  el.setAttribute("role", tipo === "danger" ? "alert" : "status");
  el.hidden = false;
}

function setLoading(mode, on) {
  processamentoAtivo = !!on;
  const processar = document.getElementById("btn-processar");
  const compilar = document.getElementById("btn-compilar");
  const result = document.getElementById("fc-tab-content");

  [processar, compilar].forEach((button) => {
    if (!button) return;
    button.disabled = !!on;
    button.classList.toggle("is-loading", !!on && button.id === `btn-${mode}`);
    button.setAttribute("aria-busy", !!on && button.id === `btn-${mode}` ? "true" : "false");
  });

  if (result) result.setAttribute("aria-busy", on ? "true" : "false");
  if (on && result) {
    hideTableChrome();
    result.innerHTML = `
      <div class="vf-loading-state" role="status">
        <span class="vf-spinner" aria-hidden="true"></span>
        <span>${mode === "compilar" ? "Compilando planilhas…" : "Processando planilha…"}</span>
      </div>`;
  }
}

function base64ToBlob(base64, mimeType) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function limparConvBlob() {
  if (_convBlobUrl) { URL.revokeObjectURL(_convBlobUrl); _convBlobUrl = null; }
  _convFilename = null;
  hideConvDownloadButton();
}

function hideConvDownloadButton() {
  const btn = document.getElementById("btn-download-conversao");
  if (btn) btn.hidden = true;
}

function showConvDownloadButton() {
  const btn = ensureConvDownloadButton();
  btn.hidden = false;
}

let _convBtnWired = false;
function ensureConvDownloadButton() {
  let btn = document.getElementById("btn-download-conversao");
  if (!btn) {
    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "btn-download-conversao";
    btn.className = "vf-btn vf-btn--secondary";
    btn.textContent = "Baixar resultado";
    btn.hidden = true;
    const statusEl = document.getElementById("fechamento-status");
    const actionsEl = document.querySelector(".vf-fechamento-actions");
    if (statusEl && statusEl.parentNode) {
      statusEl.parentNode.insertBefore(btn, statusEl.nextSibling);
    } else if (actionsEl) {
      actionsEl.appendChild(btn);
    } else {
      document.body.appendChild(btn);
    }
  }
  if (!_convBtnWired) {
    _convBtnWired = true;
    btn.addEventListener("click", exportConvResultado);
  }
  return btn;
}

function exportConvResultado() {
  if (_convBlobUrl) {
    const a = document.createElement("a");
    a.href = _convBlobUrl;
    a.download = _convFilename || "fechamento-conversao.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }

  const csvEmMemoria = dadosParaCSV(getTabRows());
  const csv = csvEmMemoria || domTabelaParaCSV();
  if (!csv) {
    setStatus("Não há dados disponíveis para download.", "danger");
    return;
  }

  const blobUrl = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = `fechamento-conversao-${abaAtiva}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function dadosParaCSV(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  const headers = Array.from(rows.reduce((set, row) => {
    Object.keys(row || {}).forEach((key) => set.add(key));
    return set;
  }, new Set()));
  if (!headers.length) return "";
  return [
    headers.map(csvCell).join(";"),
    ...rows.map((row) => headers.map((header) => csvCell(row?.[header])).join(";")),
  ].join("\r\n");
}

function domTabelaParaCSV() {
  const table = document.querySelector("#fc-tab-content .vf-table");
  if (!table) return "";
  return Array.from(table.querySelectorAll("tr"))
    .map((row) => Array.from(row.querySelectorAll("th, td")).map((cell) => csvCell(cell.textContent.trim())).join(";"))
    .filter(Boolean)
    .join("\r\n");
}

function limparStats() {
  ["stat-faturamento", "stat-unidades", "stat-pedidos", "stat-produtos"].forEach((id) => {
    const card = document.getElementById(id);
    const v = card?.querySelector?.(".vf-kpi__value");
    if (v) v.textContent = "—";
  });
}

function renderResumo() {
  if (!dadosAtuais) return;
  const r = dadosAtuais.resumo || {};

  const faturamentoEl = document.getElementById("stat-faturamento")?.querySelector(".vf-kpi__value");
  const unidadesEl = document.getElementById("stat-unidades")?.querySelector(".vf-kpi__value");
  const pedidosEl = document.getElementById("stat-pedidos")?.querySelector(".vf-kpi__value");
  const produtosEl = document.getElementById("stat-produtos")?.querySelector(".vf-kpi__value");

  if (faturamentoEl) faturamentoEl.textContent = brl(r.faturamentoTotal);
  if (unidadesEl) unidadesEl.textContent = num(r.unidadesTotais);
  if (pedidosEl) pedidosEl.textContent = num(r.pedidosTotais);
  if (produtosEl) produtosEl.textContent = num(r.produtosConsiderados);
}

function renderTable(columns, rowsHtml) {
  const normalizedColumns = Array.isArray(columns) ? columns : [];
  const th = normalizedColumns.map((c) => {
    const column = c && typeof c === "object" ? c : { label: c };
    const className = column.className ? ` class="${escapeHTML(column.className)}"` : "";
    return `<th scope="col"${className}>${escapeHTML(String(column.label ?? ""))}</th>`;
  }).join("");
  return `
    <div class="vf-table-wrap">
      <table class="vf-table vf-table--compact${normalizedColumns.length > 6 ? " vf-fechamento-table--wide" : ""}">
        <thead>
          <tr>${th}</tr>
        </thead>
        <tbody>
          ${rowsHtml || ""}
        </tbody>
      </table>
    </div>
  `;
}

function renderTabContent() {
  const el = ensureTabContentEl();
  if (!el) return;

  const q = (document.getElementById("fc-table-search")?.value || "").trim();

  if (!dadosAtuais) {
    hideTableChrome();
    el.innerHTML = `
      <div class="vf-empty">
        <span class="vf-empty__icon is-primary" aria-hidden="true">XLSX</span>
        <h3 class="vf-empty__title">Envie uma planilha para gerar a análise</h3>
        <p class="vf-empty__description">Importe uma planilha de performance ou compile várias para visualizar curvas, rankings e recomendações.</p>
      </div>`;
    return;
  }

  const allRows = getTabRows();
  if (!allRows.length) {
    hideTableChrome();
    el.innerHTML = `
      <div class="vf-empty">
        <span class="vf-empty__icon" aria-hidden="true">—</span>
        <h3 class="vf-empty__title">Esta aba não possui dados</h3>
        <p class="vf-empty__description">O arquivo processado não retornou informações para esta análise.</p>
      </div>`;
    return;
  }

  showTableChrome();

  const pageSize = getPageSize();
  const filtered = filterRows(allRows, q);
  let { slice, totalPages, page } = paginateSlice(filtered, tablePage, pageSize);
  tablePage = page;
  const sliceLen = slice.length;

  if (filtered.length === 0 && allRows.length > 0) {
    el.innerHTML = `
      <div class="vf-empty">
        <span class="vf-empty__icon" aria-hidden="true">⌕</span>
        <h3 class="vf-empty__title">Nenhum produto encontrado</h3>
        <p class="vf-empty__description">Revise o ID ou nome informado na busca.</p>
      </div>`;
    updateTableChrome(0, 1, 1, 0, pageSize);
    return;
  }

  updateTableChrome(filtered.length, page, totalPages, sliceLen, pageSize);

  const d = dadosAtuais;

  switch (abaAtiva) {
    case "abc": {
      const cols = [
        { label: "ID", className: "vf-mono" },
        "Produto",
        { label: "Fat.", className: "num" },
        { label: "% Fat.", className: "num" },
        { label: "Acum. Fat.", className: "num" },
        { label: "Unid.", className: "num" },
        { label: "% Unid.", className: "num" },
        { label: "Acum. Unid.", className: "num" },
        { label: "Curva Fat", className: "vf-fechamento-cell-center" },
        { label: "Curva Uni", className: "vf-fechamento-cell-center" },
        { label: "Final", className: "vf-fechamento-cell-center" },
      ];
      const rows = slice.map((r) => {
        const curvaFat = curvaBadge(r.curvaFat || r.curva_fat || r.curvaFaturamento);
        const curvaUni = curvaBadge(r.curvaUni || r.curva_uni || r.curvaUnidades);
        const final = escapeHTML(r.curvaFinal || r.curva_final || r.curva || "—");
        return `
          <tr>
            <td class="vf-mono">${escapeHTML(r.id ?? r.productId ?? r.produtoId ?? "—")}</td>
            <td class="vf-fechamento-product">${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
            <td class="num">${escapeHTML(brl(r.faturamento ?? r.fat ?? r.faturamentoTotalItem ?? 0))}</td>
            <td class="num">${escapeHTML(pct(r.percentualFaturamento ?? r.percFat ?? r.pctFat ?? r.percentualFat ?? 0))}</td>
            <td class="num">${escapeHTML(pct(r.acumuladoFaturamento ?? r.acumFat ?? r.acumuladoFat ?? 0))}</td>
            <td class="num">${escapeHTML(num(r.unidadesTotais ?? r.unidades ?? r.unid ?? r.unidadesPagas ?? 0))}</td>
            <td class="num">${escapeHTML(pct(r.percentualUnidades ?? r.percUnid ?? r.pctUnid ?? r.percentualUnid ?? 0))}</td>
            <td class="num">${escapeHTML(pct(r.acumuladoUnidades ?? r.acumUnid ?? r.acumuladoUnid ?? 0))}</td>
            <td class="vf-fechamento-cell-center">${curvaFat}</td>
            <td class="vf-fechamento-cell-center">${curvaUni}</td>
            <td class="vf-fechamento-cell-center"><span class="vf-fechamento-emphasis">${final}</span></td>
          </tr>
        `;
      }).join("");

      el.innerHTML = `
        <h3 class="vf-fechamento-table-title">Curva ABC completa</h3>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    case "impressoes": {
      const cols = ["ID", "Produto", "Impressões"];
      const rows = slice.map((r) => `
        <tr>
          <td class="vf-mono">${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td class="vf-fechamento-product">${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td class="num vf-fechamento-emphasis">${escapeHTML(num(r.valor ?? 0))}</td>
        </tr>
      `).join("");
      el.innerHTML = `
        <h3 class="vf-fechamento-table-title">Produtos com mais impressões</h3>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    case "cliques": {
      const cols = ["ID", "Produto", "Cliques"];
      const rows = slice.map((r) => `
        <tr>
          <td class="vf-mono">${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td class="vf-fechamento-product">${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td class="num vf-fechamento-emphasis">${escapeHTML(num(r.valor ?? 0))}</td>
        </tr>
      `).join("");
      el.innerHTML = `
        <h3 class="vf-fechamento-table-title">Produtos com mais cliques</h3>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    case "ctr": {
      const cols = ["ID", "Produto", "CTR"];
      const rows = slice.map((r) => `
        <tr>
          <td class="vf-mono">${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td class="vf-fechamento-product">${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td class="num vf-fechamento-emphasis">${escapeHTML(pct(r.valor ?? 0))}</td>
        </tr>
      `).join("");
      el.innerHTML = `
        <h3 class="vf-fechamento-table-title">Produtos com maior CTR</h3>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    case "conversao": {
      const cols = ["ID", "Produto", "Conversão"];
      const rows = slice.map((r) => `
        <tr>
          <td class="vf-mono">${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td class="vf-fechamento-product">${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td class="num vf-fechamento-emphasis">${escapeHTML(pct(r.valor ?? 0))}</td>
        </tr>
      `).join("");
      el.innerHTML = `
        <h3 class="vf-fechamento-table-title">Produtos com maior conversão</h3>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    case "kits": {
      const cols = ["ID", "Produto", "Pedidos pagos", "Unidades pagas", "Unid./Pedido", "Recomendação"];
      const rows = slice.map((r) => {
        const unidadesPorPedido = Number(r.unidadesPorPedido ?? r.unidPorPedido ?? r.unid_pedido ?? 0);
        return `
          <tr>
            <td class="vf-mono">${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
            <td class="vf-fechamento-product">${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
            <td class="num">${escapeHTML(num(r.pedidosPagos ?? r.pedidos ?? 0))}</td>
            <td class="num">${escapeHTML(num(r.unidadesPagas ?? r.unidades ?? 0))}</td>
            <td class="num vf-fechamento-emphasis">${escapeHTML(Number.isFinite(unidadesPorPedido) ? unidadesPorPedido.toFixed(2) : "0,00")}</td>
            <td><span class="vf-status is-success">Criar kit / combo</span></td>
          </tr>`;
      }).join("");
      el.innerHTML = `
        <h3 class="vf-fechamento-table-title">Sugestão de Kits</h3>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    case "adsObrigatorios":
    case "ads34":
    case "ads24": {
      const title =
        abaAtiva === "adsObrigatorios" ? "ADS Obrigatórios"
          : abaAtiva === "ads34" ? "ADS Prioridade 3/4"
            : "ADS Prioridade 2/4";

      const cols = ["ID", "Produto", "Cliques", "CTR", "Conversão", "Motivo"];
      const rows = slice.map((r) => `
        <tr>
          <td class="vf-mono">${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td class="vf-fechamento-product">${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td class="num">${escapeHTML(num(r.cliques ?? r.clicks ?? 0))}</td>
          <td class="num">${escapeHTML(pct(r.ctr ?? 0))}</td>
          <td class="num">${escapeHTML(pct(r.conversao ?? r.conversion ?? 0))}</td>
          <td>${escapeHTML(r.motivo ?? r.reason ?? "—")}</td>
        </tr>
      `).join("");

      el.innerHTML = `
        <h3 class="vf-fechamento-table-title">${escapeHTML(title)}</h3>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    default:
      hideTableChrome();
      el.innerHTML = '<div class="vf-empty"><h3 class="vf-empty__title">Nenhum dado para exibir</h3></div>';
  }
}

async function processarArquivo() {
  if (!TOKEN || processamentoAtivo) return;

  const input = document.getElementById("fechamento-arquivo");
  const arquivo = input?.files?.[0];
  if (!arquivo) {
    setStatus("Selecione um arquivo .xlsx.", "danger");
    return;
  }
  if (!validateInputFiles(input)) return;

  limparConvBlob();
  setLoading("processar", true);
  setStatus("Processando...", "info");

  try {
    const formData = new FormData();
    formData.append("marketplace", marketplaceAtivo);
    formData.append("file", arquivo);

    const res = await fetch(`${API_BASE}/fechamentos/upload`, {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN },
      body: formData
    });

    if (res.status === 401) { window.location.replace("index.html"); return; }
    if (res.status === 403) throw new Error("Você não tem permissão para processar esta planilha.");

    const json = await res.json();
    if (!res.ok) throw new Error(json.erro || json.message || "HTTP " + res.status);

    dadosAtuais = (json.data && typeof json.data === "object") ? json.data : json;
    tablePage = 1;
    renderResumo();
    renderTabContent();
    setStatus("✓ Processado com sucesso.", "success");

    const b64 = json.excelBase64 || json.data?.excelBase64;
    if (b64) {
      _convBlobUrl = URL.createObjectURL(
        base64ToBlob(b64, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      );
      const hoje = new Date().toISOString().slice(0, 10);
      _convFilename = `fechamento-conversao-${hoje}.xlsx`;
    }
    showConvDownloadButton();
  } catch (err) {
    setStatus("Erro: " + (err?.message || "Falha ao processar."), "danger");
    renderTabContent();
  } finally {
    setLoading("processar", false);
  }
}

async function compilarArquivos() {
  if (!TOKEN || processamentoAtivo) return;

  const input = document.getElementById("fechamento-arquivos");
  const arquivos = input?.files;
  if (!arquivos || arquivos.length === 0) {
    setStatus("Selecione ao menos uma planilha.", "danger");
    return;
  }
  if (!validateInputFiles(input)) return;

  limparConvBlob();
  setLoading("compilar", true);
  setStatus("Compilando planilhas...", "info");

  try {
    const formData = new FormData();
    formData.append("marketplace", marketplaceAtivo);
    Array.from(arquivos).forEach((arquivo) => {
      formData.append("files", arquivo);
    });

    const res = await fetch("https://venforce-server.onrender.com/fechamentos/compilar", {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN },
      body: formData
    });

    if (res.status === 401) { window.location.replace("index.html"); return; }
    if (res.status === 403) throw new Error("Você não tem permissão para compilar estas planilhas.");

    const json = await res.json();
    if (!res.ok) throw new Error(json.erro || json.message || "HTTP " + res.status);

    dadosAtuais = (json.data && typeof json.data === "object") ? json.data : json;
    tablePage = 1;
    renderResumo();
    renderTabContent();
    setStatus("✓ Compilado com sucesso.", "success");

    const b64 = json.excelBase64 || json.data?.excelBase64;
    if (b64) {
      _convBlobUrl = URL.createObjectURL(
        base64ToBlob(b64, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      );
      const hoje = new Date().toISOString().slice(0, 10);
      _convFilename = `fechamento-conversao-${hoje}.xlsx`;
    }
    showConvDownloadButton();
  } catch (err) {
    setStatus("Erro: " + (err?.message || "Falha ao compilar."), "danger");
    renderTabContent();
  } finally {
    setLoading("compilar", false);
  }
}

// Eventos
const inputArquivo = document.getElementById("fechamento-arquivo");
const fileLabelSpan = ensureFileLabelSpan(inputArquivo);
const inputArquivosMulti = document.getElementById("fechamento-arquivos");
const filesMultiLabel = ensureFileLabelSpan(inputArquivosMulti);

initFechamentoDragDrop("fechamento-arquivo", ".xlsx");
initFechamentoDragDrop("fechamento-arquivos", ".xlsx");

const btnProcessar = document.getElementById("btn-processar");
if (btnProcessar) btnProcessar.addEventListener("click", processarArquivo);

const btnCompilar = document.getElementById("btn-compilar");
if (btnCompilar) btnCompilar.addEventListener("click", compilarArquivos);

const btnLimpar = document.getElementById("btn-limpar");
if (btnLimpar) {
  btnLimpar.addEventListener("click", () => {
    if (inputArquivo) inputArquivo.value = "";
    if (fileLabelSpan) fileLabelSpan.textContent = "Nenhum arquivo selecionado";
    if (inputArquivosMulti) inputArquivosMulti.value = "";
    if (filesMultiLabel) filesMultiLabel.textContent = "Nenhum arquivo selecionado";
    updateFilePresentation(inputArquivo);
    updateFilePresentation(inputArquivosMulti);

    const searchEl = document.getElementById("fc-table-search");
    if (searchEl) searchEl.value = "";
    const ps = document.getElementById("fc-page-size");
    if (ps) ps.value = "25";
    tablePage = 1;

    dadosAtuais = null;
    limparConvBlob();
    limparStats();

    const el = ensureTabContentEl();
    if (el) el.innerHTML = "";
    hideTableChrome();

    setStatus("", "");
    renderTabContent();
  });
}

document.querySelectorAll(".vf-tab[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    const tab = btn.dataset.tab || "abc";
    abaAtiva = tab;
    tablePage = 1;
    const searchEl = document.getElementById("fc-table-search");
    if (searchEl) searchEl.value = "";

    sincronizarTabs();
    renderTabContent();
  });

  btn.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const available = Array.from(document.querySelectorAll(".vf-tab[data-tab]:not(:disabled)"));
    const currentIndex = available.indexOf(btn);
    if (currentIndex < 0) return;
    event.preventDefault();
    let nextIndex = currentIndex;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + available.length) % available.length;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % available.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = available.length - 1;
    available[nextIndex].focus();
    available[nextIndex].click();
  });
});

let searchDebounce;
document.getElementById("fc-table-search")?.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    tablePage = 1;
    renderTabContent();
  }, 160);
});

document.getElementById("fc-page-size")?.addEventListener("change", () => {
  tablePage = 1;
  renderTabContent();
});

document.getElementById("fc-page-prev")?.addEventListener("click", () => {
  if (tablePage <= 1) return;
  tablePage -= 1;
  renderTabContent();
});

document.getElementById("fc-page-next")?.addEventListener("click", () => {
  tablePage += 1;
  renderTabContent();
});

document.querySelectorAll(".vf-segmented__item[data-mp]").forEach((pill) => {
  pill.addEventListener("click", () => {
    const mp = pill.dataset.mp || "shopee";
    marketplaceAtivo = mp;

    document.querySelectorAll(".vf-segmented__item[data-mp]").forEach((p) => {
      const active = p.dataset.mp === mp;
      p.classList.toggle("is-active", active);
      p.setAttribute("aria-pressed", active ? "true" : "false");
    });

    const label = document.getElementById("fc-upload-label-single");
    if (label) {
      label.textContent = mp === "meli"
        ? "Planilha de vendas Mercado Livre"
        : "Planilha de performance Shopee";
    }

    dadosAtuais = null;
    limparConvBlob();
    limparStats();
    if (inputArquivo) inputArquivo.value = "";
    if (inputArquivosMulti) inputArquivosMulti.value = "";
    updateFilePresentation(inputArquivo);
    updateFilePresentation(inputArquivosMulti);
    tablePage = 1;
    const searchEl = document.getElementById("fc-table-search");
    if (searchEl) searchEl.value = "";

    const el = ensureTabContentEl();
    if (el) el.innerHTML = "";
    hideTableChrome();

    setStatus("", "");

    atualizarTabsParaMarketplace();
    renderTabContent();
  });
});

ensureConvDownloadButton();

limparStats();
renderTabContent();
atualizarTabsParaMarketplace();
