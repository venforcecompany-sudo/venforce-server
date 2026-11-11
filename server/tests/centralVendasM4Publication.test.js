// server/tests/centralVendasM4Publication.test.js
//
// M4 da fundação V3 da Central de Vendas — Candidate/Published.
//
// GATE DE PUBLICAÇÃO (correção sobre a primeira versão do M4 — ver
// centralVendasPublicationService.js e docs/CENTRAL_VENDAS_V3_ARQUITETURA.md
// seção 12.4): NÃO é run.completenessStatus === "complete" (agregado M3).
// É run.status === "completed" AND fonte "orders" desse run === "complete".
// Shipments/Claims/Returns falhos NÃO impedem publicação — o snapshot
// publica com confianca=parcial/podeConcluir=false no GET (M3, inalterado).
//
// PARTE 1 — seleção do published no GET (centralVendasRepository), unitário
//           contra uma fake db mínima de central_vendas_imports/pedidos.
// PARTE 2 — gate de publicação (centralVendasPublicationService), unitário
//           contra uma fake db de sync_runs/sync_sources/imports.
// PARTE 3 — fim-a-fim: worker.executarSyncRun (real) publica sozinho depois
//           do run terminar; GET honesto para zero pedidos; candidate ruim
//           nunca desloca o published bom.

const assert = require("assert");
const Module = require("module");

const repository = require("../services/centralVendas/centralVendasRepository");
const publicationService = require("../services/centralVendas/centralVendasPublicationService");
const runService = require("../services/centralVendas/centralVendasSyncRunService");
const sourceService = require("../services/centralVendas/centralVendasSyncSourceService");
const worker = require("../services/centralVendas/centralVendasSyncWorker");
const { createCentralVendasService } = require("../services/centralVendas/centralVendasService");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `FALHOU: ${label} — recebido ${JSON.stringify(actual)}`);
  checks += 1;
}

// =============================================================================
// PARTE 1 — seleção do published/legacy no GET (centralVendasRepository)
// =============================================================================

function makeImportsDb(imports) {
  const rows = imports.map((row, idx) => ({
    id: row.id ?? idx + 1,
    cliente_slug: row.cliente_slug ?? "loja-da-isa",
    marketplace: row.marketplace ?? "meli",
    competencia: row.competencia,
    cliente_conta_id: row.cliente_conta_id ?? null,
    publication_status: row.publication_status,
    coverage_date_from: row.coverage_date_from ?? null,
    coverage_date_to: row.coverage_date_to ?? null,
    published_at: row.published_at ?? null,
    created_at: row.created_at ?? new Date(2026, 0, 1).toISOString(),
    resumo_json: {},
    payload_json: {},
    fonte: "orders_api",
    status: "processado",
    confianca: "confiavel",
  }));

  return {
    imports: rows,
    pedidos: [],
    async query(sql, params = []) {
      if (sql.includes("FROM central_vendas_imports") && sql.includes("competencia = $2")) {
        const [slug, competencia, marketplace, contaId] = params;
        const includeLegacyConta = sql.includes("IS NULL");
        let matched = rows.filter((r) =>
          r.cliente_slug === slug && r.competencia === competencia && r.marketplace === marketplace
          && (r.publication_status === "published" || r.publication_status === "legacy"));
        if (params.length > 3 && contaId != null) {
          matched = matched.filter((r) => r.cliente_conta_id === contaId || (includeLegacyConta && r.cliente_conta_id == null));
        }
        return { rows: matched };
      }
      if (sql.includes("FROM central_vendas_imports") && sql.includes("competencia BETWEEN $3 AND $4")) {
        const [slug, marketplace, compFrom, compTo, contaId] = params;
        const includeLegacyConta = sql.includes("IS NULL");
        let matched = rows.filter((r) =>
          r.cliente_slug === slug && r.marketplace === marketplace
          && r.competencia >= compFrom && r.competencia <= compTo
          && (r.publication_status === "published" || r.publication_status === "legacy"));
        if (params.length > 4 && contaId != null) {
          matched = matched.filter((r) => r.cliente_conta_id === contaId || (includeLegacyConta && r.cliente_conta_id == null));
        }
        return { rows: matched };
      }
      if (sql.includes("FROM central_vendas_pedidos") && sql.includes("WHERE import_id = $1")) {
        return { rows: [] };
      }
      if (sql.includes("FROM central_vendas_pedido_itens") && sql.includes("WHERE import_id = $1")) {
        return { rows: [] };
      }
      if (sql.includes("FROM central_vendas_componentes") && sql.includes("WHERE import_id = $1")) {
        return { rows: [] };
      }
      if (sql.includes("FROM central_vendas_pedidos") && sql.includes("import_id = ANY($1")) {
        return { rows: [] };
      }
      if (sql.includes("FROM central_vendas_pedido_itens") && sql.includes("pedido_row_id = ANY($1")) {
        return { rows: [] };
      }
      if (sql.includes("FROM central_vendas_componentes") && sql.includes("pedido_row_id = ANY($1")) {
        return { rows: [] };
      }
      if (sql.includes("UPDATE central_vendas_imports") && sql.includes("publication_status = 'published'")) {
        const [syncRunId] = params;
        const afetados = rows.filter((r) => r.sync_run_id === syncRunId && r.publication_status === "candidate");
        for (const row of afetados) {
          row.publication_status = "published";
          row.published_at = new Date().toISOString();
        }
        return { rows: afetados.map((r) => ({ id: r.id, competencia: r.competencia })) };
      }
      // A tabela de vínculos não existe nesta fixture (reuso desligado).
      if (/to_regclass\('public\.central_vendas_import_pedidos'\)/.test(String(sql))) return { rows: [{ ok: false }] };
      throw new Error(`makeImportsDb: SQL nao mapeado -> ${sql.slice(0, 120)}`);
    },
  };
}

