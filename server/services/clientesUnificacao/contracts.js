const { createHash } = require("node:crypto");
const { rejectSecrets } = require("./snapshotPlanner");
function fail(code, statusCode = 409) {
  return Object.assign(new Error(code), { code, statusCode });
}
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
const hash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const id = (x) => Number.isSafeInteger(x) && x > 0 && x <= 2147483647;
function keys(obj, allowed) {
  if (
    !obj ||
    typeof obj !== "object" ||
    Array.isArray(obj) ||
    Object.keys(obj).some((k) => !allowed.includes(k)) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(obj))
  )
    throw fail("MANIFEST_INVALID", 422);
}
function normalizeManifest(input) {
  rejectSecrets(input);
  keys(input, [
    "schemaVersion",
    "clienteCanonicoId",
    "clientesLegadosIds",
    "decisoes",
    "aprovacao",
  ]);
  if (input.schemaVersion !== 1)
    throw fail("MANIFEST_VERSION_UNSUPPORTED", 422);
  if (!id(input.clienteCanonicoId)) throw fail("TARGET_INVALID", 422);
  const ids = input.clientesLegadosIds;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > 20 ||
    !ids.every(id) ||
    new Set(ids).size !== ids.length
  )
    throw fail("LEGACY_IDS_INVALID", 422);
  if (ids.includes(input.clienteCanonicoId))
    throw fail("ORIGIN_EQUALS_TARGET", 422);
  const decisions = input.decisoes || {};
  keys(decisions, ["primaryAccounts", "primaryGrantId", "referencias"]);
  keys(decisions.primaryAccounts || {}, ["meli", "shopee", "tiktok"]);
  if (
    Object.values(decisions.primaryAccounts || {}).some((x) => !id(x)) ||
    (decisions.primaryGrantId != null && !id(decisions.primaryGrantId))
  )
    throw fail("PRIMARY_DECISION_INVALID", 422);
  if (Object.keys(decisions.referencias || {}).length > 100)
    throw fail("REFERENCE_DECISION_INVALID", 422);
  keys(
    decisions.referencias || {},
    Object.keys(decisions.referencias || {}).filter((k) =>
      /^[a-z][a-z0-9_]{0,62}$/.test(k),
    ),
  );
  if (
    Object.values(decisions.referencias || {}).some(
      (x) =>
        ![
          "MOVE_TO_CANONICAL",
          "KEEP_AS_LEGACY_ORIGIN",
          "ACCOUNT_ALREADY_AUTHORITATIVE",
          "DERIVED_REBUILDABLE",
        ].includes(x),
    )
  )
    throw fail("REFERENCE_DECISION_INVALID", 422);
  const approval = input.aprovacao || {};
  keys(approval, ["aprovada", "aprovadorUserId", "evidencia"]);
  if (approval.aprovada != null && typeof approval.aprovada !== "boolean")
    throw fail("MANIFEST_INVALID", 422);
  // Referência documental curta, não texto livre ou conteúdo do documento.
  if (
    approval.evidencia != null &&
    (typeof approval.evidencia !== "string" ||
      !/^[\p{L}\p{N} /_.:#-]{1,160}$/u.test(approval.evidencia))
  )
    throw fail("APPROVAL_REFERENCE_INVALID", 422);
  if (approval.aprovadorUserId != null && !id(approval.aprovadorUserId))
    throw fail("MANIFEST_INVALID", 422);
  return canonical({
    schemaVersion: 1,
    clienteCanonicoId: input.clienteCanonicoId,
    clientesLegadosIds: [...ids].sort((a, b) => a - b),
    decisoes: {
      primaryAccounts: decisions.primaryAccounts || {},
      primaryGrantId: decisions.primaryGrantId ?? null,
      referencias: decisions.referencias || {},
    },
    aprovacao: {
      aprovada: approval.aprovada === true,
      aprovadorUserId: approval.aprovadorUserId ?? null,
      evidencia: approval.evidencia || null,
    },
  });
}
const confirmation = (m) =>
  `UNIFICAR ${m.clientesLegadosIds.join(",")} EM ${m.clienteCanonicoId}`;
const rollbackConfirmation = (op) => `REVERTER UNIFICACAO ${op.id}`;
function requireAdmin(actor) {
  if (
    !actor ||
    actor.role !== "admin" ||
    actor.ativo === false ||
    !id(Number(actor.id))
  )
    throw fail("ADMIN_REQUIRED", 403);
}
function safeError(e) {
  if (
    e?.discardConnection ||
    /^(?:08|57P|ECONN|EPIPE|ETIMEDOUT)/.test(e?.code || "")
  )
    return Object.assign(fail("MERGE_CONNECTION_LOST", 503), {
      discardConnection: true,
    });
  if (["23505", "23514", "23P01", "23503"].includes(e?.code))
    return fail("UNIQUE_OR_CONSTRAINT_COLLISION");
  if (["55P03", "40P01"].includes(e?.code)) return fail("MERGE_BUSY");
  if (e?.code === "40001") return fail("MERGE_PLAN_CHANGED");
  if (e?.code === "57014") return fail("MERGE_TRANSACTION_TIMEOUT");
  return /^[A-Z][A-Z0-9_]{1,80}$/.test(e?.code || "")
    ? fail(e.code, e.statusCode || 409)
    : fail("MERGE_OPERATION_FAILED", 500);
}
module.exports = {
  fail,
  canonical,
  hash,
  id,
  normalizeManifest,
  confirmation,
  rollbackConfirmation,
  requireAdmin,
  safeError,
};
