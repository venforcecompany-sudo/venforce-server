// server/tests/freteProximityConfiavel.test.js
// P0 10/11/2026 — frete subestimado em anúncios `proximity` (Alianza Jeans 2, conta 87).
// Valores reais do handoff p0_frete_2026-11-10: cotação por item_id = 7,75 (fs_optional/none, taxa 0);
// envios reais cobraram 16,85 / 13,85 / 14,45; cotação por dimensions do envio reproduz o cobrado.
// Controle MLB4122867933 (sem proximity): 19,05 mandatory — não pode mudar.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://nobody@127.0.0.1:1/teste-sem-banco";
const assert = require("assert");
const { buscarComissaoEFrete, obterCotacaoAtual } = require("../services/shared/marketplaceCurrentQuoteService");
const { criarCotadorEmP } = require("../services/motorMargem/margemCotacaoEmP");
const { freteConfiavelHabilitado, NIVEIS } = require("../services/shared/freteCotacaoConfiavel");

const SELLER = "2433262404";
let checks = 0;
const casos = [];
const cenario = (n, f) => casos.push({ n, f });
const ok = (c, m) => { assert.ok(c, m); checks += 1; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks += 1; };

const TAGS_PROX = ["self_service_in", "mandatory_free_shipping", "proximity"];
const TAGS_CTRL = ["self_service_in", "mandatory_free_shipping"];

function ped(id, envio, preco, extra = {}) {
  return { id, status: "paid", date_created: new Date(Date.now() - ((id % 9) + 1) * 86400000).toISOString(), pack_id: null,
    order_items: [{ item: { id: extra.item }, quantity: 1, unit_price: preco }], shipping: { id: envio }, ...extra.o };
}
// Mundo: item → { tags, quote7_75, dims, custo, pedidos }
function mundo(spec, { semDims = false } = {}) {
  const chamadas = [];
  const envios = {};
  const pedidos = (spec.pedidos || []).map((p, i) => {
    const envioId = `${spec.id}-${i}`;
    envios[envioId] = {
      logistic_type: spec.logistica || "cross_docking",
      dimensions: spec.dimsPorEnvio ? spec.dimsPorEnvio[i] : (semDims ? null : spec.dims),
      custo: spec.custos ? spec.custos[i] : spec.custoReal,
    };
    return { ...ped(100 + i, envioId, spec.precoVenda || spec.preco, { item: spec.id }), ...(p || {}) };
  });
  async function mlFetch(cid, path, opts = {}) {
    const p = String(path);
    chamadas.push(p);
    if (p.startsWith(`/items/${spec.id}?attributes=id,shipping`)) return { ok: true, status: 200, data: { id: spec.id, shipping: { tags: spec.tags } } };
    if (p.includes("/shipping_options/free")) {
      if (p.includes("dimensions=")) {
        const dm = decodeURIComponent(p.match(/dimensions=([^&]+)/)[1]);
        if (dm === spec.dims) return { ok: true, status: 200, data: { coverage: { all_country: { list_cost: spec.custoReal, billable_weight: 620, discount: { rate: 0.5, type: "mandatory", promoted_amount: spec.custoReal * 2 } } } } };
        return { ok: true, status: 200, data: { coverage: { all_country: { list_cost: 7.75, discount: { rate: 0, type: "none" } } } } };
      }
      return { ok: true, status: 200, data: { coverage: { all_country: spec.cotacaoItem } } };
    }
    if (p.startsWith("/sites/MLB/listing_prices")) return { ok: true, status: 200, data: { sale_fee_amount: 10, sale_fee_details: { percentage_fee: 14 } } };
    if (p.startsWith("/orders/search")) return { ok: true, status: 200, data: { results: pedidos } };
    const sh = p.match(/^\/shipments\/([^/]+)(\/costs)?$/);
    if (sh) {
      const e = envios[sh[1]];
      if (!e) return { ok: false, status: 404 };
      if (sh[2]) return { ok: true, status: 200, data: { senders: [{ user_id: Number(SELLER), cost: e.custo }] } };
      const [h, w, l, pe] = e.dimensions ? e.dimensions.replace(",", "x").split("x").map(Number) : [];
      return { ok: true, status: 200, data: { logistic_type: e.logistic_type, dimensions: e.dimensions ? { height: h, width: w, length: l, weight: pe } : null } };
    }
    if (p.startsWith("/packs/")) return { ok: true, status: 200, data: { orders: spec.packOrders || [{}] } };
    return { ok: false, status: 404 };
  }
  return { mlFetch, chamadas };
}
const FS_OPTIONAL = { list_cost: 7.75, billable_weight: 480, discount: { rate: 0, type: "fs_optional", promoted_amount: 7.75 } };
const NONE = { list_cost: 7.75, billable_weight: 480, discount: { rate: 0, type: "none", promoted_amount: 7.75 } };
const pedidos5 = [{}, {}, {}, {}, {}];

