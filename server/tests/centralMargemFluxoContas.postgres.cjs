// server/tests/centralMargemFluxoContas.postgres.cjs
//
// Fluxo integrado da Central de Margem (leitura) contra PostgreSQL LOCAL
// descartável — fora do run-all:
//   MARGIN_TEST_DATABASE_URL=postgres://vf@127.0.0.1:55433/postgres node tests/centralMargemFluxoContas.postgres.cjs
//
// Cliente com DUAS contas ML (86 principal, 87 secundária, como a Alianza
// Jeans). Retorno ML de promoção em andamento na 87 (status efetivo ≠
// persistido) — exatamente o cenário do HTTP 500 de 10/11/2026. Percorre:
// resumo → itens (worklist, margem, página 2, busca, status) → alterna para a 86
// → volta para a 87 → status de um run sem heartbeat (parado). Sem ML, sem
// server/.env: Central de Vendas, contas e promoções são fakes; o SQL é real.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Client, Pool } = require("pg");

const baseUrl = process.env.MARGIN_TEST_DATABASE_URL;
if (!baseUrl) throw new Error("Defina MARGIN_TEST_DATABASE_URL (PostgreSQL local).");
const parsed = new URL(baseUrl);
if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("LOCAL_DATABASE_REQUIRED");

const dbName = `vf_central_fluxo_${Date.now()}`;
const testUrl = new URL(baseUrl);
testUrl.pathname = `/${dbName}`;
process.env.DATABASE_URL = testUrl.toString();

const readService = require("../services/motorMargem/marginSnapshotReadService");
const apiService = require("../services/motorMargem/marginSnapshotApiService");
const runRepository = require("../services/motorMargem/marginSnapshotRunRepository");

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks += 1; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks += 1; };

const CLIENTE = { id: 133, slug: "alianza_jeans", nome: "Alianza Jeans", ativo: true };
const CONTAS = {
  86: { id: 86, cliente_id: 133, marketplace: "meli", nome: "Alianza 1", ativo: true, external_account_id: "1587129755" },
  87: { id: 87, cliente_id: 133, marketplace: "meli", nome: "Alianza 2", ativo: true, external_account_id: "2433262404" },
  99: { id: 99, cliente_id: 7, marketplace: "meli", nome: "Outro cliente", ativo: true, external_account_id: "1" },
};
const contas = {
  async resolverClientePorIdOuSlug({ clienteSlug }) {
    if (clienteSlug !== CLIENTE.slug) { const e = new Error("Cliente não encontrado."); e.statusCode = 404; throw e; }
    return CLIENTE;
  },
  async obterConta(id) {
    const c = CONTAS[Number(id)];
    if (!c) { const e = new Error("Conta não encontrada."); e.statusCode = 404; throw e; }
    return c;
  },
};
// Retorno ML em andamento SÓ na conta 87 (seller 2433262404): MLB872 sai de Prejuízo.
const promoRepository = {
  async mapRebatesAtivosDaConta({ clienteContaId, sellerId }) {
    if (Number(clienteContaId) === 87 && sellerId === "2433262404") return new Map([["MLB872", { promocoes: 1, rebate: 15 }]]);
    return new Map();
  },
};

function deps(db) {
  return {
    db,
    env: { MARGIN_SNAPSHOT_READ_ENABLED: "true" },
    now: new Date("2026-11-10T18:15:00Z"),
    clienteContaService: contas,
    promoRepository,
    contarContasAtivas: async () => 2,
    resolverIncludeLegacy: async () => false,
    carregarVendas: async () => ({ pedidos: [], pedidosTodos: [], itens: [], componentes: [], sincronizado: true, competencias: [] }),
    // agregarPorMlb: o real (centralVendasEvidenceAdapter) sobre zero vendas.
    logger: { log() {}, warn() {}, error() {} },
  };
}

