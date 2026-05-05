const express = require("express");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");

const {
  criarEntregaController,
  listarEntregasController,
  buscarEntregaPorIdController,
  atualizarEntregaController,
  publicarEntregaController,
  despublicarEntregaController,
  excluirEntregaController,
  buscarEntregaPublicaPorTokenController,
} = require("../controllers/entregasClienteController");

const router = express.Router();

// Endpoints internos (protegidos)
router.post("/entregas-cliente", authMiddleware, requireAutomacoesAccess, criarEntregaController);
router.get("/entregas-cliente", authMiddleware, requireAutomacoesAccess, listarEntregasController);
router.get("/entregas-cliente/:id", authMiddleware, requireAutomacoesAccess, buscarEntregaPorIdController);
router.patch("/entregas-cliente/:id", authMiddleware, requireAutomacoesAccess, atualizarEntregaController);
router.post("/entregas-cliente/:id/publicar", authMiddleware, requireAutomacoesAccess, publicarEntregaController);
router.post("/entregas-cliente/:id/despublicar", authMiddleware, requireAutomacoesAccess, despublicarEntregaController);
router.delete("/entregas-cliente/:id", authMiddleware, requireAutomacoesAccess, excluirEntregaController);

// Endpoint público (sem login)
router.get("/public/entregas/:token", buscarEntregaPublicaPorTokenController);

module.exports = router;

