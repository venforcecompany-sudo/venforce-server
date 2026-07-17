// server/routes/automacoesRoutes.js
// Rotas de automações, relatórios e diagnóstico.
// Mantém os endpoints públicos exatamente iguais ao index.js original.

const express = require("express");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");

const {
  listarClientesAutomacoesController,
  previewPrecificacaoController,
  previewPrecificacaoMlController,
  previewPromocoesRetornoController,
  iniciarDiagnosticoPromocoesController,
  statusDiagnosticoPromocoesController,
  buscarSnapshotPromocoesController,
  salvarRelatorioAutomacoesController,
  listarRelatoriosAutomacoesController,
  listarPastasRelatoriosController,
  criarPastaRelatoriosController,
  atualizarPastaRelatoriosController,
  excluirPastaRelatoriosController,
  moverRelatorioParaPastaController,
  buscarDetalheRelatorioAutomacoesController,
  excluirRelatorioAutomacoesController,
  exportRelatorioCsvController,
  exportRelatorioXlsxController,
  exportPlanilhaPrecificacaoSemBaseController,
  iniciarDiagnosticoCompletoController,
  buscarDiagnosticoCompletoController,
} = require("../controllers/automacoesController");

const router = express.Router();

router.get("/automacoes/clientes", authMiddleware, requireAutomacoesAccess, listarClientesAutomacoesController);

router.get("/automacoes/precificacao/preview", authMiddleware, requireAutomacoesAccess, previewPrecificacaoController);

router.get("/automacoes/precificacao/preview-ml", authMiddleware, requireAutomacoesAccess, previewPrecificacaoMlController);

// Planilha de precificação (mesma matriz/fórmulas do XLSX do relatório) gerada
// direto do grant ML, sem exigir base de custos vinculada. Somente leitura.
router.get("/automacoes/clientes/:clienteSlug/planilha-precificacao.xlsx", authMiddleware, requireAutomacoesAccess, exportPlanilhaPrecificacaoSemBaseController);

router.get("/automacoes/promocoes-retorno/preview", authMiddleware, requireAutomacoesAccess, previewPromocoesRetornoController);

router.post("/automacoes/promocoes-retorno/diagnostico/start", authMiddleware, requireAutomacoesAccess, iniciarDiagnosticoPromocoesController);

router.get("/automacoes/promocoes-retorno/diagnostico/:id", authMiddleware, requireAutomacoesAccess, statusDiagnosticoPromocoesController);

router.get("/automacoes/promocoes-retorno/snapshot", authMiddleware, requireAutomacoesAccess, buscarSnapshotPromocoesController);

router.post("/automacoes/relatorios", authMiddleware, requireAutomacoesAccess, salvarRelatorioAutomacoesController);

router.get("/automacoes/relatorios", authMiddleware, requireAutomacoesAccess, listarRelatoriosAutomacoesController);

router.get("/relatorios/pastas", authMiddleware, requireAutomacoesAccess, listarPastasRelatoriosController);

router.post("/relatorios/pastas", authMiddleware, requireAutomacoesAccess, criarPastaRelatoriosController);

router.patch("/relatorios/pastas/:id", authMiddleware, requireAutomacoesAccess, atualizarPastaRelatoriosController);

router.delete("/relatorios/pastas/:id", authMiddleware, requireAutomacoesAccess, excluirPastaRelatoriosController);

router.patch("/relatorios/:id/pasta", authMiddleware, requireAutomacoesAccess, moverRelatorioParaPastaController);

router.get("/automacoes/relatorios/:id/export/csv", authMiddleware, requireAutomacoesAccess, exportRelatorioCsvController);

router.get("/automacoes/relatorios/:id/export/xlsx", authMiddleware, requireAutomacoesAccess, exportRelatorioXlsxController);

router.get("/automacoes/relatorios/:id", authMiddleware, requireAutomacoesAccess, buscarDetalheRelatorioAutomacoesController);

router.delete("/automacoes/relatorios/:id", authMiddleware, requireAutomacoesAccess, excluirRelatorioAutomacoesController);

router.post("/automacoes/diagnostico-completo/start", authMiddleware, requireAutomacoesAccess, iniciarDiagnosticoCompletoController);

router.get("/automacoes/diagnostico-completo/:id", authMiddleware, requireAutomacoesAccess, buscarDiagnosticoCompletoController);

module.exports = router;

