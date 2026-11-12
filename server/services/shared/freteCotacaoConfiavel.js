// server/services/shared/freteCotacaoConfiavel.js
//
// P0 10/11/2026 (Alianza Jeans 2, conta 87): anúncios com a tag `proximity`
// cotados em `shipping_options/free?item_id=…` voltam R$ 7,75 fixo (desconto
// `fs_optional`/`none`, taxa 0), enquanto os envios reais cobram R$ 13,85–16,85
// (desconto `mandatory` 50%). Cotar com as DIMENSÕES do envio real reproduz o
// custo cobrado, centavo a centavo. O anúncio de controle (sem `proximity`)
// vem `mandatory` e bate com o cobrado — NÃO é tocado.
//
// Regra (evidência em ~/venforce-backups/handoffs/p0_frete_2026-11-10):
//   NÃO CONFIÁVEL = tags do envio têm `proximity` E `mandatory_free_shipping`
//                   E a resposta NÃO é desconto `mandatory` com taxa > 0.
// Nada além disso é reclassificado. Nunca se troca o valor por constante.
//
// Quando não confiável, nesta ordem:
//   1. dimensões de envios históricos (item único, ≥2 envios concordantes) →
//      nova cotação por `dimensions` (nível "estimado_dimensoes_historicas");
//   2. custo efetivamente cobrado do vendedor em envios de item único comparáveis
//      (≥3 amostras, mesmo MLB/logística, preço ±3%, dispersão ≤10%) →
//      nível "estimado_custo_cobrado" (confiança baixa);
//   3. dimensões de embalagem DECLARADAS no próprio anúncio (atributos
//      SELLER_PACKAGE_HEIGHT/WIDTH/LENGTH/WEIGHT do ML, P0 12/11/2026) → nova
//      cotação por `dimensions` (nível "estimado_dimensoes_declaradas");
//   4. nada disso → `null` + motivo `frete_cotacao_nao_confiavel` (frete
//      desconhecido: a margem não é calculada, mesmo caminho do frete ausente).
// HISTÓRICO ANTIGO (P0 12/11/2026): quando o envio mais recente da amostra tem
// mais de HISTORICO_RECENTE_DIAS, os passos 1 e 2 deixam de ter precedência —
// tenta-se antes o passo 3 (a medida que o vendedor declara HOJE); sem medida
// declarada válida, o histórico antigo ainda é usado, com confiança "baixa" e
// marcado `historicoAntigo`. Histórico recente continua em primeiro lugar.
// Nenhuma estimativa é "cobrança confirmada". SOMENTE LEITURA (GET).

const TAG_PROXIMITY = "proximity";
const TAG_FRETE_OBRIGATORIO = "mandatory_free_shipping";
const MOTIVO_NAO_CONFIAVEL = "frete_cotacao_nao_confiavel";
const NIVEIS = Object.freeze({
  COTADO: "cotado_ml",
  DIMENSOES: "estimado_dimensoes_historicas",
  CUSTO_COBRADO: "estimado_custo_cobrado",
  DECLARADAS: "estimado_dimensoes_declaradas",
  DESCONHECIDO: "desconhecido",
});

const MAX_AMOSTRAS = 6;
const MIN_DIMENSOES_CONCORDANTES = 2;
const MIN_AMOSTRAS_CUSTO = 3;
const TOLERANCIA_PRECO = 0.03;
const DISPERSAO_MAXIMA_CUSTO = 0.10;
// Toda a validação (envio × cobrado, 162/162 em coleta) é de envios com até 8
// dias; o único histórico antigo observado (MLB5872175430, dez/2025) diverge da
// medida declarada hoje (14,45 × 13,85) e não tem venda recente que desempate.
// 90 dias é um limite de PRUDÊNCIA, não uma medição: além dele a embalagem pode
// ter mudado e a declaração atual do vendedor (61/62 = cobrado) é preferida.
const HISTORICO_RECENTE_DIAS = 90;

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Liberação gradual: lista de ml_user_id; `*` = todos; ausente = ninguém (comportamento antigo). */
function freteConfiavelHabilitado(sellerId, env = process.env) {
  const cfg = String(env.FRETE_COTACAO_CONFIAVEL_SELLERS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!cfg.length || sellerId === null || sellerId === undefined || sellerId === "") return false;
  return cfg.includes("*") || cfg.includes(String(sellerId));
}

