// server/controllers/resgateController.js
//
// VenForce Resgate — API. Leituras do RESULTADO já salvo (abrir a tela nunca
// dispara varredura). Escopo SEMPRE pela carteira do usuário. As únicas
// chamadas ao Mercado Livre são GET (simulação ao vivo e dry-run). Não há rota
// de escrita no ML. Sem as tabelas do Resgate (migration não aplicada), toda
// rota responde 503 RESGATE_TABELAS_AUSENTES — nada é criado sozinho.

const pool = require("../config/database");
const { criarStorePg } = require("../services/resgate/resgateStorePg");
const { criarFetchSomenteLeitura, lerAnuncioAoVivo } = require("../services/resgate/resgateAoVivo");
const { simularPrecos, recomendarPreco } = require("../services/resgate/resgateRecomendacao");
const { entradaAoVivo } = require("../services/resgate/resgateAuditoriaItem");
const { planoParaBuffer, STATUS_REVISAO } = require("../services/resgate/resgatePlanoXlsx");
const { planoDeAtivacao } = require("../services/resgate/resgateAtivacao");
const { simularLote } = require("../services/resgate/resgateDryRun");
const { clientesAutorizadosSet } = require("../services/squads/authorizationService");
const repo = require("../services/resgate/resgateLeituraRepository");
const { montarBancada, linhaDaLista, normalizarRecotacao, metaDe, FILTROS } = require("../services/resgate/resgateBancada");
const { montarContratoFinanceiro } = require("../services/resgate/resgateContrato");
const { montarPedidosDoItem, montarDetalhePedido } = require("../services/resgate/resgatePedidos");
const { simularPreliminar, propostasEmLote, ESTRATEGIAS } = require("../services/resgate/resgateSimulacaoPreliminar");
const centralVendasReadService = require("../services/centralVendas/centralVendasReadService");

// Ações reais (alterar preço / promoção) usam os endpoints EXISTENTES de /anuncios-meli
// direto da tela, com as travas deles. A tela só as habilita com esta flag explícita
// (padrão: desligada). Nenhuma rota do Resgate escreve no Mercado Livre.
const acoesHabilitadas = () => process.env.RESGATE_ACOES_ML_HABILITADAS === "1";


// Teto por conta na planilha global do servidor (memória do Render); a CLI exporta tudo.
const LIMITE_GLOBAL_POR_CONTA = 1500;

const deps = { db: pool, criarFetch: () => criarFetchSomenteLeitura({ minIntervalMs: 150 }), clientesAutorizados: clientesAutorizadosSet, lerAoVivo: lerAnuncioAoVivo,
  // Pedidos: SOMENTE os serviços de leitura da Central de Vendas (nenhuma query própria, nenhuma fórmula).
  centralLer: (...a) => centralVendasReadService.getCentralVendasRead(...a),
  centralDetalhe: (...a) => centralVendasReadService.getCentralVendasReadOrderDetail(...a),
  hoje: () => new Date() };
function configurar(novas) { Object.assign(deps, novas); }

async function storeOu503(res) {
  const store = criarStorePg(deps.db);
  try {
    if (await store.tabelasDisponiveis()) return store;
  } catch (_) { /* cai no 503 */ }
  res.status(503).json({ ok: false, codigo: "RESGATE_TABELAS_AUSENTES", motivo: "VenForce Resgate ainda não foi habilitado neste ambiente (migration 20261112_venforce_resgate.sql não aplicada)." });
  return null;
}

async function carteira(req) {
  if (String(req.user?.role || "").toLowerCase() === "admin") return null; // admin: todas
  const s = await deps.clientesAutorizados(req.user || {});
  return [...s].map(Number);
}

async function execucaoAtual(store) { return store.ultimaExecucao({ incluirEmAndamento: false }); }

function contaDaRequisicao(req) {
  // requireClienteContaNaCarteira("contaId") já validou a carteira.
  return req.contaAutorizada || null;
}

