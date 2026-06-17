const fs = require("fs");
const path = require("path");
const pool = require("../../config/database");

const schemaPath = path.join(__dirname, "..", "..", "sql", "central_vendas_schema.sql");

function asJson(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function asDate(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function normalizeSlug(slug) {
  return String(slug || "").trim().toLowerCase();
}

async function ensureCentralVendasTables(db = pool) {
  const sql = fs.readFileSync(schemaPath, "utf8");
  await db.query(sql);
}

async function getClienteBySlug(clienteSlug, db = pool) {
  const slug = normalizeSlug(clienteSlug);
  const result = await db.query(
    `SELECT id, nome, slug
       FROM clientes
      WHERE slug = $1
        AND ativo = true
      LIMIT 1`,
    [slug]
  );
  return result.rows[0] || null;
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function createImport({ cliente, marketplace, competencia, resumo, payload, fonte, status }, db) {
  const result = await db.query(
    `INSERT INTO central_vendas_imports
      (cliente_id, cliente_slug, marketplace, competencia, fonte, status, confianca, resumo_json, payload_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
     RETURNING id, cliente_id, cliente_slug, marketplace, competencia, fonte, status, confianca,
               resumo_json, payload_json, created_at, updated_at`,
    [
      cliente.id,
      cliente.slug,
      marketplace,
      competencia,
      fonte || "planilha_vendas",
      status || "processado",
      resumo?.confianca || null,
      asJson(resumo, {}),
      asJson(payload, {}),
    ]
  );
  return result.rows[0];
}

async function insertPedido({ importacao, cliente, marketplace, competencia, pedido }, db) {
  const result = await db.query(
    `INSERT INTO central_vendas_pedidos
      (import_id, cliente_id, cliente_slug, marketplace, competencia, pedido_id, pack_id, shipment_id,
       data_pedido, status, confianca, quantidade_itens, faturamento, lucro_contribuicao, resultado,
       margem_contribuicao_percentual, pendencias_json, payload_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb)
     RETURNING id, pedido_id`,
    [
      importacao.id,
      cliente.id,
      cliente.slug,
      marketplace,
      competencia,
      pedido.pedidoId,
      pedido.packId || null,
      pedido.shipmentId || null,
      asDate(pedido.dataPedido),
      pedido.status || null,
      pedido.confianca,
      pedido.quantidadeItens ?? null,
      pedido.faturamento ?? null,
      pedido.lucroContribuicao ?? null,
      pedido.resultado ?? null,
      pedido.margemContribuicaoPercentual ?? null,
      asJson(pedido.pendencias, []),
      asJson(pedido, {}),
    ]
  );
  return result.rows[0];
}

async function insertItem({ importacao, pedidoRowId, cliente, marketplace, competencia, item }, db) {
  const result = await db.query(
    `INSERT INTO central_vendas_pedido_itens
      (import_id, pedido_row_id, cliente_id, cliente_slug, marketplace, competencia, pedido_id,
       item_id, mlb, sku, titulo, quantidade, valor_unitario, receita_produto, custo_produto,
       imposto_interno, lucro_contribuicao, resultado, margem_contribuicao_percentual,
       confianca, pendencias_json, payload_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22::jsonb)
     RETURNING id, item_id`,
    [
      importacao.id,
      pedidoRowId,
      cliente.id,
      cliente.slug,
      marketplace,
      competencia,
      item.pedidoId,
      item.itemId,
      item.mlb || null,
      item.sku || null,
      item.titulo || null,
      item.quantidade ?? null,
      item.valorUnitario ?? null,
      item.receitaProduto ?? null,
      item.custoProduto ?? null,
      item.impostoInterno ?? null,
      item.lucroContribuicao ?? null,
      item.resultado ?? null,
      item.margemContribuicaoPercentual ?? null,
      item.confianca,
      asJson(item.pendencias, []),
      asJson(item, {}),
    ]
  );
  return result.rows[0];
}

async function insertComponente({
  importacao,
  pedidoRowId,
  itemRowId,
  cliente,
  marketplace,
  competencia,
  componente,
}, db) {
  const result = await db.query(
    `INSERT INTO central_vendas_componentes
      (import_id, pedido_row_id, item_row_id, cliente_id, cliente_slug, marketplace, competencia,
       pedido_id, item_id, tipo, valor, fonte, confianca, obs, payload_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
     RETURNING id`,
    [
      importacao.id,
      pedidoRowId,
      itemRowId || null,
      cliente.id,
      cliente.slug,
      marketplace,
      competencia,
      componente.pedidoId,
      componente.itemId || null,
      componente.tipo,
      componente.valor ?? null,
      componente.fonte || null,
      componente.confianca,
      componente.obs || null,
      asJson(componente, {}),
    ]
  );
  return result.rows[0];
}

async function persistCentralVendasImport({ cliente, marketplace, competencia, motorPayload, resumo }) {
  return withTransaction(async (db) => {
    const importacao = await createImport({
      cliente,
      marketplace,
      competencia,
      resumo,
      payload: motorPayload,
    }, db);

    const pedidoRowsById = new Map();
    for (const pedido of motorPayload.pedidos || []) {
      const pedidoRow = await insertPedido({ importacao, cliente, marketplace, competencia, pedido }, db);
      pedidoRowsById.set(pedido.pedidoId, pedidoRow.id);
    }

    const itemRowsById = new Map();
    for (const item of motorPayload.itens || []) {
      const pedidoRowId = pedidoRowsById.get(item.pedidoId) || null;
      const itemRow = await insertItem({
        importacao,
        pedidoRowId,
        cliente,
        marketplace,
        competencia,
        item,
      }, db);
      itemRowsById.set(item.itemId, itemRow.id);
    }

    for (const componente of motorPayload.componentes || []) {
      await insertComponente({
        importacao,
        pedidoRowId: pedidoRowsById.get(componente.pedidoId) || null,
        itemRowId: componente.itemId ? itemRowsById.get(componente.itemId) : null,
        cliente,
        marketplace,
        competencia,
        componente,
      }, db);
    }

    return {
      importacao,
      pedidosPersistidos: pedidoRowsById.size,
      itensPersistidos: itemRowsById.size,
      componentesPersistidos: (motorPayload.componentes || []).length,
    };
  });
}

async function getLatestCentralVendasImport({ clienteSlug, competencia, marketplace = "meli" }, db = pool) {
  const importResult = await db.query(
    `SELECT id, cliente_id, cliente_slug, marketplace, competencia, fonte, status, confianca,
            resumo_json, payload_json, created_at, updated_at
       FROM central_vendas_imports
      WHERE cliente_slug = $1
        AND competencia = $2
        AND marketplace = $3
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [normalizeSlug(clienteSlug), competencia, marketplace]
  );

  const importacao = importResult.rows[0];
  if (!importacao) return null;

  const [pedidosResult, itensResult, componentesResult] = await Promise.all([
    db.query(
      `SELECT *
         FROM central_vendas_pedidos
        WHERE import_id = $1
        ORDER BY data_pedido ASC NULLS LAST, pedido_id ASC, id ASC`,
      [importacao.id]
    ),
    db.query(
      `SELECT *
         FROM central_vendas_pedido_itens
        WHERE import_id = $1
        ORDER BY pedido_id ASC, id ASC`,
      [importacao.id]
    ),
    db.query(
      `SELECT *
         FROM central_vendas_componentes
        WHERE import_id = $1
        ORDER BY pedido_id ASC, item_id ASC NULLS LAST, id ASC`,
      [importacao.id]
    ),
  ]);

  return {
    importacao,
    pedidos: pedidosResult.rows,
    itens: itensResult.rows,
    componentes: componentesResult.rows,
  };
}

module.exports = {
  ensureCentralVendasTables,
  getClienteBySlug,
  persistCentralVendasImport,
  getLatestCentralVendasImport,
};
