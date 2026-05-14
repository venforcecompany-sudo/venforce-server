// server/controllers/fechamentosFinanceiroController.js
// Controller da rota /fechamentos/financeiro.
// Extraído de server/index.js sem alterar comportamento.

const XLSX = require("xlsx");

const { toNumber } = require("../utils/numberUtils");
const {
  parseSpreadsheet,
  detectShopeeHeaderRow,
} = require("../utils/excelUtils");
const {
  buildMeliBaseSheetRows,
} = require("../services/fechamentoFinanceiro/meliFinanceiroService");
const {
  processFechamentoFinanceiro,
} = require("../services/fechamentoFinanceiro");

function processarFechamentoFinanceiroController(req, res) {
  try {
    const salesFile = req.files && req.files["sales"] && req.files["sales"][0];
    const costsFile = req.files && req.files["costs"] && req.files["costs"][0];

    const marketplace = String(req.body.marketplace || "")
      .trim()
      .toLowerCase();

    const ads = toNumber(req.body.ads);
    const venforce = toNumber(req.body.venforce);
    const affiliates = toNumber(req.body.affiliates);

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
    const ordersAllFile = req.files?.ordersAll?.[0];

    const salesRowsRaw =
      marketplace === "meli"
        ? parseSpreadsheet(salesBuffer, 5)
        : parseSpreadsheet(salesBuffer, detectShopeeHeaderRow(salesBuffer));

    const costRowsRaw = parseSpreadsheet(costsBuffer);
    let ordersAllRowsRaw = null;
    if (ordersAllFile && marketplace === "shopee") {
      try {
        ordersAllRowsRaw = parseSpreadsheet(ordersAllFile.buffer, 0);
      } catch (e) {
        // Se o parse falhar, ignora silenciosamente — é opcional.
        ordersAllRowsRaw = null;
      }
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

    const workbook = XLSX.utils.book_new();

    if (marketplace === "meli" && result.preparedRows && result.preparedRows.length > 0) {
      const baseSheet = buildMeliBaseSheetRows(result.preparedRows);
      XLSX.utils.book_append_sheet(workbook, baseSheet, "Base_MeLi");
    } else {
      const summaryRows = Object.entries(result.summary).map(([key, value]) => ({
        Métrica: key,
        Valor:
          typeof value === "number" ? Number(value.toFixed(6)) : String(value),
      }));

      const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
      const detailSheet = XLSX.utils.json_to_sheet(result.detailedRows);

      XLSX.utils.book_append_sheet(workbook, summarySheet, "Painel");
      XLSX.utils.book_append_sheet(workbook, detailSheet, "Detalhamento");
    }

    if (result.auditRows && result.auditRows.length > 0) {
      const auditSheet = XLSX.utils.json_to_sheet(result.auditRows);
      XLSX.utils.book_append_sheet(workbook, auditSheet, "Auditoria");
    }

    const excelBuffer = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    });

    const excelBase64 = Buffer.from(excelBuffer).toString("base64");

    res.json({
      ok: true,
      summary: result.summary,
      detailedRows: result.detailedRows,
      excelBase64,
      unmatchedIds: result.unmatchedIds,
      unmatchedCancelled: result.unmatchedCancelled,
      ignoredRowsWithoutCost: result.ignoredRowsWithoutCost,
      ignoredRevenue: result.ignoredRevenue,
      message: result.message
    });
  } catch (error) {
    console.error("Erro em /fechamentos/financeiro:", error);
    const statusCode =
      Number.isFinite(Number(error?.statusCode)) && Number(error.statusCode) >= 400
        ? Number(error.statusCode)
        : 500;
    res.status(statusCode).json({
      ok: false,
      error: error instanceof Error ? error.message : "Erro ao processar os arquivos enviados."
    });
  }
}

module.exports = {
  processarFechamentoFinanceiroController,
};