function lerResposta(resp) {
  const todo = resp && resp.ok && resp.data && resp.data.coverage ? resp.data.coverage.all_country : null;
  const d = todo && todo.discount ? todo.discount : null;
  return {
    listCost: num(todo && todo.list_cost),
    pesoFaturavel: num(todo && todo.billable_weight),
    descontoTipo: d && d.type ? String(d.type) : null,
    descontoTaxa: d ? num(d.rate) : null,
  };
}

function descontoObrigatorio(r) {
  return r.descontoTipo === "mandatory" && r.descontoTaxa !== null && r.descontoTaxa > 0;
}

function cotacaoNaoConfiavel({ resposta, tags }) {
  const t = Array.isArray(tags) ? tags : [];
  if (!t.includes(TAG_PROXIMITY) || !t.includes(TAG_FRETE_OBRIGATORIO)) return false;
  return !descontoObrigatorio(resposta);
}

// memo guarda a PROMESSA: cotações concorrentes (P' distintos) leem 1x só.
function memoizar(memo, chave, fn) {
  if (!memo) return fn();
  if (!memo[chave]) memo[chave] = fn();
  return memo[chave];
}

function tagsDoEnvio(args) {
  return memoizar(args.memo, "tags", () => lerTags(args));
}

async function lerTags({ fetchFn, clienteId, itemId, opcoes }) {
  let tags = null;
  try {
    const r = await fetchFn(clienteId, `/items/${encodeURIComponent(itemId)}?attributes=id,shipping`, opcoes);
    const t = r && r.ok && r.data && r.data.shipping ? r.data.shipping.tags : null;
    tags = Array.isArray(t) ? t : null;
  } catch (_) { tags = null; }
  return tags;
}

// ── Envios históricos de ITEM ÚNICO do mesmo MLB ───────────────────────────
function coletarAmostras(args) {
  return memoizar(args.memo, "amostras", () => lerAmostras(args));
}

async function lerAmostras({ fetchFn, clienteId, sellerId, itemId, opcoes }) {
  const saida = [];
  try {
    const os = await fetchFn(clienteId,
      `/orders/search?seller=${encodeURIComponent(sellerId)}&q=${encodeURIComponent(itemId)}&sort=date_desc&limit=20`, opcoes);
    // Leitura que falhou (429/5xx/403) ≠ anúncio sem vendas: fica registrado
    // para o "desconhecido" não esconder um rate limit. Sem retry aqui.
    if (!os || !os.ok) saida.falhaLeitura = (os && os.status) || "erro";
    const pedidos = (os && os.ok && os.data && os.data.results) || [];
    for (const o of pedidos) {
      if (saida.length >= MAX_AMOSTRAS) break;
      if (o.status !== "paid") continue;
      const linhas = o.order_items || [];
      if (linhas.length !== 1 || !linhas[0].item || linhas[0].item.id !== itemId || Number(linhas[0].quantity) !== 1) continue;
      const envioId = o.shipping && o.shipping.id;
      if (!envioId) continue;
      if (o.pack_id) { // o envio do pack pode levar outros itens: só vale pack de UM pedido
        const pk = await fetchFn(clienteId, `/packs/${encodeURIComponent(o.pack_id)}`, opcoes);
        const ords = pk && pk.ok && pk.data && Array.isArray(pk.data.orders) ? pk.data.orders : null;
        if (!ords || ords.length !== 1) continue;
      }
      const sh = await fetchFn(clienteId, `/shipments/${encodeURIComponent(envioId)}`, { ...(opcoes || {}), headers: { "x-format-new": "true" } });
      if (!sh || !sh.ok || !sh.data) continue;
      const dm = sh.data.dimensions || {};
      const h = num(dm.height), w = num(dm.width), l = num(dm.length), p = num(dm.weight);
      saida.push({
        envioId: String(envioId),
        data: o.date_created || null,
        precoUnitario: num(linhas[0].unit_price),
        logistica: sh.data.logistic_type || (sh.data.logistic && sh.data.logistic.type) || null,
        dimensions: h > 0 && w > 0 && l > 0 && p > 0 ? `${h}x${w}x${l},${p}` : null,
      });
    }
  } catch (err) { saida.falhaLeitura = saida.falhaLeitura || (err && (err.code || err.name)) || "erro"; }
  return saida;
}

