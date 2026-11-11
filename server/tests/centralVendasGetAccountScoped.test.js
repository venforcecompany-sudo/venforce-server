// server/tests/centralVendasGetAccountScoped.test.js
//
// P0 do hardening M1/M2: getCentralVendas() resolve `context.conta`, mas
// antes desta correção o repository lia o snapshot só por
// cliente_slug+marketplace+competência/range — nunca por cliente_conta_id.
// Cenário reproduzido aqui (seção 3 da spec):
//
//   Cliente A
//     Conta 10 → import 100 (10:00)
//     Conta 11 → import 101 (11:00, mais recente)
//
//   GET clienteContaId=10 deve devolver o import 100, NUNCA o 101 — mesmo o
//   101 sendo mais recente. Testa também invertendo a conta e cruzando
//   competências no range.
//
// Fake db único (mesmo padrão de centralVendasAccountContext.test.js):
// simula cliente_contas/ml_tokens/base_cliente_vinculos (resolver de
// identidade) + as tabelas central_vendas_imports/pedidos/itens/componentes
// em memória, o suficiente para exercitar getLatestCentralVendasImport e
// getCentralVendasByRange reais (não fakes) via createCentralVendasService.

const assert = require("assert");
const { createCentralVendasService } = require("../services/centralVendas/centralVendasService");
const repository = require("../services/centralVendas/centralVendasRepository");

const clienteA = { id: 1, nome: "Cliente A", slug: "cliente-a", ativo: true };

// createCentralVendasService(repository, db) só repassa `db` para
// resolveMarketplaceAccountContext (via `queryable`) — as funções do
// repository são chamadas com seus próprios defaults (db=pool real) a
// menos que o objeto `repository` injetado já as amarre a um db. Este
// wrapper liga as funções REAIS do repository (a lógica que este teste
// quer provar) ao mesmo fake db, em vez de fake-repository-los por
// completo — é o SQL-shape real de getLatestCentralVendasImport/
// getCentralVendasByRange que está sob teste aqui.
function realRepositoryComDb(db) {
  return {
    ensureCentralVendasTables: () => repository.ensureCentralVendasTables(db),
    getClienteBySlug: (slug) => repository.getClienteBySlug(slug, db),
    getLatestCentralVendasImport: (args) => repository.getLatestCentralVendasImport(args, db),
    getCentralVendasByRange: (args) => repository.getCentralVendasByRange(args, db),
  };
}

