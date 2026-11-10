// server/services/fechamentoFinanceiro/meliFinanceiroService.js
// Lógica de fechamento financeiro do Mercado Livre. A extração aceita as
// variações atuais dos cabeçalhos sem alterar as fórmulas financeiras.

const XLSX = require("xlsx");
const { toNumber, round2 } = require("../../utils/numberUtils");
const {
  normalizeId,
  normalizeIdNoPrefix,
  normalizeHeaderName,
  normalizeText,
  findField,
} = require("../../utils/textUtils");
const { MELI_HEADER_FIELDS } = require("../../utils/excelUtils");
const {
  allocateByRevenue,
  buildCoverage,
  classifyMeliSaleStatus,
  computeTacos,
  computeTacox,
  isMeliStatusOutOfProfit,
  legacyRatio,
  safeRatio,
} = require("../../utils/fechamento/financeiroShared");

// Presença REAL do campo na planilha. toNumber("") === 0, então sem esta
// checagem um campo financeiro ainda não publicado pelo Mercado Livre vira
// zero e passa a valer como "tarifa zero" / "repasse zero" no cálculo.
// Zero explícito ("0") é presença; vazio/ausente não é.
function hasFieldValue(row, candidates) {
  return String(findField(row, candidates) ?? "").trim() !== "";
}

// Pacote de diversos produtos (export de vendas, out/2026): a linha
// financeira do pacote diz "Pacote de N produtos" no Estado e cada produto
// traz a coluna "Pacote de diversos produtos" = Sim.
const PACK_PARENT_STATUS = /^(?:pacote|paquete) de (\d+) (?:produtos?|productos?)$/;
const PACK_MEMBER_FIELDS = [
  "pacote de diversos produtos",
  "paquete de varios productos",
];

function parseMeliRows(rows) {
  return rows.map((row, index) => {
    const saleNumber = String(
      findField(row, MELI_HEADER_FIELDS.saleNumber) ?? ""
    ).trim();

    const saleDate = String(
      findField(row, MELI_HEADER_FIELDS.saleDate) ?? ""
    ).trim();

    const adIdRaw = String(
      findField(row, MELI_HEADER_FIELDS.adId) ?? ""
    ).trim();

    const modelIdRaw = String(
      findField(row, ["model id", "model_id", "modelid", "modelo"]) ?? ""
    ).trim();

    const skuRaw = String(
      findField(row, ["sku", "seller sku", "codigo sku", "código sku"]) ?? ""
    ).trim();

    const packSizeMatch = PACK_PARENT_STATUS.exec(
      normalizeText(findField(row, ["estado"]))
    );
    const packFlag = normalizeText(findField(row, PACK_MEMBER_FIELDS));

    return {
      rowIndex: index,
      saleNumber,
      saleDate,
      hasProductRevenue: hasFieldValue(row, MELI_HEADER_FIELDS.productRevenue),
      hasSaleFee: hasFieldValue(row, MELI_HEADER_FIELDS.saleFee),
      hasShippingFee: hasFieldValue(row, MELI_HEADER_FIELDS.shippingFee),
      hasFinancialTotal: hasFieldValue(row, MELI_HEADER_FIELDS.total),
      units: toNumber(findField(row, MELI_HEADER_FIELDS.units)),
      total: toNumber(findField(row, MELI_HEADER_FIELDS.total)),
      productRevenue: toNumber(findField(row, MELI_HEADER_FIELDS.productRevenue)),
      cancelRefund: toNumber(findField(row, MELI_HEADER_FIELDS.refund)),
      tarifaVenda: toNumber(findField(row, MELI_HEADER_FIELDS.saleFee)),
      tarifaEnvio: toNumber(findField(row, MELI_HEADER_FIELDS.shippingFee)),
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
        findField(row, MELI_HEADER_FIELDS.unitPrice)
      ),
      statusKind: classifyMeliSaleStatus(row),
      modelIdRaw,
      skuRaw,
      // N declarado pela linha financeira do pacote (0 = não declara) e a
      // marca do produto (null = coluna ausente ou vazia).
      packSize: packSizeMatch ? Number(packSizeMatch[1]) : 0,
      packMember: packFlag === "sim" || packFlag === "si"
        ? true
        : packFlag === "nao" || packFlag === "no"
          ? false
          : null,
    };
  });
}

// Linha financeira agregada da venda: carrega receita/taxas/total, mas não o
// anúncio. Alguns exports preenchem só parte dos componentes financeiros.
function isMainRow(row) {
  if (!row || row.adId) return false;
  return [
    row.productRevenue,
    row.total,
    row.tarifaVenda,
    row.tarifaEnvio,
    row.cancelRefund,
    row.descontosBonus,
  ].some((value) => Math.abs(Number(value || 0)) > 0);
}

// Linha de produto bruta. No formato pai/filho real ela pode conter somente
// MLB, título e preço unitário — unidades, data e venda ficam vazios.
function isDetailRow(row) {
  return Boolean(row?.adId);
}

// Produto pronto para o motor financeiro, depois de herdar o contexto da
// venda principal ou quando já veio completo em uma linha independente.
function isEffectiveItemRow(row) {
  return Boolean(row?.adId) && Number(row?.units || 0) > 0;
}

function detailHasOwnFinancials(detail) {
  return Boolean(
    detail?.hasProductRevenue ||
    detail?.hasFinancialTotal ||
    detail?.hasSaleFee ||
    detail?.hasShippingFee ||
    Math.abs(Number(detail?.cancelRefund || 0)) > 0 ||
    Math.abs(Number(detail?.descontosBonus || 0)) > 0
  );
}

