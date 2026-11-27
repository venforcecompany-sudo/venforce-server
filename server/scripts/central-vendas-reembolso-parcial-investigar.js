#!/usr/bin/env node
// server/scripts/central-vendas-reembolso-parcial-investigar.js
//
// Evidência para a correção do REEMBOLSO PARCIAL (pedidos `partially_refunded`
// que ficam no resultado com a receita cheia e o reembolso fora). Antes de
// mudar o motor é preciso provar, pedido a pedido: quanto foi devolvido, QUEM
// bancou (vendedor × Mercado Livre), se a comissão foi estornada, o que houve
// com o frete, se a mercadoria voltou (CMV) e se há claim/mediação.
//
//   sugerir   --conta=<id> [--dias=60]                       (só banco, sem ML)
//   executar  --conta=<id> --pedidos=a,b --max-chamadas=<n> --confirm-host=<host> [--saida=arq.json]
//
// Por pedido (noRefresh, grant da PRÓPRIA conta): GET /orders/{id}; GET
// /v1/payments/{id} (Mercado Pago) de cada pagamento com valor devolvido;
// GET /post-purchase/v1/claims/search do pedido; GET /shipments/{id} (tipo
// logístico e devolução). Depois UM Billing em lote. Para no 1º 429 (inclusive
// embrulhado em 400), 401 ou 403. NUNCA grava no banco (sessão READ ONLY) e
// o relatório só tem campos financeiros (nada de comprador).
//
// Roda no Shell do serviço no Render (DATABASE_URL e grants de lá).

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MAX_PEDIDOS = 10;
const MAX_CHAMADAS = 60;
const BIGINT = ["id", "order_id", "pack_id", "payment_id", "shipping_id", "detail_id", "operation_id", "resource_id", "claim_id"];
const { classificarResposta, PARA_TUDO } = require("./central-vendas-rebate-validar");

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const cent = (v) => (num(v) === null ? null : Math.round(Number(v) * 100));
const somente = (o, chaves) => (o && typeof o === "object" ? Object.fromEntries(chaves.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) : null);

// Projeções SÓ com campos financeiros/estado (whitelist).
function projetarOrder(o) {
  return {
    status: o.status, status_detail: o.status_detail ?? null, tags: Array.isArray(o.tags) ? o.tags : [],
    total_amount: num(o.total_amount), paid_amount: num(o.paid_amount), pack_id: o.pack_id ? String(o.pack_id) : null,
    shipping_id: o.shipping?.id ? String(o.shipping.id) : null,
    itens: (o.order_items || []).map((i) => ({ mlb: i.item?.id ?? null, variacao: i.item?.variation_id ? String(i.item.variation_id) : null, quantidade: num(i.quantity),
      preco_unit: num(i.unit_price), preco_cheio_unit: num(i.full_unit_price), sale_fee_unit: num(i.sale_fee), listing_type: i.listing_type_id ?? null })),
    pagamentos: (o.payments || []).map((p) => ({ id: p.id != null ? String(p.id) : null, status: p.status, status_detail: p.status_detail ?? null,
      transaction_amount: num(p.transaction_amount), total_paid_amount: num(p.total_paid_amount), shipping_cost: num(p.shipping_cost),
      transaction_amount_refunded: num(p.transaction_amount_refunded), coupon_amount: num(p.coupon_amount), marketplace_fee: num(p.marketplace_fee) })),
  };
}
function projetarPayment(p) {
  return {
    status: p.status, status_detail: p.status_detail ?? null, transaction_amount: num(p.transaction_amount),
    transaction_amount_refunded: num(p.transaction_amount_refunded), net_received_amount: num(p.transaction_details?.net_received_amount),
    total_paid_amount: num(p.transaction_details?.total_paid_amount), coupon_amount: num(p.coupon_amount),
    refunds: (p.refunds || []).map((r) => ({ ...somente(r, ["id", "amount", "status", "date_created", "refund_mode", "reason", "adjustment_amount", "funding_type"]),
      source: r.source ? somente(r.source, ["id", "name", "type"]) : null, chaves: Object.keys(r || {}).sort() })),
    charges_details: (p.charges_details || []).map((c) => ({ name: c.name ?? null, type: c.type ?? null,
      from: c.accounts?.from ?? null, to: c.accounts?.to ?? null, original: num(c.amounts?.original), refunded: num(c.amounts?.refunded),
      refund_charges: Array.isArray(c.refund_charges) ? c.refund_charges.map((x) => somente(x, ["amount", "date_created", "client_id"])) : [] })),
  };
}
function projetarClaims(d) {
  const lista = Array.isArray(d?.data) ? d.data : Array.isArray(d?.results) ? d.results : [];
  return lista.map((c) => ({ id: c.id != null ? String(c.id) : null, type: c.type ?? null, stage: c.stage ?? null, status: c.status ?? null, reason_id: c.reason_id ?? null,
    resolucao: c.resolution ? somente(c.resolution, ["reason", "date_created", "benefited", "closed_by", "applied_coverage"]) : null,
    cobertura: c.coverages ?? c.coverage ?? null }));
}
function projetarShipment(s) {
  return { logistic_type: s.logistic_type ?? null, mode: s.mode ?? null, status: s.status ?? null, substatus: s.substatus ?? null,
    tags: Array.isArray(s.tags) ? s.tags : [], retorno: s.return_details ? true : false };
}
function projetarBilling(regs) {
  return (regs || []).map((r) => ({
    sale_fee: r.sale_fee ? somente(r.sale_fee, ["gross", "net", "rebate", "discount"]) : null,
    cobrancas: (r.details || r.charges || []).map((x) => ({ tipo: x.charge_info?.detail_type ?? x.type ?? null, subtipo: x.charge_info?.detail_sub_type ?? x.sub_type ?? null,
      valor: num(x.charge_info?.detail_amount ?? x.amount), transacao: x.charge_info?.transaction_detail ?? null })),
  }));
}

