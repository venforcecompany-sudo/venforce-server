const express = require("express");
const multer = require("multer");
const { authMiddleware, requireAdmin } = require("../middlewares/authMiddleware");
const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");
const controller = require("../controllers/centralVendasController");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

router.get("/:slug", authMiddleware, requireAutomacoesAccess, controller.obterCentralVendas);

router.post(
  "/:slug/importar-vendas",
  authMiddleware,
  requireAdmin,
  upload.fields([
    { name: "sales", maxCount: 1 },
    { name: "costs", maxCount: 1 },
  ]),
  controller.importarVendas
);

// API-first: busca pedidos na Orders API do ML e persiste no banco.
// Fluxo pesado (chama API ML); GET da Central continua lendo so do banco.
router.post(
  "/:slug/sincronizar",
  authMiddleware,
  requireAdmin,
  controller.sincronizarVendas
);

module.exports = router;
