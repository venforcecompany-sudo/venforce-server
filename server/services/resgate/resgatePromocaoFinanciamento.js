// server/services/resgate/resgatePromocaoFinanciamento.js
//
// Quem financia a promoção que FORMA o preço do comprador — a partir da
// EVIDÊNCIA lida no ML (GET /seller-promotions/items/{id} e, no desempate,
// GET /items/{id}/sale_price), nunca presumida. Puro.
//
// Regras (comprovadas em 913 leituras das contas piloto, 12/11/2026):
//   · A promoção que forma o preço é a INICIADA cujo `price` = preço do
//     comprador; desempate por `sale_price.metadata.campaign_id`.
//   · Com `meli_percentage` informado: subsídio = original_price × meli% /100,
//     conferido contra o preço (original × (1 − (meli+seller)/100) = comprador).
//   · SELLER_CAMPAIGN / PRICE_DISCOUNT sem participação do ML na resposta
//     completa = vendedor 100%, subsídio 0 COMPROVADO (não exige rebate > 0).
//   · DEAL / LIGHTNING / outros sem `meli_percentage` = NÃO determinado →
//     margem bloqueada (nunca vira zero).
//   · `boosted_offer`: nenhuma resposta trouxe campo "boost"; se aparecer, o
//     financiamento fica não determinado (não somamos compensação que não
//     sabemos medir, nem em dobro).

const TOL = 0.011;
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const brl = (v) => "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pctBr = (v) => Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + "%";

const TIPOS_DO_VENDEDOR = new Set(["SELLER_CAMPAIGN", "PRICE_DISCOUNT"]);
const TIPO_ROTULO = {
  SELLER_CAMPAIGN: "Campanha própria do vendedor", PRICE_DISCOUNT: "Desconto do vendedor", SMART: "Campanha cofinanciada (SMART)",
  DEAL: "Campanha tradicional (DEAL)", LIGHTNING: "Oferta relâmpago", PRICE_MATCHING: "Price matching", SMART_LIGHTNING: "Relâmpago cofinanciada",
  MARKETPLACE_CAMPAIGN: "Campanha do Mercado Livre", PRE_NEGOTIATED: "Desconto pré-negociado", UNHEALTHY_STOCK: "Estoque parado",
};
const FINANCIAMENTO = { VENDEDOR: "VENDEDOR_100", COFINANCIADA: "ML_COFINANCIA", INDETERMINADO: "NAO_DETERMINADO" };

/** Promoções INICIADAS da resposta bruta de /seller-promotions/items/{id}, só com os campos que importam. */
function iniciadasDaResposta(lista) {
  return (Array.isArray(lista) ? lista : []).filter((p) => p && (p.status === "started" || p.status === "active")).map((p) => ({
    id: p.id || null, refId: p.ref_id || null, type: p.type || null, subType: p.sub_type || null, status: p.status,
    price: num(p.price), original_price: num(p.original_price), meli_percentage: num(p.meli_percentage), seller_percentage: num(p.seller_percentage),
    name: p.name || null, camposBoost: Object.keys(p).filter((k) => /boost/i.test(k)),
  }));
}

/**
 * @param {object} a
 * @param {Array}  a.iniciadas   saída de iniciadasDaResposta (ou equivalente do Promo Snapshot)
 * @param {object} [a.salePrice] { amount, regular_amount, metadata:{campaign_id} } ou { erro }
 * @param {number} a.vigente     preço do comprador
 * @param {number} a.cheio       preço cheio (standard) do vendedor
 * @param {number} [a.promoStatus=200] HTTP da leitura das promoções
 * @returns {{ comprovado, financiamento, subsidio, tipo, tipoRotulo, id, nome, pendencia, texto, fonte }}
 */
