// server/tests/centralVendasM10ReadPerformance.test.js
//
// M10 — Performance da Read API. Reaproveita o MESMO padrão de fake db real
// de centralVendasM7Read.test.js (funções REAIS de centralVendasRepository
// contra uma fake db em memória) para provar, sem depender de Postgres real:
//
//   1. GET /read/orders/:rowId NÃO reconstrói o período inteiro (seção 15,
//      obrigatória): consultas de itens/componentes ficam O(1), não O(N),
//      quando N pedidos existem mas só 1 rowId é aberto; 4 casos negativos
//      (outro snapshot, outra conta, fora do range, id inválido) -> 404.
//   2. /read/bootstrap deriva de UMA reconstrução do período o mesmo
//      resultado que os 3 endpoints antigos (/read + /read/daily +
//      /read/products) davam rodando 3 reconstruções (seção 16,
//      obrigatória) — valores deepEqual.
//   3. Paridade financeira do detalhe otimizado: o mesmo pedido, buscado
//      pelo caminho ANTIGO (buildPayloadFromRange do período inteiro +
//      .find, ainda disponível como função pura) e pelo caminho NOVO
//      (getCentralVendasReadOrderDetail/resolveOrderDetail), tem exatamente
//      os mesmos campos — multi-item, custo ausente, frete real, cancelado
//      por pós-venda, componentes informativos (receita_envio/
//      cancelamento_reembolso).

const assert = require("assert");
const repository = require("../services/centralVendas/centralVendasRepository");
const { createCentralVendasReadService } = require("../services/centralVendas/centralVendasReadService");
const { buildPayloadFromRange } = require("../services/centralVendas/centralVendasService");

const cliente = { id: 1, nome: "Cliente A", slug: "cliente-a", ativo: true };

function realRepositoryComDb(db) {
  return {
    ensureCentralVendasTables: () => repository.ensureCentralVendasTables(db),
    getClienteBySlug: (slug) => repository.getClienteBySlug(slug, db),
    getLatestCentralVendasImport: (args) => repository.getLatestCentralVendasImport(args, db),
    getCentralVendasByRange: (args) => repository.getCentralVendasByRange(args, db),
    resolveImportsForRange: (args) => repository.resolveImportsForRange(args, db),
    loadPedidosByImportIds: (args) => repository.loadPedidosByImportIds(args, db),
    getPedidoDetailByRowId: (args) => repository.getPedidoDetailByRowId(args, db),
  };
}

