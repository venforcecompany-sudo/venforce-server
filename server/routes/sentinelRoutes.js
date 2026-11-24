// server/routes/sentinelRoutes.js
// Montado em server/index.js: app.use("/sentinel", sentinelRoutes).
//
// Auth obrigatória (authMiddleware: JWT + usuário ativo) + papel (admin/interno)
// + carteira por conta resolvida NO SERVIDOR (sentinelAcesso). O navegador
// nunca informa conta autorizada: `conta`/`cliente`/`squad` na query só
// ESTREITAM o que a carteira já permite.

const express = require("express");
const { authMiddleware } = require("../middlewares/authMiddleware");
const pool = require("../config/database");
const acessoReal = require("../services/sentinel/sentinelAcesso");
const { criarController } = require("../controllers/sentinelController");

function criarSentinelRouter({ auth = authMiddleware, db = pool, acesso = acessoReal, motor = () => require("../services/sentinel/sentinelIncidentes"), conciliacao, operacao } = {}) {
  const router = express.Router();
  const c = criarController({ db, acesso, motor, ...(conciliacao ? { conciliacao } : {}), ...(operacao ? { operacao } : {}) });

  const gatePapel = (req, res, next) => {
    if (!acesso.papelPermitido(req.user)) {
      return res.status(403).json({ ok: false, code: "SENTINEL_SEM_ACESSO", erro: "Seu perfil não tem acesso ao Sentinel." });
    }
    next();
  };
  const base = [auth, gatePapel];

  router.get("/resumo", ...base, c.resumo);
  router.get("/incidentes", ...base, c.listar);
  router.get("/incidentes/:id", ...base, c.obter);
  router.post("/incidentes/:id/reconhecer", ...base, c.reconhecer);
  router.post("/incidentes/:id/resolver", ...base, c.resolver);
  router.get("/contas", ...base, c.contas);
  router.get("/saude", ...base, c.saude);
  // Conciliação da comissão (S1): somente leitura.
  router.get("/conciliacao/resumo", ...base, c.conciliacaoResumo);
  router.get("/conciliacao", ...base, c.conciliacaoListar);
  router.get("/conciliacao/pedidos/:pedidoId", ...base, c.conciliacaoPedido);
  // Operação (S1.5): worker, polling, Billing, cobertura, grants e sinais — somente leitura.
  router.get("/operacao", ...base, c.operacao);
  return router;
}

const router = criarSentinelRouter();
router.criarSentinelRouter = criarSentinelRouter;
module.exports = router;
