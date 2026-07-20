/* =============================================================================
   Anúncios Meli — lógica do módulo (JavaScript puro, sem dependências)
   Central operacional + Agente Otimizador Textual IA.

   Endpoints consumidos:
     GET   /anuncios-meli/clientes
     POST  /anuncios-meli/sync
     GET   /anuncios-meli/resumo?clienteSlug=
     GET   /anuncios-meli?clienteSlug=...
     GET   /anuncios-meli/:itemId?clienteSlug=
     PATCH /anuncios-meli/:itemId/revisao
     POST  /anuncios-meli/:itemId/otimizar         (admin)
     GET   /anuncios-meli/:itemId/otimizacoes      (admin)
     PATCH /anuncios-meli/otimizacoes/:id/aprovar  (admin)
   ========================================================================== */
(function () {
  "use strict";

  var API_BASE = "https://venforce-server.onrender.com";

  // Estado global do módulo
  var AM = {
    token: null,
    clientes: [],
    clienteAtual: null,
    resumo: null,
    anuncios: [],
    paginacao: { page: 1, limit: 24, total: 0, totalPaginas: 1 },
    filtros: { q: "", status: "", filtro: "" },
    buscaTimer: null,
    carregandoCatalogo: false,
    // Estado do detalhe aberto:
    detalheAtual: null,    // { anuncio, descricao }
    otimizacoes: {         // últimas otimizações por tipo (rascunho ou aprovada)
      seo: null,
      descricao: null,
      ficha_tecnica: null,
    },
  };

  // ===========================================================================
  // Helpers
  // ===========================================================================
  function el(id) { return document.getElementById(id); }

  function escapeHtml(v) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatMoeda(v, moeda) {
    if (v === null || v === undefined || v === "") return "—";
    var n = Number(v); if (isNaN(n)) return "—";
    var s = moeda === "USD" ? "US$" : "R$";
    return s + " " + n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatData(iso) {
    if (!iso) return "nunca";
    var d = new Date(iso); if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("pt-BR") + " " +
      d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  function statusInfo(s) {
    switch (s) {
      case "active":       return { label: "Ativo", classe: "is-success" };
      case "paused":       return { label: "Pausado", classe: "is-warning" };
      case "closed":       return { label: "Encerrado", classe: "is-danger" };
      case "under_review": return { label: "Em revisão", classe: "is-info" };
      default:             return { label: s || "—", classe: "is-neutral" };
    }
  }

  function scoreClasse(s) {
    if (s >= 80) return "is-success";
    if (s >= 60) return "is-warning";
    return "is-danger";
  }

  function tryParseJSON(v, fallback) {
    if (Array.isArray(v) || (v && typeof v === "object")) return v;
    if (!v) return fallback;
    try { return JSON.parse(v); } catch (e) { return fallback; }
  }

  function copiarTexto(texto, mensagem) {
    var txt = String(texto || "");
    if (!txt) { toast("Nada para copiar."); return; }
    try {
      navigator.clipboard.writeText(txt).then(
        function () { toast(mensagem || "Copiado!"); },
        function () { copiarFallback(txt, mensagem); }
      );
    } catch (e) {
      copiarFallback(txt, mensagem);
    }
  }

  function copiarFallback(txt, mensagem) {
    var ta = document.createElement("textarea");
    ta.value = txt;
    ta.className = "am-copy-fallback";
    ta.setAttribute("aria-hidden", "true");
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast(mensagem || "Copiado!"); }
    catch (e) { toast("Não consegui copiar."); }
    document.body.removeChild(ta);
  }

  function toast(msg, tipo) {
    var stack = el("am-toast-stack");
    if (!stack) return;
    var t = document.createElement("div");
    t.className = "vf-toast " + (tipo || "is-info");
    t.setAttribute("role", "status");
    t.innerHTML = '<div class="vf-toast__content"><p class="vf-toast__description">' +
      escapeHtml(msg) + "</p></div>";
    stack.appendChild(t);
    setTimeout(function () {
      if (t.parentNode) t.parentNode.removeChild(t);
    }, 3200);
  }

  function estadoHtml(tipo, titulo, descricao) {
    if (tipo === "loading") {
      return '<div class="vf-loading-state" aria-live="polite">' +
        '<span class="vf-spinner" aria-hidden="true"></span><span>' +
        escapeHtml(titulo) + "</span></div>";
    }
    var erro = tipo === "error";
    return '<div class="vf-empty"' + (erro ? ' role="alert"' : "") + ">" +
      (erro ? '<div class="vf-empty__icon is-danger" aria-hidden="true">!</div>' : "") +
      '<p class="vf-empty__title">' + escapeHtml(titulo) + "</p>" +
      (descricao ? '<p class="vf-empty__description">' + escapeHtml(descricao) + "</p>" : "") +
      "</div>";
  }

  function aplicarLargurasScore(container) {
    if (!container) return;
    var barras = container.querySelectorAll(".vf-progress__bar[data-score]");
    for (var i = 0; i < barras.length; i++) {
      var score = Number(barras[i].getAttribute("data-score"));
      barras[i].style.width = Math.max(0, Math.min(100, isNaN(score) ? 0 : score)) + "%";
    }
  }

  function atualizarIndicadorFiltros() {
    var indicador = el("am-filtros-ativos");
    if (!indicador) return;
    var total = [AM.filtros.q, AM.filtros.status, AM.filtros.filtro].filter(Boolean).length;
    indicador.textContent = total === 1 ? "1 filtro ativo" : total + " filtros ativos";
    indicador.classList.toggle("am-hidden", total === 0);
  }

  // ===========================================================================
  // Camada HTTP
  // ===========================================================================
  function api(path, opts) {
    opts = opts || {};
    var headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + (AM.token || ""),
    };
    if (opts.headers) for (var k in opts.headers) headers[k] = opts.headers[k];
    return fetch(API_BASE + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; })
          .then(function (data) { return { status: r.status, data: data }; });
      })
      .catch(function () {
        return { status: 0, data: { ok: false, motivo: "Falha de conexão." } };
      });
  }

  // ===========================================================================
  // Inicialização e bind de eventos fixos
  // ===========================================================================
  function init() {
    AM.token = localStorage.getItem("vf-token");
    if (!AM.token) {
      el("am-clientes-container").innerHTML =
        estadoHtml("error", "Sessão não encontrada", "Faça login no portal para usar os Anúncios ML.");
      return;
    }
    if (typeof window.initLayout === "function") window.initLayout();
    bindEventosFixos();
    carregarClientes();
  }

  function bindEventosFixos() {
    el("am-busca-cliente").addEventListener("input", function (e) { renderClientes(e.target.value); });
    el("am-voltar").addEventListener("click", function () {
      AM.clienteAtual = null;
      AM.resumo = null;
      el("am-view-hud").classList.add("am-hidden");
      el("am-view-clientes").classList.remove("am-hidden");
      carregarClientes();
    });
    el("am-busca").addEventListener("input", function (e) {
      AM.filtros.q = e.target.value;
      atualizarIndicadorFiltros();
      if (AM.buscaTimer) clearTimeout(AM.buscaTimer);
      AM.buscaTimer = setTimeout(function () { AM.paginacao.page = 1; carregarAnuncios(); }, 350);
    });
    el("am-filtro-status").addEventListener("change", function (e) {
      AM.filtros.status = e.target.value; AM.paginacao.page = 1; atualizarIndicadorFiltros(); carregarAnuncios();
    });
    el("am-filtro-problema").addEventListener("change", function (e) {
      AM.filtros.filtro = e.target.value; AM.paginacao.page = 1; atualizarIndicadorFiltros(); carregarAnuncios();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") fecharDetalhe();
    });
  }

  // ===========================================================================
  // VIEW 1 — Seleção de cliente
  // ===========================================================================
  function carregarClientes() {
    var box = el("am-clientes-container");
    box.innerHTML = estadoHtml("loading", "Carregando clientes…");

    api("/anuncios-meli/clientes").then(function (r) {
      if (!r.data || !r.data.ok) {
        box.innerHTML = estadoHtml("error", "Não foi possível carregar",
          (r.data && r.data.motivo) || "Erro ao buscar clientes.");
        return;
      }
      AM.clientes = r.data.clientes || [];
      renderClientes("");
    });
  }

  function renderClientes(filtroTexto) {
    var box = el("am-clientes-container");
    var termo = (filtroTexto || "").trim().toLowerCase();
    var lista = AM.clientes.filter(function (c) {
      if (!termo) return true;
      return (c.nome || "").toLowerCase().indexOf(termo) !== -1 ||
             (c.slug || "").toLowerCase().indexOf(termo) !== -1;
    });

    if (!lista.length) {
      box.innerHTML = estadoHtml("empty", "Nenhum cliente encontrado",
        AM.clientes.length ? "Tente outro termo de busca." : "Não há clientes disponíveis para esta conta.");
      return;
    }

    var html = '<div class="am-clientes-grid">';
    lista.forEach(function (c) {
      var conectado = c.mlConectado;
      html += '<button type="button" class="am-cliente-card vf-card vf-card--interactive" data-slug="' + escapeHtml(c.slug) +
        '" data-nome="' + escapeHtml(c.nome) + '" aria-label="Abrir anúncios de ' + escapeHtml(c.nome) + '">' +
        '<span class="am-cliente-card__top"><span class="am-cliente-card__nome">' + escapeHtml(c.nome) + "</span>" +
        '<span class="am-cliente-card__abrir" aria-hidden="true">Abrir →</span></span>' +
        (c.slug ? '<span class="am-cliente-card__slug vf-mono">' + escapeHtml(c.slug) + "</span>" : "") +
        '<div class="am-cliente-card__meta">' +
        '<span class="vf-status ' + (conectado ? "is-success" : "is-danger") + '">' +
        (conectado ? "ML conectado" : "Sem conexão ML") + "</span>" +
        '<span class="vf-tag is-neutral">' + (c.totalAnuncios || 0) + " anúncios</span>" +
        "</div></button>";
    });
    html += "</div>";
    box.innerHTML = html;

    var cards = box.querySelectorAll(".am-cliente-card");
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener("click", function () {
        selecionarCliente(this.getAttribute("data-slug"), this.getAttribute("data-nome"));
      });
    }
  }

  function selecionarCliente(slug, nome) {
    AM.clienteAtual = { slug: slug, nome: nome };
    AM.resumo = null;
    AM.paginacao.page = 1;
    AM.filtros = { q: "", status: "", filtro: "" };
    el("am-busca").value = "";
    el("am-filtro-status").value = "";
    el("am-filtro-problema").value = "";
    atualizarIndicadorFiltros();
    el("am-view-clientes").classList.add("am-hidden");
    el("am-view-hud").classList.remove("am-hidden");
    renderHudHeader();
    carregarResumo();
    carregarAnuncios();
  }

  // ===========================================================================
  // VIEW 2 — HUD do cliente
  // ===========================================================================
  function renderHudHeader() {
    var c = AM.clienteAtual;
    var resumo = AM.resumo;
    var clienteCompleto = AM.clientes.find(function (item) { return item.slug === c.slug; }) || {};
    var subInfo = resumo
      ? '<span>Última sincronização: <strong>' + formatData(resumo.ultimaSync) + "</strong></span>" +
        '<span>Total sincronizado: <strong>' + (resumo.total || 0) + " anúncios</strong></span>"
      : '<span class="vf-status is-info">Carregando resumo…</span>';

    el("am-hud-top").innerHTML =
      '<div class="am-cliente-contexto vf-card">' +
        '<div class="am-cliente-contexto__info">' +
          '<div class="am-cliente-contexto__title-row"><div>' +
            '<p class="am-cliente-contexto__eyebrow">Cliente selecionado</p>' +
            '<h2 id="am-cliente-contexto-titulo">' + escapeHtml(c.nome) + "</h2></div>" +
            '<span class="vf-status ' + (clienteCompleto.mlConectado ? "is-success" : "is-danger") + '">' +
              (clienteCompleto.mlConectado ? "ML conectado" : "Sem conexão ML") + "</span></div>" +
          '<div class="am-hud-sub">' + subInfo + "</div>" +
        "</div>" +
        '<div class="am-sync-area">' +
          '<p class="am-sync-area__description"><strong>Atualizar novos</strong> busca inclusões recentes. <strong>Sincronização completa</strong> revisa todo o catálogo.</p>' +
          '<div class="am-hud-actions">' +
            '<button type="button" class="vf-btn vf-btn--secondary" id="am-sync-novos">Atualizar novos</button>' +
            '<button type="button" class="vf-btn vf-btn--primary" id="am-sync-completo">Sincronização completa</button>' +
          "</div>" +
        "</div>" +
      "</div>";

    el("am-sync-novos").addEventListener("click", function () { sincronizar("novos"); });
    el("am-sync-completo").addEventListener("click", function () { sincronizar("completo"); });
  }

  function carregarResumo() {
    if (!AM.clienteAtual) return;
    api("/anuncios-meli/resumo?clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug))
      .then(function (r) {
        if (r.data && r.data.ok) {
          AM.resumo = r.data.resumo;
          renderHudHeader();
          renderResumo();
        }
      });
  }

  function renderResumo() {
    var r = AM.resumo || {};
    var cards = [
      { label: "Total de anúncios", valor: r.total || 0, estado: "neutral", meta: "Catálogo sincronizado" },
      { label: "Ativos", valor: r.ativos || 0, estado: "success", meta: "Disponíveis no ML" },
      { label: "Pausados", valor: r.pausados || 0, estado: r.pausados ? "warning" : "neutral", meta: "Pedem acompanhamento" },
      { label: "Fotos insuficientes", valor: r.fotosInsuficientes || 0, estado: r.fotosInsuficientes ? "warning" : "success", meta: "Menos de 3 fotos" },
      { label: "Sem SKU", valor: r.semSku || 0, estado: r.semSku ? "warning" : "success", meta: "Sem identificação interna" },
      { label: "Score baixo", valor: r.scoreBaixo || 0, estado: r.scoreBaixo ? "danger" : "success", meta: "Abaixo de 60 pontos" },
      { label: "Mercado Full", valor: r.full || 0, estado: "neutral", meta: "Com logística Full" },
      { label: "Score médio", valor: r.scoreMedio || 0,
        estado: r.scoreMedio >= 80 ? "success" : r.scoreMedio >= 60 ? "warning" : "danger", meta: "De 100 pontos" },
    ];
    var html = "";
    cards.forEach(function (c) {
      html += '<article class="vf-kpi am-kpi is-' + c.estado + '">' +
        '<span class="vf-kpi__label">' + c.label + "</span>" +
        '<strong class="vf-kpi__value">' + c.valor + "</strong>" +
        '<span class="vf-kpi__foot is-' + c.estado + '">' + c.meta + "</span></article>";
    });
    el("am-resumo").innerHTML = html;
  }

  function carregarAnuncios() {
    if (!AM.clienteAtual || AM.carregandoCatalogo) return;
    AM.carregandoCatalogo = true;
    var box = el("am-catalogo-container");
    box.innerHTML = estadoHtml("loading", "Carregando anúncios…");

    var qs = "clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug) +
             "&page=" + AM.paginacao.page + "&limit=" + AM.paginacao.limit;
    if (AM.filtros.q) qs += "&q=" + encodeURIComponent(AM.filtros.q);
    if (AM.filtros.status) qs += "&status=" + encodeURIComponent(AM.filtros.status);
    if (AM.filtros.filtro) qs += "&filtro=" + encodeURIComponent(AM.filtros.filtro);

    api("/anuncios-meli?" + qs).then(function (r) {
      AM.carregandoCatalogo = false;
      if (!r.data || !r.data.ok) {
        box.innerHTML = estadoHtml("error", "Erro ao carregar",
          (r.data && r.data.motivo) || "Tente novamente.");
        return;
      }
      AM.anuncios = r.data.anuncios || [];
      AM.paginacao = r.data.paginacao || AM.paginacao;
      renderCatalogo();
    });
  }

  function renderCatalogo() {
    var box = el("am-catalogo-container");
    if (!AM.anuncios.length) {
      var temFiltro = AM.filtros.q || AM.filtros.status || AM.filtros.filtro;
      box.innerHTML = estadoHtml("empty",
        temFiltro ? "Nenhum anúncio para esse filtro" : "Nenhum anúncio sincronizado",
        temFiltro ? "Ajuste a busca ou os filtros acima."
          : 'Use o botão "Sincronização completa" para trazer os anúncios deste cliente.');
      return;
    }

    var html = '<div class="am-catalogo" aria-label="Lista de anúncios">';
    AM.anuncios.forEach(function (a) { html += cardAnuncioHtml(a); });
    html += "</div>" + paginacaoHtml();
    box.innerHTML = html;

    aplicarLargurasScore(box);

    var cards = box.querySelectorAll(".am-card[data-item]");
    for (var i = 0; i < cards.length; i++) {
      cards[i].querySelector(".am-card__acao").addEventListener("click", function (e) {
        abrirDetalhe(this.closest(".am-card").getAttribute("data-item"), this);
      });
    }

    var btnPrev = el("am-pag-prev"), btnNext = el("am-pag-next");
    if (btnPrev) btnPrev.addEventListener("click", function () {
      if (AM.paginacao.page > 1) { AM.paginacao.page--; carregarAnuncios(); window.scrollTo({ top: 0, behavior: "smooth" }); }
    });
    if (btnNext) btnNext.addEventListener("click", function () {
      if (AM.paginacao.page < AM.paginacao.totalPaginas) { AM.paginacao.page++; carregarAnuncios(); window.scrollTo({ top: 0, behavior: "smooth" }); }
    });
  }

  function cardAnuncioHtml(a) {
    var st = statusInfo(a.status);
    var score = a.score_venforce;
    var scoreTxt = score === null || score === undefined ? "—" : score;
    var badges = '<span class="vf-status ' + st.classe + '">' + st.label + "</span>";
    if (a.is_full) badges += '<span class="vf-tag is-info">Full</span>';
    if ((a.pictures_count || 0) < 3) badges += '<span class="vf-tag is-warning">' + (a.pictures_count || 0) + "/3 fotos</span>";
    if (!a.sku) badges += '<span class="vf-tag is-danger">Sem SKU</span>';
    if (a.revisado) badges += '<span class="vf-tag is-success">Revisado</span>';

    var img = a.thumbnail
      ? '<img src="' + escapeHtml(a.thumbnail) + '" alt="Imagem do anúncio ' + escapeHtml(a.titulo || a.item_id) + '" loading="lazy" />'
      : '<span class="am-card__img-vazia">Sem imagem</span>';

    return '<article class="am-card vf-card" data-item="' + escapeHtml(a.item_id) + '">' +
      '<div class="am-card__img">' + img +
      '<span class="am-card__score vf-tag ' + scoreClasse(score) + '">Score ' + scoreTxt + "/100</span></div>" +
      '<div class="am-card__body">' +
      '<h3 class="am-card__titulo">' + escapeHtml(a.titulo || "(sem título)") + "</h3>" +
      '<div class="am-card__ids"><span class="vf-mono">' + escapeHtml(a.item_id) + "</span>" +
      '<span>SKU <span class="vf-mono">' + escapeHtml(a.sku || "—") + "</span></span></div>" +
      '<div class="am-card__metricas"><span><small>Preço</small><strong>' + formatMoeda(a.preco, a.moeda) + "</strong></span>" +
      '<span><small>Estoque</small><strong>' + (a.estoque != null ? a.estoque : "—") + "</strong></span>" +
      '<span><small>Vendidos</small><strong>' + (a.vendidos != null ? a.vendidos : "—") + "</strong></span></div>" +
      '<div class="am-card__score-row"><span>Score VenForce</span><strong class="' + scoreClasse(score) + '">' + scoreTxt + "/100</strong></div>" +
      '<div class="vf-progress vf-progress--sm" aria-label="Score VenForce ' + scoreTxt + ' de 100">' +
        '<div class="vf-progress__bar ' + scoreClasse(score) + '" data-score="' + (score || 0) + '"></div></div>' +
      '<div class="am-card__badges">' + badges + "</div>" +
      '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm am-card__acao">Ver detalhes</button>' +
      "</div></article>";
  }

  function paginacaoHtml() {
    var p = AM.paginacao;
    if (p.totalPaginas <= 1) return '<nav class="vf-pagination am-paginacao" aria-label="Paginação do catálogo"><span class="vf-pagination__info">' + p.total + " anúncio(s)</span></nav>";
    return '<nav class="vf-pagination am-paginacao" aria-label="Paginação do catálogo">' +
      '<span class="vf-pagination__info">Página ' + p.page + " de " + p.totalPaginas + " · " + p.total + " anúncios</span>" +
      '<div class="vf-pagination__actions">' +
      '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" id="am-pag-prev"' + (p.page <= 1 ? " disabled" : "") + ">← Anterior</button>" +
      '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" id="am-pag-next"' + (p.page >= p.totalPaginas ? " disabled" : "") + ">Próxima →</button></div>" +
      "</nav>";
  }

  // ===========================================================================
  // Detalhe (drawer)
  // ===========================================================================
  var detalheFocusAnterior = null;

  function abrirDetalhe(itemId, trigger) {
    AM.detalheAtual = null;
    AM.otimizacoes = { seo: null, descricao: null, ficha_tecnica: null };
    detalheFocusAnterior = trigger || document.activeElement;

    var backdrop = document.createElement("div");
    backdrop.className = "am-modal-overlay vf-drawer-backdrop";
    backdrop.id = "am-modal-overlay";

    var drawer = document.createElement("section");
    drawer.className = "am-drawer vf-drawer vf-drawer--lg";
    drawer.id = "am-drawer";
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("aria-labelledby", "am-drawer-titulo");
    drawer.innerHTML = '<header class="vf-drawer__header">' +
      '<h2 class="vf-drawer__title am-drawer__titulo" id="am-drawer-titulo">Detalhe do anúncio</h2>' +
      '<button type="button" class="vf-btn vf-btn--ghost vf-btn--icon vf-btn--sm" id="am-drawer-close" aria-label="Fechar detalhes">×</button></header>' +
      '<div class="am-drawer__body vf-drawer__body" id="am-drawer-body">' +
      estadoHtml("loading", "Carregando detalhes…") + '</div><footer class="vf-drawer__footer">' +
      '<button type="button" class="vf-btn vf-btn--secondary" id="am-drawer-footer-close">Fechar</button></footer>';
    document.body.appendChild(backdrop);
    document.body.appendChild(drawer);
    document.body.classList.add("vf-no-scroll");
    backdrop.classList.add("is-open");
    drawer.classList.add("is-open");

    backdrop.addEventListener("click", fecharDetalhe);
    el("am-drawer-close").addEventListener("click", fecharDetalhe);
    el("am-drawer-footer-close").addEventListener("click", fecharDetalhe);
    el("am-drawer-close").focus();

    var url = "/anuncios-meli/" + encodeURIComponent(itemId) +
              "?clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug);

    api(url).then(function (r) {
      var body = el("am-drawer-body");
      if (!body) return;
      if (!r.data || !r.data.ok) {
        body.innerHTML = estadoHtml("error", "Erro ao carregar detalhes",
          (r.data && r.data.motivo) || "Não foi possível carregar.");
        return;
      }
      AM.detalheAtual = { anuncio: r.data.anuncio, descricao: r.data.descricao || null };
      renderDetalhe();
      carregarHistoricoOtimizacoes(r.data.anuncio.item_id);
    });
  }

  function fecharDetalhe() {
    var backdrop = el("am-modal-overlay");
    var drawer = el("am-drawer");
    if (!backdrop && !drawer) return;
    if (backdrop) backdrop.parentNode.removeChild(backdrop);
    if (drawer) drawer.parentNode.removeChild(drawer);
    document.body.classList.remove("vf-no-scroll");
    if (detalheFocusAnterior && typeof detalheFocusAnterior.focus === "function") detalheFocusAnterior.focus();
    detalheFocusAnterior = null;
  }

  function renderDetalhe() {
    var a = AM.detalheAtual.anuncio;
    var body = el("am-drawer-body");
    var st = statusInfo(a.status);
    var pics = tryParseJSON(a.pictures_json, []);
    var attrs = tryParseJSON(a.attributes_json, []);

    el("am-drawer-titulo").textContent = a.titulo || "Detalhe do anúncio";

    var html = '<div class="am-tabs vf-tabs" role="tablist" aria-label="Detalhes do anúncio">' +
      tabHtml("ia", "Otimização IA", true) +
      tabHtml("geral", "Visão geral", false) +
      tabHtml("ficha", "Ficha técnica", false) +
      tabHtml("fotos", "Fotos", false) +
      tabHtml("desc", "Descrição", false) + "</div>";

    html += painelHtml("ia", painelOtimizacaoHtml(), true);

    var geral = (a.thumbnail ? '<img class="am-detalhe-img" src="' + escapeHtml(a.thumbnail) +
      '" alt="Imagem do anúncio ' + escapeHtml(a.titulo || a.item_id) + '" />' : "") +
      '<section class="am-bloco vf-card"><div class="vf-card__body"><h3 class="am-bloco__title">' +
      escapeHtml(a.titulo || "(sem título)") + '</h3><dl class="am-definition-list">' +
      kv("MLB", '<span class="vf-mono">' + escapeHtml(a.item_id) + "</span>") +
      kv("SKU", '<span class="vf-mono">' + escapeHtml(a.sku || "—") + "</span>") +
      kv("Modelo", escapeHtml(a.modelo || "—")) + kv("Marca", escapeHtml(a.marca || "—")) +
      kv("Status", '<span class="vf-status ' + st.classe + '">' + st.label + "</span>") +
      kv("Preço", formatMoeda(a.preco, a.moeda)) +
      (a.preco_original ? kv("Preço original", formatMoeda(a.preco_original, a.moeda)) : "") +
      kv("Estoque", a.estoque != null ? a.estoque : "—") + kv("Vendidos", a.vendidos != null ? a.vendidos : "—") +
      kv("Categoria", escapeHtml(a.category_id || "—")) + kv("Tipo de anúncio", escapeHtml(a.listing_type_id || "—")) +
      kv("Logística", escapeHtml(a.is_full ? "Mercado Full" : a.logistic_type || "—")) +
      "</dl></div></section>" +
      '<section class="am-bloco vf-card"><div class="vf-card__body"><h3 class="am-bloco__title">Score VenForce</h3>' +
      '<div class="am-score-summary"><strong class="am-score-summary__value ' + scoreClasse(a.score_venforce) + '">' +
      (a.score_venforce || 0) + '</strong><span>/ 100</span></div>' +
      '<div class="vf-progress"><div class="vf-progress__bar ' + scoreClasse(a.score_venforce) + '" data-score="' +
      (a.score_venforce || 0) + '"></div></div>' +
      '<p class="am-score-summary__meta">Principal ponto: <strong>' + escapeHtml(a.score_motivo || "—") +
      "</strong></p></div></section>" +
      '<section class="am-bloco vf-card"><div class="vf-card__body"><h3 class="am-bloco__title">Ações</h3><div class="vf-cluster">' +
      (a.permalink ? '<a class="vf-btn vf-btn--secondary vf-btn--sm" href="' + escapeHtml(a.permalink) +
        '" target="_blank" rel="noopener">Abrir no Mercado Livre</a>' : "") +
      '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" id="am-btn-revisar">' +
      (a.revisado ? "Desmarcar revisão" : "Marcar como revisado") + "</button></div></div></section>";
    html += painelHtml("geral", geral, false);

    var ficha = "";
    if (!attrs.length) {
      ficha = estadoHtml("empty", "Nenhum atributo retornado", "O anúncio não possui ficha técnica disponível.");
    } else {
      var preenchidos = attrs.filter(function (x) { return x && x.value; });
      var vazios = attrs.filter(function (x) { return !x || !x.value; });
      ficha = '<section class="am-bloco vf-card"><div class="vf-card__body"><h3 class="am-bloco__title">Preenchidos (' +
        preenchidos.length + ')</h3><div class="am-attr-list">';
      if (!preenchidos.length) ficha += '<div class="am-attr"><span>—</span></div>';
      preenchidos.forEach(function (x) {
        ficha += '<div class="am-attr"><span>' + escapeHtml(x.name || x.id) + "</span><strong>" + escapeHtml(x.value) + "</strong></div>";
      });
      ficha += '</div></div></section><section class="am-bloco vf-card"><div class="vf-card__body"><h3 class="am-bloco__title">Faltando (' +
        vazios.length + ')</h3><div class="am-attr-list">';
      if (!vazios.length) ficha += '<div class="am-attr"><span>Todos os campos estão preenchidos.</span></div>';
      vazios.forEach(function (x) {
        ficha += '<div class="am-attr am-attr--vazio"><span>' + escapeHtml(x.name || x.id) + "</span><strong>Vazio</strong></div>";
      });
      ficha += "</div></div></section>";
    }
    html += painelHtml("ficha", ficha, false);

    var fotos = '<section class="am-bloco vf-card"><div class="vf-card__body"><h3 class="am-bloco__title">Fotos (' + pics.length + ")</h3>";
    if (pics.length < 3) fotos += '<div class="vf-banner vf-banner--compact is-warning"><div class="vf-banner__content"><p class="vf-banner__description">Recomendado ter pelo menos 3 fotos. Este anúncio tem ' + pics.length + ".</p></div></div>";
    if (!pics.length) fotos += estadoHtml("empty", "Sem fotos", "Nenhuma imagem foi retornada para este anúncio.");
    else {
      fotos += '<div class="am-thumbs">';
      pics.forEach(function (u, index) {
        fotos += '<img src="' + escapeHtml(u) + '" alt="Foto ' + (index + 1) + ' do anúncio" loading="lazy" />';
      });
      fotos += "</div>";
    }
    fotos += "</div></section>";
    html += painelHtml("fotos", fotos, false);

    var desc = AM.detalheAtual.descricao;
    var descricao = '<section class="am-bloco vf-card"><div class="vf-card__body"><h3 class="am-bloco__title">Descrição atual</h3>';
    if (desc && desc.trim()) descricao += '<div class="am-desc">' + escapeHtml(desc.trim()) + "</div>";
    else descricao += '<div class="vf-banner vf-banner--compact is-warning"><div class="vf-banner__content"><p class="vf-banner__description">Este anúncio não tem descrição preenchida.</p></div></div>';
    descricao += "</div></section>";
    html += painelHtml("desc", descricao, false);

    body.innerHTML = html;
    aplicarLargurasScore(body);
    bindAbas();
    bindDetalheGeral();
    bindPainelOtimizacao();
  }

  function tabHtml(id, label, ativo) {
    return '<button type="button" class="am-tab vf-tab' + (ativo ? " is-active" : "") + '" id="am-tab-' + id +
      '" role="tab" aria-selected="' + (ativo ? "true" : "false") + '" aria-controls="am-panel-' + id +
      '" tabindex="' + (ativo ? "0" : "-1") + '" data-tab="' + id + '">' + label + "</button>";
  }

  function painelHtml(id, conteudo, ativo) {
    return '<div class="am-tab-panel' + (ativo ? " is-active" : "") + '" id="am-panel-' + id +
      '" role="tabpanel" aria-labelledby="am-tab-' + id + '" data-panel="' + id + '"' +
      (ativo ? "" : " hidden") + ">" + conteudo + "</div>";
  }

  function kv(rotulo, valor) {
    return '<div class="am-kv"><dt>' + escapeHtml(rotulo) + "</dt><dd>" + valor + "</dd></div>";
  }

  function ativarAba(tab, deveFocar) {
    var body = el("am-drawer-body");
    if (!body || !tab) return;
    var tabs = body.querySelectorAll(".am-tab");
    var panels = body.querySelectorAll(".am-tab-panel");
    var alvo = tab.getAttribute("data-tab");
    for (var i = 0; i < tabs.length; i++) {
      var ativa = tabs[i] === tab;
      tabs[i].classList.toggle("is-active", ativa);
      tabs[i].setAttribute("aria-selected", ativa ? "true" : "false");
      tabs[i].setAttribute("tabindex", ativa ? "0" : "-1");
    }
    for (var j = 0; j < panels.length; j++) {
      var painelAtivo = panels[j].getAttribute("data-panel") === alvo;
      panels[j].classList.toggle("is-active", painelAtivo);
      panels[j].hidden = !painelAtivo;
    }
    if (deveFocar) tab.focus();
  }

  function bindAbas() {
    var body = el("am-drawer-body");
    var tabs = body.querySelectorAll(".am-tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () { ativarAba(this, false); });
      tabs[i].addEventListener("keydown", function (e) {
        var lista = Array.prototype.slice.call(tabs);
        var atual = lista.indexOf(this);
        var proximo = atual;
        if (e.key === "ArrowRight") proximo = (atual + 1) % lista.length;
        else if (e.key === "ArrowLeft") proximo = (atual - 1 + lista.length) % lista.length;
        else if (e.key === "Home") proximo = 0;
        else if (e.key === "End") proximo = lista.length - 1;
        else return;
        e.preventDefault();
        ativarAba(lista[proximo], true);
      });
    }
  }

  function bindDetalheGeral() {
    var btnRev = el("am-btn-revisar");
    if (!btnRev) return;
    btnRev.addEventListener("click", function () {
      var a = AM.detalheAtual.anuncio;
      var novo = !a.revisado;
      btnRev.disabled = true; btnRev.textContent = "Salvando...";
      api("/anuncios-meli/" + encodeURIComponent(a.item_id) + "/revisao", {
        method: "PATCH",
        body: { clienteSlug: AM.clienteAtual.slug, revisado: novo },
      }).then(function (r) {
        btnRev.disabled = false;
        if (r.data && r.data.ok) {
          a.revisado = novo;
          btnRev.textContent = novo ? "Desmarcar revisão" : "Marcar como revisado";
          carregarAnuncios();
        } else { btnRev.textContent = "Erro — tentar de novo"; }
      });
    });
  }

  // ===========================================================================
  // PAINEL Otimização IA — HTML + comportamento
  // ===========================================================================
  function painelOtimizacaoHtml() {
    var a = AM.detalheAtual.anuncio;
    var descAtual = AM.detalheAtual.descricao || "";

    var seoSec = otimSecaoHtml({
      id: "seo",
      icon: "S",
      titulo: "SEO — Título e Modelo",
      sub: "Otimização do título e do campo modelo para busca no Mercado Livre.",
      conteudoAtual: seoAtualHtml(a),
      conteudoSugerido: seoSugeridoHtml(null),
      botaoGerar: "Gerar SEO",
    });

    var descSec = otimSecaoHtml({
      id: "descricao",
      icon: "D",
      titulo: "Descrição",
      sub: "Reescreve a descrição em blocos padronizados para Mercado Livre.",
      conteudoAtual: descricaoAtualHtml(descAtual),
      conteudoSugerido: descricaoSugeridaHtml(null),
      botaoGerar: "Gerar descrição",
    });

    var fichaSec = otimSecaoHtml({
      id: "ficha_tecnica",
      icon: "F",
      titulo: "Ficha Técnica",
      sub: "Identifica atributos faltantes ou inconsistentes e sugere preenchimento.",
      conteudoAtual: fichaAtualHtml(tryParseJSON(a.attributes_json, [])),
      conteudoSugerido: fichaSugeridaHtml(null),
      botaoGerar: "Sugerir ficha técnica",
    });

    return '<div class="am-otim">' + seoSec + descSec + fichaSec + "</div>";
  }

  function otimSecaoHtml(o) {
    return '<section class="am-otim-section vf-card" data-section="' + o.id + '">' +
      '<div class="am-otim-section__head vf-card__header">' +
        '<div class="am-otim-section__title">' +
          '<div class="am-otim-section__icon">' + o.icon + "</div>" +
          "<div><h3>" + escapeHtml(o.titulo) + "</h3><p>" + escapeHtml(o.sub) + "</p></div>" +
        "</div>" +
        '<span class="am-otim-status vf-status is-neutral" data-status="' + o.id + '">Aguardando geração</span>' +
      "</div>" +
      '<div class="am-otim-section__body">' +
        '<div class="am-otim-grid">' +
          '<div class="am-otim-col am-otim-col--atual vf-card" data-atual="' + o.id + '">' +
            o.conteudoAtual +
          "</div>" +
          '<div class="am-otim-col am-otim-col--sugerido vf-card" data-sugerido="' + o.id + '">' +
            o.conteudoSugerido +
          "</div>" +
        "</div>" +
        '<div class="am-otim-actions">' +
          '<button type="button" class="vf-btn vf-btn--secondary" data-gerar="' + o.id + '">' + o.botaoGerar + "</button>" +
        "</div>" +
      "</div>" +
    "</section>";
  }

  // ----- SEO (lado esquerdo: atual editável) -----
  function seoAtualHtml(a) {
    var titulo = a.titulo || "";
    var modelo = a.modelo || "";
    return '<div class="am-otim-col__label">Atual no Mercado Livre' +
      '<span class="am-otim-col__label-meta">' + titulo.length + "/60</span></div>" +
      '<div class="am-otim-campo vf-field">' +
        '<label class="vf-field__label" for="am-titulo-atual">Título</label>' +
        '<textarea class="vf-textarea" id="am-titulo-atual" rows="2" maxlength="60">' +
          escapeHtml(titulo) + "</textarea>" +
        '<div class="am-otim-campo__row">' +
          '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-copy="am-titulo-atual">Copiar</button>' +
          '<span class="am-otim-col__label-meta" id="am-titulo-atual-count">' +
            titulo.length + " caracteres</span>" +
        "</div>" +
      "</div>" +
      '<div class="am-otim-campo vf-field">' +
        '<label class="vf-field__label" for="am-modelo-atual">Campo modelo</label>' +
        '<input class="vf-input" id="am-modelo-atual" value="' + escapeHtml(modelo) + '" />' +
        '<div class="am-otim-campo__row">' +
          '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-copy="am-modelo-atual">Copiar</button>' +
        "</div>" +
      "</div>";
  }

  // ----- SEO (lado direito: sugestões da IA) -----
  function seoSugeridoHtml(otim) {
    if (!otim) {
      return '<div class="am-otim-col__label">Sugestão da IA</div>' +
        '<div class="am-otim-vazio">Clique em <b>Gerar SEO</b> para ver as sugestões aqui.</div>';
    }

    var alts = (tryParseJSON(otim.melhorias_json, {}) || {}).titulos_alternativos || [];
    var alertas = tryParseJSON(otim.alertas_json, []) || [];

    var opcoesHtml = "";
    // título principal
    opcoesHtml += '<div class="am-otim-opcao am-otim-opcao--principal">' +
      '<div class="am-otim-opcao__head"><span>Principal</span><span>' +
      (otim.titulo_sugerido_chars || 0) + "/60</span></div>" +
      '<div class="am-otim-opcao__txt">' + escapeHtml(otim.titulo_sugerido || "") + "</div>" +
      '<div class="am-otim-opcao__btns">' +
        '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-copy-text="' + escapeAttr(otim.titulo_sugerido || "") + '">Copiar</button>' +
        '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-aprovar-titulo="' + escapeAttr(otim.titulo_sugerido || "") + '">Aprovar esta</button>' +
      "</div>" +
    "</div>";
    // alternativas
    alts.forEach(function (t, idx) {
      var len = String(t || "").length;
      opcoesHtml += '<div class="am-otim-opcao">' +
        '<div class="am-otim-opcao__head"><span>Opção ' + (idx + 1) + "</span><span>" + len + "/60</span></div>" +
        '<div class="am-otim-opcao__txt">' + escapeHtml(t) + "</div>" +
        '<div class="am-otim-opcao__btns">' +
          '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-copy-text="' + escapeAttr(t) + '">Copiar</button>' +
          '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-aprovar-titulo="' + escapeAttr(t) + '">Aprovar esta</button>' +
        "</div>" +
      "</div>";
    });

    var score = otim.score_seo != null ? otim.score_seo : 0;
    var alertasHtml = "";
    if (alertas.length) {
      alertasHtml = '<ul class="am-otim-alertas">';
      alertas.forEach(function (al) { alertasHtml += "<li>" + escapeHtml(al) + "</li>"; });
      alertasHtml += "</ul>";
    }

    return '<div class="am-otim-col__label">Sugestão da IA' +
      '<span class="vf-tag is-primary">' + escapeHtml(otim.ai_model || "IA") + "</span></div>" +
      '<div class="am-otim-campo vf-field"><span class="vf-field__label">Títulos sugeridos</span>' +
        '<div class="am-otim-opcoes">' + opcoesHtml + "</div></div>" +
      '<div class="am-otim-campo vf-field">' +
        '<label class="vf-field__label" for="am-modelo-sugerido">Modelo sugerido</label>' +
        '<input class="vf-input" id="am-modelo-sugerido" value="' + escapeAttr(otim.modelo_sugerido || "") + '" />' +
        '<div class="am-otim-campo__row">' +
          '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-copy="am-modelo-sugerido">Copiar</button>' +
          '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-aprovar-modelo="1">Aprovar modelo</button>' +
        "</div>" +
      "</div>" +
      '<div class="am-otim-meta">' +
        '<div class="am-otim-meta__row">' +
          '<span>Score SEO:</span><b class="am-otim-score ' + scoreClasse(score) + '">' + score + "/100</b>" +
        "</div>" +
        (otim.motivo ? '<div class="am-otim-meta__row"><span>Motivo:</span><b>' + escapeHtml(otim.motivo) + "</b></div>" : "") +
        alertasHtml +
      "</div>";
  }

  // ----- Descrição -----
  function descricaoAtualHtml(desc) {
    var d = String(desc || "").trim();
    return '<div class="am-otim-col__label">Descrição atual' +
      '<span class="am-otim-col__label-meta">' + d.length + " caracteres</span></div>" +
      '<div class="am-otim-campo vf-field">' +
        '<label class="vf-visually-hidden" for="am-desc-atual">Descrição atual</label>' +
        '<textarea class="vf-textarea" id="am-desc-atual" rows="14" placeholder="Sem descrição cadastrada">' +
          escapeHtml(d) + "</textarea>" +
        '<div class="am-otim-campo__row">' +
          '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-copy="am-desc-atual">Copiar</button>' +
        "</div>" +
      "</div>";
  }

  function descricaoSugeridaHtml(otim) {
    if (!otim) {
      return '<div class="am-otim-col__label">Sugestão da IA</div>' +
        '<div class="am-otim-vazio">Clique em <b>Gerar Descrição</b> para ver a sugestão aqui.</div>';
    }
    var melh = (tryParseJSON(otim.melhorias_json, {}) || {}).itens || [];
    var alertas = tryParseJSON(otim.alertas_json, []) || [];
    var d = otim.descricao_sugerida || "";

    var alertasHtml = "";
    if (alertas.length) {
      alertasHtml = '<ul class="am-otim-alertas">';
      alertas.forEach(function (al) { alertasHtml += "<li>" + escapeHtml(al) + "</li>"; });
      alertasHtml += "</ul>";
    }
    var melhHtml = "";
    if (melh.length) {
      melhHtml = '<div class="am-otim-meta__row"><span>Melhorias:</span></div><ul class="am-otim-alertas am-otim-alertas--neutral">';
      melh.forEach(function (m) { melhHtml += "<li>" + escapeHtml(m) + "</li>"; });
      melhHtml += "</ul>";
    }

    return '<div class="am-otim-col__label">Sugestão da IA' +
      '<span class="vf-tag is-primary">' + escapeHtml(otim.ai_model || "IA") + "</span></div>" +
      '<div class="am-otim-campo vf-field">' +
        '<label class="vf-field__label" for="am-desc-sugerida">Descrição sugerida (' + d.length + " caracteres)</label>" +
        '<textarea class="vf-textarea" id="am-desc-sugerida" rows="14">' + escapeHtml(d) + "</textarea>" +
        '<div class="am-otim-campo__row">' +
          '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-copy="am-desc-sugerida">Copiar</button>' +
          '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-aprovar-descricao="1">Aprovar descrição</button>' +
        "</div>" +
      "</div>" +
      (melhHtml || alertasHtml
        ? '<div class="am-otim-meta">' + melhHtml + alertasHtml + "</div>"
        : "");
  }

  // ----- Ficha técnica -----
  function fichaAtualHtml(attrs) {
    var preenchidos = (attrs || []).filter(function (x) { return x && x.value; });
    var vazios = (attrs || []).filter(function (x) { return !x || !x.value; });
    var html = '<div class="am-otim-col__label">Ficha técnica atual' +
      '<span class="am-otim-col__label-meta">' + preenchidos.length + " / " +
      (attrs || []).length + " preenchidos</span></div>";
    if (!attrs || !attrs.length) {
      return html + '<div class="am-otim-vazio">Sem atributos cadastrados neste anúncio.</div>';
    }
    html += '<div class="am-ficha-scroll vf-table-wrap">' +
      '<table class="am-ficha-tabela vf-table"><thead><tr><th>Atributo</th><th>Valor</th></tr></thead><tbody>';
    preenchidos.forEach(function (x) {
      html += "<tr><td>" + escapeHtml(x.name || x.id) +
        '</td><td class="am-ficha-val">' + escapeHtml(x.value) + "</td></tr>";
    });
    vazios.forEach(function (x) {
      html += "<tr><td>" + escapeHtml(x.name || x.id) +
        '</td><td class="am-ficha-vazia">Vazio</td></tr>';
    });
    html += "</tbody></table></div>";
    return html;
  }

  function fichaSugeridaHtml(otim) {
    if (!otim) {
      return '<div class="am-otim-col__label">Sugestão da IA</div>' +
        '<div class="am-otim-vazio">Clique em <b>Sugerir Ficha Técnica</b> para ver a análise.</div>';
    }
    var sug = tryParseJSON(otim.ficha_tecnica_sugerida_json, []) || [];
    var alertas = tryParseJSON(otim.alertas_json, []) || [];
    if (!sug.length) {
      return '<div class="am-otim-col__label">Sugestão da IA</div>' +
        '<div class="am-otim-vazio">A IA não encontrou ajustes relevantes — ficha técnica já está aceitável.</div>';
    }

    var html = '<div class="am-otim-col__label">Sugestões da IA' +
      '<span class="vf-tag is-primary">' + escapeHtml(otim.ai_model || "IA") + "</span></div>" +
      '<div class="am-ficha-scroll vf-table-wrap">' +
      '<table class="am-ficha-tabela vf-table"><thead><tr><th>Campo</th><th>Atual</th><th>Sugerido</th><th>Conf.</th></tr></thead><tbody>';
    sug.forEach(function (s) {
      var conf = String(s.confianca || "media").toLowerCase();
      html += "<tr>" +
        "<td>" + escapeHtml(s.campo || "—") + "</td>" +
        "<td>" + escapeHtml(s.valor_atual || "(vazio)") + "</td>" +
        '<td class="am-ficha-suj">' + escapeHtml(s.valor_sugerido || "—") + "</td>" +
        '<td><span class="am-conf vf-tag ' + (conf === "alta" ? "is-success" : conf === "baixa" ? "is-danger" : "is-warning") + '">' + escapeHtml(conf) + "</span></td>" +
      "</tr>";
    });
    html += "</tbody></table></div>";

    if (alertas.length) {
      html += '<ul class="am-otim-alertas">';
      alertas.forEach(function (al) { html += "<li>" + escapeHtml(al) + "</li>"; });
      html += "</ul>";
    }

    html += '<div class="am-otim-actions am-otim-actions--resultado">' +
      '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-copy-ficha="1">Copiar como lista</button>' +
      '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-aprovar-ficha="1">Aprovar sugestões</button>' +
      "</div>";
    return html;
  }

  function escapeAttr(s) {
    return escapeHtml(String(s || "").replace(/\n/g, " "));
  }

  // ===========================================================================
  // Bind do painel de IA
  // ===========================================================================
  function bindPainelOtimizacao() {
    var body = el("am-drawer-body");

    // Botões "Copiar" em campos existentes (id)
    body.querySelectorAll("[data-copy]").forEach(function (b) {
      if (b.getAttribute("data-am-bound") === "true") return;
      b.setAttribute("data-am-bound", "true");
      b.addEventListener("click", function () {
        var alvo = el(this.getAttribute("data-copy"));
        if (alvo) copiarTexto(alvo.value !== undefined ? alvo.value : alvo.textContent);
      });
    });
    // Botões "Copiar" com texto inline
    body.querySelectorAll("[data-copy-text]").forEach(function (b) {
      if (b.getAttribute("data-am-bound") === "true") return;
      b.setAttribute("data-am-bound", "true");
      b.addEventListener("click", function () {
        copiarTexto(this.getAttribute("data-copy-text"));
      });
    });
    // Botões "Gerar" por seção
    body.querySelectorAll("[data-gerar]").forEach(function (b) {
      if (b.getAttribute("data-am-bound") === "true") return;
      b.setAttribute("data-am-bound", "true");
      b.addEventListener("click", function () { gerar(this.getAttribute("data-gerar")); });
    });
    // Aprovar título (uma das 3 opções)
    body.querySelectorAll("[data-aprovar-titulo]").forEach(function (b) {
      if (b.getAttribute("data-am-bound") === "true") return;
      b.setAttribute("data-am-bound", "true");
      b.addEventListener("click", function () { aprovarTitulo(this.getAttribute("data-aprovar-titulo")); });
    });
    body.querySelectorAll("[data-aprovar-modelo]").forEach(function (b) {
      if (b.getAttribute("data-am-bound") === "true") return;
      b.setAttribute("data-am-bound", "true");
      b.addEventListener("click", function () { aprovarModelo(); });
    });
    body.querySelectorAll("[data-aprovar-descricao]").forEach(function (b) {
      if (b.getAttribute("data-am-bound") === "true") return;
      b.setAttribute("data-am-bound", "true");
      b.addEventListener("click", function () { aprovarDescricao(); });
    });
    body.querySelectorAll("[data-aprovar-ficha]").forEach(function (b) {
      if (b.getAttribute("data-am-bound") === "true") return;
      b.setAttribute("data-am-bound", "true");
      b.addEventListener("click", function () { aprovarFicha(); });
    });
    body.querySelectorAll("[data-copy-ficha]").forEach(function (b) {
      if (b.getAttribute("data-am-bound") === "true") return;
      b.setAttribute("data-am-bound", "true");
      b.addEventListener("click", copiarFichaSugerida);
    });

    // contador de chars do título atual
    var tat = el("am-titulo-atual");
    if (tat && tat.getAttribute("data-am-bound") !== "true") {
      tat.setAttribute("data-am-bound", "true");
      tat.addEventListener("input", function () {
        var c = el("am-titulo-atual-count");
        if (c) c.textContent = this.value.length + " caracteres";
        var meta = this.parentNode.parentNode.querySelector(".am-otim-col__label-meta");
        if (meta) meta.textContent = this.value.length + "/60";
      });
    }
  }

  // ===========================================================================
  // Histórico — pega últimas otimizações de cada tipo e popula painel
  // ===========================================================================
  function carregarHistoricoOtimizacoes(itemId) {
    var url = "/anuncios-meli/" + encodeURIComponent(itemId) +
              "/otimizacoes?clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug);
    api(url).then(function (r) {
      if (!r.data || !r.data.ok) return;
      var lista = r.data.otimizacoes || [];
      // pega a mais recente de cada tipo
      var porTipo = { seo: null, descricao: null, ficha_tecnica: null };
      lista.forEach(function (o) {
        if (porTipo[o.tipo] === null) porTipo[o.tipo] = o;
      });
      AM.otimizacoes = porTipo;
      if (porTipo.seo) atualizarSecao("seo", porTipo.seo);
      if (porTipo.descricao) atualizarSecao("descricao", porTipo.descricao);
      if (porTipo.ficha_tecnica) atualizarSecao("ficha_tecnica", porTipo.ficha_tecnica);
    });
  }

  // ===========================================================================
  // Gerar (chama IA)
  // ===========================================================================
  function gerar(tipo) {
    if (!AM.detalheAtual) return;
    var a = AM.detalheAtual.anuncio;
    var btn = document.querySelector('[data-gerar="' + tipo + '"]');
    var statusEl = document.querySelector('[data-status="' + tipo + '"]');

    if (btn) { btn.disabled = true; btn.textContent = "Gerando..."; }
    if (statusEl) {
      statusEl.className = "am-otim-status vf-status is-info";
      statusEl.textContent = "Consultando IA…";
    }

    api("/anuncios-meli/" + encodeURIComponent(a.item_id) + "/otimizar", {
      method: "POST",
      body: { clienteSlug: AM.clienteAtual.slug, tipo: tipo },
    }).then(function (r) {
      if (btn) { btn.disabled = false; btn.textContent = botaoLabelDe(tipo); }
      if (!r.data || !r.data.ok) {
        var motivo = (r.data && r.data.motivo) || "Erro ao consultar a IA.";
        if (statusEl) {
          statusEl.className = "am-otim-status vf-status is-danger";
          statusEl.textContent = motivo;
        }
        toast(motivo, "is-danger");
        return;
      }
      AM.otimizacoes[tipo] = r.data.otimizacao;
      atualizarSecao(tipo, r.data.otimizacao);
      if (statusEl) {
        statusEl.className = "am-otim-status vf-status is-success";
        statusEl.textContent = "Sugestão gerada";
      }
    });
  }

  function botaoLabelDe(tipo) {
    if (tipo === "seo") return "Gerar SEO";
    if (tipo === "descricao") return "Gerar descrição";
    if (tipo === "ficha_tecnica") return "Sugerir ficha técnica";
    return "Gerar";
  }

  function atualizarSecao(tipo, otim) {
    var alvo = document.querySelector('[data-sugerido="' + tipo + '"]');
    if (!alvo) return;
    if (tipo === "seo") alvo.innerHTML = seoSugeridoHtml(otim);
    if (tipo === "descricao") alvo.innerHTML = descricaoSugeridaHtml(otim);
    if (tipo === "ficha_tecnica") alvo.innerHTML = fichaSugeridaHtml(otim);

    var status = document.querySelector('[data-status="' + tipo + '"]');
    if (status && otim.status === "aprovado") {
      status.className = "am-otim-status vf-status is-success";
      status.textContent = "Aprovado em " + formatData(otim.aprovado_at);
    }

    // re-bind dos botões dentro do conteúdo recém-renderizado
    bindPainelOtimizacao();
  }

  // ===========================================================================
  // Aprovação
  // ===========================================================================
  function aprovarTitulo(titulo) {
    var otim = AM.otimizacoes.seo;
    if (!otim) { toast("Gere a sugestão primeiro."); return; }
    if (!titulo || titulo.length > 60) { toast("Título inválido."); return; }
    aprovar(otim.id, { tituloAprovado: titulo }, "Título aprovado.");
  }

  function aprovarModelo() {
    var otim = AM.otimizacoes.seo;
    if (!otim) { toast("Gere a sugestão primeiro."); return; }
    var input = el("am-modelo-sugerido");
    var modelo = input ? input.value.trim() : "";
    if (!modelo) { toast("Modelo vazio."); return; }
    aprovar(otim.id, { modeloAprovado: modelo }, "Modelo aprovado.");
  }

  function aprovarDescricao() {
    var otim = AM.otimizacoes.descricao;
    if (!otim) { toast("Gere a sugestão primeiro."); return; }
    var ta = el("am-desc-sugerida");
    var desc = ta ? ta.value : "";
    if (!desc.trim()) { toast("Descrição vazia."); return; }
    aprovar(otim.id, { descricaoAprovada: desc }, "Descrição aprovada.");
  }

  function aprovarFicha() {
    var otim = AM.otimizacoes.ficha_tecnica;
    if (!otim) { toast("Gere a sugestão primeiro."); return; }
    var sug = tryParseJSON(otim.ficha_tecnica_sugerida_json, []) || [];
    aprovar(otim.id, { fichaAprovadaJson: sug }, "Sugestões aprovadas.");
  }

  function aprovar(otimId, dados, msgOk) {
    api("/anuncios-meli/otimizacoes/" + otimId + "/aprovar", {
      method: "PATCH",
      body: dados,
    }).then(function (r) {
      if (r.data && r.data.ok) {
        toast(msgOk || "Aprovado.");
        // atualiza estado local e UI
        var o = r.data.otimizacao;
        if (o && AM.otimizacoes[o.tipo]) {
          AM.otimizacoes[o.tipo] = o;
          atualizarSecao(o.tipo, o);
        }
      } else {
        toast((r.data && r.data.motivo) || "Erro ao aprovar.");
      }
    });
  }

  function copiarFichaSugerida() {
    var otim = AM.otimizacoes.ficha_tecnica;
    if (!otim) return;
    var sug = tryParseJSON(otim.ficha_tecnica_sugerida_json, []) || [];
    if (!sug.length) { toast("Nada para copiar."); return; }
    var linhas = sug.map(function (s) {
      return (s.campo || "") + ": " + (s.valor_sugerido || "(deixar manual)") +
        " [" + (s.confianca || "media") + (s.precisa_revisao ? ", revisar" : "") + "]";
    });
    copiarTexto(linhas.join("\n"), "Ficha sugerida copiada.");
  }

  // ===========================================================================
  // Sincronização
  // ===========================================================================
  function sincronizar(modo) {
    var overlay = document.createElement("div");
    overlay.className = "am-sync-overlay vf-overlay is-open";
    overlay.id = "am-sync-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "am-sync-titulo");
    overlay.innerHTML = '<div class="am-sync-box vf-modal vf-modal--sm">' +
      '<div class="vf-modal__body"><div class="vf-loading-state" aria-live="polite"><span class="vf-spinner" aria-hidden="true"></span><strong id="am-sync-titulo">' +
      (modo === "completo" ? "Sincronização completa em andamento" : "Buscando anúncios novos") +
      "</strong><span>Consultando a API do Mercado Livre. Pode levar alguns minutos.</span></div></div></div>";
    document.body.appendChild(overlay);
    document.body.classList.add("vf-no-scroll");

    api("/anuncios-meli/sync", {
      method: "POST",
      body: { clienteSlug: AM.clienteAtual.slug, modo: modo },
    }).then(function (r) {
      var box = overlay.querySelector(".am-sync-box");
      var d = r.data || {};
      if (d.ok) {
        var msg;
        if (d.totalSalvos > 0) {
          msg = '<div class="vf-banner is-success"><div class="vf-banner__content"><p class="vf-banner__title">Sincronização concluída</p><p class="vf-banner__description">' + (d.totalEncontrados || 0) +
            " anúncios na conta · " + d.totalSalvos + " gravados/atualizados.</p>" +
            (d.limitado ? '<p class="vf-banner__description">O limite de itens por sincronização foi atingido. Rode novamente para continuar.</p>' : "") + "</div></div>";
        } else {
          msg = '<div class="vf-banner is-success"><div class="vf-banner__content"><p class="vf-banner__title">Tudo em dia</p><p class="vf-banner__description">' + escapeHtml(d.mensagem || "Nenhum anúncio novo para gravar.") + "</p></div></div>";
        }
        box.innerHTML = '<div class="vf-modal__body">' + msg + '</div><div class="vf-modal__footer"><button type="button" class="vf-btn vf-btn--primary" id="am-sync-ok">OK</button></div>';
        carregarResumo(); carregarAnuncios();
      } else {
        box.innerHTML = '<div class="vf-modal__body"><div class="vf-banner is-danger" role="alert"><div class="vf-banner__content"><p class="vf-banner__title">Não foi possível sincronizar</p><p class="vf-banner__description">' +
          escapeHtml(d.motivo || "Erro ao consultar o Mercado Livre.") + "</p>" +
          (d.codigo === "NO_TOKEN" ? '<p class="vf-banner__description">Conecte a conta do Mercado Livre deste cliente na tela de Clientes.</p>' : "") +
          '</div></div></div><div class="vf-modal__footer"><button type="button" class="vf-btn vf-btn--secondary" id="am-sync-ok">Fechar</button></div>';
      }
      var btn = el("am-sync-ok");
      if (btn) btn.addEventListener("click", function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        document.body.classList.remove("vf-no-scroll");
      });
    });
  }

  // ===========================================================================
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