function makeDb({ contas = [], imports = [], pedidos = [] }) {
  return {
    async query(sql, params = []) {
      if (sql.includes("CREATE TABLE") || sql.includes("ALTER TABLE") || sql.includes("CREATE INDEX") || sql.includes("CREATE UNIQUE INDEX") || sql.includes("WITH duplicados")) {
        return { rows: [] };
      }
      if (sql.includes("FROM clientes") && sql.includes("slug = $1")) {
        return { rows: params[0] === clienteA.slug ? [clienteA] : [] };
      }
      if (sql.includes("FROM clientes") && sql.includes("WHERE id")) {
        return { rows: params[0] === clienteA.id ? [clienteA] : [] };
      }
      // resolveMarketplaceAccountContext
      if (sql.includes("cliente_contas WHERE id = $1")) {
        const row = contas.find((c) => c.id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true ORDER BY is_primary")) {
        return { rows: contas.filter((c) => c.cliente_id === params[0] && c.marketplace === params[1] && c.ativo !== false) };
      }
      if (sql.includes("COUNT(*)::int AS total FROM cliente_contas")) {
        const total = contas.filter((c) => c.cliente_id === params[0] && c.marketplace === params[1] && c.ativo !== false).length;
        return { rows: [{ total }] };
      }
      if (sql.includes("FROM ml_tokens t")) return { rows: [] }; // sem grant nesta suíte — GET não exige
      if (sql.includes("v.cliente_conta_id = $1 AND v.ativo = true")) return { rows: [] };
      if (sql.includes("v.cliente_id = $1 AND v.marketplace = $2 AND v.ativo = true")) return { rows: [] };

      // ── central_vendas_imports: getLatestCentralVendasImport (por competência) ──
      if (sql.includes("FROM central_vendas_imports") && sql.includes("competencia = $2")) {
        const [slug, competencia, marketplace] = params;
        let candidatos = imports.filter((row) =>
          row.cliente_slug === slug && row.competencia === competencia && row.marketplace === marketplace
          && (row.publication_status === "published" || row.publication_status === "legacy")
        );
        // condição de conta é opcional, adicionada dinamicamente — simula
        // por posição: se o SQL contém "cliente_conta_id = $4" é estrito;
        // se contém "OR cliente_conta_id IS NULL" é o modo legado tolerante.
        if (params.length >= 4) {
          const clienteContaId = params[3];
          if (sql.includes("OR cliente_conta_id IS NULL")) {
            candidatos = candidatos.filter((r) => r.cliente_conta_id === clienteContaId || r.cliente_conta_id == null);
          } else {
            candidatos = candidatos.filter((r) => r.cliente_conta_id === clienteContaId);
          }
        }
        candidatos = candidatos.slice().sort((a, b) => (b.created_at > a.created_at ? 1 : -1) || b.id - a.id);
        return { rows: candidatos.slice(0, 1) };
      }
      if (sql.includes("FROM central_vendas_pedidos") && sql.includes("import_id = $1") && !sql.includes("ANY")) {
        return { rows: pedidos.filter((p) => p.import_id === params[0]) };
      }
      if (sql.includes("FROM central_vendas_pedido_itens") && sql.includes("import_id = $1")) return { rows: [] };
      if (sql.includes("FROM central_vendas_componentes") && sql.includes("import_id = $1") && !sql.includes("ANY")) return { rows: [] };

      // ── central_vendas_imports: getCentralVendasByRange ──
      // M4: o repository real agora busca TODAS as linhas candidatas e reduz
      // em JS (selecionarMelhorImportPorCompetencia, considerando published/
      // legacy/cobertura) — este fake só filtra (slug/marketplace/competência/
      // conta/publication_status), sem escolher a "vencedora" por competência.
      if (sql.includes("competencia BETWEEN $3 AND $4") && sql.includes("FROM central_vendas_imports")) {
        const [slug, marketplace, compFrom, compTo] = params;
        let candidatos = imports.filter((row) =>
          row.cliente_slug === slug && row.marketplace === marketplace &&
          row.competencia >= compFrom && row.competencia <= compTo &&
          (row.publication_status === "published" || row.publication_status === "legacy")
        );
        if (params.length >= 5) {
          const clienteContaId = params[4];
          if (sql.includes("OR cliente_conta_id IS NULL")) {
            candidatos = candidatos.filter((r) => r.cliente_conta_id === clienteContaId || r.cliente_conta_id == null);
          } else {
            candidatos = candidatos.filter((r) => r.cliente_conta_id === clienteContaId);
          }
        }
        return { rows: candidatos };
      }
      if (sql.includes("FROM central_vendas_pedidos") && sql.includes("import_id = ANY")) {
        const [importIds, dateFrom, dateTo] = params;
        return { rows: pedidos.filter((p) => importIds.includes(p.import_id) && p.data_pedido >= dateFrom && p.data_pedido <= dateTo) };
      }
      if (sql.includes("FROM central_vendas_pedido_itens") && sql.includes("pedido_row_id = ANY")) return { rows: [] };
      if (sql.includes("FROM central_vendas_componentes") && sql.includes("pedido_row_id = ANY")) return { rows: [] };

      // A tabela de vínculos não existe nesta fixture (reuso desligado).
      if (/to_regclass\('public\.central_vendas_import_pedidos'\)/.test(String(sql))) return { rows: [{ ok: false }] };
      throw new Error(`Fake db: SQL nao mapeado -> ${sql.slice(0, 160)}`);
    },
  };
}

async function run() {
  // 1. GET por competência: conta 10 nunca lê o import mais recente da conta 11.
  {
    const contas = [
      { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", slug: "a1", external_account_id: "111", is_primary: true, ativo: true },
      { id: 11, cliente_id: 1, marketplace: "meli", nome: "ML 2", slug: "a2", external_account_id: "222", is_primary: false, ativo: true },
    ];
    const imports = [
      { id: 100, cliente_slug: "cliente-a", marketplace: "meli", competencia: "2026-08", cliente_conta_id: 10, fonte: "orders_api", status: "processado", confianca: "confiavel", publication_status: "legacy", resumo_json: {}, payload_json: {}, created_at: "2026-08-19T10:00:00.000Z" },
      { id: 101, cliente_slug: "cliente-a", marketplace: "meli", competencia: "2026-08", cliente_conta_id: 11, fonte: "orders_api", status: "processado", confianca: "confiavel", publication_status: "legacy", resumo_json: {}, payload_json: {}, created_at: "2026-08-19T11:00:00.000Z" },
    ];
    const pedidos = [
      { id: 1, import_id: 100, pedido_id: "P_CONTA10", data_pedido: "2026-08-05", status: "paid", confianca: "confiavel", pendencias_json: [], payload_json: {} },
      { id: 2, import_id: 101, pedido_id: "P_CONTA11", data_pedido: "2026-08-06", status: "paid", confianca: "confiavel", pendencias_json: [], payload_json: {} },
    ];

    const db = makeDb({ contas, imports, pedidos });
    const svc = createCentralVendasService(realRepositoryComDb(db), db);

    const payloadConta10 = await svc.getCentralVendas("cliente-a", { competencia: "2026-08", clienteContaId: 10 });
    assert.strictEqual(payloadConta10.motor.importId, 100, "conta 10 deve ler o import 100, nunca o 101 (mais recente, mas de outra conta)");
    assert.strictEqual(payloadConta10.pedidos.length, 1);
    assert.strictEqual(payloadConta10.pedidos[0].id, "P_CONTA10");
    console.log("  ✓ GET por competência: conta 10 nunca lê o snapshot mais recente da conta 11");

    // Inverte: conta 11 deve ler o 101, nunca o 100.
    const payloadConta11 = await svc.getCentralVendas("cliente-a", { competencia: "2026-08", clienteContaId: 11 });
    assert.strictEqual(payloadConta11.motor.importId, 101);
    assert.strictEqual(payloadConta11.pedidos[0].id, "P_CONTA11");
    console.log("  ✓ GET por competência: conta 11 nunca lê o snapshot da conta 10 (invertido)");
  }

  // 2. GET por intervalo de datas (range), cruzando 2 competências — mesma
  //    regra: conta 10 nunca vê o pedido da conta 11, mesmo dentro do range.
  {
    const contas = [
      { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", slug: "a1", external_account_id: "111", is_primary: true, ativo: true },
      { id: 11, cliente_id: 1, marketplace: "meli", nome: "ML 2", slug: "a2", external_account_id: "222", is_primary: false, ativo: true },
    ];
    const imports = [
      { id: 200, cliente_slug: "cliente-a", marketplace: "meli", competencia: "2026-07", cliente_conta_id: 10, fonte: "orders_api", status: "processado", confianca: "confiavel", publication_status: "legacy", resumo_json: {}, payload_json: {}, created_at: "2026-07-31T10:00:00.000Z" },
      { id: 201, cliente_slug: "cliente-a", marketplace: "meli", competencia: "2026-07", cliente_conta_id: 11, fonte: "orders_api", status: "processado", confianca: "confiavel", publication_status: "legacy", resumo_json: {}, payload_json: {}, created_at: "2026-07-31T11:00:00.000Z" },
      { id: 202, cliente_slug: "cliente-a", marketplace: "meli", competencia: "2026-08", cliente_conta_id: 10, fonte: "orders_api", status: "processado", confianca: "confiavel", publication_status: "legacy", resumo_json: {}, payload_json: {}, created_at: "2026-08-10T10:00:00.000Z" },
      { id: 203, cliente_slug: "cliente-a", marketplace: "meli", competencia: "2026-08", cliente_conta_id: 11, fonte: "orders_api", status: "processado", confianca: "confiavel", publication_status: "legacy", resumo_json: {}, payload_json: {}, created_at: "2026-08-10T11:00:00.000Z" },
    ];
    const pedidos = [
      { id: 1, import_id: 200, pedido_id: "JUL_CONTA10", data_pedido: "2026-07-15", status: "paid", confianca: "confiavel", pendencias_json: [], payload_json: {} },
      { id: 2, import_id: 201, pedido_id: "JUL_CONTA11", data_pedido: "2026-07-15", status: "paid", confianca: "confiavel", pendencias_json: [], payload_json: {} },
      { id: 3, import_id: 202, pedido_id: "AGO_CONTA10", data_pedido: "2026-08-05", status: "paid", confianca: "confiavel", pendencias_json: [], payload_json: {} },
      { id: 4, import_id: 203, pedido_id: "AGO_CONTA11", data_pedido: "2026-08-05", status: "paid", confianca: "confiavel", pendencias_json: [], payload_json: {} },
    ];

    const db = makeDb({ contas, imports, pedidos });
    const svc = createCentralVendasService(realRepositoryComDb(db), db);
    const payload = await svc.getCentralVendas("cliente-a", { dateFrom: "2026-07-01", dateTo: "2026-08-31", clienteContaId: 10 });

    const idsRetornados = payload.pedidos.map((p) => p.id).sort();
    assert.deepStrictEqual(idsRetornados, ["AGO_CONTA10", "JUL_CONTA10"], "range deve trazer só pedidos da conta 10, em ambas as competências, nunca da conta 11");
    console.log("  ✓ GET por intervalo cruzando competências nunca mistura pedidos de outra conta");
  }

  // 3. Compatibilidade legada: única conta ativa → snapshot cliente_conta_id
  //    NULL (anterior à fundação de contas) continua legível.
  {
    const contas = [
      { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", slug: "a1", external_account_id: "111", is_primary: true, ativo: true },
    ];
    const imports = [
      { id: 300, cliente_slug: "cliente-a", marketplace: "meli", competencia: "2026-06", cliente_conta_id: null, fonte: "orders_api", status: "processado", confianca: "confiavel", publication_status: "legacy", resumo_json: {}, payload_json: {}, created_at: "2026-06-30T10:00:00.000Z" },
    ];
    const pedidos = [
      { id: 1, import_id: 300, pedido_id: "LEGADO", data_pedido: "2026-06-15", status: "paid", confianca: "confiavel", pendencias_json: [], payload_json: {} },
    ];

    const db = makeDb({ contas, imports, pedidos });
    const svc = createCentralVendasService(realRepositoryComDb(db), db);
    const payload = await svc.getCentralVendas("cliente-a", { competencia: "2026-06" });
    assert.strictEqual(payload.motor.importId, 300, "única conta ativa: snapshot legado (cliente_conta_id NULL) continua legível");
    console.log("  ✓ compat legada: única conta ativa lê snapshot cliente_conta_id=NULL anterior à fundação");
  }

  // 4. Ambiguidade real: 2+ contas ativas, snapshot legado (NULL) NUNCA é
  //    devolvido para nenhuma delas — nunca arriscar dado de outra conta.
  {
    const contas = [
      { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", slug: "a1", external_account_id: "111", is_primary: true, ativo: true },
      { id: 11, cliente_id: 1, marketplace: "meli", nome: "ML 2", slug: "a2", external_account_id: "222", is_primary: false, ativo: true },
    ];
    const imports = [
      { id: 400, cliente_slug: "cliente-a", marketplace: "meli", competencia: "2026-05", cliente_conta_id: null, fonte: "orders_api", status: "processado", confianca: "confiavel", publication_status: "legacy", resumo_json: {}, payload_json: {}, created_at: "2026-05-31T10:00:00.000Z" },
    ];
    const pedidos = [
      { id: 1, import_id: 400, pedido_id: "LEGADO_AMBIGUO", data_pedido: "2026-05-15", status: "paid", confianca: "confiavel", pendencias_json: [], payload_json: {} },
    ];

    const db = makeDb({ contas, imports, pedidos });
    const svc = createCentralVendasService(realRepositoryComDb(db), db);
    const payload = await svc.getCentralVendas("cliente-a", { competencia: "2026-05", clienteContaId: 10 });
    assert.strictEqual(payload.motor.status, "sem_dados", "com 2+ contas ativas, snapshot legado (NULL) não pode ser devolvido para nenhuma conta");
    assert.strictEqual(payload.pedidos.length, 0);
    console.log("  ✓ ambiguidade (2+ contas ativas): snapshot legado NULL nunca é devolvido, nem para a conta explícita");
  }

  console.log("centralVendasGetAccountScoped.test.js passed");
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
