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
let _xlsBlobUrl  = null;
let _xlsFilename = null;

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

function atualizarHintClienteFinanceiro() {
  const sel = document.getElementById("fin-cliente");
  const hint = document.getElementById("fin-cliente-hint");
  if (!sel || !hint) return;

  if (sel.value) {
    const nome = sel.options?.[sel.selectedIndex]?.textContent || "";
    hint.textContent = `Fechamento será vinculado a: ${nome}`;
    hint.style.display = "block";
  } else {
    hint.textContent = "";
    hint.style.display = "none";
  }
}

async function carregarClientesFinanceiro() {
  const sel = document.getElementById("fin-cliente");
  if (!sel) return;
  try {
    const res = await fetch(`${API_BASE}/clientes`, {
      headers: { Authorization: "Bearer " + TOKEN }
    });
    const data = await res.json();
    const lista = Array.isArray(data)
      ? data
      : (data?.clientes || data?.data || []);
    const ativos = lista.filter((c) => c?.ativo !== false);
    sel.innerHTML =
      '<option value="">Selecione o cliente...</option>' +
      ativos
        .sort((a, b) => (a.nome || "").localeCompare(b.nome || ""))
        .map((c) => `<option value="${c.slug}">${c.nome}</option>`)
        .join("");
    atualizarHintClienteFinanceiro();
  } catch {
    sel.innerHTML = '<option value="">Erro ao carregar clientes</option>';
    atualizarHintClienteFinanceiro();
  }
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

function normalizeFinancialSummaryForPublicReport(data) {
  const s = data?.summary || {};
  const meta = data?._vf_meta || {};

  const marketplace =
    String(meta.marketplace || s.marketplace || "").trim().toLowerCase() ||
    ((s.cancelledCount || s.unpaidCount || s.cancelledLostRevenue || s.unpaidLostRevenue) ? "shopee" : "meli");

  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };

  const grossRevenueTotal = n(s.grossRevenueTotal);
  const paidRevenueTotal = n(s.paidRevenueTotal);
  const contributionProfitTotal = n(s.contributionProfitTotal);
  const averageContributionMargin = n(s.averageContributionMargin);
  const finalResult = n(s.finalResult);
  const tacos = n(s.tacos);

  const refundsTotal = typeof s.refundsTotal !== "undefined" ? n(s.refundsTotal) : 0;
  const refundsCount = typeof s.refundsCount !== "undefined" ? n(s.refundsCount) : 0;
  const lostRevenueTotal = typeof s.lostRevenueTotal !== "undefined" ? n(s.lostRevenueTotal) : 0;

  const cancelledCount = n(s.cancelledCount);
  const cancelledLostRevenue = n(s.cancelledLostRevenue);
  const unpaidCount = n(s.unpaidCount);
  const unpaidLostRevenue = n(s.unpaidLostRevenue);

  const hasShopeeStatusData =
    (cancelledCount || 0) > 0 ||
    (cancelledLostRevenue || 0) > 0 ||
    (unpaidCount || 0) > 0 ||
    (unpaidLostRevenue || 0) > 0;

  return {
    marketplace,
    grossRevenueTotal,
    paidRevenueTotal,
    contributionProfitTotal,
    averageContributionMargin,
    finalResult,
    tacos,
    refundsTotal,
    refundsCount,
    lostRevenueTotal,
    cancelledCount,
    cancelledLostRevenue,
    unpaidCount,
    unpaidLostRevenue,
    hasShopeeStatusData,
  };
}

