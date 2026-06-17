// server/services/fechamentoFinanceiro/meliFinanceiroService.js
// Lógica de fechamento financeiro do Mercado Livre.
// Extraído de server/index.js sem alterações de comportamento.
// NÃO mexer em fórmulas, nomes ou regras sem revisar todos os usos.

const XLSX = require("xlsx");
const { toNumber, round2 } = require("../../utils/numberUtils");
const {
  normalizeId,
  normalizeIdNoPrefix,
  findField,
} = require("../../utils/textUtils");

function parseMeliRows(rows) {
  return rows.map((row, index) => {
    const saleNumber = String(
      findField(row, [
        "n.º de venda",
        "n.o de venda",
        "nª de venda",
        "nº de venda",
        "n° de venda",
        "numero de venda",
        "no de venda",
      ]) ?? ""
    ).trim();

    const saleDate = String(
      findField(row, ["data da venda"]) ?? ""
    ).trim();

    const adIdRaw = String(
      findField(row, [
        "# de anúncio",
        "# de anuncio",
        "# do anúncio",
        "# do anuncio",
        "id do anúncio",
        "id do anuncio",
        "anúncio",
        "anuncio",
        "mlb",
        "id",
      ]) ?? ""
    ).trim();

    const modelIdRaw = String(
      findField(row, ["model id", "model_id", "modelid", "modelo"]) ?? ""
    ).trim();

    return {
      rowIndex: index,
      saleNumber,
      saleDate,
      units: toNumber(findField(row, ["unidades"])),
      total: toNumber(findField(row, ["total (brl)", "total"])),
      productRevenue: toNumber(
        findField(row, [
          "receita por produtos (brl)",
          "receita por produtos",
        ])
      ),
      cancelRefund: toNumber(
        findField(row, [
          "cancelamentos e reembolsos (brl)",
          "cancelamentos e reembolsos",
        ])
      ),
      tarifaVenda: toNumber(
        findField(row, [
          "tarifa de venda e impostos (brl)",
          "tarifa de venda e impostos",
        ])
      ),
      tarifaEnvio: toNumber(
        findField(row, [
          "tarifas de envio (brl)",
          "tarifas de envio",
        ])
      ),
      descontosBonus: toNumber(
        findField(row, [
          "descontos e bônus",
          "descontos e bonus",
        ])
      ),
      adIdRaw,
      adId: normalizeId(adIdRaw || modelIdRaw),
      title: String(
        findField(row, [
          "título do anúncio",
          "titulo do anuncio",
          "título",
          "titulo",
        ]) ?? ""
      ).trim(),
      unitSalePrice: toNumber(
        findField(row, [
          "preço unitário de venda do anúncio (brl)",
          "preco unitario de venda do anuncio (brl)",
          "preço unitário de venda do anúncio",
          "preco unitario de venda do anuncio",
        ])
      ),
      modelIdRaw,
    };
  });
}



function parseMeliCostRows(rows) {
  const parsed = [];

  for (const row of rows) {
    const idRaw = findField(row, [
      "# de anúncio",
      "# de anuncio",
      "# do anúncio",
      "# do anuncio",
      "id do anúncio",
      "id do anuncio",
      "anúncio",
      "anuncio",
      "mlb",
      "id",
    ]);

    const normalizedId = normalizeId(idRaw);
    if (!normalizedId) continue;

    const cost = toNumber(
      findField(row, [
        "preço de custo",
        "preco de custo",
        "preço custo",
        "preco custo",
        "custo",
        "custo do produto",
        "custo produto",
        "custo unitário",
        "custo unitario",
      ])
    );

    let taxPercent = toNumber(
      findField(row, [
        "imposto",
        "imposto %",
        "imposto percentual",
        "percentual imposto",
        "aliquota",
        "alíquota",
      ])
    );

    if (taxPercent > 0 && taxPercent <= 1) {
      taxPercent = taxPercent * 100;
    }

    const modelIdRaw = findField(row, [
      "model_id",
      "modelid",
      "model id",
      "id modelo",
      "modelo",
    ]);
    const modelId = String(modelIdRaw ?? "").trim();

    parsed.push({
      id: normalizedId,
      modelId,
      cost: round2(cost),
      taxPercent: round2(taxPercent),
    });
  }

  return parsed;
}



function buildMeliCostMap(rows) {
  const parsed = parseMeliCostRows(rows);
  const map = new Map();

  for (const row of parsed) {
    if (!row.id) continue;

    if (!map.has(row.id)) {
      map.set(row.id, row);
    }

    const noPrefix = row.id.replace(/^MLB/i, "");
    if (noPrefix && !map.has(noPrefix)) {
      map.set(noPrefix, row);
    }

    if (row.modelId) {
      const mNorm = normalizeId(row.modelId);
      if (mNorm) {
        if (!map.has(mNorm)) map.set(mNorm, row);
        const mNoPrefix = mNorm.replace(/^MLB/i, "");
        if (mNoPrefix && !map.has(mNoPrefix)) map.set(mNoPrefix, row);
        if (mNoPrefix && !map.has(`MLB${mNoPrefix}`)) map.set(`MLB${mNoPrefix}`, row);
      }
    }
  }

  return map;
}