// Cotação por DIMENSÕES. Sem `free_shipping=true` forçado (P0 12/11/2026): o ML
// decide a faixa pelo preço. Medido nas contas 86/87: de R$ 79 para cima o
// resultado é idêntico com ou sem o parâmetro (mandatory 0,5); abaixo de R$ 79
// forçar o parâmetro devolvia a tarifa da faixa ≥ 79 (13,85 em vez de 8,25 em
// R$ 78,99), enquanto a cotação confiável por item_id do controle devolve a
// faixa < 79 (mandatory 0,3) — a mesma que esta URL devolve sem o parâmetro.
function urlCotacaoPorDimensoes({ sellerId, dimensions, precoEfetivo, listingTypeId, logisticType }) {
  return `/users/${encodeURIComponent(sellerId)}/shipping_options/free?dimensions=${encodeURIComponent(dimensions)}` +
    `&verbose=true&item_price=${encodeURIComponent(precoEfetivo)}&listing_type_id=${encodeURIComponent(listingTypeId)}` +
    `&mode=me2&condition=new&logistic_type=${encodeURIComponent(logisticType)}`;
}

// ── Dimensões de embalagem DECLARADAS no anúncio (SELLER_PACKAGE_*) ─────────
// Validação (12/11/2026, contas 86 e 87): em envios reais cross_docking cuja
// medida do envio é a declarada, a cotação por elas = custo cobrado (19/20 e
// 53/53); nos anúncios confiáveis (sem proximity) = cotação por item_id
// (17/17). Só entra quando os passos com envios reais falham. Exige as QUATRO
// medidas > 0 em unidade conhecida: nada é completado nem arredondado.
const UNIDADES = Object.freeze({ cm: 1, mm: 0.1, m: 100, g: 1, kg: 1000 });

function medidaDeclarada(atributos, id) {
  const a = (atributos || []).find((x) => x && x.id === id);
  if (!a) return null;
  const st = a.value_struct || (Array.isArray(a.values) && a.values[0] ? a.values[0].struct : null);
  if (!st || !Object.prototype.hasOwnProperty.call(UNIDADES, st.unit)) return null;
  const n = num(st.number);
  if (n === null || n <= 0) return null;
  return Math.round(n * UNIDADES[st.unit] * 1000) / 1000;
}

function lerDimensoesDeclaradas(atributos) {
  const h = medidaDeclarada(atributos, "SELLER_PACKAGE_HEIGHT");
  const w = medidaDeclarada(atributos, "SELLER_PACKAGE_WIDTH");
  const l = medidaDeclarada(atributos, "SELLER_PACKAGE_LENGTH");
  const p = medidaDeclarada(atributos, "SELLER_PACKAGE_WEIGHT");
  if (h === null || w === null || l === null || p === null) return null;
  return { dimensions: `${h}x${w}x${l},${p}` };
}

function dimensoesDeclaradas(args) {
  return memoizar(args.memo, "declaradas", async () => {
    try {
      const r = await args.fetchFn(args.clienteId, `/items/${encodeURIComponent(args.itemId)}?include_attributes=all`, args.opcoes);
      return r && r.ok && r.data ? lerDimensoesDeclaradas(r.data.attributes) : null;
    } catch (_) { return null; }
  });
}

/** Envio dentro da janela (sem data = não recente). */
function amostraRecente(a, agora) {
  const t = Date.parse(a && a.data);
  return Number.isFinite(t) && agora().getTime() - t <= HISTORICO_RECENTE_DIAS * 86400000;
}

/** true quando HÁ envio recente na amostra (a decisão de cada passo usa só os recentes). */
function historicoRecente(amostras, agora) {
  return (amostras || []).some((a) => amostraRecente(a, agora));
}

function periodo(amostras) {
  const ds = amostras.map((a) => a.data).filter(Boolean).sort();
  return ds.length ? { de: ds[0], ate: ds[ds.length - 1] } : null;
}

