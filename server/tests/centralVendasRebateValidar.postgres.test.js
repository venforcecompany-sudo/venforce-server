// server/tests/centralVendasRebateValidar.postgres.test.js
//
// Leituras de banco do script de validação real do rebate, contra PostgreSQL
// REAL e LOCAL (nenhuma chamada ao ML):
//
//   CENTRAL_VENDAS_PG_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57661/postgres \
//     node tests/centralVendasRebateValidar.postgres.test.js
//
// Para cada formato de componentes (linhas; compacto com a migration 20261126):
//   · contaDoBanco: só conta Mercado Livre com seller;
//   · tarifasDaCentral: Σ tarifa_venda do import PUBLICADO mais recente da conta,
//     nunca de outra conta com o mesmo pedido_id;
//   · sugerir: classifica pedidos representativos (item único, q>1, multi-item, Full).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { Client } = require("pg");

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

async function filho(url, modo) {
  process.env.DATABASE_URL = url;
  if (modo === "compacto") { process.env.CENTRAL_VENDAS_COMPONENTES_COMPACTOS = "true"; process.env.CENTRAL_VENDAS_COMPONENTES_COMPACTOS_CONTAS = "5"; }
  const pool = require("../config/database");
  const repo = require("../services/centralVendas/centralVendasRepository");
  const script = require("../scripts/central-vendas-rebate-validar");
  const helper = fs.readFileSync(path.join(__dirname, "helpers", "centralVendasRetencaoPostgres.js"), "utf8");
  await pool.query(helper.split("const FIXTURES = `")[1].split("`;")[0]);
  await pool.query("ALTER TABLE cliente_contas ADD COLUMN marketplace text, ADD COLUMN external_account_id text");
  await pool.query("UPDATE cliente_contas SET marketplace = 'meli', external_account_id = '9001' WHERE id = 5");
  await pool.query("UPDATE cliente_contas SET marketplace = 'shopee', external_account_id = 'x' WHERE id = 6");
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "sql", "central_vendas_schema.sql"), "utf8"));
  if (modo === "compacto") await pool.query(fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "20261126_central_vendas_pedido_componentes.sql"), "utf8"));
  const cliente = { id: 1, slug: "loja", nome: "Loja" };
  const hoje = new Date().toISOString().slice(0, 10);
  const comp = hoje.slice(0, 7);
  async function gravar(conta, tarifaA, publicar = true) {
    const motor = {
      pedidos: [
        { pedidoId: "500001", dataPedido: hoje, status: "paid", confianca: "confiavel", quantidadeItens: 1, faturamento: 50, lucroContribuicao: 10, resultado: 10, pendencias: [], logistica: "normal" },
        { pedidoId: "500002", dataPedido: hoje, status: "paid", confianca: "confiavel", quantidadeItens: 3, faturamento: 90, lucroContribuicao: 9, resultado: 9, pendencias: [], logistica: "full" },
        { pedidoId: "500003", dataPedido: hoje, status: "paid", confianca: "confiavel", quantidadeItens: 2, faturamento: 60, lucroContribuicao: 6, resultado: 6, pendencias: [], logistica: "normal" },
      ],
      itens: [
        { pedidoId: "500001", itemId: "500001:MLB1:0", mlb: "MLB1", quantidade: 1, receitaProduto: 50, resultado: 10, confianca: "confiavel", pendencias: [] },
        { pedidoId: "500002", itemId: "500002:MLB2:0", mlb: "MLB2", quantidade: 1, receitaProduto: 30, resultado: 3, confianca: "confiavel", pendencias: [] },
        { pedidoId: "500002", itemId: "500002:MLB3:1", mlb: "MLB3", quantidade: 2, receitaProduto: 60, resultado: 6, confianca: "confiavel", pendencias: [] },
        { pedidoId: "500003", itemId: "500003:MLB4:0", mlb: "MLB4", quantidade: 2, receitaProduto: 60, resultado: 6, confianca: "confiavel", pendencias: [] },
      ],
      componentes: [
        { pedidoId: "500001", itemId: "500001:MLB1:0", tipo: "tarifa_venda", valor: -tarifaA, fonte: "orders_api", confianca: "real", obs: null },
        { pedidoId: "500002", itemId: "500002:MLB2:0", tipo: "tarifa_venda", valor: -3.6, fonte: "orders_api", confianca: "real", obs: null },
        { pedidoId: "500002", itemId: "500002:MLB3:1", tipo: "tarifa_venda", valor: -7.2, fonte: "orders_api", confianca: "real", obs: null },
      ],
    };
    const { rows: [run] } = await pool.query(`INSERT INTO central_vendas_sync_runs (cliente_id, cliente_slug, cliente_conta_id, marketplace, date_from, date_to, status)
      VALUES (1, 'loja', $1, 'meli', $2, $2, 'completed') RETURNING id`, [conta, hoje]);
    await repo.persistCentralVendasImport({ cliente, marketplace: "meli", competencia: comp, fonte: "orders_api", motorPayload: { ...motor, resumo: {} }, resumo: {},
      clienteContaId: conta, syncRunId: Number(run.id), publicationStatus: "candidate", coverageDateFrom: hoje, coverageDateTo: hoje });
    if (publicar) await repo.promoverCandidatesDoRun(Number(run.id));
  }
  await gravar(5, 5.0);
  await gravar(5, 5.47); // import mais recente da conta 5: vale este
  await gravar(6, 99.99); // outra conta, mesmos pedido_id
  await gravar(5, 77.77, false); // candidate não publicado: nunca vale
  const out = {
    conta5: await script.contaDoBanco(pool, 5),
    conta6: await script.contaDoBanco(pool, 6),
    conta9: await script.contaDoBanco(pool, 9),
    tarifas: Object.fromEntries(await script.tarifasDaCentral(pool, 5, ["500001", "500002", "500003", "999"])),
    sugestao: await script.sugerir(pool, 5, 30),
  };
  await pool.end();
  process.stdout.write(`@@R@@${JSON.stringify(out)}\n`);
}

