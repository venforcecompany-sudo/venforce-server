// server/services/resgate/resgateRecomendacao.js
//
// Simulação de preços e PREÇO RECOMENDADO do Resgate. Puro: a cotação em cada
// preço é injetada (`cotarEmPreco(preco)` → mesma saída de
// buscarComissaoEFrete), então comissão E frete são recotados em CADA preço
// candidato — nunca herdados do preço atual (faixa de R$ 79, tarifa por
// faixa, frete grátis obrigatório etc. mudam com o preço).
//
// Sem entrada essencial conhecida não há recomendação: devolve o motivo.

const core = require("../motorMargem/core");
const { montarContratoFinanceiro } = require("./resgateContrato");

const MAX_ITERACOES = 6;
const TOLERANCIA_CONVERGENCIA = 0.01;

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function arredondarParaCima(v) { return Math.ceil((v - 1e-9) * 100) / 100; }

/** Entrada do contrato com o preço vigente trocado por `preco` e a cotação recotada nele. */
function entradaEmPreco(entradaBase, preco, cotacao) {
  const e = JSON.parse(JSON.stringify(entradaBase || {}));
  e.precos = { ...(e.precos || {}), vigente: preco, promocional: null, fonte: "simulado" };
  // Simular um preço novo = preço base sem promoção: o subsídio da promoção atual não se transfere.
  e.promocao = { ativa: false, subsidioMl: null };
  e.comissao = {
    valor: cotacao ? cotacao.comissaoValor : null,
    percentual: cotacao ? cotacao.comissaoPercentual : null,
    precoBase: preco,
    fonte: "listing_prices (recotado no preço simulado)",
    observadoEm: cotacao && cotacao.observadoEm ? cotacao.observadoEm : new Date().toISOString(),
    motivo: cotacao && cotacao.diagnostico && cotacao.diagnostico.comissao ? cotacao.diagnostico.comissao.motivo : null,
  };
  e.frete = {
    valor: cotacao ? cotacao.fretePrevisto : null,
    freteQualidade: cotacao ? cotacao.freteQualidade || null : null,
    motivo: cotacao && cotacao.diagnostico && cotacao.diagnostico.frete ? cotacao.diagnostico.frete.motivo : null,
    observadoEm: cotacao && cotacao.observadoEm ? cotacao.observadoEm : new Date().toISOString(),
  };
  e.legadoNaoVerificado = false;
  return e;
}

/** Contrato em cada um dos preços pedidos (recotando em cada um). */
async function simularPrecos(entradaBase, precos, cotarEmPreco) {
  const saida = [];
  for (const p of precos) {
    const preco = num(p);
    if (preco === null || preco <= 0) { saida.push({ preco: p, erro: "PRECO_INVALIDO" }); continue; }
    let cot = null;
    try { cot = await cotarEmPreco(preco); } catch (_) { cot = null; }
    saida.push({ preco, contrato: montarContratoFinanceiro(entradaEmPreco(entradaBase, preco, cot)) });
  }
  return saida;
}

/**
 * Preço mínimo que atinge a meta, recotando comissão e frete a cada iteração.
 * @returns {{ ok, preco, contrato, iteracoes, motivo, trilha }}
 */
