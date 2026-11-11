// server/tests/centralVendasRetencaoTravaReuso.postgres.test.js
//
// Trava S3 da retenção (docs/banco-de-dados/09_RETENCAO_X_REUSO_ESPECIFICACAO.md):
// enquanto existir vínculo de reuso, NENHUMA exclusão roda — CLI real
// (processo), modo auto e executor direto. Falha ao verificar ⇒ recusa.
//
//   CENTRAL_VENDAS_PG_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57651/postgres \
//     node tests/centralVendasRetencaoTravaReuso.postgres.test.js
//
// Sem a variável PULA. Host fora de localhost ⇒ recusa. Fixtures sintéticas.
// Quando S1+S2+S4 chegarem à main (GUARDA_VINCULOS = true), trocar a
// expectativa "recusa" por "protege fornecedores" (ver doc 09).

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function orders(ate) {
  const out = [];
  for (let i = 1; i <= ate; i++) {
    out.push({
      id: `8000${i}`, date_created: `2026-09-0${i}T10:00:00.000-03:00`, status: "paid", tags: [],
      payments: [{ id: `P${i}`, transaction_amount_refunded: 0 }],
      shipping: { id: `S${i}`, logistic_type: "cross_docking" },
      order_items: [{ item: { id: "MLB101", seller_sku: "SKU-MLB101", title: "Produto" }, quantity: 1, unit_price: 100 + i, sale_fee: 12 }],
    });
  }
  return out;
}

