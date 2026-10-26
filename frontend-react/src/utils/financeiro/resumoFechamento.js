// frontend-react/src/utils/financeiro/resumoFechamento.js
//
// Leitura do `summary` devolvido por POST /fechamentos/financeiro para a
// tela de resultado. REGRA: nada aqui calcula número financeiro. LC, MC,
// Resultado Final, TACoS, TACoX, coberturas e totais vêm do motor
// (server/services/fechamentoFinanceiro/*). Este módulo só escolhe QUAL campo
// mostrar, com que rótulo e unidade, e escreve frases determinísticas sobre
// eles.
//
// Honestidade de ausência:
//   null / undefined / "" / NaN → null → "—"
//   0                          → 0    → "R$ 0,00" / "0,0%"
// Campo que o motor do marketplace NÃO devolve (chave ausente) não vira
// linha — mostrar "—" para algo que não se aplica confundiria com "faltou".

export function numOuNull(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = typeof valor === "number" ? valor : Number(valor);
  return Number.isFinite(n) ? n : null;
}

function tem(summary, chave) {
  return !!summary && Object.prototype.hasOwnProperty.call(summary, chave);
}

// Item de exibição: { chave, rotulo, valor, tipo, descricao }. `tipo`:
//   moeda  → R$          fracao → 0,041 = 4,1%
//   pontos → 98,4 = 98,4% (coberturas do backend já vêm em pontos)
//   numero → contagem
function item(summary, chave, rotulo, tipo, descricao, { sempre = false, valor } = {}) {
  if (!sempre && !tem(summary, chave)) return null;
  return { chave, rotulo, valor: numOuNull(valor !== undefined ? valor : summary?.[chave]), tipo, descricao };
}

const limpar = (lista) => lista.filter(Boolean);

export const MODO_LABEL = {
  real_meli_vendas: "Financeiro real · relatório de vendas ML",
  real_financial: "Financeiro real · Order.all",
  estimated_performance: "Estimativa por performance",
  real_tiktok_income: "Financeiro real · TikTok Shop",
};

export const CONFIANCA_LABEL = {
  confiavel: "Confiável",
  parcial: "Parcial",
  insuficiente: "Insuficiente",
};

export function rotuloModo(summary) {
  const modo = String(summary?.calculationMode || "");
  return MODO_LABEL[modo] || null;
}

// MC Calculada: `contributionMarginCalculated` (safeRatio, null quando não há
// base) é o campo honesto; `averageContributionMargin` é o legado (pode ser 0
// sem base). Usa o honesto quando o motor o devolve.
function mcCalculada(summary) {
  return tem(summary, "contributionMarginCalculated") ? summary.contributionMarginCalculated : summary?.averageContributionMargin;
}

export function kpisPrincipais(summary = {}) {
  const s = summary || {};
  return limpar([
    item(s, "finalResult", "Resultado Final", "moeda", "Resultado após despesas comerciais (LC menos ADS, Venforce, afiliados e demais custos do período).", { sempre: true }),
    item(s, "grossRevenueTotal", "Receita Bruta Total", "moeda", "Total vendido no período, com e sem custo cadastrado.", { sempre: true }),
    item(s, "paidRevenueTotal", "Receita Líquida", "moeda", "Receita após taxas/reembolsos conforme as planilhas.", { sempre: true }),
    item(s, "contributionProfitTotal", "LC Total", "moeda", "Lucro de contribuição calculado pelo motor, antes das despesas comerciais.", { sempre: true }),
    { chave: "mcCalculada", rotulo: "MC Calculada", valor: numOuNull(mcCalculada(s)), tipo: "fracao", descricao: "LC Total sobre a receita calculável." },
    item(s, "finalMarginCalculated", "MC Final", "fracao", "Resultado Final sobre a receita calculável."),
    item(s, "tacos", "TACoS", "fracao", "ADS sobre o faturamento total."),
    item(s, "tacox", "TACoX", "fracao", "ADS + Venforce + afiliados sobre o faturamento total."),
  ]);
}

// LC → Resultado Final. As despesas são as que o backend devolveu como total
// do período (adsTotal, venforceTotal...). O Resultado Final é o
// `finalResult` do motor — NÃO é somado aqui. A composição foi confirmada
// no código dos motores: MELI = LC − ADS − Venforce − Afiliados − FULL −
// adicionais; Shopee = LC − ADS − Venforce − Afiliados.
export function composicaoResultado(summary = {}) {
  const s = summary || {};
  const despesas = limpar([
    item(s, "adsTotal", "ADS", "moeda"),
    item(s, "venforceTotal", "Venforce", "moeda"),
    item(s, "affiliatesTotal", "Afiliados", "moeda"),
    item(s, "fullCostTotal", "FULL", "moeda"),
    item(s, "additionalCostsTotal", "Custos adicionais", "moeda"),
  ]);
  return {
    lc: item(s, "contributionProfitTotal", "LC Total", "moeda", null, { sempre: true }),
    despesas,
    resultado: item(s, "finalResult", "Resultado após despesas comerciais", "moeda", null, { sempre: true }),
  };
}

