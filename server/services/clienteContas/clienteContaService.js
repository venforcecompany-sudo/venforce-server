// server/services/clienteContas/clienteContaService.js
//
// Fundação de Contas do Marketplace (Fase 1).
//
// Formaliza CLIENTE → CLIENTE_CONTA → MARKETPLACE → GRANT/BASE sem tocar em
// `ml_tokens` de forma destrutiva. Este service é a porta de entrada para
// resolver o contexto operacional de uma conta; consumidores existentes que
// só conhecem `clienteId` continuam funcionando (fallback legado — ver
// resolveMarketplaceAccountContext).
//
// Não remove nem substitui o resolver de grants existente
// (server/services/mlTokenService.js). Apenas o utiliza de forma explícita
// por ml_user_id quando uma conta é conhecida.

const pool = require("../../config/database");
const mlTokenService = require("../mlTokenService");
const { erroContexto, validarIdentidade, validarTitularidadeSeller, resolverBaseEstrita } = require("./accountContextIdentityService");

const MARKETPLACES_SUPORTADOS = new Set(["meli", "shopee"]);
// Cadastro de conta aceita também TikTok Shop (operação de lançamento manual
// no Painel de Contas). A RESOLUÇÃO de contexto das integrações
// (resolveMarketplaceAccountContext, vínculo legado de base) continua só
// meli/shopee: TikTok não tem integração e nenhum consumidor muda de rota.
// O banco só aceita 'tiktok' depois de 20261001_cliente_contas_marketplace_tiktok.sql.
const MARKETPLACES_CADASTRO = new Set([...MARKETPLACES_SUPORTADOS, "tiktok"]);

function criarErroHttp(statusCode, mensagem, extra = {}) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}

