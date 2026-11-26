// server/tests/centralVendasComponentesCompactos.postgres.test.js
//
// Casos de borda do formato compacto contra PostgreSQL REAL e LOCAL:
//
//   CENTRAL_VENDAS_PG_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57651/postgres \
//     node tests/centralVendasComponentesCompactos.postgres.test.js
//
// Sem a variável o teste PULA (exit 0). Host fora de localhost ⇒ recusa.
// Dois bancos descartáveis recebem os MESMOS imports pelo código real
// (persistCentralVendasImport): "linhas" (flag desligada = main) e "compacto"
// (CENTRAL_VENDAS_COMPONENTES_COMPACTOS + migration 20261126). Todos os
// leitores precisam devolver exatamente o mesmo, inclusive em:
//   arredondamento NUMERIC(14,2) (12.345, 1.005, -0.005), estouro (22003),
//   valor 0 × NULL, tipo repetido no mesmo item, tipo desconhecido (efeito e
//   incluido NULL), extras fora das colunas, pedido sem componente, pedido só
//   com componentes de pedido, o mesmo pedido_id em duas competências (borda
//   de mês), planilha manual (sempre em linhas), backup CSV da retenção e
//   CASCADE ao apagar o import.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function motorBase(competencia, dia) {
  const d = `${competencia}-${dia}`;
  const pedido = (pedidoId, extra = {}) => ({ pedidoId, dataPedido: d, status: "paid", confianca: "confiavel", quantidadeItens: 1,
    faturamento: 100, lucroContribuicao: 10, resultado: 10, margemContribuicaoPercentual: 10, pendencias: [], logistica: "normal", ...extra });
  const item = (pedidoId, itemId, mlb) => ({ pedidoId, itemId, mlb, sku: `SKU-${mlb}`, titulo: `T ${mlb}`, quantidade: 1, valorUnitario: 50,
    receitaProduto: 50, custoProduto: 20, impostoInterno: 3, lucroContribuicao: 5, resultado: 5, margemContribuicaoPercentual: 10, confianca: "confiavel", pendencias: [] });
  const c = (pedidoId, itemId, tipo, valor, fonte = "orders_api", confianca = "real", obs = null, extras = {}) => ({ pedidoId, itemId, tipo, valor, fonte, confianca, obs, ...extras });
  return {
    pedidos: [pedido("A", { quantidadeItens: 2 }), pedido("B"), pedido("C")],
    itens: [item("A", "A:1", "MLB1"), item("A", "A:2", "MLB2"), item("B", "B:1", "MLB3")],
    componentes: [
      c("A", "A:1", "receita_produto", 12.345),
      c("A", "A:1", "tarifa_venda", -1.005),
      c("A", "A:1", "tarifa_venda", -0.005, "orders_api", "real", "segunda tarifa legítima do mesmo item"),
      c("A", "A:1", "custo_produto", null, "ausente", "bloqueado", "MLB sem custo na base vinculada do cliente."),
      c("A", "A:1", "frete_seller", 0, "shipments_api"),
      c("A", "A:2", "receita_produto", 37.66),
      c("A", "A:2", "ajuste_desconhecido", 2.5, null, "parcial", null, { lote: 7, origem: { planilha: "x" } }),
      c("A", null, "receita_envio", 15.9, "shipments_api"),
      c("A", null, "cancelamento_reembolso", -12.34, "orders_api_payments", "real", "Reembolso efetivado ao comprador."),
      c("B", null, "receita_envio", null, "ausente", "ausente", "receiver.cost ausente na resposta de /shipments/:id/costs."),
      c("B", "B:1", "receita_produto", 50, "", "real", ""),
    ],
  };
}

