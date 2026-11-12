// server/services/resgate/resgateContrato.js
//
// CONTRATO FINANCEIRO ÚNICO do VenForce Resgate (versão "resgate-contrato/1").
// Módulo PURO (sem I/O). Toda tela, planilha e plano do Resgate lê este objeto
// — ninguém recalcula lucro/margem por conta própria.
//
// Regras:
//  · null/""/ausente NUNCA vira 0. O único zero aceito é o declarado (ex.:
//    taxa fixa 0 gravada na base, frete inexistente em logística a combinar).
//  · Lucro e margem só existem quando TODOS os componentes essenciais são
//    conhecidos (preço vigente, custo, imposto, taxa fixa, comissão e, quando
//    se aplica, frete). Caso contrário: `resultado.calculavel=false` e cada
//    ausência vira um `bloqueio` com o que a resolve.
//  · A fórmula é a do núcleo do Motor (core.computeMargin): o Resgate não tem
//    fórmula própria.
//  · Subsídio do ML (rebate) entra UMA vez, como `rebate` do núcleo; nunca é
//    abatido da comissão nem do preço ao mesmo tempo.
//  · Cada componente traz origem, horário da evidência e confiança.

const core = require("../motorMargem/core");
const { componenteFrete, CONFIANCA } = require("./resgateEvidencias");

const VERSAO = "resgate-contrato/1";
const ORDEM_CONFIANCA = ["desconhecida", "nao_verificada", "baixa", "media", "alta"];

const BLOQUEIO = Object.freeze({
  PRECO_AUSENTE: "PRECO_AUSENTE",
  CUSTO_AUSENTE: "CUSTO_AUSENTE",
  IMPOSTO_AUSENTE: "IMPOSTO_AUSENTE",
  TAXA_FIXA_AUSENTE: "TAXA_FIXA_AUSENTE",
  COMISSAO_AUSENTE: "COMISSAO_AUSENTE",
  FRETE_DESCONHECIDO: "FRETE_DESCONHECIDO",
});

// O que resolve cada bloqueio (texto para a fila de pendências).
const RESOLVE = Object.freeze({
  PRECO_AUSENTE: "Recarregar o anúncio no Mercado Livre (sale_price).",
  CUSTO_AUSENTE: "Cadastrar o custo do SKU na base de custos vinculada à conta.",
  IMPOSTO_AUSENTE: "Preencher o imposto (%) do SKU na base de custos.",
  TAXA_FIXA_AUSENTE: "Preencher a taxa fixa do SKU na base de custos (0 quando não houver).",
  COMISSAO_AUSENTE: "Recotar a tarifa do Mercado Livre (listing_prices) — falha de leitura.",
  FRETE_DESCONHECIDO: "Declarar as medidas da embalagem no anúncio (peso, altura, largura, comprimento) ou aguardar envios com medidas concordantes.",
});

const TEXTO_BLOQUEIO = Object.freeze({
  PRECO_AUSENTE: "Preço vigente desconhecido.",
  CUSTO_AUSENTE: "Custo do produto desconhecido.",
  IMPOSTO_AUSENTE: "Imposto desconhecido.",
  TAXA_FIXA_AUSENTE: "Taxa fixa desconhecida.",
  COMISSAO_AUSENTE: "Comissão do Mercado Livre desconhecida.",
  FRETE_DESCONHECIDO: "Frete desconhecido: nenhuma fonte permite calcular com segurança.",
});

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function r2(v) { return v === null ? null : Math.round((v + Number.EPSILON) * 100) / 100; }

function comp(valor, { fonte = null, observadoEm = null, confianca = null, status = null, extra = {} } = {}) {
  const v = num(valor);
  return {
    valor: v,
    fonte,
    observadoEm: observadoEm || null,
    confianca: confianca || (v === null ? CONFIANCA.DESCONHECIDA : CONFIANCA.ALTA),
    status: status || (v === null ? "desconhecido" : "ok"),
    ...extra,
  };
}

function menorConfianca(lista) {
  let idx = ORDEM_CONFIANCA.length - 1;
  for (const c of lista) {
    if (!c || c === CONFIANCA.NAO_APLICAVEL) continue;
    const i = ORDEM_CONFIANCA.indexOf(c);
    if (i >= 0 && i < idx) idx = i;
  }
  return ORDEM_CONFIANCA[idx];
}

/**
 * Promoção / subsídio. `promocao`:
 *   { ativa:boolean|null, id, tipo, nome, subsidioMl (R$/un), ambigua:boolean,
 *     indisponivel:string|null, fonte, observadoEm, boostedOffer:boolean|null }
 * Ambígua ou indisponível → subsídio NÃO aplicado e motivo registrado.
 */
