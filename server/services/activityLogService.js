const pool = require("../config/database");

async function registrarLog({ userId = null, userEmail = null, userNome = null, acao, detalhes = null, ip = null, status = "sucesso" } = {}) {
  if (!acao) return;

  try {
    const detalhesTexto =
      detalhes === null || detalhes === undefined
        ? null
        : typeof detalhes === "object"
          ? JSON.stringify(detalhes)
          : detalhes;

    await pool.query(
      "INSERT INTO activity_logs (user_id, user_email, user_nome, acao, detalhes, ip, status) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [userId, userEmail, userNome, acao, detalhesTexto, ip, status]
    );
  } catch (err) {
    console.error("[activityLog]", err);
    return;
  }
}

function extrairIp(req) {
  const ipBruto = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null;
  if (typeof ipBruto === "string" && ipBruto.includes(",")) {
    return ipBruto.split(",")[0].trim();
  }
  return ipBruto;
}

function dadosUsuarioDeReq(req) {
  const user = req.user;
  return {
    userId: user?.id ?? null,
    userEmail: user?.email ?? null,
    userNome: user?.nome ?? null
  };
}

module.exports = { registrarLog, extrairIp, dadosUsuarioDeReq };