async function visaoGlobal(req, res) {
  try {
    const store = await storeOu503(res); if (!store) return;
    const exec = await execucaoAtual(store);
    if (!exec) return res.json({ ok: true, execucao: null, contas: [], totais: null, ativacao: null });
    const ids = await carteira(req);
    const linhas = await store.listarContas(exec.id, ids);
    const contas = linhas.map((l) => ({ ...l.resumo, matriz: l.matriz ? { decisao: l.matriz.decisao, motivos: l.matriz.motivos, financeiramenteValidada: l.matriz.financeiramenteValidada, modalidades: l.matriz.modalidades, totais: l.matriz.totais } : null }));
    const soma = (k) => contas.reduce((s, c) => s + (Number(c[k]) || 0), 0);
    const totais = {
      contasAvaliadas: contas.filter((c) => !c.semAvaliacao).length, contasSemAvaliacao: contas.filter((c) => c.semAvaliacao).length,
      anunciosAuditados: soma("itens"), precosCorretos: soma("precosCorretos"), precisamRevisao: soma("precisamRevisao"),
      semMargemConfiavel: soma("semMargemConfiavel"), alteradosRecentemente: soma("alteradosRecentemente"),
      riscoFinanceiro30d: Math.round(soma("riscoFinanceiro30d") * 100) / 100, faturamentoComMargemDesconhecida30d: Math.round(soma("faturamentoComMargemDesconhecida30d") * 100) / 100,
    };
    const ativacao = planoDeAtivacao({ contas: linhas.map((l) => ({ resumo: l.resumo, matriz: l.matriz })) });
    return res.json({ ok: true, execucao: { id: exec.id, status: exec.status, iniciadaEm: exec.iniciada_em, finalizadaEm: exec.finalizada_em }, contas, totais, ativacao });
  } catch (err) {
    console.error("[resgate] visaoGlobal:", err.message);
    return res.status(500).json({ ok: false, motivo: "Erro ao ler o Resgate." });
  }
}

async function conta(req, res) {
  try {
    const store = await storeOu503(res); if (!store) return;
    const exec = await execucaoAtual(store);
    const ctx = contaDaRequisicao(req);
    if (!exec || !ctx) return res.status(404).json({ ok: false, motivo: "Sem auditoria para esta conta." });
    const c = await store.lerConta(exec.id, Number(req.params.contaId));
    if (!c) return res.status(404).json({ ok: false, motivo: "Conta não auditada na última execução." });
    return res.json({ ok: true, execucaoId: exec.id, resumo: c.resumo, matriz: c.matriz });
  } catch (err) {
    console.error("[resgate] conta:", err.message);
    return res.status(500).json({ ok: false, motivo: "Erro ao ler a conta." });
  }
}

async function itens(req, res) {
  try {
    const store = await storeOu503(res); if (!store) return;
    const exec = await execucaoAtual(store);
    if (!exec) return res.json({ ok: true, total: 0, itens: [] });
    const limite = Math.min(100, Math.max(1, Number(req.query.limite) || 50));
    const pagina = Math.max(1, Number(req.query.pagina) || 1);
    const r = await store.paginaItens(exec.id, Number(req.params.contaId), {
      situacao: req.query.situacao || null, acao: req.query.acao || null, origem: req.query.origem || null,
      somenteRecentes: req.query.recentes === "1", busca: req.query.busca || null, limite, offset: (pagina - 1) * limite,
      filtro: FILTROS.includes(req.query.filtro) ? req.query.filtro : null, meta: metaDe(req.query.meta),
    });
    // Lista leve: o contrato completo só no detalhe. `bancada` = colunas simples da tela nova.
    const meta = metaDe(req.query.meta);
    const leves = r.itens.map((x) => ({
      bancada: linhaDaLista(x, montarBancada(x, { meta })),
      itemId: x.itemId, sku: x.sku, titulo: x.titulo, statusAnuncio: x.statusAnuncio, familiaLogistica: x.familiaLogistica,
      situacao: x.situacao, acao: x.acao, prioridade: x.prioridade, origem: x.historico && x.historico.origem, mudancaRecente: x.historico && x.historico.mudancaRecente,
      ultimaMudancaEm: x.historico && x.historico.ultimaMudancaEm, fonteAvaliacao: x.fonteAvaliacao,
      preco: x.contrato.componentes.precoVigente.valor, margemPercent: x.contrato.resultado.margemPercent, margemExibida: x.snapshot && x.snapshot.margemPercent,
      frete: x.contrato.componentes.frete.valor, freteNivel: x.contrato.componentes.frete.nivel, confianca: x.contrato.confiancaGeral,
      bloqueios: (x.contrato.bloqueios || []).map((b) => b.codigo), unidades30d: x.vendas30d && x.vendas30d.unidades, exposicao: x.exposicao,
      recomendacao: x.recomendacao ? { ok: x.recomendacao.ok, preco: x.recomendacao.preco, margemPercentApos: x.recomendacao.margemPercentApos, motivo: x.recomendacao.motivo } : null,
      revisao: x.revisao, precoVisto: x.fingerprint && x.fingerprint.precoVisto,
    }));
    return res.json({ ok: true, execucaoId: exec.id, total: r.total, pagina, limite, itens: leves });
  } catch (err) {
    console.error("[resgate] itens:", err.message);
    return res.status(500).json({ ok: false, motivo: "Erro ao listar anúncios." });
  }
}

