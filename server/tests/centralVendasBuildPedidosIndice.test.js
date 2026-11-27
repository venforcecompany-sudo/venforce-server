// server/tests/centralVendasBuildPedidosIndice.test.js
//
// buildPedidos indexado por linha (entrega 1 da evolução do motor): o
// resultado precisa ser IDÊNTICO ao caminho antigo (filtrar a lista inteira
// por pedido), inclusive nos casos de borda da regra `mesmaLinha`:
//   · linha com pedido_row_id → casa só pelo row id (mesmo pedido_id em 2 imports);
//   · linha SEM row id → casa pelo pedido_id (payload legado / snapshot manual);
//   · pedido SEM row id → casa todas as linhas com o mesmo pedido_id;
//   · ids numéricos × texto (comparação de row id é por String, a de pedido_id é estrita);
//   · ordem original preservada quando as duas listas se misturam.
// Mede também o ganho em 3.000 pedidos.

const assert = require("node:assert/strict");
const service = require("../services/centralVendas/centralVendasService");

let passou = 0;
function teste(nome, fn) {
  fn();
  passou += 1;
  console.log(`ok - ${nome}`);
}

function caminhoAntigo(snapshot) {
  const itens = snapshot.itens || [];
  const componentes = snapshot.componentes || [];
  return (snapshot.pedidos || []).map((p) => service.buildPedidoContrato(p, itens, componentes));
}

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

const TIPOS = ["receita_produto", "tarifa_venda", "custo_produto", "imposto_interno", "frete_seller", "receita_envio", "cancelamento_reembolso"];

function gerar({ pedidos: n, seed, bordas }) {
  const r = rng(seed);
  const pedidos = [];
  const itens = [];
  const componentes = [];
  for (let k = 0; k < n; k += 1) {
    // pedido_id repetido entre "imports" (row ids distintos) em ~10%
    const pedidoId = bordas && r() < 0.1 && k > 0 ? pedidos[Math.floor(r() * k)].pedido_id : `200000${k}`;
    const semRowPedido = bordas && r() < 0.05;
    const rowId = semRowPedido ? null : (r() < 0.5 ? 1000 + k : String(1000 + k));
    pedidos.push({
      id: rowId, pedido_id: pedidoId, data_pedido: "2026-11-10", status: "paid",
      faturamento: 100, quantidade_itens: 1, confianca: "confiavel", pendencias_json: [], payload_json: {},
    });
    const nItens = 1 + Math.floor(r() * 3);
    for (let j = 0; j < nItens; j += 1) {
      const semRow = bordas && r() < 0.08;
      const itemId = `${pedidoId}-${k}-${j}`;
      itens.push({
        pedido_row_id: semRow ? null : (rowId === null ? 1000 + k : (r() < 0.5 ? Number(rowId) : String(rowId))),
        pedido_id: pedidoId, item_id: itemId, mlb: `MLB${k % 50}`, sku: `S${j}`, titulo: "Produto",
        quantidade: 1, valor_unitario: 50, receita_produto: 50, custo_produto: 20, imposto_interno: 5, resultado: 10,
      });
      for (const tipo of TIPOS) {
        if (r() < 0.2) continue;
        componentes.push({
          pedido_row_id: semRow ? undefined : (rowId === null ? 1000 + k : rowId),
          pedido_id: pedidoId, item_id: tipo === "receita_envio" ? null : itemId,
          tipo, valor: Math.round(r() * 10000) / 100, fonte: "orders_api", confianca: "real", obs: null,
        });
      }
    }
  }
  // embaralha componentes para a ordem original não coincidir com a dos pedidos
  for (let i = componentes.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [componentes[i], componentes[j]] = [componentes[j], componentes[i]];
  }
  return { pedidos, itens, componentes };
}

teste("idêntico ao caminho antigo com bordas (row id ausente, pedido_id repetido, tipos mistos)", () => {
  for (const seed of [1, 7, 42, 99, 2026]) {
    const snap = gerar({ pedidos: 400, seed, bordas: true });
    assert.deepEqual(service.buildPedidos(snap), caminhoAntigo(snap));
  }
});

teste("idêntico ao caminho antigo sem bordas", () => {
  const snap = gerar({ pedidos: 300, seed: 5, bordas: false });
  assert.deepEqual(service.buildPedidos(snap), caminhoAntigo(snap));
});

teste("pedido_id numérico × texto não casa pelo fallback (comparação estrita preservada)", () => {
  const snap = {
    pedidos: [{ id: null, pedido_id: 123, status: "paid", payload_json: {} }],
    itens: [{ pedido_id: "123", item_id: "a" }, { pedido_id: 123, item_id: "b" }],
    componentes: [],
  };
  const [p] = service.buildPedidos(snap);
  assert.deepEqual(p.itens.map((i) => i.itemId), ["b"]);
  assert.deepEqual(service.buildPedidos(snap), caminhoAntigo(snap));
});

teste("ordem original quando linhas com e sem row id se intercalam", () => {
  const snap = {
    pedidos: [{ id: 9, pedido_id: "P", status: "paid", payload_json: {} }],
    itens: [
      { pedido_row_id: null, pedido_id: "P", item_id: "1" },
      { pedido_row_id: 9, pedido_id: "P", item_id: "2" },
      { pedido_row_id: null, pedido_id: "P", item_id: "3" },
      { pedido_row_id: "9", pedido_id: "X", item_id: "4" },
      { pedido_row_id: 8, pedido_id: "P", item_id: "5" },
    ],
    componentes: [],
  };
  const [p] = service.buildPedidos(snap);
  assert.deepEqual(p.itens.map((i) => i.itemId), ["1", "2", "3", "4"]);
  assert.deepEqual(service.buildPedidos(snap), caminhoAntigo(snap));
});

teste("3.000 pedidos: mesmo resultado e ganho medido", () => {
  const snap = gerar({ pedidos: 3000, seed: 11, bordas: false });
  let t = process.hrtime.bigint();
  const antigo = caminhoAntigo(snap);
  const msAntigo = Number(process.hrtime.bigint() - t) / 1e6;
  t = process.hrtime.bigint();
  const novo = service.buildPedidos(snap);
  const msNovo = Number(process.hrtime.bigint() - t) / 1e6;
  assert.deepEqual(novo, antigo);
  console.log(`# buildPedidos 3000 pedidos / ${snap.componentes.length} componentes: antigo ${msAntigo.toFixed(0)} ms → indexado ${msNovo.toFixed(0)} ms`);
  assert.ok(msNovo < msAntigo, "o caminho indexado deve ser mais rápido");
});

console.log(`# ${passou} testes ok`);
