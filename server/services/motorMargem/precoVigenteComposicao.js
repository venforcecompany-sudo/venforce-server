// server/services/motorMargem/precoVigenteComposicao.js
// COMPOSIÇÃO DO PREÇO VIGENTE de um anúncio na Central de Margem — quem forma
// o preço usado na margem, quem financia o desconto e quanto o ML compensa.
//
// Função PURA (sem banco, sem ML). Insumos:
//   - a linha do Margin Snapshot: `price` = sale_price.amount (preço que o
//     comprador paga, base financeira do núcleo), `listPrice` = regular_amount
//     (preço cheio), `quality.precoLeitura` = ids da promoção que o sale_price
//     apontou NO MESMO instante do preço (linhas novas);
//   - as promoções iniciadas/programadas do Promo Snapshot atual da conta.
//
// Regras (comprovadas com respostas brutas do ML nas contas 86/87, nov/2026):
//   1. A promoção que forma o preço é, nesta ordem: a que o sale_price da
//      linha aponta (ref_id = promotion_id ou id = campaign_id); a que o Promo
//      Snapshot confirmou como ATIVA; a única iniciada cujo preço final = preço
//      do cálculo. Nunca por eliminação.
//   2. A promoção identificada precisa ter o MESMO preço do cálculo. Se não
//      tem, as duas leituras são de momentos diferentes → DESATUALIZADO (o
//      retorno não é somado sobre um preço que não é o dele).
//   3. Financiamento:
//      - meli_percentage informado (> 0) → cofinanciada: subsídio por unidade
//        = preço original × meli% (mesma fórmula de meliPromocoesService),
//        exigindo preço original = preço cheio e percentuais que reproduzem o
//        preço do comprador;
//      - meli_percentage = 0, ou SELLER_CAMPAIGN/PRICE_DISCOUNT sem
//        meli_percentage → vendedor 100% (subsídio 0 comprovado, sem exigir
//        rebate positivo);
//      - qualquer outro tipo sem meli_percentage (DEAL, LIGHTNING…) → a API
//        não diz quem financia → REVISAR.
//   4. Sem leitura de promoções, promoção não identificada ou ambígua →
//      REVISAR. A margem sem retorno vira LIMITE INFERIOR (o retorno ML nunca
//      é negativo), nunca uma margem confiável.
//   5. `boosted_offer`: nenhum campo de "boost" apareceu em nenhuma resposta
//      real; nada é somado por ele.
//
// O retorno (`rebate`) só existe em CONFIRMADO + cofinanciada. É ESTE valor
// que margemAtualRebate soma ao lucro — o mesmo para tabela, drawer, KPIs,
// simulador e oportunidades. O núcleo NUNCA reduz a comissão projetada: o
// retorno é uma linha separada (a comissão realizada é que vem líquida — ver
// marginComparison), então não há dupla contagem.

const TOL = 0.011;
const MOMENTOS_DIFERENTES_MS = 12 * 60 * 60 * 1000;

const STATUS = Object.freeze({
  CONFIRMADO: "CONFIRMADO",
  REVISAR: "REVISAR",
  DESATUALIZADO: "DESATUALIZADO",
  SEM_PRECO: "SEM_PRECO",
});

const FINANCIADOR = Object.freeze({
  VENDEDOR: "VENDEDOR",
  COFINANCIADA: "COFINANCIADA",
  NAO_DETERMINADO: "NAO_DETERMINADO",
});

const MOTIVO = Object.freeze({
  SEM_PROMOCAO: "SEM_PROMOCAO",
  VENDEDOR_100: "VENDEDOR_100",
  COFINANCIADA: "COFINANCIADA",
  PRECO_AUSENTE: "PRECO_AUSENTE",
  PROMO_NAO_LIDA: "PROMO_NAO_LIDA",
  PROMO_INDISPONIVEL: "PROMO_INDISPONIVEL",
  PROMO_NAO_IDENTIFICADA: "PROMO_NAO_IDENTIFICADA",
  PROMO_AMBIGUA: "PROMO_AMBIGUA",
  PARTICIPACAO_ML_NAO_INFORMADA: "PARTICIPACAO_ML_NAO_INFORMADA",
  PRECO_ORIGINAL_DIVERGE: "PRECO_ORIGINAL_DIVERGE",
  PERCENTUAIS_INCONSISTENTES: "PERCENTUAIS_INCONSISTENTES",
  PRECO_MUDOU: "PRECO_MUDOU",
  PROMOCAO_DEPOIS_DO_CALCULO: "PROMOCAO_DEPOIS_DO_CALCULO",
  PRECO_SEM_SALE_PRICE: "PRECO_SEM_SALE_PRICE",
  BOOSTED_OFFER_NAO_MEDIDO: "BOOSTED_OFFER_NAO_MEDIDO",
});

