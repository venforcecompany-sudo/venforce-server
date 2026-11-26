// server/services/meliAnuncios/promocaoTiposSuportados.js
// -----------------------------------------------------------------------------
// FONTE ÚNICA dos tipos de promoção do Mercado Livre em que o VenForce escreve.
// Usada por /anuncios (meliPromocoesService / meliPromocoesEscritaService /
// meliPromocoesRebateService) e pela Central de Margem (promocaoClassificacao /
// precificacaoAvaliacao) — os dois lugares nunca divergem sobre "dá para
// participar pelo VenForce?".
//
// Pura: sem I/O, sem dependências — pode ser carregada por qualquer módulo.
//
// Como o VenForce escreve em cada TIPO (ver meliPromocoesEscritaService e a
// auditoria de documentacao_api_meli/*):
//   PRECO  — DEAL/SELLER_CAMPAIGN: o vendedor escolhe o preço (deal_price) ao
//            participar (POST) e ao alterar (PUT);
//   ACEITE — o Mercado Livre define o preço: o vendedor só participa (POST
//            sem preço, às vezes com offer_id) ou deixa de participar
//            (DELETE com offer_id) — campanha-com-co-participacao.md,
//            campanhas-smart-price-matching.md, desconto-pre-acordado-por-item.md;
//   null   — fora do escopo (PRICE_DISCOUNT, DOD, LIGHTNING, VOLUME, cupons…):
//            só simulação, a inscrição é feita no painel do ML.
// -----------------------------------------------------------------------------

const TIPOS_ESCRITA_PRECO = new Set(["DEAL", "SELLER_CAMPAIGN"]);

const TIPOS_ESCRITA_ACEITE = new Set([
  "MARKETPLACE_CAMPAIGN",
  "SMART",
  "PRICE_MATCHING",
  "PRICE_MATCHING_MELI_ALL",
  "PRE_NEGOTIATED",
  "UNHEALTHY_STOCK",
]);

// Relâmpago cofinanciada (SMART_LIGHTNING): o ML define o preço, mas o POST
// exige `stock` dentro da faixa da candidatura (sem ele responde 400) e o dia
// da oferta é marcado pelo ML depois do aceite. Fica FORA de TIPOS_ESCRITA_ACEITE
// de propósito: só o Radar de subsídios (que pede o estoque ao gestor) escreve
// nela; Central de Margem, Anúncios e transferência continuam só simulando.
const TIPOS_ESCRITA_COM_ESTOQUE = new Set(["SMART_LIGHTNING"]);

// Tipos ACEITE cujo POST de participação NÃO leva offer_id (a doc de
// MARKETPLACE_CAMPAIGN não pede). Os demais exigem o offer_id da candidatura.
const TIPOS_ACEITE_SEM_OFFER_NO_POST = new Set(["MARKETPLACE_CAMPAIGN"]);

// Por que cada tipo conhecido fica fora da escrita do VenForce (motivo claro
// para "Só pelo Mercado Livre"). Tipo desconhecido cai no motivo genérico.
const MOTIVO_TIPO_SEM_ESCRITA = Object.freeze({
  PRICE_DISCOUNT: "o desconto individual exige datas de início/fim e não pode ser alterado (só excluído e recriado)",
  DOD: "a oferta do dia só pode ser criada no painel e, depois de ativa, não pode ser alterada nem removida",
  LIGHTNING: "a oferta relâmpago exige estoque reservado e, depois de ativa, não pode ser alterada nem removida",
  VOLUME: "o desconto por quantidade é configurado por faixas de unidades no painel",
  SELLER_COUPON_CAMPAIGN: "cupons do vendedor são criados e geridos no painel",
});

function normalizarTipo(tipo) {
  return String(tipo || "").toUpperCase().trim();
}

/** "PRECO" | "ACEITE" | null */
function modoEscritaPromocao(tipo) {
  const t = normalizarTipo(tipo);
  if (TIPOS_ESCRITA_PRECO.has(t)) return "PRECO";
  if (TIPOS_ESCRITA_ACEITE.has(t)) return "ACEITE";
  return null;
}

/** O POST de participação deste tipo ACEITE precisa do offer_id da candidatura? */
function aceiteExigeOffer(tipo) {
  const t = normalizarTipo(tipo);
  return TIPOS_ESCRITA_ACEITE.has(t) && !TIPOS_ACEITE_SEM_OFFER_NO_POST.has(t);
}

/** O tipo reserva estoque ao participar (stock obrigatório no POST)? */
function exigeEstoque(tipo) {
  return TIPOS_ESCRITA_COM_ESTOQUE.has(normalizarTipo(tipo));
}

/** Tipos em que o Radar de subsídios pode participar: ACEITE + os que reservam estoque. */
const TIPOS_RADAR = new Set([...TIPOS_ESCRITA_ACEITE, ...TIPOS_ESCRITA_COM_ESTOQUE]);

/** Motivo legível de um tipo sem escrita pelo VenForce (null para tipos suportados). */
function motivoTipoSemEscrita(tipo) {
  if (modoEscritaPromocao(tipo)) return null;
  return MOTIVO_TIPO_SEM_ESCRITA[normalizarTipo(tipo)] || "este tipo de promoção não tem participação automática pelo VenForce";
}

module.exports = {
  TIPOS_ESCRITA_PRECO,
  TIPOS_ESCRITA_ACEITE,
  TIPOS_ESCRITA_COM_ESTOQUE,
  TIPOS_RADAR,
  exigeEstoque,
  TIPOS_ACEITE_SEM_OFFER_NO_POST,
  modoEscritaPromocao,
  aceiteExigeOffer,
  motivoTipoSemEscrita,
};
