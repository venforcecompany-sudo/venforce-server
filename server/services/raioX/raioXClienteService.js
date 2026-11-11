// server/services/raioX/raioXClienteService.js
//
// Raio-X do Cliente — inventário READ-ONLY dos dados de UM cliente.
// Contrato e exemplos: docs/banco-de-dados/raio-x/CONTRATO_RAIO_X.md.
//
// Garantias:
//   - uma transação BEGIN READ ONLY; nenhuma escrita é possível;
//   - SET LOCAL statement_timeout por consulta (padrão 3 s) + orçamento total
//     (padrão 20 s): consulta que estoura vira { status: "timeout" } naquele
//     bloco (SAVEPOINT), o resto do Raio-X continua;
//   - nada de varrer o banco: toda contagem filtra pelo cliente por coluna
//     indexada ou por import_id/sync_run_id (índices existentes); tabelas
//     filhas (pedidos/itens/componentes, charges, sources) só no modo
//     `detalhado`;
//   - nunca seleciona tokens/segredos (ml_tokens/shopee_grants: só colunas
//     de status) e nunca loga dados do cliente;
//   - tamanho por cliente é ESTIMATIVA (linhas do cliente × média de bytes
//     por linha da tabela, pg_total_relation_size / reltuples) e vem marcado
//     como tal — o PostgreSQL não mede tamanho físico por cliente.

const pool = require("../../config/database");
const { REGISTRO, COLUNAS_IDENTIDADE, COLUNAS_PERIODO, COLUNAS_ULTIMA_ESCRITA } = require("./raioXRegistro");
const { selecionarMelhorImportPorCompetencia, monthBounds } = require("../centralVendas/centralVendasRepository");

const VERSAO_CONTRATO = "raio-x-cliente/v1";
const TIMEOUT_PADRAO_MS = 3000;
const ORCAMENTO_PADRAO_MS = 20000;
const METODO_ESTIMATIVA = "linhas_do_cliente × (pg_total_relation_size / reltuples) — estimativa proporcional, não tamanho físico";

function ident(nome) {
  if (!/^[a-z_][a-z0-9_]*$/.test(nome)) throw new Error(`identificador inválido: ${nome}`);
  return nome;
}

