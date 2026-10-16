/*
 * Central de Margem — cockpit de precificação em JavaScript puro.
 *
 * Ordem de leitura da tela:
 *   RESUMO       compacto (margem, receita, lucro, prejuízo…) + saúde dos dados recolhida
 *   TABELA       o centro da operação (visão Operacional × Composição)
 *   DIVERGÊNCIAS resumo recolhido; a fila técnica completa abre sob demanda
 *   OPORTUNIDADES fonte bulk persistida (nunca promoções por linha)
 *   DRAWER       resumo fixo + PRECIFICAR · EVIDÊNCIAS · HISTÓRICO
 *
 * Todo número vem de `central-margem-api.js`, que é o contrato único; o
 * cálculo de preço/promoção é do BACKEND (camada segura /precificacao).
 * Nenhuma fórmula financeira mora aqui.
 */
(function (root) {
  "use strict";

  var contract = root.VFCentralMargemApi;
  if (!contract) return;

  var api = root.__VF_CENTRAL_MARGEM_API_CLIENT__ || contract.createClient();
  // Linha de fonte das promoções — a MESMA na aba Promoções e na Bancada (o servidor devolve o mesmo
  // `fontePromocoes` nas duas respostas). Ausente (servidor antigo), as telas usam o texto de antes.
  var promoFonte = root.VFCentralMargemPromoFonte || null;

  var CONFIDENCE_META = {
    HIGH: { label: "Alta", className: "is-success" },
    MEDIUM: { label: "Média", className: "is-warning" },
    LOW: { label: "Baixa", className: "is-danger" },
    UNKNOWN: { label: "Desconhecida", className: "is-neutral" },
  };

  var PRESET_COPY = {
    projected: "Preço, comissão e frete previstos do Mercado Livre + custo, imposto e taxa fixa da Base. Responde “qual é a margem do anúncio agora?”.",
    realized: "Preço médio vendido + comissão e frete realizados dos pedidos do período. Custo e imposto são os que a Base tinha no momento de cada venda (gravados pela Central de Vendas), não a Base de hoje. Taxa fixa não tem histórico: fica indisponível e não é descontada.",
    custom: "Uma ou mais fontes foram alteradas manualmente no cabeçalho. A composição exibida não corresponde a nenhum preset.",
  };

  var SOURCE_STATE_META = {
    OK: { label: "OK", className: "is-ok" },
    PARTIAL: { label: "Parcial", className: "is-warn" },
    PENDING: { label: "Pendente", className: "is-off" },
    UNAVAILABLE: { label: "Indisponível", className: "is-off" },
  };

  var PRESET_LABELS = { projected: "Projetado", realized: "Realizado", custom: "Personalizado" };

  var DRAWER_TABS = ["pricing", "evidence", "history"];
  // Nomes antigos das abas (atalhos/links antigos) caem na aba nova equivalente.
  var DRAWER_TAB_ALIASES = { summary: "pricing", scenario: "pricing", audit: "history" };

  var state = {
    token: null,
    // F2.3 — cliente vem do Shell V3 (aplicarContextoDoShell). getWorkspace
    // não recebe clienteContaId (é client-level, não account-level — §14
    // do MASTER_SPEC), então nada aqui finge precisão por conta. marketplace
    // segue fixo em "meli": o próprio renderContext() já escrevia "Mercado
    // Livre" hardcoded antes desta unidade — o Motor de Margem só resolve
    // bases MELI (confirmado em contextoPrecificacaoService).
    client: null,
    marketplace: "meli",
    search: "",
    financial: "",
    integrity: "",
    listingStatus: "",
    selection: contract.clonePreset("projected"),
    preset: "projected",
    criticalOnly: false,
    // Paginação VISUAL apenas: fatia o array já carregado no workspace.
    // Nunca dispara nova leitura — "Todos carregados" usa a string "all".
    visiblePageSize: 50,
    visiblePage: 1,
    loading: false,
    data: null,
    error: null,
    errorCode: null,
    searchTimer: null,
    requestSequence: 0,
    abortController: null,
    selectedItemId: null,
    drawerTab: "pricing",
    evidenceVariable: "price",
    scenario: null,
    scenarioItemId: null,
    previousFocus: null,

    // Leitura persistida (Margin Snapshot). O backend decide o modo em
    // /snapshot/resumo: "legacy" = workspace ao vivo (comportamento de
    // sempre); "snapshot" = projetada lida do banco, paginada/filtrada no
    // servidor, por CONTA (clienteContaId do Shell).
    mode: null,
    contaId: null,
    awaitingAccount: false,
    snapshot: null,
    serverPage: 1,
    serverLimit: 50,
    refreshRun: null,
    refreshError: null,
    pollTimer: null,
    pollSequence: 0,

    // Período do REALIZADO na leitura persistida: null = "últimos 30 dias
    // até ontem" (padrão do servidor); "YYYY-MM" = o parâmetro global
    // ?periodo= do Shell (vf-context), nunca um store novo.
    periodParam: null,
    realizado: null,
    realizadoError: null,
    realizadoLoading: false,
    realizadoSequence: 0,

    // Visão da tabela: "operational" (decisão) × "composition" (fontes).
    view: "operational",
    healthOpen: false,
    divergencesOpen: false,

    // Drawer / precificação. `drawerSeq` muda a cada abertura/troca de item
    // ou de contexto: resposta assíncrona de outro item/conta é descartada.
    drawerSeq: 0,
    pricing: null,
    promos: null,
    history: null,
    confirm: null,

    // Oportunidades da conta (uma leitura por conta/período).
    opps: null,
    oppsSequence: 0,
    oppsPollTimer: null,
    oppsPolls: 0,
    // Página pedida ao servidor (a paginação acontece no banco).
    oppsPage: 1,
    oppsFilters: { veredito: "", tipo: "" },
    oppsTipos: [],
    bancada: null,
    promoSummary: null,
    promoSummarySeq: 0,
    promoTop: {},
    oppsLive: "idle",
    promoExpanded: {},
    promoDetail: {},
    pendingPromoId: null,
    pendingReview: false,
  };

  // Intervalo moderado de polling do run. O override existe só para o
  // smoke test de UI (mesmo padrão de __VF_CENTRAL_MARGEM_API_CLIENT__).
  var SNAPSHOT_POLL_MS = Number(root.__VF_CENTRAL_MARGEM_POLL_MS__) || 4000;
  // Pós-escrita: acompanha o refresh do snapshot do item aplicado.
  var POST_WRITE_POLL_MS = Number(root.__VF_CENTRAL_MARGEM_POST_WRITE_POLL_MS__) || 2500;

  var refs = {};

  function el(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatMoney(value, signed) {
    var number = contract.numberOrNull(value);
    if (number === null) return null;
    var prefix = signed && number > 0 ? "+" : "";
    return prefix + number.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }

  function formatPercent(value, signed) {
    var number = contract.numberOrNull(value);
    if (number === null) return null;
    var prefix = signed && number > 0 ? "+" : "";
    return prefix + (number * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + "%";
  }

  function formatPp(value) {
    var number = contract.numberOrNull(value);
    if (number === null) return null;
    return (number > 0 ? "+" : "") + number.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + " pp";
  }

  function formatByVariable(variableKey, value) {
    var meta = contract.VARIABLE_META[variableKey];
    return meta && meta.format === "percent" ? formatPercent(value) : formatMoney(value);
  }

  /**
   * Rótulo de cobertura do workspace: "107 de 107 carregados" (completa) ou
   * "200 de 350 carregados" (parcial — nunca some o total real do catálogo).
   */
  function coverageLabel(coverage) {
    if (!coverage) return "—";
    var loaded = coverage.loaded || 0;
    var total = coverage.total || loaded;
    return loaded + " de " + total + " carregados";
  }

  function formatDateTime(value) {
    if (!value) return null;
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleDateString("pt-BR") + " às " + date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  /** Ausência é informação: nunca vira zero, nunca vira traço mudo. */
  function unavailable(label, title) {
    return '<span class="cm-unavailable"' + (title ? ' title="' + escapeHtml(title) + '"' : "") +
      ">" + escapeHtml(label || "Indisponível") +
      (title ? '<span class="cm-info-mark" aria-hidden="true">ⓘ</span>' : "") + "</span>";
  }

  /*
   * Explica POR QUE uma célula está indisponível: fonte esperada, situação e
   * próxima ação — nunca inventa um motivo que o backend não informou. Sem
   * causa específica, cai no texto genérico e honesto do pedido.
   */
  var SOURCE_EXPECTATION_LABEL = {
    MELI_API: "Mercado Livre API",
    MELI_ORDER: "Pedido ML / shipment",
    VENFORCE_BASE: "Base VenForce",
    VENFORCE_BASE_HIST: "Base VenForce no momento da venda (Central de Vendas)",
    MERCADO_PAGO: "Mercado Pago",
    EXTENSION_DOM: "Extensão VenForce",
  };

  function explainUnavailable(variableKey, source) {
    var fonte = SOURCE_EXPECTATION_LABEL[source] || contract.sourceLabel(source);
    var linhas = ["Fonte esperada: " + fonte];
    if (source === "MERCADO_PAGO") {
      linhas.push("Situação: integração ainda não disponível.");
    } else if (source === "EXTENSION_DOM") {
      linhas.push("Situação: canal de ingestão ainda não disponível.");
    } else if (source === "VENFORCE_BASE_HIST" && variableKey === "fixedFee") {
      linhas.push("Situação: a Central de Vendas não guarda taxa fixa histórica — o realizado não desconta taxa fixa.");
      linhas.push("A taxa fixa atual nunca é usada no lugar do histórico.");
    } else if (source === "VENFORCE_BASE_HIST") {
      linhas.push("Situação: sem venda no período, ou as vendas não tinham " + variableLabel(variableKey) + " na Base quando foram sincronizadas.");
      linhas.push("A Base de hoje nunca substitui o valor da venda.");
    } else if (source === "VENFORCE_BASE") {
      linhas.push("Situação: nenhum " + variableLabel(variableKey) + " encontrado para este MLB na Base.");
      linhas.push("Ação: Ver na Base.");
    } else if (source === "MELI_API") {
      linhas.push("Situação: nenhuma evidência desta fonte foi retornada nesta leitura.");
      linhas.push("Ação: verificar conexão/sincronização ML.");
    } else if (source === "MELI_ORDER") {
      linhas.push("Situação: nenhuma venda/evidência realizada no período.");
    } else {
      linhas.push("Situação: nenhuma evidência desta fonte foi retornada nesta leitura.");
    }
    return linhas.join("\n");
  }

  function statusTag(entry) {
    if (!entry) return unavailable("Indisponível");
    return '<span class="vf-status ' + entry.tone + '" title="' + escapeHtml(entry.reason || "") + '">' + escapeHtml(entry.label) + "</span>";
  }

  function stateHtml(type, title, description, action) {
    if (type === "loading") {
      return '<div class="vf-loading-state" role="status"><span class="vf-spinner" aria-hidden="true"></span><span>' + escapeHtml(title) + "</span></div>";
    }
    var danger = type === "error";
    return '<div class="vf-empty"' + (danger ? ' role="alert"' : "") + ">" +
      '<div class="vf-empty__icon ' + (danger ? "is-danger" : "") + '" aria-hidden="true">' + (danger ? "!" : "◇") + "</div>" +
      '<p class="vf-empty__title">' + escapeHtml(title) + "</p>" +
      (description ? '<p class="vf-empty__description">' + escapeHtml(description) + "</p>" : "") +
      (action || "") + "</div>";
  }

  function toast(message, type) {
    // Com o vf-ui.js, o aviso entra na pilha única da V2 (erro vira alert).
    if (root.VF && typeof root.VF.toast === "function") {
      root.VF.toast({ title: message, tone: String(type || "is-info").replace(/^is-/, "") });
      return;
    }
    var node = document.createElement("div");
    node.className = "vf-toast " + (type || "is-info");
    node.setAttribute("role", "status");
    node.innerHTML = '<div class="vf-toast__content"><p class="vf-toast__description">' + escapeHtml(message) + "</p></div>";
    refs.toasts.appendChild(node);
    root.setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 3600);
  }

  function cacheRefs() {
    refs.search = el("cm-search");
    refs.refresh = el("cm-refresh");
    refs.updated = el("cm-updated");
    refs.contextMeta = el("cm-context-meta");
    refs.monitoredTag = el("cm-monitored-tag");
    refs.sourceTag = el("cm-source-tag");
    refs.pageState = el("cm-page-state");
    refs.presets = el("cm-presets");
    refs.modeCopy = el("cm-mode-copy");
    refs.sourceStrip = el("cm-source-strip");
    refs.openSources = el("cm-open-sources");
    refs.sourcesOverlay = el("cm-sources-overlay");
    refs.sourcesClose = el("cm-sources-close");
    refs.sourcesBody = el("cm-sources-body");
    refs.kpisFinancial = el("cm-kpis-financial");
    refs.kpisIntegrity = el("cm-kpis-integrity");
    refs.listingSummary = el("cm-listing-summary");
    refs.kpisListing = el("cm-kpis-listing");
    refs.summaryScope = el("cm-summary-scope");
    refs.restoreSources = el("cm-restore-sources");
    refs.financialFilter = el("cm-financial-filter");
    refs.integrityFilter = el("cm-integrity-filter");
    refs.listingStatusFilterWrap = el("cm-listing-status-filter-wrap");
    refs.listingStatusFilter = el("cm-listing-status-filter");
    refs.activeFilters = el("cm-active-filters");
    refs.resultCount = el("cm-result-count");
    refs.tableHost = el("cm-table-host");
    refs.pagination = el("cm-pagination");
    refs.criticalOnly = el("cm-critical-only");
    refs.divergenceCount = el("cm-divergence-count");
    refs.divergences = el("cm-divergences-host");
    refs.drawer = el("cm-drawer");
    refs.drawerBackdrop = el("cm-drawer-backdrop");
    refs.drawerTitle = el("cm-drawer-title");
    refs.drawerMeta = el("cm-drawer-meta");
    refs.drawerTabs = el("cm-drawer-tabs");
    refs.drawerBody = el("cm-drawer-body");
    refs.drawerPrev = el("cm-drawer-prev");
    refs.drawerNext = el("cm-drawer-next");
    refs.drawerPosition = el("cm-drawer-position");
    refs.toasts = el("cm-toasts");
    refs.topContext = el("cm-top-context");
    refs.kpisTop = el("cm-kpis-top");
    refs.topRealized = el("cm-top-realized");
    refs.summaryLine = el("cm-summary-line");
    refs.healthToggle = el("cm-health-toggle");
    refs.health = el("cm-health");
    refs.healthDot = el("cm-health-dot");
    refs.healthCount = el("cm-health-count");
    refs.view = el("cm-view");
    refs.divergencesSection = el("cm-divergences");
    refs.compbar = el("cm-compbar");
    refs.divergencesToggle = el("cm-divergences-toggle");
    refs.divergencesBody = el("cm-divergences-body");
    refs.promos = el("cm-promos");
    refs.promosLive = el("cm-promos-live");
    refs.promoVeredito = el("cm-promo-veredito");
    refs.promoTipo = el("cm-promo-tipo");
    refs.sheetToolbar = el("cm-sheet-toolbar");
    refs.oppsHost = el("cm-opps-host");
    refs.oppsMeta = el("cm-opps-meta");
    refs.drawerSummary = el("cm-drawer-summary");
    refs.healthIssues = el("cm-health-issues");
    refs.confirmOverlay = el("cm-confirm-overlay");
    refs.confirmBody = el("cm-confirm-body");
    refs.confirmApply = el("cm-confirm-apply");
    refs.periodWrap = el("cm-period-wrap");
    refs.period = el("cm-period");
    refs.realized = el("cm-realized");
    refs.realizedPeriod = el("cm-realized-period");
    refs.realizedFresh = el("cm-realized-fresh");
    refs.kpisRealized = el("cm-kpis-realized");
    refs.realizedNotes = el("cm-realized-notes");
  }

  // ---------------------------------------------------------------------------
  // Eventos
  // ---------------------------------------------------------------------------

  function bindEvents() {
    // F2.3 — Cliente/Marketplace não são mais seletores locais: o contexto
    // vem do Shell V3 (aplicarContextoDoShell(), assinado via evento
    // 'vf:context' no fim do arquivo).

    // Período do realizado: relê a página e o realizado da conta. O
    // projetado (snapshot) NÃO é recalculado — nenhum refresh é pedido.
    if (refs.period) {
      refs.period.addEventListener("change", function () {
        var valor = refs.period.value || null;
        if (valor === state.periodParam) return;
        state.periodParam = valor;
        var ctx = root.VF && root.VF.context;
        if (ctx && typeof ctx.setPeriodoParam === "function") ctx.setPeriodoParam(valor);
        if (!isSnapshotMode()) return;
        state.serverPage = 1;
        state.oppsPage = 1;
        loadSnapshotPage();
        loadRealizado();
        loadPromoSummary();
        if (state.view === "promotions") loadOpportunities();
      });
    }

    // Modo legado: busca PURAMENTE local sobre o workspace carregado.
    // Modo persistido: a busca vai ao servidor (debounce), página 1.
    refs.search.addEventListener("input", function () {
      state.search = refs.search.value.trim();
      state.visiblePage = 1;
      if (state.searchTimer) root.clearTimeout(state.searchTimer);
      state.searchTimer = root.setTimeout(function () {
        if (isSnapshotMode()) {
          state.serverPage = 1;
          loadSnapshotPage();
          return;
        }
        renderSummary();
        renderSheet();
        renderDivergences();
      }, isSnapshotMode() ? 300 : 150);
    });

    refs.refresh.addEventListener("click", function () {
      if (!state.client) { renderAll(); return; }
      // Persistido: "Atualizar leitura" enfileira o recálculo em background
      // (202) — nunca congela a tela esperando o cálculo.
      if (isSnapshotMode()) { requestSnapshotRefresh(); return; }
      loadCentral(true);
    });

    refs.presets.addEventListener("click", function (event) {
      var button = event.target.closest("[data-preset]");
      if (!button) return;
      applyPreset(button.getAttribute("data-preset"));
    });

    refs.restoreSources.addEventListener("click", function () { applyPreset("projected"); });

    refs.openSources.addEventListener("click", openSourcesPanel);
    refs.sourcesClose.addEventListener("click", closeSourcesPanel);
    refs.sourcesOverlay.addEventListener("click", function (event) {
      if (event.target === refs.sourcesOverlay) closeSourcesPanel();
    });

    refs.financialFilter.addEventListener("change", function () {
      state.financial = refs.financialFilter.value;
      onFiltersChanged();
    });

    refs.integrityFilter.addEventListener("change", function () {
      state.integrity = refs.integrityFilter.value;
      onFiltersChanged();
    });

    refs.listingStatusFilter.addEventListener("change", function () {
      state.listingStatus = refs.listingStatusFilter.value;
      onFiltersChanged();
    });

    refs.activeFilters.addEventListener("click", function (event) {
      var button = event.target.closest("[data-clear-filter]");
      if (!button) return;
      var target = button.getAttribute("data-clear-filter");
      if (target === "financial") { state.financial = ""; refs.financialFilter.value = ""; }
      if (target === "integrity") { state.integrity = ""; refs.integrityFilter.value = ""; }
      if (target === "listingStatus") { state.listingStatus = ""; refs.listingStatusFilter.value = ""; }
      onFiltersChanged();
    });

    refs.kpisFinancial.addEventListener("click", function (event) {
      var button = event.target.closest("[data-financial-filter]");
      if (!button || !state.data) return;
      var value = button.getAttribute("data-financial-filter");
      state.financial = state.financial === value ? "" : value;
      refs.financialFilter.value = state.financial;
      onFiltersChanged();
    });

    refs.kpisIntegrity.addEventListener("click", function (event) {
      var button = event.target.closest("[data-integrity-filter]");
      if (!button || !state.data) return;
      var value = button.getAttribute("data-integrity-filter");
      state.integrity = state.integrity === value ? "" : value;
      refs.integrityFilter.value = state.integrity;
      onFiltersChanged();
    });

    refs.kpisListing.addEventListener("click", function (event) {
      var button = event.target.closest("[data-listing-filter]");
      if (!button || !state.data) return;
      var value = button.getAttribute("data-listing-filter");
      state.listingStatus = state.listingStatus === value ? "" : value;
      refs.listingStatusFilter.value = state.listingStatus;
      onFiltersChanged();
    });

    // Sai da tela: nenhum timer de polling fica vivo.
    root.addEventListener("pagehide", stopPolling);

    refs.criticalOnly.addEventListener("click", function () {
      state.criticalOnly = !state.criticalOnly;
      refs.criticalOnly.setAttribute("aria-pressed", state.criticalOnly ? "true" : "false");
      refs.criticalOnly.classList.toggle("is-active", state.criticalOnly);
      refs.criticalOnly.textContent = state.criticalOnly ? "Mostrar todas" : "Somente críticas";
      renderDivergences();
    });

    refs.tableHost.addEventListener("change", function (event) {
      var select = event.target.closest("[data-source-select]");
      if (!select) return;
      state.selection[select.getAttribute("data-source-select")] = select.value;
      state.preset = contract.presetFor(state.selection);
      syncPresetButtons();
      renderSheet();
      renderDivergences();
      if (state.selectedItemId) { markSelectedRow(); renderDrawer(); }
    });

    refs.tableHost.addEventListener("click", function (event) {
      if (event.target.closest("select, option")) return;
      var chip = event.target.closest("[data-next-kind]");
      if (chip) {
        event.preventDefault();
        event.stopPropagation();
        abrirProximaAcao(chip);
        return;
      }
      var evidence = event.target.closest("[data-open-evidence]");
      var trigger = event.target.closest("[data-open-item]");
      var row = event.target.closest("tr[data-item-id]");
      if (evidence) {
        event.preventDefault();
        event.stopPropagation();
        openDrawer(evidence.getAttribute("data-open-evidence"), "evidence", evidence.getAttribute("data-evidence-variable"), evidence);
      } else if (trigger) {
        event.preventDefault();
        event.stopPropagation();
        openDrawer(trigger.getAttribute("data-open-item"), "pricing", null, trigger);
      } else if (row && !event.target.closest("a, button, input, select")) {
        openDrawer(row.getAttribute("data-item-id"), "pricing", null, row);
      }
    });

    refs.tableHost.addEventListener("keydown", function (event) {
      var row = event.target.closest("tr[data-item-id]");
      if (row && event.target === row && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        openDrawer(row.getAttribute("data-item-id"), "pricing", null, row);
      }
    });

    refs.view.addEventListener("click", function (event) {
      var button = event.target.closest("[data-view]");
      if (!button) return;
      setView(button.getAttribute("data-view"));
    });

    refs.healthToggle.addEventListener("click", function () {
      state.healthOpen = !state.healthOpen;
      renderHealth();
    });

    refs.divergencesToggle.addEventListener("click", function () {
      state.divergencesOpen = !state.divergencesOpen;
      renderDivergences();
    });

    refs.kpisTop.addEventListener("click", function (event) {
      var ir = event.target.closest("[data-top-go]");
      if (ir) {
        // "Promos com +LC" abre a aba Promoções já no veredito "Entrar".
        state.oppsFilters = { veredito: "entrar", tipo: "" };
        state.oppsPage = 1;
        state.promoExpanded = {};
        state.promoDetail = {};
        setView(ir.getAttribute("data-top-go"));
        loadOpportunities();
        return;
      }
      var integrity = event.target.closest("[data-integrity-filter]");
      if (integrity && state.data) {
        var iv = integrity.getAttribute("data-integrity-filter");
        state.integrity = state.integrity === iv ? "" : iv;
        refs.integrityFilter.value = state.integrity;
        if (state.view === "promotions") setView("operational");
        onFiltersChanged();
        return;
      }
      var button = event.target.closest("[data-financial-filter]");
      if (!button || !state.data) return;
      var value = button.getAttribute("data-financial-filter");
      state.financial = state.financial === value ? "" : value;
      refs.financialFilter.value = state.financial;
      if (state.view === "promotions") setView("operational");
      onFiltersChanged();
    });

    refs.oppsHost.addEventListener("click", function (event) {
      var pager = event.target.closest("[data-opps-page]");
      if (pager) {
        if (pager.disabled) return;
        state.oppsPage = Math.max(1, Number(pager.getAttribute("data-opps-page")) || 1);
        loadOpportunities();
        return;
      }
      var mais = event.target.closest("[data-promo-more]");
      if (mais) {
        var id = mais.getAttribute("data-promo-more");
        state.promoExpanded[id] = !state.promoExpanded[id];
        mais.setAttribute("aria-expanded", state.promoExpanded[id] ? "true" : "false");
        var linhas = refs.oppsHost.querySelectorAll("tr[data-promo-options]");
        Array.prototype.forEach.call(linhas, function (linha) {
          if (linha.getAttribute("data-promo-options") === id) linha.hidden = !state.promoExpanded[id];
        });
        return;
      }
      var button = event.target.closest("[data-opp-item]");
      if (button) {
        // "Simular" abre o drawer já com ESTA promoção selecionada e simulada.
        openDrawer(button.getAttribute("data-opp-item"), "pricing", null, button, { fromOpportunity: true, promoId: button.getAttribute("data-promo-id") || null });
        return;
      }
      var participar = event.target.closest("[data-opp-participar]");
      if (participar) {
        if (participar.disabled) return;
        // "Participar" abre a Bancada na promoção e já pede o preview (relê ao vivo, gates, fingerprint).
        openDrawer(participar.getAttribute("data-opp-participar"), "pricing", null, participar, { fromOpportunity: true, promoId: participar.getAttribute("data-promo-id") || null, autoReview: true });
        return;
      }
      if (event.target.closest("a, button, input, select, textarea")) return;
      var linha = event.target.closest("tr.cm-promo-row");
      if (linha) alternarDetalhePromo(linha);
    });

    refs.oppsHost.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      var linha = event.target.closest && event.target.closest("tr.cm-promo-row");
      if (!linha || event.target !== linha) return;
      event.preventDefault();
      alternarDetalhePromo(linha);
    });

    refs.promoVeredito.addEventListener("change", function () {
      state.oppsFilters.veredito = refs.promoVeredito.value || "";
      state.oppsPage = 1;
      state.promoExpanded = {};
      state.promoDetail = {};
      loadOpportunities();
    });
    refs.promoTipo.addEventListener("change", function () {
      state.oppsFilters.tipo = refs.promoTipo.value || "";
      state.oppsPage = 1;
      state.promoExpanded = {};
      state.promoDetail = {};
      loadOpportunities();
    });

    refs.divergences.addEventListener("click", function (event) {
      var button = event.target.closest("[data-evidence-item]");
      if (!button) return;
      openDrawer(button.getAttribute("data-evidence-item"), "evidence", button.getAttribute("data-evidence-variable"), button);
    });

    refs.drawerTabs.addEventListener("click", function (event) {
      var button = event.target.closest("[data-tab]");
      if (!button) return;
      setDrawerTab(button.getAttribute("data-tab"));
    });

    refs.drawerBackdrop.addEventListener("click", closeDrawer);
    el("cm-drawer-close").addEventListener("click", closeDrawer);
    el("cm-drawer-close-footer").addEventListener("click", closeDrawer);
    refs.drawerPrev.addEventListener("click", function () { moveDrawer(-1); });
    refs.drawerNext.addEventListener("click", function () { moveDrawer(1); });
    el("cm-confirm-close").addEventListener("click", closeConfirm);
    el("cm-confirm-cancel").addEventListener("click", closeConfirm);
    refs.confirmBody.addEventListener("click", function (event) {
      if (event.target.closest("[data-cm-reler]")) relerAplicacao();
    });
    refs.confirmApply.addEventListener("click", confirmApply);
    refs.confirmOverlay.addEventListener("click", function (event) {
      if (event.target === refs.confirmOverlay) closeConfirm();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && refs.confirmOverlay.classList.contains("is-open")) { closeConfirm(); return; }
      if (event.key === "Escape" && refs.sourcesOverlay.classList.contains("is-open")) { closeSourcesPanel(); return; }
      if (event.key === "Escape" && refs.drawer.classList.contains("is-open")) closeDrawer();
      if (event.key === "Tab" && refs.drawer.classList.contains("is-open")) trapFocus(event);
    });
  }

  // Legado: filtros re-renderizam o workspace carregado. Persistido: nova
  // página 1 no servidor (o filtro vale para o catálogo inteiro da conta).
  function onFiltersChanged() {
    state.visiblePage = 1;
    if (isSnapshotMode()) {
      state.serverPage = 1;
      renderActiveFilters();
      loadSnapshotPage();
      return;
    }
    renderSummary();
    renderSheet();
    renderDivergences();
    renderActiveFilters();
  }

  /** O drawer (e o preview por cima dele) é modal: o Tab não escapa. */
  function trapFocus(event) {
    var container = refs.confirmOverlay && refs.confirmOverlay.classList.contains("is-open") ? refs.confirmOverlay : refs.drawer;
    var focusable = container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (!container.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function applyPreset(name) {
    if (name === "custom") {
      // "Personalizado" é um ESTADO, não um preset: só é atingido alterando um
      // seletor. Clicar nele não inventa uma composição nova.
      state.preset = contract.presetFor(state.selection);
      syncPresetButtons();
      return;
    }
    state.selection = contract.clonePreset(name);
    state.preset = contract.presetFor(state.selection);
    syncPresetButtons();
    renderSheet();
    renderDivergences();
    if (state.selectedItemId) {
      var item = findSelectedItem();
      if (item) initScenario(item);
      renderDrawer();
    }
  }

  function syncPresetButtons() {
    Array.prototype.forEach.call(refs.presets.querySelectorAll("[data-preset]"), function (button) {
      var active = button.getAttribute("data-preset") === state.preset;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    refs.modeCopy.textContent = PRESET_COPY[state.preset] || PRESET_COPY.custom;
  }

  // ---------------------------------------------------------------------------
  // Carregamento
  // ---------------------------------------------------------------------------

  // F2.3 — o contexto vem do Shell V3 (vf-context.js), nunca mais de um
  // <select> local nem de localStorage. data-vf-scope="client" nesta
  // página (não "account"): getWorkspace() é client-level, sem
  // clienteContaId — exigir uma operação escolhida antes de liberar a
  // tela seria um passo sem efeito nenhum no que é carregado.
  //
  // central-margem.js roda como <script> CLÁSSICO, carregado ANTES do
  // vf-shell.js (module, deferred) terminar de executar — a ponte é o
  // evento DOM 'vf:context' (MASTER_SPEC §6.5/§15.3), registrada no fim
  // deste arquivo antes de qualquer emit poder acontecer.
  var ultimoClienteAplicado; // difere de undefined/null na primeira chamada
  function aplicarContextoDoShell(snap) {
    var ctx = root.VF && root.VF.context;
    var temCliente = ctx && snap.context && snap.context.clienteId;
    var clienteAtual = temCliente ? ctx.getClienteAtual() : null;
    var chave = clienteAtual ? clienteAtual.slug : null;
    var contaId = temCliente && snap.context.clienteContaId ? snap.context.clienteContaId : null;

    state.client = clienteAtual ? { id: clienteAtual.id, slug: clienteAtual.slug, name: clienteAtual.nome } : null;

    var clienteMudou = chave !== ultimoClienteAplicado;
    var contaMudou = contaId !== state.contaId;
    state.contaId = contaId;
    // Precificação é SEMPRE por conta: trocar a conta fecha o drawer (e
    // invalida promoções/simulações em voo) mesmo no modo legado.
    if (contaMudou) closeDrawer();
    // O workspace legado é client-level: trocar/resolver a conta NÃO relê
    // (evita uma 2ª varredura ao vivo do Motor). Só a leitura persistida é
    // por conta — nela, trocar de conta troca o dataset.
    if (!clienteMudou && !(contaMudou && (state.mode === "snapshot" || state.awaitingAccount))) return;
    ultimoClienteAplicado = chave;

    stopPolling();
    state.visiblePage = 1;
    state.serverPage = 1;
    state.refreshRun = null;
    state.refreshError = null;
    // Troca de cliente/conta invalida o realizado em voo (resposta velha
    // nunca sobrescreve o contexto novo — ver loadRealizado).
    state.realizadoSequence += 1;
    state.realizado = null;
    state.realizadoError = null;
    state.realizadoLoading = false;
    state.oppsSequence += 1;
    if (state.oppsPollTimer) { root.clearTimeout(state.oppsPollTimer); state.oppsPollTimer = null; }
    state.opps = null;
    state.oppsPage = 1;
    state.oppsLive = "idle";
    state.promoSummary = null;
    state.promoSummarySeq += 1;
    state.promoTop = {};
    state.oppsFilters = { veredito: "", tipo: "" };
    state.oppsTipos = [];
    state.promoExpanded = {};
    state.promoDetail = {};
    state.pendingPromoId = null;
    state.periodParam = lerPeriodoDoShell();
    if (clienteMudou) {
      state.mode = null;
      state.snapshot = null;
      state.data = null;
    }
    closeDrawer();
    if (state.client) {
      loadCentral();
    } else {
      state.data = null;
      state.error = null;
      state.errorCode = null;
      renderAll();
    }
  }

  function isSnapshotMode() { return state.mode === "snapshot"; }

  function lerPeriodoDoShell() {
    var ctx = root.VF && root.VF.context;
    var valor = ctx && typeof ctx.getPeriodoParam === "function" ? ctx.getPeriodoParam() : null;
    return /^\d{4}-\d{2}$/.test(String(valor || "")) ? valor : null;
  }

  // ---------------------------------------------------------------------------
  // Realizado da CONTA no período (KPIs, cobertura, freshness)
  // ---------------------------------------------------------------------------

  /** Uma leitura por (cliente, conta, período); resposta de contexto velho é descartada. */
  function loadRealizado() {
    if (!isSnapshotMode() || !state.client || !state.contaId || typeof api.getSnapshotRealizado !== "function") {
      state.realizado = null;
      renderRealized();
      return Promise.resolve();
    }
    state.realizadoSequence += 1;
    var sequence = state.realizadoSequence;
    var slug = state.client.slug;
    var conta = state.contaId;
    var periodo = state.periodParam || null;
    state.realizadoLoading = true;
    state.realizadoError = null;
    renderRealized();
    return api.getSnapshotRealizado({ clientSlug: slug, clienteContaId: conta, periodo: periodo || undefined }).then(function (result) {
      if (sequence !== state.realizadoSequence) return;
      if (!state.client || state.client.slug !== slug || state.contaId !== conta || (state.periodParam || null) !== periodo) return;
      state.realizadoLoading = false;
      if (!result.ok) {
        state.realizado = null;
        state.realizadoError = result.error || "Não foi possível carregar o realizado do período.";
      } else {
        state.realizado = result.enabled === false ? null : result;
      }
      renderRealized();
      renderContext();
      renderTop();
      renderHealth();
    }).catch(function (error) {
      if (sequence !== state.realizadoSequence) return;
      state.realizadoLoading = false;
      state.realizado = null;
      state.realizadoError = error && error.message || "Falha inesperada ao carregar o realizado.";
      renderRealized();
    });
  }

  function loadCentral(manual) {
    if (!state.client) return;
    // Cálculos do Motor guardados na tela valem por leitura: nova leitura, novo pedido.
    contract.resetCalcs();
    if (state.mode === "snapshot") return loadSnapshot(manual);
    if (state.mode === "legacy" || typeof api.getSnapshotResumo !== "function") {
      state.mode = "legacy";
      return loadWorkspace(manual);
    }
    return decideMode(manual);
  }

  // ---------------------------------------------------------------------------
  // Leitura persistida (Margin Snapshot)
  // ---------------------------------------------------------------------------

  function decideMode(manual) {
    state.requestSequence += 1;
    var sequence = state.requestSequence;
    var clienteNoInicio = state.client && state.client.slug;
    var contaNoInicio = state.contaId;
    state.loading = true;
    state.error = null;
    state.errorCode = null;
    renderAll();
    return api.getSnapshotResumo({ clientSlug: clienteNoInicio, clienteContaId: contaNoInicio }).then(function (resumo) {
      if (sequence !== state.requestSequence) return;
      // O vf-context pode resolver/trocar a conta enquanto a descoberta do
      // modo ainda está em voo. A resposta pertence ao contexto capturado
      // acima e nunca pode decidir o modo nem colocar a conta atual em espera.
      // Repassar por loadCentral() preserva o vf-context como única autoridade
      // e refaz imediatamente o resumo com a conta que ele já resolveu.
      if (!state.client || state.client.slug !== clienteNoInicio || state.contaId !== contaNoInicio) {
        return state.client ? loadCentral(manual) : undefined;
      }
      if (!resumo.ok && (resumo.status === 404 || resumo.type === "network")) {
        // Backend sem a rota de snapshot (deploy anterior/rollback) ou rede
        // indisponível: a tela segue exatamente o caminho de sempre.
        state.mode = "legacy";
        return loadWorkspace(manual);
      }
      if (!resumo.ok) {
        if (resumo.code === "CLIENTE_CONTA_ID_OBRIGATORIO") {
          // Leitura persistida ligada, mas o Shell ainda não tem conta
          // (cliente com 2+ contas sem escolha): nunca escolher por ele.
          state.mode = "snapshot";
          state.awaitingAccount = true;
          state.loading = false;
          state.data = null;
          renderAll();
          return;
        }
        state.loading = false;
        state.error = resumo.error || "Não foi possível ler o estado da Central.";
        state.errorCode = resumo.code || null;
        renderAll();
        return;
      }
      if (!resumo.enabled) {
        state.mode = "legacy";
        return loadWorkspace(manual);
      }
      state.mode = "snapshot";
      state.awaitingAccount = false;
      applySnapshotResumo(resumo);
      loadRealizado();
      loadPromoSummary();
      if (state.view === "promotions") loadOpportunities();
      return loadSnapshotPage();
    }).catch(function (error) {
      if (sequence !== state.requestSequence) return;
      state.loading = false;
      state.error = error && error.message || "Falha inesperada ao carregar a Central.";
      renderAll();
    });
  }

  function applySnapshotResumo(resumo) {
    state.snapshot = resumo;
    if (resumo.activeRun && !contract.isRunTerminal(resumo.activeRun.status)) {
      state.refreshRun = resumo.activeRun;
      startPolling(resumo.activeRun.runId);
    }
  }

  // Resumo (estado + KPIs) e página atual. Usado na entrada e depois que um
  // run de atualização termina.
  function loadSnapshot() {
    if (!state.contaId) {
      state.awaitingAccount = true;
      state.data = null;
      renderAll();
      return Promise.resolve();
    }
    state.requestSequence += 1;
    var sequence = state.requestSequence;
    state.loading = !state.data;
    renderAll();
    return api.getSnapshotResumo({ clientSlug: state.client.slug, clienteContaId: state.contaId }).then(function (resumo) {
      if (sequence !== state.requestSequence) return;
      if (!resumo.ok) {
        state.loading = false;
        state.error = resumo.error;
        state.errorCode = resumo.code || null;
        renderAll();
        return;
      }
      if (!resumo.enabled) {
        state.mode = "legacy";
        state.snapshot = null;
        return loadWorkspace();
      }
      state.awaitingAccount = false;
      applySnapshotResumo(resumo);
      loadRealizado();
      loadPromoSummary();
      if (state.view === "promotions") loadOpportunities();
      return loadSnapshotPage();
    });
  }

  /** Busca UMA página no servidor — nunca o catálogo inteiro. */
  function loadSnapshotPage() {
    if (!state.client || !state.contaId) return Promise.resolve();
    state.requestSequence += 1;
    var sequence = state.requestSequence;
    if (state.abortController) state.abortController.abort();
    state.abortController = typeof AbortController !== "undefined" ? new AbortController() : null;
    state.loading = true;
    state.error = null;
    state.errorCode = null;
    renderAll();

    var statuses = contract.snapshotStatusFilter(state.financial, state.integrity);
    if (statuses && !statuses.length) {
      // Combinação de filtros impossível: resultado vazio sem ir ao servidor.
      state.loading = false;
      state.data = Object.assign({}, state.data || {}, { items: [], pagination: { page: 1, limit: state.serverLimit, total: 0, totalPages: 1 } });
      renderAll();
      return Promise.resolve();
    }

    return api.getSnapshotItens({
      clientSlug: state.client.slug,
      clientName: state.client.name,
      marketplace: state.marketplace,
      clienteContaId: state.contaId,
      page: state.serverPage,
      limit: state.serverLimit,
      status: statuses,
      statusAnuncio: state.listingStatus || undefined,
      search: state.search || undefined,
      periodo: state.periodParam || undefined,
      // Ordem de trabalho: prejuízo → abaixo da meta → maior receita (resolvida no servidor).
      sort: "worklist",
    }, state.abortController && state.abortController.signal).then(function (result) {
      if (sequence !== state.requestSequence || result.aborted) return;
      state.loading = false;
      if (!result.ok) {
        state.error = result.error || "Não foi possível carregar os itens.";
        state.errorCode = result.code || null;
        renderAll();
        return;
      }
      state.data = result;
      if (result.refresh && result.refresh.activeRun && !contract.isRunTerminal(result.refresh.activeRun.status) && !state.pollTimer) {
        state.refreshRun = result.refresh.activeRun;
        startPolling(result.refresh.activeRun.runId);
      }
      renderAll();
    }).catch(function (error) {
      if (sequence !== state.requestSequence) return;
      state.loading = false;
      state.error = error && error.message || "Falha inesperada ao carregar os itens.";
      renderAll();
    });
  }

  /** "Atualizar leitura" no modo persistido: enfileira (202) e acompanha. */
  function requestSnapshotRefresh() {
    if (!state.client || !state.contaId) return;
    state.refreshError = null;
    refs.refresh.disabled = true;
    return api.requestSnapshotRefresh({ clientSlug: state.client.slug, clienteContaId: state.contaId }).then(function (result) {
      if (!result.ok) {
        state.refreshError = result.error;
        toast(result.error || "Não foi possível iniciar a atualização.", "is-danger");
        renderAll();
        return;
      }
      state.refreshRun = result.run || { runId: result.runId, status: "queued", processedItems: 0, totalItems: null };
      toast(result.reused ? "Já existe uma atualização em andamento; acompanhando o progresso." : "Atualização iniciada. A leitura atual continua visível.", "is-info");
      startPolling(result.runId);
      renderAll();
    });
  }

  // Polling leve do run: um único timer por vez, cancelado ao trocar de
  // cliente/conta ou sair da página; para em completed/failed.
  function startPolling(runId) {
    stopPolling();
    if (!runId) return;
    state.pollSequence += 1;
    var pollSequence = state.pollSequence;
    var contaNoInicio = state.contaId;
    var slugNoInicio = state.client && state.client.slug;
    function tick() {
      state.pollTimer = null;
      if (pollSequence !== state.pollSequence) return;
      api.getSnapshotRefreshStatus({ clientSlug: slugNoInicio, clienteContaId: contaNoInicio, runId: runId }).then(function (result) {
        if (pollSequence !== state.pollSequence) return;
        if (!result.ok) {
          // Falha pontual de rede não encerra o acompanhamento.
          state.pollTimer = root.setTimeout(tick, SNAPSHOT_POLL_MS);
          return;
        }
        state.refreshRun = result.run;
        if (contract.isRunTerminal(result.run.status)) {
          state.pollTimer = null;
          if (result.run.status === "completed") {
            toast("Leitura atualizada: " + (result.run.successItems || 0) + " item(ns) recalculado(s). Nenhum preço foi alterado.", "is-success");
          }
          loadSnapshot();
          return;
        }
        renderPageState();
        state.pollTimer = root.setTimeout(tick, SNAPSHOT_POLL_MS);
      });
    }
    state.pollTimer = root.setTimeout(tick, SNAPSHOT_POLL_MS);
  }

  function stopPolling() {
    state.pollSequence += 1;
    if (state.pollTimer) root.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  function loadWorkspace(manual) {
    if (!state.client) return;
    state.requestSequence += 1;
    var sequence = state.requestSequence;
    if (state.abortController) state.abortController.abort();
    state.abortController = typeof AbortController !== "undefined" ? new AbortController() : null;
    state.loading = true;
    state.error = null;
    state.errorCode = null;
    state.visiblePage = 1;
    renderAll();

    // UMA ÚNICA varredura (workspace) alimenta planilha, filtros, KPIs e fila
    // de divergências. Nenhuma chamada por linha, nem na abertura do drawer,
    // nem ao filtrar/buscar/paginar visualmente — só "Atualizar leitura"
    // monta um novo workspace.
    return api.getWorkspace({
      clientSlug: state.client.slug,
      clientName: state.client.name,
      marketplace: state.marketplace,
    }, state.abortController && state.abortController.signal).then(function (result) {
      if (sequence !== state.requestSequence || result.aborted) return;
      state.loading = false;
      if (!result.ok) {
        state.error = result.error || "Não foi possível carregar a Central de Margem.";
        state.errorCode = result.code || null;
        state.data = null;
      } else {
        state.data = result;
        state.error = null;
        state.errorCode = null;
        if (manual) toast("Leitura atualizada. Nenhum preço foi alterado.", "is-success");
      }
      renderAll();
    }).catch(function (error) {
      if (sequence !== state.requestSequence) return;
      state.loading = false;
      state.data = null;
      state.error = error && error.message || "Falha inesperada ao carregar a Central.";
      state.errorCode = null;
      renderAll();
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function runEmAndamento() {
    return Boolean(state.refreshRun && !contract.isRunTerminal(state.refreshRun.status));
  }

  function renderAll() {
    refs.refresh.disabled = state.loading || !state.client || (isSnapshotMode() && (state.awaitingAccount || runEmAndamento()));
    refs.refresh.classList.toggle("is-loading", state.loading || (isSnapshotMode() && runEmAndamento()));
    refs.search.disabled = !state.client;
    refs.listingStatusFilterWrap.hidden = !isSnapshotMode();
    renderContext();
    renderPeriodSelect();
    renderPageState();
    syncPresetButtons();
    renderSourceStrip();
    renderSummary();
    renderRealized();
    renderTop();
    renderHealth();
    renderViewToggle();
    renderActiveFilters();
    renderSheet();
    renderDivergences();
    renderPromotions();
  }

  var MESES_CURTOS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

  function formatDateBr(iso) {
    if (!iso) return null;
    var parts = String(iso).slice(0, 10).split("-");
    return parts.length === 3 ? parts[2] + "/" + parts[1] + "/" + parts[0] : String(iso);
  }

  /** Opções do período: padrão (30 dias até ontem), mês atual e 3 anteriores. */
  function periodOptions() {
    var hoje = new Date();
    var opts = [{ value: "", label: "Últimos 30 dias (até ontem)" }];
    for (var i = 0; i < 4; i += 1) {
      var d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
      var key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      opts.push({ value: key, label: i === 0 ? "Mês atual (até ontem)" : MESES_CURTOS[d.getMonth()] + "/" + d.getFullYear() });
    }
    if (state.periodParam && !opts.some(function (o) { return o.value === state.periodParam; })) {
      opts.push({ value: state.periodParam, label: state.periodParam });
    }
    return opts;
  }

  function renderPeriodSelect() {
    if (!refs.periodWrap || !refs.period) return;
    var visivel = isSnapshotMode() && !state.awaitingAccount && Boolean(state.client);
    refs.periodWrap.hidden = !visivel;
    if (!visivel) return;
    var atual = state.periodParam || "";
    refs.period.innerHTML = periodOptions().map(function (o) {
      return '<option value="' + escapeHtml(o.value) + '"' + (o.value === atual ? " selected" : "") + ">" + escapeHtml(o.label) + "</option>";
    }).join("");
    refs.period.value = atual;
    refs.period.disabled = state.loading;
  }

  var FRESHNESS_META = {
    ATUAL: { label: "Atual", tone: "is-success", copy: "todo o período coberto por sincronização publicada" },
    PARCIAL: { label: "Parcial", tone: "is-warning", copy: "parte do período não está coberta pela sincronização publicada" },
    NAO_DECLARADA: { label: "Cobertura não declarada", tone: "is-neutral", copy: "dados de importação anterior à publicação por cobertura" },
    SEM_SINCRONIZACAO: { label: "Sem sincronização", tone: "is-neutral", copy: "nenhuma venda sincronizada neste período" },
    INDISPONIVEL: { label: "Indisponível", tone: "is-warning", copy: "a leitura de vendas falhou neste período" },
  };


  function realizedKpi(label, valueHtml, foot, modifier) {
    return '<div class="cm-kpi cm-kpi--static ' + (modifier || "") + '"><span class="cm-kpi__label">' + escapeHtml(label) + "</span>" +
      '<strong class="cm-kpi__value">' + valueHtml + "</strong>" +
      (foot ? '<span class="cm-kpi__foot">' + escapeHtml(foot) + "</span>" : "") + "</div>";
  }

  function formatInt(value) {
    return value === null || value === undefined ? null : Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  }

  function gapCopy(gap) {
    var mes = gap.month || "";
    if (gap.reason === "COBERTURA_INSUFICIENTE") {
      return mes + ": vendas publicadas só até " + (formatDateBr(gap.publishedUntil) || "—") +
        " — o período pede até " + (formatDateBr(gap.to) || "—") + ". Este mês ficou fora do realizado (nada foi zerado).";
    }
    return mes + ": nenhuma sincronização publicada cobre " + (formatDateBr(gap.from) || "—") + " a " + (formatDateBr(gap.to) || "—") + ".";
  }

  /** Bloco "Realizado no período": só EXIBE o que o backend calculou. */
  function renderRealized() {
    // A faixa do topo (realizado em uma linha, ou o aviso único) acompanha o mesmo estado.
    realizedLine();
    if (!refs.realized) return;
    var visivel = isSnapshotMode() && !state.awaitingAccount && Boolean(state.client && state.contaId);
    refs.realized.hidden = !visivel;
    if (!visivel) return;
    var r = state.realizado;
    if (state.realizadoLoading && !r) {
      refs.realizedPeriod.textContent = "carregando…";
      refs.realizedFresh.innerHTML = "";
      refs.kpisRealized.innerHTML = '<div class="vf-skeleton vf-skeleton--row"></div>';
      refs.realizedNotes.innerHTML = "";
      return;
    }
    if (!r) {
      refs.realizedPeriod.textContent = "—";
      refs.realizedFresh.innerHTML = state.realizadoError
        ? '<p class="cm-realized__error" role="alert">' + escapeHtml(state.realizadoError) + "</p>"
        : '<p class="cm-realized__muted">O realizado da conta aparece depois da primeira leitura.</p>';
      refs.kpisRealized.innerHTML = "";
      refs.realizedNotes.innerHTML = "";
      return;
    }
    var fresh = r.freshness || {};
    var meta = FRESHNESS_META[fresh.state] || FRESHNESS_META.SEM_SINCRONIZACAO;
    refs.realizedPeriod.textContent = (r.period && r.period.label) || "—";
    refs.realizedFresh.innerHTML =
      '<span class="vf-status ' + meta.tone + '" data-cm-realized-state="' + escapeHtml(fresh.state || "") + '" title="' + escapeHtml(meta.copy) + '">' + escapeHtml(meta.label) + "</span>" +
      (fresh.syncInProgress ? '<span class="vf-status is-info" data-cm-sync-running>Sincronização em andamento</span>' : "") +
      '<span class="cm-realized__fact">Vendas sincronizadas até <strong>' + escapeHtml(formatDateBr(fresh.syncedUntil) || "—") + "</strong></span>" +
      (fresh.lastPublishedAt ? '<span class="cm-realized__fact">publicado em ' + escapeHtml(formatDateTime(fresh.lastPublishedAt)) + "</span>" : "") +
      '<span class="cm-realized__fact">Projetado calculado em ' + escapeHtml(formatDateTime(state.snapshot && state.snapshot.lastCalculatedAt) || "—") + "</span>";

    if (r.unavailable) {
      // Aviso ÚNICO ("Realizado indisponível · motivo") fica na faixa do topo; aqui não se repete
      // oito vezes "Indisponível": o bloco detalhado só aparece quando há realizado.
      refs.realized.hidden = true;
      return;
    }
    var k = r.kpis || {};
    var m = k.margin || {};
    var d = k.drift || {};
    var margemFoot = m.state === "completa"
      ? "Σ lucro ÷ Σ receita · cobertura total"
      : m.state === "parcial"
        ? "parcial · " + (m.revenueCoverage === null ? "—" : formatPercent(m.revenueCoverage)) + " da receita sustenta o número"
        : "nenhum produto com margem realizada calculável";
    refs.kpisRealized.innerHTML = [
      realizedKpi("Receita realizada", escapeHtml(formatMoney(k.revenue) || "—"), k.revenueWithoutListing ? "inclui " + formatMoney(k.revenueWithoutListing) + " sem MLB" : "pedidos que entram no resultado"),
      realizedKpi("Unidades", escapeHtml(formatInt(k.units) || "0"), null),
      realizedKpi("Pedidos", escapeHtml(formatInt(k.orders) || "0"), "distintos"),
      realizedKpi("Produtos com venda", escapeHtml(formatInt(k.productsWithSales) || "0"), null),
      realizedKpi("Lucro realizado", k.profit === null ? unavailable("Indisponível", "Nenhum produto com margem realizada calculável no período.") : escapeHtml(formatMoney(k.profit)),
        k.profit === null ? null : "sem taxa fixa (sem histórico)", k.profit !== null && k.profit < 0 ? "is-danger" : ""),
      realizedKpi("Margem realizada", m.percent === null ? unavailable("Indisponível", margemFoot) : escapeHtml(formatPercent(m.percent / 100)), margemFoot,
        m.state === "parcial" ? "is-warning" : ""),
      realizedKpi("Desvio de margem", d.pp === null ? unavailable("Indisponível", "Sem produto com projetado e realizado calculáveis.") : escapeHtml(formatPp(d.pp)),
        d.available ? "realizado " + formatPercent(d.realizedMixPercent / 100) + " × projetado " + formatPercent(d.projectedMixPercent / 100) + " no mesmo mix" : null,
        d.pp !== null && d.pp < 0 ? "is-danger" : ""),
      realizedKpi("Desvio negativo relevante", escapeHtml(formatInt(d.negative) || "0"), "produtos com Δ ≤ −" + (d.thresholdPp || 2) + " p.p.", d.negative ? "is-warning" : ""),
    ].join("");

    var notas = [];
    var cov = r.coverage || {};
    (cov.gaps || []).forEach(function (gap) { notas.push('<li data-cm-gap="' + escapeHtml(gap.month) + '">' + escapeHtml(gapCopy(gap)) + "</li>"); });
    if (m.productsWithoutMargin) {
      notas.push("<li>" + escapeHtml(m.productsWithoutMargin + " produto(s) venderam sem margem realizada calculável (ex.: sem custo histórico na venda) — fora do lucro e da margem, contados na receita.") + "</li>");
    }
    if (m.estimatedProducts) {
      notas.push("<li>" + escapeHtml(m.estimatedProducts + " produto(s) com componente estimado (cobertura parcial de comissão/frete/custo/imposto ou frete rateado de pedido multi-item).") + "</li>");
    }
    if (d.worst && d.worst.length) {
      notas.push("<li>Maiores desvios: " + d.worst.map(function (w) {
        return escapeHtml((w.titulo || w.itemId) + " " + formatPp(w.driftPp));
      }).join(" · ") + "</li>");
    }
    refs.realizedNotes.innerHTML = notas.length ? '<ul class="cm-realized__list">' + notas.join("") + "</ul>" : "";
  }

  function renderContext() {
    var data = state.data;
    if (isSnapshotMode()) {
      var snap = state.snapshot || {};
      refs.updated.innerHTML = '<span class="cm-updated__label">Último cálculo</span><strong>' +
        escapeHtml(formatDateTime(snap.lastCalculatedAt) || "—") + "</strong>";
      refs.monitoredTag.textContent = snap.totalItems === null || snap.totalItems === undefined ? "—" : snap.totalItems + " itens";
      refs.sourceTag.textContent = "Leitura persistida";
      var contaMeta = root.VF && root.VF.context && root.VF.context.getAccountMeta ? root.VF.context.getAccountMeta() : null;
      refs.contextMeta.innerHTML = state.client
        ? '<span><strong>Cliente:</strong> ' + escapeHtml(state.client.name) + "</span>" +
          (contaMeta ? '<span><strong>Conta:</strong> ' + escapeHtml(contaMeta.nome || contaMeta.externalAccountLabel || state.contaId) + "</span>" : "") +
          '<span><strong>Marketplace:</strong> Mercado Livre</span>' +
          '<span><strong>Projetado:</strong> snapshot calculado em ' + escapeHtml(formatDateTime(snap.lastCalculatedAt) || "—") + "</span>" +
          '<span><strong>Realizado:</strong> ' + escapeHtml((data && data.period && data.period.label) || (state.realizado && state.realizado.period && state.realizado.period.label) || "últimos 30 dias (até ontem)") +
          (state.realizado && state.realizado.freshness && state.realizado.freshness.syncedUntil
            ? " · sincronizado até " + escapeHtml(formatDateBr(state.realizado.freshness.syncedUntil))
            : "") + "</span>" +
          '<span><strong>Modo:</strong> somente leitura</span>'
        : "";
      return;
    }
    refs.updated.innerHTML = '<span class="cm-updated__label">Última atualização</span><strong>' +
      escapeHtml((data && formatDateTime(data.lastUpdated)) || "—") + "</strong>";
    refs.monitoredTag.textContent = data ? coverageLabel(data.coverage) : "—";
    refs.sourceTag.textContent = data ? data.sourceLabel + " · leitura" : "Motor · leitura";
    if (!data || !state.client) {
      refs.contextMeta.innerHTML = state.client ? '<span><strong>Cliente:</strong> ' + escapeHtml(state.client.name) + "</span>" : "";
      return;
    }
    var period = data.period || {};
    var coverage = data.coverage || {};
    refs.contextMeta.innerHTML =
      '<span><strong>Cliente:</strong> ' + escapeHtml(state.client.name) + "</span>" +
      '<span><strong>Marketplace:</strong> Mercado Livre</span>' +
      '<span><strong>Fonte:</strong> ' + escapeHtml(data.sourceLabel) + "</span>" +
      '<span><strong>Realizado:</strong> ' + escapeHtml(period.label || "últimos 30 dias (até ontem)") + "</span>" +
      '<span><strong>Modo:</strong> somente leitura</span>' +
      '<span class="cm-coverage' + (coverage.partial ? " is-partial" : "") + '"><strong>Cobertura:</strong> ' +
      escapeHtml(coverageLabel(coverage)) + (coverage.partial ? " · parcial" : "") + "</span>";
  }

  function progressoRun(run) {
    var total = run.totalItems;
    var feitos = run.processedItems || 0;
    var pct = total ? Math.min(100, Math.round((feitos / total) * 100)) : null;
    return { total: total, feitos: feitos, pct: pct };
  }

  // Banners do modo persistido — nunca escondem falha nem fingem leitura.
  function renderSnapshotPageState() {
    var partes = [];
    if (state.awaitingAccount) {
      refs.pageState.innerHTML = '<div class="vf-banner is-info" data-cm-snapshot-state="conta"><div class="vf-banner__content"><p class="vf-banner__title">Escolha a operação (conta Mercado Livre)</p><p class="vf-banner__description">A leitura persistida da margem é por conta. Este cliente tem mais de uma conta ativa — selecione a operação no seletor do topo.</p></div></div>';
      return;
    }
    var snap = state.snapshot || {};
    var run = state.refreshRun;
    if (run && !contract.isRunTerminal(run.status)) {
      var p = progressoRun(run);
      var texto = run.status === "queued"
        ? "Na fila para atualizar…"
        : "Atualizando leitura · " + p.feitos + (p.total !== null ? " / " + p.total : "") + " itens";
      partes.push('<div class="vf-banner is-info" data-cm-snapshot-state="' + escapeHtml(run.status) + '" role="status"><div class="vf-banner__content"><p class="vf-banner__title">' + escapeHtml(texto) + "</p>" +
        (p.pct !== null ? '<div class="cm-progress" aria-hidden="true"><span style="width:' + p.pct + '%"></span></div>' : "") +
        '<p class="vf-banner__description">' + (snap.state === "ready"
          ? "O último snapshot continua visível enquanto a atualização roda em background."
          : "A primeira leitura desta conta está sendo calculada em background.") + "</p></div></div>");
    } else if (snap.state === "missing") {
      partes.push('<div class="vf-banner is-warning" data-cm-snapshot-state="missing"><div class="vf-banner__content"><p class="vf-banner__title">Leitura ainda não calculada para esta conta</p><p class="vf-banner__description">' +
        escapeHtml(snap.message || "Clique em \"Atualizar leitura\" para calcular a margem projetada em background.") +
        '</p></div><div class="vf-banner__actions"><button class="vf-btn vf-btn--primary vf-btn--sm" type="button" id="cm-snapshot-start">Atualizar leitura</button></div></div>');
    }
    var ultimo = run && contract.isRunTerminal(run.status) ? run : snap.lastRun;
    if (ultimo && ultimo.status === "failed" && !runEmAndamento()) {
      partes.push('<div class="vf-banner is-danger" data-cm-snapshot-state="failed" role="alert"><div class="vf-banner__content"><p class="vf-banner__title">A última atualização falhou</p><p class="vf-banner__description">' +
        escapeHtml(ultimo.errorMessage || "Erro não informado.") +
        (snap.state === "ready" ? " Os valores exibidos são do último snapshot válido — nada foi zerado." : "") + "</p></div></div>");
    }
    if (snap.kpis && snap.kpis.refresh && snap.kpis.refresh.failed > 0) {
      partes.push('<div class="vf-banner is-info" data-cm-snapshot-state="itens-falhos"><div class="vf-banner__content"><p class="vf-banner__description">' +
        snap.kpis.refresh.failed + " item(ns) não puderam ser recalculados na última atualização e mostram o valor anterior (marcados na linha).</p></div></div>");
    }
    refs.pageState.innerHTML = partes.join("");
    var start = el("cm-snapshot-start");
    if (start) start.addEventListener("click", requestSnapshotRefresh);
  }

  function renderPageState() {
    if (isSnapshotMode() && !state.error) {
      renderSnapshotPageState();
      return;
    }
    if (!state.client && !state.error) {
      // F2.3 — o Shell (data-vf-scope="client") já bloqueia esta tela
      // enquanto nenhum cliente estiver escolhido; isto é rede de segurança.
      refs.pageState.innerHTML = '<div class="vf-banner is-info"><div class="vf-banner__content"><p class="vf-banner__title">Selecione o contexto da análise</p><p class="vf-banner__description">Escolha um cliente na barra lateral para carregar anúncios, dados financeiros e cobertura de Base.</p></div></div>';
      return;
    }
    if (state.error) {
      var contextError = {
        BASE_MELI_NAO_VINCULADA: { title: "Cliente sem Base vinculada", action: '<a class="vf-btn vf-btn--secondary vf-btn--sm" href="bases.html">Ver em Bases</a>' },
        MULTIPLAS_BASES_MELI: { title: "Vínculo de Base ambíguo", action: '<a class="vf-btn vf-btn--secondary vf-btn--sm" href="bases.html">Ver em Bases</a>' },
        GRANT_ML_NAO_CONECTADO: { title: "Mercado Livre não conectado", action: '<a class="vf-btn vf-btn--secondary vf-btn--sm" href="clientes.html">Ver cliente</a>' },
      }[state.errorCode] || null;
      refs.pageState.innerHTML = '<div class="vf-banner is-danger" role="alert"><div class="vf-banner__content"><p class="vf-banner__title">Não foi possível carregar a Central</p><p class="vf-banner__description">' +
        escapeHtml(state.error) + '</p></div><div class="vf-banner__actions">' + (contextError ? contextError.action : "") + '<button class="vf-btn vf-btn--secondary vf-btn--sm" type="button" id="cm-retry">Tentar novamente</button></div></div>';
      if (contextError) refs.pageState.querySelector(".vf-banner__title").textContent = contextError.title;
      var retry = el("cm-retry");
      // state.client sempre existe aqui: o Shell resolve o cliente antes de
      // qualquer chamada a loadCentral() (aplicarContextoDoShell()).
      if (retry) retry.addEventListener("click", function () { loadCentral(); });
      return;
    }
    if (!state.data || state.loading) {
      refs.pageState.innerHTML = "";
      return;
    }
    var data = state.data;
    if (!data.partial && !(data.warnings || []).length) {
      refs.pageState.innerHTML = "";
      return;
    }
    var warnings = (data.warnings || []).map(function (warning) { return "<li>" + escapeHtml(warning) + "</li>"; }).join("");
    var coverageNote = data.partial
      ? "<p class=\"vf-banner__description\">" + escapeHtml(coverageLabel(data.coverage)) +
        " · cobertura parcial: o catálogo tem mais anúncios do que o teto seguro desta leitura. Filtros, KPIs e divergências consideram só os " +
        (data.coverage && data.coverage.loaded || 0) + " carregados.</p>"
      : "";
    refs.pageState.innerHTML = '<div class="vf-banner is-info"><div class="vf-banner__content"><p class="vf-banner__title">Leitura parcial e rastreável</p><p class="vf-banner__description">Os valores exibidos são reais ou derivados de fontes reais; campos sem fonte permanecem indisponíveis.</p>' +
      coverageNote + (warnings ? "<ul>" + warnings + "</ul>" : "") + "</div></div>";
  }

  function renderSourceStrip() {
    if (!state.data) {
      refs.sourceStrip.innerHTML = '<p class="cm-source-empty">A saúde das fontes aparece depois da primeira leitura.</p>';
      return;
    }
    refs.sourceStrip.innerHTML = contract.sourceHealth(state.data).map(function (source) {
      var meta = SOURCE_STATE_META[source.state] || SOURCE_STATE_META.UNAVAILABLE;
      return '<div class="cm-source"><div class="cm-source__top"><span class="cm-source__name">' + escapeHtml(source.name) +
        '</span><span class="cm-dot ' + meta.className + '" aria-hidden="true"></span></div>' +
        '<p class="cm-source__meta"><span class="cm-source__state">' + escapeHtml(meta.label) + "</span> · " + escapeHtml(source.detail) + "</p></div>";
    }).join("");
  }

  /*
   * Painel "Fontes e cobertura" — responde "de onde vem essa coluna?" e "por
   * que essa célula está indisponível?". A Saúde das fontes (cm-source-strip)
   * responde uma pergunta diferente ("a fonte está disponível?"); este painel
   * é o mapa fonte → variável, estático por design (não muda por item).
   */
  function sourcesTableHtml() {
    var rows = contract.VARIABLES.map(function (variableKey) {
      var meta = contract.VARIABLE_META[variableKey];
      var projected = contract.PRESETS.projected[variableKey];
      var realized = contract.PRESETS.realized[variableKey];
      return "<tr><td>" + escapeHtml(meta.label) + "</td><td>" + escapeHtml(contract.sourceLabel(projected)) +
        "</td><td>" + escapeHtml(contract.sourceLabel(realized)) + "</td></tr>";
    }).join("");
    return '<table class="cm-sources-table"><thead><tr><th>Variável</th><th>Projetado</th><th>Realizado</th></tr></thead><tbody>' +
      rows + "</tbody></table>";
  }

  function renderSourcesPanel() {
    var coverage = (state.data && state.data.coverage) || {};
    var coverageHtml = state.data
      ? '<p class="cm-sources-coverage">' + escapeHtml(coverageLabel(coverage)) +
        (coverage.partial ? " · cobertura parcial do catálogo nesta leitura." : " · cobertura completa nesta leitura.") + "</p>"
      : '<p class="cm-sources-coverage">Selecione um cliente para ver a cobertura desta leitura.</p>';

    refs.sourcesBody.innerHTML =
      '<p class="cm-sources-intro">Cada variável da planilha tem uma fonte PROJETADA (estado atual do anúncio) e uma REALIZADA (o que a venda entregou). Custo, imposto e taxa fixa são declarados na Base e valem para os dois momentos — o Motor não tem uma versão "realizada" separada delas.</p>' +
      coverageHtml + sourcesTableHtml() +
      '<div class="cm-sources-pending">' +
      '<p><strong>Mercado Pago</strong> · recebimento/conciliação — integração pendente. Nenhum valor é inventado; a célula fica indisponível até a integração existir.</p>' +
      '<p><strong>Extensão</strong> · evidência visual — ingestão pendente. O canal de recebimento ainda não existe no backend.</p>' +
      "</div>" +
      '<div class="cm-sources-actions"><a class="vf-btn vf-btn--secondary vf-btn--sm" href="bases.html">Ver na Base</a></div>';
  }

  function openSourcesPanel() {
    renderSourcesPanel();
    state.previousFocus = document.activeElement;
    refs.sourcesOverlay.classList.add("is-open");
    refs.sourcesClose.focus();
  }

  function closeSourcesPanel() {
    refs.sourcesOverlay.classList.remove("is-open");
    if (state.previousFocus && state.previousFocus.focus) state.previousFocus.focus();
  }

  // Modo persistido: placar da CONTA INTEIRA calculado no banco (não da
  // página), pelo status canônico projetado. `null` (missing) vira "—".
  function snapshotKpiValue(key) {
    var kpis = state.snapshot && state.snapshot.kpis;
    if (!kpis) return "—";
    return key === "total" ? kpis.total : kpis.counts[key] || 0;
  }

  function financialCards() {
    if (isSnapshotMode()) {
      return [
        { filter: null, label: "Itens da conta", value: snapshotKpiValue("total"), foot: "leitura persistida", modifier: "" },
        { filter: "HEALTHY", label: "Saudáveis", value: snapshotKpiValue("HEALTHY"), foot: "sem ação imediata", modifier: "is-success" },
        { filter: "LOW_MARGIN", label: "Margem baixa", value: snapshotKpiValue("LOW_MARGIN"), foot: "abaixo da meta", modifier: "is-warning" },
        { filter: "LOSS", label: "Prejuízo", value: snapshotKpiValue("LOSS"), foot: "ação prioritária", modifier: "is-danger" },
      ];
    }
    var summary = state.data ? contract.summarizeItems(state.data.items) : { financial: {} };
    var counts = summary.financial || {};
    var coverage = state.data ? state.data.coverage || {} : {};
    var monitored = coverage.loaded || 0;
    return [
      { filter: null, label: "Carregados", value: monitored, foot: coverageLabel(coverage), modifier: "" },
      { filter: "HEALTHY", label: "Saudáveis", value: counts.HEALTHY || 0, foot: "sem ação imediata", modifier: "is-success" },
      { filter: "LOW_MARGIN", label: "Margem baixa", value: counts.LOW_MARGIN || 0, foot: "abaixo da meta", modifier: "is-warning" },
      { filter: "LOSS", label: "Prejuízo", value: counts.LOSS || 0, foot: "ação prioritária", modifier: "is-danger" },
    ];
  }

  function integrityCards() {
    if (isSnapshotMode()) {
      return [
        { filter: "MISSING", label: "Não validados", value: snapshotKpiValue("UNVALIDATED"), foot: "dado obrigatório ausente", modifier: "" },
        { filter: "SUSPECT", label: "Dados suspeitos", value: snapshotKpiValue("SUSPECT_DATA"), foot: "fontes em conflito", modifier: "is-warning" },
        { filter: "RECONCILING", label: "Em conciliação", value: snapshotKpiValue("RECONCILING"), foot: "realizado ainda aberto", modifier: "is-info" },
      ];
    }
    var summary = state.data ? contract.summarizeItems(state.data.items) : { integrity: {} };
    var counts = summary.integrity || {};
    return [
      { filter: "MISSING", label: "Não validados", value: counts.MISSING || 0, foot: "dado obrigatório ausente", modifier: "" },
      { filter: "SUSPECT", label: "Dados suspeitos", value: counts.SUSPECT || 0, foot: "fontes em conflito", modifier: "is-warning" },
      { filter: "RECONCILING", label: "Em conciliação", value: counts.RECONCILING || 0, foot: "realizado ainda aberto", modifier: "is-info" },
    ];
  }

  function listingCards() {
    var listings = state.snapshot && state.snapshot.kpis && state.snapshot.kpis.listings;
    return [
      { filter: null, label: "Anúncios", value: listings ? listings.total : "—", foot: "conta inteira", modifier: "" },
      { filter: "active", label: "Ativos", value: listings ? listings.active : "—", foot: "em venda", modifier: "is-success" },
      { filter: "paused", label: "Pausados", value: listings ? listings.paused : "—", foot: "fora de venda", modifier: "is-warning" },
    ];
  }

  function kpiHtml(card, attribute, activeValue) {
    var active = card.filter !== null && activeValue === card.filter;
    return '<button type="button" class="cm-kpi ' + card.modifier + (active ? " is-active" : "") + '"' +
      (card.filter === null ? "" : " " + attribute + '="' + card.filter + '"') +
      (card.filter === null ? "" : ' aria-pressed="' + (active ? "true" : "false") + '"') +
      (!state.data || state.loading ? " disabled" : "") + ">" +
      '<span class="cm-kpi__label">' + escapeHtml(card.label) + '</span>' +
      '<strong class="cm-kpi__value">' + escapeHtml(card.value) + "</strong>" +
      '<span class="cm-kpi__foot">' + escapeHtml(card.foot) + "</span></button>";
  }

  function renderSummary() {
    refs.kpisFinancial.innerHTML = financialCards().map(function (card) {
      return kpiHtml(card, "data-financial-filter", state.financial);
    }).join("");
    refs.kpisIntegrity.innerHTML = integrityCards().map(function (card) {
      return kpiHtml(card, "data-integrity-filter", state.integrity);
    }).join("");
    refs.listingSummary.hidden = !isSnapshotMode();
    refs.kpisListing.innerHTML = isSnapshotMode() ? listingCards().map(function (card) {
      return kpiHtml(card, "data-listing-filter", state.listingStatus);
    }).join("") : "";

    if (!state.client) refs.summaryScope.textContent = "Selecione um cliente para iniciar a análise.";
    else if (isSnapshotMode()) {
      refs.summaryScope.textContent = state.snapshot && state.snapshot.kpis
        ? "Placar da conta inteira (" + state.snapshot.kpis.total + " itens), calculado no banco pelo status projetado do Motor — não depende da página nem dos filtros da planilha. O realizado aparece por item, no período."
        : "O placar aparece depois da primeira leitura calculada desta conta.";
    }
    else if (state.loading) refs.summaryScope.textContent = "Atualizando a leitura…";
    else if (!state.data) refs.summaryScope.textContent = "";
    else {
      var coverage = state.data.coverage || {};
      refs.summaryScope.textContent = "Resultado financeiro e integridade do dado são leituras diferentes: um produto pode ter prejuízo com dado confiável, e margem aparentemente saudável com dado suspeito. " +
        "Os dois placares refletem os " + coverageLabel(coverage) + (coverage.partial ? " (cobertura parcial do catálogo)" : "") + ".";
    }
  }

  // ---------------------------------------------------------------------------
  // Topo compacto + Saúde dos dados
  // ---------------------------------------------------------------------------

  function formatMoneyShort(value) {
    var number = contract.numberOrNull(value);
    if (number === null) return null;
    return number.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  }

  /** Rótulo curto do período do realizado: "30d" (padrão) ou o mês escolhido. */
  function periodShortLabel() {
    if (!state.periodParam) return "30d";
    var parts = state.periodParam.split("-");
    return MESES_CURTOS[Number(parts[1]) - 1] + "/" + parts[0].slice(2);
  }

  function topMetric(label, valueHtml, opts) {
    var o = opts || {};
    var clicavel = Boolean(o.filter || o.integrity || o.go);
    var tag = clicavel ? "button" : "div";
    var active = (o.filter && state.financial === o.filter) || (o.integrity && state.integrity === o.integrity);
    var atributo = o.filter ? ' data-financial-filter="' + o.filter + '"'
      : o.integrity ? ' data-integrity-filter="' + o.integrity + '"'
        : o.go ? ' data-top-go="' + o.go + '"' : "";
    return "<" + tag + ' class="cm-topk' + (o.tone ? " " + o.tone : "") + (active ? " is-active" : "") + '"' +
      (clicavel ? ' type="button"' + atributo + ' aria-pressed="' + (active ? "true" : "false") + '"' + (!o.go && (!state.data || state.loading) ? " disabled" : "") : "") +
      (o.title ? ' title="' + escapeHtml(o.title) + '"' : "") + ">" +
      '<span class="cm-topk__label">' + escapeHtml(label) + "</span>" +
      '<strong class="cm-topk__value">' + valueHtml + "</strong>" +
      (o.foot ? '<span class="cm-topk__foot">' + escapeHtml(o.foot) + "</span>" : "") + "</" + tag + ">";
  }

  // KPIs de decisão (quatro, sempre os mesmos): o que está em prejuízo, o que está
  // abaixo da meta, quanto vale entrar em promoção e o que tem dado suspeito.
  function promoKpi(dash) {
    var ps = state.promoSummary;
    if (!isSnapshotMode()) return topMetric("Promos com +LC", dash, { title: "Disponível na leitura persistida por conta" });
    if (!ps || ps.status === "loading") return topMetric("Promos com +LC", dash, { foot: "calculando…", go: "promotions" });
    if (ps.status !== "ok") {
      return topMetric("Promos com +LC", dash, { foot: ps.motivo || "promoções indisponíveis", go: "promotions", title: ps.mensagem || null });
    }
    var r = ps.resumo || {};
    var foot = r.com_historico > 0
      ? "impacto " + (formatMoneyShort(r.impacto_lc) || "—") + " em " + periodShortLabel()
      : "sem histórico de vendas p/ medir o impacto";
    if (r.com_historico > 0 && r.sem_historico > 0) foot += " · " + r.sem_historico + " sem histórico";
    return topMetric("Promos com +LC", escapeHtml(String(r.entrar || 0)), {
      go: "promotions", tone: r.entrar ? "is-success" : "", foot: foot,
      title: "Anúncios cuja melhor promoção não reduz o LC por unidade e fica na meta (estimativa; a aba Promoções cota ao vivo)",
    });
  }

  function realizedLine() {
    if (!refs.topRealized) return;
    var r = isSnapshotMode() ? state.realizado : null;
    var texto = "";
    var indisponivelMotivo = null;
    if (isSnapshotMode() && !state.awaitingAccount && state.contaId) {
      if (r && r.unavailable) indisponivelMotivo = { codigo: r.unavailable.reason, texto: r.unavailable.message || r.unavailable.reason };
      else if (!r && state.realizadoError) indisponivelMotivo = { codigo: "ERRO", texto: state.realizadoError };
    }
    if (indisponivelMotivo) {
      refs.topRealized.hidden = false;
      refs.topRealized.className = "cm-top__realized is-unavailable";
      refs.topRealized.setAttribute("data-cm-realized-unavailable", indisponivelMotivo.codigo || "");
      refs.topRealized.textContent = "Realizado indisponível · " + indisponivelMotivo.texto;
      return;
    }
    var k = r && r.kpis ? r.kpis : null;
    refs.topRealized.removeAttribute("data-cm-realized-unavailable");
    if (!k) { refs.topRealized.hidden = true; refs.topRealized.textContent = ""; return; }
    var m = k.margin || {};
    var partes = ["Realizado " + periodShortLabel()];
    if (m.percent !== null && m.percent !== undefined) partes.push("margem " + formatPercent(m.percent / 100) + (m.state === "parcial" ? " (parcial)" : ""));
    if (k.revenue !== null && k.revenue !== undefined) partes.push("receita " + formatMoneyShort(k.revenue));
    if (k.profit !== null && k.profit !== undefined) partes.push("lucro " + formatMoneyShort(k.profit));
    if (k.productsWithSales !== null && k.productsWithSales !== undefined) partes.push(formatInt(k.productsWithSales) + " produtos com venda");
    refs.topRealized.hidden = false;
    refs.topRealized.className = "cm-top__realized";
    refs.topRealized.textContent = partes.join(" · ");
  }

  function renderTop() {
    if (!refs.kpisTop) return;
    var contaMeta = root.VF && root.VF.context && root.VF.context.getAccountMeta ? root.VF.context.getAccountMeta() : null;
    refs.topContext.textContent = state.client
      ? state.client.name + (contaMeta ? " · " + (contaMeta.nome || contaMeta.externalAccountLabel || state.contaId) : "")
      : "";
    if (!state.client) {
      refs.kpisTop.innerHTML = "";
      refs.summaryLine.textContent = "Selecione um cliente na barra lateral para iniciar.";
      return;
    }
    var kpisSnap = isSnapshotMode() && state.snapshot ? state.snapshot.kpis : null;
    var counts;
    if (isSnapshotMode()) counts = kpisSnap ? kpisSnap.counts : null;
    else counts = state.data ? contract.summarizeItems(state.data.items).financial : null;
    var dash = unavailable("—");
    var lcPrejuizo = kpisSnap && kpisSnap.lossLc !== null && kpisSnap.lossLc !== undefined ? kpisSnap.lossLc : null;
    var suspeitos = isSnapshotMode()
      ? (counts ? counts.SUSPECT_DATA || 0 : null)
      : (state.data ? contract.summarizeItems(state.data.items).integrity.SUSPECT || 0 : null);
    refs.kpisTop.innerHTML = [
      topMetric("Em prejuízo", counts ? escapeHtml(String(counts.LOSS || 0)) : dash, {
        filter: "LOSS", tone: counts && counts.LOSS ? "is-danger" : "",
        foot: counts && lcPrejuizo !== null ? "LC/un somado " + (formatMoney(lcPrejuizo) || "—") : null,
        title: "Anúncios em prejuízo (com o retorno ML da promoção em andamento). O número soma o LC por unidade deles. Clique para filtrar.",
      }),
      topMetric("Abaixo da meta", counts ? escapeHtml(String(counts.LOW_MARGIN || 0)) : dash, {
        filter: "LOW_MARGIN", tone: counts && counts.LOW_MARGIN ? "is-warning" : "", foot: counts ? "margem positiva, abaixo da meta" : null,
        title: "Margem positiva, mas abaixo da meta de referência. Clique para filtrar.",
      }),
      promoKpi(dash),
      topMetric("Dado suspeito", suspeitos === null ? dash : escapeHtml(String(suspeitos)), {
        integrity: "SUSPECT", tone: suspeitos ? "is-warning" : "", foot: suspeitos === null ? null : "fontes em conflito ou custo suspeito",
        title: "Anúncios com dado suspeito (fontes em conflito, custo ≥ preço). Clique para filtrar.",
      }),
    ].join("");
    realizedLine();

    var partes = [];
    if (isSnapshotMode()) {
      var listings = state.snapshot && state.snapshot.kpis && state.snapshot.kpis.listings;
      if (listings) partes.push(listings.total + " anúncios · " + listings.active + " ativos · " + listings.paused + " pausados");
      if (state.snapshot) partes.push(atualizadoTexto(state.snapshot.lastCalculatedAt));
    } else if (state.data) {
      partes.push(coverageLabel(state.data.coverage));
      partes.push(atualizadoTexto(state.data.lastUpdated));
    } else if (state.loading) {
      partes.push("Carregando leitura…");
    }
    refs.summaryLine.textContent = partes.join(" · ");
  }

  // "Atualizado dd/mm hh:mm" com a data real; sem data (ou inválida): "sem data registrada" — nunca "Atualizado —".
  function atualizadoTexto(valor) {
    var texto = valor ? formatShortDateTime(valor) : "—";
    return texto === "—" ? "Atualizado: sem data registrada" : "Atualizado " + texto;
  }

  function formatShortDateTime(value) {
    var d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  /** Problemas reais de dado (não o que é pendência permanente como Mercado Pago). */
  function healthIssues() {
    var issues = [];
    if (!state.client) return issues;
    if (isSnapshotMode()) {
      var snap = state.snapshot || {};
      if (state.awaitingAccount) issues.push({ tone: "warn", text: "Escolha a operação (conta) para ler a margem persistida." });
      if (snap.state === "missing") issues.push({ tone: "danger", text: "Leitura ainda não calculada para esta conta." });
      var ultimo = state.refreshRun && contract.isRunTerminal(state.refreshRun.status) ? state.refreshRun : snap.lastRun;
      if (ultimo && ultimo.status === "failed" && !runEmAndamento()) issues.push({ tone: "danger", text: "A última atualização falhou (valores do último snapshot válido)." });
      if (snap.kpis && snap.kpis.refresh && snap.kpis.refresh.failed > 0) issues.push({ tone: "warn", text: snap.kpis.refresh.failed + " item(ns) não recalculados na última atualização." });
      var fresh = state.realizado && state.realizado.freshness;
      if (fresh && fresh.state === "PARCIAL") issues.push({ tone: "warn", text: "Realizado parcial: vendas sincronizadas até " + (formatDateBr(fresh.syncedUntil) || "—") + "." });
      if (fresh && fresh.state === "SEM_SINCRONIZACAO") issues.push({ tone: "warn", text: "Nenhuma venda sincronizada no período." });
      if (state.realizadoError) issues.push({ tone: "warn", text: state.realizadoError });
      var counts = snap.kpis && snap.kpis.counts;
      if (counts && (counts.UNVALIDATED || counts.SUSPECT_DATA)) {
        issues.push({ tone: "warn", text: (counts.UNVALIDATED || 0) + " não validados · " + (counts.SUSPECT_DATA || 0) + " com dados suspeitos." });
      }
    } else if (state.data) {
      if (state.data.partial) issues.push({ tone: "warn", text: "Cobertura parcial: " + coverageLabel(state.data.coverage) + "." });
      var integ = contract.summarizeItems(state.data.items).integrity;
      if (integ.MISSING || integ.SUSPECT) issues.push({ tone: "warn", text: (integ.MISSING || 0) + " não validados · " + (integ.SUSPECT || 0) + " com dados suspeitos." });
    }
    if (state.error) issues.push({ tone: "danger", text: state.error });
    return issues;
  }

  function renderHealth() {
    if (!refs.health) return;
    var issues = healthIssues();
    var tone = issues.some(function (i) { return i.tone === "danger"; }) ? "danger" : issues.length ? "warn" : state.data ? "ok" : "off";
    refs.healthDot.className = "cm-health-dot is-" + tone;
    refs.healthCount.textContent = issues.length ? String(issues.length) : "";
    refs.healthToggle.setAttribute("aria-expanded", state.healthOpen ? "true" : "false");
    refs.healthToggle.title = issues.length ? issues.map(function (i) { return i.text; }).join("\n") : "Fontes, cobertura, integridade e freshness sem problemas.";
    refs.health.hidden = !state.healthOpen;
    refs.healthIssues.innerHTML = issues.length
      ? issues.map(function (i) { return '<li class="cm-health__issue is-' + i.tone + '">' + escapeHtml(i.text) + "</li>"; }).join("")
      : (state.data ? '<li class="cm-health__issue is-ok">Tudo certo com as fontes desta leitura.</li>' : "");
  }

  function renderViewToggle() {
    if (!refs.view) return;
    Array.prototype.forEach.call(refs.view.querySelectorAll("[data-view]"), function (button) {
      var active = button.getAttribute("data-view") === state.view;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    var promocoes = state.view === "promotions";
    refs.compbar.hidden = state.view !== "composition";
    // Na aba Promoções a barra de busca/filtros da tabela e a fila de divergências
    // não se aplicam: cada aba mostra só o que decide dentro dela.
    refs.sheetToolbar.hidden = promocoes;
    refs.tableHost.hidden = promocoes;
    refs.divergencesSection.hidden = state.view !== "composition";
    refs.promos.hidden = !promocoes;
  }

  /** Chip "Próxima ação" da worklist: abre o produto já no contexto da ação. */
  function abrirProximaAcao(chip) {
    var kind = chip.getAttribute("data-next-kind");
    var id = chip.getAttribute("data-next-item");
    if (kind === "custo" || kind === "dados") {
      openDrawer(id, "evidence", chip.getAttribute("data-next-variable") || "cost", chip);
      return;
    }
    var opts = {};
    if (kind === "subir") opts.novoPreco = Number(chip.getAttribute("data-next-price"));
    if (kind === "promo") opts.promoId = chip.getAttribute("data-next-promo");
    openDrawer(id, "pricing", null, chip, opts);
  }

  function setView(view) {
    if (view !== "operational" && view !== "composition" && view !== "promotions") return;
    state.view = view;
    renderViewToggle();
    renderSheet();
    if (view === "promotions" && !state.opps) loadOpportunities();
    if (state.selectedItemId) markSelectedRow();
  }

  // ---------------------------------------------------------------------------
  // Promoções (aba) — fonte bulk persistida; uma leitura por conta/período
  // ---------------------------------------------------------------------------

  // Promoções vêm do Promo Snapshot da conta, mantido pelo backend. Enquanto
  // a conta sincroniza (primeira leitura ou revalidação em background), a
  // lista é relida de tempos em tempos — sem nenhuma chamada ao ML daqui.
  var OPPS_POLL_MS = 20000;
  var OPPS_POLL_MAX = 30;
  // Página pedida ao servidor: o servidor calcula (mesmo cálculo do simulador),
  // ordena e fatia — a Central nunca recebe a lista inteira para fatiar aqui.
  var OPPS_LIMIT = 20;

  var VEREDITO_UI = {
    entrar: { label: "Vale entrar", tone: "is-success" },
    entrar_se_girar: { label: "Só se vender mais", tone: "is-warning" },
    nao_entrar: { label: "Não vale", tone: "is-danger" },
    bloqueado: { label: "Bloqueado", tone: "is-neutral" },
    ativa: { label: "Em vigor", tone: "is-info" },
  };

  // Motivos do núcleo em português (só exibição; código desconhecido aparece como veio).
  var MOTIVO_UI = {
    sem_snapshot_margem: "sem leitura de margem do anúncio",
    preco_atual_ausente: "preço atual ausente",
    custo_ausente: "custo ausente",
    aliquota_ausente: "imposto ausente",
    aliquota_fora_da_faixa: "alíquota fora da faixa",
    comissao_atual_ausente: "comissão atual ausente",
    frete_atual_ausente: "frete atual ausente",
    preco_cenario_invalido: "preço do cenário inválido",
    comissao_indisponivel: "tarifa do Mercado Livre indisponível",
    frete_indisponivel: "frete do Mercado Livre indisponível",
    limite_de_cotacoes_excedido: "limite de cotações atingido",
    sem_desconto_efetivo: "não baixa o preço",
    promocao_sem_preco: "promoção sem preço sugerido",
    rebate_ambiguo: "mais de uma promoção com retorno em andamento",
    rebate_atual_indisponivel: "retorno atual indisponível",
    lc_nao_positivo: "LC por unidade não positivo",
    lc_por_unidade_cai: "LC por unidade cai",
    margem_abaixo_da_meta: "margem abaixo da meta",
    margem_abaixo_do_minimo: "margem abaixo do mínimo",
    sem_preco_cheio: "sem preço cheio para calcular quem banca o desconto",
    preco_acima_do_cheio: "o preço está acima do preço cheio: não é desconto",
    retorno_maior_que_desconto: "o retorno do Mercado Livre é maior que o desconto sobre o preço cheio",
    sem_preco_viavel: "sem preço viável para a meta",
    meta_inviavel: "a meta não é atingível com estes custos",
    dados_ausentes: "faltam dados para calcular",
  };

  function motivoTexto(codigo) {
    return codigo ? (MOTIVO_UI[codigo] || String(codigo).replace(/_/g, " ")) : "";
  }

  function oppsSincronizando(o) {
    if (promoFonte && o && o.fontePromocoes) return promoFonte.sincronizando(o.fontePromocoes, o.sync && o.sync.autoTrigger);
    var sync = o && o.sync;
    return Boolean(sync && (sync.state === "syncing" || (sync.state === "never_synced" && sync.autoTrigger === "enfileirado")));
  }

  /** Linha de fonte das promoções (aba e Bancada): "" sem fontePromocoes. */
  function promoFonteLinha(fp) {
    return promoFonte && fp ? promoFonte.linha(fp, { formatDate: formatShortDateTime }) : "";
  }

  function oppsParams(cotacao) {
    return {
      clientSlug: state.client.slug,
      clienteContaId: state.contaId,
      periodo: state.periodParam || undefined,
      page: Math.max(1, Number(state.oppsPage) || 1),
      limit: OPPS_LIMIT,
      veredito: state.oppsFilters.veredito || undefined,
      tipo: state.oppsFilters.tipo || undefined,
      cotacao: cotacao || undefined,
    };
  }

  function loadOpportunities(poll) {
    if (state.oppsPollTimer) { root.clearTimeout(state.oppsPollTimer); state.oppsPollTimer = null; }
    if (!isSnapshotMode() || !state.client || !state.contaId || typeof api.getOpportunities !== "function") {
      state.opps = null;
      state.oppsLive = "idle";
      renderPromotions();
      return;
    }
    if (!poll) state.oppsPolls = 0;
    state.oppsSequence += 1;
    var seq = state.oppsSequence;
    var slug = state.client.slug;
    var conta = state.contaId;
    var contexto = function () { return seq === state.oppsSequence && state.client && state.client.slug === slug && state.contaId === conta; };
    // Releitura silenciosa: mantém a lista atual na tela enquanto busca.
    if (!poll || !state.opps || state.opps.status !== "ok") {
      state.opps = { status: "loading" };
      state.oppsLive = "idle";
      renderPromotions();
    }
    var page = Math.max(1, Number(state.oppsPage) || 1);
    api.getOpportunities(oppsParams("estimada")).then(function (result) {
      if (!contexto()) return;
      // Página que deixou de existir (lista encolheu entre releituras): vai
      // para a última página real.
      if (result.ok && page > 1 && Number(result.total) >= 0 && (!result.oportunidades || !result.oportunidades.length)) {
        var ultima = Math.max(1, Math.ceil(Number(result.total || 0) / (Number(result.limit) || OPPS_LIMIT)));
        if (ultima < page) { state.oppsPage = ultima; loadOpportunities(poll); return; }
      }
      if (result.ok && Number(result.page) >= 1) state.oppsPage = Number(result.page);
      state.opps = result.ok ? Object.assign({ status: "ok" }, result) : { status: "error", error: result.error };
      state.oppsLive = "idle";
      renderPromotions();
      if (result.ok && result.disponivel && result.oportunidades && result.oportunidades.length && !oppsSincronizando(result)) {
        refineOpportunities(contexto);
      }
      if (result.ok && oppsSincronizando(result) && (state.oppsPolls || 0) < OPPS_POLL_MAX) {
        state.oppsPolls = (state.oppsPolls || 0) + 1;
        state.oppsPollTimer = root.setTimeout(function () {
          state.oppsPollTimer = null;
          if (!contexto()) return;
          loadOpportunities(true);
        }, OPPS_POLL_MS);
      }
    });
  }

  // Resumo das promoções (KPI "Promos com +LC" e chips "Promo Y +R$ Z" da worklist):
  // UMA leitura estimada dos 50 anúncios que mais valem entrar. Roda ao abrir a
  // conta — não depende da aba — e nunca consulta o Mercado Livre.
  function loadPromoSummary() {
    if (!isSnapshotMode() || !state.client || !state.contaId || typeof api.getOpportunities !== "function") {
      state.promoSummary = null;
      state.promoTop = {};
      renderTop();
      return;
    }
    state.promoSummarySeq += 1;
    var seq = state.promoSummarySeq;
    var slug = state.client.slug;
    var conta = state.contaId;
    state.promoSummary = { status: "loading" };
    renderTop();
    api.getOpportunities({
      clientSlug: slug, clienteContaId: conta, periodo: state.periodParam || undefined,
      page: 1, limit: 50, veredito: "entrar", cotacao: "estimada",
    }).then(function (result) {
      if (seq !== state.promoSummarySeq || !state.client || state.client.slug !== slug || state.contaId !== conta) return;
      if (result.ok && result.disponivel) {
        state.promoSummary = { status: "ok", resumo: result.resumo || { entrar: 0, impacto_lc: 0, com_historico: 0, sem_historico: 0 } };
        var topo = {};
        (result.oportunidades || []).forEach(function (op) { topo[op.itemId] = op; });
        state.promoTop = topo;
      } else {
        state.promoSummary = {
          status: result.ok ? "indisponivel" : "erro",
          motivo: result.ok ? (oppsSincronizando(result) ? "sincronizando promoções…" : "sem promoções sincronizadas") : "promoções indisponíveis",
          mensagem: result.ok ? result.mensagem : result.error,
        };
        state.promoTop = {};
      }
      renderTop();
      redrawWorklist();
    });
  }

  // As chips da worklist dependem do resumo: redesenha a tabela sem perder o foco do drawer.
  function redrawWorklist() {
    if (!state.data || state.view !== "operational") return;
    var focoItem = state.previousFocus && state.previousFocus.closest ? state.previousFocus.closest("tr[data-item-id]") : null;
    var focoId = focoItem ? focoItem.getAttribute("data-item-id") : null;
    renderSheet();
    if (focoId) {
      var novaLinha = refs.tableHost.querySelector('tr[data-item-id="' + focoId.replace(/"/g, '\\"') + '"]');
      if (novaLinha) state.previousFocus = novaLinha;
    }
  }

  // Segunda etapa: a MESMA página, cotada ao vivo (comissão e frete reais em P').
  // A tela já mostra a estimativa; aqui só os números e o veredito ficam exatos.
  function refineOpportunities(contexto) {
    state.oppsLive = "loading";
    renderPromotionsLive();
    api.getOpportunities(oppsParams("viva")).then(function (result) {
      if (!contexto()) return;
      if (result.ok) {
        state.opps = Object.assign({ status: "ok" }, result);
        state.oppsLive = "ok";
      } else {
        // A estimativa continua na tela, dita como estimativa.
        state.oppsLive = "error";
      }
      renderPromotions();
    });
  }

  function oppsSyncTexto(o) {
    var sync = o.sync || {};
    if (sync.state === "syncing") return sync.total ? "atualizando (" + formatInt(sync.processed || 0) + "/" + formatInt(sync.total) + ")" : "atualizando";
    if (sync.state === "failed") return "última atualização falhou";
    if (sync.state === "stale") return "desatualizado, atualizando";
    return "";
  }

  /** Expande/recolhe o detalhe (Hoje × Promo) de UMA linha, sem redesenhar a tabela. */
  function alternarDetalhePromo(linha) {
    var id = linha.getAttribute("data-opp");
    state.promoDetail[id] = !state.promoDetail[id];
    linha.classList.toggle("is-open", state.promoDetail[id]);
    linha.setAttribute("aria-expanded", state.promoDetail[id] ? "true" : "false");
    var detalhes = refs.oppsHost.querySelectorAll("tr[data-promo-detail]");
    Array.prototype.forEach.call(detalhes, function (d) {
      if (d.getAttribute("data-promo-detail") !== id) return;
      var celula = d.firstElementChild;
      if (state.promoDetail[id]) {
        var lista = state.opps && state.opps.status === "ok" ? state.opps.oportunidades || [] : [];
        var op = lista.filter(function (x) { return x.itemId === id; })[0];
        celula.innerHTML = op ? promoDetalheConteudoHtml(op) : "";
      } else {
        celula.innerHTML = "";
      }
      d.hidden = !state.promoDetail[id];
    });
  }

  function setPromotionsFilters() {
    if (!refs.promoVeredito) return;
    refs.promoVeredito.value = state.oppsFilters.veredito || "";
    // Mantém os tipos da última resposta boa enquanto uma nova leitura carrega
    // (o seletor não pode perder as opções no meio de uma troca de filtro).
    if (state.opps && state.opps.status === "ok" && state.opps.tipos) state.oppsTipos = state.opps.tipos;
    var tipos = state.oppsTipos || [];
    var atual = state.oppsFilters.tipo || "";
    var opcoes = '<option value="">Tipo: todos</option>' + tipos.map(function (t) {
      return '<option value="' + escapeHtml(t.tipo) + '">' + escapeHtml(t.tipo) + " (" + formatInt(t.total) + ")</option>";
    }).join("");
    if (atual && !tipos.some(function (t) { return String(t.tipo).toLowerCase() === atual.toLowerCase(); })) {
      opcoes += '<option value="' + escapeHtml(atual) + '">' + escapeHtml(atual) + "</option>";
    }
    if (refs.promoTipo.getAttribute("data-built") !== opcoes) {
      refs.promoTipo.innerHTML = opcoes;
      refs.promoTipo.setAttribute("data-built", opcoes);
    }
    refs.promoTipo.value = atual;
  }

  // Origem dos NÚMEROS da linha (o servidor diz: numeros.origem). Nunca se rotula "ao vivo" o que não é:
  //   simular     — cotação real completa sobre a lista do Promo Snapshot = o mesmo resultado do simulador;
  //   estimativa  — comissão/frete do snapshot (sem consulta ao ML) ou promoção vinda do diagnóstico legado;
  //   bloqueado   — a cotação foi tentada e não veio completa (nada foi estimado).
  var NUMEROS_MOTIVO_UI = {
    comissao_e_frete_do_snapshot: "comissão e frete do snapshot, sem consulta ao Mercado Livre",
    lista_do_diagnostico_legado: "a promoção vem do diagnóstico legado, que o simulador não lê",
    cotacao_indisponivel: "a cotação ao vivo não veio completa para este preço",
  };

  function numerosDaPagina() {
    var o = state.opps;
    var linhas = o && o.status === "ok" ? (o.oportunidades || []) : [];
    var contagem = { total: linhas.length, simular: 0, estimativa: 0, bloqueado: 0, primeiroMotivo: null };
    linhas.forEach(function (l) {
      var origem = l.numeros && l.numeros.origem;
      if (origem === "simular") contagem.simular += 1;
      else if (origem === "bloqueado") contagem.bloqueado += 1;
      else contagem.estimativa += 1;
      if (origem !== "simular" && !contagem.primeiroMotivo && l.numeros && l.numeros.motivo) contagem.primeiroMotivo = l.numeros.motivo;
    });
    return contagem;
  }

  // Segunda linha do badge: "Números: …" — só diz "cotação ao vivo" quando TODA linha da página é do simulador.
  function renderPromotionsLive() {
    if (!refs.promosLive) return;
    var c = numerosDaPagina();
    var texto = "";
    if (state.oppsLive === "loading") texto = "Números: cotando a página ao vivo no Mercado Livre…";
    else if (state.oppsLive === "error") texto = "Números: estimativa — a cotação ao vivo está indisponível agora";
    else if (state.oppsLive === "ok") {
      var bloqueadas = c.bloqueado ? " · " + c.bloqueado + (c.bloqueado === 1 ? " linha bloqueada" : " linhas bloqueadas") + " (a cotação não veio completa)" : "";
      if (c.simular > 0 && c.estimativa === 0) texto = "Números: cotação ao vivo · comissão e frete reais em cada preço (mesmo cálculo do simulador)" + bloqueadas;
      else if (c.simular > 0) texto = "Números: cotação ao vivo em " + c.simular + " de " + c.total + " linhas · " + c.estimativa + (c.estimativa === 1 ? " marcada" : " marcadas") + " como estimativa" + bloqueadas;
      else if (c.total) texto = "Números: estimativa — " + (NUMEROS_MOTIVO_UI[c.primeiroMotivo] || "não vieram do simulador");
    } else if (c.total) {
      texto = "Números: estimativa — " + (NUMEROS_MOTIVO_UI[c.primeiroMotivo] || NUMEROS_MOTIVO_UI.comissao_e_frete_do_snapshot);
    }
    refs.promosLive.textContent = texto;
    refs.promosLive.setAttribute("data-cm-live", state.oppsLive || "idle");
    refs.promosLive.setAttribute("data-cm-numeros", c.simular > 0 && c.estimativa === 0 && state.oppsLive === "ok" ? "simular" : c.total ? "estimativa" : "");
  }

  function veredictoChipHtml(veredito) {
    var ui = VEREDITO_UI[veredito] || VEREDITO_UI.bloqueado;
    return '<span class="vf-status ' + ui.tone + '" data-cm-veredito="' + escapeHtml(veredito || "bloqueado") + '">' + escapeHtml(ui.label) + "</span>";
  }

  // "antes → depois" em duas linhas: antes em cinza, depois forte; o Δ vai em chip (verde/vermelho) quando existe.
  function antesDepois(antes, depois, extraHtml, depoisClasse) {
    return '<span class="cm-2l"><span class="cm-2l__antes">' + escapeHtml(antes || "—") + '</span><span class="cm-2l__depois' + (depoisClasse ? " " + depoisClasse : "") + '">' + escapeHtml(depois || "—") + "</span>" + (extraHtml || "") + "</span>";
  }

  function chipDelta(valor, texto, attr) {
    if (valor === null || valor === undefined || !texto) return "";
    var tom = valor > 0 ? "is-good" : valor < 0 ? "is-bad" : "";
    return '<span class="cm-chip-delta ' + tom + '"' + (attr ? " " + attr : "") + ">" + escapeHtml(texto) + "</span>";
  }

  function ppTexto(delta) {
    var n = contract.numberOrNull(delta);
    if (n === null) return null;
    return (n > 0 ? "+" : "") + (n * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + " pp";
  }

  // Quem banca é medido contra o preço CHEIO. Sem ele, o seller banca é "—" e o motivo é dito;
  // banca negativa nunca aparece sem o aviso do porquê.
  function bancaAvisoHtml(r) {
    var codigo = r && (r.banca_aviso || r.banca_motivo);
    if (!codigo) return "";
    return ' <span class="cm-promo-flag is-warn" data-cm-banca-aviso="' + escapeHtml(codigo) + '" title="' + escapeHtml(motivoTexto(codigo)) + '">⚠</span>';
  }

  // Marcas que explicam a linha (só o essencial na linha; o resto vai no detalhe expandido).
  function promoFlagsHtml(op) {
    var flags = op.flags || {};
    var itens = [];
    if (flags.mudou_faixa_frete === true) itens.push('<span class="cm-promo-flag is-warn" data-cm-flag="faixa-frete" title="O frete do Mercado Livre muda neste preço.">⚠ muda faixa de frete</span>');
    if (flags.sem_historico) itens.push('<span class="cm-promo-flag" data-cm-flag="sem-historico" title="Sem vendas no período: o impacto é por unidade.">sem histórico</span>');
    if (flags.ativa) itens.push('<span class="cm-promo-flag" data-cm-flag="ativa">ativa</span>');
    if (flags.rebate_ambiguo) itens.push('<span class="cm-promo-flag is-warn" data-cm-flag="rebate-ambiguo">retorno ambíguo</span>');
    if (op.veredito === "bloqueado") {
      itens.push('<span class="cm-promo-flag is-warn" data-cm-flag="bloqueado">bloqueado · ' + escapeHtml(motivoTexto(op.veredito_motivo) || "sem motivo informado") + "</span>");
    } else if (op.veredito === "entrar_se_girar" && op.empate_volume !== null && op.empate_volume !== undefined) {
      itens.push('<span class="cm-promo-flag" data-cm-flag="empate" title="Volume a mais para empatar o LC total de hoje.">precisa vender ' + escapeHtml(formatPercent(op.empate_volume, true)) + "</span>");
    } else if (op.veredito_motivo) {
      itens.push('<span class="cm-promo-flag">' + escapeHtml(motivoTexto(op.veredito_motivo)) + "</span>");
    }
    if (op.estimado) itens.push('<span class="cm-promo-flag" data-cm-flag="estimado" title="' + escapeHtml(((op.numeros && NUMEROS_MOTIVO_UI[op.numeros.motivo]) || "Números estimados") + ".") + '">estimativa</span>');
    return itens.length ? '<div class="cm-promo-flags">' + itens.join("") + "</div>" : "";
  }

  function freteCelula(op) {
    var atual = op.atual || {};
    var cen = op.cenario || {};
    // "a cotar" só enquanto o frete não foi cotado; cotação tentada que falhou diz "indisponível" (nada é estimado).
    var viva = op.cotacao && (op.cotacao.ao_vivo === true || op.cotacao.falhou === true);
    var aviso = op.flags && op.flags.mudou_faixa_frete === true
      ? ' <span class="cm-promo-flag is-warn" data-cm-flag="faixa-frete" title="O frete do Mercado Livre muda neste preço.">⚠</span>' : "";
    if (!viva) {
      return antesDepois(formatMoney(atual.frete), "a cotar", "", "is-pendente");
    }
    var depois = cen.frete === null || cen.frete === undefined ? "indisponível" : formatMoney(cen.frete);
    return '<span class="cm-2l"><span class="cm-2l__antes">' + escapeHtml(formatMoney(atual.frete) || "—") + '</span><span class="cm-2l__depois">' + escapeHtml(depois) + aviso + "</span></span>";
  }

  // Por que o Participar está (ou não) liberado: só entrar / entrar_se_girar E "Pode participar pelo VenForce".
  function participarSpec(promo, veredito, motivo) {
    promo = promo || {};
    var base = { disabled: true, title: "" };
    if (promo.grupo === "ativa") return Object.assign(base, { title: "Esta promoção já está ativa neste anúncio." });
    if (promo.grupo === "participa") return Object.assign(base, { title: "Você já participa desta promoção (ela não forma o preço agora)." });
    if (promo.grupo !== "pode") return Object.assign(base, { title: (promo.escrita && promo.escrita.motivo) || "Só pelo Mercado Livre: a inscrição é feita no painel do Mercado Livre." });
    // Lista do diagnóstico legado = estimativa: sem leitura atual do ML, não dá para participar (igual à Bancada).
    if (promoEhEstimativa(promo)) return Object.assign(base, { title: MOTIVO_ESTIMATIVA });
    if (veredito === "bloqueado") return Object.assign(base, { title: "Bloqueado: " + (motivoTexto(motivo) || "sem motivo informado") + "." });
    if (veredito === "nao_entrar") return Object.assign(base, { title: "Veredito “Não entrar”: " + (motivoTexto(motivo) || "a promoção não compensa") + "." });
    if (veredito !== "entrar" && veredito !== "entrar_se_girar") return Object.assign(base, { title: "Sem veredito para participar." });
    return { disabled: false, title: "Abre o preview da participação (relê a promoção ao vivo e avalia os gates)." };
  }

  function acoesPromoHtml(itemId, promo, veredito, motivo, ghost) {
    var spec = participarSpec(promo, veredito, motivo);
    var promoId = promo && promo.id ? promo.id : "";
    return '<span class="cm-promo-acoes">' +
      '<button class="vf-btn vf-btn--sm' + (ghost ? " vf-btn--ghost" : "") + '" type="button" data-opp-item="' + escapeHtml(itemId) + '" data-promo-id="' + escapeHtml(promoId) + '">Simular</button>' +
      '<button class="vf-btn vf-btn--sm vf-btn--primary" type="button" data-opp-participar="' + escapeHtml(itemId) + '" data-promo-id="' + escapeHtml(promoId) + '"' +
        (spec.disabled ? " disabled" : "") + ' title="' + escapeHtml(spec.title) + '">Participar</button></span>';
  }

  // Fonte da lista e origem dos números, desta linha.
  function origemLinhaHtml(op) {
    var lista = op.lista || {};
    var origemLista = lista.fonte === "diagnostico_legado" ? "diagnóstico legado" : "Promo Snapshot";
    var quando = lista.observada_em ? formatShortDateTime(lista.observada_em) : null;
    if (!quando || quando === "—") quando = "data desconhecida";
    var num = op.numeros || {};
    var numerosTxt = num.origem === "simular"
      ? "cotação ao vivo" + (op.cotacao && op.cotacao.consultado_em ? " às " + formatShortDateTime(op.cotacao.consultado_em) : "") + " (mesmo cálculo do simulador)"
      : num.origem === "bloqueado" ? "cotação ao vivo incompleta — " + (NUMEROS_MOTIVO_UI[num.motivo] || "sem números")
        : "estimativa — " + (NUMEROS_MOTIVO_UI[num.motivo] || "não vieram do simulador");
    return '<p class="cm-promo-origem" data-cm-origem-linha="' + escapeHtml(num.origem || "") + '">Lista: ' + escapeHtml(origemLista) + " · " + escapeHtml(quando) + " · Números: " + escapeHtml(numerosTxt) + ".</p>";
  }

  // Detalhe expansível: o MESMO componente de detalhe da Bancada (resposta → Hoje × Cenário →
  // de onde sai a diferença → Ver conta completa); à direita, quem banca, empate e a origem da linha.
  function promoDetalheConteudoHtml(op) {
    // `op` (oportunidades) usa `veredito_motivo`; o detalhe espera `motivo` (/simular) — normaliza na borda.
    var r = Object.assign({}, op, { motivo: op.veredito_motivo });
    return '<div class="cm-promo-detail__grid">' +
      '<div class="cm-promo-detail__esq">' + cenarioDetalheHtml(r, op.atual, null, { bancaFora: true }) + "</div>" +
      '<div class="cm-promo-detail__dir">' + bancaRodapeHtml(op) + empateHtml(op) + promoFlagsHtml(op) + origemLinhaHtml(op) + "</div></div>";
  }

  // O conteúdo só existe enquanto a linha está aberta (nada de cascatas escondidas no DOM).
  function promoDetalheHtml(op, aberto) {
    return '<tr class="cm-promo-detail" data-promo-detail="' + escapeHtml(op.itemId) + '"' + (aberto ? "" : " hidden") + '><td colspan="8">' + (aberto ? promoDetalheConteudoHtml(op) : "") + "</td></tr>";
  }

  function promoRowHtml(op) {
    var atual = op.atual || {};
    var cen = op.cenario || {};
    var promo = op.promocao || {};
    var aberto = state.promoDetail[op.itemId] === true;
    var flags = op.flags || {};
    var quando = promo.herdada ? formatShortDateTime(promo.observadaEm) : null;
    var herdada = promo.herdada
      ? '<span class="cm-prod-meta cm-opps-herdada" title="A leitura desta promoção falhou na última atualização; mostrando a leitura anterior' +
        (quando ? " (" + escapeHtml(quando) + ")" : "") + '.">leitura anterior' + (quando ? " · " + escapeHtml(quando) : "") + "</span>"
      : "";
    var mais = op.opcoes_total > 1
      ? '<button class="cm-promo-more" type="button" data-promo-more="' + escapeHtml(op.itemId) + '" aria-expanded="' + (state.promoExpanded[op.itemId] ? "true" : "false") + '">+' + (op.opcoes_total - 1) + (op.opcoes_total - 1 === 1 ? " opção" : " opções") + "</button>"
      : "";
    var unidades = op.unidades === null || op.unidades === undefined
      ? unavailable("vendas —", "Vendas indisponíveis neste período (a leitura da Central de Vendas falhou).")
      : escapeHtml(formatInt(op.unidades) + " un. no período");
    var semHist = flags.sem_historico ? ' <span class="cm-promo-flag" data-cm-flag="sem-historico" title="Sem vendas no período: o impacto é por unidade.">sem histórico</span>' : "";
    var estimativa = op.estimado
      ? ' <span class="cm-promo-flag" data-cm-flag="estimado" title="' + escapeHtml(((op.numeros && NUMEROS_MOTIVO_UI[op.numeros.motivo]) || "Números estimados") + ".") + '">estimativa</span>' : "";

    var banca = (op.seller_banca === null || op.seller_banca === undefined) && (op.ml_banca === null || op.ml_banca === undefined)
      ? "—" + bancaAvisoHtml(op)
      : '<span class="cm-2l" data-cm-banca-dupla title="Você banca / ML banca"><span class="cm-2l__depois">' + escapeHtml(formatMoney(op.seller_banca) || "—") + bancaAvisoHtml(op) + '</span><span class="cm-2l__antes">' + escapeHtml(formatMoney(op.ml_banca) || "—") + "</span></span>";

    var precoChip = op.desconto_ratio !== null && op.desconto_ratio !== undefined
      ? '<span class="cm-chip-delta" data-cm-desc-pct title="Desconto sobre o preço cheio' + (op.delta_preco_atual !== null && op.delta_preco_atual !== undefined ? " · contra o preço de hoje: " + escapeHtml(formatMoney(-op.delta_preco_atual, true) || "R$ 0,00") : "") + '">' + (op.desconto_ratio < 0 ? "+" : "−") + escapeHtml(formatPercent(Math.abs(op.desconto_ratio))) + "</span>"
      : "";
    var margemClasse = marginClass(cen.margem_ratio === undefined ? null : cen.margem_ratio, {});

    // Linha curta sob o veredito: o motivo do bloqueio, o volume de empate ou o motivo do veredito.
    var nota = "";
    if (op.veredito === "bloqueado") nota = '<span class="cm-promo-nota is-warn" data-cm-flag="bloqueado" title="' + escapeHtml("Bloqueado: " + (motivoTexto(op.veredito_motivo) || "sem motivo informado")) + '">bloqueado · ' + escapeHtml(motivoTexto(op.veredito_motivo) || "sem motivo informado") + "</span>";
    else if (op.veredito === "entrar_se_girar" && op.empate_volume !== null && op.empate_volume !== undefined) nota = '<span class="cm-promo-nota" data-cm-flag="empate" title="Volume a mais para empatar o LC total de hoje.">precisa vender ' + escapeHtml(formatPercent(op.empate_volume, true)) + "</span>";
    else if (op.veredito_motivo) nota = '<span class="cm-promo-nota" title="' + escapeHtml(motivoTexto(op.veredito_motivo)) + '">' + escapeHtml(motivoTexto(op.veredito_motivo)) + "</span>";

    return '<tr class="cm-promo-row' + (aberto ? " is-open" : "") + '" data-opp="' + escapeHtml(op.itemId) + '" tabindex="0" aria-expanded="' + (aberto ? "true" : "false") + '" data-cm-numeros="' + escapeHtml((op.numeros && op.numeros.origem) || "") + '">' +
      '<td class="cm-c-produto"><strong class="cm-clamp2" title="' + escapeHtml(op.titulo) + '">' + escapeHtml(op.titulo) + '</strong><span class="cm-prod-meta">' + escapeHtml(op.itemId) + " · " + unidades + semHist + "</span></td>" +
      '<td class="cm-c-promo"><strong class="cm-clamp2" title="' + escapeHtml(promo.nome || promo.tipo || "—") + '">' + escapeHtml(promo.nome || promo.tipo || "—") + '</strong><span class="cm-prod-meta">' + escapeHtml(promo.tipo || "") + estimativa + "</span>" + herdada + mais + "</td>" +
      '<td class="num cm-c-preco">' + antesDepois(formatMoney(op.precoAtual), formatMoney(op.precoPromocao), precoChip) + "</td>" +
      '<td class="num cm-c-banca" data-cm-banca>' + banca + "</td>" +
      '<td class="num" data-cm-frete>' + freteCelula(op) + "</td>" +
      '<td class="num" data-cm-lc>' + antesDepois(formatMoney(atual.lc), formatMoney(cen.lc), chipDelta(op.delta_lc, op.delta_lc === null || op.delta_lc === undefined ? null : "Δ " + formatMoney(op.delta_lc, true), "data-cm-delta-lc")) + "</td>" +
      '<td class="num" data-cm-margem>' + antesDepois(formatPercent(atual.margem_ratio), formatPercent(cen.margem_ratio), chipDelta(op.delta_margem_ratio, ppTexto(op.delta_margem_ratio)), margemClasse) + "</td>" +
      '<td class="cm-c-veredito">' + veredictoChipHtml(op.veredito) + nota + acoesPromoHtml(op.itemId, promo, op.veredito, op.veredito_motivo, false) + "</td></tr>" +
      promoDetalheHtml(op, aberto) +
      promoOptionsHtml(op);
  }

  // Outras promoções do mesmo anúncio (linha expansível).
  function promoOptionsHtml(op) {
    if (!(op.opcoes && op.opcoes.length)) return "";
    var aberto = state.promoExpanded[op.itemId] === true;
    return '<tr class="cm-promo-options" data-promo-options="' + escapeHtml(op.itemId) + '"' + (aberto ? "" : " hidden") + '><td colspan="8"><table class="vf-table vf-table--compact"><tbody>' +
      op.opcoes.map(function (opcao) {
        var promo = opcao.promocao || {};
        return '<tr data-promo-option="' + escapeHtml(promo.id || "") + '">' +
          "<td>" + escapeHtml(promo.nome || promo.tipo || "—") + '<span class="cm-prod-meta">' + escapeHtml(promo.tipo || "") + "</span></td>" +
          '<td class="num">' + escapeHtml(formatMoney(opcao.precoPromocao) || "—") + "</td>" +
          '<td class="num">' + (opcao.delta_lc === null || opcao.delta_lc === undefined ? "—" : escapeHtml("Δ " + formatMoney(opcao.delta_lc, true))) + "</td>" +
          '<td class="num">' + escapeHtml(formatPercent(opcao.margemDepois) || "—") + "</td>" +
          "<td>" + veredictoChipHtml(opcao.veredito) + (opcao.veredito === "bloqueado" ? '<span class="cm-promo-flag is-warn"> · ' + escapeHtml(motivoTexto(opcao.veredito_motivo)) + "</span>" : "") + "</td>" +
          '<td class="vf-table__actions">' + acoesPromoHtml(op.itemId, promo, opcao.veredito, opcao.veredito_motivo, true) + "</td></tr>";
      }).join("") + "</tbody></table></td></tr>";
  }

  function renderPromotions() {
    if (!refs.promos) return;
    var ativa = state.view === "promotions";
    refs.promos.hidden = !ativa;
    if (!ativa) return;
    setPromotionsFilters();
    renderPromotionsLive();
    var o = state.opps;
    if (!isSnapshotMode() || state.awaitingAccount || !state.contaId) {
      refs.oppsMeta.textContent = "";
      refs.oppsHost.innerHTML = '<p class="cm-empty-note" data-cm-opps="sem-conta">' +
        escapeHtml(state.awaitingAccount ? "Escolha a operação (conta Mercado Livre) para ver as promoções." : "As promoções são lidas da conta no modo persistido; escolha uma operação para vê-las.") + "</p>";
      refs.resultCount.textContent = "—";
      return;
    }
    if (!o || o.status === "loading") {
      refs.oppsMeta.textContent = "";
      refs.oppsHost.innerHTML = stateHtml("loading", "Carregando promoções…");
      refs.resultCount.textContent = "Carregando…";
      return;
    }
    if (o.status === "error") {
      refs.oppsMeta.textContent = "";
      refs.oppsHost.innerHTML = '<p class="cm-empty-note" role="alert">' + escapeHtml(o.error || "Não foi possível carregar as promoções.") + "</p>";
      refs.resultCount.textContent = "Erro";
      return;
    }
    if (!o.disponivel) {
      var linhaFonte = promoFonteLinha(o.fontePromocoes);
      refs.oppsMeta.textContent = linhaFonte || oppsSyncTexto(o) || "promoções da conta";
      refs.oppsHost.innerHTML = '<p class="cm-empty-note" data-cm-opps="indisponivel" data-cm-opps-sync="' + escapeHtml((o.sync && o.sync.state) || "") + '"' +
        (o.fontePromocoes ? ' data-cm-promo-estado="' + escapeHtml(o.fontePromocoes.estado) + '"' : "") + ">" +
        escapeHtml(linhaFonte || o.mensagem || "Nenhuma promoção sincronizada para esta conta ainda.") + "</p>";
      refs.resultCount.textContent = "—";
      return;
    }
    var fonte = o.fonte || {};
    var origem = fonte.tipo === "diagnostico_legado" ? "diagnóstico legado" : "Promo Snapshot";
    var extra = [];
    if (fonte.frescor === "antigo") extra.push("antigo (>24h)");
    else if (fonte.frescor === "atencao") extra.push("mais de 6h");
    if (fonte.parcial) extra.push("parcial");
    if (fonte.itensHerdados) extra.push(formatInt(fonte.itensHerdados) + " com leitura anterior");
    var syncTxt = oppsSyncTexto(o);
    if (syncTxt) extra.push(syncTxt);
    // Data real da fonte; sem data (ou inválida) diz "data desconhecida" — nunca "—".
    var geradoTxt = fonte.geradoEm ? formatShortDateTime(fonte.geradoEm) : null;
    if (!geradoTxt || geradoTxt === "—") geradoTxt = "data desconhecida";
    // Com fontePromocoes a linha é a da fonte única (a mesma da Bancada); sem ela, o texto de antes.
    refs.oppsMeta.textContent = "Lista: " + (promoFonteLinha(o.fontePromocoes) || (origem + " · " + geradoTxt + (extra.length ? " · " + extra.join(" · ") : "")));
    refs.resultCount.textContent = formatInt(o.total || 0) + (Number(o.total) === 1 ? " anúncio" : " anúncios");
    if (!o.oportunidades || !o.oportunidades.length) {
      var filtrado = state.oppsFilters.veredito || state.oppsFilters.tipo;
      refs.oppsHost.innerHTML = '<p class="cm-empty-note" data-cm-opps="vazio">' + escapeHtml(filtrado
        ? "Nenhuma promoção neste filtro. Ajuste o veredito ou o tipo."
        : "Nenhuma promoção disponível que valha entrar nesta conta (promoções já ativas e as que não baixam o preço não contam).") + "</p>";
      return;
    }
    refs.oppsHost.innerHTML = '<div class="vf-table-wrap cm-opps-wrap"><table class="vf-table vf-table--compact cm-opps-table"><thead><tr>' +
      '<th>Produto</th><th>Promo</th><th class="num">Preço → promo</th><th class="num" title="Você banca / ML banca">Seller / ML</th><th class="num">Frete</th>' +
      '<th class="num">LC/un</th><th class="num">Margem</th><th>Veredito</th>' +
      "</tr></thead><tbody>" + o.oportunidades.map(promoRowHtml).join("") + "</tbody></table></div>" + oppsPagerHtml(o) +
      '<p class="cm-opps-foot">' + escapeHtml(o.criterio || "") + (o.cotacao && o.cotacao.modo === "viva"
        ? " Linhas com cotação ao vivo completa usam o mesmo cálculo do simulador; as marcadas como estimativa, não."
        : " Valores estimados com a taxa de comissão e o frete do snapshot até a cotação ao vivo terminar.") + "</p>";
  }

  // Paginação do SERVIDOR: page/limit/total/hasNext vêm da resposta.
  function oppsPagerHtml(o) {
    var page = Number(o.page) || 1;
    var limit = Number(o.limit) || OPPS_LIMIT;
    var total = Number(o.total);
    if (!Number.isFinite(total)) total = (o.oportunidades || []).length;
    var hasNext = o.hasNext === true;
    if (page <= 1 && !hasNext) return "";
    var ini = (page - 1) * limit + 1;
    var fim = ini + (o.oportunidades || []).length - 1;
    return '<div class="cm-opps-pager" data-cm-opps-pager="' + page + '">' +
      '<span class="cm-opps-pager__range">' + escapeHtml(formatInt(ini) + "–" + formatInt(fim) + " de " + formatInt(total)) + "</span>" +
      '<button class="vf-btn vf-btn--sm vf-btn--ghost" type="button" data-opps-page="' + (page - 1) + '"' + (page <= 1 ? " disabled" : "") + ">Anterior</button>" +
      '<button class="vf-btn vf-btn--sm vf-btn--ghost" type="button" data-opps-page="' + (page + 1) + '"' + (hasNext ? "" : " disabled") + ">Próxima</button>" +
      "</div>";
  }

  function renderActiveFilters() {
    var chips = [];
    if (state.financial) {
      chips.push('<span class="vf-active-filter">Resultado: ' + escapeHtml(contract.FINANCIAL_RESULTS[state.financial].label) +
        '<button type="button" class="vf-active-filter__remove" data-clear-filter="financial" aria-label="Remover filtro de resultado">×</button></span>');
    }
    if (state.integrity) {
      chips.push('<span class="vf-active-filter">Integridade: ' + escapeHtml(contract.INTEGRITY_STATES[state.integrity].label) +
        '<button type="button" class="vf-active-filter__remove" data-clear-filter="integrity" aria-label="Remover filtro de integridade">×</button></span>');
    }
    if (state.listingStatus) {
      chips.push('<span class="vf-active-filter">Status do anúncio: ' + (state.listingStatus === "active" ? "Ativos" : "Pausados") +
        '<button type="button" class="vf-active-filter__remove" data-clear-filter="listingStatus" aria-label="Remover filtro de status do anúncio">×</button></span>');
    }
    refs.activeFilters.innerHTML = chips.join("");
  }

  /**
   * Filtra o WORKSPACE INTEIRO (todos os itens carregados), nunca uma página.
   * Busca, filtro financeiro e filtro de integridade operam sobre o mesmo
   * array que alimenta KPIs e fila de divergências — uma única varredura.
   */
  function filteredItems() {
    var items = state.data ? state.data.items || [] : [];
    // Persistido: a página JÁ veio filtrada/buscada e na ordem de trabalho (worklist) do servidor.
    // O workspace ao vivo (legado) segue na ordem em que foi carregado.
    if (isSnapshotMode()) return items;
    var term = state.search ? state.search.trim().toLowerCase() : "";
    return items.filter(function (item) {
      if (state.financial && contract.financialResult(item).key !== state.financial) return false;
      if (state.integrity && contract.dataIntegrity(item).key !== state.integrity) return false;
      if (term) {
        var haystack = [item.title, item.itemId, item.sku].join(" ").toLowerCase();
        if (haystack.indexOf(term) === -1) return false;
      }
      return true;
    });
  }

  /** Fatia a paginação VISUAL sobre um array já filtrado. Nunca chama a rede. */
  function visibleSlice(items) {
    if (state.visiblePageSize === "all") return items;
    var size = Number(state.visiblePageSize) || 50;
    var totalPages = Math.max(Math.ceil(items.length / size), 1);
    if (state.visiblePage > totalPages) state.visiblePage = totalPages;
    if (state.visiblePage < 1) state.visiblePage = 1;
    var start = (state.visiblePage - 1) * size;
    return items.slice(start, start + size);
  }

  // ---------------------------------------------------------------------------
  // Planilha
  // ---------------------------------------------------------------------------

  function sourceSelectHtml(variableKey) {
    var meta = contract.VARIABLE_META[variableKey];
    var selected = state.selection[variableKey];
    var options = contract.SOURCE_SLOTS[variableKey].map(function (source) {
      return '<option value="' + source + '" title="' + escapeHtml(contract.sourceLabel(source)) + '"' +
        (source === selected ? " selected" : "") + ">" +
        escapeHtml(contract.SOURCE_SELECT_LABELS[source] || contract.SOURCE_SHORT_LABELS[source] || source) + "</option>";
    }).join("");
    var changed = state.preset === "custom" && selected !== contract.PRESETS.projected[variableKey];
    return '<th class="cm-var-head"><span class="cm-head-label">' + escapeHtml(meta.label) + "</span>" +
      '<select class="cm-head-select' + (changed ? " is-changed" : "") + '" data-source-select="' + variableKey +
      '" aria-label="Fonte de ' + escapeHtml(meta.label) + '" title="' + escapeHtml(contract.sourceLabel(selected)) + '">' + options + "</select></th>";
  }

  function sheetHead() {
    return "<tr>" +
      '<th class="cm-product-head"><span class="cm-head-label">Produto</span></th>' +
      contract.VARIABLES.map(sourceSelectHtml).join("") +
      '<th class="num cm-calc-head"><span class="cm-head-label">Margem</span></th>' +
      '<th class="cm-state-head"><span class="cm-head-label">Estado</span></th>' +
      '<th class="cm-diag-head"><span class="cm-head-label">Diagnóstico</span></th>' +
      "</tr>";
  }

  function valueCell(item, variableKey) {
    var source = state.selection[variableKey];
    var entry = contract.sourceEntry(item, variableKey, source);
    if (!entry || !entry.available) {
      return '<td class="num cm-var-cell">' + unavailable("Indisponível", explainUnavailable(variableKey, source)) + "</td>";
    }
    var differs = contract.hasSourceDisagreement(item, variableKey, source);
    return '<td class="num cm-var-cell"><span class="cm-cell-value">' + escapeHtml(formatByVariable(variableKey, entry.value)) + "</span>" +
      '<span class="cm-cell-sub"><span class="cm-cell-meta">' + escapeHtml(entry.sourceShort) + "</span>" +
      (differs ? '<span class="cm-cell-diff" title="Outra fonte disponível diverge deste valor."></span>' : "") + "</span></td>";
  }

  function marginClass(margin, item) {
    if (margin === null) return "";
    if (margin < 0) return "cm-negative";
    var target = item.targetMargin;
    if (target !== null && target !== undefined && margin < target) return "cm-low";
    return "cm-good";
  }

  /**
   * Próxima ação: derivada do estado real do item, na mesma ordem de prioridade
   * que o Motor usa para classificar (dado antes de dinheiro).
   */
  function nextAction(item, integrity, financial, composition) {
    if (integrity.key === "MISSING") {
      return { title: "Completar Base", detail: "Abrir Bases usando o MLB como busca. A Central não escreve custo." };
    }
    if (integrity.key === "SUSPECT") {
      return { title: "Investigar evidências", detail: "Comparar as fontes da variável divergente antes de agir." };
    }
    if (integrity.key === "RECONCILING") {
      return { title: "Aguardar conciliação", detail: "Não tratar o realizado como fechado." };
    }
    if (composition.pending) {
      return { title: "Calculando composição", detail: "O Motor está calculando LC e margem desta seleção de fontes." };
    }
    if (composition.failed) {
      return { title: "Cálculo indisponível", detail: composition.failureReason || "Não foi possível calcular esta composição agora." };
    }
    if (!composition.computable) {
      return { title: "Completar composição", detail: "Falta " + composition.missing.map(variableLabel).join(", ") + " na fonte selecionada." };
    }
    if (financial.key === "LOSS") {
      return { title: "Revisar preço", detail: "Simular preço mínimo para sair do prejuízo." };
    }
    if (financial.key === "LOW_MARGIN") {
      return { title: "Simular ajuste", detail: "Testar preço para atingir a meta." };
    }
    return { title: "Monitorar", detail: "Nenhuma ação necessária agora." };
  }

  /** Confiança que o Motor informou para a variável desta planilha. */
  function variableConfidence(item, variableKey) {
    var map = item && item.confidenceByVariable;
    return contract.normalizeConfidence(map ? map[variableKey] : null);
  }

  function variableLabel(variableKey) {
    return contract.VARIABLE_META[variableKey] ? contract.VARIABLE_META[variableKey].label.toLowerCase() : variableKey;
  }

  /**
   * Faixa fina de status da linha (produto é a âncora visual). Prioriza o
   * resultado financeiro — é o sinal mais acionável — e cai para integridade
   * quando o financeiro não aponta exceção. Não inventa estado novo: reusa
   * exatamente as chaves que `financialResult`/`dataIntegrity` já expõem.
   */
  function rowStripeTone(financial, integrity) {
    if (financial.key === "LOSS") return "is-danger";
    if (financial.key === "LOW_MARGIN") return "is-warning";
    if (integrity.key === "SUSPECT") return "is-warning";
    if (integrity.key === "RECONCILING") return "is-info";
    if (financial.key === "HEALTHY") return "is-success";
    return "";
  }

  function productThumbHtml(item) {
    if (item.image) {
      return '<span class="cm-product__thumb"><img src="' + escapeHtml(item.image) + '" alt="" loading="lazy" ' +
        'onerror="this.parentElement.classList.add(\'is-fallback\');this.remove();"></span>';
    }
    return '<span class="cm-product__thumb cm-product__thumb--empty" aria-hidden="true"></span>';
  }

  function productCellHtml(item, stripeTone, withSales) {
    var listingStatus = "";
    if (isSnapshotMode()) {
      if (item.statusAnuncio === "active") listingStatus = '<span class="cm-listing-status is-active">● Ativo</span>';
      else if (item.statusAnuncio === "paused") listingStatus = '<span class="cm-listing-status is-paused">⏸ Pausado</span>';
      else listingStatus = '<span class="cm-listing-status">' + escapeHtml(item.statusAnuncio ? "Status: " + item.statusAnuncio : "Status não informado") + "</span>";
    }
    return '<td class="cm-product-cell' + (stripeTone ? " " + stripeTone : "") + '">' +
      '<div class="cm-product">' + productThumbHtml(item) +
      '<div class="cm-product__info"><span class="cm-prod-title">' + escapeHtml(item.title) + "</span>" +
      '<span class="cm-prod-meta">' + escapeHtml(item.itemId || "—") + " · " + escapeHtml(item.sku || "sem SKU") + "</span>" + listingStatus +
      (withSales === false ? "" : salesLineHtml(item)) + "</div>" +
      "</div></td>";
  }

  // Componentes do realizado com cobertura incompleta (backend: cobertura por
  // componente do adapter da Central de Vendas). Só lê — nada é recalculado.
  var COVERAGE_LABELS = { preco: "preço", comissao: "comissão", frete: "frete", custo: "custo", imposto: "imposto" };

  function partialCoverage(coverage) {
    if (!coverage) return [];
    return Object.keys(COVERAGE_LABELS).filter(function (key) {
      var c = coverage[key];
      return c && (c.completa === false || (c.linhasRateadas || 0) > 0);
    }).map(function (key) {
      var c = coverage[key];
      var parte = COVERAGE_LABELS[key] + " " + (c.linhasComValor || 0) + "/" + (c.linhas || 0) + " linhas";
      if (c.fracao !== null && c.fracao !== undefined) parte += " (" + formatPercent(c.fracao) + " das unidades)";
      if (c.linhasRateadas) parte += ", " + c.linhasRateadas + " com frete rateado";
      return parte;
    });
  }

  /** Vendas do período na célula do produto: unidades · pedidos · receita. */
  function salesLineHtml(item) {
    var sales = item.sales || {};
    if (item.realizedUnavailable) return '<span class="cm-prod-sales is-empty" data-cm-sales="unavailable">vendas indisponíveis</span>';
    if (!item.hasOrders) {
      return '<span class="cm-prod-sales is-empty" data-cm-sales="none">sem venda no período</span>';
    }
    // Vendeu, mas o contrato não trouxe as quantidades (adaptador legado):
    // não afirmar nada em vez de dizer "sem venda".
    if (sales.units === null || sales.units === undefined) return "";
    var parcial = partialCoverage(sales.coverage);
    return '<span class="cm-prod-sales" data-cm-sales="' + escapeHtml(String(sales.units)) + '">' +
      "<span>" + escapeHtml(formatInt(sales.units) + " un · " + formatInt(sales.orders || 0) + " ped.") + "</span>" +
      "<span>" + escapeHtml(formatMoney(sales.revenue) || "—") + "</span>" +
      (parcial.length ? '<span class="cm-cell-diff" data-cm-coverage-partial title="' + escapeHtml("Cobertura parcial: " + parcial.join("; ")) + '"></span>' : "") +
      "</span>";
  }

  var COMPARISON_COPY = {
    NO_SALES: "sem venda",
    REALIZED_NOT_COMPUTABLE: "realizado indisponível",
  };

  /**
   * Linha compacta Projetado × Realizado na célula de Margem. Os números são
   * os do Motor (projectedVsRealized); a composição da planilha continua
   * sendo o número principal da célula.
   */
  function comparisonLineHtml(item) {
    // Central de Vendas fora do ar: o realizado do item é DESCONHECIDO (≠ "sem venda").
    if (item.realizedUnavailable) {
      return '<span class="cm-cmp-line is-muted" data-cm-cmp="UNAVAILABLE" title="A leitura de vendas falhou neste período; o realizado deste anúncio é desconhecido (não é \'sem venda\').">realizado indisponível</span>';
    }
    var cmp = item.comparison;
    if (!cmp) return "";
    if (cmp.status === "NO_SALES" || cmp.status === "REALIZED_NOT_COMPUTABLE") {
      var titulo = cmp.status === "REALIZED_NOT_COMPUTABLE"
        ? "Houve venda, mas falta " + (cmp.realized.missing || []).map(variableLabel).join(", ") + " histórico para calcular a margem realizada."
        : "Nenhuma venda deste anúncio no período do realizado.";
      return '<span class="cm-cmp-line is-muted" data-cm-cmp="' + escapeHtml(cmp.status) + '" title="' + escapeHtml(titulo) + '">' + escapeHtml(COMPARISON_COPY[cmp.status]) + "</span>";
    }
    var mostrarProjetado = state.preset === "realized";
    var alvo = mostrarProjetado ? cmp.projected : cmp.realized;
    var rotulo = mostrarProjetado ? "proj." : "real.";
    var drift = cmp.drift && cmp.drift.marginPercentagePoints;
    var tone = drift === null || drift === undefined ? "" : drift < 0 ? " is-negative" : drift > 0 ? " is-positive" : "";
    return '<span class="cm-cmp-line' + tone + '" data-cm-cmp="' + escapeHtml(cmp.status) + '" title="Margem projetada × realizada no período (Δ = realizado − projetado).">' +
      "<span>" + escapeHtml(rotulo + " " + (alvo.margin === null ? "—" : formatPercent(alvo.margin))) + "</span>" +
      (drift === null || drift === undefined ? "" : "<span>" + escapeHtml(formatPp(drift)) + "</span>") + "</span>";
  }

  function rowHtml(item) {
    var composition = contract.resolveComposition(item, state.selection);
    var financial = contract.financialResult(item);
    var integrity = contract.dataIntegrity(item);
    var action = nextAction(item, integrity, financial, composition);
    var stripeTone = rowStripeTone(financial, integrity);
    var assumed = composition.computable && composition.assumed.length
      ? '<span class="cm-cell-meta">assumido 0: ' + escapeHtml(composition.assumed.map(variableLabel).join(", ")) + "</span>"
      : "";

    // Margem: MC é o número que importa (principal, maior); LC é o valor em
    // R$ que sustenta a MC (secundário). Os dois continuam presentes — só
    // compartilham uma coluna em vez de duas.
    var margemCellHtml = (composition.pending
      ? '<span class="cm-cell-meta" data-cm-calc-pending title="LC e margem desta composição são calculados pelo Motor no backend.">Calculando…</span>'
      : composition.failed
        ? unavailable("Indisponível", composition.failureReason || "Não foi possível calcular esta composição agora.")
        : composition.computable
          ? '<span class="cm-cell-value cm-mc-value ' + marginClass(composition.margin, item) + '">' + escapeHtml(formatPercent(composition.margin)) + "</span>" +
            '<span class="cm-cell-sub cm-lc-value"><span class="cm-cell-meta">LC ' + escapeHtml(formatMoney(composition.profit)) + "</span></span>" + assumed
          : unavailable("Indisponível", "Falta " + composition.missing.map(variableLabel).join(", ") + " na composição selecionada.")) +
      comparisonLineHtml(item);

    // Estado: resultado financeiro + integridade do dado continuam sendo DOIS
    // conceitos e dois status — só agrupados visualmente numa coluna.
    var estadoCellHtml = '<div class="cm-state-stack">' + statusTag(financial) + statusTag(integrity) + "</div>";

    // Diagnóstico: problema → próxima ação, sem duas colunas largas de texto.
    // Persistido: item que falhou na última atualização mostra o valor
    // anterior — sinalizado, nunca zerado.
    var snapshotNote = item.snapshot && item.snapshot.refreshStatus === "failed"
      ? '<p class="cm-diag-problem" data-cm-refresh-failed title="' + escapeHtml(item.snapshot.lastError || "") + '">Valor da leitura anterior: a última atualização não recalculou este item.</p>'
      : "";
    var diagCellHtml = snapshotNote + '<p class="cm-diag-problem">' + escapeHtml(item.problem || "Sem problema informado") + "</p>" +
      '<div class="cm-diag-action" title="' + escapeHtml(action.detail) + '"><span class="cm-diag-arrow" aria-hidden="true">→</span><strong>' +
      escapeHtml(action.title) + "</strong></div>";

    return '<tr class="' + (state.selectedItemId === item.id ? "is-selected" : "") + '" data-item-id="' + escapeHtml(item.id) + '" tabindex="0">' +
      productCellHtml(item, stripeTone) +
      contract.VARIABLES.map(function (variableKey) { return valueCell(item, variableKey); }).join("") +
      '<td class="num cm-calc-cell">' + margemCellHtml + "</td>" +
      '<td class="cm-state-cell">' + estadoCellHtml + "</td>" +
      '<td class="cm-diag-cell">' + diagCellHtml + "</td>" +
      "</tr>";
  }

  // --- Visão operacional: decisão primeiro ------------------------------------

  // ---------------------------------------------------------------------------
  // Precificar — a worklist: ordem do servidor (prejuízo → abaixo da meta → maior
  // receita), uma linha por produto e UMA próxima ação clicável.
  // ---------------------------------------------------------------------------

  function opHead() {
    return "<tr>" +
      '<th class="cm-product-head"><span class="cm-head-label">Produto</span></th>' +
      '<th class="num cm-op-head"><span class="cm-head-label">Preço</span></th>' +
      '<th class="num cm-op-head"><span class="cm-head-label">LC/un</span></th>' +
      '<th class="num cm-op-head"><span class="cm-head-label">Margem</span></th>' +
      '<th class="cm-op-head cm-next-head"><span class="cm-head-label">Próxima ação</span></th>' +
      '<th class="cm-go-head"><span class="vf-visually-hidden">Abrir produto</span></th>' +
      "</tr>";
  }

  /** Retorno ML já somado à margem atual (promoção em andamento) — ou o porquê de não ter sido. */
  function rebateNoteHtml(item) {
    var p = item.projected || {};
    if (p.rebate !== null && p.rebate !== undefined) {
      return '<span class="cm-cell-sub"><span class="cm-cell-meta" data-cm-rebate="' + escapeHtml(String(p.rebate)) + '" title="Promoção em andamento com retorno do Mercado Livre: o retorno entra no lucro da margem atual.">inclui retorno ML ' + escapeHtml(formatMoney(p.rebate)) + "</span></span>";
    }
    if (p.rebateReason) {
      return '<span class="cm-cell-sub"><span class="cm-cell-meta" data-cm-rebate-reason="' + escapeHtml(p.rebateReason) + '" title="O retorno ML da promoção em andamento não pôde ser somado à margem.">retorno ML não somado</span></span>';
    }
    return "";
  }

  /**
   * Próxima ação do produto, derivada do estado que o Motor já informou (dado
   * antes de dinheiro, como no status): revisar custo · revisar dados · subir o
   * preço até a meta · entrar numa promoção que não reduz o LC · ok.
   * Nenhum número é calculado aqui: o preço-alvo vem do Motor (estimativa) e o
   * ΔLC da promoção, do cálculo do servidor.
   */
  function nextActionOf(item, financial, integrity) {
    var promo = state.promoTop[item.itemId] || null;
    var variavel = function (preferida) {
      var divs = item.divergences || [];
      if (preferida) return preferida;
      return divs.length && contract.VARIABLE_META[divs[0].variableKey] ? divs[0].variableKey : "cost";
    };
    if (integrity.key === "MISSING" || item.integrityCode === "custo_suspeito") {
      return { kind: "custo", label: "Revisar custo", tone: "is-warning", variable: "cost", title: item.integrityReason || "Custo ausente ou suspeito: a Central não escreve custo; abra as evidências e corrija na Base." };
    }
    if (integrity.key === "SUSPECT") {
      return { kind: "dados", label: "Revisar dados", tone: "is-warning", variable: variavel(null), title: "Fontes em conflito: compare as evidências antes de decidir o preço." };
    }
    if (integrity.key === "RECONCILING") {
      return { kind: "conciliacao", label: "Em conciliação", tone: "is-neutral", title: "Dados ainda conciliando: não trate o realizado como fechado." };
    }
    var price = contract.sourceEntry(item, "price", "MELI_API");
    var precoAtual = price && price.available ? price.value : null;
    var abaixo = financial.key === "LOSS" || financial.key === "LOW_MARGIN";
    if (abaixo && item.targetPrice !== null && item.targetPrice !== undefined && precoAtual !== null && item.targetPrice > precoAtual) {
      return { kind: "subir", label: "Subir p/ " + formatMoney(item.targetPrice), tone: financial.key === "LOSS" ? "is-danger" : "is-warning", price: item.targetPrice,
        title: "Preço estimado pelo Motor que atinge a meta (taxa de comissão e frete do snapshot). A Bancada confirma com cotação real." };
    }
    if (promo && promo.promocao) {
      return { kind: "promo", label: "Promo " + (promo.promocao.nome || promo.promocao.tipo || "") + " " + (formatMoney(promo.delta_lc, true) || ""), tone: "is-success", promoId: promo.promocao.id,
        title: "Entrar nesta promoção não reduz o LC por unidade e fica na meta (estimativa; a Bancada cota ao vivo)." };
    }
    if (abaixo) return { kind: "revisar", label: "Revisar preço", tone: financial.key === "LOSS" ? "is-danger" : "is-warning", title: "Sem preço-alvo calculável nem promoção que ajude: abra a Bancada." };
    return { kind: "ok", label: "Ok", tone: "is-neutral", title: "Nenhuma ação necessária agora." };
  }

  function nextChipHtml(item, action) {
    return '<button class="cm-next-chip ' + action.tone + '" type="button" data-next-kind="' + escapeHtml(action.kind) + '" data-next-item="' + escapeHtml(item.id) + '"' +
      (action.price !== undefined ? ' data-next-price="' + escapeHtml(String(action.price)) + '"' : "") +
      (action.promoId ? ' data-next-promo="' + escapeHtml(String(action.promoId)) + '"' : "") +
      (action.variable ? ' data-next-variable="' + escapeHtml(action.variable) + '"' : "") +
      ' title="' + escapeHtml(action.title || "") + '">' + escapeHtml(action.label) + "</button>";
  }

  function opRowHtml(item) {
    var financial = contract.financialResult(item);
    var integrity = contract.dataIntegrity(item);
    var stripeTone = rowStripeTone(financial, integrity);
    var price = contract.sourceEntry(item, "price", "MELI_API");
    var projected = item.projected ? item.projected.margin : null;
    var refreshFailed = item.snapshot && item.snapshot.refreshStatus === "failed"
      ? '<span class="cm-refresh-failed" data-cm-refresh-failed title="' + escapeHtml("Valor da leitura anterior: a última atualização não recalculou este item. " + (item.snapshot.lastError || "")) + '">valor anterior</span>'
      : "";
    var lc = item.projected ? item.projected.profit : null;
    var action = nextActionOf(item, financial, integrity);
    return '<tr class="cm-op-row' + (state.selectedItemId === item.id ? " is-selected" : "") + '" data-item-id="' + escapeHtml(item.id) + '" tabindex="0">' +
      productCellHtml(item, stripeTone, false) +
      '<td class="num">' + (price && price.available ? '<span class="cm-cell-value">' + escapeHtml(formatMoney(price.value)) + "</span>" : unavailable("Indisponível", explainUnavailable("price", "MELI_API"))) + "</td>" +
      '<td class="num" data-cm-lc>' + (lc === null || lc === undefined
        ? unavailable("Indisponível", item.problem || "LC por unidade não calculável.")
        : '<span class="cm-cell-value ' + (lc < 0 ? "cm-negative" : "") + '">' + escapeHtml(formatMoney(lc)) + "</span>") + "</td>" +
      '<td class="num" data-cm-margem>' + (projected === null || projected === undefined
        ? unavailable("Indisponível", item.problem || "Margem projetada não calculável.")
        : '<span class="cm-cell-value cm-mc-value ' + marginClass(projected, item) + '">' + escapeHtml(formatPercent(projected)) + "</span>" +
          rebateNoteHtml(item)) + refreshFailed + "</td>" +
      '<td class="cm-next-cell">' + nextChipHtml(item, action) + "</td>" +
      '<td class="cm-go" aria-hidden="true">›</td></tr>';
  }

  /** Tabela da visão atual: Operacional (decisão) ou Composição (fontes). */
  function tableHtml(items) {
    var operational = state.view !== "composition";
    return '<div class="vf-table-wrap cm-table-wrap"><table class="cm-table' + (operational ? " cm-table--op" : " cm-table--comp") + '"><thead>' +
      (operational ? opHead() : sheetHead()) + "</thead><tbody>" + items.map(operational ? opRowHtml : rowHtml).join("") + "</tbody></table></div>";
  }

  function loadingTable() {
    var rows = "";
    for (var i = 0; i < 6; i += 1) {
      rows += '<tr class="vf-table__loading"><td><div class="vf-skeleton vf-skeleton--row"></div></td><td><div class="vf-skeleton vf-skeleton--row"></div></td><td><div class="vf-skeleton vf-skeleton--row"></div></td><td><div class="vf-skeleton vf-skeleton--row"></div></td></tr>';
    }
    return '<div class="vf-table-wrap cm-table-wrap" aria-busy="true"><table class="vf-table vf-table--compact cm-table"><thead><tr><th>Carregando produtos</th><th>Valores</th><th>Fontes</th><th>Situação</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
  }

  function renderSheet() {
    scheduleCalcs();
    if (state.view === "promotions") {
      refs.pagination.hidden = true;
      renderPromotions();
      return;
    }
    if (state.loading) {
      refs.tableHost.innerHTML = loadingTable();
      refs.pagination.hidden = true;
      refs.resultCount.textContent = "Carregando…";
      return;
    }
    if (!state.client) {
      refs.tableHost.innerHTML = stateHtml("empty", "Nenhum cliente selecionado", "Escolha um cliente no cabeçalho para carregar a planilha operacional.");
      refs.pagination.hidden = true;
      refs.resultCount.textContent = "0 produtos";
      return;
    }
    if (state.error) {
      refs.tableHost.innerHTML = stateHtml("error", "Erro ao carregar os produtos", state.error,
        '<div class="vf-empty__actions"><button class="vf-btn vf-btn--secondary" type="button" id="cm-table-retry">Tentar novamente</button></div>');
      var retry = el("cm-table-retry");
      if (retry) retry.addEventListener("click", function () { loadCentral(); });
      refs.pagination.hidden = true;
      refs.resultCount.textContent = "Erro";
      return;
    }
    if (isSnapshotMode()) {
      renderSnapshotSheet();
      return;
    }
    var items = filteredItems();
    var coverage = (state.data && state.data.coverage) || {};
    refs.resultCount.textContent = items.length + (items.length === 1 ? " resultado" : " resultados") +
      (coverage.loaded ? " de " + coverage.loaded + " carregados" : "");
    if (!items.length) {
      var hasFilters = state.search || state.financial || state.integrity || state.listingStatus;
      refs.tableHost.innerHTML = stateHtml("empty", hasFilters ? "Nenhum resultado" : "Nenhum item monitorado",
        hasFilters ? "Ajuste a busca ou remova os filtros operacionais." : "Sincronize o catálogo em Anúncios ML e atualize esta leitura.",
        hasFilters ? '<div class="vf-empty__actions"><button class="vf-btn vf-btn--secondary" type="button" id="cm-clear-all">Limpar filtros</button></div>' : "");
      var clear = el("cm-clear-all");
      if (clear) clear.addEventListener("click", clearAllFilters);
      refs.pagination.hidden = true;
      return;
    }
    // Paginação VISUAL: fatia o array já filtrado. Não dispara nova leitura.
    var page = visibleSlice(items);
    refs.tableHost.innerHTML = tableHtml(page);
    renderPagination(items.length);
  }

  // Planilha do modo persistido: a página do servidor como veio (já
  // filtrada/buscada/ordenada), paginação real no servidor.
  function renderSnapshotSheet() {
    if (state.awaitingAccount) {
      refs.tableHost.innerHTML = stateHtml("empty", "Escolha a operação", "A leitura persistida é por conta Mercado Livre.");
      refs.pagination.hidden = true;
      refs.resultCount.textContent = "—";
      return;
    }
    if (state.snapshot && state.snapshot.state === "missing") {
      refs.tableHost.innerHTML = stateHtml("empty", "Leitura ainda não calculada",
        runEmAndamento() ? "O cálculo desta conta está em andamento. Os itens aparecem ao final." : "Use \"Atualizar leitura\" para calcular a margem projetada desta conta em background.");
      refs.pagination.hidden = true;
      refs.resultCount.textContent = "sem leitura";
      return;
    }
    var items = state.data ? state.data.items || [] : [];
    var pagination = (state.data && state.data.pagination) || {};
    var total = pagination.total === null || pagination.total === undefined ? items.length : pagination.total;
    refs.resultCount.textContent = total + (total === 1 ? " resultado" : " resultados");
    if (!items.length) {
      var hasFilters = state.search || state.financial || state.integrity || state.listingStatus;
      refs.tableHost.innerHTML = stateHtml("empty", hasFilters ? "Nenhum resultado" : "Nenhum item na leitura desta conta",
        hasFilters ? "Ajuste a busca ou remova os filtros operacionais." : "O último cálculo não encontrou anúncios ativos ou pausados nesta conta.",
        hasFilters ? '<div class="vf-empty__actions"><button class="vf-btn vf-btn--secondary" type="button" id="cm-clear-all">Limpar filtros</button></div>' : "");
      var clear = el("cm-clear-all");
      if (clear) clear.addEventListener("click", clearAllFilters);
      refs.pagination.hidden = true;
      return;
    }
    refs.tableHost.innerHTML = tableHtml(items);
    renderServerPagination(pagination, total);
  }

  function renderServerPagination(pagination, total) {
    var page = pagination.page || 1;
    var limit = pagination.limit || state.serverLimit;
    var totalPages = pagination.totalPages || Math.max(Math.ceil(total / limit), 1);
    var start = total ? (page - 1) * limit + 1 : 0;
    var end = Math.min(page * limit, total);
    refs.pagination.hidden = false;
    refs.pagination.innerHTML = '<span class="vf-pagination__info">' + start + "–" + end + " de " + total +
      '</span><label class="vf-page-size">Por página <select class="vf-select vf-select--sm" id="cm-page-size">' +
      '<option value="50">50</option><option value="100">100</option><option value="200">200</option>' +
      '</select></label><div class="vf-pagination__actions"><button class="vf-btn vf-btn--secondary vf-btn--sm" type="button" id="cm-page-prev"' +
      (page <= 1 ? " disabled" : "") + '>Anterior</button><span class="vf-tag is-neutral">Página ' +
      page + " de " + totalPages + '</span><button class="vf-btn vf-btn--secondary vf-btn--sm" type="button" id="cm-page-next"' +
      (page >= totalPages ? " disabled" : "") + ">Próxima</button></div>";
    var sizeSelect = el("cm-page-size");
    sizeSelect.value = String(limit);
    sizeSelect.addEventListener("change", function () {
      state.serverLimit = Number(sizeSelect.value) || 50;
      state.serverPage = 1;
      loadSnapshotPage();
    });
    el("cm-page-prev").addEventListener("click", function () {
      if (state.serverPage > 1) { state.serverPage -= 1; loadSnapshotPage(); }
    });
    el("cm-page-next").addEventListener("click", function () {
      if (state.serverPage < totalPages) { state.serverPage += 1; loadSnapshotPage(); }
    });
  }

  function clearAllFilters() {
    state.financial = "";
    state.integrity = "";
    state.listingStatus = "";
    state.search = "";
    state.visiblePage = 1;
    refs.search.value = "";
    refs.financialFilter.value = "";
    refs.integrityFilter.value = "";
    refs.listingStatusFilter.value = "";
    if (isSnapshotMode()) {
      onFiltersChanged();
      return;
    }
    renderSummary();
    renderSheet();
    renderDivergences();
    renderActiveFilters();
  }

  /**
   * Paginação 100% visual: 50/100/Todos carregados. Nunca chama a rede —
   * o array já filtrado (`total`) só é reapresentado em fatias diferentes.
   */
  function renderPagination(total) {
    if (!state.data || !total) {
      refs.pagination.hidden = true;
      return;
    }
    var size = state.visiblePageSize === "all" ? total : Number(state.visiblePageSize) || 50;
    var totalPages = Math.max(Math.ceil(total / size), 1);
    if (state.visiblePage > totalPages) state.visiblePage = totalPages;
    var start = total ? (state.visiblePage - 1) * (Number(state.visiblePageSize) || total) + 1 : 0;
    var end = state.visiblePageSize === "all" ? total : Math.min(state.visiblePage * size, total);
    refs.pagination.hidden = false;
    refs.pagination.innerHTML = '<span class="vf-pagination__info">' + start + "–" + end + " de " + total +
      '</span><label class="vf-page-size">Por página <select class="vf-select vf-select--sm" id="cm-page-size">' +
      '<option value="50">50</option><option value="100">100</option><option value="all">Todos carregados</option>' +
      '</select></label><div class="vf-pagination__actions"><button class="vf-btn vf-btn--secondary vf-btn--sm" type="button" id="cm-page-prev"' +
      (state.visiblePage <= 1 || state.visiblePageSize === "all" ? " disabled" : "") + '>Anterior</button><span class="vf-tag is-neutral">Página ' +
      state.visiblePage + " de " + totalPages + '</span><button class="vf-btn vf-btn--secondary vf-btn--sm" type="button" id="cm-page-next"' +
      (state.visiblePage >= totalPages || state.visiblePageSize === "all" ? " disabled" : "") + ">Próxima</button></div>";
    var sizeSelect = el("cm-page-size");
    sizeSelect.value = String(state.visiblePageSize);
    sizeSelect.addEventListener("change", function () {
      state.visiblePageSize = sizeSelect.value === "all" ? "all" : Number(sizeSelect.value) || 50;
      state.visiblePage = 1;
      renderSheet();
    });
    el("cm-page-prev").addEventListener("click", function () {
      if (state.visiblePage > 1) { state.visiblePage -= 1; renderSheet(); }
    });
    el("cm-page-next").addEventListener("click", function () {
      if (state.visiblePage < totalPages) { state.visiblePage += 1; renderSheet(); }
    });
  }

  // ---------------------------------------------------------------------------
  // Fila de divergências
  // ---------------------------------------------------------------------------

  function allDivergenceRows() {
    return contract.divergenceQueue(filteredItems(), state.selection);
  }

  function divergenceRows() {
    var rows = allDivergenceRows();
    return state.criticalOnly ? rows.filter(function (row) { return row.severity === "CRITICA"; }) : rows;
  }

  /**
   * Divergências são informação técnica valiosa, mas não uma 2ª planilha:
   * a página mostra só o resumo (total · críticas · revisar) e a fila completa
   * abre sob demanda. A fila continua renderizada (e navegável) por inteiro.
   */
  // ---------------------------------------------------------------------------
  // Cálculo no backend (Composição personalizada, simulação avançada e impacto
  // das divergências). A tela não tem fórmula: pede ao núcleo do Motor, em
  // lote, e redesenha quando a resposta chega.
  // ---------------------------------------------------------------------------

  var calcTimer = null;

  function scheduleCalcs() {
    if (calcTimer || typeof root.setTimeout !== "function") return;
    calcTimer = root.setTimeout(function () {
      calcTimer = null;
      runCalcs();
    }, 0);
  }

  function itemsOnScreen() {
    if (isSnapshotMode()) return state.data ? state.data.items || [] : [];
    return visibleSlice(filteredItems());
  }

  function scenarioRequest() {
    if (!state.advancedOpen || !state.scenario || !state.selectedItemId || state.drawerTab !== "pricing") return null;
    var item = findSelectedItem();
    if (!item || item.stub) return null;
    var request = contract.simulateScenario(item, state.scenario, state.selection).request;
    return request && contract.needsCalc(request) ? request : null;
  }

  function runCalcs() {
    if (!state.client || !state.data || state.loading) return;
    var requests = contract.pendingCalcRequests(state.view === "composition" ? itemsOnScreen() : [], filteredItems(), state.selection);
    var scenario = scenarioRequest();
    if (scenario) requests.push(scenario);
    if (!requests.length) return;
    if (typeof api.calcularComposicoes !== "function" || !state.contaId) {
      contract.recordCalcFailure(requests, !state.contaId
        ? "Escolha a operação (conta) para o Motor calcular esta composição."
        : "Cálculo indisponível nesta leitura.");
      redrawAfterCalcs();
      return;
    }
    contract.markCalcInflight(requests);
    var contaNoInicio = state.contaId;
    api.calcularComposicoes({ clienteContaId: contaNoInicio, requests: requests.map(function (r) { return { insumos: r.insumos, base_insumos: r.base_insumos, meta_margem: r.meta_margem }; }) })
      .then(function (result) {
        if (result && result.ok) contract.recordCalcResults(requests, result.itens);
        else contract.recordCalcFailure(requests, result && result.error);
        redrawAfterCalcs();
      })
      .catch(function (error) {
        contract.recordCalcFailure(requests, error && error.message);
        redrawAfterCalcs();
      });
  }

  /**
   * Redesenha só o que o cálculo recém-chegado alimenta. A planilha só muda na
   * visão Composição (na operacional nenhuma célula depende dele) e, quando
   * muda com o drawer aberto, o elemento que o abriu é substituído: o alvo da
   * devolução de foco é remapeado para a linha nova (senão o foco se perderia).
   */
  function redrawAfterCalcs() {
    if (!state.data) return;
    if (state.view === "composition") {
      var focoItem = state.previousFocus && state.previousFocus.closest ? state.previousFocus.closest("tr[data-item-id]") : null;
      var focoId = focoItem ? focoItem.getAttribute("data-item-id") : null;
      renderSheet();
      if (focoId) {
        var novaLinha = refs.tableHost.querySelector('tr[data-item-id="' + focoId.replace(/"/g, '\\"') + '"]');
        if (novaLinha) state.previousFocus = novaLinha;
      }
    }
    renderDivergences();
    if (state.selectedItemId && state.drawerTab === "pricing" && refs.drawer.classList.contains("is-open")) renderDrawer();
  }

  function renderDivergences() {
    scheduleCalcs();
    refs.divergencesToggle.setAttribute("aria-expanded", state.divergencesOpen ? "true" : "false");
    refs.divergencesToggle.textContent = state.divergencesOpen ? "Ocultar divergências" : "Ver divergências";
    refs.divergencesBody.hidden = !state.divergencesOpen;
    if (!state.data || state.loading) {
      refs.divergenceCount.textContent = state.loading ? "comparando fontes…" : "";
      refs.divergencesToggle.disabled = !state.data;
      refs.divergences.innerHTML = state.loading
        ? stateHtml("loading", "Comparando fontes…")
        : stateHtml("empty", "Sem leitura carregada", "A fila de divergências acompanha a leitura carregada.");
      return;
    }
    var todas = allDivergenceRows();
    var criticas = todas.filter(function (row) { return row.severity === "CRITICA"; }).length;
    var coverage = (state.data && state.data.coverage) || {};
    refs.divergencesToggle.disabled = !todas.length;
    refs.divergenceCount.innerHTML = todas.length
      ? "<strong>" + todas.length + (todas.length === 1 ? " divergência" : " divergências") + "</strong>" +
        ' <span class="cm-divs__crit">' + criticas + (criticas === 1 ? " crítica" : " críticas") + "</span> · " + (todas.length - criticas) + " revisar" +
        '<span class="cm-divs__scope">' + escapeHtml(isSnapshotMode() ? " nesta página" : coverage.loaded ? " nos " + coverage.loaded + " carregados" : "") + "</span>"
      : "Nenhuma divergência" + (isSnapshotMode() ? " nesta página" : " na leitura carregada");
    var rows = divergenceRows();
    if (!rows.length) {
      refs.divergences.innerHTML = stateHtml("empty", "Nenhuma divergência no recorte",
        state.criticalOnly ? "Nenhuma divergência crítica no recorte atual." : "As fontes disponíveis concordam dentro da tolerância do Motor.");
      return;
    }
    refs.divergences.innerHTML = '<div class="vf-table-wrap cm-div-wrap"><table class="vf-table vf-table--compact cm-div-table"><thead><tr>' +
      "<th>Produto</th><th>Variável</th><th>Comparação</th><th class=\"num\">Impacto MC</th><th>Severidade</th><th><span class=\"vf-visually-hidden\">Ação</span></th>" +
      "</tr></thead><tbody>" + rows.map(function (row) {
        var impact = row.impactPending
          ? '<span class="cm-cell-meta" data-cm-calc-pending>Calculando…</span>'
          : row.impactPp === null
          ? unavailable("Sem comparação")
          : '<span class="cm-impact ' + (row.impactPp < 0 ? "is-bad" : Math.abs(row.impactPp) >= 1 ? "is-warn" : "is-good") + '">' + escapeHtml(formatPp(row.impactPp)) + "</span>";
        return "<tr>" +
          '<td><strong>' + escapeHtml(row.title) + '</strong><span class="cm-prod-meta">' + escapeHtml(row.itemId) + " · " + escapeHtml(row.sku || "sem SKU") + "</span></td>" +
          '<td><strong>' + escapeHtml(row.variableLabel) + '</strong><span class="cm-prod-meta">' + escapeHtml(row.selectedSourceLabel) + " × " + escapeHtml(row.alternativeSourceLabel) + "</span></td>" +
          '<td><span class="cm-compare-values">' + escapeHtml(formatByVariable(row.variable, row.selectedValue) || "Indisponível") +
          '<span class="cm-arrow" aria-hidden="true">→</span>' + escapeHtml(formatByVariable(row.variable, row.alternativeValue) || "Indisponível") + "</span>" +
          '<span class="cm-prod-meta">' + escapeHtml(row.type === "DRIFT" ? "Desvio previsto × realizado" : "Conflito entre fontes") +
          (row.origin === "adapter" ? " · derivada na leitura" : "") + "</span></td>" +
          '<td class="num">' + impact + "</td>" +
          "<td>" + (row.severity === "CRITICA"
            ? '<span class="vf-status is-danger">Crítica</span>'
            : '<span class="vf-status is-warning">Revisar</span>') + "</td>" +
          '<td class="vf-table__actions"><button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-evidence-item="' + escapeHtml(row.itemId) +
          '" data-evidence-variable="' + escapeHtml(row.variable) + '">Evidências</button></td>' +
          "</tr>";
      }).join("") + "</tbody></table></div>";
  }

  // ---------------------------------------------------------------------------
  // Drawer — resumo fixo + PRECIFICAR · EVIDÊNCIAS · HISTÓRICO
  // ---------------------------------------------------------------------------

  /**
   * Marca a linha aberta sem redesenhar a planilha: redesenhar destruiria o
   * elemento que abriu o drawer e o foco não teria para onde voltar.
   */
  function markSelectedRow() {
    Array.prototype.forEach.call(refs.tableHost.querySelectorAll("tr[data-item-id]"), function (row) {
      row.classList.toggle("is-selected", row.getAttribute("data-item-id") === state.selectedItemId);
    });
  }

  /** Item de Oportunidades fora da página atual: só o essencial para precificar. */
  function stubFromOpportunity(itemId) {
    var list = (state.opps && state.opps.oportunidades) || [];
    var o = list.find(function (entry) { return entry.itemId === itemId; });
    if (!o) return null;
    return {
      id: o.itemId, itemId: o.itemId, title: o.titulo, image: o.imagem || null, sku: null, stub: true,
      stubPrice: o.precoAtual, status: null, statusAnuncio: null, divergences: [], variables: {}, sources: null,
      projected: { margin: o.margemAtual, profit: null }, realized: { margin: null, profit: null, pending: true },
      sales: { units: o.unidades, orders: null, revenue: o.receita }, hasOrders: Boolean(o.unidades), comparison: null,
    };
  }

  function findSelectedItem() {
    if (state.stubItem && state.stubItem.id === state.selectedItemId) return state.stubItem;
    var items = state.data ? state.data.items || [] : [];
    return items.find(function (item) { return item.id === state.selectedItemId; }) || null;
  }

  function initScenario(item) {
    state.scenario = {};
    state.scenarioItemId = item.id;
    contract.VARIABLES.forEach(function (variableKey) {
      state.scenario[variableKey] = { source: state.selection[variableKey], value: null, manual: false };
    });
  }

  /** Preço atual mostrado ao operador — é o `precoVisto` do stale check. */
  function currentPriceOf(item) {
    if (!item) return null;
    if (item.stub) return contract.numberOrNull(item.stubPrice);
    var entry = contract.sourceEntry(item, "price", "MELI_API");
    return entry && entry.available ? entry.value : null;
  }

  /** Novo item (ou novo contexto): tudo que é assíncrono do item anterior morre aqui. */
  function resetItemState(item) {
    state.drawerSeq += 1;
    if (state.pricing && state.pricing.abort) state.pricing.abort.abort();
    if (state.pricing && state.pricing.timer) root.clearTimeout(state.pricing.timer);
    if (state.pricing && state.pricing.pollTimer) root.clearTimeout(state.pricing.pollTimer);
    var b = state.bancada;
    if (b && b.manual) {
      if (b.manual.abort) b.manual.abort.abort();
      if (b.manual.timer) root.clearTimeout(b.manual.timer);
    }
    state.pricing = { novoPreco: "", aplicacao: null, pollTimer: null, precoAoVivo: null, precoTabela: null };
    state.bancada = novaBancada();
    // Nada abre sozinho: a Simulação avançada aberta num anúncio não abre o próximo já aberta.
    state.advancedOpen = false;
    state.history = null;
    state.evidenceVariable = state.evidenceVariable || "price";
    if (item) initScenario(item);
    closeConfirm();
  }

  function openDrawer(itemId, tab, variableKey, trigger, opts) {
    var items = filteredItems();
    var item = items.find(function (entry) { return entry.id === itemId; }) || null;
    if (!item && opts && opts.fromOpportunity) {
      item = stubFromOpportunity(itemId);
      state.stubItem = item;
    } else {
      state.stubItem = null;
    }
    if (!item) return;
    if (!refs.drawer.classList.contains("is-open")) state.previousFocus = trigger || document.activeElement;
    var mesmoItem = state.selectedItemId === item.id && refs.drawer.classList.contains("is-open");
    state.selectedItemId = item.id;
    var tabName = DRAWER_TAB_ALIASES[tab] || tab;
    state.drawerTab = DRAWER_TABS.indexOf(tabName) !== -1 ? tabName : "pricing";
    if (variableKey && contract.VARIABLE_META[variableKey]) state.evidenceVariable = variableKey;
    state.pendingPromoId = opts && opts.promoId ? String(opts.promoId) : null;
    state.pendingReview = Boolean(opts && opts.autoReview && state.pendingPromoId);
    if (!mesmoItem) {
      resetItemState(item);
      loadBancada(item);
    }
    // "Subir p/ R$ X": o preço sugerido entra no preço manual e é simulado na hora.
    if (opts && opts.novoPreco !== undefined && Number.isFinite(opts.novoPreco) && state.pricing) {
      state.pricing.novoPreco = opts.novoPreco.toFixed(2).replace(".", ",");
      state.bancada.selecionado = "preco";
      simularManual(0);
    }
    applyPendingPromo();
    refs.drawerBackdrop.classList.add("is-open");
    refs.drawer.classList.add("is-open");
    document.body.classList.add("vf-no-scroll");
    renderDrawer();
    markSelectedRow();
    refs.drawer.focus();
  }

  /** "Simular" da aba Promoções / chip "Promo Y": assim que a bancada carrega, seleciona a promoção escolhida. */
  function applyPendingPromo() {
    var id = state.pendingPromoId;
    if (!id || !state.bancada || state.bancada.status === "loading" || state.bancada.status === "idle") return;
    state.pendingPromoId = null;
    if (state.bancada.status !== "ok") return;
    var achada = bancadaPromoPorId(id);
    if (achada) {
      state.drawerTab = "pricing";
      state.bancada.selecionado = promoIdDe(achada);
      // "Participar" da aba Promoções: com a Bancada pronta, já abre o preview (o botão decide se pode).
      if (state.pendingReview) {
        state.pendingReview = false;
        var chave = drawerKey();
        root.setTimeout(function () { if (chave === drawerKey()) reviewDaBancada(); }, 0);
      }
    } else {
      state.pendingReview = false;
      // Nunca cai em "Preço manual" em silêncio: a promoção pedida não está na leitura atual.
      state.bancada.aviso = "A promoção escolhida não está mais na leitura atual das promoções deste anúncio; mostrando o preço manual.";
    }
  }

  function closeDrawer() {
    if (!refs.drawer || !refs.drawer.classList.contains("is-open")) return;
    refs.drawer.classList.remove("is-open");
    refs.drawerBackdrop.classList.remove("is-open");
    document.body.classList.remove("vf-no-scroll");
    resetItemState(null);
    // Nada do produto anterior fica no DOM do drawer fechado.
    refs.drawerMeta.innerHTML = "";
    refs.drawerSummary.innerHTML = "";
    refs.drawerBody.innerHTML = "";
    state.selectedItemId = null;
    state.stubItem = null;
    state.scenario = null;
    state.scenarioItemId = null;
    markSelectedRow();
    if (state.previousFocus && typeof state.previousFocus.focus === "function" && document.contains(state.previousFocus)) state.previousFocus.focus();
    state.previousFocus = null;
  }

  function moveDrawer(direction) {
    var items = filteredItems();
    var index = items.findIndex(function (item) { return item.id === state.selectedItemId; });
    var next = index + direction;
    if (next < 0 || next >= items.length) return;
    state.selectedItemId = items[next].id;
    state.stubItem = null;
    resetItemState(items[next]);
    loadBancada(items[next]);
    renderDrawer();
    markSelectedRow();
    refs.drawerBody.scrollTop = 0;
  }

  function setDrawerTab(tab) {
    var name = DRAWER_TAB_ALIASES[tab] || tab;
    if (DRAWER_TABS.indexOf(name) === -1) return;
    state.drawerTab = name;
    if (name === "history") loadHistory();
    renderDrawer();
  }

  function panel(title, note, body, extraClass) {
    return '<section class="cm-panel' + (extraClass ? " " + extraClass : "") + '"><header class="cm-panel__head"><h3>' + escapeHtml(title) + "</h3>" +
      (note ? "<span>" + escapeHtml(note) + "</span>" : "") + "</header>" +
      '<div class="cm-panel__body">' + body + "</div></section>";
  }

  function dsumCell(label, valueHtml, foot, tone, footAttr) {
    return '<div class="cm-dsum__cell' + (tone ? " " + tone : "") + '"><span class="cm-dsum__label">' + escapeHtml(label) + "</span>" +
      '<strong class="cm-dsum__value">' + valueHtml + "</strong>" +
      // Sub em uma linha (reticências): sem title próprio, o texto inteiro vira o title.
      (foot ? '<span class="cm-dsum__foot"' + (footAttr ? " " + footAttr : "") + (/\btitle=/.test(footAttr || "") ? "" : ' title="' + escapeHtml(foot) + '"') + ">" + escapeHtml(foot) + "</span>" : "") + "</div>";
  }

  // Nota da margem projetada: retorno ML somado (valor) ou, se ambíguo (duas
  // promoções com retorno no mesmo anúncio), o aviso de que NÃO foi somado —
  // o header nunca fica mudo sobre a ambiguidade (ver rebateNoteHtml da tabela).
  function rebateFootOf(item) {
    var p = item && item.projected;
    if (!p) return { text: null, attr: null };
    if (p.rebate !== null && p.rebate !== undefined) {
      return { text: "inclui retorno ML " + formatMoney(p.rebate), attr: null };
    }
    if (p.rebateReason === "REBATE_AMBIGUO") {
      return { text: "retorno ML não somado — duas promoções ativas (ambíguo)", attr: 'data-cm-rebate-reason="REBATE_AMBIGUO"' };
    }
    return { text: null, attr: null };
  }

  function listingStatusHtml(item) {
    if (item.statusAnuncio === "active") return '<span class="cm-listing-status is-active">● Ativo</span>';
    if (item.statusAnuncio === "paused") return '<span class="cm-listing-status is-paused">⏸ Pausado</span>';
    return item.statusAnuncio ? '<span class="cm-listing-status">' + escapeHtml("Status: " + item.statusAnuncio) + "</span>" : "";
  }

  var LISTING_STATUS_TEXTO = { active: "Ativo", paused: "Pausado", closed: "Finalizado", under_review: "Em revisão", inactive: "Inativo" };
  var INTEGRIDADE_TEXTO = { RELIABLE: "Dados confiáveis", SUSPECT: "Dados suspeitos", MISSING: "Dados não validados", RECONCILING: "Dados em conciliação" };

  function renderDrawerHeader(item) {
    var financial = contract.financialResult(item);
    var integrity = contract.dataIntegrity(item);
    refs.drawerTitle.textContent = item.title;
    var baseHref = "bases.html?busca=" + encodeURIComponent(item.itemId || item.sku || "");
    // Linha cinza única (mockup): MLB · status · saúde dos dados · Ver na Base. Sem selos coloridos; o title explica.
    var metaTexto = function (texto, title) { return texto ? '<span class="cm-drawer__meta-item"' + (title ? ' title="' + escapeHtml(title) + '"' : "") + ">" + escapeHtml(texto) + "</span>" : ""; };
    var saudeTitle = [financial && financial.label, integrity && integrity.reason].filter(Boolean).join(" · ");
    refs.drawerMeta.innerHTML = '<span class="vf-mono" title="' + escapeHtml(item.sku ? "SKU " + item.sku : "") + '">' + escapeHtml(item.itemId || "") + "</span>" +
      metaTexto(LISTING_STATUS_TEXTO[item.statusAnuncio] || (item.statusAnuncio ? "Status: " + item.statusAnuncio : "")) +
      (item.stub ? "" : metaTexto(integrity && INTEGRIDADE_TEXTO[integrity.key], saudeTitle)) +
      '<a class="cm-link" href="' + escapeHtml(baseHref) + '">Ver na Base</a>';

    // Resumo essencial, sempre visível: pouco texto, números grandes.
    var aplicada = state.pricing && state.pricing.aplicacao;
    var precoAtual = currentPriceOf(item);
    var precoFoot = null; // leitura da tabela: sem rodapé (só diz algo quando o preço foi confirmado)
    if (aplicada && aplicada.precoConfirmado !== null && aplicada.precoConfirmado !== undefined) {
      precoAtual = aplicada.precoConfirmado;
      precoFoot = "confirmado pelo Mercado Livre";
    } else if (state.pricing && state.pricing.precoAoVivo !== null && state.pricing.precoAoVivo !== undefined) {
      precoAtual = state.pricing.precoAoVivo;
      precoFoot = "confirmado ao vivo";
    }
    var sales = item.sales || {};
    var realized = item.realized && item.realized.margin !== null && item.realized.margin !== undefined
      ? escapeHtml(formatPercent(item.realized.margin))
      : unavailable(item.hasOrders || item.realizedUnavailable ? "Indisponível" : "Sem venda");
    var aplicacao = state.pricing && state.pricing.aplicacao;
    var rebateFoot = rebateFootOf(item);
    // Sub em UMA linha: "LC R$ 14,44 / un"; a nota do retorno ML vai no title (ambíguo também diz na linha).
    var lcProjetado = item.projected && item.projected.profit !== null && item.projected.profit !== undefined ? "LC " + formatMoney(item.projected.profit) + " / un" : null;
    var ambiguo = item.projected && item.projected.rebateReason === "REBATE_AMBIGUO";
    var margemFoot = [lcProjetado, ambiguo ? "retorno ML não somado" : null].filter(Boolean).join(" · ") || null;
    var margemFootAttr = [rebateFoot.attr, rebateFoot.text ? 'title="' + escapeHtml(rebateFoot.text) + '"' : null].filter(Boolean).join(" ");
    var periodo = periodShortLabel();
    // Custo, imposto e preço cheio: o bloco `atual` do /simular (o mesmo da Bancada) — vazio até a Bancada responder.
    var hoje = state.bancada && state.bancada.data ? state.bancada.data.atual || {} : null;
    // "…" só enquanto a Bancada carrega; sem Bancada (sem conta/API) ou com erro, diz que não há o número.
    var esperando = !hoje && bancadaDisponivel().ok && state.bancada && (state.bancada.status === "loading" || state.bancada.status === "idle");
    if (!hoje && !esperando) hoje = {};
    var carregando = '<span class="cm-dsum__wait" aria-label="carregando">…</span>';
    var temNum = function (v) { return v !== null && v !== undefined; };
    var precoSub = [hoje && temNum(hoje.preco_cheio) ? "cheio " + formatMoney(hoje.preco_cheio) : null, precoFoot].filter(Boolean).join(" · ") || null;
    var base = hoje && hoje.base;
    var baseSub = base ? (base.nome ? (/^base\b/i.test(base.nome) ? base.nome : "Base " + base.nome) : "Base") : null;
    refs.drawerSummary.innerHTML =
      dsumCell("Preço atual", precoAtual === null ? unavailable("Indisponível") : escapeHtml(formatMoney(precoAtual)), precoSub) +
      dsumCell("Custo", !hoje ? carregando : temNum(hoje.custo) ? escapeHtml(formatMoney(hoje.custo)) : unavailable("Sem custo"), baseSub, null, 'data-cm-dsum="custo"') +
      dsumCell("Imposto", !hoje ? carregando : temNum(hoje.aliquota) ? escapeHtml(formatPct1(hoje.aliquota)) : unavailable("Sem alíquota"),
        hoje && temNum(hoje.imposto) ? formatMoney(hoje.imposto) + " / un" : null, null, 'data-cm-dsum="imposto"') +
      dsumCell("Margem projetada", item.projected && item.projected.margin !== null && item.projected.margin !== undefined
        ? escapeHtml(formatPercent(item.projected.margin)) : unavailable("Indisponível"),
        margemFoot, marginClass(item.projected ? item.projected.margin : null, item), margemFootAttr) +
      dsumCell("Margem realizada", realized, periodo === "30d" ? "últimos 30 dias" : periodo) +
      dsumCell("Vendas · " + periodo, sales.units === null || sales.units === undefined ? unavailable("Sem dado") : escapeHtml(formatInt(sales.units) + " un."),
        sales.revenue === null || sales.revenue === undefined ? null : "receita " + formatMoney(sales.revenue)) +
      (aplicacao ? '<p class="cm-dsum__status" data-cm-pos-escrita="' + escapeHtml(aplicacao.snapshotStatus || "") + '">' + escapeHtml(posEscritaTexto(aplicacao)) + "</p>" : "");
  }

  function posEscritaTexto(aplicacao) {
    var confirmado = aplicacao.precoConfirmado !== null && aplicacao.precoConfirmado !== undefined ? formatMoney(aplicacao.precoConfirmado) : "—";
    if (aplicacao.snapshotStatus === "atualizado") return "Aplicado no Mercado Livre (" + confirmado + ") · margem atualizada.";
    if (aplicacao.snapshotStatus === "falhou") return "Aplicado no Mercado Livre (" + confirmado + ") · a margem não pôde ser recalculada agora; use Atualizar leitura.";
    if (aplicacao.snapshotStatus === "nao_aplicavel") return "Aplicado no Mercado Livre (" + confirmado + ") · use Atualizar leitura para recalcular a margem.";
    if (aplicacao.snapshotStatus === "aguardando_propagacao") return "Aplicado no Mercado Livre (" + confirmado + ") · aguardando o Mercado Livre propagar o novo preço…";
    if (aplicacao.snapshotStatus === "propagacao_pendente") return "Aplicado no Mercado Livre (" + confirmado + ") · o Mercado Livre ainda não mostra o novo preço; a margem não foi recalculada. Use Atualizar leitura mais tarde.";
    return "Aplicado no Mercado Livre (" + confirmado + ") · atualizando margem…";
  }

  function renderDrawer() {
    var item = findSelectedItem();
    if (!item) return;
    var items = filteredItems();
    var index = items.findIndex(function (entry) { return entry.id === item.id; });
    renderDrawerHeader(item);
    refs.drawerPrev.disabled = index <= 0;
    refs.drawerNext.disabled = index < 0 || index >= items.length - 1;
    refs.drawerPosition.textContent = index >= 0 ? (index + 1) + " de " + items.length + " produtos neste recorte" : "";

    Array.prototype.forEach.call(refs.drawerTabs.querySelectorAll("[data-tab]"), function (button) {
      var active = button.getAttribute("data-tab") === state.drawerTab;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });

    // Precificar usa o drawer largo (Hoje × Cenário | Cenários); as outras abas ficam no tamanho normal.
    refs.drawer.classList.toggle("cm-drawer--wide", state.drawerTab !== "evidence" && state.drawerTab !== "history");
    var botaoBancada = el("cm-banc-botao");
    if (botaoBancada) botaoBancada.innerHTML = "";
    refs.drawerPosition.classList.remove("cm-drawer__hint");
    if (state.drawerTab === "evidence") renderEvidenceTab(item);
    else if (state.drawerTab === "history") renderHistoryTab(item);
    else renderPricingTab(item);
  }

  // --- Precificar ------------------------------------------------------------

  var PRICE_RE = /^\d+([.,]\d{1,2})?$/;

  /** Validação local só para não chamar o backend com lixo; o backend revalida tudo. */
  function parsePriceInput(raw) {
    var text = String(raw || "").trim().replace(/^R\$\s*/, "");
    if (!text) return { ok: false, empty: true };
    if (!PRICE_RE.test(text)) return { ok: false, error: "Use um número com até duas casas decimais." };
    var value = Number(text.replace(",", "."));
    if (!(value > 0)) return { ok: false, error: "O preço precisa ser maior que zero." };
    return { ok: true, value: Math.round(value * 100) / 100 };
  }

  var GATE_ICON = { ok: "✓", warn: "!", block: "×", info: "•" };
  var GATE_TONE = { ok: "is-ok", warn: "is-warn", block: "is-block", info: "is-info" };

  function gatesListHtml(gates, compact) {
    if (!gates || !gates.length) return "";
    var list = compact ? gates.filter(function (g) { return g.tom !== "ok"; }) : gates;
    var okCount = gates.filter(function (g) { return g.tom === "ok"; }).length;
    return '<ul class="cm-gates' + (compact ? " cm-gates--compact" : "") + '">' +
      (compact && okCount ? '<li class="cm-gate is-ok"><span class="cm-gate__icon" aria-hidden="true">✓</span><span>' + okCount + " verificação(ões) ok</span></li>" : "") +
      list.map(function (g) {
        return '<li class="cm-gate ' + (GATE_TONE[g.tom] || "is-info") + '" data-gate="' + escapeHtml(g.id) + '"><span class="cm-gate__icon" aria-hidden="true">' + (GATE_ICON[g.tom] || "•") + "</span>" +
          "<span><strong>" + escapeHtml(g.titulo) + "</strong>" + (g.detalhe ? '<small>' + escapeHtml(g.detalhe) + "</small>" : "") + "</span></li>";
      }).join("") + "</ul>";
  }

  /** Antes → depois. Cor só para resultado (margem/LC); preço é neutro: subir ou descer não é bom nem ruim por si. */
  function deltaRow(label, before, after, fmt, neutral) {
    var b = before === null || before === undefined ? "—" : fmt(before);
    var a = after === null || after === undefined ? "—" : fmt(after);
    var tone = !neutral && before !== null && before !== undefined && after !== null && after !== undefined
      ? (after > before ? " is-up" : after < before ? " is-down" : "") : "";
    return '<div class="cm-delta' + tone + '"><span class="cm-delta__label">' + escapeHtml(label) + "</span>" +
      '<span class="cm-delta__values"><span>' + escapeHtml(b) + '</span><span class="cm-arrow" aria-hidden="true">→</span><strong>' + escapeHtml(a) + "</strong></span></div>";
  }

  // --- Bancada ----------------------------------------------------------------
  //
  // O drawer é uma bancada em duas colunas. À ESQUERDA, o estado de HOJE e o
  // CENÁRIO em cascata (preço de venda → −imposto → −comissão → −frete → −taxa
  // fixa → −custo → +retorno ML = LC/un → margem), com quem banca o desconto e
  // o volume que empata o LC. À DIREITA, os cenários agrupados — Preço manual e
  // as promoções do anúncio em Ativa agora · Você já participa · Pode participar
  // pelo VenForce · Só pelo Mercado Livre. Todo número vem de POST
  // /api/margem/simular (o núcleo do Motor com cotação REAL do Mercado Livre em
  // cada preço); a tela não calcula nada. Um botão único, dinâmico, no rodapé.

  var BANCADA_LINHAS = [
    { chave: "preco", rotulo: "Preço de venda", sinal: "" },
    { chave: "imposto", rotulo: "Imposto", sinal: "−", custo: true },
    { chave: "comissao", rotulo: "Comissão", sinal: "−", custo: true },
    { chave: "frete", rotulo: "Frete", sinal: "−", custo: true },
    { chave: "taxa_fixa", rotulo: "Taxa fixa", sinal: "−", custo: true },
    { chave: "custo", rotulo: "Custo", sinal: "−", custo: true },
    { chave: "rebate", rotulo: "Retorno ML", sinal: "+" },
  ];

  // Ordem de leitura (depois de "Preço manual"): o que forma o preço agora, o que dá para inscrever
  // por aqui, o que já está inscrito e o que só o painel do Mercado Livre resolve. O grupo vem do servidor (promocao.grupo).
  var BANCADA_GRUPOS = [
    { chave: "ativa", titulo: "Ativa agora", dica: "forma o preço de hoje" },
    { chave: "pode", titulo: "Pode participar pelo VenForce", dica: "simule e entre por aqui" },
    { chave: "participa", titulo: "Você já participa", dica: "inscrita, mas não forma o preço" },
    { chave: "ml", titulo: "Só pelo Mercado Livre", dica: "inscrição no painel do ML" },
  ];

  var PROMO_STATUS_TOM = { "ATIVA": "is-success", "NÃO APLICADA": "is-warning", "PROGRAMADA": "is-info", "ELEGÍVEL": "is-empty" };

  function novaHipotese() {
    // `edit`: o campo já foi tocado pelo operador (mantém o texto digitado, mesmo vazio, enquanto ele edita).
    return { custo: "", taxa_fixa: "", edit: { custo: false, taxa_fixa: false }, status: "idle", resultado: null, error: null, localError: null, seq: 0, timer: null, abort: null };
  }

  function novaBancada() {
    return {
      status: "idle", data: null, error: null, aviso: null, selecionado: "preco", alvo: null, semAberto: false, contaAberta: false,
      manual: { status: "idle", resultado: null, atual: null, error: null, localError: null, seq: 0, timer: null, abort: null },
      hip: novaHipotese(),
    };
  }

  function bancadaDisponivel() {
    if (!state.client) return { ok: false, reason: "Selecione um cliente." };
    if (!state.contaId) return { ok: false, reason: "Escolha a operação (conta Mercado Livre) no topo para precificar: a escrita é sempre por conta." };
    if (typeof api.simular !== "function" || typeof api.previewPricing !== "function") {
      return { ok: false, reason: "Precificação indisponível nesta leitura." };
    }
    return { ok: true };
  }

  // Mantido com o nome antigo: o resto da tela só pergunta "dá para precificar?".
  function pricingAvailability() {
    return bancadaDisponivel();
  }

  function drawerKey() {
    return [state.client && state.client.slug, state.contaId, state.selectedItemId].join("::");
  }

  function bancadaPromos() {
    var d = state.bancada && state.bancada.data;
    return d ? (d.cenarios || []).filter(function (c) { return c.tipo === "promo"; }) : [];
  }

  function promoIdDe(cenario) {
    return String(cenario.promocao ? cenario.promocao.id : (cenario.entrada && cenario.entrada.promotion_id) || "");
  }

  // A promoção pode ser pedida pelo id, pela chave do snapshot ou pelo ref_id (o chip da worklist vem da lista de Oportunidades).
  function bancadaPromoPorId(id) {
    var alvo = String(id);
    var lista = bancadaPromos();
    for (var i = 0; i < lista.length; i += 1) {
      var p = lista[i].promocao;
      if (p && (promoIdDe(lista[i]) === alvo || String(p.chave || "") === alvo || String(p.ref_id || "") === alvo)) return lista[i];
    }
    return null;
  }

  /** Cenário escolhido: o preço manual ou uma promoção (sem a hipótese de custo). */
  function bancadaSelecionada() {
    var b = state.bancada;
    if (b.selecionado === "preco") return { tipo: "preco", resultado: b.manual.resultado, promo: null };
    var promo = bancadaPromoPorId(b.selecionado);
    return promo ? { tipo: "promo", resultado: promo, promo: promo } : { tipo: "preco", resultado: b.manual.resultado, promo: null };
  }

  function hipoteseAtiva() {
    var h = state.bancada && state.bancada.hip;
    return Boolean(h && (h.custo !== "" || h.taxa_fixa !== ""));
  }

  /** O que a coluna Cenário mostra: o resultado do cenário escolhido ou, se o operador testou um custo, o da HIPÓTESE. */
  function bancadaEmExibicao() {
    var sel = bancadaSelecionada();
    var h = state.bancada.hip;
    if (!hipoteseAtiva()) return Object.assign({ hipotese: false, carregando: false, erro: null }, sel);
    return Object.assign({}, sel, { resultado: h.resultado, hipotese: true, carregando: h.status === "loading", erro: h.localError || (h.status === "error" ? h.error : null) });
  }

  function bancadaAtual() {
    var b = state.bancada;
    if (b.data && b.data.atual) return b.data.atual;
    return b.manual.atual || null;
  }

  function renderBancada() {
    if (state.selectedItemId && state.drawerTab === "pricing" && refs.drawer.classList.contains("is-open")) renderDrawer();
  }

  /**
   * Lê, de uma vez, as promoções do anúncio (Promo Snapshot) e — se abaixo da meta — o preço-alvo cotado.
   * `silent`: releitura em segundo plano (depois de uma escrita) — não troca a tela por "carregando" e
   * não derruba o que o operador está digitando; se falhar, mantém o que já estava na tela.
   */
  function loadBancada(item, opts) {
    var b = state.bancada;
    var silent = Boolean(opts && opts.silent);
    if (!item || !bancadaDisponivel().ok) return;
    var financial = contract.financialResult(item);
    var cenarios = [{ tipo: "todas_promos" }];
    if (financial.key === "LOSS" || financial.key === "LOW_MARGIN") cenarios.push({ tipo: "preco_alvo" });
    if (!silent) b.status = "loading";
    var seq = state.drawerSeq;
    var key = drawerKey();
    api.simular({ clienteContaId: state.contaId, mlb: item.itemId, cenarios: cenarios }).then(function (result) {
      if (seq !== state.drawerSeq || key !== drawerKey() || state.bancada !== b) return;
      if (!result.ok) {
        if (silent) return;
        b.status = "error";
        b.error = result.error || "Não foi possível montar a bancada.";
      } else {
        b.status = "ok";
        b.data = result;
        b.alvo = (result.cenarios || []).filter(function (c) { return c.tipo === "preco_alvo"; })[0] || null;
      }
      applyPendingPromo();
      if (silent) updateBancadaResultado(true);
      else renderBancada();
    });
  }

  /** Depois de uma escrita confirmada e do snapshot recalculado: a composição "Hoje" é a nova. */
  function recarregarBancada() {
    var item = findSelectedItem();
    if (!item || !state.bancada || !bancadaDisponivel().ok) return;
    loadBancada(item, { silent: true });
    // O preço que o operador já digitou é recalculado contra a composição nova.
    if (parsePriceInput(state.pricing.novoPreco).ok) simularManual(0);
  }

  /** Preço manual: valida localmente (sem lixo ao servidor) e simula com debounce. */
  function simularManual(delay) {
    var b = state.bancada;
    var m = b.manual;
    if (m.timer) root.clearTimeout(m.timer);
    if (m.abort) m.abort.abort();
    var parsed = parsePriceInput(state.pricing.novoPreco);
    m.localError = parsed.ok || parsed.empty ? null : parsed.error;
    m.seq += 1;
    var seqManual = m.seq;
    if (!parsed.ok) {
      m.status = "idle";
      m.resultado = null;
      updateBancadaResultado(true);
      return;
    }
    if (!bancadaDisponivel().ok) return;
    m.status = "loading";
    updateBancadaResultado(true);
    var seq = state.drawerSeq;
    var key = drawerKey();
    var item = findSelectedItem();
    m.timer = root.setTimeout(function () {
      m.timer = null;
      m.abort = typeof AbortController !== "undefined" ? new AbortController() : null;
      api.simular({ clienteContaId: state.contaId, mlb: item.itemId, cenarios: [{ tipo: "preco", preco: parsed.value }] }, m.abort && m.abort.signal).then(function (result) {
        if (seq !== state.drawerSeq || key !== drawerKey() || result.aborted || seqManual !== m.seq) return;
        if (!result.ok) {
          m.status = "error";
          m.error = result.error || "Não foi possível simular este preço agora.";
          m.resultado = null;
        } else {
          m.status = "ok";
          m.error = null;
          m.resultado = (result.cenarios || [])[0] || null;
          m.atual = result.atual || m.atual;
        }
        updateBancadaResultado(true);
      });
    }, delay === undefined ? 400 : delay);
  }

  // --- Hipótese de custo ("e se o custo fosse X?") -----------------------------
  // Custo e taxa fixa (custo adicional) editáveis na coluna Cenário, marcados "hipótese". O servidor
  // refaz o MESMO cenário com o custo informado (a Base não muda; a escrita nunca usa hipótese).

  var HIP_RE = /^\d+([.,]\d{1,4})?$/;

  function hipoteseDoCampo(texto) {
    var t = String(texto || "").trim().replace(/^R\$\s*/, "");
    if (!t) return { vazio: true };
    if (!HIP_RE.test(t)) return { erro: "Use um número (ex.: 21,35)." };
    return { valor: Number(t.replace(",", ".")) };
  }

  function limparHipotese() {
    var h = state.bancada.hip;
    if (h.timer) root.clearTimeout(h.timer);
    if (h.abort) h.abort.abort();
    state.bancada.hip = novaHipotese();
  }

  function simularHipotese(delay) {
    var b = state.bancada;
    var h = b.hip;
    if (h.timer) root.clearTimeout(h.timer);
    if (h.abort) h.abort.abort();
    h.seq += 1;
    var seqHip = h.seq;
    var campos = {};
    var erro = null;
    ["custo", "taxa_fixa"].forEach(function (campo) {
      var p = hipoteseDoCampo(h[campo]);
      if (p.erro) erro = erro || p.erro;
      else if (!p.vazio) campos[campo] = p.valor;
    });
    h.localError = erro;
    if (erro || !Object.keys(campos).length) {
      h.status = "idle";
      h.resultado = null;
      updateBancadaResultado();
      return;
    }
    var sel = bancadaSelecionada();
    var cenario;
    if (sel.tipo === "promo") cenario = { tipo: "promo", promotion_id: promoIdDe(sel.promo), hipotese: campos };
    else {
      var parsed = parsePriceInput(state.pricing.novoPreco);
      if (!parsed.ok) { h.status = "idle"; h.resultado = null; h.localError = "Digite o novo preço para testar o custo."; updateBancadaResultado(); return; }
      cenario = { tipo: "preco", preco: parsed.value, hipotese: campos };
    }
    h.status = "loading";
    updateBancadaResultado();
    var seq = state.drawerSeq;
    var key = drawerKey();
    var item = findSelectedItem();
    h.timer = root.setTimeout(function () {
      h.timer = null;
      h.abort = typeof AbortController !== "undefined" ? new AbortController() : null;
      api.simular({ clienteContaId: state.contaId, mlb: item.itemId, cenarios: [cenario] }, h.abort && h.abort.signal).then(function (result) {
        if (seq !== state.drawerSeq || key !== drawerKey() || result.aborted || seqHip !== h.seq || state.bancada.hip !== h) return;
        if (!result.ok) {
          h.status = "error";
          h.error = result.error || "Não foi possível simular este custo agora.";
          h.resultado = null;
        } else {
          h.status = "ok";
          h.error = null;
          h.resultado = (result.cenarios || [])[0] || null;
        }
        updateBancadaResultado();
      });
    }, delay === undefined ? 500 : delay);
  }

  // --- Formatação da Bancada (só formatação: todo número vem pronto do /simular) ---

  // "R$ x" — vazio quando o valor não existe (nenhuma coluna mostra "—").
  function money(v) { return formatMoney(v) || ""; }

  // Número sem "R$", como nas colunas do mockup: "55,19" · "+4,71" · "−6,76" (zero nunca leva sinal).
  function formatNumero(value, signed) {
    var n = contract.numberOrNull(value);
    if (n === null) return "";
    var abs = Math.abs(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (abs === "0,00") return abs;
    return (n < 0 ? "−" : signed ? "+" : "") + abs;
  }

  // Fração do backend → "26,2%" / "+8,5%" (uma casa, como a tabela do mockup).
  function formatPct1(value, signed) {
    var n = contract.numberOrNull(value);
    if (n === null) return "";
    var abs = Math.abs(n * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    if (abs === "0,0") return abs + "%";
    return (n < 0 ? "−" : signed ? "+" : "") + abs + "%";
  }

  // Δ de margem (fração do backend) em pontos percentuais: "+0,3 pp".
  function formatPp1(value) {
    var n = contract.numberOrNull(value);
    if (n === null) return "";
    var abs = Math.abs(n * 100).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    if (abs === "0,0") return abs + " pp";
    return (n < 0 ? "−" : "+") + abs + " pp";
  }

  // Cor só em ganho/perda: verde se o número sobe o lucro, vermelho se desce, nada se é zero.
  function tomGanho(value) {
    var n = contract.numberOrNull(value);
    if (n === null || Math.abs(n) < 0.005) return "";
    return n > 0 ? " is-up" : " is-down";
  }

  function formatShortDate(value) {
    if (!value) return null;
    var d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  }

  // Tipo da promoção em caixa normal ("Deal · 19/10 a 12/11"); tipo desconhecido aparece como veio.
  var TIPO_PROMO_UI = {
    DEAL: "Deal", SMART: "Smart", SELLER_CAMPAIGN: "Campanha", MARKETPLACE_CAMPAIGN: "Campanha ML", LIGHTNING: "Lightning",
    DOD: "Oferta do dia", PRICE_DISCOUNT: "Desconto", VOLUME: "Volume", PRE_NEGOTIATED: "Pré-negociada",
    UNHEALTHY_STOCK: "Estoque parado", SELLER_COUPON_CAMPAIGN: "Cupom", PRICE_MATCHING: "Preço competitivo",
  };

  function tipoPromoTexto(tipo) {
    if (!tipo) return "";
    if (TIPO_PROMO_UI[tipo]) return TIPO_PROMO_UI[tipo];
    var t = String(tipo).replace(/_/g, " ").toLowerCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  function promoMetaTexto(p) {
    var ini = formatShortDate(p.inicio);
    var fim = formatShortDate(p.fim);
    var periodo = ini && fim ? ini + " a " + fim : ini ? "desde " + ini : fim ? "até " + fim : "";
    return [tipoPromoTexto(p.tipo), periodo].filter(Boolean).join(" · ");
  }

  // --- Ver conta completa: cascata Hoje × Cenário ----------------------------------

  function hipCelulaHtml(campo, cenValor, exibicao) {
    var h = state.bancada.hip;
    var digitado = h[campo] !== "";
    var tocado = h.edit[campo] === true;
    var valor = tocado ? h[campo] : (cenValor === null || cenValor === undefined ? "" : Number(cenValor).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 }));
    var pode = Boolean(exibicao.resultado && exibicao.resultado.cenario && exibicao.resultado.cenario[campo] !== null && exibicao.resultado.cenario[campo] !== undefined) || tocado;
    if (!pode) return escapeHtml(money(cenValor));
    return '<input class="vf-input vf-input--sm cm-banc__hip' + (digitado ? " is-hipotese" : "") + '" type="text" inputmode="decimal" autocomplete="off" data-hip="' + campo + '" value="' + escapeHtml(valor) +
      '" aria-label="' + (campo === "custo" ? "Custo" : "Taxa fixa (custos adicionais)") + ' como hipótese" title="Edite para testar outro valor — hipótese: a Base e a escrita usam os custos reais.">' +
      (digitado ? '<span class="cm-banc__hip-tag" data-cm-hipotese>hipótese</span>' : "");
  }

  // Diferença de UM componente da cascata: cor pelo IMPACTO no lucro (custo que desce é verde).
  // O valor é o efeito já decomposto pelo núcleo (`efeitos[]`), nunca uma subtração da tela.
  function deltaComponenteHtml(efeitoPorChave, chave) {
    var e = efeitoPorChave[chave];
    if (!e) return '<td class="num"></td>';
    return '<td class="num' + tomGanho(e.valor) + '">' + escapeHtml(formatNumero(e.valor, true)) + "</td>";
  }

  // "cotado em R$ P' · dd/mm hh:mm" (cotação real no preço do cenário) ou
  // "igual ao atual (mesma faixa)" quando a cotação confirma a mesma faixa.
  function freteFonteTexto(r) {
    var ev = r && r.evidencia && r.evidencia.frete;
    if (!ev || ev.fonte !== "ml_shipping_options_free" || !ev.aplicavel) return null;
    if (r.flags && r.flags.mudou_faixa_frete === false) return "igual ao atual (mesma faixa)";
    var preco = r.cenario && r.cenario.preco;
    var quando = ev.consultado_em ? formatShortDateTime(ev.consultado_em) : null;
    return "cotado em " + (money(preco) || "preço do cenário") + (quando && quando !== "—" ? " · " + quando : "");
  }

  function cascataHtml(atual, exibicao) {
    if (!atual) return '<p class="cm-empty-note" data-cm-bancada="sem-atual">A composição de hoje não está disponível (sem leitura de margem deste anúncio).</p>';
    var r = exibicao.resultado || {};
    var cen = r.cenario || {};
    var mudouFrete = r.flags && r.flags.mudou_faixa_frete === true;
    var freteFonte = freteFonteTexto(r);
    var efeitoPorChave = {};
    (r.efeitos || []).forEach(function (e) { efeitoPorChave[e.chave] = e; });
    var linhas = BANCADA_LINHAS.map(function (l) {
      var a = atual[l.chave];
      var c = cen[l.chave];
      // Retorno ML só aparece quando existe em algum dos lados (o resto da cascata é sempre mostrado).
      if (l.chave === "rebate" && !a && !c) return "";
      var mudou = c !== null && c !== undefined && a !== null && a !== undefined && a !== c;
      // Custo é a hipótese em DESTAQUE (campo próprio, fora da cascata) — só a taxa fixa é editável aqui.
      var celula = l.chave === "taxa_fixa" && !exibicao.somenteLeitura ? hipCelulaHtml(l.chave, c, exibicao) : escapeHtml(money(c));
      var aviso = l.chave === "frete" && mudouFrete ? ' <span class="cm-banc__faixa" data-cm-flag="faixa-frete" title="O frete do Mercado Livre muda neste preço.">· muda de faixa</span>' : "";
      var fonteLinha = l.chave === "frete" && freteFonte ? '<div class="cm-banc__fonte-componente" data-cm-frete-fonte>' + escapeHtml(freteFonte) + "</div>" : "";
      return '<tr data-cm-linha="' + l.chave + '"' + (mudou ? ' class="is-mudou"' : "") + '><th scope="row">' + (l.sinal ? '<span class="cm-banc__sinal" aria-hidden="true">' + l.sinal + "</span> " : "") + escapeHtml(l.rotulo) + aviso + fonteLinha + "</th>" +
        '<td class="num">' + escapeHtml(money(a)) + '</td><td class="num">' + celula + "</td>" + deltaComponenteHtml(efeitoPorChave, l.chave) + "</tr>";
    }).join("");
    var deltaLc = r.delta_lc;
    return '<table class="cm-banc__tabela" data-cm-bancada-cascata><thead><tr><th></th><th class="num">Hoje</th><th class="num">Cenário</th><th class="num">Diferença</th></tr></thead><tbody>' + linhas +
      '<tr class="cm-banc__total" data-cm-linha="lc"><th scope="row"><span class="cm-banc__sinal" aria-hidden="true">=</span> LC/un</th><td class="num">' + escapeHtml(money(atual.lc)) + '</td><td class="num"><strong>' + escapeHtml(money(cen.lc)) +
      '</strong></td><td class="num' + tomGanho(deltaLc) + '">' + escapeHtml(formatMoney(deltaLc, true) || "") + "</td></tr>" +
      '<tr class="cm-banc__total" data-cm-linha="margem"><th scope="row">Margem</th><td class="num">' + escapeHtml(formatPercent(atual.margem_ratio) || "") + '</td><td class="num"><strong>' + escapeHtml(formatPercent(cen.margem_ratio) || "") +
      '</strong></td><td class="num' + tomGanho(r.delta_margem_ratio) + '">' + escapeHtml(ppTexto(r.delta_margem_ratio) || "") + "</td></tr></tbody></table>";
  }

  // Quem banca o desconto — sempre sobre o PREÇO CHEIO (números do núcleo; a tela só os mostra).
  function bancaRodapeHtml(r) {
    if (!r || (r.ml_banca === null || r.ml_banca === undefined) && (r.desconto_total === null || r.desconto_total === undefined) && !r.banca_motivo) return "";
    var partes;
    if (r.banca_motivo === "sem_preco_cheio") {
      partes = '<span data-cm-banca="sem-cheio">Desconto: ' + escapeHtml(motivoTexto("sem_preco_cheio")) + "</span>" +
        ' · ML banca <strong>' + escapeHtml(money(r.ml_banca) || "R$ 0,00") + "</strong>";
    } else {
      var pct = r.desconto_ratio === null || r.desconto_ratio === undefined ? "" : " (" + (r.desconto_ratio < 0 ? "+" : "−") + formatPercent(Math.abs(r.desconto_ratio)) + " sobre o preço cheio)";
      partes = 'Desconto total <strong data-cm-banca="desconto">' + escapeHtml(money(r.desconto_total)) + "</strong>" + escapeHtml(pct) +
        ' · ML banca <strong data-cm-banca="ml">' + escapeHtml(money(r.ml_banca) || "R$ 0,00") + "</strong>" +
        ' · Você banca <strong data-cm-banca="seller">' + escapeHtml(money(r.seller_banca)) + "</strong>" + bancaAvisoHtml(r);
    }
    var fonte = r.preco_cheio_fonte === "promo_snapshot" ? " Preço cheio da própria promoção (original_price)." : r.preco_cheio_fonte === "margin_snapshot" ? " Preço cheio do anúncio." : "";
    return '<p class="cm-banc__banca-linha" data-cm-banca-linha>' + partes + "." + escapeHtml(fonte) + "</p>";
  }

  // Quanto a mais precisa vender para o LC TOTAL empatar com o de hoje — ou o ganho por unidade (números do núcleo).
  function empateHtml(r) {
    if (!r) return "";
    if (r.empate_volume !== null && r.empate_volume !== undefined && r.empate_volume > 0) {
      return '<p class="cm-banc__empate" data-cm-empate>Precisa vender <strong>' + escapeHtml(formatPercent(r.empate_volume, true)) + "</strong> pra empatar o LC total de hoje.</p>";
    }
    if (r.delta_lc !== null && r.delta_lc !== undefined && r.delta_lc >= 0 && r.cenario && r.cenario.lc !== null && r.cenario.lc !== undefined) {
      var menos = r.empate_volume !== null && r.empate_volume !== undefined && r.empate_volume < 0
        ? "empata o LC total de hoje mesmo vendendo " + formatPercent(Math.abs(r.empate_volume)) + " a menos"
        : "não precisa vender mais pra empatar";
      return '<p class="cm-banc__empate" data-cm-empate>Ganha LC por unidade (<strong>' + escapeHtml(formatMoney(r.delta_lc, true) || "R$ 0,00") + "</strong>) — " + escapeHtml(menos) + ".</p>";
    }
    return "";
  }

  function evidenciaBancadaHtml(r) {
    var ev = r && r.evidencia;
    if (!ev) return "";
    var partes = [];
    if (ev.comissao && ev.comissao.fonte === "ml_listing_prices") {
      partes.push(ev.comissao.consultado_em ? "cotação ao vivo do Mercado Livre às " + formatShortDateTime(ev.comissao.consultado_em) : "cotação do Mercado Livre");
    }
    if (ev.preco && ev.preco.fonte === "promo_snapshot") partes.push("promoção lida em " + (formatShortDateTime(ev.preco.observado_em) === "—" ? "data desconhecida" : formatShortDateTime(ev.preco.observado_em)));
    if (ev.preco && ev.preco.fonte === "busca_preco_alvo") partes.push("preço encontrado pela busca com cotações reais");
    if (ev.hipotese) partes.push("custo de hipótese informado por você (a Base não mudou)");
    return partes.length ? '<p class="cm-banc__fonte">' + escapeHtml(partes.join(" · ")) + ".</p>" : "";
  }

  // "Como a conta foi feita": a MESMA fórmula do cabeçalho, narrada com os
  // números já devolvidos pelo backend — nada é recalculado aqui.
  function comoAContaFoiFeitaHtml(r, atual) {
    if (!r || !r.cenario || r.cenario.lc === null || r.cenario.lc === undefined || !atual) return "";
    var c = r.cenario;
    var a = atual;
    var ev = r.evidencia || {};
    var aliquota = r.explicacao && r.explicacao.aliquota;
    var taxaPct = aliquota !== null && aliquota !== undefined ? formatPercent(aliquota) : null;
    var freteTexto = freteFonteTexto(r);
    var freteLinha = "Frete = " + (freteTexto || "no preço de " + money(c.preco)) +
      (a.frete !== null && a.frete !== c.frete ? " (antes " + money(a.frete) + " em " + money(a.preco) + ")" : "") + " = " + money(c.frete);
    var linhas = [
      taxaPct ? "Imposto = " + money(c.preco) + " × " + taxaPct + " = " + money(c.imposto) : null,
      ev.comissao && ev.comissao.fonte === "ml_listing_prices" ? "Comissão = cotação ML em " + money(c.preco) + " = " + money(c.comissao) : "Comissão = " + money(c.comissao),
      freteLinha,
      c.rebate !== null && c.rebate !== undefined ? "Retorno ML = subsídio da promoção = " + money(c.rebate) : null,
      "LC = " + money(c.preco) + " − " + money(c.imposto) + " − " + money(c.comissao) + " − " + money(c.frete) + " − " + money(c.taxa_fixa) + " − " + money(c.custo) + " + " + (money(c.rebate) || "R$ 0,00") + " = " + money(c.lc),
      "Margem = " + money(c.lc) + " ÷ " + money(c.preco) + " = " + (formatPercent(c.margem_ratio) || ""),
      r.empate_volume !== null && r.empate_volume !== undefined && a.lc !== null ? "Empate = " + money(a.lc) + " ÷ " + money(c.lc) + " − 1 = " + formatPercent(r.empate_volume, true) + " de vendas" : null,
    ].filter(Boolean);
    return '<div class="cm-banc__conta-feita" data-cm-conta-feita><h4 class="cm-banc__sub">Como a conta foi feita</h4><ul>' +
      linhas.map(function (l) { return "<li>" + escapeHtml(l) + "</li>"; }).join("") + "</ul></div>";
  }

  // --- Detalhe do cenário (o MESMO componente na Bancada e na linha expandida de Promoções) ---

  // Por que um cenário não tem número: texto curto, sem cor.
  var RESULTADO_SEM_NUMERO = { sem_desconto_efetivo: "Não reduz o preço", promocao_sem_preco: "Sem preço sugerido" };

  /** Resultado = texto + bolinha (vf-status do Portal); bloqueado diz o motivo. */
  function resultadoHtml(r) {
    if (!r) return "";
    var v = r.veredito || "bloqueado";
    var ui = VEREDITO_UI[v] || VEREDITO_UI.bloqueado;
    var label = v === "bloqueado" ? (RESULTADO_SEM_NUMERO[r.motivo] || "Bloqueado" + (r.motivo ? " · " + motivoTexto(r.motivo) : "")) : ui.label;
    return '<span class="vf-status ' + ui.tone + ' cm-res" data-cm-veredito="' + escapeHtml(v) + '">' + escapeHtml(label) + "</span>";
  }

  // Card de resposta: o veredito + UMA frase pronta do backend (`frase`); sem frase (bloqueado), o motivo.
  function respostaHtml(r) {
    if (!r) return "";
    var v = r.veredito || "bloqueado";
    var ui = VEREDITO_UI[v] || VEREDITO_UI.bloqueado;
    var titulo = v === "bloqueado" ? (RESULTADO_SEM_NUMERO[r.motivo] || "Bloqueado") : ui.label;
    var frase = r.frase || (v === "bloqueado"
      ? (RESULTADO_SEM_NUMERO[r.motivo] ? "Este cenário não tem número para comparar com hoje." : "bloqueado · " + (motivoTexto(r.motivo) || "faltam dados para calcular"))
      : motivoTexto(r.motivo));
    var avisos = [];
    if (r.flags && r.flags.rebate_ambiguo) avisos.push('<p class="cm-banc__aviso" data-cm-flag="rebate-ambiguo">Retorno ML ambíguo: mais de uma promoção com retorno em andamento.</p>');
    return '<div class="cm-banc__resposta" data-cm-resposta="' + escapeHtml(v) + '"><p class="cm-banc__veredito"><span class="vf-status ' + ui.tone + ' cm-res" data-cm-veredito="' + escapeHtml(v) + '">' + escapeHtml(titulo) + "</span></p>" +
      (frase ? '<p class="cm-banc__frase" data-cm-motivo>' + escapeHtml(frase) + "</p>" : "") + avisos.join("") + "</div>";
  }

  /** Hoje | Cenário | Diferença: Preço, LC por unidade (negrito), Margem (diferença em pp). */
  function comparativoHtml(atual, r) {
    if (!atual || !r) return "";
    var cen = r.cenario || {};
    var linha = function (rotulo, hoje, cenario, dif, tom, forte) {
      return '<tr data-cm-numero="' + escapeHtml(rotulo) + '"' + (forte ? ' class="is-forte"' : "") + '><th scope="row">' + escapeHtml(rotulo) + '</th><td class="num">' + escapeHtml(hoje) +
        '</td><td class="num">' + escapeHtml(cenario) + '</td><td class="num' + tom + '">' + escapeHtml(dif) + "</td></tr>";
    };
    return '<table class="cm-banc__cmp" data-cm-numeros-grandes><thead><tr><th></th><th class="num">Hoje</th><th class="num">Cenário</th><th class="num">Diferença</th></tr></thead><tbody>' +
      linha("Preço", formatNumero(atual.preco), formatNumero(cen.preco), formatNumero(r.delta_preco, true), tomGanho(r.delta_preco)) +
      linha("LC por unidade", formatNumero(atual.lc), formatNumero(cen.lc), formatNumero(r.delta_lc, true), tomGanho(r.delta_lc), true) +
      linha("Margem", formatPct1(atual.margem_ratio), formatPct1(cen.margem_ratio), formatPp1(r.delta_margem_ratio), tomGanho(r.delta_margem_ratio)) +
      "</tbody></table>";
  }

  // "De onde sai a diferença no lucro": uma barra fina por componente de `efeitos[]` (já ordenado
  // pelo tamanho e fechando o ΔLC no backend). A largura da barra é só proporção visual.
  function efeitosHtml(r) {
    if (!r || !Array.isArray(r.efeitos) || !r.efeitos.length) return "";
    var maior = r.efeitos.reduce(function (m, e) { return Math.max(m, Math.abs(e.valor)); }, 0) || 1;
    var mudouFrete = r.flags && r.flags.mudou_faixa_frete === true;
    var linhas = r.efeitos.map(function (e) {
      var largura = Math.round((Math.abs(e.valor) / maior) * 100);
      var aviso = e.chave === "frete" && mudouFrete ? ' <span class="cm-efeito__faixa" data-cm-flag="faixa-frete">· muda de faixa</span>' : "";
      return '<tr class="cm-efeito" data-cm-efeito="' + escapeHtml(e.chave) + '"><th scope="row" class="cm-efeito__rotulo">' + escapeHtml(e.rotulo) + aviso + "</th>" +
        '<td class="cm-efeito__barra-cel"><span class="cm-efeito__barra" aria-hidden="true"><span class="cm-efeito__preenchido' + tomGanho(e.valor) + '" style="width:' + largura + '%"></span></span></td>' +
        '<td class="num cm-efeito__valor' + tomGanho(e.valor) + '">' + escapeHtml(formatNumero(e.valor, true)) + "</td></tr>";
    }).join("");
    return '<div class="cm-banc__efeitos" data-cm-efeitos><h4 class="cm-banc__sub">De onde sai a diferença no lucro</h4><table class="cm-efeitos"><tbody>' + linhas +
      '<tr class="cm-efeito cm-efeito--total"><th scope="row">Total no LC por unidade</th><td></td><td class="num cm-efeito__valor' + tomGanho(r.delta_lc) + '"><strong>' + escapeHtml(formatNumero(r.delta_lc, true)) + "</strong></td></tr></tbody></table></div>";
  }

  // Custo em destaque: a hipótese PRINCIPAL, sempre visível, com o custo da Base ao lado.
  function hipoteseCustoHtml(ex, atual) {
    if (!ex || ex.somenteLeitura) return "";
    var cen = (ex.resultado && ex.resultado.cenario) || {};
    var base = atual && atual.custo !== null && atual.custo !== undefined ? '<span class="cm-banc__hip-base">Base: ' + escapeHtml(money(atual.custo)) + "</span>" : "";
    return '<div class="cm-banc__hip-destaque" data-cm-hip-destaque><span class="cm-banc__hip-destaque-rotulo">Custo (hipótese)</span>' + hipCelulaHtml("custo", cen.custo, ex) + base + "</div>";
  }

  /** Corpo do detalhe: resposta → Hoje×Cenário → de onde sai a diferença → [custo] → Ver conta completa. */
  function cenarioDetalheHtml(r, atual, ex, opts) {
    var exibicao = ex || { resultado: r, hipotese: false, somenteLeitura: true };
    // Na aba Promoções quem banca e o empate ficam visíveis ao lado (`bancaFora`): não se repetem aqui dentro.
    var bancaDentro = opts && opts.bancaFora ? "" : bancaRodapeHtml(r) + empateHtml(r);
    var contaCompleta = '<details class="cm-banc__conta-completa" data-cm-conta-completa><summary>Ver conta completa</summary>' +
      cascataHtml(atual, exibicao) + bancaDentro + comoAContaFoiFeitaHtml(r, atual) + evidenciaBancadaHtml(r) + "</details>";
    return respostaHtml(r) + comparativoHtml(atual, r) + efeitosHtml(r) + hipoteseCustoHtml(ex, atual) + contaCompleta;
  }

  // --- Esquerda: o cenário selecionado ----------------------------------------------

  function grupoTitulo(chave) {
    var g = BANCADA_GRUPOS.filter(function (x) { return x.chave === chave; })[0];
    return g ? g.titulo : "";
  }

  // "sai da promoção ativa" quando hoje há retorno ML (o preço digitado tira o anúncio da promoção).
  function seuPrecoMeta() {
    var atual = bancadaAtual();
    var temAtiva = bancadaPromos().some(function (c) { return c.promocao && c.promocao.grupo === "ativa"; });
    return temAtiva || (atual && atual.rebate) ? "sai da promoção ativa" : "compare com hoje";
  }

  function bancadaCenarioTituloHtml(sel) {
    if (!sel.promo) {
      return '<div class="cm-banc__titulo" data-cm-cenario-titulo="preco"><span class="cm-banc__titulo-grupo">Seu preço</span><strong class="cm-banc__titulo-nome">Preço manual</strong>' +
        '<span class="cm-banc__titulo-meta">' + escapeHtml(seuPrecoMeta()) + "</span></div>";
    }
    var p = sel.promo.promocao || {};
    return '<div class="cm-banc__titulo" data-cm-promo-info="' + escapeHtml(promoIdDe(sel.promo)) + '"><span class="cm-banc__titulo-grupo">' + escapeHtml(grupoTitulo(p.grupo || "ml")) + "</span>" +
      '<strong class="cm-banc__titulo-nome">' + escapeHtml(p.nome || tipoPromoTexto(p.tipo) || "Promoção") + "</strong>" +
      '<span class="cm-banc__titulo-meta">' + escapeHtml(promoMetaTexto(p)) + (promoEhEstimativa(p) ? " · estimativa do diagnóstico legado" : "") + "</span></div>";
  }

  /** Miolo da esquerda — redesenhado a cada resposta, sem recarregar o drawer. */
  function bancadaResultadoHtml() {
    var b = state.bancada;
    var ex = bancadaEmExibicao();
    var atual = bancadaAtual();
    var titulo = bancadaCenarioTituloHtml(ex);
    if (ex.tipo === "preco" && !ex.hipotese) {
      var m = b.manual;
      if (m.localError) return titulo + '<p class="cm-field-error" role="alert">' + escapeHtml(m.localError) + "</p>";
      if (m.status === "loading") return titulo + '<div class="vf-loading-state" role="status"><span class="vf-spinner" aria-hidden="true"></span><span>Calculando no backend com a cotação real do Mercado Livre…</span></div>';
      if (m.status === "error") return titulo + '<p class="cm-field-error" role="alert">' + escapeHtml(m.error || "Não foi possível simular.") + "</p>";
      if (!m.resultado) return titulo + '<p class="cm-empty-note" data-cm-bancada="digite">Digite o novo preço em “Preço manual” para comparar com hoje.</p>';
    }
    var h = b.hip;
    var hipAviso = "";
    if (ex.hipotese) {
      var estado = ex.erro ? '<span class="cm-field-error" role="alert">' + escapeHtml(ex.erro) + "</span>"
        : ex.carregando ? "calculando a hipótese…" : "";
      hipAviso = '<p class="cm-banc__hip-aviso" data-cm-hip-aviso><strong>Hipótese de custo.</strong> A Base e a escrita usam os custos reais; este cenário é só para comparar. ' + estado +
        ' <button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" id="cm-hip-reset">Restaurar custos reais</button></p>';
    } else if (h.localError) {
      hipAviso = '<p class="cm-field-error" role="alert">' + escapeHtml(h.localError) + "</p>";
    }
    return titulo + hipAviso + cenarioDetalheHtml(ex.resultado, atual, ex);
  }

  // --- Direita: a lista de cenários --------------------------------------------------

  function bancadaPrecoAlvoHtml(item) {
    var b = state.bancada;
    var chips = "";
    if (b.alvo) {
      var pa = b.alvo.preco_alvo || {};
      chips += pa.encontrado
        ? '<button class="vf-btn vf-btn--secondary vf-btn--sm" type="button" data-price-chip="' + pa.preco + '" data-cm-chip="alvo" title="Menor preço que atinge a meta, com a cotação real do Mercado Livre em cada preço tentado">Subir p/ ' + escapeHtml(money(pa.preco)) + "</button>"
        : '<span class="cm-banc__nota" data-cm-chip="sem-preco-viavel" title="' + escapeHtml(motivoTexto(pa.motivo) + (pa.causa ? ": " + motivoTexto(pa.causa) : "")) + '">sem preço viável p/ a meta</span>';
    } else if (b.status === "loading") {
      chips += '<span class="cm-banc__nota" data-cm-chip="calculando">calculando preço-alvo…</span>';
    }
    if (item.breakEvenPrice !== null && item.breakEvenPrice !== undefined) {
      chips += '<button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" data-price-chip="' + item.breakEvenPrice + '" data-cm-chip="break-even" title="Preço de equilíbrio (LC zero) de referência do Motor">Break-even ' + escapeHtml(money(item.breakEvenPrice)) + "</button>";
    }
    return chips ? '<div class="cm-pp__chips">' + chips + "</div>" : "";
  }

  /** Promoção do diagnóstico legado: estimativa (sem leitura de hoje no Mercado Livre). */
  function promoEhEstimativa(promocao) {
    return promoFonte ? promoFonte.estimativa(promocao) : Boolean(promocao && promocao.estimativa === true);
  }

  var MOTIVO_ESTIMATIVA = "É só uma estimativa do diagnóstico legado: sem leitura atual do Mercado Livre, não dá para participar. Aguarde a sincronização das promoções desta conta.";

  /** Sem simulação possível (sem preço sugerido, P' ≥ preço, bloqueado): a linha fica cinza e desabilitada. */
  function cardDesabilitado(cenario) {
    return !cenario || cenario.veredito === "bloqueado";
  }

  var TITULO_DESABILITADO = {
    promocao_sem_preco: "Sem sugestão do Mercado Livre para esta promoção: não há preço para simular.",
    sem_desconto_efetivo: "O preço desta promoção não é menor que o de hoje: não há desconto para simular.",
  };

  // "−7,52 (−14%)" contra hoje (delta_preco e variacao_preco_ratio do backend) ou "sem mudança".
  function mudancaPrecoTexto(r) {
    var d = r ? contract.numberOrNull(r.delta_preco) : null;
    if (d === null) return "";
    if (Math.abs(d) < 0.005) return "sem mudança";
    var ratio = contract.numberOrNull(r.variacao_preco_ratio);
    var pct = ratio === null ? "" : Math.abs(ratio * 100).toLocaleString("pt-BR", { maximumFractionDigits: 0 });
    return formatNumero(d, true) + (pct === "" ? "" : " (" + (pct === "0" ? "" : ratio < 0 ? "−" : "+") + pct + "%)");
  }

  // Meta da linha: tipo · datas · "ML paga R$ x" quando o retorno do cenário é > 0.
  function metaCenarioTexto(p, r) {
    var rebate = r && r.cenario ? contract.numberOrNull(r.cenario.rebate) : null;
    return [promoMetaTexto(p), rebate !== null && rebate >= 0.005 ? "ML paga " + money(rebate) : ""].filter(Boolean).join(" · ");
  }

  /** As três colunas numéricas de uma linha: preço (+ mudança), LC (+ vs hoje) e resultado. */
  function celulasCenario(r, opts) {
    var cen = (r && r.cenario) || {};
    var o = opts || {};
    var lc = contract.numberOrNull(cen.lc);
    var dLc = r ? contract.numberOrNull(r.delta_lc) : null;
    return {
      preco: o.precoHtml !== undefined ? o.precoHtml : (cen.preco !== null && cen.preco !== undefined ? '<span class="cm-cen__num">' + escapeHtml(formatNumero(cen.preco)) + "</span>" : ""),
      precoSub: r ? '<small class="cm-cen__sub" data-cm-mudanca>' + escapeHtml(mudancaPrecoTexto(r)) + "</small>" : "",
      lc: lc !== null ? '<span class="cm-cen__num">' + escapeHtml(formatNumero(lc)) + "</span>" : "",
      lcSub: dLc !== null ? '<small class="cm-cen__sub cm-banc__vs' + tomGanho(dLc) + '" data-cm-vs>' + escapeHtml(formatNumero(dLc, true)) + "</small>" : "",
      res: o.resultadoHtml !== undefined ? o.resultadoHtml : resultadoHtml(r),
    };
  }

  /**
   * Uma linha da tabela de cenários (role=radio, a linha inteira é clicável):
   * Cenário (radio · nome · meta) | Preço · mudança | LC/un · vs hoje | Resultado.
   */
  function linhaCenarioHtml(o) {
    var c = celulasCenario(o.resultado, o);
    return '<div class="cm-cen' + (o.ativo ? " is-active" : "") + '" role="radio" tabindex="0" aria-checked="' + (o.ativo ? "true" : "false") + '" data-cenario="' + escapeHtml(o.id) + '"' +
      (o.estimada ? " data-cm-estimativa" : "") + (o.titulo ? ' title="' + escapeHtml(o.titulo) + '"' : "") + (o.attrs || "") + ">" +
      '<span class="cm-cen__cenario"><span class="cm-cen__radio" aria-hidden="true"></span><span class="cm-cen__nome"><strong title="' + escapeHtml(o.nome) + '">' + escapeHtml(o.nome) + "</strong>" +
        '<span class="cm-cen__meta">' + escapeHtml(o.meta) + (o.metaHtml || "") + "</span></span></span>" +
      '<span class="cm-cen__preco" data-cm-col="preco">' + c.preco + '<span class="cm-cen__preco-sub">' + c.precoSub + "</span></span>" +
      '<span class="cm-cen__lc" data-cm-col="lc">' + c.lc + c.lcSub + "</span>" +
      '<span class="cm-cen__res" data-cm-col="resultado">' + c.res + "</span></div>";
  }

  function promoCardHtml(c) {
    var b = state.bancada;
    var p = c.promocao;
    var id = promoIdDe(c);
    var estimada = promoEhEstimativa(p);
    return linhaCenarioHtml({
      id: id, resultado: c, ativo: String(b.selecionado) === String(id), estimada: estimada, titulo: estimada ? MOTIVO_ESTIMATIVA : "",
      nome: p.nome || tipoPromoTexto(p.tipo) || "Promoção",
      meta: metaCenarioTexto(p, c),
      // Estimativa do diagnóstico legado: texto cinza na meta (nada de selo colorido); o motivo vai no rodapé.
      metaHtml: estimada ? ' · <span data-cm-flag="estimativa">estimativa · diagnóstico legado</span>' : "",
    });
  }

  // Linha "Preço manual": o resultado do preço digitado no campo inline (as células mudam; o campo não).
  function manualCelulas() {
    var m = state.bancada.manual;
    var res = m.status === "loading" ? '<span class="cm-banc__nota">calculando…</span>'
      : m.localError ? '<span class="cm-banc__nota">preço inválido</span>'
        : m.status === "error" ? '<span class="cm-banc__nota">não simulado</span>'
          : m.resultado ? undefined : '<span class="cm-banc__nota">digite um preço</span>';
    return celulasCenario(m.status === "ok" ? m.resultado : null, { precoHtml: "", resultadoHtml: res });
  }

  /** Primeira linha: radio · "Preço manual" · campo 84×30 na coluna Preço. Desenhada UMA vez por abertura do drawer. */
  function bancadaManualCardHtml() {
    var b = state.bancada;
    var c = manualCelulas();
    var ativo = String(b.selecionado) === "preco";
    return '<div class="cm-cen cm-cen--manual' + (ativo ? " is-active" : "") + '" role="radio" tabindex="0" aria-checked="' + (ativo ? "true" : "false") + '" data-cenario="preco" id="cm-banc-manual">' +
      '<span class="cm-cen__cenario"><span class="cm-cen__radio" aria-hidden="true"></span><span class="cm-cen__nome"><strong>Preço manual</strong><span class="cm-cen__meta">' + escapeHtml(seuPrecoMeta()) + "</span></span></span>" +
      '<span class="cm-cen__preco" data-cm-col="preco"><input class="vf-input vf-input--sm cm-cen__input" id="cm-new-price" inputmode="decimal" autocomplete="off" placeholder="0,00" aria-label="Preço manual" value="' + escapeHtml(state.pricing.novoPreco) + '">' +
        '<span class="cm-cen__preco-sub" id="cm-man-preco-sub">' + c.precoSub + "</span></span>" +
      '<span class="cm-cen__lc" data-cm-col="lc" id="cm-man-lc">' + c.lc + c.lcSub + "</span>" +
      '<span class="cm-cen__res" data-cm-col="resultado" id="cm-man-res">' + c.res + "</span></div>";
  }

  /** Atualiza só as células da linha "Preço manual" (o campo digitado nunca é redesenhado). */
  function atualizarLinhaManual() {
    var linha = el("cm-banc-manual");
    if (!linha) return;
    var c = manualCelulas();
    var ativo = String(state.bancada.selecionado) === "preco";
    linha.classList.toggle("is-active", ativo);
    linha.setAttribute("aria-checked", ativo ? "true" : "false");
    el("cm-man-preco-sub").innerHTML = c.precoSub;
    el("cm-man-lc").innerHTML = c.lc + c.lcSub;
    el("cm-man-res").innerHTML = c.res;
  }

  // Por que uma promoção ficou fora da tabela (sem número para comparar com hoje).
  function motivoSemSimulacao(c) {
    return RESULTADO_SEM_NUMERO[c.motivo] || (motivoTexto(c.motivo) ? "Bloqueado · " + motivoTexto(c.motivo) : "Bloqueado");
  }

  /** Grupos como linha-título DENTRO da tabela; só grupos com cenário simulável. Sem simulação: recolhidas no fim. */
  function bancadaPromosHtml() {
    var b = state.bancada;
    var promos = bancadaPromos().filter(function (c) { return c.promocao; });
    var html = "";
    BANCADA_GRUPOS.forEach(function (g) {
      var itens = promos.filter(function (c) { return (c.promocao.grupo || "ml") === g.chave && !cardDesabilitado(c); });
      if (!itens.length) return;
      html += '<div class="cm-cens__grupo" data-grupo="' + g.chave + '" title="' + escapeHtml(g.dica) + '">' + escapeHtml(g.titulo) + "</div>" + itens.map(promoCardHtml).join("");
    });
    var sem = promos.filter(cardDesabilitado);
    if (sem.length) {
      var soPreco = sem.every(function (c) { return RESULTADO_SEM_NUMERO[c.motivo]; });
      var rotulo = sem.length + (sem.length === 1 ? " promoção " : " promoções ") + (soPreco ? "sem efeito no preço" : "sem simulação");
      html += '<details class="cm-cens__sem" data-cm-sem-simulacao' + (b.semAberto ? " open" : "") + "><summary>" + escapeHtml(rotulo) + "</summary><ul>" +
        sem.map(function (c) {
          var p = c.promocao;
          return '<li data-cm-sem="' + escapeHtml(promoIdDe(c)) + '" title="' + escapeHtml(TITULO_DESABILITADO[c.motivo] || "") + '"><span class="cm-cens__sem-nome">' + escapeHtml(p.nome || tipoPromoTexto(p.tipo) || "Promoção") + "</span>" +
            '<span class="cm-cens__sem-info">' + escapeHtml(grupoTitulo(p.grupo || "ml") + " · " + motivoSemSimulacao(c)) + "</span></li>";
        }).join("") + "</ul></details>";
    }
    return html;
  }

  /** UMA tabela num único card: cabeçalho único, "Preço manual" primeiro, grupos dentro, sem simulação no fim. */
  function bancadaSeletorHtml(item) {
    var sugestoes = bancadaPrecoAlvoHtml(item);
    return '<div class="cm-cens" id="cm-banc-cenarios" role="radiogroup" aria-label="Cenário" data-cm-cenarios>' +
      '<div class="cm-cens__cab" aria-hidden="true"><span>Cenário</span><span class="num">Preço · mudança</span><span class="num">LC / un · vs hoje</span><span>Resultado</span></div>' +
      '<div id="cm-banc-manual-card">' + bancadaManualCardHtml() + "</div>" +
      '<div id="cm-banc-promos">' + bancadaPromosHtml() + "</div></div>" +
      (sugestoes ? '<div class="cm-banc__sugestoes">' + sugestoes + "</div>" : "");
  }

  // --- Rodapé fixo: um botão primário, dinâmico pelo cenário ---------------------------

  /**
   * O que o botão faz para o cenário em exibição:
   *   Seu preço ........................... "Revisar novo preço" (preview do preço)
   *   promoção que a Central escreve ...... "Participar desta promoção" (preview da participação)
   *   Ativa agora ......................... "Já em vigor" (desabilitado: é o preço de hoje)
   *   qualquer outra (já participa,
   *   Só pelo Mercado Livre) .............. "Abrir no Mercado Livre" (link externo, nada é escrito)
   * Desabilitado se bloqueado (e, na participação, se o veredito é "Não vale"); com hipótese de
   * custo ativa também — a escrita usa os custos reais. Escrita desligada: o preview abre e diz por quê.
   */
  function bancadaBotaoSpec() {
    var ex = bancadaEmExibicao();
    var sel = bancadaSelecionada();
    var r = sel.resultado;
    var b = state.bancada;
    var base = { kind: "preco", rotulo: "Revisar novo preço", href: null, disabled: true, title: "", dica: "Abre a revisão: relê o anúncio ao vivo antes de alterar o preço." };
    if (sel.tipo === "preco") {
      var pode = Boolean(r) && r.veredito !== "bloqueado" && bancadaDisponivel().ok && b.manual.status === "ok";
      var motivo = !r ? "Digite um preço calculado." : r.veredito === "bloqueado" ? "Cenário bloqueado: " + motivoTexto(r.motivo) + "." : "";
      if (pode && ex.hipotese) { pode = false; motivo = "Hipótese de custo: a escrita usa os custos reais da Base. Restaure os custos para revisar."; }
      return Object.assign(base, { disabled: !pode, title: motivo });
    }
    var p = sel.promo.promocao || {};
    if (p.grupo === "ativa" || (r && r.veredito === "ativa")) {
      return { kind: "vigor", rotulo: "Já em vigor", href: null, disabled: true, title: "Esta promoção já forma o preço de hoje.", dica: "Esta promoção já forma o preço de hoje: não há o que revisar." };
    }
    var participar = p.grupo === "pode" && p.escrita && p.escrita.suportada && p.escrita.acao === "PARTICIPAR";
    if (!participar) {
      var url = bancadaData("ml_promos_url");
      var motivoMl = p.escrita && p.escrita.motivo ? p.escrita.motivo : "A inscrição/alteração desta promoção é feita no painel do Mercado Livre.";
      return { kind: "ml", rotulo: "Abrir no Mercado Livre", href: url, disabled: !url, title: url ? motivoMl : "Sem link do Mercado Livre para este anúncio.", dica: "A inscrição desta promoção é feita no painel do Mercado Livre: abre em outra aba, nada é escrito aqui." };
    }
    var dicaPart = "Abre a revisão: relê a promoção ao vivo e avalia os gates antes de participar.";
    // Promoção do diagnóstico legado é só estimativa: Participar fica desabilitado até haver leitura atual.
    if (promoEhEstimativa(p)) return { kind: "promocao", rotulo: "Participar desta promoção", href: null, disabled: true, title: MOTIVO_ESTIMATIVA, estimativa: true, dica: MOTIVO_ESTIMATIVA };
    var vered = r ? r.veredito : null;
    var liberado = (vered === "entrar" || vered === "entrar_se_girar") && bancadaDisponivel().ok;
    var motivoPart = "";
    if (!r || vered === "bloqueado") motivoPart = "Cenário bloqueado: " + motivoTexto(r && r.motivo) + ".";
    else if (vered === "nao_entrar") motivoPart = "Veredito “Não vale”: " + (motivoTexto(r.motivo) || "o cenário não compensa") + ".";
    if (liberado && ex.hipotese) { liberado = false; motivoPart = "Hipótese de custo: a escrita usa os custos reais da Base. Restaure os custos para participar."; }
    return { kind: "promocao", rotulo: "Participar desta promoção", href: null, disabled: !liberado, title: motivoPart, dica: dicaPart };
  }

  function bancadaData(campo) {
    var d = state.bancada && state.bancada.data;
    return d && d.item ? d.item[campo] || null : null;
  }

  function bancadaBotaoHtml() {
    var spec = bancadaBotaoSpec();
    if (spec.kind === "ml") {
      return spec.href && !spec.disabled
        ? '<a class="vf-btn vf-btn--primary" id="cm-bancada-ml" data-cm-review="ML" href="' + escapeHtml(spec.href) + '" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(spec.title) + '">' + spec.rotulo + " ↗</a>"
        : '<button class="vf-btn vf-btn--primary" type="button" id="cm-bancada-ml" data-cm-review="ML" disabled title="' + escapeHtml(spec.title) + '">' + spec.rotulo + "</button>";
    }
    if (spec.kind === "vigor") {
      return '<button class="vf-btn vf-btn--primary" type="button" id="cm-bancada-vigor" data-cm-review="VIGOR" disabled title="' + escapeHtml(spec.title) + '">' + spec.rotulo + "</button>";
    }
    return '<button class="vf-btn vf-btn--primary" type="button" id="cm-bancada-review" data-cm-review="' + (spec.kind === "promocao" ? "PROMOTION" : "PRICE") + '"' + (spec.disabled ? " disabled" : "") +
      (spec.title ? ' title="' + escapeHtml(spec.title) + '"' : "") + ">" + spec.rotulo + "</button>";
  }

  /** Texto cinza do rodapé: o que acontece ao clicar (ou por que o botão está desligado). */
  function bancadaDicaTexto() {
    var spec = bancadaBotaoSpec();
    return spec.disabled && spec.title && spec.kind !== "vigor" ? spec.title : spec.dica;
  }

  /** Rodapé fixo do drawer: dica à esquerda, Fechar e o botão primário dinâmico. */
  function renderBancadaRodape() {
    var host = el("cm-banc-botao");
    if (!host) return;
    var pronta = state.drawerTab === "pricing" && state.bancada && state.bancada.data && bancadaDisponivel().ok && state.bancada.status !== "error";
    host.innerHTML = pronta ? bancadaBotaoHtml() : "";
    if (pronta) refs.drawerPosition.textContent = bancadaDicaTexto();
    refs.drawerPosition.classList.toggle("cm-drawer__hint", Boolean(pronta));
    var review = el("cm-bancada-review");
    if (review) review.addEventListener("click", reviewDaBancada);
  }

  function bancadaHtml(item) {
    var availability = bancadaDisponivel();
    var b = state.bancada;
    if (!availability.ok) {
      return '<section class="cm-banc" aria-labelledby="cm-banc-title"><h3 class="vf-visually-hidden" id="cm-banc-title">Bancada</h3><p class="cm-empty-note">' + escapeHtml(availability.reason) + "</p>" + advancedSimulationHtml(item) + "</section>";
    }
    var corpo;
    if (b.status === "loading" && !b.data) {
      corpo = '<div class="vf-loading-state" role="status" data-cm-bancada="loading"><span class="vf-spinner" aria-hidden="true"></span><span>Montando a bancada: promoções do anúncio e cotação real…</span></div>';
    } else if (b.status === "error") {
      corpo = '<p class="cm-field-error" role="alert" data-cm-bancada="erro">' + escapeHtml(b.error) + ' <button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" id="cm-bancada-retry">Tentar de novo</button></p>';
    } else {
      // Fonte única: a mesma linha da aba Promoções (estado, último bom, falha, legado). Servidor antigo: o aviso de antes.
      var fp = b.data && b.data.fontePromocoes;
      var linhaFonte = promoFonteLinha(fp);
      var semPromos = linhaFonte
        ? '<span class="cm-banc__fonte-lista" data-cm-promo-fonte data-cm-promo-estado="' + escapeHtml(fp.estado) + '">' + escapeHtml(linhaFonte) + "</span>"
        : b.data && b.data.promocoes && b.data.promocoes.disponivel === false
          ? '<span class="cm-banc__fonte-lista" data-cm-bancada="sem-promos">Promoções indisponíveis: ' + escapeHtml(motivoTexto(b.data.promocoes.motivo)) + ".</span>" : "";
      var ap = state.pricing && state.pricing.aplicacao;
      var defasado = ap && (ap.status === "aplicado" || ap.status === "divergente") && ["atualizado", "nao_aplicavel"].indexOf(ap.snapshotStatus) === -1
        ? '<p class="cm-banc__nota" data-cm-bancada="atual-defasado">A coluna Hoje ainda é a de antes da alteração; ela é atualizada quando a margem for recalculada.</p>' : "";
      var avisoPromo = b.aviso ? '<p class="cm-banc__nota" role="status" data-cm-bancada="promo-nao-encontrada">' + escapeHtml(b.aviso) + "</p>" : "";
      corpo = defasado + avisoPromo +
        '<div class="cm-banc__grid">' +
          // Esquerda 480px: o cenário selecionado e, no fim, a Simulação avançada (fechada).
          '<div class="cm-banc__esq"><div class="cm-banc__resultado" id="cm-banc-resultado" aria-live="polite">' + bancadaResultadoHtml() + "</div>" + advancedSimulationHtml(item) + "</div>" +
          '<div class="cm-banc__dir"><header class="cm-banc__dir-cab"><h3 class="cm-banc__dir-titulo" id="cm-banc-title">Cenários</h3>' + semPromos + "</header>" + bancadaSeletorHtml(item) + "</div>" +
        "</div>";
    }
    return '<section class="cm-banc" aria-labelledby="cm-banc-title" data-cm-bancada-status="' + escapeHtml(b.status) + '">' + corpo + "</section>";
  }

  function selecionarCenario(novo) {
    if (!novo || String(state.bancada.selecionado) === String(novo)) return;
    limparHipotese();
    state.bancada.selecionado = novo;
    // Só a esquerda, a tabela e o rodapé mudam: o drawer não é recarregado.
    updateBancadaResultado(true);
  }

  /** Tabela de cenários: um listener (delegado) para clique e teclado — as linhas são redesenhadas, o card não. */
  function bindCenarios() {
    var tabela = el("cm-banc-cenarios");
    if (!tabela) return;
    tabela.addEventListener("click", function (event) {
      var linha = event.target.closest ? event.target.closest("[data-cenario]") : null;
      if (linha && tabela.contains(linha)) selecionarCenario(linha.getAttribute("data-cenario"));
    });
    tabela.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.target.tagName === "INPUT" || !event.target.hasAttribute("data-cenario")) return;
      event.preventDefault();
      selecionarCenario(event.target.getAttribute("data-cenario"));
    });
    bindSemSimulacao();
  }

  // "N promoções sem efeito no preço": fechado por padrão; aberto só se o operador abrir (sobrevive ao redesenho).
  function bindSemSimulacao() {
    var sem = refs.drawerBody.querySelector("[data-cm-sem-simulacao]");
    if (sem) sem.addEventListener("toggle", function () { state.bancada.semAberto = sem.open; });
  }

  function bindHipotese() {
    Array.prototype.forEach.call(refs.drawerBody.querySelectorAll("[data-hip]"), function (campo) {
      campo.addEventListener("input", function () {
        var nome = campo.getAttribute("data-hip");
        state.bancada.hip[nome] = campo.value.trim();
        state.bancada.hip.edit[nome] = true;
        simularHipotese();
      });
    });
    var reset = el("cm-hip-reset");
    if (reset) reset.addEventListener("click", function () { limparHipotese(); updateBancadaResultado(); });
    // "Ver conta completa" aberto/fechado sobrevive ao redesenho da coluna.
    var conta = refs.drawerBody.querySelector("#cm-banc-resultado [data-cm-conta-completa]");
    if (conta) {
      if (state.bancada.contaAberta) conta.setAttribute("open", "");
      conta.addEventListener("toggle", function () { state.bancada.contaAberta = conta.open; });
    }
  }

  /** Preserva o foco e o cursor de um campo de hipótese enquanto a coluna é redesenhada. */
  function preservandoFoco(fn) {
    var ativo = document.activeElement;
    var campo = ativo && ativo.getAttribute ? ativo.getAttribute("data-hip") : null;
    var ini = campo && typeof ativo.selectionStart === "number" ? ativo.selectionStart : null;
    var fim = campo && typeof ativo.selectionEnd === "number" ? ativo.selectionEnd : null;
    var cenario = !campo && ativo && ativo.getAttribute ? ativo.getAttribute("data-cenario") : null;
    fn();
    if (cenario) {
      var linha = refs.drawerBody.querySelector('[data-cenario="' + cenario + '"]');
      if (linha) linha.focus();
      return;
    }
    if (!campo) return;
    var novo = refs.drawerBody.querySelector('[data-hip="' + campo + '"]');
    if (!novo) return;
    novo.focus();
    if (ini !== null) { try { novo.setSelectionRange(ini, fim); } catch (_) { /* tipo sem seleção */ } }
  }

  /** Redesenha a esquerda e o rodapé (o input não perde foco nem cursor); `comSeletor` também a lista de cenários. */
  function updateBancadaResultado(comSeletor) {
    if (state.drawerTab !== "pricing") return;
    var host = el("cm-banc-resultado");
    if (!host) { renderBancada(); return; }
    preservandoFoco(function () {
      if (comSeletor === true) {
        // Só as linhas de promoções: a linha "Preço manual" troca só as células (o campo não é tocado).
        var promos = el("cm-banc-promos");
        if (promos) promos.innerHTML = bancadaPromosHtml();
        bindSemSimulacao();
      }
      atualizarLinhaManual();
      host.innerHTML = bancadaResultadoHtml();
      bindHipotese();
      renderBancadaRodape();
    });
  }

  function reviewDaBancada() {
    var spec = bancadaBotaoSpec();
    if (spec.disabled || spec.kind === "ml" || spec.kind === "vigor") return;
    var sel = bancadaSelecionada();
    if (sel.tipo === "promo") {
      var p = sel.promo.promocao;
      reviewPricing("PROMOTION", { id: p.id, nome: p.nome, tipo: p.tipo }, null);
      return;
    }
    var parsed = parsePriceInput(state.pricing.novoPreco);
    if (!parsed.ok) return;
    reviewPricing("PRICE", null, parsed.value);
  }

  function advancedSimulationHtml(item) {
    if (item.stub || !state.scenario) return "";
    var simulation = contract.simulateScenario(item, state.scenario, state.selection);
    var rows = contract.VARIABLES.map(function (variableKey) {
      var changed = simulation.changed.indexOf(variableKey) !== -1;
      var inputValue = simulation.values[variableKey] === null ? "" : String(simulation.values[variableKey]);
      return "<tr><td>" + escapeHtml(contract.VARIABLE_META[variableKey].label) + (changed ? ' <span class="cm-changed">alterada</span>' : "") + "</td>" +
        '<td><input class="cm-scenario-input" type="number" step="0.0001" value="' + escapeHtml(inputValue) + '" data-scenario-value="' + variableKey +
        '" aria-label="Valor hipotético de ' + escapeHtml(contract.VARIABLE_META[variableKey].label) + '"></td>' +
        '<td class="cm-scenario-base">' + escapeHtml(formatByVariable(variableKey, simulation.baseline.values[variableKey]) || "Indisponível") + "</td></tr>";
    }).join("");
    var resultado = simulation.pending
      ? '<p class="cm-adv__result" data-cm-calc-pending>Calculando no Motor…</p>'
      : simulation.failed
        ? '<p class="cm-adv__result cm-field-error" role="alert">Não foi possível calcular agora: ' + escapeHtml(simulation.failureReason || "tente de novo.") + "</p>"
        : '<p class="cm-adv__result">Resultado hipotético: LC ' + escapeHtml(simulation.computable ? formatMoney(simulation.profit) : "—") + " · MC " +
          escapeHtml(simulation.computable ? formatPercent(simulation.margin) : "—") +
          (simulation.computable ? "" : " · cenário incompleto: falta " + escapeHtml(simulation.missing.map(variableLabel).join(", "))) + "</p>";
    return '<details class="cm-adv"' + (state.advancedOpen ? " open" : "") + ' id="cm-adv"><summary>Simulação avançada <small>hipótese — o cálculo é do Motor, não é decisão</small></summary>' +
      '<p class="cm-adv__warn"><strong>Somente simulação.</strong> Não grava na Base, não muda comissão, não muda o custo real e não altera nada no Mercado Livre. Só o <strong>preço</strong> pode virar escrita real.</p>' +
      '<div class="vf-table-wrap"><table class="vf-table vf-table--compact cm-scenario-table"><thead><tr><th>Variável</th><th>Hipótese</th><th>Fonte atual</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
      resultado +
      '<button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" id="cm-scenario-reset"' + (simulation.changed.length ? "" : " disabled") + ">Restaurar hipótese</button>" +
      "</details>";
  }

  function renderPricingTab(item) {
    refs.drawerBody.innerHTML = bancadaHtml(item);
    bindPricingControls(item);
    renderBancadaRodape();
    scheduleCalcs();
  }

  function bindPricingControls(item) {
    var input = el("cm-new-price");
    if (input) {
      input.addEventListener("input", function () {
        state.pricing.novoPreco = input.value;
        // Digitar um preço seleciona a linha "Preço manual" (o drawer não é recarregado).
        if (String(state.bancada.selecionado) !== "preco") limparHipotese();
        state.bancada.selecionado = "preco";
        simularManual();
      });
    }
    Array.prototype.forEach.call(refs.drawerBody.querySelectorAll("[data-price-chip]"), function (chip) {
      chip.addEventListener("click", function () {
        state.pricing.novoPreco = Number(chip.getAttribute("data-price-chip")).toFixed(2).replace(".", ",");
        if (String(state.bancada.selecionado) !== "preco") limparHipotese();
        state.bancada.selecionado = "preco";
        simularManual(0);
        renderDrawer();
      });
    });
    bindCenarios();
    bindHipotese();
    var review = el("cm-bancada-review");
    if (review) review.addEventListener("click", reviewDaBancada);
    var retry = el("cm-bancada-retry");
    if (retry) retry.addEventListener("click", function () { loadBancada(item); renderDrawer(); });
    var adv = el("cm-adv");
    if (adv) adv.addEventListener("toggle", function () { state.advancedOpen = adv.open; });
    Array.prototype.forEach.call(refs.drawerBody.querySelectorAll("[data-scenario-value]"), function (field) {
      field.addEventListener("change", function () {
        var key = field.getAttribute("data-scenario-value");
        var raw = field.value.trim();
        var parsed = raw === "" ? null : Number(raw.replace(",", "."));
        state.scenario[key] = { source: state.scenario[key].source, value: raw === "" || !Number.isFinite(parsed) ? null : parsed, manual: true };
        state.advancedOpen = true;
        renderDrawer();
      });
    });
    var reset = el("cm-scenario-reset");
    if (reset) reset.addEventListener("click", function () { initScenario(item); state.advancedOpen = true; renderDrawer(); });
  }

  /**
   * `precoVisto` = o preço que a tela está MOSTRANDO ao operador. Vem da tabela
   * (snapshot) ou, depois de uma escrita, do preço confirmado pelo ML; o
   * compare-and-set entre preview e aplicar continua valendo no servidor.
   */
  function shownPrice(item) {
    var p = state.pricing;
    return p && p.precoAoVivo !== null && p.precoAoVivo !== undefined ? p.precoAoVivo : currentPriceOf(item);
  }

  function pricingParams(extra) {
    var item = findSelectedItem();
    return Object.assign({
      clientSlug: state.client && state.client.slug,
      clienteContaId: state.contaId,
      itemId: item && item.itemId,
      precoVisto: shownPrice(item),
    }, extra || {});
  }

  // --- Preview da alteração (confirmação humana) ------------------------------

  function newIdempotencyKey() {
    if (root.crypto && typeof root.crypto.randomUUID === "function") return "cm-" + root.crypto.randomUUID();
    return "cm-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  }

  var confirmRequestSeq = 0;

  function reviewPricing(kind, promo, novoPreco) {
    var p = state.pricing;
    if (!p || !pricingAvailability().ok) return;
    // PRICE: o preço digitado (já validado pela Bancada). PROMOTION: null — o servidor lê a oferta ao vivo.
    if (novoPreco === undefined) novoPreco = null;
    if (state.confirm && state.confirm.status === "applying") return;
    abortConfirmRequest();
    state.confirm = { kind: kind, promo: promo, novoPreco: novoPreco, status: "loading", preview: null, error: null, idempotencyKey: newIdempotencyKey(), result: null };
    openConfirm();
    requestPreview(state.confirm);
  }

  function abortConfirmRequest() {
    if (state.confirm && state.confirm.abort) {
      state.confirm.abort.abort();
      state.confirm.abort = null;
    }
  }

  /**
   * Pede o preview de UMA confirmação. A resposta só é aceita se ainda for
   * EXATAMENTE esta confirmação (mesmo objeto + mesmo requestId + mesmo
   * drawer): preview A que responde depois de fechado/substituído por B
   * nunca preenche B.
   */
  function requestPreview(c, aviso) {
    var seq = state.drawerSeq;
    var key = drawerKey();
    confirmRequestSeq += 1;
    var requestId = confirmRequestSeq;
    c.requestId = requestId;
    c.status = "loading";
    c.preview = null;
    c.idempotencyKey = newIdempotencyKey(); // preview novo = intenção nova = chave nova
    c.staleNotice = aviso || null;
    c.abort = typeof root.AbortController === "function" ? new root.AbortController() : null;
    var params = pricingParams({ tipo: c.kind, promotionId: c.promo ? c.promo.id : undefined, novoPreco: c.novoPreco });
    api.previewPricing(params, c.abort ? c.abort.signal : undefined).then(function (result) {
      if (state.confirm !== c || c.requestId !== requestId || seq !== state.drawerSeq || key !== drawerKey()) return;
      c.abort = null;
      if (result && result.aborted) return;
      c.status = result.ok ? "ready" : "error";
      c.preview = result.ok ? result : null;
      c.error = result.ok ? null : result.error;
      renderConfirm();
    });
  }

  function openConfirm() {
    refs.confirmOverlay.classList.add("is-open");
    renderConfirm();
    root.setTimeout(function () { var c = el("cm-confirm-cancel"); if (c) c.focus(); }, 0);
  }

  function closeConfirm() {
    if (state.confirm && state.confirm.status === "applying") return; // nunca fechar no meio da escrita
    abortConfirmRequest();
    state.confirm = null;
    if (refs.confirmOverlay) refs.confirmOverlay.classList.remove("is-open");
  }

  function confirmRow(label, value) {
    return "<tr><th>" + escapeHtml(label) + "</th><td>" + value + "</td></tr>";
  }

  function renderConfirm() {
    var c = state.confirm;
    if (!c) return;
    var item = findSelectedItem();
    if (c.status === "loading") {
      refs.confirmBody.innerHTML = '<div class="vf-loading-state" role="status"><span class="vf-spinner" aria-hidden="true"></span><span>Relendo o anúncio ao vivo e avaliando os gates…</span></div>';
      refs.confirmApply.disabled = true;
      return;
    }
    if (c.status === "error" && !c.preview) {
      refs.confirmBody.innerHTML = '<div class="vf-banner is-danger" role="alert"><div class="vf-banner__content"><p class="vf-banner__title">Não foi possível gerar o preview</p><p class="vf-banner__description">' + escapeHtml(c.error || "Erro desconhecido.") + "</p></div></div>";
      refs.confirmApply.disabled = true;
      return;
    }
    var pv = c.preview;
    var a = pv.atual || {};
    var p = pv.proposta || {};
    var promo = pv.promocao;
    var arrow = function (b, x, fmt) {
      return escapeHtml((b === null || b === undefined ? "—" : fmt(b)) + " → ") + "<strong>" + escapeHtml(x === null || x === undefined ? "—" : fmt(x)) + "</strong>";
    };
    var titulo = c.kind === "PROMOTION"
      ? (promo && promo.escrita && promo.escrita.acao === "ALTERAR" ? "Alterar oferta: " : "Participar de: ") + (promo ? (promo.nome || promo.tipoLabel || promo.tipo) : "promoção")
      : "Alterar preço";
    var rows = confirmRow("Preço", arrow(a.preco, p.preco, formatMoney)) +
      (c.kind === "PROMOTION" && promo
        ? confirmRow("Desconto total", escapeHtml(formatMoney(promo.descontoReais) || "—")) +
          confirmRow("ML banca", escapeHtml(formatMoney(promo.mlBanca) || "R$ 0,00")) +
          confirmRow("Seller banca", escapeHtml(formatMoney(promo.sellerBanca) || "—") + bancaAvisoHtml({ banca_aviso: promo.bancaAviso, banca_motivo: promo.bancaMotivo }))
        : "") +
      confirmRow("Margem", arrow(a.margem, p.margem, formatPercent)) +
      confirmRow("LC / un.", arrow(a.lucro, p.lucro, formatMoney)) +
      confirmRow("Vendas " + periodShortLabel(), escapeHtml(pv.vendas && pv.vendas.unidades !== null && pv.vendas.unidades !== undefined ? formatInt(pv.vendas.unidades) + " un." : "—"));
    var escrita = pv.escrita || {};
    var status = "";
    var aviso = c.staleNotice
      ? '<div class="vf-banner is-warning" role="status" data-cm-preview-novo="1"><div class="vf-banner__content"><p class="vf-banner__title">O cenário mudou desde o preview anterior</p><p class="vf-banner__description">' + escapeHtml(c.staleNotice) + " Revise os números abaixo — nada foi enviado ao Mercado Livre.</p></div></div>"
      : "";
    var apl = c.result && c.result.aplicacao;
    if (c.status === "applying") status = '<div class="vf-loading-state" role="status"><span class="vf-spinner" aria-hidden="true"></span><span>Aplicando no Mercado Livre… não feche esta janela.</span></div>';
    else if (c.status === "done" && !(apl && apl.status === "divergente")) status = '<div class="vf-banner is-success" role="status" data-cm-apply-result="aplicado"><div class="vf-banner__content"><p class="vf-banner__title">Aplicado no Mercado Livre</p><p class="vf-banner__description">Preço confirmado pelo Mercado Livre: <strong>' + escapeHtml(formatMoney(c.result.aplicacao.precoConfirmado) || "—") + "</strong>. A margem está sendo recalculada.</p></div></div>";
    else if (c.status === "failed" && apl && apl.status === "resultado_desconhecido") status = resultadoDesconhecidoHtml(c, apl);
    else if (c.status === "failed") status = '<div class="vf-banner is-danger" role="alert" data-cm-apply-result="' + escapeHtml(c.result && c.result.aplicacao ? c.result.aplicacao.status : "erro") + '"><div class="vf-banner__content"><p class="vf-banner__title">' + escapeHtml(c.result && c.result.aplicacao && c.result.aplicacao.status === "recusado" ? "Alteração recusada — nada foi alterado" : "A alteração não foi confirmada") + '</p><p class="vf-banner__description">' + escapeHtml(c.error || "") + (c.retryable ? " Você pode tentar de novo com segurança (mesma chave, sem escrita dupla)." : " Gere um novo preview para tentar de novo.") + "</p></div></div>";
    refs.confirmBody.innerHTML =
      '<div class="cm-confirm__who"><strong>' + escapeHtml(pv.item && pv.item.titulo || (item && item.title) || "Produto") + "</strong>" +
      '<span class="vf-mono">' + escapeHtml(pv.item ? pv.item.itemId : "") + "</span>" +
      "<span>" + escapeHtml("Conta " + (pv.conta && pv.conta.nome || "—") + " · Mercado Livre " + (pv.conta && pv.conta.mlUserId || "")) + "</span></div>" +
      '<p class="cm-confirm__what">' + escapeHtml(titulo) + "</p>" +
      '<table class="cm-confirm__table">' + rows + "</table>" +
      aviso +
      '<p class="cm-block-label">Gates</p>' + gatesListHtml((c.result && c.result.gates) || pv.gates, false) +
      (escrita.habilitada ? "" : '<p class="cm-rollout-note" data-cm-rollout="off">' + escapeHtml(escrita.motivo || "Escrita desligada.") + "</p>") +
      status + (c.status === "done" && apl && apl.status === "divergente" ? divergenteHtml(apl) : "");
    var podeAplicar = c.status === "ready" && !pv.bloqueado && escrita.habilitada && pv.preview && pv.preview.id && pv.preview.fingerprint;
    var podeRetentar = c.status === "failed" && c.retryable;
    refs.confirmApply.disabled = !(podeAplicar || podeRetentar);
    var promocao = c.kind === "PROMOTION";
    // Escrita desligada (preço ou promoção): o preview abre completo, mas o botão final diz por que não confirma (nunca simula sucesso).
    var desligada = !escrita.habilitada && c.status !== "done";
    refs.confirmApply.textContent = podeRetentar ? "Tentar de novo"
      : c.status === "done" ? (promocao ? "Participação confirmada" : "Aplicado")
        : desligada ? "Escrita desligada — piloto não liberado"
          : promocao ? "Confirmar participação no Mercado Livre" : "Confirmar alteração no Mercado Livre";
  }

  // Timeout/falha depois do envio: o Mercado Livre pode ter aplicado. Nada é repetido sozinho e o botão final
  // não volta: o operador relê a aplicação (reconciliação no servidor) e confere o anúncio antes de qualquer nova tentativa.
  function resultadoDesconhecidoHtml(c, apl) {
    var rel = c.releitura;
    var estado = rel && rel.erro
      ? '<span class="cm-field-error" role="alert">' + escapeHtml(rel.erro) + "</span>"
      : rel && rel.aplicacao
        ? "Estado relido: <strong>" + escapeHtml(rel.aplicacao.status || "—") + "</strong>" + (rel.aplicacao.execucao ? " (" + escapeHtml(rel.aplicacao.execucao) + ")" : "") + (rel.em ? " às " + escapeHtml(formatShortDateTime(rel.em)) : "") + "."
        : "";
    return '<div class="vf-banner is-danger" role="alert" data-cm-apply-result="resultado_desconhecido"><div class="vf-banner__content">' +
      '<p class="vf-banner__title">Resultado desconhecido — confira o anúncio antes de qualquer nova tentativa</p>' +
      '<p class="vf-banner__description">O Mercado Livre não confirmou a ' + (c.kind === "PROMOTION" ? "participação" : "alteração") + ' a tempo: ela <strong>pode ter sido aplicada</strong>. A Central não repete sozinha. ' +
      escapeHtml(c.error || "") + " " + estado + "</p>" +
      '<p><button class="vf-btn vf-btn--secondary vf-btn--sm" type="button" id="cm-confirm-reler" data-cm-reler' + (c.relendo ? " disabled" : "") + ">" + (c.relendo ? "Relendo…" : "Reler aplicação e anúncio") + "</button></p></div></div>";
  }

  function relerAplicacao() {
    var c = state.confirm;
    var apl = c && c.result && c.result.aplicacao;
    if (!c || !apl || c.relendo || typeof api.getPricingApplication !== "function") return;
    c.relendo = true;
    renderConfirm();
    var seq = state.drawerSeq;
    api.getPricingApplication({ clientSlug: state.client.slug, clienteContaId: state.contaId, id: apl.id }).then(function (result) {
      if (state.confirm !== c) return;
      c.relendo = false;
      if (result.ok && result.aplicacao) {
        c.releitura = { aplicacao: result.aplicacao, em: new Date().toISOString() };
        c.result.aplicacao = result.aplicacao;
        // Se a releitura mostra que de fato aplicou (reconciliado), o estado segue o servidor.
        if (result.aplicacao.status === "aplicado" || result.aplicacao.status === "divergente") {
          c.status = "done";
          if (seq === state.drawerSeq && state.pricing) { state.pricing.aplicacao = result.aplicacao; if (result.aplicacao.snapshotStatus !== "nao_aplicavel") trackPostWrite(result.aplicacao.id, seq); }
        }
      } else {
        c.releitura = { erro: result.error || "Não foi possível reler agora." };
      }
      // O anúncio também é relido (a coluna Hoje volta do Mercado Livre/snapshot, nunca do que foi enviado).
      if (seq === state.drawerSeq) recarregarBancada();
      renderConfirm();
    });
  }

  var ATENCAO_TEXTO = {
    PRECO_CONFIRMADO_DIVERGENTE: "margem recalculada sobre o preço confirmado.",
    PRECO_CONFIRMADO_ABAIXO_BREAK_EVEN: "ATENÇÃO: no preço confirmado o LC fica negativo (abaixo do break-even). Revise o anúncio.",
    PRECO_CONFIRMADO_SEM_RECOTACAO: "não foi possível recotar comissão/frete no preço confirmado; margem indisponível até a próxima leitura.",
  };

  function divergenteHtml(apl) {
    var abaixo = apl.atencaoCodigo === "PRECO_CONFIRMADO_ABAIXO_BREAK_EVEN";
    return '<div class="vf-banner ' + (abaixo ? "is-danger" : "is-warning") + '" role="alert" data-cm-apply-result="divergente"><div class="vf-banner__content"><p class="vf-banner__title">O Mercado Livre confirmou um preço diferente do solicitado</p><p class="vf-banner__description">Solicitado ' +
      escapeHtml(formatMoney(apl.precoSolicitado) || "—") + " · confirmado <strong>" + escapeHtml(formatMoney(apl.precoConfirmado) || "—") + "</strong>. " +
      (apl.margemDepois !== null && apl.margemDepois !== undefined ? "Margem no confirmado: <strong>" + escapeHtml(formatPercent(apl.margemDepois)) + "</strong> · LC " + escapeHtml(formatMoney(apl.lucroDepois) || "—") + ". " : "") +
      escapeHtml(ATENCAO_TEXTO[apl.atencaoCodigo] || "") + "</p></div></div>";
  }

  // Recusas que exigem um NOVO preview (o operador precisa ver os números de novo).
  var CODIGOS_NOVO_PREVIEW = ["PREVIEW_DESATUALIZADO", "PREVIEW_SUPERADO", "PRECO_ALTERADO", "PROMOCAO_MUDOU", "PROMOCAO_INTENCAO_MUDOU"];

  function descreverDiferencas(lista) {
    if (!lista || !lista.length) return "";
    var nomes = { custo: "custo", imposto: "imposto", taxaFixa: "taxa fixa", comissao: "comissão", frete: "frete", precoAtual: "preço atual", rebate: "subsídio ML" };
    return "Mudou: " + lista.slice(0, 5).map(function (d) { return nomes[d.campo] || d.campo; }).join(", ") + ".";
  }

  /** Aplicar: 1 clique = 1 chave; clique repetido/retry reusa a MESMA chave. */
  function confirmApply() {
    var c = state.confirm;
    if (!c || !c.preview || c.status === "applying" || c.status === "done") return;
    if (c.status !== "ready" && !(c.status === "failed" && c.retryable)) return;
    if (c.preview.bloqueado || !(c.preview.escrita && c.preview.escrita.habilitada)) return;
    c.status = "applying";
    renderConfirm();
    var seq = state.drawerSeq;
    var item = findSelectedItem();
    var promoId = c.kind === "PROMOTION" && c.promo ? c.promo.id : undefined;
    api.applyPricing({
      clientSlug: state.client.slug,
      clienteContaId: state.contaId,
      previewId: c.preview.preview.id,
      fingerprint: c.preview.preview.fingerprint,
      idempotencyKey: c.idempotencyKey,
      promotionId: promoId,
    }).then(function (result) {
      if (state.confirm !== c) return;
      // 200 ok:false (recusa) chega "achatado"; 4xx traz o payload em .data.
      var data = result.aplicacao || result.codigo ? result : (result.data || result || {});
      var aplicacao = data.aplicacao || null;
      var codigo = data.codigo || result.code || null;
      if (!result.ok && (data.novoPreviewNecessario || CODIGOS_NOVO_PREVIEW.indexOf(codigo) !== -1)) {
        // Nunca aplicar outra coisa em silêncio: novo preview, nova confirmação.
        toast("O cenário mudou desde o preview. Revise o novo preview antes de confirmar.", "is-warning");
        if (seq === state.drawerSeq) state.history = null;
        requestPreview(c, (data.motivo || result.error || "") + " " + descreverDiferencas(data.diferencas));
        renderConfirm();
        return;
      }
      if (result.ok && aplicacao && (aplicacao.status === "aplicado" || aplicacao.status === "divergente")) {
        c.status = "done";
        c.result = data;
        if (aplicacao.status === "divergente") toast("O Mercado Livre confirmou " + (formatMoney(aplicacao.precoConfirmado) || "") + " (diferente do solicitado). Confira a margem.", "is-warning");
        else toast("Aplicado no Mercado Livre: " + (formatMoney(aplicacao.precoConfirmado) || "") + " (valor confirmado pelo ML).", "is-success");
        if (seq === state.drawerSeq && state.pricing) {
          state.pricing.aplicacao = aplicacao;
          // O cenário era do preço anterior: depois da escrita a bancada recomeça do preço novo.
          state.pricing.novoPreco = "";
          state.bancada.manual = novaBancada().manual;
          limparHipotese();
          state.bancada.selecionado = "preco";
          if (c.kind === "PRICE" && aplicacao.precoConfirmado !== null && aplicacao.precoConfirmado !== undefined) {
            state.pricing.precoTabela = null;
            state.pricing.precoAoVivo = aplicacao.precoConfirmado;
          }
          state.history = null;
          if (aplicacao.snapshotStatus !== "nao_aplicavel") trackPostWrite(aplicacao.id, seq);
          renderDrawer();
        }
      } else {
        c.status = "failed";
        c.result = data;
        c.error = data.motivo || result.error || "A alteração não foi aplicada.";
        if (aplicacao && aplicacao.status === "resultado_desconhecido") {
          c.error = "Resultado desconhecido: a alteração pode ter sido aplicada no Mercado Livre sem confirmação. Confira o anúncio antes de tentar de novo. " + (data.motivo || "");
        }
        // Só erro de rede (sem resposta) é retentável com a mesma chave.
        c.retryable = result.type === "network";
        toast(c.error, "is-danger");
        if (seq === state.drawerSeq) state.history = null;
      }
      if (state.confirm === c) renderConfirm();
      if (item && seq === state.drawerSeq && state.drawerTab === "history") loadHistory(true);
    });
  }

  /** Pós-escrita: acompanha o refresh do snapshot do ITEM e relê a página quando chegar. */
  function trackPostWrite(aplicacaoId, seq) {
    var tentativas = 0;
    var slug = state.client.slug;
    var conta = state.contaId;
    function tick() {
      if (!state.pricing || seq !== state.drawerSeq) return;
      tentativas += 1;
      api.getPricingApplication({ clientSlug: slug, clienteContaId: conta, id: aplicacaoId }).then(function (result) {
        if (!state.pricing || seq !== state.drawerSeq) return;
        if (result.ok && result.aplicacao) {
          state.pricing.aplicacao = result.aplicacao;
          if (["atualizado", "falhou", "nao_aplicavel", "propagacao_pendente"].indexOf(result.aplicacao.snapshotStatus) !== -1) {
            renderDrawerHeader(findSelectedItem());
            if (result.aplicacao.snapshotStatus === "atualizado") recarregarBancada();
            if (result.aplicacao.snapshotStatus === "atualizado" && isSnapshotMode()) {
              toast("Margem recalculada com o preço confirmado.", "is-success");
              loadSnapshotPage();
            }
            return;
          }
        }
        renderDrawerHeader(findSelectedItem());
        if (tentativas < 40) state.pricing.pollTimer = root.setTimeout(tick, POST_WRITE_POLL_MS);
      });
    }
    if (typeof api.getPricingApplication === "function") state.pricing.pollTimer = root.setTimeout(tick, POST_WRITE_POLL_MS);
  }

  // --- Histórico ---------------------------------------------------------------

  function loadHistory(force) {
    var item = findSelectedItem();
    if (!item || typeof api.getPricingHistory !== "function" || !state.client || !state.contaId) return;
    if (state.history && state.history.status !== "error" && !force) return;
    var seq = state.drawerSeq;
    var key = drawerKey();
    state.history = { status: "loading" };
    api.getPricingHistory({ clientSlug: state.client.slug, clienteContaId: state.contaId, itemId: item.itemId }).then(function (result) {
      if (seq !== state.drawerSeq || key !== drawerKey()) return;
      state.history = result.ok ? { status: "ok", list: result.historico || [] } : { status: "error", error: result.error };
      if (state.drawerTab === "history") renderDrawer();
    });
  }

  var HISTORY_STATUS = {
    aplicado: { label: "Aplicado no Mercado Livre", tone: "is-success" },
    recusado: { label: "Recusado — nada foi alterado", tone: "is-warning" },
    falhou: { label: "Não confirmado", tone: "is-danger" },
    aplicando: { label: "Aplicando…", tone: "is-info" },
  };

  function historyEntryHtml(entry) {
    var meta = HISTORY_STATUS[entry.status] || { label: entry.status, tone: "is-neutral" };
    var quando = entry.aplicadoEm || entry.criadoEm;
    var d = quando ? new Date(quando) : null;
    var data = d && !Number.isNaN(d.getTime())
      ? d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " · " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
      : "—";
    var quem = entry.usuario && (entry.usuario.nome || entry.usuario.email) || "usuário não identificado";
    var depois = entry.precoConfirmado !== null && entry.precoConfirmado !== undefined ? entry.precoConfirmado : entry.precoSolicitado;
    var oque = entry.tipoAcao === "PROMOTION"
      ? (entry.promotionAcao === "ALTERAR" ? "Alterou oferta: " : "Participou de: ") + (entry.promotionNome || entry.promotionType || entry.promotionId || "promoção")
      : "Preço";
    return '<li class="cm-hist" data-cm-hist="' + escapeHtml(entry.status) + '">' +
      '<div class="cm-hist__head"><span>' + escapeHtml(data + " · " + quem) + '</span><span class="vf-status ' + meta.tone + '">' + escapeHtml(meta.label) + "</span></div>" +
      '<p class="cm-hist__what">' + escapeHtml(oque) + "</p>" +
      '<div class="cm-hist__nums">' +
      deltaRow("Preço", entry.precoAnterior !== null && entry.precoAnterior !== undefined ? entry.precoAnterior : entry.precoVisto, depois, function (v) { return formatMoney(v); }, true) +
      deltaRow("Margem", entry.margemAntes, entry.margemDepois, function (v) { return formatPercent(v); }) +
      "</div>" +
      (entry.status !== "aplicado" && (entry.erroMensagem || entry.erroCodigo)
        ? '<p class="cm-hist__err">' + escapeHtml((entry.erroMensagem || "") + (entry.erroCodigo ? " (" + entry.erroCodigo + ")" : "")) + "</p>"
        : "") +
      "</li>";
  }

  function renderHistoryTab(item) {
    var h = state.history;
    var body;
    if (item.stub || !state.contaId || typeof api.getPricingHistory !== "function") {
      body = '<p class="cm-empty-note">Histórico disponível quando uma conta está selecionada.</p>';
    } else if (!h || h.status === "loading") {
      body = stateHtml("loading", "Carregando histórico…");
    } else if (h.status === "error") {
      body = '<p class="cm-field-error" role="alert">' + escapeHtml(h.error || "Não foi possível carregar o histórico.") + "</p>";
    } else if (!h.list.length) {
      body = '<div class="cm-hist-empty" data-cm-hist-empty><p class="vf-empty__title">Nenhuma alteração feita pela Central</p><p class="vf-empty__description">Quando um preço ou promoção for aplicado por aqui, fica registrado quem, quando, o preço visto, o pedido e o confirmado pelo Mercado Livre.</p></div>';
    } else {
      body = '<ol class="cm-hist-list">' + h.list.map(historyEntryHtml).join("") + "</ol>";
    }
    refs.drawerBody.innerHTML = panel("Histórico de precificação", "auditoria persistida", body) + readTrailHtml(item);
  }

  /** Rastro desta LEITURA (não é histórico): observações que vieram na resposta. */
  function readTrailHtml(item) {
    if (item.stub) return "";
    var audit = item.audit || {};
    var trail = [];
    contract.VARIABLES.forEach(function (variableKey) {
      var bucket = item.sources[variableKey];
      bucket.order.forEach(function (source) {
        var entry = bucket.entries[source];
        if (!entry.available) return;
        trail.push({
          time: entry.observedAt,
          title: contract.sourceLabel(source) + " · " + contract.VARIABLE_META[variableKey].label,
          copy: (entry.kind === "REALIZED" ? "Observação realizada" : "Observação projetada") + " de " + (formatByVariable(variableKey, entry.value) || "—") + (entry.note ? " — " + entry.note : "."),
        });
      });
    });
    trail.sort(function (a, b) { return String(a.time || "") < String(b.time || "") ? -1 : 1; });
    var reasons = (audit.statusReasons || []).concat(audit.qualityReasons || []);
    return '<details class="cm-trail"><summary>Rastro desta leitura <small>metadado da resposta atual, não um log de eventos gravado</small></summary>' +
      (trail.length
        ? '<ol class="cm-audit">' + trail.map(function (entry) {
            return '<li class="cm-audit-row"><span class="cm-audit-time">' + escapeHtml(formatDateTime(entry.time) || "sem horário") + "</span>" +
              '<span class="cm-audit-dot" aria-hidden="true"></span><span class="cm-audit-copy"><strong>' + escapeHtml(entry.title) + "</strong><span>" + escapeHtml(entry.copy) + "</span></span></li>";
          }).join("") + "</ol>"
        : '<p class="cm-empty-note">Nenhuma observação com valor chegou para este produto.</p>') +
      '<p class="cm-empty-note">Status canônico: <strong>' + escapeHtml(item.status) + "</strong>" + (reasons.length ? " · " + escapeHtml(reasons.join(" · ")) : "") + "</p>" +
      '<div class="cm-technical-grid">' +
      techCard("identity.itemId", audit.itemId || item.itemId) +
      techCard("marketplace", (audit.marketplace || item.marketplace || "").toUpperCase()) +
      techCard("sourceMode", state.data && state.data.sourceMode) +
      techCard("última atualização", state.data && formatDateTime(state.data.lastUpdated)) +
      techCard("última venda", formatDateTime(audit.lastSoldAt)) +
      techCard("pedido mais recente", item.latestOrderId) +
      techCard("snapshot calculado em", item.snapshot ? formatDateTime(item.snapshot.calculatedAt) : null) +
      "</div></details>";
  }

  // --- Evidências (enxuta) ----------------------------------------------------

  var EVIDENCE_ORDER = ["price", "cost", "tax", "commission", "freight", "fixedFee"];

  // Variáveis que são CUSTO: a alternativa maior derruba o lucro (vermelho); no preço é o contrário.
  var EVIDENCE_CUSTO = { cost: true, tax: true, commission: true, freight: true, fixedFee: true };

  /** Melhor fonte alternativa disponível (a primeira na ordem do Motor que não é a selecionada). */
  function evidenceAlternative(bucket, chosenSource) {
    var alternative = null;
    bucket.order.forEach(function (source) {
      if (alternative || source === chosenSource) return;
      var entry = bucket.entries[source];
      if (entry && entry.available) alternative = entry;
    });
    return alternative;
  }

  /** Uma linha por variável: fonte × alternativa × diferença (cor pelo impacto no lucro) × confiança × horário. Sem "—": o que falta vira texto curto. */
  function evidenceSummaryRow(item, variableKey) {
    var bucket = item.sources[variableKey];
    var chosenSource = state.selection[variableKey];
    var chosen = bucket.entries[chosenSource];
    var alternative = evidenceAlternative(bucket, chosenSource);
    var diff = chosen && chosen.available && alternative ? alternative.value - chosen.value : null;
    var percent = contract.VARIABLE_META[variableKey].format === "percent";
    var flagged = contract.hasSourceDisagreement(item, variableKey, chosenSource);
    var level = variableConfidence(item, variableKey).level;
    var meta = CONFIDENCE_META[level] || CONFIDENCE_META.UNKNOWN;
    var difTexto = diff === null ? "" : percent ? formatPp1(diff) : formatNumero(diff, true);
    var tom = diff === null ? "" : tomGanho(EVIDENCE_CUSTO[variableKey] ? -diff : diff);
    var alternativaCelulas = alternative
      ? "<td>" + escapeHtml(alternative.sourceShort) + '</td><td class="num">' + escapeHtml(formatByVariable(variableKey, alternative.value)) + '</td><td class="num' + tom + '">' + escapeHtml(difTexto) + "</td>"
      : '<td class="cm-ev-sem" colspan="3">sem fonte alternativa</td>';
    return '<tr class="' + (variableKey === state.evidenceVariable ? "is-active" : "") + (flagged ? " is-flagged" : "") + '" data-evidence-var="' + variableKey + '" tabindex="0" aria-selected="' + (variableKey === state.evidenceVariable ? "true" : "false") + '">' +
      '<th scope="row">' + escapeHtml(contract.VARIABLE_META[variableKey].label) + "</th>" +
      "<td>" + escapeHtml(contract.SOURCE_SHORT_LABELS[chosenSource] || chosenSource) + '</td><td class="num">' +
      (chosen && chosen.available ? escapeHtml(formatByVariable(variableKey, chosen.value)) : '<span class="cm-ev-sem">sem valor</span>') + "</td>" +
      alternativaCelulas +
      '<td><span class="vf-status ' + meta.className + ' cm-res">' + escapeHtml(meta.label) + "</span></td>" +
      '<td class="num cm-ev-time">' + escapeHtml(formatShortDateTime(chosen && chosen.observedAt) === "—" ? "" : formatShortDateTime(chosen && chosen.observedAt)) + "</td></tr>";
  }

  /** Uma fonte em uma linha: "R$ 8,15 · projetado · 16/10 14:16" — ou "sem observação". */
  function evidenceFonteTexto(variableKey, entry, papel) {
    if (!entry || !entry.available) return "sem observação";
    var quando = formatShortDateTime(entry.observedAt);
    return [formatByVariable(variableKey, entry.value), entry.kind === "REALIZED" ? "realizado" : entry.kind === "PROJECTED" ? "projetado" : null, quando && quando !== "—" ? quando : null, papel]
      .filter(Boolean).join(" · ");
  }

  function renderEvidenceTab(item) {
    if (item.stub) {
      refs.drawerBody.innerHTML = '<p class="cm-empty-note">Evidências completas ficam disponíveis quando o produto é aberto pela tabela (esta linha veio de Oportunidades, fora da página atual).</p>';
      return;
    }
    var variableKey = contract.VARIABLE_META[state.evidenceVariable] ? state.evidenceVariable : "price";
    var bucket = item.sources[variableKey];
    var chosenSource = state.selection[variableKey];
    var chosen = bucket.entries[chosenSource];
    var motor = (item.motorChoice && item.motorChoice[variableKey]) || { available: false, source: null, value: null, sourceLabel: null };
    var disagreement = contract.hasSourceDisagreement(item, variableKey, chosenSource);

    var summary = '<table class="cm-ev-table" role="grid"><thead><tr>' +
      '<th>Variável</th><th>Fonte</th><th class="num">Valor</th><th>Alternativa</th><th class="num">Valor</th><th class="num">Diferença</th><th>Confiança</th><th class="num">Observado</th>' +
      "</tr></thead><tbody>" + EVIDENCE_ORDER.map(function (key) { return evidenceSummaryRow(item, key); }).join("") + "</tbody></table>";

    var why = (EVIDENCE_WHY[variableKey] && EVIDENCE_WHY[variableKey][chosenSource]) || "Fonte selecionada para esta variável.";
    if (!chosen || !chosen.available) why = "Esta fonte não observou a variável nesta leitura: o valor fica indisponível — não é zero.";

    // Detalhe da linha clicada: pares rótulo/valor em 2 colunas, uma linha por fonte (ausente = "sem observação"),
    // sem repetir o que a tabela já mostra em destaque.
    var pares = bucket.order.map(function (source) {
      var entry = bucket.entries[source];
      return [entry.sourceLabel || contract.sourceLabel(source), evidenceFonteTexto(variableKey, entry, source === chosenSource ? "selecionada" : null), !entry || !entry.available];
    });
    pares.push(["Escolha do Motor", motor.available && motor.source !== chosenSource ? formatByVariable(variableKey, motor.value) + " · " + motor.sourceLabel : motor.available ? "mesma fonte" : "sem valor selecionado"]);
    pares.push(["Conflito", disagreement ? "sim — outra fonte diverge além da tolerância do Motor" : "não"]);
    pares.push(["Por que esta fonte", why]);
    var detail = '<div class="cm-ev-detail" data-cm-ev-detalhe="' + escapeHtml(variableKey) + '"><p class="cm-ev-detail__titulo"><strong>' + escapeHtml(contract.VARIABLE_META[variableKey].label) + "</strong> <span>fontes desta variável</span></p>" +
      '<dl class="cm-ev-pares">' + pares.map(function (par) {
        return '<div class="cm-ev-par"><dt>' + escapeHtml(par[0]) + "</dt><dd" + (par[2] ? ' class="cm-ev-sem"' : "") + ">" + escapeHtml(par[1]) + "</dd></div>";
      }).join("") + "</dl></div>";

    var receipt = '<div class="cm-receipt-line"><span>Recebimento líquido: ' + unavailable("Não integrado", "Mercado Pago não integrado ao backend.") + "</span>" +
      "<span>Conciliação: " + escapeHtml(item.reconciliation || "Pendente") + "</span>" +
      '<button class="vf-btn vf-btn--ghost vf-btn--sm" type="button" disabled title="Integração de recebimentos indisponível no backend.">Mercado Pago</button></div>';

    refs.drawerBody.innerHTML = panel("Evidências por variável", "clique numa linha para ver as fontes", summary + detail, "cm-panel--ev") +
      comparisonPanelHtml(item) + receipt;

    Array.prototype.forEach.call(refs.drawerBody.querySelectorAll("[data-evidence-var]"), function (row) {
      function choose() { state.evidenceVariable = row.getAttribute("data-evidence-var"); renderDrawer(); }
      row.addEventListener("click", choose);
      row.addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); } });
    });
  }

  var COMPARISON_ROWS = [
    { key: "price", label: "Preço (médio vendido no realizado)", format: "money" },
    { key: "commission", label: "Comissão / un.", format: "money", custo: true },
    { key: "freight", label: "Frete / un.", format: "money", custo: true },
    { key: "cost", label: "Custo / un.", format: "money", custo: true },
    { key: "taxRate", label: "Imposto", format: "percent", custo: true },
    { key: "fixedFee", label: "Taxa fixa / un.", format: "money", custo: true },
  ];

  function cmpValue(format, value) {
    if (value === null || value === undefined) return null;
    return format === "percent" ? formatPercent(value) : formatMoney(value);
  }

  // Impacto no lucro: linha de CUSTO (comissão/frete/custo/imposto/taxa) é
  // projetado − realizado (custo que caiu ajuda o lucro); preço/lucro/margem
  // seguem realizado − projetado. Verde se > 0, vermelho se < 0.
  function cmpImpactoClasse(v) {
    if (v === null || v === undefined) return "";
    return v > 0 ? " is-up" : v < 0 ? " is-down" : "";
  }

  // Valor numérico do impacto (pro sinal/cor) — null quando o desvio não existe.
  function cmpImpactoValor(format, row, drift) {
    if (!drift) return null;
    var v = format === "percent" ? drift.taxRatePp : drift[row.key];
    if (v === null || v === undefined) return null;
    // Custo que caiu ajuda o lucro; zero nunca vira "−R$ 0,00".
    var impacto = row.custo ? -v : v;
    return impacto === 0 ? 0 : impacto;
  }

  /** Painel Projetado × Realizado — exibe o bloco do Motor, sem recalcular. */
  function comparisonPanelHtml(item) {
    var cmp = item.comparison;
    var periodo = (state.data && state.data.period && state.data.period.label) || (state.realizado && state.realizado.period && state.realizado.period.label) || "período do realizado";
    if (!cmp && item.realizedUnavailable) {
      return panel("Projetado × Realizado", periodo,
        '<p class="cm-empty-note" data-cm-cmp-panel="UNAVAILABLE">O realizado deste período está indisponível (a leitura da Central de Vendas falhou). Isso não significa que o anúncio não vendeu — nenhum valor foi zerado.</p>');
    }
    if (!cmp) {
      return panel("Projetado × Realizado", periodo, '<p class="cm-empty-note">O backend não enviou a comparação para este item.</p>');
    }
    if (cmp.status === "NO_SALES") {
      return panel("Projetado × Realizado", periodo,
        '<p class="cm-empty-note" data-cm-cmp-panel="NO_SALES">Sem venda deste anúncio no período. O realizado não existe — não é zero. Projetado atual: ' +
        escapeHtml(cmp.projected.margin === null ? "indisponível" : formatPercent(cmp.projected.margin)) + ".</p>");
    }
    var drift = cmp.drift || {};
    // Retorno ML em andamento: a comissão realizada (Orders API) já vem
    // líquida do subsídio — o rótulo avisa, e uma linha própria "Retorno ML"
    // mostra o valor somado ao lucro do header/painel (nunca somado de novo).
    var temRebate = cmp.projected.rebate !== null && cmp.projected.rebate !== undefined;
    var linhaRows = COMPARISON_ROWS.map(function (row) {
      var proj = cmpValue(row.format, cmp.projected[row.key]);
      var real = cmpValue(row.format, cmp.realized[row.key]);
      var semHistorico = row.key === "fixedFee" && cmp.notComparable.some(function (n) { return n.field === "fixedFee"; });
      var impactoVal = cmpImpactoValor(row.format, row, drift);
      var impacto = impactoVal === null ? null : (row.format === "percent" ? formatPp(impactoVal) : formatMoney(impactoVal, true));
      var label = row.key === "commission" && temRebate ? row.label + " (líquida do retorno ML)" : row.label;
      // Sem valor: a célula fica vazia (ou diz "sem histórico") — nunca "—".
      var html = "<tr><td>" + escapeHtml(label) + '</td><td class="num">' + (proj === null ? "" : escapeHtml(proj)) +
        '</td><td class="num">' + (real === null ? (semHistorico ? unavailable("sem histórico", "A Central de Vendas não guarda taxa fixa histórica: o realizado não a desconta.") : "") : escapeHtml(real)) +
        '</td><td class="num' + cmpImpactoClasse(impactoVal) + '">' + escapeHtml(impacto || "") + "</td></tr>";
      if (row.key === "commission" && temRebate) {
        html += '<tr data-cm-cmp-rebate-row="1"><td>Retorno ML</td><td class="num">' + escapeHtml(formatMoney(cmp.projected.rebate)) +
          '</td><td class="num">' + unavailable("incluído na comissão", "O retorno ML já está embutido na comissão realizada, líquida do subsídio.") +
          '</td><td class="num"></td></tr>';
      }
      return html;
    });
    if (!temRebate && cmp.projected.rebateMotivo === "REBATE_AMBIGUO") {
      linhaRows.push('<tr data-cm-cmp-rebate-ambiguo="1"><td colspan="4"><span class="cm-cell-meta" title="Duas ou mais promoções com retorno ML ativas neste anúncio: o Motor não adivinha qual, então nada foi somado.">⚠ Retorno ML não somado — duas promoções ativas (ambíguo)</span></td></tr>');
    }
    var linhas = linhaRows.join("");
    var impactoLucro = drift.profit === null || drift.profit === undefined ? null : drift.profit;
    var impactoMargem = drift.marginPercentagePoints === null || drift.marginPercentagePoints === undefined ? null : drift.marginPercentagePoints;
    var margemRow = '<tr class="cm-cmp-total"><td>Lucro / un.</td><td class="num">' + escapeHtml(formatMoney(cmp.projected.profit) || "") +
      '</td><td class="num">' + escapeHtml(formatMoney(cmp.realized.profit) || "") + '</td><td class="num' + cmpImpactoClasse(impactoLucro) + '">' + escapeHtml(formatMoney(impactoLucro, true) || "") + "</td></tr>" +
      '<tr class="cm-cmp-total" data-cm-cmp-margem><td>Margem</td><td class="num">' + escapeHtml(cmp.projected.margin === null ? "" : formatPercent(cmp.projected.margin)) +
      '</td><td class="num">' + escapeHtml(cmp.realized.margin === null ? "" : formatPercent(cmp.realized.margin)) +
      '</td><td class="num' + cmpImpactoClasse(impactoMargem) + '" data-cm-delta-margem><strong>' + escapeHtml(formatPp(impactoMargem) || "") + "</strong></td></tr>";
    var sales = item.sales || {};
    var parcial = partialCoverage(cmp.realized.coverage);
    var fatos = [
      "<li>" + escapeHtml(formatInt(cmp.realized.units) + " unidade(s) · " + formatInt(cmp.realized.orders || 0) + " pedido(s) · receita " + (formatMoney(cmp.realized.revenue) || "—") +
        (cmp.realized.lastSaleAt ? " · última venda " + formatDateBr(cmp.realized.lastSaleAt) : "")) + "</li>",
    ];
    if (cmp.status === "REALIZED_NOT_COMPUTABLE") {
      fatos.push("<li>Margem realizada indisponível: falta " + escapeHtml((cmp.realized.missing || []).map(variableLabel).join(", ")) + " histórico nas vendas do período.</li>");
    }
    if (cmp.realized.assumed && cmp.realized.assumed.length) {
      fatos.push("<li>Assumido 0 no realizado: " + escapeHtml(cmp.realized.assumed.map(variableLabel).join(", ")) + ".</li>");
    }
    if (cmp.realized.rebateEmbutido !== null && cmp.realized.rebateEmbutido !== undefined) {
      fatos.push('<li data-cm-cmp-rebate-embutido="' + escapeHtml(String(cmp.realized.rebateEmbutido)) + '">Retorno ML embutido na comissão realizada ≈ ' +
        escapeHtml(formatMoney(cmp.realized.rebateEmbutido)) + " — já incluído na tarifa que o Mercado Livre cobrou, não somado de novo.</li>");
    }
    if (cmp.projected.rebateMotivo === "REBATE_AMBIGUO") {
      fatos.push('<li data-cm-cmp-rebate-ambiguo-fato="1">Duas ou mais promoções com retorno ML ativas neste anúncio: o Motor não soma nem adivinha qual — a comissão comparada aqui é a bruta de sempre.</li>');
    }
    fatos.push("<li>" + escapeHtml(parcial.length ? "Cobertura parcial — " + parcial.join("; ") + ". Valores por unidade são a média das vendas com o dado." : "Cobertura completa dos componentes nas vendas do período.") + "</li>");
    if (sales.refund && sales.refund.total) {
      fatos.push("<li>Reembolso atribuído ao anúncio: " + escapeHtml(formatMoney(sales.refund.total) + " em " + sales.refund.pedidos + " pedido(s)") + " — conciliação, fora da margem.</li>");
    }
    if (sales.persistedResult !== null && sales.persistedResult !== undefined) {
      fatos.push("<li>Contraprova: resultado persistido pela Central de Vendas " + escapeHtml(formatMoney(sales.persistedResult)) +
        " × recalculado pelo Motor " + escapeHtml(formatMoney(sales.recalculatedResult) || "—") + " (a Central de Vendas não desconta taxa fixa).</li>");
    }
    return panel("Projetado × Realizado", periodo,
      '<div class="vf-table-wrap"><table class="vf-table vf-table--compact cm-cmp-table" data-cm-cmp-panel="' + escapeHtml(cmp.status) + '"><thead><tr><th>Componente</th><th class="num">Projetado</th><th class="num">Realizado</th><th class="num">Impacto no lucro</th></tr></thead><tbody>' +
      linhas + margemRow + "</tbody></table></div>" +
      '<ul class="cm-cmp-facts">' + fatos.join("") + "</ul>");
  }

  var EVIDENCE_WHY = {
    price: {
      MELI_API: "O preço da API representa o anúncio neste momento.",
      MELI_ORDER: "A última venda representa o preço efetivamente praticado no pedido.",
      EXTENSION_DOM: "A extensão é evidência visual e funciona como verificação independente.",
    },
    cost: {
      VENFORCE_BASE: "Custo declarado HOJE na Base vinculada. A Central apenas lê esse valor.",
      VENFORCE_BASE_HIST: "Custo que a Base tinha no momento da venda, gravado pela Central de Vendas. Mudar a Base hoje não altera este valor.",
    },
    tax: {
      VENFORCE_BASE: "Percentual de imposto declarado HOJE na Base vinculada.",
      VENFORCE_BASE_HIST: "Alíquota histórica: imposto gravado na venda ÷ receita das mesmas vendas.",
    },
    commission: {
      MELI_API: "Tarifa prevista da API, usada para projetar a margem do anúncio.",
      MELI_ORDER: "Tarifa realizada do pedido: evidência do que foi efetivamente cobrado.",
    },
    freight: {
      MELI_API: "Frete previsto serve para projeção e comparação com o realizado.",
      MELI_ORDER: "Frete realizado é evidência do que ocorreu no shipment.",
      EXTENSION_DOM: "Leitura visual do frete exibido na página do anúncio.",
    },
    fixedFee: {
      VENFORCE_BASE: "Taxa fixa declarada na Base vinculada.",
      VENFORCE_BASE_HIST: "Não existe taxa fixa histórica: o realizado não a desconta.",
    },
  };

  function techCard(label, value) {
    return '<div class="cm-tech"><span>' + escapeHtml(label) + "</span><strong>" +
      (value === null || value === undefined || value === "" ? "Não informado" : escapeHtml(value)) + "</strong></div>";
  }


  // ---------------------------------------------------------------------------

  function init() {
    cacheRefs();
    state.token = root.localStorage && root.localStorage.getItem("vf-token");
    if (typeof root.initLayout === "function") root.initLayout();
    bindEvents();
    syncPresetButtons();
    if (!state.token && !root.__VF_CENTRAL_MARGEM_API_CLIENT__) {
      state.error = "Sessão não encontrada. Faça login novamente.";
      renderAll();
      return;
    }
    renderAll();
    document.addEventListener("vf:context", function (event) { aplicarContextoDoShell(event.detail); });
  }

  root.VFCentralMargemUi = {
    getState: function () { return state; },
    filteredItems: filteredItems,
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    setDrawerTab: setDrawerTab,
    applyPreset: applyPreset,
    reload: loadCentral,
    atualizadoTexto: atualizadoTexto,
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})(window);
