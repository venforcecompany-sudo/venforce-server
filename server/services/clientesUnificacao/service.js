const { finalIdentityViolations, TRANSACTION_TIME } = require("./identity");
const { isCurrentGrant, currentGrantSql } = require("../mlGrantIdentity");
const {
  flags,
  previewTimeoutMs,
  executeTimeoutMs,
} = require("../../config/clientesUnificacao");
const {
  normalizeManifest,
  confirmation,
  rollbackConfirmation,
  requireAdmin,
  fail,
  hash,
  safeError,
} = require("./contracts");
const { buildPlan, ledgerSnapshot, canonicalId } = require("./planner");
const defaultRepository = require("./repository");
function createService({
  pool,
  repository = defaultRepository,
  getFlags = flags,
  getPreviewTimeoutMs = previewTimeoutMs,
  getExecuteTimeoutMs = executeTimeoutMs,
  now = Date.now,
} = {}) {
  if (!pool) throw new Error("UNIFICATION_POOL_REQUIRED");
  const repo = repository;
  async function connection(fn) {
    const client = await pool.connect();
    let failed = null;
    try {
      return await fn(client);
    } catch (e) {
      failed = e;
      throw safeError(e);
    } finally {
      client.release(
        failed &&
          (failed.discardConnection ||
            /^(?:08|57P|ECONN)/.test(failed.code || ""))
          ? failed
          : undefined,
      );
    }
  }
  async function transaction(db, fn, { readOnly = false, retries = 0 } = {}) {
    for (let attempt = 0; ; attempt++) {
      let active = false;
      const baseQuery = db.query;
      const budget = readOnly ? getPreviewTimeoutMs() : getExecuteTimeoutMs();
      const deadline = now() + budget;
      db.query = async function (...args) {
        const command = String(args[0]).trim().toUpperCase();
        if (command !== "ROLLBACK" && now() > deadline)
          throw fail("MERGE_TRANSACTION_TIMEOUT");
        const result = await baseQuery.apply(db, args);
        if (!["ROLLBACK", "COMMIT"].includes(command) && now() > deadline)
          throw fail("MERGE_TRANSACTION_TIMEOUT");
        return result;
      };
      try {
        await db.query(
          readOnly
            ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
            : "BEGIN ISOLATION LEVEL SERIALIZABLE",
        );
        active = true;
        // Nenhuma query legítima pode morrer antes do orçamento global.
        await db.query(
          `SET LOCAL statement_timeout='${budget}ms'`,
        );
        await db.query("SET LOCAL lock_timeout='1500ms'");
        await db.query(
          "SET LOCAL idle_in_transaction_session_timeout='15000ms'",
        );
        const value = await fn();
        await db.query("COMMIT");
        active = false;
        return value;
      } catch (e) {
        if (active)
          try {
            await db.query("ROLLBACK");
          } catch (_) {}
        // SSI pode abortar destinos independentes por predicado. Só repetir 40001
        // comprovadamente pré-commit; cada tentativa recalcula/hash/valida sob locks.
        if (e.code === "40001" && attempt < retries) continue;
        throw e;
      } finally {
        db.query = baseQuery;
      }
    }
  }
  const requireFlag = (kind) => {
    if (!getFlags()[kind])
      throw fail(`CLIENTES_UNIFICACAO_${kind.toUpperCase()}_DISABLED`, 403);
  };
  function replay(row, requestHash, actor) {
    if (
      row.request_hash !== requestHash ||
      Number(row.requested_by_user_id) !== Number(actor.id)
    )
      throw fail("IDEMPOTENCY_KEY_REUSED");
    if (["failed", "blocked"].includes(row.status))
      throw fail("IDEMPOTENCY_RETRY_REQUIRES_NEW_KEY");
    return repo.operation(row);
  }
  function previewResult(snapshot, plan) {
    const ids = [
      plan.manifest.clienteCanonicoId,
      ...plan.manifest.clientesLegadosIds,
    ];
    const selected = (t) =>
      (snapshot.tables[t] || []).filter((r) =>
        ids.includes(Number(r.cliente_id)),
      );
    const safe = (row) =>
      Object.fromEntries(Object.entries(row).filter(([k]) => k !== "_version"));
    const basesIds = new Set(
      selected("base_cliente_vinculos").map((v) => String(v.base_id)),
    );
    return {
      manifest: plan.manifest,
      planHash: plan.planHash,
      canExecute: plan.validation.ok && getFlags().execute,
      validationReady: plan.validation.ok,
      blockers: plan.validation.blockers,
      warnings: plan.validation.warnings,
      info: plan.validation.info,
      clienteCanonico: safe(
        (snapshot.tables.clientes || []).find(
          (r) => Number(r.id) === plan.manifest.clienteCanonicoId,
        ) || {},
      ),
      clientesLegados: (snapshot.tables.clientes || [])
        .filter((r) => plan.manifest.clientesLegadosIds.includes(Number(r.id)))
        .map(safe),
      clienteContas: selected("cliente_contas").map(safe),
      grants: selected("ml_tokens").map(safe),
      bases: (snapshot.tables.bases || [])
        .filter((r) => basesIds.has(String(r.id)))
        .map(safe),
      baseVinculos: selected("base_cliente_vinculos").map(safe),
      squad: selected("cliente_squad_history")
        .filter((r) => r.fim_em == null)
        .map(safe),
      responsaveis: selected("cliente_responsaveis").map(safe),
      impactCounts: plan.impactCounts,
      decisionsRequired: plan.decisionsRequired,
      confirmationText: confirmation(plan.manifest),
      plan,
    };
  }
  // Fluxo simples: o admin autenticado que valida/executa é o aprovador. Só
  // preenche quando o manifesto não traz aprovador nem referência; aprovação
  // explícita (API/CLI) segue valendo como está.
  function withActorApproval(input, actor) {
    const a = input?.aprovacao;
    if (!input || (a && (a.aprovadorUserId != null || a.evidencia != null)))
      return input;
    return {
      ...input,
      aprovacao: {
        aprovada: true,
        aprovadorUserId: Number(actor.id),
        evidencia: "ADMIN_AUTENTICADO",
      },
    };
  }
  async function preview(input, actor) {
    requireAdmin(actor);
    const manifest = normalizeManifest(withActorApproval(input, actor));
    return connection(async (db) => {
      const result = await transaction(
        db,
        async () => {
          const snapshot = await repo.readSnapshot(db, manifest);
          return previewResult(snapshot, buildPlan(snapshot, manifest));
        },
        { readOnly: true },
      );
      await repo.audit(
        db,
        result.validationReady
          ? "CLIENT_UNIFICATION_PREVIEW"
          : "CLIENT_UNIFICATION_BLOCKED",
        actor,
        null,
        {
          planHash: result.planHash,
          clienteCanonicoId: manifest.clienteCanonicoId,
          blockerCodes: result.blockers.map((x) => x.code),
        },
      );
      return result;
    });
  }
  async function execute(input, actor) {
    requireAdmin(actor);
    requireFlag("execute");
    const manifest = normalizeManifest(withActorApproval(input?.manifest, actor));
    if (!/^[a-f0-9]{64}$/.test(input.planHash || ""))
      throw fail("PLAN_HASH_REQUIRED", 422);
    if (
      typeof input.idempotencyKey !== "string" ||
      !/^[A-Za-z0-9_.:-]{8,128}$/.test(input.idempotencyKey)
    )
      throw fail("IDEMPOTENCY_KEY_INVALID", 422);
    if (input.confirmationText !== confirmation(manifest))
      throw fail("STRONG_CONFIRMATION_REQUIRED", 422);
    const requestHash = hash({ manifest, planHash: input.planHash });
    return connection(async (db) => {
      const existing = await repo.findKey(db, input.idempotencyKey);
      if (existing) return replay(existing, requestHash, actor);
      const plan = await transaction(
        db,
        async () => buildPlan(await repo.readSnapshot(db, manifest), manifest),
        { readOnly: true },
      );
      if (plan.planHash !== input.planHash) throw fail("MERGE_PLAN_CHANGED");
      if (!plan.validation.ok) {
        await repo.audit(db, "CLIENT_UNIFICATION_BLOCKED", actor, null, {
          planHash: plan.planHash,
          blockerCodes: plan.validation.blockers.map((b) => b.code),
        });
        throw fail("MERGE_VALIDATION_BLOCKED");
      }
      const reservation = await repo.reserve(db, {
        manifest,
        plan,
        actor,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      });
      if (!reservation.created)
        return replay(reservation.row, requestHash, actor);
      const op = reservation.row;
      try {
        return await transaction(
          db,
          async () => {
            await repo.lockClients(db, manifest);
            const snapshot = await repo.readSnapshot(db, manifest);
            await repo.lockRows(db, snapshot, manifest);
            const locked = await repo.readSnapshot(db, manifest),
              fresh = buildPlan(locked, manifest);
            if (fresh.planHash !== input.planHash)
              throw fail("MERGE_PLAN_CHANGED");
            if (!fresh.validation.ok) throw fail("MERGE_VALIDATION_BLOCKED");
            // Material + footprints dos filhos preservados (sem linhas).
            const before = ledgerSnapshot(locked, manifest);
            const appliedChanges = await materializeChanges(db, fresh.changes);
            const rollbackChanges = [...appliedChanges]
              .reverse()
              .map((c) => ({
                ...c,
                pk: Object.fromEntries(
                  Object.entries(c.pk).map(([k, v]) => [
                    k,
                    Object.hasOwn(c.after, k) ? c.after[k] : v,
                  ]),
                ),
                before: c.after,
                after: c.before,
              }));
            await repo.update(db, op.id, {
              status: "executing",
              started_at: new Date(),
              before_snapshot_json: before,
              rollback_plan_json: { changes: rollbackChanges },
            });
            await repo.applyChanges(db, locked, appliedChanges);
            const afterSource = await repo.readSnapshot(db, manifest);
            verifyChanges(afterSource, appliedChanges);
            verifyIdentity(afterSource, manifest, fresh);
            const after = ledgerSnapshot(afterSource, manifest);
            const expected = JSON.parse(JSON.stringify(before));
            for (const c of appliedChanges) {
              const row = expected[c.table]?.find((r) =>
                Object.entries(c.pk).every(
                  ([k, v]) => String(r[k]) === String(v),
                ),
              );
              if (!row) throw fail("MERGE_POST_VALIDATION_FAILED");
              Object.assign(row, c.after);
            }
            if (
              hash(withoutVersions(after)) !== hash(withoutVersions(expected))
            )
              throw fail("MERGE_POST_VALIDATION_FAILED");
            // After e completed no MESMO commit dos dados. Evita a janela "dados
            // commitados / ledger pendente" se o processo cair antes da resposta.
            const completed = await repo.update(db, op.id, {
              status: "completed",
              after_snapshot_json: after,
              finished_at: new Date(),
            });
            await repo.audit(db, "CLIENT_UNIFICATION_EXECUTED", actor, op, {
              planHash: fresh.planHash,
            });
            return repo.operation(completed);
          },
          { retries: 2 },
        );
      } catch (raw) {
        const error = safeError(raw);
        // Commit de resultado desconhecido por queda de conexão nunca é tratado
        // como failed: retry deve consultar ledger persistido, sem reaplicar.
        try {
          const persisted = await repo.detail(db, op.id);
          if (persisted?.status === "completed")
            return repo.operation(persisted);
          if (persisted?.status === "validated")
            await transaction(db, async () => {
              await repo.update(db, op.id, {
                status: "failed",
                error_code: error.code,
                error_message_safe: error.code,
                finished_at: new Date(),
              });
              await repo.audit(db, "CLIENT_UNIFICATION_FAILED", actor, op, {
                errorCode: error.code,
              });
            });
        } catch (_) {}
        throw error;
      }
    });
  }
  async function rollback(id, input, actor) {
    requireAdmin(actor);
    requireFlag("rollback");
    if (!/^[1-9][0-9]{0,18}$/.test(String(id)))
      throw fail("OPERATION_ID_INVALID", 422);
    if (input?.confirmationText !== rollbackConfirmation({ id: String(id) }))
      throw fail("STRONG_CONFIRMATION_REQUIRED", 422);
    return connection(async (db) => {
      const original = await repo.detail(db, id);
      if (!original) throw fail("MERGE_OPERATION_NOT_FOUND", 404);
      if (original.status === "rolled_back") return repo.operation(original);
      if (!["completed", "rollback_failed"].includes(original.status))
        throw fail("ROLLBACK_OPERATION_NOT_COMPLETED");
      const manifest = normalizeManifest(original.manifest_json);
      try {
        return await transaction(
          db,
          async () => {
            await repo.lockClients(db, manifest);
            const op = await repo.detail(db, id, { lock: true });
            if (op.status === "rolled_back") return repo.operation(op);
            if (!["completed", "rollback_failed"].includes(op.status))
              throw fail("ROLLBACK_OPERATION_NOT_COMPLETED");
            const snapshot = await repo.readSnapshot(db, manifest);
            await repo.lockRows(db, snapshot, manifest);
            const locked = await repo.readSnapshot(db, manifest);
            if (
              hash(ledgerSnapshot(locked, manifest)) !==
                hash(op.after_snapshot_json) ||
              locked.errors.length
            )
              throw fail("ROLLBACK_STATE_DIVERGED");
            // Catalog changes also invalidate rollback, even if rows stayed equal.
            const catalogHash = hash({
              columns: sort(locked.columns),
              constraints: sort(locked.constraints),
              indexes: sort(locked.indexes),
            });
            if (catalogHash !== op.plan_json.catalogHash)
              throw fail("ROLLBACK_STATE_DIVERGED");
            await repo.applyChanges(db, locked, op.rollback_plan_json.changes);
            const restored = await repo.readSnapshot(db, manifest);
            verifyChanges(restored, op.rollback_plan_json.changes);
            // Row versions must change on UPDATE; compare all safe identities/keys
            // while retaining original versions in the immutable before snapshot.
            if (
              hash(withoutVersions(ledgerSnapshot(restored, manifest))) !==
              hash(withoutVersions(op.before_snapshot_json))
            )
              throw fail("ROLLBACK_POST_VALIDATION_FAILED");
            const finished = await repo.update(db, id, {
              status: "rolled_back",
              rolled_back_at: new Date(),
              error_code: null,
              error_message_safe: null,
            });
            await repo.audit(db, "CLIENT_UNIFICATION_ROLLED_BACK", actor, op, {
              planHash: op.plan_hash,
            });
            return repo.operation(finished);
          },
          { retries: 2 },
        );
      } catch (raw) {
        const error = safeError(raw);
        try {
          const persisted = await repo.detail(db, id);
          if (persisted?.status === "rolled_back")
            return repo.operation(persisted);
          if (["completed", "rollback_failed"].includes(persisted?.status))
            await transaction(db, async () => {
              await repo.update(db, id, {
                status: "rollback_failed",
                error_code: error.code,
                error_message_safe: error.code,
              });
              await repo.audit(
                db,
                "CLIENT_UNIFICATION_ROLLBACK_BLOCKED",
                actor,
                original,
                { errorCode: error.code },
              );
            });
        } catch (_) {}
        throw error;
      }
    });
  }
  async function detail(id, actor) {
    requireAdmin(actor);
    if (!/^[1-9][0-9]{0,18}$/.test(String(id)))
      throw fail("OPERATION_ID_INVALID", 422);
    return connection(async (db) => {
      const op = await repo.detail(db, id);
      if (!op) throw fail("MERGE_OPERATION_NOT_FOUND", 404);
      return repo.operation(op);
    });
  }
  async function history(input = {}, actor) {
    requireAdmin(actor);
    const allowed = [
      "planned",
      "validated",
      "blocked",
      "executing",
      "completed",
      "failed",
      "rolled_back",
      "rollback_failed",
    ];
    if (input.status && !allowed.includes(input.status))
      throw fail("HISTORY_FILTER_INVALID", 422);
    for (const key of ["clienteId", "cursor"])
      if (input[key] != null && !/^[1-9][0-9]{0,18}$/.test(String(input[key])))
        throw fail("HISTORY_FILTER_INVALID", 422);
    const limit = input.limit == null ? 25 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw fail("HISTORY_FILTER_INVALID", 422);
    return connection(async (db) => {
      const rows = await repo.history(db, { ...input, limit });
      return {
        operations: rows.map((r) => repo.operation(r, { summary: true })),
        nextCursor: rows.length === limit ? String(rows.at(-1).id) : null,
      };
    });
  }
  async function search(input = {}, actor) {
    requireAdmin(actor);
    if (typeof (input.q ?? "") !== "string" || (input.q || "").length > 100)
      throw fail("SEARCH_INVALID", 422);
    return connection(async (db) => ({
      clientes: await repo.search(db, input.q || "", 30),
    }));
  }
  async function candidates(actor) {
    requireAdmin(actor);
    return connection(async (db) =>
      transaction(
        db,
        async () => {
          const tables = {};
          tables.clientes = (
            await db.query(
              "SELECT id,nome,slug,ativo,merged_into_cliente_id FROM clientes WHERE merged_into_cliente_id IS NULL ORDER BY id LIMIT 501",
            )
          ).rows;
          if (tables.clientes.length > 500)
            throw fail("CANDIDATE_SCOPE_TOO_LARGE");
          tables.cliente_contas = (
            await db.query(
              "SELECT id,cliente_id,external_account_id FROM cliente_contas LIMIT 5001",
            )
          ).rows;
          tables.ml_tokens = (
            await db.query(
              `SELECT id,cliente_id,ml_user_id FROM ml_tokens WHERE ${currentGrantSql()} LIMIT 5001`,
            )
          ).rows;
          tables.cliente_squad_history = (
            await db.query(
              "SELECT cliente_id,squad_id,fim_em FROM cliente_squad_history WHERE fim_em IS NULL LIMIT 501",
            )
          ).rows;
          if (
            tables.cliente_contas.length > 5000 ||
            tables.ml_tokens.length > 5000 ||
            tables.cliente_squad_history.length > 500
          )
            throw fail("CANDIDATE_SCOPE_TOO_LARGE");
          return {
            candidatos: require("./candidates").candidatePairs(tables),
            automaticMerge: false,
          };
        },
        { readOnly: true },
      ),
    );
  }
  async function resolveCanonicalCliente(id, { db } = {}) {
    const work = async (queryable) => {
      let current = Number(id);
      const seen = new Set();
      if (!Number.isSafeInteger(current) || current <= 0)
        throw fail("TARGET_INVALID", 422);
      for (let hops = 0; hops < 100; hops++) {
        if (seen.has(current)) throw fail("MERGE_CYCLE");
        seen.add(current);
        const row = (
          await queryable.query(
            "SELECT id,nome,slug,ativo,merged_into_cliente_id FROM clientes WHERE id=$1",
            [current],
          )
        ).rows[0];
        if (!row) throw fail("TARGET_INVALID", 404);
        if (row.merged_into_cliente_id == null)
          return {
            cliente: row,
            legacyClienteIds: [...seen].filter((x) => x !== current),
          };
        current = Number(row.merged_into_cliente_id);
      }
      throw fail("MERGE_CYCLE");
    };
    return db ? work(db) : connection(work);
  }
  return {
    preview,
    execute,
    rollback,
    detail,
    history,
    search,
    candidates,
    resolveCanonicalCliente,
  };
}
const sort = (rows) =>
  [...rows].sort((a, b) =>
    JSON.stringify(require("./contracts").canonical(a)).localeCompare(
      JSON.stringify(require("./contracts").canonical(b)),
    ),
  );
