// server/services/centralVendas/centralVendasComposicaoFinanceira.js
//
// Contrato da COMPOSIÇÃO FINANCEIRA da Central de Vendas (v1) — declarativo e
// puro. Formaliza o que o motor JÁ calcula (nenhuma fórmula muda) e marca
// explicitamente o que é informativo, o que é lacuna e o que depende de fonte
// externa (Ads, Full, Billing). Usado pela tela (cascata), pela documentação
// (docs/banco-de-dados/14_CONTRATO_FINANCEIRO.md) e pelos testes.
//
// Quatro resultados que NUNCA se misturam:
//   resultado_venda        = MC do motor (lucroContribuicao): receita de produto
//                            − comissão − frete do vendedor − CMV − imposto.
//                            Só pedidos que entram no resultado e calculáveis.
//   resultado_operacional  = resultado_venda − Ads − Full, só quando Ads e Full
//                            são da MESMA conta e do MESMO período (ver
//                            centralVendasCustosOperacionais). Senão: null.
//   conciliacao            = valores de conferência (receita de envio,
//                            reembolso, Billing, Mercado Pago). Nunca somados.
//   informativo            = composição promocional (preço cheio, descontos,
//                            rebate) — explica a receita, não a altera.

const ESTADO = Object.freeze({
  IMPLEMENTADO: "implementado",   // o motor grava e o resultado usa
  INFORMATIVO: "informativo",     // gravado/derivado, fora do resultado
  CONTRATO_PRONTO: "contrato_pronto", // função pura pronta, ainda não gravada
  EXTERNO: "externo",             // fonte por conta × período (Ads/Full), fora do pedido
  LACUNA: "lacuna",               // não modelado; nunca vira zero
});

