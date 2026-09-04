#!/usr/bin/env node
// server/sql/squads-consolidacao-auditoria.js
// VenForce V3 — P2.9 Real Mapping. Auditoria de CONSOLIDAÇÃO, estritamente READ-ONLY.
//
// Uso:
//   DATABASE_URL="postgres://READONLY:...@host/db" \
//     node server/sql/squads-consolidacao-auditoria.js --saida auditoria.json
//
// Responde ao que o inventário (squads-inventario-readonly.js) NÃO responde:
// o que aconteceria se dois registros de `clientes` fossem tratados como a
// mesma empresa. Para isso levanta, do banco real:
//
//   1. MATRIZ DE REFERÊNCIAS — toda tabela/coluna que referencia cliente_id ou
//      cliente_conta_id, COM ou SEM foreign key, e a regra ON DELETE de cada FK.
//      As colunas SEM FK são as perigosas: nada garante integridade nelas e a
//      consolidação precisa atualizá-las explicitamente.
//   2. CONTAGEM POR CLIENTE — quantas linhas cada cliente_id tem em cada uma
//      dessas tabelas. É o que prova que nada se perde.
//   3. COLISÕES DE CHAVE NATURAL — mesmo ml_user_id (grant) ou mesmo
//      external_account_id (conta) aparecendo sob clientes DIFERENTES. É a
//      única evidência objetiva de que duas entidades são a mesma empresa;
//      sufixo "2" no nome não é evidência.
//   4. PRESENÇA de api_key por cliente — booleano apenas. O valor NUNCA é lido.
//
// ══════════════════ GARANTIAS DE SEGURANÇA ══════════════════
//  1. `BEGIN; SET TRANSACTION READ ONLY;` — o Postgres recusa escrita.
//  2. Termina SEMPRE em ROLLBACK. Nunca COMMIT.
//  3. Só SELECT. Zero DDL. Não chama ensureSquadsTables().
//  4. Nomes de tabela/coluna vindos do information_schema são validados contra
//     /^[a-z_][a-z0-9_]*$/ e citados com aspas antes de entrar em SQL.
//  5. NUNCA seleciona: api_key, access_token, refresh_token, password.
//     A auditoria de api_key devolve apenas `tem_api_key: true|false`.
// ═════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

function linha(t = "") { process.stdout.write(t + "\n"); }

function parseArgs(argv) {
  const a = { saida: null, resumo: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--saida" || t === "-o") a.saida = argv[++i];
    else if (t === "--resumo") a.resumo = true;
    else if (t === "-h" || t === "--help") a.help = true;
  }
  return a;
}

