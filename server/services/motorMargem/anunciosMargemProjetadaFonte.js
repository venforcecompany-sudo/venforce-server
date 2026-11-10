// server/services/motorMargem/anunciosMargemProjetadaFonte.js
// -----------------------------------------------------------------------------
// Fonte da margem PROJETADA exibida/ordenada em Anúncios ML — passo 3 de
// docs/PLANO_FONTE_CANONICA_MARGEM.md (Margin Snapshot como fonte canônica).
//
// Ordem de leitura, por item:
//   1. `margin_projection_snapshots` (Margin Snapshot, pipeline A) — a mesma
//      tabela da Central de Margem, atualizada pelo worker (refresh manual,
//      pós-sync da Central de Vendas, mudança de Base). Status gravado é o da
//      margem PROJETADA (worker roda o Motor sem vendas), alinhado com o
//      rótulo "Margem Projetada" da coluna (passo 2 do plano).
//   2. `anuncios_margem_projetada_snapshot` (pipeline B, legado) — só para os
//      itens que ainda não têm linha em A. A data de cálculo vai junto, então
//      um valor antigo do legado nunca se passa por recente.
//
// Somente leitura, nenhuma chamada ao ML, nenhum recálculo: devolve o MESMO
// formato de `margemProjetadaSnapshotRepository.lerSnapshotPorItens`
// (Map item_id -> {marginPercent, profit, computable, status, calculadoEm,
// origemJob}), então ranking e célula do controller não mudam.
//
// Escopo de conta (multi-conta nunca mistura snapshots):
//   - conta resolvida → A filtrada por `cliente_conta_id = conta` (chave
//     canônica). Nunca cai em outra conta nem na principal.
//   - conta NÃO resolvida (request sem clienteContaId) → cada item só lê a
//     linha de A da conta DONA dele no catálogo (`meli_anuncios.cliente_conta_id`).
//     Linha de catálogo legada sem conta (NULL) não tem dono declarado: aceita
//     a linha de A do item (MLB é único por vendedor); o DISTINCT ON é só
//     defesa e fica com o cálculo mais recente.
// O legado (B) tem UNIQUE (cliente_id, item_id): 1 linha por item, sem conta.
//
// Rollback sem deploy: ANUNCIOS_MARGEM_FONTE=legado volta a ler só a tabela
// antiga. Falha ao ler A (ex.: schema do Margin Snapshot ausente porque o
// worker nunca foi ligado nesta instância) também cai no legado, nunca 500.
// -----------------------------------------------------------------------------

const pool = require("../../config/database");
const legado = require("./margemProjetadaSnapshotRepository");
const margemConfiavel = require("./margemConfiavel");

const MARKETPLACE = "meli";
// Valor de `origemJob` para linhas vindas de A — distingue no payload a
// fonte canônica de "manual_cli"/"orquestrador_manual" (legado).
const ORIGEM_MARGIN_SNAPSHOT = "margin_snapshot";
// `fonte` exposto na resposta de Anúncios (margemProjetadaFonte): qual tabela
// respondeu — independente de quem gravou (origemJob).
const FONTE_MARGIN_SNAPSHOT = "margin_snapshot";
const FONTE_LEGADO = "legado";

function marcarLegado(mapa) {
  const marcado = new Map();
  for (const [itemId, valor] of mapa) marcado.set(itemId, { ...valor, fonte: FONTE_LEGADO });
  return marcado;
}

function fonteConfigurada(env = process.env) {
  return String(env.ANUNCIOS_MARGEM_FONTE ?? "").trim().toLowerCase() === "legado" ? "legado" : "snapshot";
}

