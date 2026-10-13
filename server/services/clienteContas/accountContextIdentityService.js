// Invariantes de identidade compartilhados; somente SELECT, sem refresh/sync.
// A resolução continua em clienteContaService. O modo estrito é opt-in:
// Central de Vendas mantém o contrato padrão sem consultas novas.
const pool = require("../../config/database");
const { assertAccountContext } = require("./accountContextInvariant");
function criarErroHttp(statusCode, payload) {
  const err = new Error(payload.erro); err.statusCode = statusCode;
  err.code = payload.code || payload.codigo; err.payload = payload; return err;
}
function erroContexto(code, mensagem, statusCode = 409, ids = {}) {
  return criarErroHttp(statusCode, { ok: false, code, codigo: code, erro: mensagem, ...ids });
}

function validarIdentidade({ cliente, conta, grant = null, base = null, eligibleAccountCount = null, clienteContaId = conta?.id, marketplace = "meli" }) {
  assertAccountContext({ clienteId: cliente.id, clienteContaId,
    marketplace, conta, grant, base, requireAccount: true,
    mlUserId: grant?.ml_user_id, strict: true, eligibleAccountCount });
}

// Projeções de identidade, sem credenciais. Inclui Grants históricos: um
// status inválido não é prova de titularidade comercial diferente.
async function validarTitularidadeSeller(cliente, conta, queryable = pool) {
  const seller = conta.external_account_id;
  if (!seller || conta.marketplace !== "meli") return;
  const contas = await queryable.query(
    "SELECT id, cliente_id FROM cliente_contas WHERE marketplace = 'meli' AND external_account_id = $1",
    [String(seller)]
  );
  const grants = await queryable.query(
    "SELECT id, cliente_id, cliente_conta_id, ml_user_id FROM ml_tokens WHERE ml_user_id = $1",
    [String(seller)]
  );
  if (contas.rows.some((c) => Number(c.cliente_id) !== Number(cliente.id)) ||
      grants.rows.some((g) => Number(g.cliente_id) !== Number(cliente.id))) {
    throw erroContexto("SELLER_OWNERSHIP_AMBIGUOUS", "Seller vinculado a mais de um Cliente; revise a titularidade.", 409,
      { clienteId: cliente.id, clienteContaId: conta.id });
  }
  if (contas.rows.some((c) => Number(c.id) !== Number(conta.id))) {
    throw erroContexto("ACCOUNT_CONTEXT_AMBIGUOUS", "Seller vinculado a mais de uma Conta.");
  }
  if (grants.rows.length > 1) {
    throw erroContexto("GRANT_CONTEXT_AMBIGUOUS", "Mais de um Grant para a identidade operacional.");
  }
  for (const grant of grants.rows) validarIdentidade({ cliente, conta, grant });
}

async function resolverBaseEstrita(cliente, conta, queryable = pool) {
  const r = await queryable.query(
    `SELECT b.id, b.id AS base_id, b.slug, b.nome, b.ativo, b.marketplace,
            v.id AS vinculo_id, v.cliente_id, v.cliente_conta_id,
            v.marketplace AS vinculo_marketplace, v.ativo AS vinculo_ativo
       FROM base_cliente_vinculos v JOIN bases b ON b.id = v.base_id
      WHERE v.cliente_id = $1 AND v.marketplace = $2 AND v.ativo = true`,
    [cliente.id, conta.marketplace]
  );
  const count = await queryable.query(
    "SELECT COUNT(*)::int AS total FROM cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true",
    [cliente.id, conta.marketplace]
  );
  const eligibleAccountCount = Number(count.rows[0]?.total || 0);
  const direct = r.rows.filter(b => Number(b.cliente_conta_id) === Number(conta.id));
  const legacy = r.rows.filter(b => b.cliente_conta_id == null);
  if (!direct.length && legacy.length && eligibleAccountCount !== 1) {
    throw erroContexto("ACCOUNT_CONTEXT_AMBIGUOUS", "Base legada sem operação inequívoca.");
  }
  const candidates = direct.concat(eligibleAccountCount === 1 ? legacy : []);
  if (candidates.length > 1) throw erroContexto("ACCOUNT_CONTEXT_AMBIGUOUS", "Mais de uma Base elegível para a Conta.");
  if (!candidates.length) return { base_id: null, vinculo_id: null, resolvido_por: null };
  const base = candidates[0];
  validarIdentidade({ cliente, conta, base, eligibleAccountCount, marketplace: conta.marketplace });
  return { ...base, resolvido_por: base.cliente_conta_id == null ? "legado_unico" : "conta" };
}
module.exports = { erroContexto, validarIdentidade, validarTitularidadeSeller, resolverBaseEstrita };
