#!/usr/bin/env node
// server/scripts/poc-componentes-v2/bench.cjs
//
// PoC — persistência dos componentes da Central de Vendas. SÓ PostgreSQL LOCAL.
//
//   POC_DATABASE_URL=postgres://vf@127.0.0.1:57661/postgres \
//     [NOITES=20] [PEDIDOS_POR_DIA=150] [SAIDA=relatorio.json] \
//     node server/scripts/poc-componentes-v2/bench.cjs
//
// Para cada modo de persistência que JÁ existe na main (completo / enxuto /
// reuso = enxuto + reuso de pedidos), um banco descartável recebe as MESMAS N
// noites do sync gravadas pelo código real (buildMotorFromOrders +
// persistCentralVendasImport + promoverCandidatesDoRun). Depois, no mesmo
// banco, os três layouts alternativos (layouts.sql) são montados por backfill
// a partir de central_vendas_componentes e comparados: tamanho físico,
// equivalência linha a linha com a leitura atual, leitura do período, detalhe
// de 1 pedido, agregações e escrita. Nunca lê server/.env; recusa host remoto.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const MODOS = (process.env.MODOS || "completo,enxuto,reuso").split(",");
const NOITES = Number(process.env.NOITES || 20);
const PEDIDOS_POR_DIA = Number(process.env.PEDIDOS_POR_DIA || 150);
const REPETICOES = Number(process.env.REPETICOES || 15);
const SERVER = path.join(__dirname, "..", "..");

const COLS = `id, import_id, pedido_row_id, item_row_id, cliente_id, cliente_slug, marketplace,
       competencia, pedido_id, item_id, tipo, valor, fonte, confianca, obs, escopo, efeito,
       incluido_no_resultado, created_at, updated_at`;

const SQL_LEGADO = `SELECT ${COLS} FROM central_vendas_componentes
  WHERE pedido_row_id = ANY($1::bigint[]) ORDER BY pedido_id ASC, item_id ASC NULLS LAST, id ASC`;

const derivados = (tipo, item) => `cv_poc_escopo(${item}) AS escopo, cv_poc_efeito(${tipo}) AS efeito, cv_poc_incluido(${tipo}) AS incluido_no_resultado`;
const PROJ = (src) => `NULL::bigint AS id, p.import_id, ${src}.pedido_row_id, x.item_row_id, p.cliente_id, p.cliente_slug, p.marketplace,
       p.competencia, p.pedido_id, i.item_id, tt.texto AS tipo, x.valor, tf.texto AS fonte, tc.texto AS confianca, tob.texto AS obs,
       ${derivados("tt.texto", "i.item_id")}, p.created_at, p.updated_at`;
const JOINS = `JOIN cv_poc_textos tt ON tt.id = x.tipo_id
  JOIN cv_poc_textos tc ON tc.id = x.confianca_id
  LEFT JOIN cv_poc_textos tf ON tf.id = x.fonte_id
  LEFT JOIN cv_poc_textos tob ON tob.id = x.obs_id
  LEFT JOIN central_vendas_pedido_itens i ON i.id = x.item_row_id`;

// Fonte de linhas "explodidas" por layout: (pedido_row_id, ordem, item_row_id, tipo_id, valor, fonte_id, confianca_id, obs_id).
const EXPLODE = {
  jsonb: `SELECT k.pedido_row_id, e.ordem, (e.v->>5)::bigint AS item_row_id, (e.v->>0)::int AS tipo_id, (e.v->>1)::numeric(14,2) AS valor,
                 (e.v->>2)::int AS fonte_id, (e.v->>3)::int AS confianca_id, (e.v->>4)::int AS obs_id
            FROM cv_poc_comp_jsonb k CROSS JOIN LATERAL jsonb_array_elements(k.componentes) WITH ORDINALITY e(v, ordem)
           WHERE k.pedido_row_id = ANY($1::bigint[])`,
  slim: `SELECT s.pedido_row_id, s.ordem, s.item_row_id, s.tipo_id, s.valor, s.fonte_id, s.confianca_id, s.obs_id
           FROM cv_poc_comp_slim s WHERE s.pedido_row_id = ANY($1::bigint[])`,
  arrays: `SELECT a.pedido_row_id, u.ordem, u.item_row_id, a.codigos[4*u.ordem-3] AS tipo_id, u.valor,
                  NULLIF(a.codigos[4*u.ordem-2], 0) AS fonte_id, a.codigos[4*u.ordem-1] AS confianca_id, NULLIF(a.codigos[4*u.ordem], 0) AS obs_id
             FROM cv_poc_comp_arrays a CROSS JOIN LATERAL unnest(a.valores, a.item_row_ids) WITH ORDINALITY u(valor, item_row_id, ordem)
            WHERE a.pedido_row_id = ANY($1::bigint[])`,
};
const SQL_COMPAT = Object.fromEntries(Object.entries(EXPLODE).map(([k, ex]) => [k,
  `SELECT ${PROJ("x")} FROM (${ex}) x JOIN central_vendas_pedidos p ON p.id = x.pedido_row_id ${JOINS}
    ORDER BY p.pedido_id ASC, i.item_id ASC NULLS LAST, x.pedido_row_id ASC, x.ordem ASC`]));