const PROBLEMA = [
  { id: "MLB6244198308", preco: 108.8, dims: "27x23x5,620", custoReal: 16.85, listing: "gold_special" },
  { id: "MLB4113911709", preco: 99.9, dims: "28x24x4,430", custoReal: 13.85, listing: "gold_special" },
  { id: "MLB4161792499", preco: 94.99, dims: "36x26x6,300", custoReal: 14.45, listing: "gold_special" },
];
const CONTROLE = { id: "MLB4122867933", preco: 127.9, tags: TAGS_CTRL, listing: "gold_pro", cotacaoItem: { list_cost: 19.05, billable_weight: 556, discount: { rate: 0.5, type: "mandatory", promoted_amount: 38.1 } } };

async function cotar(spec, extra = {}, mundoOpc) {
  const m = mundo({ pedidos: pedidos5, ...spec }, mundoOpc);
  const r = await buscarComissaoEFrete({
    clienteId: 133, itemId: spec.id, precoEfetivo: spec.preco, listingTypeId: spec.listing || "gold_special",
    categoryId: "MLB1", sellerId: SELLER, logisticType: "cross_docking", mlUserId: SELLER, ...extra,
  }, m.mlFetch);
  return { r, m };
}

function comEnv(valor, fn) {
  const ant = process.env.FRETE_COTACAO_CONFIAVEL_SELLERS;
  if (valor === undefined) delete process.env.FRETE_COTACAO_CONFIAVEL_SELLERS; else process.env.FRETE_COTACAO_CONFIAVEL_SELLERS = valor;
  return Promise.resolve().then(fn).finally(() => { if (ant === undefined) delete process.env.FRETE_COTACAO_CONFIAVEL_SELLERS; else process.env.FRETE_COTACAO_CONFIAVEL_SELLERS = ant; });
}

for (const base of PROBLEMA) {
  for (const [rotulo, cot] of [["fs_optional", FS_OPTIONAL], ["none (URL atual sem logistic_type)", NONE]]) {
    cenario(`${base.id}: ${rotulo} + proximity → estima por dimensões históricas (${base.custoReal}), nunca 7,75 nem "confirmado"`, () => comEnv(SELLER, async () => {
      const { r } = await cotar({ ...base, tags: TAGS_PROX, cotacaoItem: cot });
      eq(r.fretePrevisto, base.custoReal);
      eq(r.freteQualidade.nivel, NIVEIS.DIMENSOES);
      eq(r.freteQualidade.confirmado, false);
      eq(r.freteQualidade.dimensions, base.dims);
      eq(r.freteQualidade.cotacaoRejeitada, 7.75);
      ok(r.freteQualidade.amostras >= 2 && r.freteQualidade.periodo.de, "amostras e período registrados");
      eq(r.diagnostico.frete.motivo, null);
    }));
  }
}

cenario("controle MLB4122867933 (sem proximity, mandatory 19,05): inalterado, sem GET extra", () => comEnv(SELLER, async () => {
  const { r, m } = await cotar({ ...CONTROLE, pedidos: pedidos5 });
  eq(r.fretePrevisto, 19.05);
  eq(r.freteQualidade.nivel, NIVEIS.COTADO);
  ok(!m.chamadas.some((c) => c.startsWith("/orders") || c.startsWith("/shipments") || c.includes("dimensions=")), m.chamadas.join(" | "));
  ok(!m.chamadas.some((c) => c.startsWith("/items/")), "mandatory não precisa nem ler as tags");
}));

