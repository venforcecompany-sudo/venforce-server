/* ================================================================
   cliente-360.js — VenForce · Cockpit do Cliente
   ----------------------------------------------------------------
   Thin client: busca dados → consolida em `resumoMes` → renderiza.
   O frontend NÃO recalcula o que o backend já calcula. Ele apenas
   normaliza, formata e monta a tela.

   SEAM PARA O BACKEND (Etapa 2 do roadmap):
   `consolidarResumoMes()` produz exatamente o shape que o futuro
   endpoint `GET /operacao/cliente-360/:slug` deve retornar em
   `resumoMes`. Quando o endpoint existir, basta trocar o miolo de
   `loadCliente360()` por uma única chamada e ler `data.resumoMes`,
   `data.fechamentos`, `data.relatorios`, etc. Nada mais muda.
   ================================================================ */

const API_BASE = "https://venforce-server.onrender.com";
const TOKEN    = localStorage.getItem("vf-token") || "";

/* ── FORMATADORES ─────────────────────────────────────────── */
const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const fmt    = (n, d = 0) => (Number(n) || 0).toLocaleString('pt-BR',
  { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtBRL = n => 'R$ ' + fmt(n, 2);
const fmtPct = n => fmt(n, 1) + '%';
/* Data robusta: null/undefined/''/Invalid Date → '—'. Nunca exibe "Invalid Date". */
const fmtDt  = s => {
  if (s === null || s === undefined || s === '') return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('pt-BR');
};
/* Mostra '—' quando o dado não foi sincronizado (null/undefined),
   mas exibe 0 real quando o valor sincronizado for de fato zero. */
const valOr  = (n, f) => (n === null || n === undefined) ? '—' : f(n);

/* ── THRESHOLDS (centralizados, fácil de ajustar) ────────── */
const MC_OK     = 15;   // MC% boa → verde
const MC_WARN   = 8;    // MC% atenção → âmbar
const TACOS_WARN = 6;   // TACoS acima disso → revisar Ads
const SYNC_STALE_H = 18; // horas até "atualização recomendada"

/* ── STATE ───────────────────────────────────────────────── */
const S = {
  clientes:    [],
  cliente:     null,
  entregas:    [],
  relatorios:  [],
  bases:       [],
  tokens:      [],
  ads:         [],
  adsMensal:   [],
  metricas:    null,
  metricasLoading: false,
  adsResumo:   null,    // resumo mensal gerencial (ads_resumos_mensais) — tem faturamentoTotal
  adsPerformance: null, // performance Mercado Ads ao vivo (/ads/performance)
  adsPerfLoading: false,
  diagSimAlvo: null,    // margem alvo simulada localmente (%) — não salva
  periodo:     { competencia: null, label: '', dateFrom: null, dateTo: null },
  resumoMes:   null,   // objeto consolidado (shape do endpoint unificado)
  temGrant:    false,
  grant:       null,   // { temGrant, status, mlUserIdMascarado, expiresAt }
  sync:        null,   // { status, precisaSincronizar, ultimaSincronizacao, motivo }
  diagnosticoAuto: null, // { issues, oportunidades, acoes, ultimo }
  freteHistorico: null,
  proximoPasso: null,
  activeTab:   'overview',
  compare:     { a: null, b: null },
  compareData: { a: null, b: null },
  diag:        { relId: null, loading: false, itens: null, erro: false },
};

/* ── API ─────────────────────────────────────────────────── */
async function api(path) {
  try {
    const r = await fetch(API_BASE + path, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function apiPublic(token) {
  try {
    const r = await fetch(API_BASE + '/public/entregas/' + token);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function apiDelete(path) {
  try {
    const r = await fetch(API_BASE + path, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + TOKEN }
    });
    return r.ok;
  } catch { return false; }
}
async function apiPost(path, body) {
  try {
    const r = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : null,
    });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0, data: null }; }
}

/* Papel do usuário (mesma fonte usada pelo layout.js: vf-user no localStorage). */
function isAdmin360() {
  try {
    const u = JSON.parse(localStorage.getItem('vf-user') || '{}');
    return String(u.role || '').toLowerCase() === 'admin';
  } catch { return false; }
}

/* ── PERÍODO / COMPETÊNCIA ───────────────────────────────── */
const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
function competenciaAtual() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const first = new Date(y, m, 1);
  const mesNome = first.toLocaleDateString('pt-BR', { month: 'long' });
  return {
    competencia: `${y}-${String(m+1).padStart(2,'0')}`,
    label: `${mesNome.charAt(0).toUpperCase()}${mesNome.slice(1)}/${y}`,
    dateFrom: ymd(first),
    dateTo:   ymd(now),
  };
}

/* ── SYNC TIMESTAMP (localStorage por cliente) ───────────── */
const syncKey = slug => `c360-sync-${slug}`;
function marcarSync(slug) { try { localStorage.setItem(syncKey(slug), new Date().toISOString()); } catch {} }
function lerSync(slug)   { try { return localStorage.getItem(syncKey(slug)); } catch { return null; } }
function fmtSync(iso) {
  if (!iso) return null;
  const d = new Date(iso), now = new Date();
  if (isNaN(d.getTime())) return null;   // data inválida → trata como sem registro
  const hh = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const isYest = d.toDateString() === yest.toDateString();
  const when = sameDay ? `hoje às ${hh}` : isYest ? `ontem às ${hh}`
             : `${d.toLocaleDateString('pt-BR')} às ${hh}`;
  return { text: when, stale: (now - d) / 3.6e6 > SYNC_STALE_H };
}

/* ── INIT ────────────────────────────────────────────────── */
async function init360() {
  // Lista operacional segura (admin/user/membro). Substitui /clientes (admin-only).
  // Fallback para /clientes apenas se o endpoint novo não existir (deploy antigo).
  let data = await api('/operacao/cliente-360/clientes');
  if (!data?.ok) data = await api('/clientes');
  S.clientes = data?.clientes || data || [];
  if (!Array.isArray(S.clientes)) S.clientes = [];

  const sel = document.getElementById('c360-client-select');
  if (sel) {
    sel.innerHTML = '<option value="">Selecione o cliente…</option>' +
      S.clientes
        .filter(c => c?.ativo !== false)
        .sort((a, b) => (a.nome || '').localeCompare(b.nome || ''))
        .map(c => `<option value="${esc(c.slug)}">${esc(c.nome)}</option>`)
        .join('');
    sel.addEventListener('change', () => {
      const slug = sel.value;
      if (!slug) return;
      S.cliente = S.clientes.find(c => c.slug === slug) || null;
      loadCliente360();
    });
  }

  renderAtalhos360();

  const saved = localStorage.getItem('c360-last-slug') || localStorage.getItem('vfop-last-slug');
  if (saved && S.clientes.find(c => c.slug === saved)) {
    if (sel) sel.value = saved;
    S.cliente = S.clientes.find(c => c.slug === saved) || null;
    if (S.cliente) loadCliente360();
  }

  document.querySelectorAll('.c360-tab').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
}

/* ── LOAD UNIFICADO (endpoint /operacao/cliente-360/:slug) ──
   Lê o estado salvo (snapshot). NUNCA dispara sincronização/Orders API.
   Em falha (404/5xx/deploy antigo), cai no caminho legado. */
async function loadCliente360(forcado = false) {
  const slug = S.cliente?.slug;
  if (!slug) return;

  const pick = document.getElementById('c360-pick');
  if (pick) pick.style.display = 'none';

  const syncBtn = document.getElementById('c360-sync-btn');
  if (forcado && syncBtn) syncBtn.classList.add('loading');
  else {
    document.getElementById('c360-loading').style.display = 'flex';
    document.getElementById('c360-content').style.display = 'none';
  }
  localStorage.setItem('c360-last-slug', slug);
  S.diag = { relId: null, loading: false, itens: null, erro: false };
  S.metricas = null; S.metricasLoading = false;   // métricas ML carregam sob demanda (aba)
  S.adsPerformance = null; S.adsPerfLoading = false; S.adsResumo = null;
  S.diagSimAlvo = null;                            // limpa simulação ao trocar de cliente

  const data = await api(`/operacao/cliente-360/${encodeURIComponent(slug)}`);

  if (!data?.ok) {
    // Fallback: endpoint novo indisponível → consolida no front (legado).
    console.warn('[c360] endpoint unificado indisponível, usando fallback legado');
    return fallbackLoadCliente360Legacy(forcado);
  }

  normalizeCliente360Response(data);

  renderHeader360();
  renderSyncBar();
  renderCockpit();
  renderReco();
  updateTabCounts();
  renderTab360(S.activeTab);

  if (syncBtn) syncBtn.classList.remove('loading');
  document.getElementById('c360-loading').style.display = 'none';
  document.getElementById('c360-content').style.display = 'block';

  // Enriquecimento de Ads em background: 1 chamada leve à API Mercado Ads
  // (NÃO é Orders API nem sync pesado). Não bloqueia o render; preenche
  // "Ads investido"/"TACoS" no cockpit e a aba Ads assim que chegar.
  if (S.temGrant) ensureAdsPerformance360();
}

/* Mapeia o payload do backend para os shapes que os renderers já consomem. */
function normalizeCliente360Response(data) {
  S.periodo = {
    competencia: data.periodo?.competencia || null,
    label: data.periodo?.label || '',
    dateFrom: data.periodo?.dateFrom || null,
    dateTo: data.periodo?.dateTo || null,
  };
  S.sync = data.sync || null;
  S.grant = data.grant || null;
  S.temGrant = !!data.grant?.temGrant;
  S.diagnosticoAuto = data.diagnostico || null;
  S.freteHistorico = data.freteHistorico || null;
  S.proximoPasso = data.proximoPasso || null;

  // Bases → shape com .vinculo (renderBases360)
  S.bases = (data.bases || []).map(b => ({
    id: b.id, nome: b.nome, slug: b.slug, updated_at: b.atualizadaEm,
    vinculo: { marketplace: b.marketplace, origem: b.origem, cliente_slug: data.cliente?.slug },
  }));

  // Relatórios → snake_case (renderDiag / bucketsFromList / updateTabCounts)
  S.relatorios = (data.relatorios || []).map(r => ({
    id: r.id, cliente_slug: data.cliente?.slug, base_slug: r.baseSlug,
    escopo: r.escopo, status: r.status,
    total_itens: r.totalItens, itens_com_base: r.itensComBase,
    itens_sem_base: r.itensSemBase, itens_criticos: r.itensCriticos,
    itens_atencao: r.itensAtencao, itens_saudaveis: r.itensSaudaveis,
    mc_media: r.mcMedia, margem_alvo: r.margemAlvo ?? null,
    created_at: r.criadoEm, updated_at: r.criadoEm,
  }));

  // Entregas / histórico
  S.entregas = (data.historico || []).map(e => ({
    id: e.id, tipo: e.tipo, titulo: e.titulo, periodo: e.periodo, status: e.status,
    token_publico: e.tokenPublico, publicado: e.publicado, created_at: e.criadoEm,
    cliente_slug: data.cliente?.slug, cliente_id: data.cliente?.id,
  }));

  // Ads mensal gerencial (tem faturamentoTotal, usado no TACoS)
  const a = data.ads && data.ads.mes ? data.ads : null;
  S.adsResumo = a;
  S.ads = [];
  S.adsMensal = a ? [{ mes: a.mes, investimento: a.investimentoAds, tacos: a.tacos, roas: a.roas }] : [];

  // resumoMes no shape do renderCockpit
  const rm = data.resumoMes || {};
  const pedidos = rm.pedidos, cancelados = rm.cancelados;
  // % só quando há pedidos reais; sem denominador → null (nunca 0% falso).
  const cancelPct = (pedidos > 0 && cancelados != null) ? (cancelados / pedidos * 100) : null;
  S.resumoMes = {
    competencia: S.periodo.competencia, label: S.periodo.label,
    faturamento: rm.faturamento ?? null,
    mcMedia: rm.mcMedia ?? null,
    pedidos: pedidos ?? null,
    cancelados: cancelados ?? null,
    cancelPct,
    unidades: null,
    ticketMedio: null,
    valorCancelado: null,
    adsInvestido: rm.adsInvestido ?? null,
    adsRef: rm.adsRef ?? (a && a.referencia ? a.mes : null),
    // Snapshot e enriquecimento vêm de ads_resumos_mensais (gerencial);
    // 'mercado_ads' só após aplicarAdsNoCockpit (performance ao vivo).
    adsFonte: (rm.adsInvestido ?? null) != null ? 'gerencial' : null,
    tacos: rm.tacos ?? null,
    roas: a?.roas ?? null,
    fechamentos: rm.fechamentosCount ?? 0,
    diagnosticos: rm.diagnosticosCount ?? 0,
    temGrant: S.temGrant,
    temBase: (data.setup?.temBase) ?? (S.bases.length > 0),
    ultimaSync: data.sync?.ultimaSincronizacao || null,
  };
}

/* Sincronização pesada — ADMIN ONLY. POST /sincronizar → recarrega o GET. */
async function sincronizarResumoMes() {
  const slug = S.cliente?.slug;
  if (!slug) return;
  if (!isAdmin360()) { alert('Apenas administradores podem sincronizar.'); return; }
  const aviso = 'Essa sincronização pode demorar e consumir chamadas da API do Mercado Livre.\n\n' +
    'Em clientes grandes, pode levar até 30 segundos ou mais.\n\nDeseja continuar?';
  if (!confirm(aviso)) return;

  const btn = document.getElementById('c360-sync-btn');
  if (btn) { btn.classList.add('loading'); btn.disabled = true; }

  const res = await apiPost(`/operacao/cliente-360/${encodeURIComponent(slug)}/sincronizar`, {});
  if (btn) { btn.classList.remove('loading'); btn.disabled = false; }

  if (res.status === 409) { alert('Já existe uma sincronização em andamento para este cliente.'); return; }
  if (!res.ok) { alert('Falha na sincronização. Tente novamente.'); return; }

  await loadCliente360();   // recarrega o snapshot recém-gravado
}

/* ── LOAD LEGADO (fallback) — consolida no front a partir dos endpoints antigos ── */
async function fallbackLoadCliente360Legacy(forcado = false) {
  const slug = S.cliente?.slug;
  if (!slug) return;

  const pick = document.getElementById('c360-pick');
  if (pick) pick.style.display = 'none';

  // Botão de atualizar em estado "loading"
  const syncBtn = document.getElementById('c360-sync-btn');
  if (forcado && syncBtn) syncBtn.classList.add('loading');
  else {
    document.getElementById('c360-loading').style.display = 'flex';
    document.getElementById('c360-content').style.display = 'none';
  }
  localStorage.setItem('c360-last-slug', slug);
  S.diag = { relId: null, loading: false, itens: null, erro: false };   // limpa detalhe do cliente anterior

  S.periodo = competenciaAtual();
  const { dateFrom, dateTo } = S.periodo;

  const [entregasRes, basesRes, grantRes, relRes, adsRes, adsMensalRes, metRes] =
    await Promise.all([
      api(`/entregas-cliente?cliente_slug=${encodeURIComponent(slug)}`),
      api('/base-vinculos'),
      api('/metricas/clientes'),                 // grant via lista ML (NUNCA /admin/ml-tokens)
      api('/automacoes/relatorios'),
      api('/ads/acompanhamento'),
      api('/ads/resumo-mensal'),
      api(`/metricas/resumo?clienteSlug=${encodeURIComponent(slug)}&dateFrom=${dateFrom}&dateTo=${dateTo}`),
    ]);

  // ── Filtragem por cliente (frágil hoje; o endpoint unificado resolve) ──
  const allEntregas = entregasRes?.entregas || [];
  S.entregas = allEntregas.filter(e =>
    e?.cliente_slug === slug || String(e?.cliente_id) === String(S.cliente?.id));

  const allBases = basesRes?.bases || basesRes?.vinculos || basesRes || [];
  S.bases = (Array.isArray(allBases) ? allBases : []).filter(b =>
    b?.vinculo?.cliente_slug === slug || b?.vinculo?.cliente_id === S.cliente?.id);

  // Grant detectado pela lista de clientes com ML (sem expor token).
  const clientesComML = grantRes?.clientes || [];
  S.tokens = [];
  S.temGrant = clientesComML.some(c => c?.slug === slug || c?.id === S.cliente?.id);

  const allRel = relRes?.relatorios || relRes || [];
  const primeiroNome = (S.cliente?.nome || '').toLowerCase().split(' ')[0];
  S.relatorios = (Array.isArray(allRel) ? allRel : []).filter(r =>
    r?.cliente_slug === slug || r?.clienteSlug === slug ||
    (primeiroNome && r?.cliente_nome?.toLowerCase().includes(primeiroNome)));

  const allAds = adsRes?.acompanhamentos || adsRes?.data || adsRes || [];
  S.ads = (Array.isArray(allAds) ? allAds : []).filter(a =>
    a?.cliente_slug === slug || a?.clienteSlug === slug);
  const allMensal = adsMensalRes?.resumos || adsMensalRes || [];
  S.adsMensal = (Array.isArray(allMensal) ? allMensal : []).filter(a =>
    a?.cliente_slug === slug || a?.clienteSlug === slug);

  S.metricas = metRes?.ok ? metRes : null;

  // ── Consolidação (seam do endpoint futuro) ──
  S.resumoMes = consolidarResumoMes();
  marcarSync(slug);

  // ── Render ──
  renderHeader360();
  renderSyncBar();
  renderCockpit();
  renderReco();
  updateTabCounts();
  renderTab360(S.activeTab);

  if (syncBtn) syncBtn.classList.remove('loading');
  document.getElementById('c360-loading').style.display = 'none';
  document.getElementById('c360-content').style.display = 'block';
}

/* ── CONSOLIDADOR — shape do endpoint /operacao/cliente-360/:slug ──
   Produz `resumoMes` com NULL explícito onde o dado não existe,
   para nunca exibir 0 como se fosse dado sincronizado. */
function consolidarResumoMes() {
  const r = S.metricas?.resumo || null;
  const temML = !!S.metricas;

  // MC média: vem do diagnóstico/base de custo, não do /metricas/resumo (que é orders ML).
  // Tenta métricas → último relatório → null.
  const ultimoRel = [...S.relatorios].sort((a, b) =>
    new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))[0];
  const mc = r?.mcMedia ?? r?.mc_media
    ?? ultimoRel?.mc_media ?? ultimoRel?.mcMedia ?? ultimoRel?.mc_medio ?? null;

  const pedidos    = temML ? (r?.quantidadeVendas ?? 0) : null;
  // Mesmos campos da aba Métricas (ajustada → API → null). Nunca 0 falso.
  const cancelados = temML ? (r?.quantidadeCanceladasAjustada ?? r?.quantidadeCanceladasApi ?? null) : null;
  const cancelPct  = (temML && pedidos > 0 && cancelados != null) ? (cancelados / pedidos * 100) : null;

  // Ads do mês: prioriza a competência atual; senão usa o registro mais recente (marcado como ref.)
  const comp = S.periodo.competencia;
  const norm = m => String(m?.mes || '').replace(/[^\d]/g, '');
  const compNum = comp ? comp.replace('-', '') : '';
  let adsEntry = S.adsMensal.find(m => m.mes === comp || norm(m).includes(compNum)) || null;
  let adsRef = null;
  if (!adsEntry && S.adsMensal.length) {
    adsEntry = [...S.adsMensal].sort((a, b) => String(b.mes||'').localeCompare(String(a.mes||'')))[0];
    adsRef = adsEntry?.mes || null;
  }

  const adsInvest = adsEntry ? (adsEntry.investimento ?? 0) : null;
  const fat = temML ? (r?.vendasBrutas ?? 0) : null;
  // TACoS sempre Ads ÷ faturamento da Cliente 360. Sem faturamento ML → null
  // (nunca cai no TACoS gerencial, que usa outro denominador).
  const tacos = (adsInvest !== null && fat) ? adsInvest / fat * 100 : null;

  return {
    competencia:  comp,
    label:        S.periodo.label,
    // Performance do mês
    faturamento:  fat,
    mcMedia:      mc,
    pedidos,
    cancelados,
    cancelPct,
    unidades:     temML ? (r?.unidadesVendidas ?? 0) : null,
    ticketMedio:  temML ? (r?.ticketMedio ?? 0) : null,
    valorCancelado: temML ? (r?.valorCanceladoAjustado ?? r?.valorCanceladoApi ?? null) : null,
    // Operação e mídia
    adsInvestido: adsInvest,
    adsRef,
    adsFonte: adsInvest != null ? 'gerencial' : null,
    tacos,
    roas:         adsEntry?.roas ?? null,
    fechamentos:  S.entregas.filter(e => e.tipo === 'fechamento_mensal').length,
    diagnosticos: S.relatorios.length,
    // Estado
    temGrant:     S.temGrant,
    temBase:      S.bases.length > 0,
    ultimaSync:   lerSync(S.cliente?.slug),
  };
}

