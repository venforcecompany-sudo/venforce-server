// server/services/motorMargem/margemAtualRebate.js
// Margem ATUAL de um anúncio que já está numa promoção com retorno do ML.
//
// O preço atual (`sale_price.amount`) JÁ é o promocional, mas o Margin
// Snapshot calcula a margem sem o retorno ML (rebate) — o worker não conhece
// a promoção. Sem corrigir isso, a margem atual de quem está numa promoção
// subsidiada aparece menor do que a real.
//
// A correção é na LEITURA, sem reprocessar o snapshot, e é a MESMA para a
// tabela, o drawer e as Oportunidades (todos chamam este módulo):
//   margem atual = core.computeMargin(insumos do snapshot, rebate)
// onde `rebate` = subsídio ML (por unidade) da ÚNICA promoção em andamento
// (started/active) do anúncio, lida do Promo Snapshot atual da conta.
//
//   - 0 promoções com retorno → nada a aplicar (margem do snapshot, intacta);
//   - 1 promoção              → rebate aplicado, e exposto;
//   - 2+ promoções            → ambíguo: NÃO adivinha. Margem do snapshot +
//                               motivo REBATE_AMBIGUO;
//   - Promo Snapshot ilegível → margem do snapshot + motivo
//                               PROMO_SNAPSHOT_INDISPONIVEL.
// Nunca zera, nunca estima.
//
// STATUS: a margem muda, então o status financeiro (Prejuízo / Margem baixa /
// Saudável) é reclassificado com a MESMA classifyStatus do núcleo, sobre a
// margem já com o rebate (reclassificarStatus). A tabela, o drawer e os KPIs
// (placar por status, filtro por status) usam este resultado: um anúncio
// persistido como Prejuízo que o retorno ML deixa positivo não aparece nem
// conta como Prejuízo. Só status que dependem da margem (LOSS, LOW_MARGIN,
// HEALTHY) são reclassificados — dado suspeito/não validado não depende do
// retorno e fica como o snapshot calculou.

const core = require("./core");
const { logEvento } = require("./marginSnapshotLog");
const { classificarPrecoVigente, STATUS: STATUS_PRECO, MOTIVO: MOTIVO_PRECO } = require("./precoVigenteComposicao");

const MOTIVO_REBATE = {
  AMBIGUO: "REBATE_AMBIGUO",
  PROMO_SNAPSHOT_INDISPONIVEL: "PROMO_SNAPSHOT_INDISPONIVEL",
  // P0 12/11/2026: composição do preço não comprovada (promoção não lida, não
  // identificada, DEAL sem participação do ML…) ou leituras de momentos
  // diferentes — o retorno não é somado e a margem não é confiável.
  PRECO_PROMOCAO_NAO_COMPROVADO: "PRECO_PROMOCAO_NAO_COMPROVADO",
  PRECO_PROMOCAO_DESATUALIZADO: "PRECO_PROMOCAO_DESATUALIZADO",
};

/**
 * Composição do preço da linha (quem forma, quem financia, quanto o ML
 * compensa) pelo classificador único. `info` = entrada do mapa do repositório
 * ({ linhas }); `mapa` traz `promoSnapshot` (estado da leitura da conta).
 * Entrada sem `linhas` (formato antigo, fakes) → null: não há como compor.
 */
function composicaoDoPreco(linha, info, { promoSnapshot, indisponivel = null } = {}) {
  if (indisponivel) return classificarPrecoVigente({ linha, promocoes: null, contexto: { indisponivel } });
  if (info && !Array.isArray(info.linhas)) return null;
  return classificarPrecoVigente({ linha, promocoes: info ? info.linhas : [], contexto: { promoSnapshot } });
}

/**
 * Retorno ML aplicável a uma linha (preço/lista do snapshot) — o que a tabela,
 * o drawer, os KPIs, o simulador e as oportunidades somam. Mesmo contrato para
 * todos: { rebate, motivo, ambiguo, composicao }.
 */
