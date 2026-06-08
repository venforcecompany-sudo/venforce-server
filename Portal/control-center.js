(function () {
  "use strict";

  const STORAGE_KEY = "vf-token";
  const USER_KEY = "vf-user";
  const SOURCE_MODE_KEY = "vf-control-center-mode";
  const DEBUG_ENABLED_KEY = "vf-debug-enabled";
  const DEBUG_LOG_KEY = "vf-debug-logs";
  const CONTROL_CENTER_MODE = "mock";
  const VALID_MODES = ["mock", "browser", "backend"];
  const API_BASE_HINT = "https://venforce-server.onrender.com";
  const SLOW_LIMIT_MS = 1000;
  const SENSITIVE_KEY_PARTS = [
    "authorization",
    "accesstoken",
    "refreshtoken",
    "apikey",
    "token",
    "password",
    "senha",
    "xapikey",
    "clientsecret"
  ];

  initLayout();

  const state = {
    entries: [],
    selectedId: null,
    statusFilter: "all",
    screenFilter: "all",
    search: "",
    activeTab: "request",
    mockDebug: true,
    browserDebug: isBrowserDebugEnabled(),
    mode: resolveInitialMode(),
    user: readUserSafe(),
    token: localStorage.getItem(STORAGE_KEY) || ""
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", initControlCenter);

  async function initControlCenter() {
    cacheElements();
    bindEvents();
    renderSessionContext();
    await reloadEntries();
  }

  function cacheElements() {
    els.rows = document.querySelector("[data-vfc-rows]");
    els.detail = document.querySelector("[data-vfc-detail]");
    els.visibleCount = document.querySelector("[data-vfc-visible-count]");
    els.statusButtons = Array.from(document.querySelectorAll("[data-vfc-status-filter]"));
    els.modeButtons = Array.from(document.querySelectorAll("[data-vfc-mode]"));
    els.screenFilter = document.querySelector("[data-vfc-screen-filter]");
    els.search = document.querySelector("[data-vfc-search]");
    els.clear = document.querySelector("[data-vfc-clear]");
    els.refresh = document.querySelector("[data-vfc-refresh]");
    els.debug = document.querySelector("[data-vfc-debug]");
    els.browserDebug = document.querySelector("[data-vfc-browser-debug]");
    els.userName = document.querySelector("[data-vfc-user-name]");
    els.userRole = document.querySelector("[data-vfc-user-role]");
    els.tokenState = document.querySelector("[data-vfc-token-state]");
    els.apiBase = document.querySelector("[data-vfc-api-base]");
    els.envMode = document.querySelector("[data-vfc-env-mode]");
    els.kicker = document.querySelector("[data-vfc-kicker]");
    els.browserDebugState = document.querySelector("[data-vfc-browser-debug-state]");
    els.modeTitle = document.querySelector("[data-vfc-mode-title]");
    els.modeCopy = document.querySelector("[data-vfc-mode-copy]");
    els.modeStorage = document.querySelector("[data-vfc-mode-storage]");
    els.footerSource = document.querySelector("[data-vfc-footer-source]");
    els.summary = {
      total: document.querySelector('[data-vfc-summary="total"]'),
      ok: document.querySelector('[data-vfc-summary="ok"]'),
      "4xx": document.querySelector('[data-vfc-summary="4xx"]'),
      "5xx": document.querySelector('[data-vfc-summary="5xx"]'),
      slow: document.querySelector('[data-vfc-summary="slow"]'),
      avg: document.querySelector('[data-vfc-summary="avg"]'),
      lastError: document.querySelector('[data-vfc-summary="lastError"]')
    };
  }

  function bindEvents() {
    els.modeButtons.forEach((button) => {
      button.addEventListener("click", async () => {
        const nextMode = button.dataset.vfcMode || CONTROL_CENTER_MODE;
        if (!VALID_MODES.includes(nextMode)) return;
        state.mode = nextMode;
        localStorage.setItem(SOURCE_MODE_KEY, nextMode);
        await reloadEntries();
      });
    });

    els.statusButtons.forEach((button) => {
      button.addEventListener("click", () => {
        state.statusFilter = button.dataset.vfcStatusFilter || "all";
        els.statusButtons.forEach((item) => item.classList.toggle("is-active", item === button));
        renderAll();
      });
    });

    els.screenFilter.addEventListener("change", () => {
      state.screenFilter = els.screenFilter.value;
      renderAll();
    });

    els.search.addEventListener("input", () => {
      state.search = els.search.value.trim().toLowerCase();
      renderAll();
    });

    els.refresh.addEventListener("click", reloadEntries);

    els.clear.addEventListener("click", () => {
      if (state.mode === "browser") {
        clearDebugLogs();
      }

      state.entries = [];
      state.selectedId = null;
      hydrateScreenFilter();
      renderAll();
      renderModeState();
    });

    els.debug.addEventListener("click", () => {
      state.mockDebug = !state.mockDebug;

      if (state.mode === "mock" && state.mockDebug && state.entries.length === 0) {
        state.entries = loadMockData().map(normalizeEntry);
        state.selectedId = state.entries[0]?.id || null;
        hydrateScreenFilter();
      }

      renderAll();
      renderModeState();
    });

    els.browserDebug.addEventListener("click", async () => {
      const next = !state.browserDebug;
      setBrowserDebugEnabled(next);
      state.browserDebug = isBrowserDebugEnabled();

      if (state.browserDebug) {
        ensureBrowserDebugClientLoaded();
      }

      if (state.mode === "browser") {
        await reloadEntries();
      } else {
        renderModeState();
        renderDetail();
      }
    });

    window.addEventListener("storage", (event) => {
      if (event.key === DEBUG_LOG_KEY && state.mode === "browser") {
        reloadEntries();
      }
      if (event.key === DEBUG_ENABLED_KEY) {
        state.browserDebug = isBrowserDebugEnabled();
        renderModeState();
      }
    });

    window.addEventListener("vf-debug-log", () => {
      if (state.mode === "browser") reloadEntries();
    });
  }

  async function reloadEntries() {
    const rawEntries = await loadEntriesForMode(state.mode);
    state.entries = rawEntries.map(normalizeEntry);

    if (!state.entries.some((entry) => entry.id === state.selectedId)) {
      state.selectedId = state.entries[0]?.id || null;
    }

    hydrateScreenFilter();
    renderAll();
    renderModeState();
  }

  async function loadEntriesForMode(mode) {
    if (mode === "browser") return loadBrowserLogs();
    if (mode === "backend") return loadBackendData();
    return state.mockDebug ? loadMockData() : [];
  }

  function renderSessionContext() {
    const userName = state.user.nome || state.user.email || "Usuario";
    const role = state.user.role || "sem role";

    els.userName.textContent = sanitizeText(userName);
    els.userRole.textContent = sanitizeText(role);
    els.tokenState.textContent = state.token ? maskSensitive(`Bearer ${state.token}`) : "ausente";
    els.apiBase.textContent = API_BASE_HINT;
  }

  function renderModeState() {
    const meta = getModeMeta(state.mode);
    state.browserDebug = isBrowserDebugEnabled();

    els.modeButtons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.vfcMode === state.mode);
    });

    els.debug.textContent = `debug mock: ${state.mockDebug ? "on" : "off"}`;
    els.debug.setAttribute("aria-pressed", String(state.mockDebug));
    els.debug.disabled = state.mode !== "mock";

    els.browserDebug.textContent = `debug navegador: ${state.browserDebug ? "on" : "off"}`;
    els.browserDebug.setAttribute("aria-pressed", String(state.browserDebug));

    els.clear.textContent = state.mode === "browser" ? "limpar logs" : state.mode === "backend" ? "limpar painel" : "limpar mock";
    els.refresh.textContent = state.mode === "browser" ? "reler logs" : "recarregar fonte";

    els.envMode.textContent = meta.env;
    els.kicker.textContent = meta.kicker;
    els.modeTitle.textContent = meta.title;
    els.modeCopy.textContent = meta.copy;
    els.modeStorage.textContent = meta.storage;
    els.footerSource.textContent = meta.footer;
    els.browserDebugState.textContent = state.browserDebug ? "on" : "off";
  }

  function hydrateScreenFilter() {
    const current = state.screenFilter;
    const screens = Array.from(new Set(state.entries.map((entry) => entry.screen))).sort();
    els.screenFilter.innerHTML = '<option value="all">Todas</option>';

    screens.forEach((screen) => {
      const option = document.createElement("option");
      option.value = screen;
      option.textContent = screen;
      els.screenFilter.appendChild(option);
    });

    state.screenFilter = current === "all" || screens.includes(current) ? current : "all";
    els.screenFilter.value = state.screenFilter;
  }

  function renderAll() {
    renderSummary();
    renderRows();
    renderDetail();
  }

  function renderSummary() {
    const total = state.entries.length;
    const ok = state.entries.filter((entry) => entry.status >= 200 && entry.status < 300).length;
    const four = state.entries.filter((entry) => entry.status >= 400 && entry.status < 500).length;
    const five = state.entries.filter((entry) => entry.status >= 500).length;
    const slow = state.entries.filter((entry) => entry.duration >= SLOW_LIMIT_MS).length;
    const timed = state.entries.filter((entry) => entry.duration > 0);
    const avg = timed.length
      ? Math.round(timed.reduce((sum, entry) => sum + entry.duration, 0) / timed.length)
      : 0;
    const lastError = state.entries.filter((entry) => entry.status >= 400 || entry.status === 0).at(-1);

    els.summary.total.textContent = String(total);
    els.summary.ok.textContent = String(ok);
    els.summary["4xx"].textContent = String(four);
    els.summary["5xx"].textContent = String(five);
    els.summary.slow.textContent = String(slow);
    els.summary.avg.textContent = `${avg}ms`;
    els.summary.lastError.textContent = lastError ? `${lastError.status || "NET"} ${lastError.endpoint}` : "none";
  }

  function getVisibleEntries() {
    return state.entries.filter((entry) => {
      if (state.statusFilter === "ok" && !isOk(entry)) return false;
      if (state.statusFilter === "4xx" && !is4xx(entry)) return false;
      if (state.statusFilter === "5xx" && !is5xx(entry)) return false;
      if (state.statusFilter === "slow" && !isSlow(entry)) return false;
      if (state.screenFilter !== "all" && entry.screen !== state.screenFilter) return false;

      if (state.search) {
        const haystack = [
          entry.endpoint,
          entry.url,
          entry.method,
          entry.screen,
          entry.description,
          entry.source,
          String(entry.status),
          JSON.stringify(entry.payload || {}),
          JSON.stringify(entry.response || {}),
          JSON.stringify(entry.error || {})
        ].join(" ").toLowerCase();

        if (!haystack.includes(state.search)) return false;
      }

      return true;
    });
  }

  function renderRows() {
    const rows = getVisibleEntries();
    els.visibleCount.textContent = `${rows.length} visiveis`;

    if (!rows.length) {
      els.rows.innerHTML = '<tr><td class="vfc-empty-table" colspan="7">nenhuma request corresponde aos filtros atuais</td></tr>';
      return;
    }

    els.rows.innerHTML = rows.map((entry) => {
      const selected = entry.id === state.selectedId ? " is-selected" : "";
      const timeClass = isSlow(entry) ? " is-slow" : "";

      return `
        <tr class="${selected}" data-vfc-request-id="${escapeHtml(entry.id)}">
          <td class="vfc-mono">${escapeHtml(entry.time)}</td>
          <td>${escapeHtml(entry.screen)}</td>
          <td><span class="vfc-method">${escapeHtml(entry.method)}</span></td>
          <td><span class="vfc-endpoint">${escapeHtml(entry.endpoint)}</span></td>
          <td><span class="vfc-status ${getStatusClass(entry)}">${formatStatus(entry.status)}</span></td>
          <td><span class="vfc-time${timeClass}">${formatDuration(entry.duration)}</span></td>
          <td>${escapeHtml(entry.description)}</td>
        </tr>
      `;
    }).join("");

    els.rows.querySelectorAll("[data-vfc-request-id]").forEach((row) => {
      row.addEventListener("click", () => {
        state.selectedId = row.dataset.vfcRequestId;
        state.activeTab = "request";
        renderAll();
      });
    });
  }

  function renderDetail() {
    const selected = state.entries.find((entry) => entry.id === state.selectedId);

    if (!selected) {
      els.detail.innerHTML = `
        <div class="vfc-detail-empty">
          <span class="vfc-empty-dot"></span>
          <p>Selecione uma request para inspecionar payload, response e contexto seguro.</p>
        </div>
      `;
      return;
    }

    els.detail.innerHTML = `
      <div class="vfc-detail-head">
        <div class="vfc-detail-title">
          <h2>${escapeHtml(selected.endpoint)}</h2>
          <span>${escapeHtml(selected.screen)} · ${escapeHtml(selected.time)}</span>
        </div>
        <span class="vfc-status ${getStatusClass(selected)}">${formatStatus(selected.status)}</span>
      </div>
      <div class="vfc-chip-row">
        <span class="vfc-chip">${escapeHtml(selected.method)}</span>
        <span class="vfc-chip ${getChipClass(selected)}">${formatDuration(selected.duration)}</span>
        <span class="vfc-chip">${escapeHtml(selected.sourceLabel)}</span>
        <span class="vfc-chip">${state.browserDebug ? "browser debug on" : "browser debug off"}</span>
      </div>
      <div class="vfc-tabs" role="tablist" aria-label="Detalhes da request">
        ${["request", "response", "contexto", "erro"].map((tab) => `
          <button class="vfc-tab ${state.activeTab === tab ? "is-active" : ""}" type="button" data-vfc-tab="${tab}">
            ${tab}
          </button>
        `).join("")}
      </div>
      <div class="vfc-detail-body">
        ${renderTab(selected)}
      </div>
    `;

    els.detail.querySelectorAll("[data-vfc-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        state.activeTab = button.dataset.vfcTab || "request";
        renderDetail();
      });
    });
  }

  function renderTab(entry) {
    if (state.activeTab === "request") {
      return `
        ${renderKv({
          url: entry.url || `${API_BASE_HINT}${entry.endpoint}`,
          metodo: entry.method,
          status: formatStatus(entry.status),
          duracao: formatDuration(entry.duration),
          origem: entry.screen,
          fonte: entry.sourceLabel,
          authorization: state.token ? maskSensitive(`Bearer ${state.token}`) : "ausente"
        })}
        <p class="vfc-code-label">payload enviado</p>
        <pre class="vfc-code">${escapeHtml(formatJson(sanitizePayload(entry.payload || { empty: true })))}</pre>
      `;
    }

    if (state.activeTab === "response") {
      return `
        ${renderKv({
          status: formatStatus(entry.status),
          tipo: entry.status === 0 ? "network" : entry.contentType || "application/json",
          cache: entry.cache || "no-store",
          request_id: entry.id
        })}
        <p class="vfc-code-label">response sanitizado</p>
        <pre class="vfc-code">${escapeHtml(formatJson(sanitizePayload(entry.response || { ok: false, network: "sem resposta HTTP" })))}</pre>
      `;
    }

    if (state.activeTab === "contexto") {
      return `
        ${renderKv({
          usuario: state.user.nome || state.user.email || "Usuario",
          role: state.user.role || "sem role",
          modo: getModeMeta(state.mode).title,
          source: entry.sourceLabel,
          storage: entry.storage || getModeMeta(state.mode).storage,
          api_base: API_BASE_HINT,
          token: state.token ? maskSensitive(`Bearer ${state.token}`) : "ausente",
          origem: entry.screen
        })}
        <p class="vfc-code-label">contexto seguro</p>
        <pre class="vfc-code">${escapeHtml(formatJson(sanitizePayload({
          user: {
            id: state.user.id || "mock-user",
            nome: state.user.nome || state.user.email || "Usuario",
            role: state.user.role || "sem role"
          },
          screen: entry.screen,
          routeGuard: entry.endpoint.includes("/admin") ? "admin-only" : "authenticated",
          browserDebug: state.browserDebug ? "enabled" : "disabled",
          token: state.token ? "presente" : "ausente",
          tokenMasked: state.token ? maskSensitive(`Bearer ${state.token}`) : "ausente",
          tokenFull: "nunca exibir token completo"
        })))}</pre>
      `;
    }

    return `
      ${renderKv({
        tipo: entry.error?.type || "none",
        severidade: getErrorSeverity(entry),
        ultimo_erro: entry.error?.message || "sem erro",
        acao_sugerida: entry.error?.action || entry.error?.hint || "nenhuma"
      })}
      <p class="vfc-code-label">erro formatado</p>
      <pre class="vfc-code ${entry.error ? "vfc-error-box" : ""}">${escapeHtml(formatJson(sanitizePayload(entry.error || { ok: true, message: "request sem erro" })))}</pre>
    `;
  }

  function renderKv(map) {
    return `<dl class="vfc-kv-grid">${
      Object.entries(map).map(([key, value]) => `
        <dt>${escapeHtml(key)}</dt>
        <dd>${escapeHtml(String(value))}</dd>
      `).join("")
    }</dl>`;
  }

  function loadMockData() {
    return [
      {
        id: "req-001",
        time: "09:41:03",
        screen: "bases.html",
        method: "GET",
        endpoint: "/bases",
        status: 200,
        duration: 84,
        description: "bases carregadas",
        payload: null,
        response: {
          ok: true,
          bases: [
            { id: 41, slug: "loja-meli-principal", nome: "Loja ML Principal", ativo: true, updated_at: "2026-06-08T12:34:01.000Z" },
            { id: 42, slug: "loja-shopee-outlet", nome: "Loja Shopee Outlet", ativo: true, updated_at: "2026-05-14T18:03:18.000Z" }
          ]
        }
      },
      {
        id: "req-002",
        time: "09:41:04",
        screen: "bases.html",
        method: "GET",
        endpoint: "/base-vinculos",
        status: 200,
        duration: 126,
        description: "vinculos + sugestoes",
        payload: null,
        response: {
          ok: true,
          bases: [
            {
              id: 41,
              slug: "loja-meli-principal",
              vinculo: { cliente_slug: "alpha-store", cliente_nome: "Alpha Store", marketplace: "meli", origem: "manual" },
              sugestao: null
            },
            {
              id: 42,
              slug: "loja-shopee-outlet",
              vinculo: null,
              sugestao: { cliente_slug: "outlet-sp", marketplace: "shopee", confianca: 76 }
            }
          ]
        }
      },
      {
        id: "req-003",
        time: "09:42:18",
        screen: "bases.html",
        method: "POST",
        endpoint: "/importar-base",
        status: 201,
        duration: 612,
        description: "base importada",
        payload: {
          formData: true,
          arquivo: "custos-junho-alpha.xlsx",
          baseSlug: "loja-meli-principal",
          rows: 1842
        },
        response: {
          ok: true,
          mensagem: "Base importada com sucesso",
          base: { slug: "loja-meli-principal", custos_importados: 1842, custos_atualizados: 391 }
        }
      },
      {
        id: "req-004",
        time: "09:45:50",
        screen: "relatorios.html",
        method: "GET",
        endpoint: "/automacoes/relatorios",
        status: 200,
        duration: 173,
        description: "relatorios recentes",
        payload: null,
        response: {
          ok: true,
          total: 3,
          relatorios: [
            { id: 882, cliente_slug: "alpha-store", status: "concluido", itens_criticos: 12, itens_sem_base: 44, mc_media: 0.183 },
            { id: 881, cliente_slug: "beta-home", status: "concluido", itens_criticos: 0, itens_sem_base: 3, mc_media: 0.216 }
          ]
        }
      },
      {
        id: "req-005",
        time: "09:47:12",
        screen: "automacoes.html",
        method: "POST",
        endpoint: "/automacoes/diagnostico-completo/start",
        status: 200,
        duration: 2400,
        description: "diagnostico iniciado, lento",
        payload: {
          clienteSlug: "alpha-store",
          baseSlug: "loja-meli-principal",
          margemAlvo: 0.18,
          marketplace: "meli"
        },
        response: {
          ok: true,
          id: 883,
          status: "processando",
          estimativa: "2-4 min"
        }
      },
      {
        id: "req-006",
        time: "09:48:19",
        screen: "automacoes.html",
        method: "GET",
        endpoint: "/automacoes/diagnostico-completo/883",
        status: 200,
        duration: 311,
        description: "polling diagnostico",
        payload: null,
        response: {
          ok: true,
          relatorio: {
            id: 883,
            status: "processando",
            progresso: 62,
            processados: 392,
            total: 628
          }
        }
      },
      {
        id: "req-007",
        time: "09:49:02",
        screen: "dashboard.html",
        method: "GET",
        endpoint: "/admin/ml-tokens",
        status: 403,
        duration: 68,
        description: "sem permissao admin",
        payload: {
          headers: {
            Authorization: "Bearer mock-token",
            "x-api-key": "mock-api-key"
          }
        },
        response: {
          ok: false,
          erro: "Acesso restrito a administradores."
        },
        error: {
          type: "permission",
          message: "Usuario membro tentou acessar rota admin-only.",
          hint: "Ocultar bloco sensivel ou degradar para score parcial."
        }
      },
      {
        id: "req-008",
        time: "09:50:44",
        screen: "dashboard.html",
        method: "GET",
        endpoint: "/operacao/base-cobertura",
        status: 401,
        duration: 42,
        description: "token invalido",
        payload: null,
        response: {
          ok: false,
          erro: "Token invalido ou expirado"
        },
        error: {
          type: "auth",
          message: "JWT expirado ou ausente no localStorage.",
          action: "Limpar sessao e redirecionar para index.html."
        }
      },
      {
        id: "req-009",
        time: "09:52:11",
        screen: "clickup-executivo.html",
        method: "GET",
        endpoint: "/api/clickup/executivo/resumo",
        status: 500,
        duration: 934,
        description: "erro ClickUp upstream",
        payload: null,
        response: {
          ok: false,
          motivo: "Erro ao carregar resumo executivo."
        },
        error: {
          type: "server",
          message: "ClickUp API respondeu 502 durante agregacao.",
          requestId: "mock-cc-9f7a"
        }
      },
      {
        id: "req-010",
        time: "09:53:27",
        screen: "financeiro.html",
        method: "POST",
        endpoint: "/fechamentos/financeiro",
        status: 200,
        duration: 1480,
        description: "fechamento processado",
        payload: {
          formData: true,
          sales: "vendas-ml-maio.xlsx",
          costs: "custos-maio.xlsx",
          ordersAll: "orders-all-shopee.xlsx",
          password: "mock-password"
        },
        response: {
          ok: true,
          resumo: {
            meli: { pedidos: 481, divergencias: 7 },
            shopee: { pedidos: 112, divergencias: 2 },
            totalLiquido: 94732.18
          }
        }
      },
      {
        id: "req-011",
        time: "09:54:38",
        screen: "metricas.html",
        method: "GET",
        endpoint: "/metricas/resumo?clienteSlug=alpha-store&dateFrom=2026-06-01&dateTo=2026-06-08",
        status: 0,
        duration: 0,
        description: "network error",
        payload: null,
        response: null,
        error: {
          type: "network",
          message: "Failed to fetch",
          hint: "Verificar conexao, CORS, Render cold start ou DNS."
        }
      }
    ];
  }

  function loadBrowserLogs() {
    const fromClient = window.VFDebugClient?.getLogs?.();
    const clientLogs = Array.isArray(fromClient)
      ? fromClient.map((entry) => ({ ...entry, storage: entry.storage || "VFDebugClient/sessionStorage" }))
      : [];

    const sessionLogs = readStoredLogs(sessionStorage, "sessionStorage");
    const localLogs = readStoredLogs(localStorage, "localStorage");
    const seen = new Set();

    return clientLogs.concat(sessionLogs, localLogs)
      .filter((entry) => {
        const key = String(entry.id || `${entry.timestamp || ""}-${entry.endpoint || ""}-${entry.duration || ""}`);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => String(a.timestamp || a.time || "").localeCompare(String(b.timestamp || b.time || "")));
  }

  async function loadBackendData() {
    // TODO: integrar futuramente com endpoint interno de observabilidade.
    // Esta funcao deve receber apenas dados ja sanitizados no backend.
    // Nao chamar fetch aqui enquanto o endpoint nao existir.
    return [];
  }

  function normalizeEntry(entry) {
    const endpoint = sanitizeUrl(entry.endpoint || endpointFromUrl(entry.url) || "/");
    const url = sanitizeUrl(entry.url || `${API_BASE_HINT}${endpoint}`);
    const source = String(entry.source || state.mode || "mock");
    const status = Number(entry.status || 0);
    const payload = entry.payload !== undefined ? entry.payload : entry.requestPayload;
    const response = entry.response !== undefined ? entry.response : entry.responseBody;
    const error = entry.error || (status >= 400 || status === 0 ? { type: "http", message: entry.description || "request com erro" } : null);

    return {
      id: String(entry.id || cryptoRandomId()),
      timestamp: String(entry.timestamp || ""),
      time: String(entry.time || formatClockFromTimestamp(entry.timestamp) || formatClock(new Date())),
      screen: String(entry.screen || entry.page || "portal"),
      method: String(entry.method || "GET").toUpperCase(),
      endpoint,
      url,
      status,
      duration: Number(entry.duration || entry.durationMs || 0),
      description: String(entry.description || buildDescription(status, endpoint)),
      payload: sanitizePayload(payload || null),
      response: sanitizePayload(response || null),
      error: sanitizePayload(error || null),
      source,
      sourceLabel: getSourceLabel(source),
      storage: String(entry.storage || ""),
      contentType: String(entry.contentType || entry.responseContentType || ""),
      cache: String(entry.cache || "")
    };
  }

  function readStoredLogs(storage, label) {
    try {
      const parsed = JSON.parse(storage.getItem(DEBUG_LOG_KEY) || "[]");
      return Array.isArray(parsed)
        ? parsed.map((entry) => ({ ...entry, storage: entry.storage || label }))
        : [];
    } catch {
      return [];
    }
  }

  function clearDebugLogs() {
    try {
      sessionStorage.removeItem(DEBUG_LOG_KEY);
      localStorage.removeItem(DEBUG_LOG_KEY);
      window.VFDebugClient?.clearLogs?.();
    } catch {
      // A limpeza de logs nunca deve interferir na tela.
    }
  }

  function ensureBrowserDebugClientLoaded() {
    if (window.VFDebugClient) return;
    if (document.querySelector('script[data-vf-debug-client="true"]')) return;

    try {
      const script = document.createElement("script");
      script.src = "vf-debug-client.js";
      script.async = true;
      script.dataset.vfDebugClient = "true";
      document.head.appendChild(script);
    } catch {
      // Debug eh auxiliar; falhas de carregamento nao podem quebrar o Portal.
    }
  }

  function setBrowserDebugEnabled(enabled) {
    if (enabled && !isAdminUser()) {
      localStorage.setItem(DEBUG_ENABLED_KEY, "false");
      return;
    }
    localStorage.setItem(DEBUG_ENABLED_KEY, enabled ? "true" : "false");
    if (enabled) {
      window.VFDebugClient?.enable?.();
    } else {
      window.VFDebugClient?.disable?.();
    }
  }

  function isBrowserDebugEnabled() {
    return isAdminUser() && localStorage.getItem(DEBUG_ENABLED_KEY) === "true";
  }

  function isAdminUser() {
    const role = String(readUserSafe().role || "").toLowerCase();
    return role === "admin";
  }

  function resolveInitialMode() {
    const stored = localStorage.getItem(SOURCE_MODE_KEY);
    return VALID_MODES.includes(stored) ? stored : CONTROL_CENTER_MODE;
  }

  function getModeMeta(mode) {
    if (mode === "browser") {
      return {
        env: "browser logs",
        kicker: "browser logs · sessionStorage",
        title: "Fonte browser logs",
        copy: state.browserDebug
          ? "Lendo requests reais capturadas pelo navegador depois que o debug foi ligado."
          : "Debug do navegador desligado. Logs antigos ainda podem aparecer ate serem limpos.",
        storage: "sessionStorage/localStorage",
        footer: "browser logs reais"
      };
    }

    if (mode === "backend") {
      return {
        env: "backend futuro",
        kicker: "backend futuro · TODO",
        title: "Fonte backend futuro",
        copy: "Reserva tecnica para observabilidade do backend. Nenhuma chamada real e feita nesta etapa.",
        storage: "sem endpoint nesta fase",
        footer: "backend TODO"
      };
    }

    return {
      env: "mock/frontend",
      kicker: "mock/frontend · dados simulados",
      title: "Fonte mock",
      copy: "Dados simulados para validar filtros, detalhes e sanitizacao antes das proximas migracoes.",
      storage: "memoria local da tela",
      footer: "mock preview"
    };
  }

  function getSourceLabel(source) {
    if (source === "browser") return "browser log";
    if (source === "backend") return "backend futuro";
    return "mock";
  }

  function sanitizePayload(data, seen = new WeakSet()) {
    if (data === null || data === undefined) return data;

    if (typeof data === "string") {
      return looksSensitiveValue(data) ? maskSensitive(data) : truncateLongText(data);
    }

    if (typeof data === "number" || typeof data === "boolean") return data;

    if (typeof FormData !== "undefined" && data instanceof FormData) {
      const form = {};
      data.forEach((value, key) => {
        form[key] = summarizeBodyValue(value);
      });
      return sanitizePayload(form, seen);
    }

    if (Array.isArray(data)) {
      return data.map((item) => sanitizePayload(item, seen));
    }

    if (typeof data === "object") {
      if (seen.has(data)) return "[Circular]";
      seen.add(data);

      if (data instanceof Date) return data.toISOString();

      return Object.entries(data).reduce((acc, [key, value]) => {
        acc[key] = isSensitiveKey(key) ? maskSensitive(value) : sanitizePayload(value, seen);
        return acc;
      }, {});
    }

    return String(data);
  }

  function isSensitiveKey(key) {
    const normalized = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
  }

  function maskSensitive(value) {
    const text = String(value || "");
    if (!text) return "ausente";

    if (/^Bearer\s+/i.test(text)) {
      const token = text.replace(/^Bearer\s+/i, "");
      if (!token) return "Bearer ausente";
      return `Bearer ${token.slice(0, 3)}...****`;
    }

    if (text.length <= 8) return "****";
    return `${text.slice(0, 4)}...****`;
  }

  function looksSensitiveValue(value) {
    const text = String(value || "").trim();
    if (/^Bearer\s+/i.test(text)) return true;
    if (/^eyJ[a-zA-Z0-9_-]+\./.test(text)) return true;
    if (/^vf_[a-f0-9]{16,}$/i.test(text)) return true;
    if (/^(sk|pk|ghp|glpat)_[a-zA-Z0-9_-]{16,}$/i.test(text)) return true;
    return text.length > 80 && /^[a-zA-Z0-9._-]+$/.test(text);
  }

  function sanitizeUrl(value) {
    const raw = String(value || "");
    if (!raw) return "";

    try {
      const url = new URL(raw, window.location.href);
      url.searchParams.forEach((paramValue, key) => {
        if (isSensitiveKey(key) || looksSensitiveValue(paramValue)) {
          url.searchParams.set(key, maskSensitive(paramValue));
        }
      });

      url.pathname = url.pathname.split("/").map((segment) => {
        const decoded = safeDecode(segment);
        return looksSensitiveValue(decoded) ? encodeURIComponent(maskSensitive(decoded)) : segment;
      }).join("/");

      if (raw.startsWith("http")) return url.toString();
      return `${url.pathname}${url.search}`;
    } catch {
      return looksSensitiveValue(raw) ? maskSensitive(raw) : raw;
    }
  }

  function endpointFromUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(String(value), window.location.href);
      return `${url.pathname}${url.search}`;
    } catch {
      return String(value);
    }
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function truncateLongText(value) {
    const text = String(value || "");
    return text.length > 4000 ? `${text.slice(0, 4000)}...[truncated]` : text;
  }

  function summarizeBodyValue(value) {
    if (typeof File !== "undefined" && value instanceof File) {
      return { file: value.name, size: value.size, type: value.type || "application/octet-stream" };
    }
    return value;
  }

  function readUserSafe() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }

  function buildDescription(status, endpoint) {
    if (status === 0) return "network error";
    if (status >= 500) return "erro servidor";
    if (status >= 400) return "erro cliente/autorizacao";
    if (status >= 200 && status < 300) return "request ok";
    return endpoint || "request";
  }

  function getStatusClass(entry) {
    if (entry.status === 0) return "vfc-status--network";
    if (is5xx(entry)) return "vfc-status--error";
    if (is4xx(entry)) return "vfc-status--warn";
    return "vfc-status--ok";
  }

  function getChipClass(entry) {
    if (isSlow(entry)) return "vfc-chip--slow";
    if (is5xx(entry) || entry.status === 0) return "vfc-chip--error";
    if (is4xx(entry)) return "vfc-chip--warn";
    return "vfc-chip--ok";
  }

  function getErrorSeverity(entry) {
    if (entry.status === 0) return "network";
    if (is5xx(entry)) return "alta";
    if (is4xx(entry)) return "media";
    return "none";
  }

  function isOk(entry) {
    return entry.status >= 200 && entry.status < 300;
  }

  function is4xx(entry) {
    return entry.status >= 400 && entry.status < 500;
  }

  function is5xx(entry) {
    return entry.status >= 500;
  }

  function isSlow(entry) {
    return entry.duration >= SLOW_LIMIT_MS;
  }

  function formatStatus(status) {
    return status === 0 ? "NETWORK" : String(status);
  }

  function formatDuration(duration) {
    return duration ? `${duration}ms` : "n/a";
  }

  function formatJson(value) {
    return JSON.stringify(value, null, 2);
  }

  function formatClockFromTimestamp(timestamp) {
    if (!timestamp) return "";
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? "" : formatClock(date);
  }

  function formatClock(date) {
    return [
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
      String(date.getSeconds()).padStart(2, "0")
    ].join(":");
  }

  function cryptoRandomId() {
    if (window.crypto?.randomUUID) return `req-${window.crypto.randomUUID()}`;
    return `req-${Math.random().toString(16).slice(2, 10)}`;
  }

  function sanitizeText(value) {
    return String(value || "").trim() || "-";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