/* ── SETUP SCORE ─────────────────────────────────────────── */
function computeSetup() {
  const checks = [
    S.temGrant,                  // grant ML
    S.bases.length > 0,          // base vinculada
    S.relatorios.length > 0,     // diagnóstico
    S.entregas.some(e => e.tipo === 'fechamento_mensal'), // fechamento
    S.adsMensal.length > 0,      // acompanhamento ads
  ];
  const done = checks.filter(Boolean).length;
  const pct = Math.round(done / checks.length * 100);
  const level = pct >= 80 ? 'ok' : pct >= 50 ? 'warn' : 'crit';
  return { pct, level };
}

/* ── HEADER ──────────────────────────────────────────────── */
function renderHeader360() {
  const c = S.cliente;
  if (!c) return;
  const setup = computeSetup();

  setText('c360-page-title', c.nome || '—');

  const metaEl = document.getElementById('c360-meta');
  if (metaEl) {
    metaEl.innerHTML = `
      <span class="mono" style="font-family:'JetBrains Mono',monospace;font-size:11.5px;">${esc(c.slug)}</span>
      <span class="c360-meta-sep"></span>
      <span>Canal: Mercado Livre</span>
      <span class="c360-meta-sep"></span>
      <span class="c360-setup-pill ${setup.level}">
        <span class="c360-setup-dot"></span> Setup <b>${setup.pct}%</b>
      </span>`;
  }

  const actEl = document.getElementById('c360-head-actions');
  if (actEl) {
    actEl.innerHTML = `
      <a href="cliente-operacao.html" class="c360-btn c360-btn-ghost">← Setup</a>
      ${!S.temGrant ? `
        <button class="c360-btn c360-btn-ghost" onclick="copiarLink360('${esc(c.slug)}')">
          Copiar link ML
        </button>` : ''}
      <button class="c360-btn c360-btn-ghost"
              onclick="salvarAtalho360('${esc(c.slug)}','${esc((c.nome||'').replace(/'/g,''))}')">
        ☆ Atalho
      </button>
      <a href="financeiro.html" class="c360-btn c360-btn-primary">+ Novo fechamento</a>`;
  }

  const chipEl = document.getElementById('c360-switcher-chip');
  if (chipEl) {
    const initials = (c.nome || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    const temDados = S.entregas.length > 0 ? 'com dados' : 'sem dados';
    chipEl.innerHTML = `
      <div class="vfop-switch-chip">
        <div class="vfop-switch-chip-ic">${initials}</div>
        <div class="vfop-switch-chip-body">
          <div class="vfop-switch-chip-name">${esc(c.nome)}</div>
          <div class="vfop-switch-chip-meta">360 · ${temDados}</div>
        </div>
        <span class="vfop-switch-chip-chev">▾</span>
      </div>`;
  }
  renderAtalhos360();
}

/* ── SYNC BAR ────────────────────────────────────────────── */
function renderSyncBar() {
  const el = document.getElementById('c360-syncbar');
  if (!el) return;
  const admin = isAdmin360();

  // Estado vindo do backend (S.sync). Fallback ao timestamp local (legado).
  let stateHtml;
  if (S.sync) {
    const when = fmtSync(S.sync.ultimaSincronizacao);
    if (S.sync.status === 'ausente') {
      stateHtml = `<span class="c360-sync-state stale">Sem sincronização ainda${admin ? ' · clique em Sincronizar' : ''}</span>`;
    } else if (S.sync.status === 'stale') {
      stateHtml = `<span class="c360-sync-state stale">Snapshot de <span class="mono">${when ? when.text : '—'}</span> · ${admin ? 'sincronização recomendada' : 'aguardando atualização'}</span>`;
    } else {
      stateHtml = `<span class="c360-sync-state">Atualizado <span class="mono">${when ? when.text : '—'}</span></span>`;
    }
  } else {
    const sync = fmtSync(S.resumoMes?.ultimaSync);
    stateHtml = sync
      ? `<span class="c360-sync-state ${sync.stale ? 'stale' : ''}">Atualizado <span class="mono">${sync.text}</span></span>`
      : `<span class="c360-sync-state">Dados ao vivo desta sessão</span>`;
  }

  // Botão de ação: só admin sincroniza (fluxo pesado). Demais só leem.
  const acaoHtml = admin
    ? `<button id="c360-sync-btn" class="c360-btn c360-btn-primary c360-btn-sync"
              onclick="sincronizarResumoMes()" title="Consolida o mês via API do Mercado Livre">
         <span class="c360-spin"></span><span class="c360-sync-ic">↻</span> Sincronizar dados
       </button>`
    : `<span class="c360-sync-note">Somente admin pode sincronizar</span>`;

  el.className = 'c360-syncbar';
  el.innerHTML = `
    <span class="c360-comp"><span class="c360-comp-dot"></span> Competência ${esc(S.periodo.label)}</span>
    <span class="c360-syncbar-sep"></span>
    ${stateHtml}
    <span class="c360-syncbar-right">${acaoHtml}</span>`;

  // Aviso obrigatório perto do botão (admin).
  if (admin) {
    el.insertAdjacentHTML('afterend',
      `<div class="c360-sync-warn" id="c360-sync-warn">⚠ Essa sincronização pode demorar e consumir chamadas da API do Mercado Livre. Use apenas quando precisar atualizar os dados do mês. Em clientes grandes, pode levar até 30 segundos ou mais.</div>`);
    // remove duplicado se re-render
    const warns = document.querySelectorAll('#c360-sync-warn');
    warns.forEach((w, i) => { if (i < warns.length - 1) w.remove(); });
  }
}

/* ── COCKPIT (2 grupos de 4 cards) ───────────────────────── */
function card(label, valueHtml, subHtml = '') {
  return `
    <div class="c360-card">
      <div class="c360-card-label">${label}</div>
      <div class="c360-card-value-wrap">${valueHtml}</div>
      <div class="c360-card-sub">${subHtml || '&nbsp;'}</div>
    </div>`;
}
function renderCockpit() {
  const el = document.getElementById('c360-cockpit');
  if (!el) return;
  const m = S.resumoMes;

  // Performance do mês
  const mcCls = m.mcMedia == null ? 'muted'
    : m.mcMedia >= MC_OK ? 'ok' : m.mcMedia >= MC_WARN ? 'warn' : 'crit';
  const cancelSub = (m.cancelPct == null) ? ''
    : `<span class="c360-chip ${m.cancelPct > 5 ? 'warn' : 'flat'}">${fmtPct(m.cancelPct)} dos pedidos</span>`;

  const perf = [
    card('Faturamento', `<div class="c360-card-value brand">${valOr(m.faturamento, fmtBRL)}</div>`,
         'Vendas brutas no mês'),
    card('MC média', `<div class="c360-card-value ${mcCls}">${valOr(m.mcMedia, fmtPct)}</div>`,
         'Margem de contribuição'),
    card('Pedidos', `<div class="c360-card-value">${valOr(m.pedidos, n => fmt(n))}</div>`,
         m.ticketMedio == null ? '' : `Ticket ${fmtBRL(m.ticketMedio)}`),
    card('Cancelados', `<div class="c360-card-value">${valOr(m.cancelados, n => fmt(n))}</div>`, cancelSub),
  ];

  // Operação e mídia
  const tacosCls = m.tacos == null ? 'muted' : m.tacos > TACOS_WARN ? 'crit' : 'ok';
  // Fonte sempre explícita: Mercado Ads (ao vivo, igual à tela Ads) ou
  // gerencial (ads_resumos_mensais). Mês de referência ganha chip de alerta.
  const adsFonteChip = m.adsFonte === 'mercado_ads'
    ? `<span class="c360-chip flat">fonte: Mercado Ads</span>`
    : `<span class="c360-chip flat">fonte: gerencial</span>`;
  const adsSub = m.adsInvestido == null ? 'sem registro do mês'
    : `${m.adsRef ? `<span class="c360-chip warn">ref. ${esc(m.adsRef)}</span> ` : ''}${adsFonteChip}`;

  const oper = [
    card('Ads investido', `<div class="c360-card-value">${valOr(m.adsInvestido, fmtBRL)}</div>`, adsSub),
    card('TACoS', `<div class="c360-card-value ${tacosCls}">${valOr(m.tacos, fmtPct)}</div>`,
         m.tacos == null
           ? (m.adsInvestido == null ? 'sem registro de Ads' : 'sem faturamento do mês')
           : 'Ads ÷ faturamento (Cliente 360)'),
    card('Fechamentos', `<div class="c360-card-value">${fmt(m.fechamentos)}</div>`, 'salvos no total'),
    card('Diagnósticos', `<div class="c360-card-value">${fmt(m.diagnosticos)}</div>`, 'rodados no total'),
  ];

  el.innerHTML = `
    <div class="c360-group">
      <div class="c360-group-label">Performance do mês</div>
      <div class="c360-cards4">${perf.join('')}</div>
    </div>
    <div class="c360-group">
      <div class="c360-group-label">Operação e mídia</div>
      <div class="c360-cards4">${oper.join('')}</div>
    </div>`;
}

/* ── MOTOR DE PRÓXIMO PASSO RECOMENDADO ──────────────────── */
function renderReco() {
  const el = document.getElementById('c360-reco');
  if (!el) return;
  const m = S.resumoMes;
  const slug = S.cliente?.slug;
  const temFechMes = S.entregas.some(e =>
    e.tipo === 'fechamento_mensal' &&
    String(e.periodo || '').includes(S.periodo.competencia.split('-')[1]));

  let reco;
  if (!m.temGrant) {
    reco = { lvl: 'crit', ic: '🔗', k: 'Conectar Mercado Livre',
      t: 'Este cliente ainda não tem grant ML. Copie o link de conexão e envie ao cliente para liberar pedidos e métricas.',
      act: `<button class="c360-btn c360-btn-primary" onclick="copiarLink360('${esc(slug)}')">Copiar link ML</button>` };
  } else if (!m.temBase) {
    reco = { lvl: 'crit', ic: '📦', k: 'Vincular base de custo',
      t: 'Sem base vinculada não há cálculo de margem. Vincule a base do cliente para habilitar MC e fechamento.',
      act: `<a href="bases.html" class="c360-btn c360-btn-primary">Ir para Bases</a>` };
  } else if (m.diagnosticos === 0) {
    reco = { lvl: 'warn', ic: '🔍', k: 'Rodar primeiro diagnóstico',
      t: 'Cliente tem grant e base, mas nenhum diagnóstico. Rode um diagnóstico para identificar itens sem custo e oportunidades.',
      act: `<a href="automacoes.html" class="c360-btn c360-btn-primary">Ir para Automações</a>` };
  } else if (!temFechMes) {
    reco = { lvl: 'warn', ic: '🧾', k: 'Próximo passo recomendado',
      t: `Criar fechamento de <b>${esc(S.periodo.label)}</b>. O cliente já possui base, grant e diagnóstico.`,
      act: `<a href="financeiro.html" class="c360-btn c360-btn-primary">+ Novo fechamento</a>` };
  } else if (m.tacos != null && m.tacos > TACOS_WARN) {
    reco = { lvl: 'warn', ic: '📢', k: 'Atenção em mídia',
      t: `TACoS em <b>${fmtPct(m.tacos)}</b>, acima do limite de ${TACOS_WARN}%. Vale revisar a estratégia de Ads do mês.`,
      act: `<a href="ads.html" class="c360-btn c360-btn-ghost">Revisar Ads</a>` };
  } else {
    reco = { lvl: 'ok', ic: '✓', k: 'Operação saudável',
      t: 'Cliente configurado e em dia: grant, base, diagnóstico e fechamento do mês concluídos.',
      act: `<a href="cliente-operacao.html" class="c360-btn c360-btn-ghost">Ver setup</a>` };
  }

  el.className = `c360-reco ${reco.lvl}`;
  el.innerHTML = `
    <div class="c360-reco-ic">${reco.ic}</div>
    <div class="c360-reco-body">
      <div class="c360-reco-kicker">${esc(reco.k)}</div>
      <div class="c360-reco-text">${reco.t}</div>
    </div>
    <div class="c360-reco-action">${reco.act}</div>`;
}

/* ── TABS ────────────────────────────────────────────────── */
function switchTab(tab) {
  S.activeTab = tab;
  document.querySelectorAll('.c360-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.c360-tab-panel').forEach(p => p.style.display = 'none');
  const panel = document.getElementById('tab-' + tab);
  if (panel) panel.style.display = 'block';
  renderTab360(tab);
}
function updateTabCounts() {
  const counts = {
    bases:       S.bases.length,
    diagnostico: S.relatorios.length,
    fechamentos: S.entregas.filter(e => e.tipo === 'fechamento_mensal').length,
    historico:   S.entregas.length,
  };
  document.querySelectorAll('.c360-tab').forEach(btn => {
    const n = counts[btn.dataset.tab];
    let span = btn.querySelector('.c360-tab-count');
    if (!n) { if (span) span.remove(); return; }
    if (!span) { span = document.createElement('span'); span.className = 'c360-tab-count'; btn.appendChild(span); }
    span.textContent = n;
  });
}
function renderTab360(tab) {
  const panel = document.getElementById('tab-' + tab);
  if (!panel) return;
  // Métricas ML são live — carregam só ao abrir a aba (ação do usuário),
  // nunca no load da página. Não roda no fallback legado (já traz S.metricas).
  if (tab === 'metricas' && S.metricas === null && S.temGrant && !S.metricasLoading) {
    ensureMetricas360();
  }
  if (tab === 'ads' && S.adsPerformance === null && S.temGrant && !S.adsPerfLoading) {
    ensureAdsPerformance360();
  }
  ({ overview: renderOverview, bases: renderBases360, diagnostico: renderDiag,
     metricas: renderMetricas360, ads: renderAds360, fechamentos: renderFechamentos,
     historico: renderHistorico }[tab])?.(panel);
}

/* Carrega métricas ML ao vivo sob demanda (aba Métricas). */
async function ensureMetricas360() {
  const slug = S.cliente?.slug;
  if (!slug || S.metricasLoading) return;
  S.metricasLoading = true;
  const panel = document.getElementById('tab-metricas');
  if (panel) renderMetricas360(panel);
  const { dateFrom, dateTo } = S.periodo;
  const res = await api(`/metricas/resumo?clienteSlug=${encodeURIComponent(slug)}&dateFrom=${dateFrom}&dateTo=${dateTo}`);
  S.metricas = res?.ok ? res : null;
  S.metricasLoading = false;
  if (panel && S.activeTab === 'metricas') renderMetricas360(panel);
}

/* ── ABA: VISÃO GERAL ────────────────────────────────────── */
function renderOverview(el) {
  const temBase = S.bases.length > 0;
  const temGrant = S.temGrant;
  const fechs = S.entregas.filter(e => e.tipo === 'fechamento_mensal');
  const rels = S.relatorios;

  const saude = (temBase && temGrant && rels.length > 0) ? 'ok' : (temBase || temGrant) ? 'warn' : 'crit';
  const saudeLabel = { ok: 'operável', warn: 'atenção', crit: 'crítico' }[saude];

  const ultimoFech = [...fechs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  const ultimoRel  = [...rels].sort((a, b) =>
    new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at))[0];

  const eventos = [
    ultimoFech && { title: 'Fechamento processado', sub: 'Período: ' + (ultimoFech.periodo || '—'),
      date: ultimoFech.created_at, type: 'ok' },
    ultimoRel && { title: 'Diagnóstico rodado', sub: ultimoRel.nome || ultimoRel.slug || '—',
      date: ultimoRel.updated_at || ultimoRel.created_at, type: 'brand' },
    S.adsMensal.length && { title: 'Acompanhamento de Ads', sub: 'Último resumo mensal salvo',
      date: null, type: 'warn' },
  ].filter(Boolean);

  const porDia = S.metricas?.porDia || [];

  el.innerHTML = `
    <div class="c360-grid2 c360-grid2--wide">

      <div class="c360-panel">
        <div class="c360-panel-head">
          <h2 class="c360-panel-title">Saúde operacional</h2>
          <span class="vfop-badge vfop-badge-${saude}">● ${saudeLabel}</span>
        </div>
        <div class="c360-panel-body c360-panel-body--flush">
          <div class="c360-stat-grid">
            <div class="c360-stat-head">
              <div>Canal</div><div>Base</div><div>Grant</div>
              <div>Diagnóstico</div><div>Fechamento</div><div>Status</div>
            </div>
            <div class="c360-stat-row">
              <div><strong>ML · Principal</strong></div>
              <div>${temBase
                ? `<span class="vfop-badge vfop-badge-ok">${esc(S.bases[0]?.nome || 'vinculada')}</span>`
                : `<span class="vfop-badge vfop-badge-warn">pendente</span>`}</div>
              <div>${temGrant
                ? `<span class="vfop-badge vfop-badge-ok">grantado</span>`
                : `<span class="vfop-badge vfop-badge-crit">precisa grant</span>`}</div>
              <div>${rels.length
                ? `<span class="vfop-badge vfop-badge-ok">${rels.length} feito(s)</span>`
                : `<span class="vfop-badge vfop-badge-neutral">pendente</span>`}</div>
              <div>${fechs.length
                ? `<span class="vfop-badge vfop-badge-ok">${fechs.length} salvo(s)</span>`
                : `<span class="vfop-badge vfop-badge-neutral">pendente</span>`}</div>
              <div><span class="vfop-badge vfop-badge-${saude}">${saudeLabel}</span></div>
            </div>
          </div>
        </div>
      </div>

      <div class="c360-panel">
        <div class="c360-panel-head"><h2 class="c360-panel-title">Últimas ações</h2></div>
        <div class="c360-panel-body">
          <div class="c360-timeline">
            ${eventos.length ? eventos.map(ev => `
              <div class="c360-event">
                <div class="c360-event-dot ${ev.type}"></div>
                <div>
                  <div class="c360-event-title">${esc(ev.title)}</div>
                  <div class="c360-event-sub">${esc(ev.sub)}</div>
                </div>
                <div class="c360-event-date">${ev.date ? fmtDt(ev.date) : ''}</div>
              </div>`).join('')
            : `<div class="c360-empty" style="padding:18px 0;"><p>Nenhuma ação registrada ainda.</p></div>`}
          </div>
        </div>
      </div>
    </div>

    <div class="c360-panel">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Vendas por dia · ${esc(S.periodo.label)}</h2>
        <span class="c360-panel-meta">Mercado Livre</span>
      </div>
      ${porDia.length
        ? `<div class="c360-chart" id="c360-overview-chart"></div>`
        : `<div class="c360-empty">
             <div class="c360-empty-icon">📈</div>
             <b>Sem dados do mês</b>
             <p>${temGrant ? 'Nenhum pedido no período ou métricas ainda não carregadas.'
                           : 'Conecte o grant Mercado Livre para ver as vendas diárias.'}</p>
           </div>`}
    </div>`;

  if (porDia.length) renderAreaChart(document.getElementById('c360-overview-chart'), porDia);
}

/* ── GRÁFICO DE ÁREA (SVG, sem dependências, com hover) ──── */
function renderAreaChart(host, porDia) {
  if (!host) return;
  const W = 720, H = 168, padL = 4, padR = 4, padT = 8, padB = 4;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  // Pedidos/dia vêm de quantidadeVendas no /metricas/resumo (agregarPorDia).
  // Se não houver série diária de pedidos, ped = null → "pedidos indisponíveis" (nunca finge 0).
  const pedDe = d => {
    const v = d.quantidadeVendas ?? d.pedidos ?? d.qtd_vendas;
    return (v === null || v === undefined || v === '') ? null : Number(v);
  };
  let data = porDia.map(d => {
    const v = Number(d.vendasBrutas) || 0;
    let ped = pedDe(d);
    // Dia com venda e 0 pedidos é impossível (toda venda é um pedido):
    // a fonte não rastreia pedidos/dia → indisponível, não 0.
    if (ped === 0 && v > 0) ped = null;
    return { v, dia: d.data, ped };
  });
  // Série inteira sem contagem positiva com venda no mês = fonte sem pedidos/dia.
  if (!data.some(d => d.ped != null && d.ped > 0) && data.some(d => d.v > 0)) {
    data = data.map(d => ({ ...d, ped: null }));
  }
  const max = Math.max(1, ...data.map(d => d.v));
  const total = data.reduce((s, d) => s + d.v, 0);
  const n = data.length;
  const X = i => padL + (n <= 1 ? innerW / 2 : i / (n - 1) * innerW);
  const Y = v => padT + innerH - (v / max) * innerH;

  let line = '', area = '';
  data.forEach((d, i) => {
    const x = X(i).toFixed(1), y = Y(d.v).toFixed(1);
    line += (i ? 'L' : 'M') + x + ' ' + y + ' ';
  });
  area = `M${X(0).toFixed(1)} ${(padT+innerH).toFixed(1)} ` +
         data.map((d, i) => `L${X(i).toFixed(1)} ${Y(d.v).toFixed(1)}`).join(' ') +
         ` L${X(n-1).toFixed(1)} ${(padT+innerH).toFixed(1)} Z`;

  // gridlines (3)
  let grid = '';
  for (let g = 1; g <= 3; g++) {
    const gy = (padT + innerH * g / 4).toFixed(1);
    grid += `<line class="c360-chart-grid" x1="${padL}" y1="${gy}" x2="${W-padR}" y2="${gy}"/>`;
  }

  const first = data[0]?.dia ? new Date(data[0].dia).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '';
  const last = data[n-1]?.dia ? new Date(data[n-1].dia).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '';

  host.innerHTML = `
    <div class="c360-chart-top">
      <div class="c360-chart-read">
        <span class="c360-chart-read-val" id="c360-chart-val">${fmtBRL(total)}</span>
        <span class="c360-chart-read-day" id="c360-chart-day">total acumulado</span>
      </div>
      <div class="c360-chart-legend">Pico diário: ${fmtBRL(max)}</div>
    </div>
    <div class="c360-chart-svg-wrap">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Vendas por dia">
        ${grid}
        <path class="c360-chart-area" d="${area}"/>
        <path class="c360-chart-line" d="${line}"/>
        <line class="c360-chart-cursor" id="c360-chart-cursor" y1="${padT}" y2="${padT+innerH}"/>
        <circle class="c360-chart-dot" id="c360-chart-dot" r="3.5"/>
      </svg>
    </div>
    <div class="c360-chart-xaxis"><span>${first}</span><span>${last}</span></div>`;

  const svg = host.querySelector('svg');
  const cursor = host.querySelector('#c360-chart-cursor');
  const dot = host.querySelector('#c360-chart-dot');
  const valEl = host.querySelector('#c360-chart-val');
  const dayEl = host.querySelector('#c360-chart-day');

  function move(clientX) {
    const rect = svg.getBoundingClientRect();
    const px = (clientX - rect.left) / rect.width * W;
    let i = Math.round((px - padL) / innerW * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    const d = data[i];
    const x = X(i), y = Y(d.v);
    cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); cursor.style.opacity = '1';
    dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.style.opacity = '1';
    valEl.textContent = fmtBRL(d.v);
    const diaTxt = d.dia ? new Date(d.dia).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) : '';
    const pedTxt = d.ped == null ? 'pedidos indisponíveis' : (fmt(d.ped) + ' pedidos');
    dayEl.textContent = (diaTxt ? diaTxt + ' · ' : '') + pedTxt;
  }
  function reset() {
    cursor.style.opacity = '0'; dot.style.opacity = '0';
    valEl.textContent = fmtBRL(total); dayEl.textContent = 'total acumulado';
  }
  svg.addEventListener('mousemove', e => move(e.clientX));
  svg.addEventListener('mouseleave', reset);
  svg.addEventListener('touchmove', e => { if (e.touches[0]) move(e.touches[0].clientX); }, { passive: true });
}

