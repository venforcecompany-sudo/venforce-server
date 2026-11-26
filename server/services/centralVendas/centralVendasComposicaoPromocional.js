// server/services/centralVendas/centralVendasComposicaoPromocional.js
//
// Composição PROMOCIONAL e de COMISSÃO de um pedido do Mercado Livre para a
// Central de Vendas (contrato v1). Função PURA: sem I/O, sem relógio, sem ML.
//
// Não é um segundo Sentinel. Reaproveita as duas funções puras dele, sem cópia
// e sem alterá-las:
//   · sentinelEvidenciaFinanceira.extrairEvidencia  → preço cheio, desconto,
//     parte do vendedor e do ML (orders + /orders/{id}/discounts);
//   · sentinelConciliacaoComissao.conciliarComissaoPedido → tarifa do pedido ×
//     Billing (gross/net/rebate) + cobranças CVV*.
// A Central não depende de o Sentinel monitorar a conta: quem chama entrega o
// pedido (o sync da Central já o baixa) e, quando tiver, o detalhe de descontos
// e o registro de Billing.
//
// O QUE ESTE MÓDULO GARANTE (por construção, coberto por teste):
//   · nada muda o resultado oficial: `efeitoNoResultadoOficial` é sempre
//     "nenhum". Um ajuste só aparece em `creditoAdicionalComprovado`, separado;
//   · REBATE NUNCA CONTA DUAS VEZES: o motor desconta `sale_fee × q` do pedido.
//     - Billing provou que essa tarifa é a LÍQUIDA (net): o rebate já está
//       dentro dela ⇒ crédito adicional = 0;
//     - Billing provou que é a BRUTA (gross ≠ net): o vendedor pagou net ⇒
//       crédito adicional comprovado = gross − net;
//     - qualquer outra situação ⇒ crédito adicional = null (não comprovado).
//     O `limiteSuperiorNaoComprovado` (credito_max da evidência) é só hipótese e
//     some assim que a conciliação existe: ela o SUBSTITUI, nunca se soma;
//   · ausente ≠ zero: todo valor é { centavos: inteiro|null, estado, fonte };
//   · divergência é exposta com as duas pontas, nunca corrigida.
//
// Unidades: centavos inteiros. `unit_price` já é o preço após descontos;
// `gross_price` é o TOTAL das q unidades antes do desconto (validado em 100% dos
// itens MLB em 17/11/2026); `sale_fee` é por unidade.

const { extrairEvidencia, lerCentavos } = require("../sentinel/sentinelEvidenciaFinanceira");
const {
  conciliarComissaoPedido,
  CATEGORIA_MOTIVO,
  DESCONTOS_INDISPONIVEL_CHAVE,
} = require("../sentinel/sentinelConciliacaoComissao");

const CONTRATO_VERSAO = 1;

// Gravação dos componentes promocionais pelo motor: opt-in por flag + lista de
// contas (mesmo padrão dos compactos). Desligada ⇒ o motor não muda nada.
const ENV_NAME = "CENTRAL_VENDAS_COMPOSICAO_PROMOCIONAL";
const ENV_CONTAS = "CENTRAL_VENDAS_COMPOSICAO_PROMOCIONAL_CONTAS";
const VALORES_LIGADO = new Set(["true", "1", "on", "yes", "sim"]);
function isComposicaoPromocionalHabilitada({ clienteContaId }, env = process.env) {
  const raw = env[ENV_NAME];
  if (raw == null || !VALORES_LIGADO.has(String(raw).trim().toLowerCase())) return false;
  const lista = String(env[ENV_CONTAS] || "").split(",").map((v) => v.trim()).filter(Boolean);
  if (lista.includes("*")) return true;
  return clienteContaId != null && lista.includes(String(clienteContaId));
}

const ESTADOS_VALOR = Object.freeze([
  "comprovado",   // duas fontes independentes fecham ao centavo
  "observado",    // lido de uma fonte, sem contradição
  "calculado",    // derivado de campos observados (ex.: unit + desconto)
  "inferido",     // deduzido sem a fonte própria (ex.: gross sem o detalhe)
  "desconhecido", // a fonte não foi lida ou não traz o campo
  "contraditorio",
]);

