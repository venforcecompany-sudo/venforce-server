#!/usr/bin/env node
// server/scripts/central-vendas-rebate-validar.js
//
// VALIDAÇÃO REAL e CONTROLADA da composição promocional / rebate da Central de
// Vendas em POUCOS pedidos de UMA conta. Roda no shell do serviço no Render
// (DATABASE_URL e grants já existem lá; nada vem do server/.env). NUNCA grava no
// banco: só lê a Central e chama o ML com teto de chamadas.
//
//   node scripts/central-vendas-rebate-validar.js sugerir   --conta=<id> [--dias=30]
//        SOMENTE LEITURA, zero chamada ao ML: sugere pedidos representativos da conta
//        (item único, quantidade > 1, multi-item, Full) a partir da Central.
//
//   node scripts/central-vendas-rebate-validar.js planejar  --conta=<id> --pedidos=<id,id,…>
//        SOMENTE LEITURA, zero chamada ao ML: mostra a conta, a tarifa gravada na Central
//        de cada pedido e o máximo de chamadas que `executar` faria.
//
//   node scripts/central-vendas-rebate-validar.js executar  --conta=<id> --pedidos=<id,id,…>
//        --max-chamadas=<n> --confirm-host=<host> [--saida=<arquivo.json>]
//        Chamadas ao ML (noRefresh, grant da PRÓPRIA conta): GET /orders/{id} por pedido,
//        1 lote de Billing (/billing/integration/group/ML/order/details, ≤ 60) e
//        /orders/{id}/discounts só onde há desconto. Para no primeiro 429 (inclusive
//        embrulhado em 400), 401 ou 403. Compõe cada pedido com a MESMA função do motor
//        (centralVendasComposicaoPromocional → conciliador do Sentinel) e confere:
//          · rebate nunca contado duas vezes (crédito > 0 só com tarifa bruta comprovada);
//          · tarifa gravada na Central × sale_fee × q do pedido atual;
//          · divergências Orders × Discounts × Billing.
//
// Limites: até 20 pedidos; --max-chamadas obrigatório, 1..40. Não imprime tokens nem
// dados de comprador (o relatório leva só ids de pedido/item e valores).

const { comporPedido } = require("../services/centralVendas/centralVendasComposicaoPromocional");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const MAX_PEDIDOS = 20;
const MAX_CHAMADAS = 40;
const LOTE_BILLING = 60;
const BIGINT_CAMPOS = ["order_id", "operation_id", "payment_id", "detail_id", "document_id", "pack_id", "shipping_id", "charge_bonified_id", "id"];

const cent = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));

function corpoIndicaLimite(data) {
  if (!data || typeof data !== "object") return false;
  if (Number(data.status) === 429 || Number(data.status_code) === 429) return true;
  const t = [data.message, data.error, data.code].filter((v) => typeof v === "string").join(" ");
  return /\b429\b|too[_ ]many[_ ]requests|rate[_ ]?limit/i.test(t);
}
function classificar(resp, err) {
  if (err) return err.name === "MlTimeoutError" ? "timeout" : "erro";
  const s = Number(resp?.status);
  if (s === 200) return resp.data && typeof resp.data === "object" ? "ok" : "erro";
  if (s === 429 || (s !== 401 && corpoIndicaLimite(resp?.data))) return "limite";
  if (s === 401) return "token";
  if (s === 403) return "proibido";
  if (s === 404) return "nao_encontrado";
  if (s === 206) return "parcial";
  return "erro";
}
const PARA_TUDO = new Set(["limite", "token", "proibido"]);

function temDesconto(order) {
  return (Array.isArray(order?.order_items) ? order.order_items : []).some((oi) => {
    const g = cent(oi?.gross_price);
    const u = cent(oi?.unit_price);
    const q = Number(oi?.quantity) || 0;
    return g !== null && u !== null && g > u * q;
  });
}

function planejarChamadas(pedidoIds) {
  const n = pedidoIds.length;
  return { orders: n, billing: Math.ceil(n / LOTE_BILLING), discountsNoMaximo: n, totalNoMaximo: n + Math.ceil(n / LOTE_BILLING) + n };
}