/* ── ABA: BASES ──────────────────────────────────────────── */
function renderBases360(el) {
  if (!S.bases.length) {
    el.innerHTML = panelEmpty('Bases vinculadas', '📦', 'Nenhuma base vinculada',
      'Vincule uma base em <a href="bases.html">Bases de Custo</a>.');
    return;
  }
  el.innerHTML = `
    <div class="c360-panel">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Bases vinculadas</h2>
        <span class="c360-panel-meta">${S.bases.length} base(s)</span>
      </div>
      <div class="c360-panel-body c360-panel-body--flush">
        <table class="c360-table">
          <thead><tr><th>Base</th><th>Marketplace</th><th>Origem</th><th>Atualizado</th><th></th></tr></thead>
          <tbody>
            ${S.bases.map(b => `
              <tr>
                <td class="strong">${esc(b.nome || b.slug || '—')}</td>
                <td>${esc(b.vinculo?.marketplace || '—')}</td>
                <td><span class="vfop-badge vfop-badge-ok">${esc(b.vinculo?.origem || 'manual')}</span></td>
                <td class="muted">${fmtDt(b.updated_at)}</td>
                <td><a href="bases.html" class="c360-btn-link">Ver bases →</a></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

/* ── ABA: DIAGNÓSTICO ────────────────────────────────────── */
/* ── acesso defensivo a item de relatório (snake/camel) ── */
const itMlb     = it => it.item_id || it.itemId || it.mlb || it.mlb_id || it.codigo || '';
const itTit     = it => it.titulo || it.title || it.nome || '';
const itMc      = it => { const v = it.mc ?? it.mcMedia ?? it.mc_percentual ?? it.margem;
                          return (v === null || v === undefined || v === '') ? null : Number(v); };
const itPreco   = it => it.preco_efetivo ?? it.precoEfetivo ?? it.preco ?? it.preco_venda ?? null;
const itAcao    = it => it.acao_recomendada || it.acaoRecomendada || it.recomendacao || '';
function itTemBase(it) {
  const v = it.tem_base ?? it.temBase ?? it.com_base;
  if (v === true || v === 'true' || v === 1)  return true;
  if (v === false || v === 'false' || v === 0) return false;
  const c = it.custo ?? it.cost;                       // fallback: custo > 0 ⇒ tem base
  if (c !== undefined && c !== null && c !== '') return Number(c) > 0;
  return null;                                          // desconhecido
}
/* MC/margem podem vir como fração (0.14) ou percentual (14). Normaliza p/ %. */
function toPct(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n) <= 1 ? n * 100 : n;
}
/* margem alvo do relatório em %, default 10. */
function relMargemAlvoPct(r) {
  const v = toPct(r?.margem_alvo ?? r?.margemAlvo);
  return v == null ? 10 : v;
}
/* margem alvo efetiva: simulação local tem prioridade sobre a do relatório. */
function getDiagAlvoPct() {
  if (S.diagSimAlvo != null && Number.isFinite(S.diagSimAlvo)) return S.diagSimAlvo;
  return relMargemAlvoPct(latestRel());
}
/* Regra relativa à margem alvo (em %):
   MC >= alvo → saudável · MC >= alvo-4 → atenção · senão crítico. */