// Produto do pacote do pai: no export real cada produto do pacote tem o SEU
// N.º de venda, mas nenhum campo financeiro — receita, tarifas e Total só
// existem na linha do pacote. Exige essa ausência E uma marca de pacote (a
// do produto ou o "Pacote de N produtos" do pai); posição sozinha não basta.
function detailBelongsToParentPack(parent, detail) {
  if (detailHasOwnFinancials(detail)) return false;
  return detail.packMember === true || Number(parent?.packSize) > 0;
}

// Outro N.º de venda começa outra venda — exceto produto do pacote do pai.
// Venda com financeiro próprio nunca é anexada ao grupo anterior.
function detailStartsAnotherSale(parent, detail) {
  return Boolean(
    parent?.saleNumber &&
    detail?.saleNumber &&
    String(parent.saleNumber) !== String(detail.saleNumber) &&
    !detailBelongsToParentPack(parent, detail)
  );
}

function collectMeliAssociations(parsedRows) {
  const groups = [];
  const associatedIndexes = new Set();

  for (let i = 0; i < parsedRows.length; i++) {
    const parent = parsedRows[i];
    if (!isMainRow(parent)) continue;

    const details = [];
    const detailIndexes = [];
    let j = i + 1;
    while (j < parsedRows.length) {
      const next = parsedRows[j];
      if (isMainRow(next)) break;
      if (!isDetailRow(next)) break;
      if (detailStartsAnotherSale(parent, next)) break;
      // O pai declara quantos produtos o pacote tem: o bloco termina no N-ésimo.
      if (parent.packSize > 0 && details.length >= parent.packSize) break;
      details.push(next);
      detailIndexes.push(j);
      j += 1;
    }

    if (details.length > 0) {
      groups.push({ parent, parentIndex: i, details, detailIndexes });
      detailIndexes.forEach((index) => associatedIndexes.add(index));
    }
  }

  const standaloneItems = parsedRows
    .map((row, index) => ({ row, index }))
    .filter(({ row, index }) =>
      !associatedIndexes.has(index) && !isMainRow(row) && isEffectiveItemRow(row)
    );

  return { groups, associatedIndexes, standaloneItems };
}

function allocateParentValue(value, items) {
  if (Math.abs(Number(value || 0)) <= 0) return items.map(() => 0);
  return allocateByRevenue(value, items);
}

function enrichDetailsFromMain(parent, details, diagnostics) {
  const missingUnits = details.filter((detail) => !(Number(detail.units) > 0));
  const saleLabel = parent.saleNumber || `linha ${parent.rowIndex + 1}`;

  if (details.length === 1 && missingUnits.length === 1) {
    if (!(Number(parent.units) > 0)) {
      throw createMeliParsingError(
        `Não foi possível determinar as unidades do produto da venda ${saleLabel}.`,
        diagnostics
      );
    }
  } else if (details.length > 1 && missingUnits.length > 0) {
    throw createMeliParsingError(
      `Não foi possível determinar com segurança as unidades dos produtos da venda ${saleLabel}: ` +
      "há vários detalhes com MLB e pelo menos um deles não informa unidades.",
      diagnostics
    );
  }

  const items = details.map((detail) => ({
    ...detail,
    saleNumber: detail.saleNumber || parent.saleNumber,
    saleDate: detail.saleDate || parent.saleDate,
    statusKind: detail.statusKind !== "other" ? detail.statusKind : parent.statusKind,
    units: Number(detail.units) > 0 ? detail.units : parent.units,
  }));

  const allocationProbe = allocateByRevenue(1, items);
  if (items.length > 0 && round2(allocationProbe.reduce((sum, value) => sum + value, 0)) !== 1) {
    throw createMeliParsingError(
      `Não foi possível ratear com segurança os valores da venda ${saleLabel} entre seus produtos.`,
      diagnostics
    );
  }

  const productRevenue = allocateParentValue(parent.productRevenue, items);
  const total = allocateParentValue(parent.total, items);
  const tarifaVenda = allocateParentValue(parent.tarifaVenda, items);
  const tarifaEnvio = allocateParentValue(parent.tarifaEnvio, items);
  const cancelRefund = allocateParentValue(parent.cancelRefund, items);
  const descontosBonus = allocateParentValue(parent.descontosBonus, items);
  const platformAdjustment = allocateParentValue(
    (parent.productRevenue || 0) +
      (parent.tarifaVenda || 0) +
      (parent.tarifaEnvio || 0) +
      (parent.descontosBonus || 0) -
      (parent.total || 0),
    items
  );

  return items.map((item, index) => ({
    ...item,
    productRevenue: productRevenue[index],
    total: total[index],
    tarifaVenda: tarifaVenda[index],
    tarifaEnvio: tarifaEnvio[index],
    cancelRefund: cancelRefund[index],
    descontosBonus: descontosBonus[index],
    platformAdjustment: platformAdjustment[index],
    parentRowIndex: parent.rowIndex,
    // Os componentes financeiros do filho vêm rateados do pai: a
    // disponibilidade financeira do filho é a do pai, não a da própria linha.
    hasProductRevenue: parent.hasProductRevenue,
    hasSaleFee: parent.hasSaleFee,
    hasShippingFee: parent.hasShippingFee,
    hasFinancialTotal: parent.hasFinancialTotal,
  }));
}

function rowHasData(row) {
  return Object.values(row || {}).some(
    (value) => value !== null && value !== undefined && String(value).trim() !== ""
  );
}