async function item(req, res) {
  try {
    const store = await storeOu503(res); if (!store) return;
    const exec = await execucaoAtual(store);
    const x = exec ? await store.item(exec.id, Number(req.params.contaId), String(req.params.itemId)) : null;
    if (!x) return res.status(404).json({ ok: false, motivo: "Anúncio não auditado." });
    const ctx = contaDaRequisicao(req);
    return res.json({
      ok: true, execucaoId: exec.id, item: x, bancada: montarBancada(x, { meta: metaDe(req.query.meta) }),
      contexto: { clienteSlug: ctx ? ctx.clienteSlug || null : null, clienteContaId: Number(req.params.contaId), acoesHabilitadas: acoesHabilitadas() },
    });
  } catch (err) {
    console.error("[resgate] item:", err.message);
    return res.status(500).json({ ok: false, motivo: "Erro ao ler o anúncio." });
  }
}

/** POST /resgate/contas/:contaId/itens/:itemId/simular { precos?:number[], meta?:number } — SOMENTE GET no ML. */
async function simular(req, res) {
  try {
    const store = await storeOu503(res); if (!store) return;
    const ctx = contaDaRequisicao(req);
    const exec = await execucaoAtual(store);
    const auditado = exec ? await store.item(exec.id, Number(req.params.contaId), String(req.params.itemId)) : null;
    if (!ctx || !auditado) return res.status(404).json({ ok: false, motivo: "Anúncio não auditado nesta conta." });
    const precos = (Array.isArray(req.body && req.body.precos) ? req.body.precos : []).map(Number).filter((p) => p > 0).slice(0, 8);
    // Preliminar: NENHUMA chamada ao ML — mesmo núcleo, comissão e frete auditados do preço atual.
    if (req.body && req.body.preliminar === true) return res.json(await simularPreliminar(auditado, precos));
    const meta = metaDe(req.body && req.body.meta) ?? (auditado.meta ? auditado.meta.valor : null);
    const ler = deps.criarFetch();
    const vivo = await deps.lerAoVivo({ clienteId: ctx.clienteId, sellerId: auditado.sellerId, itemId: auditado.itemId, ler });
    if (!vivo.ok) return res.status(502).json({ ok: false, codigo: "LEITURA_ML_FALHOU", motivo: vivo.motivo });
    const [row] = await repo.paginaItens(deps.db, { clienteContaId: Number(req.params.contaId), aposItemId: "", limite: 1, itemIds: [auditado.itemId] });
    const entrada = entradaAoVivo(vivo, row || {}, { clienteId: ctx.clienteId, clienteContaId: Number(req.params.contaId), sellerId: auditado.sellerId });
    const simulacoes = precos.length ? await simularPrecos(entrada, precos, vivo.cotarEmPreco) : [];
    // recotar:false = só simular os preços pedidos (sem buscar o sugerido: menos GET no ML).
    const querRecotar = !(req.body && req.body.recotar === false);
    const recomendacao = querRecotar && Number.isFinite(meta) ? await recomendarPreco(entrada, { meta, cotarEmPreco: vivo.cotarEmPreco }) : null;
    // Bancada AO VIVO: contrato do preço atual (promoção financiada pela evidência lida agora)
    // + recotação do sugerido + cenário "sair da promoção" (só quando pode decidir: cheio ≥ sugerido).
    const contratoVivo = montarContratoFinanceiro(entrada);
    const cheio = Number(vivo.precos.cheio), atual = Number(vivo.precos.vigente);
    let cenarioSairPromo = null;
    if (recomendacao && recomendacao.ok && cheio > atual + 0.001 && cheio >= recomendacao.preco - 0.009) {
      const [sv] = await simularPrecos(entrada, [cheio], vivo.cotarEmPreco);
      if (sv && sv.contrato) cenarioSairPromo = { preco: cheio, calculavel: sv.contrato.resultado.calculavel, margem: sv.contrato.resultado.margem, lucro: sv.contrato.resultado.lucro, margemConfiavel: sv.contrato.margemConfiavel };
    }
    const recotacao = recomendacao ? normalizarRecotacao({
      ok: recomendacao.ok, motivo: recomendacao.motivo || null, meta, recotadoEm: vivo.observadoEm, cenarioSairPromo,
      recomendacao: recomendacao.contrato ? { preco: recomendacao.preco, comissao: recomendacao.contrato.componentes.comissao.valor, frete: recomendacao.contrato.componentes.frete.valor, freteNivel: recomendacao.contrato.componentes.frete.nivel, freteConfianca: recomendacao.contrato.componentes.frete.confianca, margem: recomendacao.contrato.resultado.margem, lucro: recomendacao.contrato.resultado.lucro, margemConfiavel: recomendacao.contrato.margemConfiavel } : null,
    }) : null;
    const financiamento = vivo.promocao && vivo.promocao.financiamento && vivo.promocao.financiamento.financiamento !== undefined ? vivo.promocao.financiamento : null;
    const bancada = montarBancada({ ...auditado, contrato: contratoVivo, promocaoFinanciamento: null, recotacao: null }, { promocao: financiamento && cheio > atual + 0.001 ? financiamento : null, recotacao, meta });
    return res.json({
      ok: true, observadoEm: vivo.observadoEm, precoAtual: vivo.precos.vigente,
      precoMudouDesdeAuditoria: auditado.fingerprint && auditado.fingerprint.precoVisto !== null && Math.abs(Number(vivo.precos.vigente) - Number(auditado.fingerprint.precoVisto)) >= 0.01,
      simulacoes: simulacoes.map((s) => ({ preco: s.preco, erro: s.erro || null, resultado: s.contrato ? s.contrato.resultado : null, frete: s.contrato ? s.contrato.componentes.frete : null, comissao: s.contrato ? s.contrato.componentes.comissao : null, bloqueios: s.contrato ? s.contrato.bloqueios : [] })),
      recomendacao: recomendacao ? { ok: recomendacao.ok, preco: recomendacao.preco ?? null, motivo: recomendacao.motivo || null, margemPercent: recomendacao.contrato ? recomendacao.contrato.resultado.margemPercent : null, trilha: recomendacao.trilha } : null,
      recotacao, bancada, metricasMl: ler.metricas,
    });
  } catch (err) {
    console.error("[resgate] simular:", err.message);
    return res.status(500).json({ ok: false, motivo: "Erro ao simular." });
  }
}

