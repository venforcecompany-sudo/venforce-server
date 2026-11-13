// server/services/meliAnuncios/meliPromocoesService.js
// -----------------------------------------------------------------------------
// Módulo: Anúncios Meli — promoções oficiais do item, para o bloco
// "Promoções disponíveis" do modal de detalhe.
//
// Fonte principal: GET /seller-promotions/items/{ITEM_ID}?app_version=v2 (ver
// documentacao_api_meli/gerenciar-ofertas.md). Read-only — nunca inscreve o
// item em promoção nenhuma, nunca grava preço no Mercado Livre. O preço final
// de cada linha alimenta, no FRONTEND, a mesma simulação de margem que já
// existe (POST /:itemId/simular-margem, marginEngine.computeMargin) — este
// módulo só busca e normaliza o dado bruto do ML.
//
// Fórmula de margem "de planilha" de
// server/services/automacoes/promocoesRetornoService.js (tela "Promoções com
// Retorno ML") NÃO é reaproveitada aqui — é outra tela, com outra fórmula. O
// que É reaproveitado de lá é `escolherPromocao`, só para ORDENAR (nunca para
// calcular margem).
// -----------------------------------------------------------------------------

const { mlFetch } = require("../../utils/mlClient");
const { escolherPromocao } = require("../automacoes/promocoesRetornoService");

const ROTULO_TIPO = {
  DEAL: "Campanha tradicional",
  MARKETPLACE_CAMPAIGN: "Campanha cofinanciada",
  PRICE_DISCOUNT: "Desconto individual",
  VOLUME: "Desconto por quantidade",
  PRE_NEGOTIATED: "Desconto pré-acordado",
  DOD: "Oferta do dia",
  LIGHTNING: "Oferta relâmpago",
  SELLER_CAMPAIGN: "Campanha própria",
  SMART: "Campanha cofinanciada automatizada",
  PRICE_MATCHING: "Preços competitivos",
  UNHEALTHY_STOCK: "Liquidação de estoque Full",
  SELLER_COUPON_CAMPAIGN: "Cupom do vendedor",
};

// Como o VenForce pode escrever em cada TIPO de promoção (PRECO · ACEITE · null):
// fonte única em promocaoTiposSuportados.js — a Central de Margem usa a mesma.
const {
  TIPOS_ESCRITA_PRECO,
  TIPOS_ESCRITA_ACEITE,
  modoEscritaPromocao,
} = require("./promocaoTiposSuportados");

function rotuloTipoPromocao(tipo) {
  const t = String(tipo || "").toUpperCase().trim();
  return ROTULO_TIPO[t] || tipo || "Promoção";
}

// candidate/started/pending são os únicos status documentados nas várias
// campanhas (ver gerenciar-ofertas.md/campanhas-tradicionais.md) — "active" é
// aceito também porque aparece como sinônimo de "started" em outro ponto da
// mesma doc (central de promoções).
const STATUS_LABEL = {
  started: "ATIVA",
  active: "ATIVA",
  pending: "AGENDADA",
  candidate: "ELEGÍVEL",
};

function statusLabelPromocao(status) {
  const s = String(status || "").toLowerCase().trim();
  return STATUS_LABEL[s] || (s ? s.toUpperCase() : "—");
}

