// frontend-react/src/utils/financeiro/comparacao.js
//
// COMPARAÇÃO entre duas revisões (v1 → v2) ou duas competências (Setembro ×
// Outubro). Diferenças OBJETIVAS entre números que o motor já calculou e o
// snapshot guardou — nenhuma fórmula financeira nova, nenhuma IA:
//
//   moeda / número → diferença absoluta e variação % sobre o anterior
//   fração (MC, TACoS) e pontos (cobertura) → diferença em p.p.
//   dado ausente em qualquer lado → "sem dado", nunca 0
//
// As frases ("Receita Bruta subiu 12,0%.") são montadas por regra fixa.

import { kpisPrincipais, numOuNull } from "./resumoFechamento.js";
import { formatarMoeda } from "../currency.js";
import { formatarPercentual, pontosParaFracao } from "../percentage.js";
import { formatarNumero } from "../numbers.js";

const tem = (s, k) => !!s && Object.prototype.hasOwnProperty.call(s, k);

// `sentido`: "maior" = subir é melhor; "menor" = cair é melhor; "neutro" =
// mudança sem juízo (ADS, CMV). `plural` acerta o verbo da frase.
const M = {
  grossRevenueTotal: { rotulo: "Receita Bruta", tipo: "moeda", sentido: "maior" },
  paidRevenueTotal: { rotulo: "Receita Líquida", tipo: "moeda", sentido: "maior" },
  contributionProfitTotal: { rotulo: "LC Total", tipo: "moeda", sentido: "maior" },
  mcCalculada: { rotulo: "MC Calculada", tipo: "fracao", sentido: "maior", feminino: true },
  finalResult: { rotulo: "Resultado Final", tipo: "moeda", sentido: "maior" },
  tacos: { rotulo: "TACoS", tipo: "fracao", sentido: "menor" },
  adsTotal: { rotulo: "ADS", tipo: "moeda", sentido: "neutro" },
  cmvTotal: { rotulo: "CMV", tipo: "moeda", sentido: "neutro" },
  cobertura: { rotulo: "Cobertura de custo", tipo: "pontos", sentido: "maior", ler: (s) => s.calculatedCoveragePercent, chaveSummary: "calculatedCoveragePercent" },
  revenueWithoutCost: { rotulo: "Receita sem custo", tipo: "moeda", sentido: "menor" },
  // Eventos do período: a chave do motor muda por marketplace.
  cancelamentos: { rotulo: "Cancelamentos", tipo: "moeda", sentido: "menor", plural: true, chaves: ["cancelledLostRevenue", "refundsTotal"] },
  devolucoes: { rotulo: "Devoluções / reembolsos", tipo: "moeda", sentido: "menor", plural: true, chaves: ["returnRefundRevenue"] },
  naoPagos: { rotulo: "Não pagos", tipo: "moeda", sentido: "menor", plural: true, chaves: ["unpaidLostRevenue"] },
  pendencias: { rotulo: "Pendências de custo", tipo: "numero", sentido: "menor", plural: true, contagem: "pendencias" },
};

export const METRICAS_REVISAO = ["finalResult", "mcCalculada", "cobertura", "revenueWithoutCost", "contributionProfitTotal", "pendencias"];
export const METRICAS_COMPETENCIA = [
  "grossRevenueTotal", "paidRevenueTotal", "contributionProfitTotal", "mcCalculada", "finalResult", "tacos", "adsTotal", "cmvTotal",
  "cobertura", "cancelamentos", "devolucoes", "naoPagos", "pendencias",
];

// { valor, existe } — `existe=false` quando o motor daquele marketplace nem
// devolve o campo (não vira linha); `valor=null` quando existe mas está vazio.
function ler(snapshot, chave) {
  const m = M[chave];
  const s = snapshot?.summary || {};
  if (m.contagem) {
    const c = snapshot?.contagens;
    return { existe: !!c && tem(c, m.contagem), valor: numOuNull(c?.[m.contagem]) };
  }
  if (chave === "mcCalculada") {
    const k = kpisPrincipais(s).find((i) => i.chave === "mcCalculada");
    return { existe: !!k && (tem(s, "contributionMarginCalculated") || tem(s, "averageContributionMargin")), valor: k?.valor ?? null };
  }
  if (m.chaves) {
    const k = m.chaves.find((c) => tem(s, c));
    return { existe: !!k, valor: k ? numOuNull(s[k]) : null };
  }
  const chaveSummary = m.chaveSummary || chave;
  return { existe: tem(s, chaveSummary), valor: numOuNull(m.ler ? m.ler(s) : s[chaveSummary]) };
}

