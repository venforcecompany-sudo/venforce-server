// server/services/centralVendas/centralVendasSyncRunService.js
// Central de Vendas — Sync Run (M2 da fundação V3).
//
// Uma linha de central_vendas_sync_runs é uma TENTATIVA de sincronizar uma
// conta de marketplace num intervalo. Não é o snapshot nem o fechamento — é
// a execução que produziu ou tentou produzir dados.
//
// A identidade (cliente_conta_id, grant_id, base_id, external_account_id) é
// resolvida UMA ÚNICA VEZ aqui, na criação do run, via
// resolveMarketplaceAccountContext (a mesma porta de entrada do M1 — nunca
// duplicar a lógica de escolha de conta). Ela fica congelada no run: se o
// operador trocar a base oficial do cliente enquanto o run está em
// andamento, o run continua auditável com a base que ele tinha quando foi
// criado, nunca com a nova silenciosamente.
//
// metadata_json NUNCA recebe access_token/refresh_token/Authorization —
// só IDs e contadores (ver marcarRunCompleted).

const pool = require("../../config/database");
const { resolveMarketplaceAccountContext } = require("../clienteContas/clienteContaService");

// Política de stale run (seção 14 do hardening M1/M2): o worker é
// in-process (sem fila externa — ver centralVendasSyncWorker). Se o
// processo Node reiniciar com um run em 'queued'/'running', ninguém nunca
// mais avança esse estado sozinho, e o índice único de runs ativos
// bloquearia uma nova tentativa idêntica para sempre. Limites conservadores
// e configuráveis por env — não é heartbeat, só um teto de idade.
const QUEUED_STALE_MINUTES = Number(process.env.CENTRAL_VENDAS_SYNC_QUEUED_STALE_MINUTES) || 15;
const RUNNING_STALE_MINUTES = Number(process.env.CENTRAL_VENDAS_SYNC_RUNNING_STALE_MINUTES) || 60;

const CAMPOS_SENSIVEIS = new Set([
  "access_token", "refresh_token", "api_key", "apikey", "password",
  "authorization", "token", "secret", "client_secret",
]);

function assertNoSecrets(obj, caminho = "metadata_json") {
  if (!obj || typeof obj !== "object") return;
  for (const [key, value] of Object.entries(obj)) {
    if (CAMPOS_SENSIVEIS.has(String(key).toLowerCase())) {
      throw new Error(`Tentativa de persistir campo sensivel "${key}" em ${caminho}.`);
    }
    if (value && typeof value === "object") assertNoSecrets(value, `${caminho}.${key}`);
  }
}

function criarErroHttp(statusCode, mensagem, extra = {}) {
  const err = new Error(mensagem);
  err.statusCode = statusCode;
  if (extra.code) err.code = extra.code;
  if (extra.contas) err.contas = extra.contas;
  return err;
}

function normalizeSlug(slug) {
  return String(slug || "").trim().toLowerCase();
}

function isValidIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function ensureTables(db = pool) {
  const repository = require("./centralVendasRepository");
  await repository.ensureCentralVendasTables(db);
}

// Estados finais nunca voltam para running (ver seção 4 da especificação).
const ESTADOS_FINAIS = new Set(["completed", "failed"]);

function sanitizeRun(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    status: row.status,
    clienteId: row.cliente_id != null ? Number(row.cliente_id) : null,
    clienteSlug: row.cliente_slug,
    clienteContaId: row.cliente_conta_id != null ? Number(row.cliente_conta_id) : null,
    marketplace: row.marketplace,
    externalAccountId: row.external_account_id || null,
    grantId: row.grant_id != null ? Number(row.grant_id) : null,
    baseId: row.base_id != null ? Number(row.base_id) : null,
    baseResolutionMode: row.base_resolution_mode || null,
    dateFrom: row.date_from ? String(row.date_from).slice(0, 10) : null,
    dateTo: row.date_to ? String(row.date_to).slice(0, 10) : null,
    // M3 — eixo separado do status técnico (ver seção 40 da spec): um run
    // completed pode ter completenessStatus 'partial'. Sempre derivado de
    // central_vendas_sync_sources via calcularCompletudeDoRun, nunca escrito
    // diretamente por outro caminho — ver atualizarCompletenessRun.
    completenessStatus: row.completeness_status || null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.status === "failed" ? { code: row.error_code || null, message: row.error_message || null } : null,
    metadata: row.metadata_json || {},
  };
}