const AGG_LEGADO = `SELECT tipo, SUM(valor)::text AS soma, COUNT(*)::int AS n, COUNT(valor)::int AS n_valor
  FROM central_vendas_componentes WHERE pedido_row_id = ANY($1::bigint[]) GROUP BY tipo ORDER BY tipo`;
const AGG = Object.fromEntries(Object.entries(EXPLODE).map(([k, ex]) => [k,
  `SELECT tt.texto AS tipo, SUM(x.valor)::text AS soma, COUNT(*)::int AS n, COUNT(x.valor)::int AS n_valor
     FROM (${ex}) x JOIN cv_poc_textos tt ON tt.id = x.tipo_id GROUP BY tt.texto ORDER BY tt.texto`]));
// Padrão do Resgate (resgateLeituraRepository): frete_seller da shipments_api por item.
const RESGATE_LEGADO = `SELECT i.id, (SELECT c.valor FROM central_vendas_componentes c WHERE c.item_row_id = i.id AND c.tipo = 'frete_seller' AND c.fonte = 'shipments_api' LIMIT 1)::text AS frete
  FROM central_vendas_pedido_itens i WHERE i.pedido_row_id = ANY($1::bigint[]) ORDER BY i.id`;
const RESGATE = Object.fromEntries(Object.entries(EXPLODE).map(([k, ex]) => [k,
  `SELECT i.id, f.frete::text AS frete FROM central_vendas_pedido_itens i
     LEFT JOIN LATERAL (SELECT x.valor AS frete FROM (${ex.replace("ANY($1::bigint[])", "ANY(ARRAY[i.pedido_row_id])")}) x
                         JOIN cv_poc_textos tt ON tt.id = x.tipo_id AND tt.texto = 'frete_seller'
                         JOIN cv_poc_textos tf ON tf.id = x.fonte_id AND tf.texto = 'shipments_api'
                        WHERE x.item_row_id = i.id ORDER BY x.ordem LIMIT 1) f ON TRUE
    WHERE i.pedido_row_id = ANY($1::bigint[]) ORDER BY i.id`]));

