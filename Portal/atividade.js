/**
 * atividade.js — Venforce Portal
 * Consome GET /admin/logs — contrato de API INALTERADO.
 */

/* ─── Estado ─────────────────────────────────────────────── */
let state = {
  page: 1,
  totalPages: 1,
  total: 0,
  loading: false,
};

/* ─── Refs ───────────────────────────────────────────────── */
const tbody         = document.getElementById('logs-tbody');
const totalBadge    = document.getElementById('total-badge');
const pagination    = document.getElementById('pagination');
const pgInfo        = document.getElementById('pagination-info');
const pgControls    = document.getElementById('pagination-controls');
const btnFiltrar    = document.getElementById('btn-filtrar');
const btnLimpar     = document.getElementById('btn-limpar');
const inputAcao     = document.getElementById('f-acao');
const selectStatus  = document.getElementById('f-status');
const inputDe       = document.getElementById('f-de');
const inputAte      = document.getElementById('f-ate');

/* ─── Filtros ────────────────────────────────────────────── */
function getFiltros() {
  return {
    acao_prefix: inputAcao.value.trim()    || null,
    status:      selectStatus.value       || null,
    de:          inputDe.value            || null,
    ate:         inputAte.value           || null,
  };
}

function buildQuery(filtros, page) {
  const p = new URLSearchParams();
  if (filtros.acao_prefix) p.set('acao_prefix', filtros.acao_prefix);
  if (filtros.status)      p.set('status',      filtros.status);
  if (filtros.de)          p.set('de',          filtros.de);
  if (filtros.ate)         p.set('ate',         filtros.ate);
  p.set('page',  String(page));
  p.set('limit', '50');
  return p.toString();
}

/* ─── Fetch ──────────────────────────────────────────────── */
async function fetchLogs(page = 1) {
  if (state.loading) return;
  state.loading = true;

  const token = getToken(); // de layout.js
  const filtros = getFiltros();
  const qs = buildQuery(filtros, page);

  setLoading(true);

  try {
    const res = await fetch(`${API_BASE}/admin/logs?${qs}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    if (!data.ok) throw new Error(data.message || 'Erro ao buscar logs');

    state.page       = data.page       || 1;
    state.totalPages = data.totalPages || 1;
    state.total      = data.total      || 0;

    renderTable(data.logs || []);
    renderPagination();

  } catch (err) {
    renderError(err.message);
  } finally {
    state.loading = false;
  }
}

/* ─── Render ─────────────────────────────────────────────── */
function setLoading(on) {
  if (on) {
    tbody.innerHTML = `
      <tr class="loading-row">
        <td colspan="6"><span class="spinner"></span>carregando logs…</td>
      </tr>`;
    totalBadge.textContent = '—';
    pagination.style.display = 'none';
  }
}

function renderError(msg) {
  tbody.innerHTML = `
    <tr>
      <td colspan="6">
        <div class="empty-state">
          <div class="empty-state-icon">⚠</div>
          <div class="empty-state-title">Erro ao carregar</div>
          <div class="empty-state-desc">${escHtml(msg)}</div>
        </div>
      </td>
    </tr>`;
  totalBadge.textContent = '!';
  pagination.style.display = 'none';
}

function renderTable(logs) {
  totalBadge.textContent = state.total.toLocaleString('pt-BR');

  if (!logs.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="empty-state">
            <div class="empty-state-icon">◎</div>
            <div class="empty-state-title">Nenhum log encontrado</div>
            <div class="empty-state-desc">Tente ajustar os filtros.</div>
          </div>
        </td>
      </tr>`;
    pagination.style.display = 'none';
    return;
  }

  tbody.innerHTML = logs.map(log => {
    const date    = formatDate(log.created_at);
    const usuario = escHtml(log.user_nome || log.user_email || '—');
    const acao    = escHtml(log.acao || '—');
    const ip      = escHtml(log.ip || '—');
    const detStr  = log.detalhes
      ? (typeof log.detalhes === 'string' ? log.detalhes : JSON.stringify(log.detalhes, null, 2))
      : '—';
    const isSuccess = log.status === 'sucesso';

    return `<tr>
      <td class="col-date">${date}</td>
      <td class="col-user">${usuario}</td>
      <td class="col-action">${acao}</td>
      <td>
        <span class="badge ${isSuccess ? 'badge-success' : 'badge-error'}">
          ${isSuccess ? 'sucesso' : 'falha'}
        </span>
      </td>
      <td class="col-ip">${ip}</td>
      <td class="col-details">
        ${detStr !== '—' ? `<div class="json-block">${escHtml(detStr)}</div>` : '—'}
      </td>
    </tr>`;
  }).join('');
}

function renderPagination() {
  if (state.totalPages <= 1) {
    pagination.style.display = 'none';
    return;
  }

  const inicio = (state.page - 1) * 50 + 1;
  const fim    = Math.min(state.page * 50, state.total);
  pgInfo.textContent = `${inicio}–${fim} de ${state.total.toLocaleString('pt-BR')}`;

  // janela de páginas: máx 5 botões
  const pages  = [];
  const half   = 2;
  let start    = Math.max(1, state.page - half);
  let end      = Math.min(state.totalPages, state.page + half);
  if (end - start < 4) {
    if (start === 1) end   = Math.min(state.totalPages, start + 4);
    else             start = Math.max(1, end - 4);
  }
  for (let i = start; i <= end; i++) pages.push(i);

  let html = `
    <button class="page-btn" onclick="goPage(${state.page - 1})"
      ${state.page === 1 ? 'disabled' : ''}>‹</button>`;
  pages.forEach(p => {
    html += `<button class="page-btn ${p === state.page ? 'active' : ''}"
      onclick="goPage(${p})">${p}</button>`;
  });
  html += `
    <button class="page-btn" onclick="goPage(${state.page + 1})"
      ${state.page === state.totalPages ? 'disabled' : ''}>›</button>`;

  pgControls.innerHTML = html;
  pagination.style.display = 'flex';
}

/* ─── Helpers ────────────────────────────────────────────── */
function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh   = String(d.getHours()).padStart(2, '0');
  const min  = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ─── Navegação ──────────────────────────────────────────── */
function goPage(p) {
  if (p < 1 || p > state.totalPages || p === state.page) return;
  state.page = p;
  fetchLogs(p);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
window.goPage = goPage;

/* ─── Eventos ────────────────────────────────────────────── */
btnFiltrar.addEventListener('click', () => {
  state.page = 1;
  fetchLogs(1);
});

btnLimpar.addEventListener('click', () => {
  inputAcao.value    = '';
  selectStatus.value = '';
  inputDe.value      = '';
  inputAte.value     = '';
  state.page = 1;
  fetchLogs(1);
});

// filtrar ao pressionar Enter em qualquer input
[inputAcao, inputDe, inputAte].forEach(el => {
  el.addEventListener('keydown', e => { if (e.key === 'Enter') btnFiltrar.click(); });
});

/* ─── Init ───────────────────────────────────────────────── */
(async () => {
  await initLayout(); // de layout.js — verifica auth, monta sidebar
  fetchLogs(1);
})();