function rebateAplicavel(linha, info, ctx = {}) {
  if (ctx.indisponivel) return { rebate: null, motivo: ctx.indisponivel, ambiguo: false, composicao: composicaoDoPreco(linha, null, ctx) };
  if (info && !Array.isArray(info.linhas)) {
    // Formato pré-decidido { promocoes, rebate } (fakes/legado): mantido.
    if (info.promocoes > 1 || info.rebate === null || info.rebate === undefined) {
      return { rebate: null, motivo: info.promocoes > 1 ? MOTIVO_REBATE.AMBIGUO : null, ambiguo: info.promocoes > 1, composicao: null };
    }
    return { rebate: Number(info.rebate), motivo: null, ambiguo: false, composicao: null };
  }
  const composicao = composicaoDoPreco(linha, info, ctx);
  if (!composicao || composicao.status === STATUS_PRECO.SEM_PRECO) return { rebate: null, motivo: null, ambiguo: false, composicao };
  if (composicao.status === STATUS_PRECO.CONFIRMADO) {
    return { rebate: composicao.rebate, motivo: null, ambiguo: false, composicao };
  }
  const ambiguo = composicao.motivo === MOTIVO_PRECO.PROMO_AMBIGUA;
  const motivo = ambiguo ? MOTIVO_REBATE.AMBIGUO
    : composicao.status === STATUS_PRECO.DESATUALIZADO ? MOTIVO_REBATE.PRECO_PROMOCAO_DESATUALIZADO
    : MOTIVO_REBATE.PRECO_PROMOCAO_NAO_COMPROVADO;
  return { rebate: null, motivo, ambiguo, composicao };
}

