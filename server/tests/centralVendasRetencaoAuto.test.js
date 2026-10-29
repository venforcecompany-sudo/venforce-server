// server/tests/centralVendasRetencaoAuto.test.js
//
// Retenção automática pós-publicação — fila single-flight por processo,
// sem banco (db e executor falsos):
//   - desligada (sem CENTRAL_VENDAS_RETENCAO_AUTO=true) não agenda nada;
//   - N publicações simultâneas ⇒ no máximo 1 execução concorrente, e todas
//     as tuplas (inclusive as que chegam DURANTE a execução) são processadas;
//   - pool com espera (waitingCount > 0) ⇒ a rodada não roda;
//   - o modo auto passa statement_timeout 15 s / lock_timeout 2 s também ao
//     planejamento (o executor aplica no BEGIN READ ONLY do plano).

const assert = require("assert");
const { agendarRetencaoAposPublicacao, aguardarOcioso } = require("../services/centralVendas/retencao/centralVendasRetencaoAuto");
const { executarRetencao } = require("../services/centralVendas/retencao/centralVendasRetencaoExecutor");

let checks = 0;
async function check(label, fn) {
  await fn();
  checks += 1;
  console.log(`  ok  ${label}`);
}

const ENV = { CENTRAL_VENDAS_RETENCAO_AUTO: "true" };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// db falso: resolve cada import id numa tupla própria (conta = id).
function dbFalso() {
  return {
    waitingCount: 0,
    connect() { throw new Error("não usado"); },
    async query(_sql, [ids]) {
      return { rows: ids.map((id) => ({ cliente_slug: "loja", marketplace: "meli", competencia: "2026-09", cliente_conta_id: id })) };
    },
  };
}

function resultadoVazio() {
  return { totais: { importsRemovidos: 0, mpRunsLimpos: 0 }, motivoParada: "CONCLUIDO", erro: null };
}

(async () => {
  await check("desligado: não agenda nada", async () => {
    let agendou = false;
    const r = agendarRetencaoAposPublicacao({ importIds: [1], db: dbFalso(), env: {}, agendar: () => { agendou = true; } });
    assert.deepStrictEqual(r, { agendado: false, motivo: "desligado" });
    assert.strictEqual(agendou, false);
  });

  await check("N publicações simultâneas ⇒ no máximo 1 execução concorrente; chegadas durante a execução também drenam", async () => {
    const db = dbFalso();
    const logs = [];
    const logger = { log: (m) => logs.push(m), error: (m) => logs.push(m) };
    let ativos = 0;
    let maxAtivos = 0;
    const processadas = [];
    let opcoesVistas = null;
    const executar = async (opts) => {
      ativos += 1;
      maxAtivos = Math.max(maxAtivos, ativos);
      opcoesVistas = opts;
      await espera(15);
      processadas.push(opts.escopo.tupla.cliente_conta_id);
      if (opts.escopo.tupla.cliente_conta_id === 1) {
        // uma publicação chega no meio da execução
        const r = agendarRetencaoAposPublicacao({ importIds: [99], db, env: ENV, logger, executar });
        assert.strictEqual(r.motivo, "enfileirado");
      }
      ativos -= 1;
      return resultadoVazio();
    };
    const respostas = [];
    for (let id = 1; id <= 6; id += 1) respostas.push(agendarRetencaoAposPublicacao({ importIds: [id], db, env: ENV, logger, executar }));
    assert.strictEqual(respostas[0].motivo, null);
    assert.ok(respostas.slice(1).every((r) => r.agendado && r.motivo === "enfileirado"));
    await aguardarOcioso();
    assert.strictEqual(maxAtivos, 1);
    assert.deepStrictEqual([...processadas].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 99]);
    assert.strictEqual(opcoesVistas.statementTimeoutMs, 15000);
    assert.strictEqual(opcoesVistas.statementTimeoutPlanoMs, 15000);
    assert.strictEqual(opcoesVistas.lockTimeoutMs, 2000);
    assert.strictEqual(opcoesVistas.autorizacao, "auto");
  });

  await check("pool com espera ⇒ não roda; os pendentes saem na próxima publicação com pool livre", async () => {
    const db = dbFalso();
    db.waitingCount = 2;
    const logs = [];
    const logger = { log: (m) => logs.push(m), error: (m) => logs.push(m) };
    const processadas = [];
    const executar = async (opts) => { processadas.push(opts.escopo.tupla.cliente_conta_id); return resultadoVazio(); };
    agendarRetencaoAposPublicacao({ importIds: [7], db, env: ENV, logger, executar });
    await aguardarOcioso();
    assert.deepStrictEqual(processadas, []);
    assert.ok(logs.some((m) => /adiada: pool com espera/.test(m)));
    db.waitingCount = 0;
    agendarRetencaoAposPublicacao({ importIds: [8], db, env: ENV, logger, executar });
    await aguardarOcioso();
    assert.deepStrictEqual(processadas.sort((a, b) => a - b), [7, 8]);
  });

  await check("executor: timeouts do modo auto valem no BEGIN READ ONLY do planejamento", async () => {
    const sqls = [];
    const pool = {
      async connect() {
        return {
          release() {},
          async query(sql) {
            sqls.push(String(sql));
            if (/^(BEGIN|SET LOCAL|ROLLBACK|COMMIT)/.test(String(sql).trim())) return { rows: [] };
            throw Object.assign(new Error("parar aqui"), { code: "TESTE" });
          },
        };
      },
    };
    await assert.rejects(
      executarRetencao({ pool, env: ENV, apply: true, autorizacao: "auto", statementTimeoutPlanoMs: 15000, lockTimeoutMs: 2000, logger: { log() {}, error() {} } }),
      { code: "TESTE" }
    );
    assert.strictEqual(sqls[0], "BEGIN READ ONLY");
    assert.strictEqual(sqls[1], "SET LOCAL statement_timeout = 15000");
    assert.strictEqual(sqls[2], "SET LOCAL lock_timeout = 2000");
  });

  await check("erro no executor vira log; a fila volta a ficar ociosa", async () => {
    const erros = [];
    const r = agendarRetencaoAposPublicacao({
      importIds: [5], db: dbFalso(), env: ENV, logger: { log() {}, error: (m) => erros.push(m) },
      executar: async () => { throw new Error("boom"); },
    });
    assert.strictEqual(r.agendado, true);
    await aguardarOcioso();
    assert.ok(erros.some((m) => /boom/.test(m)));
    const r2 = agendarRetencaoAposPublicacao({ importIds: [6], db: dbFalso(), env: ENV, logger: { log() {}, error() {} }, executar: async () => resultadoVazio() });
    assert.strictEqual(r2.motivo, null, "não ficou travada em 'executando'");
    await aguardarOcioso();
  });

  console.log(`\n✓ centralVendasRetencaoAuto: ${checks} checks`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
