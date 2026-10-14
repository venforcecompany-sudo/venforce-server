const legacy = require("./snapshotPlanner");
const { normalizeManifest, hash, canonical } = require("./contracts");
const {
  checkAccountContext,
} = require("../clienteContas/accountContextInvariant");
const { strategy, core, infrastructure } = require("./references");
const same = (a, b) => a != null && b != null && String(a) === String(b);
const rows = (s, t) => s.tables?.[t] || [];
const order = (list) =>
  [...list].sort((a, b) =>
    JSON.stringify(canonical(a)).localeCompare(JSON.stringify(canonical(b))),
  );
function canonicalId(clients, start) {
  const seen = new Set();
  let current = Number(start);
  for (;;) {
    if (seen.has(current)) return { code: "MERGE_CYCLE" };
    seen.add(current);
    const row = clients.find((c) => same(c.id, current));
    if (!row) return { code: "TARGET_INVALID" };
    if (row.merged_into_cliente_id == null) return { id: current };
    current = Number(row.merged_into_cliente_id);
  }
}
// Subconjunto fechado de predicados dos índices reais. Expressão desconhecida
// não é interpretada/evaluada: passa a blocker se uma chave seria modificada.
function predicate(raw, row) {
  if (!raw) return true;
  const text = raw
    .replace(/::(?:text|bigint|integer|boolean)/g, "")
    .replace(/[()]/g, "")
    .replace(/"/g, "")
    .trim();
  const parts = text.split(/\s+AND\s+/i);
  for (const part of parts) {
    if (/^[a-z_][a-z0-9_]*$/.test(part) && typeof row[part] === "boolean") {
      if (!row[part]) return false;
      continue;
    }
    let m = part.match(/^([a-z_][a-z0-9_]*) IS (NOT )?NULL$/i);
    if (m) {
      if (m[2] ? row[m[1]] == null : row[m[1]] != null) return false;
      continue;
    }
    m = part.match(/^([a-z_][a-z0-9_]*) = (true|false|'[^']*')$/i);
    if (m) {
      const v =
        m[2] === "true" ? true : m[2] === "false" ? false : m[2].slice(1, -1);
      if (row[m[1]] !== v) return false;
      continue;
    }
    m = part.match(/^([a-z_][a-z0-9_]*) = ANY\s*ARRAY\[([^\]]+)\]$/i);
    if (m && /^'[^']*'(?:,\s*'[^']*')*$/.test(m[2])) {
      if (
        !m[2]
          .split(/,\s*/)
          .map((v) => v.slice(1, -1))
          .includes(row[m[1]])
      )
        return false;
      continue;
    }
    return null;
  }
  return true;
}
function buildExecutablePlan(snapshot, input) {
  legacy.rejectSecrets(snapshot);
  const manifest = normalizeManifest(input);
  const blockers = [],
    warnings = [],
    info = [],
    changes = [],
    decisionsRequired = [],
    impactCounts = [];
  const issue = (code, detail = {}) => {
    if (
      !blockers.some(
        (x) =>
          x.code === code &&
          JSON.stringify(x.detail) === JSON.stringify(detail),
      )
    )
      blockers.push({ severity: "BLOCKER", code, detail });
  };
  const target = manifest.clienteCanonicoId,
    sources = manifest.clientesLegadosIds,
    ids = [target, ...sources].sort((a, b) => a - b);
  const clients = rows(snapshot, "clientes");
  const targetRow = clients.find((c) => same(c.id, target));
  if (!targetRow || targetRow.ativo !== true) issue("TARGET_INVALID");
  for (const cid of ids) {
    const c = clients.find((c) => same(c.id, cid));
    if (!c)
      issue(cid === target ? "TARGET_INVALID" : "ORIGIN_NOT_FOUND", {
        clienteId: cid,
      });
    else {
      const resolved = canonicalId(clients, cid);
      if (resolved.code === "MERGE_CYCLE")
        issue("MERGE_CYCLE", { clienteId: cid });
      if (c.merged_into_cliente_id != null)
        issue("CLIENT_ALREADY_MERGED", { clienteId: cid });
      if (c.ativo !== true) issue("CLIENT_INACTIVE", { clienteId: cid });
    }
  }
  if (
    manifest.aprovacao.aprovada !== true ||
    !manifest.aprovacao.aprovadorUserId ||
    !manifest.aprovacao.evidencia
  ) {
    issue("BUSINESS_DECISION_REQUIRED");
    decisionsRequired.push("aprovacao");
  }
  if (
    snapshot.profile !== "executor-v1" ||
    !Array.isArray(snapshot.columns) ||
    !Array.isArray(snapshot.indexes) ||
    !Array.isArray(snapshot.constraints)
  )
    issue("CATALOG_INCOMPLETE");
  for (const t of [
    "clientes",
    "cliente_contas",
    "ml_tokens",
    "bases",
    "base_cliente_vinculos",
    "cliente_squad_history",
    "squads",
    "cliente_responsaveis",
    "seller_clientes",
  ])
    if (!Array.isArray(snapshot.tables?.[t]))
      issue("CATALOG_INCOMPLETE", { table: t });
  for (const e of snapshot.errors || [])
    issue("UNKNOWN_CRITICAL_REFERENCE", { table: e.table, reason: e.code });
  for (const [table, column, parent] of [
    ["cliente_contas", "cliente_id", "clientes"],
    ["ml_tokens", "cliente_id", "clientes"],
    ["ml_tokens", "cliente_conta_id", "cliente_contas"],
    ["base_cliente_vinculos", "cliente_id", "clientes"],
    ["base_cliente_vinculos", "cliente_conta_id", "cliente_contas"],
    ["base_cliente_vinculos", "base_id", "bases"],
  ]) {
    if (
      !(snapshot.constraints || []).some(
        (c) =>
          c.type === "f" &&
          c.table_name === table &&
          c.referenced_table === parent &&
          c.columns?.length === 1 &&
          c.columns[0] === column &&
          c.referenced_columns?.[0] === "id" &&
          c.validated !== false,
      )
    )
      issue("UNKNOWN_CRITICAL_REFERENCE", {
        table,
        reason: "CORE_FK_MISSING",
        column,
      });
  }
  const currentSquad = (cid) =>
    rows(snapshot, "cliente_squad_history").filter(
      (r) => same(r.cliente_id, cid) && r.fim_em == null,
    );
  const squads = ids.map((cid) => currentSquad(cid));
  if (
    squads.some((s) => s.length !== 1) ||
    new Set(squads.flat().map((s) => String(s.squad_id))).size !== 1 ||
    !rows(snapshot, "squads").some(
      (s) => same(s.id, squads[0]?.[0]?.squad_id) && s.ativo === true,
    )
  )
    issue("SQUAD_MISMATCH");
  for (const t of ["cliente_responsaveis", "seller_clientes"]) {
    const signature = (cid) =>
      rows(snapshot, t)
        .filter((r) => same(r.cliente_id, cid) && r.ativo !== false)
        .map((r) => `${r.user_id}/${r.papel ?? r.funcao ?? r.marketplace}`)
        .sort()
        .join("|");
    if (sources.some((cid) => signature(cid) !== signature(target)))
      issue("ACL_SCOPE_CHANGE", { table: t });
  }
  const accounts = rows(snapshot, "cliente_contas").filter((a) =>
    ids.includes(Number(a.cliente_id)),
  );
  const grants = rows(snapshot, "ml_tokens").filter((g) =>
    ids.includes(Number(g.cliente_id)),
  );
  const bindings = rows(snapshot, "base_cliente_vinculos").filter((v) =>
    ids.includes(Number(v.cliente_id)),
  );
  const mutate = (table, row, after, pk = { id: row.id }) => {
    const before = Object.fromEntries(
      Object.keys(after).map((k) => [k, row[k] ?? null]),
    );
    if (
      Object.keys(after).some(
        (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
      )
    )
      changes.push({ table, pk, before, after });
  };
  const selectedPrimary = manifest.decisoes.primaryAccounts;
  for (const [marketplace, choice] of Object.entries(selectedPrimary))
    if (
      !accounts.some(
        (a) =>
          same(a.id, choice) &&
          a.marketplace === marketplace &&
          a.ativo === true,
      )
    )
      issue("PRIMARY_DECISION_INVALID", { marketplace });
  for (const marketplace of new Set(accounts.map((a) => a.marketplace))) {
    const activePrimaries = accounts.filter(
      (a) =>
        a.marketplace === marketplace &&
        a.ativo === true &&
        a.is_primary === true,
    );
    if (activePrimaries.length > 1 && !selectedPrimary[marketplace]) {
      issue("UNIQUE_COLLISION", {
        table: "cliente_contas",
        kind: "primary",
        marketplace,
      });
      decisionsRequired.push(`decisoes.primaryAccounts.${marketplace}`);
    }
  }
  if (
    grants.filter((g) => g.is_primary === true).length > 1 &&
    !manifest.decisoes.primaryGrantId
  ) {
    issue("UNIQUE_COLLISION", { table: "ml_tokens", kind: "primary" });
    decisionsRequired.push("decisoes.primaryGrantId");
  }
  if (
    manifest.decisoes.primaryGrantId &&
    !grants.some((g) => same(g.id, manifest.decisoes.primaryGrantId))
  )
    issue("PRIMARY_GRANT_DECISION_INVALID");
  for (const a of accounts) {
    if (!["meli", "shopee", "tiktok"].includes(a.marketplace))
      issue("MARKETPLACE_MISMATCH", { clienteContaId: a.id });
    if (a.external_account_id != null) {
      const shared = rows(snapshot, "cliente_contas").filter(
        (b) =>
          b.marketplace === a.marketplace &&
          same(b.external_account_id, a.external_account_id),
      );
      if (
        shared.length !== 1 ||
        rows(snapshot, "ml_tokens").some(
          (g) =>
            a.marketplace === "meli" &&
            same(g.ml_user_id, a.external_account_id) &&
            !same(g.cliente_id, a.cliente_id),
        )
      )
        issue("SELLER_AMBIGUOUS", { clienteContaId: a.id });
    }
    const exact = grants.filter(
      (g) =>
        same(g.cliente_conta_id, a.id) ||
        (g.cliente_conta_id == null &&
          same(g.cliente_id, a.cliente_id) &&
          same(g.ml_user_id, a.external_account_id)),
    );
    if (
      a.marketplace === "meli" &&
      a.ativo === true &&
      (!a.external_account_id || exact.length !== 1)
    )
      issue("GRANT_AMBIGUOUS", { clienteContaId: a.id });
    for (const g of exact) {
      const result = checkAccountContext({
        clienteId: a.cliente_id,
        clienteContaId: a.id,
        marketplace: a.marketplace,
        conta: { ...a, ativo: true },
        grant: g,
        strict: true,
      });
      if (!result.ok)
        issue(
          same(g.cliente_id, a.cliente_id)
            ? "ACCOUNT_CONTEXT_AMBIGUOUS"
            : "ACCOUNT_OWNER_MISMATCH",
          { table: "ml_tokens", id: g.id },
        );
    }
    const direct = bindings.filter((v) => same(v.cliente_conta_id, a.id));
    if (direct.filter((v) => v.ativo === true).length > 1)
      issue("BASE_AMBIGUOUS", { clienteContaId: a.id });
    if (!direct.some((v) => v.ativo === true))
      warnings.push({
        severity: "WARNING",
        code: "ACCOUNT_WITHOUT_BASE",
        detail: { clienteContaId: a.id },
      });
    for (const v of direct) {
      const b = rows(snapshot, "bases").find((b) => same(b.id, v.base_id));
      if (!same(v.cliente_id, a.cliente_id))
        issue("ACCOUNT_OWNER_MISMATCH", {
          table: "base_cliente_vinculos",
          id: v.id,
        });
      if (
        !b ||
        b.marketplace !== a.marketplace ||
        v.marketplace !== a.marketplace
      )
        issue("MARKETPLACE_MISMATCH", {
          table: "base_cliente_vinculos",
          id: v.id,
        });
      if (
        v.ativo === true &&
        (!b?.ativo ||
          rows(snapshot, "base_cliente_vinculos").filter(
            (x) => same(x.base_id, v.base_id) && x.ativo === true,
          ).length !== 1)
      )
        issue("BASE_AMBIGUOUS", { id: v.id });
    }
    const after = {};
    if (sources.includes(Number(a.cliente_id))) after.cliente_id = target;
    if (selectedPrimary[a.marketplace])
      after.is_primary =
        a.ativo === true && same(a.id, selectedPrimary[a.marketplace]);
    mutate("cliente_contas", a, after);
  }
  for (const g of grants) {
    const candidates = accounts.filter(
      (a) =>
        a.marketplace === "meli" &&
        same(a.cliente_id, g.cliente_id) &&
        same(a.external_account_id, g.ml_user_id) &&
        (g.cliente_conta_id == null || same(a.id, g.cliente_conta_id)),
    );
    if (candidates.length !== 1) issue("GRANT_AMBIGUOUS", { grantId: g.id });
    if (
      g.cliente_conta_id != null &&
      !accounts.some(
        (a) =>
          same(a.id, g.cliente_conta_id) && same(a.cliente_id, g.cliente_id),
      )
    )
      issue("ACCOUNT_OWNER_MISMATCH", { table: "ml_tokens", id: g.id });
    const after = {};
    if (sources.includes(Number(g.cliente_id))) after.cliente_id = target;
    if (manifest.decisoes.primaryGrantId)
      after.is_primary = same(g.id, manifest.decisoes.primaryGrantId);
    mutate("ml_tokens", g, after);
    if (g.token_status !== "valid")
      warnings.push({
        severity: "WARNING",
        code: "GRANT_NOT_ONLINE_VALIDATED",
        detail: { grantId: g.id },
      });
  }
  for (const v of bindings) {
    if (v.cliente_conta_id == null)
      issue("ACCOUNT_CONTEXT_AMBIGUOUS", {
        table: "base_cliente_vinculos",
        id: v.id,
      });
    else if (
      !accounts.some(
        (a) =>
          same(a.id, v.cliente_conta_id) && same(a.cliente_id, v.cliente_id),
      )
    )
      issue("ACCOUNT_OWNER_MISMATCH", {
        table: "base_cliente_vinculos",
        id: v.id,
      });
    if (sources.includes(Number(v.cliente_id)))
      mutate("base_cliente_vinculos", v, { cliente_id: target });
  }
  for (const table of Object.keys(snapshot.tables || {}).sort()) {
    if (core.has(table) || infrastructure.has(table)) continue;
    const data = rows(snapshot, table),
      cols = (snapshot.columns || [])
        .filter((c) => c.table_name === table)
        .map((c) => c.column_name);
    const parent = (snapshot.constraints || []).filter(
      (c) => c.type === "f" && c.table_name === table,
    );
    const affected = data.filter(
      (r) =>
        sources.includes(Number(r.cliente_id)) ||
        clients.some(
          (c) => sources.includes(Number(c.id)) && c.slug === r.cliente_slug,
        ) ||
        accounts.some(
          (a) =>
            sources.includes(Number(a.cliente_id)) &&
            same(a.id, r.cliente_conta_id),
        ) ||
        bindings.some(
          (v) =>
            sources.includes(Number(v.cliente_id)) &&
            (same(v.base_id, r.base_id) ||
              rows(snapshot, "bases").some(
                (b) => same(b.id, v.base_id) && same(b.slug, r.base_slug),
              )),
        ) ||
        parent.some((f) =>
          f.columns?.some((col, i) =>
            rows(snapshot, f.referenced_table).some(
              (p) =>
                sources.includes(Number(p.cliente_id)) &&
                same(p[f.referenced_columns[i]], r[col]),
            ),
          ),
        ),
    );
    const category = strategy(table);
    if (category === "BLOCKED_UNKNOWN" && data.length) {
      issue("UNKNOWN_CRITICAL_REFERENCE", { table });
      impactCounts.push({ table, count: data.length, strategy: category });
      continue;
    }
    if (!affected.length) continue;
    impactCounts.push({ table, count: affected.length, strategy: category });
    if (category === "BLOCKED_UNKNOWN") {
      issue("UNKNOWN_CRITICAL_REFERENCE", { table });
      continue;
    }
    if (
      manifest.decisoes.referencias[table] &&
      manifest.decisoes.referencias[table] !== category
    )
      issue("REFERENCE_STRATEGY_UNSUPPORTED", { table });
    if (category === "MOVE_TO_CANONICAL") {
      if (
        data.some((r) =>
          ["queued", "running", "aplicando", "executing"].includes(r.status),
        )
      )
        issue("ACTIVE_OPERATION", { table });
      for (const r of affected) {
        if (
          r.cliente_conta_id != null &&
          cols.includes("cliente_id") &&
          !accounts.some(
            (a) =>
              same(a.id, r.cliente_conta_id) &&
              same(a.cliente_id, r.cliente_id),
          )
        )
          issue("ACCOUNT_OWNER_MISMATCH", { table });
        if (
          r.cliente_conta_id != null &&
          r.marketplace != null &&
          !accounts.some(
            (a) =>
              same(a.id, r.cliente_conta_id) && a.marketplace === r.marketplace,
          )
        )
          issue("MARKETPLACE_MISMATCH", { table });
        if (
          r.cliente_id != null &&
          r.cliente_slug != null &&
          !clients.some(
            (c) => same(c.id, r.cliente_id) && c.slug === r.cliente_slug,
          )
        )
          issue("ACCOUNT_OWNER_MISMATCH", { table });
        const pkCols = (snapshot.constraints || []).find(
          (c) => c.type === "p" && c.table_name === table,
        )?.columns;
        if (!pkCols?.length || pkCols.some((k) => r[k] == null)) {
          issue("UNKNOWN_CRITICAL_REFERENCE", {
            table,
            reason: "PRIMARY_KEY_UNKNOWN",
          });
          continue;
        }
        const after = {};
        if (
          cols.includes("cliente_id") &&
          sources.includes(Number(r.cliente_id))
        )
          after.cliente_id = target;
        if (
          cols.includes("cliente_slug") &&
          clients.some(
            (c) =>
              sources.includes(Number(c.id)) && same(c.slug, r.cliente_slug),
          )
        )
          after.cliente_slug = targetRow?.slug;
        mutate(
          table,
          r,
          after,
          Object.fromEntries(pkCols.map((k) => [k, r[k]])),
        );
      }
    }
  }
  for (const cid of sources) {
    const c = clients.find((c) => same(c.id, cid));
    if (c)
      mutate("clientes", c, { ativo: false, merged_into_cliente_id: target });
  }
  for (const c of snapshot.constraints || [])
    if (
      c.type === "c" &&
      changes.some(
        (x) =>
          x.table === c.table_name &&
          Object.keys(x.after).some((k) =>
            new RegExp(`\\b${k}\\b`).test(c.definition || ""),
          ),
      ) &&
      !["clientes_merge_not_self", "cliente_contas_marketplace_check"].includes(
        c.name,
      )
    )
      issue("UNKNOWN_CRITICAL_REFERENCE", {
        table: c.table_name,
        reason: "UNMODELED_CHECK",
        constraint: c.name,
      });
  const virtual = (table) =>
    rows(snapshot, table).map((r) => {
      const c = changes.find(
        (c) =>
          c.table === table &&
          Object.entries(c.pk).every(([k, v]) => same(v, r[k])),
      );
      return c ? { ...r, ...c.after } : r;
    });
  for (const index of snapshot.indexes || []) {
    if (!index.unique) continue;
    const updates = changes.filter((c) => c.table === index.table_name);
    if (!updates.length) continue;
    const keyCols = index.keys || [];
    // No change to any index key/predicate: uniqueness remains invariant.
    const material = [...keyCols, index.predicate || ""].join(" ");
    if (
      !updates.some((c) =>
        Object.keys(c.after).some((k) =>
          new RegExp(`\\b${k}\\b`).test(material),
        ),
      )
    )
      continue;
    if (
      index.valid === false ||
      index.ready === false ||
      !keyCols.length ||
      keyCols.some((k) => !/^"?[a-z_][a-z0-9_]*"?$/.test(k))
    ) {
      issue("UNKNOWN_CRITICAL_REFERENCE", {
        table: index.table_name,
        index: index.name,
        reason: "UNMODELED_UNIQUE",
      });
      continue;
    }
    const cols = keyCols.map((k) => k.replace(/"/g, ""));
    const seen = new Set();
    for (const row of virtual(index.table_name)) {
      const match = predicate(index.predicate, row);
      if (match == null) {
        issue("UNKNOWN_CRITICAL_REFERENCE", {
          table: index.table_name,
          index: index.name,
          reason: "UNMODELED_PREDICATE",
        });
        break;
      }
      if (
        !match ||
        (!index.nulls_not_distinct && cols.some((k) => row[k] == null))
      )
        continue;
      if (cols.some((k) => row[k] === undefined)) {
        issue("UNKNOWN_CRITICAL_REFERENCE", {
          table: index.table_name,
          index: index.name,
          reason: "UNIQUE_KEY_COVERAGE",
        });
        break;
      }
      const key = JSON.stringify(
        cols.map((k) => (row[k] == null ? null : String(row[k]))),
      );
      if (seen.has(key))
        issue("UNIQUE_COLLISION", {
          table: index.table_name,
          index: index.name,
        });
      seen.add(key);
    }
  }
  // Defesa também para snapshots antigos que não possuem metadados de índice.
  for (const [table, key, filter] of [
    [
      "cliente_contas",
      (r) => `${r.cliente_id}/${r.marketplace}/${r.external_account_id}`,
      (r) => r.external_account_id != null,
    ],
    ["ml_tokens", (r) => `${r.cliente_id}/${r.ml_user_id}`, () => true],
  ]) {
    const seen = new Set();
    for (const r of virtual(table).filter(filter)) {
      const k = key(r);
      if (seen.has(k) && ids.includes(Number(r.cliente_id)))
        issue("UNIQUE_COLLISION", { table });
      seen.add(k);
    }
  }
  const material = materialSnapshot(snapshot, manifest);
  const validation = {
    ok: !blockers.length,
    blockers: order(blockers),
    warnings: order(warnings),
    info: order([
      ...info,
      { severity: "INFO", code: "BUSINESS_APPROVAL_IS_EXTERNAL" },
      { severity: "INFO", code: "NO_ONLINE_GRANT_CHECK" },
    ]),
  };
  const plan = {
    schemaVersion: 1,
    manifest,
    changes: order(changes),
    impactCounts: order(impactCounts),
    decisionsRequired: [...new Set(decisionsRequired)].sort(),
    validation,
    materialHash: hash(material),
    catalogHash: hash({
      columns: order(snapshot.columns || []),
      constraints: order(snapshot.constraints || []),
      indexes: order(snapshot.indexes || []),
    }),
    preserved: {
      clienteContaIds: accounts.map((a) => Number(a.id)).sort((a, b) => a - b),
      grantIds: grants.map((g) => Number(g.id)).sort((a, b) => a - b),
      baseIds: [...new Set(bindings.map((v) => Number(v.base_id)))].sort(
        (a, b) => a - b,
      ),
    },
    productionReady: false,
    writeCapability: false,
  };
  return {
    ...plan,
    planHash: hash(plan),
    rollback: {
      changes: [...plan.changes].reverse().map((c) => ({
        ...c,
        pk: Object.fromEntries(
          Object.entries(c.pk).map(([k, v]) => [
            k,
            Object.hasOwn(c.after, k) ? c.after[k] : v,
          ]),
        ),
        before: c.after,
        after: c.before,
      })),
    },
  };
}
function materialSnapshot(snapshot, manifest) {
  const ids = [manifest.clienteCanonicoId, ...manifest.clientesLegadosIds];
  const accounts = rows(snapshot, "cliente_contas").filter((a) =>
    ids.includes(Number(a.cliente_id)),
  );
  const sellers = new Set(
    accounts
      .filter((a) => a.external_account_id)
      .map((a) => `${a.marketplace}/${a.external_account_id}`),
  );
  const bindings = rows(snapshot, "base_cliente_vinculos").filter((v) =>
    ids.includes(Number(v.cliente_id)),
  );
  const baseIds = new Set(bindings.map((v) => String(v.base_id)));
  const result = {};
  for (const [table, data] of Object.entries(snapshot.tables || {})) {
    let selected = data;
    if (table === "clientes")
      selected = data.filter((c) => ids.includes(Number(c.id)));
    if (table === "cliente_contas")
      selected = data.filter(
        (a) =>
          ids.includes(Number(a.cliente_id)) ||
          sellers.has(`${a.marketplace}/${a.external_account_id}`),
      );
    if (table === "ml_tokens")
      selected = data.filter(
        (g) =>
          ids.includes(Number(g.cliente_id)) ||
          sellers.has(`meli/${g.ml_user_id}`),
      );
    if (table === "bases")
      selected = data.filter((b) => baseIds.has(String(b.id)));
    if (table === "base_cliente_vinculos")
      selected = data.filter(
        (v) =>
          ids.includes(Number(v.cliente_id)) || baseIds.has(String(v.base_id)),
      );
    if (table === "squads")
      selected = data.filter((s) =>
        rows(snapshot, "cliente_squad_history").some(
          (h) => ids.includes(Number(h.cliente_id)) && same(h.squad_id, s.id),
        ),
      );
    if (table === "squad_members")
      selected = data.filter((s) =>
        rows(snapshot, "cliente_squad_history").some(
          (h) =>
            ids.includes(Number(h.cliente_id)) && same(h.squad_id, s.squad_id),
        ),
      );
    result[table] = order(selected);
  }
  return canonical(result);
}
function buildPlan(s, m, o) {
  return m?.schemaVersion == null
    ? legacy.buildPlan(s, m, o)
    : buildExecutablePlan(s, m);
}
function validate(s, m, o) {
  return buildPlan(s, m, o).validation;
}
module.exports = {
  ...legacy,
  buildPlan,
  validate,
  buildExecutablePlan,
  normalizeManifest,
  materialSnapshot,
  canonicalId,
  predicate,
};
