/* ================================================================
   fechamentos-api.js — VenForce · Central de Vendas (Fundação V2)
   ----------------------------------------------------------------
   FERRAMENTA OPERACIONAL de conciliação por PEDIDO.
   Regra central: o PEDIDO é a fonte da verdade; o PRODUTO é agregação
   dos pedidos; dia/semana/mês são FILTROS sobre os pedidos.

   Honestidade do dado:
     null/undefined = AUSENTE (mostra "—")   ·   0 = zero REAL
     status: real | estimado | ausente | parcial | bloqueado
     resultado NUNCA é exibido como confiável se faltar dado.

   Arquitetura da tela (V2):
     - Barra global de contexto (cliente/período/motor/ações admin);
     - Abas: Visão geral · Pedidos · Produtos/Curva ABC;
     - UM único fetch por carregamento (init, troca de cliente/período,
       pós-importação, pós-sincronização); filtros/busca/paginação e
       troca de aba são 100% locais;
     - Detalhe do pedido em drawer lateral;
     - Curva ABC isolada em módulo próprio (ver seção "MÓDULO CURVA ABC")
       para futura extração em página dedicada.
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
const fmtDtHr = s => { if (!s) return '—'; const d = new Date(s); return isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }); };
const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/* Período de análise: converte o modo escolhido em { dateFrom, dateTo }. */
const PERIOD_OPTS = [
  ['mes_atual', 'Mês atual'],
  ['mes_anterior', 'Mês anterior'],
  ['ultimos7', 'Últimos 7 dias'],
  ['ultimos30', 'Últimos 30 dias'],
  ['personalizado', 'Personalizado'],
];
function computePeriodo(mode, customFrom, customTo) {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const y = hoje.getFullYear(), m = hoje.getMonth();
  if (mode === 'mes_anterior') {
    return { mode, dateFrom: isoDate(new Date(y, m - 1, 1)), dateTo: isoDate(new Date(y, m, 0)) };
  }
  if (mode === 'ultimos7') {
    const f = new Date(hoje); f.setDate(f.getDate() - 6);
    return { mode, dateFrom: isoDate(f), dateTo: isoDate(hoje) };
  }
  if (mode === 'ultimos30') {
    const f = new Date(hoje); f.setDate(f.getDate() - 29);
    return { mode, dateFrom: isoDate(f), dateTo: isoDate(hoje) };
  }
  if (mode === 'personalizado') {
    const from = customFrom || isoDate(new Date(y, m, 1));
    const to = customTo || isoDate(hoje);
    return { mode: 'personalizado', dateFrom: from <= to ? from : to, dateTo: from <= to ? to : from };
  }
  // mes_atual (default): 1º dia do mês até hoje
  return { mode: 'mes_atual', dateFrom: isoDate(new Date(y, m, 1)), dateTo: isoDate(hoje) };
}
const shortMoney = n => {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1000000) return 'R$ ' + num(v / 1000000, 1) + ' mi';
  if (abs >= 1000) return 'R$ ' + num(v / 1000, 1) + 'k';
  return 'R$ ' + num(v, 0);
};
/* '—' para ausente; valor para 0 real. */
const valOr = (v, f = num) => (v === null || v === undefined) ? '—' : f(v);

/* ── STATUS / CONFIANÇA / TAGS SEMÂNTICAS (Fundação V2) ──────
   real → sucesso · estimado → info · ausente → perigo ·
   parcial → alerta · bloqueado → neutro (mesmo mapa da V1). */
const STATUS_LBL = { real:'Real', estimado:'Estimado', ausente:'Ausente', parcial:'Parcial', bloqueado:'Bloqueado' };
const STATUS_CLS = { real:'is-success', estimado:'is-info', ausente:'is-danger', parcial:'is-warning', bloqueado:'is-neutral' };
function statusTag(s) { return `<span class="vf-tag ${STATUS_CLS[s] || 'is-neutral'}">${esc(STATUS_LBL[s] || s || '—')}</span>`; }
const CONF = { confiavel:['is-success','Confiável'], parcial:['is-warning','Parcial'], insuficiente:['is-danger','Insuficiente'], bloqueado:['is-danger','Bloqueado'] };
function confidenceClass(c) { return (CONF[c] || CONF.bloqueado)[0]; }
function confidenceLabel(c) { return (CONF[c] || CONF.bloqueado)[1]; }
/* Estado operacional: dot + texto (nunca só cor). */
function confStatus(c) { return `<span class="vf-status ${confidenceClass(c)}">${esc(confidenceLabel(c))}</span>`; }