// Os quatro cartões do detalhamento executivo, com as linhas do legado
// (Portal/financeiro.html, .vf-fin-exec-grid): Receitas (com o financeiro
// publicado e a cobertura da base), Deduções, Custos/Investimentos e Resultado
// (com o status do fechamento). Linha cujo campo o motor não devolve não
// aparece — o legado mostrava "100%" fixo para "Financeiro publicado" até no
// Shopee, que nem tem esse eixo.
export function blocosExecutivos(summary = {}, marketplace = "") {
  const s = summary || {};
  const shopee = marketplace === "shopee";
  const aguardando = numOuNull(s.revenuePendingFinancial);
  return [
    {
      id: "receitas",
      titulo: "Receitas",
      itens: limpar([
        item(s, "grossRevenueTotal", "Receita Bruta Total", "moeda"),
        item(s, "paidRevenueTotal", "Receita Líquida", "moeda"),
        item(s, "financialDataCoveragePercent", "Financeiro publicado", "pontos"),
        aguardando !== null && aguardando > 0 ? item(s, "revenuePendingFinancial", "Aguardando financeiro", "moeda") : null,
        item(s, "revenueWithCost", "Receita com custo", "moeda"),
        item(s, "revenueWithoutCost", "Receita sem custo", "moeda"),
        item(s, "calculatedCoveragePercent", "Cobertura da base", "pontos"),
      ]),
    },
    {
      id: "deducoes",
      titulo: "Deduções",
      itens: limpar(
        shopee
          ? [
              item(s, "cancellationsTotal", "Cancelamentos confirmados", "moeda"),
              item(s, "returnsTotal", "Devoluções / reembolsos", "moeda"),
              item(s, "marketplaceFeesTotal", "Taxas do marketplace", "moeda"),
              item(s, "shippingFeesTotal", "Frete", "moeda"),
              item(s, "taxValueTotal", "Imposto", "moeda"),
              item(s, "cmvTotal", "CMV", "moeda"),
            ]
          : [
              item(s, "refundsTotal", "Cancelamentos e reembolsos", "moeda"),
              item(s, "refundsCount", "Pedidos cancelados", "numero"),
              item(s, "lostRevenueTotal", "Faturamento perdido", "moeda"),
              item(s, "platformAdjustmentTotal", "Ajuste de plataforma", "moeda"),
              item(s, "excludedStatusRevenue", "Fora do LC por status", "moeda"),
            ]
      ),
    },
    {
      id: "investimentos",
      titulo: "Custos / Investimentos",
      itens: composicaoResultado(s).despesas,
    },
    {
      id: "resultado",
      titulo: "Resultado",
      itens: limpar([
        item(s, "contributionProfitTotal", "LC Total", "moeda"),
        { chave: "mcCalculada", rotulo: "MC Calculada", valor: numOuNull(mcCalculada(s)), tipo: "fracao" },
        item(s, "finalResult", "Resultado Final", "moeda"),
        item(s, "finalMarginCalculated", "MC Final", "fracao"),
        item(s, "tacos", "TACoS", "fracao"),
        item(s, "tacox", "TACoX", "fracao"),
      ]),
      // "Status do fechamento" do legado: modo de cálculo · confiança.
      status: [rotuloModo(s), CONFIANCA_LABEL[s.financialConfidence] || null].filter(Boolean).join(" · ") || null,
      confianca: s.financialConfidence || null,
    },
  ].filter((b) => b.itens.length || b.status);
}

