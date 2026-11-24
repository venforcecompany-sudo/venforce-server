// server/services/sentinel/sentinelConciliacaoRepositorio.js
//
// Persistência da conciliação da comissão (S1) — tabelas da migration 20261119 (NÃO aplicada em produção).
// Só SQL; nenhuma regra financeira aqui (o estado vem do conciliador puro). `db` é sempre explícito; escritas recebem a
// conexão que detém o advisory lock do coletor (dbEscrita).
//
// Regras de escrita:
//   · upsert por (conta, pedido) — idempotente; monotônico em `observado_em` (uma observação mais VELHA nunca
//     sobrescreve uma mais nova, mesmo que dois coletores escapem do lock);
//   · falha de coleta NUNCA apaga a conciliação anterior: só incrementa falhas, agenda nova tentativa e guarda o erro;
//   · a FK para sentinel_pedidos impede gravar pedido de outra conta e apaga junto no purge.

const { CONCILIACAO_CONTRATO_VERSAO } = require("./sentinelConciliacaoComissao");
const { CONTRATO_VERSAO } = require("./sentinelEvidenciaFinanceira");

const CHAVE_PAUSA_429 = "billing_429";
const MOTIVO_COLETA_FALHOU = "coleta_billing_falhou";

// Pedidos ELEGÍVEIS da conta (o escopo provado no S1-A: 1 item, quantidade 1, pago, comissão gravada, cálculo estável),
// na janela e com maturidade mínima (cobranças aparecem ~1 h após a venda), que precisam de (re)conciliação:
// nunca conciliados, pedido mudou (hash), contrato do conciliador mudou (reinterpretação: descontos já gravados são
// reaproveitados), reconsulta/falha vencida, ou esgotada com a retentativa LONGA vencida (recuperação automática depois
// de uma indisponibilidade do ML; o limite final é a janela). Concluídas ficam de fora.
// Forma do pedido elegível (sem janela de datas; alias `p` = sentinel_pedidos). FONTE ÚNICA: a seleção do coletor e a
// leitura operacional (cobertura) usam este mesmo predicado — nunca copiar.
const ELEGIBILIDADE_SQL = `p.status_ml = 'paid'
     AND p.comissao IS NOT NULL
     AND p.estado_margem IN ('confirmada', 'sem_custo', 'custo_ambiguo')
     AND jsonb_typeof(p.itens) = 'array' AND jsonb_array_length(p.itens) = 1
     AND (p.itens -> 0 ->> 'quantidade') = '1'`;

