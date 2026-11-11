// server/tests/centralVendasPersistenciaEnxuta.postgres.test.js
//
// Três versões da persistência do Sync contra PostgreSQL REAL e LOCAL:
//   completo — comportamento da main (flags desligadas);
//   enxuto   — CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA=true;
//   reuso    — enxuto + CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS=true + migration
//              20261111_central_vendas_import_pedidos aplicada.
//
//   CENTRAL_VENDAS_PG_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57651/postgres \
//     node tests/centralVendasPersistenciaEnxuta.postgres.test.js
//
// Sem a variável o teste PULA (exit 0). Host fora de localhost ⇒ recusa.
// Um banco descartável por versão; as MESMAS N noites do sync noturno do mês
// corrente (noite k = dias 1..k; pedidos novos + pedidos antigos que mudam de
// status/reembolso + frete que chega atrasado); cada import é publicado como o
// worker faz. Noite a noite, as três versões precisam devolver o MESMO
// resultado em todos os leitores atuais:
//   Central (resolveImportsForRange + loadPedidosByImportIds, getLatest,
//   detalhe de pedido), realizado da Margem (loadRealizadoByImportIds), resumo
//   financeiro (buildPayloadFromRange), Painel de Contas (pedidos, composição,
//   sobreposição) e Cliente 360 (carregarPedidosEItens + consolidarCentral);
// candidate não vaza antes da publicação; planilha manual intacta; e, no
// reuso, a FK impede apagar linhas ainda usadas por um import vigente.
//
// Fixtures 100% sintéticas. SAIDA_RELATORIO=<arquivo.json> grava as medições.

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const NOITES = Number(process.env.NOITES || 12);
const PEDIDOS_POR_DIA = Number(process.env.PEDIDOS_POR_DIA || 40);
const TAXA_MUDANCA = Number(process.env.TAXA_MUDANCA || 0.03);
const MODOS = ["completo", "enxuto", "reuso"];

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
    // frete de "ontem" pode ainda não ter chegado — chega na noite seguinte
    // (pedido alterado legitimamente: frete de null → valor)
    if (dia === noite && Number(o.id.slice(-1)) % 5 === 0) continue;
    m.set(o.shipping.id, { valor: 9.9 + (Number(o.id.slice(-2)) % 7), status: "real", receitaComprador: 0 });
  }
  return m;
}

