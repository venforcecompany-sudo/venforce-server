// server/tests/centralVendasRetencaoPostgres.test.js
//
// Retenção da Central de Vendas em PostgreSQL REAL local (descartável):
//   CENTRAL_VENDAS_RETENCAO_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57651/postgres node tests/centralVendasRetencaoPostgres.test.js
// Sem a variável: PULA (exit 0). Host não-local: recusa.
//
// Prova: dry-run não escreve; apply sem env/confirm-host recusa (executor e
// CLI); apply remove só os elegíveis sem órfãos; seleção real
// (resolveImportsForRange) idêntica antes/depois; re-avaliação dentro do lote
// (publicação nova + referência nova entre plano e lote); idempotência; lock
// da tupla adia o lote; export CSV; mp_payments por run; hook automático.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { urlDeTeste, criarAmbiente } = require("./helpers/centralVendasRetencaoPostgres");

if (!urlDeTeste()) {
  console.log("  (pulado) defina CENTRAL_VENDAS_RETENCAO_TEST_DATABASE_URL para rodar contra PostgreSQL local");
  process.exit(0);
}

const repository = require("../services/centralVendas/centralVendasRepository");
const { executarRetencao } = require("../services/centralVendas/retencao/centralVendasRetencaoExecutor");
const { agendarRetencaoAposPublicacao } = require("../services/centralVendas/retencao/centralVendasRetencaoAuto");

let checks = 0;
function ok(label) {
  checks += 1;
  console.log(`  ok  ${label}`);
}
const silencioso = { log: () => {}, error: () => {} };
const ENV = {}; // política padrão (72 h, manterUltimos=1), sem herdar env do shell

const VARIANTES = [
  { conta: 5, inc: false }, { conta: 5, inc: true }, { conta: null, inc: false }, { conta: 6, inc: false }, { conta: 6, inc: true },
];
const RANGES = [["2026-09-01", "2026-09-30"], ["2026-09-05", "2026-09-12"], ["2026-09-20", "2026-10-31"], ["2026-08-15", "2026-10-10"]];

async function selecoes(pool) {
  const out = {};
  for (const v of VARIANTES) {
    for (const [dateFrom, dateTo] of RANGES) {
      const r = await repository.resolveImportsForRange(
        { clienteSlug: "loja", dateFrom, dateTo, marketplace: "meli", clienteContaId: v.conta, includeLegacy: v.inc }, pool
      );
      out[`${v.conta}|${v.inc}|${dateFrom}..${dateTo}`] = r.importIds.map(Number);
    }
  }
  return out;
}

