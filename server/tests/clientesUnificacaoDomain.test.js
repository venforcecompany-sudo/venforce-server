const assert = require("node:assert/strict");
const {
  buildPlan,
  normalizeManifest,
  canonicalId,
} = require("../services/clientesUnificacao/planner");
const { fixture, manifest } = require("./helpers/clientesUnificacaoFixture");
const {
  hash,
  confirmation,
} = require("../services/clientesUnificacao/contracts");
const { flags } = require("../config/clientesUnificacao");
let count = 0;
function test(name, fn) {
  fn(fixture(), manifest());
  count++;
  console.log("ok — " + name);
}
const has = (s, m, code) =>
  buildPlan(s, m).validation.blockers.some((b) => b.code === code);
test("origem igual ao destino", (s, m) => {
  m.clientesLegadosIds = [1];
  assert.throws(() => normalizeManifest(m), { code: "ORIGIN_EQUALS_TARGET" });
});
test("IDs duplicados/versão/keys inválidos", (s, m) => {
  m.clientesLegadosIds = [2, 2];
  assert.throws(() => normalizeManifest(m));
  m.clientesLegadosIds = [2];
  m.schemaVersion = 2;
  assert.throws(() => normalizeManifest(m));
  m.schemaVersion = 1;
  m.extra = 1;
  assert.throws(() => normalizeManifest(m));
});
test("destino inexistente", (s, m) => {
  s.tables.clientes = s.tables.clientes.slice(1);
  assert.ok(has(s, m, "TARGET_INVALID"));
});
test("origem inexistente", (s, m) => {
  s.tables.clientes = s.tables.clientes.slice(0, 1);
  assert.ok(has(s, m, "ORIGIN_NOT_FOUND"));
});
test("já unificado", (s, m) => {
  s.tables.clientes[1].merged_into_cliente_id = 1;
  assert.ok(has(s, m, "CLIENT_ALREADY_MERGED"));
});
test("ciclo", (s, m) => {
  s.tables.clientes[0].merged_into_cliente_id = 2;
  s.tables.clientes[1].merged_into_cliente_id = 1;
  assert.ok(has(s, m, "MERGE_CYCLE"));
  assert.equal(canonicalId(s.tables.clientes, 2).code, "MERGE_CYCLE");
});
test("Squad diferente", (s, m) => {
  s.tables.cliente_squad_history[1].squad_id = 30;
  assert.ok(has(s, m, "SQUAD_MISMATCH"));
});
test("Squad ausente/duplicado/inativo", (s, m) => {
  s.tables.cliente_squad_history.push({
    ...s.tables.cliente_squad_history[0],
    id: 99,
  });
  assert.ok(has(s, m, "SQUAD_MISMATCH"));
  s.tables.cliente_squad_history.pop();
  s.tables.squads[0].ativo = false;
  assert.ok(has(s, m, "SQUAD_MISMATCH"));
});
test("seller ambíguo incluindo inativo", (s, m) => {
  s.tables.cliente_contas.push({
    ...s.tables.cliente_contas[1],
    id: 99,
    cliente_id: 3,
    ativo: false,
  });
  assert.ok(has(s, m, "SELLER_AMBIGUOUS"));
});
test("Grant ambíguo", (s, m) => {
  s.tables.ml_tokens.push({ ...s.tables.ml_tokens[1], id: 99 });
  assert.ok(has(s, m, "GRANT_AMBIGUOUS"));
});
test("Base ambígua", (s, m) => {
  s.tables.base_cliente_vinculos.push({
    ...s.tables.base_cliente_vinculos[1],
    id: 99,
  });
  assert.ok(has(s, m, "BASE_AMBIGUOUS"));
});
test("owner incompatível", (s, m) => {
  s.tables.ml_tokens[1].cliente_id = 1;
  assert.ok(has(s, m, "ACCOUNT_OWNER_MISMATCH"));
});
test("marketplace incompatível", (s, m) => {
  s.tables.bases[1].marketplace = "shopee";
  assert.ok(has(s, m, "MARKETPLACE_MISMATCH"));
});
test("UNIQUE external bloqueia", (s, m) => {
  s.tables.cliente_contas[0].external_account_id = "222";
  assert.ok(has(s, m, "UNIQUE_COLLISION"));
});
test("referência crítica desconhecida", (s, m) => {
  s.tables.unknown = [{ id: 1, cliente_id: 2 }];
  s.columns.push({ table_name: "unknown", column_name: "cliente_id" });
  assert.ok(has(s, m, "UNKNOWN_CRITICAL_REFERENCE"));
});
test("Central com histórico exige integração separada", (s, m) => {
  s.tables.central_vendas_imports = [
    { id: 100, cliente_id: 1, cliente_conta_id: 11 },
  ];
  assert.ok(has(s, m, "UNKNOWN_CRITICAL_REFERENCE"));
  assert.equal(
    buildPlan(s, m).changes.some((c) => c.table.startsWith("central_vendas")),
    false,
  );
});
test("primary ausente nunca escolhe sozinho", (s, m) => {
  delete m.decisoes.primaryAccounts.meli;
  delete m.decisoes.primaryGrantId;
  const p = buildPlan(s, m);
  assert.ok(p.validation.blockers.some((b) => b.code === "UNIQUE_COLLISION"));
  assert.ok(p.decisionsRequired.includes("decisoes.primaryAccounts.meli"));
});
test("primary explícita válida", (s, m) => {
  const p = buildPlan(s, m);
  assert.equal(p.validation.ok, true);
  assert.equal(
    p.changes.find((c) => c.table === "cliente_contas" && c.pk.id === 11).after
      .is_primary,
    false,
  );
  assert.equal(
    p.changes.find((c) => c.table === "ml_tokens" && c.pk.id === 31).after
      .is_primary,
    false,
  );
});
test("primary de outra conta ou inativa recusada", (s, m) => {
  m.decisoes.primaryAccounts.meli = 99;
  assert.ok(has(s, m, "PRIMARY_DECISION_INVALID"));
  m.decisoes.primaryAccounts.meli = 21;
  s.tables.cliente_contas[1].ativo = false;
  assert.ok(has(s, m, "PRIMARY_DECISION_INVALID"));
});
test("single-account e multicanal sem primary collision", (s, m) => {
  s.tables.cliente_contas[0].marketplace = "shopee";
  s.tables.cliente_contas[0].external_account_id = null;
  s.tables.ml_tokens = s.tables.ml_tokens.slice(1);
  s.tables.base_cliente_vinculos = s.tables.base_cliente_vinculos.slice(1);
  assert.equal(buildPlan(s, m).validation.ok, true);
});
test("multi-account legítimo preserva IDs/seller/Grants/Bases", (s, m) => {
  const p = buildPlan(s, m);
  assert.deepEqual(p.preserved.clienteContaIds, [11, 21]);
  assert.deepEqual(p.preserved.grantIds, [31, 32]);
  assert.deepEqual(p.preserved.baseIds, [41, 42]);
  assert.ok(
    p.changes.every(
      (c) =>
        !("external_account_id" in c.after) &&
        !("ml_user_id" in c.after) &&
        !("cliente_conta_id" in c.after) &&
        !("base_id" in c.after),
    ),
  );
});
test("contas inativas preservadas e movidas sem reativar", (s, m) => {
  s.tables.cliente_contas.push({
    id: 25,
    cliente_id: 2,
    marketplace: "shopee",
    ativo: false,
    is_primary: false,
  });
  const p = buildPlan(s, m);
  assert.equal(p.validation.ok, true);
  assert.deepEqual(
    p.changes.find((c) => c.table === "cliente_contas" && c.pk.id === 25).after,
    { cliente_id: 1 },
  );
});
test("Grant NULL exato preservado sem backfill", (s, m) => {
  s.tables.ml_tokens[1].cliente_conta_id = null;
  assert.equal(buildPlan(s, m).validation.ok, true);
});
test("Base NULL bloqueia em vez de atribuição automática", (s, m) => {
  s.tables.base_cliente_vinculos[1].cliente_conta_id = null;
  assert.ok(has(s, m, "ACCOUNT_CONTEXT_AMBIGUOUS"));
});
test("Base ausente permite operação manual e gera warning", (s, m) => {
  s.tables.base_cliente_vinculos = [];
  assert.equal(buildPlan(s, m).validation.ok, true);
  assert.ok(
    buildPlan(s, m).validation.warnings.some(
      (w) => w.code === "ACCOUNT_WITHOUT_BASE",
    ),
  );
});
test("ACL/responsáveis divergentes bloqueiam", (s, m) => {
  s.tables.cliente_responsaveis.push({
    id: 99,
    cliente_id: 2,
    user_id: 7,
    papel: "gestor",
    ativo: true,
  });
  assert.ok(has(s, m, "ACL_SCOPE_CHANGE"));
});
test("aprovação empresarial não inferida", (s, m) => {
  delete m.aprovacao;
  assert.ok(has(s, m, "BUSINESS_DECISION_REQUIRED"));
});
test("hash estável com ordem irrelevante e sem mutação", (s, m) => {
  const before = JSON.stringify(s);
  const p = buildPlan(s, m);
  for (const t in s.tables) s.tables[t].reverse();
  s.columns.reverse();
  s.constraints.reverse();
  s.indexes.reverse();
  assert.equal(p.planHash, buildPlan(s, m).planHash);
  assert.equal(JSON.stringify(fixture()), before);
  assert.equal(hash({ b: 1, a: 2 }), hash({ a: 2, b: 1 }));
});
test("hash muda com decisões/materialidade/versão/catálogo", (s, m) => {
  const p = buildPlan(s, m);
  m.decisoes.primaryAccounts.meli = 11;
  assert.notEqual(p.planHash, buildPlan(s, m).planHash);
  m = manifest();
  s.tables.cliente_contas[1]._version = "2";
  assert.notEqual(p.planHash, buildPlan(s, m).planHash);
});
test("hash não muda por outra carteira", (s, m) => {
  const p = buildPlan(s, m);
  s.tables.clientes.push({ id: 99, nome: "fora", slug: "fora", ativo: true });
  s.tables.cliente_contas.push({
    id: 99,
    cliente_id: 99,
    marketplace: "meli",
    external_account_id: "999",
  });
  assert.equal(p.planHash, buildPlan(s, m).planHash);
});
test("manifesto ordena IDs e confirmação determinística", (s, m) => {
  m.clientesLegadosIds = [3, 2];
  assert.equal(confirmation(normalizeManifest(m)), "UNIFICAR 2,3 EM 1");
});
test("secrets e SQL arbitrário recusados", (s, m) => {
  m.access_token = "NAO_EXIBIR";
  assert.throws(() => buildPlan(s, m), { code: "SECRET_FIELD_REJECTED" });
  delete m.access_token;
  m.decisoes.referencias = { "x;DROP TABLE clientes": "MOVE_TO_CANONICAL" };
  assert.throws(() => buildPlan(s, m));
});
test("flag parsing fail closed", (s, m) => {
  for (const value of [undefined, "false", "0", "on", "invalid", ""])
    assert.deepEqual(
      flags({
        CLIENTES_UNIFICACAO_EXECUTE_ENABLED: value,
        CLIENTES_UNIFICACAO_ROLLBACK_ENABLED: value,
      }),
      { execute: false, rollback: false },
    );
  assert.equal(
    flags({ CLIENTES_UNIFICACAO_EXECUTE_ENABLED: " true " }).execute,
    true,
  );
});
test("rollback derivado exatamente de before", (s, m) => {
  const p = buildPlan(s, m);
  for (const c of p.changes) {
    const r = p.rollback.changes.find(
      (r) => r.table === c.table && r.pk.id === c.pk.id,
    );
    assert.deepEqual(r.before, c.after);
    assert.deepEqual(r.after, c.before);
  }
  assert.equal(
    p.changes.some((c) => c.after.nome || c.after.slug),
    false,
  );
});
test("UNIQUE real Ads e perfil comercial detectada", (s, m) => {
  s.tables.ads_resumos_mensais = [
    {
      id: 90,
      cliente_slug: "canonico",
      mes_ref: "2026-01",
      loja_campanha: "todas",
    },
    {
      id: 91,
      cliente_slug: "legado",
      mes_ref: "2026-01",
      loja_campanha: "todas",
    },
  ];
  for (const col of ["id", "cliente_slug", "mes_ref", "loja_campanha"])
    s.columns.push({ table_name: "ads_resumos_mensais", column_name: col });
  s.constraints.push({
    type: "p",
    table_name: "ads_resumos_mensais",
    columns: ["id"],
  });
  s.indexes.push({
    table_name: "ads_resumos_mensais",
    name: "ads_unique",
    unique: true,
    keys: ["cliente_slug", "mes_ref", "loja_campanha"],
  });
  assert.ok(has(s, m, "UNIQUE_COLLISION"));
});
test("índice com expressão não modelada bloqueia", (s, m) => {
  s.indexes.push({
    table_name: "cliente_contas",
    name: "custom_expr",
    unique: true,
    keys: ["cliente_id", "lower(slug)"],
  });
  assert.ok(has(s, m, "UNKNOWN_CRITICAL_REFERENCE"));
});
test("CHECK desconhecido sobre ownership bloqueia", (s, m) => {
  s.constraints.push({
    type: "c",
    table_name: "cliente_contas",
    name: "custom_owner",
    definition: "CHECK (cliente_id <> 1)",
  });
  assert.ok(has(s, m, "UNKNOWN_CRITICAL_REFERENCE"));
});
test("snapshot incompleto nunca vira volume zero", (s, m) => {
  s.errors.push({ table: "historico", code: "BOUNDED_VOLUME_EXCEEDED" });
  assert.ok(has(s, m, "UNKNOWN_CRITICAL_REFERENCE"));
});
test("jobs vivos bloqueiam movimentação", (s, m) => {
  s.tables.margin_snapshot_runs = [
    { id: 90, cliente_id: 2, cliente_conta_id: 21, status: "running" },
  ];
  s.columns.push(
    ...["id", "cliente_id", "cliente_conta_id", "status"].map(
      (column_name) => ({ table_name: "margin_snapshot_runs", column_name }),
    ),
  );
  s.constraints.push({
    table_name: "margin_snapshot_runs",
    type: "p",
    columns: ["id"],
  });
  assert.ok(has(s, m, "ACTIVE_OPERATION"));
});
test("cliente_id e slug divergentes bloqueiam", (s, m) => {
  s.tables.entregas_cliente = [
    { id: 90, cliente_id: 2, cliente_slug: "canonico", cliente_conta_id: 21 },
  ];
  s.columns.push(
    ...["id", "cliente_id", "cliente_slug", "cliente_conta_id"].map(
      (column_name) => ({ table_name: "entregas_cliente", column_name }),
    ),
  );
  s.constraints.push({
    type: "p",
    table_name: "entregas_cliente",
    columns: ["id"],
  });
  assert.ok(has(s, m, "ACCOUNT_OWNER_MISMATCH"));
});
test("snapshot com API key também é rejeitado antes do hash", (s, m) => {
  s.tables.clientes[0].api_key = "SECRET_VALUE_NOT_EXPORTED";
  assert.throws(() => buildPlan(s, m), { code: "SECRET_FIELD_REJECTED" });
});
console.log(`${count} cenários de domínio passaram.`);
