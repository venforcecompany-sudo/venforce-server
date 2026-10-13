#!/usr/bin/env node
// server/scripts/fechamentoSnapshotSqlCheck.js
// Validação do SQL do snapshot do fechamento (Financeiro V3) contra um
// Postgres REAL em memória (PGlite). Prova o que os testes com fake não
// provam: a migration versionada (2x, com advisory lock), CHECKs, UNIQUE da
// revisão, trigger de imutabilidade, FKs (NO ACTION na conta, CASCADE no
// cliente, SET NULL na entrega), revisão incremental por conta, idempotência
// por selo, itens sem truncar em 50 com paginação/filtro/busca no backend,
// e o vínculo entrega → snapshot (incl. entrega com link imutável).
//
// SEGURANÇA: nunca lê DATABASE_URL e nunca abre conexão de rede.
//
// Uso (a partir de server/, sem alterar package.json):
//   npm install --no-save @electric-sql/pglite@0.3
//   node scripts/fechamentoSnapshotSqlCheck.js

process.env.DATABASE_URL = "postgres://127.0.0.1:1/fechamento-snapshot-sql-check-nunca-conecta";

const assert = require("assert");

let PGlite;
try {
  ({ PGlite } = require("@electric-sql/pglite"));
} catch (_) {
  console.error("Instale antes (sem salvar no package.json): npm install --no-save @electric-sql/pglite@0.3");
  process.exit(2);
}

const schemaEnsure = require("../services/schema/schemaEnsure");
const repo = require("../repositories/fechamentoSnapshotRepository");
const { itemDoSnapshot, contarItens } = require("../services/fechamentoSnapshot/itemDoSnapshot");

async function criarDb() {
  const pg = new PGlite();
  const queries = [];
  const db = {
    async query(sql, params = []) {
      queries.push(sql);
      if (!params.length && /;\s*\S/.test(sql)) {
        const r = await pg.exec(sql);
        return { rows: r[r.length - 1]?.rows || [], rowCount: r[r.length - 1]?.affectedRows };
      }
      const r = await pg.query(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows };
    },
  };
  // Mínimo do schema real de que as FKs dependem.
  await pg.exec(`
    CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT);
    INSERT INTO users (email) VALUES ('op@venforce');
    CREATE TABLE activity_logs (id SERIAL PRIMARY KEY, user_id INTEGER, user_email TEXT, user_nome TEXT, acao TEXT, detalhes TEXT, ip TEXT, status TEXT, created_at TIMESTAMP DEFAULT NOW());
    CREATE TABLE clientes (id SERIAL PRIMARY KEY, slug TEXT UNIQUE, nome TEXT, ativo BOOLEAN DEFAULT true);
    CREATE TABLE cliente_contas (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      marketplace TEXT NOT NULL, nome TEXT, ativo BOOLEAN DEFAULT true
    );
    INSERT INTO clientes (slug, nome) VALUES ('zorza', 'Zorza'), ('outro', 'Outro');
    INSERT INTO cliente_contas (cliente_id, marketplace, nome) VALUES (1, 'shopee', 'Zorza Shopee'), (1, 'meli', 'Zorza ML'), (2, 'meli', 'Outro ML');
  `);
  await schemaEnsure.ensureEntregasClienteSchema(db);
  return { pg, db, queries };
}

function linhaOrderAll(i, extra = {}) {
  return {
    Marketplace: "Shopee", "ID do pedido": `2509${String(i).padStart(10, "0")}`, Produto: `Produto ${i}`,
    SKU: `SKU-${i}`, Quantidade: 1, "Receita bruta": 100 + i, "Receita líquida": 80 + i, CMV: i % 7 === 0 ? null : 30,
    Imposto: 8, "Match de custo": i % 7 === 0 ? "miss" : "direct_sku", "ID resolvido pela ponte": `2299${i}`,
    LC: i % 7 === 0 ? null : 42, MC: i % 7 === 0 ? null : (i % 3 === 0 ? 10 : 33),
    "Cobertura de custo": i % 7 === 0 ? "sem custo" : "com custo", "Status do pedido": i % 11 === 0 ? "Cancelado" : "Concluído",
    ...extra,
  };
}