// ---------------------------------------------------------------------------
// Criação — resolve identidade, dedupe, INSERT queued.
// ---------------------------------------------------------------------------

async function criarSyncRun({
  clienteSlug, clienteContaId = null, marketplace = "meli", dateFrom, dateTo,
  requestedBy = null, reutilizarCompletedPublicado = false, db = pool,
}) {
  const slug = normalizeSlug(clienteSlug);
  const marketplaceNorm = String(marketplace || "meli").trim().toLowerCase();

  if (!slug) throw criarErroHttp(400, "slug e obrigatorio.");
  if (marketplaceNorm !== "meli") {
    throw criarErroHttp(400, "Marketplace invalido para Central de Vendas nesta fase.");
  }
  if (!isValidIsoDate(dateFrom) || !isValidIsoDate(dateTo)) {
    throw criarErroHttp(400, "dateFrom e dateTo (YYYY-MM-DD) sao obrigatorios.");
  }
  const from = dateFrom <= dateTo ? dateFrom : dateTo;
  const to = dateFrom <= dateTo ? dateTo : dateFrom;

  await ensureTables(db);

  const clienteResult = await db.query(
    "SELECT id, nome, slug FROM clientes WHERE slug = $1 AND ativo = true LIMIT 1",
    [slug]
  );
  const cliente = clienteResult.rows[0];
  if (!cliente) throw criarErroHttp(404, "Cliente nao encontrado.");

  // Porta única de identidade — nunca escolhe sozinha entre 2+ contas ativas
  // (lança 409 MULTIPLE_MARKETPLACE_ACCOUNTS). requireUsableGrant:true falha
  // cedo, ANTES de criar o run, se o grant não for utilizável.
  const context = await resolveMarketplaceAccountContext({
    clienteId: cliente.id,
    marketplace: marketplaceNorm,
    clienteContaId,
    requireUsableGrant: true,
    queryable: db,
  });

  if (marketplaceNorm === "meli" && !context.mlUserId) {
    throw criarErroHttp(422, "Cliente sem Mercado Livre conectado.", { code: "GRANT_UNAVAILABLE" });
  }

  // Reconcilia runs presos ANTES do dedupe (seção 16 do hardening): sem
  // isso, um run 'running' órfão de um restart do processo bloquearia esta
  // chamada para sempre (o índice único cobre queued/running).
  await reconciliarRunsStale({
    clienteId: cliente.id,
    clienteContaId: context.conta?.id || null,
    marketplace: marketplaceNorm,
    dateFrom: from,
    dateTo: to,
    db,
  });

  // Fast path: já existe um run queued/running idêntico? Devolve ele em vez
  // de criar outro (seção 21 — dois cliques não geram dois workers).
  const existenteAntes = await buscarRunAtivoEquivalente({
    clienteId: cliente.id,
    clienteContaId: context.conta?.id || null,
    marketplace: marketplaceNorm,
    dateFrom: from,
    dateTo: to,
    db,
  });
  if (existenteAntes) return { run: sanitizeRun(existenteAntes), context, reaproveitado: true };

  // A rodada automatica pode ser retomada/repetida depois de restart. Nesse
  // caso um run equivalente ja concluido E publicado e trabalho terminal, nao
  // uma autorizacao para consultar a API e publicar tudo novamente. O fluxo
  // manual preserva o comportamento de reprocessar porque o opt-in e falso.
  if (reutilizarCompletedPublicado) {
    const completed = await buscarRunCompletedPublicadoEquivalente({
      clienteId: cliente.id,
      clienteContaId: context.conta?.id || null,
      marketplace: marketplaceNorm,
      dateFrom: from,
      dateTo: to,
      db,
    });
    if (completed) return { run: sanitizeRun(completed), context, reaproveitado: true };
  }

  let insertResult;
  try {
    insertResult = await db.query(
      `INSERT INTO central_vendas_sync_runs
        (cliente_id, cliente_slug, cliente_conta_id, marketplace, external_account_id, grant_id,
         base_id, base_resolution_mode, date_from, date_to, status, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'queued',$11)
       RETURNING *`,
      [
        cliente.id,
        cliente.slug,
        context.conta?.id || null,
        marketplaceNorm,
        context.mlUserId || null,
        context.grant?.id || null,
        context.base?.base_id || null,
        context.base?.resolvido_por || null,
        from,
        to,
        requestedBy || null,
      ]
    );
  } catch (err) {
    // Corrida real (dois requests simultâneos passaram pelo SELECT acima ao
    // mesmo tempo): o índice único parcial barrou o segundo INSERT. Em vez de
    // propagar 500, devolve o run que "ganhou" a corrida.
    if (err && err.code === "23505") {
      const existenteDepois = await buscarRunAtivoEquivalente({
        clienteId: cliente.id,
        clienteContaId: context.conta?.id || null,
        marketplace: marketplaceNorm,
        dateFrom: from,
        dateTo: to,
        db,
      });
      if (existenteDepois) return { run: sanitizeRun(existenteDepois), context, reaproveitado: true };
    }
    throw err;
  }

  return { run: sanitizeRun(insertResult.rows[0]), context, reaproveitado: false };
}

