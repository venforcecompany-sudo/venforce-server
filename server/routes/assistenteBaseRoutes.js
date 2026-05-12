// server/routes/assistenteBaseRoutes.js
// Rota isolada do Assistente de Base. Multer próprio, sem dependência do index.js.

const express = require("express");
const multer  = require("multer");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { previewAssistenteBaseController } = require("../controllers/assistenteBaseController");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// POST /bases/assistente/preview
router.post("/preview", authMiddleware, upload.single("arquivo"), previewAssistenteBaseController);

module.exports = router;
