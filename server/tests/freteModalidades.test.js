// server/tests/freteModalidades.test.js
// P0 12/11/2026 — confiabilidade do frete por modalidade (Alianza Jeans 1 = conta 86,
// seller 1587129755; Alianza Jeans 2 = conta 87, seller 2433262404).
// Valores reais em ~/venforce-backups/handoffs/frete_modalidades_2026-11-12:
//  - MLB4445939340 (conta 86, "Envios Agora" = tag proximity): item_id → 7,75 (none, taxa 0)
//    em QUALQUER preço; dimensões declaradas 28x23x4,324 → 13,85 (mandatory 0,5) de 79 a 99,99;
//    abaixo de R$ 79 o ML cobra a faixa < 79 (8,25, mandatory 0,3) — só se a URL NÃO forçar
//    free_shipping=true (forçando devolvia 13,85).
//  - Controle MLB7699058364 (sem proximity): item_id 14,45 (≥79) / 8,45 (<79, mandatory 0,3).
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://nobody@127.0.0.1:1/teste-sem-banco";
const assert = require("assert");
const { buscarComissaoEFrete } = require("../services/shared/marketplaceCurrentQuoteService");
const { NIVEIS } = require("../services/shared/freteCotacaoConfiavel");

const S86 = "1587129755";
const S87 = "2433262404";
let checks = 0;
const casos = [];
const cenario = (n, f) => casos.push({ n, f });
const ok = (c, m) => { assert.ok(c, m); checks += 1; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks += 1; };

const TAGS_PROX = ["self_service_in", "mandatory_free_shipping", "proximity"];
const TAGS_CTRL = ["self_service_in", "mandatory_free_shipping"];
const NONE = (v = 7.75) => ({ list_cost: v, billable_weight: 430, discount: { rate: 0, type: "none", promoted_amount: v } });
const MANDATORY = (v, rate = 0.5) => ({ list_cost: v, billable_weight: 430, discount: { rate, type: "mandatory", promoted_amount: v / (1 - rate) } });

// Tabela do ML medida (12/11) para 28x23x4,324 / gold_special: ≥79 → 13,85; <79 → 8,25 (sem
// free_shipping forçado) ou 13,85 (forçado).
function tabelaDimensoes(preco, forcado) {
  if (preco >= 79 || forcado) return MANDATORY(13.85);
  return MANDATORY(8.25, 0.3);
}

/**
 * Mundo ML de UM anúncio.
 * spec: { id, seller, tags, cotacaoItem(preco)→all_country, dims (declaradas "AxLxC,P" | null),
 *         unidades {dim, peso}, pedidos[], dimsPorEnvio[], custos[], logistica }
 */
function mundo(spec) {
  const chamadas = [];
  const envios = {};
  const pedidos = (spec.pedidos || []).map((p, i) => {
    const envioId = `${spec.id}-${i}`;
    envios[envioId] = { logistic_type: spec.logistica || "cross_docking", dimensions: spec.dimsPorEnvio ? spec.dimsPorEnvio[i] : null, custo: spec.custos ? spec.custos[i] : null };
    return { id: 100 + i, status: "paid", date_created: `2026-11-0${(i % 9) + 1}T10:00:00.000-04:00`, pack_id: null,
      order_items: [{ item: { id: spec.id }, quantity: 1, unit_price: spec.precoVenda || 99.9 }], shipping: { id: envioId }, ...(p || {}) };
  });
  function atributosDeclarados() {
    if (!spec.dims) return [];
    const [d, peso] = spec.dims.split(",");
    const [h, w, l] = d.split("x").map(Number);
    const u = spec.unidades || { dim: "cm", peso: "g" };
    const at = (id, n, unit) => ({ id, value_name: `${n} ${unit}`, values: [{ id: null, name: `${n} ${unit}`, struct: { number: n, unit } }] });
    const lista = [at("SELLER_PACKAGE_HEIGHT", h, u.dim), at("SELLER_PACKAGE_WIDTH", w, u.dim), at("SELLER_PACKAGE_LENGTH", l, u.dim), at("SELLER_PACKAGE_WEIGHT", Number(peso), u.peso)];
    return spec.semAtributo ? lista.filter((a) => a.id !== spec.semAtributo) : lista;
  }
  async function mlFetch(cid, path, opts = {}) {
    const p = String(path);
    chamadas.push({ p, mlUserId: opts.mlUserId || null });
    if (p.startsWith(`/items/${spec.id}?attributes=id,shipping`)) return { ok: true, status: 200, data: { id: spec.id, shipping: { tags: spec.tags } } };
    if (p.startsWith(`/items/${spec.id}?include_attributes=all`)) return { ok: true, status: 200, data: { id: spec.id, shipping: { tags: spec.tags }, attributes: atributosDeclarados() } };
    if (p.includes("/shipping_options/free")) {
      const preco = Number(new URLSearchParams(p.split("?")[1]).get("item_price"));
      if (p.includes("dimensions=")) {
        const dm = decodeURIComponent(p.match(/dimensions=([^&]+)/)[1]);
        const valida = spec.dimsCotaveis ? spec.dimsCotaveis.includes(dm) : dm === spec.dimsNormalizadas || dm === spec.dims;
        if (!valida) return { ok: true, status: 200, data: { coverage: { all_country: NONE() } } };
        return { ok: true, status: 200, data: { coverage: { all_country: (spec.tabela || tabelaDimensoes)(preco, p.includes("free_shipping=true")) } } };
      }
      return { ok: true, status: 200, data: { coverage: { all_country: spec.cotacaoItem(preco) } } };
    }
    if (p.startsWith("/sites/MLB/listing_prices")) {
      const preco = Number(new URLSearchParams(p.split("?")[1]).get("price"));
      return { ok: true, status: 200, data: { sale_fee_amount: Math.round(preco * 0.14 * 100) / 100, sale_fee_details: { percentage_fee: 14 } } };
    }
    if (p.startsWith("/orders/search")) return { ok: true, status: 200, data: { results: pedidos } };
    const sh = p.match(/^\/shipments\/([^/?]+)(\/costs)?/);
    if (sh) {
      const e = envios[sh[1]];
      if (!e) return { ok: false, status: 404 };
      if (sh[2]) return { ok: true, status: 200, data: { senders: [{ user_id: Number(spec.seller), cost: e.custo }] } };
      const [h, w, l, pe] = e.dimensions ? e.dimensions.replace(",", "x").split("x").map(Number) : [];
      return { ok: true, status: 200, data: { logistic_type: e.logistic_type, dimensions: e.dimensions ? { height: h, width: w, length: l, weight: pe } : null } };
    }
    if (p.startsWith("/packs/")) return { ok: true, status: 200, data: { orders: [{}] } };
    return { ok: false, status: 404 };
  }
  return { mlFetch, chamadas };
}

