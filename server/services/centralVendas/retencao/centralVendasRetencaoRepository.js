// server/services/centralVendas/retencao/centralVendasRetencaoRepository.js
// Retenção da Central de Vendas — LEITURAS para o planner e o relatório.
//
// Nada aqui escreve (o único DELETE da retenção mora no executor). Toda função
// recebe `db` explícito: o CLI passa um client dentro de uma transação READ
// ONLY no dry-run; o executor passa o client da transação do lote.
//
// Escopo (`escopo`): { tupla } | { clienteSlug?, contaId? }. contaId === null
// significa "só legado (cliente_conta_id IS NULL)"; undefined = sem filtro.

const fs = require("fs");
const path = require("path");

const COLUNAS_IMPORT = `id, cliente_slug, marketplace, competencia, cliente_conta_id, publication_status,
       coverage_date_from, coverage_date_to, published_at, created_at, sync_run_id`;

function escopoImportsSql(escopo = {}, params, alias = "") {
  const a = alias ? `${alias}.` : "";
  const cond = [];
  if (escopo.tupla) {
    const t = escopo.tupla;
    params.push(t.cliente_slug); cond.push(`${a}cliente_slug = $${params.length}`);
    params.push(t.marketplace); cond.push(`${a}marketplace = $${params.length}`);
    params.push(String(t.competencia).trim()); cond.push(`${a}competencia = $${params.length}`);
    params.push(t.cliente_conta_id == null ? null : Number(t.cliente_conta_id));
    cond.push(`${a}cliente_conta_id IS NOT DISTINCT FROM $${params.length}::bigint`);
    return cond.join(" AND ");
  }
  if (escopo.clienteSlug) { params.push(escopo.clienteSlug); cond.push(`${a}cliente_slug = $${params.length}`); }
  if (escopo.contaId === null) cond.push(`${a}cliente_conta_id IS NULL`);
  else if (escopo.contaId !== undefined) { params.push(Number(escopo.contaId)); cond.push(`${a}cliente_conta_id = $${params.length}`); }
  return cond.length ? cond.join(" AND ") : "TRUE";
}

// Runs "do escopo" que podem ter mp_payments a limpar mesmo sem import (runs
// sem import nenhum). Escopo de tupla: só os runs dos imports da tupla.
function escopoRunsSql(escopo = {}, params) {
  if (escopo.tupla) return "FALSE";
  const cond = [];
  if (escopo.clienteSlug) { params.push(escopo.clienteSlug); cond.push(`r.cliente_slug = $${params.length}`); }
  if (escopo.contaId === null) cond.push("r.cliente_conta_id IS NULL");
  else if (escopo.contaId !== undefined) { params.push(Number(escopo.contaId)); cond.push(`r.cliente_conta_id = $${params.length}`); }
  return cond.length ? cond.join(" AND ") : "TRUE";
}

// forUpdate: trava as linhas da tupla (ORDER BY id) com NOWAIT — a retenção
// nunca ESPERA por lock: se a publicação/sync estiver mexendo na tupla, o
// lote é adiado (55P03) em vez de entrar num ciclo de espera que o detector de
// deadlock poderia resolver abortando a publicação.
async function carregarImports(db, { escopo = {}, forUpdate = false } = {}) {
  const params = [];
  const where = escopoImportsSql(escopo, params);
  const { rows } = await db.query(
    `SELECT ${COLUNAS_IMPORT}
       FROM central_vendas_imports
      WHERE ${where}
      ORDER BY id${forUpdate ? " FOR UPDATE NOWAIT" : ""}`,
    params
  );
  return rows;
}

async function carregarRuns(db, { runIds = [], escopo = {} } = {}) {
  const params = [runIds.map(Number)];
  const escopoRuns = escopoRunsSql(escopo, params);
  const { rows } = await db.query(
    `SELECT r.id, r.status, r.created_at, r.finished_at, r.cliente_conta_id, r.cliente_slug,
            EXISTS (SELECT 1 FROM central_vendas_mp_payments p WHERE p.sync_run_id = r.id) AS tem_mp_payments
       FROM central_vendas_sync_runs r
      WHERE r.id = ANY($1::bigint[])
         OR ((${escopoRuns}) AND EXISTS (SELECT 1 FROM central_vendas_mp_payments p WHERE p.sync_run_id = r.id))
      ORDER BY r.id`,
    params
  );
  return rows;
}

