/* ================================================================
   fechamentos-api.js — VenForce · Central de Vendas (Fundação V2)
   ----------------------------------------------------------------
   FERRAMENTA OPERACIONAL de conciliação por PEDIDO.

   M9 — a tela NÃO possui mais interpretação financeira própria:

     BACKEND calcula · persiste · classifica · agrega
              ↓
     FRONTEND consulta · filtra/navega · formata · renderiza

   Todo custo/imposto/resultado/confiança/margem exibido vem PRONTO da Read
   API canônica (M7) e dos agregados de leitura do M9 (/read, /read/daily,
   /read/products, /read/orders/:rowId). Não existe `computeOrder` nem
   nenhuma segunda fórmula: filtro, busca, ordenação e paginação da aba
   Pedidos viram parâmetros de query no backend; o que resta local é
   navegação (aba ativa, drawer aberto, campo de busca, período escolhido).

   Honestidade do dado (inalterada):
     null/undefined = AUSENTE (mostra "—")   ·   0 = zero REAL
     status: real | ausente | parcial | bloqueado
     resultado NUNCA é exibido como confiável se faltar dado.

   Arquitetura da tela (V2, inalterada nesta rodada):
     - Barra global de contexto (cliente/conta/período/motor/ações admin);
     - Abas: Visão geral · Pedidos · Produtos/Curva ABC;
     - Detalhe do pedido em drawer lateral (busca sob demanda no M7);
     - Curva ABC integrada permanentemente à Fechamento API, módulo próprio.
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

/* ── HELPERS DE FORMATO (A — apresentação, sem cálculo financeiro) ── */
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
/* Datas do calendário do período — só aritmética de data (categoria A/B),
   usada para preencher dias sem pedido na régua de "Vendas por dia". */
