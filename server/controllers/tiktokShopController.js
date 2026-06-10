const pool = require("../config/database");

async function garantirTabelaCallbackLogs() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tiktok_shop_callback_logs (
      id SERIAL PRIMARY KEY,
      code TEXT,
      state TEXT,
      query_json JSONB,
      user_agent TEXT,
      ip TEXT,
      status TEXT DEFAULT 'recebido',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

function extrairIp(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (forwardedFor) {
    return String(forwardedFor).split(",")[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || "";
}

async function salvarCallbackLog(req, code) {
  await garantirTabelaCallbackLogs();

  await pool.query(
    `INSERT INTO tiktok_shop_callback_logs
      (code, state, query_json, user_agent, ip, status)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
    [
      String(code),
      req.query.state ? String(req.query.state) : null,
      JSON.stringify(req.query || {}),
      req.get("user-agent") || "",
      extrairIp(req),
      "recebido",
    ]
  );
}

function renderCallbackRecebido({ logSalvo }) {
  const detalhe = logSalvo
    ? "Callback recebido com sucesso."
    : "Callback recebido, mas não foi possível salvar o log no banco.";

  return `<html><body style="font-family:sans-serif;text-align:center;padding:3rem;background:#f8f9fc;">
    <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:2.5rem;box-shadow:0 4px 24px rgba(0,0,0,.08);">
      <div style="font-size:2.5rem;margin-bottom:1rem;">OK</div>
      <h2 style="margin:0 0 .5rem;color:#2d2d2d;">TikTok Shop autorizado</h2>
      <p style="color:#6b7280;margin:0;">${detalhe}</p>
    </div>
  </body></html>`;
}

async function callbackTikTokShopController(req, res) {
  const code = req.query.code || req.query.auth_code;

  if (!code || String(code).trim() === "") {
    return res.status(400).send(
      `<html><body style="font-family:sans-serif;padding:2rem;">
        <h2>Erro</h2>
        <p>Parâmetro code ou auth_code não recebido.</p>
      </body></html>`
    );
  }

  try {
    await salvarCallbackLog(req, code);
    return res.send(renderCallbackRecebido({ logSalvo: true }));
  } catch (err) {
    console.error("[TikTok Shop callback] erro ao salvar log:", err.message);
    return res.send(renderCallbackRecebido({ logSalvo: false }));
  }
}

module.exports = {
  callbackTikTokShopController,
};
