// server/services/centralVendas/centralVendasDetalheFinanceiro.js
//
// Detalhamento financeiro de UM pedido (GET /read/orders/:rowId →
// `pedido.composicaoFinanceira`). Função PURA sobre o que já foi persistido:
// o contrato do pedido (buildPedidoContrato), os componentes do ledger e os
// metadados do import que gravou o pedido. Nenhuma fórmula nova, nenhum
// recálculo: explica, linha a linha, como o motor chegou ao resultado e diz o
// que é comprovado, observado, inferido ou desconhecido.
//
//   identificação   pedido, status, logística, itens (MLB, SKU, variação)
//   preços          preço cheio × efetivo, desconto total e quem financiou
//   comissão        do pedido (a do resultado) × bruta × líquida, rebate,
//                   se já está na comissão, crédito adicional comprovado
//   composição      receita − comissão − frete − CMV − imposto = MC, com a
//                   identidade conferida (resíduo exposto, nunca escondido)
//   conciliação     receita de envio, reembolso, pós-venda, cancelamento
//   evidências      fonte e estado de cada valor; estado da conciliação
//   pendências      do motor + da composição + base de custos alterada
//   divergências    Orders × Discounts × Billing
//
// "composição não coletada" (flag desligada quando o import foi gravado) é um
// estado próprio: nunca vira "sem desconto".

const CONTRATO_VERSAO = 1;
const TIPOS_PROMO = new Set([
  "preco_cheio", "desconto_vendedor", "desconto_marketplace",
  "comissao_bruta", "rebate_marketplace", "credito_comissao_comprovado",
]);

const c = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));
const r = (cent) => (cent === null ? null : cent / 100);
const soma = (lista) => (lista.length ? lista.reduce((a, b) => a + b, 0) : null);

const ROTULO_DIVERGENCIA = {
  sale_fee_pedido_difere_do_net: "Comissão do pedido diferente da tarifa líquida do Billing",
  rebate_possivelmente_contado_duas_vezes: "Rebate possivelmente descontado duas vezes",
  rebate_billing_difere_do_calculado: "Rebate do Billing diferente da parte do ML nos descontos",
  cobrancas_nao_somam_net: "Cobranças do Billing não somam a tarifa líquida",
  identidade_gross_net_violada: "Tarifa bruta − líquida ≠ rebate + desconto no Billing",
  gross_nao_reconcilia: "Preço cheio ≠ preço efetivo + desconto",
  descontos_nao_reconciliam: "Descontos do pedido não fecham com o preço cheio",
  gross_menor_que_pago: "Preço cheio menor que o pago",
  vendedor_maior_que_total: "Parte do vendedor maior que o desconto total",
  seller_divergente: "Pedido de outro vendedor",
};

function porTipo(componentes, tipo, itemId) {
  return componentes.filter((x) => x.tipo === tipo && (itemId === undefined || (x.itemId || null) === itemId));
}
function valorDe(componentes, tipo, itemId) {
  const l = porTipo(componentes, tipo, itemId).map((x) => c(x.valor)).filter((v) => v !== null);
  return l.length ? l.reduce((a, b) => a + b, 0) : null;
}
function primeiro(componentes, tipo, itemId) { return porTipo(componentes, tipo, itemId)[0] || null; }
function obsValor(comp, prefixo) {
  const o = comp && typeof comp.obs === "string" ? comp.obs : "";
  return o.startsWith(`${prefixo}:`) ? o.slice(prefixo.length + 1) : null;
}
function linha(id, rotulo, cent, { sinal = 0, fonte = null, estado = null, entraNoResultado = false, itemId = null, nota = null } = {}) {
  return { id, rotulo, valor: r(cent), sinal, fonte, estado: cent === null && estado !== "bloqueado" ? (estado === "ausente" ? "ausente" : "desconhecido") : estado, entraNoResultado, itemId, nota };
}
function estadoDoComponente(comp) {
  if (!comp) return "ausente";
  const k = String(comp.confianca || "");
  if (k === "real") return "observado";
  return k || "observado";
}