// Onde cada divergência mora (para a tela dizer "Orders × Billing" etc.).
const ENTRE = Object.freeze({
  sale_fee_pedido_difere_do_net: "orders×billing",
  rebate_possivelmente_contado_duas_vezes: "orders×billing",
  rebate_billing_difere_do_calculado: "discounts×billing",
  cobrancas_nao_somam_net: "billing",
  identidade_gross_net_violada: "billing",
  gross_nao_reconcilia: "orders×discounts",
  descontos_nao_reconciliam: "orders×discounts",
  gross_menor_que_pago: "orders",
  gross_nao_divisivel: "orders",
  vendedor_maior_que_total: "discounts",
  desconto_negativo: "discounts",
  sale_fee_fora_da_faixa: "orders",
  seller_divergente: "orders",
  detalhe_sem_item_correspondente: "orders×discounts",
});
const MOTIVOS_ITEM_CONTRADITORIOS = new Set([
  "gross_nao_reconcilia", "descontos_nao_reconciliam", "gross_menor_que_pago", "gross_nao_divisivel",
  "vendedor_maior_que_total", "desconto_negativo", "sale_fee_fora_da_faixa",
]);

const valor = (centavos, estado, fonte = null) => ({ centavos, estado: centavos === null && estado !== "contraditorio" ? "desconhecido" : estado, fonte: centavos === null ? null : fonte });
const vezes = (c, q) => (c === null || c === undefined || q === null ? null : c * q);
const somaOuNull = (lista) => (lista.length && lista.every((v) => v !== null) ? lista.reduce((a, b) => a + b, 0) : null);

function piorEstado(estados) {
  const ordem = ["contraditorio", "desconhecido", "inferido", "calculado", "observado", "comprovado"];
  for (const e of ordem) if (estados.includes(e)) return e;
  return "desconhecido";
}

function estadoDoDesconto(item) {
  if (item.estado === "INCONSISTENTE") return "contraditorio";
  if (item.via === "discounts_api") return "observado";
  if (item.confianca === "INFERIDA" || (item.motivos || []).includes("gross_indica_desconto_sem_discounts")) return "inferido";
  if (item.confianca === "OBSERVADA") return "observado";
  return "desconhecido";
}

function fonteDescontos(descontos) {
  if (descontos === null || descontos === undefined) return "nao_consultado";
  if (typeof descontos === "object" && descontos[DESCONTOS_INDISPONIVEL_CHAVE] !== undefined) return "indisponivel";
  return "lido";
}

function fonteBilling(billing, meta) {
  if (billing === null || billing === undefined) return "nao_consultado";
  const parcial = (Array.isArray(billing.errors) && billing.errors.length > 0) || Number(meta?.billingHttpStatus) === 206;
  return parcial ? "parcial" : "lido";
}

/**
 * @param {object} entrada
 *   pedido        pedido ML (/orders/search ou /orders/{id}) — obrigatório
 *   conta         { clienteContaId (obrigatório), sellerId? }
 *   descontos     resposta de /orders/{id}/discounts, marcador { indisponivel_http } ou null
 *   billing       resposta de /billing/integration/group/ML/order/details ou null
 *   origemBilling { contaId } da conta cujo grant leu o Billing (opcional)
 *   meta          { billingHttpStatus } (opcional)
 */
