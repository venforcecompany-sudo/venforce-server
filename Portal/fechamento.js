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

let marketplaceAtivo = "shopee"; // "shopee" | "meli"

/** Paginação / busca — só afeta exibição */
let tablePage = 1;

// Tabs que NÃO têm dados na planilha Meli (ficam desabilitadas)
const TABS_SEM_DADOS_MELI = new Set(["impressoes", "cliques", "ctr", "conversao"]);

function atualizarTabsParaMarketplace() {
  document.querySelectorAll(".fc-tab").forEach((btn) => {
    const tab = btn.dataset.tab || "";
    const indisponivel = marketplaceAtivo === "meli" && TABS_SEM_DADOS_MELI.has(tab);
    btn.disabled = indisponivel;
    btn.title = indisponivel ? "Dado não disponível na planilha de vendas do Mercado Livre" : "";
    btn.style.opacity = indisponivel ? "0.35" : "";
    btn.style.cursor = indisponivel ? "not-allowed" : "";
  });

  if (marketplaceAtivo === "meli" && TABS_SEM_DADOS_MELI.has(abaAtiva)) {
    abaAtiva = "abc";
    document.querySelectorAll(".fc-tab").forEach((b) => {
      b.classList.toggle("fc-tab-active", b.dataset.tab === "abc");
      b.setAttribute("aria-selected", b.dataset.tab === "abc" ? "true" : "false");
    });
  }
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
  const root = inputEl.closest(".fc-upload-card") || inputEl.parentElement;
  if (!root) return null;

  let span = root.querySelector(".fc-file-name");
  if (!span) {
    span = document.createElement("div");
    span.className = "fc-file-name";
    span.style.margin = "10px 0 0";
    span.style.color = "#a1a1aa";
    span.style.fontSize = "12.5px";
    span.textContent = "Nenhum arquivo selecionado";
    inputEl.insertAdjacentElement("afterend", span);
  }
  return span;
}

