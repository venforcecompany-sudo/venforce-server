// server/services/painelContas/painelContasRepository.js
// Leitura em LOTE (nunca 1 query por cliente) sobre dados já persistidos:
//   cliente_360_resumos_mensais   snapshot mensal do cliente (Central + Ads)
//   central_vendas_imports        resultado oficial POR CONTA (resumo_json)
//   central_vendas_sync_runs      evidência do último sync (só status/código)
//   ads_resumos_mensais           Ads do cliente (loja "todas")
//   painel_contas_lancamentos_manuais  lançamento manual por conta
// Cada query cobre N clientes/contas (`= ANY($1)`), mesmo padrão de
// dashboardService.loadProductionData (Auditoria §13/§18/§19).
//
// NENHUMA chamada aqui aciona motor ao vivo, Orders API ou Ads API — só
// leitura do que o sync já gravou.

const fs = require("fs");
const pedidosCompartilhados = require("../centralVendas/centralVendasPedidosCompartilhados");
const path = require("path");
const pool = require("../../config/database");

const schemaPath = path.join(__dirname, "..", "..", "sql", "painel_contas_schema.sql");

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function parsePayload(raw) {
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch (_) { return {}; }
  }
  return raw || {};
}

function mapRow(row) {
  const payload = parsePayload(row.payload_json);
  const central = payload.centralVendas && typeof payload.centralVendas === "object" ? payload.centralVendas : {};
  const ads = payload.ads && typeof payload.ads === "object" ? payload.ads : null;
  return {
    clienteId: Number(row.cliente_id),
    clienteSlug: row.cliente_slug || null,
    competencia: row.competencia || null,
    faturamento: row.faturamento,
    mcMedia: row.mc_media,
    adsInvestido: ads ? ads.investimentoAds : row.ads_investido,
    gmvAds: ads ? ads.gmvAds : null,
    lucroContribuicao: central.lucroContribuicao,
    lucroContribuicaoPresente: Object.prototype.hasOwnProperty.call(central, "lucroContribuicao"),
    sincronizadoEm: toIso(row.sincronizado_em),
    // Proveniência do snapshot: permite provar que ele foi gerado com os
    // mesmos imports que o Painel lê por conta (painelContasOperacional).
    fonte: payload.fonte || null,
    mcFonte: central.mcFonte || null,
    centralDadosAte: central.dadosAte || null,
    centralImportIds: Array.isArray(central.contas)
      ? central.contas.map((c) => Number(c.importId)).filter(Number.isFinite)
      : null,
  };
}

// ─── schema do lançamento manual (single-flight, uma vez por processo) ──────

let ensurePromise = null;
let ensureConcluido = false;

async function ensurePainelContasTables() {
  if (ensureConcluido) return;
  if (!ensurePromise) {
    ensurePromise = pool.query(fs.readFileSync(schemaPath, "utf8")).then(
      () => { ensureConcluido = true; ensurePromise = null; },
      (err) => { ensurePromise = null; throw err; }
    );
  }
  await ensurePromise;
}

// ─── lista principal (uma competência EXATA) ─────────────────────────────────

// Snapshot DA competência — nunca "o mais recente": um cliente sem setembro
// não aparece aqui quando a tela está em setembro.
async function listarResumosDaCompetencia(clienteIds, competencia) {
  if (!Array.isArray(clienteIds) || !clienteIds.length) return [];
  const { rows } = await pool.query(
    `/* painelContas:RESUMO_DA_COMPETENCIA */
     SELECT s.cliente_id, s.cliente_slug, s.competencia, s.faturamento, s.mc_media,
            s.ads_investido, s.payload_json, s.sincronizado_em
       FROM cliente_360_resumos_mensais s
      WHERE s.cliente_id = ANY($1::int[])
        AND s.competencia = $2`,
    [clienteIds, competencia]
  );
  return rows.map(mapRow);
}

// Só informativo ("último dado: ago/2026") — nunca substitui a competência.
async function listarUltimaCompetenciaComDado(clienteIds) {
  if (!Array.isArray(clienteIds) || !clienteIds.length) return [];
  const { rows } = await pool.query(
    `/* painelContas:ULTIMA_COMPETENCIA */
     SELECT s.cliente_id, MAX(s.competencia) AS competencia
       FROM cliente_360_resumos_mensais s
      WHERE s.cliente_id = ANY($1::int[])
      GROUP BY s.cliente_id`,
    [clienteIds]
  );
  return rows.map((r) => ({ clienteId: Number(r.cliente_id), competencia: r.competencia }));
}