function classificarFinanciamento({ iniciadas, salePrice = null, vigente, cheio, promoStatus = 200, fonte = null }) {
  const base = { fonte, tipo: null, tipoRotulo: null, id: null, nome: null, financiamento: null, subsidio: null, comprovado: false, pendencia: null, texto: null };
  const v = num(vigente), ch = num(cheio);
  if (promoStatus !== 200) return { ...base, financiamento: FINANCIAMENTO.INDETERMINADO, pendencia: "LEITURA_PROMO_INCOMPLETA", texto: `Leitura das promoções incompleta (HTTP ${promoStatus}): participação do ML desconhecida.` };
  if (v === null) return { ...base, financiamento: FINANCIAMENTO.INDETERMINADO, pendencia: "PRECO_COMPRADOR_DESCONHECIDO", texto: "Preço do comprador desconhecido." };
  let casam = (iniciadas || []).filter((p) => num(p.price) !== null && Math.abs(p.price - v) < TOL);
  if (casam.length !== 1 && salePrice && salePrice.metadata && salePrice.metadata.campaign_id) {
    if (num(salePrice.amount) !== null && Math.abs(salePrice.amount - v) >= TOL) {
      return { ...base, financiamento: FINANCIAMENTO.INDETERMINADO, pendencia: "PRECO_MUDOU", texto: `Preço do comprador mudou depois da leitura anterior (${brl(v)} → ${brl(salePrice.amount)}): recalcular.` };
    }
    const porId = (iniciadas || []).filter((p) => p.id === salePrice.metadata.campaign_id);
    if (porId.length === 1) casam = porId;
  }
  if (casam.length === 0) return { ...base, financiamento: FINANCIAMENTO.INDETERMINADO, pendencia: "PROMO_NAO_IDENTIFICADA", texto: "Preço abaixo do cheio, mas nenhuma promoção iniciada forma esse preço: origem do desconto não comprovada." };
  if (casam.length > 1) {
    const grupos = new Set(casam.map((p) => (TIPOS_DO_VENDEDOR.has(p.type) && !(num(p.meli_percentage) > 0) ? "V" : num(p.meli_percentage) !== null ? `M${p.meli_percentage}` : "?")));
    if (grupos.size !== 1) return { ...base, financiamento: FINANCIAMENTO.INDETERMINADO, pendencia: "PROMO_AMBIGUA", texto: `${casam.length} promoções iniciadas no mesmo preço com financiamento diferente: não dá para saber qual forma o preço.` };
  }
  const p = casam[0];
  // Todas as iniciadas, marcando QUAL forma o preço (a tela explica a campanha do vendedor "por baixo").
  const lista = (iniciadas || []).map((x) => ({ id: x.id || null, tipo: x.type || null, tipoRotulo: TIPO_ROTULO[x.type] || x.type || null, nome: x.name || null, preco: num(x.price), original: num(x.original_price), mlPct: num(x.meli_percentage), vendPct: num(x.seller_percentage), formaPreco: x === p }));
  const out = { ...base, tipo: p.type, tipoRotulo: TIPO_ROTULO[p.type] || p.type, nome: p.name || null, id: p.id || null, iniciadas: lista };
  if (p.camposBoost && p.camposBoost.length) return { ...out, financiamento: FINANCIAMENTO.INDETERMINADO, pendencia: "BOOSTED_OFFER_NAO_MEDIDO", texto: `A resposta traz ${p.camposBoost.join(", ")}: compensação do ML não mensurável com segurança.` };
  const mp = num(p.meli_percentage), sp = num(p.seller_percentage), orig = num(p.original_price);
  if (mp !== null) {
    if (orig === null || (ch !== null && Math.abs(orig - ch) >= TOL)) return { ...out, financiamento: FINANCIAMENTO.INDETERMINADO, pendencia: "PRECO_ORIGINAL_DIVERGE", texto: `Preço original da promoção (${orig === null ? "ausente" : brl(orig)}) difere do preço cheio (${ch === null ? "ausente" : brl(ch)}): subsídio não calculável com segurança.` };
    if (sp !== null && Math.abs(orig * (1 - (mp + sp) / 100) - v) > 0.05) return { ...out, financiamento: FINANCIAMENTO.INDETERMINADO, pendencia: "INCONSISTENCIA_PRECO_PROMO", texto: `Percentuais (ML ${pctBr(mp)} + vendedor ${pctBr(sp)}) não reproduzem o preço do comprador: subsídio não comprovado.` };
    const sub = r2(orig * mp / 100);
    return { ...out, financiamento: mp > 0 ? FINANCIAMENTO.COFINANCIADA : FINANCIAMENTO.VENDEDOR, subsidio: mp > 0 ? sub : 0, comprovado: true,
      texto: mp > 0 ? `${out.tipoRotulo}: ML cofinancia ${pctBr(mp)} (${brl(sub)}/un) e vendedor ${sp === null ? "?" : pctBr(sp)}.` : `${out.tipoRotulo} com participação do ML 0%.` };
  }
  if (TIPOS_DO_VENDEDOR.has(p.type)) return { ...out, financiamento: FINANCIAMENTO.VENDEDOR, subsidio: 0, comprovado: true, texto: `${out.tipoRotulo}: promoção do próprio vendedor, sem participação financeira do ML na resposta.` };
  return { ...out, financiamento: FINANCIAMENTO.INDETERMINADO, pendencia: "PARTICIPACAO_ML_NAO_INFORMADA", texto: `${out.tipoRotulo}: a API não informa a participação do ML (sem meli_percentage) e o tipo não é do vendedor: financiamento não determinado.` };
}

module.exports = { classificarFinanciamento, iniciadasDaResposta, TIPOS_DO_VENDEDOR, TIPO_ROTULO, FINANCIAMENTO };
