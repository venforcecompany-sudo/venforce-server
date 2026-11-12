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
    return { id: 100 + i, status: "paid", date_created: spec.dataPedidos || new Date(Date.now() - ((i % 9) + 1) * 86400000).toISOString(), pack_id: null,
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
        return { ok: true, status: 200, data: { coverage: { all_country: (spec.tabela || tabelaDimensoes)(preco, p.includes("free_shipping=true"), dm) } } };
      }
      return { ok: true, status: 200, data: { coverage: { all_country: spec.cotacaoItem(preco) } } };
    }
    if (p.startsWith("/sites/MLB/listing_prices")) {
      const preco = Number(new URLSearchParams(p.split("?")[1]).get("price"));
      return { ok: true, status: 200, data: { sale_fee_amount: Math.round(preco * 0.14 * 100) / 100, sale_fee_details: { percentage_fee: 14 } } };
    }
    if (p.startsWith("/orders/search")) return spec.falhaPedidos || { ok: true, status: 200, data: { results: pedidos } };
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

// ── Passo 4: dimensões de embalagem declaradas (SELLER_PACKAGE_*) ────────────
// Caso do Fernando (conta 86): sem nenhuma venda, "Envios Agora" (proximity), 7,75 no item_id.
const FERNANDO = { id: "MLB4445939340", seller: S86, tags: TAGS_PROX, cotacaoItem: () => NONE(), dims: "28x23x4,324", pedidos: [] };

cenario("conta 86 — MLB4445939340 sem vendas: 7,75 rejeitado, declaradas 28x23x4,324 → 13,85 em 84,90 e em 82,29", () => comEnv(S86, async () => {
  for (const p of [84.9, 82.29]) {
    const { r, m } = await cotar(FERNANDO, p);
    eq(r.fretePrevisto, 13.85, `P=${p}`);
    eq(r.freteQualidade.nivel, NIVEIS.DECLARADAS);
    eq(r.freteQualidade.confirmado, false);
    eq(r.freteQualidade.confianca, "media");
    eq(r.freteQualidade.dimensions, "28x23x4,324");
    eq(r.freteQualidade.cotacaoRejeitada, 7.75);
    eq(r.diagnostico.frete.motivo, null);
    ok(m.chamadas.every((c) => c.mlUserId === S86), "toda leitura com o token da conta 86");
  }
}));

cenario("declaradas abaixo de R$ 79: faixa < 79 do ML (8,25), nunca 7,75 nem 13,85", () => comEnv(S86, async () => {
  eq((await cotar(FERNANDO, 78.99)).r.fretePrevisto, 8.25);
}));

cenario("declaradas em kg/mm são convertidas; unidade desconhecida ou medida faltando → desconhecido", () => comEnv(S86, async () => {
  const kg = await cotar({ ...FERNANDO, dims: "280x230x40,0.324", dimsNormalizadas: "28x23x4,324", unidades: { dim: "mm", peso: "kg" } }, 84.9);
  eq(kg.r.fretePrevisto, 13.85);
  eq(kg.r.freteQualidade.dimensions, "28x23x4,324");
  const pol = await cotar({ ...FERNANDO, unidades: { dim: "in", peso: "g" } }, 84.9);
  eq(pol.r.fretePrevisto, null);
  eq(pol.r.diagnostico.frete.motivo, "frete_cotacao_nao_confiavel");
  const falta = await cotar({ ...FERNANDO, semAtributo: "SELLER_PACKAGE_WEIGHT" }, 84.9);
  eq(falta.r.fretePrevisto, null);
  eq(falta.r.freteQualidade.nivel, NIVEIS.DESCONHECIDO);
}));

cenario("declaradas cuja cotação não volta com desconto obrigatório → desconhecido (não aceita 7,75 por outro caminho)", () => comEnv(S86, async () => {
  const { r } = await cotar({ ...FERNANDO, tabela: () => NONE() }, 84.9);
  eq(r.fretePrevisto, null);
  eq(r.freteQualidade.nivel, NIVEIS.DESCONHECIDO);
}));