async function filho(url) {
  process.env.DATABASE_URL = url;
  const pool = require("../config/database");
  const repo = require("../services/centralVendas/centralVendasRepository");
  const { buildMotorFromOrders, buildCostMap, coverageParaCompetencia } = require("../services/centralVendas/centralVendasSyncService");
  const { buildResumoCentralVendas } = require("../services/centralVendas/centralVendasImportService");
  const ex = require("../services/centralVendas/retencao/centralVendasRetencaoExecutor");
  const auto = require("../services/centralVendas/retencao/centralVendasRetencaoAuto");

  const helper = fs.readFileSync(path.join(__dirname, "helpers", "centralVendasRetencaoPostgres.js"), "utf8");
  await pool.query(helper.split("const FIXTURES = `")[1].split("`;")[0]);
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "sql", "central_vendas_schema.sql"), "utf8"));
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "20261111_central_vendas_import_pedidos.sql"), "utf8"));

  const cliente = { id: 1, slug: "loja", nome: "Loja" };
  const costMap = buildCostMap([{ produto_id: "MLB101", custo_produto: 10, imposto_percentual: 6 }]);
  const frete = (os) => new Map(os.map((o) => [o.shipping.id, { valor: 9.9, status: "real", receitaComprador: 0 }]));
  async function noite(contaId, ate) {
    const os = orders(ate);
    const motor = buildMotorFromOrders({ orders: os, costMap, freteMap: frete(os), clienteSlug: "loja", competencia: "2026-09" });
    const dateTo = `2026-09-0${ate}`;
    const { rows: [run] } = await pool.query(
      `INSERT INTO central_vendas_sync_runs (cliente_id, cliente_slug, cliente_conta_id, marketplace, date_from, date_to, status)
       VALUES (1, 'loja', $1, 'meli', '2026-09-01', $2, 'completed') RETURNING id`, [contaId, dateTo]);
    const resumo = { ...buildResumoCentralVendas(motor), syncRunId: Number(run.id) };
    const { coverageFrom, coverageTo } = coverageParaCompetencia("2026-09", "2026-09-01", dateTo);
    const r = await repo.persistCentralVendasImport({
      cliente, marketplace: "meli", competencia: "2026-09", fonte: "orders_api",
      motorPayload: { ...motor, resumo }, resumo, clienteContaId: contaId,
      syncRunId: Number(run.id), publicationStatus: "candidate", coverageDateFrom: coverageFrom, coverageDateTo: coverageTo,
    });
    await repo.promoverCandidatesDoRun(Number(run.id));
    return { importId: Number(r.importacao.id), gravados: r.persistencia.gravados };
  }
  async function envelhecer() {
    await pool.query(`UPDATE central_vendas_imports SET created_at = NOW() - interval '10 days', updated_at = NOW() - interval '10 days', published_at = CASE WHEN published_at IS NULL THEN NULL ELSE NOW() - interval '10 days' END`);
    await pool.query(`UPDATE central_vendas_sync_runs SET created_at = NOW() - interval '10 days', finished_at = NOW() - interval '10 days'`);
  }
  const contagem = async () => (await pool.query(`SELECT COUNT(*)::int n FROM central_vendas_imports`)).rows[0].n;
  const vinculos = async () => (await pool.query(`SELECT COUNT(*)::int n FROM central_vendas_import_pedidos`)).rows[0].n;
  const silencioso = { log: () => {}, error: () => {} };
  const ENV_APPLY = { CENTRAL_VENDAS_RETENCAO_APPLY: "true" };
  const CFG = { minIdadeHoras: 24, manterUltimosSubstituidos: 0, incluirMpPayments: false };
  const R = [];
  const ok = (nome, c) => { assert.ok(c, nome); R.push(nome); };
  const executarApply = (extra = {}) => ex.executarRetencao({
    pool, escopo: { clienteSlug: "loja" }, apply: true, host: "127.0.0.1", env: { ...process.env, ...ENV_APPLY },
    cfg: CFG, logger: silencioso, ...extra,
  });
  const cli = (...args) => {
    const u = new URL(url);
    const r = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "central-vendas-retencao.js"), "--json", "--sem-estimativa", "--min-idade-horas=24", "--manter-ultimos=0", "--sem-mp", ...args], {
      env: { PATH: process.env.PATH, DATABASE_URL: u.toString(), CENTRAL_VENDAS_RETENCAO_APPLY: "true" }, encoding: "utf8",
    });
    return r;
  };

  // ── 1. Import SEM vínculos (conta 6, reuso desligado): a retenção funciona como antes.
  delete process.env.CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS;
  delete process.env.CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA;
  for (const n of [2, 3, 3]) await noite(6, n);
  await envelhecer();
  ok("sem vínculos: nenhuma linha em import_pedidos", (await vinculos()) === 0);
  ok("sem vínculos: dry-run lista elegíveis (plano normal)", (await ex.executarRetencao({ pool, escopo: { clienteSlug: "loja" }, apply: false, cfg: CFG, env: process.env, logger: silencioso })).plano.elegiveis.length === 2);
  const r1 = await executarApply({ escopo: { clienteSlug: "loja", contaId: 6 } });
  ok("sem vínculos: apply remove os 2 superados (comportamento atual preservado)", r1.motivoParada === "CONCLUIDO" && r1.totais.importsRemovidos === 2 && (await contagem()) === 1);

  // ── 2/3. Reuso ligado na conta 5: um import FORNECEDOR e outro que REUTILIZA.
  process.env.CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA = "true";
  process.env.CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS = "true";
  process.env.CENTRAL_VENDAS_SYNC_REUSO_CONTAS = "5";
  const forn = await noite(5, 2);                // fornecedor (grava completo: não há vigente)
  const reus = await noite(5, 3);                // reutiliza 2 pedidos do fornecedor
  const reus2 = await noite(5, 3);               // reutiliza os 3 (nada mudou)
  ok("fornecedor gravou pedidos próprios; o reutilizador só vínculos", forn.gravados.vinculos === 0 && reus.gravados.vinculos === 2 && reus2.gravados.vinculos === 3);
  await envelhecer();
  const antes = { imports: await contagem(), vinc: await vinculos() };
  ok("há vínculos de reuso", antes.vinc === 5);

  // Dry-run continua permitido com vínculos.
  const dry = await ex.executarRetencao({ pool, escopo: { clienteSlug: "loja" }, apply: false, cfg: CFG, env: process.env, logger: silencioso });
  ok("dry-run segue permitido com vínculos (só SELECT)", dry.modo === "dry-run" && (await contagem()) === antes.imports);

  // ── 4. Retenção por CLI (processo real): recusa, em qualquer escopo (trava global).
  for (const [nome, args] of [["conta do reuso", ["--conta=5"]], ["conta SEM reuso", ["--conta=6"]], ["cliente inteiro", ["--cliente=loja"]]]) {
    const r = cli("--apply", "--confirm-host=127.0.0.1", ...args);
    ok(`CLI --apply (${nome}) recusa com REUSO_ATIVO_SEM_GUARDA`, r.status === 1 && /REUSO_ATIVO_SEM_GUARDA/.test(r.stderr || ""));
  }
  ok("CLI: nada foi apagado", (await contagem()) === antes.imports && (await vinculos()) === antes.vinc);
  const rDry = cli("--cliente=loja");
  ok("CLI dry-run (sem --apply) continua funcionando", rDry.status === 0 && /"modo": "dry-run"/.test(rDry.stdout || ""));

  // ── Executor direto.
  let e = null;
  try { await executarApply(); } catch (err) { e = err; }
  ok("executor direto: REUSO_ATIVO_SEM_GUARDA", e && e.code === "REUSO_ATIVO_SEM_GUARDA");
  ok("executor direto: nada apagado", (await contagem()) === antes.imports);

  // ── 5. Retenção automática (hook pós-publicação): recusa, publicação não afetada, nada apaga.
  const logs = [];
  const logger = { log: (m) => logs.push(m), error: (m) => logs.push(`ERR ${m}`) };
  const envAuto = { ...process.env, CENTRAL_VENDAS_RETENCAO_AUTO: "true", CENTRAL_VENDAS_RETENCAO_APPLY: "true" };
  const ag = auto.agendarRetencaoAposPublicacao({ importIds: [reus2.importId], db: pool, env: envAuto, logger });
  await auto.aguardarOcioso();
  ok("auto: hook agendou e terminou sem lançar (publicação não afetada)", ag.agendado === true);
  ok("auto: recusou com REUSO_ATIVO_SEM_GUARDA", logs.some((l) => l.includes("REUSO_ATIVO_SEM_GUARDA")));
  ok("auto: nada apagado", (await contagem()) === antes.imports);
  ok("auto continua DESLIGADA por padrão", auto.retencaoAutoLigada({}) === false);

  // ── 6. Falha na verificação da tabela de vínculos ⇒ recusa (nunca assume 'sem vínculos').
  for (const [nome, falha] of [
    ["to_regclass lança", (sql) => (sql.includes("to_regclass") ? new Error("statement timeout") : null)],
    ["EXISTS lança", (sql) => (sql.includes("EXISTS") ? new Error("Connection terminated") : null)],
  ]) {
    const poolFalho = { query: async (sql, p) => { const f = falha(String(sql)); if (f) throw f; return pool.query(sql, p); }, connect: () => pool.connect() };
    let er = null;
    try { await ex.executarRetencao({ pool: poolFalho, escopo: { clienteSlug: "loja" }, apply: true, host: "127.0.0.1", env: { ...process.env, ...ENV_APPLY }, cfg: CFG, logger: silencioso }); } catch (err) { er = err; }
    ok(`falha na verificação (${nome}): recusa REUSO_VERIFICACAO_FALHOU`, er && er.code === "REUSO_VERIFICACAO_FALHOU");
  }
  ok("falha na verificação: nada apagado", (await contagem()) === antes.imports);
  // Resposta indeterminada também recusa.
  let ind = null;
  try { await ex.verificarReusoSemGuarda({ query: async () => ({ rows: [] }) }); } catch (err) { ind = err; }
  ok("resposta indeterminada recusa", ind && ind.code === "REUSO_VERIFICACAO_FALHOU");

  // ── Corrida: vínculo surge ENTRE o plano e o lote ⇒ a trava dentro do lote recusa.
  // (estado limpo: sem vínculos, depois um sync cria vínculos durante o apply)
  await pool.query(`DELETE FROM central_vendas_imports WHERE cliente_conta_id = 5`); // fixture local: reinicia a conta 5
  ok("fixture reiniciada sem vínculos", (await vinculos()) === 0);
  delete process.env.CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS;
  for (const n of [2, 3, 3]) await noite(5, n);
  await envelhecer();
  const imports0 = await contagem();
  process.env.CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS = "true";
  const r3 = await executarApply({
    escopo: { clienteSlug: "loja", contaId: 5 },
    depoisDoPlano: async () => { await noite(5, 3); }, // sync em modo reuso grava vínculos depois do plano
  });
  ok("vínculo criado depois do plano: o LOTE recusa (nada removido das tuplas em reuso)",
    r3.motivoParada === "ERRO" && r3.erro && r3.erro.code === "REUSO_ATIVO_SEM_GUARDA" && (await contagem()) >= imports0);

  // ── Tabela ausente CONFIRMADA: sem reuso possível, a retenção segue como antes.
  await pool.query(`DELETE FROM central_vendas_imports WHERE cliente_conta_id = 5`);
  await pool.query(`ALTER TABLE central_vendas_import_pedidos RENAME TO central_vendas_import_pedidos_off`);
  let semTabela = null;
  try { await ex.verificarReusoSemGuarda(pool); semTabela = "liberou"; } catch (err) { semTabela = err.code; }
  ok("tabela ausente confirmada: a trava libera (sem reuso)", semTabela === "liberou");
  await pool.query(`ALTER TABLE central_vendas_import_pedidos_off RENAME TO central_vendas_import_pedidos`);
  // Guarda implementada (futuro): a trava vira no-op.
  await ex.verificarReusoSemGuarda({ query: async () => { throw new Error("não deveria consultar"); } }, { guarda: true });
  ok("com GUARDA_VINCULOS=true a trava é no-op", ex.GUARDA_VINCULOS === false);

  await pool.end();
  process.stdout.write(`@@RESULTADO@@${JSON.stringify({ checks: R.length })}\n`);
}