function criarExecutor(client, { timeoutMs, orcamentoMs }) {
  const inicio = Date.now();
  let seq = 0;
  async function q(sql, params = []) {
    if (Date.now() - inicio > orcamentoMs) return { status: "orcamento_esgotado" };
    const sp = `rx_${++seq}`;
    await client.query(`SAVEPOINT ${sp}`);
    try {
      await client.query(`SET LOCAL statement_timeout = ${Math.max(100, Number(timeoutMs) | 0)}`);
      // Só os parâmetros que o SQL referencia ($n): parâmetro sobrando é
      // erro de protocolo (08P01) no PostgreSQL.
      const usados = Math.max(0, ...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      const r = await client.query(sql, params.slice(0, usados));
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      return { status: "ok", rows: r.rows };
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      // 57014 = query_canceled (statement_timeout). Mensagem do PG nunca leva
      // dado do cliente aqui (consultas parametrizadas, sem literais).
      return { status: err.code === "57014" ? "timeout" : "erro", codigo: err.code || null };
    }
  }
  return { q, decorridoMs: () => Date.now() - inicio };
}

async function carregarCatalogo(q) {
  const tabelas = REGISTRO.map((r) => r.tabela);
  const cols = await q(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
    [tabelas]
  );
  const stats = await q(
    `SELECT c.relname AS tabela, c.reltuples::bigint AS linhas_estimadas,
            pg_total_relation_size(c.oid)::bigint AS bytes_total
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
    [tabelas]
  );
  const colunas = new Map();
  for (const row of cols.rows || []) {
    if (!colunas.has(row.table_name)) colunas.set(row.table_name, new Set());
    colunas.get(row.table_name).add(row.column_name);
  }
  const estat = new Map((stats.rows || []).map((r) => [r.tabela, {
    linhasEstimadas: Number(r.linhas_estimadas), bytesTotal: Number(r.bytes_total),
  }]));
  return { colunas, estat };
}

const idOuNull = (v) => (v === null || v === undefined ? null : Number(v));

function primeira(set, lista) { return lista.find((c) => set && set.has(c)) || null; }

function estimarBytes(linhas, estat) {
  if (!estat || linhas == null) return null;
  const base = Math.max(estat.linhasEstimadas, 1);
  return Math.round((estat.bytesTotal / base) * linhas);
}

// Filtro do cliente para uma tabela com identidade própria.
function filtroCliente(colunaIdentidade) {
  if (colunaIdentidade === "cliente_id") return "cliente_id = $1";
  if (colunaIdentidade === "cliente_slug") return "cliente_slug = $2";
  return "cliente_conta_id IN (SELECT id FROM cliente_contas WHERE cliente_id = $1)";
}

async function inventariarTabela(entrada, ctx) {
  const { q, catalogo, cliente, detalhado } = ctx;
  const cols = catalogo.colunas.get(entrada.tabela);
  const base = {
    tabela: entrada.tabela, dominio: entrada.dominio, modulos: entrada.modulos, classe: entrada.classe,
    origem: entrada.origem, manual: entrada.manual, reconstruivel: entrada.reconstruivel,
  };
  if (!cols) return { ...base, status: "nao_existe" };

  let where;
  let identidade;
  if (entrada.via) {
    if (!detalhado) return { ...base, status: "so_no_modo_detalhado", identidade: `via ${entrada.via.pai}.${entrada.via.fk}` };
    const pai = REGISTRO.find((r) => r.tabela === entrada.via.pai);
    const colPai = primeira(catalogo.colunas.get(pai.tabela), COLUNAS_IDENTIDADE);
    if (!colPai) return { ...base, status: "sem_identidade" };
    identidade = `via ${entrada.via.pai}.${entrada.via.fk}`;
    where = `${ident(entrada.via.fk)} IN (SELECT id FROM ${ident(pai.tabela)} WHERE ${filtroCliente(colPai)})`;
  } else {
    identidade = primeira(cols, COLUNAS_IDENTIDADE);
    if (!identidade) return { ...base, status: "sem_identidade" };
    where = filtroCliente(identidade);
  }
  const colPeriodo = primeira(cols, COLUNAS_PERIODO);
  const colUltima = primeira(cols, COLUNAS_ULTIMA_ESCRITA);
  const t = ident(entrada.tabela);
  const r = await q(
    `SELECT COUNT(*)::bigint AS linhas
            ${colPeriodo ? `, MIN(${ident(colPeriodo)})::text AS periodo_de, MAX(${ident(colPeriodo)})::text AS periodo_ate` : ""}
            ${colUltima ? `, MAX(${ident(colUltima)}) AS ultima_escrita` : ""}
       FROM ${t} WHERE ${where}`,
    [cliente.id, cliente.slug]
  );
  if (r.status !== "ok") return { ...base, identidade, status: r.status };
  const row = r.rows[0] || {};
  const linhas = Number(row.linhas || 0);
  return {
    ...base,
    identidade,
    status: "ok",
    linhas,
    bytesEstimados: estimarBytes(linhas, catalogo.estat.get(entrada.tabela)),
    periodo: colPeriodo ? { coluna: colPeriodo, de: row.periodo_de || null, ate: row.periodo_ate || null } : null,
    ultimaEscrita: colUltima ? row.ultima_escrita || null : null,
  };
}

// Central de Vendas por conta × competência: vigente (MESMA seleção canônica
// dos leitores), cópias superadas, manuais protegidas, candidates órfãos.
async function inventariarCentral(ctx) {
  const { q, cliente } = ctx;
  const r = await q(
    `SELECT id, cliente_conta_id, marketplace, competencia, fonte, publication_status, sync_run_id,
            coverage_date_from::text AS coverage_date_from, coverage_date_to::text AS coverage_date_to,
            published_at, created_at,
            NULLIF(resumo_json->>'pedidosTotal', '')::int AS pedidos_total,
            pg_column_size(payload_json)::bigint AS payload_bytes
       FROM central_vendas_imports
      WHERE cliente_id = $1 OR cliente_slug = $2`,
    [cliente.id, cliente.slug]
  );
  if (r.status !== "ok") return { status: r.status };
  const grupos = new Map();
  for (const row of r.rows) {
    const k = `${row.cliente_conta_id ?? "sem_conta"}|${row.marketplace}|${row.competencia}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(row);
  }
  const porContaCompetencia = [];
  const tot = { imports: r.rows.length, vigentes: 0, superados: 0, manuais: 0, candidatesNaoPublicados: 0, pedidosEmCopiasSuperadas: 0 };
  for (const [k, rows] of grupos) {
    const [conta, marketplace, competencia] = k.split("|");
    const { inicio, fim } = monthBounds(competencia);
    const vigente = selecionarMelhorImportPorCompetencia(rows, { segmentStart: inicio, segmentEnd: fim });
    const ehManual = (row) => row.fonte !== "orders_api" || row.sync_run_id == null;
    const outros = rows.filter((row) => !vigente || String(row.id) !== String(vigente.id));
    const superados = outros.filter((row) => !ehManual(row) && row.publication_status === "published");
    const manuais = rows.filter(ehManual);
    const candidates = outros.filter((row) => row.publication_status === "candidate");
    tot.vigentes += vigente ? 1 : 0;
    tot.superados += superados.length;
    tot.manuais += manuais.length;
    tot.candidatesNaoPublicados += candidates.length;
    tot.pedidosEmCopiasSuperadas += superados.reduce((s, row) => s + (row.pedidos_total || 0), 0);
    porContaCompetencia.push({
      clienteContaId: conta === "sem_conta" ? null : Number(conta), marketplace, competencia,
      vigente: vigente ? {
        importId: Number(vigente.id), fonte: vigente.fonte, status: vigente.publication_status,
        cobertura: [vigente.coverage_date_from, vigente.coverage_date_to], pedidos: vigente.pedidos_total,
      } : null,
      importsTotal: rows.length,
      copiasSuperadas: superados.length,
      pedidosEmCopiasSuperadas: superados.reduce((s, row) => s + (row.pedidos_total || 0), 0),
      manuaisProtegidos: manuais.map((row) => Number(row.id)),
      candidatesNaoPublicados: candidates.map((row) => Number(row.id)),
    });
  }
  porContaCompetencia.sort((a, b) => String(a.competencia).localeCompare(String(b.competencia)) || (a.clienteContaId || 0) - (b.clienteContaId || 0));
  return { status: "ok", totais: tot, porContaCompetencia };
}

async function inventariarSyncs(ctx) {
  const { q, cliente } = ctx;
  const ultimo = await q(
    `SELECT DISTINCT ON (cliente_conta_id) cliente_conta_id, id, status, completeness_status,
            date_from::text, date_to::text, created_at, finished_at, error_code
       FROM central_vendas_sync_runs WHERE cliente_id = $1
      ORDER BY cliente_conta_id, created_at DESC`,
    [cliente.id]
  );
  const agregados = await q(
    `SELECT cliente_conta_id, COUNT(*)::int AS runs,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS falhas,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS runs_7d,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (finished_at - started_at)))
              FILTER (WHERE finished_at IS NOT NULL AND started_at IS NOT NULL) AS duracao_mediana_s
       FROM central_vendas_sync_runs WHERE cliente_id = $1 GROUP BY cliente_conta_id`,
    [cliente.id]
  );
  return {
    status: ultimo.status === "ok" && agregados.status === "ok" ? "ok" : (ultimo.status !== "ok" ? ultimo.status : agregados.status),
    ultimoPorConta: (ultimo.rows || []).map((row) => ({
      clienteContaId: idOuNull(row.cliente_conta_id), runId: Number(row.id), status: row.status, completude: row.completeness_status,
      periodo: [row.date_from, row.date_to], criadoEm: row.created_at, terminadoEm: row.finished_at, erro: row.error_code,
    })),
    agregadosPorConta: (agregados.rows || []).map((row) => ({
      clienteContaId: idOuNull(row.cliente_conta_id), runs: row.runs, falhas: row.falhas, runs7d: row.runs_7d,
      duracaoMedianaS: row.duracao_mediana_s == null ? null : Number(row.duracao_mediana_s),
    })),
  };
}

async function inventariarMercadoPago(ctx) {
  const { q, cliente } = ctx;
  const r = await q(
    `SELECT p.cliente_conta_id, COUNT(*)::bigint AS linhas, COUNT(DISTINCT p.payment_id)::bigint AS payments_distintos,
            COUNT(DISTINCT p.sync_run_id)::int AS runs, MAX(p.created_at) AS ultima_coleta
       FROM central_vendas_mp_payments p
      WHERE p.sync_run_id IN (SELECT id FROM central_vendas_sync_runs WHERE cliente_id = $1)
      GROUP BY p.cliente_conta_id`,
    [cliente.id]
  );
  if (r.status !== "ok") return { status: r.status };
  return {
    status: "ok",
    porConta: r.rows.map((row) => {
      const linhas = Number(row.linhas), distintos = Number(row.payments_distintos);
      return {
        clienteContaId: idOuNull(row.cliente_conta_id), linhas, paymentsDistintos: distintos, runs: row.runs,
        copiasPorPayment: distintos ? Math.round((linhas / distintos) * 100) / 100 : null,
        ultimaColeta: row.ultima_coleta,
      };
    }),
  };
}

// Relações que parecem inconsistentes (cada uma = 1 consulta barata).
const CHECAGENS = [
  ["import_com_conta_de_outro_cliente", "Import da Central apontando para conta de OUTRO cliente",
    `SELECT COUNT(*)::int AS n FROM central_vendas_imports i JOIN cliente_contas cc ON cc.id = i.cliente_conta_id
      WHERE i.cliente_id = $1 AND cc.cliente_id <> $1`],
  ["import_slug_divergente", "Import com cliente_id do cliente mas cliente_slug diferente do atual",
    `SELECT COUNT(*)::int AS n FROM central_vendas_imports WHERE cliente_id = $1 AND cliente_slug <> $2`],
  ["import_sem_conta_com_varias_contas", "Import sem cliente_conta_id num cliente com 2+ contas no marketplace (invisível na leitura por conta)",
    `SELECT COUNT(*)::int AS n FROM central_vendas_imports i
      WHERE i.cliente_id = $1 AND i.cliente_conta_id IS NULL
        AND (SELECT COUNT(*) FROM cliente_contas cc WHERE cc.cliente_id = $1 AND cc.marketplace = i.marketplace AND cc.ativo) > 1`],
  ["conta_meli_sem_grant", "Conta ML ativa sem grant (ml_tokens) para o external_account_id",
    `SELECT COUNT(*)::int AS n FROM cliente_contas cc
      WHERE cc.cliente_id = $1 AND cc.marketplace = 'meli' AND cc.ativo
        AND NOT EXISTS (SELECT 1 FROM ml_tokens t WHERE t.ml_user_id = cc.external_account_id)`],
  ["grant_sem_conta", "Grant ML do cliente sem conta correspondente",
    `SELECT COUNT(*)::int AS n FROM ml_tokens t
      WHERE t.cliente_id = $1 AND NOT EXISTS (SELECT 1 FROM cliente_contas cc WHERE cc.cliente_id = $1 AND cc.external_account_id = t.ml_user_id)`],
  ["run_preso", "Sync run em queued/running há mais de 6 h",
    `SELECT COUNT(*)::int AS n FROM central_vendas_sync_runs
      WHERE cliente_id = $1 AND status IN ('queued','running') AND created_at < NOW() - INTERVAL '6 hours'`],
];

async function checarConsistencia(ctx) {
  const out = [];
  for (const [codigo, descricao, sql] of CHECAGENS) {
    // eslint-disable-next-line no-await-in-loop
    const r = await ctx.q(sql, [ctx.cliente.id, ctx.cliente.slug]);
    out.push({ codigo, descricao, status: r.status, ...(r.codigo ? { codigoErro: r.codigo } : {}), ocorrencias: r.status === "ok" ? Number(r.rows[0]?.n ?? 0) : null });
  }
  return out;
}

// Fluxo declarado (origem → tabela → módulos) a partir do registro.
function montarFluxo(tabelas) {
  return tabelas
    .filter((t) => t.status === "ok" && t.linhas > 0)
    .map((t) => ({ origem: t.origem, tabela: t.tabela, modulos: t.modulos, classe: t.classe }));
}

async function gerarRaioXCliente({ clienteId = null, clienteSlug = null } = {}, {
  db = pool, timeoutMs = TIMEOUT_PADRAO_MS, orcamentoMs = ORCAMENTO_PADRAO_MS, detalhado = false,
} = {}) {
  const client = typeof db.connect === "function" ? await db.connect() : db;
  const liberar = typeof client.release === "function" ? () => client.release() : () => {};
  try {
    await client.query("BEGIN READ ONLY");
    const { q, decorridoMs } = criarExecutor(client, { timeoutMs, orcamentoMs });
    const c = await q(
      `SELECT id, nome, slug, ativo FROM clientes WHERE ($1::int IS NOT NULL AND id = $1) OR ($2::text IS NOT NULL AND slug = $2) LIMIT 1`,
      [clienteId, clienteSlug]
    );
    if (c.status !== "ok") return { ok: false, codigo: "CLIENTE_CONSULTA_" + c.status.toUpperCase() };
    const cliente = c.rows[0];
    if (!cliente) return { ok: false, codigo: "CLIENTE_NAO_ENCONTRADO" };

    const contas = await q(
      `SELECT id, marketplace, nome, slug, external_account_id, is_primary, ativo, created_at
         FROM cliente_contas WHERE cliente_id = $1 ORDER BY marketplace, id`,
      [cliente.id]
    );
    // Grants: SÓ colunas de status/identificação (nunca access/refresh token).
    const grantsMl = await q(
      `SELECT id, ml_user_id, is_primary, token_status, refresh_failures, superseded_at, expires_at, updated_at
         FROM ml_tokens WHERE cliente_id = $1 ORDER BY id`,
      [cliente.id]
    );
    const catalogo = await carregarCatalogo(q);
    const ctx = { q, catalogo, cliente, detalhado };

    const tabelas = [];
    for (const entrada of REGISTRO) {
      // eslint-disable-next-line no-await-in-loop
      tabelas.push(await inventariarTabela(entrada, ctx));
    }
    const centralVendas = await inventariarCentral(ctx);
    const syncs = await inventariarSyncs(ctx);
    const mercadoPago = await inventariarMercadoPago(ctx);
    const inconsistencias = await checarConsistencia(ctx);
    await client.query("ROLLBACK");

    const comLinhas = tabelas.filter((t) => t.status === "ok" && t.linhas > 0);
    return {
      ok: true,
      versao: VERSAO_CONTRATO,
      geradoEm: new Date().toISOString(),
      duracaoMs: decorridoMs(),
      modo: detalhado ? "detalhado" : "rapido",
      limites: { timeoutPorConsultaMs: timeoutMs, orcamentoTotalMs: orcamentoMs },
      estimativaTamanho: { metodo: METODO_ESTIMATIVA, exato: false },
      cliente: { id: cliente.id, nome: cliente.nome, slug: cliente.slug, ativo: cliente.ativo },
      contas: contas.status === "ok" ? contas.rows.map((r) => ({
        id: r.id, marketplace: r.marketplace, nome: r.nome, slug: r.slug, externalAccountId: r.external_account_id,
        principal: r.is_primary, ativa: r.ativo, criadaEm: r.created_at,
      })) : { status: contas.status },
      grants: {
        mercadoLivre: grantsMl.status === "ok" ? grantsMl.rows.map((r) => ({
          id: r.id, mlUserId: r.ml_user_id, principal: r.is_primary, status: r.token_status,
          falhasRefresh: r.refresh_failures, substituidoEm: r.superseded_at, expiraEm: r.expires_at, atualizadoEm: r.updated_at,
        })) : { status: grantsMl.status },
      },
      resumo: {
        tabelasComDados: comLinhas.length,
        linhas: comLinhas.reduce((s, t) => s + t.linhas, 0),
        bytesEstimados: comLinhas.reduce((s, t) => s + (t.bytesEstimados || 0), 0),
        tabelasManuaisComDados: comLinhas.filter((t) => t.manual).map((t) => t.tabela),
        blocosComTimeout: tabelas.filter((t) => t.status === "timeout").map((t) => t.tabela),
      },
      tabelas,
      centralVendas,
      syncs,
      mercadoPago,
      inconsistencias,
      fluxo: montarFluxo(tabelas),
    };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* conexão já perdida */ }
    throw err;
  } finally {
    liberar();
  }
}

module.exports = { gerarRaioXCliente, VERSAO_CONTRATO, METODO_ESTIMATIVA, CHECAGENS };