function getCompetenceDays(inicio, fim) {
  const days = [];
  const cur = new Date(inicio + 'T00:00:00');
  const end = new Date(fim + 'T00:00:00');
  while (!isNaN(cur.getTime()) && cur <= end) {
    days.push(isoDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

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
/* Diagnóstico (Motor de Margem) fica fora do escopo do M9 (seção 21/22) — o
   motor real da Central de Vendas nunca preenche `diag.presente` (é sempre
   `false`, hardcoded em buildProdutos), então a única leitura honesta hoje
   é "base" (custoStatus) cruzada com "fora do diagnóstico" sempre. Quando o
   Motor de Margem passar a alimentar esse dado, este é o único ponto a
   trocar — nenhuma tabela/coluna precisa mudar de lugar. */
function tagDiag(custoStatus) {
  const temCusto = custoStatus === 'real';
  return temCusto
    ? `<span class="vf-tag is-warning">base · fora diag</span>`
    : `<span class="vf-tag is-danger">sem base/diag</span>`;
}
function thumb(p) {
  const ini = String(p?.titulo || p?.sku || p?.mlb || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '—';
  return `<span class="vf-fapi-thumb" aria-hidden="true">${esc(ini)}</span>`;
}

/* Pendências: códigos curtos persistidos pelo motor (M5/M6 —
   centralVendasSyncService.js / meliFinanceiroService.js). Só tradução para
   leitura humana — nenhuma regra nova, os códigos são os mesmos das duas
   origens (API-first e planilha). */
const PENDENCIA_LBL = {
  produto_ausente: 'financeiro sem produto conciliado',
  custo_produto_ausente: 'MLB sem custo na base',
  tarifa_venda_ausente: 'tarifa não identificada',
  frete_seller_ausente: 'frete real ausente',
  imposto_interno_ausente: 'imposto não calculável',
  ajuste_plataforma_presente: 'ajuste de plataforma não conciliado',
};
const PENDENCIA_IMPACTO = {
  produto_ausente: 'impede atribuir custo/base e calcular resultado do item',
  custo_produto_ausente: 'impede calcular resultado do item',
  tarifa_venda_ausente: 'resultado fica parcial, nunca confiável',
  frete_seller_ausente: 'resultado fica parcial, nunca confiável',
  imposto_interno_ausente: 'resultado fica parcial, nunca confiável',
  ajuste_plataforma_presente: 'o total líquido reportado não bate com os componentes — resíduo não conciliado (achado documentado, não corrigido)',
};
function pendenciaLabel(code) { return PENDENCIA_LBL[code] || String(code || '').replace(/_/g, ' '); }
function pendenciaImpacto(code) { return PENDENCIA_IMPACTO[code] || ''; }

/* Componentes do ledger financeiro (M6) — tradução de tipo p/ leitura humana. */
const COMPONENTE_LBL = {
  receita_produto: 'Receita do produto',
  tarifa_venda: 'Tarifa de venda',
  frete_seller: 'Frete seller',
  custo_produto: 'Custo do produto',
  imposto_interno: 'Imposto interno',
  receita_envio: 'Receita de envio (conciliação)',
  cancelamento_reembolso: 'Cancelamento / reembolso (conciliação)',
};
const COMPONENTE_ORDEM = ['receita_produto', 'tarifa_venda', 'custo_produto', 'imposto_interno', 'frete_seller', 'receita_envio', 'cancelamento_reembolso'];

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

/* ================================================================
   MOCK — só ligado explicitamente em dev (vf-fapi-mock-dev=1 no
   localStorage), nunca automático após erro real de backend (seção 23).

   Contrato JÁ CANÔNICO: cada pedido abaixo já traz os campos finais
   (resultado/custo/imposto/confiança) como CONSTANTES escritas à mão —
   nenhuma fórmula os deriva. `buildMockResponse*` só filtra/ordena/pagina/
   soma esses campos já prontos (equivalente ao que o backend faz), do
   mesmo jeito que a Read API real faz sobre o pedido persistido — isolado
   neste bloco, nunca importado nem chamado por nenhum caminho de produção.
   ================================================================ */
const MOCK_PERIODO = { competencia:'2026-08', inicio:'2026-08-01', fim:'2026-08-31', label:'Agosto/2026' };

function mockPedido(over) {
  return Object.assign({
    id: over.pedidoId, pedidoId: over.pedidoId, rowId: over.rowId,
    multiItem: false, qtdItens: 1,
    status: 'pago', statusOriginal: 'paid', entraNoResultado: true,
    posVendaTipo: null, posVendaMotivo: null, posVendaParcial: false,
    posVendaQuantidadeComprada: null, posVendaQuantidadeDevolvida: null,
    claimId: null, claimIds: [],
    receitaEnvio: null, receitaEnvioStatus: 'ausente',
    reembolso: null, reembolsoStatus: 'ausente',
    logistica: over.full ? 'full' : 'normal',
    adsStatus: 'ausente',
    pendencias: [],
    itens: [], componentes: [],
  }, over);
}

const MOCK_ROWS = [
  mockPedido({
    pedidoId:'9000000001', rowId:1, data:'2026-08-02', valor:200, frete:20, freteStatus:'real',
    taxas:30, taxasStatus:'real', custo:60, custoStatus:'real', imposto:8,
    resultado:82, resultadoStatus:'real', confianca:'confiavel', unidades:2, full:true,
    mlb:'MLBA', sku:'SKU-A', produto:{ mlb:'MLBA', sku:'SKU-A', titulo:'Cabo USB-C 2m' },
    itens: [{ id:'IT1', itemId:'IT1', mlb:'MLBA', sku:'SKU-A', titulo:'Cabo USB-C 2m', quantidade:2, valorUnitario:100, receitaProduto:200, custoProduto:60, impostoInterno:8, resultado:82, confianca:'confiavel', pendencias:[] }],
    componentes: [
      { tipo:'receita_produto', valor:200, fonte:'orders_api', confianca:'confiavel', obs:null, itemId:'IT1', escopo:'item', efeito:'credito', incluidoNoResultado:true },
      { tipo:'tarifa_venda', valor:30, fonte:'orders_api', confianca:'confiavel', obs:null, itemId:'IT1', escopo:'item', efeito:'debito', incluidoNoResultado:true },
      { tipo:'custo_produto', valor:60, fonte:'base_vinculada', confianca:'confiavel', obs:null, itemId:'IT1', escopo:'item', efeito:'debito', incluidoNoResultado:true },
      { tipo:'imposto_interno', valor:8, fonte:'base_vinculada', confianca:'confiavel', obs:null, itemId:'IT1', escopo:'item', efeito:'debito', incluidoNoResultado:true },
      { tipo:'frete_seller', valor:20, fonte:'shipments_api', confianca:'confiavel', obs:null, itemId:'IT1', escopo:'item', efeito:'debito', incluidoNoResultado:true },
    ],
  }),
  mockPedido({
    pedidoId:'9000000002', rowId:2, data:'2026-08-03', valor:250, frete:25, freteStatus:'real',
    taxas:35, taxasStatus:'real', custo:80, custoStatus:'real', imposto:10,
    resultado:100, resultadoStatus:'real', confianca:'confiavel', unidades:2, full:true,
    multiItem:true, qtdItens:2,
    mlb:'MLBB', sku:'SKU-B', produto:{ mlb:'MLBB', sku:'SKU-B', titulo:'Suporte Articulado Monitor' },
    itens: [
      { id:'IT2', itemId:'IT2', mlb:'MLBB', sku:'SKU-B', titulo:'Suporte Articulado Monitor', quantidade:1, valorUnitario:150, receitaProduto:150, custoProduto:50, impostoInterno:6, resultado:62, confianca:'confiavel', pendencias:[] },
      { id:'IT3', itemId:'IT3', mlb:'MLBC', sku:'SKU-C', titulo:'Luminária LED Mesa', quantidade:1, valorUnitario:100, receitaProduto:100, custoProduto:30, impostoInterno:4, resultado:38, confianca:'confiavel', pendencias:[] },
    ],
    componentes: [
      { tipo:'receita_produto', valor:150, itemId:'IT2', escopo:'item', efeito:'credito', incluidoNoResultado:true, confianca:'confiavel', fonte:'orders_api' },
      { tipo:'receita_produto', valor:100, itemId:'IT3', escopo:'item', efeito:'credito', incluidoNoResultado:true, confianca:'confiavel', fonte:'orders_api' },
      { tipo:'custo_produto', valor:50, itemId:'IT2', escopo:'item', efeito:'debito', incluidoNoResultado:true, confianca:'confiavel', fonte:'base_vinculada' },
      { tipo:'custo_produto', valor:30, itemId:'IT3', escopo:'item', efeito:'debito', incluidoNoResultado:true, confianca:'confiavel', fonte:'base_vinculada' },
      { tipo:'tarifa_venda', valor:35, itemId:null, escopo:'pedido', efeito:'debito', incluidoNoResultado:true, confianca:'confiavel', fonte:'orders_api' },
      { tipo:'frete_seller', valor:25, itemId:null, escopo:'pedido', efeito:'debito', incluidoNoResultado:true, confianca:'confiavel', fonte:'shipments_api' },
      { tipo:'imposto_interno', valor:10, itemId:null, escopo:'pedido', efeito:'debito', incluidoNoResultado:true, confianca:'confiavel', fonte:'base_vinculada' },
    ],
  }),
  mockPedido({
    pedidoId:'9000000003', rowId:3, data:'2026-08-03', valor:180, frete:15, freteStatus:'real',
    taxas:22, taxasStatus:'real', custo:null, custoStatus:'ausente', imposto:null,
    resultado:null, resultadoStatus:'bloqueado', confianca:'bloqueado', unidades:1, full:false,
    mlb:'MLBD', sku:null, produto:{ mlb:'MLBD', sku:null, titulo:'Produto sem base vinculada' },
    pendencias:['custo_produto_ausente', 'imposto_interno_ausente'],
    itens: [{ id:'IT4', itemId:'IT4', mlb:'MLBD', sku:null, titulo:'Produto sem base vinculada', quantidade:1, valorUnitario:180, receitaProduto:180, custoProduto:null, impostoInterno:null, resultado:null, confianca:'bloqueado', pendencias:['custo_produto_ausente'] }],
    componentes: [
      { tipo:'receita_produto', valor:180, itemId:'IT4', escopo:'item', efeito:'credito', incluidoNoResultado:true, confianca:'bloqueado', fonte:'orders_api' },
      { tipo:'tarifa_venda', valor:22, itemId:'IT4', escopo:'item', efeito:'debito', incluidoNoResultado:true, confianca:'bloqueado', fonte:'orders_api' },
      { tipo:'frete_seller', valor:15, itemId:'IT4', escopo:'item', efeito:'debito', incluidoNoResultado:true, confianca:'bloqueado', fonte:'shipments_api' },
    ],
  }),
  mockPedido({
    pedidoId:'9000000004', rowId:4, data:'2026-08-04', valor:90, frete:null, freteStatus:'ausente',
    taxas:null, taxasStatus:'ausente', custo:null, custoStatus:'ausente', imposto:null,
    resultado:null, resultadoStatus:'bloqueado', confianca:'bloqueado', unidades:1, full:false,
    status:'cancelado', statusOriginal:'cancelled', entraNoResultado:false,
    mlb:'MLBA', sku:'SKU-A', produto:{ mlb:'MLBA', sku:'SKU-A', titulo:'Cabo USB-C 2m' },
  }),
  mockPedido({
    pedidoId:'9000000005', rowId:5, data:'2026-08-05', valor:260, frete:20, freteStatus:'real',
    taxas:30, taxasStatus:'real', custo:null, custoStatus:'ausente', imposto:null,
    resultado:null, resultadoStatus:'bloqueado', confianca:'bloqueado', unidades:2, full:true,
    status:'com_problema', statusOriginal:'mediation', entraNoResultado:false, posVendaTipo:'mediacao',
    mlb:'MLBB', sku:'SKU-B', produto:{ mlb:'MLBB', sku:'SKU-B', titulo:'Suporte Articulado Monitor' },
  }),
  mockPedido({
    pedidoId:'9000000006', rowId:6, data:'2026-08-06', valor:130, frete:null, freteStatus:'ausente',
    taxas:18, taxasStatus:'real', custo:40, custoStatus:'real', imposto:5,
    resultado:67, resultadoStatus:'parcial', confianca:'parcial', unidades:1, full:false,
    mlb:'MLBC', sku:'SKU-C', produto:{ mlb:'MLBC', sku:'SKU-C', titulo:'Luminária LED Mesa' },
    pendencias:['frete_seller_ausente'],
    itens: [{ id:'IT5', itemId:'IT5', mlb:'MLBC', sku:'SKU-C', titulo:'Luminária LED Mesa', quantidade:1, valorUnitario:130, receitaProduto:130, custoProduto:40, impostoInterno:5, resultado:67, confianca:'parcial', pendencias:['frete_seller_ausente'] }],
    componentes: [
      { tipo:'receita_produto', valor:130, itemId:'IT5', escopo:'item', efeito:'credito', incluidoNoResultado:true, confianca:'parcial', fonte:'orders_api' },
      { tipo:'tarifa_venda', valor:18, itemId:'IT5', escopo:'item', efeito:'debito', incluidoNoResultado:true, confianca:'parcial', fonte:'orders_api' },
      { tipo:'custo_produto', valor:40, itemId:'IT5', escopo:'item', efeito:'debito', incluidoNoResultado:true, confianca:'parcial', fonte:'base_vinculada' },
      { tipo:'imposto_interno', valor:5, itemId:'IT5', escopo:'item', efeito:'debito', incluidoNoResultado:true, confianca:'parcial', fonte:'base_vinculada' },
    ],
  }),
];

/* Mock só: filtro/ordenação/agregação sobre os campos JÁ prontos acima —
   mesmo formato de saída da Read API real, isolado, nunca chamado fora do
   modo mock explícito (mockModeDevAtivo()). */
const MOCK_STATUS_FORA = new Set(['cancelado', 'com_problema']);
function mockMatchesQuick(o, q) {
  switch (q) {
    case 'sem_custo': return !!o.mlb && o.custoStatus === 'ausente';
    case 'sem_frete': return o.entraNoResultado && o.frete == null;
    case 'frete_real': return o.frete != null;
    case 'calculavel': return o.resultado != null;
    case 'bloqueados': case 'receita_bloqueada': return o.resultadoStatus === 'bloqueado' && o.entraNoResultado;
    case 'cancel_problema': return MOCK_STATUS_FORA.has(o.status);
    case 'full': return o.full === true;
    case 'normal': return o.full !== true;
    default: return true;
  }
}
function mockMatchesStatus(o, s) {
  if (s === 'valido') return o.status === 'pago';
  if (s === 'cancelado') return o.status === 'cancelado';
  if (s === 'problema') return o.status === 'com_problema';
  if (s === 'bloqueado') return o.resultadoStatus === 'bloqueado' && o.entraNoResultado;
  return true;
}
function mockMatchesLogistica(o, l) {
  if (l === 'full') return o.full === true;
  if (l === 'nao_full') return o.full !== true;
  return true;
}
function mockMatchesDiagbase(o, d) {
  if (d === 'com_custo') return o.custoStatus === 'real';
  if (d === 'sem_custo') return o.custoStatus === 'ausente';
  return true;
}
function mockMatchesSearch(o, termo) {
  if (!termo) return true;
  return String(o.id || '').toLowerCase().includes(termo)
    || String(o.mlb || '').toLowerCase().includes(termo)
    || String(o.sku || '').toLowerCase().includes(termo)
    || String(o.produto?.titulo || '').toLowerCase().includes(termo)
    || String(o.status || '').toLowerCase().includes(termo);
}
function mockSort(arr, key) {
  const a = arr.slice();
  const desc = f => (x, y) => (Number(f(y)) || 0) - (Number(f(x)) || 0);
  const asc  = f => (x, y) => (Number(f(x)) || 0) - (Number(f(y)) || 0);
  switch (key) {
    case 'data_asc': a.sort((x, y) => String(x.data).localeCompare(String(y.data))); break;
    case 'fat_desc': a.sort(desc(o => o.valor)); break;
    case 'fat_asc': a.sort(asc(o => o.valor)); break;
    case 'resultado_desc': a.sort(desc(o => o.resultado)); break;
    default: a.sort((x, y) => String(y.data).localeCompare(String(x.data))); break;
  }
  return a;
}
function mockResumo(rows) {
  const validos = rows.filter(o => o.entraNoResultado);
  const comResultado = validos.filter(o => o.resultado != null);
  const faturamento = round2(validos.reduce((s, o) => s + (o.valor || 0), 0));
  const lucroContribuicao = comResultado.length ? round2(comResultado.reduce((s, o) => s + (o.resultado || 0), 0)) : null;
  const somaSe = campo => {
    const c = validos.filter(o => o[campo] != null);
    return c.length ? round2(c.reduce((s, o) => s + (o[campo] || 0), 0)) : null;
  };
  const receitaBloqueada = round2(validos.filter(o => o.confianca === 'bloqueado').reduce((s, o) => s + (o.valor || 0), 0));
  return {
    pedidosTotal: rows.length, pedidosValidos: validos.length, pedidosForaResultado: rows.length - validos.length,
    pedidosConfiaveis: validos.filter(o => o.confianca === 'confiavel').length,
    pedidosParciais: validos.filter(o => o.confianca === 'parcial').length,
    pedidosBloqueados: validos.filter(o => o.confianca === 'bloqueado').length,
    faturamento, lucroContribuicao,
    margemContribuicaoPercentual: lucroContribuicao != null && faturamento > 0 ? round2(lucroContribuicao / faturamento * 100) : null,
    receitaBloqueada, unidades: validos.reduce((s, o) => s + (o.unidades || 0), 0),
    ticket: validos.length ? round2(faturamento / validos.length) : null,
    cancelados: rows.filter(o => o.status === 'cancelado' && o.posVendaTipo !== 'devolucao').length,
    problemas: rows.filter(o => o.status === 'com_problema' && o.posVendaTipo !== 'devolucao').length,
    full: rows.filter(o => o.full === true).length, normal: rows.filter(o => o.full !== true).length,
    comissao: somaSe('taxas'), custoTotal: somaSe('custo'), impostoTotal: somaSe('imposto'), freteTotal: somaSe('frete'),
    semCusto: validos.filter(o => o.mlb && o.custoStatus === 'ausente').length,
    semFrete: validos.filter(o => o.frete == null).length,
    devolucoes: 0, devolucoesParciais: 0, mediacoes: rows.filter(o => o.posVendaTipo === 'mediacao').length,
    claimsIndisponivel: false, claimsReturnsNaoResolvidos: 0,
    pctFatBloqueado: faturamento > 0 ? round2(receitaBloqueada / faturamento * 100) : null,
    cobertura: {
      comissao: faturamento > 0 ? round2(validos.filter(o => o.taxas != null).reduce((s, o) => s + (o.valor || 0), 0) / faturamento * 100) : null,
      custo: faturamento > 0 ? round2(validos.filter(o => o.custo != null).reduce((s, o) => s + (o.valor || 0), 0) / faturamento * 100) : null,
      imposto: faturamento > 0 ? round2(validos.filter(o => o.imposto != null).reduce((s, o) => s + (o.valor || 0), 0) / faturamento * 100) : null,
      frete: faturamento > 0 ? round2(validos.filter(o => o.frete != null).reduce((s, o) => s + (o.valor || 0), 0) / faturamento * 100) : null,
      resultado: faturamento > 0 ? round2(comResultado.reduce((s, o) => s + (o.valor || 0), 0) / faturamento * 100) : null,
    },
    confiancaFechamento: !validos.length || !comResultado.length ? 'insuficiente' : validos.every(o => o.confianca === 'confiavel') ? 'confiavel' : 'parcial',
  };
}
function mockDiario(rows) {
  const map = new Map();
  for (const o of rows) {
    if (!map.has(o.data)) map.set(o.data, { data:o.data, pedidos:0, unidades:0, faturamento:0, comissao:0, custo:0, imposto:0, receitaBloqueada:0, cancelProblema:0, semFrete:0, semCusto:0, _c:false, _cu:false, _i:false, produtosSet:new Set() });
    const d = map.get(o.data);
    d.pedidos += 1;
    if (o.entraNoResultado) {
      d.faturamento += o.valor || 0; d.unidades += o.unidades || 0;
      if (o.mlb) d.produtosSet.add(o.mlb);
      if (o.taxas != null) { d.comissao += o.taxas; d._c = true; }
      if (o.custo != null) { d.custo += o.custo; d._cu = true; }
      if (o.imposto != null) { d.imposto += o.imposto; d._i = true; }
      if (o.frete == null) d.semFrete += 1;
      if (o.mlb && o.custoStatus === 'ausente') d.semCusto += 1;
    }
    if (o.confianca === 'bloqueado' && o.entraNoResultado) d.receitaBloqueada += o.valor || 0;
    if (MOCK_STATUS_FORA.has(o.status)) d.cancelProblema += 1;
  }
  return [...map.values()].sort((a, b) => a.data.localeCompare(b.data)).map(d => ({
    data:d.data, pedidos:d.pedidos, unidades:d.unidades, faturamento:round2(d.faturamento),
    comissao:d._c?round2(d.comissao):null, custo:d._cu?round2(d.custo):null, imposto:d._i?round2(d.imposto):null,
    receitaBloqueada:round2(d.receitaBloqueada), cancelProblema:d.cancelProblema, semFrete:d.semFrete, semCusto:d.semCusto,
    produtos:d.produtosSet.size, topProduto:null,
  }));
}
function mockAbcProdutos(rows) {
  const map = new Map();
  for (const o of rows) {
    const key = o.mlb || '__SEM__';
    if (!map.has(key)) map.set(key, { mlb:o.mlb, sku:o.sku, titulo:o.produto?.titulo || o.mlb, semProduto:!o.mlb, temCusto:o.custoStatus === 'real', custoUnit: (o.custoStatus === 'real' && o.unidades) ? round2(o.custo / o.unidades) : null, unidades:0, pedidos:0, faturamento:0, receitaBloqueada:0, comissao:0, fullP:0, normalP:0 });
    const p = map.get(key);
    p.pedidos += 1;
    if (o.entraNoResultado) { p.unidades += o.unidades || 0; p.faturamento += o.valor || 0; p.comissao += o.taxas || 0; }
    if (o.confianca === 'bloqueado' && o.entraNoResultado) p.receitaBloqueada += o.valor || 0;
    if (o.full === true) p.fullP += 1; else p.normalP += 1;
  }
  const all = [...map.values()].map(p => ({
    mlb:p.mlb, sku:p.sku, titulo:p.titulo, semProduto:p.semProduto, temCusto:p.temCusto, custoUnit:p.custoUnit,
    unidades:p.unidades, pedidos:p.pedidos, faturamento:round2(p.faturamento), receitaBloqueada:round2(p.receitaBloqueada),
    comissao:round2(p.comissao), ticketMedio:p.pedidos>0?round2(p.faturamento/p.pedidos):null,
    logisticaTipo: p.fullP>0 && p.normalP>0 ? 'misto' : p.fullP>0 ? 'full' : p.normalP>0 ? 'normal' : null,
  }));
  const totalFat = round2(all.reduce((s, p) => s + p.faturamento, 0));
  all.forEach(p => { p.pctFat = totalFat > 0 ? round2(p.faturamento / totalFat * 100) : null; });
  const porFat = all.slice().sort((a, b) => b.faturamento - a.faturamento);
  let acc = 0;
  for (const p of porFat) { const prev = acc; acc = round2(acc + (p.pctFat || 0)); p.acumPctFat = acc; p.curva = p.faturamento <= 0 ? null : (prev < 80 ? 'A' : prev < 95 ? 'B' : 'C'); }
  return { produtos: all, totalFat };
}
function buildMockRead(params) {
  const termo = String(params.search || '').trim().toLowerCase();
  const dentro = o => (!params.dataDe || o.data >= params.dataDe) && (!params.dataAte || o.data <= params.dataAte);
  const filtrados = MOCK_ROWS.filter(dentro)
    .filter(o => mockMatchesQuick(o, params.filtro || 'todos'))
    .filter(o => mockMatchesStatus(o, params.status || 'todos'))
    .filter(o => mockMatchesLogistica(o, params.logistica || 'todos'))
    .filter(o => mockMatchesDiagbase(o, params.diagbase || 'todos'))
    .filter(o => mockMatchesSearch(o, termo));
  const ordenados = mockSort(filtrados, params.sort || 'data_desc');
  const limit = Number(params.limit) || 50;
  const page = Number(params.page) || 1;
  const total = ordenados.length;
  const totalPages = total ? Math.ceil(total / limit) : 0;
  const inicio = (page - 1) * limit;
  const rows = ordenados.slice(inicio, inicio + limit).map(({ itens, componentes, ...resto }) => resto);
  return {
    ok: true, cliente: F.cliente || { id:0, nome:'Cliente simulado', slug: params.slug || '' }, periodo: MOCK_PERIODO,
    contexto: null, snapshot: { importId: 1, fonte: 'orders_api', publicationStatus: 'published' },
    motor: { status:'mock', etapaAtual:'simulacao_local', progresso:100, confianca:'parcial', podeConcluir:false,
             motivoBloqueio:'Dados simulados — o backend não respondeu.', geradoEm:new Date().toISOString(), origemPrincipal:'mock_conciliacao_fechamento_api' },
    completude: null,
    summary: mockResumo(MOCK_ROWS), filteredSummary: mockResumo(MOCK_ROWS.filter(o => mockMatchesQuick(o, params.resumoFiltro || 'todos'))),
    rows, pagination: { page, limit, total, totalPages },
  };
}
function buildMockDaily() {
  return { ok: true, dias: mockDiario(MOCK_ROWS) };
}
function buildMockProducts() {
  const { produtos, totalFat } = mockAbcProdutos(MOCK_ROWS);
  return { ok: true, produtos, totalFaturamento: totalFat };
}
function buildMockOrderDetail(rowId) {
  const pedido = MOCK_ROWS.find(o => o.rowId === Number(rowId));
  return pedido ? { ok: true, pedido } : { ok: false, erro: 'Pedido não encontrado no mock.' };
}

/* ── ESTADO ───────────────────────────────────────────────────
   F guarda o que a Read API M9 devolveu, nada recalculado:
     F.summary          → resumo GLOBAL do período (sempre igual entre
                           páginas/filtros — M7, seção 10)
     F.filteredSummary  → resumo do recorte da Visão Geral
                           (F.summary.quickFilter), contrato distinto
     F.rows/F.pagination→ página atual da tabela de Pedidos
     F.daily            → agregado diário (/read/daily), período inteiro
     F.products          → Curva ABC agregada (/read/products), período inteiro
   Os pedidos nunca são duplicados/recalculados: cada seção lê exatamente o
   que o backend devolveu. */
function defaultOrderFilters() { return { logistica:'todos', diagbase:'todos', status:'todos', de:null, ate:null }; }
const F = {
  // F2.2 — cliente/contas/clienteConta NÃO são mais resolvidos aqui: vêm de
  // window.VF.context (Shell V3), espelhados por aplicarContextoDoShell().
  // O "motor" abaixo (fetchRead/carregarTela/atualizarListaEResumo/sync)
  // continua lendo F.cliente.slug e F.clienteConta.id exatamente como
  // antes — só quem os escreve mudou.
  cliente: null,
  contas: [], clienteConta: null,
  periodo: null,          // { mode, dateFrom, dateTo } — período de análise escolhido na UI
  periodoResp: null,      // periodo ecoado pela Read API (mesmo intervalo, rótulo formatado)

  ok: null,               // null = nada carregado ainda · true/false = último /read
  erro: null,
  motor: null, completude: null, snapshot: null, contexto: null,
  summary: null, filteredSummary: null,
  rows: [], pagination: null,
  daily: [], products: [], totalFaturamento: 0,

  lastSyncBase: null,
  sync: { runId: null, timer: null, clienteSlug: null, clienteContaId: null },

  // MP3 — Conciliação Mercado Pago: carga própria, assíncrona, NUNCA bloqueia
  // carregarTela()/renderAll() principal (seção 13/15 do spec MP3).
  mp: { loading: false, loadSeq: 0, data: null, rowsByOrderId: null },

  loadSeq: 0, loadAbort: null, loading: false,     // carga PRINCIPAL (cliente/conta/período)
  arquivoImport: null,

  ui: {
    activeTab: 'visao',
    drawerRowId: null,
    drawerReturnFocusId: null,
    drawerLoadSeq: 0,
    filtersPanelOpen: false,
    importPanelOpen: false,
  },

  orders: {
    filters: defaultOrderFilters(),
    quickFilter: 'todos',
    search: '',
    searchTimer: null,
    sort: 'data_desc',
    page: 1, pageSize: 100,
    loadSeq: 0, loadAbort: null, loading: false,   // carga da LISTA (filtro/busca/ordenação/página/dia)
  },

  summaryUi: {
    quickFilter: 'todos',      // recorte da Visão Geral (Composição/Qualidade) — vira resumoFiltro
    dailySort: 'data',
  },

  abc: {                       // estado do módulo Curva ABC — navegação sobre F.products
    group: 'todos', sort: 'faturamento', search: '', searchTimer: null,
    page: 1, pageSize: 50,
  },
};

/* ── FETCH — Read API M9 (única fonte de verdade) ────────────
   Mock só é usado se explicitamente ligado neste navegador (nunca
   automático após erro real de backend): localStorage 'vf-fapi-mock-dev'. */
function mockModeDevAtivo() {
  try { return localStorage.getItem('vf-fapi-mock-dev') === '1'; }
  catch (_) { return false; }
}
const HTTP_ERRO_MSG = {
  401: 'Sessão expirada. Faça login novamente.',
  403: 'Você não tem permissão para acessar estes dados.',
};
/* GET genérico contra a Central de Vendas: devolve o JSON quando ok, ou um
   objeto { ok:false, erro, erroTipo, contas? } — nunca lança. */
async function fetchCentralVendas(path, params, signal) {
  let res;
  try {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== null && v !== undefined && v !== '') qs.set(k, v);
    }
    res = await fetch(`${API_BASE}${path}?${qs.toString()}`, { headers: { Authorization: 'Bearer ' + TOKEN }, signal });
  } catch (err) {
    if (err?.name === 'AbortError') return null; // cancelado por troca de contexto — silencioso
    console.error(`[fechamentos-api] falha de rede em ${path}:`, err);
    return { ok:false, erro:'Falha de conexão com o servidor.', erroTipo:'rede' };
  }

  if (!res.ok) {
    const texto = await res.text().catch(() => '');
    let corpoJson = null;
    try { corpoJson = JSON.parse(texto); } catch (_) { /* corpo nao e JSON */ }
    if (res.status === 409 && corpoJson?.code === 'MULTIPLE_MARKETPLACE_ACCOUNTS') {
      return { ok:false, erro: corpoJson.erro || 'Selecione a conta.', erroTipo:'ambiguidade_conta', contas: corpoJson.contas || [] };
    }
    if (res.status === 401) { window.location.replace('index.html'); return null; }
    const corpo = corpoJson?.erro || corpoJson?.message || corpoJson?.error || (corpoJson ? JSON.stringify(corpoJson) : texto);
    const mensagem = HTTP_ERRO_MSG[res.status] || corpo || `Erro ${res.status} em ${path}.`;
    console.error(`[fechamentos-api] HTTP ${res.status} em ${path}:`, corpo);
    return { ok:false, erro:mensagem, erroTipo:'http', httpStatus:res.status };
  }

  try {
    const data = await res.json();
    if (!data || data.ok !== true) return { ok:false, erro: data?.erro || 'Backend retornou um payload inválido.', erroTipo:'payload_invalido' };
    return data;
  } catch (err) {
    console.error(`[fechamentos-api] resposta inválida (JSON) em ${path}:`, err);
    return { ok:false, erro:'Resposta inválida do servidor.', erroTipo:'json_invalido' };
  }
}

function contextoParams(extra) {
  return {
    dateFrom: F.periodo?.dateFrom, dateTo: F.periodo?.dateTo,
    clienteContaId: F.clienteConta?.id || null,
    ...extra,
  };
}

async function fetchRead(params, signal) {
  const resp = await fetchCentralVendas(`/operacao/central-vendas/${encodeURIComponent(F.cliente.slug)}/read`, params, signal);
  if (resp === null) return null;
  if (!resp.ok && mockModeDevAtivo() && resp.erroTipo !== 'ambiguidade_conta') return buildMockRead({ ...params, slug: F.cliente.slug });
  return resp;
}
async function fetchDaily(signal) {
  const resp = await fetchCentralVendas(`/operacao/central-vendas/${encodeURIComponent(F.cliente.slug)}/read/daily`, contextoParams(), signal);
  if (resp === null) return null;
  if (!resp.ok && mockModeDevAtivo()) return buildMockDaily();
  return resp;
}
async function fetchProducts(signal) {
  const resp = await fetchCentralVendas(`/operacao/central-vendas/${encodeURIComponent(F.cliente.slug)}/read/products`, contextoParams(), signal);
  if (resp === null) return null;
  if (!resp.ok && mockModeDevAtivo()) return buildMockProducts();
  return resp;
}
async function fetchOrderDetail(rowId, signal) {
  const resp = await fetchCentralVendas(`/operacao/central-vendas/${encodeURIComponent(F.cliente.slug)}/read/orders/${encodeURIComponent(rowId)}`, contextoParams(), signal);
  if (resp === null) return null;
  if (!resp.ok && mockModeDevAtivo()) return buildMockOrderDetail(rowId);
  return resp;
}
/* MP3 — conciliação Mercado Pago (resultadoConciliadoMp), range-aware. Sem
   fallback de mock: é uma camada auxiliar (seção 19 do spec MP3) — se
   falhar, a Central inteira continua funcionando normalmente, só esta
   seção fica indisponível. */
/* Hardening final MP3 (ponto 1) — full=1 pede o índice COMPLETO do range
   numa única execução backend (summary + rows de TODO período, sem depender
   de paginação), nunca só os primeiros 200 — necessário para o drawer achar
   qualquer pedido do período, mesmo além da posição 200/da paginação da
   tabela principal de Pedidos. Continua 1 unica request, sem N+1. */
async function fetchMercadoPagoReconciliation(signal) {
  const resp = await fetchCentralVendas(`/operacao/central-vendas/${encodeURIComponent(F.cliente.slug)}/read/mercado-pago/reconciliation`, contextoParams({ full: 1 }), signal);
  return resp;
}
/* Carga PRÓPRIA, disparada depois do conteúdo principal (nunca await'ada
   por carregarTela) — nunca trava a tela principal se o Mercado Pago
   estiver lento/indisponível. */
async function carregarConciliacaoMercadoPago() {
  if (!F.cliente || (F.contas.length > 1 && !F.clienteConta) || !F.periodo) {
    F.mp.loading = false; F.mp.data = null; F.mp.rowsByOrderId = null;
    renderMercadoPagoSection();
    return;
  }
  const seq = ++F.mp.loadSeq;
  F.mp.loading = true;
  renderMercadoPagoSection();

  const resp = await fetchMercadoPagoReconciliation();
  if (seq !== F.mp.loadSeq) return; // contexto trocou antes da resposta

  F.mp.loading = false;
  F.mp.data = (resp && resp.ok) ? resp : null;
  F.mp.rowsByOrderId = F.mp.data
    ? new Map((F.mp.data.rows || []).map(r => [String(r.orderId), r]))
    : null;
  renderMercadoPagoSection();
}
/* M10 — carga inicial em 1 request (backend resolve contexto + constrói o
   payload do período 1x só, deriva read+daily+products no mesmo processo).
   Fallback defensivo: se a rota nova falhar por qualquer motivo que não seja
   ambiguidade de conta (servidor antigo sem a rota, erro de rede pontual),
   refaz pelo caminho antigo (3 requests, cada um com seu próprio fallback de
   mock dev mode) — nunca perde a tela por causa da otimização. */
async function fetchBootstrap(params, signal) {
  const resp = await fetchCentralVendas(`/operacao/central-vendas/${encodeURIComponent(F.cliente.slug)}/read/bootstrap`, params, signal);
  if (resp === null) return null;
  if (resp.ok || resp.erroTipo === 'ambiguidade_conta') return resp;

  const [readResp, dailyResp, productsResp] = await Promise.all([
    fetchRead(params, signal),
    fetchDaily(signal),
    fetchProducts(signal),
  ]);
  if (!readResp?.ok) return readResp;
  return {
    ...readResp,
    dias: dailyResp?.ok ? (dailyResp.dias || []) : [],
    produtos: productsResp?.ok ? (productsResp.produtos || []) : [],
    totalFaturamento: productsResp?.ok ? (productsResp.totalFaturamento || 0) : 0,
  };
}

/* ── INIT ─────────────────────────────────────────────────── */
function isAdminUser() {
  try { return (JSON.parse(localStorage.getItem('vf-user') || '{}').role) === 'admin'; }
  catch (_) { return false; }
}

function initFechamentosApi() {
  // F2.2 — a lista de clientes e a resolução de cliente/conta são do Shell
  // V3 agora (aplicarContextoDoShell(), já assinando `vf:context` desde o
  // topo do arquivo). Esta função só cuida do que continua local à página:
  // período, visibilidade de ações admin, aba restaurada do hash.
  const periodSel = document.getElementById('fapi-period-select');
  if (periodSel) {
    periodSel.innerHTML = PERIOD_OPTS.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    F.periodo = computePeriodo('mes_atual');
    periodSel.value = 'mes_atual';
  }

  if (isAdminUser()) {
    document.getElementById('fapi-sync-btn')?.removeAttribute('hidden');
    document.getElementById('fapi-import-toggle')?.removeAttribute('hidden');
  }

  const hashTab = { '#visao-geral':'visao', '#pedidos':'pedidos', '#produtos':'produtos' }[window.location.hash];
  if (hashTab) F.ui.activeTab = hashTab;

  wireStatic();
  // Não chama carregarTela() aqui: o listener de 'vf:context' já recebeu
  // (ou vai receber, síncrono) o primeiro emit("boot") de vf-context.js e
  // aplicarContextoDoShell() chama carregarTela() sozinho.
}

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
  F.orders.filters = defaultOrderFilters();
  F.orders.quickFilter = 'todos';
  F.orders.search = '';
  F.orders.sort = 'data_desc';
  F.orders.page = 1;
  F.ui.filtersPanelOpen = false;
  F.summaryUi.quickFilter = 'todos';
  F.summaryUi.dailySort = 'data';
  resetCurvaAbcState();
}

/* ── CONTEXTO (F2.2 — vem do Shell V3, não mais desta tela) ───
   window.VF.context é a máquina de estados de vf-context.js (F0.3): ela já
   resolve cardinalidade (1 conta ativa → auto; 2+ → escolha explícita;
   0 → NO_ACTIVE_ACCOUNT), dedupe de fan-out (I6) e validação de posse/
   atividade — nada disso é reimplementado aqui (R8: a regra de
   cardinalidade mora só em vf-context.js).

   fechamentos-api.js roda como <script> CLÁSSICO (não-module), carregado
   ANTES do vf-shell.js (module, deferred) terminar de executar — não dá
   para `import` nem assinar window.VF.context.subscribe() direto na hora
   em que este arquivo é avaliado. A ponte documentada para esse caso
   (MASTER_SPEC §6.5/§15.3) é o evento DOM `vf:context`, que vf-context.js
   dispara a cada emit() — inclusive o primeiro, síncrono, dentro de
   init(). Registrar o listener AQUI (antes do módulo rodar) garante que
   nenhum emit é perdido, sem polling. */
let ultimoContextoAplicado = Symbol('contexto-nao-aplicado-ainda'); // difere de qualquer chave real ou de `null`
function aplicarContextoDoShell(snap) {
  const ctx = window.VF?.context;
  const pronto = ctx && snap.state === ctx.STATES.READY;

  // clienteAtual/F.contas dependem só de ctx.clienteId estar setado — não
  // de READY. Em ACCOUNT_CHOICE_REQUIRED o cliente JÁ é conhecido (só a
  // conta está pendente) e ctx.getAccounts() já tem as contas resolvidas;
  // gatear os dois atrás de `pronto` faria carregarTela() cair no ramo
  // "!F.cliente" ("selecione um cliente") em vez do ramo certo
  // ("selecione a operação") — invisível hoje (o Shell já esconde #fapi-main
  // nesse estado), mas incorreto internamente, e visível no VM sandbox de
  // server/tests/fechamentosApiAccountAware.test.js, que chama esta função
  // direto, sem o gating do shell por cima.
  const clienteAtual = ctx && snap.context ? ctx.getClienteAtual() : null;
  const contaMeta = pronto ? ctx.getAccountMeta() : null;
  const chave = pronto && snap.context ? `${snap.context.clienteSlug}:${snap.context.clienteContaId}` : null;

  F.cliente = clienteAtual ? { id: clienteAtual.id, slug: clienteAtual.slug, nome: clienteAtual.nome } : null;
  F.contas = clienteAtual && ctx.getAccounts ? ctx.getAccounts().filter(c => c?.ativo !== false) : [];
  F.clienteConta = contaMeta ? { id: contaMeta.id, nome: contaMeta.nome } : null;

  if (chave === ultimoContextoAplicado) return; // mesmo cliente+conta — nada novo para carregar (ex.: flag de integração)
  ultimoContextoAplicado = chave;

  pararPollingSync();
  closeOrderDrawer({ restoreFocus: false });
  F.lastSyncBase = null;
  resetFilters();
  carregarTela();
  if (pronto) retomarSyncEmAndamento();
}
document.addEventListener('vf:context', e => aplicarContextoDoShell(e.detail));

/* ── CARREGAMENTO — Read API M9/M10 ───────────────────────────
   Dois pontos de fetch:
     carregarTela()          → troca de cliente/conta/período: busca
                                summary+rows(pág.1)+daily+products em 1
                                request (/read/bootstrap, M10 — backend
                                resolve contexto e constrói o payload do
                                período 1x só, em vez de 3x). Fallback
                                automático para os 3 endpoints antigos em
                                paralelo se o bootstrap falhar.
     atualizarListaEResumo() → qualquer filtro/busca/ordenação/página da
                                aba Pedidos OU recorte da Visão Geral: só
                                refaz /read (rows+summary+filteredSummary);
                                daily/products não dependem desses filtros,
                                não são refeitos.
   Guard de concorrência (loadSeq) + AbortController em cada um — resposta
   antiga nunca sobrescreve estado novo. */
function resetDataState() {
  F.ok = null; F.erro = null; F.motor = null; F.completude = null; F.snapshot = null; F.contexto = null;
  F.summary = null; F.filteredSummary = null; F.rows = []; F.pagination = null;
  F.daily = []; F.products = []; F.totalFaturamento = 0; F.periodoResp = null;
  F.mp.loadSeq += 1; F.mp.loading = false; F.mp.data = null; F.mp.rowsByOrderId = null;
}

function applyReadResponse(resp) {
  if (!resp?.ok) {
    F.ok = false; F.erro = resp?.erro || 'O backend do motor não respondeu para este cliente/período.';
    F.summary = null; F.filteredSummary = null; F.rows = []; F.pagination = null;
    F.motor = null; F.completude = null; F.snapshot = null; F.contexto = null; F.periodoResp = null;
    return;
  }
  F.ok = true; F.erro = null;
  F.summary = resp.summary; F.filteredSummary = resp.filteredSummary;
  F.rows = resp.rows; F.pagination = resp.pagination;
  F.motor = resp.motor; F.completude = resp.completude; F.snapshot = resp.snapshot; F.contexto = resp.contexto;
  F.periodoResp = resp.periodo;
}

function buildReadParams(extra) {
  return contextoParams({
    page: F.orders.page, limit: F.orders.pageSize, sort: F.orders.sort,
    filtro: F.orders.quickFilter, status: F.orders.filters.status,
    logistica: F.orders.filters.logistica, diagbase: F.orders.filters.diagbase,
    search: F.orders.search, dataDe: F.orders.filters.de, dataAte: F.orders.filters.ate,
    resumoFiltro: F.summaryUi.quickFilter,
    ...extra,
  });
}

/* ÚNICO ponto de fetch "pesado" (1 endpoint, /read/bootstrap — M10). Só deve
   ser chamado em: init, troca de cliente/conta/período, "Atualizar leitura"
   e depois de importar/sincronizar. */
async function carregarTela() {
  if (!F.cliente) { resetDataState(); F.loading = false; renderAll(); return; }
  if (F.contas.length > 1 && !F.clienteConta) { resetDataState(); F.loading = false; renderAll(); return; }
  if (!F.periodo) F.periodo = computePeriodo('mes_atual');

  const seq = ++F.loadSeq;
  if (F.loadAbort) { try { F.loadAbort.abort(); } catch (_) {} }
  F.loadAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const signal = F.loadAbort?.signal;

  F.loading = true;
  renderAll();

  F.orders.page = 1;
  const bootstrapResp = await fetchBootstrap(buildReadParams({ page: 1 }), signal);
  if (seq !== F.loadSeq) return;

  F.loading = false;

  if (bootstrapResp?.erroTipo === 'ambiguidade_conta') {
    // A cardinalidade é do Shell (vf-context.js), não mais desta tela —
    // devolve o sinal para lá; a máquina de estados zera a conta e abre
    // ACCOUNT_CHOICE_REQUIRED, o que reemite vf:context e passa de novo
    // por aplicarContextoDoShell() com F.contas/F.clienteConta corretos.
    window.VF?.context?.signalContextError({ code: 'CONTA_AMBIGUA' });
    resetDataState();
    renderAll();
    return;
  }

  applyReadResponse(bootstrapResp);
  F.daily = bootstrapResp?.ok ? (bootstrapResp.dias || []) : [];
  F.products = bootstrapResp?.ok ? (bootstrapResp.produtos || []) : [];
  F.totalFaturamento = bootstrapResp?.ok ? (bootstrapResp.totalFaturamento || 0) : 0;
  resetCurvaAbcState();
  renderAll();

  // MP3 — nunca aguardada: conteúdo principal já está na tela; a conciliação
  // Mercado Pago carrega à parte e se auto-renderiza quando chegar.
  if (F.ok) carregarConciliacaoMercadoPago();
}

/* Refaz só a lista de pedidos + os dois resumos (summary/filteredSummary) —
   nunca daily/products, que não dependem de filtro/busca/página. */
async function atualizarListaEResumo({ resetPage = false } = {}) {
  if (!F.cliente || (F.contas.length > 1 && !F.clienteConta) || !F.periodo) return;
  if (resetPage) F.orders.page = 1;

  const seq = ++F.orders.loadSeq;
  if (F.orders.loadAbort) { try { F.orders.loadAbort.abort(); } catch (_) {} }
  F.orders.loadAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  F.orders.loading = true;
  renderPedTable();

  const resp = await fetchRead(buildReadParams({}), F.orders.loadAbort?.signal);
  if (seq !== F.orders.loadSeq) return;
  F.orders.loading = false;

  if (resp?.erroTipo === 'ambiguidade_conta') {
    window.VF?.context?.signalContextError({ code: 'CONTA_AMBIGUA' });
    resetDataState();
    renderAll();
    return;
  }
  if (!resp?.ok) {
    setActionStatus(resp?.erro || 'Falha ao atualizar pedidos.', ACTION_TONE.danger);
    renderPedTable();
    return;
  }

  applyReadResponse(resp);
  renderTabCounts();
  renderContextStatus();
  renderFechamentoSection();
  renderPedTable();
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

  // F2.2 — estas duas condições já são bloqueadas pelo próprio Shell V3
  // (data-vf-scope="account" só libera main quando READY, MASTER_SPEC
  // §5.4); ficam como rede de segurança, nunca visíveis na prática.
  if (!F.cliente) {
    showPanels(false);
    stateHost.hidden = false;
    stateHost.innerHTML = emptyState({
      icon:'target', title:'Selecione um cliente para abrir a Central de Vendas',
      why:'O fechamento por pedido é sempre por cliente e por período de análise.',
      next:'Escolha um cliente e uma operação na barra lateral.',
    });
    return;
  }

  if (F.contas.length > 1 && !F.clienteConta) {
    showPanels(false);
    stateHost.hidden = false;
    stateHost.innerHTML = emptyState({
      icon:'target', title:'Selecione a operação',
      why:'Este cliente tem mais de uma operação ativa — a Central precisa saber qual conta ler antes de mostrar qualquer número.',
      next:'Escolha a operação na barra lateral.',
    });
    return;
  }

  if (F.loading) {
    showPanels(false);
    stateHost.hidden = false;
    stateHost.innerHTML = loadingState();
    return;
  }

  if (!F.ok) {
    showPanels(false);
    stateHost.hidden = false;
    stateHost.innerHTML = emptyState({
      icon:'plug', tone:'is-danger', title:'Motor indisponível',
      why: F.erro || 'O backend do motor não respondeu para este cliente/período.',
      next:'Tente novamente em instantes ou use "Atualizar leitura".',
    });
    return;
  }

  stateHost.hidden = true;
  stateHost.innerHTML = '';
  if (tabs) tabs.hidden = false;
  renderTabCounts();
  renderFechamentoSection();
  renderMercadoPagoSection();
  renderDaysSection();
  renderOrdersPanel();
  renderAbc();
  setActiveTab(F.ui.activeTab, { updateHash: false, focus: false });
}

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
const FONTE_LABEL = { orders: 'Orders', shipments: 'Fretes', claims: 'Pós-venda', returns: 'Devoluções', base: 'Base' };

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

  const motorStatus = F.ok ? (F.motor?.status || 'indisponivel') : 'indisponivel';
  const [cls, label] = MOTOR[motorStatus] || MOTOR.indisponivel;
  const isMock = motorStatus === 'mock';
  if (mockBanner) mockBanner.hidden = !isMock;

  const parts = [item('Motor', `<span class="vf-status ${cls}">${esc(label)}</span>`)];
  if (F.ok) {
    if (F.motor?.confianca && F.motor.confianca !== 'ausente') parts.push(item('Confiança', confStatus(F.motor.confianca)));
    const origem = F.motor?.origemPrincipal;
    if (origem) parts.push(item('Origem', `<b>${esc(ORIGEM_LBL[origem] || origem)}</b>`));
    if (F.motor?.geradoEm) parts.push(item('Gerado em', `<b>${esc(fmtDtHr(F.motor.geradoEm))}</b>`));
    if (F.motor?.importId != null) parts.push(item('Import', `<span class="vf-mono">#${esc(F.motor.importId)}</span>`));
    if (F.periodoResp?.label) parts.push(item('Intervalo', `<b>${esc(F.periodoResp.label)}</b>`));
    if (F.clienteConta && F.contas.length > 1) parts.push(item('Conta', `<b>${esc(F.clienteConta.nome || F.clienteConta.slug)}</b>`));
    if (F.lastSyncBase?.nome) parts.push(item('Base vinculada', `<b>${esc(F.lastSyncBase.nome)}</b>`));
    if (F.summary?.claimsIndisponivel) {
      parts.push(item('Pós-venda', '<span class="vf-status is-warning">Não verificado</span>'));
    }
    if (F.completude && F.completude.status && F.completude.status !== 'complete') {
      const fontes = (F.completude.fontesIncompletas || []).map(f => FONTE_LABEL[f] || f).join(', ');
      parts.push(item('Completude', `<span class="vf-status is-warning">${esc(fontes ? `Parcial (${fontes})` : 'Parcial')}</span>`));
    }
  }
  host.innerHTML = parts.join('');
}

