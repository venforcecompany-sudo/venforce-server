// server/routes/mlRoutes.js
// Rotas Mercado Livre OAuth/API.
// Extraído de server/index.js sem alterar endpoints, payloads ou fluxo OAuth.

const express = require("express");
const { authMiddleware, requireAdmin } = require("../middlewares/authMiddleware");
const {
  testarConexaoMlController,
  listarMlItemsController,
  conectarMlLegadoController,
  iniciarConexaoMlController,
  callbackMlController,
} = require("../controllers/mlController");

const router = express.Router();

router.get(
  "/ml/teste/:clienteId",
  authMiddleware,
  requireAdmin,
  testarConexaoMlController
);

router.get(
  "/ml/items/:clienteId",
  authMiddleware,
  requireAdmin,
  listarMlItemsController
);

router.get(
  "/ml/conectar",
  conectarMlLegadoController
);

router.get(
  "/ml/conectar/:clienteSlug",
  iniciarConexaoMlController
);

router.get(
  "/callback",
  callbackMlController
);

module.exports = router;