async function pai() {
  const baseUrl = process.env.CENTRAL_VENDAS_PG_TEST_DATABASE_URL;
  if (!baseUrl) { console.log("centralVendasRebateValidar.postgres.test.js: PULADO (defina CENTRAL_VENDAS_PG_TEST_DATABASE_URL)"); return; }
  if (!LOCAL.has(new URL(baseUrl).hostname)) throw new Error("LOCAL_DATABASE_REQUIRED");
  const adm = new Client({ connectionString: baseUrl });
  await adm.connect();
  let checks = 0;
  const ok = (l, c) => { assert.ok(c, `FALHOU: ${l}`); checks += 1; console.log(`  ✓ ${l}`); };
  try {
    for (const modo of ["linhas", "compacto"]) {
      const nome = `cv_rebate_val_${modo}_${process.pid}`;
      await adm.query(`DROP DATABASE IF EXISTS ${nome}`);
      await adm.query(`CREATE DATABASE ${nome}`);
      const url = new URL(baseUrl); url.pathname = `/${nome}`; url.searchParams.set("sslmode", "disable");
      const r = spawnSync(process.execPath, [__filename, "--filho", url.toString(), modo], { encoding: "utf8", env: { ...process.env } });
      await adm.query(`DROP DATABASE IF EXISTS ${nome}`);
      const linha = (r.stdout || "").split("\n").find((l) => l.startsWith("@@R@@"));
      if (!linha) { console.error(r.stdout, r.stderr); throw new Error(`filho ${modo} falhou`); }
      const o = JSON.parse(linha.slice(5));
      ok(`[${modo}] conta ML com seller resolvida; conta Shopee e conta inexistente recusadas`,
        JSON.stringify(o.conta5) === JSON.stringify({ clienteContaId: 5, clienteId: 1, sellerId: "9001" }) && o.conta6 === null && o.conta9 === null);
      ok(`[${modo}] tarifa = Σ tarifa_venda do import publicado mais recente da conta (nunca outra conta nem candidate)`,
        JSON.stringify(o.tarifas) === JSON.stringify({ 500001: 547, 500002: 1080 }));
      ok(`[${modo}] sugestão classifica item único, multi-item e quantidade > 1`,
        o.sugestao.item_unico_q1.includes("500001") && o.sugestao.multi_item.includes("500002") && o.sugestao.quantidade_maior_que_1.includes("500003"));
    }
  } finally {
    await adm.end();
  }
  console.log(`centralVendasRebateValidar.postgres.test.js: ${checks} verificacoes OK`);
}

if (process.argv[2] === "--filho") filho(process.argv[3], process.argv[4]).catch((e) => { console.error(e); process.exit(1); });
else pai().catch((e) => { console.error(e); process.exit(1); });