function renderTabCounts() {
  const pc = document.getElementById('fapi-tab-pedidos-count');
  const gc = document.getElementById('fapi-tab-produtos-count');
  const pedidosTotal = F.summary?.pedidosTotal || 0;
  const produtosTotal = F.products.filter(p => !p.semProduto).length;
  if (pc) { pc.hidden = !pedidosTotal; pc.textContent = num(pedidosTotal); }
  if (gc) { gc.hidden = !produtosTotal; gc.textContent = num(produtosTotal); }
}

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
   Tudo lido de F.summary (global) / F.filteredSummary (recorte da Visão
   Geral, F.summaryUi.quickFilter) — nenhum cálculo aqui, só formatação. */
const FECH_QUICKS = [
  ['todos', 'Todos'], ['sem_custo', 'Sem custo'], ['sem_frete', 'Sem frete'],
  ['bloqueados', 'Bloqueados'], ['calculavel', 'Calculáveis'],
];
/* Contagem de cada chip: sempre sobre o período INTEIRO (F.summary global),
   igual ao comportamento anterior (rAll era o payload inteiro, nunca
   escopado pela busca/filtro da tabela de pedidos). */
function fechQuickCount(k, s) {
  switch (k) {
    case 'sem_custo': return s.semCusto;
    case 'sem_frete': return s.semFrete;
    case 'bloqueados': return s.pedidosBloqueados;
    case 'calculavel': return Math.max(0, s.pedidosValidos - s.pedidosBloqueados);
    default: return s.pedidosTotal;
  }
}

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