// Dois eixos INDEPENDENTES. Financeiro pendente não é "sem custo": uma venda
// pode ter custo cadastrado e ainda não ter tarifas/repasse publicados.
export function coberturas(summary = {}, { unmatchedIds = [], unmatchedCosts = [] } = {}) {
  const s = summary || {};
  const ambiguos = Array.isArray(s.ambiguousCostIds)
    ? s.ambiguousCostIds.length
    : tem(s, "bridgeAmbiguousCount")
      ? numOuNull(s.bridgeAmbiguousCount)
      : null;
  const semCusto = Array.isArray(unmatchedCosts) && unmatchedCosts.length
    ? unmatchedCosts.filter((g) => g?.reason !== "ambiguous_bridge_candidates").length
    : Array.isArray(unmatchedIds) ? unmatchedIds.length : null;

  const temEixoFinanceiro = ["revenueWithFinancialData", "revenuePendingFinancial", "financialDataCoveragePercent"].some((k) => tem(s, k));

  return {
    custo: {
      receitaComCusto: numOuNull(s.revenueWithCost),
      receitaSemCusto: numOuNull(s.revenueWithoutCost),
      percentual: numOuNull(s.calculatedCoveragePercent),
      produtosSemCusto: semCusto,
      custosAmbiguos: ambiguos,
    },
    financeiro: temEixoFinanceiro
      ? {
          aplicavel: true,
          receitaComFinanceiro: numOuNull(s.revenueWithFinancialData),
          receitaAguardando: numOuNull(s.revenuePendingFinancial),
          percentual: numOuNull(s.financialDataCoveragePercent),
          vendasAguardando: numOuNull(s.salesPendingFinancialCount),
        }
      : { aplicavel: false },
  };
}