function fin(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function round2(n) {
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : null;
}

// Normaliza UMA promoção crua do ML. Nunca inventa desconto: quando o ML não
// fornece preço utilizável — started/pending sem `price` > 0, ou candidate
// sem `suggested_discounted_price` — `precoFinal` fica null e a UI mostra
// "sem sugestão do Mercado Livre", nunca um cálculo próprio.
//
// `promotionIdAtivo` (opcional): id/ref_id da promoção que o próprio ML está
// usando AGORA para formar o preço de venda (GET /items/{id}/sale_price →
// metadata.promotion_id, ver obterPromotionIdAtivo). Usado só para decidir
// `statusExibicao` — nunca para recalcular preço/desconto/margem.
function normalizarPromocao(promo, index, promotionIdAtivo = null) {
  const status = String((promo && promo.status) || "").toLowerCase().trim();
  const precoOriginal = fin(promo && promo.original_price);

  let precoFinal = null;
  if (status === "started" || status === "active" || status === "pending") {
    const p = fin(promo && promo.price);
    precoFinal = p != null && p > 0 ? p : null;
  } else if (status === "candidate") {
    const sugerido = fin(promo && promo.suggested_discounted_price);
    if (sugerido != null) {
      precoFinal = sugerido;
    } else {
      // Campanhas cofinanciadas automáticas (SMART, PRICE_MATCHING) nunca
      // enviam suggested_discounted_price em candidate — só original_price +
      // meli_percentage/seller_percentage. Caso real: "Impulsione suas
      // vendas" (SMART, item MLB4147165927/MLB4162633919) aparecia com
      // subsidioMl preenchido mas precoFinal/voceRecebe vazios.
      //
      // O desconto REAL pago pelo comprador é meli_percentage + seller_
      // percentage somados — nunca só a fatia do ML (confirmado em 3
      // exemplos oficiais independentes: campanha-com-co-participacao.md,
      // 1000→700 com meli=5+seller=25=30%; campanhas-smart-price-
      // matching.md PRICE_MATCHING_MELI_ALL, 135→121,5 com meli=10+
      // seller=0=10%; e o exemplo com boost, 76287→73001≈4,3%). Usar só
      // meli_percentage (== subsidioMl) subestima o desconto sempre que
      // seller_percentage > 0. seller_percentage ausente conta como 0 (é
      // aditivo, opcional); meli_percentage continua obrigatório — sem ele,
      // precoFinal fica null, nunca inventa desconto.
      //
      // subsidioMl (abaixo) continua só meli_percentage — é "quanto o
      // vendedor recebe de volta", nunca o desconto total do comprador; as
      // duas fórmulas são propositalmente diferentes e o subsídio nunca é
      // subtraído uma segunda vez em cima do desconto já calculado aqui.
      // suggested_discounted_price do ML, quando vier, sempre tem
      // prioridade sobre este cálculo. Continua uma simulação local
      // (editavelPrecoFinal), nunca escreve no ML nem no motor de margem.
      const meliPercentageCandidata = fin(promo && promo.meli_percentage);
      const sellerPercentageCandidata = fin(promo && promo.seller_percentage) ?? 0;
      precoFinal =
        precoOriginal != null && meliPercentageCandidata != null
          ? round2(precoOriginal * (1 - (meliPercentageCandidata + sellerPercentageCandidata) / 100))
          : null;
    }
  }

  const descontoReais =
    precoOriginal != null && precoFinal != null ? round2(precoOriginal - precoFinal) : null;
  const descontoPercentual =
    descontoReais != null && precoOriginal ? round2((descontoReais / precoOriginal) * 100) : null;

  // Subsídio ML em R$ — NÃO vem de discount_meli_boost_amount/boosted_offer/
  // benefits (auditoria ao vivo: 101 promoções reais de 15 clientes em
  // produção, ZERO com boosted_offer:true — inclusive as 2 SMART reais do
  // item que mostrava "Reduzimos R$0,61" no Mercado Livre). Fonte real:
  // fórmula já validada em produção pela tela "Promoções com Retorno ML"
  // (server/services/automacoes/promocoesRetornoService.js, campo
  // "Retorno ML") — original_price * (meli_percentage/100). Caso real
  // confirmado: item MLB4147165927, promoção "Impulsione suas vendas"
  // (SMART), original_price=119.90, meli_percentage=0.5 → R$0,60, a 1
  // centavo do R$0,61 mostrado pelo ML (diferença compatível com a
  // precisão de 1 casa decimal do meli_percentage retornado pela API).
  // Nome do campo interno (subsidioMl) mantido para não exigir refactor
  // grande no frontend — semanticamente é "Retorno ML" (a fatia do
  // desconto promocional que o Mercado Livre banca), não uma redução de
  // tarifa/comissão. Exige os DOIS campos (original_price E
  // meli_percentage); nunca usa seller_percentage como fonte nem soma os
  // dois percentuais — um cálculo parcial vira null, nunca um valor
  // inventado.
  const meliPercentage = fin(promo && promo.meli_percentage);
  const sellerPercentage = fin(promo && promo.seller_percentage);
  const subsidioMl =
    precoOriginal !== null && meliPercentage !== null
      ? round2(precoOriginal * (meliPercentage / 100))
      : null;

  const idPromo = promo && promo.id;
  const refIdPromo = promo && (promo.ref_id || promo.offer_id);

  // statusExibicao — só a promoção que o próprio ML aponta como responsável
  // pelo preço de venda atual (promotionIdAtivo, casado contra id/ref_id)
  // pode virar ATIVA. Sem esse dado, ou sem bater com nenhuma started/
  // active, NENHUMA fica ATIVA — nunca por eliminação/heurística de preço.
  // `status` (bruto, vindo do ML) nunca muda: isto é só um campo de exibição.
  //
  // `pending` apontada pelo sale_price também é ATIVA: a Oferta relâmpago
  // (SMART_LIGHTNING) continua `pending` na listagem durante a própria janela
  // em que forma o preço. Caso real (Red Fish, MLB7337265348, 15/10/2026):
  // sale_price amount 112,81 com promotion_id = ref_id da relâmpago `pending`
  // — sem isto ela aparecia PROGRAMADA e o rebate dela (R$ 7,45) sumia do
  // "Hoje". Para `pending` só vale o casamento pelo ref_id (OFFER-<item>-<n>,
  // exclusivo da oferta): o id da CAMPANHA se repete numa janela futura
  // `pending` da mesma campanha que está `started` — casar por ele marcaria
  // as duas como ATIVA. O fallback por preço (aplicarFallbackPrecoAtivo)
  // continua restrito a started/active.
  const casaRef = promotionIdAtivo != null && refIdPromo != null && String(refIdPromo) === String(promotionIdAtivo);
  const aplicada =
    casaRef || (promotionIdAtivo != null && idPromo != null && String(idPromo) === String(promotionIdAtivo));
  let statusExibicao;
  if (status === "started" || status === "active") {
    statusExibicao = aplicada ? "ATIVA" : "NÃO APLICADA";
  } else if (status === "pending") {
    statusExibicao = casaRef ? "ATIVA" : "PROGRAMADA";
  } else if (status === "candidate") {
    statusExibicao = "ELEGÍVEL";
  } else {
    statusExibicao = statusLabelPromocao(status);
  }

  return {
    id:
      (idPromo || refIdPromo) ||
      String((promo && promo.type) || "promo") + "-" + (status || "s") + "-" + index,
    tipo: (promo && promo.type) || null,
    // offer_id da oferta/candidatura (ref_id na listagem v2 — OFFER-…/
    // CANDIDATE-…). Exigido pelo ML para participar de parte dos tipos
    // ACEITE e para deixar de participar (DELETE); null quando não vem.
    refId: refIdPromo || (promo && promo.offer_id) || null,
    modoEscrita: modoEscritaPromocao(promo && promo.type),
    tipoLabel: rotuloTipoPromocao(promo && promo.type),
    nome: (promo && promo.name) || null,
    status: status || null,
    statusLabel: statusLabelPromocao(status),
    statusExibicao,
    inicio: (promo && promo.start_date) || null,
    fim: (promo && promo.finish_date) || null,
    precoOriginal,
    precoFinal,
    descontoReais,
    descontoPercentual,
    meliPercentage,
    sellerPercentage,
    subsidioMl,
    // A célula "Preço final" é sempre uma SIMULAÇÃO local (nunca escreve no
    // ML) — não depende de o ML ter enviado preço/sugestão pronta, por isso é
    // sempre editável, mesmo quando precoFinal nasce null.
    editavelPrecoFinal: true,
  };
}

// Reaproveita escolherPromocao (mesma função usada pela tela "Promoções com
// Retorno ML") para ORDENAR em vez de escolher uma só: escolhe repetidamente
// a mais prioritária (ativa/agendada primeiro, depois maior meli_percentage)
// e a remove da fila. Resultado é a lista inteira, ordenada — sem
// reimplementar a régua de prioridade em outro lugar do código.
function ordenarPorPrioridade(lista) {
  const restante = lista.slice();
  const ordenada = [];
  while (restante.length) {
    const escolhida = escolherPromocao(restante, {});
    if (!escolhida) break;
    const idx = restante.indexOf(escolhida);
    if (idx === -1) break;
    restante.splice(idx, 1);
    ordenada.push(escolhida);
  }
  return ordenada;
}

// Fonte de verdade da promoção REALMENTE aplicada agora — GET /items/{id}/
// sale_price?context=channel_marketplace → metadata.promotion_id (doc
// api-de-precos.md). É o mesmo endpoint que precoItemService.resolverPrecosItem
// usa para o Motor de Margem, mas esta é uma chamada INDEPENDENTE: só lê
// metadata.promotion_id, nunca amount/regular_amount — zero import, zero
// alteração em precoItemService.js/motor de margem. Falha ou campo ausente
// vira null (nunca derruba a lista nem inventa uma promoção ATIVA).
async function obterPromotionIdAtivo({ clienteId, itemId, mlUserId }) {
  try {
    const resp = await mlFetch(
      clienteId,
      `/items/${encodeURIComponent(itemId)}/sale_price?context=channel_marketplace`,
      { mlUserId }
    );
    if (!resp || !resp.ok) return { promotionId: null, amount: null };
    const promotionId = resp.data && resp.data.metadata && resp.data.metadata.promotion_id;
    const amount = fin(resp.data && resp.data.amount);
    return {
      promotionId: promotionId != null ? String(promotionId) : null,
      amount,
      regularAmount: fin(resp.data && resp.data.regular_amount),
      campaignId: resp.data && resp.data.metadata && resp.data.metadata.campaign_id,
    };
  } catch (_) {
    return { promotionId: null, amount: null };
  }
}

// A listagem pode devolver apenas uma nova candidatura da campanha cuja
// oferta anterior segue formando o preço. Confirma a oferta pelo seu ID;
// nunca promove uma candidata a ativa apenas por igualdade de preço.
async function reconciliarOfertaAtiva({ clienteId, itemId, mlUserId, lista, saleInfo }) {
  const offerId = saleInfo && saleInfo.promotionId;
  if (!offerId || !String(offerId).startsWith("OFFER-") || !(saleInfo.amount > 0)) return lista;
  const reconhecida = lista.some((p) =>
    String(p.ref_id || p.offer_id || "") === String(offerId) &&
    ["started", "active", "pending"].includes(String(p.status || "").toLowerCase())
  );
  if (reconhecida) return lista;

  try {
    const resp = await mlFetch(clienteId, `/seller-promotions/offers/${encodeURIComponent(offerId)}?app_version=v2`, { mlUserId });
    const oferta = resp && resp.ok && resp.data;
    const status = String(oferta && (oferta.status && oferta.status.id || oferta.status) || "").toLowerCase();
    if (!oferta || String(oferta.id) !== String(offerId) || String(oferta.item_id) !== String(itemId) ||
        !oferta.promotion_id || !oferta.type || !["started", "active"].includes(status) ||
        (saleInfo.campaignId && String(saleInfo.campaignId) !== String(oferta.promotion_id))) return lista;

    const index = lista.findIndex((p) => String(p.id) === String(oferta.promotion_id) && p.type === oferta.type);
    const anterior = index >= 0 ? lista[index] : {};
    // Nome e vigência identificam a campanha; percentuais da nova candidatura
    // não comprovam o subsídio da oferta anterior. Ausência continua null.
    const recuperada = {
      id: oferta.promotion_id, type: oferta.type, ref_id: oferta.id, status,
      name: anterior.name || oferta.name || null,
      start_date: anterior.start_date || null, finish_date: anterior.finish_date || null,
      price: saleInfo.amount,
      original_price: saleInfo.regularAmount > 0 ? saleInfo.regularAmount : anterior.original_price,
      meli_percentage: oferta.meli_percentage ?? undefined,
      seller_percentage: oferta.seller_percentage ?? undefined,
    };
    return index < 0 ? [...lista, recuperada] : lista.map((p, i) => i === index ? recuperada : p);
  } catch (_) {
    return lista;
  }
}

// Enriquecimento de vigência — /seller-promotions/items/{itemId} (fonte
// principal) só manda start_date/finish_date de forma confiável para DEAL;
// para SMART, PRICE_MATCHING, PRE_NEGOTIATED, LIGHTNING, UNHEALTHY_STOCK (e
// parte dos PRICE_DISCOUNT) o próprio Mercado Livre só expõe a vigência via
// GET /seller-promotions/promotions/{promotion_id}?promotion_type={tipo}
// (ver auditoria: campanhas-smart-price-matching.md, desconto-pre-acordado-
// por-item.md, ofertas-relampago.md). Chamada OPCIONAL, uma por promoção sem
// data — nunca bloqueia a listagem: falha (ok:false ou exceção) mantém
// inicio/fim como vieram (null), nunca inventa.
async function obterVigenciaCampanha({ clienteId, promotionId, tipo, mlUserId }) {
  try {
    const resp = await mlFetch(
      clienteId,
      `/seller-promotions/promotions/${encodeURIComponent(promotionId)}?promotion_type=${encodeURIComponent(tipo)}&app_version=v2`,
      { mlUserId }
    );
    if (!resp || !resp.ok) return null;
    const inicio = (resp.data && resp.data.start_date) || null;
    const fim = (resp.data && resp.data.finish_date) || null;
    const nome = (resp.data && resp.data.name) || null;
    return inicio || fim || nome ? { inicio, fim, nome } : null;
  } catch (_) {
    return null;
  }
}

// Só dispara para promoções que chegaram SEM start_date e SEM finish_date da
// fonte principal E que têm promotion_id + type suficientes para montar a
// consulta de detalhe.
//
// promotion_id: prioriza `bruta.id` (id da CAMPANHA, formato "P-.../LGH-...",
// é o que todos os exemplos oficiais do ML usam em
// /seller-promotions/promotions/{promotion_id} — ver gerenciar-ofertas.md,
// campanhas-smart-price-matching.md, desconto-pre-acordado-por-item.md,
// ofertas-relampago.md). `bruta.ref_id` é documentado como "id da oferta ou
// candidato" (formato "OFFER-..."), um recurso DIFERENTE — em todo exemplo
// oficial onde ref_id aparece, id também aparece junto, nunca sozinho.
// Mesmo assim, cai para ref_id como fallback defensivo quando id vier
// ausente: se ref_id não servir como promotion_id nesse endpoint, o ML só
// devolve erro/ok:false — já tratado, nunca quebra a listagem.
//
// Deduplicação: duas promoções diferentes na mesma lista podem apontar para
// o mesmo id+type (ex.: uma entrada started e outra pending da mesma
// campanha) — `cache` (Map local, recriado a cada chamada de
// listarPromocoesDoItem, NUNCA persistente entre requisições) garante uma
// única chamada de rede por id+type, guardando a PROMISE (não o valor já
// resolvido) para que chamadas concorrentes dentro do mesmo Promise.all
// compartilhem a mesma requisição em voo.
//
// Roda em paralelo (Promise.all) — mutação in-place dos objetos
// normalizados, que acabaram de ser criados aqui dentro (sem referência
// externa ainda).
async function enriquecerVigencia({ clienteId, mlUserId, paresBrutoNormalizado }) {
  const cache = new Map();
  await Promise.all(
    paresBrutoNormalizado.map(async ([bruta, p]) => {
      if (p.inicio != null || p.fim != null) return;
      const promotionId = (bruta && bruta.id) || (bruta && bruta.ref_id);
      const tipo = bruta && bruta.type;
      if (!promotionId || !tipo) return;
      const chave = `${promotionId}::${tipo}`;
      if (!cache.has(chave)) {
        cache.set(chave, obterVigenciaCampanha({ clienteId, promotionId, tipo, mlUserId }));
      }
      const detalhe = await cache.get(chave);
      if (!detalhe) return;
      if (detalhe.inicio != null) p.inicio = detalhe.inicio;
      if (detalhe.fim != null) p.fim = detalhe.fim;
      if (!p.nome && detalhe.nome) p.nome = detalhe.nome;
    })
  );
}

// Duas entradas cruas do ML podem repetir a mesma campanha com o mesmo
// id+type (ex.: uma started e outra pending da mesma campanha — já
// documentado em enriquecerVigencia) mas com campos diferentes preenchidos
// (ex.: uma sem meli_percentage → subsidioMl null, outra completa). Sem
// deduplicar, a tabela do frontend desenha uma linha por entrada, mas
// promocaoPorId (Portal/anuncios-meli.js) resolve o clique pela PRIMEIRA
// ocorrência do id no array — podendo abrir a confirmação usando os dados
// de uma linha diferente da que o operador está olhando (caso real:
// "Vendex - Setembro" mostrava Subsídio ML "—", mas o clique em "Alterar"
// resolvia pra a outra entrada duplicada, com subsidioMl preenchido, e
// disparava o aviso de rebate indevidamente).
//
// Nunca junta/soma campos das duas entradas — só ESCOLHE uma, pela mesma
// régua de "mais completa" nesta ordem: 1) statusExibicao ATIVA (é a que
// realmente forma o preço agora), 2) subsidioMl preenchido, 3) datas
// preenchidas, 4) maior quantidade de campos preenchidos.
function contarCamposPreenchidos(p) {
  return Object.keys(p).filter((k) => p[k] !== null && p[k] !== undefined).length;
}

function promocaoMaisCompleta(a, b) {
  const aAtiva = a.statusExibicao === "ATIVA";
  const bAtiva = b.statusExibicao === "ATIVA";
  if (aAtiva !== bAtiva) return aAtiva ? a : b;

  const aSubsidio = a.subsidioMl != null;
  const bSubsidio = b.subsidioMl != null;
  if (aSubsidio !== bSubsidio) return aSubsidio ? a : b;

  const aData = a.inicio != null || a.fim != null;
  const bData = b.inicio != null || b.fim != null;
  if (aData !== bData) return aData ? a : b;

  return contarCamposPreenchidos(a) >= contarCamposPreenchidos(b) ? a : b;
}

function deduplicarPromocoes(lista) {
  const porChave = new Map();
  const ordemChaves = [];
  lista.forEach((p) => {
    const chave = `${p.id}::${p.tipo}`;
    if (!porChave.has(chave)) {
      porChave.set(chave, p);
      ordemChaves.push(chave);
    } else {
      porChave.set(chave, promocaoMaisCompleta(porChave.get(chave), p));
    }
  });
  return ordemChaves.map((chave) => porChave.get(chave));
}

// Fallback secundário de statusExibicao — cobre tipos como SELLER_CAMPAIGN,
// que não seguem o mecanismo de "oferta" (ref_id no formato OFFER-...) que os
// outros 5 tipos usam para bater com sale_price.metadata.promotion_id (ver
// documentacao_api_meli/campanhas-do-vendedor.md vs. gerenciar-ofertas.md):
// a campanha pode estar realmente formando o preço de venda sem que
// promotion_id case com id/ref_id, deixando uma promoção real ficar presa em
// NÃO APLICADA (caso real: "Vendex - Setembro").
//
// Só roda quando o casamento primário (promotionIdAtivo) não elegeu NENHUMA
// ATIVA na lista inteira. Critério: status started/active com precoFinal
// (promo.price) igual, em centavos (round2), ao amount do sale_price — nunca
// percentual de desconto, meli_percentage, maior desconto ou prioridade de
// campanha. Ambiguidade (duas ou mais batendo no mesmo preço) nunca escolhe
// arbitrariamente: nenhuma vira ATIVA. Muta os objetos in-place, mesmo
// padrão de enriquecerVigencia — chamado antes de deduplicarPromocoes.
function aplicarFallbackPrecoAtivo(normalizadas, saleAmount) {
  if (normalizadas.some((p) => p.statusExibicao === "ATIVA")) return;

  const amount = fin(saleAmount);
  if (amount == null) return;

  const candidatas = normalizadas.filter(
    (p) =>
      (p.status === "started" || p.status === "active") &&
      p.precoFinal != null &&
      round2(p.precoFinal) === round2(amount)
  );

  if (candidatas.length === 1) {
    candidatas[0].statusExibicao = "ATIVA";
  }
}

async function listarPromocoesDoItem({ clienteId, itemId, mlUserId }) {
  const r = await listarPromocoesDoItemDetalhado({ clienteId, itemId, mlUserId });
  return r.promocoes;
}

// Mesma leitura de listarPromocoesDoItem, mas sem engolir a falha do ML: quem
// precisa distinguir "o item não tem promoção" de "o ML não respondeu" (ex.:
// 429 na análise em lote de "Promoções com rebate") recebe `ok`/`status`/
// `retryAfter` junto da lista. listarPromocoesDoItem continua devolvendo só a
// lista (vazia em falha), exatamente como antes.
async function listarPromocoesDoItemDetalhado({ clienteId, itemId, mlUserId }) {
  const [resp, saleInfo] = await Promise.all([
    mlFetch(clienteId, `/seller-promotions/items/${encodeURIComponent(itemId)}?app_version=v2`, { mlUserId }),
    obterPromotionIdAtivo({ clienteId, itemId, mlUserId }),
  ]);
  if (!resp || !resp.ok) {
    return {
      ok: false,
      status: (resp && resp.status) ?? null,
      retryAfter: (resp && resp.retryAfter) ?? null,
      promocoes: [],
    };
  }

  let lista = Array.isArray(resp.data)
    ? resp.data
    : Array.isArray(resp.data && resp.data.results)
      ? resp.data.results
      : [];
  lista = lista.filter((p) => p && typeof p === "object");

  lista = await reconciliarOfertaAtiva({ clienteId, itemId, mlUserId, lista, saleInfo });
  const ordenada = ordenarPorPrioridade(lista);
  const normalizadas = ordenada.map((p, i) => normalizarPromocao(p, i, saleInfo && saleInfo.promotionId));

  aplicarFallbackPrecoAtivo(normalizadas, saleInfo && saleInfo.amount);

  await enriquecerVigencia({
    clienteId,
    mlUserId,
    paresBrutoNormalizado: ordenada.map((p, i) => [p, normalizadas[i]]),
  });

  return { ok: true, status: resp.status ?? 200, retryAfter: null, promocoes: deduplicarPromocoes(normalizadas) };
}

// Retorno ML (subsídio por unidade) da promoção que forma o preço AGORA — a
// mesma ATIVA que o modal usa no "Hoje", decidida pelas mesmas regras
// (normalizarPromocao + aplicarFallbackPrecoAtivo). Versão enxuta para a
// LISTA: só as duas leituras que decidem a ATIVA, sem o enriquecimento de
// vigência (uma chamada a mais por campanha sem data). `ok:false` = não deu
// para saber; nunca vira rebate 0 inventado.
//
// `saleInfo` ({promotionId, amount}, opcional): o sale_price que o chamador
// JÁ leu (o Motor de Margem lê no mesmo pedido) — evita relê-lo, e a
// leitura cai para UMA chamada (seller-promotions).
async function obterRebatePromocaoAtiva({ clienteId, itemId, mlUserId, saleInfo: saleInfoPronto = null }) {
  const [resp, saleInfo] = await Promise.all([
    mlFetch(clienteId, `/seller-promotions/items/${encodeURIComponent(itemId)}?app_version=v2`, { mlUserId }),
    saleInfoPronto || obterPromotionIdAtivo({ clienteId, itemId, mlUserId }),
  ]);
  if (!resp || !resp.ok) return { ok: false, rebate: null, promocao: null };

  let lista = (Array.isArray(resp.data) ? resp.data : (resp.data && resp.data.results) || [])
    .filter((p) => p && typeof p === "object");
  lista = await reconciliarOfertaAtiva({ clienteId, itemId, mlUserId, lista, saleInfo });
  const normalizadas = ordenarPorPrioridade(lista).map((p, i) => normalizarPromocao(p, i, saleInfo && saleInfo.promotionId));
  aplicarFallbackPrecoAtivo(normalizadas, saleInfo && saleInfo.amount);

  const ativa = normalizadas.find((p) => p.statusExibicao === "ATIVA") || null;
  if (!ativa) return { ok: true, rebate: null, promocao: null };
  return {
    ok: true,
    rebate: ativa.subsidioMl != null && ativa.subsidioMl > 0 ? ativa.subsidioMl : null,
    promocao: { id: ativa.id, nome: ativa.nome, tipoLabel: ativa.tipoLabel },
  };
}

module.exports = {
  obterRebatePromocaoAtiva,
  ROTULO_TIPO,
  listarPromocoesDoItem,
  listarPromocoesDoItemDetalhado,
  normalizarPromocao,
  ordenarPorPrioridade,
  deduplicarPromocoes,
  aplicarFallbackPrecoAtivo,
  rotuloTipoPromocao,
  statusLabelPromocao,
  modoEscritaPromocao,
  TIPOS_ESCRITA_PRECO,
  TIPOS_ESCRITA_ACEITE,
};
