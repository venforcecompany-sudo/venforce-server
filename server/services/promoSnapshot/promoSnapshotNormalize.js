// server/services/promoSnapshot/promoSnapshotNormalize.js
// Promo Snapshot — normalização da resposta de
// GET /seller-promotions/items/{MLB}?app_version=v2 em linhas persistíveis.
//
// ZERO fórmula nova: reaproveita a normalização do drawer
// (meliPromocoesService — candidate com sugestão/percentuais, subsídio ML,
// status exibido, fallback de preço ativo, dedupe da mesma campanha). O que
// este módulo acrescenta é só o mapeamento para colunas e as flags
// elegivel/ativa/programada/nao_aplicada, SEM chute:
//   - ativa/nao_aplicada ficam null quando não deu para confirmar qual
//     promoção forma o preço agora (sale_price indisponível);
//   - promoção sem preço utilizável fica com preco_final null (nunca inventado);
//   - promoção sem meli_percentage fica sem subsídio (null, nunca zero);
//   - tipo desconhecido é PRESERVADO (tipo_conhecido=false), nunca descartado.

const {
  normalizarPromocao,
  ordenarPorPrioridade,
  aplicarFallbackPrecoAtivo,
  deduplicarPromocoes,
  ROTULO_TIPO,
} = require("../meliAnuncios/meliPromocoesService");

const TIPOS_CONHECIDOS = new Set(Object.keys(ROTULO_TIPO));

function dataIsoOuNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fin(n) {
  const v = Number(n);
  return n !== null && n !== undefined && n !== "" && Number.isFinite(v) ? v : null;
}

// De onde veio o preço final — para a UI nunca apresentar cálculo local como
// preço do ML.
function fontePrecoFinal(bruta, precoFinal) {
  if (precoFinal === null || precoFinal === undefined) return null;
  const status = String((bruta && bruta.status) || "").toLowerCase().trim();
  if (status === "candidate") {
    if (fin(bruta && bruta.suggested_discounted_price) > 0) return "sugerido_ml";
    return fin(bruta && bruta.price) > 0 ? "ml" : "calculado_percentuais";
  }
  return "ml";
}

// null = resposta fora do formato documentado (não é "sem promoção").
function extrairLista(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  return null;
}

/**
 * @param {object} p
 * @param {string} p.itemId
 * @param {Array}  p.lista        resposta crua do ML (array de promoções)
 * @param {object|null} p.saleInfo {promotionId, amount} de /items/{id}/sale_price;
 *                                  null = não consultado/indisponível
 * @param {Map}    [p.vigencias]  chave "id::tipo" → {inicio, fim}
 * @param {string} p.observedAt   ISO do instante da leitura
 * @returns {Array} linhas no formato de promoSnapshotRepository
 */
function normalizarPromocoesDoItem({ itemId, lista, saleInfo = null, vigencias = null, observedAt }) {
  const brutas = (Array.isArray(lista) ? lista : []).filter((p) => p && typeof p === "object");
  if (!brutas.length) return [];

  const ordenadas = ordenarPorPrioridade(brutas);
  const confirmavel = Boolean(saleInfo && (saleInfo.promotionId || fin(saleInfo.amount) !== null));
  const normalizadas = ordenadas.map((b, i) => normalizarPromocao(b, i, saleInfo ? saleInfo.promotionId : null));
  if (saleInfo) aplicarFallbackPrecoAtivo(normalizadas, saleInfo.amount);

  // Guarda a bruta de cada normalizada para fonte do preço / ids crus.
  const brutaDe = new Map();
  normalizadas.forEach((n, i) => {
    brutaDe.set(n, ordenadas[i]);
    if (vigencias && n.inicio == null && n.fim == null) {
      const b = ordenadas[i];
      const chave = `${(b && (b.id || b.ref_id)) || ""}::${(b && b.type) || ""}`;
      const v = vigencias.get(chave);
      if (v) {
        if (v.inicio != null) n.inicio = v.inicio;
        if (v.fim != null) n.fim = v.fim;
      }
    }
  });

  return deduplicarPromocoes(normalizadas).map((n) => {
    const b = brutaDe.get(n) || {};
    const iniciada = n.status === "started" || n.status === "active";
    let ativa;
    let naoAplicada;
    let statusExibicao = n.statusExibicao;
    if (iniciada) {
      if (confirmavel) {
        ativa = n.statusExibicao === "ATIVA";
        naoAplicada = !ativa;
      } else {
        // Sem sale_price não dá para dizer se ESTA promoção forma o preço:
        // nunca afirmar "não aplicada" (o normalizador do drawer diria).
        ativa = null;
        naoAplicada = null;
        statusExibicao = "INICIADA";
      }
    } else {
      ativa = false;
      naoAplicada = false;
    }
    const tipo = n.tipo ? String(n.tipo).toUpperCase().trim() : null;
    return {
      itemId: String(itemId),
      promocaoChave: `${n.id}::${n.tipo || ""}`,
      promotionId: b.id != null ? String(b.id) : null,
      refId: b.ref_id != null ? String(b.ref_id) : null,
      promotionType: n.tipo || null,
      tipoConhecido: tipo ? TIPOS_CONHECIDOS.has(tipo) : false,
      nome: n.nome || null,
      status: n.status || null,
      statusExibicao,
      dataInicio: dataIsoOuNull(n.inicio),
      dataFim: dataIsoOuNull(n.fim),
      precoOriginal: n.precoOriginal,
      precoFinal: n.precoFinal,
      precoFinalFonte: fontePrecoFinal(b, n.precoFinal),
      descontoValor: n.descontoReais,
      descontoPercentual: n.descontoPercentual,
      sellerPercentage: n.sellerPercentage,
      meliPercentage: n.meliPercentage,
      subsidioMl: n.subsidioMl,
      elegivel: n.status === "candidate",
      ativa,
      programada: n.status === "pending",
      naoAplicada,
      observedAt,
    };
  });
}

// Promoções da lista que precisam de vigência (sem datas, com id + tipo).
function chavesSemVigencia(lista) {
  const out = new Map();
  for (const b of Array.isArray(lista) ? lista : []) {
    if (!b || typeof b !== "object" || b.start_date || b.finish_date) continue;
    const id = b.id || b.ref_id;
    if (!id || !b.type) continue;
    out.set(`${id}::${b.type}`, { promotionId: String(id), tipo: String(b.type) });
  }
  return out;
}

function temPromocaoIniciada(lista) {
  return (Array.isArray(lista) ? lista : []).some((b) => {
    const s = String((b && b.status) || "").toLowerCase().trim();
    return s === "started" || s === "active";
  });
}

module.exports = {
  TIPOS_CONHECIDOS,
  normalizarPromocoesDoItem,
  chavesSemVigencia,
  temPromocaoIniciada,
  extrairLista,
  fontePrecoFinal,
};