// Descontos cujo dono é o vendedor (o ML não cofinancia campanha própria).
const TIPOS_DO_VENDEDOR = new Set(["SELLER_CAMPAIGN", "PRICE_DISCOUNT"]);

const ROTULO_TIPO = Object.freeze({
  SELLER_CAMPAIGN: "Campanha do vendedor",
  PRICE_DISCOUNT: "Desconto do vendedor",
  SMART: "Campanha cofinanciada (SMART)",
  DEAL: "Campanha tradicional (DEAL)",
  LIGHTNING: "Oferta relâmpago",
  SMART_LIGHTNING: "Relâmpago cofinanciada",
  PRICE_MATCHING: "Preço competitivo",
  PRICE_MATCHING_MELI_ALL: "Preço competitivo (ML)",
  MARKETPLACE_CAMPAIGN: "Campanha do Mercado Livre",
  DOD: "Oferta do dia",
  VOLUME: "Desconto por volume",
  UNHEALTHY_STOCK: "Estoque parado",
  PRE_NEGOTIATED: "Pré-negociada",
});

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function r2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }
function igual(a, b) { return a !== null && b !== null && Math.abs(a - b) < TOL; }
function iso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function brl(v) { return v === null || v === undefined ? "—" : `R$ ${Number(v).toFixed(2).replace(".", ",")}`; }

/** Linha de promoção em formato único (linhaPublica do repo ou linha crua). */
function normalizarLinhaPromo(p) {
  if (!p || typeof p !== "object") return null;
  // Aceita a linha do Promo Snapshot (camelCase/snake_case) e a resposta BRUTA
  // de GET /seller-promotions/items/{id} (type, price, id, ref_id) — o mesmo
  // classificador serve a Central e o Resgate.
  const tipo = p.tipo || p.promotionType || p.promotion_type || p.type || null;
  const ativa = p.ativa;
  const camposBoost = Array.isArray(p.camposBoost)
    ? p.camposBoost
    : Object.keys(p).filter((k) => /boost/i.test(k) && p[k] !== null && p[k] !== undefined && p[k] !== false);
  return {
    promotionId: p.promotionId ?? p.promotion_id ?? p.id ?? null,
    refId: p.refId ?? p.ref_id ?? null,
    tipo: tipo ? String(tipo).toUpperCase() : null,
    nome: p.nome || p.name || null,
    status: String(p.status || "").toLowerCase() || null,
    ativa: typeof ativa === "boolean" ? ativa : null,
    precoFinal: num(p.precoFinal ?? p.preco_final ?? p.price),
    precoOriginal: num(p.precoOriginal ?? p.preco_original ?? p.original_price),
    meliPercentage: num(p.meliPercentage ?? p.meli_percentage),
    sellerPercentage: num(p.sellerPercentage ?? p.seller_percentage),
    subsidioMl: num(p.subsidioMl ?? p.subsidio_ml),
    observedAt: iso(p.observedAt ?? p.observed_at),
    herdada: p.herdada === true || p.herdado === true,
    camposBoost,
  };
}

function iniciada(p) {
  return p.status === "started" || p.status === "active" || (p.status === "pending" && p.ativa === true);
}

/**
 * Quem financia a promoção que forma o preço, e quanto o ML compensa.
 * @returns {{financiador, subsidio:number|null, motivo, texto}}
 */
