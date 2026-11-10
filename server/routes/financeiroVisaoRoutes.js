// server/routes/financeiroVisaoRoutes.js
// Montado em server/index.js: app.use("/financeiro", financeiroVisaoRoutes).
// Não confundir com /fechamentos (fechamentosFinanceiroRoutes.js — fluxo de
// upload/processamento, intocado).
const express = require("express");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");
const { requireClienteNaCarteira } = require("../middlewares/carteiraMiddleware");
const controller = require("../controllers/financeiroVisaoController");

const router = express.Router();

// Autorização real por carteira (V3 S4).
router.get("/:cliente", authMiddleware, requireAutomacoesAccess, requireClienteNaCarteira("cliente"), controller.financeiro);
// Campo ADS do Fechamento — investimento do Mercado Ads da conta na competência.
router.get("/:cliente/ads", authMiddleware, requireAutomacoesAccess, requireClienteNaCarteira("cliente"), controller.ads);
// Foto dos produtos da lista (Mercado Livre), lida da base do sync de Anúncios ML.
router.get("/:cliente/miniaturas", authMiddleware, requireAutomacoesAccess, requireClienteNaCarteira("cliente"), controller.miniaturas);
// Fechamento pela API do Mercado Livre (Central de Vendas, sem planilha):
// status do sync da competência e geração do resultado. Leitura pura.
router.get("/:cliente/fechamento-api/status", authMiddleware, requireAutomacoesAccess, requireClienteNaCarteira("cliente"), controller.fechamentoApiStatus);
router.post("/:cliente/fechamento-api", authMiddleware, requireAutomacoesAccess, requireClienteNaCarteira("cliente"), controller.fechamentoApi);

module.exports = router;