function analyzeMeliParsing(rows) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const parsedRows = parseMeliRows(sourceRows);
  const revenueAliases = [
    ...MELI_HEADER_FIELDS.total,
    ...MELI_HEADER_FIELDS.productRevenue,
    ...MELI_HEADER_FIELDS.unitPrice,
  ].map(normalizeHeaderName);
  const revenueHeaders = Array.from(new Set(
    sourceRows.flatMap((row) => Object.keys(row || {}).filter((key) => {
      const normalized = normalizeHeaderName(key);
      return revenueAliases.some(
        (alias) => normalized === alias || ` ${normalized} `.includes(` ${alias} `)
      );
    }))
  ));
  let unparsedRevenueCells = 0;
  for (const row of sourceRows) {
    for (const header of revenueHeaders) {
      const raw = row?.[header];
      const text = String(raw ?? "").trim();
      if (text && /[1-9]/.test(text) && toNumber(raw) === 0) {
        unparsedRevenueCells += 1;
      }
    }
  }
  const mainRows = parsedRows.filter(isMainRow);
  const detailRows = parsedRows.filter(isDetailRow);
  const associations = collectMeliAssociations(parsedRows);
  // Pacote que não fecha com a própria linha financeira (export cortado, N
  // declarado ≠ produtos encontrados, Σ unidades × preço ≠ receita do pai):
  // o rateio continua o mesmo, mas o fechamento avisa em vez de calar.
  const packGroups = associations.groups.filter((group) => group.parent.packSize > 0);
  const incompletePacks = packGroups.filter((group) => {
    if (group.details.length !== group.parent.packSize) return true;
    if (!(Math.abs(group.parent.productRevenue) > 0)) return false;
    const childrenRevenue = group.details.reduce(
      (sum, detail) => sum + Number(detail.units || 0) * Number(detail.unitSalePrice || 0),
      0
    );
    return Math.abs(round2(childrenRevenue) - round2(group.parent.productRevenue)) > 0.01;
  });
  const standaloneSaleKeys = new Set(
    associations.standaloneItems.map(({ row }) => row.saleNumber || `linha:${row.rowIndex + 1}`)
  );
  const standaloneRevenue = associations.standaloneItems.reduce((sum, { row }) => {
    const gross = row.unitSalePrice > 0
      ? row.units * row.unitSalePrice
      : Math.abs(row.productRevenue || row.total || 0);
    return sum + gross;
  }, 0);
  const associatedRevenue = associations.groups.reduce(
    (sum, group) => sum + Math.abs(group.parent.productRevenue || group.parent.total || 0),
    0
  );

  return {
    parsedRows,
    totalRowsRead: sourceRows.filter(rowHasData).length,
    rowsWithSaleNumber: parsedRows.filter((row) => !!row.saleNumber).length,
    rowsWithAd: parsedRows.filter((row) => !!row.adId).length,
    rowsWithUnits: parsedRows.filter((row) => row.units > 0).length,
    mainRowsCount: mainRows.length,
    detailRowsCount: detailRows.length,
    itemRowsCount: detailRows.length,
    recognizedRowsCount: mainRows.length + detailRows.length,
    recognizedSalesCount: associations.groups.length + standaloneSaleKeys.size,
    associatedItemsCount:
      associations.groups.reduce((sum, group) => sum + group.details.length, 0) +
      associations.standaloneItems.length,
    packGroupsCount: packGroups.length,
    incompletePackSales: incompletePacks.map(
      (group) => group.parent.saleNumber || `linha ${group.parent.rowIndex + 1}`
    ),
    sourceRevenueFound: round2(associatedRevenue + standaloneRevenue),
    detectedRevenueHeaders: revenueHeaders,
    unparsedRevenueCells,
    financialRowsCount: 0,
    revenueFound: 0,
    validEmpty: sourceRows.filter(rowHasData).length === 0,
  };
}

function createMeliParsingError(message, diagnostics) {
  const error = new Error(message);
  error.statusCode = 422;
  error.diagnostics = { ...diagnostics };
  delete error.diagnostics.parsedRows;
  return error;
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
        "custos",
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

    const skuRaw = findField(row, [
      "sku",
      "seller sku",
      "codigo sku",
      "código sku",
      "codigo do sku",
    ]);
    const sku = String(skuRaw ?? "").trim();

    parsed.push({
      id: normalizedId,
      modelId,
      sku,
      cost: round2(cost),
      taxPercent: round2(taxPercent),
    });
  }

  return parsed;
}

// Assinatura financeira do custo. Dois registros do mesmo MLB só são
// equivalentes se custo E imposto coincidirem.
function costSignature(row) {
  return `${round2(row.cost || 0)}|${round2(row.taxPercent || 0)}`;
}

// Identificador de variação: model_id tem precedência sobre SKU.
function variationKeyOf(row) {
  const model = String(row?.modelId ?? row?.modelIdRaw ?? "").trim();
  if (model) return `model:${model.toLowerCase()}`;
  const sku = String(row?.sku ?? row?.skuRaw ?? "").trim();
  if (sku) return `sku:${sku.toLowerCase()}`;
  return "";
}

function variationLookupKeys(id, row) {
  const keys = [];
  const model = String(row?.modelId ?? row?.modelIdRaw ?? "").trim();
  const sku = String(row?.sku ?? row?.skuRaw ?? "").trim();
  if (model) keys.push(`${id}::model:${model.toLowerCase()}`);
  if (sku) keys.push(`${id}::sku:${sku.toLowerCase()}`);
  return keys;
}



