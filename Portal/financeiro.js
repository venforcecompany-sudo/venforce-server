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

// Persistência do fechamento (reuso de entregas_cliente)
let _entregaIdSalvo   = null;   // id da entrega criada como rascunho
let _entregaPublicada = false;  // se já foi publicada (link gerado)

// Estado da base vinculada ao cliente + marketplace
const baseVinculadaState = {
  loading: false,
  hasLink: false,
  baseId: null,
  baseNome: null,
  clienteSlug: "",
  marketplace: "",
};

function escapeHTML(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

// Feedback de status → vf-banner (is-success/is-danger/is-warning/is-info)
function setStatus(msg, tipo) {
  const el = document.getElementById("fin-status");
  if (!el) return;
  el.classList.remove("is-success", "is-danger", "is-info", "is-warning");
  if (!msg) { el.hidden = true; el.textContent = ""; return; }
  el.textContent = msg;
  el.hidden = false;
  if (tipo === "success") el.classList.add("is-success");
  else if (tipo === "danger") el.classList.add("is-danger");
  else if (tipo === "warn") el.classList.add("is-warning");
  else el.classList.add("is-info");
}

// Feedback do link (legado) → vf-alert (cor por classe, nunca inline)
function setStatusLinkCliente(msg, tipo) {
  const el = document.getElementById("fin-link-cliente-status");
  if (!el) return;
  el.classList.remove("is-success", "is-danger", "is-info");
  if (!msg) { el.hidden = true; el.textContent = ""; return; }
  el.textContent = msg;
  el.hidden = false;
  if (tipo === "success") el.classList.add("is-success");
  else if (tipo === "danger") el.classList.add("is-danger");
  else el.classList.add("is-info");
}

// Mapeia as variantes legadas para os estados semânticos da Fundação V2.
function chipVariantClass(variant) {
  if (variant === "ok") return "is-success";
  if (variant === "warn") return "is-warning";
  if (variant === "bad") return "is-danger";
  if (variant === "info") return "is-info";
  return "is-neutral";
}

// ── Chips informativos do cabeçalho → vf-status ────────────────────────────
function setChip(id, label, value, variant) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = "vf-status " + chipVariantClass(variant);
  el.hidden = false;
  el.innerHTML = `${escapeHTML(label)}: <b>${escapeHTML(value)}</b>`;
}

function marketplaceLabel(mk) {
  if (mk === "meli") return "Mercado Livre";
  if (mk === "shopee") return "Shopee";
  return "—";
}

function atualizarChips() {
  const sel = document.getElementById("fin-cliente");
  const clienteNome = sel?.value ? (sel.options?.[sel.selectedIndex]?.textContent || "—") : "—";
  const marketplace = document.getElementById("fin-marketplace")?.value || "";

  setChip("fin-chip-cliente", "Cliente", clienteNome, sel?.value ? "info" : null);
  setChip("fin-chip-marketplace", "Marketplace", marketplaceLabel(marketplace), marketplace ? "info" : null);

  // Chip da base
  if (!sel?.value || !marketplace) {
    setChip("fin-chip-base", "Base", "—", null);
  } else if (baseVinculadaState.loading) {
    setChip("fin-chip-base", "Base", "verificando…", null);
  } else if (baseVinculadaState.hasLink) {
    setChip("fin-chip-base", "Base", "vinculada", "ok");
  } else if (marketplace === "shopee") {
    setChip("fin-chip-base", "Base", "upload manual", "info");
  } else {
    setChip("fin-chip-base", "Base", "não vinculada", "warn");
  }
}

function setChipProcessamento(texto, variant) {
  setChip("fin-chip-processamento", "Processamento", texto, variant || null);
}

function setChipSalvo(texto, variant) {
  const el = document.getElementById("fin-chip-salvo");
  if (!el) return;
  if (!texto) { el.hidden = true; return; }
  el.className = "vf-status " + chipVariantClass(variant);
  el.hidden = false;
  el.innerHTML = `Fechamento: <b>${escapeHTML(texto)}</b>`;
}

function showLinkClienteActions(show) {
  const host = document.getElementById("fin-link-cliente-actions");
  if (!host) return;
  host.hidden = !show;
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
    hint.hidden = false;
  } else {
    hint.textContent = "";
    hint.hidden = true;
  }
}

