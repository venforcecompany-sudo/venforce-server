const express = require("express");
const router = express.Router();
const { authMiddleware, requireAdmin } = require("../middlewares/authMiddleware");
const { listar } = require("../controllers/logsController");

router.get("/", authMiddleware, requireAdmin, listar);

module.exports = router;
