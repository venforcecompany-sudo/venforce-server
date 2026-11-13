// server/tests/precoVigenteComposicao.test.js
// Composição do PREÇO VIGENTE na Central de Margem: qual promoção forma o preço
// da margem, quem financia o desconto e quanto o ML compensa.
//
// Os números dos casos "reais" vêm de leituras GET de anúncios de duas contas
// de moda (nov/2026: seller-promotions + sale_price). Sem banco real, sem ML.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://127.0.0.1:1/dead";

const assert = require("assert");
const core = require("../services/motorMargem/core");
const read = require("../services/motorMargem/marginSnapshotReadService");
const { classificarPrecoVigente, STATUS, FINANCIADOR, MOTIVO } = require("../services/motorMargem/precoVigenteComposicao");
const { margemAtualComRebate, rebateAplicavel, MOTIVO_REBATE } = require("../services/motorMargem/margemAtualRebate");
const { mapItemParaSnapshot } = require("../services/motorMargem/marginSnapshotProcessor");

const casos = [];
function cenario(nome, fn) { casos.push({ nome, fn }); }

const PROMO_RUN = { runId: 41, snapshotAt: "2026-11-12T18:44:00Z" };
const SEM_VENDAS = { porMlb: new Map(), reembolsoPorMlb: new Map(), fallbackObservedAt: null };

function linha(o = {}) {
  const insumos = { price: o.price ?? 100, cost: o.cost ?? 40, taxRate: 0.1, fixedFee: 0, commission: o.commission ?? 14, freight: o.freight ?? 16.85 };
  const calc = core.computeMargin(insumos);
  return {
    itemId: o.itemId || "MLB1", sku: null, titulo: "Produto", marketplace: "meli", imageUrl: null, clienteContaId: 5,
    ...insumos, listPrice: o.listPrice === undefined ? null : o.listPrice,
    profit: calc.profit, margin: calc.margin, marginPercent: Math.round(calc.margin * 10000) / 100,
    status: "HEALTHY", confidenceLevel: "HIGH", assumed: [], missing: [], refreshStatus: o.refreshStatus || "fresh",
    calculatedAt: o.calculatedAt || "2026-11-12T18:40:00Z", observedAt: "2026-11-12T18:40:00Z", runId: 7,
    quality: {
      targetMargin: 0.1, evidencias: {}, freteAplicavel: true,
      freteQualidade: o.freteQualidade === undefined ? { nivel: "cotado_ml", confianca: "alta" } : o.freteQualidade,
      precoLeitura: o.precoLeitura || null,
    },
  };
}
function promo(o = {}) {
  return {
    promotionId: o.id || "P-1", refId: o.refId ?? null, tipo: o.tipo || "SMART", nome: o.nome || "Promo",
    status: o.status || "started", ativa: o.ativa === undefined ? null : o.ativa,
    precoFinal: o.preco, precoOriginal: o.original, meliPercentage: o.meli ?? null, sellerPercentage: o.seller ?? null,
    subsidioMl: o.meli != null && o.original != null ? Math.round(o.original * o.meli) / 100 : null,
    observedAt: o.observedAt || "2026-11-12T18:44:00Z", herdada: false,
  };
}
const classificar = (l, promocoes, contexto = { promoSnapshot: PROMO_RUN }) => classificarPrecoVigente({ linha: l, promocoes, contexto });

// ── Sem promoção ─────────────────────────────────────────────────────────────
cenario("sem promoção: preço vigente confirmado = preço do anúncio, nenhum retorno", () => {
  const r = classificar(linha({ price: 100, listPrice: null }), []);
  assert.strictEqual(r.status, STATUS.CONFIRMADO);
  assert.strictEqual(r.motivo, MOTIVO.SEM_PROMOCAO);
  assert.strictEqual(r.rebate, null);
  assert.strictEqual(r.precoVendedor, 100);
  assert.strictEqual(r.subsidioMl.status, "NAO_SE_APLICA");
});