const ISO = (d) => d.toISOString().slice(0, 10);
function periodoDePedidos(req) {
  const dias = Math.min(365, Math.max(1, parseInt(req.query.dias, 10) || 90));
  const fim = deps.hoje(), ini = new Date(fim.getTime() - dias * 86400000);
  return { dateFrom: /^\d{4}-\d{2}-\d{2}$/.test(req.query.dateFrom || "") ? req.query.dateFrom : ISO(ini), dateTo: /^\d{4}-\d{2}-\d{2}$/.test(req.query.dateTo || "") ? req.query.dateTo : ISO(fim), dias };
}
function erroCentral(res, err, onde) {
  const code = err && err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  if (code === 500) console.error(`[resgate] ${onde}:`, err && err.message);
  return res.status(code).json({ ok: false, motivo: code === 404 ? "Pedido não encontrado neste período." : code === 500 ? "Erro ao ler pedidos da Central de Vendas." : (err.message || "Pedidos indisponíveis.") });
}

/** GET /resgate/contas/:contaId/itens/:itemId/pedidos?dias=90&meta= — pedidos reais do MLB (Central de Vendas, só leitura). */
async function pedidos(req, res) {
  try {
    const store = await storeOu503(res); if (!store) return;
    const exec = await execucaoAtual(store);
    const contaId = Number(req.params.contaId), itemId = String(req.params.itemId);
    const x = exec ? await store.item(exec.id, contaId, itemId) : null;
    if (!x) return res.status(404).json({ ok: false, motivo: "Anúncio não auditado." });
    const ctx = contaDaRequisicao(req);
    if (!ctx || !ctx.clienteSlug) return res.status(409).json({ ok: false, motivo: "Conta sem cliente vinculado: pedidos indisponíveis." });
    const per = periodoDePedidos(req);
    const r = await deps.centralLer(ctx.clienteSlug, { dateFrom: per.dateFrom, dateTo: per.dateTo, marketplace: "meli", clienteContaId: contaId, search: itemId, limit: 200, sort: "data_desc", page: 1 });
    const bancada = montarBancada(x, { meta: metaDe(req.query.meta) });
    return res.json({ ok: true, ...montarPedidosDoItem({ itemId, rows: r.rows, bancada, periodo: { ...per, central: r.periodo || null }, completude: r.completude || null, snapshot: r.snapshot || null, totalNoPeriodo: r.pagination ? r.pagination.total : null }) });
  } catch (err) { return erroCentral(res, err, "pedidos"); }
}