// Política de seleção (S1.5 — starvation comprovada em produção em 19/11: a ordem antiga, por
// COALESCE(proxima_tentativa_em, data_pedido) ASC, gastava o orçamento nos pedidos MAIS ANTIGOS da janela, que saíam dela
// antes de qualquer reconsulta). É ORDEM de consulta, não certeza de nada:
//   tier 0 — já conciliado, descontos em cache e reprocessamento devido (reconsulta/falha vencida, hash ou contrato mudou),
//            exceto esgotada: custa ~0 chamada extra (vai no lote do Billing, sem /discounts);
//   tier 1 — nunca consultado e citado por incidente aberto/reaberto/reconhecido (só se a tabela de incidentes existir);
//   tier 2 — nunca consultado (ou 1ª consulta que falhou sem observar nada), MAIS RECENTE primeiro;
//   tier 3 — reprocessamento devido sem descontos em cache;
//   tier 4 — esgotada com a retentativa longa vencida.
// Janelas: a PRIMEIRA consulta (e o reprocessamento de concluída por hash/contrato) fica em janelaDias; pedido já
// conciliado em reconsultar/falha/esgotada continua elegível até janelaReconsultaDias (≥ janelaDias), para que o documento
// provisório de um pedido de ~30 dias seja de fato reconsultado.
// $1 conta, $2 agora, $3 janelaDias, $4 maturidadeHoras, $5 limite, $6 contrato, $7 janelaReconsultaDias
function montarSelecionarSql({ comIncidentes = false } = {}) {
  const incidente = comIncidentes
    ? `EXISTS (SELECT 1 FROM sentinel_incidentes i
                  WHERE i.cliente_conta_id = p.cliente_conta_id
                    AND i.status IN ('aberto', 'reaberto', 'reconhecido')
                    AND p.pedido_id = ANY(i.pedidos_ids))`
    : "false";
  // ordem DENTRO da prioridade (mesma no ROW_NUMBER e no ORDER BY final)
  const ordem = (a) => `${a}.tier ASC,
            CASE WHEN ${a}.tier IN (1, 2) THEN ${a}.data_pedido END DESC NULLS LAST,
            COALESCE(${a}.proxima_tentativa_em, ${a}.data_pedido) ASC,
            ${a}.pedido_id ASC`;
  return `/* sentinel:CONCILIACAO_SELECIONAR${comIncidentes ? "_INC" : ""} */
  SELECT q.pedido_id, q.status_ml, q.itens, q.comissao, q.payload_hash, q.data_pedido,
         q.tem_conciliacao, q.estado_anterior, q.status_coleta, q.observacoes, q.falhas_consecutivas,
         q.pedido_payload_hash, q.descontos_min, q.descontos_consultado_em, q.tier
    FROM (
      SELECT s.*,
             -- COTA: o tier 0 (reprocessamento com cache: ~0 chamada extra, cabe num lote só do Billing) tem $5 vagas
             -- PRÓPRIAS; os demais tiers outras $5. Sem isso, ≥ $5 reconsultas vencidas tomariam todo o LIMIT e nenhum
             -- pedido novo seria consultado na execução mesmo com orçamento sobrando (achado da revisão independente).
             ROW_NUMBER() OVER (PARTITION BY (s.tier = 0) ORDER BY ${ordem("s")}) AS rn
        FROM (
          SELECT p.pedido_id, p.status_ml, p.itens, p.comissao, p.payload_hash, p.data_pedido,
                 (c.pedido_id IS NOT NULL) AS tem_conciliacao, c.estado AS estado_anterior, c.status_coleta,
                 c.observacoes, c.falhas_consecutivas, c.pedido_payload_hash, c.descontos_min, c.descontos_consultado_em,
                 c.proxima_tentativa_em,
                 CASE
                   WHEN c.pedido_id IS NULL THEN CASE WHEN ${incidente} THEN 1 ELSE 2 END
                   WHEN c.status_coleta = 'esgotada' THEN 4
                   WHEN c.descontos_min IS NOT NULL THEN 0
                   -- 1ª consulta que FALHOU (5xx/timeout do lote) e nunca observou nada: equivale a "nunca consultado"
                   -- (tier 2, por recência). No tier 3 ficaria atrás de todo o backlog novo (conta 86: ~67 novos/dia) e
                   -- nunca seria retentada. Backoff exponencial + lote menor por falhas continuam isolando o "venenoso".
                   WHEN c.status_coleta = 'falha' AND c.observado_em IS NULL THEN 2
                   ELSE 3
                 END AS tier
            FROM sentinel_pedidos p
            LEFT JOIN sentinel_conciliacao_comissao c ON c.cliente_conta_id = p.cliente_conta_id AND c.pedido_id = p.pedido_id
           WHERE p.cliente_conta_id = $1
             AND ${ELEGIBILIDADE_SQL}
             AND p.data_pedido >= $2::timestamptz - make_interval(days => GREATEST($3::int, $7::int))
             AND p.data_pedido <= $2::timestamptz - make_interval(hours => $4::int)
             AND (
                  -- primeira consulta / concluída que mudou: só dentro de janelaDias
                  (p.data_pedido >= $2::timestamptz - make_interval(days => $3::int)
                   AND (c.pedido_id IS NULL
                        OR c.pedido_payload_hash IS DISTINCT FROM p.payload_hash
                        OR c.contrato_versao IS DISTINCT FROM $6::smallint))
                  -- reconsulta/falha/esgotada vencida: até janelaReconsultaDias
               OR (c.status_coleta IN ('reconsultar', 'falha')
                   AND (c.proxima_tentativa_em IS NULL OR c.proxima_tentativa_em <= $2::timestamptz))
               OR (c.status_coleta = 'esgotada' AND c.proxima_tentativa_em <= $2::timestamptz)
             )
        ) s
    ) q
   WHERE q.rn <= $5
   ORDER BY ${ordem("q")}
   LIMIT 2 * $5::int`;
}

