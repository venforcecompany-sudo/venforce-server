// server/routes/automacoesRoutes.js
// Rotas de automações, relatórios e diagnóstico.
// Mantém os endpoints públicos exatamente iguais ao index.js original.

const express = require("express");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");
const { requireClienteNaCarteira } = require("../middlewares/carteiraMiddleware");

const {
  listarClientesAutomacoesController,
  prontidaoContaAutomacoesController,
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
  exportModeloBaseCustosController,
  iniciarDiagnosticoCompletoController,
  buscarDiagnosticoCompletoController,
} = require("../controllers/automacoesController");

const router = express.Router();

// P2.1 — seam de carteira para as automações client-scoped. O cliente chega
// por `clienteSlug` em param (rotas de export), query (previews/snapshot) ou
// body (starts/salvar). Pass-through quando não há clienteSlug. As rotas por
// `:id` (relatório salvo / job) resolvem o cliente no service — ver
// BACKEND_V3_AUTHORIZATION_COVERAGE.md.
const naCarteira = requireClienteNaCarteira({ param: "clienteSlug", query: "clienteSlug", body: "clienteSlug" });

router.get("/automacoes/clientes", authMiddleware, requireAutomacoesAccess, listarClientesAutomacoesController);

// Prontidão por CONTA ML (clienteSlug + clienteContaId) — a que o Otimizador usa.
router.get("/automacoes/prontidao", authMiddleware, requireAutomacoesAccess, naCarteira, prontidaoContaAutomacoesController);

router.get("/automacoes/precificacao/preview", authMiddleware, requireAutomacoesAccess, naCarteira, previewPrecificacaoController);

router.get("/automacoes/precificacao/preview-ml", authMiddleware, requireAutomacoesAccess, naCarteira, previewPrecificacaoMlController);

// Planilha de precificação (mesma matriz/fórmulas do XLSX do relatório) gerada
// direto do grant ML, sem exigir base de custos vinculada. Somente leitura.
router.get("/automacoes/clientes/:clienteSlug/planilha-precificacao.xlsx", authMiddleware, requireAutomacoesAccess, naCarteira, exportPlanilhaPrecificacaoSemBaseController);

// Modelo simples para criar uma base: somente os IDs MLB dos anúncios ativos,
// sem enriquecimento financeiro, relatório ou escrita no banco.
router.get("/automacoes/clientes/:clienteSlug/modelo-base-custos.xlsx", authMiddleware, requireAutomacoesAccess, naCarteira, exportModeloBaseCustosController);

router.get("/automacoes/promocoes-retorno/preview", authMiddleware, requireAutomacoesAccess, naCarteira, previewPromocoesRetornoController);

router.post("/automacoes/promocoes-retorno/diagnostico/start", authMiddleware, requireAutomacoesAccess, naCarteira, iniciarDiagnosticoPromocoesController);

router.get("/automacoes/promocoes-retorno/diagnostico/:id", authMiddleware, requireAutomacoesAccess, statusDiagnosticoPromocoesController);

router.get("/automacoes/promocoes-retorno/snapshot", authMiddleware, requireAutomacoesAccess, naCarteira, buscarSnapshotPromocoesController);

router.post("/automacoes/relatorios", authMiddleware, requireAutomacoesAccess, naCarteira, salvarRelatorioAutomacoesController);

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

router.post("/automacoes/diagnostico-completo/start", authMiddleware, requireAutomacoesAccess, naCarteira, iniciarDiagnosticoCompletoController);

router.get("/automacoes/diagnostico-completo/:id", authMiddleware, requireAutomacoesAccess, buscarDiagnosticoCompletoController);

module.exports = router;