function comEnv(valor, fn) {
  const ant = process.env.FRETE_COTACAO_CONFIAVEL_SELLERS;
  if (valor === undefined) delete process.env.FRETE_COTACAO_CONFIAVEL_SELLERS; else process.env.FRETE_COTACAO_CONFIAVEL_SELLERS = valor;
  return Promise.resolve().then(fn).finally(() => { if (ant === undefined) delete process.env.FRETE_COTACAO_CONFIAVEL_SELLERS; else process.env.FRETE_COTACAO_CONFIAVEL_SELLERS = ant; });
}

async function cotar(spec, preco, extra = {}) {
  const m = mundo(spec);
  const r = await buscarComissaoEFrete({
    clienteId: 133, itemId: spec.id, precoEfetivo: preco, listingTypeId: spec.listing || "gold_special",
    categoryId: "MLB1", sellerId: spec.seller, logisticType: spec.logistica || "cross_docking", mlUserId: spec.seller,
    shippingTags: spec.passarTags ? spec.tags : null, ...extra,
  }, m.mlFetch);
  return { r, m };
}

// Envios históricos concordantes (passo 1 do hotfix) para o mesmo anúncio da conta 86.
const HIST_86 = { id: "MLB4445939340", seller: S86, tags: TAGS_PROX, cotacaoItem: () => NONE(),
  pedidos: [{}, {}, {}], dimsPorEnvio: ["28x23x4,324", "28x23x4,324", "28x23x4,324"], dimsCotaveis: ["28x23x4,324"] };

cenario("dimensões históricas abaixo de R$ 79: cota a faixa < 79 do ML (8,25), não força free_shipping (13,85)", () => comEnv(S86, async () => {
  const { r, m } = await cotar(HIST_86, 78.99);
  eq(r.fretePrevisto, 8.25);
  eq(r.freteQualidade.nivel, NIVEIS.DIMENSOES);
  ok(m.chamadas.filter((c) => c.p.includes("dimensions=")).every((c) => !c.p.includes("free_shipping=true")), "URL sem free_shipping forçado");
}));

cenario("dimensões históricas de R$ 79 para cima: valor inalterado (13,85 em 82,29 e 79,00)", () => comEnv(S86, async () => {
  for (const p of [82.29, 79]) eq((await cotar(HIST_86, p)).r.fretePrevisto, 13.85);
}));

(async () => {
  let falhas = 0;
  for (const { n, f } of casos) {
    try { await f(); console.log(`  ✓ ${n}`); } catch (e) { falhas += 1; console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n    ") : e}`); }
  }
  console.log(`\nfreteModalidades: ${casos.length - falhas}/${casos.length} cenários, ${checks} checks`);
  if (falhas) process.exit(1);
})();