function allocateByUnits(totalValue, componentRows) {
  const totalUnits = componentRows.reduce((acc, row) => acc + row.units, 0);

  if (totalUnits <= 0 || componentRows.length === 0) {
    return componentRows.map(() => 0);
  }

  const allocations = [];
  let accumulated = 0;

  for (let i = 0; i < componentRows.length; i++) {
    const row = componentRows[i];

    if (i === componentRows.length - 1) {
      allocations.push(round2(totalValue - accumulated));
      continue;
    }

    const value = round2((totalValue / totalUnits) * row.units);
    allocations.push(value);
    accumulated += value;
  }

  return allocations;
}



function buildMeliBaseSheetRows(finalRows) {
  const aoa = [];

  aoa.push([
    "# de anúncio",
    "Título do anúncio",
    "Unidades",
    "Preço unitário de venda do anúncio (BRL)",
    "Venda Total",
    "Total (BRL)",
    "Imposto",
    "Preço de custo",
    "Preço de custo total",
    "Ajuste plataforma (BRL)",
    "LC",
    "MC",
  ]);

  for (const row of finalRows) {
    aoa.push([
      row["# de anúncio"],
      row["Título do anúncio"],
      row.Unidades,
      row["Preço unitário de venda do anúncio (BRL)"],
      row["Venda Total"],
      row["Total (BRL)"],
      row["Imposto"] / 100,
      row["Preço de custo"],
      row["Preço de custo total"],
      row["Ajuste plataforma (BRL)"],
      row.LC,
      row.MC / 100,
    ]);
  }

  const sheet = XLSX.utils.aoa_to_sheet(aoa);

  for (let rowIndex = 2; rowIndex <= finalRows.length + 1; rowIndex++) {
    const d = `D${rowIndex}`;
    const e = `E${rowIndex}`;
    const f = `F${rowIndex}`;
    const g = `G${rowIndex}`;
    const h = `H${rowIndex}`;
    const i = `I${rowIndex}`;
    const j = `J${rowIndex}`;
    const k = `K${rowIndex}`;
    const l = `L${rowIndex}`;

    if (sheet[d]) sheet[d].z = "R$ #,##0.00";
    if (sheet[e]) sheet[e].z = "R$ #,##0.00";
    if (sheet[f]) sheet[f].z = "R$ #,##0.00";
    if (sheet[g]) sheet[g].z = "0.00%";
    if (sheet[h]) sheet[h].z = "R$ #,##0.00";
    if (sheet[i]) sheet[i].z = "R$ #,##0.00";
    if (sheet[j]) sheet[j].z = "R$ #,##0.00";
    if (sheet[k]) sheet[k].z = "R$ #,##0.00";
    if (sheet[l]) sheet[l].z = "0.00%";
  }

  sheet["!cols"] = [
    { wch: 16 },
    { wch: 55 },
    { wch: 10 },
    { wch: 24 },
    { wch: 16 },
    { wch: 16 },
    { wch: 10 },
    { wch: 14 },
    { wch: 18 },
    { wch: 18 },
    { wch: 14 },
    { wch: 10 },
  ];

  sheet["!autofilter"] = { ref: "A1:L1" };

  return sheet;
}



