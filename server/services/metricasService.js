// server/services/metricasService.js
// Camada de dados para a tela Métricas — Mercado Livre.
// Nunca expõe access_token, refresh_token, dados pessoais do comprador.
const pool = require('../config/database');
const { mlFetch } = require('../utils/mlClient');

// Cancelamentos que aproximam o card do painel ML.
// Excluídos: shipment_not_delivered, pack_splitted (logísticos/internos).
const CANCEL_COMERCIAL = new Set(['buyer_cancel_express', 'mediations']);
const CANCEL_EXCLUIDOS = ['shipment_not_delivered', 'pack_splitted'];

const MAX_PAGINAS = 100; // 100 * 50 = 5.000 pedidos — teto de segurança para Render

// ---------------------------------------------------------------------------
// Banco
// ---------------------------------------------------------------------------

async function listarClientesComML() {
  const { rows } = await pool.query(`
    SELECT c.id, c.slug, c.nome, t.ml_user_id
    FROM clientes c
    INNER JOIN ml_tokens t ON t.cliente_id = c.id
    WHERE c.ativo = true
    ORDER BY c.nome ASC
  `);
  return rows.map(r => ({ id: r.id, slug: r.slug, nome: r.nome, ml_user_id: r.ml_user_id }));
}

async function buscarClienteComToken(slug) {
  const { rows } = await pool.query(
    `SELECT c.id, c.slug, c.nome, t.ml_user_id
     FROM clientes c
     INNER JOIN ml_tokens t ON t.cliente_id = c.id
     WHERE c.slug = $1 AND c.ativo = true
     LIMIT 1`,
    [slug]
  );
  return rows[0] || null;
}

