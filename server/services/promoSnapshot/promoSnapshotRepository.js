const { currentGrantSql } = require("../mlGrantIdentity");
// server/services/promoSnapshot/promoSnapshotRepository.js
// Promo Snapshot — persistência (runs, linhas, lotes e snapshot atual).
//
// Toda leitura/escrita é ACCOUNT-SCOPED (cliente_conta_id explícito). Mesma
// disciplina de marginSnapshotRunRepository:
//   - transições com guarda estrita (WHERE status = <origem>), nunca "<> X";
//   - claim atômico com FOR UPDATE SKIP LOCKED (duas instâncias nunca pegam
//     o mesmo run);
//   - toda escrita de um run exige que ele AINDA esteja `running` (a linha do
//     run é travada com FOR UPDATE na mesma transação): um worker zumbi cujo
//     run foi reconciliado como parado não grava mais nada;
//   - o ponteiro do snapshot atual muda na MESMA transação que conclui o run;
//   - identidade efetiva = cliente_conta_id + marketplace + seller_id: a mesma
//     conta reconectada a outro seller nunca lê/reaproveita o que foi do
//     seller anterior (ponteiro, runs, linhas);
//   - lote idempotente: contadores só avançam quando o (run_id, seq) é
//     inserido; replay do mesmo lote não muda progresso nenhum.
//
// SQL validado contra Postgres real (PGlite) em
// server/scripts/promoSnapshotSqlCheck.js.

const pool = require("../../config/database");
const { ensurePromoSnapshotSchema } = require("../schema/schemaEnsure");

const TIPO = "PROMO_SNAPSHOT";
const ESTADOS_ATIVOS = ["queued", "running"];
const ERRO_STALE = "PROMO_SNAPSHOT_RUN_STALE";
const ERRO_WORKER_PARADO = "PROMO_SNAPSHOT_WORKER_STOPPED";
const ERRO_SELLER_SUBSTITUIDO = "PROMO_SNAPSHOT_SELLER_SUBSTITUIDO";
const ERRO_SELLER_DIVERGENTE = "PROMO_SNAPSHOT_SELLER_DIVERGENTE";
// Runs interrompidos (não por erro do ML/conta) — seus lotes podem ser retomados.
const ERROS_RETOMAVEIS = [ERRO_STALE, ERRO_WORKER_PARADO];

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

async function ensureTables(db = pool) {
  await ensurePromoSnapshotSchema(db);
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sanitizeRun(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    clienteId: Number(row.cliente_id),
    clienteSlug: row.cliente_slug || null,
    clienteContaId: Number(row.cliente_conta_id),
    marketplace: row.marketplace,
    sellerId: row.seller_id != null ? String(row.seller_id) : null,
    reason: row.reason,
    status: row.status,
    requestedBy: row.requested_by != null ? Number(row.requested_by) : null,
    resumedFromRunId: row.resumed_from_run_id != null ? Number(row.resumed_from_run_id) : null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
    itensTotal: numOrNull(row.itens_total),
    itensProcessados: Number(row.itens_processados || 0),
    itensComPromocao: Number(row.itens_com_promocao || 0),
    promocoesEncontradas: Number(row.promocoes_encontradas || 0),
    erros: Number(row.erros || 0),
    rateLimits: Number(row.rate_limits || 0),
    retries: Number(row.retries || 0),
    promovido: row.promovido === true,
    itensHerdados: Number(row.itens_herdados || 0),
    promocoesHerdadas: Number(row.promocoes_herdadas || 0),
    snapshotAt: row.snapshot_at || null,
    freshUntil: row.fresh_until || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    metadata: row.metadata_json || {},
    updatedAt: row.updated_at,
    // Contrato que o worker genérico (marginSnapshotWorker) usa no log.
    totalItems: numOrNull(row.itens_total),
    successItems: Math.max(0, Number(row.itens_processados || 0) - Number(row.erros || 0)),
    failedItems: Number(row.erros || 0),
  };
}

function sanitizeConta(row) {
  if (!row) return null;
  return {
    clienteContaId: Number(row.cliente_conta_id),
    clienteId: Number(row.cliente_id),
    marketplace: row.marketplace,
    sellerId: row.seller_id != null ? String(row.seller_id) : null,
    currentRunId: row.current_run_id != null ? Number(row.current_run_id) : null,
    previousRunId: row.previous_run_id != null ? Number(row.previous_run_id) : null,
    snapshotAt: row.snapshot_at || null,
    freshUntil: row.fresh_until || null,
    parcial: row.parcial === true,
    itensTotal: numOrNull(row.itens_total),
    itensComPromocao: numOrNull(row.itens_com_promocao),
    promocoesTotal: numOrNull(row.promocoes_total),
    itensSemLeitura: Number(row.itens_sem_leitura || 0),
    itensHerdados: Number(row.itens_herdados || 0),
    lastAttemptRunId: row.last_attempt_run_id != null ? Number(row.last_attempt_run_id) : null,
    lastAttemptStatus: row.last_attempt_status || null,
    lastAttemptAt: row.last_attempt_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastErrorCode: row.last_error_code || null,
    updatedAt: row.updated_at || null,
  };
}

// Transação: pool real usa uma conexão dedicada; client/sessão única (PGlite,
// fakes) usa a própria db.
async function transacao(db, fn) {
  const usaPool = typeof db.connect === "function" && typeof db.release !== "function";
  const client = usaPool ? await db.connect() : db;
  try {
    await client.query("BEGIN");
    const resultado = await fn(client);
    await client.query("COMMIT");
    return resultado;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) { /* conexão caída */ }
    throw err;
  } finally {
    if (usaPool && typeof client.release === "function") client.release();
  }
}

// Trava a linha do run e confirma que ele ainda está em execução. Serializa
// com a reconciliação de heartbeat (que faz UPDATE na mesma linha).
async function travarRunEmExecucao(client, runId) {
  const r = await client.query(
    `SELECT id FROM promo_snapshot_runs WHERE id = $1 AND status = 'running' FOR UPDATE`,
    [runId]
  );
  return r.rows.length > 0;
}

// ─── Criação / leitura de runs ───────────────────────────────────────────────

async function createRun({
  clienteId, clienteSlug = null, clienteContaId, marketplace = "meli", sellerId,
  reason, requestedBy = null, resumedFromRunId = null,
}, db = pool) {
  if (!clienteId) throw new Error("createRun: clienteId é obrigatório.");
  if (!clienteContaId) throw new Error("createRun: clienteContaId é obrigatório.");
  if (!sellerId) throw new Error("createRun: sellerId é obrigatório.");
  if (!reason) throw new Error("createRun: reason é obrigatório.");
  await ensureTables(db);
  const r = await db.query(
    `INSERT INTO promo_snapshot_runs
       (cliente_id, cliente_slug, cliente_conta_id, marketplace, seller_id, tipo, reason, status,
        requested_by, resumed_from_run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9)
     RETURNING *`,
    [clienteId, clienteSlug, clienteContaId, marketplace, String(sellerId), TIPO, reason, requestedBy, resumedFromRunId]
  );
  return sanitizeRun(r.rows[0]);
}

