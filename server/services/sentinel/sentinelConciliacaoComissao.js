// server/services/sentinel/sentinelConciliacaoComissao.js
//
// Conciliador de COMISSÃO por pedido (S1-B1). Função PURA: sem I/O, sem relógio, sem estado, sem ML, sem banco.
// Concilia três fontes JÁ LIDAS por quem chama:
//   1. pedido do ML (formato de /orders/{id} ou /orders/search): order_items[].sale_fee (por unidade), quantity…
//   2. GET /orders/{id}/discounts (opcional): parte financiada pelo ML por item, via adaptarDetalheDescontos();
//   3. GET /billing/integration/group/ML/order/details: sale_fee {gross, net, rebate, discount} + cobranças.
//
// O QUE FOI PROVADO (S1-A, 17/11/2026, conta 41, 6 pedidos de quantidade 1 e item único): sale_fee do pedido == billing
// sale_fee.net == Σ das cobranças CVVML + CVVPRC + CVVFNU; gross − net == rebate; rebate == parte do ML (total − seller)
// em /discounts quando funding_mode = "sale_fee". Fora disso NADA foi provado — por isso o estado é conservador.
//
// O QUE ESTE MÓDULO NÃO FAZ (por construção):
//   · não calcula nem altera margem, lucro, incidente ou alerta; `efeito_na_margem` é SEMPRE "nenhum";
//   · não soma o rebate a nada: quando o rebate já está na tarifa líquida ele só é DECLARADO como incorporado;
//   · não corrige valor divergente (DIVERGENTE preserva os dois lados);
//   · não trata ausência como zero (campo ausente ⇒ NAO_CONCILIADO, nunca "0 confirmado");
//   · não segue o Billing como verdade de liquidação: documento PROCESSING = cobrança OBSERVADA, `liquidacao` fica
//     "nao_verificada" mesmo com documento PROCESSED;
//   · não copia dado pessoal do Billing (payer_nickname, state_name, payer_id…): só valores e identificadores de cobrança.
//
// Reaproveita o contrato v1 de sentinelEvidenciaFinanceira (ESTADOS_CONCILIACAO, lerCentavos, adaptarDetalheDescontos)
// sem alterá-lo. Toda aritmética é em CENTAVOS INTEIROS; fração de centavo é inválida, nunca é arredondada.
//
// ENTRADA: conciliarComissaoPedido({ pedido, descontos, billing, conta, origem_billing, meta })
//   pedido          objeto do pedido ML (obrigatório). { id, status, seller:{id}, order_items[], payments[] }
//   descontos       resposta de /orders/{id}/discounts ou null/undefined (cruzamento opcional)
//   billing         resposta de /billing/integration/group/ML/order/details ({results, errors}) OU um único registro
//   conta           { id, sellerId } da conta Sentinel dona do pedido (opcional; sem ela o vínculo de conta é "nao_verificado")
//   origem_billing  { contaId } da conta cujo grant buscou o Billing (opcional)
//   meta            { billingHttpStatus } (opcional; 206 = parcial)
// SAÍDA: ver `resultadoBase()` — { contrato, pedido_id, estado, motivos[], rebate_incorporado, efeito_na_margem,
//   escopo_validado, vinculo, centavos, rebate, cobrancas[], faturamento, liquidacao }.

const { ESTADOS_CONCILIACAO, CONTRATO_VERSAO, lerCentavos, adaptarDetalheDescontos } = require("./sentinelEvidenciaFinanceira");

const CONCILIACAO_CONTRATO_VERSAO = 1;

// Subtipos de cobrança que compõem a tarifa de venda (sale_fee.net) — observados e provados no S1-A.
const SUBTIPOS_TARIFA = Object.freeze(["CVVML", "CVVPRC", "CVVFNU"]);
// Subtipos conhecidos que NÃO fazem parte da tarifa (frete extra, parcelamento pago pelo comprador).
const SUBTIPOS_FORA_DA_TARIFA = Object.freeze(["CXDE", "CFONPN"]);

