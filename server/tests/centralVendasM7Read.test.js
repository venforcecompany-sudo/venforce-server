// server/tests/centralVendasM7Read.test.js
//
// M7 — Read API canônica e paginada.
//
// Reaproveita o MESMO padrão de fake db de centralVendasGetAccountScoped.test.js
// e centralVendasM4Publication.test.js: as funções REAIS de
// centralVendasRepository (getLatestCentralVendasImport/getCentralVendasByRange/
// selecionarMelhorImportPorCompetencia) rodam contra uma fake db em memória —
// central_vendas_pedidos/itens/componentes/imports. centralVendasReadService
// chama createCentralVendasService(...).resolveRangeContext internamente, então
// estes testes provam que M7 reusa a MESMA seleção published/candidate/legacy
// do M4 (nunca uma segunda implementação) e que filtro/ordenação/paginação
// operam sobre o contrato de pedido já canônico (M5/M6), sem recalcular nada.

const assert = require("assert");
const repository = require("../services/centralVendas/centralVendasRepository");
const { createCentralVendasReadService } = require("../services/centralVendas/centralVendasReadService");

const cliente = { id: 1, nome: "Cliente A", slug: "cliente-a", ativo: true };

function realRepositoryComDb(db) {
  return {
    ensureCentralVendasTables: () => repository.ensureCentralVendasTables(db),
    getClienteBySlug: (slug) => repository.getClienteBySlug(slug, db),
    getLatestCentralVendasImport: (args) => repository.getLatestCentralVendasImport(args, db),
    getCentralVendasByRange: (args) => repository.getCentralVendasByRange(args, db),
    // M10 — leitura otimizada: mesmo padrão de binding dos métodos acima.
    resolveImportsForRange: (args) => repository.resolveImportsForRange(args, db),
    loadPedidosByImportIds: (args) => repository.loadPedidosByImportIds(args, db),
    getPedidoDetailByRowId: (args) => repository.getPedidoDetailByRowId(args, db),
  };
}

