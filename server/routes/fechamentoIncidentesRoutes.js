// server/routes/fechamentoIncidentesRoutes.js
// Área admin/TI da caixa-preta do fechamento — ADMIN ONLY, ponta a ponta.
// Mesmo prefixo /fechamentos das outras rotas de fechamento; arquivo
// separado para deixar claro que nada aqui é usado pelo fluxo de produção
// do fechamento em si (só por quem investiga um FIN-xxx).

const express = require("express");
const { authMiddleware, requireAdmin } = require("../middlewares/authMiddleware");
const {
  listarIncidentesController,
  detalharIncidenteController,
  baixarArquivoIncidenteController,
} = require("../controllers/fechamentoIncidentesController");

const router = express.Router();

router.get("/incidentes", authMiddleware, requireAdmin, listarIncidentesController);
router.get("/incidentes/:codigo", authMiddleware, requireAdmin, detalharIncidenteController);
router.get("/incidentes/:codigo/arquivos/:arquivoId", authMiddleware, requireAdmin, baixarArquivoIncidenteController);

module.exports = router;
