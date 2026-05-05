// server/services/mlApiService.js
// Helpers do bloco Mercado Livre OAuth/API.
// Extraído de server/index.js para preparar controllers/routes ML.
// Não altera endpoints, payloads nem fluxo OAuth.

const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const pool = require("../config/database");

const ML_CLIENT_ID = process.env.ML_CLIENT_ID || "";
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || "";
const ML_REDIRECT_URI = process.env.ML_REDIRECT_URI || "https://venforce-server.onrender.com/callback";
const JWT_SECRET = process.env.JWT_SECRET || "venforce_secret_local";

async function buscarClienteAtivoPorSlug(slug) {
  const result = await pool.query(
    "SELECT id, slug, nome FROM clientes WHERE slug = $1 AND ativo = true",
    [slug]
  );
  return result.rows[0] || null;
}

async function buscarClienteAtivoPorId(clienteId) {
  const result = await pool.query(
    "SELECT * FROM clientes WHERE id = $1 AND ativo = true",
    [clienteId]
  );
  return result.rows[0] || null;
}

function gerarMlState(cliente) {
  return jwt.sign(
    {
      clienteId: cliente.id,
      clienteSlug: cliente.slug,
      nonce: crypto.randomBytes(16).toString("hex"),
    },
    JWT_SECRET,
    { expiresIn: "10m" }
  );
}

function verificarMlState(state) {
  return jwt.verify(String(state), JWT_SECRET);
}

function gerarMlAuthorizationUrl(state) {
  if (!ML_CLIENT_ID) {
    throw new Error("ML_CLIENT_ID não configurado.");
  }

  const url = new URL("https://auth.mercadolivre.com.br/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", ML_CLIENT_ID);
  url.searchParams.set("redirect_uri", ML_REDIRECT_URI);
  url.searchParams.set("state", state);

  return url.toString();
}

async function trocarCodePorTokenMl(code) {
  const tokenRes = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      code,
      redirect_uri: ML_REDIRECT_URI,
    }),
  });

  const data = await tokenRes.json();

  return {
    ok: tokenRes.ok,
    status: tokenRes.status,
    data,
  };
}

function calcularMlExpiresAt(expiresIn) {
  return new Date(Date.now() + (expiresIn || 0) * 1000);
}

async function salvarMlToken({ clienteId, mlUserId, accessToken, refreshToken, expiresAt }) {
  await pool.query(
    `INSERT INTO ml_tokens (cliente_id, ml_user_id, access_token, refresh_token, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (cliente_id, ml_user_id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()`,
    [clienteId, String(mlUserId), accessToken, refreshToken, expiresAt]
  );
}

module.exports = {
  buscarClienteAtivoPorSlug,
  buscarClienteAtivoPorId,
  gerarMlState,
  verificarMlState,
  gerarMlAuthorizationUrl,
  trocarCodePorTokenMl,
  calcularMlExpiresAt,
  salvarMlToken,
};