function lerPromocao(promocao, precos) {
  const p = promocao && typeof promocao === "object" ? promocao : {};
  const pendencias = [];
  let subsidio = num(p.subsidioMl);
  if (p.ambigua) { pendencias.push({ codigo: "REBATE_AMBIGUO", texto: "Mais de uma promoção com retorno do ML em andamento: o subsídio não foi aplicado." }); subsidio = null; }
  if (p.indisponivel) { pendencias.push({ codigo: "PROMO_INDISPONIVEL", texto: `Promoções da conta não puderam ser lidas (${p.indisponivel}).` }); subsidio = null; }
  const temPromo = precos.promocional !== null || p.ativa === true;
  return {
    ativa: p.ativa === undefined ? (precos.promocional !== null ? true : null) : p.ativa,
    id: p.id || null,
    tipo: p.tipo || null,
    nome: p.nome || null,
    subsidioMl: comp(subsidio, { fonte: subsidio !== null ? (p.fonte || "promo_snapshot.subsidio_ml") : null, observadoEm: p.observadoEm, status: subsidio === null ? (temPromo ? "desconhecido" : "nao_aplicavel") : "ok", confianca: subsidio === null && !temPromo ? CONFIANCA.NAO_APLICAVEL : undefined }),
    // boosted_offer: a fonte atual (Promo Snapshot) não expõe o campo — fica
    // registrado como não disponível, nunca presumido.
    boostedOffer: p.boostedOffer === true || p.boostedOffer === false ? p.boostedOffer : null,
    pendencias,
  };
}

/**
 * @param {object} e entrada normalizada (ver resgateAuditoriaItem.montarEntrada…)
 * @returns contrato
 */
