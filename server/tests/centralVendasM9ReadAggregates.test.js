// server/tests/centralVendasM9ReadAggregates.test.js
//
// M9 — remoção do recálculo financeiro do frontend da Central de Vendas V3.
//
// Este arquivo prova o lado BACKEND do marco: os agregados que
// Portal/fechamentos-api.js antes recalculava localmente (resumo do
// fechamento/qualidade, vendas por dia, Curva ABC) agora existem como
// leitura pura sobre o contrato de pedido já canônico (M5/M6/M7) — nenhuma
// fórmula financeira nova, apenas soma de campos já persistidos.
//
// Mesmo padrão de fake db de centralVendasM7Read.test.js: as funções REAIS
// de centralVendasRepository rodam contra uma fake db em memória.

const assert = require("assert");
const repository = require("../services/centralVendas/centralVendasRepository");
const { createCentralVendasReadService } = require("../services/centralVendas/centralVendasReadService");
const { round2 } = require("../utils/numberUtils");

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
      if (sql.includes("FROM central_vendas_pedidos") && sql.includes("import_id = ANY")) {
        const [importIds, dateFrom, dateTo] = params;
        return { rows: pedidos.filter((p) => importIds.includes(p.import_id) && p.data_pedido >= dateFrom && p.data_pedido <= dateTo) };
      }
      if (sql.includes("FROM central_vendas_pedido_itens") && sql.includes("pedido_row_id = ANY")) {
        const [rowIds] = params;
        return { rows: itens.filter((i) => rowIds.includes(i.pedido_row_id)) };
      }
      if (sql.includes("FROM central_vendas_componentes") && sql.includes("pedido_row_id = ANY")) {
        const [rowIds] = params;
        return { rows: componentes.filter((c) => rowIds.includes(c.pedido_row_id)) };
      }

      // A tabela de vínculos não existe nesta fixture (reuso desligado).
      if (/to_regclass\('public\.central_vendas_import_pedidos'\)/.test(String(sql))) return { rows: [{ ok: false }] };
      throw new Error(`Fake db: SQL nao mapeado -> ${sql.slice(0, 160)}`);
    },
  };
}

