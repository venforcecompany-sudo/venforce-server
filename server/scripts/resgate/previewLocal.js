#!/usr/bin/env node
// server/scripts/resgate/previewLocal.js
// Preview LOCAL da tela do Resgate sobre o resultado de uma auditoria da CLI
// (store de arquivo). Só 127.0.0.1, só leitura do diretório: nenhum banco,
// nenhum Mercado Livre. Simular/revisar/dry-run respondem 501 aqui (precisam
// do servidor). O Shell é desligado no preview (sem login); com --shell, o
// vf-shell.js REAL é servido com um usuário fictício local e carteira vazia,
// só para ver a tela dentro da moldura do Portal.
//   node server/scripts/resgate/previewLocal.js --dados <dir da auditoria> [--porta 5099] [--shell]
const fs = require("fs");
const path = require("path");
const http = require("http");
const { args } = require("./lib");
const { criarStoreArquivo } = require("../../services/resgate/resgateStoreArquivo");
const { planoDeAtivacao } = require("../../services/resgate/resgateAtivacao");
const { planoParaBuffer } = require("../../services/resgate/resgatePlanoXlsx");
const { montarBancada, passaFiltro, linhaDaLista, metaDe, FILTROS } = require("../../services/resgate/resgateBancada");
const { montarPedidosDoItem, montarDetalhePedido } = require("../../services/resgate/resgatePedidos");
const { simularPreliminar, propostasEmLote, ESTRATEGIAS } = require("../../services/resgate/resgateSimulacaoPreliminar");
// Corpo JSON das POSTs (preview só aceita as que NÃO escrevem: simulação preliminar e propostas).
const lerCorpo = (req) => new Promise((ok) => { let s = ""; req.on("data", (d) => { s += d; if (s.length > 1e6) req.destroy(); }); req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch (_) { ok({}); } }); });