// Marca como 'failed' (error_code SYNC_RUN_STALE_QUEUED/SYNC_RUN_STALE_RUNNING)
// runs 'queued'/'running' velhos demais para o mesmo escopo (cliente/conta/
// marketplace/período) do run que está prestes a ser criado. Escopo
// deliberadamente estreito (não varre a tabela inteira) — seção 16: "no
// mínimo, antes de buscarRunAtivoEquivalente". Nunca mexe em runs de outro
// cliente/conta/período, e nunca apaga linha nenhuma (só transiciona
// estado, mantendo o histórico auditável).
async function reconciliarRunsStale({ clienteId, clienteContaId, marketplace, dateFrom, dateTo, db = pool }) {
  await db.query(
    `UPDATE central_vendas_sync_runs
        SET status = 'failed', finished_at = NOW(), updated_at = NOW(),
            error_code = 'SYNC_RUN_STALE_QUEUED',
            error_message = 'Run abandonado: ficou queued alem do limite (possivel restart do processo).'
      WHERE cliente_id = $1
        AND cliente_conta_id IS NOT DISTINCT FROM $2
        AND marketplace = $3
        AND date_from = $4
        AND date_to = $5
        AND status = 'queued'
        AND created_at < NOW() - make_interval(mins => $6::int)`,
    [clienteId, clienteContaId, marketplace, dateFrom, dateTo, QUEUED_STALE_MINUTES]
  );

  await db.query(
    `UPDATE central_vendas_sync_runs
        SET status = 'failed', finished_at = NOW(), updated_at = NOW(),
            error_code = 'SYNC_RUN_STALE_RUNNING',
            error_message = 'Run abandonado: ficou running alem do limite (possivel restart do processo).'
      WHERE cliente_id = $1
        AND cliente_conta_id IS NOT DISTINCT FROM $2
        AND marketplace = $3
        AND date_from = $4
        AND date_to = $5
        AND status = 'running'
        AND started_at < NOW() - make_interval(mins => $6::int)`,
    [clienteId, clienteContaId, marketplace, dateFrom, dateTo, RUNNING_STALE_MINUTES]
  );
}

async function buscarRunAtivoEquivalente({ clienteId, clienteContaId, marketplace, dateFrom, dateTo, db = pool }) {
  const result = await db.query(
    `SELECT * FROM central_vendas_sync_runs
      WHERE cliente_id = $1
        AND cliente_conta_id IS NOT DISTINCT FROM $2
        AND marketplace = $3
        AND date_from = $4
        AND date_to = $5
        AND status IN ('queued','running')
      ORDER BY id DESC
      LIMIT 1`,
    [clienteId, clienteContaId, marketplace, dateFrom, dateTo]
  );
  return result.rows[0] || null;
}

