// server/tests/squadsDryRunZeroWrite.test.js
//
// V3 P2.9 — BLOQUEADOR T-3: o "dry-run" do tooling de migração NÃO era
// read-only.
//
// `validarPlano()` e `auditoria()` chamavam `ensureSquadsTables(db)`, que lê os
// arquivos de migration e os executa — CREATE TABLE, CREATE INDEX, ALTER. Ou
// seja: rodar o dry-run contra produção aplicava DDL em produção. O mesmo valia
// para `--audit`, que existe justamente para ser a leitura inofensiva.
//
// Isso é inaceitável antes de um dry-run contra o banco real: a disciplina de
// auditoria exige que "simular" não mude nada. A correção introduz o modo
// `{ garantirSchema: false }`, que:
//   - nunca executa migration;
//   - confirma a existência das tabelas com `to_regclass` (SELECT puro);
//   - devolve ERRO explícito se o schema não existir, em vez de criá-lo calado.
//
// O default continua `garantirSchema: true` — inverter quebraria chamadores
// existentes. O zero-write é opt-in, e `squads-migrate.js` opta por ele em
// todo caminho que não seja `--apply`.
//
// A prova aqui é mecânica: um fake de `db` que registra TODA query e reprova
// qualquer uma que case com escrita.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

/** Toda forma de escrita que o Postgres aceita, incluindo DDL. */
const PALAVRAS_ESCRITA =
  /^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|COMMENT|MERGE|REINDEX|VACUUM)\b/i;

/**
 * Um arquivo de migration tem VÁRIOS statements e começa com comentário `--`.
 * Olhar só o começo do texto deixaria passar exatamente o caso que este teste
 * existe para pegar. Então: tira os comentários dos dois estilos, quebra em
 * statements e testa a primeira palavra de cada um.
 */