function mediana(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }
async function cronometrar(fn, n = REPETICOES) {
  await fn(); // aquecimento
  const ts = [];
  for (let i = 0; i < n; i++) { const t0 = process.hrtime.bigint(); await fn(); ts.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  return { medianaMs: Number(mediana(ts).toFixed(2)), minMs: Number(Math.min(...ts).toFixed(2)) };
}

// ---------------------------------------------------------------------------
async function filho({ url, modo }) {
  process.env.DATABASE_URL = url;
  delete process.env.CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA;
  delete process.env.CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS;
  delete process.env.CENTRAL_VENDAS_SYNC_REUSO_CONTAS;
  if (modo !== "completo") process.env.CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA = "true";
  if (modo === "reuso") { process.env.CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS = "true"; process.env.CENTRAL_VENDAS_SYNC_REUSO_CONTAS = "5"; }

  const pool = require(path.join(SERVER, "config", "database"));
  const repo = require(path.join(SERVER, "services/centralVendas/centralVendasRepository"));
  const { buildMotorFromOrders, buildCostMap, coverageParaCompetencia } = require(path.join(SERVER, "services/centralVendas/centralVendasSyncService"));
  const { buildResumoCentralVendas } = require(path.join(SERVER, "services/centralVendas/centralVendasImportService"));
  const { classificarComponenteFinanceiro } = require(path.join(SERVER, "services/centralVendas/centralVendasComponenteLedger"));
  const cen = require("./cenario");

  const helper = fs.readFileSync(path.join(SERVER, "tests", "helpers", "centralVendasRetencaoPostgres.js"), "utf8");
  await pool.query(helper.split("const FIXTURES = `")[1].split("`;")[0]);
  await pool.query(fs.readFileSync(path.join(SERVER, "sql", "central_vendas_schema.sql"), "utf8"));
  if (modo === "reuso") await pool.query(fs.readFileSync(path.join(SERVER, "sql", "migrations", "20261111_central_vendas_import_pedidos.sql"), "utf8"));

  const cliente = { id: 1, slug: "loja", nome: "Loja" };
  const costMap = buildCostMap(cen.costMapEntradas());
  const params = { pedidosPorDia: PEDIDOS_POR_DIA };
  const tamanhoLegado = async () => (await pool.query(
    `SELECT pg_total_relation_size('central_vendas_componentes')::bigint AS comp,
            (pg_total_relation_size('central_vendas_pedidos') + pg_total_relation_size('central_vendas_pedido_itens')
             + pg_total_relation_size('central_vendas_imports')
             + COALESCE(pg_total_relation_size(to_regclass('central_vendas_import_pedidos')), 0))::bigint AS resto`)).rows[0];

  const noites = [];
  let motorFinal = null;
  for (let noite = 1; noite <= NOITES + 1; noite++) {
    const fechamento = noite === NOITES + 1;
    const k = fechamento ? NOITES : noite;
    const orders = cen.ordersDaNoite(k, params);
    const motor = buildMotorFromOrders({
      orders, costMap, freteMap: cen.freteDaNoite(orders, k), packsIncompletos: cen.packsIncompletosDaNoite(orders),
      clienteSlug: cliente.slug, competencia: "2026-09",
    });
    const dateTo = fechamento ? "2026-09-30" : `2026-09-${String(noite).padStart(2, "0")}`;
    const { rows: [run] } = await pool.query(
      `INSERT INTO central_vendas_sync_runs (cliente_id, cliente_slug, cliente_conta_id, marketplace, date_from, date_to, status)
       VALUES (1, 'loja', 5, 'meli', '2026-09-01', $1, 'completed') RETURNING id`, [dateTo]);
    const resumo = { ...buildResumoCentralVendas(motor), syncRunId: Number(run.id) };
    const { coverageFrom, coverageTo } = coverageParaCompetencia("2026-09", "2026-09-01", dateTo);
    const t0 = Date.now();
    const persisted = await repo.persistCentralVendasImport({
      cliente, marketplace: "meli", competencia: "2026-09", fonte: "orders_api",
      motorPayload: { ...motor, resumo }, resumo, clienteContaId: 5,
      syncRunId: Number(run.id), publicationStatus: "candidate", coverageDateFrom: coverageFrom, coverageDateTo: coverageTo,
    });
    const ms = Date.now() - t0;
    await repo.promoverCandidatesDoRun(Number(run.id));
    const tam = await tamanhoLegado();
    noites.push({ noite, pedidos: motor.pedidos.length, componentes: motor.componentes.length, msPersistir: ms,
      gravados: persisted.persistencia.gravados || null, importId: Number(persisted.importacao.id), tamanhoLegado: tam });
    if (fechamento) motorFinal = { motor, importId: Number(persisted.importacao.id) };
  }

  // Classificação M6 persistida = função pura de (tipo, item_id)? (prova de que pode ser derivada)
  const { rows: classe } = await pool.query(`SELECT DISTINCT tipo, item_id IS NOT NULL AND item_id <> '' AS tem_item, escopo, efeito, incluido_no_resultado FROM central_vendas_componentes`);
  const classificacaoDerivavel = classe.every((r) => {
    const c = classificarComponenteFinanceiro({ tipo: r.tipo, itemId: r.tem_item ? "x" : null });
    return c.escopo === r.escopo && c.efeito === r.efeito && c.incluidoNoResultado === r.incluido_no_resultado;
  });
  // Campos de identificação = os da linha do pedido?
  const { rows: [redund] } = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE c.import_id IS DISTINCT FROM p.import_id OR c.cliente_id IS DISTINCT FROM p.cliente_id
              OR c.cliente_slug IS DISTINCT FROM p.cliente_slug OR c.marketplace IS DISTINCT FROM p.marketplace
              OR c.competencia IS DISTINCT FROM p.competencia OR c.pedido_id IS DISTINCT FROM p.pedido_id
              OR c.created_at IS DISTINCT FROM p.created_at OR c.updated_at IS DISTINCT FROM p.updated_at)::int AS divergem_pedido,
            COUNT(*) FILTER (WHERE c.item_id IS DISTINCT FROM i.item_id)::int AS divergem_item,
            COUNT(*) FILTER (WHERE c.pedido_row_id IS NULL)::int AS sem_pedido,
            COUNT(*) FILTER (WHERE c.item_id IS NOT NULL AND c.item_row_id IS NULL)::int AS item_sem_linha
       FROM central_vendas_componentes c
       LEFT JOIN central_vendas_pedidos p ON p.id = c.pedido_row_id
       LEFT JOIN central_vendas_pedido_itens i ON i.id = c.item_row_id`);

  // --- Layouts alternativos (backfill a partir da tabela atual) -------------
  const tBack0 = Date.now();
  await pool.query(fs.readFileSync(path.join(__dirname, "layouts.sql"), "utf8"));
  const msBackfill = Date.now() - tBack0;
  await pool.query("VACUUM ANALYZE");

  const TAB = ["central_vendas_componentes", "cv_poc_comp_jsonb", "cv_poc_comp_slim", "cv_poc_comp_arrays", "cv_poc_textos",
    "central_vendas_pedidos", "central_vendas_pedido_itens", "central_vendas_imports", "central_vendas_import_pedidos"];
  const { rows: tamanhos } = await pool.query(
    `SELECT c.relname AS tabela, pg_total_relation_size(c.oid)::bigint AS total, pg_relation_size(c.oid)::bigint AS heap,
            pg_indexes_size(c.oid)::bigint AS indices, COALESCE(pg_total_relation_size(NULLIF(c.reltoastrelid, 0)), 0)::bigint AS toast,
            (SELECT COUNT(*) FROM pg_index x WHERE x.indrelid = c.oid)::int AS n_indices
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[]) ORDER BY 1`, [TAB]);
  const { rows: [linhas] } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM central_vendas_componentes)::int AS componentes_legado,
            (SELECT COUNT(*) FROM cv_poc_comp_slim)::int AS slim, (SELECT COUNT(*) FROM cv_poc_comp_jsonb)::int AS jsonb,
            (SELECT COUNT(*) FROM cv_poc_comp_arrays)::int AS arrays, (SELECT COUNT(*) FROM cv_poc_textos)::int AS textos,
            (SELECT COUNT(*) FROM central_vendas_pedidos)::int AS pedidos, (SELECT COUNT(*) FROM central_vendas_pedido_itens)::int AS itens`);
  // Bytes médios de cada linha (sem índice, sem página): onde estão os bytes.
  const { rows: [porLinha] } = await pool.query(
    `SELECT AVG(pg_column_size(c.*))::numeric(10,1) AS linha, AVG(pg_column_size(c.payload_json))::numeric(10,1) AS payload,
            AVG(COALESCE(pg_column_size(c.obs), 0))::numeric(10,1) AS obs,
            AVG(pg_column_size(c.cliente_slug) + pg_column_size(c.marketplace) + pg_column_size(c.competencia) + pg_column_size(c.pedido_id)
                + COALESCE(pg_column_size(c.item_id), 0) + pg_column_size(c.import_id) + COALESCE(pg_column_size(c.cliente_id), 0)
                + pg_column_size(c.created_at) + pg_column_size(c.updated_at))::numeric(10,1) AS identificacao_derivavel,
            AVG(COALESCE(pg_column_size(c.escopo), 0) + COALESCE(pg_column_size(c.efeito), 0) + 1)::numeric(10,1) AS classificacao_derivavel,
            AVG(pg_column_size(c.tipo) + COALESCE(pg_column_size(c.fonte), 0) + pg_column_size(c.confianca))::numeric(10,1) AS textos_curtos
       FROM central_vendas_componentes c`);

  // --- Conjunto lido: o período vigente inteiro (como a tela) ----------------
  const range = { clienteSlug: "loja", dateFrom: "2026-09-01", dateTo: "2026-09-30", clienteContaId: 5 };
  const { importIds } = await repo.resolveImportsForRange(range);
  const carga = await repo.loadPedidosByImportIds({ importIds, dateFrom: range.dateFrom, dateTo: range.dateTo });
  const ids = carga.pedidos.map((p) => p.id);
  const itensPorId = new Map(carga.itens.map((i) => [String(i.id), i]));
  const pedidosPorId = new Map(carga.pedidos.map((p) => [String(p.id), p]));
  // TODOS os pedidos do banco (todos os snapshots) para a equivalência total.
  const { rows: todos } = await pool.query(`SELECT id FROM central_vendas_pedidos ORDER BY id`);
  const idsTodos = todos.map((r) => r.id);

  const semId = (rows) => rows.map((r) => { const o = { ...r }; delete o.id; return o; });
  const legadoTodos = semId((await pool.query(SQL_LEGADO, [idsTodos])).rows);
  const equivalencia = {};
  for (const k of Object.keys(SQL_COMPAT)) {
    const comp = semId((await pool.query(SQL_COMPAT[k], [idsTodos])).rows);
    equivalencia[k] = { linhas: comp.length, identico: JSON.stringify(comp) === JSON.stringify(legadoTodos) };
  }
  // Leitura "crua" do JSONB + decodificação em JS (caminho de produção pretendido).
  const { rows: dic } = await pool.query(`SELECT id, texto FROM cv_poc_textos`);
  const texto = new Map(dic.map((d) => [d.id, d.texto]));
  const pedidosTodos = new Map((await pool.query(`SELECT * FROM central_vendas_pedidos`)).rows.map((p) => [String(p.id), p]));
  const itensTodos = new Map((await pool.query(`SELECT id, item_id FROM central_vendas_pedido_itens`)).rows.map((i) => [String(i.id), i]));
  function decodificar(rows, pedidos, itens) {
    const out = [];
    for (const r of rows) {
      const p = pedidos.get(String(r.pedido_row_id));
      r.componentes.forEach((e, n) => {
        const item = e[5] == null ? null : itens.get(String(e[5]));
        const tipo = texto.get(e[0]);
        const cls = classificarComponenteFinanceiro({ tipo, itemId: item ? item.item_id : null });
        out.push({ _o: n, id: null, import_id: p.import_id, pedido_row_id: r.pedido_row_id, item_row_id: e[5] == null ? null : String(e[5]),
          cliente_id: p.cliente_id, cliente_slug: p.cliente_slug, marketplace: p.marketplace, competencia: p.competencia, pedido_id: p.pedido_id,
          item_id: item ? item.item_id : null, tipo, valor: e[1] == null ? null : Number(e[1]).toFixed(2), fonte: e[2] == null ? null : texto.get(e[2]),
          confianca: texto.get(e[3]), obs: e[4] == null ? null : texto.get(e[4]), escopo: cls.escopo, efeito: cls.efeito,
          incluido_no_resultado: cls.incluidoNoResultado, created_at: p.created_at, updated_at: p.updated_at });
      });
    }
    // Mesma ordem do SQL atual: pedido_id, item_id NULLS LAST, (linha, ordem) ≡ id antigo.
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    out.sort((a, b) => cmp(a.pedido_id, b.pedido_id)
      || (a.item_id === null) - (b.item_id === null) || (a.item_id !== null && b.item_id !== null ? cmp(a.item_id, b.item_id) : 0)
      || Number(a.pedido_row_id) - Number(b.pedido_row_id) || a._o - b._o);
    for (const o of out) delete o._o;
    return out;
  }
  const SQL_JSONB_CRU = `SELECT pedido_row_id, componentes FROM cv_poc_comp_jsonb WHERE pedido_row_id = ANY($1::bigint[])`;
  {
    const cru = decodificar((await pool.query(SQL_JSONB_CRU, [idsTodos])).rows, pedidosTodos, itensTodos);
    // node-pg devolve created_at como Date nos dois lados; ordem de texto do JS = collation "C".
    equivalencia.jsonb_js = { linhas: cru.length, identico: JSON.stringify(semId(cru)) === JSON.stringify(legadoTodos),
      observacao: "ordenação em JS; idêntica quando a collation do banco ordena pedido_id/item_id como bytes (ids numéricos)" };
  }
  const aggLeg = (await pool.query(AGG_LEGADO, [idsTodos])).rows;
  const resgLeg = (await pool.query(RESGATE_LEGADO, [ids])).rows;
  for (const k of Object.keys(AGG)) {
    equivalencia[k].agregacaoIdentica = JSON.stringify((await pool.query(AGG[k], [idsTodos])).rows) === JSON.stringify(aggLeg);
    equivalencia[k].resgateIdentico = JSON.stringify((await pool.query(RESGATE[k], [ids])).rows) === JSON.stringify(resgLeg);
  }

  // --- Leitura ---------------------------------------------------------------
  const umPedido = [ids[Math.floor(ids.length / 2)]];
  const leitura = {
    periodo: { pedidos: ids.length, componentes: (await pool.query(SQL_LEGADO, [ids])).rowCount },
    legado: { periodo: await cronometrar(() => pool.query(SQL_LEGADO, [ids])), detalhe: await cronometrar(() => pool.query(SQL_LEGADO, [umPedido]), 200),
      agregacao: await cronometrar(() => pool.query(AGG_LEGADO, [ids])), resgate: await cronometrar(() => pool.query(RESGATE_LEGADO, [ids])) },
  };
  for (const k of Object.keys(SQL_COMPAT)) {
    leitura[k] = { periodo: await cronometrar(() => pool.query(SQL_COMPAT[k], [ids])), detalhe: await cronometrar(() => pool.query(SQL_COMPAT[k], [umPedido]), 200),
      agregacao: await cronometrar(() => pool.query(AGG[k], [ids])), resgate: await cronometrar(() => pool.query(RESGATE[k], [ids])) };
  }
  leitura.jsonb_js = {
    periodo: await cronometrar(async () => decodificar((await pool.query(SQL_JSONB_CRU, [ids])).rows, pedidosPorId, itensPorId)),
    detalhe: await cronometrar(async () => decodificar((await pool.query(SQL_JSONB_CRU, [umPedido])).rows, pedidosPorId, itensPorId), 200),
  };

  // --- Escrita: os componentes do snapshot final, em transação revertida -----
  let escrita = null;
  if (modo === "completo") {
    const { motor, importId } = motorFinal;
    const { rows: pedRows } = await pool.query(`SELECT id, pedido_id FROM central_vendas_pedidos WHERE import_id = $1`, [importId]);
    const { rows: itRows } = await pool.query(`SELECT id, item_id FROM central_vendas_pedido_itens WHERE import_id = $1`, [importId]);
    const pedMap = new Map(pedRows.map((r) => [r.pedido_id, Number(r.id)]));
    const itMap = new Map(itRows.map((r) => [r.item_id, Number(r.id)]));
    const comps = motor.componentes;
    const ordem = new Map();
    const linhasW = comps.map((c) => {
      const pr = pedMap.get(c.pedidoId); const o = (ordem.get(pr) || 0) + 1; ordem.set(pr, o);
      return { pr, ir: c.itemId ? itMap.get(c.itemId) ?? null : null, o, ...c };
    });
    const cli = await pool.connect();
    const emTransacao = async (fn) => { await cli.query("BEGIN"); try { await fn(); } finally { await cli.query("ROLLBACK"); } };
    const dicionario = async () => {
      const textos = [...new Set(comps.flatMap((c) => [c.tipo, c.fonte, c.confianca, c.obs]).filter((t) => t))];
      await cli.query(`INSERT INTO cv_poc_textos (texto) SELECT unnest($1::text[]) ON CONFLICT (texto) DO NOTHING`, [textos]);
      return new Map((await cli.query(`SELECT id, texto FROM cv_poc_textos WHERE texto = ANY($1::text[])`, [textos])).rows.map((r) => [r.texto, r.id]));
    };
    const arr = (f) => linhasW.map(f);
    escrita = {
      componentes: comps.length, pedidos: pedMap.size,
      legado_linha_a_linha: await cronometrar(() => emTransacao(async () => {
        for (const c of linhasW) {
          const cls = classificarComponenteFinanceiro({ tipo: c.tipo, itemId: c.itemId || null });
          // eslint-disable-next-line no-await-in-loop
          await cli.query(`INSERT INTO central_vendas_componentes (import_id, pedido_row_id, item_row_id, cliente_id, cliente_slug, marketplace, competencia,
             pedido_id, item_id, tipo, valor, fonte, confianca, obs, payload_json, escopo, efeito, incluido_no_resultado)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18) RETURNING id`,
          [importId, c.pr, c.ir, 1, "loja", "meli", "2026-09", c.pedidoId, c.itemId || null, c.tipo, c.valor, c.fonte || null, c.confianca, c.obs || null,
            JSON.stringify({ pedidoId: c.pedidoId, itemId: c.itemId, tipo: c.tipo, valor: c.valor, fonte: c.fonte, confianca: c.confianca, obs: c.obs }),
            cls.escopo, cls.efeito, cls.incluidoNoResultado]);
        }
      }), 3),
      legado_em_lote: await cronometrar(() => emTransacao(() => cli.query(
        `INSERT INTO central_vendas_componentes (import_id, pedido_row_id, item_row_id, cliente_id, cliente_slug, marketplace, competencia,
           pedido_id, item_id, tipo, valor, fonte, confianca, obs, payload_json)
         SELECT $1, u.pr, u.ir, 1, 'loja', 'meli', '2026-09', u.pid, u.iid, u.tipo, u.valor, u.fonte, u.conf, u.obs, '{}'::jsonb
           FROM unnest($2::bigint[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::text[], $9::text[], $10::text[])
                AS u(pr, ir, pid, iid, tipo, valor, fonte, conf, obs)`,
        [importId, arr((c) => c.pr), arr((c) => c.ir), arr((c) => c.pedidoId), arr((c) => c.itemId || null), arr((c) => c.tipo), arr((c) => c.valor),
          arr((c) => c.fonte || null), arr((c) => c.confianca), arr((c) => c.obs || null)])), 5),
      jsonb_em_lote: await cronometrar(() => emTransacao(async () => {
        const d = await dicionario();
        const porPedido = new Map();
        for (const c of linhasW) {
          if (!porPedido.has(c.pr)) porPedido.set(c.pr, []);
          porPedido.get(c.pr).push([d.get(c.tipo), c.valor, c.fonte ? d.get(c.fonte) : null, d.get(c.confianca), c.obs ? d.get(c.obs) : null, c.ir]);
        }
        await cli.query(`DELETE FROM cv_poc_comp_jsonb WHERE pedido_row_id = ANY($1::bigint[])`, [[...porPedido.keys()]]);
        await cli.query(`INSERT INTO cv_poc_comp_jsonb (pedido_row_id, componentes) SELECT * FROM unnest($1::bigint[], $2::jsonb[])`,
          [[...porPedido.keys()], [...porPedido.values()].map((v) => JSON.stringify(v))]);
      }), 5),
      slim_em_lote: await cronometrar(() => emTransacao(async () => {
        const d = await dicionario();
        await cli.query(`DELETE FROM cv_poc_comp_slim WHERE pedido_row_id = ANY($1::bigint[])`, [[...new Set(arr((c) => c.pr))]]);
        await cli.query(`INSERT INTO cv_poc_comp_slim (pedido_row_id, item_row_id, tipo_id, fonte_id, confianca_id, obs_id, ordem, valor)
           SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::int[], $4::int[], $5::int[], $6::int[], $7::smallint[], $8::numeric(14,2)[])`,
        [arr((c) => c.pr), arr((c) => c.ir), arr((c) => d.get(c.tipo)), arr((c) => (c.fonte ? d.get(c.fonte) : null)), arr((c) => d.get(c.confianca)),
          arr((c) => (c.obs ? d.get(c.obs) : null)), arr((c) => c.o), arr((c) => c.valor)]);
      }), 5),
      // Código REAL da escrita compacta (centralVendasComponentesCompactos), migration 20261126 aplicada.
      arrays_codigo_real: await (async () => {
        const cc = require(path.join(SERVER, "services/centralVendas/centralVendasComponentesCompactos"));
        const pe = require(path.join(SERVER, "services/centralVendas/centralVendasPersistenciaEnxuta"));
        await pool.query(fs.readFileSync(path.join(SERVER, "sql/migrations/20261126_central_vendas_pedido_componentes.sql"), "utf8"));
        return cronometrar(() => emTransacao(async () => {
          const av = cc.avaliarImport(motor);
          if (!av.elegivel) throw new Error(av.motivo);
          const textos = await cc.garantirTextos(av.textos, cli);
          await cli.query(`DELETE FROM central_vendas_pedido_componentes WHERE pedido_row_id = ANY($1::bigint[])`, [[...pedMap.values()]]);
          const linhas = cc.montarLinhas({ componentes: comps, pedidoRowsById: pedMap, itemRowsById: itMap, textos, extrasDoComponente: pe.extrasDoComponente });
          await cc.gravarCompactos(linhas, cli);
        }), 5);
      })(),
    };
    cli.release();
  }

  await pool.end();
  process.stdout.write(`@@RESULTADO@@${JSON.stringify({ modo, noites, tamanhos, linhas, porLinha, redund, classificacaoDerivavel, msBackfill, equivalencia, leitura, escrita })}\n`);
}

