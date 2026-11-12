// server/tests/fretePrecificacaoCockpit.test.js
// P0 12/11/2026 — cockpit de precificação da Central (preview/aplicar): a ESCRITA de preço só
// passa com frete cotado ou estimado NO novo preço; frete desconhecido bloqueia; frete estimado
// é dito como estimado (aviso), nunca como confirmado. Fixtures simulados (caso MLB4150917539).
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://nobody@127.0.0.1:1/teste-sem-banco";
const assert = require("assert");
const av = require("../services/motorMargem/precificacao/precificacaoAvaliacao");

let checks = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks += 1; };
const ok = (c, m) => { assert.ok(c, m); checks += 1; };

const QUALI = (nivel, extra = {}) => ({ nivel, confirmado: false, cotacaoRejeitada: 7.75, avaliadoEm: "2026-11-12T12:00:00.000Z",
  modalidade: { logistica: "cross_docking", flexHabilitado: true, enviosAgora: true, custosForaDaMargem: ["entregador_flex"] }, ...extra });
function base(motor = {}) {
  return {
    cliente: { id: 133, slug: "alianza", nome: "Alianza" }, conta: { id: 86, nome: "Alianza Jeans 1", mlUserId: "1587129755" }, contaCorreta: true,
    anuncio: { itemId: "MLB4150917539", sellerId: "1587129755", status: "active", temVariacao: false, listingTypeId: "gold_special", categoryId: "MLB1",
      logisticType: "cross_docking", shippingTags: ["self_service_in", "mandatory_free_shipping", "proximity"] },
    motor: { precoAtual: 94.99, precoLista: 94.99, precoPromocional: null, custo: 44, imposto: 0.13, taxaFixa: 0, comissao: 13.3, comissaoTaxa: 0.14,
      frete: 13.85, freteQualidade: QUALI("estimado_dimensoes_historicas", { confianca: "media" }), metaMargem: 0.1, breakEven: null, precoAlvo: null,
      status: "HEALTHY", confianca: "HIGH", temConflito: false, vendas: null, ...motor },
  };
}
const gateFrete = (r) => r.gates.find((g) => g.id === "frete");
const avaliarPreco = (b, recote, modo) => av.avaliar({ base: b, tipo: "PRICE", novoPreco: 82.29, precoVisto: 94.99, recote, modo });

