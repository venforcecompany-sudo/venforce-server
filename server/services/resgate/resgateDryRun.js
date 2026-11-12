// server/services/resgate/resgateDryRun.js
//
// DRY-RUN da recuperação em massa. Produz, para cada proposta aprovada, o que
// SERIA enviado ao Mercado Livre — e por que não seria —, revalidando AO VIVO
// (somente GET) antes de cada item. NÃO EXISTE caminho de escrita nesta
// versão: `executarLote` lança sempre. A estrutura já prevê o que a execução
// futura exige: aprovação humana, revalidação do preço visto (proteção contra
// alteração concorrente/manual), limite de variação, limite por lote e por
// conta, 429/falha parcial, log/auditoria, verificação pós-escrita e compensação.

const { resolverPrecosItem } = require("../automacoes/precoItemService");
const { lerAnuncioAoVivo } = require("./resgateAoVivo");
const { recomendarPreco } = require("./resgateRecomendacao");
const { entradaAoVivo } = require("./resgateAuditoriaItem");

// Trava dura: não depende de env. Ligar escrita exige outra entrega, revisada.
const ESCRITA_REAL_DISPONIVEL = false;

const LIMITES_PADRAO = Object.freeze({ variacaoMaxima: 0.30, maxPorLote: 20, maxPorConta: 100, toleranciaPreco: 0.01 });

const MOTIVO = Object.freeze({
  SEM_APROVACAO: "SEM_APROVACAO_HUMANA",
  SEM_RECOMENDACAO: "SEM_PRECO_RECOMENDADO",
  PRECO_MUDOU: "PRECO_MUDOU_DESDE_A_ANALISE",
  PRECO_ILEGIVEL: "PRECO_ATUAL_ILEGIVEL",
  VARIACAO: "VARIACAO_ACIMA_DO_LIMITE",
  LIMITE_LOTE: "LIMITE_DO_LOTE",
  LIMITE_CONTA: "LIMITE_DA_CONTA",
  RESTRICAO: "RESTRICAO_DO_ANUNCIO",
  META_NAO_ATINGIDA: "PROPOSTA_NAO_ATINGE_A_META_AO_VIVO",
  LEITURA_FALHOU: "REVALIDACAO_FALHOU",
});

class EscritaDesativadaError extends Error {
  constructor() { super("Escrita real do VenForce Resgate não existe nesta versão (somente dry-run)."); this.code = "RESGATE_ESCRITA_DESATIVADA"; }
}

/**
 * @param {object} p
 *  propostas[]  { clienteId, clienteContaId, sellerId, itemId, aprovado:boolean, precoVisto, precoProposto, meta, restricoes[], entradaBase? (row) }
 *  ler          fetch somente leitura (criarFetchSomenteLeitura)
 *  limites      { variacaoMaxima, maxPorLote, maxPorConta }
 *  agora        () => Date
 * @returns {{ lote, itens[], resumo }}
 */
