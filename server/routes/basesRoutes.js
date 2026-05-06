// server/routes/basesRoutes.js
// Rotas do editor rápido de base de custos.

const express = require("express");
const { authMiddleware } = require("../middlewares/authMiddleware");

const {
  obterPadraoCustoBaseController,
  upsertCustoBaseController,
} = require("../controllers/basesController");

const router = express.Router();

router.get("/bases/:baseSlug/custos/padrao", authMiddleware, obterPadraoCustoBaseController);
router.post("/bases/:baseSlug/custos/upsert", authMiddleware, upsertCustoBaseController);

module.exports = router;

