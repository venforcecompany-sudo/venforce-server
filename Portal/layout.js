// Layout compartilhado (sidebar/topbar) para páginas do portal
(function () {
  const STORAGE_KEY = "vf-token";

  function getUserSafe() {
    try {
      return JSON.parse(localStorage.getItem("vf-user") || "{}") || {};
    } catch {
      return {};
    }
  }

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
      return `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
        </svg>`;
    }
    if (name === "users") {
      return `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
          <circle cx="9" cy="7" r="4"></circle>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
          <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
        </svg>`;
    }
    if (name === "repeat") {
      return `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="17 1 21 5 17 9"></polyline>
          <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
          <polyline points="7 23 3 19 7 15"></polyline>
          <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
        </svg>`;
    }
    if (name === "bar-chart") {
      return `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="12" y1="20" x2="12" y2="10"></line>
          <line x1="18" y1="20" x2="18" y2="4"></line>
          <line x1="6" y1="20" x2="6" y2="16"></line>
        </svg>`;
    }
    if (name === "download") {
      return `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="12" y1="3" x2="12" y2="16"></line>
          <polyline points="7 11 12 16 17 11"></polyline>
          <line x1="5" y1="21" x2="19" y2="21"></line>
        </svg>`;
    }
    if (name === "shield") {
      return `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
        </svg>`;
    }
    if (name === "logout") {
      return `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
          <polyline points="16 17 21 12 16 7"></polyline>
          <line x1="21" y1="12" x2="9" y2="12"></line>
        </svg>`;
    }
    if (name === "menu") {
      return `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="3" y1="12" x2="21" y2="12"></line>
          <line x1="3" y1="6" x2="21" y2="6"></line>
          <line x1="3" y1="18" x2="21" y2="18"></line>
        </svg>`;
    }
    return "";
  }

  function buildNavLinks(user) {
    const links = [
      { label: "Extensão", href: "extensao.html", icon: "download", adminOnly: false },
      { label: "Dashboard", href: "dashboard.html", icon: "activity", adminOnly: false },
      { label: "Painel de análise de conversão", href: "fechamento.html", icon: "activity", adminOnly: false },
      { label: "Clientes", href: "clientes.html", icon: "users", adminOnly: false },
      { label: "Callbacks", href: "callbacks.html", icon: "repeat", adminOnly: false },
      { label: "Usuários", href: "usuarios.html", icon: "shield", adminOnly: true },
    ];
    return links
      .filter((l) => !l.adminOnly || user.role === "admin")
      .map((l) => {
        const active = isActiveLink(l.href) ? "active" : "";
        return `<a class="${active}" href="${l.href}">${svgIcon(l.icon)}<span>${l.label}</span></a>`;
      })
      .join("");
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

  window.initLayout = function initLayout() {
    if (document.querySelector(".vf-sidebar")) return;
    if (!ensureAuthenticated()) return;

    const user = getUserSafe();
    const sidebar = document.createElement("aside");
    sidebar.className = "vf-sidebar";

    const logo = document.createElement("div");
    logo.className = "vf-sidebar-logo";
    logo.innerHTML = `
      <button type="button" id="vf-menu-btn" aria-label="Abrir menu" style="display:none;background:transparent;border:1px solid var(--vf-border);border-radius:10px;width:36px;height:36px;align-items:center;justify-content:center;color:var(--vf-text-m);cursor:pointer;">
        ${svgIcon("menu")}
      </button>
      <a href="dashboard.html" style="display:flex;align-items:center;gap:0.75rem;text-decoration:none;color:inherit;">
        <span style="width:36px;height:36px;background-color:var(--vf-primary);background-image:linear-gradient(180deg, rgba(255,255,255,.12) 0%, rgba(255,255,255,0) 55%);border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 2px 8px rgba(var(--vf-primary-rgb),.2);">
          ${svgIcon("activity")}
        </span>
        <span>VenforceGo</span>
      </a>
    `;

    const nav = document.createElement("nav");
    nav.className = "vf-sidebar-nav";
    nav.innerHTML = buildNavLinks(user);

    const footer = document.createElement("div");
    footer.className = "vf-sidebar-footer";
    footer.innerHTML = `
      <div class="vf-sidebar-avatar">${getInitial(user)}</div>
      <div class="vf-sidebar-user-name" title="${(user.nome || user.email || "").replace(/"/g, "")}">
        ${user.nome || user.email || "Usuário"}
      </div>
      <button class="vf-sidebar-logout" id="vf-btn-logout" title="Sair">
        ${svgIcon("logout")}
      </button>
    `;

    sidebar.appendChild(logo);
    sidebar.appendChild(nav);
    sidebar.appendChild(footer);

    document.body.insertBefore(sidebar, document.body.firstChild);

    const logoutBtn = sidebar.querySelector("#vf-btn-logout");
    if (logoutBtn) logoutBtn.addEventListener("click", clearSession);

    const menuBtn = sidebar.querySelector("#vf-menu-btn");
    function syncMenuButton() {
      const isMobile = window.matchMedia("(max-width: 768px)").matches;
      if (!menuBtn) return;
      menuBtn.style.display = isMobile ? "inline-flex" : "none";
      if (!isMobile) sidebar.classList.remove("is-open");
    }
    syncMenuButton();
    window.addEventListener("resize", syncMenuButton);

    if (menuBtn) {
      menuBtn.addEventListener("click", () => {
        sidebar.classList.toggle("is-open");
      });
    }
  };
})();

