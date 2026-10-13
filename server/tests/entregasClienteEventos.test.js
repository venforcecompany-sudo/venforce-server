// server/tests/entregasClienteEventos.test.js
//
// Trilha de auditoria das entregas (activity_logs, reutilizada): publicar e
// despublicar registram QUAL revisão do fechamento (snapshot_id) estava na
// entrega — é o que responde "qual versão o cliente recebeu?". Erro não
// registra evento.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";
process.env.SQUADS_ENFORCEMENT = "on";

const assert = require("assert");
const pool = require("../config/database");
const controller = require("../controllers/entregasClienteController");

let checks = 0;
function ok(label, cond) { assert.ok(cond, `FALHOU: ${label}`); checks += 1; console.log(`  ok  ${label}`); }
function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

const ENTREGA = { id: 7, tipo: "fechamento_mensal", cliente_id: 10, cliente_slug: "cli-10", cliente_conta_id: 100, periodo: "2026-09", snapshot_id: 42, token_publico: null, publicado: false };
const logs = [];

function mock(sql, params = []) {
  const q = String(sql).replace(/\s+/g, " ").trim();
  if (q.startsWith("INSERT INTO activity_logs")) { logs.push({ acao: params[3], detalhes: JSON.parse(params[4]), userId: params[0] }); return { rows: [] }; }
  if (q.includes("authz:CAN_ACCESS_INTERNAL")) return { rows: Number(params[1]) === 10 ? [{ "?column?": 1 }] : [] };
  if (q.startsWith("SELECT * FROM entregas_cliente WHERE id = $1")) return { rows: Number(params[0]) === 7 ? [ENTREGA] : [] };
  if (q.startsWith("SELECT id, token_publico FROM entregas_cliente")) return { rows: [ENTREGA] };
  if (q.startsWith("SELECT id FROM entregas_cliente")) return { rows: [ENTREGA] };
  if (q.startsWith("UPDATE entregas_cliente SET publicado = true")) return { rows: [{ ...ENTREGA, publicado: true, token_publico: "t" }] };
  if (q.startsWith("UPDATE entregas_cliente SET publicado = false")) return { rows: [{ ...ENTREGA, publicado: false, token_publico: "t" }] };
  return { rows: [] };
}

async function run() {
  const original = pool.query;
  pool.query = async (sql, params) => mock(sql, params);
  const user = { id: 1, role: "membro", email: "op@venforce" };
  const flush = () => new Promise((r) => setImmediate(r));

  {
    const res = fakeRes();
    await controller.publicarEntregaController({ params: { id: "7" }, user, headers: {}, socket: {} }, res);
    await flush();
    ok("publicar → 200", res.statusCode === 200);
    ok("evento entrega_publicada com a revisão (snapshotId) e o usuário", logs.length === 1 && logs[0].acao === "entrega_publicada" && logs[0].detalhes.snapshotId === 42 && logs[0].userId === 1);
  }
  {
    const res = fakeRes();
    await controller.despublicarEntregaController({ params: { id: "7" }, user, headers: {}, socket: {} }, res);
    await flush();
    ok("evento entrega_despublicada", logs.length === 2 && logs[1].acao === "entrega_despublicada" && logs[1].detalhes.periodo === "2026-09");
  }
  {
    const res = fakeRes();
    await controller.publicarEntregaController({ params: { id: "8" }, user, headers: {}, socket: {} }, res);
    await flush();
    ok("erro (404) não registra evento", res.statusCode === 404 && logs.length === 2);
  }

  pool.query = original;
  console.log(`\nentregasClienteEventos.test.js: ${checks} verificações passaram.`);
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
