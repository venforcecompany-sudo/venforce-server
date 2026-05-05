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

const TOKEN = localStorage.getItem("vf-token");
if (!TOKEN) window.location.replace("index.html");
const API_BASE = "https://venforce-server.onrender.com";

// Último fechamento processado (snapshot para entrega ao cliente)
let ultimoFechamentoFinanceiro = null;

function escapeHTML(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function setStatus(msg, tipo) {
  const el = document.getElementById("fin-status");
  if (!el) return;
  if (!msg) { el.style.display = "none"; return; }
  el.textContent = msg;
  el.style.display = "block";

  if (tipo === "success") el.style.color = "#047857";
  else if (tipo === "danger") el.style.color = "var(--vf-danger)";
  else if (tipo === "info") el.style.color = "var(--vf-text-m)";
  else el.style.color = "var(--vf-text-m)";
}

function setStatusLinkCliente(msg, tipo) {
  const el = document.getElementById("fin-link-cliente-status");
  if (!el) return;
  if (!msg) { el.style.display = "none"; return; }
  el.textContent = msg;
  el.style.display = "block";
  if (tipo === "success") el.style.color = "#86efac";
  else if (tipo === "danger") el.style.color = "#f87171";
  else if (tipo === "info") el.style.color = "#a1a1aa";
  else el.style.color = "#a1a1aa";
}

function showLinkClienteActions(show) {
  const host = document.getElementById("fin-link-cliente-actions");
  if (!host) return;
  host.style.display = show ? "" : "none";
}

function setLinkClienteOutput(url) {
  const input = document.getElementById("fin-link-cliente-output");
  const btnCopiar = document.getElementById("btn-fin-copiar-link-cliente");
  const btnAbrir = document.getElementById("btn-fin-abrir-link-cliente");
  if (input) input.value = url || "";
  const enable = !!url;
  if (btnCopiar) btnCopiar.disabled = !enable;
  if (btnAbrir) btnAbrir.disabled = !enable;
}

function formatDateTimePtBR(d) {
  try { return new Date(d).toLocaleString("pt-BR"); } catch { return ""; }
}

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickFirstKey(obj, candidates) {
  if (!obj || typeof obj !== "object") return null;
  const keys = Object.keys(obj);
  const lowerKeys = keys.map((k) => ({ k, l: k.toLowerCase() }));
  for (const c of candidates) {
    const cLower = String(c).toLowerCase();
    const hit = lowerKeys.find((x) => x.l === cLower);
    if (hit) return hit.k;
  }
  return null;
}

function pickKeyByIncludes(obj, includesAny) {
  if (!obj || typeof obj !== "object") return null;
  const keys = Object.keys(obj);
  const lower = keys.map((k) => ({ k, l: k.toLowerCase() }));
  for (const inc of includesAny) {
    const incLower = String(inc).toLowerCase();
    const hit = lower.find((x) => x.l.includes(incLower));
    if (hit) return hit.k;
  }
  return null;
}

function montarPayloadFechamentoCliente(data) {
  const summary = data?.summary || {};
  const meta = data?._vf_meta || {};

  const gross = safeNumber(summary.grossRevenueTotal);
  const net = safeNumber(summary.paidRevenueTotal);
  const lcTotal = safeNumber(summary.contributionProfitTotal);
  const mcMedia = safeNumber(summary.averageContributionMargin);
  const tacos = safeNumber(summary.tacos);
  const refundsTotal = safeNumber(summary.refundsTotal);
  const refundsCount = safeNumber(summary.refundsCount);
  const finalResult = safeNumber(summary.finalResult);

  const lostRevenueTotal = safeNumber(summary.lostRevenueTotal);
  const faturamentoPerdido = lostRevenueTotal > 0 ? -lostRevenueTotal : 0;

  const resumoExecutivo = [
    `Fechamento financeiro processado para ${String(meta.marketplace || "").toUpperCase()} em ${formatDateTimePtBR(meta.dataGeracao)}.`,
    `Receita bruta: ${brl(gross)} · Receita líquida: ${brl(net)} · LC total: ${brl(lcTotal)} · MC média: ${pct(mcMedia)}.`,
    `Resultado final (após ADS/Venforce/Afiliados): ${brl(finalResult)} · TACoS: ${pct(tacos)}.`,
  ].join(" ");

  const cards = [
    { titulo: "Resultado Final", valor: brl(finalResult), destaque: true, raw: finalResult },
    { titulo: "Receita Bruta", valor: brl(gross), raw: gross },
    { titulo: "Receita Líquida", valor: brl(net), raw: net },
    { titulo: "LC Total", valor: brl(lcTotal), raw: lcTotal },
    { titulo: "MC Média", valor: pct(mcMedia), raw: mcMedia, tipoValor: "pct" },
    { titulo: "TACoS", valor: pct(tacos), raw: tacos, tipoValor: "pct" },
    { titulo: "Reembolsos / Cancelamentos", valor: `${brl(refundsTotal)} (${num(refundsCount)})`, raw: refundsTotal },
    { titulo: "Faturamento perdido", valor: brl(faturamentoPerdido), raw: faturamentoPerdido },
  ];

  const secoes = [];

  const unmatched = Array.isArray(data?.unmatchedIds) ? data.unmatchedIds : [];
  if (unmatched.length > 0) {
    secoes.push({
      tipo: "atencao",
      titulo: "Produtos sem custo cadastrado",
      texto: `Há ${unmatched.length} ID(s) que não foram encontrados na planilha/base de custos. Receita ignorada: ${brl(data?.ignoredRevenue || 0)}.`,
      bullets: unmatched.slice(0, 30).map((x) => String(x)),
    });
  }

  if (refundsCount > 0) {
    secoes.push({
      tipo: "atencao",
      titulo: "Cancelamentos / reembolsos",
      texto: `Foram identificados ${num(refundsCount)} cancelamento(s)/reembolso(s), totalizando ${brl(refundsTotal)}.`,
    });
  }

  if (safeNumber(summary.lostRevenueTotal) > 0) {
    secoes.push({
      tipo: "atencao",
      titulo: "Faturamento perdido",
      texto: `O faturamento perdido estimado (produtos cancelados) foi de ${brl(faturamentoPerdido)}.`,
    });
  }

  if (mcMedia <= 0.02) {
    secoes.push({
      tipo: "atencao",
      titulo: "Margem de contribuição baixa",
      texto: `A MC média está em ${pct(mcMedia)}. Isso indica pressão de custos/comissões/frete ou necessidade de revisão de preços.`,
    });
  }

  const tabelas = [];
  const detailed = Array.isArray(data?.detailedRows) ? data.detailedRows : [];
  if (detailed.length > 0) {
    const sample = detailed.slice(0, 30);
    const first = sample[0] || {};

    const colProduto =
      pickFirstKey(first, ["item_id", "produto_id", "id", "sku"]) ||
      pickKeyByIncludes(first, ["item", "produto", "sku", "id"]);
    const colTitulo =
      pickFirstKey(first, ["titulo", "title", "nome"]) ||
      pickKeyByIncludes(first, ["titul", "nome", "descr"]);
    const colPreco =
      pickFirstKey(first, ["preco_efetivo", "preco", "preço", "price"]) ||
      pickKeyByIncludes(first, ["preco", "price"]);
    const colMc =
      pickFirstKey(first, ["mc", "margem"]) ||
      pickKeyByIncludes(first, ["mc", "margem"]);
    const colLc =
      pickFirstKey(first, ["lc", "lucro", "contribution"]) ||
      pickKeyByIncludes(first, ["lc", "lucro", "contrib"]);
    const colDiagnostico =
      pickFirstKey(first, ["diagnostico", "diagnóstico", "status"]) ||
      pickKeyByIncludes(first, ["diagn", "status"]);

    const cols = [colProduto, colTitulo, colPreco, colLc, colMc, colDiagnostico].filter(Boolean);
    const uniqueCols = Array.from(new Set(cols));

    const linhas = sample.map((row) => {
      const o = {};
      uniqueCols.forEach((k) => { o[k] = row?.[k]; });
      return o;
    });

    tabelas.push({
      titulo: "Amostra de itens (top 30)",
      descricao: "A tabela completa fica registrada no sistema; aqui exibimos uma amostra para leitura rápida.",
      colunas: uniqueCols,
      linhas,
      totalOriginal: detailed.length,
    });
  }

  return {
    versao: 1,
    tipo: "fechamento_mensal",
    titulo: "Relatório de Fechamento Financeiro",
    periodo: meta.periodo || "",
    resumoExecutivo,
    cliente: meta.cliente || {},
    cards,
    secoes,
    tabelas,
    graficos: [],
    conclusao: "",
    metadados: {
      geradoEm: meta.dataGeracao || new Date().toISOString(),
      marketplace: meta.marketplace || null,
      ads: meta.ads ?? null,
      venforce: meta.venforce ?? null,
      affiliates: meta.affiliates ?? null,
    },
  };
}

async function gerarLinkClienteFinanceiro() {
  if (!TOKEN) return;
  if (!ultimoFechamentoFinanceiro?.data) {
    setStatusLinkCliente("Processa um fechamento antes de gerar o link.", "danger");
    return;
  }

  const btn = document.getElementById("btn-fin-gerar-link-cliente");
  if (btn) { btn.disabled = true; btn.textContent = "Gerando..."; }
  setStatusLinkCliente("Gerando entrega e publicando…", "info");
  setLinkClienteOutput("");

  try {
    const data = ultimoFechamentoFinanceiro.data;
    const payload = montarPayloadFechamentoCliente(data);

    const criarResp = await fetch(`${API_BASE}/entregas-cliente`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: JSON.stringify({
        tipo: "fechamento_mensal",
        titulo: payload.titulo || "Relatório de Fechamento Financeiro",
        periodo: payload.periodo || "",
        status: "rascunho",
        payload_json: payload,
        origem_tipo: "fechamento_financeiro",
        origem_id: null,
      }),
    });

    if (criarResp.status === 401) { window.location.replace("index.html"); return; }
    const criarJson = await criarResp.json();
    if (!criarResp.ok) throw new Error(criarJson?.erro || criarJson?.error || "Falha ao criar entrega.");

    const entregaId = criarJson?.entrega?.id;
    if (!entregaId) throw new Error("Entrega criada sem id.");

    const pubResp = await fetch(`${API_BASE}/entregas-cliente/${encodeURIComponent(entregaId)}/publicar`, {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN },
    });

    if (pubResp.status === 401) { window.location.replace("index.html"); return; }
    const pubJson = await pubResp.json();
    if (!pubResp.ok) throw new Error(pubJson?.erro || pubJson?.error || "Falha ao publicar entrega.");

    const token = pubJson?.entrega?.token_publico;
    if (!token) throw new Error("Entrega publicada sem token_publico.");

    const publicUrl = `${window.location.origin}/relatorio-publico.html?token=${encodeURIComponent(token)}`;
    setLinkClienteOutput(publicUrl);
    setStatusLinkCliente("✓ Link público gerado. Você pode copiar e enviar ao cliente.", "success");
  } catch (err) {
    setStatusLinkCliente("Erro: " + (err?.message || "Falha ao gerar link."), "danger");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Gerar link para cliente"; }
  }
}