function processMeli(salesRowsRaw, costRowsRaw, ads, venforce, affiliates) {
  const salesRows = parseMeliRows(salesRowsRaw);
  const costMap = buildMeliCostMap(costRowsRaw);

  const finalRows = [];
  const unmatchedIds = new Set();
  const consumedIndexes = new Set();
  let ignoredRevenue = 0;

  const refundsTotal = round2(
    salesRows.reduce((sum, row) => sum + row.cancelRefund, 0)
  );
  const refundsCount = salesRows.filter(
    (row) => Math.abs(Number(row.cancelRefund || 0)) > 0.01
  ).length;
  // Faturamento perdido = soma da Receita por produtos (coluna I) nas linhas
  // que tiveram cancelamento/reembolso. Mostra o quanto de venda integral
  // foi perdida nessas operações (independente de quanto o ML reembolsou).
  const lostRevenueTotal = round2(
    salesRows
      .filter((row) => Math.abs(Number(row.cancelRefund || 0)) > 0.01)
      .reduce((sum, row) => sum + Number(row.productRevenue || 0), 0)
  );

  function isMainRow(row) {
    return !row.adId && Math.abs(row.productRevenue) > 0;
  }

  function isItemRow(row) {
    return !!row.adId && row.units > 0;
  }

  function computePlatformAdjustment(row) {
    const expected =
      (row.productRevenue || 0) +
      (row.tarifaVenda || 0) +
      (row.tarifaEnvio || 0) +
      (row.descontosBonus || 0);
    return round2(expected - (row.total || 0));
  }

  function getCostForAd(adId) {
    const normalized = normalizeId(adId);
    const noPrefix = normalized.replace(/^MLB/i, "");

    return (
      costMap.get(normalized) ||
      costMap.get(noPrefix) ||
      costMap.get(`MLB${noPrefix}`) ||
      null
    );
  }

  function pushCalculatedRow(item, totalRateado, ajustePlataforma = 0) {
    const id = normalizeId(item.adId || item.adIdRaw);
    let cost = item.modelIdRaw ? getCostForAd(item.modelIdRaw) : null;
    if (!cost) cost = getCostForAd(id);

    if (!cost || cost.cost <= 0) {
      unmatchedIds.add(id || item.adIdRaw || "SEM_ID");
      ignoredRevenue += round2(totalRateado);
      return;
    }

    const units = round2(item.units);
    const price = round2(item.unitSalePrice);
    const vendaTotal =
      price > 0 ? round2(units * price) : round2(Math.abs(totalRateado));

    const impostoPercent = round2(cost.taxPercent || 0);
    const impostoDec = impostoPercent > 1 ? impostoPercent / 100 : impostoPercent;

    const precoCusto = round2(cost.cost || 0);
    const precoCustoTotal = round2(units * precoCusto);

    const totalFormatado = round2(totalRateado);

    let lc = 0;
    let mc = 0;
    
    if (totalFormatado < 0) {
      lc = round2(totalFormatado);
      const baseCalcMcNeg = vendaTotal > 0 ? vendaTotal : round2(Math.abs(totalRateado));
      mc = baseCalcMcNeg > 0 ? round2((lc / baseCalcMcNeg) * 100) : 0;
    } else if (totalFormatado > 0) {
      lc = round2(
        vendaTotal -
          (vendaTotal * impostoDec) -
          (vendaTotal - totalFormatado) -
          precoCustoTotal
      );
    
      const baseCalcMc = vendaTotal > 0 ? vendaTotal : round2(Math.abs(totalRateado));
      mc = baseCalcMc > 0 ? round2((lc / baseCalcMc) * 100) : 0;
    } else {
      lc = 0;
      mc = 0;
    }

    finalRows.push({
      "# de anúncio": id,
      "Título do anúncio": item.title,
      Unidades: units,
      "Preço unitário de venda do anúncio (BRL)": price,
      "Venda Total": vendaTotal,
      "Total (BRL)": totalFormatado,
      Imposto: impostoPercent,
      "Preço de custo": precoCusto,
      "Preço de custo total": precoCustoTotal,
      "Ajuste plataforma (BRL)": round2(ajustePlataforma),
      LC: lc,
      MC: mc,
    });
  }

  const EXCLUIR_ESTADOS = /cancelad|devolu|reembolso|mediacao|mediação|reemb/i;

  for (let i = 0; i < salesRows.length; i++) {
    if (consumedIndexes.has(i)) continue;

    const current = salesRows[i];

    // Exclui do cálculo de LC/MC mas não dos totais de reembolso
    const estadoAtual = String(
      findField(salesRowsRaw[i] || {}, ["estado", "descrição do status", "descricao do status"]) ?? ""
    ).trim();
    if (EXCLUIR_ESTADOS.test(estadoAtual) && !isMainRow(current)) continue;

    if (isMainRow(current)) {
      const children = [];
      const childrenIndexes = [];
      let j = i + 1;

      while (j < salesRows.length) {
        const next = salesRows[j];

        if (isMainRow(next)) break;
        if (next.saleDate !== current.saleDate) break;
        if (!isItemRow(next)) break;

        children.push(next);
        childrenIndexes.push(j);
        j++;
      }

      if (children.length > 0) {
        const totalRateado = allocateByUnits(current.total, children);
        const ajusteParent = computePlatformAdjustment(current);
        const ajustesRateados = allocateByUnits(ajusteParent, children);

        for (let k = 0; k < children.length; k++) {
          pushCalculatedRow(children[k], totalRateado[k], ajustesRateados[k]);
          consumedIndexes.add(childrenIndexes[k]);
        }

        consumedIndexes.add(i);
        continue;
      }

      consumedIndexes.add(i);
      continue;
    }

    if (isItemRow(current)) {
      pushCalculatedRow(current, current.total, computePlatformAdjustment(current));
      consumedIndexes.add(i);
    }
  }

  const groupedMap = new Map();
  for (const row of finalRows) {
    const id = row["# de anúncio"];
    if (!groupedMap.has(id)) {
      groupedMap.set(id, { ...row });
    } else {
      const acc = groupedMap.get(id);
      acc.Unidades              = round2(acc.Unidades + row.Unidades);
      acc["Venda Total"]        = round2(acc["Venda Total"] + row["Venda Total"]);
      acc["Total (BRL)"]        = round2(acc["Total (BRL)"] + row["Total (BRL)"]);
      acc["Preço de custo total"] = round2(acc["Preço de custo total"] + row["Preço de custo total"]);
      acc["Ajuste plataforma (BRL)"] = round2(acc["Ajuste plataforma (BRL)"] + row["Ajuste plataforma (BRL)"]);
      acc.LC                    = round2(acc.LC + row.LC);
    }
  }
  const aggregatedRows = Array.from(groupedMap.values()).map((row) => ({
    ...row,
    MC: row["Venda Total"] > 0 ? round2((row.LC / row["Venda Total"]) * 100) : 0,
  }));

  const grossRevenueTotal = round2(
    finalRows.reduce((sum, row) => sum + Number(row["Venda Total"] || 0), 0)
  );

  const paidRevenueTotal = round2(
    finalRows.reduce((sum, row) => sum + Number(row["Total (BRL)"] || 0), 0)
  );

  const contributionProfitTotal = round2(
    finalRows.reduce((sum, row) => sum + Number(row["LC"] || 0), 0)
  );

  const platformAdjustmentTotal = round2(
    finalRows.reduce(
      (sum, row) => sum + Number(row["Ajuste plataforma (BRL)"] || 0),
      0
    )
  );
  const platformAdjustmentRowsCount = finalRows.filter(
    (row) => Math.abs(Number(row["Ajuste plataforma (BRL)"] || 0)) > 0.01
  ).length;

  const averageContributionMargin =
    grossRevenueTotal > 0 ? contributionProfitTotal / grossRevenueTotal : 0;

  const finalResult = contributionProfitTotal - ads - venforce - affiliates;
  const tacos = grossRevenueTotal > 0 ? ads / grossRevenueTotal : 0;
  const tacox =
    grossRevenueTotal > 0 ? (ads + venforce + affiliates) / grossRevenueTotal : 0;

  return {
    summary: {
      grossRevenueTotal,
      refundsTotal,
      cancelledRevenue: refundsTotal,
      refundsCount,
      lostRevenueTotal,
      paidRevenueTotal,
      contributionProfitTotal,
      averageContributionMargin,
      finalResult,
      tacos,
      tacox,
      platformAdjustmentTotal,
      platformAdjustmentRowsCount,
    },
    preparedRows: aggregatedRows,
    detailedRows: aggregatedRows,
    auditRows: [],
    excelFileName: "fechamento-meli.xlsx",
    unmatchedIds: Array.from(unmatchedIds),
    ignoredRowsWithoutCost: unmatchedIds.size,
    ignoredRevenue: round2(ignoredRevenue),
    message:
      unmatchedIds.size > 0
        ? "Alguns anúncios do MELI não possuem custo cadastrado e foram ignorados."
        : "OK",
  };
}