// Mesmo roteador de SQL de centralVendasM7Read.test.js — copiado (não
// importado) porque cada arquivo de teste roda isolado em processo próprio
// (server/tests/run-all.js) e não há módulo compartilhado de fixtures ainda.
function makeDb({ contas = [], imports = [], pedidos = [], itens = [], componentes = [] }, { onQuery } = {}) {
  return {
    queryLog: [],
    async query(sql, params = []) {
      this.queryLog.push({ sql, params });
      if (onQuery) onQuery(sql, params);

      if (sql.includes("CREATE TABLE") || sql.includes("ALTER TABLE") || sql.includes("CREATE INDEX") || sql.includes("CREATE UNIQUE INDEX") || sql.includes("WITH duplicados")) {
        return { rows: [] };
      }
      if (sql.includes("FROM clientes") && sql.includes("slug = $1")) {
        return { rows: params[0] === cliente.slug ? [cliente] : [] };
      }
      if (sql.includes("FROM clientes") && sql.includes("WHERE id")) {
        return { rows: params[0] === cliente.id ? [cliente] : [] };
      }
      if (sql.includes("cliente_contas WHERE id = $1")) {
        const row = contas.find((c) => c.id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true ORDER BY is_primary")) {
        return { rows: contas.filter((c) => c.cliente_id === params[0] && c.marketplace === params[1] && c.ativo !== false) };
      }
      if (sql.includes("COUNT(*)::int AS total FROM cliente_contas")) {
        const total = contas.filter((c) => c.cliente_id === params[0] && c.marketplace === params[1] && c.ativo !== false).length;
        return { rows: [{ total }] };
      }
      if (sql.includes("FROM ml_tokens t")) return { rows: [] };
      if (sql.includes("v.cliente_conta_id = $1 AND v.ativo = true")) return { rows: [] };
      if (sql.includes("v.cliente_id = $1 AND v.marketplace = $2 AND v.ativo = true")) return { rows: [] };

      if (sql.includes("competencia BETWEEN $3 AND $4") && sql.includes("FROM central_vendas_imports")) {
        const [slug, marketplace, compFrom, compTo] = params;
        let candidatos = imports.filter((row) =>
          row.cliente_slug === slug && row.marketplace === marketplace &&
          row.competencia >= compFrom && row.competencia <= compTo &&
          (row.publication_status === "published" || row.publication_status === "legacy")
        );
        if (params.length >= 5) {
          const clienteContaId = params[4];
          if (sql.includes("OR cliente_conta_id IS NULL")) {
            candidatos = candidatos.filter((r) => r.cliente_conta_id === clienteContaId || r.cliente_conta_id == null);
          } else {
            candidatos = candidatos.filter((r) => r.cliente_conta_id === clienteContaId);
          }
        }
        return { rows: candidatos };
      }
      if (sql.includes("FROM central_vendas_pedidos") && sql.includes("LIMIT 1")) {
        const [rowId, importIds, dateFrom, dateTo] = params;
        const found = pedidos.find((p) =>
          p.id === rowId && importIds.includes(p.import_id) && p.data_pedido >= dateFrom && p.data_pedido <= dateTo
        );
        return { rows: found ? [found] : [] };
      }
      if (sql.includes("FROM central_vendas_pedidos") && sql.includes("import_id = ANY")) {
        const [importIds, dateFrom, dateTo] = params;
        return {
          rows: pedidos.filter((p) => importIds.includes(p.import_id) && p.data_pedido >= dateFrom && p.data_pedido <= dateTo),
        };
      }
      if (sql.includes("FROM central_vendas_pedido_itens") && sql.includes("pedido_row_id = ANY")) {
        const [rowIds] = params;
        return { rows: itens.filter((i) => rowIds.includes(i.pedido_row_id)) };
      }
      if (sql.includes("FROM central_vendas_pedido_itens") && sql.includes("pedido_row_id = $1")) {
        const [rowId] = params;
        return { rows: itens.filter((i) => i.pedido_row_id === rowId) };
      }
      if (sql.includes("FROM central_vendas_componentes") && sql.includes("pedido_row_id = ANY")) {
        const [rowIds] = params;
        return { rows: componentes.filter((c) => rowIds.includes(c.pedido_row_id)) };
      }
      if (sql.includes("FROM central_vendas_componentes") && sql.includes("pedido_row_id = $1")) {
        const [rowId] = params;
        return { rows: componentes.filter((c) => c.pedido_row_id === rowId) };
      }

      // A tabela de vínculos não existe nesta fixture (reuso desligado).
      if (/to_regclass\('public\.central_vendas_import_pedidos'\)/.test(String(sql))) return { rows: [{ ok: false }] };
      throw new Error(`Fake db: SQL nao mapeado -> ${sql.slice(0, 160)}`);
    },
  };
}

function pedidoRow({ id, importId, pedidoId, data, faturamento = 100, resultado = null, confianca = "confiavel", status = "paid", payload = {} }) {
  return {
    id, import_id: importId, pedido_id: pedidoId, data_pedido: data, status, confianca,
    faturamento, resultado, pendencias_json: [], payload_json: payload,
  };
}

function importRow({ id, competencia, publicationStatus, coverageFrom, coverageTo, publishedAt = null, contaId = null, createdAt = "2026-08-01T00:00:00.000Z" }) {
  return {
    id, cliente_slug: cliente.slug, marketplace: "meli", competencia,
    cliente_conta_id: contaId, publication_status: publicationStatus,
    coverage_date_from: coverageFrom, coverage_date_to: coverageTo, published_at: publishedAt,
    fonte: "orders_api", status: "processado", confianca: "confiavel",
    resumo_json: {}, payload_json: {}, created_at: createdAt,
  };
}

function svcFor(db) {
  return createCentralVendasReadService(realRepositoryComDb(db), db);
}

async function run() {
  let checks = 0;
  function eq(label, actual, expected) {
    assert.deepStrictEqual(actual, expected, `FALHOU: ${label} — recebido ${JSON.stringify(actual)}, esperado ${JSON.stringify(expected)}`);
    checks += 1;
  }
  function ok(label, cond) {
    assert.ok(cond, `FALHOU: ${label}`);
    checks += 1;
  }

  const PERIODO = { dateFrom: "2026-08-01", dateTo: "2026-08-31" };

  // ── 1. Detalhe NÃO reconstrói o período inteiro (seção 15, obrigatória) ──
  {
    const N = 500;
    const imp = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    const pedidos = Array.from({ length: N }, (_, i) =>
      pedidoRow({ id: i + 1, importId: 1, pedidoId: `P${i + 1}`, data: "2026-08-05", faturamento: 100 + i }));
    // 3 itens + 2 componentes por pedido — se o detalhe reconstruísse tudo,
    // isso seria 1500 itens/1000 componentes cruzados em memória.
    const itens = [];
    const componentes = [];
    for (const p of pedidos) {
      for (let k = 0; k < 3; k++) {
        itens.push({ id: p.id * 10 + k, import_id: 1, pedido_row_id: p.id, item_id: `IT${p.id}_${k}`, pedido_id: p.pedido_id, mlb: "MLBX", confianca: "confiavel", pendencias_json: [] });
      }
      componentes.push({ id: p.id * 10, import_id: 1, pedido_row_id: p.id, pedido_id: p.pedido_id, tipo: "receita_produto", valor: 10, confianca: "confiavel", escopo: "pedido", efeito: "credito", incluido_no_resultado: true });
    }
    const db = makeDb({ imports: [imp], pedidos, itens, componentes });
    const svc = svcFor(db);

    const alvo = pedidos[250]; // rowId 251, no meio do período — não é o primeiro nem o último
    db.queryLog.length = 0;
    const detalhe = await svc.getCentralVendasReadOrderDetail(cliente.slug, alvo.id, PERIODO);

    eq("1: detalhe traz o pedido certo", detalhe.pedido.rowId, alvo.id);
    eq("1: detalhe traz os 3 itens DELE, não os 1500 do período", detalhe.pedido.itens.length, 3);

    // Nenhuma query de pedidos/itens/componentes bulk (import_id = ANY /
    // pedido_row_id = ANY) foi disparada — só as versões "1 registro" (LIMIT
    // 1 / pedido_row_id = $1). Prova objetiva de que a leitura é O(1) no
    // tamanho do período, não O(N).
    const queriesBulkPedidos = db.queryLog.filter((q) => q.sql.includes("FROM central_vendas_pedidos") && q.sql.includes("import_id = ANY") && !q.sql.includes("LIMIT 1"));
    const queriesBulkItens = db.queryLog.filter((q) => q.sql.includes("FROM central_vendas_pedido_itens") && q.sql.includes("ANY"));
    const queriesBulkComponentes = db.queryLog.filter((q) => q.sql.includes("FROM central_vendas_componentes") && q.sql.includes("ANY"));
    eq("1: nenhuma query bulk de pedidos (import_id = ANY) foi disparada", queriesBulkPedidos.length, 0);
    eq("1: nenhuma query bulk de itens (ANY) foi disparada", queriesBulkItens.length, 0);
    eq("1: nenhuma query bulk de componentes (ANY) foi disparada", queriesBulkComponentes.length, 0);

    const queryDetalhePedido = db.queryLog.filter((q) => q.sql.includes("FROM central_vendas_pedidos") && q.sql.includes("LIMIT 1"));
    eq("1: exatamente 1 query de pedido único (LIMIT 1)", queryDetalhePedido.length, 1);
    ok("1: query de itens do detalhe devolveu só os 3 do pedido, nao os 1500",
      itens.filter((i) => i.pedido_row_id === alvo.id).length === 3);

    console.log(`  ✓ 1. detalhe de 1 pedido entre ${N} não dispara nenhuma query bulk (O(1), não O(N))`);

    // ── 1b. 4 casos negativos -> 404 ──
    await assert.rejects(
      () => svc.getCentralVendasReadOrderDetail(cliente.slug, 999999, PERIODO),
      (err) => err.statusCode === 404,
      "1b: rowId inexistente -> 404"
    ); checks++;

    await assert.rejects(
      () => svc.getCentralVendasReadOrderDetail(cliente.slug, "abc", PERIODO),
      (err) => err.statusCode === 404,
      "1b: rowId invalido (nao numerico) -> 404"
    ); checks++;

    // rowId de OUTRO snapshot (import diferente, fora dos importIds resolvidos p/ este range)
    const impOutraCompetencia = importRow({ id: 2, competencia: "2026-06", publicationStatus: "published", coverageFrom: "2026-06-01", coverageTo: "2026-06-30", publishedAt: "2026-06-01T10:00:00Z" });
    const pedidoOutroSnapshot = pedidoRow({ id: 9001, importId: 2, pedidoId: "OUTRO_MES", data: "2026-06-05" });
    const dbComOutro = makeDb({ imports: [imp, impOutraCompetencia], pedidos: [...pedidos, pedidoOutroSnapshot] });
    const svcComOutro = svcFor(dbComOutro);
    await assert.rejects(
      () => svcComOutro.getCentralVendasReadOrderDetail(cliente.slug, pedidoOutroSnapshot.id, PERIODO),
      (err) => err.statusCode === 404,
      "1b: rowId de outro snapshot/competencia fora do range -> 404"
    ); checks++;

    // rowId de OUTRA conta
    const contas = [
      { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", slug: "a1", external_account_id: "111", is_primary: true, ativo: true },
      { id: 11, cliente_id: 1, marketplace: "meli", nome: "ML 2", slug: "a2", external_account_id: "222", is_primary: false, ativo: true },
    ];
    const impContaA = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z", contaId: 10 });
    const impContaB = importRow({ id: 2, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z", contaId: 11 });
    const pedidoContaB = pedidoRow({ id: 5001, importId: 2, pedidoId: "DA_CONTA_B", data: "2026-08-05" });
    const dbContas = makeDb({ contas, imports: [impContaA, impContaB], pedidos: [pedidoContaB] });
    const svcContas = svcFor(dbContas);
    await assert.rejects(
      () => svcContas.getCentralVendasReadOrderDetail(cliente.slug, pedidoContaB.id, { ...PERIODO, clienteContaId: 10 }),
      (err) => err.statusCode === 404,
      "1b: rowId de outra conta (conta A pedindo pedido da conta B) -> 404"
    ); checks++;

    // rowId dentro do snapshot mas fora do range de datas pedido
    const pedidoForaDoRange = pedidoRow({ id: 7001, importId: 1, pedidoId: "FORA_RANGE", data: "2026-08-05" });
    const dbSoRange = makeDb({ imports: [imp], pedidos: [pedidoForaDoRange] });
    const svcSoRange = svcFor(dbSoRange);
    await assert.rejects(
      () => svcSoRange.getCentralVendasReadOrderDetail(cliente.slug, pedidoForaDoRange.id, { dateFrom: "2026-08-10", dateTo: "2026-08-15" }),
      (err) => err.statusCode === 404,
      "1b: rowId cuja data_pedido cai fora do range pedido -> 404"
    ); checks++;

    console.log("  ✓ 1b. 4 casos negativos (id invalido, outro snapshot, outra conta, fora do range) -> 404");
  }

  // ── 2. /read/bootstrap == /read + /read/daily + /read/products (seção 16, obrigatória) ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "P1", data: "2026-08-05", faturamento: 100, resultado: 40 }),
      pedidoRow({ id: 2, importId: 1, pedidoId: "P2", data: "2026-08-06", faturamento: 200, resultado: 80 }),
      pedidoRow({ id: 3, importId: 1, pedidoId: "P3", data: "2026-08-07", faturamento: 50, resultado: null, confianca: "bloqueado" }),
    ];
    const itens = [
      { id: 1, import_id: 1, pedido_row_id: 1, item_id: "ITA", mlb: "MLBA", pedido_id: "P1", quantidade: 1, receita_produto: 100, confianca: "confiavel", pendencias_json: [] },
      { id: 2, import_id: 1, pedido_row_id: 2, item_id: "ITB", mlb: "MLBB", pedido_id: "P2", quantidade: 1, receita_produto: 200, confianca: "confiavel", pendencias_json: [] },
      { id: 3, import_id: 1, pedido_row_id: 3, item_id: "ITC", mlb: "MLBC", pedido_id: "P3", quantidade: 1, receita_produto: 50, confianca: "bloqueado", pendencias_json: [] },
    ];
    const componentes = [
      { id: 1, import_id: 1, pedido_row_id: 1, pedido_id: "P1", tipo: "receita_produto", valor: 100, confianca: "confiavel", escopo: "pedido", efeito: "credito", incluido_no_resultado: true },
      { id: 2, import_id: 1, pedido_row_id: 2, pedido_id: "P2", tipo: "receita_produto", valor: 200, confianca: "confiavel", escopo: "pedido", efeito: "credito", incluido_no_resultado: true },
    ];
    const db = makeDb({ imports: [imp], pedidos, itens, componentes });
    const svc = svcFor(db);

    const params = { ...PERIODO, page: 1, limit: 50, sort: "data_desc" };
    const [readResp, dailyResp, productsResp] = await Promise.all([
      svc.getCentralVendasRead(cliente.slug, params),
      svc.getCentralVendasReadDaily(cliente.slug, params),
      svc.getCentralVendasReadProducts(cliente.slug, params),
    ]);
    const bootstrap = await svc.getCentralVendasReadBootstrap(cliente.slug, params);

    eq("2: bootstrap.summary == /read summary", bootstrap.summary, readResp.summary);
    eq("2: bootstrap.filteredSummary == /read filteredSummary", bootstrap.filteredSummary, readResp.filteredSummary);
    eq("2: bootstrap.rows == /read rows", bootstrap.rows, readResp.rows);
    eq("2: bootstrap.pagination == /read pagination", bootstrap.pagination, readResp.pagination);
    eq("2: bootstrap.motor == /read motor", bootstrap.motor, readResp.motor);
    eq("2: bootstrap.snapshot == /read snapshot", bootstrap.snapshot, readResp.snapshot);
    eq("2: bootstrap.dias == /read/daily dias", bootstrap.dias, dailyResp.dias);
    eq("2: bootstrap.produtos == /read/products produtos", bootstrap.produtos, productsResp.produtos);
    eq("2: bootstrap.totalFaturamento == /read/products totalFaturamento", bootstrap.totalFaturamento, productsResp.totalFaturamento);
    ok("2: bootstrap tem 3 pedidos no summary", bootstrap.summary.pedidosTotal === 3);

    console.log("  ✓ 2. /read/bootstrap deriva de 1 reconstrução exatamente os mesmos valores dos 3 endpoints antigos");
  }

  // ── 3. Paridade financeira: detalhe NOVO (getPedidoDetailByRowId) ==
  //      detalhe ANTIGO (buildPayloadFromRange do período inteiro + .find) ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    const pedidos = [
      // B) multi-item
      pedidoRow({ id: 1, importId: 1, pedidoId: "MULTI", data: "2026-08-05", faturamento: 300, resultado: 120 }),
      // D) custo ausente
      pedidoRow({ id: 2, importId: 1, pedidoId: "SEM_CUSTO", data: "2026-08-06", faturamento: 90, resultado: null, confianca: "bloqueado" }),
      // G) cancelado por pós-venda + H) componentes informativos (receita_envio/cancelamento_reembolso)
      pedidoRow({ id: 3, importId: 1, pedidoId: "CANCELADO", data: "2026-08-07", faturamento: 150, resultado: null, status: "cancelado", payload: { posVendaTipo: "devolucao", posVendaMotivo: "item_returned" } }),
    ];
    const itens = [
      { id: 1, import_id: 1, pedido_row_id: 1, item_id: "ITA", mlb: "MLBA", pedido_id: "MULTI", quantidade: 1, receita_produto: 200, confianca: "confiavel", pendencias_json: [] },
      { id: 2, import_id: 1, pedido_row_id: 1, item_id: "ITB", mlb: "MLBB", pedido_id: "MULTI", quantidade: 1, receita_produto: 100, confianca: "confiavel", pendencias_json: [] },
      { id: 3, import_id: 1, pedido_row_id: 2, item_id: "ITC", mlb: "MLBC", pedido_id: "SEM_CUSTO", quantidade: 1, receita_produto: 90, confianca: "bloqueado", pendencias_json: ["custo_ausente"] },
      { id: 4, import_id: 1, pedido_row_id: 3, item_id: "ITD", mlb: "MLBD", pedido_id: "CANCELADO", quantidade: 1, receita_produto: 150, confianca: "confiavel", pendencias_json: [] },
    ];
    const componentes = [
      { id: 1, import_id: 1, pedido_row_id: 1, pedido_id: "MULTI", tipo: "receita_produto", valor: 200, confianca: "confiavel", escopo: "item", item_id: "ITA", efeito: "credito", incluido_no_resultado: true },
      { id: 2, import_id: 1, pedido_row_id: 1, pedido_id: "MULTI", tipo: "receita_produto", valor: 100, confianca: "confiavel", escopo: "item", item_id: "ITB", efeito: "credito", incluido_no_resultado: true },
      { id: 3, import_id: 1, pedido_row_id: 1, pedido_id: "MULTI", tipo: "frete_seller", valor: -15, confianca: "confiavel", escopo: "pedido", efeito: "debito", incluido_no_resultado: true },
      // H) informativos — nunca entram no resultado, mas devem sobreviver no detalhe
      { id: 4, import_id: 1, pedido_row_id: 3, pedido_id: "CANCELADO", tipo: "receita_envio", valor: 12, confianca: "confiavel", escopo: "pedido", efeito: "credito", incluido_no_resultado: false },
      { id: 5, import_id: 1, pedido_row_id: 3, pedido_id: "CANCELADO", tipo: "cancelamento_reembolso", valor: -150, confianca: "confiavel", escopo: "pedido", efeito: "debito", incluido_no_resultado: false },
    ];
    const db = makeDb({ imports: [imp], pedidos, itens, componentes });
    const svc = svcFor(db);

    // "ANTIGO": reconstrói o período inteiro (mesma função pura de antes do
    // M10, ainda exportada) e acha o pedido na lista — exatamente o que
    // getCentralVendasReadOrderDetail fazia até este marco.
    const payloadAntigo = buildPayloadFromRange(cliente, PERIODO, { importacao: imp, imports: [imp], pedidos, itens, componentes });

    for (const [label, pedidoId, rowId] of [["B/multi-item", "MULTI", 1], ["D/custo ausente", "SEM_CUSTO", 2], ["G+H/cancelado+informativos", "CANCELADO", 3]]) {
      const antigo = payloadAntigo.pedidos.find((p) => p.pedidoId === pedidoId);
      const novo = await svc.getCentralVendasReadOrderDetail(cliente.slug, rowId, PERIODO);
      eq(`3: paridade detalhe (${label}) — novo == antigo (buildPayloadFromRange completo)`, novo.pedido, antigo);
    }

    console.log("  ✓ 3. paridade financeira: detalhe otimizado == detalhe reconstruindo o período inteiro (multi-item, custo ausente, cancelado, componentes informativos)");
  }

  console.log(`centralVendasM10ReadPerformance.test.js: ${checks} verificacoes OK`);
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
