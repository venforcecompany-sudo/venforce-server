// server/services/sentinel/sentinelConciliacaoLeitura.js
//
// LEITURA da conciliação da comissão (S1) para o backend do Sentinel e outros módulos. SOMENTE SELECT.
// Não altera lucro, margem, severidade, incidentes nem dispara aviso: a conciliação é uma camada de EVIDÊNCIA ao lado da
// margem oficial (`efeito_na_margem: "nenhum"`, `alertas_financeiros: "desligados"`).
//
// Sem a migration 20261119 devolve { disponivel:false } (nunca 500). Escopo sempre por contaIds já AUTORIZADOS pela
// carteira (o controller resolve no servidor).

const { conciliacaoSchemaPronto } = require("./sentinelSchema");
const { MOTIVOS, CATEGORIA_MOTIVO } = require("./sentinelConciliacaoComissao");

const ESTADOS = Object.freeze(["TARIFA_LIQUIDA_COMPROVADA", "TARIFA_BRUTA_COMPROVADA", "DIVERGENTE", "NAO_CONCILIADO"]);

// O que cada estado PERMITE afirmar (texto fixo, para qualquer consumidor exibir igual).
const INTERPRETACAO = Object.freeze({
  TARIFA_LIQUIDA_COMPROVADA: "A comissão do pedido confere com a tarifa LÍQUIDA cobrada pelo Mercado Livre; o rebate, se houver, já está dentro dela. Não somar rebate à margem.",
  TARIFA_BRUTA_COMPROVADA: "A comissão do pedido é a tarifa BRUTA; o Mercado Livre cobrou menos (rebate). Inconsistência a investigar; nenhum crédito é aplicado à margem.",
  DIVERGENTE: "Os valores do pedido e do Billing não fecham. Inconsistência a investigar — NÃO é prejuízo confirmado.",
  NAO_CONCILIADO: "Sem comprovação (dado ausente, cenário não validado ou coleta pendente). Nada a afirmar sobre a tarifa.",
});

// motivos da camada de LEITURA (pedido sem linha de conciliação)
const MOTIVOS_LEITURA = Object.freeze({
  AINDA_NAO_CONCILIADO: "ainda_nao_conciliado",
  COMISSAO_AUSENTE: "comissao_ausente",
  CALCULO_PROVISORIO: "calculo_provisorio",
  MIGRATION_AUSENTE: "migration_20261119_nao_aplicada",
});

const vazioPorEstado = () => Object.fromEntries(ESTADOS.map((e) => [e, 0]));

function definitividade(documento, definitivo) {
  if (definitivo) return { documento, definitivo: true, leitura: "documento processado (liquidação não verificada)" };
  if (documento === "PROCESSING" || documento === "MISTO") return { documento, definitivo: false, leitura: "cobrança observada; documento em processamento (pode mudar)" };
  return { documento: documento || null, definitivo: false, leitura: "sem documento definitivo" };
}

function linhaParaItem(r, hashAtual) {
  return {
    contaId: r.cliente_conta_id,
    pedidoId: r.pedido_id,
    estado: r.estado,
    interpretacao: INTERPRETACAO[r.estado],
    motivos: (r.motivos || []).map((m) => ({ codigo: m, categoria: CATEGORIA_MOTIVO[m] || "coleta" })),
    rebateIncorporado: r.rebate_incorporado,
    efeitoNaMargem: "nenhum",
    documento: definitividade(r.documento, r.documento_definitivo === true),
    centavos: {
      comissao: r.comissao_centavos, gross: r.gross_centavos, net: r.net_centavos, rebate: r.rebate_centavos,
      discount: r.discount_centavos, cobrancasTarifa: r.cobrancas_tarifa_centavos, rebateCalculadoDescontos: r.rebate_calculado_centavos,
    },
    contratoVersao: r.contrato_versao,
    evidenciaVersao: r.evidencia_versao,
    fonte: r.fonte,
    coleta: {
      status: r.status_coleta, observacoes: r.observacoes, falhasConsecutivas: r.falhas_consecutivas,
      proximaTentativaEm: r.proxima_tentativa_em, ultimoErro: r.ultimo_erro, observadoEm: r.observado_em, atualizadoEm: r.atualizado_em,
    },
    // o pedido mudou depois da conciliação (nova comissão/itens): a conciliação vale para o cálculo ANTERIOR
    desatualizada: hashAtual !== undefined && (r.pedido_payload_hash || null) !== (hashAtual || null),
  };
}

// Por que um pedido sem linha não foi conciliado (pura; usa a linha de sentinel_pedidos).
function motivosSemConciliacao(p) {
  const motivos = [];
  const itens = Array.isArray(p.itens) ? p.itens : [];
  if (itens.length !== 1) motivos.push(MOTIVOS.MULTIPLOS_ITENS);
  else if (String(itens[0]?.quantidade) !== "1") motivos.push(MOTIVOS.QUANTIDADE_MAIOR_QUE_1);
  if (p.status_ml === "cancelled" || p.status_ml === "invalid" || p.status_ml === "partially_refunded") motivos.push(MOTIVOS.CANCELAMENTO_OU_REEMBOLSO);
  else if (p.status_ml !== "paid") motivos.push(MOTIVOS.PEDIDO_NAO_PAGO);
  if (p.comissao === null || p.comissao === undefined) motivos.push(MOTIVOS_LEITURA.COMISSAO_AUSENTE);
  if (!["confirmada", "sem_custo", "custo_ambiguo"].includes(p.estado_margem)) motivos.push(MOTIVOS_LEITURA.CALCULO_PROVISORIO);
  if (!motivos.length) motivos.push(MOTIVOS_LEITURA.AINDA_NAO_CONCILIADO);
  return motivos;
}