function statements(sql) {
  return String(sql || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

function ehEscrita(sql) { return statements(sql).some((s) => PALAVRAS_ESCRITA.test(s)); }

/* ─────────────── fake de banco que registra tudo ─────────────── */

function novoDbGravador(respostas = {}) {
  const queries = [];
  const db = {
    queries,
    escritas: () => queries.filter((q) => ehEscrita(q.sql)),
    async query(sql, params) {
      queries.push({ sql: String(sql), params });
      for (const [marca, linhas] of Object.entries(respostas)) {
        if (String(sql).includes(marca)) return { rows: linhas };
      }
      // to_regclass: por padrão, todas as tabelas existem
      if (/to_regclass/i.test(sql)) {
        const nomes = (params && params[0]) || [];
        return { rows: nomes.map((n) => ({ nome: n, existe: true })) };
      }
      return { rows: [] };
    },
  };
  return db;
}

const AUDIT_VAZIO = {
  AUDIT_CLIENTES: [{ ativos: 3, com_squad_ativo: 3, em_squad_inativo: 0, sem_squad: 0 }],
  AUDIT_USUARIOS: [{
    internos: 2, com_membership: 2, sem_membership: 0, apenas_squad_inativo: 0,
    com_multiplas: 0, multi_squad_valido: 0, sem_principal: 0,
  }],
  AUDIT_TOTAIS_VACUIDADE: [{ squads_ativos: 2, memberships_ativas: 4 }],
};

const PLANO_MINIMO = {
  versao: 1,
  squads: [{ slug: "alpha", nome: "Alpha", ativo: true }],
  membros: [], clientes: [], responsaveis: [],
};

/* ────────────────────────────── testes ────────────────────────────── */

async function testarValidarPlano() {
  console.log("\nT-3 · validarPlano");
  const mod = require("../services/squads/squadsMigracaoImportService");

  // (a) modo DEFAULT: preserva o comportamento antigo — ainda garante schema.
  const dbDefault = novoDbGravador(AUDIT_VAZIO);
  await mod.validarPlano(PLANO_MINIMO, dbDefault);
  ok("default preserva compatibilidade: ainda executa DDL de schema",
    dbDefault.escritas().length > 0);

  // (b) modo ZERO-WRITE: nenhuma query de escrita, nenhuma.
  const dbZero = novoDbGravador(AUDIT_VAZIO);
  const r = await mod.validarPlano(PLANO_MINIMO, dbZero, { garantirSchema: false });
  const escritas = dbZero.escritas();
  ok(`validarPlano zero-write não emite escrita (emitiu ${escritas.length}: ${escritas.map((q) => q.sql.slice(0, 40)).join(" | ")})`,
    escritas.length === 0);
  ok("validarPlano zero-write ainda executou consultas", dbZero.queries.length > 0);
  ok("validarPlano zero-write devolve resultado utilizável", r && typeof r.ok === "boolean");
}

async function testarAuditoria() {
  console.log("\nT-3 · auditoria");
  const { auditoria } = require("../services/squads/squadsMigracaoService");

  const dbDefault = novoDbGravador(AUDIT_VAZIO);
  await auditoria(dbDefault);
  ok("default da auditoria preserva compatibilidade", dbDefault.escritas().length > 0);

  const dbZero = novoDbGravador(AUDIT_VAZIO);
  await auditoria(dbZero, { garantirSchema: false });
  const escritas = dbZero.escritas();
  ok(`auditoria zero-write não emite escrita (emitiu ${escritas.length}: ${escritas.map((q) => q.sql.slice(0, 40)).join(" | ")})`,
    escritas.length === 0);
}

async function testarSchemaAusente() {
  console.log("\nT-3 · schema ausente no modo zero-write");
  const mod = require("../services/squads/squadsMigracaoImportService");

  const db = novoDbGravador(AUDIT_VAZIO);
  const originalQuery = db.query.bind(db);
  db.query = async (sql, params) => {
    if (/to_regclass/i.test(sql)) {
      db.queries.push({ sql: String(sql), params });
      const nomes = (params && params[0]) || [];
      // 'squads' NÃO existe
      return { rows: nomes.map((n) => ({ nome: n, existe: n !== "squads" })) };
    }
    return originalQuery(sql, params);
  };

  const r = await mod.validarPlano(PLANO_MINIMO, db, { garantirSchema: false });
  ok("schema ausente → plano inválido", r.ok === false);
  ok("schema ausente → erro menciona o schema de Squads",
    (r.erros || []).some((e) => /schema/i.test(e.msg) && /squads/i.test(e.msg)));
  ok("schema ausente → NADA foi criado", db.escritas().length === 0);
}

async function testarApplyAindaGaranteSchema() {
  console.log("\nT-3 · o caminho de APPLY continua garantindo o schema");
  const mod = require("../services/squads/squadsMigracaoImportService");
  const db = novoDbGravador(AUDIT_VAZIO);
  db.connect = async () => ({
    query: async (sql, params) => db.query(sql, params),
    release: () => {},
  });

  // dryRun:false é o caminho de escrita legítima — ali DDL é permitido.
  await mod.importar(PLANO_MINIMO, { dryRun: false }, db);
  ok("apply executa DDL de schema (correção não quebrou o apply)",
    db.escritas().length > 0);
}

async function testarImportarDryRunZeroWrite() {
  console.log("\nT-3 · importar() em dry-run zero-write");
  const mod = require("../services/squads/squadsMigracaoImportService");
  const db = novoDbGravador(AUDIT_VAZIO);
  const r = await mod.importar(PLANO_MINIMO, { dryRun: true, garantirSchema: false }, db);
  const escritas = db.escritas();
  ok(`importar dry-run zero-write não emite escrita (emitiu ${escritas.length})`, escritas.length === 0);
  ok("importar dry-run continua reportando dryRun", r.dryRun === true);
  ok("importar dry-run não aplica", r.aplicado === false);
}

function testarDetectorDeEscrita() {
  console.log("\nT-3 · o próprio detector de escrita");
  ok("detecta CREATE TABLE", ehEscrita("CREATE TABLE x (id int)"));
  ok("detecta CREATE com comentário antes", ehEscrita("/* squads:MIG */ CREATE INDEX i ON t(x)"));
  ok("detecta INSERT/UPDATE/DELETE",
    ehEscrita("INSERT INTO t VALUES (1)") && ehEscrita("UPDATE t SET a=1") && ehEscrita("DELETE FROM t"));
  ok("detecta ALTER e DROP", ehEscrita("  alter table t add column c int") && ehEscrita("DROP TABLE t"));
  ok("NÃO acusa SELECT", !ehEscrita("SELECT 1"));
  ok("NÃO acusa SELECT com comentário", !ehEscrita("/* squads:AUDIT */ SELECT 1"));
  ok("NÃO acusa WITH/BEGIN/ROLLBACK",
    !ehEscrita("WITH a AS (SELECT 1) SELECT * FROM a") && !ehEscrita("BEGIN") && !ehEscrita("ROLLBACK"));
  // "CREATED_AT" não pode disparar o detector por acidente
  ok("NÃO acusa coluna chamada created_at", !ehEscrita("SELECT created_at FROM t"));
  ok("detecta escrita DEPOIS de comentário -- de arquivo de migration",
    ehEscrita("-- migration squads\n-- P2.9\nCREATE TABLE IF NOT EXISTS squads (id serial);"));
  ok("detecta escrita no 2o statement", ehEscrita("SELECT 1; CREATE INDEX i ON t(x);"));
}

(async () => {
  testarDetectorDeEscrita();
  await testarValidarPlano();
  await testarAuditoria();
  await testarSchemaAusente();
  await testarApplyAindaGaranteSchema();
  await testarImportarDryRunZeroWrite();
  console.log(`\n✔ squadsDryRunZeroWrite: ${checks} verificações OK\n`);
})().catch((e) => { console.error(e); process.exit(1); });
