const jwt = require("jsonwebtoken");

function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        ok: false,
        erro: "Token não informado"
      });
    }

    const token = authHeader.substring(7);
    const secret = process.env.JWT_SECRET || "venforce_secret_local";

    const decoded = jwt.verify(token, secret);

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      ok: false,
      erro: "Token inválido ou expirado"
    });
  }
}

module.exports = authMiddleware;