cenario("ordem preservada: com envios históricos concordantes vale o passo 1 (não lê os atributos)", () => comEnv(S86, async () => {
  const { r, m } = await cotar({ ...HIST_86, dims: "99x99x99,9999" }, 84.9);
  eq(r.freteQualidade.nivel, NIVEIS.DIMENSOES);
  eq(r.freteQualidade.dimensions, "28x23x4,324");
  ok(!m.chamadas.some((c) => c.p.includes("include_attributes")), "atributos só depois dos passos com envios reais");
}));

// ── Histórico antigo (MLB5872175430: envios de dez/2025 → 14,45; declaradas hoje → 13,85) ──
// Fixture SIMULADO no formato do caso real: a tabela devolve 14,45 para a medida antiga e 13,85
// para a declarada. Não há venda recente que diga qual o ML cobraria.
const ANTIGO = { id: "MLB5872175430", seller: S86, tags: TAGS_PROX, cotacaoItem: () => NONE(), dataPedidos: "2025-12-10T10:00:00.000-04:00",
  pedidos: [{}, {}, {}], dimsPorEnvio: ["30x23x5,530", "30x23x5,530", "30x23x5,530"], dims: "28x23x4,324", dimsCotaveis: ["30x23x5,530", "28x23x4,324"],
  tabela: (preco, forcado, dm) => MANDATORY(dm === "30x23x5,530" ? 14.45 : 13.85) };

cenario("histórico antigo (> 90 dias) não prevalece: a medida declarada hoje passa na frente e o histórico fica registrado", () => comEnv(S86, async () => {
  const { r } = await cotar(ANTIGO, 99.9);
  eq(r.fretePrevisto, 13.85);
  eq(r.freteQualidade.nivel, NIVEIS.DECLARADAS);
  eq(r.freteQualidade.historicoAntigo.amostras, 3);
  ok(String(r.freteQualidade.historicoAntigo.periodo.ate).startsWith("2025-12-10"), "período do histórico preterido fica auditável");
}));

cenario("histórico antigo sem medida declarada: ainda é usado, mas com confiança baixa e marcado", () => comEnv(S86, async () => {
  const { r } = await cotar({ ...ANTIGO, dims: null }, 99.9);
  eq(r.fretePrevisto, 14.45);
  eq(r.freteQualidade.nivel, NIVEIS.DIMENSOES);
  eq(r.freteQualidade.confianca, "baixa");
  eq(r.freteQualidade.historicoAntigo, true);
}));

cenario("histórico recente continua em primeiro lugar mesmo com medida declarada diferente", () => comEnv(S86, async () => {
  const { r, m } = await cotar({ ...ANTIGO, dataPedidos: undefined }, 99.9);
  eq(r.fretePrevisto, 14.45);
  eq(r.freteQualidade.nivel, NIVEIS.DIMENSOES);
  eq(r.freteQualidade.confianca, "media");
  ok(!("historicoAntigo" in r.freteQualidade));
  ok(!m.chamadas.some((c) => c.p.includes("include_attributes")), "sem leitura extra");
}));

cenario("429 na leitura dos envios: não inventa nem repete em rajada — usa a medida declarada; sem ela, desconhecido com a falha registrada", () => comEnv(S86, async () => {
  const falha = { ok: false, status: 429, data: null, retryAfter: 60 };
  const a = await cotar({ ...HIST_86, dims: "28x23x4,324", falhaPedidos: falha }, 84.9);
  eq([a.r.fretePrevisto, a.r.freteQualidade.nivel], [13.85, NIVEIS.DECLARADAS]);
  eq(a.m.chamadas.filter((c) => c.p.startsWith("/orders/search")).length, 1, "uma tentativa, sem retry");
  const b = await cotar({ ...HIST_86, falhaPedidos: falha }, 84.9);
  eq([b.r.fretePrevisto, b.r.freteQualidade.nivel, b.r.freteQualidade.historicoNaoLido], [null, NIVEIS.DESCONHECIDO, 429]);
  eq(b.r.diagnostico.frete.motivo, "frete_cotacao_nao_confiavel");
}));