// Confere um pedido composto. tarifaCentralCentavos: o que a Central gravou (valor absoluto) ou null.
function conferir(comp, tarifaCentralCentavos) {
  const problemas = [];
  const c = comp.creditoAdicionalComprovado.centavos;
  if (c !== null && c > 0 && comp.comissao.naturezaNoMotor !== "bruta_comprovada") problemas.push("credito_sem_tarifa_bruta_comprovada");
  if (comp.rebate.incorporadoNaComissao === "comprovado" && c !== 0) problemas.push("rebate_incorporado_com_credito");
  if (c !== null && comp.limiteSuperiorNaoComprovado !== null) problemas.push("credito_somado_ao_limite");
  if (comp.efeitoNoResultadoOficial !== "nenhum") problemas.push("efeito_no_resultado_oficial");
  const doPedido = comp.comissao.doPedido.centavos;
  const tarifa = tarifaCentralCentavos === null || tarifaCentralCentavos === undefined ? "sem_registro_na_central"
    : doPedido === null ? "pedido_sem_sale_fee" : Math.abs(tarifaCentralCentavos) === doPedido ? "igual" : "difere";
  return { invariantesOk: problemas.length === 0, problemas, tarifaCentralXPedido: tarifa };
}

/**
 * Núcleo da validação (puro quanto ao I/O: recebe fetchMl). fetchMl(path) → { status, data }.
 *   conta: { clienteContaId, sellerId }
 *   tarifasCentral: Map(pedidoId → centavos gravados na Central)
 */
