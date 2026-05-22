const rateLimit = require("express-rate-limit");

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 8, // 8 tentativas por IP a cada 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    erro: "Muitas tentativas de login. Aguarde alguns minutos e tente novamente.",
  },
});

module.exports = { loginRateLimiter };