function classifByAlvo(mcPct, alvoPct) {
  if (mcPct === null || mcPct === undefined) return null;
  if (mcPct >= alvoPct) return 'ok';
  if (mcPct >= alvoPct - 4) return 'warn';
  return 'crit';
}
function classifItem(it, alvoPct) {
  const alvo = (alvoPct == null) ? getDiagAlvoPct() : alvoPct;
  return classifByAlvo(toPct(itMc(it)), alvo);
}
/* Ação recomendada construtiva — NUNCA sugere reduzir/baixar preço. */
const REDUCE_PRICE_RX = /(reduz|baix|diminu|abaix).{0,12}pre|pre.{0,12}(reduz|baix|diminu|abaix)/i;
function acaoFor(it, alvoPct) {
  const alvo = (alvoPct == null) ? getDiagAlvoPct() : alvoPct;
  if (itTemBase(it) === false) return 'Cadastrar custo na base';
  const mcp = toPct(itMc(it));
  if (mcp === null) return 'Revisar dados do item (sem MC)';
  if (mcp >= alvo) return 'Manter preço/operação';
  return 'Subir preço para a margem alvo ou revisar custo/frete';
}
/* Sanitiza ação vinda do backend: descarta sugestões de baixar preço. */
function sanitizeAcao(raw, it, alvoPct) {
  const r = String(raw || '').trim();
  if (!r || REDUCE_PRICE_RX.test(r)) return acaoFor(it, alvoPct);
  return r;
}
function latestRel() {
  if (!S.relatorios.length) return null;
  return [...S.relatorios].sort((a, b) =>
    new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))[0];
}
const relId = r => r?.id ?? r?.relatorio_id ?? r?.relatorioId ?? null;