const MOTIVOS = Object.freeze({
  // — impedem a comparação (⇒ NAO_CONCILIADO)
  PEDIDO_INVALIDO: "pedido_invalido",
  SEM_REGISTRO_BILLING: "sem_registro_billing",
  BILLING_DE_OUTRO_PEDIDO: "billing_de_outro_pedido",
  BILLING_REGISTRO_DUPLICADO: "billing_registro_duplicado",
  BILLING_PARCIAL: "billing_parcial",
  BILLING_DE_OUTRA_CONTA: "billing_de_outra_conta",
  PEDIDO_DE_OUTRA_CONTA: "pedido_de_outra_conta",
  ITEM_NAO_CONFERE: "item_nao_confere",
  PAGAMENTO_NAO_CONFERE: "pagamento_nao_confere",
  CAMPO_BILLING_AUSENTE: "campo_billing_ausente",
  VALOR_INVALIDO: "valor_invalido",
  SALE_FEE_PEDIDO_INVALIDO: "sale_fee_pedido_invalido",
  COBRANCA_DUPLICADA: "cobranca_duplicada",
  COBRANCA_MULTIPLA_MESMO_TIPO: "cobranca_multipla_mesmo_tipo",
  SUBTIPO_DESCONHECIDO: "subtipo_cobranca_desconhecido",
  SEM_COBRANCAS_DE_TARIFA: "sem_cobrancas_de_tarifa",
  DESCONTO_SEM_ITEM_CORRESPONDENTE: "desconto_sem_item_correspondente",
  // — fora do escopo validado (⇒ NAO_CONCILIADO, conservador)
  MULTIPLOS_ITENS: "multiplos_itens_nao_validado",
  QUANTIDADE_MAIOR_QUE_1: "quantidade_maior_que_1_nao_validada",
  CUPOM_NAO_VALIDADO: "cupom_nao_validado",
  CASHBACK_NAO_VALIDADO: "cashback_nao_validado",
  DESCONTO_TIPO_DESCONHECIDO: "desconto_tipo_desconhecido",
  CANCELAMENTO_OU_REEMBOLSO: "cancelamento_ou_reembolso_nao_validado",
  PEDIDO_NAO_PAGO: "pedido_nao_pago_nao_validado",
  BILLING_COM_BONIFICACAO_OU_CREDITO: "billing_com_bonificacao_ou_credito_nao_validado",
  FUNDING_MODE_NAO_VALIDADO: "funding_mode_nao_validado",
  DISCOUNT_BILLING_NAO_VALIDADO: "discount_billing_nao_validado",
  // — divergências (⇒ DIVERGENTE, sem ajuste)
  SALE_FEE_DIFERE_DO_NET: "sale_fee_pedido_difere_do_net",
  REBATE_POSSIVELMENTE_EM_DOBRO: "rebate_possivelmente_contado_duas_vezes",
  COBRANCAS_NAO_SOMAM_NET: "cobrancas_nao_somam_net",
  IDENTIDADE_GROSS_NET: "identidade_gross_net_violada",
  REBATE_DIFERE_DO_CALCULADO: "rebate_billing_difere_do_calculado",
  // — avisos (não mudam o estado)
  DOCUMENTO_EM_PROCESSAMENTO: "documento_em_processamento",
  CONTA_NAO_VERIFICADA: "conta_nao_verificada",
  CRUZAMENTO_DESCONTOS_INDISPONIVEL: "cruzamento_com_descontos_indisponivel",
  TARIFA_DO_PEDIDO_E_BRUTA: "tarifa_do_pedido_e_bruta",
});

const idTexto = (v) => (v === null || v === undefined || v === "" ? null : String(v));
const ehObjeto = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const somar = (arr) => arr.reduce((a, b) => a + b, 0);

function resultadoBase() {
  return {
    contrato: { versao: CONCILIACAO_CONTRATO_VERSAO, evidencia_versao: CONTRATO_VERSAO },
    pedido_id: null,
    estado: "NAO_CONCILIADO",
    motivos: [],
    rebate_incorporado: "desconhecido", // comprovado | nao_aplicavel | nao | desconhecido
    efeito_na_margem: "nenhum",          // invariante do contrato: o conciliador NUNCA mexe na margem
    escopo_validado: false,
    vinculo: { pedido_billing: "nao_verificado", item: "nao_verificado", pagamento: "nao_verificado", conta: "nao_verificado" },
    centavos: { sale_fee_pedido: null, billing: null, cobrancas_tarifa: null },
    rebate: { billing_centavos: null, calculado_descontos_centavos: null, concordam: null, origem: null },
    cobrancas: [],
    faturamento: { documento: "NAO_APLICAVEL", definitivo: false },
    liquidacao: "nao_verificada",
  };
}