// ── Base vinculada (cliente + marketplace) ─────────────────────────────────
async function detectarBaseVinculada() {
  const clienteSlug = document.getElementById("fin-cliente")?.value || "";
  const marketplace = document.getElementById("fin-marketplace")?.value || "";

  baseVinculadaState.clienteSlug = clienteSlug;
  baseVinculadaState.marketplace = marketplace;
  baseVinculadaState.hasLink = false;
  baseVinculadaState.baseId = null;
  baseVinculadaState.baseNome = null;

  if (!clienteSlug || !marketplace) {
    baseVinculadaState.loading = false;
    aplicarEstadoBase();
    return;
  }

  baseVinculadaState.loading = true;
  aplicarEstadoBase();

  try {
    const res = await fetch(`${API_BASE}/base-vinculos`, {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    if (res.status === 401) { window.location.replace("index.html"); return; }
    const data = await res.json();
    const bases = Array.isArray(data) ? data : (data?.bases || data?.data || []);

    const match = bases.find((b) => {
      const v = b?.vinculo;
      return v
        && String(v.cliente_slug || "").toLowerCase() === clienteSlug.toLowerCase()
        && String(v.marketplace || "").toLowerCase() === marketplace.toLowerCase();
    });

    // Evita condição de corrida: só aplica se a seleção não mudou.
    if (baseVinculadaState.clienteSlug !== clienteSlug ||
        baseVinculadaState.marketplace !== marketplace) return;

    if (match) {
      baseVinculadaState.hasLink = true;
      baseVinculadaState.baseId = match.id;
      baseVinculadaState.baseNome = match.nome || match.slug || ("Base #" + match.id);
    }
  } catch (_) {
    // Silencioso: cai no fluxo de upload manual.
  } finally {
    baseVinculadaState.loading = false;
    aplicarEstadoBase();
  }
}

// Aplica o estado da base à UI (chips, card de custos, status, hint, mini-resumo).
function aplicarEstadoBase() {
  atualizarChips();

  const marketplace = document.getElementById("fin-marketplace")?.value || "";
  const clienteSlug = document.getElementById("fin-cliente")?.value || "";
  const statusEl = document.getElementById("fin-base-status");
  const costsCard = document.getElementById("fin-costs-card");
  const costsBadge = document.getElementById("fin-costs-badge");
  const costsTitle = document.getElementById("fin-costs-title");
  const costsHint = document.getElementById("fin-costs-hint");
  const costsInput = document.getElementById("fin-costs");
  const costsNote = costsCard?.querySelector(".vf-fin-upload__note");
  const arquivosHint = document.getElementById("fin-arquivos-hint");

  const usandoBase = marketplace === "meli" && baseVinculadaState.hasLink;

  // Card de custos: base vinculada resolve os custos no servidor
  if (costsInput) costsInput.disabled = usandoBase;
  if (costsCard) {
    costsCard.classList.toggle("is-linked", usandoBase);
    if (usandoBase) {
      if (costsBadge) { costsBadge.textContent = "Base vinculada"; costsBadge.className = "vf-tag is-info"; }
      if (costsTitle) costsTitle.textContent = "Usando base vinculada do cliente";
      if (costsHint) costsHint.textContent = baseVinculadaState.baseNome || "Custos resolvidos automaticamente";
      // Limpa qualquer upload manual anterior para não conflitar
      if (costsInput && costsInput.files?.length) {
        costsInput.value = "";
        costsInput.dispatchEvent(new Event("change"));
      }
      costsCard.classList.remove("has-file");
      if (costsNote) {
        costsNote.classList.remove("is-error");
        costsNote.textContent = "Os custos serão resolvidos no servidor a partir da base vinculada. Não é preciso enviar planilha de custos.";
        costsNote.hidden = false;
      }
    } else {
      if (costsBadge) { costsBadge.textContent = "Obrigatório"; costsBadge.className = "vf-tag is-danger"; }
      if (costsTitle) costsTitle.textContent = "Clique ou arraste o arquivo";
      if (costsHint) costsHint.textContent = ".xlsx";
      if (costsNote) { costsNote.textContent = ""; costsNote.hidden = true; }
    }
  }

  // Status da base → vf-banner
  if (statusEl) {
    statusEl.classList.remove("is-info", "is-success", "is-warning", "is-danger");
    if (!clienteSlug || !marketplace) {
      statusEl.hidden = true;
    } else if (baseVinculadaState.loading) {
      statusEl.hidden = false;
      statusEl.classList.add("is-info");
      statusEl.textContent = "Verificando base vinculada do cliente…";
    } else if (baseVinculadaState.hasLink) {
      statusEl.hidden = false;
      statusEl.classList.add("is-success");
      statusEl.textContent = marketplace === "meli"
        ? `Base vinculada encontrada: "${baseVinculadaState.baseNome}". O upload de custos não é necessário.`
        : `Base vinculada encontrada: "${baseVinculadaState.baseNome}".`;
    } else if (marketplace === "meli") {
      statusEl.hidden = false;
      statusEl.classList.add("is-warning");
      statusEl.textContent = "Nenhuma base vinculada para este cliente/marketplace. Envie a planilha de custos manualmente.";
    } else {
      statusEl.hidden = true;
    }
  }

  // Hint dos arquivos
  if (arquivosHint) {
    if (usandoBase) arquivosHint.textContent = "Envie apenas a planilha de vendas — os custos vêm da base vinculada.";
    else if (marketplace === "shopee") arquivosHint.textContent = "Envie as planilhas de vendas e custos da Shopee.";
    else arquivosHint.textContent = "Envie a planilha de vendas e a planilha de custos.";
  }

  atualizarMiniResumo();
}

// ── Mini resumo antes de processar ─────────────────────────────────────────
function atualizarMiniResumo() {
  const sel = document.getElementById("fin-cliente");
  const clienteNome = sel?.value ? (sel.options?.[sel.selectedIndex]?.textContent || "—") : "—";
  const marketplace = document.getElementById("fin-marketplace")?.value || "";
  const usandoBase = marketplace === "meli" && baseVinculadaState.hasLink;

  const salesFile = document.getElementById("fin-sales")?.files?.[0];
  const costsFile = document.getElementById("fin-costs")?.files?.[0];
  const ordersAll = document.getElementById("fin-orders-all")?.files?.[0];

  const arquivos = [];
  if (salesFile) arquivos.push("vendas");
  if (costsFile) arquivos.push("custos");
  if (ordersAll) arquivos.push("Order.all");

  const ads = parseMoneyInput(document.getElementById("fin-ads")?.value);
  const venforce = parseMoneyInput(document.getElementById("fin-venforce")?.value);
  const afiliados = parseMoneyInput(document.getElementById("fin-affiliates")?.value);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("fin-res-cliente", clienteNome);
  set("fin-res-marketplace", marketplaceLabel(marketplace));
  set("fin-res-base", usandoBase ? `Vinculada (${baseVinculadaState.baseNome})` : (marketplace ? "Upload manual" : "—"));
  set("fin-res-arquivos", arquivos.length ? arquivos.join(", ") : "nenhum selecionado");
  if (marketplace === "meli") {
    const fullCost = parseMoneyInput(document.getElementById("fin-full-cost")?.value);
    const additionalCosts = parseMoneyInput(document.getElementById("fin-additional-costs")?.value);
    set("fin-res-ajustes", `ADS ${brl(ads)} · Venforce ${brl(venforce)} · Afiliados ${brl(afiliados)} · Full ${brl(fullCost)} · Custos adicionais ${brl(additionalCosts)}`);
  } else {
    set("fin-res-ajustes", `ADS ${brl(ads)} · Venforce ${brl(venforce)} · Afiliados ${brl(afiliados)}`);
  }
}

// Aceita "1.234,56" e "1234.56"
function parseMoneyInput(raw) {
  if (raw == null) return 0;
  let s = String(raw).trim();
  if (!s) return 0;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
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
        .map((c) => `<option value="${escapeHTML(c.slug)}">${escapeHTML(c.nome)}</option>`)
        .join("");
    atualizarHintClienteFinanceiro();
    atualizarChips();
    atualizarMiniResumo();
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
  // MC Final = LC Total (summary.finalResult) já descontado de Ads/Venforce/Afiliados, sobre o faturamento considerado.
  const mcFinal = net > 0 ? finalResult / net : 0;

  const isShopee = summaryNormalized.marketplace === "shopee" || !!summaryNormalized.hasShopeeStatusData;

  const lostRevenueTotal = safeNumber(summaryNormalized.lostRevenueTotal);
  const faturamentoPerdido = lostRevenueTotal > 0 ? -lostRevenueTotal : 0;

  const resumoExecutivo = isShopee
    ? [
        `Fechamento financeiro processado para ${String(meta.marketplace || "").toUpperCase()} em ${formatDateTimePtBR(meta.dataGeracao)}.`,
        `Receita bruta: ${brl(gross)} · Receita líquida: ${brl(net)}.`,
        `LC Total após Ads, Venforce e afiliados: ${brl(finalResult)} · MC Final: ${pct(mcFinal)} · TACoS: ${pct(tacos)}.`,
      ].join(" ")
    : [
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

  const cards = isShopee
    ? [
        { titulo: "Receita Bruta", valor: brl(gross), subtitulo: "Total vendido no período.", raw: gross, status: "neutro" },
        { titulo: "Receita Líquida", valor: brl(net), subtitulo: "Receita recebida no período.", raw: net, status: "neutro" },
        {
          titulo: "LC Total",
          valor: brl(finalResult),
          subtitulo: "LC Total após Ads, Venforce e afiliados.",
          destaque: true,
          raw: finalResult,
          status: finalResult > 0 ? "positivo" : (finalResult < 0 ? "critico" : "neutro"),
        },
        { titulo: "MC Final", valor: pct(mcFinal), subtitulo: "Margem de contribuição final.", raw: mcFinal, tipoValor: "pct", status: mcFinal >= 0.15 ? "positivo" : (mcFinal < 0 ? "critico" : "atencao") },
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

// Cria (rascunho) ou atualiza a entrega salva. Retorna o id.
async function criarOuAtualizarEntregaFechamento(payload, periodo) {
  const clienteSlug = document.getElementById("fin-cliente")?.value || null;

  if (_entregaIdSalvo) {
    const patchResp = await fetch(`${API_BASE}/entregas-cliente/${encodeURIComponent(_entregaIdSalvo)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ periodo: periodo || "", payload_json: payload }),
    });
    if (patchResp.status === 401) { window.location.replace("index.html"); throw new Error("401"); }
    // Se o PATCH falhar (ex.: entrega removida), recria abaixo.
    if (patchResp.ok) return _entregaIdSalvo;
    _entregaIdSalvo = null;
  }

  const criarResp = await fetch(`${API_BASE}/entregas-cliente`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
    body: JSON.stringify({
      tipo: "fechamento_mensal",
      titulo: payload.titulo || "Relatório de Fechamento Financeiro",
      periodo: periodo || "",
      cliente_slug: clienteSlug,
      status: "rascunho",
      payload_json: payload,
      origem_tipo: "fechamento_financeiro",
      origem_id: null,
    }),
  });
  if (criarResp.status === 401) { window.location.replace("index.html"); throw new Error("401"); }
  const criarJson = await criarResp.json();
  if (!criarResp.ok) throw new Error(criarJson?.erro || criarJson?.error || "Falha ao criar entrega.");
  const entregaId = criarJson?.entrega?.id;
  if (!entregaId) throw new Error("Entrega criada sem id.");
  _entregaIdSalvo = entregaId;
  return entregaId;
}

// Publica a entrega e retorna a URL pública.
async function publicarEntregaFechamento(entregaId) {
  const pubResp = await fetch(`${API_BASE}/entregas-cliente/${encodeURIComponent(entregaId)}/publicar`, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN },
  });
  if (pubResp.status === 401) { window.location.replace("index.html"); throw new Error("401"); }
  const pubJson = await pubResp.json();
  if (!pubResp.ok) throw new Error(pubJson?.erro || pubJson?.error || "Falha ao publicar entrega.");
  const token = pubJson?.entrega?.token_publico;
  if (!token) throw new Error("Entrega publicada sem token_publico.");

  _entregaPublicada = true;
  setChipSalvo("publicado para cliente", "ok");
  const btnSalvar = document.getElementById("btn-fin-salvar");
  if (btnSalvar) btnSalvar.textContent = "Salvar fechamento";

  return `${window.location.origin}/relatorio-publico.html?token=${encodeURIComponent(token)}`;
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
    const periodo = document.getElementById("fin-periodo")?.value?.trim() || payload.periodo || "";

    const entregaId = await criarOuAtualizarEntregaFechamento(payload, periodo);
    const publicUrl = await publicarEntregaFechamento(entregaId);

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
    const v = card?.querySelector?.(".vf-kpi__value");
    if (v) {
      v.textContent = "—";
      v.classList.remove("is-pos", "is-neg", "is-warn");
    }
  });
}

function setExecValue(id, value, formatter, mode = "neutral") {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = formatter(value);
  el.classList.remove("vf-fin-exec__value--pos", "vf-fin-exec__value--neg", "vf-fin-exec__value--muted");
  if (mode === "positive") el.classList.add("vf-fin-exec__value--pos");
  else if (mode === "negative") el.classList.add("vf-fin-exec__value--neg");
  else if (mode === "muted") el.classList.add("vf-fin-exec__value--muted");
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
    el.classList.remove("vf-fin-exec__value--pos", "vf-fin-exec__value--neg", "vf-fin-exec__value--muted");
  });
}

function renderFinResumoExecutivo(data) {
  const s = data?.summary || {};
  const isShopee = String(data?._vf_meta?.marketplace || "").toLowerCase() === "shopee";
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
  // MC Final (Shopee) = LC Total (summary.finalResult) já pós Ads/Venforce/Afiliados, sobre o faturamento considerado.
  const mcFinal = net > 0 ? finalResult / net : 0;
  const tacosValue = Number(s.tacos || 0);

  setExecValue("fin-exec-receita-bruta", gross, brl, gross > 0 ? "positive" : "neutral");
  setExecValue("fin-exec-receita-liquida", net, brl, net > 0 ? "positive" : "neutral");
  setExecValue("fin-exec-cancelamentos", refunds, brl, refunds < 0 ? "negative" : "neutral");
  setExecValue("fin-exec-pedidos-cancelados", refundsCount, num, refundsCount > 0 ? "negative" : "muted");

  setExecValue("fin-exec-ads", ads, brl, ads > 0 ? "negative" : "muted");
  setExecValue("fin-exec-venforce", venforce, brl, venforce > 0 ? "negative" : "muted");
  setExecValue("fin-exec-afiliados", afiliados, brl, afiliados > 0 ? "negative" : "muted");

  // Shopee: evita mostrar "Resultado Final" e "LC Total" como dois números concorrentes.
  const resultadoFinalRow = document.getElementById("fin-exec-resultado-final")?.closest(".vf-fin-exec__row");
  const mcMediaLabelEl = document.getElementById("fin-exec-mc-media")?.previousElementSibling;

  if (isShopee) {
    if (resultadoFinalRow) resultadoFinalRow.hidden = true;
    setExecValue("fin-exec-lc-total", finalResult, brl, finalResult > 0 ? "positive" : (finalResult < 0 ? "negative" : "neutral"));
    if (mcMediaLabelEl) mcMediaLabelEl.textContent = "MC Final";
    setExecValue("fin-exec-mc-media", mcFinal, pct, mcFinal > 0 ? "positive" : (mcFinal < 0 ? "negative" : "neutral"));
  } else {
    if (resultadoFinalRow) resultadoFinalRow.hidden = false;
    setExecValue("fin-exec-resultado-final", finalResult, brl, finalResult > 0 ? "positive" : (finalResult < 0 ? "negative" : "neutral"));
    setExecValue("fin-exec-lc-total", lcTotal, brl, lcTotal > 0 ? "positive" : (lcTotal < 0 ? "negative" : "neutral"));
    if (mcMediaLabelEl) mcMediaLabelEl.textContent = "MC Média";
    setExecValue("fin-exec-mc-media", mcMedia, pct, mcMedia > 0 ? "positive" : (mcMedia < 0 ? "negative" : "neutral"));
  }
  setExecValue("fin-exec-tacos", tacosValue, pct, "muted");
}

function renderFinResumo(data) {
  const s = data?.summary || {};
  const isShopee = String(data?._vf_meta?.marketplace || "").toLowerCase() === "shopee";

  function setCard(id, rawValue, formattedValue) {
    const el = document.getElementById(id)?.querySelector(".vf-kpi__value");
    if (!el) return;
    el.textContent = formattedValue;
    el.classList.remove("is-pos", "is-neg", "is-warn");
    const n = Number(rawValue);
    if (!Number.isFinite(n) || n === 0) return;
    el.classList.add(n > 0 ? "is-pos" : "is-neg");
  }

  setCard("fin-bruto", s.grossRevenueTotal, brl(s.grossRevenueTotal));
  setCard("fin-liquido", s.paidRevenueTotal, brl(s.paidRevenueTotal));

  // Shopee: "LC Total" passa a ser summary.finalResult (já pós Ads/Venforce/Afiliados);
  // o card "Resultado Final" fica escondido por ser o mesmo valor, e "MC Média" vira "MC Final".
  const finResultadoEl = document.getElementById("fin-resultado");
  const mcTitleEl = document.getElementById("fin-mc")?.querySelector(".vf-kpi__label");
  if (isShopee) {
    if (finResultadoEl) finResultadoEl.hidden = true;
    const finalResult = Number(s.finalResult || 0);
    const net = Number(s.paidRevenueTotal || 0);
    const mcFinal = net > 0 ? finalResult / net : 0;
    setCard("fin-lc", finalResult, brl(finalResult));
    if (mcTitleEl) mcTitleEl.textContent = "MC Final";
    setCard("fin-mc", mcFinal, pct(mcFinal));
  } else {
    if (finResultadoEl) finResultadoEl.hidden = false;
    if (mcTitleEl) mcTitleEl.textContent = "MC Média";
    setCard("fin-lc", s.contributionProfitTotal, brl(s.contributionProfitTotal));
    setCard("fin-mc", s.averageContributionMargin, pct(s.averageContributionMargin));
    setCard("fin-resultado", s.finalResult, brl(s.finalResult));
  }
  setCard("fin-tacos", s.tacos, pct(s.tacos));

  // Cancelamentos: setCard já pinta vermelho quando valor < 0
  setCard("fin-cancelamentos", s.refundsTotal, brl(s.refundsTotal));
  // Faturamento perdido: valor integral dos produtos cancelados (I das linhas
  // canceladas). Mostra como negativo porque é dinheiro de venda que o seller
  // não recebeu. Usar -lostRevenueTotal para o setCard pintar de vermelho.
  const lostNegative = -Number(s.lostRevenueTotal || 0);
  setCard("fin-faturamento-perdido", lostNegative, brl(lostNegative));

  // Cards Shopee — só populam se vieram no summary.
  const setCountColor = (el, on, cls) => {
    if (!el) return;
    el.classList.remove("is-pos", "is-neg", "is-warn");
    if (on) el.classList.add(cls);
  };

  const shopeeCancCount = Number(s.cancelledCount || 0);
  const elShopeeCancCount = document
    .getElementById("fin-shopee-cancelados-count")
    ?.querySelector(".vf-kpi__value");
  if (elShopeeCancCount) {
    elShopeeCancCount.textContent = num(shopeeCancCount);
    setCountColor(elShopeeCancCount, shopeeCancCount > 0, "is-neg");
  }

  const shopeeLost = -Number(s.cancelledLostRevenue || 0);
  setCard("fin-shopee-faturamento-perdido", shopeeLost, brl(shopeeLost));

  const unpaidCount = Number(s.unpaidCount || 0);
  const elUnpaid = document
    .getElementById("fin-shopee-nao-pagos")
    ?.querySelector(".vf-kpi__value");
  if (elUnpaid) {
    const unpaidVal = Number(s.unpaidLostRevenue || 0);
    elUnpaid.textContent = unpaidCount > 0
      ? `${num(unpaidCount)} (${brl(unpaidVal)})`
      : "—";
    setCountColor(elUnpaid, unpaidCount > 0, "is-warn");
  }

  // Pedidos cancelados: contagem; coloração semântica (não é financeiro)
  const elCount = document
    .getElementById("fin-cancelados-count")
    ?.querySelector(".vf-kpi__value");
  if (elCount) {
    const count = Number(s.refundsCount || 0);
    elCount.textContent = num(count);
    setCountColor(elCount, count > 0, "is-neg");
  }

  // Leitura executiva do fechamento
  renderLeituraFechamento(data);
}

// ── "Leitura do fechamento" — resumo executivo objetivo (sem inventar números)
function renderLeituraFechamento(data) {
  const host = document.getElementById("fin-leitura");
  if (!host) return;
  const s = data?.summary || {};
  const isShopee = String(data?._vf_meta?.marketplace || "").toLowerCase() === "shopee";
  const finalResult = Number(s.finalResult || 0);
  const lcTotal = Number(s.contributionProfitTotal || 0);
  const mcMedia = Number(s.averageContributionMargin || 0);
  const net = Number(s.paidRevenueTotal || 0);
  const mcFinal = net > 0 ? finalResult / net : 0;
  const tacos = Number(s.tacos || 0);
  const unmatched = Array.isArray(data?.unmatchedIds) ? data.unmatchedIds.length : 0;
  const refundsCount = Number(s.refundsCount || 0);
  const lost = Number(s.lostRevenueTotal || 0);

  const positivo = finalResult >= 0;
  // Shopee: não repetir o mesmo valor sob dois rótulos concorrentes (LC total / Resultado final).
  const mcReferencia = isShopee ? mcFinal : mcMedia;
  const bullets = [];
  if (isShopee) {
    bullets.push(`LC Total após Ads, Venforce e afiliados ${positivo ? "positivo" : "negativo"} de <b>${brl(finalResult)}</b> (MC Final ${pct(mcFinal)}).`);
  } else {
    bullets.push(`Resultado final ${positivo ? "positivo" : "negativo"} de <b>${brl(finalResult)}</b> (LC total ${brl(lcTotal)}, MC média ${pct(mcMedia)}).`);
  }
  if (tacos > 0) bullets.push(`TACoS de <b>${pct(tacos)}</b> — ADS como percentual da receita.`);
  if (mcReferencia < 0.15) bullets.push(`Margem de contribuição ${isShopee ? "final" : "média"} <b>abaixo de 15%</b> — atenção a custos, comissões e frete.`);
  if (unmatched > 0) bullets.push(`<b>${num(unmatched)}</b> produto(s) sem custo/base cadastrado — os cálculos podem estar incompletos.`);
  if (refundsCount > 0) bullets.push(`<b>${num(refundsCount)}</b> cancelamento(s)/reembolso(s) no período.`);
  if (lost > 0) bullets.push(`Faturamento perdido estimado de <b>${brl(lost)}</b> em pedidos cancelados.`);

  const tone = !positivo || mcReferencia < 0 ? "danger" : (mcReferencia < 0.15 || unmatched > 0 ? "warn" : "success");
  const toneClass = tone === "danger" ? "is-danger" : tone === "warn" ? "is-warning" : "is-success";

  host.innerHTML = `
    <div class="vf-banner ${toneClass}" role="status">
      <div class="vf-banner__content">
        <p class="vf-banner__title">Leitura do fechamento</p>
        <ul class="vf-fin-leitura__list">
          ${bullets.map((b) => `<li>${b}</li>`).join("")}
        </ul>
      </div>
    </div>`;
  host.hidden = false;
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
  if (numericCols.has(col)) parts.push("num");

  const l = finColumnKey(col);
  if (/(^id$|item_id|produto_id|id_produto|^# de anuncio$|id.*anuncio|anuncio.*id|mlb|sku)/.test(l)) {
    parts.push("vf-mono", "vf-fin-col--id");
  } else if (/titulo|title|nome|produto|descri|item_title/.test(l)) {
    parts.push("vf-fin-col--produto");
  }

  return parts.length ? ` class="${parts.join(" ")}"` : "";
}

function limparShopeeReconciliacao() {
  const el = document.getElementById("fin-shopee-reconciliacao");
  if (!el) return;
  el.hidden = true;
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

  // Maiores impactos de cancelamento confirmado — consolidados em um popover
  // ancorado no card "Cancelados confirmados" (antes eram um bloco longo).
  const topCancelled = Array.isArray(s.orderAllTopCancelledItems) ? s.orderAllTopCancelledItems : [];
  const impactItems = topCancelled.filter((i) => i && i.productName);
  const impactsPopId = "fin-recon-impacts-pop";
  const impactsPopHtml = impactItems.length
    ? `<button type="button" class="vf-fin-impact-trigger" aria-label="Ver maiores impactos" aria-expanded="false" aria-controls="${impactsPopId}">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path></svg>
      </button>
      <div class="vf-fin-impact-popover" id="${impactsPopId}" role="dialog" aria-label="Maiores impactos de cancelamento confirmado" hidden>
        <div class="vf-fin-impact-popover__header">
          <strong>Maiores impactos</strong>
          <button type="button" class="vf-fin-impact-popover__close" aria-label="Fechar">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
          </button>
        </div>
        <p class="vf-fin-impact-popover__description">Produtos mais afetados por cancelamento confirmado.</p>
        <div class="vf-fin-impact-popover__list">${impactItems.map((i) => `<div class="vf-fin-impact-popover__item"><span class="vf-fin-impact-popover__name">${escapeHTML(i.productName)}</span><span class="vf-fin-impact-popover__meta">${num(i.count || 0)} pedido${(i.count || 0) !== 1 ? "s" : ""} · ${brl(i.revenue || 0)}</span></div>`).join("")}</div>
      </div>`
    : "";

  const cardsHtml = statusItems.map((item) => {
    const isCancelled = item.label === "Cancelados confirmados";
    const infoHtml = isCancelled ? impactsPopHtml : "";
    const extraClass = isCancelled && infoHtml ? " has-info" : "";
    return `<div class="vf-fin-reconciliation__item is-${item.tone}${extraClass}">
      ${infoHtml}
      <div class="vf-fin-reconciliation__item-label">${escapeHTML(item.label)}</div>
      <div class="vf-fin-reconciliation__item-support">${escapeHTML(item.support)}</div>
      <div class="vf-fin-reconciliation__item-value">${brl(item.revenue)}</div>
      <div class="vf-fin-reconciliation__item-count">${num(item.count)} pedido${item.count !== 1 ? "s" : ""}</div>
    </div>`;
  }).join("");

  // Explicação curta mantida abaixo dos KPIs (diferença Performance × Reconciliação).
  const diffHtml = reconcRevenue > perfRevenue
    ? `<p class="vf-fin-reconciliation__note">A diferença entre Performance e Reconciliação acontece porque a Performance considera apenas pedidos pagos usados no cálculo financeiro. A Reconciliação inclui também cancelados, não pagos, devoluções e status operacionais.</p>`
    : "";

  el.innerHTML = `<section class="vf-card">
    <div class="vf-card__header">
      <div>
        <h2 class="vf-card__title">Reconciliação Shopee</h2>
      </div>
    </div>
    <div class="vf-card__body vf-fin-reconciliation">
      <div class="vf-fin-reconciliation__header">
        <div class="vf-fin-reconciliation__compare">
          <div class="vf-fin-reconciliation__compare-item">
            <span class="vf-fin-reconciliation__compare-label">Performance (pedidos pagos)</span>
            <span class="vf-fin-reconciliation__compare-value is-pos">${brl(perfRevenue)}</span>
          </div>
          <div class="vf-fin-reconciliation__sep" aria-hidden="true">→</div>
          <div class="vf-fin-reconciliation__compare-item">
            <span class="vf-fin-reconciliation__compare-label">Reconciliação (visão completa)</span>
            <span class="vf-fin-reconciliation__compare-value">${brl(reconcRevenue)}</span>
          </div>
        </div>
      </div>
      <div class="vf-fin-reconciliation__grid">${cardsHtml}</div>
      <div class="vf-fin-reconciliation__text">
        ${diffHtml}
      </div>
    </div>
  </section>`;
  el.hidden = false;

  wireReconInfoPopover(el);
}

// Fiação do popover de "Maiores impactos" ancorado no card
// "Cancelados confirmados". Apenas apresentação — não altera cálculos.
// O painel visual é movido para document.body enquanto aberto e
// posicionado com position: fixed, para nunca ser cortado pelo overflow
// do painel da Reconciliação.
function wireReconInfoPopover(root) {
  // Remove qualquer popover órfão de uma renderização anterior.
  document.querySelectorAll("body > .vf-fin-impact-popover").forEach((n) => n.remove());

  const trigger = root.querySelector(".vf-fin-impact-trigger");
  const pop = root.querySelector(".vf-fin-impact-popover");
  if (!trigger || !pop) return;

  const home = pop.parentNode; // volta para o card ao fechar
  const MARGIN = 12;
  const GAP = 6;
  let isOpen = false;

  function position() {
    const r = trigger.getBoundingClientRect();
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: alinhado à direita do gatilho, preso à viewport.
    let left = r.right - pw;
    left = Math.min(left, vw - MARGIN - pw);
    left = Math.max(left, MARGIN);

    // Vertical: abaixo quando cabe; senão acima; senão o lado com mais espaço.
    const spaceBelow = vh - r.bottom;
    const spaceAbove = r.top;
    let top;
    if (spaceBelow >= ph + GAP + MARGIN) top = r.bottom + GAP;
    else if (spaceAbove >= ph + GAP + MARGIN) top = r.top - ph - GAP;
    else top = spaceBelow >= spaceAbove ? r.bottom + GAP : r.top - ph - GAP;
    top = Math.min(top, vh - MARGIN - ph);
    top = Math.max(top, MARGIN);

    pop.style.top = `${Math.round(top)}px`;
    pop.style.left = `${Math.round(left)}px`;
  }

  function onDocClick(ev) {
    if (!pop.contains(ev.target) && !trigger.contains(ev.target)) close();
  }
  function onKeydown(ev) {
    if (ev.key === "Escape") { close(); trigger.focus(); }
  }
  function onScrollOrResize() {
    if (isOpen) position();
  }

  function open() {
    if (isOpen) return;
    document.body.appendChild(pop); // fora de qualquer container com overflow
    pop.style.visibility = "hidden";
    pop.hidden = false;
    position(); // mede e posiciona antes de revelar
    pop.style.visibility = "";
    isOpen = true;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKeydown, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
  }
  function close() {
    if (!isOpen) return;
    pop.hidden = true;
    pop.style.visibility = "";
    pop.style.top = "";
    pop.style.left = "";
    if (home && pop.parentNode !== home) home.appendChild(pop);
    isOpen = false;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("scroll", onScrollOrResize, true);
    window.removeEventListener("resize", onScrollOrResize);
  }

  trigger.addEventListener("click", (ev) => {
    ev.stopPropagation();
    isOpen ? close() : open();
  });
  pop.querySelector(".vf-fin-impact-popover__close")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    close();
    trigger.focus();
  });
}

function renderFinTabela(data) {
  const host = document.getElementById("fin-tabela");
  if (!host) return;

  const rows = Array.isArray(data?.detailedRows) ? data.detailedRows : [];
  host.innerHTML = "";

  if (!rows.length) {
    const emptyPanel = document.createElement("div");
    emptyPanel.className = "vf-card";
    emptyPanel.innerHTML = `<div class="vf-empty"><p class="vf-empty__title">Nenhum dado para exibir</p></div>`;
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
    let activeFilter = "";

    // Detecção de colunas semânticas para os filtros rápidos.
    const findCol = (re) => columns.find((c) => re.test(finColumnKey(c)));
    const colLc   = findCol(/(^lc$)|lucro|contrib/);
    const colMc   = findCol(/(^mc$)|margem/);
    const colDiag = findCol(/diagn|status/);
    const colFat  = findCol(/faturamento|receita|total.*brl|valor.*total|preco.*total|vendas/);
    const colId   = findCol(/(^id$)|item_id|produto_id|anuncio|mlb|sku/);
    const unmatchedSet = new Set((Array.isArray(data?.unmatchedIds) ? data.unmatchedIds : []).map((x) => String(x)));

    function cellNum(v) {
      if (typeof v === "number") return v;
      let s = String(v ?? "").replace(/[^\d,.\-]/g, "");
      if (!s) return NaN;
      if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
      else if (s.includes(",")) s = s.replace(",", ".");
      const n = Number(s);
      return Number.isFinite(n) ? n : NaN;
    }
    // MC pode vir como fração (0.12) ou pontos percentuais (12,5). Meta = 15%.
    function mcAbaixoMeta(v) {
      const n = cellNum(v);
      if (!Number.isFinite(n)) return false;
      const frac = Math.abs(n) > 1 ? n / 100 : n;
      return frac >= 0 && frac < 0.15;
    }
    const diagInclui = (r, re) => colDiag && re.test(finColumnKey(String(r?.[colDiag] ?? "")));

    // Definição dos filtros disponíveis (só entram os que fazem sentido nos dados).
    const FILTERS = [
      { key: "sem-custo",   label: "Produto sem custo", enabled: !!(colDiag || (colId && unmatchedSet.size)),
        test: (r) => diagInclui(r, /sem custo|sem base|nao encontrad|nao localizad/) || (colId && unmatchedSet.has(String(r?.[colId] ?? ""))) },
      { key: "mc-neg",      label: "Margem negativa", enabled: !!colMc,
        test: (r) => cellNum(r?.[colMc]) < 0 },
      { key: "mc-meta",     label: "Abaixo da meta (15%)", enabled: !!colMc,
        test: (r) => mcAbaixoMeta(r?.[colMc]) },
      { key: "cancelados",  label: "Cancelados", enabled: !!colDiag,
        test: (r) => diagInclui(r, /cancel|reembols|devolu/) },
      { key: "maior-fat",   label: "Maior faturamento", enabled: !!colFat, sort: true,
        cmp: (a, b) => (cellNum(b?.[colFat]) || -Infinity) - (cellNum(a?.[colFat]) || -Infinity) },
      { key: "maior-prej",  label: "Maior prejuízo", enabled: !!colLc, sort: true,
        cmp: (a, b) => (cellNum(a?.[colLc]) || Infinity) - (cellNum(b?.[colLc]) || Infinity) },
    ].filter((f) => f.enabled);

    function getFiltered() {
      let out = rows;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        out = out.filter((r) => columns.some((c) => String(r?.[c] ?? "").toLowerCase().includes(q)));
      }
      const f = FILTERS.find((x) => x.key === activeFilter);
      if (f) {
        if (f.sort) out = out.slice().sort(f.cmp);
        else out = out.filter(f.test);
      }
      return out;
    }

    const panelEl = document.createElement("div");
    panelEl.className = "vf-card";
    panelEl.innerHTML = `
      <div class="vf-card__body vf-stack">
        <div class="vf-section__header">
          <h2 class="vf-section__title">Detalhamento por produto</h2>
        </div>
        <div class="vf-toolbar">
          <div class="vf-toolbar__filters">
            <input type="text" class="vf-input vf-search vf-fin-search" placeholder="Buscar por ID ou título…" autocomplete="off" aria-label="Buscar produtos">
            <span class="vf-fin-counter"></span>
          </div>
          <div class="vf-toolbar__actions">
            <label class="vf-page-size">Por página
              <select class="vf-select vf-fin-page-select" aria-label="Itens por página">
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select>
            </label>
          </div>
        </div>
        <div class="vf-cluster vf-fin-filter-chips"></div>
        <div class="vf-table-wrap vf-fin-table-wrap"></div>
        <nav class="vf-pagination" aria-label="Paginação de produtos">
          <span class="vf-pagination__info vf-fin-page-info"></span>
          <div class="vf-pagination__actions">
            <button class="vf-btn vf-btn--secondary vf-btn--sm vf-fin-prev" type="button">Anterior</button>
            <button class="vf-btn vf-btn--secondary vf-btn--sm vf-fin-next" type="button">Próxima</button>
          </div>
        </nav>
      </div>
    `;

    const searchInputEl  = panelEl.querySelector(".vf-fin-search");
    const pageSelectEl   = panelEl.querySelector(".vf-fin-page-select");
    const counterEl      = panelEl.querySelector(".vf-fin-counter");
    const filterChipsEl  = panelEl.querySelector(".vf-fin-filter-chips");
    const tableScrollEl  = panelEl.querySelector(".vf-fin-table-wrap");
    const prevBtn        = panelEl.querySelector(".vf-fin-prev");
    const nextBtn        = panelEl.querySelector(".vf-fin-next");
    const pageInfoEl     = panelEl.querySelector(".vf-fin-page-info");

    function renderFilterChips() {
      if (!filterChipsEl) return;
      if (!FILTERS.length) { filterChipsEl.hidden = true; return; }
      filterChipsEl.innerHTML = FILTERS.map((f) =>
        `<button type="button" class="vf-filter-chip${activeFilter === f.key ? " is-active" : ""}" data-filter="${escapeHTML(f.key)}" aria-pressed="${activeFilter === f.key ? "true" : "false"}">${escapeHTML(f.label)}</button>`
      ).join("");
      filterChipsEl.querySelectorAll(".vf-filter-chip").forEach((btn) => {
        btn.addEventListener("click", () => {
          const k = btn.getAttribute("data-filter");
          activeFilter = activeFilter === k ? "" : k;
          currentPage = 1;
          renderFilterChips();
          renderPage();
        });
      });
    }

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
      // Largura mínima calculada dinamicamente a partir das colunas detectadas
      tableScrollEl.style.setProperty("--vf-fin-detail-min-width", `${detailMinWidth}px`);

      const COL_ABBREV = {
        "Preço unitário de venda do anúncio (BRL)": "Preço Unit.",
        "Preço de custo total": "Custo Total",
        "Ajuste plataforma (BRL)": "Aj. Plataforma",
        "Título do anúncio": "Título",
      };
      const thHtml = columns.map((c) => {
        const minWidth = finColumnMinWidth(c, numericCols);
        const w = ` style="min-width:${minWidth}px"`;
        const label = COL_ABBREV[c] || c;
        return `<th${finColumnCellClassAttr(c, numericCols)}${w}>${escapeHTML(String(label))}</th>`;
      }).join("");

      const tbodyHtml = pageRows.map((r) => {
        const tds = columns.map((c) => {
          let attr = finColumnCellClassAttr(c, numericCols);
          if (c === colLc || c === colMc) {
            const n = cellNum(r?.[c]);
            if (Number.isFinite(n) && n !== 0) {
              const cls = n > 0 ? "vf-fin-num--pos" : "vf-fin-num--neg";
              attr = attr ? attr.replace('class="', `class="${cls} `) : ` class="${cls}"`;
            }
          }
          return `<td${attr}>${escapeHTML(String(r?.[c] ?? ""))}</td>`;
        }).join("");
        return `<tr>${tds}</tr>`;
      }).join("");

      tableScrollEl.innerHTML = `<table class="vf-table vf-table--compact vf-fin-detail"><thead><tr>${thHtml}</tr></thead><tbody>${tbodyHtml}</tbody></table>`;

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
    renderFilterChips();
    renderPage();
  }

  // --- IDs sem custo ---
  const unmatched = Array.isArray(data?.unmatchedIds) ? data.unmatchedIds : [];
  if (unmatched.length > 0) {
    const panel = document.createElement("div");
    panel.className = "vf-banner is-danger";
    panel.setAttribute("role", "alert");

    const idsHtml = unmatched
      .map((id) => `<span class="vf-fin-idlist__item vf-mono">${escapeHTML(String(id))}</span>`)
      .join("");

    panel.innerHTML = `
      <div class="vf-banner__content">
        <p class="vf-banner__title">${unmatched.length} ID(s) não encontrados na planilha de custos</p>
        <p class="vf-banner__description">Receita ignorada: ${escapeHTML(brl(data?.ignoredRevenue || 0))}. Cadastre esses IDs na base de custos e processe novamente.</p>
        <div class="vf-fin-idlist">${idsHtml}</div>
      </div>
    `;
    host.appendChild(panel);
  }

  // --- Cancelados sem custo ---
  const unmatchedCancelled = Array.isArray(data?.unmatchedCancelled) ? data.unmatchedCancelled : [];
  if (unmatchedCancelled.length > 0) {
    const panel = document.createElement("div");
    panel.className = "vf-banner is-warning";
    panel.setAttribute("role", "status");

    const itemsHtml = unmatchedCancelled
      .map((c) => `<span class="vf-fin-idlist__item">${escapeHTML(c.productName || "—")} <span class="vf-fin-muted">· SKU: ${escapeHTML(c.skuPrincipal || "—")} · ${escapeHTML(brl(c.subtotal || 0))}</span></span>`)
      .join("");

    panel.innerHTML = `
      <div class="vf-banner__content">
        <p class="vf-banner__title">${unmatchedCancelled.length} pedido(s) cancelado(s) sem custo identificado</p>
        <p class="vf-banner__description">Esses pedidos cancelados não foram encontrados na base de custos via SKU. Cadastre o produto na base e processe novamente para incluir nos cálculos.</p>
        <div class="vf-fin-idlist">${itemsHtml}</div>
      </div>
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
  if (btn) btn.hidden = true;
}
function setXlsBlob(blob, filename) {
  limparXlsBlob();
  _xlsBlobUrl = URL.createObjectURL(blob);
  _xlsFilename = filename || "fechamento-resultado.xlsx";
  const btn = document.getElementById("btn-fin-download");
  if (btn) btn.hidden = false;
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

  const clienteSlug = document.getElementById("fin-cliente")?.value || "";

  const sales = document.getElementById("fin-sales")?.files?.[0];
  if (!sales) { setStatus("Selecione a planilha de vendas (.xlsx).", "danger"); return; }

  const costs = document.getElementById("fin-costs")?.files?.[0];
  const usandoBase = marketplace === "meli" && baseVinculadaState.hasLink && !costs;

  // Custos: arquivo manual OU base vinculada (só MELI).
  if (!costs && !usandoBase) {
    if (marketplace === "meli") {
      setStatus("Selecione a planilha de custos ou vincule uma base ao cliente na tela de Bases.", "danger");
    } else {
      setStatus("Selecione a planilha de custos (.xlsx).", "danger");
    }
    return;
  }

  const btn = document.getElementById("btn-fin-processar");
  setBtnLoading(btn, true, "Processando…");
  setChipProcessamento("processando…", "info");
  setStatus("Processando…", "info");

  try {
    const ads = parseMoneyInput(document.getElementById("fin-ads")?.value);
    const venforce = parseMoneyInput(document.getElementById("fin-venforce")?.value);
    const affiliates = parseMoneyInput(document.getElementById("fin-affiliates")?.value);

    const formData = new FormData();
    formData.append("sales", sales);
    formData.append("marketplace", marketplace);
    if (clienteSlug) formData.append("cliente_slug", clienteSlug);

    if (usandoBase) {
      // MELI com base vinculada — custos resolvidos no servidor.
      if (baseVinculadaState.baseId != null) formData.append("costsBaseId", baseVinculadaState.baseId);
    } else {
      formData.append("costs", costs);
    }

    // Order.all opcional, só Shopee
    if (marketplace === "shopee") {
      const ordersAll = document.getElementById("fin-orders-all")?.files?.[0];
      if (ordersAll) formData.append("ordersAll", ordersAll);
    }
    formData.append("ads", String(ads));
    formData.append("venforce", String(venforce));
    formData.append("affiliates", String(affiliates));

    // FULL e Custos adicionais: opcionais, só Mercado Livre.
    if (marketplace === "meli") {
      const fullCost = parseMoneyInput(document.getElementById("fin-full-cost")?.value);
      const additionalCosts = parseMoneyInput(document.getElementById("fin-additional-costs")?.value);
      formData.append("fullCost", String(fullCost));
      formData.append("additionalCosts", String(additionalCosts));
    }

    const res = await fetch(`${API_BASE}/fechamentos/financeiro`, {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN },
      body: formData
    });

    if (res.status === 401) { window.location.replace("index.html"); return; }

    const json = await res.json();
    if (!res.ok) throw new Error(json.erro || json.error || json.message || "HTTP " + res.status);

    // Snapshot do fechamento para gerar entrega ao cliente (não altera cálculo)
    const clienteSel = document.getElementById("fin-cliente");
    const clienteNome = clienteSel?.value ? (clienteSel.options?.[clienteSel.selectedIndex]?.textContent || "") : "";
    const periodo = document.getElementById("fin-periodo")?.value?.trim() || "";
    const dataGeracao = new Date().toISOString();
    json._vf_meta = {
      marketplace,
      ads, venforce, affiliates,
      dataGeracao,
      periodo,
      cliente: clienteSlug ? { slug: clienteSlug, nome: clienteNome } : {},
    };
    ultimoFechamentoFinanceiro = { data: json, marketplace, ads, venforce, affiliates, dataGeracao };

    // Novo processamento invalida a entrega salva anterior.
    _entregaIdSalvo = null;
    _entregaPublicada = false;

    // Painel legado permanece oculto — a entrega é feita pela aba "Entrega para o cliente".
    showLinkClienteActions(false);
    setLinkClienteOutput("");

    renderFinResumo(json);
    renderFinResumoExecutivo(json);
    renderShopeeReconciliacao(json);
    renderFinTabela(json);
    document.querySelector(".vf-fin-dashboard")?.setAttribute("data-processed", "");
    initEntregaTabs();

    // Ações pós-processamento
    const btnSalvar = document.getElementById("btn-fin-salvar");
    if (btnSalvar) { btnSalvar.hidden = false; btnSalvar.disabled = false; btnSalvar.textContent = "Salvar fechamento"; }
    setChipProcessamento("processado", "ok");
    setChipSalvo("processado, ainda não salvo", "warn");

    const origemTxt = json.costsSource === "base"
      ? ` Custos: base vinculada${json.costsBase?.nome ? ` "${json.costsBase.nome}"` : ""}.`
      : "";
    setStatus("✓ Processado com sucesso." + origemTxt, "success");

    if (json.excelBase64) {
      const blob = base64ToBlob(json.excelBase64, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      setXlsBlob(blob, `fechamento-${marketplace}-${todayISO()}.xlsx`);
    }
  } catch (err) {
    setChipProcessamento("erro", "bad");
    setStatus("Erro: " + (err?.message || "Falha ao processar."), "danger");
  } finally {
    setBtnLoading(btn, false, "Processar fechamento");
  }
}

// Helper: estado de loading em botões. O spinner é do componente V2
// (.vf-btn.is-loading exibe um spinner absoluto sem alterar a largura),
// então preservamos o rótulo original — nada de HTML injetado.
function setBtnLoading(btn, loading, labelWhileLoading) {
  if (!btn) return;
  if (loading) {
    btn.disabled = true;
    btn.classList.add("is-loading");
  } else {
    btn.disabled = false;
    btn.classList.remove("is-loading");
    if (labelWhileLoading) btn.textContent = labelWhileLoading;
  }
}

// ── Salvar fechamento (reuso de entregas_cliente como rascunho) ─────────────
async function salvarFechamentoFinanceiro() {
  if (!TOKEN) return;
  if (!ultimoFechamentoFinanceiro?.data) {
    setStatus("Processe um fechamento antes de salvar.", "danger");
    return;
  }

  const btn = document.getElementById("btn-fin-salvar");
  setBtnLoading(btn, true, "Salvando…");
  setStatus("Salvando fechamento…", "info");

  try {
    const data = ultimoFechamentoFinanceiro.data;
    const payload = montarPayloadFechamentoCliente(data);
    const clienteSlug = document.getElementById("fin-cliente")?.value || null;
    const periodo = document.getElementById("fin-periodo")?.value?.trim() || payload.periodo || "";

    let resp;
    if (_entregaIdSalvo) {
      // Já salvo antes: atualiza o payload/período em vez de duplicar.
      resp = await fetch(`${API_BASE}/entregas-cliente/${encodeURIComponent(_entregaIdSalvo)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
        body: JSON.stringify({ periodo, payload_json: payload }),
      });
    } else {
      resp = await fetch(`${API_BASE}/entregas-cliente`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
        body: JSON.stringify({
          tipo: "fechamento_mensal",
          titulo: payload.titulo || "Fechamento Financeiro",
          periodo,
          cliente_slug: clienteSlug,
          status: "rascunho",
          payload_json: payload,
          origem_tipo: "fechamento_financeiro",
          origem_id: null,
        }),
      });
    }

    if (resp.status === 401) { window.location.replace("index.html"); return; }
    const json = await resp.json();
    if (!resp.ok) throw new Error(json?.erro || json?.error || "Falha ao salvar fechamento.");

    _entregaIdSalvo = json?.entrega?.id || _entregaIdSalvo;
    setChipSalvo(_entregaPublicada ? "publicado para cliente" : "fechamento salvo", _entregaPublicada ? "ok" : "ok");
    setStatus("✓ Fechamento salvo.", "success");
  } catch (err) {
    setStatus("Erro ao salvar: " + (err?.message || "Falha."), "danger");
  } finally {
    setBtnLoading(btn, false, "Salvar fechamento");
  }
}

function formatFileSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

// Atualiza o cartão de upload: alterna dropzone/file-item e estado has-file.
// O markup do file-item é estático (vf-file-item) — só preenchemos nome/tamanho.
function updateFileCard(inputEl) {
  if (!inputEl) return;
  const card = inputEl.closest(".vf-fin-upload");
  if (!card) return;
  const fileItem = card.querySelector(".vf-file-item");
  const nameEl = fileItem?.querySelector(".vf-file-item__name");
  const infoEl = fileItem?.querySelector(".vf-file-item__info");
  const f = inputEl.files?.[0];
  if (f) {
    if (nameEl) nameEl.textContent = f.name;
    if (infoEl) infoEl.textContent = formatFileSize(f.size);
    if (fileItem) fileItem.hidden = false;
    card.classList.add("has-file");
  } else {
    if (nameEl) nameEl.textContent = "";
    if (infoEl) infoEl.textContent = "";
    if (fileItem) fileItem.hidden = true;
    card.classList.remove("has-file");
  }
  atualizarMiniResumo();
}

function initUploadDragDrop(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const card = input.closest(".vf-fin-upload");
  if (!card) return;
  const note = card.querySelector(".vf-fin-upload__note");

  card.addEventListener("dragover", (e) => {
    if (input.disabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    card.classList.add("is-dragging");
  });

  card.addEventListener("dragleave", (e) => {
    if (!card.contains(e.relatedTarget)) card.classList.remove("is-dragging");
  });

  card.addEventListener("drop", (e) => {
    e.preventDefault();
    card.classList.remove("is-dragging");
    if (input.disabled) return;
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      if (note) {
        note.textContent = "Apenas arquivos .xlsx são aceitos.";
        note.classList.add("is-error");
        note.hidden = false;
        setTimeout(() => { note.textContent = ""; note.classList.remove("is-error"); note.hidden = true; }, 3000);
      }
      return;
    }
    if (note && !card.classList.contains("is-linked")) { note.textContent = ""; note.classList.remove("is-error"); note.hidden = true; }
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

// Há resultado processado que ainda não foi salvo?
function temResultadoNaoSalvo() {
  return !!ultimoFechamentoFinanceiro?.data && !_entregaIdSalvo;
}

const btnFinLimpar = document.getElementById("btn-fin-limpar");
if (btnFinLimpar) {
  btnFinLimpar.addEventListener("click", () => {
    if (temResultadoNaoSalvo() &&
        !window.confirm("Há um fechamento processado que ainda não foi salvo. Limpar mesmo assim?")) {
      return;
    }

    const sales = document.getElementById("fin-sales");
    const costs = document.getElementById("fin-costs");
    const ordersAll = document.getElementById("fin-orders-all");
    [sales, costs, ordersAll].forEach((inp) => {
      if (!inp) return;
      inp.value = "";
      inp.dispatchEvent(new Event("change"));
      inp.closest(".vf-fin-upload")?.classList.remove("has-file", "is-dragging");
    });

    const finAds = document.getElementById("fin-ads");
    const finVenforce = document.getElementById("fin-venforce");
    const finAffiliates = document.getElementById("fin-affiliates");
    const finFullCost = document.getElementById("fin-full-cost");
    const finAdditionalCosts = document.getElementById("fin-additional-costs");
    if (finAds) finAds.value = "0";
    if (finVenforce) finVenforce.value = "0";
    if (finAffiliates) finAffiliates.value = "0";
    if (finFullCost) finFullCost.value = "0";
    if (finAdditionalCosts) finAdditionalCosts.value = "0";

    const marketplace = document.getElementById("fin-marketplace");
    if (marketplace) marketplace.value = "";
    const periodo = document.getElementById("fin-periodo");
    if (periodo) periodo.value = "";

    limparXlsBlob();
    limparFinStats();
    limparFinResumoExecutivo();
    limparShopeeReconciliacao();
    document.querySelector(".vf-fin-dashboard")?.removeAttribute("data-processed");
    resetEntregaTabs();

    const tabela = document.getElementById("fin-tabela");
    if (tabela) tabela.innerHTML = "";
    const leitura = document.getElementById("fin-leitura");
    if (leitura) { leitura.innerHTML = ""; leitura.hidden = true; }

    ultimoFechamentoFinanceiro = null;
    _entregaIdSalvo = null;
    _entregaPublicada = false;

    const btnSalvar = document.getElementById("btn-fin-salvar");
    if (btnSalvar) btnSalvar.hidden = true;

    showLinkClienteActions(false);
    setLinkClienteOutput("");
    setStatusLinkCliente("", "");
    setStatus("", "");

    // Reset de estado de base/chips
    baseVinculadaState.hasLink = false;
    baseVinculadaState.baseId = null;
    baseVinculadaState.baseNome = null;
    baseVinculadaState.clienteSlug = "";
    baseVinculadaState.marketplace = "";
    updateOrdersAllVisibility();
    updateMeliExtraCostsVisibility();
    aplicarEstadoBase();
    setChipProcessamento("não iniciado", null);
    setChipSalvo("", null);
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

["fin-sales", "fin-costs", "fin-orders-all"].forEach((id) => {
  const input = document.getElementById(id);
  if (input) input.addEventListener("change", () => updateFileCard(input));
});

// Botões "remover arquivo" (markup estático do file-item)
document.querySelectorAll(".vf-fin-file-remove").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const input = btn.closest(".vf-fin-upload")?.querySelector('input[type="file"]');
    if (!input) return;
    input.value = "";
    input.dispatchEvent(new Event("change"));
  });
});

// Bloco Order.all (Reconciliação Shopee) — visível só para Shopee.
const marketplaceSelect = document.getElementById("fin-marketplace");
const ordersAllBlock = document.getElementById("fin-orders-all-block");
function updateOrdersAllVisibility() {
  if (ordersAllBlock) ordersAllBlock.hidden = marketplaceSelect?.value !== "shopee";
}

// Bloco FULL / Custos adicionais — visível só para Mercado Livre.
const meliExtraCostsBlock = document.getElementById("fin-meli-extra-costs");
function updateMeliExtraCostsVisibility() {
  if (meliExtraCostsBlock) meliExtraCostsBlock.hidden = marketplaceSelect?.value !== "meli";
}

// Alteração de cliente/marketplace redetecta base vinculada e atualiza a UI.
function onClienteOuMarketplaceChange() {
  updateOrdersAllVisibility();
  updateMeliExtraCostsVisibility();
  detectarBaseVinculada();
}
if (marketplaceSelect) marketplaceSelect.addEventListener("change", onClienteOuMarketplaceChange);

const clienteSelectFinanceiro = document.getElementById("fin-cliente");
if (clienteSelectFinanceiro) {
  clienteSelectFinanceiro.addEventListener("change", () => {
    atualizarHintClienteFinanceiro();
    onClienteOuMarketplaceChange();
  });
}

// Botão salvar fechamento
const btnFinSalvar = document.getElementById("btn-fin-salvar");
if (btnFinSalvar) btnFinSalvar.addEventListener("click", salvarFechamentoFinanceiro);

// Ajustes financeiros e período atualizam o mini-resumo ao vivo.
["fin-ads", "fin-venforce", "fin-affiliates", "fin-full-cost", "fin-additional-costs", "fin-periodo"].forEach((id) => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", atualizarMiniResumo);
});

updateOrdersAllVisibility();
updateMeliExtraCostsVisibility();
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

// Troca entre abas (Dashboard / Entrega) — vf-tabs + aria
function _switchTab(tab) {
  const dash = document.getElementById("vft-dashboard");
  const ent  = document.getElementById("vft-entrega");
  const btnD = document.getElementById("vft-btn-dashboard");
  const btnE = document.getElementById("vft-btn-entrega");
  if (!dash || !ent || !btnD || !btnE) return;

  const toEntrega = tab === "entrega";
  // Antes de mostrar a aba de entrega, aplica o estado salvo
  if (toEntrega) _applyEntregaStateToDOM();

  dash.hidden = toEntrega;
  ent.hidden = !toEntrega;
  btnD.classList.toggle("is-active", !toEntrega);
  btnE.classList.toggle("is-active", toEntrega);
  btnD.setAttribute("aria-selected", String(!toEntrega));
  btnE.setAttribute("aria-selected", String(toEntrega));

  if (toEntrega) {
    document.getElementById("vft-root")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// Habilita a aba "Entrega para o cliente" após um processamento bem-sucedido.
// O markup das abas e do formulário é estático (financeiro.html) — aqui só
// alteramos o estado; nada de HTML/CSS injetado em runtime.
function initEntregaTabs() {
  const btnE = document.getElementById("vft-btn-entrega");
  if (btnE) { btnE.disabled = false; btnE.removeAttribute("aria-disabled"); }
}

// Reverte para o estado inicial (aba Entrega desabilitada, Dashboard ativo).
function resetEntregaTabs() {
  const btnE = document.getElementById("vft-btn-entrega");
  if (btnE) btnE.disabled = true;
  _switchTab("dashboard");
}

// Liga os controles das abas e do formulário de entrega (markup estático).
(function bindEntregaTabs() {
  document.getElementById("vft-btn-dashboard")?.addEventListener("click", () => _switchTab("dashboard"));
  document.getElementById("vft-btn-entrega")?.addEventListener("click", () => _switchTab("entrega"));

  document.getElementById("btn-vft-gerar")?.addEventListener("click", _gerarLinkComEntrega);

  document.getElementById("btn-vft-copiar")?.addEventListener("click", async () => {
    const url = document.getElementById("vft-link-output")?.value;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      _setEntStatus("Link copiado.", "ok");
    } catch { _setEntStatus("Copie manualmente o link acima.", "warn"); }
  });

  document.getElementById("btn-vft-abrir")?.addEventListener("click", () => {
    const url = document.getElementById("vft-link-output")?.value;
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  });

  // Auto-save ao digitar (mantém estado mesmo sem mudar de aba)
  document.getElementById("vft-entrega")?.querySelectorAll("input, textarea").forEach((el) => {
    el.addEventListener("input", () => _syncEntregaStateFromDOM());
  });
})();

function _setEntStatus(msg, type) {
  const el = document.getElementById("vft-ent-status");
  if (!el) return;
  el.classList.remove("is-success", "is-danger", "is-warning");
  if (!msg) { el.hidden = true; el.textContent = ""; return; }
  el.textContent = msg;
  el.hidden = false;
  if (type === "ok") el.classList.add("is-success");
  else if (type === "err") el.classList.add("is-danger");
  else el.classList.add("is-warning");
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
  setBtnLoading(btn, true);
  _setEntStatus("Gerando e publicando…", "warn");
  const linkRow = document.getElementById("vft-link-row");
  if (linkRow) linkRow.hidden = true;

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

    const entregaId = await criarOuAtualizarEntregaFechamento(payload, payload.periodo);
    const publicUrl = await publicarEntregaFechamento(entregaId);

    const outputEl = document.getElementById("vft-link-output");
    if (outputEl) outputEl.value = publicUrl;
    if (linkRow) linkRow.hidden = false;
    _setEntStatus("Link gerado com sucesso. Copie e envie ao cliente.", "ok");

  } catch (err) {
    _setEntStatus("Erro: " + (err?.message || "Falha ao gerar link."), "err");
  } finally {
    setBtnLoading(btn, false, "Gerar link para o cliente");
  }
}
