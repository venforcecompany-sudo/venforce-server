const { parseSpreadsheet, detectMeliHeaderRow } = require("../utils/excelUtils");
const centralVendasService = require("../services/centralVendas/centralVendasService");
const centralVendasImportService = require("../services/centralVendas/centralVendasImportService");

const CAMPOS_SENSIVEIS = new Set([
  "access_token", "refresh_token", "api_key", "apikey", "password",
  "authorization", "token", "secret", "client_secret",
]);

function maskSensitiveData(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(maskSensitiveData);
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (CAMPOS_SENSIVEIS.has(String(key).toLowerCase())) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = maskSensitiveData(value);
    }
  }
  return out;
}

function responder(res, statusCode, payload) {
  return res.status(statusCode).json(maskSensitiveData(payload));
}

function tratarErro(res, err, contexto) {
  const statusCode =
    Number.isFinite(Number(err?.statusCode)) && Number(err.statusCode) >= 400
      ? Number(err.statusCode)
      : 500;
  if (statusCode >= 500) console.error(`[centralVendas] ${contexto}:`, err?.message);
  return responder(res, statusCode, {
    ok: false,
    erro: err?.message || "Erro interno.",
  });
}

function slugParam(req) {
  return String(req.params.slug || "").trim().toLowerCase();
}

function parseSalesRows(req) {
  // Aceita salesRowsRaw como JSON no body (testes/integração) ou upload de arquivo .xlsx
  const salesRowsBody = req.body?.salesRowsRaw;
  if (Array.isArray(salesRowsBody)) return salesRowsBody;
  if (typeof salesRowsBody === "string" && salesRowsBody.trim()) {
    try {
      const parsed = JSON.parse(salesRowsBody);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) { /* ignora, tenta arquivo */ }
  }

  const salesFile = req.files?.sales?.[0];
  if (!salesFile?.buffer) {
    const err = new Error("Arquivo de vendas (sales) e obrigatorio.");
    err.statusCode = 400;
    throw err;
  }

  return parseSpreadsheet(salesFile.buffer, detectMeliHeaderRow(salesFile.buffer));
}

async function obterCentralVendas(req, res) {
  try {
    const slug = slugParam(req);
    if (!slug) return responder(res, 400, { ok: false, erro: "slug e obrigatorio." });

    const data = await centralVendasService.getCentralVendas(slug, {
      competencia: req.query.competencia,
      marketplace: req.query.marketplace || "meli",
    });
    return responder(res, 200, data);
  } catch (err) {
    return tratarErro(res, err, "obterCentralVendas");
  }
}

async function importarVendas(req, res) {
  try {
    const slug = slugParam(req);
    if (!slug) return responder(res, 400, { ok: false, erro: "slug e obrigatorio." });

    const salesRowsRaw = parseSalesRows(req);
    const data = await centralVendasImportService.importarVendasMeli({
      salesRowsRaw,
      clienteSlug: slug,
      competencia: req.body?.competencia || req.query?.competencia,
      marketplace: req.body?.marketplace || "meli",
    });
    return responder(res, 201, data);
  } catch (err) {
    return tratarErro(res, err, "importarVendas");
  }
}

module.exports = {
  obterCentralVendas,
  importarVendas,
  maskSensitiveData,
};
