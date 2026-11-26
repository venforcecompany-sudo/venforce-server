#!/usr/bin/env node
// server/scripts/central-vendas-validar-conta.js
//
// Validação REAL de uma conta durante o rollout (reuso → componentes
// compactos) — SOMENTE LEITURA. Nada é gravado, nenhuma sincronização roda,
// nenhuma flag muda. Usa os LEITORES REAIS do repositório (os mesmos da
// Central, da Margem e do Resgate), então valida o que a tela vai mostrar.
//
//   DATABASE_URL=<URL da raiox_ro> node server/scripts/central-vendas-validar-conta.js \
//     --conta=<cliente_conta_id> [--dias=14] [--saida=relatorio.json]
//
// Para cada import do Sync PUBLICADO da conta nos últimos --dias:
//   C1 pedidos lidos (próprios ∪ vinculados) = pedidosTotal gravado pelo motor; sem repetição
//   C2 Σ componentes por tipo (pedidos no resultado), relida do banco =
//      resumo_json.totaisPorTipo calculado EM MEMÓRIA pelo motor na gravação
//      → prova que nenhum componente sumiu nem duplicou, em qualquer formato
//   C3 ledger por item: Σ dos 5 componentes do resultado = resultado do item
//      (itens calculáveis; propriedade do motor API-first)
//   C4 integridade das linhas compactas (formato, posições alinhadas, dicionário)
//   C5 Resgate: pedidos pagos vistos pelo Resgate = pedidos pagos da Central
// e o retrato dos formatos (linhas antigas × compactas × vínculos) por import.
//
// Permissões: além do que a raiox_ro já tem, exige SELECT em
// central_vendas_pedidos, central_vendas_pedido_itens, central_vendas_componentes
// (e nas tabelas compactas, se existirem) — ver
// docs/banco-de-dados/componentes-v2/raiox_ro_paridade_central.sql. Sem elas
// o script para ANTES de ler qualquer coisa e lista o que falta.
// Segurança: não lê server/.env; imprime o host; sessão READ ONLY verificada.

const fs = require("fs");
const path = require("path");

function lerArgs(argv) {
  const args = {};
  for (const a of argv) { const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a); if (m) args[m[1]] = m[2] === undefined ? true : m[2]; }
  return args;
}
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const TIPOS_RESULTADO = ["receita_produto", "tarifa_venda", "custo_produto", "imposto_interno", "frete_seller"];

