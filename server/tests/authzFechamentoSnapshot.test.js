// server/tests/authzFechamentoSnapshot.test.js
//
// Carteira nas rotas do snapshot do fechamento. Mesmo idioma de
// authzEntregasCliente.test.js: user interno 1 acessa o Cliente 10, não o 20;
// por `:id` vale o cliente DO SNAPSHOT, nunca o que o request diz.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";
process.env.SQUADS_ENFORCEMENT = "on";

const assert = require("assert");
const pool = require("../config/database");
const controller = require("../controllers/fechamentoSnapshotController");

let checks = 0;
function ok(label, cond) { assert.ok(cond, `FALHOU: ${label}`); checks += 1; console.log(`  ok  ${label}`); }
function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

const SNAPSHOTS = {
  1: { id: 1, cliente_id: 10, cliente_conta_id: 100, periodo: "2026-09", marketplace: "shopee", revisao: 1, summary_json: {} },
  2: { id: 2, cliente_id: 20, cliente_conta_id: 200, periodo: "2026-09", marketplace: "shopee", revisao: 1, summary_json: {} },
};
let itensConsultados = 0;

function mock(sql, params = []) {
  const q = String(sql).replace(/\s+/g, " ").trim();
  if (q.includes("authz:CAN_ACCESS_ADMIN")) return { rows: [{ "?column?": 1 }] };
  if (q.includes("authz:CAN_ACCESS_INTERNAL")) return { rows: Number(params[1]) === 10 ? [{ "?column?": 1 }] : [] };
  if (q.includes("authz:RESOLVE_CLIENTE_SLUG")) {
    const m = String(params[0]).match(/^cli-(\d+)$/);
    return { rows: m ? [{ id: Number(m[1]), slug: params[0], nome: params[0], ativo: true }] : [] };
  }
  if (q.startsWith("SELECT id, cliente_id, cliente_conta_id, periodo, marketplace, revisao, summary_json FROM fechamento_snapshots WHERE id = $1")) {
    const s = SNAPSHOTS[Number(params[0])];
    return { rows: s ? [s] : [] };
  }
  if (q.includes("FROM fechamento_snapshot_itens")) {
    itensConsultados += 1;
    if (q.includes("COUNT(*)")) return { rows: [{ total: 0 }] };
    return { rows: [] };
  }
  return { rows: [] };
}

async function run() {
  const original = { query: pool.query, connect: pool.connect };
  pool.query = async (sql, params) => mock(sql, params);
  // O repositório reaplica o runner da migration (BEGIN/lock/DDL/COMMIT) numa
  // conexão dedicada; aqui ela é o mesmo mock.
  pool.connect = async () => ({ query: async (sql, params) => mock(sql, params), release() {} });
  const interno = { id: 1, role: "membro" };
  const admin = { id: 9, role: "admin" };

  {
    const res = fakeRes();
    await controller.buscar({ params: { id: "2" }, query: {}, user: interno }, res);
    ok("GET /:id de snapshot de cliente fora da carteira → 403", res.statusCode === 403 && res.body.code === "CLIENTE_FORA_DA_CARTEIRA");
  }
  {
    const antes = itensConsultados;
    const res = fakeRes();
    await controller.itens({ params: { id: "2" }, query: {}, user: interno }, res);
    ok("GET /:id/itens fora da carteira → 403 e NENHUMA linha lida", res.statusCode === 403 && itensConsultados === antes);
  }
  {
    const res = fakeRes();
    await controller.itens({ params: { id: "1" }, query: {}, user: interno }, res);
    ok("GET /:id/itens do cliente da carteira → 200", res.statusCode === 200 && res.body.ok === true && res.body.total === 0);
  }
  {
    const res = fakeRes();
    await controller.itens({ params: { id: "99" }, query: {}, user: admin }, res);
    ok("snapshot inexistente → 404", res.statusCode === 404 && res.body.code === "SNAPSHOT_NAO_ENCONTRADO");
  }
  {
    const res = fakeRes();
    await controller.criar({ body: { clienteSlug: "cli-20", clienteContaId: 200 }, user: interno }, res);
    ok("POST com cliente fora da carteira → 403 antes de qualquer gravação", res.statusCode === 403);
  }
  {
    const res = fakeRes();
    await controller.criar({ body: {}, user: interno }, res);
    ok("POST sem cliente → 400 CLIENTE_OBRIGATORIO (nunca 'sem filtro')", res.statusCode === 400 && res.body.code === "CLIENTE_OBRIGATORIO");
  }
  {
    const res = fakeRes();
    await controller.listar({ query: { cliente_slug: "cli-20", cliente_conta_id: "200" }, user: interno }, res);
    ok("GET / lista de cliente fora da carteira → 403", res.statusCode === 403);
  }
  {
    const res = fakeRes();
    await controller.listar({ query: {}, user: admin }, res);
    ok("GET / lista sem cliente → 400 (nem admin lista tudo)", res.statusCode === 400);
  }

  pool.query = original.query;
  pool.connect = original.connect;
  console.log(`\nauthzFechamentoSnapshot.test.js: ${checks} verificações passaram.`);
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
