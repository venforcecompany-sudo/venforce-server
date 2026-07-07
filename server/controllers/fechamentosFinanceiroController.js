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
const {
  buildCostRowsFromBase,
} = require("../services/bases/baseCustosService");

async function processarFechamentoFinanceiroController(req, res) {
  try {
    const salesFile = req.files && req.files["sales"] && req.files["sales"][0];
    const costsFile = req.files && req.files["costs"] && req.files["costs"][0];

    const marketplace = String(req.body.marketplace || "")
      .trim()
      .toLowerCase();

    const ads = toNumber(req.body.ads);
    const venforce = toNumber(req.body.venforce);
    const affiliates = toNumber(req.body.affiliates);

    // Origem alternativa dos custos: base vinculada ao cliente (sem upload).
    const costsBaseId = req.body.costsBaseId || req.body.baseId || null;
    const clienteSlug = req.body.cliente_slug || req.body.clienteSlug || null;

    if (!salesFile || !salesFile.buffer) {
      return res.status(400).json({ ok: false, error: "Arquivo de vendas não enviado." });
    }

    if (marketplace !== "meli" && marketplace !== "shopee") {
      return res.status(400).json({ ok: false, error: "Marketplace inválido. Envie exatamente 'meli' ou 'shopee'." });
    }

    // Resolve a origem dos custos: arquivo enviado OU base vinculada (só MELI).
    const podeUsarBaseVinculada =
      marketplace === "meli" && (costsBaseId || clienteSlug);

    if ((!costsFile || !costsFile.buffer) && !podeUsarBaseVinculada) {
      return res.status(400).json({ ok: false, error: "Arquivo de custos não enviado." });
    }

    const salesBuffer = salesFile.buffer;
    const ordersAllFile = req.files?.ordersAll?.[0];

    const salesRowsRaw =
      marketplace === "meli"
        ? parseSpreadsheet(salesBuffer, 5)
        : parseSpreadsheet(salesBuffer, detectShopeeHeaderRow(salesBuffer));

    let costRowsRaw;
    let costsSource = "upload";
    let costsBase = null;
    if (costsFile && costsFile.buffer) {
      costRowsRaw = parseSpreadsheet(costsFile.buffer);
    } else {
      // MELI usando base vinculada: monta as linhas de custo a partir do banco.
      const resolved = await buildCostRowsFromBase({
        baseId: costsBaseId,
        clienteSlug,
        marketplace,
      });
      costRowsRaw = resolved.costRows;
      costsSource = "base";
      costsBase = resolved.base;
    }

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
      message: result.message,
      costsSource,
      costsBase
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