// valor monetário válido e não negativo → { c, ok } ; ausente/inválido → motivo é decidido por quem chama
function centavosNaoNegativos(v) {
  const l = lerCentavos(v);
  if (l.st === "ausente") return { c: null, st: "ausente" };
  if (l.st !== "ok") return { c: null, st: "invalido" };
  if (l.c < 0) return { c: null, st: "invalido" };
  return { c: l.c, st: "ok" };
}

function conciliarComissaoPedido(entrada) {
  const e = ehObjeto(entrada) ? entrada : {};
  const res = resultadoBase();
  const m = { bloqueio: new Set(), escopo: new Set(), divergencia: new Set(), aviso: new Set() };
  const fim = () => finalizar(res, m);

  // ── 1. pedido ────────────────────────────────────────────────────────────────────────────────
  const p = e.pedido;
  const pid = ehObjeto(p) ? idTexto(p.id) : null;
  const itens = ehObjeto(p) && Array.isArray(p.order_items) ? p.order_items.filter(ehObjeto) : [];
  if (!pid || !itens.length) { m.bloqueio.add(MOTIVOS.PEDIDO_INVALIDO); return fim(); }
  res.pedido_id = pid;

  // ── 2. escopo do PEDIDO (o que o S1-A não validou) ───────────────────────────────────────────
  if (itens.length > 1) m.escopo.add(MOTIVOS.MULTIPLOS_ITENS);
  const idsItens = new Set(itens.map((i) => idTexto(i?.item?.id)).filter(Boolean));
  let feeTotal = 0;
  let feeOk = true;
  for (const i of itens) {
    const q = Number(i.quantity);
    if (!Number.isInteger(q) || q < 1) { feeOk = false; m.bloqueio.add(MOTIVOS.VALOR_INVALIDO); continue; }
    if (q > 1) m.escopo.add(MOTIVOS.QUANTIDADE_MAIOR_QUE_1);
    const f = centavosNaoNegativos(i.sale_fee); // sale_fee do pedido é POR UNIDADE
    if (f.st !== "ok") { feeOk = false; m.bloqueio.add(MOTIVOS.SALE_FEE_PEDIDO_INVALIDO); continue; }
    feeTotal += f.c * q;
  }
  const feePedido = feeOk ? feeTotal : null;
  res.centavos.sale_fee_pedido = feePedido;

  const status = typeof p.status === "string" ? p.status.toLowerCase() : "";
  if (status === "cancelled" || status === "invalid") m.escopo.add(MOTIVOS.CANCELAMENTO_OU_REEMBOLSO);
  else if (status !== "paid") m.escopo.add(MOTIVOS.PEDIDO_NAO_PAGO);
  const pagamentosPedido = Array.isArray(p.payments) ? p.payments.filter(ehObjeto) : [];
  for (const pg of pagamentosPedido) {
    if ((typeof pg.status === "string" && pg.status !== "approved") || Number(pg.transaction_amount_refunded) > 0) m.escopo.add(MOTIVOS.CANCELAMENTO_OU_REEMBOLSO);
  }

  // ── 3. /orders/{id}/discounts (cruzamento; nunca decide sozinho) ─────────────────────────────
  let calculadoMl = null; // parte do ML em centavos; null = não calculável (≠ zero)
  if (ehObjeto(e.descontos)) {
    const dets = Array.isArray(e.descontos.details) ? e.descontos.details : [];
    for (const d of dets) {
      const t = d?.type;
      if (t === "coupon") m.escopo.add(MOTIVOS.CUPOM_NAO_VALIDADO);
      else if (t === "cashback") m.escopo.add(MOTIVOS.CASHBACK_NAO_VALIDADO);
      else if (t !== "discount") m.escopo.add(MOTIVOS.DESCONTO_TIPO_DESCONHECIDO);
    }
    const ad = adaptarDetalheDescontos(e.descontos, itens);
    if (ad.motivos.has("detalhe_sem_item_correspondente")) m.bloqueio.add(MOTIVOS.DESCONTO_SEM_ITEM_CORRESPONDENTE);
    let temLinha = false;
    let sellerConhecido = true;
    let ml = 0;
    let mlComFundingDiferente = false;
    for (const [idx, ent] of ad.porItem) {
      if (ent.erro) { m.bloqueio.add(MOTIVOS.VALOR_INVALIDO); sellerConhecido = false; continue; }
      const q = Number(itens[idx]?.quantity);
      for (const ln of ent.linhas) {
        temLinha = true;
        if (ln.seller === null) { sellerConhecido = false; continue; }
        const parte = (ln.full - ln.seller) * (Number.isInteger(q) && q > 0 ? q : 1);
        if (parte < 0) { m.bloqueio.add(MOTIVOS.VALOR_INVALIDO); sellerConhecido = false; continue; }
        ml += parte;
        if (parte > 0 && ln.fm !== "sale_fee") mlComFundingDiferente = true;
      }
    }
    if (temLinha && sellerConhecido) calculadoMl = ml;
    if (mlComFundingDiferente) m.escopo.add(MOTIVOS.FUNDING_MODE_NAO_VALIDADO);
  }
  res.rebate.calculado_descontos_centavos = calculadoMl;
  if (calculadoMl !== null) res.rebate.origem = "calculado_apenas";

  // ── 4. registro do Billing ───────────────────────────────────────────────────────────────────
  const b = e.billing;
  const registros = ehObjeto(b) && Array.isArray(b.results) ? b.results.filter(ehObjeto) : ehObjeto(b) && b.order_id !== undefined ? [b] : [];
  const parcial = (ehObjeto(b) && Array.isArray(b.errors) && b.errors.length > 0) || Number(e.meta?.billingHttpStatus) === 206;
  if (parcial) m.bloqueio.add(MOTIVOS.BILLING_PARCIAL);
  if (!registros.length) { m.bloqueio.add(MOTIVOS.SEM_REGISTRO_BILLING); verificarConta(e, p, res, m); return fim(); }
  const meus = registros.filter((r) => idTexto(r.order_id) === pid);
  if (!meus.length) { m.bloqueio.add(MOTIVOS.BILLING_DE_OUTRO_PEDIDO); res.vinculo.pedido_billing = "diverge"; verificarConta(e, p, res, m); return fim(); }
  if (meus.length > 1) { m.bloqueio.add(MOTIVOS.BILLING_REGISTRO_DUPLICADO); res.vinculo.pedido_billing = "ambiguo"; verificarConta(e, p, res, m); return fim(); }
  const rec = meus[0];
  res.vinculo.pedido_billing = "confere";
  verificarConta(e, p, res, m);

  const detalhes = Array.isArray(rec.details) ? rec.details.filter(ehObjeto) : [];

  // vínculo de item/pedido dentro de cada cobrança
  let itemVerificado = false;
  let itemDiverge = false;
  let pedidoDiverge = false;
  for (const d of detalhes) {
    for (const s of Array.isArray(d.sales_info) ? d.sales_info : []) if (s && idTexto(s.order_id) !== null && idTexto(s.order_id) !== pid) pedidoDiverge = true;
    for (const it of Array.isArray(d.items_info) ? d.items_info : []) {
      if (!it) continue;
      if (idTexto(it.order_id) !== null && idTexto(it.order_id) !== pid) pedidoDiverge = true;
      if (idTexto(it.item_id) !== null) { itemVerificado = true; if (!idsItens.has(idTexto(it.item_id))) itemDiverge = true; }
    }
  }
  if (pedidoDiverge) { m.bloqueio.add(MOTIVOS.BILLING_DE_OUTRO_PEDIDO); res.vinculo.pedido_billing = "diverge"; }
  if (itemDiverge) { m.bloqueio.add(MOTIVOS.ITEM_NAO_CONFERE); res.vinculo.item = "diverge"; } else if (itemVerificado) res.vinculo.item = "confere";

  // vínculo de pagamento
  const pgBilling = Array.isArray(rec.payment_info) ? rec.payment_info.filter(ehObjeto) : [];
  const idsPgPedido = new Set(pagamentosPedido.map((x) => idTexto(x.id)).filter(Boolean));
  const idsPgBilling = pgBilling.map((x) => idTexto(x.payment_id)).filter(Boolean);
  if (idsPgPedido.size && idsPgBilling.length) {
    if (idsPgBilling.some((i) => idsPgPedido.has(i))) res.vinculo.pagamento = "confere";
    else { res.vinculo.pagamento = "diverge"; m.bloqueio.add(MOTIVOS.PAGAMENTO_NAO_CONFERE); }
  }
  for (const x of pgBilling) if (typeof x.status === "string" && x.status !== "approved") m.escopo.add(MOTIVOS.CANCELAMENTO_OU_REEMBOLSO);

  // ── 5. sale_fee do Billing (cada campo: ausente ≠ zero) ──────────────────────────────────────
  const sf = ehObjeto(rec.sale_fee) ? rec.sale_fee : {};
  const bl = { gross: null, net: null, rebate: null, discount: null };
  let billingCompleto = true;
  for (const campo of Object.keys(bl)) {
    const v = centavosNaoNegativos(sf[campo]);
    if (v.st === "ok") bl[campo] = v.c;
    else { billingCompleto = false; m.bloqueio.add(v.st === "ausente" ? MOTIVOS.CAMPO_BILLING_AUSENTE : MOTIVOS.VALOR_INVALIDO); }
  }
  res.centavos.billing = bl;
  if (bl.rebate !== null) { res.rebate.billing_centavos = bl.rebate; res.rebate.origem = "billing_observado"; }

  // ── 6. cobranças vinculadas à venda ──────────────────────────────────────────────────────────
  const vistos = new Set();
  const porSubtipo = new Map();
  const docs = new Set();
  let cobrancasOk = true;
  for (const d of detalhes) {
    const ci = ehObjeto(d.charge_info) ? d.charge_info : {};
    const sub = typeof ci.detail_sub_type === "string" ? ci.detail_sub_type : "";
    const detailId = idTexto(ci.detail_id);
    const mkt = typeof d.marketplace_info?.marketplace === "string" ? d.marketplace_info.marketplace : "";
    const valor = lerCentavos(ci.detail_amount);
    const registro = { detail_id: detailId, subtipo: sub || null, valor_centavos: valor.st === "ok" ? valor.c : null, documento: typeof ci.legal_document_status === "string" ? ci.legal_document_status : null, na_tarifa: false };
    if ((ci.detail_type && ci.detail_type !== "CHARGE") || (ci.status !== null && ci.status !== undefined) || idTexto(ci.charge_bonified_id)) {
      m.escopo.add(MOTIVOS.BILLING_COM_BONIFICACAO_OU_CREDITO);
      res.cobrancas.push(registro);
      continue;
    }
    if (detailId) {
      if (vistos.has(detailId)) { m.bloqueio.add(MOTIVOS.COBRANCA_DUPLICADA); continue; } // não conta duas vezes
      vistos.add(detailId);
    }
    const ehTarifa = SUBTIPOS_TARIFA.includes(sub);
    if (!ehTarifa && !SUBTIPOS_FORA_DA_TARIFA.includes(sub) && (mkt === "CORE" || mkt === "")) m.bloqueio.add(MOTIVOS.SUBTIPO_DESCONHECIDO);
    if (ehTarifa) {
      registro.na_tarifa = true;
      if (valor.st !== "ok" || valor.c < 0) { cobrancasOk = false; m.bloqueio.add(MOTIVOS.VALOR_INVALIDO); }
      porSubtipo.set(sub, (porSubtipo.get(sub) || 0) + 1);
      if (registro.documento && registro.documento !== "NOT_APPLICABLE") docs.add(registro.documento);
    }
    res.cobrancas.push(registro);
  }
  for (const n of porSubtipo.values()) if (n > 1) m.bloqueio.add(MOTIVOS.COBRANCA_MULTIPLA_MESMO_TIPO);
  const tarifa = res.cobrancas.filter((c) => c.na_tarifa);
  if (!tarifa.length) m.bloqueio.add(MOTIVOS.SEM_COBRANCAS_DE_TARIFA);
  const somaTarifa = cobrancasOk && tarifa.length ? somar(tarifa.map((c) => c.valor_centavos)) : null;
  res.centavos.cobrancas_tarifa = somaTarifa;
  if (tarifa.length) {
    const lista = [...docs];
    res.faturamento.documento = lista.length === 0 ? "NAO_APLICAVEL" : lista.length === 1 ? lista[0] : "MISTO";
    res.faturamento.definitivo = lista.length === 1 && lista[0] === "PROCESSED";
    if (lista.includes("PROCESSING") || res.faturamento.documento === "MISTO") m.aviso.add(MOTIVOS.DOCUMENTO_EM_PROCESSAMENTO);
  }

  // ── 7. verificações numéricas (centavos inteiros; só com dado completo e válido) ─────────────
  if (billingCompleto) {
    if (bl.discount > 0) m.escopo.add(MOTIVOS.DISCOUNT_BILLING_NAO_VALIDADO); // nunca visto em produção; fica SEPARADO do rebate
    if (bl.gross - bl.net !== bl.rebate + bl.discount) m.divergencia.add(MOTIVOS.IDENTIDADE_GROSS_NET);
    if (somaTarifa !== null && somaTarifa !== bl.net) m.divergencia.add(MOTIVOS.COBRANCAS_NAO_SOMAM_NET);
    if (res.rebate.calculado_descontos_centavos === null) m.aviso.add(MOTIVOS.CRUZAMENTO_DESCONTOS_INDISPONIVEL);
    else {
      res.rebate.concordam = res.rebate.calculado_descontos_centavos === bl.rebate;
      if (!res.rebate.concordam) m.divergencia.add(MOTIVOS.REBATE_DIFERE_DO_CALCULADO);
    }
    if (feePedido !== null) {
      if (feePedido === bl.net) { /* tarifa do pedido == net: rebate (se houver) já está incorporado */ }
      else if (feePedido === bl.gross && bl.gross !== bl.net) { res.__bruta = true; m.aviso.add(MOTIVOS.TARIFA_DO_PEDIDO_E_BRUTA); }
      else {
        m.divergencia.add(MOTIVOS.SALE_FEE_DIFERE_DO_NET);
        if (bl.rebate > 0 && feePedido === bl.net - bl.rebate) m.divergencia.add(MOTIVOS.REBATE_POSSIVELMENTE_EM_DOBRO);
      }
    }
  }
  return fim();
}

