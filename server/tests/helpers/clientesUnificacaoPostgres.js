const { Pool } = require("pg");
const fs = require("node:fs"),
  path = require("node:path");
const fixtureSQL = `
CREATE TABLE users(id integer PRIMARY KEY,role text NOT NULL,ativo boolean NOT NULL);
CREATE TABLE clientes(id integer PRIMARY KEY,nome text,slug text UNIQUE,api_key text,ativo boolean,created_at timestamptz DEFAULT now());
CREATE TABLE cliente_contas(id integer PRIMARY KEY,cliente_id integer REFERENCES clientes(id),marketplace text,nome text,slug text UNIQUE,external_account_id text,is_primary boolean,ativo boolean);
CREATE UNIQUE INDEX uq_cliente_contas_external_account ON cliente_contas(cliente_id,marketplace,external_account_id) WHERE external_account_id IS NOT NULL;
CREATE UNIQUE INDEX uq_cliente_contas_primary_por_marketplace ON cliente_contas(cliente_id,marketplace) WHERE is_primary AND ativo;
CREATE TABLE ml_tokens(id integer PRIMARY KEY,cliente_id integer REFERENCES clientes(id),cliente_conta_id integer REFERENCES cliente_contas(id),ml_user_id text,token_status text,is_primary boolean,access_token text,refresh_token text);
CREATE UNIQUE INDEX ml_tokens_cliente_ml_user_unique ON ml_tokens(cliente_id,ml_user_id);
CREATE UNIQUE INDEX ml_tokens_one_primary_per_cliente ON ml_tokens(cliente_id) WHERE is_primary = true;
CREATE TABLE bases(id integer PRIMARY KEY,nome text,slug text,marketplace text,ativo boolean);
CREATE TABLE base_cliente_vinculos(id integer PRIMARY KEY,cliente_id integer REFERENCES clientes(id),cliente_conta_id integer REFERENCES cliente_contas(id),base_id integer REFERENCES bases(id),marketplace text,ativo boolean);
CREATE UNIQUE INDEX uq_base_ativo ON base_cliente_vinculos(base_id) WHERE ativo = true;
CREATE TABLE squads(id integer PRIMARY KEY,nome text,slug text,ativo boolean);
CREATE TABLE squad_members(id integer PRIMARY KEY,squad_id integer REFERENCES squads(id),user_id integer REFERENCES users(id),funcao text,ativo boolean,is_primary boolean);
CREATE TABLE cliente_squad_history(id integer PRIMARY KEY,cliente_id integer REFERENCES clientes(id),squad_id integer REFERENCES squads(id),fim_em timestamptz);
CREATE UNIQUE INDEX uq_squad_atual ON cliente_squad_history(cliente_id) WHERE fim_em IS NULL;
CREATE TABLE cliente_responsaveis(id integer PRIMARY KEY,cliente_id integer REFERENCES clientes(id),user_id integer REFERENCES users(id),papel text,ativo boolean);
CREATE TABLE seller_clientes(id integer PRIMARY KEY,cliente_id integer REFERENCES clientes(id),user_id integer REFERENCES users(id),marketplace text,ativo boolean);
CREATE TABLE activity_logs(id bigserial PRIMARY KEY,user_id integer REFERENCES users(id),acao text,detalhes text,status text);
CREATE TABLE painel_contas_lancamentos_manuais(id integer PRIMARY KEY,cliente_id integer REFERENCES clientes(id),cliente_conta_id integer REFERENCES cliente_contas(id),competencia text,faturamento numeric);
CREATE UNIQUE INDEX uq_manual ON painel_contas_lancamentos_manuais(cliente_conta_id,competencia);
CREATE TABLE margin_projection_snapshots(id integer PRIMARY KEY,cliente_id integer REFERENCES clientes(id),cliente_conta_id integer REFERENCES cliente_contas(id),marketplace text,item_id text,base_id integer REFERENCES bases(id),profit numeric);
CREATE UNIQUE INDEX uq_margin ON margin_projection_snapshots(cliente_id,cliente_conta_id,marketplace,item_id);
CREATE TABLE ads_resumos_mensais(id integer PRIMARY KEY,cliente_slug text,mes_ref text,loja_campanha text,investimento_ads numeric);
CREATE UNIQUE INDEX uq_ads ON ads_resumos_mensais(cliente_slug,mes_ref,loja_campanha);
`;
async function environment() {
  const url = process.env.UNIFICACAO_TEST_DATABASE_URL;
  if (!url)
    throw new Error(
      "Set UNIFICACAO_TEST_DATABASE_URL to an explicitly isolated local PostgreSQL",
    );
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    !/^\/vf_unificacao_test_[a-z0-9_]+$/.test(parsed.pathname)
  )
    throw new Error("LOCAL_ISOLATED_DATABASE_REQUIRED");
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = new Pool({
    connectionString: adminUrl.toString(),
    ssl: false,
    max: 1,
  });
  const database = parsed.pathname.slice(1);
  await admin.query('CREATE DATABASE "' + database + '"');
  const pool = new Pool({
    connectionString: url,
    ssl: false,
    max: 8,
    connectionTimeoutMillis: 2000,
  });
  try {
    await pool.query(fixtureSQL);
    const sql = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../sql/migrations/20261014_clientes_unificacao_executor.sql",
      ),
      "utf8",
    );
    await pool.query(sql);
    await pool.query(sql); // DDL idempotente; nenhum backfill.
  } catch (e) {
    await pool.end();
    await admin.query('DROP DATABASE "' + database + '"');
    await admin.end();
    throw e;
  }
  async function seed({ extra = false } = {}) {
    // Reset administrativo exclusivamente no banco LOCAL descartável acima.
    await pool.query(
      "ALTER TABLE cliente_unificacoes DISABLE TRIGGER cliente_unificacoes_no_truncate; ALTER TABLE cliente_unificacao_events DISABLE TRIGGER cliente_unificacao_events_no_truncate",
    );
    await pool.query(
      "TRUNCATE cliente_unificacao_events,cliente_unificacoes,activity_logs,painel_contas_lancamentos_manuais,margin_projection_snapshots,ads_resumos_mensais,cliente_responsaveis,seller_clientes,cliente_squad_history,squad_members,base_cliente_vinculos,ml_tokens,cliente_contas,bases,clientes,squads,users RESTART IDENTITY CASCADE",
    );
    await pool.query(
      "ALTER TABLE cliente_unificacoes ENABLE TRIGGER cliente_unificacoes_no_truncate; ALTER TABLE cliente_unificacao_events ENABLE TRIGGER cliente_unificacao_events_no_truncate",
    );
    await pool.query(`INSERT INTO users VALUES(5,'admin',true),(6,'user',true);
INSERT INTO clientes(id,nome,slug,api_key,ativo) VALUES(1,'Canônico sintético','canonico','SECRET_API_KEY',true),(2,'Legado sintético','legado','SECRET_API_KEY_2',true),(3,'Terceiro sintético','terceiro','SECRET_API_KEY_3',true),(4,'Independente sintético','independente','SECRET_API_KEY_4',true);
INSERT INTO cliente_contas VALUES(11,1,'meli','ML1','c1','111',true,true),(21,2,'meli','ML2','c2','222',true,true),(31,3,'shopee','SP1','c3',null,true,true),(41,4,'shopee','SP2','c4',null,false,true);
INSERT INTO ml_tokens VALUES(31,1,11,'111','valid',true,'SECRET_ACCESS_1','SECRET_REFRESH_1'),(32,2,21,'222','valid',true,'SECRET_ACCESS_2','SECRET_REFRESH_2');
INSERT INTO bases VALUES(41,'Base1','base1','meli',true),(42,'Base2','base2','meli',true);
INSERT INTO base_cliente_vinculos VALUES(51,1,11,41,'meli',true),(52,2,21,42,'meli',true);
INSERT INTO squads VALUES(20,'Squad sintético','squad',true);
INSERT INTO cliente_squad_history VALUES(71,1,20,null),(72,2,20,null),(73,3,20,null),(74,4,20,null);
INSERT INTO squad_members VALUES(1,20,6,'analista',true,true);`);
    if (extra)
      await pool.query(
        "INSERT INTO painel_contas_lancamentos_manuais VALUES(90,2,21,'2026-01',123.45);INSERT INTO margin_projection_snapshots VALUES(91,2,21,'meli','ITEM-SINTETICO',42,67.89);INSERT INTO ads_resumos_mensais VALUES(92,'legado','2026-01','todas',10.25)",
      );
  }
  return {
    pool,
    seed,
    close: async () => {
      await pool.end();
      await admin.query('DROP DATABASE "' + database + '"');
      await admin.end();
    },
  };
}
module.exports = { environment };