function pedidoRow({ id, importId, pedidoId, data, faturamento = 100, resultado = null, confianca = "confiavel", status = "paid", quantidadeItens = null }) {
  return {
    id, import_id: importId, pedido_id: pedidoId, data_pedido: data, status, confianca,
    faturamento, resultado, quantidade_itens: quantidadeItens, pendencias_json: [], payload_json: {},
  };
}
function importRow({ id, competencia, coverageFrom, coverageTo, publishedAt, contaId = null }) {
  return {
    id, cliente_slug: cliente.slug, marketplace: "meli", competencia,
    cliente_conta_id: contaId, publication_status: "published",
    coverage_date_from: coverageFrom, coverage_date_to: coverageTo, published_at: publishedAt,
    fonte: "orders_api", status: "processado", confianca: "confiavel",
    resumo_json: {}, payload_json: {}, created_at: "2026-08-01T00:00:00.000Z",
  };
}
function itemRow({ id, pedidoRowId, itemId, mlb, pedidoId, quantidade = 1, receitaProduto = null, custoProduto = null, confianca = "confiavel" }) {
  return { id, import_id: 1, pedido_row_id: pedidoRowId, item_id: itemId, mlb, pedido_id: pedidoId, quantidade, receita_produto: receitaProduto, custo_produto: custoProduto, confianca, pendencias_json: [], payload_json: {} };
}
function componenteRow({ id, pedidoRowId, itemRowId = null, pedidoId, itemId = null, tipo, valor, confianca = "confiavel", escopo, efeito, incluidoNoResultado }) {
  return { id, import_id: 1, pedido_row_id: pedidoRowId, item_row_id: itemRowId, pedido_id: pedidoId, item_id: itemId, tipo, valor, confianca, escopo, efeito, incluido_no_resultado: incluidoNoResultado };
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

  // ── A. summary: unidades/ticket/comissão/custo/frete/cobertura, honestidade de ausência ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "P1", data: "2026-08-01", faturamento: 100, resultado: 30, quantidadeItens: 2 }),
      pedidoRow({ id: 2, importId: 1, pedidoId: "P2", data: "2026-08-02", faturamento: 200, resultado: 60, quantidadeItens: 3 }),
    ];
    const itens = [
      itemRow({ id: 1, pedidoRowId: 1, itemId: "IT1", mlb: "MLBA", pedidoId: "P1", quantidade: 2, receitaProduto: 100, custoProduto: 40 }),
      itemRow({ id: 2, pedidoRowId: 2, itemId: "IT2", mlb: "MLBB", pedidoId: "P2", quantidade: 3, receitaProduto: 200, custoProduto: 80 }),
    ];
    const componentes = [
      componenteRow({ id: 1, pedidoRowId: 1, itemRowId: 1, pedidoId: "P1", itemId: "IT1", tipo: "custo_produto", valor: 40, escopo: "item", efeito: "debito", incluidoNoResultado: true }),
      componenteRow({ id: 2, pedidoRowId: 1, itemRowId: 1, pedidoId: "P1", itemId: "IT1", tipo: "tarifa_venda", valor: 10, escopo: "item", efeito: "debito", incluidoNoResultado: true }),
      // P2 nao tem tarifa_venda nem frete_seller -> comissao/frete devem ficar null (ausencia real, nao 0).
      componenteRow({ id: 3, pedidoRowId: 2, itemRowId: 2, pedidoId: "P2", itemId: "IT2", tipo: "custo_produto", valor: 80, escopo: "item", efeito: "debito", incluidoNoResultado: true }),
    ];
    const db = makeDb({ imports: [imp], pedidos, itens, componentes });
    const resp = await svcFor(db).getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    const s = resp.summary;

    eq("A: unidades = soma quantidade_itens", s.unidades, 5);
    eq("A: ticket = faturamento/pedidosValidos", s.ticket, 150);
    eq("A: comissao = soma so de quem tem tarifa_venda (P1), nao 0 no P2", s.comissao, 10);
    eq("A: freteTotal ausente em TODOS os pedidos -> null, nunca 0", s.freteTotal, null);
    eq("A: custoTotal = soma dos 2 pedidos", s.custoTotal, 120);
    eq("A: cobertura.custo = 100% (os 2 pedidos tem custo)", s.cobertura.custo, 100);
    eq("A: cobertura.frete = null (nenhum pedido tem frete)", s.cobertura.frete, null);
    eq("A: cobertura.comissao = 33.33% (so P1, R$100 de R$300)", s.cobertura.comissao, 33.33);
    eq("A: semFrete = 2 (nenhum pedido valido tem frete)", s.semFrete, 2);
    eq("A: semCusto = 0 (os 2 tem custo)", s.semCusto, 0);
    console.log("  ✓ A. summary: unidades/ticket/comissão/custo/frete/cobertura — ausência nunca vira 0");
  }

  // ── B. filteredSummary (resumoFiltro) é distinto de summary (global) ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "COM_CUSTO", data: "2026-08-01", faturamento: 100, resultado: 30, quantidadeItens: 1 }),
      pedidoRow({ id: 2, importId: 1, pedidoId: "SEM_CUSTO", data: "2026-08-02", faturamento: 200, resultado: null, confianca: "bloqueado", quantidadeItens: 1 }),
    ];
    const itens = [
      itemRow({ id: 1, pedidoRowId: 1, itemId: "IT1", mlb: "MLBA", pedidoId: "COM_CUSTO", quantidade: 1, receitaProduto: 100, custoProduto: 40 }),
      itemRow({ id: 2, pedidoRowId: 2, itemId: "IT2", mlb: "MLBB", pedidoId: "SEM_CUSTO", quantidade: 1, receitaProduto: 200 }),
    ];
    const componentes = [
      componenteRow({ id: 1, pedidoRowId: 1, itemRowId: 1, pedidoId: "COM_CUSTO", itemId: "IT1", tipo: "custo_produto", valor: 40, escopo: "item", efeito: "debito", incluidoNoResultado: true }),
    ];
    const db = makeDb({ imports: [imp], pedidos, itens, componentes });
    const svc = svcFor(db);

    const respTodos = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", resumoFiltro: "todos" });
    const respBloq = await svc.getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", resumoFiltro: "bloqueados" });

    eq("B: summary global sempre com os 2 pedidos, independente de resumoFiltro", respTodos.summary.pedidosTotal, 2);
    eq("B: summary global identico entre as duas chamadas (nunca reaproveita filteredSummary)", respBloq.summary, respTodos.summary);
    eq("B: filteredSummary('todos') = os 2 pedidos", respTodos.filteredSummary.pedidosTotal, 2);
    eq("B: filteredSummary('bloqueados') = so o pedido sem custo", respBloq.filteredSummary.pedidosTotal, 1);
    eq("B: filteredSummary('bloqueados').faturamento = so R$200", respBloq.filteredSummary.faturamento, 200);
    console.log("  ✓ B. filteredSummary é um contrato distinto de summary — nunca reaproveita o global com outro sentido");
  }

  // ── C. dataDe/dataAte recorta as rows (dia clicado), mas NUNCA o summary global ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "DIA1", data: "2026-08-01", faturamento: 100 }),
      pedidoRow({ id: 2, importId: 1, pedidoId: "DIA2", data: "2026-08-05", faturamento: 200 }),
    ];
    const db = makeDb({ imports: [imp], pedidos });
    const resp = await svcFor(db).getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", dataDe: "2026-08-05", dataAte: "2026-08-05" });
    eq("C: rows só do dia clicado", resp.rows.map((r) => r.pedidoId), ["DIA2"]);
    eq("C: summary continua global (2 pedidos)", resp.summary.pedidosTotal, 2);
    console.log("  ✓ C. clique no dia recorta as rows via dataDe/dataAte, nunca o summary global");
  }

  // ── D. diagbase (com_custo/sem_custo) filtra as rows ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "COM_CUSTO", data: "2026-08-01", faturamento: 100 }),
      pedidoRow({ id: 2, importId: 1, pedidoId: "SEM_CUSTO", data: "2026-08-02", faturamento: 200 }),
    ];
    const itens = [
      itemRow({ id: 1, pedidoRowId: 1, itemId: "IT1", mlb: "MLBA", pedidoId: "COM_CUSTO" }),
      itemRow({ id: 2, pedidoRowId: 2, itemId: "IT2", mlb: "MLBB", pedidoId: "SEM_CUSTO" }),
    ];
    const componentes = [
      componenteRow({ id: 1, pedidoRowId: 1, itemRowId: 1, pedidoId: "COM_CUSTO", itemId: "IT1", tipo: "custo_produto", valor: 40, escopo: "item", efeito: "debito", incluidoNoResultado: true }),
    ];
    const db = makeDb({ imports: [imp], pedidos, itens, componentes });
    const resp = await svcFor(db).getCentralVendasRead(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", diagbase: "sem_custo" });
    eq("D: diagbase=sem_custo so retorna o pedido sem custo", resp.rows.map((r) => r.pedidoId), ["SEM_CUSTO"]);
    console.log("  ✓ D. diagbase (com_custo/sem_custo) filtra as rows no backend");
  }

  // ── E. Vendas por dia (/read/daily): agregado por data, período inteiro ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "P1", data: "2026-08-01", faturamento: 100, quantidadeItens: 1 }),
      pedidoRow({ id: 2, importId: 1, pedidoId: "P2", data: "2026-08-01", faturamento: 50, quantidadeItens: 1, status: "cancelado" }),
      pedidoRow({ id: 3, importId: 1, pedidoId: "P3", data: "2026-08-02", faturamento: 300, quantidadeItens: 1, resultado: null, confianca: "bloqueado" }),
    ];
    const itens = [
      itemRow({ id: 1, pedidoRowId: 1, itemId: "IT1", mlb: "MLBA", pedidoId: "P1", receitaProduto: 100, custoProduto: 40 }),
      itemRow({ id: 3, pedidoRowId: 3, itemId: "IT3", mlb: "MLBC", pedidoId: "P3", receitaProduto: 300 }),
    ];
    const componentes = [
      componenteRow({ id: 1, pedidoRowId: 1, itemRowId: 1, pedidoId: "P1", itemId: "IT1", tipo: "custo_produto", valor: 40, escopo: "item", efeito: "debito", incluidoNoResultado: true }),
    ];
    const db = makeDb({ imports: [imp], pedidos, itens, componentes });
    const resp = await svcFor(db).getCentralVendasReadDaily(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    eq("E: 2 dias com pedido (calendário completo é responsabilidade do frontend)", resp.dias.length, 2);
    const dia1 = resp.dias.find((d) => d.data === "2026-08-01");
    eq("E: dia 1 tem 2 pedidos (inclui cancelado na contagem)", dia1.pedidos, 2);
    eq("E: dia 1 faturamento só do pedido válido (exclui cancelado)", dia1.faturamento, 100);
    eq("E: dia 1 cancelProblema = 1", dia1.cancelProblema, 1);
    const dia2 = resp.dias.find((d) => d.data === "2026-08-02");
    eq("E: dia 2 receita bloqueada = 300 (pedido sem custo)", dia2.receitaBloqueada, 300);
    eq("E: dia 2 custo = null (nenhum pedido do dia tem custo), nunca 0", dia2.custo, null);
    console.log("  ✓ E. /read/daily agrega por data — ausência nunca vira 0, cancelado fora do faturamento");
  }

  // ── F. Curva ABC (/read/products): cada MLB recebe SÓ a própria receita,
  // mesmo dentro de um pedido multi-item — nunca o total do pedido inteiro
  // no "mlb representante" (bug corrigido no hardening M9: a expectativa
  // antiga desta suíte era "linha MULTI conta só pelo mlb representante",
  // que era o próprio bug documentado, não uma regra de negócio). ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    // MULTI-ITEM: um pedido com 2 produtos diferentes (MLBB e MLBA) + um
    // segundo pedido mono-produto reforçando MLBA. custoUnit tem de vir do
    // CATÁLOGO daquele mlb, nunca de pedido.custo/unidades (que somaria os
    // dois produtos e daria um custo unitário errado).
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "MULTI", data: "2026-08-01", faturamento: 300, resultado: 100, quantidadeItens: 3 }),
      pedidoRow({ id: 2, importId: 1, pedidoId: "SO_A", data: "2026-08-02", faturamento: 700, resultado: 200, quantidadeItens: 1 }),
    ];
    const itens = [
      itemRow({ id: 2, pedidoRowId: 1, itemId: "IT1B", mlb: "MLBB", pedidoId: "MULTI", quantidade: 2, receitaProduto: 200, custoProduto: 160 }),
      itemRow({ id: 1, pedidoRowId: 1, itemId: "IT1A", mlb: "MLBA", pedidoId: "MULTI", quantidade: 1, receitaProduto: 100, custoProduto: 40 }),
      itemRow({ id: 3, pedidoRowId: 2, itemId: "IT2A", mlb: "MLBA", pedidoId: "SO_A", quantidade: 1, receitaProduto: 700, custoProduto: 40 }),
    ];
    const componentes = [
      componenteRow({ id: 2, pedidoRowId: 1, itemRowId: 2, pedidoId: "MULTI", itemId: "IT1B", tipo: "custo_produto", valor: 160, escopo: "item", efeito: "debito", incluidoNoResultado: true }),
      componenteRow({ id: 4, pedidoRowId: 1, itemRowId: 2, pedidoId: "MULTI", itemId: "IT1B", tipo: "tarifa_venda", valor: 20, escopo: "item", efeito: "debito", incluidoNoResultado: true }),
      componenteRow({ id: 1, pedidoRowId: 1, itemRowId: 1, pedidoId: "MULTI", itemId: "IT1A", tipo: "custo_produto", valor: 40, escopo: "item", efeito: "debito", incluidoNoResultado: true }),
      componenteRow({ id: 5, pedidoRowId: 1, itemRowId: 1, pedidoId: "MULTI", itemId: "IT1A", tipo: "tarifa_venda", valor: 10, escopo: "item", efeito: "debito", incluidoNoResultado: true }),
      componenteRow({ id: 3, pedidoRowId: 2, itemRowId: 3, pedidoId: "SO_A", itemId: "IT2A", tipo: "custo_produto", valor: 40, escopo: "item", efeito: "debito", incluidoNoResultado: true }),
      // SO_A não tem tarifa_venda -> comissão de MLBA deve ser só a de IT1A (10), nunca 0 nem null.
    ];
    const db = makeDb({ imports: [imp], pedidos, itens, componentes });
    const resp = await svcFor(db).getCentralVendasReadProducts(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });

    eq("F: 2 produtos distintos (MLBA e MLBB), cada MLB do multi-item vira sua própria linha", resp.produtos.length, 2);
    eq("F: totalFaturamento = soma dos 2 pedidos (300 + 700)", resp.totalFaturamento, 1000);
    const mlbA = resp.produtos.find((p) => p.mlb === "MLBA");
    const mlbB = resp.produtos.find((p) => p.mlb === "MLBB");
    // MLBA recebe só a própria receita: 100 (item do MULTI) + 700 (SO_A) = 800.
    // NUNCA 300 (faturamento do pedido MULTI inteiro) nem 0.
    eq("F: MLBA faturamento = soma só dos itens MLBA (100 + 700), nunca o total do pedido MULTI", mlbA.faturamento, 800);
    // MLBB recebe só a própria receita do item dentro do MULTI: 200. Nunca 300 (total do pedido) nem 0.
    eq("F: MLBB faturamento = só a receita do próprio item (200), nunca o total do pedido nem 0", mlbB.faturamento, 200);
    eq("F: MLBA aparece em 2 pedidos distintos (MULTI e SO_A)", mlbA.pedidos, 2);
    eq("F: MLBB aparece em 1 pedido (só o MULTI)", mlbB.pedidos, 1);
    // custo unitário do catálogo (MLBA: custo_produto=40, quantidade=1 -> 40/1=40),
    // nunca pedido.custo/pedido.unidades do MULTI (que seria (40+160)/3 = 66.67, errado).
    eq("F: custoUnit vem do catálogo do MLB, não da divisão do total multi-item", mlbA.custoUnit, 40);
    eq("F: MLBA concentra 80% do faturamento (800 de 1000) -> curva A", mlbA.curva, "A");
    // Comissão (tarifa_venda) já é persistida por ITEM (M5) — nunca a tarifa do pedido inteiro.
    eq("F: comissão de MLBB = só a tarifa do próprio item (20), nunca a soma do pedido inteiro (30)", mlbB.comissao, 20);
    eq("F: comissão de MLBA = soma das tarifas dos itens MLBA (10 do MULTI; SO_A não tem)", mlbA.comissao, 10);
    // Reconciliação (Caso H da spec): Σ faturamento dos produtos == faturamento válido do período.
    const somaProdutos = round2(resp.produtos.reduce((sum, p) => sum + p.faturamento, 0));
    eq("F/H: Σ faturamento dos produtos reconcilia com totalFaturamento do período", somaProdutos, resp.totalFaturamento);
    console.log("  ✓ F. /read/products: cada MLB recebe só a própria receita/comissão, mesmo em pedido multi-item; reconciliação (Σ produtos = total)");
  }

  // ── F2. Caso C/D da spec de hardening — contagem de PEDIDOS por produto:
  // 2 pedidos com o mesmo MLB -> 2; o mesmo MLB repetido em 2 LINHAS do
  // MESMO pedido -> não duplica (continua 1). ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "REP1", data: "2026-08-01", faturamento: 50, quantidadeItens: 1 }),
      pedidoRow({ id: 2, importId: 1, pedidoId: "REP2", data: "2026-08-02", faturamento: 30, quantidadeItens: 1 }),
      // Duas LINHAS do mesmo MLB dentro do MESMO pedido (ex.: 2 unidades vendidas em entradas separadas).
      pedidoRow({ id: 3, importId: 1, pedidoId: "DUPLINHA", data: "2026-08-03", faturamento: 40, quantidadeItens: 2 }),
    ];
    const itens = [
      itemRow({ id: 1, pedidoRowId: 1, itemId: "R1", mlb: "MLBREP", pedidoId: "REP1", quantidade: 1, receitaProduto: 50, custoProduto: 20 }),
      itemRow({ id: 2, pedidoRowId: 2, itemId: "R2", mlb: "MLBREP", pedidoId: "REP2", quantidade: 1, receitaProduto: 30, custoProduto: 10 }),
      itemRow({ id: 3, pedidoRowId: 3, itemId: "R3a", mlb: "MLBREP", pedidoId: "DUPLINHA", quantidade: 1, receitaProduto: 20, custoProduto: 8 }),
      itemRow({ id: 4, pedidoRowId: 3, itemId: "R3b", mlb: "MLBREP", pedidoId: "DUPLINHA", quantidade: 1, receitaProduto: 20, custoProduto: 8 }),
    ];
    const db = makeDb({ imports: [imp], pedidos, itens });
    const resp = await svcFor(db).getCentralVendasReadProducts(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    const rep = resp.produtos.find((p) => p.mlb === "MLBREP");
    eq("F2 (Caso C): MLBREP aparece em 3 pedidos distintos (REP1, REP2, DUPLINHA)", rep.pedidos, 3);
    eq("F2 (Caso D): 2 linhas do mesmo MLB no pedido DUPLINHA não duplicam a contagem de pedidos (conta 1x)", rep.pedidos, 3);
    eq("F2: faturamento soma as 2 linhas do DUPLINHA (50+30+20+20=120)", rep.faturamento, 120);
    eq("F2: unidades soma as 2 linhas do DUPLINHA (1+1+1+1=4)", rep.unidades, 4);
    console.log("  ✓ F2. Contagem de pedidos por produto: 2 pedidos com mesmo MLB conta 2; 2 linhas no mesmo pedido não duplicam");
  }

  // ── F3. Caso I da spec de hardening — custos/receitas de itens diferentes
  // no mesmo pedido nunca se misturam entre produtos. ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "MIX", data: "2026-08-01", faturamento: 1010, quantidadeItens: 2 }),
    ];
    // Item A: custo altíssimo (1000) e imposto alto. Item B: custo baixíssimo
    // (1) e imposto baixo. Se o item posterior herdasse dado do primeiro (ou
    // vice-versa), a diferença apareceria em ordens de grandeza no custoUnit
    // do catálogo (que já é por item — aqui provamos que o agregado por
    // produto também nunca soma o custo/receita do MLB errado).
    const itens = [
      itemRow({ id: 1, pedidoRowId: 1, itemId: "MA", mlb: "MLB_CARO", pedidoId: "MIX", quantidade: 1, receitaProduto: 1000, custoProduto: 900 }),
      itemRow({ id: 2, pedidoRowId: 1, itemId: "MB", mlb: "MLB_BARATO", pedidoId: "MIX", quantidade: 1, receitaProduto: 10, custoProduto: 1 }),
    ];
    const componentes = [
      componenteRow({ id: 1, pedidoRowId: 1, itemRowId: 1, pedidoId: "MIX", itemId: "MA", tipo: "custo_produto", valor: 900, escopo: "item", efeito: "debito", incluidoNoResultado: true }),
      componenteRow({ id: 2, pedidoRowId: 1, itemRowId: 2, pedidoId: "MIX", itemId: "MB", tipo: "custo_produto", valor: 1, escopo: "item", efeito: "debito", incluidoNoResultado: true }),
    ];
    const db = makeDb({ imports: [imp], pedidos, itens, componentes });
    const resp = await svcFor(db).getCentralVendasReadProducts(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    const caro = resp.produtos.find((p) => p.mlb === "MLB_CARO");
    const barato = resp.produtos.find((p) => p.mlb === "MLB_BARATO");
    eq("F3 (Caso I): MLB_CARO custoUnit = 900 (nunca contaminado pelo item barato)", caro.custoUnit, 900);
    eq("F3 (Caso I): MLB_BARATO custoUnit = 1 (nunca contaminado pelo item caro)", barato.custoUnit, 1);
    eq("F3 (Caso I): MLB_CARO faturamento = só o próprio item (1000)", caro.faturamento, 1000);
    eq("F3 (Caso I): MLB_BARATO faturamento = só o próprio item (10)", barato.faturamento, 10);
    console.log("  ✓ F3. Custo/receita de itens diferentes no mesmo pedido nunca se misturam entre produtos");
  }

  // ── F4. Caso E/F da spec de hardening — /read/daily: produtos distintos e
  // topProduto respeitam cada MLB real do pedido multi-item, nunca o
  // "primeiro produto" absorvendo o pedido inteiro. ──
  {
    const imp = importRow({ id: 1, competencia: "2026-08", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z" });
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "DIAMULTI", data: "2026-08-10", faturamento: 300, quantidadeItens: 3 }),
    ];
    const itens = [
      itemRow({ id: 1, pedidoRowId: 1, itemId: "DA", mlb: "MLB_A", pedidoId: "DIAMULTI", quantidade: 1, receitaProduto: 100 }),
      itemRow({ id: 2, pedidoRowId: 1, itemId: "DB", mlb: "MLB_B", pedidoId: "DIAMULTI", quantidade: 2, receitaProduto: 200 }),
    ];
    const db = makeDb({ imports: [imp], pedidos, itens });
    const resp = await svcFor(db).getCentralVendasReadDaily(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    const dia = resp.dias.find((d) => d.data === "2026-08-10");
    eq("F4 (Caso E): produtos distintos do dia = 2 (MLB_A e MLB_B), nunca 1", dia.produtos, 2);
    eq("F4 (Caso F): topProduto = MLB_B (200), nunca MLB_A com o total do pedido (300)", dia.topProduto?.mlb, "MLB_B");
    eq("F4 (Caso F): topProduto.faturamento = só a receita do próprio item (200), nunca 300", dia.topProduto?.faturamento, 200);
    console.log("  ✓ F4. /read/daily: produtos distintos e topProduto por item, nunca pelo mlb representante do pedido");
  }

  // ── G. Conta A nunca vê agregados (daily/products) da conta B ──
  {
    const contas = [
      { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", slug: "a1", external_account_id: "111", is_primary: true, ativo: true },
      { id: 11, cliente_id: 1, marketplace: "meli", nome: "ML 2", slug: "a2", external_account_id: "222", is_primary: false, ativo: true },
    ];
    const impA = importRow({ id: 1, competencia: "2026-08", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z", contaId: 10 });
    const impB = importRow({ id: 2, competencia: "2026-08", coverageFrom: "2026-08-01", coverageTo: "2026-08-31", publishedAt: "2026-08-01T10:00:00Z", contaId: 11 });
    const pedidos = [
      pedidoRow({ id: 1, importId: 1, pedidoId: "DA_CONTA_A", data: "2026-08-05", faturamento: 10 }),
      pedidoRow({ id: 2, importId: 2, pedidoId: "DA_CONTA_B", data: "2026-08-05", faturamento: 999 }),
    ];
    const db = makeDb({ contas, imports: [impA, impB], pedidos });
    const svc = svcFor(db);
    const dailyA = await svc.getCentralVendasReadDaily(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", clienteContaId: 10 });
    const productsA = await svc.getCentralVendasReadProducts(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31", clienteContaId: 10 });
    eq("G: daily da conta A não inclui faturamento da conta B", dailyA.dias[0].faturamento, 10);
    eq("G: products da conta A não inclui pedido da conta B", productsA.totalFaturamento, 10);
    console.log("  ✓ G. account-aware: /read/daily e /read/products nunca misturam conta A com conta B");
  }

  console.log(`centralVendasM9ReadAggregates.test.js: ${checks} verificacoes OK`);
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
