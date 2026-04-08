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

function escapeHTML(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function ensureTabContentEl() {
  let el = document.getElementById("fc-tab-content");
  if (el) return el;

  const host = document.getElementById("fechamento-resultado");
  if (!host) return null;

  el = document.createElement("div");
  el.id = "fc-tab-content";
  host.appendChild(el);
  return el;
}

function ensureFileLabelSpan(inputEl) {
  if (!inputEl) return null;
  const root = inputEl.closest(".fc-upload-card") || inputEl.parentElement;
  if (!root) return null;

  let span = root.querySelector(".fc-file-name");
  if (!span) {
    span = document.createElement("div");
    span.className = "fc-file-name";
    span.style.margin = "8px 0 0";
    span.style.color = "#a1a1aa";
    span.style.fontSize = "12.5px";
    span.textContent = "Escolher arquivo…";
    inputEl.insertAdjacentElement("afterend", span);
  }
  return span;
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
  // columns pode vir como array de strings ou de objetos { html } para permitir <th> com estilos
  const th = (Array.isArray(columns) ? columns : []).map((c) => {
    if (c && typeof c === "object" && "html" in c) return String(c.html || "");
    return `<th>${escapeHTML(String(c ?? ""))}</th>`;
  }).join("");
  return `
    <div class="fc-table-wrap">
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

  if (!dadosAtuais) {
    el.innerHTML = '<div class="fc-empty">Envie a planilha para gerar a análise.</div>';
    return;
  }

  const d = dadosAtuais;

  switch (abaAtiva) {
    case "abc": {
      const arr = Array.isArray(d.curvaAbcCompleta) ? d.curvaAbcCompleta : [];
      if (!arr.length) { el.innerHTML = '<div class="fc-empty">Nenhum dado para exibir.</div>'; return; }

      const cols = [
        { html: '<th style="width:130px;">ID</th>' },
        { html: '<th style="width:260px;text-align:left;">Produto</th>' },
        { html: '<th style="width:110px;text-align:right;">Fat.</th>' },
        { html: '<th style="width:80px;text-align:right;">% Fat.</th>' },
        { html: '<th style="width:90px;text-align:right;">Acum. Fat.</th>' },
        { html: '<th style="width:70px;text-align:right;">Unid.</th>' },
        { html: '<th style="width:80px;text-align:right;">% Unid.</th>' },
        { html: '<th style="width:90px;text-align:right;">Acum. Unid.</th>' },
        { html: '<th style="width:80px;text-align:center;">Curva Fat</th>' },
        { html: '<th style="width:80px;text-align:center;">Curva Uni</th>' },
        { html: '<th style="width:70px;text-align:center;">Final</th>' },
      ];
      const rows = arr.map((r) => {
        const curvaFat = curvaBadge(r.curvaFat || r.curva_fat || r.curvaFaturamento);
        const curvaUni = curvaBadge(r.curvaUni || r.curva_uni || r.curvaUnidades);
        const final = escapeHTML(r.curvaFinal || r.curva_final || r.curva || "—");
        return `
          <tr>
            <td style="width:130px;white-space:nowrap;">${escapeHTML(r.id ?? r.productId ?? r.produtoId ?? "—")}</td>
            <td class="fc-td-produto" style="width:260px;">${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
            <td class="fc-td-num" style="width:110px;">${escapeHTML(brl(r.faturamento ?? r.fat ?? r.faturamentoTotalItem ?? 0))}</td>
            <td class="fc-td-num" style="width:80px;">${escapeHTML(pct(r.percentualFaturamento ?? r.percFat ?? r.pctFat ?? r.percentualFat ?? 0))}</td>
            <td class="fc-td-num" style="width:90px;">${escapeHTML(pct(r.acumuladoFaturamento ?? r.acumFat ?? r.acumuladoFat ?? 0))}</td>
            <td class="fc-td-num" style="width:70px;">${escapeHTML(num(r.unidadesTotais ?? r.unidades ?? r.unid ?? r.unidadesPagas ?? 0))}</td>
            <td class="fc-td-num" style="width:80px;">${escapeHTML(pct(r.percentualUnidades ?? r.percUnid ?? r.pctUnid ?? r.percentualUnid ?? 0))}</td>
            <td class="fc-td-num" style="width:90px;">${escapeHTML(pct(r.acumuladoUnidades ?? r.acumUnid ?? r.acumuladoUnid ?? 0))}</td>
            <td class="fc-td-center" style="width:80px;">${curvaFat}</td>
            <td class="fc-td-center" style="width:80px;">${curvaUni}</td>
            <td class="fc-td-center" style="width:70px;"><span style="color:#c4b5fd;font-weight:800">${final}</span></td>
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
      const arr = Array.isArray(d.produtosMaisImpressoes) ? d.produtosMaisImpressoes : [];
      if (!arr.length) { el.innerHTML = '<div class="fc-empty">Nenhum dado para exibir.</div>'; return; }
      const cols = ["ID", "Produto", "Impressões"];
      const rows = arr.map((r) => `
        <tr>
          <td>${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td>${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td><span style="color:#c4b5fd;font-weight:800">${escapeHTML(num(r.valor ?? 0))}</span></td>
        </tr>
      `).join("");
      el.innerHTML = `
        <div class="fc-section-title">Produtos com mais impressões</div>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    case "cliques": {
      const arr = Array.isArray(d.produtosMaisCliques) ? d.produtosMaisCliques : [];
      if (!arr.length) { el.innerHTML = '<div class="fc-empty">Nenhum dado para exibir.</div>'; return; }
      const cols = ["ID", "Produto", "Cliques"];
      const rows = arr.map((r) => `
        <tr>
          <td>${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td>${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td><span style="color:#c4b5fd;font-weight:800">${escapeHTML(num(r.valor ?? 0))}</span></td>
        </tr>
      `).join("");
      el.innerHTML = `
        <div class="fc-section-title">Produtos com mais cliques</div>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    case "ctr": {
      const arr = Array.isArray(d.produtosMaiorCtr) ? d.produtosMaiorCtr : [];
      if (!arr.length) { el.innerHTML = '<div class="fc-empty">Nenhum dado para exibir.</div>'; return; }
      const cols = ["ID", "Produto", "CTR"];
      const rows = arr.map((r) => `
        <tr>
          <td>${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td>${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td><span style="color:#c4b5fd;font-weight:800">${escapeHTML(pct(r.valor ?? 0))}</span></td>
        </tr>
      `).join("");
      el.innerHTML = `
        <div class="fc-section-title">Produtos com maior CTR</div>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    case "conversao": {
      const arr = Array.isArray(d.produtosMaiorConversao) ? d.produtosMaiorConversao : [];
      if (!arr.length) { el.innerHTML = '<div class="fc-empty">Nenhum dado para exibir.</div>'; return; }
      const cols = ["ID", "Produto", "Conversão"];
      const rows = arr.map((r) => `
        <tr>
          <td>${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td>${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td><span style="color:#c4b5fd;font-weight:800">${escapeHTML(pct(r.valor ?? 0))}</span></td>
        </tr>
      `).join("");
      el.innerHTML = `
        <div class="fc-section-title">Produtos com maior conversão</div>
        ${renderTable(cols, rows)}
      `;
      return;
    }

    case "kits": {
      const arr = Array.isArray(d.sugestaoKits) ? d.sugestaoKits : [];
      if (!arr.length) { el.innerHTML = '<div class="fc-empty">Nenhum dado para exibir.</div>'; return; }
      const cols = ["ID", "Produto", "Pedidos pagos", "Unidades pagas", "Unid./Pedido", "Recomendação"];
      const rows = arr.map((r) => `
        <tr>
          <td>${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td>${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td>${escapeHTML(num(r.pedidosPagos ?? r.pedidos ?? 0))}</td>
          <td>${escapeHTML(num(r.unidadesPagas ?? r.unidades ?? 0))}</td>
          <td><span style="color:#c4b5fd;font-weight:800">${escapeHTML((r.unidadesPorPedido ?? r.unidPorPedido ?? r.unid_pedido ?? 0).toFixed ? (r.unidadesPorPedido).toFixed(2) : String(r.unidadesPorPedido ?? r.unidPorPedido ?? r.unid_pedido ?? 0))}</span></td>
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

      const arr = Array.isArray(src) ? src : [];
      if (!arr.length) { el.innerHTML = '<div class="fc-empty">Nenhum dado para exibir.</div>'; return; }

      const cols = ["ID", "Produto", "Cliques", "CTR", "Conversão", "Motivo"];
      const rows = arr.map((r) => `
        <tr>
          <td>${escapeHTML(r.id ?? r.produtoId ?? "—")}</td>
          <td>${escapeHTML(r.produto ?? r.nome ?? r.titulo ?? "—")}</td>
          <td>${escapeHTML(num(r.cliques ?? r.clicks ?? 0))}</td>
          <td>${escapeHTML(pct(r.ctr ?? 0))}</td>
          <td>${escapeHTML(pct(r.conversao ?? r.conversion ?? 0))}</td>
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
    if (fileLabelSpan) fileLabelSpan.textContent = f ? f.name : "Escolher arquivo…";
  });
}

const btnProcessar = document.getElementById("btn-processar");
if (btnProcessar) btnProcessar.addEventListener("click", processarArquivo);

const btnCompilar = document.getElementById("btn-compilar");
if (btnCompilar) btnCompilar.addEventListener("click", compilarArquivos);

const btnLimpar = document.getElementById("btn-limpar");
if (btnLimpar) {
  btnLimpar.addEventListener("click", () => {
    if (inputArquivo) inputArquivo.value = "";
    if (fileLabelSpan) fileLabelSpan.textContent = "Escolher arquivo…";

    dadosAtuais = null;
    limparStats();

    const el = ensureTabContentEl();
    if (el) el.innerHTML = "";

    setStatus("", "");
  });
}

document.querySelectorAll(".fc-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab || "abc";
    abaAtiva = tab;

    document.querySelectorAll(".fc-tab").forEach((b) => {
      b.classList.remove("fc-tab-active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("fc-tab-active");
    btn.setAttribute("aria-selected", "true");

    renderTabContent();
  });
});

// Estado inicial
limparStats();
renderTabContent();