function financiamento(p, precoCheio, preco) {
  const rotulo = ROTULO_TIPO[p.tipo] || p.tipo || "Promoção";
  // boosted_offer/benefício extra do ML: nenhuma resposta real trouxe esses
  // campos; se aparecerem, a compensação não é mensurável — nunca somada.
  if (p.camposBoost && p.camposBoost.length) {
    return { financiador: FINANCIADOR.NAO_DETERMINADO, subsidio: null, motivo: MOTIVO.BOOSTED_OFFER_NAO_MEDIDO,
      texto: `${rotulo}: a resposta do Mercado Livre traz ${p.camposBoost.join(", ")} — compensação do ML não mensurável com segurança.` };
  }
  const mp = p.meliPercentage;
  if (mp !== null) {
    if (mp <= 0) {
      return { financiador: FINANCIADOR.VENDEDOR, subsidio: 0, motivo: MOTIVO.VENDEDOR_100,
        texto: `${rotulo}: participação do Mercado Livre informada como 0% — o vendedor banca o desconto.` };
    }
    const orig = p.precoOriginal;
    if (orig === null || (precoCheio !== null && !igual(orig, precoCheio))) {
      return { financiador: FINANCIADOR.NAO_DETERMINADO, subsidio: null, motivo: MOTIVO.PRECO_ORIGINAL_DIVERGE,
        texto: `${rotulo}: o preço original da promoção (${brl(orig)}) difere do preço cheio (${brl(precoCheio)}); o retorno do ML não é calculável com segurança.` };
    }
    const sp = p.sellerPercentage;
    // O ML devolve os percentuais com 1 casa decimal: cada um pode estar até
    // 0,05 p.p. longe do real, e o preço reconstruído, até 0,1% do original
    // (casos reais: 0,10–0,12 em 134,99–168,78). Fora disso, não reproduz.
    const tolerancia = Math.max(0.05, orig * 0.001) + 0.011;
    if (sp !== null && Math.abs(orig * (1 - (mp + sp) / 100) - preco) > tolerancia) {
      return { financiador: FINANCIADOR.NAO_DETERMINADO, subsidio: null, motivo: MOTIVO.PERCENTUAIS_INCONSISTENTES,
        texto: `${rotulo}: os percentuais (ML ${mp}% + vendedor ${sp}%) não reproduzem o preço do comprador ${brl(preco)}; retorno não comprovado.` };
    }
    const subsidio = r2(orig * mp / 100);
    return { financiador: FINANCIADOR.COFINANCIADA, subsidio, motivo: MOTIVO.COFINANCIADA,
      texto: `${rotulo}: o Mercado Livre cofinancia ${mp}% (${brl(subsidio)}/un, compensado na tarifa) e o vendedor ${sp === null ? "o restante" : `${sp}%`}.` };
  }
  if (TIPOS_DO_VENDEDOR.has(p.tipo)) {
    return { financiador: FINANCIADOR.VENDEDOR, subsidio: 0, motivo: MOTIVO.VENDEDOR_100,
      texto: `${rotulo}: promoção do próprio vendedor, sem participação do Mercado Livre.` };
  }
  return { financiador: FINANCIADOR.NAO_DETERMINADO, subsidio: null, motivo: MOTIVO.PARTICIPACAO_ML_NAO_INFORMADA,
    texto: `${rotulo}: o Mercado Livre não informa a participação dele (sem meli_percentage) e o tipo não é do vendedor — não dá para saber quem financia o desconto.` };
}

function grupoFinanciamento(p) {
  if (p.meliPercentage !== null) return p.meliPercentage > 0 ? `M${p.meliPercentage}` : "V";
  return TIPOS_DO_VENDEDOR.has(p.tipo) ? "V" : "?";
}

function promocaoPublica(p) {
  if (!p) return null;
  return {
    id: p.promotionId, refId: p.refId, tipo: p.tipo, tipoLabel: ROTULO_TIPO[p.tipo] || p.tipo || null,
    nome: p.nome, status: p.status, ativaConfirmada: p.ativa === true,
    precoFinal: p.precoFinal, precoOriginal: p.precoOriginal,
    meliPercentage: p.meliPercentage, sellerPercentage: p.sellerPercentage,
    observadoEm: p.observedAt, herdada: p.herdada,
  };
}

