// server/services/resgate/resgateAuditoriaService.js
//
// Execução da auditoria do Resgate — por conta, em LOTES, RETOMÁVEL e
// CANCELÁVEL, uma conta por vez (nunca jobs pesados simultâneos).
//
//  Camada 1 (banco, todas as linhas): snapshot do Motor + cadastro + vendas
//    reais (Central de Vendas) + eventos de preço → contrato, histórico,
//    classificação. Sem chamar o ML.
//  Camada 2 (ao vivo, limitada): para os N anúncios mais prioritários
//    (mudança recente, inflados, prejuízo, abaixo da meta, desconhecidos com
//    venda), lê o anúncio no ML — SOMENTE GET, rate limit e 429 tratados — e
//    recota com o cotador compartilhado (avaliação forçada), recomendando preço.
//
// Persistência via `store` (arquivo na CLI; PostgreSQL no servidor). Nada aqui
// escreve no Mercado Livre.

const repo = require("./resgateLeituraRepository");
const { auditarItem } = require("./resgateAuditoriaItem");
const { lerAnuncioAoVivo } = require("./resgateAoVivo");
const { montarMatriz } = require("./resgateCompatibilidade");
const { SITUACAO } = require("./resgateClassificacao");
const { freteConfiavelHabilitado } = require("../shared/freteCotacaoConfiavel");
const { DEFAULT_TARGET_MARGIN } = require("../motorMargem/core/marginStatus");

const PADROES = Object.freeze({
  pagina: 300,
  janelaVendasDias: 30,
  janelaEventosDias: 120,
  ttlHoras: 48,
  aoVivoMaxItens: 25,
  aoVivoConcorrencia: 2,
  limiteVariacao: 0.30,
});

const SITUACOES_AO_VIVO = new Set([SITUACAO.MARGEM_ANTIGA_INFLADA, SITUACAO.PREJUIZO, SITUACAO.ABAIXO_DA_META, SITUACAO.MARGEM_DESCONHECIDA, SITUACAO.DADOS_INSUFICIENTES, SITUACAO.SNAPSHOT_DESATUALIZADO]);

function cancelado(signal) { return Boolean(signal && signal.aborted); }
const { competenciasJanela } = repo;

/** Meta da conta: configurada > último relatório salvo do cliente > padrão do Motor (não validada). */
async function resolverMeta(db, conta, metasConfiguradas = {}) {
  const cfg = metasConfiguradas[String(conta.clienteContaId)];
  if (cfg !== undefined && cfg !== null && Number.isFinite(Number(cfg))) return { valor: Number(cfg), origem: "configurada para a conta", validada: true };
  try {
    const r = await repo.metaDoUltimoRelatorio(db, { clienteId: conta.clienteId });
    if (r && Number.isFinite(r.valor)) return { valor: r.valor > 1 ? r.valor / 100 : r.valor, origem: `último relatório salvo do cliente (${r.em.slice(0, 10)})`, validada: false };
  } catch (_) { /* sem relatórios */ }
  return { valor: DEFAULT_TARGET_MARGIN, origem: `padrão do Motor (${(DEFAULT_TARGET_MARGIN * 100).toFixed(0)}%), não validada pela conta`, validada: false };
}