const CENTRAL_FIELDS = {
  saleStatus: ["estado", "descricao do status", "status"],
  packId: ["pack id", "id do pacote", "numero do pacote", "n de pacote"],
  shipmentId: ["shipment id", "id do envio", "numero do envio", "n de envio"],
  sku: ["sku", "seller sku", "codigo sku", "codigo do sku"],
  productRevenue: ["receita por produtos (brl)", "receita por produtos"],
  unitPrice: [
    "preco unitario de venda do anuncio (brl)",
    "preco unitario de venda do anuncio",
  ],
  total: ["total (brl)", "total"],
  tarifaVenda: ["tarifa de venda e impostos (brl)", "tarifa de venda e impostos"],
  tarifaEnvio: ["tarifas de envio (brl)", "tarifas de envio"],
  cancelRefund: [
    "cancelamentos e reembolsos (brl)",
    "cancelamentos e reembolsos",
  ],
  cost: [
    "preco de custo",
    "preco custo",
    "custo",
    "custo do produto",
    "custo produto",
    "custo unitario",
  ],
  tax: [
    "imposto",
    "imposto %",
    "imposto percentual",
    "percentual imposto",
    "aliquota",
  ],
};

function normalizeCentralKey(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u00aa\u00ba\u00b0]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function findCentralField(row, candidates) {
  const entries = Object.entries(row || {});
  const normalizedCandidates = candidates.map(normalizeCentralKey);

  for (const [key, value] of entries) {
    const normalized = normalizeCentralKey(key);
    if (normalizedCandidates.includes(normalized)) {
      return { present: true, value };
    }
  }

  for (const [key, value] of entries) {
    const normalized = normalizeCentralKey(key);
    if (normalizedCandidates.some((candidate) => normalized.includes(candidate))) {
      return { present: true, value };
    }
  }

  return { present: false, value: null };
}