// Revisão independente (12/11): uma venda recente NÃO pode reabilitar 2 envios antigos que concordam entre si.
cenario("histórico misto: 2 envios antigos concordantes + 1 recente diferente → vale só o recente/declarada, nunca a medida antiga", () => comEnv(S86, async () => {
  const antigo = "2025-01-10T10:00:00.000-04:00";
  const spec = { ...HIST_86, dims: "28x23x4,324", pedidos: [{ date_created: antigo }, { date_created: antigo }, {}],
    dimsPorEnvio: ["10x10x10,500", "10x10x10,500", "20x20x20,900"], dimsCotaveis: ["10x10x10,500", "20x20x20,900", "28x23x4,324"],
    tabela: (preco, f, dm) => MANDATORY(dm === "10x10x10,500" ? 8.25 : 13.85) };
  const { r } = await cotar(spec, 99.9);
  ok(r.freteQualidade.dimensions !== "10x10x10,500", "medida antiga não prevalece");
  eq(r.fretePrevisto, 13.85);
  eq(r.freteQualidade.nivel, NIVEIS.DECLARADAS, "1 recente não concorda com nada: cai na declarada");
}));

cenario("custo cobrado: 1 leitura de /shipments/{id}/costs por envio, mesmo cotando vários preços; amostra sem logística não entra", () => comEnv(S86, async () => {
  const spec = { id: "MLB5", seller: S86, tags: TAGS_PROX, cotacaoItem: () => NONE(), precoVenda: 99.9, pedidos: [{}, {}, {}, {}],
    dimsPorEnvio: [null, null, null, null], custos: [14.45, 14.45, 14.45, 14.45] };
  const m = mundo(spec);
  const memo = {};
  for (const preco of [99.9, 99.5, 100.2]) {
    const r = await buscarComissaoEFrete({ clienteId: 133, itemId: spec.id, precoEfetivo: preco, listingTypeId: "gold_special", categoryId: "MLB1",
      sellerId: S86, logisticType: "cross_docking", mlUserId: S86, shippingTags: TAGS_PROX, memoFrete: memo }, m.mlFetch);
    eq([r.fretePrevisto, r.freteQualidade.nivel], [14.45, NIVEIS.CUSTO_COBRADO]);
  }
  eq(m.chamadas.filter((c) => /\/shipments\/[^/]+\/costs/.test(c.p)).length, 4, "4 envios = 4 leituras, não 12");
  const semLog = mundo({ ...spec, id: "MLB6", pedidos: [{}, {}, {}, {}], dimsPorEnvio: [null, null, null, null] });
  const orig = semLog.mlFetch;
  const r2 = await buscarComissaoEFrete({ clienteId: 133, itemId: "MLB6", precoEfetivo: 99.9, listingTypeId: "gold_special", categoryId: "MLB1",
    sellerId: S86, logisticType: "cross_docking", mlUserId: S86, shippingTags: TAGS_PROX },
  async (c, p, o) => { const x = await orig(c, p, o); if (/^\/shipments\/[^/?]+$/.test(String(p)) && x.data) x.data.logistic_type = null; return x; });
  eq(r2.fretePrevisto, null, "sem logística conhecida nas amostras, o custo cobrado não é comparável");
}));

// Descontos: 50% (coleta ≥ 79) e 30% (< 79) e 10% (Flex) são MEDIDOS nas contas 86/87. 40% (reputação) NÃO
// apareceu em nenhuma das 286 vendas: o caso abaixo é SIMULADO, só para travar que a taxa nunca é presumida.
cenario("desconto vem da resposta do ML, nunca presumido: 50%, 40% (simulado), 30% e 10% aceitos como vieram; taxa 0 ou tipo não obrigatório, não", () => comEnv(S86, async () => {
  for (const [rate, valor] of [[0.5, 13.85], [0.4, 16.62], [0.3, 8.25], [0.1, 9.8]]) {
    const direto = await cotar({ id: "MLB3", seller: S86, tags: TAGS_PROX, passarTags: true, cotacaoItem: () => MANDATORY(valor, rate) }, 99.9);
    eq([direto.r.fretePrevisto, direto.r.freteQualidade.nivel], [valor, NIVEIS.COTADO], `item_id mandatory ${rate}: confiável mesmo com proximity`);
    eq(direto.m.chamadas.filter((c) => c.p.includes("shipping_options")).length, 1, "sem recotação");
    const porDims = await cotar({ ...FERNANDO, tabela: () => MANDATORY(valor, rate) }, 99.9);
    eq(porDims.r.fretePrevisto, valor, `dimensões mandatory ${rate}: valor da resposta, sem ajuste`);
  }
  for (const all of [MANDATORY(13.85, 0), { list_cost: 13.85, discount: { rate: 0.5, type: "fs_optional", promoted_amount: 13.85 } }, { list_cost: 13.85 }]) {
    const r = (await cotar({ ...FERNANDO, tabela: () => all }, 99.9)).r;
    eq([r.fretePrevisto, r.freteQualidade.nivel], [null, NIVEIS.DESCONHECIDO], "resposta sem desconto obrigatório não vira frete");
  }
}));