async function main() {
  const args = lerArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url || !args.conta) {
    console.error("uso: DATABASE_URL=<raiox_ro> node central-vendas-validar-conta.js --conta=<id> [--dias=14] [--saida=x.json]");
    process.exit(2);
  }
  const conta = Number(args.conta);
  const dias = Number(args.dias || 14);
  console.log(`  banco: host=${new URL(url).hostname} conta=${conta} (somente leitura)`);
  const { Pool } = require(path.join(__dirname, "..", "node_modules", "pg"));
  const ssl = /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false };
  const db = new Pool({ connectionString: url, ssl, max: 1,
    options: "-c default_transaction_read_only=on -c statement_timeout=60000 -c lock_timeout=2000" });
  const { rows: [ro] } = await db.query("SHOW default_transaction_read_only");
  if (ro.default_transaction_read_only !== "on") throw new Error("SESSAO_NAO_READ_ONLY");

  // Permissões ANTES de qualquer leitura de dado.
  const { rows: [perm] } = await db.query(
    `SELECT has_table_privilege(current_user, 'public.central_vendas_pedidos', 'SELECT') AS pedidos,
            has_table_privilege(current_user, 'public.central_vendas_pedido_itens', 'SELECT') AS itens,
            has_table_privilege(current_user, 'public.central_vendas_componentes', 'SELECT') AS componentes,
            to_regclass('public.central_vendas_pedido_componentes') IS NULL
              OR (has_table_privilege(current_user, 'public.central_vendas_pedido_componentes', 'SELECT')
                  AND has_table_privilege(current_user, 'public.central_vendas_componente_textos', 'SELECT')) AS compactos,
            to_regclass('public.central_vendas_import_pedidos') IS NULL
              OR has_table_privilege(current_user, 'public.central_vendas_import_pedidos', 'SELECT') AS vinculos`);
  const faltam = Object.entries(perm).filter(([, v]) => !v).map(([k]) => k);
  if (faltam.length) {
    console.error(`  GRANT_INSUFICIENTE: falta SELECT em ${faltam.join(", ")} — ver docs/banco-de-dados/componentes-v2/raiox_ro_paridade_central.sql`);
    await db.end();
    process.exit(4);
  }

  const repo = require("../services/centralVendas/centralVendasRepository");
  const cc = require("../services/centralVendas/centralVendasComponentesCompactos");
  const pc = require("../services/centralVendas/centralVendasPedidosCompartilhados");
  const { pedidoEntraNoResultado } = require("../services/centralVendas/centralVendasService");
  const resgate = require("../services/resgate/resgateLeituraRepository");

  const temCompactos = await cc.tabelaCompactaDisponivel(db);
  const temVinculos = await pc.tabelaVinculosDisponivel(db);
  const { rows: imports } = await db.query(
    `SELECT id, competencia, cliente_slug, publication_status, created_at, resumo_json
       FROM central_vendas_imports
      WHERE cliente_conta_id = $1 AND fonte = 'orders_api' AND publication_status = 'published'
        AND created_at >= now() - ($2::int * interval '1 day')
      ORDER BY id DESC`, [conta, dias]);

  const relatorio = { conta, dias, tabelas: { vinculos: temVinculos, compactos: temCompactos }, imports: [], problemas: [] };
  const problema = (importId, codigo, detalhe) => relatorio.problemas.push({ importId, codigo, ...detalhe });

  for (const imp of imports) {
    const resumo = imp.resumo_json || {};
    // eslint-disable-next-line no-await-in-loop
    const carga = await repo.loadPedidosByImportIds({ importIds: [imp.id], dateFrom: "1900-01-01", dateTo: "2999-12-31" }, db);
    const rowIds = carga.pedidos.map((p) => String(p.id));
    // C1
    const distintos = new Set(rowIds).size;
    if (distintos !== rowIds.length) problema(imp.id, "C1_PEDIDO_REPETIDO", { lidos: rowIds.length, distintos });
    // pedidos sem data_pedido não entram no intervalo de leitura: contados à parte.
    // eslint-disable-next-line no-await-in-loop
    const { rows: [semData] } = await db.query(
      `SELECT count(*)::int AS n FROM ${pc.fontePedidosSql("$1", { comVinculos: temVinculos })} JOIN central_vendas_pedidos p ON p.id = fp.pedido_row_id WHERE p.data_pedido IS NULL`, [[imp.id]]);
    if (resumo.pedidosTotal != null && distintos + semData.n !== Number(resumo.pedidosTotal)) {
      problema(imp.id, "C1_PEDIDOS_DIVERGEM_DO_MOTOR", { lidos: distintos, semData: semData.n, motor: Number(resumo.pedidosTotal) });
    }
    // C2
    const noResultado = new Set(carga.pedidos.filter(pedidoEntraNoResultado).map((p) => String(p.id)));
    const somas = {};
    for (const c of carga.componentes) {
      if (!noResultado.has(String(c.pedido_row_id)) || c.valor === null) continue;
      somas[c.tipo] = (somas[c.tipo] || 0) + Number(c.valor);
    }
    const esperado = resumo.totaisPorTipo || null;
    if (esperado) {
      for (const tipo of Object.keys(esperado)) {
        const lido = round2(somas[tipo] || 0);
        if (Math.abs(lido - Number(esperado[tipo])) > 0.005) problema(imp.id, "C2_TOTAL_POR_TIPO_DIVERGE", { tipo, lido, motor: Number(esperado[tipo]) });
      }
    }
    // C3
    let itensConferidos = 0;
    const porItem = new Map();
    for (const c of carga.componentes) {
      if (c.item_row_id == null || !TIPOS_RESULTADO.includes(c.tipo)) continue;
      const k = String(c.item_row_id);
      if (!porItem.has(k)) porItem.set(k, []);
      porItem.get(k).push(c);
    }
    for (const item of carga.itens) {
      const cs = porItem.get(String(item.id)) || [];
      if (item.resultado === null || cs.length !== TIPOS_RESULTADO.length || cs.some((c) => c.valor === null)) continue;
      itensConferidos += 1;
      const soma = round2(cs.reduce((s, c) => s + Number(c.valor), 0));
      if (Math.abs(soma - Number(item.resultado)) > 0.005 && relatorio.problemas.length < 200) {
        problema(imp.id, "C3_LEDGER_ITEM_DIVERGE", { itemRowId: item.id, soma, resultado: Number(item.resultado) });
      }
    }
    // Formatos + C4
    const formato = { pedidos: distintos, componentesLinhas: 0, pedidosCompactos: 0, componentesCompactos: 0, vinculados: 0 };
    formato.componentesLinhas = carga.componentes.filter((c) => c.id != null).length;
    formato.componentesCompactos = carga.componentes.filter((c) => c.id == null).length;
    if (temVinculos) {
      // eslint-disable-next-line no-await-in-loop
      formato.vinculados = (await db.query(`SELECT count(*)::int AS n FROM ${pc.TABELA} WHERE import_id = $1`, [imp.id])).rows[0].n;
    }
    if (temCompactos && rowIds.length) {
      // eslint-disable-next-line no-await-in-loop
      const { rows: crus } = await db.query(cc.sqlCompactosCrus("pc.pedido_row_id = ANY($1::bigint[])"), [rowIds]);
      formato.pedidosCompactos = crus.length;
      for (const r of crus) {
        try { cc.validarLinhaCompacta(cc.lerLinhaCrua(r)); } catch (err) { problema(imp.id, "C4_COMPACTO_CORROMPIDO", { erro: err.message }); }
      }
    }
    relatorio.imports.push({ importId: Number(imp.id), competencia: imp.competencia, criadoEm: imp.created_at, formato, itensConferidosLedger: itensConferidos });
  }

  // C5 — Resgate × Central no import vigente por competência.
  const competencias = [...new Set(imports.map((i) => i.competencia))];
  if (competencias.length) {
    const vig = await resgate.importsCanonicos(db, { clienteContaId: conta, competencias });
    const desde = "1900-01-01";
    const r = await resgate.vendasResumoConta(db, { clienteContaId: conta, desde, competencias });
    const carga = await repo.loadPedidosByImportIds({ importIds: vig.map((v) => v.id), dateFrom: desde, dateTo: "2999-12-31" }, db);
    const itensPorPedido = new Set(carga.itens.map((i) => String(i.pedido_row_id)));
    const pagos = new Set(carga.pedidos.filter((p) => p.status === "paid" && itensPorPedido.has(String(p.id))).map((p) => p.pedido_id));
    relatorio.resgate = { pedidosResgate: r.pedidos, pedidosPagosCentral: pagos.size };
    if (r.pedidos !== pagos.size) problema(null, "C5_RESGATE_DIVERGE_DA_CENTRAL", relatorio.resgate);
  }
  relatorio.leitura = { ...cc.estatisticas };
  relatorio.veredito = relatorio.problemas.length ? "NO_GO" : "GO";
  if (args.saida) fs.writeFileSync(args.saida, JSON.stringify(relatorio, null, 2));
  console.log(JSON.stringify({ ...relatorio, problemas: relatorio.problemas.slice(0, 20) }, null, 2));
  await db.end();
  process.exit(relatorio.veredito === "GO" ? 0 : 3);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
