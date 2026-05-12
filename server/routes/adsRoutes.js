const express = require("express");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");
const { getAdsClientes, getAdsAcompanhamento, putAdsAcompanhamento } = require("../controllers/adsController");

const router = express.Router();

router.get("/clientes", authMiddleware, requireAutomacoesAccess, getAdsClientes);
router.get("/acompanhamento", authMiddleware, requireAutomacoesAccess, getAdsAcompanhamento);
router.put("/acompanhamento", authMiddleware, requireAutomacoesAccess, putAdsAcompanhamento);

module.exports = router;