async function filho({ url, modo }) {
  process.env.DATABASE_URL = url;
  delete process.env.CENTRAL_VENDAS_COMPONENTES_COMPACTOS;
  if (modo === "compacto") { process.env.CENTRAL_VENDAS_COMPONENTES_COMPACTOS = "true"; process.env.CENTRAL_VENDAS_COMPONENTES_COMPACTOS_CONTAS = "5"; }
  const pool = require("../config/database");
  const repo = require("../services/centralVendas/centralVendasRepository");
  const { buildPayloadFromRange } = require("../services/centralVendas/centralVendasService");
  const ret = require("../services/centralVendas/retencao/centralVendasRetencaoRepository");

  const helper = fs.readFileSync(path.join(__dirname, "helpers", "centralVendasRetencaoPostgres.js"), "utf8");
  await pool.query(helper.split("const FIXTURES = `")[1].split("`;")[0]);
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "sql", "central_vendas_schema.sql"), "utf8"));
  if (modo === "compacto") await pool.query(fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "20261126_central_vendas_pedido_componentes.sql"), "utf8"));

  const cliente = { id: 1, slug: "loja", nome: "Loja" };
  const fimDoMes = (comp) => { const [y, m] = comp.split("-").map(Number); return `${comp}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };
  async function gravar(competencia, dia, motor, fonte = "orders_api") {
    const { rows: [run] } = await pool.query(
      `INSERT INTO central_vendas_sync_runs (cliente_id, cliente_slug, cliente_conta_id, marketplace, date_from, date_to, status)
       VALUES (1, 'loja', 5, 'meli', $1, $2, 'completed') RETURNING id`, [`${competencia}-01`, fimDoMes(competencia)]);
    const p = await repo.persistCentralVendasImport({
      cliente, marketplace: "meli", competencia, fonte, motorPayload: { ...motor, resumo: {} }, resumo: {}, clienteContaId: 5,
      syncRunId: fonte === "orders_api" ? Number(run.id) : null, publicationStatus: fonte === "orders_api" ? "candidate" : "legacy",
      coverageDateFrom: `${competencia}-01`, coverageDateTo: fimDoMes(competencia),
    });
    if (fonte === "orders_api") await repo.promoverCandidatesDoRun(Number(run.id));
    return p;
  }
  const set = await gravar("2026-09", "30", motorBase("2026-09", "30"));
  // Borda de mês: o MESMO pedido_id "A" também na competência seguinte.
  const out = await gravar("2026-10", "01", motorBase("2026-10", "01"));
  // Planilha manual: sempre em linhas.
  const planilha = await gravar("2026-08", "15", motorBase("2026-08", "15"), "planilha_vendas");

  // Estouro de NUMERIC(14,2): os dois formatos recusam o import inteiro.
  let estouro = null;
  try {
    const m = motorBase("2026-07", "10"); m.componentes[0].valor = 1e13;
    await gravar("2026-07", "10", m);
  } catch (err) { estouro = err.code || err.message; }

  const VOL = ["id", "created_at", "updated_at"];
  const sem = (r) => { const o = { ...r }; for (const k of VOL) delete o[k]; return o; };
  const range = { clienteSlug: "loja", dateFrom: "2026-08-01", dateTo: "2026-10-31", clienteContaId: 5, includeLegacy: true };
  const { importIds } = await repo.resolveImportsForRange(range);
  const carga = await repo.loadPedidosByImportIds({ importIds, dateFrom: range.dateFrom, dateTo: range.dateTo });
  const realizado = await repo.loadRealizadoByImportIds({ importIds, dateFrom: range.dateFrom, dateTo: range.dateTo });
  const latest = await repo.getLatestCentralVendasImport({ clienteSlug: "loja", competencia: "2026-09", clienteContaId: 5 });
  const detalhes = [];
  for (const p of carga.pedidos) {
    // eslint-disable-next-line no-await-in-loop
    const d = await repo.getPedidoDetailByRowId({ importIds, dateFrom: range.dateFrom, dateTo: range.dateTo, rowId: p.id });
    detalhes.push(d.componentes.map(sem));
  }
  const snapshot = await repo.getCentralVendasByRange(range);
  const payload = buildPayloadFromRange(cliente, { dateFrom: range.dateFrom, dateTo: range.dateTo }, snapshot);

  // Retenção: contagem por import e backup CSV antes do DELETE; CASCADE.
  const contagem = Object.fromEntries([...(await ret.contarFilhosPorImport(pool, [Number(set.importacao.id)])).entries()]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cv-compactos-"));
  const arquivos = await ret.exportarImportsCsv(pool, [Number(set.importacao.id)], { dir, prefixo: "t" });
  const csv = Object.fromEntries(Object.entries(arquivos).map(([k, f]) => [k, fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").length - 1 : 0]));
  fs.rmSync(dir, { recursive: true, force: true });
  await pool.query(`DELETE FROM central_vendas_imports WHERE id = $1`, [set.importacao.id]);
  const { rows: [resto] } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM central_vendas_componentes WHERE import_id = $1)::int AS linhas,
            ${modo === "compacto" ? `(SELECT COUNT(*) FROM central_vendas_pedido_componentes)::int` : "0"} AS compactos_total`, [set.importacao.id]);
  const { rows: [fmt] } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM central_vendas_componentes WHERE import_id = $1)::int AS planilha_linhas`, [planilha.importacao.id]);

  await pool.end();
  process.stdout.write(`@@R@@${JSON.stringify({
    leitura: JSON.stringify({ carga: { pedidos: carga.pedidos.map(sem), itens: carga.itens.map(sem), componentes: carga.componentes.map(sem) },
      realizado: realizado.componentes, latest: latest.componentes.map(sem), detalhes,
      payload: { resumo: payload.resumo, pedidos: payload.pedidos } }),
    estouro, contagem, csv, resto, fmt,
    formatos: { set: set.persistencia.componentes, out: out.persistencia.componentes, planilha: planilha.persistencia.componentes },
    amostra: carga.componentes.filter((c) => c.pedido_id === "A" && String(c.pedido_row_id) === String(Math.min(...carga.componentes.filter((x) => x.pedido_id === "A").map((x) => Number(x.pedido_row_id))))).map((c) => [c.item_id, c.tipo, c.valor, c.fonte, c.obs, c.escopo, c.efeito, c.incluido_no_resultado]),
  })}\n`);
}

async function pai() {
  const baseUrl = process.env.CENTRAL_VENDAS_PG_TEST_DATABASE_URL;
  if (!baseUrl) { console.log("centralVendasComponentesCompactos.postgres.test.js: PULADO (defina CENTRAL_VENDAS_PG_TEST_DATABASE_URL para um PG local)"); return; }
  const host = new URL(baseUrl).hostname;
  console.log(`  banco de teste: host=${host}`);
  if (!LOCAL.has(host)) throw new Error("LOCAL_DATABASE_REQUIRED");
  const { Client } = require("pg");
  const admin = new Client({ connectionString: baseUrl, ssl: false });
  await admin.connect();
  const R = {};
  const nomes = [];
  try {
    for (const modo of ["linhas", "compacto"]) {
      const nome = `vf_cv_compactos_${modo}_${Date.now()}`;
      nomes.push(nome);
      await admin.query(`CREATE DATABASE "${nome}"`);
      const url = new URL(baseUrl); url.pathname = `/${nome}`; url.searchParams.set("sslmode", "disable");
      const r = spawnSync(process.execPath, [__filename, "--filho", modo, url.toString()], { env: { ...process.env }, encoding: "utf8", maxBuffer: 1 << 28 });
      const linha = (r.stdout || "").split("\n").find((l) => l.startsWith("@@R@@"));
      if (r.status !== 0 || !linha) { console.error(r.stdout?.slice(-3000)); console.error(r.stderr?.slice(-3000)); throw new Error(`filho ${modo} falhou`); }
      R[modo] = JSON.parse(linha.slice(5));
    }
  } finally {
    for (const nome of nomes) await admin.query(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
  const { linhas, compacto } = R;
  if (process.env.DUMP_DIR) for (const m of ["linhas", "compacto"]) fs.writeFileSync(path.join(process.env.DUMP_DIR, `${m}.json`), JSON.stringify(JSON.parse(R[m].leitura), null, 1));
  let checks = 0;
  const ok = (label, cond) => { assert.ok(cond, `FALHOU: ${label}`); checks += 1; console.log(`  ✓ ${label}`); };
  ok("formato gravado: Sync em compacto; planilha e flag desligada em linhas (sem campo novo na medição)", compacto.formatos.set.formato === "compacto_v1" && compacto.formatos.out.formato === "compacto_v1"
    && compacto.formatos.planilha === undefined && linhas.formatos.set === undefined && compacto.fmt.planilha_linhas > 0);
  ok("todos os leitores idênticos (carga, realizado, getLatest, detalhe, resumo financeiro)", linhas.leitura === compacto.leitura);
  ok("arredondamento NUMERIC(14,2) idêntico (12.345→12.35, -1.005→-1.01, -0.005→-0.01)",
    JSON.stringify(compacto.amostra.slice(0, 3).map((x) => x[2])) === JSON.stringify(["12.35", "-1.01", "-0.01"]));
  ok("NULL ≠ 0 preservado", compacto.amostra[3][2] === null && compacto.amostra[4][2] === "0.00");
  ok("tipo desconhecido: efeito e incluido NULL; fonte '' e obs '' viram NULL (como a coluna antiga)",
    compacto.amostra.some((x) => x[1] === "ajuste_desconhecido" && x[5] === "item" && x[6] === null && x[7] === null && x[3] === null));
  ok("estouro de NUMERIC(14,2) recusa o import nos dois formatos (22003)", linhas.estouro === "22003" && compacto.estouro === "22003");
  ok("retenção conta os componentes compactos do import", compacto.contagem[Object.keys(compacto.contagem)[0]].componentes_compactos === 2
    && linhas.contagem[Object.keys(linhas.contagem)[0]].componentes === 11);
  ok("backup CSV da retenção leva as linhas compactas e o dicionário", compacto.csv.componentes_compactos === 2 && compacto.csv.componente_textos > 0 && linhas.csv.componentes === 11);
  ok("DELETE do import apaga os compactos dele por CASCADE (e só os dele)", compacto.resto.linhas === 0 && compacto.resto.compactos_total === 2);
  console.log(`centralVendasComponentesCompactos.postgres.test.js: ${checks} verificacoes OK`);
}

if (process.argv[2] === "--filho") filho({ modo: process.argv[3], url: process.argv[4] }).catch((e) => { console.error(e); process.exit(1); });
else pai().catch((e) => { console.error(e); process.exit(1); });