// Índice de custos com detecção de duplicidade.
//
// Regra: o mesmo MLB com custos divergentes NUNCA resolve silenciosamente no
// primeiro registro. Se os registros divergentes tiverem identificador de
// variação (model_id/SKU), cada variação fica endereçável por
// `MLB::model:x` / `MLB::sku:y` e só o acesso pelo MLB "pelado" é ambíguo.
// Sem identificador de variação, o MLB inteiro é ambíguo e é bloqueado.
function buildMeliCostIndex(rows) {
  const parsed = parseMeliCostRows(rows);
  const map = new Map();
  const conflicts = [];

  const byId = new Map();
  for (const row of parsed) {
    if (!row.id) continue;
    if (!byId.has(row.id)) byId.set(row.id, []);
    byId.get(row.id).push(row);
  }

  const aliasSet = (id, entry) => {
    const noPrefix = id.replace(/^MLB/i, "");
    for (const key of [id, noPrefix, `MLB${noPrefix}`]) {
      if (key && !map.has(key)) map.set(key, entry);
    }
  };

  for (const [id, group] of byId) {
    const signatures = new Set(group.map(costSignature));

    // Caminho normal e inalterado: um único custo para o MLB.
    if (signatures.size === 1) {
      const entry = group[0];
      aliasSet(id, entry);
      for (const row of group) {
        for (const key of variationLookupKeys(id, row)) {
          if (!map.has(key)) map.set(key, entry);
        }
      }
      if (entry.modelId) {
        const mNorm = normalizeId(entry.modelId);
        if (mNorm) aliasSet(mNorm, entry);
      }
      continue;
    }

    // Divergência: registra o conflito com os valores em disputa.
    const conflictingValues = Array.from(signatures).map((signature) => {
      const [cost, taxPercent] = signature.split("|");
      return { cost: Number(cost), taxPercent: Number(taxPercent) };
    });

    const variationKeys = group.map(variationKeyOf);
    const everyRowHasVariation = variationKeys.every(Boolean);
    const variationsAreUnique =
      new Set(variationKeys).size === variationKeys.length;
    const resolvableByVariation = everyRowHasVariation && variationsAreUnique;

    conflicts.push({
      id,
      values: conflictingValues,
      resolvableByVariation,
      variations: resolvableByVariation ? variationKeys : [],
    });

    if (resolvableByVariation) {
      for (const row of group) {
        for (const key of variationLookupKeys(id, row)) {
          if (!map.has(key)) map.set(key, row);
        }
      }
    }

    // Sem variação para desempatar, o MLB "pelado" fica bloqueado.
    const ambiguous = { id, ambiguous: true, values: conflictingValues, resolvableByVariation };
    aliasSet(id, ambiguous);
  }

  return { map, conflicts };
}

// Compatibilidade: consumidores externos esperam apenas o Map.
function buildMeliCostMap(rows) {
  return buildMeliCostIndex(rows).map;
}