// ── Campanha 100% do vendedor (caso real: cheio 149,90 → comprador 129,90) ──
cenario("caso real — campanha do vendedor sem meli_percentage: vendedor 100%, subsídio 0 comprovado, sem exigir rebate", () => {
  const l = linha({ price: 129.9, listPrice: 149.9 });
  const r = classificar(l, [promo({ id: "C-1", tipo: "SELLER_CAMPAIGN", preco: 129.9, original: 149.9 })]);
  assert.strictEqual(r.status, STATUS.CONFIRMADO);
  assert.strictEqual(r.financiador, FINANCIADOR.VENDEDOR);
  assert.strictEqual(r.rebate, null);
  assert.deepStrictEqual(r.subsidioMl, { valor: 0, status: "ZERO" });
  assert.strictEqual(r.precoCheio, 149.9);
  assert.strictEqual(r.precoComprador, 129.9);
  assert.strictEqual(r.precoVendedor, 129.9);
  assert.strictEqual(r.promocao.tipoLabel, "Campanha do vendedor");
  // Margem: a do snapshot, intacta, e CONFIÁVEL (frete cotado).
  const item = read.comporItem(l, SEM_VENDAS, {}, { linhas: [promo({ id: "C-1", tipo: "SELLER_CAMPAIGN", preco: 129.9, original: 149.9 })], promocoes: 0 }, null, { promoSnapshot: PROMO_RUN });
  assert.strictEqual(item.projected.margin, l.margin);
  assert.strictEqual(item.projected.confianca, "CONFIAVEL");
  assert.strictEqual(item.precoVigente.financiador, "VENDEDOR");
});

// ── Cofinanciada (caso real: SMART 1,4% de 122,43 forma 95,84) ──────────────
cenario("caso real — SMART cofinanciada forma o preço (com campanha do vendedor iniciada a outro preço): retorno = original × meli%", () => {
  const l = linha({ price: 95.84, listPrice: 122.43 });
  const promocoes = [
    promo({ id: "C-1", tipo: "SELLER_CAMPAIGN", preco: 98.8, original: 122.43 }),
    promo({ id: "P-2", refId: "OFFER-1", tipo: "SMART", preco: 95.84, original: 122.43, meli: 1.4, seller: 20.3 }),
  ];
  const r = classificar(l, promocoes);
  assert.strictEqual(r.status, STATUS.CONFIRMADO);
  assert.strictEqual(r.financiador, FINANCIADOR.COFINANCIADA);
  assert.strictEqual(r.rebate, 1.71);
  assert.strictEqual(r.precoVendedor, 97.55, "valor reconhecido ao vendedor = comprador + retorno (somado uma vez)");
  assert.strictEqual(r.promocao.id, "P-2");
  const m = margemAtualComRebate(l, { linhas: promocoes, promocoes: 1 }, null, { promoSnapshot: PROMO_RUN });
  assert.strictEqual(m.rebate, 1.71);
  assert.strictEqual(m.margin, core.computeMargin({ price: 95.84, cost: 40, taxRate: 0.1, fixedFee: 0, commission: 14, freight: 16.85, rebate: 1.71 }).margin);
});

// ── O BUG: retorno de uma SMART que NÃO forma o preço ───────────────────────
cenario("caso real (bug de 12/11) — preço 102,90 da campanha do vendedor; SMART iniciada a 109,51 NÃO soma retorno", () => {
  const l = linha({ price: 102.9, listPrice: 129.99 });
  const promocoes = [
    promo({ id: "C-1", tipo: "SELLER_CAMPAIGN", preco: 102.9, original: 129.99 }),
    promo({ id: "P-2", refId: "OFFER-2", tipo: "SMART", preco: 109.51, original: 129.99, meli: 1.5, seller: 14.2 }),
  ];
  const r = classificar(l, promocoes);
  assert.strictEqual(r.financiador, FINANCIADOR.VENDEDOR);
  assert.strictEqual(r.rebate, null);
  const m = margemAtualComRebate(l, { linhas: promocoes, promocoes: 1 }, null, { promoSnapshot: PROMO_RUN });
  assert.strictEqual(m.rebate, null, "antes: R$ 1,95 somado sobre um preço que não era o da SMART");
  assert.strictEqual(m.margin, l.margin);
});