// sinal: +1 aumenta o resultado, −1 reduz, 0 não entra.
const CATALOGO = Object.freeze([
  { id: "faturamento_bruto", rotulo: "Faturamento a preço cheio", escopos: ["item", "pedido", "produto", "conta", "periodo"], sinal: 0, entraEm: ["informativo"], fonte: "orders_api.gross_price", componente: "preco_cheio", estado: ESTADO.CONTRATO_PRONTO, nota: "Só difere da receita quando há desconto; sem desconto não é gravado (= receita)." },
  { id: "descontos", rotulo: "Descontos promocionais", escopos: ["item", "pedido", "produto", "conta", "periodo"], sinal: 0, entraEm: ["informativo"], fonte: "orders_api.gross_price − unit_price; split por /orders/{id}/discounts", componente: "desconto_vendedor + desconto_marketplace", estado: ESTADO.CONTRATO_PRONTO, nota: "Já está FORA da receita (unit_price é pós-desconto). Mostrar, nunca subtrair de novo." },
  { id: "subsidio_marketplace", rotulo: "Subsídio do Mercado Livre", escopos: ["item", "pedido"], sinal: 0, entraEm: ["informativo"], fonte: "/orders/{id}/discounts (total − seller)", componente: "desconto_marketplace", estado: ESTADO.CONTRATO_PRONTO, nota: "Parte do desconto bancada pelo ML; quando funding_mode=sale_fee, volta como rebate na comissão." },
  { id: "cupons", rotulo: "Cupons", escopos: ["pedido"], sinal: 0, entraEm: ["informativo"], fonte: "/orders/{id}/discounts type=coupon", componente: null, estado: ESTADO.LACUNA, nota: "Exposto como sinal. Efeito no repasse do vendedor NÃO validado (VALIDACOES_PENDENTES cupom_do_vendedor_nao_modelado)." },
  { id: "receita_produto", rotulo: "Receita de produtos", escopos: ["item", "pedido", "produto", "conta", "periodo"], sinal: +1, entraEm: ["resultado_venda"], fonte: "orders_api.unit_price × quantity", componente: "receita_produto", estado: ESTADO.IMPLEMENTADO },
  { id: "receita_envio", rotulo: "Receita de envio", escopos: ["pedido"], sinal: 0, entraEm: ["conciliacao"], fonte: "shipments costs receiver", componente: "receita_envio", estado: ESTADO.INFORMATIVO },
  { id: "comissao", rotulo: "Comissão (tarifa de venda)", escopos: ["item", "pedido", "produto", "conta", "periodo"], sinal: -1, entraEm: ["resultado_venda"], fonte: "orders_api.sale_fee × quantity", componente: "tarifa_venda", estado: ESTADO.IMPLEMENTADO, nota: "Provado em amostra (S1-A): sale_fee do pedido = Billing net (já líquida do rebate). Conciliação por pedido em centralVendasComposicaoPromocional." },
  { id: "comissao_bruta", rotulo: "Comissão bruta (Billing)", escopos: ["pedido"], sinal: 0, entraEm: ["conciliacao"], fonte: "billing sale_fee.gross", componente: "comissao_bruta", estado: ESTADO.CONTRATO_PRONTO },
  { id: "rebate", rotulo: "Rebate do Mercado Livre", escopos: ["pedido"], sinal: 0, entraEm: ["conciliacao"], fonte: "billing sale_fee.rebate; cruzado com /discounts", componente: "rebate_marketplace", estado: ESTADO.CONTRATO_PRONTO, nota: "Incorporado à comissão quando a tarifa do pedido = net. Nunca somado ao resultado." },
  { id: "credito_comissao", rotulo: "Crédito adicional comprovado", escopos: ["pedido"], sinal: 0, entraEm: ["conciliacao"], fonte: "billing gross − net quando a tarifa do pedido é a bruta", componente: "credito_comissao_comprovado", estado: ESTADO.CONTRATO_PRONTO, nota: "Proposta de ajuste exibida ao lado do resultado oficial; só altera o oficial com decisão explícita." },
  { id: "tarifa_fixa", rotulo: "Tarifa fixa por unidade", escopos: ["item"], sinal: -1, entraEm: ["resultado_venda"], fonte: "contida em sale_fee (CVVFNU no Billing)", componente: "tarifa_venda", estado: ESTADO.IMPLEMENTADO, nota: "Não é componente próprio: está dentro da tarifa de venda. Separável pelo Billing (CVVFNU)." },
  { id: "frete_seller", rotulo: "Frete pago pelo vendedor", escopos: ["item", "pedido", "pack"], sinal: -1, entraEm: ["resultado_venda"], fonte: "shipments costs senders (rateio por pack/unidades)", componente: "frete_seller", estado: ESTADO.IMPLEMENTADO, nota: "Inclui o frete das vendas Full (CFFE/CFFI no Billing) — por isso o Full mensal NÃO o soma." },
  { id: "cmv", rotulo: "Custo do produto (CMV)", escopos: ["item", "pedido", "produto"], sinal: -1, entraEm: ["resultado_venda"], fonte: "base de custos da conta", componente: "custo_produto", estado: ESTADO.IMPLEMENTADO, nota: "Sem custo ⇒ pedido bloqueado (resultado null). Identidade da base: pendente (ver doc 14 §base)." },
  { id: "imposto", rotulo: "Impostos", escopos: ["item", "pedido", "produto"], sinal: -1, entraEm: ["resultado_venda"], fonte: "alíquota da base × receita", componente: "imposto_interno", estado: ESTADO.IMPLEMENTADO },
  { id: "cancelamentos", rotulo: "Cancelamentos", escopos: ["pedido"], sinal: 0, entraEm: ["conciliacao"], fonte: "status do pedido", componente: null, estado: ESTADO.IMPLEMENTADO, nota: "Pedido cancelado sai do resultado inteiro (STATUS_FORA_DO_RESULTADO)." },
  { id: "reembolsos", rotulo: "Reembolsos", escopos: ["pedido"], sinal: 0, entraEm: ["conciliacao"], fonte: "payments refunded", componente: "cancelamento_reembolso", estado: ESTADO.INFORMATIVO },
  { id: "devolucoes", rotulo: "Devoluções", escopos: ["pedido"], sinal: 0, entraEm: ["conciliacao"], fonte: "claims/returns", componente: null, estado: ESTADO.INFORMATIVO, nota: "Pós-venda marca o pedido (posVendaTipo); custo de logística reversa não modelado." },
  { id: "mediacoes", rotulo: "Mediações", escopos: ["pedido"], sinal: 0, entraEm: ["conciliacao"], fonte: "claims", componente: null, estado: ESTADO.LACUNA },
  { id: "ajustes", rotulo: "Ajustes de plataforma", escopos: ["pedido"], sinal: 0, entraEm: ["conciliacao"], fonte: "planilha (descontos_e_bonus) / Billing BONUS", componente: null, estado: ESTADO.LACUNA, nota: "Resíduo do motor de planilha (pendência ajuste_plataforma_presente) não tem componente próprio." },
  { id: "ads", rotulo: "Publicidade (Product Ads)", escopos: ["conta", "periodo", "produto"], sinal: -1, entraEm: ["resultado_operacional"], fonte: "Mercado Ads (financeiro_ads_cache / janela exata)", componente: null, estado: ESTADO.EXTERNO, nota: "Nunca replicado por pedido. Período parcial com fonte mensal ⇒ incompatível." },
  { id: "full", rotulo: "Custos Full", escopos: ["conta", "periodo"], sinal: -1, entraEm: ["resultado_operacional"], fonte: "Billing CFWA/CFBA/CFCBI/CFCBE/CFRS (financeiro_full_cache)", componente: null, estado: ESTADO.EXTERNO, nota: "Exclui CFFE/CFFI (frete por venda, já no frete_seller)." },
]);