function centralFieldHasValue(field) {
  if (!field || !field.present) return false;
  if (field.value === null || field.value === undefined) return false;
  return String(field.value).trim() !== "";
}

function centralTextFromField(field) {
  return centralFieldHasValue(field) ? String(field.value).trim() : null;
}

function addCentralCostEntry(map, key, row) {
  const normalized = normalizeId(key);
  if (!normalized) return;

  if (!map.has(normalized)) map.set(normalized, row);

  const noPrefix = normalized.replace(/^MLB/i, "");
  if (noPrefix && !map.has(noPrefix)) map.set(noPrefix, row);
  if (noPrefix && !map.has(`MLB${noPrefix}`)) map.set(`MLB${noPrefix}`, row);
}

function buildCentralCostMap(rows) {
  const map = new Map();

  for (const rawRow of rows || []) {
    const parsed = parseMeliCostRows([rawRow])[0];
    if (!parsed || !parsed.id) continue;

    const costField = findCentralField(rawRow, CENTRAL_FIELDS.cost);
    const taxField = findCentralField(rawRow, CENTRAL_FIELDS.tax);
    const row = {
      ...parsed,
      hasCost: centralFieldHasValue(costField) && parsed.cost > 0,
      hasTax: centralFieldHasValue(taxField),
    };

    addCentralCostEntry(map, parsed.id, row);
    if (parsed.modelId) addCentralCostEntry(map, parsed.modelId, row);
  }

  return map;
}

function getCentralCostForAd(costMap, adId) {
  const normalized = normalizeId(adId);
  const noPrefix = normalized.replace(/^MLB/i, "");

  return (
    costMap.get(normalized) ||
    costMap.get(noPrefix) ||
    costMap.get(`MLB${noPrefix}`) ||
    null
  );
}

function buildCentralPedidoId(row, index) {
  const saleNumber = String(row.saleNumber || "").trim();
  if (saleNumber) return saleNumber;
  const adId = normalizeId(row.adId || row.adIdRaw);
  return adId ? `MELI-${adId}-${index + 1}` : `MELI-LINHA-${index + 1}`;
}

function addCentralPendencia(pendencias, pendencia) {
  if (!pendencias.includes(pendencia)) pendencias.push(pendencia);
}

function buildCentralComponent({
  pedidoId,
  itemId,
  tipo,
  valor,
  fonte,
  confianca,
  obs,
}) {
  return {
    pedidoId,
    itemId,
    tipo,
    valor: valor === null || valor === undefined ? null : round2(valor),
    fonte,
    confianca,
    obs,
  };
}