function limparFinStats() {
  [
    "fin-bruto",
    "fin-liquido",
    "fin-lc",
    "fin-mc",
    "fin-resultado",
    "fin-tacos",
    "fin-cancelamentos",
    "fin-cancelados-count",
    "fin-faturamento-perdido",
    "fin-shopee-cancelados-count",
    "fin-shopee-faturamento-perdido",
    "fin-shopee-nao-pagos",
  ].forEach((id) => {
    const card = document.getElementById(id);
    const v = card?.querySelector?.(".fc-stat-value");
    if (v) {
      v.textContent = "—";
      v.style.color = "";
    }
  });
}

function setExecValue(id, value, formatter, mode = "neutral") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = formatter(value);
  el.classList.remove("fc-exec-value-positive", "fc-exec-value-negative", "fc-exec-muted");
  if (mode === "positive") el.classList.add("fc-exec-value-positive");
  else if (mode === "negative") el.classList.add("fc-exec-value-negative");
  else if (mode === "muted") el.classList.add("fc-exec-muted");
}

function limparFinResumoExecutivo() {
  [
    "fin-exec-receita-bruta",
    "fin-exec-receita-liquida",
    "fin-exec-cancelamentos",
    "fin-exec-pedidos-cancelados",
    "fin-exec-ads",
    "fin-exec-venforce",
    "fin-exec-afiliados",
    "fin-exec-resultado-final",
    "fin-exec-lc-total",
    "fin-exec-mc-media",
    "fin-exec-tacos",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = "—";
    el.classList.remove("fc-exec-value-positive", "fc-exec-value-negative", "fc-exec-muted");
  });
}

