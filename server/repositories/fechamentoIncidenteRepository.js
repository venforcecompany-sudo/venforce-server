// server/repositories/fechamentoIncidenteRepository.js
// Acesso a dados da caixa-preta do fechamento financeiro. Só SQL — a decisão
// de QUANDO criar um incidente mora em fechamentoIncidentStorageService.

const pool = require("../config/database");

async function ensureFechamentoIncidenteTables(db = pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS fechamento_incidentes (
      id SERIAL PRIMARY KEY,
      codigo TEXT,
      cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
      cliente_slug TEXT,
      cliente_conta_id INTEGER REFERENCES cliente_contas(id) ON DELETE SET NULL,
      marketplace TEXT NOT NULL,
      periodo TEXT,
      usuario_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      trigger_tipo TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'aberto',
      resumo_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      diagnostico_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP NOT NULL,
      resolved_at TIMESTAMP
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_fechamento_incidentes_codigo ON fechamento_incidentes (codigo) WHERE codigo IS NOT NULL;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_fechamento_incidentes_expires_at ON fechamento_incidentes (expires_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_fechamento_incidentes_cliente ON fechamento_incidentes (cliente_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_fechamento_incidentes_created_at ON fechamento_incidentes (created_at DESC);`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS fechamento_incidente_arquivos (
      id SERIAL PRIMARY KEY,
      incidente_id INTEGER NOT NULL REFERENCES fechamento_incidentes(id) ON DELETE CASCADE,
      tipo_arquivo TEXT NOT NULL,
      nome_original TEXT NOT NULL,
      mime_type TEXT,
      tamanho_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      conteudo BYTEA,
      conteudo_truncado BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_fechamento_incidente_arquivos_incidente ON fechamento_incidente_arquivos (incidente_id);`);
}

async function createIncidente(
  {
    clienteId = null,
    clienteSlug = null,
    clienteContaId = null,
    marketplace,
    periodo = null,
    usuarioId = null,
    triggerTipo,
    resumo = {},
    diagnostico = {},
    metadata = {},
    expiresInDays,
  },
  db = pool
) {
  const inserted = await db.query(
    `INSERT INTO fechamento_incidentes
      (cliente_id, cliente_slug, cliente_conta_id, marketplace, periodo, usuario_id,
       trigger_tipo, resumo_json, diagnostico_json, metadata_json, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW() + ($11 || ' days')::interval)
     RETURNING id`,
    [
      clienteId, clienteSlug, clienteContaId, marketplace, periodo, usuarioId,
      triggerTipo, JSON.stringify(resumo), JSON.stringify(diagnostico), JSON.stringify(metadata),
      String(expiresInDays),
    ]
  );
  const id = inserted.rows[0].id;
  const codigo = `FIN-${id}`;
  const updated = await db.query(
    `UPDATE fechamento_incidentes SET codigo = $1 WHERE id = $2 RETURNING id, codigo`,
    [codigo, id]
  );
  return updated.rows[0];
}

async function addArquivo(
  incidenteId,
  { tipoArquivo, nomeOriginal, mimeType, tamanhoBytes, sha256, conteudo, conteudoTruncado = false },
  db = pool
) {
  const result = await db.query(
    `INSERT INTO fechamento_incidente_arquivos
      (incidente_id, tipo_arquivo, nome_original, mime_type, tamanho_bytes, sha256, conteudo, conteudo_truncado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [incidenteId, tipoArquivo, nomeOriginal, mimeType, tamanhoBytes, sha256, conteudoTruncado ? null : conteudo, conteudoTruncado]
  );
  return result.rows[0];
}

async function getIncidenteByCodigo(codigo, db = pool) {
  const result = await db.query(
    `SELECT * FROM fechamento_incidentes WHERE codigo = $1 AND expires_at > NOW()`,
    [codigo]
  );
  return result.rows[0] || null;
}

async function listArquivosByIncidenteId(incidenteId, db = pool) {
  const result = await db.query(
    `SELECT id, incidente_id, tipo_arquivo, nome_original, mime_type, tamanho_bytes, sha256, conteudo_truncado, created_at
       FROM fechamento_incidente_arquivos WHERE incidente_id = $1 ORDER BY id ASC`,
    [incidenteId]
  );
  return result.rows;
}

async function getArquivo(incidenteId, arquivoId, db = pool) {
  const result = await db.query(
    `SELECT a.* FROM fechamento_incidente_arquivos a
       JOIN fechamento_incidentes i ON i.id = a.incidente_id
      WHERE a.incidente_id = $1 AND a.id = $2 AND i.expires_at > NOW()`,
    [incidenteId, arquivoId]
  );
  return result.rows[0] || null;
}

async function listIncidentes({ clienteSlug, marketplace, status, limit = 50, offset = 0 } = {}, db = pool) {
  const conditions = ["expires_at > NOW()"];
  const params = [];
  if (clienteSlug) { params.push(clienteSlug); conditions.push(`cliente_slug = $${params.length}`); }
  if (marketplace) { params.push(marketplace); conditions.push(`marketplace = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  params.push(Math.min(Number(limit) || 50, 200));
  params.push(Number(offset) || 0);
  const result = await db.query(
    `SELECT id, codigo, cliente_id, cliente_slug, cliente_conta_id, marketplace, periodo,
            usuario_id, trigger_tipo, status, resumo_json, created_at, expires_at, resolved_at
       FROM fechamento_incidentes
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return result.rows;
}

async function cleanupExpirados(_opts = {}, db = pool) {
  const result = await db.query(`DELETE FROM fechamento_incidentes WHERE expires_at < NOW()`);
  return { incidentesRemovidos: result.rowCount || 0 };
}

module.exports = {
  ensureFechamentoIncidenteTables,
  createIncidente,
  addArquivo,
  getIncidenteByCodigo,
  listArquivosByIncidenteId,
  getArquivo,
  listIncidentes,
  cleanupExpirados,
};
