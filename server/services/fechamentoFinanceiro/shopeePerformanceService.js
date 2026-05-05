// server/services/fechamentoFinanceiro/shopeePerformanceService.js
// Lógica de fechamento financeiro da Shopee (performance + cancelados via
// Order.all opcional). Branch Order.all para CÁLCULO PRINCIPAL continua
// pausada — só é usada para identificar cancelados/não pagos.
// Extraído de server/index.js sem alterações de comportamento.

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
const { isShopeeFinancialOrderSheet } = require("./shopeeOrderAllService");

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

    const statusLower = normalizeText(status);
    const isCancelled = statusLower === "cancelado";
    const isUnpaid = statusLower === "nao pago" || statusLower === "não pago";
    if (!isCancelled && !isUnpaid) continue;

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
      findField(row, [
        "subtotal do produto",
        "subtotal produto",
        "subtotal",
      ])
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
      kind: isCancelled ? "cancelled" : "unpaid",
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



function buildShopeeStatusSummary(orderAllItems, perfBridge, costMap) {
  const result = {
    cancelledCount: 0,
    cancelledLostRevenue: 0,
    unpaidCount: 0,
    unpaidLostRevenue: 0,
    unmatchedCancelled: [],
  };
  if (!Array.isArray(orderAllItems)) return result;

  for (const item of orderAllItems) {
    const subtotal = Number(item.subtotal || 0);

    if (item.kind === "cancelled") {
      result.cancelledCount += 1;
      result.cancelledLostRevenue += subtotal;
    } else if (item.kind === "unpaid") {
      result.unpaidCount += 1;
      result.unpaidLostRevenue += subtotal;
    }

    // Tentar match (só relevante para o painel de unmatched)
    let matched = false;
    const tryKeys = [item.skuPrincipal, item.skuRef].filter(Boolean);
    for (const sku of tryKeys) {
      const ids = perfBridge.get(sku);
      if (ids) {
        // tenta achar custo via idItem ou idVariacao
        if (
          (ids.idItem && costMap.has(ids.idItem)) ||
          (ids.idVariacao && costMap.has(ids.idVariacao))
        ) {
          matched = true;
          break;
        }
      }
    }

    if (!matched && item.kind === "cancelled") {
      result.unmatchedCancelled.push({
        orderId: item.orderId,
        productName: item.productName,
        skuPrincipal: item.skuPrincipal,
        subtotal,
      });
    }
  }

  result.cancelledLostRevenue = round2(result.cancelledLostRevenue);
  result.unpaidLostRevenue = round2(result.unpaidLostRevenue);
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

    const cost = toNumber(
      findField(row, [
        "preco custo",
        "preço custo",
        "custo",
        "custo produto",
        "custo do produto",
        "custo unitario",
        "custo unitário",
        "product cost",
      ])
    );

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
      taxPercent,
    });
  }

  return parsed;
}