(async () => {
  // 1. Cotação estimada em P' — a recotação recebe as tags do anúncio (sem GET extra) e devolve a qualidade.
  const pedidos = [];
  const estimada = async (args) => { pedidos.push(args); return { comissaoValor: 11.52, fretePrevisto: 13.85, freteQualidade: QUALI("estimado_dimensoes_historicas", { confianca: "media" }) }; };
  const rec = await av.recotar(base(), 82.29, { buscarComissaoEFrete: estimada });
  eq([rec.comissao, rec.frete, rec.freteFonte, rec.freteQualidade.nivel], [11.52, 13.85, "recotado", "estimado_dimensoes_historicas"]);
  eq([pedidos[0].precoEfetivo, pedidos[0].mlUserId, pedidos[0].sellerId], [82.29, "1587129755", "1587129755"], "cotado em P', com a conta do anúncio");
  eq(pedidos[0].shippingTags, ["self_service_in", "mandatory_free_shipping", "proximity"]);
  const r1 = avaliarPreco(base(), rec, "escrita");
  eq([gateFrete(r1).tom, gateFrete(r1).titulo], ["warn", "Frete estimado no novo preço"]);
  ok(/ESTIMADO/.test(gateFrete(r1).detalhe) && /Flex/.test(gateFrete(r1).detalhe), gateFrete(r1).detalhe);
  eq(r1.proposta.freteDetalhe.estimado, true);
  eq(r1.proposta.freteDetalhe.confirmado, false);
  eq(Math.round(r1.proposta.lucro * 100) / 100, 2.22, "caso real: 82,29 → 2,22 (comissão 11,52, frete 13,85)");
  ok(!r1.gates.some((g) => g.id === "frete" && g.tom === "block"), "estimativa validada não bloqueia a escrita");

  // 2. Frete não confiável e irrecuperável em P' — nunca escreve com o frete do preço anterior.
  const desconhecida = async () => ({ comissaoValor: 11.52, fretePrevisto: null, freteQualidade: QUALI("desconhecido"), diagnostico: { frete: { motivo: "frete_cotacao_nao_confiavel" } } });
  const rec2 = await av.recotar(base(), 82.29, { buscarComissaoEFrete: desconhecida });
  eq([rec2.freteFonte, rec2.freteQualidade], ["atual", null], "fallback marcado; a qualidade não acompanha valor herdado");
  const r2 = avaliarPreco(base(), rec2, "escrita");
  eq([gateFrete(r2).tom, r2.bloqueado, av.codigoDoGate(gateFrete(r2))], ["block", true, "RECOTACAO_INDISPONIVEL"]);
  eq(avaliarPreco(base(), rec2, "simulacao").proposta.freteDetalhe, null, "simulação com frete herdado não ganha selo de qualidade");

  // 3. Falhas de leitura (429/500/timeout/exceção) — mesma trava.
  for (const falha of [async () => ({ comissaoValor: 11.52, fretePrevisto: null }), async () => { throw Object.assign(new Error("t"), { name: "MlTimeoutError" }); }]) {
    const rf = await av.recotar(base(), 82.29, { buscarComissaoEFrete: falha });
    ok(rf.freteFonte !== "recotado", "sem cotação, sem 'recotado'");
    eq(avaliarPreco(base(), rf, "escrita").bloqueado, true);
  }

  // 4. Motor sem frete no preço atual (desconhecido) — nem simulação afirma margem; escrita bloqueada.
  const semFrete = base({ frete: null, freteQualidade: QUALI("desconhecido") });
  const rec4 = await av.recotar(semFrete, 82.29, { buscarComissaoEFrete: desconhecida });
  eq(rec4.freteFonte, "indisponivel");
  const r4 = avaliarPreco(semFrete, rec4, "escrita");
  eq([r4.bloqueado, r4.atual.margem, r4.proposta.margem, r4.proposta.lucro], [true, null, null, null], "frete ausente nunca vira zero");

  // 5. Mesmo preço: usa o Motor, com a qualidade do Motor.
  const rec5 = await av.recotar(base(), 94.99, { buscarComissaoEFrete: async () => { throw new Error("não deveria cotar"); } });
  eq([rec5.freteFonte, rec5.frete, rec5.freteQualidade.nivel], ["motor", 13.85, "estimado_dimensoes_historicas"]);

  // 6. Cotação confiável do ML (controle/Full) e seller sem verificação: gate ok, texto de sempre.
  for (const q of [QUALI("cotado_ml", { cotacaoRejeitada: undefined, modalidade: { logistica: "fulfillment", flexHabilitado: false, enviosAgora: false, custosForaDaMargem: [] } }), null]) {
    const r6 = avaliarPreco(base(), { comissao: 11.52, comissaoFonte: "recotada", frete: 14.45, freteFonte: "recotado", freteQualidade: q }, "escrita");
    eq([gateFrete(r6).tom, gateFrete(r6).titulo, r6.bloqueado], ["ok", "Frete previsto no novo preço", false]);
  }
  // 7. Confiança baixa / histórico antigo: simula (aviso), mas a escrita real é bloqueada.
  for (const q of [QUALI("estimado_custo_cobrado", { confianca: "baixa" }), QUALI("estimado_dimensoes_historicas", { confianca: "baixa", historicoAntigo: true })]) {
    const rr = { comissao: 11.52, comissaoFonte: "recotada", frete: 14.45, freteFonte: "recotado", freteQualidade: q };
    eq(gateFrete(avaliarPreco(base(), rr, "simulacao")).tom, "warn", "simulação: aviso");
    const e = avaliarPreco(base(), rr, "escrita");
    eq([gateFrete(e).tom, e.bloqueado], ["block", true], "escrita: bloqueada");
  }
  // 8. Flex habilitado com frete cotado normal: aviso do entregador fora da margem (não bloqueia).
  const flex = avaliarPreco(base(), { comissao: 11.52, comissaoFonte: "recotada", frete: 14.45, freteFonte: "recotado", freteQualidade: QUALI("cotado_ml", { cotacaoRejeitada: undefined }) }, "escrita");
  eq([gateFrete(flex).tom, flex.bloqueado], ["warn", false]);
  ok(/Flex/.test(gateFrete(flex).detalhe), gateFrete(flex).detalhe);
  console.log(`fretePrecificacaoCockpit: ${checks} checks`);
})().catch((e) => { console.error(e); process.exit(1); });