async function resumoConciliacao(db, { contaIds }) {
  const ids = (contaIds || []).map(Number).filter(Number.isInteger);
  const base = { efeitoNaMargem: "nenhum", alertasFinanceiros: "desligados", interpretacao: INTERPRETACAO };
  if (!(await conciliacaoSchemaPronto(db))) return { ...base, disponivel: false, motivo: MOTIVOS_LEITURA.MIGRATION_AUSENTE, contas: [], pausa: null };
  const contas = new Map(ids.map((id) => [id, {
    contaId: id, total: 0, porEstado: vazioPorEstado(), documentoDefinitivo: 0, documentoProvisorio: 0,
    coleta: { concluida: 0, reconsultar: 0, falha: 0, esgotada: 0 }, ultimaObservacaoEm: null,
  }]));
  if (ids.length) {
    const r = await db.query(
      `SELECT cliente_conta_id, estado, documento_definitivo, status_coleta, COUNT(*)::int AS n, MAX(observado_em) AS ultima
         FROM sentinel_conciliacao_comissao WHERE cliente_conta_id = ANY($1::int[])
        GROUP BY 1, 2, 3, 4`, [ids]);
    for (const row of r.rows) {
      const c = contas.get(Number(row.cliente_conta_id));
      if (!c) continue;
      c.total += row.n;
      c.porEstado[row.estado] = (c.porEstado[row.estado] || 0) + row.n;
      if (row.documento_definitivo) c.documentoDefinitivo += row.n; else c.documentoProvisorio += row.n;
      c.coleta[row.status_coleta] = (c.coleta[row.status_coleta] || 0) + row.n;
      if (row.ultima && (!c.ultimaObservacaoEm || new Date(row.ultima) > new Date(c.ultimaObservacaoEm))) c.ultimaObservacaoEm = row.ultima;
    }
  }
  const p = await db.query("SELECT pausado_ate, ocorrencias FROM sentinel_conciliacao_controle WHERE chave = 'billing_429'");
  const pausa = p.rows[0] && p.rows[0].pausado_ate && new Date(p.rows[0].pausado_ate) > new Date()
    ? { ate: p.rows[0].pausado_ate, ocorrencias: p.rows[0].ocorrencias } : null;
  return { ...base, disponivel: true, contas: [...contas.values()], pausa };
}

async function listarConciliacoes(db, { contaIds, estado = null, limit = 50, offset = 0 }) {
  const ids = (contaIds || []).map(Number).filter(Number.isInteger);
  if (!(await conciliacaoSchemaPronto(db))) return { disponivel: false, motivo: MOTIVOS_LEITURA.MIGRATION_AUSENTE, itens: [], total: 0 };
  if (!ids.length) return { disponivel: true, itens: [], total: 0 };
  if (estado !== null && !ESTADOS.includes(estado)) throw Object.assign(new Error("estado inválido"), { code: "PARAMETRO_INVALIDO" });
  const r = await db.query(
    `SELECT c.*, p.payload_hash AS hash_atual, COUNT(*) OVER()::int AS total
       FROM sentinel_conciliacao_comissao c
       JOIN sentinel_pedidos p ON p.cliente_conta_id = c.cliente_conta_id AND p.pedido_id = c.pedido_id
      WHERE c.cliente_conta_id = ANY($1::int[]) AND ($2::text IS NULL OR c.estado = $2)
      ORDER BY c.atualizado_em DESC, c.cliente_conta_id, c.pedido_id
      LIMIT $3 OFFSET $4`, [ids, estado, limit, offset]);
  return { disponivel: true, itens: r.rows.map((x) => linhaParaItem(x, x.hash_atual)), total: r.rows[0]?.total || 0 };
}

// null ⇒ pedido inexistente nesta conta (o controller responde 404 igual para inexistente e fora da carteira).
async function obterConciliacaoPedido(db, contaId, pedidoId) {
  const p = await db.query(
    "SELECT pedido_id, status_ml, itens, comissao, estado_margem, payload_hash FROM sentinel_pedidos WHERE cliente_conta_id = $1 AND pedido_id = $2",
    [contaId, String(pedidoId)]);
  if (!p.rows.length) return null;
  const pedido = p.rows[0];
  const semLinha = (motivos, extra = {}) => ({
    contaId: Number(contaId), pedidoId: String(pedidoId), estado: "NAO_CONCILIADO", interpretacao: INTERPRETACAO.NAO_CONCILIADO,
    motivos: motivos.map((m) => ({ codigo: m, categoria: CATEGORIA_MOTIVO[m] || "leitura" })), rebateIncorporado: "desconhecido",
    efeitoNaMargem: "nenhum", documento: definitividade(null, false), centavos: null, coleta: null, desatualizada: false, ...extra,
  });
  if (!(await conciliacaoSchemaPronto(db))) return semLinha([MOTIVOS_LEITURA.MIGRATION_AUSENTE], { disponivel: false });
  const r = await db.query("SELECT * FROM sentinel_conciliacao_comissao WHERE cliente_conta_id = $1 AND pedido_id = $2", [contaId, String(pedidoId)]);
  if (!r.rows.length) return semLinha(motivosSemConciliacao(pedido), { disponivel: true });
  return { ...linhaParaItem(r.rows[0], pedido.payload_hash), disponivel: true };
}

module.exports = {
  ESTADOS,
  INTERPRETACAO,
  MOTIVOS_LEITURA,
  motivosSemConciliacao,
  linhaParaItem,
  resumoConciliacao,
  listarConciliacoes,
  obterConciliacaoPedido,
};