async function clienteExisteAtivo(slug) {
  const { rows } = await pool.query(
    'SELECT id FROM clientes WHERE slug = $1 AND ativo = true LIMIT 1',
    [slug]
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toISOFrom(date) { return `${date}T00:00:00.000-03:00`; }
function toISOTo(date)   { return `${date}T23:59:59.999-03:00`; }
function datePart(iso)   { return String(iso || '').slice(0, 10); }
function n(v)            { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function r2(v)           { return Math.round(v * 100) / 100; }
function pct(atual, ant) {
  if (ant === 0) return atual > 0 ? 100 : 0;
  return r2(((atual - ant) / ant) * 100);
}

// ---------------------------------------------------------------------------
// API Mercado Livre — paginação
// ---------------------------------------------------------------------------

async function fetchAllOrders(clienteId, sellerId, dateFrom, dateTo, status) {
  const LIMIT = 50;
  let offset = 0;
  const all = [];

  for (let page = 0; page < MAX_PAGINAS; page++) {
    const qs = new URLSearchParams({
      seller: String(sellerId),
      'order.date_created.from': toISOFrom(dateFrom),
      'order.date_created.to':   toISOTo(dateTo),
      limit:  String(LIMIT),
      offset: String(offset),
    });
    if (status) qs.set('order.status', status);

    const { ok, status: httpStatus, data } = await mlFetch(clienteId, `/orders/search?${qs}`);

    if (!ok) {
      const err = new Error(data?.message || 'Erro na Orders API do Mercado Livre');
      err.mlStatus = httpStatus;
      throw err;
    }

    const results = Array.isArray(data?.results) ? data.results : [];
    all.push(...results);

    if (!results.length) break;
    offset += LIMIT;
    if (offset >= (data?.paging?.total || 0)) break;
  }

  return all;
}

// ---------------------------------------------------------------------------
// Agregações
// ---------------------------------------------------------------------------

function agregarResumo(vendas, cancelados) {
  let vendasBrutas = 0, quantidadeVendas = 0, unidadesVendidas = 0;
  let comissaoEstimada = 0, valorTabela = 0;

  for (const order of vendas) {
    vendasBrutas += n(order.total_amount);
    quantidadeVendas += 1;
    for (const oi of (order.order_items || [])) {
      const qty = n(oi.quantity);
      unidadesVendidas += qty;
      comissaoEstimada += n(oi.sale_fee) * qty;
      if (oi.gross_price != null) valorTabela += n(oi.gross_price) * qty;
    }
  }

  const precoMedioUnidade = unidadesVendidas > 0 ? r2(vendasBrutas / unidadesVendidas) : 0;
  const ticketMedio       = quantidadeVendas  > 0 ? r2(vendasBrutas / quantidadeVendas) : 0;
  const descontoEstimado  = valorTabela > 0 ? r2(valorTabela - vendasBrutas) : 0;

  let quantidadeCanceladasApi = cancelados.length;
  let valorCanceladoApi = 0;
  let quantidadeCanceladasAjustada = 0;
  let valorCanceladoAjustado = 0;

  for (const order of cancelados) {
    valorCanceladoApi += n(order.total_amount);
    if (CANCEL_COMERCIAL.has(order.cancel_detail?.code)) {
      quantidadeCanceladasAjustada += 1;
      valorCanceladoAjustado += n(order.total_amount);
    }
  }

  return {
    vendasBrutas: r2(vendasBrutas),
    quantidadeVendas,
    unidadesVendidas,
    precoMedioUnidade,
    ticketMedio,
    comissaoEstimada: r2(comissaoEstimada),
    valorTabela: r2(valorTabela),
    descontoEstimado,
    quantidadeCanceladasApi,
    valorCanceladoApi: r2(valorCanceladoApi),
    quantidadeCanceladasAjustada,
    valorCanceladoAjustado: r2(valorCanceladoAjustado),
  };
}

function agregarPorDia(vendas, cancelados) {
  const map = {};

  const dia = (data) => {
    if (!map[data]) {
      map[data] = { data, vendasBrutas: 0, quantidadeVendas: 0, unidadesVendidas: 0, ticketMedio: 0, quantidadeCanceladas: 0, valorCancelado: 0 };
    }
    return map[data];
  };

  for (const order of vendas) {
    const d = dia(datePart(order.date_created));
    d.vendasBrutas += n(order.total_amount);
    d.quantidadeVendas += 1;
    for (const oi of (order.order_items || [])) d.unidadesVendidas += n(oi.quantity);
  }

  for (const order of cancelados) {
    if (!CANCEL_COMERCIAL.has(order.cancel_detail?.code)) continue;
    const d = dia(datePart(order.date_created));
    d.quantidadeCanceladas += 1;
    d.valorCancelado += n(order.total_amount);
  }

  return Object.values(map)
    .sort((a, b) => a.data.localeCompare(b.data))
    .map(d => ({
      ...d,
      vendasBrutas: r2(d.vendasBrutas),
      ticketMedio:  d.quantidadeVendas > 0 ? r2(d.vendasBrutas / d.quantidadeVendas) : 0,
      valorCancelado: r2(d.valorCancelado),
    }));
}

function agregarTopProdutos(vendas) {
  const map = {};

  for (const order of vendas) {
    for (const oi of (order.order_items || [])) {
      const itemId = oi.item?.id || 'desconhecido';
      if (!map[itemId]) {
        map[itemId] = {
          itemId,
          titulo: oi.item?.title || '',
          sku: oi.item?.seller_sku || '',
          unidades: 0,
          faturamento: 0,
          comissaoEstimada: 0,
        };
      }
      const qty = n(oi.quantity);
      map[itemId].unidades += qty;
      map[itemId].faturamento += n(oi.unit_price) * qty;
      map[itemId].comissaoEstimada += n(oi.sale_fee) * qty;
    }
  }

  return Object.values(map)
    .map(p => ({
      ...p,
      faturamento:       r2(p.faturamento),
      comissaoEstimada:  r2(p.comissaoEstimada),
      ticketMedio:       p.unidades > 0 ? r2(p.faturamento / p.unidades) : 0,
    }))
    .sort((a, b) => b.faturamento - a.faturamento)
    .slice(0, 50);
}

function periodoAnterior(dateFrom, dateTo) {
  const from = new Date(dateFrom + 'T12:00:00Z');
  const to   = new Date(dateTo   + 'T12:00:00Z');
  const dias = Math.round((to - from) / 86400000) + 1;
  const prevTo   = new Date(from.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - (dias - 1) * 86400000);
  return {
    dateFrom: prevFrom.toISOString().slice(0, 10),
    dateTo:   prevTo.toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Exports públicos
// ---------------------------------------------------------------------------

async function buscarResumo({ clienteSlug, dateFrom, dateTo, compare }) {
  const cliente = await buscarClienteComToken(clienteSlug);

  if (!cliente) {
    const existe = await clienteExisteAtivo(clienteSlug);
    return existe ? { semToken: true } : { notFound: true };
  }

  if (!cliente.ml_user_id) return { semToken: true };

  let vendas, cancelados;
  try {
    [vendas, cancelados] = await Promise.all([
      fetchAllOrders(cliente.id, cliente.ml_user_id, dateFrom, dateTo, null),
      fetchAllOrders(cliente.id, cliente.ml_user_id, dateFrom, dateTo, 'cancelled'),
    ]);
  } catch (err) {
    if (err.mlStatus === 401 || err.mlStatus === 403) return { tokenInvalido: true };
    console.error('[metricasService] fetchAllOrders:', err.message);
    return { erroApi: true };
  }

  const resumo      = agregarResumo(vendas, cancelados);
  const porDia      = agregarPorDia(vendas, cancelados);
  const topProdutos = agregarTopProdutos(vendas);

  const payload = {
    cliente: { id: cliente.id, slug: cliente.slug, nome: cliente.nome, ml_user_id: cliente.ml_user_id },
    periodo: { dateFrom, dateTo },
    resumo,
    porDia,
    topProdutos,
    debug: {
      regraCancelamento: 'buyer_cancel_express + mediations',
      cancelamentosExcluidos: CANCEL_EXCLUIDOS,
    },
  };

  if (compare === 'previous_period') {
    const ant = periodoAnterior(dateFrom, dateTo);
    let vendasAnt = [], canceladosAnt = [];
    try {
      [vendasAnt, canceladosAnt] = await Promise.all([
        fetchAllOrders(cliente.id, cliente.ml_user_id, ant.dateFrom, ant.dateTo, null),
        fetchAllOrders(cliente.id, cliente.ml_user_id, ant.dateFrom, ant.dateTo, 'cancelled'),
      ]);
    } catch (_) {
      // período anterior indisponível — devolve comparativo zerado
    }
    const resumoAnt = agregarResumo(vendasAnt, canceladosAnt);
    payload.comparativo = {
      vendasBrutasPct:       pct(resumo.vendasBrutas,            resumoAnt.vendasBrutas),
      quantidadeVendasPct:   pct(resumo.quantidadeVendas,        resumoAnt.quantidadeVendas),
      unidadesVendidasPct:   pct(resumo.unidadesVendidas,        resumoAnt.unidadesVendidas),
      ticketMedioPct:        pct(resumo.ticketMedio,             resumoAnt.ticketMedio),
      valorCanceladoPct:     pct(resumo.valorCanceladoAjustado,  resumoAnt.valorCanceladoAjustado),
    };
  }

  return payload;
}

module.exports = { listarClientesComML, buscarResumo };
