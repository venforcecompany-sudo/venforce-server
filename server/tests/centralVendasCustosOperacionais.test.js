// server/tests/centralVendasCustosOperacionais.test.js
//
// Contrato de Ads e Full na Central + cascata da composição financeira.
// Cenários pedidos: Ads sem dados × Ads comprovadamente zerado, período parcial,
// contas distintas do mesmo cliente, Full com risco de duplicar frete, Full sem
// fonte, e a identidade da cascata com o resultado do motor.
const test = require("node:test");
const assert = require("node:assert/strict");
const ops = require("../services/centralVendas/centralVendasCustosOperacionais");
const { cascataDoPeriodo, CATALOGO } = require("../services/centralVendas/centralVendasComposicaoFinanceira");
const service = require("../services/centralVendas/centralVendasService");

const NOV = { dateFrom: "2026-11-01", dateTo: "2026-11-30" };
const NOV_PARCIAL = { dateFrom: "2026-11-01", dateTo: "2026-11-15" };
const adsMes = (o = {}) => ({ escopo: "conta", clienteContaId: 21, cobertura: { tipo: "mes", mes: "2026-11" }, disponivel: true, investimentoAds: 1200, gmvAds: 9600, gmvDireto: 7000, gmvIndireto: 2600, ...o });
const fullMes = (o = {}) => ({
  clienteContaId: 21, mes: "2026-11", disponivel: true, definitivo: true,
  componentes: [
    { grupo: "armazenagem", valor: 310.4, lancamentos: 30 },
    { grupo: "armazenamento_prolongado", valor: 12.1, lancamentos: 2 },
    { grupo: "coleta", valor: 45, lancamentos: 1 },
    { grupo: "retirada", valor: 0, lancamentos: 0 },
  ],
  ...o,
});

test("mês inteiro, mesma conta: resultado operacional = venda − Ads − Full, métricas com denominador explícito", () => {
  const r = ops.resultadoOperacional({ periodo: NOV, clienteContaId: 21, resultadoVendaCentavos: 2500000, receitaProdutoCentavos: 10000000, fontesAds: [adsMes()], fontesFull: [fullMes()] });
  assert.equal(r.ads.estado, "observado");
  assert.equal(r.ads.investimento.centavos, 120000);
  assert.equal(r.ads.metricas.roas.valor, 8);
  assert.equal(r.ads.metricas.acos.valor, 12.5);
  assert.equal(r.ads.metricas.tacos.valor, 1.2);
  assert.equal(r.ads.metricas.tacos.denominador.nome, "receita de produtos da Central (pedidos no resultado)");
  assert.equal(r.full.total.centavos, 36750);
  assert.deepEqual(r.full.componentes.map((x) => x.grupo), ["armazenagem", "armazenamento_prolongado", "coleta", "retirada"]);
  assert.equal(r.full.estado, "consolidado");
  assert.equal(r.resultadoAposAds.centavos, 2380000);
  assert.equal(r.resultadoOperacional.centavos, 2343250);
  assert.equal(r.resultadoOperacional.margemPercentual, 23.43);
  assert.deepEqual(r.pendencias, []);
});

test("período parcial com fonte mensal: valor exibido como referência, mas incompatível e fora do resultado", () => {
  const r = ops.resultadoOperacional({ periodo: NOV_PARCIAL, clienteContaId: 21, resultadoVendaCentavos: 1000000, receitaProdutoCentavos: 4000000, fontesAds: [adsMes()], fontesFull: [fullMes()] });
  assert.equal(r.ads.compativel, false);
  assert.equal(r.ads.motivoIncompativel, "periodo_parcial_com_fonte_mensal");
  assert.equal(r.ads.investimento.centavos, 120000, "o total mensal continua visível");
  assert.equal(r.ads.metricas.tacos.valor, null, "TACOS não mistura janelas");
  assert.equal(r.resultadoAposAds.centavos, null);
  assert.equal(r.resultadoOperacional.centavos, null);
  assert.ok(r.pendencias.includes("ads_periodo_parcial_com_fonte_mensal"));
  assert.ok(r.pendencias.includes("full_periodo_parcial_com_fonte_mensal"));
});

test("período parcial com Ads em janela EXATA: compatível", () => {
  const janela = adsMes({ cobertura: { tipo: "janela", ...NOV_PARCIAL }, investimentoAds: 500, gmvAds: 3000 });
  const r = ops.avaliarAds({ periodo: NOV_PARCIAL, clienteContaId: 21, fontesAds: [adsMes(), janela], receitaProdutoCentavos: 4000000 });
  assert.equal(r.compativel, true);
  assert.equal(r.investimento.centavos, 50000);
  assert.equal(r.metricas.tacos.valor, 1.25);
});