/* contagem precisa a partir dos itens (preferida). MC média em %.
   Itens sem base não entram em crit/warn/ok (não têm custo p/ classificar). */
function computeBuckets(itens, alvoPct) {
  const alvo = (alvoPct == null) ? getDiagAlvoPct() : alvoPct;
  let crit = 0, warn = 0, ok = 0, semBase = 0, mcSum = 0, mcN = 0;
  itens.forEach(it => {
    const semB = itTemBase(it) === false;
    if (semB) { semBase++; return; }
    const c = classifByAlvo(toPct(itMc(it)), alvo);
    if (c === 'crit') crit++; else if (c === 'warn') warn++; else if (c === 'ok') ok++;
    const mcp = toPct(itMc(it));
    if (mcp !== null) { mcSum += mcp; mcN++; }
  });
  return { total: itens.length, semBase, crit, warn, ok, classificados: crit + warn + ok,
           mcMedia: mcN ? mcSum / mcN : null };
}
/* contagem instantânea do item de lista (enquanto o detalhe carrega). MC em %. */
function bucketsFromList(r) {
  const num = v => (v === null || v === undefined || v === '') ? null : Number(v);
  return {
    total:   num(r.total_itens ?? r.itens ?? r.qtd_itens ?? r.quantidade),
    semBase: num(r.sem_custo ?? r.semCusto ?? r.sem_base ?? r.itens_sem_base),
    crit:    num(r.itens_criticos ?? r.criticos ?? r.qtd_criticos),
    warn:    num(r.atencao ?? r.itens_atencao),
    ok:      num(r.saudaveis ?? r.itens_saudaveis),
    mcMedia: toPct(r.mc_media ?? r.mcMedia ?? r.mc_medio),
  };
}
/* confiança derivada (heurística — Preview) */
function confDiag(buckets, r) {
  const dias = r ? (Date.now() - new Date(r.updated_at || r.created_at || Date.now())) / 864e5 : 0;
  const tot = buckets.total || 0;
  const fracSemBase = tot ? (buckets.semBase || 0) / tot : 0;
  if (fracSemBase > 0.2 || dias > 30) return { nivel: 'baixa', motivo: fracSemBase > 0.2 ? 'muitos itens sem base de custo' : 'diagnóstico com mais de 30 dias' };
  if (fracSemBase > 0.05 || dias > 14) return { nivel: 'media', motivo: fracSemBase > 0.05 ? 'alguns itens sem base' : 'diagnóstico com mais de 14 dias' };
  return { nivel: 'alta', motivo: 'base completa e diagnóstico recente' };
}

/* busca o detalhe (itens) do último relatório — preguiçoso, com cache */
async function loadDiagDetalhe(force) {
  const r = latestRel(); const id = relId(r);
  if (!id) return;
  if (!force && S.diag.relId === id && Array.isArray(S.diag.itens)) return;   // já em cache
  S.diag = { relId: id, loading: true, itens: null, erro: false };
  const panel = document.getElementById('tab-diagnostico');
  if (panel) renderDiag(panel);
  const det = await api(`/automacoes/relatorios/${encodeURIComponent(id)}`);
  const itens = det?.itens || det?.relatorio?.itens || det?.items || det?.data?.itens || det?.data?.items || [];
  S.diag = { relId: id, loading: false, itens: Array.isArray(itens) ? itens : [], erro: !det };
  const panel2 = document.getElementById('tab-diagnostico');
  if (panel2) renderDiag(panel2);
}
function atualizarDiagnostico(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Atualizando…'; }
  loadDiagDetalhe(true).finally(() => {
    if (btn) { btn.disabled = false; btn.textContent = 'Atualizar diagnóstico'; }
  });
}
function copiarMLBs(tipo, btn) {
  const itens = S.diag.itens || [];
  const lista = tipo === 'sembase' ? itens.filter(it => itTemBase(it) === false)
              : tipo === 'crit'    ? itens.filter(it => classifItem(it) === 'crit')
              : itens;
  const txt = lista.map(itMlb).filter(Boolean).join('\n');
  if (!txt) return;
  navigator.clipboard.writeText(txt).then(() => {
    if (!btn) return; const orig = btn.textContent; btn.textContent = 'Copiado!';
    setTimeout(() => { btn.textContent = orig; }, 1800);
  });
}

/* ── DIAGNÓSTICO AUTOMÁTICO (prévia read-only do endpoint unificado) ──
   Renderiza issues/oportunidades determinísticas vindas do backend.
   Botão de "rodar" é TODO/futuro — sem ação pesada agora. */
function renderDiagnosticoAutomatico() {
  const d = S.diagnosticoAuto;
  if (!d) return '';
  const issues = d.issues || [], oport = d.oportunidades || [];
  if (!issues.length && !oport.length) return '';

  const sevCls = s => s === 'critico' ? 'crit' : s === 'atencao' ? 'warn' : 'ok';
  const linha = it => `
    <div class="c360-auto-row">
      <span class="c360-sev-dot ${sevCls(it.severidade)}"></span>
      <div class="c360-auto-body">
        <div class="c360-auto-title">${esc(it.titulo)}</div>
        ${it.descricao ? `<div class="c360-auto-desc">${esc(it.descricao)}</div>` : ''}
        ${it.acaoRecomendada ? `<div class="c360-auto-acao">→ ${esc(it.acaoRecomendada)}</div>` : ''}
      </div>
      ${it.fonte ? `<span class="c360-auto-fonte">${esc(it.fonte)}</span>` : ''}
    </div>`;

  return `
    <div class="c360-panel c360-auto">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Diagnóstico automático</h2>
        <div class="c360-panel-actions">
          <span class="c360-panel-meta">${issues.length} problema(s) · ${oport.length} oportunidade(s)</span>
          <button class="c360-btn c360-btn-ghost" disabled title="Em breve">Rodar diagnóstico automático <span class="c360-tag todo">em breve</span></button>
        </div>
      </div>
      <div class="c360-panel-body c360-panel-body--flush">
        ${issues.length ? `<div class="c360-auto-group"><div class="c360-auto-group-label">Problemas e riscos</div>${issues.map(linha).join('')}</div>` : ''}
        ${oport.length ? `<div class="c360-auto-group"><div class="c360-auto-group-label">Oportunidades</div>${oport.map(linha).join('')}</div>` : ''}
      </div>
    </div>`;
}

/* ── RESUMO DO DIAGNÓSTICO (contagens explícitas + ações agregadas) ──
   Usa os itens já carregados do último relatório. Sem novo endpoint. */
function renderDiagResumo(buckets, itens, conf, alvoPct) {
  const total = buckets.total || 0;
  const semBase = buckets.semBase || 0;
  const comBase = Math.max(0, total - semBase);

  const stat = (label, val, cls = '') =>
    `<div class="c360-dstat"><div class="c360-dstat-val ${cls}">${val}</div><div class="c360-dstat-lbl">${label}</div></div>`;

  // Ações recomendadas geradas pela regra (nunca "reduzir preço"), top 5.
  const acoesMap = {};
  (itens || []).forEach(it => {
    const a = acaoFor(it, alvoPct);
    if (a) acoesMap[a] = (acoesMap[a] || 0) + 1;
  });
  const topAcoes = Object.entries(acoesMap).sort((x, y) => y[1] - x[1]).slice(0, 5);

  return `
    <div class="c360-panel c360-diag-resumo">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Resumo do diagnóstico</h2>
        <span class="c360-diag-conf-pill ${conf.nivel}">Confiança ${conf.nivel}</span>
      </div>
      <div class="c360-panel-body c360-panel-body--flush">
        <div class="c360-dstats">
          ${stat('Itens', fmt(total))}
          ${stat('Com base', fmt(comBase), 'ok')}
          ${stat('Sem base', fmt(semBase), semBase > 0 ? 'warn' : '')}
          ${stat('Críticos', valOr(buckets.crit, fmt), 'crit')}
          ${stat('Atenção', valOr(buckets.warn, fmt), 'warn')}
          ${stat('Saudáveis', valOr(buckets.ok, fmt), 'ok')}
          ${stat('MC média', valOr(buckets.mcMedia, fmtPct))}
        </div>
        ${topAcoes.length ? `
          <div class="c360-dacoes">
            <div class="c360-dacoes-label">Principais ações recomendadas</div>
            ${topAcoes.map(([a, n]) =>
              `<div class="c360-dacao-row"><span class="c360-dacao-n">${n}×</span><span>${esc(a)}</span></div>`).join('')}
          </div>` : ''}
      </div>
    </div>`;
}