// Sem a tabela de incidentes (V0-b não aplicada) a subconsulta não pode nem ser preparada: variante sem tier 1.
const SELECIONAR_SQL = montarSelecionarSql({ comIncidentes: false });
const SELECIONAR_INCIDENTES_SQL = montarSelecionarSql({ comIncidentes: true });

const JANELA_RECONSULTA_PADRAO_DIAS = 60;

async function incidentesExistem(db) {
  try {
    const r = await db.query("SELECT to_regclass('public.sentinel_incidentes') IS NOT NULL AS ok");
    return r.rows[0]?.ok === true;
  } catch (_) {
    return false;
  }
}

async function selecionarCandidatos(db, contaId, { agoraIso, janelaDias, maturidadeHoras, limite, janelaReconsultaDias, comIncidentes }) {
  const usarInc = comIncidentes === undefined ? await incidentesExistem(db) : comIncidentes === true;
  const janelaRec = Math.max(Number(janelaDias) || 0, Number(janelaReconsultaDias) || JANELA_RECONSULTA_PADRAO_DIAS);
  const r = await db.query(usarInc ? SELECIONAR_INCIDENTES_SQL : SELECIONAR_SQL,
    [contaId, agoraIso, janelaDias, maturidadeHoras, limite, CONCILIACAO_CONTRATO_VERSAO, janelaRec]);
  return r.rows;
}

// Rotação: a conta cuja última conciliação gravada é a MAIS ANTIGA vai primeiro (nunca conciliada = primeiro de tudo), para
// que o orçamento GLOBAL da execução não deixe sempre a última conta da lista com menos. Consulta barata (índice por conta).
async function ordenarContasPorAntiguidade(db, contaIds) {
  if (!contaIds.length) return [];
  const r = await db.query(
    `SELECT x.id, (SELECT MAX(c.atualizado_em) FROM sentinel_conciliacao_comissao c WHERE c.cliente_conta_id = x.id) AS ultima
       FROM unnest($1::int[]) AS x(id)
      ORDER BY ultima ASC NULLS FIRST, x.id ASC`, [contaIds]);
  return r.rows.map((x) => Number(x.id));
}

// Mesmo critério do polling (sentinelWorker.selecionarContas): só contas ML ATIVAS com seller, dentro da allowlist.
async function contasAtivasMeli(db, contaIds) {
  if (!contaIds.length) return [];
  const r = await db.query(
    `SELECT id FROM cliente_contas
      WHERE ativo = true AND marketplace = 'meli' AND external_account_id IS NOT NULL AND id = ANY($1::int[])
      ORDER BY id`, [contaIds]);
  return r.rows.map((x) => Number(x.id));
}