async function recomendarPreco(entradaBase, { meta, cotarEmPreco, limiteVariacao = null } = {}) {
  const alvo = num(meta);
  if (alvo === null || alvo < 0 || alvo >= 1) return { ok: false, motivo: "META_INVALIDA", trilha: [] };
  const custo = num(entradaBase && entradaBase.custo && entradaBase.custo.valor);
  const imposto = num(entradaBase && entradaBase.imposto && entradaBase.imposto.percentual);
  const taxa = num(entradaBase && entradaBase.taxaFixa && entradaBase.taxaFixa.valor);
  const ausentes = [custo === null && "custo", imposto === null && "imposto", taxa === null && "taxaFixa"].filter(Boolean);
  if (ausentes.length) return { ok: false, motivo: "ENTRADA_ESSENCIAL_DESCONHECIDA", ausentes, trilha: [] };

  const precoAtual = num(entradaBase.precos && entradaBase.precos.vigente);
  const trilha = [];
  let preco = precoAtual;
  let cot = null;
  if (preco === null || preco <= 0) return { ok: false, motivo: "PRECO_ATUAL_DESCONHECIDO", trilha };

  const vistos = [];
  for (let i = 0; i < MAX_ITERACOES; i++) {
    try { cot = await cotarEmPreco(preco); } catch (_) { cot = null; }
    const taxaComissao = cot ? num(cot.comissaoPercentual) : null;
    const frete = cot ? num(cot.fretePrevisto) : null;
    const freteAplica = !(entradaBase.anuncio && ["not_specified", "custom"].includes(entradaBase.anuncio.logisticType));
    trilha.push({ preco, comissaoPercentual: taxaComissao, frete, nivelFrete: cot && cot.freteQualidade ? cot.freteQualidade.nivel : null });
    if (taxaComissao === null) return { ok: false, motivo: "COMISSAO_DESCONHECIDA_NO_PRECO", trilha };
    if (freteAplica && frete === null) return { ok: false, motivo: "FRETE_DESCONHECIDO_NO_PRECO", trilha };
    // Comissão fixa por unidade (faixa < R$ 79) está DENTRO de sale_fee_amount: a parte
    // que não é percentual entra como custo fixo nesta iteração.
    const comissaoValor = num(cot.comissaoValor);
    const parteFixaComissao = comissaoValor !== null ? Math.max(0, comissaoValor - taxaComissao * preco) : 0;
    const alvoCalc = core.computeTargetPrice({
      cost: custo, fixedFee: taxa + parteFixaComissao, freight: freteAplica ? frete : 0,
      taxRate: imposto, commissionRate: taxaComissao, targetMargin: alvo,
    });
    if (!alvoCalc.computable) return { ok: false, motivo: alvoCalc.reason || "ALVO_NAO_CALCULAVEL", trilha };
    const novo = arredondarParaCima(alvoCalc.price);
    if (Math.abs(novo - preco) < TOLERANCIA_CONVERGENCIA) { preco = novo; break; }
    // Oscilação entre faixas (ex.: cruza R$ 79 e volta): fica com o MAIOR preço visto, conservador.
    if (vistos.some((v) => Math.abs(v - novo) < TOLERANCIA_CONVERGENCIA)) { preco = Math.max(novo, preco); break; }
    vistos.push(preco);
    preco = novo;
  }

  // Verificação final: contrato completo NO preço recomendado.
  let cotFinal = null;
  try { cotFinal = await cotarEmPreco(preco); } catch (_) { cotFinal = null; }
  const contrato = montarContratoFinanceiro(entradaEmPreco(entradaBase, preco, cotFinal));
  if (!contrato.resultado.calculavel) return { ok: false, motivo: "CONTRATO_NAO_CALCULAVEL_NO_PRECO", preco, contrato, trilha };
  // Se a recotação final ficou abaixo da meta (mudou de faixa), sobe 1 centavo por vez até 5 tentativas.
  let tentativas = 0;
  let final = { preco, contrato };
  while (final.contrato.resultado.margem < alvo - 1e-6 && tentativas < 5) {
    const p = arredondarParaCima(final.preco * 1.01);
    let c = null;
    try { c = await cotarEmPreco(p); } catch (_) { c = null; }
    final = { preco: p, contrato: montarContratoFinanceiro(entradaEmPreco(entradaBase, p, c)) };
    if (!final.contrato.resultado.calculavel) return { ok: false, motivo: "CONTRATO_NAO_CALCULAVEL_NO_PRECO", preco: p, contrato: final.contrato, trilha };
    tentativas++;
  }
  if (final.contrato.resultado.margem < alvo - 1e-6) return { ok: false, motivo: "NAO_CONVERGIU", preco: final.preco, contrato: final.contrato, trilha };

  const variacao = (final.preco - precoAtual) / precoAtual;
  return {
    ok: true,
    preco: final.preco,
    precoAtual,
    variacao: Math.round(variacao * 10000) / 10000,
    acimaDoLimite: limiteVariacao !== null && Math.abs(variacao) > limiteVariacao,
    contrato: final.contrato,
    iteracoes: trilha.length,
    trilha,
    motivo: null,
  };
}

module.exports = { simularPrecos, recomendarPreco, entradaEmPreco };