function renderDiag(el) {
  const autoHtml = renderDiagnosticoAutomatico();
  if (!S.relatorios.length) {
    el.innerHTML = autoHtml + panelEmpty('Diagnóstico por anúncio', '🔍', 'Nenhum diagnóstico ainda',
      'Rode o primeiro diagnóstico em <a href="automacoes.html">Automações</a> para mapear margem, custos e problemas por anúncio.');
    return;
  }
  const r = latestRel();
  // dispara o carregamento do detalhe (uma vez) se ainda não veio
  if (S.diag.relId !== relId(r) && !S.diag.loading) { loadDiagDetalhe(); }

  const alvoPct = getDiagAlvoPct();
  const simulando = S.diagSimAlvo != null;
  const itens   = Array.isArray(S.diag.itens) ? S.diag.itens : null;
  const loading = S.diag.loading || (itens === null && !S.diag.erro);
  const buckets = itens ? computeBuckets(itens, alvoPct)
                        : { ...bucketsFromList(r), classificados: null };
  const conf = confDiag(buckets, r);

  const nome   = r.nome || r.titulo || r.slug || ('Relatório #' + (relId(r) || ''));
  const tipo   = r.escopo || r.tipo || r.tipo_relatorio || '';
  const baseSlug = r.base_slug || r.baseSlug || (S.bases[0]?.base?.slug) || (S.bases[0]?.slug) || null;
  const mc     = buckets.mcMedia;

  const seg = (n) => Math.max(0, (buckets.total ? (n / buckets.total) * 100 : 0));
  const bar = (buckets.total)
    ? `<div class="c360-diag-bar">
         <span class="seg-crit" style="width:${seg(buckets.crit || 0)}%"></span>
         <span class="seg-warn" style="width:${seg(buckets.warn || 0)}%"></span>
         <span class="seg-ok"   style="width:${seg(buckets.ok || 0)}%"></span>
         <span class="seg-none" style="width:${seg(buckets.semBase || 0)}%"></span>
       </div>`
    : `<div class="c360-diag-skel" style="height:10px"></div>`;

  const leg = (cls, label, n) =>
    `<span class="c360-diag-leg"><span class="dot ${cls}"></span>${label} <b>${valOr(n, v => fmt(v))}</b></span>`;

  // ── HERO ──
  const hero = `
    <div class="c360-diag-hero">
      <div class="c360-diag-hero-top">
        <div class="c360-diag-id">
          <div class="c360-diag-name">${esc(nome)}</div>
          <div class="c360-diag-sub">
            <span class="c360-diag-status">concluído</span>
            ${tipo ? `<span class="c360-diag-tipo">${esc(tipo)}</span>` : ''}
            <span>· ${fmtDt(r.updated_at || r.created_at)}</span>
            ${baseSlug ? `<span>· base <code>${esc(baseSlug)}</code></span>` : ''}
          </div>
        </div>
        <div class="c360-diag-actions">
          <button class="c360-btn c360-btn-primary" onclick="atualizarDiagnostico(this)">Atualizar diagnóstico</button>
          <button class="c360-btn" onclick="simularMargemAlvo()">Simular margem alvo</button>
          ${simulando ? `<button class="c360-btn c360-btn-ghost" onclick="limparSimulacaoMargem()">Limpar simulação</button>` : ''}
          <a class="c360-btn" href="relatorios.html">Abrir relatório completo</a>
        </div>
      </div>
      ${simulando ? `<div class="c360-sim-note">Simulação local usando margem alvo de <b>${fmt(alvoPct, 1)}%</b> — não altera o relatório.</div>` : ''}
      <div class="c360-diag-hero-body">
        <div class="c360-diag-mc-box">
          <span class="c360-diag-mc-label">MC média</span>
          <span class="c360-diag-mc">${valOr(mc, fmtPct)}</span>
          <span class="c360-diag-mc-note">${itens ? 'margem alvo ' + fmt(alvoPct, 1) + '% · ' + fmt(buckets.classificados || 0) + ' classificados' : 'carregando itens…'}</span>
        </div>
        <div class="c360-diag-dist">
          ${bar}
          <div class="c360-diag-legend">
            ${leg('crit', 'Críticos', buckets.crit)}
            ${leg('warn', 'Atenção', buckets.warn)}
            ${leg('ok', 'Saudáveis', buckets.ok)}
            ${leg('none', 'Sem base', buckets.semBase)}
          </div>
        </div>
        <div class="c360-diag-conf">
          <span class="c360-diag-conf-pill ${conf.nivel}">Confiança ${conf.nivel}</span>
          <span class="c360-diag-conf-why">${esc(conf.motivo)}</span>
        </div>
      </div>
    </div>`;

  // ── enquanto o detalhe carrega: skeletons ──
  if (loading || !itens) {
    const skelRows = Array.from({ length: 4 }).map(() =>
      `<div class="c360-diag-mlb"><span class="c360-diag-skel" style="width:90px"></span><span class="c360-diag-skel" style="flex:1"></span></div>`).join('');
    el.innerHTML = autoHtml + `<div class="c360-diag">${hero}
      <div class="c360-diag-row">
        <div class="c360-diag-card"><div class="c360-diag-card-head"><span class="c360-diag-card-title">Sem base de custo</span></div><div class="c360-diag-list">${skelRows}</div></div>
        <div class="c360-diag-card"><div class="c360-diag-card-head"><span class="c360-diag-card-title">Críticos</span></div><div class="c360-diag-list">${skelRows}</div></div>
      </div></div>`;
    return;
  }

  // ── conjuntos por item (classificados pela margem alvo vigente) ──
  const mcOrd = it => (toPct(itMc(it)) ?? 999);
  const semBase = itens.filter(it => itTemBase(it) === false);
  const crit    = itens.filter(it => itTemBase(it) !== false && classifItem(it, alvoPct) === 'crit')
                       .sort((a, b) => mcOrd(a) - mcOrd(b));
  const probs   = itens.filter(it => itTemBase(it) !== false && ['crit', 'warn'].includes(classifItem(it, alvoPct)))
                       .sort((a, b) => mcOrd(a) - mcOrd(b));

  const mlbRow = (it, showMc) => `
    <div class="c360-diag-mlb">
      <span class="c360-diag-mlb-code">${esc(itMlb(it) || '—')}</span>
      <span class="c360-diag-mlb-title">${esc(itTit(it) || '—')}</span>
      ${showMc ? `<span class="c360-diag-mlb-mc">${valOr(toPct(itMc(it)), fmtPct)}</span>` : ''}
    </div>`;

  // card 1 — sem base (copiar → futura página do cliente)
  const cardSemBase = semBase.length ? `
    <div class="c360-diag-card">
      <div class="c360-diag-card-head">
        <span class="c360-diag-card-title">Sem base de custo
          <span class="c360-diag-card-count warn">${semBase.length}</span></span>
        <button class="c360-btn c360-btn-sm" onclick="copiarMLBs('sembase', this)">Copiar MLBs</button>
      </div>
      <div class="c360-diag-list">${semBase.map(it => mlbRow(it, false)).join('')}</div>
      <div class="c360-diag-card-foot">Estes anúncios precisam de custo cadastrado. <span class="c360-tag todo">em breve</span> página para o cliente preencher.</div>
    </div>`
    : `<div class="c360-diag-card"><div class="c360-diag-card-head"><span class="c360-diag-card-title">Sem base de custo</span></div>
        <div class="c360-diag-okstate"><b>Tudo com base ✓</b><span>Nenhum anúncio sem custo cadastrado.</span></div></div>`;

  // card 2 — críticos (margem real ruim)
  const cardCrit = crit.length ? `
    <div class="c360-diag-card">
      <div class="c360-diag-card-head">
        <span class="c360-diag-card-title">Críticos <span class="c360-diag-card-count crit">${crit.length}</span></span>
        <button class="c360-btn c360-btn-sm" onclick="copiarMLBs('crit', this)">Copiar MLBs</button>
      </div>
      <div class="c360-diag-list">${crit.map(it => mlbRow(it, true)).join('')}</div>
      <div class="c360-diag-card-foot">MC bem abaixo da margem alvo (${fmt(alvoPct, 1)}%). Subir preço ou revisar custo/frete. <span class="c360-tag real">real</span></div>
    </div>`
    : `<div class="c360-diag-card"><div class="c360-diag-card-head"><span class="c360-diag-card-title">Críticos</span></div>
        <div class="c360-diag-okstate"><b>Nenhum crítico ✓</b><span>Nenhum anúncio muito abaixo da margem alvo.</span></div></div>`;

  // tabela — atenção + crítico
  const tabela = `
    <div class="c360-panel">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Produtos em atenção e crítico</h2>
        <span class="c360-panel-meta">${probs.length} de ${itens.length} anúncios</span>
      </div>
      <div class="c360-panel-body c360-panel-body--flush">
        ${probs.length ? `
        <table class="c360-table">
          <thead><tr>
            <th class="c360-diag-sevcell"></th><th>MLB</th><th>Anúncio</th>
            <th style="text-align:right">MC</th><th style="text-align:right">Preço</th><th>Ação recomendada</th>
          </tr></thead>
          <tbody>
            ${probs.map(it => { const c = classifItem(it, alvoPct); return `
              <tr>
                <td class="c360-diag-sevcell"><span class="c360-sev-dot ${c}"></span></td>
                <td class="c360-diag-mlb-code">${esc(itMlb(it) || '—')}</td>
                <td class="clip">${esc(itTit(it) || '—')}</td>
                <td class="c360-diag-mctd ${c}" style="text-align:right">${valOr(toPct(itMc(it)), fmtPct)}</td>
                <td style="text-align:right">${valOr(itPreco(it), fmtBRL)}</td>
                <td class="c360-diag-acao">${esc(sanitizeAcao(itAcao(it), it, alvoPct))}</td>
              </tr>`; }).join('')}
          </tbody>
        </table>`
        : `<div class="c360-diag-okstate" style="padding:36px"><b>Nenhum produto em atenção ✓</b><span>Todos os anúncios com base atingem a margem alvo (${fmt(alvoPct, 1)}%).</span></div>`}
      </div>
    </div>`;

  el.innerHTML = autoHtml + `<div class="c360-diag">${hero}
    ${renderDiagResumo(buckets, itens, conf, alvoPct)}
    <div class="c360-diag-row">${cardSemBase}${cardCrit}</div>
    ${tabela}</div>`;
}

/* ── SIMULAÇÃO LOCAL DE MARGEM ALVO (não toca backend/relatório) ── */
function simularMargemAlvo() {
  const atual = getDiagAlvoPct();
  const v = prompt('Simular margem alvo (%) — apenas visual, não salva:', String(Math.round(atual)));
  if (v === null) return;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) { alert('Informe uma margem entre 0 e 100.'); return; }
  S.diagSimAlvo = n;
  renderTab360('diagnostico');
}
function limparSimulacaoMargem() {
  S.diagSimAlvo = null;
  renderTab360('diagnostico');
}