// O que a evidência permite afirmar (nada é inferido de ausência).
function concluir({ order, pagamentos, claims, shipment, billing, central }) {
  const devolvido = (order?.pagamentos || []).reduce((s, p) => (s === null || p.transaction_amount_refunded === null ? null : s + cent(p.transaction_amount_refunded)), 0);
  const refunds = pagamentos.flatMap((p) => p.refunds || []);
  const fontes = [...new Set(refunds.map((r) => r.source?.type || r.funding_type || null).filter(Boolean))];
  const comissaoPedido = (order?.itens || []).reduce((s, i) => (s === null || i.sale_fee_unit === null ? null : s + cent(i.sale_fee_unit) * (i.quantidade || 0)), 0);
  const net = billing.length ? cent(billing[0].sale_fee?.net) : null;
  return {
    devolvidoAoCompradorCentavos: devolvido,
    reembolsoGravadoNaCentralCentavos: central ? central.reembolsoCentavos : null,
    conferenciaReembolso: devolvido === null || !central ? "desconhecido" : (devolvido === central.reembolsoCentavos ? "igual" : "difere"),
    quemBancou: fontes.length ? fontes : ["nao_informado_pela_api"],
    claim: claims.length ? claims.map((c) => `${c.type || "?"}:${c.status || "?"}:${c.resolucao?.reason || "-"}`) : ["nenhum"],
    comissaoDoPedidoCentavos: comissaoPedido,
    comissaoBillingNetCentavos: net,
    comissaoEstornada: net === null || comissaoPedido === null ? "desconhecido" : (net < comissaoPedido ? "parcial_ou_total" : "nao"),
    logistica: shipment?.logistic_type || "desconhecido",
    mercadoriaVoltou: shipment ? (shipment.retorno || (shipment.tags || []).some((t) => /return/i.test(t)) ? "indicio_sim" : "sem_indicio") : "desconhecido",
  };
}