function montarContratoFinanceiro(e = {}) {
  const conta = e.conta || {};
  const anuncio = e.anuncio || {};
  const precosIn = e.precos || {};
  const obsPreco = precosIn.observadoEm || null;

  const precos = {
    cheio: num(precosIn.cheio),
    vigente: num(precosIn.vigente),
    promocional: num(precosIn.promocional),
  };
  const promo = lerPromocao(e.promocao, precos);
  const subsidio = promo.subsidioMl.valor;

  const frete = componenteFrete({
    valor: e.frete ? e.frete.valor : null,
    freteQualidade: e.frete ? e.frete.freteQualidade : null,
    logisticType: anuncio.logisticType === undefined ? undefined : anuncio.logisticType,
    motivo: e.frete ? e.frete.motivo : null,
    observadoEm: e.frete ? e.frete.observadoEm : null,
  });

  const custoIn = e.custo || {};
  const impostoIn = e.imposto || {};
  const taxaIn = e.taxaFixa || {};
  const comIn = e.comissao || {};

  const componentes = {
    precoCheio: comp(precos.cheio, { fonte: precosIn.fonte || null, observadoEm: obsPreco }),
    precoVigente: comp(precos.vigente, { fonte: precosIn.fonte || null, observadoEm: obsPreco }),
    precoPromocional: comp(precos.promocional, { fonte: precosIn.fonte || null, observadoEm: obsPreco, status: precos.promocional === null ? "nao_aplicavel" : "ok", confianca: precos.promocional === null ? CONFIANCA.NAO_APLICAVEL : undefined }),
    // Preço final do comprador = preço vigente (sale_price já inclui a promoção ativa).
    precoComprador: comp(precos.vigente, { fonte: "sale_price.amount", observadoEm: obsPreco }),
    subsidioMl: promo.subsidioMl,
    // O que o vendedor reconhece por unidade: preço do comprador + subsídio ML (uma vez).
    valorReconhecidoVendedor: comp(precos.vigente === null ? null : r2(precos.vigente + (subsidio || 0)), {
      fonte: subsidio !== null ? "preço do comprador + subsídio ML" : "preço do comprador",
      observadoEm: obsPreco,
      status: precos.vigente === null ? "desconhecido" : (promo.subsidioMl.status === "desconhecido" ? "estimado" : "ok"),
    }),
    // Desconto bancado pelo VENDEDOR = cheio − comprador − subsídio ML.
    descontoVendedor: comp(precos.cheio !== null && precos.vigente !== null && precos.cheio > precos.vigente && promo.subsidioMl.status !== "desconhecido"
      ? r2(precos.cheio - precos.vigente - (subsidio || 0)) : (precos.cheio !== null && precos.vigente !== null && precos.cheio <= precos.vigente ? 0 : null), {
      fonte: "preço cheio − preço do comprador − subsídio ML",
      observadoEm: obsPreco,
      status: precos.cheio !== null && precos.vigente !== null && precos.cheio <= precos.vigente ? "nao_aplicavel" : undefined,
      confianca: precos.cheio !== null && precos.vigente !== null && precos.cheio <= precos.vigente ? CONFIANCA.NAO_APLICAVEL : undefined,
    }),
    comissao: comp(comIn.valor, {
      fonte: comIn.fonte || (num(comIn.valor) !== null ? "listing_prices.sale_fee_amount" : null),
      observadoEm: comIn.observadoEm,
      extra: { percentual: num(comIn.percentual), precoBase: num(comIn.precoBase) ?? precos.vigente, motivo: num(comIn.valor) === null ? (comIn.motivo || null) : null },
    }),
    frete: {
      valor: frete.valor, fonte: frete.fonte, observadoEm: frete.avaliadoEm, confianca: frete.confianca,
      status: frete.aplicavel === false ? "nao_aplicavel" : frete.valor === null ? "desconhecido" : (frete.estimado ? "estimado" : (frete.confianca === CONFIANCA.NAO_VERIFICADA ? "nao_verificado" : "ok")),
      nivel: frete.nivel, motivo: frete.motivo, texto: frete.texto, aplicavel: frete.aplicavel,
      modalidade: frete.modalidade || null, custosForaDaMargem: frete.custosForaDaMargem || [], cotacaoRejeitada: frete.cotacaoRejeitada ?? null,
    },
    custo: comp(custoIn.valor, { fonte: custoIn.fonte || (num(custoIn.valor) !== null ? "base de custos" : null), observadoEm: custoIn.observadoEm }),
    imposto: comp(impostoIn.percentual, { fonte: impostoIn.fonte || (num(impostoIn.percentual) !== null ? "base de custos" : null), observadoEm: impostoIn.observadoEm }),
    taxaFixa: comp(taxaIn.valor, { fonte: taxaIn.fonte || (num(taxaIn.valor) !== null ? "base de custos" : null), observadoEm: taxaIn.observadoEm }),
  };

  // ── Bloqueios (componentes essenciais desconhecidos) ──────────────────────
  const bloqueios = [];
  const bloquear = (codigo, componente) => bloqueios.push({ codigo, componente, texto: TEXTO_BLOQUEIO[codigo], resolveCom: RESOLVE[codigo] });
  if (precos.vigente === null || precos.vigente <= 0) bloquear(BLOQUEIO.PRECO_AUSENTE, "precoVigente");
  if (componentes.custo.valor === null) bloquear(BLOQUEIO.CUSTO_AUSENTE, "custo");
  if (componentes.imposto.valor === null) bloquear(BLOQUEIO.IMPOSTO_AUSENTE, "imposto");
  if (componentes.taxaFixa.valor === null) bloquear(BLOQUEIO.TAXA_FIXA_AUSENTE, "taxaFixa");
  if (componentes.comissao.valor === null) bloquear(BLOQUEIO.COMISSAO_AUSENTE, "comissao");
  if (frete.aplicavel !== false && frete.valor === null) bloquear(BLOQUEIO.FRETE_DESCONHECIDO, "frete");

  // ── Pendências (não impedem o cálculo, mas rebaixam a confiança) ──────────
  const pendencias = [...promo.pendencias];
  if (componentes.frete.status === "nao_verificado") {
    pendencias.push({ codigo: "FRETE_NAO_VERIFICADO", texto: "Frete cotado pelo ML sem a verificação de confiabilidade (conta ainda não liberada)." });
  }
  if ((frete.custosForaDaMargem || []).includes("entregador_flex")) {
    pendencias.push({ codigo: "FLEX_ENTREGADOR_FORA", texto: "Vendas pelo Flex pagam o entregador próprio: custo externo, fora desta margem." });
  }
  if (frete.aplicavel === null) {
    pendencias.push({ codigo: "LOGISTICA_DESCONHECIDA", texto: "Logística do anúncio desconhecida: não dá para saber se o frete se aplica." });
  }
  if (e.legadoNaoVerificado) {
    pendencias.push({ codigo: "SNAPSHOT_ANTERIOR_A_CORRECAO", texto: "Snapshot gravado antes da correção do frete (conta liberada): recalcular." });
  }

  // ── Inconsistências entre fontes ───────────────────────────────────────────
  const inconsistencias = [];
  if (precos.promocional !== null && precos.cheio !== null && precos.promocional > precos.cheio) {
    inconsistencias.push({ codigo: "PROMO_ACIMA_DO_CHEIO", texto: "Preço promocional acima do preço cheio." });
  }
  if (componentes.comissao.valor !== null && precos.vigente !== null && componentes.comissao.valor >= precos.vigente) {
    inconsistencias.push({ codigo: "COMISSAO_IMPOSSIVEL", texto: "Comissão maior ou igual ao preço." });
  }
  const precoBaseComissao = componentes.comissao.precoBase;
  if (componentes.comissao.valor !== null && precoBaseComissao !== null && precos.vigente !== null && Math.abs(precoBaseComissao - precos.vigente) > 0.01) {
    inconsistencias.push({ codigo: "COMISSAO_DE_OUTRO_PRECO", texto: `Comissão cotada em R$ ${precoBaseComissao.toFixed(2)}, preço vigente R$ ${precos.vigente.toFixed(2)}.` });
  }

  // ── Resultado (só quando calculável) ───────────────────────────────────────
  let resultado = { calculavel: false, lucro: null, margem: null, margemPercent: null, motivo: bloqueios.length ? "COMPONENTE_ESSENCIAL_DESCONHECIDO" : null };
  if (!bloqueios.length) {
    const m = core.computeMargin({
      price: precos.vigente,
      cost: componentes.custo.valor,
      taxRate: componentes.imposto.valor,
      fixedFee: componentes.taxaFixa.valor,
      commission: componentes.comissao.valor,
      // Único zero aceito para frete: logística a combinar (sem frete previsto).
      freight: frete.aplicavel === false ? 0 : frete.valor,
      rebate: subsidio || 0,
    });
    // Promoção ativa com subsídio desconhecido: a margem é calculada SEM subsídio e
    // declarada como LIMITE INFERIOR (o subsídio, se existir, só aumentaria o lucro).
    const subsidioDesconhecido = promo.subsidioMl.status === "desconhecido";
    resultado = m.computable && m.strict
      ? { calculavel: true, lucro: m.profit, margem: m.margin, margemPercent: r2(m.margin * 100), motivo: null,
          subsidioConsiderado: subsidio || 0, limiteInferior: subsidioDesconhecido }
      : { calculavel: false, lucro: null, margem: null, margemPercent: null, motivo: "NUCLEO_NAO_CALCULOU" };
    if (resultado.calculavel && subsidioDesconhecido && !pendencias.some((x) => x.codigo === "PROMO_INDISPONIVEL" || x.codigo === "REBATE_AMBIGUO")) {
      pendencias.push({ codigo: "SUBSIDIO_DESCONHECIDO", texto: "Promoção ativa com subsídio do ML desconhecido: margem calculada sem subsídio (limite inferior)." });
    }
  }

  const confiancaGeral = resultado.calculavel
    ? menorConfianca([componentes.precoVigente.confianca, componentes.custo.confianca, componentes.comissao.confianca, componentes.frete.confianca, componentes.imposto.confianca, componentes.taxaFixa.confianca])
    : CONFIANCA.DESCONHECIDA;

  const horarios = Object.values(componentes).map((c) => c && c.observadoEm).filter(Boolean).map((d) => Date.parse(d)).filter(Number.isFinite);

  return {
    versao: VERSAO,
    conta: {
      clienteId: conta.clienteId ?? null, clienteNome: conta.clienteNome ?? null, clienteContaId: conta.clienteContaId ?? null,
      contaNome: conta.contaNome ?? null, sellerId: conta.sellerId ? String(conta.sellerId) : null,
    },
    anuncio: {
      itemId: anuncio.itemId || null, sku: anuncio.sku || null, titulo: anuncio.titulo || null, status: anuncio.status || null,
      logisticType: anuncio.logisticType ?? null, listingTypeId: anuncio.listingTypeId || null,
    },
    componentes,
    promocao: { ativa: promo.ativa, id: promo.id, tipo: promo.tipo, nome: promo.nome, boostedOffer: promo.boostedOffer },
    resultado,
    // Margem confiável para DECIDIR: calculável, frete verificado e sem snapshot legado.
    margemConfiavel: resultado.calculavel && componentes.frete.status !== "nao_verificado" && !e.legadoNaoVerificado,
    confiancaGeral,
    bloqueios,
    pendencias,
    inconsistencias,
    evidenciaMaisAntiga: horarios.length ? new Date(Math.min(...horarios)).toISOString() : null,
    evidenciaMaisRecente: horarios.length ? new Date(Math.max(...horarios)).toISOString() : null,
  };
}

module.exports = { montarContratoFinanceiro, VERSAO, BLOQUEIO, RESOLVE, menorConfianca };
