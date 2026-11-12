#!/usr/bin/env node
// server/scripts/resgate/auditoriaGlobal.js
// AUDITORIA GLOBAL do VenForce Resgate, fora do servidor, SOMENTE LEITURA:
//  · PostgreSQL em sessão read-only (abortado se aceitar escrita);
//  · Mercado Livre só por GET, SEM renovar token (noRefresh): um token vencido
//    vira "sem avaliação ao vivo" para aquele item — o processo local nunca
//    renova o grant de produção;
//  · resultados em arquivos (store de arquivo), retomável e cancelável (Ctrl+C);
//  · uma conta por vez; camada ao vivo limitada a N anúncios por conta.
//
//   node server/scripts/resgate/auditoriaGlobal.js --executar --saida <dir> [--contas 86,87] [--ao-vivo 15]
//        [--metas metas.json] [--xlsx] [--intervalo-ms 150]
const fs = require("fs");
const path = require("path");
const { args, abrirBancoSomenteLeitura } = require("./lib");

const a = args();
if (!a.executar) {
  console.log("PLANO (nada foi acessado). Com --executar:");
  console.log("  · lista as contas ML; para cada conta (uma por vez): snapshots + cadastro em páginas de 300, vendas pagas 30 d, eventos de preço 120 d");
  console.log("  · classifica TODOS os anúncios (contrato, histórico, situação, exposição, prioridade)");
  console.log("  · --ao-vivo N: GET no ML dos N anúncios mais prioritários por conta (item, sale_price, prices, seller-promotions, listing_prices, shipping_options; pedidos/envios só quando a avaliação de frete pede)");
  console.log("  · grava em <saida>/contas/<id>/ ; gera relatório e XLSX com --xlsx. Nenhuma escrita em banco ou no ML.");
  process.exit(0);
}

(async () => {
  const saida = path.resolve(a.saida || "resgate_saida");
  const { criarStoreArquivo } = require("../../services/resgate/resgateStoreArquivo");
  const store = criarStoreArquivo(saida);
  if (!store.adquirirLock()) { console.error("Outra auditoria está rodando neste diretório."); process.exit(3); }
  const ctrl = new AbortController();
  process.on("SIGINT", () => { console.error("\nCancelando com segurança (checkpoint salvo)…"); ctrl.abort(); });

  const db = await abrirBancoSomenteLeitura();
  const repo = require("../../services/resgate/resgateLeituraRepository");
  const { auditarCarteira } = require("../../services/resgate/resgateAuditoriaService");
  const { criarFetchSomenteLeitura } = require("../../services/resgate/resgateAoVivo");
  const { planoParaBuffer } = require("../../services/resgate/resgatePlanoXlsx");
  const { planoDeAtivacao } = require("../../services/resgate/resgateAtivacao");

  let contas = await repo.listarContasMeli(db);
  if (a.contas) { const ids = String(a.contas).split(",").map(Number); contas = contas.filter((c) => ids.includes(c.clienteContaId)); }
  // Prioriza contas com mais vendas recentes (inventário prévio, se existir no diretório).
  try {
    const inv = JSON.parse(fs.readFileSync(path.join(a.inventario || path.join(saida, "..", "inventario_contas.json")), "utf8"));
    const fat = new Map(inv.contas.map((c) => [c.clienteContaId, c.vendas ? c.vendas.faturamento : 0]));
    contas.sort((x, y) => (fat.get(y.clienteContaId) || 0) - (fat.get(x.clienteContaId) || 0));
  } catch (_) { /* sem inventário: ordem por id */ }

  const metas = a.metas ? JSON.parse(fs.readFileSync(a.metas, "utf8")) : {};
  const nAoVivo = Number(a["ao-vivo"] || 0);
  const execucaoId = await store.iniciarExecucao({ id: `resgate-${new Date().toISOString().slice(0, 10)}`, contas: contas.map((c) => c.clienteContaId), aoVivo: nAoVivo, modo: "somente_leitura" });
  const metricasGlobais = { chamadas: 0, status429: 0, erros: 0 };
  const inicio = Date.now();
  const resultados = [];
  for (const conta of contas) {
    if (ctrl.signal.aborted) break;
    const ler = nAoVivo > 0 ? criarFetchSomenteLeitura({ noRefresh: true, minIntervalMs: Number(a["intervalo-ms"] || 150), signal: ctrl.signal }) : null;
    const t0 = Date.now();
    const [r] = await auditarCarteira({ db, contas: [conta], store, execucaoId, opcoes: { metas, signal: ctrl.signal, aoVivo: { ativo: nAoVivo > 0, maxItens: nAoVivo, concorrencia: 2, ler } } });
    if (ler) for (const k of Object.keys(metricasGlobais)) metricasGlobais[k] += ler.metricas[k] || 0;
    resultados.push(r);
    const rs = r.resumo || {};
    console.log(`conta ${conta.clienteContaId} ${r.status}${r.motivo ? ` (${r.motivo})` : ""} itens=${rs.itens ?? 0} revisar=${rs.precisamRevisao ?? "-"} semMargem=${rs.semMargemConfiavel ?? "-"} ${(Date.now() - t0) / 1000}s${ler ? ` ml=${ler.metricas.chamadas}/429=${ler.metricas.status429}` : ""}`);
  }
  const status = ctrl.signal.aborted ? "cancelada" : "concluida";
  const contasSalvas = await store.listarContas();
  const ativacao = planoDeAtivacao({ contas: contasSalvas });
  fs.writeFileSync(path.join(saida, "plano_ativacao.json"), JSON.stringify(ativacao, null, 2));
  await store.finalizarExecucao(execucaoId, status, { duracaoS: Math.round((Date.now() - inicio) / 1000), contas: resultados.length, ml: metricasGlobais });
  if (a.xlsx) {
    const itensPorConta = new Map();
    for (const c of contasSalvas) itensPorConta.set(Number(c.resumo.clienteContaId), await store.lerItens(execucaoId, c.resumo.clienteContaId));
    const exec = JSON.parse(fs.readFileSync(path.join(saida, "execucao.json"), "utf8"));
    fs.writeFileSync(path.join(saida, "VENFORCE_RESGATE_plano.xlsx"), planoParaBuffer({ contas: contasSalvas, itensPorConta, execucao: exec }));
  }
  console.log(JSON.stringify({ status, contas: resultados.length, ml: metricasGlobais, saida }));
  store.liberarLock();
  await db.end();
})().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", e.stack || e.message); process.exit(1); });
