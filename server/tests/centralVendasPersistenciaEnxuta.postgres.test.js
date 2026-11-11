// server/tests/centralVendasPersistenciaEnxuta.postgres.test.js
//
// Prova da persistência enxuta contra PostgreSQL REAL e LOCAL:
//
//   CENTRAL_VENDAS_PG_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57651/postgres \
//     node tests/centralVendasPersistenciaEnxuta.postgres.test.js
//
// Sem a variável o teste PULA (exit 0). Host fora de localhost ⇒ recusa.
// Cria DOIS bancos descartáveis (modo completo × modo enxuto), simula N noites
// do sync noturno do mês corrente (noite k = dias 1..k, com pedidos novos e
// pedidos antigos que mudam de status/reembolso/frete), publica cada import
// como o worker faz e compara, noite a noite:
//   - leitura canônica (resolveImportsForRange + loadPedidosByImportIds +
//     loadRealizadoByImportIds) IDÊNTICA entre os modos;
//   - resumo financeiro (buildPayloadFromRange) IDÊNTICO;
//   - itens/componentes do modo enxuto reconstruídos == motorPayload;
//   - planilha manual continua com payload completo no modo enxuto;
// e mede linhas gravadas, bytes de JSON, tamanho em disco e tempo.
//
// Fixtures 100% sintéticas (ids, MLBs e valores gerados), sem dado real.
// SAIDA_RELATORIO=<arquivo.json> grava as medições para a documentação.

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const NOITES = Number(process.env.NOITES || 12);
const PEDIDOS_POR_DIA = Number(process.env.PEDIDOS_POR_DIA || 40);
const TAXA_MUDANCA = Number(process.env.TAXA_MUDANCA || 0.03);

// ---------------------------------------------------------------------------
// Gerador determinístico (mesmo conteúdo nos dois modos).
// ---------------------------------------------------------------------------
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function ordersDaNoite(noite) {
  const r = prng(424242);
  const todos = [];
  for (let dia = 1; dia <= noite; dia++) {
    for (let n = 0; n < PEDIDOS_POR_DIA; n++) {
      const id = `9${String(dia).padStart(2, "0")}${String(n).padStart(4, "0")}`;
      const qtd = 1 + Math.floor(r() * 3);
      const preco = Math.round((20 + r() * 300) * 100) / 100;
      const mlb = `MLB${100 + Math.floor(r() * 60)}`;
      todos.push({
        id, date_created: `2026-09-${String(dia).padStart(2, "0")}T1${n % 10}:00:00.000-03:00`,
        status: "paid", tags: [],
        payments: [{ id: `P${id}`, transaction_amount_refunded: 0 }],
        shipping: { id: `S${id}`, logistic_type: n % 4 === 0 ? "fulfillment" : "cross_docking" },
        order_items: [{ item: { id: mlb, seller_sku: `SKU-${mlb}`, title: `Produto ${mlb}` }, quantity: qtd, unit_price: preco, sale_fee: Math.round(preco * 0.12 * 100) / 100 }],
      });
    }
  }
  // Mudanças em pedidos ANTIGOS: cada noite j>1 altera ~TAXA_MUDANCA dos
  // pedidos existentes (determinístico por noite) — status, reembolso.
  for (let j = 2; j <= noite; j++) {
    const rj = prng(1000 + j);
    for (const o of todos) {
      const dia = Number(o.id.slice(1, 3));
      if (dia >= j) continue;
      if (rj() < TAXA_MUDANCA) {
        if (rj() < 0.5) o.status = "cancelled";
        else o.payments[0].transaction_amount_refunded = o.order_items[0].unit_price;
      }
    }
  }
  return todos;
}
function freteDaNoite(orders, noite) {
  const m = new Map();
  for (const o of orders) {
    const dia = Number(o.id.slice(1, 3));
    // frete de pedidos do dia de "ontem" ainda pode não ter chegado (ausente)
    if (dia === noite && Number(o.id.slice(-1)) % 5 === 0) continue;
    m.set(o.shipping.id, { valor: 9.9 + (Number(o.id.slice(-2)) % 7), status: "real", receitaComprador: 0 });
  }
  return m;
}

