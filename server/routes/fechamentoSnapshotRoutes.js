// server/routes/fechamentoSnapshotRoutes.js
// Montado em server/index.js: app.use("/fechamento-snapshots", ...).
// Prefixo próprio de propósito: GET /financeiro/:cliente (visão) capturaria
// "/financeiro/snapshots" como se "snapshots" fosse um cliente.
const express = require("express");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");
const controller = require("../controllers/fechamentoSnapshotController");

const router = express.Router();

router.post("/", authMiddleware, requireAutomacoesAccess, controller.criar);
router.get("/", authMiddleware, requireAutomacoesAccess, controller.listar);
router.get("/:id", authMiddleware, requireAutomacoesAccess, controller.buscar);
router.get("/:id/itens", authMiddleware, requireAutomacoesAccess, controller.itens);
// "A base de custos desta revisão ainda é a mesma?" (só leitura)
router.get("/:id/base-atual", authMiddleware, requireAutomacoesAccess, controller.baseAtual);

module.exports = router;