function comporPedido(entrada) {
  const { pedido, conta = {}, descontos = null, billing = null, origemBilling = null, meta = null } = entrada || {};
  const clienteContaId = Number(conta.clienteContaId);
  const evidencia = extrairEvidencia(pedido, {
    clienteContaId,
    sellerId: conta.sellerId ?? null,
    descontosDetalhe: descontos && descontos[DESCONTOS_INDISPONIVEL_CHAVE] === undefined ? descontos : null,
    observadoEm: "1970-01-01T00:00:00.000Z", // determinístico: o contrato não guarda relógio
  });
  const conc = conciliarComissaoPedido({
    pedido,
    descontos,
    billing,
    conta: { id: clienteContaId, sellerId: conta.sellerId ?? null },
    origem_billing: origemBilling,
    meta,
  });

  const fonteDesc = fonteDescontos(descontos);
  const fonteBill = fonteBilling(billing, meta);
  const ordensItens = Array.isArray(pedido?.order_items) ? pedido.order_items : [];

  // ── itens ──────────────────────────────────────────────────────────────────────────────
  const itens = evidencia.itens.map((it) => {
    const oi = ordensItens[it.idx] || {};
    const q = it.q;
    const estDesc = estadoDoDesconto(it);
    const contraditorio = estDesc === "contraditorio";
    const precoEfetivo = valor(vezes(it.preco_unit, q), "observado", "orders_api");
    const precoCheio = it.preco_bruto_total !== null && !contraditorio
      ? valor(it.preco_bruto_total, "observado", "orders_api")
      : it.desconto_unit !== null && it.preco_unit !== null && !contraditorio
        ? valor((it.preco_unit + it.desconto_unit) * q, "calculado", "discounts_api")
        : valor(null, contraditorio ? "contraditorio" : "desconhecido");
    const fonteDesconto = it.via === "discounts_api" ? "discounts_api" : "orders_api";
    const descontoTotal = valor(contraditorio ? null : vezes(it.desconto_unit, q), contraditorio ? "contraditorio" : estDesc, fonteDesconto);
    const descontoVendedor = valor(contraditorio ? null : vezes(it.desconto_vendedor_unit, q), contraditorio ? "contraditorio" : estDesc, fonteDesconto);
    const descontoMarketplace = valor(contraditorio ? null : vezes(it.parcela_ml_unit, q), contraditorio ? "contraditorio" : estDesc, fonteDesconto);
    const fee = lerCentavos(oi.sale_fee);
    return {
      idx: it.idx,
      mlb: it.item_id,
      variationId: it.variation_id,
      sku: it.sku,
      quantidade: q,
      precoCheio,
      precoEfetivo,
      descontoTotal,
      descontoVendedor,
      descontoMarketplace,
      comissaoDoPedido: valor(fee.st === "ok" && q !== null ? fee.c * q : null, "observado", "orders_api"),
      estadoPromocional: it.estado,
      motivos: it.motivos,
    };
  });

  const total = (campo) => {
    const lista = itens.map((i) => i[campo]);
    const c = somaOuNull(lista.map((v) => v.centavos));
    const est = piorEstado(lista.map((v) => v.estado));
    const fontes = [...new Set(lista.map((v) => v.fonte).filter(Boolean))];
    return { centavos: c, estado: c === null && est !== "contraditorio" ? "desconhecido" : est, fonte: c === null ? null : fontes.join("+") || null };
  };

  // ── comissão ───────────────────────────────────────────────────────────────────────────
  const bl = conc.centavos.billing;
  const comprovada = conc.estado === "TARIFA_LIQUIDA_COMPROVADA" || conc.estado === "TARIFA_BRUTA_COMPROVADA";
  const estBilling = comprovada ? "comprovado" : "observado";
  const comissao = {
    doPedido: valor(conc.centavos.sale_fee_pedido, "observado", "orders_api"),
    bruta: valor(bl ? bl.gross : null, estBilling, "billing_api"),
    liquida: valor(bl ? bl.net : null, estBilling, "billing_api"),
    cobrancasDaTarifa: valor(conc.centavos.cobrancas_tarifa, estBilling, "billing_api"),
    naturezaNoMotor:
      conc.estado === "TARIFA_LIQUIDA_COMPROVADA" ? "liquida_comprovada"
        : conc.estado === "TARIFA_BRUTA_COMPROVADA" ? "bruta_comprovada"
          : conc.estado === "DIVERGENTE" ? "divergente" : "nao_verificada",
    estadoConciliacao: conc.estado,
    documento: conc.faturamento.documento,
    documentoDefinitivo: conc.faturamento.definitivo === true,
  };

  // ── rebate ─────────────────────────────────────────────────────────────────────────────
  let identificado;
  if (conc.rebate.billing_centavos !== null) identificado = valor(conc.rebate.billing_centavos, comprovada ? "comprovado" : "observado", "billing_api");
  else if (conc.rebate.calculado_descontos_centavos !== null) identificado = valor(conc.rebate.calculado_descontos_centavos, "calculado", "discounts_api");
  else identificado = valor(null, "desconhecido");
  const rebate = {
    identificado,
    incorporadoNaComissao: conc.rebate_incorporado, // comprovado | nao | nao_aplicavel | desconhecido
    calculadoPelosDescontos: valor(conc.rebate.calculado_descontos_centavos, "calculado", "discounts_api"),
    descontosEBillingConcordam: conc.rebate.concordam,
  };

  // ── crédito adicional (anti-dupla-contagem) ────────────────────────────────────────────
  let creditoAdicionalComprovado;
  if (conc.estado === "TARIFA_LIQUIDA_COMPROVADA") {
    creditoAdicionalComprovado = { centavos: 0, estado: "comprovado", motivo: conc.rebate_incorporado === "comprovado" ? "rebate_ja_incorporado_na_comissao" : "sem_rebate", fonte: "billing_api" };
  } else if (conc.estado === "TARIFA_BRUTA_COMPROVADA") {
    creditoAdicionalComprovado = { centavos: bl.gross - bl.net, estado: "comprovado", motivo: "tarifa_do_pedido_e_bruta", fonte: "billing_api" };
  } else {
    creditoAdicionalComprovado = { centavos: null, estado: "desconhecido", motivo: conc.estado === "DIVERGENTE" ? "conciliacao_divergente" : "nao_conciliado", fonte: null };
  }
  const limiteSuperiorNaoComprovado = comprovada ? null : evidencia.credito_max_pedido;

  // ── cupom (sinal; não modelado no resultado) ───────────────────────────────────────────
  const s = evidencia.sinais || {};
  const cupom = {
    total: valor(s.cupom_detalhe ? s.cupom_detalhe.total : s.cupom_pedido ?? null, s.cupom_detalhe ? "observado" : "inferido", s.cupom_detalhe ? "discounts_api" : "orders_api"),
    vendedor: valor(s.cupom_detalhe ? s.cupom_detalhe.seller : null, "observado", "discounts_api"),
    modeladoNoResultado: false,
  };

  // ── divergências e pendências ──────────────────────────────────────────────────────────
  const divergencias = [];
  const vistos = new Set();
  const addDiv = (codigo, origem, detalhe = null) => {
    const chave = `${codigo}|${detalhe && detalhe.idx !== undefined ? detalhe.idx : ""}`;
    if (vistos.has(chave)) return;
    vistos.add(chave);
    divergencias.push({ codigo, entre: ENTRE[codigo] || origem, origem, detalhe });
  };
  for (const mot of conc.motivos) if (CATEGORIA_MOTIVO[mot] === "divergencia") addDiv(mot, "conciliacao", null);
  for (const it of evidencia.itens) {
    for (const mot of it.motivos) {
      if (MOTIVOS_ITEM_CONTRADITORIOS.has(mot)) addDiv(mot, "evidencia", { idx: it.idx, mlb: it.item_id, difGrossCentavos: it.verificacoes?.dif_gross_centavos ?? null });
    }
  }
  if (evidencia.motivos.includes("seller_divergente")) addDiv("seller_divergente", "evidencia", null);
  if (comissao.doPedido.centavos !== null && comissao.liquida.centavos !== null && comissao.naturezaNoMotor === "divergente") {
    // as duas pontas ficam visíveis
    for (const d of divergencias) if (d.codigo === "sale_fee_pedido_difere_do_net") d.detalhe = { pedidoCentavos: comissao.doPedido.centavos, billingNetCentavos: comissao.liquida.centavos, billingGrossCentavos: comissao.bruta.centavos };
  }
  const pendencias = conc.motivos.filter((mot) => CATEGORIA_MOTIVO[mot] === "bloqueio" || CATEGORIA_MOTIVO[mot] === "escopo");
  const avisos = conc.motivos.filter((mot) => CATEGORIA_MOTIVO[mot] === "aviso");
  if (evidencia.motivos.includes("cupom_presente_nao_modelado")) avisos.push("cupom_presente_nao_modelado");

  let estado;
  if (divergencias.length) estado = "DIVERGENTE";
  else if (comprovada) estado = "CONCILIADO";
  else if (fonteDesc === "lido" || fonteBill !== "nao_consultado") estado = "PARCIAL";
  else estado = "NAO_VERIFICADO";

  return {
    contrato: { versao: CONTRATO_VERSAO, evidencia: evidencia.v, conciliacao: conc.contrato.versao },
    pedidoId: evidencia.pedido.id,
    fontes: { orders: "lido", discounts: fonteDesc, billing: fonteBill },
    itens,
    totais: {
      precoCheio: total("precoCheio"),
      precoEfetivo: total("precoEfetivo"),
      descontoTotal: total("descontoTotal"),
      vendedorBancou: total("descontoVendedor"),
      marketplaceBancou: total("descontoMarketplace"),
    },
    cupom,
    comissao,
    rebate,
    creditoAdicionalComprovado,
    limiteSuperiorNaoComprovado,
    divergencias,
    pendencias,
    avisos: [...new Set(avisos)].sort(),
    estado,
    efeitoNoResultadoOficial: "nenhum",
  };
}

