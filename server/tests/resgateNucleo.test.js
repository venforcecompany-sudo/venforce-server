// VenForce Resgate — Entrega A: contrato financeiro, evidências de frete,
// recomendação com recotação por preço, classificação, histórico, matriz de
// compatibilidade, plano de ativação e o cotador compartilhado em modo auditoria.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { componenteFrete, ORDEM_EVIDENCIA_FRETE, CONFIANCA, compararComRealizado, familiaLogistica } = require("../services/resgate/resgateEvidencias");
const { montarContratoFinanceiro, BLOQUEIO } = require("../services/resgate/resgateContrato");
const { recomendarPreco, simularPrecos } = require("../services/resgate/resgateRecomendacao");
const { classificarSituacao, classificarOrigem, SITUACAO, ORIGEM, ACAO, exposicao } = require("../services/resgate/resgateClassificacao");
const { montarHistoricoItem } = require("../services/resgate/resgateHistorico");
const { montarMatriz, DECISAO } = require("../services/resgate/resgateCompatibilidade");
const { planoDeAtivacao } = require("../services/resgate/resgateAtivacao");
const { NIVEIS } = require("../services/shared/freteCotacaoConfiavel");

let ok = 0;
async function t(nome, fn) {
  try { await fn(); ok++; console.log(`  ✓ ${nome}`); } catch (e) { console.error(`  ✗ ${nome}\n    ${e.stack}`); process.exitCode = 1; }
}

const completo = (extra = {}) => ({
  conta: { clienteId: 1, clienteContaId: 10, sellerId: "S1" },
  anuncio: { itemId: "MLB1", logisticType: "cross_docking", status: "active" },
  precos: { cheio: 100, vigente: 100, promocional: null, observadoEm: "2026-11-12T10:00:00Z" },
  comissao: { valor: 14, percentual: 0.14, precoBase: 100 },
  frete: { valor: 18, freteQualidade: { nivel: NIVEIS.COTADO, avaliadoEm: "2026-11-12T10:00:00Z" } },
  custo: { valor: 40 }, imposto: { percentual: 0.13 }, taxaFixa: { valor: 0 },
  ...extra,
});