async function buscarRunCompletedPublicadoEquivalente({ clienteId, clienteContaId, marketplace, dateFrom, dateTo, db = pool }) {
  const result = await db.query(
    `SELECT r.* FROM central_vendas_sync_runs r
      WHERE r.cliente_id = $1
        AND r.cliente_conta_id IS NOT DISTINCT FROM $2
        AND r.marketplace = $3
        AND r.date_from = $4
        AND r.date_to = $5
        AND r.status = 'completed'
        AND EXISTS (
          SELECT 1 FROM central_vendas_imports i
           WHERE i.sync_run_id = r.id AND i.publication_status = 'published'
        )
      ORDER BY r.id DESC
      LIMIT 1`,
    [clienteId, clienteContaId, marketplace, dateFrom, dateTo]
  );
  return result.rows[0] || null;
}

// Recuperacao no boot, executada sob o MESMO advisory lock da rodada. Runs
// noturnos que estavam running antes deste processo nascer nao possuem mais
// worker neste processo; fecha-os explicitamente para que a rodada equivalente
// possa criar uma nova tentativa. Queued permanecem queued e sao reivindicados.
async function reconciliarRunsNoturnosInterrompidos({ antesDe, db = pool }) {
  const result = await db.query(
    `UPDATE central_vendas_sync_runs
        SET status = 'failed', finished_at = NOW(), updated_at = NOW(),
            error_code = 'SYNC_RUN_PROCESS_RESTART',
            error_message = 'Run interrompido por restart do processo; uma rodada equivalente podera retomar o trabalho.'
      WHERE requested_by IS NULL
        AND status = 'running'
        AND started_at < $1
      RETURNING id, date_from, date_to`,
    [antesDe]
  );
  return result.rows || [];
}

async function listarPeriodosNoturnosPendentes({ antesDe, db = pool }) {
  const result = await db.query(
    `SELECT DISTINCT date_from, date_to
       FROM central_vendas_sync_runs r
      WHERE r.requested_by IS NULL
        AND r.created_at < $1
        AND (
          r.status IN ('queued','running')
          OR (
            r.status = 'completed'
            AND EXISTS (
              SELECT 1 FROM central_vendas_imports i
               WHERE i.sync_run_id = r.id AND i.publication_status = 'published'
            )
            AND NOT EXISTS (
              SELECT 1 FROM cliente_360_resumos_mensais s
               WHERE s.cliente_id = r.cliente_id
                 AND s.competencia = TO_CHAR(r.date_from, 'YYYY-MM')
                 AND s.sincronizado_em >= COALESCE((
                   SELECT MAX(i2.published_at) FROM central_vendas_imports i2
                    WHERE i2.sync_run_id = r.id AND i2.publication_status = 'published'
                 ), r.finished_at)
            )
          )
        )
      ORDER BY date_from, date_to`,
    [antesDe]
  );
  return result.rows.map((row) => ({
    competencia: String(row.date_from).slice(0, 7),
    dateFrom: String(row.date_from).slice(0, 10),
    dateTo: String(row.date_to).slice(0, 10),
  }));
}

// ---------------------------------------------------------------------------
// Leitura — sempre escopada por cliente (nunca vaza run de outro cliente).
// ---------------------------------------------------------------------------

async function obterSyncRun({ runId, clienteSlug, db = pool }) {
  const slug = normalizeSlug(clienteSlug);
  const result = await db.query(
    `SELECT r.* FROM central_vendas_sync_runs r
       JOIN clientes c ON c.id = r.cliente_id
      WHERE r.id = $1 AND c.slug = $2
      LIMIT 1`,
    [runId, slug]
  );
  if (!result.rows.length) throw criarErroHttp(404, "Sync run nao encontrado.");
  return sanitizeRun(result.rows[0]);
}