const brl = (n) =>
  `${n < 0 ? "−" : ""}R$ ${Math.abs(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (pontos) => `${Number(pontos).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
// " (R$ x)" só quando o valor existe — ausência nunca vira "R$ 0,00".
const entreParenteses = (v) => {
  const n = numOuNull(v);
  return n === null ? "" : ` (${brl(n)})`;
};
const qtd = (n, um, varios) => `${Number(n).toLocaleString("pt-BR")} ${n === 1 ? um : varios}`;

// Frases DETERMINÍSTICAS sobre números que o backend já devolveu. Explica por
// que o fechamento é parcial — não interpreta nem recomenda nada novo.
export function leituraDoFechamento({ summary = {}, marketplace = "", unmatchedIds = [], unmatchedCosts = [], competencia = null } = {}) {
  const s = summary || {};
  const frases = [];
  const modo = rotuloModo(s);
  // `redundante`: a tela já diz isto no cabeçalho/KPIs — a frase continua
  // disponível para quem a consome, mas a Leitura não a repete.
  if (modo) frases.push({ tom: "neutral", texto: `Fechamento em modo ${modo}.`, redundante: true });

  const final = numOuNull(s.finalResult);
  if (final !== null) {
    frases.push({
      tom: final > 0 ? "success" : final < 0 ? "danger" : "neutral",
      texto: final > 0 ? `Resultado Final positivo: ${brl(final)}.` : final < 0 ? `Resultado Final negativo: ${brl(final)}.` : "Resultado Final zerado (R$ 0,00).",
      redundante: true,
    });
  }

  const cob = coberturas(s, { unmatchedIds, unmatchedCosts });
  if (cob.custo.percentual !== null) {
    const parcial = cob.custo.percentual < 99.995;
    frases.push({
      tom: parcial ? "warning" : "success",
      texto: parcial
        ? `Cobertura da base de custos em ${pct(cob.custo.percentual)}: LC e MC representam só a parcela com custo identificado.`
        : `Cobertura da base de custos em ${pct(cob.custo.percentual)}.`,
    });
  }
  if (cob.custo.receitaSemCusto !== null && cob.custo.receitaSemCusto > 0) {
    frases.push({ tom: "warning", texto: `${brl(cob.custo.receitaSemCusto)} da receita estão sem custo — continuam no faturamento, fora do LC/MC.` });
  }
  if (cob.custo.produtosSemCusto) {
    frases.push({ tom: "warning", texto: `${qtd(cob.custo.produtosSemCusto, "produto sem custo identificado", "produtos sem custo identificado")}.` });
  }
  if (cob.custo.custosAmbiguos) {
    frases.push({ tom: "warning", texto: `${qtd(cob.custo.custosAmbiguos, "custo ambíguo", "custos ambíguos")} na base — o sistema não escolhe entre candidatos.` });
  }

  if (cob.financeiro.aplicavel && cob.financeiro.receitaAguardando !== null && cob.financeiro.receitaAguardando > 0) {
    const n = cob.financeiro.vendasAguardando;
    frases.push({
      tom: "warning",
      texto: `${n ? `${qtd(n, "venda", "vendas")} (${brl(cob.financeiro.receitaAguardando)})` : brl(cob.financeiro.receitaAguardando)} aguardando financeiro do marketplace — LC, MC e Resultado Final consideram só as vendas com financeiro completo.`,
    });
  }

  if (marketplace === "shopee") {
    const canc = numOuNull(s.cancelledCount);
    if (canc) frases.push({ tom: "warning", texto: `${qtd(canc, "pedido cancelado confirmado", "pedidos cancelados confirmados")}${entreParenteses(s.cancelledLostRevenue)}.` });
    const devol = numOuNull(s.returnRefundCount);
    if (devol) frases.push({ tom: "warning", texto: `${qtd(devol, "devolução/reembolso", "devoluções/reembolsos")}${entreParenteses(s.returnRefundRevenue)}.` });
    const naoPagos = numOuNull(s.unpaidCount);
    if (naoPagos) frases.push({ tom: "neutral", texto: `${qtd(naoPagos, "pedido não pago", "pedidos não pagos")} — não viraram venda e não afetam o resultado.` });
  } else {
    const reemb = numOuNull(s.refundsCount);
    if (reemb) frases.push({ tom: "warning", texto: `${qtd(reemb, "cancelamento/reembolso", "cancelamentos/reembolsos")}${entreParenteses(s.refundsTotal)}.` });
    const perdido = numOuNull(s.lostRevenueTotal);
    if (perdido) frases.push({ tom: "warning", texto: `Faturamento perdido informado pelo motor: ${brl(perdido)}.` });
    const fora = numOuNull(s.excludedStatusCount);
    if (fora) frases.push({ tom: "neutral", texto: `${qtd(fora, "item ficou", "itens ficaram")} fora do LC por status (cancelado/devolvido/mediação).` });
  }

  if (competencia?.divergente) {
    frases.push({ tom: "danger", texto: "A competência dos dados enviados não bate com a competência do fechamento." });
  }
  return frases;
}

// Métricas que só existem num marketplace. Shopee nunca aparece no MELI e
// vice-versa; contagem 0 real aparece como 0.
export function metricasSecundarias(summary = {}, marketplace = "") {
  const s = summary || {};
  if (marketplace === "shopee") {
    return limpar([
      item(s, "cancelledCount", "Pedidos cancelados", "numero"),
      item(s, "cancelledLostRevenue", "Faturamento perdido (cancelados)", "moeda"),
      item(s, "unpaidCount", "Pedidos não pagos", "numero"),
      item(s, "unpaidLostRevenue", "Faturamento não pago", "moeda"),
      item(s, "returnRefundCount", "Devoluções / reembolsos", "numero"),
      item(s, "returnRefundRevenue", "Valor de devoluções / reembolsos", "moeda"),
    ]);
  }
  // Cancelamentos (qtd. e valor) e faturamento perdido já estão no cartão
  // Deduções da composição — aqui só o que ele não mostra.
  return limpar([
    item(s, "excludedStatusCount", "Itens fora do LC por status", "numero"),
    item(s, "platformAdjustmentRowsCount", "Linhas com ajuste de plataforma", "numero"),
    item(s, "salesPendingFinancialCount", "Vendas aguardando financeiro", "numero"),
  ]);
}

// Reconciliação Shopee (Order.all). Sem Order.all no processamento, o motor
// devolve contagens 0 — e "0 pedidos" ali seria mentira: o arquivo não veio.
export function reconciliacaoShopee(summary = {}) {
  const s = summary || {};
  const total = numOuNull(s.orderAllTotalCount);
  if (!total) return { disponivel: false };
  const estados = [
    // Rótulos, textos de apoio e cores os MESMOS do legado.
    ["Concluídos", "Dinheiro consolidado", "orderAllCompletedCount", "orderAllCompletedRevenue", "success"],
    ["Entregues", "Dinheiro próximo de consolidar", "orderAllDeliveredCount", "orderAllDeliveredRevenue", "success"],
    ["Enviados", "Em trânsito", "orderAllShippedCount", "orderAllShippedRevenue", "warning"],
    ["Em atenção", "Aguardando devolução, a enviar ou status intermediário", "orderAllIntermediateCount", "orderAllIntermediateRevenue", "warning"],
    ["Cancelados confirmados", "Perda confirmada", "orderAllCancelledConfirmedCount", "orderAllCancelledConfirmedRevenue", "danger"],
    ["Não pagos", "Pedidos que não viraram venda", "orderAllUnpaidCount", "orderAllUnpaidRevenue", "warning"],
    ["Devoluções / Reembolsos", "Impacto separado dos cancelados", "orderAllReturnRefundCount", "orderAllReturnRefundRevenue", "danger"],
  ].map(([rotulo, apoio, kc, kr, tom]) => ({ rotulo, apoio, pedidos: numOuNull(s[kc]), receita: numOuNull(s[kr]), tom }));

  return {
    disponivel: true,
    // Mesmo campo do legado (grossRevenueTotal, senão paidRevenueTotal).
    performance: numOuNull(s.grossRevenueTotal) ?? numOuNull(s.paidRevenueTotal),
    reconciliada: numOuNull(s.orderAllTotalRevenue),
    pedidos: total,
    estados,
    maioresCancelamentos: Array.isArray(s.orderAllTopCancelledItems)
      ? s.orderAllTopCancelledItems.filter((i) => i && i.productName)
      : [],
  };
}
