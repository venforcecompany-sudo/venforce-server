// server/services/fechamentoFinanceiro/shopeePerformanceService.js
// MOTOR ESTIMADO da Shopee (planilha de performance por produto/variação).
//
// A planilha de performance NÃO tem repasse, frete nem taxas reais: as tarifas
// são estimadas por faixa de ticket. Por isso este motor é sempre marcado como
// "estimated_performance" e nunca deve ser apresentado como fechamento
// financeiro definitivo. O motor real vive em shopeeOrderAllService.js.
//
// processShopee() continua sendo a porta de entrada e despacha para o motor
// financeiro quando a planilha enviada é a de pedidos.

const XLSX = require("xlsx");
const { toNumber, round2 } = require("../../utils/numberUtils");
const {
  normalizeText,
  normalizeKey,
  normalizeMatchKey,
  normalizeShopeeId,
  findField,
  normalizeIdNoPrefix,
} = require("../../utils/textUtils");
const { createBadRequestError } = require("../../utils/excelUtils");
const {
  isShopeeFinancialOrderSheet,
  classifyShopeeOrderStatus,
  processShopeeFinancialOrders,
} = require("./shopeeOrderAllService");
const {
  buildCoverage,
  computeTacos,
  computeTacox,
  legacyRatio,
  safeRatio,
} = require("../../utils/fechamento/financeiroShared");

function getShopeeFeesByTicket(avgTicket) {
  if (avgTicket <= 79.99) return { commissionPercent: 20, fixedFeePerUnit: 4 };
  if (avgTicket <= 99.99) return { commissionPercent: 14, fixedFeePerUnit: 16 };
  if (avgTicket <= 199.99) return { commissionPercent: 14, fixedFeePerUnit: 20 };
  return { commissionPercent: 14, fixedFeePerUnit: 26 };
}



function parseShopeeSalesRows(rows) {
  const groups = new Map();

  for (const row of rows) {
    const itemId = normalizeIdNoPrefix(
      findField(row, ["id do item", "item id", "id do produto", "product id"])
    );

    if (!itemId) continue;

    if (!groups.has(itemId)) groups.set(itemId, []);
    groups.get(itemId).push(row);
  }

  const parsed = [];

  for (const [itemId, groupRows] of groups.entries()) {
    const variationRows = groupRows.filter((row) => {
      const variationId = normalizeIdNoPrefix(
        findField(row, ["id da variacao", "id da variação", "variation id"])
      );

      const revenue = toNumber(
        findField(row, [
          "vendas (pedido pago) (brl)",
          "Vendas (Pedido pago) (BRL)",
          "vendas (pedido pago)",
          "pedido pago (brl)",
        ])
      );

      const paidUnits = toNumber(
        findField(row, [
          "unidades (pedido pago)",
          "Unidades (Pedido pago)",
          "unidades pagas",
          "paid units",
        ])
      );

const impressionsRaw = findField(row, [
  "impressao do produto",
  "impressão do produto",
  "impressoes do produto",
  "impressões do produto",
]);

const impressions = toNumber(impressionsRaw);

const raw = String(impressionsRaw || "").trim();

const isZeroImpressions =
  impressions === 0 ||
  raw === "-" ||
  raw === "–" ||
  raw === "";

      return !!variationId && !isNaN(Number(variationId)) && isZeroImpressions;
    });

    const rowsToUse = variationRows.length > 0 ? variationRows : groupRows;

    for (const row of rowsToUse) {
      const paidRevenue = toNumber(
        findField(row, [
          "vendas (pedido pago) (brl)",
          "Vendas (Pedido pago) (BRL)",
          "vendas (pedido pago)",
          "pedido pago (brl)",
        ])
      );

      const paidUnits = toNumber(
        findField(row, [
          "unidades (pedido pago)",
          "Unidades (Pedido pago)",
          "unidades pagas",
          "paid units",
        ])
      );

      const product = String(
        findField(row, ["produto", "nome do produto", "product name"]) || ""
      ).trim();

      const variationId = normalizeIdNoPrefix(
        findField(row, ["id da variacao", "id da variação", "variation id"])
      );

      const variationStatus = normalizeText(
        findField(row, ["status atual da variacao", "status atual da variação"])
      );

      const saleModelId = normalizeIdNoPrefix(
        findField(row, ["model id", "model_id", "modelid"])
      );

      const isVariation = variationRows.length > 0;
      const id = isVariation ? variationId : itemId;

      if (!id || paidRevenue <= 0 || paidUnits <= 0) continue;

      parsed.push({
        id,
        product,
        itemId,
        variationId,
        saleModelId,
        paidRevenue,
        paidUnits,
        isVariation,
        variationStatus,
      });
    }
  }

  return parsed;
}



function getNormalizedColumns(rows) {
  const first = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  if (!first || typeof first !== "object") return [];
  return Object.keys(first).map((k) => normalizeKey(k));
}



function hasAnyColumn(columns, candidates) {
  return candidates.some((candidate) =>
    columns.some((col) => col.includes(normalizeKey(candidate)))
  );
}



