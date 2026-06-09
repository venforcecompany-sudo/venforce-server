(function () {
  "use strict";

  const STORAGE_KEY = "vf-token";
  const API_BASE = "https://venforce-server.onrender.com";
  const FALLBACK_CLIENTE = {
    id: null,
    nome: "Extra Maquinas",
    slug: "extra-maquinas",
    ativo: true,
    marketplace: "Mercado Livre",
    __mock: true,
  };

  const state = {
    loading: false,
    selectedCliente: null,
    selectedKey: "",
    clientes: [],
    bases: [],
    vinculos: [],
    vinculoClientes: [],
    tokens: [],
    relatorios: [],
    entregas: [],
    ads: null,
    cobertura: null,
    sources: {},
    failures: [],
    loadedAt: null,
  };

  document.addEventListener("DOMContentLoaded", initClienteOperacao);

  function initClienteOperacao() {
    if (typeof window.initLayout === "function") window.initLayout();
    syncControlCenterLink();

    const refresh = document.getElementById("vfop-refresh");
    if (refresh) refresh.addEventListener("click", loadClienteOperacao);

    const select = document.getElementById("vfop-client-select");
    if (select) select.addEventListener("change", onClienteChange);

    ensureQuickAccessContainer();
    loadClienteOperacao();
    renderAtalhos();
  }

  function getToken() {
    const token = localStorage.getItem(STORAGE_KEY);
    if (!token) {
      window.location.replace("index.html");
      return null;
    }
    return token;
  }

  function syncControlCenterLink() {
    const link = document.getElementById("vfop-control-center-link");
    if (!link) return;
    const params = new URLSearchParams(window.location.search || "");
    link.href = params.get("vf_debug") ? "control-center.html?vf_debug=1" : "control-center.html";
  }

  async function loadClienteOperacao() {
    const token = getToken();
    if (!token || state.loading) return;

    setLoading(true);
    state.sources = {};
    state.failures = [];
    state.loadedAt = new Date();

    // TODO backend futuro: preferir GET /clientes/:id/operacao ou
    // GET /clientes/:id/workspace quando esse contrato existir.
    state.clientes = await loadClientes();
    state.selectedCliente = chooseCliente(state.clientes, state.selectedKey);
    state.selectedKey = getClienteOptionKey(state.selectedCliente);
    renderClienteSelect();
    renderHeaderSkeleton(state.selectedCliente);

    const results = await Promise.all([
      loadBases(),
      loadVinculos(),
      loadVinculoClientes(),
      loadTokens(),
      loadRelatorios(),
      loadBaseCobertura(),
      loadEntregas(state.selectedCliente),
    ]);

    state.bases = results[0];
    state.vinculos = results[1];
    state.vinculoClientes = results[2];
    state.tokens = results[3];
    state.relatorios = results[4];
    state.cobertura = results[5];
    state.entregas = results[6];
    state.ads = await loadAds(state.selectedCliente);
    renderClienteOperacao(normalizeClienteWorkspace());
    setLoading(false);
  }

  async function onClienteChange(event) {
    const nextKey = event?.target?.value || "";
    const nextCliente = state.clientes.find((cliente) => getClienteOptionKey(cliente) === nextKey) || state.clientes[0] || FALLBACK_CLIENTE;
    state.selectedKey = getClienteOptionKey(nextCliente);
    state.selectedCliente = nextCliente;
    state.ads = await loadAds(nextCliente);
    state.entregas = await loadEntregas(nextCliente);
    renderClienteOperacao(normalizeClienteWorkspace());
  }

  async function loadClientes() {
    const result = await apiGet("/clientes", "clientes", "GET /clientes");
    if (!result.ok) return [FALLBACK_CLIENTE];
    const clientes = extractArray(result.data, ["clientes", "items", "data"]).filter(isPlainObject);
    return clientes.length ? clientes : [FALLBACK_CLIENTE];
  }

  async function loadBases() {
    const result = await apiGet("/bases", "bases", "GET /bases");
    if (!result.ok) return [];
    return extractArray(result.data, ["bases", "items", "data"]).filter(isPlainObject);
  }

  async function loadVinculos() {
    const result = await apiGet("/base-vinculos", "vinculos", "GET /base-vinculos");
    if (!result.ok) return [];
    return extractArray(result.data, ["bases", "vinculos", "items", "data"]).filter(isPlainObject);
  }

  async function loadVinculoClientes() {
    const result = await apiGet("/base-vinculos/clientes", "vinculoClientes", "GET /base-vinculos/clientes");
    if (!result.ok) return [];
    return extractArray(result.data, ["clientes", "items", "data"]).filter(isPlainObject);
  }

  async function loadTokens() {
    const result = await apiGet("/admin/ml-tokens", "tokens", "GET /admin/ml-tokens");
    if (!result.ok) return [];
    return extractArray(result.data, ["tokens", "items", "data"]).filter(isPlainObject);
  }

  async function loadRelatorios() {
    const result = await apiGet("/automacoes/relatorios", "relatorios", "GET /automacoes/relatorios");
    if (!result.ok) return [];
    return extractArray(result.data, ["relatorios", "items", "data"]).filter(isPlainObject);
  }

  async function loadAds(cliente) {
    const params = new URLSearchParams({
      clienteSlug: getClienteSlug(cliente) || FALLBACK_CLIENTE.slug,
      mes: getCurrentMonthRef(),
      lojaCampanha: "todas",
    });
    const result = await apiGet(`/ads/acompanhamento?${params.toString()}`, "ads", "GET /ads/acompanhamento");
    if (!result.ok) return null;
    return result.data?.acompanhamento || result.data || null;
  }

  async function loadBaseCobertura() {
    const result = await apiGet("/operacao/base-cobertura", "cobertura", "GET /operacao/base-cobertura");
    if (!result.ok) return null;
    return result.data || null;
  }

  async function loadEntregas(cliente) {
    const slug = cliente?.slug
      || state.selectedCliente?.slug
      || FALLBACK_CLIENTE?.slug
      || "";
    if (!slug) return [];
    const result = await apiGet(`/entregas-cliente?cliente_slug=${encodeURIComponent(slug)}`, "entregas", "GET /entregas-cliente");
    if (!result.ok) return [];
    return Array.isArray(result.data?.entregas) ? result.data.entregas : [];
  }

  async function apiGet(path, key, label) {
    const token = getToken();
    if (!token) return { ok: false, status: 0, data: null };

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      });
      const data = sanitizeSensitiveData(await response.json().catch(() => ({})));

      if (!response.ok || data?.ok === false) {
        const message = data?.erro || data?.error || data?.motivo || `HTTP ${response.status}`;
        recordSource(key, label, response.status, false, message);
        return { ok: false, status: response.status, data, error: message };
      }

      recordSource(key, label, response.status, true, "");
      return { ok: true, status: response.status, data };
    } catch (error) {
      const message = error?.message || "Falha de rede";
      recordSource(key, label, 0, false, message);
      return { ok: false, status: 0, data: null, error: message };
    }
  }

  function recordSource(key, label, status, ok, message) {
    const kind = ok ? "real" : (status === 403 || status === 401 ? "preview" : "todo");
    state.sources[key] = { key, label, status, ok, kind, message: message || "" };
    if (!ok) state.failures.push({ key, label, status, message: message || "Indisponivel" });
  }

  function chooseCliente(clientes, preferredKey) {
    const list = Array.isArray(clientes) && clientes.length ? clientes : [FALLBACK_CLIENTE];
    const preferred = preferredKey ? list.find((cliente) => getClienteOptionKey(cliente) === preferredKey) : null;
    if (preferred) return preferred;

    const active = list.find((cliente) => {
      const status = String(cliente?.status || cliente?.situacao || "").toLowerCase();
      return cliente?.ativo !== false && status !== "inativo" && status !== "inactive";
    });
    return active || list[0] || FALLBACK_CLIENTE;
  }

  function normalizeClienteWorkspace() {
    const cliente = state.selectedCliente || FALLBACK_CLIENTE;
    const allBases = uniqueBy([...state.bases, ...state.vinculos], getBaseStableKey);
    const basesDoCliente = allBases.filter((base) => matchesCliente(base, cliente));
    const vinculoClientes = state.vinculoClientes.filter((item) => matchesCliente(item, cliente));
    const tokenRows = state.tokens.filter((token) => matchesCliente(token, cliente));
    const baseKeys = basesDoCliente.map(getBaseSlug).filter(Boolean).map(slugKey);
    const relatorios = state.relatorios
      .filter((relatorio) => matchesCliente(relatorio, cliente) || baseKeys.includes(slugKey(relatorio.base_slug || relatorio.baseSlug || "")))
      .sort(sortByRecent);

    const baseDoVinculo = state.vinculos.find(
      (v) => v?.vinculo?.cliente_slug === cliente?.slug ||
             v?.vinculo?.cliente_id   === cliente?.id
    ) || null;
    const basePrincipal = basesDoCliente[0] || buildBaseFromCliente(cliente, vinculoClientes[0]) || baseDoVinculo || null;
    const tokenPrincipal = tokenRows[0] || null;
    const relatorioPrincipal = relatorios[0] || null;
    const tokenState = getTokenState(tokenPrincipal, state.sources.tokens);
    const channel = inferMarketplace(cliente, basePrincipal, tokenPrincipal);

    const workspace = {
      cliente,
      nome: getClienteName(cliente),
      slug: getClienteSlug(cliente),
      channel,
      basePrincipal,
      basesDoCliente,
      vinculoClientes,
      tokenPrincipal,
      tokenRows,
      tokenState,
      relatorioPrincipal,
      relatorios,
      ads: state.ads,
      coverage: normalizeCoverage(state.cobertura),
      hasBase: Boolean(basePrincipal),
      hasGrant: Boolean(tokenPrincipal),
      hasDiagnosis: Boolean(relatorioPrincipal),
      hasAds: Boolean(state.ads && state.sources.ads?.ok),
      loadedAt: state.loadedAt,
      isFallback: Boolean(cliente.__mock),
    };

    workspace.frete = buildFretePreviewMock(workspace);
    workspace.pricing = buildPricingPreviewMock(workspace);
    workspace.setup = buildSetupScore(workspace);
    workspace.quality = buildDataQuality(workspace);
    workspace.futureData = buildFutureCalcData(workspace);
    workspace.record = buildOperationalRecord(workspace);
    workspace.channels = buildChannels(workspace);
    workspace.actions = buildActions(workspace);
    workspace.history = buildHistory(workspace);

    return workspace;
  }

  function buildOperationalRecord(workspace) {
    const apiKeyStatus = getSensitivePresence(workspace.cliente, ["api_key", "apiKey", "key"]);
    return [
      { label: "Nome", value: workspace.nome, hint: sourceHint("clientes") },
      { label: "Slug", value: workspace.slug || "--", hint: sourceHint("clientes") },
      { label: "Status", value: workspace.cliente?.ativo === false ? "Inativo" : "Ativo", hint: sourceHint("clientes") },
      { label: "Canais detectados", value: getDetectedChannels(workspace).join(", "), hint: "real + preview quando canal futuro" },
      { label: "Base oficial vinculada", value: workspace.hasBase ? getBaseName(workspace.basePrincipal) : "Pendente", hint: workspace.hasBase ? sourceHint("vinculos") : "vincular em Bases de Custo" },
      { label: "Grant ML", value: workspace.tokenState.label, hint: workspace.tokenState.detail, tone: workspace.tokenState.tone },
      { label: "API key", value: apiKeyStatus, hint: "valor completo nao e exibido" },
      { label: "Observacao", value: "Dados sensiveis em clientes.html", hint: "cadastro administrativo separado" },
    ];
  }

  function buildSetupScore(workspace) {
    const reportAge = getAgeDays(workspace.relatorioPrincipal?.created_at || workspace.relatorioPrincipal?.createdAt);
    const recentReport = workspace.hasDiagnosis && (reportAge == null || reportAge <= 30);
    const temFechamento = (state.entregas || []).some(
      (e) => e?.tipo === "fechamento_mensal" || e?.tipo === "fechamento"
    );
    const ultimoFechamento = (state.entregas || [])
      .filter((e) => e?.tipo === "fechamento_mensal" || e?.tipo === "fechamento")
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    const dataUltimo = ultimoFechamento?.created_at
      ? new Date(ultimoFechamento.created_at).toLocaleDateString("pt-BR")
      : null;
    const checks = [
      setupItem("cliente", "Cliente cadastrado", Boolean(workspace.cliente), "Cadastro encontrado", sourceKind("clientes"), 12),
      setupItem("canal", "Canal principal definido", Boolean(workspace.channel), marketplaceLabel(workspace.channel), workspace.channel ? "real" : "preview", 10),
      setupItem("base", "Base vinculada", workspace.hasBase, workspace.hasBase ? getBaseName(workspace.basePrincipal) : "Aguardando vinculo oficial", sourceKind("vinculos"), 18),
      setupItem("grant", "Grant ML conectado", workspace.hasGrant, workspace.tokenState.detail, sourceKind("tokens"), 18),
      setupItem("diagnostico", "Primeiro diagnostico", workspace.hasDiagnosis, workspace.hasDiagnosis ? getReportName(workspace.relatorioPrincipal) : "Nao localizado", sourceKind("relatorios"), 14),
      {
        key: "fechamento",
        label: "Primeiro fechamento",
        done: temFechamento,
        detail: temFechamento ? `Último: ${dataUltimo}` : "Aguardando primeiro fechamento",
        source: sourceKind("entregas"),
        points: 8,
        tone: temFechamento ? "success" : "warning",
      },
      setupItem("ads", "Ads/acompanhamento", workspace.hasAds, workspace.hasAds ? "Acompanhamento salvo no periodo" : "Sem acompanhamento do periodo", sourceKind("ads"), 10),
      setupItem("frete", "Frete historico", false, "Pendente para backend futuro", "todo", 10),
    ];

    const stale = workspace.hasDiagnosis && reportAge != null && reportAge > 30;
    if (stale) {
      const item = checks.find((check) => check.key === "diagnostico");
      if (item) {
        item.done = false;
        item.tone = "warning";
        item.detail = `Relatorio antigo: ${reportAge} dias`;
      }
    }
    const score = clamp(checks.reduce((sum, item) => sum + (item.done ? item.points : 0), 0), 0, 100);
    const label = score >= 80 ? "Setup completo" : "Setup incompleto";
    const tone = score >= 80 ? "success" : (score >= 45 ? "warning" : "danger");
    return { score, label, tone, checks };
  }

  function setupItem(key, label, done, detail, source, points) {
    return {
      key,
      label,
      done: Boolean(done),
      detail,
      source,
      points,
      tone: done ? "success" : (source === "todo" ? "warning" : "danger"),
    };
  }

  function buildDataQuality(workspace) {
    const relatorio = workspace.relatorioPrincipal || {};
    const semCusto = firstFiniteNumber([
      relatorio.itens_sem_base,
      relatorio.itensSemBase,
      relatorio.sem_custo,
      relatorio.anuncios_sem_custo,
      relatorio.produtos_sem_custo,
    ]);
    const reportAge = getAgeDays(relatorio.created_at || relatorio.createdAt);
    const missingCostValue = semCusto == null ? 18 : semCusto;

    return [
      futureRow("Produtos/anuncios sem custo", semCusto == null ? `${missingCostValue} prev.` : String(missingCostValue), semCusto == null ? "preview" : "real", semCusto == null ? "Aguardando total no relatorio" : "Diagnostico mais recente"),
      futureRow("Sem frete confiavel", "Pendente", "todo", "Contrato futuro de frete historico por cliente"),
      futureRow("Sem marketplace identificado", workspace.channel ? "Nao" : "Sim", workspace.channel ? "real" : "preview", workspace.channel ? marketplaceLabel(workspace.channel) : "Canal principal nao veio nos dados"),
      futureRow(
        "Grant ML ausente",
        state.sources.tokens?.ok ? (workspace.hasGrant ? "Nao" : "Sim") : "Nao validado",
        sourceKind("tokens"),
        state.sources.tokens?.ok
          ? (workspace.hasGrant ? "Grant ML conectado" : "Conectar em clientes.html")
          : "Nao foi possivel validar /admin/ml-tokens"
      ),
      futureRow("Relatorio antigo", !workspace.hasDiagnosis ? "Sem relatorio" : (reportAge != null && reportAge > 30 ? `${reportAge} dias` : "Nao"), sourceKind("relatorios"), workspace.hasDiagnosis ? "Diagnostico localizado" : "Rode o primeiro diagnostico"),
      futureRow("Precificacao pendente", workspace.pricing.blockers.length ? "Sim" : "Nao", "todo", workspace.pricing.blockers.join(", ") || "Sem bloqueio critico no piloto"),
      futureRow("Frete historico pendente", "Sim", "todo", "Necessario para calculo fino de margem"),
    ];
  }

  function buildFutureCalcData(workspace) {
    return buildDataQuality(workspace);
  }

  function buildPricingPreviewMock(workspace) {
    const relatorio = workspace.relatorioPrincipal || {};
    const mcMedia = firstFiniteNumber([relatorio.mc_media, relatorio.margem_media, relatorio.margemAtual]);
    const blockers = [];
    if (!workspace.hasBase) blockers.push("base vinculada");
    if (!workspace.hasGrant) blockers.push("grant ML");
    if (!workspace.hasDiagnosis) blockers.push("diagnostico");
    return {
      isMock: mcMedia == null,
      confidence: blockers.length ? "baixa" : "media",
      blockers,
      currentMargin: mcMedia == null ? null : normalizePercent(mcMedia),
    };
  }

  function buildFretePreviewMock(workspace) {
    return {
      isMock: true,
      confidence: workspace.hasBase && workspace.hasDiagnosis ? "media" : "baixa",
      blockers: ["frete historico por SKU/canal"],
    };
  }

  function buildChannels(workspace) {
    const pending = getMainPending(workspace);
    return [
      {
        canal: "Mercado Livre",
        marketplace: "Mercado Livre",
        name: "Loja principal",
        id: workspace.slug || "cliente selecionado",
        base: statusSpec(workspace.hasBase ? "Vinculada" : "Pendente", workspace.hasBase ? "success" : "danger"),
        grant: statusSpec(workspace.tokenState.label, workspace.tokenState.tone),
        diagnostico: statusSpec(workspace.hasDiagnosis ? "Localizado" : "Pendente", workspace.hasDiagnosis ? "success" : "warning"),
        fechamento: statusSpec("TODO", "warning"),
        pending,
        source: "real",
      },
      {
        canal: "Mercado Livre",
        marketplace: "Mercado Livre",
        name: "Loja 2",
        id: "canal preparado",
        base: statusSpec("Preview", "warning"),
        grant: statusSpec("TODO", "warning"),
        diagnostico: statusSpec("TODO", "warning"),
        fechamento: statusSpec("TODO", "warning"),
        pending: "confirmar existencia da loja",
        source: "preview",
      },
      {
        canal: "Shopee",
        marketplace: "Shopee",
        name: "Loja futura",
        id: "canal preparado",
        base: statusSpec("Preview", "warning"),
        grant: statusSpec("TODO", "warning"),
        diagnostico: statusSpec("TODO", "warning"),
        fechamento: statusSpec("TODO", "warning"),
        pending: "aguarda contrato de canal",
        source: "preview",
      },
    ];
  }

  function buildMetrics(workspace) {
    return [
      futureRow("Pedidos", "--", "todo", "GET /clientes/:id/operacao"),
      futureRow("Faturamento", "--", "todo", "Contrato financeiro por cliente"),
      futureRow("Investimento Ads", workspace.hasAds ? "Acompanhamento salvo" : "Sem dado", sourceKind("ads"), "GET /ads/acompanhamento"),
    ];
  }

  function buildActions(workspace) {
    const semCusto = workspace.futureData.find((item) => item.label === "Produtos/anuncios sem custo");
    const actions = [
      actionRow("Vincular base", workspace.hasBase ? "OK" : "Alta", workspace.hasBase ? getBaseName(workspace.basePrincipal) : "Base oficial ausente", sourceKind("vinculos"), workspace.hasBase ? "Concluido" : "Pendente"),
      actionRow("Rodar diagnostico", workspace.hasDiagnosis ? "OK" : "Alta", workspace.hasDiagnosis ? getReportName(workspace.relatorioPrincipal) : "Primeiro diagnostico nao localizado", sourceKind("relatorios"), workspace.hasDiagnosis ? "Concluido" : "Pendente"),
      actionRow("Revisar anuncios sem custo", semCusto?.source === "real" ? "Media" : "Baixa", semCusto?.detail || "Aguardando relatorio", semCusto?.source || "preview", semCusto?.value || "Preview"),
      actionRow("Atualizar frete historico", "Media", "Necessario para calculo fino de margem", "todo", "TODO backend"),
      actionRow("Gerar relatorio", workspace.hasDiagnosis ? "Baixa" : "Media", workspace.hasDiagnosis ? "Relatorio localizado" : "Sem diagnostico salvo", sourceKind("relatorios"), workspace.hasDiagnosis ? "Opcional" : "Pendente"),
      // FUTURO: ClickUp por cliente.
    ];
    if (!workspace.hasGrant && state.sources.tokens?.ok) {
      actions.splice(1, 0, actionRow("Conectar grant", "Alta", "Grant ML ausente", "real", "Pendente"));
    }
    return actions;
  }

  function buildHistory(workspace) {
    const baseDate = workspace.basePrincipal?.updated_at || workspace.basePrincipal?.created_at || workspace.basePrincipal?.createdAt;
    const tokenDate = workspace.tokenPrincipal?.updated_at || workspace.tokenPrincipal?.created_at || workspace.tokenPrincipal?.createdAt;
    const reportDate = workspace.relatorioPrincipal?.created_at || workspace.relatorioPrincipal?.createdAt;
    return [
      historyRow("Base importada", workspace.hasBase ? getBaseName(workspace.basePrincipal) : "pendente", baseDate, workspace.hasBase ? "real" : "preview"),
      historyRow("Grant conectado", workspace.tokenState.detail, tokenDate, sourceKind("tokens")),
      historyRow("Diagnostico rodado", workspace.hasDiagnosis ? getReportName(workspace.relatorioPrincipal) : "pendente", reportDate, sourceKind("relatorios")),
      historyRow("Relatorio salvo", workspace.hasDiagnosis ? "Disponivel em relatorios" : "aguarda diagnostico", reportDate, sourceKind("relatorios")),
      historyRow("Fechamento processado", "TODO contrato por cliente", null, "todo"),
      // FUTURO: ClickUp por cliente.
    ];
  }

  function futureRow(label, value, source, detail) {
    return { label, value, source, detail };
  }

  function actionRow(title, priority, reason, source, status) {
    return { title, priority, reason, source, status };
  }

  function historyRow(title, detail, date, source) {
    return { title, detail, date, source };
  }

  function renderClienteOperacao(workspace) {
    renderHeader(workspace);
    renderPilotNote();
    renderOperationalRecord(workspace);
    renderIdentityPanel(workspace.cliente);
    renderClientChip(workspace.cliente, workspace.setup?.score);
    renderMLLinkButton(workspace.cliente);
    renderChannels(workspace);
    renderReadiness(workspace);
    renderFutureData(workspace);
    renderActions(workspace);
    renderHistory(workspace);
    renderAtalhos();
  }

  function renderClienteSelect() {
    const select = document.getElementById("vfop-client-select");
    if (!select) return;
    select.innerHTML = state.clientes.map((cliente) => {
      const key = getClienteOptionKey(cliente);
      const label = `${getClienteName(cliente)}${cliente?.ativo === false ? " (inativo)" : ""}`;
      return `<option value="${escapeHTML(key)}">${escapeHTML(label)}</option>`;
    }).join("");
    select.value = state.selectedKey;
  }

  function renderHeaderSkeleton(cliente) {
    setText("vfop-client-name", getClienteName(cliente));
    setText("vfop-client-channel", "Canal principal: carregando");
    setText("vfop-last-update", "Atualizacao: carregando");
  }

  function renderHeader(workspace) {
    setText("vfop-client-name", workspace.nome);
    setText("vfop-client-channel", `Canal principal: ${marketplaceLabel(workspace.channel)}`);
    setText("vfop-last-update", `Atualizado: ${formatDateTime(workspace.loadedAt)}`);
    const titleEl = document.getElementById("vfop-page-title");
    if (titleEl && workspace.cliente?.nome) {
      titleEl.textContent = workspace.cliente.nome;
    }
    const headActs = document.getElementById("vfop-head-actions");
    if (headActs && workspace.cliente) {
      const c = workspace.cliente;
      const slug = getClienteSlug(c);
      const safeSlug = escapeHTML(escapeJsString(slug));
      const safeName = escapeHTML(escapeJsString((getClienteName(c) || "").replace(/'/g, "")));
      const temGrant = (state.tokens || []).some(
        t => t?.cliente_slug === c?.slug || t?.cliente_id === c?.id
      );
      headActs.innerHTML = `
        <a href="clientes.html" class="vfop-action">
          Editar cliente
        </a>
        ${!temGrant ? `
          <button class="vfop-action vfop-action--ghost"
                  onclick="copiarLinkML('${safeSlug}')">
            Copiar link ML
          </button>` : ""}
        <button class="vfop-action"
                onclick="salvarAtalhoCliente('${safeSlug}',
                '${safeName}')">
          ☆ Salvar atalho
        </button>`;
    }
    setStatus("vfop-operational-status", workspace.setup.label, workspace.setup.tone);
  }

  function renderPilotNote() {
    const alert = document.getElementById("vfop-source-alert");
    if (!alert) return;
    if (!state.failures.length) {
      alert.textContent = "Ficha piloto: dados reais carregados onde ja existe contrato de API; previews e TODO ficam marcados por linha.";
      return;
    }
    const labels = state.failures.slice(0, 3).map((item) => item.label.replace("GET ", "")).join(", ");
    const more = state.failures.length > 3 ? ` +${state.failures.length - 3}` : "";
    alert.textContent = `Estado parcial: ${labels}${more} indisponivel(is). A ficha continua com dados reais parciais e linhas preview/TODO.`;
  }

  function renderOperationalRecord(workspace) {
    const target = document.getElementById("vfop-operational-record");
    if (!target) return;
    target.innerHTML = workspace.record.map((item) => `
      <div class="vfop-record-item">
        <div class="vfop-record-item__label">${escapeHTML(item.label)}</div>
        <div class="vfop-record-item__value">${item.tone ? statusBadge(item.value, item.tone) : escapeHTML(item.value)}</div>
        <div class="vfop-record-item__hint">${escapeHTML(item.hint || "")}</div>
      </div>
    `).join("");
  }

  function renderIdentityPanel(cliente) {
    const el = document.getElementById("vfop-identity-panel");
    if (!el || !cliente) return;

    const workspace = normalizeClienteWorkspace
      ? null : null; // só lê o que já está no state

    const basePrincipal = state.vinculos?.find(
      v => v?.vinculo?.cliente_slug === cliente.slug
        || v?.vinculo?.cliente_id   === cliente.id
    );
    const baseNome = basePrincipal?.nome
      || basePrincipal?.slug
      || "Pendente";
    const baseOk = !!basePrincipal;

    const temGrant = (state.tokens || []).some(
      t => t?.cliente_slug === cliente.slug
        || t?.cliente_id   === cliente.id
    );

    const rows = [
      ["Nome",   escapeHTML(cliente.nome || "—")],
      ["Slug",
        `<span style="font-family:monospace;font-size:12px">
          ${escapeHTML(cliente.slug || "—")}
        </span>`],
      ["Status", cliente.ativo !== false
        ? `<span class="vfop-badge vfop-badge-ok">ativo</span>`
        : `<span class="vfop-badge vfop-badge-crit">inativo</span>`
      ],
      ["Canais", String(
        state.canais?.length
        || state.vinculos?.length
        ||
        "—"
      )],
      ["Base",   baseOk
        ? `<span class="vfop-badge vfop-badge-ok">
             ${escapeHTML(baseNome)}
           </span>`
        : `<span class="vfop-badge vfop-badge-warn">
             pendente
           </span>`
      ],
      ["Grant ML", temGrant
        ? `<span class="vfop-badge vfop-badge-ok">
             grantado
           </span>`
        : `<span class="vfop-badge vfop-badge-warn">
             precisa grant
           </span>`
      ],
    ];

    el.innerHTML = `
      <div class="vfop-identity">
        <div class="vfop-identity-head">
          <span class="vfop-section-eyebrow">Identidade</span>
        </div>
        ${rows.map(([l, v]) => `
          <div class="vfop-identity-row">
            <span class="vfop-identity-label">${l}</span>
            <span class="vfop-identity-val">${v}</span>
          </div>`).join("")}
        <div style="padding:10px 14px;border-top:
                    1px solid var(--vfop-border-soft);
                    display:flex;align-items:center;
                    justify-content:space-between;">
          <span style="font-size:11.5px;
                       color:var(--vfop-soft);">
            API key, tokens e segredos
          </span>
          <span class="vfop-badge vfop-badge-neutral">
            somente admin
          </span>
        </div>
      </div>`;
  }

  function renderClientChip(cliente, scorePercent) {
    const titleEl = document.getElementById("vfop-page-title");
    if (titleEl && cliente?.nome) {
      titleEl.textContent = cliente.nome;
    }

    const chipEl = document.getElementById("vfop-switcher-chip");
    if (!chipEl || !cliente) return;

    const pct   = Math.round(scorePercent || 0);
    const isOk  = pct >= 80;
    const color = isOk ? "#1a7a45"
      : (pct >= 45 ? "#855100" : "#9b1c1c");
    const status = isOk ? "completo" : "em configuração";
    const initials = (cliente.nome || "?")
      .split(/\s+/).slice(0, 2)
      .map(w => w[0]).join("").toUpperCase();

    chipEl.innerHTML = `
      <div class="vfop-switch-chip">
        <div class="vfop-switch-chip-ic">${escapeHTML(initials)}</div>
        <div class="vfop-switch-chip-body">
          <div class="vfop-switch-chip-name">
            ${escapeHTML(cliente.nome || "—")}
          </div>
          <div class="vfop-switch-chip-meta"
               style="color:${color}">
            setup ${pct}% · ${status}
          </div>
        </div>
        <span class="vfop-switch-chip-chev">▾</span>
      </div>`;
  }

  function ensureQuickAccessContainer() {
    if (!document.getElementById("vfop-quick-access")) {
      const chip = document.getElementById("vfop-client-chip");
      if (chip) {
        const qa = document.createElement("div");
        qa.id = "vfop-quick-access";
        qa.className = "vfop-quick-access";
        qa.style.display = "none";
        chip.parentNode.insertBefore(qa, chip.nextSibling);
      }
    }
  }

  function renderMLLinkButton(cliente) {
    const temGrant = (state.tokens || []).some(
      (t) => t?.cliente_slug === cliente?.slug ||
             t?.cliente_id   === cliente?.id
    );

    const btnLink = document.getElementById("vfop-btn-copiar-link");
    if (btnLink) {
      if (!temGrant) {
        btnLink.style.display = "inline-flex";
        btnLink.textContent   = "Copiar link ML";
        btnLink.onclick = () => {
          const url =
            `https://venforce-server.onrender.com/ml/conectar/${cliente.slug}`;
          navigator.clipboard.writeText(url).then(() => {
            btnLink.textContent = "Link copiado!";
            setTimeout(() => {
              btnLink.textContent = "Copiar link ML";
            }, 2000);
          });
        };
      } else {
        btnLink.style.display = "none";
        btnLink.onclick = null;
      }
    }
  }

  function renderChannels(workspace) {
    const target = document.getElementById("vfop-channels-body");
    if (!target) return;
    const reportAge = getAgeDays(workspace.relatorioPrincipal?.created_at || workspace.relatorioPrincipal?.createdAt);
    const diagnosticoOk = workspace.hasDiagnosis && (reportAge == null || reportAge <= 30);
    target.innerHTML = workspace.channels.map((channel, index) => {
      const canalActions = [];
      if (channel.source === "real") {
        if (!workspace.hasBase) {
          canalActions.push({ label: "Vincular base", href: "bases.html" });
        } else if (channel.marketplace !== "Shopee" && !workspace.hasGrant) {
          canalActions.push({
            label: "Copiar link ML",
            primary: true,
            onclick: `copiarLinkML('${escapeJsString(workspace.slug || "")}')`,
          });
        } else if (!diagnosticoOk) {
          canalActions.push({ label: "Rodar diagnóstico", href: "automacoes.html", primary: true });
        }
      }

      return renderChannelCard({
        marketplace: channel.marketplace,
        nome: channel.name,
        identificador: channel.id,
        source: channel.source,
        baseHtml: statusBadge(channel.base.label, channel.base.tone),
        grantHtml: statusBadge(channel.grant.label, channel.grant.tone),
        diagHtml: statusBadge(channel.diagnostico.label, channel.diagnostico.tone),
        fechHtml: statusBadge(channel.fechamento.label, channel.fechamento.tone),
        pendencia: channel.pending,
        clienteSlug: workspace.slug,
        temBase: workspace.hasBase,
        temGrant: workspace.hasGrant,
        diagnosticoOk,
        baseOk: workspace.hasBase,
        grantOk: workspace.hasGrant,
        diagOk: diagnosticoOk,
        isPrincipal: index === 0,
        acoes: canalActions,
      });
    }).join("");
  }

  function renderChannelCard(canal) {
    const mp = (canal.marketplace || "").toLowerCase();
    const iconClass = mp.includes("shopee")
      ? "vfop-canal-icon--shopee"
      : mp.includes("meli") || mp.includes("mercado")
      ? "vfop-canal-icon--meli"
      : "vfop-canal-icon--outro";

    const iconLetter = mp.includes("shopee") ? "S"
      : mp.includes("meli") || mp.includes("mercado") ? "ML"
      : "?";

    const srcClass = canal.source === "real"
      ? "vfop-source-tag--real"
      : canal.source === "preview"
      ? "vfop-source-tag--preview"
      : "vfop-source-tag--todo";

    const srcLabel = canal.source === "real" ? "Real"
      : canal.source === "preview" ? "Preview" : "TODO";

    const statusBadge = (() => {
      if (canal.source !== "real") {
        return `<span class="vfop-badge vfop-badge-neutral">
          canal futuro</span>`;
      }
      const hasGrant = canal.grantOk ?? canal.temGrant;
      const hasBase  = canal.baseOk ?? canal.temBase;
      const hasDiag  = canal.diagOk ?? canal.diagnosticoOk;
      if (!hasGrant && mp.includes("meli")) {
        return `<span class="vfop-badge vfop-badge-crit">
          <span class="vfop-dot vfop-dot-err"></span>
          incompleto</span>`;
      }
      if (!hasBase) {
        return `<span class="vfop-badge vfop-badge-warn">
          <span class="vfop-dot vfop-dot-warn"></span>
          em config</span>`;
      }
      if (!hasDiag) {
        return `<span class="vfop-badge vfop-badge-warn">
          <span class="vfop-dot vfop-dot-warn"></span>
          em config</span>`;
      }
      return `<span class="vfop-badge vfop-badge-ok">
        <span class="vfop-dot vfop-dot-ok"></span>
        operável</span>`;
    })();

    const cells = [
      {
        label: mp.includes("shopee") ? "API / Grant" : "Grant ML",
        html: canal.grantHtml || `<span class="vfop-badge
          vfop-badge-neutral">—</span>`
      },
      {
        label: "Base de custo",
        html: canal.baseHtml || `<span class="vfop-badge
          vfop-badge-neutral">—</span>`
      },
      {
        label: "Diagnóstico",
        html: canal.diagHtml || `<span class="vfop-badge
          vfop-badge-neutral">—</span>`
      },
      {
        label: "Fechamento",
        html: canal.fechHtml || `<span class="vfop-badge
          vfop-badge-neutral">—</span>`
      },
    ];

    const btns = canal.acoes || [];
    const btnsHtml = btns.length
      ? btns.map(b => b.primary
          ? `<button class="vfop-action vfop-action--primary"
               onclick="${escapeHTML(b.onclick || "")}">${escapeHTML(b.label)}</button>`
          : b.href
          ? `<a href="${escapeHTML(b.href)}" class="vfop-action">${escapeHTML(b.label)}</a>`
          : `<button class="vfop-action"
               onclick="${escapeHTML(b.onclick || "")}">${escapeHTML(b.label)}</button>`
        ).join("")
      : "";

    return `
      <div class="vfop-canal-card">
        <div class="vfop-canal-head">
          <div class="vfop-canal-icon ${iconClass}">
            ${iconLetter}
          </div>
          <div class="vfop-canal-name">
            <div class="vfop-canal-name-main">
              ${escapeHTML(canal.marketplace || "")} ·
              ${escapeHTML(canal.nome || "")}
              ${canal.isPrincipal
                ? `<span class="vfop-badge vfop-badge-brand"
                         style="font-size:9px;padding:1px 5px">
                     principal
                   </span>`
                : ""}
            </div>
            <div class="vfop-canal-name-sub">
              ${escapeHTML(canal.identificador || "")}
            </div>
          </div>
          ${statusBadge}
        </div>
        <div class="vfop-canal-fields">
          ${cells.map(c => `
            <div class="vfop-canal-field-cell">
              <div class="vfop-canal-field-cell-label">
                ${escapeHTML(c.label)}
              </div>
              ${c.html}
            </div>`).join("")}
        </div>
        ${btnsHtml
          ? `<div class="vfop-canal-foot">${btnsHtml}</div>`
          : ""}
      </div>`;
  }

  function renderChannelCardAction(canal) {
    if (canal.source !== "real") {
      return `<span style="font-size:11px;color:var(--vfop-muted);">
        canal futuro
      </span>`;
    }

    if (!canal.temBase) {
      return `<a href="bases.html" class="vfop-card-action">
        Vincular base
      </a>`;
    }

    if (canal.marketplace !== "Shopee" && !canal.temGrant) {
      return `<button class="vfop-card-action vfop-card-action--primary"
              onclick="copiarLinkML('${escapeJsString(canal.clienteSlug || "")}')">
        Copiar link ML
      </button>`;
    }

    if (!canal.diagnosticoOk) {
      return `<a href="automacoes.html"
         class="vfop-card-action vfop-card-action--primary">
        Rodar diagnóstico
      </a>`;
    }

    return `<span style="font-size:11px;color:var(--vfop-success);">
      ✓ Canal operacional
    </span>`;
  }

  function copiarLinkML(slug) {
    const url =
      `https://venforce-server.onrender.com/ml/conectar/${slug}`;
    navigator.clipboard.writeText(url).then(() => {
      const btns = document.querySelectorAll(
        ".vfop-card-action--primary"
      );
      btns.forEach(b => {
        if (b.textContent.includes("link ML")) {
          b.textContent = "Copiado!";
          setTimeout(() => {
            b.textContent = "Copiar link ML";
          }, 2000);
        }
      });
    });
  }

  function salvarAtalhoCliente(slug, nome) {
    const KEY = "vfop-atalhos-clientes";
    let lista = [];
    try {
      lista = JSON.parse(localStorage.getItem(KEY) || "[]");
    } catch {}
    if (!lista.find(a => a.slug === slug)) {
      lista.push({ slug, nome });
      if (lista.length > 5) lista.shift();
      localStorage.setItem(KEY, JSON.stringify(lista));
    }
    renderAtalhos();
    const btn = document.querySelector(
      `[onclick*="salvarAtalhoCliente"]`
    );
    if (btn) {
      btn.textContent = "★ Salvo";
      setTimeout(() => { btn.textContent = "☆ Salvar atalho"; },
        1500);
    }
  }

  function renderAtalhos() {
    const wrap = document.getElementById("vfop-quick-chips");
    if (!wrap) return;
    const KEY = "vfop-atalhos-clientes";
    let lista = [];
    try {
      lista = JSON.parse(localStorage.getItem(KEY) || "[]");
    } catch {}
    if (!lista.length) { wrap.innerHTML = ""; return; }

    const slugAtual = state.selectedCliente?.slug || "";

    wrap.innerHTML = lista.map(a => {
      const isActive = a.slug === slugAtual;
      const initials = (a.nome || "?")
        .split(/\s+/).slice(0, 2)
        .map(w => w[0]).join("").toUpperCase();
      const safeSlug = escapeHTML(escapeJsString(a.slug));

      return `
        <div class="vfop-quick-chip-v2
          ${isActive ? "vfop-quick-chip-v2--active" : ""}"
             onclick="selecionarClienteRapido('${safeSlug}')">
          <div class="vfop-quick-chip-v2-ic">
            ${escapeHTML(initials)}
          </div>
          <span>${escapeHTML(a.nome)}</span>
          <span class="vfop-quick-chip-v2-score"
                onclick="event.stopPropagation();
                         removerAtalho('${safeSlug}')">
            ×
          </span>
        </div>`;
    }).join("");
  }

  function removerAtalho(slug) {
    const KEY = "vfop-atalhos-clientes";
    let lista = [];
    try {
      lista = JSON.parse(localStorage.getItem(KEY) || "[]");
    } catch {}
    lista = lista.filter(a => a.slug !== slug);
    localStorage.setItem(KEY, JSON.stringify(lista));
    renderAtalhos();
  }

  function selecionarClienteRapido(slug) {
    const sel = document.getElementById("vfop-client-select");
    if (sel) {
      const cliente = (state.clientes || []).find(
        item => slugKey(getClienteSlug(item)) === slugKey(slug)
      );
      sel.value = cliente ? getClienteOptionKey(cliente) : slug;
      sel.dispatchEvent(new Event("change"));
    }
  }

  window.copiarLinkML = copiarLinkML;
  window.salvarAtalhoCliente = salvarAtalhoCliente;
  window.renderAtalhos = renderAtalhos;
  window.removerAtalho = removerAtalho;
  window.selecionarClienteRapido = selecionarClienteRapido;

  function renderReadinessPanel(workspace) {
    const el = document.getElementById("vfop-readiness-body");
    if (!el) return;

    const score  = workspace?.setup?.score  || 0;
    const label  = workspace?.setup?.label  || "Setup incompleto";
    const checks = workspace?.setup?.checks || [];
    const isOk   = score >= 80;
    const color  = isOk ? "#1a7a45"
      : score >= 45 ? "#855100" : "#9b1c1c";
    const bgColor = isOk ? "#eef7f2"
      : score >= 45 ? "#fdf2e3" : "#fef1f0";

    const badgeClass = isOk ? "vfop-badge-ok"
      : score >= 45 ? "vfop-badge-warn" : "vfop-badge-crit";

    const blockers = checks
      .filter(c => !c.done && c.points > 0)
      .slice(0, 4);

    const blockersHtml = blockers.length
      ? blockers.map(c => {
          const nome = String(c.label || c.key || "—")
            .replace(/</g,"&lt;").replace(/>/g,"&gt;");
          const dotColor =
            c.tone === "danger"  ? "#9b1c1c" :
            c.tone === "warning" ? "#855100" : "#8c96a6";
          return `
            <div style="display:flex;align-items:center;
                        gap:8px;font-size:13px;padding:4px 0;
                        line-height:1.3;">
              <span style="width:7px;height:7px;flex-shrink:0;
                           border-radius:50%;display:inline-block;
                           background:${dotColor}"></span>
              <span><b>${nome}</b></span>
              <span style="margin-left:auto;font-size:11.5px;
                           font-weight:600;color:#8c96a6;
                           white-space:nowrap;">
                +${c.points} pts
              </span>
            </div>`;
        }).join("")
      : `<div style="font-size:12.5px;color:#1a7a45;">
           ✓ Sem bloqueadores críticos
         </div>`;

    el.innerHTML = `
      <div style="display:flex;gap:24px;align-items:center;
                  flex:1;">
        <div class="vfop-conic-ring"
             style="width:132px;height:132px;
                    background:conic-gradient(
                      ${color} 0 ${score}%,
                      #eaecf0 ${score}% 100%)">
          <div class="vfop-conic-inner"
               style="width:95px;height:95px;">
            <span class="vfop-conic-pct">
              ${score}<sup>%</sup>
            </span>
            <span class="vfop-conic-sub">setup</span>
          </div>
        </div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;
                      gap:8px;margin-bottom:10px">
            <span class="vfop-badge ${badgeClass}">
              <span style="width:6px;height:6px;border-radius:50%;
                           background:${color};display:inline-block">
              </span>
              ${escapeHTML(label)}
            </span>
            ${!isOk
              ? `<span style="font-size:12px;color:#8c96a6;">
                   faltam ${100 - score} pts para "pronto"
                 </span>`
              : ""}
          </div>
          ${!isOk
            ? `<div style="font-size:13px;color:#5a6578;
                           margin-bottom:12px;line-height:1.5">
                 Resolva o que está crítico primeiro:
               </div>`
            : ""}
          <div style="display:flex;flex-direction:column;gap:4px">
            ${blockersHtml}
          </div>
        </div>
      </div>`;

    const panelEl = el.closest(".vfop-panel")
      || el.parentElement?.closest(".vfop-panel")
      || el.parentElement;

    const oldFoot = panelEl?.querySelector(".vfop-panel-foot");
    if (oldFoot) oldFoot.remove();

    const clienteSlug = state.selectedCliente?.slug || "";
    const temGrant = (state.tokens || []).some(
      t => t?.cliente_slug === clienteSlug
        || t?.cliente_id === state.selectedCliente?.id
    );

    const footEl = document.createElement("div");
    footEl.className = "vfop-panel-foot";
    footEl.innerHTML = `
      <span class="vfop-panel-foot-note">
        Pesos renormalizados por canal — Shopee não exige grant
      </span>
      <div class="vfop-panel-foot-actions">
        ${!temGrant && clienteSlug ? `
          <button class="vfop-action vfop-action--primary"
                  style="font-size:12px;padding:5px 11px;"
                  onclick="copiarLinkML('${clienteSlug}')">
            Copiar link ML
          </button>` : ""}
        <a href="bases.html"
           class="vfop-action--ghost-arrow">
          Bases →
        </a>
        <a href="automacoes.html"
           class="vfop-action--ghost-arrow">
          Diagnóstico →
        </a>
        <a href="financeiro.html"
           class="vfop-action--ghost-arrow">
          Fechamento →
        </a>
      </div>`;

    if (panelEl) panelEl.appendChild(footEl);
  }

  function renderReadiness(workspace) {
    renderReadinessPanel(workspace);
    setText("vfop-score-value", `${workspace.setup.score}%`);
    setText("vfop-score-label", workspace.setup.label);
    const bar = document.getElementById("vfop-score-bar");
    if (bar) bar.style.width = `${workspace.setup.score}%`;

    const list = document.getElementById("vfop-setup-list");
    if (!list) return;
    list.classList.add("vfop-check-v2");
    list.innerHTML = workspace.setup.checks.map((item) => `
      <div class="vfop-check-v2-item
        ${item.done ? "vfop-check-v2-item--done" : ""}">
        <div class="vfop-check-v2-box
          ${item.done
            ? "vfop-check-v2-box--done"
            : "vfop-check-v2-box--pend"}">
        </div>
        <span class="vfop-check-v2-text">
          ${escapeHTML(item.label || item.key || "")}
          ${item.detail
            ? `<span style="display:block;font-size:11px;
                            color:#8c96a6;margin-top:1px;">
                 ${escapeHTML(item.detail)}
               </span>`
            : ""}
        </span>
        ${item.points
          ? `<span class="vfop-check-v2-pts">
               +${item.points}
             </span>`
          : ""}
      </div>
    `).join("");
  }

  function renderFutureData(workspace) {
    const tbody = document.getElementById("vfop-data-body");
    if (!tbody) return;
    tbody.innerHTML = workspace.futureData.map((item) => `
      <tr>
        <td><span class="vfop-line-main">${escapeHTML(item.label)}</span></td>
        <td>${escapeHTML(item.value)}</td>
        <td>${sourceTag(item.source)}</td>
        <td>${escapeHTML(item.detail)}</td>
      </tr>
    `).join("");
  }

  function renderActions(workspace) {
    renderAcoes(workspace.actions);
  }

  function renderAcoes(acoes) {
    const el = document.getElementById("vfop-action-body");
    if (!el) return;

    const toneMap = {
      "Alta": "crit", "Media": "warn",
      "OK": "ok", "Baixa": "info"
    };

    const emojiMap = {
      "crit": "⚠", "warn": "◉",
      "ok": "✓", "info": "ℹ"
    };

    const normalized = (acoes || []).map((a) => ({
      acao: a.acao || a.title || "",
      prioridade: a.prioridade || a.priority || "",
      motivo: a.motivo || a.reason || "",
      fonte: a.fonte || sourceText(a.source || ""),
      status: a.status || "",
    }));

    if (!normalized.length) {
      el.innerHTML = `<div style="padding:14px;font-size:13px;
        color:#8c96a6;">Sem ações pendentes.</div>`;
      return;
    }

    el.innerHTML = `<div class="vfop-alerts"
                        style="padding:14px;">` +
      normalized.map(a => {
        const tone = toneMap[a.prioridade] || "info";
        const icon = emojiMap[tone];
        const concluido = (a.status || "").toLowerCase()
          .includes("conclu");
        if (concluido) return "";
        return `
          <div class="vfop-alert vfop-alert--${tone}">
            <div class="vfop-alert-icon">${icon}</div>
            <div>
              <div class="vfop-alert-title">
                ${escapeHTML(a.acao || "")}
              </div>
              <div class="vfop-alert-desc">
                ${escapeHTML(a.motivo || "")}
                ${a.fonte ? `<span style="margin-left:6px;">
                  <span class="vfop-source-tag
                    vfop-source-tag--${
                      (a.fonte||"").includes("Real") ? "real" :
                      (a.fonte||"").includes("TODO") ? "todo" :
                      "preview"
                    }">
                    ${escapeHTML(a.fonte)}
                  </span></span>` : ""}
              </div>
            </div>
            ${a.status && !concluido
              ? `<span class="vfop-alert-action"
                       style="font-size:11.5px;
                              color:#8c96a6;">
                   ${escapeHTML(a.status)}
                 </span>`
              : ""}
          </div>`;
      }).join("") + "</div>";
  }

  function renderHistory(workspace) {
    const target = document.getElementById("vfop-history");
    if (!target) return;
    target.innerHTML = workspace.history.map((item) => `
      <div class="vfop-timeline-item">
        <div class="vfop-timeline-date">${escapeHTML(item.date ? formatDateTime(item.date) : "TODO")}</div>
        <div class="vfop-timeline-main">
          <strong>${escapeHTML(item.title)}</strong>
          <span>${escapeHTML(item.detail)}</span>
        </div>
        ${sourceTag(item.source)}
      </div>
    `).join("");
  }

  function renderMetricRows() {}
  function renderMetrics() {}
  function renderSources() {}

  function setLoading(isLoading) {
    state.loading = isLoading;
    const btn = document.getElementById("vfop-refresh");
    if (btn) {
      btn.disabled = isLoading;
      const label = btn.querySelector("span");
      if (label) label.textContent = isLoading ? "Atualizando" : "Atualizar dados";
    }
    const select = document.getElementById("vfop-client-select");
    if (select) select.disabled = isLoading && !state.clientes.length;
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value == null || value === "" ? "--" : String(value);
  }

  function setStatus(id, label, tone) {
    const element = document.getElementById(id);
    if (!element) return;
    element.className = `vfop-status vfop-status--${tone || "neutral"}`;
    element.textContent = label || "--";
  }

  function statusBadge(label, tone) {
    const safeTone = ["success", "warning", "danger", "info", "muted", "neutral"].includes(tone) ? tone : "neutral";
    return `<span class="vfop-status vfop-status--${safeTone}">${escapeHTML(label || "--")}</span>`;
  }

  function sourceTag(source) {
    const kind = normalizeSourceKind(source);
    return `<span class="vfop-source-tag vfop-source-tag--${kind}">${escapeHTML(sourceText(kind))}</span>`;
  }

  function sourceText(source) {
    const kind = normalizeSourceKind(source);
    if (kind === "real") return "Real";
    if (kind === "todo") return "TODO backend";
    return "Preview";
  }

  function normalizeSourceKind(source) {
    const value = String(source || "").toLowerCase();
    if (value === "real" || value === "success") return "real";
    if (value === "todo" || value === "info") return "todo";
    return "preview";
  }

  function sourceKind(key) {
    const source = state.sources[key];
    if (!source) return "preview";
    return source.ok ? "real" : source.kind || "preview";
  }

  function sourceHint(key) {
    return sourceText(sourceKind(key));
  }

  function statusSpec(label, tone) {
    return { label, tone };
  }

  function getTokenState(token, source) {
    if (!source?.ok) {
      return {
        label: source?.status === 403 ? "Sem permissao" : "Nao validado",
        tone: "warning",
        detail: source?.status === 403 ? "Rota admin indisponivel para este usuario" : "Nao foi possivel validar tokens",
      };
    }
    if (!token) return { label: "Precisa grant", tone: "warning", detail: "Conectar em clientes.html" };
    return { label: "Grantado", tone: "success", detail: "Grant ML conectado" };
  }

  function getMainPending(workspace) {
    if (!workspace.hasBase) return "vincular base";
    if (!workspace.hasGrant) return "conectar grant";
    if (!workspace.hasDiagnosis) return "rodar diagnostico";
    return "sem pendencia critica";
  }

  function getDetectedChannels(workspace) {
    const channels = new Set();
    channels.add(marketplaceLabel(workspace.channel));
    workspace.basesDoCliente.forEach((base) => {
      const label = marketplaceLabel(base.marketplace || base.canal || "");
      if (label && label !== "Nao identificado") channels.add(label);
    });
    return [...channels].filter(Boolean);
  }

  function inferMarketplace(cliente, base, token) {
    const raw = cliente?.marketplace || cliente?.canal || cliente?.canal_principal
      || base?.marketplace || base?.canal || token?.marketplace || token?.canal;
    const text = String(raw || "").toLowerCase();
    if (text.includes("shopee")) return "shopee";
    if (text.includes("meli") || text.includes("mercado") || token) return "meli";
    return raw ? String(raw) : "meli";
  }

  function marketplaceLabel(value) {
    const text = String(value || "").toLowerCase();
    if (text === "meli" || text.includes("mercado")) return "Mercado Livre";
    if (text.includes("shopee")) return "Shopee";
    if (!value) return "Nao identificado";
    return String(value);
  }

  function normalizeCoverage(payload) {
    if (!payload) return null;
    return {
      clientesAtivos: Number(payload.clientes_ativos || payload.clientesAtivos || 0),
      clientesComBase: Number(payload.clientes_com_base || payload.clientesComBase || 0),
      clientesSemBase: Number(payload.clientes_sem_base || payload.clientesSemBase || 0),
      basesSemVinculo: Number(payload.bases_sem_vinculo || payload.basesSemVinculo || 0),
      porMarketplace: payload.por_marketplace || payload.porMarketplace || {},
    };
  }

  function buildBaseFromCliente(cliente, vinculoCliente) {
    const baseSlug = cliente?.base_slug || cliente?.baseSlug || vinculoCliente?.base_slug || vinculoCliente?.baseSlug;
    if (!baseSlug) return null;
    return {
      slug: baseSlug,
      nome: cliente?.base_nome || cliente?.baseNome || baseSlug,
      marketplace: cliente?.marketplace || vinculoCliente?.marketplace,
      vinculo: vinculoCliente || null,
    };
  }

  function matchesCliente(item, cliente) {
    if (!item || !cliente) return false;
    const clienteKeys = getClienteKeys(cliente);
    if (!clienteKeys.length) return false;
    return getItemClienteKeys(item).some((key) => clienteKeys.includes(key));
  }

  function getClienteKeys(cliente) {
    return unique([
      cliente?.id,
      cliente?.cliente_id,
      cliente?.clienteId,
      cliente?.slug,
      cliente?.cliente_slug,
      cliente?.clienteSlug,
      cliente?.nome,
      cliente?.name,
      cliente?.razao_social,
    ].map(slugKey).filter(Boolean));
  }

  function getItemClienteKeys(item) {
    return unique([
      item?.cliente_id,
      item?.clienteId,
      item?.cliente_slug,
      item?.clienteSlug,
      item?.cliente,
      item?.cliente_nome,
      item?.clienteNome,
      item?.nome_cliente,
      item?.nomeCliente,
      item?.client_slug,
      item?.clientSlug,
      item?.slug_cliente,
      item?.slugCliente,
      item?.conta,
      item?.seller_nickname,
      item?.sellerNickname,
      item?.vinculo?.cliente_id,
      item?.vinculo?.clienteId,
      item?.vinculo?.cliente_slug,
      item?.vinculo?.clienteSlug,
      item?.vinculo?.cliente_nome,
      item?.vinculo?.clienteNome,
      item?.cliente?.id,
      item?.cliente?.slug,
      item?.cliente?.nome,
    ].map(slugKey).filter(Boolean));
  }

  function getClienteName(cliente) {
    return String(cliente?.nome || cliente?.name || cliente?.razao_social || cliente?.slug || FALLBACK_CLIENTE.nome);
  }

  function getClienteSlug(cliente) {
    return String(cliente?.slug || cliente?.cliente_slug || cliente?.clienteSlug || slugify(getClienteName(cliente)));
  }

  function getClienteOptionKey(cliente) {
    const id = cliente?.id ?? cliente?.cliente_id ?? cliente?.clienteId;
    if (id != null && id !== "") return `id:${id}`;
    return `slug:${getClienteSlug(cliente)}`;
  }

  function getBaseName(base) {
    return String(base?.nome || base?.name || base?.slug || base?.base_slug || "Base vinculada");
  }

  function getBaseSlug(base) {
    return String(base?.slug || base?.base_slug || base?.baseSlug || "");
  }

  function getBaseStableKey(base) {
    return String(base?.id || base?.base_id || base?.slug || base?.base_slug || JSON.stringify(base || {}));
  }

  function getReportName(relatorio) {
    return String(relatorio?.nome || relatorio?.titulo || relatorio?.base_slug || relatorio?.cliente_slug || `Relatorio ${relatorio?.id || ""}`).trim();
  }

  function getSensitivePresence(row, keys) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(row || {}, key)) {
        const value = row[key];
        if (value === "[presente]" || value === "[removido]") return "Presente";
        if (value) return "Presente";
      }
    }
    return "Ausente";
  }

  function extractArray(data, keys) {
    if (Array.isArray(data)) return data;
    if (!isPlainObject(data)) return [];
    for (const key of keys) {
      if (Array.isArray(data[key])) return data[key];
    }
    for (const value of Object.values(data)) {
      if (Array.isArray(value)) return value;
    }
    return [];
  }

  function sanitizeSensitiveData(value, seen) {
    if (value == null) return value;
    if (typeof value !== "object") return value;

    const visited = seen || new WeakSet();
    if (visited.has(value)) return null;
    visited.add(value);

    if (Array.isArray(value)) return value.map((item) => sanitizeSensitiveData(item, visited));

    const output = {};
    Object.keys(value).forEach((key) => {
      if (isSensitiveKey(key)) {
        output[key] = value[key] ? "[presente]" : "";
        return;
      }
      output[key] = sanitizeSensitiveData(value[key], visited);
    });
    return output;
  }

  function isSensitiveKey(key) {
    const normalized = String(key || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (!normalized || normalized === "tokens") return false;
    return normalized === "authorization"
      || normalized === "token"
      || normalized === "accesstoken"
      || normalized === "refreshtoken"
      || normalized === "apikey"
      || normalized === "xapikey"
      || normalized === "password"
      || normalized === "senha"
      || normalized === "clientsecret"
      || normalized.endsWith("accesstoken")
      || normalized.endsWith("refreshtoken")
      || normalized.includes("authorization")
      || normalized.includes("secret");
  }

  function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
  }

  function unique(items) {
    return [...new Set(items)];
  }

  function uniqueBy(items, getKey) {
    const seen = new Set();
    const out = [];
    items.forEach((item) => {
      const key = getKey(item);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(item);
    });
    return out;
  }

  function slugKey(value) {
    const str = String(value ?? "").trim().toLowerCase();
    if (!str) return "";
    return str
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function slugify(value) {
    return slugKey(value) || "cliente";
  }

  function sortByRecent(a, b) {
    const dateA = getDateMs(a?.created_at || a?.createdAt || a?.updated_at || a?.updatedAt);
    const dateB = getDateMs(b?.created_at || b?.createdAt || b?.updated_at || b?.updatedAt);
    if (dateA !== dateB) return dateB - dateA;
    return Number(b?.id || 0) - Number(a?.id || 0);
  }

  function getDateMs(value) {
    const date = value ? new Date(value) : null;
    const ms = date ? date.getTime() : 0;
    return Number.isFinite(ms) ? ms : 0;
  }

  function getAgeDays(value) {
    const ms = getDateMs(value);
    if (!ms) return null;
    return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
  }

  function firstFiniteNumber(values) {
    for (const value of values) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function normalizePercent(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.abs(n) <= 1 ? n * 100 : n;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function getCurrentMonthRef() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  }

  function formatDateTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "--";
    return date.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function escapeHTML(value) {
    const div = document.createElement("div");
    div.textContent = value == null ? "" : String(value);
    return div.innerHTML;
  }

  function escapeJsString(value) {
    return String(value ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/[\r\n]+/g, " ");
  }
})();
