// Margem realizada × republicação de fechamento (frete de pack, PR #362).
//
// Prova, do repositório da Central até o agregado por MLB do Motor de Margem
// (resolveImportsForRange → loadRealizadoByImportIds → agregarPorMlb), que:
//   1. o import republicado (frete do pack rateado) SUBSTITUI o antigo (frete
//      cheio em cada pedido) — o realizado nunca soma as duas versões;
//   2. o frete realizado do pack é conservado (Σ pedidos == custo do shipment);
//   3. um published mais novo com cobertura PARCIAL não responde o mês inteiro
//      (cai no published antigo de cobertura completa) e responde só o trecho
//      que cobre;
//   4. um published de OUTRA conta nunca entra na leitura da conta.
// O banco é um fake em memória que só filtra — a escolha é do código real.

const assert = require("assert");
const cv = require("../services/motorMargem/adapters/centralVendasEvidenceAdapter");

const SLUG = "red-fish";
const CONTA = 41;

function imp(id, { conta = CONTA, publishedAt, from = "2026-09-01", to = "2026-09-30", status = "published" }) {
  return {
    id, cliente_slug: SLUG, marketplace: "meli", competencia: "2026-09", cliente_conta_id: conta,
    publication_status: status, published_at: publishedAt, coverage_date_from: from, coverage_date_to: to,
    created_at: publishedAt, updated_at: publishedAt, fonte: "orders_api", status: "processado",
    confianca: "confiavel", resumo_json: {}, payload_json: {}, sync_run_id: id * 10,
  };
}

// Pack S1 = pedidos A (receita 100) e B (receita 50), custo do shipment 30.
// Import 300 (antes do fix): 30 em CADA pedido (60). Import 400 (republicado): 20 + 10.
function montarBanco(imports) {
  const pedidos = [];
  const itens = [];
  const componentes = [];
  for (const i of imports) {
    const fretes = i.id === 400 ? [20, 10] : [30, 30];
    ["A", "B"].forEach((p, idx) => {
      const rowId = i.id * 100 + idx;
      const itemId = rowId * 10;
      const receita = idx === 0 ? 100 : 50;
      pedidos.push({ id: rowId, import_id: i.id, pedido_id: `${p}`, data_pedido: "2026-09-15", status: "paid" });
      itens.push({ id: itemId, pedido_row_id: rowId, pedido_id: p, mlb: "MLB1", sku: "SKU1", titulo: "Produto",
        quantidade: 1, valor_unitario: receita, receita_produto: receita, custo_produto: 10, imposto_interno: 5, resultado: null });
      componentes.push({ item_row_id: itemId, pedido_row_id: rowId, tipo: "frete_seller", valor: -fretes[idx] });
      componentes.push({ item_row_id: itemId, pedido_row_id: rowId, tipo: "tarifa_venda", valor: -receita * 0.1 });
    });
  }
  return {
    async query(sql, params) {
      if (/FROM central_vendas_imports/.test(sql) && /competencia BETWEEN \$3 AND \$4/.test(sql)) {
        const [slug, marketplace, de, ate, conta] = params;
        const exigeNull = /cliente_conta_id IS NULL/.test(sql) && !/OR cliente_conta_id IS NULL/.test(sql);
        const aceitaNull = /OR cliente_conta_id IS NULL/.test(sql);
        return {
          rows: imports.filter((r) => r.cliente_slug === slug && r.marketplace === marketplace
            && r.competencia >= de && r.competencia <= ate
            && ["published", "legacy"].includes(r.publication_status)
            && (exigeNull ? r.cliente_conta_id === null
              : (r.cliente_conta_id === conta || (aceitaNull && r.cliente_conta_id === null)))),
        };
      }
      if (/cv:realizado-pedidos/.test(sql)) {
        const [ids, de, ate] = params;
        return { rows: pedidos.filter((p) => ids.map(Number).includes(p.import_id) && p.data_pedido >= de && p.data_pedido <= ate) };
      }
      if (/cv:realizado-itens/.test(sql)) return { rows: itens.filter((i) => params[0].includes(i.pedido_row_id)) };
      if (/cv:realizado-componentes/.test(sql)) {
        return { rows: componentes.filter((c) => params[0].includes(c.pedido_row_id) && params[1].includes(c.tipo)) };
      }
      throw new Error(`query não esperada no fake: ${sql.slice(0, 80)}`);
    },
  };
}

