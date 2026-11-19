// server/services/sentinel/sentinelSchema.js
// Aplica sql/migrations/20261023_sentinel_pedidos.sql + 20261027_sentinel_v0a.sql com o mesmo runner das
// migrations versionadas do boot (schemaEnsure.aplicarMigrationSerializada):
// BEGIN → pg_advisory_xact_lock → DDL → COMMIT. Single-flight por db.

const fs = require("fs");
const path = require("path");
const { aplicarMigrationSerializada, migrationsDir } = require("../schema/schemaEnsure");

const SENTINEL_MIGRATION = "20261023_sentinel_pedidos.sql";
const SENTINEL_LOCK_KEY = "vf:schema:sentinel_pedidos";
// V0-a: aditiva sobre a anterior (payload_hash, atraso do checkpoint, exceções).
const SENTINEL_V0A_MIGRATION = "20261027_sentinel_v0a.sql";
const SENTINEL_V0A_LOCK_KEY = "vf:schema:sentinel_v0a";
const emCurso = new WeakMap();

function sentinelDdl() {
  return fs.readFileSync(path.join(migrationsDir, SENTINEL_MIGRATION), "utf8");
}

function sentinelV0aDdl() {
  return fs.readFileSync(path.join(migrationsDir, SENTINEL_V0A_MIGRATION), "utf8");
}

function ensureSentinelSchema(db) {
  if (!db || typeof db.query !== "function") throw new Error("ensureSentinelSchema exige `db` explícito (pool próprio do Sentinel).");
  const chave = db;
  const atual = emCurso.get(chave);
  if (atual) return atual;
  const promessa = (async () => {
    await aplicarMigrationSerializada(chave, sentinelDdl(), SENTINEL_LOCK_KEY);
    await aplicarMigrationSerializada(chave, sentinelV0aDdl(), SENTINEL_V0A_LOCK_KEY);
  })();
  emCurso.set(chave, promessa);
  promessa.catch(() => emCurso.delete(chave));
  return promessa;
}

// Verificação SOMENTE LEITURA (nenhum DDL): o worker e o run-once usam esta por
// padrão — aplicar a migration é etapa separada, com aprovação explícita
// (run-once --aplicar-schema ou psql -f).
const TABELAS_OBRIGATORIAS = ["sentinel_pedidos", "sentinel_checkpoints", "sentinel_pedido_excecoes"];
const COLUNAS_OBRIGATORIAS = [
  ["sentinel_pedidos", "payload_hash"],
  ["sentinel_checkpoints", "atraso_segundos"],
  ["sentinel_checkpoints", "atraso_medido_em"],
  ["sentinel_checkpoints", "ciclos_sem_progresso"],
];

async function verificarSentinelSchema(db) {
  if (!db || typeof db.query !== "function") throw new Error("verificarSentinelSchema exige `db` explícito (pool próprio do Sentinel).");
  const faltando = [];
  const tabelas = await db.query(
    "SELECT t AS nome, to_regclass('public.' || t) IS NOT NULL AS existe FROM unnest($1::text[]) AS t", [TABELAS_OBRIGATORIAS]);
  const existentes = new Set(tabelas.rows.filter((r) => r.existe).map((r) => r.nome));
  for (const t of TABELAS_OBRIGATORIAS) if (!existentes.has(t)) faltando.push(`tabela ${t}`);
  const cols = await db.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, [TABELAS_OBRIGATORIAS]);
  const colunas = new Set(cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
  for (const [t, c] of COLUNAS_OBRIGATORIAS) {
    if (existentes.has(t) && !colunas.has(`${t}.${c}`)) faltando.push(`coluna ${t}.${c}`);
  }
  if (faltando.length) {
    const err = new Error(`Schema do Sentinel ausente/incompleto (migrations 20261023 e 20261027 não aplicadas): ${faltando.join(", ")}.`);
    err.code = "SENTINEL_SCHEMA_AUSENTE";
    err.faltando = faltando;
    throw err;
  }
  return { ok: true };
}

// V0-b: incidentes. SEPARADA de propósito: o worker de coleta não depende dela
// (verificarSentinelSchema não a exige); sem as tabelas, a avaliação de
// incidentes é pulada e a coleta segue igual.
const SENTINEL_INCIDENTES_MIGRATION = "20261028_sentinel_incidentes.sql";
const SENTINEL_INCIDENTES_LOCK_KEY = "vf:schema:sentinel_incidentes";

async function ensureSentinelIncidentesSchema(db) {
  if (!db || typeof db.query !== "function") throw new Error("ensureSentinelIncidentesSchema exige `db` explícito.");
  const ddl = fs.readFileSync(path.join(migrationsDir, SENTINEL_INCIDENTES_MIGRATION), "utf8");
  await aplicarMigrationSerializada(db, ddl, SENTINEL_INCIDENTES_LOCK_KEY);
}

// Somente leitura: as duas tabelas de incidentes existem?
async function incidentesDisponiveis(db) {
  const r = await db.query(
    "SELECT to_regclass('public.sentinel_incidentes') IS NOT NULL AND to_regclass('public.sentinel_incidente_eventos') IS NOT NULL AS ok");
  return r.rows[0]?.ok === true;
}