// ---------------------------------------------------------------------------
// Filho: roda as noites num banco, num modo, e imprime JSON.
// ---------------------------------------------------------------------------
async function filho({ url, modo }) {
  process.env.DATABASE_URL = url;
  if (modo === "enxuto") process.env.CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA = "true";
  else delete process.env.CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA;

  const pool = require("../config/database");
  const repo = require("../services/centralVendas/centralVendasRepository");
  const { buildMotorFromOrders, buildCostMap, coverageParaCompetencia } = require("../services/centralVendas/centralVendasSyncService");
  const { buildPayloadFromRange } = require("../services/centralVendas/centralVendasService");
  const pe = require("../services/centralVendas/centralVendasPersistenciaEnxuta");
  const { buildResumoCentralVendas } = require("../services/centralVendas/centralVendasImportService");

  const helper = fs.readFileSync(path.join(__dirname, "helpers", "centralVendasRetencaoPostgres.js"), "utf8");
  const fixtures = helper.split("const FIXTURES = `")[1].split("`;")[0];
  await pool.query(fixtures);
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "sql", "central_vendas_schema.sql"), "utf8"));

  const cliente = { id: 1, slug: "loja", nome: "Loja" };
  const costMap = buildCostMap(Array.from({ length: 60 }, (_, i) => ({
    produto_id: `MLB${100 + i}`, custo_produto: i % 9 === 0 ? null : 5 + i * 0.73, imposto_percentual: 6,
  })));

  const noites = [];
  const sem = (row, chaves) => { const o = { ...row }; for (const k of chaves) delete o[k]; return o; };
  const VOLATEIS = ["id", "import_id", "pedido_row_id", "item_row_id", "created_at", "updated_at"];

  for (let noite = 1; noite <= NOITES; noite++) {
    const orders = ordersDaNoite(noite);
    const motor = buildMotorFromOrders({
      orders, costMap, freteMap: freteDaNoite(orders, noite), clienteSlug: cliente.slug, competencia: "2026-09",
    });
    const resumo = { ...buildResumoCentralVendas(motor), syncRunId: null };
    const { rows: [run] } = await pool.query(
      `INSERT INTO central_vendas_sync_runs (cliente_id, cliente_slug, cliente_conta_id, marketplace, date_from, date_to, status)
       VALUES (1, 'loja', 5, 'meli', '2026-09-01', $1, 'completed') RETURNING id`,
      [`2026-09-${String(noite).padStart(2, "0")}`]
    );
    resumo.syncRunId = Number(run.id);
    const dateTo = `2026-09-${String(noite).padStart(2, "0")}`;
    const { coverageFrom, coverageTo } = coverageParaCompetencia("2026-09", "2026-09-01", dateTo);
    const t0 = Date.now();
    const persisted = await repo.persistCentralVendasImport({
      cliente, marketplace: "meli", competencia: "2026-09", fonte: "orders_api",
      motorPayload: { ...motor, resumo }, resumo, clienteContaId: 5,
      syncRunId: Number(run.id), publicationStatus: "candidate", coverageDateFrom: coverageFrom, coverageDateTo: coverageTo,
    });
    const ms = Date.now() - t0;
    await repo.promoverCandidatesDoRun(Number(run.id));

    // Leitura canônica (o que Central/Painel/Margem/Fechamento-API leem).
    const range = { clienteSlug: "loja", dateFrom: "2026-09-01", dateTo, clienteContaId: 5 };
    const { importIds, imports } = await repo.resolveImportsForRange(range);
    const carga = await repo.loadPedidosByImportIds({ importIds, dateFrom: range.dateFrom, dateTo });
    const realizado = await repo.loadRealizadoByImportIds({ importIds, dateFrom: range.dateFrom, dateTo });
    const snapshot = await repo.getCentralVendasByRange(range);
    const payload = buildPayloadFromRange(cliente, { dateFrom: range.dateFrom, dateTo }, snapshot);

    // Reconstrução (só faz sentido no enxuto, mas roda nos dois).
    const { rows: itensDb } = await pool.query(`SELECT * FROM central_vendas_pedido_itens WHERE import_id = $1 ORDER BY id`, [persisted.importacao.id]);
    const { rows: compsDb } = await pool.query(`SELECT * FROM central_vendas_componentes WHERE import_id = $1 ORDER BY id`, [persisted.importacao.id]);
    const norm = (o) => JSON.parse(JSON.stringify(o));
    const comNulls = (orig, rec) => { const out = norm(orig); for (const k of Object.keys(rec)) if (!(k in out)) out[k] = null; return out; };
    let reconstrucaoOk = itensDb.length === motor.itens.length && compsDb.length === motor.componentes.length;
    itensDb.forEach((row, i) => {
      const rec = pe.reconstruirItem(row);
      try { assert.deepStrictEqual(rec, comNulls(motor.itens[i], rec)); } catch { reconstrucaoOk = false; }
    });
    compsDb.forEach((row, i) => {
      const rec = pe.reconstruirComponente(row);
      try { assert.deepStrictEqual(rec, comNulls(motor.componentes[i], rec)); } catch { reconstrucaoOk = false; }
    });

    noites.push({
      noite,
      pedidosNoSnapshot: motor.pedidos.length,
      linhas: { pedidos: persisted.pedidosPersistidos, itens: persisted.itensPersistidos, componentes: persisted.componentesPersistidos },
      persistencia: persisted.persistencia,
      msPersistir: ms,
      importsVigentes: imports.map((i) => Number(i.id)),
      leitura: JSON.stringify({
        pedidos: carga.pedidos.map((p) => sem(p, VOLATEIS)),
        itens: carga.itens.map((p) => sem(p, VOLATEIS)),
        componentes: carga.componentes.map((p) => sem(p, VOLATEIS)),
        realizado: {
          pedidos: realizado.pedidos.map((p) => sem(p, VOLATEIS)),
          itens: realizado.itens.map((p) => sem(p, VOLATEIS)),
          componentes: realizado.componentes.map((p) => sem(p, VOLATEIS)),
        },
      }),
      financeiro: JSON.stringify({ resumo: payload.resumo, pedidos: (payload.pedidos || []).map((p) => sem(p, ["id", "rowId", "importId"])) }),
      reconstrucaoOk,
    });
  }

  // Planilha manual no mesmo banco: payload completo SEMPRE (protegida).
  const motorPlanilha = { pedidos: [], itens: [], componentes: [], resumo: { manual: true } };
  const planilha = await repo.persistCentralVendasImport({
    cliente, marketplace: "meli", competencia: "2026-08", fonte: "planilha_vendas",
    motorPayload: motorPlanilha, resumo: motorPlanilha.resumo, clienteContaId: 5,
  });
  const { rows: [pl] } = await pool.query(`SELECT payload_json FROM central_vendas_imports WHERE id = $1`, [planilha.importacao.id]);

  await pool.query("ANALYZE");
  const { rows: tamanhos } = await pool.query(
    `SELECT c.relname AS tabela, pg_total_relation_size(c.oid)::bigint AS total, pg_relation_size(c.oid)::bigint AS heap,
            pg_indexes_size(c.oid)::bigint AS indices, COALESCE(pg_total_relation_size(c.reltoastrelid), 0)::bigint AS toast
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname IN ('central_vendas_imports','central_vendas_pedidos','central_vendas_pedido_itens','central_vendas_componentes')
      ORDER BY 1`
  );
  const { rows: payloads } = await pool.query(
    `SELECT 'imports' AS t, COALESCE(SUM(pg_column_size(payload_json)),0)::bigint AS b FROM central_vendas_imports
     UNION ALL SELECT 'pedidos', COALESCE(SUM(pg_column_size(payload_json)),0)::bigint FROM central_vendas_pedidos
     UNION ALL SELECT 'itens', COALESCE(SUM(pg_column_size(payload_json)),0)::bigint FROM central_vendas_pedido_itens
     UNION ALL SELECT 'componentes', COALESCE(SUM(pg_column_size(payload_json)),0)::bigint FROM central_vendas_componentes`
  );
  await pool.end();
  process.stdout.write(`@@RESULTADO@@${JSON.stringify({
    modo, noites, tamanhos, payloads,
    planilhaPayloadCompleto: !!(pl.payload_json && pl.payload_json.resumo && pl.payload_json.resumo.manual === true && Array.isArray(pl.payload_json.pedidos)),
  })}\n`);
}

