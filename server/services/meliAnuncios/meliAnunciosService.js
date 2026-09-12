// server/services/meliAnuncios/meliAnunciosService.js
// -----------------------------------------------------------------------------
// Módulo: Anúncios Meli — Central operacional de anúncios por cliente.
// Camada de banco de dados (PostgreSQL).
//
// Responsável por:
//  - garantir o schema da tabela meli_anuncios (idempotente);
//  - resolver clientes e ml_user_id reaproveitando as tabelas existentes;
//  - listar / paginar / filtrar anúncios já sincronizados no banco;
//  - gerar o resumo (cards do HUD);
//  - fazer upsert dos anúncios vindos da sincronização.
//
// NÃO mexe em OAuth, refresh de token ou em qualquer tabela existente.
// Apenas LÊ clientes / ml_tokens e LÊ/ESCREVE em meli_anuncios.
// -----------------------------------------------------------------------------

// O config/database exporta o pool PG. Importado de forma defensiva caso o
// módulo exporte { pool } em vez do pool direto.
const _dbModule = require("../../config/database");
const db =
  _dbModule && typeof _dbModule.query === "function"
    ? _dbModule
    : _dbModule.pool || _dbModule.default || _dbModule;
const { resolveMarketplaceAccountContext } = require("../clienteContas/clienteContaService");

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
let _schemaPronto = false;

