// server/services/fechamentoFinanceiro/meliFinanceiroService.js
// Lógica de fechamento financeiro do Mercado Livre.
// NÃO mexer em fórmulas, nomes ou regras sem revisar todos os usos.

const XLSX = require("xlsx");
const { toNumber, round2 } = require("../../utils/numberUtils");
const {
  normalizeId,
  findField,
  normalizeText,
} = require("../../utils/textUtils");

// ─── Parsers de linhas ────────────────────────────────────────────────────────

function parseMeliRows(rows) {
  return rows.map((row, index) => {
    const saleNumber = String(
      findField(row, [
        "n.º de venda", "n.o de venda", "nª de venda",
        "nº de venda", "n° de venda", "numero de venda", "no de venda",
      ]) ?? ""
    ).trim();

    const saleDate = String(findField(row, ["data da venda"]) ?? "").trim();

    const adIdRaw = String(
      findField(row, [
        "# de anúncio", "# de anuncio", "# do anúncio", "# do anuncio",
        "id do anúncio", "id do anuncio", "anúncio", "anuncio", "mlb", "id",
      ]) ?? ""
    ).trim();

    const modelIdRaw = String(
      findField(row, ["model id", "model_id", "modelid", "modelo"]) ?? ""
    ).trim();

    return {
      rowIndex: index,
      saleNumber,
      saleDate,
      units:          toNumber(findField(row, ["unidades"])),
      total:          toNumber(findField(row, ["total (brl)", "total"])),
      productRevenue: toNumber(findField(row, ["receita por produtos (brl)", "receita por produtos"])),
      cancelRefund:   toNumber(findField(row, ["cancelamentos e reembolsos (brl)", "cancelamentos e reembolsos"])),
      tarifaVenda:    toNumber(findField(row, ["tarifa de venda e impostos (brl)", "tarifa de venda e impostos"])),
      tarifaEnvio:    toNumber(findField(row, ["tarifas de envio (brl)", "tarifas de envio"])),
      descontosBonus: toNumber(findField(row, ["descontos e bônus", "descontos e bonus"])),
      adIdRaw,
      adId: normalizeId(adIdRaw || modelIdRaw),
      title: String(
        findField(row, ["título do anúncio", "titulo do anuncio", "título", "titulo"]) ?? ""
      ).trim(),
      unitSalePrice: toNumber(
        findField(row, [
          "preço unitário de venda do anúncio (brl)", "preco unitario de venda do anuncio (brl)",
          "preço unitário de venda do anúncio",       "preco unitario de venda do anuncio",
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
      "# de anúncio", "# de anuncio", "# do anúncio", "# do anuncio",
      "id do anúncio", "id do anuncio", "anúncio", "anuncio", "mlb", "id",
    ]);

    const normalizedId = normalizeId(idRaw);
    if (!normalizedId) continue;

    const cost = toNumber(
      findField(row, [
        "preço de custo", "preco de custo", "preço custo", "preco custo",
        "custo", "custo do produto", "custo produto", "custo unitário", "custo unitario",
      ])
    );

    let taxPercent = toNumber(
      findField(row, ["imposto", "imposto %", "imposto percentual", "percentual imposto", "aliquota", "alíquota"])
    );
    if (taxPercent > 0 && taxPercent <= 1) taxPercent = taxPercent * 100;

    const modelIdRaw = findField(row, ["model_id", "modelid", "model id", "id modelo", "modelo"]);
    const modelId    = String(modelIdRaw ?? "").trim();

    parsed.push({
      id: normalizedId,
      modelId,
      cost:       round2(cost),
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

    if (!map.has(row.id)) map.set(row.id, row);
    const noPrefix = row.id.replace(/^MLB/i, "");
    if (noPrefix && !map.has(noPrefix)) map.set(noPrefix, row);

    if (row.modelId) {
      const mNorm = normalizeId(row.modelId);
      if (mNorm) {
        if (!map.has(mNorm))          map.set(mNorm, row);
        const mNoPrefix = mNorm.replace(/^MLB/i, "");
        if (mNoPrefix && !map.has(mNoPrefix))          map.set(mNoPrefix, row);
        if (mNoPrefix && !map.has(`MLB${mNoPrefix}`)) map.set(`MLB${mNoPrefix}`, row);
      }
    }
  }

  return map;
}

// ─── Excel de saída ───────────────────────────────────────────────────────────

function buildMeliBaseSheetRows(finalRows) {
  const headers = [
    "# de anúncio", "Título do anúncio",
    "Unidades", "Cancelamentos", "Unidades líquidas",
    "Preço unitário de venda do anúncio (BRL)", "Venda Total", "Total (BRL)",
    "Imposto", "Preço de custo", "Preço de custo total",
    "Ajuste plataforma (BRL)", "LC", "MC",
  ];

  const aoa = [headers];

  for (const row of finalRows) {
    aoa.push([
      row["# de anúncio"],
      row["Título do anúncio"],
      row.Unidades,
      row.Cancelamentos ?? 0,
      row["Unidades líquidas"] ?? row.Unidades,
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
  const nRows = finalRows.length;
  const colCount = headers.length;

  for (let ri = 2; ri <= nRows + 1; ri++) {
    for (let ci = 0; ci < colCount; ci++) {
      const addr = XLSX.utils.encode_cell({ r: ri - 1, c: ci });
      if (!sheet[addr]) continue;
      const h = headers[ci];
      if (h.includes("BRL") || h.includes("Total") || h.includes("custo") || h === "LC") {
        sheet[addr].z = "R$ #,##0.00";
      } else if (h === "MC" || h === "Imposto") {
        sheet[addr].z = "0.00%";
      }
    }
  }

  sheet["!cols"] = headers.map((h) => {
    if (h === "Título do anúncio") return { wch: 55 };
    if (h === "# de anúncio")      return { wch: 16 };
    if (h.includes("BRL") || h.includes("Total") || h.includes("Venda"))
      return { wch: 20 };
    return { wch: 14 };
  });

  sheet["!autofilter"] = { ref: `A1:${XLSX.utils.encode_col(colCount - 1)}1` };

  return sheet;
}

// ─── Alocação proporcional ────────────────────────────────────────────────────

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

// ─── Processamento principal ──────────────────────────────────────────────────

const ESTADO_CANCELADO = /cancelad|devolu[çc]|reembolso|mediacao|media[çc]ao|reemb/i;

/**
 * @param {object[]} salesRowsRaw  Linhas da aba "Vendas BR" (ou primeira aba)
 * @param {object[]} costRowsRaw   Linhas da planilha de custos
 * @param {number}   ads
 * @param {number}   venforce
 * @param {number}   affiliates
 */
function processMeli(salesRowsRaw, costRowsRaw, ads, venforce, affiliates) {
  const salesRows = parseMeliRows(salesRowsRaw);
  const costMap   = buildMeliCostMap(costRowsRaw);

  // Tarifas e reembolsos: acumulados de TODAS as linhas do Vendas BR
  const refundsTotal          = round2(salesRows.reduce((s, r) => s + r.cancelRefund, 0));
  const marketplaceFeesTotal  = round2(
    salesRows.reduce((s, r) => s + r.tarifaVenda + r.tarifaEnvio + r.descontosBonus, 0)
  );

  const finalRows         = [];
  const cancelledUnitsMap = new Map(); // adId normalizado → unidades canceladas
  const unmatchedIds      = new Set();
  const consumedIndexes   = new Set();
  let ignoredRevenue      = 0;

  function isMainRow(row) { return !row.adId && Math.abs(row.productRevenue) > 0; }
  function isItemRow(row) { return !!row.adId && row.units > 0; }

  function isCancelledRow(rawRow) {
    const estado = String(
      findField(rawRow || {}, ["estado", "descrição do status", "descricao do status"]) ?? ""
    ).trim();
    return ESTADO_CANCELADO.test(estado);
  }

  function addCancelledUnits(adId, units) {
    const id = normalizeId(adId);
    if (!id) return;
    const noPrefix = id.replace(/^MLB/i, "");
    cancelledUnitsMap.set(id, (cancelledUnitsMap.get(id) || 0) + units);
    if (noPrefix) cancelledUnitsMap.set(noPrefix, (cancelledUnitsMap.get(noPrefix) || 0) + units);
  }

  function computePlatformAdjustment(row) {
    const expected =
      (row.productRevenue || 0) +
      (row.tarifaVenda    || 0) +
      (row.tarifaEnvio    || 0) +
      (row.descontosBonus || 0);
    return round2(expected - (row.total || 0));
  }

  function getCostForAd(adId) {
    const normalized = normalizeId(adId);
    const noPrefix   = normalized.replace(/^MLB/i, "");
    return (
      costMap.get(normalized) ||
      costMap.get(noPrefix)   ||
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

    // Venda Total: Receita por produtos (BRL) > unidades * preço > |total rateado|
    const vendaTotal =
      item.productRevenue > 0
        ? round2(item.productRevenue)
        : price > 0
          ? round2(units * price)
          : round2(Math.abs(totalRateado));

    const impostoPercent  = round2(cost.taxPercent || 0);
    const impostoDec      = impostoPercent > 1 ? impostoPercent / 100 : impostoPercent;
    const precoCusto      = round2(cost.cost || 0);
    const precoCustoTotal = round2(units * precoCusto);
    const totalFormatado  = round2(totalRateado);

    // LC por linha (Excel): vendaTotal - imposto - CMV (tarifas de plataforma no resumo)
    let lc = 0;
    let mc = 0;
    if (vendaTotal > 0) {
      lc = round2(vendaTotal - (vendaTotal * impostoDec) - precoCustoTotal);
      mc = round2((lc / vendaTotal) * 100);
    } else if (totalFormatado < 0) {
      lc = round2(totalFormatado);
      mc = 0;
    }

    finalRows.push({
      "# de anúncio":                             id,
      "Título do anúncio":                        item.title,
      Unidades:                                   units,
      "Preço unitário de venda do anúncio (BRL)": price,
      "Venda Total":                              vendaTotal,
      "Total (BRL)":                              totalFormatado,
      Imposto:                                    impostoPercent,
      "Preço de custo":                           precoCusto,
      "Preço de custo total":                     precoCustoTotal,
      "Ajuste plataforma (BRL)":                  round2(ajustePlataforma),
      LC:                                         lc,
      MC:                                         mc,
    });
  }

  // ── Loop principal ──
  for (let i = 0; i < salesRows.length; i++) {
    if (consumedIndexes.has(i)) continue;

    const current    = salesRows[i];
    const currentRaw = salesRowsRaw[i] || {};

    if (isMainRow(current)) {
      const mainCancelled = isCancelledRow(currentRaw);
      const children      = [];
      let j = i + 1;

      while (j < salesRows.length) {
        const next = salesRows[j];
        if (isMainRow(next)) break;
        if (next.saleDate !== current.saleDate) break;
        if (!isItemRow(next)) break;
        children.push({ row: next, rawRow: salesRowsRaw[j] || {}, index: j });
        j++;
      }

      if (children.length > 0) {
        const childRows       = children.map((c) => c.row);
        const totalRateado    = allocateByUnits(current.total, childRows);
        const ajusteParent    = computePlatformAdjustment(current);
        const ajustesRateados = allocateByUnits(ajusteParent, childRows);

        for (let k = 0; k < children.length; k++) {
          const childCancelled = mainCancelled || isCancelledRow(children[k].rawRow);
          if (childCancelled) {
            addCancelledUnits(children[k].row.adId || children[k].row.adIdRaw, children[k].row.units);
          } else {
            pushCalculatedRow(children[k].row, totalRateado[k], ajustesRateados[k]);
          }
          consumedIndexes.add(children[k].index);
        }
      }

      consumedIndexes.add(i);
      continue;
    }

    if (isItemRow(current)) {
      if (isCancelledRow(currentRaw)) {
        addCancelledUnits(current.adId || current.adIdRaw, current.units);
      } else {
        pushCalculatedRow(current, current.total, computePlatformAdjustment(current));
      }
      consumedIndexes.add(i);
    }
  }

  // ── Agregação por anúncio ──
  const groupedMap = new Map();
  for (const row of finalRows) {
    const id = row["# de anúncio"];
    if (!groupedMap.has(id)) {
      groupedMap.set(id, { ...row });
    } else {
      const acc = groupedMap.get(id);
      acc.Unidades                   = round2(acc.Unidades + row.Unidades);
      acc["Venda Total"]             = round2(acc["Venda Total"] + row["Venda Total"]);
      acc["Total (BRL)"]             = round2(acc["Total (BRL)"] + row["Total (BRL)"]);
      acc["Preço de custo total"]    = round2(acc["Preço de custo total"] + row["Preço de custo total"]);
      acc["Ajuste plataforma (BRL)"] = round2(acc["Ajuste plataforma (BRL)"] + row["Ajuste plataforma (BRL)"]);
      acc.LC                         = round2(acc.LC + row.LC);
    }
  }

  // ── Pós-agregação: unidades canceladas (detectadas via Estado) e recálculo de custo/LC ──
  const aggregatedRows = Array.from(groupedMap.values()).map((row) => {
    const id         = row["# de anúncio"];
    const noPrefix   = id.replace(/^MLB/i, "");
    const cancelamentos   = cancelledUnitsMap.get(id) || cancelledUnitsMap.get(noPrefix) || 0;
    const netUnidades     = Math.max(round2(row.Unidades - cancelamentos), 0);
    const precoCusto      = row["Preço de custo"];
    const precoCustoTotal = round2(netUnidades * precoCusto);

    const vendaTotal     = row["Venda Total"];
    const impostoPercent = row["Imposto"];
    const impostoDec     = impostoPercent > 1 ? impostoPercent / 100 : impostoPercent;

    const lc = vendaTotal > 0
      ? round2(vendaTotal - (vendaTotal * impostoDec) - precoCustoTotal)
      : round2(row.LC);
    const mc = vendaTotal > 0 ? round2((lc / vendaTotal) * 100) : 0;

    return {
      ...row,
      Cancelamentos:         cancelamentos,
      "Unidades líquidas":   netUnidades,
      "Preço de custo total": precoCustoTotal,
      LC:                    lc,
      MC:                    mc,
    };
  });

  // ── Resumo ────────────────────────────────────────────────────────────────
  const grossRevenueTotal = round2(aggregatedRows.reduce((s, r) => s + r["Venda Total"], 0));
  // refundsTotal já é negativo (soma de cancelRefund das linhas do Vendas BR)
  const paidRevenueTotal  = round2(grossRevenueTotal + refundsTotal);

  const cmvTotal = round2(aggregatedRows.reduce((s, r) => s + r["Preço de custo total"], 0));
  const taxTotal = round2(
    aggregatedRows.reduce((s, r) => {
      const dec = r["Imposto"] > 1 ? r["Imposto"] / 100 : r["Imposto"];
      return s + r["Venda Total"] * dec;
    }, 0)
  );

  // contributionProfitTotal = paidRevenue + tarifas (negativas) - CMV - imposto
  const contributionProfitTotal = round2(
    paidRevenueTotal + marketplaceFeesTotal - cmvTotal - taxTotal
  );

  const averageContributionMargin =
    paidRevenueTotal > 0 ? round2(contributionProfitTotal / paidRevenueTotal) : 0;

  const finalResult = round2(contributionProfitTotal - ads - venforce - affiliates);
  const tacos = paidRevenueTotal > 0 ? round2(ads / paidRevenueTotal) : 0;
  const tacox = paidRevenueTotal > 0 ? round2((ads + venforce + affiliates) / paidRevenueTotal) : 0;

  const platformAdjustmentTotal =
    round2(aggregatedRows.reduce((s, r) => s + r["Ajuste plataforma (BRL)"], 0));
  const platformAdjustmentRowsCount =
    aggregatedRows.filter((r) => Math.abs(r["Ajuste plataforma (BRL)"]) > 0.01).length;

  return {
    summary: {
      grossRevenueTotal,
      refundsTotal,
      paidRevenueTotal,
      cmvTotal,
      taxTotal,
      marketplaceFeesTotal,
      contributionProfitTotal,
      averageContributionMargin,
      finalResult,
      tacos,
      tacox,
      platformAdjustmentTotal,
      platformAdjustmentRowsCount,
    },
    preparedRows:           aggregatedRows,
    detailedRows:           aggregatedRows,
    auditRows:              [],
    excelFileName:          "fechamento-meli.xlsx",
    unmatchedIds:           Array.from(unmatchedIds),
    ignoredRowsWithoutCost: unmatchedIds.size,
    ignoredRevenue:         round2(ignoredRevenue),
    message:
      unmatchedIds.size > 0
        ? "Alguns anúncios do MELI não possuem custo cadastrado e foram ignorados."
        : "OK",
  };
}

module.exports = {
  parseMeliRows,
  parseMeliCostRows,
  buildMeliCostMap,
  buildMeliBaseSheetRows,
  allocateByUnits,
  processMeli,
};
