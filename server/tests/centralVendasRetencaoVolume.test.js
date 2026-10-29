// server/tests/centralVendasRetencaoVolume.test.js
//
// Volume em PostgreSQL REAL local: 30 syncs repetidos da MESMA tupla (500
// pedidos cada — cada sync regrava o mês inteiro, como em produção).
//   sem retenção ⇒ a tupla cresce linear (30 imports, 15.000 pedidos);
//   com retenção após cada sync ⇒ fica em vigente + manterUltimos (2 imports).
//   CENTRAL_VENDAS_RETENCAO_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57651/postgres node tests/centralVendasRetencaoVolume.test.js
// Sem a variável: PULA (exit 0).

const assert = require("assert");
const { urlDeTeste, criarAmbiente } = require("./helpers/centralVendasRetencaoPostgres");

if (!urlDeTeste()) {
  console.log("  (pulado) defina CENTRAL_VENDAS_RETENCAO_TEST_DATABASE_URL para rodar contra PostgreSQL local");
  process.exit(0);
}

const { executarRetencao } = require("../services/centralVendas/retencao/centralVendasRetencaoExecutor");

const SYNCS = 30;
const PEDIDOS = 500;
const silencioso = { log: () => {}, error: () => {} };

async function tamanhoTabelas(q) {
  const [r] = await q(`SELECT pg_total_relation_size('central_vendas_pedidos')
                            + pg_total_relation_size('central_vendas_pedido_itens')
                            + pg_total_relation_size('central_vendas_componentes')
                            + pg_total_relation_size('central_vendas_imports') AS bytes`);
  return Number(r.bytes);
}

async function simular(amb, { comRetencao }) {
  const linhasPorSync = [];
  for (let k = 0; k < SYNCS; k += 1) {
    // sync k aconteceu há (SYNCS - k) dias: todos mais velhos que 72h exceto os 3 últimos
    await amb.criarImport({ conta: comRetencao ? 5 : 6, criadoHaDias: SYNCS - k, pedidos: PEDIDOS });
    if (comRetencao) {
      const r = await executarRetencao({
        pool: amb.pool, env: { CENTRAL_VENDAS_RETENCAO_APPLY: "true" }, apply: true, host: "127.0.0.1",
        escopo: { contaId: 5 }, cfg: { minIdadeHoras: 0, manterUltimosSubstituidos: 1 }, logger: silencioso,
      });
      assert.ok(!r.erro, JSON.stringify(r.erro));
    }
    const [c] = await amb.q(
      `SELECT (SELECT COUNT(*) FROM central_vendas_imports WHERE cliente_conta_id = $1)::int AS imports,
              (SELECT COUNT(*) FROM central_vendas_pedidos p JOIN central_vendas_imports i ON i.id = p.import_id
                WHERE i.cliente_conta_id = $1)::int AS pedidos`,
      [comRetencao ? 5 : 6]
    );
    linhasPorSync.push(c);
  }
  return linhasPorSync;
}

(async () => {
  const amb = await criarAmbiente("vol");
  try {
    const t0 = Date.now();
    const sem = await simular(amb, { comRetencao: false });
    const bytesSem = await tamanhoTabelas(amb.q);
    const com = await simular(amb, { comRetencao: true });
    const ms = Date.now() - t0;

    assert.deepStrictEqual(sem[SYNCS - 1], { imports: SYNCS, pedidos: SYNCS * PEDIDOS });
    for (let k = 0; k < SYNCS; k += 1) assert.strictEqual(sem[k].pedidos, (k + 1) * PEDIDOS, "sem retenção cresce linear");
    for (let k = 1; k < SYNCS; k += 1) assert.deepStrictEqual(com[k], { imports: 2, pedidos: 2 * PEDIDOS }, `sync ${k + 1}`);
    assert.deepStrictEqual(com[0], { imports: 1, pedidos: PEDIDOS });
    assert.deepStrictEqual(await amb.orfaos(), { pedidos: 0, itens: 0, componentes: 0, charges: 0 });

    // Mesmo depois de 30 syncs, o vigente é o último e é o único selecionado
    const [vig] = await amb.q(`SELECT MAX(id)::int AS id FROM central_vendas_imports WHERE cliente_conta_id = 5`);
    const repository = require("../services/centralVendas/centralVendasRepository");
    const sel = await repository.resolveImportsForRange({ clienteSlug: "loja", dateFrom: "2026-09-01", dateTo: "2026-09-30", clienteContaId: 5 }, amb.pool);
    assert.deepStrictEqual(sel.importIds.map(Number), [vig.id]);

    console.log(`  ok  sem retenção: ${sem[SYNCS - 1].imports} imports / ${sem[SYNCS - 1].pedidos} pedidos (linear; tabelas ≈ ${(bytesSem / 1048576).toFixed(1)} MB)`);
    console.log(`  ok  com retenção após cada sync: ${com[SYNCS - 1].imports} imports / ${com[SYNCS - 1].pedidos} pedidos (vigente + manterUltimos=1)`);
    console.log(`  ok  sem órfãos; seleção = último sync (${ms} ms no total)`);
    console.log("\n✓ centralVendasRetencaoVolume: 3 checks");
  } finally {
    await amb.encerrar();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