async function inserir(db, contaId, item, { status, margem, preco = 100 }) {
  const lucro = margem * preco;
  await db.query(
    `INSERT INTO margin_projection_snapshots
       (cliente_id, cliente_conta_id, marketplace, item_id, titulo, price, cost, tax_rate, fixed_fee, commission, freight,
        profit, margin, margin_percent, status, refresh_status, calculated_at, observed_at, quality_json, assumed_json, missing_json)
     VALUES (133, $1, 'meli', $2, $2, $3, 50, 0.1, 0, 12, 15, $4, $5, $6, $7, 'fresh', '2026-11-10T18:00:00Z', '2026-11-10T18:00:00Z',
             '{"freteQualidade":{"nivel":"cotado_ml","confirmado":false}}'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
    [contaId, item, preco, lucro, margem, margem * 100, status]
  );
}

async function main() {
  const admin = new Client({ connectionString: baseUrl, ssl: false });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const db = new Pool({ connectionString: testUrl.toString(), ssl: false, max: 4 });
  try {
    await db.query(`CREATE TABLE clientes (id BIGSERIAL PRIMARY KEY, slug TEXT);
      CREATE TABLE cliente_contas (id BIGSERIAL PRIMARY KEY, cliente_id BIGINT);
      CREATE TABLE bases (id BIGSERIAL PRIMARY KEY, nome TEXT);
      CREATE TABLE users (id BIGSERIAL PRIMARY KEY);
      INSERT INTO clientes (id, slug) VALUES (133, 'alianza_jeans'), (7, 'outro');
      INSERT INTO cliente_contas (id, cliente_id) VALUES (86, 133), (87, 133), (99, 7);`);
    await db.query(fs.readFileSync(path.join(__dirname, "../sql/margin_snapshot_schema.sql"), "utf8"));

    // Conta 87: 60 itens (2 páginas de 50) — 2 em prejuízo, 1 deles com retorno ML.
    await inserir(db, 87, "MLB871", { status: "LOSS", margem: -0.05 });
    await inserir(db, 87, "MLB872", { status: "LOSS", margem: -0.02 });
    await inserir(db, 87, "MLB873", { status: "LOW_MARGIN", margem: 0.04 });
    for (let i = 0; i < 57; i++) await inserir(db, 87, `MLB87X${String(i).padStart(2, "0")}`, { status: "HEALTHY", margem: 0.2 + i / 1000 });
    // Conta 86: 3 itens próprios; nenhum deve aparecer na 87 (nem o inverso).
    for (const [item, status, margem] of [["MLB861", "LOSS", -0.1], ["MLB862", "HEALTHY", 0.3], ["MLB863", "HEALTHY", 0.25]]) {
      await inserir(db, 86, item, { status, margem });
    }
    await db.query(`INSERT INTO margin_snapshot_runs (cliente_id, cliente_slug, cliente_conta_id, marketplace, reason, status, total_items, processed_items, success_items, failed_items, cursor_offset, created_at, started_at, heartbeat_at, finished_at)
      VALUES (133, 'alianza_jeans', 87, 'meli', 'manual_refresh', 'completed', 60, 60, 60, 0, 60, '2026-11-10T17:59:00Z', '2026-11-10T17:59:00Z', '2026-11-10T18:00:00Z', '2026-11-10T18:00:00Z')`);

    const d = deps(db);
    const ler = (contaId, extra = {}) => readService.listarItens({ clienteSlug: "alianza_jeans", clienteContaId: String(contaId), page: 1, limit: 50, ...extra }, d);

    // 1. Carregar Central da conta 87: resumo + KPIs pelo status EFETIVO.
    const resumo = await readService.obterResumo({ clienteSlug: "alianza_jeans", clienteContaId: "87" }, d);
    eq(resumo.estado, "ready");
    eq(resumo.kpis.total, 60);
    eq(resumo.kpis.porStatus.LOSS, 1, "MLB872 saiu de Prejuízo pelo retorno ML");

    // 2. Itens da conta 87 — o pedido exato que dava 500 (worklist sem filtros) e as variações.
    const wl = await ler(87, { ordenacao: "worklist" });
    eq(wl.paginacao.total, 60);
    eq(wl.itens.length, 50);
    eq(wl.itens[0].itemId, "MLB871", "prejuízo efetivo primeiro");
    ok(!wl.itens.some((i) => i.itemId.startsWith("MLB86")), "conta 87 nunca mostra item da 86");
    const p2 = await ler(87, { ordenacao: "worklist", page: 2 });
    eq(p2.itens.length, 10, "página 2");
    ok(!p2.itens.some((i) => wl.itens.some((j) => j.itemId === i.itemId)), "paginação sem repetir item");
    eq((await ler(87, { ordenacao: "margin_percent" })).itens.length, 50);
    eq((await ler(87, { ordenacao: "worklist", busca: "MLB872" })).paginacao.total, 1);
    eq((await ler(87, { ordenacao: "worklist", status: "LOSS" })).paginacao.total, 1, "filtro LOSS pelo status efetivo");

    // 3. Alterna para a conta 86 e volta: cada uma só vê o próprio catálogo.
    const c86 = await ler(86, { ordenacao: "worklist" });
    eq(c86.paginacao.total, 3);
    ok(c86.itens.every((i) => i.itemId.startsWith("MLB86")), "conta 86 só vê a própria leitura");
    eq(c86.conta.id, 86);
    const volta = await ler(87, { ordenacao: "worklist" });
    eq(volta.paginacao.total, 60);
    eq(volta.conta.id, 87);

    // 4. Identidade: sem conta, conta de outro cliente e id inválido nunca leem nada.
    for (const [contaId, status] of [[undefined, 400], ["99", 403], ["abc", 400]]) {
      let erro = null;
      try { await readService.listarItens({ clienteSlug: "alianza_jeans", clienteContaId: contaId, page: 1, limit: 50 }, d); } catch (e) { erro = e; }
      eq(erro && erro.statusCode, status, `clienteContaId=${contaId}`);
    }

    // 5. Atualizar leitura: run sem heartbeat (crash do PG) aparece parado; um GET não muda o estado.
    await db.query(`INSERT INTO margin_snapshot_runs (cliente_id, cliente_slug, cliente_conta_id, marketplace, reason, status, total_items, processed_items, success_items, failed_items, cursor_offset, created_at, started_at, heartbeat_at)
      VALUES (133, 'alianza_jeans', 87, 'meli', 'manual_refresh', 'running', 60, 20, 20, 0, 20, NOW() - interval '9 minutes', NOW() - interval '9 minutes', NOW() - interval '8 minutes')`);
    const ativo = await runRepository.findActiveRunForAccount({ clienteId: 133, clienteContaId: 87, marketplace: "meli", db });
    const st = await apiService.obterStatusRefresh({ clienteSlug: "alianza_jeans", clienteContaId: "87", runId: String(ativo.id) }, { db, clienteContaService: contas });
    eq(st.run.status, "running");
    eq(st.run.parado, true);
    ok(st.run.semProgressoMinutos >= 8, String(st.run.semProgressoMinutos));
    const resumoDurante = await readService.obterResumo({ clienteSlug: "alianza_jeans", clienteContaId: "87" }, d);
    eq(resumoDurante.refresh.runAtivo.parado, true, "o resumo também avisa o run parado");
    eq(resumoDurante.kpis.total, 60, "leitura anterior continua íntegra durante o run parado");
    // O run de outra conta não é visível pela 86.
    let erro86 = null;
    try { await apiService.obterStatusRefresh({ clienteSlug: "alianza_jeans", clienteContaId: "86", runId: String(ativo.id) }, { db, clienteContaService: contas }); } catch (e) { erro86 = e; }
    eq(erro86 && erro86.statusCode, 404, "run da 87 não aparece para a 86");

    console.log(`centralMargemFluxoContas.postgres: ${checks} checks OK`);
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