function makeDb({ contas = [], imports = [], pedidos = [], itens = [], componentes = [] }) {
  return {
    async query(sql, params = []) {
      if (sql.includes("CREATE TABLE") || sql.includes("ALTER TABLE") || sql.includes("CREATE INDEX") || sql.includes("CREATE UNIQUE INDEX") || sql.includes("WITH duplicados")) {
        return { rows: [] };
      }
      if (sql.includes("FROM clientes") && sql.includes("slug = $1")) {
        return { rows: params[0] === cliente.slug ? [cliente] : [] };
      }
      if (sql.includes("FROM clientes") && sql.includes("WHERE id")) {
        return { rows: params[0] === cliente.id ? [cliente] : [] };
      }
      // resolveMarketplaceAccountContext
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

      // ── central_vendas_imports: getCentralVendasByRange ──
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
      // M10 — getPedidoDetailByRowId: 1 pedido específico (checado ANTES do
      // branch genérico de import_id = ANY abaixo, que também casaria com
      // esta query — LIMIT 1 é a marca exclusiva desta).
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
      // M10 — getPedidoDetailByRowId: itens/componentes de 1 pedido só.
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

function pedidoRow({ id, importId, pedidoId, data, faturamento = 100, resultado = null, confianca = "confiavel", status = "paid" }) {
  return {
    id, import_id: importId, pedido_id: pedidoId, data_pedido: data, status, confianca,
    faturamento, resultado, pendencias_json: [], payload_json: {},
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

  // ── A. Paginação: 185 pedidos, limit 50 → 4 páginas, sem duplicação ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    const pedidos = Array.from({ length: 185 }, (_, i) =>
      pedidoRow({ id: i + 1, importId: 1, pedidoId: `P${i + 1}`, data: "2026-08-01", faturamento: 100 + i }));
    const db = makeDb({ imports: [imp], pedidos });
    const svc = svcFor(db);

    const seen = new Set();
    let totalPages = null;
    for (let page = 1; page <= 4; page++) {
      const resp = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", page, limit: 50 });
      totalPages = resp.pagination.totalPages;
      eq(`A: page ${page} total`, resp.pagination.total, 185);
      for (const row of resp.rows) {
        ok(`A: pedido ${row.id} nao duplicado entre paginas`, !seen.has(row.id));
        seen.add(row.id);
      }
    }
    eq("A: 4 paginas", totalPages, 4);
    eq("A: todos os 185 pedidos vistos", seen.size, 185);
    console.log("  ✓ A. paginação: 185 pedidos, limit 50 → 4 páginas sem duplicação");
  }

  // ── B. Summary global: página 1 e página 2 têm summary idêntico ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    const pedidos = Array.from({ length: 120 }, (_, i) =>
      pedidoRow({ id: i + 1, importId: 1, pedidoId: `P${i + 1}`, data: "2026-08-01", faturamento: 10 }));
    const db = makeDb({ imports: [imp], pedidos });
    const svc = svcFor(db);

    const p1 = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", page: 1, limit: 50 });
    const p2 = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", page: 2, limit: 50 });
    eq("B: summary identico entre paginas", p1.summary, p2.summary);
    eq("B: summary reflete os 120 pedidos, nao so a pagina", p1.summary.pedidosTotal, 120);
    ok("B: rows da pagina 1 tem 50", p1.rows.length === 50);
    console.log("  ✓ B. summary global idêntico entre páginas, nunca só a página atual");
  }

  // ── C. Filtro + paginação: total é do universo filtrado ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "SEM_MLB", data: "2026-08-01", faturamento: 50 }), // sem item -> mlb null, custoStatus nunca "ausente" por regra (mlb obrigatorio no filtro)
      pedidoRow({ id: 2, importId: 1, pedidoId: "COM_CUSTO", data: "2026-08-02", faturamento: 80 }),
      pedidoRow({ id: 3, importId: 1, pedidoId: "SEM_CUSTO", data: "2026-08-03", faturamento: 90 }),
    ];
    const itens = [
      { id: 1, import_id: 1, pedido_row_id: 2, item_id: "IT2", mlb: "MLB2", pedido_id: "COM_CUSTO", confianca: "confiavel", pendencias_json: [], payload_json: {} },
      { id: 2, import_id: 1, pedido_row_id: 3, item_id: "IT3", mlb: "MLB3", pedido_id: "SEM_CUSTO", confianca: "parcial", pendencias_json: [], payload_json: {} },
    ];
    const componentes = [
      { id: 1, import_id: 1, pedido_row_id: 2, item_row_id: 1, pedido_id: "COM_CUSTO", item_id: "IT2", tipo: "custo_produto", valor: 20, confianca: "confiavel", escopo: "item", efeito: "debito", incluido_no_resultado: true },
    ];
    const db = makeDb({ imports: [imp], pedidos, itens, componentes });
    const svc = svcFor(db);

    const resp = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", filtro: "sem_custo", page: 1, limit: 50 });
    eq("C: total do universo filtrado (so SEM_CUSTO tem mlb sem custo)", resp.pagination.total, 1);
    eq("C: pedido correto no filtro", resp.rows.map((r) => r.pedidoId), ["SEM_CUSTO"]);
    eq("C: summary continua global (3 pedidos), nao filtrado", resp.summary.pedidosTotal, 3);
    console.log("  ✓ C. filtro (sem_custo) + paginação: total é do universo filtrado, summary continua global");
  }

  // ── D. Ordenação determinística: empates não mudam pedido entre páginas ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    // Todos com o MESMO faturamento (empate total) — só rowId desempata.
    const pedidos = Array.from({ length: 10 }, (_, i) =>
      pedidoRow({ id: i + 1, importId: 1, pedidoId: `P${i + 1}`, data: "2026-08-01", faturamento: 100 }));
    const db = makeDb({ imports: [imp], pedidos });
    const svc = svcFor(db);

    const p1a = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", sort: "fat_desc", page: 1, limit: 5 });
    const p1b = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", sort: "fat_desc", page: 1, limit: 5 });
    eq("D: mesma pagina, mesma ordenacao, chamadas repetidas -> mesmo resultado", p1a.rows.map((r) => r.id), p1b.rows.map((r) => r.id));

    const p2 = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", sort: "fat_desc", page: 2, limit: 5 });
    const idsP1 = new Set(p1a.rows.map((r) => r.id));
    for (const row of p2.rows) ok(`D: pedido ${row.id} da pagina 2 nao esta na pagina 1`, !idsP1.has(row.id));
    console.log("  ✓ D. ordenação determinística: empate total nunca duplica/desloca pedido entre páginas");
  }

  // ── E. Published correto é lido (candidate concorrente é ignorado) ──
  {
    const published = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-10T10:00:00Z" });
    const candidate = importRow({ id: 2, competencia: "2026-08", publicationStatus: "candidate", coverageFrom: "2026-08-01", coverageTo: "2026-08-31" });
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "DO_PUBLISHED", data: "2026-08-05", faturamento: 10 }),
      pedidoRow({ id: 2, importId: 2, pedidoId: "DO_CANDIDATE", data: "2026-08-06", faturamento: 20 }),
    ];
    const db = makeDb({ imports: [published, candidate], pedidos });
    const svc = svcFor(db);
    const resp = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    eq("E: le o published", resp.snapshot.importId, 1);
    eq("E: so ve o pedido do published", resp.rows.map((r) => r.pedidoId), ["DO_PUBLISHED"]);
    console.log("  ✓ E. published correto é lido");
  }

  // ── F. Candidate nunca vira oficial (sem published/legacy) ──
  {
    const candidate = importRow({ id: 1, competencia: "2026-08", publicationStatus: "candidate", coverageFrom: "2026-08-01", coverageTo: "2026-08-31" });
    const pedidos = [pedidoRow({ id: 1, importId: 1, pedidoId: "SO_CANDIDATE", data: "2026-08-05", faturamento: 10 })];
    const db = makeDb({ imports: [candidate], pedidos });
    const svc = svcFor(db);
    const resp = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    eq("F: snapshot nulo (candidate nunca aparece)", resp.snapshot, null);
    eq("F: motor sem_dados", resp.motor.status, "sem_dados");
    eq("F: rows vazio", resp.rows, []);
    eq("F: pagination zerada", resp.pagination, { page: 1, limit: 50, total: 0, totalPages: 0 });
    console.log("  ✓ F. candidate nunca vira oficial");
  }

  // ── G. Legacy — fallback continua funcionando ──
  {
    const legacy = importRow({ id: 1, competencia: "2026-08", publicationStatus: "legacy", coverageFrom: null, coverageTo: null, createdAt: "2026-08-15T10:00:00Z" });
    const pedidos = [pedidoRow({ id: 1, importId: 1, pedidoId: "LEGADO", data: "2026-08-05", faturamento: 10 })];
    const db = makeDb({ imports: [legacy], pedidos });
    const svc = svcFor(db);
    const resp = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    eq("G: le o legacy quando nao ha published", resp.snapshot.importId, 1);
    eq("G: publicationStatus reportado", resp.snapshot.publicationStatus, "legacy");
    eq("G: pedido legado presente", resp.rows.map((r) => r.pedidoId), ["LEGADO"]);
    console.log("  ✓ G. legacy: fallback continua funcionando");
  }

  // ── H. Coverage: snapshot parcial nao responde por range maior ──
  {
    const parcial = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-10", coverageTo: "2026-08-15", publishedAt: "2026-08-16T10:00:00Z" });
    const pedidos = [pedidoRow({ id: 1, importId: 1, pedidoId: "PARCIAL", data: "2026-08-12", faturamento: 10 })];
    const db = makeDb({ imports: [parcial], pedidos });
    const svc = svcFor(db);
    const respMesInteiro = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    eq("H: cobertura parcial nunca responde range maior", respMesInteiro.snapshot, null);

    const respSoTrecho = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-10", dateTo: "2026-08-15" });
    eq("H: mas responde o trecho que de fato cobre", respSoTrecho.snapshot.importId, 1);
    console.log("  ✓ H. coverage respeitada");
  }

  // ── I. Account-aware: conta A nunca lê conta B ──
  {
    const contas = [
      { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", slug: "a1", external_account_id: "111", is_primary: true, ativo: true },
      { id: 11, cliente_id: 1, marketplace: "meli", nome: "ML 2", slug: "a2", external_account_id: "222", is_primary: false, ativo: true },
    ];
    const impA = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z", contaId: 10 });
    const impB = importRow({ id: 2, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z", contaId: 11 });
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "DA_CONTA_A", data: "2026-08-05", faturamento: 10 }),
      pedidoRow({ id: 2, importId: 2, pedidoId: "DA_CONTA_B", data: "2026-08-05", faturamento: 20 }),
    ];
    const db = makeDb({ contas, imports: [impA, impB], pedidos });
    const svc = svcFor(db);
    const respA = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", clienteContaId: 10 });
    const respB = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", clienteContaId: 11 });
    eq("I: conta A so ve seu pedido", respA.rows.map((r) => r.pedidoId), ["DA_CONTA_A"]);
    eq("I: conta B so ve seu pedido", respB.rows.map((r) => r.pedidoId), ["DA_CONTA_B"]);
    console.log("  ✓ I. account-aware: conta A nunca lê conta B");
  }

  // ── J. Zero pedidos é snapshot válido ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    const db = makeDb({ imports: [imp], pedidos: [] });
    const svc = svcFor(db);
    const resp = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    eq("J: snapshot existe (persistido), nao null", resp.snapshot?.importId, 1);
    eq("J: motor persistido, nao sem_dados", resp.motor.status, "persistido");
    eq("J: rows vazio", resp.rows, []);
    eq("J: pagination zerada mas snapshot valido", resp.pagination, { page: 1, limit: 50, total: 0, totalPages: 0 });
    console.log("  ✓ J. zero pedidos é snapshot válido (motor persistido, não sem_dados)");
  }

  // ── K. Multi-item: linha honesta (nao vira 1 produto), valores = soma dos itens (M5) ──
  // ── L. Ledger/detail: sob demanda, escopado ao snapshot/cliente/conta ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", publicationStatus: "published", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    // pedido.faturamento/resultado já são o valor CANÔNICO (soma dos itens, M5) —
    // a Read API nunca recalcula, só expõe o que já foi persistido.
    const pedidos = [pedidoRow({ id: 1, importId: 1, pedidoId: "MULTI", data: "2026-08-05", faturamento: 200, resultado: 150 })];
    const itens = [
      { id: 1, import_id: 1, pedido_row_id: 1, item_id: "ITA", mlb: "MLBA", pedido_id: "MULTI", quantidade: 1, receita_produto: 150, confianca: "confiavel", pendencias_json: [], payload_json: {} },
      { id: 2, import_id: 1, pedido_row_id: 1, item_id: "ITB", mlb: "MLBB", pedido_id: "MULTI", quantidade: 1, receita_produto: 50, confianca: "confiavel", pendencias_json: [], payload_json: {} },
    ];
    const componentes = [
      { id: 1, import_id: 1, pedido_row_id: 1, item_row_id: 1, pedido_id: "MULTI", item_id: "ITA", tipo: "receita_produto", valor: 150, confianca: "confiavel", escopo: "item", efeito: "credito", incluido_no_resultado: true },
      { id: 2, import_id: 1, pedido_row_id: 1, item_row_id: 2, pedido_id: "MULTI", item_id: "ITB", tipo: "receita_produto", valor: 50, confianca: "confiavel", escopo: "item", efeito: "credito", incluido_no_resultado: true },
    ];
    const db = makeDb({ imports: [imp], pedidos, itens, componentes });
    const svc = svcFor(db);

    const list = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    const row = list.rows[0];
    eq("K: multiItem true", row.multiItem, true);
    eq("K: qtdItens 2", row.qtdItens, 2);
    eq("K: valor = soma dos itens (M5), nao so o primeiro item", row.valor, 200);
    eq("K: resultado = canonico persistido", row.resultado, 150);
    ok("K: lista NAO inclui itens/componentes (payload leve)", row.itens === undefined && row.componentes === undefined);
    ok("K: rowId presente para detalhe sob demanda", row.rowId === 1);

    const detalhe = await svc.getCentralVendasReadOrderDetail(cliente.slug, row.rowId, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    eq("L: detalhe traz os 2 itens", detalhe.pedido.itens.length, 2);
    eq("L: detalhe traz os componentes com escopo/efeito/incluidoNoResultado (M6)", detalhe.pedido.componentes.map((c) => c.escopo), ["item", "item"]);
    eq("L: incluidoNoResultado exposto", detalhe.pedido.componentes.every((c) => c.incluidoNoResultado === true), true);

    // rowId de outro snapshot/cliente nunca resolve aqui (sem import_id/pedidoId isolado).
    await assert.rejects(
      () => svc.getCentralVendasReadOrderDetail(cliente.slug, 9999, { dateFrom: "2026-08-01", dateTo: "2026-08-31" }),
      (err) => err.statusCode === 404
    );
    checks += 1;
    console.log("  ✓ K. multi-item honesto (soma dos itens, nunca 1 produto só)");
    console.log("  ✓ L. detalhe/ledger sob demanda, escopado ao snapshot; rowId estranho -> 404");
  }

  console.log(`centralVendasM7Read.test.js: ${checks} verificacoes OK`);
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
