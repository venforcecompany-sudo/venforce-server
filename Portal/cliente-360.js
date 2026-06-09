/* ================================================================
   cliente-360.js — VenForce
   Memória operacional por cliente: bases, diagnóstico, métricas,
   ads, fechamentos e histórico unificado.
   ================================================================ */

const API_BASE = "https://venforce-server.onrender.com";
const TOKEN    = localStorage.getItem("vf-token") || "";
const esc      = s => String(s||"").replace(/[&<>"']/g,
  c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt      = (n, d=0) => (Number(n)||0).toLocaleString('pt-BR',
  {minimumFractionDigits:d,maximumFractionDigits:d});
const fmtBRL   = n => 'R$ ' + fmt(n,2);
const fmtPct   = n => fmt(n,2) + '%';

/* ── STATE ──────────────────────────────────────────────── */
const S = {
  clientes:   [],
  cliente:    null,
  entregas:   [],
  relatorios: [],
  bases:      [],
  tokens:     [],
  ads:        null,
  adsMensal:  [],
  metricas:   null,
  activeTab:  'overview',
  compare:    { a: null, b: null },
  compareData:{ a: null, b: null },
};

/* ── API HELPERS ─────────────────────────────────────────── */
async function api(path) {
  try {
    const r = await fetch(API_BASE + path, {
      headers: { Authorization: 'Bearer ' + TOKEN }
    });
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
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + TOKEN }
    });
    return r.ok;
  } catch { return false; }
}

/* ── INIT ────────────────────────────────────────────────── */
async function init360() {
  const data = await api('/clientes');
  S.clientes = data?.clientes || data || [];
  if (!Array.isArray(S.clientes)) S.clientes = [];

  const sel = document.getElementById('c360-client-select');
  if (sel) {
    sel.innerHTML = '<option value="">Selecione o cliente...</option>' +
      S.clientes
        .filter(c => c?.ativo !== false)
        .sort((a,b) => (a.nome||'').localeCompare(b.nome||''))
        .map(c => `<option value="${c.slug}">${esc(c.nome)}</option>`)
        .join('');

    sel.addEventListener('change', () => {
      const slug = sel.value;
      if (!slug) return;
      S.cliente = S.clientes.find(c => c.slug === slug) || null;
      loadCliente360();
    });
  }

  // Restaurar atalhos
  renderAtalhos360();

  // Carregar cliente inicial
  const saved = localStorage.getItem('c360-last-slug')
    || localStorage.getItem('vfop-last-slug');
  if (saved && S.clientes.find(c => c.slug === saved)) {
    if (sel) sel.value = saved;
    S.cliente = S.clientes.find(c => c.slug === saved) || null;
    if (S.cliente) loadCliente360();
  }

  // Tabs
  document.querySelectorAll('.c360-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      switchTab(tab);
    });
  });
}

/* ── LOAD DADOS DO CLIENTE ───────────────────────────────── */
async function loadCliente360() {
  const slug = S.cliente?.slug;
  if (!slug) return;

  document.getElementById('c360-loading').style.display  = 'flex';
  document.getElementById('c360-content').style.display  = 'none';

  localStorage.setItem('c360-last-slug', slug);

  // Data range — últimos 30 dias
  const now  = new Date();
  const from = new Date(now); from.setDate(from.getDate() - 30);
  const dateFrom = from.toISOString().slice(0,10);
  const dateTo   = now.toISOString().slice(0,10);

  const [entregasRes, basesRes, tokensRes, relRes, adsRes, adsMensalRes, metRes] =
    await Promise.all([
      api(`/entregas-cliente?cliente_slug=${encodeURIComponent(slug)}`),
      api('/base-vinculos'),
      api('/admin/ml-tokens'),
      api('/automacoes/relatorios'),
      api('/ads/acompanhamento'),
      api('/ads/resumo-mensal'),
      api(`/metricas/resumo?clienteSlug=${encodeURIComponent(slug)}&dateFrom=${dateFrom}&dateTo=${dateTo}`),
    ]);

  // Entregas filtradas para esse cliente
  const allEntregas = entregasRes?.entregas || [];
  S.entregas = allEntregas.filter(e =>
    e?.cliente_slug === slug || String(e?.cliente_id) === String(S.cliente?.id)
  );

  // Bases vinculadas a esse cliente
  const allBases = basesRes?.bases || basesRes?.vinculos || basesRes || [];
  S.bases = (Array.isArray(allBases) ? allBases : []).filter(b =>
    b?.vinculo?.cliente_slug === slug ||
    b?.vinculo?.cliente_id   === S.cliente?.id
  );

  // Tokens ML
  S.tokens  = tokensRes?.tokens || tokensRes || [];
  const temGrant = S.tokens.some(t =>
    t?.cliente_slug === slug || t?.cliente_id === S.cliente?.id
  );

  // Relatórios (todos — filtrar por slug depois)
  const allRel = relRes?.relatorios || relRes || [];
  S.relatorios = (Array.isArray(allRel) ? allRel : []).filter(r =>
    r?.cliente_slug === slug ||
    r?.clienteSlug  === slug ||
    r?.cliente_nome?.toLowerCase().includes((S.cliente?.nome||'').toLowerCase().split(' ')[0])
  );

  // Ads
  const allAds = adsRes?.acompanhamentos || adsRes?.data || adsRes || [];
  S.ads = (Array.isArray(allAds) ? allAds : []).filter(a =>
    a?.cliente_slug === slug || a?.clienteSlug === slug
  );

  const allMensal = adsMensalRes?.resumos || adsMensalRes || [];
  S.adsMensal = (Array.isArray(allMensal) ? allMensal : []).filter(a =>
    a?.cliente_slug === slug || a?.clienteSlug === slug
  );

  // Métricas
  S.metricas = metRes?.ok ? metRes : null;

  // Header
  renderHeader360(temGrant);

  // KPIs
  renderKPIs360();

  // Tabs counts
  updateTabCounts();

  // Render aba ativa
  renderTab360(S.activeTab);

  document.getElementById('c360-loading').style.display  = 'none';
  document.getElementById('c360-content').style.display  = 'block';
}