const RESULTADOS = Object.freeze({
  resultado_venda: { rotulo: "Margem de contribuição", formula: "receita_produto − comissao − frete_seller − cmv − imposto", denominador: "receita_produto dos pedidos no resultado" },
  resultado_operacional: { rotulo: "Resultado após Ads e Full", formula: "resultado_venda − ads − full (mesma conta, mesmo período)", denominador: "receita_produto dos pedidos no resultado" },
});

const c = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));

// Cascata do período a partir do contrato de pedido da Central (buildPedidos).
// Reproduz a soma do motor sem recalcular nada e PROVA a identidade pedido a
// pedido; qualquer resíduo (ex.: ajuste de plataforma da planilha) é exposto.
function cascataDoPeriodo(pedidos) {
  const linhas = {
    receita_produto: { centavos: 0, pedidos: 0, ausentes: 0 },
    comissao: { centavos: 0, pedidos: 0, ausentes: 0 },
    frete_seller: { centavos: 0, pedidos: 0, ausentes: 0 },
    cmv: { centavos: 0, pedidos: 0, ausentes: 0 },
    imposto: { centavos: 0, pedidos: 0, ausentes: 0 },
  };
  const conc = { receita_envio: 0, reembolso: 0 };
  let resultado = 0;
  const fora = { cancelados: 0, semResultado: 0, receitaSemResultado: 0 };
  const residuos = [];
  let noResultado = 0;
  for (const p of pedidos || []) {
    if (!p.entraNoResultado) { fora.cancelados += 1; continue; }
    if (p.resultado === null || p.resultado === undefined) {
      fora.semResultado += 1;
      fora.receitaSemResultado += c(p.valor) || 0;
      continue;
    }
    noResultado += 1;
    const campos = { receita_produto: p.valor, comissao: p.taxas, frete_seller: p.frete, cmv: p.custo, imposto: p.imposto };
    for (const [k, v] of Object.entries(campos)) {
      if (v === null || v === undefined) linhas[k].ausentes += 1;
      else { linhas[k].centavos += c(v); linhas[k].pedidos += 1; }
    }
    conc.receita_envio += c(p.receitaEnvio) || 0;
    conc.reembolso += c(p.reembolso) || 0;
    const esperado = (c(p.valor) || 0) - (c(p.taxas) || 0) - (c(p.frete) || 0) - (c(p.custo) || 0) - (c(p.imposto) || 0);
    const r = c(p.resultado);
    resultado += r;
    if (Math.abs(esperado - r) > 1) residuos.push({ rowId: p.rowId ?? null, pedidoId: p.pedidoId, residuoCentavos: r - esperado });
  }
  const receita = linhas.receita_produto.centavos;
  const margem = (v) => (receita > 0 ? Math.round((v / receita) * 10000) / 100 : null);
  return {
    contrato: 1,
    pedidosNoResultado: noResultado,
    fora,
    linhas,
    resultadoVenda: { centavos: resultado, margemPercentual: margem(resultado), denominador: "receita_produto dos pedidos no resultado" },
    identidade: { fecha: residuos.length === 0, residuos },
    conciliacao: conc,
  };
}

module.exports = { ESTADO, CATALOGO, RESULTADOS, cascataDoPeriodo };