function renderFinResumoExecutivo(data) {
  const s = data?.summary || {};
  const ads = Number(document.getElementById("fin-ads")?.value || 0);
  const venforce = Number(document.getElementById("fin-venforce")?.value || 0);
  const afiliados = Number(document.getElementById("fin-affiliates")?.value || 0);

  const gross = Number(s.grossRevenueTotal || 0);
  const net = Number(s.paidRevenueTotal || 0);
  const refunds = Number(s.refundsTotal || 0);
  const refundsCount = Number(s.refundsCount || 0);
  const finalResult = Number(s.finalResult || 0);
  const lcTotal = Number(s.contributionProfitTotal || 0);
  const mcMedia = Number(s.averageContributionMargin || 0);
  const tacosValue = Number(s.tacos || 0);

  setExecValue("fin-exec-receita-bruta", gross, brl, gross > 0 ? "positive" : "neutral");
  setExecValue("fin-exec-receita-liquida", net, brl, net > 0 ? "positive" : "neutral");
  setExecValue("fin-exec-cancelamentos", refunds, brl, refunds < 0 ? "negative" : "neutral");
  setExecValue("fin-exec-pedidos-cancelados", refundsCount, num, refundsCount > 0 ? "negative" : "muted");

  setExecValue("fin-exec-ads", ads, brl, ads > 0 ? "negative" : "muted");
  setExecValue("fin-exec-venforce", venforce, brl, venforce > 0 ? "negative" : "muted");
  setExecValue("fin-exec-afiliados", afiliados, brl, afiliados > 0 ? "negative" : "muted");

  setExecValue("fin-exec-resultado-final", finalResult, brl, finalResult > 0 ? "positive" : (finalResult < 0 ? "negative" : "neutral"));
  setExecValue("fin-exec-lc-total", lcTotal, brl, lcTotal > 0 ? "positive" : (lcTotal < 0 ? "negative" : "neutral"));
  setExecValue("fin-exec-mc-media", mcMedia, pct, mcMedia > 0 ? "positive" : (mcMedia < 0 ? "negative" : "neutral"));
  setExecValue("fin-exec-tacos", tacosValue, pct, "muted");
}