/* ── HEADER ──────────────────────────────────────────────── */
function renderHeader360(temGrant) {
  const c = S.cliente;
  if (!c) return;

  const titleEl = document.getElementById('c360-page-title');
  if (titleEl) titleEl.textContent = c.nome || '—';

  const metaEl = document.getElementById('c360-meta');
  if (metaEl) {
    metaEl.innerHTML = `
      <span>${esc(c.slug)}</span>
      <span class="vfop-meta-sep"></span>
      <span>Canal principal: Mercado Livre</span>`;
  }

  const actEl = document.getElementById('c360-head-actions');
  if (actEl) {
    actEl.innerHTML = `
      <a href="cliente-operacao.html"
         class="vfop-action vfop-action--ghost"
         style="font-size:12px;">
        ← Setup
      </a>
      ${!temGrant ? `
        <button class="vfop-action"
                style="font-size:12px;"
                onclick="copiarLink360('${c.slug}')">
          Copiar link ML
        </button>` : ''}
      <button class="vfop-action"
              style="font-size:12px;"
              onclick="salvarAtalho360('${c.slug}','${(c.nome||'').replace(/'/g,'')}')">
        ☆ Atalho
      </button>
      <a href="financeiro.html"
         class="vfop-action vfop-action--primary"
         style="font-size:12px;">
        + Novo fechamento
      </a>`;
  }

  // Chip do switcher
  const chipEl = document.getElementById('c360-switcher-chip');
  if (chipEl) {
    const initials = (c.nome||'?').split(/\s+/).slice(0,2)
      .map(w=>w[0]).join('').toUpperCase();
    const pct = (S.entregas.length > 0) ? 'tem dados' : 'sem dados';
    chipEl.innerHTML = `
      <div class="vfop-switch-chip">
        <div class="vfop-switch-chip-ic">${initials}</div>
        <div class="vfop-switch-chip-body">
          <div class="vfop-switch-chip-name">${esc(c.nome)}</div>
          <div class="vfop-switch-chip-meta">360 · ${pct}</div>
        </div>
        <span class="vfop-switch-chip-chev">▾</span>
      </div>`;
  }
}

/* ── KPIs ────────────────────────────────────────────────── */
function renderKPIs360() {
  const mc   = S.metricas?.resumo?.mcMedia
    || S.metricas?.resumo?.mc_media || 0;
  const fat  = S.metricas?.resumo?.vendasBrutas || 0;
  const fech = S.entregas.filter(e => e.tipo === 'fechamento_mensal').length;
  const rels = S.relatorios.length;
  const ads30 = S.adsMensal.slice(-1)[0]?.investimento
    || S.ads.slice(-1)[0]?.ads_valor || 0;
  const crit = S.relatorios.length > 0
    ? (S.relatorios[0]?.sem_custo || S.relatorios[0]?.semCusto || '—')
    : '—';

  setText('kpi-mc',  mc  ? fmtPct(mc) : '—');
  setText('kpi-fat', fat ? fmtBRL(fat) : '—');
  setText('kpi-fech', fech || '0');
  setText('kpi-rel',  rels || '0');
  setText('kpi-ads',  ads30 ? fmtBRL(ads30) : '—');
  setText('kpi-crit', crit);

  if (mc > 0) {
    const el = document.getElementById('kpi-mc');
    if (el) el.className = 'c360-kpi-value ' +
      (mc >= 15 ? 'ok' : mc >= 8 ? 'warn' : 'crit');
  }
}

/* ── TABS ────────────────────────────────────────────────── */
function switchTab(tab) {
  S.activeTab = tab;
  document.querySelectorAll('.c360-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.c360-tab-panel').forEach(p => {
    p.style.display = 'none';
  });
  const panel = document.getElementById('tab-' + tab);
  if (panel) panel.style.display = 'block';
  renderTab360(tab);
}

function updateTabCounts() {
  const map = {
    bases:      S.bases.length,
    diagnostico: S.relatorios.length,
    fechamentos: S.entregas.filter(e=>e.tipo==='fechamento_mensal').length,
    historico:   S.entregas.length,
  };
  document.querySelectorAll('.c360-tab').forEach(btn => {
    const n = map[btn.dataset.tab];
    let span = btn.querySelector('.c360-tab-count');
    if (n > 0) {
      if (!span) {
        span = document.createElement('span');
        span.className = 'c360-tab-count';
        btn.appendChild(span);
      }
      span.textContent = n;
    }
  });
}

function renderTab360(tab) {
  const panel = document.getElementById('tab-' + tab);
  if (!panel) return;
  switch(tab) {
    case 'overview':    renderOverview(panel);    break;
    case 'bases':       renderBases360(panel);    break;
    case 'diagnostico': renderDiag(panel);        break;
    case 'metricas':    renderMetricas360(panel); break;
    case 'ads':         renderAds360(panel);      break;
    case 'fechamentos': renderFechamentos(panel); break;
    case 'historico':   renderHistorico(panel);   break;
  }
}