function dimensoesConcordantes(amostras) {
  const cont = new Map();
  for (const a of amostras) if (a.dimensions) cont.set(a.dimensions, (cont.get(a.dimensions) || 0) + 1);
  let melhor = null;
  for (const [dimensions, n] of cont) if (!melhor || n > melhor.n) melhor = { dimensions, n };
  if (!melhor || melhor.n < MIN_DIMENSOES_CONCORDANTES) return null;
  const usadas = amostras.filter((a) => a.dimensions);
  if (melhor.n / usadas.length < 0.6) return null;
  return { dimensions: melhor.dimensions, concordantes: melhor.n, amostras: usadas.length };
}

async function custoCobrado({ fetchFn, clienteId, sellerId, opcoes, amostras, precoEfetivo, logisticType, memo = null }) {
  // Amostra sem logística conhecida não é comparável: não entra (P0 12/11/2026, revisão).
  const comparaveis = amostras.filter((a) =>
    a.precoUnitario !== null && Math.abs(a.precoUnitario - precoEfetivo) <= precoEfetivo * TOLERANCIA_PRECO &&
    (!logisticType || a.logistica === logisticType));
  if (comparaveis.length < MIN_AMOSTRAS_CUSTO) return null;
  const custos = [];
  for (const a of comparaveis) {
    try {
      // O custo de um envio não depende do preço cotado: 1 leitura por envio na requisição inteira.
      const c = await memoizar(memo, `custo:${a.envioId}`, () => fetchFn(clienteId, `/shipments/${encodeURIComponent(a.envioId)}/costs`, opcoes));
      const senders = (c && c.ok && c.data && c.data.senders) || [];
      const s = senders.find((x) => String(x.user_id) === String(sellerId));
      const v = s ? num(s.cost) : null;
      if (v !== null && v > 0) custos.push(v);
    } catch (_) { /* amostra descartada */ }
  }
  if (custos.length < MIN_AMOSTRAS_CUSTO) return null;
  custos.sort((x, y) => x - y);
  const mediana = custos.length % 2 ? custos[(custos.length - 1) / 2] : (custos[custos.length / 2 - 1] + custos[custos.length / 2]) / 2;
  if ((custos[custos.length - 1] - custos[0]) / mediana > DISPERSAO_MAXIMA_CUSTO) return null;
  return { valor: Math.round(mediana * 100) / 100, amostras: custos.length, periodo: periodo(comparaveis) };
}

// ── Modalidade (rastreabilidade; NÃO muda o valor) ──────────────────────────
// O frete projetado é o da logística do anúncio (`logistic_type`). Um mesmo
// anúncio pode vender por outra modalidade, com outro custo (medido em
// 12/11/2026, contas 86/87, 286 vendas):
//  - Flex (`self_service_in` no anúncio; envio `self_service`): o ML cobra do
//    vendedor ~R$ 7,19–9,89 (mandatory 0,1) em /shipments/{id}/costs, e o
//    vendedor paga o PRÓPRIO entregador — custo externo que o ML não informa e
//    que a margem NÃO inclui (nunca tratado como zero: fica sinalizado aqui).
//  - Envios Agora (`proximity`): entrega em até 1 h; nenhum envio dessa
//    modalidade nas amostras, todas as vendas do anúncio saíram como coleta
//    (cross_docking) com a tarifa normal.
function modalidadeDoAnuncio(logisticType, tags) {
  const t = Array.isArray(tags) ? tags : null;
  return {
    logistica: logisticType || null,
    flexHabilitado: t ? t.includes("self_service_in") : null,
    enviosAgora: t ? t.includes(TAG_PROXIMITY) : null,
    custosForaDaMargem: t && t.includes("self_service_in") ? ["entregador_flex"] : [],
  };
}

/**
 * Avalia a resposta de frete de `item_id` e, se não confiável, tenta recuperar.
 * @returns {Promise<{fretePrevisto:number|null, qualidade:object, motivo:string|null}>}
 */