async function lerMarginSnapshotPorItens({ clienteId, clienteContaId = null, itemIds }, db = pool) {
  const ids = Array.from(new Set((itemIds || []).map(String).filter(Boolean)));
  if (!ids.length) return new Map();

  const params = [clienteId, MARKETPLACE, ids];
  let escopoConta;
  if (clienteContaId != null) {
    params.push(clienteContaId);
    escopoConta = "\n      WHERE s.cliente_conta_id = $4";
  } else {
    escopoConta = "\n       JOIN meli_anuncios a ON a.cliente_id = s.cliente_id AND a.item_id = s.item_id"
      + "\n      WHERE (a.cliente_conta_id = s.cliente_conta_id OR a.cliente_conta_id IS NULL)";
  }

  const { rows } = await db.query(
    `-- LER_MARGIN_SNAPSHOT_PARA_ANUNCIOS
     SELECT DISTINCT ON (s.item_id) s.item_id, s.margin_percent, s.profit, s.status, s.calculated_at,
            s.assumed_json, s.refresh_status, s.quality_json->>'freteAplicavel' AS frete_aplicavel,
            s.quality_json->'freteQualidade'->>'nivel' AS frete_nivel,
            s.cliente_conta_id, jsonb_typeof(s.quality_json->'freteQualidade') AS frete_qualidade_tipo
       FROM margin_projection_snapshots s${escopoConta}
        AND s.cliente_id = $1
        AND s.marketplace = $2
        AND s.item_id = ANY($3::text[])
      ORDER BY s.item_id, s.calculated_at DESC`,
    params
  );

  const porItem = new Map();
  for (const r of rows) {
    const marginPercent = r.margin_percent != null ? Number(r.margin_percent) : null;
    const assumidos = Array.isArray(r.assumed_json) ? r.assumed_json : [];
    // P0 04/11/2026: margem com comissão ou frete ASSUMIDOS como 0 (linhas
    // gravadas antes da trava de cotação incompleta) é inflada — ex.: R$ 50 com
    // 45%. Não entra como computável: fora da ordenação, da faixa e da média da
    // família, e a célula não mostra o número como se fosse margem.
    const custoAusenteBase = margemConfiavel.custoMarketplaceAusente({
      assumed: assumidos,
      freteAplicavel: r.frete_aplicavel === "true" ? true : r.frete_aplicavel === "false" ? false : null,
    });
    const custoMarketplaceAusente = custoAusenteBase || margemConfiavel.freteLegadoNaoVerificado({
      clienteContaId: r.cliente_conta_id, freteQualidade: r.frete_qualidade_tipo === "object" ? {} : null,
    });
    porItem.set(r.item_id, {
      marginPercent: custoMarketplaceAusente ? null : marginPercent,
      profit: custoMarketplaceAusente ? null : (r.profit != null ? Number(r.profit) : null),
      // O Motor só zera margin quando a projetada não é computável
      // (marginEngine.computeMargin) — A não tem coluna `computable` própria.
      computable: marginPercent != null && !custoMarketplaceAusente,
      margemIncompleta: custoMarketplaceAusente,
      // 'estimado_dimensoes_historicas' | 'estimado_custo_cobrado' | 'cotado_ml' | null (sem avaliação).
      ...(r.frete_nivel ? { freteNivel: r.frete_nivel } : {}),
      assumidos,
      // 'fresh' | 'stale' | 'failed' | … — valor de um run anterior não revalidado.
      refreshStatus: r.refresh_status || null,
      status: r.status || null,
      calculadoEm: r.calculated_at || null,
      origemJob: ORIGEM_MARGIN_SNAPSHOT,
      fonte: FONTE_MARGIN_SNAPSHOT,
    });
  }
  return porItem;
}

async function lerMargemProjetadaPorItens({ clienteId, clienteContaId = null, itemIds }, depsOverride = {}) {
  const deps = {
    env: process.env,
    db: pool,
    lerMarginSnapshot: lerMarginSnapshotPorItens,
    lerLegado: legado.lerSnapshotPorItens,
    logger: console,
    ...depsOverride,
  };
  const ids = Array.from(new Set((itemIds || []).map(String).filter(Boolean)));
  if (!ids.length) return new Map();

  if (fonteConfigurada(deps.env) === "legado") {
    return marcarLegado(await deps.lerLegado({ clienteId, itemIds: ids }));
  }

  let canonico = new Map();
  try {
    canonico = await deps.lerMarginSnapshot({ clienteId, clienteContaId, itemIds: ids }, deps.db);
  } catch (err) {
    deps.logger.error(
      "[anuncios-meli] margem projetada: erro ao ler margin_projection_snapshots, usando só o legado:",
      err.message
    );
  }

  const faltantes = ids.filter((id) => !canonico.has(id));
  if (!faltantes.length) return canonico;

  // Erro no legado propaga (mesmo contrato de antes): o chamador já trata
  // falha de leitura com fallback próprio (campos ausentes / ordem padrão).
  const doLegado = marcarLegado(await deps.lerLegado({ clienteId, itemIds: faltantes }));
  const resultado = new Map(canonico);
  for (const [itemId, valor] of doLegado) {
    if (!resultado.has(itemId)) resultado.set(itemId, valor);
  }
  return resultado;
}

module.exports = {
  lerMargemProjetadaPorItens,
  lerMarginSnapshotPorItens,
  fonteConfigurada,
  ORIGEM_MARGIN_SNAPSHOT,
  FONTE_MARGIN_SNAPSHOT,
  FONTE_LEGADO,
};