cenario("caso real — campanha do vendedor 82,85 + DEAL iniciada a 84,90: quem forma o preço é a do vendedor", () => {
  const r = classificar(linha({ price: 82.85, listPrice: 129.99 }), [
    promo({ id: "C-1", tipo: "SELLER_CAMPAIGN", preco: 82.85, original: 129.99 }),
    promo({ id: "P-9", tipo: "DEAL", preco: 84.9, original: 129.99 }),
  ]);
  assert.strictEqual(r.status, STATUS.CONFIRMADO);
  assert.strictEqual(r.financiador, FINANCIADOR.VENDEDOR);
});

// ── DEAL sem participação informada (caso real: 278,14 → 169,66) ────────────
cenario("caso real — DEAL ativa sem meli_percentage: REVISAR; margem vira limite inferior, nunca confiável", () => {
  const l = linha({ price: 169.66, listPrice: 278.14, commission: 20.36, freight: 21.75 });
  const promocoes = [
    promo({ id: "C-7", tipo: "SELLER_CAMPAIGN", preco: 175.22, original: 278.14, ativa: false }),
    promo({ id: "P-8", tipo: "DEAL", preco: 169.66, original: 278.14, ativa: true }),
  ];
  const r = classificar(l, promocoes);
  assert.strictEqual(r.status, STATUS.REVISAR);
  assert.strictEqual(r.motivo, MOTIVO.PARTICIPACAO_ML_NAO_INFORMADA);
  assert.strictEqual(r.financiador, FINANCIADOR.NAO_DETERMINADO);
  assert.strictEqual(r.rebate, null);
  const item = read.comporItem(l, SEM_VENDAS, {}, { linhas: promocoes, promocoes: 0 }, null, { promoSnapshot: PROMO_RUN });
  assert.strictEqual(item.projected.confianca, "BLOQUEADA");
  assert.strictEqual(item.projected.limiteInferior, true);
  assert.strictEqual(item.projected.rebateMotivo, MOTIVO_REBATE.PRECO_PROMOCAO_NAO_COMPROVADO);
  assert.ok(/não informa a participação/.test(item.projected.confiancaMotivos[0]));
});

// ── Sem leitura de promoções ────────────────────────────────────────────────
cenario("preço promocional sem leitura de promoções da conta: REVISAR (não presume vendedor)", () => {
  const r = classificar(linha({ price: 129.9, listPrice: 149.9 }), [], { promoSnapshot: null });
  assert.strictEqual(r.status, STATUS.REVISAR);
  assert.strictEqual(r.motivo, MOTIVO.PROMO_NAO_LIDA);
  const falha = classificarPrecoVigente({ linha: linha({ price: 129.9, listPrice: 149.9 }), contexto: { indisponivel: "PROMO_SNAPSHOT_INDISPONIVEL" } });
  assert.strictEqual(falha.motivo, MOTIVO.PROMO_INDISPONIVEL);
});

cenario("promoção lida, mas nenhuma iniciada forma o preço: REVISAR (origem do desconto não comprovada)", () => {
  const r = classificar(linha({ price: 90, listPrice: 120 }), [promo({ preco: 95, original: 120, meli: 2 })]);
  assert.strictEqual(r.status, STATUS.REVISAR);
  assert.strictEqual(r.motivo, MOTIVO.PROMO_NAO_IDENTIFICADA);
});

// ── Momentos diferentes ─────────────────────────────────────────────────────
cenario("caso real — sale_price do cálculo aponta a campanha, mas ela está a outro preço agora: DESATUALIZADO, sem retorno", () => {
  // Cálculo a 104,90; leitura de promoções às 23:17 mostra a mesma campanha a 99,99.
  const l = linha({ price: 104.9, listPrice: 112.88, precoLeitura: { fonte: "sale_price", promotionId: "OFFER-X", campaignId: "C-1", promotionType: "custom" } });
  const r = classificar(l, [promo({ id: "C-1", tipo: "SELLER_CAMPAIGN", preco: 99.99, original: 112.88 })]);
  assert.strictEqual(r.status, STATUS.DESATUALIZADO);
  assert.strictEqual(r.motivo, MOTIVO.PRECO_MUDOU);
  const item = read.comporItem(l, SEM_VENDAS, {}, { linhas: [promo({ id: "C-1", tipo: "SELLER_CAMPAIGN", preco: 99.99, original: 112.88 })], promocoes: 0 }, null, { promoSnapshot: PROMO_RUN });
  assert.strictEqual(item.projected.confianca, "DESATUALIZADA");
});