function isShopeeMassUpdateSheet(rows) {
  const cols = getNormalizedColumns(rows);
  if (!cols.length) return false;

  // Proteção: se for claramente planilha de pedidos, nunca classificar como mass update.
  const hasOrderId = hasAnyColumn(cols, ["id do pedido", "order id", "pedido id"]);
  const hasOrderStatus = hasAnyColumn(cols, ["status do pedido"]);
  if (hasOrderId && hasOrderStatus) return false;

  // Sinais fortes e específicos de mass update (evita falso positivo por colunas genéricas).
  const strongMarkers = [
    "et_title_product_id",
    "et_title_product_name",
    "et_title_variation_id",
    "et_title_variation_price",
    "et_title_variation_stock",
    "ps_gtin_code",
    "motivo da falha",
    "gtin (ean)",
    "variante identificador",
    "sku de referencia",
    "estoque",
  ];

  const markerHits = strongMarkers.filter((marker) =>
    cols.some((col) => col === normalizeKey(marker) || col.includes(normalizeKey(marker)))
  ).length;

  return markerHits >= 3;
}



function isShopeePerformanceSheet(rows) {
  const cols = getNormalizedColumns(rows);
  if (!cols.length) return false;

  const requiredSignals = [
    ["id do item", "item id"],
    ["produto", "nome do produto", "product"],
    ["vendas (pedido pago) (brl)", "vendas (pedido pago)"],
    ["unidades (pedido pago)"],
    ["impressao do produto", "impressão do produto"],
    ["cliques por produto", "clicks por produto"],
    ["ctr"],
  ];

  return requiredSignals.every((group) => hasAnyColumn(cols, group));
}
// Classificação de status vive em shopeeOrderAllService (fonte única).
const _classifyOrderAllRow = classifyShopeeOrderStatus;

function parseShopeeOrderAllForStatus(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const parsed = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object") continue;

    const status = String(
      findField(row, ["status do pedido", "status pedido"]) || ""
    ).trim();
    if (!status) continue;

    const statusNorm = normalizeText(status);

    const cancelarMotivo = String(
      findField(row, [
        "cancelar motivo", "motivo cancelamento", "motivo do cancelamento",
        "motivo cancelar", "cancel reason",
      ]) || ""
    ).trim();
    const motivoNorm = normalizeText(cancelarMotivo);

    const statusDevolucao = String(
      findField(row, [
        "status da devolucao / reembolso",
        "status da devolução / reembolso",
        "status devolucao reembolso",
        "status devolução reembolso",
        "status da devolucao",
        "status devolucao",
        "devolucao reembolso",
        "return refund status",
      ]) || ""
    ).trim();
    const devolucaoNorm = normalizeText(statusDevolucao);

    const kind = _classifyOrderAllRow(statusNorm, motivoNorm, devolucaoNorm);

    const skuPrincipal = String(
      findField(row, [
        "no de referencia do sku principal",
        "n. de referencia do sku principal",
        "nº de referência do sku principal",
        "sku principal",
      ]) || ""
    ).trim();

    const skuRef = String(
      findField(row, [
        "numero de referencia sku",
        "número de referência sku",
        "n. de referencia sku",
        "sku",
      ]) || ""
    ).trim();

    const subtotal = toNumber(
      findField(row, ["subtotal do produto", "subtotal produto", "subtotal"])
    );

    const productName = String(
      findField(row, ["nome do produto", "nome produto", "produto"]) || ""
    ).trim();

    const orderId = String(
      findField(row, ["id do pedido", "id pedido"]) || ""
    ).trim();

    parsed.push({
      orderId,
      status,
      cancelarMotivo,
      statusDevolucao,
      kind,
      skuPrincipal: normalizeShopeeId(skuPrincipal),
      skuRef: normalizeShopeeId(skuRef),
      productName,
      subtotal,
    });
  }
  return parsed;
}



function buildShopeePerfSkuBridge(rows) {
  const bridge = new Map();
  if (!Array.isArray(rows)) return bridge;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;

    const idItem = String(
      findField(row, ["id do item", "id item", "item id"]) || ""
    ).trim();
    const idVariacao = String(
      findField(row, ["id da variacao", "id da variação", "id variacao"]) || ""
    ).trim();

    const skuVar = normalizeShopeeId(
      String(findField(row, ["sku da variacao", "sku da variação"]) || "")
    );
    const skuPri = normalizeShopeeId(
      String(findField(row, ["sku principle", "sku principal"]) || "")
    );

    const ids = {
      idItem: normalizeShopeeId(idItem),
      idVariacao: normalizeShopeeId(idVariacao),
    };

    if (skuVar && !bridge.has(skuVar)) bridge.set(skuVar, ids);
    if (skuPri && !bridge.has(skuPri)) bridge.set(skuPri, ids);
  }
  return bridge;
}