async function testeRepositorio() {
  // 1. published A (mês inteiro) + candidate B (nunca aparece) → getCentralVendasByRange escolhe A.
  {
    const db = makeImportsDb([
      { id: 1, competencia: "2026-08", publication_status: "published", coverage_date_from: "2026-08-01", coverage_date_to: "2026-08-31", published_at: "2026-08-01T10:00:00.000Z" },
      { id: 2, competencia: "2026-08", publication_status: "candidate", coverage_date_from: "2026-08-01", coverage_date_to: "2026-08-31" },
    ]);
    const snapshot = await repository.getCentralVendasByRange({ clienteSlug: "loja-da-isa", dateFrom: "2026-08-01", dateTo: "2026-08-31" }, db);
    eq("1: escolhe o published, ignora o candidate", snapshot.importacao.id, 1);
  }

  // 2. published A (antigo) + published B (mais recente, mesma cobertura) → escolhe B (published_at DESC).
  {
    const db = makeImportsDb([
      { id: 1, competencia: "2026-08", publication_status: "published", coverage_date_from: "2026-08-01", coverage_date_to: "2026-08-31", published_at: "2026-08-01T10:00:00.000Z" },
      { id: 2, competencia: "2026-08", publication_status: "published", coverage_date_from: "2026-08-01", coverage_date_to: "2026-08-31", published_at: "2026-08-05T10:00:00.000Z" },
    ]);
    const snapshot = await repository.getCentralVendasByRange({ clienteSlug: "loja-da-isa", dateFrom: "2026-08-01", dateTo: "2026-08-31" }, db);
    eq("2: published mais recente vence", snapshot.importacao.id, 2);
  }

  // 3. Item 4 da spec: snapshot 10→15 NUNCA responde consulta 01→31.
  {
    const db = makeImportsDb([
      { id: 1, competencia: "2026-08", publication_status: "published", coverage_date_from: "2026-08-10", coverage_date_to: "2026-08-15", published_at: "2026-08-16T10:00:00.000Z" },
    ]);
    const snapshot = await repository.getCentralVendasByRange({ clienteSlug: "loja-da-isa", dateFrom: "2026-08-01", dateTo: "2026-08-31" }, db);
    eq("3: cobertura parcial nunca responde range maior", snapshot, null);
  }

  // 4. Item 5 da spec: snapshot 01→31 PODE responder consulta 10→15.
  {
    const db = makeImportsDb([
      { id: 1, competencia: "2026-08", publication_status: "published", coverage_date_from: "2026-08-01", coverage_date_to: "2026-08-31", published_at: "2026-08-16T10:00:00.000Z" },
    ]);
    const snapshot = await repository.getCentralVendasByRange({ clienteSlug: "loja-da-isa", dateFrom: "2026-08-10", dateTo: "2026-08-15" }, db);
    eq("4: cobertura total responde range menor", snapshot.importacao.id, 1);
  }

  // 5. Duas contas ML — published da conta A nunca aparece na leitura da conta B.
  {
    const db = makeImportsDb([
      { id: 1, competencia: "2026-08", cliente_conta_id: 10, publication_status: "published", coverage_date_from: "2026-08-01", coverage_date_to: "2026-08-31", published_at: "2026-08-16T10:00:00.000Z" },
      { id: 2, competencia: "2026-08", cliente_conta_id: 20, publication_status: "published", coverage_date_from: "2026-08-01", coverage_date_to: "2026-08-31", published_at: "2026-08-16T10:00:00.000Z" },
    ]);
    const snapshotA = await repository.getCentralVendasByRange({ clienteSlug: "loja-da-isa", dateFrom: "2026-08-01", dateTo: "2026-08-31", clienteContaId: 10, includeLegacy: false }, db);
    const snapshotB = await repository.getCentralVendasByRange({ clienteSlug: "loja-da-isa", dateFrom: "2026-08-01", dateTo: "2026-08-31", clienteContaId: 20, includeLegacy: false }, db);
    eq("5: conta A ve o import 1", snapshotA.importacao.id, 1);
    eq("5: conta B ve o import 2", snapshotB.importacao.id, 2);
  }

  // 6. Sem published (só legacy) → fallback legacy continua funcionando.
  {
    const db = makeImportsDb([
      { id: 1, competencia: "2026-08", publication_status: "legacy", created_at: "2026-08-05T10:00:00.000Z" },
      { id: 2, competencia: "2026-08", publication_status: "legacy", created_at: "2026-08-10T10:00:00.000Z" },
    ]);
    const snapshot = await repository.getCentralVendasByRange({ clienteSlug: "loja-da-isa", dateFrom: "2026-08-01", dateTo: "2026-08-31" }, db);
    eq("6: fallback pega o legacy mais recente", snapshot.importacao.id, 2);
  }

  // 7. Só candidate (sem published, sem legacy) → nunca aparece no GET oficial.
  {
    const db = makeImportsDb([
      { id: 1, competencia: "2026-08", publication_status: "candidate", coverage_date_from: "2026-08-01", coverage_date_to: "2026-08-31" },
    ]);
    const snapshot = await repository.getCentralVendasByRange({ clienteSlug: "loja-da-isa", dateFrom: "2026-08-01", dateTo: "2026-08-31" }, db);
    eq("7: candidate sozinho nunca aparece", snapshot, null);
  }

  // 8. getLatestCentralVendasImport (leitura mensal legada) segue a mesma regra.
  {
    const db = makeImportsDb([
      { id: 1, competencia: "2026-08", publication_status: "published", coverage_date_from: "2026-08-10", coverage_date_to: "2026-08-15", published_at: "2026-08-16T10:00:00.000Z" },
    ]);
    const semCobrirMesInteiro = await repository.getLatestCentralVendasImport({ clienteSlug: "loja-da-isa", competencia: "2026-08" }, db);
    eq("8: leitura mensal exige cobertura do mes inteiro", semCobrirMesInteiro, null);
  }

  // 9. promoverCandidatesDoRun: promove só os candidates do run pedido, idempotente.
  {
    const db = makeImportsDb([
      { id: 1, competencia: "2026-07", publication_status: "candidate" },
      { id: 2, competencia: "2026-08", publication_status: "candidate" },
      { id: 3, competencia: "2026-08", publication_status: "candidate" },
    ]);
    db.imports[0].sync_run_id = 77;
    db.imports[1].sync_run_id = 77;
    db.imports[2].sync_run_id = 99;

    const primeira = await repository.promoverCandidatesDoRun(77, db);
    eq("9: primeira chamada promove os 2 do run 77", primeira.map((r) => r.id).sort(), [1, 2]);
    eq("9: run 77 imports viram published", db.imports.filter((r) => r.sync_run_id === 77).every((r) => r.publication_status === "published"), true);
    eq("9: run 99 continua candidate (nao foi tocado)", db.imports[2].publication_status, "candidate");

    const segunda = await repository.promoverCandidatesDoRun(77, db);
    eq("9: segunda chamada e idempotente (nada mais a promover)", segunda, []);
    eq("9: run 77 continua published apos a segunda chamada", db.imports.filter((r) => r.sync_run_id === 77).every((r) => r.publication_status === "published"), true);
  }

  console.log(`  PARTE 1 (repositorio) OK`);
}

