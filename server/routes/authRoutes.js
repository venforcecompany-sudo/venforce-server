const express = require("express");
const router = express.Router();

const { authMiddleware } = require("../middlewares/authMiddleware");
const { register, login, me } = require("../controllers/authController");
const { loginRateLimiter } = require("../middlewares/loginRateLimiter");

router.post("/register", register);
router.post("/login", loginRateLimiter, login);
router.get("/me", authMiddleware, me);

module.exports = router;