async function avaliarFrete({
  fetchFn, clienteId, sellerId, itemId, listingTypeId, precoEfetivo, logisticType,
  respostaMl, tags = null, opcoes, memo = null, agora = () => new Date(),
}) {
  const resposta = lerResposta(respostaMl);
  const base = { listCostItemId: resposta.listCost, descontoTipo: resposta.descontoTipo, avaliadoEm: agora().toISOString() };
  if (resposta.listCost === null) return { fretePrevisto: null, qualidade: null, motivo: null }; // falha de leitura: caminho antigo
  let tagsEnvio = tags;
  if (!descontoObrigatorio(resposta) && !Array.isArray(tagsEnvio)) {
    tagsEnvio = await tagsDoEnvio({ fetchFn, clienteId, itemId, opcoes, memo });
  }
  base.modalidade = modalidadeDoAnuncio(logisticType, tagsEnvio);
  if (!cotacaoNaoConfiavel({ resposta, tags: tagsEnvio })) {
    return { fretePrevisto: resposta.listCost, qualidade: { nivel: NIVEIS.COTADO, confirmado: false, ...base }, motivo: null };
  }

  const amostras = await coletarAmostras({ fetchFn, clienteId, sellerId, itemId, opcoes, memo });
  const cotarDimensoes = async (dimensions) => {
    try {
      const r = lerResposta(await fetchFn(clienteId, urlCotacaoPorDimensoes({ sellerId, dimensions, precoEfetivo, listingTypeId, logisticType }), opcoes));
      return r.listCost !== null && descontoObrigatorio(r) ? r.listCost : null;
    } catch (_) { return null; }
  };

  // Passos 1 e 2 — envios reais do MLB.
  const porHistorico = async (lista) => {
    const dims = dimensoesConcordantes(lista);
    const valorDims = dims ? await cotarDimensoes(dims.dimensions) : null;
    if (valorDims !== null) {
      return {
        fretePrevisto: valorDims,
        qualidade: {
          nivel: NIVEIS.DIMENSOES, confirmado: false, confianca: "media", fonte: "shipping_options/free?dimensions (envios historicos)",
          dimensions: dims.dimensions, amostras: dims.amostras, concordantes: dims.concordantes, periodo: periodo(lista),
          cotacaoRejeitada: resposta.listCost, ...base,
        },
        motivo: null,
      };
    }
    const custo = await custoCobrado({ fetchFn, clienteId, sellerId, opcoes, amostras: lista, precoEfetivo, logisticType, memo });
    if (!custo) return null;
    return {
      fretePrevisto: custo.valor,
      qualidade: {
        nivel: NIVEIS.CUSTO_COBRADO, confirmado: false, confianca: "baixa", fonte: "shipments/costs senders.cost (item unico, mesmo MLB)",
        amostras: custo.amostras, periodo: custo.periodo, precoReferencia: precoEfetivo, cotacaoRejeitada: resposta.listCost, ...base,
      },
      motivo: null,
    };
  };

  // Passo 3 — medidas declaradas HOJE no anúncio.
  const porDeclaradas = async () => {
    const declaradas = await dimensoesDeclaradas({ fetchFn, clienteId, itemId, opcoes, memo });
    const valor = declaradas ? await cotarDimensoes(declaradas.dimensions) : null;
    if (valor === null) return null;
    return {
      fretePrevisto: valor,
      qualidade: {
        nivel: NIVEIS.DECLARADAS, confirmado: false, confianca: "media",
        fonte: "shipping_options/free?dimensions (SELLER_PACKAGE_* declaradas no anuncio)",
        dimensions: declaradas.dimensions, amostrasEncontradas: amostras.length, cotacaoRejeitada: resposta.listCost, ...base,
      },
      motivo: null,
    };
  };

  // Cada passo histórico enxerga SÓ os envios recentes: uma venda nova não "reabilita" medidas
  // antigas que concordam entre si. Os antigos ficam como último recurso, rebaixados e marcados.
  const recentes = amostras.filter((a) => amostraRecente(a, agora));
  const antigas = amostras.filter((a) => !amostraRecente(a, agora));
  if (recentes.length) {
    const r = (await porHistorico(recentes)) || (await porDeclaradas());
    if (r) return r;
  } else {
    const d = await porDeclaradas();
    if (d) {
      if (antigas.length) d.qualidade.historicoAntigo = { periodo: periodo(antigas), amostras: antigas.length };
      return d;
    }
  }
  if (antigas.length) {
    const h = await porHistorico(antigas);
    if (h) {
      h.qualidade.confianca = "baixa";
      h.qualidade.historicoAntigo = true;
      return h;
    }
  }
  return {
    fretePrevisto: null,
    qualidade: {
      nivel: NIVEIS.DESCONHECIDO, confirmado: false, motivo: MOTIVO_NAO_CONFIAVEL, amostrasEncontradas: amostras.length, cotacaoRejeitada: resposta.listCost,
      ...(amostras.falhaLeitura ? { historicoNaoLido: amostras.falhaLeitura } : {}), ...base,
    },
    motivo: MOTIVO_NAO_CONFIAVEL,
  };
}