async function simularLote({ propostas = [], ler, limites = {}, linhasPorItem = new Map(), contas = new Map(), agora = () => new Date() }) {
  const L = { ...LIMITES_PADRAO, ...limites };
  const porConta = new Map();
  const itens = [];
  let noLote = 0;
  for (const p of propostas) {
    const base = { itemId: p.itemId, clienteContaId: p.clienteContaId, precoVisto: p.precoVisto, precoProposto: p.precoProposto, revalidadoEm: null };
    const bloquear = (motivo, extra = {}) => itens.push({ ...base, acao: "NAO_ESCREVERIA", motivo, ...extra });
    if (!p.aprovado) { bloquear(MOTIVO.SEM_APROVACAO); continue; }
    if (!(Number(p.precoProposto) > 0)) { bloquear(MOTIVO.SEM_RECOMENDACAO); continue; }
    const restr = (p.restricoes || []).filter((r) => r && (r.codigo === "PROMOCAO_ATIVA" || r.codigo === "ANUNCIO_COM_VARIACOES"));
    if (restr.length) { bloquear(MOTIVO.RESTRICAO, { detalhe: restr.map((r) => r.codigo) }); continue; }
    const variacao = (Number(p.precoProposto) - Number(p.precoVisto)) / Number(p.precoVisto);
    if (!Number.isFinite(variacao) || Math.abs(variacao) > L.variacaoMaxima) { bloquear(MOTIVO.VARIACAO, { variacao }); continue; }
    if (noLote >= L.maxPorLote) { bloquear(MOTIVO.LIMITE_LOTE); continue; }
    const k = String(p.clienteContaId);
    if ((porConta.get(k) || 0) >= L.maxPorConta) { bloquear(MOTIVO.LIMITE_CONTA); continue; }

    // Revalidação ao vivo (GET): o preço atual tem de ser o preço visto.
    let atual = null;
    try {
      const pr = await resolverPrecosItem({ clienteId: p.clienteId, itemId: p.itemId, mlUserId: String(p.sellerId), fetchFn: ler });
      atual = pr && Number.isFinite(Number(pr.precoEfetivo)) ? Number(pr.precoEfetivo) : null;
      if (pr && pr.precoPromocional != null) { bloquear(MOTIVO.RESTRICAO, { detalhe: ["PROMOCAO_ATIVA"], precoAtual: atual, revalidadoEm: agora().toISOString() }); continue; }
    } catch (err) { bloquear(MOTIVO.LEITURA_FALHOU, { erro: err && err.code ? err.code : "erro" }); continue; }
    if (atual === null) { bloquear(MOTIVO.PRECO_ILEGIVEL); continue; }
    if (Math.abs(atual - Number(p.precoVisto)) >= L.toleranciaPreco) {
      bloquear(MOTIVO.PRECO_MUDOU, { precoAtual: atual, revalidadoEm: agora().toISOString(), texto: "Preço alterado depois da análise (manual ou externo): proposta invalidada, nada seria sobrescrito." });
      continue;
    }

    // Reconfere a meta no preço proposto com cotação ao vivo (comissão e frete recotados).
    let confere = null;
    const row = linhasPorItem.get(p.itemId);
    const conta = contas.get(k) || { clienteId: p.clienteId, clienteContaId: p.clienteContaId, sellerId: p.sellerId };
    if (row) {
      try {
        const vivo = await lerAnuncioAoVivo({ clienteId: p.clienteId, sellerId: p.sellerId, itemId: p.itemId, ler, agora });
        if (vivo.ok) {
          const sim = await recomendarPreco(entradaAoVivo(vivo, row, conta), { meta: p.meta, cotarEmPreco: vivo.cotarEmPreco, limiteVariacao: L.variacaoMaxima });
          confere = sim.ok ? { precoMinimoAoVivo: sim.preco, margemPercent: sim.contrato.resultado.margemPercent } : { motivo: sim.motivo };
          if (sim.ok && Number(p.precoProposto) + 0.005 < sim.preco) { bloquear(MOTIVO.META_NAO_ATINGIDA, { precoAtual: atual, confere, revalidadoEm: agora().toISOString() }); continue; }
        }
      } catch (_) { confere = { motivo: "recotacao_falhou" }; }
    }

    noLote++;
    porConta.set(k, (porConta.get(k) || 0) + 1);
    itens.push({
      ...base, acao: "ESCREVERIA", precoAtual: atual, revalidadoEm: agora().toISOString(), variacao: Math.round(variacao * 10000) / 10000, confere,
      // O que a execução FUTURA enviaria — aqui só descrito.
      escrita: { metodo: "PUT", caminho: `/items/${p.itemId}`, corpo: { price: Number(p.precoProposto) }, condicao: `preço atual = ${Number(p.precoVisto).toFixed(2)} (revalidado imediatamente antes)` },
      verificacaoPosEscrita: { metodo: "GET", caminho: `/items/${p.itemId}/sale_price?context=channel_marketplace`, esperado: Number(p.precoProposto) },
      compensacao: { metodo: "PUT", caminho: `/items/${p.itemId}`, corpo: { price: Number(p.precoVisto) }, quando: "verificação divergente ou rejeição posterior do aprovador" },
    });
  }
  const resumo = itens.reduce((a, x) => { a[x.acao] = (a[x.acao] || 0) + 1; if (x.motivo) a.motivos[x.motivo] = (a.motivos[x.motivo] || 0) + 1; return a; }, { motivos: {} });
  return {
    lote: { modo: "DRY_RUN", escritaRealDisponivel: ESCRITA_REAL_DISPONIVEL, limites: L, geradoEm: agora().toISOString(), metricasApi: ler && ler.metricas ? { ...ler.metricas } : null },
    itens,
    resumo,
  };
}

/** Execução real: NÃO existe nesta versão. */
async function executarLote() { throw new EscritaDesativadaError(); }

module.exports = { simularLote, executarLote, ESCRITA_REAL_DISPONIVEL, LIMITES_PADRAO, MOTIVO, EscritaDesativadaError };
