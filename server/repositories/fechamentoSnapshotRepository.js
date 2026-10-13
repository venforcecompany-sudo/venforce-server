// server/repositories/fechamentoSnapshotRepository.js
//
// Persistência do snapshot do fechamento (fechamento_snapshots + itens).
// SÓ INSERT e SELECT: não existe função de UPDATE — e o trigger da migration
// recusa UPDATE no banco também. Uma correção é uma revisão NOVA.
//
// `db` é injetável (pool real, PGlite ou fake de teste), no mesmo padrão de
// schemaEnsure: pool → conexão dedicada para a transação; objeto sem
// `connect` → a própria `db` é a sessão.

"use strict";

const pool = require("../config/database");
const { ensureFechamentoSnapshotsSchema } = require("../services/schema/schemaEnsure");

// Linhas por INSERT: um parâmetro jsonb por lote mantém a query pequena e o
// número de round-trips baixo (20 mil linhas = 10 INSERTs).
const LOTE_ITENS = 2000;

const COLUNAS_META = `
  s.id, s.cliente_id, s.cliente_slug, s.cliente_conta_id, s.marketplace, s.periodo, s.revisao,
  s.total_itens, s.contagens_json, s.origem_custos_json, s.ajustes_json, s.arquivos_json,
  s.origem, s.processado_em, s.processado_por, s.criado_por, s.criado_por_email, s.created_at`;

// As entregas (apresentações) que apontam para cada snapshot — é daqui que
// sai "Publicado: v1". Agregado em SQL para a lista não fazer N+1.
const ENTREGAS_DO_SNAPSHOT = `
  COALESCE((
    SELECT json_agg(json_build_object(
             'id', e.id, 'publicado', e.publicado, 'status', e.status,
             'temLink', e.token_publico IS NOT NULL, 'publishedAt', e.published_at,
             'createdAt', e.created_at
           ) ORDER BY e.id)
      FROM entregas_cliente e
     WHERE e.snapshot_id = s.id
  ), '[]'::json) AS entregas`;

async function garantirSchema(db) {
  await ensureFechamentoSnapshotsSchema(db);
}

async function comTransacao(db, fn) {
  const usaPool = typeof db.connect === "function" && typeof db.release !== "function";
  const client = usaPool ? await db.connect() : db;
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) { /* conexão já pode ter caído */ }
    throw err;
  } finally {
    if (usaPool && typeof client.release === "function") client.release();
  }
}

// Cria a PRÓXIMA revisão de (conta, competência).
//
// Concorrência: o advisory lock de transação serializa dois "Salvar" da mesma
// conta+competência (duas abas, dois operadores); a 2ª espera e numera depois
// da 1ª. A UNIQUE (cliente_conta_id, periodo, revisao) é a última barreira.
//
// Idempotência: se a última revisão já tem o MESMO selo (o mesmo
// processamento salvo de novo — duplo clique, retry de rede), devolve ela em
// vez de criar uma cópia idêntica.
async function criarSnapshot(meta, itens, db = pool) {
  await garantirSchema(db);
  return comTransacao(db, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `vf:fechamento-snapshot:${meta.clienteContaId}:${meta.periodo}`,
    ]);

    const ultima = await client.query(
      `SELECT id, revisao, selo FROM fechamento_snapshots
        WHERE cliente_conta_id = $1 AND periodo = $2
        ORDER BY revisao DESC LIMIT 1`,
      [meta.clienteContaId, meta.periodo]
    );
    const anterior = ultima.rows[0] || null;
    if (anterior && anterior.selo === meta.selo) {
      const { rows } = await client.query(`SELECT ${COLUNAS_META}, ${ENTREGAS_DO_SNAPSHOT} FROM fechamento_snapshots s WHERE s.id = $1`, [anterior.id]);
      return { snapshot: rows[0], reaproveitado: true };
    }
    const revisao = (anterior ? Number(anterior.revisao) : 0) + 1;

    const ins = await client.query(
      `INSERT INTO fechamento_snapshots
         (cliente_id, cliente_slug, cliente_conta_id, marketplace, periodo, revisao,
          summary_json, origem_custos_json, ajustes_json, arquivos_json, diagnostico_json,
          contagens_json, total_itens, selo, origem, processado_em, processado_por,
          criado_por, criado_por_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,
               $12::jsonb,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [
        meta.clienteId, meta.clienteSlug, meta.clienteContaId, meta.marketplace, meta.periodo, revisao,
        JSON.stringify(meta.summary ?? {}),
        JSON.stringify(meta.origemCustos ?? {}),
        JSON.stringify(meta.ajustes ?? {}),
        JSON.stringify(meta.arquivos ?? []),
        JSON.stringify(meta.diagnostico ?? {}),
        JSON.stringify(meta.contagens ?? {}),
        itens.length,
        meta.selo,
        meta.origem || "financeiro-v3",
        meta.processadoEm,
        meta.processadoPor ?? null,
        meta.criadoPor ?? null,
        meta.criadoPorEmail ?? null,
      ]
    );
    const snapshotId = ins.rows[0].id;

    for (let i = 0; i < itens.length; i += LOTE_ITENS) {
      const lote = itens.slice(i, i + LOTE_ITENS);
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO fechamento_snapshot_itens
           (snapshot_id, ordem, formato, titulo, item_id, model_id, sku, pedido_id,
            receita, lc, mc, status_custo, status_financeiro, status_principal,
            cancelado, busca, linha)
         SELECT $1, x.ordem, x.formato, x.titulo, x.item_id, x.model_id, x.sku, x.pedido_id,
                x.receita, x.lc, x.mc, x.status_custo, x.status_financeiro, x.status_principal,
                x.cancelado, x.busca, x.linha
           FROM jsonb_to_recordset($2::jsonb) AS x(
             ordem int, formato text, titulo text, item_id text, model_id text, sku text,
             pedido_id text, receita numeric, lc numeric, mc numeric, status_custo text,
             status_financeiro text, status_principal text, cancelado boolean, busca text,
             linha jsonb)`,
        [snapshotId, JSON.stringify(lote)]
      );
    }

    const { rows } = await client.query(`SELECT ${COLUNAS_META}, ${ENTREGAS_DO_SNAPSHOT} FROM fechamento_snapshots s WHERE s.id = $1`, [snapshotId]);
    return { snapshot: rows[0], reaproveitado: false };
  });
}

