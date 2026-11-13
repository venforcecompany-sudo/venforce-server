// server/services/resgate/resgateSimulacaoPreliminar.js
//
// Simulação PRELIMINAR (sem nenhuma chamada ao Mercado Livre) e preparação de
// PROPOSTAS EM LOTE do Resgate. Puro.
//
// NÃO é um motor novo: o resultado em cada preço sai do MESMO núcleo do
// Resgate — simularPrecos() → entradaEmPreco() → montarContratoFinanceiro().
// A única diferença para a simulação real (/simular) é a cotação injetada:
// aqui ela REPETE a comissão (mesmo % e mesma parte fixa) e o frete AUDITADOS
// do preço atual, em vez de recotar no ML. Por isso todo resultado sai com
// tipo "PRELIMINAR" e nunca é apresentado como validado; o preço só vira
// "RECOTADO" pela recotação real (POST /simular sem `preliminar`).

const { simularPrecos } = require("./resgateRecomendacao");
const { montarBancada, metaDe } = require("./resgateBancada");

const VERSAO = "resgate-preliminar/1";
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const valor = (c) => (c && c.status !== "desconhecido" ? num(c.valor) : null);

/** Entrada do contrato reconstruída a partir do contrato AUDITADO do item (mesmos custos, preço e logística). */
function entradaDoContratoAuditado(item) {
  const c = item && item.contrato; if (!c || !c.componentes) return null;
  const k = c.componentes;
  return {
    conta: c.conta || {},
    anuncio: { ...(c.anuncio || {}) },
    precos: { cheio: valor(k.precoCheio), vigente: valor(k.precoVigente), promocional: valor(k.precoPromocional), fonte: (k.precoVigente && k.precoVigente.fonte) || null, observadoEm: k.precoVigente && k.precoVigente.observadoEm },
    promocao: { ativa: false },
    comissao: { valor: valor(k.comissao), percentual: num(k.comissao && k.comissao.percentual), precoBase: num(k.comissao && k.comissao.precoBase), fonte: k.comissao && k.comissao.fonte },
    frete: { valor: valor(k.frete), freteQualidade: k.frete && k.frete.nivel ? { nivel: k.frete.nivel, confianca: k.frete.confianca, fonte: k.frete.fonte, modalidade: k.frete.modalidade || null, cotacaoRejeitada: k.frete.cotacaoRejeitada ?? null } : null },
    custo: { valor: valor(k.custo), fonte: k.custo && k.custo.fonte },
    imposto: { percentual: valor(k.imposto), fonte: k.imposto && k.imposto.fonte },
    taxaFixa: { valor: valor(k.taxaFixa), fonte: k.taxaFixa && k.taxaFixa.fonte },
  };
}

/** Cotação "mantida": o mesmo % e a mesma parte fixa de comissão e o mesmo frete do preço auditado. */
function cotacaoMantida(entrada) {
  const pct = num(entrada.comissao.percentual), com = num(entrada.comissao.valor), base = num(entrada.comissao.precoBase) ?? num(entrada.precos.vigente);
  const fixa = pct !== null && com !== null && base !== null ? Math.max(0, com - pct * base) : 0;
  return async (preco) => ({
    comissaoValor: pct === null ? null : r2(fixa + pct * preco), comissaoPercentual: pct,
    fretePrevisto: entrada.frete.valor, freteQualidade: entrada.frete.freteQualidade, observadoEm: null,
  });
}

/** Simula os preços pedidos SEM ML. Cada resultado vem marcado PRELIMINAR, com o porquê. */
async function simularPreliminar(item, precos) {
  const entrada = entradaDoContratoAuditado(item);
  if (!entrada) return { ok: false, motivo: "Anúncio sem contrato auditado." };
  const atual = num(entrada.precos.vigente);
  const sims = await simularPrecos(entrada, (precos || []).map(Number).filter((p) => p > 0).slice(0, 8), cotacaoMantida(entrada));
  return {
    ok: true, versao: VERSAO, tipo: "PRELIMINAR",
    simulacoes: sims.map((s) => {
      const k = s.contrato ? s.contrato.componentes : {};
      const avisos = ["Comissão e frete mantidos como no preço atual: o sistema confirma no Mercado Livre antes de qualquer alteração."];
      if (atual !== null && (atual < 79) !== (s.preco < 79)) avisos.push("O preço cruza a faixa de R$ 79, onde o frete costuma mudar: recotar no Mercado Livre.");
      return { preco: s.preco, tipo: "PRELIMINAR", erro: s.erro || null, resultado: s.contrato ? s.contrato.resultado : null, comissao: k.comissao || null, frete: k.frete || null, imposto: k.imposto || null, custo: k.custo || null, taxaFixa: k.taxaFixa || null, bloqueios: s.contrato ? s.contrato.bloqueios : [], avisos };
    }),
  };
}

// ── Propostas em lote ─────────────────────────────────────────────────────
const ESTRATEGIAS = {
  SAIR_CAMPANHA: "Sair da campanha própria e ajustar o preço cheio",
  AJUSTAR_PROMOCIONAL: "Ajustar o preço promocional da campanha própria",
  ALTERAR_CHEIO: "Alterar o preço cheio (sem promoção)",
};
const EXCECAO = {
  BLOQUEADO: "BLOQUEADO", MARGEM_INCERTA: "MARGEM_INCERTA", PRECO_MUDOU: "PRECO_MUDOU", NA_META: "NA_META",
  NAO_SE_APLICA: "NAO_SE_APLICA", SEM_PRECO: "SEM_PRECO", ACIMA_DO_TETO: "ACIMA_DO_TETO",
};
const fim90 = (p) => { const x = Math.floor(p) + 0.9; return r2(x + 1e-6 >= p ? x : x + 1); };

