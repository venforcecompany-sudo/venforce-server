// server/tests/helpers/marginSnapshotFakeDb.js
// Fake db em memória para exercitar marginSnapshotRepository/
// marginSnapshotRunRepository (M1) e marginSnapshotRunService/
// marginSnapshotWorker (M2) sem Postgres real — mesmo espírito de
// tests/helpers/mpSettlementFakeDb.js, mas implementando de verdade a
// semântica de UNIQUE INDEX/UPSERT/transição de estado/claim atômico que os
// testes precisam provar (idempotência, isolamento de conta, dedupe de run
// ativo, claim exclusivo).
//
// Não é executado como teste (run-all.js só roda *.test.js na raiz de
// tests/, não em subpastas).

// ── Avaliador das condições geradas por marginSnapshotRepository.
// montarFiltroSnapshots (M5/M6). O builder SÓ produz estes formatos; o fake
// os interpreta com a mesma semântica do Postgres (NULL nunca casa em
// comparação, ILIKE com escape por barra invertida, NULLS LAST).
function likeParaRegex(padrao) {
  let re = "";
  for (let i = 0; i < padrao.length; i += 1) {
    const ch = padrao[i];
    if (ch === "\\" && i + 1 < padrao.length) { re += padrao[i + 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); i += 1; }
    else if (ch === "%") re += ".*";
    else if (ch === "_") re += ".";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "is");
}

function avaliarCondicao(cond, row, params) {
  let m;
  const p = (n) => params[Number(n) - 1];
  if ((m = cond.match(/^(\w+) = \$(\d+)$/))) return row[m[1]] === p(m[2]);
  if ((m = cond.match(/^(\w+) IS NULL$/))) return row[m[1]] === null || row[m[1]] === undefined;
  if ((m = cond.match(/^(\w+) IS NOT NULL$/))) return row[m[1]] !== null && row[m[1]] !== undefined;
  if ((m = cond.match(new RegExp(`^${EXPR_STATUS_EFETIVO} = ANY\\(\\$(\\d+)::text\\[\\]\\)$`)))) {
    return p(m[3]).includes(statusEfetivo(row, params, m[1], m[2]));
  }
  if ((m = cond.match(/^(\w+) = ANY\(\$(\d+)::text\[\]\)$/))) return p(m[2]).includes(row[m[1]]);
  if ((m = cond.match(/^\(quality_json->>'statusAnuncio'\) = ANY\(\$(\d+)::text\[\]\)$/))) {
    return p(m[1]).includes(row.quality_json && row.quality_json.statusAnuncio);
  }
  if ((m = cond.match(/^(\w+) (>=|<=|<|>) \$(\d+)$/))) {
    const v = row[m[1]];
    if (v === null || v === undefined) return false;
    const alvo = Number(p(m[3]));
    return m[2] === ">=" ? v >= alvo : m[2] === "<=" ? v <= alvo : m[2] === "<" ? v < alvo : v > alvo;
  }
  if ((m = cond.match(/^\((.+)\)$/)) && / ILIKE \$\d+/.test(cond)) {
    return m[1].split(" OR ").some((parte) => {
      const mm = parte.trim().match(/^(\w+) ILIKE \$(\d+)$/);
      if (!mm) throw new Error(`marginSnapshotFakeDb: ILIKE não suportado -> ${parte}`);
      const v = row[mm[1]];
      return v !== null && v !== undefined && likeParaRegex(p(mm[2])).test(String(v));
    });
  }
  throw new Error(`marginSnapshotFakeDb: condição não suportada -> ${cond}`);
}

// Status EFETIVO (statusOverrides do builder): COALESCE(($novos)[array_position($ids, item_id)], status).
// Mesma semântica do Postgres: item sem override cai no status persistido.
const EXPR_STATUS_EFETIVO = "COALESCE\\(\\(\\$(\\d+)::text\\[\\]\\)\\[array_position\\(\\$(\\d+)::text\\[\\], item_id\\)\\], status\\)";
function statusEfetivo(row, params, iNovos, iIds) {
  const i = params[Number(iIds) - 1].indexOf(row.item_id);
  return i >= 0 ? params[Number(iNovos) - 1][i] : row.status;
}