const UPSERT_SQL = `/* sentinel:CONCILIACAO_UPSERT */
  INSERT INTO sentinel_conciliacao_comissao (
    cliente_conta_id, pedido_id, estado, motivos, contrato_versao, evidencia_versao, fonte, rebate_incorporado,
    comissao_centavos, gross_centavos, net_centavos, rebate_centavos, discount_centavos, cobrancas_tarifa_centavos,
    rebate_calculado_centavos, documento, documento_definitivo, cobrancas, descontos_min, descontos_consultado_em,
    pedido_payload_hash, status_coleta, observacoes, falhas_consecutivas, proxima_tentativa_em, ultimo_erro,
    observado_em, atualizado_em)
  VALUES ($1, $2, $3, $4::text[], $5, $6, 'billing_order_details', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
          $17::jsonb, $18::jsonb, $19::timestamptz, $20, $21, $22, 0, $23::timestamptz, NULL, $24::timestamptz, $24::timestamptz)
  ON CONFLICT (cliente_conta_id, pedido_id) DO UPDATE SET
    estado = EXCLUDED.estado, motivos = EXCLUDED.motivos, contrato_versao = EXCLUDED.contrato_versao,
    evidencia_versao = EXCLUDED.evidencia_versao, rebate_incorporado = EXCLUDED.rebate_incorporado,
    comissao_centavos = EXCLUDED.comissao_centavos, gross_centavos = EXCLUDED.gross_centavos, net_centavos = EXCLUDED.net_centavos,
    rebate_centavos = EXCLUDED.rebate_centavos, discount_centavos = EXCLUDED.discount_centavos,
    cobrancas_tarifa_centavos = EXCLUDED.cobrancas_tarifa_centavos, rebate_calculado_centavos = EXCLUDED.rebate_calculado_centavos,
    documento = EXCLUDED.documento, documento_definitivo = EXCLUDED.documento_definitivo, cobrancas = EXCLUDED.cobrancas,
    descontos_min = COALESCE(EXCLUDED.descontos_min, sentinel_conciliacao_comissao.descontos_min),
    descontos_consultado_em = COALESCE(EXCLUDED.descontos_consultado_em, sentinel_conciliacao_comissao.descontos_consultado_em),
    pedido_payload_hash = EXCLUDED.pedido_payload_hash, status_coleta = EXCLUDED.status_coleta,
    observacoes = EXCLUDED.observacoes, falhas_consecutivas = 0, proxima_tentativa_em = EXCLUDED.proxima_tentativa_em,
    ultimo_erro = NULL, observado_em = EXCLUDED.observado_em, atualizado_em = EXCLUDED.atualizado_em
  WHERE sentinel_conciliacao_comissao.observado_em IS NULL OR EXCLUDED.observado_em >= sentinel_conciliacao_comissao.observado_em
  RETURNING (xmax = 0) AS inserido`;

// res = saída do conciliador; extra = { comissaoCentavos, descontosMin, descontosConsultadoEm, hash, status, observacoes, proximaIso, agoraIso }
async function gravarConciliacao(dbW, contaId, pedidoId, res, extra) {
  const b = res.centavos.billing || {};
  const cobrancas = res.cobrancas.map((c) => [c.detail_id, c.subtipo, c.valor_centavos, c.documento, c.na_tarifa]);
  const r = await dbW.query(UPSERT_SQL, [
    contaId, String(pedidoId), res.estado, res.motivos, res.contrato.versao, res.contrato.evidencia_versao, res.rebate_incorporado,
    extra.comissaoCentavos, b.gross ?? null, b.net ?? null, b.rebate ?? null, b.discount ?? null, res.centavos.cobrancas_tarifa,
    res.rebate.calculado_descontos_centavos, res.faturamento.documento, res.faturamento.definitivo === true,
    JSON.stringify(cobrancas), extra.descontosMin ? JSON.stringify(extra.descontosMin) : null, extra.descontosConsultadoEm || null,
    extra.hash || null, extra.status, extra.observacoes, extra.proximaIso || null, extra.agoraIso,
  ]);
  return { gravado: r.rows.length > 0, inserido: r.rows[0]?.inserido === true };
}

