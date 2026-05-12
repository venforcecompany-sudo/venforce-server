const pool = require("../config/database");

async function ensureAdsTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_acompanhamentos (
      id           SERIAL PRIMARY KEY,
      cliente_slug TEXT NOT NULL,
      mes_ref      TEXT NOT NULL,
      loja_campanha TEXT NOT NULL DEFAULT 'todas',
      checklist    JSONB NOT NULL DEFAULT '{}'::jsonb,
      feedback_text TEXT,
      created_by   INTEGER NULL,
      updated_by   INTEGER NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_ads_acomp UNIQUE (cliente_slug, mes_ref, loja_campanha)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ads_acomp_cliente_mes
    ON ads_acompanhamentos (cliente_slug, mes_ref)
  `);
}

async function listarClientesAds() {
  const result = await pool.query(`
    SELECT id, nome, slug
    FROM clientes
    WHERE ativo = true
    ORDER BY nome ASC
  `);
  return result.rows;
}

async function buscarAcompanhamentoAds({ clienteSlug, mes, lojaCampanha }) {
  const loja = lojaCampanha || "todas";
  const result = await pool.query(
    `SELECT cliente_slug, mes_ref, loja_campanha, checklist, feedback_text, updated_at
     FROM ads_acompanhamentos
     WHERE cliente_slug = $1 AND mes_ref = $2 AND loja_campanha = $3`,
    [clienteSlug, mes, loja]
  );

  if (!result.rows.length) {
    return {
      clienteSlug,
      mes,
      lojaCampanha: loja,
      checklist: { semana1: {}, semana2: {}, semana3: {}, semana4: {} },
      feedbackText: "",
      updatedAt: null,
    };
  }

  const row = result.rows[0];
  return {
    clienteSlug: row.cliente_slug,
    mes: row.mes_ref,
    lojaCampanha: row.loja_campanha,
    checklist: row.checklist,
    feedbackText: row.feedback_text || "",
    updatedAt: row.updated_at,
  };
}

async function salvarAcompanhamentoAds({ clienteSlug, mes, lojaCampanha, checklist, feedbackText, userId }) {
  const loja = lojaCampanha || "todas";
  const result = await pool.query(
    `INSERT INTO ads_acompanhamentos
       (cliente_slug, mes_ref, loja_campanha, checklist, feedback_text, created_by, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6, NOW())
     ON CONFLICT (cliente_slug, mes_ref, loja_campanha)
     DO UPDATE SET
       checklist     = EXCLUDED.checklist,
       feedback_text = EXCLUDED.feedback_text,
       updated_by    = EXCLUDED.updated_by,
       updated_at    = NOW()
     RETURNING cliente_slug, mes_ref, loja_campanha, checklist, feedback_text, updated_at`,
    [clienteSlug, mes, loja, JSON.stringify(checklist), feedbackText ?? "", userId ?? null]
  );
  const row = result.rows[0];
  return {
    clienteSlug: row.cliente_slug,
    mes: row.mes_ref,
    lojaCampanha: row.loja_campanha,
    checklist: row.checklist,
    feedbackText: row.feedback_text || "",
    updatedAt: row.updated_at,
  };
}

module.exports = {
  ensureAdsTables,
  listarClientesAds,
  buscarAcompanhamentoAds,
  salvarAcompanhamentoAds,
};