// Mapa vazio com o estado da leitura da conta: `null` = sem leitura de
// promoções (sem seller/tabela) — diferente de `undefined` (desconhecido).
function mapaVazio(promoSnapshot = null) {
  const m = new Map();
  Object.defineProperty(m, "promoSnapshot", { value: promoSnapshot, enumerable: false });
  return m;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lê, para um lote de anúncios, o rebate das promoções em andamento.
 * Falha de leitura NÃO derruba a margem: devolve `indisponivel` com motivo.
 *
 * @returns {Promise<{ porItem: Map, indisponivel: string|null }>}
 */
async function carregarRebatesAtivos({ clienteContaId, sellerId, itemIds, db, promoRepo, logger = null }) {
  if (!itemIds || !itemIds.length) return { porItem: new Map(), indisponivel: null };
  if (!sellerId) return { porItem: mapaVazio(null), indisponivel: null };
  try {
    const repo = promoRepo || require("../promoSnapshot/promoSnapshotRepository");
    const porItem = await repo.mapRebatesAtivosPorItem({ clienteContaId, sellerId, itemIds }, db);
    return { porItem, indisponivel: null };
  } catch (err) {
    // Conta/tabela sem Promo Snapshot (42P01) não é falha: não há promoção conhecida.
    if (err && err.code === "42P01") return { porItem: mapaVazio(null), indisponivel: null };
    logEvento(logger, "error", "margin_snapshot.rebate_indisponivel", {
      motivo: MOTIVO_REBATE.PROMO_SNAPSHOT_INDISPONIVEL,
      clienteContaId,
      erro: err && err.message,
    });
    return { porItem: new Map(), indisponivel: MOTIVO_REBATE.PROMO_SNAPSHOT_INDISPONIVEL };
  }
}

/**
 * Margem atual de UMA linha do snapshot, com o rebate quando existe.
 *
 * @param {object} linha  { price, cost, taxRate, fixedFee, commission, freight, margin, profit }
 * @param {{promocoes:number, rebate:number|null}|undefined} info  item do mapa de rebates
 * @param {string|null} indisponivel  motivo global de leitura (carregarRebatesAtivos)
 * @returns {{ margin, profit, rebate:number|null, rebateMotivo:string|null }}
 */
function margemAtualComRebate(linha, info, indisponivel = null, ctx = {}) {
  const original = { margin: linha.margin ?? null, profit: linha.profit ?? null, rebate: null, rebateMotivo: null, precoVigente: null };
  const decisao = rebateAplicavel(linha, info, { ...ctx, indisponivel });
  const precoVigente = decisao.composicao || null;
  if (decisao.rebate === null || decisao.rebate === undefined) {
    return { ...original, rebateMotivo: decisao.motivo, precoVigente };
  }
  const calc = core.computeMargin({
    price: num(linha.price),
    cost: num(linha.cost),
    taxRate: num(linha.taxRate),
    fixedFee: num(linha.fixedFee),
    commission: num(linha.commission),
    freight: num(linha.freight),
    rebate: decisao.rebate,
  });
  // Insumos incompletos: a margem do snapshot (que também não os tinha) fica.
  if (!calc.computable) return { ...original, precoVigente };
  return { margin: calc.margin, profit: calc.profit, rebate: decisao.rebate, rebateMotivo: null, precoVigente };
}

const STATUS_PELA_MARGEM = ["LOSS", "LOW_MARGIN", "HEALTHY"];

/**
 * Status financeiro com a margem já somada ao rebate, pela MESMA classifyStatus
 * do núcleo. Devolve null quando nada muda (sem rebate aplicado, status que não
 * depende da margem, ou mesma classificação); senão { status, label, severity,
 * reasons, de }.
 *
 * Os demais insumos são os que o snapshot usou ao classificar (a leitura é da
 * PROJETADA, sem pedidos): confiança e conflito persistidos, meta do snapshot.
 *
 * @param {object} linha  linha do snapshot (status, confidenceLevel, missing, quality)
 * @param {{margin:number|null, rebate:number|null}} atual  retorno de margemAtualComRebate
 */
// P0 13/11/2026: margem calculada sobre preço promocional cuja composição NÃO
// é comprovada (promoção não lida/identificada, DEAL sem participação do ML…)
// é só LIMITE INFERIOR — o retorno ML desconhecido é ≥ 0. "Prejuízo" ou
// "Margem baixa" sobre um limite inferior não está comprovado: o status
// efetivo vira SUSPECT_DATA ("Revisar preço/promoção"), fora dos KPIs de
// resultado. "Saudável" continua: se o limite inferior já está na meta, a
// margem real também está.
const STATUS_NAO_COMPROVAVEIS = ["LOSS", "LOW_MARGIN"];
const ROTULO_LIMITE_INFERIOR = "Revisar preço/promoção";
const MOTIVO_LIMITE_INFERIOR = "preco_promocao_nao_comprovado";

function statusLimiteInferior(linha, atual) {
  const pv = atual && atual.precoVigente;
  if (!pv || pv.status !== STATUS_PRECO.REVISAR) return null;
  // Falha momentânea de leitura não reclassifica (os KPIs também não podem):
  // o item segue com o status persistido e a margem já sai como BLOQUEADA.
  if (pv.motivo === MOTIVO_PRECO.PROMO_INDISPONIVEL) return null;
  if (!STATUS_NAO_COMPROVAVEIS.includes(linha.status)) return null;
  return {
    status: core.STATUS.SUSPECT_DATA,
    label: ROTULO_LIMITE_INFERIOR,
    severity: core.SEVERITY[core.STATUS.SUSPECT_DATA],
    reasons: [pv.texto || "Composição do preço não comprovada: a margem exibida é só um limite inferior."],
    de: linha.status,
    motivo: MOTIVO_LIMITE_INFERIOR,
  };
}

function reclassificarStatus(linha, atual) {
  const limite = statusLimiteInferior(linha, atual);
  if (limite) return limite;
  if (!atual || atual.rebate === null || atual.rebate === undefined) return null;
  if (!STATUS_PELA_MARGEM.includes(linha.status)) return null;
  const quality = linha.quality || {};
  const meta = num(quality.targetMargin);
  const novo = core.classifyStatus({
    margin: atual.margin,
    computable: atual.margin !== null && atual.margin !== undefined,
    missing: linha.missing || [],
    confidenceLevel: linha.confidenceLevel,
    hasConflict: quality.hasConflict === true,
    hasOrders: false,
    settlementPending: false,
    targetMargin: meta === null ? core.DEFAULT_TARGET_MARGIN : meta,
  });
  if (novo.status === linha.status) return null;
  return { status: novo.status, label: novo.label, severity: novo.severity, reasons: novo.reasons, de: linha.status, motivo: "retorno_ml" };
}

/**
 * Rebates ativos da CONTA inteira — uma consulta. Mesmo contrato de falha de
 * carregarRebatesAtivos (nunca derruba a leitura).
 */
async function carregarRebatesDaConta({ clienteContaId, sellerId, db, promoRepo, logger = null }) {
  if (!sellerId) return { porItem: mapaVazio(null), indisponivel: null };
  try {
    const repo = promoRepo || require("../promoSnapshot/promoSnapshotRepository");
    const porItem = await repo.mapRebatesAtivosDaConta({ clienteContaId, sellerId }, db);
    return { porItem, indisponivel: null };
  } catch (err) {
    if (err && err.code === "42P01") return { porItem: mapaVazio(null), indisponivel: null };
    logEvento(logger, "error", "margin_snapshot.rebate_indisponivel", {
      motivo: MOTIVO_REBATE.PROMO_SNAPSHOT_INDISPONIVEL,
      clienteContaId,
      erro: err && err.message,
    });
    return { porItem: new Map(), indisponivel: MOTIVO_REBATE.PROMO_SNAPSHOT_INDISPONIVEL };
  }
}

/**
 * Status efetivos que DIFEREM do persistido, para a conta inteira: é o que o
 * filtro/KPIs/ordenação do repositório recebem (`statusOverrides`). Lê só as
 * linhas dos anúncios com rebate (uma consulta) e aplica reclassificarStatus.
 *
 * @returns {Promise<{ itemIds: string[], statuses: string[] }>}
 */
async function calcularStatusOverrides({ clienteId, clienteContaId, rebates, snapshotRepo, db, carregarPromocoesDosItens = null }) {
  // Candidatos: (1) itens com iniciada subsidiada (o retorno pode mudar o
  // status) e (2) linhas em Prejuízo/Margem baixa calculadas sobre preço
  // promocional (limite inferior se a composição não for comprovada).
  const comRebate = Array.from(rebates.entries()).filter(([, info]) => info &&
    (Array.isArray(info.linhas) ? info.promocoes > 0 : info.rebate !== null && info.rebate !== undefined));
  const promoSnapshot = rebates.promoSnapshot;
  const vazio = { itemIds: [], statuses: [], rebateEmPrejuizo: 0, limiteInferior: { total: 0, LOSS: 0, LOW_MARGIN: 0 } };
  const linhasRebate = comRebate.length
    ? await snapshotRepo.listProjectionSnapshotsByItemIds({ clienteId, clienteContaId, itemIds: comRebate.map(([itemId]) => itemId), db })
    : [];
  const promocionais = typeof snapshotRepo.listProjectionSnapshotsPromocionais === "function"
    ? await snapshotRepo.listProjectionSnapshotsPromocionais({ clienteId, clienteContaId, statuses: STATUS_NAO_COMPROVAVEIS, db })
    : [];
  if (!linhasRebate.length && !promocionais.length) return vazio;

  // Promoções completas dos promocionais que o mapa da conta não trouxe (só
  // quando há leitura de promoções; sem leitura, todos são "não lidos").
  const infoPorItem = new Map(rebates);
  const faltam = promocionais.map((l) => String(l.itemId)).filter((id) => !infoPorItem.has(id));
  if (faltam.length && promoSnapshot && carregarPromocoesDosItens) {
    const extra = await carregarPromocoesDosItens(faltam);
    if (extra && extra.indisponivel) {
      // Leitura falhou: sem prova de nada — fica como estava (nunca meio-corrigido).
      for (const id of faltam) infoPorItem.set(id, { __indisponivel: extra.indisponivel });
    } else if (extra && extra.porItem) {
      for (const [id, info] of extra.porItem) infoPorItem.set(String(id), info);
    }
  }

  const porId = new Map();
  for (const l of [...linhasRebate, ...promocionais]) porId.set(String(l.itemId), l);
  const ctx = { promoSnapshot };
  const itemIds = [];
  const statuses = [];
  const limiteInferior = { total: 0, LOSS: 0, LOW_MARGIN: 0 };
  // Retorno ML dos anúncios que CONTINUAM em Prejuízo (o LC deles é o persistido + o retorno):
  // quem sai de Prejuízo deixa de entrar na soma do prejuízo, então não entra aqui.
  let rebateEmPrejuizo = 0;
  for (const linha of porId.values()) {
    const info = infoPorItem.get(String(linha.itemId));
    if (info && info.__indisponivel) continue;
    const atual = margemAtualComRebate(linha, info, null, ctx);
    const novo = reclassificarStatus(linha, atual);
    if (novo) {
      itemIds.push(String(linha.itemId));
      statuses.push(novo.status);
      if (novo.motivo === MOTIVO_LIMITE_INFERIOR) { limiteInferior.total += 1; limiteInferior[novo.de] += 1; }
    } else if (linha.status === "LOSS" && atual.rebate !== null && atual.rebate !== undefined) rebateEmPrejuizo += Number(atual.rebate);
  }
  return { itemIds, statuses, rebateEmPrejuizo: Math.round((rebateEmPrejuizo + Number.EPSILON) * 100) / 100, limiteInferior };
}

module.exports = {
  rebateAplicavel,
  statusLimiteInferior,
  MOTIVO_LIMITE_INFERIOR,
  composicaoDoPreco,
  carregarRebatesAtivos,
  carregarRebatesDaConta,
  calcularStatusOverrides,
  margemAtualComRebate,
  reclassificarStatus,
  MOTIVO_REBATE,
  STATUS_PELA_MARGEM,
};