test("Ads sem dados ≠ Ads zerado", () => {
  const sem = ops.avaliarAds({ periodo: NOV, clienteContaId: 21, fontesAds: [adsMes({ disponivel: false, codigo: "NO_ADS_PERMISSION" })], receitaProdutoCentavos: 100 });
  assert.equal(sem.estado, "indisponivel");
  assert.deepEqual(sem.codigos, ["NO_ADS_PERMISSION"]);
  assert.equal(sem.investimento.centavos, null);
  const nenhuma = ops.avaliarAds({ periodo: NOV, clienteContaId: 21, fontesAds: [], receitaProdutoCentavos: 100 });
  assert.equal(nenhuma.estado, "indisponivel");
  assert.deepEqual(nenhuma.codigos, ["SEM_FONTE"]);
  const zero = ops.avaliarAds({ periodo: NOV, clienteContaId: 21, fontesAds: [adsMes({ investimentoAds: 0, gmvAds: 0 })], receitaProdutoCentavos: 100 });
  assert.equal(zero.estado, "zero_observado");
  assert.equal(zero.investimento.centavos, 0);
  assert.equal(zero.metricas.roas.valor, null, "ROAS sem investimento não existe (não é 0)");
  const r = ops.resultadoOperacional({ periodo: NOV, clienteContaId: 21, resultadoVendaCentavos: 1000, receitaProdutoCentavos: 5000, fontesAds: [], fontesFull: [fullMes()] });
  assert.equal(r.resultadoAposAds.centavos, null);
  assert.ok(r.pendencias.includes("ads_indisponivel"));
});

test("contas distintas do mesmo cliente: fonte de outra conta e agregado do cliente são recusados", () => {
  const r = ops.avaliarAds({
    periodo: NOV, clienteContaId: 21, receitaProdutoCentavos: 100,
    fontesAds: [adsMes({ clienteContaId: 22 }), { escopo: "cliente", clienteContaId: null, cobertura: { tipo: "mes", mes: "2026-11" }, disponivel: true, investimentoAds: 9999, gmvAds: 1 }],
  });
  assert.equal(r.disponivel, false);
  assert.deepEqual(r.recusadas.map((x) => x.motivo).sort(), ["escopo_cliente_nao_e_da_conta", "outra_conta"]);
  const f = ops.avaliarFull({ periodo: NOV, clienteContaId: 21, fontesFull: [fullMes({ clienteContaId: 22 })] });
  assert.equal(f.disponivel, false);
});

test("Full: frete por venda fica de fora, estornos declarados como limitação, faturas abertas marcadas", () => {
  const f = ops.avaliarFull({ periodo: NOV, clienteContaId: 21, fontesFull: [fullMes({ definitivo: false, componentes: [...fullMes().componentes, { grupo: "frete_full", valor: 999, lancamentos: 50 }] })] });
  assert.equal(f.total.centavos, 36750, "um grupo de frete (CFFE/CFFI) nunca é somado");
  assert.ok(f.subtiposExcluidos.includes("CFFE") && f.subtiposExcluidos.includes("CFFI"));
  assert.equal(f.estado, "observado_faturas_abertas");
  assert.ok(f.limitacoes.some((l) => l.startsWith("estornos_nao_abatidos")));
});

test("Full sem fonte é indisponível mesmo sem venda Full (armazenagem independe da venda)", () => {
  const r = ops.resultadoOperacional({ periodo: NOV, clienteContaId: 21, resultadoVendaCentavos: 1000, receitaProdutoCentavos: 5000, fontesAds: [adsMes()], fontesFull: [] });
  assert.equal(r.full.disponivel, false);
  assert.equal(r.resultadoAposAds.centavos, 1000 - 120000);
  assert.equal(r.resultadoOperacional.centavos, null);
  assert.ok(r.pendencias.includes("full_indisponivel"));
});

test("dois meses inteiros: soma por mês; falta de um mês torna o período indisponível", () => {
  const per = { dateFrom: "2026-10-01", dateTo: "2026-11-30" };
  const out = adsMes({ cobertura: { tipo: "mes", mes: "2026-10" }, investimentoAds: 800, gmvAds: 4000 });
  const ok = ops.avaliarAds({ periodo: per, clienteContaId: 21, fontesAds: [out, adsMes()], receitaProdutoCentavos: 100 });
  assert.equal(ok.investimento.centavos, 200000);
  const falta = ops.avaliarAds({ periodo: per, clienteContaId: 21, fontesAds: [adsMes()], receitaProdutoCentavos: 100 });
  assert.equal(falta.disponivel, false);
  assert.equal(falta.cobertura[0].estado, "sem_fonte");
});

test("Ads por produto só com anúncios da mesma janela", () => {
  const anuncios = [{ itemId: "MLB1", metrics: { cost: 100, directAmount: 700, indirectAmount: 50 } }, { itemId: "MLB2", metrics: { cost: 20, directAmount: 0, indirectAmount: 0 } }];
  const r = ops.avaliarAds({ periodo: NOV, clienteContaId: 21, fontesAds: [adsMes({ anuncios })], receitaProdutoCentavos: 100 });
  assert.deepEqual(r.produtos.porMlb.find((p) => p.mlb === "MLB1"), { mlb: "MLB1", custoCentavos: 10000, receitaDiretaCentavos: 70000, receitaIndiretaCentavos: 5000 });
  const parcial = ops.avaliarAds({ periodo: NOV_PARCIAL, clienteContaId: 21, fontesAds: [adsMes({ anuncios })], receitaProdutoCentavos: 100 });
  assert.equal(parcial.produtos, null);
});