async function pai() {
  const baseUrl = process.env.CENTRAL_VENDAS_PG_TEST_DATABASE_URL;
  if (!baseUrl) {
    console.log("centralVendasRetencaoTravaReuso.postgres.test.js: PULADO (defina CENTRAL_VENDAS_PG_TEST_DATABASE_URL para um PG local)");
    return;
  }
  if (!LOCAL.has(new URL(baseUrl).hostname)) throw new Error("LOCAL_DATABASE_REQUIRED");
  const { Client } = require("pg");
  const admin = new Client({ connectionString: baseUrl, ssl: false });
  await admin.connect();
  const nome = `vf_cv_trava_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  try {
    await admin.query(`CREATE DATABASE "${nome}"`);
    const url = new URL(baseUrl); url.pathname = `/${nome}`; url.searchParams.set("sslmode", "disable");
    const r = spawnSync(process.execPath, [__filename, "--filho", url.toString()], { env: { ...process.env }, encoding: "utf8", maxBuffer: 1 << 28 });
    const linha = (r.stdout || "").split("\n").find((l) => l.startsWith("@@RESULTADO@@"));
    if (r.status !== 0 || !linha) {
      console.error((r.stdout || "").slice(-3000)); console.error((r.stderr || "").slice(-3000));
      throw new Error(`filho falhou (exit ${r.status})`);
    }
    console.log(`centralVendasRetencaoTravaReuso.postgres.test.js: ${JSON.parse(linha.slice(13)).checks} verificacoes OK`);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
}

if (process.argv[2] === "--filho") {
  filho(process.argv[3]).catch((err) => { console.error(err); process.exit(1); });
} else {
  pai().catch((err) => { console.error(err); process.exit(1); });
}