// Runs (com mp_payments) citados por imports FORA do escopo carregado — um
// run pode gerar imports em várias competências; limpar a tupla de setembro
// não pode apagar o mp_payments que o vigente de outubro ainda lê.
async function carregarRunsReferenciadosForaDoEscopo(db, { runIds = [], escopo = {} } = {}) {
  if (!runIds.length) return new Set();
  const params = [runIds.map(Number)];
  const where = escopoImportsSql(escopo, params);
  const { rows } = await db.query(
    `SELECT DISTINCT sync_run_id
       FROM central_vendas_imports
      WHERE sync_run_id = ANY($1::bigint[])
        AND NOT (${where})`,
    params
  );
  return new Set(rows.map((r) => Number(r.sync_run_id)));
}

// ── Referências protegidas ────────────────────────────────────────────────
// Busca (grep -a em server/ e Portal/, out/2026) por import_id/importId/
// centralImport fora das tabelas central_vendas_*:
//   cliente_360_resumos_mensais.payload_json.centralVendas.contas[].importId
//     → snapshot do Painel de Contas (painelContasRepository.mapRow →
//       centralImportIds; comparado em painelContasOperacional).
//   cliente_360_sync_jobs.payload_json.importIds[] → auditoria do job do
//     Cliente 360 (gravado por finalizeSyncJob; nenhum leitor do campo).
//     NÃO protege por padrão (decisão do Maestro, 29/10/2026: em produção
//     1.248 jobs citavam 1.304 imports / 614.340 pedidos ≈ 79% do que a
//     retenção deve liberar; a linha do job continua sendo a auditoria). Só
//     protege com incluirAuditoriaSyncJobs=true (--proteger-auditoria-sync-jobs);
//     desligada, é lida como citação INFORMATIVA (relatório do dry-run).
//   entregas_cliente.payload_json → nenhum gravador de importId hoje; varrido
//     por garantia (o Financeiro exibe motor.importId e poderia salvá-lo).
//   margin_snapshot_*, sentinel_*, fechamento_incidentes, financeiro_ads_cache
//     → nenhuma coluna/campo de import (sem busca em runtime).
// A extração é GENÉRICA por chave em qualquer profundidade (importId,
// importIds[], centralImportIds[], import_id): um campo novo com esses nomes
// passa a proteger sozinho.
const FONTES_REFS = [
  { fonte: "painel_contas_snapshot", tabela: "cliente_360_resumos_mensais", colunaSlug: "cliente_slug" },
  { fonte: "cliente360_sync_job", tabela: "cliente_360_sync_jobs", colunaSlug: "cliente_slug", auditoria: true },
  { fonte: "entregas_cliente", tabela: "entregas_cliente", colunaSlug: null },
];

const CAMINHOS_REF = ["lax $.**.importId", "lax $.**.importIds[*]", "lax $.**.centralImportIds[*]", "lax $.**.import_id"];

async function tabelaExiste(db, tabela) {
  const { rows } = await db.query("SELECT to_regclass($1) IS NOT NULL AS existe", [`public.${tabela}`]);
  return Boolean(rows[0]?.existe);
}

// refs = só as fontes que PROTEGEM; citacoes = tudo que foi lido (inclusive a
// auditoria informativa) — o relatório usa citacoes para "citadosSoPorAuditoria".
// lerInformativas=false pula a leitura de fonte que não protege (lote do apply).
async function carregarRefsProtegidas(db, { clienteSlugs = null, incluirAuditoriaSyncJobs = false, lerInformativas = true } = {}) {
  const refs = new Map();
  const citacoes = new Map();
  const fontesLidas = [];
  for (const f of FONTES_REFS) {
    const protege = !f.auditoria || incluirAuditoriaSyncJobs;
    if (!protege && !lerInformativas) { fontesLidas.push({ fonte: f.fonte, lida: false, protege, motivo: "nao_protege" }); continue; }
    if (!(await tabelaExiste(db, f.tabela))) { fontesLidas.push({ fonte: f.fonte, lida: false, protege, motivo: "tabela_ausente" }); continue; }
    const params = [];
    let filtro = "";
    if (clienteSlugs && f.colunaSlug) {
      params.push(clienteSlugs);
      filtro = `WHERE t.${f.colunaSlug} = ANY($1::text[])`;
    }
    const lateral = CAMINHOS_REF.map((c) => `SELECT jsonb_path_query(t.payload_json, '${c}') AS v`).join(" UNION ALL ");
    const { rows } = await db.query(
      `SELECT DISTINCT x.v #>> '{}' AS ref
         FROM ${f.tabela} t
         CROSS JOIN LATERAL (${lateral}) x
         ${filtro}`,
      params
    );
    let n = 0;
    for (const r of rows) {
      if (!/^\d+$/.test(String(r.ref || ""))) continue;
      const id = Number(r.ref);
      for (const mapa of protege ? [refs, citacoes] : [citacoes]) {
        if (!mapa.has(id)) mapa.set(id, []);
        if (!mapa.get(id).includes(f.fonte)) mapa.get(id).push(f.fonte);
      }
      n += 1;
    }
    fontesLidas.push({ fonte: f.fonte, lida: true, protege, idsCitados: n });
  }
  return { refs, citacoes, fontesLidas };
}