test("adaptador do cache do Financeiro: consolidado depois de M+1 dia 3", () => {
  const f = ops.fonteAdsDoCacheFinanceiro({ disponivel: true, investimentoAds: 10, gmvAds: 50, consultadoEm: "2026-12-05T10:00:00.000Z" }, { clienteContaId: 21, mes: "2026-11" });
  assert.equal(f.consolidado, true);
  const g = ops.fonteAdsDoCacheFinanceiro({ disponivel: true, investimentoAds: 10, gmvAds: 50, consultadoEm: "2026-12-02T10:00:00.000Z" }, { clienteContaId: 21, mes: "2026-11" });
  assert.equal(g.consolidado, false);
  assert.equal(ops.fonteAdsDoCacheFinanceiro(null, { clienteContaId: 21, mes: "2026-11" }).disponivel, false);
});

// ─── cascata ────────────────────────────────────────────────────────────────────────────
test("cascata reproduz o resultado do motor e expõe resíduo, cancelados e bloqueados", () => {
  const snapshot = {
    pedidos: [
      { id: 1, pedido_id: "A", status: "paid", faturamento: 100, resultado: 40, margem_contribuicao_percentual: 40, confianca: "confiavel", payload_json: {} },
      { id: 2, pedido_id: "B", status: "paid", faturamento: 50, resultado: 30, confianca: "parcial", payload_json: {} },
      { id: 3, pedido_id: "C", status: "cancelled", faturamento: 80, resultado: 10, confianca: "confiavel", payload_json: {} },
      { id: 4, pedido_id: "D", status: "paid", faturamento: 60, resultado: null, confianca: "bloqueado", payload_json: {} },
      { id: 5, pedido_id: "E", status: "paid", faturamento: 70, resultado: 9, confianca: "parcial", payload_json: {} },
    ],
    itens: [],
    componentes: [
      { pedido_row_id: 1, tipo: "tarifa_venda", valor: -12 }, { pedido_row_id: 1, tipo: "frete_seller", valor: -8 },
      { pedido_row_id: 1, tipo: "custo_produto", valor: -30 }, { pedido_row_id: 1, tipo: "imposto_interno", valor: -10 },
      { pedido_row_id: 1, tipo: "receita_envio", valor: 5 },
      { pedido_row_id: 2, tipo: "tarifa_venda", valor: -5 }, { pedido_row_id: 2, tipo: "custo_produto", valor: -15 },
      { pedido_row_id: 5, tipo: "tarifa_venda", valor: -7 }, { pedido_row_id: 5, tipo: "custo_produto", valor: -40 }, { pedido_row_id: 5, tipo: "imposto_interno", valor: -7 },
    ],
  };
  const pedidos = service.buildPedidos(snapshot);
  const cas = cascataDoPeriodo(pedidos);
  assert.equal(cas.pedidosNoResultado, 3);
  assert.equal(cas.fora.cancelados, 1);
  assert.equal(cas.fora.semResultado, 1);
  assert.equal(cas.fora.receitaSemResultado, 6000);
  assert.equal(cas.linhas.receita_produto.centavos, 22000);
  assert.equal(cas.linhas.frete_seller.ausentes, 2, "frete ausente é contado, não vira zero silencioso");
  assert.equal(cas.resultadoVenda.centavos, 7900);
  assert.equal(cas.resultadoVenda.margemPercentual, 35.91);
  // pedido E: 70 − 7 − 40 − 7 = 16, motor gravou 9 ⇒ resíduo exposto (ex.: ajuste de plataforma)
  assert.equal(cas.identidade.fecha, false);
  assert.deepEqual(cas.identidade.residuos, [{ rowId: 5, pedidoId: "E", residuoCentavos: -700 }]);
  assert.equal(cas.conciliacao.receita_envio, 500);
});

test("catálogo: todo item declara sinal, escopo, fonte e onde entra; Ads/Full nunca no resultado de venda", () => {
  for (const l of CATALOGO) {
    assert.ok(l.id && l.rotulo && l.fonte && Array.isArray(l.escopos) && l.escopos.length, l.id);
    assert.ok([-1, 0, 1].includes(l.sinal), l.id);
    assert.ok(l.entraEm.length === 1, l.id);
    if (l.sinal !== 0) assert.ok(["resultado_venda", "resultado_operacional"].includes(l.entraEm[0]), l.id);
  }
  assert.equal(CATALOGO.find((l) => l.id === "ads").entraEm[0], "resultado_operacional");
  assert.equal(CATALOGO.find((l) => l.id === "full").entraEm[0], "resultado_operacional");
  assert.equal(CATALOGO.find((l) => l.id === "descontos").sinal, 0, "desconto já está fora da receita: não subtrair de novo");
  assert.equal(CATALOGO.find((l) => l.id === "rebate").sinal, 0, "rebate nunca somado ao resultado");
});
