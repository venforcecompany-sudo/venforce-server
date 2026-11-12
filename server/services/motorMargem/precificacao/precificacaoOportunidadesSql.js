// server/services/motorMargem/precificacao/precificacaoOportunidadesSql.js
// Oportunidades — as promoções ELEGÍVEIS da conta, casadas com o Margin
// Snapshot da MESMA conta, em UMA consulta (qualquer tamanho de catálogo).
//
// O banco só SELECIONA. Nenhuma conta financeira roda aqui: LC', margem',
// ΔLC, empate de volume e veredito saem do `core.calcularCenario` (uma fórmula
// só), no Node, e é lá que se ordena por ΔLC × unidades e se pagina — a
// ordem depende do cálculo, então não pode ser resolvida em SQL sem copiar a
// fórmula. O que o SQL aplica é a ELEGIBILIDADE (regra de negócio, a mesma de
// precificacaoOportunidadesService.motivoForaDoRanking):
//   - promoção em andamento (`started`/`active`) → "ativa": fora;
//   - P' >= preço atual do anúncio → "sem_desconto_efetivo": fora;
//   - sem preço de promoção utilizável, sem Margin Snapshot ou item fora do
//     catálogo: não há o que comparar.
// Nada mais é filtrado: insumo ausente (custo, imposto, comissão) NÃO exclui a
// linha — ela sai `bloqueado` com o motivo, em vez de sumir da lista.
// O LEFT JOIN em meli_anuncios só traz o tipo de logística (não filtra nem
// multiplica linhas: um anúncio por cliente + MLB).
//
// `fonteSql` é um SELECT que expõe: item_id, chave, preco_promo, retorno,
// promo_status (texto; nulo/vazio = aceito) e, quando a fonte as tem,
// promo_preco_original (preço cheio da própria promoção) — demais colunas passam adiante
// como estão — e usa os parâmetros $1..$n de `paramsFonte`.

const { sqlFreteLegadoNaoVerificado } = require("../margemConfiavel");

function sqlOportunidadesElegiveis({ fonteSql, paramsFonte = [], clienteContaId, clienteId }) {
  const k = paramsFonte.length;
  const sql = `
    WITH promos AS (${fonteSql})
    SELECT pr.*, s.titulo AS snap_titulo, s.image_url, s.price, s.cost, s.tax_rate, s.fixed_fee,
           s.commission_rate,
           -- Frete gravado ANTES da verificação numa conta com bloqueio de legado
           -- (FRETE_LEGADO_BLOQUEAR_CONTAS): ausente, como na tabela da Central —
           -- a linha sai bloqueada em vez de comparar com um frete subestimado.
           CASE WHEN ${sqlFreteLegadoNaoVerificado("s")} THEN NULL ELSE s.freight END AS freight,
           s.margin, s.commission AS snap_commission, s.profit AS snap_profit,
           s.quality_json->>'targetMargin' AS snap_target_margin, s.calculated_at AS snap_calculated_at,
           s.list_price AS snap_list_price,
           a.logistic_type AS anuncio_logistic_type
      FROM promos pr
      JOIN margin_projection_snapshots s
        ON s.cliente_conta_id = $${k + 1} AND s.marketplace = 'meli'
       AND s.item_id = pr.item_id AND s.catalog_missing_since IS NULL
      -- Tipo de logística do anúncio: decide se frete é "zero declarado"
      -- (combinável) ou dado ausente. Sem cadastro do anúncio fica null.
      LEFT JOIN meli_anuncios a
        ON a.cliente_id = $${k + 2} AND a.item_id = pr.item_id
     WHERE pr.preco_promo > 0
       -- Fora do ranking (precificacaoOportunidadesService.motivoForaDoRanking):
       -- promoção em andamento = "ativa"; P' >= preço atual = "sem_desconto_efetivo".
       AND LOWER(COALESCE(pr.promo_status, '')) NOT IN ('started', 'active')
       AND s.price IS NOT NULL AND pr.preco_promo < s.price
     ORDER BY pr.item_id ASC, pr.chave ASC`;
  return { sql, params: [...paramsFonte, clienteContaId, clienteId] };
}

/** Linhas da consulta (a linha-sentinela, se houver, nunca tem item_id). */
function lerLinhas(result) {
  return ((result && result.rows) || []).filter((r) => r.item_id !== null && r.item_id !== undefined);
}

module.exports = { sqlOportunidadesElegiveis, lerLinhas };