// ---------------------------------------------------------------------------
// Pai: cria os bancos, roda os dois modos, compara.
// ---------------------------------------------------------------------------
async function pai() {
  const baseUrl = process.env.CENTRAL_VENDAS_PG_TEST_DATABASE_URL;
  if (!baseUrl) {
    console.log("centralVendasPersistenciaEnxuta.postgres.test.js: PULADO (defina CENTRAL_VENDAS_PG_TEST_DATABASE_URL para um PG local)");
    return;
  }
  const host = new URL(baseUrl).hostname;
  console.log(`  banco de teste: host=${host}`);
  if (!LOCAL.has(host)) throw new Error("LOCAL_DATABASE_REQUIRED");
  const { Client } = require("pg");
  const admin = new Client({ connectionString: baseUrl, ssl: false });
  await admin.connect();
  const sufixo = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const resultados = {};
  const nomes = [];
  try {
    for (const modo of ["completo", "enxuto"]) {
      const nome = `vf_cv_enxuta_${modo}_${sufixo}`;
      nomes.push(nome);
      await admin.query(`CREATE DATABASE "${nome}"`);
      const url = new URL(baseUrl); url.pathname = `/${nome}`; url.searchParams.set("sslmode", "disable");
      const r = spawnSync(process.execPath, [__filename, "--filho", modo, url.toString()], {
        env: { ...process.env, PGSSLMODE: "disable" }, encoding: "utf8", maxBuffer: 512 * 1024 * 1024,
      });
      const linha = (r.stdout || "").split("\n").find((l) => l.startsWith("@@RESULTADO@@"));
      if (r.status !== 0 || !linha) {
        console.error(r.stdout?.slice(-3000)); console.error(r.stderr?.slice(-3000));
        throw new Error(`filho ${modo} falhou (exit ${r.status})`);
      }
      resultados[modo] = JSON.parse(linha.slice("@@RESULTADO@@".length));
    }
  } finally {
    for (const nome of nomes) await admin.query(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }

  const { completo, enxuto } = resultados;
  let checks = 0;
  const ok = (label, cond) => { assert.ok(cond, `FALHOU: ${label}`); checks += 1; };

  for (let i = 0; i < NOITES; i++) {
    const a = completo.noites[i], b = enxuto.noites[i];
    ok(`noite ${a.noite}: leitura canônica idêntica (pedidos/itens/componentes/realizado)`, a.leitura === b.leitura);
    ok(`noite ${a.noite}: resumo financeiro e pedidos do payload idênticos`, a.financeiro === b.financeiro);
    ok(`noite ${a.noite}: mesmas linhas gravadas`, JSON.stringify(a.linhas) === JSON.stringify(b.linhas));
    ok(`noite ${a.noite}: enxuto reconstrói itens/componentes sem perda`, b.reconstrucaoOk === true);
    ok(`noite ${a.noite}: bytes de JSON menores no enxuto`, b.persistencia.bytesJsonEstimados < a.persistencia.bytesJsonEstimados);
    if (i === 0) ok("noite 1: sem manifesto anterior", b.persistencia.diff && b.persistencia.diff.comparavel === false);
    else ok(`noite ${a.noite}: diff comparável`, b.persistencia.diff && b.persistencia.diff.comparavel === true);
  }
  ok("planilha manual mantém payload completo no modo enxuto", enxuto.planilhaPayloadCompleto === true);

  const total = (r) => r.tamanhos.reduce((s, t) => s + Number(t.total), 0);
  ok("tamanho total em disco menor no enxuto", total(enxuto) < total(completo));

  const relatorio = {
    parametros: { NOITES, PEDIDOS_POR_DIA, TAXA_MUDANCA },
    porNoite: completo.noites.map((a, i) => {
      const b = enxuto.noites[i];
      return {
        noite: a.noite, pedidosNoSnapshot: a.pedidosNoSnapshot, linhas: a.linhas,
        bytesJsonCompleto: a.persistencia.bytesJsonEstimados, bytesJsonEnxuto: b.persistencia.bytesJsonEstimados,
        msCompleto: a.msPersistir, msEnxuto: b.msPersistir, diff: b.persistencia.diff,
      };
    }),
    tamanhos: { completo: completo.tamanhos, enxuto: enxuto.tamanhos },
    payloadJsonBytes: { completo: completo.payloads, enxuto: enxuto.payloads },
    totalBytes: { completo: total(completo), enxuto: total(enxuto) },
  };
  if (process.env.SAIDA_RELATORIO) fs.writeFileSync(process.env.SAIDA_RELATORIO, JSON.stringify(relatorio, null, 2));
  const somaDiff = relatorio.porNoite.slice(1).reduce((s, n) => ({
    novos: s.novos + n.diff.novos, alterados: s.alterados + n.diff.alterados, inalterados: s.inalterados + n.diff.inalterados,
  }), { novos: 0, alterados: 0, inalterados: 0 });
  console.log(`  disco: completo=${relatorio.totalBytes.completo} enxuto=${relatorio.totalBytes.enxuto}`
    + ` (${(100 * (1 - relatorio.totalBytes.enxuto / relatorio.totalBytes.completo)).toFixed(1)}% menor)`);
  console.log(`  noites 2..${NOITES}: novos=${somaDiff.novos} alterados=${somaDiff.alterados} inalterados=${somaDiff.inalterados}`);
  console.log(`centralVendasPersistenciaEnxuta.postgres.test.js: ${checks} verificacoes OK`);
}

if (process.argv[2] === "--filho") {
  filho({ modo: process.argv[3], url: process.argv[4] }).catch((err) => { console.error(err); process.exit(1); });
} else {
  pai().catch((err) => { console.error(err); process.exit(1); });
}