async function listarContasDeClientes(clienteIds) {
  if (!Array.isArray(clienteIds) || !clienteIds.length) return [];
  const { rows } = await pool.query(
    `/* painelContas:CONTAS_DOS_CLIENTES */
     SELECT cc.id, cc.cliente_id, cc.marketplace, cc.nome, cc.slug,
            cc.external_account_id, cc.is_primary, cc.ativo
       FROM cliente_contas cc
      WHERE cc.cliente_id = ANY($1::int[])
      ORDER BY cc.cliente_id, cc.id`,
    [clienteIds]
  );
  return rows;
}

// Imports da competência (published/legacy) de N contas. A ESCOLHA do import
// por conta é feita no service com selecionarMelhorImportPorCompetencia — a
// mesma regra M4 da leitura da Central de Vendas, nunca uma segunda. Só os
// campos do resumo oficial saem do JSON (nada de payload/pedidos).
async function listarImportsDaCompetencia(contaIds, competencia) {
  if (!Array.isArray(contaIds) || !contaIds.length) return [];
  const { rows } = await pool.query(
    `/* painelContas:IMPORTS_DA_COMPETENCIA */
     SELECT i.id, i.cliente_conta_id, i.competencia, i.publication_status,
            i.coverage_date_from, i.coverage_date_to, i.published_at, i.created_at, i.sync_run_id,
            (i.resumo_json->>'faturamento')::numeric AS faturamento,
            (i.resumo_json->>'faturamentoComCusto')::numeric AS faturamento_com_custo,
            (i.resumo_json->>'lucroContribuicao')::numeric AS lucro_contribuicao,
            (i.resumo_json->>'margemContribuicaoPercentual')::numeric AS margem_contribuicao_percentual,
            i.resumo_json->>'completenessStatus' AS completeness_status
       FROM central_vendas_imports i
      WHERE i.cliente_conta_id = ANY($1::int[])
        AND i.competencia = $2
        AND i.publication_status IN ('published', 'legacy')`,
    [contaIds, competencia]
  );
  return rows;
}