const arred = (n, casas) => Math.round(n * 10 ** casas) / 10 ** casas;

// Uma linha da comparação. delta em R$/unidade (moeda/número) ou em p.p.
// (fração/pontos); variacao = Δ ÷ |anterior| (só moeda/número, anterior ≠ 0).
export function compararMetrica(chave, anterior, atual) {
  const m = M[chave];
  const a = ler(anterior, chave);
  const b = ler(atual, chave);
  if (!a.existe && !b.existe) return null;
  const de = a.valor;
  const para = b.valor;
  let delta = null;
  let variacao = null;
  let unidade = "";
  if (de !== null && para !== null) {
    if (m.tipo === "fracao") {
      delta = arred((para - de) * 100, 2);
      unidade = "p.p.";
    } else if (m.tipo === "pontos") {
      delta = arred(para - de, 2);
      unidade = "p.p.";
    } else {
      delta = arred(para - de, 2);
      variacao = de !== 0 ? (para - de) / Math.abs(de) : null;
    }
  }
  let tom = "sem_dado";
  if (delta !== null) {
    if (delta === 0) tom = "igual";
    else if (m.sentido === "neutro") tom = "neutro";
    else tom = (delta > 0) === (m.sentido === "maior") ? "melhora" : "piora";
  }
  return { chave, rotulo: m.rotulo, tipo: m.tipo, de, para, delta, variacao, unidade, tom };
}

export function compararSnapshots(anterior, atual, metricas = METRICAS_REVISAO) {
  return metricas.map((k) => compararMetrica(k, anterior, atual)).filter(Boolean);
}

// ── Formatação ───────────────────────────────────────────────────────────
export function formatarValorDaMetrica(valor, tipo) {
  const n = numOuNull(valor);
  if (n === null) return "—";
  if (tipo === "fracao") return formatarPercentual(n);
  if (tipo === "pontos") return formatarPercentual(pontosParaFracao(n));
  if (tipo === "numero") return formatarNumero(n);
  return formatarMoeda(n);
}

const pp = (d) => `${d > 0 ? "+" : d < 0 ? "−" : ""}${formatarNumero(Math.abs(d), 1)} p.p.`;

export function formatarDelta(linha) {
  if (!linha || linha.delta === null) return "sem dado";
  const d = linha.delta;
  if (linha.unidade === "p.p.") return pp(d);
  if (linha.tipo === "numero") return `${linha.de === null ? "—" : formatarNumero(linha.de)} → ${formatarNumero(linha.para)}`;
  const sinal = d > 0 ? "+" : d < 0 ? "−" : "";
  return `${sinal}${formatarMoeda(Math.abs(d))}`;
}

// Frases determinísticas, na ordem das métricas, só para o que mudou.
export function frasesDaComparacao(linhas, { maximo = 6 } = {}) {
  const frases = [];
  for (const l of linhas) {
    if (!l || l.delta === null || l.delta === 0) continue;
    const m = M[l.chave];
    const sobe = l.delta > 0;
    const verbo = m.plural ? (sobe ? "subiram" : "caíram") : (sobe ? "subiu" : "caiu");
    if (l.chave === "cobertura") {
      frases.push(`Cobertura ${sobe ? "melhorou" : "piorou"} de ${formatarValorDaMetrica(l.de, l.tipo)} para ${formatarValorDaMetrica(l.para, l.tipo)}.`);
    } else if (l.unidade === "p.p.") {
      frases.push(`${m.rotulo} ${verbo} ${formatarNumero(Math.abs(l.delta), 1)} p.p.`);
    } else if (l.tipo === "numero") {
      frases.push(`${m.rotulo}: ${formatarNumero(l.de)} → ${formatarNumero(l.para)}.`);
    } else if (m.plural || m.sentido === "neutro" || l.variacao === null) {
      frases.push(`${m.rotulo} ${verbo} ${formatarMoeda(Math.abs(l.delta))}.`);
    } else {
      frases.push(`${m.rotulo} ${verbo} ${formatarNumero(Math.abs(l.variacao) * 100, 1)}%.`);
    }
    if (frases.length >= maximo) break;
  }
  return frases;
}