/* ── ABA: VISÃO GERAL ────────────────────────────────────── */
function renderOverview(el) {
  const c      = S.cliente;
  const fechs  = S.entregas.filter(e => e.tipo === 'fechamento_mensal');
  const rels   = S.relatorios;
  const temBase  = S.bases.length > 0;
  const temGrant = S.tokens.some(t =>
    t?.cliente_slug === c?.slug || t?.cliente_id === c?.id
  );

  // Saúde por canal (baseado nos dados disponíveis)
  const saude = temBase && temGrant && rels.length > 0 ? 'ok'
    : temBase || temGrant ? 'warn' : 'crit';

  const saudeLabel = saude === 'ok' ? 'operável'
    : saude === 'warn' ? 'atenção' : 'crítico';

  const saudeBadge = saude === 'ok'
    ? `<span class="vfop-badge vfop-badge-ok">● ${saudeLabel}</span>`
    : saude === 'warn'
    ? `<span class="vfop-badge vfop-badge-warn">● ${saudeLabel}</span>`
    : `<span class="vfop-badge vfop-badge-crit">● ${saudeLabel}</span>`;

  const ultimoFech = fechs.sort((a,b) =>
    new Date(b.created_at) - new Date(a.created_at))[0];
  const ultimoRel  = rels.sort((a,b) =>
    new Date(b.updated_at||b.created_at) -
    new Date(a.updated_at||a.created_at))[0];

  const mc = S.metricas?.resumo?.mcMedia
    || S.metricas?.resumo?.mc_media;

  el.innerHTML = `
    <div class="c360-grid2" style="margin-bottom:14px;">
      <div class="c360-panel">
        <div class="c360-panel-head">
          <h2 class="c360-panel-title">Saúde operacional</h2>
          ${saudeBadge}
        </div>
        <div class="c360-panel-body">
          <div class="c360-health-head c360-health-row" style="border-radius:6px 6px 0 0;overflow:hidden;">
            <div>Canal</div><div>Base</div><div>Grant</div>
            <div>Diagnóstico</div><div>Fechamento</div><div>Risco</div>
          </div>
          <div class="c360-health-row" style="border-radius:0 0 6px 6px;overflow:hidden;">
            <div style="font-weight:600;">ML · Principal</div>
            <div>${temBase
              ? `<span class="vfop-badge vfop-badge-ok">${esc(S.bases[0]?.nome||'vinculada')}</span>`
              : `<span class="vfop-badge vfop-badge-warn">pendente</span>`}</div>
            <div>${temGrant
              ? `<span class="vfop-badge vfop-badge-ok">grantado</span>`
              : `<span class="vfop-badge vfop-badge-crit">precisa grant</span>`}</div>
            <div>${rels.length > 0
              ? `<span class="vfop-badge vfop-badge-ok">feito</span>`
              : `<span class="vfop-badge vfop-badge-neutral">pendente</span>`}</div>
            <div>${fechs.length > 0
              ? `<span class="vfop-badge vfop-badge-ok">${fechs.length} saved</span>`
              : `<span class="vfop-badge vfop-badge-neutral">pendente</span>`}</div>
            <div><span class="vfop-badge vfop-badge-${saude === 'ok' ? 'ok' : saude === 'warn' ? 'warn' : 'crit'}">${saudeLabel}</span></div>
          </div>
        </div>
      </div>

      <div class="c360-panel">
        <div class="c360-panel-head">
          <h2 class="c360-panel-title">Últimas ações</h2>
        </div>
        <div class="c360-panel-body" style="padding:14px 18px;">
          <div class="c360-timeline">
            ${[
              ultimoFech ? {
                title: 'Fechamento processado',
                sub: 'Período: ' + (ultimoFech.periodo||'—'),
                date: ultimoFech.created_at,
                type: 'ok'
              } : null,
              ultimoRel ? {
                title: 'Diagnóstico rodado',
                sub: ultimoRel.nome || ultimoRel.slug || '—',
                date: ultimoRel.updated_at || ultimoRel.created_at,
                type: 'brand'
              } : null,
            ].filter(Boolean).map(ev => `
              <div class="c360-event">
                <div class="c360-event-dot ${ev.type}"></div>
                <div>
                  <div class="c360-event-title">${esc(ev.title)}</div>
                  <div class="c360-event-sub">${esc(ev.sub)}</div>
                </div>
                <div style="font-size:11px;color:var(--vfop-soft);">
                  ${ev.date
                    ? new Date(ev.date).toLocaleDateString('pt-BR')
                    : '—'}
                </div>
              </div>`).join('')}
            ${(!ultimoFech && !ultimoRel)
              ? `<div class="c360-empty"><p>Nenhuma ação registrada ainda.</p></div>`
              : ''}
          </div>
        </div>
      </div>
    </div>

    ${mc ? `
    <div class="c360-panel">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Métricas 30 dias</h2>
        <span class="c360-panel-meta">Mercado Livre</span>
      </div>
      <div class="c360-panel-body">
        <div class="c360-grid3">
          <div style="text-align:center;padding:14px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;
                        color:var(--vfop-soft);font-weight:700;margin-bottom:8px;">
              MC Média
            </div>
            <div style="font-size:32px;font-weight:700;letter-spacing:-.02em;
                        color:${mc>=15?'#1a7a45':mc>=8?'#855100':'#9b1c1c'};">
              ${fmtPct(mc)}
            </div>
          </div>
          <div style="text-align:center;padding:14px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;
                        color:var(--vfop-soft);font-weight:700;margin-bottom:8px;">
              Faturamento
            </div>
            <div style="font-size:28px;font-weight:700;letter-spacing:-.02em;
                        color:var(--vfop-text);">
              ${fmtBRL(S.metricas?.resumo?.vendasBrutas||0)}
            </div>
          </div>
          <div style="text-align:center;padding:14px;">
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;
                        color:var(--vfop-soft);font-weight:700;margin-bottom:8px;">
              Pedidos
            </div>
            <div style="font-size:28px;font-weight:700;letter-spacing:-.02em;
                        color:var(--vfop-text);">
              ${fmt(S.metricas?.resumo?.quantidadeVendas||0)}
            </div>
          </div>
        </div>
      </div>
    </div>` : ''}`;
}

