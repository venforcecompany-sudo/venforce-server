#!/usr/bin/env node
// server/scripts/poc-componentes-v2/bench-leitura.cjs
//
// Benchmark de LEITURA de ponta a ponta, pelo código real dos leitores, nos 4
// modos de persistência: linhas (enxuta, sem reuso — o melhor da main sem
// reuso), compacto, reuso (enxuta + reuso — o melhor da main) e
// reuso_compacto. SÓ PostgreSQL LOCAL, dados sintéticos (cenario.js no motor real).
//
//   POC_DATABASE_URL=postgres://vf@127.0.0.1:57661/postgres \
//     PEDIDOS_POR_DIA=150 NOITES=20 [REPETICOES=7] [SAIDA=x.json] \
//     node --expose-gc server/scripts/poc-componentes-v2/bench-leitura.cjs
//
// Modos com reuso gravam TODAS as noites (o reuso só existe com histórico);
// modos sem reuso gravam só o snapshot final (a leitura só vê o vigente), o que
// mantém a escala "conta grande" viável sem mudar o que é lido.
// Mede por leitor: tempo (mediana), CPU do Node (user+sys), heap retido pelo
// resultado; e, nas consultas de componentes, buffers lidos pelo PostgreSQL
// (EXPLAIN ANALYZE BUFFERS). Confere que os 4 modos devolvem o mesmo resultado.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MODOS = (process.env.MODOS || "linhas,compacto,reuso,reuso_compacto").split(",");
const NOITES = Number(process.env.NOITES || 20);
const PEDIDOS_POR_DIA = Number(process.env.PEDIDOS_POR_DIA || 150);
const REPETICOES = Number(process.env.REPETICOES || 7);
const SERVER = path.join(__dirname, "..", "..");
const REUSO = (m) => m.startsWith("reuso");
const COMPACTO = (m) => m.endsWith("compacto");