function renderFinResumo(data) {
  const s = data?.summary || {};

  function setCard(id, rawValue, formattedValue) {
    const el = document.getElementById(id)?.querySelector(".fc-stat-value");
    if (!el) return;
    el.textContent = formattedValue;

    const n = Number(rawValue);
    if (!Number.isFinite(n) || n === 0) { el.style.color = ""; return; }
    el.style.color = n > 0 ? "#86efac" : "#f87171";
  }

  setCard("fin-bruto", s.grossRevenueTotal, brl(s.grossRevenueTotal));
  setCard("fin-liquido", s.paidRevenueTotal, brl(s.paidRevenueTotal));
  setCard("fin-lc", s.contributionProfitTotal, brl(s.contributionProfitTotal));
  setCard("fin-mc", s.averageContributionMargin, pct(s.averageContributionMargin));
  setCard("fin-resultado", s.finalResult, brl(s.finalResult));
  setCard("fin-tacos", s.tacos, pct(s.tacos));

  // Cancelamentos: setCard já pinta vermelho quando valor < 0
  setCard("fin-cancelamentos", s.refundsTotal, brl(s.refundsTotal));
  // Faturamento perdido: valor integral dos produtos cancelados (I das linhas
  // canceladas). Mostra como negativo porque é dinheiro de venda que o seller
  // não recebeu. Usar -lostRevenueTotal para o setCard pintar de vermelho.
  const lostNegative = -Number(s.lostRevenueTotal || 0);
  setCard("fin-faturamento-perdido", lostNegative, brl(lostNegative));

  // Cards Shopee — só populam se vieram no summary.
  const shopeeCancCount = Number(s.cancelledCount || 0);
  const elShopeeCancCount = document
    .getElementById("fin-shopee-cancelados-count")
    ?.querySelector(".fc-stat-value");
  if (elShopeeCancCount) {
    elShopeeCancCount.textContent = num(shopeeCancCount);
    elShopeeCancCount.style.color = shopeeCancCount > 0 ? "#f87171" : "";
  }

  const shopeeLost = -Number(s.cancelledLostRevenue || 0);
  setCard("fin-shopee-faturamento-perdido", shopeeLost, brl(shopeeLost));

  const unpaidCount = Number(s.unpaidCount || 0);
  const elUnpaid = document
    .getElementById("fin-shopee-nao-pagos")
    ?.querySelector(".fc-stat-value");
  if (elUnpaid) {
    const unpaidVal = Number(s.unpaidLostRevenue || 0);
    elUnpaid.textContent = unpaidCount > 0
      ? `${num(unpaidCount)} (${brl(unpaidVal)})`
      : "—";
    elUnpaid.style.color = unpaidCount > 0 ? "#fbbf24" : "";
  }

  // Pedidos cancelados: contagem; coloração customizada (não é financeiro)
  const elCount = document
    .getElementById("fin-cancelados-count")
    ?.querySelector(".fc-stat-value");
  if (elCount) {
    const count = Number(s.refundsCount || 0);
    elCount.textContent = num(count);
    elCount.style.color = count > 0 ? "#f87171" : "";
  }
}

