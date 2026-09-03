#!/usr/bin/env node
// server/sql/squads-inventario-readonly.js
// VenForce V3 — P2.9 Real Data Readiness. Inventário ESTRITAMENTE READ-ONLY.
//
// Uso:
//   DATABASE_URL="postgres://READONLY:...@host/db" \
//     node server/sql/squads-inventario-readonly.js --saida inventario.json
//
//   node server/sql/squads-inventario-readonly.js --saida inv.json --resumo
//
// Produz, numa única passada, TODO o inventário que P2.9 precisa e que NÃO
// depende da relação humana (BLOCOS A, B, C, E, F, G, H, I da missão):
//   clientes · cliente_contas · usuários · estado do schema de Squads ·
//   Grants (ml_tokens) · Bases (base_cliente_vinculos) · duplicatas D4 ·
//   responsabilidades.
//
// A saída alimenta o pré-validador:
//   node server/sql/squads-preflight-relacao.js --relacao <rel> --inventario inventario.json
//
// ══════════════════ GARANTIAS DE SEGURANÇA ══════════════════
//  1. Abre `BEGIN; SET TRANSACTION READ ONLY;` — o próprio Postgres recusa
//     qualquer escrita, mesmo por engano.
//  2. Termina SEMPRE em ROLLBACK. Nunca COMMIT.
//  3. Só executa SELECT. Zero DDL.
//  4. NÃO chama ensureSquadsTables() — essa função reaplica migrations (DDL) e
//     seria escrita. Tabelas ausentes são detectadas com to_regclass().
//  5. NÃO carrega server/.env por conta própria: a DATABASE_URL tem de ser
//     fornecida explicitamente pelo operador, e o host é impresso antes de
//     qualquer consulta.
// ═════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { ROLES_COBRADAS_NA_AUDITORIA } = require("../services/squads/rolesInternas");

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