function resumirConta(conta, itens, matriz, meta, extras = {}) {
  const porSituacao = {}, porOrigem = {}, porAcao = {};
  let exposicaoCalc = 0, faturamentoExposto = 0, recentes = 0, comRecomendacao = 0;
  for (const it of itens) {
    porSituacao[it.situacao] = (porSituacao[it.situacao] || 0) + 1;
    porOrigem[it.historico.origem] = (porOrigem[it.historico.origem] || 0) + 1;
    porAcao[it.acao] = (porAcao[it.acao] || 0) + 1;
    if (it.exposicao && it.exposicao.tipo !== "faturamento_exposto" && Number.isFinite(it.exposicao.valor)) exposicaoCalc += it.exposicao.valor;
    if (it.exposicao && it.exposicao.tipo === "faturamento_exposto" && Number.isFinite(it.exposicao.valor)) faturamentoExposto += it.exposicao.valor;
    if (it.historico.mudancaRecente) recentes++;
    if (it.recomendacao && it.recomendacao.ok) comRecomendacao++;
  }
  return {
    clienteContaId: conta.clienteContaId, clienteId: conta.clienteId, clienteNome: conta.clienteNome || null, contaNome: conta.contaNome || null,
    sellerId: conta.sellerId ? String(conta.sellerId) : null,
    meta, itens: itens.length, porSituacao, porOrigem, porAcao,
    precosCorretos: (porSituacao.PRECO_OK || 0) + (porSituacao.PROMOCAO_SUBSIDIADA || 0),
    precisamRevisao: (porSituacao.MARGEM_ANTIGA_INFLADA || 0) + (porSituacao.PREJUIZO || 0) + (porSituacao.ABAIXO_DA_META || 0),
    semMargemConfiavel: (porSituacao.MARGEM_DESCONHECIDA || 0) + (porSituacao.DADOS_INSUFICIENTES || 0),
    alteradosRecentemente: recentes,
    comRecomendacao,
    riscoFinanceiro30d: Math.round(exposicaoCalc * 100) / 100,
    faturamentoComMargemDesconhecida30d: Math.round(faturamentoExposto * 100) / 100,
    decisaoAtivacao: matriz ? matriz.decisao : null,
    financeiramenteValidada: matriz ? matriz.financeiramenteValidada : false,
    ...extras,
  };
}

async function emParalelo(lista, limite, fn, signal) {
  let i = 0;
  const trabalhadores = Array.from({ length: Math.max(1, limite) }, async () => {
    while (i < lista.length) {
      if (cancelado(signal)) return;
      const idx = i++;
      await fn(lista[idx], idx);
    }
  });
  await Promise.all(trabalhadores);
}

/**
 * Audita UMA conta.
 * @param {object} p
 *  db, conta {clienteId, clienteContaId, sellerId, clienteNome, contaNome}, resumoBanco,
 *  store, execucaoId, opcoes { agora, pagina, ttlHoras, metas, aoVivo:{ativo, maxItens, concorrencia, ler}, signal, logger, itemIds }
 */
