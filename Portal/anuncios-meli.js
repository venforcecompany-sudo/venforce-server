/* =============================================================================
   Anúncios Meli — lógica do módulo (JavaScript puro, sem dependências)
   Central operacional de anúncios do Mercado Livre por cliente.

   Endpoints consumidos (módulo backend meliAnuncios):
     GET   /anuncios-meli/clientes
     POST  /anuncios-meli/sync
     GET   /anuncios-meli/resumo?clienteSlug=
     GET   /anuncios-meli?clienteSlug=&q=&status=&filtro=&page=&limit=
     GET   /anuncios-meli/:itemId?clienteSlug=
     PATCH /anuncios-meli/:itemId/revisao
   ========================================================================== */
(function () {
  "use strict";

  // Mesma API usada pelo restante do portal.
  var API_BASE = "https://venforce-server.onrender.com";

  var AM = {
    token: null,
    clientes: [],
    clienteAtual: null, // { slug, nome }
    resumo: null,
    anuncios: [],
    paginacao: { page: 1, limit: 24, total: 0, totalPaginas: 1 },
    filtros: { q: "", status: "", filtro: "" },
    buscaTimer: null,
    carregandoCatalogo: false,
  };

  // --------------------------------------------------------------------------
  // Helpers básicos
  // --------------------------------------------------------------------------
  function el(id) {
    return document.getElementById(id);
  }

  function escapeHtml(valor) {
    if (valor === null || valor === undefined) return "";
    return String(valor)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatMoeda(valor, moeda) {
    if (valor === null || valor === undefined || valor === "") return "—";
    var n = Number(valor);
    if (isNaN(n)) return "—";
    var simbolo = moeda === "USD" ? "US$" : "R$";
    return (
      simbolo +
      " " +
      n.toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }

  function formatData(iso) {
    if (!iso) return "nunca";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return (
      d.toLocaleDateString("pt-BR") +
      " " +
      d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    );
  }

  function safeParseJson(valor, fallback) {
    if (valor === null || valor === undefined) return fallback;
    if (typeof valor === "object") return valor;
    try {
      return JSON.parse(valor);
    } catch (e) {
      return fallback;
    }
  }

  function copiarTexto(texto) {
    var valor = String(texto || "");
    if (!valor) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard
        .writeText(valor)
        .then(function () {
          return true;
        })
        .catch(function () {
          return false;
        });
    }
    var area = document.createElement("textarea");
    area.value = valor;
    area.setAttribute("readonly", "readonly");
    area.style.position = "fixed";
    area.style.top = "-9999px";
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(area);
    return Promise.resolve(ok);
  }

  function statusInfo(status) {
    switch (status) {
      case "active":
        return { label: "Ativo", classe: "am-badge--ok" };
      case "paused":
        return { label: "Pausado", classe: "am-badge--alerta" };
      case "closed":
        return { label: "Encerrado", classe: "am-badge--ruim" };
      case "under_review":
        return { label: "Em revisão", classe: "am-badge--neutro" };
      default:
        return { label: status || "—", classe: "am-badge--neutro" };
    }
  }

  function scoreClasse(score) {
    if (score === null || score === undefined) return "am-score--ruim";
    if (score >= 80) return "am-score--ok";
    if (score >= 60) return "am-score--alerta";
    return "am-score--ruim";
  }

  function scoreCorBarra(score) {
    if (score >= 80) return "#1f9d57";
    if (score >= 60) return "#c9821a";
    return "#d64545";
  }

  // --------------------------------------------------------------------------
  // Camada HTTP
  // --------------------------------------------------------------------------
  function api(path, opts) {
    opts = opts || {};
    var headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + (AM.token || ""),
    };
    if (opts.headers) {
      for (var k in opts.headers) headers[k] = opts.headers[k];
    }
    return fetch(API_BASE + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
      .then(function (resp) {
        return resp
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            return { status: resp.status, data: data };
          });
      })
      .catch(function () {
        return { status: 0, data: { ok: false, motivo: "Falha de conexão." } };
      });
  }

  // --------------------------------------------------------------------------
  // Inicialização
  // --------------------------------------------------------------------------
  function init() {
    AM.token = localStorage.getItem("vf-token");

    if (!AM.token) {
      el("am-clientes-container").innerHTML =
        '<div class="am-state"><strong>Sessão não encontrada</strong>' +
        "Faça login no portal para usar os Anúncios Meli.</div>";
      return;
    }

    bindEventosFixos();
    carregarClientes();
  }

  function bindEventosFixos() {
    el("am-busca-cliente").addEventListener("input", function (e) {
      renderClientes(e.target.value);
    });

    el("am-voltar").addEventListener("click", function () {
      AM.clienteAtual = null;
      el("am-view-hud").classList.add("am-hidden");
      el("am-view-clientes").classList.remove("am-hidden");
      carregarClientes();
    });

    el("am-busca").addEventListener("input", function (e) {
      AM.filtros.q = e.target.value;
      if (AM.buscaTimer) clearTimeout(AM.buscaTimer);
      AM.buscaTimer = setTimeout(function () {
        AM.paginacao.page = 1;
        carregarAnuncios();
      }, 350);
    });

    el("am-filtro-status").addEventListener("change", function (e) {
      AM.filtros.status = e.target.value;
      AM.paginacao.page = 1;
      carregarAnuncios();
    });

    el("am-filtro-problema").addEventListener("change", function (e) {
      AM.filtros.filtro = e.target.value;
      AM.paginacao.page = 1;
      carregarAnuncios();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") fecharDetalhe();
    });
  }

  // ==========================================================================
  // VIEW 1 — Seleção de cliente
  // ==========================================================================
  function carregarClientes() {
    var box = el("am-clientes-container");
    box.innerHTML =
      '<div class="am-state"><div class="am-spinner"></div>Carregando clientes...</div>';

    api("/anuncios-meli/clientes").then(function (r) {
      if (!r.data || !r.data.ok) {
        box.innerHTML =
          '<div class="am-state"><strong>Não foi possível carregar</strong>' +
          escapeHtml((r.data && r.data.motivo) || "Erro ao buscar clientes.") +
          "</div>";
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
      return (
        (c.nome || "").toLowerCase().indexOf(termo) !== -1 ||
        (c.slug || "").toLowerCase().indexOf(termo) !== -1
      );
    });

    if (!lista.length) {
      box.innerHTML =
        '<div class="am-state"><strong>Nenhum cliente encontrado</strong>' +
        (AM.clientes.length
          ? "Tente outro termo de busca."
          : "Cadastre clientes na tela de Clientes do portal.") +
        "</div>";
      return;
    }

    var html = '<div class="am-clientes-grid">';
    lista.forEach(function (c) {
      var conectado = c.mlConectado;
      html +=
        '<div class="am-cliente-card" data-slug="' +
        escapeHtml(c.slug) +
        '" data-nome="' +
        escapeHtml(c.nome) +
        '">' +
        '<div class="am-cliente-card__nome">' +
        escapeHtml(c.nome) +
        "</div>" +
        '<div class="am-cliente-card__meta">' +
        '<span class="am-badge ' +
        (conectado ? "am-badge--ok" : "am-badge--ruim") +
        '">' +
        (conectado ? "ML conectado" : "Sem ML") +
        "</span>" +
        "<span>" +
        (c.totalAnuncios || 0) +
        " anúncios</span>" +
        "</div>" +
        "</div>";
    });
    html += "</div>";
    box.innerHTML = html;

    var cards = box.querySelectorAll(".am-cliente-card");
    for (var i = 0; i < cards.length; i++) {
      cards[i].addEventListener("click", function () {
        selecionarCliente(
          this.getAttribute("data-slug"),
          this.getAttribute("data-nome")
        );
      });
    }
  }

  function selecionarCliente(slug, nome) {
    AM.clienteAtual = { slug: slug, nome: nome };
    AM.paginacao.page = 1;
    AM.filtros = { q: "", status: "", filtro: "" };

    el("am-busca").value = "";
    el("am-filtro-status").value = "";
    el("am-filtro-problema").value = "";

    el("am-view-clientes").classList.add("am-hidden");
    el("am-view-hud").classList.remove("am-hidden");

    renderHudHeader();
    carregarResumo();
    carregarAnuncios();
  }

  // ==========================================================================
  // VIEW 2 — HUD do cliente
  // ==========================================================================
  function renderHudHeader() {
    var c = AM.clienteAtual;
    var resumo = AM.resumo;

    var subInfo = "";
    if (resumo) {
      subInfo =
        "<span>Última sincronização: <b>" +
        formatData(resumo.ultimaSync) +
        "</b></span>" +
        "<span>Total sincronizado: <b>" +
        (resumo.total || 0) +
        " anúncios</b></span>";
    } else {
      subInfo = "<span>Carregando resumo...</span>";
    }

    el("am-hud-top").innerHTML =
      '<div class="am-hud-info">' +
      "<h2>" +
      escapeHtml(c.nome) +
      " — Anúncios Mercado Livre</h2>" +
      '<div class="am-hud-sub">' +
      subInfo +
      "</div>" +
      "</div>" +
      '<div class="am-hud-actions">' +
      '<button class="am-btn" id="am-sync-novos">Atualizar novos</button>' +
      '<button class="am-btn am-btn--primary" id="am-sync-completo">Sincronização completa</button>' +
      "</div>";

    el("am-sync-novos").addEventListener("click", function () {
      sincronizar("novos");
    });
    el("am-sync-completo").addEventListener("click", function () {
      sincronizar("completo");
    });
  }

  function carregarResumo() {
    if (!AM.clienteAtual) return;
    api(
      "/anuncios-meli/resumo?clienteSlug=" +
        encodeURIComponent(AM.clienteAtual.slug)
    ).then(function (r) {
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
      { label: "Total de anúncios", valor: r.total || 0, classe: "" },
      { label: "Ativos", valor: r.ativos || 0, classe: "am-stat--bom" },
      { label: "Pausados", valor: r.pausados || 0, classe: "am-stat--alerta" },
      {
        label: "Fotos insuficientes",
        valor: r.fotosInsuficientes || 0,
        classe: r.fotosInsuficientes ? "am-stat--alerta" : "",
      },
      {
        label: "Sem SKU",
        valor: r.semSku || 0,
        classe: r.semSku ? "am-stat--alerta" : "",
      },
      {
        label: "Score baixo",
        valor: r.scoreBaixo || 0,
        classe: r.scoreBaixo ? "am-stat--ruim" : "",
      },
      { label: "Mercado Full", valor: r.full || 0, classe: "" },
      {
        label: "Score médio",
        valor: r.scoreMedio || 0,
        classe:
          r.scoreMedio >= 80
            ? "am-stat--bom"
            : r.scoreMedio >= 60
            ? "am-stat--alerta"
            : "am-stat--ruim",
      },
    ];

    var html = "";
    cards.forEach(function (c) {
      html +=
        '<div class="am-stat ' +
        c.classe +
        '">' +
        '<div class="am-stat__label">' +
        c.label +
        "</div>" +
        '<div class="am-stat__valor">' +
        c.valor +
        "</div>" +
        "</div>";
    });
    el("am-resumo").innerHTML = html;
  }

  function carregarAnuncios() {
    if (!AM.clienteAtual || AM.carregandoCatalogo) return;
    AM.carregandoCatalogo = true;

    var box = el("am-catalogo-container");
    box.innerHTML =
      '<div class="am-state"><div class="am-spinner"></div>Carregando anúncios...</div>';

    var qs =
      "clienteSlug=" +
      encodeURIComponent(AM.clienteAtual.slug) +
      "&page=" +
      AM.paginacao.page +
      "&limit=" +
      AM.paginacao.limit;
    if (AM.filtros.q) qs += "&q=" + encodeURIComponent(AM.filtros.q);
    if (AM.filtros.status) qs += "&status=" + encodeURIComponent(AM.filtros.status);
    if (AM.filtros.filtro) qs += "&filtro=" + encodeURIComponent(AM.filtros.filtro);

    api("/anuncios-meli?" + qs).then(function (r) {
      AM.carregandoCatalogo = false;

      if (!r.data || !r.data.ok) {
        box.innerHTML =
          '<div class="am-state"><strong>Erro ao carregar</strong>' +
          escapeHtml((r.data && r.data.motivo) || "Tente novamente.") +
          "</div>";
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
      var temFiltro =
        AM.filtros.q || AM.filtros.status || AM.filtros.filtro;
      box.innerHTML =
        '<div class="am-state"><strong>' +
        (temFiltro
          ? "Nenhum anúncio para esse filtro"
          : "Nenhum anúncio sincronizado") +
        "</strong>" +
        (temFiltro
          ? "Ajuste a busca ou os filtros acima."
          : 'Use o botão "Sincronização completa" para trazer os anúncios deste cliente.') +
        "</div>";
      return;
    }

    var html = '<div class="am-catalogo">';
    AM.anuncios.forEach(function (a) {
      html += cardAnuncioHtml(a);
    });
    html += "</div>";
    html += paginacaoHtml();
    box.innerHTML = html;

    var cards = box.querySelectorAll(".am-card[data-item]");
    for (var i = 0; i < cards.length; i++) {
      cards[i]
        .querySelector(".am-card__acao")
        .addEventListener("click", function (e) {
          e.stopPropagation();
          abrirDetalhe(
            this.parentNode.parentNode.getAttribute("data-item")
          );
        });
      cards[i].addEventListener("click", function () {
        abrirDetalhe(this.getAttribute("data-item"));
      });
    }

    var btnPrev = el("am-pag-prev");
    var btnNext = el("am-pag-next");
    if (btnPrev)
      btnPrev.addEventListener("click", function () {
        if (AM.paginacao.page > 1) {
          AM.paginacao.page--;
          carregarAnuncios();
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      });
    if (btnNext)
      btnNext.addEventListener("click", function () {
        if (AM.paginacao.page < AM.paginacao.totalPaginas) {
          AM.paginacao.page++;
          carregarAnuncios();
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      });
  }

  function cardAnuncioHtml(a) {
    var st = statusInfo(a.status);
    var score = a.score_venforce;
    var scoreTxt = score === null || score === undefined ? "—" : score;

    var badges = "";
    badges +=
      '<span class="am-badge ' + st.classe + '">' + st.label + "</span>";
    if (a.is_full) badges += '<span class="am-badge am-badge--full">Full</span>';
    if ((a.pictures_count || 0) < 3)
      badges +=
        '<span class="am-badge am-badge--alerta">' +
        (a.pictures_count || 0) +
        "/3 fotos</span>";
    if (!a.sku)
      badges += '<span class="am-badge am-badge--ruim">Sem SKU</span>';
    if (a.revisado)
      badges += '<span class="am-badge am-badge--ok">Revisado</span>';

    var img = a.thumbnail
      ? '<img src="' +
        escapeHtml(a.thumbnail) +
        '" alt="" loading="lazy" />'
      : '<span class="am-card__img-vazia">sem imagem</span>';

    return (
      '<div class="am-card" data-item="' +
      escapeHtml(a.item_id) +
      '">' +
      '<div class="am-card__img">' +
      img +
      '<span class="am-card__score ' +
      scoreClasse(score) +
      '">' +
      scoreTxt +
      "/100</span>" +
      "</div>" +
      '<div class="am-card__body">' +
      '<div class="am-card__titulo">' +
      escapeHtml(a.titulo || "(sem título)") +
      "</div>" +
      '<div class="am-card__ids">' +
      "<b>" +
      escapeHtml(a.item_id) +
      "</b>" +
      (a.sku ? " · SKU " + escapeHtml(a.sku) : "") +
      (a.modelo ? "<br>Modelo: " + escapeHtml(a.modelo) : "") +
      "</div>" +
      '<div class="am-card__preco">' +
      formatMoeda(a.preco, a.moeda) +
      "</div>" +
      '<div class="am-card__badges">' +
      badges +
      "</div>" +
      '<button class="am-btn am-btn--sm am-card__acao">Ver detalhes</button>' +
      "</div>" +
      "</div>"
    );
  }

  function paginacaoHtml() {
    var p = AM.paginacao;
    if (p.totalPaginas <= 1) {
      return (
        '<div class="am-paginacao"><span>' +
        p.total +
        " anúncio(s)</span></div>"
      );
    }
    return (
      '<div class="am-paginacao">' +
      '<button class="am-btn am-btn--sm" id="am-pag-prev"' +
      (p.page <= 1 ? " disabled" : "") +
      ">&larr; Anterior</button>" +
      "<span>Página " +
      p.page +
      " de " +
      p.totalPaginas +
      " · " +
      p.total +
      " anúncios</span>" +
      '<button class="am-btn am-btn--sm" id="am-pag-next"' +
      (p.page >= p.totalPaginas ? " disabled" : "") +
      ">Próxima &rarr;</button>" +
      "</div>"
    );
  }

  // ==========================================================================
  // Detalhe do anúncio (drawer lateral)
  // ==========================================================================
  function abrirDetalhe(itemId) {
    var overlay = document.createElement("div");
    overlay.className = "am-modal-overlay";
    overlay.id = "am-modal-overlay";
    overlay.innerHTML =
      '<div class="am-drawer">' +
      '<div class="am-drawer__head">' +
      "<strong>Detalhe do anúncio</strong>" +
      '<button class="am-drawer__close" id="am-drawer-close">&times;</button>' +
      "</div>" +
      '<div class="am-drawer__body" id="am-drawer-body">' +
      '<div class="am-state"><div class="am-spinner"></div>Carregando...</div>' +
      "</div>" +
      "</div>";
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) fecharDetalhe();
    });
    el("am-drawer-close").addEventListener("click", fecharDetalhe);

    api(
      "/anuncios-meli/" +
        encodeURIComponent(itemId) +
        "?clienteSlug=" +
        encodeURIComponent(AM.clienteAtual.slug)
    ).then(function (r) {
      var body = el("am-drawer-body");
      if (!body) return;
      if (!r.data || !r.data.ok) {
        body.innerHTML =
          '<div class="am-state"><strong>Erro</strong>' +
          escapeHtml((r.data && r.data.motivo) || "Não foi possível carregar.") +
          "</div>";
        return;
      }
      renderDetalhe(r.data);
    });
  }

  function fecharDetalhe() {
    var overlay = el("am-modal-overlay");
    if (overlay) overlay.parentNode.removeChild(overlay);
  }

  function renderDetalhe(payload) {
    var a = payload.anuncio;
    var descricao = payload.descricao;
    var body = el("am-drawer-body");
    var st = statusInfo(a.status);
    var score = a.score_venforce != null ? a.score_venforce : 0;

    var pics = [];
    try {
      pics = Array.isArray(a.pictures_json)
        ? a.pictures_json
        : JSON.parse(a.pictures_json || "[]");
    } catch (e) {
      pics = [];
    }

    var attrs = [];
    try {
      attrs = Array.isArray(a.attributes_json)
        ? a.attributes_json
        : JSON.parse(a.attributes_json || "[]");
    } catch (e) {
      attrs = [];
    }

    // ---- abas
    var html =
      '<div class="am-tabs">' +
      '<button class="am-tab am-tab--ativa" data-tab="geral">Visão geral</button>' +
      '<button class="am-tab" data-tab="ficha">Ficha técnica</button>' +
      '<button class="am-tab" data-tab="fotos">Fotos</button>' +
      '<button class="am-tab" data-tab="desc">Descrição</button>' +
      '<button class="am-tab" data-tab="otimizacao">Otimização IA</button>' +
      "</div>";

    // ---- aba: visão geral
    html += '<div class="am-tab-panel am-tab-panel--ativa" data-panel="geral">';
    html +=
      (a.thumbnail
        ? '<img class="am-detalhe-img" src="' +
          escapeHtml(a.thumbnail) +
          '" alt="" />'
        : "") +
      '<div class="am-bloco">' +
      "<h4>" +
      escapeHtml(a.titulo || "(sem título)") +
      "</h4>" +
      kv("MLB", a.item_id) +
      kv("SKU", a.sku || "—") +
      kv("Modelo", a.modelo || "—") +
      kv("Marca", a.marca || "—") +
      kv(
        "Status",
        '<span class="am-badge ' + st.classe + '">' + st.label + "</span>"
      ) +
      kv("Preço", formatMoeda(a.preco, a.moeda)) +
      (a.preco_original
        ? kv("Preço original", formatMoeda(a.preco_original, a.moeda))
        : "") +
      kv("Estoque", a.estoque != null ? a.estoque : "—") +
      kv("Vendidos", a.vendidos != null ? a.vendidos : "—") +
      kv("Categoria", a.category_id || "—") +
      kv("Tipo de anúncio", a.listing_type_id || "—") +
      kv("Logística", a.is_full ? "Mercado Full" : a.logistic_type || "—") +
      "</div>";

    // score VenForce
    html +=
      '<div class="am-bloco">' +
      "<h4>Score VenForce</h4>" +
      '<div style="display:flex;align-items:baseline;gap:8px;">' +
      '<span style="font-size:26px;font-weight:700;" class="' +
      scoreClasse(score) +
      '">' +
      score +
      "</span><span style=\"color:#5b6680;font-size:13px;\">/ 100</span>" +
      "</div>" +
      '<div class="am-score-bar"><div class="am-score-bar__fill" style="width:' +
      score +
      "%;background:" +
      scoreCorBarra(score) +
      ';"></div></div>' +
      '<div style="font-size:12.5px;color:#5b6680;margin-top:6px;">Principal ponto: <b>' +
      escapeHtml(a.score_motivo || "—") +
      "</b></div>" +
      "</div>";

    // ações
    html +=
      '<div class="am-bloco">' +
      "<h4>Ações</h4>" +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
      (a.permalink
        ? '<a class="am-btn am-btn--sm" href="' +
          escapeHtml(a.permalink) +
          '" target="_blank" rel="noopener">Abrir no Mercado Livre</a>'
        : "") +
      '<button class="am-btn am-btn--sm" id="am-btn-revisar">' +
      (a.revisado ? "Desmarcar revisão" : "Marcar como revisado") +
      "</button>" +
      "</div>" +
      "</div>";
    html += "</div>"; // fim painel geral

    // ---- aba: ficha técnica
    html += '<div class="am-tab-panel" data-panel="ficha">';
    if (!attrs.length) {
      html +=
        '<div class="am-state">Nenhum atributo retornado para este anúncio.</div>';
    } else {
      var preenchidos = attrs.filter(function (x) {
        return x && x.value;
      });
      var vazios = attrs.filter(function (x) {
        return !x || !x.value;
      });
      html +=
        '<div class="am-bloco"><h4>Preenchidos (' +
        preenchidos.length +
        ")</h4>" +
        '<div class="am-attr-list">';
      if (!preenchidos.length) {
        html += '<div class="am-attr"><span>—</span></div>';
      }
      preenchidos.forEach(function (x) {
        html +=
          '<div class="am-attr"><span>' +
          escapeHtml(x.name || x.id) +
          "</span><b>" +
          escapeHtml(x.value) +
          "</b></div>";
      });
      html += "</div></div>";

      html +=
        '<div class="am-bloco"><h4>Faltando (' +
        vazios.length +
        ")</h4>" +
        '<div class="am-attr-list">';
      if (!vazios.length) {
        html += '<div class="am-attr"><span>Tudo preenchido 🎉</span></div>';
      }
      vazios.forEach(function (x) {
        html +=
          '<div class="am-attr am-attr--vazio"><span>' +
          escapeHtml(x.name || x.id) +
          "</span><b>vazio</b></div>";
      });
      html += "</div></div>";
    }
    html += "</div>"; // fim painel ficha

    // ---- aba: fotos
    html += '<div class="am-tab-panel" data-panel="fotos">';
    html +=
      '<div class="am-bloco"><h4>Fotos (' +
      pics.length +
      ")</h4>";
    if (pics.length < 3) {
      html +=
        '<div class="am-aviso">Recomendado ter pelo menos 3 fotos. Este anúncio tem ' +
        pics.length +
        ".</div>";
    }
    if (!pics.length) {
      html += '<div class="am-state">Sem fotos.</div>';
    } else {
      html += '<div class="am-thumbs">';
      pics.forEach(function (url) {
        html += '<img src="' + escapeHtml(url) + '" alt="" loading="lazy" />';
      });
      html += "</div>";
    }
    html += "</div></div>"; // fim painel fotos

    // ---- aba: descrição
    html += '<div class="am-tab-panel" data-panel="desc">';
    html += '<div class="am-bloco"><h4>Descrição atual</h4>';
    if (descricao && descricao.trim()) {
      html += '<div class="am-desc">' + escapeHtml(descricao.trim()) + "</div>";
    } else {
      html +=
        '<div class="am-aviso">Este anúncio não tem descrição preenchida.</div>';
    }
    html += "</div></div>"; // fim painel desc

    // ---- aba: otimização IA (SEO)
    html += '<div class="am-tab-panel" data-panel="otimizacao">';
    html +=
      '<div class="am-ai-panel" id="am-ai-panel">' +
      '<div class="am-ai-card">' +
      "<h4>SEO do anúncio</h4>" +
      '<div class="am-ai-current-title"><b>Título atual:</b> ' +
      escapeHtml(a.titulo || "(sem título)") +
      "</div>" +
      '<div class="am-ai-actions">' +
      '<button class="am-btn am-btn--sm am-btn--primary" id="am-ai-gerar">Gerar SEO</button>' +
      "</div>" +
      '<div class="am-ai-status" id="am-ai-status"></div>' +
      '<div class="am-ai-error am-hidden" id="am-ai-error"></div>' +
      '<div class="am-ai-resultados" id="am-ai-resultados"></div>' +
      "</div>" +
      "</div>";
    html += "</div>"; // fim painel otimização

    body.innerHTML = html;

    // bind das abas
    var tabs = body.querySelectorAll(".am-tab");
    var panels = body.querySelectorAll(".am-tab-panel");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        var alvo = this.getAttribute("data-tab");
        for (var j = 0; j < tabs.length; j++)
          tabs[j].classList.remove("am-tab--ativa");
        this.classList.add("am-tab--ativa");
        for (var k = 0; k < panels.length; k++) {
          panels[k].classList.toggle(
            "am-tab-panel--ativa",
            panels[k].getAttribute("data-panel") === alvo
          );
        }
      });
    }

    // bind do botão revisar
    var btnRev = el("am-btn-revisar");
    if (btnRev) {
      btnRev.addEventListener("click", function () {
        alternarRevisado(a.item_id, a.revisado, btnRev);
      });
    }

    bindOtimizacaoIA(a);
  }

  function kv(rotulo, valor) {
    return (
      '<div class="am-kv"><span>' +
      escapeHtml(rotulo) +
      "</span><b>" +
      valor +
      "</b></div>"
    );
  }

  function alternarRevisado(itemId, atual, btn) {
    var novo = !atual;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Salvando...";
    }
    api("/anuncios-meli/" + encodeURIComponent(itemId) + "/revisao", {
      method: "PATCH",
      body: { clienteSlug: AM.clienteAtual.slug, revisado: novo },
    }).then(function (r) {
      if (btn) btn.disabled = false;
      if (r.data && r.data.ok) {
        if (btn)
          btn.textContent = novo
            ? "Desmarcar revisão"
            : "Marcar como revisado";
        // atualiza estado local + recarrega catálogo ao fechar
        var alvo = AM.anuncios.filter(function (x) {
          return x.item_id === itemId;
        })[0];
        if (alvo) alvo.revisado = novo;
        carregarAnuncios();
      } else if (btn) {
        btn.textContent = "Erro — tentar de novo";
      }
    });
  }

  function obterTitulosAlternativos(otimizacao) {
    var melhorias = safeParseJson(otimizacao && otimizacao.melhorias_json, {});
    var lista = Array.isArray(melhorias && melhorias.titulos_alternativos)
      ? melhorias.titulos_alternativos
      : [];
    var titulos = [];
    for (var i = 0; i < lista.length; i++) {
      var t = String(lista[i] || "").trim();
      if (t && titulos.indexOf(t) === -1) titulos.push(t);
    }
    var tituloPrincipal = String(
      (otimizacao && otimizacao.titulo_sugerido) || ""
    ).trim();
    if (tituloPrincipal && titulos.indexOf(tituloPrincipal) === -1) {
      titulos.unshift(tituloPrincipal);
    }
    return titulos;
  }

  function bindOtimizacaoIA(anuncio) {
    var panel = el("am-ai-panel");
    var btnGerar = el("am-ai-gerar");
    var boxStatus = el("am-ai-status");
    var boxErro = el("am-ai-error");
    var boxResultados = el("am-ai-resultados");
    if (!panel || !btnGerar || !boxStatus || !boxErro || !boxResultados) return;

    var estado = { otimizacao: null, titulos: [] };

    function setStatus(texto, classe) {
      boxStatus.className = "am-ai-status";
      if (classe) boxStatus.classList.add(classe);
      boxStatus.textContent = texto || "";
    }

    function setErro(texto) {
      if (!texto) {
        boxErro.classList.add("am-hidden");
        boxErro.textContent = "";
        return;
      }
      boxErro.classList.remove("am-hidden");
      boxErro.textContent = texto;
    }

    function renderResultados() {
      if (!estado.otimizacao) {
        boxResultados.innerHTML = "";
        return;
      }

      var ot = estado.otimizacao;
      estado.titulos = obterTitulosAlternativos(ot);
      var recomendado = String(ot.titulo_sugerido || "").trim();
      var score =
        ot.score_seo === null || ot.score_seo === undefined ? "—" : ot.score_seo;
      var alertasRaw = safeParseJson(ot.alertas_json, []);
      var alertas = Array.isArray(alertasRaw) ? alertasRaw : [];
      var modelo = String(ot.modelo_sugerido || "").trim();
      var status = String(ot.status || "rascunho");

      var html =
        '<div class="am-ai-card">' +
        '<div class="am-ai-meta">' +
        "<span><b>Status:</b> " +
        escapeHtml(status) +
        "</span>" +
        "<span><b>Score SEO:</b> " +
        escapeHtml(score) +
        "</span>" +
        "</div>" +
        '<div class="am-ai-line"><b>Motivo:</b> ' +
        escapeHtml(ot.motivo || "—") +
        "</div>";

      if (alertas.length) {
        html += '<div class="am-ai-alert"><b>Alertas:</b><ul>';
        for (var i = 0; i < alertas.length; i++) {
          html += "<li>" + escapeHtml(alertas[i]) + "</li>";
        }
        html += "</ul></div>";
      }

      html +=
        '<div class="am-ai-line"><b>Modelo sugerido:</b> ' +
        escapeHtml(modelo || "—") +
        "</div>" +
        '<div class="am-ai-actions">' +
        '<button class="am-btn am-btn--sm am-ai-copy" id="am-ai-copy-modelo">Copiar modelo</button>' +
        "</div>" +
        "</div>";

      html += '<div class="am-ai-titles">';
      for (var j = 0; j < estado.titulos.length; j++) {
        var titulo = estado.titulos[j];
        var isRecomendado = recomendado && recomendado === titulo;
        html +=
          '<div class="am-ai-title-option ' +
          (isRecomendado ? "is-recommended" : "") +
          '">' +
          '<div class="am-ai-title-text">' +
          escapeHtml(titulo) +
          "</div>" +
          '<div class="am-ai-meta">' +
          '<span class="am-ai-chars">' +
          titulo.length +
          "/60</span>" +
          (isRecomendado
            ? '<span class="am-ai-badge">Recomendado</span>'
            : "") +
          "</div>" +
          '<div class="am-ai-actions">' +
          '<button class="am-btn am-btn--sm am-ai-copy" data-ai-copy="' +
          j +
          '">Copiar</button>' +
          '<button class="am-btn am-btn--sm am-ai-approve" data-ai-approve="' +
          j +
          '">Aprovar</button>' +
          "</div>" +
          "</div>";
      }
      html += "</div>";
      boxResultados.innerHTML = html;

      var btnCopiarModelo = el("am-ai-copy-modelo");
      if (btnCopiarModelo) {
        btnCopiarModelo.addEventListener("click", function () {
          copiarTexto(modelo).then(function (ok) {
            setStatus(ok ? "Modelo copiado." : "Não foi possível copiar.", "");
          });
        });
      }

      var botoesCopy = boxResultados.querySelectorAll("[data-ai-copy]");
      for (var c = 0; c < botoesCopy.length; c++) {
        botoesCopy[c].addEventListener("click", function () {
          var idx = Number(this.getAttribute("data-ai-copy"));
          var texto = estado.titulos[idx] || "";
          copiarTexto(texto).then(function (ok) {
            setStatus(ok ? "Título copiado." : "Não foi possível copiar.", "");
          });
        });
      }

      var botoesAprovar = boxResultados.querySelectorAll("[data-ai-approve]");
      for (var aIdx = 0; aIdx < botoesAprovar.length; aIdx++) {
        botoesAprovar[aIdx].addEventListener("click", function () {
          if (!estado.otimizacao || !estado.otimizacao.id) {
            setErro("Não foi possível aprovar: otimização sem ID.");
            return;
          }
          var idx = Number(this.getAttribute("data-ai-approve"));
          var tituloEscolhido = estado.titulos[idx] || "";
          if (!tituloEscolhido) return;

          var self = this;
          self.disabled = true;
          self.textContent = "Aprovando...";
          setErro("");

          api(
            "/anuncios-meli/otimizacoes/" +
              encodeURIComponent(estado.otimizacao.id) +
              "/aprovar",
            {
              method: "PATCH",
              body: {
                tituloAprovado: tituloEscolhido,
                modeloAprovado: String(
                  estado.otimizacao.modelo_sugerido || ""
                ).trim(),
                observacao: "",
              },
            }
          ).then(function (r) {
            self.disabled = false;
            self.textContent = "Aprovar";

            if (!r.data || !r.data.ok || !r.data.otimizacao) {
              setErro(
                (r.data && r.data.motivo) ||
                  "Não foi possível aprovar esta sugestão."
              );
              return;
            }

            estado.otimizacao = r.data.otimizacao;
            setStatus("Sugestão aprovada.", "is-approved");
            renderResultados();
          });
        });
      }
    }

    btnGerar.addEventListener("click", function () {
      btnGerar.disabled = true;
      btnGerar.textContent = "Gerando...";
      setErro("");
      setStatus("Gerando sugestões de SEO com IA...", "");

      api("/anuncios-meli/" + encodeURIComponent(anuncio.item_id) + "/otimizar", {
        method: "POST",
        body: {
          clienteSlug: AM.clienteAtual && AM.clienteAtual.slug,
          tipo: "seo",
        },
      }).then(function (r) {
        btnGerar.disabled = false;
        btnGerar.textContent = "Gerar SEO";

        if (!r.data || !r.data.ok || !r.data.otimizacao) {
          setStatus("", "");
          setErro(
            (r.data && r.data.motivo) ||
              "Não foi possível gerar SEO agora. Tente novamente em instantes."
          );
          return;
        }

        estado.otimizacao = r.data.otimizacao;
        setStatus("Sugestões geradas com sucesso.", "");
        renderResultados();
      });
    });
  }

  // ==========================================================================
  // Sincronização
  // ==========================================================================
  function sincronizar(modo) {
    var overlay = document.createElement("div");
    overlay.className = "am-sync-overlay";
    overlay.id = "am-sync-overlay";
    overlay.innerHTML =
      '<div class="am-sync-box">' +
      '<div class="am-spinner"></div>' +
      "<strong>" +
      (modo === "completo"
        ? "Sincronização completa em andamento"
        : "Buscando anúncios novos") +
      "</strong>" +
      "<p>Consultando a API do Mercado Livre. Isso pode levar alguns minutos para contas grandes.</p>" +
      "</div>";
    document.body.appendChild(overlay);

    api("/anuncios-meli/sync", {
      method: "POST",
      body: { clienteSlug: AM.clienteAtual.slug, modo: modo },
    }).then(function (r) {
      var box = overlay.querySelector(".am-sync-box");
      var d = r.data || {};

      if (d.ok) {
        var msg;
        if (d.totalSalvos > 0) {
          msg =
            "<strong>Sincronização concluída</strong>" +
            "<p>" +
            (d.totalEncontrados || 0) +
            " anúncios na conta · " +
            d.totalSalvos +
            " gravados/atualizados.</p>" +
            (d.limitado
              ? "<p>O limite de itens por sincronização foi atingido. Rode novamente para continuar.</p>"
              : "");
        } else {
          msg =
            "<strong>Tudo em dia</strong>" +
            "<p>" +
            escapeHtml(d.mensagem || "Nenhum anúncio novo para gravar.") +
            "</p>";
        }
        box.innerHTML =
          msg + '<button class="am-btn am-btn--primary" id="am-sync-ok">OK</button>';
        carregarResumo();
        carregarAnuncios();
      } else {
        box.innerHTML =
          "<strong>Não foi possível sincronizar</strong>" +
          "<p>" +
          escapeHtml(
            d.motivo || "Erro ao consultar o Mercado Livre."
          ) +
          "</p>" +
          (d.codigo === "NO_TOKEN"
            ? "<p>Conecte a conta do Mercado Livre deste cliente na tela de Clientes.</p>"
            : "") +
          '<button class="am-btn" id="am-sync-ok">Fechar</button>';
      }

      var btn = el("am-sync-ok");
      if (btn)
        btn.addEventListener("click", function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        });
    });
  }

  // --------------------------------------------------------------------------
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