cenario("sem proximity mas resposta fs_optional (ex.: abaixo de R$ 79, free_shipping=false): NÃO reclassifica", () => comEnv(SELLER, async () => {
  const { r } = await cotar({ id: "MLB4325512299", preco: 41.9, tags: ["self_service_in"], cotacaoItem: { list_cost: 6.95, discount: { rate: 0, type: "fs_optional" } } });
  eq(r.fretePrevisto, 6.95);
  eq(r.freteQualidade.nivel, NIVEIS.COTADO);
}));

cenario("proximity com desconto mandatory (taxa 0,5): confiável, mantém o valor da cotação", () => comEnv(SELLER, async () => {
  const { r } = await cotar({ id: "MLB9", preco: 100, tags: TAGS_PROX, cotacaoItem: { list_cost: 14, discount: { rate: 0.5, type: "mandatory" } } });
  eq(r.fretePrevisto, 14);
  eq(r.freteQualidade.nivel, NIVEIS.COTADO);
}));

cenario("seller fora da liberação / env ausente: comportamento antigo byte a byte (7,75, sem GET extra, sem freteQualidade)", async () => {
  for (const env of [undefined, "9999999", ""]) {
    await comEnv(env, async () => {
      const { r, m } = await cotar({ ...PROBLEMA[0], tags: TAGS_PROX, cotacaoItem: FS_OPTIONAL });
      eq(r.fretePrevisto, 7.75);
      eq(r.freteQualidade, null);
      eq(m.chamadas.filter((c) => !c.startsWith("/sites/") && !c.includes("shipping_options")).length, 0);
    });
  }
  eq(freteConfiavelHabilitado(SELLER, { FRETE_COTACAO_CONFIAVEL_SELLERS: "*" }), true);
  eq(freteConfiavelHabilitado(SELLER, { FRETE_COTACAO_CONFIAVEL_SELLERS: "1, 2433262404" }), true);
});

cenario("proximity sem envios/vendas: frete DESCONHECIDO (null + motivo), nunca 7,75", () => comEnv(SELLER, async () => {
  const { r } = await cotar({ ...PROBLEMA[0], tags: TAGS_PROX, cotacaoItem: FS_OPTIONAL, pedidos: [] });
  eq(r.fretePrevisto, null);
  eq(r.freteQualidade.nivel, NIVEIS.DESCONHECIDO);
  eq(r.diagnostico.frete.motivo, "frete_cotacao_nao_confiavel");
}));

cenario("dimensões discordantes entre envios (sem ≥2 iguais): não inventa medidas → desconhecido", () => comEnv(SELLER, async () => {
  const { r } = await cotar({ ...PROBLEMA[0], tags: TAGS_PROX, cotacaoItem: FS_OPTIONAL, pedidos: [{}, {}, {}],
    dimsPorEnvio: ["27x23x5,620", "30x20x6,500", "25x25x5,700"], custos: [16.85, 16.85, 20] });
  eq(r.fretePrevisto, null);
}));

cenario("sem dimensões mas ≥3 envios de item único comparáveis (preço ±3%, dispersão ≤10%): custo cobrado, confiança baixa", () => comEnv(SELLER, async () => {
  const { r } = await cotar({ ...PROBLEMA[0], tags: TAGS_PROX, cotacaoItem: FS_OPTIONAL, custos: [16.85, 16.85, 16.85, 16.15, 16.85] }, {}, { semDims: true });
  eq(r.fretePrevisto, 16.85);
  eq(r.freteQualidade.nivel, NIVEIS.CUSTO_COBRADO);
  eq(r.freteQualidade.confianca, "baixa");
  eq(r.freteQualidade.confirmado, false);
  eq(r.freteQualidade.amostras, 5);
  ok(r.freteQualidade.periodo.ate, "período");
}));

cenario("custo cobrado: preço de venda histórico fora de ±3% do atual ou dispersão >10% → desconhecido", () => comEnv(SELLER, async () => {
  const a = await cotar({ ...PROBLEMA[0], tags: TAGS_PROX, cotacaoItem: FS_OPTIONAL, custoReal: 16.85, custos: [16.85, 16.85, 16.85, 16.85, 16.85], precoVenda: 150 }, {}, { semDims: true });
  eq(a.r.fretePrevisto, null);
  const b = await cotar({ ...PROBLEMA[0], tags: TAGS_PROX, cotacaoItem: FS_OPTIONAL, custos: [10, 16.85, 20, 25, 16.85] }, {}, { semDims: true });
  eq(b.r.fretePrevisto, null);
}));