/* tags discretas de logística / ads / diagnóstico (textos preservados) */
function tagFull(full) {
  if (full === true)  return `<span class="vf-tag is-primary">Full</span>`;
  if (full === false) return `<span class="vf-tag is-neutral">Normal</span>`;
  return `<span class="vf-tag is-neutral">logística —</span>`;
}
function tagAds(status) {
  if (status === 'real')    return `<span class="vf-tag is-info">Ads</span>`;
  if (status === 'parcial') return `<span class="vf-tag is-warning">Ads parcial</span>`;
  if (status === 'nao')     return `<span class="vf-tag is-neutral">sem Ads</span>`;
  return `<span class="vf-tag is-neutral">Ads —</span>`;
}
function tagDiag(prod) {
  if (!prod) return `<span class="vf-tag is-neutral">—</span>`;
  const temCusto = prod.base?.temCusto === true;
  const noDiag = prod.diag?.presente === true;
  if (temCusto && noDiag)  return `<span class="vf-tag is-success">base + diag</span>`;
  if (temCusto && !noDiag) return `<span class="vf-tag is-warning">base · fora diag</span>`;
  if (!temCusto && noDiag) return `<span class="vf-tag is-warning">diag · sem custo</span>`;
  return `<span class="vf-tag is-danger">sem base/diag</span>`;
}
function thumb(p) {
  const ini = String(p?.titulo || p?.sku || p?.mlb || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '—';
  return `<span class="vf-fapi-thumb" aria-hidden="true">${esc(ini)}</span>`;
}

/* Ícones SVG neutros para estados (sem emoji como único significado) */
const EMPTY_ICONS = {
  target: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="4"></circle><circle cx="12" cy="12" r="0.5"></circle></svg>',
  plug: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 7V3"></path><path d="M15 7V3"></path><path d="M6 7h12v4a6 6 0 0 1-12 0z"></path><path d="M12 17v4"></path></svg>',
  doc: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="13" y2="17"></line></svg>',
  box: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5v8l9 5 9-5z"></path><path d="M3 8l9 5 9-5"></path><path d="M12 13v8"></path></svg>',
  dot: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="2.5"></circle></svg>',
};
function emptyState({ icon = 'dot', tone = '', title = '', why = '', next = '', action = '' }) {
  return `<div class="vf-empty">
    <div class="vf-empty__icon${tone ? ' ' + tone : ''}">${EMPTY_ICONS[icon] || EMPTY_ICONS.dot}</div>
    <p class="vf-empty__title">${esc(title)}</p>
    ${why ? `<p class="vf-empty__description">${esc(why)}</p>` : ''}
    ${next ? `<p class="vf-empty__description">${esc(next)}</p>` : ''}
    ${action ? `<div class="vf-empty__actions">${action}</div>` : ''}
  </div>`;
}
function loadingState(msg) {
  return `<div class="vf-loading-state"><span class="vf-spinner vf-spinner--lg" aria-hidden="true"></span><span>${esc(msg || 'Carregando dados do período…')}</span></div>`;
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
   Nesta versão NÃO há Curva ABC do backend nem Full API real, e não se
   inventa estoque parado / retirada Full / quantidade parada. Quando o
   backend/Drive existir, deve preencher estes campos; sem dado, mostrar
   "sem dado" ou ocultar.

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

/* ── ESTADO ───────────────────────────────────────────────────
   Um único objeto F, com sub-estados por módulo:
     F.ui      → aba ativa, drawer, painéis abertos (só interface)
     F.orders  → tudo da tabela de Pedidos (filtros locais)
     F.summary → recorte e ordenação do bloco de fechamento/dias
     F.abc     → estado EXCLUSIVO do módulo Curva ABC
   Os pedidos nunca são duplicados: viewPayload/visiblePayload são
   derivados de rawPayload em memória.

   Modos de período expostos na UI: mes | intervalo (via clique num dia).
   'dia'/'semana'/'ultimos7' são LEGADOS aceitos pelo sanitizador. */
function defaultFilters() { return { modo:'mes', dia:null, semana:null, de:null, ate:null, logistica:'todos', midia:'todos', diagbase:'todos', status:'todos' }; }
function cloneFilters(filters) { return { ...defaultFilters(), ...(filters || {}) }; }
const F = {
  clientes: [], cliente: null,
  periodo: null,          // { mode, dateFrom, dateTo } — período de análise
  rawPayload: null, viewPayload: null, visiblePayload: null,
  lastSyncBase: null,     // base vinculada informada pela última sincronização da sessão
  loadSeq: 0,             // guard de concorrência: ignora resposta de fetch antigo
  loadAbort: null,        // AbortController do fetch em voo
  loading: false,
  arquivoImport: null,    // File guardado no change do input — imune a re-render

  ui: {
    activeTab: 'visao',   // visao | pedidos | produtos
    drawerOrderId: null,
    drawerReturnFocusId: null,
    filtersPanelOpen: false,
    importPanelOpen: false,
  },

  orders: {
    filters: defaultFilters(), // selects locais (logística/mídia/diag.base/status) + dia
    quickFilter: 'todos',      // recorte rápido (chips)
    search: '',                // busca local por pedido/MLB/SKU/título/status/logística
    searchTimer: null,         // debounce da busca
    sort: 'data_desc',         // ordenação local
    page: 1, pageSize: 100,    // paginação local (100 pedidos/página)
  },

  summary: {
    quickFilter: 'todos',      // recorte do bloco Fechamento (não toca Pedidos/ABC)
    dailySort: 'data',         // ordenação da tabela "Resumo por dia"
  },

  abc: {                       // estado EXCLUSIVO do módulo Curva ABC
    group: 'todos',
    sort: 'faturamento',
    search: '',
    searchTimer: null,
    page: 1, pageSize: 50,
    selectedProduct: null,     // reservado p/ futura extração (sem uso hoje)
  },
};

/* ── DERIVAÇÕES DE PEDIDO (motor por pedido) ──────────────── */
function getOrderDate(o) { const d = new Date(String(o.data) + 'T00:00:00'); return isNaN(d.getTime()) ? null : d; }
function getWeekOfMonth(o) { const d = getOrderDate(o); return d ? Math.ceil(d.getDate() / 7) : null; }
function isOrderFull(o) { return o.logistica === 'full'; }
function getProduto(payload, mlb) { return mlb ? (payload.produtos || {})[mlb] || null : null; }
function hasProductAds(prod) { const s = prod?.ads?.status; return s === 'real' || s === 'parcial'; }
function isDateInPeriod(iso, period) {
  return !!iso && iso >= period.inicio && iso <= period.fim;
}
function clampDateToPeriod(iso, period) {
  if (!iso) return null;
  if (iso < period.inicio) return period.inicio;
  if (iso > period.fim) return period.fim;
  return iso;
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

  // período de análise (intervalo de datas — pode cruzar meses)
  pedidos = pedidos.filter(o => o.data && o.data >= payload.periodo.inicio && o.data <= payload.periodo.fim);
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

/* ── FECHAMENTO API (helpers puros) ───────────────────────────
   Fecham o PERÍODO inteiro (payload já escopado pelo GET por range) usando
   só pedidos/itens/componentes sincronizados + base vinculada. Não chamam ML.
   null = ausente ("—") · 0 = zero real · ausência nunca vira R$ 0,00. */
function fechamentoOrders(payload) {
  return (payload?.pedidos || []).map(o => (o.prod !== undefined ? o : computeOrder(o, payload)));
}
/* Recorte do Fechamento (reaproveita o predicado dos chips de pedido). */
function fechamentoOrdersFiltered(payload, quick) {
  const orders = fechamentoOrders(payload);
  return (quick && quick !== 'todos') ? orders.filter(o => pedidoMatchesQuick(o, quick)) : orders;
}
function fechSum(arr, f) { return round2(arr.reduce((s, o) => s + (Number(f(o)) || 0), 0)); }

function buildFechamentoResumo(payload, quick = 'todos') {
  const orders = fechamentoOrdersFiltered(payload, quick);
  const validos = orders.filter(o => o.status !== 'cancelado');
  const cancelProblema = orders.filter(o => o.status === 'cancelado' || o.status === 'com_problema');
  const faturamento = fechSum(validos, o => o.valor);
  const unidades = validos.reduce((s, o) => s + (o.unidades || 0), 0);
  const comComissao = validos.filter(o => o.taxas != null);
  const comissao = comComissao.length ? fechSum(comComissao, o => o.taxas) : null;
  const comCusto = validos.filter(o => o.custo != null);
  const custoTotal = comCusto.length ? fechSum(comCusto, o => o.custo) : null;
  const comImposto = validos.filter(o => o.imposto != null);
  const impostoTotal = comImposto.length ? fechSum(comImposto, o => o.imposto) : null;
  const comFrete = validos.filter(o => o.frete != null);
  const freteTotal = comFrete.length ? fechSum(comFrete, o => o.frete) : null; // null = ausente (sem Shipping API)
  const comResultado = validos.filter(o => o.resultado != null);
  const resultadoParcial = comResultado.length ? fechSum(comResultado, o => o.resultado) : null;
  const receitaBloqueada = fechSum(validos.filter(o => o.resultadoStatus === 'bloqueado'), o => o.valor);
  const ticket = validos.length ? round2(faturamento / validos.length) : null;

  // Confiável só quando TODO pedido válido tem resultado real (custo + tarifa +
  // frete real). Qualquer ausência (inclusive frete) mantém o fechamento parcial.
  let confianca;
  if (!validos.length || !comResultado.length) confianca = 'insuficiente';
  else if (validos.every(o => o.resultadoStatus === 'real')) confianca = 'confiavel';
  else confianca = 'parcial';

  return {
    periodo: payload.periodo, cliente: payload.cliente,
    fonte: payload.motor?.origemPrincipal || payload.fonte || 'central_vendas_db',
    totalPedidos: orders.length, validos: validos.length, cancelProblema: cancelProblema.length,
    unidades, faturamento, ticket, comissao, custoTotal, impostoTotal, freteTotal,
    resultadoParcial, receitaBloqueada, confianca,
  };
}

function buildFechamentoComponentes(payload, quick = 'todos') {
  const r = buildFechamentoResumo(payload, quick);
  const orders = fechamentoOrdersFiltered(payload, quick);
  const validos = orders.filter(o => o.status !== 'cancelado');
  const semCusto = validos.filter(o => o.mlb && o.custoStatus === 'ausente').length;
  const semFrete = validos.filter(o => o.frete == null).length;
  return [
    { comp:'Receita de produtos', op:'+', valor: r.faturamento,
      status: r.faturamento > 0 ? 'real' : 'ausente', fonte:'orders_api', obs:'soma do valor dos pedidos válidos' },
    { comp:'Tarifa marketplace', op:'−', valor: r.comissao == null ? null : -r.comissao,
      status: r.comissao == null ? 'ausente' : 'real', fonte:'orders_api', obs:'comissão (sale_fee) dos pedidos' },
    { comp:'Custo dos produtos', op:'−', valor: r.custoTotal == null ? null : -r.custoTotal,
      status: r.custoTotal == null ? 'ausente' : (semCusto > 0 ? 'parcial' : 'real'), fonte:'base vinculada',
      obs: semCusto > 0 ? `${num(semCusto)} pedido(s) sem custo na base` : 'custo unitário × unidades' },
    { comp:'Imposto interno', op:'−', valor: r.impostoTotal == null ? null : -r.impostoTotal,
      status: r.impostoTotal == null ? 'ausente' : (semCusto > 0 ? 'parcial' : 'real'), fonte:'cálculo interno',
      obs:'imposto % da base × receita' },
    { comp:'Frete seller', op:'−', valor: r.freteTotal == null ? null : -r.freteTotal,
      status: r.freteTotal == null ? 'ausente' : (semFrete > 0 ? 'parcial' : 'real'),
      fonte: r.freteTotal == null ? 'pendente' : 'shipments_api',
      obs: r.freteTotal == null
        ? 'nenhum envio retornou custo (shipments API)'
        : (semFrete > 0 ? `${num(semFrete)} pedido(s) sem frete real` : 'custo do envio (base_cost)') },
    { comp:'Resultado parcial', op:'=', valor: r.resultadoParcial,
      status: r.resultadoParcial == null ? 'ausente' : (r.confianca === 'confiavel' ? 'real' : 'parcial'), fonte:'cálculo interno',
      obs: r.confianca === 'confiavel' ? 'todos os componentes reais' : (semFrete > 0 || r.freteTotal == null ? 'parcial — frete incompleto' : 'parcial — falta custo em parte') },
  ];
}

function buildFechamentoQualidade(payload, quick = 'todos') {
  const orders = fechamentoOrdersFiltered(payload, quick);
  const validos = orders.filter(o => o.status !== 'cancelado');
  const faturamento = fechSum(validos, o => o.valor);
  const fatComCusto = fechSum(validos.filter(o => o.custo != null), o => o.valor);
  const fatComFrete = fechSum(validos.filter(o => o.frete != null), o => o.valor);
  const fatBloqueado = fechSum(validos.filter(o => o.resultadoStatus === 'bloqueado'), o => o.valor);
  return {
    semCusto: validos.filter(o => o.mlb && o.custoStatus === 'ausente').length,
    semFrete: validos.filter(o => o.frete == null).length,
    cancelProblema: orders.filter(o => o.status === 'cancelado' || o.status === 'com_problema').length,
    comResultado: validos.filter(o => o.resultado != null).length,
    bloqueados: validos.filter(o => o.resultadoStatus === 'bloqueado').length,
    pctFatComCusto: faturamento > 0 ? round2(fatComCusto / faturamento * 100) : null,
    pctFatComFrete: faturamento > 0 ? round2(fatComFrete / faturamento * 100) : null,
    pctFatBloqueado: faturamento > 0 ? round2(fatBloqueado / faturamento * 100) : null,
  };
}

function buildFechamentoPorDia(payload, quick = 'todos') {
  const orders = fechamentoOrdersFiltered(payload, quick);
  const map = new Map();
  for (const o of orders) {
    if (!o.data) continue;
    if (!map.has(o.data)) map.set(o.data, { data:o.data, pedidos:0, faturamento:0, comissao:0, custo:0, imposto:0, receitaBloqueada:0, cancelProblema:0, semFrete:0, semCusto:0, _comissao:false, _custo:false, _imposto:false });
    const d = map.get(o.data);
    const valido = o.status !== 'cancelado';
    d.pedidos += 1;
    if (valido) {
      d.faturamento += (o.valor || 0);
      if (o.taxas != null) { d.comissao += o.taxas; d._comissao = true; }
      if (o.custo != null) { d.custo += o.custo; d._custo = true; }
      if (o.imposto != null) { d.imposto += o.imposto; d._imposto = true; }
      if (o.frete == null) d.semFrete += 1;
      if (o.mlb && o.custoStatus === 'ausente') d.semCusto += 1;
    }
    if (o.resultadoStatus === 'bloqueado' && valido) d.receitaBloqueada += (o.valor || 0);
    if (o.status === 'cancelado' || o.status === 'com_problema') d.cancelProblema += 1;
  }
  return [...map.values()].map(d => ({
    data: d.data, pedidos: d.pedidos,
    faturamento: round2(d.faturamento),
    comissao: d._comissao ? round2(d.comissao) : null,
    custo: d._custo ? round2(d.custo) : null,
    imposto: d._imposto ? round2(d.imposto) : null,
    receitaBloqueada: round2(d.receitaBloqueada),
    cancelProblema: d.cancelProblema,
    semFrete: d.semFrete, semCusto: d.semCusto,
  }));
}

const FECH_DAILY_SORTS = [
  ['data', 'Data'], ['faturamento', 'Maior faturamento'], ['pedidos', 'Mais pedidos'],
  ['cancelProblema', 'Mais cancelados/problema'], ['receitaBloqueada', 'Maior receita bloqueada'],
  ['semFrete', 'Mais sem frete'], ['semCusto', 'Mais sem custo'],
];
function sortDias(dias, key) {
  const a = dias.slice();
  if (key === 'data') a.sort((x, y) => x.data.localeCompare(y.data));
  else a.sort((x, y) => (y[key] || 0) - (x[key] || 0) || x.data.localeCompare(y.data));
  return a;
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
    // Catálogo do payload carregado (a V1 lia direto de MOCK_PRODUTOS e o
    // "top do dia" sumia com dados reais; no mock o objeto é o mesmo).
    const prod = top ? (F.rawPayload?.produtos || {})[top] || null : null;
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
    ...F.orders.filters,
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
/* 'selected' = dia exato do filtro · 'scope' = dentro do recorte ativo. */
function dayScope(data) {
  const fl = F.orders.filters;
  if (fl.modo === 'dia') return fl.dia === data ? 'selected' : '';
  if (fl.modo === 'intervalo' && fl.de && fl.de === fl.ate) return fl.de === data ? 'selected' : '';
  if (fl.modo === 'semana' && fl.semana) return getWeekOfMonth({ data }) === Number(fl.semana) ? 'scope' : '';
  if (fl.modo === 'intervalo' && (fl.de || fl.ate)) return (!fl.de || data >= fl.de) && (!fl.ate || data <= fl.ate) ? 'scope' : '';
  if (fl.modo === 'ultimos7') {
    const r = getLast7Range(F.rawPayload.periodo);
    return data >= r.de && data <= r.ate ? 'scope' : '';
  }
  return '';
}

/* ── CARREGAMENTO ─────────────────────────────────────────── */
// Mock só é usado se explicitamente ligado neste navegador (nunca automático
// após erro real de backend): localStorage.setItem('vf-fapi-mock-dev','1').
function mockModeDevAtivo() {
  try { return localStorage.getItem('vf-fapi-mock-dev') === '1'; }
  catch (_) { return false; }
}
function buildMockPayload(slug) {
  const cli = F.clientes.find(c => c.slug === slug) || mockFechamentoApiPayload.cliente;
  const comp = MOCK_COMPETENCIAS[0];
  const p = JSON.parse(JSON.stringify(mockFechamentoApiPayload));
  p.cliente = { id:cli.id, nome:cli.nome, slug:cli.slug };
  p.periodo = { competencia:comp.competencia, inicio:comp.inicio, fim:comp.fim, label:comp.label };
  return p;
}
async function lerRespostaErro(res) {
  try {
    const data = await res.json();
    return data?.erro || data?.message || data?.error || JSON.stringify(data);
  } catch (_) {
    try { return await res.text(); } catch (_) { return ''; }
  }
}
const HTTP_ERRO_MSG = {
  401: 'Sessão expirada. Faça login novamente.',
  403: 'Você não tem permissão para acessar estes dados.',
};
async function carregarPayload(slug, dateFrom, dateTo, signal) {
  if (!slug) return null;

  let res;
  try {
    res = await fetch(
      `${API_BASE}/operacao/central-vendas/${encodeURIComponent(slug)}?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`,
      { headers: { Authorization: "Bearer " + TOKEN }, signal }
    );
  } catch (err) {
    if (err?.name === 'AbortError') return null; // cancelado por troca de cliente/período — silencioso
    console.error('[fechamentos-api] falha de rede ao carregar a Central de Vendas:', err);
    if (mockModeDevAtivo()) return buildMockPayload(slug);
    return { ok:false, erro:'Falha de conexão com o servidor.', erroTipo:'rede' };
  }

  if (!res.ok) {
    const corpo = await lerRespostaErro(res);
    const mensagem = HTTP_ERRO_MSG[res.status] || corpo || `Erro ${res.status} ao carregar a Central de Vendas.`;
    console.error(`[fechamentos-api] HTTP ${res.status} em /operacao/central-vendas/${slug}:`, corpo);
    if (mockModeDevAtivo()) return buildMockPayload(slug);
    return { ok:false, erro:mensagem, erroTipo:'http', httpStatus:res.status };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    console.error('[fechamentos-api] resposta inválida (JSON) da Central de Vendas:', err);
    if (mockModeDevAtivo()) return buildMockPayload(slug);
    return { ok:false, erro:'Resposta inválida do servidor.', erroTipo:'json_invalido' };
  }

  if (!data || data.ok !== true) {
    console.error('[fechamentos-api] payload com ok !== true da Central de Vendas:', data);
    if (mockModeDevAtivo()) return buildMockPayload(slug);
    return { ok:false, erro: data?.erro || 'Backend retornou um payload inválido.', erroTipo:'payload_invalido' };
  }

  // Período sem pedidos é resposta VÁLIDA (mostra estado vazio honesto, não mock).
  return data;
}

/* ── INIT ─────────────────────────────────────────────────── */
function isAdminUser() {
  try { return (JSON.parse(localStorage.getItem('vf-user') || '{}').role) === 'admin'; }
  catch (_) { return false; }
}

async function initFechamentosApi() {
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
  }
  // Período de análise. Default: mês atual.
  const periodSel = document.getElementById('fapi-period-select');
  if (periodSel) {
    periodSel.innerHTML = PERIOD_OPTS.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    F.periodo = computePeriodo('mes_atual');
    periodSel.value = 'mes_atual';
  }

  // Ações administrativas só para admin (leitura fica para todos).
  if (isAdminUser()) {
    document.getElementById('fapi-sync-btn')?.removeAttribute('hidden');
    document.getElementById('fapi-import-toggle')?.removeAttribute('hidden');
  }

  // Aba inicial via hash opcional (#visao-geral / #pedidos / #produtos).
  const hashTab = { '#visao-geral':'visao', '#pedidos':'pedidos', '#produtos':'produtos' }[window.location.hash];
  if (hashTab) F.ui.activeTab = hashTab;

  wireStatic();
  carregarTela();
}

/* Troca de período de análise. "Personalizado" só mostra os inputs; aplica no
   botão "Aplicar". Os demais modos carregam dados uma vez. */
function onPeriodChange() {
  const periodSel = document.getElementById('fapi-period-select');
  const custom = document.getElementById('fapi-period-custom');
  const mode = periodSel?.value || 'mes_atual';
  if (mode === 'personalizado') {
    if (custom) custom.hidden = false;
    const from = document.getElementById('fapi-period-from');
    const to = document.getElementById('fapi-period-to');
    if (from && !from.value) from.value = F.periodo?.dateFrom || '';
    if (to && !to.value) to.value = F.periodo?.dateTo || '';
    return; // espera "Aplicar"
  }
  if (custom) custom.hidden = true;
  F.periodo = computePeriodo(mode);
  closeOrderDrawer({ restoreFocus: false });
  resetFilters();
  carregarTela();
}
function aplicarPeriodoCustom() {
  const from = document.getElementById('fapi-period-from')?.value;
  const to = document.getElementById('fapi-period-to')?.value;
  if (!from || !to) { setActionStatus('Informe data inicial e final.', 'warning'); return; }
  F.periodo = computePeriodo('personalizado', from, to);
  closeOrderDrawer({ restoreFocus: false });
  resetFilters();
  carregarTela();
}
function resetFilters() {
  F.orders.filters = defaultFilters();
  F.orders.quickFilter = 'todos';
  F.orders.search = '';
  F.orders.sort = 'data_desc';
  F.orders.page = 1;
  F.ui.filtersPanelOpen = false;
  F.summary.quickFilter = 'todos';
  F.summary.dailySort = 'data';
  resetCurvaAbcState();
}

/* ÚNICO ponto de fetch. Só deve ser chamado em: init, troca de cliente/
   período, "Atualizar leitura" e depois de importar/sincronizar.
   Filtros/busca/paginação/aba NÃO passam por aqui — renders locais.
   Guard de concorrência (loadSeq) + AbortController ignoram resposta antiga. */
async function carregarTela() {
  if (!F.cliente) {
    F.rawPayload = null; F.viewPayload = null; F.visiblePayload = null;
    F.loading = false;
    renderAll();
    return;
  }

  if (!F.periodo) F.periodo = computePeriodo('mes_atual');
  const seq = ++F.loadSeq;
  if (F.loadAbort) { try { F.loadAbort.abort(); } catch (_) {} }
  F.loadAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;

  F.loading = true;
  renderAll();

  const payload = await carregarPayload(F.cliente.slug, F.periodo.dateFrom, F.periodo.dateTo, F.loadAbort?.signal);
  if (seq !== F.loadSeq) return; // resposta de um carregamento mais antigo — ignora

  F.loading = false;
  F.rawPayload = payload;
  if (!F.rawPayload?.ok) {
    renderAll();
    return;
  }

  F.orders.filters = sanitizeFilters(F.orders.filters, F.rawPayload);
  F.orders.page = 1;
  recomputeView();
  renderAll();
}

/* Aplica filtros sobre F.rawPayload em memória — SEM fetch. Recalcula uma vez. */
function recomputeView() {
  F.viewPayload = F.rawPayload ? applyFilters(F.rawPayload, F.orders.filters) : null;
}

/* Recortes rápidos (chips). Tudo local sobre o pedido. */
const QUICK_FILTERS = [
  ['todos', 'Todos'], ['sem_custo', 'Sem custo'], ['sem_frete', 'Sem frete'],
  ['frete_real', 'Com frete real'], ['calculavel', 'Resultado calculável'],
  ['bloqueados', 'Bloqueados'], ['receita_bloqueada', 'Receita bloqueada'],
  ['cancel_problema', 'Cancelados/problema'], ['full', 'Full'], ['normal', 'Normal'],
];
/* Chips expostos na linha principal; os demais ficam no painel "Filtros". */
const QUICK_PRIMARY = ['todos', 'sem_custo', 'sem_frete', 'bloqueados', 'cancel_problema', 'full'];
function pedidoMatchesQuick(o, q) {
  switch (q) {
    case 'sem_custo':         return !!o.mlb && o.custoStatus === 'ausente';
    case 'sem_frete':         return o.status !== 'cancelado' && o.frete == null;
    case 'frete_real':        return o.frete != null;
    case 'calculavel':        return o.resultado != null;
    case 'bloqueados':        return o.resultadoStatus === 'bloqueado' && o.status !== 'cancelado';
    case 'receita_bloqueada': return o.resultadoStatus === 'bloqueado' && o.status !== 'cancelado';
    case 'cancel_problema':   return o.status === 'cancelado' || o.status === 'com_problema';
    case 'full':              return o.full === true;
    case 'normal':            return o.full !== true;
    default:                  return true;
  }
}

/* Ordenações locais da tabela de pedidos. */
const ORDER_SORTS = [
  ['data_desc', 'Data (mais recente)'], ['data_asc', 'Data (mais antiga)'],
  ['fat_desc', 'Maior faturamento'], ['fat_asc', 'Menor faturamento'],
  ['comissao_desc', 'Maior comissão'], ['frete_desc', 'Maior frete'],
  ['custo_desc', 'Maior custo'], ['resultado_desc', 'Maior resultado'],
  ['bloqueada_desc', 'Maior receita bloqueada'], ['confianca', 'Confiança (pior 1º)'],
];
const CONF_RANK = { bloqueado: 0, insuficiente: 0, parcial: 1, estimado: 2, real: 3, confiavel: 3 };
function sortPedidos(arr, key) {
  const a = arr.slice();
  const desc = f => (x, y) => { const vx = f(x), vy = f(y); return (vy == null ? -Infinity : vy) - (vx == null ? -Infinity : vx); };
  const asc  = f => (x, y) => { const vx = f(x), vy = f(y); return (vx == null ? Infinity : vx) - (vy == null ? Infinity : vy); };
  switch (key) {
    case 'data_asc':       a.sort((x, y) => String(x.data || '').localeCompare(String(y.data || '')) || String(x.id).localeCompare(String(y.id))); break;
    case 'fat_desc':       a.sort(desc(o => o.valor)); break;
    case 'fat_asc':        a.sort(asc(o => o.valor)); break;
    case 'comissao_desc':  a.sort(desc(o => o.taxas)); break;
    case 'frete_desc':     a.sort(desc(o => o.frete)); break;
    case 'custo_desc':     a.sort(desc(o => o.custo)); break;
    case 'resultado_desc': a.sort(desc(o => o.resultado)); break;
    case 'bloqueada_desc': a.sort(desc(o => (o.resultadoStatus === 'bloqueado' && o.status !== 'cancelado') ? (o.valor || 0) : null)); break;
    case 'confianca':      a.sort((x, y) => (CONF_RANK[x.confianca] ?? 9) - (CONF_RANK[y.confianca] ?? 9)); break;
    default:               a.sort((x, y) => String(y.data || '').localeCompare(String(x.data || '')) || String(y.id).localeCompare(String(x.id))); break;
  }
  return a;
}
/* Estado da linha (filete à esquerda + classes de leitura). */
function pedidoRowClass(o) {
  if (o.status === 'cancelado') return ' is-cancel';
  if (o.status === 'com_problema') return ' is-problem';
  if (o.resultadoStatus === 'bloqueado') return ' is-blocked';
  if (o.mlb && o.custoStatus === 'ausente') return ' is-nocost';
  if (o.frete == null) return ' is-nofreight';
  return '';
}

const STATUS_PEDIDO = { pago:['is-success','Pago'], cancelado:['is-danger','Cancelado'], com_problema:['is-warning','Problema'], pendente:['is-warning','Pendente'] };

/* Pedidos filtrados (recorte rápido + busca). Ordenação/paginação ficam na tabela. */
function pedidoMatchesSearch(o, term) {
  return String(o.id || '').toLowerCase().includes(term) ||
    String(o.produto?.mlb || o.mlb || '').toLowerCase().includes(term) ||
    String(o.produto?.sku || o.sku || '').toLowerCase().includes(term) ||
    String(o.produto?.titulo || '').toLowerCase().includes(term) ||
    String(o.status || '').toLowerCase().includes(term) ||
    String((STATUS_PEDIDO[o.status] || [])[1] || '').toLowerCase().includes(term) ||
    (o.full === true ? 'full' : 'normal').includes(term) ||
    String(o.logistica || '').toLowerCase().includes(term);
}
function getSearchedPedidos() {
  let pedidos = F.viewPayload?.pedidos || [];
  const term = String(F.orders.search || '').trim().toLowerCase();
  if (term) pedidos = pedidos.filter(o => pedidoMatchesSearch(o, term));
  return pedidos;
}
function getVisiblePedidos() {
  let pedidos = getSearchedPedidos();
  if (F.orders.quickFilter && F.orders.quickFilter !== 'todos') pedidos = pedidos.filter(o => pedidoMatchesQuick(o, F.orders.quickFilter));
  return pedidos;
}

/* ── RENDER GERAL (sem fetch) ─────────────────────────────── */
const TAB_KEYS = ['visao', 'pedidos', 'produtos'];
const TAB_HASH = { visao:'#visao-geral', pedidos:'#pedidos', produtos:'#produtos' };

function renderAll() {
  renderContextStatus();

  const stateHost = document.getElementById('fapi-state-host');
  const tabs = document.getElementById('fapi-tabs');
  const panels = TAB_KEYS.map(k => document.getElementById(`fapi-panel-${k}`)).filter(Boolean);
  const showPanels = show => {
    if (tabs) tabs.hidden = !show;
    panels.forEach(p => { p.hidden = true; });
    if (!show) return;
  };

  // 1) Sem cliente selecionado
  if (!F.cliente) {
    showPanels(false);
    stateHost.hidden = false;
    stateHost.innerHTML = emptyState({
      icon:'target', title:'Selecione um cliente para abrir a Central de Vendas',
      why:'O fechamento por pedido é sempre por cliente e por período de análise.',
      next:'Escolha um cliente e o período na barra acima.',
    });
    return;
  }

  // 2) Carregando
  if (F.loading) {
    showPanels(false);
    stateHost.hidden = false;
    stateHost.innerHTML = loadingState();
    return;
  }

  // 3) Backend indisponível ou retornou erro real (sem payload válido)
  if (!F.rawPayload?.ok) {
    showPanels(false);
    stateHost.hidden = false;
    stateHost.innerHTML = emptyState({
      icon:'plug', tone:'is-danger', title:'Motor indisponível',
      why: F.rawPayload?.erro || 'O backend do motor não respondeu para este cliente/período.',
      next:'Tente novamente em instantes ou use "Atualizar leitura".',
    });
    return;
  }

  // 4) Dados carregados — abas + painéis
  stateHost.hidden = true;
  stateHost.innerHTML = '';
  if (tabs) tabs.hidden = false;
  renderTabCounts();
  F.visiblePayload = { ...F.viewPayload, pedidos: getVisiblePedidos() };
  renderFechamentoSection();
  renderDaysSection();
  renderOrdersPanel();
  renderAbc();
  setActiveTab(F.ui.activeTab, { updateHash: false, focus: false });
}

/* Estados do motor → componentes semânticos (barra de contexto). */
const MOTOR = {
  mock:         ['is-info',    'Mock — dados simulados'],
  parcial:      ['is-warning', 'Parcial'],
  api:          ['is-success', 'API conectada'],
  persistido:   ['is-success', 'API conectada'],
  indisponivel: ['is-danger',  'Indisponível'],
  sem_dados:    ['is-neutral', 'Sem dados no período'],
};
const ORIGEM_LBL = {
  orders_api: 'Orders API',
  planilha_vendas: 'Planilha de vendas',
  central_vendas_db: 'Banco Central de Vendas',
  mock_conciliacao_fechamento_api: 'Simulação local',
};
function renderContextStatus() {
  const host = document.getElementById('fapi-context-status');
  const mockBanner = document.getElementById('fapi-mock-banner');
  if (!host) return;

  const item = (label, html) => `<span class="vf-fapi-context__status-item"><span class="vf-fapi-context__status-label">${esc(label)}</span> ${html}</span>`;

  if (!F.cliente) {
    if (mockBanner) mockBanner.hidden = true;
    host.innerHTML = item('Motor', '<span class="vf-status is-neutral">Aguardando cliente</span>');
    return;
  }
  if (F.loading) {
    if (mockBanner) mockBanner.hidden = true;
    host.innerHTML = item('Motor', '<span class="vf-status is-neutral">Carregando…</span>');
    return;
  }

  const p = F.rawPayload;
  const motorStatus = p?.ok ? (p.motor?.status || 'indisponivel') : 'indisponivel';
  const [cls, label] = MOTOR[motorStatus] || MOTOR.indisponivel;
  const isMock = motorStatus === 'mock';
  if (mockBanner) mockBanner.hidden = !isMock;

  const parts = [item('Motor', `<span class="vf-status ${cls}">${esc(label)}</span>`)];
  if (p?.ok) {
    if (p.motor?.confianca && p.motor.confianca !== 'ausente') parts.push(item('Confiança', confStatus(p.motor.confianca)));
    const origem = p.motor?.origemPrincipal || p.fonte;
    if (origem) parts.push(item('Origem', `<b>${esc(ORIGEM_LBL[origem] || origem)}</b>`));
    if (p.motor?.geradoEm) parts.push(item('Gerado em', `<b>${esc(fmtDtHr(p.motor.geradoEm))}</b>`));
    if (p.motor?.importId != null) parts.push(item('Import', `<span class="vf-mono">#${esc(p.motor.importId)}</span>`));
    if (p.periodo?.label) parts.push(item('Intervalo', `<b>${esc(p.periodo.label)}</b>`));
    if (F.lastSyncBase?.nome) parts.push(item('Base vinculada', `<b>${esc(F.lastSyncBase.nome)}</b>`));
  }
  host.innerHTML = parts.join('');
}

function renderTabCounts() {
  const pedidos = fechamentoOrders(F.rawPayload);
  const produtos = new Set(pedidos.filter(o => o.mlb).map(o => o.mlb)).size;
  const pc = document.getElementById('fapi-tab-pedidos-count');
  const gc = document.getElementById('fapi-tab-produtos-count');
  if (pc) { pc.hidden = !pedidos.length; pc.textContent = num(pedidos.length); }
  if (gc) { gc.hidden = !produtos; gc.textContent = num(produtos); }
}

/* Troca de aba: só visibilidade — NUNCA dispara fetch nem re-render. */
function setActiveTab(key, { updateHash = true, focus = false } = {}) {
  if (!TAB_KEYS.includes(key)) key = 'visao';
  F.ui.activeTab = key;
  for (const k of TAB_KEYS) {
    const tab = document.getElementById(`fapi-tab-${k}`);
    const panel = document.getElementById(`fapi-panel-${k}`);
    const active = k === key;
    if (tab) {
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.setAttribute('tabindex', active ? '0' : '-1');
      if (active && focus) tab.focus();
    }
    if (panel) panel.hidden = !active;
  }
  if (updateHash && TAB_HASH[key]) {
    try { history.replaceState(null, '', TAB_HASH[key]); } catch (_) {}
  }
}
function onTablistKeydown(e) {
  const idx = TAB_KEYS.indexOf(F.ui.activeTab);
  let next = null;
  if (e.key === 'ArrowRight') next = TAB_KEYS[(idx + 1) % TAB_KEYS.length];
  else if (e.key === 'ArrowLeft') next = TAB_KEYS[(idx - 1 + TAB_KEYS.length) % TAB_KEYS.length];
  else if (e.key === 'Home') next = TAB_KEYS[0];
  else if (e.key === 'End') next = TAB_KEYS[TAB_KEYS.length - 1];
  if (next) { e.preventDefault(); setActiveTab(next, { focus: true }); }
}

/* ── ABA 1 · VISÃO GERAL — Fechamento (KPIs, composição, qualidade) ──
   Recorte próprio (F.summary.quickFilter) filtra SÓ este bloco —
   não toca a tabela de pedidos nem a Curva ABC. */
const FECH_QUICKS = [
  ['todos', 'Todos'], ['sem_custo', 'Sem custo'], ['sem_frete', 'Sem frete'],
  ['bloqueados', 'Bloqueados'], ['calculavel', 'Calculáveis'],
];

function kpiValueHtml(v, { currency = false } = {}) {
  if (v === null || v === undefined) return '<span class="vf-kpi__value">—</span>';
  if (!currency) return `<span class="vf-kpi__value">${num(v)}</span>`;
  return `<span class="vf-kpi__value vf-kpi__value--currency"><span class="vf-kpi__currency">R$</span><span>${num(v, 2)}</span></span>`;
}
function kpi({ label, valueHtml, foot = '', footTone = '', mod = '' }) {
  return `<div class="vf-kpi${mod ? ' ' + mod : ''}">
    <span class="vf-kpi__label">${esc(label)}</span>
    ${valueHtml}
    ${foot ? `<span class="vf-kpi__foot${footTone ? ' ' + footTone : ''}">${esc(foot)}</span>` : ''}
  </div>`;
}
function secondaryMetric(label, valueHtml, hint = '', muted = false) {
  return `<div class="vf-fapi-secondary-metrics__item"${hint ? ` title="${esc(hint)}"` : ''}>
    <span class="vf-fapi-secondary-metrics__label">${esc(label)}</span>
    <span class="vf-fapi-secondary-metrics__value${muted ? ' is-muted' : ''}">${valueHtml}</span>
  </div>`;
}

function renderFechamentoSection() {
  const host = document.getElementById('fapi-fech-host');
  const payload = F.rawPayload;
  if (!host || !payload?.ok) return;

  const rAll = buildFechamentoResumo(payload, 'todos');
  const fonteTxt = (rAll.fonte === 'orders_api') ? 'orders_api · central_vendas_db' : esc(rAll.fonte);
  const headerMeta = `${esc(payload.periodo?.label || '')} · ${esc(payload.cliente?.nome || '')} · fonte: ${fonteTxt}`;

  if (!rAll.totalPedidos) {
    const syncBtn = isAdminUser()
      ? '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-action="sync-empty">Sincronizar via API</button>' : '';
    host.innerHTML = `
      <section class="vf-section" aria-label="Fechamento do período">
        <div class="vf-section__header">
          <div>
            <h2 class="vf-section__title">Fechamento do período</h2>
            <p class="vf-section__description">${headerMeta}</p>
          </div>
        </div>
        <div class="vf-card"><div class="vf-card__body">${emptyState({
          icon:'doc', title:'Sem pedidos no período',
          why:'Nada sincronizado para fechar neste intervalo.',
          next:'Use "Sincronizar via API" para trazer os pedidos do Mercado Livre.',
          action: syncBtn,
        })}</div></div>
      </section>`;
    return;
  }

  const quick = F.summary.quickFilter;
  const r = buildFechamentoResumo(payload, quick);
  const chips = FECH_QUICKS.map(([k, l]) => {
    const count = k === 'todos' ? rAll.totalPedidos : fechamentoOrdersFiltered(payload, k).length;
    return `<button type="button" class="vf-filter-chip${quick === k ? ' is-active' : ''}" data-fechq="${k}" aria-pressed="${quick === k}">${esc(l)} <span class="vf-badge">${num(count)}</span></button>`;
  }).join('');
  const clearBtn = quick !== 'todos'
    ? '<button type="button" class="vf-clear-filters" data-fechq="todos">Limpar recorte</button>' : '';
  const recorteBar = `<div class="vf-fapi-fech-chips" role="group" aria-label="Recorte do fechamento">${chips}${clearBtn}</div>`;

  let corpo;
  if (!r.totalPedidos) {
    corpo = `<div class="vf-card"><div class="vf-card__body">${emptyState({
      icon:'dot', title:'Nenhum pedido neste recorte',
      why:'O recorte selecionado não tem pedidos.',
      next:'Volte para "Todos".',
    })}</div></div>`;
  } else {
    const parcialFoot = r.confianca === 'confiavel' ? 'todos componentes reais' : 'parcial';
    const kpis = `<div class="vf-kpi-grid" role="list" aria-label="Indicadores principais do fechamento">
      ${kpi({ label:'Faturamento bruto', valueHtml: kpiValueHtml(r.faturamento, { currency:true }), foot:'pedidos válidos', mod:'vf-kpi--featured' })}
      ${kpi({ label:'Resultado parcial', valueHtml: kpiValueHtml(r.resultadoParcial, { currency:true }), foot: parcialFoot, footTone: r.confianca === 'confiavel' ? 'is-success' : 'is-warning', mod: r.confianca === 'confiavel' ? '' : 'vf-kpi--warning' })}
      ${kpi({ label:'Receita bloqueada', valueHtml: kpiValueHtml(r.receitaBloqueada, { currency:true }), foot:'falta custo/frete p/ calcular', footTone: r.receitaBloqueada > 0 ? 'is-warning' : '', mod: r.receitaBloqueada > 0 ? 'vf-kpi--warning' : '' })}
      ${kpi({ label:'Pedidos válidos', valueHtml: kpiValueHtml(r.validos), foot:'pagos + problema' })}
      ${kpi({ label:'Cancelados / problema', valueHtml: kpiValueHtml(r.cancelProblema), foot:'fora da venda boa', footTone: r.cancelProblema > 0 ? 'is-danger' : '', mod: r.cancelProblema > 0 ? 'vf-kpi--danger' : '' })}
      ${kpi({ label:'Unidades vendidas', valueHtml: kpiValueHtml(r.unidades), foot:'itens válidos' })}
    </div>`;

    const secundarios = `<div class="vf-fapi-secondary-metrics" aria-label="Métricas secundárias do fechamento">
      ${secondaryMetric('Total de pedidos', valOr(r.totalPedidos), 'no período')}
      ${secondaryMetric('Ticket médio', valOr(r.ticket, money), 'por pedido válido')}
      ${secondaryMetric('Comissão marketplace', valOr(r.comissao, money), 'tarifa ML (sale_fee)')}
      ${secondaryMetric('Custo dos produtos', valOr(r.custoTotal, money), 'base vinculada')}
      ${secondaryMetric('Imposto interno', valOr(r.impostoTotal, money), 'cálculo interno')}
      ${secondaryMetric('Frete seller', valOr(r.freteTotal, money), r.freteTotal == null ? 'ausente (shipments)' : 'real (shipments API)', r.freteTotal == null)}
    </div>`;

    // Composição do resultado
    const comps = buildFechamentoComponentes(payload, quick);
    const compRows = comps.map(c => `
      <tr${c.comp === 'Resultado parcial' ? ' class="vf-fapi-total-row"' : ''}>
        <td>${esc(c.comp)}</td>
        <td class="vf-fapi-op" aria-hidden="true">${esc(c.op)}</td>
        <td class="num">${c.valor == null ? '<span class="is-absent">—</span>' : (c.comp === 'Resultado parcial' && c.status !== 'real' ? `<span class="vf-fapi-est">${money(c.valor)}</span>` : money(c.valor))}</td>
        <td>${statusTag(c.status)}</td>
        <td class="vf-fapi-fonte">${esc(c.fonte)}</td>
        <td class="vf-fapi-obs vf-truncate" title="${esc(c.obs)}">${esc(c.obs)}</td>
      </tr>`).join('');
    const composicao = `
      <div class="vf-card vf-card--compact vf-fapi-composition">
        <div class="vf-card__header"><h3 class="vf-card__title">Composição do resultado</h3></div>
        <div class="vf-table-wrap">
          <table class="vf-table vf-table--compact">
            <thead><tr><th scope="col">Componente</th><th scope="col"><span class="vf-visually-hidden">Operação</span></th><th scope="col" class="num">Valor</th><th scope="col">Status</th><th scope="col">Fonte</th><th scope="col">Observação</th></tr></thead>
            <tbody>${compRows}</tbody>
          </table>
        </div>
      </div>`;

    // Qualidade do fechamento — lista compacta, exceções destacadas
    const q = buildFechamentoQualidade(payload, quick);
    const qRow = (lbl, val, cls) => `<div class="vf-fapi-quality__row"><span class="vf-fapi-quality__label">${esc(lbl)}</span><span class="vf-fapi-quality__value${cls ? ' ' + cls : ''}">${val}</span></div>`;
    const qualidade = `
      <div class="vf-card vf-card--compact vf-fapi-quality">
        <div class="vf-card__header"><h3 class="vf-card__title">Qualidade do fechamento</h3></div>
        <div class="vf-card__body">
          <div class="vf-fapi-quality__list">
            ${qRow('Pedidos sem custo', valOr(q.semCusto), q.semCusto ? 'is-danger' : '')}
            ${qRow('Pedidos sem frete', valOr(q.semFrete), q.semFrete ? 'is-warning' : '')}
            ${qRow('Com resultado calculável', valOr(q.comResultado))}
            ${qRow('Pedidos bloqueados', valOr(q.bloqueados), q.bloqueados ? 'is-danger' : '')}
            ${qRow('Cancelados/problema', valOr(q.cancelProblema))}
            ${qRow('% faturamento com custo', valOr(q.pctFatComCusto, pct))}
            ${qRow('% faturamento com frete real', valOr(q.pctFatComFrete, pct), (q.pctFatComFrete || 0) > 0 ? 'is-success' : '')}
            ${qRow('% faturamento bloqueado', valOr(q.pctFatBloqueado, pct), (q.pctFatBloqueado || 0) > 0 ? 'is-warning' : '')}
          </div>
        </div>
      </div>`;

    const nota = `<div class="vf-banner is-info vf-banner--compact" role="note">
      <div class="vf-banner__content"><p class="vf-banner__description">Fechamento do <strong>período inteiro</strong> (independe dos filtros da tabela de pedidos). O <strong>frete seller</strong> vem da Shipments API por pedido quando disponível; pedidos sem frete real mantêm o fechamento <strong>parcial</strong>. Ausência aparece como <strong>—</strong>, nunca R$ 0,00.</p></div>
    </div>`;

    corpo = `${kpis}${secundarios}<div class="vf-fapi-composition-grid">${composicao}${qualidade}</div>${nota}`;
  }

  host.innerHTML = `
    <section class="vf-section vf-fapi-overview" aria-label="Fechamento do período">
      <div class="vf-section__header">
        <div>
          <h2 class="vf-section__title">Fechamento do período</h2>
          <p class="vf-section__description">${headerMeta}</p>
        </div>
        <div class="vf-section__actions">
          <span class="vf-fapi-context__status-item"><span class="vf-fapi-context__status-label">Confiança</span> ${confStatus(r.totalPedidos ? r.confianca : rAll.confianca)}</span>
        </div>
      </div>
      ${recorteBar}
      ${corpo}
    </section>`;
}

/* ── ABA 1 · VISÃO GERAL — Vendas por dia (régua + tabela) ── */
function renderDaysSection() {
  const host = document.getElementById('fapi-days-host');
  if (!host || !F.rawPayload?.ok) return;
  const dias = buildDailyRulerRows();
  if (!dias.length) { host.innerHTML = ''; return; }

  const cells = dias.map(d => {
    const scope = dayScope(d.data);
    const cls = ['vf-fapi-day'];
    if (scope === 'selected') cls.push('is-selected');
    else if (scope === 'scope') cls.push('is-scope');
    if (d.pedidos === 0) cls.push('is-empty');
    const markers = [
      d.cancelProblema > 0 ? '<span class="vf-fapi-day__dot vf-fapi-day__dot--problem" aria-hidden="true"></span>' : '',
      d.receitaBloqueada > 0 ? '<span class="vf-fapi-day__dot vf-fapi-day__dot--blocked" aria-hidden="true"></span>' : '',
    ].join('');
    const tipParts = [`${fmtDt(d.data)}`, `${money(d.faturamento)}`, `${d.pedidos} pedido(s)`, `${d.unidades} unidade(s)`];
    if (d.cancelProblema > 0) tipParts.push(`${d.cancelProblema} com cancelamento/problema`);
    if (d.receitaBloqueada > 0) tipParts.push(`receita bloqueada ${money(d.receitaBloqueada)}`);
    if (d.topProduto) tipParts.push(`top: ${d.topProduto.titulo}`);
    const tip = tipParts.join(' · ');
    return `<button type="button" class="${cls.join(' ')}" data-day="${esc(d.data)}" title="${esc(tip)}" aria-label="Filtrar pedidos de ${esc(tip)}" aria-pressed="${scope === 'selected'}">
      <span class="vf-fapi-day__num">${esc(String(new Date(d.data + 'T00:00:00').getDate()).padStart(2, '0'))}</span>
      <span class="vf-fapi-day__value">${esc(shortMoney(d.faturamento))}</span>
      <span class="vf-fapi-day__orders">${esc(String(d.pedidos))} ped.</span>
      <span class="vf-fapi-day__markers">${markers}</span>
    </button>`;
  }).join('');

  // Tabela ordenável por dia (período inteiro, independe dos recortes)
  const tdias = sortDias(buildFechamentoPorDia(F.rawPayload, 'todos'), F.summary.dailySort);
  const dailySortOpts = FECH_DAILY_SORTS.map(([k, l]) => `<option value="${k}"${F.summary.dailySort === k ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const DAILY_SORT_COL = { data:['data','ascending'], faturamento:['faturamento','descending'], pedidos:['pedidos','descending'], cancelProblema:['cancelProblema','descending'], receitaBloqueada:['receitaBloqueada','descending'], semFrete:['semFrete','descending'], semCusto:['semCusto','descending'] };
  const dailyTh = (key, label, numCls) => {
    const s = DAILY_SORT_COL[F.summary.dailySort];
    const sorted = s && s[0] === key ? ` aria-sort="${s[1]}"` : '';
    return `<th scope="col"${numCls ? ' class="num"' : ''}${sorted}>${esc(label)}</th>`;
  };
  const diaRows = tdias.map(d => `
    <tr${dayScope(d.data) ? ' class="is-scope"' : ''} data-fechday="${esc(d.data)}" title="Filtrar pedidos de ${fmtDt(d.data)}" tabindex="0">
      <td>${fmtDt(d.data)}</td>
      <td class="num">${valOr(d.pedidos)}</td>
      <td class="num">${money(d.faturamento)}</td>
      <td class="num">${valOr(d.comissao, money)}</td>
      <td class="num">${valOr(d.custo, money)}</td>
      <td class="num">${valOr(d.imposto, money)}</td>
      <td class="num">${d.receitaBloqueada > 0 ? `<span class="vf-fapi-est">${money(d.receitaBloqueada)}</span>` : '—'}</td>
      <td class="num">${d.semFrete > 0 ? num(d.semFrete) : '—'}</td>
      <td class="num">${d.semCusto > 0 ? num(d.semCusto) : '—'}</td>
      <td class="num">${d.cancelProblema > 0 ? num(d.cancelProblema) : '—'}</td>
    </tr>`).join('');

  host.innerHTML = `
    <section class="vf-section vf-fapi-days" aria-label="Vendas por dia">
      <div class="vf-section__header">
        <div>
          <h2 class="vf-section__title">Vendas por dia</h2>
          <p class="vf-section__description">Clique num dia para filtrar a aba Pedidos · ponto âmbar = cancelamento/problema · ponto vermelho = receita bloqueada.</p>
        </div>
        <div class="vf-section__actions">
          <label class="vf-filter-group">
            <span class="vf-filter-group__label">Ordenar resumo por</span>
            <select class="vf-select vf-select--sm" id="fapi-daily-sort">${dailySortOpts}</select>
          </label>
        </div>
      </div>
      <div class="vf-fapi-days__strip-wrap" role="group" aria-label="Régua de dias do período">
        <div class="vf-fapi-days__strip">${cells}</div>
      </div>
      <div class="vf-table-wrap vf-fapi-days__table-wrap">
        <table class="vf-table vf-table--compact">
          <thead><tr>
            ${dailyTh('data', 'Data')}
            ${dailyTh('pedidos', 'Ped.', true)}
            ${dailyTh('faturamento', 'Faturamento', true)}
            <th scope="col" class="num">Comissão</th>
            <th scope="col" class="num">Custo</th>
            <th scope="col" class="num">Imposto</th>
            ${dailyTh('receitaBloqueada', 'Receita bloq.', true)}
            ${dailyTh('semFrete', 'S/frete', true)}
            ${dailyTh('semCusto', 'S/custo', true)}
            ${dailyTh('cancelProblema', 'Canc/Prob', true)}
          </tr></thead>
          <tbody>${diaRows}</tbody>
        </table>
      </div>
    </section>`;
}

/* ── ABA 2 · PEDIDOS — toolbar em duas camadas + tabela ─────
   A toolbar é renderizada por carga de dados; a tabela vive em
   #fapi-ped-table e re-renderiza sozinha (busca/recorte/ordenação/
   página) preservando o foco do campo de busca. */
function quickChipHtml(k, label, count, active) {
  return `<button type="button" class="vf-filter-chip${active ? ' is-active' : ''}" data-quick="${k}" aria-pressed="${active}">${esc(label)} <span class="vf-badge">${num(count)}</span></button>`;
}
function renderOrdersPanel() {
  const panel = document.getElementById('fapi-panel-pedidos');
  if (!panel || !F.rawPayload?.ok) return;
  const fl = F.orders.filters;
  const opt = (v, label, cur) => `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${esc(label)}</option>`;
  const selF = (id, key, labelTxt, opts) => `
    <div class="vf-field">
      <label class="vf-field__label" for="${id}">${esc(labelTxt)}</label>
      <select id="${id}" class="vf-select vf-select--sm" data-pedfilter="${key}">${opts}</select>
    </div>`;

  const base = getSearchedPedidos();
  const countBy = q => q === 'todos' ? base.length : base.filter(o => pedidoMatchesQuick(o, q)).length;
  const primary = QUICK_FILTERS.filter(([k]) => QUICK_PRIMARY.includes(k))
    .map(([k, l]) => quickChipHtml(k, l, countBy(k), F.orders.quickFilter === k)).join('');
  const extra = QUICK_FILTERS.filter(([k]) => !QUICK_PRIMARY.includes(k))
    .map(([k, l]) => quickChipHtml(k, l, countBy(k), F.orders.quickFilter === k)).join('');

  const sortOpts = ORDER_SORTS.map(([k, l]) => `<option value="${k}"${F.orders.sort === k ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const advCount = ['logistica', 'midia', 'diagbase', 'status'].filter(k => fl[k] !== 'todos').length;

  panel.innerHTML = `
    <section class="vf-section" aria-label="Pedidos do período">
      <div class="vf-section__header">
        <div>
          <h2 class="vf-section__title">Pedidos</h2>
          <p class="vf-section__description">Clique num pedido para abrir o extrato. Todos os filtros são locais — nenhuma nova busca no servidor.</p>
        </div>
      </div>

      <div class="vf-fapi-orders-toolbar">
        <div class="vf-fapi-orders-toolbar__main">
          <input type="search" id="fapi-search" class="vf-input vf-input--sm vf-search" placeholder="Buscar pedido, MLB, SKU, título, status…" value="${esc(F.orders.search || '')}" autocomplete="off" aria-label="Buscar pedidos">
          <label class="vf-fapi-orders-toolbar__sort">
            <span class="vf-filter-group__label">Ordenar por</span>
            <select class="vf-select vf-select--sm" id="fapi-order-sort">${sortOpts}</select>
          </label>
          <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" id="fapi-filters-toggle" aria-expanded="${F.ui.filtersPanelOpen}" aria-controls="fapi-filters-panel">Filtros${advCount ? ` <span class="vf-badge is-primary">${num(advCount)}</span>` : ''}</button>
          <span class="vf-fapi-orders-toolbar__count" id="fapi-orders-count" aria-live="polite"></span>
        </div>
        <div class="vf-fapi-orders-toolbar__chips" role="group" aria-label="Recortes rápidos">${primary}</div>
        <div class="vf-fapi-orders-filters" id="fapi-filters-panel"${F.ui.filtersPanelOpen ? '' : ' hidden'}>
          <div class="vf-fapi-orders-filters__grid">
            ${selF('fapi-filter-logistica', 'logistica', 'Logística', [opt('todos','Todas',fl.logistica), opt('full','Full',fl.logistica), opt('nao_full','Não Full',fl.logistica)].join(''))}
            ${selF('fapi-filter-midia', 'midia', 'Mídia', [opt('todos','Todas',fl.midia), opt('com_ads','Com Ads',fl.midia), opt('sem_ads','Sem Ads',fl.midia)].join(''))}
            ${selF('fapi-filter-diagbase', 'diagbase', 'Diagnóstico / base', [opt('todos','Todos',fl.diagbase), opt('com_custo','Com custo',fl.diagbase), opt('sem_custo','Sem custo',fl.diagbase), opt('no_diag','No diagnóstico',fl.diagbase), opt('fora_diag','Fora do diag.',fl.diagbase)].join(''))}
            ${selF('fapi-filter-status', 'status', 'Status do pedido', [opt('todos','Todos',fl.status), opt('valido','Válido',fl.status), opt('cancelado','Cancelado',fl.status), opt('problema','Problema',fl.status), opt('bloqueado','Bloqueado',fl.status)].join(''))}
          </div>
          <div class="vf-fapi-orders-toolbar__chips" role="group" aria-label="Recortes adicionais">${extra}</div>
        </div>
      </div>

      <div id="fapi-ped-table"></div>
    </section>`;
  renderPedTable();
}

/* Filtros ativos: chips removíveis (recorte + selects + dia + busca). */
const PEDFILTER_LBL = {
  logistica: { full:'Full', nao_full:'Não Full' },
  midia: { com_ads:'Com Ads', sem_ads:'Sem Ads' },
  diagbase: { com_custo:'Com custo', sem_custo:'Sem custo', no_diag:'No diagnóstico', fora_diag:'Fora do diag.' },
  status: { valido:'Válido', cancelado:'Cancelado', problema:'Problema', bloqueado:'Bloqueado' },
};
function buildActiveFilters() {
  const fl = F.orders.filters;
  const items = [];
  if (F.orders.quickFilter && F.orders.quickFilter !== 'todos') {
    const q = QUICK_FILTERS.find(c => c[0] === F.orders.quickFilter);
    if (q) items.push({ type:'quick', label:q[1] });
  }
  for (const key of ['logistica', 'midia', 'diagbase', 'status']) {
    if (fl[key] !== 'todos') items.push({ type:'pedfilter', key, label: PEDFILTER_LBL[key][fl[key]] || fl[key] });
  }
  if (fl.modo === 'intervalo' && (fl.de || fl.ate)) {
    items.push({ type:'dia', label: fl.de === fl.ate ? `Dia ${fmtDt(fl.de)}` : `${fmtDt(fl.de)} até ${fmtDt(fl.ate)}` });
  }
  const termo = String(F.orders.search || '').trim();
  if (termo) items.push({ type:'busca', label:`Busca "${termo}"` });
  return items;
}

/* Tabela + paginação + linha de filtros ativos (re-renderável isoladamente). */
function renderPedTable() {
  const host = document.getElementById('fapi-ped-table');
  if (!host) return;
  const all = getVisiblePedidos();
  const sorted = sortPedidos(all, F.orders.sort);
  const total = sorted.length;

  const countEl = document.getElementById('fapi-orders-count');
  if (countEl) countEl.textContent = `${num(total)} pedido(s) encontrados`;

  const ativos = buildActiveFilters();
  const activeLine = ativos.length ? `
    <div class="vf-active-filters" aria-label="Filtros ativos">
      <span class="vf-filter-group__label">Filtros ativos:</span>
      ${ativos.map(a => `
        <span class="vf-active-filter">${esc(a.label)}
          <button type="button" class="vf-active-filter__remove" data-remove-filter="${a.type}"${a.key ? ` data-remove-key="${a.key}"` : ''} aria-label="Remover filtro ${esc(a.label)}">✕</button>
        </span>`).join('')}
      <button type="button" class="vf-clear-filters" id="fapi-clear-local">Limpar tudo</button>
    </div>` : '';

  if (!total) {
    const buscando = String(F.orders.search || '').trim();
    host.innerHTML = `${activeLine}<div class="vf-card"><div class="vf-card__body">${emptyState({
      icon:'box',
      title: buscando ? 'Nenhum pedido para a busca' : 'Nenhum pedido neste recorte',
      why: buscando ? `Nada encontrado para "${buscando}".` : 'O recorte/filtros atuais não retornaram pedidos.',
      next:'Use "Limpar tudo" ou escolha "Todos" nos recortes.',
      action: ativos.length ? '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" id="fapi-clear-local-empty">Limpar tudo</button>' : '',
    })}</div></div>`;
    return;
  }

  const pageSize = F.orders.pageSize;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (F.orders.page > pages) F.orders.page = pages;
  if (F.orders.page < 1) F.orders.page = 1;
  const start = (F.orders.page - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  const rows = sorted.slice(start, end);

  const tr = rows.map(o => {
    const [scls, slbl] = STATUS_PEDIDO[o.status] || ['is-neutral', o.status];
    const res = o.resultado == null ? '—' : `<span class="vf-fapi-est">${money(o.resultado)}</span>`;
    const selected = F.ui.drawerOrderId === o.id;
    return `
      <tr class="${(pedidoRowClass(o) + (selected ? ' row--selected' : '')).trim()}" data-pedido="${esc(o.id)}" tabindex="0" aria-label="Abrir extrato do pedido ${esc(o.id)}">
        <td class="vf-mono">${esc(o.id)}</td>
        <td>${fmtDt(o.data)}</td>
        <td><span class="vf-tag ${scls}">${esc(slbl)}</span></td>
        <td class="vf-truncate" title="${esc(o.produto?.titulo || '—')}">${esc(o.produto?.titulo || '—')}</td>
        <td class="vf-mono">${esc(o.produto?.mlb || '—')}</td>
        <td class="vf-mono${o.produto?.sku ? '' : ' is-absent'}">${esc(o.produto?.sku || '—')}</td>
        <td>${tagFull(o.full)}</td>
        <td>${tagAds(o.adsStatus)}</td>
        <td class="num">${valOr(o.valor, money)}</td>
        <td class="num${o.frete == null ? ' is-absent' : ''}">${valOr(o.frete, money)}</td>
        <td class="num${o.taxas == null ? ' is-absent' : ''}">${valOr(o.taxas, money)}</td>
        <td class="num${o.custo == null ? ' is-absent' : ''}">${valOr(o.custo, money)}</td>
        <td class="num${o.resultado == null ? ' is-absent' : ''}">${res}</td>
        <td>${confStatus(o.confianca)}</td>
        <td class="vf-truncate is-absent" title="${esc(o.pendencias.length ? o.pendencias.join(' · ') : '—')}">${o.pendencias.length ? esc(o.pendencias[0]) : '—'}</td>
      </tr>`;
  }).join('');

  const SORT_COL = { data_desc:['data','descending'], data_asc:['data','ascending'], fat_desc:['valor','descending'], fat_asc:['valor','ascending'], comissao_desc:['taxas','descending'], frete_desc:['frete','descending'], custo_desc:['custo','descending'], resultado_desc:['resultado','descending'], confianca:['confianca','ascending'] };
  const th = (key, label, numCls) => {
    const s = SORT_COL[F.orders.sort];
    const sorted2 = s && s[0] === key ? ` aria-sort="${s[1]}"` : '';
    return `<th scope="col"${numCls ? ' class="num"' : ''}${sorted2}>${esc(label)}</th>`;
  };

  host.innerHTML = `${activeLine}
    <div class="vf-table-wrap vf-fapi-orders__table-wrap">
      <table class="vf-table vf-table--compact vf-fapi-orders__table" aria-label="Pedidos do período">
        <thead><tr>
          <th scope="col">Pedido</th>
          ${th('data', 'Data')}
          <th scope="col">Status</th>
          <th scope="col">Produto</th>
          <th scope="col">MLB</th>
          <th scope="col">SKU</th>
          <th scope="col">Full</th>
          <th scope="col">Ads</th>
          ${th('valor', 'Valor', true)}
          ${th('frete', 'Frete', true)}
          ${th('taxas', 'Taxas', true)}
          ${th('custo', 'Custo', true)}
          ${th('resultado', 'Resultado', true)}
          ${th('confianca', 'Confiança')}
          <th scope="col">Pendência</th>
        </tr></thead>
        <tbody>${tr}</tbody>
      </table>
    </div>
    <div class="vf-pager">
      <span class="vf-pager__info">Mostrando ${num(start + 1)}–${num(end)} de ${num(total)} pedidos${pages > 1 ? ` · página ${num(F.orders.page)}/${num(pages)}` : ''}</span>
      <div class="vf-pager__nav">
        <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" id="fapi-page-prev"${F.orders.page <= 1 ? ' disabled' : ''}>← Anterior</button>
        <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" id="fapi-page-next"${F.orders.page >= pages ? ' disabled' : ''}>Próxima →</button>
      </div>
    </div>
    <p class="vf-fapi-legend">Filete à esquerda da linha: <b>vermelho</b> cancelado/bloqueado · <b>âmbar</b> problema/sem custo · <b>cinza</b> sem frete. O estado também está escrito nas colunas Status, Confiança e Pendência. Ausência é <b>—</b>, nunca R$ 0,00.</p>`;
}

/* ── DETALHE DO PEDIDO (drawer lateral) ───────────────────── */
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
function findOrderById(id) {
  return (F.viewPayload?.pedidos || F.rawPayload?.pedidos || [])
    .map(x => x.prod !== undefined ? x : computeOrder(x, F.rawPayload))
    .find(x => x.id === id) || null;
}

function buildOrderDrawerBody(o) {
  const prod = o.prod;
  const faltas = faltasDoPedido(o, prod);
  const bloqueado = o.resultado == null;
  const cancelado = o.status === 'cancelado';
  const precoUnit = (o.valor != null && o.unidades) ? round2(o.valor / o.unidades) : null;
  const [scls, slbl] = STATUS_PEDIDO[o.status] || ['is-neutral', o.status];

  const kv = pairs => `<dl class="vf-fapi-kv">${pairs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;

  // Uma linha do extrato: Componente · Valor · Status · Fonte · Obs.
  const linha = (comp, op, valHtml, status, fonte, obs) => `
    <tr>
      <td>${esc(comp)}</td>
      <td class="vf-fapi-op" aria-hidden="true">${esc(op || '')}</td>
      <td class="num">${valHtml}</td>
      <td>${status ? statusTag(status) : '—'}</td>
      <td class="vf-fapi-fonte">${esc(fonte || '—')}</td>
      <td class="vf-fapi-obs vf-truncate" title="${esc(obs || '—')}">${esc(obs || '—')}</td>
    </tr>`;

  return `
    <section class="vf-fapi-drawer-section" aria-label="Identificação do pedido">
      <div class="vf-fapi-drawer-ident">
        ${thumb(o.produto)}
        <div>
          <p class="vf-fapi-drawer-ident__title">${esc(o.produto?.titulo || '—')}</p>
          <p class="vf-fapi-drawer-ident__meta">Pedido <span class="vf-mono">${esc(o.id)}</span> · ${fmtDt(o.data)}</p>
          <div class="vf-fapi-drawer-ident__tags">
            <span class="vf-tag ${scls}">${esc(slbl)}</span>
            ${tagFull(o.full)} ${tagAds(o.adsStatus)} ${tagDiag(prod)}
          </div>
        </div>
      </div>
      <p class="vf-fapi-legend">Valores derivados do pedido e dos cruzamentos disponíveis. Ausência nunca vira zero.</p>
    </section>

    <section class="vf-fapi-drawer-section" aria-label="Resultado financeiro">
      <h3 class="vf-fapi-drawer-section__title">Resultado financeiro</h3>
      <div class="vf-table-wrap">
        <table class="vf-table vf-table--compact">
          <thead><tr><th scope="col">Componente</th><th scope="col"><span class="vf-visually-hidden">Operação</span></th><th scope="col" class="num">Valor</th><th scope="col">Status</th><th scope="col">Fonte</th><th scope="col">Observação</th></tr></thead>
          <tbody>
            ${linha('Receita do pedido', '', valOr(o.valor, money), 'real', o.mlb ? 'planilha vendas / futuro Orders API' : 'planilha vendas (sem MLB)', o.mlb ? '' : 'linha financeira sem produto')}
            ${linha('Frete seller', '−', valOr(o.frete, money), o.frete == null ? 'ausente' : o.freteStatus, o.freteStatus === 'estimado' ? 'estimado / futuro Shipping API' : 'planilha vendas / futuro Shipping API', o.frete == null ? 'sem frete real — parcial' : '')}
            ${linha('Taxas marketplace', '−', valOr(o.taxas, money), o.taxas == null ? 'ausente' : o.taxasStatus, 'planilha vendas / futuro pagamentos', o.taxas == null ? 'taxa não identificada — parcial' : '')}
            ${linha('Custo / base', '−', valOr(o.custo, money), o.custoStatus, 'base interna', o.custoStatus === 'ausente' ? (o.mlb ? 'sem custo na base — bloqueia' : 'sem produto vinculado') : '')}
            ${linha('Imposto / regra interna', '−', valOr(o.imposto, money), o.imposto == null ? 'ausente' : 'real', 'base interna · Imposto %', o.imposto == null ? 'depende do custo/base' : '')}
            ${cancelado ? linha('Reembolso / cancelamento', '−', valOr(o.valor, money), 'parcial', 'planilha vendas', 'pedido cancelado — impacto, não conclusão') : ''}
            <tr class="vf-fapi-total-row">
              <td>Resultado estimado</td>
              <td class="vf-fapi-op" aria-hidden="true">=</td>
              <td class="num">${o.resultado == null ? '—' : `<span class="vf-fapi-est">${money(o.resultado)}</span>`}</td>
              <td>${statusTag(o.resultadoStatus)}</td>
              <td class="vf-fapi-fonte">derivado</td>
              <td class="vf-fapi-obs">${esc(bloqueado ? 'bloqueado — não vira R$ 0,00' : (o.resultadoStatus === 'real' ? 'todos os componentes presentes' : 'parcial — não confiável'))}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="vf-fapi-drawer-section" aria-label="Produto e base">
      <h3 class="vf-fapi-drawer-section__title">Produto e base</h3>
      ${kv([
        ['MLB', `<span class="vf-mono">${esc(o.produto?.mlb || '—')}</span>`],
        ['SKU', `<span class="vf-mono">${esc(o.produto?.sku || '—')}</span>`],
        ['Quantidade', esc(valOr(o.unidades, num))],
        ['Preço unit.', esc(valOr(precoUnit, money))],
        ['Valor do pedido', esc(valOr(o.valor, money))],
        ['Custo unit. (base)', esc(valOr(prod?.base?.temCusto ? prod.base.custo : null, money))],
        ['Imposto % (base)', prod?.base?.imposto == null ? '—' : esc(pct(prod.base.imposto))],
      ])}
    </section>

    <section class="vf-fapi-drawer-section" aria-label="Logística e Ads">
      <h3 class="vf-fapi-drawer-section__title">Logística e Ads</h3>
      <div class="vf-cluster">${tagFull(o.full)} ${tagAds(o.adsStatus)} ${tagDiag(prod)}</div>
    </section>

    ${(bloqueado || faltas.length) ? `
    <section class="vf-fapi-drawer-section" aria-label="Pendências e confiança">
      <h3 class="vf-fapi-drawer-section__title">Pendências e confiança</h3>
      <div class="vf-banner ${bloqueado ? 'is-danger' : 'is-warning'} vf-banner--compact">
        <div class="vf-banner__content">
          <p class="vf-banner__title">${bloqueado ? 'Sem informações suficientes para concluir' : 'Resultado parcial — o que ainda falta'}</p>
          <ul>${faltas.map(([f, imp]) => `<li><strong>${esc(f)}</strong> — ${esc(imp)}</li>`).join('')}</ul>
        </div>
      </div>
    </section>` : ''}`;
}

function openOrderDrawer(id, triggerRow) {
  const o = findOrderById(id);
  const drawer = document.getElementById('fapi-order-drawer');
  const backdrop = document.getElementById('fapi-drawer-backdrop');
  const body = document.getElementById('fapi-drawer-body');
  if (!o || !drawer || !body) return;

  F.ui.drawerOrderId = id;
  F.ui.drawerReturnFocusId = triggerRow?.dataset?.pedido || id;
  document.querySelectorAll('#fapi-ped-table tr[data-pedido]').forEach(r =>
    r.classList.toggle('row--selected', r.dataset.pedido === id));

  const conf = document.getElementById('fapi-drawer-conf');
  if (conf) conf.innerHTML = confStatus(o.confianca);
  body.innerHTML = buildOrderDrawerBody(o);

  drawer.classList.add('is-open');
  if (backdrop) backdrop.classList.add('is-open');
  document.body.classList.add('vf-no-scroll');
  // Foco inicial após o estilo aplicar (o drawer sai de visibility:hidden)
  requestAnimationFrame(() => requestAnimationFrame(() =>
    document.getElementById('fapi-drawer-close')?.focus()));
}

function closeOrderDrawer({ restoreFocus = true } = {}) {
  const drawer = document.getElementById('fapi-order-drawer');
  const backdrop = document.getElementById('fapi-drawer-backdrop');
  const wasOpen = drawer?.classList.contains('is-open');
  drawer?.classList.remove('is-open');
  backdrop?.classList.remove('is-open');
  document.body.classList.remove('vf-no-scroll');
  const returnId = F.ui.drawerReturnFocusId;
  F.ui.drawerOrderId = null;
  F.ui.drawerReturnFocusId = null;
  document.querySelectorAll('#fapi-ped-table tr.row--selected').forEach(r => r.classList.remove('row--selected'));
  if (wasOpen && restoreFocus && returnId) {
    const row = document.querySelector(`#fapi-ped-table tr[data-pedido="${CSS.escape(returnId)}"]`);
    (row || document.getElementById('fapi-search'))?.focus();
  }
}

/* Foco preso dentro do drawer enquanto aberto (Tab cíclico). */
function onDrawerKeydown(e) {
  if (e.key !== 'Tab') return;
  const drawer = document.getElementById('fapi-order-drawer');
  if (!drawer?.classList.contains('is-open')) return;
  const focusables = drawer.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* ================================================================
   MÓDULO CURVA ABC  (aba Produtos / Curva ABC)
   ----------------------------------------------------------------
   FRONTEIRA DE EXTRAÇÃO FUTURA — regras deste bloco:
     - Estado exclusivo em F.abc (nenhum outro módulo lê/escreve);
     - Recebe os pedidos DERIVADOS como argumento (não conhece
       F.viewPayload, filtros de Pedidos nem paginação de Pedidos);
     - Todo DOM manipulado aqui vive sob o root
       [data-module="curva-abc"] (#fapi-abc-root) — seletores sempre
       escopados via root.querySelector;
     - Nenhuma função daqui toca o DOM de Pedidos, e nenhuma função
       de Pedidos toca o DOM daqui;
     - CSS específico usa o prefixo .vf-fapi-abc.
   Para extrair no futuro: mover este bloco + F.abc + o CSS
   .vf-fapi-abc* e alimentar renderCurvaAbc(orders) com o payload
   da nova página.
   ================================================================ */

function abcRoot() { return document.getElementById('fapi-abc-root'); }

function resetCurvaAbcState() {
  F.abc.group = 'todos';
  F.abc.sort = 'faturamento';
  F.abc.search = '';
  F.abc.page = 1;
  F.abc.selectedProduct = null;
}

/* Agregação por produto a partir dos pedidos (fonte da verdade). */
function aggByProduct(pedidos) {
  const map = new Map();
  for (const o of pedidos) {
    const key = o.mlb || '__SEM_PRODUTO__';
    if (!map.has(key)) map.set(key, {
      mlb: o.mlb, prod: o.prod, titulo: o.produto.titulo, sku: o.produto.sku,
      unidades: 0, pedidos: 0, faturamento: 0, receitaBloqueada: 0, freteAcum: 0, taxasAcum: 0,
      cancelProblema: 0, full: o.full, fullPedidos: 0, normalPedidos: 0, semProduto: !o.mlb,
    });
    const a = map.get(key);
    const valido = o.status !== 'cancelado';
    a.pedidos += 1;
    if (valido) { a.unidades += (o.unidades || 0); a.faturamento += (o.valor || 0); a.taxasAcum += (o.taxas || 0); }
    if (o.resultadoStatus === 'bloqueado' && valido) a.receitaBloqueada += (o.valor || 0);
    a.freteAcum += (o.frete || 0);
    if (o.status === 'cancelado' || o.status === 'com_problema') a.cancelProblema += 1;
    if (o.full === true) { a.full = true; a.fullPedidos += 1; } else { a.normalPedidos += 1; }
  }
  for (const a of map.values()) { a.faturamento = round2(a.faturamento); a.receitaBloqueada = round2(a.receitaBloqueada); a.freteAcum = round2(a.freteAcum); a.taxasAcum = round2(a.taxasAcum); }
  return [...map.values()];
}

/* Logística do produto: full / normal / misto (ambos) / null (—). */
function productLogisticaTipo(a) {
  const f = a.fullPedidos > 0, n = a.normalPedidos > 0;
  return f && n ? 'misto' : f ? 'full' : n ? 'normal' : null;
}

/* Enriquece a agregação com derivados de leitura e aplica grupo + ordenação
   + busca local. Tudo derivado dos pedidos recebidos — sem inventar custo/
   frete. Classificação ABC idêntica à V1:
   A: acumulado até 80% · B: 80%–95% · C: o restante (item que cruza a
   fronteira fica na faixa anterior). */
function buildCurvaAbcRows(orders, { group = 'todos', sortBy = 'faturamento', search = '' } = {}) {
  const all = aggByProduct(orders).map(a => {
    const temCusto = !a.semProduto && a.prod?.base?.temCusto === true;
    return {
      ...a,
      temCusto,
      custoUnit: temCusto ? a.prod.base.custo : null,
      comissao: a.taxasAcum,
      ticketMedio: a.pedidos > 0 ? round2(a.faturamento / a.pedidos) : null,
      logisticaTipo: productLogisticaTipo(a),
    };
  });
  const totalFat = all.reduce((s, a) => s + a.faturamento, 0) || 0;
  all.forEach(a => { a.pctFat = totalFat > 0 ? round2(a.faturamento / totalFat * 100) : null; });

  // Curva ABC: ordena por faturamento desc, acumula % e classifica.
  const byFat = all.slice().sort((x, y) => y.faturamento - x.faturamento);
  let acc = 0;
  for (const a of byFat) {
    const prev = acc;
    acc = round2(acc + (a.pctFat || 0));
    a.acumPctFat = acc;
    a.curva = (a.faturamento <= 0) ? null : (prev < 80 ? 'A' : prev < 95 ? 'B' : 'C');
  }

  let rows = all;
  if (group === 'sem_custo')            rows = rows.filter(a => !a.semProduto && !a.temCusto);
  else if (group === 'receita_bloqueada') rows = rows.filter(a => (a.receitaBloqueada || 0) > 0);
  else if (group === 'full')            rows = rows.filter(a => a.logisticaTipo === 'full' || a.logisticaTipo === 'misto');
  else if (group === 'normal')          rows = rows.filter(a => a.logisticaTipo === 'normal' || a.logisticaTipo === 'misto');
  else if (group === 'misto')           rows = rows.filter(a => a.logisticaTipo === 'misto');
  else if (group === 'curva_a')         rows = rows.filter(a => a.curva === 'A');
  else if (group === 'curva_b')         rows = rows.filter(a => a.curva === 'B');
  else if (group === 'curva_c')         rows = rows.filter(a => a.curva === 'C');
  // 'todos' não filtra

  // Busca local (aplicada APÓS a classificação — não altera curva/acumulado)
  const term = String(search || '').trim().toLowerCase();
  if (term) {
    rows = rows.filter(a =>
      String(a.mlb || '').toLowerCase().includes(term) ||
      String(a.sku || '').toLowerCase().includes(term) ||
      String(a.titulo || '').toLowerCase().includes(term));
  }

  const sortKey = group === 'receita_bloqueada' ? 'receitaBloqueada' : sortBy;
  rows = rows.slice().sort((x, y) => (y[sortKey] || 0) - (x[sortKey] || 0));
  return { rows, allRows: all, totalFat };
}

const ABC_SORTS = [
  ['faturamento','Faturamento'], ['unidades','Unidades'], ['pedidos','Pedidos'],
  ['ticketMedio','Ticket médio'], ['comissao','Comissão'], ['receitaBloqueada','Receita bloqueada'],
];
const ABC_GROUPS = [
  ['todos','Todos'], ['curva_a','Curva A'], ['curva_b','Curva B'], ['curva_c','Curva C'],
  ['sem_custo','Sem custo'], ['full','Full'], ['normal','Normal'], ['misto','Misto'],
];
function abcBaseTag(a) {
  if (a.semProduto) return '<span class="vf-tag is-neutral">—</span>';
  return a.temCusto ? '<span class="vf-tag is-success">com custo</span>' : '<span class="vf-tag is-danger">sem custo</span>';
}
function abcLogTag(t) {
  if (t === 'full')  return '<span class="vf-tag is-primary">Full</span>';
  if (t === 'normal')return '<span class="vf-tag is-neutral">Normal</span>';
  if (t === 'misto') return '<span class="vf-tag is-info">Misto</span>';
  return '<span class="vf-tag is-neutral">—</span>';
}
function abcDiagTag(a) {
  if (a.semProduto || !a.prod) return '<span class="vf-tag is-neutral">—</span>';
  return a.prod.diag?.presente === true
    ? '<span class="vf-tag is-success">no diagnóstico</span>'
    : '<span class="vf-tag is-warning">fora do diag.</span>';
}
const ABC_CURVA_TAG = {
  A: '<span class="vf-tag is-primary">A</span>',
  B: '<span class="vf-tag is-neutral">B</span>',
  C: '<span class="vf-tag is-neutral">C</span>',
};

function renderCurvaAbcToolbar(counts) {
  const groupOpts = ABC_GROUPS.map(([k, l]) => `<option value="${k}"${F.abc.group === k ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const sortOpts = ABC_SORTS.map(([k, l]) => `<option value="${k}"${F.abc.sort === k ? ' selected' : ''}>${esc(l)}</option>`).join('');
  return `
    <div class="vf-fapi-abc-toolbar">
      <div class="vf-fapi-abc-toolbar__filters">
        <input type="search" class="vf-input vf-input--sm vf-search" data-abc-search placeholder="Buscar MLB, SKU ou título…" value="${esc(F.abc.search || '')}" autocomplete="off" aria-label="Buscar produtos na Curva ABC">
        <label class="vf-filter-group">
          <span class="vf-filter-group__label">Grupo</span>
          <select class="vf-select vf-select--sm" data-abc-group>${groupOpts}</select>
        </label>
        <label class="vf-filter-group">
          <span class="vf-filter-group__label">Ordenar por</span>
          <select class="vf-select vf-select--sm" data-abc-sort>${sortOpts}</select>
        </label>
        <span class="vf-fapi-orders-toolbar__count">${num(counts.visiveis)} produto(s)</span>
      </div>
      <div class="vf-fapi-abc-toolbar__actions">
        <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-abc-action="only-nocost">Ver apenas sem custo</button>
        <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-abc-action="copy-nocost">Copiar MLBs sem custo</button>
      </div>
    </div>`;
}

function renderCurvaAbcTable(rows, totalFat) {
  const total = rows.length;
  const pageSize = F.abc.pageSize;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (F.abc.page > pages) F.abc.page = pages;
  if (F.abc.page < 1) F.abc.page = 1;
  const start = (F.abc.page - 1) * pageSize;
  const end = Math.min(start + pageSize, total);
  const pageRows = rows.slice(start, end);

  const semFaturamento = totalFat <= 0;
  if (semFaturamento || total === 0) {
    return `<div class="vf-card"><div class="vf-card__body">${emptyState({
      icon:'dot',
      title: semFaturamento ? 'Sem faturamento no período' : 'Sem produtos neste grupo',
      why: semFaturamento ? 'Não há receita para montar a Curva ABC.' : 'Nenhum produto no recorte atual.',
      next: semFaturamento ? 'Sincronize pedidos ou amplie o período.' : 'Troque o grupo ou limpe a busca.',
    })}</div></div>`;
  }

  const sortDescCol = F.abc.group === 'receita_bloqueada' ? 'receitaBloqueada' : F.abc.sort;
  const th = (key, label, numCls) => `<th scope="col"${numCls ? ' class="num"' : ''}${key === sortDescCol ? ' aria-sort="descending"' : ''}>${esc(label)}</th>`;

  const body = pageRows.map((a, i) => `
    <tr class="${!a.semProduto && !a.temCusto ? 'is-nocost' : ''}">
      <td class="vf-fapi-abc-rank">${num(start + i + 1)}</td>
      <td>${a.curva ? ABC_CURVA_TAG[a.curva] : '<span class="vf-tag is-neutral">—</span>'}</td>
      <td class="vf-truncate" title="${esc(a.titulo || '—')}">${esc(a.titulo || '—')}</td>
      <td class="vf-mono">${esc(a.mlb || '—')}</td>
      <td class="vf-mono${a.sku ? '' : ' is-absent'}">${esc(a.sku || '—')}</td>
      <td class="num">${money(a.faturamento)}</td>
      <td class="num">${valOr(a.pctFat, pct)}</td>
      <td class="num is-absent">${valOr(a.acumPctFat, pct)}</td>
      <td class="num">${valOr(a.unidades)}</td>
      <td class="num">${valOr(a.pedidos)}</td>
      <td class="num${a.ticketMedio == null ? ' is-absent' : ''}">${valOr(a.ticketMedio, money)}</td>
      <td class="num">${money(a.comissao)}</td>
      <td class="num${a.custoUnit == null ? ' is-absent' : ''}">${valOr(a.custoUnit, money)}</td>
      <td>${abcBaseTag(a)}</td>
      <td>${abcDiagTag(a)}</td>
      <td>${abcLogTag(a.logisticaTipo)}</td>
      <td class="num">${a.receitaBloqueada > 0 ? `<span class="vf-fapi-est">${money(a.receitaBloqueada)}</span>` : '—'}</td>
    </tr>`).join('');

  return `
    <div class="vf-table-wrap vf-fapi-abc__table-wrap">
      <table class="vf-table vf-table--compact vf-fapi-abc-table" aria-label="Curva ABC de produtos">
        <thead><tr>
          <th scope="col"><span class="vf-visually-hidden">Posição</span>#</th>
          <th scope="col">Curva</th>
          <th scope="col">Produto</th>
          <th scope="col">MLB</th>
          <th scope="col">SKU</th>
          ${th('faturamento', 'Faturamento', true)}
          <th scope="col" class="num">% fat.</th>
          <th scope="col" class="num">Acum. %</th>
          ${th('unidades', 'Un.', true)}
          ${th('pedidos', 'Ped.', true)}
          ${th('ticketMedio', 'Ticket', true)}
          ${th('comissao', 'Comissão', true)}
          <th scope="col" class="num">Custo un.</th>
          <th scope="col">Base</th>
          <th scope="col">Diagnóstico</th>
          <th scope="col">Logística</th>
          ${th('receitaBloqueada', 'Receita bloq.', true)}
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <div class="vf-pager">
      <span class="vf-pager__info">Mostrando ${num(start + 1)}–${num(end)} de ${num(total)} produtos${pages > 1 ? ` · página ${num(F.abc.page)}/${num(pages)}` : ''}</span>
      <div class="vf-pager__nav">
        <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-abc-page="-1"${F.abc.page <= 1 ? ' disabled' : ''}>← Anterior</button>
        <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-abc-page="1"${F.abc.page >= pages ? ' disabled' : ''}>Próxima →</button>
      </div>
    </div>
    <p class="vf-fapi-legend">A ≤ 80% · B ≤ 95% · C = resto do faturamento acumulado do período. Curva calculada sobre o período inteiro — a busca e os grupos não alteram a classificação. Filete âmbar = produto sem custo na base.</p>`;
}

/* Render do módulo. Recebe os pedidos derivados (período inteiro). */
function renderCurvaAbc(orders) {
  const root = abcRoot();
  if (!root) return;
  const { rows, allRows, totalFat } = buildCurvaAbcRows(orders, { group: F.abc.group, sortBy: F.abc.sort, search: F.abc.search });

  const vendidos = allRows.filter(a => !a.semProduto);
  const curvaA = vendidos.filter(a => a.curva === 'A');
  const semCusto = vendidos.filter(a => !a.temCusto);
  const fatSemCusto = round2(semCusto.reduce((s, a) => s + a.faturamento, 0));
  const unidadesTotal = allRows.reduce((s, a) => s + (a.unidades || 0), 0);
  const receitaBloqTotal = round2(allRows.reduce((s, a) => s + (a.receitaBloqueada || 0), 0));

  const sum = (label, val, cls = '', foot = '') => `
    <div class="vf-fapi-abc-summary__item">
      <span class="vf-fapi-abc-summary__label">${esc(label)}</span>
      <span class="vf-fapi-abc-summary__value${cls ? ' ' + cls : ''}">${val}</span>
      ${foot ? `<span class="vf-fapi-abc-summary__foot">${esc(foot)}</span>` : ''}
    </div>`;

  root.innerHTML = `
    <div class="vf-section__header">
      <div>
        <h2 class="vf-section__title">Curva ABC de produtos</h2>
        <p class="vf-section__description">Agregação dos pedidos do período por produto — leitura/análise, sem recomendação automática.</p>
      </div>
    </div>
    <div class="vf-fapi-abc-summary" aria-label="Resumo da Curva ABC">
      ${sum('Produtos vendidos', num(vendidos.length), '', 'com faturamento no período')}
      ${sum('Faturamento', money(totalFat))}
      ${sum('Unidades', num(unidadesTotal))}
      ${sum('Curva A', num(curvaA.length), '', 'concentram até 80%')}
      ${sum('Produtos sem custo', num(semCusto.length), semCusto.length ? 'is-danger' : '', fatSemCusto > 0 ? `${money(fatSemCusto)} sem custo p/ calcular` : '')}
      ${sum('Receita bloqueada', receitaBloqTotal > 0 ? money(receitaBloqTotal) : '—', receitaBloqTotal > 0 ? 'is-warning' : '')}
    </div>
    ${renderCurvaAbcToolbar({ visiveis: rows.length })}
    <div data-abc-table>${renderCurvaAbcTable(rows, totalFat)}</div>`;
}

/* Ponte única entre a página e o módulo: deriva os pedidos e delega. */
function renderAbc() {
  if (!F.rawPayload?.ok) return;
  renderCurvaAbc(fechamentoOrders(F.rawPayload));
}

/* Copia para a área de transferência os MLBs sem custo na base (todo o período). */
function fallbackCopy(texto, cb) {
  try {
    const ta = document.createElement('textarea');
    ta.value = texto;
    ta.className = 'vf-visually-hidden';
    ta.setAttribute('aria-hidden', 'true');
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  } catch (_) { /* ignora */ }
  if (cb) cb();
}
function copiarMlbsSemCusto(orders, btn) {
  const { allRows } = buildCurvaAbcRows(orders, { group: 'todos', sortBy: 'faturamento' });
  const mlbs = allRows.filter(a => !a.semProduto && !a.temCusto && a.mlb).map(a => a.mlb);
  const flash = msg => { if (btn) { const t = btn.dataset.label || btn.textContent; btn.dataset.label = t; btn.textContent = msg; setTimeout(() => { btn.textContent = t; }, 1600); } };
  if (!mlbs.length) { flash('Nenhum sem custo'); return; }
  const texto = mlbs.join('\n');
  const ok = () => flash(`Copiado ${mlbs.length} MLB(s)`);
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(texto).then(ok).catch(() => fallbackCopy(texto, ok));
  else fallbackCopy(texto, ok);
}

/* Interações do módulo — delegação escopada ao root (uma vez, no boot). */
function wireCurvaAbc() {
  const root = abcRoot();
  if (!root) return;

  root.addEventListener('change', e => {
    const group = e.target.closest('[data-abc-group]');
    if (group) { F.abc.group = group.value; F.abc.page = 1; renderAbc(); return; }
    const sort = e.target.closest('[data-abc-sort]');
    if (sort) { F.abc.sort = sort.value; F.abc.page = 1; renderAbc(); return; }
  });

  root.addEventListener('input', e => {
    const search = e.target.closest('[data-abc-search]');
    if (!search) return;
    if (F.abc.searchTimer) clearTimeout(F.abc.searchTimer);
    const value = search.value;
    F.abc.searchTimer = setTimeout(() => {
      F.abc.search = value;
      F.abc.page = 1;
      // Re-render só da tabela (o campo de busca fica fora e preserva o foco)
      const tableHost = root.querySelector('[data-abc-table]');
      if (!tableHost || !F.rawPayload?.ok) return;
      const orders = fechamentoOrders(F.rawPayload);
      const { rows, totalFat } = buildCurvaAbcRows(orders, { group: F.abc.group, sortBy: F.abc.sort, search: F.abc.search });
      const count = root.querySelector('.vf-fapi-abc-toolbar__count');
      if (count) count.textContent = `${num(rows.length)} produto(s)`;
      tableHost.innerHTML = renderCurvaAbcTable(rows, totalFat);
    }, 300);
  });

  root.addEventListener('click', e => {
    const pageBtn = e.target.closest('[data-abc-page]');
    if (pageBtn) { F.abc.page = Math.max(1, F.abc.page + Number(pageBtn.dataset.abcPage)); renderAbc(); return; }
    const action = e.target.closest('[data-abc-action]');
    if (!action || !F.rawPayload?.ok) return;
    if (action.dataset.abcAction === 'only-nocost') { F.abc.group = 'sem_custo'; F.abc.page = 1; renderAbc(); return; }
    if (action.dataset.abcAction === 'copy-nocost') { copiarMlbsSemCusto(fechamentoOrders(F.rawPayload), action); return; }
  });
}
/* ════════════════ FIM DO MÓDULO CURVA ABC ════════════════ */

/* ── INTERAÇÕES (tudo local, sem fetch) ───────────────────── */
/* Filtro de pedido (select do painel Filtros) — aplica instantâneo. */
function setPedFilter(key, value) {
  F.orders.filters[key] = value || (key === 'logistica' || key === 'midia' || key === 'diagbase' || key === 'status' ? 'todos' : null);
  F.orders.filters = sanitizeFilters(F.orders.filters, F.rawPayload);
  closeOrderDrawer({ restoreFocus: false });
  F.orders.page = 1;
  recomputeView();
  renderPedTable();
  updateQuickChips();
  renderDaysSection(); // a régua de dias respeita logística/mídia/diag/status
}
/* Clique num dia (régua ou tabela) → filtra SÓ a tabela de pedidos daquele
   dia e leva o usuário para a aba Pedidos (sem novo fetch). */
function applyDayFilter(day) {
  if (!isDateInPeriod(day, F.rawPayload.periodo)) return;
  F.orders.filters = { ...cloneFilters(F.orders.filters), modo:'intervalo', dia:null, semana:null, de:day, ate:day };
  closeOrderDrawer({ restoreFocus: false });
  F.orders.page = 1;
  recomputeView();
  renderOrdersPanel();     // rebuild da toolbar (linha de filtros ativos ganha o dia)
  renderDaysSection();     // destaque do dia selecionado na régua/tabela
  setActiveTab('pedidos');
}
/* Recorte rápido (chip). Toggle: reclicar o ativo volta a "Todos". */
function applyQuickFilter(q) {
  F.orders.quickFilter = (q !== 'todos' && q === F.orders.quickFilter) ? 'todos' : q;
  F.orders.page = 1;
  closeOrderDrawer({ restoreFocus: false });
  renderPedTable();
  updateQuickChips();
}
function updateQuickChips() {
  const panel = document.getElementById('fapi-panel-pedidos');
  if (!panel) return;
  const base = getSearchedPedidos();
  panel.querySelectorAll('[data-quick]').forEach(b => {
    const k = b.dataset.quick;
    const active = k === F.orders.quickFilter;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-pressed', String(active));
    const badge = b.querySelector('.vf-badge');
    if (badge) badge.textContent = num(k === 'todos' ? base.length : base.filter(o => pedidoMatchesQuick(o, k)).length);
  });
}
function setOrderSort(value) {
  F.orders.sort = value || 'data_desc';
  F.orders.page = 1;
  renderPedTable();
}
/* "Limpar tudo": zera recorte, ordenação, busca e selects (mantém o período). */
function limparTudoLocal() {
  resetFilters();
  closeOrderDrawer({ restoreFocus: false });
  recomputeView();
  renderOrdersPanel();  // rebuild toolbar (selects/busca/chips) + tabela
  renderDaysSection();  // remove destaque de dia/escopo
}
/* Busca local com debounce de 300ms — re-renderiza só #fapi-ped-table; o input
   está na toolbar (fora desse host), então o foco é preservado. */
function onSearchInput(value) {
  if (F.orders.searchTimer) clearTimeout(F.orders.searchTimer);
  F.orders.searchTimer = setTimeout(() => {
    F.orders.search = value;
    F.orders.page = 1;
    closeOrderDrawer({ restoreFocus: false });
    renderPedTable();
    updateQuickChips();
  }, 300);
}
function goToPage(delta) {
  F.orders.page = Math.max(1, F.orders.page + delta);
  renderPedTable();
}
/* Recorte do Fechamento (chips próprios) — re-render só do bloco Fechamento. */
function setFechQuick(q) {
  F.summary.quickFilter = (q !== 'todos' && q === F.summary.quickFilter) ? 'todos' : q;
  renderFechamentoSection();
}
function setDailySort(value) {
  F.summary.dailySort = value || 'data';
  renderDaysSection();
}
/* Remoção de um filtro ativo individual (chips da linha "Filtros ativos"). */
function removeActiveFilter(type, key) {
  if (type === 'quick') { F.orders.quickFilter = 'todos'; }
  else if (type === 'pedfilter' && key) { setPedFilter(key, 'todos'); renderOrdersPanel(); return; }
  else if (type === 'dia') {
    F.orders.filters = { ...cloneFilters(F.orders.filters), modo:'mes', dia:null, semana:null, de:null, ate:null };
    recomputeView();
    renderOrdersPanel();
    renderDaysSection();
    return;
  }
  else if (type === 'busca') {
    F.orders.search = '';
    const input = document.getElementById('fapi-search');
    if (input) input.value = '';
  }
  F.orders.page = 1;
  renderPedTable();
  updateQuickChips();
}

/* ── IMPORTAÇÃO / SINCRONIZAÇÃO (admin only — endpoints preservados) ── */
function setActionStatus(msg, tipo) {
  const el = document.getElementById('fapi-action-status');
  if (!el) return;
  el.hidden = !msg;
  el.innerHTML = msg
    ? `<div class="vf-banner is-${tipo || 'info'} vf-banner--compact"><div class="vf-banner__content"><p class="vf-banner__description">${esc(msg)}</p></div></div>`
    : '';
}
const ACTION_TONE = { info:'info', ok:'success', warn:'warning', danger:'danger', warning:'warning', success:'success' };

function setImportFile(file) {
  F.arquivoImport = file || null;
  const item = document.getElementById('fapi-import-fileitem');
  const name = document.getElementById('fapi-import-fname');
  if (item) item.hidden = !file;
  if (name) name.textContent = file ? file.name : '';
  if (!file) {
    const input = document.getElementById('fapi-import-file');
    if (input) input.value = '';
  }
}
function toggleImportPanel(force) {
  const panel = document.getElementById('fapi-import-panel');
  const toggle = document.getElementById('fapi-import-toggle');
  if (!panel) return;
  F.ui.importPanelOpen = typeof force === 'boolean' ? force : !F.ui.importPanelOpen;
  panel.hidden = !F.ui.importPanelOpen;
  toggle?.setAttribute('aria-expanded', String(F.ui.importPanelOpen));
}

function setAdminBusy(busy, activeBtnId) {
  ['fapi-import-btn', 'fapi-sync-btn', 'fapi-refresh-btn'].forEach(id => {
    const b = document.getElementById(id);
    if (!b) return;
    b.disabled = busy;
    b.classList.toggle('is-loading', busy && id === activeBtnId);
  });
}

async function executarImportacao() {
  if (!TOKEN) return;
  if (!F.cliente) { setActionStatus('Selecione um cliente antes de importar.', ACTION_TONE.warn); return; }
  if (!F.periodo) { setActionStatus('Selecione o período antes de importar.', ACTION_TONE.warn); return; }

  // Usa F.arquivoImport (variável de estado) — não depende de input.files[0],
  // que o browser pode zerar após repaint mesmo sem destruir o elemento.
  const arquivo = F.arquivoImport;
  if (!arquivo) { setActionStatus('Selecione a planilha de vendas (.xlsx).', ACTION_TONE.warn); return; }

  setAdminBusy(true, 'fapi-import-btn');
  setActionStatus('Importando…', ACTION_TONE.info);

  try {
    const form = new FormData();
    form.append('sales', arquivo);
    // Import (planilha) ainda agrupa por competência: deriva do mês do início do período.
    form.append('competencia', String(F.periodo.dateFrom).slice(0, 7));

    const res = await fetch(
      `${API_BASE}/operacao/central-vendas/${encodeURIComponent(F.cliente.slug)}/importar-vendas`,
      { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: form }
    );

    if (res.status === 401) { window.location.replace('index.html'); return; }

    const json = await res.json();
    if (!res.ok) throw new Error(json.erro || json.error || json.message || `HTTP ${res.status}`);

    const pedidos = json.pedidosPersistidos ?? '?';
    setActionStatus(`Importado: ${pedidos} pedido(s). Recarregando…`, ACTION_TONE.ok);
    // Limpa o arquivo após importação bem-sucedida
    setImportFile(null);
    toggleImportPanel(false);
    await carregarTela();
    setActionStatus(`${pedidos} pedido(s) importados com sucesso.`, ACTION_TONE.ok);
  } catch (err) {
    setActionStatus(`Erro: ${err?.message || 'Falha na importação.'}`, ACTION_TONE.danger);
  } finally {
    setAdminBusy(false);
  }
}

/* Sincronização API-first: busca pedidos direto da Orders API do ML, sem planilha.
   Custo continua vindo da base vinculada oficial do cliente. */
async function executarSincronizacao() {
  if (!TOKEN) return;
  if (!F.cliente) { setActionStatus('Selecione um cliente antes de sincronizar.', ACTION_TONE.warn); return; }
  if (!F.periodo) { setActionStatus('Selecione o período antes de sincronizar.', ACTION_TONE.warn); return; }

  setAdminBusy(true, 'fapi-sync-btn');
  setActionStatus('Sincronizando pedidos via API do Mercado Livre…', ACTION_TONE.info);

  try {
    const res = await fetch(
      `${API_BASE}/operacao/central-vendas/${encodeURIComponent(F.cliente.slug)}/sincronizar`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateFrom: F.periodo.dateFrom, dateTo: F.periodo.dateTo }),
      }
    );

    if (res.status === 401) { window.location.replace('index.html'); return; }

    const json = await res.json();
    if (!res.ok) throw new Error(json.erro || json.error || json.message || `HTTP ${res.status}`);

    const pedidos = json.pedidosPersistidos ?? '?';
    const orders = json.ordersEncontrados ?? '?';
    F.lastSyncBase = json.baseVinculada || null;
    const baseTxt = json.baseVinculada ? `base "${json.baseVinculada.nome}"` : 'sem base vinculada';
    setActionStatus(`Sincronizado: ${pedidos} pedido(s) de ${orders} da API · ${baseTxt}. Recarregando…`, ACTION_TONE.ok);
    await carregarTela();
    setActionStatus(`${pedidos} pedido(s) sincronizados via API (${baseTxt}).`, ACTION_TONE.ok);
  } catch (err) {
    setActionStatus(`Erro: ${err?.message || 'Falha na sincronização.'}`, ACTION_TONE.danger);
  } finally {
    setAdminBusy(false);
  }
}

/* ── WIRING ESTÁTICO (uma vez, no boot — delegação nos hosts) ── */
function wireStatic() {
  // Barra de contexto
  document.getElementById('fapi-client-select')?.addEventListener('change', e => {
    F.cliente = F.clientes.find(c => c.slug === e.target.value) || null;
    closeOrderDrawer({ restoreFocus: false });
    F.lastSyncBase = null;
    resetFilters();
    carregarTela();
  });
  document.getElementById('fapi-period-select')?.addEventListener('change', onPeriodChange);
  document.getElementById('fapi-period-apply')?.addEventListener('click', aplicarPeriodoCustom);
  document.getElementById('fapi-refresh-btn')?.addEventListener('click', () => {
    setActionStatus('', '');
    carregarTela(); // relê o banco (GET) — não chama a API do ML
  });
  document.getElementById('fapi-sync-btn')?.addEventListener('click', executarSincronizacao);
  document.getElementById('fapi-import-toggle')?.addEventListener('click', () => toggleImportPanel());
  document.getElementById('fapi-import-choose')?.addEventListener('click', () => document.getElementById('fapi-import-file')?.click());
  document.getElementById('fapi-import-file')?.addEventListener('change', function () {
    setImportFile(this.files?.[0] || null);
    setActionStatus('', '');
  });
  document.getElementById('fapi-import-clear')?.addEventListener('click', () => setImportFile(null));
  document.getElementById('fapi-import-btn')?.addEventListener('click', executarImportacao);

  // Abas (tablist com teclado)
  const tabs = document.getElementById('fapi-tabs');
  tabs?.addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab) setActiveTab(tab.dataset.tab);
  });
  tabs?.addEventListener('keydown', onTablistKeydown);

  // Aba Visão geral: recorte do fechamento, régua de dias, tabela diária, CTA
  const visao = document.getElementById('fapi-panel-visao');
  visao?.addEventListener('click', e => {
    const fechq = e.target.closest('[data-fechq]');
    if (fechq) { setFechQuick(fechq.dataset.fechq); return; }
    const syncEmpty = e.target.closest('[data-action="sync-empty"]');
    if (syncEmpty) { executarSincronizacao(); return; }
    const day = e.target.closest('[data-day]');
    if (day) { applyDayFilter(day.dataset.day); return; }
    const row = e.target.closest('[data-fechday]');
    if (row) { applyDayFilter(row.dataset.fechday); return; }
  });
  visao?.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-fechday]');
    if (row) { e.preventDefault(); applyDayFilter(row.dataset.fechday); }
  });
  visao?.addEventListener('change', e => {
    if (e.target.id === 'fapi-daily-sort') setDailySort(e.target.value);
  });

  // Aba Pedidos: busca, ordenação, filtros, chips, tabela, paginação
  const pedidos = document.getElementById('fapi-panel-pedidos');
  pedidos?.addEventListener('input', e => {
    if (e.target.id === 'fapi-search') onSearchInput(e.target.value);
  });
  pedidos?.addEventListener('change', e => {
    const sel = e.target.closest('[data-pedfilter]');
    if (sel) { setPedFilter(sel.dataset.pedfilter, sel.value); return; }
    if (e.target.id === 'fapi-order-sort') setOrderSort(e.target.value);
  });
  pedidos?.addEventListener('click', e => {
    const chip = e.target.closest('[data-quick]');
    if (chip) { applyQuickFilter(chip.dataset.quick); return; }
    const remove = e.target.closest('[data-remove-filter]');
    if (remove) { removeActiveFilter(remove.dataset.removeFilter, remove.dataset.removeKey); return; }
    if (e.target.closest('#fapi-clear-local') || e.target.closest('#fapi-clear-local-empty')) { limparTudoLocal(); return; }
    if (e.target.closest('#fapi-page-prev')) { goToPage(-1); return; }
    if (e.target.closest('#fapi-page-next')) { goToPage(1); return; }
    const toggle = e.target.closest('#fapi-filters-toggle');
    if (toggle) {
      F.ui.filtersPanelOpen = !F.ui.filtersPanelOpen;
      const panel = document.getElementById('fapi-filters-panel');
      if (panel) panel.hidden = !F.ui.filtersPanelOpen;
      toggle.setAttribute('aria-expanded', String(F.ui.filtersPanelOpen));
      return;
    }
    const row = e.target.closest('tr[data-pedido]');
    if (row) { openOrderDrawer(row.dataset.pedido, row); return; }
  });
  pedidos?.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('tr[data-pedido]');
    if (row && e.target === row) { e.preventDefault(); openOrderDrawer(row.dataset.pedido, row); }
  });

  // Módulo Curva ABC (delegação própria, escopada ao root)
  wireCurvaAbc();

  // Drawer do pedido
  document.getElementById('fapi-drawer-close')?.addEventListener('click', () => closeOrderDrawer());
  document.getElementById('fapi-drawer-close-footer')?.addEventListener('click', () => closeOrderDrawer());
  document.getElementById('fapi-drawer-backdrop')?.addEventListener('click', () => closeOrderDrawer());
  document.getElementById('fapi-order-drawer')?.addEventListener('keydown', onDrawerKeydown);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('fapi-order-drawer')?.classList.contains('is-open')) {
      closeOrderDrawer();
    }
  });
}

/* ── BOOT ─────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', initFechamentosApi);
