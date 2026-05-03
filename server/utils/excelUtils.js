// server/utils/excelUtils.js
// Helpers de leitura/parsing de planilhas XLSX, extraídos de server/index.js.
// NÃO alterar comportamento. detectMeliHeaderRow / detectShopeeHeaderRow
// dependem de repairWorksheetRef ter sido aplicado antes.

const XLSX = require("xlsx");
const { normalizeText } = require("./textUtils");

function repairWorksheetRef(sheet) {
  if (!sheet || typeof sheet !== "object") return sheet;

  const cells = Object.keys(sheet).filter((key) => key && key[0] !== "!");
  if (!cells.length) return sheet;

  let minR = Infinity;
  let minC = Infinity;
  let maxR = 0;
  let maxC = 0;

  for (const addr of cells) {
    try {
      const cell = XLSX.utils.decode_cell(addr);
      minR = Math.min(minR, cell.r);
      minC = Math.min(minC, cell.c);
      maxR = Math.max(maxR, cell.r);
      maxC = Math.max(maxC, cell.c);
    } catch (_) {
      // ignora chaves não compatíveis com endereço de célula
    }
  }

  if (Number.isFinite(minR) && Number.isFinite(minC)) {
    sheet["!ref"] = XLSX.utils.encode_range({
      s: { r: minR, c: minC },
      e: { r: maxR, c: maxC },
    });
  }

  return sheet;
}

function readSheetRows(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    throw new Error("A planilha enviada está vazia.");
  }

  const sheet = workbook.Sheets[firstSheetName];
  repairWorksheetRef(sheet);

  const rowsAsArrays = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  return { workbook, sheet, rowsAsArrays };
}

function parseSpreadsheet(fileBuffer, skipRows = 0) {
  const { sheet } = readSheetRows(fileBuffer);

  return XLSX.utils.sheet_to_json(sheet, {
    defval: "",
    raw: false,
    range: skipRows,
  });
}

function detectMeliHeaderRow(fileBuffer) {
  const { rowsAsArrays } = readSheetRows(fileBuffer);

  for (let i = 0; i < rowsAsArrays.length; i++) {
    const joined = (rowsAsArrays[i] || [])
      .map((cell) => normalizeText(cell))
      .join(" | ");

    if (
      joined.includes("n.º de venda") ||
      joined.includes("n.o de venda") ||
      joined.includes("nº de venda") ||
      joined.includes("# de anuncio") ||
      joined.includes("# de anúncio") ||
      joined.includes("receita por produtos") ||
      joined.includes("tarifa de venda e impostos")
    ) {
      return i;
    }
  }

  return 5;
}

function detectShopeeHeaderRow(fileBuffer) {
  const { rowsAsArrays } = readSheetRows(fileBuffer);

  for (let i = 0; i < rowsAsArrays.length; i++) {
    const joined = (rowsAsArrays[i] || [])
      .map((cell) => normalizeText(cell))
      .join(" | ");

    if (
      joined.includes("id do item") ||
      joined.includes("item id") ||
      joined.includes("id da variacao") ||
      joined.includes("id da variação") ||
      joined.includes("vendas (pedido pago)") ||
      joined.includes("unidades (pedido pago)") ||
      joined.includes("id do pedido") ||
      joined.includes("status do pedido") ||
      joined.includes("nome do produto") ||
      joined.includes("faturamento") ||
      joined.includes("subtotal do produto") ||
      joined.includes("repasse")
    ) {
      return i;
    }
  }

  return 0;
}

function createBadRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

module.exports = {
  repairWorksheetRef,
  readSheetRows,
  parseSpreadsheet,
  detectMeliHeaderRow,
  detectShopeeHeaderRow,
  createBadRequestError,
};
