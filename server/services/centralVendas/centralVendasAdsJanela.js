// server/services/centralVendas/centralVendasAdsJanela.js
//
// Ads da MESMA janela das vendas, por conta — para o resultado depois de Ads
// não ficar indisponível o mês corrente inteiro.
//
// O sync noturno da Central já consulta o Mercado Ads de CADA conta exatamente
// na janela que acabou de sincronizar (centralVendasAdsSyncService →
// mlAdsService.buscarPerformanceML, a mesma função do Financeiro), mas só grava
// a SOMA do cliente em ads_resumos_mensais (escopo cliente, sem a janela).
// Aqui o valor POR CONTA e a janela exata ficam no próprio run da conta
// (central_vendas_sync_runs.metadata_json.adsDaJanela) — sem migration, sem
// chamada nova ao ML, sem tocar no Financeiro.
//
// Garantias:
//   · escopo: só grava/lê no run da MESMA conta (cliente_conta_id) e com a
//     MESMA janela (date_from/date_to do run = janela consultada); qualquer
//     diferença ⇒ não grava / não usa;
//   · flag desligada por padrão (CENTRAL_VENDAS_ADS_JANELA + _CONTAS);
//   · falha ao gravar nunca derruba o sync (só registra);
//   · leitura: fonte "janela" do contrato centralVendasCustosOperacionais —
//     provisória até o mês consolidar (regra do Financeiro: fim do mês + 3 dias).

const ENV_NAME = "CENTRAL_VENDAS_ADS_JANELA";
const ENV_CONTAS = "CENTRAL_VENDAS_ADS_JANELA_CONTAS";
const VALORES_LIGADO = new Set(["1", "true", "on", "yes", "sim"]);
const DATA = /^\d{4}-\d{2}-\d{2}$/;

function isAdsDaJanelaHabilitado({ clienteContaId }, env = process.env) {
  const raw = env[ENV_NAME];
  if (raw == null || !VALORES_LIGADO.has(String(raw).trim().toLowerCase())) return false;
  const lista = String(env[ENV_CONTAS] || "").split(",").map((v) => v.trim()).filter(Boolean);
  if (lista.includes("*")) return true;
  return clienteContaId != null && lista.includes(String(clienteContaId));
}

const numeroOuNull = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));

// Registro gravado no run. Só números e datas (nada de token/headers).
function registroAdsDaJanela({ clienteContaId, dateFrom, dateTo, investimentoAds, gmvAds, consultadoEm }) {
  const inv = numeroOuNull(investimentoAds);
  const gmv = numeroOuNull(gmvAds);
  if (!DATA.test(String(dateFrom || "")) || !DATA.test(String(dateTo || "")) || inv === null || gmv === null) return null;
  return {
    v: 1,
    clienteContaId: Number(clienteContaId),
    dateFrom, dateTo,
    investimentoAds: Math.round(inv * 100) / 100,
    gmvAds: Math.round(gmv * 100) / 100,
    consultadoEm: new Date(consultadoEm || Date.now()).toISOString(),
    fonte: "mercado_ads_sync_noturno",
  };
}

// Grava no run da conta. O WHERE garante conta e janela; 0 linhas ⇒ false.
async function gravarAdsDaJanela(db, { runId, ...dados }) {
  const reg = registroAdsDaJanela(dados);
  if (!reg || !runId) return false;
  const r = await db.query(
    `UPDATE central_vendas_sync_runs
        SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object('adsDaJanela', $2::jsonb)
      WHERE id = $1 AND cliente_conta_id = $3 AND date_from = $4::date AND date_to = $5::date`,
    [runId, JSON.stringify(reg), reg.clienteContaId, reg.dateFrom, reg.dateTo]
  );
  return (r.rowCount || 0) === 1;
}

// Lê os registros dos runs dos imports selecionados, só da conta pedida.
async function lerAdsDaJanela(db, { clienteContaId, syncRunIds }) {
  const ids = [...new Set((syncRunIds || []).filter((v) => v != null).map(String))];
  if (clienteContaId == null || !ids.length) return [];
  const { rows } = await db.query(
    `SELECT id, cliente_conta_id, to_char(date_from, 'YYYY-MM-DD') AS date_from, to_char(date_to, 'YYYY-MM-DD') AS date_to,
            metadata_json->'adsDaJanela' AS ads
       FROM central_vendas_sync_runs
      WHERE id = ANY($1::bigint[]) AND cliente_conta_id = $2 AND metadata_json ? 'adsDaJanela'`,
    [ids, clienteContaId]
  );
  return rows;
}

// Linha do run → fonte "janela" do contrato. Qualquer incoerência ⇒ descartada.
function fonteAdsDaJanela(row, clienteContaId) {
  const a = row && (typeof row.ads === "string" ? JSON.parse(row.ads) : row.ads);
  if (!a || Number(row.cliente_conta_id) !== Number(clienteContaId) || Number(a.clienteContaId) !== Number(clienteContaId)) return null;
  if (a.dateFrom !== row.date_from || a.dateTo !== row.date_to) return null;
  const reg = registroAdsDaJanela(a);
  if (!reg) return null;
  return {
    escopo: "conta", clienteContaId: Number(clienteContaId),
    cobertura: { tipo: "janela", dateFrom: reg.dateFrom, dateTo: reg.dateTo },
    disponivel: true, investimentoAds: reg.investimentoAds, gmvAds: reg.gmvAds,
    consultadoEm: a.consultadoEm || null, origem: reg.fonte, syncRunId: String(row.id),
  };
}

module.exports = {
  ENV_NAME,
  ENV_CONTAS,
  isAdsDaJanelaHabilitado,
  registroAdsDaJanela,
  gravarAdsDaJanela,
  lerAdsDaJanela,
  fonteAdsDaJanela,
};