// conta: só afirma "verificado" quando há DUAS pontas comparáveis; diverge ⇒ bloqueia.
function verificarConta(e, p, res, m) {
  const conta = ehObjeto(e.conta) ? e.conta : null;
  let verificado = false;
  const sellerPedido = ehObjeto(p) ? idTexto(p.seller?.id) : null;
  const sellerConta = conta ? idTexto(conta.sellerId) : null;
  if (sellerPedido && sellerConta) {
    if (sellerPedido === sellerConta) verificado = true;
    else { m.bloqueio.add(MOTIVOS.PEDIDO_DE_OUTRA_CONTA); res.vinculo.conta = "diverge"; }
  }
  const contaBilling = ehObjeto(e.origem_billing) ? idTexto(e.origem_billing.contaId) : null;
  const contaId = conta ? idTexto(conta.id) : null;
  if (contaBilling && contaId) {
    if (contaBilling === contaId) verificado = verificado || true;
    else { m.bloqueio.add(MOTIVOS.BILLING_DE_OUTRA_CONTA); res.vinculo.conta = "diverge"; }
  }
  if (res.vinculo.conta === "diverge") return;
  if (verificado) res.vinculo.conta = "verificado";
  else m.aviso.add(MOTIVOS.CONTA_NAO_VERIFICADA);
}