async function realizado(imports, { dateFrom = "2026-09-01", dateTo = "2026-09-30", conta = CONTA } = {}) {
  const vendas = await cv.carregarVendasDoPeriodo(
    { clienteSlug: SLUG, dateFrom, dateTo, clienteContaId: conta }, montarBanco(imports));
  const { porMlb } = cv.agregarPorMlb({
    pedidosTodos: vendas.pedidosTodos, pedidosResultado: vendas.pedidos, itens: vendas.itens, componentes: vendas.componentes,
  });
  return { vendas, mlb: porMlb.get("MLB1") };
}

const cenarios = [];
function cenario(nome, fn) { cenarios.push([nome, fn]); }

cenario("republicado substitui o antigo e o frete do pack é conservado (30, não 60 nem 90)", async () => {
  const antigo = imp(300, { publishedAt: "2026-10-01T03:00:00Z" });
  const novo = imp(400, { publishedAt: "2026-10-29T12:00:00Z" });
  const { vendas, mlb } = await realizado([antigo, novo]);
  assert.deepStrictEqual(vendas.imports.map((i) => i.id), [400]);
  assert.strictEqual(vendas.pedidos.length, 2, "2 pedidos, nunca 4");
  assert.strictEqual(Math.abs(mlb.frete.soma), 30);
  assert.strictEqual(mlb.unidades, 2);
});

cenario("sem a republicação, o realizado mostra o frete duplicado (60) — é o dado histórico a reprocessar", async () => {
  const { mlb } = await realizado([imp(300, { publishedAt: "2026-10-01T03:00:00Z" })]);
  assert.strictEqual(Math.abs(mlb.frete.soma), 60);
});

cenario("ordem é published_at, não id: id maior publicado antes não vence", async () => {
  const novoId = imp(400, { publishedAt: "2026-10-01T03:00:00Z" });
  const antigoId = imp(300, { publishedAt: "2026-10-29T12:00:00Z" });
  const { vendas } = await realizado([novoId, antigoId]);
  assert.deepStrictEqual(vendas.imports.map((i) => i.id), [300]);
});

cenario("published mais novo com cobertura parcial não responde o mês inteiro", async () => {
  const completo = imp(300, { publishedAt: "2026-10-01T03:00:00Z" });
  const parcial = imp(400, { publishedAt: "2026-10-29T12:00:00Z", from: "2026-09-10", to: "2026-09-20" });
  const mes = await realizado([completo, parcial]);
  assert.deepStrictEqual(mes.vendas.imports.map((i) => i.id), [300]);
  const trecho = await realizado([completo, parcial], { dateFrom: "2026-09-12", dateTo: "2026-09-18" });
  assert.deepStrictEqual(trecho.vendas.imports.map((i) => i.id), [400]);
  assert.strictEqual(Math.abs(trecho.mlb.frete.soma), 30);
});

cenario("published de outra conta nunca entra na leitura da conta", async () => {
  const daConta = imp(300, { publishedAt: "2026-10-01T03:00:00Z" });
  const outraConta = imp(400, { conta: 42, publishedAt: "2026-10-29T12:00:00Z" });
  const { vendas, mlb } = await realizado([daConta, outraConta]);
  assert.deepStrictEqual(vendas.imports.map((i) => i.id), [300]);
  assert.strictEqual(Math.abs(mlb.frete.soma), 60);
});

cenario("candidate (ainda não publicado) não substitui o published", async () => {
  const pub = imp(300, { publishedAt: "2026-10-01T03:00:00Z" });
  const cand = imp(400, { publishedAt: "2026-10-29T12:00:00Z", status: "candidate" });
  const { vendas } = await realizado([pub, cand]);
  assert.deepStrictEqual(vendas.imports.map((i) => i.id), [300]);
});

(async () => {
  for (const [nome, fn] of cenarios) {
    await fn();
    console.log(`  ✓ ${nome}`);
  }
  console.log("margemRealizadaRepublicacaoFretePack.test.js passed");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