/* Linhas da "Composição do resultado" — formatação sobre os agregados já
   prontos de F.filteredSummary (comissao/custoTotal/impostoTotal/freteTotal/
   lucroContribuicao/receitaBloqueada), nunca uma fórmula HTML/JS paralela. */
function buildComposicaoRows(s) {
  const foraDoCalculo = Math.max(0, s.pedidosValidos - (s.pedidosConfiaveis + s.pedidosParciais));
  return [
    { comp:'Receita de produtos', op:'+', valor: s.faturamento,
      status: s.faturamento > 0 ? 'real' : 'ausente', fonte:'orders_api', obs:'soma do valor dos pedidos válidos' },
    { comp:'Receita bloqueada fora do cálculo', op:'−', valor: s.receitaBloqueada === 0 ? 0 : -s.receitaBloqueada,
      status: foraDoCalculo ? 'parcial' : 'real', fonte:'cálculo interno',
      obs: foraDoCalculo ? `${num(foraDoCalculo)} pedido(s) sem custo/produto — receita existe, resultado não é calculável` : 'nenhum pedido válido bloqueado' },
    { comp:'Tarifa marketplace', op:'−', valor: s.comissao == null ? null : -s.comissao,
      status: s.comissao == null ? 'ausente' : 'real', fonte:'orders_api', obs:'comissão (sale_fee) dos pedidos calculáveis' },
    { comp:'Custo dos produtos', op:'−', valor: s.custoTotal == null ? null : -s.custoTotal,
      status: s.custoTotal == null ? 'ausente' : 'real', fonte:'base vinculada',
      obs: s.semCusto > 0 ? `${num(s.semCusto)} pedido(s) sem custo na base ficaram na linha bloqueada` : 'custo unitário × unidades' },
    { comp:'Imposto interno', op:'−', valor: s.impostoTotal == null ? null : -s.impostoTotal,
      status: s.impostoTotal == null ? 'ausente' : 'real', fonte:'cálculo interno', obs:'imposto % da base × receita dos pedidos calculáveis' },
    { comp:'Frete seller', op:'−', valor: s.freteTotal == null ? null : -s.freteTotal,
      status: s.freteTotal == null ? 'ausente' : (s.semFrete > 0 ? 'parcial' : 'real'),
      fonte: s.freteTotal == null ? 'pendente' : 'shipments_api',
      obs: s.freteTotal == null ? 'nenhum envio retornou custo (shipments API)' : (s.semFrete > 0 ? `${num(s.semFrete)} pedido(s) calculáveis sem frete real` : 'custo final do seller (shipments costs)') },
    { comp:'Resultado parcial', op:'=', valor: s.lucroContribuicao,
      status: s.lucroContribuicao == null ? 'ausente' : (s.confiancaFechamento === 'confiavel' ? 'real' : 'parcial'), fonte:'cálculo interno',
      obs: s.confiancaFechamento === 'confiavel' ? 'todos os componentes reais' : (s.semFrete > 0 || s.freteTotal == null ? 'parcial — frete incompleto' : 'parcial — falta custo em parte') },
  ];
}
/* Resíduo: soma das linhas (exceto o total) menos o Resultado Parcial —
   formatação de auditoria sobre os mesmos agregados, não um novo cálculo
   independente (deve bater com o que o backend já persistiu). */
function composicaoResiduo(comps) {
  const total = comps.find(c => c.op === '=');
  if (!total || total.valor == null) return null;
  const soma = comps.filter(c => c.op !== '=').reduce((s, c) => s + (Number(c.valor) || 0), 0);
  return round2(soma - total.valor);
}

