// server/services/centralVendas/centralVendasCustoVariacaoComparador.js
//
// Lacuna L1 (doc 13): a Central resolve o custo SÓ por MLB (buildCostMap +
// getCost: o primeiro custo do MLB na ordem das linhas vence), enquanto o
// Financeiro e o Sentinel resolvem por variação — model_id, depois SKU, depois
// MLB — e acusam "custo ambíguo" quando o MLB tem custos diferentes sem chave
// de variação que os separe (meliFinanceiroService.buildMeliCostIndex via
// sentinelCusto).
//
// Este módulo NÃO troca nada no motor. Compara as duas resoluções sobre as
// MESMAS linhas da base e os MESMOS itens de pedido e diz, item a item e no
// total, quanto o CMV mudaria — a evidência que a decisão de trocar a regra
// exige (fórmula financeira não muda sem comparação e aprovação).

const { buildCostMap, getCost } = require("./centralVendasSyncService");
const { construirIndiceCusto, resolverCustoItem } = require("../sentinel/sentinelCusto");
const { normalizeId } = require("../../utils/textUtils");

const cent = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));

/**
 * @param {object} p
 *   custosRows  linhas de `custos` da base (produto_id, custo_produto, imposto_percentual, id_model, sku),
 *               na ordem em que a Central as leria
 *   orders      pedidos do ML (order_items[].item.{id, variation_id, seller_sku}, quantity)
 * @returns {{ itens, resumo }}
 */
function compararResolucaoCusto({ custosRows = [], orders = [] }) {
  const costMap = buildCostMap(custosRows);
  const indice = construirIndiceCusto(custosRows);
  const itens = [];
  for (const order of orders) {
    for (const oi of Array.isArray(order?.order_items) ? order.order_items : []) {
      const q = Number(oi?.quantity) || 0;
      const mlb = normalizeId(oi?.item?.id);
      const central = getCost(costMap, mlb);
      const centralCusto = central && central.hasCost ? cent(central.cost) : null;
      const fin = resolverCustoItem(indice, oi);
      const finCusto = fin.estado === "ok" ? cent(fin.cost) : null;
      let situacao;
      if (fin.estado === "custo_ambiguo") situacao = centralCusto === null ? "ambos_sem_custo_definido" : "central_escolheu_custo_ambiguo";
      else if (centralCusto === null && finCusto === null) situacao = "ambos_sem_custo";
      else if (centralCusto === null) situacao = "so_financeiro_tem_custo";
      else if (finCusto === null) situacao = "so_central_tem_custo";
      else situacao = centralCusto === finCusto ? "igual" : "diferente";
      const delta = centralCusto !== null && finCusto !== null ? (finCusto - centralCusto) * q : null;
      itens.push({
        pedidoId: order?.id != null ? String(order.id) : null,
        mlb,
        variacaoId: oi?.item?.variation_id != null ? String(oi.item.variation_id) : null,
        sku: oi?.item?.seller_sku || null,
        quantidade: q,
        centralCustoUnitCentavos: centralCusto,
        financeiroCustoUnitCentavos: finCusto,
        financeiroEstado: fin.estado,
        financeiroOrigem: fin.origem || null,
        situacao,
        deltaCmvCentavos: delta,
      });
    }
  }
  const por = {};
  for (const i of itens) por[i.situacao] = (por[i.situacao] || 0) + 1;
  const afetados = itens.filter((i) => i.situacao !== "igual" && i.situacao !== "ambos_sem_custo");
  return {
    itens,
    resumo: {
      itens: itens.length,
      porSituacao: por,
      itensAfetados: afetados.length,
      pedidosAfetados: new Set(afetados.map((i) => i.pedidoId)).size,
      // positivo = o CMV pela regra do Financeiro seria MAIOR (margem menor)
      deltaCmvCentavos: itens.reduce((s, i) => s + (i.deltaCmvCentavos || 0), 0),
      conflitosNaBase: indice.conflicts.length,
    },
  };
}

module.exports = { compararResolucaoCusto };