// Run ativo da CONTA (qualquer seller — o índice único é por conta). Quem
// chama compara run.sellerId com o seller atual da conta.
async function findActiveRun({ clienteContaId, marketplace = "meli" }, db = pool) {
  if (!clienteContaId) throw new Error("findActiveRun: clienteContaId é obrigatório.");
  await ensureTables(db);
  const r = await db.query(
    `SELECT * FROM promo_snapshot_runs
      WHERE cliente_conta_id = $1 AND marketplace = $2 AND tipo = $3
        AND status IN ('queued','running')
      ORDER BY id DESC LIMIT 1`,
    [clienteContaId, marketplace, TIPO]
  );
  return sanitizeRun(r.rows[0]);
}

async function getRunById({ runId, clienteContaId }, db = pool) {
  if (!runId) throw new Error("getRunById: runId é obrigatório.");
  if (!clienteContaId) throw new Error("getRunById: clienteContaId é obrigatório (leitura sempre por conta).");
  await ensureTables(db);
  const r = await db.query(
    `SELECT * FROM promo_snapshot_runs WHERE id = $1 AND cliente_conta_id = $2 LIMIT 1`,
    [runId, clienteContaId]
  );
  return sanitizeRun(r.rows[0]);
}

// `sellerId` opcional: com ele, só runs do seller vinculado hoje à conta.
async function findLatestFinishedRun({ clienteContaId, marketplace = "meli", sellerId = null }, db = pool) {
  await ensureTables(db);
  const r = await db.query(
    `SELECT * FROM promo_snapshot_runs
      WHERE cliente_conta_id = $1 AND marketplace = $2 AND tipo = $3
        AND status IN ('completed','partial','failed')
        AND ($4::text IS NULL OR seller_id = $4::text)
      ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1`,
    [clienteContaId, marketplace, TIPO, sellerId == null ? null : String(sellerId)]
  );
  return sanitizeRun(r.rows[0]);
}

// Run interrompido recentemente (heartbeat parado / worker parado) da MESMA
// conta e do MESMO seller, com pelo menos um lote concluído, mais novo que o
// snapshot atual — candidato a retomada.
async function findResumableRun({ clienteContaId, marketplace = "meli", sellerId, resumeMaxMinutes }, db = pool) {
  const minutos = Number(resumeMaxMinutes);
  if (!(minutos > 0)) return null;
  await ensureTables(db);
  const r = await db.query(
    `SELECT r.* FROM promo_snapshot_runs r
      WHERE r.cliente_conta_id = $1 AND r.marketplace = $2 AND r.tipo = $3 AND r.seller_id = $4
        AND r.status = 'failed' AND r.error_code = ANY($5::text[])
        AND r.started_at IS NOT NULL
        AND r.finished_at > NOW() - make_interval(mins => $6::int)
        AND EXISTS (SELECT 1 FROM promo_snapshot_run_lotes l WHERE l.run_id = r.id)
        AND NOT EXISTS (
          SELECT 1 FROM promo_snapshot_contas c
           WHERE c.cliente_conta_id = r.cliente_conta_id AND c.marketplace = r.marketplace
             AND c.seller_id = r.seller_id AND c.snapshot_at >= r.started_at)
      ORDER BY r.finished_at DESC, r.id DESC LIMIT 1`,
    [clienteContaId, marketplace, TIPO, String(sellerId), ERROS_RETOMAVEIS, minutos]
  );
  return sanitizeRun(r.rows[0]);
}

/**
 * Conta reconectada a outro seller: encerra (failed, SELLER_SUBSTITUIDO) o
 * run ativo que ainda é do seller ANTERIOR, liberando o índice único para o
 * seller atual. Um worker que ainda esteja processando esse run é barrado
 * pelo fencing na próxima escrita.
 */
async function encerrarRunsDeOutroSeller({ clienteContaId, marketplace = "meli", sellerId }, db = pool) {
  if (!clienteContaId || !sellerId) throw new Error("encerrarRunsDeOutroSeller: conta e seller são obrigatórios.");
  await ensureTables(db);
  const r = await db.query(
    `UPDATE promo_snapshot_runs
        SET status = 'failed', finished_at = NOW(), updated_at = NOW(), promovido = false,
            error_code = '${ERRO_SELLER_SUBSTITUIDO}',
            error_message = 'A conta foi reconectada a outro seller do Mercado Livre; este run era do seller anterior.'
      WHERE cliente_conta_id = $1 AND marketplace = $2 AND tipo = $3
        AND status IN ('queued','running') AND seller_id <> $4
      RETURNING *`,
    [clienteContaId, marketplace, TIPO, String(sellerId)]
  );
  return r.rows.map(sanitizeRun);
}

// ─── Claim / progresso / heartbeat ───────────────────────────────────────────

async function claimNextQueuedRun({ excludeContaIds = [] } = {}, db = pool) {
  await ensureTables(db);
  const excluir = (Array.isArray(excludeContaIds) ? excludeContaIds : [])
    .map(Number).filter(Number.isFinite);
  const r = await db.query(
    `UPDATE promo_snapshot_runs
        SET status = 'running', started_at = NOW(), heartbeat_at = NOW(), updated_at = NOW()
      WHERE id = (
        SELECT id FROM promo_snapshot_runs
         WHERE status = 'queued' AND tipo = $2
           AND cliente_conta_id <> ALL($1::bigint[])
         ORDER BY created_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
        AND status = 'queued'
      RETURNING *`,
    [excluir, TIPO]
  );
  return sanitizeRun(r.rows[0]);
}

async function touchHeartbeat(runId, db = pool) {
  const r = await db.query(
    `UPDATE promo_snapshot_runs SET heartbeat_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'running' RETURNING *`,
    [runId]
  );
  return sanitizeRun(r.rows[0]);
}

async function registrarTotal({ runId, itensTotal }, db = pool) {
  const r = await db.query(
    `UPDATE promo_snapshot_runs SET itens_total = $2, heartbeat_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'running' RETURNING *`,
    [runId, itensTotal]
  );
  return sanitizeRun(r.rows[0]);
}

const COLUNAS_ITEM = [
  "run_id", "cliente_id", "cliente_conta_id", "marketplace", "seller_id", "item_id", "promocao_chave",
  "promotion_id", "ref_id", "promotion_type", "tipo_conhecido", "nome", "status", "status_exibicao",
  "data_inicio", "data_fim", "preco_original", "preco_final", "preco_final_fonte", "desconto_valor",
  "desconto_percentual", "seller_percentage", "meli_percentage", "subsidio_ml", "elegivel", "ativa",
  "programada", "nao_aplicada", "observed_at", "origem_run_id", "herdado",
];
const LINHAS_POR_INSERT = 300;

function valoresLinha(run, l) {
  return [
    run.id, run.clienteId, run.clienteContaId, run.marketplace, run.sellerId, l.itemId, l.promocaoChave,
    l.promotionId ?? null, l.refId ?? null, l.promotionType ?? null, l.tipoConhecido === true, l.nome ?? null,
    l.status ?? null, l.statusExibicao ?? null, l.dataInicio ?? null, l.dataFim ?? null,
    numOrNull(l.precoOriginal), numOrNull(l.precoFinal), l.precoFinalFonte ?? null, numOrNull(l.descontoValor),
    numOrNull(l.descontoPercentual), numOrNull(l.sellerPercentage), numOrNull(l.meliPercentage),
    numOrNull(l.subsidioMl), l.elegivel === true, typeof l.ativa === "boolean" ? l.ativa : null,
    l.programada === true, typeof l.naoAplicada === "boolean" ? l.naoAplicada : null,
    l.observedAt, l.origemRunId ?? null, l.herdado === true,
  ];
}