// =============================================================================
// PARTE 2 — gate de publicação (centralVendasPublicationService)
// =============================================================================

function makeRunDb({ run, fontes }) {
  const runs = [{ ...run }];
  const sources = fontes.map((f, idx) => ({ id: idx + 1, sync_run_id: run.id, ...f }));
  const imports = [];

  return {
    runs, sources, imports,
    async query(sql, params = []) {
      if (sql.includes("SELECT * FROM central_vendas_sync_runs WHERE id = $1")) {
        const row = runs.find((r) => r.id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("SELECT * FROM central_vendas_sync_sources WHERE sync_run_id = $1")) {
        return { rows: sources.filter((s) => s.sync_run_id === params[0]) };
      }
      if (sql.includes("UPDATE central_vendas_imports") && sql.includes("publication_status = 'published'")) {
        const [syncRunId] = params;
        const afetados = imports.filter((r) => r.sync_run_id === syncRunId && r.publication_status === "candidate");
        for (const row of afetados) { row.publication_status = "published"; row.published_at = new Date().toISOString(); }
        return { rows: afetados.map((r) => ({ id: r.id, competencia: r.competencia })) };
      }
      // A tabela de vínculos não existe nesta fixture (reuso desligado).
      if (/to_regclass\('public\.central_vendas_import_pedidos'\)/.test(String(sql))) return { rows: [{ ok: false }] };
      throw new Error(`makeRunDb: SQL nao mapeado -> ${sql.slice(0, 120)}`);
    },
  };
}

function runRow(overrides) {
  return {
    id: 1, status: "completed", cliente_id: 1, cliente_slug: "loja-da-isa",
    cliente_conta_id: null, marketplace: "meli", date_from: "2026-08-01", date_to: "2026-08-31",
    created_at: new Date().toISOString(), started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    error_code: null, error_message: null, metadata_json: {}, completeness_status: null,
    ...overrides,
  };
}

function fonteRow(source, status, extra = {}) {
  return { source, status, complete: status === "complete", ...extra };
}

async function testePublicationService() {
  // 1. run não completed → não publica.
  {
    const db = makeRunDb({ run: runRow({ status: "running" }), fontes: [fonteRow("orders", "complete")] });
    db.imports.push({ id: 1, sync_run_id: 1, publication_status: "candidate", competencia: "2026-08" });
    const resultado = await publicationService.publicarRun(1, { db });
    eq("1: nao publica (run nao completed)", resultado.published, false);
    eq("1: motivo", resultado.reason, "RUN_NAO_COMPLETED");
    eq("1: candidate continua candidate", db.imports[0].publication_status, "candidate");
  }

  // 2. run completed, fonte orders nunca registrada → não publica.
  {
    const db = makeRunDb({ run: runRow(), fontes: [fonteRow("shipments", "complete")] });
    db.imports.push({ id: 1, sync_run_id: 1, publication_status: "candidate", competencia: "2026-08" });
    const resultado = await publicationService.publicarRun(1, { db });
    eq("2: nao publica (orders nunca rodou)", resultado.published, false);
    eq("2: motivo", resultado.reason, "ORDERS_INCOMPLETE");
  }

  // 3. run completed, orders incomplete (truncado) → não publica, mesmo com o run tecnicamente completed.
  {
    const db = makeRunDb({ run: runRow(), fontes: [fonteRow("orders", "incomplete", { errorCode: "ORDERS_TRUNCATED_BY_SAFETY_LIMIT" })] });
    db.imports.push({ id: 1, sync_run_id: 1, publication_status: "candidate", competencia: "2026-08" });
    const resultado = await publicationService.publicarRun(1, { db });
    eq("3: nao publica (orders truncado)", resultado.published, false);
    eq("3: motivo", resultado.reason, "ORDERS_INCOMPLETE");
    eq("3: candidate preservado para auditoria", db.imports[0].publication_status, "candidate");
  }

  // 4. CORREÇÃO — orders complete + shipments/claims failed + run completed → PUBLICA.
  {
    const db = makeRunDb({
      run: runRow(),
      fontes: [
        fonteRow("orders", "complete", { expectedCount: 587, receivedCount: 587 }),
        fonteRow("shipments", "incomplete", { expectedCount: 573, receivedCount: 570 }),
        fonteRow("claims", "failed", { errorCode: "CLAIMS_HTTP_400" }),
        fonteRow("returns", "incomplete", { errorCode: "RETURNS_BLOCKED_BY_CLAIMS" }),
      ],
    });
    db.imports.push({ id: 1, sync_run_id: 1, publication_status: "candidate", competencia: "2026-08" });
    const resultado = await publicationService.publicarRun(1, { db });
    eq("4: publica mesmo com shipments/claims/returns ruins", resultado.published, true);
    eq("4: import promovido", db.imports[0].publication_status, "published");
    ok("4: published_at gravado", !!db.imports[0].published_at);
  }

  // 5. run inexistente → não publica.
  {
    const db = makeRunDb({ run: runRow({ id: 1 }), fontes: [] });
    const resultado = await publicationService.publicarRun(999, { db });
    eq("5: run nao encontrado", resultado.published, false);
    eq("5: motivo", resultado.reason, "RUN_NAO_ENCONTRADO");
  }

  // 6. Idempotência: publicarRun() duas vezes não duplica nada.
  {
    const db = makeRunDb({ run: runRow(), fontes: [fonteRow("orders", "complete")] });
    db.imports.push({ id: 1, sync_run_id: 1, publication_status: "candidate", competencia: "2026-08" });
    db.imports.push({ id: 2, sync_run_id: 1, publication_status: "candidate", competencia: "2026-09" });

    const primeira = await publicationService.publicarRun(1, { db });
    eq("6: primeira chamada publica os 2 imports do run", primeira.importIds.sort(), [1, 2]);
    const publishedAtPrimeira = db.imports.map((r) => r.published_at);

    const segunda = await publicationService.publicarRun(1, { db });
    eq("6: segunda chamada continua published:true", segunda.published, true);
    eq("6: segunda chamada nao promove nada de novo", segunda.importIds, []);
    eq("6: published_at nao muda na segunda chamada", db.imports.map((r) => r.published_at), publishedAtPrimeira);
    eq("6: imports continuam published (nao duplicados nem revertidos)", db.imports.map((r) => r.publication_status), ["published", "published"]);
  }

  console.log(`  PARTE 2 (publication service) OK`);
}

// =============================================================================
// PARTE 3 — fim-a-fim: worker publica sozinho, GET honesto para zero pedidos,
// candidate ruim nunca desloca o published bom.
// =============================================================================

const cliente = { id: 1, nome: "Loja da Isa", slug: "loja-da-isa" };

function grantFixture({ id, cliente_id, ml_user_id }) {
  return {
    id, cliente_id, ml_user_id,
    access_token: "tok-secreto", refresh_token: "ref-secreto",
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    token_status: "valid", is_primary: false, refresh_failures: 0, updated_at: new Date().toISOString(),
  };
}

function pedido(id, shipmentId, dateCreated) {
  return {
    id, date_created: dateCreated, status: "paid", tags: [], payments: [],
    shipping: { id: shipmentId },
    order_items: [{ item: { id: "MLB1", seller_sku: null, title: "Produto" }, quantity: 1, unit_price: 100, sale_fee: 10 }],
  };
}

// Fake db completo: identidade de conta (M1) + sync_runs (M2) + sync_sources
// (M3) + central_vendas_imports/pedidos/itens/componentes (M4) — mesmo
// padrão de centralVendasM3Completude.test.js, estendido com as tabelas de
// import. persistCentralVendasImport é fake (grava direto nos arrays, sem
// passar pela transação real — mesmo motivo do M3: withTransaction usa o
// pool real, nunca o db injetado); as LEITURAS (getLatestCentralVendasImport/
// getCentralVendasByRange/promoverCandidatesDoRun) usam o
// centralVendasRepository DE VERDADE contra esta fake db, provando a seleção
// real.
function makeFullDb({ contas, grants }) {
  const runs = [];
  const sources = [];
  const imports = [];
  const pedidos = [];
  const itens = [];
  const componentes = [];
  let nextRunId = 1;
  let nextSourceId = 1;
  let nextImportId = 1;
  let nextPedidoId = 1;
  let nextItemId = 1;
  let nextComponenteId = 1;

  function acharRunAtivo({ clienteId, clienteContaId, marketplace, dateFrom, dateTo }) {
    return runs.find((r) =>
      r.cliente_id === clienteId && (r.cliente_conta_id ?? null) === (clienteContaId ?? null) &&
      r.marketplace === marketplace && r.date_from === dateFrom && r.date_to === dateTo &&
      (r.status === "queued" || r.status === "running")
    ) || null;
  }

  const db = {
    runs, sources, imports, pedidos, itens, componentes,
    async query(sql, params = []) {
      if (sql.includes("CREATE TABLE") || sql.includes("ALTER TABLE") || sql.includes("CREATE INDEX") || sql.includes("CREATE UNIQUE INDEX")) {
        return { rows: [] };
      }
      if (sql.includes("FROM clientes WHERE slug = $1 AND ativo = true")) {
        return { rows: params[0] === cliente.slug ? [cliente] : [] };
      }
      if (sql.includes("FROM clientes WHERE id")) {
        return { rows: params[0] === cliente.id ? [cliente] : [] };
      }
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
      if (sql.includes("t.cliente_id = $1 AND t.ml_user_id = $2")) {
        const row = grants.find((g) => g.cliente_id === params[0] && String(g.ml_user_id) === String(params[1]));
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("FROM ml_tokens t") && sql.includes("WHERE t.cliente_id = $1")) {
        return { rows: grants.filter((g) => g.cliente_id === params[0]) };
      }
      if (sql.includes("v.cliente_conta_id = $1 AND v.ativo = true")) return { rows: [] };
      if (sql.includes("v.cliente_id = $1 AND v.marketplace = $2 AND v.ativo = true")) return { rows: [] };
      if (sql.includes("FROM custos WHERE base_id")) return { rows: [] };

      if (sql.includes("FROM central_vendas_sync_runs") && sql.includes("status IN ('queued','running')") && !sql.includes("JOIN clientes")) {
        const [clienteId, clienteContaId, marketplace, dateFrom, dateTo] = params;
        const row = acharRunAtivo({ clienteId, clienteContaId, marketplace, dateFrom, dateTo });
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("INSERT INTO central_vendas_sync_runs")) {
        const [clienteId, clienteSlug, clienteContaId, marketplace, externalAccountId, grantId, baseId, baseResolutionMode, dateFrom, dateTo, requestedBy] = params;
        const row = {
          id: nextRunId++, cliente_id: clienteId, cliente_slug: clienteSlug, cliente_conta_id: clienteContaId,
          marketplace, external_account_id: externalAccountId, grant_id: grantId, base_id: baseId,
          base_resolution_mode: baseResolutionMode, date_from: dateFrom, date_to: dateTo, status: "queued",
          requested_by: requestedBy, created_at: new Date().toISOString(), started_at: null, finished_at: null,
          error_code: null, error_message: null, metadata_json: {}, completeness_status: null,
          updated_at: new Date().toISOString(),
        };
        runs.push(row);
        return { rows: [row] };
      }
      if (sql.includes("SYNC_RUN_STALE_QUEUED") || sql.includes("SYNC_RUN_STALE_RUNNING")) return { rows: [] };
      if (sql.includes("UPDATE central_vendas_sync_runs") && sql.includes("status = 'running'") && sql.includes("started_at = NOW()")) {
        const row = runs.find((r) => r.id === params[0] && r.status === "queued");
        if (!row) return { rows: [] };
        Object.assign(row, { status: "running", started_at: new Date().toISOString() });
        return { rows: [row] };
      }
      if (sql.includes("UPDATE central_vendas_sync_runs") && sql.includes("status = 'completed'")) {
        const row = runs.find((r) => r.id === params[0] && r.status === "running");
        if (!row) return { rows: [] };
        Object.assign(row, { status: "completed", finished_at: new Date().toISOString(), metadata_json: JSON.parse(params[1]) });
        return { rows: [row] };
      }
      if (sql.includes("UPDATE central_vendas_sync_runs") && sql.includes("status = 'failed'")) {
        const row = runs.find((r) => r.id === params[0] && r.status === "running");
        if (!row) return { rows: [] };
        Object.assign(row, { status: "failed", finished_at: new Date().toISOString(), error_code: params[1], error_message: params[2] });
        return { rows: [row] };
      }
      if (sql.includes("UPDATE central_vendas_sync_runs") && sql.includes("completeness_status = $2")) {
        const row = runs.find((r) => r.id === params[0]);
        if (!row) return { rows: [] };
        row.completeness_status = params[1];
        return { rows: [row] };
      }
      if (sql.includes("SELECT * FROM central_vendas_sync_runs WHERE id = $1")) {
        const row = runs.find((r) => r.id === params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("JOIN clientes c ON c.id = r.cliente_id") && sql.includes("r.id = $1 AND c.slug = $2")) {
        const row = runs.find((r) => r.id === params[0] && r.cliente_id === cliente.id && params[1] === cliente.slug);
        return { rows: row ? [row] : [] };
      }

      if (sql.includes("INSERT INTO central_vendas_sync_sources")) {
        const [syncRunId, source] = params;
        const TERMINAL = new Set(["complete", "incomplete", "failed", "not_applicable"]);
        let row = sources.find((r) => r.sync_run_id === syncRunId && r.source === source);
        if (!row) {
          row = {
            id: nextSourceId++, sync_run_id: syncRunId, source, status: "running", complete: null,
            expected_count: null, received_count: null, pages_expected: null, pages_received: null,
            attempts: 1, started_at: new Date().toISOString(), finished_at: null,
            error_code: null, http_status: null, error_message: null, metadata_json: {},
          };
          sources.push(row);
          return { rows: [row] };
        }
        if (TERMINAL.has(row.status)) return { rows: [] };
        row.status = "running";
        row.attempts += 1;
        return { rows: [row] };
      }
      if (sql.includes("UPDATE central_vendas_sync_sources") && sql.includes("status = $3")) {
        const [
          syncRunId, source, status, complete, expectedCount, receivedCount,
          pagesExpected, pagesReceived, errorCode, httpStatus, errorMessage, metadataJson,
        ] = params;
        const TERMINAL = new Set(["complete", "incomplete", "failed", "not_applicable"]);
        const row = sources.find((r) => r.sync_run_id === syncRunId && r.source === source && !TERMINAL.has(r.status));
        if (!row) return { rows: [] };
        Object.assign(row, {
          status, complete, expected_count: expectedCount, received_count: receivedCount,
          pages_expected: pagesExpected, pages_received: pagesReceived, error_code: errorCode,
          http_status: httpStatus, error_message: errorMessage, metadata_json: JSON.parse(metadataJson),
        });
        return { rows: [row] };
      }
      if (sql.includes("status = 'failed', complete = false") && sql.includes("IN ('pending', 'running')")) {
        const [syncRunId, errorCode, errorMessage] = params;
        const afetadas = sources.filter((r) => r.sync_run_id === syncRunId && (r.status === "pending" || r.status === "running"));
        for (const row of afetadas) Object.assign(row, { status: "failed", complete: false, error_code: errorCode, error_message: errorMessage });
        return { rows: afetadas.map((r) => ({ source: r.source })) };
      }
      if (sql.includes("SELECT * FROM central_vendas_sync_sources WHERE sync_run_id = $1")) {
        return { rows: sources.filter((r) => r.sync_run_id === params[0]).sort((a, b) => a.id - b.id) };
      }

      // ---- M4: central_vendas_imports (repository real contra esta fake db) ----
      if (sql.includes("FROM central_vendas_imports") && sql.includes("competencia = $2")) {
        const [slug, competencia, marketplace, contaId] = params;
        const includeLegacyConta = sql.includes("IS NULL");
        let matched = imports.filter((r) =>
          r.cliente_slug === slug && r.competencia === competencia && r.marketplace === marketplace
          && (r.publication_status === "published" || r.publication_status === "legacy"));
        if (params.length > 3 && contaId != null) {
          matched = matched.filter((r) => r.cliente_conta_id === contaId || (includeLegacyConta && r.cliente_conta_id == null));
        }
        return { rows: matched };
      }
      if (sql.includes("FROM central_vendas_imports") && sql.includes("competencia BETWEEN $3 AND $4")) {
        const [slug, marketplace, compFrom, compTo, contaId] = params;
        const includeLegacyConta = sql.includes("IS NULL");
        let matched = imports.filter((r) =>
          r.cliente_slug === slug && r.marketplace === marketplace
          && r.competencia >= compFrom && r.competencia <= compTo
          && (r.publication_status === "published" || r.publication_status === "legacy"));
        if (params.length > 4 && contaId != null) {
          matched = matched.filter((r) => r.cliente_conta_id === contaId || (includeLegacyConta && r.cliente_conta_id == null));
        }
        return { rows: matched };
      }
      if (sql.includes("UPDATE central_vendas_imports") && sql.includes("publication_status = 'published'")) {
        const [syncRunId] = params;
        const afetados = imports.filter((r) => r.sync_run_id === syncRunId && r.publication_status === "candidate");
        for (const row of afetados) { row.publication_status = "published"; row.published_at = new Date().toISOString(); }
        return { rows: afetados.map((r) => ({ id: r.id, competencia: r.competencia })) };
      }
      if (sql.includes("FROM central_vendas_pedidos") && sql.includes("WHERE import_id = $1")) {
        return { rows: pedidos.filter((p) => p.import_id === params[0]) };
      }
      if (sql.includes("FROM central_vendas_pedido_itens") && sql.includes("WHERE import_id = $1")) {
        return { rows: itens.filter((i) => i.import_id === params[0]) };
      }
      if (sql.includes("FROM central_vendas_componentes") && sql.includes("WHERE import_id = $1")) {
        return { rows: componentes.filter((c) => c.import_id === params[0]) };
      }
      if (sql.includes("FROM central_vendas_pedidos") && sql.includes("import_id = ANY($1")) {
        const [importIds, dateFrom, dateTo] = params;
        const idsSet = new Set(importIds.map(Number));
        return { rows: pedidos.filter((p) => idsSet.has(Number(p.import_id)) && p.data_pedido != null && p.data_pedido >= dateFrom && p.data_pedido <= dateTo) };
      }
      if (sql.includes("FROM central_vendas_pedido_itens") && sql.includes("pedido_row_id = ANY($1")) {
        const idsSet = new Set(params[0].map(Number));
        return { rows: itens.filter((i) => idsSet.has(Number(i.pedido_row_id))) };
      }
      if (sql.includes("FROM central_vendas_componentes") && sql.includes("pedido_row_id = ANY($1")) {
        const idsSet = new Set(params[0].map(Number));
        return { rows: componentes.filter((c) => idsSet.has(Number(c.pedido_row_id))) };
      }

      // A tabela de vínculos não existe nesta fixture (reuso desligado).
      if (/to_regclass\('public\.central_vendas_import_pedidos'\)/.test(String(sql))) return { rows: [{ ok: false }] };
      throw new Error(`makeFullDb: SQL nao mapeado -> ${sql.slice(0, 160)}`);
    },
  };

  // fakeRepo: só o WRITE (persistCentralVendasImport) é fake — mesmo motivo
  // do M3 (withTransaction usa pool real). Leituras usam o repository real.
  db.fakeRepo = {
    async ensureCentralVendasTables() {},
    async getClienteBySlug(slug) { return slug === cliente.slug ? cliente : null; },
    // getLatestCentralVendasImport/getCentralVendasByRange delegam para o
    // repository DE VERDADE (a lógica de seleção published/legacy que este
    // arquivo está provando) — só getClienteBySlug/persistCentralVendasImport
    // são fake, e só porque ambos ignoram o `db` injetado nas funções reais
    // (getClienteBySlug tem default mas o caller não repassa; persist usa
    // pool.connect() direto via withTransaction — mesmo motivo do M3).
    async getLatestCentralVendasImport(args) { return repository.getLatestCentralVendasImport(args, db); },
    async getCentralVendasByRange(args) { return repository.getCentralVendasByRange(args, db); },
    async persistCentralVendasImport(args) {
      const {
        marketplace, competencia, motorPayload, resumo, fonte,
        clienteContaId, baseId, baseResolutionMode, grantId, externalAccountId,
        syncRunId, publicationStatus, coverageDateFrom, coverageDateTo,
      } = args;
      const importRow = {
        id: nextImportId++, cliente_id: cliente.id, cliente_slug: cliente.slug, marketplace, competencia,
        fonte: fonte || "orders_api", status: "processado", confianca: resumo?.confianca || null,
        resumo_json: resumo || {}, payload_json: motorPayload || {},
        cliente_conta_id: clienteContaId ?? null, base_id: baseId ?? null,
        base_resolution_mode: baseResolutionMode ?? null, grant_id: grantId ?? null,
        external_account_id: externalAccountId ?? null, sync_run_id: syncRunId ?? null,
        publication_status: publicationStatus || "legacy",
        coverage_date_from: coverageDateFrom || null, coverage_date_to: coverageDateTo || null,
        published_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      imports.push(importRow);

      const pedidoRowsById = new Map();
      for (const p of motorPayload.pedidos || []) {
        const row = {
          id: nextPedidoId++, import_id: importRow.id, pedido_id: p.pedidoId,
          data_pedido: p.dataPedido ? String(p.dataPedido).slice(0, 10) : null,
          status: p.status || null, confianca: p.confianca,
          faturamento: p.faturamento ?? null, resultado: p.resultado ?? null,
          pendencias_json: p.pendencias || [], payload_json: p,
        };
        pedidos.push(row);
        pedidoRowsById.set(p.pedidoId, row.id);
      }
      const itemRowsById = new Map();
      for (const item of motorPayload.itens || []) {
        const row = {
          id: nextItemId++, import_id: importRow.id, pedido_row_id: pedidoRowsById.get(item.pedidoId) || null,
          pedido_id: item.pedidoId, item_id: item.itemId, mlb: item.mlb || null, sku: item.sku || null,
          titulo: item.titulo || null, quantidade: item.quantidade ?? null,
          confianca: item.confianca, pendencias_json: item.pendencias || [], payload_json: item,
        };
        itens.push(row);
        itemRowsById.set(item.itemId, row.id);
      }
      for (const c of motorPayload.componentes || []) {
        componentes.push({
          id: nextComponenteId++, import_id: importRow.id,
          pedido_row_id: pedidoRowsById.get(c.pedidoId) || null,
          item_row_id: c.itemId ? (itemRowsById.get(c.itemId) || null) : null,
          pedido_id: c.pedidoId, item_id: c.itemId || null, tipo: c.tipo, valor: c.valor ?? null,
          fonte: c.fonte || null, confianca: c.confianca, obs: c.obs || null, payload_json: c,
        });
      }

      return {
        importacao: importRow,
        pedidosPersistidos: pedidoRowsById.size,
        itensPersistidos: itemRowsById.size,
        componentesPersistidos: (motorPayload.componentes || []).length,
      };
    },
  };

  return db;
}

function carregarComHandlers(handlers) {
  const originalLoad = Module._load;
  Module._load = function loadWithStub(request, parent, isMain) {
    if (request === "../../utils/mlClient") {
      return {
        async mlFetch(clienteId, path, options = {}) {
          for (const [prefix, handler] of handlers) {
            if (path.startsWith(prefix)) return handler(path, options);
          }
          return { ok: true, status: 200, data: {} };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("../services/centralVendas/centralVendasSyncService")];
    delete require.cache[require.resolve("../services/centralVendas/centralVendasClaimsService")];
    delete require.cache[require.resolve("../services/centralVendas/centralVendasFreteService")];
    return require("../services/centralVendas/centralVendasSyncService");
  } finally {
    Module._load = originalLoad;
  }
}

async function capturandoLogs(fn) {
  const original = console.log;
  const originalErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try { return await fn(); } finally { console.log = original; console.error = originalErr; }
}

async function testeFimAFim() {
  const contas = [{ id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", slug: "loja-isa", external_account_id: "111", is_primary: true, ativo: true }];
  const grants = [grantFixture({ id: 100, cliente_id: 1, ml_user_id: "111" })];

  await capturandoLogs(async () => {
    const db = makeFullDb({ contas, grants });
    const getCentralVendas = createCentralVendasService(db.fakeRepo, db).getCentralVendas;

    // ---- Run A: sincronização boa (Orders/Shipments/Claims completos) ----
    const runA = await runService.criarSyncRun({
      clienteSlug: cliente.slug, marketplace: "meli", dateFrom: "2026-08-01", dateTo: "2026-08-31", db,
    });
    const syncServiceA = carregarComHandlers([
      ["/orders/search", () => ({ ok: true, status: 200, data: { results: [pedido("9001", "s1", "2026-08-10T10:00:00.000-03:00")], paging: { total: 1 } } })],
      ["/shipments/", () => ({ ok: true, status: 200, data: { senders: [{ user_id: "111", cost: 12.5 }], receiver: { cost: 5 } } })],
      ["/post-purchase/v1/claims/search", () => ({ ok: true, status: 200, data: { data: [], paging: { total: 0 } } })],
    ]);
    await worker.executarSyncRun({
      run: runA.run, context: runA.context, db,
      sincronizarVendasMeli: syncServiceA.createCentralVendasSyncService(db.fakeRepo, db).sincronizarVendasMeli,
      params: { clienteSlug: cliente.slug, dateFrom: "2026-08-01", dateTo: "2026-08-31", marketplace: "meli" },
    });

    const runAFinal = await runService.obterSyncRun({ runId: runA.run.id, clienteSlug: cliente.slug, db });
    eq("E2E: run A completed", runAFinal.status, "completed");
    const importsRunA = db.imports.filter((r) => r.sync_run_id === runA.run.id);
    ok("E2E: run A gerou candidate", importsRunA.length > 0);
    eq("E2E: worker publicou o candidate do run A sozinho", importsRunA.every((r) => r.publication_status === "published"), true);

    const getA = await getCentralVendas(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    eq("E2E: GET ve o pedido do run A", getA.resumo.pedidosTotal, 1);
    eq("E2E: GET ve o pedido certo (9001)", getA.pedidos[0]?.pedidoId, "9001");
    eq("E2E: GET persistido (nao sem_dados)", getA.motor.status, "persistido");

    // ---- Run B: mesma janela, Orders TRUNCADO (40 recebidos, total=50) ----
    // candidate ruim: run tecnicamente completed, mas orders != complete.
    const runB = await runService.criarSyncRun({
      clienteSlug: cliente.slug, marketplace: "meli", dateFrom: "2026-08-01", dateTo: "2026-08-31", db,
    });
    const paginaTruncada = Array.from({ length: 40 }, (_, i) => pedido(`B${i}`, `sB${i}`, "2026-08-12T10:00:00.000-03:00"));
    const syncServiceB = carregarComHandlers([
      ["/orders/search", () => ({ ok: true, status: 200, data: { results: paginaTruncada, paging: { total: 50 } } })],
      ["/shipments/", () => ({ ok: true, status: 200, data: { senders: [{ user_id: "111", cost: 9 }], receiver: { cost: 3 } } })],
      ["/post-purchase/v1/claims/search", () => ({ ok: true, status: 200, data: { data: [], paging: { total: 0 } } })],
    ]);
    await worker.executarSyncRun({
      run: runB.run, context: runB.context, db,
      sincronizarVendasMeli: syncServiceB.createCentralVendasSyncService(db.fakeRepo, db).sincronizarVendasMeli,
      params: { clienteSlug: cliente.slug, dateFrom: "2026-08-01", dateTo: "2026-08-31", marketplace: "meli" },
    });

    const runBFinal = await runService.obterSyncRun({ runId: runB.run.id, clienteSlug: cliente.slug, db });
    eq("E2E: run B completed (orders incompleto nao e falha tecnica)", runBFinal.status, "completed");
    const importsRunB = db.imports.filter((r) => r.sync_run_id === runB.run.id);
    ok("E2E: run B gerou candidate", importsRunB.length > 0);
    eq("E2E: run B NUNCA publicado (orders truncado)", importsRunB.every((r) => r.publication_status === "candidate"), true);

    const getDepoisDeB = await getCentralVendas(cliente.slug, { dateFrom: "2026-08-01", dateTo: "2026-08-31" });
    eq("E2E: GET continua no snapshot do run A — candidate ruim nao desloca published bom", getDepoisDeB.resumo.pedidosTotal, 1);
    eq("E2E: GET nao mostra os 40 pedidos do candidate truncado", getDepoisDeB.motor.importId, getA.motor.importId);

    // ---- Run C: Orders 0/0 num mes diferente → snapshot vazio publicado ----
    const runC = await runService.criarSyncRun({
      clienteSlug: cliente.slug, marketplace: "meli", dateFrom: "2026-09-01", dateTo: "2026-09-30", db,
    });
    const syncServiceC = carregarComHandlers([
      ["/orders/search", () => ({ ok: true, status: 200, data: { results: [], paging: { total: 0 } } })],
      ["/post-purchase/v1/claims/search", () => ({ ok: true, status: 200, data: { data: [], paging: { total: 0 } } })],
    ]);
    await worker.executarSyncRun({
      run: runC.run, context: runC.context, db,
      sincronizarVendasMeli: syncServiceC.createCentralVendasSyncService(db.fakeRepo, db).sincronizarVendasMeli,
      params: { clienteSlug: cliente.slug, dateFrom: "2026-09-01", dateTo: "2026-09-30", marketplace: "meli" },
    });

    const runCFinal = await runService.obterSyncRun({ runId: runC.run.id, clienteSlug: cliente.slug, db });
    eq("E2E: run C completed (zero orders nao e erro)", runCFinal.status, "completed");
    const importsRunC = db.imports.filter((r) => r.sync_run_id === runC.run.id);
    ok("E2E: run C persistiu snapshot vazio (nao ficou sem import nenhum)", importsRunC.length > 0);
    eq("E2E: snapshot vazio publicado (orders 0/0 e complete)", importsRunC.every((r) => r.publication_status === "published"), true);

    const getC = await getCentralVendas(cliente.slug, { dateFrom: "2026-09-01", dateTo: "2026-09-30" });
    eq("E2E: GET de mes vazio NAO e sem_dados", getC.motor.status, "persistido");
    eq("E2E: GET mostra 0 pedidos verificados", getC.resumo.pedidosTotal, 0);
    eq("E2E: confianca de 0 pedidos verificados e confiavel, nao ausente", getC.motor.confianca, "confiavel");
    ok("E2E: podeConcluir true (nada bloqueado)", getC.motor.podeConcluir === true);
  });

  console.log(`  PARTE 3 (fim-a-fim) OK`);
}

async function run() {
  await testeRepositorio();
  await testePublicationService();
  await testeFimAFim();
  console.log(`centralVendasM4Publication.test.js: ${checks} verificacoes OK`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