// ---------------------------------------------------------------------------
async function pai() {
  const baseUrl = process.env.POC_DATABASE_URL;
  if (!baseUrl) { console.log("bench.cjs: defina POC_DATABASE_URL (PostgreSQL LOCAL)"); process.exit(2); }
  const host = new URL(baseUrl).hostname;
  console.log(`  banco: host=${host}`);
  if (!LOCAL.has(host)) throw new Error("LOCAL_DATABASE_REQUIRED");
  const { Client } = require(path.join(SERVER, "node_modules", "pg"));
  const admin = new Client({ connectionString: baseUrl, ssl: false });
  await admin.connect();
  const sufixo = `${Date.now()}`;
  const R = {};
  try {
    for (const modo of MODOS) {
      const nome = `vf_poc_comp_${modo}_${sufixo}`;
      await admin.query(`CREATE DATABASE "${nome}"`);
      const url = new URL(baseUrl); url.pathname = `/${nome}`; url.searchParams.set("sslmode", "disable");
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [__filename, "--filho", modo, url.toString()], { env: { ...process.env }, encoding: "utf8", maxBuffer: 1 << 30 });
      const linha = (r.stdout || "").split("\n").find((l) => l.startsWith("@@RESULTADO@@"));
      if (r.status !== 0 || !linha) { console.error(r.stdout?.slice(-3000)); console.error(r.stderr?.slice(-5000)); throw new Error(`filho ${modo} falhou`); }
      R[modo] = JSON.parse(linha.slice("@@RESULTADO@@".length));
      console.log(`  ${modo}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      await admin.query(`DROP DATABASE IF EXISTS "${nome}" WITH (FORCE)`);
    }
  } finally { await admin.end(); }

  for (const m of MODOS) {
    for (const [k, e] of Object.entries(R[m].equivalencia)) {
      assert.ok(e.identico, `${m}/${k}: leitura compatível DIFERE da atual`);
      if ("agregacaoIdentica" in e) { assert.ok(e.agregacaoIdentica, `${m}/${k}: agregação difere`); assert.ok(e.resgateIdentico, `${m}/${k}: padrão Resgate difere`); }
    }
    assert.ok(R[m].classificacaoDerivavel, `${m}: escopo/efeito/incluido não é função de (tipo, item)`);
    assert.strictEqual(R[m].redund.divergem_pedido, 0, `${m}: identificação do componente diverge do pedido`);
    assert.strictEqual(R[m].redund.divergem_item, 0, `${m}: item_id diverge do item`);
  }
  const saida = { parametros: { NOITES, PEDIDOS_POR_DIA, REPETICOES, pg: "local" }, ...R };
  if (process.env.SAIDA) fs.writeFileSync(process.env.SAIDA, JSON.stringify(saida, null, 2));
  const mb = (b) => (Number(b) / 1048576).toFixed(2);
  for (const m of MODOS) {
    const t = Object.fromEntries(R[m].tamanhos.map((x) => [x.tabela, x]));
    console.log(`  [${m}] componentes atual=${mb(t.central_vendas_componentes.total)} MB | jsonb=${mb(t.cv_poc_comp_jsonb.total)} | slim=${mb(t.cv_poc_comp_slim.total)} | arrays=${mb(t.cv_poc_comp_arrays.total)} | dicionário=${mb(t.cv_poc_textos.total)} MB; linhas ${JSON.stringify(R[m].linhas)}`);
  }
  console.log("bench.cjs: equivalência OK em todos os modos e layouts");
}

if (process.argv[2] === "--filho") filho({ modo: process.argv[3], url: process.argv[4] }).catch((e) => { console.error(e); process.exit(1); });
else pai().catch((e) => { console.error(e); process.exit(1); });
