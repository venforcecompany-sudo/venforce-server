// server/routes/fechamentosFinanceiroRoutes.js
// Rotas de fechamento financeiro.
// Mantém POST /fechamentos/financeiro quando montado em /fechamentos.

const express = require("express");
const multer = require("multer");
const { authMiddleware } = require("../middlewares/authMiddleware");
const {
  processarFechamentoFinanceiroController,
} = require("../controllers/fechamentosFinanceiroController");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

router.post(
  "/financeiro",
  authMiddleware,
  upload.fields([
    { name: "sales", maxCount: 1 },
    { name: "costs", maxCount: 1 },
    { name: "ordersAll", maxCount: 1 },
  ]),
  processarFechamentoFinanceiroController
);

module.exports = router;