cenario("resumoDoFrete: contrato único de leitura (estimado ≠ confirmado; desconhecido sem valor; Flex fora da margem; seller não avaliado)", () => comEnv(S86, async () => {
  const { resumoDoFrete } = require("../services/shared/freteCotacaoConfiavel");
  const est = await cotar({ ...FERNANDO, passarTags: true }, 84.9);
  const a = resumoDoFrete({ fretePrevisto: est.r.fretePrevisto, freteQualidade: est.r.freteQualidade });
  eq([a.valor, a.avaliado, a.estimado, a.confirmado, a.confianca, a.cotacaoRejeitada], [13.85, true, true, false, "media", 7.75]);
  eq(a.custosForaDaMargem, ["entregador_flex"]);
  ok(/ESTIMADO/.test(a.texto) && /7,75/.test(a.texto) && /Flex/.test(a.texto), a.texto);
  const desc = await cotar({ ...FERNANDO, dims: null }, 84.9);
  const b = resumoDoFrete({ fretePrevisto: desc.r.fretePrevisto, freteQualidade: desc.r.freteQualidade, motivo: desc.r.diagnostico.frete.motivo });
  eq([b.valor, b.estimado, b.motivo, b.nivel], [null, false, "frete_cotacao_nao_confiavel", NIVEIS.DESCONHECIDO]);
  const ctrl = await cotar({ id: "MLB2", seller: S86, tags: TAGS_CTRL, passarTags: true, cotacaoItem: () => MANDATORY(14.45) }, 99.9);
  const c = resumoDoFrete({ fretePrevisto: ctrl.r.fretePrevisto, freteQualidade: ctrl.r.freteQualidade });
  eq([c.valor, c.estimado, c.confirmado, c.nivel, c.cotacaoRejeitada], [14.45, false, false, NIVEIS.COTADO, null]);
  const fora = resumoDoFrete({ fretePrevisto: 7.75, freteQualidade: null });
  eq([fora.valor, fora.avaliado, fora.nivel, fora.texto], [7.75, false, null, null]);
  const falha = resumoDoFrete({ fretePrevisto: null, freteQualidade: null, motivo: "ml_rate_limit" });
  eq([falha.valor, falha.motivo], [null, "ml_rate_limit"]);
}));

cenario("cotação confiável (mandatory) nunca chega ao passo 4: controle e Full ficam iguais, sem GET extra", () => comEnv(`${S86},${S87}`, async () => {
  const ctrl = { id: "MLB7699058364", seller: S86, tags: TAGS_CTRL, dims: "27x23x4,548", cotacaoItem: (p) => (p >= 79 ? MANDATORY(14.45) : MANDATORY(8.45, 0.3)) };
  for (const [p, v] of [[104.92, 14.45], [82.29, 14.45], [78.99, 8.45]]) {
    const { r, m } = await cotar(ctrl, p);
    eq(r.fretePrevisto, v, `controle P=${p}`);
    eq(r.freteQualidade.nivel, NIVEIS.COTADO);
    ok(!m.chamadas.some((c) => c.p.startsWith("/items/") || c.p.startsWith("/orders")), "sem leitura extra");
  }
  // Full (MLB7722083152): item_id 19,05 mandatory (cobrado 14,45 em 88,99 = item_id em 88,99). As declaradas do
  // anúncio Full são MAIORES que as medidas do CD (billable 3168 x 510): nunca podem substituir a cotação.
  const full = { id: "MLB7722083152", seller: S86, tags: TAGS_CTRL, logistica: "fulfillment", dims: "40x40x10,3168", cotacaoItem: (p) => (p >= 100 ? MANDATORY(19.05) : MANDATORY(14.45)) };
  const f = await cotar(full, 137.33);
  eq(f.r.fretePrevisto, 19.05);
  eq(f.r.freteQualidade.nivel, NIVEIS.COTADO);
}));

