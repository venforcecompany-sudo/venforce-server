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

const deps = { db: pool, criarFetch: () => criarFetchSomenteLeitura({ minIntervalMs: 150 }), clientesAutorizados: clientesAutorizadosSet, lerAoVivo: lerAnuncioAoVivo };
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
    });
    // Lista leve: o contrato completo só no detalhe.
    const leves = r.itens.map((x) => ({
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
    return res.json({ ok: true, execucaoId: exec.id, item: x });
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
    const meta = req.body && req.body.meta !== undefined ? Number(req.body.meta) : (auditado.meta ? auditado.meta.valor : null);
    const ler = deps.criarFetch();
    const vivo = await deps.lerAoVivo({ clienteId: ctx.clienteId, sellerId: auditado.sellerId, itemId: auditado.itemId, ler });
    if (!vivo.ok) return res.status(502).json({ ok: false, codigo: "LEITURA_ML_FALHOU", motivo: vivo.motivo });
    const [row] = await repo.paginaItens(deps.db, { clienteContaId: Number(req.params.contaId), aposItemId: "", limite: 1, itemIds: [auditado.itemId] });
    const entrada = entradaAoVivo(vivo, row || {}, { clienteId: ctx.clienteId, clienteContaId: Number(req.params.contaId), sellerId: auditado.sellerId });
    const simulacoes = precos.length ? await simularPrecos(entrada, precos, vivo.cotarEmPreco) : [];
    const recomendacao = Number.isFinite(meta) ? await recomendarPreco(entrada, { meta, cotarEmPreco: vivo.cotarEmPreco }) : null;
    return res.json({
      ok: true, observadoEm: vivo.observadoEm, precoAtual: vivo.precos.vigente,
      precoMudouDesdeAuditoria: auditado.fingerprint && auditado.fingerprint.precoVisto !== null && Math.abs(Number(vivo.precos.vigente) - Number(auditado.fingerprint.precoVisto)) >= 0.01,
      simulacoes: simulacoes.map((s) => ({ preco: s.preco, erro: s.erro || null, resultado: s.contrato ? s.contrato.resultado : null, frete: s.contrato ? s.contrato.componentes.frete : null, comissao: s.contrato ? s.contrato.componentes.comissao : null, bloqueios: s.contrato ? s.contrato.bloqueios : [] })),
      recomendacao: recomendacao ? { ok: recomendacao.ok, preco: recomendacao.preco ?? null, motivo: recomendacao.motivo || null, margemPercent: recomendacao.contrato ? recomendacao.contrato.resultado.margemPercent : null, trilha: recomendacao.trilha } : null,
      metricasMl: ler.metricas,
    });
  } catch (err) {
    console.error("[resgate] simular:", err.message);
    return res.status(500).json({ ok: false, motivo: "Erro ao simular." });
  }
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
    for (const l of linhas) itensPorConta.set(Number(l.cliente_conta_id), await store.lerItens(exec.id, Number(l.cliente_conta_id), { somenteAcionaveis }));
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

module.exports = { visaoGlobal, conta, itens, item, simular, revisar, planoXlsx, dryRun, configurar };