cenario("sale_price identifica a SELLER_CAMPAIGN pelo campaign_id (ref_id nulo na listagem), mesmo com SMART no mesmo preço", () => {
  const l = linha({ price: 100, listPrice: 120, precoLeitura: { fonte: "sale_price", promotionId: "OFFER-9", campaignId: "C-1", promotionType: "custom" } });
  const r = classificar(l, [
    promo({ id: "C-1", tipo: "SELLER_CAMPAIGN", preco: 100, original: 120 }),
    promo({ id: "P-2", refId: "OFFER-2", tipo: "SMART", preco: 100, original: 120, meli: 2, seller: 14.67 }),
  ]);
  assert.strictEqual(r.status, STATUS.CONFIRMADO);
  assert.strictEqual(r.promocao.id, "C-1");
  assert.strictEqual(r.rebate, null);
});

cenario("duas iniciadas no MESMO preço com financiamento diferente, sem confirmação: REVISAR ambígua", () => {
  const r = classificar(linha({ price: 100, listPrice: 120 }), [
    promo({ id: "C-1", tipo: "SELLER_CAMPAIGN", preco: 100, original: 120 }),
    promo({ id: "P-2", tipo: "SMART", preco: 100, original: 120, meli: 2 }),
  ]);
  assert.strictEqual(r.status, STATUS.REVISAR);
  assert.strictEqual(r.motivo, MOTIVO.PROMO_AMBIGUA);
  assert.strictEqual(rebateAplicavel(linha({ price: 100, listPrice: 120 }), { linhas: [promo({ id: "C-1", tipo: "SELLER_CAMPAIGN", preco: 100, original: 120 }), promo({ id: "P-2", tipo: "SMART", preco: 100, original: 120, meli: 2 })] }, { promoSnapshot: PROMO_RUN }).motivo, MOTIVO_REBATE.AMBIGUO);
});

cenario("calculado sem promoção, mas a leitura de promoções mostra uma ATIVA mais barata: DESATUALIZADO", () => {
  const r = classificar(linha({ price: 120, listPrice: 120 }), [promo({ tipo: "SELLER_CAMPAIGN", preco: 99, original: 120, ativa: true })]);
  assert.strictEqual(r.status, STATUS.DESATUALIZADO);
  assert.strictEqual(r.motivo, MOTIVO.PROMOCAO_DEPOIS_DO_CALCULO);
});

// ── Financiamento: bordas ───────────────────────────────────────────────────
cenario("meli_percentage 0 informado: vendedor 100% (qualquer tipo)", () => {
  const r = classificar(linha({ price: 90, listPrice: 100 }), [promo({ tipo: "DEAL", preco: 90, original: 100, meli: 0, seller: 10 })]);
  assert.strictEqual(r.financiador, FINANCIADOR.VENDEDOR);
  assert.strictEqual(r.rebate, null);
});

cenario("preço original da promoção ≠ preço cheio, ou percentuais que não reproduzem o preço: REVISAR (retorno não comprovado)", () => {
  const a = classificar(linha({ price: 90, listPrice: 100 }), [promo({ preco: 90, original: 110, meli: 2 })]);
  assert.strictEqual(a.motivo, MOTIVO.PRECO_ORIGINAL_DIVERGE);
  const b = classificar(linha({ price: 90, listPrice: 100 }), [promo({ preco: 90, original: 100, meli: 2, seller: 2 })]);
  assert.strictEqual(b.motivo, MOTIVO.PERCENTUAIS_INCONSISTENTES);
  assert.strictEqual(b.rebate, null);
  // Arredondamento dos percentuais (1 casa) não é inconsistência — caso real:
  // original 168,78, ML 3,1% + vendedor 35% reconstrói 104,47 para um preço de 104,59.
  const c = classificar(linha({ price: 104.59, listPrice: 168.78 }), [promo({ preco: 104.59, original: 168.78, meli: 3.1, seller: 35 })]);
  assert.strictEqual(c.status, STATUS.CONFIRMADO);
  assert.strictEqual(c.rebate, 5.23);
});