async function ensureSchema() {
  if (_schemaPronto) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS meli_anuncios (
      id              SERIAL PRIMARY KEY,
      cliente_id      INTEGER NOT NULL,
      cliente_slug    TEXT NOT NULL,
      item_id         TEXT NOT NULL,
      sku             TEXT,
      titulo          TEXT,
      marca           TEXT,
      modelo          TEXT,
      preco           NUMERIC,
      preco_original  NUMERIC,
      moeda           TEXT,
      estoque         INTEGER,
      vendidos        INTEGER,
      status          TEXT,
      sub_status      TEXT,
      listing_type_id TEXT,
      category_id     TEXT,
      permalink       TEXT,
      thumbnail       TEXT,
      pictures_count  INTEGER DEFAULT 0,
      pictures_json   JSONB,
      logistic_type   TEXT,
      is_full         BOOLEAN DEFAULT false,
      attributes_json JSONB,
      health          NUMERIC,
      score_venforce  INTEGER,
      score_motivo    TEXT,
      revisado        BOOLEAN DEFAULT false,
      last_synced_at  TIMESTAMPTZ DEFAULT NOW(),
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (cliente_id, item_id)
    );
  `);

  // cliente_conta_id/ml_user_id: identificam de qual conta ML (Cliente/Conta)
  // veio cada anúncio. Nullable — linhas sincronizadas antes desta coluna
  // existir ficam NULL (nunca inferidas por adivinhação); uma ressincronização
  // subsequente já corrige a linha com o valor real.
  await db.query(`
    ALTER TABLE meli_anuncios
      ADD COLUMN IF NOT EXISTS cliente_conta_id INTEGER,
      ADD COLUMN IF NOT EXISTS ml_user_id TEXT;
  `);

  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_meli_anuncios_cliente ON meli_anuncios (cliente_id);`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_meli_anuncios_status ON meli_anuncios (cliente_id, status);`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_meli_anuncios_score ON meli_anuncios (cliente_id, score_venforce);`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_meli_anuncios_conta ON meli_anuncios (cliente_conta_id);`
  );

  _schemaPronto = true;
}

// -----------------------------------------------------------------------------
// Clientes / tokens (reaproveita tabelas existentes)
// -----------------------------------------------------------------------------

// Lista clientes ativos com flag de ML conectado e total já sincronizado.
async function listarClientes() {
  await ensureSchema();

  const { rows } = await db.query(`
    SELECT
      c.*,
      EXISTS (
        SELECT 1 FROM ml_tokens t WHERE t.cliente_id = c.id
      ) AS ml_conectado,
      (
        SELECT COUNT(*)::int FROM meli_anuncios m WHERE m.cliente_id = c.id
      ) AS total_anuncios
    FROM clientes c
    WHERE c.ativo = true
    ORDER BY c.slug ASC;
  `);

  return rows.map((c) => ({
    id: c.id,
    slug: c.slug,
    nome: c.nome || c.name || c.razao_social || c.slug,
    mlConectado: !!c.ml_conectado,
    totalAnuncios: c.total_anuncios || 0,
  }));
}

// Resolve um cliente pelo slug. Retorna { id, slug, nome } ou null.
async function resolverCliente(clienteSlug) {
  if (!clienteSlug) return null;
  const slug = String(clienteSlug).trim().toLowerCase();

  const { rows } = await db.query(
    `SELECT * FROM clientes WHERE LOWER(slug) = $1 LIMIT 1;`,
    [slug]
  );
  if (!rows.length) return null;

  const c = rows[0];
  return {
    id: c.id,
    slug: c.slug,
    nome: c.nome || c.name || c.razao_social || c.slug,
  };
}

// Resolve a conta ML exata do cliente (Cliente/Conta/Grant). Nunca escolhe
// "a conta principal" em silêncio: com 2+ contas ML ativas sem clienteContaId
// explícito, propaga o erro estrutural (err.statusCode=409,
// err.code='MULTIPLE_MARKETPLACE_ACCOUNTS', err.contas) para o chamador.
//
// includeLegacy só é true quando a conta resolvida é comprovadamente a única
// ativa do marketplace — assim linhas históricas (cliente_conta_id IS NULL)
// continuam aparecendo quando não há ambiguidade real, e somem só quando há
// 2+ contas e uma foi escolhida.
async function resolverContextoConta({ clienteId, clienteContaId = null, requireUsableGrant = true }) {
  const context = await resolveMarketplaceAccountContext({
    clienteId,
    marketplace: "meli",
    clienteContaId: clienteContaId || null,
    requireUsableGrant,
    queryable: db,
  });

  const contaId = context.conta?.id ?? null;
  let includeLegacy = true;
  if (contaId) {
    const totalAtivas = await db.query(
      "SELECT COUNT(*)::int AS total FROM cliente_contas WHERE cliente_id = $1 AND marketplace = 'meli' AND ativo = true",
      [clienteId]
    );
    includeLegacy = (totalAtivas.rows[0]?.total || 0) <= 1;
  }

  return {
    mlUserId: context.mlUserId || null,
    contaId,
    contaNome: context.conta?.nome ?? null,
    includeLegacy,
  };
}

// -----------------------------------------------------------------------------
// Catálogo
// -----------------------------------------------------------------------------

// Conjunto de item_ids já gravados para um cliente (usado no modo "novos").
async function itemIdsExistentes(clienteId) {
  const { rows } = await db.query(
    `SELECT item_id FROM meli_anuncios WHERE cliente_id = $1;`,
    [clienteId]
  );
  return new Set(rows.map((r) => String(r.item_id)));
}

// Listagem paginada com filtros. Filtros possíveis em `filtro`:
//   sem_fotos | score_baixo | sem_sku | ficha_incompleta | pausados |
//   score_muito_bom | score_medio | mercado_full
// (os três últimos foram adicionados junto com os cards de KPI clicáveis
// da listagem — mesmos limiares 60/80 já usados em scoreClasse() no front.)
async function listarAnuncios({
  clienteId,
  clienteContaId = null,
  includeLegacy = true,
  q = "",
  status = "",
  filtro = "",
  page = 1,
  limit = 24,
}) {
  await ensureSchema();

  const where = ["cliente_id = $1"];
  const params = [clienteId];
  let i = 2;

  if (clienteContaId != null) {
    where.push(includeLegacy
      ? `(cliente_conta_id = $${i} OR cliente_conta_id IS NULL)`
      : `cliente_conta_id = $${i}`);
    params.push(clienteContaId);
    i++;
  }

  const termo = String(q || "").trim();
  if (termo) {
    where.push(`(titulo ILIKE $${i} OR item_id ILIKE $${i} OR sku ILIKE $${i})`);
    params.push(`%${termo}%`);
    i++;
  }

  if (status) {
    where.push(`status = $${i}`);
    params.push(status);
    i++;
  }

  switch (filtro) {
    case "sem_fotos":
      where.push(`COALESCE(pictures_count, 0) < 3`);
      break;
    case "score_baixo":
      where.push(`COALESCE(score_venforce, 0) < 60`);
      break;
    case "sem_sku":
      where.push(`(sku IS NULL OR sku = '')`);
      break;
    case "ficha_incompleta":
      where.push(`(score_motivo = 'Ficha técnica incompleta')`);
      break;
    case "pausados":
      where.push(`status = 'paused'`);
      break;
    case "score_muito_bom":
      where.push(`COALESCE(score_venforce, 0) >= 80`);
      break;
    case "score_medio":
      where.push(`COALESCE(score_venforce, 0) >= 60 AND COALESCE(score_venforce, 0) < 80`);
      break;
    case "mercado_full":
      where.push(`is_full = true`);
      break;
    default:
      break;
  }

  const whereSql = where.join(" AND ");

  const totalRes = await db.query(
    `SELECT COUNT(*)::int AS total FROM meli_anuncios WHERE ${whereSql};`,
    params
  );
  const total = totalRes.rows[0] ? totalRes.rows[0].total : 0;

  const lim = Math.min(Math.max(parseInt(limit, 10) || 24, 1), 100);
  const pag = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (pag - 1) * lim;

  const dataParams = params.slice();
  dataParams.push(lim, offset);

  const { rows } = await db.query(
    `SELECT
        item_id, sku, titulo, marca, modelo, preco, preco_original, moeda,
        estoque, vendidos, status, sub_status, listing_type_id, category_id,
        permalink, thumbnail, pictures_count, logistic_type, is_full,
        health, score_venforce, score_motivo, revisado, last_synced_at
       FROM meli_anuncios
       WHERE ${whereSql}
       ORDER BY revisado ASC, score_venforce ASC NULLS FIRST, updated_at DESC
       LIMIT $${i} OFFSET $${i + 1};`,
    dataParams
  );

  return {
    anuncios: rows,
    paginacao: {
      page: pag,
      limit: lim,
      total,
      totalPaginas: Math.max(Math.ceil(total / lim), 1),
    },
  };
}

// Resumo agregado para os cards do HUD.
async function obterResumo(clienteId, clienteContaId = null, includeLegacy = true) {
  await ensureSchema();

  const where = ["cliente_id = $1"];
  const params = [clienteId];
  if (clienteContaId != null) {
    where.push(includeLegacy
      ? `(cliente_conta_id = $2 OR cliente_conta_id IS NULL)`
      : `cliente_conta_id = $2`);
    params.push(clienteContaId);
  }
  const whereSql = where.join(" AND ");

  const { rows } = await db.query(
    `SELECT
        COUNT(*)::int                                                  AS total,
        COUNT(*) FILTER (WHERE status = 'active')::int                 AS ativos,
        COUNT(*) FILTER (WHERE status = 'paused')::int                 AS pausados,
        COUNT(*) FILTER (WHERE status = 'closed')::int                 AS encerrados,
        COUNT(*) FILTER (WHERE COALESCE(pictures_count,0) < 3)::int     AS fotos_insuficientes,
        COUNT(*) FILTER (WHERE sku IS NULL OR sku = '')::int            AS sem_sku,
        COUNT(*) FILTER (WHERE COALESCE(score_venforce,0) < 60)::int    AS score_baixo,
        COUNT(*) FILTER (WHERE COALESCE(score_venforce,0) >= 80)::int   AS score_muito_bom,
        COUNT(*) FILTER (WHERE is_full = true)::int                     AS full,
        ROUND(AVG(score_venforce))::int                                AS score_medio,
        MAX(last_synced_at)                                            AS ultima_sync
       FROM meli_anuncios
       WHERE ${whereSql};`,
    params
  );

  const r = rows[0] || {};
  return {
    total: r.total || 0,
    ativos: r.ativos || 0,
    pausados: r.pausados || 0,
    encerrados: r.encerrados || 0,
    fotosInsuficientes: r.fotos_insuficientes || 0,
    semSku: r.sem_sku || 0,
    scoreBaixo: r.score_baixo || 0,
    scoreMuitoBom: r.score_muito_bom || 0,
    full: r.full || 0,
    scoreMedio: r.score_medio || 0,
    ultimaSync: r.ultima_sync || null,
  };
}

// Detalhe de um anúncio específico já gravado.
async function obterAnuncio(clienteId, itemId) {
  await ensureSchema();
  const { rows } = await db.query(
    `SELECT * FROM meli_anuncios WHERE cliente_id = $1 AND item_id = $2 LIMIT 1;`,
    [clienteId, String(itemId)]
  );
  return rows.length ? rows[0] : null;
}

// Marca/desmarca um anúncio como revisado.
async function marcarRevisado(clienteId, itemId, revisado) {
  await ensureSchema();
  await db.query(
    `UPDATE meli_anuncios
        SET revisado = $3, updated_at = NOW()
      WHERE cliente_id = $1 AND item_id = $2;`,
    [clienteId, String(itemId), !!revisado]
  );
}

// -----------------------------------------------------------------------------
// Upsert (chamado pela sincronização)
// -----------------------------------------------------------------------------
async function upsertAnuncios(registros) {
  if (!Array.isArray(registros) || registros.length === 0) return 0;
  await ensureSchema();

  const sql = `
    INSERT INTO meli_anuncios (
      cliente_id, cliente_slug, item_id, sku, titulo, marca, modelo,
      preco, preco_original, moeda, estoque, vendidos, status, sub_status,
      listing_type_id, category_id, permalink, thumbnail, pictures_count,
      pictures_json, logistic_type, is_full, attributes_json, health,
      score_venforce, score_motivo, cliente_conta_id, ml_user_id,
      last_synced_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13, $14,
      $15, $16, $17, $18, $19,
      $20, $21, $22, $23, $24,
      $25, $26, $27, $28,
      NOW(), NOW()
    )
    ON CONFLICT (cliente_id, item_id) DO UPDATE SET
      sku             = EXCLUDED.sku,
      titulo          = EXCLUDED.titulo,
      marca           = EXCLUDED.marca,
      modelo          = EXCLUDED.modelo,
      preco           = EXCLUDED.preco,
      preco_original  = EXCLUDED.preco_original,
      moeda           = EXCLUDED.moeda,
      estoque         = EXCLUDED.estoque,
      vendidos        = EXCLUDED.vendidos,
      status          = EXCLUDED.status,
      sub_status      = EXCLUDED.sub_status,
      listing_type_id = EXCLUDED.listing_type_id,
      category_id     = EXCLUDED.category_id,
      permalink       = EXCLUDED.permalink,
      thumbnail       = EXCLUDED.thumbnail,
      pictures_count  = EXCLUDED.pictures_count,
      pictures_json   = EXCLUDED.pictures_json,
      logistic_type   = EXCLUDED.logistic_type,
      is_full         = EXCLUDED.is_full,
      attributes_json = EXCLUDED.attributes_json,
      health          = EXCLUDED.health,
      score_venforce  = EXCLUDED.score_venforce,
      score_motivo    = EXCLUDED.score_motivo,
      cliente_conta_id = EXCLUDED.cliente_conta_id,
      ml_user_id      = EXCLUDED.ml_user_id,
      last_synced_at  = NOW(),
      updated_at      = NOW();
  `;

  let salvos = 0;
  for (const r of registros) {
    await db.query(sql, [
      r.cliente_id,
      r.cliente_slug,
      r.item_id,
      r.sku,
      r.titulo,
      r.marca,
      r.modelo,
      r.preco,
      r.preco_original,
      r.moeda,
      r.estoque,
      r.vendidos,
      r.status,
      r.sub_status,
      r.listing_type_id,
      r.category_id,
      r.permalink,
      r.thumbnail,
      r.pictures_count,
      JSON.stringify(r.pictures_json || []),
      r.logistic_type,
      r.is_full,
      JSON.stringify(r.attributes_json || []),
      r.health,
      r.score_venforce,
      r.score_motivo,
      r.cliente_conta_id ?? null,
      r.ml_user_id != null ? String(r.ml_user_id) : null,
    ]);
    salvos++;
  }
  return salvos;
}

module.exports = {
  ensureSchema,
  listarClientes,
  resolverCliente,
  resolverContextoConta,
  itemIdsExistentes,
  listarAnuncios,
  obterResumo,
  obterAnuncio,
  marcarRevisado,
  upsertAnuncios,
};
