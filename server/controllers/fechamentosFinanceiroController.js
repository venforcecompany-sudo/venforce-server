// server/controllers/fechamentosFinanceiroController.js
// Controller da rota /fechamentos/financeiro.

const XLSX = require("xlsx");

const { toNumber } = require("../utils/numberUtils");
const { normalizeText } = require("../utils/textUtils");
const {
  parseSpreadsheet,
  detectShopeeHeaderRow,
  detectMeliHeaderRow,
  repairWorksheetRef,
} = require("../utils/excelUtils");
const {
  buildMeliBaseSheetRows,
  processMeli,
} = require("../services/fechamentoFinanceiro/meliFinanceiroService");
const {
  processFechamentoFinanceiro,
} = require("../services/fechamentoFinanceiro");

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Lê uma aba específica do workbook como array de objetos.
 * Detecta automaticamente a linha de cabeçalho para abas de vendas MeLi.
 */
function readWorkbookSheet(workbook, sheetName, { isMeliSales = false } = {}) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return null;
  repairWorksheetRef(sheet);

  let skipRows = 0;
  if (isMeliSales) {
    // Detecta linha de cabeçalho dentro da aba (mesmo padrão do detectMeliHeaderRow)
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
    for (let i = 0; i < aoa.length; i++) {
      const joined = (aoa[i] || []).map((c) => normalizeText(String(c))).join(" | ");
      if (
        joined.includes("n.º de venda") || joined.includes("n.o de venda") ||
        joined.includes("nº de venda")  || joined.includes("# de anuncio") ||
        joined.includes("# de anúncio") || joined.includes("receita por produtos") ||
        joined.includes("tarifa de venda e impostos")
      ) {
        skipRows = i;
        break;
      }
    }
    if (skipRows === 0) skipRows = 5; // fallback padrão ML
  }

  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false, range: skipRows });
}

/**
 * Encontra o nome real de uma aba no workbook por padrão de texto (case-insensitive).
 */
function findSheetName(workbook, patterns) {
  return workbook.SheetNames.find((name) =>
    patterns.some((p) => name.trim().toLowerCase().includes(p.toLowerCase()))
  ) || null;
}

// ─── Controller ───────────────────────────────────────────────────────────────

function processarFechamentoFinanceiroController(req, res) {
  try {
    const salesFile  = req.files?.["sales"]?.[0];
    const costsFile  = req.files?.["costs"]?.[0];

    const marketplace = String(req.body.marketplace || "").trim().toLowerCase();
    const ads         = toNumber(req.body.ads);
    const venforce    = toNumber(req.body.venforce);
    const affiliates  = toNumber(req.body.affiliates);

    if (!salesFile || !salesFile.buffer) {
      return res.status(400).json({ ok: false, error: "Arquivo de vendas não enviado." });
    }
    if (!costsFile || !costsFile.buffer) {
      return res.status(400).json({ ok: false, error: "Arquivo de custos não enviado." });
    }
    if (marketplace !== "meli" && marketplace !== "shopee") {
      return res.status(400).json({ ok: false, error: "Marketplace inválido. Envie exatamente 'meli' ou 'shopee'." });
    }

    const salesBuffer = salesFile.buffer;
    const costsBuffer = costsFile.buffer;

    // ── Shopee: lógica inalterada ──
    if (marketplace === "shopee") {
      const salesRowsRaw = parseSpreadsheet(salesBuffer, detectShopeeHeaderRow(salesBuffer));
      const costRowsRaw  = parseSpreadsheet(costsBuffer);

      const ordersAllFile = req.files?.ordersAll?.[0];
      let ordersAllRowsRaw = null;
      if (ordersAllFile) {
        try { ordersAllRowsRaw = parseSpreadsheet(ordersAllFile.buffer, 0); } catch (_) { /* opcional */ }
      }

      const result = processFechamentoFinanceiro({
        marketplace,
        salesRowsRaw,
        costRowsRaw,
        ads,
        venforce,
        affiliates,
        ordersAllRowsRaw,
      });

      return enviarResposta(res, result, marketplace);
    }

    // ── MeLi: detectar aba "Vendas BR"; custos sempre do arquivo separado ──
    const salesWb = XLSX.read(salesBuffer, { type: "buffer" });

    const vendasBrName = findSheetName(salesWb, ["vendas br", "vendas_br"]);

    // Linhas de vendas: aba "Vendas BR" (detecção automática de header) ou fallback
    const salesRowsRaw = vendasBrName
      ? readWorkbookSheet(salesWb, vendasBrName, { isMeliSales: true })
      : parseSpreadsheet(salesBuffer, detectMeliHeaderRow(salesBuffer));

    // Linhas de custo: sempre do arquivo de custos separado
    const costRowsRaw = parseSpreadsheet(costsBuffer);

    const result = processMeli(salesRowsRaw, costRowsRaw, ads, venforce, affiliates);

    return enviarResposta(res, result, marketplace);

  } catch (error) {
    console.error("Erro em /fechamentos/financeiro:", error);
    const statusCode =
      Number.isFinite(Number(error?.statusCode)) && Number(error.statusCode) >= 400
        ? Number(error.statusCode)
        : 500;
    res.status(statusCode).json({
      ok: false,
      error: error instanceof Error ? error.message : "Erro ao processar os arquivos enviados.",
    });
  }
}

// ─── Montagem e envio da resposta ─────────────────────────────────────────────

function enviarResposta(res, result, marketplace) {
  const workbook = XLSX.utils.book_new();

  if (marketplace === "meli" && result.preparedRows && result.preparedRows.length > 0) {
    const baseSheet = buildMeliBaseSheetRows(result.preparedRows);
    XLSX.utils.book_append_sheet(workbook, baseSheet, "Base_MeLi");
  } else {
    const summaryRows = Object.entries(result.summary).map(([key, value]) => ({
      Métrica: key,
      Valor: typeof value === "number" ? Number(value.toFixed(6)) : String(value),
    }));
    const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
    const detailSheet  = XLSX.utils.json_to_sheet(result.detailedRows);
    XLSX.utils.book_append_sheet(workbook, summarySheet, "Painel");
    XLSX.utils.book_append_sheet(workbook, detailSheet,  "Detalhamento");
  }

  if (result.auditRows && result.auditRows.length > 0) {
    const auditSheet = XLSX.utils.json_to_sheet(result.auditRows);
    XLSX.utils.book_append_sheet(workbook, auditSheet, "Auditoria");
  }

  const excelBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const excelBase64 = Buffer.from(excelBuffer).toString("base64");

  return res.json({
    ok: true,
    summary:                result.summary,
    detailedRows:           result.detailedRows,
    excelBase64,
    unmatchedIds:           result.unmatchedIds,
    unmatchedCancelled:     result.unmatchedCancelled,
    ignoredRowsWithoutCost: result.ignoredRowsWithoutCost,
    ignoredRevenue:         result.ignoredRevenue,
    message:                result.message,
  });
}

module.exports = {
  processarFechamentoFinanceiroController,
};
