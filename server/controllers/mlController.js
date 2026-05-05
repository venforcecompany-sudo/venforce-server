// server/controllers/mlController.js
// Controllers das rotas Mercado Livre OAuth/API.
// Extraído de server/index.js sem alterar endpoints, payloads ou fluxo OAuth.

const pool = require("../config/database");
const { mlFetch } = require("../utils/mlClient");
const {
  registrarLog,
  extrairIp,
} = require("../services/activityLogService");

const {
  buscarClienteAtivoPorSlug,
  buscarClienteAtivoPorId,
  gerarMlState,
  gerarMlAuthorizationUrl,
  verificarMlState,
  trocarCodePorTokenMl,
  calcularMlExpiresAt,
  salvarMlToken,
} = require("../services/mlApiService");

function normalizarSlug(nome) {
  return String(nome || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

async function testarConexaoMlController(req, res) {
  try {
    const clienteId = parseInt(req.params.clienteId);
    if (!clienteId) return res.status(400).json({ ok: false, erro: "clienteId inválido." });

    const { ok, status, data } = await mlFetch(clienteId, "/users/me");

    if (!ok) {
      return res.status(status).json({ ok: false, erro: data?.message || "Erro ao chamar ML.", status, data });
    }

    res.json({ ok: true, status, usuario: data });
  } catch (err) {
    console.error("[GET /ml/teste] erro:", err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
}

async function listarMlItemsController(req, res) {
  try {
    const clienteId = parseInt(req.params.clienteId);
    if (!clienteId) return res.status(400).json({ ok: false, erro: "clienteId inválido." });

    // Passo 1: buscar o ml_user_id do cliente no banco
    const tokenRow = await pool.query(
      "SELECT ml_user_id FROM ml_tokens WHERE cliente_id = $1",
      [clienteId]
    );
    if (!tokenRow.rows.length) {
      return res.status(404).json({ ok: false, erro: "Cliente sem conta ML vinculada." });
    }
    const mlUserId = tokenRow.rows[0].ml_user_id;

    // Passo 2: buscar itens ativos
    const offset = parseInt(req.query.offset) || 0;
    const limit  = Math.min(parseInt(req.query.limit) || 20, 50);

    const { ok, status, data } = await mlFetch(
      clienteId,
      `/users/${mlUserId}/items/search?status=active&offset=${offset}&limit=${limit}`
    );

    if (!ok) {
      return res.status(status).json({ ok: false, erro: data?.message || "Erro ao buscar itens.", status, data });
    }

    res.json({
      ok: true,
      total: data?.paging?.total ?? 0,
      offset: data?.paging?.offset ?? offset,
      limit:  data?.paging?.limit  ?? limit,
      items:  data?.results ?? [],
    });
  } catch (err) {
    console.error("[GET /ml/items] erro:", err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
}

function conectarMlLegadoController(req, res) {
  res.status(410).send(
    `<html><body style="font-family:sans-serif;padding:2rem;max-width:520px;margin:0 auto;">
      <h2>410 Gone</h2>
      <p>Use <code>GET /ml/conectar/:clienteSlug</code> com o slug do cliente para iniciar a autorização Mercado Livre.</p>
    </body></html>`
  );
}

async function iniciarConexaoMlController(req, res) {
  try {
    const slug = normalizarSlug(req.params.clienteSlug);
    const cliente = await buscarClienteAtivoPorSlug(slug);
    if (!cliente) {
      return res.status(404).send("Cliente não encontrado.");
    }

    const state = gerarMlState(cliente);
    const url = gerarMlAuthorizationUrl(state);

    res.redirect(url);
  } catch (err) {
    if (err.message === "ML_CLIENT_ID não configurado.") {
      return res.status(500).send("ML_CLIENT_ID não configurado.");
    }
    console.error("[ML conectar] erro:", err);
    res.status(500).send("Erro interno: " + err.message);
  }
}

async function callbackMlController(req, res) {
  const { code, error, error_description, state } = req.query;

  if (!state || String(state).trim() === "") {
    return res.status(400).send(
      `<html><body style="font-family:sans-serif;padding:2rem;"><h2>Erro</h2><p>state ausente</p></body></html>`
    );
  }

  let decoded;
  try {
    decoded = verificarMlState(state);
  } catch (e) {
    return res.status(400).send(
      `<html><body style="font-family:sans-serif;padding:2rem;"><h2>Erro</h2><p>state inválido ou expirado</p></body></html>`
    );
  }

  try {
    const cliente = await buscarClienteAtivoPorId(decoded.clienteId);
    if (!cliente) {
      return res.status(400).send(
        `<html><body style="font-family:sans-serif;padding:2rem;"><h2>Erro</h2><p>Cliente inválido ou inativo.</p></body></html>`
      );
    }

    if (error) {
      return res.status(400).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:3rem;background:#f8f9fc;">
          <h2>❌ Autorização negada</h2>
          <p style="color:#6b7280;">${error_description || error}</p>
        </body></html>`);
    }

    if (!code) {
      return res.status(400).send(
        `<html><body style="font-family:sans-serif;padding:2rem;"><h2>Erro</h2><p>Parâmetro 'code' não recebido.</p></body></html>`
      );
    }

    const tokenResult = await trocarCodePorTokenMl(code);
    const data = tokenResult.data;
    console.log("[ML callback] resposta:", JSON.stringify(data));

    if (!tokenResult.ok) {
      return res.status(502).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:3rem;background:#f8f9fc;">
          <h2>❌ Erro ao obter token</h2>
          <p style="color:#6b7280;">${data?.message || JSON.stringify(data)}</p>
        </body></html>`);
    }

    const { access_token, refresh_token, user_id: mlUserId, expires_in } = data;
    const expiresAt = calcularMlExpiresAt(expires_in);

    await salvarMlToken({
      clienteId: cliente.id,
      mlUserId,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt,
    });
    registrarLog({
      userId: null,
      userEmail: null,
      userNome: null,
      acao: "admin.ml.conectar",
      detalhes: { cliente_slug: cliente.slug, cliente_nome: cliente.nome, ml_user_id: String(mlUserId) },
      ip: extrairIp(req),
      status: "sucesso"
    });

    console.log(`[ML callback] ✓ token salvo — cliente: ${cliente.nome} ml_user_id: ${mlUserId}`);

    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:3rem;background:#f8f9fc;">
        <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:2.5rem;box-shadow:0 4px 24px rgba(0,0,0,.08);">
          <div style="font-size:2.5rem;margin-bottom:1rem;">✅</div>
          <h2 style="margin:0 0 .5rem;color:#2d2d2d;">Conta conectada!</h2>
          <p style="color:#6b7280;margin:0 0 1rem;"><strong>${cliente.nome}</strong></p>
          <p style="font-family:monospace;font-size:.8rem;color:#9ca3af;background:#f8f9fc;padding:.75rem;border-radius:8px;">
            ML User ID: ${mlUserId}<br>
            Expira em: ${expiresAt.toLocaleString("pt-BR")}
          </p>
        </div>
      </body></html>`);
  } catch (err) {
    console.error("[ML callback] erro:", err);
    return res.status(500).send("Erro interno: " + err.message);
  }
}

module.exports = {
  testarConexaoMlController,
  listarMlItemsController,
  conectarMlLegadoController,
  iniciarConexaoMlController,
  callbackMlController,
};