function finalizar(res, m) {
  const bruta = res.__bruta === true;
  delete res.__bruta;
  const todos = new Set([...m.bloqueio, ...m.escopo, ...m.divergencia, ...m.aviso]);
  res.motivos = [...todos].sort();
  res.escopo_validado = m.escopo.size === 0 && !m.bloqueio.has(MOTIVOS.PEDIDO_INVALIDO);
  if (m.bloqueio.size || m.escopo.size) res.estado = "NAO_CONCILIADO";
  else if (m.divergencia.size) res.estado = "DIVERGENTE";
  else res.estado = bruta ? "TARIFA_BRUTA_COMPROVADA" : "TARIFA_LIQUIDA_COMPROVADA";

  if (res.estado === "TARIFA_LIQUIDA_COMPROVADA") res.rebate_incorporado = res.centavos.billing.rebate === 0 ? "nao_aplicavel" : "comprovado";
  else if (res.estado === "TARIFA_BRUTA_COMPROVADA") res.rebate_incorporado = "nao";
  else res.rebate_incorporado = "desconhecido";
  if (!ESTADOS_CONCILIACAO.includes(res.estado)) throw new Error("estado de conciliação fora do contrato v1");
  return res;
}

module.exports = {
  CONCILIACAO_CONTRATO_VERSAO,
  MOTIVOS,
  SUBTIPOS_TARIFA,
  SUBTIPOS_FORA_DA_TARIFA,
  conciliarComissaoPedido,
};
