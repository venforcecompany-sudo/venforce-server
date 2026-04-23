/**
 * layout.js — Venforce Portal
 * Monta sidebar + verifica auth. Compatível com o backend atual.
 * NÃO muda chamadas de API nem formato de token.
 */

const API_BASE = 'https://venforce-server.onrender.com';

const NAV_ITEMS = [
  { label: 'Extensão',                href: 'extensao.html',    icon: iconDownload(),   adminOnly: false },
  { label: 'Ferramenta OR',           href: 'ferramenta-or.html', icon: iconTool(),    adminOnly: false },
  { label: 'Dashboard',               href: 'dashboard.html',   icon: iconChart(),      adminOnly: false },
  { label: 'Automações',              href: 'automacoes.html',  icon: iconAuto(),       adminOnly: false },
  { label: 'Painel de conversão',     href: 'scans.html',       icon: iconScan(),       adminOnly: false },
  { label: 'Fechamento Financeiro',   href: 'fechamento.html',  icon: iconClose(),      adminOnly: false },
  { label: 'Clientes',                href: 'clientes.html',    icon: iconUsers(),      adminOnly: false },
  { label: 'Callbacks',               href: 'callbacks.html',   icon: iconCallback(),   adminOnly: false },
  { label: 'Tokens ML',               href: 'ml-tokens.html',   icon: iconKey(),        adminOnly: false },
  { label: 'Atividade',               href: 'atividade.html',   icon: iconActivity(),   adminOnly: true  },
  { label: 'Usuários',                href: 'usuarios.html',    icon: iconUserAdmin(),  adminOnly: true  },
];

/* ─── Ícones SVG (inline, 15×15) ─────────────────────────── */
function svg(path) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}
function iconDownload()  { return svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'); }
function iconTool()      { return svg('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'); }
function iconChart()     { return svg('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'); }
function iconAuto()      { return svg('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>'); }
function iconScan()      { return svg('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="10" height="10" rx="1"/>'); }
function iconClose()     { return svg('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'); }
function iconUsers()     { return svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'); }
function iconCallback()  { return svg('<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>'); }
function iconKey()       { return svg('<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>'); }
function iconActivity()  { return svg('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'); }
function iconUserAdmin() { return svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="23" y1="11" x2="17" y2="11"/><line x1="20" y1="8" x2="20" y2="14"/>'); }
function iconLogout()    { return svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'); }

/* ─── Auth ───────────────────────────────────────────────── */
function getToken() { return localStorage.getItem('token'); }
function getUser()  {
  try { return JSON.parse(localStorage.getItem('user')); } catch { return null; }
}
function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = 'login.html';
}

async function verificarAuth() {
  const token = getToken();
  if (!token) { window.location.href = 'login.html'; return null; }
  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) { logout(); return null; }
    const data = await res.json();
    // atualiza user em cache
    if (data.user) localStorage.setItem('user', JSON.stringify(data.user));
    return data.user;
  } catch {
    // se offline mas token existe, usa cache
    const cached = getUser();
    if (cached) return cached;
    logout(); return null;
  }
}

/* ─── Sidebar HTML ───────────────────────────────────────── */
function buildSidebar(user) {
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  const isAdmin = user?.role === 'admin';
  const initials = (user?.nome || user?.email || 'U')
    .split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  const navItems = NAV_ITEMS
    .filter(item => !item.adminOnly || isAdmin)
    .map(item => {
      const active = currentPage === item.href ? 'active' : '';
      return `<a href="${item.href}" class="sidebar-item ${active}">
        ${item.icon}
        <span>${item.label}</span>
      </a>`;
    }).join('');

  return `
    <div class="sidebar">
      <div class="sidebar-logo">
        <div class="sidebar-logo-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="white">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
          </svg>
        </div>
        <span class="sidebar-logo-name">VenforceGo</span>
      </div>

      <nav class="sidebar-nav" id="sidebar-nav">
        ${navItems}
      </nav>

      <div class="sidebar-footer">
        <div class="sidebar-user" title="Sair" onclick="logout()">
          <div class="sidebar-avatar">${initials}</div>
          <div class="sidebar-user-info">
            <div class="sidebar-user-name">${user?.nome || user?.email || 'Usuário'}</div>
            <div class="sidebar-user-role">${isAdmin ? 'Admin' : 'Membro'}</div>
          </div>
          <button class="sidebar-logout-btn" aria-label="Sair">
            ${iconLogout()}
          </button>
        </div>
      </div>
    </div>
  `;
}

/* ─── initLayout ─────────────────────────────────────────── */
async function initLayout() {
  const user = await verificarAuth();
  if (!user) return;

  const app = document.getElementById('app');
  if (!app) return;

  // injeta sidebar antes do conteúdo existente
  app.insertAdjacentHTML('afterbegin', buildSidebar(user));

  // expõe user globalmente para páginas que precisam
  window._vfUser = user;

  return user;
}

window.logout = logout;
window.getToken = getToken;
window.getUser = getUser;
window.initLayout = initLayout;
window.API_BASE = API_BASE;