/** GET /resgate/contas/:contaId/itens/:itemId/pedidos/:rowId — detalhe financeiro de um pedido. */
async function pedidoDetalhe(req, res) {
  try {
    const store = await storeOu503(res); if (!store) return;
    const exec = await execucaoAtual(store);
    const contaId = Number(req.params.contaId), itemId = String(req.params.itemId);
    const x = exec ? await store.item(exec.id, contaId, itemId) : null;
    if (!x) return res.status(404).json({ ok: false, motivo: "Anúncio não auditado." });
    const ctx = contaDaRequisicao(req);
    if (!ctx || !ctx.clienteSlug) return res.status(409).json({ ok: false, motivo: "Conta sem cliente vinculado: pedidos indisponíveis." });
    const per = periodoDePedidos(req);
    const r = await deps.centralDetalhe(ctx.clienteSlug, req.params.rowId, { dateFrom: per.dateFrom, dateTo: per.dateTo, marketplace: "meli", clienteContaId: contaId });
    const doAnuncio = (r.pedido.itens || []).some((i) => String(i.mlb || "").toUpperCase() === itemId.toUpperCase());
    if (!doAnuncio) return res.status(404).json({ ok: false, motivo: "Este pedido não contém o anúncio." });
    return res.json({ ok: true, ...montarDetalhePedido({ pedido: r.pedido, itemId, bancada: montarBancada(x, { meta: metaDe(req.query.meta) }) }) });
  } catch (err) { return erroCentral(res, err, "pedidoDetalhe"); }
}

/**
 * POST /resgate/contas/:contaId/propostas { itemIds[], estrategia, meta, tetoAumento, terminarEm90 }
 * Prepara PROPOSTAS em lote (nada é aplicado, nada é gravado): preço da meta recotado quando
 * existe, senão PRELIMINAR; exceções com o motivo. Sem chamada ao ML.
 */
async function propostas(req, res) {
  try {
    const store = await storeOu503(res); if (!store) return;
    const exec = await execucaoAtual(store);
    if (!exec) return res.status(404).json({ ok: false, motivo: "Sem auditoria para esta conta." });
    const b = req.body || {};
    if (!ESTRATEGIAS[b.estrategia]) return res.status(400).json({ ok: false, motivo: "Estratégia inválida." });
    const ids = new Set((Array.isArray(b.itemIds) ? b.itemIds : []).map(String).slice(0, 500));
    if (!ids.size) return res.status(400).json({ ok: false, motivo: "Selecione ao menos um anúncio." });
    const itens = (await store.lerItens(exec.id, Number(req.params.contaId))).filter((x) => ids.has(x.itemId));
    return res.json(await propostasEmLote(itens, { estrategia: b.estrategia, meta: b.meta, tetoAumento: b.tetoAumento, terminarEm90: b.terminarEm90 === true }));
  } catch (err) {
    console.error("[resgate] propostas:", err.message);
    return res.status(500).json({ ok: false, motivo: "Erro ao preparar as propostas." });
  }
}

/** GET /resgate/config — o que a tela pode oferecer neste ambiente. */
function config(_req, res) {
  return res.json({ ok: true, acoesHabilitadas: acoesHabilitadas(), recotacaoSobDemanda: true, simulacaoPreliminar: true, preview: false });
}

/** POST /resgate/contas/:contaId/itens/:itemId/revisao { status, nota, precoVisto } */
async function revisar(req, res) {
  try {
    const store = await storeOu503(res); if (!store) return;
    const exec = await execucaoAtual(store);
    const status = String((req.body && req.body.status) || "").toUpperCase();
    if (!STATUS_REVISAO.includes(status) || status === "INVALIDADO") return res.status(400).json({ ok: false, motivo: "Status de revisão inválido." });
    const precoVisto = Number(req.body && req.body.precoVisto);
    if (!Number.isFinite(precoVisto)) return res.status(400).json({ ok: false, motivo: "Informe o preço visto (proteção contra proposta desatualizada)." });
    const okRev = exec && (await store.registrarRevisao(exec.id, Number(req.params.contaId), String(req.params.itemId), { status, nota: req.body.nota ? String(req.body.nota).slice(0, 500) : null, userId: req.user && req.user.id, precoVisto }));
    if (!okRev) return res.status(409).json({ ok: false, codigo: "PROPOSTA_DESATUALIZADA", motivo: "O preço visto não confere com a proposta auditada: recalcule antes de revisar." });
    return res.json({ ok: true, status });
  } catch (err) {
    console.error("[resgate] revisar:", err.message);
    return res.status(500).json({ ok: false, motivo: "Erro ao registrar a revisão." });
  }
}