// Descreve o destino sem jamais imprimir usuário/senha.
function descreverDestino(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? ":" + u.port : ""}${u.pathname}`;
  } catch {
    return "(DATABASE_URL não parseável)";
  }
}

const TABELAS = [
  "clientes", "cliente_contas", "users", "ml_tokens", "bases",
  "base_cliente_vinculos", "entregas_cliente", "squads", "squad_members",
  "cliente_squad_history", "cliente_responsaveis", "cliente_contas_pendencias",
];

async function existentes(db) {
  const { rows } = await db.query(
    `SELECT t AS nome, to_regclass('public.' || t) IS NOT NULL AS existe
       FROM unnest($1::text[]) AS t`,
    [TABELAS]
  );
  return new Map(rows.map((r) => [r.nome, r.existe]));
}

// Executa só se a tabela existir; caso contrário devolve [] e registra ausência.
async function selecionar(db, tabelas, nome, sql, params = []) {
  if (!tabelas.get(nome)) return null;
  const { rows } = await db.query(sql, params);
  return rows;
}

async function coletar(db) {
  const tabelas = await existentes(db);
  const inv = {
    geradoEm: new Date().toISOString(),
    origem: "squads-inventario-readonly.js",
    schema: { tabelas: Object.fromEntries(tabelas) },
  };

  /* ── BLOCO A — clientes ── */
  inv.clientes = (await selecionar(db, tabelas, "clientes", `
    SELECT c.id, c.slug, c.nome, c.ativo,
           COALESCE(COUNT(cc.id), 0)::int                                   AS contas_total,
           COALESCE(COUNT(cc.id) FILTER (WHERE cc.ativo), 0)::int           AS contas_ativas,
           COALESCE(COUNT(cc.id) FILTER (WHERE NOT cc.ativo), 0)::int       AS contas_inativas,
           COALESCE(ARRAY_REMOVE(ARRAY_AGG(DISTINCT cc.marketplace)
                    FILTER (WHERE cc.ativo), NULL), '{}')                   AS marketplaces_ativos
      FROM clientes c
      LEFT JOIN cliente_contas cc ON cc.cliente_id = c.id
     GROUP BY c.id, c.slug, c.nome, c.ativo
     ORDER BY c.nome ASC`)) || [];

  /* ── BLOCO B — cliente_contas ── */
  inv.cliente_contas = (await selecionar(db, tabelas, "cliente_contas", `
    SELECT id, cliente_id, marketplace, nome, slug, external_account_id,
           is_primary, ativo, created_at
      FROM cliente_contas
     ORDER BY cliente_id ASC, marketplace ASC, id ASC`)) || [];

  /* ── BLOCO C — usuários ── */
  inv.usuarios = (await selecionar(db, tabelas, "users", `
    SELECT id, nome, email, role, ativo
      FROM users
     ORDER BY id ASC`)) || [];

  /* ── BLOCO E — estado do schema de Squads ── */
  inv.squads = (await selecionar(db, tabelas, "squads", `
    SELECT id, slug, nome, ativo FROM squads ORDER BY id ASC`)) || [];
  inv.squad_members = (await selecionar(db, tabelas, "squad_members", `
    SELECT id, squad_id, user_id, is_primary, funcao, ativo
      FROM squad_members ORDER BY id ASC`)) || [];
  inv.cliente_squad_history = (await selecionar(db, tabelas, "cliente_squad_history", `
    SELECT id, cliente_id, squad_id, inicio_em, fim_em, motivo
      FROM cliente_squad_history ORDER BY id ASC`)) || [];

  /* ── BLOCO I — responsabilidades (inclui histórico encerrado) ── */
  inv.cliente_responsaveis = (await selecionar(db, tabelas, "cliente_responsaveis", `
    SELECT id, cliente_id, user_id, papel, ativo, encerrado_em, motivo
      FROM cliente_responsaveis ORDER BY cliente_id ASC, id ASC`)) || [];

  /* ── BLOCO F — Grants (ml_tokens). NUNCA seleciona access/refresh token. ── */
  inv.grants = (await selecionar(db, tabelas, "ml_tokens", `
    SELECT id, cliente_id, cliente_conta_id, ml_user_id, is_primary,
           token_status, refresh_failures, (expires_at < NOW()) AS expirado
      FROM ml_tokens
     ORDER BY cliente_id ASC, id ASC`)) || [];

  /* ── BLOCO G — Bases ── */
  inv.base_vinculos = (await selecionar(db, tabelas, "base_cliente_vinculos", `
    SELECT v.id, v.base_id, b.slug AS base_slug, v.cliente_id, v.cliente_conta_id,
           v.marketplace, v.origem, v.ativo
      FROM base_cliente_vinculos v
      LEFT JOIN bases b ON b.id = v.base_id
     ORDER BY v.cliente_id ASC, v.id ASC`)) || [];

  /* ── BLOCO H — duplicatas D4 de fechamento_mensal ── */
  inv.d4_duplicatas = (await selecionar(db, tabelas, "entregas_cliente", `
    SELECT cliente_id, cliente_conta_id, periodo,
           COUNT(*)::int                              AS total,
           COUNT(*) FILTER (WHERE publicado)::int     AS publicadas,
           ARRAY_AGG(id ORDER BY created_at DESC)     AS ids
      FROM entregas_cliente
     WHERE tipo = 'fechamento_mensal'
       AND periodo IS NOT NULL
       AND cliente_id IS NOT NULL
     GROUP BY cliente_id, cliente_conta_id, periodo
    HAVING COUNT(*) > 1
     ORDER BY COUNT(*) DESC`)) || [];

  /* ── Ambiguidades já registradas pelo próprio sistema ── */
  inv.pendencias_contas = (await selecionar(db, tabelas, "cliente_contas_pendencias", `
    SELECT id, tipo, resolvido, created_at
      FROM cliente_contas_pendencias
     WHERE resolvido = false
     ORDER BY id ASC`)) || [];

  return inv;
}

/* ─────────────── classificação (pura, sem banco) ─────────────── */

const STATUS_PERMANENTES = new Set(["revoked", "blocked", "invalid"]);

// Contas ativas por (cliente, marketplace) — base das classificações F e G.
function indiceContas(inv) {
  const idx = new Map();
  for (const c of inv.cliente_contas || []) {
    if (!c.ativo) continue;
    const k = `${c.cliente_id}:${c.marketplace}`;
    idx.set(k, (idx.get(k) || 0) + 1);
  }
  return idx;
}

function classificarGrants(inv) {
  const idx = indiceContas(inv);
  const out = { EXATO: 0, LEGADO_SINGLE_ACCOUNT: 0, AMBIGUO: 0, DESCONECTADO: 0, casos: [] };
  for (const g of inv.grants || []) {
    let classe;
    if (STATUS_PERMANENTES.has(String(g.token_status || "").toLowerCase())) classe = "DESCONECTADO";
    else if (g.cliente_conta_id != null) classe = "EXATO";
    else {
      const ativas = idx.get(`${g.cliente_id}:meli`) || 0;
      classe = ativas >= 2 ? "AMBIGUO" : "LEGADO_SINGLE_ACCOUNT";
    }
    out[classe] += 1;
    if (classe === "AMBIGUO" || classe === "DESCONECTADO") {
      out.casos.push({ grant_id: g.id, cliente_id: g.cliente_id, ml_user_id: g.ml_user_id, classe,
        token_status: g.token_status });
    }
  }
  return out;
}

function classificarBases(inv) {
  const idx = indiceContas(inv);
  const out = { EXATA: 0, CLIENT_LEVEL_LEGADA: 0, AMBIGUA: 0, AUSENTE: 0, casos: [] };
  const comVinculo = new Set();
  for (const v of inv.base_vinculos || []) {
    if (!v.ativo) continue;
    comVinculo.add(v.cliente_id);
    let classe;
    if (v.cliente_conta_id != null) classe = "EXATA";
    else {
      const ativas = idx.get(`${v.cliente_id}:${v.marketplace}`) || 0;
      classe = ativas >= 2 ? "AMBIGUA" : "CLIENT_LEVEL_LEGADA";
    }
    out[classe] += 1;
    if (classe === "AMBIGUA") {
      out.casos.push({ vinculo_id: v.id, base_slug: v.base_slug, cliente_id: v.cliente_id,
        marketplace: v.marketplace, classe });
    }
  }
  for (const c of inv.clientes || []) {
    if (c.ativo && c.contas_ativas > 0 && !comVinculo.has(c.id)) {
      out.AUSENTE += 1;
      out.casos.push({ cliente_id: c.id, cliente_slug: c.slug, classe: "AUSENTE" });
    }
  }
  return out;
}

function classificarD4(inv) {
  const out = { A_sem_duplicata: 0, B_nenhuma_publicada: 0, C_uma_publicada: 0, D_multiplas_publicadas: 0, casos: [] };
  const grupos = inv.d4_duplicatas || [];
  if (!grupos.length) { out.A_sem_duplicata = 1; return out; }
  for (const g of grupos) {
    const classe = g.publicadas >= 2 ? "D_multiplas_publicadas"
      : g.publicadas === 1 ? "C_uma_publicada" : "B_nenhuma_publicada";
    out[classe] += 1;
    out.casos.push({ cliente_id: g.cliente_id, cliente_conta_id: g.cliente_conta_id,
      periodo: g.periodo, total: g.total, publicadas: g.publicadas, ids: g.ids, classe });
  }
  return out;
}

function resumir(inv) {
  const ROLES_INTERNAS = ROLES_COBRADAS_NA_AUDITORIA.set; // fonte canonica — a mesma do gate
  const internos = (inv.usuarios || []).filter(
    (u) => u.ativo && ROLES_INTERNAS.has(String(u.role || "").toLowerCase()));
  return {
    clientes: { total: inv.clientes.length, ativos: inv.clientes.filter((c) => c.ativo).length },
    cliente_contas: {
      total: inv.cliente_contas.length,
      ativas: inv.cliente_contas.filter((c) => c.ativo).length,
      multiConta: (inv.clientes || []).filter((c) => c.contas_ativas > 1).length,
    },
    usuarios: { total: inv.usuarios.length, internosAtivos: internos.length,
      admins: (inv.usuarios || []).filter((u) => String(u.role).toLowerCase() === "admin").length },
    squads: {
      squads: inv.squads.length,
      memberships: inv.squad_members.length,
      vinculosAbertos: (inv.cliente_squad_history || []).filter((h) => h.fim_em == null).length,
      responsaveisAtivos: (inv.cliente_responsaveis || []).filter((r) => r.ativo).length,
    },
    grants: classificarGrants(inv),
    bases: classificarBases(inv),
    d4: classificarD4(inv),
    pendenciasContasAbertas: (inv.pendencias_contas || []).length,
  };
}

/* ─────────────────────────────── main ─────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    linha(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 35).join("\n").replace(/^\/\/ ?/gm, "").trimEnd());
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.error("Erro: DATABASE_URL não definida.");
    console.error("Este script é READ-ONLY, mas exige que o destino seja explícito.");
    console.error("Prefira um usuário de banco somente-leitura ou uma réplica.");
    process.exit(1);
  }

  linha(`[inventario] destino: ${descreverDestino(process.env.DATABASE_URL)}`);
  linha(`[inventario] modo: TRANSAÇÃO READ ONLY — termina em ROLLBACK, nunca COMMIT.`);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  let inv;
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    inv = await coletar(client);
  } finally {
    // ROLLBACK incondicional: nada desta sessão pode sobreviver.
    try { await client.query("ROLLBACK"); } catch { /* sessão já encerrada */ }
    client.release();
    await pool.end();
  }

  inv.resumo = resumir(inv);

  if (args.saida) {
    fs.writeFileSync(path.resolve(args.saida), JSON.stringify(inv, null, 2) + "\n", "utf8");
    linha(`[inventario] escrito em ${path.resolve(args.saida)}`);
  }
  if (args.resumo || !args.saida) {
    linha("");
    linha(JSON.stringify(inv.resumo, null, 2));
  }
}

module.exports = { classificarGrants, classificarBases, classificarD4, resumir, descreverDestino, TABELAS };

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
