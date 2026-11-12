// server/tests/freteConsumidoresAutomacoes.test.js
// P0 12/11/2026 — Automações (preview-ml), Diagnóstico e planilhas usam a MESMA cotação de
// comissão/frete da Central (shared/marketplaceCurrentQuoteService). Antes cada um consultava o
// ML por conta própria e exibia o frete de item_id (7,75 nos anúncios `proximity`) como válido.
// Fixtures SIMULADOS no formato real (handoff frete_modalidades_2026-11-12): MLB4445939340
// (conta 86) item_id 7,75 none; medidas declaradas 28x23x4,324 → 13,85 mandatory 0,5.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://nobody@127.0.0.1:1/teste-sem-banco";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let checks = 0;
const casos = [];
const cenario = (n, f) => casos.push({ n, f });
const ok = (c, m) => { assert.ok(c, m); checks += 1; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks += 1; };

const S86 = "1587129755";
const S87 = "2433262404";
const TAGS_PROX = ["self_service_in", "mandatory_free_shipping", "proximity"];
const NONE = { list_cost: 7.75, billable_weight: 430, discount: { rate: 0, type: "none", promoted_amount: 7.75 } };
const MAND = (v, rate = 0.5) => ({ list_cost: v, billable_weight: 430, discount: { rate, type: "mandatory", promoted_amount: v } });

