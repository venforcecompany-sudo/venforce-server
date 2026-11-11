// Autoridade da Central: Conta -> execução/import -> filhos por FK real.
// Não usar base/grant/cliente como caminhos alternativos para histórico resolvido.
const roots = new Set(["central_vendas_imports", "central_vendas_sync_runs"]);
// Política auditada contra sql/central_vendas_schema.sql e todos os leitores
// da Central (repository, MP payments/settlement, sync run/source, painel,
// cliente 360, meService, purge/dependências):
// - raízes são lidas por cliente_id/cliente_slug e sync_runs.cliente_id
//   cascateia de clientes: precisam mudar (linha a linha, poucas dezenas);
// - filhos só são lidos/apagados pela FK do pai (import_id, pedido_row_id,
//   item_row_id, sync_run_id, mp_payment_row_id, settlement_report_id). O
//   cliente_id/cliente_slug redundante neles não é autoridade de ninguém:
//   ficam intactos e entram no plano como contagem + fingerprint.
// Qualquer desvio de FK/PK/coluna de identidade vira blocker (drift).
const ROOT_IDENTITY = [
  "cliente_id",
  "cliente_slug",
  "cliente_conta_id",
  "external_account_id",
  "grant_id",
  "base_id",
];
const CENTRAL_POLICY = {
  central_vendas_sync_runs: {
    strategy: "MOVE_TO_CANONICAL",
    parents: [],
    identity: ROOT_IDENTITY,
  },
  central_vendas_imports: {
    strategy: "MOVE_TO_CANONICAL",
    parents: [["sync_run_id", "central_vendas_sync_runs"]],
    identity: ROOT_IDENTITY,
  },
  central_vendas_sync_sources: {
    strategy: "PRESERVE_BY_PARENT",
    parents: [["sync_run_id", "central_vendas_sync_runs"]],
    identity: [],
  },
  central_vendas_pedidos: {
    strategy: "PRESERVE_BY_PARENT",
    parents: [["import_id", "central_vendas_imports"]],
    identity: ["cliente_id", "cliente_slug"],
  },
  central_vendas_pedido_itens: {
    strategy: "PRESERVE_BY_PARENT",
    parents: [
      ["import_id", "central_vendas_imports"],
      ["pedido_row_id", "central_vendas_pedidos"],
    ],
    identity: ["cliente_id", "cliente_slug"],
  },
  central_vendas_componentes: {
    strategy: "PRESERVE_BY_PARENT",
    parents: [
      ["import_id", "central_vendas_imports"],
      ["pedido_row_id", "central_vendas_pedidos"],
      ["item_row_id", "central_vendas_pedido_itens"],
    ],
    // item_row_id só cascateia: nenhum leitor o usa e não há índice nele.
    scope: ["import_id", "pedido_row_id"],
    identity: ["cliente_id", "cliente_slug"],
  },
  // Reuso de pedidos entre imports (migration 20261111): só vínculos
  // import → linha de pedido, sem identidade própria; segue os dois pais.
  central_vendas_import_pedidos: {
    strategy: "PRESERVE_BY_PARENT",
    parents: [
      ["import_id", "central_vendas_imports"],
      ["pedido_row_id", "central_vendas_pedidos"],
    ],
    identity: [],
  },
  central_vendas_mp_payments: {
    strategy: "PRESERVE_BY_PARENT",
    parents: [["sync_run_id", "central_vendas_sync_runs"]],
    identity: ["cliente_id", "cliente_conta_id", "external_account_id"],
  },
  central_vendas_mp_payment_charges: {
    strategy: "PRESERVE_BY_PARENT",
    parents: [["mp_payment_row_id", "central_vendas_mp_payments"]],
    identity: [],
  },
  central_vendas_mp_settlement_reports: {
    strategy: "PRESERVE_BY_PARENT",
    parents: [["sync_run_id", "central_vendas_sync_runs"]],
    identity: ["cliente_id", "cliente_conta_id", "external_account_id"],
  },
  central_vendas_mp_settlement_movements: {
    strategy: "PRESERVE_BY_PARENT",
    parents: [
      ["settlement_report_id", "central_vendas_mp_settlement_reports"],
    ],
    identity: ["cliente_conta_id"],
  },
};
const centralPolicy = (table) =>
  Object.hasOwn(CENTRAL_POLICY, table) ? CENTRAL_POLICY[table] : null;
const preservedByParent = (table) =>
  centralPolicy(table)?.strategy === "PRESERVE_BY_PARENT";