async function investigar({ conta, pedidoIds, maxChamadas, fetchMl, fetchMp, central = new Map() }) {
  const uso = { orders: 0, payments: 0, claims: 0, shipments: 0, billing: 0, total: 0 };
  let parada = null;
  const chamar = async (fn, path, tipo) => {
    if (parada) return { classe: "nao_chamado" };
    if (uso.total >= maxChamadas) { parada = "orcamento"; return { classe: "nao_chamado" }; }
    uso.total += 1; uso[tipo] += 1;
    let resp = null; let err = null;
    try { resp = await fn(path); } catch (e) { err = e; }
    const classe = classificarResposta(resp, err);
    if (PARA_TUDO.has(classe)) parada = classe;
    return { classe, resp };
  };
  const out = [];
  for (const id of pedidoIds) {
    const reg = { pedidoId: id, fontes: {} };
    const o = await chamar(fetchMl, `/orders/${id}`, "orders");
    reg.fontes.orders = o.classe;
    reg.order = o.classe === "ok" ? projetarOrder(o.resp.data) : null;
    reg.pagamentos = [];
    for (const p of (reg.order?.pagamentos || []).filter((x) => x.id && (x.transaction_amount_refunded || 0) > 0)) {
      const r = await chamar(fetchMp, `/v1/payments/${encodeURIComponent(p.id)}`, "payments");
      reg.fontes[`payment_${p.id}`] = r.classe;
      if (r.classe === "ok") reg.pagamentos.push({ id: p.id, ...projetarPayment(r.resp.data) });
    }
    const c = reg.order ? await chamar(fetchMl, `/post-purchase/v1/claims/search?resource=order&resource_id=${encodeURIComponent(id)}`, "claims") : { classe: "nao_chamado" };
    reg.fontes.claims = c.classe;
    reg.claims = c.classe === "ok" ? projetarClaims(c.resp.data) : [];
    const sid = reg.order?.shipping_id;
    const s = sid ? await chamar(fetchMl, `/shipments/${encodeURIComponent(sid)}`, "shipments") : { classe: "nao_chamado" };
    reg.fontes.shipment = s.classe;
    reg.shipment = s.classe === "ok" ? projetarShipment(s.resp.data) : null;
    out.push(reg);
  }
  const lidos = out.filter((r) => r.order).map((r) => r.pedidoId);
  const billing = new Map();
  if (lidos.length) {
    const b = await chamar(fetchMl, `/billing/integration/group/ML/order/details?order_ids=${lidos.join(",")}`, "billing");
    for (const r of out) r.fontes.billing = b.classe;
    if (b.classe === "ok") for (const x of Array.isArray(b.resp.data.results) ? b.resp.data.results : []) {
      const k = x && x.order_id != null ? String(x.order_id) : null;
      if (k) billing.set(k, [...(billing.get(k) || []), x]);
    }
  }
  for (const r of out) {
    r.billing = projetarBilling(billing.get(r.pedidoId));
    r.central = central.get(r.pedidoId) || null;
    r.conclusao = concluir({ order: r.order, pagamentos: r.pagamentos, claims: r.claims, shipment: r.shipment, billing: r.billing, central: r.central });
  }
  return { conta: { clienteContaId: conta.clienteContaId }, chamadas: { ...uso, maximo: maxChamadas }, parada, pedidos: out };
}

// Composição gravada na Central (import publicado mais recente da conta).
async function composicaoDaCentral(db, contaId, pedidoIds) {
  const repo = require("../services/centralVendas/centralVendasRepository");
  const r = await db.query(
    `SELECT DISTINCT ON (p.pedido_id) p.pedido_id, p.id, p.status, p.resultado::text AS resultado
       FROM central_vendas_pedidos p JOIN central_vendas_imports i ON i.id = p.import_id
      WHERE i.cliente_conta_id = $1 AND i.publication_status = 'published' AND p.pedido_id = ANY($2::text[])
      ORDER BY p.pedido_id, i.published_at DESC NULLS LAST, i.id DESC`, [contaId, pedidoIds]);
  const mapa = new Map();
  if (!r.rows.length) return mapa;
  const comps = await repo.carregarComponentesDosPedidos({ pedidoRowIds: r.rows.map((x) => String(x.id)), colunas: ["pedido_row_id", "tipo", "valor"] }, db);
  for (const x of r.rows) {
    const doPedido = comps.filter((c) => String(c.pedido_row_id) === String(x.id));
    const porTipo = {};
    for (const c of doPedido) porTipo[c.tipo] = (porTipo[c.tipo] || 0) + (cent(c.valor) || 0);
    mapa.set(String(x.pedido_id), { status: x.status, resultadoCentavos: cent(x.resultado), componentesCentavos: porTipo, reembolsoCentavos: porTipo.cancelamento_reembolso != null ? Math.abs(porTipo.cancelamento_reembolso) : null });
  }
  return mapa;
}

