// server/tests/marginSnapshotFiltroOverrides.postgres.cjs
//
// P0 10/11/2026 — HTTP 500 em /snapshot/itens (Alianza Jeans 2, conta 87) contra
// PostgreSQL LOCAL descartável (fora do run-all: o fake DB não valida a contagem
// de parâmetros, que era exatamente o defeito):
//   MARGIN_TEST_DATABASE_URL=postgres://vf@127.0.0.1:55432/postgres node tests/marginSnapshotFiltroOverrides.postgres.cjs
// Nunca lê server/.env. Cria e apaga um banco próprio.

const assert = require("assert");
const { Client, Pool } = require("pg");

const baseUrl = process.env.MARGIN_TEST_DATABASE_URL;
if (!baseUrl) throw new Error("Defina MARGIN_TEST_DATABASE_URL (PostgreSQL local).");
const parsed = new URL(baseUrl);
if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("LOCAL_DATABASE_REQUIRED");

const dbName = `vf_margin_filtro_${Date.now()}`;
const testUrl = new URL(baseUrl);
testUrl.pathname = `/${dbName}`;
process.env.DATABASE_URL = testUrl.toString();

const repo = require("../services/motorMargem/marginSnapshotRepository");

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks += 1; };

async function main() {
  const admin = new Client({ connectionString: baseUrl, ssl: false });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const db = new Pool({ connectionString: testUrl.toString(), ssl: false, max: 2 });
  try {
    // Só as tabelas referenciadas pelas FKs do schema, com o mínimo de colunas.
    await db.query(`CREATE TABLE clientes (id BIGSERIAL PRIMARY KEY, slug TEXT);
      CREATE TABLE cliente_contas (id BIGSERIAL PRIMARY KEY, cliente_id BIGINT);
      CREATE TABLE bases (id BIGSERIAL PRIMARY KEY);
      CREATE TABLE users (id BIGSERIAL PRIMARY KEY);
      INSERT INTO clientes (id, slug) VALUES (133, 'alianza_jeans');
      INSERT INTO cliente_contas (id, cliente_id) VALUES (86, 133), (87, 133);`);
    await db.query(require("fs").readFileSync(require("path").join(__dirname, "../sql/margin_snapshot_schema.sql"), "utf8"));
    // Conta 87: 3 itens; MLB2 está em LOSS no snapshot mas o retorno ML o tira do prejuízo (override → HEALTHY).
    const linhas = [["MLB1", "LOSS", -5], ["MLB2", "LOSS", -1], ["MLB3", "HEALTHY", 30]];
    for (const [item, status, margem] of linhas) {
      await db.query(
        `INSERT INTO margin_projection_snapshots (cliente_id, cliente_conta_id, marketplace, item_id, titulo, price, profit, margin, margin_percent, status, refresh_status, calculated_at, observed_at)
         VALUES (133, 87, 'meli', $1, $1, 100, $2, $3, $2, $4, 'fresh', NOW(), NOW())`,
        [item, margem, margem / 100, status]
      );
    }
    // Conta 86 (mesmo cliente): nunca pode aparecer na leitura da 87.
    await db.query(`INSERT INTO margin_projection_snapshots (cliente_id, cliente_conta_id, marketplace, item_id, titulo, price, status, refresh_status, calculated_at, observed_at)
                    VALUES (133, 86, 'meli', 'MLB9', 'outra conta', 50, 'LOSS', 'fresh', NOW(), NOW())`);

    const overrides = { itemIds: ["MLB2"], statuses: ["HEALTHY"] };
    const base = { clienteId: 133, clienteContaId: 87, marketplace: "meli", statusOverrides: overrides };

    // 1. O caso do 500: overrides SEM filtro de status (count + página com cada ordenação).
    const filtro = repo.montarFiltroSnapshots(base);
    const contagem = await repo.countProjectionSnapshotsFiltrado({ filtro, db });
    ok(contagem.total === 3, `count com overrides sem filtro de status: ${contagem.total}`);
    for (const ordenacao of ["worklist", "margin_percent", "profit", "status", "titulo", "updated_at"]) {
      const ordem = repo.resolverOrdenacao({ ordenacao });
      const pagina = await repo.queryProjectionSnapshotsPage({ filtro, orderBy: ordem.orderBy, limit: 50, offset: 0, receitas: { MLB3: 999 }, db });
      ok(pagina.length === 3, `${ordenacao}: ${pagina.length} itens`);
    }
    // worklist usa o status EFETIVO: MLB1 (LOSS) primeiro; MLB2 (override HEALTHY) não é prejuízo.
    const wl = await repo.queryProjectionSnapshotsPage({ filtro, orderBy: repo.resolverOrdenacao({ ordenacao: "worklist" }).orderBy, limit: 50, offset: 0, receitas: { MLB3: 999 }, db });
    ok(wl[0].itemId === "MLB1", `worklist: prejuízo primeiro (${wl.map((r) => r.itemId)})`);
    ok(wl[1].itemId === "MLB3", "dentro do grupo, maior receita realizada primeiro");

    // 2. Overrides + busca (antes: "could not determine data type of parameter $4").
    const comBusca = repo.montarFiltroSnapshots({ ...base, busca: "MLB2" });
    ok((await repo.countProjectionSnapshotsFiltrado({ filtro: comBusca, db })).total === 1, "busca com overrides");
    // 3. Overrides + filtro por status usam o status efetivo.
    const soLoss = repo.montarFiltroSnapshots({ ...base, status: ["LOSS"] });
    ok((await repo.countProjectionSnapshotsFiltrado({ filtro: soLoss, db })).total === 1, "LOSS efetivo = só MLB1");
    // 4. KPIs com overrides.
    const kpis = await repo.summarizeProjectionSnapshots({ filtro, db });
    ok(kpis.total === 3 && kpis.porStatus.LOSS === 1 && kpis.porStatus.HEALTHY === 2, JSON.stringify(kpis.porStatus));
    // 5. Sem overrides: mesmo comportamento de antes.
    const semOverride = repo.montarFiltroSnapshots({ clienteId: 133, clienteContaId: 87, marketplace: "meli" });
    ok((await repo.countProjectionSnapshotsFiltrado({ filtro: semOverride, db })).total === 3, "sem overrides");
    // 6. Isolamento entre contas 86 × 87.
    const c86 = repo.montarFiltroSnapshots({ clienteId: 133, clienteContaId: 86, marketplace: "meli", statusOverrides: overrides });
    const p86 = await repo.queryProjectionSnapshotsPage({ filtro: c86, limit: 50, offset: 0, db });
    ok(p86.length === 1 && p86[0].itemId === "MLB9", "conta 86 só vê a própria linha");
    ok(!wl.some((r) => r.itemId === "MLB9"), "conta 87 nunca vê linha da 86");

    // 7. Unidade do compactador.
    const c = repo.compactarParametros("a = $1 AND b = $3 AND c = $1 LIMIT $5", ["x", "nao", "y", "nao", 9]);
    assert.deepStrictEqual(c, { sql: "a = $1 AND b = $2 AND c = $1 LIMIT $3", params: ["x", "y", 9] }); checks += 1;
    console.log(`marginSnapshotFiltroOverrides.postgres: ${checks} checks OK`);
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