(async () => {
  const amb = await criarAmbiente("int");
  const { pool, q, criarRun, criarImport, criarMp, contar, orfaos } = amb;
  try {
    // ── Cenário (conta 5, 2026-09 = tupla T1) ─────────────────────────────
    const r0 = await criarRun({ criadoHaDias: 40 });
    const rf = await criarRun({ status: "failed", criadoHaDias: 25 });
    const rc = await criarRun({ criadoHaDias: 22 });
    const rSolo = await criarRun({ criadoHaDias: 15 });
    const rRecente = await criarRun({ criadoHaDias: 1 });
    const rAtivo = await criarRun({ status: "running", criadoHaDias: 30 });
    const A = await criarImport({ criadoHaDias: 40, run: r0 });
    const B = await criarImport({ criadoHaDias: 30 });
    const C = await criarImport({ criadoHaDias: 20 });
    const D = await criarImport({ criadoHaDias: 10 });
    const L = await criarImport({ status: "legacy", from: null, to: null, criadoHaDias: 50 });
    const X = await criarImport({ status: "candidate", criadoHaDias: 25, run: rf });
    const Y = await criarImport({ status: "candidate", criadoHaDias: 22, run: rc });
    const I = await criarImport({ from: "2026-10-01", to: "2026-09-30", criadoHaDias: 35 });
    const Z = await criarImport({ status: "candidate", criadoHaDias: 30, run: rAtivo });
    // T2 (2026-10, conta 5): vigente do MESMO run de A ⇒ mp de r0 fica
    const E = await criarImport({ competencia: "2026-10", from: "2026-10-01", to: "2026-10-31", criadoHaDias: 40, run: r0 });
    // T3 (legado NULL) e T4 (conta 6, coberturas parciais que não se contêm)
    const N0 = await criarImport({ conta: null, criadoHaDias: 30 });
    const P6a = await criarImport({ conta: 6, from: "2026-09-01", to: "2026-09-15", criadoHaDias: 30 });
    const P6b = await criarImport({ conta: 6, from: "2026-09-10", to: "2026-09-30", criadoHaDias: 20 });
    for (const r of [r0, rf, rSolo, rRecente]) await criarMp(r, 3);
    // Painel de Contas cita B (snapshot vigente na época)
    await q(`INSERT INTO cliente_360_resumos_mensais (cliente_id, cliente_slug, competencia, payload_json)
             VALUES (1, 'loja', '2026-09', $1)`, [JSON.stringify({ centralVendas: { contas: [{ clienteContaId: 5, importId: B }] } })]);

    const esperadoImports = [A, L, X, Y, I].sort((a, b) => a - b);

    // ── 1. dry-run não escreve ───────────────────────────────────────────
    const antes = await contar();
    const dry = await executarRetencao({ pool, env: ENV, comEstimativa: true, logger: silencioso });
    assert.strictEqual(dry.modo, "dry-run");
    assert.deepStrictEqual(dry.plano.elegiveis, esperadoImports);
    assert.deepStrictEqual(dry.plano.residuo.sort((a, b) => a - b), [X, Y, I].sort((a, b) => a - b));
    assert.ok(dry.plano.motivos[I].motivos.includes("cobertura_vazia"));
    assert.ok(dry.plano.motivos[B].motivos.includes("referenciado:painel_contas_snapshot"));
    assert.ok(dry.plano.motivos[C].motivos.includes("margem_rollback"));
    assert.strictEqual(dry.plano.motivos[Z].classe, "retido");
    for (const id of [D, E, N0, P6a, P6b]) assert.strictEqual(dry.plano.motivos[id].classe, "essencial", `id ${id}`);
    assert.deepStrictEqual(dry.plano.mp.elegiveis, [rf, rSolo].sort((a, b) => a - b));
    assert.ok(dry.plano.mp.motivos[r0].includes("run_de_import_retido"));
    assert.ok(dry.plano.mp.motivos[rRecente].includes("run_recente"));
    assert.strictEqual(dry.plano.espaco.porClasse.substituido.linhas.pedidos, 6);
    assert.strictEqual(dry.plano.espaco.porClasse.mp_payments.linhas.mp_payments, 6);
    assert.ok(dry.plano.espaco.totalBytesEstimados > 0);
    assert.deepStrictEqual(await contar(), antes);
    ok("dry-run: plano esperado (substituído/resíduo/cobertura_vazia/ref/margem/mp) e contagem de linhas idêntica");

    // ── 2. apply sem env / sem confirm-host recusa (antes de qualquer query) ─
    await assert.rejects(executarRetencao({ pool, env: ENV, apply: true, host: "127.0.0.1", logger: silencioso }), { code: "APPLY_ENV_AUSENTE" });
    await assert.rejects(
      executarRetencao({ pool, env: { CENTRAL_VENDAS_RETENCAO_APPLY: "true" }, apply: true, host: "db.producao.example", logger: silencioso }),
      { code: "CONFIRM_HOST_INVALIDO" }
    );
    await assert.rejects(executarRetencao({ pool, env: { CENTRAL_VENDAS_RETENCAO_APPLY: "true" }, apply: true, logger: silencioso }), { code: "HOST_DESCONHECIDO" });
    assert.deepStrictEqual(await contar(), antes);
    ok("executor: apply sem env / host não confirmado / host desconhecido recusa e nada muda");

    const cli = path.join(__dirname, "..", "scripts", "central-vendas-retencao.js");
    const envCli = { PATH: process.env.PATH, DATABASE_URL: amb.url };
    const cliDry = spawnSync(process.execPath, [cli, "--json", "--sem-estimativa"], { env: envCli, encoding: "utf8" });
    assert.strictEqual(cliDry.status, 0, cliDry.stderr);
    assert.ok(/host=127\.0\.0\.1/.test(cliDry.stderr));
    assert.deepStrictEqual(JSON.parse(cliDry.stdout).plano.elegiveis, esperadoImports);
    const cliApply = spawnSync(process.execPath, [cli, "--apply"], { env: envCli, encoding: "utf8" });
    assert.strictEqual(cliApply.status, 3, cliApply.stderr);
    assert.ok(/APPLY_ENV_AUSENTE/.test(cliApply.stderr));
    assert.deepStrictEqual(await contar(), antes);
    ok("CLI: dry-run --json devolve o mesmo plano; --apply sem env sai com 3 sem escrever");

    // ── 3. apply com re-avaliação concorrente ──────────────────────────
    const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-retencao-export-"));
    let selAntes = null;
    const envApply = { CENTRAL_VENDAS_RETENCAO_APPLY: "true" };
    const ap = await executarRetencao({
      pool, env: envApply, apply: true, host: "127.0.0.1", exportDir, logger: silencioso,
      depoisDoPlano: async () => {
        // entre o plano e o lote: Y é publicado (vira o vigente) e o Painel passa a citar L
        await q(`UPDATE central_vendas_imports SET publication_status = 'published', published_at = NOW() WHERE id = $1`, [Y]);
        await q(`INSERT INTO cliente_360_resumos_mensais (cliente_id, cliente_slug, competencia, payload_json)
                 VALUES (1, 'loja', '2026-08', $1)`, [JSON.stringify({ centralVendas: { contas: [{ importId: L }] } })]);
        selAntes = await selecoes(pool);
      },
    });
    assert.strictEqual(ap.motivoParada, "CONCLUIDO", JSON.stringify(ap.erro));
    const loteImports = ap.lotes.filter((l) => l.tipo === "imports");
    const removidos = loteImports.flatMap((l) => l.removidos).sort((a, b) => a - b);
    assert.deepStrictEqual(removidos, [A, X, I].sort((a, b) => a - b));
    const desistidos = loteImports.flatMap((l) => l.desistidos.map((d) => d.id)).sort((a, b) => a - b);
    assert.deepStrictEqual(desistidos, [L, Y].sort((a, b) => a - b));
    assert.deepStrictEqual(await selecoes(pool), selAntes);
    ok("apply: re-avaliação no lote poupa Y (publicado entre plano e lote) e L (citado entre plano e lote); seleção real idêntica");

    assert.deepStrictEqual(await orfaos(), { pedidos: 0, itens: 0, componentes: 0, charges: 0 });
    const depois = await contar();
    assert.strictEqual(depois.central_vendas_imports, antes.central_vendas_imports - 3);
    assert.strictEqual(depois.central_vendas_pedidos, antes.central_vendas_pedidos - 9);
    assert.strictEqual(depois.central_vendas_componentes, antes.central_vendas_componentes - 18);
    assert.strictEqual(depois.central_vendas_sync_runs, antes.central_vendas_sync_runs, "sync_runs nunca apagados");
    const mpRuns = (await q(`SELECT DISTINCT sync_run_id FROM central_vendas_mp_payments ORDER BY 1`)).map((r) => Number(r.sync_run_id));
    assert.deepStrictEqual(mpRuns, [r0, rRecente].sort((a, b) => a - b));
    assert.strictEqual(depois.central_vendas_mp_payment_charges, 12);
    assert.strictEqual(ap.totais.linhas.mp_payments, 6);
    assert.strictEqual(ap.totais.linhas.mp_payment_charges, 12);
    ok("integridade: sem órfãos (pedidos/itens/componentes/charges), contagens exatas, sync_runs intactos, mp só de runs sem import retido");

    const csvImports = fs.readFileSync(path.join(exportDir, "lote-0001-imports.csv"), "utf8").trim().split("\n");
    const csvPedidos = fs.readFileSync(path.join(exportDir, "lote-0001-pedidos.csv"), "utf8").trim().split("\n");
    assert.strictEqual(csvImports.length, 1 + 3);
    assert.strictEqual(csvPedidos.length, 1 + 9);
    assert.ok(csvImports[0].includes("payload_json"));
    fs.rmSync(exportDir, { recursive: true, force: true });
    ok("--export-dir: CSV dos imports e filhos do lote gravado antes do DELETE");

    // ── 4. idempotência ────────────────────────────────────────────────
    // Y virou vigente ⇒ D é a margem de rollback e C perdeu a margem: a 2ª
    // execução tira C (estado mudou); a 3ª não encontra nada.
    const ap2 = await executarRetencao({ pool, env: envApply, apply: true, host: "127.0.0.1", logger: silencioso });
    assert.deepStrictEqual(ap2.lotes.flatMap((l) => l.removidos || []), [C]);
    const ap3 = await executarRetencao({ pool, env: envApply, apply: true, host: "127.0.0.1", logger: silencioso });
    assert.strictEqual(ap3.totais.importsRemovidos, 0);
    assert.strictEqual(ap3.totais.mpRunsLimpos, 0);
    assert.deepStrictEqual(ap3.plano.elegiveis, []);
    ok("idempotente: sem mudança de estado, a execução seguinte remove 0");

    // ── 5. lock da tupla ⇒ lote adiado, sem esperar ────────────────────
    const K1 = await criarImport({ conta: 6, competencia: "2026-08", from: "2026-08-01", to: "2026-08-31", criadoHaDias: 30 });
    const K2 = await criarImport({ conta: 6, competencia: "2026-08", from: "2026-08-01", to: "2026-08-31", criadoHaDias: 20 });
    const K3 = await criarImport({ conta: 6, competencia: "2026-08", from: "2026-08-01", to: "2026-08-31", criadoHaDias: 10 });
    const cfg0 = { manterUltimosSubstituidos: 0 };
    const segurador = await pool.connect();
    await segurador.query("BEGIN");
    await segurador.query("SELECT id FROM central_vendas_imports WHERE id = $1 FOR UPDATE", [K3]);
    const t0 = Date.now();
    const bloqueado = await executarRetencao({ pool, env: envApply, apply: true, host: "127.0.0.1", escopo: { contaId: 6 }, cfg: cfg0, logger: silencioso });
    assert.ok(Date.now() - t0 < 5000, "não esperou o lock");
    assert.strictEqual(bloqueado.totais.importsRemovidos, 0);
    assert.strictEqual(bloqueado.lotes[0].adiado, "tupla_ocupada");
    await segurador.query("COMMIT");
    segurador.release();
    const liberado = await executarRetencao({ pool, env: envApply, apply: true, host: "127.0.0.1", escopo: { contaId: 6 }, cfg: cfg0, logger: silencioso });
    assert.deepStrictEqual(liberado.lotes.flatMap((l) => l.removidos || []).sort((a, b) => a - b), [K1, K2].sort((a, b) => a - b));
    ok("tupla travada por outra transação ⇒ lote adiado (NOWAIT); liberada ⇒ removidos");

    // ── 6. limite de lotes e sinal de interrupção ───────────────────────
    const W = [];
    for (let i = 0; i < 5; i += 1) W.push(await criarImport({ slug: "outra", conta: 7, competencia: "2026-07", from: "2026-07-01", to: "2026-07-31", criadoHaDias: 60 - i }));
    const limitado = await executarRetencao({ pool, env: envApply, apply: true, host: "127.0.0.1", escopo: { clienteSlug: "outra" }, cfg: cfg0, tamanhoLote: 2, limiteLotes: 1, logger: silencioso });
    assert.strictEqual(limitado.motivoParada, "LIMITE_LOTES");
    assert.strictEqual(limitado.totais.importsRemovidos, 2);
    const sinal = { interrompido: true };
    const parado = await executarRetencao({ pool, env: envApply, apply: true, host: "127.0.0.1", escopo: { clienteSlug: "outra" }, cfg: cfg0, tamanhoLote: 2, sinal, logger: silencioso });
    assert.strictEqual(parado.motivoParada, "SIGINT");
    assert.strictEqual(parado.totais.importsRemovidos, 0);
    ok("limiteLotes para após N lotes; sinal interrompido para antes do próximo lote");

    // ── 7. hook automático ──────────────────────────────────────────────
    let agendou = false;
    const desligado = agendarRetencaoAposPublicacao({ importIds: [W[4]], db: pool, env: {}, agendar: () => { agendou = true; } });
    assert.deepStrictEqual(desligado, { agendado: false, motivo: "desligado" });
    assert.strictEqual(agendou, false);
    let pendente = null;
    const envAuto = { CENTRAL_VENDAS_RETENCAO_AUTO: "true", CENTRAL_VENDAS_RETENCAO_MANTER_ULTIMOS: "0" };
    const ligado = agendarRetencaoAposPublicacao({ importIds: [W[4]], db: pool, env: envAuto, logger: silencioso, agendar: (fn) => { pendente = fn(); } });
    assert.strictEqual(ligado.agendado, true);
    await pendente;
    const restantes = (await q(`SELECT id FROM central_vendas_imports WHERE cliente_slug = 'outra' ORDER BY id`)).map((r) => Number(r.id));
    assert.deepStrictEqual(restantes, [W[4]]);
    const erros = [];
    const falha = agendarRetencaoAposPublicacao({
      importIds: [W[4]], db: pool, env: envAuto, logger: { log: () => {}, error: (m) => erros.push(m) },
      executar: async () => { throw new Error("boom"); }, agendar: (fn) => { pendente = fn(); },
    });
    assert.strictEqual(falha.agendado, true);
    await pendente;
    assert.ok(erros.some((m) => /boom/.test(m)));
    ok("hook: desligado não agenda nada; ligado limpa só a tupla publicada; erro vira log, nunca exceção");
  } finally {
    await amb.encerrar();
  }
  console.log(`\n✓ centralVendasRetencaoPostgres: ${checks} checks`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
