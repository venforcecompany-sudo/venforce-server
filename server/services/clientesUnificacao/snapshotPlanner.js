// Planejamento offline. Não importa banco, serviços de aplicação ou executor.
const { createHash } = require("node:crypto");
const same = (a, b) => a != null && b != null && String(a) === String(b);
const positive = (x) => Number.isSafeInteger(x) && x > 0;
const hash = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const tables = (s) => s.tables || {};
const rows = (s, name) => tables(s)[name] || [];
const secretKey =
  /^(access_?token|refresh_?token|password|senha|database_?url|jwt|client_?secret|secret|api_?key|private_?key|token_publico|authorization|credentials?)$/i;
function rejectSecrets(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, v] of Object.entries(value)) {
    if (secretKey.test(key))
      throw Object.assign(new Error("SECRET_FIELD_REJECTED"), {
        code: "SECRET_FIELD_REJECTED",
      });
    rejectSecrets(v);
  }
}
function validateManifest(m) {
  rejectSecrets(m);
  if (
    !m ||
    !positive(m.clienteCanonicoId) ||
    !Array.isArray(m.clientesLegados) ||
    !m.clientesLegados.length ||
    !m.clientesLegados.every(positive) ||
    new Set(m.clientesLegados).size !== m.clientesLegados.length ||
    m.clientesLegados.includes(m.clienteCanonicoId) ||
    !Array.isArray(m.contas) ||
    !m.contas.length
  ) {
    throw Object.assign(new Error("MANIFEST_INVALID"), {
      code: "MANIFEST_INVALID",
    });
  }
  const ids = new Set();
  for (const a of m.contas) {
    if (
      !positive(a.clienteContaId) ||
      !positive(a.clienteOrigemId) ||
      !positive(a.clienteDestinoId) ||
      a.clienteDestinoId !== m.clienteCanonicoId ||
      !m.clientesLegados.includes(a.clienteOrigemId) ||
      ids.has(a.clienteContaId)
    ) {
      throw Object.assign(new Error("MANIFEST_ACCOUNT_INVALID"), {
        code: "MANIFEST_ACCOUNT_INVALID",
      });
    }
    ids.add(a.clienteContaId);
  }
  return m;
}
function dependencies(snapshot) {
  const edges = (snapshot.constraints || []).filter((c) => c.type === "f");
  const reached = new Set(["clientes", "cliente_contas"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) {
      if (reached.has(e.referenced_table) && !reached.has(e.table_name)) {
        reached.add(e.table_name);
        changed = true;
      }
    }
  }
  return {
    tables: [...reached].sort(),
    foreignKeys: edges.filter(
      (e) => reached.has(e.table_name) && reached.has(e.referenced_table),
    ),
  };
}
function buildPlan(snapshot, manifest, { now = new Date() } = {}) {
  rejectSecrets(snapshot);
  validateManifest(manifest);
  const errors = [];
  const warn = (code, detail = {}) => errors.push({ code, ...detail });
  const required = [
    "clientes",
    "cliente_contas",
    "ml_tokens",
    "bases",
    "base_cliente_vinculos",
    "squads",
    "squad_members",
    "cliente_squad_history",
    "cliente_responsaveis",
    "seller_clientes",
    "user_bases",
  ];
  for (const table of required)
    if (!Array.isArray(tables(snapshot)[table]))
      warn("SNAPSHOT_TABLE_MISSING", { table });
  if (
    !Array.isArray(snapshot.columns) ||
    !Array.isArray(snapshot.constraints) ||
    !Array.isArray(snapshot.indexes) ||
    !Array.isArray(snapshot.counts)
  )
    warn("CATALOG_INCOMPLETE");
  for (const table of required.filter((t) => t !== "user_bases")) {
    const list = rows(snapshot, table);
    const ids = new Set();
    for (const row of list) {
      if (row.id == null || ids.has(String(row.id)))
        warn("SNAPSHOT_ROW_ID_AMBIGUOUS", { table });
      ids.add(String(row.id));
    }
  }
  for (const [table, parent] of [
    ["cliente_contas", "clientes"],
    ["ml_tokens", "clientes"],
    ["ml_tokens", "cliente_contas"],
    ["base_cliente_vinculos", "clientes"],
    ["base_cliente_vinculos", "cliente_contas"],
  ]) {
    if (
      !(snapshot.constraints || []).some(
        (c) =>
          c.type === "f" &&
          c.table_name === table &&
          c.referenced_table === parent,
      )
    )
      warn("CORE_FK_CATALOG_MISSING", { table, parent });
  }
  if (snapshot.session?.read_only !== "on") warn("READ_ONLY_EVIDENCE_MISSING");
  const age = (now - new Date(snapshot.collectedAt)) / 3600000;
  if (!Number.isFinite(age) || age < 0 || age > 24) warn("SNAPSHOT_STALE");
  const id = manifest.clienteCanonicoId;
  const clients = rows(snapshot, "clientes");
  const dest = clients.find((c) => same(c.id, id));
  if (!dest) warn("DESTINATION_NOT_FOUND");
  else if (dest.ativo !== true) warn("DESTINATION_INACTIVE");
  for (const source of manifest.clientesLegados)
    if (!clients.some((c) => same(c.id, source)))
      warn("SOURCE_NOT_FOUND", { clienteId: source });
  const approval = manifest.decisaoEmpresarial;
  if (
    approval?.aprovada !== true ||
    !String(approval?.evidencia || "").trim() ||
    !String(approval?.aprovador || "").trim()
  )
    warn("BUSINESS_DECISION_REQUIRED");
  const origins = [id, ...manifest.clientesLegados];
  const moves = new Map(manifest.contas.map((m) => [m.clienteContaId, m]));
  const accounts = rows(snapshot, "cliente_contas");
  const grants = rows(snapshot, "ml_tokens");
  const bindings = rows(snapshot, "base_cliente_vinculos");
  const accountPlans = [];
  const changes = [];
  const change = (table, row, after) => {
    const before = Object.fromEntries(
      Object.keys(after).map((k) => [k, row[k] ?? null]),
    );
    if (Object.keys(after).some((k) => !same(before[k], after[k])))
      changes.push({
        table,
        id: row.id,
        before,
        after,
        versionBefore: row.updated_at ?? null,
      });
  };
  for (const m of manifest.contas) {
    const a = accounts.find((a) => same(a.id, m.clienteContaId));
    if (!a) {
      warn("ACCOUNT_NOT_FOUND", { clienteContaId: m.clienteContaId });
      accountPlans.push({ ...m, estado: "CONFLITO" });
      continue;
    }
    const exactGrants =
      a.marketplace === "meli"
        ? grants.filter(
            (g) =>
              same(g.cliente_conta_id, a.id) ||
              (g.cliente_conta_id == null &&
                [a.cliente_id, m.clienteOrigemId, m.clienteDestinoId].some(
                  (id) => same(g.cliente_id, id),
                ) &&
                same(g.ml_user_id, a.external_account_id)),
          )
        : [];
    const exactBases = bindings.filter(
      (v) => same(v.cliente_conta_id, a.id) && v.ativo === true,
    );
    const childParents = [...exactGrants, ...exactBases].map(
      (r) => r.cliente_id,
    );
    for (const count of snapshot.counts || [])
      if (
        count.scope?.includes("cliente_id") &&
        count.scope?.includes("cliente_conta_id")
      ) {
        const history = count.rows.filter((r) =>
          same(r.cliente_conta_id, a.id),
        );
        const preserveOrigin =
          same(a.cliente_id, m.clienteDestinoId) &&
          manifest.politicasHistorico?.[count.table] ===
            "PRESERVAR_ORIGEM_COM_LOOKUP";
        childParents.push(
          ...history
            .filter(
              (r) =>
                !preserveOrigin ||
                ![m.clienteOrigemId, m.clienteDestinoId].some((id) =>
                  same(r.cliente_id, id),
                ),
            )
            .map((r) => r.cliente_id),
        );
      }
    let estado = same(a.cliente_id, m.clienteOrigemId)
      ? "NAO_MIGRADO"
      : same(a.cliente_id, m.clienteDestinoId)
        ? "JA_MIGRADO"
        : "CONFLITO";
    if (
      estado !== "CONFLITO" &&
      childParents.some((c) => !same(c, a.cliente_id))
    )
      estado = "PARCIALMENTE_MIGRADO";
    if (estado === "CONFLITO" || estado === "PARCIALMENTE_MIGRADO")
      warn("ACCOUNT_STATE_UNSAFE", { clienteContaId: a.id, estado });
    if (a.ativo !== true) warn("ACCOUNT_INACTIVE", { clienteContaId: a.id });
    if (a.marketplace === "meli") {
      if (!a.external_account_id)
        warn("SELLER_MISSING", { clienteContaId: a.id });
      if (exactGrants.length !== 1)
        warn("GRANT_MISSING_OR_AMBIGUOUS", { clienteContaId: a.id });
      for (const g of exactGrants) {
        if (
          !same(g.ml_user_id, a.external_account_id) ||
          !same(g.cliente_id, a.cliente_id) ||
          (g.cliente_conta_id != null && !same(g.cliente_conta_id, a.id))
        )
          warn("GRANT_ACCOUNT_MISMATCH", { grantId: g.id });
        if (g.token_status !== "valid")
          warn("GRANT_NOT_VALID", { grantId: g.id });
      }
      const conflictingAccounts = accounts.filter(
        (other) =>
          other.id !== a.id &&
          other.marketplace === a.marketplace &&
          same(other.external_account_id, a.external_account_id),
      );
      const conflictingGrants = grants.filter(
        (g) =>
          same(g.ml_user_id, a.external_account_id) && !exactGrants.includes(g),
      );
      if (
        conflictingAccounts.length ||
        conflictingGrants.length ||
        grants.some(
          (g) =>
            same(g.ml_user_id, a.external_account_id) &&
            !same(g.cliente_id, a.cliente_id),
        )
      )
        warn("SELLER_OWNERSHIP_AMBIGUOUS", { clienteContaId: a.id });
    }
    if (
      exactBases.length > 1 ||
      (a.marketplace === "meli" && exactBases.length !== 1)
    )
      warn("BASE_MISSING_OR_AMBIGUOUS", { clienteContaId: a.id });
    for (const v of exactBases) {
      const base = rows(snapshot, "bases").find((b) => same(b.id, v.base_id));
      if (
        !base ||
        base.ativo !== true ||
        base.marketplace !== a.marketplace ||
        v.marketplace !== a.marketplace ||
        !same(v.cliente_id, a.cliente_id)
      )
        warn("BASE_ACCOUNT_MISMATCH", { baseId: v.base_id });
      if (
        bindings.filter((b) => same(b.base_id, v.base_id) && b.ativo === true)
          .length !== 1
      )
        warn("BASE_SHARED_OR_AMBIGUOUS", { baseId: v.base_id });
    }
    // Vínculo NULL é preservado, jamais atribuído automaticamente ao destino.
    if (
      bindings.some(
        (v) =>
          same(v.cliente_id, m.clienteOrigemId) &&
          v.cliente_conta_id == null &&
          v.ativo === true &&
          v.marketplace === a.marketplace,
      )
    )
      warn("LEGACY_BASE_MAPPING_REQUIRED", { clienteContaId: a.id });
    if (estado === "NAO_MIGRADO") {
      change("cliente_contas", a, { cliente_id: m.clienteDestinoId });
      for (const g of exactGrants)
        change("ml_tokens", g, { cliente_id: m.clienteDestinoId });
      for (const v of exactBases)
        change("base_cliente_vinculos", v, { cliente_id: m.clienteDestinoId });
    }
    accountPlans.push({
      ...m,
      estado,
      marketplace: a.marketplace,
      sellerPreservado: true,
      grantIds: exactGrants.map((g) => g.id),
      baseIds: exactBases.map((v) => v.base_id),
    });
  }
  // Simulação das UNIQUEs de identidade, inclusive contas históricas/inativas.
  const virtualAccounts = accounts.map((a) => ({
    ...a,
    cliente_id: moves.get(Number(a.id))?.clienteDestinoId ?? a.cliente_id,
  }));
  const virtualGrants = grants.map((g) => ({
    ...g,
    cliente_id:
      changes.find((c) => c.table === "ml_tokens" && same(c.id, g.id))?.after
        .cliente_id ?? g.cliente_id,
  }));
  function unique(data, key, code, predicate = () => true) {
    const seen = new Map();
    for (const r of data.filter(predicate)) {
      const k = key(r);
      if (seen.has(k) && origins.some((id) => same(id, r.cliente_id)))
        warn(code, { ids: [seen.get(k), r.id] });
      else seen.set(k, r.id);
    }
  }
  unique(
    virtualAccounts,
    (a) => `${a.cliente_id}/${a.marketplace}/${a.external_account_id}`,
    "UNIQUE_EXTERNAL_COLLISION",
    (a) => a.external_account_id != null,
  );
  unique(
    virtualAccounts,
    (a) => `${a.cliente_id}/${a.marketplace}`,
    "UNIQUE_PRIMARY_COLLISION",
    (a) => a.ativo === true && a.is_primary === true,
  );
  unique(
    virtualGrants,
    (g) => `${g.cliente_id}/${g.ml_user_id}`,
    "UNIQUE_GRANT_COLLISION",
  );
  unique(
    virtualGrants,
    (g) => String(g.cliente_id),
    "UNIQUE_GRANT_PRIMARY_COLLISION",
    (g) => g.is_primary === true,
  );
  const currentSquads = (cid) =>
    rows(snapshot, "cliente_squad_history").filter(
      (h) => same(h.cliente_id, cid) && h.fim_em == null,
    );
  const targetSquads = currentSquads(id);
  if (
    targetSquads.length !== 1 ||
    !rows(snapshot, "squads").some(
      (s) => same(s.id, targetSquads[0]?.squad_id) && s.ativo === true,
    )
  )
    warn("DESTINATION_SQUAD_AMBIGUOUS");
  const currentAcl = (cid) => ({
    squad: currentSquads(cid).map((h) => h.squad_id),
    responsaveis: rows(snapshot, "cliente_responsaveis")
      .filter((r) => same(r.cliente_id, cid) && r.ativo !== false)
      .map((r) => `${r.user_id}/${r.funcao}`)
      .sort(),
    seller: rows(snapshot, "seller_clientes")
      .filter((r) => same(r.cliente_id, cid) && r.ativo === true)
      .map((r) => `${r.user_id}/${r.marketplace}`)
      .sort(),
  });
  for (const source of manifest.clientesLegados) {
    if (JSON.stringify(currentAcl(source)) !== JSON.stringify(currentAcl(id)))
      warn("ACL_SCOPE_CHANGE_REQUIRES_DECISION", { clienteId: source });
    if (currentSquads(source).length !== 1)
      warn("SOURCE_SQUAD_AMBIGUOUS", { clienteId: source });
  }
  // Todo acesso direto à Base deve permanecer sob a mesma carteira após mudança.
  if (!Array.isArray(rows(snapshot, "user_bases"))) warn("BASE_ACL_INCOMPLETE");
  const dependency = dependencies(snapshot);
  const affected = [];
  for (const table of dependency.tables) {
    const coreChanges = changes.filter((c) => c.table === table);
    const count = (snapshot.counts || []).find((c) => c.table === table);
    const scoped = count?.scope?.includes("cliente_conta_id")
      ? count.rows.filter((r) => moves.has(Number(r.cliente_conta_id)))
      : [];
    const byClient = count?.scope?.includes("cliente_id")
      ? count.rows.filter((r) =>
          manifest.clientesLegados.some((id) => same(id, r.cliente_id)),
        )
      : [];
    const amount = scoped.reduce((n, r) => n + Number(r.total), 0);
    if (
      coreChanges.length ||
      amount ||
      byClient.length ||
      ["clientes", "cliente_contas"].includes(table)
    ) {
      affected.push({
        table,
        identityRows: coreChanges.length,
        accountHistoryRows: amount,
        legacyClientRows: byClient.reduce((n, r) => n + Number(r.total), 0),
        action: coreChanges.length
          ? "ALTERACAO_VIRTUAL_DE_IDENTIDADE"
          : "PRESERVAR_HISTORICO_E_DEFINIR_LOOKUP",
        rowCountComplete: count?.complete === true || !!tables(snapshot)[table],
      });
      if (amount && count?.scope.includes("cliente_id")) {
        if (
          manifest.politicasHistorico?.[table] !== "PRESERVAR_ORIGEM_COM_LOOKUP"
        )
          warn("HISTORY_POLICY_REQUIRED", { table });
      }
    }
  }
  for (const e of snapshot.errors || []) {
    // Uma dependência incompleta nunca vira volume zero nem validação OK.
    if (dependency.tables.includes(e.table))
      warn("DEPENDENCY_COVERAGE_INCOMPLETE", {
        table: e.table,
        reason: e.code,
      });
  }
  const logicalTables = [
    ...new Set(
      (snapshot.columns || [])
        .filter((c) =>
          ["cliente_slug", "seller_id", "ml_user_id"].includes(c.column_name),
        )
        .map((c) => c.table_name),
    ),
  ];
  const logical = logicalTables.map((table) => {
    const count = (snapshot.counts || []).find((c) => c.table === table);
    const legacySlugs = clients
      .filter((c) => manifest.clientesLegados.includes(Number(c.id)))
      .map((c) => c.slug);
    const matches =
      count?.rows.filter(
        (r) =>
          manifest.clientesLegados.includes(Number(r.cliente_id)) ||
          legacySlugs.includes(r.cliente_slug),
      ) || [];
    return {
      table,
      registros: matches.reduce((n, r) => n + Number(r.total), 0),
      coverage: count?.complete ? "AGREGADO_COMPLETO" : "NAO_CERTIFICADO",
    };
  });
  if (
    manifest.referenciasLogicasRevisadas?.aprovada !== true ||
    !manifest.referenciasLogicasRevisadas?.evidencia
  )
    warn("LOGICAL_REFERENCES_REVIEW_REQUIRED");
  if (manifest.estrategiaUrls !== "MANTER_SLUG_LEGADO_COM_LOOKUP")
    warn("URL_ALIAS_STRATEGY_REQUIRED");
  const relevantIndexes = (snapshot.indexes || []).filter(
    (i) =>
      /CREATE UNIQUE INDEX/i.test(i.definition) &&
      dependency.tables.includes(i.table_name),
  );
  const modeled = new Set(["cliente_contas", "ml_tokens"]);
  const unmodeled = relevantIndexes.filter(
    (i) =>
      !modeled.has(i.table_name) &&
      /cliente_id|cliente_slug/i.test(i.definition),
  );
  if (
    unmodeled.length &&
    (manifest.uniqueRevisadas?.aprovada !== true ||
      !manifest.uniqueRevisadas?.evidencia)
  )
    warn("UNIQUE_REVIEW_REQUIRED", { indexes: unmodeled.map((i) => i.name) });
  const reverse = changes
    .map((c) => ({
      table: c.table,
      id: c.id,
      before: c.after,
      after: c.before,
      versionBefore: c.versionBefore,
    }))
    .reverse();
  const rollback = {
    mode: "PLANO_REVERSO_SEM_EXECUTOR",
    snapshotHash: hash(snapshot),
    manifestHash: hash(manifest),
    changes: reverse,
    requisitos: [
      "backup/PITR verificado",
      "revalidar versão por PK antes/depois",
      "coordenar writers em janela aprovada",
      "tratamento explícito de dados criados após movimento",
      "restaurar lookup/ACL/flags se aprovados no manifesto",
    ],
  };
  return {
    schemaVersion: 1,
    mode: "PLAN_ONLY",
    productionReady: false,
    writeCapability: false,
    baseSnapshotHash: hash(snapshot),
    manifestHash: hash(manifest),
    accountPlans,
    changes,
    clientesLegadosPreservados: manifest.clientesLegados,
    clientesExcluidos: [],
    affectedTables: affected,
    foreignKeys: dependency.foreignKeys,
    uniqueIndexes: relevantIndexes,
    logicalReferences: logical,
    missingCoverage: snapshot.errors || [],
    rollback,
    validation: {
      ok: errors.length === 0,
      status: errors.length ? "BLOQUEADO" : "VALIDO_PARA_ENSAIO_EM_COPIA",
      errors,
      scope:
        "estrutura/manifesto/snapshot; não autoriza produção nem certifica validade online de Grant",
    },
  };
}
function validate(snapshot, manifest, options) {
  return buildPlan(snapshot, manifest, options).validation;
}
module.exports = {
  buildPlan,
  validate,
  validateManifest,
  dependencies,
  rejectSecrets,
  hash,
};