/**
 * @param {Array} itens itens auditados (com promocaoFinanciamento/recotacao enriquecidos)
 * @param {object} o { estrategia, meta (0.15 ou 15), tetoAumento (0.30 ou 30), terminarEm90 }
 * @returns {{ prontos, excecoes, resumo }} — nada é aplicado; são PROPOSTAS para revisão.
 */
async function propostasEmLote(itens, { estrategia, meta, tetoAumento = 0.3, terminarEm90 = false } = {}) {
  const m = metaDe(meta), teto = num(tetoAumento) > 1 ? num(tetoAumento) / 100 : num(tetoAumento);
  if (!ESTRATEGIAS[estrategia]) return { ok: false, motivo: "Estratégia inválida." };
  const prontos = [], excecoes = [];
  for (const item of itens || []) {
    const b = montarBancada(item, { meta: m });
    const base = { itemId: item.itemId, titulo: item.titulo, sku: item.sku || null, precoAtual: b.precos.comprador, margemAtual: b.resultado.calculavel ? b.resultado.margemPercent : null, lucroAtual: b.resultado.calculavel ? b.resultado.lucro : null, precoVisto: item.fingerprint ? item.fingerprint.precoVisto : null };
    const p = b.promocao || {};
    const ex = (tipo, motivo) => excecoes.push({ ...base, tipo, motivo });
    if (b.status === "BLOQUEADO") { ex(EXCECAO.BLOQUEADO, (b.bloqueios[0] && b.bloqueios[0].texto) || "Falta informação para calcular."); continue; }
    if (b.status === "MARGEM_DESCONHECIDA") { ex(EXCECAO.MARGEM_INCERTA, "Quanto o Mercado Livre paga desta promoção não está comprovado: a margem pode estar errada."); continue; }
    if (b.precoMudou) { ex(EXCECAO.PRECO_MUDOU, b.precoMudou.texto); continue; }
    if (b.status === "OK") { ex(EXCECAO.NA_META, "Já está na meta."); continue; }
    const vendedor = p.ativa && p.financiamento === "VENDEDOR_100";
    if (estrategia === "SAIR_CAMPANHA" && !vendedor) { ex(EXCECAO.NAO_SE_APLICA, p.ativa ? "A promoção não é uma campanha própria do vendedor." : "Não tem campanha para sair."); continue; }
    if (estrategia === "AJUSTAR_PROMOCIONAL" && !(vendedor && p.modoEscrita === "PRECO")) { ex(EXCECAO.NAO_SE_APLICA, !p.ativa ? "Não está em promoção." : p.modoEscrita !== "PRECO" ? "Nesta promoção o Mercado Livre define o preço: dá para continuar ou sair, não para mudar o valor." : "A promoção tem ajuda do Mercado Livre: ajustar o valor não está disponível."); continue; }
    if (estrategia === "ALTERAR_CHEIO" && p.ativa) { ex(EXCECAO.NAO_SE_APLICA, "Está em promoção: alterar o preço cheio não muda o que o comprador paga."); continue; }
    const s = b.sugerido || {};
    if (!num(s.preco)) { ex(EXCECAO.SEM_PRECO, "Com os custos atuais, não há preço que atinja a meta."); continue; }
    let preco = s.preco, tipo = s.status === "RECOTADO" ? "RECOTADO" : "PRELIMINAR", res = null;
    if (tipo === "PRELIMINAR" && terminarEm90) preco = fim90(preco);
    if (estrategia === "AJUSTAR_PROMOCIONAL" && preco >= b.precos.cheio - 0.009) { ex(EXCECAO.NAO_SE_APLICA, "O preço da meta é maior que o preço cheio: é preciso sair da campanha."); continue; }
    if (tipo === "RECOTADO") res = { margemPercent: s.margemPercent, lucro: s.lucro, comissao: s.comissao, frete: s.frete };
    else { const sim = (await simularPreliminar(item, [preco])).simulacoes[0]; res = sim && sim.resultado && sim.resultado.calculavel ? { margemPercent: sim.resultado.margemPercent, lucro: sim.resultado.lucro, comissao: sim.comissao && sim.comissao.valor, frete: sim.frete && sim.frete.valor } : null; }
    if (!res) { ex(EXCECAO.SEM_PRECO, "Não foi possível calcular o preço proposto."); continue; }
    const aumento = base.precoAtual ? r2((preco / base.precoAtual - 1) * 100) : null;
    const prop = { ...base, estrategia, acao: ESTRATEGIAS[estrategia], precoProposto: preco, tipo, margemProposta: res.margemPercent, lucroProposto: res.lucro, comissaoProposta: res.comissao, freteProposto: res.frete, aumentoPercent: aumento, unidades30d: item.vendas30d ? item.vendas30d.unidades || 0 : 0 };
    if (teto !== null && aumento !== null && aumento / 100 > teto + 1e-9) excecoes.push({ ...prop, tipo: EXCECAO.ACIMA_DO_TETO, tipoPreco: tipo, motivo: `O aumento seria de ${aumento.toLocaleString("pt-BR")}%, acima do limite de ${r2(teto * 100).toLocaleString("pt-BR")}%.` });
    else prontos.push(prop);
  }
  return { ok: true, versao: VERSAO, prontos, excecoes, resumo: { prontos: prontos.length, recotados: prontos.filter((x) => x.tipo === "RECOTADO").length, preliminares: prontos.filter((x) => x.tipo === "PRELIMINAR").length, excecoes: excecoes.length } };
}

module.exports = { simularPreliminar, propostasEmLote, entradaDoContratoAuditado, ESTRATEGIAS, EXCECAO, VERSAO };