/**
 * @param {object} p
 * @param {object} p.linha    linha do Margin Snapshot (price, listPrice, calculatedAt, observedAt, quality)
 * @param {Array|null} p.promocoes  promoções do item no Promo Snapshot atual (null = sem leitura para o item)
 * @param {object} [p.contexto]
 *   - promoSnapshot: { runId, snapshotAt } | null (conta sem leitura) | undefined (desconhecido)
 *   - indisponivel: motivo de falha da leitura do Promo Snapshot
 * @returns {object} contrato `preco-vigente/1`
 */
function classificarPrecoVigente({ linha, promocoes = null, contexto = {} } = {}) {
  const l = linha || {};
  const preco = num(l.price);
  const cheioBruto = num(l.listPrice);
  const quality = l.quality || {};
  const leitura = quality.precoLeitura && typeof quality.precoLeitura === "object" ? quality.precoLeitura : null;
  const precoEm = iso(l.calculatedAt) || iso(l.observedAt);
  const notaPreco = (((quality.evidencias || {}).price || [])[0] || {}).note || null;
  const fontePreco = leitura ? leitura.fonte : (notaPreco && /legado_prices/.test(notaPreco) ? "legado_prices" : notaPreco ? "sale_price" : null);

  const temPromoPeloPreco = cheioBruto !== null && preco !== null && cheioBruto - preco > TOL;
  const precoCheio = cheioBruto !== null ? cheioBruto : preco;
  const linhas = (Array.isArray(promocoes) ? promocoes : []).map(normalizarLinhaPromo).filter(Boolean);
  const iniciadas = linhas.filter(iniciada);
  const promoEm = iniciadas.reduce((m, p) => (p.observedAt && (!m || p.observedAt > m) ? p.observedAt : m), null) ||
    iso(contexto.promoSnapshot && contexto.promoSnapshot.snapshotAt);

  const base = {
    versao: "preco-vigente/1",
    status: STATUS.CONFIRMADO,
    motivo: null,
    texto: null,
    precoCalculo: preco,
    precoCheio,
    precoComprador: preco,
    precoVendedor: null,
    temPromocao: temPromoPeloPreco,
    promocao: null,
    financiador: null,
    subsidioMl: { valor: null, status: "NAO_SE_APLICA" },
    rebate: null,
    leituras: {
      precoEm, precoFonte: fontePreco, promocaoEm: promoEm,
      promoSnapshotEm: iso(contexto.promoSnapshot && contexto.promoSnapshot.snapshotAt),
    },
    momentosDiferentes: false,
    baseFinanceira: "Preço do comprador (sale_price). O retorno do Mercado Livre, quando comprovado, entra como compensação separada; a comissão projetada é a cheia nesse preço.",
  };
  const comMomento = (out) => {
    const a = out.leituras.precoEm ? Date.parse(out.leituras.precoEm) : NaN;
    const b = out.leituras.promocaoEm ? Date.parse(out.leituras.promocaoEm) : NaN;
    out.momentosDiferentes = Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) > MOMENTOS_DIFERENTES_MS;
    return out;
  };

  if (preco === null || preco <= 0) {
    return { ...base, status: STATUS.SEM_PRECO, motivo: MOTIVO.PRECO_AUSENTE, precoCheio: cheioBruto, precoComprador: null,
      texto: "Preço vigente não lido do Mercado Livre: não há margem a calcular." };
  }

  // ── Identificação da promoção que forma o preço ──────────────────────────
  const porId = leitura && (leitura.promotionId || leitura.campaignId)
    ? iniciadas.filter((p) => (leitura.promotionId && p.refId === String(leitura.promotionId)) ||
        (leitura.campaignId && p.promotionId === String(leitura.campaignId)))
    : [];
  const ativas = iniciadas.filter((p) => p.ativa === true);
  const noPreco = iniciadas.filter((p) => igual(p.precoFinal, preco));
  // Linha sem preço cheio (legado/fallback): uma promoção iniciada no preço do
  // cálculo (ou apontada pelo sale_price) ainda é promoção formando o preço.
  const temPromo = temPromoPeloPreco || (cheioBruto === null &&
    (porId.length > 0 || noPreco.length > 0));
  base.temPromocao = temPromo;

  if (!temPromo) {
    // sale_price sem promoção no cálculo. Promoção ATIVA lida depois, a outro
    // preço, quer dizer que o preço mudou desde o cálculo.
    const depois = ativas.find((p) => p.precoFinal !== null && !igual(p.precoFinal, preco) && p.precoFinal < preco);
    if (depois && cheioBruto !== null) {
      return comMomento({ ...base, status: STATUS.DESATUALIZADO, motivo: MOTIVO.PROMOCAO_DEPOIS_DO_CALCULO,
        promocao: promocaoPublica(depois), precoVendedor: preco,
        texto: `A margem foi calculada a ${brl(preco)} sem promoção, mas a leitura de promoções mostra "${depois.nome || depois.tipo}" ativa a ${brl(depois.precoFinal)}. Recalcule antes de decidir.` });
    }
    if (fontePreco === "legado_prices" && noPreco.length) {
      return comMomento({ ...base, status: STATUS.REVISAR, motivo: MOTIVO.PRECO_SEM_SALE_PRICE, temPromocao: true,
        texto: "Preço lido pela rota antiga (sem sale_price): não dá para saber se há promoção formando este preço." });
    }
    return comMomento({ ...base, precoVendedor: preco, motivo: MOTIVO.SEM_PROMOCAO,
      texto: "Sem promoção: o preço vigente é o preço do anúncio." });
  }

  // Há promoção formando o preço. Sem leitura das promoções, não se sabe quem financia.
  if (contexto.indisponivel) {
    return comMomento({ ...base, status: STATUS.REVISAR, motivo: MOTIVO.PROMO_INDISPONIVEL, subsidioMl: { valor: null, status: "DESCONHECIDO" },
      texto: "Preço promocional, mas a leitura das promoções falhou agora: participação do Mercado Livre desconhecida." });
  }
  if (contexto.promoSnapshot === null) {
    return comMomento({ ...base, status: STATUS.REVISAR, motivo: MOTIVO.PROMO_NAO_LIDA, subsidioMl: { valor: null, status: "DESCONHECIDO" },
      texto: `Preço ${brl(preco)} abaixo do cheio ${brl(precoCheio)}, mas as promoções desta conta ainda não foram lidas: não dá para saber quem financia o desconto. Atualize as promoções.` });
  }

  let escolhida = null;
  if (porId.length === 1) escolhida = porId[0];
  else if (ativas.length === 1 && igual(ativas[0].precoFinal, preco)) escolhida = ativas[0];
  else if (noPreco.length === 1) escolhida = noPreco[0];
  else if (noPreco.length > 1) {
    const grupos = new Set(noPreco.map(grupoFinanciamento));
    if (grupos.size !== 1 || grupos.has("?")) {
      return comMomento({ ...base, status: STATUS.REVISAR, motivo: MOTIVO.PROMO_AMBIGUA, subsidioMl: { valor: null, status: "DESCONHECIDO" },
        texto: `${noPreco.length} promoções iniciadas no mesmo preço ${brl(preco)} com financiamento diferente: não dá para saber qual forma o preço.` });
    }
    escolhida = noPreco.find((p) => p.ativa === true) || noPreco[0];
  }

  if (!escolhida) {
    // Nada no preço do cálculo. Promoção ATIVA a outro preço = momentos diferentes.
    const ativaOutroPreco = (porId[0] || ativas[0]) || null;
    if (ativaOutroPreco && ativaOutroPreco.precoFinal !== null) {
      return comMomento({ ...base, status: STATUS.DESATUALIZADO, motivo: MOTIVO.PRECO_MUDOU, promocao: promocaoPublica(ativaOutroPreco),
        subsidioMl: { valor: null, status: "DESCONHECIDO" },
        texto: `A margem foi calculada a ${brl(preco)}, mas a promoção ativa "${ativaOutroPreco.nome || ativaOutroPreco.tipo}" está a ${brl(ativaOutroPreco.precoFinal)}: leituras de momentos diferentes. Recalcule.` });
    }
    return comMomento({ ...base, status: STATUS.REVISAR, motivo: MOTIVO.PROMO_NAO_IDENTIFICADA, subsidioMl: { valor: null, status: "DESCONHECIDO" },
      texto: `Preço ${brl(preco)} abaixo do cheio ${brl(precoCheio)}, mas nenhuma promoção iniciada lida forma esse preço: origem do desconto não comprovada.` });
  }

  if (!igual(escolhida.precoFinal, preco)) {
    return comMomento({ ...base, status: STATUS.DESATUALIZADO, motivo: MOTIVO.PRECO_MUDOU, promocao: promocaoPublica(escolhida),
      subsidioMl: { valor: null, status: "DESCONHECIDO" },
      texto: `A margem foi calculada a ${brl(preco)}, mas a promoção "${escolhida.nome || escolhida.tipo}" que formava esse preço está a ${brl(escolhida.precoFinal)} na leitura de promoções. Recalcule antes de decidir.` });
  }

  const fin = financiamento(escolhida, cheioBruto, preco);
  if (cheioBruto === null && escolhida.precoOriginal !== null) base.precoCheio = escolhida.precoOriginal;
  const promocao = promocaoPublica(escolhida);
  if (fin.financiador === FINANCIADOR.NAO_DETERMINADO) {
    return comMomento({ ...base, status: STATUS.REVISAR, motivo: fin.motivo, promocao, financiador: fin.financiador,
      subsidioMl: { valor: null, status: "DESCONHECIDO" }, texto: fin.texto });
  }
  const cofin = fin.financiador === FINANCIADOR.COFINANCIADA;
  return comMomento({
    ...base,
    motivo: fin.motivo,
    texto: fin.texto,
    promocao,
    financiador: fin.financiador,
    precoVendedor: cofin ? r2(preco + fin.subsidio) : preco,
    subsidioMl: { valor: fin.subsidio, status: cofin ? "COMPROVADO" : "ZERO" },
    rebate: cofin && fin.subsidio > 0 ? fin.subsidio : null,
  });
}

