const fixture = () => {
  const tables = {
    clientes: [
      {
        id: 1,
        nome: "Canônico sintético",
        slug: "canonico",
        ativo: true,
        merged_into_cliente_id: null,
        _version: "1",
      },
      {
        id: 2,
        nome: "Legado sintético",
        slug: "legado",
        ativo: true,
        merged_into_cliente_id: null,
        _version: "1",
      },
    ],
    cliente_contas: [
      {
        id: 11,
        cliente_id: 1,
        marketplace: "meli",
        external_account_id: "111",
        ativo: true,
        is_primary: true,
        _version: "1",
      },
      {
        id: 21,
        cliente_id: 2,
        marketplace: "meli",
        external_account_id: "222",
        ativo: true,
        is_primary: true,
        _version: "1",
      },
    ],
    ml_tokens: [
      {
        id: 31,
        cliente_id: 1,
        cliente_conta_id: 11,
        ml_user_id: "111",
        token_status: "valid",
        is_primary: true,
        _version: "1",
      },
      {
        id: 32,
        cliente_id: 2,
        cliente_conta_id: 21,
        ml_user_id: "222",
        token_status: "valid",
        is_primary: true,
        _version: "1",
      },
    ],
    bases: [
      { id: 41, marketplace: "meli", ativo: true, _version: "1" },
      { id: 42, marketplace: "meli", ativo: true, _version: "1" },
    ],
    base_cliente_vinculos: [
      {
        id: 51,
        cliente_id: 1,
        cliente_conta_id: 11,
        base_id: 41,
        marketplace: "meli",
        ativo: true,
        _version: "1",
      },
      {
        id: 52,
        cliente_id: 2,
        cliente_conta_id: 21,
        base_id: 42,
        marketplace: "meli",
        ativo: true,
        _version: "1",
      },
    ],
    squads: [{ id: 20, ativo: true, _version: "1" }],
    squad_members: [],
    cliente_squad_history: [
      { id: 71, cliente_id: 1, squad_id: 20, fim_em: null, _version: "1" },
      { id: 72, cliente_id: 2, squad_id: 20, fim_em: null, _version: "1" },
    ],
    cliente_responsaveis: [],
    seller_clientes: [],
  };
  const constraints = Object.keys(tables).map((t) => ({
    type: "p",
    table_name: t,
    name: t + "_pkey",
    columns: ["id"],
  }));
  for (const [table, column, parent] of [
    ["cliente_contas", "cliente_id", "clientes"],
    ["ml_tokens", "cliente_id", "clientes"],
    ["ml_tokens", "cliente_conta_id", "cliente_contas"],
    ["base_cliente_vinculos", "cliente_id", "clientes"],
    ["base_cliente_vinculos", "cliente_conta_id", "cliente_contas"],
    ["base_cliente_vinculos", "base_id", "bases"],
  ])
    constraints.push({
      name: `fk_${table}_${column}`,
      type: "f",
      table_name: table,
      referenced_table: parent,
      columns: [column],
      referenced_columns: ["id"],
    });
  const columns = Object.entries(tables).flatMap(([table, list]) =>
    Object.keys(list[0] || { id: 0, cliente_id: 0 })
      .filter((k) => k !== "_version")
      .map((column_name) => ({ table_name: table, column_name })),
  );
  const indexes = [
    {
      table_name: "cliente_contas",
      name: "unique_external",
      unique: true,
      keys: ["cliente_id", "marketplace", "external_account_id"],
      predicate: "external_account_id IS NOT NULL",
    },
    {
      table_name: "cliente_contas",
      name: "unique_primary",
      unique: true,
      keys: ["cliente_id", "marketplace"],
      predicate: "(is_primary = true) AND (ativo = true)",
    },
    {
      table_name: "ml_tokens",
      name: "unique_seller",
      unique: true,
      keys: ["cliente_id", "ml_user_id"],
      predicate: null,
    },
    {
      table_name: "ml_tokens",
      name: "unique_primary",
      unique: true,
      keys: ["cliente_id"],
      predicate: "is_primary = true",
    },
  ];
  return {
    profile: "executor-v1",
    tables,
    columns,
    constraints,
    indexes,
    errors: [],
  };
};
const manifest = () => ({
  schemaVersion: 1,
  clienteCanonicoId: 1,
  clientesLegadosIds: [2],
  decisoes: {
    primaryAccounts: { meli: 21 },
    primaryGrantId: 32,
    referencias: {},
  },
  aprovacao: {
    aprovada: true,
    aprovadorUserId: 5,
    evidencia: "DOC-SINTETICO-001",
  },
});
module.exports = { fixture, manifest };