// ── Contrato de leitura para consumidores (texto + campos estáveis) ─────────
// Resume `fretePrevisto` + `freteQualidade` + motivo num objeto único, para
// quem exibe/exporta (Automações, Diagnóstico, planilhas) não reinterpretar os
// níveis. `avaliado:false` = seller fora de FRETE_COTACAO_CONFIAVEL_SELLERS: o
// valor é a cotação por item_id como veio do ML, SEM verificação.
const TEXTO_NIVEL = Object.freeze({
  [NIVEIS.COTADO]: "Frete cotado pelo Mercado Livre para o anúncio",
  [NIVEIS.DIMENSOES]: "Frete ESTIMADO: cotação pelas medidas de envios anteriores do anúncio",
  [NIVEIS.CUSTO_COBRADO]: "Frete ESTIMADO: mediana do que o Mercado Livre cobrou em envios anteriores",
  [NIVEIS.DECLARADAS]: "Frete ESTIMADO: cotação pelas medidas de embalagem declaradas no anúncio",
  [NIVEIS.DESCONHECIDO]: "Frete DESCONHECIDO: a cotação do Mercado Livre para este anúncio não é confiável e não há medidas para recalcular",
});

function resumoDoFrete({ fretePrevisto = null, freteQualidade = null, motivo = null } = {}) {
  const q = freteQualidade && typeof freteQualidade === "object" ? freteQualidade : null;
  const valor = num(fretePrevisto);
  const fora = q && q.modalidade && Array.isArray(q.modalidade.custosForaDaMargem) ? q.modalidade.custosForaDaMargem : [];
  const partes = [];
  if (q) {
    partes.push(TEXTO_NIVEL[q.nivel] || `Frete: ${q.nivel}`);
    if (q.cotacaoRejeitada !== null && q.cotacaoRejeitada !== undefined && q.nivel !== NIVEIS.COTADO) {
      partes.push(`cotação por anúncio rejeitada: R$ ${Number(q.cotacaoRejeitada).toFixed(2).replace(".", ",")}`);
    }
    if (q.historicoAntigo) partes.push("envios anteriores antigos");
    if (fora.includes("entregador_flex")) partes.push("vendas pelo Flex têm o custo do entregador próprio, fora deste valor");
  } else if (valor === null && motivo) {
    partes.push(`Frete indisponível (${motivo})`);
  }
  return {
    valor,
    avaliado: Boolean(q),
    nivel: q ? q.nivel : null,
    confirmado: false, // frete previsto nunca é cobrança realizada
    estimado: Boolean(q && q.nivel !== NIVEIS.COTADO && q.nivel !== NIVEIS.DESCONHECIDO),
    confianca: q ? (q.confianca || (q.nivel === NIVEIS.COTADO ? "alta" : null)) : null,
    fonte: q ? (q.fonte || (q.nivel === NIVEIS.COTADO ? "shipping_options/free?item_id" : null)) : null,
    motivo: valor === null ? (motivo || (q && q.motivo) || null) : null,
    cotacaoRejeitada: q && q.nivel !== NIVEIS.COTADO ? (q.cotacaoRejeitada ?? null) : null,
    modalidade: q ? (q.modalidade || null) : null,
    custosForaDaMargem: fora,
    avaliadoEm: q ? (q.avaliadoEm || null) : null,
    texto: partes.length ? `${partes.join("; ")}.` : null,
  };
}

module.exports = {
  freteConfiavelHabilitado, cotacaoNaoConfiavel, lerResposta, descontoObrigatorio, avaliarFrete,
  dimensoesConcordantes, lerDimensoesDeclaradas, modalidadeDoAnuncio, resumoDoFrete, historicoRecente,
  MOTIVO_NAO_CONFIAVEL, NIVEIS, HISTORICO_RECENTE_DIAS,
};