// ---------------------------------------------------------------------------
async function filho({ url, modo }) {
  process.env.DATABASE_URL = url;
  delete process.env.CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA;
  delete process.env.CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS;
  if (modo !== "completo") process.env.CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA = "true";
  if (modo === "reuso") process.env.CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS = "true";

  const pool = require("../config/database");
  const repo = require("../services/centralVendas/centralVendasRepository");
  const { buildMotorFromOrders, buildCostMap, coverageParaCompetencia } = require("../services/centralVendas/centralVendasSyncService");
  const { buildPayloadFromRange } = require("../services/centralVendas/centralVendasService");
  const { buildResumoCentralVendas } = require("../services/centralVendas/centralVendasImportService");
  const painelRepo = require("../services/painelContas/painelContasRepository");
  const c360 = require("../services/centralVendas/centralVendasCliente360Adapter");
  const pe = require("../services/centralVendas/centralVendasPersistenciaEnxuta");

  const helper = fs.readFileSync(path.join(__dirname, "helpers", "centralVendasRetencaoPostgres.js"), "utf8");
  await pool.query(helper.split("const FIXTURES = `")[1].split("`;")[0]);
  await pool.query(fs.readFileSync(path.join(__dirname, "..", "sql", "central_vendas_schema.sql"), "utf8"));
  if (modo === "reuso") {
    await pool.query(fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "20261111_central_vendas_import_pedidos.sql"), "utf8"));
  }

  const cliente = { id: 1, slug: "loja", nome: "Loja" };
  const costMap = buildCostMap(Array.from({ length: 60 }, (_, i) => ({
    produto_id: `MLB${100 + i}`, custo_produto: i % 9 === 0 ? null : 5 + i * 0.73, imposto_percentual: 6,
  })));
  const VOLATEIS = ["id", "import_id", "pedido_row_id", "item_row_id", "created_at", "updated_at"];
  const sem = (row) => { const o = { ...row }; for (const k of VOLATEIS) delete o[k]; return o; };
  const ordenar = (rows, chave) => [...rows].sort((a, b) => String(chave(a)).localeCompare(String(chave(b))));

  async function lerTudo(dateTo) {
    const range = { clienteSlug: "loja", dateFrom: "2026-09-01", dateTo, clienteContaId: 5 };
    const { importIds, imports } = await repo.resolveImportsForRange(range);
    const carga = await repo.loadPedidosByImportIds({ importIds, dateFrom: range.dateFrom, dateTo });
    const realizado = await repo.loadRealizadoByImportIds({ importIds, dateFrom: range.dateFrom, dateTo });
    const latest = await repo.getLatestCentralVendasImport({ clienteSlug: "loja", competencia: "2026-09", clienteContaId: 5 });
    const snapshot = await repo.getCentralVendasByRange(range);
    const payload = buildPayloadFromRange(cliente, { dateFrom: range.dateFrom, dateTo }, snapshot);
    const detalhes = [];
    for (const p of carga.pedidos.slice(0, 3)) {
      // eslint-disable-next-line no-await-in-loop
      const d = await repo.getPedidoDetailByRowId({ importIds, dateFrom: range.dateFrom, dateTo, rowId: p.id });
      detalhes.push({ pedido: sem(d.pedido), itens: d.itens.map(sem), componentes: d.componentes.map(sem),
        importLidoOk: d.itens.every((i) => String(i.import_id) === String(d.pedido.import_id)) });
    }
    const painelPedidos = await painelRepo.listarPedidosDosImports(importIds, { inicio: range.dateFrom, fim: dateTo });
    const painelComp = await painelRepo.listarComposicaoDosImports(importIds);
    const sobreposicao = await painelRepo.medirSobreposicaoDosImports([...importIds, ...importIds]);
    const c = await c360.carregarPedidosEItens(importIds, pool);
    const consolidado = c360.consolidarCentral({ imports, pedidos: c.pedidos, itens: c.itens });
    const ids = importIds.map(String);
    return {
      // Todo leitor por import devolve o import LIDO (nunca o dono da linha).
      importLidoOk: carga.pedidos.every((p) => ids.includes(String(p.import_id)))
        && painelPedidos.every((p) => ids.includes(String(p.import_id)))
        && c.pedidos.every((p) => ids.includes(String(p.import_id)))
        && carga.itens.every((i) => ids.includes(String(i.import_id))),
      texto: JSON.stringify({
        pedidos: carga.pedidos.map(sem), itens: carga.itens.map(sem), componentes: carga.componentes.map(sem),
        realizado: { pedidos: realizado.pedidos.map(sem), itens: realizado.itens.map(sem), componentes: realizado.componentes.map(sem) },
        latest: latest ? { pedidos: latest.pedidos.map(sem), itens: latest.itens.map(sem), componentes: latest.componentes.map(sem) } : null,
        detalhes,
        // O Painel só SOMA por semana: compara o multiconjunto (a ordem de
        // desempate por id difere quando linhas são reaproveitadas).
        painel: { pedidos: ordenar(painelPedidos.map(sem), (r) => JSON.stringify(r)), composicao: ordenar(painelComp.map(sem), (r) => `${r.status}|${r.pos_venda_tipo}`), sobreposicao },
        cliente360: consolidado,
      }),
      financeiro: JSON.stringify({ resumo: payload.resumo, pedidos: (payload.pedidos || []).map((p) => { const o = { ...p }; delete o.id; delete o.rowId; delete o.importId; return o; }) }),
    };
  }

  const noites = [];
  let anterior = null;
  // Noites 1..N do mês corrente + 1 "fechamento" (mesmos pedidos da noite N,
  // cobertura do mês inteiro: exercita getLatestCentralVendasImport e o caso
  // "nada mudou" — reuso total).
  for (let noite = 1; noite <= NOITES + 1; noite++) {
    const fechamento = noite === NOITES + 1;
    const orders = ordersDaNoite(fechamento ? NOITES : noite);
    const motor = buildMotorFromOrders({ orders, costMap, freteMap: freteDaNoite(orders, fechamento ? NOITES : noite), clienteSlug: cliente.slug, competencia: "2026-09" });
    const dateTo = fechamento ? "2026-09-30" : `2026-09-${String(noite).padStart(2, "0")}`;
    const { rows: [run] } = await pool.query(
      `INSERT INTO central_vendas_sync_runs (cliente_id, cliente_slug, cliente_conta_id, marketplace, date_from, date_to, status)
       VALUES (1, 'loja', 5, 'meli', '2026-09-01', $1, 'completed') RETURNING id`, [dateTo]
    );
    const resumo = { ...buildResumoCentralVendas(motor), syncRunId: Number(run.id) };
    const { coverageFrom, coverageTo } = coverageParaCompetencia("2026-09", "2026-09-01", dateTo);
    const t0 = Date.now();
    const persisted = await repo.persistCentralVendasImport({
      cliente, marketplace: "meli", competencia: "2026-09", fonte: "orders_api",
      motorPayload: { ...motor, resumo }, resumo, clienteContaId: 5,
      syncRunId: Number(run.id), publicationStatus: "candidate", coverageDateFrom: coverageFrom, coverageDateTo: coverageTo,
    });
    const ms = Date.now() - t0;

    // Candidate não vaza: antes de publicar, a leitura continua a da noite anterior.
    let candidateIsolado = true;
    if (anterior) candidateIsolado = (await lerTudo(anterior.dateTo)).texto === anterior.leitura.texto;
    await repo.promoverCandidatesDoRun(Number(run.id));
    const leitura = await lerTudo(dateTo);

    // Conteúdo do import (próprios + vinculados) reconstrói o motorPayload.
    const conteudo = await repo.loadPedidosByImportIds({ importIds: [persisted.importacao.id], dateFrom: "2026-09-01", dateTo });
    const rowIds = conteudo.pedidos.map((p) => p.id);
    const { rows: itensDb } = await pool.query(`SELECT * FROM central_vendas_pedido_itens WHERE pedido_row_id = ANY($1::bigint[])`, [rowIds]);
    const { rows: compsDb } = await pool.query(`SELECT * FROM central_vendas_componentes WHERE pedido_row_id = ANY($1::bigint[])`, [rowIds]);
    const norm = (o) => JSON.parse(JSON.stringify(o));
    const comNulls = (orig, rec) => { const out = norm(orig); for (const k of Object.keys(rec)) if (!(k in out)) out[k] = null; return out; };
    let reconstrucaoOk = conteudo.pedidos.length === motor.pedidos.length
      && itensDb.length === motor.itens.length && compsDb.length === motor.componentes.length;
    if (modo !== "completo" && reconstrucaoOk) {
      const chaveI = (x) => x.itemId; const chaveC = (x) => `${x.pedidoId}|${x.itemId}|${x.tipo}`;
      const ri = ordenar(itensDb.map(pe.reconstruirItem), chaveI); const mi = ordenar(motor.itens, chaveI);
      const rc = ordenar(compsDb.map(pe.reconstruirComponente), chaveC); const mc = ordenar(motor.componentes, chaveC);
      try {
        ri.forEach((r, i) => assert.deepStrictEqual(r, comNulls(mi[i], r)));
        rc.forEach((r, i) => assert.deepStrictEqual(r, comNulls(mc[i], r)));
      } catch { reconstrucaoOk = false; }
    }

    noites.push({
      noite, pedidosNoSnapshot: motor.pedidos.length, persistencia: persisted.persistencia, msPersistir: ms,
      candidateIsolado, reconstrucaoOk, leitura: leitura.texto, financeiro: leitura.financeiro, importLidoOk: leitura.importLidoOk,
    });
    anterior = { dateTo, leitura };
  }

  // Planilha manual: payload completo e sem vínculo, em qualquer versão.
  const motorPlanilha = { pedidos: [{ pedidoId: "MAN1", confianca: "confiavel", dataPedido: "2026-08-02" }], itens: [], componentes: [], resumo: { manual: true } };
  const planilha = await repo.persistCentralVendasImport({
    cliente, marketplace: "meli", competencia: "2026-08", fonte: "planilha_vendas",
    motorPayload: motorPlanilha, resumo: motorPlanilha.resumo, clienteContaId: 5,
  });
  const { rows: [pl] } = await pool.query(`SELECT payload_json FROM central_vendas_imports WHERE id = $1`, [planilha.importacao.id]);

  await pool.query("VACUUM ANALYZE");
  const TABELAS = ["central_vendas_imports", "central_vendas_pedidos", "central_vendas_pedido_itens", "central_vendas_componentes", "central_vendas_import_pedidos"];
  const { rows: tamanhos } = await pool.query(
    `SELECT c.relname AS tabela, pg_total_relation_size(c.oid)::bigint AS total, pg_relation_size(c.oid)::bigint AS heap,
            pg_indexes_size(c.oid)::bigint AS indices, COALESCE(pg_total_relation_size(NULLIF(c.reltoastrelid, 0)), 0)::bigint AS toast
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[]) ORDER BY 1`, [TABELAS]
  );
  const { rows: [linhas] } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM central_vendas_imports)::int AS imports,
            (SELECT COUNT(*) FROM central_vendas_pedidos)::int AS pedidos,
            (SELECT COUNT(*) FROM central_vendas_pedido_itens)::int AS itens,
            (SELECT COUNT(*) FROM central_vendas_componentes)::int AS componentes,
            ${modo === "reuso" ? "(SELECT COUNT(*) FROM central_vendas_import_pedidos)::int" : "0"} AS vinculos`
  );

  // Segurança da FK (só reuso): apagar o import DONO de linhas usadas por
  // outro import falha; apagar dono + referenciadores juntos (purge) passa.
  let fk = null;
  if (modo === "reuso") {
    const cli = await pool.connect();
    try {
      await cli.query("BEGIN");
      const { rows: [{ id: primeiro }] } = await cli.query(`SELECT MIN(id) AS id FROM central_vendas_imports WHERE fonte = 'orders_api'`);
      let codigo = null;
      try { await cli.query("SAVEPOINT s"); await cli.query(`DELETE FROM central_vendas_imports WHERE id = $1`, [primeiro]); }
      catch (err) { codigo = err.code; await cli.query("ROLLBACK TO SAVEPOINT s"); }
      const purge = await cli.query(`DELETE FROM central_vendas_imports WHERE cliente_id = 1`);
      const { rows: [{ n }] } = await cli.query(`SELECT COUNT(*)::int AS n FROM central_vendas_pedidos`);
      fk = { apagarDonoUsado: codigo, purgeApagou: purge.rowCount, pedidosRestantes: n };
    } finally {
      await cli.query("ROLLBACK");
      cli.release();
    }
  }
  await pool.end();
  process.stdout.write(`@@RESULTADO@@${JSON.stringify({
    modo, noites, tamanhos, linhas, fk,
    planilhaPayloadCompleto: !!(pl.payload_json && pl.payload_json.resumo && pl.payload_json.resumo.manual === true && Array.isArray(pl.payload_json.pedidos)),
  })}\n`);
}

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
  const R = {};
  const nomes = [];
  try {
    for (const modo of MODOS) {
      const nome = `vf_cv_persist_${modo}_${sufixo}`;
      nomes.push(nome);
      await admin.query(`CREATE DATABASE "${nome}"`);
      const url = new URL(baseUrl); url.pathname = `/${nome}`; url.searchParams.set("sslmode", "disable");
      const r = spawnSync(process.execPath, [__filename, "--filho", modo, url.toString()], {
        env: { ...process.env }, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024,
      });
      const linha = (r.stdout || "").split("\n").find((l) => l.startsWith("@@RESULTADO@@"));
      if (r.status !== 0 || !linha) {
        console.error(r.stdout?.slice(-3000)); console.error(r.stderr?.slice(-3000));
        throw new Error(`filho ${modo} falhou (exit ${r.status})`);
      }
      R[modo] = JSON.parse(linha.slice("@@RESULTADO@@".length));
    }
  } finally {
    for (const nome of nomes) await admin.query(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }

  let checks = 0;
  const ok = (label, cond) => { assert.ok(cond, `FALHOU: ${label}`); checks += 1; };
  const { completo, enxuto, reuso } = R;
  ok("fechamento: getLatest exercitado", JSON.parse(completo.noites[NOITES].leitura).latest !== null);
  for (let i = 0; i < completo.noites.length; i++) {
    const a = completo.noites[i];
    for (const m of ["enxuto", "reuso"]) {
      const b = R[m].noites[i];
      ok(`noite ${a.noite} ${m}: todos os leitores idênticos à main`, a.leitura === b.leitura);
      ok(`noite ${a.noite} ${m}: resultado financeiro idêntico`, a.financeiro === b.financeiro);
      ok(`noite ${a.noite} ${m}: reconstrução sem perda`, b.reconstrucaoOk === true);
    }
    for (const m of MODOS) {
      ok(`noite ${a.noite} ${m}: candidate não vaza antes de publicar`, R[m].noites[i].candidateIsolado === true);
      ok(`noite ${a.noite} ${m}: leitores devolvem o import lido`, R[m].noites[i].importLidoOk === true);
    }
    const g = reuso.noites[i].persistencia;
    if (i > 0) {
      ok(`noite ${a.noite} reuso: só novos+alterados são gravados; inalterados viram vínculo`,
        g.gravados.pedidos === g.diff.novos + g.diff.alterados && g.gravados.vinculos === g.diff.inalterados);
    }
  }
  ok("planilha manual com payload completo (enxuto)", enxuto.planilhaPayloadCompleto === true);
  ok("planilha manual com payload completo (reuso)", reuso.planilhaPayloadCompleto === true);
  ok("FK: apagar import dono de linhas em uso FALHA (23503)", reuso.fk && reuso.fk.apagarDonoUsado === "23503");
  ok("FK: purge do cliente (dono + referenciadores) passa e não deixa órfão", reuso.fk.pedidosRestantes === 0);

  const total = (r) => r.tamanhos.reduce((s, t) => s + Number(t.total), 0);
  ok("reuso ocupa menos que enxuto", total(reuso) < total(enxuto));
  ok("enxuto ocupa menos que completo", total(enxuto) < total(completo));

  const relatorio = {
    parametros: { NOITES, PEDIDOS_POR_DIA, TAXA_MUDANCA },
    totalBytes: Object.fromEntries(MODOS.map((m) => [m, total(R[m])])),
    tamanhos: Object.fromEntries(MODOS.map((m) => [m, R[m].tamanhos])),
    linhas: Object.fromEntries(MODOS.map((m) => [m, R[m].linhas])),
    msPersistirTotal: Object.fromEntries(MODOS.map((m) => [m, R[m].noites.reduce((s, n) => s + n.msPersistir, 0)])),
    fk: reuso.fk,
    porNoite: completo.noites.map((a, i) => ({
      noite: a.noite, pedidosNoSnapshot: a.pedidosNoSnapshot,
      diff: reuso.noites[i].persistencia.diff,
      gravados: Object.fromEntries(MODOS.map((m) => [m, R[m].noites[i].persistencia.gravados])),
      bytesJson: Object.fromEntries(MODOS.map((m) => [m, R[m].noites[i].persistencia.bytesJsonEstimados])),
      ms: Object.fromEntries(MODOS.map((m) => [m, R[m].noites[i].msPersistir])),
    })),
  };
  if (process.env.SAIDA_RELATORIO) fs.writeFileSync(process.env.SAIDA_RELATORIO, JSON.stringify(relatorio, null, 2));
  const mb = (b) => (b / 1048576).toFixed(2);
  console.log(`  disco: completo=${mb(total(completo))} MB enxuto=${mb(total(enxuto))} MB reuso=${mb(total(reuso))} MB`);
  console.log(`  linhas: ${MODOS.map((m) => `${m}=${JSON.stringify(R[m].linhas)}`).join(" ")}`);
  console.log(`centralVendasPersistenciaEnxuta.postgres.test.js: ${checks} verificacoes OK`);
}

if (process.argv[2] === "--filho") {
  filho({ modo: process.argv[3], url: process.argv[4] }).catch((err) => { console.error(err); process.exit(1); });
} else {
  pai().catch((err) => { console.error(err); process.exit(1); });
}