// Ponte de custo por REGISTRO DE VARIAÇÃO. O Map por SKU é mantido para
// compatibilidade/diagnóstico, mas a identidade preservada em `bridge.records`
// contém os campos que permitem distinguir a linha vendida sem depender da
// estabilidade textual do SKU.
//
// A ponte carrega SOMENTE identidade. Nenhum número financeiro da performance
// (vendas, unidades, ticket, comissão estimada) é lido aqui.
function buildShopeeCostBridge(performanceRowsRaw) {
  // Compatibilidade: o próprio Map retornado representa SOMENTE o índice de
  // SKU da Variação. SKU Principle vive em outro índice e nunca adiciona
  // variações aos candidatos deste Map.
  const variationSkuIndex = new Map();
  const principalSkuIndex = new Map();
  const bridge = variationSkuIndex;
  const records = [];
  for (const [property, value] of [
    ["records", records],
    ["variationSkuIndex", variationSkuIndex],
    ["principalSkuIndex", principalSkuIndex],
  ]) {
    Object.defineProperty(bridge, property, {
      value,
      enumerable: false,
      writable: false,
    });
  }
  if (!Array.isArray(performanceRowsRaw)) return bridge;

  // A performance usa "-" para "não se aplica" (item sem variação). Isso não é
  // identidade: não pode virar chave nem candidato de custo.
  const PLACEHOLDERS = new Set(["-", "--", "–", "N/A", "NA", "0"]);
  const identity = (value) => {
    const normalized = normalizeShopeeId(value);
    return PLACEHOLDERS.has(normalized) ? "" : normalized;
  };

  for (const row of performanceRowsRaw) {
    if (!row || typeof row !== "object") continue;

    const itemId = findField(row, ["id do item", "id item", "item id"]);
    const variationId = findField(row, [
      "id da variacao",
      "id da variação",
      "id variacao",
      "variation id",
    ]);
    const modelIdRaw = findField(row, ["model id", "model_id", "modelid"]);
    const productName = String(
      findField(row, ["produto", "nome do produto", "product name"]) || ""
    ).trim();
    const variationName = String(
      findField(row, [
        "nome da variacao",
        "nome da variação",
        "opcao da variacao",
        "opção da variação",
        "variation name",
        "variation option",
      ]) || ""
    ).trim();

    // SKU é TEXTO: normalizeShopeeId preserva zeros à esquerda ("0007654352998"
    // continua "0007654352998"); Number() jamais é usado aqui.
    const variationSkus = [
      findField(row, ["sku da variacao", "sku da variação"]),
    ].map(identity).filter(Boolean);
    const principalSkus = [
      findField(row, ["sku principle", "sku principal"]),
    ].map(identity).filter(Boolean);

    const normalizedVariationId = identity(variationId);
    const record = {
      itemId: identity(itemId),
      variationId: normalizedVariationId,
      // Na exportação real, "ID da Variação" corresponde ao "model id" da
      // base. Quando a Performance trouxer Model ID explicitamente, ele vence.
      modelId: identity(modelIdRaw) || normalizedVariationId,
      productName,
      variationName,
      variationSkus,
      principalSkus,
    };

    if (!record.modelId && !record.itemId) continue;
    records.push(record);

    const addToIndex = (index, sku) => {
      if (!index.has(sku)) {
        index.set(sku, { sku, records: [], variationIds: [], itemIds: [] });
      }
      const entry = index.get(sku);
      entry.records.push(record);
      if (record.modelId && !entry.variationIds.includes(record.modelId)) {
        entry.variationIds.push(record.modelId);
      }
      if (record.itemId && !entry.itemIds.includes(record.itemId)) {
        entry.itemIds.push(record.itemId);
      }
    };

    for (const sku of variationSkus) addToIndex(variationSkuIndex, sku);
    for (const sku of principalSkus) addToIndex(principalSkuIndex, sku);
  }

  return bridge;
}



function buildOrderAllTopCancelledItems(orderAllItems) {
  const map = new Map();
  // Item entra quando o PEDIDO é cancelado confirmado, não a linha isolada.
  const cancelledItems = groupShopeeOrders(orderAllItems)
    .filter((order) => order.kind === "cancelledConfirmed")
    .flatMap((order) => order.items);

  for (const item of cancelledItems) {
    const name = String(item.productName || "").trim() || "Produto sem identificação";
    const entry = map.get(name) || { productName: name, revenue: 0, count: 0 };
    entry.count += 1;
    entry.revenue += Number(item.subtotal || 0);
    map.set(name, entry);
  }
  return Array.from(map.values())
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5)
    .map((e) => ({ productName: e.productName, revenue: round2(e.revenue), count: e.count }));
}



// Severidade do status quando um pedido tem várias linhas de item: uma
// devolução em qualquer linha marca o pedido inteiro.
const ORDER_KIND_PRIORITY = [
  "cancelledConfirmed",
  "returnOrRefund",
  "unpaid",
  "intermediate",
  "shipped",
  "delivered",
  "completed",
  "other",
];

// Agrupa as linhas do Order.all por ID do pedido. Um pedido com três produtos
// continua sendo UM pedido: a contagem nunca pode virar 3.
function groupShopeeOrders(orderAllItems) {
  const orders = new Map();

  for (const item of Array.isArray(orderAllItems) ? orderAllItems : []) {
    const key = String(item.orderId || "").trim() || `SEM_PEDIDO:${orders.size}`;
    if (!orders.has(key)) {
      orders.set(key, { orderId: key, items: [], revenue: 0, kind: "other" });
    }
    const order = orders.get(key);
    order.items.push(item);
    order.revenue = round2(order.revenue + Number(item.subtotal || 0));
  }

  for (const order of orders.values()) {
    order.kind =
      ORDER_KIND_PRIORITY.find((kind) =>
        order.items.some((item) => item.kind === kind)
      ) || "other";
  }

  return Array.from(orders.values());
}