/** GET /resgate/plano.xlsx[?contaId=] — carteira do usuário; dados da ÚLTIMA execução. */
async function planoXlsx(req, res) {
  try {
    const store = await storeOu503(res); if (!store) return;
    const exec = await execucaoAtual(store);
    if (!exec) return res.status(404).json({ ok: false, motivo: "Nenhuma auditoria concluída." });
    let linhas = await store.listarContas(exec.id, await carteira(req));
    if (req.params.contaId) linhas = linhas.filter((l) => Number(l.cliente_conta_id) === Number(req.params.contaId));
    const itensPorConta = new Map();
    // Exportação global no servidor: só anúncios com ação (memória limitada no Render);
    // a planilha de UMA conta traz todos. A exportação global completa é feita pela CLI.
    const somenteAcionaveis = !req.params.contaId;
    for (const l of linhas) itensPorConta.set(Number(l.cliente_conta_id), await store.lerItens(exec.id, Number(l.cliente_conta_id), { somenteAcionaveis, limite: somenteAcionaveis ? LIMITE_GLOBAL_POR_CONTA : null }));
    const buf = planoParaBuffer({ contas: linhas.map((l) => ({ resumo: l.resumo, matriz: l.matriz })), itensPorConta, execucao: { id: exec.id, iniciadaEm: exec.iniciada_em, finalizadaEm: exec.finalizada_em } });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="venforce-resgate-${exec.id}${req.params.contaId ? `-conta-${req.params.contaId}` : ""}.xlsx"`);
    return res.send(buf);
  } catch (err) {
    console.error("[resgate] planoXlsx:", err.message);
    return res.status(500).json({ ok: false, motivo: "Erro ao gerar a planilha." });
  }
}

/** POST /resgate/contas/:contaId/dry-run — propostas APROVADAS da conta, revalidadas ao vivo (GET). Nada é escrito. */
async function dryRun(req, res) {
  try {
    const store = await storeOu503(res); if (!store) return;
    const ctx = contaDaRequisicao(req);
    const exec = await execucaoAtual(store);
    if (!exec || !ctx) return res.status(404).json({ ok: false, motivo: "Sem auditoria para esta conta." });
    const contaId = Number(req.params.contaId);
    const todos = await store.lerItens(exec.id, contaId);
    const { itens: revisados } = await store.paginaItens(exec.id, contaId, { limite: 200 });
    const aprovados = new Set(revisados.filter((x) => x.revisao && x.revisao.status === "APROVADO").map((x) => x.itemId));
    const propostas = todos.filter((x) => aprovados.has(x.itemId) && x.recomendacao && x.recomendacao.ok).map((x) => ({
      clienteId: ctx.clienteId, clienteContaId: contaId, sellerId: x.sellerId, itemId: x.itemId, aprovado: true,
      precoVisto: x.fingerprint.precoVisto, precoProposto: x.recomendacao.preco, meta: x.meta ? x.meta.valor : null, restricoes: x.restricoes || [],
    }));
    const rows = propostas.length ? await repo.paginaItens(deps.db, { clienteContaId: contaId, aposItemId: "", limite: 1000, itemIds: propostas.map((p) => p.itemId) }) : [];
    const r = await simularLote({ propostas, ler: deps.criarFetch(), linhasPorItem: new Map(rows.map((x) => [x.item_id, x])), contas: new Map([[String(contaId), { clienteId: ctx.clienteId, clienteContaId: contaId }]]) });
    return res.json({ ok: true, ...r });
  } catch (err) {
    console.error("[resgate] dryRun:", err.message);
    return res.status(500).json({ ok: false, motivo: "Erro no dry-run." });
  }
}

module.exports = { visaoGlobal, conta, itens, item, simular, revisar, planoXlsx, dryRun, config, pedidos, pedidoDetalhe, propostas, configurar };