// Pedidos dos imports JÁ escolhidos pelo service. Uma consulta cobre todas as
// contas do cliente e traz só os campos canônicos necessários à quebra
// semanal; o intervalo impede que uma linha de borda de outra competência
// contamine o mês selecionado.
async function listarPedidosDosImports(importIds, { inicio, fim }) {
  if (!Array.isArray(importIds) || !importIds.length) return [];
  if (await pedidosCompartilhados.tabelaVinculosDisponivel(pool)) {
    const { rows } = await pool.query(
      `/* painelContas:PEDIDOS_DOS_IMPORTS */
       SELECT fp.import_lido AS import_id, p.data_pedido, p.status, p.confianca,
              p.faturamento, p.resultado
         FROM ${pedidosCompartilhados.fontePedidosSql("$1", { comVinculos: true })}
         JOIN central_vendas_pedidos p ON p.id = fp.pedido_row_id
        WHERE p.data_pedido BETWEEN $2::date AND $3::date
        ORDER BY fp.import_lido, p.data_pedido, p.pedido_id`,
      [importIds, inicio, fim]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `/* painelContas:PEDIDOS_DOS_IMPORTS */
     SELECT p.import_id, p.data_pedido, p.status, p.confianca,
            p.faturamento, p.resultado
       FROM central_vendas_pedidos p
      WHERE p.import_id = ANY($1::bigint[])
        AND p.data_pedido BETWEEN $2::date AND $3::date
      ORDER BY p.import_id, p.data_pedido, p.id`,
    [importIds, inicio, fim]
  );
  return rows;
}

// Composição do faturamento: TODOS os pedidos dos imports escolhidos (o mesmo
// conjunto sobre o qual o FAT do import foi calculado — sem recorte de data),
// agregados por status × tipo de pós-venda. Poucas linhas por import; a
// classificação em grupos fica no service (painelContasComposicao), com o
// mesmo predicado da Central.
async function listarComposicaoDosImports(importIds) {
  if (!Array.isArray(importIds) || !importIds.length) return [];
  if (await pedidosCompartilhados.tabelaVinculosDisponivel(pool)) {
    const { rows } = await pool.query(
      `/* painelContas:COMPOSICAO_DOS_IMPORTS */
       SELECT fp.import_lido AS import_id, p.status, p.payload_json->>'posVendaTipo' AS pos_venda_tipo,
              COUNT(*)::int AS pedidos,
              (COUNT(*) - COUNT(p.faturamento))::int AS sem_valor,
              COALESCE(SUM(p.faturamento), 0) AS faturamento
         FROM ${pedidosCompartilhados.fontePedidosSql("$1", { comVinculos: true })}
         JOIN central_vendas_pedidos p ON p.id = fp.pedido_row_id
        GROUP BY fp.import_lido, p.status, p.payload_json->>'posVendaTipo'`,
      [importIds]
    );
    return rows;
  }
  const { rows } = await pool.query(
    `/* painelContas:COMPOSICAO_DOS_IMPORTS */
     SELECT p.import_id, p.status, p.payload_json->>'posVendaTipo' AS pos_venda_tipo,
            COUNT(*)::int AS pedidos,
            (COUNT(*) - COUNT(p.faturamento))::int AS sem_valor,
            COALESCE(SUM(p.faturamento), 0) AS faturamento
       FROM central_vendas_pedidos p
      WHERE p.import_id = ANY($1::bigint[])
      GROUP BY p.import_id, p.status, p.payload_json->>'posVendaTipo'`,
    [importIds]
  );
  return rows;
}

// Pedido presente em mais de um dos imports escolhidos (duas contas apontando
// para a mesma loja, p.ex.). A soma das contas contaria a venda duas vezes;
// isso é medido, nunca deduplicado em silêncio.
async function medirSobreposicaoDosImports(importIds) {
  if (!Array.isArray(importIds) || importIds.length < 2) return { pedidos: 0, valor: 0 };
  if (await pedidosCompartilhados.tabelaVinculosDisponivel(pool)) {
    const { rows } = await pool.query(
      `/* painelContas:COMPOSICAO_SOBREPOSICAO */
       SELECT COUNT(*)::int AS pedidos, COALESCE(SUM(d.excedente), 0) AS valor
         FROM (SELECT p.pedido_id, SUM(p.faturamento) - MAX(p.faturamento) AS excedente
                 FROM ${pedidosCompartilhados.fontePedidosSql("$1", { comVinculos: true })}
                 JOIN central_vendas_pedidos p ON p.id = fp.pedido_row_id
                GROUP BY p.pedido_id
               HAVING COUNT(*) > 1) d`,
      [importIds]
    );
    return { pedidos: Number(rows[0]?.pedidos) || 0, valor: Number(rows[0]?.valor) || 0 };
  }
  const { rows } = await pool.query(
    `/* painelContas:COMPOSICAO_SOBREPOSICAO */
     SELECT COUNT(*)::int AS pedidos, COALESCE(SUM(d.excedente), 0) AS valor
       FROM (SELECT p.pedido_id, SUM(p.faturamento) - MAX(p.faturamento) AS excedente
               FROM central_vendas_pedidos p
              WHERE p.import_id = ANY($1::bigint[])
              GROUP BY p.pedido_id
             HAVING COUNT(*) > 1) d`,
    [importIds]
  );
  return { pedidos: Number(rows[0]?.pedidos) || 0, valor: Number(rows[0]?.valor) || 0 };
}

// Último sync_run de cada conta que toca a competência. Só status/código/data
// — error_message pode carregar texto de terceiros e não sai daqui.
// `travado`: queued/running além do limite de abandono — um run órfão de
// restart não é exibido como "sincronizando" para sempre. Nada é
// transicionado aqui (só leitura). Limites:
//   running            → RUNNING_STALE_MINUTES da Central (a unidade noturna já
//                        tem prazo de 30 min, então além disso está parada);
//   queued manual      → QUEUED_STALE_MINUTES da Central;
//   queued noturno     → teto da RODADA: a rodada cria todas as unidades como
//                        queued antes de executar, então horas na fila durante
//                        uma rodada saudável é normal.
async function listarUltimoRunPorConta(contaIds, { inicio, fim }) {
  if (!Array.isArray(contaIds) || !contaIds.length) return [];
  const { QUEUED_STALE_MINUTES, RUNNING_STALE_MINUTES } = require("../centralVendas/centralVendasSyncRunService");
  const { RODADA_TIMEOUT_PADRAO_MS } = require("../centralVendas/centralVendasNoturnoScheduler");
  const { lerMsPositivo } = require("../../config/databaseConexao");
  const rodadaMin = Math.ceil(lerMsPositivo(process.env.CENTRAL_VENDAS_NOTURNO_RODADA_TIMEOUT_MS, RODADA_TIMEOUT_PADRAO_MS) / 60000);
  const { rows } = await pool.query(
    `/* painelContas:ULTIMO_RUN_POR_CONTA */
     SELECT DISTINCT ON (r.cliente_conta_id)
            r.id, r.cliente_conta_id, r.status, r.error_code, r.created_at,
            ((r.status = 'queued' AND r.requested_by IS NOT NULL AND r.created_at < NOW() - make_interval(mins => $4::int))
              OR (r.status = 'queued' AND r.requested_by IS NULL AND r.created_at < NOW() - make_interval(mins => $6::int))
              OR (r.status = 'running' AND COALESCE(r.started_at, r.created_at) < NOW() - make_interval(mins => $5::int))) AS travado
       FROM central_vendas_sync_runs r
      WHERE r.cliente_conta_id = ANY($1::int[])
        AND r.date_from <= $3::date
        AND r.date_to >= $2::date
      ORDER BY r.cliente_conta_id, r.created_at DESC, r.id DESC`,
    [contaIds, inicio, fim, QUEUED_STALE_MINUTES, RUNNING_STALE_MINUTES, rodadaMin]
  );
  return rows;
}

async function listarAdsDaCompetencia(clienteSlugs, competencia) {
  if (!Array.isArray(clienteSlugs) || !clienteSlugs.length) return [];
  const { rows } = await pool.query(
    `/* painelContas:ADS_DA_COMPETENCIA */
     SELECT a.cliente_slug, a.investimento_ads, a.gmv_ads, a.updated_at
       FROM ads_resumos_mensais a
      WHERE a.cliente_slug = ANY($1::text[])
        AND a.mes_ref = $2
        AND a.loja_campanha = 'todas'`,
    [clienteSlugs, competencia]
  );
  return rows;
}

async function listarManuaisDaCompetencia(contaIds, competencia) {
  if (!Array.isArray(contaIds) || !contaIds.length) return [];
  const { rows } = await pool.query(
    `/* painelContas:MANUAIS_DA_COMPETENCIA */
     SELECT m.*, u.nome AS updated_by_nome, uc.nome AS created_by_nome
       FROM painel_contas_lancamentos_manuais m
       LEFT JOIN users u ON u.id = m.updated_by
       LEFT JOIN users uc ON uc.id = m.created_by
      WHERE m.cliente_conta_id = ANY($1::int[])
        AND m.competencia = $2`,
    [contaIds, competencia]
  );
  return rows;
}

// Todas as competências lançadas de UMA conta (mais recente primeiro) — o
// histórico mês a mês do lançamento manual. Linha removida não aparece aqui
// (está só na trilha).
async function listarManuaisDaConta(contaId, clienteId) {
  const { rows } = await pool.query(
    `/* painelContas:MANUAIS_DA_CONTA */
     SELECT m.*, u.nome AS updated_by_nome, uc.nome AS created_by_nome
       FROM painel_contas_lancamentos_manuais m
       LEFT JOIN users u ON u.id = m.updated_by
       LEFT JOIN users uc ON uc.id = m.created_by
      WHERE m.cliente_conta_id = $1 AND m.cliente_id = $2
      ORDER BY m.competencia DESC`,
    [contaId, clienteId]
  );
  return rows;
}

// Trilha de auditoria de uma conta × competência, inclusive remoções (a
// trilha não tem FK para o lançamento justamente para sobreviver a elas).
async function listarHistoricoManual(contaId, clienteId, competencia) {
  const { rows } = await pool.query(
    `/* painelContas:HISTORICO_DA_CONTA */
     SELECT h.id, h.acao, h.valores_json, h.user_id, h.created_at, u.nome AS user_nome
       FROM painel_contas_lancamentos_manuais_historico h
       LEFT JOIN users u ON u.id = h.user_id
      WHERE h.cliente_conta_id = $1 AND h.cliente_id = $2 AND h.competencia = $3
      ORDER BY h.created_at DESC, h.id DESC`,
    [contaId, clienteId, competencia]
  );
  return rows;
}

// ─── histórico do cliente (expansão lazy) ────────────────────────────────────

async function listarResumosDoAno(clienteId, clienteSlug, ano) {
  const { rows } = await pool.query(
    `/* painelContas:RESUMOS_DO_ANO */
     SELECT s.cliente_id, s.cliente_slug, s.competencia, s.faturamento, s.mc_media,
            s.ads_investido, s.payload_json, s.sincronizado_em
       FROM cliente_360_resumos_mensais s
      WHERE s.cliente_id = $1 AND s.competencia LIKE $2
      ORDER BY s.competencia ASC`,
    [clienteId, `${ano}-%`]
  );
  return rows.map(mapRow);
}

// ─── lançamento manual (escrita) ─────────────────────────────────────────────

async function obterContaDoCliente(contaId, clienteId) {
  const { rows } = await pool.query(
    `/* painelContas:CONTA_DO_CLIENTE */
     SELECT id, cliente_id, marketplace, nome, slug, external_account_id, is_primary, ativo
       FROM cliente_contas
      WHERE id = $1 AND cliente_id = $2`,
    [contaId, clienteId]
  );
  return rows[0] || null;
}

function valoresParaHistorico(valores) {
  return {
    faturamento: valores.faturamento,
    lucroContribuicao: valores.lucroContribuicao,
    margemContribuicao: valores.margemContribuicao,
    investimentoAds: valores.investimentoAds,
    gmvAds: valores.gmvAds,
    observacao: valores.observacao,
    dataReferencia: valores.dataReferencia ?? null,
  };
}

async function comTransacao(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Upsert + trilha de auditoria na MESMA transação: não existe alteração
// manual sem registro de quem fez e com quais valores.
async function salvarLancamentoManual({ clienteId, contaId, competencia, valores, userId }) {
  return comTransacao(async (db) => {
    const { rows } = await db.query(
      `/* painelContas:UPSERT_MANUAL */
       INSERT INTO painel_contas_lancamentos_manuais
         (cliente_id, cliente_conta_id, competencia, faturamento, lucro_contribuicao, margem_contribuicao,
          investimento_ads, gmv_ads, observacao, created_by, updated_by, data_referencia)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11::date)
       ON CONFLICT (cliente_conta_id, competencia) DO UPDATE SET
         faturamento = EXCLUDED.faturamento,
         lucro_contribuicao = EXCLUDED.lucro_contribuicao,
         margem_contribuicao = EXCLUDED.margem_contribuicao,
         investimento_ads = EXCLUDED.investimento_ads,
         gmv_ads = EXCLUDED.gmv_ads,
         observacao = EXCLUDED.observacao,
         data_referencia = EXCLUDED.data_referencia,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *, (xmax = 0) AS inserido`,
      [clienteId, contaId, competencia, valores.faturamento, valores.lucroContribuicao, valores.margemContribuicao,
        valores.investimentoAds, valores.gmvAds, valores.observacao, userId ?? null, valores.dataReferencia ?? null]
    );
    const row = rows[0];
    await db.query(
      `/* painelContas:HISTORICO_MANUAL */
       INSERT INTO painel_contas_lancamentos_manuais_historico
         (lancamento_id, cliente_id, cliente_conta_id, competencia, acao, valores_json, user_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [row.id, clienteId, contaId, competencia, row.inserido ? "criado" : "alterado", JSON.stringify(valoresParaHistorico(valores)), userId ?? null]
    );
    return row;
  });
}

async function removerLancamentoManual({ clienteId, contaId, competencia, userId }) {
  return comTransacao(async (db) => {
    const { rows } = await db.query(
      `/* painelContas:DELETE_MANUAL */
       DELETE FROM painel_contas_lancamentos_manuais
        WHERE cliente_conta_id = $1 AND competencia = $2 AND cliente_id = $3
        RETURNING *`,
      [contaId, competencia, clienteId]
    );
    const row = rows[0];
    if (!row) return null;
    await db.query(
      `/* painelContas:HISTORICO_MANUAL */
       INSERT INTO painel_contas_lancamentos_manuais_historico
         (lancamento_id, cliente_id, cliente_conta_id, competencia, acao, valores_json, user_id)
       VALUES ($1,$2,$3,$4,'removido',$5::jsonb,$6)`,
      [row.id, clienteId, contaId, competencia, JSON.stringify({
        faturamento: row.faturamento, lucroContribuicao: row.lucro_contribuicao,
        margemContribuicao: row.margem_contribuicao, investimentoAds: row.investimento_ads,
        gmvAds: row.gmv_ads, observacao: row.observacao,
        dataReferencia: row.data_referencia instanceof Date ? row.data_referencia.toISOString().slice(0, 10) : row.data_referencia ?? null,
      }), userId ?? null]
    );
    return row;
  });
}

module.exports = {
  ensurePainelContasTables,
  listarResumosDaCompetencia,
  listarUltimaCompetenciaComDado,
  listarContasDeClientes,
  listarImportsDaCompetencia,
  listarComposicaoDosImports,
  medirSobreposicaoDosImports,
  listarPedidosDosImports,
  listarUltimoRunPorConta,
  listarAdsDaCompetencia,
  listarManuaisDaCompetencia,
  listarManuaisDaConta,
  listarHistoricoManual,
  listarResumosDoAno,
  obterContaDoCliente,
  salvarLancamentoManual,
  removerLancamentoManual,
  mapRow,
};
