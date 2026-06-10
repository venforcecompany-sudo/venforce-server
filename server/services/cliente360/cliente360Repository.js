// server/services/cliente360/cliente360Repository.js
// Camada de dados do Cliente 360. TODO o SQL vive aqui, sempre parametrizado.
// Nunca seleciona access_token, refresh_token nem api_key.

const fs = require("fs");
const path = require("path");
const pool = require("../../config/database");

let _schemaGarantido = false;

// Cria as tabelas do Cliente 360 (idempotente). Roda só uma vez por processo.
async function ensureCliente360Tables() {
  if (_schemaGarantido) return;
  const sqlPath = path.join(__dirname, "..", "..", "sql", "cliente360_schema.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await pool.query(sql);
  _schemaGarantido = true;
}

// ─── Cliente / setup ────────────────────────────────────────────────────

async function findClienteBySlug(slug) {
  const { rows } = await pool.query(
    `SELECT id, nome, slug, ativo, created_at
       FROM clientes
      WHERE slug = $1 AND ativo = true
      LIMIT 1`,
    [slug]
  );
  return rows[0] || null;
}

// Lista todos os clientes ativos (base para a lista operacional).
async function findClientesAtivos() {
  const { rows } = await pool.query(
    `SELECT id, nome, slug, ativo
       FROM clientes
      WHERE ativo = true
      ORDER BY nome ASC`
  );
  return rows;
}

async function findBasesVinculadasByCliente(clienteId) {
  const { rows } = await pool.query(
    `SELECT b.id, b.slug, b.nome, b.ativo, b.updated_at,
            v.marketplace, v.origem, v.updated_at AS vinculo_em
       FROM base_cliente_vinculos v
       JOIN bases b ON b.id = v.base_id
      WHERE v.cliente_id = $1
        AND v.ativo = true
        AND b.ativo = true
      ORDER BY v.updated_at DESC`,
    [clienteId]
  );
  return rows;
}

// Grant ML mascarável: NUNCA seleciona access_token/refresh_token.
async function findMlGrantByCliente(clienteId) {
  const { rows } = await pool.query(
    `SELECT ml_user_id, expires_at, token_status, updated_at
       FROM ml_tokens
      WHERE cliente_id = $1
      ORDER BY updated_at DESC
      LIMIT 1`,
    [clienteId]
  );
  return rows[0] || null;
}

// Mapa cliente_id → grant resumido (para a lista operacional, sem N+1).
async function findGrantsResumo() {
  const { rows } = await pool.query(
    `SELECT cliente_id, ml_user_id, expires_at, token_status
       FROM ml_tokens
      WHERE cliente_id IS NOT NULL`
  );
  return rows;
}

// cliente_ids que têm pelo menos uma base ativa vinculada (lista operacional).
async function findClienteIdsComBase() {
  const { rows } = await pool.query(
    `SELECT DISTINCT v.cliente_id
       FROM base_cliente_vinculos v
       JOIN bases b ON b.id = v.base_id
      WHERE v.ativo = true AND b.ativo = true AND v.cliente_id IS NOT NULL`
  );
  return rows.map((r) => r.cliente_id);
}

// Mapa cliente_id → sincronizado_em para uma competência (lista operacional).
async function findSincronizacoesPorCompetencia(competencia) {
  const { rows } = await pool.query(
    `SELECT cliente_id, sincronizado_em
       FROM cliente_360_resumos_mensais
      WHERE competencia = $1`,
    [competencia]
  );
  return rows;
}

// ─── Relatórios / diagnóstico legado ──────────────────────────────────────

async function findRelatoriosByCliente(clienteSlug, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 20;
  const { rows } = await pool.query(
    `SELECT id, cliente_slug, base_slug, escopo, status,
            total_itens, itens_com_base, itens_sem_base,
            itens_criticos, itens_atencao, itens_saudaveis,
            mc_media, margem_alvo, created_at
       FROM relatorios
      WHERE cliente_slug = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [clienteSlug, limit]
  );
  return rows;
}

async function findRelatorioItensResumo(relatorioId) {
  const { rows } = await pool.query(
    `SELECT id, item_id, sku, tem_base, mc, diagnostico, acao_recomendada
       FROM relatorio_itens
      WHERE relatorio_id = $1`,
    [relatorioId]
  );
  return rows;
}

// ─── Entregas / fechamentos ───────────────────────────────────────────────

async function findEntregasByCliente(clienteId, clienteSlug, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : 50;
  const { rows } = await pool.query(
    `SELECT id, tipo, titulo, periodo, status, token_publico, publicado, created_at
       FROM entregas_cliente
      WHERE (cliente_id = $1 OR cliente_slug = $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [clienteId, clienteSlug, limit]
  );
  return rows;
}

// ─── Ads ──────────────────────────────────────────────────────────────────

async function findAdsResumoByCliente(clienteSlug, competencia) {
  const { rows } = await pool.query(
    `SELECT cliente_slug, mes_ref, loja_campanha,
            investimento_ads, gmv_ads, roas,
            faturamento_total, tacos, updated_at
       FROM ads_resumos_mensais
      WHERE cliente_slug = $1 AND mes_ref = $2 AND loja_campanha = 'todas'
      LIMIT 1`,
    [clienteSlug, competencia]
  ).catch(() => ({ rows: [] })); // tabela pode não existir antes do 1º uso do módulo Ads
  return rows[0] || null;
}

// Ads mais recente do cliente (qualquer mês). Usado como referência quando
// o mês atual ainda não tem linha em ads_resumos_mensais.
async function findUltimoAdsResumoByCliente(clienteSlug) {
  const { rows } = await pool.query(
    `SELECT cliente_slug, mes_ref, loja_campanha,
            investimento_ads, gmv_ads, roas,
            faturamento_total, tacos, updated_at
       FROM ads_resumos_mensais
      WHERE cliente_slug = $1 AND loja_campanha = 'todas'
      ORDER BY mes_ref DESC
      LIMIT 1`,
    [clienteSlug]
  ).catch(() => ({ rows: [] }));
  return rows[0] || null;
}

// ─── Snapshot mensal (cliente_360_resumos_mensais) ────────────────────────

async function findResumoMensal(clienteId, competencia) {
  const { rows } = await pool.query(
    `SELECT * FROM cliente_360_resumos_mensais
      WHERE cliente_id = $1 AND competencia = $2
      LIMIT 1`,
    [clienteId, competencia]
  );
  return rows[0] || null;
}

async function upsertResumoMensal(p) {
  const { rows } = await pool.query(
    `INSERT INTO cliente_360_resumos_mensais
       (cliente_id, cliente_slug, competencia,
        faturamento, mc_media, pedidos, cancelados, problemas,
        ads_investido, tacos, fechamentos_count, diagnosticos_count,
        itens_sem_custo, itens_criticos, frete_confianca,
        payload_json, sincronizado_em, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW())
     ON CONFLICT (cliente_id, competencia) DO UPDATE SET
       faturamento        = EXCLUDED.faturamento,
       mc_media           = EXCLUDED.mc_media,
       pedidos            = EXCLUDED.pedidos,
       cancelados         = EXCLUDED.cancelados,
       problemas          = EXCLUDED.problemas,
       ads_investido      = EXCLUDED.ads_investido,
       tacos              = EXCLUDED.tacos,
       fechamentos_count  = EXCLUDED.fechamentos_count,
       diagnosticos_count = EXCLUDED.diagnosticos_count,
       itens_sem_custo    = EXCLUDED.itens_sem_custo,
       itens_criticos     = EXCLUDED.itens_criticos,
       frete_confianca    = EXCLUDED.frete_confianca,
       payload_json       = EXCLUDED.payload_json,
       sincronizado_em    = NOW(),
       updated_at         = NOW()
     RETURNING *`,
    [
      p.clienteId, p.clienteSlug, p.competencia,
      p.faturamento, p.mcMedia, p.pedidos, p.cancelados, p.problemas,
      p.adsInvestido, p.tacos, p.fechamentosCount ?? 0, p.diagnosticosCount ?? 0,
      p.itensSemCusto, p.itensCriticos, p.freteConfianca,
      JSON.stringify(p.payloadJson || {}),
    ]
  );
  return rows[0];
}

// ─── Diagnóstico automático persistido ────────────────────────────────────

async function insertDiagnostico(p) {
  const { rows } = await pool.query(
    `INSERT INTO cliente_360_diagnosticos
       (cliente_id, cliente_slug, competencia, score_saude, status, resumo, payload_json, gerado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, created_at`,
    [
      p.clienteId, p.clienteSlug, p.competencia,
      p.scoreSaude, p.status || "gerado", p.resumo || null,
      JSON.stringify(p.payloadJson || {}), p.geradoPor || null,
    ]
  );
  return rows[0];
}

async function insertDiagnosticoItens(diagnosticoId, itens) {
  if (!Array.isArray(itens) || !itens.length) return;
  const values = [];
  const params = [];
  let i = 1;
  for (const it of itens) {
    values.push(`($${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`);
    params.push(
      diagnosticoId, it.tipo, it.severidade, it.titulo,
      it.descricao || null, it.fonte || null,
      it.acaoRecomendada || null, it.impactoEstimado || null,
      JSON.stringify(it.payloadJson || {})
    );
  }
  await pool.query(
    `INSERT INTO cliente_360_diagnostico_itens
       (diagnostico_id, tipo, severidade, titulo, descricao, fonte, acao_recomendada, impacto_estimado, payload_json)
     VALUES ${values.join(",")}`,
    params
  );
}

async function findDiagnosticos(clienteSlug, limit = 10) {
  const { rows } = await pool.query(
    `SELECT id, competencia, score_saude, status, resumo, created_at
       FROM cliente_360_diagnosticos
      WHERE cliente_slug = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [clienteSlug, limit]
  );
  return rows;
}

async function countDiagnosticos(clienteSlug, competencia) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS total
       FROM cliente_360_diagnosticos
      WHERE cliente_slug = $1 AND competencia = $2`,
    [clienteSlug, competencia]
  );
  return rows[0]?.total || 0;
}

// ─── Frete histórico ──────────────────────────────────────────────────────

async function findFreteHistorico(clienteSlug, competencia) {
  const { rows } = await pool.query(
    `SELECT * FROM cliente_360_frete_historico
      WHERE cliente_slug = $1 AND competencia = $2
      ORDER BY created_at DESC`,
    [clienteSlug, competencia]
  );
  return rows;
}

// ─── Lock de sincronização (cliente_360_sync_jobs) ────────────────────────

// Cria um job 'running' se não houver outro 'running' para (cliente, competência).
// Retorna { job } ou { conflito: jobExistente }.
async function lockSyncJob(clienteId, clienteSlug, competencia, tipo, userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existente = await client.query(
      `SELECT id, iniciado_em
         FROM cliente_360_sync_jobs
        WHERE cliente_id = $1 AND competencia = $2 AND status = 'running'
        FOR UPDATE`,
      [clienteId, competencia]
    );
    if (existente.rows.length) {
      await client.query("ROLLBACK");
      return { conflito: existente.rows[0] };
    }
    const job = await client.query(
      `INSERT INTO cliente_360_sync_jobs
         (cliente_id, cliente_slug, competencia, status, tipo, iniciado_por)
       VALUES ($1,$2,$3,'running',$4,$5)
       RETURNING id, iniciado_em`,
      [clienteId, clienteSlug, competencia, tipo || "manual", userId || null]
    );
    await client.query("COMMIT");
    return { job: job.rows[0] };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function finalizeSyncJob(jobId, status, erro, payloadJson) {
  await pool.query(
    `UPDATE cliente_360_sync_jobs
        SET status = $2, erro = $3, payload_json = $4, finalizado_em = NOW()
      WHERE id = $1`,
    [jobId, status, erro || null, JSON.stringify(payloadJson || {})]
  );
}

module.exports = {
  ensureCliente360Tables,
  findClienteBySlug,
  findClientesAtivos,
  findBasesVinculadasByCliente,
  findMlGrantByCliente,
  findGrantsResumo,
  findClienteIdsComBase,
  findSincronizacoesPorCompetencia,
  findRelatoriosByCliente,
  findRelatorioItensResumo,
  findEntregasByCliente,
  findAdsResumoByCliente,
  findUltimoAdsResumoByCliente,
  findResumoMensal,
  upsertResumoMensal,
  insertDiagnostico,
  insertDiagnosticoItens,
  findDiagnosticos,
  countDiagnosticos,
  findFreteHistorico,
  lockSyncJob,
  finalizeSyncJob,
};