/**
 * Adaptador para quem lê o ML direto (VenForce Resgate): mesma decisão de
 * classificarPrecoVigente, a partir da RESPOSTA BRUTA.
 *
 * @param {object} a
 * @param {Array}  a.lista           resposta de GET /seller-promotions/items/{id}?app_version=v2
 * @param {number} [a.promoStatus]   HTTP dessa leitura (≠ 200 → leitura indisponível)
 * @param {object} [a.salePrice]     resposta de GET /items/{id}/sale_price (amount, regular_amount, metadata)
 * @param {number} a.precoComprador  preço usado na margem (sale_price.amount do cálculo)
 * @param {number} [a.precoCheio]    preço cheio do vendedor (regular_amount)
 * @param {string} [a.precoLidoEm]   ISO da leitura do preço
 * @param {string} [a.promoLidaEm]   ISO da leitura das promoções
 */
function classificarDaLeituraMl({ lista, promoStatus = 200, salePrice = null, precoComprador, precoCheio = null, precoLidoEm = null, promoLidaEm = null } = {}) {
  const meta = salePrice && salePrice.metadata ? salePrice.metadata : null;
  const linha = {
    price: precoComprador,
    listPrice: precoCheio,
    calculatedAt: precoLidoEm,
    quality: {
      precoLeitura: meta ? { fonte: "sale_price", promotionId: meta.promotion_id ?? null, campaignId: meta.campaign_id ?? null, promotionType: meta.promotion_type ?? null } : null,
    },
  };
  if (promoStatus !== 200) {
    return classificarPrecoVigente({ linha, promocoes: null, contexto: { indisponivel: `HTTP_${promoStatus}` } });
  }
  // O sale_price lido junto, se o valor mudou, aponta a promoção de OUTRO preço:
  // a identificação por id só vale para o mesmo preço (o classificador confere).
  const promocoes = (Array.isArray(lista) ? lista : []).filter((p) => p && typeof p === "object");
  return classificarPrecoVigente({ linha, promocoes, contexto: { promoSnapshot: { runId: null, snapshotAt: promoLidaEm } } });
}

module.exports = {
  classificarDaLeituraMl,
  classificarPrecoVigente,
  normalizarLinhaPromo,
  STATUS,
  FINANCIADOR,
  MOTIVO,
  TIPOS_DO_VENDEDOR,
  ROTULO_TIPO,
};