(async () => {
  console.log("Evidências de frete");
  await t("ordem de evidência = ordem do avaliarFrete (cotado → históricas → custo cobrado → declaradas → antigo → desconhecido)", () => {
    assert.deepStrictEqual(ORDEM_EVIDENCIA_FRETE.map((x) => x.nivel), [NIVEIS.COTADO, NIVEIS.DIMENSOES, NIVEIS.CUSTO_COBRADO, NIVEIS.DECLARADAS, "historico_antigo", NIVEIS.DESCONHECIDO]);
    assert.strictEqual(ORDEM_EVIDENCIA_FRETE.find((x) => x.nivel === NIVEIS.DESCONHECIDO).projeta, false);
  });
  await t("frete sem avaliação = nao_verificada; avaliado = confiança do nível; nulo = desconhecida", () => {
    assert.strictEqual(componenteFrete({ valor: 7.75, logisticType: "cross_docking" }).confianca, CONFIANCA.NAO_VERIFICADA);
    assert.strictEqual(componenteFrete({ valor: 13.85, freteQualidade: { nivel: NIVEIS.DECLARADAS, confianca: "media" }, logisticType: "cross_docking" }).confianca, CONFIANCA.MEDIA);
    assert.strictEqual(componenteFrete({ valor: 12, freteQualidade: { nivel: NIVEIS.CUSTO_COBRADO, confianca: "baixa" }, logisticType: "cross_docking" }).confianca, CONFIANCA.BAIXA);
    assert.strictEqual(componenteFrete({ valor: 12, freteQualidade: { nivel: NIVEIS.DIMENSOES, confianca: "media", historicoAntigo: true }, logisticType: "cross_docking" }).confianca, CONFIANCA.BAIXA);
    const d = componenteFrete({ valor: null, freteQualidade: { nivel: NIVEIS.DESCONHECIDO }, logisticType: "cross_docking" });
    assert.strictEqual(d.valor, null); assert.strictEqual(d.confianca, CONFIANCA.DESCONHECIDA);
  });
  await t("logística a combinar: frete não se aplica (não é zero inventado)", () => {
    const c = componenteFrete({ valor: null, logisticType: "not_specified" });
    assert.strictEqual(c.aplicavel, false); assert.strictEqual(c.confianca, CONFIANCA.NAO_APLICAVEL);
  });
  await t("famílias de logística (Full, Coleta, Agência, Flex, a combinar)", () => {
    assert.deepStrictEqual(["fulfillment", "cross_docking", "xd_drop_off", "self_service", "custom", null, "xyz"].map(familiaLogistica), ["full", "coleta", "agencia", "flex", "a_combinar", "desconhecida", "outra"]);
  });
  await t("projetado × realizado: bate, subestimado, sem amostra comparável", () => {
    const r = [{ precoUnitario: 99, frete: 18.05 }, { precoUnitario: 101, frete: 17.95 }, { precoUnitario: 150, frete: 30 }];
    assert.strictEqual(compararComRealizado({ projetado: 18, realizados: r, preco: 100 }).bate, true);
    const s = compararComRealizado({ projetado: 7.75, realizados: r, preco: 100 });
    assert.strictEqual(s.subestimado, true); assert.strictEqual(s.amostras, 2);
    assert.strictEqual(compararComRealizado({ projetado: 18, realizados: r, preco: 60 }), null);
  });

  console.log("Contrato financeiro");
  await t("completo: lucro = P − P·imp − comissão − frete − taxa − custo", () => {
    const c = montarContratoFinanceiro(completo());
    assert.strictEqual(c.resultado.calculavel, true); assert.strictEqual(c.resultado.lucro, 15); assert.strictEqual(c.resultado.margemPercent, 15);
    assert.strictEqual(c.margemConfiavel, true); assert.strictEqual(c.bloqueios.length, 0); assert.strictEqual(c.versao, "resgate-contrato/1");
  });
  for (const [campo, mut, codigo] of [
    ["frete", (e) => { e.frete = { valor: null }; }, BLOQUEIO.FRETE_DESCONHECIDO],
    ["custo", (e) => { e.custo = { valor: "" }; }, BLOQUEIO.CUSTO_AUSENTE],
    ["imposto", (e) => { e.imposto = { percentual: null }; }, BLOQUEIO.IMPOSTO_AUSENTE],
    ["taxa fixa", (e) => { e.taxaFixa = {}; }, BLOQUEIO.TAXA_FIXA_AUSENTE],
    ["comissão", (e) => { e.comissao = { valor: undefined }; }, BLOQUEIO.COMISSAO_AUSENTE],
    ["preço", (e) => { e.precos = { vigente: null }; }, BLOQUEIO.PRECO_AUSENTE],
  ]) {
    await t(`${campo} ausente → sem margem e bloqueio ${codigo} (nunca vira 0)`, () => {
      const e = completo(); mut(e);
      const c = montarContratoFinanceiro(e);
      assert.strictEqual(c.resultado.calculavel, false); assert.strictEqual(c.resultado.lucro, null); assert.strictEqual(c.resultado.margemPercent, null);
      assert.ok(c.bloqueios.some((b) => b.codigo === codigo && b.resolveCom));
    });
  }
  await t("zero declarado é zero (taxa fixa 0, frete a combinar)", () => {
    const c = montarContratoFinanceiro(completo({ anuncio: { itemId: "X", logisticType: "custom" }, frete: { valor: null } }));
    assert.strictEqual(c.resultado.calculavel, true); assert.strictEqual(c.resultado.lucro, 33);
  });
  await t("subsídio ML entra UMA vez no lucro e não mexe na comissão", () => {
    const c = montarContratoFinanceiro(completo({ precos: { cheio: 120, vigente: 100, promocional: 100 }, promocao: { ativa: true, subsidioMl: 5, tipo: "SMART" } }));
    assert.strictEqual(c.resultado.lucro, 20); assert.strictEqual(c.componentes.comissao.valor, 14);
    assert.strictEqual(c.componentes.valorReconhecidoVendedor.valor, 105);
    assert.strictEqual(c.componentes.descontoVendedor.valor, 15);
  });
  await t("promoção com subsídio desconhecido: margem é limite inferior e declarada", () => {
    const c = montarContratoFinanceiro(completo({ precos: { cheio: 120, vigente: 100, promocional: 100 }, promocao: { ativa: true, subsidioMl: null } }));
    assert.strictEqual(c.resultado.calculavel, true); assert.strictEqual(c.resultado.limiteInferior, true);
    assert.ok(c.pendencias.some((p) => p.codigo === "SUBSIDIO_DESCONHECIDO"));
    const amb = montarContratoFinanceiro(completo({ precos: { cheio: 120, vigente: 100, promocional: 100 }, promocao: { ativa: true, subsidioMl: 5, ambigua: true } }));
    assert.strictEqual(amb.resultado.lucro, 15); assert.ok(amb.pendencias.some((p) => p.codigo === "REBATE_AMBIGUO"));
  });
  await t("frete não verificado (conta fora da liberação): calcula, mas margemConfiavel=false", () => {
    const c = montarContratoFinanceiro(completo({ frete: { valor: 7.75, freteQualidade: null } }));
    assert.strictEqual(c.resultado.calculavel, true); assert.strictEqual(c.margemConfiavel, false);
    assert.strictEqual(c.componentes.frete.status, "nao_verificado");
  });
  await t("snapshot legado de conta liberada não serve para decidir; Flex declara entregador fora", () => {
    assert.strictEqual(montarContratoFinanceiro(completo({ legadoNaoVerificado: true })).margemConfiavel, false);
    const f = montarContratoFinanceiro(completo({ frete: { valor: 18, freteQualidade: { nivel: NIVEIS.COTADO, modalidade: { custosForaDaMargem: ["entregador_flex"] } } } }));
    assert.ok(f.pendencias.some((p) => p.codigo === "FLEX_ENTREGADOR_FORA"));
  });
  await t("inconsistência: comissão cotada em outro preço", () => {
    const c = montarContratoFinanceiro(completo({ comissao: { valor: 14, precoBase: 90 } }));
    assert.ok(c.inconsistencias.some((x) => x.codigo === "COMISSAO_DE_OUTRO_PRECO"));
  });

  console.log("Simulação e recomendação (recotação por preço)");
  // Cotação fake com faixa: < R$ 79 frete 8,25 e comissão 12% + 6,75 fixo; ≥ 79 frete 18 e 14%.
  const chamadas = [];
  const cotar = async (p) => { chamadas.push(p); return p < 79 ? { comissaoValor: Math.round((p * 0.12 + 6.75) * 100) / 100, comissaoPercentual: 0.12, fretePrevisto: 8.25, freteQualidade: { nivel: NIVEIS.COTADO } } : { comissaoValor: Math.round(p * 0.14 * 100) / 100, comissaoPercentual: 0.14, fretePrevisto: 18, freteQualidade: { nivel: NIVEIS.COTADO } }; };
  await t("simular vários preços recota comissão e frete em CADA preço", async () => {
    const s = await simularPrecos(completo({ precos: { vigente: 70 } }), [70, 85], cotar);
    assert.strictEqual(s[0].contrato.componentes.frete.valor, 8.25); assert.strictEqual(s[1].contrato.componentes.frete.valor, 18);
    assert.strictEqual(s[1].contrato.componentes.comissao.valor, 11.9);
  });
  await t("recomendação cruza a faixa de R$ 79 e verifica a meta no preço final", async () => {
    const r = await recomendarPreco(completo({ precos: { vigente: 70 } }), { meta: 0.15, cotarEmPreco: cotar });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(r.preco >= 79, `preço ${r.preco}`);
    assert.ok(r.contrato.resultado.margem >= 0.15 - 1e-9);
    assert.strictEqual(r.contrato.componentes.frete.valor, 18);
  });
  await t("sem custo/imposto/taxa: nenhuma recomendação (motivo explícito)", async () => {
    const r = await recomendarPreco(completo({ custo: { valor: null } }), { meta: 0.15, cotarEmPreco: cotar });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.motivo, "ENTRADA_ESSENCIAL_DESCONHECIDA");
  });
  await t("frete desconhecido no preço candidato: nenhuma recomendação", async () => {
    const r = await recomendarPreco(completo(), { meta: 0.2, cotarEmPreco: async () => ({ comissaoValor: 14, comissaoPercentual: 0.14, fretePrevisto: null }) });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.motivo, "FRETE_DESCONHECIDO_NO_PRECO");
  });

  console.log("Classificação");
  const meta = { valor: 0.15, origem: "configurada" };
  await t("margem exibida maior que a real = MARGEM_ANTIGA_INFLADA", () => {
    const c = montarContratoFinanceiro(completo());
    const s = classificarSituacao({ contrato: c, margemExibida: 25, precoExibido: 100, meta });
    assert.strictEqual(s.situacao, SITUACAO.MARGEM_ANTIGA_INFLADA); assert.strictEqual(s.inflada, true);
  });
  await t("dados faltando = DADOS_INSUFICIENTES; frete não verificado = MARGEM_DESCONHECIDA", () => {
    assert.strictEqual(classificarSituacao({ contrato: montarContratoFinanceiro(completo({ custo: {} })), meta }).situacao, SITUACAO.DADOS_INSUFICIENTES);
    const s = classificarSituacao({ contrato: montarContratoFinanceiro(completo({ frete: { valor: 18 } })), meta });
    assert.strictEqual(s.situacao, SITUACAO.MARGEM_DESCONHECIDA); assert.strictEqual(s.acao, ACAO.VERIFICAR_FRETE);
  });
  await t("abaixo da meta correto, prejuízo, preço ok, promoção subsidiada, limite inferior", () => {
    assert.strictEqual(classificarSituacao({ contrato: montarContratoFinanceiro(completo({ custo: { valor: 45 } })), meta }).situacao, SITUACAO.ABAIXO_DA_META);
    assert.strictEqual(classificarSituacao({ contrato: montarContratoFinanceiro(completo({ custo: { valor: 70 } })), meta }).situacao, SITUACAO.PREJUIZO);
    assert.strictEqual(classificarSituacao({ contrato: montarContratoFinanceiro(completo()), meta }).situacao, SITUACAO.PRECO_OK);
    assert.strictEqual(classificarSituacao({ contrato: montarContratoFinanceiro(completo({ precos: { cheio: 120, vigente: 100, promocional: 100 }, promocao: { ativa: true, subsidioMl: 5 } })), meta }).situacao, SITUACAO.PROMOCAO_SUBSIDIADA);
    assert.strictEqual(classificarSituacao({ contrato: montarContratoFinanceiro(completo({ custo: { valor: 45 }, precos: { cheio: 120, vigente: 100, promocional: 100 }, promocao: { ativa: true } })), meta }).situacao, SITUACAO.MARGEM_DESCONHECIDA);
  });
  await t("margem abaixo de 15% não é erro: depende da meta configurada", () => {
    const c = montarContratoFinanceiro(completo({ custo: { valor: 45 } }));
    assert.strictEqual(classificarSituacao({ contrato: c, meta: { valor: 0.08 } }).situacao, SITUACAO.PRECO_OK);
  });
  await t("snapshot de outro preço = SNAPSHOT_DESATUALIZADO quando a margem real está ok", () => {
    const s = classificarSituacao({ contrato: montarContratoFinanceiro(completo()), margemExibida: 15, precoExibido: 95, meta });
    assert.strictEqual(s.situacao, SITUACAO.SNAPSHOT_DESATUALIZADO);
  });
  await t("exposição: inflada = lucro superestimado × unidades; desconhecida = faturamento exposto", () => {
    const c = montarContratoFinanceiro(completo());
    const e = exposicao({ contrato: c, situacao: SITUACAO.MARGEM_ANTIGA_INFLADA, unidades30d: 10, margemExibida: 25 });
    assert.strictEqual(e.tipo, "lucro_superestimado"); assert.strictEqual(e.valor, 100);
    const d = exposicao({ contrato: montarContratoFinanceiro(completo({ custo: {} })), situacao: SITUACAO.DADOS_INSUFICIENTES, faturamento30d: 500 });
    assert.strictEqual(d.tipo, "faturamento_exposto"); assert.strictEqual(d.valor, 500);
  });

  console.log("Histórico (nunca inventado)");
  const agora = new Date("2026-11-12T12:00:00Z");
  await t("sem fontes → HISTORICO_INSUFICIENTE; só snapshot igual → sem alteração, com ressalva do log manual", () => {
    assert.strictEqual(classificarOrigem(montarHistoricoItem({ agora })).origem, ORIGEM.HISTORICO_INSUFICIENTE);
    const h = montarHistoricoItem({ snapshot: { preco: 100, em: "2026-11-10T00:00:00Z" }, sync: { preco: 100, em: "2026-11-11T00:00:00Z" }, agora });
    const o = classificarOrigem(h);
    assert.strictEqual(o.origem, ORIGEM.SEM_ALTERACAO_REGISTRADA); assert.ok(/não eram registradas/.test(o.motivo));
  });
  await t("preço mudou entre observações sem evento → origem indeterminada e recente", () => {
    const h = montarHistoricoItem({ snapshot: { preco: 100, em: "2026-11-05T00:00:00Z" }, aoVivo: { preco: 89.9, em: "2026-11-12T11:00:00Z" }, agora });
    assert.strictEqual(classificarOrigem(h).origem, ORIGEM.ALTERADO_ORIGEM_INDETERMINADA); assert.strictEqual(h.mudancaRecente, true);
  });
  await t("evento do VenForce explica a mudança → automação / manual", () => {
    const base = { snapshot: { preco: 100, em: "2026-11-05T00:00:00Z" }, aoVivo: { preco: 89.9, em: "2026-11-12T11:00:00Z" }, agora };
    assert.strictEqual(classificarOrigem(montarHistoricoItem({ ...base, eventos: [{ tipo: "rebate_participacao", em: "2026-11-08T00:00:00Z", alteraPreco: true, precoNovo: 89.9 }] })).origem, ORIGEM.ALTERADO_AUTOMACAO);
    assert.strictEqual(classificarOrigem(montarHistoricoItem({ ...base, eventos: [{ tipo: "preco_manual", em: "2026-11-08T00:00:00Z", alteraPreco: true, precoNovo: 89.9 }] })).origem, ORIGEM.ALTERADO_MANUAL);
  });
  await t("troca de REGIME no preço vendido e last_updated do ML entram como sinais datados", () => {
    const v = { precos: [{ data: "2026-10-20", preco: 100 }, { data: "2026-10-25", preco: 100 }, { data: "2026-11-08", preco: 92 }, { data: "2026-11-09", preco: 92 }] };
    const h = montarHistoricoItem({ vendas: v, aoVivo: { preco: 92, em: agora.toISOString(), precoBaseAtualizadoEm: "2026-11-09T08:00:00Z" }, agora });
    assert.ok(h.trocaNasVendas && h.trocaNasVendas.para === 92); assert.strictEqual(h.mudancaRecente, true);
    assert.ok(h.linhaDoTempo.some((x) => x.tipo === "preco_base_atualizado_ml"));
  });
  await t("falso positivo evitado: venda isolada com cupom, oscilação em promoção e efetivo × cheio não são 'mudança'", () => {
    const isolada = montarHistoricoItem({ vendas: { precos: [{ data: "2026-11-01", preco: 100 }, { data: "2026-11-05", preco: 88 }, { data: "2026-11-08", preco: 100 }] }, agora });
    assert.strictEqual(isolada.trocaNasVendas, null);
    const promo = montarHistoricoItem({ vendas: { precos: [{ data: "2026-10-20", preco: 100 }, { data: "2026-10-25", preco: 100 }, { data: "2026-11-08", preco: 92 }, { data: "2026-11-09", preco: 92 }] }, promocaoAtiva: true, agora });
    assert.strictEqual(promo.trocaNasVendas, null);
    // cadastro (cheio) 139,90 × snapshot efetivo 113,78 com promoção: séries diferentes, nada mudou.
    const series = montarHistoricoItem({ snapshot: { preco: 113.78, precoCheio: 139.9, em: "2026-11-12T20:00:00Z" }, sync: { preco: 139.9, em: "2026-11-12T18:00:00Z" }, agora });
    assert.strictEqual(series.mudancaDetectada, null); assert.strictEqual(classificarOrigem(series).origem, ORIGEM.SEM_ALTERACAO_REGISTRADA);
    const cadastro = montarHistoricoItem({ snapshot: { preco: 120, precoCheio: 120, em: "2026-11-10T20:00:00Z" }, sync: { preco: 43.9, em: "2026-11-12T18:00:00Z" }, agora });
    assert.strictEqual(cadastro.mudancaDetectada, null, "cadastro sincronizado é só informativo");
    const cheioMudou = montarHistoricoItem({ snapshot: { preco: 120, precoCheio: 120, em: "2026-11-10T20:00:00Z" }, aoVivo: { preco: 129.9, precoCheio: 129.9, em: "2026-11-12T18:00:00Z" }, agora });
    assert.strictEqual(classificarOrigem(cheioMudou).origem, ORIGEM.ALTERADO_ORIGEM_INDETERMINADA);
    // Diferença entre um relatório de agosto e o snapshot de novembro: mudou, mas a data é desconhecida → não "recente".
    const antigo = montarHistoricoItem({ relatorios: [{ em: "2026-08-01T00:00:00Z", preco: 75.9 }], snapshot: { preco: 74.67, em: "2026-11-11T00:00:00Z" }, agora });
    assert.strictEqual(classificarOrigem(antigo).origem, ORIGEM.ALTERADO_ORIGEM_INDETERMINADA); assert.strictEqual(antigo.mudancaRecente, false);
  });

  console.log("Matriz de compatibilidade e ativação");
  const item = (fam, bate, extra = {}) => ({ familiaLogistica: fam, statusAnuncio: "active", vendas30d: { unidades: 5 }, comparacaoFrete: bate === null ? null : { bate, subestimado: !bate, superestimado: false }, contrato: { confiancaGeral: "alta", bloqueios: [], margemConfiavel: true, componentes: { frete: { nivel: "cotado_ml", valor: 10, aplicavel: true } } }, situacao: "PRECO_OK", ...extra });
  await t("≥5 comparações e ≥90% batem em todas as modalidades com volume → LIBERAVEL e validada", () => {
    const m = montarMatriz({ conta: { clienteContaId: 1, sellerId: "S" }, itens: Array.from({ length: 10 }, () => item("coleta", true)) });
    assert.strictEqual(m.decisao, DECISAO.LIBERAVEL); assert.strictEqual(m.financeiramenteValidada, true);
  });
  await t("cotação diverge do cobrado → NAO_LIBERAVEL e não validada", () => {
    const m = montarMatriz({ conta: { clienteContaId: 1, sellerId: "S" }, itens: [...Array.from({ length: 4 }, () => item("coleta", true)), ...Array.from({ length: 6 }, () => item("coleta", false))] });
    assert.strictEqual(m.decisao, DECISAO.NAO_LIBERAVEL); assert.strictEqual(m.financeiramenteValidada, false);
  });
  await t("sem comparações nem amostra ao vivo → SEM_DADOS; Flex nunca 'validada' (entregador externo)", () => {
    assert.strictEqual(montarMatriz({ conta: {}, itens: [item("coleta", null)] }).decisao, DECISAO.SEM_DADOS);
    const m = montarMatriz({ conta: {}, itens: [...Array.from({ length: 10 }, () => item("coleta", true)), ...Array.from({ length: 10 }, () => item("flex", true))] });
    assert.strictEqual(m.modalidades.flex.status, "PARCIAL"); assert.strictEqual(m.financeiramenteValidada, false);
  });
  await t("frete abaixo do cobrado em 10–20% = INCONCLUSIVA; só acima do cobrado = CONSERVADORA; ambos com ressalvas", () => {
    const m = montarMatriz({ conta: {}, itens: [...Array.from({ length: 17 }, () => item("coleta", true)), ...Array.from({ length: 3 }, () => item("coleta", false))] });
    assert.strictEqual(m.modalidades.coleta.status, "INCONCLUSIVA"); assert.strictEqual(m.decisao, DECISAO.LIBERAVEL_COM_RESSALVAS);
    assert.ok(m.motivos.some((x) => /85% batem, 3 abaixo e 0 acima do cobrado, de 20/.test(x)));
    // Projeção ACIMA do cobrado (desconto depois da venda): conservadora, não bloqueia nem valida.
    const sup = (b) => ({ ...item("agencia", b), comparacaoFrete: { bate: b, subestimado: false, superestimado: !b } });
    const c = montarMatriz({ conta: {}, itens: [...Array.from({ length: 12 }, () => sup(true)), ...Array.from({ length: 8 }, () => sup(false))] });
    assert.strictEqual(c.modalidades.agencia.status, "CONSERVADORA"); assert.strictEqual(c.decisao, DECISAO.LIBERAVEL_COM_RESSALVAS); assert.strictEqual(c.financeiramenteValidada, false);
    const lib = montarMatriz({ conta: {}, liberadaHoje: true, itens: Array.from({ length: 10 }, () => item("coleta", false)) });
    assert.strictEqual(lib.decisao, DECISAO.JA_LIBERADA); assert.ok(lib.motivos.some((x) => /Mesmo liberada/.test(x)));
  });
  await t("exposição de margem desconhecida é faturamento exposto, mesmo com contrato calculável (limite inferior)", () => {
    const c = montarContratoFinanceiro(completo({ custo: { valor: 45 }, precos: { cheio: 120, vigente: 100, promocional: 100 }, promocao: { ativa: true } }));
    const e = exposicao({ contrato: c, situacao: SITUACAO.MARGEM_DESCONHECIDA, unidades30d: 4, faturamento30d: 400 });
    assert.strictEqual(e.tipo, "faturamento_exposto"); assert.strictEqual(e.valor, 400);
  });
  await t("plano de ativação: listas explícitas (sem *), as duas variáveis juntas, alerta de inconsistência", () => {
    const contas = [
      { resumo: { clienteContaId: 87, sellerId: "2433", riscoFinanceiro30d: 10 }, matriz: { decisao: DECISAO.JA_LIBERADA, motivos: [], totais: {} } },
      { resumo: { clienteContaId: 18, sellerId: "1181", riscoFinanceiro30d: 500 }, matriz: { decisao: DECISAO.LIBERAVEL, motivos: [], totais: { desconhecidoAoVivo: 0 } } },
      { resumo: { clienteContaId: 66, sellerId: "2348", riscoFinanceiro30d: 50 }, matriz: { decisao: DECISAO.NAO_LIBERAVEL, motivos: ["x"], totais: {} } },
    ];
    const p = planoDeAtivacao({ contas, env: { FRETE_COTACAO_CONFIAVEL_SELLERS: "2433", FRETE_LEGADO_BLOQUEAR_CONTAS: "" } });
    assert.strictEqual(p.envProposto.FRETE_COTACAO_CONFIAVEL_SELLERS, "2433,1181");
    assert.strictEqual(p.envProposto.FRETE_LEGADO_BLOQUEAR_CONTAS, "87,18");
    assert.ok(!/\*/.test(JSON.stringify(p.envProposto)));
    assert.ok(p.alertas.some((a) => /87/.test(a)));
    // Sem a flag no processo (CLI local), JA_LIBERADA por evidência entra nas listas propostas.
    const q = planoDeAtivacao({ contas, env: {} });
    assert.strictEqual(q.envProposto.FRETE_COTACAO_CONFIAVEL_SELLERS, "2433,1181");
    assert.ok(q.alertas.some((a) => /CONFIRMAR no Render/.test(a)));
    assert.ok(p.naoLiberar.some((x) => x.clienteContaId === 66));
  });

  console.log("Cotador compartilhado em modo auditoria");
  await t("avaliarFreteSempre avalia seller FORA da liberação; o padrão não avalia (produção intacta)", async () => {
    delete process.env.FRETE_COTACAO_CONFIAVEL_SELLERS;
    const { buscarComissaoEFrete } = require("../services/shared/marketplaceCurrentQuoteService");
    const metodos = [];
    const fake = async (_c, p, o) => {
      metodos.push((o && o.method) || "GET");
      if (p.startsWith("/sites/MLB/listing_prices")) return { ok: true, status: 200, data: { sale_fee_amount: 14, sale_fee_details: { percentage_fee: 14 } } };
      if (p.includes("shipping_options/free?item_id")) return { ok: true, status: 200, data: { coverage: { all_country: { list_cost: 7.75, discount: { type: "none", rate: 0 } } } } };
      if (p.includes("include_attributes=all")) return { ok: true, status: 200, data: { attributes: [] } };
      if (p.startsWith("/orders/search")) return { ok: true, status: 200, data: { results: [] } };
      return { ok: false, status: 404 };
    };
    const args = { clienteId: 1, itemId: "MLB9", precoEfetivo: 100, listingTypeId: "gold_special", categoryId: "C", sellerId: "999", logisticType: "cross_docking", mlUserId: "999", shippingTags: ["proximity", "mandatory_free_shipping"] };
    const padrao = await buscarComissaoEFrete(args, fake);
    assert.strictEqual(padrao.fretePrevisto, 7.75); assert.strictEqual(padrao.freteQualidade, null);
    const aud = await buscarComissaoEFrete({ ...args, avaliarFreteSempre: true }, fake);
    assert.strictEqual(aud.fretePrevisto, null); assert.strictEqual(aud.freteQualidade.nivel, NIVEIS.DESCONHECIDO);
    assert.ok(metodos.every((m) => m === "GET"));
  });
  await t("nenhum consumidor de produção liga avaliarFreteSempre (só o Resgate)", () => {
    const raiz = path.join(__dirname, "..");
    const achados = [];
    const varrer = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (["node_modules", "tests", "resgate"].includes(f)) continue; if (fs.statSync(p).isDirectory()) varrer(p); else if (f.endsWith(".js") && /avaliarFreteSempre\s*:\s*true/.test(fs.readFileSync(p, "utf8"))) achados.push(p); } };
    varrer(path.join(raiz, "services")); varrer(path.join(raiz, "controllers")); varrer(path.join(raiz, "routes"));
    assert.deepStrictEqual(achados, []);
  });
  await t("o Resgate não tem constante de frete (7,75 / 13,85 / 21,75)", () => {
    const d = path.join(__dirname, "..", "services", "resgate");
    for (const f of fs.readdirSync(d)) {
      const src = fs.readFileSync(path.join(d, f), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
      assert.ok(!/\b(7[.,]75|13[.,]85|21[.,]75)\b/.test(src), `${f} contém constante de frete`);
    }
  });
  await t("/anuncios registra a alteração manual de preço (antes não havia rastro) e o Resgate lê esse evento", () => {
    const ctl = fs.readFileSync(path.join(__dirname, "..", "controllers", "meliAnunciosController.js"), "utf8");
    assert.ok(/acao: "anuncios_meli\.preco\.alterar"/.test(ctl));
    assert.ok(/preco_confirmado: r\.preco/.test(ctl) && /preco_anterior/.test(ctl));
    const repo = fs.readFileSync(path.join(__dirname, "..", "services", "resgate", "resgateLeituraRepository.js"), "utf8");
    assert.ok(/'anuncios_meli\.preco\.alterar'/.test(repo));
  });

  console.log(`\n${ok} verificações do núcleo do Resgate`);
})();
