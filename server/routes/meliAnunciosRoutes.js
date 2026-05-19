// server/routes/meliAnunciosRoutes.js
// -----------------------------------------------------------------------------
// Módulo: Anúncios Meli — rotas.
//
// Montagem esperada em server/index.js:
//   const meliAnunciosRoutes = require("./routes/meliAnunciosRoutes");
//   app.use("/anuncios-meli", meliAnunciosRoutes);
//
// Proteção base do módulo: authMiddleware + requireAutomacoesAccess
//   (admin | user | membro). As rotas do Otimizador IA têm trava extra
//   requireAdmin (admin-only) — temporária, ver mais abaixo.
//
// Endpoints finais:
//   GET    /anuncios-meli/clientes
//   POST   /anuncios-meli/sync
//   GET    /anuncios-meli/resumo
//   GET    /anuncios-meli
//   POST   /anuncios-meli/:itemId/otimizar      (Otimizador IA — admin-only)
//   GET    /anuncios-meli/:itemId/otimizacoes   (histórico — admin-only)
//   GET    /anuncios-meli/:itemId
//   PATCH  /anuncios-meli/:itemId/revisao
// -----------------------------------------------------------------------------

const express = require("express");
const router = express.Router();

const { authMiddleware, requireAdmin } = require("../middlewares/authMiddleware");
const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");
const ctrl = require("../controllers/meliAnunciosController");

// Todas as rotas exigem usuário autenticado com acesso a automações.
router.use(authMiddleware, requireAutomacoesAccess);

// Rotas estáticas declaradas ANTES de "/:itemId" para evitar conflito.
router.get("/clientes", ctrl.listarClientes);
router.post("/sync", ctrl.sincronizar);
router.get("/resumo", ctrl.resumo);
router.get("/", ctrl.listar);

// Rotas com sub-caminho declaradas ANTES da rota genérica "/:itemId".
//
// ETAPA 1 do Otimizador: as rotas que chamam IA ficam ADMIN-ONLY
// (authMiddleware do router + requireAdmin por rota). É uma trava
// temporária — quando o otimizador sair da fase de testes, basta
// remover o requireAdmin destas duas linhas para voltar ao acesso
// padrão do módulo (automações: admin | user | membro).
router.post("/:itemId/otimizar", requireAdmin, ctrl.otimizar);
router.get("/:itemId/otimizacoes", requireAdmin, ctrl.listarOtimizacoes);

router.patch("/:itemId/revisao", ctrl.marcarRevisado);

router.get("/:itemId", ctrl.detalhe);

module.exports = router;