const a = args();
const os = require("os");
const PADRAO = path.join(os.homedir(), "venforce-backups", "handoffs", "resgate_2026-11-12", "auditoria_bancada_e5");
const dir = path.resolve(String(a.dados || PADRAO).replace(/^~(?=\/|$)/, os.homedir()));
// Pasta sem contas/ gerava uma tela com ZERO contas sem explicar: agora recusa com a causa.
(function conferirDados() {
  const c = path.join(dir, "contas");
  const n = fs.existsSync(c) ? fs.readdirSync(c).filter((x) => fs.existsSync(path.join(c, x, "conta.json"))).length : 0;
  if (!n) { console.error(`--dados "${dir}" não tem contas/<id>/conta.json (symlink quebrado ou pasta errada). Use a pasta de uma auditoria, ex.: ${PADRAO}`); process.exit(2); }
})();
const portal = path.resolve(__dirname, "..", "..", "..", "Portal");
const store = criarStoreArquivo(dir);
const porta = Number(a.porta || 5099);
// Pedidos: arquivo local OPCIONAL (--pedidos), extraído da Central de Vendas por leitura. O preview nunca consulta a Central.
const pedidosLocais = a.pedidos ? JSON.parse(fs.readFileSync(path.resolve(String(a.pedidos)), "utf8")) : null;
const cacheItens = new Map();
async function itensDa(id) { if (!cacheItens.has(id)) cacheItens.set(id, await store.lerItens(null, id)); return cacheItens.get(id); }
const exec = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, "execucao.json"), "utf8")); } catch (_) { return { id: "?" }; } };
const json = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  try {
    if (u.pathname === "/resgate/visao-global") {
      const contas = await store.listarContas();
      const e = exec();
      const lista = contas.map((c) => ({ ...c.resumo, matriz: c.matriz }));
      const soma = (k) => lista.reduce((s, c) => s + (Number(c[k]) || 0), 0);
      return json(res, 200, { ok: true, execucao: { id: e.id, status: e.status, iniciadaEm: e.iniciadaEm, finalizadaEm: e.finalizadaEm }, contas: lista,
        totais: { contasAvaliadas: lista.filter((c) => !c.semAvaliacao).length, contasSemAvaliacao: lista.filter((c) => c.semAvaliacao).length, anunciosAuditados: soma("itens"), precosCorretos: soma("precosCorretos"), precisamRevisao: soma("precisamRevisao"), semMargemConfiavel: soma("semMargemConfiavel"), alteradosRecentemente: soma("alteradosRecentemente"), riscoFinanceiro30d: Math.round(soma("riscoFinanceiro30d") * 100) / 100 },
        ativacao: planoDeAtivacao({ contas }) });
    }
    // Preview NUNCA habilita ações reais, mesmo com a flag no ambiente.
    if (u.pathname === "/resgate/config") return json(res, 200, { ok: true, acoesHabilitadas: false, recotacaoSobDemanda: false, simulacaoPreliminar: true, preview: true });
    let m = u.pathname.match(/^\/resgate\/contas\/(\d+)\/itens$/);
    if (m) {
      const q = u.searchParams; const lim = Math.min(100, Number(q.get("limite")) || 50); const pag = Math.max(1, Number(q.get("pagina")) || 1);
      const busca = (q.get("busca") || "").toUpperCase();
      let it = (await itensDa(Number(m[1]))).filter((x) => (!q.get("situacao") || x.situacao === q.get("situacao")) && (!q.get("acao") || x.acao === q.get("acao")) && (!q.get("origem") || x.historico.origem === q.get("origem")) && (q.get("recentes") !== "1" || x.historico.mudancaRecente) && (!busca || [x.itemId, x.sku, x.titulo].some((v) => String(v || "").toUpperCase().includes(busca))));
      const meta = metaDe(q.get("meta")), filtro = FILTROS.includes(q.get("filtro")) ? q.get("filtro") : null;
      if (filtro) it = it.filter((x) => passaFiltro(montarBancada(x, { meta }), filtro));
      it = it.sort((x, y) => y.prioridade - x.prioridade || (x.itemId < y.itemId ? -1 : 1));
      const pg = it.slice((pag - 1) * lim, pag * lim).map((x) => ({ bancada: linhaDaLista(x, montarBancada(x, { meta })), itemId: x.itemId, sku: x.sku, titulo: x.titulo, statusAnuncio: x.statusAnuncio, situacao: x.situacao, acao: x.acao, prioridade: x.prioridade, origem: x.historico.origem, mudancaRecente: x.historico.mudancaRecente, preco: x.contrato.componentes.precoVigente.valor, margemPercent: x.contrato.resultado.margemPercent, margemExibida: x.snapshot && x.snapshot.margemPercent, frete: x.contrato.componentes.frete.valor, freteNivel: x.contrato.componentes.frete.nivel, confianca: x.contrato.confiancaGeral, unidades30d: x.vendas30d.unidades, exposicao: x.exposicao, recomendacao: x.recomendacao, revisao: { status: "PENDENTE" }, precoVisto: x.fingerprint.precoVisto }));
      return json(res, 200, { ok: true, total: it.length, pagina: pag, limite: lim, itens: pg });
    }
    m = u.pathname.match(/^\/resgate\/contas\/(\d+)\/itens\/([^/]+)\/pedidos(?:\/([^/]+))?$/);
    if (m) {
      const contaId = Number(m[1]), itemId = decodeURIComponent(m[2]);
      const x = (await itensDa(contaId)).find((y) => y.itemId === itemId);
      if (!x) return json(res, 404, { ok: false, motivo: "não auditado" });
      const fx = pedidosLocais && pedidosLocais.contas && pedidosLocais.contas[contaId] && pedidosLocais.contas[contaId].itens[itemId];
      if (!fx) return json(res, 501, { ok: false, motivo: pedidosLocais ? "Este anúncio não está no arquivo local de pedidos do preview." : "Preview sem arquivo de pedidos (--pedidos)." });
      const bancada = montarBancada(x, { meta: metaDe(u.searchParams.get("meta")) });
      if (!m[3]) return json(res, 200, { ok: true, ...montarPedidosDoItem({ itemId, rows: fx.rows, bancada, periodo: { ...(fx.periodo || {}), dias: 60, fonte: "arquivo local extraído da Central de Vendas" }, completude: fx.completude || null, snapshot: fx.snapshot || null, totalNoPeriodo: fx.pagination ? fx.pagination.total : null }) });
      const ped = fx.detalhes && fx.detalhes[decodeURIComponent(m[3])];
      return ped ? json(res, 200, { ok: true, ...montarDetalhePedido({ pedido: ped, itemId, bancada }) }) : json(res, 404, { ok: false, motivo: "Pedido fora do arquivo local do preview." });
    }
    m = u.pathname.match(/^\/resgate\/contas\/(\d+)\/itens\/([^/]+)$/);
    if (m) {
      const x = (await itensDa(Number(m[1]))).find((y) => y.itemId === decodeURIComponent(m[2]));
      return x ? json(res, 200, { ok: true, item: x, bancada: montarBancada(x, { meta: metaDe(u.searchParams.get("meta")) }), contexto: { clienteSlug: null, clienteContaId: Number(m[1]), acoesHabilitadas: false, preview: true } })
        : json(res, 404, { ok: false, motivo: "não auditado" });
    }
    m = u.pathname.match(/^\/resgate\/contas\/(\d+)\/itens\/([^/]+)\/simular$/);
    if (m && req.method === "POST") {
      const corpo = await lerCorpo(req);
      if (corpo.preliminar !== true) return json(res, 501, { ok: false, codigo: "RECOTACAO_INDISPONIVEL_NO_PREVIEW", motivo: "Recotação no Mercado Livre indisponível no preview local: a simulação aqui é só preliminar." });
      const x = (await itensDa(Number(m[1]))).find((y) => y.itemId === decodeURIComponent(m[2]));
      return x ? json(res, 200, await simularPreliminar(x, corpo.precos)) : json(res, 404, { ok: false, motivo: "não auditado" });
    }
    m = u.pathname.match(/^\/resgate\/contas\/(\d+)\/propostas$/);
    if (m && req.method === "POST") {
      const corpo = await lerCorpo(req);
      if (!ESTRATEGIAS[corpo.estrategia]) return json(res, 400, { ok: false, motivo: "Estratégia inválida." });
      const ids = new Set((corpo.itemIds || []).map(String).slice(0, 500));
      return json(res, 200, await propostasEmLote((await itensDa(Number(m[1]))).filter((x) => ids.has(x.itemId)), { estrategia: corpo.estrategia, meta: corpo.meta, tetoAumento: corpo.tetoAumento, terminarEm90: corpo.terminarEm90 === true }));
    }
    m = u.pathname.match(/^\/resgate\/(?:contas\/(\d+)\/)?plano\.xlsx$/);
    if (m) {
      let contas = await store.listarContas();
      if (m[1]) contas = contas.filter((c) => Number(c.resumo.clienteContaId) === Number(m[1]));
      const ip = new Map(); for (const c of contas) ip.set(Number(c.resumo.clienteContaId), await itensDa(Number(c.resumo.clienteContaId)));
      res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      return res.end(planoParaBuffer({ contas, itensPorConta: ip, execucao: exec() }));
    }
    if (a.shell && u.pathname === "/me/context") return json(res, 200, { ok: true, clientes: [], squads: [], squadPrincipalId: null });
    if (u.pathname.startsWith("/resgate/")) return json(res, 501, { ok: false, motivo: "Indisponível no preview local (requer o servidor com acesso ao Mercado Livre)." });
    if (u.pathname === "/vf-shell.js" && !a.shell) { res.writeHead(200, { "Content-Type": "text/javascript" }); return res.end("/* shell desligado no preview */"); }
    const arq = path.join(portal, u.pathname === "/" ? "resgate.html" : path.normalize(u.pathname));
    if (!arq.startsWith(portal) || !fs.existsSync(arq)) { res.writeHead(404); return res.end(); }
    let corpo = fs.readFileSync(arq);
    if (arq.endsWith("resgate.html")) {
      const usuario = a.shell ? 'localStorage.setItem("vf-user",JSON.stringify({nome:"Preview Local",role:"user"}));' : "";
      const injetado = `<script>window.VF_API_BASE=location.origin;try{localStorage.setItem("vf-token","preview");${usuario}}catch(e){}</script><script src="resgate.js">`;
      corpo = String(corpo).replace('<script src="resgate.js">', injetado);
      // Shell real: a API do Portal (vf-config) aponta para ESTE preview, nunca para produção.
      if (a.shell) corpo = corpo.replace("<head>", `<head>\n  <meta name="vf-api-base" content="http://127.0.0.1:${porta}">`);
      corpo = Buffer.from(corpo);
    }
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(arq)] || "application/octet-stream" });
    return res.end(corpo);
  } catch (err) { return json(res, 500, { ok: false, motivo: err.message }); }
}).listen(porta, "127.0.0.1", () => console.log(`Resgate (preview local, somente leitura): http://127.0.0.1:${porta}/resgate.html`));