// Evidência financeira (modo sombra): SEPARADA de propósito, como a de incidentes. O worker de coleta NÃO depende
// dela (verificarSentinelSchema não a exige); sem as colunas, a coleta segue no SQL legado. Aplicar é etapa
// manual e autorizada (aplicarMigrationSerializada); aqui só há leitura (information_schema).
const SENTINEL_EVIDENCIA_MIGRATION = "20261117_sentinel_evidencia_financeira.sql";
const SENTINEL_EVIDENCIA_LOCK_KEY = "vf:schema:sentinel_evidencia_financeira";
const EVIDENCIA_COLUNAS = Object.freeze(["calculo_versao", "afirmacao_financeira", "evidencia_financeira"]);
const EVIDENCIA_TTL_AUSENTE_MS = 60000;
const evidenciaCache = new WeakMap();

// Esquece o cache (ex.: coluna sumiu depois de ter sido vista — rollback manual com o worker no ar).
function invalidarEvidenciaSchema(db) {
  if (db && typeof db === "object") evidenciaCache.delete(db);
}

async function ensureSentinelEvidenciaSchema(db) {
  if (!db || typeof db.query !== "function") throw new Error("ensureSentinelEvidenciaSchema exige `db` explícito.");
  const ddl = fs.readFileSync(path.join(migrationsDir, SENTINEL_EVIDENCIA_MIGRATION), "utf8");
  await aplicarMigrationSerializada(db, ddl, SENTINEL_EVIDENCIA_LOCK_KEY);
  evidenciaCache.delete(db);
}

// Somente leitura. Presente ⇒ cache permanente (colunas não somem); ausente ⇒ reavaliada após o TTL (a migration
// pode ser aplicada com o worker no ar). Erro de consulta ⇒ false (nunca derruba a coleta) e NÃO é memorizado.
async function evidenciaSchemaPronto(db, { agora = Date.now(), ttlMs = EVIDENCIA_TTL_AUSENTE_MS } = {}) {
  if (!db || typeof db.query !== "function") return false;
  const c = evidenciaCache.get(db);
  if (c && (c.ok || agora - c.em < ttlMs)) return c.ok;
  try {
    const r = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'sentinel_pedidos' AND column_name = ANY($1::text[])`,
      [EVIDENCIA_COLUNAS]);
    const nomes = new Set(r.rows.map((x) => x.column_name));
    const ok = EVIDENCIA_COLUNAS.every((n) => nomes.has(n));
    evidenciaCache.set(db, { ok, em: agora });
    return ok;
  } catch (err) {
    console.warn(`[sentinel] verificação do schema de evidência falhou (${String(err?.message || err).slice(0, 120)}); seguindo sem evidência.`);
    return false;
  }
}

// Conciliação da comissão (S1): SEPARADA, como a de incidentes/evidência. O polling NÃO depende dela; o coletor de
// Billing (sentinelConciliacaoColetor) suspende sozinho sem as tabelas. Aplicar é etapa manual e autorizada.
const SENTINEL_CONCILIACAO_MIGRATION = "20261119_sentinel_conciliacao_comissao.sql";
const SENTINEL_CONCILIACAO_LOCK_KEY = "vf:schema:sentinel_conciliacao_comissao";

async function ensureSentinelConciliacaoSchema(db) {
  if (!db || typeof db.query !== "function") throw new Error("ensureSentinelConciliacaoSchema exige `db` explícito.");
  const ddl = fs.readFileSync(path.join(migrationsDir, SENTINEL_CONCILIACAO_MIGRATION), "utf8");
  await aplicarMigrationSerializada(db, ddl, SENTINEL_CONCILIACAO_LOCK_KEY);
}

// Somente leitura e SEM cache (1 consulta barata por execução): as duas tabelas existem? Erro ⇒ false (nunca lança),
// salvo { lancar: true } (o coletor: banco fora do ar NÃO pode ser confundido com "migration ausente").
async function conciliacaoSchemaPronto(db, { lancar = false } = {}) {
  if (!db || typeof db.query !== "function") return false;
  if (lancar) {
    const r = await db.query(
      "SELECT to_regclass('public.sentinel_conciliacao_comissao') IS NOT NULL AND to_regclass('public.sentinel_conciliacao_controle') IS NOT NULL AS ok");
    return r.rows[0]?.ok === true;
  }
  try {
    const r = await db.query(
      "SELECT to_regclass('public.sentinel_conciliacao_comissao') IS NOT NULL AND to_regclass('public.sentinel_conciliacao_controle') IS NOT NULL AS ok");
    return r.rows[0]?.ok === true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  ensureSentinelConciliacaoSchema,
  conciliacaoSchemaPronto,
  SENTINEL_CONCILIACAO_MIGRATION,
  SENTINEL_CONCILIACAO_LOCK_KEY,
  ensureSentinelEvidenciaSchema,
  evidenciaSchemaPronto,
  invalidarEvidenciaSchema,
  EVIDENCIA_COLUNAS,
  SENTINEL_EVIDENCIA_MIGRATION,
  SENTINEL_EVIDENCIA_LOCK_KEY,
  ensureSentinelIncidentesSchema,
  incidentesDisponiveis,
  SENTINEL_INCIDENTES_MIGRATION,
  ensureSentinelSchema,
  verificarSentinelSchema,
  SENTINEL_MIGRATION,
  SENTINEL_LOCK_KEY,
  SENTINEL_V0A_MIGRATION,
  SENTINEL_V0A_LOCK_KEY,
};
