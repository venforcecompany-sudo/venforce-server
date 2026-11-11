// server/tests/centralVendasReusoIsolamentoContas.postgres.test.js
//
// Isolamento por conta do reuso de pedidos, contra PostgreSQL REAL e LOCAL:
// duas contas do MESMO cliente/marketplace/competência com pedidos de ids e
// valores IDÊNTICOS. Nenhum vínculo pode cruzar contas, a conta fora da lista
// grava completo e a conta NULL (legado) nunca entra em reuso.
//
//   CENTRAL_VENDAS_PG_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57651/postgres \
//     node tests/centralVendasReusoIsolamentoContas.postgres.test.js
//
// Sem a variável o teste PULA (exit 0). Host fora de localhost ⇒ recusa.

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function orders(ate) {
  const out = [];
  for (let i = 1; i <= ate; i++) {
    out.push({
      id: `7000${i}`, date_created: `2026-09-0${i}T10:00:00.000-03:00`, status: "paid", tags: [],
      payments: [{ id: `P${i}`, transaction_amount_refunded: 0 }],
      shipping: { id: `S${i}`, logistic_type: "cross_docking" },
      order_items: [{ item: { id: "MLB101", seller_sku: "SKU-MLB101", title: "Produto" }, quantity: 1, unit_price: 100 + i, sale_fee: 12 }],
    });
  }
  return out;
}

async function filho(url) {
  process.env.DATABASE_URL = url;
  process.env.CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA = "true";
  process.env.CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS = "true";
  const pool = require("../config/database");
  const repo = require("../services/centralVendas/centralVendasRepository");
  const { buildMotorFromOrders, buildCostMap, coverageParaCompetencia } = require("../services/centralVendas/centralVendasSyncService");
  const { buildResumoCentralVendas } = require("../services/centralVendas/centralVendasImportService");

  const helper = fs.readFileSync(path.join(__dirname, "helpers", "centralVendasRetencaoPostgres.js"), "utf8");
  await pool.query(helper.split("const FIXTURES = `")[1].split("`;")[0]);
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "sql", "central_vendas_schema.sql"), "utf8"));
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "20261111_central_vendas_import_pedidos.sql"), "utf8"));

  const cliente = { id: 1, slug: "loja", nome: "Loja" };
  const costMap = buildCostMap([{ produto_id: "MLB101", custo_produto: 10, imposto_percentual: 6 }]);
  const frete = (os) => new Map(os.map((o) => [o.shipping.id, { valor: 9.9, status: "real", receitaComprador: 0 }]));

  async function noite(contaId, ate) {
    const os = orders(ate);
    const motor = buildMotorFromOrders({ orders: os, costMap, freteMap: frete(os), clienteSlug: "loja", competencia: "2026-09" });
    const dateTo = `2026-09-0${ate}`;
    const { rows: [run] } = await pool.query(
      `INSERT INTO central_vendas_sync_runs (cliente_id, cliente_slug, cliente_conta_id, marketplace, date_from, date_to, status)
       VALUES (1, 'loja', $1, 'meli', '2026-09-01', $2, 'completed') RETURNING id`, [contaId, dateTo]);
    const resumo = { ...buildResumoCentralVendas(motor), syncRunId: Number(run.id) };
    const { coverageFrom, coverageTo } = coverageParaCompetencia("2026-09", "2026-09-01", dateTo);
    const r = await repo.persistCentralVendasImport({
      cliente, marketplace: "meli", competencia: "2026-09", fonte: "orders_api",
      motorPayload: { ...motor, resumo }, resumo, clienteContaId: contaId,
      syncRunId: Number(run.id), publicationStatus: "candidate", coverageDateFrom: coverageFrom, coverageDateTo: coverageTo,
    });
    await repo.promoverCandidatesDoRun(Number(run.id));
    return { importId: Number(r.importacao.id), gravados: r.persistencia.gravados, dateTo };
  }
  // Para cada vínculo: conta do import que referencia × conta do import dono da linha.
  async function contasDosVinculos() {
    const { rows } = await pool.query(
      `SELECT ir.cliente_conta_id AS ref, io.cliente_conta_id AS dono
         FROM central_vendas_import_pedidos v
         JOIN central_vendas_imports ir ON ir.id = v.import_id
         JOIN central_vendas_pedidos p ON p.id = v.pedido_row_id
         JOIN central_vendas_imports io ON io.id = p.import_id`);
    return rows.map((r) => ({ ref: Number(r.ref), dono: Number(r.dono) }));
  }
  async function leitura(contaId, dateTo) {
    const range = { clienteSlug: "loja", dateFrom: "2026-09-01", dateTo, clienteContaId: contaId };
    const { importIds } = await repo.resolveImportsForRange(range);
    const carga = await repo.loadPedidosByImportIds({ importIds, dateFrom: range.dateFrom, dateTo });
    const { rows } = await pool.query(`SELECT DISTINCT cliente_conta_id FROM central_vendas_imports WHERE id = ANY($1::bigint[])`, [importIds]);
    return { pedidos: carga.pedidos.length, contas: rows.map((x) => Number(x.cliente_conta_id)) };
  }

  const R = { checks: [] };
  const ok = (nome, cond) => { assert.ok(cond, nome); R.checks.push(nome); };

  // Lista = só a conta 5. Conta 6 grava completo mesmo com pedidos idênticos.
  process.env.CENTRAL_VENDAS_SYNC_REUSO_CONTAS = "5";
  const a5n1 = await noite(5, 2);
  const a6n1 = await noite(6, 2);
  ok("conta 6 (fora da lista) grava os 2 pedidos completos", a6n1.gravados.pedidos === 2 && a6n1.gravados.vinculos === 0);
  const a5n2 = await noite(5, 3);
  ok("conta 5 reusa os 2 inalterados dela e grava só o novo", a5n2.gravados.vinculos === 2 && a5n2.gravados.pedidos === 1);
  const a6n2 = await noite(6, 3);
  ok("conta 6 segue completa (3 pedidos, 0 vínculos)", a6n2.gravados.pedidos === 3 && a6n2.gravados.vinculos === 0);

  // Lista = 5 e 6: a conta 6 passa a reusar, mas só linhas da própria conta.
  process.env.CENTRAL_VENDAS_SYNC_REUSO_CONTAS = "5,6";
  const a6n3 = await noite(6, 3);
  ok("conta 6 (agora na lista) reusa os 3 pedidos da própria conta", a6n3.gravados.vinculos === 3 && a6n3.gravados.pedidos === 0);
  const a5n3 = await noite(5, 3);
  ok("conta 5 reusa os 3 dela (fechamento, nada mudou)", a5n3.gravados.vinculos === 3 && a5n3.gravados.pedidos === 0);

  const vinc = await contasDosVinculos();
  ok("existem vínculos nas duas contas", vinc.some((v) => v.ref === 5) && vinc.some((v) => v.ref === 6));
  ok("NENHUM vínculo cruza contas (conta do import = conta do dono da linha)", vinc.every((v) => v.ref === v.dono));

  const l5 = await leitura(5, "2026-09-03");
  const l6 = await leitura(6, "2026-09-03");
  ok("leitura da conta 5 só toca imports da conta 5", l5.contas.length === 1 && l5.contas[0] === 5 && l5.pedidos === 3);
  ok("leitura da conta 6 só toca imports da conta 6", l6.contas.length === 1 && l6.contas[0] === 6 && l6.pedidos === 3);

  // Conta legada (NULL): com "*" reusa SÓ dentro do grupo NULL (mesma regra de
  // lerManifestoVigente: IS NOT DISTINCT FROM) e nunca de conta numerada.
  process.env.CENTRAL_VENDAS_SYNC_REUSO_CONTAS = "5";
  const n0 = await noite(null, 2);
  const n0b = await noite(null, 2);
  ok("conta NULL fora da lista grava completo", n0.gravados.vinculos === 0 && n0b.gravados.vinculos === 0 && n0b.gravados.pedidos === 2);
  process.env.CENTRAL_VENDAS_SYNC_REUSO_CONTAS = "*";
  const n1 = await noite(null, 2);
  ok("conta NULL com '*' reusa os 2 pedidos do grupo NULL", n1.gravados.vinculos === 2 && n1.gravados.pedidos === 0);
  const vinc2 = await contasDosVinculos();
  ok("vínculo de NULL aponta só para linha de import NULL; nenhum cruza contas", vinc2.every((v) => (v.ref === 0) === (v.dono === 0) && (v.ref === 0 || v.ref === v.dono)));

  // Apagar o import dono da conta 5 não afeta a conta 6.
  const { rows: [{ n }] } = await pool.query(`SELECT COUNT(*)::int AS n FROM central_vendas_import_pedidos v JOIN central_vendas_imports i ON i.id = v.import_id WHERE i.cliente_conta_id = 6`);
  ok("vínculos da conta 6 existem e dependem só de linhas da 6", n === 3);

  await pool.end();
  process.stdout.write(`@@RESULTADO@@${JSON.stringify({ checks: R.checks.length })}\n`);
}