function buildShopeeStatusSummary(orderAllItems, perfBridge, costMap) {
  const result = {
    // Campos legados — mantidos para compatibilidade com frontend e relatório público.
    // Agora mapeados a partir das subcategorias corretas (ver ao final da função).
    cancelledCount: 0,
    cancelledLostRevenue: 0,
    unpaidCount: 0,
    unpaidLostRevenue: 0,
    unmatchedCancelled: [],
    orderAllTopCancelledItems: [],

    // Visão operacional detalhada do Order.all
    orderAllTotalCount: 0,
    orderAllTotalRevenue: 0,
    orderAllCompletedCount: 0,
    orderAllCompletedRevenue: 0,
    orderAllDeliveredCount: 0,
    orderAllDeliveredRevenue: 0,
    orderAllShippedCount: 0,
    orderAllShippedRevenue: 0,
    orderAllIntermediateCount: 0,
    orderAllIntermediateRevenue: 0,
    orderAllCancelledConfirmedCount: 0,
    orderAllCancelledConfirmedRevenue: 0,
    orderAllReturnRefundCount: 0,
    orderAllReturnRefundRevenue: 0,
    orderAllUnpaidCount: 0,
    orderAllUnpaidRevenue: 0,
  };
  if (!Array.isArray(orderAllItems)) return result;

  // Contagem POR PEDIDO; faturamento somado POR ITEM.
  for (const order of groupShopeeOrders(orderAllItems)) {
    const subtotal = order.revenue;
    result.orderAllTotalCount += 1;
    result.orderAllTotalRevenue += subtotal;

    switch (order.kind) {
      case "completed":
        result.orderAllCompletedCount += 1;
        result.orderAllCompletedRevenue += subtotal;
        break;
      case "delivered":
        result.orderAllDeliveredCount += 1;
        result.orderAllDeliveredRevenue += subtotal;
        break;
      case "shipped":
        result.orderAllShippedCount += 1;
        result.orderAllShippedRevenue += subtotal;
        break;
      case "intermediate":
        result.orderAllIntermediateCount += 1;
        result.orderAllIntermediateRevenue += subtotal;
        break;
      case "returnOrRefund":
        result.orderAllReturnRefundCount += 1;
        result.orderAllReturnRefundRevenue += subtotal;
        break;
      case "unpaid":
        result.orderAllUnpaidCount += 1;
        result.orderAllUnpaidRevenue += subtotal;
        break;
      case "cancelledConfirmed":
        result.orderAllCancelledConfirmedCount += 1;
        result.orderAllCancelledConfirmedRevenue += subtotal;
        break;
      // "other" contabilizado no total mas sem subcategoria própria
    }

    // Unmatched: apenas cancelados confirmados (exclui não-pagos e devoluções)
    if (order.kind !== "cancelledConfirmed") continue;

    for (const item of order.items) {
      let matched = false;
      const tryKeys = [item.skuPrincipal, item.skuRef].filter(Boolean);
      for (const sku of tryKeys) {
        const ids = perfBridge.get(sku);
        if (ids) {
          if (
            (ids.idItem && costMap.has(ids.idItem)) ||
            (ids.idVariacao && costMap.has(ids.idVariacao))
          ) {
            matched = true;
            break;
          }
        }
      }
      if (!matched) {
        result.unmatchedCancelled.push({
          orderId: item.orderId,
          productName: item.productName,
          skuPrincipal: item.skuPrincipal,
          subtotal: Number(item.subtotal || 0),
        });
      }
    }
  }

  // Arredondar receitas
  result.orderAllTotalRevenue = round2(result.orderAllTotalRevenue);
  result.orderAllCompletedRevenue = round2(result.orderAllCompletedRevenue);
  result.orderAllDeliveredRevenue = round2(result.orderAllDeliveredRevenue);
  result.orderAllShippedRevenue = round2(result.orderAllShippedRevenue);
  result.orderAllIntermediateRevenue = round2(result.orderAllIntermediateRevenue);
  result.orderAllCancelledConfirmedRevenue = round2(result.orderAllCancelledConfirmedRevenue);
  result.orderAllReturnRefundRevenue = round2(result.orderAllReturnRefundRevenue);
  result.orderAllUnpaidRevenue = round2(result.orderAllUnpaidRevenue);

  // Mapeamento de compatibilidade: legados recebem os valores corretos
  result.cancelledCount = result.orderAllCancelledConfirmedCount;
  result.cancelledLostRevenue = result.orderAllCancelledConfirmedRevenue;
  result.unpaidCount = result.orderAllUnpaidCount;
  result.unpaidLostRevenue = result.orderAllUnpaidRevenue;

  // Top 5 produtos com maior faturamento perdido por cancelamento confirmado
  result.orderAllTopCancelledItems = buildOrderAllTopCancelledItems(orderAllItems);

  return result;
}