function normalizarSlug(nome) {
  return String(nome || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .replace(/[^\w\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizarMarketplaceConta(valor) {
  const texto = String(valor || "").trim().toLowerCase();
  return MARKETPLACES_SUPORTADOS.has(texto) ? texto : null;
}

function normalizarMarketplaceCadastro(valor) {
  const texto = String(valor || "").trim().toLowerCase();
  return MARKETPLACES_CADASTRO.has(texto) ? texto : null;
}

// externalAccountLabel: o desambiguador humano entre 2+ contas do mesmo
// marketplace (nickname ML / nome da loja). Vem de metadata_json.nickname,
// capturado no momento do OAuth (ver callbackMlController) — nunca exige
// uma chamada ao marketplace na leitura. null quando ainda não capturado;
// o consumidor cai para external_account_id, depois #id (V3 Master Spec §14.3).
function externalAccountLabelDe(row) {
  const nickname = row?.metadata_json?.nickname;
  return typeof nickname === "string" && nickname.trim() ? nickname.trim() : null;
}

function sanitizarConta(row) {
  if (!row) return null;
  return {
    id: row.id,
    cliente_id: row.cliente_id,
    marketplace: row.marketplace,
    nome: row.nome,
    slug: row.slug,
    external_account_id: row.external_account_id,
    externalAccountLabel: externalAccountLabelDe(row),
    is_primary: row.is_primary === true,
    ativo: row.ativo !== false,
    metadata_json: row.metadata_json || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function resolverClientePorIdOuSlug({ clienteId, clienteSlug }, queryable = pool) {
  if (clienteId != null && String(clienteId).trim() !== "") {
    const idNum = Number(clienteId);
    if (!Number.isInteger(idNum) || idNum <= 0) {
      throw criarErroHttp(400, "cliente inválido.");
    }
    const r = await queryable.query("SELECT id, nome, slug, ativo FROM clientes WHERE id = $1", [idNum]);
    if (!r.rows.length) throw criarErroHttp(404, "Cliente não encontrado.");
    return r.rows[0];
  }
  const slugNorm = normalizarSlug(clienteSlug);
  if (!slugNorm) throw criarErroHttp(400, "cliente é obrigatório.");
  const r = await queryable.query("SELECT id, nome, slug, ativo FROM clientes WHERE slug = $1", [slugNorm]);
  if (!r.rows.length) throw criarErroHttp(404, "Cliente não encontrado.");
  return r.rows[0];
}

async function gerarSlugContaUnico(clienteSlug, marketplace, nome, queryable = pool) {
  const base = normalizarSlug(`${clienteSlug}-${marketplace}-${nome}`) || normalizarSlug(`${clienteSlug}-${marketplace}`);
  let candidato = base;
  let sufixo = 1;
  // Poucas contas por cliente: laço simples é suficiente e evita corrida
  // de nomes sem precisar de sequência dedicada.
  while (true) {
    const existente = await queryable.query("SELECT 1 FROM cliente_contas WHERE slug = $1", [candidato]);
    if (!existente.rows.length) return candidato;
    sufixo += 1;
    candidato = `${base}-${sufixo}`;
  }
}

async function listarContasDoCliente({ clienteId, clienteSlug, marketplace, incluirInativas = true }) {
  const cliente = await resolverClientePorIdOuSlug({ clienteId, clienteSlug });
  const marketplaceNorm = marketplace ? normalizarMarketplaceCadastro(marketplace) : null;
  if (marketplace && !marketplaceNorm) throw criarErroHttp(400, "marketplace inválido.");

  const params = [cliente.id];
  const filtros = ["cc.cliente_id = $1"];
  if (marketplaceNorm) {
    params.push(marketplaceNorm);
    filtros.push(`cc.marketplace = $${params.length}`);
  }
  if (!incluirInativas) filtros.push("cc.ativo = true");

  // LATERAL + LIMIT 1 em vez de LEFT JOIN direto: uma cliente_conta com 2+
  // linhas em ml_tokens (reconexão que deixou o grant antigo, migration de
  // backfill) ou 2+ vínculos ativos em base_cliente_vinculos (violação do
  // invariante "1 conta = no máx. 1 base ativa", dado histórico) duplicava a
  // linha da conta na resposta — uma conta virava "2 contas" na leitura, a
  // mesma ambiguidade que todo o modelo existe para evitar (achado do V3
  // Master Spec §18.1: fan-out era corrigido só defensivamente no frontend).
  // Corrigido na origem: no máximo 1 grant e 1 vínculo por conta, sempre.
  const result = await pool.query(
    `SELECT cc.*,
            g.id AS grant_id,
            g.ml_user_id AS grant_ml_user_id,
            COALESCE(NULLIF(to_jsonb(g)->>'token_status', ''), 'valid') AS grant_token_status,
            COALESCE(NULLIF(to_jsonb(g)->>'is_primary', '')::boolean, false) AS grant_is_primary,
            v.id AS vinculo_id,
            v.base_id AS vinculo_base_id,
            b.slug AS vinculo_base_slug,
            b.nome AS vinculo_base_nome
       FROM cliente_contas cc
       LEFT JOIN LATERAL (
         SELECT * FROM ml_tokens g
          WHERE g.cliente_conta_id = cc.id
          ORDER BY g.updated_at DESC NULLS LAST, g.id DESC
          LIMIT 1
       ) g ON true
       LEFT JOIN LATERAL (
         SELECT * FROM base_cliente_vinculos v
          WHERE v.cliente_conta_id = cc.id AND v.ativo = true
          ORDER BY v.updated_at DESC NULLS LAST, v.id DESC
          LIMIT 1
       ) v ON true
       LEFT JOIN bases b ON b.id = v.base_id
      WHERE ${filtros.join(" AND ")}
      ORDER BY cc.marketplace ASC, cc.is_primary DESC, cc.created_at ASC, cc.id ASC`,
    params
  );

  // Compatibilidade: uma conta sem vínculo direto (cliente_conta_id) ainda
  // pode ter um vínculo legado (cliente_id + marketplace) apontando pra ela
  // sem ambiguidade — mesma regra de obterBaseDaConta. Sem isto, esta
  // listagem (a que /clientes.html usa) diverge da leitura por conta e
  // mostra "Base não definida" para bases que já estão vinculadas.
  const ativasPorMarketplace = new Map();
  for (const row of result.rows) {
    if (row.ativo === false) continue;
    ativasPorMarketplace.set(row.marketplace, (ativasPorMarketplace.get(row.marketplace) || 0) + 1);
  }
  const marketplacesElegiveis = [...ativasPorMarketplace.entries()]
    .filter(([, total]) => total === 1)
    .map(([mp]) => mp);

  const legadoPorMarketplace = new Map();
  if (marketplacesElegiveis.length) {
    const legado = await pool.query(
      `SELECT DISTINCT ON (v.marketplace)
              v.marketplace, v.id AS vinculo_id, v.base_id, b.slug, b.nome
         FROM base_cliente_vinculos v
         JOIN bases b ON b.id = v.base_id
        WHERE v.cliente_id = $1
          AND v.marketplace = ANY($2::text[])
          AND v.ativo = true
          AND v.cliente_conta_id IS NULL
        ORDER BY v.marketplace, v.updated_at DESC NULLS LAST, v.id DESC`,
      [cliente.id, marketplacesElegiveis]
    );
    for (const row of legado.rows) legadoPorMarketplace.set(row.marketplace, row);
  }

  return {
    cliente: { id: cliente.id, nome: cliente.nome, slug: cliente.slug, ativo: cliente.ativo },
    contas: result.rows.map((row) => {
      let base = row.vinculo_id
        ? { vinculo_id: row.vinculo_id, base_id: row.vinculo_base_id, slug: row.vinculo_base_slug, nome: row.vinculo_base_nome, resolvido_por: "conta" }
        : null;
      if (!base && row.ativo !== false) {
        const legadoRow = legadoPorMarketplace.get(row.marketplace);
        if (legadoRow) {
          base = { vinculo_id: legadoRow.vinculo_id, base_id: legadoRow.base_id, slug: legadoRow.slug, nome: legadoRow.nome, resolvido_por: "legado_unico" };
        }
      }
      return {
        ...sanitizarConta(row),
        grant: row.grant_id
          ? {
              id: row.grant_id,
              ml_user_id: row.grant_ml_user_id == null ? null : String(row.grant_ml_user_id),
              token_status: row.grant_token_status,
              is_primary: row.grant_is_primary === true,
            }
          : null,
        base,
      };
    }),
  };
}

// Versão em lote de listarContasDoCliente, para GET /me/portfolio (V3): a
// Carteira precisa das contas de N clientes autorizados em UMA consulta, não
// N+1 (V3 Master Spec §10.5/§18.2, nível C). Só contas ATIVAS — a Carteira
// nunca lista conta desativada. Simplificação deliberada em relação a
// listarContasDoCliente: não aplica o enriquecimento de "vínculo legado
// único" (base ligada por cliente_id+marketplace sem cliente_conta_id) —
// esse shim de compatibilidade é do modelo pré-Fundação de Contas; aqui o
// custo de replicar por lote não compensa para um payload de resumo. Uma
// conta nessa situação rara aparece com baseVinculada=null em vez do nome
// da base; nunca mistura dado de outra conta.
async function listarContasDeClientesAtivos(clienteIds) {
  if (!Array.isArray(clienteIds) || !clienteIds.length) return [];

  const result = await pool.query(
    `SELECT cc.*,
            g.id AS grant_id,
            g.ml_user_id AS grant_ml_user_id,
            COALESCE(NULLIF(to_jsonb(g)->>'token_status', ''), 'valid') AS grant_token_status,
            g.expires_at AS grant_expires_at,
            v.id AS vinculo_id,
            v.base_id AS vinculo_base_id,
            b.slug AS vinculo_base_slug,
            b.nome AS vinculo_base_nome
       FROM cliente_contas cc
       LEFT JOIN LATERAL (
         SELECT * FROM ml_tokens g
          WHERE g.cliente_conta_id = cc.id
          ORDER BY g.updated_at DESC NULLS LAST, g.id DESC
          LIMIT 1
       ) g ON true
       LEFT JOIN LATERAL (
         SELECT * FROM base_cliente_vinculos v
          WHERE v.cliente_conta_id = cc.id AND v.ativo = true
          ORDER BY v.updated_at DESC NULLS LAST, v.id DESC
          LIMIT 1
       ) v ON true
       LEFT JOIN bases b ON b.id = v.base_id
      WHERE cc.cliente_id = ANY($1::int[]) AND cc.ativo = true
      ORDER BY cc.cliente_id ASC, cc.marketplace ASC, cc.is_primary DESC, cc.created_at ASC, cc.id ASC`,
    [clienteIds]
  );

  return result.rows.map((row) => ({
    ...sanitizarConta(row),
    grant: row.grant_id
      ? {
          id: row.grant_id,
          ml_user_id: row.grant_ml_user_id == null ? null : String(row.grant_ml_user_id),
          token_status: row.grant_token_status,
          expires_at: row.grant_expires_at,
        }
      : null,
    base: row.vinculo_id
      ? { vinculo_id: row.vinculo_id, base_id: row.vinculo_base_id, slug: row.vinculo_base_slug, nome: row.vinculo_base_nome }
      : null,
  }));
}

// Usado pelo fluxo legado de vínculo de base (baseVinculosService.criarVinculoManual)
// quando só há cliente_id + marketplace, sem cliente_conta_id explícito.
// Nunca escolhe entre 2+ contas ativas — mesma regra de ambiguidade de
// resolveMarketplaceAccountContext. Marketplace fora da fundação (ex.:
// tiktok) devolve null: o vínculo legado segue sem cliente_conta_id.
async function resolverContaParaVinculoLegado({ clienteId, marketplace }, queryable = pool) {
  const marketplaceNorm = normalizarMarketplaceConta(marketplace);
  if (!marketplaceNorm) return null;

  const ativas = await queryable.query(
    "SELECT * FROM cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true ORDER BY is_primary DESC, created_at ASC, id ASC",
    [clienteId, marketplaceNorm]
  );
  if (!ativas.rows.length) return null;
  if (ativas.rows.length > 1) {
    throw criarErroHttp(409, "O cliente possui mais de uma conta para este marketplace; informe cliente_conta_id.", {
      code: "MULTIPLE_MARKETPLACE_ACCOUNTS",
      contas: ativas.rows.map(sanitizarConta),
    });
  }
  return sanitizarConta(ativas.rows[0]);
}

async function obterConta(contaId, queryable = pool) {
  const idNum = Number(contaId);
  if (!Number.isInteger(idNum) || idNum <= 0) throw criarErroHttp(400, "conta inválida.");
  const r = await queryable.query("SELECT * FROM cliente_contas WHERE id = $1", [idNum]);
  if (!r.rows.length) throw criarErroHttp(404, "Conta não encontrada.");
  return r.rows[0];
}

async function criarConta({ clienteId, clienteSlug, marketplace, nome, externalAccountId = null, isPrimary = false, metadata = {} }) {
  const cliente = await resolverClientePorIdOuSlug({ clienteId, clienteSlug });
  const marketplaceNorm = normalizarMarketplaceCadastro(marketplace);
  if (!marketplaceNorm) throw criarErroHttp(400, "marketplace deve ser 'meli', 'shopee' ou 'tiktok'.");

  const nomeFinal = String(nome || "").trim();
  if (!nomeFinal) throw criarErroHttp(400, "nome é obrigatório.");

  if (metadata && typeof metadata === "object") {
    if ("access_token" in metadata || "refresh_token" in metadata) {
      throw criarErroHttp(400, "metadata_json não pode conter tokens.");
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(1296845909, $1)`, [Number(cliente.id)]);

    const ativas = await client.query(
      "SELECT id FROM cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true AND is_primary = true",
      [cliente.id, marketplaceNorm]
    );
    const devePrincipal = isPrimary === true || ativas.rows.length === 0;

    const slug = await gerarSlugContaUnico(cliente.slug, marketplaceNorm, nomeFinal, client);

    if (devePrincipal && ativas.rows.length) {
      await client.query(
        "UPDATE cliente_contas SET is_primary = false, updated_at = NOW() WHERE cliente_id = $1 AND marketplace = $2 AND is_primary = true",
        [cliente.id, marketplaceNorm]
      );
    }

    const inserted = await client.query(
      `INSERT INTO cliente_contas (cliente_id, marketplace, nome, slug, external_account_id, is_primary, ativo, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7)
       RETURNING *`,
      [cliente.id, marketplaceNorm, nomeFinal, slug, externalAccountId || null, devePrincipal, metadata || {}]
    );

    await client.query("COMMIT");
    return sanitizarConta(inserted.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") throw criarErroHttp(409, "Já existe uma conta com esse identificador.");
    // Banco ainda com a CHECK antiga (sem 'tiktok'): migration manual pendente.
    if (error.code === "23514" && error.constraint === "cliente_contas_marketplace_check") {
      throw criarErroHttp(409, "Contas TikTok Shop ainda não estão habilitadas neste banco (migração pendente).", {
        code: "MARKETPLACE_PENDENTE_MIGRACAO",
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

// Captura o desambiguador humano da conta (V3 Master Spec §14.3, Q1):
// o nickname/nome de loja do Mercado Livre, mesclado em metadata_json sem
// apagar outras chaves. Chamado no momento do OAuth (uma vez por conexão,
// não a cada leitura da Carteira) e, opcionalmente, ao testar um grant.
// Nunca deve derrubar o fluxo que a chamou — falha vira log, não exceção.
async function atualizarNicknameConta(contaId, nickname, queryable = pool) {
  const nomeNick = typeof nickname === "string" ? nickname.trim() : "";
  if (!nomeNick || contaId == null) return;
  try {
    await queryable.query(
      `UPDATE cliente_contas
          SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object('nickname', $2::text),
              updated_at = NOW()
        WHERE id = $1`,
      [contaId, nomeNick]
    );
  } catch (error) {
    console.error(JSON.stringify({ event: "cliente_conta_nickname_falhou", cliente_conta_id: contaId, error: error.message }));
  }
}

// Chamada depois de um OAuth ML bem-sucedido (mlController.callbackMlController)
// para que a conta VenForce exista desde a primeira conexão, não só via
// backfill em massa da migration. Idempotente: se a conta já existe para
// (cliente_id, ml_user_id), apenas garante que o grant aponte para ela.
// Nunca toca em access_token/refresh_token/expires_at/token_status.
async function garantirContaMlParaGrant({ clienteId, clienteSlug, mlUserId, grantIsPrimary = false, transactionClient = null }) {
  const mlUserIdStr = mlUserId == null ? "" : String(mlUserId);
  if (!mlUserIdStr) return null;

  const client = transactionClient || await pool.connect();
  try {
    if (!transactionClient) await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(1296845909, $1)`, [Number(clienteId)]);

    const existente = await client.query(
      "SELECT * FROM cliente_contas WHERE cliente_id = $1 AND marketplace = 'meli' AND external_account_id = $2 LIMIT 1",
      [clienteId, mlUserIdStr]
    );

    let conta = existente.rows[0] || null;
    if (!conta) {
      const totalAtual = await client.query(
        "SELECT COUNT(*)::int AS total FROM cliente_contas WHERE cliente_id = $1 AND marketplace = 'meli'",
        [clienteId]
      );
      const ordinal = (totalAtual.rows[0]?.total || 0) + 1;
      const ativas = await client.query(
        "SELECT id FROM cliente_contas WHERE cliente_id = $1 AND marketplace = 'meli' AND ativo = true AND is_primary = true",
        [clienteId]
      );
      const devePrincipal = grantIsPrimary === true || ativas.rows.length === 0;
      const slug = await gerarSlugContaUnico(clienteSlug, "meli", `Mercado Livre ${ordinal}`, client);

      if (devePrincipal && ativas.rows.length) {
        await client.query(
          "UPDATE cliente_contas SET is_primary = false, updated_at = NOW() WHERE cliente_id = $1 AND marketplace = 'meli' AND is_primary = true",
          [clienteId]
        );
      }

      const inserted = await client.query(
        `INSERT INTO cliente_contas (cliente_id, marketplace, nome, slug, external_account_id, is_primary, ativo, metadata_json)
         VALUES ($1, 'meli', $2, $3, $4, $5, true, $6)
         ON CONFLICT (cliente_id, marketplace, external_account_id) WHERE external_account_id IS NOT NULL DO NOTHING
         RETURNING *`,
        [clienteId, `Mercado Livre ${ordinal}`, slug, mlUserIdStr, devePrincipal, { origem: "oauth_callback" }]
      );
      conta = inserted.rows[0] || (await client.query(
        "SELECT * FROM cliente_contas WHERE cliente_id = $1 AND marketplace = 'meli' AND external_account_id = $2 LIMIT 1",
        [clienteId, mlUserIdStr]
      )).rows[0];
    }

    if (conta) {
      await client.query(
        "UPDATE ml_tokens SET cliente_conta_id = $1 WHERE cliente_id = $2 AND ml_user_id = $3 AND cliente_conta_id IS NULL",
        [conta.id, clienteId, mlUserIdStr]
      );
    }

    if (!transactionClient) await client.query("COMMIT");
    return sanitizarConta(conta);
  } catch (error) {
    if (transactionClient) throw error;
    await client.query("ROLLBACK");
    // Nunca deve derrubar o fluxo OAuth por causa da fundação de contas.
    console.error(JSON.stringify({ event: "cliente_conta_auto_provisao_falhou", cliente_id: clienteId, ml_user_id: mlUserIdStr, error: error.message }));
    return null;
  } finally {
    if (!transactionClient) client.release();
  }
}

// Chamado pelo callback OAuth account-scoped (mlController.callbackMlController)
// depois que o code já foi trocado por token e a checagem de seller
// incompatível (regra "reconexão segura") já passou no controller — este
// service é a segunda linha de defesa, não a única. Idempotente: se a conta
// ainda não tem external_account_id, grava agora (primeira conexão daquela
// conta). Nunca move o grant para outra conta nem apaga tokens existentes.
async function vincularGrantMlNaConta({ contaId, mlUserId, transactionClient = null }) {
  const mlUserIdStr = mlUserId == null ? "" : String(mlUserId);
  if (!mlUserIdStr) throw criarErroHttp(400, "mlUserId é obrigatório.");

  const client = transactionClient || await pool.connect();
  try {
    if (!transactionClient) await client.query("BEGIN");
    const found = await client.query("SELECT * FROM cliente_contas WHERE id = $1 FOR UPDATE", [contaId]);
    const conta = found.rows[0];
    if (!conta) throw criarErroHttp(404, "Conta não encontrada.");

    if (conta.external_account_id && String(conta.external_account_id) !== mlUserIdStr) {
      throw criarErroHttp(409, `Esta conexão pertence ao seller ${mlUserIdStr}, mas a conta ${conta.nome} espera o seller ${conta.external_account_id}.`, {
        code: "ML_ACCOUNT_MISMATCH",
      });
    }

    if (!conta.external_account_id) {
      await client.query(
        "UPDATE cliente_contas SET external_account_id = $1, updated_at = NOW() WHERE id = $2",
        [mlUserIdStr, contaId]
      );
    }

    await client.query(
      "UPDATE ml_tokens SET cliente_conta_id = $1 WHERE cliente_id = $2 AND ml_user_id = $3",
      [conta.id, conta.cliente_id, mlUserIdStr]
    );

    if (!transactionClient) await client.query("COMMIT");
    return sanitizarConta({ ...conta, external_account_id: conta.external_account_id || mlUserIdStr });
  } catch (error) {
    if (!transactionClient) await client.query("ROLLBACK");
    if (error.code === "23505") {
      throw criarErroHttp(409, "Este seller já está vinculado a outra conta VenForce.", { code: "ML_ACCOUNT_MISMATCH" });
    }
    throw error;
  } finally {
    if (!transactionClient) client.release();
  }
}

// OAuth é uma unidade: preflight de titularidade, Grant e vínculo na MESMA
// transação. Só o callback usa esta porta; nenhum sync/refresh é disparado.
async function concluirOAuthContaMl({ clienteId, clienteSlug, clienteContaId = null,
  mlUserId, accessToken, refreshToken, expiresAt }) {
  const seller = String(mlUserId || "").trim();
  if (!/^[1-9]\d*$/.test(seller) || typeof accessToken !== "string" || !accessToken.trim() ||
      typeof refreshToken !== "string" || !refreshToken.trim() || !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) throw erroContexto("OAUTH_IDENTITY_INVALID", "Resposta OAuth sem identidade/credenciais válidas.", 400);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serializa OAuth do MESMO seller entre Clientes, antes do preflight.
    await client.query("SELECT pg_advisory_xact_lock(1296845910, hashtext($1))", [seller]);
    // Mesma ordem do save de Grant: Cliente antes de Conta/Grant evita
    // inversão entre callback explícito e provisionamento legado concorrentes.
    await client.query("SELECT pg_advisory_xact_lock(1296845907, $1)", [Number(clienteId)]);
    const cliente = await resolverClientePorIdOuSlug({ clienteId }, client);
    if (cliente.ativo === false) throw erroContexto("CLIENTE_INATIVO", "Cliente inativo.");
    let conta = null;
    if (clienteContaId != null) {
      const locked = await client.query("SELECT * FROM cliente_contas WHERE id = $1 FOR UPDATE", [clienteContaId]);
      conta = locked.rows[0];
      if (!conta) throw erroContexto("ACCOUNT_CONTEXT_NOT_FOUND", "Conta não encontrada.", 404);
      validarIdentidade({ cliente, conta, clienteContaId, marketplace: "meli" });
      if (conta.external_account_id && String(conta.external_account_id) !== seller) {
        throw erroContexto("ML_ACCOUNT_MISMATCH", "Seller OAuth incompatível com a Conta.");
      }
    } else {
      const exact = await client.query("SELECT * FROM cliente_contas WHERE cliente_id = $1 AND marketplace = 'meli' AND external_account_id = $2", [cliente.id, seller]);
      if (exact.rows.length > 1) throw erroContexto("ACCOUNT_CONTEXT_AMBIGUOUS", "Mais de uma Conta para o seller OAuth.");
      conta = exact.rows[0] || null;
      if (conta) validarIdentidade({ cliente, conta, marketplace: "meli" });
    }
    const identidade = conta || { id: null, cliente_id: cliente.id, marketplace: "meli", ativo: true };
    await validarTitularidadeSeller(cliente, { ...identidade, external_account_id: seller }, client);
    const grant = await mlTokenService.saveMlToken({ clienteId: cliente.id, mlUserId: seller,
      accessToken, refreshToken, expiresAt, transactionClient: client });
    if (!grant?.id) throw erroContexto("GRANT_PERSIST_FAILED", "Grant OAuth não foi persistido.");
    const resolvida = conta
      ? await vincularGrantMlNaConta({ contaId: conta.id, mlUserId: seller, transactionClient: client })
      : await garantirContaMlParaGrant({ clienteId: cliente.id, clienteSlug, mlUserId: seller,
          grantIsPrimary: grant?.is_primary === true, transactionClient: client });
    if (!resolvida) throw erroContexto("ACCOUNT_BINDING_FAILED", "Não foi possível associar a Conta OAuth.");
    validarIdentidade({ cliente, conta: resolvida, grant: { ...grant, cliente_conta_id: resolvida.id } });
    await client.query("COMMIT");
    mlTokenService.clearGrantBackoff(grant.id);
    return { grant, conta: resolvida };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    if (error.code === "23505") throw erroContexto("ACCOUNT_CONTEXT_AMBIGUOUS", "Conflito de identidade durante OAuth.");
    error.message = mlTokenService.sanitizeErrorMessage(error, [accessToken, refreshToken]);
    throw error;
  } finally { client.release(); }
}

async function atualizarConta(contaId, { nome, ativo } = {}) {
  const conta = await obterConta(contaId);
  const patches = [];
  const params = [];

  if (nome !== undefined) {
    const nomeFinal = String(nome || "").trim();
    if (!nomeFinal) throw criarErroHttp(400, "nome não pode ser vazio.");
    params.push(nomeFinal);
    patches.push(`nome = $${params.length}`);
  }

  if (ativo !== undefined) {
    const ativoBool = Boolean(ativo);
    params.push(ativoBool);
    patches.push(`ativo = $${params.length}`);
    // Desativar a conta principal libera o slot; não promove outra
    // automaticamente (evitaria escolha silenciosa de conta).
    if (!ativoBool) patches.push(`is_primary = false`);
  }

  if (!patches.length) throw criarErroHttp(400, "Nenhum campo para atualizar.");

  patches.push("updated_at = NOW()");
  params.push(conta.id);
  const result = await pool.query(
    `UPDATE cliente_contas SET ${patches.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params
  );
  return sanitizarConta(result.rows[0]);
}

async function definirContaPrincipal(contaId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT id, cliente_id, marketplace, ativo FROM cliente_contas WHERE id = $1 FOR UPDATE", [contaId]);
    const conta = found.rows[0];
    if (!conta) throw criarErroHttp(404, "Conta não encontrada.");
    if (!conta.ativo) throw criarErroHttp(409, "Conta inativa não pode ser principal.");

    await client.query(`SELECT pg_advisory_xact_lock(1296845909, $1)`, [Number(conta.cliente_id)]);
    await client.query(
      "UPDATE cliente_contas SET is_primary = false, updated_at = NOW() WHERE cliente_id = $1 AND marketplace = $2 AND is_primary = true AND id <> $3",
      [conta.cliente_id, conta.marketplace, conta.id]
    );
    const updated = await client.query(
      "UPDATE cliente_contas SET is_primary = true, updated_at = NOW() WHERE id = $1 RETURNING *",
      [conta.id]
    );
    await client.query("COMMIT");
    return sanitizarConta(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function obterBaseDaConta(contaId, queryable = pool) {
  const conta = await obterConta(contaId, queryable);
  const direto = await queryable.query(
    `SELECT v.id AS vinculo_id, v.base_id, b.slug, b.nome
       FROM base_cliente_vinculos v
       JOIN bases b ON b.id = v.base_id
      WHERE v.cliente_conta_id = $1 AND v.ativo = true
      LIMIT 1`,
    [conta.id]
  );
  if (direto.rows.length) return { ...direto.rows[0], resolvido_por: "conta" };

  // Compatibilidade: se esta é a única conta ativa daquele marketplace para
  // o cliente, um vínculo legado (cliente_id + marketplace) ainda identifica
  // a base sem ambiguidade.
  const outrasContas = await queryable.query(
    "SELECT COUNT(*)::int AS total FROM cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true",
    [conta.cliente_id, conta.marketplace]
  );
  if ((outrasContas.rows[0]?.total || 0) !== 1) return { vinculo_id: null, base_id: null, resolvido_por: null };

  const legado = await queryable.query(
    `SELECT v.id AS vinculo_id, v.base_id, b.slug, b.nome
       FROM base_cliente_vinculos v
       JOIN bases b ON b.id = v.base_id
      WHERE v.cliente_id = $1 AND v.marketplace = $2 AND v.ativo = true
      ORDER BY v.updated_at DESC NULLS LAST, v.id DESC
      LIMIT 1`,
    [conta.cliente_id, conta.marketplace]
  );
  if (!legado.rows.length) return { vinculo_id: null, base_id: null, resolvido_por: null };
  return { ...legado.rows[0], resolvido_por: "legado_unico" };
}

// Núcleo transacional do vínculo account-aware. Não abre/fecha transação —
// quem chama (vincularBaseNaConta ou um comando maior, ex.: importação
// atômica de base) controla BEGIN/COMMIT/ROLLBACK e passa o client.
//
// Invariante de cardinalidade (decisão da correção pós-auditoria): uma
// cliente_conta tem no máximo 1 base oficial ativa, e uma base tem no
// máximo 1 vínculo ativo. "Trocar base" da mesma conta desativa o vínculo
// anterior da CONTA (não só o da base) na mesma transação — sem isso, uma
// conta acumulava vínculos ativos em bases diferentes (achado P1 da
// auditoria: trocar base não desativava o vínculo antigo da conta).
async function vincularBaseNaContaTx(client, { contaId, baseId, userId = null }) {
  const conta = await obterConta(contaId, client);
  if (conta.ativo === false) {
    throw criarErroHttp(422, `Conta "${conta.nome}" está inativa e não pode receber vínculo de base.`, {
      code: "CONTA_INATIVA",
    });
  }

  const baseIdNum = Number(baseId);
  if (!Number.isInteger(baseIdNum) || baseIdNum <= 0) throw criarErroHttp(400, "base_id inválido.");

  const base = await client.query("SELECT id, slug, nome, marketplace, ativo FROM bases WHERE id = $1", [baseIdNum]);
  if (!base.rows.length) throw criarErroHttp(404, "Base não encontrada.");
  const baseRow = base.rows[0];

  if (baseRow.ativo === false) {
    throw criarErroHttp(422, `Base "${baseRow.nome}" está inativa e não pode receber vínculo.`, {
      code: "BASE_INATIVA",
    });
  }

  if (String(baseRow.marketplace || "").toLowerCase() !== conta.marketplace) {
    throw criarErroHttp(422, `Base é do marketplace "${baseRow.marketplace}" e a conta é "${conta.marketplace}". Vínculo bloqueado.`, {
      code: "BASE_MARKETPLACE_MISMATCH",
    });
  }

  // Cardinalidade: desativa o vínculo anterior da BASE e o vínculo anterior
  // da CONTA (podem ser linhas diferentes) antes de ativar o novo.
  await client.query(
    "UPDATE base_cliente_vinculos SET ativo = false, updated_at = NOW() WHERE base_id = $1 AND ativo = true",
    [baseIdNum]
  );
  await client.query(
    "UPDATE base_cliente_vinculos SET ativo = false, updated_at = NOW() WHERE cliente_conta_id = $1 AND ativo = true",
    [conta.id]
  );

  const vinculo = await client.query(
    `INSERT INTO base_cliente_vinculos
       (base_id, cliente_id, cliente_conta_id, marketplace, origem, ativo, confirmado_por, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'conta', true, $5, NOW(), NOW())
     RETURNING *`,
    [baseIdNum, conta.cliente_id, conta.id, conta.marketplace, userId || null]
  );

  return { base: baseRow, vinculo: vinculo.rows[0], conta };
}

// Wrapper com transação própria — mantém a assinatura pública usada por
// clienteContasController (PUT /cliente-contas/:id/base).
async function vincularBaseNaConta(contaId, baseIdRaw, { userId = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const resultado = await vincularBaseNaContaTx(client, { contaId, baseId: baseIdRaw, userId });
    await client.query("COMMIT");
    return resultado;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Desconecta APENAS o grant ML ligado a esta conta — nunca os grants de
// outras contas do mesmo cliente. Complementar a (não substitui)
// DELETE /clientes/:slug/ml-token, que continua existindo por
// compatibilidade legada.
async function desconectarGrantMlDaConta(contaId) {
  const conta = await obterConta(contaId);
  if (conta.marketplace !== "meli") {
    throw criarErroHttp(422, "Esta conta não é Mercado Livre.");
  }
  const result = await pool.query(
    "DELETE FROM ml_tokens WHERE cliente_conta_id = $1 RETURNING id, ml_user_id",
    [conta.id]
  );
  if (!result.rows.length) {
    throw criarErroHttp(404, "Esta conta não possui um grant Mercado Livre vinculado (migration de backfill pode não ter rodado ainda).");
  }
  return { conta_id: conta.id, grants_removidos: result.rows.map((r) => r.id) };
}

// Porta de entrada para operações account-sensitive. Nunca escolhe
// silenciosamente entre 2+ contas do mesmo marketplace — ver seção 7 da
// auditoria/spec (regra de ambiguidade).
//
// `queryable` é opcional (default: pool real) e existe para permitir
// injeção de um db fake em testes de consumidores (ex.: Central de Vendas),
// sem precisar monkeypatchar o singleton do pool. Todo chamador existente
// (Central Full, /clientes, /bases) continua igual — não passa esse campo e
// cai no default.
async function resolveMarketplaceAccountContext({ clienteId, clienteSlug, marketplace, clienteContaId = null, requireUsableGrant = false, queryable = pool, strictIdentity = false, resolveBase = true }) {
  const cliente = await resolverClientePorIdOuSlug({ clienteId, clienteSlug }, queryable);
  const marketplaceNorm = normalizarMarketplaceConta(marketplace);
  if (!marketplaceNorm) throw criarErroHttp(400, "marketplace deve ser 'meli' ou 'shopee'.");

  let conta = null;

  if (clienteContaId != null) {
    conta = await obterConta(clienteContaId, queryable);
    if (conta.cliente_id !== cliente.id) {
      throw criarErroHttp(403, "Esta conta não pertence ao cliente informado.", {
        code: "CONTA_NAO_PERTENCE_AO_CLIENTE",
      });
    }
    if (conta.marketplace !== marketplaceNorm) {
      throw criarErroHttp(422, "Esta conta não é do marketplace informado.", {
        code: "MARKETPLACE_INCOMPATIVEL",
      });
    }
    // V3 Master Spec M32: uma operação account-aware nunca pode operar
    // silenciosamente numa conta desativada, mesmo com clienteContaId
    // explícito (ex.: link antigo, cache do frontend). Antes desta checagem,
    // resolveMarketplaceAccountContext não rejeitava conta inativa.
    if (conta.ativo === false) {
      throw criarErroHttp(409, `A conta "${conta.nome}" foi desativada.`, {
        code: "CONTA_INATIVA",
      });
    }
  } else {
    const ativas = await queryable.query(
      "SELECT * FROM cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true ORDER BY is_primary DESC, created_at ASC, id ASC",
      [cliente.id, marketplaceNorm]
    );
    if (ativas.rows.length === 1) {
      conta = ativas.rows[0];
    } else if (ativas.rows.length > 1) {
      throw criarErroHttp(409, "O cliente possui mais de uma conta para este marketplace; informe cliente_conta_id.", {
        code: "MULTIPLE_MARKETPLACE_ACCOUNTS",
        contas: ativas.rows.map(sanitizarConta),
      });
    }
    // 0 contas ativas: segue em modo legado (conta = null).
  }

  if (strictIdentity) {
    if (!conta) throw erroContexto("ACCOUNT_CONTEXT_NOT_FOUND", "Cliente sem operação ativa.", 404);
    if (cliente.ativo === false) throw erroContexto("CLIENTE_INATIVO", "Cliente inativo.");
    validarIdentidade({ cliente, conta, marketplace: marketplaceNorm });
    await validarTitularidadeSeller(cliente, conta, queryable);
  }

  const context = {
    cliente: { id: cliente.id, nome: cliente.nome, slug: cliente.slug },
    marketplace: marketplaceNorm,
    conta: sanitizarConta(conta),
    grant: null,
    mlUserId: null,
    base: null,
  };

  if (marketplaceNorm === "meli") {
    const tokenService = mlTokenService.createMlTokenService({ db: queryable });
    if (conta) {
      context.mlUserId = conta.external_account_id || null;
      if (context.mlUserId) {
        try {
          context.grant = await tokenService.resolveMlGrant({
            clienteId: cliente.id,
            mlUserId: context.mlUserId,
            requireUsable: requireUsableGrant,
          });
        } catch (error) {
          if (requireUsableGrant) throw error;
          context.grantError = error.code || error.message;
        }
      }
    } else {
      // Legado: sem conta cadastrada, comportamento pré-existente (principal/fallback).
      try {
        context.grant = await tokenService.resolveMlGrant({ clienteId: cliente.id, requireUsable: requireUsableGrant });
        context.mlUserId = context.grant?.ml_user_id != null ? String(context.grant.ml_user_id) : null;
      } catch (error) {
        if (requireUsableGrant) throw error;
        context.grantError = error.code || error.message;
      }
    }
  }

  if (strictIdentity) {
    validarIdentidade({ cliente, conta: context.conta, grant: context.grant, marketplace: marketplaceNorm });
    if (marketplaceNorm === "meli" && requireUsableGrant && !context.grant) {
      throw erroContexto("ML_GRANT_NOT_FOUND", "Conta sem Grant Mercado Livre exato.", 424);
    }
    context.base = resolveBase ? await resolverBaseEstrita(cliente, context.conta, queryable) : null;
    return context;
  }

  if (conta) {
    context.base = await obterBaseDaConta(conta.id, queryable);
  } else {
    const legado = await queryable.query(
      `SELECT v.id AS vinculo_id, v.base_id, b.slug, b.nome
         FROM base_cliente_vinculos v
         JOIN bases b ON b.id = v.base_id
        WHERE v.cliente_id = $1 AND v.marketplace = $2 AND v.ativo = true
        ORDER BY v.updated_at DESC NULLS LAST, v.id DESC
        LIMIT 1`,
      [cliente.id, marketplaceNorm]
    );
    context.base = legado.rows.length ? { ...legado.rows[0], resolvido_por: "legado" } : { vinculo_id: null, base_id: null, resolvido_por: null };
  }

  return context;
}

module.exports = {
  normalizarMarketplaceConta,
  normalizarMarketplaceCadastro,
  MARKETPLACES_CADASTRO,
  resolverClientePorIdOuSlug,
  listarContasDoCliente,
  listarContasDeClientesAtivos,
  resolverContaParaVinculoLegado,
  obterConta,
  criarConta,
  concluirOAuthContaMl,
  garantirContaMlParaGrant,
  vincularGrantMlNaConta,
  atualizarNicknameConta,
  atualizarConta,
  definirContaPrincipal,
  obterBaseDaConta,
  vincularBaseNaConta,
  vincularBaseNaContaTx,
  desconectarGrantMlDaConta,
  resolveMarketplaceAccountContext,
  sanitizarConta,
};
