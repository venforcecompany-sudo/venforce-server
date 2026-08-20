// server/routes/cliente360ResultadoRoutes.js
// Rotas do cockpit de RESULTADO da Cliente 360 (telas React).
//
// Montado em server/index.js no MESMO prefixo das rotas atuais da 360:
//   app.use("/operacao/cliente-360", cliente360ResultadoRoutes);   ← este, primeiro
//   app.use("/operacao/cliente-360", cliente360Routes);            ← o existente
//
// Rotas estáticas como /carteira/resultado devem ficar antes de /:slug/* para
// nunca serem interpretadas como slug de cliente.
//
// Permissões espelham as da Cliente 360 atual:
//   leitura         → authMiddleware + requireAutomacoesAccess (admin/user/membro)
//   simulação       → mesmo nível de leitura (não muta nada)
//   escrita de ação → authMiddleware + requireAdmin (admin only)

const express = require("express");
const { authMiddleware, requireAdmin } = require("../middlewares/authMiddleware");
const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");
const controller = require("../controllers/cliente360ResultadoController");

const router = express.Router();

// Leitura agregada da carteira — antes de /:slug.
router.get("/carteira/resultado", authMiddleware, requireAutomacoesAccess, controller.obterCarteiraExecutiva);

// Leitura por cliente.
router.get("/:slug/resultado", authMiddleware, requireAutomacoesAccess, controller.obterResultado);
router.get("/:slug/elasticidades", authMiddleware, requireAutomacoesAccess, controller.obterElasticidades);
router.get("/:slug/placar", authMiddleware, requireAutomacoesAccess, controller.obterPlacar);
router.get("/:slug/acoes", authMiddleware, requireAutomacoesAccess, controller.listarAcoes);

// Simulação (leitura pesada, mas não persiste nada).
router.post("/:slug/resultado/simular", authMiddleware, requireAutomacoesAccess, controller.simularResultado);

// Escrita de ações do consultor (admin).
router.post("/:slug/acoes", authMiddleware, requireAdmin, controller.registrarAcao);
router.delete("/:slug/acoes/:id", authMiddleware, requireAdmin, controller.removerAcao);

module.exports = router;