function renderFinTabela(data) {
  const host = document.getElementById("fin-tabela");
  if (!host) return;

  const rows = Array.isArray(data?.detailedRows) ? data.detailedRows : [];
  if (!rows.length) {
    host.innerHTML = `<div class="fc-content-panel"><div class="fc-empty">Nenhum dado para exibir.</div></div>`;
    return;
  }

  const columns = Object.keys(rows[0] || {});
  const th = columns.map((c) => `<th>${escapeHTML(c)}</th>`).join("");
  const tbody = rows.map((r) => {
    const tds = columns.map((c) => `<td>${escapeHTML(r?.[c] ?? "")}</td>`).join("");
    return `<tr>${tds}</tr>`;
  }).join("");

  host.innerHTML = `
    <div class="fc-content-panel">
      <table class="fc-table">
        <thead><tr>${th}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>
  `;

  const unmatched = Array.isArray(data?.unmatchedIds) ? data.unmatchedIds : [];
  if (unmatched.length > 0) {
    const panel = document.createElement("div");
    panel.className = "fc-content-panel";
    panel.style.marginTop = "14px";
    panel.style.background = "rgba(9,9,11,0.86)";
    panel.style.border = "1px solid rgba(248,113,113,0.28)";
    panel.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace";

    const idsHtml = unmatched
      .map((id) => `<div style="padding:6px 10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:10px;user-select:text;">${escapeHTML(String(id))}</div>`)
      .join("");

    panel.innerHTML = `
      <div style="font-weight:900;color:#f87171;margin:0 0 10px;">⚠ ${unmatched.length} ID(s) não encontrados na planilha de custos</div>
      <div style="color:#e5e7eb;margin:0 0 10px;">Receita ignorada: ${escapeHTML(brl(data?.ignoredRevenue || 0))}</div>
      <div style="display:flex;flex-direction:column;gap:8px;font-size:12px;color:#f4f4f5;line-height:1.45;">${idsHtml}</div>
      <div style="color:#a1a1aa;margin:12px 0 0;font-size:12px;">Cadastre esses IDs na planilha de custos e processe novamente.</div>
    `;

    host.appendChild(panel);
  }

  const unmatchedCancelled = Array.isArray(data?.unmatchedCancelled)
    ? data.unmatchedCancelled
    : [];
  if (unmatchedCancelled.length > 0) {
    const panel = document.createElement("div");
    panel.className = "fc-content-panel";
    panel.style.marginTop = "14px";
    panel.style.background = "rgba(9,9,11,0.86)";
    panel.style.border = "1px solid rgba(251,191,36,0.28)";
    panel.style.fontFamily = "ui-monospace, monospace";

    const itemsHtml = unmatchedCancelled
      .map((c) => `<div style="padding:6px 10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:10px;user-select:text;">${escapeHTML(c.productName || "—")} <span style="color:#a1a1aa;">| SKU: ${escapeHTML(c.skuPrincipal || "—")} | ${escapeHTML(brl(c.subtotal || 0))}</span></div>`)
      .join("");

    panel.innerHTML = `
      <div style="font-weight:900;color:#fbbf24;margin:0 0 10px;">⚠ ${unmatchedCancelled.length} pedido(s) cancelado(s) sem custo identificado</div>
      <div style="color:#e5e7eb;margin:0 0 10px;">Esses pedidos cancelados não foram encontrados na sua base de custos via SKU. Cadastre o produto na base e processe novamente para incluir nos cálculos.</div>
      <div style="display:flex;flex-direction:column;gap:8px;font-size:12px;color:#f4f4f5;line-height:1.45;">${itemsHtml}</div>
    `;

    host.appendChild(panel);
  }
}

