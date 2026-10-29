// server/tests/helpers/centralVendasRetencaoPostgres.js
// Banco PostgreSQL LOCAL e descartável para os testes da retenção.
//
//   CENTRAL_VENDAS_RETENCAO_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57651/postgres
//
// Sem a variável os testes PULAM (exit 0). Host fora de localhost ⇒ recusa.
// Cria vf_retencao_test_<sufixo>, aplica fixtures mínimas + o schema real da
// Central (server/sql/central_vendas_schema.sql) e devolve helpers de seed.

const fs = require("fs");
const path = require("path");
const { Pool, Client } = require("pg");

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const FIXTURES = `
CREATE TABLE users (id integer PRIMARY KEY);
CREATE TABLE clientes (id integer PRIMARY KEY, nome text, slug text UNIQUE, ativo boolean DEFAULT true);
CREATE TABLE cliente_contas (id integer PRIMARY KEY, cliente_id integer REFERENCES clientes(id));
CREATE TABLE ml_tokens (id integer PRIMARY KEY);
CREATE TABLE bases (id integer PRIMARY KEY);
CREATE TABLE cliente_360_resumos_mensais (id serial PRIMARY KEY, cliente_id integer, cliente_slug text NOT NULL,
  competencia text NOT NULL, payload_json jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE cliente_360_sync_jobs (id serial PRIMARY KEY, cliente_id integer, cliente_slug text NOT NULL,
  competencia text NOT NULL, payload_json jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE entregas_cliente (id serial PRIMARY KEY, cliente_slug varchar(255), payload_json jsonb NOT NULL DEFAULT '{}'::jsonb);
INSERT INTO users VALUES (1);
INSERT INTO clientes VALUES (1, 'Loja', 'loja', true), (2, 'Outra', 'outra', true);
INSERT INTO cliente_contas VALUES (5, 1), (6, 1), (7, 2);
`;

const TABELAS = [
  "central_vendas_imports", "central_vendas_pedidos", "central_vendas_pedido_itens", "central_vendas_componentes",
  "central_vendas_sync_runs", "central_vendas_sync_sources", "central_vendas_mp_payments", "central_vendas_mp_payment_charges",
];

function urlDeTeste() {
  return process.env.CENTRAL_VENDAS_RETENCAO_TEST_DATABASE_URL || null;
}

