// server/services/meliAnuncios/meliPromocoesEscritaService.js
// -----------------------------------------------------------------------------
// Módulo: Anúncios Meli — ESCRITA real de participação/alteração em promoção.
//
// Escopo desta v1 (decisão de produto, ver auditoria de
// documentacao_api_meli/{gerenciar-ofertas,campanhas-tradicionais,
// campanhas-do-vendedor,desconto-individua,ofertas-do-dia,ofertas-relampago,
// campanha-com-co-participacao,campanhas-smart-price-matching,
// desconto-pre-acordado-por-item,campanhas-de-desconto-por-quantidade}.md):
// só DEAL e SELLER_CAMPAIGN têm um contrato de escrita SIMÉTRICO — POST
// participa / PUT altera — com um preço escolhido pelo vendedor, compatível
// com a célula "Preço final" que já existe no bloco "Promoções disponíveis".
//
// Todos os outros tipos ficam de fora desta v1, cada um por um motivo
// diferente:
//   - PRICE_DISCOUNT: POST cria, mas não existe PUT — a doc manda excluir e
//     recriar, e exige start_date/finish_date que esta tela não coleta;
//   - DOD/LIGHTNING: só POST, sem "alterar" documentado, e uma vez ativas não
//     podem ser removidas nem alteradas (LIGHTNING ainda exige `stock`, que
//     também não coletamos);
//   - MARKETPLACE_CAMPAIGN/VOLUME/SMART/PRICE_MATCHING/PRE_NEGOTIATED/
//     UNHEALTHY_STOCK: o vendedor só ACEITA — o corpo do POST não leva preço
//     nenhum (ou leva um offer_id que hoje não capturamos), então não há
//     "preço final editável" nenhum pra mandar.
//
// Sempre relê o estado AO VIVO da promoção (GET /seller-promotions/items/{id},
// via listarPromocoesDoItem) antes de decidir POST x PUT — nunca confia no
// status que o frontend guardou em cache, porque pode ter mudado entre a
// simulação e o clique em "Confirmar" (mesmo espírito do "GET fresco -> PUT"
// de meliVariacoesLegadoEstoqueService).
// -----------------------------------------------------------------------------

const { mlFetch } = require("../../utils/mlClient");
const { motivoDoErroMl, codigoDoErroMl } = require("./meliConteudoService");
const { listarPromocoesDoItem } = require("./meliPromocoesService");
// Fonte única dos tipos (também lida pela Central de Margem).
const {
  TIPOS_ESCRITA_PRECO,
  TIPOS_ESCRITA_ACEITE,
  TIPOS_ACEITE_SEM_OFFER_NO_POST,
} = require("./promocaoTiposSuportados");

// Preço escolhido pelo vendedor (POST participa / PUT altera): DEAL e SELLER_CAMPAIGN.
const TIPOS_COM_ESCRITA = TIPOS_ESCRITA_PRECO;

// Status BRUTOS do ML que podem virar PUT (alteração de preço de uma
// participação em andamento). `pending` é DELIBERADAMENTE excluído daqui:
// uma promoção agendada nunca é a que define o preço atual do anúncio — o
// próprio normalizador (meliPromocoesService) sempre marca pending como
// statusExibicao "PROGRAMADA", nunca "ATIVA" — então "alterar" algo que
// ainda não começou não faz sentido de produto (regra: PROGRAMADA → só
// Simular, nunca Alterar). Separado de propósito da classificação de status
// bruto que outros módulos usam pra rótulo/exibição (ver STATUS_LABEL em
// meliPromocoesService.js, que inclui pending como "AGENDADA") — aqui é
// estritamente "pode isto virar uma escrita real", não "como isto aparece
// na tela". Excluir pending do Set torna o bloqueio estrutural: mesmo que
// um bug futuro fizesse o normalizador marcar um pending como "ATIVA" por
// engano, este Set continuaria impedindo o PUT, porque a decisão não
// depende só de statusExibicao.
const STATUS_ALTERAVEL = new Set(["started", "active"]);

// Participações (inscrito, mesmo que ainda não comece ou não forme o preço).
const STATUS_PODE_SAIR = new Set(["started", "active", "pending"]);

function falha(codigo, motivo) {
  return { ok: false, codigo, motivo };
}