function base64ToBlob(base64, mimeType) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function processarFechamentoFinanceiro() {
  if (!TOKEN) return;

  const marketplace = document.getElementById("fin-marketplace")?.value || "";
  if (!marketplace) { setStatus("Selecione o marketplace.", "danger"); return; }

  const sales = document.getElementById("fin-sales")?.files?.[0];
  if (!sales) { setStatus("Selecione a planilha de vendas (.xlsx).", "danger"); return; }

  const costs = document.getElementById("fin-costs")?.files?.[0];
  if (!costs) { setStatus("Selecione a planilha de custos (.xlsx).", "danger"); return; }

  const btn = document.getElementById("btn-fin-processar");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Processando...";
  }

  setStatus("Processando...", "info");

  try {
    const ads = document.getElementById("fin-ads")?.value || "0";
    const venforce = document.getElementById("fin-venforce")?.value || "0";
    const affiliates = document.getElementById("fin-affiliates")?.value || "0";

    const formData = new FormData();
    formData.append("sales", sales);
    formData.append("costs", costs);
    formData.append("marketplace", marketplace);
    // Order.all opcional, só Shopee
    if (marketplace === "shopee") {
      const ordersAll = document.getElementById("fin-orders-all")?.files?.[0];
      if (ordersAll) formData.append("ordersAll", ordersAll);
    }
    formData.append("ads", ads);
    formData.append("venforce", venforce);
    formData.append("affiliates", affiliates);

    const res = await fetch(`${API_BASE}/fechamentos/financeiro`, {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN },
      body: formData
    });

    if (res.status === 401) { window.location.replace("index.html"); return; }

    const json = await res.json();
    if (!res.ok) throw new Error(json.erro || json.error || json.message || "HTTP " + res.status);

    // Snapshot do fechamento para gerar entrega ao cliente (não altera cálculo)
    const adsNum = Number(document.getElementById("fin-ads")?.value || 0);
    const venforceNum = Number(document.getElementById("fin-venforce")?.value || 0);
    const affiliatesNum = Number(document.getElementById("fin-affiliates")?.value || 0);
    const dataGeracao = new Date().toISOString();
    json._vf_meta = { marketplace, ads: adsNum, venforce: venforceNum, affiliates: affiliatesNum, dataGeracao };
    ultimoFechamentoFinanceiro = { data: json, marketplace, ads: adsNum, venforce: venforceNum, affiliates: affiliatesNum, dataGeracao };
    showLinkClienteActions(true);
    setStatusLinkCliente("Pronto para gerar a entrega do cliente.", "info");
    setLinkClienteOutput("");

    renderFinResumo(json);
    renderFinResumoExecutivo(json);
    renderFinTabela(json);
    setStatus("✓ Processado com sucesso.", "success");

    if (json.excelBase64) {
      const blob = base64ToBlob(json.excelBase64, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fechamento-${marketplace}-${todayISO()}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    setStatus("Erro: " + (err?.message || "Falha ao processar."), "danger");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Processar";
    }
  }
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

