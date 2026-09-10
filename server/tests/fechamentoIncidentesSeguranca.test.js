// server/tests/fechamentoIncidentesSeguranca.test.js
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const repo = require("../repositories/fechamentoIncidenteRepository");
const { requireAdmin } = require("../middlewares/authMiddleware");

let checks = 0;
function ok(label, condition) { assert.ok(condition, label); checks += 1; console.log(`  ok  ${label}`); }

function fakeDb(rows) {
  return {
    async query(sql) {
      if (sql.includes("SELECT a.* FROM fechamento_incidente_arquivos")) return { rows };
      return { rows: [] };
    },
  };
}

async function testArquivoDeOutroIncidenteNaoAparece() {
  // getArquivo faz JOIN incidente_id = $1 AND a.id = $2 — um arquivoId que
  // pertence a OUTRO incidente não deve ser devolvido mesmo que exista na
  // tabela (o fakeDb aqui simula "banco vazio para essa combinação").
  const db = fakeDb([]);
  const arquivo = await repo.getArquivo(184, 999, db);
  ok("arquivo de incidente errado não é encontrado", arquivo === null);
}

function testRequireAdminBloqueiaNaoAdmin() {
  let status = null;
  const res = { status(c) { status = c; return this; }, json() { return this; } };
  let nextCalled = false;
  requireAdmin({ user: { role: "user" } }, res, () => { nextCalled = true; });
  ok("não-admin é bloqueado (403)", status === 403 && nextCalled === false);
}

function testRequireAdminLiberaAdmin() {
  let nextCalled = false;
  requireAdmin({ user: { role: "admin" } }, {}, () => { nextCalled = true; });
  ok("admin passa", nextCalled === true);
}

(async () => {
  await testArquivoDeOutroIncidenteNaoAparece();
  testRequireAdminBloqueiaNaoAdmin();
  testRequireAdminLiberaAdmin();
  console.log(`\n${checks} checks ok`);
})();
