// frontend-react/src/components/inicio/formato.js
// Formatação e pequenas contas da tela de Início (porte do Início do
// Lucratto 360). Ausente vira "—", nunca zero inventado (utils/numbers.js).

import { formatarMoeda } from "../../utils/currency.js";
import { AUSENTE, ehAusente } from "../../utils/numbers.js";

export const reais = (n) => formatarMoeda(n);

export const pct = (n, casas = 1) =>
  ehAusente(n) ? AUSENTE : `${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;

export const num = (n) => (ehAusente(n) ? AUSENTE : Number(n).toLocaleString("pt-BR"));

export const noPlural = (n, um, varios) => (n === 1 ? um : varios);

// "27/10" ou, com ano diferente do de referência, "27/10/25".
export function diaCurto(dia, anoRef) {
  const [a, m, d] = dia.split("-");
  return anoRef && a !== anoRef ? `${d}/${m}/${a.slice(2)}` : `${d}/${m}`;
}

export const diaCompleto = (dia) => dia.split("-").reverse().join("/");

export function horario(iso) {
  if (!iso) return AUSENTE;
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

// Quanto mudou em %, sobre o módulo do valor anterior; sem base, sem variação.
export const variacaoPct = (atual, antes) => (ehAusente(atual) || ehAusente(antes) || antes === 0 ? null : ((atual - antes) / Math.abs(antes)) * 100);

// Contra o que a variação é calculada.
export const rotuloComparacao = (anterior) => (anterior.periodo.de === anterior.periodo.ate ? "ontem" : "período anterior");

// Variações dos cartões; só quando o período anterior tem de onde comparar.
export function variacoes(t, a) {
  const vazio = { faturamento: null, lucro: null, margem: null, ticket: null };
  if (!a) return vazio;
  const contra = rotuloComparacao(a);
  const fat = a.vendas > 0 ? variacaoPct(t.faturamento, a.faturamento) : null;
  const lucro = a.vendasCalculadas > 0 && t.vendasCalculadas > 0 ? variacaoPct(t.lucro, a.lucro) : null;
  const ticket = a.vendas > 0 && t.vendas > 0 ? variacaoPct(t.ticket, a.ticket) : null;
  return {
    faturamento: fat === null ? null : { delta: fat, unidade: "%", antes: reais(a.faturamento), contra },
    lucro: lucro === null ? null : { delta: lucro, unidade: "%", antes: reais(a.lucro), contra },
    margem: !ehAusente(t.margemPct) && !ehAusente(a.margemPct) ? { delta: t.margemPct - a.margemPct, unidade: "p.p.", antes: pct(a.margemPct), contra } : null,
    ticket: ticket === null ? null : { delta: ticket, unidade: "%", antes: reais(a.ticket), contra },
  };
}

// Eixo "redondo" que sempre inclui o zero (barras de dinheiro partem da base).
export function escalaRedonda(minimo, maximo, quantos = 4) {
  const min = Math.min(0, minimo);
  const max = Math.max(0, maximo);
  if (min === 0 && max === 0) return { min: 0, max: 1, ticks: [0, 1] };
  const bruto = (max - min) / quantos;
  const grandeza = 10 ** Math.floor(Math.log10(bruto));
  const passo = [1, 2, 2.5, 5, 10].map((f) => f * grandeza).find((p) => p >= bruto);
  const de = Math.floor(min / passo + 1e-9) * passo;
  const ate = Math.ceil(max / passo - 1e-9) * passo;
  const ticks = [];
  for (let t = de; t <= ate + passo / 2; t += passo) ticks.push(Math.round(t * 1e6) / 1e6);
  return { min: de, max: ate, ticks };
}

const numeroCurto = (n) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

// "R$ 850", "R$ 1,5 mil", "R$ 2 mi": rótulo de eixo, curto.
export function reaisCompacto(n) {
  const sinal = n < 0 ? "−" : "";
  const v = Math.abs(n);
  if (v >= 1_000_000) return `${sinal}R$ ${numeroCurto(v / 1_000_000)} mi`;
  if (v >= 1_000) return `${sinal}R$ ${numeroCurto(v / 1_000)} mil`;
  return `${sinal}R$ ${numeroCurto(v)}`;
}