async function pai() {
  const baseUrl = process.env.CENTRAL_VENDAS_PG_TEST_DATABASE_URL;
  if (!baseUrl) {
    console.log("centralVendasReusoIsolamentoContas.postgres.test.js: PULADO (defina CENTRAL_VENDAS_PG_TEST_DATABASE_URL para um PG local)");
    return;
  }
  if (!LOCAL.has(new URL(baseUrl).hostname)) throw new Error("LOCAL_DATABASE_REQUIRED");
  const { Client } = require("pg");
  const admin = new Client({ connectionString: baseUrl, ssl: false });
  await admin.connect();
  const nome = `vf_cv_iso_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  try {
    await admin.query(`CREATE DATABASE "${nome}"`);
    const url = new URL(baseUrl); url.pathname = `/${nome}`; url.searchParams.set("sslmode", "disable");
    const r = spawnSync(process.execPath, [__filename, "--filho", url.toString()], { env: { ...process.env }, encoding: "utf8" });
    const linha = (r.stdout || "").split("\n").find((l) => l.startsWith("@@RESULTADO@@"));
    if (r.status !== 0 || !linha) {
      console.error((r.stdout || "").slice(-3000)); console.error((r.stderr || "").slice(-3000));
      throw new Error(`filho falhou (exit ${r.status})`);
    }
    console.log(`centralVendasReusoIsolamentoContas.postgres.test.js: ${JSON.parse(linha.slice(13)).checks} verificacoes OK`);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
}

if (process.argv[2] === "--filho") {
  filho(process.argv[3]).catch((err) => { console.error(err); process.exit(1); });
} else {
  pai().catch((err) => { console.error(err); process.exit(1); });
}