// Eventos
const btnFinProcessar = document.getElementById("btn-fin-processar");
if (btnFinProcessar) btnFinProcessar.addEventListener("click", processarFechamentoFinanceiro);

const btnFinLimpar = document.getElementById("btn-fin-limpar");
if (btnFinLimpar) {
  btnFinLimpar.addEventListener("click", () => {
    const sales = document.getElementById("fin-sales");
    const costs = document.getElementById("fin-costs");
    const ordersAll = document.getElementById("fin-orders-all");
    if (sales) sales.value = "";
    if (costs) costs.value = "";
    if (ordersAll) ordersAll.value = "";

    const finAds = document.getElementById("fin-ads");
    const finVenforce = document.getElementById("fin-venforce");
    const finAffiliates = document.getElementById("fin-affiliates");
    if (finAds) finAds.value = "0";
    if (finVenforce) finVenforce.value = "0";
    if (finAffiliates) finAffiliates.value = "0";

    const marketplace = document.getElementById("fin-marketplace");
    if (marketplace) marketplace.value = "";

    limparFinStats();
    limparFinResumoExecutivo();

    const tabela = document.getElementById("fin-tabela");
    if (tabela) tabela.innerHTML = "";

    ultimoFechamentoFinanceiro = null;
    showLinkClienteActions(false);
    setLinkClienteOutput("");
    setStatusLinkCliente("", "");
    setStatus("", "");
  });
}

const btnGerarLinkCliente = document.getElementById("btn-fin-gerar-link-cliente");
if (btnGerarLinkCliente) btnGerarLinkCliente.addEventListener("click", gerarLinkClienteFinanceiro);

const btnCopiarLinkCliente = document.getElementById("btn-fin-copiar-link-cliente");
if (btnCopiarLinkCliente) {
  btnCopiarLinkCliente.addEventListener("click", async () => {
    const input = document.getElementById("fin-link-cliente-output");
    const url = String(input?.value || "").trim();
    if (!url) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        input.focus();
        input.select();
        document.execCommand("copy");
      }
      setStatusLinkCliente("Link copiado.", "success");
    } catch (_) {
      setStatusLinkCliente("Não foi possível copiar automaticamente. Selecione e copie manualmente.", "danger");
    }
  });
}

const btnAbrirLinkCliente = document.getElementById("btn-fin-abrir-link-cliente");
if (btnAbrirLinkCliente) {
  btnAbrirLinkCliente.addEventListener("click", () => {
    const input = document.getElementById("fin-link-cliente-output");
    const url = String(input?.value || "").trim();
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

const finSalesInput = document.getElementById("fin-sales");
const finSalesLabel = ensureFileLabelSpan(finSalesInput);
if (finSalesInput) {
  finSalesInput.addEventListener("change", () => {
    const f = finSalesInput.files?.[0];
    if (finSalesLabel) finSalesLabel.textContent = f ? f.name : "Escolher arquivo…";
  });
}

const finCostsInput = document.getElementById("fin-costs");
const finCostsLabel = ensureFileLabelSpan(finCostsInput);
if (finCostsInput) {
  finCostsInput.addEventListener("change", () => {
    const f = finCostsInput.files?.[0];
    if (finCostsLabel) finCostsLabel.textContent = f ? f.name : "Escolher arquivo…";
  });
}

const finOrdersAllInput = document.getElementById("fin-orders-all");
const finOrdersAllLabel = ensureFileLabelSpan(finOrdersAllInput);
if (finOrdersAllInput) {
  finOrdersAllInput.addEventListener("change", () => {
    const f = finOrdersAllInput.files?.[0];
    if (finOrdersAllLabel) finOrdersAllLabel.textContent = f ? f.name : "Escolher arquivo…";
  });
}

const marketplaceSelect = document.getElementById("fin-marketplace");
const ordersAllWrapper = document.getElementById("fin-orders-all-wrapper");
if (marketplaceSelect && ordersAllWrapper) {
  const updateOrdersAllVisibility = () => {
    ordersAllWrapper.style.display =
      marketplaceSelect.value === "shopee" ? "" : "none";
  };
  marketplaceSelect.addEventListener("change", updateOrdersAllVisibility);
  updateOrdersAllVisibility();
}

limparFinStats();
limparFinResumoExecutivo();

