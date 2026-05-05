// server/services/fechamentoFinanceiro/index.js
// Orquestrador do fechamento financeiro.
// Decide qual service chamar conforme marketplace.
// Extraído para preparar a etapa 8, sem alterar comportamento da rota.

const { processMeli } = require("./meliFinanceiroService");
const { processShopee } = require("./shopeePerformanceService");

function processFechamentoFinanceiro({
  marketplace,
  salesRowsRaw,
  costRowsRaw,
  ads,
  venforce,
  affiliates,
  ordersAllRowsRaw,
}) {
  const marketplaceNorm = String(marketplace || "").trim().toLowerCase();

  if (marketplaceNorm === "meli") {
    return processMeli(salesRowsRaw, costRowsRaw, ads, venforce, affiliates);
  }

  if (marketplaceNorm === "shopee") {
    return processShopee(
      salesRowsRaw,
      costRowsRaw,
      ads,
      venforce,
      affiliates,
      ordersAllRowsRaw
    );
  }

  throw new Error("Marketplace inválido. Envie exatamente 'meli' ou 'shopee'.");
}

module.exports = {
  processFechamentoFinanceiro,
};