function montarPayloadFechamentoCliente(data) {
  const summary = data?.summary || {};
  const meta = data?._vf_meta || {};

  const summaryNormalized = normalizeFinancialSummaryForPublicReport(data);

  const gross = safeNumber(summaryNormalized.grossRevenueTotal);
  const net = safeNumber(summaryNormalized.paidRevenueTotal);
  const lcTotal = safeNumber(summaryNormalized.contributionProfitTotal);
  const mcMedia = safeNumber(summaryNormalized.averageContributionMargin);
  const tacos = safeNumber(summaryNormalized.tacos);
  const refundsTotal = safeNumber(summaryNormalized.refundsTotal);
  const refundsCount = safeNumber(summaryNormalized.refundsCount);
  const finalResult = safeNumber(summaryNormalized.finalResult);

  const lostRevenueTotal = safeNumber(summaryNormalized.lostRevenueTotal);
  const faturamentoPerdido = lostRevenueTotal > 0 ? -lostRevenueTotal : 0;

  const resumoExecutivo = [
    `Fechamento financeiro processado para ${String(meta.marketplace || "").toUpperCase()} em ${formatDateTimePtBR(meta.dataGeracao)}.`,
    `Receita bruta: ${brl(gross)} · Receita líquida: ${brl(net)} · LC total: ${brl(lcTotal)} · MC média: ${pct(mcMedia)}.`,
    `Resultado final (após ADS/Venforce/Afiliados): ${brl(finalResult)} · TACoS: ${pct(tacos)}.`,
  ].join(" ");

  const unmatched = Array.isArray(data?.unmatchedIds) ? data.unmatchedIds : [];
  const unmatchedCancelled = Array.isArray(data?.unmatchedCancelled) ? data.unmatchedCancelled : [];
  const ignoredRevenue = safeNumber(data?.ignoredRevenue);
  const detailedAll = Array.isArray(data?.detailedRows) ? data.detailedRows : [];
  const detailedSample50 = detailedAll.slice(0, 50);

  const severidade = (() => {
    if (finalResult < 0 || mcMedia < 0) return "critico";
    if (mcMedia < 0.15 || unmatched.length > 0 || refundsCount > 0 || lostRevenueTotal > 0) return "atencao";
    return "positivo";
  })();

  const isShopee = summaryNormalized.marketplace === "shopee" || !!summaryNormalized.hasShopeeStatusData;

  const cards = isShopee
    ? [
        {
          titulo: "Resultado Final",
          valor: brl(finalResult),
          subtitulo: "Resultado após despesas (ADS/Venforce/Afiliados).",
          destaque: true,
          raw: finalResult,
          status: finalResult > 0 ? "positivo" : (finalResult < 0 ? "critico" : "neutro"),
        },
        { titulo: "Receita Bruta", valor: brl(gross), subtitulo: "Total vendido no período.", raw: gross, status: "neutro" },
        { titulo: "Receita Líquida", valor: brl(net), subtitulo: "Receita recebida no período.", raw: net, status: "neutro" },
        { titulo: "LC Total", valor: brl(lcTotal), subtitulo: "Lucro de contribuição total.", raw: lcTotal, status: lcTotal > 0 ? "positivo" : (lcTotal < 0 ? "critico" : "neutro") },
        { titulo: "MC Média", valor: pct(mcMedia), subtitulo: "Margem de contribuição média.", raw: mcMedia, tipoValor: "pct", status: mcMedia >= 0.15 ? "positivo" : (mcMedia < 0 ? "critico" : "atencao") },
        { titulo: "TACoS", valor: pct(tacos), subtitulo: "ADS como % da receita.", raw: tacos, tipoValor: "pct", status: "neutro" },
        { titulo: "Pedidos cancelados (Shopee)", valor: num(summaryNormalized.cancelledCount || 0), subtitulo: "Cancelados confirmados via Order.all (excluídos: não pagos, devoluções e reembolsos).", raw: summaryNormalized.cancelledCount || 0, status: (summaryNormalized.cancelledCount || 0) > 0 ? "atencao" : "neutro" },
        { titulo: "Faturamento perdido (Shopee)", valor: brl(-(summaryNormalized.cancelledLostRevenue || 0)), subtitulo: "Receita estimada apenas de pedidos cancelados confirmados.", raw: summaryNormalized.cancelledLostRevenue || 0, status: (summaryNormalized.cancelledLostRevenue || 0) > 0 ? "atencao" : "neutro" },
        { titulo: "Não pagos (Shopee)", valor: `${num(summaryNormalized.unpaidCount || 0)} (${brl(summaryNormalized.unpaidLostRevenue || 0)})`, subtitulo: "Pedidos não pagos identificados no Order.all (separados dos cancelados confirmados).", raw: summaryNormalized.unpaidCount || 0, status: (summaryNormalized.unpaidCount || 0) > 0 ? "atencao" : "neutro" },
        { titulo: "Faturamento não pago", valor: brl(-(summaryNormalized.unpaidLostRevenue || 0)), subtitulo: "Receita estimada de pedidos não pagos (não afeta o Resultado Final).", raw: summaryNormalized.unpaidLostRevenue || 0, status: (summaryNormalized.unpaidLostRevenue || 0) > 0 ? "atencao" : "neutro" },
      ]
    : [
        {
          titulo: "Resultado Final",
          valor: brl(finalResult),
          subtitulo: "Resultado após despesas (ADS/Venforce/Afiliados).",
          destaque: true,
          raw: finalResult,
          status: finalResult > 0 ? "positivo" : (finalResult < 0 ? "critico" : "neutro"),
        },
        { titulo: "Receita Bruta", valor: brl(gross), subtitulo: "Total vendido no período.", raw: gross, status: gross > 0 ? "neutro" : "neutro" },
        { titulo: "Receita Líquida", valor: brl(net), subtitulo: "Receita após taxas/reembolsos conforme planilhas.", raw: net, status: net > 0 ? "neutro" : "neutro" },
        { titulo: "LC Total", valor: brl(lcTotal), subtitulo: "Lucro de contribuição total.", raw: lcTotal, status: lcTotal > 0 ? "positivo" : (lcTotal < 0 ? "critico" : "neutro") },
        { titulo: "MC Média", valor: pct(mcMedia), subtitulo: "Margem de contribuição média.", raw: mcMedia, tipoValor: "pct", status: mcMedia >= 0.15 ? "positivo" : (mcMedia < 0 ? "critico" : "atencao") },
        { titulo: "TACoS", valor: pct(tacos), subtitulo: "ADS como % da receita.", raw: tacos, tipoValor: "pct", status: "neutro" },
        { titulo: "Reembolsos / Cancelamentos", valor: `${brl(refundsTotal)} (${num(refundsCount)})`, subtitulo: "Impacto e volume de cancelamentos.", raw: refundsTotal, status: refundsCount > 0 ? "atencao" : "neutro" },
        { titulo: "Faturamento Perdido", valor: brl(faturamentoPerdido), subtitulo: "Receita de pedidos cancelados.", raw: faturamentoPerdido, status: faturamentoPerdido < 0 ? "atencao" : "neutro" },
      ];

  const secoes = [];

  if (unmatched.length > 0) {
    secoes.push({
      tipo: "atencao",
      titulo: "Produtos sem custo cadastrado",
      texto: `Identificamos ${unmatched.length} produto(s) que não foram cruzados com a base de custos. Isso pode afetar a precisão do fechamento. Receita ignorada: ${brl(ignoredRevenue)}.`,
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
  if (detailedAll.length > 0) {
    const sample = detailedAll.slice(0, 30);
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
      totalOriginal: detailedAll.length,
    });
  }

  return {
    versao: 1,
    tipo: "fechamento_mensal",
    titulo: "Relatório de Fechamento Financeiro",
    periodo: meta.periodo || "",
    marketplace: summaryNormalized.marketplace,
    summary,
    detailedRows: detailedSample50,
    unmatchedIds: unmatched,
    unmatchedCancelled,
    ignoredRevenue,
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
      severidade,
    },
    // Normalização do summary para relatório público (MELI + Shopee)
    summaryNormalized,
    // Snapshot enriquecido (não altera cálculo / não altera endpoint de fechamento)
    snapshot: {
      summary,
      summaryNormalized,
      detailedRows: detailedSample50,
      detailedRowsTotal: detailedAll.length,
      unmatchedIds: unmatched,
      ignoredRevenue,
      unmatchedCancelled,
      marketplace: meta.marketplace || null,
      ads: meta.ads ?? null,
      venforce: meta.venforce ?? null,
      affiliates: meta.affiliates ?? null,
      dataGeracao: meta.dataGeracao || null,
      metricasDerivadas: {
        gross,
        net,
        lcTotal,
        mcMedia,
        tacos,
        refundsTotal,
        refundsCount,
        finalResult,
        faturamentoPerdido,
        hasUnmatchedIds: unmatched.length > 0,
      }
    }
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
        cliente_slug: document.getElementById("fin-cliente")?.value || null,
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

function finColumnKey(col) {
  return String(col || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function finColumnMinWidth(col, numericCols) {
  const l = finColumnKey(col);
  if (/(^id$|item_id|produto_id|id_produto|^# de anuncio$|id.*anuncio|anuncio.*id|mlb|sku)/.test(l)) return 140;
  if (/marketplace|canal/.test(l)) return 128;
  if (/titulo|title|nome|produto|descri|item_title/.test(l)) return 360;
  if (/lc.*anuncio|anuncio.*lc/.test(l)) return 150;
  if (/vendas|pedido/.test(l)) return 145;
  if (/unidades|unid/.test(l)) return 145;
  if (/comissao/.test(l)) return 130;
  if (/taxa/.test(l)) return 125;
  if (/imposto/.test(l)) return 115;
  if (/custo/.test(l)) return 135;
  if (/preco|price/.test(l)) return 130;
  if (/total|brl|ajuste|frete/.test(l)) return 130;
  if (/^lc$|^mc$|lucro|margem/.test(l)) return 110;
  return numericCols.has(col) ? 120 : 150;
}

function finColumnCellClassAttr(col, numericCols) {
  const parts = [];
  if (numericCols.has(col)) parts.push("fc-td-num");

  const l = finColumnKey(col);
  if (/(^id$|item_id|produto_id|id_produto|^# de anuncio$|id.*anuncio|anuncio.*id|mlb|sku)/.test(l)) {
    parts.push("fc-col-compact", "fc-col-id");
  } else if (/marketplace|canal/.test(l)) {
    parts.push("fc-col-compact", "fc-col-marketplace");
  } else if (/titulo|title|nome|produto|descri|item_title/.test(l)) {
    parts.push("fc-col-produto");
  }

  if (/lc.*anuncio|anuncio.*lc/.test(l)) parts.push("fc-col-lc-ad");

  return parts.length ? ` class="${parts.join(" ")}"` : "";
}

function limparShopeeReconciliacao() {
  const el = document.getElementById("fin-shopee-reconciliacao");
  if (!el) return;
  el.style.display = "none";
  el.innerHTML = "";
}

function renderShopeeReconciliacao(data) {
  const el = document.getElementById("fin-shopee-reconciliacao");
  if (!el) return;

  const s = data?.summary || {};
  const totalCount = Number(s.orderAllTotalCount || 0);

  if (!totalCount) {
    limparShopeeReconciliacao();
    return;
  }

  const perfRevenue = Number(s.grossRevenueTotal || s.paidRevenueTotal || 0);
  const reconcRevenue = Number(s.orderAllTotalRevenue || 0);

  // Definição de cards por status — labels e textos de apoio sem "Order.all"
  const statusItems = [
    {
      label: "Concluídos",
      support: "Dinheiro consolidado",
      count: Number(s.orderAllCompletedCount || 0),
      revenue: Number(s.orderAllCompletedRevenue || 0),
      tone: "positive",
    },
    {
      label: "Entregues",
      support: "Dinheiro próximo de consolidar",
      count: Number(s.orderAllDeliveredCount || 0),
      revenue: Number(s.orderAllDeliveredRevenue || 0),
      tone: "positive",
    },
    {
      label: "Enviados",
      support: "Em trânsito",
      count: Number(s.orderAllShippedCount || 0),
      revenue: Number(s.orderAllShippedRevenue || 0),
      tone: "warning",
    },
    {
      label: "Em atenção",
      support: "Aguardando devolução, a enviar ou status intermediário",
      count: Number(s.orderAllIntermediateCount || 0),
      revenue: Number(s.orderAllIntermediateRevenue || 0),
      tone: "warning",
    },
    {
      label: "Cancelados confirmados",
      support: "Perda confirmada",
      count: Number(s.orderAllCancelledConfirmedCount || 0),
      revenue: Number(s.orderAllCancelledConfirmedRevenue || 0),
      tone: "danger",
    },
    {
      label: "Não pagos",
      support: "Pedidos que não viraram venda",
      count: Number(s.orderAllUnpaidCount || 0),
      revenue: Number(s.orderAllUnpaidRevenue || 0),
      tone: "warning",
    },
    {
      label: "Devoluções / Reembolsos",
      support: "Impacto separado dos cancelados",
      count: Number(s.orderAllReturnRefundCount || 0),
      revenue: Number(s.orderAllReturnRefundRevenue || 0),
      tone: "danger",
    },
  ].filter((item) => item.count > 0);

  const toneStyle = {
    positive: { bg: "rgba(134,239,172,0.07)", border: "rgba(134,239,172,0.2)", color: "#86efac" },
    warning:  { bg: "rgba(251,191,36,0.07)",  border: "rgba(251,191,36,0.2)",  color: "#fbbf24" },
    danger:   { bg: "rgba(248,113,113,0.07)", border: "rgba(248,113,113,0.18)", color: "#f87171" },
  };

  const cardsHtml = statusItems.map((item) => {
    const c = toneStyle[item.tone];
    return `<div class="fc-recon-card" style="background:${c.bg};border-color:${c.border};">
      <div class="fc-recon-card-label">${escapeHTML(item.label)}</div>
      <div class="fc-recon-card-support">${escapeHTML(item.support)}</div>
      <div class="fc-recon-card-value" style="color:${c.color};">${brl(item.revenue)}</div>
      <div class="fc-recon-card-count">${num(item.count)} pedido${item.count !== 1 ? "s" : ""}</div>
    </div>`;
  }).join("");

  // Texto narrativo dinâmico
  const reconcParts = [];
  if (Number(s.orderAllCompletedRevenue || 0) > 0)
    reconcParts.push(`${brl(s.orderAllCompletedRevenue)} concluídos`);
  if (Number(s.orderAllDeliveredRevenue || 0) > 0)
    reconcParts.push(`${brl(s.orderAllDeliveredRevenue)} entregues`);
  if (Number(s.orderAllShippedRevenue || 0) > 0)
    reconcParts.push(`${brl(s.orderAllShippedRevenue)} enviados`);
  if (Number(s.orderAllIntermediateRevenue || 0) > 0)
    reconcParts.push(`${brl(s.orderAllIntermediateRevenue)} em status intermediário`);
  if (Number(s.orderAllCancelledConfirmedRevenue || 0) > 0)
    reconcParts.push(`${brl(s.orderAllCancelledConfirmedRevenue)} cancelados confirmados`);
  if (Number(s.orderAllUnpaidRevenue || 0) > 0)
    reconcParts.push(`${brl(s.orderAllUnpaidRevenue)} não pagos`);
  if (Number(s.orderAllReturnRefundRevenue || 0) > 0)
    reconcParts.push(`${brl(s.orderAllReturnRefundRevenue)} em devolução/reembolso`);

  const mainText = `Os ${brl(perfRevenue)} são as vendas pagas no mês segundo a Performance Shopee.` +
    (reconcParts.length
      ? ` A Reconciliação Shopee mostra o cenário operacional completo: ${reconcParts.join(", ")}. O total da Reconciliação foi de ${brl(reconcRevenue)}.`
      : "");

  const diffHtml = reconcRevenue > perfRevenue
    ? `<p class="fc-recon-text-note">A diferença entre Performance e Reconciliação acontece porque a Performance considera apenas pedidos pagos usados no cálculo financeiro. A Reconciliação inclui também cancelados, não pagos, devoluções e status operacionais.</p>`
    : "";

  const topCancelled = Array.isArray(s.orderAllTopCancelledItems) ? s.orderAllTopCancelledItems : [];
  const topNames = topCancelled.map((i) => i.productName).filter(Boolean);
  const topHtml = topNames.length
    ? `<p class="fc-recon-text-top">Os maiores impactos de cancelamento confirmado estão concentrados em: ${escapeHTML(topNames.join(", "))}.</p>`
    : "";

  el.innerHTML = `<div class="fc-recon-panel">
    <div class="fc-recon-header">
      <div>
        <div class="fc-recon-badge">Reconciliação Shopee</div>
        <p class="fc-recon-subtitle">Visão operacional dos pedidos do período, baseada no arquivo completo de pedidos da Shopee.</p>
        <p class="fc-recon-source">Fonte: arquivo completo de pedidos da Shopee.</p>
      </div>
      <div class="fc-recon-compare">
        <div class="fc-recon-compare-item">
          <span class="fc-recon-compare-label">Performance (pedidos pagos)</span>
          <span class="fc-recon-compare-value fc-recon-value-positive">${brl(perfRevenue)}</span>
        </div>
        <div class="fc-recon-compare-sep">→</div>
        <div class="fc-recon-compare-item">
          <span class="fc-recon-compare-label">Reconciliação (visão completa)</span>
          <span class="fc-recon-compare-value">${brl(reconcRevenue)}</span>
        </div>
      </div>
    </div>
    <div class="fc-recon-cards">${cardsHtml}</div>
    <div class="fc-recon-text">
      <p>${mainText}</p>
      ${diffHtml}
      ${topHtml}
    </div>
  </div>`;
  el.style.display = "block";
}

function renderFinTabela(data) {
  const host = document.getElementById("fin-tabela");
  if (!host) return;

  const rows = Array.isArray(data?.detailedRows) ? data.detailedRows : [];
  host.innerHTML = "";

  if (!rows.length) {
    const emptyPanel = document.createElement("div");
    emptyPanel.className = "fc-content-panel";
    emptyPanel.innerHTML = `<div class="fc-empty">Nenhum dado para exibir.</div>`;
    host.appendChild(emptyPanel);
  } else {
    const columns = Object.keys(rows[0] || {});

    // Detecta colunas numéricas pelo tipo do valor na primeira linha
    const numericCols = new Set();
    const firstRow = rows[0] || {};
    columns.forEach((c) => {
      const v = firstRow[c];
      if (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))) {
        numericCols.add(c);
      }
    });

    let currentPage = 1;
    let pageSize = 25;
    let searchQuery = "";

    function getFiltered() {
      if (!searchQuery) return rows;
      const q = searchQuery.toLowerCase();
      return rows.filter((r) => columns.some((c) => String(r?.[c] ?? "").toLowerCase().includes(q)));
    }

    const panelEl = document.createElement("div");
    panelEl.className = "fc-content-panel";
    panelEl.innerHTML = `
      <h2 class="fc-section-title" style="margin-bottom:14px;">Detalhamento por produto</h2>
      <div class="fc-table-toolbar">
        <input type="text" class="fc-table-search" placeholder="Buscar por ID ou título…" autocomplete="off">
        <select class="fc-table-page-select">
          <option value="25">25 por página</option>
          <option value="50">50 por página</option>
          <option value="100">100 por página</option>
        </select>
        <span class="fc-table-counter"></span>
      </div>
      <div class="fc-table-scroll"></div>
      <div class="fc-pagination">
        <span class="fc-pagination-info"></span>
        <button class="fc-pagination-btn fc-pagination-prev" type="button">← Anterior</button>
        <button class="fc-pagination-btn fc-pagination-next" type="button">Próxima →</button>
      </div>
    `;

    const searchInputEl  = panelEl.querySelector(".fc-table-search");
    const pageSelectEl   = panelEl.querySelector(".fc-table-page-select");
    const counterEl      = panelEl.querySelector(".fc-table-counter");
    const tableScrollEl  = panelEl.querySelector(".fc-table-scroll");
    const prevBtn        = panelEl.querySelector(".fc-pagination-prev");
    const nextBtn        = panelEl.querySelector(".fc-pagination-next");
    const pageInfoEl     = panelEl.querySelector(".fc-pagination-info");

    function renderPage() {
      const filtered   = getFiltered();
      const total      = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      if (currentPage > totalPages) currentPage = totalPages;
      const start    = (currentPage - 1) * pageSize;
      const pageRows = filtered.slice(start, start + pageSize);

      const detailMinWidth = Math.max(
        1200,
        columns.reduce((sum, c) => sum + finColumnMinWidth(c, numericCols), 0)
      );
      tableScrollEl.style.setProperty("--fc-detail-table-min-width", `${detailMinWidth}px`);

      const COL_ABBREV = {
        "Preço unitário de venda do anúncio (BRL)": "Preço Unit.",
        "Preço de custo total": "Custo Total",
        "Ajuste plataforma (BRL)": "Aj. Plataforma",
        "Título do anúncio": "Título",
      };
      const thHtml = columns.map((c) => {
        const minWidth = finColumnMinWidth(c, numericCols);
        const isProductCol = /titulo|title|nome|produto|descri|item_title/.test(finColumnKey(c));
        const w = ` style="min-width:${minWidth}px;${isProductCol ? "" : "white-space:nowrap;"}"`;
        const label = COL_ABBREV[c] || c;
        return `<th${finColumnCellClassAttr(c, numericCols)}${w}>${escapeHTML(String(label))}</th>`;
      }).join("");

      const tbodyHtml = pageRows.map((r) => {
        const tds = columns.map((c) => {
          return `<td${finColumnCellClassAttr(c, numericCols)}>${escapeHTML(String(r?.[c] ?? ""))}</td>`;
        }).join("");
        return `<tr>${tds}</tr>`;
      }).join("");

      tableScrollEl.innerHTML = `<table class="fc-table fc-fin-detail-table"><thead><tr>${thHtml}</tr></thead><tbody>${tbodyHtml}</tbody></table>`;

      const showing = pageRows.length;
      counterEl.textContent = showing > 0
        ? `Mostrando ${start + 1}–${start + showing} de ${total} produto${total !== 1 ? "s" : ""}`
        : `0 de ${total} produtos`;
      prevBtn.disabled  = currentPage <= 1;
      nextBtn.disabled  = currentPage >= totalPages;
      pageInfoEl.textContent = `Página ${currentPage} de ${totalPages}`;
    }

    searchInputEl.addEventListener("input", () => { searchQuery = searchInputEl.value.trim(); currentPage = 1; renderPage(); });
    pageSelectEl.addEventListener("change", () => { pageSize = Number(pageSelectEl.value) || 25; currentPage = 1; renderPage(); });
    prevBtn.addEventListener("click", () => { if (currentPage > 1) { currentPage--; renderPage(); } });
    nextBtn.addEventListener("click", () => {
      const totalPages = Math.max(1, Math.ceil(getFiltered().length / pageSize));
      if (currentPage < totalPages) { currentPage++; renderPage(); }
    });

    host.appendChild(panelEl);
    renderPage();
  }

  // --- IDs sem custo ---
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

  // --- Cancelados sem custo ---
  const unmatchedCancelled = Array.isArray(data?.unmatchedCancelled) ? data.unmatchedCancelled : [];
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

function limparXlsBlob() {
  if (_xlsBlobUrl) { URL.revokeObjectURL(_xlsBlobUrl); _xlsBlobUrl = null; }
  _xlsFilename = null;
  const btn = document.getElementById("btn-fin-download");
  if (btn) btn.style.display = "none";
}
function setXlsBlob(blob, filename) {
  limparXlsBlob();
  _xlsBlobUrl = URL.createObjectURL(blob);
  _xlsFilename = filename || "fechamento-resultado.xlsx";
  const btn = document.getElementById("btn-fin-download");
  if (btn) btn.style.display = "";
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

  limparXlsBlob();

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
    renderShopeeReconciliacao(json);
    renderFinTabela(json);
    document.getElementById("fc-wrap")?.setAttribute("data-processed", "");
    initEntregaTabs();
    setStatus("✓ Processado com sucesso.", "success");

    if (json.excelBase64) {
      const blob = base64ToBlob(json.excelBase64, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      setXlsBlob(blob, `fechamento-${marketplace}-${todayISO()}.xlsx`);
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

function initUploadDragDrop(inputId) {
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
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      let msg = card.querySelector(".fc-upload-reject-msg");
      if (!msg) {
        msg = document.createElement("div");
        msg.className = "fc-upload-reject-msg";
        card.appendChild(msg);
      }
      msg.textContent = "Apenas arquivos .xlsx são aceitos.";
      setTimeout(() => msg?.remove(), 3000);
      return;
    }
    card.querySelector(".fc-upload-reject-msg")?.remove();
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
    } catch (_) {}
    input.dispatchEvent(new Event("change"));
  });

  // Atualiza classe has-file também ao usar o clique nativo
  input.addEventListener("change", () => {
    card.classList.toggle("has-file", !!(input.files?.length));
  });
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
    [sales, costs, ordersAll].forEach((inp) =>
      inp?.closest(".fc-upload-card")?.classList.remove("has-file", "drag-over")
    );

    const finAds = document.getElementById("fin-ads");
    const finVenforce = document.getElementById("fin-venforce");
    const finAffiliates = document.getElementById("fin-affiliates");
    if (finAds) finAds.value = "0";
    if (finVenforce) finVenforce.value = "0";
    if (finAffiliates) finAffiliates.value = "0";

    const marketplace = document.getElementById("fin-marketplace");
    if (marketplace) marketplace.value = "";

    limparXlsBlob();
    limparFinStats();
    limparFinResumoExecutivo();
    limparShopeeReconciliacao();
    document.getElementById("fc-wrap")?.removeAttribute("data-processed");

    const tabela = document.getElementById("fin-tabela");
    if (tabela) tabela.innerHTML = "";

    ultimoFechamentoFinanceiro = null;
    showLinkClienteActions(false);
    setLinkClienteOutput("");
    setStatusLinkCliente("", "");
    setStatus("", "");
  });
}

const btnFinDownload = document.getElementById("btn-fin-download");
if (btnFinDownload) {
  btnFinDownload.addEventListener("click", () => {
    if (!_xlsBlobUrl) return;
    const a = document.createElement("a");
    a.href = _xlsBlobUrl;
    a.download = _xlsFilename || "fechamento-resultado.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
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

const clienteSelectFinanceiro = document.getElementById("fin-cliente");
if (clienteSelectFinanceiro) {
  clienteSelectFinanceiro.addEventListener("change", atualizarHintClienteFinanceiro);
}

carregarClientesFinanceiro();

initUploadDragDrop("fin-sales");
initUploadDragDrop("fin-costs");
initUploadDragDrop("fin-orders-all");

limparFinStats();
limparFinResumoExecutivo();
limparShopeeReconciliacao();
// ─────────────────────────────────────────────────────────────────────────────
// ENTREGA PARA O CLIENTE — Sistema de Abas
// ─────────────────────────────────────────────────────────────────────────────

// Estado persistente do formulário de entrega (não perde ao trocar de aba)
const _entregaState = {
  periodo:   "",
  cliente:   "",
  destaques: ["", "", ""],
  atencoes:  ["", ""],
  prioridades: {
    alta:  [{ titulo: "", desc: "", data: "" }, { titulo: "", desc: "", data: "" }, { titulo: "", desc: "", data: "" }],
    media: [{ titulo: "", desc: "", data: "" }, { titulo: "", desc: "", data: "" }, { titulo: "", desc: "", data: "" }],
    baixa: [{ titulo: "", desc: "", data: "" }, { titulo: "", desc: "", data: "" }, { titulo: "", desc: "", data: "" }],
  },
};

// Lê o estado do formulário dos inputs do DOM
function _syncEntregaStateFromDOM() {
  const g = (id) => document.getElementById(id)?.value || "";
  _entregaState.periodo = g("ent-periodo");
  _entregaState.cliente = g("ent-cliente");
  _entregaState.destaques = [g("ent-d1"), g("ent-d2"), g("ent-d3")];
  _entregaState.atencoes  = [g("ent-a1"), g("ent-a2")];

  ["alta", "media", "baixa"].forEach((nv, ni) => {
    [1, 2, 3].forEach((n, i) => {
      _entregaState.prioridades[nv][i] = {
        titulo: g(`ent-${nv}-${n}-t`),
        desc:   g(`ent-${nv}-${n}-d`),
        data:   g(`ent-${nv}-${n}-dt`),
      };
    });
  });
}

// Preenche os inputs com o estado salvo
function _applyEntregaStateToDOM() {
  const s = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ""; };
  s("ent-periodo", _entregaState.periodo);
  s("ent-cliente", _entregaState.cliente);
  _entregaState.destaques.forEach((v, i) => s(`ent-d${i + 1}`, v));
  _entregaState.atencoes.forEach((v, i)  => s(`ent-a${i + 1}`, v));
  ["alta", "media", "baixa"].forEach((nv) => {
    [1, 2, 3].forEach((n, i) => {
      s(`ent-${nv}-${n}-t`,  _entregaState.prioridades[nv][i].titulo);
      s(`ent-${nv}-${n}-d`,  _entregaState.prioridades[nv][i].desc);
      s(`ent-${nv}-${n}-dt`, _entregaState.prioridades[nv][i].data);
    });
  });
}

// Troca entre abas
function _switchTab(tab) {
  const dash = document.getElementById("vft-dashboard");
  const ent  = document.getElementById("vft-entrega");
  const btnD = document.getElementById("vft-btn-dashboard");
  const btnE = document.getElementById("vft-btn-entrega");
  if (!dash || !ent) return;

  if (tab === "dashboard") {
    dash.style.display = ""; ent.style.display = "none";
    btnD.classList.add("vft-active"); btnE.classList.remove("vft-active");
  } else {
    // Antes de mostrar a aba de entrega, aplica o estado salvo
    _applyEntregaStateToDOM();
    dash.style.display = "none"; ent.style.display = "";
    btnD.classList.remove("vft-active"); btnE.classList.add("vft-active");
    // Scroll suave para o topo da área
    document.getElementById("vft-root")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// Constrói o HTML do formulário de entrega
function _buildEntregaFormHTML() {
  const inputCls = "vft-input";
  const textareaCls = "vft-input vft-textarea";

  const destaque = (id, placeholder) =>
    `<input id="${id}" class="${inputCls}" type="text" placeholder="${placeholder}" />`;

  const acao = (nv, n) => `
    <div class="vft-action-group">
      <div class="vft-action-title">Ação ${n}</div>
      <label class="vft-label">Título</label>
      <input id="ent-${nv}-${n}-t" class="${inputCls}" type="text" placeholder="ex: Reestruturar campanhas ADS" />
      <label class="vft-label">O que será feito</label>
      <input id="ent-${nv}-${n}-d" class="${inputCls}" type="text" placeholder="Descreva a ação" />
      <label class="vft-label">Data prevista</label>
      <input id="ent-${nv}-${n}-dt" class="${inputCls}" type="text" placeholder="ex: 15/06" />
    </div>`;

  return `
  <div id="vft-entrega" style="display:none;" class="vft-entrega-panel">

    <!-- Identificação -->
    <div class="vft-form-section">
      <div class="vft-form-section-label">Identificação</div>
      <div class="vft-row-2">
        <div>
          <label class="vft-label">Período</label>
          <input id="ent-periodo" class="${inputCls}" type="text" placeholder="ex: Maio 2026" />
        </div>
        <div>
          <label class="vft-label">Nome do cliente</label>
          <input id="ent-cliente" class="${inputCls}" type="text" placeholder="ex: Maximus Ferramentas" />
        </div>
      </div>
    </div>

    <!-- Destaques -->
    <div class="vft-form-section">
      <div class="vft-form-section-label">Destaques do Mês</div>
      <div class="vft-form-section-sub">Estes itens serão exibidos no relatório do cliente como checkmarks positivos e pontos de atenção.</div>

      <label class="vft-label" style="margin-top:14px;">✅ Destaques positivos</label>
      ${destaque("ent-d1", "ex: Crescimento de receita acima da meta")}
      ${destaque("ent-d2", "ex: ROAS acima da meta")}
      ${destaque("ent-d3", "ex: Full indo bem pelo 2º mês seguido")}

      <label class="vft-label" style="margin-top:14px;">⚠️ Pontos de atenção</label>
      ${destaque("ent-a1", "ex: Ruptura de estoque no produto X")}
      ${destaque("ent-a2", "ex: ACOS acima do ideal em campanhas brand")}
    </div>

    <!-- Plano de Prioridades -->
    <div class="vft-form-section">
      <div class="vft-form-section-label">Plano de Prioridades — Próximo Mês</div>
      <div class="vft-form-section-sub">Preencha as ações planejadas. Deixe em branco o que não se aplica.</div>
      <div class="vft-prio-grid">

        <div class="vft-prio-col vft-prio-alta">
          <div class="vft-prio-head">
            <span class="vft-prio-dot" style="background:#f87171;"></span>
            Alta Prioridade
          </div>
          ${acao("alta", 1)}${acao("alta", 2)}${acao("alta", 3)}
        </div>

        <div class="vft-prio-col vft-prio-media">
          <div class="vft-prio-head">
            <span class="vft-prio-dot" style="background:#fbbf24;"></span>
            Média Prioridade
          </div>
          ${acao("media", 1)}${acao("media", 2)}${acao("media", 3)}
        </div>

        <div class="vft-prio-col vft-prio-baixa">
          <div class="vft-prio-head">
            <span class="vft-prio-dot" style="background:#60a5fa;"></span>
            Baixa Prioridade
          </div>
          ${acao("baixa", 1)}${acao("baixa", 2)}${acao("baixa", 3)}
        </div>

      </div>
    </div>

    <!-- Ações -->
    <div class="vft-form-actions">
      <div id="vft-ent-status" class="vft-ent-status" style="display:none;"></div>
      <button id="btn-vft-gerar" class="fc-btn fc-btn-primary fc-btn-lg" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        Gerar link para o cliente
      </button>

      <div class="vft-link-row" id="vft-link-row" style="display:none;">
        <input id="vft-link-output" class="vft-link-input" type="text" readonly />
        <div class="vft-link-btns">
          <button id="btn-vft-copiar" class="fc-btn fc-btn-secondary" type="button">Copiar</button>
          <button id="btn-vft-abrir"  class="fc-btn fc-btn-secondary" type="button">Abrir</button>
        </div>
      </div>
    </div>

  </div>`;
}

// Inicia o sistema de abas após processamento bem-sucedido
function initEntregaTabs() {
  // Evita criar duas vezes
  if (document.getElementById("vft-root")) return;

  const fcWrap = document.getElementById("fc-wrap");
  if (!fcWrap) return;

  // Encontrar o ponto de inserção: antes do dashboard
  const dashSection = fcWrap.querySelector(".fc-dashboard-panel");
  if (!dashSection) return;

  // Esconder seção antiga de entrega
  document.getElementById("fin-link-cliente-actions")?.style.setProperty("display", "none", "important");

  // Criar o container root das abas
  const tabRoot = document.createElement("div");
  tabRoot.id = "vft-root";

  // CSS inline das abas (não depende de style.css)
  const style = document.createElement("style");
  style.textContent = `
    #vft-root { margin-bottom: 0; }

    /* Tab bar */
    .vft-bar {
      display: flex;
      border-bottom: 1.5px solid rgba(255,255,255,0.08);
      margin-bottom: 20px;
    }
    .vft-tab-btn {
      padding: 12px 26px;
      background: none; border: none; cursor: pointer;
      font-size: 13px; font-weight: 600; color: #71717a;
      border-bottom: 2px solid transparent;
      margin-bottom: -1.5px;
      transition: color .15s, border-color .15s;
      display: flex; align-items: center; gap: 6px;
    }
    .vft-tab-btn:hover { color: #c084fc; }
    .vft-tab-btn.vft-active { color: #c084fc; border-bottom-color: #c084fc; }
    .vft-tab-btn .vft-tab-icon { font-size: 15px; }

    /* Entrega panel */
    .vft-entrega-panel { padding-bottom: 40px; }

    /* Seções do form */
    .vft-form-section {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 16px;
      padding: 22px 24px;
      margin-bottom: 14px;
    }
    .vft-form-section-label {
      font-size: 10px; font-weight: 800;
      letter-spacing: .08em; text-transform: uppercase;
      color: #c084fc; margin-bottom: 6px;
    }
    .vft-form-section-sub {
      font-size: 12.5px; color: #71717a; margin-bottom: 14px; line-height: 1.6;
    }
    .vft-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 640px) { .vft-row-2 { grid-template-columns: 1fr; } }

    /* Inputs */
    .vft-label {
      display: block; font-size: 11px; font-weight: 700;
      color: #71717a; margin: 6px 0 4px; text-transform: uppercase; letter-spacing: .04em;
    }
    .vft-input {
      display: block; width: 100%;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 9px; padding: 9px 13px;
      font-size: 13px; color: #f4f4f5;
      margin-bottom: 6px;
      transition: border-color .15s;
      box-sizing: border-box;
    }
    .vft-input:focus { outline: none; border-color: #7c3aed; background: rgba(124,58,237,0.06); }
    .vft-input::placeholder { color: #52525b; }
    .vft-textarea { resize: vertical; min-height: 72px; }

    /* Prioridades */
    .vft-prio-grid {
      display: grid; grid-template-columns: 1fr 1fr 1fr;
      gap: 12px; margin-top: 14px;
    }
    @media (max-width: 860px) { .vft-prio-grid { grid-template-columns: 1fr; } }
    .vft-prio-col {
      border-radius: 12px; overflow: hidden;
      border: 1px solid rgba(255,255,255,0.07);
    }
    .vft-prio-alta  { border-top: 3px solid #f87171; }
    .vft-prio-media { border-top: 3px solid #fbbf24; }
    .vft-prio-baixa { border-top: 3px solid #60a5fa; }
    .vft-prio-head {
      display: flex; align-items: center; gap: 7px;
      padding: 12px 14px;
      font-size: 12px; font-weight: 700; color: #a1a1aa;
      background: rgba(255,255,255,0.03);
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .vft-prio-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
    .vft-action-group {
      padding: 12px 12px 6px;
      border-bottom: 1px solid rgba(255,255,255,0.04);
    }
    .vft-action-group:last-child { border-bottom: none; }
    .vft-action-title {
      font-size: 11px; font-weight: 700; color: #52525b;
      text-transform: uppercase; letter-spacing: .04em; margin-bottom: 6px;
    }

    /* Ações finais */
    .vft-form-actions {
      padding: 8px 0; display: flex; flex-direction: column; gap: 12px; align-items: flex-start;
    }
    .vft-ent-status { font-size: 13px; }
    .vft-link-row {
      display: flex; align-items: center; gap: 10px; width: 100%; flex-wrap: wrap;
    }
    .vft-link-input {
      flex: 1; min-width: 200px;
      background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 9px; padding: 9px 13px; font-size: 13px; color: #a1a1aa;
    }
    .vft-link-btns { display: flex; gap: 8px; }
  `;
  document.head.appendChild(style);

  // Tab bar
  tabRoot.innerHTML = `
    <div class="vft-bar">
      <button id="vft-btn-dashboard" class="vft-tab-btn vft-active" type="button">
        <span class="vft-tab-icon">📊</span> Dashboard Financeiro
      </button>
      <button id="vft-btn-entrega" class="vft-tab-btn" type="button">
        <span class="vft-tab-icon">📤</span> Entrega para o Cliente
      </button>
    </div>
    ${_buildEntregaFormHTML()}
  `;

  // Inserir antes do dashboard
  fcWrap.insertBefore(tabRoot, dashSection);

  // Envolver o dashboard + tabela em um wrapper de aba
  const dashWrapper = document.createElement("div");
  dashWrapper.id = "vft-dashboard";

  // Mover dashboard, shopee recon e tabela para dentro do wrapper
  const shopeeRecon = document.getElementById("fin-shopee-reconciliacao");
  const tabelaEl    = document.getElementById("fin-tabela");

  dashSection.parentNode.insertBefore(dashWrapper, dashSection);
  dashWrapper.appendChild(dashSection);
  if (shopeeRecon) dashWrapper.appendChild(shopeeRecon);
  if (tabelaEl)    dashWrapper.appendChild(tabelaEl);

  // Eventos das abas
  document.getElementById("vft-btn-dashboard").addEventListener("click", () => _switchTab("dashboard"));
  document.getElementById("vft-btn-entrega").addEventListener("click", () => _switchTab("entrega"));

  // Evento do botão de gerar link na aba entrega
  document.getElementById("btn-vft-gerar")?.addEventListener("click", _gerarLinkComEntrega);

  // Copiar
  document.getElementById("btn-vft-copiar")?.addEventListener("click", async () => {
    const url = document.getElementById("vft-link-output")?.value;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      _setEntStatus("✓ Link copiado.", "ok");
    } catch { _setEntStatus("Copie manualmente o link acima.", "warn"); }
  });

  // Abrir
  document.getElementById("btn-vft-abrir")?.addEventListener("click", () => {
    const url = document.getElementById("vft-link-output")?.value;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  });

  // Auto-save ao digitar (mantém estado mesmo sem mudar de aba)
  document.getElementById("vft-entrega")?.querySelectorAll("input, textarea").forEach(el => {
    el.addEventListener("input", () => _syncEntregaStateFromDOM());
  });
}

function _setEntStatus(msg, type) {
  const el = document.getElementById("vft-ent-status");
  if (!el) return;
  if (!msg) { el.style.display = "none"; return; }
  el.textContent = msg;
  el.style.display = "block";
  el.style.color = type === "ok" ? "#4ade80" : type === "err" ? "#f87171" : "#fbbf24";
}

// Gerar link incluindo os dados do formulário de entrega
async function _gerarLinkComEntrega() {
  if (!TOKEN) return;
  if (!ultimoFechamentoFinanceiro?.data) {
    _setEntStatus("Processe um fechamento antes de gerar o link.", "err");
    return;
  }

  // Salvar estado atual do form
  _syncEntregaStateFromDOM();

  const btn = document.getElementById("btn-vft-gerar");
  if (btn) { btn.disabled = true; btn.textContent = "Gerando…"; }
  _setEntStatus("Gerando e publicando…", "warn");
  document.getElementById("vft-link-row").style.display = "none";

  try {
    const data = ultimoFechamentoFinanceiro.data;
    const payload = montarPayloadFechamentoCliente(data);

    // Injetar dados de entrega no payload
    payload.entrega = {
      cliente:   _entregaState.cliente,
      periodo:   _entregaState.periodo || payload.periodo,
      destaques: _entregaState.destaques.filter(Boolean),
      atencoes:  _entregaState.atencoes.filter(Boolean),
      prioridades: _entregaState.prioridades,
    };
    payload.periodo = _entregaState.periodo || payload.periodo;

    const criarResp = await fetch(`${API_BASE}/entregas-cliente`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: JSON.stringify({
        tipo: "fechamento_mensal",
        titulo: payload.titulo || "Fechamento Financeiro",
        periodo: payload.periodo || "",
        cliente_slug: document.getElementById("fin-cliente")?.value || null,
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
    if (!entregaId) throw new Error("Entrega criada sem ID.");

    const pubResp = await fetch(`${API_BASE}/entregas-cliente/${encodeURIComponent(entregaId)}/publicar`, {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN },
    });

    if (pubResp.status === 401) { window.location.replace("index.html"); return; }
    const pubJson = await pubResp.json();
    if (!pubResp.ok) throw new Error(pubJson?.erro || pubJson?.error || "Falha ao publicar entrega.");

    const token = pubJson?.entrega?.token_publico;
    if (!token) throw new Error("Token público não gerado.");

    const publicUrl = `${window.location.origin}/relatorio-publico.html?token=${encodeURIComponent(token)}`;

    const outputEl = document.getElementById("vft-link-output");
    if (outputEl) outputEl.value = publicUrl;
    document.getElementById("vft-link-row").style.display = "flex";
    _setEntStatus("✓ Link gerado com sucesso. Copie e envie ao cliente.", "ok");

  } catch (err) {
    _setEntStatus("Erro: " + (err?.message || "Falha ao gerar link."), "err");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Gerar link para o cliente"; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH na função processarFechamentoFinanceiro:
// Chamar initEntregaTabs() após processamento bem-sucedido.
//
// Localize a linha:
//   document.getElementById("fc-wrap")?.setAttribute("data-processed", "");
//
// E adicione LOGO ABAIXO:
//   initEntregaTabs();
// ─────────────────────────────────────────────────────────────────────────────
