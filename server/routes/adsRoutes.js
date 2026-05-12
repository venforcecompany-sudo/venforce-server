const express = require("express");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");
const {
  getAdsClientes,
  getAdsAcompanhamento,
  putAdsAcompanhamento,
  getAdsResumoMensal,
  putAdsResumoMensal,
} = require("../controllers/adsController");

const router = express.Router();

router.get("/clientes",       authMiddleware, requireAutomacoesAccess, getAdsClientes);
router.get("/acompanhamento", authMiddleware, requireAutomacoesAccess, getAdsAcompanhamento);
router.put("/acompanhamento", authMiddleware, requireAutomacoesAccess, putAdsAcompanhamento);
router.get("/resumo-mensal",  authMiddleware, requireAutomacoesAccess, getAdsResumoMensal);
router.put("/resumo-mensal",  authMiddleware, requireAutomacoesAccess, putAdsResumoMensal);

module.exports = router;
