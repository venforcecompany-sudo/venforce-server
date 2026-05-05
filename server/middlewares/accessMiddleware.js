// server/middlewares/accessMiddleware.js
// Middlewares de acesso customizados.
// Extraído de server/index.js sem alterar permissões, mensagens ou comportamento.

const pool = require("../config/database");

async function apiKeyMiddleware(req, res, next) {
  try {
    const key = req.headers["x-api-key"] || req.query.api_key;
    if (!key) return res.status(401).json({ ok: false, erro: "API Key não informada." });
    const result = await pool.query(
      "SELECT * FROM clientes WHERE api_key = $1 AND ativo = true",
      [key]
    );
    if (!result.rows.length) {
      return res.status(401).json({ ok: false, erro: "API Key inválida ou inativa." });
    }
    req.cliente = result.rows[0];
    next();
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
}

function requireAutomacoesAccess(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();

  if (role === "admin" || role === "user" || role === "membro") {
    return next();
  }

  return res.status(403).json({
    ok: false,
    erro: "Acesso restrito às automações."
  });
}

function requireDesignAccess(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();

  if (role === "admin" || role === "user" || role === "membro") {
    return next();
  }

  return res.status(403).json({
    ok: false,
    erro: "Acesso restrito ao módulo de design."
  });
}

module.exports = {
  apiKeyMiddleware,
  requireAutomacoesAccess,
  requireDesignAccess,
};