// LEGADO: rateio por quantidade. Mantido apenas por compatibilidade de import
// (server/index.js). O fechamento usa allocateByRevenue — rateio por valor
// vendido, ver utils/fechamento/financeiroShared.js.
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

  // Célula vazia quando o número é desconhecido — nunca 0 falso.
  const cell = (value) =>
    value === null || value === undefined ? "" : value;
  const percentCell = (value) =>
    value === null || value === undefined ? "" : value / 100;

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
    "Cobertura de custo",
  ]);

  for (const row of finalRows) {
    aoa.push([
      row["# de anúncio"],
      row["Título do anúncio"],
      row.Unidades,
      row["Preço unitário de venda do anúncio (BRL)"],
      row["Venda Total"],
      cell(row["Total (BRL)"]),
      percentCell(row["Imposto"]),
      cell(row["Preço de custo"]),
      cell(row["Preço de custo total"]),
      cell(row["Ajuste plataforma (BRL)"]),
      cell(row.LC),
      percentCell(row.MC),
      row["Cobertura de custo"] || "com custo",
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
    { wch: 18 },
  ];

  sheet["!autofilter"] = { ref: "A1:M1" };

  return sheet;
}



// debugCollector é opcional (só vem do Debug Financeiro). Sem ele, o
// resultado de processMeli() é IDÊNTICO ao anterior — cada ponto de
// instrumentação abaixo é guardado por `if (debugCollector)`.
function processMeli(
  salesRowsRaw,
  costRowsRaw,
  ads,
  venforce,
  affiliates,
  fullCost = 0,
  additionalCosts = 0,
  debugCollector = null
) {
  const parsingDiagnostics = analyzeMeliParsing(salesRowsRaw);
  const salesRows = parsingDiagnostics.parsedRows;
  const { map: costMap, conflicts: costConflicts } = buildMeliCostIndex(costRowsRaw);
  const associations = collectMeliAssociations(salesRows);
  const groupByParentIndex = new Map(
    associations.groups.map((group) => [group.parentIndex, group])
  );

  if (
    parsingDiagnostics.totalRowsRead > 0 &&
    parsingDiagnostics.recognizedRowsCount === 0
  ) {
    throw createMeliParsingError(
      "Não foi possível reconhecer as vendas desta planilha do Mercado Livre. Verifique o formato ou os cabeçalhos.",
      parsingDiagnostics
    );
  }
  if (
    parsingDiagnostics.totalRowsRead > 0 &&
    parsingDiagnostics.itemRowsCount > 0 &&
    parsingDiagnostics.detectedRevenueHeaders.length === 0
  ) {
    throw createMeliParsingError(
      "Não foi possível reconhecer as colunas de receita desta planilha do Mercado Livre. Verifique o formato ou os cabeçalhos.",
      parsingDiagnostics
    );
  }

  const finalRows = [];
  const unmatchedIds = new Set();
  const ambiguousCostIds = new Set();
  const consumedIndexes = new Set();
  const excludedStatusRows = [];
  let ignoredRevenue = 0;

  // Eixos independentes de cobertura, somados na origem porque LC === null
  // passou a ter duas causas distintas (sem custo OU financeiro pendente).
  let revenueWithCost = 0;
  let revenueWithoutCost = 0;
  let revenueWithFinancialData = 0;
  let revenuePendingFinancial = 0;
  let revenueCalculable = 0;
  let salesWithFinancialDataCount = 0;
  let salesPendingFinancialCount = 0;

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

  function computePlatformAdjustment(row) {
    const expected =
      (row.productRevenue || 0) +
      (row.tarifaVenda || 0) +
      (row.tarifaEnvio || 0) +
      (row.descontosBonus || 0);
    return round2(expected - (row.total || 0));
  }

  // saleNumberOf() só serve para nomear a tentativa no Debug Financeiro —
  // não influencia o resultado do lookup.
  function saleNumberOf(item) {
    return (item && item.saleNumber) || null;
  }

  function getCostForAd(adId, item) {
    const normalized = normalizeId(adId);
    const noPrefix = normalized.replace(/^MLB/i, "");

    for (const candidate of [
      { field: "mlb_normalizado", value: normalized },
      { field: "mlb_sem_prefixo", value: noPrefix },
      { field: "mlb_com_prefixo", value: `MLB${noPrefix}` },
    ]) {
      const hit = costMap.get(candidate.value);
      if (debugCollector) {
        debugCollector.recordMatchAttempt({
          engine: "meli",
          stage: "cost_lookup",
          orderId: saleNumberOf(item),
          field: candidate.field,
          rawValue: candidate.value || null,
          normalizedKey: candidate.value || null,
          result: hit ? "hit" : candidate.value ? "miss" : "skip",
        });
      }
      if (hit) return hit;
    }

    return null;
  }

  // Resolve o custo do item preferindo a variação (model_id/SKU). Só cai no
  // MLB "pelado" quando a venda não traz identificador de variação — e nesse
  // caso um MLB com custos divergentes devolve o marcador de ambiguidade.
  function resolveCostForItem(item, id) {
    for (const key of variationLookupKeys(id, item)) {
      const byVariation = costMap.get(key);
      if (debugCollector) {
        debugCollector.recordMatchAttempt({
          engine: "meli",
          stage: "cost_lookup",
          orderId: saleNumberOf(item),
          field: "variation_key",
          rawValue: key,
          normalizedKey: key,
          result: byVariation ? "hit" : "miss",
        });
      }
      if (byVariation) return byVariation;
    }
    if (item.modelIdRaw) {
      const byModel = getCostForAd(item.modelIdRaw, item);
      if (byModel) return byModel;
    } else if (debugCollector) {
      debugCollector.recordMatchAttempt({
        engine: "meli",
        stage: "cost_lookup",
        orderId: saleNumberOf(item),
        field: "model_id_raw",
        rawValue: null,
        normalizedKey: null,
        result: "skip",
      });
    }
    return getCostForAd(id, item);
  }

  // Item cancelado/devolvido/reembolsado/em mediação: sai do LC, mas NÃO
  // desaparece — vira linha de auditoria com o valor que lhe cabia no pedido.
  function registerExcludedRow(item, statusKind, totalRateado) {
    const id = normalizeId(item.adId || item.adIdRaw);
    const units = round2(item.units);
    const price = round2(item.unitSalePrice);
    const inheritedRevenue =
      item.parentRowIndex !== undefined && Math.abs(item.productRevenue) > 0;
    const vendaTotal =
      inheritedRevenue
        ? round2(Math.abs(item.productRevenue))
        : price > 0
        ? round2(units * price)
        : Math.abs(item.productRevenue) > 0
          ? round2(Math.abs(item.productRevenue))
          : round2(Math.abs(toNumber(totalRateado)));

    excludedStatusRows.push({
      "# de anúncio": id || item.adIdRaw || "SEM_ID",
      "Título do anúncio": item.title,
      Unidades: units,
      "Venda Total": vendaTotal,
      "Total rateado (BRL)": round2(toNumber(totalRateado)),
      "Status da venda": statusKind,
      Motivo: "Fora do LC por status da venda",
    });
  }

  function pushCalculatedRow(item, totalRateado, ajustePlataforma = 0) {
    const id = normalizeId(item.adId || item.adIdRaw);
    const cost = resolveCostForItem(item, id);
    const costIsAmbiguous = Boolean(cost && cost.ambiguous);
    const hasUsableCost = Boolean(cost && !costIsAmbiguous && cost.cost > 0);
    // Total (BRL) ausente = o Mercado Livre ainda não publicou tarifas e
    // repasse desta venda. Não é repasse zero.
    const financialAvailable = item.hasFinancialTotal === true;

    const units = round2(item.units);
    const price = round2(item.unitSalePrice);
    const inheritedRevenue =
      item.parentRowIndex !== undefined && Math.abs(item.productRevenue) > 0;
    const vendaTotal =
      inheritedRevenue
        ? round2(Math.abs(item.productRevenue))
        : price > 0
        ? round2(units * price)
        : Math.abs(item.productRevenue) > 0
          ? round2(Math.abs(item.productRevenue))
          : round2(Math.abs(totalRateado));

    if (hasUsableCost) revenueWithCost += vendaTotal;
    else revenueWithoutCost += vendaTotal;

    if (financialAvailable) {
      revenueWithFinancialData += vendaTotal;
      salesWithFinancialDataCount += 1;
    } else {
      revenuePendingFinancial += vendaTotal;
      salesPendingFinancialCount += 1;
    }
    if (financialAvailable && hasUsableCost) revenueCalculable += vendaTotal;

    if (costIsAmbiguous) ambiguousCostIds.add(id || item.adIdRaw || "SEM_ID");

    // Financeiro pendente: a venda e o faturamento continuam visíveis, mas
    // LC/MC ficam desconhecidos (null, nunca 0) — inclusive o ajuste de
    // plataforma, que é derivado das tarifas ainda não publicadas.
    if (!financialAvailable) {
      finalRows.push({
        "# de anúncio": id || item.adIdRaw || "SEM_ID",
        "Título do anúncio": item.title,
        Unidades: units,
        "Preço unitário de venda do anúncio (BRL)": price,
        "Venda Total": vendaTotal,
        "Total (BRL)": null,
        Imposto: hasUsableCost ? round2(cost.taxPercent || 0) : null,
        "Preço de custo": hasUsableCost ? round2(cost.cost || 0) : null,
        "Preço de custo total": hasUsableCost ? round2(units * round2(cost.cost || 0)) : null,
        "Ajuste plataforma (BRL)": null,
        LC: null,
        MC: null,
        "Cobertura de custo": "financeiro pendente",
      });
      return;
    }

    // Custo ausente ou ambíguo NÃO apaga faturamento: a linha entra no
    // fechamento com receita preservada e lucro desconhecido (null, nunca 0).
    if (!hasUsableCost) {
      if (!costIsAmbiguous) {
        unmatchedIds.add(id || item.adIdRaw || "SEM_ID");
      }
      ignoredRevenue += round2(totalRateado);

      finalRows.push({
        "# de anúncio": id || item.adIdRaw || "SEM_ID",
        "Título do anúncio": item.title,
        Unidades: units,
        "Preço unitário de venda do anúncio (BRL)": price,
        "Venda Total": vendaTotal,
        "Total (BRL)": round2(totalRateado),
        Imposto: null,
        "Preço de custo": null,
        "Preço de custo total": null,
        "Ajuste plataforma (BRL)": round2(ajustePlataforma),
        LC: null,
        MC: null,
        "Cobertura de custo": costIsAmbiguous ? "custo ambíguo" : "sem custo",
      });
      return;
    }

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
      "Cobertura de custo": "com custo",
    });
  }

  for (let i = 0; i < salesRows.length; i++) {
    if (consumedIndexes.has(i)) continue;

    const current = salesRows[i];

    if (isMainRow(current)) {
      const group = groupByParentIndex.get(i);

      if (group?.details.length > 0) {
        const effectiveItems = enrichDetailsFromMain(
          current,
          group.details,
          parsingDiagnostics
        );

        for (let k = 0; k < effectiveItems.length; k++) {
          const item = effectiveItems[k];
          if (isMeliStatusOutOfProfit(item.statusKind)) {
            registerExcludedRow(item, item.statusKind, item.total);
          } else {
            pushCalculatedRow(item, item.total, item.platformAdjustment);
          }
          consumedIndexes.add(group.detailIndexes[k]);
        }

        consumedIndexes.add(i);
        continue;
      }

      consumedIndexes.add(i);
      continue;
    }

    if (isEffectiveItemRow(current)) {
      if (isMeliStatusOutOfProfit(current.statusKind)) {
        registerExcludedRow(current, current.statusKind, current.total);
      } else {
        pushCalculatedRow(current, current.total, computePlatformAdjustment(current));
      }
      consumedIndexes.add(i);
    }
  }

  // Soma que preserva "desconhecido": null + null = null; null + número = número.
  const sumNullable = (a, b) => {
    if (a === null && b === null) return null;
    return round2(Number(a || 0) + Number(b || 0));
  };

  const groupedMap = new Map();
  for (const row of finalRows) {
    const id = row["# de anúncio"];
    if (!groupedMap.has(id)) {
      groupedMap.set(id, { ...row });
    } else {
      const acc = groupedMap.get(id);
      acc.Unidades              = round2(acc.Unidades + row.Unidades);
      acc["Venda Total"]        = round2(acc["Venda Total"] + row["Venda Total"]);
      // sumNullable preserva "desconhecido": um grupo inteiramente pendente
      // não pode virar Total 0.
      acc["Total (BRL)"]        = sumNullable(acc["Total (BRL)"], row["Total (BRL)"]);
      acc["Preço de custo total"] = sumNullable(acc["Preço de custo total"], row["Preço de custo total"]);
      acc["Ajuste plataforma (BRL)"] = sumNullable(acc["Ajuste plataforma (BRL)"], row["Ajuste plataforma (BRL)"]);
      acc.LC                    = sumNullable(acc.LC, row.LC);
      if (row["Cobertura de custo"] === "financeiro pendente" ||
          acc["Cobertura de custo"] === "financeiro pendente") {
        acc["Cobertura de custo"] =
          row["Cobertura de custo"] === acc["Cobertura de custo"]
            ? "financeiro pendente"
            : "parcial";
      } else if (row["Cobertura de custo"] === "sem custo") {
        acc["Cobertura de custo"] =
          acc["Cobertura de custo"] === "com custo" ? "parcial" : "sem custo";
      } else if (acc["Cobertura de custo"] === "sem custo") {
        acc["Cobertura de custo"] = "parcial";
      }
    }
  }
  const aggregatedRows = Array.from(groupedMap.values()).map((row) => ({
    ...row,
    MC:
      row.LC === null
        ? null
        : row["Venda Total"] > 0
          ? round2((row.LC / row["Venda Total"]) * 100)
          : 0,
  }));

  // LC !== null passou a significar "calculável": tem custo utilizável E
  // financeiro publicado. Os eixos de cobertura vêm dos acumuladores.
  const rowsCalculable = finalRows.filter((row) => row.LC !== null);

  // Faturamento reconhecido = TODAS as vendas processadas, com ou sem custo.
  const grossRevenueTotal = round2(
    finalRows.reduce((sum, row) => sum + Number(row["Venda Total"] || 0), 0)
  );

  parsingDiagnostics.financialRowsCount = finalRows.length;
  parsingDiagnostics.revenueFound = grossRevenueTotal;
  delete parsingDiagnostics.parsedRows;

  if (
    parsingDiagnostics.totalRowsRead > 0 &&
    parsingDiagnostics.recognizedSalesCount === 0
  ) {
    throw createMeliParsingError(
      "Não foi possível reconhecer as vendas desta planilha do Mercado Livre. Verifique o formato ou os cabeçalhos.",
      parsingDiagnostics
    );
  }
  if (parsingDiagnostics.totalRowsRead > 0 && finalRows.length === 0) {
    throw createMeliParsingError(
      "A planilha do Mercado Livre foi lida, mas nenhuma linha financeira de venda foi criada.",
      parsingDiagnostics
    );
  }
  if (
    parsingDiagnostics.totalRowsRead > 0 &&
    grossRevenueTotal === 0 &&
    (
      parsingDiagnostics.sourceRevenueFound > 0 ||
      parsingDiagnostics.unparsedRevenueCells > 0 ||
      parsingDiagnostics.detectedRevenueHeaders.length === 0
    )
  ) {
    throw createMeliParsingError(
      "A planilha contém valores de venda, mas a receita não pôde ser reconhecida. Verifique o formato ou os cabeçalhos.",
      parsingDiagnostics
    );
  }

  const revenueWithCostTotal = round2(revenueWithCost);
  const revenueWithoutCostTotal = round2(revenueWithoutCost);
  const revenueWithFinancialDataTotal = round2(revenueWithFinancialData);
  const revenuePendingFinancialTotal = round2(revenuePendingFinancial);
  const revenueCalculableTotal = round2(revenueCalculable);

  const paidRevenueTotal = round2(
    finalRows.reduce((sum, row) => sum + Number(row["Total (BRL)"] || 0), 0)
  );

  // Lucro calculável: só a parcela com custo identificado E financeiro
  // publicado. Vendas com financeiro pendente têm LC null e não entram.
  const contributionProfitTotal = round2(
    rowsCalculable.reduce((sum, row) => sum + Number(row["LC"] || 0), 0)
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

  const coverage = buildCoverage({
    revenueWithCost: revenueWithCostTotal,
    revenueWithoutCost: revenueWithoutCostTotal,
  });

  // Cobertura financeira: quanto do faturamento já tem tarifas e repasse
  // publicados pelo Mercado Livre. null = não há faturamento reconhecido.
  const financialDataCoveragePercent =
    grossRevenueTotal > 0
      ? round2((revenueWithFinancialDataTotal / grossRevenueTotal) * 100)
      : null;

  // Confiança nunca é "confiável" com financeiro pendente, mesmo que todos os
  // MLBs tenham custo cadastrado.
  const financialConfidence =
    revenuePendingFinancialTotal > 0 && coverage.financialConfidence === "confiavel"
      ? "parcial"
      : coverage.financialConfidence;

  // MC calculada usa o faturamento CALCULÁVEL: dividir pelo total mascararia a
  // margem real da parcela efetivamente calculada.
  const averageContributionMargin = legacyRatio(
    contributionProfitTotal,
    revenueCalculableTotal
  );

  const finalResult =
    contributionProfitTotal - ads - venforce - affiliates - fullCost - additionalCosts;

  // TACoS/TACoX sobre o faturamento TOTAL (inclui receita sem custo).
  const tacos = computeTacos(ads, grossRevenueTotal);
  const tacox = computeTacox(ads, venforce, affiliates, grossRevenueTotal);

  const excludedStatusRevenue = round2(
    excludedStatusRows.reduce((sum, row) => sum + Number(row["Venda Total"] || 0), 0)
  );

  const PENDING_FINANCIAL_WARNING =
    "Parte das vendas ainda não possui tarifas e repasse disponíveis no relatório " +
    "do Mercado Livre. LC, MC e Resultado Final consideram somente as vendas com " +
    "dados financeiros completos.";

  const costConflictWarnings = costConflicts.map((conflict) => {
    const valores = conflict.values
      .map((value) => `custo R$ ${value.cost.toFixed(2)} / imposto ${value.taxPercent}%`)
      .join(" vs ");
    return conflict.resolvableByVariation
      ? `Base de custos: ${conflict.id} possui custos diferentes por variação (${valores}). ` +
        "As vendas com model_id/SKU usam o custo da variação; sem identificador de variação o custo é ambíguo."
      : `Base de custos: ${conflict.id} possui custos divergentes (${valores}) sem identificador de variação. ` +
        "O cálculo deste anúncio foi bloqueado — corrija a base antes de fechar.";
  });

  const executiveNotes = [];
  if (unmatchedIds.size > 0) {
    executiveNotes.push(
      `Fechamento parcial: ${unmatchedIds.size} anúncio(s) sem custo cadastrado. ` +
        "O faturamento total está completo; LC, MC e Resultado Final cobrem apenas a receita com custo identificado."
    );
  }
  if (revenuePendingFinancialTotal > 0) {
    executiveNotes.push(PENDING_FINANCIAL_WARNING);
  }
  for (const warning of costConflictWarnings) {
    executiveNotes.push(warning);
  }
  const incompletePackSales = parsingDiagnostics.incompletePackSales || [];
  if (incompletePackSales.length > 0) {
    executiveNotes.push(
      `${incompletePackSales.length} pacote(s) com produtos que não fecham com a linha do pacote ` +
        `(${incompletePackSales.slice(0, 5).join(", ")}${incompletePackSales.length > 5 ? ", …" : ""}). ` +
        "O financeiro do pacote foi rateado entre os produtos encontrados — confira o export."
    );
  }
  if (excludedStatusRows.length > 0) {
    executiveNotes.push(
      `${excludedStatusRows.length} item(ns) fora do LC por status (cancelado/devolvido/reembolsado/mediação). ` +
        "Os valores continuam na aba de auditoria."
    );
  }

  return {
    emptySales: parsingDiagnostics.validEmpty,
    parsingDiagnostics,
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
      fullCostTotal: round2(fullCost),
      additionalCostsTotal: round2(additionalCosts),
      tacos,
      tacox,
      platformAdjustmentTotal,
      platformAdjustmentRowsCount,
      // ── Separação faturamento × cobertura de custos ──────────────────────
      calculationMode: "real_meli_vendas",
      revenueWithCost: coverage.revenueWithCost,
      revenueWithoutCost: coverage.revenueWithoutCost,
      calculatedCoveragePercent: coverage.calculatedCoveragePercent,
      financialConfidence,
      // ── Separação financeiro disponível × pendente ──────────────────────
      revenueWithFinancialData: revenueWithFinancialDataTotal,
      revenuePendingFinancial: revenuePendingFinancialTotal,
      revenueCalculable: revenueCalculableTotal,
      financialDataCoveragePercent,
      salesWithFinancialDataCount,
      salesPendingFinancialCount,
      pendingFinancialWarning:
        revenuePendingFinancialTotal > 0 ? PENDING_FINANCIAL_WARNING : null,
      costConflicts,
      costConflictWarnings,
      ambiguousCostIds: Array.from(ambiguousCostIds),
      contributionMarginCalculated: safeRatio(contributionProfitTotal, revenueCalculableTotal),
      finalMarginCalculated: safeRatio(finalResult, revenueCalculableTotal),
      profitCoversRevenue: revenueCalculableTotal,
      excludedStatusRevenue,
      excludedStatusCount: excludedStatusRows.length,
      adsTotal: round2(ads),
      venforceTotal: round2(venforce),
      affiliatesTotal: round2(affiliates),
      executiveNotes,
    },
    preparedRows: aggregatedRows,
    detailedRows: aggregatedRows,
    auditRows: excludedStatusRows,
    excelFileName: "fechamento-meli.xlsx",
    unmatchedIds: Array.from(unmatchedIds),
    ignoredRowsWithoutCost: unmatchedIds.size,
    ignoredRevenue: round2(ignoredRevenue),
    message:
      parsingDiagnostics.validEmpty
        ? "Planilha válida sem vendas."
        : unmatchedIds.size > 0
        ? "Alguns anúncios do MELI não possuem custo cadastrado. O faturamento foi preservado; LC e MC cobrem apenas a receita com custo."
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

    // Rateio proporcional ao valor vendido — mesma regra do fechamento legado.
    return {
      total: allocateByRevenue(sourceRow.total, componentRows),
      ajustePlataforma: allocateByRevenue(computePlatformAdjustment(sourceRow), componentRows),
      tarifaVenda: centralFieldHasValue(tarifaVendaField)
        ? allocateByRevenue(sourceRow.tarifaVenda, componentRows)
        : null,
      tarifaEnvio: centralFieldHasValue(tarifaEnvioField)
        ? allocateByRevenue(sourceRow.tarifaEnvio, componentRows)
        : null,
      cancelRefund: centralFieldHasValue(cancelRefundField)
        ? allocateByRevenue(sourceRow.cancelRefund, componentRows)
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
      _itensRegistrados: 0,
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

    pedido._itensRegistrados += 1;
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
    // Pedido em que todos os itens saíram por status não vira pedido fantasma.
    if (pedido._itensRegistrados === 0) {
      delete pedido._temResultado;
      delete pedido._itensRegistrados;
      return;
    }

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
    delete pedido._itensRegistrados;
    pedidos.push(pedido);
  }

  const itensForaDoLucro = [];

  for (let i = 0; i < salesRows.length; i++) {
    if (consumedIndexes.has(i)) continue;

    const current = salesRows[i];
    const currentRaw = salesRowsRaw[i] || {};
    const statusAtual = classifyMeliSaleStatus(currentRaw);

    if (isMeliStatusOutOfProfit(statusAtual) && !isMainRow(current)) {
      itensForaDoLucro.push({
        mlb: normalizeId(current.adId || current.adIdRaw) || null,
        titulo: current.title || null,
        quantidade: round2(current.units),
        valor: round2(current.total),
        status: statusAtual,
      });
      continue;
    }

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
          // Filho é classificado ANTES de ser consumido: cancelado/devolvido
          // não entra no lucro, mas continua registrado.
          const childStatus = classifyMeliSaleStatus(
            salesRowsRaw[childrenIndexes[k]] || {}
          );

          if (isMeliStatusOutOfProfit(childStatus)) {
            itensForaDoLucro.push({
              pedidoId: pedido.pedidoId,
              mlb: normalizeId(children[k].adId || children[k].adIdRaw) || null,
              titulo: children[k].title || null,
              quantidade: round2(children[k].units),
              valor: financials.total[k],
              status: childStatus,
            });
            consumedIndexes.add(childrenIndexes[k]);
            continue;
          }

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

  // Mesma regra de cobertura/confiança do fechamento legado (ETAPA 5).
  const cobertura = buildCoverage({
    revenueWithCost: faturamento,
    revenueWithoutCost: receitaBloqueada,
  });

  return {
    pedidos,
    itens,
    componentes,
    itensForaDoLucro,
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
      // Faturamento total = com custo + sem custo. A ausência de custo nunca
      // apaga faturamento; ela só limita o lucro calculável.
      faturamentoTotal: cobertura.revenueTotal,
      faturamentoComCusto: cobertura.revenueWithCost,
      receitaSemCusto: cobertura.revenueWithoutCost,
      coberturaCalculadaPercentual: cobertura.calculatedCoveragePercent,
      confiancaFechamento: cobertura.financialConfidence,
      itensForaDoLucroCount: itensForaDoLucro.length,
      totaisPorTipo,
    },
  };
}



module.exports = {
  parseMeliRows,
  analyzeMeliParsing,
  isMainRow,
  isDetailRow,
  isEffectiveItemRow,
  collectMeliAssociations,
  enrichDetailsFromMain,
  parseMeliCostRows,
  buildMeliCostMap,
  buildMeliCostIndex,
  buildMeliBaseSheetRows,
  allocateByUnits,
  allocateByRevenue,
  classifyMeliSaleStatus,
  processMeli,
  processMeliForCentralVendas,
  buildCentralCostMap,
  getCentralCostForAd,
};