// Devolve as linhas EFETIVAMENTE gravadas (a mesma promoção repetida no
// mesmo item conta uma vez só).
async function inserirLinhas(client, run, linhas) {
  const gravadas = [];
  for (let i = 0; i < linhas.length; i += LINHAS_POR_INSERT) {
    const parte = linhas.slice(i, i + LINHAS_POR_INSERT);
    const valores = [];
    const tuplas = parte.map((l) => {
      const base = valores.length;
      valores.push(...valoresLinha(run, l));
      return `(${COLUNAS_ITEM.map((_, j) => `$${base + j + 1}`).join(",")})`;
    });
    // eslint-disable-next-line no-await-in-loop
    const r = await client.query(
      `INSERT INTO promo_snapshot_itens (${COLUNAS_ITEM.join(",")}) VALUES ${tuplas.join(",")}
       ON CONFLICT (run_id, item_id, promocao_chave) DO NOTHING
       RETURNING item_id`,
      valores
    );
    gravadas.push(...r.rows);
  }
  return gravadas;
}

function mesmosItens(a, b) {
  const x = [...(a || [])].map(String).sort();
  const y = [...(b || [])].map(String).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Grava um lote concluído: registro do lote + linhas + contadores + heartbeat,
 * numa transação, e só se o run ainda estiver `running`. Devolve o run
 * atualizado, ou null quando o run deixou de estar em execução (fencing).
 *
 * IDEMPOTENTE por (run_id, seq): o registro do lote é inserido PRIMEIRO; se
 * ele já existia (replay — ex.: o COMMIT aconteceu mas a resposta se perdeu
 * e o lote foi reenviado), nada mais é gravado e nenhum contador
 * (itens_processados, itens_com_promocao, promocoes_encontradas, erros,
 * retries, rate_limits) muda. O mesmo seq com OUTROS itens é recusado
 * (PROMO_SNAPSHOT_LOTE_CONFLITANTE) — nunca sobrescreve progresso.
 */
async function registrarLote({ run, seq, itemIds, itensFalhos = [], linhas = [], contadores = {} }, db = pool) {
  assertNoSecrets(contadores, "contadores");
  return transacao(db, async (client) => {
    if (!(await travarRunEmExecucao(client, run.id))) return null;
    const retries = Number(contadores.retries || 0);
    const rateLimits = Number(contadores.rateLimits || 0);
    const novo = await client.query(
      `INSERT INTO promo_snapshot_run_lotes (run_id, seq, item_ids, itens_falhos, retries, rate_limits)
       VALUES ($1,$2,$3::text[],$4::text[],$5,$6)
       ON CONFLICT (run_id, seq) DO NOTHING
       RETURNING seq`,
      [run.id, seq, itemIds, itensFalhos, retries, rateLimits]
    );
    if (!novo.rows.length) {
      const existente = await client.query(
        `SELECT item_ids FROM promo_snapshot_run_lotes WHERE run_id = $1 AND seq = $2`, [run.id, seq]
      );
      if (!mesmosItens(existente.rows[0] && existente.rows[0].item_ids, itemIds)) {
        const err = new Error(`Lote ${seq} do run ${run.id} já foi gravado com outros itens; replay recusado.`);
        err.code = "PROMO_SNAPSHOT_LOTE_CONFLITANTE";
        throw err;
      }
      const atual = await client.query(
        `UPDATE promo_snapshot_runs SET heartbeat_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'running' RETURNING *`,
        [run.id]
      );
      return sanitizeRun(atual.rows[0]);
    }
    const gravadas = linhas.length ? await inserirLinhas(client, run, linhas) : [];
    const itensComPromocao = new Set(gravadas.map((l) => l.item_id)).size;
    await client.query(
      `UPDATE promo_snapshot_run_lotes SET promocoes = $3, itens_com_promocao = $4 WHERE run_id = $1 AND seq = $2`,
      [run.id, seq, gravadas.length, itensComPromocao]
    );
    const r = await client.query(
      `UPDATE promo_snapshot_runs
          SET itens_processados = itens_processados + $2,
              itens_com_promocao = itens_com_promocao + $3,
              promocoes_encontradas = promocoes_encontradas + $4,
              erros = erros + $5,
              rate_limits = rate_limits + $6,
              retries = retries + $7,
              heartbeat_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'running'
        RETURNING *`,
      [run.id, itemIds.length, itensComPromocao, gravadas.length, itensFalhos.length, rateLimits, retries]
    );
    return sanitizeRun(r.rows[0]);
  });
}

/**
 * Retomada: copia para `run` as linhas dos itens que o run interrompido
 * `fromRunId` já tinha concluído (e que continuam no catálogo). Devolve os
 * itens reaproveitados — o processor não os relê do ML.
 */
async function copiarLotesRetomados({ run, fromRunId, catalogItemIds }, db = pool) {
  return transacao(db, async (client) => {
    if (!(await travarRunEmExecucao(client, run.id))) return null;
    const origem = await client.query(
      `SELECT r.started_at, r.cliente_conta_id, r.seller_id FROM promo_snapshot_runs r WHERE r.id = $1`,
      [fromRunId]
    );
    const o = origem.rows[0];
    // Nunca retoma dados de outra conta/seller.
    if (!o || Number(o.cliente_conta_id) !== run.clienteContaId || String(o.seller_id) !== run.sellerId) {
      return { itens: [], promocoes: 0, startedAt: null };
    }
    const lotes = await client.query(
      `SELECT item_ids, itens_falhos FROM promo_snapshot_run_lotes WHERE run_id = $1`,
      [fromRunId]
    );
    const catalogo = new Set(catalogItemIds);
    const feitos = new Set();
    for (const l of lotes.rows) {
      const falhos = new Set(l.itens_falhos || []);
      for (const id of l.item_ids || []) if (!falhos.has(id) && catalogo.has(id)) feitos.add(id);
    }
    const itens = [...feitos];
    if (!itens.length) return { itens: [], promocoes: 0, startedAt: null };
    // Idempotente: o lote 0 (retomada) é registrado PRIMEIRO; se já existia,
    // devolve o que foi copiado da primeira vez sem mexer em contador.
    const novo = await client.query(
      `INSERT INTO promo_snapshot_run_lotes (run_id, seq, item_ids, itens_falhos)
       VALUES ($1, 0, $2::text[], '{}') ON CONFLICT (run_id, seq) DO NOTHING RETURNING seq`,
      [run.id, itens]
    );
    if (!novo.rows.length) {
      const ja = await client.query(
        `SELECT item_ids, promocoes FROM promo_snapshot_run_lotes WHERE run_id = $1 AND seq = 0`, [run.id]
      );
      const l0 = ja.rows[0] || {};
      return { itens: l0.item_ids || [], promocoes: Number(l0.promocoes || 0), startedAt: o.started_at };
    }
    const cols = COLUNAS_ITEM.filter((c) => c !== "run_id" && c !== "origem_run_id");
    const copia = await client.query(
      `INSERT INTO promo_snapshot_itens (run_id, ${cols.join(",")}, origem_run_id)
       SELECT $1, ${cols.join(",")}, COALESCE(origem_run_id, run_id)
         FROM promo_snapshot_itens
        WHERE run_id = $2 AND item_id = ANY($3::text[])
       ON CONFLICT (run_id, item_id, promocao_chave) DO NOTHING
       RETURNING item_id`,
      [run.id, fromRunId, itens]
    );
    const promocoes = copia.rows.length;
    const itensComPromocao = new Set(copia.rows.map((x) => x.item_id)).size;
    await client.query(
      `UPDATE promo_snapshot_run_lotes SET promocoes = $2, itens_com_promocao = $3 WHERE run_id = $1 AND seq = 0`,
      [run.id, promocoes, itensComPromocao]
    );
    await client.query(
      `UPDATE promo_snapshot_runs
          SET itens_processados = itens_processados + $2,
              itens_com_promocao = itens_com_promocao + $3,
              promocoes_encontradas = promocoes_encontradas + $4,
              heartbeat_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND status = 'running'`,
      [run.id, itens.length, itensComPromocao, promocoes]
    );
    return { itens, promocoes, startedAt: o.started_at };
  });
}

// ─── Conclusão / falha / recovery ────────────────────────────────────────────

const CONFLITO_CONTA = "ON CONFLICT (cliente_conta_id, marketplace, seller_id)";

const SQL_TENTATIVA = `
  INSERT INTO promo_snapshot_contas
    (cliente_conta_id, cliente_id, marketplace, seller_id, last_attempt_run_id, last_attempt_status,
     last_attempt_at, last_error_code, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,NOW())
  ${CONFLITO_CONTA} DO UPDATE SET
    last_attempt_run_id = EXCLUDED.last_attempt_run_id,
    last_attempt_status = EXCLUDED.last_attempt_status,
    last_attempt_at = EXCLUDED.last_attempt_at,
    last_error_code = EXCLUDED.last_error_code,
    updated_at = NOW()`;

async function registrarTentativa(client, run, status, errorCode) {
  await client.query(SQL_TENTATIVA, [
    run.clienteContaId, run.clienteId, run.marketplace, run.sellerId, run.id, status, errorCode || null,
  ]);
}

// Seller vinculado HOJE à conta. undefined = instalação sem cliente_contas
// (nada a comparar); null = conta sem seller/apagada.
async function sellerAtualDaConta(client, clienteContaId) {
  const t = await client.query(`SELECT to_regclass('public.cliente_contas') IS NOT NULL AS existe`);
  if (!t.rows[0] || !t.rows[0].existe) return undefined;
  const r = await client.query(`SELECT external_account_id FROM cliente_contas WHERE id = $1`, [clienteContaId]);
  if (!r.rows.length || r.rows[0].external_account_id == null) return null;
  return String(r.rows[0].external_account_id);
}

/**
 * Parcial promovido: os itens cuja leitura FALHOU neste run herdam as linhas
 * do snapshot atual (mesma conta + seller), com herdado = true, o
 * observed_at da leitura original e origem_run_id — nunca somem em
 * silêncio. Só herda leitura com até `inheritMaxMinutes` de idade.
 */
async function herdarDoSnapshotAnterior(client, run, inheritMaxMinutes) {
  const minutos = Number(inheritMaxMinutes);
  if (!(minutos > 0)) return { itens: 0, promocoes: 0 };
  const cols = COLUNAS_ITEM.filter((c) => c !== "run_id" && c !== "origem_run_id" && c !== "herdado");
  const r = await client.query(
    `WITH anterior AS (
       SELECT current_run_id FROM promo_snapshot_contas
        WHERE cliente_conta_id = $2 AND marketplace = $3 AND seller_id = $4
          AND current_run_id IS NOT NULL AND current_run_id <> $1
     ), falhos AS (
       SELECT DISTINCT unnest(itens_falhos) AS item_id FROM promo_snapshot_run_lotes WHERE run_id = $1
     )
     INSERT INTO promo_snapshot_itens (run_id, ${cols.join(",")}, origem_run_id, herdado)
     SELECT $1, ${cols.map((c) => `i.${c}`).join(",")}, COALESCE(i.origem_run_id, i.run_id), true
       FROM promo_snapshot_itens i
      WHERE i.run_id = (SELECT current_run_id FROM anterior)
        AND i.cliente_conta_id = $2 AND i.seller_id = $4
        AND i.item_id IN (SELECT item_id FROM falhos)
        AND i.observed_at > NOW() - make_interval(mins => $5::int)
     ON CONFLICT (run_id, item_id, promocao_chave) DO NOTHING
     RETURNING item_id`,
    [run.id, run.clienteContaId, run.marketplace, run.sellerId, Math.trunc(minutos)]
  );
  return { itens: new Set(r.rows.map((x) => x.item_id)).size, promocoes: r.rows.length };
}

/**
 * Conclui o run (running → completed | partial) e, se `promover`, troca o
 * ponteiro do snapshot atual DA CONTA + SELLER NA MESMA TRANSAÇÃO. O
 * snapshot anterior vira `previous_run_id`; linhas de runs mais velhos da
 * conta (e tudo do seller anterior da conta) são podadas.
 *
 *   - Seller: se a conta já não está vinculada ao seller do run
 *     (reconectada no meio do run), o run vira failed SELLER_DIVERGENTE e
 *     nada é promovido.
 *   - Parcial promovido: itens que falharam herdam a última leitura boa
 *     (herdarDoSnapshotAnterior).
 *
 * Devolve null se o run já não estava em execução (nada é alterado).
 */
async function finalizarRun({
  runId, status, promover, snapshotAt = null, freshMinutes, inheritMaxMinutes = 0, metadata = {},
  errorCode = null, errorMessage = null,
}, db = pool) {
  if (status !== "completed" && status !== "partial") throw new Error(`finalizarRun: status inválido "${status}".`);
  assertNoSecrets(metadata);
  return transacao(db, async (client) => {
    const travado = await client.query(
      `SELECT * FROM promo_snapshot_runs WHERE id = $1 AND status = 'running' FOR UPDATE`, [runId]
    );
    const emExecucao = sanitizeRun(travado.rows[0]);
    if (!emExecucao) return null;

    const sellerConta = await sellerAtualDaConta(client, emExecucao.clienteContaId);
    if (sellerConta !== undefined && sellerConta !== emExecucao.sellerId) {
      const f = await client.query(
        `UPDATE promo_snapshot_runs
            SET status = 'failed', finished_at = NOW(), updated_at = NOW(), promovido = false,
                error_code = $2, error_message = $3
          WHERE id = $1 AND status = 'running'
          RETURNING *`,
        [runId, ERRO_SELLER_DIVERGENTE, "A conta foi reconectada a outro seller durante o run; nada foi promovido."]
      );
      const falho = sanitizeRun(f.rows[0]);
      await registrarTentativa(client, falho, "failed", ERRO_SELLER_DIVERGENTE);
      return falho;
    }

    const herdadas = promover && status === "partial"
      ? await herdarDoSnapshotAnterior(client, emExecucao, inheritMaxMinutes)
      : { itens: 0, promocoes: 0 };

    const r = await client.query(
      `UPDATE promo_snapshot_runs
          SET status = $2, finished_at = NOW(), updated_at = NOW(), promovido = $3,
              snapshot_at = COALESCE($4::timestamptz, started_at),
              fresh_until = COALESCE($4::timestamptz, started_at) + make_interval(mins => $5::int),
              metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $6::jsonb,
              error_code = $7, error_message = $8,
              itens_herdados = $9, promocoes_herdadas = $10
        WHERE id = $1 AND status = 'running'
        RETURNING *`,
      [
        runId, status, promover === true, snapshotAt, freshMinutes, JSON.stringify(metadata || {}), errorCode,
        errorMessage, herdadas.itens, herdadas.promocoes,
      ]
    );
    const run = sanitizeRun(r.rows[0]);
    if (!run) return null;

    if (promover) {
      await client.query(
        `INSERT INTO promo_snapshot_contas
           (cliente_conta_id, cliente_id, marketplace, seller_id, current_run_id, previous_run_id,
            snapshot_at, fresh_until, parcial, itens_total, itens_com_promocao, promocoes_total,
            itens_sem_leitura, itens_herdados, last_attempt_run_id, last_attempt_status, last_attempt_at,
            last_success_at, last_error_code, updated_at)
         VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11,$12,$13,$5,$14,NOW(),NOW(),NULL,NOW())
         ${CONFLITO_CONTA} DO UPDATE SET
           cliente_id = EXCLUDED.cliente_id,
           previous_run_id = CASE WHEN promo_snapshot_contas.current_run_id IS DISTINCT FROM EXCLUDED.current_run_id
                                  THEN promo_snapshot_contas.current_run_id ELSE promo_snapshot_contas.previous_run_id END,
           current_run_id = EXCLUDED.current_run_id,
           snapshot_at = EXCLUDED.snapshot_at,
           fresh_until = EXCLUDED.fresh_until,
           parcial = EXCLUDED.parcial,
           itens_total = EXCLUDED.itens_total,
           itens_com_promocao = EXCLUDED.itens_com_promocao,
           promocoes_total = EXCLUDED.promocoes_total,
           itens_sem_leitura = EXCLUDED.itens_sem_leitura,
           itens_herdados = EXCLUDED.itens_herdados,
           last_attempt_run_id = EXCLUDED.last_attempt_run_id,
           last_attempt_status = EXCLUDED.last_attempt_status,
           last_attempt_at = EXCLUDED.last_attempt_at,
           last_success_at = EXCLUDED.last_success_at,
           last_error_code = NULL,
           updated_at = NOW()
         WHERE promo_snapshot_contas.snapshot_at IS NULL OR promo_snapshot_contas.snapshot_at <= EXCLUDED.snapshot_at`,
        [
          run.clienteContaId, run.clienteId, run.marketplace, run.sellerId, run.id,
          run.snapshotAt, run.freshUntil, status === "partial", run.itensTotal,
          run.itensComPromocao + herdadas.itens, run.promocoesEncontradas + herdadas.promocoes,
          run.erros, herdadas.itens, status,
        ]
      );
      // Seller anterior da conta: ponteiro e linhas nunca mais servem.
      await client.query(
        `DELETE FROM promo_snapshot_contas WHERE cliente_conta_id = $1 AND marketplace = $2 AND seller_id <> $3`,
        [run.clienteContaId, run.marketplace, run.sellerId]
      );
      // Poda: da conta, mantém só o snapshot atual e o anterior DESTE seller
      // (e runs ainda ativos dele).
      await client.query(
        `DELETE FROM promo_snapshot_itens i
          USING promo_snapshot_contas c
          WHERE c.cliente_conta_id = $1 AND c.marketplace = $2 AND c.seller_id = $3
            AND i.cliente_conta_id = $1
            AND (i.seller_id <> $3
                 OR (i.run_id IS DISTINCT FROM c.current_run_id AND i.run_id IS DISTINCT FROM c.previous_run_id))
            AND NOT EXISTS (
              SELECT 1 FROM promo_snapshot_runs a
               WHERE a.id = i.run_id AND a.seller_id = $3 AND a.status IN ('queued','running'))`,
        [run.clienteContaId, run.marketplace, run.sellerId]
      );
    } else {
      await registrarTentativa(client, run, status, errorCode || "PROMO_SNAPSHOT_PARCIAL_NAO_PROMOVIDO");
    }
    return run;
  });
}

async function marcarFalhou({ runId, code = null, message = null }, db = pool) {
  return transacao(db, async (client) => {
    const r = await client.query(
      `UPDATE promo_snapshot_runs
          SET status = 'failed', finished_at = NOW(), updated_at = NOW(), promovido = false,
              error_code = $2, error_message = $3
        WHERE id = $1 AND status = 'running'
        RETURNING *`,
      [runId, code, message ? String(message).slice(0, 2000) : null]
    );
    const run = sanitizeRun(r.rows[0]);
    if (run) await registrarTentativa(client, run, "failed", code);
    return run;
  });
}

async function mergeRunMetadata({ runId, patch }, db = pool) {
  assertNoSecrets(patch);
  const r = await db.query(
    `UPDATE promo_snapshot_runs
        SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $2::jsonb, updated_at = NOW()
      WHERE id = $1 AND status = 'running' RETURNING *`,
    [runId, JSON.stringify(patch || {})]
  );
  return sanitizeRun(r.rows[0]);
}

// Recovery: running sem heartbeat além do teto → failed (STALE). Nunca apaga
// linha nem reabre terminal; o ponteiro do snapshot atual não é tocado.
async function reconcileStaleRunningRuns({ staleMinutes, clienteContaId = null }, db = pool) {
  const minutos = Number(staleMinutes);
  if (!Number.isInteger(minutos) || minutos <= 0) throw new Error("reconcileStaleRunningRuns: staleMinutes inválido.");
  await ensureTables(db);
  const r = await db.query(
    `WITH mortos AS (
       UPDATE promo_snapshot_runs
          SET status = 'failed', finished_at = NOW(), updated_at = NOW(), promovido = false,
              error_code = '${ERRO_STALE}',
              error_message = 'Run sem heartbeat além do limite (processo reiniciado ou travado); marcado como falho para liberar um novo run.'
        WHERE status = 'running'
          AND COALESCE(heartbeat_at, started_at, created_at) < NOW() - make_interval(mins => $1::int)
          AND ($2::bigint IS NULL OR cliente_conta_id = $2)
        RETURNING *
     ), tentativa AS (
       INSERT INTO promo_snapshot_contas
         (cliente_conta_id, cliente_id, marketplace, seller_id, last_attempt_run_id, last_attempt_status,
          last_attempt_at, last_error_code, updated_at)
       SELECT cliente_conta_id, cliente_id, marketplace, seller_id, id, 'failed', NOW(), '${ERRO_STALE}', NOW()
         FROM mortos
       ${CONFLITO_CONTA} DO UPDATE SET
         last_attempt_run_id = EXCLUDED.last_attempt_run_id,
         last_attempt_status = EXCLUDED.last_attempt_status,
         last_attempt_at = EXCLUDED.last_attempt_at,
         last_error_code = EXCLUDED.last_error_code,
         updated_at = NOW()
     )
     SELECT * FROM mortos`,
    [minutos, clienteContaId]
  );
  return r.rows.map(sanitizeRun);
}

// ─── Retenção ────────────────────────────────────────────────────────────────

/**
 * Poda o histórico de UMA conta, sem nunca tocar no que ainda serve:
 *   protegidos = snapshot atual e anterior (qualquer seller da conta), runs
 *                ativos, o run de origem de uma retomada em andamento e os
 *                runs interrompidos ainda retomáveis (janela de retomada +
 *                folga de 60 min).
 *   1. lotes de runs terminados não protegidos (só servem para retomada);
 *   2. linhas de promoções de runs terminados não protegidos (run falho ou
 *      não promovido — nunca o snapshot atual/anterior);
 *   3. o registro do run além dos `manterRuns` terminados mais novos (o
 *      CASCADE leva o que sobrou de linhas e lotes).
 * DELETEs curtos (no máximo PODA_LINHAS_POR_DELETE linhas cada, no máximo
 * PODA_DELETES_MAX por poda), sem transação longa e sem chamada externa;
 * idempotente. O que passar do teto fica para a próxima poda da conta
 * (`pendente: true`). Devolve as contagens.
 */
const SQL_PROTEGIDOS = `
  SELECT current_run_id AS id FROM promo_snapshot_contas WHERE cliente_conta_id = $1 AND current_run_id IS NOT NULL
  UNION SELECT previous_run_id FROM promo_snapshot_contas WHERE cliente_conta_id = $1 AND previous_run_id IS NOT NULL
  UNION SELECT id FROM promo_snapshot_runs WHERE cliente_conta_id = $1 AND status IN ('queued','running')
  UNION SELECT resumed_from_run_id FROM promo_snapshot_runs
         WHERE cliente_conta_id = $1 AND status IN ('queued','running') AND resumed_from_run_id IS NOT NULL
  UNION SELECT id FROM promo_snapshot_runs
         WHERE cliente_conta_id = $1 AND status = 'failed' AND error_code = ANY($2::text[])
           AND finished_at > NOW() - make_interval(mins => $3::int)`;

// Teto por DELETE e por poda: a instância do Render é pequena. O que sobrar
// fica para o próximo término de run da conta (`pendente: true`).
const PODA_LINHAS_POR_DELETE = 5000;
const PODA_DELETES_MAX = 20;

async function apagarEmLotes(db, sql, params, limite, orcamento) {
  let total = 0;
  while (orcamento.restantes > 0) {
    orcamento.restantes -= 1;
    // eslint-disable-next-line no-await-in-loop
    const r = await db.query(sql, [...params, limite]);
    const n = r.rowCount || 0;
    total += n;
    if (n < limite) return { total, completo: true };
  }
  return { total, completo: false };
}

async function podarHistoricoDaConta({
  clienteContaId, manterRuns, resumeMaxMinutes = 0,
  linhasPorDelete = PODA_LINHAS_POR_DELETE, deletesMax = PODA_DELETES_MAX,
}, db = pool) {
  const conta = Number(clienteContaId);
  if (!Number.isSafeInteger(conta) || conta <= 0) throw new Error("podarHistoricoDaConta: clienteContaId é obrigatório.");
  const manter = Number(manterRuns);
  if (!Number.isInteger(manter) || manter < 1) throw new Error("podarHistoricoDaConta: manterRuns inválido.");
  const limite = Math.max(1, Math.trunc(Number(linhasPorDelete)) || PODA_LINHAS_POR_DELETE);
  const orcamento = { restantes: Math.max(3, Math.trunc(Number(deletesMax)) || PODA_DELETES_MAX) };
  const janela = Math.max(0, Math.trunc(Number(resumeMaxMinutes) || 0)) + 60;
  await ensureTables(db);
  const params = [conta, ERROS_RETOMAVEIS, janela];
  const naoProtegido = `r.cliente_conta_id = $1 AND r.status IN ('completed','partial','failed')
        AND NOT EXISTS (SELECT 1 FROM (${SQL_PROTEGIDOS}) p WHERE p.id = r.id)`;
  // 1. lotes (PK run_id+seq), no máximo `limite` por DELETE.
  const lotes = await apagarEmLotes(db,
    `DELETE FROM promo_snapshot_run_lotes
      WHERE (run_id, seq) IN (
        SELECT l.run_id, l.seq FROM promo_snapshot_run_lotes l
          JOIN promo_snapshot_runs r ON r.id = l.run_id
         WHERE ${naoProtegido}
         LIMIT $4)`,
    params, limite, orcamento);
  // 2. linhas de promoções (PK id), idem.
  const itens = await apagarEmLotes(db,
    `DELETE FROM promo_snapshot_itens
      WHERE id IN (
        SELECT i.id FROM promo_snapshot_itens i
          JOIN promo_snapshot_runs r ON r.id = i.run_id
         WHERE ${naoProtegido}
         LIMIT $4)`,
    params, limite, orcamento);
  // 3. registros de run além dos `manter` mais novos — só os já sem linhas e
  //    sem lotes (o CASCADE nunca vira um DELETE grande escondido).
  let runs = 0;
  if (orcamento.restantes > 0) {
    orcamento.restantes -= 1;
    const r = await db.query(
      `DELETE FROM promo_snapshot_runs
        WHERE id IN (
          SELECT r.id FROM promo_snapshot_runs r
           WHERE ${naoProtegido}
             AND NOT EXISTS (SELECT 1 FROM promo_snapshot_itens i WHERE i.run_id = r.id)
             AND NOT EXISTS (SELECT 1 FROM promo_snapshot_run_lotes l WHERE l.run_id = r.id)
             AND r.id NOT IN (
               SELECT k.id FROM promo_snapshot_runs k
                WHERE k.cliente_conta_id = $1 AND k.status IN ('completed','partial','failed')
                ORDER BY k.id DESC LIMIT $4)
           ORDER BY r.id
           LIMIT $5)`,
      [...params, manter, limite]
    );
    runs = r.rowCount || 0;
  }
  return {
    lotes: lotes.total, itens: itens.total, runs,
    pendente: !lotes.completo || !itens.completo || orcamento.restantes <= 0,
  };
}

// ─── Leitura do estado / snapshot ────────────────────────────────────────────

/** Ponteiro do snapshot da conta PARA ESTE SELLER (nunca o de outro seller). */
async function obterConta({ clienteContaId, marketplace = "meli", sellerId }, db = pool) {
  if (!clienteContaId) throw new Error("obterConta: clienteContaId é obrigatório.");
  if (!sellerId) throw new Error("obterConta: sellerId é obrigatório (identidade = conta + seller).");
  await ensureTables(db);
  const r = await db.query(
    `SELECT * FROM promo_snapshot_contas WHERE cliente_conta_id = $1 AND marketplace = $2 AND seller_id = $3`,
    [clienteContaId, marketplace, String(sellerId)]
  );
  return sanitizeConta(r.rows[0]);
}

function linhaPublica(row) {
  return {
    itemId: row.item_id,
    promocaoChave: row.promocao_chave,
    promotionId: row.promotion_id || null,
    refId: row.ref_id || null,
    tipo: row.promotion_type || null,
    tipoConhecido: row.tipo_conhecido === true,
    nome: row.nome || null,
    status: row.status || null,
    statusExibicao: row.status_exibicao || null,
    inicio: row.data_inicio || null,
    fim: row.data_fim || null,
    precoOriginal: numOrNull(row.preco_original),
    precoFinal: numOrNull(row.preco_final),
    precoFinalFonte: row.preco_final_fonte || null,
    descontoValor: numOrNull(row.desconto_valor),
    descontoPercentual: numOrNull(row.desconto_percentual),
    sellerPercentage: numOrNull(row.seller_percentage),
    meliPercentage: numOrNull(row.meli_percentage),
    subsidioMl: numOrNull(row.subsidio_ml),
    elegivel: row.elegivel === true,
    ativa: typeof row.ativa === "boolean" ? row.ativa : null,
    programada: row.programada === true,
    naoAplicada: typeof row.nao_aplicada === "boolean" ? row.nao_aplicada : null,
    observedAt: row.observed_at || null,
    // Leitura que falhou neste run: é a última leitura boa (observedAt antigo).
    herdada: row.herdado === true,
    reaproveitadaDoRun: row.origem_run_id != null ? Number(row.origem_run_id) : null,
  };
}

/** Linhas do snapshot ATUAL da conta + seller, paginadas no servidor. */
async function listarLinhasSnapshot({ clienteContaId, sellerId, runId, page, limit, itemId = null, status = null, tipo = null }, db = pool) {
  if (!sellerId) throw new Error("listarLinhasSnapshot: sellerId é obrigatório.");
  const offset = (page - 1) * limit;
  const filtros = [clienteContaId, runId, itemId, status, tipo, String(sellerId)];
  const where = `run_id = $2 AND cliente_conta_id = $1 AND seller_id = $6
      AND ($3::text IS NULL OR item_id = $3)
      AND ($4::text IS NULL OR status = $4)
      AND ($5::text IS NULL OR promotion_type = $5)`;
  const total = await db.query(`SELECT COUNT(*)::int AS total FROM promo_snapshot_itens WHERE ${where}`, filtros);
  const rows = await db.query(
    `SELECT * FROM promo_snapshot_itens WHERE ${where}
      ORDER BY item_id ASC, promocao_chave ASC
      LIMIT $7 OFFSET $8`,
    [...filtros, limit, offset]
  );
  return { total: Number(total.rows[0]?.total || 0), linhas: rows.rows.map(linhaPublica) };
}

/**
 * Retorno ML (subsídio, R$ por unidade) das promoções EM ANDAMENTO
 * (`started`/`active`) dos anúncios informados, no snapshot atual da
 * conta+seller — UMA consulta para o lote inteiro (sem N+1). Só leitura: não
 * cria tabela nem dispara sincronização.
 *
 * Por anúncio: `promocoes` (em andamento com subsídio > 0) e `rebate` (o
 * subsídio quando há exatamente uma; null quando 0 ou quando há mais de uma,
 * porque somar/escolher seria adivinhar qual delas fixa o preço).
 *
 * @returns {Promise<Map<string,{promocoes:number, rebate:number|null}>>}
 */
async function mapRebatesAtivosPorItem({ clienteContaId, marketplace = "meli", sellerId, itemIds }, db = pool) {
  const ids = Array.from(new Set((itemIds || []).map((x) => String(x)).filter(Boolean)));
  if (!clienteContaId || !sellerId || !ids.length) return new Map();
  return lerRebatesAtivos({ clienteContaId, marketplace, sellerId, itemIds: ids }, db);
}

/**
 * Mesmo contrato, para a CONTA inteira (todos os anúncios com promoção em
 * andamento com retorno ML). Uma consulta; o resultado é limitado pelo
 * catálogo da conta (um item por linha).
 */
async function mapRebatesAtivosDaConta({ clienteContaId, marketplace = "meli", sellerId }, db = pool) {
  if (!clienteContaId || !sellerId) return new Map();
  return lerRebatesAtivos({ clienteContaId, marketplace, sellerId, itemIds: null }, db);
}

// Promoções que podem formar o preço (iniciadas, e programadas que o sale_price
// confirmou) de cada item, do snapshot ATUAL da conta + seller. Quem decide
// QUAL delas forma o preço da margem e quanto o ML compensa é o classificador
// (motorMargem/precoVigenteComposicao) — nunca "qualquer iniciada com
// subsídio" (bug de 12/11/2026: SMART iniciada a 109,51 somava retorno sobre
// um preço de 102,90 formado por campanha do vendedor).
//
// Modo conta (itemIds = null): só os itens com alguma iniciada subsidiada —
// os únicos que podem ganhar retorno (KPIs/filtro por status).
//
// Devolve Map itemId → { linhas, promocoes } e, não enumerável,
// `mapa.promoSnapshot` = { runId, snapshotAt } | null (conta sem leitura).
async function lerRebatesAtivos({ clienteContaId, marketplace, sellerId, itemIds }, db) {
  // UMA consulta: a linha da conta (estado da leitura) com as promoções do run
  // atual. Conta sem linha = sem leitura; conta com run e sem promoção = uma
  // linha com item_id nulo.
  const r = await db.query(
    `SELECT c.current_run_id, c.snapshot_at,
            p.item_id::text AS item_id, p.promotion_id, p.ref_id, p.promotion_type, p.nome, p.status,
            p.ativa, p.preco_final, p.preco_original, p.meli_percentage, p.seller_percentage,
            p.subsidio_ml, p.observed_at, p.herdado
       FROM promo_snapshot_contas c
       LEFT JOIN promo_snapshot_itens p
         ON p.run_id = c.current_run_id AND p.cliente_conta_id = c.cliente_conta_id AND p.seller_id = c.seller_id
        AND ($4::text[] IS NULL OR p.item_id = ANY($4::text[]))
        AND (LOWER(COALESCE(p.status, '')) IN ('started', 'active')
             OR (LOWER(COALESCE(p.status, '')) = 'pending' AND p.ativa IS TRUE))
        AND ($4::text[] IS NOT NULL OR p.item_id IN (
              SELECT s.item_id FROM promo_snapshot_itens s
               WHERE s.run_id = c.current_run_id AND s.cliente_conta_id = c.cliente_conta_id AND s.seller_id = c.seller_id
                 AND LOWER(COALESCE(s.status, '')) IN ('started', 'active') AND s.subsidio_ml > 0))
      WHERE c.cliente_conta_id = $1 AND c.marketplace = $2 AND c.seller_id = $3`,
    [clienteContaId, marketplace, String(sellerId), itemIds]
  );
  const rows = (r && r.rows) || [];
  const conta = rows[0] || null;
  const promoSnapshot = conta && conta.current_run_id != null
    ? { runId: Number(conta.current_run_id), snapshotAt: conta.snapshot_at || null }
    : null;
  const mapa = new Map();
  Object.defineProperty(mapa, "promoSnapshot", { value: promoSnapshot, enumerable: false });
  if (!promoSnapshot) return mapa;
  for (const row of rows) {
    if (row.item_id == null) continue;
    const id = String(row.item_id);
    const linha = {
      promotionId: row.promotion_id || null,
      refId: row.ref_id || null,
      tipo: row.promotion_type || null,
      nome: row.nome || null,
      status: row.status || null,
      ativa: typeof row.ativa === "boolean" ? row.ativa : null,
      precoFinal: numOrNull(row.preco_final),
      precoOriginal: numOrNull(row.preco_original),
      meliPercentage: numOrNull(row.meli_percentage),
      sellerPercentage: numOrNull(row.seller_percentage),
      subsidioMl: numOrNull(row.subsidio_ml),
      observedAt: row.observed_at || null,
      herdada: row.herdado === true,
    };
    const atual = mapa.get(id) || { linhas: [], promocoes: 0 };
    atual.linhas.push(linha);
    const st = String(linha.status || "").toLowerCase();
    if ((st === "started" || st === "active") && linha.subsidioMl > 0) atual.promocoes += 1;
    mapa.set(id, atual);
  }
  return mapa;
}

/**
 * Promoções ELEGÍVEIS do snapshot atual, casadas com o Margin Snapshot da
 * mesma conta — UMA consulta para a conta inteira (precificacaoOportunidadesSql).
 * O banco só seleciona (elegibilidade); LC', ΔLC, veredito, ordem e página saem
 * do `core.calcularCenario` no serviço — uma fórmula só.
 */
async function listarOportunidadesElegiveis({ clienteId, clienteContaId, sellerId, runId }, db = pool) {
  if (!sellerId) throw new Error("listarOportunidadesElegiveis: sellerId é obrigatório.");
  const { sqlOportunidadesElegiveis, lerLinhas } = require("../motorMargem/precificacao/precificacaoOportunidadesSql");
  const { sql, params } = sqlOportunidadesElegiveis({
    fonteSql: `
      SELECT p.item_id, p.promocao_chave AS chave, p.preco_final AS preco_promo, p.subsidio_ml AS retorno,
             NULL::text AS fonte_titulo, p.nome AS promo_nome, p.promotion_id AS promo_id,
             p.promotion_type AS promo_tipo, p.status AS promo_status, p.status_exibicao AS promo_status_exibicao,
             p.preco_final_fonte AS promo_preco_fonte, p.data_fim AS promo_fim, p.herdado AS promo_herdado,
             p.observed_at AS promo_observado_em, p.preco_original AS promo_preco_original
        FROM promo_snapshot_itens p
       WHERE p.run_id = $1 AND p.cliente_conta_id = $2 AND p.seller_id = $3
         AND p.preco_final > 0 AND p.status IN ('candidate','started','active','pending')`,
    paramsFonte: [runId, clienteContaId, String(sellerId)],
    clienteContaId,
    clienteId,
  });
  return { rows: lerLinhas(await db.query(sql, params)) };
}

/**
 * Contas elegíveis para sincronização automática: MELI, ativas, cliente
 * ativo, com seller vinculado e grant utilizável (credenciais presentes e
 * status não permanente), sem run ativo DO SELLER ATUAL, com snapshot do
 * seller atual vencido ou inexistente e fora da espera pós-falha. Vencidas
 * primeiro. (Run ativo de um seller anterior é encerrado no enqueue.)
 */
async function listarContasElegiveis({ limit, failedRetryMinutes, clientesPiloto, contasPiloto = [] }, db = pool) {
  await ensureTables(db);
  // Allowlist do piloto (slugs em minúsculas): lista vazia = nenhuma conta;
  // `*` na lista = todos os clientes (o resto da elegibilidade continua).
  const slugs = Array.isArray(clientesPiloto) ? clientesPiloto.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
  // Allowlist de contas (cliente_conta_id): soma-se à de clientes.
  const contas = Array.isArray(contasPiloto) ? contasPiloto.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : [];
  if (!slugs.length && !contas.length) return [];
  const r = await db.query(
    `SELECT c.id AS cliente_conta_id, c.cliente_id, cl.slug AS cliente_slug, c.external_account_id AS seller_id,
            s.fresh_until
       FROM cliente_contas c
       JOIN clientes cl ON cl.id = c.cliente_id
       LEFT JOIN promo_snapshot_contas s
         ON s.cliente_conta_id = c.id AND s.marketplace = 'meli' AND s.seller_id = c.external_account_id::text
      WHERE c.marketplace = 'meli' AND c.ativo = true AND COALESCE(cl.ativo, true) = true
        AND c.external_account_id IS NOT NULL AND c.external_account_id <> ''
        AND ('*' = ANY($4::text[]) OR LOWER(cl.slug) = ANY($4::text[]) OR c.id = ANY($5::bigint[]))
        AND EXISTS (
          SELECT 1 FROM ml_tokens t
           WHERE ${currentGrantSql("t")} AND t.cliente_id = c.cliente_id AND t.ml_user_id::text = c.external_account_id::text
             AND COALESCE(t.access_token, '') <> '' AND COALESCE(t.refresh_token, '') <> ''
             AND LOWER(COALESCE(t.token_status, 'valid')) NOT IN ('revoked','blocked','invalid'))
        AND NOT EXISTS (
          SELECT 1 FROM promo_snapshot_runs r
           WHERE r.cliente_conta_id = c.id AND r.tipo = $2 AND r.status IN ('queued','running')
             AND r.seller_id = c.external_account_id::text)
        AND (s.fresh_until IS NULL OR s.fresh_until < NOW())
        AND NOT (COALESCE(s.last_attempt_status, '') IN ('failed','partial')
                 AND s.last_attempt_at > NOW() - make_interval(mins => $3::int))
      ORDER BY s.fresh_until ASC NULLS FIRST, c.id ASC
      LIMIT $1`,
    [limit, TIPO, failedRetryMinutes, slugs, contas]
  );
  return r.rows.map((row) => ({
    clienteContaId: Number(row.cliente_conta_id),
    clienteId: Number(row.cliente_id),
    clienteSlug: row.cliente_slug,
    sellerId: String(row.seller_id),
  }));
}

module.exports = {
  TIPO,
  ESTADOS_ATIVOS,
  ERRO_STALE,
  ERRO_WORKER_PARADO,
  ERRO_SELLER_SUBSTITUIDO,
  ERRO_SELLER_DIVERGENTE,
  ERROS_RETOMAVEIS,
  ensureTables,
  sanitizeRun,
  sanitizeConta,
  assertNoSecrets,
  createRun,
  findActiveRun,
  getRunById,
  findLatestFinishedRun,
  findResumableRun,
  encerrarRunsDeOutroSeller,
  claimNextQueuedRun,
  touchHeartbeat,
  registrarTotal,
  registrarLote,
  copiarLotesRetomados,
  finalizarRun,
  marcarFalhou,
  mergeRunMetadata,
  reconcileStaleRunningRuns,
  podarHistoricoDaConta,
  obterConta,
  listarLinhasSnapshot,
  listarOportunidadesElegiveis,
  mapRebatesAtivosPorItem,
  mapRebatesAtivosDaConta,
  listarContasElegiveis,
  linhaPublica,
  COLUNAS_ITEM,
};
