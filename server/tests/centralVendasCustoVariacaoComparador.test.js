// server/tests/centralVendasCustoVariacaoComparador.test.js
//
// Lacuna L1: comparação da resolução de custo da Central (só MLB, primeiro
// vence) com a do Financeiro/Sentinel (model_id > SKU > MLB, ambiguidade
// acusada). Só mede; não muda o motor.
const test = require("node:test");
const assert = require("node:assert/strict");
const { compararResolucaoCusto } = require("../services/centralVendas/centralVendasCustoVariacaoComparador");

const row = (produto_id, custo, { model = "", sku = "", imposto = 6 } = {}) => ({ produto_id, custo_produto: custo, imposto_percentual: imposto, id_model: model, sku });
const it = (id, { variacao = null, sku = null, q = 1 } = {}) => ({ item: { id, variation_id: variacao, seller_sku: sku }, quantity: q });

test("MLB com um custo só: igual nas duas regras", () => {
  const r = compararResolucaoCusto({ custosRows: [row("MLB1", 10)], orders: [{ id: 1, order_items: [it("MLB1")] }] });
  assert.equal(r.itens[0].situacao, "igual");
  assert.equal(r.resumo.itensAfetados, 0);
});

test("variações com custos diferentes resolvidas por model_id: a Central usa o primeiro custo do MLB", () => {
  const custosRows = [row("MLB2", 30, { model: "111" }), row("MLB2", 45, { model: "222" })];
  const r = compararResolucaoCusto({ custosRows, orders: [{ id: 2, order_items: [it("MLB2", { variacao: 222, q: 2 })] }, { id: 3, order_items: [it("MLB2", { variacao: 111 })] }] });
  assert.deepEqual(r.itens.map((i) => [i.situacao, i.centralCustoUnitCentavos, i.financeiroCustoUnitCentavos, i.financeiroOrigem, i.deltaCmvCentavos]), [
    ["diferente", 3000, 4500, "model_id", 3000],
    ["igual", 3000, 3000, "model_id", 0],
  ]);
  assert.equal(r.resumo.pedidosAfetados, 1);
  assert.equal(r.resumo.deltaCmvCentavos, 3000, "a regra do Financeiro aumentaria o CMV em R$ 30,00");
  assert.equal(r.resumo.conflitosNaBase, 1);
});

test("variações por SKU", () => {
  const custosRows = [row("MLB3", 20, { sku: "AZUL" }), row("MLB3", 25, { sku: "VERDE" })];
  const r = compararResolucaoCusto({ custosRows, orders: [{ id: 4, order_items: [it("MLB3", { sku: "VERDE" })] }] });
  assert.equal(r.itens[0].situacao, "diferente");
  assert.equal(r.itens[0].financeiroOrigem, "sku");
  assert.equal(r.itens[0].deltaCmvCentavos, 500);
});

test("custos diferentes sem chave de variação: o Financeiro acusa ambiguidade, a Central escolhe um", () => {
  const custosRows = [row("MLB4", 20), row("MLB4", 25)];
  const r = compararResolucaoCusto({ custosRows, orders: [{ id: 5, order_items: [it("MLB4")] }] });
  assert.equal(r.itens[0].financeiroEstado, "custo_ambiguo");
  assert.equal(r.itens[0].situacao, "central_escolheu_custo_ambiguo");
  assert.equal(r.itens[0].centralCustoUnitCentavos, 2000);
  assert.equal(r.itens[0].deltaCmvCentavos, null, "sem custo definido não há delta (nunca zero)");
});

test("sem custo nas duas: não conta como afetado", () => {
  const r = compararResolucaoCusto({ custosRows: [], orders: [{ id: 6, order_items: [it("MLB9")] }] });
  assert.equal(r.itens[0].situacao, "ambos_sem_custo");
  assert.equal(r.resumo.itensAfetados, 0);
});
