const { rateLimit } = require("express-rate-limit");

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    ok: false,
    erro: "Muitas tentativas de login. Aguarde alguns minutos e tente novamente.",
  },
});

module.exports = { loginRateLimiter };