function normalizarPrecoPromocao(bruto) {
  if (bruto === null || bruto === undefined || bruto === "") {
    return { ok: false, codigo: "PRECO_INVALIDO", motivo: "Informe o novo preço." };
  }
  const n = Number(bruto);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, codigo: "PRECO_INVALIDO", motivo: "O preço precisa ser um número maior que zero." };
  }
  return { ok: true, valor: Math.round((n + Number.EPSILON) * 100) / 100 };
}

function comPrazo(promessa, ms) {
  if (!ms) return promessa;
  let timer;
  return Promise.race([
    promessa,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Leitura do Mercado Livre sem resposta em ${ms} ms.`);
        err.name = "MlTimeoutError";
        err.code = "ML_TIMEOUT";
        err.enviado = false;
        reject(err);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function ehTimeout(err) {
  return Boolean(err && err.name === "MlTimeoutError");
}

/**
 * Parâmetros OPCIONAIS (camada segura da Central de Margem; sem eles o fluxo
 * é exatamente o de antes, que /anuncios usa):
 *  - timeoutMs        prazo real da releitura e do POST/PUT
 *  - antesDeEscrever  gancho chamado com a promoção RELIDA e a ação decidida
 *                     (PARTICIPAR/ALTERAR) ANTES do POST/PUT; devolve
 *                     { ok:true, deadlineAt } ou uma falha. É onde a Central
 *                     exige que a promoção e a intenção sejam as do preview e
 *                     confirma que ainda é dona do claim (fencing) — nunca
 *                     transforma Participar em Alterar em silêncio.
 *  - alterarParticipacao  pedido EXPLÍCITO do operador (modal de Anúncios ML)
 *                     para alterar o preço de uma participação que NÃO é a que
 *                     forma o preço agora (NÃO APLICADA) ou que ainda não
 *                     começou (PROGRAMADA). A doc do ML aceita PUT em qualquer
 *                     item participante (inclusive pending). Sem a flag, a
 *                     regra antiga vale: só a ATIVA vira PUT.
 * Timeout no POST/PUT volta como falha com `incerto:true`.
 */
async function aplicarPromocao({ clienteId, itemId, mlUserId, promotionId, precoNovo, timeoutMs = null, antesDeEscrever = null, alterarParticipacao = false }) {
  const v = normalizarPrecoPromocao(precoNovo);
  if (!v.ok) return falha(v.codigo, v.motivo);

  const id = String(itemId || "").trim();
  if (!id) return falha("ITEM_ID_AUSENTE", "Item sem identificador do Mercado Livre.");

  // Releitura ao vivo — nunca confia no status/tipo que o frontend guardou.
  let lista;
  try {
    lista = await comPrazo(listarPromocoesDoItem({ clienteId, itemId: id, mlUserId }), timeoutMs);
  } catch (err) {
    if (ehTimeout(err)) return { ...falha("ML_TIMEOUT_LEITURA", "O Mercado Livre não respondeu a tempo antes da escrita. Nada foi enviado."), enviado: false };
    throw err;
  }
  const promo = lista.find((p) => String(p.id) === String(promotionId));
  if (!promo) {
    return falha(
      "PROMOCAO_NAO_ENCONTRADA",
      "Esta promoção não está mais disponível para este anúncio. Atualize a tela e tente novamente."
    );
  }
  if (!TIPOS_COM_ESCRITA.has(promo.tipo)) {
    return falha(
      "TIPO_SEM_ESCRITA",
      "Este tipo de promoção ainda não tem participação/alteração automática nesta tela — use o Mercado Livre diretamente."
    );
  }

  // Decisão de escrita — regra final por statusExibicao (ver auditoria):
  //   ATIVA        → PUT  (só quem está started/active E é a que o ML aponta
  //                        via sale_price.metadata.promotion_id como a que
  //                        define o preço atual)
  //   ELEGÍVEL     → POST (candidate — participação nova)
  //   NÃO APLICADA → bloqueado (started/active que não é a vencedora)
  //   PROGRAMADA   → bloqueado (pending — nem começou; nunca fica ATIVA)
  // `promo.statusExibicao` já vem calculado por listarPromocoesDoItem (mesma
  // releitura ao vivo de cima, não uma segunda chamada). `podeAlterar` exige
  // as DUAS condições (status bruto em STATUS_ALTERAVEL E statusExibicao
  // ATIVA) — nunca confia só numa das duas — para que nem um bug futuro no
  // normalizador nem uma reclassificação de status bruto sozinhos consigam
  // liberar um PUT indevido. Defesa em profundidade: o frontend já bloqueia
  // isso na UI, mas este endpoint pode ser chamado por qualquer cliente HTTP.
  const podeAlterar = (STATUS_ALTERAVEL.has(promo.status) && promo.statusExibicao === "ATIVA") ||
    (alterarParticipacao === true && STATUS_PODE_SAIR.has(promo.status));
  const podeParticipar = promo.status === "candidate";

  if (!podeAlterar && !podeParticipar) {
    const motivo =
      promo.status === "pending"
        ? "Esta promoção ainda não começou no Mercado Livre — ainda não é possível alterá-la."
        : "Esta promoção existe no Mercado Livre, mas não é a que está definindo o preço atual do anúncio — atualize a tela e confira qual promoção está realmente aplicada.";
    return falha("PROMOCAO_NAO_APLICADA", motivo);
  }

  const metodo = podeAlterar ? "PUT" : "POST";

  let deadlineAt = null;
  if (antesDeEscrever) {
    let liberado;
    try {
      liberado = await antesDeEscrever({ promo, metodo, acao: podeAlterar ? "ALTERAR" : "PARTICIPAR" });
    } catch (err) {
      if (ehTimeout(err)) return { ...falha("ML_TIMEOUT_LEITURA", "O Mercado Livre não respondeu a tempo antes da escrita. Nada foi enviado."), enviado: false };
      throw err;
    }
    if (!liberado || liberado.ok !== true) {
      return falha((liberado && liberado.codigo) || "ESCRITA_NAO_LIBERADA", (liberado && liberado.motivo) || "A escrita não foi liberada.");
    }
    deadlineAt = liberado.deadlineAt ?? null;
  }

  let writeResp;
  try {
    writeResp = await mlFetch(
      clienteId,
      `/seller-promotions/items/${encodeURIComponent(id)}?app_version=v2`,
      {
        method: metodo,
        body: JSON.stringify({
          promotion_id: promotionId,
          promotion_type: promo.tipo,
          deal_price: v.valor,
        }),
        mlUserId,
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(deadlineAt != null ? { deadlineAt } : {}),
      }
    );
  } catch (err) {
    if (!ehTimeout(err)) throw err;
    if (!err.enviado) {
      return { ...falha(err.code || "ML_DEADLINE_EXCEEDED", "O prazo da escrita esgotou antes do envio. Nada foi enviado ao Mercado Livre."), enviado: false };
    }
    return {
      ...falha("ML_TIMEOUT", "O Mercado Livre não respondeu a tempo. A promoção pode ter sido aplicada — confira o anúncio antes de tentar de novo."),
      enviado: true,
      incerto: true,
    };
  }

  if (!writeResp || !writeResp.ok) {
    return falha(
      codigoDoErroMl(writeResp && writeResp.data, writeResp && writeResp.status),
      motivoDoErroMl(writeResp && writeResp.data, writeResp && writeResp.status)
    );
  }

  // Nunca assumir o valor enviado — o confirmado é sempre o que a RESPOSTA
  // do POST/PUT devolve (mesma garantia de meliPrecoService.atualizarPreco).
  const precoConfirmado = Number(writeResp.data && writeResp.data.price);
  const precoOriginal = Number(writeResp.data && writeResp.data.original_price);

  return {
    ok: true,
    metodo,
    promotionId,
    tipo: promo.tipo,
    precoConfirmado: Number.isFinite(precoConfirmado) ? precoConfirmado : null,
    precoOriginal: Number.isFinite(precoOriginal) ? precoOriginal : null,
  };
}

// ---------------------------------------------------------------------------
// Tipos ACEITE (o Mercado Livre define o preço — ver meliPromocoesService.
// TIPOS_ESCRITA_ACEITE): o vendedor só PARTICIPA ou DEIXA DE PARTICIPAR.
// Nunca envia preço. Mesma regra de sempre: relê o estado AO VIVO antes de
// escrever e decide pelo status relido, nunca pelo que o frontend guardou.
//
//   participar  → só status candidate; POST {promotion_id, promotion_type}
//                 + offer_id da candidatura quando o tipo exige (SMART,
//                 PRICE_MATCHING, PRE_NEGOTIATED, UNHEALTHY_STOCK — a doc de
//                 MARKETPLACE_CAMPAIGN não leva offer_id);
//   sair        → qualquer tipo em started/active/pending; DELETE com os
//                 parâmetros do tipo (ver TIPOS_SAIDA_* abaixo), independente
//                 de o VenForce permitir criar ou alterar essa promoção.
// (TIPOS_ACEITE_SEM_OFFER_NO_POST vem da fonte única promocaoTiposSuportados.)
// ---------------------------------------------------------------------------

async function relerPromocaoAceite({ clienteId, itemId, mlUserId, promotionId, tipo, tiposAceitos = TIPOS_ESCRITA_ACEITE }) {
  const id = String(itemId || "").trim();
  if (!id) return { falha: falha("ITEM_ID_AUSENTE", "Item sem identificador do Mercado Livre.") };

  const lista = await listarPromocoesDoItem({ clienteId, itemId: id, mlUserId });
  // id + tipo: o id só é único dentro de cada tipo (ver deduplicarPromocoes).
  const promo = lista.find((p) => String(p.id) === String(promotionId) && (!tipo || p.tipo === tipo));
  if (!promo) {
    return {
      falha: falha(
        "PROMOCAO_NAO_ENCONTRADA",
        "Esta promoção não está mais disponível para este anúncio. Atualize a tela e tente novamente."
      ),
    };
  }
  if (!promo.tipo || (tiposAceitos && !tiposAceitos.has(promo.tipo))) {
    return {
      falha: falha(
        "TIPO_SEM_ACEITE",
        "Nesta promoção o preço é escolhido pelo vendedor ou ela só é gerida pelo Mercado Livre — não dá para só participar/sair por aqui."
      ),
    };
  }
  return { id, promo, lista };
}

/**
 * `antesDeEscrever` (OPCIONAL, mesmo espírito do de aplicarPromocao): gancho
 * chamado com a promoção RELIDA e a lista inteira relida do item
 * ({ promo, lista, acao: "PARTICIPAR" }) ANTES do POST; devolve { ok:true }
 * (opcionalmente com `deadlineAt`) ou uma falha { codigo, motivo }. É onde
 * "Promoções com rebate" revalida, na mesma releitura, que a referência
 * continua ativa e que o preço da candidata continua menor que o dela, e onde
 * a Central de Margem confere o fingerprint do preview e faz o fencing.
 *
 * `timeoutMs` (OPCIONAL, camada segura da Central): prazo real da releitura e
 * do POST, como em aplicarPromocao — timeout na releitura volta como falha
 * `enviado:false`; no POST, como falha `incerto:true`. Sem `timeoutMs` (e sem
 * `deadlineAt` do gancho) o fluxo é exatamente o de antes, que /anuncios usa.
 */
async function participarPromocaoAceite({ clienteId, itemId, mlUserId, promotionId, tipo, antesDeEscrever = null, timeoutMs = null }) {
  let lido;
  try {
    lido = await comPrazo(relerPromocaoAceite({ clienteId, itemId, mlUserId, promotionId, tipo }), timeoutMs);
  } catch (err) {
    if (timeoutMs && ehTimeout(err)) return { ...falha("ML_TIMEOUT_LEITURA", "O Mercado Livre não respondeu a tempo antes da escrita. Nada foi enviado."), enviado: false };
    throw err;
  }
  if (lido.falha) return lido.falha;
  const { id, promo, lista } = lido;

  if (promo.status !== "candidate") {
    return falha("PROMOCAO_JA_PARTICIPA", "O anúncio já participa desta promoção. Atualize a tela.");
  }

  const corpo = { promotion_id: promo.id, promotion_type: promo.tipo };
  if (!TIPOS_ACEITE_SEM_OFFER_NO_POST.has(promo.tipo)) {
    if (!promo.refId) {
      return falha("OFFER_ID_AUSENTE", "O Mercado Livre não informou a oferta desta promoção — participe pelo painel do Mercado Livre.");
    }
    corpo.offer_id = promo.refId;
  }

  let deadlineAt = null;
  if (antesDeEscrever) {
    let liberado;
    try {
      liberado = await antesDeEscrever({ promo, lista, acao: "PARTICIPAR" });
    } catch (err) {
      if (timeoutMs && ehTimeout(err)) return { ...falha("ML_TIMEOUT_LEITURA", "O Mercado Livre não respondeu a tempo antes da escrita. Nada foi enviado."), enviado: false };
      throw err;
    }
    if (!liberado || liberado.ok !== true) {
      return falha((liberado && liberado.codigo) || "ESCRITA_NAO_LIBERADA", (liberado && liberado.motivo) || "A escrita não foi liberada.");
    }
    deadlineAt = liberado.deadlineAt ?? null;
  }

  const comLimite = Boolean(timeoutMs) || deadlineAt != null;
  let resp;
  try {
    resp = await mlFetch(clienteId, `/seller-promotions/items/${encodeURIComponent(id)}?app_version=v2`, {
      method: "POST",
      body: JSON.stringify(corpo),
      mlUserId,
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(deadlineAt != null ? { deadlineAt } : {}),
    });
  } catch (err) {
    if (!comLimite || !ehTimeout(err)) throw err;
    if (!err.enviado) {
      return { ...falha(err.code || "ML_DEADLINE_EXCEEDED", "O prazo da escrita esgotou antes do envio. Nada foi enviado ao Mercado Livre."), enviado: false };
    }
    return {
      ...falha("ML_TIMEOUT", "O Mercado Livre não respondeu a tempo. A participação pode ter sido registrada — confira o anúncio antes de tentar de novo."),
      enviado: true,
      incerto: true,
    };
  }
  if (!resp || !resp.ok) {
    return falha(codigoDoErroMl(resp && resp.data, resp && resp.status), motivoDoErroMl(resp && resp.data, resp && resp.status));
  }

  const precoConfirmado = Number(resp.data && resp.data.price);
  return {
    ok: true,
    acao: "PARTICIPAR",
    promotionId: promo.id,
    tipo: promo.tipo,
    precoConfirmado: Number.isFinite(precoConfirmado) ? precoConfirmado : null,
  };
}

// Sair independe do suporte à criação/alteração. O ML valida as restrições
// da oferta (por exemplo, DOD/LIGHTNING já iniciadas) e devolvemos sua recusa.
const TIPOS_SAIDA_SO_TIPO = new Set(["PRICE_DISCOUNT", "DOD", "LIGHTNING"]);
const TIPOS_SAIDA_COM_OFFER = new Set([...TIPOS_ESCRITA_ACEITE, "VOLUME", "BANK"]);

async function sairPromocao({ clienteId, itemId, mlUserId, promotionId, tipo }) {
  const lido = await relerPromocaoAceite({ clienteId, itemId, mlUserId, promotionId, tipo, tiposAceitos: null });
  if (lido.falha) return lido.falha;
  const { id, promo } = lido;

  if (!STATUS_PODE_SAIR.has(promo.status)) {
    return falha("PROMOCAO_NAO_PARTICIPA", "O anúncio não participa desta promoção. Atualize a tela.");
  }
  const soTipo = TIPOS_SAIDA_SO_TIPO.has(promo.tipo);
  const comOffer = !soTipo && !TIPOS_COM_ESCRITA.has(promo.tipo) && Boolean(promo.refId);
  if (TIPOS_SAIDA_COM_OFFER.has(promo.tipo) && !promo.refId) {
    return falha("OFFER_ID_AUSENTE", "O Mercado Livre não informou a oferta desta promoção — saia pelo painel do Mercado Livre.");
  }

  const qs =
    "promotion_type=" + encodeURIComponent(promo.tipo) +
    (soTipo ? "" : "&promotion_id=" + encodeURIComponent(promo.id)) +
    (comOffer ? "&offer_id=" + encodeURIComponent(promo.refId) : "") +
    "&app_version=v2";
  const resp = await mlFetch(clienteId, `/seller-promotions/items/${encodeURIComponent(id)}?${qs}`, {
    method: "DELETE",
    mlUserId,
  });
  if (!resp || !resp.ok) {
    return falha(codigoDoErroMl(resp && resp.data, resp && resp.status), motivoDoErroMl(resp && resp.data, resp && resp.status));
  }
  return { ok: true, acao: "SAIR", promotionId: promo.id, tipo: promo.tipo };
}

module.exports = {
  aplicarPromocao,
  participarPromocaoAceite,
  sairPromocao,
  normalizarPrecoPromocao,
  TIPOS_COM_ESCRITA,
};