function initFechamentoDragDrop(inputId, acceptExt = ".xlsx") {
  const input = document.getElementById(inputId);
  if (!input) return;
  const card = input.closest(".fc-upload-card");
  if (!card) return;

  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    card.classList.add("drag-over");
  });

  card.addEventListener("dragleave", (e) => {
    if (!card.contains(e.relatedTarget)) card.classList.remove("drag-over");
  });

  card.addEventListener("drop", (e) => {
    e.preventDefault();
    card.classList.remove("drag-over");
    const files = e.dataTransfer?.files;
    if (!files?.length) return;

    const valid = Array.from(files).every((f) => f.name.toLowerCase().endsWith(acceptExt));
    if (!valid) {
      let msg = card.querySelector(".fc-upload-reject-msg");
      if (!msg) {
        msg = document.createElement("div");
        msg.className = "fc-upload-reject-msg";
        card.appendChild(msg);
      }
      msg.textContent = `Apenas arquivos ${acceptExt} são aceitos.`;
      setTimeout(() => msg.remove(), 3500);
      card.classList.add("invalid-file");
      setTimeout(() => card.classList.remove("invalid-file"), 600);
      return;
    }
    card.querySelector(".fc-upload-reject-msg")?.remove();
    try {
      const dt = new DataTransfer();
      if (input.multiple) Array.from(files).forEach((f) => dt.items.add(f));
      else dt.items.add(files[0]);
      input.files = dt.files;
    } catch (_) {}
    input.dispatchEvent(new Event("change"));
  });

  input.addEventListener("change", () => {
    card.classList.toggle("has-file", !!(input.files?.length));
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
  document.getElementById("fc-table-toolbar")?.classList.remove("is-visible");
  document.getElementById("fc-pagination-wrap")?.classList.remove("is-visible");
}

function showTableChrome() {
  document.getElementById("fc-table-toolbar")?.classList.add("is-visible");
  document.getElementById("fc-pagination-wrap")?.classList.add("is-visible");
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
  if (v === "A") return '<span class="badge-green">A</span>';
  if (v === "B") return '<span class="badge-yellow">B</span>';
  if (v === "C") return '<span class="badge-red">C</span>';
  return `<span>${escapeHTML(v || "—")}</span>`;
}

function setStatus(msg, tipo) {
  const el = document.getElementById("fechamento-status");
  if (!el) return;
  if (!msg) { el.style.display = "none"; return; }
  el.textContent = msg;
  el.style.display = "block";

  if (tipo === "success") el.style.color = "#047857";
  else if (tipo === "danger") el.style.color = "var(--vf-danger)";
  else if (tipo === "info") el.style.color = "var(--vf-text-m)";
  else el.style.color = "var(--vf-text-m)";
}

function setLoading(on) {
  const btn = document.getElementById("btn-processar");
  if (!btn) return;
  btn.disabled = !!on;
  btn.textContent = on ? "Processando..." : "Analisar planilha única";
}

function limparStats() {
  ["stat-faturamento", "stat-unidades", "stat-pedidos", "stat-produtos"].forEach((id) => {
    const card = document.getElementById(id);
    const v = card?.querySelector?.(".fc-stat-value");
    if (v) v.textContent = "—";
  });
}

function renderResumo() {
  if (!dadosAtuais) return;
  const r = dadosAtuais.resumo || {};

  const faturamentoEl = document.getElementById("stat-faturamento")?.querySelector(".fc-stat-value");
  const unidadesEl = document.getElementById("stat-unidades")?.querySelector(".fc-stat-value");
  const pedidosEl = document.getElementById("stat-pedidos")?.querySelector(".fc-stat-value");
  const produtosEl = document.getElementById("stat-produtos")?.querySelector(".fc-stat-value");

  if (faturamentoEl) faturamentoEl.textContent = brl(r.faturamentoTotal);
  if (unidadesEl) unidadesEl.textContent = num(r.unidadesTotais);
  if (pedidosEl) pedidosEl.textContent = num(r.pedidosTotais);
  if (produtosEl) produtosEl.textContent = num(r.produtosConsiderados);
}

function renderTable(columns, rowsHtml) {
  const th = (Array.isArray(columns) ? columns : []).map((c) => {
    if (c && typeof c === "object" && "html" in c) return String(c.html || "");
    return `<th>${escapeHTML(String(c ?? ""))}</th>`;
  }).join("");
  return `
    <div class="fc-table-scroll">
      <table class="fc-table">
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
      <div class="fc-empty fc-empty-hero">
        <p class="fc-empty-hero-title">Envie uma planilha para gerar a análise.</p>
        <p class="fc-empty" style="margin-top:10px;padding:0;background:none;border:none;">Importe uma planilha de performance ou compile várias para visualizar curvas, rankings e recomendações.</p>
      </div>`;
    return;
  }

  const allRows = getTabRows();
  if (!allRows.length) {
    hideTableChrome();
    el.innerHTML = '<div class="fc-empty">Nenhum dado para exibir nesta aba.</div>';
    return;
  }

  showTableChrome();

  const pageSize = getPageSize();
  const filtered = filterRows(allRows, q);
  let { slice, totalPages, page } = paginateSlice(filtered, tablePage, pageSize);
  tablePage = page;
  const sliceLen = slice.length;

  if (filtered.length === 0 && allRows.length > 0) {
    el.innerHTML = '<div class="fc-empty">Nenhum produto corresponde à busca.</div>';
    updateTableChrome(0, 1, 1, 0, pageSize);
    return;
  }

  updateTableChrome(filtered.length, page, totalPages, sliceLen, pageSize);

  const d = dadosAtuais;

  switch (abaAtiva) {
    case "abc": {
      const cols = [
        { html: '<th>ID</th>' },
        { html: '<th style="text-align:left;">Produto</th>' },
        { html: '<th style="text-align:right;">Fat.</th>' },
        { html: '<th style="text-align:right;">% Fat.</th>' },
        { html: '<th style="text-align:right;">Acum. Fat.</th>' },
        { html: '<th style="text-align:right;">Unid.</th>' },
        { html: '<th style="text-align:right;">% Unid.</th>' },
        { html: '<th style="text-align:right;">Acum. Unid.</th>' },
        { html: '<th style="text-align:center;">Curva Fat</th>' },
        { html: '<th style="text-align:center;">Curva Uni</th>' },
        { html: '<th style="text-align:center;">Final</th>' },
      ];
      const rows = slice.map((r) => {
        const curvaFat = curvaBadge(r.curvaFat || r.curva_fat || r.curvaFaturamento);
        const curvaUni = curvaBadge(r.curvaUni || r.curva_uni || r.curvaUnidades);
        const final = escapeHTML(r.curvaFinal || r.curva_final || r.curva || "—");
        return `
          <tr>
            <td class="fc-td-id">${escapeHTML(r.id ?? r.productId ?? r.produtoId ?? "—")}</td>
            <td class="fc-td-produto">${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
            <td class="fc-td-num">${escapeHTML(brl(r.faturamento ?? r.fat ?? r.faturamentoTotalItem ?? 0))}</td>
            <td class="fc-td-num">${escapeHTML(pct(r.percentualFaturamento ?? r.percFat ?? r.pctFat ?? r.percentualFat ?? 0))}</td>
            <td class="fc-td-num">${escapeHTML(pct(r.acumuladoFaturamento ?? r.acumFat ?? r.acumuladoFat ?? 0))}</td>
            <td class="fc-td-num">${escapeHTML(num(r.unidadesTotais ?? r.unidades ?? r.unid ?? r.unidadesPagas ?? 0))}</td>
            <td class="fc-td-num">${escapeHTML(pct(r.percentualUnidades ?? r.percUnid ?? r.pctUnid ?? r.percentualUnid ?? 0))}</td>
            <td class="fc-td-num">${escapeHTML(pct(r.acumuladoUnidades ?? r.acumUnid ?? r.acumuladoUnid ?? 0))}</td>
            <td class="fc-td-center">${curvaFat}</td>
            <td class="fc-td-center">${curvaUni}</td>
            <td class="fc-td-center"><span style="color:#c4b5fd;font-weight:800">${final}</span></td>
          </tr>
        `;
      }).join("");

      el.innerHTML = `
        <div class="fc-section-title">Curva ABC completa</div>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    case "impressoes": {
      const cols = ["ID", "Produto", "Impressões"];
      const rows = slice.map((r) => `
        <tr>
          <td class="fc-td-id">${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td class="fc-td-produto">${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td class="fc-td-num"><span style="color:#c4b5fd;font-weight:800">${escapeHTML(num(r.valor ?? 0))}</span></td>
        </tr>
      `).join("");
      el.innerHTML = `
        <div class="fc-section-title">Produtos com mais impressões</div>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    case "cliques": {
      const cols = ["ID", "Produto", "Cliques"];
      const rows = slice.map((r) => `
        <tr>
          <td class="fc-td-id">${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td class="fc-td-produto">${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td class="fc-td-num"><span style="color:#c4b5fd;font-weight:800">${escapeHTML(num(r.valor ?? 0))}</span></td>
        </tr>
      `).join("");
      el.innerHTML = `
        <div class="fc-section-title">Produtos com mais cliques</div>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    case "ctr": {
      const cols = ["ID", "Produto", "CTR"];
      const rows = slice.map((r) => `
        <tr>
          <td class="fc-td-id">${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td class="fc-td-produto">${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td class="fc-td-num"><span style="color:#c4b5fd;font-weight:800">${escapeHTML(pct(r.valor ?? 0))}</span></td>
        </tr>
      `).join("");
      el.innerHTML = `
        <div class="fc-section-title">Produtos com maior CTR</div>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    case "conversao": {
      const cols = ["ID", "Produto", "Conversão"];
      const rows = slice.map((r) => `
        <tr>
          <td class="fc-td-id">${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td class="fc-td-produto">${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td class="fc-td-num"><span style="color:#c4b5fd;font-weight:800">${escapeHTML(pct(r.valor ?? 0))}</span></td>
        </tr>
      `).join("");
      el.innerHTML = `
        <div class="fc-section-title">Produtos com maior conversão</div>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    case "kits": {
      const cols = ["ID", "Produto", "Pedidos pagos", "Unidades pagas", "Unid./Pedido", "Recomendação"];
      const rows = slice.map((r) => `
        <tr>
          <td class="fc-td-id">${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td class="fc-td-produto">${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td class="fc-td-num">${escapeHTML(num(r.pedidosPagos ?? r.pedidos ?? 0))}</td>
          <td class="fc-td-num">${escapeHTML(num(r.unidadesPagas ?? r.unidades ?? 0))}</td>
          <td class="fc-td-num"><span style="color:#c4b5fd;font-weight:800">${escapeHTML((r.unidadesPorPedido ?? r.unidPorPedido ?? r.unid_pedido ?? 0).toFixed ? (r.unidadesPorPedido).toFixed(2) : String(r.unidadesPorPedido ?? r.unidPorPedido ?? r.unid_pedido ?? 0))}</span></td>
          <td><span style="color:#86efac;font-weight:700">Criar kit / combo</span></td>
        </tr>
      `).join("");
      el.innerHTML = `
        <div class="fc-section-title">Sugestão de Kits</div>
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

      const src =
        abaAtiva === "adsObrigatorios" ? d.adsObrigatorios
          : abaAtiva === "ads34" ? d.adsPrioridade34
            : d.adsPrioridade24;

      const cols = ["ID", "Produto", "Cliques", "CTR", "Conversão", "Motivo"];
      const rows = slice.map((r) => `
        <tr>
          <td class="fc-td-id">${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td class="fc-td-produto">${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td class="fc-td-num">${escapeHTML(num(r.cliques ?? r.clicks ?? 0))}</td>
          <td class="fc-td-num">${escapeHTML(pct(r.ctr ?? 0))}</td>
          <td class="fc-td-num">${escapeHTML(pct(r.conversao ?? r.conversion ?? 0))}</td>
          <td>${escapeHTML(r.motivo ?? r.reason ?? "—")}</td>
        </tr>
      `).join("");

      el.innerHTML = `
        <div class="fc-section-title">${escapeHTML(title)}</div>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    default:
      hideTableChrome();
      el.innerHTML = '<div class="fc-empty">Nenhum dado para exibir.</div>';
  }
}

async function processarArquivo() {
  if (!TOKEN) return;

  const arquivo = document.getElementById("fechamento-arquivo")?.files?.[0];
  if (!arquivo) {
    setStatus("Selecione um arquivo .xlsx.", "danger");
    return;
  }

  setLoading(true);
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

    const json = await res.json();
    if (!res.ok) throw new Error(json.erro || json.message || "HTTP " + res.status);

    dadosAtuais = json.data;
    tablePage = 1;
    renderResumo();
    renderTabContent();
    setStatus("✓ Processado com sucesso.", "success");
  } catch (err) {
    setStatus("Erro: " + (err?.message || "Falha ao processar."), "danger");
  } finally {
    setLoading(false);
  }
}

async function compilarArquivos() {
  if (!TOKEN) return;

  const input = document.getElementById("fechamento-arquivos");
  const arquivos = input?.files;
  if (!arquivos || arquivos.length === 0) {
    setStatus("Selecione ao menos uma planilha.", "danger");
    return;
  }

  const btnCompilar = document.getElementById("btn-compilar");
  if (btnCompilar) {
    btnCompilar.disabled = true;
    btnCompilar.textContent = "Compilando...";
  }

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

    const json = await res.json();
    if (!res.ok) throw new Error(json.erro || json.message || "HTTP " + res.status);

    dadosAtuais = json.data;
    tablePage = 1;
    renderResumo();
    renderTabContent();
    setStatus("✓ Compilado com sucesso.", "success");
  } catch (err) {
    setStatus("Erro: " + (err?.message || "Falha ao compilar."), "danger");
  } finally {
    if (btnCompilar) {
      btnCompilar.disabled = false;
      btnCompilar.textContent = "Compilar várias planilhas";
    }
  }
}

// Eventos
const inputArquivo = document.getElementById("fechamento-arquivo");
const fileLabelSpan = ensureFileLabelSpan(inputArquivo);

if (inputArquivo) {
  inputArquivo.addEventListener("change", () => {
    const f = inputArquivo.files?.[0];
    if (fileLabelSpan) fileLabelSpan.textContent = f ? f.name : "Nenhum arquivo selecionado";
  });
}

const inputArquivosMulti = document.getElementById("fechamento-arquivos");
const filesMultiLabel = ensureFileLabelSpan(inputArquivosMulti);
if (inputArquivosMulti) {
  inputArquivosMulti.addEventListener("change", () => {
    const n = inputArquivosMulti.files?.length || 0;
    if (filesMultiLabel) {
      filesMultiLabel.textContent = n === 0 ? "Nenhum arquivo selecionado" : `${n} arquivo(s) selecionado(s)`;
    }
  });
}

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

    document.querySelectorAll(".fc-upload-card").forEach((c) => {
      c.classList.remove("has-file", "drag-over");
    });

    const searchEl = document.getElementById("fc-table-search");
    if (searchEl) searchEl.value = "";
    const ps = document.getElementById("fc-page-size");
    if (ps) ps.value = "25";
    tablePage = 1;

    dadosAtuais = null;
    limparStats();

    const el = ensureTabContentEl();
    if (el) el.innerHTML = "";
    hideTableChrome();

    setStatus("", "");
    renderTabContent();
  });
}

document.querySelectorAll(".fc-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab || "abc";
    abaAtiva = tab;
    tablePage = 1;
    const searchEl = document.getElementById("fc-table-search");
    if (searchEl) searchEl.value = "";

    document.querySelectorAll(".fc-tab").forEach((b) => {
      b.classList.remove("fc-tab-active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("fc-tab-active");
    btn.setAttribute("aria-selected", "true");

    renderTabContent();
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

document.querySelectorAll(".fc-mp-pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    const mp = pill.dataset.mp || "shopee";
    marketplaceAtivo = mp;

    document.querySelectorAll(".fc-mp-pill").forEach((p) => {
      p.classList.toggle("fc-mp-active", p.dataset.mp === mp);
    });

    const label = document.getElementById("fc-upload-label-single");
    if (label) {
      label.textContent = mp === "meli"
        ? "Planilha de vendas Mercado Livre"
        : "Planilha de performance Shopee";
    }

    dadosAtuais = null;
    limparStats();
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

limparStats();
renderTabContent();
atualizarTabsParaMarketplace();