function withoutVersions(snapshot) {
  return Object.fromEntries(
    Object.entries(snapshot).map(([t, rows]) => [
      t,
      sort(
        rows.map((r) =>
          Object.fromEntries(
            Object.entries(r)
              .filter(([k]) => k !== "_version")
              .map(([k, v]) => [
                k,
                v != null && (k === "id" || k.endsWith("_id")) ? String(v) : v,
              ]),
          ),
        ),
      ),
    ]),
  );
}
function verifyChanges(snapshot, changes) {
  for (const c of changes) {
    const matches = (snapshot.tables[c.table] || []).filter((r) =>
      Object.entries(c.pk).every(
        ([k, v]) =>
          String(r[k]) === String(Object.hasOwn(c.after, k) ? c.after[k] : v),
      ),
    );
    if (
      matches.length !== 1 ||
      Object.entries(c.after).some(([k, v]) =>
        matches[0][k] == null || v == null
          ? matches[0][k] !== v
          : (matches[0][k] instanceof Date
              ? matches[0][k].toISOString()
              : String(matches[0][k])) !==
            (v instanceof Date ? v.toISOString() : String(v)),
      )
    )
      throw fail("MERGE_POST_VALIDATION_FAILED");
  }
}
async function materializeChanges(db, changes) {
  if (!changes.some((c) => c.after.superseded_at === TRANSACTION_TIME))
    return changes;
  const result = await db.query(
    "SELECT transaction_timestamp() AS identity_timestamp",
  );
  const timestamp = result.rows[0]?.identity_timestamp;
  if (!timestamp) throw fail("MERGE_TIMESTAMP_UNAVAILABLE");
  return changes.map((c) => ({
    ...c,
    after: {
      ...c.after,
      ...(c.after.superseded_at === TRANSACTION_TIME
        ? { superseded_at: new Date(timestamp).toISOString() }
        : {}),
    },
  }));
}
function verifyIdentity(snapshot, manifest, plan) {
  const target = manifest.clienteCanonicoId,
    accounts = snapshot.tables.cliente_contas || [],
    grants = snapshot.tables.ml_tokens || [],
    bindings = snapshot.tables.base_cliente_vinculos || [];
  for (const id of plan.preserved.clienteContaIds)
    if (
      !accounts.some(
        (a) => Number(a.id) === id && Number(a.cliente_id) === target,
      )
    )
      throw fail("MERGE_POST_VALIDATION_FAILED");
  for (const id of plan.preserved.grantIds)
    if (
      !grants.some(
        (g) =>
          Number(g.id) === id &&
          (Number(g.cliente_id) === target || !isCurrentGrant(g)),
      )
    )
      throw fail("MERGE_POST_VALIDATION_FAILED");
  if (
    manifest.schemaVersion === 2 &&
    finalIdentityViolations(
      snapshot.tables,
      target,
      (plan.identityResolution?.sellers || []).map((s) => s.seller),
    ).length
  )
    throw fail("MERGE_POST_VALIDATION_FAILED");
  for (const v of bindings.filter((v) => Number(v.cliente_id) === target))
    if (
      v.cliente_conta_id != null &&
      !accounts.some(
        (a) =>
          String(a.id) === String(v.cliente_conta_id) &&
          Number(a.cliente_id) === target,
      )
    )
      throw fail("MERGE_POST_VALIDATION_FAILED");
  for (const id of manifest.clientesLegadosIds) {
    const c = (snapshot.tables.clientes || []).find((c) => Number(c.id) === id);
    if (
      !c ||
      c.ativo !== false ||
      Number(c.merged_into_cliente_id) !== target ||
      canonicalId(snapshot.tables.clientes, id).id !== target
    )
      throw fail("MERGE_POST_VALIDATION_FAILED");
  }
}
module.exports = {
  createService,
  withoutVersions,
  verifyChanges,
  verifyIdentity,
  materializeChanges,
};