cenario("relâmpago `pending` que o sale_price confirmou (ativa): conta como a promoção do preço", () => {
  const r = classificar(linha({ price: 90, listPrice: 100 }), [promo({ tipo: "SMART_LIGHTNING", status: "pending", ativa: true, preco: 90, original: 100, meli: 3, seller: 7 })]);
  assert.strictEqual(r.status, STATUS.CONFIRMADO);
  assert.strictEqual(r.rebate, 3);
});

cenario("sem preço: SEM_PRECO e margem BLOQUEADA", () => {
  const r = classificar({ price: null, listPrice: null, quality: {} }, []);
  assert.strictEqual(r.status, STATUS.SEM_PRECO);
});

// ── Confiança da margem ─────────────────────────────────────────────────────
cenario("confiança: frete estimado/não verificado = ESTIMADA; atualização que falhou = DESATUALIZADA; tudo medido = CONFIAVEL", () => {
  const ctx = [null, null, { promoSnapshot: PROMO_RUN }];
  const ok = read.comporItem(linha(), SEM_VENDAS, {}, ...ctx);
  assert.strictEqual(ok.projected.confianca, "CONFIAVEL");
  assert.strictEqual(ok.diagnostico.frete.valor, 16.85);
  const est = read.comporItem(linha({ freteQualidade: { nivel: "estimado_dimensoes_declaradas", confianca: "media" } }), SEM_VENDAS, {}, ...ctx);
  assert.strictEqual(est.projected.confianca, "ESTIMADA");
  assert.ok(/ESTIMADO/.test(est.projected.confiancaMotivos[0]));
  assert.strictEqual(est.diagnostico.frete.estimado, true);
  const naoVerif = read.comporItem(linha({ freteQualidade: null }), SEM_VENDAS, {}, ...ctx);
  assert.strictEqual(naoVerif.projected.confianca, "ESTIMADA");
  assert.ok(/sem verificação da modalidade/.test(naoVerif.projected.confiancaMotivos[0]));
  const falhou = read.comporItem(linha({ refreshStatus: "failed" }), SEM_VENDAS, {}, ...ctx);
  assert.strictEqual(falhou.projected.confianca, "DESATUALIZADA");
  const semFrete = linha({ freight: null });
  semFrete.margin = null; semFrete.profit = null; semFrete.missing = ["freight"];
  assert.strictEqual(read.comporItem(semFrete, SEM_VENDAS, {}, ...ctx).projected.confianca, "BLOQUEADA");
});

// ── Snapshot grava a promoção do preço ──────────────────────────────────────
cenario("Margin Snapshot grava em quality.precoLeitura a promoção que o sale_price apontou na MESMA leitura do preço", () => {
  const item = {
    identity: { itemId: "MLB1", sku: null, titulo: "P", image: null },
    fields: {}, margin: { projected: { profit: null, margin: null, marginPercent: null, missing: [], assumed: [] }, target: null },
    quality: { status: "UNVALIDATED", confidence: "LOW", divergences: [] },
    diagnostico: { precoLeitura: { fonte: "sale_price", promotionId: "OFFER-1", campaignId: "C-1", promotionType: "custom" } },
  };
  const row = mapItemParaSnapshot({ item, run: { clienteId: 1, clienteContaId: 5, marketplace: "meli", id: 9 }, base: null, observedAt: new Date() });
  assert.deepStrictEqual(row.quality.precoLeitura, { fonte: "sale_price", promotionId: "OFFER-1", campaignId: "C-1", promotionType: "custom" });
});

async function main() {
  let falhas = 0;
  for (const c of casos) {
    try { await c.fn(); console.log(`  ✓ ${c.nome}`); } catch (err) { falhas += 1; console.log(`  ✗ ${c.nome}\n    ${err && err.stack ? err.stack.split("\n").slice(0, 6).join("\n    ") : err}`); }
  }
  if (falhas) { console.log(`precoVigenteComposicao: ${falhas} de ${casos.length} cenários falharam`); process.exit(1); }
  console.log(`precoVigenteComposicao: ok (${casos.length} cenários)`);
}
main();