function calculateShopeeItem(sale, costRow) {
  const averageTicket =
    sale.paidUnits > 0 ? sale.paidRevenue / sale.paidUnits : 0;

  if (averageTicket <= 0) {
    return {
      id: sale.id,
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



function processShopee(salesRowsRaw, costRowsRaw, ads, venforce, affiliates, ordersAllRowsRaw) {
  const detectedColumns =
    salesRowsRaw.length > 0 ? Object.keys(salesRowsRaw[0]) : [];
  const executiveNotes = [];
  const isFinancial = isShopeeFinancialOrderSheet(salesRowsRaw);
  const isPerformance = isShopeePerformanceSheet(salesRowsRaw);

  // Order.all está PAUSADO até existir chave de cruzamento (ID do Item /
  // ID da Variação) na planilha exportada. As funções
  // parseShopeeFinancialRows e isShopeeFinancialOrderSheet permanecem no
  // arquivo para reuso futuro. Não remover.
  if (isFinancial) {
    throw createBadRequestError(
      "A planilha Shopee Order.all ainda não é suportada para fechamento. " +
      "Ela não contém ID do Item nem ID da Variação, necessários para cruzar " +
      "com a base de custos. Use a planilha de performance/parentskudetail."
    );
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

  const unmatchedIdsSet = new Set();
  const excludedVariationIdsSet = new Set();
  const validItems = [];
  const detailedRows = [];
  let ignoredRevenue = 0;

  for (const sale of salesRows) {
    if (sale.isVariation && sale.variationStatus === "excluido") {
      excludedVariationIdsSet.add(sale.id);
    }

    const costRow =
      (sale.saleModelId && costMap.get(normalizeMatchKey(sale.saleModelId))) ||
      costMap.get(normalizeMatchKey(sale.id)) ||
      costMap.get(normalizeMatchKey(sale.itemId));

    if (!costRow || costRow.cost <= 0) {
      unmatchedIdsSet.add(sale.id);
      ignoredRevenue += sale.paidRevenue;
      continue;
    }

    const calculated = calculateShopeeItem(sale, costRow);
    validItems.push(calculated);

    detailedRows.push({
      Marketplace: "Shopee",
      Produto: calculated.product,
      ID: calculated.id,
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
    });
  }

  const paidRevenueTotal = validItems.reduce((acc, item) => acc + item.paidRevenue, 0);
  const contributionProfitTotal = validItems.reduce(
    (acc, item) => acc + item.contributionProfit,
    0
  );

  const averageContributionMargin =
    paidRevenueTotal > 0 ? contributionProfitTotal / paidRevenueTotal : 0;

  const tacos = paidRevenueTotal > 0 ? ads / paidRevenueTotal : 0;
  const tacox = paidRevenueTotal > 0 ? (ads + venforce) / paidRevenueTotal : 0;
  const finalResult = contributionProfitTotal - ads - venforce - affiliates;

  executiveNotes.push(
    "Planilha Shopee de performance processada com taxas estimadas por regra, não por repasse financeiro real."
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

  // Feature opcional: cruza Order.all (cancelados/não pagos) com a base
  // de custos via ponte da própria planilha de performance.
  // Só executa se o usuário subiu Order.all.
  let shopeeStatusSummary = {
    cancelledCount: 0,
    cancelledLostRevenue: 0,
    unpaidCount: 0,
    unpaidLostRevenue: 0,
    unmatchedCancelled: [],
  };
  if (Array.isArray(ordersAllRowsRaw) && ordersAllRowsRaw.length > 0) {
    const orderAllItems = parseShopeeOrderAllForStatus(ordersAllRowsRaw);
    if (orderAllItems.length > 0) {
      const perfBridge = buildShopeePerfSkuBridge(salesRowsRaw);
      shopeeStatusSummary = buildShopeeStatusSummary(
        orderAllItems,
        perfBridge,
        costMap
      );
    }
  }

  return {
    summary: {
      grossRevenueTotal: paidRevenueTotal,
      refundsTotal: 0,
      cancelledRevenue: 0,
      refundsCount: 0,
      paidRevenueTotal,
      contributionProfitTotal,
      averageContributionMargin,
      finalResult,
      tacos,
      tacox,
      platformAdjustmentTotal: 0,
      platformAdjustmentRowsCount: 0,
      cancellationsTotal: 0,
      returnsTotal: null,
      marketplaceFeesTotal,
      shippingFeesTotal: null,
      discountsBonusesTotal: null,
      taxValueTotal,
      cmvTotal,
      adsTotal: round2(ads),
      venforceTotal: round2(venforce),
      affiliatesTotal: round2(affiliates),
      grossProfitTotal: round2(contributionProfitTotal),
      grossMargin: paidRevenueTotal > 0 ? round2(contributionProfitTotal / paidRevenueTotal) : 0,
      executiveNotes,
      cancelledCount: shopeeStatusSummary.cancelledCount,
      cancelledLostRevenue: shopeeStatusSummary.cancelledLostRevenue,
      unpaidCount: shopeeStatusSummary.unpaidCount,
      unpaidLostRevenue: shopeeStatusSummary.unpaidLostRevenue,
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
        ? "Alguns IDs não possuem custo cadastrado e foram removidos do cálculo."
        : "Processamento concluído com sucesso.",
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
  buildShopeeStatusSummary,
  parseCostRows,
  processShopee,
};