async function auditarConta({ db, conta, resumoBanco = {}, store, execucaoId, opcoes = {} }) {
  const o = { ...PADROES, ...opcoes };
  const agora = o.agora || new Date();
  const log = o.logger || (() => {});
  const liberadaHoje = freteConfiavelHabilitado(conta.sellerId);
  // Conta já avaliada em produção (há linhas com freteQualidade): linhas sem ela são legado.
  const contaLiberada = liberadaHoje || (resumoBanco.freteAvaliado || 0) > 0;

  const meta = await resolverMeta(db, conta, o.metas || {});
  const desdeVendas = new Date(agora.getTime() - o.janelaVendasDias * 86400000).toISOString().slice(0, 10);
  const { porItem: vendas, imports } = await repo.vendasPorItem(db, { clienteContaId: conta.clienteContaId, desde: desdeVendas, competencias: competenciasJanela(agora, o.janelaVendasDias) });
  const eventos = await repo.eventosDePreco(db, { clienteContaId: conta.clienteContaId, desde: new Date(agora.getTime() - o.janelaEventosDias * 86400000).toISOString() });

  const cp = (store && (await store.lerCheckpoint(execucaoId, conta.clienteContaId))) || { aposItemId: "", camada: 1 };
  if (cp.concluida && store) {
    const salvo = await store.lerConta(execucaoId, conta.clienteContaId);
    if (salvo && salvo.resumo) return { status: "concluida", conta: conta.clienteContaId, resumo: salvo.resumo, matriz: salvo.matriz, itens: await store.lerItens(execucaoId, conta.clienteContaId), retomada: true };
  }
  const itens = cp.camada === 1 ? [] : await store.lerItens(execucaoId, conta.clienteContaId);
  const linhas = new Map();
  const falhasSnapshot = {};
  let aposItemId = cp.aposItemId || "";

  // ── Camada 1 ──────────────────────────────────────────────────────────────
  if (cp.camada === 1) {
    if (aposItemId) for (const it of await store.lerItens(execucaoId, conta.clienteContaId)) itens.push(it);
    for (;;) {
      if (cancelado(o.signal)) return { status: "cancelado", conta: conta.clienteContaId, aposItemId };
      const rows = await repo.paginaItens(db, { clienteContaId: conta.clienteContaId, aposItemId, limite: o.pagina, itemIds: o.itemIds || null });
      if (!rows.length) break;
      const rel = await repo.precosEmRelatorios(db, { clienteId: conta.clienteId, itemIds: rows.map((r) => r.item_id), desde: new Date(agora.getTime() - o.janelaEventosDias * 86400000).toISOString() });
      const lote = [];
      for (const row of rows) {
        if (row.refresh_status === "failed" && row.last_error) { const k = String(row.last_error).slice(0, 90); falhasSnapshot[k] = (falhasSnapshot[k] || 0) + 1; }
        linhas.set(row.item_id, row);
        lote.push(await auditarItem({
          row, conta, contaLiberada, vendas: vendas.get(row.item_id) || null, eventos: eventos.get(row.item_id) || [],
          relatorios: rel.get(row.item_id) || [], meta, agora, ttlHoras: o.ttlHoras, limiteVariacao: o.limiteVariacao,
        }));
      }
      itens.push(...lote);
      aposItemId = rows[rows.length - 1].item_id;
      if (store) { await store.salvarItens(execucaoId, conta.clienteContaId, lote); await store.salvarCheckpoint(execucaoId, conta.clienteContaId, { aposItemId, camada: 1 }); }
      log({ evento: "resgate_lote", conta: conta.clienteContaId, itens: itens.length });
      if (rows.length < o.pagina) break;
    }
    if (store) await store.salvarCheckpoint(execucaoId, conta.clienteContaId, { aposItemId, camada: 2 });
  }

  // ── Camada 2 (ao vivo, limitada) ──────────────────────────────────────────
  let metricasApi = null;
  const av = o.aoVivo || {};
  if (av.ativo && av.ler && conta.sellerId) {
    if (!linhas.size) for (const r of await carregarLinhas(db, conta, itens.map((x) => x.itemId))) linhas.set(r.item_id, r);
    const candidatos = itens
      .filter((it) => it.statusAnuncio === "active" && (it.historico.mudancaRecente || SITUACOES_AO_VIVO.has(it.situacao)) && it.fonteAvaliacao !== "ao_vivo")
      .sort((a, b) => b.prioridade - a.prioridade || (b.vendas30d.unidades - a.vendas30d.unidades))
      .slice(0, av.maxItens ?? PADROES.aoVivoMaxItens);
    const atualizados = new Map();
    await emParalelo(candidatos, av.concorrencia ?? PADROES.aoVivoConcorrencia, async (it) => {
      const row = linhas.get(it.itemId);
      if (!row) return;
      let vivo = null;
      try { vivo = await lerAnuncioAoVivo({ clienteId: conta.clienteId, sellerId: conta.sellerId, itemId: it.itemId, ler: av.ler }); }
      catch (err) { vivo = { ok: false, motivo: err && err.code ? err.code : "erro_leitura" }; }
      if (!vivo || !vivo.ok) { atualizados.set(it.itemId, { ...it, aoVivoFalhou: vivo ? vivo.motivo : "erro" }); return; }
      const novo = await auditarItem({
        row, conta, contaLiberada, vendas: vendas.get(it.itemId) || null, eventos: eventos.get(it.itemId) || [], relatorios: [], meta, vivo, agora,
        ttlHoras: o.ttlHoras, limiteVariacao: o.limiteVariacao,
      });
      atualizados.set(it.itemId, novo);
    }, o.signal);
    for (let k = 0; k < itens.length; k++) if (atualizados.has(itens[k].itemId)) itens[k] = atualizados.get(itens[k].itemId);
    if (store && atualizados.size) await store.salvarItens(execucaoId, conta.clienteContaId, [...atualizados.values()]);
    metricasApi = av.ler.metricas ? { ...av.ler.metricas, porStatus: { ...av.ler.metricas.porStatus } } : null;
    if (cancelado(o.signal)) return { status: "cancelado", conta: conta.clienteContaId, aposItemId, camada: 2 };
  }

  const matriz = montarMatriz({ conta, itens, liberadaHoje, resumo: resumoBanco, metricasApi, falhasSnapshot });
  const resumo = resumirConta(conta, itens, matriz, meta, {
    vendasImports: imports.map((i) => ({ competencia: i.competencia, ate: i.coverage_date_to })),
    contaLiberadaEmProducao: liberadaHoje, linhasLegadoBloqueaveis: contaLiberada,
  });
  if (store) { await store.salvarConta(execucaoId, conta.clienteContaId, { resumo, matriz }); await store.salvarCheckpoint(execucaoId, conta.clienteContaId, { aposItemId, camada: 3, concluida: true }); }
  return { status: "concluida", conta: conta.clienteContaId, resumo, matriz, itens };
}

