const express = require("express");
const router = express.Router();

const { login, me } = require("./authController");
const authMiddleware = require("./authMiddleware");

router.post("/login", login);
router.get("/me", authMiddleware, me);

module.exports = router;