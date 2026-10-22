const assert = require("node:assert/strict");
const databasePath = require.resolve("../config/database");
require.cache[databasePath] = {
  id: databasePath,
  filename: databasePath,
  loaded: true,
  exports: {},
};
const { createService } = require("../services/clientesUnificacao/service");
const { buildPlan } = require("../services/clientesUnificacao/planner");
const { fixture, manifest } = require("./helpers/clientesUnificacaoFixture");
const { previewTimeoutMs, executeTimeoutMs } = require("../config/clientesUnificacao");
const {
  diagnostics,
} = require("../services/clientesUnificacao/snapshotDiagnostics");
const actor = { id: 5, role: "admin" };
function harness(budget, executeBudget = 15000, stepMs = 300) {
  let clock = 0;
  const commands = [];
  const db = {
    query: async (sql) => {
      commands.push(sql);
      clock += stepMs;
      return { rows: [] };
    },
    release() {},
  };
  const repository = {
    readSnapshot: async (db) => {
      for (let n = 0; n < 55; n++) await db.query("SELECT snapshot_step");
      return fixture();
    },
    audit: async () => {},
    findKey: async () => null,
    reserve: async () => ({ created: true, row: { id: 1 } }),
    lockClients: async () => {},
    detail: async () => null,
  };
  const service = createService({
    pool: { connect: async () => db },
    repository,
    getFlags: () => ({ execute: true }),
    getPreviewTimeoutMs: budget == null ? previewTimeoutMs : () => budget,
    getExecuteTimeoutMs: () => executeBudget,
    now: () => clock,
  });
  return { service, commands };
}
async function main() {
  const old = harness(15000);
  await assert.rejects(old.service.preview(manifest(), actor), {
    code: "MERGE_TRANSACTION_TIMEOUT",
  });
  const current = harness();
  const p = await current.service.preview(manifest(), actor);
  assert.equal(p.validationReady, true);
  assert.ok(current.commands.includes("COMMIT"));
  const write = harness(45000),
    m = manifest();
  const plan = buildPlan(fixture(), m);
  await assert.rejects(
    write.service.execute(
      {
        manifest: m,
        planHash: plan.planHash,
        idempotencyKey: "timing-write-test",
        confirmationText: "UNIFICAR 2 EM 1",
      },
      actor,
    ),
    { code: "MERGE_TRANSACTION_TIMEOUT" },
  );
  assert.ok(write.commands.includes("BEGIN ISOLATION LEVEL SERIALIZABLE"));
  for (const sql of [
    "SET LOCAL statement_timeout='45000ms'",
    "SET LOCAL lock_timeout='1500ms'",
    "SET LOCAL idle_in_transaction_session_timeout='15000ms'",
  ])
    assert.ok(write.commands.includes(sql));
  // Escrita configurada acima de 15s: sem MERGE_TRANSACTION_TIMEOUT.
  const long = harness(45000, 120000);
  try {
    await long.service.execute(
      {
        manifest: m,
        planHash: plan.planHash,
        idempotencyKey: "timing-write-long",
        confirmationText: "UNIFICAR 2 EM 1",
      },
      actor,
    );
  } catch (e) {
    assert.notEqual(e.code, "MERGE_TRANSACTION_TIMEOUT");
  }
  assert.ok(long.commands.includes("SET LOCAL statement_timeout='120000ms'"));
  assert.ok(long.commands.filter((c) => c === "SELECT snapshot_step").length > 50);
  for (const value of ["", "999999", "300001", "14999", "-1", "abc"])
    assert.equal(
      executeTimeoutMs({ CLIENTES_UNIFICACAO_EXECUTE_TIMEOUT_MS: value }),
      120000,
    );
  assert.equal(executeTimeoutMs({}), 120000);
  for (const value of ["15000", "300000"])
    assert.equal(
      executeTimeoutMs({ CLIENTES_UNIFICACAO_EXECUTE_TIMEOUT_MS: value }),
      Number(value),
    );
  for (const value of ["", "999999", "300001", "14999", "-1", "Infinity", "abc"])
    assert.equal(
      previewTimeoutMs({ CLIENTES_UNIFICACAO_PREVIEW_TIMEOUT_MS: value }),
      120000,
    );
  assert.equal(previewTimeoutMs({}), 120000);
  for (const value of ["15000", "45000", "300000"])
    assert.equal(
      previewTimeoutMs({ CLIENTES_UNIFICACAO_PREVIEW_TIMEOUT_MS: value }),
      Number(value),
    );
  // Preview de ~44s (conta grande): passa no default, estoura com o teto antigo.
  const slow = harness(undefined, 15000, 800);
  const big = await slow.service.preview(manifest(), actor);
  assert.equal(big.validationReady, true);
  assert.ok(slow.commands.includes("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));
  assert.ok(slow.commands.includes("SET LOCAL statement_timeout='120000ms'"));
  assert.ok(slow.commands.includes("SET LOCAL lock_timeout='1500ms'"));
  await assert.rejects(
    harness(30000, 15000, 800).service.preview(manifest(), actor),
    { code: "MERGE_TRANSACTION_TIMEOUT" },
  );
  const events = [];
  const timer = diagnostics({ onStage: (e) => events.push(e) });
  const error = Object.assign(
    Error("access_token=SECRET refresh_token=SECRET"),
    { code: "57014" },
  );
  await assert.rejects(
    timer.query(
      {
        query: async () => {
          throw error;
        },
      },
      "references.load",
      "SELECT secret",
      ["SECRET"],
      { tables: ["meli_anuncios"] },
    ),
    (e) => e === error,
  );
  timer.finish("error");
  assert.ok(
    events.some((e) => e.stage === "references.load" && e.code === "57014"),
  );
  assert.ok(!JSON.stringify(events).includes("SECRET"));
  console.log(
    "6 cenários: teto antigo reproduzido, preview >15s, escrita limitada, config limitada e diagnóstico sem secrets.",
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