async function carregarLinhas(db, conta, itemIds) {
  const out = [];
  for (let i = 0; i < itemIds.length; i += 500) out.push(...(await repo.paginaItens(db, { clienteContaId: conta.clienteContaId, aposItemId: "", limite: 1000, itemIds: itemIds.slice(i, i + 500) })));
  return out;
}

/**
 * Carteira inteira, UMA conta por vez. Contas sem anúncios/snapshots ficam
 * registradas como "sem avaliação" com o motivo (nunca somem do mapa).
 */
async function auditarCarteira({ db, contas, store, execucaoId, opcoes = {} }) {
  const resultados = [];
  const resumoBanco = await repo.resumoPorConta(db, contas.map((c) => c.clienteContaId));
  for (const conta of contas) {
    if (cancelado(opcoes.signal)) { resultados.push({ status: "cancelado", conta: conta.clienteContaId }); break; }
    const rb = resumoBanco.get(Number(conta.clienteContaId)) || {};
    const motivo = !conta.ativo ? "conta_inativa" : !conta.sellerId ? "conta_sem_seller" : !conta.temGrant ? "conta_sem_grant_ml" : !(rb.snapshots > 0) ? "sem_snapshots_do_motor" : null;
    if (motivo) {
      const r = { status: "sem_avaliacao", conta: conta.clienteContaId, motivo, resumoBanco: rb };
      resultados.push(r);
      if (store) await store.salvarConta(execucaoId, conta.clienteContaId, { resumo: { clienteContaId: conta.clienteContaId, clienteId: conta.clienteId, clienteNome: conta.clienteNome, contaNome: conta.contaNome, sellerId: conta.sellerId, semAvaliacao: motivo, snapshotBanco: rb }, matriz: null });
      continue;
    }
    try {
      const r = await auditarConta({ db, conta, resumoBanco: rb, store, execucaoId, opcoes });
      resultados.push({ status: r.status, conta: conta.clienteContaId, resumo: r.resumo, matriz: r.matriz });
    } catch (err) {
      // Falha parcial: registra e segue para a próxima conta (retomável pelo checkpoint).
      resultados.push({ status: "erro", conta: conta.clienteContaId, erro: String(err && err.message ? err.message : err).slice(0, 300) });
      if (opcoes.logger) opcoes.logger({ evento: "resgate_conta_erro", conta: conta.clienteContaId, erro: String(err && err.message).slice(0, 200) });
    }
  }
  return resultados;
}

module.exports = { auditarConta, auditarCarteira, resolverMeta, resumirConta, PADROES, competenciasJanela };
