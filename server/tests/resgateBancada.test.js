// VenForce Resgate — E2: financiamento da promoção (evidência lida) e bancada
// do anúncio (cascata, status simples, sugerido só recotado, opções de ação).
// Casos com números REAIS das contas piloto (MLB4427778060, MLB4191880059).
const assert = require("assert");
const { classificarFinanciamento, iniciadasDaResposta, FINANCIAMENTO } = require("../services/resgate/resgatePromocaoFinanciamento");
const { montarBancada, passaFiltro, STATUS } = require("../services/resgate/resgateBancada");
const { montarContratoFinanceiro } = require("../services/resgate/resgateContrato");
const { NIVEIS } = require("../services/shared/freteCotacaoConfiavel");

let ok = 0;
async function t(nome, fn) {
  try { await fn(); ok++; console.log(`  ✓ ${nome}`); } catch (e) { console.error(`  ✗ ${nome}\n    ${e.stack}`); process.exitCode = 1; }
}

/** Item auditado com contrato REAL (montarContratoFinanceiro). */
function item({ itemId = "MLB1", sku = "SKU1", cheio, vigente, comissao, pct, frete, custo, imposto = 0.13, taxa = 0, promocao = undefined, nivel = NIVEIS.DIMENSOES, meta = 0.15, logisticType = "cross_docking" }) {
  const contrato = montarContratoFinanceiro({
    conta: { clienteId: 133, clienteContaId: 86, sellerId: "S" },
    anuncio: { itemId, logisticType, status: "active" },
    precos: { cheio, vigente, promocional: cheio > vigente ? vigente : null, observadoEm: "2026-11-12T22:00:00Z" },
    comissao: { valor: comissao, percentual: pct, precoBase: vigente },
    frete: { valor: frete, freteQualidade: { nivel, confianca: "media", avaliadoEm: "2026-11-12T22:00:00Z" } },
    custo: { valor: custo }, imposto: { percentual: imposto }, taxaFixa: { valor: taxa },
    promocao: promocao === undefined ? (cheio > vigente ? { ativa: true, subsidioMl: null } : { ativa: false }) : promocao,
  });
  return { itemId, sku, meta: { valor: meta, origem: "teste" }, contrato, avaliadoEm: "2026-11-12T22:00:00Z" };
}
// MLB4427778060: SELLER_CAMPAIGN C-MLB6270746, cheio 149,90, comprador 129,90.
const mlb4427 = () => item({ itemId: "MLB4427778060", sku: null, cheio: 149.9, vigente: 129.9, comissao: 24.68, pct: 0.19, frete: 19.05, custo: 62, nivel: NIVEIS.DECLARADAS });
const promo4427 = [{ id: "C-MLB6270746", type: "SELLER_CAMPAIGN", sub_type: "FLEXIBLE_PERCENTAGE", status: "started", price: 129.9, original_price: 149.9, meli_percentage: null, seller_percentage: null, name: "PROMO - VENDEX" }];
// MLB4191880059: SMART P-MLB17937078 (ML 1,5% / vendedor 24,9%) forma 88,26; SELLER_CAMPAIGN em 90,99 não forma.
const mlb4191 = () => item({ itemId: "MLB4191880059", cheio: 119.9, vigente: 88.26, comissao: 12.36, pct: 0.14, frete: 13.85, custo: 43 });
const promo4191 = [
  { id: "C-MLB6270746", type: "SELLER_CAMPAIGN", status: "started", price: 90.99, original_price: 119.9, meli_percentage: null, seller_percentage: null, name: "PROMO - VENDEX" },
  { id: "P-MLB17937078", type: "SMART", status: "started", price: 88.26, original_price: 119.9, meli_percentage: 1.5, seller_percentage: 24.9, name: "Impulsione suas vendas" },
  { id: "X", type: "DEAL", status: "candidate", price: 80 },
];