// ---------------------------------------------------------------------------
// Armazenamento: a composição vira componentes INFORMATIVOS (fora do resultado)
// do mesmo ledger — cabem nos arrays tipados do formato compacto (tipo, fonte,
// confiança e obs viram códigos do dicionário; o valor, numeric(14,2)). Só o que
// é conhecido vira componente: ausência de componente = "desconhecido", nunca 0.
// Nenhum payload de endpoint é guardado.
// ---------------------------------------------------------------------------
const TIPOS_PROMOCIONAIS = Object.freeze({
  preco_cheio: { escopo: "item" },
  desconto_vendedor: { escopo: "item" },
  desconto_marketplace: { escopo: "item" },
  comissao_bruta: { escopo: "pedido" },
  rebate_marketplace: { escopo: "pedido" },
  credito_comissao_comprovado: { escopo: "pedido" },
});

const reais = (c) => Math.round(c) / 100;

function componentesInformativos(composicao, { pedidoId, itemIdDoIdx }) {
  const out = [];
  const push = (tipo, itemId, v, obs = null) => {
    if (!v || v.centavos === null) return;
    out.push({ pedidoId, itemId, tipo, valor: reais(v.centavos), fonte: v.fonte, confianca: v.estado, obs });
  };
  for (const it of composicao.itens) {
    const itemId = itemIdDoIdx(it.idx);
    // preço cheio só quando há desconto: sem desconto ele é igual à receita (já gravada).
    if (it.descontoTotal.centavos !== null && it.descontoTotal.centavos > 0) push("preco_cheio", itemId, it.precoCheio);
    if (it.descontoTotal.centavos !== null && it.descontoTotal.centavos > 0) {
      push("desconto_vendedor", itemId, it.descontoVendedor);
      push("desconto_marketplace", itemId, it.descontoMarketplace);
    }
  }
  const natureza = composicao.comissao.naturezaNoMotor;
  push("comissao_bruta", null, composicao.comissao.bruta, `natureza:${natureza}`);
  push("rebate_marketplace", null, composicao.rebate.identificado, `incorporado:${composicao.rebate.incorporadoNaComissao}`);
  if (composicao.creditoAdicionalComprovado.centavos !== null) {
    push("credito_comissao_comprovado", null, composicao.creditoAdicionalComprovado, composicao.creditoAdicionalComprovado.motivo);
  }
  return out;
}

module.exports = {
  CONTRATO_VERSAO,
  ENV_NAME,
  ENV_CONTAS,
  isComposicaoPromocionalHabilitada,
  ESTADOS_VALOR,
  TIPOS_PROMOCIONAIS,
  comporPedido,
  componentesInformativos,
};