function descreverDestino(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? ":" + u.port : ""}${u.pathname}`;
  } catch {
    return "(DATABASE_URL não parseável)";
  }
}

/* ── Identificadores: só aceitamos o que o Postgres devolveu e o que casa com
      o formato canônico. Qualquer outra coisa é recusada, não escapada. ── */
const IDENT_OK = /^[a-z_][a-z0-9_]*$/;

/** Colunas que esta ferramenta se recusa a ler, em qualquer tabela. */
const COLUNAS_PROIBIDAS = new Set([
  "api_key", "access_token", "refresh_token", "password", "senha", "secret",
]);

function citar(ident) {
  if (typeof ident !== "string" || !IDENT_OK.test(ident)) {
    throw new Error(`identificador recusado: ${JSON.stringify(ident)}`);
  }
  if (COLUNAS_PROIBIDAS.has(ident)) {
    throw new Error(`leitura proibida da coluna sensível: ${ident}`);
  }
  return `"${ident}"`;
}

/* ─────────────────────────── coleta ─────────────────────────── */

async function matrizReferencias(db) {
  const { rows: colunas } = await db.query(`
    SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema
       AND t.table_name  = c.table_name
       AND t.table_type  = 'BASE TABLE'
     WHERE c.table_schema = 'public'
       AND c.column_name IN ('cliente_id', 'cliente_conta_id')
     ORDER BY c.table_name, c.column_name`);

  const { rows: fks } = await db.query(`
    SELECT tc.table_name, kcu.column_name,
           ccu.table_name  AS ref_table,
           ccu.column_name AS ref_column,
           rc.delete_rule, rc.update_rule, tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema    = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
       AND ccu.table_schema    = tc.table_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name   = tc.constraint_name
       AND rc.constraint_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND tc.table_schema    = 'public'
       AND ccu.table_name IN ('clientes', 'cliente_contas')
     ORDER BY tc.table_name, kcu.column_name`);

  const porChave = new Map(fks.map((f) => [`${f.table_name}.${f.column_name}`, f]));

  return colunas.map((c) => {
    const fk = porChave.get(`${c.table_name}.${c.column_name}`) || null;
    return {
      tabela: c.table_name,
      coluna: c.column_name,
      tipo: c.data_type,
      nullable: c.is_nullable === "YES",
      temFk: Boolean(fk),
      referencia: fk ? `${fk.ref_table}.${fk.ref_column}` : null,
      onDelete: fk ? fk.delete_rule : null,
      onUpdate: fk ? fk.update_rule : null,
      constraint: fk ? fk.constraint_name : null,
    };
  });
}

/** Linhas por cliente_id (ou cliente_conta_id) em cada tabela referenciadora. */
async function contagensPorReferencia(db, matriz) {
  const out = [];
  for (const ref of matriz) {
    // cliente_contas.cliente_id e a própria clientes já vêm do inventário,
    // mas contamos igual: a matriz tem de ser auto-suficiente.
    const t = citar(ref.tabela);
    const c = citar(ref.coluna);
    const { rows } = await db.query(
      `SELECT ${c} AS chave, COUNT(*)::int AS linhas
         FROM ${t}
        WHERE ${c} IS NOT NULL
        GROUP BY ${c}
        ORDER BY ${c}`
    );
    const { rows: nulos } = await db.query(
      `SELECT COUNT(*)::int AS linhas FROM ${t} WHERE ${c} IS NULL`
    );
    out.push({
      tabela: ref.tabela,
      coluna: ref.coluna,
      total: rows.reduce((s, r) => s + r.linhas, 0),
      nulos: nulos[0].linhas,
      porChave: Object.fromEntries(rows.map((r) => [String(r.chave), r.linhas])),
    });
  }
  return out;
}

/**
 * Colisões de chave natural — a ÚNICA evidência objetiva de identidade.
 * Um mesmo ml_user_id sob dois clientes distintos significa: a mesma conta de
 * marketplace foi cadastrada duas vezes, sob duas entidades Cliente diferentes.
 */
async function colisoesChaveNatural(db, tabelas) {
  const out = { grants_ml_user_id: [], contas_external_account_id: [] };

  if (tabelas.get("ml_tokens")) {
    const { rows } = await db.query(`
      SELECT ml_user_id,
             ARRAY_AGG(DISTINCT cliente_id ORDER BY cliente_id) AS clientes,
             ARRAY_AGG(id ORDER BY id)                          AS grants,
             COUNT(DISTINCT cliente_id)::int                    AS clientes_distintos
        FROM ml_tokens
       WHERE ml_user_id IS NOT NULL
       GROUP BY ml_user_id
      HAVING COUNT(DISTINCT cliente_id) > 1
       ORDER BY ml_user_id`);
    out.grants_ml_user_id = rows;
  }

  if (tabelas.get("cliente_contas")) {
    const { rows } = await db.query(`
      SELECT external_account_id, marketplace,
             ARRAY_AGG(DISTINCT cliente_id ORDER BY cliente_id) AS clientes,
             ARRAY_AGG(id ORDER BY id)                          AS contas,
             COUNT(DISTINCT cliente_id)::int                    AS clientes_distintos
        FROM cliente_contas
       WHERE external_account_id IS NOT NULL AND external_account_id <> ''
       GROUP BY external_account_id, marketplace
      HAVING COUNT(DISTINCT cliente_id) > 1
       ORDER BY external_account_id`);
    out.contas_external_account_id = rows;
  }

  return out;
}

/** Presença de api_key — booleano. O valor nunca sai do banco. */
async function presencaApiKey(db) {
  const { rows } = await db.query(`
    SELECT id,
           (api_key IS NOT NULL AND api_key <> '') AS tem_api_key,
           LENGTH(COALESCE(api_key, ''))::int      AS tamanho_api_key
      FROM clientes
     ORDER BY id`);
  return rows;
}

const TABELAS_INTERESSE = [
  "clientes", "cliente_contas", "ml_tokens", "bases", "base_cliente_vinculos",
  "squads", "squad_members", "cliente_squad_history", "cliente_responsaveis",
];

async function existentes(db, nomes) {
  const { rows } = await db.query(
    `SELECT t AS nome, to_regclass('public.' || t) IS NOT NULL AS existe
       FROM unnest($1::text[]) AS t`, [nomes]);
  return new Map(rows.map((r) => [r.nome, r.existe]));
}

async function coletar(db) {
  const tabelas = await existentes(db, TABELAS_INTERESSE);
  const matriz = await matrizReferencias(db);
  return {
    geradoEm: new Date().toISOString(),
    origem: "squads-consolidacao-auditoria.js",
    matrizReferencias: matriz,
    contagens: await contagensPorReferencia(db, matriz),
    colisoes: await colisoesChaveNatural(db, tabelas),
    apiKeys: await presencaApiKey(db),
  };
}

/* ─────────────── análise (pura, sem banco) ─────────────── */

/** Referências sem FK: nada garante integridade — a consolidação tem de tratá-las. */
function referenciasSemFk(auditoria) {
  return (auditoria.matrizReferencias || []).filter((r) => !r.temFk);
}

/** FKs que DESTROEM dados se o cliente for deletado. Justifica "não deletar". */
function referenciasCascade(auditoria) {
  return (auditoria.matrizReferencias || []).filter((r) => r.onDelete === "CASCADE");
}

/** Soma de linhas de um conjunto de cliente_ids, por tabela. */
function linhasDoCluster(auditoria, clienteIds) {
  const ids = new Set(clienteIds.map(String));
  const out = {};
  for (const c of auditoria.contagens || []) {
    if (c.coluna !== "cliente_id") continue;
    let n = 0;
    for (const [k, v] of Object.entries(c.porChave)) if (ids.has(k)) n += v;
    if (n > 0) out[c.tabela] = n;
  }
  return out;
}

function resumir(auditoria) {
  const semFk = referenciasSemFk(auditoria);
  const cascade = referenciasCascade(auditoria);
  return {
    referencias: {
      total: (auditoria.matrizReferencias || []).length,
      comFk: (auditoria.matrizReferencias || []).length - semFk.length,
      semFk: semFk.length,
      semFkLista: semFk.map((r) => `${r.tabela}.${r.coluna}`),
      onDeleteCascade: cascade.length,
      onDeleteCascadeLista: cascade.map((r) => `${r.tabela}.${r.coluna}`),
    },
    colisoes: {
      grantsMesmoMlUserId: (auditoria.colisoes?.grants_ml_user_id || []).length,
      contasMesmoExternalId: (auditoria.colisoes?.contas_external_account_id || []).length,
    },
    apiKeys: {
      clientes: (auditoria.apiKeys || []).length,
      comApiKey: (auditoria.apiKeys || []).filter((r) => r.tem_api_key).length,
    },
  };
}

/* ─────────────────────────────── main ─────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    linha(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 40)
      .join("\n").replace(/^\/\/ ?/gm, "").trimEnd());
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("Erro: DATABASE_URL não definida.");
    console.error("Esta ferramenta é READ-ONLY, mas exige destino explícito.");
    process.exit(1);
  }

  linha(`[consolidacao] destino: ${descreverDestino(process.env.DATABASE_URL)}`);
  linha(`[consolidacao] modo: TRANSAÇÃO READ ONLY — termina em ROLLBACK, nunca COMMIT.`);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  const client = await pool.connect();
  let auditoria;
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    auditoria = await coletar(client);
  } finally {
    try { await client.query("ROLLBACK"); } catch { /* sessão já encerrada */ }
    client.release();
    await pool.end();
  }

  auditoria.resumo = resumir(auditoria);

  if (args.saida) {
    fs.writeFileSync(path.resolve(args.saida), JSON.stringify(auditoria, null, 2) + "\n", "utf8");
    linha(`[consolidacao] escrito em ${path.resolve(args.saida)}`);
  }
  if (args.resumo || !args.saida) {
    linha("");
    linha(JSON.stringify(auditoria.resumo, null, 2));
  }
}

module.exports = {
  citar, IDENT_OK, COLUNAS_PROIBIDAS, descreverDestino,
  referenciasSemFk, referenciasCascade, linhasDoCluster, resumir,
};

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