cenario("conta 87 — casos proximity comprovados continuam iguais (envios históricos) e MLB7892951136 sai de desconhecido", () => comEnv(S87, async () => {
  const comprovados = [
    { id: "MLB6244198308", preco: 108.8, dims: "27x23x5,620", custo: 16.85 },
    { id: "MLB4113911709", preco: 99.9, dims: "28x24x4,430", custo: 13.85 },
    { id: "MLB4161792499", preco: 94.99, dims: "36x26x6,300", custo: 14.45 },
  ];
  for (const c of comprovados) {
    const spec = { id: c.id, seller: S87, tags: TAGS_PROX, cotacaoItem: () => NONE(), precoVenda: c.preco, pedidos: [{}, {}, {}],
      dimsPorEnvio: [c.dims, c.dims, c.dims], dimsCotaveis: [c.dims], tabela: () => MANDATORY(c.custo) };
    const { r } = await cotar(spec, c.preco);
    eq(r.fretePrevisto, c.custo, c.id);
    eq(r.freteQualidade.nivel, NIVEIS.DIMENSOES, c.id);
  }
  const m136 = { id: "MLB7892951136", seller: S87, tags: TAGS_PROX, cotacaoItem: () => NONE(), dims: "10x25x35,700", tabela: () => MANDATORY(21.75), pedidos: [] };
  const { r } = await cotar(m136, 169.66);
  eq(r.fretePrevisto, 21.75);
  eq(r.freteQualidade.nivel, NIVEIS.DECLARADAS);
}));

cenario("modalidade rastreável: Flex/Envios Agora sinalizados, custo do entregador Flex fora da margem; Full/coleta sem Flex não", () => comEnv(S86, async () => {
  const prox = await cotar({ ...FERNANDO, passarTags: true }, 84.9);
  eq(prox.r.freteQualidade.modalidade, { logistica: "cross_docking", flexHabilitado: true, enviosAgora: true, custosForaDaMargem: ["entregador_flex"] });
  const full = await cotar({ id: "MLB1", seller: S86, tags: ["mandatory_free_shipping"], passarTags: true, logistica: "fulfillment", cotacaoItem: () => MANDATORY(19.05) }, 137.33);
  eq(full.r.fretePrevisto, 19.05, "Full mantém a cotação");
  eq(full.r.freteQualidade.modalidade, { logistica: "fulfillment", flexHabilitado: false, enviosAgora: false, custosForaDaMargem: [] });
  const semTags = await cotar({ id: "MLB2", seller: S86, tags: TAGS_CTRL, cotacaoItem: () => MANDATORY(14.45) }, 99.9);
  eq(semTags.r.freteQualidade.modalidade.flexHabilitado, null, "tags não lidas = desconhecido, nunca 'não'");
}));

cenario("seller fora de FRETE_COTACAO_CONFIAVEL_SELLERS: comportamento antigo (7,75, sem avaliação) — liberação continua por seller", () => comEnv(S87, async () => {
  const { r, m } = await cotar(FERNANDO, 84.9);
  eq(r.fretePrevisto, 7.75);
  eq(r.freteQualidade, null);
  ok(!m.chamadas.some((c) => c.p.startsWith("/items/")), "nenhuma leitura extra");
}));

(async () => {
  let falhas = 0;
  for (const { n, f } of casos) {
    try { await f(); console.log(`  ✓ ${n}`); } catch (e) { falhas += 1; console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n    ") : e}`); }
  }
  console.log(`\nfreteModalidades: ${casos.length - falhas}/${casos.length} cenários, ${checks} checks`);
  if (falhas) process.exit(1);
})();