function mediana(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
async function medir(fn, n = REPETICOES) {
  let resultado = await fn(); // aquecimento
  const ts = []; const cpus = [];
  for (let i = 0; i < n; i++) {
    const c0 = process.cpuUsage(); const t0 = process.hrtime.bigint();
    resultado = await fn();
    ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
    const c = process.cpuUsage(c0); cpus.push((c.user + c.system) / 1000);
  }
  // Heap retido pelo resultado (o que a requisição segura até responder).
  resultado = null; global.gc && global.gc();
  const h0 = process.memoryUsage().heapUsed;
  let guardado = await fn();
  global.gc && global.gc();
  const heapMB = (process.memoryUsage().heapUsed - h0) / 1048576;
  guardado = null; // eslint-disable-line no-unused-vars
  return { ms: Number(mediana(ts).toFixed(1)), cpuMs: Number(mediana(cpus).toFixed(1)), heapRetidoMB: Number(heapMB.toFixed(2)) };
}

async function filho({ url, modo }) {
  process.env.DATABASE_URL = url;
  for (const k of ["CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS", "CENTRAL_VENDAS_SYNC_REUSO_CONTAS", "CENTRAL_VENDAS_COMPONENTES_COMPACTOS", "CENTRAL_VENDAS_COMPONENTES_COMPACTOS_CONTAS"]) delete process.env[k];
  process.env.CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA = "true";
  if (REUSO(modo)) { process.env.CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS = "true"; process.env.CENTRAL_VENDAS_SYNC_REUSO_CONTAS = "5"; }
  if (COMPACTO(modo)) { process.env.CENTRAL_VENDAS_COMPONENTES_COMPACTOS = "true"; process.env.CENTRAL_VENDAS_COMPONENTES_COMPACTOS_CONTAS = "5"; }

  const pool = require(path.join(SERVER, "config", "database"));
  const repo = require(path.join(SERVER, "services/centralVendas/centralVendasRepository"));
  const cc = require(path.join(SERVER, "services/centralVendas/centralVendasComponentesCompactos"));
  const { buildMotorFromOrders, buildCostMap, coverageParaCompetencia } = require(path.join(SERVER, "services/centralVendas/centralVendasSyncService"));
  const { buildResumoCentralVendas } = require(path.join(SERVER, "services/centralVendas/centralVendasImportService"));
  const svc = require(path.join(SERVER, "services/centralVendas/centralVendasService"));
  const margem = require(path.join(SERVER, "services/motorMargem/adapters/centralVendasEvidenceAdapter"));
  const c360 = require(path.join(SERVER, "services/centralVendas/centralVendasCliente360Adapter"));
  const resgate = require(path.join(SERVER, "services/resgate/resgateLeituraRepository"));
  const cen = require("./cenario");

  const helper = fs.readFileSync(path.join(SERVER, "tests", "helpers", "centralVendasRetencaoPostgres.js"), "utf8");
  await pool.query(helper.split("const FIXTURES = `")[1].split("`;")[0]);
  await pool.query(fs.readFileSync(path.join(SERVER, "sql", "central_vendas_schema.sql"), "utf8"));
  if (REUSO(modo)) await pool.query(fs.readFileSync(path.join(SERVER, "sql/migrations/20261111_central_vendas_import_pedidos.sql"), "utf8"));
  if (COMPACTO(modo)) await pool.query(fs.readFileSync(path.join(SERVER, "sql/migrations/20261126_central_vendas_pedido_componentes.sql"), "utf8"));

  const cliente = { id: 1, slug: "loja", nome: "Loja" };
  const costMap = buildCostMap(cen.costMapEntradas());
  const noites = REUSO(modo) ? Array.from({ length: NOITES }, (_, i) => i + 1) : [NOITES];
  let msEscrita = 0;
  for (const noite of noites) {
    const orders = cen.ordersDaNoite(noite, { pedidosPorDia: PEDIDOS_POR_DIA });
    const motor = buildMotorFromOrders({ orders, costMap, freteMap: cen.freteDaNoite(orders, noite), packsIncompletos: cen.packsIncompletosDaNoite(orders), clienteSlug: "loja", competencia: "2026-09" });
    const dateTo = `2026-09-${String(noite).padStart(2, "0")}`;
    const { rows: [run] } = await pool.query(
      `INSERT INTO central_vendas_sync_runs (cliente_id, cliente_slug, cliente_conta_id, marketplace, date_from, date_to, status)
       VALUES (1, 'loja', 5, 'meli', '2026-09-01', $1, 'completed') RETURNING id`, [dateTo]);
    const resumo = { ...buildResumoCentralVendas(motor), syncRunId: Number(run.id) };
    const { coverageFrom, coverageTo } = coverageParaCompetencia("2026-09", "2026-09-01", dateTo);
    const t0 = Date.now();
    await repo.persistCentralVendasImport({ cliente, marketplace: "meli", competencia: "2026-09", fonte: "orders_api",
      motorPayload: { ...motor, resumo }, resumo, clienteContaId: 5, syncRunId: Number(run.id), publicationStatus: "candidate",
      coverageDateFrom: coverageFrom, coverageDateTo: coverageTo });
    msEscrita += Date.now() - t0;
    await repo.promoverCandidatesDoRun(Number(run.id));
  }
  await pool.query("VACUUM ANALYZE");

  const dateTo = `2026-09-${String(NOITES).padStart(2, "0")}`;
  const range = { clienteSlug: "loja", dateFrom: "2026-09-01", dateTo, clienteContaId: 5 };
  const { importIds, imports } = await repo.resolveImportsForRange(range);
  const carga = await repo.loadPedidosByImportIds({ importIds, dateFrom: range.dateFrom, dateTo });
  const ids = carga.pedidos.map((p) => p.id);
  const amostraDetalhe = ids.filter((_, i) => i % Math.max(1, Math.floor(ids.length / 30)) === 0).slice(0, 30);

  const leitores = {
    central_carga: () => repo.getCentralVendasByRange(range),
    central_payload: async () => svc.buildPayloadFromRange(cliente, range, await repo.getCentralVendasByRange(range)),
    agregacoes: async () => {
      const snap = await repo.getCentralVendasByRange(range);
      const pedidos = svc.buildPedidos(snap);
      return { diario: svc.buildDiario(pedidos), abc: svc.buildAbcProdutos(pedidos) };
    },
    detalhe_30_pedidos: async () => {
      const out = [];
      for (const rowId of amostraDetalhe) {
        // eslint-disable-next-line no-await-in-loop
        const d = await repo.getPedidoDetailByRowId({ importIds, dateFrom: range.dateFrom, dateTo, rowId });
        out.push(svc.buildPedidoContrato(d.pedido, d.itens, d.componentes));
      }
      return out;
    },
    margem_realizado: async () => margem.agregarPorMlb(await margem.carregarVendasDoPeriodo(range)),
    cliente360: async () => { const c = await c360.carregarPedidosEItens(importIds, pool); return c360.consolidarCentral({ imports, pedidos: c.pedidos, itens: c.itens }); },
    resgate: async () => {
      const v = await resgate.vendasPorItem(pool, { clienteContaId: 5, desde: "2026-09-01", competencias: ["2026-09"] });
      const r = await resgate.vendasResumoConta(pool, { clienteContaId: 5, desde: "2026-09-01", competencias: ["2026-09"] });
      return { porItem: [...v.porItem.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)), resumo: r };
    },
  };
  // Escala grande: o payload/agregações da Central custam P×C em buildPedidos
  // (filtro de todos os componentes por pedido — pré-existente, independe do
  // armazenamento) e levariam horas; ficam medidos só na escala média.
  if (process.env.SEM_PAYLOAD) { delete leitores.central_payload; delete leitores.agregacoes; }
  const medidas = {};
  const saidas = {};
  for (const [nome, fn] of Object.entries(leitores)) {
    // eslint-disable-next-line no-await-in-loop
    medidas[nome] = await medir(fn);
    // eslint-disable-next-line no-await-in-loop
    saidas[nome] = await fn();
  }
  // Caminho SQL (fallback) dos compactos, para comparar com a mescla em JS.
  if (COMPACTO(modo)) {
    const colunas = ["id", "import_id", "pedido_row_id", "item_row_id", "cliente_id", "cliente_slug", "marketplace", "competencia", "pedido_id",
      "item_id", "tipo", "valor", "fonte", "confianca", "obs", "escopo", "efeito", "incluido_no_resultado", "created_at", "updated_at"];
    const sqlU = cc.sqlUniao({ colunas, filtroLegado: "pedido_row_id = ANY($1::bigint[])", filtroCompacto: "pc.pedido_row_id = ANY($1::bigint[])" });
    medidas.componentes_periodo_uniao_sql = await medir(() => pool.query(sqlU, [ids]));
    const viaJs = (await repo.loadPedidosByImportIds({ importIds, dateFrom: range.dateFrom, dateTo })).componentes;
    // Mesma etapa que o repositório aplica depois de ler: import_id = import LIDO (reuso).
    const pc = require(path.join(SERVER, "services/centralVendas/centralVendasPedidosCompartilhados"));
    const viaSql = pc.itensComImportLido(carga.pedidos, [], (await pool.query(sqlU, [ids])).rows).componentes;
    medidas.uniaoSqlIgualMesclaJs = JSON.stringify(viaJs) === JSON.stringify(viaSql);
    // Referência independente: a consulta antiga sobre as linhas antigas + compactas desembrulhadas.
    if (!medidas.uniaoSqlIgualMesclaJs && process.env.DUMP_DIR) {
      fs.writeFileSync(path.join(process.env.DUMP_DIR, `${modo}.js.json`), JSON.stringify(viaJs, null, 1));
      fs.writeFileSync(path.join(process.env.DUMP_DIR, `${modo}.sql.json`), JSON.stringify(viaSql, null, 1));
    }
  }
  medidas.componentes_periodo = await medir(async () => (await repo.loadPedidosByImportIds({ importIds, dateFrom: range.dateFrom, dateTo })).componentes);
  // Buffers lidos pelo PG nas consultas de componentes do período.
  const buffers = async (sql, params) => {
    const { rows } = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    const plano = rows[0]["QUERY PLAN"][0];
    return { msServidor: Number(plano["Execution Time"].toFixed(1)), buffers: plano.Plan["Shared Hit Blocks"] + plano.Plan["Shared Read Blocks"] };
  };
  medidas.pg_componentes_linhas = await buffers(`SELECT id, tipo, valor, fonte, confianca, obs FROM central_vendas_componentes WHERE pedido_row_id = ANY($1::bigint[]) ORDER BY pedido_id, item_id NULLS LAST, id`, [ids]);
  if (COMPACTO(modo)) medidas.pg_componentes_compactos_crus = await buffers(cc.sqlCompactosCrus("pc.pedido_row_id = ANY($1::bigint[])"), [ids]);

  const TAB = ["central_vendas_imports", "central_vendas_pedidos", "central_vendas_pedido_itens", "central_vendas_componentes",
    "central_vendas_import_pedidos", "central_vendas_pedido_componentes", "central_vendas_componente_textos"];
  const { rows: tamanhos } = await pool.query(
    `SELECT c.relname AS tabela, pg_total_relation_size(c.oid)::bigint AS total FROM pg_class c
      WHERE c.relkind = 'r' AND c.relname = ANY($1::text[]) ORDER BY 1`, [TAB]);
  const { rows: [linhas] } = await pool.query(`SELECT (SELECT COUNT(*) FROM central_vendas_pedidos)::int AS pedidos,
      (SELECT COUNT(*) FROM central_vendas_componentes)::int AS componentes_linhas,
      ${COMPACTO(modo) ? "(SELECT COUNT(*) FROM central_vendas_pedido_componentes)::int" : "0"} AS compactos`);

  // Saídas sem identificadores físicos (ids de linha, timestamps): comparáveis entre modos.
  const limpar = (o) => JSON.parse(JSON.stringify(o, (k, v) => (["id", "rowId", "import_id", "importId", "pedido_row_id", "item_row_id", "created_at", "updated_at", "importacao", "imports", "importIds", "syncRunId", "cobertura", "geradoEm"].includes(k) ? undefined : v)));
  const assinatura = Object.fromEntries(Object.entries(saidas).map(([k, v]) => [k, JSON.stringify(limpar(v))]));
  await pool.end();
  process.stdout.write(`@@R@@${JSON.stringify({ modo, periodo: { pedidos: ids.length, componentes: carga.componentes.length }, msEscrita, medidas, tamanhos, linhas, assinatura, estatisticas: cc.estatisticas })}\n`);
}