async function sugerir(db, contaId, dias) {
  const r = await db.query(
    `SELECT DISTINCT ON (p.pedido_id) p.pedido_id, p.data_pedido::text AS data, p.faturamento::text AS faturamento, p.resultado::text AS resultado
       FROM central_vendas_pedidos p JOIN central_vendas_imports i ON i.id = p.import_id
      WHERE i.cliente_conta_id = $1 AND i.publication_status = 'published' AND p.status = 'partially_refunded'
        AND p.data_pedido >= (CURRENT_DATE - $2::int)
      ORDER BY p.pedido_id, i.published_at DESC NULLS LAST, i.id DESC`, [contaId, dias]);
  return r.rows.slice(0, 20);
}

function lerArgs(argv) {
  const a = { _: [] };
  for (const x of argv) { const m = /^--([a-z-]+)(?:=(.*))?$/.exec(x); if (m) a[m[1]] = m[2] === undefined ? true : m[2]; else a._.push(x); }
  return a;
}

async function main(argv) {
  const args = lerArgs(argv);
  const cmd = args._[0];
  if (!["sugerir", "executar"].includes(cmd) || !/^\d{1,9}$/.test(String(args.conta || ""))) {
    console.error("uso: central-vendas-reembolso-parcial-investigar.js sugerir|executar --conta=<id> [--pedidos=a,b --max-chamadas=n --confirm-host=<host>]");
    return 2;
  }
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL ausente (rode no Shell do serviço no Render)."); return 2; }
  const host = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch (_) { return null; } })();
  console.error(`banco: host=${host}`);
  const pool = require("../config/database");
  const client = await pool.connect();
  try {
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    const contaId = Number(args.conta);
    if (cmd === "sugerir") { console.log(JSON.stringify({ conta: contaId, partially_refunded: await sugerir(client, contaId, Number(args.dias) || 60) }, null, 2)); return 0; }
    const ids = String(args.pedidos || "").split(",").map((x) => x.trim()).filter(Boolean);
    if (!ids.length || ids.length > MAX_PEDIDOS || ids.some((x) => !/^\d{1,30}$/.test(x))) { console.error(`--pedidos: 1 a ${MAX_PEDIDOS} ids`); return 2; }
    const max = Number(args["max-chamadas"]);
    if (!Number.isInteger(max) || max < 1 || max > MAX_CHAMADAS) { console.error(`--max-chamadas obrigatório, 1..${MAX_CHAMADAS}`); return 2; }
    if (!LOCAL_HOSTS.has(host) && args["confirm-host"] !== host) { console.error("--confirm-host precisa ser igual ao host do banco impresso acima"); return 2; }
    const { rows: [c] } = await client.query("SELECT id, cliente_id, marketplace, external_account_id FROM cliente_contas WHERE id = $1", [contaId]);
    if (!c || c.marketplace !== "meli" || !c.external_account_id) { console.error("conta inexistente, não é Mercado Livre ou sem seller"); return 2; }
    const conta = { clienteContaId: Number(c.id), clienteId: Number(c.cliente_id), sellerId: String(c.external_account_id) };
    const central = await composicaoDaCentral(client, contaId, ids);
    const { mlFetch } = require("../utils/mlClient");
    const { mpFetch } = require("../utils/mercadoPagoClient");
    const opts = { mlUserId: conta.sellerId, noRefresh: true };
    const rel = await investigar({ conta, pedidoIds: ids, maxChamadas: max, central,
      fetchMl: (p) => mlFetch(conta.clienteId, p, { ...opts, bigIntFields: BIGINT }),
      fetchMp: (p) => mpFetch(conta.clienteId, p, opts) });
    const texto = JSON.stringify(rel, null, 2);
    if (args.saida && args.saida !== true) require("fs").writeFileSync(String(args.saida), texto);
    console.log(texto);
    return rel.parada && rel.parada !== "orcamento" ? 3 : 0;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err?.message || err); process.exit(1); });
}

module.exports = { investigar, concluir, projetarOrder, projetarPayment, projetarClaims, projetarShipment, projetarBilling, composicaoDaCentral, sugerir, main };