// FKs que definem o subgrafo: caminhos de leitura reais, todos indexados.
const scopeParents = (table) => {
  const policy = centralPolicy(table);
  return policy.parents.filter(
    ([column]) => !policy.scope || policy.scope.includes(column),
  );
};
// Catálogo real precisa bater exatamente com o shape auditado.
function centralPolicyErrors({
  table,
  columns,
  constraints,
  indexes = [],
  identityColumns,
}) {
  const policy = centralPolicy(table);
  if (!policy) return [];
  const errors = [];
  const own = constraints.filter((c) => c.table_name === table);
  const pk = own.find((c) => c.type === "p");
  if (pk?.columns?.length !== 1 || pk.columns[0] !== "id")
    errors.push("CENTRAL_POLICY_DRIFT");
  const fks = own.filter((c) => c.type === "f");
  const centralFks = fks
    .filter((c) => c.referenced_table?.startsWith("central_vendas_"))
    .map((c) =>
      c.validated !== false &&
      c.columns?.length === 1 &&
      c.referenced_columns?.length === 1 &&
      c.referenced_columns[0] === "id"
        ? `${c.columns[0]}>${c.referenced_table}`
        : "?",
    )
    .sort();
  const expected = policy.parents.map(([col, ref]) => `${col}>${ref}`).sort();
  if (JSON.stringify(centralFks) !== JSON.stringify(expected))
    errors.push("CENTRAL_POLICY_DRIFT");
  if (
    columns.some((c) => identityColumns.has(c) && !policy.identity.includes(c))
  )
    errors.push("CENTRAL_POLICY_DRIFT");
  // Filho preservado com FK direta para Cliente seria cascateado pelo legado.
  if (
    policy.strategy === "PRESERVE_BY_PARENT" &&
    fks.some((c) => c.referenced_table === "clientes")
  )
    errors.push("CENTRAL_PRESERVED_CLIENT_FK");
  // Sem índice o fingerprint viraria seq scan da tabela histórica inteira:
  // blocker explícito em vez de statement_timeout no meio do preview.
  if (
    policy.strategy === "PRESERVE_BY_PARENT" &&
    scopeParents(table).some(
      ([column]) =>
        !indexes.some(
          (i) =>
            i.table_name === table &&
            i.valid !== false &&
            i.ready !== false &&
            !i.predicate &&
            String(i.keys?.[0] || "").replace(/"/g, "") === column,
        ),
    )
  )
    errors.push("CENTRAL_SCOPE_INDEX_MISSING");
  return [...new Set(errors)];
}
// Linhas (id, xmin) do subgrafo de um filho preservado: UNION de um ramo por
// FK de escopo. Raiz usa os IDs já carregados (`fk = ANY`, indexável); pai
// preservado vira LATERAL por linha do pai (OFFSET 0 impede o achatamento),
// que força nested loop no índice da FK em vez de hash join com seq scan da
// tabela histórica inteira, qualquer que seja a estatística.
function preservedRowsSql({ table, rootIds, bind, quote, depth = 0 }) {
  const alias = `p${depth}`;
  const row = `SELECT ${alias}."id", ${alias}.xmin::text AS "x" FROM ${quote(table)} ${alias}`;
  return scopeParents(table)
    .map(([column, parent]) =>
      preservedByParent(parent)
        ? `SELECT c${depth}."id", c${depth}."x" FROM (${preservedRowsSql({ table: parent, rootIds, bind, quote, depth: depth + 1 })}) r${depth} CROSS JOIN LATERAL (${row} WHERE ${alias}.${quote(column)} = r${depth}."id" OFFSET 0) c${depth}`
        : `${row} WHERE ${alias}.${quote(column)} = ANY(${bind(rootIds(parent))})`,
    )
    .join(" UNION ");
}
// Contagem + fingerprint (id:xmin ordenado) do subgrafo. Nenhuma linha sai do
// banco; qualquer INSERT/UPDATE/DELETE no subgrafo muda o fingerprint.
function preservedFootprintQuery({ table, rootIds, quote }) {
  const params = [];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  const rows = preservedRowsSql({ table, rootIds, bind, quote });
  return {
    sql: `SELECT count(*)::text AS "rows", md5(COALESCE(string_agg(s."id"::text || ':' || s."x", ',' ORDER BY s."id"), '')) AS "fingerprint", extract(epoch FROM clock_timestamp()-statement_timestamp())*1000 AS "_server_ms" FROM (${rows}) s`,
    params,
  };
}
function centralReferenceScope({
  table,
  columns,
  constraints,
  accountIds,
  ids,
  slugs,
  parentIds,
  quote,
}) {
  if (!table.startsWith("central_vendas_")) return null;
  const parents = constraints.filter(
    (c) =>
      c.type === "f" &&
      c.table_name === table &&
      c.referenced_table?.startsWith("central_vendas_"),
  );
  const clauses = [];
  const errors = [];
  const add = (column, values) => {
    if (values.length)
      clauses.push((bind) => `${quote(column)} = ANY(${bind(values)})`);
  };
  if (roots.has(table)) {
    const accountFk = constraints.some(
      (c) =>
        c.type === "f" &&
        c.validated !== false &&
        c.table_name === table &&
        c.columns?.length === 1 &&
        c.columns[0] === "cliente_conta_id" &&
        c.referenced_table === "cliente_contas" &&
        c.referenced_columns?.[0] === "id",
    );
    if (!accountFk) errors.push("CENTRAL_ACCOUNT_FK_UNKNOWN");
    if (columns.includes("cliente_conta_id")) {
      add("cliente_conta_id", accountIds);
      // Histórico anterior à identidade account-aware permanece visível/blocker.
      // Nunca atribuir uma Conta por aproximação, competência ou status published.
      if (columns.includes("cliente_id"))
        clauses.push(
          (bind) =>
            `(${quote("cliente_conta_id")} IS NULL AND ${quote("cliente_id")} = ANY(${bind(ids)}))`,
        );
      if (columns.includes("cliente_slug") && slugs.length)
        clauses.push(
          (bind) =>
            `(${quote("cliente_conta_id")} IS NULL AND ${quote("cliente_slug")} = ANY(${bind(slugs)}))`,
        );
    }
  }
  for (const fk of parents) {
    if (
      fk.validated === false ||
      fk.columns?.length !== 1 ||
      fk.referenced_columns?.length !== 1
    ) {
      errors.push("CENTRAL_PARENT_FK_UNKNOWN");
      continue;
    }
    add(
      fk.columns[0],
      parentIds(fk.referenced_table, fk.referenced_columns[0]),
    );
  }
  // Tabela/shape novo nunca recebe silenciosamente uma interpretação auditada.
  if (!roots.has(table) && !parents.length)
    errors.push("CENTRAL_PARENT_FK_UNKNOWN");
  return { clauses, errors, parents };
}
module.exports = {
  centralReferenceScope,
  centralPolicy,
  centralPolicyErrors,
  preservedByParent,
  preservedFootprintQuery,
  scopeParents,
};