// Falha de coleta (5xx, timeout, 206, errors[], 404…): preserva estado/valores anteriores. Linha nova nasce
// NAO_CONCILIADO com o motivo de coleta (nunca um zero).
const FALHA_SQL = `/* sentinel:CONCILIACAO_FALHA */
  INSERT INTO sentinel_conciliacao_comissao (
    cliente_conta_id, pedido_id, estado, motivos, contrato_versao, evidencia_versao, pedido_payload_hash,
    status_coleta, falhas_consecutivas, proxima_tentativa_em, ultimo_erro, atualizado_em)
  VALUES ($1, $2, 'NAO_CONCILIADO', ARRAY[$3::text], $4, $5, $6, $7, $8, $9::timestamptz, $10, $11::timestamptz)
  ON CONFLICT (cliente_conta_id, pedido_id) DO UPDATE SET
    status_coleta = EXCLUDED.status_coleta, falhas_consecutivas = EXCLUDED.falhas_consecutivas,
    proxima_tentativa_em = EXCLUDED.proxima_tentativa_em, ultimo_erro = EXCLUDED.ultimo_erro, atualizado_em = EXCLUDED.atualizado_em`;

async function registrarFalha(dbW, contaId, pedidoId, { hash, status, falhas, proximaIso, erro, agoraIso }) {
  await dbW.query(FALHA_SQL, [contaId, String(pedidoId), MOTIVO_COLETA_FALHOU, CONCILIACAO_CONTRATO_VERSAO, CONTRATO_VERSAO,
    hash || null, status, falhas, proximaIso || null, String(erro || "").slice(0, 300), agoraIso]);
}

// ── pausa global após 429 ────────────────────────────────────────────────────────────────────────
async function lerPausa(db, chave = CHAVE_PAUSA_429) {
  const r = await db.query("SELECT pausado_ate, ocorrencias FROM sentinel_conciliacao_controle WHERE chave = $1", [chave]);
  return r.rows[0] || { pausado_ate: null, ocorrencias: 0 };
}

// Nunca encurta uma pausa já registrada (GREATEST); conta ocorrências consecutivas (backoff exponencial).
async function registrarPausa(dbW, { ateIso, motivo, agoraIso }, chave = CHAVE_PAUSA_429) {
  await dbW.query(
    `INSERT INTO sentinel_conciliacao_controle (chave, pausado_ate, ocorrencias, motivo, atualizado_em)
     VALUES ($1, $2::timestamptz, 1, $3, $4::timestamptz)
     ON CONFLICT (chave) DO UPDATE SET
       pausado_ate = GREATEST(COALESCE(sentinel_conciliacao_controle.pausado_ate, EXCLUDED.pausado_ate), EXCLUDED.pausado_ate),
       ocorrencias = sentinel_conciliacao_controle.ocorrencias + 1, motivo = EXCLUDED.motivo, atualizado_em = EXCLUDED.atualizado_em`,
    [chave, ateIso, String(motivo || "").slice(0, 200), agoraIso]);
}

// Billing respondeu normalmente ⇒ zera a sequência de 429 (a pausa passada continua registrada, só não cresce mais).
async function zerarOcorrencias(dbW, chave = CHAVE_PAUSA_429) {
  await dbW.query("UPDATE sentinel_conciliacao_controle SET ocorrencias = 0 WHERE chave = $1 AND ocorrencias > 0", [chave]);
}

module.exports = {
  CHAVE_PAUSA_429,
  MOTIVO_COLETA_FALHOU,
  ELEGIBILIDADE_SQL,
  SELECIONAR_SQL,
  SELECIONAR_INCIDENTES_SQL,
  JANELA_RECONSULTA_PADRAO_DIAS,
  montarSelecionarSql,
  incidentesExistem,
  ordenarContasPorAntiguidade,
  UPSERT_SQL,
  FALHA_SQL,
  selecionarCandidatos,
  contasAtivasMeli,
  gravarConciliacao,
  registrarFalha,
  lerPausa,
  registrarPausa,
  zerarOcorrencias,
};