function processMeliForCentralVendas({
  salesRowsRaw = [],
  costRowsRaw = [],
  clienteSlug = null,
  competencia = null,
} = {}) {
  const salesRows = parseMeliRows(salesRowsRaw);
  const costMap = buildCentralCostMap(costRowsRaw);

  const pedidos = [];
  const itens = [];
  const componentes = [];
  const consumedIndexes = new Set();

  function isMainRow(row) {
    return !row.adId && Math.abs(row.productRevenue) > 0;
  }

  function isItemRow(row) {
    return !!row.adId && row.units > 0;
  }

  function computePlatformAdjustment(row) {
    const expected =
      (row.productRevenue || 0) +
      (row.tarifaVenda || 0) +
      (row.tarifaEnvio || 0) +
      (row.descontosBonus || 0);
    return round2(expected - (row.total || 0));
  }

  function buildSourceFinancials(sourceRow, sourceRaw, componentRows) {
    const tarifaVendaField = findCentralField(sourceRaw, CENTRAL_FIELDS.tarifaVenda);
    const tarifaEnvioField = findCentralField(sourceRaw, CENTRAL_FIELDS.tarifaEnvio);
    const cancelRefundField = findCentralField(sourceRaw, CENTRAL_FIELDS.cancelRefund);

    return {
      total: allocateByUnits(sourceRow.total, componentRows),
      ajustePlataforma: allocateByUnits(computePlatformAdjustment(sourceRow), componentRows),
      tarifaVenda: centralFieldHasValue(tarifaVendaField)
        ? allocateByUnits(sourceRow.tarifaVenda, componentRows)
        : null,
      tarifaEnvio: centralFieldHasValue(tarifaEnvioField)
        ? allocateByUnits(sourceRow.tarifaEnvio, componentRows)
        : null,
      cancelRefund: centralFieldHasValue(cancelRefundField)
        ? allocateByUnits(sourceRow.cancelRefund, componentRows)
        : null,
      hasTarifaVenda: centralFieldHasValue(tarifaVendaField),
      hasTarifaEnvio: centralFieldHasValue(tarifaEnvioField),
      hasCancelRefund: centralFieldHasValue(cancelRefundField),
    };
  }

  function createPedido(sourceRow, sourceRaw, sourceIndex) {
    const pedidoId = buildCentralPedidoId(sourceRow, sourceIndex);
    const packId = centralTextFromField(findCentralField(sourceRaw, CENTRAL_FIELDS.packId));
    const shipmentId = centralTextFromField(findCentralField(sourceRaw, CENTRAL_FIELDS.shipmentId));
    const status =
      centralTextFromField(findCentralField(sourceRaw, CENTRAL_FIELDS.saleStatus)) || null;

    return {
      pedidoId,
      packId,
      shipmentId,
      clienteSlug,
      competencia,
      dataPedido: sourceRow.saleDate || null,
      status,
      quantidadeItens: 0,
      faturamento: 0,
      lucroContribuicao: 0,
      resultado: 0,
      margemContribuicaoPercentual: null,
      confianca: "confiavel",
      pendencias: [],
      _temResultado: false,
    };
  }

  function applyConfidence(pedido, itemConfianca, pendencias) {
    for (const pendencia of pendencias) {
      addCentralPendencia(pedido.pendencias, pendencia);
    }

    if (itemConfianca === "bloqueado") {
      pedido.confianca = "bloqueado";
      return;
    }

    if (itemConfianca === "parcial" && pedido.confianca !== "bloqueado") {
      pedido.confianca = "parcial";
    }
  }

  function pushCentralItem({
    pedido,
    item,
    rawItem,
    totalRateado,
    ajustePlataforma,
    financials,
    allocationIndex,
  }) {
    const id = normalizeId(item.adId || item.adIdRaw);
    let cost = item.modelIdRaw ? getCentralCostForAd(costMap, item.modelIdRaw) : null;
    if (!cost) cost = getCentralCostForAd(costMap, id);

    const units = round2(item.units);
    const price = round2(item.unitSalePrice);
    const productRevenueField = findCentralField(rawItem, CENTRAL_FIELDS.productRevenue);
    const unitPriceField = findCentralField(rawItem, CENTRAL_FIELDS.unitPrice);
    const sku = centralTextFromField(findCentralField(rawItem, CENTRAL_FIELDS.sku));

    const hasProduct =
      !!id &&
      units > 0 &&
      (centralFieldHasValue(unitPriceField) ||
        centralFieldHasValue(productRevenueField) ||
        Math.abs(Number(totalRateado || 0)) > 0);
    const hasCost = !!cost && cost.hasCost;
    const hasTax = !!cost && cost.hasTax;
    const vendaTotal =
      hasProduct && price > 0
        ? round2(units * price)
        : hasProduct
          ? round2(Math.abs(totalRateado))
          : null;
    const totalFormatado = round2(totalRateado);
    const impostoPercent = hasTax ? round2(cost.taxPercent || 0) : null;
    const impostoDec =
      impostoPercent === null ? 0 : impostoPercent > 1 ? impostoPercent / 100 : impostoPercent;
    const precoCusto = hasCost ? round2(cost.cost || 0) : null;
    const precoCustoTotal =
      hasCost && vendaTotal !== null ? round2(units * precoCusto) : null;
    const impostoInterno =
      hasTax && vendaTotal !== null ? round2(vendaTotal * impostoDec) : null;

    const pendencias = [];
    if (!hasProduct) addCentralPendencia(pendencias, "produto_ausente");
    if (!hasCost) addCentralPendencia(pendencias, "custo_produto_ausente");
    if (!financials.hasTarifaVenda) addCentralPendencia(pendencias, "tarifa_venda_ausente");
    if (!financials.hasTarifaEnvio) addCentralPendencia(pendencias, "frete_seller_ausente");
    if (!hasTax) addCentralPendencia(pendencias, "imposto_interno_ausente");

    const bloqueado = !hasProduct || !hasCost;
    const parcial =
      !bloqueado &&
      (!financials.hasTarifaVenda || !financials.hasTarifaEnvio || !hasTax);
    const confianca = bloqueado ? "bloqueado" : parcial ? "parcial" : "confiavel";

    let lucroContribuicao = null;
    let margemContribuicaoPercentual = null;

    if (!bloqueado) {
      if (totalFormatado < 0) {
        lucroContribuicao = round2(totalFormatado);
        const baseCalcMcNeg = vendaTotal > 0 ? vendaTotal : round2(Math.abs(totalRateado));
        margemContribuicaoPercentual =
          baseCalcMcNeg > 0 ? round2((lucroContribuicao / baseCalcMcNeg) * 100) : 0;
      } else if (totalFormatado > 0) {
        lucroContribuicao = round2(
          vendaTotal -
            (vendaTotal * impostoDec) -
            (vendaTotal - totalFormatado) -
            precoCustoTotal
        );
        const baseCalcMc = vendaTotal > 0 ? vendaTotal : round2(Math.abs(totalRateado));
        margemContribuicaoPercentual =
          baseCalcMc > 0 ? round2((lucroContribuicao / baseCalcMc) * 100) : 0;
      } else {
        lucroContribuicao = 0;
        margemContribuicaoPercentual = 0;
      }
    }

    const itemId = `${pedido.pedidoId}:${id || "SEM_ID"}:${item.rowIndex}`;
    const itemPayload = {
      pedidoId: pedido.pedidoId,
      itemId,
      mlb: id || null,
      sku,
      titulo: item.title || null,
      quantidade: units,
      valorUnitario: centralFieldHasValue(unitPriceField) ? price : null,
      receitaProduto: vendaTotal,
      custoProduto: precoCustoTotal,
      impostoInterno,
      lucroContribuicao,
      resultado: lucroContribuicao,
      margemContribuicaoPercentual,
      confianca,
      pendencias,
    };

    itens.push(itemPayload);

    componentes.push(
      buildCentralComponent({
        pedidoId: pedido.pedidoId,
        itemId,
        tipo: "receita_produto",
        valor: vendaTotal,
        fonte: hasProduct ? "planilha_vendas" : "ausente",
        confianca: hasProduct ? "real" : "bloqueado",
        obs: hasProduct ? null : "Produto ausente ou incompleto na planilha de vendas.",
      }),
      buildCentralComponent({
        pedidoId: pedido.pedidoId,
        itemId,
        tipo: "tarifa_venda",
        valor: financials.tarifaVenda ? financials.tarifaVenda[allocationIndex] : null,
        fonte: financials.hasTarifaVenda ? "planilha_vendas" : "ausente",
        confianca: financials.hasTarifaVenda ? "real" : "ausente",
        obs: financials.hasTarifaVenda
          ? null
          : "Tarifa ausente; o resultado usa o total liquido do fechamento atual.",
      }),
      buildCentralComponent({
        pedidoId: pedido.pedidoId,
        itemId,
        tipo: "frete_seller",
        valor: financials.tarifaEnvio ? financials.tarifaEnvio[allocationIndex] : null,
        fonte: financials.hasTarifaEnvio ? "planilha_vendas" : "ausente",
        confianca: financials.hasTarifaEnvio ? "real" : "ausente",
        obs: financials.hasTarifaEnvio
          ? null
          : "Frete seller ausente; o resultado usa o total liquido do fechamento atual.",
      }),
      buildCentralComponent({
        pedidoId: pedido.pedidoId,
        itemId,
        tipo: "custo_produto",
        valor: precoCustoTotal === null ? null : -precoCustoTotal,
        fonte: hasCost ? "planilha_custos" : "ausente",
        confianca: hasCost ? "real" : "bloqueado",
        obs: hasCost ? null : "Custo do produto ausente na planilha de custos.",
      }),
      buildCentralComponent({
        pedidoId: pedido.pedidoId,
        itemId,
        tipo: "imposto_interno",
        valor: impostoInterno === null ? null : -impostoInterno,
        fonte: hasTax ? "planilha_custos" : "ausente",
        confianca: hasTax ? "real" : "ausente",
        obs: hasTax ? null : "Imposto interno ausente na planilha de custos.",
      }),
      buildCentralComponent({
        pedidoId: pedido.pedidoId,
        itemId,
        tipo: "cancelamento_reembolso",
        valor: financials.cancelRefund ? financials.cancelRefund[allocationIndex] : null,
        fonte: financials.hasCancelRefund ? "planilha_vendas" : "ausente",
        confianca: financials.hasCancelRefund ? "real" : "ausente",
        obs: financials.hasCancelRefund ? null : "Cancelamento/reembolso ausente na planilha.",
      })
    );

    pedido.quantidadeItens = round2(pedido.quantidadeItens + units);
    pedido.faturamento = round2(pedido.faturamento + (vendaTotal || 0));
    if (lucroContribuicao !== null) {
      pedido.lucroContribuicao = round2(pedido.lucroContribuicao + lucroContribuicao);
      pedido.resultado = pedido.lucroContribuicao;
      pedido._temResultado = true;
    }
    applyConfidence(pedido, confianca, pendencias);

    if (Math.abs(Number(ajustePlataforma || 0)) > 0.01) {
      addCentralPendencia(pedido.pendencias, "ajuste_plataforma_presente");
    }
  }

  function finishPedido(pedido) {
    if (pedido.confianca === "bloqueado" || !pedido._temResultado) {
      pedido.lucroContribuicao = null;
      pedido.resultado = null;
      pedido.margemContribuicaoPercentual = null;
    } else {
      pedido.lucroContribuicao = round2(pedido.lucroContribuicao);
      pedido.resultado = pedido.lucroContribuicao;
      pedido.margemContribuicaoPercentual =
        pedido.faturamento > 0
          ? round2((pedido.lucroContribuicao / pedido.faturamento) * 100)
          : 0;
    }

    delete pedido._temResultado;
    pedidos.push(pedido);
  }

  const EXCLUIR_ESTADOS = /cancelad|devolu|reembolso|mediacao|reemb/i;

  for (let i = 0; i < salesRows.length; i++) {
    if (consumedIndexes.has(i)) continue;

    const current = salesRows[i];
    const currentRaw = salesRowsRaw[i] || {};
    const estadoAtual = String(
      findField(currentRaw, ["estado", "descricao do status"]) ?? ""
    ).trim();

    if (EXCLUIR_ESTADOS.test(estadoAtual) && !isMainRow(current)) continue;

    if (isMainRow(current)) {
      const children = [];
      const childrenIndexes = [];
      let j = i + 1;

      while (j < salesRows.length) {
        const next = salesRows[j];

        if (isMainRow(next)) break;
        if (next.saleDate !== current.saleDate) break;
        if (!isItemRow(next)) break;

        children.push(next);
        childrenIndexes.push(j);
        j++;
      }

      if (children.length > 0) {
        const pedido = createPedido(current, currentRaw, i);
        const financials = buildSourceFinancials(current, currentRaw, children);

        for (let k = 0; k < children.length; k++) {
          pushCentralItem({
            pedido,
            item: children[k],
            rawItem: salesRowsRaw[childrenIndexes[k]] || {},
            totalRateado: financials.total[k],
            ajustePlataforma: financials.ajustePlataforma[k],
            financials,
            allocationIndex: k,
          });
          consumedIndexes.add(childrenIndexes[k]);
        }

        consumedIndexes.add(i);
        finishPedido(pedido);
        continue;
      }

      consumedIndexes.add(i);
      continue;
    }

    if (isItemRow(current)) {
      const pedido = createPedido(current, currentRaw, i);
      const financials = buildSourceFinancials(current, currentRaw, [current]);

      pushCentralItem({
        pedido,
        item: current,
        rawItem: currentRaw,
        totalRateado: financials.total[0],
        ajustePlataforma: financials.ajustePlataforma[0],
        financials,
        allocationIndex: 0,
      });

      consumedIndexes.add(i);
      finishPedido(pedido);
    }
  }

  const receitaConfiavel = round2(
    pedidos
      .filter((pedido) => pedido.confianca === "confiavel")
      .reduce((sum, pedido) => sum + Number(pedido.faturamento || 0), 0)
  );
  const receitaParcial = round2(
    pedidos
      .filter((pedido) => pedido.confianca === "parcial")
      .reduce((sum, pedido) => sum + Number(pedido.faturamento || 0), 0)
  );
  const receitaBloqueada = round2(
    pedidos
      .filter((pedido) => pedido.confianca === "bloqueado")
      .reduce((sum, pedido) => sum + Number(pedido.faturamento || 0), 0)
  );
  const faturamento = round2(receitaConfiavel + receitaParcial);
  const pedidosComResultado = pedidos.filter(
    (pedido) => pedido.lucroContribuicao !== null && pedido.lucroContribuicao !== undefined
  );
  const lucroContribuicao = pedidosComResultado.length
    ? round2(
        pedidosComResultado.reduce(
          (sum, pedido) => sum + Number(pedido.lucroContribuicao || 0),
          0
        )
      )
    : null;

  const totaisPorTipo = {};
  for (const tipo of [
    "receita_produto",
    "tarifa_venda",
    "frete_seller",
    "custo_produto",
    "imposto_interno",
    "cancelamento_reembolso",
  ]) {
    totaisPorTipo[tipo] = round2(
      componentes
        .filter((component) => component.tipo === tipo && component.valor !== null)
        .reduce((sum, component) => sum + Number(component.valor || 0), 0)
    );
  }

  return {
    pedidos,
    itens,
    componentes,
    resumo: {
      clienteSlug,
      competencia,
      pedidosTotal: pedidos.length,
      pedidosConfiaveis: pedidos.filter((pedido) => pedido.confianca === "confiavel").length,
      pedidosParciais: pedidos.filter((pedido) => pedido.confianca === "parcial").length,
      pedidosBloqueados: pedidos.filter((pedido) => pedido.confianca === "bloqueado").length,
      faturamento,
      lucroContribuicao,
      margemContribuicaoPercentual:
        lucroContribuicao !== null && faturamento > 0
          ? round2((lucroContribuicao / faturamento) * 100)
          : null,
      receitaConfiavel,
      receitaParcial,
      receitaBloqueada,
      totaisPorTipo,
    },
  };
}



module.exports = {
  parseMeliRows,
  parseMeliCostRows,
  buildMeliCostMap,
  buildMeliBaseSheetRows,
  allocateByUnits,
  processMeli,
  processMeliForCentralVendas,
};