/* ── ABA: BASES ──────────────────────────────────────────── */
function renderBases360(el) {
  if (!S.bases.length) {
    el.innerHTML = `
      <div class="c360-panel">
        <div class="c360-panel-head">
          <h2 class="c360-panel-title">Bases vinculadas</h2>
        </div>
        <div class="c360-empty" style="padding:32px;">
          <div class="c360-empty-icon">📦</div>
          <b>Nenhuma base vinculada</b>
          <p>Vincule uma base em <a href="bases.html">Bases de Custo</a>.</p>
        </div>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="c360-panel">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Bases vinculadas</h2>
        <span class="c360-panel-meta">${S.bases.length} base(s)</span>
      </div>
      <div class="c360-panel-body" style="padding:0;">
        <table class="c360-table">
          <thead>
            <tr>
              <th>Base</th><th>Marketplace</th><th>Origem</th>
              <th>Atualizado</th><th>Ações</th>
            </tr>
          </thead>
          <tbody>
            ${S.bases.map(b => `
              <tr>
                <td class="strong">${esc(b.nome||b.slug||'—')}</td>
                <td>${esc(b.vinculo?.marketplace||'—')}</td>
                <td><span class="vfop-badge vfop-badge-ok">
                  ${esc(b.vinculo?.origem||'manual')}
                </span></td>
                <td class="muted">${b.updated_at
                  ? new Date(b.updated_at).toLocaleDateString('pt-BR')
                  : '—'}</td>
                <td>
                  <a href="bases.html"
                     class="vfop-action--ghost-arrow"
                     style="font-size:11.5px;">
                    Ver bases →
                  </a>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

/* ── ABA: DIAGNÓSTICO ────────────────────────────────────── */
function renderDiag(el) {
  if (!S.relatorios.length) {
    el.innerHTML = `
      <div class="c360-panel">
        <div class="c360-panel-head">
          <h2 class="c360-panel-title">Diagnósticos</h2>
        </div>
        <div class="c360-empty" style="padding:32px;">
          <div class="c360-empty-icon">🔍</div>
          <b>Nenhum diagnóstico encontrado</b>
          <p>Rode um diagnóstico em
            <a href="automacoes.html">Automações</a>.
          </p>
        </div>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="c360-panel">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Diagnósticos</h2>
        <span class="c360-panel-meta">${S.relatorios.length} relatório(s)</span>
      </div>
      <div class="c360-panel-body" style="padding:0;">
        <table class="c360-table">
          <thead>
            <tr>
              <th>Relatório</th><th>Sem custo</th>
              <th>Data</th><th>Ações</th>
            </tr>
          </thead>
          <tbody>
            ${S.relatorios.map(r => `
              <tr>
                <td class="strong">${esc(r.nome||r.slug||r.id||'—')}</td>
                <td>${r.sem_custo||r.semCusto
                  ? `<span class="vfop-badge vfop-badge-warn">
                       ${r.sem_custo||r.semCusto} itens
                     </span>`
                  : `<span class="vfop-badge vfop-badge-ok">ok</span>`
                }</td>
                <td class="muted">${r.updated_at||r.created_at
                  ? new Date(r.updated_at||r.created_at)
                      .toLocaleDateString('pt-BR')
                  : '—'}</td>
                <td>
                  <a href="relatorios.html"
                     class="vfop-action--ghost-arrow"
                     style="font-size:11.5px;">
                    Ver →
                  </a>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

/* ── ABA: MÉTRICAS ML ────────────────────────────────────── */
function renderMetricas360(el) {
  const m = S.metricas;
  if (!m) {
    el.innerHTML = `
      <div class="c360-panel">
        <div class="c360-panel-head">
          <h2 class="c360-panel-title">Métricas Mercado Livre</h2>
        </div>
        <div class="c360-empty" style="padding:32px;">
          <div class="c360-empty-icon">📊</div>
          <b>Dados não disponíveis</b>
          <p>Verifique se o grant ML está conectado.</p>
        </div>
      </div>`;
    return;
  }

  const r = m.resumo || {};
  const rows = [
    ['Vendas brutas',      fmtBRL(r.vendasBrutas||0)],
    ['Quantidade vendas',  fmt(r.quantidadeVendas||0)],
    ['Unidades vendidas',  fmt(r.unidadesVendidas||0)],
    ['Ticket médio',       fmtBRL(r.ticketMedio||0)],
    ['Preço médio/unid.',  fmtBRL(r.precoMedioUnidade||0)],
    ['Cancelamentos',      fmt(r.quantidadeCancelada||0)],
    ['Valor cancelado',    fmtBRL(r.valorCancelado||0)],
    ['MC Média',           fmtPct(r.mcMedia||r.mc_media||0)],
  ];

  // Salvar snapshot de métricas
  const snapKey = `c360-snaps-${S.cliente?.slug}`;
  let snaps = [];
  try { snaps = JSON.parse(localStorage.getItem(snapKey)||'[]'); } catch{}

  el.innerHTML = `
    <div class="c360-grid2">
      <div class="c360-panel">
        <div class="c360-panel-head">
          <h2 class="c360-panel-title">Resumo 30 dias</h2>
          <span class="c360-panel-meta">Mercado Livre</span>
        </div>
        <div class="c360-panel-body" style="padding:0;">
          <table class="c360-table">
            ${rows.map(([k,v]) => `
              <tr>
                <td class="muted">${k}</td>
                <td class="strong" style="text-align:right;">${v}</td>
              </tr>`).join('')}
          </table>
        </div>
        <div class="c360-panel-foot">
          <span>Período: últimos 30 dias</span>
          <button class="vfop-action"
                  style="font-size:12px;"
                  onclick="salvarSnapshot()">
            Salvar snapshot
          </button>
        </div>
      </div>

      <div class="c360-panel" id="c360-snaps-panel">
        <div class="c360-panel-head">
          <h2 class="c360-panel-title">Snapshots salvos</h2>
          <span class="c360-panel-meta">${snaps.length} salvo(s)</span>
        </div>
        <div id="c360-snaps-list">
          ${renderSnapsList(snaps)}
        </div>
      </div>
    </div>

    <div class="c360-panel" id="c360-snaps-compare">
      ${renderSnapsCompare(snaps)}
    </div>`;
}

function salvarSnapshot() {
  const m = S.metricas;
  if (!m || !S.cliente?.slug) return;
  const snapKey = `c360-snaps-${S.cliente.slug}`;
  let snaps = [];
  try { snaps = JSON.parse(localStorage.getItem(snapKey)||'[]'); } catch{}

  const r = m.resumo || {};
  snaps.unshift({
    id: Date.now(),
    data: new Date().toLocaleDateString('pt-BR'),
    vendasBrutas: r.vendasBrutas||0,
    quantidadeVendas: r.quantidadeVendas||0,
    ticketMedio: r.ticketMedio||0,
    mc: r.mcMedia||r.mc_media||0,
    valorCancelado: r.valorCancelado||0,
  });
  if (snaps.length > 12) snaps = snaps.slice(0,12);
  localStorage.setItem(snapKey, JSON.stringify(snaps));

  const listEl = document.getElementById('c360-snaps-list');
  if (listEl) listEl.innerHTML = renderSnapsList(snaps);
  const cmpEl  = document.getElementById('c360-snaps-compare');
  if (cmpEl)  cmpEl.innerHTML  = renderSnapsCompare(snaps);

  const btn = document.querySelector('[onclick="salvarSnapshot()"]');
  if (btn) {
    btn.textContent = 'Salvo!';
    setTimeout(() => { btn.textContent = 'Salvar snapshot'; }, 1500);
  }
}

function renderSnapsList(snaps) {
  if (!snaps.length) return `
    <div class="c360-empty" style="padding:24px;">
      <p>Nenhum snapshot salvo ainda.<br>Clique em "Salvar snapshot" para guardar.</p>
    </div>`;
  return `<table class="c360-table">
    <thead><tr>
      <th>Data</th><th>Faturamento</th>
      <th>Pedidos</th><th>MC%</th><th></th>
    </tr></thead>
    <tbody>
      ${snaps.map((s,i) => `
        <tr>
          <td class="muted mono">${s.data}</td>
          <td class="strong">${fmtBRL(s.vendasBrutas)}</td>
          <td>${fmt(s.quantidadeVendas)}</td>
          <td><span class="vfop-badge vfop-badge-${s.mc>=15?'ok':s.mc>=8?'warn':'crit'}">
            ${fmtPct(s.mc)}
          </span></td>
          <td>
            <button class="vfop-action--ghost-arrow"
                    style="font-size:11px;color:var(--vfop-err,#9b1c1c);"
                    onclick="removerSnapshot(${i})">
              ×
            </button>
          </td>
        </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderSnapsCompare(snaps) {
  if (snaps.length < 2) return `
    <div class="c360-panel-head">
      <h2 class="c360-panel-title">Comparativo de snapshots</h2>
    </div>
    <div class="c360-empty" style="padding:24px;">
      <p>Salve pelo menos 2 snapshots para comparar.</p>
    </div>`;

  const a = snaps[0];
  const b = snaps[1];

  const delta = (va, vb, pct=false) => {
    const d = va - vb;
    const sign = d > 0 ? '+' : '';
    const cls  = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
    const val  = pct ? sign+fmtPct(Math.abs(d)) : sign+fmtBRL(Math.abs(d));
    return `<span class="c360-delta-${cls}">${d>=0?'+':'-'}${pct?fmtPct(Math.abs(d)):fmtBRL(Math.abs(d))}</span>`;
  };

  const rows = [
    ['Faturamento',  fmtBRL(a.vendasBrutas), fmtBRL(b.vendasBrutas),
      delta(a.vendasBrutas, b.vendasBrutas), true],
    ['Pedidos',      fmt(a.quantidadeVendas), fmt(b.quantidadeVendas),
      delta(a.quantidadeVendas, b.quantidadeVendas), true],
    ['Ticket médio', fmtBRL(a.ticketMedio),  fmtBRL(b.ticketMedio),
      delta(a.ticketMedio, b.ticketMedio), true],
    ['MC Média',     fmtPct(a.mc), fmtPct(b.mc),
      delta(a.mc, b.mc, true), true],
    ['Cancelado',    fmtBRL(a.valorCancelado), fmtBRL(b.valorCancelado),
      delta(a.valorCancelado, b.valorCancelado), true],
  ];

  return `
    <div class="c360-panel-head">
      <h2 class="c360-panel-title">Comparativo de snapshots</h2>
      <span class="c360-panel-meta">${a.data} vs ${b.data}</span>
    </div>
    <div class="c360-panel-body" style="padding:0;">
      <div class="c360-compare-header">
        <div>Métrica</div>
        <div>${a.data} (recente)</div>
        <div>${b.data} (anterior)</div>
        <div>Δ variação</div>
      </div>
      ${rows.map(([label,va,vb,dlt]) => `
        <div class="c360-compare-row">
          <div>${label}</div>
          <div style="font-weight:600;">${va}</div>
          <div>${vb}</div>
          <div>${dlt}</div>
        </div>`).join('')}
    </div>`;
}

function removerSnapshot(idx) {
  const snapKey = `c360-snaps-${S.cliente?.slug}`;
  let snaps = [];
  try { snaps = JSON.parse(localStorage.getItem(snapKey)||'[]'); } catch{}
  snaps.splice(idx, 1);
  localStorage.setItem(snapKey, JSON.stringify(snaps));
  const listEl = document.getElementById('c360-snaps-list');
  if (listEl) listEl.innerHTML = renderSnapsList(snaps);
  const cmpEl  = document.getElementById('c360-snaps-compare');
  if (cmpEl)  cmpEl.innerHTML  = renderSnapsCompare(snaps);
}

/* ── ABA: ADS ────────────────────────────────────────────── */
function renderAds360(el) {
  if (!S.ads.length && !S.adsMensal.length) {
    el.innerHTML = `
      <div class="c360-panel">
        <div class="c360-panel-head">
          <h2 class="c360-panel-title">Ads</h2>
        </div>
        <div class="c360-empty" style="padding:32px;">
          <div class="c360-empty-icon">📢</div>
          <b>Sem dados de Ads</b>
          <p>Salve acompanhamento em <a href="ads.html">Ads</a>.</p>
        </div>
      </div>`;
    return;
  }

  const mensal = [...S.adsMensal].sort((a,b) =>
    (b.mes||'').localeCompare(a.mes||''));

  el.innerHTML = `
    <div class="c360-panel">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Resumo mensal de Ads</h2>
        <a href="ads.html" class="vfop-action--ghost-arrow"
           style="font-size:12px;">
          Gerenciar →
        </a>
      </div>
      <div class="c360-panel-body" style="padding:0;">
        ${mensal.length ? `
          <table class="c360-table">
            <thead><tr>
              <th>Mês</th><th>Investimento</th>
              <th>TACoS</th><th>ROAS</th>
            </tr></thead>
            <tbody>
              ${mensal.slice(0,12).map(m => `
                <tr>
                  <td class="muted">${m.mes||'—'}</td>
                  <td class="strong">${fmtBRL(m.investimento||0)}</td>
                  <td>${m.tacos ? fmtPct(m.tacos) : '—'}</td>
                  <td>${m.roas  ? fmt(m.roas,1)+'x' : '—'}</td>
                </tr>`).join('')}
            </tbody>
          </table>` : `
          <div class="c360-empty" style="padding:20px;">
            <p>Sem resumo mensal salvo.</p>
          </div>`}
      </div>
    </div>`;
}

/* ── ABA: FECHAMENTOS ────────────────────────────────────── */
function renderFechamentos(el) {
  const fechs = S.entregas
    .filter(e => e.tipo === 'fechamento_mensal')
    .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

  el.innerHTML = `
    <div class="c360-panel" style="margin-bottom:14px;">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Fechamentos</h2>
        <div style="display:flex;gap:6px;align-items:center;">
          <span class="c360-panel-meta">${fechs.length} salvos</span>
          <a href="financeiro.html"
             class="vfop-action vfop-action--primary"
             style="font-size:12px;">
            + Novo fechamento
          </a>
        </div>
      </div>
      <div class="c360-panel-body" style="padding:14px;">
        <p style="font-size:12px;color:var(--vfop-soft);margin:0 0 12px;">
          Selecione dois fechamentos para comparar lado a lado.
        </p>
        <div id="c360-fech-list">
          ${fechs.length
            ? fechs.map(f => renderFechCard(f)).join('')
            : `<div class="c360-empty">
                 <div class="c360-empty-icon">📋</div>
                 <b>Nenhum fechamento</b>
                 <p>Processe um fechamento para visualizar aqui.</p>
               </div>`}
        </div>
      </div>
    </div>

    <div class="c360-panel c360-compare-wrap" id="c360-fech-compare">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Comparativo</h2>
        <span class="c360-panel-meta" id="c360-compare-label">
          Selecione 2 fechamentos
        </span>
      </div>
      <div id="c360-compare-body" class="c360-panel-body">
        <div class="c360-empty">
          <p>Selecione dois fechamentos acima.</p>
        </div>
      </div>
    </div>`;

  // Tornar o painel de comparação sempre visível
  const wrap = document.getElementById('c360-fech-compare');
  if (wrap) wrap.classList.add('visible');
}

function renderFechCard(f) {
  const isA = S.compare.a === f.id;
  const isB = S.compare.b === f.id;
  const sel = isA || isB;

  return `
    <div class="c360-fech-card ${sel ? 'selected' : ''}"
         id="fech-card-${f.id}"
         onclick="toggleFechamento(${f.id})">
      <div class="c360-fech-check"></div>
      <div class="c360-fech-icon">F</div>
      <div class="c360-fech-body">
        <div class="c360-fech-title">
          ${esc(f.titulo||'Fechamento mensal')}
          ${isA ? '<span style="font-size:10px;margin-left:6px;color:var(--vfop-primary);">[A]</span>' : ''}
          ${isB ? '<span style="font-size:10px;margin-left:6px;color:#855100;">[B]</span>' : ''}
        </div>
        <div class="c360-fech-meta">
          Período: ${esc(f.periodo||'—')} ·
          ${new Date(f.created_at).toLocaleDateString('pt-BR')}
          ${f.publicado
            ? `· <span style="color:#1a7a45;">publicado</span>`
            : ''}
        </div>
      </div>
      <div class="c360-fech-actions" onclick="event.stopPropagation();">
        ${f.token_publico ? `
          <a href="/relatorio-publico.html?token=${f.token_publico}"
             target="_blank"
             class="vfop-action--ghost-arrow"
             style="font-size:11.5px;">
            Ver →
          </a>` : ''}
        <button class="vfop-action"
                style="font-size:11px;color:var(--vfop-err,#9b1c1c);
                       border-color:var(--vfop-err-bg,#fef1f0);"
                onclick="removerFechamento(${f.id})">
          Remover
        </button>
      </div>
    </div>`;
}

async function toggleFechamento(id) {
  // Toggle seleção A/B
  if (S.compare.a === id) {
    S.compare.a = null;
    S.compareData.a = null;
  } else if (S.compare.b === id) {
    S.compare.b = null;
    S.compareData.b = null;
  } else if (!S.compare.a) {
    S.compare.a = id;
  } else if (!S.compare.b) {
    S.compare.b = id;
  } else {
    // Substitui o primeiro
    S.compare.a = id;
    S.compareData.a = null;
  }

  // Atualizar visual dos cards
  document.querySelectorAll('.c360-fech-card').forEach(el => {
    const cid = parseInt(el.id.replace('fech-card-',''));
    const isA = S.compare.a === cid;
    const isB = S.compare.b === cid;
    el.classList.toggle('selected', isA || isB);
    const check = el.querySelector('.c360-fech-check');
    if (check) {
      check.style.background = isA
        ? 'var(--vfop-primary,#4b267a)'
        : isB ? '#855100' : '';
      check.style.borderColor = isA
        ? 'var(--vfop-primary,#4b267a)'
        : isB ? '#855100' : '';
    }
  });

  // Carregar dados se dois selecionados
  if (S.compare.a && S.compare.b) {
    await carregarComparativo();
  } else {
    const body = document.getElementById('c360-compare-body');
    const lbl  = document.getElementById('c360-compare-label');
    if (lbl) lbl.textContent = 'Selecione 2 fechamentos';
    if (body) body.innerHTML = `
      <div class="c360-empty">
        <p>Selecione dois fechamentos acima.</p>
      </div>`;
  }
}

async function carregarComparativo() {
  const lbl  = document.getElementById('c360-compare-label');
  const body = document.getElementById('c360-compare-body');
  if (!body) return;

  body.innerHTML = `<div class="c360-loading">Carregando comparativo...</div>`;

  const fechA = S.entregas.find(e => e.id === S.compare.a);
  const fechB = S.entregas.find(e => e.id === S.compare.b);

  if (!fechA?.token_publico || !fechB?.token_publico) {
    body.innerHTML = `<div class="c360-empty">
      <p>Fechamentos sem token público. Publique-os primeiro.</p>
    </div>`;
    return;
  }

  const [dataA, dataB] = await Promise.all([
    apiPublic(fechA.token_publico),
    apiPublic(fechB.token_publico),
  ]);

  S.compareData.a = dataA?.entrega || dataA;
  S.compareData.b = dataB?.entrega || dataB;

  if (lbl) {
    lbl.textContent =
      `${fechA.periodo||fechA.titulo||'A'} vs ${fechB.periodo||fechB.titulo||'B'}`;
  }

  renderComparativoFechs(body, fechA, fechB, S.compareData.a, S.compareData.b);
}

function renderComparativoFechs(el, fechA, fechB, dataA, dataB) {
  // Extrair cards do payload_json
  const cardsA = dataA?.payload_json?.cards || dataA?.cards || [];
  const cardsB = dataB?.payload_json?.cards || dataB?.cards || [];

  // Mapear por título
  const mapA = {};
  const mapB = {};
  cardsA.forEach(c => { mapA[c.titulo||c.title] = c; });
  cardsB.forEach(c => { mapB[c.titulo||c.title] = c; });

  const allTitles = [...new Set([
    ...Object.keys(mapA),
    ...Object.keys(mapB)
  ])];

  if (!allTitles.length) {
    el.innerHTML = `<div class="c360-empty" style="padding:20px;">
      <p>Dados detalhados não disponíveis.<br>
         Os fechamentos precisam estar publicados.</p>
    </div>`;
    return;
  }

  const rows = allTitles.map(title => {
    const a = mapA[title];
    const b = mapB[title];
    const va = a?.raw ?? a?.valor ?? null;
    const vb = b?.raw ?? b?.valor ?? null;

    const deltaHtml = (() => {
      if (va === null || vb === null) return '—';
      const d = Number(va) - Number(vb);
      const pct = vb !== 0 ? (d / Math.abs(vb) * 100).toFixed(1) : '—';
      const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
      const sign = d > 0 ? '+' : '';
      return `<span class="c360-delta-${cls}">${sign}${pct}%</span>`;
    })();

    const fmtVal = c => {
      if (!c) return '—';
      if (c.valor) return esc(c.valor);
      if (c.raw !== undefined) return fmtBRL(c.raw);
      return '—';
    };

    return `
      <div class="c360-compare-row${a?.destaque ? ' highlight' : ''}">
        <div>${esc(title)}</div>
        <div style="font-weight:600;">${fmtVal(a)}</div>
        <div>${fmtVal(b)}</div>
        <div>${deltaHtml}</div>
      </div>`;
  });

  el.innerHTML = `
    <div class="c360-compare-header">
      <div>Métrica</div>
      <div>${esc(fechA.periodo||fechA.titulo||'Fechamento A')}</div>
      <div>${esc(fechB.periodo||fechB.titulo||'Fechamento B')}</div>
      <div>Δ variação</div>
    </div>
    ${rows.join('')}`;
}

async function removerFechamento(id) {
  if (!confirm('Remover este fechamento? Essa ação não pode ser desfeita.')) return;
  const ok = await apiDelete('/entregas-cliente/' + id);
  if (ok) {
    S.entregas = S.entregas.filter(e => e.id !== id);
    if (S.compare.a === id) { S.compare.a = null; S.compareData.a = null; }
    if (S.compare.b === id) { S.compare.b = null; S.compareData.b = null; }
    renderFechamentos(document.getElementById('tab-fechamentos'));
  } else {
    alert('Erro ao remover. Tente novamente.');
  }
}

/* ── ABA: HISTÓRICO ──────────────────────────────────────── */
function renderHistorico(el) {
  const eventos = S.entregas
    .sort((a,b) => new Date(b.created_at) - new Date(a.created_at))
    .map(e => ({
      title: e.titulo || tipoLabel(e.tipo),
      sub:   `${e.tipo} · período: ${e.periodo||'—'}`,
      date:  e.created_at,
      type:  e.tipo === 'fechamento_mensal' ? 'ok' : 'brand',
      extra: e.token_publico
        ? `<a href="/relatorio-publico.html?token=${e.token_publico}"
             target="_blank"
             class="vfop-action--ghost-arrow"
             style="font-size:11px;">Ver →</a>`
        : '',
    }));

  if (!eventos.length) {
    el.innerHTML = `
      <div class="c360-panel">
        <div class="c360-panel-head">
          <h2 class="c360-panel-title">Histórico operacional</h2>
        </div>
        <div class="c360-empty" style="padding:32px;">
          <div class="c360-empty-icon">📅</div>
          <b>Sem histórico</b>
          <p>As ações do cliente aparecerão aqui.</p>
        </div>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="c360-panel">
      <div class="c360-panel-head">
        <h2 class="c360-panel-title">Histórico operacional</h2>
        <span class="c360-panel-meta">${eventos.length} evento(s)</span>
      </div>
      <div class="c360-panel-body" style="padding:18px;">
        <div class="c360-timeline">
          ${eventos.map(ev => `
            <div class="c360-event">
              <div class="c360-event-dot ${ev.type}"></div>
              <div>
                <div class="c360-event-title">${esc(ev.title)}</div>
                <div class="c360-event-sub">${esc(ev.sub)}</div>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:11px;color:var(--vfop-soft);">
                  ${ev.date
                    ? new Date(ev.date).toLocaleDateString('pt-BR')
                    : '—'}
                </span>
                ${ev.extra}
              </div>
            </div>`).join('')}
        </div>
      </div>
    </div>`;
}

function tipoLabel(tipo) {
  const m = {
    fechamento_mensal: 'Fechamento mensal',
    relatorio: 'Relatório',
    diagnostico: 'Diagnóstico',
  };
  return m[tipo] || tipo || '—';
}

/* ── ATALHOS ─────────────────────────────────────────────── */
function salvarAtalho360(slug, nome) {
  const KEY = 'vfop-atalhos-clientes';
  let lista = [];
  try { lista = JSON.parse(localStorage.getItem(KEY)||'[]'); } catch{}
  if (!lista.find(a => a.slug === slug)) {
    lista.push({ slug, nome });
    if (lista.length > 5) lista.shift();
    localStorage.setItem(KEY, JSON.stringify(lista));
  }
  renderAtalhos360();
}

function renderAtalhos360() {
  const wrap = document.getElementById('c360-quick-chips');
  if (!wrap) return;
  const KEY = 'vfop-atalhos-clientes';
  let lista = [];
  try { lista = JSON.parse(localStorage.getItem(KEY)||'[]'); } catch{}
  if (!lista.length) { wrap.innerHTML = ''; return; }
  const slug = S.cliente?.slug || '';
  wrap.innerHTML = lista.map(a => {
    const initials = (a.nome||'?').split(/\s+/).slice(0,2)
      .map(w=>w[0]).join('').toUpperCase();
    const active = a.slug === slug;
    return `
      <div class="vfop-quick-chip-v2${active?' vfop-quick-chip-v2--active':''}"
           onclick="selecionarCliente360('${a.slug}')">
        <div class="vfop-quick-chip-v2-ic">${initials}</div>
        <span>${esc(a.nome)}</span>
        <span style="opacity:.4;font-size:10px;margin-left:2px;"
              onclick="event.stopPropagation();removerAtalho360('${a.slug}')">
          ×
        </span>
      </div>`;
  }).join('');
}

function selecionarCliente360(slug) {
  const sel = document.getElementById('c360-client-select');
  if (sel) {
    sel.value = slug;
    sel.dispatchEvent(new Event('change'));
  }
}

function removerAtalho360(slug) {
  const KEY = 'vfop-atalhos-clientes';
  let lista = [];
  try { lista = JSON.parse(localStorage.getItem(KEY)||'[]'); } catch{}
  lista = lista.filter(a => a.slug !== slug);
  localStorage.setItem(KEY, JSON.stringify(lista));
  renderAtalhos360();
}

function copiarLink360(slug) {
  const url = API_BASE + '/ml/conectar/' + slug;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.querySelector('[onclick*="copiarLink360"]');
    if (btn) {
      btn.textContent = 'Copiado!';
      setTimeout(() => { btn.textContent = 'Copiar link ML'; }, 2000);
    }
  });
}

/* ── UTIL ────────────────────────────────────────────────── */
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

/* ── BOOT ────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init360);
