#!/usr/bin/env node
// server/scripts/resgate/inventarioContas.js
// INVENTÁRIO de todas as contas Mercado Livre do VenForce — SOMENTE LEITURA.
// Sem --executar: imprime o plano (nenhum acesso). Com --executar: SELECTs em
// sessão read-only (default_transaction_read_only=on, statement_timeout 15 s),
// uma conta por vez. Nenhuma chamada ao Mercado Livre. Nenhum token lido.
//   node server/scripts/resgate/inventarioContas.js --executar --saida <dir> [--dias 30] [--horas-antigo 48]
const fs = require("fs");
const path = require("path");
const { args, abrirBancoSomenteLeitura } = require("./lib");

const a = args();
if (!a.executar) {
  console.log("PLANO (nada foi acessado):");
  console.log("  1. cliente_contas (marketplace=meli) + clientes + existência de grant (sem ler token)");
  console.log("  2. contagens por conta: meli_anuncios, margin_projection_snapshots (frete avaliado/estimado/desconhecido, sem custo, antigos)");
  console.log("  3. eventos de preço do VenForce (activity_logs, margem_precificacao_aplicacoes) agregados por conta");
  console.log("  4. vendas pagas dos últimos N dias (Central de Vendas, import publicado canônico por competência)");
  console.log("  5. flags de frete do ambiente LOCAL (o valor do Render precisa ser informado em --flags-render)");
  process.exit(0);
}

(async () => {
  const repo = require("../../services/resgate/resgateLeituraRepository");
  const { freteConfiavelHabilitado } = require("../../services/shared/freteCotacaoConfiavel");
  const { competenciasJanela } = repo;
  const db = await abrirBancoSomenteLeitura();
  const dias = Number(a.dias || 30), horas = Number(a["horas-antigo"] || 48);
  const agora = new Date();
  // Flags de PRODUÇÃO não estão neste processo: informe-as explicitamente (copiadas do Render).
  const flags = { FRETE_COTACAO_CONFIAVEL_SELLERS: a["sellers-liberados"] || process.env.FRETE_COTACAO_CONFIAVEL_SELLERS || "", FRETE_LEGADO_BLOQUEAR_CONTAS: a["contas-legado"] || process.env.FRETE_LEGADO_BLOQUEAR_CONTAS || "" };
  const contas = await repo.listarContasMeli(db);
  const ids = contas.map((c) => c.clienteContaId);
  const resumo = await repo.resumoPorConta(db, ids);
  const antigos = await repo.snapshotsAntigos(db, { contaIds: ids, horas });
  const eventos = await repo.eventosPorConta(db, { desde: new Date(agora.getTime() - 120 * 86400000).toISOString() });
  const desde = new Date(agora.getTime() - dias * 86400000).toISOString().slice(0, 10);
  const linhas = [];
  for (const c of contas) {
    const r = resumo.get(c.clienteContaId) || {};
    const v = (r.anuncios || r.snapshots) ? await repo.vendasResumoConta(db, { clienteContaId: c.clienteContaId, desde, competencias: competenciasJanela(agora, dias) }) : { pedidos: 0, unidades: 0, faturamento: 0, itensVendidos: 0, cobertura: null };
    const sn = r.snapshots || 0;
    // Flag de produção não é visível daqui: liga se informada OU se há linhas avaliadas no banco (evidência).
    const liberadaFlag = freteConfiavelHabilitado(c.sellerId, flags);
    const liberada = liberadaFlag || (r.freteAvaliado || 0) > 0;
    const pct = (x) => (sn ? Math.round(((x || 0) / sn) * 1000) / 10 : null);
    const fqObj = r.freteAvaliado || 0;
    linhas.push({
      clienteId: c.clienteId, cliente: c.clienteNome, clienteContaId: c.clienteContaId, conta: c.contaNome, sellerId: c.sellerId, ativa: c.ativo,
      grantMl: c.temGrant ? (c.grantStatus || "sim") : "sem grant",
      anuncios: r.anuncios || 0, ativos: r.ativos || 0, logisticas: r.logisticas || [],
      cotador: "shared/buscarComissaoEFrete (snapshot do Motor)", avaliacaoFrete: liberadaFlag ? "LIGADA (flag informada)" : liberada ? "LIGADA (inferida: há snapshots avaliados)" : "desligada",
      bloqueioLegado: String(flags.FRETE_LEGADO_BLOQUEAR_CONTAS).split(",").map((x) => x.trim()).includes(String(c.clienteContaId)),
      snapshots: sn, snapshotsAntigos: antigos.get(c.clienteContaId) || 0, snapshotsFalhos: r.failed || 0, calculoMaisRecente: r.calculoMaisRecente || null,
      freteAvaliadoPct: pct(fqObj), freteCotadoVerificadoPct: pct(r.freteCotado), freteEstimadoPct: pct(r.freteEstimado), freteDesconhecidoPct: pct(r.freteDesconhecido),
      freteNaoVerificadoPct: sn ? Math.round(((sn - fqObj - (r.freteDesconhecido || 0)) / sn) * 1000) / 10 : null,
      semCustoPct: pct(r.semCusto), comMargemPct: pct(r.comMargem),
      historicoPreco: eventos.get(String(c.clienteContaId)) || {},
      vendas: v,
      // Exposição POTENCIAL = faturamento recente cuja margem não foi verificada pela avaliação do frete.
      exposicaoPotencial30d: liberada ? Math.round(v.faturamento * ((r.freteDesconhecido || 0) / (sn || 1)) * 100) / 100 : v.faturamento,
    });
  }
  linhas.sort((x, y) => y.vendas.faturamento - x.vendas.faturamento || y.anuncios - x.anuncios);
  const out = { geradoEm: agora.toISOString(), janelaVendasDias: dias, flagsConsideradas: flags, contas: linhas,
    totais: { contas: linhas.length, comAnuncios: linhas.filter((l) => l.anuncios > 0).length, comSnapshots: linhas.filter((l) => l.snapshots > 0).length, comVendas: linhas.filter((l) => l.vendas.unidades > 0).length,
      anuncios: linhas.reduce((s, l) => s + l.anuncios, 0), ativos: linhas.reduce((s, l) => s + l.ativos, 0), faturamento30d: Math.round(linhas.reduce((s, l) => s + l.vendas.faturamento, 0) * 100) / 100 } };
  const dir = a.saida || ".";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "inventario_contas.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.totais));
  await db.end();
})().then(() => process.exit(0)).catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