function parseCostRows(rows) {
  const parsed = [];

  for (const row of rows) {
    const itemIdRaw = findField(row, [
      "id",
      "id do item",
      "id do produto",
      "product id",
      "item id",
      "product_id",
      "item_id",
      "id do anuncio",
      "id do anúncio",
      "id anuncio",
      "id anúncio",
    ]);
    const modelIdRaw = findField(row, [
      "id model",
      "id da variacao",
      "id da variação",
      "id de variacao",
      "id de variação",
      "id da variacao do produto",
      "id da variação do produto",
      "id do modelo",
      "id do model",
      "model_id",
      "model id",
      "modelid",
      "variation_id",
      "variation id",
    ]);
    const skuRaw = findField(row, [
      "sku",
      "sku da variacao",
      "sku da variação",
      "sku principle",
      "sku principal",
      "seller sku",
      "sku do vendedor",
      "nº de referencia do sku principal",
      "no de referencia do sku principal",
      "numero de referencia sku",
      "número de referência sku",
      "codigo",
      "código",
      "codigo do produto",
      "codigo do item",
    ]);

    const id = normalizeShopeeId(itemIdRaw);
    const modelId = normalizeShopeeId(modelIdRaw);
    const skuKey = normalizeMatchKey(skuRaw);

    if (!id && !modelId && !skuKey) continue;

    const costFieldRaw = findField(row, [
      "preco custo",
      "preço custo",
      "custo",
      "custo produto",
      "custo do produto",
      "custo unitario",
      "custo unitário",
      "product cost",
    ]);
    const cost = toNumber(costFieldRaw);

    let taxPercent = toNumber(
      findField(row, [
        "imposto",
        "imposto percentual",
        "percentual imposto",
        "aliquota",
        "alíquota",
        "taxa imposto",
        "tax percent",
        "taxa",
      ])
    );

    if (taxPercent > 0 && taxPercent <= 1) {
      taxPercent = taxPercent * 100;
    }

    const keys = [];
    const pushKey = (value) => {
      const k = normalizeMatchKey(value);
      if (!k) return;
      if (!keys.includes(k)) keys.push(k);
      const compact = k.replace(/\s+/g, "");
      if (compact && !keys.includes(compact)) keys.push(compact);
    };
    pushKey(id);
    pushKey(modelId);
    pushKey(skuKey);
    pushKey(itemIdRaw);
    pushKey(modelIdRaw);
    pushKey(skuRaw);

    parsed.push({
      id,
      modelId,
      sku: skuKey,
      rawItemId: String(itemIdRaw ?? "").trim(),
      rawModelId: String(modelIdRaw ?? "").trim(),
      matchKeys: keys,
      cost,
      // Preserva o texto cru e se ele era numérico — diferencia "#N/A"
      // (preenchido, sem dígito → inválido) de vazio e de "0" (preenchido,
      // com dígito → válido, mesmo que zero). Só diagnóstico: `cost` acima
      // continua sendo o único valor usado no cálculo financeiro.
      rawCost: String(costFieldRaw ?? "").trim(),
      costValid: isShopeeCostValueValid(costFieldRaw),
      taxPercent,
    });
  }

  return parsed;
}

function isShopeeCostValueValid(rawValue) {
  const text = String(rawValue ?? "").trim();
  if (!text) return false;
  return /\d/.test(text);
}



function calculateShopeeItem(sale, costRow) {
  const averageTicket =
    sale.paidUnits > 0 ? sale.paidRevenue / sale.paidUnits : 0;

  if (averageTicket <= 0) {
    return {
      id: sale.id,
      modelId: costRow.modelId || null,
      product: sale.product,
      paidRevenue: sale.paidRevenue,
      paidUnits: sale.paidUnits,
      contributionProfit: 0,
      contributionMargin: 0,
      averageTicket: 0,
      contributionProfitUnit: 0,
      cost: costRow.cost,
      taxPercent: costRow.taxPercent,
      commissionPercent: 0,
      fixedFeePerUnit: 0,
    };
  }

  const shopeeFees = getShopeeFeesByTicket(averageTicket);

  const commissionValueUnit =
    averageTicket * (shopeeFees.commissionPercent / 100);

  const fixedFeeUnit = shopeeFees.fixedFeePerUnit;
  const taxUnit = averageTicket * (costRow.taxPercent / 100);
  const costUnit = costRow.cost;

  const contributionProfitUnit =
    averageTicket - commissionValueUnit - fixedFeeUnit - costUnit - taxUnit;

  const contributionMargin =
    averageTicket > 0 ? contributionProfitUnit / averageTicket : 0;

  const contributionProfit = contributionProfitUnit * sale.paidUnits;

  return {
    id: sale.id,
    modelId: costRow.modelId || null,
    product: sale.product,
    paidRevenue: sale.paidRevenue,
    paidUnits: sale.paidUnits,
    contributionProfit,
    contributionMargin,
    averageTicket,
    contributionProfitUnit,
    cost: costRow.cost,
    taxPercent: costRow.taxPercent,
    commissionPercent: shopeeFees.commissionPercent,
    fixedFeePerUnit: shopeeFees.fixedFeePerUnit,
  };
}



function buildShopeeCostMap(costRowsRaw) {
  const costRows = parseCostRows(costRowsRaw);
  if (!costRows.length) {
    throw createBadRequestError("Não consegui identificar linhas válidas na planilha de custos.");
  }

  const costMap = new Map();
  for (const row of costRows) {
    const keys = Array.isArray(row.matchKeys) ? row.matchKeys : [];
    for (const key of keys) {
      const normalized = normalizeMatchKey(key);
      if (!normalized) continue;
      if (!costMap.has(normalized)) costMap.set(normalized, row);
    }
  }

  return costMap;
}