async function pai() {
  const baseUrl = process.env.POC_DATABASE_URL;
  if (!baseUrl) { console.log("defina POC_DATABASE_URL (PostgreSQL LOCAL)"); process.exit(2); }
  if (!LOCAL.has(new URL(baseUrl).hostname)) throw new Error("LOCAL_DATABASE_REQUIRED");
  const { Client } = require(path.join(SERVER, "node_modules", "pg"));
  const admin = new Client({ connectionString: baseUrl, ssl: false });
  await admin.connect();
  const R = {};
  try {
    for (const modo of MODOS) {
      const nome = `vf_poc_leitura_${modo}_${Date.now()}`;
      await admin.query(`CREATE DATABASE "${nome}"`);
      const url = new URL(baseUrl); url.pathname = `/${nome}`; url.searchParams.set("sslmode", "disable");
      const t0 = Date.now();
      const r = spawnSync(process.execPath, ["--expose-gc", __filename, "--filho", modo, url.toString()], { env: { ...process.env }, encoding: "utf8", maxBuffer: 1 << 30 });
      await admin.query(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`);
      const linha = (r.stdout || "").split("\n").find((l) => l.startsWith("@@R@@"));
      if (r.status !== 0 || !linha) { console.error(r.stdout?.slice(-2000)); console.error(r.stderr?.slice(-4000)); throw new Error(`filho ${modo} falhou`); }
      R[modo] = JSON.parse(linha.slice(5));
      console.log(`  ${modo}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }
  } finally { await admin.end(); }
  // Garantia do formato compacto: idêntico ao mesmo modo em linhas, leitor a leitor.
  // linhas × reuso: idêntico em tudo, exceto o rótulo de SKU do Cliente 360, que
  // depende da ordem física dos itens (consulta sem ORDER BY — defeito pré-existente).
  const iguais = {};
  const comparar = (a, b, ignorar = []) => {
    if (!R[a] || !R[b]) return;
    for (const [k, v] of Object.entries(R[b].assinatura)) {
      if (ignorar.includes(k)) continue;
      const igual = v === R[a].assinatura[k];
      iguais[`${b}=${a}.${k}`] = igual;
      if (!igual && process.env.DUMP_DIR) {
        fs.writeFileSync(path.join(process.env.DUMP_DIR, `${a}.${k}.json`), JSON.stringify(JSON.parse(R[a].assinatura[k]), null, 1));
        fs.writeFileSync(path.join(process.env.DUMP_DIR, `${b}.${k}.json`), JSON.stringify(JSON.parse(v), null, 1));
      }
      assert.ok(igual, `${b}/${k}: resultado difere de ${a}`);
    }
  };
  comparar("linhas", "compacto");
  comparar("reuso", "reuso_compacto");
  comparar("linhas", "reuso", ["cliente360"]);
  if (R.linhas && R.reuso) {
    const semSku = (t) => JSON.stringify(JSON.parse(t), (k, v) => (k === "sku" || k === "titulo" ? undefined : v));
    iguais["reuso=linhas.cliente360(sem rótulo sku/título)"] = semSku(R.reuso.assinatura.cliente360) === semSku(R.linhas.assinatura.cliente360);
    iguais["reuso=linhas.cliente360(com rótulo)"] = R.reuso.assinatura.cliente360 === R.linhas.assinatura.cliente360;
    assert.ok(iguais["reuso=linhas.cliente360(sem rótulo sku/título)"], "reuso/cliente360: valores diferem de linhas");
  }
  for (const m of MODOS.filter(COMPACTO)) assert.ok(R[m].medidas.uniaoSqlIgualMesclaJs, `${m}: união SQL difere da mescla JS`);
  for (const m of MODOS) delete R[m].assinatura;
  const saida = { parametros: { NOITES, PEDIDOS_POR_DIA, REPETICOES }, equivalencia: iguais, modos: R };
  if (process.env.SAIDA) fs.writeFileSync(process.env.SAIDA, JSON.stringify(saida, null, 2));
  for (const m of MODOS) {
    const x = R[m].medidas;
    console.log(`  [${m}] período ${R[m].periodo.pedidos} pedidos/${R[m].periodo.componentes} comp. | carga ${x.central_carga.ms} ms | payload ${x.central_payload.ms} | detalhe×30 ${x.detalhe_30_pedidos.ms} | margem ${x.margem_realizado.ms} | c360 ${x.cliente360.ms} | resgate ${x.resgate.ms} | comp ${x.componentes_periodo.ms} ms cpu ${x.componentes_periodo.cpuMs} heap ${x.componentes_periodo.heapRetidoMB} MB${x.componentes_periodo_uniao_sql ? ` | união SQL ${x.componentes_periodo_uniao_sql.ms} ms` : ""}`);
  }
  console.log("bench-leitura.cjs: todos os leitores idênticos nos modos medidos");
}

if (process.argv[2] === "--filho") filho({ modo: process.argv[3], url: process.argv[4] }).catch((e) => { console.error(e); process.exit(1); });
else pai().catch((e) => { console.error(e); process.exit(1); });