cenario("envios de múltiplos itens ou pack com outros pedidos não entram nas amostras", () => comEnv(SELLER, async () => {
  const multi = { order_items: [{ item: { id: "MLB6244198308" }, quantity: 1, unit_price: 108.8 }, { item: { id: "MLB1" }, quantity: 1, unit_price: 10 }] };
  const { r } = await cotar({ ...PROBLEMA[0], tags: TAGS_PROX, cotacaoItem: FS_OPTIONAL, pedidos: [multi, multi, { pack_id: 55 }, { pack_id: 56 }], packOrders: [{}, {}] });
  eq(r.fretePrevisto, null, "nenhuma amostra válida");
  eq(r.freteQualidade.amostrasEncontradas, 0);
}));

cenario("obterCotacaoAtual: desconhecido entra em faltantes ('frete') → margem não é calculada/gravada; estimado propaga freteQualidade", () => comEnv(SELLER, async () => {
  const m1 = mundo({ ...PROBLEMA[0], tags: TAGS_PROX, cotacaoItem: FS_OPTIONAL, pedidos: [] });
  const base = { clienteId: 133, itemId: "MLB6244198308", listingTypeId: "gold_special", categoryId: "MLB1", sellerId: SELLER, logisticType: "cross_docking", mlUserId: SELLER };
  const deps = (m) => ({ mlFetchFn: m.mlFetch, resolverPrecosItemFn: async () => ({ precoCheio: 119.9, precoPromocional: 108.8, precoEfetivo: 108.8, fonte: "sale_price", promotionIdAtivo: null }) });
  const c1 = await obterCotacaoAtual(base, deps(m1));
  ok(c1.faltantes.includes("frete") && c1.fretePrevisto === null);
  const m2 = mundo({ ...PROBLEMA[0], tags: TAGS_PROX, cotacaoItem: FS_OPTIONAL, pedidos: pedidos5 });
  const c2 = await obterCotacaoAtual(base, deps(m2));
  eq(c2.fretePrevisto, 16.85); eq(c2.freteQualidade.nivel, NIVEIS.DIMENSOES); ok(!c2.faltantes.includes("frete"));
}));

cenario("cotador em P' (Simular/Promoções): recota por dimensões em cada P', reaproveita envios; desconhecido bloqueia o cenário", () => comEnv(SELLER, async () => {
  const spec = { ...PROBLEMA[0], tags: TAGS_PROX, cotacaoItem: FS_OPTIONAL, pedidos: pedidos5 };
  const m = mundo(spec);
  const cot = criarCotadorEmP({
    clienteId: 133, itemId: spec.id, anuncio: { listing_type_id: "gold_special", category_id: "MLB1", logistic_type: "cross_docking" },
    sellerId: SELLER, mlUserId: SELLER, buscarComissaoEFrete, mlFetch: m.mlFetch,
  });
  const mapa = await cot.cotarVarios([108.8, 99.9]);
  const a = mapa.get("108.80");
  eq(a.frete, 16.85);
  eq(a.frete_qualidade.nivel, NIVEIS.DIMENSOES);
  ok(m.chamadas.filter((c) => c.startsWith("/orders")).length === 1, "envios históricos lidos 1x por MLB");
  const sem = mundo({ ...spec, pedidos: [] });
  const cot2 = criarCotadorEmP({
    clienteId: 133, itemId: spec.id, anuncio: { listing_type_id: "gold_special", category_id: "MLB1", logistic_type: "cross_docking" },
    sellerId: SELLER, mlUserId: SELLER, buscarComissaoEFrete, mlFetch: sem.mlFetch,
  });
  const b = await cot2.cotar(108.8);
  eq(b.frete, null);
  eq(b.motivos.frete, "frete_cotacao_nao_confiavel");
}));

(async () => {
  let falhas = 0;
  for (const { n, f } of casos) {
    try { await f(); console.log(`  ✓ ${n}`); } catch (e) { falhas += 1; console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n    ") : e}`); }
  }
  console.log(`\nfreteProximityConfiavel: ${casos.length - falhas}/${casos.length} cenários, ${checks} checks`);
  if (falhas) process.exit(1);
})();