function meta(extra = {}) {
  return {
    clienteId: 1, clienteSlug: "zorza", clienteContaId: 1, marketplace: "shopee", periodo: "2026-09",
    summary: { finalResult: 25000, calculatedCoveragePercent: 91, revenueWithoutCost: 8300 },
    origemCustos: { costsSource: "base", costsBase: { id: 9, slug: "zorza-shopee-3", nome: "zorza shopee 3" } },
    ajustes: { ads: 20, venforce: 5, affiliates: 2, fullCost: 0, additionalCosts: 0 },
    arquivos: [{ tipo: "vendas", nomeOriginal: "Order.all.xlsx", sha256: "a".repeat(64), tamanhoBytes: 10, mimeType: "x", origem: "upload" }],
    diagnostico: { unmatchedIds: ["229977"] },
    selo: "1".repeat(64),
    processadoEm: "2026-10-13T17:30:00.000Z",
    processadoPor: 3, criadoPor: 3, criadoPorEmail: "op@venforce",
    ...extra,
  };
}

function itensDe(linhas) {
  return linhas.map((l, i) => itemDoSnapshot(l, i + 1));
}

const checks = [];
function check(nome, fn) { checks.push({ nome, fn }); }

check("migration: aplicada 2x (idempotente), BEGIN + advisory lock + COMMIT", async ({ db, queries }) => {
  await schemaEnsure.ensureFechamentoSnapshotsSchema(db);
  const ini = queries.length;
  const outra = { query: (s, p) => db.query(s, p) };
  await schemaEnsure.ensureFechamentoSnapshotsSchema(outra);
  assert.strictEqual(queries[ini].trim(), "BEGIN");
  assert.ok(/pg_advisory_xact_lock/.test(queries[ini + 1]));
  assert.strictEqual(queries[ini + 3].trim(), "COMMIT");
  const cols = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'entregas_cliente' AND column_name = 'snapshot_id'`);
  assert.strictEqual(cols.rows.length, 1, "entregas_cliente.snapshot_id criada");
});

check("v1 → v2 na mesma conta/competência; outra conta e outra competência começam em v1", async ({ db }) => {
  const a = await repo.criarSnapshot(meta(), itensDe([linhaOrderAll(1)]), db);
  assert.strictEqual(a.snapshot.revisao, 1);
  assert.strictEqual(a.reaproveitado, false);
  const b = await repo.criarSnapshot(meta({ selo: "2".repeat(64), summary: { finalResult: 29500 } }), itensDe([linhaOrderAll(1)]), db);
  assert.strictEqual(b.snapshot.revisao, 2);
  const outraConta = await repo.criarSnapshot(meta({ clienteContaId: 2, marketplace: "meli", selo: "3".repeat(64) }), [], db);
  assert.strictEqual(outraConta.snapshot.revisao, 1, "conta 2 não herda a numeração da conta 1");
  const outroMes = await repo.criarSnapshot(meta({ periodo: "2026-10", selo: "4".repeat(64) }), [], db);
  assert.strictEqual(outroMes.snapshot.revisao, 1);
  const lista = await repo.listarSnapshotsDaConta({ clienteContaId: 1 }, db);
  assert.deepStrictEqual(lista.map((s) => `${s.periodo}v${s.revisao}`), ["2026-10v1", "2026-09v2", "2026-09v1"]);
  assert.ok(lista.every((s) => Number(s.cliente_conta_id) === 1), "lista nunca mistura contas");
  assert.strictEqual(Number(lista[1].summary_json.finalResult), 29500);
});

check("mesmo selo salvo de novo = mesma revisão (sem cópia)", async ({ db }) => {
  const a = await repo.criarSnapshot(meta(), [], db);
  const b = await repo.criarSnapshot(meta(), [], db);
  assert.strictEqual(b.reaproveitado, true);
  assert.strictEqual(Number(b.snapshot.id), Number(a.snapshot.id));
  const n = await db.query("SELECT COUNT(*)::int AS n FROM fechamento_snapshots");
  assert.strictEqual(n.rows[0].n, 1);
});

check("UNIQUE (conta, competência, revisão) é a última barreira contra revisão duplicada", async ({ db, pg }) => {
  await repo.criarSnapshot(meta(), [], db);
  await assert.rejects(
    () => pg.query(`INSERT INTO fechamento_snapshots (cliente_id, cliente_slug, cliente_conta_id, marketplace, periodo, revisao, summary_json, total_itens, selo, processado_em)
                    VALUES (1,'zorza',1,'shopee','2026-09',1,'{}',0,'x',NOW())`),
    (e) => /uq_fechamento_snapshots_revisao|duplicate key/.test(e.message)
  );
});

check("CHECKs: competência AAAA-MM, marketplace conhecido, revisão ≥ 1", async ({ db, pg }) => {
  await schemaEnsure.ensureFechamentoSnapshotsSchema(db);
  const ins = (periodo, mkt, rev) => pg.query(
    `INSERT INTO fechamento_snapshots (cliente_id, cliente_slug, cliente_conta_id, marketplace, periodo, revisao, summary_json, total_itens, selo, processado_em)
     VALUES (1,'zorza',1,$2,$1,$3,'{}',0,'x',NOW())`, [periodo, mkt, rev]);
  await assert.rejects(() => ins("Set 2026", "shopee", 1));
  await assert.rejects(() => ins("2026-13", "shopee", 1));
  await assert.rejects(() => ins("2026-09", "amazon", 1));
  await assert.rejects(() => ins("2026-09", "shopee", 0));
  await ins("2026-09", "tiktok", 1); // marketplace-agnóstico: TikTok já cabe
});

check("snapshot e itens são imutáveis no banco (UPDATE recusado pelo trigger)", async ({ db, pg }) => {
  const a = await repo.criarSnapshot(meta(), itensDe([linhaOrderAll(1)]), db);
  await assert.rejects(() => pg.query("UPDATE fechamento_snapshots SET summary_json = '{}' WHERE id = $1", [a.snapshot.id]), /imutável/);
  await assert.rejects(() => pg.query("UPDATE fechamento_snapshot_itens SET lc = 0 WHERE snapshot_id = $1", [a.snapshot.id]), /imutável/);
  const s = await repo.buscarSnapshot(a.snapshot.id, db);
  assert.strictEqual(Number(s.summary_json.finalResult), 25000);
});

check("todas as linhas persistidas (sem truncar em 50), em ordem, com IDs como texto e null preservado", async ({ db }) => {
  const linhas = Array.from({ length: 4321 }, (_, i) => linhaOrderAll(i + 1));
  const itens = itensDe(linhas);
  const a = await repo.criarSnapshot(meta({ contagens: contarItens(itens) }), itens, db);
  assert.strictEqual(a.snapshot.total_itens, 4321);
  const n = await db.query("SELECT COUNT(*)::int AS n FROM fechamento_snapshot_itens WHERE snapshot_id = $1", [a.snapshot.id]);
  assert.strictEqual(n.rows[0].n, 4321);

  const p1 = await repo.listarItens({ snapshotId: a.snapshot.id, offset: 0, limit: 50 }, db);
  assert.strictEqual(p1.total, 4321);
  assert.strictEqual(p1.itens.length, 50);
  assert.deepStrictEqual(p1.itens.map((i) => i.ordem).slice(0, 3), [1, 2, 3]);
  const ultima = await repo.listarItens({ snapshotId: a.snapshot.id, offset: 4300, limit: 50 }, db);
  assert.strictEqual(ultima.itens.length, 21);
  assert.strictEqual(ultima.itens[20].ordem, 4321);

  // A linha volta EXATA: ID longo como texto, null como null (nunca 0).
  const l7 = (await repo.listarItens({ snapshotId: a.snapshot.id, offset: 6, limit: 1 }, db)).itens[0].linha;
  assert.strictEqual(l7["ID do pedido"], "25090000000007");
  assert.strictEqual(typeof l7["ID do pedido"], "string");
  assert.strictEqual(l7.LC, null);
  assert.strictEqual(l7.CMV, null);
  assert.deepStrictEqual(l7, linhas[6]);
});

check("filtro por status, cancelados e busca sem acento — no backend", async ({ db }) => {
  const linhas = [
    linhaOrderAll(1, { Produto: "Camiseta Algodão" }),
    linhaOrderAll(7), // sem custo
    linhaOrderAll(11), // cancelado
    linhaOrderAll(14), // sem custo
  ];
  const a = await repo.criarSnapshot(meta(), itensDe(linhas), db);
  const semCusto = await repo.listarItens({ snapshotId: a.snapshot.id, status: "sem_custo" }, db);
  assert.strictEqual(semCusto.total, 2);
  const canc = await repo.listarItens({ snapshotId: a.snapshot.id, status: "cancelados" }, db);
  assert.strictEqual(canc.total, 1);
  const busca = await repo.listarItens({ snapshotId: a.snapshot.id, busca: "algodao" }, db);
  assert.strictEqual(busca.total, 1);
  const pct = await repo.listarItens({ snapshotId: a.snapshot.id, busca: "100%" }, db);
  assert.strictEqual(pct.total, 0, "% da busca é literal, não curinga");
});

check("FK da conta: apagar a conta sozinha é recusado; purge do cliente leva tudo junto", async ({ db, pg }) => {
  await repo.criarSnapshot(meta(), itensDe([linhaOrderAll(1)]), db);
  await assert.rejects(() => pg.query("DELETE FROM cliente_contas WHERE id = 1"), /foreign key|violates/);
  await pg.query("DELETE FROM clientes WHERE id = 1");
  const n = await db.query("SELECT (SELECT COUNT(*) FROM fechamento_snapshots)::int AS s, (SELECT COUNT(*) FROM fechamento_snapshot_itens)::int AS i");
  assert.deepStrictEqual(n.rows[0], { s: 0, i: 0 });
});

check("entrega → snapshot: lista diz qual entrega (e se publicada) aponta para cada revisão", async ({ db, pg }) => {
  const v1 = await repo.criarSnapshot(meta(), [], db);
  const v2 = await repo.criarSnapshot(meta({ selo: "2".repeat(64) }), [], db);
  await pg.query(
    `INSERT INTO entregas_cliente (tipo, cliente_id, cliente_conta_id, titulo, periodo, status, publicado, token_publico, snapshot_id)
     VALUES ('fechamento_mensal', 1, 1, 'F', '2026-09', 'publicado', true, 'tok', $1),
            ('fechamento_mensal', 1, 1, 'F', '2026-09', 'rascunho', false, NULL, $2)`,
    [v1.snapshot.id, v2.snapshot.id]
  );
  const lista = await repo.listarSnapshotsDaConta({ clienteContaId: 1, periodo: "2026-09" }, db);
  const porRev = Object.fromEntries(lista.map((s) => [s.revisao, s.entregas]));
  assert.strictEqual(porRev[1][0].publicado, true);
  assert.strictEqual(porRev[1][0].temLink, true);
  assert.strictEqual(porRev[2][0].publicado, false);
  const ident = await repo.buscarIdentidadeDoSnapshot(v2.snapshot.id, db);
  assert.strictEqual(ident.periodo, "2026-09");
  assert.strictEqual(Number(ident.cliente_conta_id), 1);
});

// ─── Ponta a ponta pelas funções REAIS, com o pool apontado para o PGlite ───
// (entregasClienteService e o service do snapshot usam config/database).
const pool = require("../config/database");
const entregas = require("../services/entregasClienteService");
const snapshotService = require("../services/fechamentoSnapshot/fechamentoSnapshotService");
const { selarProcessamento } = require("../services/fechamentoSnapshot/seloProcessamento");
delete process.env.NODE_ENV;
process.env.JWT_SECRET = process.env.JWT_SECRET || "segredo-de-teste-com-tamanho-suficiente-123";

// O ensure é single-flight POR objeto de conexão: o `pool` é o mesmo entre
// os checks, então o schema é aplicado explicitamente em cada PGlite novo.
async function apontarPool(db) {
  pool.query = (sql, params) => db.query(sql, params);
  pool.connect = async () => ({ query: (sql, params) => db.query(sql, params), release() {} });
  await schemaEnsure.ensureFechamentoSnapshotsSchema(db);
}

function processamentoSelado({ finalResult = 25000, n = 80, periodo = "2026-09", clienteContaId = 1 } = {}) {
  const ctx = { clienteSlug: "zorza", clienteContaId, periodo, marketplace: "shopee" };
  const resposta = {
    ok: true, summary: { finalResult, calculatedCoveragePercent: 91 }, detailedRows: Array.from({ length: n }, (_, i) => linhaOrderAll(i + 1)),
    unmatchedIds: [], competencia: { periodoDetectado: periodo }, costsSource: "base", costsBase: { id: 9, slug: "b", nome: "zorza shopee 3" },
  };
  resposta.processamento = selarProcessamento({ contexto: ctx, resultado: resposta, usuarioId: 1, ajustes: { ads: 20 }, arquivos: [], costRowsRaw: [] });
  const volta = JSON.parse(JSON.stringify(resposta));
  const { processamento, ...resultado } = volta;
  return { ...ctx, resultado, processamento };
}

function corpoEntrega(snapshot, summary, extra = {}) {
  return {
    tipo: "fechamento_mensal", titulo: "Fechamento Financeiro", periodo: "2026-09", cliente_slug: "zorza", cliente_conta_id: 1,
    status: "rascunho", snapshot_id: snapshot.id,
    payload_json: { cliente: { slug: "zorza" }, summary, detailedRows: [], entrega: { destaques: [] } },
    ...extra,
  };
}

const codigo = (code) => (e) => (e.code === code || e.payload?.code === code) || assert.fail(`esperava ${code}, veio ${e.code || e.payload?.code}: ${e.message}`);

check("ponta a ponta: v1 → entrega → apresentação → publicar v1 → v2 → nova entrega v2; v1 publicada intacta", async ({ db }) => {
  await apontarPool(db);
  const u = { id: 1, email: "op@venforce" };
  const p1 = processamentoSelado();
  const { snapshot: v1 } = await snapshotService.criarSnapshot({ user: u, body: p1 });
  assert.strictEqual(v1.revisao, 1);
  assert.strictEqual(v1.totalItens, 80);

  // entrega aponta para v1
  const { entrega: e1 } = await entregas.criarEntrega({ userId: 1, body: corpoEntrega(v1, p1.resultado.summary) });
  assert.strictEqual(Number(e1.snapshot_id), v1.id);

  // editar a apresentação (texto) não mexe nos números — aceito
  await entregas.atualizarEntrega({ idRaw: e1.id, body: { payload_json: { ...corpoEntrega(v1, p1.resultado.summary).payload_json, entrega: { destaques: ["Melhoramos a margem"] } } } });
  // trocar um número pela apresentação — recusado
  await assert.rejects(
    () => entregas.atualizarEntrega({ idRaw: e1.id, body: { payload_json: { ...corpoEntrega(v1, p1.resultado.summary).payload_json, summary: { finalResult: 1 } } } }),
    codigo("SNAPSHOT_DIVERGENTE")
  );
  const sV1 = await snapshotService.buscarSnapshot({ id: v1.id });
  assert.strictEqual(sV1.summary.finalResult, 25000, "o snapshot nunca muda com a apresentação");

  await entregas.publicarEntrega({ idRaw: e1.id });

  // corrigiu custos → v2
  const p2 = processamentoSelado({ finalResult: 29500 });
  const { snapshot: v2 } = await snapshotService.criarSnapshot({ user: u, body: p2 });
  assert.strictEqual(v2.revisao, 2);

  // salvar a entrega de v2 sem substituir → 409 (já existe entrega publicada)
  await assert.rejects(() => entregas.criarEntrega({ userId: 1, body: corpoEntrega(v2, p2.resultado.summary) }), codigo("ENTREGA_JA_EXISTE"));
  // substituir com a publicada existente → NOVA entrega (rascunho) em v2
  const { entrega: e2 } = await entregas.criarEntrega({ userId: 1, body: corpoEntrega(v2, p2.resultado.summary, { substituir: true }) });
  assert.notStrictEqual(e2.id, e1.id);
  assert.strictEqual(Number(e2.snapshot_id), v2.id);

  // a publicada continua em v1 — trocar a revisão dela é recusado
  await assert.rejects(() => entregas.atualizarEntrega({ idRaw: e1.id, body: { snapshot_id: v2.id } }), codigo("ENTREGA_PUBLICADA_IMUTAVEL"));
  const lista = await snapshotService.listarSnapshots({ query: { cliente_slug: "zorza", cliente_conta_id: 1, periodo: "2026-09" } });
  const porRev = Object.fromEntries(lista.map((s) => [s.revisao, s]));
  assert.strictEqual(porRev[1].publicado, true, "Publicado: v1");
  assert.strictEqual(porRev[2].publicado, false, "v2 salva, ainda não publicada");
  assert.deepStrictEqual(porRev[2].entregas.map((e) => e.id), [e2.id]);
  // trilha reutilizada: activity_logs (registrarLog é fire-and-forget)
  await new Promise((r) => setTimeout(r, 20));
  const logs = await db.query("SELECT acao, detalhes FROM activity_logs ORDER BY id");
  assert.deepStrictEqual(logs.rows.map((l) => l.acao), ["financeiro_snapshot_criado", "financeiro_snapshot_criado"]);
  assert.strictEqual(JSON.parse(logs.rows[1].detalhes).revisao, 2);
});

check("vínculo entrega → snapshot só quando é verdadeiro (cliente, conta, competência, números)", async ({ db }) => {
  await apontarPool(db);
  const p1 = processamentoSelado();
  const { snapshot: v1 } = await snapshotService.criarSnapshot({ user: { id: 1 }, body: p1 });
  await assert.rejects(() => entregas.criarEntrega({ userId: 1, body: corpoEntrega(v1, { finalResult: 1 }) }), codigo("SNAPSHOT_DIVERGENTE"));
  await assert.rejects(() => entregas.criarEntrega({ userId: 1, body: corpoEntrega(v1, p1.resultado.summary, { periodo: "2026-10" }) }), codigo("SNAPSHOT_DIVERGENTE"));
  await assert.rejects(() => entregas.criarEntrega({ userId: 1, body: corpoEntrega(v1, p1.resultado.summary, { cliente_conta_id: 2 }) }), codigo("SNAPSHOT_DIVERGENTE"));
  await assert.rejects(() => entregas.criarEntrega({ userId: 1, body: corpoEntrega(v1, p1.resultado.summary, { snapshot_id: 999 }) }), codigo("SNAPSHOT_NAO_ENCONTRADO"));
  await assert.rejects(() => entregas.criarEntrega({ userId: 1, body: corpoEntrega(v1, p1.resultado.summary, { tipo: "relatorio_misto" }) }), codigo("SNAPSHOT_DIVERGENTE"));
});

check("substituir um RASCUNHO troca a revisão no lugar (explícito); entrega antiga sem snapshot segue igual", async ({ db }) => {
  await apontarPool(db);
  // entrega antiga, sem snapshot (legado)
  const { entrega: antiga } = await entregas.criarEntrega({ userId: 1, body: { tipo: "fechamento_mensal", titulo: "F", periodo: "2026-08", cliente_slug: "zorza", cliente_conta_id: 1, payload_json: { cliente: { slug: "zorza" }, summary: { finalResult: 1 }, detailedRows: [] } } });
  assert.strictEqual(antiga.snapshot_id ?? null, null);
  await entregas.atualizarEntrega({ idRaw: antiga.id, body: { payload_json: { cliente: { slug: "zorza" }, summary: { finalResult: 2 }, detailedRows: [] } } });

  const p1 = processamentoSelado();
  const { snapshot: v1 } = await snapshotService.criarSnapshot({ user: { id: 1 }, body: p1 });
  const { entrega: rasc } = await entregas.criarEntrega({ userId: 1, body: corpoEntrega(v1, p1.resultado.summary) });
  const p2 = processamentoSelado({ finalResult: 30000 });
  const { snapshot: v2 } = await snapshotService.criarSnapshot({ user: { id: 1 }, body: p2 });
  const { entrega: mesma } = await entregas.criarEntrega({ userId: 1, body: corpoEntrega(v2, p2.resultado.summary, { substituir: true }) });
  assert.strictEqual(mesma.id, rasc.id, "rascunho sem link é atualizado no lugar");
  assert.strictEqual(Number(mesma.snapshot_id), v2.id);
  const n = await db.query("SELECT COUNT(*)::int AS n FROM entregas_cliente WHERE periodo = '2026-09'");
  assert.strictEqual(n.rows[0].n, 1);
});

(async () => {
  let ok = 0;
  for (const c of checks) {
    const ctx = await criarDb();
    try {
      await c.fn(ctx);
      ok += 1;
      console.log(`  ok  ${c.nome}`);
    } catch (err) {
      console.error(`  FALHOU  ${c.nome}\n${err.stack}`);
      process.exitCode = 1;
    } finally {
      await ctx.pg.close();
    }
  }
  console.log(`\n${ok}/${checks.length} verificações SQL OK (PGlite)`);
})();