// Revisões de UMA conta (nunca do cliente inteiro: contas não se misturam),
// mais recentes primeiro. Com `periodo`, só aquela competência. Traz o
// summary — é pequeno (dezenas de chaves) e o histórico mostra os números.
async function listarSnapshotsDaConta({ clienteContaId, periodo = null, limit = 120 }, db = pool) {
  await garantirSchema(db);
  const params = [clienteContaId];
  let filtro = "";
  if (periodo) {
    params.push(periodo);
    filtro = ` AND s.periodo = $${params.length}`;
  }
  params.push(Math.min(Math.max(parseInt(limit, 10) || 120, 1), 500));
  const { rows } = await db.query(
    `SELECT ${COLUNAS_META}, s.summary_json, ${ENTREGAS_DO_SNAPSHOT}
       FROM fechamento_snapshots s
      WHERE s.cliente_conta_id = $1${filtro}
      ORDER BY s.periodo DESC, s.revisao DESC
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function buscarSnapshot(id, db = pool) {
  await garantirSchema(db);
  const { rows } = await db.query(
    `SELECT ${COLUNAS_META}, s.summary_json, s.diagnostico_json, s.selo, ${ENTREGAS_DO_SNAPSHOT}
       FROM fechamento_snapshots s WHERE s.id = $1`,
    [id]
  );
  return rows[0] || null;
}

// Itens paginados no backend. `status` = status_principal (os mesmos filtros
// da tela) ou "cancelados"; `busca` = mesma busca sem acento da tela.
// Devolve a linha do MOTOR (`linha`) — é ela que a tela normaliza — e o total
// do recorte, para a paginação.
async function listarItens({ snapshotId, offset = 0, limit = 50, status = null, busca = "" }, db = pool) {
  await garantirSchema(db);
  const params = [snapshotId];
  const where = ["snapshot_id = $1"];
  if (status === "cancelados") {
    where.push("cancelado = true");
  } else if (status) {
    params.push(status);
    where.push(`status_principal = $${params.length}`);
  }
  if (busca) {
    params.push(`%${String(busca).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`busca LIKE $${params.length}`);
  }
  const whereSql = where.join(" AND ");
  const total = await db.query(`SELECT COUNT(*)::int AS total FROM fechamento_snapshot_itens WHERE ${whereSql}`, params);
  params.push(limit);
  const iLimit = params.length;
  params.push(offset);
  const iOffset = params.length;
  const { rows } = await db.query(
    `SELECT ordem, linha FROM fechamento_snapshot_itens
      WHERE ${whereSql}
      ORDER BY ordem
      LIMIT $${iLimit} OFFSET $${iOffset}`,
    params
  );
  return { total: total.rows[0]?.total || 0, itens: rows };
}

// Snapshot (id, conta, competência, cliente) para validar o vínculo de uma
// entrega. Leve: sem summary.
async function buscarIdentidadeDoSnapshot(id, db = pool) {
  await garantirSchema(db);
  const { rows } = await db.query(
    `SELECT id, cliente_id, cliente_conta_id, periodo, marketplace, revisao, summary_json
       FROM fechamento_snapshots WHERE id = $1`,
    [id]
  );
  return rows[0] || null;
}

module.exports = {
  criarSnapshot,
  listarSnapshotsDaConta,
  buscarSnapshot,
  listarItens,
  buscarIdentidadeDoSnapshot,
  LOTE_ITENS,
};