function renderFechamentoSection() {
  const host = document.getElementById('fapi-fech-host');
  if (!host || !F.ok) return;
  const rAll = F.summary;
  const fonteTxt = (F.motor?.origemPrincipal === 'orders_api') ? 'orders_api · central_vendas_db' : esc(F.motor?.origemPrincipal || 'central_vendas_db');
  const headerMeta = `${esc(F.periodoResp?.label || '')} · ${esc(F.cliente?.nome || '')} · fonte: ${fonteTxt}`;

  if (!rAll.pedidosTotal) {
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

  const quick = F.summaryUi.quickFilter;
  const s = F.filteredSummary || rAll;
  const chips = FECH_QUICKS.map(([k, l]) => {
    const count = fechQuickCount(k, rAll);
    return `<button type="button" class="vf-filter-chip${quick === k ? ' is-active' : ''}" data-fechq="${k}" aria-pressed="${quick === k}">${esc(l)} <span class="vf-badge">${num(count)}</span></button>`;
  }).join('');
  const clearBtn = quick !== 'todos'
    ? '<button type="button" class="vf-clear-filters" data-fechq="todos">Limpar recorte</button>' : '';
  const recorteBar = `<div class="vf-fapi-fech-chips" role="group" aria-label="Recorte do fechamento">${chips}${clearBtn}</div>`;
  const claimsMotivo = String(rAll.claimsMotivo || 'motivo_nao_informado');
  const claimsSemPermissao = claimsMotivo === 'http_401' || claimsMotivo === 'http_403';
  const claimsPermissaoHint = claimsSemPermissao
    ? ' O código indica <strong>falta de permissão</strong>: a aplicação pode não ter acesso a Post Purchase/Claims (tópico habilitado em "Minhas aplicações", no painel do Mercado Livre).'
    : '';
  const returnsNaoResolvidos = Number(rAll.claimsReturnsNaoResolvidos) || 0;
  const posVendaWarning = rAll.claimsIndisponivel
    ? `<div class="vf-banner is-warning vf-banner--compact" role="alert">
        <div class="vf-banner__content">
          <p class="vf-banner__title">Pós-venda não verificado</p>
          <p class="vf-banner__description">A consulta de claims do Mercado Livre não foi concluída (<strong>motivo: ${esc(claimsMotivo)}</strong>).${claimsPermissaoHint} Devoluções e mediações podem estar ausentes; por segurança, a confiança deste fechamento permanece parcial.</p>
        </div>
      </div>`
    : returnsNaoResolvidos > 0
      ? `<div class="vf-banner is-warning vf-banner--compact" role="alert">
        <div class="vf-banner__content">
          <p class="vf-banner__title">Pós-venda verificado parcialmente</p>
          <p class="vf-banner__description">A consulta de claims foi concluída, mas <strong>${num(returnsNaoResolvidos)}</strong> devolução(ões) não puderam ser ligadas a um pedido (detalhe de returns indisponível). Esses casos <strong>não</strong> foram tratados como "sem devolução"; a confiança permanece parcial.</p>
        </div>
      </div>`
      : '';

  let corpo;
  if (!s.pedidosTotal) {
    corpo = `<div class="vf-card"><div class="vf-card__body">${emptyState({
      icon:'dot', title:'Nenhum pedido neste recorte',
      why:'O recorte selecionado não tem pedidos.',
      next:'Volte para "Todos".',
    })}</div></div>`;
  } else {
    const parcialFoot = s.confiancaFechamento === 'confiavel'
      ? 'todos componentes reais'
      : (s.cobertura?.resultado != null ? `parcial · cobre ${pct(s.cobertura.resultado)} da receita` : 'parcial');
    const kpis = `<div class="vf-kpi-grid" role="list" aria-label="Indicadores principais do fechamento">
      ${kpi({ label:'Faturamento bruto', valueHtml: kpiValueHtml(s.faturamento, { currency:true }), foot:'pedidos válidos', mod:'vf-kpi--featured' })}
      ${kpi({ label:'Resultado parcial', valueHtml: kpiValueHtml(s.lucroContribuicao, { currency:true }), foot: parcialFoot, footTone: s.confiancaFechamento === 'confiavel' ? 'is-success' : 'is-warning', mod: s.confiancaFechamento === 'confiavel' ? '' : 'vf-kpi--warning' })}
      ${kpi({ label:'Receita bloqueada', valueHtml: kpiValueHtml(s.receitaBloqueada, { currency:true }), foot:'falta custo/frete p/ calcular', footTone: s.receitaBloqueada > 0 ? 'is-warning' : '', mod: s.receitaBloqueada > 0 ? 'vf-kpi--warning' : '' })}
      ${kpi({ label:'Pedidos válidos', valueHtml: kpiValueHtml(s.pedidosValidos), foot:'fora cancelamentos, devoluções e mediações' })}
      ${kpi({ label:'Cancelados', valueHtml: kpiValueHtml(s.cancelados), foot:'fora da venda boa · definitivo', footTone: s.cancelados > 0 ? 'is-danger' : '', mod: s.cancelados > 0 ? 'vf-kpi--danger' : '' })}
      ${kpi({ label:'Devoluções / reembolsos', valueHtml: kpiValueHtml(s.devolucoes), foot:'fora da venda boa · pós-venda', footTone: s.devolucoes > 0 ? 'is-danger' : '', mod: s.devolucoes > 0 ? 'vf-kpi--danger' : '' })}
      ${kpi({ label:'Mediações / problema', valueHtml: kpiValueHtml(s.problemas), foot:'fora da venda boa · aguardando decisão', footTone: s.problemas > 0 ? 'is-warning' : '', mod: s.problemas > 0 ? 'vf-kpi--warning' : '' })}
      ${kpi({ label:'Unidades vendidas', valueHtml: kpiValueHtml(s.unidades), foot:'itens válidos' })}
    </div>`;

    const cob = s.cobertura || {};
    const hintCob = (base, pctCob) =>
      pctCob == null ? base
        : pctCob >= 99.95 ? `${base} · cobre 100% da receita`
        : `${base} · cobre ${pct(pctCob)} da receita`;
    const mutedCob = (valor, pctCob) => valor == null || (pctCob != null && pctCob < 99.95);

    const secundarios = `<div class="vf-fapi-secondary-metrics" aria-label="Métricas secundárias do fechamento">
      ${secondaryMetric('Total de pedidos', valOr(s.pedidosTotal), 'no período')}
      ${secondaryMetric('Ticket médio', valOr(s.ticket, money), 'por pedido válido')}
      ${secondaryMetric('Comissão marketplace', valOr(s.comissao, money), hintCob('tarifa ML (sale_fee)', cob.comissao), mutedCob(s.comissao, cob.comissao))}
      ${secondaryMetric('Custo dos produtos', valOr(s.custoTotal, money), hintCob('base vinculada', cob.custo), mutedCob(s.custoTotal, cob.custo))}
      ${secondaryMetric('Imposto interno', valOr(s.impostoTotal, money), hintCob('cálculo interno', cob.imposto), mutedCob(s.impostoTotal, cob.imposto))}
      ${secondaryMetric('Frete seller', valOr(s.freteTotal, money), s.freteTotal == null ? 'ausente (shipments)' : hintCob('real (shipments API)', cob.frete), mutedCob(s.freteTotal, cob.frete))}
    </div>`;

    const comps = buildComposicaoRows(s);
    const compRows = comps.map(c => `
      <tr${c.comp === 'Resultado parcial' ? ' class="vf-fapi-total-row"' : ''}>
        <td>${esc(c.comp)}</td>
        <td class="vf-fapi-op" aria-hidden="true">${esc(c.op)}</td>
        <td class="num">${c.valor == null ? '<span class="is-absent">—</span>' : (c.comp === 'Resultado parcial' && c.status !== 'real' ? `<span class="vf-fapi-est">${money(c.valor)}</span>` : money(c.valor))}</td>
        <td>${statusTag(c.status)}</td>
        <td class="vf-fapi-fonte">${esc(c.fonte)}</td>
        <td class="vf-fapi-obs vf-truncate" title="${esc(c.obs)}">${esc(c.obs)}</td>
      </tr>`).join('');
    const residuo = composicaoResiduo(comps);
    const residuoRow = (residuo != null && Math.abs(residuo) >= 0.01)
      ? `<tr class="vf-fapi-total-row"><td>Resíduo não explicado</td><td class="vf-fapi-op" aria-hidden="true">≠</td><td class="num"><span class="vf-fapi-est">${money(residuo)}</span></td><td>${statusTag('parcial')}</td><td class="vf-fapi-fonte">cálculo interno</td><td class="vf-fapi-obs">as linhas acima não fecham no resultado — reportar</td></tr>`
      : '';
    const composicao = `
      <div class="vf-card vf-card--compact vf-fapi-composition">
        <div class="vf-card__header"><h3 class="vf-card__title">Composição do resultado</h3></div>
        <div class="vf-table-wrap">
          <table class="vf-table vf-table--compact">
            <thead><tr><th scope="col">Componente</th><th scope="col"><span class="vf-visually-hidden">Operação</span></th><th scope="col" class="num">Valor</th><th scope="col">Status</th><th scope="col">Fonte</th><th scope="col">Observação</th></tr></thead>
            <tbody>${compRows}${residuoRow}</tbody>
          </table>
        </div>
      </div>`;

    const qRow = (lbl, val, cls) => `<div class="vf-fapi-quality__row"><span class="vf-fapi-quality__label">${esc(lbl)}</span><span class="vf-fapi-quality__value${cls ? ' ' + cls : ''}">${val}</span></div>`;
    const comResultado = Math.max(0, s.pedidosValidos - s.pedidosBloqueados);
    const qualidade = `
      <div class="vf-card vf-card--compact vf-fapi-quality">
        <div class="vf-card__header"><h3 class="vf-card__title">Qualidade do fechamento</h3></div>
        <div class="vf-card__body">
          <div class="vf-fapi-quality__list">
            ${qRow('Pedidos sem custo', valOr(s.semCusto), s.semCusto ? 'is-danger' : '')}
            ${qRow('Pedidos sem frete', valOr(s.semFrete), s.semFrete ? 'is-warning' : '')}
            ${qRow('Com resultado calculável', valOr(comResultado))}
            ${qRow('Pedidos bloqueados', valOr(s.pedidosBloqueados), s.pedidosBloqueados ? 'is-danger' : '')}
            ${qRow('Cancelados', valOr(s.cancelados), s.cancelados ? 'is-danger' : '')}
            ${qRow('Devoluções / reembolsos', valOr(s.devolucoes), s.devolucoes ? 'is-danger' : '')}
            ${qRow('Devoluções parciais (no resultado)', valOr(s.devolucoesParciais), s.devolucoesParciais ? 'is-warning' : '')}
            ${qRow('Mediações / problema', valOr(s.problemas), s.problemas ? 'is-warning' : '')}
            ${qRow('% faturamento com custo', valOr(cob.custo, pct))}
            ${qRow('% faturamento com frete real', valOr(cob.frete, pct), (cob.frete || 0) > 0 ? 'is-success' : '')}
            ${qRow('% faturamento bloqueado', valOr(s.pctFatBloqueado, pct), (s.pctFatBloqueado || 0) > 0 ? 'is-warning' : '')}
          </div>
        </div>
      </div>`;

    const nota = `<div class="vf-banner is-info vf-banner--compact" role="note">
      <div class="vf-banner__content"><p class="vf-banner__description">Fechamento do <strong>período inteiro</strong> (independe dos filtros da tabela de pedidos). O <strong>frete seller</strong> vem da Shipments API por pedido quando disponível; pedidos sem frete real mantêm o fechamento <strong>parcial</strong>. Ausência aparece como <strong>—</strong>, nunca R$ 0,00.</p></div>
    </div>`;

    corpo = `${posVendaWarning}${kpis}${secundarios}<div class="vf-fapi-composition-grid">${composicao}${qualidade}</div>${nota}`;
  }

  host.innerHTML = `
    <section class="vf-section vf-fapi-overview" aria-label="Fechamento do período">
      <div class="vf-section__header">
        <div>
          <h2 class="vf-section__title">Fechamento do período</h2>
          <p class="vf-section__description">${headerMeta}</p>
        </div>
        <div class="vf-section__actions">
          <span class="vf-fapi-context__status-item"><span class="vf-fapi-context__status-label">Confiança</span> ${confStatus(s.pedidosTotal ? s.confiancaFechamento : rAll.confiancaFechamento)}</span>
        </div>
      </div>
      ${recorteBar}
      ${corpo}
    </section>`;
}

/* MP3 — Conciliação Mercado Pago (Payment + Settlement), seção enxuta e
   auxiliar (seção 15 do spec MP3). NUNCA compara um subtotal (só os pedidos
   cobertos) com o total da Central como se fossem a mesma base — por isso
   "Resultado calculado" aqui é resultadoOperacionalDosOrdersCobertos
   (mesmo subconjunto do resultado conciliado), não F.summary.lucroContribuicao. */
const MP_STATUS_LBL = {
  matched_clean: 'Conciliado',
  matched_with_post_events: 'Conciliado (c/ eventos pós-venda)',
  payment_missing: 'Sem Payment',
  payment_incomplete: 'Payment incompleto',
  shared_payment_ambiguous: 'Payment compartilhado',
  settlement_pending: 'Settlement pendente',
  settlement_missing: 'Settlement ausente',
  settlement_ambiguous: 'Settlement ambíguo',
  divergent: 'Divergente',
  order_gross_divergent: 'Divergente (bruto)',
  not_applicable: 'Não se aplica',
};
const MP_STATUS_CLS = {
  matched_clean: 'is-success',
  matched_with_post_events: 'is-success',
  payment_missing: 'is-neutral',
  payment_incomplete: 'is-warning',
  shared_payment_ambiguous: 'is-warning',
  settlement_pending: 'is-neutral',
  settlement_missing: 'is-warning',
  settlement_ambiguous: 'is-warning',
  divergent: 'is-danger',
  order_gross_divergent: 'is-danger',
  not_applicable: 'is-neutral',
};
const MP_RECONCILIATION_STATUS_LBL = {
  not_available: 'Ainda não disponível para este período',
  pending: 'Sincronização pendente',
  partial: 'Cobertura parcial',
  complete: 'Cobertura completa',
  divergent: 'Divergências encontradas',
};
function mpStatusTag(s) { return `<span class="vf-tag ${MP_STATUS_CLS[s] || 'is-neutral'}">${esc(MP_STATUS_LBL[s] || s || '—')}</span>`; }

function renderMercadoPagoSection() {
  const host = document.getElementById('fapi-mp-host');
  if (!host || !F.ok) return;

  if (F.mp.loading && !F.mp.data) {
    host.innerHTML = `
      <section class="vf-section" aria-label="Conciliação Mercado Pago">
        <div class="vf-section__header"><div>
          <h2 class="vf-section__title">Conciliação Mercado Pago</h2>
        </div></div>
        <div class="vf-card"><div class="vf-card__body"><p class="vf-fapi-legend">Carregando conciliação Mercado Pago…</p></div></div>
      </section>`;
    return;
  }

  if (!F.mp.data) {
    host.innerHTML = '';
    return; // falha silenciosa: camada auxiliar, nunca derruba a tela principal
  }

  const status = F.mp.data.mpReconciliationStatus || 'not_available';
  if (status === 'not_available') {
    host.innerHTML = `
      <section class="vf-section" aria-label="Conciliação Mercado Pago">
        <div class="vf-section__header"><div>
          <h2 class="vf-section__title">Conciliação Mercado Pago</h2>
          <p class="vf-section__description">Camada auxiliar de conciliação financeira com o Mercado Pago (Payment + Settlement) — não substitui o Resultado Parcial.</p>
        </div></div>
        <div class="vf-card"><div class="vf-card__body">${emptyState({
          icon:'dot', title:'Ainda não disponível para este período',
          why:'Nenhum Payment/Settlement do Mercado Pago foi sincronizado para este intervalo/conta.',
          next:'Sincronize novamente após validar a integração de Mercado Pago.',
        })}</div></div>
      </section>`;
    return;
  }

  const s = F.mp.data.summary || {};
  const cobertura = s.coveragePercent != null ? pct(s.coveragePercent) : '—';
  const metrics = `<div class="vf-fapi-secondary-metrics" aria-label="Métricas da conciliação Mercado Pago">
    ${secondaryMetric('Resultado calculado', esc(valOr(s.resultadoOperacionalDosOrdersCobertos, money)), 'sobre os pedidos conciliados')}
    ${secondaryMetric(`Resultado conciliado MP · ${esc(cobertura)}`, esc(valOr(s.resultadoConciliadoDosOrdersCobertos, money)), `cobertura: ${esc(cobertura)} dos pedidos elegíveis`)}
    ${secondaryMetric('Diferença nos pedidos conciliados', esc(valOr(s.deltaResultadoDosOrdersCobertos, money)), 'resultado conciliado − resultado calculado', s.deltaResultadoDosOrdersCobertos === 0)}
    ${secondaryMetric('Payments conciliados', `${num(s.paymentsMatched)} / ${num(s.paymentsUnique)}`, 'matched / total únicos')}
    ${secondaryMetric('Liberação', `${num(s.paymentsReleased)} liberados · ${num(s.paymentsPendingRelease)} pendentes`, 'money_release_status — nunca assume liberado por omissão')}
    ${secondaryMetric('Divergências', num((s.ordersDivergent || 0) + (s.ordersAmbiguous || 0)), 'pedidos divergentes/ambíguos', !(s.ordersDivergent || s.ordersAmbiguous)) }
    ${secondaryMetric('Eventos pós-venda financeiros', num(s.postMovementsCount), 'REFUND/DISPUTE/etc. — nunca somados ao resultado', !s.postMovementsCount)}
  </div>`;

  host.innerHTML = `
    <section class="vf-section" aria-label="Conciliação Mercado Pago">
      <div class="vf-section__header">
        <div>
          <h2 class="vf-section__title">Conciliação Mercado Pago</h2>
          <p class="vf-section__description">Resultado conciliado sobre ${esc(cobertura)} dos pedidos elegíveis — ${esc(MP_RECONCILIATION_STATUS_LBL[status] || status)}. Camada auxiliar; não substitui o Resultado Parcial.</p>
        </div>
      </div>
      <div class="vf-card"><div class="vf-card__body">${metrics}</div></div>
    </section>`;
}

/* ── ABA 1 · VISÃO GERAL — Vendas por dia (régua + tabela) ──
   F.daily já vem agregado por data do backend (/read/daily, período
   inteiro, sempre igual — não respeita filtro/busca da tabela de Pedidos,
   simplificação assumida no M9: antes a régua e a tabela podiam divergir
   entre si por causa disso; agora as duas leem a MESMA fonte). Só o
   preenchimento dos dias sem pedido (zero) é feito aqui — aritmética de
   calendário, não financeira. */
function diasComZeros() {
  if (!F.periodoResp) return [];
  const byDay = new Map(F.daily.map(d => [d.data, d]));
  return getCompetenceDays(F.periodoResp.inicio, F.periodoResp.fim).map(data => byDay.get(data) || {
    data, pedidos: 0, unidades: 0, faturamento: 0, comissao: null, custo: null, imposto: null,
    receitaBloqueada: 0, cancelProblema: 0, semFrete: 0, semCusto: 0, produtos: 0, topProduto: null,
  });
}
/* 'selected' = dia exato do filtro ativo da aba Pedidos. */
function dayScope(data) {
  const fl = F.orders.filters;
  if (fl.de && fl.de === fl.ate) return fl.de === data ? 'selected' : '';
  if (fl.de || fl.ate) return (!fl.de || data >= fl.de) && (!fl.ate || data <= fl.ate) ? 'scope' : '';
  return '';
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

function renderDaysSection() {
  const host = document.getElementById('fapi-days-host');
  if (!host || !F.ok) return;

  const dias = diasComZeros();
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

  const tdias = sortDias(F.daily, F.summaryUi.dailySort);
  const dailySortOpts = FECH_DAILY_SORTS.map(([k, l]) => `<option value="${k}"${F.summaryUi.dailySort === k ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const DAILY_SORT_COL = { data:['data','ascending'], faturamento:['faturamento','descending'], pedidos:['pedidos','descending'], cancelProblema:['cancelProblema','descending'], receitaBloqueada:['receitaBloqueada','descending'], semFrete:['semFrete','descending'], semCusto:['semCusto','descending'] };
  const dailyTh = (key, label, numCls) => {
    const s = DAILY_SORT_COL[F.summaryUi.dailySort];
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

/* ── ABA 2 · PEDIDOS — toolbar + tabela (server-side) ─────────
   F.rows é a PÁGINA atual, já filtrada/ordenada/paginada pelo backend
   (M7/M9 — GET /read). Nenhum filtro/busca/ordenação roda no browser;
   mudar qualquer um deles chama atualizarListaEResumo(). */
const QUICK_FILTERS = [
  ['todos', 'Todos'], ['sem_custo', 'Sem custo'], ['sem_frete', 'Sem frete'],
  ['frete_real', 'Com frete real'], ['calculavel', 'Resultado calculável'],
  ['bloqueados', 'Bloqueados'], ['receita_bloqueada', 'Receita bloqueada'],
  ['cancel_problema', 'Cancelados/problema'], ['full', 'Full'], ['normal', 'Normal'],
];
const QUICK_PRIMARY = ['todos', 'sem_custo', 'sem_frete', 'bloqueados', 'cancel_problema', 'full'];
/* Contagem de cada chip: sempre o total do PERÍODO (F.summary global),
   igual ao dado que a Read API já traz pronto — nunca uma nova busca. */
function quickCountFromSummary(k, s) {
  if (!s) return 0;
  switch (k) {
    case 'sem_custo': return s.semCusto;
    case 'sem_frete': return s.semFrete;
    case 'frete_real': return Math.max(0, s.pedidosValidos - s.semFrete);
    case 'calculavel': return Math.max(0, s.pedidosValidos - s.pedidosBloqueados);
    case 'bloqueados': case 'receita_bloqueada': return s.pedidosBloqueados;
    case 'cancel_problema': return s.pedidosForaResultado;
    case 'full': return s.full;
    case 'normal': return s.normal;
    default: return s.pedidosTotal;
  }
}
function quickChipHtml(k, label, count, active) {
  return `<button type="button" class="vf-filter-chip${active ? ' is-active' : ''}" data-quick="${k}" aria-pressed="${active}">${esc(label)} <span class="vf-badge">${num(count)}</span></button>`;
}

const ORDER_SORTS = [
  ['data_desc', 'Data (mais recente)'], ['data_asc', 'Data (mais antiga)'],
  ['fat_desc', 'Maior faturamento'], ['fat_asc', 'Menor faturamento'],
  ['comissao_desc', 'Maior comissão'], ['frete_desc', 'Maior frete'],
  ['custo_desc', 'Maior custo'], ['resultado_desc', 'Maior resultado'],
  ['bloqueada_desc', 'Maior receita bloqueada'], ['confianca', 'Confiança (pior 1º)'],
];
/* Estado da linha (filete à esquerda + classes de leitura) — direto dos
   campos já canônicos da row. */
function pedidoRowClass(o) {
  if (o.status === 'cancelado') return ' is-cancel';
  if (o.status === 'com_problema') return ' is-problem';
  if (o.resultadoStatus === 'bloqueado') return ' is-blocked';
  if (o.mlb && o.custoStatus === 'ausente') return ' is-nocost';
  if (o.frete == null) return ' is-nofreight';
  return '';
}
const STATUS_PEDIDO = { pago:['is-success','Pago'], cancelado:['is-danger','Cancelado'], com_problema:['is-warning','Mediação / problema'], pendente:['is-warning','Pendente'] };
function statusPedidoInfo(o) {
  if (o?.posVendaTipo === 'devolucao') {
    return o.status === 'cancelado'
      ? ['is-danger', 'Devolução / reembolso']
      : ['is-warning', 'Devolução em andamento'];
  }
  return STATUS_PEDIDO[o?.status] || ['is-neutral', o?.status];
}

const PEDFILTER_LBL = {
  logistica: { full:'Full', nao_full:'Não Full' },
  diagbase: { com_custo:'Com custo', sem_custo:'Sem custo' },
  status: { valido:'Válido', cancelado:'Cancelado', problema:'Problema', bloqueado:'Bloqueado' },
};
function buildActiveFilters() {
  const fl = F.orders.filters;
  const items = [];
  if (F.orders.quickFilter && F.orders.quickFilter !== 'todos') {
    const q = QUICK_FILTERS.find(c => c[0] === F.orders.quickFilter);
    if (q) items.push({ type:'quick', label:q[1] });
  }
  for (const key of ['logistica', 'diagbase', 'status']) {
    if (fl[key] !== 'todos') items.push({ type:'pedfilter', key, label: PEDFILTER_LBL[key][fl[key]] || fl[key] });
  }
  if (fl.de || fl.ate) {
    items.push({ type:'dia', label: fl.de === fl.ate ? `Dia ${fmtDt(fl.de)}` : `${fmtDt(fl.de)} até ${fmtDt(fl.ate)}` });
  }
  const termo = String(F.orders.search || '').trim();
  if (termo) items.push({ type:'busca', label:`Busca "${termo}"` });
  return items;
}

function renderOrdersPanel() {
  const panel = document.getElementById('fapi-panel-pedidos');
  if (!panel || !F.ok) return;
  const fl = F.orders.filters;
  const opt = (v, label, cur) => `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${esc(label)}</option>`;
  const selF = (id, key, labelTxt, opts) => `
    <div class="vf-field">
      <label class="vf-field__label" for="${id}">${esc(labelTxt)}</label>
      <select id="${id}" class="vf-select vf-select--sm" data-pedfilter="${key}">${opts}</select>
    </div>`;

  const primary = QUICK_FILTERS.filter(([k]) => QUICK_PRIMARY.includes(k))
    .map(([k, l]) => quickChipHtml(k, l, quickCountFromSummary(k, F.summary), F.orders.quickFilter === k)).join('');
  const extra = QUICK_FILTERS.filter(([k]) => !QUICK_PRIMARY.includes(k))
    .map(([k, l]) => quickChipHtml(k, l, quickCountFromSummary(k, F.summary), F.orders.quickFilter === k)).join('');

  const sortOpts = ORDER_SORTS.map(([k, l]) => `<option value="${k}"${F.orders.sort === k ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const advCount = ['logistica', 'diagbase', 'status'].filter(k => fl[k] !== 'todos').length;

  panel.innerHTML = `
    <section class="vf-section" aria-label="Pedidos do período">
      <div class="vf-section__header">
        <div>
          <h2 class="vf-section__title">Pedidos</h2>
          <p class="vf-section__description">Clique num pedido para abrir o extrato. Filtro, busca e ordenação consultam o servidor.</p>
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
            ${selF('fapi-filter-diagbase', 'diagbase', 'Diagnóstico / base', [opt('todos','Todos',fl.diagbase), opt('com_custo','Com custo',fl.diagbase), opt('sem_custo','Sem custo',fl.diagbase)].join(''))}
            ${selF('fapi-filter-status', 'status', 'Status do pedido', [opt('todos','Todos',fl.status), opt('valido','Válido',fl.status), opt('cancelado','Cancelado',fl.status), opt('problema','Problema',fl.status), opt('bloqueado','Bloqueado',fl.status)].join(''))}
          </div>
          <div class="vf-fapi-orders-toolbar__chips" role="group" aria-label="Recortes adicionais">${extra}</div>
        </div>
      </div>

      <div id="fapi-ped-table"></div>
    </section>`;
  renderPedTable();
}

function renderPedTable() {
  const host = document.getElementById('fapi-ped-table');
  if (!host) return;

  if (F.orders.loading) {
    host.innerHTML = loadingState('Atualizando pedidos…');
    return;
  }

  const rows = F.rows || [];
  const pg = F.pagination || { page:1, limit:F.orders.pageSize, total:0, totalPages:0 };

  const countEl = document.getElementById('fapi-orders-count');
  if (countEl) countEl.textContent = `${num(pg.total)} pedido(s) encontrados`;

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

  if (!pg.total) {
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

  const tr = rows.map(o => {
    const [scls, slbl] = statusPedidoInfo(o);
    const res = o.resultado == null ? '—' : `<span class="vf-fapi-est">${money(o.resultado)}</span>`;
    const selected = F.ui.drawerRowId === o.rowId;
    const pendPrimaria = o.pendencias?.length ? pendenciaLabel(o.pendencias[0]) : '—';
    const pendTitle = o.pendencias?.length ? o.pendencias.map(pendenciaLabel).join(' · ') : '—';
    return `
      <tr class="${(pedidoRowClass(o) + (selected ? ' row--selected' : '')).trim()}" data-row-id="${esc(o.rowId)}" tabindex="0" aria-label="Abrir extrato do pedido ${esc(o.id)}">
        <td class="vf-mono">${esc(o.id)}${o.multiItem ? ` <span class="vf-tag is-info" title="${esc(o.qtdItens)} itens neste pedido">${esc(o.qtdItens)} itens</span>` : ''}</td>
        <td>${fmtDt(o.data)}</td>
        <td><span class="vf-tag ${scls}">${esc(slbl)}</span></td>
        <td class="vf-truncate" title="${esc(o.produto?.titulo || '—')}">${esc(o.produto?.titulo || '—')}${o.multiItem ? ' (+ outros)' : ''}</td>
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
        <td class="vf-truncate is-absent" title="${esc(pendTitle)}">${esc(pendPrimaria)}</td>
      </tr>`;
  }).join('');

  const SORT_COL = { data_desc:['data','descending'], data_asc:['data','ascending'], fat_desc:['valor','descending'], fat_asc:['valor','ascending'], comissao_desc:['taxas','descending'], frete_desc:['frete','descending'], custo_desc:['custo','descending'], resultado_desc:['resultado','descending'], confianca:['confianca','ascending'] };
  const th = (key, label, numCls) => {
    const s = SORT_COL[F.orders.sort];
    const sorted2 = s && s[0] === key ? ` aria-sort="${s[1]}"` : '';
    return `<th scope="col"${numCls ? ' class="num"' : ''}${sorted2}>${esc(label)}</th>`;
  };

  const start = pg.total ? (pg.page - 1) * pg.limit + 1 : 0;
  const end = Math.min(pg.page * pg.limit, pg.total);

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
      <span class="vf-pager__info">Mostrando ${num(start)}–${num(end)} de ${num(pg.total)} pedidos${pg.totalPages > 1 ? ` · página ${num(pg.page)}/${num(pg.totalPages)}` : ''}</span>
      <div class="vf-pager__nav">
        <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" id="fapi-page-prev"${pg.page <= 1 ? ' disabled' : ''}>← Anterior</button>
        <button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" id="fapi-page-next"${pg.page >= pg.totalPages ? ' disabled' : ''}>Próxima →</button>
      </div>
    </div>
    <p class="vf-fapi-legend">Filete à esquerda da linha: <b>vermelho</b> cancelado/bloqueado · <b>âmbar</b> problema/sem custo · <b>cinza</b> sem frete. O estado também está escrito nas colunas Status, Confiança e Pendência. Pedido com mais de um item mostra a etiqueta "N itens" — os valores já são a soma de todos os itens (nunca só o primeiro produto). Ausência é <b>—</b>, nunca R$ 0,00.</p>`;
}

/* ── DETALHE DO PEDIDO (drawer lateral) ───────────────────────
   M9 — busca sob demanda em GET /read/orders/:rowId (M7/M6): itens e
   componentes vêm prontos do ledger, nunca reconstruídos aqui. */
function faltasDoPedido(o) {
  const faltas = [];
  if (o.status === 'cancelado') faltas.push(['pedido cancelado/reembolso', 'não conclui resultado; impacto fora da venda boa']);
  if (o.status === 'com_problema') faltas.push(['pedido em mediação/problema', 'não conclui resultado; impacto fora da venda boa']);
  for (const code of (o.pendencias || [])) faltas.push([pendenciaLabel(code), pendenciaImpacto(code)]);
  return faltas;
}

/* MP3, seção 16 do spec — seção enxuta do drawer: só os campos prioritários,
   nunca despeja JSON bruto. mpRow vem de F.mp.rowsByOrderId (já carregado
   pela seção de topo, seção 15) — nunca dispara um fetch extra por pedido.
   Ausência de mpRow (pedido fora da página carregada, ou MP indisponível
   para o período) simplesmente omite a seção — nunca um falso "ausente". */
function buildMercadoPagoDrawerSection(mpRow) {
  if (!mpRow || !mpRow.paymentsCount) return '';
  const kv = pairs => `<dl class="vf-fapi-kv">${pairs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  const releaseLbl = mpRow.moneyReleaseStatus === 'released' ? 'Liberado'
    : mpRow.moneyReleaseStatus === 'pending' ? 'Pendente' : 'Desconhecido';
  const eventos = mpRow.temEventosPosteriores
    ? `${esc((mpRow.postMovementTypes || []).join(', ') || '—')} (${num(mpRow.postMovementsCount)})`
    : 'Nenhum';

  return `
    <section class="vf-fapi-drawer-section" aria-label="Mercado Pago">
      <h3 class="vf-fapi-drawer-section__title">Mercado Pago ${mpStatusTag(mpRow.mpStatus)}</h3>
      ${kv([
        ['Payment(s)', esc((mpRow.paymentIds || []).join(', ') || '—')],
        ['Valor bruto (Payment)', esc(valOr(mpRow.paymentTransactionAmountTotal, money))],
        ['Líquido Payment', esc(valOr(mpRow.paymentNetReceivedAmountTotal, money))],
        ['Líquido Settlement', esc(valOr(mpRow.settlementNetAmountTotal, money))],
        ['Resultado operacional', esc(valOr(mpRow.resultadoOperacional, money))],
        ['Resultado conciliado MP', esc(valOr(mpRow.resultadoConciliadoMpBase, money))],
        ['Diferença (conciliado − operacional)', esc(valOr(mpRow.deltaResultadoMp, money))],
        ['Liberação (money_release_status)', esc(releaseLbl) + (mpRow.moneyReleaseDate ? ` · ${esc(fmtDt(mpRow.moneyReleaseDate))}` : '')],
        ['Eventos pós-venda (REFUND/DISPUTE/…)', eventos],
      ])}
      ${mpRow.motivo ? `<p class="vf-fapi-legend">${esc(mpRow.motivo)}</p>` : ''}
      <p class="vf-fapi-legend">Camada auxiliar de conciliação (Payment + Settlement) — nunca substitui o Resultado acima, persistido pelo backend.</p>
    </section>`;
}

function buildOrderDrawerBody(o, mpRow) {
  const faltas = faltasDoPedido(o);
  const bloqueado = o.resultado == null;
  const precoUnit = (o.valor != null && o.unidades) ? round2(o.valor / o.unidades) : null;
  const [scls, slbl] = statusPedidoInfo(o);
  const kv = pairs => `<dl class="vf-fapi-kv">${pairs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;

  const itensSecao = (o.itens && o.itens.length) ? `
    <section class="vf-fapi-drawer-section" aria-label="Itens do pedido">
      <h3 class="vf-fapi-drawer-section__title">Itens do pedido${o.multiItem ? ` (${esc(o.qtdItens)})` : ''}</h3>
      <div class="vf-table-wrap">
        <table class="vf-table vf-table--compact">
          <thead><tr><th scope="col">Produto</th><th scope="col">MLB</th><th scope="col">SKU</th><th scope="col" class="num">Qtd.</th><th scope="col" class="num">Receita</th><th scope="col" class="num">Custo</th><th scope="col" class="num">Imposto</th><th scope="col" class="num">Resultado</th><th scope="col">Confiança</th></tr></thead>
          <tbody>${o.itens.map(it => `
            <tr>
              <td class="vf-truncate" title="${esc(it.titulo || '—')}">${esc(it.titulo || '—')}</td>
              <td class="vf-mono">${esc(it.mlb || '—')}</td>
              <td class="vf-mono${it.sku ? '' : ' is-absent'}">${esc(it.sku || '—')}</td>
              <td class="num">${valOr(it.quantidade)}</td>
              <td class="num">${valOr(it.receitaProduto, money)}</td>
              <td class="num${it.custoProduto == null ? ' is-absent' : ''}">${valOr(it.custoProduto, money)}</td>
              <td class="num${it.impostoInterno == null ? ' is-absent' : ''}">${valOr(it.impostoInterno, money)}</td>
              <td class="num${it.resultado == null ? ' is-absent' : ''}">${valOr(it.resultado, money)}</td>
              <td>${confStatus(it.confianca)}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    </section>` : '';

  const componentesOrdenados = (o.componentes || []).slice()
    .sort((a, b) => COMPONENTE_ORDEM.indexOf(a.tipo) - COMPONENTE_ORDEM.indexOf(b.tipo));
  // c.confianca é status de COMPONENTE (real/estimado/ausente/parcial/bloqueado
  // — STATUS_LBL), não confiança de PEDIDO (confiavel/parcial/insuficiente/
  // bloqueado — CONF). confStatus() só conhece o vocabulário de pedido; "real"
  // caía no fallback e virava "Bloqueado" mesmo com valor presente.
  const compLinha = c => `
    <tr>
      <td>${esc(COMPONENTE_LBL[c.tipo] || c.tipo)}${c.itemId ? ` <span class="vf-fapi-fonte">(${esc(c.itemId)})</span>` : ''}</td>
      <td class="vf-fapi-op" aria-hidden="true">${c.efeito === 'credito' ? '+' : c.efeito === 'debito' ? '−' : ''}</td>
      <td class="num">${valOr(c.valor, money)}</td>
      <td>${statusTag(c.confianca)}</td>
      <td>${c.incluidoNoResultado === false ? '<span class="vf-tag is-neutral">conciliação</span>' : (c.escopo ? `<span class="vf-tag is-neutral">${esc(c.escopo)}</span>` : '—')}</td>
      <td class="vf-fapi-fonte">${esc(c.fonte || '—')}</td>
      <td class="vf-fapi-obs vf-truncate" title="${esc(c.obs || '—')}">${esc(c.obs || '—')}</td>
    </tr>`;
  const ledgerSecao = componentesOrdenados.length ? `
    <section class="vf-fapi-drawer-section" aria-label="Composição financeira">
      <h3 class="vf-fapi-drawer-section__title">Composição financeira (ledger)</h3>
      <div class="vf-table-wrap">
        <table class="vf-table vf-table--compact">
          <thead><tr><th scope="col">Componente</th><th scope="col"><span class="vf-visually-hidden">Operação</span></th><th scope="col" class="num">Valor</th><th scope="col">Confiança</th><th scope="col">Escopo</th><th scope="col">Fonte</th><th scope="col">Observação</th></tr></thead>
          <tbody>${componentesOrdenados.map(compLinha).join('')}
            <tr class="vf-fapi-total-row">
              <td>Resultado</td>
              <td class="vf-fapi-op" aria-hidden="true">=</td>
              <td class="num">${o.resultado == null ? '—' : `<span class="vf-fapi-est">${money(o.resultado)}</span>`}</td>
              <td>${statusTag(o.resultadoStatus)}</td>
              <td colspan="3" class="vf-fapi-obs">${esc(bloqueado ? 'bloqueado — não vira R$ 0,00' : (o.resultadoStatus === 'real' ? 'todos os componentes presentes' : 'parcial — não confiável'))} · persistido pelo backend, não recalculado aqui</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="vf-fapi-legend">"conciliação" = fora do Resultado Parcial (receita de envio / cancelamento-reembolso — nunca somados de novo).</p>
    </section>` : '';

  return `
    <section class="vf-fapi-drawer-section" aria-label="Identificação do pedido">
      <div class="vf-fapi-drawer-ident">
        ${thumb(o.produto)}
        <div>
          <p class="vf-fapi-drawer-ident__title">${esc(o.produto?.titulo || '—')}</p>
          <p class="vf-fapi-drawer-ident__meta">Pedido <span class="vf-mono">${esc(o.id)}</span> · ${fmtDt(o.data)}</p>
          <div class="vf-fapi-drawer-ident__tags">
            <span class="vf-tag ${scls}">${esc(slbl)}</span>
            ${tagFull(o.full)} ${tagAds(o.adsStatus)} ${tagDiag(o.custoStatus)}
            ${o.multiItem ? `<span class="vf-tag is-info">${esc(o.qtdItens)} itens neste pedido</span>` : ''}
          </div>
        </div>
      </div>
      <p class="vf-fapi-legend">Valores exatamente como persistidos pelo backend (M5/M6) — a tela nunca recalcula. Ausência nunca vira zero.</p>
    </section>
    ${itensSecao}
    ${ledgerSecao}
    ${buildMercadoPagoDrawerSection(mpRow)}
    <section class="vf-fapi-drawer-section" aria-label="Pedido">
      <h3 class="vf-fapi-drawer-section__title">Pedido</h3>
      ${kv([
        ['MLB', `<span class="vf-mono">${esc(o.produto?.mlb || '—')}</span>`],
        ['SKU', `<span class="vf-mono">${esc(o.produto?.sku || '—')}</span>`],
        ['Quantidade', esc(valOr(o.unidades, num))],
        ['Preço médio unit.', esc(valOr(precoUnit, money))],
        ['Valor do pedido', esc(valOr(o.valor, money))],
      ])}
    </section>
    ${(bloqueado || faltas.length) ? `
    <section class="vf-fapi-drawer-section" aria-label="Pendências e confiança">
      <h3 class="vf-fapi-drawer-section__title">Pendências e confiança</h3>
      <div class="vf-banner ${bloqueado ? 'is-danger' : 'is-warning'} vf-banner--compact">
        <div class="vf-banner__content">
          <p class="vf-banner__title">${bloqueado ? 'Sem informações suficientes para concluir' : 'Resultado parcial — o que ainda falta'}</p>
          <ul>${faltas.map(([f, imp]) => `<li><strong>${esc(f)}</strong>${imp ? ` — ${esc(imp)}` : ''}</li>`).join('')}</ul>
        </div>
      </div>
    </section>` : ''}`;
}

async function openOrderDrawer(rowId, triggerRow) {
  const drawer = document.getElementById('fapi-order-drawer');
  const backdrop = document.getElementById('fapi-drawer-backdrop');
  const body = document.getElementById('fapi-drawer-body');
  const conf = document.getElementById('fapi-drawer-conf');
  if (!drawer || !body) return;

  const rowIdNum = Number(rowId);
  F.ui.drawerRowId = rowIdNum;
  F.ui.drawerReturnFocusId = triggerRow?.dataset?.rowId || String(rowId);
  document.querySelectorAll('#fapi-ped-table tr[data-row-id]').forEach(r =>
    r.classList.toggle('row--selected', Number(r.dataset.rowId) === rowIdNum));

  if (conf) conf.innerHTML = '';
  body.innerHTML = loadingState('Carregando extrato do pedido…');
  drawer.classList.add('is-open');
  if (backdrop) backdrop.classList.add('is-open');
  document.body.classList.add('vf-no-scroll');
  requestAnimationFrame(() => requestAnimationFrame(() =>
    document.getElementById('fapi-drawer-close')?.focus()));

  const seq = ++F.ui.drawerLoadSeq;
  const detalhe = await fetchOrderDetail(rowIdNum, null);
  if (seq !== F.ui.drawerLoadSeq || F.ui.drawerRowId !== rowIdNum) return; // drawer trocou/fechou antes da resposta

  if (!detalhe?.ok || !detalhe.pedido) {
    body.innerHTML = emptyState({
      icon:'plug', tone:'is-danger', title:'Não foi possível carregar o extrato',
      why: detalhe?.erro || 'O backend não respondeu para este pedido.',
      next:'Feche e tente novamente.',
    });
    return;
  }

  const o = detalhe.pedido;
  if (conf) conf.innerHTML = confStatus(o.confianca);
  const mpRow = F.mp.rowsByOrderId ? F.mp.rowsByOrderId.get(String(o.id)) : null;
  body.innerHTML = buildOrderDrawerBody(o, mpRow);
}

function closeOrderDrawer({ restoreFocus = true } = {}) {
  const drawer = document.getElementById('fapi-order-drawer');
  const backdrop = document.getElementById('fapi-drawer-backdrop');
  const wasOpen = drawer?.classList.contains('is-open');
  drawer?.classList.remove('is-open');
  backdrop?.classList.remove('is-open');
  document.body.classList.remove('vf-no-scroll');
  const returnId = F.ui.drawerReturnFocusId;
  F.ui.drawerRowId = null;
  F.ui.drawerReturnFocusId = null;
  document.querySelectorAll('#fapi-ped-table tr.row--selected').forEach(r => r.classList.remove('row--selected'));
  if (wasOpen && restoreFocus && returnId) {
    const row = document.querySelector(`#fapi-ped-table tr[data-row-id="${CSS.escape(returnId)}"]`);
    (row || document.getElementById('fapi-search'))?.focus();
  }
}

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
   MÓDULO CURVA ABC (aba Produtos / Curva ABC)
   ----------------------------------------------------------------
   M9 — a agregação por produto (faturamento, curva A/B/C, unidades,
   ticket, comissão, custo unitário) vem PRONTA de F.products (GET
   /read/products, período inteiro). Este módulo só agrupa/ordena/busca/
   pagina sobre essa lista já agregada — nenhuma soma nova, nenhuma
   reconstrução a partir de pedidos.
   ================================================================ */
function abcRoot() { return document.getElementById('fapi-abc-root'); }

function resetCurvaAbcState() {
  F.abc.group = 'todos';
  F.abc.sort = 'faturamento';
  F.abc.search = '';
  F.abc.page = 1;
}

/* Logística do produto: full / normal / misto (vem pronta de F.products —
   logisticaTipo). */
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
const ABC_CURVA_TAG = {
  A: '<span class="vf-tag is-primary">A</span>',
  B: '<span class="vf-tag is-neutral">B</span>',
  C: '<span class="vf-tag is-neutral">C</span>',
};

/* Filtro/ordenação/busca — categoria B, navegação sobre dado já agregado. */
function buildCurvaAbcView({ group = 'todos', sortBy = 'faturamento', search = '' } = {}) {
  let rows = F.products;
  if (group === 'sem_custo')              rows = rows.filter(a => !a.semProduto && !a.temCusto);
  else if (group === 'receita_bloqueada') rows = rows.filter(a => (a.receitaBloqueada || 0) > 0);
  else if (group === 'full')              rows = rows.filter(a => a.logisticaTipo === 'full' || a.logisticaTipo === 'misto');
  else if (group === 'normal')            rows = rows.filter(a => a.logisticaTipo === 'normal' || a.logisticaTipo === 'misto');
  else if (group === 'misto')             rows = rows.filter(a => a.logisticaTipo === 'misto');
  else if (group === 'curva_a')           rows = rows.filter(a => a.curva === 'A');
  else if (group === 'curva_b')           rows = rows.filter(a => a.curva === 'B');
  else if (group === 'curva_c')           rows = rows.filter(a => a.curva === 'C');

  const term = String(search || '').trim().toLowerCase();
  if (term) {
    rows = rows.filter(a =>
      String(a.mlb || '').toLowerCase().includes(term) ||
      String(a.sku || '').toLowerCase().includes(term) ||
      String(a.titulo || '').toLowerCase().includes(term));
  }

  const sortKey = group === 'receita_bloqueada' ? 'receitaBloqueada' : sortBy;
  rows = rows.slice().sort((x, y) => (y[sortKey] || 0) - (x[sortKey] || 0));
  return rows;
}

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
      <td class="num${a.comissao == null ? ' is-absent' : ''}">${valOr(a.comissao, money)}</td>
      <td class="num${a.custoUnit == null ? ' is-absent' : ''}">${valOr(a.custoUnit, money)}</td>
      <td>${abcBaseTag(a)}</td>
      <td>${tagDiag(a.temCusto ? 'real' : 'ausente')}</td>
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

function renderCurvaAbc() {
  const root = abcRoot();
  if (!root) return;
  const rows = buildCurvaAbcView({ group: F.abc.group, sortBy: F.abc.sort, search: F.abc.search });
  const totalFat = F.totalFaturamento;

  const vendidos = F.products.filter(a => !a.semProduto);
  const curvaA = vendidos.filter(a => a.curva === 'A');
  const semCusto = vendidos.filter(a => !a.temCusto);
  const fatSemCusto = round2(semCusto.reduce((s, a) => s + a.faturamento, 0));
  const unidadesTotal = F.products.reduce((s, a) => s + (a.unidades || 0), 0);
  const receitaBloqTotal = round2(F.products.reduce((s, a) => s + (a.receitaBloqueada || 0), 0));

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

function renderAbc() {
  if (!F.ok) return;
  renderCurvaAbc();
}

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
function copiarMlbsSemCusto(btn) {
  const mlbs = F.products.filter(a => !a.semProduto && !a.temCusto && a.mlb).map(a => a.mlb);
  const flash = msg => { if (btn) { const t = btn.dataset.label || btn.textContent; btn.dataset.label = t; btn.textContent = msg; setTimeout(() => { btn.textContent = t; }, 1600); } };
  if (!mlbs.length) { flash('Nenhum sem custo'); return; }
  const texto = mlbs.join('\n');
  const ok = () => flash(`Copiado ${mlbs.length} MLB(s)`);
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(texto).then(ok).catch(() => fallbackCopy(texto, ok));
  else fallbackCopy(texto, ok);
}

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
      const tableHost = root.querySelector('[data-abc-table]');
      if (!tableHost || !F.ok) return;
      const rows = buildCurvaAbcView({ group: F.abc.group, sortBy: F.abc.sort, search: F.abc.search });
      const count = root.querySelector('.vf-fapi-abc-toolbar__count');
      if (count) count.textContent = `${num(rows.length)} produto(s)`;
      tableHost.innerHTML = renderCurvaAbcTable(rows, F.totalFaturamento);
    }, 300);
  });

  root.addEventListener('click', e => {
    const pageBtn = e.target.closest('[data-abc-page]');
    if (pageBtn) { F.abc.page = Math.max(1, F.abc.page + Number(pageBtn.dataset.abcPage)); renderAbc(); return; }
    const action = e.target.closest('[data-abc-action]');
    if (!action || !F.ok) return;
    if (action.dataset.abcAction === 'only-nocost') { F.abc.group = 'sem_custo'; F.abc.page = 1; renderAbc(); return; }
    if (action.dataset.abcAction === 'copy-nocost') { copiarMlbsSemCusto(action); return; }
  });
}
/* ════════════════ FIM DO MÓDULO CURVA ABC ════════════════ */

/* ── INTERAÇÕES — cada mudança de filtro/busca/ordenação/página
   dispara uma nova consulta ao servidor (M9, seção 11). Navegação pura
   (aba ativa, drawer, painel de filtros aberto) continua 100% local. ── */
function setPedFilter(key, value) {
  F.orders.filters[key] = value || 'todos';
  closeOrderDrawer({ restoreFocus: false });
  atualizarListaEResumo({ resetPage: true });
}
/* Clique num dia (régua ou tabela) → filtra a tabela de Pedidos por
   dataDe/dataAte e leva o usuário para a aba Pedidos. */
function applyDayFilter(day) {
  if (!F.periodoResp || day < F.periodoResp.inicio || day > F.periodoResp.fim) return;
  F.orders.filters.de = day;
  F.orders.filters.ate = day;
  closeOrderDrawer({ restoreFocus: false });
  setActiveTab('pedidos');
  atualizarListaEResumo({ resetPage: true }).then(renderDaysSection);
}
function applyQuickFilter(q) {
  F.orders.quickFilter = (q !== 'todos' && q === F.orders.quickFilter) ? 'todos' : q;
  closeOrderDrawer({ restoreFocus: false });
  atualizarListaEResumo({ resetPage: true });
}
function setOrderSort(value) {
  F.orders.sort = value || 'data_desc';
  atualizarListaEResumo({ resetPage: true });
}
function limparTudoLocal() {
  F.orders.filters = defaultOrderFilters();
  F.orders.quickFilter = 'todos';
  F.orders.search = '';
  F.orders.sort = 'data_desc';
  const input = document.getElementById('fapi-search');
  if (input) input.value = '';
  closeOrderDrawer({ restoreFocus: false });
  atualizarListaEResumo({ resetPage: true }).then(renderDaysSection);
}
function onSearchInput(value) {
  if (F.orders.searchTimer) clearTimeout(F.orders.searchTimer);
  F.orders.searchTimer = setTimeout(() => {
    F.orders.search = value;
    closeOrderDrawer({ restoreFocus: false });
    atualizarListaEResumo({ resetPage: true });
  }, 300);
}
function goToPage(delta) {
  const pages = F.pagination?.totalPages || 1;
  const next = Math.min(pages, Math.max(1, F.orders.page + delta));
  if (next === F.orders.page) return;
  F.orders.page = next;
  atualizarListaEResumo({});
}
/* Recorte do Fechamento (Visão Geral) — refaz o mesmo /read (summary muda
   de recorte via resumoFiltro; a lista de Pedidos é atualizada junto,
   sem custo extra de fórmula). */
function setFechQuick(q) {
  F.summaryUi.quickFilter = (q !== 'todos' && q === F.summaryUi.quickFilter) ? 'todos' : q;
  atualizarListaEResumo({});
}
function setDailySort(value) {
  F.summaryUi.dailySort = value || 'data';
  renderDaysSection();
}
function removeActiveFilter(type, key) {
  if (type === 'quick') { F.orders.quickFilter = 'todos'; }
  else if (type === 'pedfilter' && key) { setPedFilter(key, 'todos'); return; }
  else if (type === 'dia') {
    F.orders.filters.de = null; F.orders.filters.ate = null;
    atualizarListaEResumo({ resetPage: true }).then(renderDaysSection);
    return;
  }
  else if (type === 'busca') {
    F.orders.search = '';
    const input = document.getElementById('fapi-search');
    if (input) input.value = '';
  }
  atualizarListaEResumo({ resetPage: true });
}

/* ── IMPORTAÇÃO / SINCRONIZAÇÃO (admin only — endpoints preservados,
   inalterados nesta rodada: M9 troca a LEITURA, não a escrita) ── */
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
  if (F.contas.length > 1 && !F.clienteConta) { setActionStatus('Selecione a conta antes de importar.', ACTION_TONE.warn); return; }
  if (!F.periodo) { setActionStatus('Selecione o período antes de importar.', ACTION_TONE.warn); return; }

  const arquivo = F.arquivoImport;
  if (!arquivo) { setActionStatus('Selecione a planilha de vendas (.xlsx).', ACTION_TONE.warn); return; }

  setAdminBusy(true, 'fapi-import-btn');
  setActionStatus('Importando…', ACTION_TONE.info);

  try {
    const form = new FormData();
    form.append('sales', arquivo);
    form.append('competencia', String(F.periodo.dateFrom).slice(0, 7));
    if (F.clienteConta?.id) form.append('clienteContaId', String(F.clienteConta.id));

    const res = await fetch(
      `${API_BASE}/operacao/central-vendas/${encodeURIComponent(F.cliente.slug)}/importar-vendas`,
      { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: form }
    );

    if (res.status === 401) { window.location.replace('index.html'); return; }

    const json = await res.json();
    if (!res.ok) throw new Error(json.erro || json.error || json.message || `HTTP ${res.status}`);

    const pedidos = json.pedidosPersistidos ?? '?';
    setActionStatus(`Importado: ${pedidos} pedido(s). Recarregando…`, ACTION_TONE.ok);
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

const SYNC_POLL_MS = 3000;

function pararPollingSync() {
  if (F.sync.timer) { clearTimeout(F.sync.timer); F.sync.timer = null; }
  F.sync.runId = null;
  F.sync.clienteSlug = null;
  F.sync.clienteContaId = null;
}

async function executarSincronizacao() {
  if (!TOKEN) return;
  if (!F.cliente) { setActionStatus('Selecione um cliente antes de sincronizar.', ACTION_TONE.warn); return; }
  if (F.contas.length > 1 && !F.clienteConta) { setActionStatus('Selecione a conta antes de sincronizar.', ACTION_TONE.warn); return; }
  if (!F.periodo) { setActionStatus('Selecione o período antes de sincronizar.', ACTION_TONE.warn); return; }

  setAdminBusy(true, 'fapi-sync-btn');
  setActionStatus('Iniciando sincronização…', ACTION_TONE.info);

  const clienteContaId = F.clienteConta?.id || null;
  try {
    const body = { dateFrom: F.periodo.dateFrom, dateTo: F.periodo.dateTo };
    if (clienteContaId) body.clienteContaId = clienteContaId;
    const res = await fetch(
      `${API_BASE}/operacao/central-vendas/${encodeURIComponent(F.cliente.slug)}/sync-runs`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    if (res.status === 401) { window.location.replace('index.html'); return; }

    const json = await res.json();
    if (!res.ok) throw new Error(json.erro || json.error || json.message || `HTTP ${res.status}`);

    setActionStatus('Sincronização iniciada — acompanhando…', ACTION_TONE.info);
    F.sync.runId = json.run.id;
    F.sync.clienteSlug = F.cliente.slug;
    F.sync.clienteContaId = clienteContaId;
    pollSyncRun(json.run.id, F.cliente.slug, clienteContaId);
  } catch (err) {
    setActionStatus(`Erro: ${err?.message || 'Falha ao iniciar a sincronização.'}`, ACTION_TONE.danger);
    setAdminBusy(false);
  }
}

function resumoConclusaoSync(run, sources, meta) {
  const partes = (Array.isArray(sources) ? sources : []).map((s) => {
    const nome = FONTE_LABEL[s.source] || s.source;
    if (s.status === 'complete') {
      return (s.expectedCount != null && s.receivedCount != null)
        ? `${nome} ${s.receivedCount}/${s.expectedCount}`
        : `${nome} verificado`;
    }
    if (s.status === 'failed') return `${nome} falhou`;
    if (s.status === 'incomplete') return `${nome} incompleto`;
    return null;
  }).filter(Boolean);

  const base = `${meta.pedidosPersistidos ?? '?'} pedido(s) sincronizados via API.`;
  if (!partes.length) return base;
  return run.completenessStatus === 'partial'
    ? `Sincronização concluída com pendências. ${partes.join(' · ')}.`
    : `${base} ${partes.join(' · ')}.`;
}

async function pollSyncRun(runId, clienteSlugNoInicio, clienteContaIdNoInicio = null) {
  const contextoMudou = () =>
    F.sync.runId !== runId || F.cliente?.slug !== clienteSlugNoInicio ||
    (F.clienteConta?.id || null) !== (clienteContaIdNoInicio || null);
  if (contextoMudou()) return;

  try {
    const res = await fetch(
      `${API_BASE}/operacao/central-vendas/${encodeURIComponent(clienteSlugNoInicio)}/sync-runs/${runId}`,
      { headers: { Authorization: 'Bearer ' + TOKEN } }
    );
    if (res.status === 401) { window.location.replace('index.html'); return; }
    const json = await res.json();

    if (contextoMudou()) return;

    if (!res.ok || !json?.ok) {
      pararPollingSync();
      setActionStatus(`Erro ao acompanhar sincronização: ${json?.erro || `HTTP ${res.status}`}`, ACTION_TONE.danger);
      setAdminBusy(false);
      return;
    }

    const run = json.run;
    if (run.status === 'queued' || run.status === 'running') {
      setActionStatus(run.status === 'queued' ? 'Sincronização na fila…' : 'Sincronizando pedidos via API do Mercado Livre…', ACTION_TONE.info);
      F.sync.timer = setTimeout(() => pollSyncRun(runId, clienteSlugNoInicio, clienteContaIdNoInicio), SYNC_POLL_MS);
      return;
    }

    pararPollingSync();
    setAdminBusy(false);

    if (run.status === 'failed') {
      setActionStatus(`Sincronização falhou: ${run.error?.message || 'erro desconhecido'}.`, ACTION_TONE.danger);
      return;
    }

    const meta = run.metadata || {};
    F.lastSyncBase = run.baseId ? { id: run.baseId } : null;
    setActionStatus('Sincronização concluída. Recarregando…', ACTION_TONE.info);
    await carregarTela();
    setActionStatus(resumoConclusaoSync(run, json.sources, meta), run.completenessStatus === 'partial' ? ACTION_TONE.warn : ACTION_TONE.ok);
  } catch (_) {
    if (!contextoMudou()) F.sync.timer = setTimeout(() => pollSyncRun(runId, clienteSlugNoInicio, clienteContaIdNoInicio), SYNC_POLL_MS);
  }
}

async function retomarSyncEmAndamento() {
  if (!TOKEN || !F.cliente || !F.periodo) return;
  if (F.contas.length > 1 && !F.clienteConta) return;
  pararPollingSync();
  const clienteContaId = F.clienteConta?.id || null;
  try {
    const params = new URLSearchParams({
      limit: '5',
      dateFrom: F.periodo.dateFrom,
      dateTo: F.periodo.dateTo,
    });
    if (clienteContaId) params.set('clienteContaId', clienteContaId);
    const res = await fetch(
      `${API_BASE}/operacao/central-vendas/${encodeURIComponent(F.cliente.slug)}/sync-runs?${params.toString()}`,
      { headers: { Authorization: 'Bearer ' + TOKEN } }
    );
    if (!res.ok) return;
    const json = await res.json();
    const ativo = (json.runs || []).find(r => r.status === 'queued' || r.status === 'running');
    if (!ativo) return;

    F.sync.runId = ativo.id;
    F.sync.clienteSlug = F.cliente.slug;
    F.sync.clienteContaId = clienteContaId;
    setAdminBusy(true, 'fapi-sync-btn');
    setActionStatus('Retomando acompanhamento de sincronização em andamento…', ACTION_TONE.info);
    pollSyncRun(ativo.id, F.cliente.slug, clienteContaId);
  } catch (_) { /* silencioso — não bloqueia a tela por causa do resume */ }
}

/* ── WIRING ESTÁTICO (uma vez, no boot — delegação nos hosts) ── */
function wireStatic() {
  // F2.2 — seletores de Cliente/Conta removidos: o contexto vem do Shell V3
  // (aplicarContextoDoShell(), assinado via evento 'vf:context' no topo do
  // arquivo). Período não é contexto (D11) e continua local.
  document.getElementById('fapi-period-select')?.addEventListener('change', onPeriodChange);
  document.getElementById('fapi-period-apply')?.addEventListener('click', aplicarPeriodoCustom);
  document.getElementById('fapi-refresh-btn')?.addEventListener('click', () => {
    setActionStatus('', '');
    carregarTela();
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

  const tabs = document.getElementById('fapi-tabs');
  tabs?.addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab) setActiveTab(tab.dataset.tab);
  });
  tabs?.addEventListener('keydown', onTablistKeydown);

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
    const row = e.target.closest('tr[data-row-id]');
    if (row) { openOrderDrawer(row.dataset.rowId, row); return; }
  });
  pedidos?.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('tr[data-row-id]');
    if (row && e.target === row) { e.preventDefault(); openOrderDrawer(row.dataset.rowId, row); }
  });

  wireCurvaAbc();

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