async function criarAmbiente(prefixo) {
  const baseUrl = urlDeTeste();
  const host = new URL(baseUrl).hostname;
  console.log(`  banco de teste: host=${host}`);
  if (!LOCAL.has(host)) throw new Error("LOCAL_DATABASE_REQUIRED");
  const nome = `vf_retencao_test_${prefixo}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Client({ connectionString: baseUrl, ssl: false });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${nome}"`);
  const url = new URL(baseUrl);
  url.pathname = `/${nome}`;
  const pool = new Pool({ connectionString: url.toString(), ssl: false, max: 6 });
  pool.on("error", () => {});
  await pool.query(FIXTURES);
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "..", "sql", "central_vendas_schema.sql"), "utf8"));

  const q = async (sql, p) => (await pool.query(sql, p)).rows;

  async function criarRun({ status = "completed", conta = 5, slug = "loja", criadoHaDias = 30, terminadoHaDias = null } = {}) {
    const fim = terminadoHaDias ?? criadoHaDias;
    const [r] = await q(
      `INSERT INTO central_vendas_sync_runs (cliente_id, cliente_slug, cliente_conta_id, marketplace, date_from, date_to, status,
                                             created_at, finished_at)
       VALUES ((SELECT id FROM clientes WHERE slug = $2), $2, $1, 'meli', '2026-09-01', '2026-09-30', $3,
               NOW() - ($4 || ' days')::interval,
               CASE WHEN $3 IN ('completed','failed','cancelled') THEN NOW() - ($5 || ' days')::interval END)
       RETURNING id`,
      [conta, slug, status, String(criadoHaDias), String(fim)]
    );
    return Number(r.id);
  }

  async function criarImport({
    status = "published", competencia = "2026-09", conta = 5, slug = "loja", from = "2026-09-01", to = "2026-09-30",
    criadoHaDias = 30, publicadoHaDias = null, run = null, pedidos = 3,
  } = {}) {
    const pub = status === "published" ? (publicadoHaDias ?? criadoHaDias) : null;
    const [imp] = await q(
      `INSERT INTO central_vendas_imports (cliente_id, cliente_slug, marketplace, competencia, cliente_conta_id, publication_status,
                                           coverage_date_from, coverage_date_to, created_at, published_at, sync_run_id, payload_json)
       VALUES ((SELECT id FROM clientes WHERE slug = $1), $1, 'meli', $2, $3, $4, $5, $6,
               NOW() - ($7 || ' days')::interval,
               CASE WHEN $8::text IS NULL THEN NULL ELSE NOW() - ($8 || ' days')::interval END, $9, '{"x":1}'::jsonb)
       RETURNING id`,
      [slug, competencia, conta, status, from, to, String(criadoHaDias), pub == null ? null : String(pub), run]
    );
    const id = Number(imp.id);
    if (pedidos > 0) {
      await q(
        `INSERT INTO central_vendas_pedidos (import_id, cliente_id, cliente_slug, marketplace, competencia, pedido_id, confianca, data_pedido)
         SELECT $1, 1, $2, 'meli', $3::text, 'P' || g, 'alta', ($3::text || '-01')::date FROM generate_series(1, $4) g`,
        [id, slug, competencia, pedidos]
      );
      await q(
        `INSERT INTO central_vendas_pedido_itens (import_id, pedido_row_id, cliente_id, cliente_slug, marketplace, competencia, pedido_id, item_id, confianca)
         SELECT p.import_id, p.id, 1, p.cliente_slug, 'meli', p.competencia, p.pedido_id, p.pedido_id || '-I', 'alta'
           FROM central_vendas_pedidos p WHERE p.import_id = $1`,
        [id]
      );
      await q(
        `INSERT INTO central_vendas_componentes (import_id, pedido_row_id, item_row_id, cliente_id, cliente_slug, marketplace, competencia,
                                                 pedido_id, item_id, tipo, valor, confianca)
         SELECT i.import_id, i.pedido_row_id, i.id, 1, i.cliente_slug, 'meli', i.competencia, i.pedido_id, i.item_id, t.tipo, 10, 'alta'
           FROM central_vendas_pedido_itens i CROSS JOIN (VALUES ('receita'), ('tarifa')) t(tipo)
          WHERE i.import_id = $1`,
        [id]
      );
    }
    return id;
  }

  async function criarMp(runId, n = 2) {
    await q(
      `INSERT INTO central_vendas_mp_payments (sync_run_id, payment_id) SELECT $1::bigint, 'PAY' || $1::bigint || '-' || g FROM generate_series(1, $2) g`,
      [runId, n]
    );
    await q(
      `INSERT INTO central_vendas_mp_payment_charges (mp_payment_row_id, sync_run_id, payment_id, amount_original)
       SELECT p.id, p.sync_run_id, p.payment_id, 1.5 FROM central_vendas_mp_payments p CROSS JOIN generate_series(1, 2)
        WHERE p.sync_run_id = $1`,
      [runId]
    );
  }

  async function contar() {
    const out = {};
    for (const t of TABELAS) out[t] = Number((await q(`SELECT COUNT(*)::int AS n FROM ${t}`))[0].n);
    return out;
  }

  async function orfaos() {
    const [r] = await q(`
      SELECT
        (SELECT COUNT(*) FROM central_vendas_pedidos p WHERE NOT EXISTS (SELECT 1 FROM central_vendas_imports i WHERE i.id = p.import_id))::int AS pedidos,
        (SELECT COUNT(*) FROM central_vendas_pedido_itens x WHERE NOT EXISTS (SELECT 1 FROM central_vendas_imports i WHERE i.id = x.import_id)
            OR NOT EXISTS (SELECT 1 FROM central_vendas_pedidos p WHERE p.id = x.pedido_row_id))::int AS itens,
        (SELECT COUNT(*) FROM central_vendas_componentes c WHERE NOT EXISTS (SELECT 1 FROM central_vendas_imports i WHERE i.id = c.import_id)
            OR NOT EXISTS (SELECT 1 FROM central_vendas_pedido_itens x WHERE x.id = c.item_row_id))::int AS componentes,
        (SELECT COUNT(*) FROM central_vendas_mp_payment_charges c WHERE NOT EXISTS (SELECT 1 FROM central_vendas_mp_payments p WHERE p.id = c.mp_payment_row_id))::int AS charges`);
    return r;
  }

  async function encerrar() {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }

  return { pool, url: url.toString(), nome, q, criarRun, criarImport, criarMp, contar, orfaos, encerrar };
}

module.exports = { urlDeTeste, criarAmbiente };