async function validar({ conta, pedidoIds, maxChamadas, fetchMl, tarifasCentral = new Map() }) {
  const uso = { orders: 0, billing: 0, discounts: 0, total: 0 };
  let parada = null;
  const chamar = async (path, tipo) => {
    if (parada) return { classe: "nao_chamado" };
    if (uso.total >= maxChamadas) { parada = "orcamento"; return { classe: "nao_chamado" }; }
    uso.total += 1;
    uso[tipo] += 1;
    let resp = null;
    let err = null;
    try { resp = await fetchMl(path); } catch (e) { err = e; }
    const classe = classificar(resp, err);
    if (PARA_TUDO.has(classe)) parada = classe;
    return { classe, resp };
  };

  const orders = new Map();
  const falhas = {};
  for (const id of pedidoIds) {
    const r = await chamar(`/orders/${id}`, "orders");
    if (r.classe === "ok") orders.set(id, r.resp.data);
    else falhas[id] = `orders_${r.classe}`;
  }
  const ids = [...orders.keys()];
  const billingPorPedido = new Map();
  let billingLido = false;
  for (let i = 0; i < ids.length && !parada; i += LOTE_BILLING) {
    const lote = ids.slice(i, i + LOTE_BILLING);
    const r = await chamar(`/billing/integration/group/ML/order/details?order_ids=${lote.join(",")}`, "billing");
    if (r.classe !== "ok") { for (const id of lote) falhas[id] = falhas[id] || `billing_${r.classe}`; continue; }
    billingLido = true;
    const erros = Array.isArray(r.resp.data.errors) ? r.resp.data.errors : [];
    for (const reg of Array.isArray(r.resp.data.results) ? r.resp.data.results : []) {
      const k = reg && reg.order_id != null ? String(reg.order_id) : null;
      if (!k) continue;
      if (!billingPorPedido.has(k)) billingPorPedido.set(k, { results: [], errors: erros });
      billingPorPedido.get(k).results.push(reg);
    }
  }
  const descontos = new Map();
  for (const id of ids) {
    if (parada) break;
    if (!temDesconto(orders.get(id)) || !billingPorPedido.has(id)) continue;
    const r = await chamar(`/orders/${id}/discounts`, "discounts");
    if (r.classe === "ok") descontos.set(id, r.resp.data);
    else if (r.classe === "nao_encontrado") descontos.set(id, { indisponivel_http: 404 });
  }

  const pedidos = [];
  for (const id of pedidoIds) {
    const order = orders.get(id);
    if (!order) { pedidos.push({ pedidoId: id, consultado: false, motivo: falhas[id] || parada || "nao_consultado" }); continue; }
    const comp = comporPedido({
      pedido: order,
      conta: { clienteContaId: conta.clienteContaId, sellerId: conta.sellerId },
      descontos: descontos.get(id) ?? null,
      billing: billingPorPedido.get(id) ?? (billingLido ? { results: [], errors: [] } : null),
      origemBilling: billingPorPedido.has(id) ? { contaId: conta.clienteContaId } : null,
    });
    const conf = conferir(comp, tarifasCentral.has(id) ? tarifasCentral.get(id) : null);
    pedidos.push({
      pedidoId: id, consultado: true,
      itens: comp.itens.length, quantidades: comp.itens.map((i) => i.quantidade),
      temDesconto: temDesconto(order), fontes: comp.fontes,
      estado: comp.estado, natureza: comp.comissao.naturezaNoMotor,
      precoCheio: comp.totais.precoCheio.centavos, precoEfetivo: comp.totais.precoEfetivo.centavos,
      desconto: comp.totais.descontoTotal, vendedor: comp.totais.vendedorBancou, marketplace: comp.totais.marketplaceBancou,
      comissaoPedido: comp.comissao.doPedido.centavos, comissaoBruta: comp.comissao.bruta.centavos, comissaoLiquida: comp.comissao.liquida.centavos,
      rebate: comp.rebate.identificado, rebateIncorporado: comp.rebate.incorporadoNaComissao,
      credito: comp.creditoAdicionalComprovado, divergencias: comp.divergencias.map((d) => `${d.codigo} (${d.entre})`),
      pendencias: comp.pendencias, ...conf,
    });
  }
  const consultados = pedidos.filter((p) => p.consultado);
  const porEstado = {};
  for (const p of consultados) porEstado[p.estado] = (porEstado[p.estado] || 0) + 1;
  return {
    conta: { clienteContaId: conta.clienteContaId },
    chamadas: { ...uso, maximo: maxChamadas },
    parada,
    pedidos,
    resumo: {
      pedidos: pedidoIds.length, consultados: consultados.length, porEstado,
      invariantesOk: consultados.every((p) => p.invariantesOk),
      tarifaCentralDifere: consultados.filter((p) => p.tarifaCentralXPedido === "difere").map((p) => p.pedidoId),
      rebateIdentificadoCentavos: consultados.reduce((s, p) => s + (p.rebate.centavos || 0), 0),
      rebateIncorporadoComprovadoCentavos: consultados.filter((p) => p.rebateIncorporado === "comprovado").reduce((s, p) => s + (p.rebate.centavos || 0), 0),
      creditoComprovadoCentavos: consultados.reduce((s, p) => s + (p.credito.centavos || 0), 0),
      divergentes: consultados.filter((p) => p.divergencias.length).map((p) => p.pedidoId),
    },
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────────────────────
function lerArgs(argv) {
  const a = { _: [] };
  for (const x of argv) { const m = /^--([a-z-]+)(?:=(.*))?$/.exec(x); if (m) a[m[1]] = m[2] === undefined ? true : m[2]; else a._.push(x); }
  return a;
}
function lerPedidos(v) {
  const ids = String(v || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!ids.length || ids.length > MAX_PEDIDOS || ids.some((x) => !/^\d{1,30}$/.test(x))) return null;
  return [...new Set(ids)];
}

async function contaDoBanco(db, contaId) {
  const r = await db.query(
    `SELECT id, cliente_id, marketplace, external_account_id FROM cliente_contas WHERE id = $1`, [contaId]);
  const c = r.rows[0];
  if (!c || c.marketplace !== "meli" || !c.external_account_id) return null;
  return { clienteContaId: Number(c.id), clienteId: Number(c.cliente_id), sellerId: String(c.external_account_id) };
}

// Tarifa gravada na Central (Σ tarifa_venda, valor absoluto) do pedido no import publicado mais recente da conta.
async function tarifasDaCentral(db, contaId, pedidoIds) {
  const repo = require("../services/centralVendas/centralVendasRepository");
  const r = await db.query(
    `SELECT DISTINCT ON (p.pedido_id) p.pedido_id, p.id
       FROM central_vendas_pedidos p JOIN central_vendas_imports i ON i.id = p.import_id
      WHERE i.cliente_conta_id = $1 AND i.publication_status = 'published' AND p.pedido_id = ANY($2::text[])
      ORDER BY p.pedido_id, i.published_at DESC NULLS LAST, i.id DESC`, [contaId, pedidoIds]);
  const rowPorPedido = new Map(r.rows.map((x) => [String(x.pedido_id), String(x.id)]));
  const mapa = new Map();
  if (!rowPorPedido.size) return mapa;
  const comps = await repo.carregarComponentesDosPedidos({ pedidoRowIds: [...rowPorPedido.values()], tipos: ["tarifa_venda"], colunas: ["pedido_row_id", "tipo", "valor"] }, db);
  const pedidoDoRow = new Map([...rowPorPedido].map(([p, row]) => [row, p]));
  for (const c of comps) {
    const p = pedidoDoRow.get(String(c.pedido_row_id));
    const v = cent(c.valor);
    if (!p || v === null) continue;
    mapa.set(p, (mapa.get(p) || 0) + Math.abs(v));
  }
  return mapa;
}

async function sugerir(db, contaId, dias) {
  const r = await db.query(
    `WITH ped AS (
       SELECT DISTINCT ON (p.pedido_id) p.pedido_id, p.id, p.data_pedido, p.status, p.payload_json->>'logistica' AS logistica
         FROM central_vendas_pedidos p JOIN central_vendas_imports i ON i.id = p.import_id
        WHERE i.cliente_conta_id = $1 AND i.publication_status = 'published' AND p.data_pedido >= (CURRENT_DATE - $2::int)
        ORDER BY p.pedido_id, i.published_at DESC NULLS LAST, i.id DESC)
     SELECT ped.pedido_id, ped.status, ped.logistica, COUNT(it.id)::int AS itens, COALESCE(MAX(it.quantidade), 0)::numeric AS qmax
       FROM ped LEFT JOIN central_vendas_pedido_itens it ON it.pedido_row_id = ped.id
      GROUP BY ped.pedido_id, ped.status, ped.logistica, ped.data_pedido
      ORDER BY ped.data_pedido DESC LIMIT 2000`, [contaId, dias]);
  const grupos = { item_unico_q1: [], quantidade_maior_que_1: [], multi_item: [], full: [], cancelado: [] };
  for (const x of r.rows) {
    const g = x.status === "cancelled" ? "cancelado" : x.itens > 1 ? "multi_item" : Number(x.qmax) > 1 ? "quantidade_maior_que_1" : x.logistica === "full" ? "full" : "item_unico_q1";
    if (grupos[g].length < (g === "item_unico_q1" ? 6 : 3)) grupos[g].push(String(x.pedido_id));
  }
  return grupos;
}

async function main(argv) {
  const args = lerArgs(argv);
  const cmd = args._[0];
  const uso = "uso: central-vendas-rebate-validar.js sugerir|planejar|executar --conta=<id> [--pedidos=a,b] [--max-chamadas=n --confirm-host=<host>]";
  if (!["sugerir", "planejar", "executar"].includes(cmd) || !/^\d{1,9}$/.test(String(args.conta || ""))) { console.error(uso); return 2; }
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL ausente (rode no shell do serviço; nunca com o server/.env local)."); return 2; }
  const host = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch (_) { return null; } })();
  console.error(`banco: host=${host}`);
  const pool = require("../config/database");
  try {
    const contaId = Number(args.conta);
    if (cmd === "sugerir") {
      console.log(JSON.stringify({ conta: contaId, sugestao: await sugerir(pool, contaId, Number(args.dias) || 30) }, null, 2));
      return 0;
    }
    const pedidoIds = lerPedidos(args.pedidos);
    if (!pedidoIds) { console.error(`--pedidos: 1 a ${MAX_PEDIDOS} ids numéricos separados por vírgula`); return 2; }
    const conta = await contaDoBanco(pool, contaId);
    if (!conta) { console.error("conta inexistente, não é Mercado Livre ou sem seller"); return 2; }
    const tarifas = await tarifasDaCentral(pool, contaId, pedidoIds);
    if (cmd === "planejar") {
      console.log(JSON.stringify({ conta: { clienteContaId: conta.clienteContaId }, pedidos: pedidoIds,
        tarifaGravadaNaCentral: Object.fromEntries(pedidoIds.map((p) => [p, tarifas.has(p) ? tarifas.get(p) : null])),
        chamadasNoMaximo: planejarChamadas(pedidoIds) }, null, 2));
      return 0;
    }
    const max = Number(args["max-chamadas"]);
    if (!Number.isInteger(max) || max < 1 || max > MAX_CHAMADAS) { console.error(`--max-chamadas obrigatório, 1..${MAX_CHAMADAS}`); return 2; }
    if (!LOCAL_HOSTS.has(host) && args["confirm-host"] !== host) { console.error("--confirm-host precisa ser igual ao host do banco impresso acima"); return 2; }
    const { mlFetch } = require("../utils/mlClient");
    const fetchMl = (path) => mlFetch(conta.clienteId, path, { mlUserId: conta.sellerId, noRefresh: true, bigIntFields: BIGINT_CAMPOS });
    const rel = await validar({ conta, pedidoIds, maxChamadas: max, fetchMl, tarifasCentral: tarifas });
    const texto = JSON.stringify(rel, null, 2);
    if (args.saida && args.saida !== true) require("fs").writeFileSync(String(args.saida), texto);
    console.log(texto);
    return rel.resumo.invariantesOk ? 0 : 3;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err?.message || err); process.exit(1); });
}

module.exports = { validar, conferir, planejarChamadas, temDesconto, classificar, lerPedidos, main, contaDoBanco, tarifasDaCentral, sugerir };
