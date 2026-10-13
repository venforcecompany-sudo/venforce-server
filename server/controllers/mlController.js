// server/controllers/mlController.js
// Controllers das rotas Mercado Livre OAuth/API.
// Extraído de server/index.js sem alterar endpoints, payloads ou fluxo OAuth.

const pool = require("../config/database");
const { mlFetch } = require("../utils/mlClient");
const {
  findGrantById,
  listGrantsByCliente,
  resolveMlGrant,
  setPrimaryGrant,
  refreshMlGrant,
  markGrantValid,
  markGrantError,
  isGrantUsable,
  grantNeedsRefresh,
  sanitizedGrant,
  sanitizeErrorMessage,
} = require("../services/mlTokenService");
const {
  registrarLog,
  extrairIp,
} = require("../services/activityLogService");
const {
  concluirOAuthContaMl,
  obterConta,
  atualizarNicknameConta,
} = require("../services/clienteContas/clienteContaService");

const {
  buscarClienteAtivoPorSlug,
  buscarClienteAtivoPorId,
  gerarMlState,
  gerarMlAuthorizationUrl,
  verificarMlState,
  trocarCodePorTokenMl,
  calcularMlExpiresAt,
} = require("../services/mlApiService");

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizarSlug(nome) {
  return String(nome || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function resumoStatusGrant(grant, now = new Date()) {
  const safe = sanitizedGrant(grant);
  const expiresMs = new Date(grant?.expires_at).getTime();
  const expiraEm = Number.isFinite(expiresMs)
    ? Math.floor((expiresMs - now.getTime()) / 1000)
    : null;
  return {
    ...safe,
    expirado: expiraEm == null || expiraEm <= 0,
    expira_em_segundos: expiraEm == null ? null : Math.max(0, expiraEm),
    precisa_refresh: grantNeedsRefresh(grant, now),
    utilizavel: isGrantUsable(grant, now),
  };
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

    const grant = await resolveMlGrant({ clienteId, requireUsable: true });
    const mlUserId = grant.ml_user_id;

    // Passo 2: buscar itens ativos
    const offset = parseInt(req.query.offset) || 0;
    const limit  = Math.min(parseInt(req.query.limit) || 20, 50);

    const { ok, status, data } = await mlFetch(
      clienteId,
      `/users/${mlUserId}/items/search?status=active&offset=${offset}&limit=${limit}`,
      { mlUserId }
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
    const status = err.code === "ML_GRANT_NOT_FOUND" ? 404 : (err.code === "ML_GRANT_UNUSABLE" || err.code === "ML_GRANT_REVOKED" ? 409 : 500);
    res.status(status).json({ ok: false, erro: err.message });
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

// Link account-scoped (Fundação de Contas): identifica a cliente_conta
// específica, não só o cliente. Continua público — é o link compartilhável
// com o cliente, igual ao /ml/conectar/:clienteSlug legado — mas valida no
// backend que a conta existe, é do marketplace meli, está ativa e o cliente
// dono dela também está ativo antes de redirecionar para o Mercado Livre.
async function iniciarConexaoContaMlController(req, res) {
  try {
    const contaId = Number(req.params.clienteContaId);
    if (!Number.isInteger(contaId) || contaId <= 0) {
      return res.status(400).send("Conta inválida.");
    }

    let conta = null;
    try {
      conta = await obterConta(contaId);
    } catch (_) {
      conta = null;
    }
    if (!conta || conta.marketplace !== "meli" || conta.ativo === false) {
      return res.status(404).send("Conta Mercado Livre não encontrada ou inativa.");
    }

    const cliente = await buscarClienteAtivoPorId(conta.cliente_id);
    if (!cliente) {
      return res.status(404).send("Cliente não encontrado ou inativo.");
    }

    const state = gerarMlState(cliente, { clienteContaId: conta.id });
    const url = gerarMlAuthorizationUrl(state);

    res.redirect(url);
  } catch (err) {
    if (err.message === "ML_CLIENT_ID não configurado.") {
      return res.status(500).send("ML_CLIENT_ID não configurado.");
    }
    console.error("[ML conectar-conta] erro:", err);
    res.status(500).send("Erro interno: " + err.message);
  }
}

async function callbackMlController(req, res) {
  const { code, error, state } = req.query;

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
          <p style="color:#6b7280;">A autorização foi negada ou cancelada.</p>
        </body></html>`);
    }

    if (!code) {
      return res.status(400).send(
        `<html><body style="font-family:sans-serif;padding:2rem;"><h2>Erro</h2><p>Parâmetro 'code' não recebido.</p></body></html>`
      );
    }

    // Fluxo account-scoped (Fundação de Contas): resolve e valida a
    // cliente_conta ANTES de trocar o code — falha cedo se a conta não
    // existir mais, tiver sido desativada, ou não pertencer a este cliente.
    // O fluxo legado (sem clienteContaId no state) segue exatamente como
    // antes — contaAlvo fica null e nada muda.
    let contaAlvo = null;
    if (decoded.clienteContaId != null) {
      try {
        contaAlvo = await obterConta(decoded.clienteContaId);
      } catch (_) {
        contaAlvo = null;
      }
      if (!contaAlvo || contaAlvo.cliente_id !== cliente.id || contaAlvo.marketplace !== "meli" || contaAlvo.ativo === false) {
        return res.status(400).send(
          `<html><body style="font-family:sans-serif;padding:2rem;"><h2>Erro</h2><p>Conta Mercado Livre inválida, inativa ou não pertence a este cliente.</p></body></html>`
        );
      }
    }

    const tokenResult = await trocarCodePorTokenMl(code);
    const data = tokenResult.data;

    if (!tokenResult.ok) {
      console.warn(JSON.stringify({
        event: "ml_oauth_code_exchange_failed",
        cliente_id: cliente.id,
        status: tokenResult.status,
        oauth_error: /^[a-z0-9_.-]{1,80}$/i.test(String(data?.error || "")) ? String(data.error) : "unknown",
      }));
      return res.status(502).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:3rem;background:#f8f9fc;">
          <h2>❌ Erro ao obter token</h2>
          <p style="color:#6b7280;">Não foi possível concluir a autorização. Gere um novo link e tente novamente.</p>
        </body></html>`);
    }

    const { access_token, refresh_token, user_id: mlUserId, expires_in } = data;

    // Reconexão segura (regra obrigatória): se a conta já tem um seller
    // identificado e o Mercado Livre devolveu outro, bloqueia ANTES de
    // salvar qualquer coisa. Nunca substitui a conta, nunca move o grant,
    // nunca toca em tokens existentes.
    if (contaAlvo && contaAlvo.external_account_id && String(contaAlvo.external_account_id) !== String(mlUserId)) {
      console.warn(JSON.stringify({
        event: "ml_account_mismatch",
        cliente_id: cliente.id,
        cliente_conta_id: contaAlvo.id,
        esperado: contaAlvo.external_account_id,
        recebido: String(mlUserId),
      }));
      return res.status(409).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:3rem;background:#f8f9fc;">
          <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:16px;padding:2.5rem;box-shadow:0 4px 24px rgba(0,0,0,.08);">
            <div style="font-size:2.5rem;margin-bottom:1rem;">⚠️</div>
            <h2 style="margin:0 0 .5rem;color:#2d2d2d;">Conta Mercado Livre incompatível</h2>
            <p style="color:#6b7280;margin:0 0 1rem;">
              Esta conexão pertence ao seller <strong>${escapeHtml(String(mlUserId))}</strong>, mas
              <strong>${escapeHtml(contaAlvo.nome)}</strong> espera o seller
              <strong>${escapeHtml(String(contaAlvo.external_account_id))}</strong>.
            </p>
            <p style="color:#9ca3af;font-size:.85rem;">Nenhum token foi alterado. Faça login no Mercado Livre com a conta correta ou gere um novo link para o seller certo.</p>
          </div>
        </body></html>`);
    }

    const expiresAt = calcularMlExpiresAt(expires_in);

    const { conta: contaResolvida } = await concluirOAuthContaMl({
      clienteId: cliente.id, clienteSlug: cliente.slug, clienteContaId: contaAlvo?.id ?? null,
      mlUserId, accessToken: access_token, refreshToken: refresh_token, expiresAt,
    });

    // externalAccountLabel (V3 Master Spec §14.3): captura o nickname/nome
    // de loja UMA VEZ, aqui, para que a Carteira nunca precise consultar o
    // Mercado Livre ao abrir. Falha aqui nunca derruba o OAuth — o grant já
    // foi salvo; sem nickname, o consumidor cai para external_account_id.
    if (contaResolvida) {
      try {
        const meResp = await mlFetch(cliente.id, "/users/me", { mlUserId });
        if (meResp.ok && meResp.data?.nickname) {
          await atualizarNicknameConta(contaResolvida.id, meResp.data.nickname);
        }
      } catch (nicknameErr) {
        console.error(JSON.stringify({ event: "ml_conta_nickname_falhou", cliente_conta_id: contaResolvida.id, error: nicknameErr.message }));
      }
    }

    registrarLog({
      userId: null,
      userEmail: null,
      userNome: null,
      acao: "admin.ml.conectar",
      detalhes: {
        cliente_slug: cliente.slug,
        cliente_nome: cliente.nome,
        ml_user_id: String(mlUserId),
        cliente_conta_id: contaAlvo ? contaAlvo.id : null,
      },
      ip: extrairIp(req),
      status: "sucesso"
    });

    console.log(`[ML callback] ✓ token salvo — cliente: ${cliente.nome} ml_user_id: ${mlUserId}`);

    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:3rem;background:#f8f9fc;">
        <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:2.5rem;box-shadow:0 4px 24px rgba(0,0,0,.08);">
          <div style="font-size:2.5rem;margin-bottom:1rem;">✅</div>
          <h2 style="margin:0 0 .5rem;color:#2d2d2d;">Conta conectada!</h2>
          <p style="color:#6b7280;margin:0 0 1rem;"><strong>${escapeHtml(cliente.nome)}</strong>${contaAlvo ? ` · ${escapeHtml(contaAlvo.nome)}` : ""}</p>
          <p style="font-family:monospace;font-size:.8rem;color:#9ca3af;background:#f8f9fc;padding:.75rem;border-radius:8px;">
            ML User ID: ${escapeHtml(String(mlUserId))}<br>
            Expira em: ${expiresAt.toLocaleString("pt-BR")}
          </p>
        </div>
      </body></html>`);
  } catch (err) {
    console.error(JSON.stringify({ event: "ml_oauth_callback_failed", error: sanitizeErrorMessage(err) }));
    return res.status(err.statusCode || 500).send(err.statusCode === 409 ? "Contexto OAuth ambíguo ou incompatível; nenhum vínculo foi alterado." : "Erro interno ao concluir a autorização.");
  }
}

async function listarMlTokensAdminController(req, res) {
  try {
    // A migration da Fase 1 (cliente_contas) pode ainda não ter rodado em
    // produção — o LEFT JOIN só é seguro se a tabela já existir.
    const tabelaContas = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'cliente_contas'`
    );
    const temContas = tabelaContas.rows.length > 0;

    const result = await pool.query(`
      SELECT t.id, t.cliente_id, c.nome AS cliente_nome, c.slug AS cliente_slug,
             t.ml_user_id,
             t.expires_at, t.updated_at,
             COALESCE(NULLIF(to_jsonb(t)->>'token_status', ''), 'valid') AS token_status,
             COALESCE(NULLIF(to_jsonb(t)->>'is_primary', '')::boolean, false) AS is_primary,
             COALESCE(NULLIF(to_jsonb(t)->>'refresh_failures', '')::integer, 0) AS refresh_failures,
             NULLIF(to_jsonb(t)->>'last_refresh_error_at', '')::timestamp AS last_refresh_error_at,
             NULLIF(to_jsonb(t)->>'next_refresh_attempt_at', '')::timestamp AS next_refresh_attempt_at,
             (t.access_token IS NOT NULL AND t.access_token <> '') AS has_access_token,
             (t.refresh_token IS NOT NULL AND t.refresh_token <> '') AS has_refresh_token
             ${temContas ? ", cc.nome AS cliente_conta_nome, cc.slug AS cliente_conta_slug" : ""}
        FROM ml_tokens t
        INNER JOIN clientes c ON c.id = t.cliente_id
        ${temContas ? "LEFT JOIN cliente_contas cc ON cc.id = NULLIF(to_jsonb(t)->>'cliente_conta_id', '')::integer" : ""}
       ORDER BY c.nome ASC,
                COALESCE(NULLIF(to_jsonb(t)->>'is_primary', '')::boolean, false) DESC,
                t.updated_at DESC NULLS LAST, t.id DESC
    `);
    return res.json({ ok: true, tokens: result.rows });
  } catch (error) {
    return res.status(500).json({ ok: false, erro: "Não foi possível listar os grants Mercado Livre." });
  }
}

async function definirGrantPrincipalController(req, res) {
  const tokenId = Number(req.params.tokenId);
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return res.status(400).json({ ok: false, erro: "tokenId inválido." });
  }
  try {
    const grants = await setPrimaryGrant(tokenId);
    return res.json({ ok: true, token_id: tokenId, grants });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      ok: false,
      erro: error.statusCode === 404 ? error.message : "Não foi possível definir o grant principal.",
    });
  }
}

// Área dev-admin explícita (auditoria de clientes/contas): access_token e
// refresh_token NUNCA aparecem em listagens genéricas (listarMlTokensAdminController,
// cliente-contas). Só este endpoint, admin-only, revela o par de credenciais
// de um grant específico — para debug/manutenção pontual. Não logar o
// resultado; a mensagem de erro também não pode ecoar tokens.
async function revelarCredenciaisGrantController(req, res) {
  const tokenId = Number(req.params.tokenId);
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return res.status(400).json({ ok: false, erro: "tokenId inválido." });
  }
  try {
    const grant = await findGrantById(tokenId);
    if (!grant) return res.status(404).json({ ok: false, erro: "Grant Mercado Livre não encontrado." });
    return res.json({
      ok: true,
      token_id: grant.id,
      cliente_id: grant.cliente_id,
      ml_user_id: grant.ml_user_id == null ? null : String(grant.ml_user_id),
      access_token: grant.access_token || null,
      refresh_token: grant.refresh_token || null,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, erro: "Não foi possível obter as credenciais deste grant." });
  }
}

async function testarGrantAdminController(req, res) {
  const tokenId = Number(req.params.tokenId);
  if (!Number.isInteger(tokenId) || tokenId <= 0) {
    return res.status(400).json({ ok: false, erro: "tokenId inválido." });
  }
  try {
    const grant = await findGrantById(tokenId);
    if (!grant) return res.status(404).json({ ok: false, erro: "Grant Mercado Livre não encontrado." });

    if (grantNeedsRefresh(grant, new Date())) {
      await refreshMlGrant(grant.id, { ignoreBackoff: true });
    }
    const response = await mlFetch(grant.cliente_id, "/users/me", {
      mlUserId: grant.ml_user_id,
      noRefresh: true,
    });
    if (!response.ok) {
      await markGrantError(grant.id, `Teste /users/me falhou com HTTP ${response.status}.`);
      return res.status(502).json({
        ok: false,
        token_id: grant.id,
        cliente_id: grant.cliente_id,
        ml_user_id: String(grant.ml_user_id),
        erro: "O Mercado Livre recusou o teste deste grant.",
        status: response.status,
      });
    }

    const returnedId = response.data?.id == null ? "" : String(response.data.id);
    if (returnedId !== String(grant.ml_user_id)) {
      await markGrantError(grant.id, "A conta retornada pelo Mercado Livre não corresponde ao grant salvo.");
      return res.status(409).json({
        ok: false,
        token_id: grant.id,
        cliente_id: grant.cliente_id,
        ml_user_id: String(grant.ml_user_id),
        erro: "A conta retornada não corresponde ao ml_user_id salvo.",
      });
    }

    await markGrantValid(grant.id);
    const updated = await findGrantById(grant.id);
    return res.json({
      ok: true,
      token_id: grant.id,
      cliente_id: grant.cliente_id,
      ml_user_id: String(grant.ml_user_id),
      is_primary: updated?.is_primary === true,
      token_status: "valid",
      expires_at: updated?.expires_at || grant.expires_at,
      usuario: { id: response.data.id, nickname: response.data.nickname || null },
    });
  } catch (error) {
    const status = error.code === "ML_GRANT_REVOKED" ? 409 : 500;
    return res.status(status).json({
      ok: false,
      token_id: tokenId,
      erro: error.code === "ML_GRANT_REVOKED"
        ? "Grant revogado; reconexão necessária."
        : sanitizeErrorMessage(error),
    });
  }
}

async function statusClienteMlController(req, res) {
  try {
    const slug = normalizarSlug(req.params.slug);
    const cliente = await pool.query("SELECT id FROM clientes WHERE slug = $1", [slug]);
    if (!cliente.rows.length) return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });

    const clienteId = cliente.rows[0].id;
    let grants = await listGrantsByCliente(clienteId);
    if (!grants.length) {
      return res.json({
        ok: true, conectado: false, saudavel: false, total_grants: 0,
        grants_validos: 0, grants_com_erro: 0, grant_principal: null, grants: [],
      });
    }

    const now = new Date();
    const usable = grants.filter((grant) => isGrantUsable(grant, now));
    const valid = usable.filter((grant) => String(grant.token_status || "valid").toLowerCase() === "valid");
    let selected = null;
    try {
      selected = await resolveMlGrant({ clienteId, requireUsable: true });
      if (!grants.some((grant) => grant.is_primary === true) && selected?.is_primary === true) {
        grants = await listGrantsByCliente(clienteId);
        selected = grants.find((grant) => grant.id === selected.id) || selected;
      }
    } catch (_) {
      selected = grants.find((grant) => grant.is_primary === true) || grants[0];
    }
    const summaries = grants.map((grant) => resumoStatusGrant(grant, now));
    const principal = resumoStatusGrant(selected, now);
    return res.json({
      ok: true,
      conectado: true,
      saudavel: usable.length > 0,
      total_grants: grants.length,
      grants_validos: valid.length,
      grants_com_erro: grants.filter((grant) => String(grant.token_status || "valid") === "error").length,
      grant_principal: principal,
      grants: summaries,
      // Campos legados mantidos de forma aditiva.
      ml_user_id: principal?.ml_user_id || null,
      expires_at: principal?.expires_at || null,
      updated_at: principal?.updated_at || null,
      expira_em_segundos: principal?.expira_em_segundos ?? 0,
      precisa_refresh: principal?.precisa_refresh ?? true,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, erro: "Não foi possível consultar o status Mercado Livre." });
  }
}

module.exports = {
  testarConexaoMlController,
  listarMlItemsController,
  conectarMlLegadoController,
  iniciarConexaoMlController,
  iniciarConexaoContaMlController,
  callbackMlController,
  listarMlTokensAdminController,
  definirGrantPrincipalController,
  revelarCredenciaisGrantController,
  testarGrantAdminController,
  statusClienteMlController,
};
