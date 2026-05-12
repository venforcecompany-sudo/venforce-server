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

// ─── Resumo mensal ────────────────────────────────────────────────────────────

async function ensureAdsResumoTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads_resumos_mensais (
      id                SERIAL PRIMARY KEY,
      cliente_slug      TEXT NOT NULL,
      mes_ref           TEXT NOT NULL,
      loja_campanha     TEXT NOT NULL DEFAULT 'todas',
      investimento_ads  NUMERIC(14,2) NOT NULL DEFAULT 0,
      gmv_ads           NUMERIC(14,2) NOT NULL DEFAULT 0,
      roas              NUMERIC(10,2) NOT NULL DEFAULT 0,
      faturamento_total NUMERIC(14,2) NOT NULL DEFAULT 0,
      cancelados_valor  NUMERIC(14,2) NOT NULL DEFAULT 0,
      cancelados_pct    NUMERIC(10,2) NOT NULL DEFAULT 0,
      devolvidos_valor  NUMERIC(14,2) NOT NULL DEFAULT 0,
      tacos             NUMERIC(10,2) NOT NULL DEFAULT 0,
      created_by        INTEGER NULL,
      updated_by        INTEGER NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_ads_resumo UNIQUE (cliente_slug, mes_ref, loja_campanha)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ads_resumo_cliente_mes
    ON ads_resumos_mensais (cliente_slug, mes_ref)
  `);
}

function calcularStatusTacos(tacos, dados) {
  const semDados =
    dados.investimentoAds === 0 &&
    dados.gmvAds === 0 &&
    dados.roas === 0 &&
    dados.faturamentoTotal === 0 &&
    dados.tacos === 0;
  if (semDados) return "sem_dados";
  if (tacos <= 4) return "saudavel";
  if (tacos <= 5) return "atencao";
  return "critico";
}

function rowToResumo(row) {
  const d = {
    clienteSlug:      row.cliente_slug,
    mes:              row.mes_ref,
    lojaCampanha:     row.loja_campanha,
    investimentoAds:  Number(row.investimento_ads),
    gmvAds:           Number(row.gmv_ads),
    roas:             Number(row.roas),
    faturamentoTotal: Number(row.faturamento_total),
    canceladosValor:  Number(row.cancelados_valor),
    canceladosPct:    Number(row.cancelados_pct),
    devolvidosValor:  Number(row.devolvidos_valor),
    tacos:            Number(row.tacos),
    updatedAt:        row.updated_at,
  };
  d.status = calcularStatusTacos(d.tacos, d);
  return d;
}

async function buscarResumoMensalAds({ clienteSlug, mes, lojaCampanha }) {
  const loja = lojaCampanha || "todas";
  const result = await pool.query(
    `SELECT * FROM ads_resumos_mensais
     WHERE cliente_slug = $1 AND mes_ref = $2 AND loja_campanha = $3`,
    [clienteSlug, mes, loja]
  );
  if (!result.rows.length) {
    return {
      clienteSlug,
      mes,
      lojaCampanha: loja,
      investimentoAds:  0,
      gmvAds:           0,
      roas:             0,
      faturamentoTotal: 0,
      canceladosValor:  0,
      canceladosPct:    0,
      devolvidosValor:  0,
      tacos:            0,
      status:           "sem_dados",
      updatedAt:        null,
    };
  }
  return rowToResumo(result.rows[0]);
}

async function salvarResumoMensalAds({ clienteSlug, mes, lojaCampanha, dados, userId }) {
  const loja = lojaCampanha || "todas";
  const result = await pool.query(
    `INSERT INTO ads_resumos_mensais
       (cliente_slug, mes_ref, loja_campanha,
        investimento_ads, gmv_ads, roas, faturamento_total,
        cancelados_valor, cancelados_pct, devolvidos_valor, tacos,
        created_by, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, NOW())
     ON CONFLICT (cliente_slug, mes_ref, loja_campanha)
     DO UPDATE SET
       investimento_ads  = EXCLUDED.investimento_ads,
       gmv_ads           = EXCLUDED.gmv_ads,
       roas              = EXCLUDED.roas,
       faturamento_total = EXCLUDED.faturamento_total,
       cancelados_valor  = EXCLUDED.cancelados_valor,
       cancelados_pct    = EXCLUDED.cancelados_pct,
       devolvidos_valor  = EXCLUDED.devolvidos_valor,
       tacos             = EXCLUDED.tacos,
       updated_by        = EXCLUDED.updated_by,
       updated_at        = NOW()
     RETURNING *`,
    [
      clienteSlug, mes, loja,
      dados.investimentoAds, dados.gmvAds, dados.roas, dados.faturamentoTotal,
      dados.canceladosValor, dados.canceladosPct, dados.devolvidosValor, dados.tacos,
      userId ?? null,
    ]
  );
  return rowToResumo(result.rows[0]);
}

module.exports = {
  ensureAdsTables,
  listarClientesAds,
  buscarAcompanhamentoAds,
  salvarAcompanhamentoAds,
  ensureAdsResumoTables,
  calcularStatusTacos,
  buscarResumoMensalAds,
  salvarResumoMensalAds,
};
