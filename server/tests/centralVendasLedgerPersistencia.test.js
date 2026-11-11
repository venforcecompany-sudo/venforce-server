// M6 — Ledger financeiro auditável: persistência (imutabilidade,
// candidate/published, account-scope, segurança).
//
// Testa createImport/insertPedido/insertItem/insertComponente REAIS
// (centralVendasRepository.js) contra uma fake db — mesmo padrão de
// centralVendasM4Publication.test.js (persistCentralVendasImport usa
// withTransaction/pool.connect() real e não aceita db injetado; as funções
// individuais aceitam `db` diretamente, por isso M6 as expôs no
// module.exports para serem testáveis sem Postgres real).

const assert = require("assert");
const repository = require("../services/centralVendas/centralVendasRepository");

let checks = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `FALHOU: ${label} — recebido ${JSON.stringify(actual)}`);
  checks += 1;
}
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
}

const cliente = { id: 1, slug: "loja-da-isa" };

function makeDb() {
  const imports = [];
  const pedidos = [];
  const itens = [];
  const componentes = [];
  let nextImportId = 1;
  let nextPedidoId = 1;
  let nextItemId = 1;
  let nextComponenteId = 1;

  return {
    imports, pedidos, itens, componentes,
    async query(sql, params = []) {
      if (sql.includes("INSERT INTO central_vendas_imports")) {
        const [
          clienteId, clienteSlug, marketplace, competencia, fonte, status, confianca,
          resumoJson, payloadJson, clienteContaId, baseId, baseResolutionMode, grantId,
          externalAccountId, syncRunId, publicationStatus, coverageDateFrom, coverageDateTo,
        ] = params;
        const row = {
          id: nextImportId++, cliente_id: clienteId, cliente_slug: clienteSlug, marketplace, competencia,
          fonte, status, confianca, resumo_json: JSON.parse(resumoJson), payload_json: JSON.parse(payloadJson),
          cliente_conta_id: clienteContaId, base_id: baseId, base_resolution_mode: baseResolutionMode,
          grant_id: grantId, external_account_id: externalAccountId, sync_run_id: syncRunId,
          publication_status: publicationStatus, coverage_date_from: coverageDateFrom, coverage_date_to: coverageDateTo,
          published_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        imports.push(row);
        return { rows: [row] };
      }
      if (sql.includes("INSERT INTO central_vendas_pedidos")) {
        const [
          importId, clienteId, clienteSlug, marketplace, competencia, pedidoId, packId, shipmentId,
          dataPedido, status, confianca, quantidadeItens, faturamento, lucroContribuicao, resultado,
          margem, pendenciasJson, payloadJson,
        ] = params;
        const row = {
          id: nextPedidoId++, import_id: importId, cliente_id: clienteId, cliente_slug: clienteSlug,
          marketplace, competencia, pedido_id: pedidoId, pack_id: packId, shipment_id: shipmentId,
          data_pedido: dataPedido, status, confianca, quantidade_itens: quantidadeItens,
          faturamento, lucro_contribuicao: lucroContribuicao, resultado,
          margem_contribuicao_percentual: margem, pendencias_json: JSON.parse(pendenciasJson),
          payload_json: JSON.parse(payloadJson),
        };
        pedidos.push(row);
        return { rows: [row] };
      }
      if (sql.includes("INSERT INTO central_vendas_pedido_itens")) {
        const [
          importId, pedidoRowId, clienteId, clienteSlug, marketplace, competencia, pedidoId, itemId,
          mlb, sku, titulo, quantidade, valorUnitario, receitaProduto, custoProduto, impostoInterno,
          lucroContribuicao, resultado, margem, confianca, pendenciasJson, payloadJson,
        ] = params;
        const row = {
          id: nextItemId++, import_id: importId, pedido_row_id: pedidoRowId, cliente_id: clienteId,
          cliente_slug: clienteSlug, marketplace, competencia, pedido_id: pedidoId, item_id: itemId,
          mlb, sku, titulo, quantidade, valor_unitario: valorUnitario, receita_produto: receitaProduto,
          custo_produto: custoProduto, imposto_interno: impostoInterno, lucro_contribuicao: lucroContribuicao,
          resultado, margem_contribuicao_percentual: margem, confianca,
          pendencias_json: JSON.parse(pendenciasJson), payload_json: JSON.parse(payloadJson),
        };
        itens.push(row);
        return { rows: [row] };
      }
      if (sql.includes("INSERT INTO central_vendas_componentes")) {
        const [
          importId, pedidoRowId, itemRowId, clienteId, clienteSlug, marketplace, competencia,
          pedidoId, itemId, tipo, valor, fonte, confianca, obs, payloadJson, escopo, efeito, incluidoNoResultado,
        ] = params;
        const row = {
          id: nextComponenteId++, import_id: importId, pedido_row_id: pedidoRowId, item_row_id: itemRowId,
          cliente_id: clienteId, cliente_slug: clienteSlug, marketplace, competencia, pedido_id: pedidoId,
          item_id: itemId, tipo, valor, fonte, confianca, obs, payload_json: JSON.parse(payloadJson),
          escopo, efeito, incluido_no_resultado: incluidoNoResultado,
        };
        componentes.push(row);
        return { rows: [row] };
      }
      if (sql.includes("UPDATE central_vendas_imports") && sql.includes("publication_status = 'published'")) {
        const [syncRunId] = params;
        const afetados = imports.filter((r) => r.sync_run_id === syncRunId && r.publication_status === "candidate");
        for (const row of afetados) { row.publication_status = "published"; row.published_at = new Date().toISOString(); }
        return { rows: afetados.map((r) => ({ id: r.id, competencia: r.competencia })) };
      }
      if (sql.includes("FROM central_vendas_imports") && sql.includes("competencia BETWEEN $3 AND $4")) {
        const [slug, marketplace, compFrom, compTo, contaId] = params;
        const includeLegacyConta = sql.includes("IS NULL");
        let matched = imports.filter((r) =>
          r.cliente_slug === slug && r.marketplace === marketplace &&
          r.competencia >= compFrom && r.competencia <= compTo &&
          (r.publication_status === "published" || r.publication_status === "legacy"));
        if (params.length > 4 && contaId != null) {
          matched = matched.filter((r) => r.cliente_conta_id === contaId || (includeLegacyConta && r.cliente_conta_id == null));
        }
        return { rows: matched };
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
      throw new Error(`makeDb: SQL nao mapeado -> ${sql.slice(0, 160)}`);
    },
  };
}

// Persiste um snapshot completo (import + pedidos + itens + componentes)
// chamando as funções REAIS do repository uma a uma — mesmo fluxo de
// persistCentralVendasImport, sem depender de withTransaction/pool real.
async function persistarSnapshot(db, { marketplace = "meli", competencia, motorPayload, fonte, clienteContaId = null, syncRunId = null, publicationStatus = "legacy", coverageDateFrom = null, coverageDateTo = null }) {
  const importacao = await repository.createImport({
    cliente, marketplace, competencia, resumo: motorPayload.resumo, payload: motorPayload, fonte,
    clienteContaId, syncRunId, publicationStatus, coverageDateFrom, coverageDateTo,
  }, db);

  const pedidoRowsById = new Map();
  for (const pedido of motorPayload.pedidos || []) {
    const row = await repository.insertPedido({ importacao, cliente, marketplace, competencia, pedido }, db);
    pedidoRowsById.set(pedido.pedidoId, row.id);
  }
  const itemRowsById = new Map();
  for (const item of motorPayload.itens || []) {
    const row = await repository.insertItem({ importacao, pedidoRowId: pedidoRowsById.get(item.pedidoId) || null, cliente, marketplace, competencia, item }, db);
    itemRowsById.set(item.itemId, row.id);
  }
  for (const componente of motorPayload.componentes || []) {
    await repository.insertComponente({
      importacao, pedidoRowId: pedidoRowsById.get(componente.pedidoId) || null,
      itemRowId: componente.itemId ? itemRowsById.get(componente.itemId) : null,
      cliente, marketplace, competencia, componente,
    }, db);
  }
  return importacao;
}

function motorPayloadFixture({ pedidoId, mlb, dataPedido, custo, resultado }) {
  const itemId = `${pedidoId}:${mlb}:0`;
  return {
    resumo: { confianca: "confiavel" },
    pedidos: [{
      pedidoId, dataPedido, status: "pago", confianca: "confiavel",
      quantidadeItens: 1, faturamento: 100, lucroContribuicao: resultado, resultado,
      margemContribuicaoPercentual: resultado, pendencias: [],
    }],
    itens: [{
      pedidoId, itemId, mlb, sku: null, titulo: mlb, quantidade: 1, valorUnitario: 100,
      receitaProduto: 100, custoProduto: custo, impostoInterno: 5, lucroContribuicao: resultado,
      resultado, margemContribuicaoPercentual: resultado, confianca: "confiavel", pendencias: [],
    }],
    componentes: [
      { pedidoId, itemId, tipo: "receita_produto", valor: 100, fonte: "orders_api", confianca: "real", obs: null },
      { pedidoId, itemId, tipo: "custo_produto", valor: -custo, fonte: "base_vinculada", confianca: "real", obs: null },
      { pedidoId, itemId, tipo: "imposto_interno", valor: -5, fonte: "base_vinculada", confianca: "real", obs: null },
    ],
  };
}

async function run() {
  // ── Caso F — imutabilidade: snapshot B nunca altera componentes de A ────
  {
    const db = makeDb();
    const payloadA = motorPayloadFixture({ pedidoId: "A1", mlb: "MLB1", dataPedido: "2026-07-10", custo: 40, resultado: 55 });
    const importA = await persistarSnapshot(db, { competencia: "2026-07", motorPayload: payloadA, fonte: "orders_api", publicationStatus: "candidate" });

    const snapshotComponentesA = JSON.parse(JSON.stringify(db.componentes.filter((c) => c.import_id === importA.id)));

    const payloadB = motorPayloadFixture({ pedidoId: "B1", mlb: "MLB2", dataPedido: "2026-07-11", custo: 999, resultado: -500 });
    await persistarSnapshot(db, { competencia: "2026-07", motorPayload: payloadB, fonte: "orders_api", publicationStatus: "candidate" });

    const componentesADepoisDeB = db.componentes.filter((c) => c.import_id === importA.id);
    eq("F: componentes de A permanecem byte-a-byte iguais depois de persistir B", componentesADepoisDeB, snapshotComponentesA);
    ok("F: import B gerou suas próprias linhas, distintas de A", db.componentes.some((c) => c.import_id !== importA.id));
  }

  // ── Caso G — candidate/published não altera o conteúdo financeiro ───────
  {
    const db = makeDb();
    const payload = motorPayloadFixture({ pedidoId: "G1", mlb: "MLB3", dataPedido: "2026-07-10", custo: 30, resultado: 65 });
    const importacao = await persistarSnapshot(db, { competencia: "2026-07", motorPayload: payload, fonte: "orders_api", syncRunId: 55, publicationStatus: "candidate" });
    const antes = JSON.parse(JSON.stringify(db.componentes.filter((c) => c.import_id === importacao.id)));

    await repository.promoverCandidatesDoRun(55, db);

    eq("G: publication_status virou published", db.imports.find((r) => r.id === importacao.id).publication_status, "published");
    const depois = db.componentes.filter((c) => c.import_id === importacao.id);
    eq("G: componentes financeiros inalterados pela publicação", depois, antes);
  }

  // ── Caso H — account scope: conta A nunca lê componentes da conta B ─────
  {
    const db = makeDb();
    const payloadContaA = motorPayloadFixture({ pedidoId: "H_A1", mlb: "MLB4", dataPedido: "2026-08-05", custo: 10, resultado: 20 });
    const payloadContaB = motorPayloadFixture({ pedidoId: "H_B1", mlb: "MLB5", dataPedido: "2026-08-06", custo: 15, resultado: 25 });
    const importContaA = await persistarSnapshot(db, { competencia: "2026-08", motorPayload: payloadContaA, fonte: "orders_api", clienteContaId: 10, publicationStatus: "published", coverageDateFrom: "2026-08-01", coverageDateTo: "2026-08-31" });
    await persistarSnapshot(db, { competencia: "2026-08", motorPayload: payloadContaB, fonte: "orders_api", clienteContaId: 20, publicationStatus: "published", coverageDateFrom: "2026-08-01", coverageDateTo: "2026-08-31" });
    // published_at é exigido pela seleção do repository — grava manualmente (mesmo trick do M4 test).
    db.imports.forEach((r) => { r.published_at = r.published_at || new Date().toISOString(); });

    const snapshotContaA = await repository.getCentralVendasByRange(
      { clienteSlug: cliente.slug, dateFrom: "2026-08-01", dateTo: "2026-08-31", clienteContaId: 10, includeLegacy: false }, db
    );
    ok("H: GET da conta 10 encontrou snapshot", !!snapshotContaA);
    eq("H: GET da conta 10 só ve o import da conta 10", snapshotContaA.importacao.id, importContaA.id);
    ok("H: nenhum componente retornado pertence à conta 20", snapshotContaA.componentes.every((c) => c.import_id === importContaA.id));
    ok("H: componentes da conta 10 têm o pedido H_A1", snapshotContaA.componentes.some((c) => c.pedido_id === "H_A1"));
    ok("H: NENHUM componente da conta 20 (H_B1) vazou", !snapshotContaA.componentes.some((c) => c.pedido_id === "H_B1"));
  }

  // ── Caso J — segurança: nenhum token/credencial é persistido como evidência ──
  {
    const db = makeDb();
    const payload = motorPayloadFixture({ pedidoId: "J1", mlb: "MLB6", dataPedido: "2026-07-10", custo: 10, resultado: 10 });
    await persistarSnapshot(db, { competencia: "2026-07", motorPayload: payload, fonte: "orders_api", publicationStatus: "candidate" });

    const FORBIDDEN = ["access_token", "refresh_token", "authorization", "cookie", "segredo", "credencial", "senha", "password"];
    const ALLOWED_KEYS = new Set(["pedidoId", "itemId", "tipo", "valor", "fonte", "confianca", "obs"]);

    for (const row of db.componentes) {
      const serialized = JSON.stringify(row.payload_json).toLowerCase();
      for (const termo of FORBIDDEN) {
        ok(`J: payload_json do componente ${row.tipo} nao contem "${termo}"`, !serialized.includes(termo));
      }
      const chaves = Object.keys(row.payload_json);
      ok(`J: payload_json do componente ${row.tipo} so tem chaves permitidas (${chaves.join(",")})`, chaves.every((k) => ALLOWED_KEYS.has(k)));
    }
  }

  console.log(`centralVendasLedgerPersistencia.test.js: ${checks} verificacoes OK`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
