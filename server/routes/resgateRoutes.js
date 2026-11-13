// server/routes/resgateRoutes.js — VenForce Resgate (montado em /resgate).
// Auth: JWT + acesso de automações; rotas por conta passam pela carteira
// (requireClienteContaNaCarteira). Não existe rota que escreva no ML.
const express = require("express");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");
const { requireClienteContaNaCarteira } = require("../middlewares/carteiraMiddleware");
const c = require("../controllers/resgateController");

const router = express.Router();
const base = [authMiddleware, requireAutomacoesAccess];
const daConta = [...base, requireClienteContaNaCarteira("contaId")];

router.get("/config", ...base, c.config);
router.get("/visao-global", ...base, c.visaoGlobal);
router.get("/plano.xlsx", ...base, c.planoXlsx);
router.get("/contas/:contaId", ...daConta, c.conta);
router.get("/contas/:contaId/itens", ...daConta, c.itens);
router.get("/contas/:contaId/itens/:itemId", ...daConta, c.item);
router.post("/contas/:contaId/itens/:itemId/simular", ...daConta, c.simular);
router.post("/contas/:contaId/itens/:itemId/revisao", ...daConta, c.revisar);
router.get("/contas/:contaId/plano.xlsx", ...daConta, c.planoXlsx);
router.post("/contas/:contaId/dry-run", ...daConta, c.dryRun);

module.exports = router;