// debugCollector é opcional (só vem do Debug Financeiro). Sem ele, o
// resultado de processShopee() é IDÊNTICO ao anterior.
function processShopee(salesRowsRaw, costRowsRaw, ads, venforce, affiliates, ordersAllRowsRaw, debugCollector) {
  const detectedColumns =
    salesRowsRaw.length > 0 ? Object.keys(salesRowsRaw[0]) : [];
  const executiveNotes = [];
  const isFinancial = isShopeeFinancialOrderSheet(salesRowsRaw);
  const isPerformance = isShopeePerformanceSheet(salesRowsRaw);

  // O segundo upload (ordersAll) é classificado pelo CONTEÚDO, igual ao
  // primeiro: com performance + Order.all + custos, o financeiro vem do
  // Order.all e a performance entra só como ponte de identidade.
  const hasOrdersAllRows = Array.isArray(ordersAllRowsRaw) && ordersAllRowsRaw.length > 0;
  const ordersAllIsFinancial = hasOrdersAllRows && isShopeeFinancialOrderSheet(ordersAllRowsRaw);
  const ordersAllIsPerformance = hasOrdersAllRows && isShopeePerformanceSheet(ordersAllRowsRaw);

  // CASO A — as 3 planilhas: performance (identidade) + Order.all (financeiro)
  // + base de custos. Motor REAL com ponte de custo.
  if (isPerformance && !isFinancial && ordersAllIsFinancial) {
    return processShopeeFinancialOrders({
      salesRowsRaw: ordersAllRowsRaw,
      costMap: buildShopeeCostMap(costRowsRaw),
      costBridge: buildShopeeCostBridge(salesRowsRaw),
      ads,
      venforce,
      affiliates,
      debugCollector,
    });
  }

  // Planilha financeira de pedidos: motor REAL (repasse + taxas efetivas,
  // por pedido). Antes era rejeitada — o cruzamento com a base de custos usa
  // SKU/ID de variação, não só ID do item.
  // Se o segundo arquivo for a performance, ela vira a ponte de identidade.
  if (isFinancial && !isPerformance) {
    return processShopeeFinancialOrders({
      salesRowsRaw,
      costMap: buildShopeeCostMap(costRowsRaw),
      costBridge: ordersAllIsPerformance ? buildShopeeCostBridge(ordersAllRowsRaw) : null,
      ads,
      venforce,
      affiliates,
      debugCollector,
    });
  }

  if (!isPerformance) {
    const isMassUpdate = isShopeeMassUpdateSheet(salesRowsRaw);
    if (isMassUpdate) {
      throw createBadRequestError(
        "Planilha Shopee de atualização em massa não é suportada neste fechamento. Envie a planilha de performance por produto/variação ou o fechamento por pedido."
      );
    }
    throw createBadRequestError(
      `Formato de planilha Shopee não reconhecido. Colunas detectadas: ${detectedColumns.join(", ")}`
    );
  }

  const salesRows = parseShopeeSalesRows(salesRowsRaw);
  if (!salesRows.length) {
    throw createBadRequestError(
      `Planilha Shopee de performance reconhecida, mas não foi possível extrair linhas válidas de vendas pagas. Colunas detectadas: ${detectedColumns.join(", ")}`
    );
  }

  const costMap = buildShopeeCostMap(costRowsRaw);

  const unmatchedIdsSet = new Set();
  const excludedVariationIdsSet = new Set();
  const validItems = [];
  const detailedRows = [];
  let ignoredRevenue = 0;
  let revenueWithoutCost = 0;

  for (const sale of salesRows) {
    if (sale.isVariation && sale.variationStatus === "excluido") {
      excludedVariationIdsSet.add(sale.id);
    }

    // Mesma prioridade/short-circuit de sempre: saleModelId -> id -> itemId.
    // A instrumentação abaixo só registra; não muda qual costRow é escolhido.
    let costRow = null;
    for (const candidate of [
      { field: "saleModelId", value: sale.saleModelId },
      { field: "id", value: sale.id },
      { field: "itemId", value: sale.itemId },
    ]) {
      const key = normalizeMatchKey(candidate.value);
      if (!key) {
        if (debugCollector) {
          debugCollector.recordMatchAttempt({
            engine: "shopee_performance",
            stage: "cost_lookup",
            orderId: sale.id,
            field: candidate.field,
            rawValue: candidate.value ?? null,
            normalizedKey: null,
            result: "skip",
          });
        }
        continue;
      }
      const hit = costMap.get(key);
      if (debugCollector) {
        debugCollector.recordMatchAttempt({
          engine: "shopee_performance",
          stage: "cost_lookup",
          orderId: sale.id,
          field: candidate.field,
          rawValue: candidate.value,
          normalizedKey: key,
          result: hit ? "hit" : "miss",
        });
      }
      if (hit) {
        costRow = hit;
        break;
      }
    }

    // Sem custo: a receita CONTINUA no faturamento, apenas sem lucro calculável.
    if (!costRow || costRow.cost <= 0) {
      unmatchedIdsSet.add(sale.id);
      ignoredRevenue += sale.paidRevenue;
      revenueWithoutCost = round2(revenueWithoutCost + sale.paidRevenue);

      detailedRows.push({
        Marketplace: "Shopee",
        Produto: sale.product,
        ID: sale.id,
        "ID Model": "",
        "Vendas (Pedido pago) (BRL)": round2(sale.paidRevenue),
        "Unidades (Pedido pago)": Number(sale.paidUnits.toFixed(0)),
        Ticket: sale.paidUnits > 0 ? round2(sale.paidRevenue / sale.paidUnits) : 0,
        Custo: null,
        Imposto: null,
        "Comissão %": null,
        "Taxa Fixa": null,
        LC: null,
        MC: null,
        "LC POR ANÚNCIO": null,
        "Cobertura de custo": "sem custo",
      });
      continue;
    }

    const calculated = calculateShopeeItem(sale, costRow);
    validItems.push(calculated);

    detailedRows.push({
      Marketplace: "Shopee",
      Produto: calculated.product,
      ID: calculated.id,
      "ID Model": calculated.modelId || "",
      "Vendas (Pedido pago) (BRL)": Number(calculated.paidRevenue.toFixed(2)),
      "Unidades (Pedido pago)": Number(calculated.paidUnits.toFixed(0)),
      Ticket: Number(calculated.averageTicket.toFixed(2)),
      Custo: Number(calculated.cost.toFixed(2)),
      Imposto: Number(calculated.taxPercent.toFixed(2)),
      "Comissão %": Number(calculated.commissionPercent.toFixed(2)),
      "Taxa Fixa": Number(calculated.fixedFeePerUnit.toFixed(2)),
      LC: Number(calculated.contributionProfitUnit.toFixed(2)),
      MC: Number((calculated.contributionMargin * 100).toFixed(2)),
      "LC POR ANÚNCIO": Number(calculated.contributionProfit.toFixed(2)),
      "Cobertura de custo": "com custo",
    });
  }

  const revenueWithCost = round2(
    validItems.reduce((acc, item) => acc + item.paidRevenue, 0)
  );

  // Faturamento reconhecido = com custo + sem custo. A ausência de custo
  // nunca apaga faturamento.
  const paidRevenueTotal = round2(revenueWithCost + revenueWithoutCost);
  const contributionProfitTotal = round2(
    validItems.reduce((acc, item) => acc + item.contributionProfit, 0)
  );

  const coverage = buildCoverage({ revenueWithCost, revenueWithoutCost });

  // MC calculada sobre o faturamento COM CUSTO (parcela efetivamente calculada).
  const averageContributionMargin = legacyRatio(contributionProfitTotal, revenueWithCost);

  // TACoS/TACoX sobre o faturamento TOTAL; TACoX inclui afiliados.
  const tacos = computeTacos(ads, paidRevenueTotal);
  const tacox = computeTacox(ads, venforce, affiliates, paidRevenueTotal);
  const finalResult = round2(contributionProfitTotal - ads - venforce - affiliates);

  executiveNotes.push(
    "Estimativa por performance: taxas calculadas por faixa de tarifa, não por repasse financeiro real. Não é um fechamento financeiro definitivo."
  );
  executiveNotes.push(
    "Frete, devoluções e repasse real não disponíveis nesse modelo de planilha Shopee."
  );
  executiveNotes.push(
    "returnsTotal não disponível separado na planilha Shopee enviada."
  );
  executiveNotes.push("shippingFeesTotal não disponível separado na planilha Shopee enviada.");

  const marketplaceFeesBase = validItems.reduce((sum, item) => {
    const commissionUnit =
      Number(item.averageTicket || 0) * (Number(item.commissionPercent || 0) / 100);
    const fixedFeeUnit = Number(item.fixedFeePerUnit || 0);
    const units = Number(item.paidUnits || 0);
    return sum + (commissionUnit + fixedFeeUnit) * units;
  }, 0);
  const marketplaceFeesTotal = round2(
    marketplaceFeesBase > 0 ? -Math.abs(marketplaceFeesBase) : marketplaceFeesBase
  );
  const taxValueBase = validItems.reduce(
    (sum, item) =>
      sum + Number(item.paidRevenue || 0) * (Number(item.taxPercent || 0) / 100),
    0
  );
  const taxValueTotal = round2(taxValueBase > 0 ? -Math.abs(taxValueBase) : taxValueBase);
  const cmvBase = validItems.reduce(
    (sum, item) => sum + Number(item.cost || 0) * Number(item.paidUnits || 0),
    0
  );
  const cmvTotal = round2(cmvBase > 0 ? -Math.abs(cmvBase) : cmvBase);

  // Feature opcional: cruza Order.all com a base de custos para reconciliação
  // operacional. O cálculo principal (LC/MC/Resultado) NÃO usa Order.all.
  let shopeeStatusSummary = {
    cancelledCount: 0,
    cancelledLostRevenue: 0,
    unpaidCount: 0,
    unpaidLostRevenue: 0,
    unmatchedCancelled: [],
    orderAllTotalCount: 0,
    orderAllTotalRevenue: 0,
    orderAllCompletedCount: 0,
    orderAllCompletedRevenue: 0,
    orderAllDeliveredCount: 0,
    orderAllDeliveredRevenue: 0,
    orderAllShippedCount: 0,
    orderAllShippedRevenue: 0,
    orderAllIntermediateCount: 0,
    orderAllIntermediateRevenue: 0,
    orderAllCancelledConfirmedCount: 0,
    orderAllCancelledConfirmedRevenue: 0,
    orderAllReturnRefundCount: 0,
    orderAllReturnRefundRevenue: 0,
    orderAllUnpaidCount: 0,
    orderAllUnpaidRevenue: 0,
  };
  const hasOrderAll = Array.isArray(ordersAllRowsRaw) && ordersAllRowsRaw.length > 0;
  if (hasOrderAll) {
    const orderAllItems = parseShopeeOrderAllForStatus(ordersAllRowsRaw);
    if (orderAllItems.length > 0) {
      const perfBridge = buildShopeePerfSkuBridge(salesRowsRaw);
      shopeeStatusSummary = buildShopeeStatusSummary(
        orderAllItems,
        perfBridge,
        costMap
      );
    }
    executiveNotes.push(
      "Performance Shopee representa pedidos pagos e é a base do cálculo financeiro. " +
      "Order.all representa visão operacional completa e é usada apenas para reconciliação de status."
    );
  }

  if (coverage.financialConfidence !== "confiavel") {
    executiveNotes.push(
      "Fechamento parcial: existem vendas sem custo cadastrado. O faturamento total está completo; LC e MC cobrem apenas a receita com custo identificado."
    );
  }

  return {
    summary: {
      calculationMode: "estimated_performance",
      engine: "shopee_performance",
      grossRevenueTotal: paidRevenueTotal,
      revenueWithCost: coverage.revenueWithCost,
      revenueWithoutCost: coverage.revenueWithoutCost,
      calculatedCoveragePercent: coverage.calculatedCoveragePercent,
      financialConfidence: coverage.financialConfidence,
      contributionMarginCalculated: safeRatio(contributionProfitTotal, revenueWithCost),
      finalMarginCalculated: safeRatio(finalResult, revenueWithCost),
      // Devoluções/reembolsos vêm do Order.all quando enviado — não podem
      // ficar zerados quando o arquivo contém devoluções.
      refundsTotal: hasOrderAll
        ? round2(-shopeeStatusSummary.orderAllReturnRefundRevenue)
        : 0,
      refundsCount: shopeeStatusSummary.orderAllReturnRefundCount,
      cancelledRevenue: shopeeStatusSummary.orderAllCancelledConfirmedRevenue,
      lostRevenueTotal: shopeeStatusSummary.orderAllCancelledConfirmedRevenue,
      paidRevenueTotal,
      contributionProfitTotal,
      averageContributionMargin,
      finalResult,
      tacos,
      tacox,
      platformAdjustmentTotal: 0,
      platformAdjustmentRowsCount: 0,
      cancellationsTotal: round2(-shopeeStatusSummary.orderAllCancelledConfirmedRevenue),
      returnsTotal: hasOrderAll
        ? round2(-shopeeStatusSummary.orderAllReturnRefundRevenue)
        : null,
      marketplaceFeesTotal,
      shippingFeesTotal: null,
      discountsBonusesTotal: null,
      taxValueTotal,
      cmvTotal,
      adsTotal: round2(ads),
      venforceTotal: round2(venforce),
      affiliatesTotal: round2(affiliates),
      grossProfitTotal: round2(contributionProfitTotal),
      grossMargin: legacyRatio(contributionProfitTotal, revenueWithCost),
      executiveNotes,
      cancelledCount: shopeeStatusSummary.cancelledCount,
      cancelledLostRevenue: shopeeStatusSummary.cancelledLostRevenue,
      unpaidCount: shopeeStatusSummary.unpaidCount,
      unpaidLostRevenue: shopeeStatusSummary.unpaidLostRevenue,
      returnRefundCount: shopeeStatusSummary.orderAllReturnRefundCount,
      returnRefundRevenue: shopeeStatusSummary.orderAllReturnRefundRevenue,
      // Visão operacional detalhada — apenas quando Order.all foi enviado
      orderAllTotalCount: shopeeStatusSummary.orderAllTotalCount,
      orderAllTotalRevenue: shopeeStatusSummary.orderAllTotalRevenue,
      orderAllCompletedCount: shopeeStatusSummary.orderAllCompletedCount,
      orderAllCompletedRevenue: shopeeStatusSummary.orderAllCompletedRevenue,
      orderAllDeliveredCount: shopeeStatusSummary.orderAllDeliveredCount,
      orderAllDeliveredRevenue: shopeeStatusSummary.orderAllDeliveredRevenue,
      orderAllShippedCount: shopeeStatusSummary.orderAllShippedCount,
      orderAllShippedRevenue: shopeeStatusSummary.orderAllShippedRevenue,
      orderAllIntermediateCount: shopeeStatusSummary.orderAllIntermediateCount,
      orderAllIntermediateRevenue: shopeeStatusSummary.orderAllIntermediateRevenue,
      orderAllCancelledConfirmedCount: shopeeStatusSummary.orderAllCancelledConfirmedCount,
      orderAllCancelledConfirmedRevenue: shopeeStatusSummary.orderAllCancelledConfirmedRevenue,
      orderAllReturnRefundCount: shopeeStatusSummary.orderAllReturnRefundCount,
      orderAllReturnRefundRevenue: shopeeStatusSummary.orderAllReturnRefundRevenue,
      orderAllUnpaidCount: shopeeStatusSummary.orderAllUnpaidCount,
      orderAllUnpaidRevenue: shopeeStatusSummary.orderAllUnpaidRevenue,
      orderAllTopCancelledItems: shopeeStatusSummary.orderAllTopCancelledItems,
    },
    detailedRows,
    excelFileName: "fechamento-shopee.xlsx",
    unmatchedIds: Array.from(unmatchedIdsSet),
    excludedVariationIds: Array.from(excludedVariationIdsSet),
    ignoredRowsWithoutCost: unmatchedIdsSet.size,
    ignoredRevenue,
    unmatchedCancelled: shopeeStatusSummary.unmatchedCancelled,
    message:
      unmatchedIdsSet.size > 0
        ? "Estimativa por performance. Alguns IDs não possuem custo cadastrado: o faturamento foi preservado e o lucro cobre apenas a receita com custo."
        : "Estimativa por performance concluída com sucesso.",
  };
}



module.exports = {
  parseShopeeSalesRows,
  calculateShopeeItem,
  getShopeeFeesByTicket,
  isShopeePerformanceSheet,
  isShopeeMassUpdateSheet,
  parseShopeeOrderAllForStatus,
  buildShopeePerfSkuBridge,
  buildShopeeCostBridge,
  buildShopeeStatusSummary,
  groupShopeeOrders,
  buildShopeeCostMap,
  parseCostRows,
  processShopee,
};
