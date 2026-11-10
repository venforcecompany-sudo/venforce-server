// server/tests/freteLegadoBloqueioConta.test.js
// P0 10/11/2026 — margem ANTIGA (sem freteQualidade) de conta liberada não aparece como confiável;
// contas fora da flag e linhas já avaliadas não mudam. A flag é lida na carga: cada caso roda em processo filho.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://nobody@127.0.0.1:1/teste-sem-banco";
const assert = require("assert");
const { execFileSync } = require("child_process");
let checks = 0; const ok = (c, m) => { assert.ok(c, m); checks += 1; };

if (process.argv[2] === "filho") {
  const conf = require("../services/motorMargem/margemConfiavel");
  const fonte = require("../services/motorMargem/anunciosMargemProjetadaFonte");
  const rows = [
    // conta 87, linha antiga (sem freteQualidade), frete aparentemente válido
    { item_id: "MLB_ANTIGA", cliente_conta_id: 87, margin_percent: "45.25", profit: "125.85", status: "HEALTHY", calculated_at: "2026-11-10T16:14:00Z", assumed_json: [], frete_qualidade_tipo: null },
    // conta 87, já recalculada com frete válido
    { item_id: "MLB_AVALIADA", cliente_conta_id: 87, margin_percent: "30", profit: "20", status: "HEALTHY", calculated_at: "2026-11-11T10:00:00Z", assumed_json: [], frete_qualidade_tipo: "object", frete_nivel: "cotado_ml" },
    // conta 87, estimada por dimensões: vale, rotulada
    { item_id: "MLB_ESTIMADA", cliente_conta_id: 87, margin_percent: "22", profit: "15", status: "HEALTHY", calculated_at: "2026-11-11T10:00:00Z", assumed_json: [], frete_qualidade_tipo: "object", frete_nivel: "estimado_dimensoes_historicas" },
    // outra conta, linha antiga: intocada
    { item_id: "MLB_OUTRA", cliente_conta_id: 55, margin_percent: "18", profit: "9", status: "HEALTHY", calculated_at: "2026-11-10T16:14:00Z", assumed_json: [], frete_qualidade_tipo: null },
  ];
  fonte.lerMarginSnapshotPorItens({ clienteId: 133, itemIds: rows.map((r) => r.item_id) }, { async query() { return { rows }; } }).then((m) => {
    console.log(JSON.stringify({
      sql: conf.SQL_CUSTO_MARKETPLACE_AUSENTE,
      antiga: m.get("MLB_ANTIGA"), avaliada: m.get("MLB_AVALIADA"), estimada: m.get("MLB_ESTIMADA"), outra: m.get("MLB_OUTRA"),
    }));
  });
} else {
  const rodar = (contas) => JSON.parse(execFileSync(process.execPath, [__filename, "filho"], {
    env: { ...process.env, ...(contas === undefined ? {} : { FRETE_LEGADO_BLOQUEAR_CONTAS: contas }) }, encoding: "utf8",
  }).trim().split("\n").pop());

  const comFlag = rodar("87");
  ok(comFlag.antiga.margemIncompleta === true && comFlag.antiga.marginPercent === null && comFlag.antiga.profit === null && comFlag.antiga.computable === false,
    "linha antiga da conta 87 não é confiável");
  ok(comFlag.avaliada.margemIncompleta === false && comFlag.avaliada.marginPercent === 30, "linha já avaliada (frete válido) continua visível");
  ok(comFlag.estimada.margemIncompleta === false && comFlag.estimada.freteNivel === "estimado_dimensoes_historicas", "estimada visível e rotulada");
  ok(comFlag.outra.margemIncompleta === false && comFlag.outra.marginPercent === 18, "outra conta intocada");
  ok(comFlag.sql.includes("cliente_conta_id IN (87)") && comFlag.sql.includes("jsonb_typeof(quality_json->'freteQualidade')"), comFlag.sql);

  for (const sem of [undefined, "", "abc", "*"]) {
    const r = rodar(sem);
    ok(r.antiga.margemIncompleta === false && r.antiga.marginPercent === 45.25, `flag ${JSON.stringify(sem)}: comportamento antigo`);
    ok(!r.sql.includes("freteQualidade"), "SQL idêntico ao original sem a flag");
  }
  console.log(`\nfreteLegadoBloqueioConta: ${checks} checks`);
}
