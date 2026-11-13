#!/usr/bin/env node
// server/scripts/resgate/enriquecerPromocoes.js
//
// Enriquecimento LOCAL do resultado da auditoria com evidência já coletada:
//   · financiamento da promoção (leituras GET de /seller-promotions já gravadas
//     em JSONL e/ou export do Promo Snapshot da conta) → item.promocaoFinanciamento;
//   · recotação do preço sugerido (JSONL da recotação controlada) → item.recotacao;
//   · item.bancadaIndice (mesmas regras da bancada) para o SQL filtrar.
// Nenhum banco, nenhum Mercado Livre. NUNCA altera a pasta de origem: escreve em
// --saida (contas sem evidência viram links simbólicos para a origem, só leitura).
//
//   node server/scripts/resgate/enriquecerPromocoes.js --dados <auditoria> --saida <nova pasta>
//        [--promo <leituras.jsonl>] [--snapshot <conta>:<export.json>] [--recotacao <recotacao.jsonl>]
//
// Formatos: leituras = {conta,itemId,lidoEm,promoStatus,iniciadas[],salePrice?} por linha;
// snapshot = [{item,pid,tipo,pf,po,mp,sp,status,ativa}]; recotação = saída da recotação controlada.
const fs = require("fs");
const path = require("path");
const { args } = require("./lib");
const { classificarFinanciamento } = require("../../services/resgate/resgatePromocaoFinanciamento");
const { indiceBancada, normalizarRecotacao, montarBancada, STATUS } = require("../../services/resgate/resgateBancada");

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const lerJsonl = (f) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

function carregarEvidencias({ promo, snapshot, recotacao }) {
  const leituras = new Map(), snap = new Map(), rec = new Map();
  if (promo) for (const x of lerJsonl(promo)) leituras.set(`${x.conta}:${x.itemId}`, x);
  for (const s of [].concat(snapshot || [])) {
    const [conta, arq] = String(s).split(/:(.+)/);
    for (const p of JSON.parse(fs.readFileSync(arq, "utf8"))) {
      if (!["started", "active"].includes(p.status) || p.ativa !== true) continue;
      const k = `${conta}:${p.item}`;
      if (!snap.has(k)) snap.set(k, { fonte: `Promo Snapshot da conta (${path.basename(arq)})`, iniciadas: [] });
      snap.get(k).iniciadas.push({ id: p.pid, type: p.tipo, price: num(p.pf), original_price: num(p.po), meli_percentage: num(p.mp), seller_percentage: num(p.sp) });
    }
  }
  if (recotacao) for (const x of lerJsonl(recotacao)) rec.set(`${x.conta}:${x.itemId}`, x);
  return { leituras, snap, rec };
}

/** Financiamento de UM item a partir da evidência (leitura direta tem precedência sobre o snapshot). */
function financiamentoDoItem(conta, x, ev) {
  const k = x.contrato && x.contrato.componentes;
  if (!k) return null;
  const vigente = num(k.precoVigente.valor), cheio = num(k.precoCheio.valor);
  if (!(cheio !== null && vigente !== null && cheio > vigente + 0.001)) return null;
  const lido = ev.leituras.get(`${conta}:${x.itemId}`);
  if (lido) return { ...classificarFinanciamento({ iniciadas: lido.iniciadas, salePrice: lido.salePrice, vigente, cheio, promoStatus: lido.promoStatus,
    fonte: `Leitura ao ML em ${String(lido.lidoEm).slice(0, 16).replace("T", " ")} UTC (GET /seller-promotions)` }), lidoEm: lido.lidoEm };
  const s = ev.snap.get(`${conta}:${x.itemId}`);
  if (s) return classificarFinanciamento({ iniciadas: s.iniciadas, vigente, cheio, fonte: s.fonte });
  return null;
}

function enriquecerConta({ origem, saida, conta, ev }) {
  const dirO = path.join(origem, "contas", String(conta)), dirS = path.join(saida, "contas", String(conta));
  const m = new Map();
  for (const l of fs.readFileSync(path.join(dirO, "itens.jsonl"), "utf8").split("\n")) if (l.trim()) { const x = JSON.parse(l); m.set(x.itemId, x); } // última versão vence
  fs.mkdirSync(dirS, { recursive: true });
  const cont = { itens: 0, comFinanciamento: 0, comRecotacao: 0, porStatus: {} };
  const linhas = [];
  for (const x of m.values()) {
    const f = financiamentoDoItem(conta, x, ev);
    const q = ev.rec.get(`${conta}:${x.itemId}`);
    const y = { ...x };
    if (f) { y.promocaoFinanciamento = f; cont.comFinanciamento++; }
    if (q) { y.recotacao = normalizarRecotacao(q); cont.comRecotacao++; }
    y.bancadaIndice = indiceBancada(y);
    const st = montarBancada(y).status; cont.porStatus[st] = (cont.porStatus[st] || 0) + 1;
    linhas.push(JSON.stringify(y)); cont.itens++;
  }
  fs.writeFileSync(path.join(dirS, "itens.jsonl"), linhas.join("\n") + "\n");
  const contaJson = JSON.parse(fs.readFileSync(path.join(dirO, "conta.json"), "utf8"));
  contaJson.resumo = { ...contaJson.resumo, bancada: { porStatusNaMetaDoItem: cont.porStatus, comFinanciamento: cont.comFinanciamento, comRecotacao: cont.comRecotacao, enriquecidoEm: new Date().toISOString() } };
  fs.writeFileSync(path.join(dirS, "conta.json"), JSON.stringify(contaJson, null, 2));
  return cont;
}

function main() {
  const a = args();
  if (!a.dados || !a.saida) { console.error("Uso: --dados <auditoria> --saida <nova pasta> [--promo f.jsonl] [--snapshot conta:f.json] [--recotacao f.jsonl]"); process.exit(2); }
  const origem = path.resolve(a.dados), saida = path.resolve(a.saida);
  if (saida === origem || saida.startsWith(origem + path.sep)) { console.error("A saída não pode ser a pasta de origem (nem estar dentro dela)."); process.exit(2); }
  if (fs.existsSync(saida) && fs.readdirSync(saida).length) { console.error(`A pasta de saída já existe e não está vazia: ${saida}`); process.exit(2); }
  const ev = carregarEvidencias({ promo: a.promo, snapshot: a.snapshot, recotacao: a.recotacao });
  const contasComEvidencia = new Set([...ev.leituras.keys(), ...ev.snap.keys(), ...ev.rec.keys()].map((k) => k.split(":")[0]));
  fs.mkdirSync(path.join(saida, "contas"), { recursive: true });
  fs.copyFileSync(path.join(origem, "execucao.json"), path.join(saida, "execucao.json"));
  const relatorio = { origem, saida, contas: {} };
  for (const id of fs.readdirSync(path.join(origem, "contas"))) {
    if (contasComEvidencia.has(id) && fs.existsSync(path.join(origem, "contas", id, "itens.jsonl"))) relatorio.contas[id] = enriquecerConta({ origem, saida, conta: Number(id), ev });
    else fs.symlinkSync(path.join(origem, "contas", id), path.join(saida, "contas", id), "dir");
  }
  fs.writeFileSync(path.join(saida, "ENRIQUECIMENTO.json"), JSON.stringify({ ...relatorio, em: new Date().toISOString(), fontes: { promo: a.promo || null, snapshot: a.snapshot || null, recotacao: a.recotacao || null } }, null, 2));
  console.log(JSON.stringify(relatorio, null, 1));
}

if (require.main === module) main();
module.exports = { carregarEvidencias, financiamentoDoItem, enriquecerConta, STATUS };
