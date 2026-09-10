// frontend-react/src/utils/fechamentoPayload.js
//
// Convergência #3 — monta o `payload_json` da entrega de fechamento a partir
// da resposta do processamento (POST /fechamentos/financeiro).
//
// NÃO é uma cópia do `montarPayloadFechamentoCliente` de Portal/financeiro.js
// (aquele tem ~250 linhas de cards/seções/tabelas para o relatório legado).
// O renderizador público (Portal/relatorio-publico.js `extractData`) reconstrói
// TUDO a partir de `summary` + `detailedRows` + `unmatchedIds` + `metadados` —
// não lê `cards`, `secoes` nem `resumoExecutivo`. Então o payload nativo é o
// mínimo que o público entende, mais `cards` (pedido explícito da missão §9,
// consumido só pelo preview interno do V3).
//
// `cliente.slug` é a IDENTIDADE CONGELADA: o backend
// (entregasClienteService.validarIdentidadeFechamento) recusa com 409
// IDENTIDADE_DIVERGENTE se ela não bater com o cliente sob o qual a entrega
// está sendo salva. Como no V3 os dois vêm do mesmo VF Context, batem sempre —
// a trava fica lá de guarda, não atrapalha.

import { ehAusente } from "./numbers.js";

// "3.011,00" / "3011.00" / "3011" / "" → número (ou null). O backend é a
// autoridade final (server/utils/numberUtils.parseMoneyValue); aqui é só para
// o preview e os metadados não guardarem a string crua.
export function parseMoedaBR(texto) {
  if (texto === null || texto === undefined) return null;
  const limpo = String(texto).trim();
  if (!limpo) return null;
  // vírgula decimal pt-BR: remove separador de milhar (.) e troca , por .
  const normalizado = /,/.test(limpo)
    ? limpo.replace(/\./g, "").replace(",", ".")
    : limpo;
  const n = Number(normalizado);
  return Number.isFinite(n) ? n : null;
}

function card(titulo, valor, subtitulo) {
  const disponivel = !ehAusente(valor);
  return { titulo, valor: disponivel ? Number(valor) : null, subtitulo, disponivel };
}

// summary da resposta do processamento → cards de leitura rápida. Campo
// ausente no summary vira card com `disponivel:false` (nunca R$0 — Master
// Spec M6), exatamente como o ResultadoTab já trata.
export function cardsDoSummary(summary = {}) {
  const s = summary || {};
  const mc = s.averageContributionMargin;
  const cobertura = s.calculatedCoveragePercent;
  return [
    card("Resultado Final", s.finalResult, "LC Total menos ADS, Venforce e afiliados."),
    card("Receita Bruta Total", s.grossRevenueTotal, "Total vendido no período, com e sem custo cadastrado."),
    card("Receita Líquida", s.paidRevenueTotal, "Receita após taxas/reembolsos conforme planilhas."),
    card("Receita com custo", s.revenueWithCost, "Base efetiva do cálculo de lucro e margem."),
    card("Receita sem custo", s.revenueWithoutCost, "Faturamento preservado, fora do cálculo de lucro."),
    card("Cobertura da base (%)", cobertura, "Percentual da receita com custo identificado."),
    card("LC Total", s.contributionProfitTotal, "Lucro de contribuição antes de ADS, Venforce e afiliados."),
    card("MC Calculada (%)", ehAusente(mc) ? null : Number(mc) * 100, "LC Total sobre a receita com custo."),
    card("TACoS (%)", ehAusente(s.tacos) ? null : Number(s.tacos) * 100, "ADS como % do faturamento total."),
    card("TACoX (%)", ehAusente(s.tacox) ? null : Number(s.tacox) * 100, "ADS + Venforce + afiliados como % do faturamento."),
  ];
}

export function montarPayloadFechamento({
  processamento,
  clienteSlug,
  clienteNome,
  periodo,
  marketplace,
  ajustes = {},
}) {
  const summary = processamento?.summary || {};
  const detailedRows = Array.isArray(processamento?.detailedRows)
    ? processamento.detailedRows.slice(0, 50)
    : [];
  const unmatchedIds = Array.isArray(processamento?.unmatchedIds) ? processamento.unmatchedIds : [];

  const geradoEm = new Date().toISOString();

  return {
    versao: 1,
    tipo: "fechamento_mensal",
    titulo: "Fechamento Financeiro",
    periodo: periodo || "",
    marketplace: marketplace || summary.marketplace || null,
    // identidade congelada — ver cabeçalho
    cliente: clienteSlug ? { slug: clienteSlug, nome: clienteNome || null } : {},
    // o que o relatório público reconstrói:
    summary,
    summaryNormalized: summary,
    detailedRows,
    unmatchedIds,
    // pedido da missão §9 — só o preview interno do V3 usa:
    cards: cardsDoSummary(summary),
    // competência DECLARADA pelo backend (periodoDetectado / divergente / motivo)
    competencia: processamento?.competencia || null,
    metadados: {
      geradoEm,
      origem: "financeiro-v3-nativo",
      marketplace: marketplace || null,
      ads: parseMoedaBR(ajustes.ads),
      venforce: parseMoedaBR(ajustes.venforce),
      affiliates: parseMoedaBR(ajustes.affiliates),
      fullCost: parseMoedaBR(ajustes.fullCost),
      additionalCosts: parseMoedaBR(ajustes.additionalCosts),
      // Origem dos custos DECLARADA pelo backend: "base" (base vinculada) ou
      // "upload" (planilha enviada). Fica no metadado para o diagnóstico
      // (Caixa-preta / incidente) saber de onde vieram os custos sem ter que
      // reprocessar.
      costsSource: processamento?.costsSource || null,
      costsBase: processamento?.costsSource === "base" && processamento?.costsBase
        ? {
            id: processamento.costsBase.id ?? null,
            slug: processamento.costsBase.slug ?? null,
            nome: processamento.costsBase.nome ?? null,
          }
        : null,
    },
  };
}
