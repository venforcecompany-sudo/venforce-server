/* ================================================================
   fechamentos-api.js — VenForce · Central de Vendas
   ----------------------------------------------------------------
   FERRAMENTA OPERACIONAL de conciliação por PEDIDO.
   Regra central: o PEDIDO é a fonte da verdade; o PRODUTO é agregação
   dos pedidos; dia/semana/mês são FILTROS sobre os pedidos.

   Honestidade do dado:
     null/undefined = AUSENTE (mostra "—")   ·   0 = zero REAL
     status: real | estimado | ausente | parcial | bloqueado
     resultado NUNCA é exibido como confiável se faltar dado.
   ================================================================ */

const STORAGE_KEY = "vf-token";
const API_BASE    = "https://venforce-server.onrender.com";

function getToken() {
  const t = localStorage.getItem(STORAGE_KEY);
  if (!t) { window.location.replace("index.html"); return null; }
  return t;
}
const TOKEN = getToken();

if (typeof window.initLayout === "function") window.initLayout();

/* ── HELPERS DE FORMATO ───────────────────────────────────── */
const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const num   = (n, d = 0) => (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = n => 'R$ ' + num(n, 2);
const pct   = n => num(n, 1) + '%';
const round2 = v => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const fmtDt = s => { if (s == null || s === '') return '—'; const d = new Date(s + (String(s).length === 10 ? 'T00:00:00' : '')); return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR'); };
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shortMoney = n => {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1000000) return 'R$ ' + num(v / 1000000, 1) + ' mi';
  if (abs >= 1000) return 'R$ ' + num(v / 1000, 1) + 'k';
  return 'R$ ' + num(v, 0);
};
/* '—' para ausente; valor para 0 real. */
const valOr = (v, f = num) => (v === null || v === undefined) ? '—' : f(v);

/* ── STATUS / CONFIANÇA / CHIPS ───────────────────────────── */
const STATUS_LBL = { real:'Real', estimado:'Estimado', ausente:'Ausente', parcial:'Parcial', bloqueado:'Bloqueado' };
const STATUS_CLS = { real:'ok', estimado:'info', ausente:'crit', parcial:'warn', bloqueado:'muted' };
function statusBadge(s) { return `<span class="fapi-badge fapi-badge--${STATUS_CLS[s] || 'muted'}">${esc(STATUS_LBL[s] || s || '—')}</span>`; }
const CONF = { confiavel:['ok','Confiável'], parcial:['warn','Parcial'], insuficiente:['crit','Insuficiente'], bloqueado:['crit','Bloqueado'] };
function confidenceClass(c) { return (CONF[c] || CONF.bloqueado)[0]; }
function confidenceLabel(c) { return (CONF[c] || CONF.bloqueado)[1]; }
function confPill(c) { return `<span class="fapi-conf-pill fapi-conf-pill--${confidenceClass(c)}">${esc(confidenceLabel(c))}</span>`; }

/* chips discretos de logística / ads / diagnóstico */
function tagFull(full) {
  if (full === true)  return `<span class="fapi-tag fapi-tag--full">Full</span>`;
  if (full === false) return `<span class="fapi-tag fapi-tag--muted">Normal</span>`;
  return `<span class="fapi-tag fapi-tag--ausente">logística —</span>`;
}
function tagAds(status) {
  if (status === 'real')    return `<span class="fapi-tag fapi-tag--ads">Ads</span>`;
  if (status === 'parcial') return `<span class="fapi-tag fapi-tag--warn">Ads parcial</span>`;
  if (status === 'nao')     return `<span class="fapi-tag fapi-tag--muted">sem Ads</span>`;
  return `<span class="fapi-tag fapi-tag--ausente">Ads —</span>`;
}
function tagDiag(prod) {
  if (!prod) return `<span class="fapi-tag fapi-tag--ausente">—</span>`;
  const temCusto = prod.base?.temCusto === true;
  const noDiag = prod.diag?.presente === true;
  if (temCusto && noDiag)  return `<span class="fapi-tag fapi-tag--ok">base + diag</span>`;
  if (temCusto && !noDiag) return `<span class="fapi-tag fapi-tag--warn">base · fora diag</span>`;
  if (!temCusto && noDiag) return `<span class="fapi-tag fapi-tag--warn">diag · sem custo</span>`;
  return `<span class="fapi-tag fapi-tag--crit">sem base/diag</span>`;
}
function thumb(p) {
  const ini = String(p?.titulo || p?.sku || p?.mlb || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '—';
  return `<span class="fapi-thumb" title="Foto via API (futuro)">${esc(ini)}</span>`;
}
function emptyState({ icon='•', title='', why='', next='', action='' }) {
  return `<div class="fapi-empty"><div class="fapi-empty-ic">${icon}</div><b>${esc(title)}</b>
    ${why ? `<p class="fapi-empty-why"><span>Por que importa:</span> ${esc(why)}</p>` : ''}
    ${next ? `<p class="fapi-empty-next"><span>Próximo passo:</span> ${esc(next)}</p>` : ''}${action || ''}</div>`;
}

/* ── SELETORES MOCK ───────────────────────────────────────── */
const MOCK_CLIENTES = [
  { id:12, nome:'Loja Exemplo', slug:'loja-exemplo' },
  { id:27, nome:'Casa & Decoração BR', slug:'casa-decoracao-br' },
  { id:41, nome:'TechParts Oficial', slug:'techparts-oficial' },
];
const MOCK_COMPETENCIAS = [
  { competencia:'2026-05', label:'Maio/2026', inicio:'2026-05-01', fim:'2026-05-31' },
  { competencia:'2026-04', label:'Abril/2026', inicio:'2026-04-01', fim:'2026-04-30' },
];

/* ================================================================
   FIXTURE — catálogo de produtos + pedidos.
   Produto carrega base/custo, diagnóstico e Product Ads (quando houver
   por produto). Pedido carrega valores crus; resultado é DERIVADO.
   ================================================================ */
const MOCK_PRODUTOS = {
  MLB1111: { mlb:'MLB1111', sku:'SKU-001', titulo:'Cabo USB-C 2m Nylon',        full:true,  ads:{status:'real', investimento:420.00, vendasAds:6200.00, acos:6.8}, base:{temCusto:true, custo:18.00, imposto:10, status:'real'},    diag:{presente:true, mc:14.2, status:'real'} },
  MLB2222: { mlb:'MLB2222', sku:'SKU-014', titulo:'Suporte Articulado Monitor', full:true,  ads:{status:'real', investimento:880.00, vendasAds:12400.00, acos:7.1}, base:{temCusto:true, custo:95.00, imposto:10, status:'real'},   diag:{presente:true, mc:22.0, status:'real'} },
  MLB3333: { mlb:'MLB3333', sku:'SKU-022', titulo:'Luminária LED Mesa',         full:false, ads:{status:'ausente'},                                                  base:{temCusto:false, custo:null, imposto:null, status:'ausente'}, diag:{presente:false, mc:null, status:'ausente'} },
  MLB4444: { mlb:'MLB4444', sku:'SKU-037', titulo:'Organizador Gavetas Kit',    full:true,  ads:{status:'nao'},                                                      base:{temCusto:true, custo:52.00, imposto:10, status:'real'},   diag:{presente:true, mc:9.0, status:'real'} },
  MLB5555: { mlb:'MLB5555', sku:'SKU-048', titulo:'Fone Bluetooth Esportivo',   full:false, ads:{status:'real', investimento:610.00, vendasAds:8900.00, acos:6.9}, base:{temCusto:true, custo:70.00, imposto:10, status:'real'},   diag:{presente:true, mc:18.0, status:'real'} },
  MLB6666: { mlb:'MLB6666', sku:null,      titulo:'Capa Protetora Universal',   full:null,  ads:{status:'parcial', investimento:null, vendasAds:null, acos:null},     base:{temCusto:false, custo:null, imposto:null, status:'ausente'}, diag:{presente:false, mc:null, status:'ausente'} },
  MLB7777: { mlb:'MLB7777', sku:'SKU-061', titulo:'Garrafa Térmica Inox 1L',    full:true,  ads:{status:'ausente'},                                                  base:{temCusto:false, custo:null, imposto:null, status:'ausente'}, diag:{presente:true, mc:null, status:'parcial'} },
  MLB8888: { mlb:'MLB8888', sku:'SKU-070', titulo:'Mouse Gamer RGB',            full:false, ads:{status:'real', investimento:300.00, vendasAds:5400.00, acos:5.6}, base:{temCusto:true, custo:60.00, imposto:10, status:'real'},   diag:{presente:true, mc:16.5, status:'real'} },
};

// pedidos: data, mlb(ref|null), unidades, valor, frete, freteStatus, taxas, taxasStatus, status, logistica
const MOCK_PEDIDOS = [
  { id:'2000000001', data:'2026-05-02', mlb:'MLB1111', unidades:3, valor:312.90, frete:24.90, freteStatus:'real',    taxas:41.80,  taxasStatus:'real',    status:'pago',         logistica:'full' },
  { id:'2000000002', data:'2026-05-02', mlb:'MLB2222', unidades:2, valor:489.50, frete:32.40, freteStatus:'real',    taxas:65.20,  taxasStatus:'real',    status:'pago',         logistica:'full' },
  { id:'2000000003', data:'2026-05-03', mlb:'MLB3333', unidades:1, valor:220.00, frete:null,  freteStatus:'ausente', taxas:28.00,  taxasStatus:'real',    status:'pago',         logistica:'normal' },
  { id:'2000000004', data:'2026-05-05', mlb:'MLB5555', unidades:2, valor:360.00, frete:26.70, freteStatus:'real',    taxas:47.00,  taxasStatus:'real',    status:'pago',         logistica:'normal' },
  { id:'2000000005', data:'2026-05-06', mlb:'MLB7777', unidades:4, valor:1180.00,frete:41.00, freteStatus:'real',    taxas:150.00, taxasStatus:'real',    status:'pago',         logistica:'full' },
  { id:'2000000006', data:'2026-05-07', mlb:'MLB4444', unidades:1, valor:159.00, frete:null,  freteStatus:'ausente', taxas:21.10,  taxasStatus:'real',    status:'pago',         logistica:'full' },
  { id:'2000000007', data:'2026-05-08', mlb:'MLB1111', unidades:5, valor:521.50, frete:30.00, freteStatus:'real',    taxas:70.00,  taxasStatus:'real',    status:'pago',         logistica:'full' },
  { id:'2000000008', data:'2026-05-09', mlb:'MLB2222', unidades:1, valor:268.00, frete:26.70, freteStatus:'real',    taxas:35.70,  taxasStatus:'real',    status:'pago',         logistica:'full' },
  { id:'2000000009', data:'2026-05-10', mlb:'MLB6666', unidades:6, valor:540.00, frete:38.00, freteStatus:'real',    taxas:70.00,  taxasStatus:'real',    status:'pago',         logistica:'full' },
  { id:'2000000010', data:'2026-05-11', mlb:'MLB8888', unidades:2, valor:370.00, frete:28.00, freteStatus:'real',    taxas:49.00,  taxasStatus:'real',    status:'pago',         logistica:'normal' },
  { id:'2000000011', data:'2026-05-12', mlb:'MLB3333', unidades:2, valor:440.00, frete:30.00, freteStatus:'real',    taxas:56.00,  taxasStatus:'real',    status:'cancelado',    logistica:'normal' },
  { id:'2000000012', data:'2026-05-13', mlb:'MLB5555', unidades:1, valor:180.00, frete:18.50, freteStatus:'real',    taxas:24.00,  taxasStatus:'real',    status:'pago',         logistica:'normal' },
  { id:'2000000013', data:'2026-05-15', mlb:null,      unidades:1, valor:318.40, frete:19.90, freteStatus:'real',    taxas:44.30,  taxasStatus:'real',    status:'pago',         logistica:'normal' },
  { id:'2000000014', data:'2026-05-16', mlb:'MLB2222', unidades:3, valor:735.00, frete:45.00, freteStatus:'real',    taxas:98.00,  taxasStatus:'real',    status:'pago',         logistica:'full' },
  { id:'2000000015', data:'2026-05-17', mlb:'MLB7777', unidades:2, valor:590.00, frete:22.00, freteStatus:'real',    taxas:76.00,  taxasStatus:'real',    status:'com_problema', logistica:'full' },
  { id:'2000000016', data:'2026-05-18', mlb:'MLB1111', unidades:4, valor:417.20, frete:28.00, freteStatus:'real',    taxas:55.00,  taxasStatus:'real',    status:'pago',         logistica:'full' },
  { id:'2000000017', data:'2026-05-20', mlb:'MLB4444', unidades:2, valor:318.00, frete:null,  freteStatus:'ausente', taxas:42.00,  taxasStatus:'real',    status:'pago',         logistica:'full' },
  { id:'2000000018', data:'2026-05-22', mlb:'MLB8888', unidades:3, valor:555.00, frete:33.00, freteStatus:'real',    taxas:73.00,  taxasStatus:'real',    status:'pago',         logistica:'normal' },
  { id:'2000000019', data:'2026-05-23', mlb:'MLB5555', unidades:2, valor:360.00, frete:26.00, freteStatus:'real',    taxas:null,   taxasStatus:'ausente', status:'pago',         logistica:'normal' },
  { id:'2000000020', data:'2026-05-24', mlb:'MLB2222', unidades:1, valor:268.00, frete:26.70, freteStatus:'real',    taxas:35.70,  taxasStatus:'real',    status:'pago',         logistica:'full' },
  { id:'2000000021', data:'2026-05-26', mlb:'MLB6666', unidades:3, valor:270.00, frete:20.00, freteStatus:'estimado',taxas:35.00,  taxasStatus:'real',    status:'pago',         logistica:'full' },
  { id:'2000000022', data:'2026-05-28', mlb:'MLB1111', unidades:2, valor:208.60, frete:16.00, freteStatus:'real',    taxas:27.00,  taxasStatus:'real',    status:'pago',         logistica:'full' },
];

/* Contrato consumível pela tela (mantém compatibilidade com a doc). */
const mockFechamentoApiPayload = {
  ok: true,
  fonte: 'mock_conciliacao_fechamento_api',
  cliente: { id:12, nome:'Loja Exemplo', slug:'loja-exemplo' },
  periodo: { competencia:'2026-05', inicio:'2026-05-01', fim:'2026-05-31', label:'Maio/2026' },
  motor: { status:'mock', etapaAtual:'cruzar_base_custo', progresso:62, confianca:'parcial', podeConcluir:false,
           motivoBloqueio:'Receita sem produto conciliado e itens sem custo/base impedem resultado confiável.',
           geradoEm:new Date().toISOString(), origemPrincipal:'planilha_vendas' },
  adsPorProdutoDisponivel: true,   // há Product Ads por produto p/ parte do catálogo
  adsMensal: { investimento: 2210.00, status: 'real' },
  produtos: MOCK_PRODUTOS,
  pedidos: MOCK_PEDIDOS,
};

/* ────────────────────────────────────────────────────────────────
   CONTRATO FUTURO (não implementar agora) — Curva ABC e Full real.
   Nesta V1 NÃO há Curva ABC real, NÃO há Full API real, e não se inventa
   estoque parado / retirada Full / quantidade parada. Quando o backend/Drive
   existir, deve preencher estes campos; sem dado, mostrar "sem dado" ou ocultar.

   abc: {
     fonte,
     produtos: [{
       mlb, sku, titulo, unidades, faturamento,
       percentualFaturamento, acumuladoFaturamento,
       percentualUnidades, acumuladoUnidades,
       curvaFaturamento, curvaUnidades, curvaFinal
     }]
   }
   full: {
     fonte, pedidosFull, produtosFull, estoqueFull, retiradaFull
   }
   ──────────────────────────────────────────────────────────────── */

/* ── ESTADO ───────────────────────────────────────────────── */
/* Modos de período expostos na UI: mes | intervalo (Data personalizada) |
   ultimos7 | semana.  O modo 'dia' é LEGADO: não aparece no seletor, mas a
   régua de dias ainda pode aplicar um intervalo de 1 dia (de == ate). */
function defaultFilters() { return { modo:'mes', dia:null, semana:null, de:null, ate:null, logistica:'todos', midia:'todos', diagbase:'todos', status:'todos' }; }
function cloneFilters(filters) { return { ...defaultFilters(), ...(filters || {}) }; }
const F = {
  clientes: [], cliente: null, competencia: null,
  rawPayload: null, viewPayload: null,
  filters: defaultFilters(),
  draftFilters: defaultFilters(),
  selectedOrderId: null,
  productLimit: 10, draftProductLimit: 10, productSort: 'faturamento',
  intervaloAviso: null,   // aviso discreto quando a data inicial > final foi corrigida
  arquivoImport: null,    // File guardado no change do input — imune a repaint do carregarTela
};

/* ── DERIVAÇÕES DE PEDIDO (motor por pedido) ──────────────── */
function getOrderDate(o) { const d = new Date(String(o.data) + 'T00:00:00'); return isNaN(d.getTime()) ? null : d; }
function getWeekOfMonth(o) { const d = getOrderDate(o); return d ? Math.ceil(d.getDate() / 7) : null; }
function isOrderFull(o) { return o.logistica === 'full'; }
function getProduto(payload, mlb) { return mlb ? (payload.produtos || {})[mlb] || null : null; }
function hasProductAds(prod) { const s = prod?.ads?.status; return s === 'real' || s === 'parcial'; }
function normalizeLimit(value) {
  if (value === null || value === undefined || value === 'todos') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 10;
}
function isDateInPeriod(iso, period) {
  return !!iso && iso >= period.inicio && iso <= period.fim && String(iso).startsWith(period.competencia);
}
function clampDateToPeriod(iso, period) {
  if (!iso) return null;
  if (iso < period.inicio) return period.inicio;
  if (iso > period.fim) return period.fim;
  return String(iso).startsWith(period.competencia) ? iso : null;
}
function getCompetenceDays(period) {
  const days = [];
  const cur = new Date(period.inicio + 'T00:00:00');
  const end = new Date(period.fim + 'T00:00:00');
  while (!isNaN(cur.getTime()) && cur <= end) {
    days.push(isoDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}
function getWeekRanges(period) {
  const days = getCompetenceDays(period);
  const max = days.length ? Math.ceil(Number(days[days.length - 1].slice(8, 10)) / 7) : 5;
  return Array.from({ length:max }, (_, idx) => {
    const semana = idx + 1;
    const fromDay = (semana - 1) * 7 + 1;
    const toDay = Math.min(semana * 7, Number(period.fim.slice(8, 10)));
    const ym = period.competencia;
    return {
      semana,
      de: `${ym}-${String(fromDay).padStart(2, '0')}`,
      ate: `${ym}-${String(toDay).padStart(2, '0')}`,
    };
  });
}
function getLast7Range(period) {
  const fim = new Date(period.fim + 'T00:00:00');
  const de = new Date(fim);
  de.setDate(de.getDate() - 6);
  const deIso = isoDate(de);
  return { de: deIso < period.inicio ? period.inicio : deIso, ate: period.fim };
}
function sanitizeFilters(filters, payload) {
  const f = cloneFilters(filters);
  const period = payload.periodo;

  if (!['mes', 'dia', 'semana', 'intervalo', 'ultimos7'].includes(f.modo)) f.modo = 'mes';
  if (!['todos', 'full', 'nao_full'].includes(f.logistica)) f.logistica = 'todos';
  if (!['todos', 'com_ads', 'sem_ads'].includes(f.midia)) f.midia = 'todos';
  if (!['todos', 'com_custo', 'sem_custo', 'no_diag', 'fora_diag'].includes(f.diagbase)) f.diagbase = 'todos';
  if (!['todos', 'valido', 'cancelado', 'problema', 'bloqueado'].includes(f.status)) f.status = 'todos';

  if (f.modo === 'dia') {
    f.dia = isDateInPeriod(f.dia, period) ? f.dia : null;
    f.semana = null; f.de = null; f.ate = null;
  } else if (f.modo === 'semana') {
    const weeks = getWeekRanges(period).map(w => String(w.semana));
    f.semana = weeks.includes(String(f.semana || '')) ? String(f.semana) : null;
    f.dia = null; f.de = null; f.ate = null;
  } else if (f.modo === 'intervalo') {
    f.de = clampDateToPeriod(f.de, period);
    f.ate = clampDateToPeriod(f.ate, period);
    if (f.de && f.ate && f.de > f.ate) { const t = f.de; f.de = f.ate; f.ate = t; }
    f.dia = null; f.semana = null;
  } else {
    f.dia = null; f.semana = null; f.de = null; f.ate = null;
  }
  return f;
}

/* Calcula o pedido cruzando com o produto/base. Resultado DERIVADO. */
function computeOrder(o, payload) {
  const prod = getProduto(payload, o.mlb);
  const un = o.unidades;
  const cancelled = o.status === 'cancelado';
  const noProduct = !o.mlb;
  const temCusto = prod?.base?.temCusto === true;
  const custoTotal = (temCusto && un != null) ? round2(prod.base.custo * un) : null;
  const impostoPct = temCusto ? (prod.base.imposto || 0) : null;
  const imposto = (custoTotal != null) ? round2(o.valor * (impostoPct / 100)) : null;

  const out = {
    ...o,
    produto: prod ? { mlb:prod.mlb, sku:prod.sku, titulo:prod.titulo } : { mlb:o.mlb, sku:null, titulo:(noProduct ? '(linha financeira sem produto)' : o.mlb) },
    prod,
    full: isOrderFull(o),
    adsStatus: prod?.ads?.status ?? 'ausente',
    custo: custoTotal, custoStatus: custoTotal == null ? 'ausente' : 'real',
    imposto,
    resultado: null, resultadoStatus: 'bloqueado', confianca: 'bloqueado',
    pendencias: [],
  };

  if (cancelled) { out.pendencias.push('cancelado/reembolso — fora do resultado'); out.status = 'cancelado'; return out; }
  if (noProduct) { out.pendencias.push('financeiro sem produto conciliado'); return out; }
  if (custoTotal == null) { out.pendencias.push('MLB sem custo na base'); return out; }

  const provis = round2(o.valor - (o.frete || 0) - (o.taxas || 0) - custoTotal - (imposto || 0));
  out.resultado = provis;
  if (o.frete == null)        { out.resultadoStatus = 'parcial';  out.confianca = 'parcial'; out.pendencias.push('frete real ausente'); }
  else if (o.taxas == null)   { out.resultadoStatus = 'parcial';  out.confianca = 'parcial'; out.pendencias.push('taxa não identificada'); }
  else if (o.freteStatus === 'estimado') { out.resultadoStatus = 'estimado'; out.confianca = 'parcial'; out.pendencias.push('frete estimado'); }
  else                        { out.resultadoStatus = 'real';     out.confianca = 'confiavel'; }
  if (o.status === 'com_problema') { out.confianca = 'parcial'; out.pendencias.push('pedido com problema'); }
  if (prod && prod.diag?.presente !== true) out.pendencias.push('produto fora do diagnóstico');
  return out;
}

/* ── FILTROS ──────────────────────────────────────────────── */
function applyFilters(payload, filters) {
  filters = sanitizeFilters(filters, payload);
  let pedidos = (payload.pedidos || []).map(o => computeOrder(o, payload));

  // período
  pedidos = pedidos.filter(o => String(o.data).startsWith(payload.periodo.competencia));
  if (filters.modo === 'dia' && filters.dia) pedidos = pedidos.filter(o => o.data === filters.dia);
  if (filters.modo === 'semana' && filters.semana) pedidos = pedidos.filter(o => getWeekOfMonth(o) === Number(filters.semana));
  if (filters.modo === 'intervalo' && (filters.de || filters.ate)) {
    pedidos = pedidos.filter(o => (!filters.de || o.data >= filters.de) && (!filters.ate || o.data <= filters.ate));
  }
  if (filters.modo === 'ultimos7') {
    const r = getLast7Range(payload.periodo);
    pedidos = pedidos.filter(o => o.data >= r.de && o.data <= r.ate);
  }
  // logística
  if (filters.logistica === 'full')     pedidos = pedidos.filter(o => o.full === true);
  if (filters.logistica === 'nao_full') pedidos = pedidos.filter(o => o.full !== true);
  // mídia
  if (filters.midia === 'com_ads') pedidos = pedidos.filter(o => hasProductAds(o.prod));
  if (filters.midia === 'sem_ads') pedidos = pedidos.filter(o => !hasProductAds(o.prod));
  // diagnóstico/base
  if (filters.diagbase === 'com_custo')  pedidos = pedidos.filter(o => o.prod?.base?.temCusto === true);
  if (filters.diagbase === 'sem_custo')  pedidos = pedidos.filter(o => o.prod?.base?.temCusto !== true);
  if (filters.diagbase === 'no_diag')    pedidos = pedidos.filter(o => o.prod?.diag?.presente === true);
  if (filters.diagbase === 'fora_diag')  pedidos = pedidos.filter(o => !o.prod || o.prod.diag?.presente !== true);
  // status
  if (filters.status === 'valido')    pedidos = pedidos.filter(o => o.status === 'pago');
  if (filters.status === 'cancelado') pedidos = pedidos.filter(o => o.status === 'cancelado');
  if (filters.status === 'problema')  pedidos = pedidos.filter(o => o.status === 'com_problema');
  if (filters.status === 'bloqueado') pedidos = pedidos.filter(o => o.resultadoStatus === 'bloqueado' && o.status !== 'cancelado');

  return { ...payload, pedidos };
}

/* ── BUILDERS ─────────────────────────────────────────────── */
function buildOrderMetrics(view) {
  const ps = view.pedidos;
  const validos = ps.filter(o => o.status === 'pago' || o.status === 'com_problema');
  const cancelProblema = ps.filter(o => o.status === 'cancelado' || o.status === 'com_problema');
  const faturamento = round2(validos.reduce((s, o) => s + (o.valor || 0), 0));
  const bloqueada = round2(ps.filter(o => o.resultadoStatus === 'bloqueado' && o.status !== 'cancelado').reduce((s, o) => s + (o.valor || 0), 0));
  return {
    totalPedidos: ps.length,
    faturamento,
    validos: validos.length,
    cancelProblema: cancelProblema.length,
    ticketMedio: validos.length ? round2(faturamento / validos.length) : null,
    receitaBloqueada: bloqueada,
    pedidosFreteAusente: ps.filter(o => o.frete == null && o.status !== 'cancelado').length,
    pedidosCustoAusente: ps.filter(o => o.custoStatus === 'ausente' && o.mlb && o.status !== 'cancelado').length,
  };
}

function aggByProduct(pedidos) {
  const map = new Map();
  for (const o of pedidos) {
    const key = o.mlb || '__SEM_PRODUTO__';
    if (!map.has(key)) map.set(key, {
      mlb: o.mlb, prod: o.prod, titulo: o.produto.titulo, sku: o.produto.sku,
      unidades: 0, pedidos: 0, faturamento: 0, receitaBloqueada: 0, freteAcum: 0, taxasAcum: 0,
      cancelProblema: 0, full: o.full, semProduto: !o.mlb,
    });
    const a = map.get(key);
    const valido = o.status !== 'cancelado';
    a.pedidos += 1;
    if (valido) { a.unidades += (o.unidades || 0); a.faturamento += (o.valor || 0); }
    if (o.resultadoStatus === 'bloqueado' && valido) a.receitaBloqueada += (o.valor || 0);
    a.freteAcum += (o.frete || 0);
    a.taxasAcum += (o.taxas || 0);
    if (o.status === 'cancelado' || o.status === 'com_problema') a.cancelProblema += 1;
    if (o.full === true) a.full = true;        // qualquer pedido full marca o produto como (também) full
  }
  for (const a of map.values()) { a.faturamento = round2(a.faturamento); a.receitaBloqueada = round2(a.receitaBloqueada); a.freteAcum = round2(a.freteAcum); a.taxasAcum = round2(a.taxasAcum); }
  return [...map.values()];
}

function buildProductSalesRanking(view, { sortBy = 'faturamento', limit = 10 } = {}) {
  const arr = aggByProduct(view.pedidos);
  const totalFat = arr.reduce((s, a) => s + a.faturamento, 0) || 0;
  arr.forEach(a => { a.pctFat = totalFat > 0 ? round2(a.faturamento / totalFat * 100) : null; });
  arr.sort((x, y) => (y[sortBy] || 0) - (x[sortBy] || 0));
  const limited = (limit == null) ? arr : arr.slice(0, limit);
  return { rows: limited, totalFat, totalCount: arr.length };
}

function productPendenciaPrincipal(a, prod) {
  if (a?.semProduto) return 'financeiro sem produto';
  if (!prod) return 'produto não encontrado';
  if (prod.base?.temCusto !== true) return 'sem custo/base';
  if (prod.diag?.presente !== true) return 'fora do diagnóstico';
  if (prod.ads?.status === 'parcial') return 'Product Ads parcial';
  if ((a?.receitaBloqueada || 0) > 0) return 'receita bloqueada';
  if ((a?.cancelProblema || 0) > 0) return 'cancelado/problema';
  return '—';
}
function buildDailySales(view) {
  const map = new Map();
  for (const o of view.pedidos) {
    if (!map.has(o.data)) map.set(o.data, { data:o.data, faturamento:0, pedidos:0, unidades:0, cancelProblema:0, produtosSet:new Set(), receitaBloqueada:0, _topMap:new Map() });
    const d = map.get(o.data);
    const valido = o.status !== 'cancelado';
    d.pedidos += 1;
    if (valido) { d.faturamento += (o.valor || 0); d.unidades += (o.unidades || 0); if (o.mlb) d.produtosSet.add(o.mlb); }
    if (o.status === 'cancelado' || o.status === 'com_problema') d.cancelProblema += 1;
    if (o.resultadoStatus === 'bloqueado' && valido) d.receitaBloqueada += (o.valor || 0);
    if (valido && o.mlb) d._topMap.set(o.mlb, (d._topMap.get(o.mlb) || 0) + (o.valor || 0));
  }
  const arr = [...map.values()].map(d => {
    let top = null; let topV = -1;
    for (const [mlb, v] of d._topMap) if (v > topV) { topV = v; top = mlb; }
    const prod = top ? MOCK_PRODUTOS[top] : null;
    return { data:d.data, faturamento:round2(d.faturamento), pedidos:d.pedidos, unidades:d.unidades,
             cancelProblema:d.cancelProblema, produtos:d.produtosSet.size, receitaBloqueada:round2(d.receitaBloqueada),
             topProduto: prod ? { titulo:prod.titulo, faturamento:round2(topV) } : null };
  });
  arr.sort((a, b) => a.data.localeCompare(b.data));
  return arr;
}

function buildDailyRulerRows() {
  if (!F.rawPayload) return [];
  const secondaryFilters = {
    ...F.filters,
    modo: 'mes',
    dia: null,
    semana: null,
    de: null,
    ate: null,
  };
  const monthView = applyFilters(F.rawPayload, secondaryFilters);
  const byDay = new Map(buildDailySales(monthView).map(d => [d.data, d]));
  return getCompetenceDays(F.rawPayload.periodo).map(data => byDay.get(data) || {
    data,
    faturamento: 0,
    pedidos: 0,
    unidades: 0,
    cancelProblema: 0,
    produtos: 0,
    receitaBloqueada: 0,
    topProduto: null,
  });
}
function dayScopeClass(data) {
  const fl = F.filters;
  if (fl.modo === 'dia') return fl.dia === data ? ' fapi-day--sel' : '';
  if (fl.modo === 'semana' && fl.semana) return getWeekOfMonth({ data }) === Number(fl.semana) ? ' fapi-day--scope' : '';
  if (fl.modo === 'intervalo' && (fl.de || fl.ate)) return (!fl.de || data >= fl.de) && (!fl.ate || data <= fl.ate) ? ' fapi-day--scope' : '';
  if (fl.modo === 'ultimos7') {
    const r = getLast7Range(F.rawPayload.periodo);
    return data >= r.de && data <= r.ate ? ' fapi-day--scope' : '';
  }
  return '';
}

/* ── CARREGAMENTO ─────────────────────────────────────────── */
async function carregarPayload(slug, competencia) {
  if (!slug) return null;
  try {
    const res = await fetch(
      `${API_BASE}/operacao/central-vendas/${encodeURIComponent(slug)}?competencia=${encodeURIComponent(competencia)}`,
      { headers: { Authorization: "Bearer " + TOKEN } }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // fallback se vier sem pedidos (cliente sem importação)
    if (!data || !Array.isArray(data.pedidos) || data.pedidos.length === 0) throw new Error("sem_pedidos");
    return data;
  } catch (_) {
    // fallback para mock — motor-status fica "● Mock"
    const cli = F.clientes.find(c => c.slug === slug) || mockFechamentoApiPayload.cliente;
    const comp = MOCK_COMPETENCIAS.find(c => c.competencia === competencia) || MOCK_COMPETENCIAS[0];
    const p = JSON.parse(JSON.stringify(mockFechamentoApiPayload));
    p.cliente = { id:cli.id, nome:cli.nome, slug:cli.slug };
    p.periodo = { competencia:comp.competencia, inicio:comp.inicio, fim:comp.fim, label:comp.label };
    return p;
  }
}

/* ── INIT ─────────────────────────────────────────────────── */
async function initFechamentosApi() {
  // Troca textos visíveis para "Central de Vendas"
  document.title = document.title.replace('Fechamentos API', 'Central de Vendas');
  const titleEl = document.querySelector('.fapi-title');
  if (titleEl && titleEl.textContent.trim() === 'Fechamentos API') titleEl.textContent = 'Central de Vendas';
  const ariaEl = document.getElementById('fapi-main');
  if (ariaEl) ariaEl.setAttribute('aria-label', 'Central de Vendas');

  // Busca lista real de clientes — mesmo endpoint e lógica do cliente-360.js.
  // Fallback para /clientes (admin-only) se o endpoint operacional não existir.
  try {
    let data = await fetch(`${API_BASE}/operacao/cliente-360/clientes`,
      { headers: { Authorization: 'Bearer ' + TOKEN } }).then(r => r.ok ? r.json() : null);
    if (!data?.ok) {
      const r2 = await fetch(`${API_BASE}/clientes`, { headers: { Authorization: 'Bearer ' + TOKEN } });
      data = r2.ok ? await r2.json() : null;
    }
    const lista = Array.isArray(data?.clientes) ? data.clientes
                : Array.isArray(data)            ? data
                : [];
    F.clientes = lista
      .filter(c => c?.ativo !== false)
      .sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
  } catch (_) {
    F.clientes = [];
  }

  const sel = document.getElementById('fapi-client-select');
  if (sel) {
    sel.innerHTML = '<option value="">Selecione o cliente…</option>' +
      F.clientes.map(c => `<option value="${esc(c.slug)}">${esc(c.nome)}</option>`).join('');
    // Trocar cliente reseta filtros e seleção.
    sel.addEventListener('change', () => { F.cliente = F.clientes.find(c => c.slug === sel.value) || null; F.selectedOrderId = null; resetFilters(); carregarTela(); });
  }
  const comp = document.getElementById('fapi-comp-select');
  if (comp) {
    comp.innerHTML = MOCK_COMPETENCIAS.map(c => `<option value="${esc(c.competencia)}">${esc(c.label)}</option>`).join('');
    F.competencia = MOCK_COMPETENCIAS[0].competencia;
    // Trocar competência reseta filtros e seleção.
    comp.addEventListener('change', () => { F.competencia = comp.value; F.selectedOrderId = null; resetFilters(); carregarTela(); });
  }
  const controls = document.querySelector('.fapi-controls');
  if (controls) montarBlocoImportacao(controls);
  carregarTela();
}
function resetFilters() {
  F.filters = defaultFilters();
  F.draftFilters = defaultFilters();
  F.productLimit = 10;
  F.draftProductLimit = 10;
  F.productSort = 'faturamento';
  F.intervaloAviso = null;
}

async function carregarTela() {
  const content = document.getElementById('fapi-content');
  if (!content) return;
  if (!F.cliente) {
    F.rawPayload = null; F.viewPayload = null; renderHeader(null);
    content.innerHTML = emptyState({ icon:'🎯', title:'Selecione um cliente para abrir o motor',
      why:'O fechamento por pedido é sempre por cliente e por competência.', next:'Escolha um cliente e a competência acima.' });
    return;
  }
  F.rawPayload = await carregarPayload(F.cliente.slug, F.competencia);
  if (!F.rawPayload?.ok) {
    renderHeader({ motor:{ status:'indisponivel' } });
    content.innerHTML = emptyState({ icon:'🔌', title:'Motor indisponível', why:'O backend do motor ainda não respondeu.', next:'Quando o endpoint existir, a tela carrega o payload real.' });
    return;
  }
  F.viewPayload = applyFilters(F.rawPayload, F.filters);
  F.filters = sanitizeFilters(F.filters, F.rawPayload);
  F.draftFilters = sanitizeFilters(F.draftFilters, F.rawPayload);
  renderHeader(F.rawPayload);
  /* Ordem da tela: filtros → cards → régua de dias → tabela de pedidos →
     detalhe/extrato do pedido (sob demanda) → ranking de produtos. */
  content.innerHTML =
    renderFilters() +
    renderOrderSummary() +
    renderDailySales() +
    renderOrdersTable() +
    '<div id="fapi-pedido-detalhe"></div>' +
    renderTopProducts();
  wireInteractions();
}

/* ── HEADER ───────────────────────────────────────────────── */
const MOTOR = { mock:['mock','● Mock'], parcial:['parcial','● Parcial'], api:['api','● API conectado'], indisponivel:['indisponivel','● Indisponível'] };
function renderHeader(p) {
  const st = document.getElementById('fapi-motor-status');
  if (st) { const [cls, label] = MOTOR[p?.motor?.status] || MOTOR.mock; st.className = `fapi-motor fapi-motor--${cls}`; st.textContent = label; }
  const cf = document.getElementById('fapi-confianca');
  if (cf) { if (p?.motor?.confianca) { cf.hidden = false; cf.innerHTML = `Confiança ${confPill(p.motor.confianca)}`; } else cf.hidden = true; }
}

/* ── 1. FILTROS ───────────────────────────────────────────── */
function filterStatesEqual(a, b) {
  const fa = cloneFilters(a), fb = cloneFilters(b);
  return ['modo', 'dia', 'semana', 'de', 'ate', 'logistica', 'midia', 'diagbase', 'status'].every(k => String(fa[k] ?? '') === String(fb[k] ?? ''));
}
function hasPendingFilterChanges() {
  return !filterStatesEqual(F.filters, F.draftFilters) || String(F.productLimit ?? 'todos') !== String(F.draftProductLimit ?? 'todos');
}
function periodText(filters = F.filters, payload = F.rawPayload) {
  if (!payload) return '';
  // Modo legado 'dia' (clique na régua): mostra o intervalo de 1 dia.
  if (filters.modo === 'dia') return filters.dia ? fmtDt(filters.dia) : payload.periodo.label;
  if (filters.modo === 'semana') {
    const range = getWeekRanges(payload.periodo).find(w => String(w.semana) === String(filters.semana || ''));
    return range ? `semana ${range.semana} · ${fmtDt(range.de)} até ${fmtDt(range.ate)}` : 'semana do mês';
  }
  if (filters.modo === 'intervalo') {
    if (filters.de && filters.ate) return `${fmtDt(filters.de)} até ${fmtDt(filters.ate)}`;
    if (filters.de) return `a partir de ${fmtDt(filters.de)}`;
    if (filters.ate) return `até ${fmtDt(filters.ate)}`;
    return 'data personalizada';
  }
  if (filters.modo === 'ultimos7') {
    const r = getLast7Range(payload.periodo);
    return `${fmtDt(r.de)} até ${fmtDt(r.ate)}`;
  }
  return `${payload.periodo.label} · mês inteiro`;
}
function filterSummaryText() {
  const parts = [`Mostrando ${F.viewPayload?.pedidos?.length || 0} pedidos`, periodText(F.filters, F.rawPayload)];
  const fl = F.filters;
  if (fl.logistica === 'full') parts.push('Full');
  if (fl.logistica === 'nao_full') parts.push('não Full');
  if (fl.midia === 'com_ads') parts.push('com Product Ads');
  if (fl.midia === 'sem_ads') parts.push('sem Product Ads');
  if (fl.diagbase === 'com_custo') parts.push('com custo/base');
  if (fl.diagbase === 'sem_custo') parts.push('sem custo/base');
  if (fl.diagbase === 'no_diag') parts.push('no diagnóstico');
  if (fl.diagbase === 'fora_diag') parts.push('fora do diagnóstico');
  if (fl.status === 'valido') parts.push('pedidos válidos');
  if (fl.status === 'cancelado') parts.push('cancelados');
  if (fl.status === 'problema') parts.push('com problema');
  if (fl.status === 'bloqueado') parts.push('bloqueados por dado');
  parts.push(F.productLimit == null ? 'todos os produtos' : `Top ${F.productLimit} produtos`);
  return parts.filter(Boolean).join(' · ') + '.';
}
function renderFilters() {
  const raw = F.rawPayload, fl = F.draftFilters;
  const semanas = getWeekRanges(raw.periodo);
  const opt = (v, label, sel) => `<option value="${esc(v)}"${sel === v ? ' selected' : ''}>${esc(label)}</option>`;
  const sel = (id, val, opts) => `<select class="fapi-fsel" data-filter="${id}">${opts}</select>`;
  const pending = hasPendingFilterChanges();
  // Modo de UI: 'dia' (legado) é tratado como 'intervalo' no seletor.
  const modoUI = fl.modo === 'dia' ? 'intervalo' : fl.modo;
  /* Período principal (espelha a tela Métricas): Mês inteiro · Data
     personalizada · Últimos 7 dias · Semana do mês. Sem "Dia específico". */
  const periodoSel = sel('modo', modoUI, [
    opt('mes', 'Mês inteiro', modoUI),
    opt('intervalo', 'Data personalizada', modoUI),
    opt('ultimos7', 'Últimos 7 dias', modoUI),
    opt('semana', 'Semana do mês', modoUI),
  ].join(''));
  // Campo visual de intervalo (Métricas-like): dois inputs de data limpos.
  const intervaloUI = (modoUI === 'intervalo') ? `
      <label class="fapi-fitem fapi-fitem--date"><span>Data inicial</span>
        <input type="date" class="fapi-fdate" data-filter="de" value="${esc(fl.de || '')}" min="${esc(raw.periodo.inicio)}" max="${esc(raw.periodo.fim)}"></label>
      <span class="fapi-date-sep" aria-hidden="true">até</span>
      <label class="fapi-fitem fapi-fitem--date"><span>Data final</span>
        <input type="date" class="fapi-fdate" data-filter="ate" value="${esc(fl.ate || '')}" min="${esc(raw.periodo.inicio)}" max="${esc(raw.periodo.fim)}"></label>` : '';
  const semanaUI = (modoUI === 'semana') ? `<label class="fapi-fitem"><span>Semana</span>${sel('semana', String(fl.semana || ''), ['<option value="">—</option>', ...semanas.map(w => opt(String(w.semana), `Semana ${w.semana} · ${fmtDt(w.de)} a ${fmtDt(w.ate)}`, String(fl.semana || '')))].join(''))}</label>` : '';
  const aviso = F.intervaloAviso ? `<div class="fapi-filter-aviso" role="status">${esc(F.intervaloAviso)}</div>` : '';
  return `
  <section class="fapi-filters">
    <div class="fapi-filters-row fapi-filters-main">
      <label class="fapi-fitem"><span>Período principal</span>${periodoSel}</label>
      ${intervaloUI}
      ${semanaUI}
      <div class="fapi-filter-actions">
        <button class="fapi-btn fapi-btn-primary fapi-btn-sm" id="fapi-filter-apply" type="button">Filtrar</button>
        <button class="fapi-btn fapi-btn-ghost fapi-btn-sm" id="fapi-filter-clear" type="button">Limpar</button>
      </div>
    </div>
    <div class="fapi-filters-row fapi-filters-secondary">
      <label class="fapi-fitem"><span>Logística</span>${sel('logistica', fl.logistica, [opt('todos','Todos',fl.logistica), opt('full','Full',fl.logistica), opt('nao_full','Não Full',fl.logistica)].join(''))}</label>
      <label class="fapi-fitem"><span>Mídia</span>${sel('midia', fl.midia, [opt('todos','Todos',fl.midia), opt('com_ads','Com Product Ads',fl.midia), opt('sem_ads','Sem Product Ads',fl.midia)].join(''))}</label>
      <label class="fapi-fitem"><span>Diagnóstico/base</span>${sel('diagbase', fl.diagbase, [opt('todos','Todos',fl.diagbase), opt('com_custo','Com custo/base',fl.diagbase), opt('sem_custo','Sem custo/base',fl.diagbase), opt('no_diag','No diagnóstico',fl.diagbase), opt('fora_diag','Fora do diagnóstico',fl.diagbase)].join(''))}</label>
      <label class="fapi-fitem"><span>Status</span>${sel('status', fl.status, [opt('todos','Todos',fl.status), opt('valido','Válido',fl.status), opt('cancelado','Cancelado',fl.status), opt('problema','Problema',fl.status), opt('bloqueado','Bloqueado por dado',fl.status)].join(''))}</label>
      <label class="fapi-fitem"><span>Top produtos</span>${sel('limit', String(F.draftProductLimit ?? 'todos'), [opt('10','Top 10',String(F.draftProductLimit ?? 'todos')), opt('20','Top 20',String(F.draftProductLimit ?? 'todos')), opt('todos','Todos',String(F.draftProductLimit ?? 'todos'))].join(''))}</label>
    </div>
    ${aviso}
    <div class="fapi-filter-summary">${esc(filterSummaryText())}${pending ? ' <span class="fapi-filter-pending">aplique para atualizar</span>' : ''}</div>
  </section>`;
}

/* ── 2. RESUMO PEDIDO-FIRST ───────────────────────────────── */
function renderOrderSummary() {
  const m = buildOrderMetrics(F.viewPayload);
  const card = (lbl, val, sub, cls) => `<div class="fapi-card"><div class="fapi-card-lbl">${esc(lbl)}</div><div class="fapi-card-val${cls ? ' ' + cls : ''}">${val}</div><div class="fapi-card-sub">${sub || '&nbsp;'}</div></div>`;
  return `
  <section class="fapi-panel">
    <div class="fapi-panel-head"><h2 class="fapi-panel-title">Pedidos do período</h2>
      <span class="fapi-panel-meta">o que aconteceu nos pedidos deste filtro</span></div>
    <div class="fapi-panel-body fapi-panel-body--flush">
      <div class="fapi-cards">
        ${card('Total de pedidos', valOr(m.totalPedidos), 'no filtro')}
        ${card('Faturamento', money(m.faturamento), 'pedidos válidos', 'brand')}
        ${card('Pedidos válidos', valOr(m.validos), 'pagos + problema')}
        ${card('Cancelados / problema', valOr(m.cancelProblema), 'fora da venda boa', 'crit')}
        ${card('Ticket médio', valOr(m.ticketMedio, money), 'por pedido válido')}
        ${card('Receita bloqueada', money(m.receitaBloqueada), 'falta dado p/ calcular', 'warn')}
        ${card('Frete ausente', valOr(m.pedidosFreteAusente), 'pedidos sem frete')}
        ${card('Custo ausente', valOr(m.pedidosCustoAusente), 'pedidos s/ custo na base')}
      </div>
    </div>
  </section>`;
}

/* ── 10. VENDAS POR DIA ───────────────────────────────────── */
function renderDailySales() {
  const dias = buildDailyRulerRows();
  if (!dias.length) return '';
  const cells = dias.map(d => {
    const scope = dayScopeClass(d.data);
    const empty = d.pedidos === 0 ? ' fapi-day--empty' : '';
    const markers = [
      d.cancelProblema > 0 ? '<span class="fapi-day-marker fapi-day-marker--problem" title="Cancelamento/problema"></span>' : '',
      d.receitaBloqueada > 0 ? '<span class="fapi-day-marker fapi-day-marker--blocked" title="Receita bloqueada"></span>' : '',
    ].join('');
    const tip = `${fmtDt(d.data)} · ${money(d.faturamento)} · ${d.pedidos} ped · ${d.unidades} un` + (d.topProduto ? ` · top: ${d.topProduto.titulo}` : '');
    return `<button class="fapi-day${scope}${empty}" data-day="${esc(d.data)}" title="${esc(tip)}">
      <span class="fapi-day-d">${esc(String(new Date(d.data + 'T00:00:00').getDate()).padStart(2, '0'))}</span>
      <span class="fapi-day-v">${esc(shortMoney(d.faturamento))}</span>
      <span class="fapi-day-p">${esc(String(d.pedidos))} ped.</span>
      <span class="fapi-day-markers">${markers}</span>
    </button>`;
  }).join('');
  return `
  <section class="fapi-panel">
    <div class="fapi-panel-head"><h2 class="fapi-panel-title">Vendas por dia</h2>
      <span class="fapi-panel-meta">clique num dia para aplicar · amarelo = problema · vermelho = receita bloqueada</span></div>
    <div class="fapi-panel-body"><div class="fapi-days">${cells}</div></div>
  </section>`;
}

/* ── 3. TABELA DE PEDIDOS ─────────────────────────────────── */
const STATUS_PEDIDO = { pago:['ok','Pago'], cancelado:['crit','Cancelado'], com_problema:['warn','Problema'], pendente:['warn','Pendente'] };
function renderOrdersTable() {
  const rows = F.viewPayload.pedidos;
  if (!rows.length) {
    return `<section class="fapi-panel"><div class="fapi-panel-body">${emptyState({ icon:'📦', title:'Nenhum pedido neste filtro', why:'Os filtros atuais não retornaram pedidos.', next:'Ajuste o período/logística/status acima.' })}</div></section>`;
  }
  const tr = rows.map(o => {
    const [scls, slbl] = STATUS_PEDIDO[o.status] || ['muted', o.status];
    const res = o.resultado == null ? '<span class="muted">—</span>' : `<span class="fapi-est">${money(o.resultado)}</span>`;
    return `
      <tr class="fapi-prow${F.selectedOrderId === o.id ? ' fapi-prow--sel' : ''}" data-pedido="${esc(o.id)}" tabindex="0">
        <td class="mono">${esc(o.id)}</td>
        <td class="nowrap">${fmtDt(o.data)}</td>
        <td><span class="fapi-pill fapi-pill--${scls}">${esc(slbl)}</span></td>
        <td class="clip">${esc(o.produto?.titulo || '—')}</td>
        <td class="mono">${esc(o.produto?.mlb || '—')}</td>
        <td class="mono muted">${esc(o.produto?.sku || '—')}</td>
        <td>${tagFull(o.full)}</td>
        <td>${tagAds(o.adsStatus)}</td>
        <td class="right strong">${valOr(o.valor, money)}</td>
        <td class="right">${valOr(o.frete, money)}</td>
        <td class="right">${valOr(o.taxas, money)}</td>
        <td class="right">${valOr(o.custo, money)}</td>
        <td class="right">${res}</td>
        <td>${confPill(o.confianca)}</td>
        <td class="muted clip">${o.pendencias.length ? esc(o.pendencias[0]) : '—'}</td>
      </tr>`;
  }).join('');
  return `
  <section class="fapi-panel">
    <div class="fapi-panel-head"><h2 class="fapi-panel-title">Pedidos</h2>
      <span class="fapi-panel-meta">clique para abrir o extrato financeiro · respeita os filtros</span></div>
    <div class="fapi-panel-body fapi-panel-body--flush">
      <div class="fapi-tablewrap">
        <table class="fapi-table fapi-table--click">
          <thead><tr><th>Pedido</th><th>Data</th><th>Status</th><th>Produto</th><th>MLB</th><th>SKU</th><th>Full</th><th>Ads</th><th class="right">Valor</th><th class="right">Frete</th><th class="right">Taxas</th><th class="right">Custo</th><th class="right">Resultado</th><th>Confiança</th><th>Pendência</th></tr></thead>
          <tbody>${tr}</tbody>
        </table>
      </div>
      <div class="fapi-table-note">Resultado é sempre <b>estimado</b> e fica <b>—</b> quando o pedido está bloqueado (custo/produto ausente). Ausência nunca vira R$ 0,00.</div>
    </div>
  </section>`;
}

/* ── 4. DETALHE DO PEDIDO ─────────────────────────────────── */
/* Lista o que falta para concluir, com o impacto de cada lacuna. */
function faltasDoPedido(o, prod) {
  const faltas = [];
  if (o.status === 'cancelado') faltas.push(['pedido cancelado/reembolso', 'não conclui resultado; impacto fora da venda boa']);
  if (!o.mlb) faltas.push(['financeiro sem produto', 'impede atribuir custo/base e calcular resultado do item']);
  if (o.custoStatus === 'ausente' && o.mlb) faltas.push(['falta custo/base', 'impede calcular resultado do item']);
  if (o.frete == null) faltas.push(['falta frete real', 'resultado fica parcial, nunca confiável']);
  if (o.taxas == null) faltas.push(['falta taxa', 'resultado fica parcial, nunca confiável']);
  if (prod && prod.diag?.presente !== true) faltas.push(['falta vínculo com diagnóstico', 'sem checagem de margem do produto']);
  return faltas;
}
function abrirPedido(id) {
  const o = (F.viewPayload?.pedidos || F.rawPayload?.pedidos || []).map(x => x.prod !== undefined ? x : computeOrder(x, F.rawPayload)).find(x => x.id === id);
  const host = document.getElementById('fapi-pedido-detalhe');
  if (!o || !host) return;
  F.selectedOrderId = id;
  document.querySelectorAll('.fapi-prow').forEach(r => r.classList.toggle('fapi-prow--sel', r.dataset.pedido === id));

  const prod = o.prod;
  const faltas = faltasDoPedido(o, prod);
  const bloqueado = o.resultado == null;
  const cancelado = o.status === 'cancelado';
  const precoUnit = (o.valor != null && o.unidades) ? round2(o.valor / o.unidades) : null;

  // Uma linha do extrato: Componente · Operação · Valor · Status · Fonte · Obs.
  const linha = (comp, op, valHtml, status, fonte, obs) => `
    <tr>
      <td class="fapi-ext-comp">${esc(comp)}</td>
      <td class="center fapi-ext-op">${esc(op || '')}</td>
      <td class="right fapi-ext-val">${valHtml}</td>
      <td>${status ? statusBadge(status) : '<span class="muted">—</span>'}</td>
      <td class="fapi-ext-fonte muted">${esc(fonte || '—')}</td>
      <td class="fapi-ext-obs muted clip">${esc(obs || '—')}</td>
    </tr>`;

  // Bloco do produto: quantidade, preço/valor, Full/Normal, Ads, base/diag.
  const prodKV = [
    ['MLB', o.produto?.mlb || '—'],
    ['SKU', o.produto?.sku || '—'],
    ['Quantidade', valOr(o.unidades, num)],
    ['Preço unit.', valOr(precoUnit, money)],
    ['Valor do pedido', valOr(o.valor, money)],
  ].map(([k, v]) => `<div class="fapi-det-row"><span class="fapi-det-k">${esc(k)}</span><span class="fapi-det-v">${esc(v)}</span></div>`).join('');

  host.innerHTML = `
    <section class="fapi-panel fapi-detail">
      <div class="fapi-panel-head"><h2 class="fapi-panel-title">Extrato financeiro do pedido</h2>
        <div class="fapi-panel-actions">${confPill(o.confianca)}
          <button class="fapi-btn fapi-btn-ghost fapi-btn-sm" onclick="fecharPedido()">Fechar ✕</button></div></div>
      <div class="fapi-panel-body">
        <p class="fapi-det-lede">Valores derivados do pedido e dos cruzamentos disponíveis. Ausência nunca vira zero.</p>

        <div class="fapi-det-head">${thumb(o.produto)}
          <div><div class="fapi-det-title">${esc(o.produto?.titulo || '—')}</div>
            <div class="fapi-det-meta">Pedido ${esc(o.id)} · ${fmtDt(o.data)} · ${esc((STATUS_PEDIDO[o.status] || ['', o.status])[1])}</div>
            <div class="fapi-det-tags">${tagFull(o.full)} ${tagAds(o.adsStatus)} ${tagDiag(prod)}</div></div></div>
        <div class="fapi-det-grid">${prodKV}</div>

        <div class="fapi-ext-wrap fapi-tablewrap">
          <table class="fapi-table fapi-ext-table">
            <thead><tr><th>Componente</th><th class="center">Op.</th><th class="right">Valor</th><th>Status</th><th>Fonte</th><th>Observação</th></tr></thead>
            <tbody>
              ${linha('Receita do pedido', '', valOr(o.valor, money), 'real', o.mlb ? 'planilha vendas / futuro Orders API' : 'planilha vendas (sem MLB)', o.mlb ? '' : 'linha financeira sem produto')}
              ${linha('Frete seller', '−', valOr(o.frete, money), o.frete == null ? 'ausente' : o.freteStatus, o.freteStatus === 'estimado' ? 'estimado / futuro Shipping API' : 'planilha vendas / futuro Shipping API', o.frete == null ? 'sem frete real — parcial' : '')}
              ${linha('Taxas marketplace', '−', valOr(o.taxas, money), o.taxas == null ? 'ausente' : o.taxasStatus, 'planilha vendas / futuro pagamentos', o.taxas == null ? 'taxa não identificada — parcial' : '')}
              ${linha('Custo / base', '−', valOr(o.custo, money), o.custoStatus, 'base interna', o.custoStatus === 'ausente' ? (o.mlb ? 'sem custo na base — bloqueia' : 'sem produto vinculado') : '')}
              ${linha('Imposto / regra interna', '−', valOr(o.imposto, money), o.imposto == null ? 'ausente' : 'real', 'base interna · Imposto %', o.imposto == null ? 'depende do custo/base' : '')}
              ${cancelado ? linha('Reembolso / cancelamento', '−', valOr(o.valor, money), 'parcial', 'planilha vendas', 'pedido cancelado — impacto, não conclusão') : ''}
              <tr class="fapi-ext-total">
                <td class="fapi-ext-comp strong">Resultado estimado</td>
                <td class="center fapi-ext-op">=</td>
                <td class="right fapi-ext-val">${o.resultado == null ? '<span class="muted">—</span>' : `<span class="fapi-est">${money(o.resultado)}</span>`}</td>
                <td>${statusBadge(o.resultadoStatus)}</td>
                <td class="fapi-ext-fonte muted">derivado</td>
                <td class="fapi-ext-obs muted">${esc(bloqueado ? 'bloqueado — não vira R$ 0,00' : (o.resultadoStatus === 'real' ? 'todos os componentes presentes' : 'parcial — não confiável'))}</td>
              </tr>
            </tbody>
          </table>
        </div>

        ${(bloqueado || faltas.length) ? `<div class="fapi-det-block${bloqueado ? '' : ' fapi-det-block--warn'}">
          <b>${bloqueado ? 'Sem informações suficientes para concluir' : 'Resultado parcial — o que ainda falta'}</b>
          <ul>${faltas.map(([f, imp]) => `<li><b>${esc(f)}</b> — ${esc(imp)}</li>`).join('')}</ul>
        </div>` : ''}
      </div>
    </section>`;
  host.scrollIntoView({ behavior:'smooth', block:'nearest' });
}
function fecharPedido() { F.selectedOrderId = null; const h = document.getElementById('fapi-pedido-detalhe'); if (h) h.innerHTML = ''; document.querySelectorAll('.fapi-prow--sel').forEach(r => r.classList.remove('fapi-prow--sel')); }

/* ── 5. PRODUTOS MAIS VENDIDOS ────────────────────────────── */
const SORTS = [['faturamento','Faturamento'], ['unidades','Unidades'], ['pedidos','Pedidos'], ['receitaBloqueada','Receita bloqueada']];
/* Ranking simples de produtos (agregação dos pedidos do filtro).
   Sem produto acompanhado e sem painel de detalhe — apenas a tabela. */
function renderTopProducts() {
  const { rows, totalCount } = buildProductSalesRanking(F.viewPayload, { sortBy: F.productSort, limit: F.productLimit });
  const sortBtns = SORTS.map(([k, l]) => `<button class="fapi-sortbtn${F.productSort === k ? ' active' : ''}" data-sort="${k}">${esc(l)}</button>`).join('');
  if (!rows.length) return `<section class="fapi-panel"><div class="fapi-panel-head"><h2 class="fapi-panel-title">Ranking de produtos</h2></div><div class="fapi-panel-body">${emptyState({ icon:'•', title:'Sem produtos no filtro', why:'Nenhum pedido com produto no recorte atual.', next:'Ajuste os filtros.' })}</div></section>`;
  const body = rows.map((a, i) => {
    const pend = productPendenciaPrincipal(a, a.prod);
    const missingBase = !a.semProduto && a.prod?.base?.temCusto !== true;
    return `
    <tr class="${missingBase ? 'fapi-prow--missing-base' : ''}">
      <td class="fapi-rank">${i + 1}</td>
      <td class="strong clip">${esc(a.titulo)}</td>
      <td class="mono">${esc(a.mlb || '—')}</td>
      <td class="mono muted">${esc(a.sku || '—')}</td>
      <td class="right">${valOr(a.unidades)}</td>
      <td class="right">${valOr(a.pedidos)}</td>
      <td class="right strong">${money(a.faturamento)}</td>
      <td class="right">${valOr(a.pctFat, pct)}</td>
      <td>${tagFull(a.semProduto ? null : (a.prod ? a.prod.full : a.full))}</td>
      <td>${tagAds(a.prod?.ads?.status ?? 'ausente')}</td>
      <td>${tagDiag(a.prod)}</td>
      <td class="muted clip">${esc(pend)}</td>
    </tr>`;
  }).join('');
  return `
  <section class="fapi-panel">
    <div class="fapi-panel-head"><h2 class="fapi-panel-title">Ranking de produtos</h2>
      <span class="fapi-panel-meta">${rows.length}/${totalCount} · agregação dos pedidos do filtro</span></div>
    <div class="fapi-sortbar" id="fapi-sortbar"><span class="fapi-sortbar-lbl">Ordenar por</span>${sortBtns}</div>
    <div class="fapi-panel-body fapi-panel-body--flush"><div class="fapi-tablewrap">
      <table class="fapi-table">
        <thead><tr><th>#</th><th>Produto</th><th>MLB</th><th>SKU</th><th class="right">Un.</th><th class="right">Ped.</th><th class="right">Faturamento</th><th class="right">% filtro</th><th>Full</th><th>Ads</th><th>Base/diag</th><th>Pendência</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div></div>
  </section>`;
}

/* ── INTERAÇÕES ───────────────────────────────────────────── */
function setDraftFilter(key, value) {
  if (key === 'limit') {
    F.draftProductLimit = normalizeLimit(value);
    return;
  }
  F.intervaloAviso = null;
  // 'modo' vem da UI com os valores internos (mes | intervalo | ultimos7 | semana).
  F.draftFilters[key] = value || null;
  if (key === 'modo') { F.draftFilters.dia = null; F.draftFilters.semana = null; F.draftFilters.de = null; F.draftFilters.ate = null; }
  F.draftFilters = sanitizeFilters(F.draftFilters, F.rawPayload);
}
function applyDraftFilters() {
  // Aviso discreto quando data inicial > final foi corrigida automaticamente.
  const d = F.draftFilters;
  const invertido = d.modo === 'intervalo' && d.de && d.ate && d.de > d.ate;
  F.filters = sanitizeFilters(F.draftFilters, F.rawPayload);
  F.draftFilters = cloneFilters(F.filters);
  F.productLimit = normalizeLimit(F.draftProductLimit);
  F.draftProductLimit = F.productLimit;
  F.selectedOrderId = null;
  F.intervaloAviso = invertido ? 'A data inicial era maior que a final — invertemos o intervalo.' : null;
  carregarTela();
}
function clearFilters() {
  // Limpar: volta para mês inteiro, todos os filtros, Top 10, sem datas/semana.
  resetFilters();
  F.selectedOrderId = null;
  carregarTela();
}
function applyDayFilter(day) {
  // Clique na régua: vira Data personalizada com intervalo de 1 dia e aplica já.
  if (!isDateInPeriod(day, F.rawPayload.periodo)) return;
  F.filters = { ...cloneFilters(F.filters), modo:'intervalo', dia:null, semana:null, de:day, ate:day };
  F.draftFilters = cloneFilters(F.filters);
  F.selectedOrderId = null;
  F.intervaloAviso = null;
  carregarTela();
}
function wireInteractions() {
  document.querySelectorAll('.fapi-fsel').forEach(s => s.addEventListener('change', () => { setDraftFilter(s.dataset.filter, s.value); carregarTela(); }));
  document.querySelectorAll('.fapi-fdate').forEach(s => s.addEventListener('change', () => { setDraftFilter(s.dataset.filter, s.value); carregarTela(); }));
  document.getElementById('fapi-filter-apply')?.addEventListener('click', applyDraftFilters);
  document.getElementById('fapi-filter-clear')?.addEventListener('click', clearFilters);
  document.querySelectorAll('#fapi-sortbar .fapi-sortbtn').forEach(b => b.addEventListener('click', () => { F.productSort = b.dataset.sort; carregarTela(); }));
  document.querySelectorAll('.fapi-day').forEach(d => d.addEventListener('click', () => applyDayFilter(d.dataset.day)));
  document.querySelectorAll('.fapi-prow').forEach(row => {
    row.addEventListener('click', () => abrirPedido(row.dataset.pedido));
    row.addEventListener('keydown', e => { if (e.key === 'Enter') abrirPedido(row.dataset.pedido); });
  });
  if (F.selectedOrderId) abrirPedido(F.selectedOrderId);
}

/* ── IMPORTAÇÃO DE VENDAS (admin only) ───────────────────── */
function montarBlocoImportacao(controls) {
  const user = JSON.parse(localStorage.getItem('vf-user') || '{}');
  if (user.role !== 'admin') return;

  if (!document.getElementById('fapi-import-styles')) {
    const s = document.createElement('style');
    s.id = 'fapi-import-styles';
    s.textContent = [
      '.fapi-import-block { border-left: 1px solid var(--vfop-border,#dde1e8); padding-left: 14px; margin-left: 2px; }',
      '.fapi-import-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
      '.fapi-import-input { width: 0.1px; height: 0.1px; opacity: 0; overflow: hidden; position: absolute; z-index: -1; }',
      '.fapi-import-label { display: inline-flex; align-items: center; height: 28px; padding: 0 10px; border-radius: 6px; font-size: 11.5px; font-weight: 600; cursor: pointer; border: 1px solid var(--vfop-border,#dde1e8); color: var(--vfop-muted,#5a6578); background: var(--vfop-surface,#fff); white-space: nowrap; }',
      '.fapi-import-label:hover { background: var(--vfop-subtle,#f8f9fb); }',
      '.fapi-import-fname { font-size: 11px; color: var(--vfop-text,#111827); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.fapi-import-fname:empty::before { content: "Nenhum arquivo"; color: var(--vfop-soft,#8c96a6); }',
      '.fapi-import-status { font-size: 11.5px; font-weight: 600; margin-top: 4px; padding: 3px 7px; border-radius: 4px; width: 100%; box-sizing: border-box; }',
      '.fapi-import-status--info    { color: #2563eb; background: #eff6ff; }',
      '.fapi-import-status--ok      { color: #1a7a45; background: #f4fbf7; }',
      '.fapi-import-status--warn    { color: #855100; background: #fdf9f0; }',
      '.fapi-import-status--danger  { color: #9b1c1c; background: #fdf4f3; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  const wrap = document.createElement('div');
  wrap.id = 'fapi-import-block';
  wrap.className = 'fapi-field fapi-import-block';
  wrap.innerHTML = `
    <label>Importar vendas</label>
    <div class="fapi-import-row">
      <input type="file" id="fapi-import-file" accept=".xlsx" class="fapi-import-input">
      <label for="fapi-import-file" class="fapi-import-label">Escolher .xlsx</label>
      <span id="fapi-import-fname" class="fapi-import-fname"></span>
      <button id="fapi-import-btn" class="fapi-btn fapi-btn-primary fapi-btn-sm" type="button">Importar</button>
      <button id="fapi-sync-btn" class="fapi-btn fapi-btn-ghost fapi-btn-sm" type="button" title="Busca os pedidos direto da API do Mercado Livre (sem planilha)">Sincronizar via API</button>
    </div>
    <div id="fapi-import-status" class="fapi-import-status" hidden></div>`;
  controls.appendChild(wrap);

  // Guarda o File em F.arquivoImport no momento da seleção — imune a qualquer
  // repaint ou reescrita de #fapi-content pelo carregarTela.
  document.getElementById('fapi-import-file').addEventListener('change', function () {
    const f = this.files?.[0] || null;
    F.arquivoImport = f;
    const nome = document.getElementById('fapi-import-fname');
    if (nome) nome.textContent = f ? f.name : '';
    setImportStatus('', '');
  });

  document.getElementById('fapi-import-btn').addEventListener('click', executarImportacao);
  document.getElementById('fapi-sync-btn').addEventListener('click', executarSincronizacao);
}

function setImportStatus(msg, tipo) {
  const el = document.getElementById('fapi-import-status');
  if (!el) return;
  el.hidden = !msg;
  el.textContent = msg || '';
  el.className = `fapi-import-status fapi-import-status--${tipo || 'info'}`;
}

async function executarImportacao() {
  if (!TOKEN) return;
  const btn = document.getElementById('fapi-import-btn');

  if (!F.cliente) { setImportStatus('Selecione um cliente antes de importar.', 'warn'); return; }
  if (!F.competencia) { setImportStatus('Selecione a competência antes de importar.', 'warn'); return; }

  // Usa F.arquivoImport (variável de estado) — não depende de input.files[0],
  // que o browser pode zerar após repaint mesmo sem destruir o elemento.
  const arquivo = F.arquivoImport;
  if (!arquivo) { setImportStatus('Selecione a planilha de vendas (.xlsx).', 'warn'); return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Importando…'; }
  setImportStatus('Importando…', 'info');

  try {
    const form = new FormData();
    form.append('sales', arquivo);
    form.append('competencia', F.competencia);

    const res = await fetch(
      `${API_BASE}/operacao/central-vendas/${encodeURIComponent(F.cliente.slug)}/importar-vendas`,
      { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: form }
    );

    if (res.status === 401) { window.location.replace('index.html'); return; }

    const json = await res.json();
    if (!res.ok) throw new Error(json.erro || json.error || json.message || `HTTP ${res.status}`);

    const pedidos = json.pedidosPersistidos ?? '?';
    setImportStatus(`✓ Importado: ${pedidos} pedido(s). Recarregando…`, 'ok');
    // Limpa o arquivo após importação bem-sucedida
    F.arquivoImport = null;
    const fileInput = document.getElementById('fapi-import-file');
    if (fileInput) fileInput.value = '';
    const fname = document.getElementById('fapi-import-fname');
    if (fname) fname.textContent = '';
    await carregarTela();
    setImportStatus(`✓ ${pedidos} pedido(s) importados com sucesso.`, 'ok');
  } catch (err) {
    setImportStatus(`Erro: ${err?.message || 'Falha na importação.'}`, 'danger');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Importar'; }
  }
}

/* Sincronização API-first: busca pedidos direto da Orders API do ML, sem planilha.
   Custo continua vindo da base vinculada oficial do cliente. */
async function executarSincronizacao() {
  if (!TOKEN) return;
  const btn = document.getElementById('fapi-sync-btn');

  if (!F.cliente) { setImportStatus('Selecione um cliente antes de sincronizar.', 'warn'); return; }
  if (!F.competencia) { setImportStatus('Selecione a competência antes de sincronizar.', 'warn'); return; }

  if (btn) { btn.disabled = true; btn.textContent = 'Sincronizando…'; }
  setImportStatus('Sincronizando pedidos via API do Mercado Livre…', 'info');

  try {
    const res = await fetch(
      `${API_BASE}/operacao/central-vendas/${encodeURIComponent(F.cliente.slug)}/sincronizar`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ competencia: F.competencia }),
      }
    );

    if (res.status === 401) { window.location.replace('index.html'); return; }

    const json = await res.json();
    if (!res.ok) throw new Error(json.erro || json.error || json.message || `HTTP ${res.status}`);

    const pedidos = json.pedidosPersistidos ?? '?';
    const orders = json.ordersEncontrados ?? '?';
    const baseTxt = json.baseVinculada ? `base "${json.baseVinculada.nome}"` : 'sem base vinculada';
    setImportStatus(`✓ Sincronizado: ${pedidos} pedido(s) de ${orders} da API · ${baseTxt}. Recarregando…`, 'ok');
    await carregarTela();
    setImportStatus(`✓ ${pedidos} pedido(s) sincronizados via API (${baseTxt}).`, 'ok');
  } catch (err) {
    setImportStatus(`Erro: ${err?.message || 'Falha na sincronização.'}`, 'danger');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sincronizar via API'; }
  }
}

/* ── BOOT ─────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', initFechamentosApi);
