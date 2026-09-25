// server/services/painelContas/painelContasRepository.js
// Leitura em LOTE (nunca 1 query por cliente) sobre os snapshots já
// persistidos — cliente_360_resumos_mensais (Cliente 360). Investimento e GMV
// Ads sao lidos da mesma versao gravada no payload do snapshot. Segue o padrão
// de dashboardService.loadProductionData (Auditoria §13/§18/§19): uma query
// cobre N clientes, sempre `WHERE c.id = ANY($1::int[])` ou equivalente.
//
// NENHUMA chamada aqui aciona cliente360ResultadoService.getResultado nem
// qualquer motor ao vivo — só leitura do snapshot batch (Auditoria §18 riscos
// 1/2, ETAPA 1 do checklist §27).

const pool = require("../../config/database");

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapRow(row) {
  const payload = typeof row.payload_json === "string"
    ? (() => { try { return JSON.parse(row.payload_json); } catch (_) { return {}; } })()
    : (row.payload_json || {});
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
  };
}

// Um resumo por cliente: o mais recente dentro do ano informado (ou o mais
// recente de qualquer ano, se `ano` for null/undefined). Clientes sem NENHUM
// snapshot simplesmente não aparecem no resultado — quem chama trata a
// ausência como `resumo: null`, nunca erro.
async function listarUltimosResumos(clienteIds, { ano = null } = {}) {
  if (!Array.isArray(clienteIds) || !clienteIds.length) return [];
  const anoLike = ano ? `${ano}-%` : null;
  const { rows } = await pool.query(
    `/* painelContas:ULTIMO_RESUMO_POR_CLIENTE */
     SELECT c.id AS cliente_id, c.slug AS cliente_slug,
            r.competencia, r.faturamento, r.mc_media, r.ads_investido,
            r.payload_json, r.sincronizado_em
       FROM clientes c
       LEFT JOIN LATERAL (
         SELECT competencia, faturamento, mc_media, ads_investido, payload_json, sincronizado_em
           FROM cliente_360_resumos_mensais s
          WHERE s.cliente_id = c.id
            AND ($2::text IS NULL OR s.competencia LIKE $2)
          ORDER BY s.competencia DESC
          LIMIT 1
       ) r ON true
      WHERE c.id = ANY($1::int[])`,
    [clienteIds, anoLike]
  );
  return rows.filter((row) => row.competencia !== null).map(mapRow);
}

// Todas as competências de um cliente dentro de um ano, ordenadas do mais
// antigo para o mais recente (para permitir variação mês-a-mês em sequência
// no service, sem nova query por mês).
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

module.exports = { listarUltimosResumos, listarResumosDoAno };