function filtrarPorWhere(sql, linhas, params) {
  // O WHERE principal é o que vem depois do FROM (os `FILTER (WHERE …)` dos
  // KPIs ficam antes dele).
  const where = sql.match(/FROM margin_projection_snapshots\s+WHERE ([\s\S]+?)(?:\s+ORDER BY|\s+GROUP BY|\s+LIMIT|$)/);
  if (!where) return linhas;
  const condicoes = where[1].split(/\s+AND\s+/).map((c) => c.trim());
  return linhas.filter((row) => condicoes.every((c) => avaliarCondicao(c, row, params)));
}

// Divide por vírgula fora de parênteses/colchetes (ARRAY[...] tem vírgulas).
function dividirNivelZero(texto) {
  const partes = [];
  let nivel = 0;
  let atual = "";
  for (const ch of texto) {
    if (ch === "(" || ch === "[") nivel += 1;
    if (ch === ")" || ch === "]") nivel -= 1;
    if (ch === "," && nivel === 0) { partes.push(atual); atual = ""; } else atual += ch;
  }
  if (atual.trim()) partes.push(atual);
  return partes;
}

function ordenarPorOrderBy(sql, linhas, params = []) {
  const m = sql.match(/ORDER BY ([\s\S]+?)\s+LIMIT/);
  if (!m) return linhas;
  const chaves = dividirNivelZero(m[1]).map((parte) => {
    const texto = parte.trim();
    // array_position(ARRAY['A','B',...]::text[], coluna) — ranking por enum.
    const ap = texto.match(/^array_position\(ARRAY\[([^\]]+)\]::text\[\], (\w+)\) (ASC|DESC)(?: NULLS (LAST|FIRST))?$/);
    if (ap) {
      const ordem = ap[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
      const idx = (row) => { const i = ordem.indexOf(row[ap[2]]); return i === -1 ? null : i + 1; };
      return { valor: idx, dir: ap[3], nulls: ap[4] || (ap[3] === "ASC" ? "LAST" : "FIRST") };
    }
    // Worklist: CASE de status (persistido ou efetivo) e receita por MLB num parâmetro JSON.
    const cs = texto.match(/^CASE WHEN (status|COALESCE\(.+?, status\)) = 'LOSS' THEN 0 WHEN \1 = 'LOW_MARGIN' THEN 1 ELSE 2 END (ASC|DESC)$/);
    if (cs) {
      const ef = cs[1].match(new RegExp(`^${EXPR_STATUS_EFETIVO}$`));
      const st = (row) => (ef ? statusEfetivo(row, params, ef[1], ef[2]) : row.status);
      return { valor: (row) => { const x = st(row); return x === "LOSS" ? 0 : x === "LOW_MARGIN" ? 1 : 2; }, dir: cs[2], nulls: "LAST" };
    }
    const rc = texto.match(/^COALESCE\(\(\$(\d+)::jsonb ->> item_id\)::numeric, 0\) (ASC|DESC)$/);
    if (rc) {
      const mapa = JSON.parse(params[Number(rc[1]) - 1] || "{}");
      return { valor: (row) => (mapa[row.item_id] === undefined || mapa[row.item_id] === null ? 0 : Number(mapa[row.item_id])), dir: rc[2], nulls: "LAST" };
    }
    const apEf = texto.match(new RegExp(`^array_position\\(ARRAY\\[([^\\]]+)\\]::text\\[\\], ${EXPR_STATUS_EFETIVO}\\) (ASC|DESC)(?: NULLS (LAST|FIRST))?$`));
    if (apEf) {
      const ordem = apEf[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
      const idx = (row) => { const i = ordem.indexOf(statusEfetivo(row, params, apEf[2], apEf[3])); return i === -1 ? null : i + 1; };
      return { valor: idx, dir: apEf[4], nulls: apEf[5] || (apEf[4] === "ASC" ? "LAST" : "FIRST") };
    }
    // P0 04/11/2026: margem/lucro "confiáveis" — linha com comissão/frete
    // assumidos como 0 (assumed_json) ordena como sem margem.
    const cf = texto.match(/^\(CASE WHEN \(assumed_json \? 'commission' OR \(assumed_json \? 'freight' AND COALESCE\(quality_json->>'freteAplicavel' = 'true', false\)\)\) THEN NULL ELSE (\w+) END\) (ASC|DESC)(?: NULLS (LAST|FIRST))?$/);
    if (cf) {
      return { valor: (row) => (custoMarketplaceAssumido(row) ? null : row[cf[1]]), dir: cf[2], nulls: cf[3] || (cf[2] === "ASC" ? "LAST" : "FIRST") };
    }
    const mm = texto.match(/^(\w+) (ASC|DESC)(?: NULLS (LAST|FIRST))?$/);
    if (!mm) throw new Error(`marginSnapshotFakeDb: ORDER BY não suportado -> ${texto}`);
    return { valor: (row) => row[mm[1]], dir: mm[2], nulls: mm[3] || (mm[2] === "ASC" ? "LAST" : "FIRST") };
  });
  return linhas.slice().sort((a, b) => {
    for (const { valor, dir, nulls } of chaves) {
      const va = valor(a); const vb = valor(b);
      const na = va === null || va === undefined; const nb = vb === null || vb === undefined;
      if (na && nb) continue;
      if (na) return nulls === "LAST" ? 1 : -1;
      if (nb) return nulls === "LAST" ? -1 : 1;
      const x = va instanceof Date ? va.getTime() : va;
      const y = vb instanceof Date ? vb.getTime() : vb;
      if (x < y) return dir === "ASC" ? -1 : 1;
      if (x > y) return dir === "ASC" ? 1 : -1;
    }
    return 0;
  });
}

// Mesma regra de services/motorMargem/margemConfiavel (SQL_CUSTO_MARKETPLACE_AUSENTE):
// comissão assumida sempre; frete só quando quality_json.freteAplicavel = true.
function custoMarketplaceAssumido(row) {
  const a = Array.isArray(row.assumed_json) ? row.assumed_json : [];
  if (a.includes("commission")) return true;
  const q = row.quality_json && typeof row.quality_json === "object" ? row.quality_json : {};
  return a.includes("freight") && q.freteAplicavel === true;
}

function makeMarginSnapshotFakeDb() {
  const runs = [];
  const snapshots = [];
  let nextRunId = 1;
  let nextSnapshotId = 1;

  async function query(sqlBruto, params = []) {
    const sql = String(sqlBruto);

    // ── M5/M6: leitura da Central (condições do builder) ─────────────────
    if (sql.includes("/* ms:list */")) {
      const limit = params[params.length - 2];
      const offset = params[params.length - 1];
      const linhas = ordenarPorOrderBy(sql, filtrarPorWhere(sql, snapshots, params), params);
      return { rows: linhas.slice(offset, offset + limit).map((r) => ({ ...r })) };
    }
    if (sql.includes("/* ms:kpis */")) {
      const linhas = filtrarPorWhere(sql, snapshots, params);
      const comMargem = linhas.filter((r) => r.margin !== null && r.margin !== undefined);
      const row = {
        total: linhas.length,
        com_margem: comMargem.filter((r) => !custoMarketplaceAssumido(r)).length,
        margem_incompleta: comMargem.filter(custoMarketplaceAssumido).length,
      };
      // LC somado dos anúncios em Prejuízo (status persistido ou efetivo).
      if (/AS lc_prejuizo/.test(sql)) {
        const mEf = sql.match(new RegExp(`SUM\\(profit\\) FILTER \\(WHERE ${EXPR_STATUS_EFETIVO} = 'LOSS'\\)`));
        const st = (r) => (mEf ? statusEfetivo(r, params, mEf[1], mEf[2]) : r.status);
        row.lc_prejuizo = linhas.filter((r) => st(r) === "LOSS").reduce((soma, r) => soma + (Number(r.profit) || 0), 0);
      }
      for (const m of sql.matchAll(/COUNT\(\*\) FILTER \(WHERE (\w+) = '([^']+)'\)::int AS "(\w+)"/g)) {
        row[m[3]] = linhas.filter((r) => r[m[1]] === m[2]).length;
      }
      for (const m of sql.matchAll(new RegExp(`COUNT\\(\\*\\) FILTER \\(WHERE ${EXPR_STATUS_EFETIVO} = '([^']+)'\\)::int AS "(\\w+)"`, "g"))) {
        row[m[4]] = linhas.filter((r) => statusEfetivo(r, params, m[1], m[2]) === m[3]).length;
      }
      for (const m of sql.matchAll(/COUNT\(\*\) FILTER \(WHERE quality_json->>'statusAnuncio' = '([^']+)'\)::int AS (\w+)/g)) {
        row[m[2]] = linhas.filter((r) => r.quality_json && r.quality_json.statusAnuncio === m[1]).length;
      }
      row.ultimo_calculo = linhas.reduce((max, r) => (!max || r.calculated_at > max ? r.calculated_at : max), null);
      return { rows: [row] };
    }
    if (sql.includes("/* ms:promocionais */")) {
      const [clienteId, clienteContaId, marketplace, statuses] = params;
      return { rows: snapshots.filter((r) => Number(r.cliente_id) === Number(clienteId) && Number(r.cliente_conta_id) === Number(clienteContaId)
        && r.marketplace === marketplace && !r.catalog_missing_since && statuses.includes(r.status)
        && r.price !== null && r.price !== undefined && r.list_price !== null && r.list_price !== undefined
        && Number(r.list_price) - Number(r.price) > 0.011).map((r) => ({ ...r })) };
    }
    if (sql.includes("/* ms:por-itens */")) {
      const [clienteId, clienteContaId, marketplace, ids] = params;
      return { rows: snapshots.filter((r) => Number(r.cliente_id) === Number(clienteId) && Number(r.cliente_conta_id) === Number(clienteContaId)
        && r.marketplace === marketplace && !r.catalog_missing_since && ids.includes(r.item_id)).map((r) => ({ ...r })) };
    }
    if (sql.includes("/* ms:projecoes */")) {
      return { rows: filtrarPorWhere(sql, snapshots, params).map((r) => ({ ...r, custo_marketplace_ausente: custoMarketplaceAssumido(r) })) };
    }
    if (sql.includes("/* ms:count */")) {
      const linhas = filtrarPorWhere(sql, snapshots, params);
      const ultimo = linhas.reduce((max, r) => (!max || r.calculated_at > max ? r.calculated_at : max), null);
      return { rows: [{ total: linhas.length, ultimo_calculo: ultimo }] };
    }

    // ── M5: último run terminado / completo da conta ─────────────────────
    if (sql.includes("FROM margin_snapshot_runs") && (sql.includes("status IN ('completed','failed')") || sql.includes("AND status = 'completed'"))) {
      const [clienteId, clienteContaId, marketplace] = params;
      const aceitos = sql.includes("status IN ('completed','failed')") ? ["completed", "failed"] : ["completed"];
      const candidatos = runs
        .filter((r) => r.cliente_id === clienteId && r.cliente_conta_id === clienteContaId
          && r.marketplace === marketplace && aceitos.includes(r.status))
        .sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0) || b.id - a.id);
      return { rows: candidatos.length ? [{ ...candidatos[0] }] : [] };
    }

    // Bootstrap idempotente (ensureMarginSnapshotTables lê o .sql inteiro e
    // manda como uma única string) — no-op no fake, as tabelas já "existem"
    // como arrays em memória.
    if (sql.includes("CREATE TABLE IF NOT EXISTS margin_snapshot_runs")) {
      return { rows: [] };
    }

    // ── margin_snapshot_runs ────────────────────────────────────────────

    if (sql.includes("INSERT INTO margin_snapshot_runs")) {
      const [clienteId, clienteSlug, clienteContaId, marketplace, baseId, reason, requestedBy, metadataJson] = params;
      const conflito = runs.find((r) =>
        r.cliente_id === clienteId
        && r.cliente_conta_id === clienteContaId
        && r.marketplace === marketplace
        && (r.status === "queued" || r.status === "running")
      );
      if (conflito) {
        const err = new Error('duplicate key value violates unique constraint "uq_margin_snapshot_runs_ativo"');
        err.code = "23505";
        throw err;
      }
      const now = new Date();
      const row = {
        id: nextRunId++,
        cliente_id: clienteId, cliente_slug: clienteSlug, cliente_conta_id: clienteContaId,
        marketplace, base_id: baseId ?? null, reason, status: "queued",
        total_items: null, processed_items: 0, success_items: 0, failed_items: 0, cursor_offset: 0,
        requested_by: requestedBy ?? null,
        created_at: now, started_at: null, heartbeat_at: null, finished_at: null,
        error_code: null, error_message: null, metadata_json: metadataJson ? JSON.parse(metadataJson) : {},
        updated_at: now,
      };
      runs.push(row);
      return { rows: [{ ...row }] };
    }

    if (sql.includes("FROM margin_snapshot_runs") && sql.includes("WHERE id = $1")) {
      const [runId, clienteContaId] = params;
      const row = runs.find((r) => r.id === runId && r.cliente_conta_id === clienteContaId);
      return { rows: row ? [{ ...row }] : [] };
    }

    if (sql.includes("FROM margin_snapshot_runs") && sql.includes("status IN ('queued','running')")) {
      const [clienteId, clienteContaId, marketplace] = params;
      const candidatos = runs
        .filter((r) => r.cliente_id === clienteId && r.cliente_conta_id === clienteContaId
          && r.marketplace === marketplace && (r.status === "queued" || r.status === "running"))
        .sort((a, b) => b.id - a.id);
      return { rows: candidatos.length ? [{ ...candidatos[0] }] : [] };
    }

    if (sql.includes("UPDATE margin_snapshot_runs") && sql.includes("SET status = 'running'")
        && !sql.includes("FOR UPDATE SKIP LOCKED")) {
      const [runId] = params;
      const row = runs.find((r) => r.id === runId && r.status === "queued");
      if (!row) return { rows: [] };
      const now = new Date();
      row.status = "running"; row.started_at = now; row.heartbeat_at = now; row.updated_at = now;
      return { rows: [{ ...row }] };
    }

    // ── M2: claim atômico ────────────────────────────────────────────────
    // Espelha `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED
    // LIMIT 1) RETURNING *` — busca + mutação num único bloco síncrono (sem
    // `await` entre achar o candidato e marcá-lo `running`), a mesma
    // garantia que o Postgres dá com uma única instrução UPDATE: nenhuma
    // outra chamada pode "enxergar" o candidato entre o SELECT e o UPDATE.
    if (sql.includes("UPDATE margin_snapshot_runs") && sql.includes("FOR UPDATE SKIP LOCKED")) {
      // M3: $1 = contas excluídas do claim (em execução neste processo).
      const excluir = new Set((Array.isArray(params[0]) ? params[0] : []).map(Number));
      const candidatos = runs
        .filter((r) => r.status === "queued" && !excluir.has(Number(r.cliente_conta_id)))
        .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
      const row = candidatos[0];
      if (!row) return { rows: [] };
      const now = new Date();
      row.status = "running"; row.started_at = now; row.heartbeat_at = now; row.updated_at = now;
      return { rows: [{ ...row }] };
    }

    // ── M2: heartbeat explícito ──────────────────────────────────────────
    if (sql.includes("UPDATE margin_snapshot_runs") && sql.includes("SET heartbeat_at = NOW()")) {
      const [runId] = params;
      const row = runs.find((r) => r.id === runId && r.status === "running");
      if (!row) return { rows: [] };
      row.heartbeat_at = new Date(); row.updated_at = new Date();
      return { rows: [{ ...row }] };
    }

    if (sql.includes("UPDATE margin_snapshot_runs") && sql.includes("SET status = $2")) {
      const [runId, status, errorCode, errorMessage] = params;
      const row = runs.find((r) => r.id === runId && r.status === "running");
      if (!row) return { rows: [] };
      const now = new Date();
      row.status = status; row.finished_at = now; row.updated_at = now;
      row.error_code = errorCode ?? null; row.error_message = errorMessage ?? null;
      return { rows: [{ ...row }] };
    }

    // ── M8: reconciliação de run running sem heartbeat ────────────────────
    if (sql.includes("UPDATE margin_snapshot_runs") && sql.includes("MARGIN_SNAPSHOT_RUN_STALE_RUNNING")) {
      const [minutos, clienteId, clienteContaId] = params;
      const limite = Date.now() - Number(minutos) * 60000;
      const mortos = runs.filter((r) => {
        if (r.status !== "running") return false;
        const ref = r.heartbeat_at || r.started_at || r.created_at;
        if (!(ref instanceof Date ? ref.getTime() < limite : new Date(ref).getTime() < limite)) return false;
        if (clienteId !== null && clienteId !== undefined && r.cliente_id !== clienteId) return false;
        if (clienteContaId !== null && clienteContaId !== undefined && r.cliente_conta_id !== clienteContaId) return false;
        return true;
      });
      const now = new Date();
      for (const r of mortos) {
        r.status = "failed"; r.finished_at = now; r.updated_at = now;
        r.error_code = "MARGIN_SNAPSHOT_RUN_STALE_RUNNING";
        r.error_message = "Run sem heartbeat além do limite (processo reiniciado ou travado); marcado como falho para liberar um novo run.";
      }
      return { rows: mortos.map((r) => ({ ...r })) };
    }

    // ── M3: metadata merge (jsonb ||) ────────────────────────────────────
    if (sql.includes("UPDATE margin_snapshot_runs") && sql.includes("SET metadata_json")) {
      const [runId, patchJson] = params;
      const row = runs.find((r) => r.id === runId && r.status === "running");
      if (!row) return { rows: [] };
      row.metadata_json = { ...(row.metadata_json || {}), ...JSON.parse(patchJson || "{}") };
      row.updated_at = new Date();
      return { rows: [{ ...row }] };
    }

    if (sql.includes("UPDATE margin_snapshot_runs") && sql.includes("SET processed_items")) {
      const [runId, processedItems, successItems, failedItems, cursorOffset, totalItems] = params;
      const row = runs.find((r) => r.id === runId && r.status === "running");
      if (!row) return { rows: [] };
      row.processed_items = processedItems; row.success_items = successItems; row.failed_items = failedItems;
      row.cursor_offset = cursorOffset;
      if (totalItems != null) row.total_items = totalItems;
      row.heartbeat_at = new Date(); row.updated_at = new Date();
      return { rows: [{ ...row }] };
    }

    // ── margin_projection_snapshots ─────────────────────────────────────

    if (sql.includes("INSERT INTO margin_projection_snapshots")) {
      const [
        clienteId, clienteContaId, marketplace, itemId, sku, titulo, baseId,
        price, listPrice, promoPrice, cost, taxRate, fixedFee, commission, commissionRate, freight,
        profit, margin, marginPercent, status,
        confidenceLevel, qualityJson, missingJson, assumedJson, divergencesJson,
        observedAt, calculatedAt, sourceUpdatedAt,
        runId, refreshStatus, lastError,
        imageUrl,
      ] = params;

      let row = snapshots.find((r) =>
        r.cliente_id === clienteId && r.cliente_conta_id === clienteContaId
        && r.marketplace === marketplace && r.item_id === itemId
      );
      const now = new Date();
      const isNovo = !row;
      if (isNovo) {
        row = { id: nextSnapshotId++, cliente_id: clienteId, cliente_conta_id: clienteContaId, marketplace, item_id: itemId, created_at: now };
        snapshots.push(row);
      }
      row.sku = sku ?? null;
      row.titulo = titulo ?? null;
      row.base_id = baseId ?? null;
      row.price = price ?? null;
      row.list_price = listPrice ?? null;
      row.promo_price = promoPrice ?? null;
      row.cost = cost ?? null;
      row.tax_rate = taxRate ?? null;
      row.fixed_fee = fixedFee ?? null;
      row.commission = commission ?? null;
      row.commission_rate = commissionRate ?? null;
      row.freight = freight ?? null;
      row.profit = profit ?? null;
      row.margin = margin ?? null;
      row.margin_percent = marginPercent ?? null;
      row.status = status;
      row.confidence_level = confidenceLevel ?? null;
      row.quality_json = JSON.parse(qualityJson ?? "{}");
      row.missing_json = JSON.parse(missingJson ?? "[]");
      row.assumed_json = JSON.parse(assumedJson ?? "[]");
      row.divergences_json = JSON.parse(divergencesJson ?? "[]");
      row.observed_at = observedAt ?? null;
      row.calculated_at = calculatedAt ?? now;
      row.source_updated_at = sourceUpdatedAt ?? null;
      row.run_id = runId ?? null;
      row.refresh_status = refreshStatus;
      row.last_error = lastError ?? null;
      row.image_url = imageUrl ?? null;
      row.catalog_missing_since = null;
      row.updated_at = now;
      return { rows: [{ ...row }] };
    }

    // ── M3: falha parcial (preserva valores) ─────────────────────────────
    if (sql.includes("UPDATE margin_projection_snapshots") && sql.includes("SET refresh_status = 'failed'")) {
      const [clienteId, clienteContaId, marketplace, itemIds, lastError, runId] = params;
      const alvo = new Set(itemIds);
      const afetadas = snapshots.filter((r) => r.cliente_id === clienteId && r.cliente_conta_id === clienteContaId
        && r.marketplace === marketplace && alvo.has(r.item_id));
      for (const r of afetadas) {
        r.refresh_status = "failed"; r.last_error = lastError ?? null; r.run_id = runId ?? null; r.updated_at = new Date();
      }
      return { rows: afetadas.map((r) => ({ item_id: r.item_id })) };
    }

    // ── M3: fora do catálogo (marca, nunca apaga) ────────────────────────
    if (sql.includes("UPDATE margin_projection_snapshots") && sql.includes("SET catalog_missing_since = NOW()")) {
      const [clienteId, clienteContaId, marketplace, catalogo, runId] = params;
      const noCatalogo = new Set(catalogo);
      const afetadas = snapshots.filter((r) => r.cliente_id === clienteId && r.cliente_conta_id === clienteContaId
        && r.marketplace === marketplace && !r.catalog_missing_since && !noCatalogo.has(r.item_id));
      const now = new Date();
      for (const r of afetadas) {
        r.catalog_missing_since = now; r.refresh_status = "stale";
        r.last_error = "Item fora do catálogo (ativos + pausados) na última listagem completa.";
        r.run_id = runId ?? null; r.updated_at = now;
      }
      return { rows: afetadas.map((r) => ({ item_id: r.item_id })) };
    }

    if (sql.includes("FROM margin_projection_snapshots") && sql.includes("item_id = $3")) {
      const [clienteContaId, marketplace, itemId] = params;
      const row = snapshots.find((r) => r.cliente_conta_id === clienteContaId && r.marketplace === marketplace && r.item_id === itemId);
      return { rows: row ? [{ ...row }] : [] };
    }

    if (sql.includes("SELECT COUNT(*)::int AS total FROM margin_projection_snapshots")) {
      let clienteContaId, marketplace, status;
      if (params.length === 3) [clienteContaId, marketplace, status] = params;
      else [clienteContaId, marketplace] = params;
      const total = snapshots.filter((r) =>
        r.cliente_conta_id === clienteContaId && r.marketplace === marketplace
        && (status ? r.status === status : true)
      ).length;
      return { rows: [{ total }] };
    }

    if (sql.includes("FROM margin_projection_snapshots") && sql.includes("ORDER BY")) {
      let clienteContaId, marketplace, status, limit, offset;
      if (params.length === 5) [clienteContaId, marketplace, status, limit, offset] = params;
      else [clienteContaId, marketplace, limit, offset] = params;

      let linhas = snapshots.filter((r) =>
        r.cliente_conta_id === clienteContaId && r.marketplace === marketplace
        && (status ? r.status === status : true)
      );

      const m = sql.match(/ORDER BY (\w+) (ASC|DESC)/);
      const coluna = m ? m[1] : "updated_at";
      const dir = m ? m[2] : "DESC";
      linhas = linhas.slice().sort((a, b) => {
        const va = a[coluna]; const vb = b[coluna];
        if (va == null && vb == null) return 0;
        if (va == null) return 1; // NULLS LAST
        if (vb == null) return -1;
        if (va < vb) return dir === "ASC" ? -1 : 1;
        if (va > vb) return dir === "ASC" ? 1 : -1;
        return 0;
      });
      linhas = linhas.slice(offset, offset + limit);
      return { rows: linhas.map((r) => ({ ...r })) };
    }

    throw new Error(`marginSnapshotFakeDb: SQL nao mapeado -> ${sql.trim().slice(0, 200)}`);
  }

  return { runs, snapshots, query };
}

module.exports = { makeMarginSnapshotFakeDb };
