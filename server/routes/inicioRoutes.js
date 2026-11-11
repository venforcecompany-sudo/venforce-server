// server/routes/inicioRoutes.js
// Montado em server/index.js: app.use("/operacao/inicio", inicioRoutes).
// Mesma autorização da Visão: authMiddleware + requireAutomacoesAccess +
// carteira (interno só vê cliente do seu Squad, seller só os seus).
const express = require("express");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { requireAutomacoesAccess } = require("../middlewares/accessMiddleware");
const { requireClienteNaCarteira } = require("../middlewares/carteiraMiddleware");
const controller = require("../controllers/inicioController");

const router = express.Router();

router.get("/:cliente", authMiddleware, requireAutomacoesAccess, requireClienteNaCarteira("cliente"), controller.inicio);

module.exports = router;