// ── Estimativa de espaço ──────────────────────────────────────────────────
// bytes ≈ média de pg_column_size(linha) (amostra) × linhas + índices da
// tabela proporcionais às linhas. É ESTIMATIVA. DELETE libera espaço para
// REUSO dentro das mesmas tabelas/índices (após autovacuum): o arquivo NÃO
// encolhe e o tamanho do banco não cai sem VACUUM FULL / pg_repack.
const TABELAS_IMPORT = {
  imports: "central_vendas_imports",
  pedidos: "central_vendas_pedidos",
  itens: "central_vendas_pedido_itens",
  componentes: "central_vendas_componentes",
};
const TABELAS_MP = { mp_payments: "central_vendas_mp_payments", mp_payment_charges: "central_vendas_mp_payment_charges" };

async function estatisticasTabela(db, tabela) {
  const meta = await db.query(
    `SELECT GREATEST(c.reltuples, 0)::float AS reltuples, pg_indexes_size(c.oid)::float AS indices,
            pg_total_relation_size(c.oid)::float AS total
       FROM pg_class c WHERE c.oid = to_regclass($1)`,
    [`public.${tabela}`]
  );
  let amostra = await db.query(
    `SELECT AVG(pg_column_size(t.*))::float AS media, COUNT(*)::int AS n
       FROM (SELECT * FROM ${tabela} TABLESAMPLE SYSTEM (1) LIMIT 5000) t`
  );
  if (!amostra.rows[0].n) {
    amostra = await db.query(`SELECT AVG(pg_column_size(t.*))::float AS media, COUNT(*)::int AS n FROM (SELECT * FROM ${tabela} LIMIT 5000) t`);
  }
  const m = meta.rows[0] || {};
  return {
    tabela,
    reltuples: Number(m.reltuples) || 0,
    indicesBytes: Number(m.indices) || 0,
    totalBytes: Number(m.total) || 0,
    mediaLinhaBytes: Number(amostra.rows[0].media) || 0,
  };
}

function bytesEstimados(stats, linhas) {
  const base = Math.max(stats.reltuples, linhas, 1);
  return Math.round(stats.mediaLinhaBytes * linhas + stats.indicesBytes * (linhas / base));
}

async function contarFilhosPorImport(db, importIds) {
  const porImport = new Map(importIds.map((id) => [Number(id), { imports: 1, pedidos: 0, itens: 0, componentes: 0 }]));
  if (!importIds.length) return porImport;
  for (const [chave, tabela] of Object.entries(TABELAS_IMPORT)) {
    if (chave === "imports") continue;
    const { rows } = await db.query(
      `SELECT import_id, COUNT(*)::bigint AS n FROM ${tabela} WHERE import_id = ANY($1::bigint[]) GROUP BY import_id`,
      [importIds.map(Number)]
    );
    for (const r of rows) porImport.get(Number(r.import_id))[chave] = Number(r.n);
  }
  return porImport;
}

async function contarMpPorRun(db, runIds) {
  const porRun = new Map(runIds.map((id) => [Number(id), { mp_payments: 0, mp_payment_charges: 0 }]));
  if (!runIds.length) return porRun;
  const ids = runIds.map(Number);
  const p = await db.query(
    `SELECT sync_run_id, COUNT(*)::bigint AS n FROM central_vendas_mp_payments WHERE sync_run_id = ANY($1::bigint[]) GROUP BY sync_run_id`,
    [ids]
  );
  for (const r of p.rows) porRun.get(Number(r.sync_run_id)).mp_payments = Number(r.n);
  const c = await db.query(
    `SELECT p.sync_run_id, COUNT(*)::bigint AS n
       FROM central_vendas_mp_payment_charges c
       JOIN central_vendas_mp_payments p ON p.id = c.mp_payment_row_id
      WHERE p.sync_run_id = ANY($1::bigint[])
      GROUP BY p.sync_run_id`,
    [ids]
  );
  for (const r of c.rows) porRun.get(Number(r.sync_run_id)).mp_payment_charges = Number(r.n);
  return porRun;
}

