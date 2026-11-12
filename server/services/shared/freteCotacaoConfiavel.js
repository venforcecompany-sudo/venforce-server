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
  } catch (_) { /* sem amostras: cai em desconhecido */ }
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

async function custoCobrado({ fetchFn, clienteId, sellerId, opcoes, amostras, precoEfetivo, logisticType }) {
  const comparaveis = amostras.filter((a) =>
    a.precoUnitario !== null && Math.abs(a.precoUnitario - precoEfetivo) <= precoEfetivo * TOLERANCIA_PRECO &&
    (!logisticType || !a.logistica || a.logistica === logisticType));
  if (comparaveis.length < MIN_AMOSTRAS_CUSTO) return null;
  const custos = [];
  for (const a of comparaveis) {
    try {
      const c = await fetchFn(clienteId, `/shipments/${encodeURIComponent(a.envioId)}/costs`, opcoes);
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
  if (!cotacaoNaoConfiavel({ resposta, tags: tagsEnvio })) {
    return { fretePrevisto: resposta.listCost, qualidade: { nivel: NIVEIS.COTADO, confirmado: false, ...base }, motivo: null };
  }

  const amostras = await coletarAmostras({ fetchFn, clienteId, sellerId, itemId, opcoes, memo });
  const dims = dimensoesConcordantes(amostras);
  if (dims) {
    try {
      const r = lerResposta(await fetchFn(clienteId, urlCotacaoPorDimensoes({ sellerId, dimensions: dims.dimensions, precoEfetivo, listingTypeId, logisticType }), opcoes));
      if (r.listCost !== null && descontoObrigatorio(r)) {
        return {
          fretePrevisto: r.listCost,
          qualidade: {
            nivel: NIVEIS.DIMENSOES, confirmado: false, confianca: "media", fonte: "shipping_options/free?dimensions (envios historicos)",
            dimensions: dims.dimensions, amostras: dims.amostras, concordantes: dims.concordantes, periodo: periodo(amostras),
            cotacaoRejeitada: resposta.listCost, ...base,
          },
          motivo: null,
        };
      }
    } catch (_) { /* tenta o custo cobrado */ }
  }

  const custo = await custoCobrado({ fetchFn, clienteId, sellerId, opcoes, amostras, precoEfetivo, logisticType });
  if (custo) {
    return {
      fretePrevisto: custo.valor,
      qualidade: {
        nivel: NIVEIS.CUSTO_COBRADO, confirmado: false, confianca: "baixa", fonte: "shipments/costs senders.cost (item unico, mesmo MLB)",
        amostras: custo.amostras, periodo: custo.periodo, precoReferencia: precoEfetivo, cotacaoRejeitada: resposta.listCost, ...base,
      },
      motivo: null,
    };
  }
  const declaradas = await dimensoesDeclaradas({ fetchFn, clienteId, itemId, opcoes, memo });
  if (declaradas) {
    try {
      const r = lerResposta(await fetchFn(clienteId, urlCotacaoPorDimensoes({ sellerId, dimensions: declaradas.dimensions, precoEfetivo, listingTypeId, logisticType }), opcoes));
      if (r.listCost !== null && descontoObrigatorio(r)) {
        return {
          fretePrevisto: r.listCost,
          qualidade: {
            nivel: NIVEIS.DECLARADAS, confirmado: false, confianca: "media",
            fonte: "shipping_options/free?dimensions (SELLER_PACKAGE_* declaradas no anuncio)",
            dimensions: declaradas.dimensions, amostrasEncontradas: amostras.length, cotacaoRejeitada: resposta.listCost, ...base,
          },
          motivo: null,
        };
      }
    } catch (_) { /* desconhecido */ }
  }
  return {
    fretePrevisto: null,
    qualidade: { nivel: NIVEIS.DESCONHECIDO, confirmado: false, motivo: MOTIVO_NAO_CONFIAVEL, amostrasEncontradas: amostras.length, cotacaoRejeitada: resposta.listCost, ...base },
    motivo: MOTIVO_NAO_CONFIAVEL,
  };
}

module.exports = {
  freteConfiavelHabilitado, cotacaoNaoConfiavel, lerResposta, descontoObrigatorio, avaliarFrete,
  dimensoesConcordantes, lerDimensoesDeclaradas, MOTIVO_NAO_CONFIAVEL, NIVEIS,
};