async function listarSyncRuns({
  clienteSlug, clienteContaId = null, marketplace = null, status = null,
  dateFrom = null, dateTo = null, limit = 20, db = pool,
}) {
  const slug = normalizeSlug(clienteSlug);
  const limitNum = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const condicoes = ["c.slug = $1"];
  const params = [slug];

  if (clienteContaId != null) {
    params.push(Number(clienteContaId));
    condicoes.push(`r.cliente_conta_id = $${params.length}`);
  }
  if (marketplace) {
    params.push(String(marketplace).trim().toLowerCase());
    condicoes.push(`r.marketplace = $${params.length}`);
  }
  if (status) {
    params.push(String(status).trim().toLowerCase());
    condicoes.push(`r.status = $${params.length}`);
  }
  // Filtro por período (seção 24): permite ao frontend achar o run
  // equivalente ao período aberto na tela, em vez de pegar "o mais recente
  // do cliente" quando há sincronizações concorrentes de meses diferentes.
  if (isValidIsoDate(dateFrom)) {
    params.push(dateFrom);
    condicoes.push(`r.date_from = $${params.length}`);
  }
  if (isValidIsoDate(dateTo)) {
    params.push(dateTo);
    condicoes.push(`r.date_to = $${params.length}`);
  }

  params.push(limitNum);
  const result = await db.query(
    `SELECT r.* FROM central_vendas_sync_runs r
       JOIN clientes c ON c.id = r.cliente_id
      WHERE ${condicoes.join(" AND ")}
      ORDER BY r.id DESC
      LIMIT $${params.length}`,
    params
  );
  return result.rows.map(sanitizeRun);
}

// ---------------------------------------------------------------------------
// Transições de estado — sempre em transações curtas (sem API externa).
// ---------------------------------------------------------------------------

async function marcarRunRunning(runId, db = pool) {
  const result = await db.query(
    `UPDATE central_vendas_sync_runs
        SET status = 'running', started_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'queued'
      RETURNING *`,
    [runId]
  );
  return result.rows[0] || null;
}

// Transições estritas (seção 11 do hardening): só running -> completed e
// running -> failed. Um estado final (completed/failed) NUNCA volta para
// outro estado, nem para o mesmo estado final por outro caminho — por isso
// a guarda é "AND status = 'running'", não "status <> 'completed'"/"status
// <> 'failed'" (essa negação deixava passar failed->completed e
// completed->failed, o bug real encontrado na revisão).
async function marcarRunCompleted(runId, metadata = {}, db = pool) {
  assertNoSecrets(metadata);
  const result = await db.query(
    `UPDATE central_vendas_sync_runs
        SET status = 'completed', finished_at = NOW(), updated_at = NOW(), metadata_json = $2::jsonb
      WHERE id = $1 AND status = 'running'
      RETURNING *`,
    [runId, JSON.stringify(metadata || {})]
  );
  return result.rows[0] || null;
}

async function marcarRunFailed(runId, { code = null, message = null } = {}, db = pool) {
  const result = await db.query(
    `UPDATE central_vendas_sync_runs
        SET status = 'failed', finished_at = NOW(), updated_at = NOW(),
            error_code = $2, error_message = $3
      WHERE id = $1 AND status = 'running'
      RETURNING *`,
    [runId, code, message ? String(message).slice(0, 2000) : null]
  );
  return result.rows[0] || null;
}

// M3 — grava o cache de completude do run (sempre derivado de
// centralVendasSyncSourceService.calcularCompletudeDoRun, nunca calculado
// aqui). Não é uma transição de estado do run (queued/running/completed/
// failed continuam exatamente como no M2) — por isso não tem guarda de
// status: pode ser chamado a qualquer momento sem afetar run.status.
async function atualizarCompletenessRun(runId, completenessStatus, db = pool) {
  const result = await db.query(
    `UPDATE central_vendas_sync_runs
        SET completeness_status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [runId, completenessStatus || null]
  );
  return result.rows[0] ? sanitizeRun(result.rows[0]) : null;
}

module.exports = {
  criarSyncRun,
  obterSyncRun,
  listarSyncRuns,
  marcarRunRunning,
  marcarRunCompleted,
  marcarRunFailed,
  atualizarCompletenessRun,
  reconciliarRunsStale,
  buscarRunCompletedPublicadoEquivalente,
  reconciliarRunsNoturnosInterrompidos,
  listarPeriodosNoturnosPendentes,
  sanitizeRun,
  ESTADOS_FINAIS,
  QUEUED_STALE_MINUTES,
  RUNNING_STALE_MINUTES,
};