// Relatório de espaço do plano: linhas e bytes estimados por classe e por
// (conta, competência).
async function estimarEspaco(db, plano) {
  const stats = {};
  for (const tabela of [...Object.values(TABELAS_IMPORT), ...Object.values(TABELAS_MP)]) stats[tabela] = await estatisticasTabela(db, tabela);
  const porImport = await contarFilhosPorImport(db, plano.elegiveis);
  const porRun = await contarMpPorRun(db, plano.mp.elegiveis);

  const vazio = () => ({ linhas: {}, bytesEstimados: 0 });
  const somar = (acc, contagem, mapaTabelas) => {
    for (const [chave, n] of Object.entries(contagem)) {
      acc.linhas[chave] = (acc.linhas[chave] || 0) + n;
      acc.bytesEstimados += bytesEstimados(stats[mapaTabelas[chave]], n);
    }
  };
  const porClasse = { substituido: vazio(), residuo: vazio(), mp_payments: vazio() };
  const porContaCompetencia = {};
  for (const [id, contagem] of porImport) {
    const m = plano.motivos[id];
    somar(porClasse[m.classe], contagem, TABELAS_IMPORT);
    const [slug, marketplace, competencia, conta] = m.tupla.split("|");
    const chave = `${slug}|${marketplace}|conta=${conta}|${competencia}`;
    porContaCompetencia[chave] = porContaCompetencia[chave] || { ...vazio(), imports: 0 };
    porContaCompetencia[chave].imports += 1;
    somar(porContaCompetencia[chave], contagem, TABELAS_IMPORT);
  }
  for (const contagem of porRun.values()) somar(porClasse.mp_payments, contagem, TABELAS_MP);
  const total = Object.values(porClasse).reduce((s, c) => s + c.bytesEstimados, 0);
  return {
    porClasse,
    porContaCompetencia,
    totalBytesEstimados: total,
    tabelas: Object.values(stats),
    observacao: "Estimativa (pg_column_size médio × linhas + índices proporcionais). DELETE libera espaço para REUSO; "
      + "o arquivo não encolhe sem VACUUM FULL/pg_repack.",
  };
}

// ── Backup lógico (CSV) ───────────────────────────────────────────────────
function csvValor(v) {
  if (v === null || v === undefined) return "";
  let s;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === "object") s = JSON.stringify(v);
  else s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function anexarCsv(arquivo, rows) {
  if (!rows.length) return;
  const colunas = Object.keys(rows[0]);
  const novo = !fs.existsSync(arquivo);
  const linhas = rows.map((r) => colunas.map((c) => csvValor(r[c])).join(","));
  fs.appendFileSync(arquivo, (novo ? `${colunas.join(",")}\n` : "") + linhas.join("\n") + "\n");
}

// Exporta o import e TODAS as linhas filhas (pedidos/itens/componentes), um
// import por vez para não segurar o lote inteiro em memória. Chamado dentro
// da transação do lote, depois da reavaliação e antes do DELETE.
async function exportarImportsCsv(db, importIds, { dir, prefixo }) {
  fs.mkdirSync(dir, { recursive: true });
  const arquivos = {};
  for (const chave of Object.keys(TABELAS_IMPORT)) arquivos[chave] = path.join(dir, `${prefixo}-${chave}.csv`);
  for (const id of importIds) {
    const imp = await db.query(`SELECT * FROM central_vendas_imports WHERE id = $1`, [id]);
    anexarCsv(arquivos.imports, imp.rows);
    for (const chave of ["pedidos", "itens", "componentes"]) {
      const r = await db.query(`SELECT * FROM ${TABELAS_IMPORT[chave]} WHERE import_id = $1 ORDER BY id`, [id]);
      anexarCsv(arquivos[chave], r.rows);
    }
  }
  return arquivos;
}

module.exports = {
  carregarImports,
  carregarRuns,
  carregarRunsReferenciadosForaDoEscopo,
  carregarRefsProtegidas,
  contarFilhosPorImport,
  contarMpPorRun,
  estimarEspaco,
  exportarImportsCsv,
  FONTES_REFS,
  TABELAS_IMPORT,
  TABELAS_MP,
};
