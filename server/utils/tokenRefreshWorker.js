// server/utils/tokenRefreshWorker.js
const pool = require("../config/database");

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID     || "";
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || "";
const INTERVAL_MS      = 5 * 60 * 1000; // 5 minutos
const REFRESH_WINDOW_S = 10 * 60;        // renova tokens que expiram em até 10 min

let workerTimer = null;

async function refreshTokenRow(row) {
  try {
    const tokenRes = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        client_id:     ML_CLIENT_ID,
        client_secret: ML_CLIENT_SECRET,
        refresh_token: row.refresh_token,
      }),
    });

    const data = await tokenRes.json();

    if (!tokenRes.ok) {
      // Marca token com erro para não tentar em loop
      await pool.query(
        `UPDATE ml_tokens SET token_status = 'error', updated_at = NOW()
         WHERE id = $1`,
        [row.id]
      );
      console.warn(
        `[tokenWorker] ✗ cliente_id=${row.cliente_id} — refresh falhou:`,
        data?.message || JSON.stringify(data)
      );
      return;
    }

    const { access_token, refresh_token, expires_in } = data;
    const newExpires = new Date(Date.now() + (expires_in || 21600) * 1000);
    const newRefresh = refresh_token || row.refresh_token;

    await pool.query(
      `UPDATE ml_tokens
       SET access_token = $1, refresh_token = $2, expires_at = $3,
           token_status = 'valid', updated_at = NOW()
       WHERE id = $4`,
      [access_token, newRefresh, newExpires, row.id]
    );

    console.log(
      `[tokenWorker] ✓ cliente_id=${row.cliente_id} ml_user_id=${row.ml_user_id} — renovado até ${newExpires.toLocaleString("pt-BR")}`
    );
  } catch (err) {
    console.error(`[tokenWorker] erro inesperado cliente_id=${row.cliente_id}:`, err.message);
  }
}

async function runRefreshCycle() {
  try {
    // Busca tokens que expiram nos próximos REFRESH_WINDOW_S segundos
    // ou que já estão expirados (exceto os marcados como error)
    const result = await pool.query(
      `SELECT id, cliente_id, ml_user_id, refresh_token, expires_at
       FROM ml_tokens
       WHERE expires_at <= NOW() + ($1 || ' seconds')::INTERVAL
         AND (token_status IS NULL OR token_status != 'error')`,
      [REFRESH_WINDOW_S]
    );

    if (!result.rows.length) {
      console.log(`[tokenWorker] — nenhum token para renovar.`);
      return;
    }

    console.log(`[tokenWorker] renovando ${result.rows.length} token(s)...`);

    // Renova em paralelo (cuidado com rate limit do ML em escala grande)
    await Promise.allSettled(result.rows.map(refreshTokenRow));
  } catch (err) {
    console.error("[tokenWorker] erro no ciclo:", err.message);
  }
}

function startTokenRefreshWorker() {
  if (workerTimer) return; // evita iniciar duas vezes

  console.log(
    `[tokenWorker] iniciado — ciclo a cada ${INTERVAL_MS / 60000} min, janela de ${REFRESH_WINDOW_S / 60} min`
  );

  // Roda imediatamente na inicialização
  runRefreshCycle();

  workerTimer = setInterval(runRefreshCycle, INTERVAL_MS);
}

function stopTokenRefreshWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
    console.log("[tokenWorker] parado.");
  }
}

module.exports = { startTokenRefreshWorker, stopTokenRefreshWorker };