(async () => {
  console.log("Financiamento da promoção");
  await t("SELLER_CAMPAIGN que forma o preço, sem meli_percentage = vendedor 100%, subsídio 0 COMPROVADO", () => {
    const f = classificarFinanciamento({ iniciadas: iniciadasDaResposta(promo4427), vigente: 129.9, cheio: 149.9 });
    assert.strictEqual(f.comprovado, true); assert.strictEqual(f.subsidio, 0); assert.strictEqual(f.financiamento, FINANCIAMENTO.VENDEDOR); assert.strictEqual(f.id, "C-MLB6270746");
  });
  await t("SMART com meli_percentage: subsídio = original × meli% (119,90 × 1,5% = 1,80), conferido contra o preço", () => {
    const f = classificarFinanciamento({ iniciadas: iniciadasDaResposta(promo4191), vigente: 88.26, cheio: 119.9 });
    assert.strictEqual(f.financiamento, FINANCIAMENTO.COFINANCIADA); assert.strictEqual(f.subsidio, 1.8); assert.strictEqual(f.id, "P-MLB17937078");
  });
  await t("candidatas não contam; só promoções iniciadas", () => { assert.strictEqual(iniciadasDaResposta(promo4191).length, 2); });
  await t("DEAL/LIGHTNING sem meli_percentage = NÃO determinado (bloqueia, não vira zero)", () => {
    for (const type of ["DEAL", "LIGHTNING"]) {
      const f = classificarFinanciamento({ iniciadas: [{ id: "D", type, price: 90, original_price: 100, meli_percentage: null }], vigente: 90, cheio: 100 });
      assert.strictEqual(f.comprovado, false); assert.strictEqual(f.subsidio, null); assert.strictEqual(f.pendencia, "PARTICIPACAO_ML_NAO_INFORMADA");
    }
  });
  await t("percentuais que não reproduzem o preço = inconsistência; nenhuma iniciada no preço = não identificada", () => {
    assert.strictEqual(classificarFinanciamento({ iniciadas: [{ id: "S", type: "SMART", price: 88.26, original_price: 119.9, meli_percentage: 1.5, seller_percentage: 10 }], vigente: 88.26, cheio: 119.9 }).pendencia, "INCONSISTENCIA_PRECO_PROMO");
    assert.strictEqual(classificarFinanciamento({ iniciadas: iniciadasDaResposta(promo4427), vigente: 120, cheio: 149.9 }).pendencia, "PROMO_NAO_IDENTIFICADA");
  });
  await t("desempate por sale_price.metadata.campaign_id; sale_price com outro valor = PRECO_MUDOU", () => {
    const duas = [{ id: "A", type: "SELLER_CAMPAIGN", price: 90 }, { id: "B", type: "SMART", price: 90, original_price: 100, meli_percentage: 2, seller_percentage: 8 }];
    assert.strictEqual(classificarFinanciamento({ iniciadas: duas, vigente: 90, cheio: 100 }).pendencia, "PROMO_AMBIGUA");
    assert.strictEqual(classificarFinanciamento({ iniciadas: duas, vigente: 90, cheio: 100, salePrice: { amount: 90, metadata: { campaign_id: "B" } } }).subsidio, 2);
    assert.strictEqual(classificarFinanciamento({ iniciadas: duas, vigente: 90, cheio: 100, salePrice: { amount: 95, metadata: { campaign_id: "B" } } }).pendencia, "PRECO_MUDOU");
  });
  await t("boosted_offer na resposta = não mensurável (nada somado); leitura com erro HTTP = incompleta", () => {
    assert.strictEqual(classificarFinanciamento({ iniciadas: iniciadasDaResposta([{ ...promo4427[0], boosted_offer: true }]), vigente: 129.9, cheio: 149.9 }).pendencia, "BOOSTED_OFFER_NAO_MEDIDO");
    assert.strictEqual(classificarFinanciamento({ iniciadas: [], vigente: 1, cheio: 2, promoStatus: 403 }).pendencia, "LEITURA_PROMO_INCOMPLETA");
  });

  console.log("Bancada");
  await t("MLB4427778060 sem leitura de promoção: margem mínima 5,61% e status MARGEM_DESCONHECIDA (não conclui abaixo da meta)", () => {
    const b = montarBancada(mlb4427());
    assert.strictEqual(b.status, STATUS.MARGEM_DESCONHECIDA); assert.strictEqual(b.resultado.limiteInferior, true); assert.strictEqual(b.resultado.margemPercent, 5.61);
    assert.ok(b.pendencias.some((p) => p.codigo === "SUBSIDIO_NAO_VERIFICADO")); assert.strictEqual(b.sugerido.status, "NAO_NECESSARIO"); assert.deepStrictEqual(b.acoes, []);
  });
  await t("MLB4427778060 com evidência: vendedor 100%, subsídio 0, margem 5,61% CONFIÁVEL → abaixo da meta de 15%", () => {
    const f = classificarFinanciamento({ iniciadas: iniciadasDaResposta(promo4427), vigente: 129.9, cheio: 149.9, fonte: "GET" });
    const b = montarBancada(mlb4427(), { promocao: f });
    assert.strictEqual(b.status, STATUS.ABAIXO_DA_META); assert.strictEqual(b.resultado.confiavel, true); assert.strictEqual(b.resultado.lucro, 7.28);
    const c = Object.fromEntries(b.cascata.map((l) => [l.chave, l.valor]));
    assert.strictEqual(c.precoCheio, 149.9); assert.strictEqual(c.descontoVendedor, 20); assert.strictEqual(c.descontoMl, 0); assert.strictEqual(c.precoComprador, 129.9);
    assert.strictEqual(c.subsidioMl, 0); assert.strictEqual(c.receitaVendedor, 129.9); assert.strictEqual(c.lucro, 7.28);
    assert.strictEqual(b.precos.promocionalVendedor, 129.9);
  });
  await t("sem recotação o sugerido é PRELIMINAR (nunca liberado); ação de preço promocional só quando o sugerido < cheio", () => {
    const f = classificarFinanciamento({ iniciadas: iniciadasDaResposta(promo4427), vigente: 129.9, cheio: 149.9 });
    const b = montarBancada(mlb4427(), { promocao: f });
    assert.strictEqual(b.sugerido.status, "PRELIMINAR"); assert.ok(b.sugerido.preco > 149.9, "preliminar 15% acima do cheio");
    const tipos = b.acoes.map((a) => a.tipo);
    assert.ok(!tipos.includes("ALTERAR_PRECO_PROMOCIONAL")); assert.ok(tipos.includes("SAIR_DA_PROMOCAO")); assert.ok(tipos.includes("ALTERAR_PRECO"));
    assert.strictEqual(b.acoes.find((a) => a.tipo === "ALTERAR_PRECO").requerAntes, "SAIR_DA_PROMOCAO");
  });
  await t("recotação confiável na MESMA meta → RECOTADO; outra meta → volta a PRELIMINAR", () => {
    const f = classificarFinanciamento({ iniciadas: iniciadasDaResposta(promo4427), vigente: 129.9, cheio: 149.9 });
    const rec = { ok: true, meta: 0.15, recotadoEm: "2026-11-12T23:40:00Z", recomendacao: { preco: 140.5, comissao: 26.7, frete: 19.05, margem: 0.1502, lucro: 21.1, margemConfiavel: true }, cenarioSairPromo: { preco: 149.9, margem: 0.19 } };
    const b = montarBancada(mlb4427(), { promocao: f, recotacao: rec });
    assert.strictEqual(b.sugerido.status, "RECOTADO"); assert.strictEqual(b.sugerido.preco, 140.5);
    const promoAcao = b.acoes.find((a) => a.tipo === "ALTERAR_PRECO_PROMOCIONAL");
    assert.ok(promoAcao && promoAcao.promocaoId === "C-MLB6270746" && /aplicar/.test(promoAcao.endpoint));
    const sair = b.acoes.find((a) => a.tipo === "SAIR_DA_PROMOCAO");
    assert.strictEqual(sair.resultadoEsperado.atingeMeta, true); assert.strictEqual(sair.resultadoEsperado.recotado, true);
    assert.strictEqual(montarBancada(mlb4427(), { promocao: f, recotacao: rec, meta: 0.2 }).sugerido.status, "PRELIMINAR");
  });
  await t("SMART cofinanciada: subsídio 1,80 entra UMA vez (receita 90,06; lucro 9,38) e não se oferece alterar o preço promocional", () => {
    const f = classificarFinanciamento({ iniciadas: iniciadasDaResposta(promo4191), vigente: 88.26, cheio: 119.9 });
    const b = montarBancada(mlb4191(), { promocao: f });
    const c = Object.fromEntries(b.cascata.map((l) => [l.chave, l.valor]));
    assert.strictEqual(c.subsidioMl, 1.8); assert.strictEqual(c.receitaVendedor, 90.06); assert.strictEqual(c.lucro, 9.38); assert.strictEqual(c.descontoVendedor, 29.84);
    assert.strictEqual(b.resultado.margemPercent, 10.62); // = auditoria (lucro sem arredondar 9,3762 / 88,26)
    assert.strictEqual(b.status, STATUS.ABAIXO_DA_META);
    assert.ok(!b.acoes.some((a) => a.tipo === "ALTERAR_PRECO_PROMOCIONAL")); assert.ok(b.acoes.find((a) => a.tipo === "SAIR_DA_PROMOCAO").suportada);
    assert.strictEqual(b.precos.promocionalVendedor, null);
  });
  await t("sem promoção e abaixo da meta: única ação é PATCH de preço; prejuízo tem status próprio", () => {
    const b = montarBancada(item({ cheio: 80, vigente: 80, comissao: 11.2, pct: 0.14, frete: 13.85, custo: 55 }));
    assert.strictEqual(b.status, STATUS.PREJUIZO); assert.deepStrictEqual(b.acoes.map((a) => a.tipo), ["ALTERAR_PRECO"]);
    assert.ok(!b.cascata.some((l) => l.chave === "descontoVendedor"));
  });
  await t("sem custo (anúncio sem SKU) = BLOQUEADO com o motivo exato e o que resolve; nada de margem", () => {
    const b = montarBancada(item({ sku: null, cheio: 100, vigente: 100, comissao: 14, pct: 0.14, frete: 18, custo: null }));
    assert.strictEqual(b.status, STATUS.BLOQUEADO); assert.strictEqual(b.resultado.margem, null);
    assert.ok(b.bloqueios.some((x) => x.codigo === "CUSTO_AUSENTE")); assert.ok(b.bloqueios.some((x) => x.codigo === "SEM_SKU" && x.resolveCom));
  });
  await t("PRICE_DISCOUNT: sair não é suportado pelo VenForce (motivo do tipo), nunca prometido", () => {
    const f = classificarFinanciamento({ iniciadas: [{ id: "PD", type: "PRICE_DISCOUNT", price: 129.9, original_price: 149.9 }], vigente: 129.9, cheio: 149.9 });
    const sair = montarBancada(mlb4427(), { promocao: f }).acoes.find((a) => a.tipo === "SAIR_DA_PROMOCAO");
    assert.strictEqual(sair.suportada, false); assert.ok(/desconto individual/.test(sair.motivoNaoSuportada));
  });
  await t("preço mudou desde a auditoria fica explícito (reler antes de agir)", () => {
    const b = montarBancada(mlb4427(), { recotacao: { ok: true, meta: 0.15, precoCheio: 149.9, anuncioLido: { price: 159.9 }, recomendacao: { preco: 140, margem: 0.15, margemConfiavel: true } } });
    assert.ok(b.precoMudou && /reler/.test(b.precoMudou.texto));
  });
  await t("filtros simples: abaixo da meta inclui prejuízo; desconhecida inclui bloqueado; promoção ativa", () => {
    const f = classificarFinanciamento({ iniciadas: iniciadasDaResposta(promo4427), vigente: 129.9, cheio: 149.9 });
    const abaixo = montarBancada(mlb4427(), { promocao: f }), desconhecida = montarBancada(mlb4427());
    const prejuizo = montarBancada(item({ cheio: 80, vigente: 80, comissao: 11.2, pct: 0.14, frete: 13.85, custo: 55 }));
    assert.ok(passaFiltro(abaixo, "abaixo_meta") && passaFiltro(prejuizo, "abaixo_meta") && passaFiltro(prejuizo, "prejuizo") && !passaFiltro(abaixo, "prejuizo"));
    assert.ok(passaFiltro(desconhecida, "desconhecida") && !passaFiltro(abaixo, "desconhecida"));
    assert.ok(passaFiltro(abaixo, "promocao") && !passaFiltro(prejuizo, "promocao"));
  });
  await t("limite inferior já na meta conclui OK (subsídio só soma), exceto com PRECO_MUDOU", () => {
    const alto = () => item({ cheio: 200, vigente: 180, comissao: 25.2, pct: 0.14, frete: 20, custo: 60 });
    assert.strictEqual(montarBancada(alto()).status, STATUS.OK);
    assert.strictEqual(montarBancada(alto(), { promocao: { comprovado: false, pendencia: "PRECO_MUDOU", texto: "mudou" } }).status, STATUS.MARGEM_DESCONHECIDA);
  });

  console.log("Leitura ao vivo");
  await t("ao vivo: SMART em andamento que NÃO forma o preço não paga rebate; campanha do vendedor = 0 comprovado", () => {
    const { aplicarFinanciamento } = require("../services/resgate/resgateAoVivo");
    const antigo = { ativa: true, subsidioMl: 1.8, ambigua: false };
    const lista = [{ id: "C1", type: "SELLER_CAMPAIGN", status: "started", price: 90.99, original_price: 119.9 }, { id: "S1", type: "SMART", status: "started", price: 88.26, original_price: 119.9, meli_percentage: 1.5, seller_percentage: 24.9 }];
    const r = aplicarFinanciamento(antigo, lista, { precoCheio: 119.9, precoEfetivo: 90.99 });
    assert.strictEqual(r.subsidioMl, 0); assert.strictEqual(r.id, "C1"); assert.strictEqual(r.financiamento.financiamento, FINANCIAMENTO.VENDEDOR);
    assert.strictEqual(aplicarFinanciamento(antigo, lista, { precoCheio: 119.9, precoEfetivo: 88.26 }).subsidioMl, 1.8);
    assert.strictEqual(aplicarFinanciamento(antigo, [{ id: "D", type: "DEAL", status: "started", price: 80 }], { precoCheio: 100, precoEfetivo: 80 }).subsidioMl, null);
    assert.strictEqual(aplicarFinanciamento(antigo, lista, { precoCheio: 100, precoEfetivo: 100 }).subsidioMl, 0);
  });

  console.log(`\n${ok} verificações da bancada do Resgate`);
})();