/**
 * @param {object} pedido        contrato do pedido (buildPedidoContrato)
 * @param {object} contexto
 *   variacoes            Map(itemId → variacaoId) (opcional)
 *   composicaoColetada   o import que gravou o pedido tinha a composição ligada?
 *   composicaoDoPedido   { estado, divergencias[] } gravado no pedido (opcional)
 *   baseCustos           { estado: igual|alterada|base_trocada|sem_registro, gravada, atual }
 */
function detalharPedido(pedido, contexto = {}) {
  const comps = Array.isArray(pedido?.componentes) ? pedido.componentes : [];
  const itensPedido = Array.isArray(pedido?.itens) ? pedido.itens : [];
  const variacoes = contexto.variacoes instanceof Map ? contexto.variacoes : new Map();
  const coletada = contexto.composicaoColetada === true || comps.some((x) => TIPOS_PROMO.has(x.tipo));

  // ── itens ──
  const itens = itensPedido.map((it) => {
    const itemId = it.itemId || it.id || null;
    const receita = c(it.receitaProduto);
    const precoCheioComp = primeiro(comps, "preco_cheio", itemId);
    // Composição coletada e sem preco_cheio ⇒ não houve desconto (o motor só grava quando há).
    const precoCheio = precoCheioComp ? c(precoCheioComp.valor) : coletada ? receita : null;
    const desconto = precoCheio !== null && receita !== null ? precoCheio - receita : null;
    const dv = primeiro(comps, "desconto_vendedor", itemId);
    const dm = primeiro(comps, "desconto_marketplace", itemId);
    const estadoPreco = precoCheioComp ? estadoDoComponente(precoCheioComp) : coletada ? "inferido" : "nao_coletado";
    return {
      itemId,
      mlb: it.mlb || null,
      sku: it.sku || null,
      variacaoId: variacoes.get(itemId) ?? null,
      titulo: it.titulo || null,
      quantidade: it.quantidade ?? null,
      precoEfetivoUnitario: it.valorUnitario ?? null,
      precoCheio: { valor: r(precoCheio), estado: estadoPreco, fonte: precoCheioComp ? precoCheioComp.fonte : coletada ? "orders_api" : null },
      precoEfetivo: { valor: r(receita), estado: receita === null ? "desconhecido" : "observado", fonte: "orders_api" },
      desconto: { valor: r(desconto), estado: desconto === null ? (coletada ? "desconhecido" : "nao_coletado") : desconto === 0 ? "inferido" : estadoPreco },
      descontoVendedor: dv ? { valor: r(c(dv.valor)), estado: estadoDoComponente(dv), fonte: dv.fonte } : { valor: desconto === 0 ? 0 : null, estado: desconto === 0 ? "inferido" : coletada ? "desconhecido" : "nao_coletado", fonte: null },
      descontoMarketplace: dm ? { valor: r(c(dm.valor)), estado: estadoDoComponente(dm), fonte: dm.fonte } : { valor: desconto === 0 ? 0 : null, estado: desconto === 0 ? "inferido" : coletada ? "desconhecido" : "nao_coletado", fonte: null },
      resultado: it.resultado ?? null,
      confianca: it.confianca || null,
      pendencias: Array.isArray(it.pendencias) ? it.pendencias : [],
    };
  });
  const somaItens = (campo) => {
    const l = itens.map((i) => c(i[campo].valor));
    return l.every((v) => v !== null) ? soma(l) : null;
  };
  const precos = {
    coletado: coletada,
    precoCheio: somaItens("precoCheio"),
    precoEfetivo: somaItens("precoEfetivo"),
    desconto: somaItens("desconto"),
    vendedorBancou: somaItens("descontoVendedor"),
    marketplaceBancou: somaItens("descontoMarketplace"),
  };
  for (const k of ["precoCheio", "precoEfetivo", "desconto", "vendedorBancou", "marketplaceBancou"]) precos[k] = r(precos[k]);

  // ── comissão ──
  const tarifa = valorDe(comps, "tarifa_venda");
  const bruta = primeiro(comps, "comissao_bruta");
  const natureza = obsValor(bruta, "natureza") || (coletada ? "nao_verificada" : "nao_coletada");
  const rebate = primeiro(comps, "rebate_marketplace");
  const credito = primeiro(comps, "credito_comissao_comprovado");
  const doPedido = tarifa === null ? null : Math.abs(tarifa);
  const comissao = {
    doPedido: { valor: r(doPedido), estado: doPedido === null ? "ausente" : "observado", fonte: "orders_api", nota: "valor usado no resultado" },
    bruta: bruta ? { valor: r(c(bruta.valor)), estado: estadoDoComponente(bruta), fonte: bruta.fonte } : { valor: null, estado: coletada ? "desconhecido" : "nao_coletado", fonte: null },
    // líquida só é afirmada quando o Billing provou a natureza da tarifa do pedido
    liquida: natureza === "liquida_comprovada"
      ? { valor: r(doPedido), estado: "comprovado", fonte: "billing_api" }
      : natureza === "bruta_comprovada" && bruta && credito
        ? { valor: r(c(bruta.valor) - c(credito.valor)), estado: "comprovado", fonte: "billing_api" }
        : { valor: null, estado: coletada ? "desconhecido" : "nao_coletado", fonte: null },
    natureza,
    rebate: rebate
      ? { valor: r(c(rebate.valor)), estado: estadoDoComponente(rebate), fonte: rebate.fonte, incorporadoNaComissao: obsValor(rebate, "incorporado") || "desconhecido" }
      : { valor: null, estado: coletada ? "desconhecido" : "nao_coletado", fonte: null, incorporadoNaComissao: "desconhecido" },
    creditoAdicionalComprovado: credito
      ? { valor: r(c(credito.valor)), estado: "comprovado", motivo: credito.obs || null, foraDoResultadoOficial: true }
      : { valor: null, estado: coletada ? "desconhecido" : "nao_coletado", motivo: null, foraDoResultadoOficial: true },
  };

  // ── composição do resultado (só o que o motor somou) ──
  const sinalizado = (tipo) => {
    const v = valorDe(comps, tipo);
    return v === null ? null : Math.abs(v);
  };
  const fonteDe = (tipo) => {
    const l = [...new Set(porTipo(comps, tipo).map((x) => x.fonte).filter(Boolean))];
    return l.length ? l.join(" + ") : null;
  };
  const estadoAgregado = (tipo) => {
    const l = porTipo(comps, tipo);
    if (!l.length) return "ausente";
    const ks = l.map((x) => String(x.confianca || ""));
    if (ks.includes("bloqueado")) return "bloqueado";
    if (ks.includes("ausente")) return "ausente";
    return natureza === "liquida_comprovada" && tipo === "tarifa_venda" ? "comprovado" : "observado";
  };
  const receita = sinalizado("receita_produto");
  const vComissao = sinalizado("tarifa_venda");
  const vFrete = sinalizado("frete_seller");
  const vCmv = sinalizado("custo_produto");
  const vImposto = sinalizado("imposto_interno");
  const resultado = c(pedido?.resultado);
  const linhas = [
    linha("receita_produto", "Receita de produtos (preço efetivo × quantidade)", receita, { sinal: 1, fonte: fonteDe("receita_produto"), estado: estadoAgregado("receita_produto"), entraNoResultado: true }),
    linha("comissao", "Comissão (tarifa de venda)", vComissao, { sinal: -1, fonte: fonteDe("tarifa_venda"), estado: estadoAgregado("tarifa_venda"), entraNoResultado: true, nota: natureza === "liquida_comprovada" ? "líquida do rebate, comprovada no Billing" : null }),
    linha("frete_seller", "Frete pago pelo vendedor", vFrete, { sinal: -1, fonte: fonteDe("frete_seller"), estado: estadoAgregado("frete_seller"), entraNoResultado: true, nota: porTipo(comps, "frete_seller").map((x) => x.obs).find(Boolean) || null }),
    linha("cmv", "Custo do produto (CMV)", vCmv, { sinal: -1, fonte: fonteDe("custo_produto"), estado: estadoAgregado("custo_produto"), entraNoResultado: true }),
    linha("imposto", "Impostos", vImposto, { sinal: -1, fonte: fonteDe("imposto_interno"), estado: estadoAgregado("imposto_interno"), entraNoResultado: true }),
  ];
  const esperado = receita === null ? null : receita - (vComissao || 0) - (vFrete || 0) - (vCmv || 0) - (vImposto || 0);
  const identidade = {
    formula: "receita − comissão − frete − CMV − imposto (ausente não é descontado e deixa o resultado parcial)",
    esperado: r(esperado),
    resultado: r(resultado),
    fecha: resultado === null || esperado === null ? null : Math.abs(esperado - resultado) <= 1,
    residuo: resultado === null || esperado === null ? null : r(resultado - esperado),
  };
  const margem = resultado !== null && receita ? Math.round((resultado / receita) * 10000) / 100 : null;

  // ── conciliação e pós-venda (fora do resultado) ──
  const receitaEnvio = valorDe(comps, "receita_envio");
  const reembolso = valorDe(comps, "cancelamento_reembolso");
  const conciliacao = {
    receitaEnvio: { valor: r(receitaEnvio === null ? null : Math.abs(receitaEnvio)), estado: primeiro(comps, "receita_envio") ? estadoDoComponente(primeiro(comps, "receita_envio")) : "ausente", nota: "paga pelo comprador; não entra no resultado" },
    reembolso: { valor: r(reembolso === null ? null : Math.abs(reembolso)), estado: reembolso === null ? "sem_registro" : "observado", nota: "devolvido ao comprador; não descontado de novo (a receita já sai do resultado)" },
    cancelado: pedido?.status === "cancelado",
    entraNoResultado: pedido?.entraNoResultado !== false,
    posVenda: { tipo: pedido?.posVendaTipo ?? null, motivo: pedido?.posVendaMotivo ?? null, parcial: pedido?.posVendaParcial === true, quantidadeComprada: pedido?.posVendaQuantidadeComprada ?? null, quantidadeDevolvida: pedido?.posVendaQuantidadeDevolvida ?? null, claimIds: pedido?.claimIds || [] },
    ajustes: identidade.fecha === false ? { valor: identidade.residuo, nota: "resíduo entre os componentes e o resultado gravado (ex.: ajuste de plataforma da planilha)" } : null,
  };

  // ── estado da conciliação da comissão, divergências e pendências ──
  const doPedidoGravado = contexto.composicaoDoPedido || null;
  const estado = !coletada ? "NAO_COLETADO"
    : doPedidoGravado?.estado || (natureza === "liquida_comprovada" || natureza === "bruta_comprovada" ? "CONCILIADO" : "NAO_VERIFICADO");
  const divergencias = (doPedidoGravado?.divergencias || []).map((codigo) => ({ codigo, rotulo: ROTULO_DIVERGENCIA[codigo] || codigo.replace(/_/g, " ") }));
  if (identidade.fecha === false) divergencias.push({ codigo: "resultado_nao_fecha_com_componentes", rotulo: `Resultado gravado difere da soma dos componentes em ${identidade.residuo}` });
  const pendencias = [...new Set([...(pedido?.pendencias || []), ...itens.flatMap((i) => i.pendencias)])].map((codigo) => ({ codigo, origem: "motor" }));
  if (!coletada) pendencias.push({ codigo: "composicao_promocional_nao_coletada", origem: "composicao" });
  else if (estado === "NAO_VERIFICADO" || estado === "PARCIAL") pendencias.push({ codigo: "comissao_nao_conciliada", origem: "composicao" });
  const base = contexto.baseCustos || null;
  if (base && (base.estado === "alterada" || base.estado === "base_trocada")) pendencias.push({ codigo: base.estado === "alterada" ? "base_custos_alterada_desde_o_calculo" : "base_custos_trocada_desde_o_calculo", origem: "base" });

  return {
    contrato: CONTRATO_VERSAO,
    identificacao: {
      pedidoId: pedido?.pedidoId ?? pedido?.id ?? null,
      rowId: pedido?.rowId ?? null,
      data: pedido?.data ?? null,
      status: pedido?.status ?? null,
      statusOriginal: pedido?.statusOriginal ?? null,
      logistica: pedido?.logistica ?? null,
      full: pedido?.full ?? null,
      multiItem: itens.length > 1,
    },
    itens,
    precos,
    comissao,
    composicao: { linhas, resultado: r(resultado), margemPercentual: margem, identidade, denominador: "receita de produtos do pedido" },
    conciliacao,
    evidencias: {
      estadoConciliacao: estado,
      fontes: [...new Set(comps.map((x) => x.fonte).filter(Boolean))].sort(),
      baseCustos: base,
    },
    divergencias,
    pendencias,
  };
}

module.exports = { CONTRATO_VERSAO, detalharPedido, TIPOS_PROMO };
