// Layout compartilhado (sidebar/topbar) para páginas do portal
(function () {
  const STORAGE_KEY = "vf-token";
  const DEBUG_ENABLED_KEY = "vf-debug-enabled";
  const DEBUG_CLIENT_SRC = "vf-debug-client.js";

  function getUserSafe() {
    try {
      return JSON.parse(localStorage.getItem("vf-user") || "{}") || {};
    } catch {
      return {};
    }
  }

  function getDebugUrlFlag() {
    try {
      return new URLSearchParams(window.location.search || "").get("vf_debug");
    } catch {
      return null;
    }
  }

  function loadDebugClientIfSafe() {
    try {
      const user = getUserSafe();
      const isAdmin = String(user.role || "").toLowerCase() === "admin";
      const hasToken = !!localStorage.getItem(STORAGE_KEY);
      const urlFlag = getDebugUrlFlag();

      if (urlFlag === "0" || urlFlag === "false" || urlFlag === "off") {
        localStorage.setItem(DEBUG_ENABLED_KEY, "false");
        return;
      }

      if (!isAdmin || !hasToken) return;

      if (urlFlag === "1" || urlFlag === "true" || urlFlag === "on") {
        localStorage.setItem(DEBUG_ENABLED_KEY, "true");
      }

      if (localStorage.getItem(DEBUG_ENABLED_KEY) !== "true") return;
      if (window.__VF_DEBUG_CLIENT_LOADING__ || window.VFDebugClient) return;
      if (document.querySelector('script[data-vf-debug-client="true"]')) return;

      window.__VF_DEBUG_CLIENT_LOADING__ = true;

      if (document.readyState === "loading" && typeof document.write === "function") {
        document.write('<script src="' + DEBUG_CLIENT_SRC + '" data-vf-debug-client="true"><\/script>');
        return;
      }

      const script = document.createElement("script");
      script.src = DEBUG_CLIENT_SRC;
      script.async = true;
      script.dataset.vfDebugClient = "true";
      script.onerror = function () {
        window.__VF_DEBUG_CLIENT_LOADING__ = false;
      };
      (document.head || document.documentElement).appendChild(script);
    } catch {
      // O debug client e auxiliar; qualquer falha deve manter o Portal intacto.
    }
  }

  loadDebugClientIfSafe();

  function clearSession() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem("vf-user");
    window.location.replace("index.html");
  }

  function isActiveLink(href) {
    const current = (window.location.pathname || "").split("/").pop() || "";
    return current === href;
  }

  function svgIcon(name) {
    if (name === "activity") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>`;
    }
    if (name === "vf-dashboard") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"></path><path d="M7 15l4-4 3 3 6-6"></path></svg>`;
    }
    if (name === "vf-fechamento") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v20"></path><path d="M17 6H9.5a3.5 3.5 0 0 0 0 7H14a3.5 3.5 0 0 1 0 7H6"></path></svg>`;
    }
    if (name === "vf-financeiro") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V10"></path><path d="M10 20V4"></path><path d="M16 20v-8"></path><path d="M3 20h18"></path></svg>`;
    }
    if (name === "users") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`;
    }
    if (name === "repeat") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>`;
    }
    if (name === "bar-chart") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="20" x2="12" y2="10"></line><line x1="18" y1="20" x2="18" y2="4"></line><line x1="6" y1="20" x2="6" y2="16"></line></svg>`;
    }
    if (name === "download") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="3" x2="12" y2="16"></line><polyline points="7 11 12 16 17 11"></polyline><line x1="5" y1="21" x2="19" y2="21"></line></svg>`;
    }
    if (name === "shield") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>`;
    }
    if (name === "logout") {
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>`;
    }
    if (name === "menu") {
      return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>`;
    }
    if (name === "chevron-left") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>`;
    }
    if (name === "chevron-right") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
    }
    if (name === "search") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;
    }
    if (name === "layers") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`;
    }
    if (name === "trending-up") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg>`;
    }
    if (name === "database") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>`;
    }
    if (name === "book-open") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>`;
    }
    if (name === "media") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;
    }
    if (name === "terminal") {
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`;
    }
    return "";
  }

  // ─── Navigation groups ──────────────────────────────────────────────────────

  const NAV_GROUPS = {
    operacao: {
      label: "Operação",
      defaultPage: "dashboard.html",
      links: [
        { separator: true, label: "INÍCIO" },
        { label: "Dashboard",    href: "dashboard.html",     icon: "vf-dashboard" },
        { label: "Diagnóstico Inicial", href: "diagnostico-inicial.html", icon: "activity" },
        { label: "Cliente Operação", href: "cliente-operacao.html", icon: "users" },
        { label: "Cliente 360", href: "cliente-360.html", icon: "users" },
        { label: "Bases de Custo", href: "bases.html",         icon: "database"     },

        { separator: true, label: "MARKETPLACE" },
        { label: "Anúncios ML",  href: "anuncios-meli.html", icon: "activity",    adminOnly: true },
        { label: "Criação Anúncios ML", href: "criar-anuncios-meli.html", icon: "activity", adminOnly: true },
        { label: "Mercado Ads",  href: "ads.html",           icon: "trending-up"  },
        { label: "Precificação - API",   href: "automacoes.html",    icon: "repeat"       },
        { label: "Relatórios",   href: "relatorios.html",    icon: "bar-chart"     },
        { label: "Promoções ML", href: "promocoes-retorno.html", icon: "trending-up" },
        
        { separator: true, label: "ANÁLISES" },
        { label: "Fechamento",   href: "financeiro.html",    icon: "vf-financeiro" },
        { label: "Fechamento - API", href: "fechamentos-api.html", icon: "vf-financeiro", adminOnly: true },
        { label: "Conversão",    href: "fechamento.html",    icon: "vf-fechamento" },

        { separator: true, label: "FERRAMENTAS" },
        { label: "Ferramentas", href: "ferramentas.html", icon: "download" },
      ],
    },
    guia: {
      label: "Guia - Vendedor",
      defaultPage: "guia-vendedor.html",
      links: [
        { label: "Guia do Vendedor", href: "guia-vendedor.html", icon: "book-open" },
      ],
    },
    clientes: {
      label: "Clientes",
      defaultPage: "clientes.html",
      adminOnly: true,
      links: [
        { label: "Todos os clientes", href: "clientes.html",  icon: "users"  },
        { label: "Mercado Livre",     href: "clientes.html",  icon: "shield" },
        { label: "Tokens ML",         href: "ml-tokens.html", icon: "shield" },
        { label: "Callbacks",         href: "callbacks.html", icon: "repeat" },
      ],
    },
    admin: {
      label: "Admin",
      defaultPage: "usuarios.html",
      adminOnly: true,
      links: [
        { label: "Usuários",  href: "usuarios.html",  icon: "users"    },
        { label: "Tokens ML", href: "ml-tokens.html", icon: "shield"   },
        { label: "Callbacks", href: "callbacks.html", icon: "repeat"   },
        { label: "Atividade", href: "atividade.html", icon: "activity" },
        { label: "Control Center", href: "control-center.html", icon: "terminal" },
      ],
    },
    clickup: {
      label: "Gestão - Clickup",
      defaultPage: "clickup-executivo.html",
      adminOnly: true,
      links: [
        { label: "Resumo executivo", href: "clickup-executivo.html", icon: "activity" },
      ],
    },
  };

  const PAGE_TO_GROUP = {
    "clientes.html":        "clientes",
    "ml-tokens.html":       "clientes",
    "callbacks.html":       "clientes",
    "usuarios.html":        "admin",
    "atividade.html":       "admin",
    "control-center.html":   "admin",
    "clickup-executivo.html": "clickup",
    "guia-vendedor.html":   "guia",
    "anuncios-meli.html":   "operacao",
    "criar-anuncios-meli.html": "operacao",
    "ads.html":             "operacao",
    "automacoes.html":      "operacao",
    "promocoes-retorno.html": "operacao",
    "financeiro.html":      "operacao",
    "fechamentos-api.html": "operacao",
    "relatorios.html":      "operacao",
    "fechamento.html":      "operacao",
    "ferramentas.html":       "operacao",
    "extensao.html":          "operacao",
    "ferramenta-or.html":     "operacao",
    "baixador-midias.html":   "operacao",
    "metricas.html":          "operacao",
    "cliente-operacao.html":  "operacao",
    "diagnostico-inicial.html": "operacao",
    "cliente-360.html":       "operacao",
    "dashboard.html":       "operacao",
    "bases.html":           "operacao",
  };

  function detectGroup() {
    const page = (window.location.pathname || "").split("/").pop() || "";
    return PAGE_TO_GROUP[page] || "operacao";
  }

  function buildSidebarLinks(groupId, isAdmin) {
    const group = NAV_GROUPS[groupId];
    if (!group) return "";
    return group.links
      .filter((l) => l.separator || !l.adminOnly || isAdmin)
      .map((l) => {
        if (l.separator) {
          return `<div class="vf-sidebar-separator">${l.label}</div>`;
        }
        const cls = isActiveLink(l.href) ? ' class="active"' : "";
        return `<a${cls} href="${l.href}">${svgIcon(l.icon)}<span>${l.label}</span></a>`;
      })
      .join("");
  }

  function buildTopbar(activeGroup, isAdmin) {
    const tabs = Object.keys(NAV_GROUPS)
      .filter((id) => !NAV_GROUPS[id].adminOnly || isAdmin)
      .map((id) => {
        const g = NAV_GROUPS[id];
        const cls = "vf-topbar-link" + (id === activeGroup ? " is-active" : "");
        return `<a href="${g.defaultPage}" class="${cls}" data-group="${id}">${g.label}</a>`;
      })
      .join("");
    return `<div class="vf-app-topbar"><nav class="vf-topbar-nav">${tabs}</nav></div>`;
  }

  function getInitial(user) {
    const nome = (user.nome || "").trim();
    const base = nome || (user.email || "").trim();
    return (base ? base[0] : "V").toUpperCase();
  }

  function ensureAuthenticated() {
    const t = localStorage.getItem(STORAGE_KEY);
    if (!t) {
      window.location.replace("index.html");
      return false;
    }
    return true;
  }

  const SIDEBAR_COLLAPSED_KEY = "vf-sidebar-collapsed";

  function isDesktopSidebar() {
    return window.matchMedia("(min-width: 769px)").matches;
  }

  window.initLayout = function initLayout() {
    if (document.querySelector(".vf-sidebar")) return;
    if (!ensureAuthenticated()) return;

    const user = getUserSafe();
    const role = String(user.role || "").toLowerCase();
    // Seller não usa o portal interno: tem área própria sem sidebar.
    if (role === "seller") {
      window.location.replace("seller.html");
      return;
    }
    const isAdmin = role === "admin";
    const activeGroup = detectGroup();

    // ── Sidebar ──────────────────────────────────────────────────────────────
    const sidebar = document.createElement("aside");
    sidebar.className = "vf-sidebar";

    const logo = document.createElement("div");
    logo.className = "vf-sidebar-logo";
    logo.innerHTML = `
      <button type="button" id="vf-menu-btn" aria-label="Abrir menu" style="display:none;background:transparent;border:1px solid var(--vf-border);border-radius:10px;width:36px;height:36px;align-items:center;justify-content:center;color:var(--vf-text-m);cursor:pointer;">${svgIcon("menu")}</button>
      <a href="dashboard.html" class="vf-sidebar-logo-link">
        <span class="vf-sidebar-logo-icon" aria-hidden="true">VF</span>
        <span class="vf-sidebar-logo-text"><span class="vf-logo-wordmark">Venforce</span><span class="vf-logo-go-inline">Go</span></span>
      </a>
      <button type="button" id="vf-sidebar-toggle" class="vf-sidebar-toggle" aria-label="Recolher menu" aria-expanded="true">${svgIcon("chevron-left")}</button>
    `;

    const nav = document.createElement("nav");
    nav.className = "vf-sidebar-nav";
    nav.innerHTML = `<div class="vf-sidebar-section-title">${(NAV_GROUPS[activeGroup] || NAV_GROUPS.operacao).label}</div>${buildSidebarLinks(activeGroup, isAdmin)}`;

    const footer = document.createElement("div");
    footer.className = "vf-sidebar-footer";
    footer.innerHTML = `
      <div class="vf-sidebar-avatar">${getInitial(user)}</div>
      <div class="vf-sidebar-user-name" title="${(user.nome || user.email || "").replace(/"/g, "")}">${user.nome || user.email || "Usuário"}</div>
      <button class="vf-sidebar-logout" id="vf-btn-logout" title="Sair">${svgIcon("logout")}</button>
    `;

    sidebar.appendChild(logo);
    sidebar.appendChild(nav);
    sidebar.appendChild(footer);
    document.body.insertBefore(sidebar, document.body.firstChild);

    // ── Topbar inside .vf-main-with-sidebar ──────────────────────────────────
    const mainArea = document.querySelector(".vf-main-with-sidebar");
    if (mainArea) {
      const tmp = document.createElement("div");
      tmp.innerHTML = buildTopbar(activeGroup, isAdmin);
      mainArea.insertBefore(tmp.firstChild, mainArea.firstChild);
    }

    // ── Logout ───────────────────────────────────────────────────────────────
    const logoutBtn = sidebar.querySelector("#vf-btn-logout");
    if (logoutBtn) logoutBtn.addEventListener("click", clearSession);

    // ── Sidebar collapse ─────────────────────────────────────────────────────
    const toggleBtn = sidebar.querySelector("#vf-sidebar-toggle");

    function setSidebarCollapsed(collapsed) {
      if (!isDesktopSidebar()) {
        sidebar.classList.remove("is-collapsed");
        if (toggleBtn) {
          toggleBtn.setAttribute("aria-expanded", "true");
          toggleBtn.setAttribute("aria-label", "Recolher menu");
          toggleBtn.innerHTML = svgIcon("chevron-left");
        }
        return;
      }
      sidebar.classList.toggle("is-collapsed", collapsed);
      if (toggleBtn) {
        toggleBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
        toggleBtn.setAttribute("aria-label", collapsed ? "Expandir menu" : "Recolher menu");
        toggleBtn.innerHTML = collapsed ? svgIcon("chevron-right") : svgIcon("chevron-left");
      }
    }

    function applyStoredSidebarCollapse() {
      const collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
      setSidebarCollapsed(collapsed);
    }

    const menuBtn = sidebar.querySelector("#vf-menu-btn");

    function syncMenuButton() {
      const isMobile = window.matchMedia("(max-width: 768px)").matches;
      if (!menuBtn) return;
      menuBtn.style.display = isMobile ? "inline-flex" : "none";
      if (!isMobile) sidebar.classList.remove("is-open");
    }

    function onResizeLayout() {
      syncMenuButton();
      applyStoredSidebarCollapse();
    }

    syncMenuButton();
    applyStoredSidebarCollapse();
    window.addEventListener("resize", onResizeLayout);

    if (menuBtn) {
      menuBtn.addEventListener("click", () => {
        sidebar.classList.toggle("is-open");
      });
    }

    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        if (!isDesktopSidebar()) return;
        const next = !sidebar.classList.contains("is-collapsed");
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
        setSidebarCollapsed(next);
      });
    }
  };
})();