// ── Mundo: stubs injetados no cache de módulos ANTES de carregar os serviços ──
const mundo = { itens: {}, custos: [], chamadas: [], falhaFrete: null, contexto: null };
function stub(rel, exportsObj) {
  const abs = require.resolve(rel);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
}
stub("../config/database", { query: async (sql) => (/FROM custos/.test(sql) ? { rows: mundo.custos } : { rows: [] }) });
stub("../services/automacoes/precoItemService", {
  resolverPrecosItem: async ({ itemId }) => {
    const it = mundo.itens[itemId];
    return { precoCheio: it.preco, precoPromocional: null, precoEfetivo: it.preco, fonte: "sale_price", promotionIdAtivo: null };
  },
});
stub("../services/automacoes/contextoPrecificacaoService", {
  exigirContextoPronto: async () => mundo.contexto,
  criarErroHttp: (status, payload) => Object.assign(new Error(payload && payload.erro), { statusCode: status, payload }),
});
function atributos(dims) {
  if (!dims) return [];
  const [d, peso] = dims.split(",");
  const [h, w, l] = d.split("x").map(Number);
  const at = (id, n, unit) => ({ id, values: [{ struct: { number: n, unit } }] });
  return [at("SELLER_PACKAGE_HEIGHT", h, "cm"), at("SELLER_PACKAGE_WIDTH", w, "cm"), at("SELLER_PACKAGE_LENGTH", l, "cm"), at("SELLER_PACKAGE_WEIGHT", Number(peso), "g")];
}
async function mlFetch(clienteId, caminho, opts = {}) {
  const p = String(caminho);
  mundo.chamadas.push({ p, mlUserId: opts.mlUserId || null, method: opts.method || "GET" });
  if (p.includes("/items/search")) return { ok: true, status: 200, data: { paging: { total: Object.keys(mundo.itens).length }, results: Object.keys(mundo.itens) } };
  if (p.startsWith("/items?ids=")) {
    return { ok: true, status: 200, data: p.split("=")[1].split(",").map((id) => ({ code: 200, body: corpo(id) })) };
  }
  const unico = p.match(/^\/items\/([^?]+)\?/);
  if (unico) {
    const it = mundo.itens[unico[1]];
    return { ok: true, status: 200, data: { id: unico[1], shipping: { tags: it.tags }, attributes: atributos(it.dims) } };
  }
  if (p.startsWith("/sites/MLB/listing_prices")) {
    const preco = Number(new URLSearchParams(p.split("?")[1]).get("price"));
    return { ok: true, status: 200, data: { sale_fee_amount: Math.round(preco * 14) / 100, sale_fee_details: { percentage_fee: 14 } } };
  }
  if (p.includes("/shipping_options/free")) {
    if (mundo.falhaFrete) return mundo.falhaFrete;
    const q = new URLSearchParams(p.split("?")[1]);
    const seller = p.match(/^\/users\/(\d+)\//)[1];
    if (String(opts.mlUserId) !== seller) return { ok: false, status: 403, data: { error: "access_denied" } };
    if (q.get("dimensions")) return { ok: true, status: 200, data: { coverage: { all_country: MAND(13.85) } } };
    return { ok: true, status: 200, data: { coverage: { all_country: mundo.itens[q.get("item_id")].cotacaoItem } } };
  }
  if (p.startsWith("/orders/search")) return { ok: true, status: 200, data: { results: [] } };
  return { ok: false, status: 404, data: null };
}
stub("../utils/mlClient", { mlFetch });
function corpo(id) {
  const it = mundo.itens[id];
  return { id, title: `Anúncio ${id}`, status: "active", price: it.preco, listing_type_id: "gold_special", category_id: "MLB1",
    seller_id: Number(it.seller), shipping: { logistic_type: it.logistica || "cross_docking", tags: it.tags } };
}

const { gerarPreviewPrecificacaoMl } = require("../services/automacoes/precificacaoService");
const { diagEnriquecerItem } = require("../services/automacoes/diagnosticoService");
const { buscarComissaoEFrete, obterCotacaoAtual } = require("../services/shared/marketplaceCurrentQuoteService");
const { criarCotadorEmP } = require("../services/motorMargem/margemCotacaoEmP");

function montar({ seller = S86, itens, env }) {
  mundo.itens = itens; mundo.chamadas = []; mundo.falhaFrete = null;
  mundo.custos = Object.keys(itens).map((id) => ({ produto_id: id, custo_produto: 40, imposto_percentual: 13, taxa_fixa: 0 }));
  mundo.contexto = { cliente: { id: 133, slug: "alianza", nome: "Alianza" }, base: { id: 1, slug: "b", nome: "B", ativo: true }, mlUserId: seller };
  if (env === undefined) delete process.env.FRETE_COTACAO_CONFIAVEL_SELLERS; else process.env.FRETE_COTACAO_CONFIAVEL_SELLERS = env;
}
const FERNANDO = { preco: 84.9, seller: S86, tags: TAGS_PROX, cotacaoItem: NONE, dims: "28x23x4,324" };
const SEM_MEDIDAS = { ...FERNANDO, dims: null };
const BASE_ROW = { custoProduto: 40, impostoPercentual: 13, taxaFixa: 0 };
const r2 = (n) => Math.round(n * 100) / 100;

cenario("preview-ml (seller liberado): frete estimado 13,85 no lugar de 7,75; lucro e preço alvo usam o frete corrigido", async () => {
  montar({ itens: { MLB4445939340: FERNANDO }, env: S86 });
  const out = await gerarPreviewPrecificacaoMl({ clienteSlugRaw: "alianza", margemAlvoRaw: "0.15" });
  const l = out.linhas[0];
  eq(l.frete, 13.85);
  eq(l.comissaoMarketplace, 11.89);
  eq(l.comissaoPercentual, 14, "percentual na escala 0–100 de sempre");
  eq(r2(l.lucroContribuicao), r2(84.9 - 84.9 * 0.13 - 11.89 - 13.85 - 40));
  eq(r2(l.precoAlvo), r2((40 + 13.85) / (1 - 0.13 - 0.14 - 0.15)));
  eq([l.freteDetalhe.estimado, l.freteDetalhe.confirmado, l.freteDetalhe.cotacaoRejeitada], [true, false, 7.75]);
  ok(l.observacoes.some((o) => /ESTIMADO/.test(o) && /Flex/.test(o)), "observação diz que é estimado e que o Flex fica fora");
  ok(!mundo.chamadas.some((c) => c.p.includes("?attributes=id,shipping")), "tags vêm do multiget: sem GET extra de tags");
});

cenario("preview-ml (seller liberado, sem medidas): frete desconhecido → sem lucro, sem margem, SEM preço alvo", async () => {
  montar({ itens: { MLB1: SEM_MEDIDAS }, env: S86 });
  const l = (await gerarPreviewPrecificacaoMl({ clienteSlugRaw: "alianza", margemAlvoRaw: "0.15" })).linhas[0];
  eq([l.frete, l.lucroContribuicao, l.margemContribuicao, l.precoAlvo, l.lucroAlvo], [null, null, null, null, null]);
  eq(l.freteDetalhe.motivo, "frete_cotacao_nao_confiavel");
  ok(l.observacoes.some((o) => /DESCONHECIDO/.test(o)), "motivo interpretável");
});

cenario("seller NÃO liberado: nada muda (7,75, mesmas 2 consultas por item, sem avaliação) — liberação continua por seller", async () => {
  montar({ itens: { MLB1: FERNANDO }, env: S87 });
  const l = (await gerarPreviewPrecificacaoMl({ clienteSlugRaw: "alianza", margemAlvoRaw: "0.15" })).linhas[0];
  eq(l.frete, 7.75);
  eq([l.freteDetalhe.avaliado, l.freteDetalhe.texto], [false, null]);
  eq(l.observacoes, []);
  const cotacoes = mundo.chamadas.filter((c) => c.p.includes("listing_prices") || c.p.includes("shipping_options"));
  eq(cotacoes.map((c) => c.p), [
    "/sites/MLB/listing_prices?price=84.9&listing_type_id=gold_special&category_id=MLB1",
    `/users/${S86}/shipping_options/free?item_id=MLB1&verbose=true&item_price=84.9&listing_type_id=gold_special&mode=me2`,
  ], "URLs idênticas às do código anterior");
  const d = await diagEnriquecerItem({ clienteId: 133, body: corpo("MLB1"), baseRow: BASE_ROW, margemAlvo: 0.15, mlUserId: S86 });
  eq([d.frete, d.explicacao_calculo, d.diagnostico], [7.75, null, "saudavel"]);
});

for (const [nome, falha] of [["429", { ok: false, status: 429, data: null, retryAfter: 30 }], ["500", { ok: false, status: 500, data: null }], ["403", { ok: false, status: 403, data: null }], ["resposta parcial", { ok: true, status: 200, data: { coverage: {} } }]]) {
  cenario(`falha de leitura do frete (${nome}) nunca vira frete zero: sem lucro e sem preço alvo, em preview e diagnóstico`, async () => {
    montar({ itens: { MLB1: FERNANDO }, env: S86 });
    mundo.falhaFrete = falha;
    const l = (await gerarPreviewPrecificacaoMl({ clienteSlugRaw: "alianza", margemAlvoRaw: "0.15" })).linhas[0];
    eq([l.frete, l.lucroContribuicao, l.precoAlvo], [null, null, null]);
    const d = await diagEnriquecerItem({ clienteId: 133, body: corpo("MLB1"), baseRow: BASE_ROW, margemAlvo: 0.15, mlUserId: S86 });
    eq([d.frete, d.lc, d.preco_alvo, d.diagnostico], [null, null, null, "sem_frete"]);
    ok(mundo.chamadas.filter((c) => c.p.includes("shipping_options")).length === 2, "uma tentativa por consumidor: sem retry agressivo");
  });
}

cenario("diagnóstico (seller liberado): frete estimado vai para explicacao_calculo (coluna já exportada em CSV/XLSX)", async () => {
  montar({ itens: { MLB4445939340: FERNANDO }, env: S86 });
  const d = await diagEnriquecerItem({ clienteId: 133, body: corpo("MLB4445939340"), baseRow: BASE_ROW, margemAlvo: 0.15, mlUserId: S86 });
  eq([d.frete, d.comissao, d.comissao_percentual], [13.85, 11.89, 14]);
  eq(r2(d.lc), 8.12, "mesmo lucro do Motor no caso real (84,90 → 8,12)");
  ok(/ESTIMADO/.test(d.explicacao_calculo) && /7,75/.test(d.explicacao_calculo), d.explicacao_calculo);
  eq(d.frete_detalhe.nivel, "estimado_dimensoes_declaradas");
});

cenario("diagnóstico (sem medidas): 'sem_frete' com ação específica; nunca recomenda preço", async () => {
  montar({ itens: { MLB1: SEM_MEDIDAS }, env: S86 });
  const d = await diagEnriquecerItem({ clienteId: 133, body: corpo("MLB1"), baseRow: BASE_ROW, margemAlvo: 0.15, mlUserId: S86 });
  eq([d.frete, d.lc, d.mc, d.preco_alvo, d.preco_sugerido, d.diagnostico], [null, null, null, null, null, "sem_frete"]);
  ok(/medidas da embalagem/.test(d.acao_recomendada) && !/Subir preço/.test(d.acao_recomendada), d.acao_recomendada);
});

cenario("MESMO anúncio, MESMO preço: preview-ml, diagnóstico, Motor (obterCotacaoAtual) e cotador em P' dão a mesma comissão e o mesmo frete", async () => {
  for (const env of [S86, undefined]) {
    montar({ itens: { MLB4445939340: FERNANDO }, env });
    const body = corpo("MLB4445939340");
    const prev = (await gerarPreviewPrecificacaoMl({ clienteSlugRaw: "alianza" })).linhas[0];
    const diag = await diagEnriquecerItem({ clienteId: 133, body, baseRow: BASE_ROW, margemAlvo: null, mlUserId: S86 });
    const motor = await obterCotacaoAtual({ clienteId: 133, itemId: body.id, listingTypeId: "gold_special", categoryId: "MLB1", sellerId: S86,
      logisticType: "cross_docking", mlUserId: S86, shippingTags: TAGS_PROX },
    { mlFetchFn: mlFetch, resolverPrecosItemFn: async () => ({ precoCheio: 84.9, precoPromocional: null, precoEfetivo: 84.9, fonte: "sale_price", promotionIdAtivo: null }) });
    const cot = await criarCotadorEmP({ clienteId: 133, itemId: body.id, sellerId: S86, mlUserId: S86, buscarComissaoEFrete, mlFetch,
      anuncio: { listing_type_id: "gold_special", category_id: "MLB1", logistic_type: "cross_docking", shipping_tags: TAGS_PROX } }).cotar(84.9);
    const esperado = env ? [11.89, 13.85] : [11.89, 7.75];
    eq([prev.comissaoMarketplace, prev.frete], esperado, `preview (${env || "sem flag"})`);
    eq([diag.comissao, diag.frete], esperado, "diagnóstico");
    eq([motor.comissaoValor, motor.fretePrevisto], esperado, "Motor");
    eq([cot.comissao, cot.frete], esperado, "cotador em P'");
  }
});

cenario("isolamento 86 × 87: toda leitura sai com o token da conta do anúncio; seller de outra conta não é aceito em silêncio", async () => {
  montar({ seller: S87, itens: { MLB7892951136: { preco: 169.66, seller: S87, tags: TAGS_PROX, cotacaoItem: NONE, dims: "40x30x8,1200" } }, env: `${S86},${S87}` });
  await gerarPreviewPrecificacaoMl({ clienteSlugRaw: "alianza" });
  ok(mundo.chamadas.length > 0 && mundo.chamadas.every((c) => c.mlUserId === S87), "100% das chamadas com mlUserId da conta 87");
  ok(mundo.chamadas.every((c) => c.method === "GET"), "somente leitura");
  // Anúncio da 87 lido com o token da 86: o ML nega (403) → frete ausente, nunca o da outra conta.
  mundo.chamadas = [];
  const d = await diagEnriquecerItem({ clienteId: 133, body: corpo("MLB7892951136"), baseRow: BASE_ROW, margemAlvo: 0.15, mlUserId: S86 });
  eq([d.frete, d.lc, d.diagnostico], [null, null, "sem_frete"]);
});

cenario("fonte única: nenhum serviço fora de shared/ monta consulta de comissão ou frete ao ML", async () => {
  const raiz = path.join(__dirname, "..");
  const permitidos = new Set(["services/shared/marketplaceCurrentQuoteService.js", "services/shared/freteCotacaoConfiavel.js", "scripts/freteSnapshotsSuspeitos.js"]);
  const achados = [];
  (function andar(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "tests") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { andar(abs); continue; }
      if (!e.name.endsWith(".js")) continue;
      const rel = path.relative(raiz, abs).split(path.sep).join("/");
      const codigo = fs.readFileSync(abs, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      if (/shipping_options\/free\?|listing_prices\?price=/.test(codigo) && !permitidos.has(rel)) achados.push(rel);
    }
  })(raiz);
  eq(achados, [], "consulta duplicada de comissão/frete");
});

(async () => {
  let falhas = 0;
  for (const { n, f } of casos) {
    try { await f(); console.log(`  ✓ ${n}`); } catch (e) { falhas += 1; console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n    ") : e}`); }
  }
  delete process.env.FRETE_COTACAO_CONFIAVEL_SELLERS;
  console.log(`\nfreteConsumidoresAutomacoes: ${casos.length - falhas}/${casos.length} cenários, ${checks} checks`);
  if (falhas) process.exit(1);
})();