/* ── ABA: MÉTRICAS ML ────────────────────────────────────── */
function renderMetricas360(el) {
  const m = S.metricas;
  if (!m) {
    if (S.metricasLoading) {
      el.innerHTML = panelEmpty('Métricas Mercado Livre', '⏳', 'Carregando métricas ao vivo…',
        'Buscando pedidos no Mercado Livre para o período.');
    } else {
      el.innerHTML = panelEmpty('Métricas Mercado Livre', '📊', 'Dados não disponíveis',
        S.temGrant ? 'Nenhum pedido no período ou métricas indisponíveis no momento.'
                   : 'Conecte o grant Mercado Livre para carregar as métricas.');
    }
    return;
  }
  const r = m.resumo || {};
  const top = m.topProdutos || [];
  const canc = m.cancelamentosPorMotivo || [];
  const avisos = m.avisos || [];
  const maxFat = Math.max(1, ...top.map(p => Number(p.faturamento) || 0));

  const snapKey = `c360-snaps-${S.cliente?.slug}`;
  let snaps = []; try { snaps = JSON.parse(localStorage.getItem(snapKey) || '[]'); } catch {}

  // Cancelados: mesma fonte do card topo (resumoMes.cancelados) p/ consistência.
  // Fallback aos campos reais do /metricas/resumo. Sem dado real → '—' (nunca 0/R$0,00 falso).
  const cancelN = (S.resumoMes && S.resumoMes.cancelados != null)
    ? S.resumoMes.cancelados
    : (r.quantidadeCanceladasAjustada ?? r.quantidadeCanceladasApi ?? null);
  const cancelVal = r.valorCanceladoAjustado ?? r.valorCanceladoApi ?? null;

  const resumoRows = [
    ['Vendas brutas',     fmtBRL(r.vendasBrutas || 0)],
    ['Quantidade vendas', fmt(r.quantidadeVendas || 0)],
    ['Unidades vendidas', fmt(r.unidadesVendidas || 0)],
    ['Ticket médio',      fmtBRL(r.ticketMedio || 0)],
    ['Preço médio/unid.', fmtBRL(r.precoMedioUnidade || 0)],
    ['Cancelamentos',     valOr(cancelN, v => fmt(v))],
    ['Valor cancelado',   valOr(cancelVal, fmtBRL)],
  ];

  el.innerHTML = `
    <div class="c360-grid2">
      <div class="c360-panel">
        <div class="c360-panel-head">
          <h2 class="c360-panel-title">Resumo · ${esc(S.periodo.label)}</h2>
          <span class="c360-panel-meta">Mercado Livre</span>
        </div>
        <div class="c360-panel-body c360-panel-body--flush">
          <table class="c360-table">
            ${resumoRows.map(([k, v]) => `
              <tr><td class="muted">${k}</td><td class="strong right">${v}</td></tr>`).join('')}
          </table>
        </div>
        <div class="c360-panel-foot">
          <span>Competência atual</span>
          <button class="c360-btn c360-btn-ghost" onclick="salvarSnapshot()">Salvar snapshot</button>
        </div>
      </div>

      <div class="c360-panel">
        <div class="c360-panel-head">
          <h2 class="c360-panel-title">Snapshots salvos</h2>
          <span class="c360-panel-meta" id="c360-snaps-meta">${snaps.length} salvo(s)</span>
        </div>
        <div id="c360-snaps-list">${renderSnapsList(snaps)}</div>
      </div>
    </div>

    <div class="c360-panel">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Top produtos por faturamento</h2>
        <span class="c360-panel-meta">${top.length} item(ns)</span>
      </div>
      <div class="c360-panel-body c360-panel-body--flush">
        ${top.length ? `
          <table class="c360-table">
            <thead><tr><th>Produto</th><th>MLB</th><th>Unid.</th><th>Faturamento</th><th style="width:120px;"></th></tr></thead>
            <tbody>
              ${top.slice(0, 12).map(p => `
                <tr>
                  <td class="strong clip">${esc(p.titulo || p.sku || '—')}</td>
                  <td class="mono muted">${esc(p.mlb || '—')}</td>
                  <td class="right">${fmt(p.unidades || 0)}</td>
                  <td class="right strong">${fmtBRL(p.faturamento || 0)}</td>
                  <td><div class="c360-bar-track"><div class="c360-bar-fill"
                      style="width:${((Number(p.faturamento)||0)/maxFat*100).toFixed(1)}%"></div></div></td>
                </tr>`).join('')}
            </tbody>
          </table>` : `<div class="c360-empty" style="padding:24px;"><p>Sem produtos no período.</p></div>`}
      </div>
    </div>

    <div class="c360-panel">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Cancelamentos por motivo</h2>
        <span class="c360-panel-meta">${canc.length} motivo(s)</span>
      </div>
      <div class="c360-panel-body c360-panel-body--flush">
        ${canc.length ? `
          <table class="c360-table">
            <thead><tr><th>Motivo</th><th>Responsável</th><th>Pedidos</th><th>Valor</th></tr></thead>
            <tbody>
              ${canc.map(c => `
                <tr>
                  <td class="strong">${esc(c.code || c.group || '—')}</td>
                  <td class="muted">${esc(c.requestedBy || c.group || '—')}</td>
                  <td class="right">${fmt(c.pedidos || 0)}</td>
                  <td class="right strong">${fmtBRL(c.valor || 0)}</td>
                </tr>`).join('')}
            </tbody>
          </table>` : `<div class="c360-empty" style="padding:24px;"><p>Nenhum cancelamento no período.</p></div>`}
      </div>
      ${avisos.length ? `<div class="c360-notes"><ul>${avisos.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>` : ''}
    </div>

    <div class="c360-panel" id="c360-snaps-compare">${renderSnapsCompare(snaps)}</div>`;
}

/* ── SNAPSHOTS (localStorage) ────────────────────────────── */
function salvarSnapshot() {
  const m = S.metricas;
  if (!m || !S.cliente?.slug) return;
  const key = `c360-snaps-${S.cliente.slug}`;
  let snaps = []; try { snaps = JSON.parse(localStorage.getItem(key) || '[]'); } catch {}
  const r = m.resumo || {};
  snaps.unshift({
    id: Date.now(),
    data: new Date().toLocaleDateString('pt-BR'),
    competencia: S.periodo.label,
    vendasBrutas: r.vendasBrutas || 0,
    quantidadeVendas: r.quantidadeVendas || 0,
    ticketMedio: r.ticketMedio || 0,
    mc: S.resumoMes?.mcMedia || 0,
    valorCancelado: r.valorCancelado || 0,
  });
  if (snaps.length > 12) snaps = snaps.slice(0, 12);
  localStorage.setItem(key, JSON.stringify(snaps));

  const list = document.getElementById('c360-snaps-list');
  if (list) list.innerHTML = renderSnapsList(snaps);
  const meta = document.getElementById('c360-snaps-meta');
  if (meta) meta.textContent = `${snaps.length} salvo(s)`;
  const cmp = document.getElementById('c360-snaps-compare');
  if (cmp) cmp.innerHTML = renderSnapsCompare(snaps);

  const btn = document.querySelector('[onclick="salvarSnapshot()"]');
  if (btn) { btn.textContent = 'Salvo!'; setTimeout(() => btn.textContent = 'Salvar snapshot', 1500); }
}
function renderSnapsList(snaps) {
  if (!snaps.length) return `
    <div class="c360-empty" style="padding:24px;">
      <p>Nenhum snapshot salvo ainda.<br>Guarde o resumo do mês para comparar adiante.</p>
    </div>`;
  return `
    <table class="c360-table">
      <thead><tr><th>Data</th><th>Faturamento</th><th>Pedidos</th><th>MC%</th><th></th></tr></thead>
      <tbody>
        ${snaps.map((s, i) => `
          <tr>
            <td class="muted mono">${esc(s.data)}</td>
            <td class="strong">${fmtBRL(s.vendasBrutas)}</td>
            <td class="right">${fmt(s.quantidadeVendas)}</td>
            <td><span class="vfop-badge vfop-badge-${s.mc >= MC_OK ? 'ok' : s.mc >= MC_WARN ? 'warn' : 'crit'}">${fmtPct(s.mc)}</span></td>
            <td><button class="c360-btn c360-btn-danger" onclick="removerSnapshot(${i})">×</button></td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}
function renderSnapsCompare(snaps) {
  if (snaps.length < 2) return `
    <div class="c360-panel-head"><h2 class="c360-panel-title">Comparativo de snapshots</h2></div>
    <div class="c360-empty" style="padding:24px;"><p>Salve pelo menos 2 snapshots para comparar.</p></div>`;
  const [a, b] = snaps;
  const delta = (va, vb, isPct = false) => {
    const d = va - vb, cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
    const str = isPct ? fmtPct(Math.abs(d)) : fmtBRL(Math.abs(d));
    return `<span class="c360-delta-${cls}">${d >= 0 ? '+' : '−'}${str}</span>`;
  };
  const rows = [
    ['Faturamento', fmtBRL(a.vendasBrutas), fmtBRL(b.vendasBrutas), delta(a.vendasBrutas, b.vendasBrutas)],
    ['Pedidos', fmt(a.quantidadeVendas), fmt(b.quantidadeVendas), delta(a.quantidadeVendas, b.quantidadeVendas)],
    ['Ticket médio', fmtBRL(a.ticketMedio), fmtBRL(b.ticketMedio), delta(a.ticketMedio, b.ticketMedio)],
    ['MC média', fmtPct(a.mc), fmtPct(b.mc), delta(a.mc, b.mc, true)],
    ['Cancelado', fmtBRL(a.valorCancelado), fmtBRL(b.valorCancelado), delta(a.valorCancelado, b.valorCancelado)],
  ];
  return `
    <div class="c360-panel-head">
      <h2 class="c360-panel-title">Comparativo de snapshots</h2>
      <span class="c360-panel-meta">${esc(a.data)} vs ${esc(b.data)}</span>
    </div>
    <div class="c360-panel-body c360-panel-body--flush">
      <div class="c360-compare-header"><div>Métrica</div><div>${esc(a.data)} (recente)</div><div>${esc(b.data)} (anterior)</div><div>Δ</div></div>
      ${rows.map(([l, va, vb, dl]) => `
        <div class="c360-compare-row"><div>${l}</div><div><strong>${va}</strong></div><div>${vb}</div><div>${dl}</div></div>`).join('')}
    </div>`;
}
function removerSnapshot(idx) {
  const key = `c360-snaps-${S.cliente?.slug}`;
  let snaps = []; try { snaps = JSON.parse(localStorage.getItem(key) || '[]'); } catch {}
  snaps.splice(idx, 1);
  localStorage.setItem(key, JSON.stringify(snaps));
  const list = document.getElementById('c360-snaps-list');
  if (list) list.innerHTML = renderSnapsList(snaps);
  const meta = document.getElementById('c360-snaps-meta');
  if (meta) meta.textContent = `${snaps.length} salvo(s)`;
  const cmp = document.getElementById('c360-snaps-compare');
  if (cmp) cmp.innerHTML = renderSnapsCompare(snaps);
}

/* ── ADS: performance ao vivo (mesma fonte da tela ads.html) ──
   Carrega /ads/performance sob demanda. Backfill do cockpit ao chegar. */
async function ensureAdsPerformance360() {
  const slug = S.cliente?.slug;
  const mes  = S.periodo?.competencia;
  if (!slug || !mes || S.adsPerfLoading || S.adsPerformance !== null) return;
  if (!S.temGrant) return;   // performance Ads exige conta ML conectada
  S.adsPerfLoading = true;
  const panel = document.getElementById('tab-ads');
  if (panel && S.activeTab === 'ads') renderAds360(panel);

  const res = await api(`/ads/performance?clienteSlug=${encodeURIComponent(slug)}&mes=${encodeURIComponent(mes)}`);
  if (res && res.ok && res.performance) S.adsPerformance = res.performance;
  else if (res && res.semDados)         S.adsPerformance = { semDados: true, motivo: res.motivo };
  else                                  S.adsPerformance = { semDados: true, motivo: 'indisponivel' };
  S.adsPerfLoading = false;

  aplicarAdsNoCockpit();
  if (panel && S.activeTab === 'ads') renderAds360(panel);
}

/* Preenche Ads investido + TACoS no cockpit a partir da performance real. */
function aplicarAdsNoCockpit() {
  const p = S.adsPerformance;
  if (!p || p.semDados || !S.resumoMes) return;
  const invest = (p.investimentoAds == null) ? null : Number(p.investimentoAds);
  if (invest == null) return;
  S.resumoMes.adsInvestido = invest;
  S.resumoMes.adsRef = null;   // performance é do mês selecionado, não referência
  S.resumoMes.adsFonte = 'mercado_ads';   // mesma fonte da tela Ads
  // TACoS = investimento ÷ faturamento da Cliente 360. Sem faturamento → null
  // (nunca usa o faturamento/TACoS gerencial, que tem outro denominador).
  const fat = Number(S.resumoMes.faturamento);
  S.resumoMes.tacos = (Number.isFinite(fat) && fat > 0)
    ? Math.round((invest / fat) * 10000) / 100
    : null;
  renderCockpit();
}

/* ── ABA: ADS ────────────────────────────────────────────── */
function renderAds360(el) {
  const p = S.adsPerformance;
  const temPerf = p && !p.semDados;
  const mensal = [...S.adsMensal].sort((a, b) => String(b.mes || '').localeCompare(String(a.mes || '')));

  // Nada ainda e sem mensal: estado vazio (ou carregando).
  if (!temPerf && !mensal.length) {
    if (S.adsPerfLoading) {
      el.innerHTML = panelEmpty('Ads', '⏳', 'Carregando performance Mercado Ads…',
        'Buscando investimento, ROAS e ACOS do mês.');
    } else {
      el.innerHTML = panelEmpty('Ads', '📢', 'Sem dados de Ads',
        S.temGrant ? 'Nenhuma campanha Mercado Ads no período, ou dados indisponíveis.'
                   : 'Conecte o Mercado Livre para ver a performance de Ads.');
    }
    return;
  }

  // Painel de performance (KPIs reais, mesma fonte da tela Ads).
  const kpi = (label, val, hint = '') =>
    `<div class="c360-adskpi"><div class="c360-adskpi-lbl">${label}</div><div class="c360-adskpi-val">${val}</div>${hint ? `<div class="c360-adskpi-hint">${hint}</div>` : ''}</div>`;

  const perfHtml = temPerf ? `
    <div class="c360-panel">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Performance Mercado Ads · ${esc(S.periodo.label)}</h2>
        <a href="ads.html" class="c360-btn-link">Abrir Ads →</a>
      </div>
      <div class="c360-panel-body">
        <div class="c360-adskpis">
          ${kpi('Investimento', valOr(p.investimentoAds, fmtBRL))}
          ${kpi('GMV Ads', valOr(p.gmvAds, fmtBRL))}
          ${kpi('ROAS', valOr(p.roas, v => fmt(v, 2) + 'x'))}
          ${kpi('ACOS', valOr(p.acos, fmtPct))}
          ${kpi('TACoS', valOr(S.resumoMes?.tacos, fmtPct), S.resumoMes?.faturamento ? 'sobre faturamento (Cliente 360)' : 'sem faturamento do mês')}
          ${kpi('Cliques', valOr(p.cliques, v => fmt(v)))}
          ${kpi('Impressões', valOr(p.impressoes, v => fmt(v)))}
          ${kpi('Vendas', valOr(p.vendas, v => fmt(v)))}
        </div>
      </div>
    </div>` : (p && p.semDados ? `
    <div class="c360-panel"><div class="c360-panel-body">
      <div class="c360-empty" style="padding:18px;"><p>Performance Mercado Ads indisponível para o período (${esc(p.motivo || '—')}).</p></div>
    </div></div>` : '');

  // Tabela gerencial (resumo mensal salvo manualmente).
  const mensalHtml = `
    <div class="c360-panel">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Resumo mensal (gerencial)</h2>
        <a href="ads.html" class="c360-btn-link">Gerenciar →</a>
      </div>
      <div class="c360-panel-body c360-panel-body--flush">
        ${mensal.length ? `
          <table class="c360-table">
            <thead><tr><th>Mês</th><th>Investimento</th><th>TACoS</th><th>ROAS</th></tr></thead>
            <tbody>
              ${mensal.slice(0, 12).map(x => `
                <tr>
                  <td class="muted mono">${esc(x.mes || '—')}</td>
                  <td class="strong">${valOr(x.investimento, fmtBRL)}</td>
                  <td>${x.tacos != null ? `<span class="vfop-badge vfop-badge-${x.tacos > TACOS_WARN ? 'crit' : 'ok'}">${fmtPct(x.tacos)}</span>` : '—'}</td>
                  <td>${x.roas != null ? fmt(x.roas, 1) + 'x' : '—'}</td>
                </tr>`).join('')}
            </tbody>
          </table>` : `<div class="c360-empty" style="padding:24px;"><p>Sem resumo mensal gerencial salvo.</p></div>`}
      </div>
    </div>`;

  el.innerHTML = perfHtml + mensalHtml;
}

/* ── ABA: FECHAMENTOS ────────────────────────────────────── */
function renderFechamentos(el) {
  const fechs = S.entregas
    .filter(e => e.tipo === 'fechamento_mensal')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  el.innerHTML = `
    <div class="c360-panel">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Fechamentos</h2>
        <div class="c360-panel-actions">
          <span class="c360-panel-meta">${fechs.length} salvos</span>
          <a href="financeiro.html" class="c360-btn c360-btn-primary">+ Novo fechamento</a>
        </div>
      </div>
      <div class="c360-fech-list">
        ${fechs.length ? fechs.map(renderFechCard).join('')
          : `<div class="c360-empty"><div class="c360-empty-icon">🧾</div>
               <b>Nenhum fechamento</b><p>Processe um fechamento para visualizar aqui.</p></div>`}
      </div>
      ${fechs.length >= 2 ? `<div class="c360-compare-hint">Selecione <strong>dois fechamentos</strong> para comparar lado a lado.</div>` : ''}
    </div>

    <div class="c360-panel" id="c360-fech-compare">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Comparativo</h2>
        <span class="c360-panel-meta" id="c360-compare-label">Selecione 2 fechamentos</span>
      </div>
      <div id="c360-compare-body" class="c360-panel-body">
        <div class="c360-empty" style="padding:24px;"><p>Selecione dois fechamentos acima.</p></div>
      </div>
    </div>`;
}
function renderFechCard(f) {
  const isA = S.compare.a === f.id, isB = S.compare.b === f.id;
  const tag = isA ? `<span class="c360-tag a">A</span>` : isB ? `<span class="c360-tag b">B</span>` : '';
  return `
    <div class="c360-fech-card ${isA || isB ? 'selected' : ''}" id="fech-card-${f.id}" onclick="toggleFechamento(${f.id})">
      <div class="c360-fech-check"></div>
      <div class="c360-fech-icon">F</div>
      <div class="c360-fech-body">
        <div class="c360-fech-title">${esc(f.titulo || 'Fechamento mensal')}${tag}</div>
        <div class="c360-fech-meta">
          Período: ${esc(f.periodo || '—')} · ${fmtDt(f.created_at)}
          ${f.publicado ? ' · <span class="c360-pub">publicado</span>' : ''}
        </div>
      </div>
      <div class="c360-fech-side" onclick="event.stopPropagation();">
        ${f.token_publico ? `<a href="/relatorio-publico.html?token=${esc(f.token_publico)}" target="_blank" class="c360-btn-link">Ver →</a>` : ''}
        <button class="c360-btn c360-btn-danger" onclick="removerFechamento(${f.id})">Remover</button>
      </div>
    </div>`;
}
async function toggleFechamento(id) {
  if (S.compare.a === id) { S.compare.a = null; S.compareData.a = null; }
  else if (S.compare.b === id) { S.compare.b = null; S.compareData.b = null; }
  else if (!S.compare.a) S.compare.a = id;
  else if (!S.compare.b) S.compare.b = id;
  else { S.compare.a = id; S.compareData.a = null; }

  document.querySelectorAll('.c360-fech-card').forEach(elx => {
    const cid = parseInt(elx.id.replace('fech-card-', ''));
    elx.classList.toggle('selected', S.compare.a === cid || S.compare.b === cid);
  });
  // re-render tags
  renderTab360('fechamentos');
  document.querySelectorAll('.c360-fech-card').forEach(elx => {
    const cid = parseInt(elx.id.replace('fech-card-', ''));
    elx.classList.toggle('selected', S.compare.a === cid || S.compare.b === cid);
  });

  if (S.compare.a && S.compare.b) await carregarComparativo();
}
async function carregarComparativo() {
  const lbl = document.getElementById('c360-compare-label');
  const body = document.getElementById('c360-compare-body');
  if (!body) return;
  body.innerHTML = `<div class="c360-loading">Carregando comparativo…</div>`;
  const fechA = S.entregas.find(e => e.id === S.compare.a);
  const fechB = S.entregas.find(e => e.id === S.compare.b);
  if (!fechA?.token_publico || !fechB?.token_publico) {
    body.innerHTML = `<div class="c360-empty" style="padding:24px;"><p>Fechamentos sem token público.<br>Publique-os primeiro.</p></div>`;
    return;
  }
  const [dataA, dataB] = await Promise.all([apiPublic(fechA.token_publico), apiPublic(fechB.token_publico)]);
  S.compareData.a = dataA?.entrega || dataA;
  S.compareData.b = dataB?.entrega || dataB;
  if (lbl) lbl.textContent = `${fechA.periodo || fechA.titulo || 'A'} vs ${fechB.periodo || fechB.titulo || 'B'}`;
  renderComparativoFechs(body, fechA, fechB, S.compareData.a, S.compareData.b);
}
function renderComparativoFechs(elx, fechA, fechB, dataA, dataB) {
  const cardsA = dataA?.payload_json?.cards || dataA?.cards || [];
  const cardsB = dataB?.payload_json?.cards || dataB?.cards || [];
  const mapA = Object.fromEntries(cardsA.map(c => [c.titulo || c.title, c]));
  const mapB = Object.fromEntries(cardsB.map(c => [c.titulo || c.title, c]));
  const titles = [...new Set([...Object.keys(mapA), ...Object.keys(mapB)])];
  if (!titles.length) {
    elx.innerHTML = `<div class="c360-empty" style="padding:24px;"><p>Dados detalhados não disponíveis.<br>Os fechamentos precisam estar publicados.</p></div>`;
    return;
  }
  const fmtVal = c => !c ? '—' : (c.valor ? esc(c.valor) : c.raw !== undefined ? fmtBRL(c.raw) : '—');
  const rows = titles.map(t => {
    const a = mapA[t], b = mapB[t];
    const va = a?.raw ?? a?.valor ?? null, vb = b?.raw ?? b?.valor ?? null;
    let dl = '—';
    if (va !== null && vb !== null) {
      const d = Number(va) - Number(vb);
      const pct = vb !== 0 ? (d / Math.abs(vb) * 100).toFixed(1) : '—';
      const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
      dl = `<span class="c360-delta-${cls}">${d > 0 ? '+' : ''}${pct}%</span>`;
    }
    return `<div class="c360-compare-row${a?.destaque ? ' highlight' : ''}"><div>${esc(t)}</div><div><strong>${fmtVal(a)}</strong></div><div>${fmtVal(b)}</div><div>${dl}</div></div>`;
  });
  elx.innerHTML = `
    <div class="c360-compare-header">
      <div>Métrica</div><div>${esc(fechA.periodo || fechA.titulo || 'A')}</div>
      <div>${esc(fechB.periodo || fechB.titulo || 'B')}</div><div>Δ</div>
    </div>${rows.join('')}`;
}
async function removerFechamento(id) {
  if (!confirm('Remover este fechamento? Essa ação não pode ser desfeita.')) return;
  const ok = await apiDelete('/entregas-cliente/' + id);
  if (ok) {
    S.entregas = S.entregas.filter(e => e.id !== id);
    if (S.compare.a === id) { S.compare.a = null; S.compareData.a = null; }
    if (S.compare.b === id) { S.compare.b = null; S.compareData.b = null; }
    S.resumoMes = consolidarResumoMes();
    renderCockpit(); updateTabCounts();
    renderTab360('fechamentos');
  } else { alert('Não foi possível remover. Tente novamente.'); }
}

/* ── ABA: HISTÓRICO ──────────────────────────────────────── */
function renderHistorico(el) {
  const TIPO = { fechamento_mensal: 'Fechamento mensal', relatorio: 'Relatório', diagnostico: 'Diagnóstico' };
  const eventos = [...S.entregas]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map(e => ({
      title: e.titulo || TIPO[e.tipo] || e.tipo || '—',
      sub: `${e.tipo} · período: ${e.periodo || '—'}`,
      date: e.created_at,
      type: e.tipo === 'fechamento_mensal' ? 'ok' : 'brand',
      link: e.token_publico ? `<a href="/relatorio-publico.html?token=${esc(e.token_publico)}" target="_blank" class="c360-btn-link">Ver →</a>` : '',
    }));
  if (!eventos.length) {
    el.innerHTML = panelEmpty('Histórico operacional', '📅', 'Sem histórico', 'As ações do cliente aparecerão aqui.');
    return;
  }
  el.innerHTML = `
    <div class="c360-panel">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Histórico operacional</h2>
        <span class="c360-panel-meta">${eventos.length} evento(s)</span>
      </div>
      <div class="c360-panel-body">
        <div class="c360-timeline">
          ${eventos.map(ev => `
            <div class="c360-event">
              <div class="c360-event-dot ${ev.type}"></div>
              <div>
                <div class="c360-event-title">${esc(ev.title)}</div>
                <div class="c360-event-sub">${esc(ev.sub)}</div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span class="c360-event-date">${fmtDt(ev.date)}</span>${ev.link}
              </div>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
}

/* ── HELPER: painel vazio ────────────────────────────────── */
function panelEmpty(title, icon, head, body) {
  return `
    <div class="c360-panel">
      <div class="c360-panel-head"><h2 class="c360-panel-title">${title}</h2></div>
      <div class="c360-empty">
        <div class="c360-empty-icon">${icon}</div>
        <b>${head}</b><p>${body}</p>
      </div>
    </div>`;
}

/* ── ATALHOS (chave compartilhada com cliente-operacao) ──── */
const ATALHOS_KEY = 'vfop-atalhos-clientes';
function salvarAtalho360(slug, nome) {
  let lista = []; try { lista = JSON.parse(localStorage.getItem(ATALHOS_KEY) || '[]'); } catch {}
  if (!lista.find(a => a.slug === slug)) {
    lista.push({ slug, nome });
    if (lista.length > 5) lista.shift();
    localStorage.setItem(ATALHOS_KEY, JSON.stringify(lista));
  }
  renderAtalhos360();
}
function renderAtalhos360() {
  const wrap = document.getElementById('c360-quick-chips');
  if (!wrap) return;
  let lista = []; try { lista = JSON.parse(localStorage.getItem(ATALHOS_KEY) || '[]'); } catch {}
  if (!lista.length) { wrap.innerHTML = ''; return; }
  const slug = S.cliente?.slug || '';
  wrap.innerHTML = lista.map(a => {
    const initials = (a.nome || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    return `
      <div class="vfop-quick-chip-v2${a.slug === slug ? ' vfop-quick-chip-v2--active' : ''}" onclick="selecionarCliente360('${esc(a.slug)}')">
        <div class="vfop-quick-chip-v2-ic">${initials}</div>
        <span>${esc(a.nome)}</span>
        <span style="opacity:.4;font-size:10px;margin-left:2px;" onclick="event.stopPropagation();removerAtalho360('${esc(a.slug)}')">×</span>
      </div>`;
  }).join('');
}
function selecionarCliente360(slug) {
  const sel = document.getElementById('c360-client-select');
  if (sel) { sel.value = slug; sel.dispatchEvent(new Event('change')); }
}
function removerAtalho360(slug) {
  let lista = []; try { lista = JSON.parse(localStorage.getItem(ATALHOS_KEY) || '[]'); } catch {}
  lista = lista.filter(a => a.slug !== slug);
  localStorage.setItem(ATALHOS_KEY, JSON.stringify(lista));
  renderAtalhos360();
}
function copiarLink360(slug) {
  const url = API_BASE + '/ml/conectar/' + slug;
  navigator.clipboard.writeText(url).then(() => {
    document.querySelectorAll('[onclick*="copiarLink360"]').forEach(btn => {
      const orig = btn.textContent;
      btn.textContent = 'Copiado!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    });
  });
}

/* ── UTIL ────────────────────────────────────────────────── */
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

/* ── BOOT ────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init360);
