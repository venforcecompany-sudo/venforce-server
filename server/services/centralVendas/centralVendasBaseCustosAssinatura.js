// server/services/centralVendas/centralVendasBaseCustosAssinatura.js
//
// Identidade da BASE DE CUSTOS com que um import da Central foi calculado
// (lacuna L5, doc 13). Mesma ideia de sentinelRecalculoBase.assinaturaBase:
// detecção por CONTEÚDO, nunca por updated_at (todo reimport reescreve
// updated_at mesmo sem mudar valor). A projeção é a que a Central USA para
// custo (buscarCustosPorBaseId: produto_id, custo_produto, imposto_percentual,
// todas as linhas da base), então só muda quando algo que pode mudar a margem
// mudou.
//
// Gravada no resumo_json do import (`baseCustos: { baseId, n, hash }`) e
// comparada com a base ATUAL quando um pedido é aberto. Nada é recalculado
// automaticamente: a diferença vira pendência explícita.

const ASSINATURA_SQL = `/* cv:base-custos-assinatura */
SELECT COUNT(*)::int AS n,
       COALESCE(md5(string_agg(concat_ws('|', produto_id, COALESCE(custo_produto::text, ''), COALESCE(imposto_percentual::text, '')),
                               ';' ORDER BY produto_id, custo_produto NULLS FIRST, imposto_percentual NULLS FIRST)), '') AS h
  FROM custos
 WHERE base_id = $1`;

async function assinaturaBaseCustos(db, baseId) {
  if (baseId === null || baseId === undefined || baseId === "") return null;
  const r = await db.query(ASSINATURA_SQL, [baseId]);
  const row = (r && r.rows && r.rows[0]) || {};
  if (typeof row.h !== "string") return null;
  return { baseId: String(baseId), n: Number(row.n) || 0, hash: row.h };
}

// gravada: { baseId, n, hash } do import; atual: idem da base vigente da conta (ou null)
function compararAssinatura(gravada, atual) {
  if (!gravada || !gravada.hash) return { estado: "sem_registro", gravada: gravada || null, atual: atual || null };
  if (!atual) return { estado: "base_atual_indisponivel", gravada, atual: null };
  if (String(gravada.baseId) !== String(atual.baseId)) return { estado: "base_trocada", gravada, atual };
  return { estado: gravada.hash === atual.hash && gravada.n === atual.n ? "igual" : "alterada", gravada, atual };
}

module.exports = { ASSINATURA_SQL, assinaturaBaseCustos, compararAssinatura };
