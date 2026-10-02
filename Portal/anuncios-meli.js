/* =============================================================================
   Anúncios Meli — lógica do módulo (JavaScript puro, sem dependências)
   Central operacional + Agente Otimizador Textual IA.

   A listagem é UMA SÓ (ver docs/AUDITORIA_ANUNCIOS_ML_LISTAGEM_UNIFICADA.md):
   anúncio agrupado e anúncio individual dividem a mesma lista, a mesma
   ordenação e a mesma paginação. A família é forma de agrupamento interno do
   Mercado Livre, não uma categoria de tela — não existe aba.

   Endpoints consumidos:
     GET   /anuncios-meli/clientes
     POST  /anuncios-meli/sync
     GET   /anuncios-meli/resumo?clienteSlug=
     GET   /anuncios-meli/familias?clienteSlug=...    (A LISTA unificada)
     GET   /anuncios-meli/familias/:familyId          (expansão do agrupador)
     GET   /anuncios-meli/performance                 (métricas 7d + margem, assíncrono — nunca bloqueia a lista)
     GET   /anuncios-meli/:itemId?clienteSlug=
     PATCH /anuncios-meli/:itemId/conteudo         (escreve no Mercado Livre)
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
    // Fonte de PRONTIDÃO (mlConectado), não seletor — ver
    // carregarProntidaoClientes(). `prontidaoCarregada` separa "ainda não sei"
    // de "sei que este cliente não está na lista".
    clientes: [],
    prontidaoCarregada: false,
    clienteAtual: null,
    resumo: null,
    anuncios: [],
    paginacao: { page: 1, limit: 24, total: 0, totalPaginas: 1 },
    filtros: { q: "", status: "", filtro: "" },
    // Critério GLOBAL ativo (faturamento_*/curvaAbc_*) — sobrevive à troca de
    // página, ao contrário da ordenação LOCAL (AM_ordemOriginalAnuncios, que
    // reseta a cada carregarAnuncios porque só faz sentido pra página que
    // acabou de sair de cena). null = nenhum critério global ativo.
    ordenarPor: null,
    // Card de KPI atualmente selecionado como filtro rápido (V3 — os cards
    // do resumo substituem os antigos <select> de Status/Qualidade). Guarda
    // só a CHAVE do KPI; o valor real que vai para AM.filtros.status/filtro
    // continua vindo do mesmo mapa usado para montar os cards (KPI_DEFS).
    kpiAtivo: null,
    buscaTimer: null,
    carregandoCatalogo: false,
    // Guarda de corrida (mesma classe de bug corrigida em automacoes.js/
    // ads.js): sem isso, a resposta LENTA da conta anterior podia chegar
    // depois da resposta rápida da conta nova e sobrescrever resumo/catálogo
    // em tela como se fossem da conta selecionada agora.
    resumoToken: 0,
    catalogoToken: 0,
    // A operação escolhida no Shell (data-vf-scope="account"). Esta tela não
    // decide mais cardinalidade — vf-context.js decide (R8).
    contaMlId: "",
    // ── Listagem UNIFICADA ─────────────────────────────────────────────────
    // Uma lista só. `AM.anuncios` guarda linhas, e cada linha é um agrupador
    // (tipo "familia", quando o Mercado Livre agrupou aquele produto) ou o
    // próprio anúncio (tipo "item"). Não existe modo, aba nem segunda lista:
    // a família é forma de agrupamento interno do ML, não categoria de tela.
    // Ver docs/AUDITORIA_ANUNCIOS_ML_LISTAGEM_UNIFICADA.md.
    //
    // Cache dos agrupadores já conhecidos: family_id -> detalhe. Reabrir um
    // agrupador não gasta requisição — e, desde o pré-carregamento em
    // background (ver garantirFamiliaDetalhe/carregarMetricasDosGruposVisiveis),
    // a família pode já estar aqui ANTES do primeiro clique.
    //
    // `performanceCache` é o mesmo tipo de cache, por item_id, mas com dois
    // aspectos independentes (`temMetricas`/`temMargem`): o pré-carregamento
    // só pede metricas7d (nunca margem, que fica cara — Motor de Margem — e
    // só faz sentido quando o operador realmente abre o agrupador). Ao
    // expandir, só o aspecto que falta é buscado — metricas7d já cacheado
    // NUNCA é pedido de novo.
    //
    // `familyFetchEmVoo`/`metricasEmVoo`/`margemEmVoo`/`composicaoEmVoo`
    // deduplicam chamadas concorrentes para o MESMO family_id/item_id: o
    // pré-carregamento em background e um clique do operador na mesma
    // família (ou abrir o modal de um item que já está em voo) nunca
    // disparam duas requisições — o segundo pedido reaproveita a Promise já
    // em voo do primeiro (ver garantirFamiliaDetalhe/carregarPerformance).
    //
    // `composicao`/`temComposicao` (por item_id, dentro de
    // `performanceCache[itemId]`): a decomposição da margem (venda, custo,
    // comissão, frete, taxa fixa, imposto) que alimenta a seção "Composição
    // da margem" do modal de detalhe — só pedida quando o operador abre
    // aquela seção (ver garantirComposicaoDoItem), nunca junto do resto.
    state: {
      familyCache: {},
      familyFetchEmVoo: {},
      familyFetchFalhou: {},
      performanceCache: {},
      metricasEmVoo: {},
      margemEmVoo: {},
      composicaoEmVoo: {},
      // % faturamento e Curva ABC — coluna/tag SEMPRE visíveis, então têm
      // pré-carregamento automático (ver
      // carregarPerformance/carregarFaturamentoDasFamiliasVisiveis, chamados
      // no fim de renderCatalogo): item avulso é bundlado na MESMA chamada
      // de metricas7d/margem (os dois vêm do MESMO porMlb, zero custo
      // extra); família consolidada leva uma chamada própria com
      // `familias=`, dedupe por faturamentoFamiliaEmVoo. MLB filho de uma
      // família ainda fechada só ganha Curva ABC ao expandir (mesma regra
      // de custo já aplicada à margem — nunca gasta Motor para filho
      // oculto, ver garantirPerformanceDaFamilia). Em qualquer um dos
      // caches, uma chave ausente é "nunca pedido" (célula mostra
      // "—"/sem tag); uma chave presente com valor null é "pedido, mas o
      // backend não tem o dado para esta linha".
      faturamentoCache: {},
      faturamentoValorCache: {},
      faturamentoEmVoo: {},
      faturamentoPorFamiliaCache: {},
      faturamentoValorPorFamiliaCache: {},
      faturamentoFamiliaEmVoo: {},
      curvaAbcCache: {},
      curvaAbcEmVoo: {},
      curvaAbcPorFamiliaCache: {},
      // Variações do modelo LEGADO do ML (item_id -> variations[], ver
      // rowAnuncioHtml/badge "N variações no ML") — mesmo padrão de cache e
      // dedupe de garantirFamiliaDetalhe, por item_id em vez de family_id.
      variacoesLegadoCache: {},
      variacoesLegadoFetchEmVoo: {},
      // Promoções oficiais do item (GET /:itemId/promocoes, ver
      // meliPromocoesService) — mesmo padrão de cache/dedupe por item_id dos
      // vizinhos acima. `promocoesCache[itemId]` é `{ ok, promocoes }` depois
      // de resolvida; `undefined` enquanto não foi pedida ainda (a seção
      // mostra "Carregando…" nesse caso — ver promocoesSecaoHtml).
      promocoesCache: {},
      promocoesFetchEmVoo: {},
    },
    // familiaEpoca invalida de uma vez toda expansão/pré-carregamento em voo
    // quando o cliente/conta muda (senão o detalhe do cliente A pintaria a
    // tela do B, ou escreveria no cache do B usando a época do A).
    familiaEpoca: 0,
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

  // Valor seguro para dentro de um atributo HTML (o " já é escapado por
  // escapeHtml; a quebra de linha vira espaço porque atributo não tem linha).
  function escapeAttr(v) {
    return escapeHtml(String(v === null || v === undefined ? "" : v).replace(/\n/g, " "));
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

  // Dois critérios DIFERENTES, de propósito — não unificar de volta:
  //  - tag visual "Catálogo": só catalog_listing===true. family_name é outro
  //    conceito da doc do ML (família/User Products), não indica publicação
  //    de catálogo — usá-lo aqui gerava falso positivo na tag.
  //  - bloqueio de edição do título: mais amplo (catalog_listing OU
  //    family_name), porque o ML já demonstrou recusar o PUT de título só
  //    por family_name, mesmo sem catalog_listing=true (achado da
  //    investigação do BODY_INVALID_FIELDS).
  function ehCatalogoOficial(a) {
    return !!(a && a.catalog_listing === true);
  }

  function tituloTravadoPorCatalogo(a) {
    return !!(a && (a.catalog_listing === true || a.family_name));
  }

  // Badges de status do anúncio (Catálogo/Full/fotos/Sem SKU/Revisado) —
  // compartilhado entre o card legado (rowAnuncioHtml) e o card do MLB
  // dentro de agrupador/família (rowMlbCompactaHtml). Os dois representam o
  // MESMO anúncio (mesmas colunas de meli_anuncios), então o mesmo anúncio
  // não pode mostrar um badge fora da família e escondê-lo dentro dela —
  // ver auditoria "padronizar card MLB dentro de agrupadores".
  // Curva ABC (classificação por Pareto de receita, últ. 30d) como TAG, não
  // coluna — mesmo componente vf-tag das demais (Catálogo/Full/Sem SKU/...),
  // nunca um padrão novo de badge. Renderizada em SPAN PRÓPRIA (data-abc-*),
  // separada de badgesAnuncioHtml: os badges estáticos (Catálogo/Full/...)
  // nunca mudam depois do primeiro paint, mas a Curva ABC chega assíncrona
  // (ver carregarPerformance/carregarFaturamentoDasFamiliasVisiveis) e
  // precisa de um alvo próprio pra repintar sem reconstruir a linha inteira
  // (ver pintarPerformanceEmCelulas). Sempre visível quando existe dado —
  // não depende mais de o operador ter ordenado por ela nesta sessão (ver
  // auditoria "Curva ABC sempre visível + faturamento absoluto"). `classe`
  // ausente (cache ainda não pedido/resolvido) devolve "" (nenhuma tag).
  var CURVA_ABC_TAG_CLASSE = { A: "is-success", B: "is-warning", C: "is-danger" };
  function curvaAbcBadgeHtml(classe) {
    if (!classe) return "";
    return '<span class="vf-tag ' + (CURVA_ABC_TAG_CLASSE[classe] || "is-neutral") + '">' + escapeHtml(classe) + "</span>";
  }

  function badgesAnuncioHtml(a) {
    var badges = "";
    if (ehCatalogoOficial(a)) badges += '<span class="vf-tag is-primary">Catálogo</span>';
    if (a.is_full) badges += '<span class="vf-tag is-info">Full</span>';
    if ((a.pictures_count || 0) < 3) badges += '<span class="vf-tag is-warning">' + (a.pictures_count || 0) + "/3 fotos</span>";
    if (!a.sku) badges += '<span class="vf-tag is-danger">Sem SKU</span>';
    if (a.revisado) badges += '<span class="vf-tag is-success">Revisado</span>';
    return badges;
  }

  function scoreClasse(s) {
    if (s >= 80) return "is-success";
    if (s >= 60) return "is-warning";
    return "is-danger";
  }

  function scoreLegenda(s) {
    if (s >= 80) return "Score muito bom";
    if (s >= 60) return "Score razoável";
    return "Score baixo";
  }

  // Medidor semicircular do Score VenForce (estilo Mercado Livre): arco de
  // fundo cinza + arco colorido proporcional ao score, número central e
  // legenda curta abaixo. Path fixo (raio 28, viewBox 64x34) — só o
  // stroke-dasharray do arco de progresso muda por item.
  var AM_GAUGE_ARC_LEN = 87.96; // comprimento do semicírculo (pi * raio 28)
  function scoreGaugeHtml(score) {
    var s = score === null || score === undefined ? 0 : Number(score);
    if (isNaN(s)) s = 0;
    var pct = Math.max(0, Math.min(100, s));
    var classe = scoreClasse(s);
    var dash = (pct / 100 * AM_GAUGE_ARC_LEN).toFixed(1);
    var scoreTxt = score === null || score === undefined ? "—" : s;
    return '<div class="am-gauge">' +
      '<div class="am-gauge__wrap">' +
        '<svg viewBox="0 0 64 34" width="64" height="34" aria-hidden="true">' +
          '<path d="M4 32 A28 28 0 0 1 60 32" fill="none" stroke-width="6" stroke-linecap="round" class="am-gauge__track"/>' +
          '<path d="M4 32 A28 28 0 0 1 60 32" fill="none" stroke-width="6" stroke-linecap="round" ' +
            'class="am-gauge__arc ' + classe + '" stroke-dasharray="' + dash + ' 200"/>' +
        "</svg>" +
        '<span class="am-gauge__value ' + classe + '">' + scoreTxt + "</span>" +
      "</div>" +
      '<span class="am-gauge__legenda">' + scoreLegenda(s) + "</span>" +
    "</div>";
  }

  // ===========================================================================
  // KPIs do resumo — também funcionam como filtros rápidos da listagem (V3).
  // `campo` lê o valor pronto de AM.resumo; `tipo`+`valor` dizem o que setar
  // em AM.filtros ao clicar (mesmo mecanismo de query string que os antigos
  // <select> de Status/Qualidade já usavam — só a forma de disparar mudou).
  // ===========================================================================
  // `estado` colore o texto de apoio (meta); `accent` é o filete lateral
  // (box-shadow inset) — só os KPIs de qualidade/risco têm filete, igual
  // ao canva "modelo 1-principal" (Main.dc.html): Total/Ativos/Pausados
  // não têm, e Mercado Full tem filete info mas texto neutro.
  // `meta` pode ser string fixa ou function(r) para texto calculado a
  // partir do próprio resumo (ex.: % de ativos sobre o total).
  var KPI_DEFS = [
    { key: "total", label: "Total de anúncios", campo: "total", meta: "Catálogo sincronizado", estado: "neutral", accent: "" },
    {
      key: "ativos", label: "Ativos", campo: "ativos", estado: "success", accent: "", tipo: "status", valor: "active",
      meta: function (r) {
        var total = r.total || 0;
        var pct = total > 0 ? Math.round(((r.ativos || 0) / total) * 100) : 0;
        return pct + "% do catálogo";
      },
    },
    { key: "pausados", label: "Pausados", campo: "pausados", meta: "Pedem acompanhamento", estado: "warning", accent: "", tipo: "status", valor: "paused" },
    { key: "score_muito_bom", label: "Score muito bom", campo: "scoreMuitoBom", meta: "80 pontos ou mais", estado: "success", accent: "success", tipo: "filtro", valor: "score_muito_bom" },
    { key: "score_medio", label: "Score médio", campo: "scoreMedio", meta: "Média de 100 pontos", estado: "warning", accent: "warning", tipo: "filtro", valor: "score_medio" },
    { key: "score_baixo", label: "Score baixo", campo: "scoreBaixo", meta: "Abaixo de 60 pontos", estado: "danger", accent: "danger", tipo: "filtro", valor: "score_baixo" },
    { key: "mercado_full", label: "Mercado Full", campo: "full", meta: "Com logística Full", estado: "neutral", accent: "info", tipo: "filtro", valor: "mercado_full" },
    { key: "sem_sku", label: "Sem SKU", campo: "semSku", meta: "Sem identificação interna", estado: "danger", accent: "neutral", tipo: "filtro", valor: "sem_sku" },
  ];

  // Todo card de KPI vale para a lista inteira. Enquanto a tela tinha duas
  // abas, metade dos cards ficava desabilitada em cada uma — a aba "Sem
  // agrupamento" monopolizava o parâmetro `filtro`, e a aba "Famílias" lia um
  // endpoint que só aceitava `q`. Com uma lista só, o recorte deixou de
  // disputar o slot do filtro e nenhum card fica indisponível.
  function alternarFiltroKpi(key) {
    var def = null;
    for (var i = 0; i < KPI_DEFS.length; i++) if (KPI_DEFS[i].key === key) def = KPI_DEFS[i];

    if (AM.kpiAtivo === key || key === "total" || !def || !def.tipo) {
      // clicar de novo no mesmo card (ou em "Total") limpa o filtro
      AM.kpiAtivo = null;
      AM.filtros.status = "";
      AM.filtros.filtro = "";
    } else {
      AM.kpiAtivo = key;
      AM.filtros.status = def.tipo === "status" ? def.valor : "";
      AM.filtros.filtro = def.tipo === "filtro" ? def.valor : "";
    }
    AM.paginacao.page = 1;
    atualizarIndicadorFiltros();
    renderResumo();
    carregarAnuncios();
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
    // F5 — initLayout() saiu com o layout.js; vf-shell.js monta a navegação.
    bindEventosFixos();
    carregarProntidaoClientes();
    aplicarContextoDoShell();
  }

  /* ── CONTEXTO (F5 — vem do Shell V3, não mais desta tela) ──────────────
     A tela tinha uma VIEW inteira só para escolher o cliente e um seletor
     de conta Mercado Livre por cima. Os dois viraram o mesmo par de
     dropdowns do Shell, e a regra de cardinalidade voltou a existir num
     lugar só (vf-context.js, R8).

     O listener é registrado no init(), que roda enquanto este script
     clássico é avaliado — antes de vf-shell.js (module, deferido) publicar
     o store —, então nenhum emit se perde. */
  function contextoDoShell() {
    var store = window.VF && window.VF.context ? window.VF.context : null;
    var ctx = store ? store.getContext() : null;
    // Escopo CONTA: cliente sem operação ainda não é contexto para esta tela.
    // `vf:context` emite durante a resolução das contas (cliente já
    // conhecido, conta ainda não) — buscar aí gastaria uma requisição para
    // um recorte que o operador não escolheu.
    if (!ctx || !ctx.clienteSlug || !ctx.clienteContaId) return null;
    var cliente = store.getClienteAtual ? store.getClienteAtual() : null;
    return {
      slug: ctx.clienteSlug,
      nome: cliente ? cliente.nome : ctx.clienteSlug,
      contaId: ctx.clienteContaId ? String(ctx.clienteContaId) : "",
    };
  }

  var ultimoContextoAplicado = null;
  function aplicarContextoDoShell() {
    var ctx = contextoDoShell();
    var chave = ctx ? ctx.slug + ":" + ctx.contaId : "";
    if (chave === ultimoContextoAplicado) return;
    ultimoContextoAplicado = chave;

    // O detalhe é de UM anúncio de UMA conta. Trocar de operação não pode
    // deixar o modal da conta anterior em tela — nem descartar em silêncio o
    // que o operador estava digitando: com alteração pendente, o modal fica e
    // pede a decisão; sem nada pendente, ele simplesmente fecha.
    if (DET && DET.aberto) {
      if (camposSujos().length) pedirConfirmacaoSaida();
      else fecharDetalhe(true);
    }

    // Trocar de cliente/conta invalida o cache de expansões: ele é indexado só
    // por family_id, então sem isso um agrupador do cliente anterior
    // reapareceria para o cliente novo. A época sobe junto para descartar toda
    // expansão que ainda esteja em voo.
    resetarExpansoes();

    if (!ctx) { AM.clienteAtual = null; AM.contaMlId = ""; return; }

    AM.clienteAtual = { slug: ctx.slug, nome: ctx.nome };
    AM.contaMlId = ctx.contaId;
    AM.resumo = null;
    AM.anuncios = [];
    AM.paginacao.page = 1;
    AM.filtros = { q: "", status: "", filtro: "" };
    AM.kpiAtivo = null;
    if (el("am-busca")) el("am-busca").value = "";
    atualizarIndicadorFiltros();
    renderHudHeader();
    carregarResumo();
    carregarAnuncios();
  }

  // Zera o cache de agrupadores expandidos/pré-carregados. Chamado na troca
  // de contexto. `familyFetchEmVoo` some junto: sem isso, uma família com o
  // MESMO family_id na conta nova reaproveitaria a Promise da conta velha
  // (fechada sobre a query string errada). performanceCache/faturamentoCache
  // (por item_id) NÃO são zerados — item_id é global no Mercado Livre. Já
  // faturamentoPorFamiliaCache é indexado por family_id, o MESMO problema de
  // familyCache (não é global) — precisa zerar junto, senão o percentual
  // consolidado da conta anterior vazaria para uma família de mesmo id na
  // conta nova.
  function resetarExpansoes() {
    AM.state.familyCache = {};
    AM.state.familyFetchEmVoo = {};
    AM.state.familyFetchFalhou = {};
    AM.state.faturamentoPorFamiliaCache = {};
    AM.state.faturamentoFamiliaEmVoo = {};
    AM.familiaEpoca++;
  }

  function bindEventosFixos() {
    document.addEventListener("vf:context", aplicarContextoDoShell);
    el("am-busca").addEventListener("input", function (e) {
      AM.filtros.q = e.target.value;
      atualizarIndicadorFiltros();
      if (AM.buscaTimer) clearTimeout(AM.buscaTimer);
      AM.buscaTimer = setTimeout(function () {
        // Uma busca, uma lista. O backend casa o termo por item (título, MLB,
        // SKU, MLBU ou nome da família) e devolve o GRUPO inteiro de quem
        // casou — um anúncio nunca aparece órfão do seu agrupador.
        AM.paginacao.page = 1;
        // Uma busca nova é um contexto novo — nenhuma ordenação (local ou
        // global) sobrevive a ela (comportamento de sempre, de quando os 4
        // critérios eram locais). Zerar aqui garante que carregarAnuncios()
        // caia no branch que reseta o combo pra "Padrão" (ver o `else` logo
        // abaixo de `if (AM.ordenarPor)`).
        AM.ordenarPor = null;
        carregarAnuncios();
      }, 350);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        fecharDetalhe();
        fecharMenuOrdenacao();
      }
    });
    if (el("am-ordenacao")) {
      el("am-ordenacao").addEventListener("change", function (e) {
        var criterio = e.target.value;
        if (!criterio) {
          // Se o critério anterior era GLOBAL (faturamento/Curva ABC), voltar
          // a "Padrão" precisa reconsultar o backend (a ordem padrão nunca
          // existiu em memória — AM_ordemOriginalAnuncios fica null durante
          // ordenação global, de propósito, ver carregarAnuncios) — nunca
          // restaurar um snapshot local (que ou é a própria ordem global, ou
          // é uma ordem local antiga já obsoleta). Se era LOCAL (Margem/
          // Unidades) ou nenhum, o restore em memória de sempre continua.
          var eraGlobal = !!AM.ordenarPor;
          AM.ordenarPor = null;
          if (eraGlobal) {
            AM.paginacao.page = 1;
            carregarAnuncios();
            return;
          }
          aplicarOrdenacaoPerformance(null);
          return;
        }
        if (ORDENACOES_GLOBAIS[criterio]) {
          AM.ordenarPor = criterio;
          AM.paginacao.page = 1;
          carregarAnuncios();
          return;
        }
        // Margem/Unidades: ordenação LOCAL de sempre, nunca junto com uma
        // ordenação global ativa — as duas são mutuamente exclusivas no
        // mesmo <select>.
        AM.ordenarPor = null;
        aplicarOrdenacaoPerformance(criterio);
      });
    }
    if (el("am-ordenacao-trigger")) {
      montarMenuOrdenacao();
      sincronizarComboOrdenacao();
      el("am-ordenacao-trigger").addEventListener("click", function (e) {
        e.stopPropagation();
        alternarMenuOrdenacao();
      });
      el("am-ordenacao-dir").addEventListener("click", alternarDirecaoOrdenacao);
      document.addEventListener("click", function (e) {
        var combo = el("am-ordenacao-combo");
        if (combo && !combo.contains(e.target)) fecharMenuOrdenacao();
      });
    }
  }

  // ===========================================================================
  // Prontidão dos clientes — fonte, não seletor (F5)
  // ===========================================================================
  // GET /anuncios-meli/clientes continua sendo chamado: ele é quem sabe se a
  // conta ML do cliente está conectada. Deixou de virar um grid clicável — a
  // escolha é do Shell. `prontidaoCarregada` distingue "ainda não sei" de
  // "sei que este cliente não está aqui": sem isso, o intervalo entre o boot
  // e a resposta pareceria "Sem conexão ML", que é uma afirmação.
  function carregarProntidaoClientes() {
    api("/anuncios-meli/clientes").then(function (r) {
      AM.clientes = r.data && r.data.ok && Array.isArray(r.data.clientes) ? r.data.clientes : [];
      AM.prontidaoCarregada = !!(r.data && r.data.ok);
      if (AM.clienteAtual) renderHudHeader();
    });
  }

  // ===========================================================================
  // VIEW 2 — HUD do cliente
  // ===========================================================================
  function renderHudHeader() {
    var c = AM.clienteAtual;
    var resumo = AM.resumo;
    var clienteCompleto = AM.clientes.find(function (item) { return item.slug === c.slug; }) || null;
    // Três estados, não dois: conectado · não conectado · não sabemos ainda
    // (ou este cliente não está na lista de Anúncios ML). Renderizar
    // "Sem conexão ML" para o terceiro caso seria afirmar um diagnóstico
    // que não foi feito.
    var conexao = clienteCompleto
      ? (clienteCompleto.mlConectado ? { cls: "is-success", txt: "ML conectado" } : { cls: "is-danger", txt: "Sem conexão ML" })
      : (AM.prontidaoCarregada ? { cls: "is-warning", txt: "Fora da lista de Anúncios ML" } : { cls: "is-info", txt: "Verificando conexão ML…" });
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
            '<span class="vf-status ' + conexao.cls + '">' + conexao.txt + "</span></div>" +
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
    var meuToken = ++AM.resumoToken;
    var qs = "clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug);
    if (AM.contaMlId) qs += "&clienteContaId=" + encodeURIComponent(AM.contaMlId);
    api("/anuncios-meli/resumo?" + qs)
      .then(function (r) {
        if (meuToken !== AM.resumoToken) return; // troca de conta/cliente já disparou outra busca
        if (r.data && r.data.ok) {
          AM.resumo = r.data.resumo;
          renderHudHeader();
          renderResumo();
        }
      });
  }

  function renderResumo() {
    var r = AM.resumo || {};
    var html = "";
    KPI_DEFS.forEach(function (k) {
      var ativo = AM.kpiAtivo === k.key;
      var meta = typeof k.meta === "function" ? k.meta(r) : k.meta;
      html += '<button type="button" class="vf-metric am-kpi' +
        (k.accent ? " is-" + k.accent : "") +
        (ativo ? " is-active" : "") + '" data-kpi="' + k.key + '"' +
        (ativo ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' +
        '<span class="vf-metric__label">' + k.label + "</span>" +
        '<strong class="vf-metric__value">' + (r[k.campo] || 0) + "</strong>" +
        '<span class="vf-metric__foot is-' + k.estado + '">' + meta + "</span></button>";
    });
    var box = el("am-resumo");
    box.innerHTML = html;
    box.querySelectorAll("[data-kpi]").forEach(function (btn) {
      btn.addEventListener("click", function () { alternarFiltroKpi(this.getAttribute("data-kpi")); });
    });
  }

  // A LISTA. Uma requisição, uma ordenação, uma paginação — para anúncios
  // agrupados e não agrupados. O endpoint devolve linhas já resolvidas em
  // grupo (ver docs/AUDITORIA_ANUNCIOS_ML_LISTAGEM_UNIFICADA.md §4.5); a tela
  // não intercala nada e não decide quem agrupa com quem.
  function carregarAnuncios() {
    if (!AM.clienteAtual) return;
    var meuToken = ++AM.catalogoToken;
    var box = el("am-catalogo-container");

    AM.carregandoCatalogo = true;
    box.innerHTML = estadoHtml("loading", "Carregando anúncios…");

    var qs = "clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug) +
             "&page=" + AM.paginacao.page + "&limit=" + AM.paginacao.limit;
    if (AM.filtros.q) qs += "&q=" + encodeURIComponent(AM.filtros.q);
    if (AM.filtros.status) qs += "&status=" + encodeURIComponent(AM.filtros.status);
    if (AM.filtros.filtro) qs += "&filtro=" + encodeURIComponent(AM.filtros.filtro);
    if (AM.contaMlId) qs += "&clienteContaId=" + encodeURIComponent(AM.contaMlId);
    if (AM.ordenarPor) qs += "&ordenarPor=" + encodeURIComponent(AM.ordenarPor);

    api("/anuncios-meli/familias?" + qs).then(function (r) {
      if (meuToken !== AM.catalogoToken) return; // troca de conta/cliente (ou novo filtro) já disparou outra busca
      AM.carregandoCatalogo = false;
      if (!r.data || !r.data.ok) {
        box.innerHTML = estadoHtml("error", "Erro ao carregar",
          (r.data && r.data.motivo) || "Tente novamente.");
        return;
      }
      AM.anuncios = r.data.anuncios || [];
      AM.paginacao = r.data.paginacao || AM.paginacao;

      // Ordenação GLOBAL: o backend já manda o valor que decidiu a posição
      // (faturamentoPercentual/curvaAbc) — escreve nos MESMOS caches que as
      // células da lista já leem (faturamentoCelulaHtml/badgesAnuncioHtml),
      // sem uma 2ª chamada a /performance (ver auditoria "ordenação global
      // limitada à página atual").
      if (AM.ordenarPor) {
        // Qualquer snapshot local (AM_ordemOriginalAnuncios) que ainda
        // existisse só poderia descrever a página ANTERIOR — nunca esta que
        // acabou de chegar. Zera aqui também (não só no branch "sem
        // ordenarPor" abaixo): sem isso, uma sequência local -> global ->
        // "Padrão" restauraria o snapshot congelado do momento da ordenação
        // LOCAL, mostrando itens que não batem com a paginação global atual.
        AM_ordemOriginalAnuncios = null;
        AM.anuncios.forEach(function (linha) {
          if (linha.faturamentoPercentual === undefined && linha.curvaAbc === undefined) return;
          var cacheItem = linha.tipo === "familia" ? AM.state.faturamentoPorFamiliaCache : AM.state.faturamentoCache;
          var cacheValor = linha.tipo === "familia" ? AM.state.faturamentoValorPorFamiliaCache : AM.state.faturamentoValorCache;
          var cacheAbc = linha.tipo === "familia" ? AM.state.curvaAbcPorFamiliaCache : AM.state.curvaAbcCache;
          var chave = linha.tipo === "familia" ? linha.family_id : linha.item_id;
          if (linha.faturamentoPercentual !== undefined) cacheItem[chave] = linha.faturamentoPercentual;
          if (linha.faturamentoValor !== undefined) cacheValor[chave] = linha.faturamentoValor;
          if (linha.curvaAbc !== undefined) cacheAbc[chave] = linha.curvaAbc;
        });
        var aviso = el("am-ordenacao-aviso");
        if (aviso) {
          if (r.data.ordenacaoAplicada === false && r.data.ordenacaoIndisponivel) {
            aviso.textContent = r.data.ordenacaoIndisponivel.mensagem || "Não foi possível ordenar globalmente.";
            aviso.hidden = false;
          } else {
            aviso.hidden = true;
          }
        }
      } else {
        // Nova busca no backend já vem na ordem padrão — a ordem "original"
        // capturada por aplicarOrdenacaoPerformance para a página anterior não
        // serve mais, e qualquer ordenação LOCAL ativa deixa de fazer sentido
        // até o operador escolher de novo.
        AM_ordemOriginalAnuncios = null;
        if (el("am-ordenacao")) el("am-ordenacao").value = "";
        sincronizarComboOrdenacao();
        var avisoLimpo = el("am-ordenacao-aviso");
        if (avisoLimpo) avisoLimpo.hidden = true;
      }
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

    var html = '<div class="am-listagem" aria-label="Lista de anúncios">' +
      '<div class="am-listagem__head" aria-hidden="true">' +
        "<span></span><span>Anúncio</span><span>Status</span><span>Preço</span>" +
        "<span>Estoque</span><span>Vendidos</span><span>Faturamento</span><span>Métricas últ. 7 dias</span>" +
        "<span>Margem</span><span>Score VenForce</span><span></span>" +
      "</div>";
    // Mesma grade, mesmas colunas, mesma densidade para os dois tipos de
    // linha. O que muda é só o que existe embaixo: um agrupador abre, um
    // anúncio individual não tem nada para abrir (no modelo do ML a relação
    // ali é 1:1). Nenhuma moldura, cor ou seção separa os dois.
    AM.anuncios.forEach(function (linha, idx) {
      html += linha.tipo === "familia" ? rowGrupoHtml(linha, idx) : rowAnuncioHtml(linha, idx);
    });
    html += "</div>" + paginacaoHtml(AM.paginacao, "am-pag", "anúncio");
    box.innerHTML = html;

    bindLinhasAnuncio(box);
    bindEstoqueEditavel(box);

    box.querySelectorAll(".am-row--grupo[data-familia]").forEach(function (row) {
      row.addEventListener("click", function () { alternarGrupo(row); });
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); alternarGrupo(row); }
      });
    });

    bindPaginacao("am-pag", AM.paginacao, function (pagina) {
      AM.paginacao.page = pagina;
      carregarAnuncios();
    });

    // Métricas últ. 7 dias + margem + % faturamento chegam DEPOIS que a lista
    // já está na tela — nunca atrasam este render. A CÉLULA de margem
    // (percentual/status) já chegou PRONTA na própria resposta da listagem
    // (margemProjetadaPercent, ver anexarMargemProjetadaNaPagina no
    // controller/margemCelulaHtml) — fonte única, nunca mais lida daqui.
    // `incluirMargem` continua pedido porque `margem[itemId]` (a resposta
    // desta chamada) TAMBÉM carrega `precoAtual`/`precoOriginal` (preço AO
    // VIVO do Motor, ver celulaPrecoHtml) — efeito colateral do mesmo lote,
    // não uma chamada própria só de preço. Anúncios avulsos (tipo "item")
    // pedem as três NA MESMA chamada (faturamento reaproveita o mesmo porMlb
    // do Motor). Agrupadores pedem metricas7d dos filhos em background (ver
    // carregarMetricasDosGruposVisiveis); o % faturamento CONSOLIDADO da
    // família é outra chamada, própria (ver
    // carregarFaturamentoDasFamiliasVisiveis), porque exige `familias=` no
    // Motor, não os filhos individuais.
    carregarPerformance(
      AM.anuncios.filter(function (l) { return l.tipo === "item"; }).map(function (l) { return l.item_id; }),
      { incluirFaturamento: true, incluirCurvaAbc: true }
    );
    carregarMetricasDosGruposVisiveis();
    carregarFaturamentoDasFamiliasVisiveis();
  }

  // Linhas de anúncio da lista principal (tipo "item"). As linhas de MLB
  // dentro de um agrupador expandido têm o seu próprio bind (bindLinhasMlb),
  // porque são outra classe — mas abrem o MESMO modal.
  function bindLinhasAnuncio(raiz) {
    raiz.querySelectorAll(".am-row[data-item]").forEach(function (row) {
      function abrir() { abrirDetalhe(row.getAttribute("data-item"), row); }
      // Mesmas duas exceções da linha filha (ver bindLinhasMlb): controles
      // próprios da linha não podem abrir o modal por cima deles.
      function ehControleProprio(e) {
        return !!(e.target.closest(".am-row__link") || e.target.closest(".am-estoque") ||
          e.target.closest(".am-row__variacoes-toggle"));
      }
      row.addEventListener("click", function (e) {
        if (ehControleProprio(e)) return; // ação externa não abre o modal
        abrir();
      });
      row.addEventListener("keydown", function (e) {
        if (ehControleProprio(e)) return; // deixa o botão/link nativo agir (Enter = ativar)
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abrir(); }
      });
      var toggle = row.querySelector(".am-row__variacoes-toggle");
      if (toggle) toggle.addEventListener("click", function (e) {
        e.stopPropagation();
        alternarVariacoesLegado(row, toggle);
      });
    });
  }

  // ===========================================================================
  // LINHA DE AGRUPADOR — e a expansão Agrupador -> Item MLB
  //
  // A hierarquia do Mercado Livre tem três níveis (family_id ->
  // user_product_id -> item_id) e a tela mostra os três, como a listagem
  // oficial do ML:
  //
  //   AGRUPADOR / FAMÍLIA
  //     └── VARIAÇÃO   (nome amigável + MLBU discreto)
  //          ├── MLB Clássico
  //          └── MLB Premium
  //
  // A variação voltou a ser nível visível, mas com o peso trocado: antes ela
  // era uma faixa "PRODUTO MLBU-123 · 2 anúncios" — o MLBU como manchete de um
  // nível. Agora a manchete é o NOME da variação ("Azul P") e o MLBU é
  // legenda, do tamanho de um SKU. O MLBU não é entidade operável: o nível não
  // tem handler, não expande, não abre nada.
  //
  // Ações por nível, de propósito:
  //   Agrupador -> só expandir/colapsar (a família é chave derivada do ML, não
  //                entidade operável: não tem preço nem status próprio);
  //   Variação  -> nada: é subtítulo dos MLBs, sem handler;
  //   Item MLB  -> abrirDetalhe() (o modal de sempre) e edição de ESTOQUE na
  //                própria linha — o único dado do anúncio que se escreve sem
  //                abrir o modal, porque no ML ele pertence à variação e não
  //                ao anúncio (ver salvarEstoque).
  //
  // Nenhum PAINEL abre sozinho — expandir (ver MLBs, editar estoque) é sempre
  // ação explícita do operador. O DETALHE da família, porém, é buscado
  // sozinho em BACKGROUND assim que a família aparece na página (ver
  // carregarMetricasDosGruposVisiveis), só para somar as métricas 7d na
  // linha-mãe — a primeira expansão de verdade (clique) reaproveita esse
  // cache (AM.state.familyCache, via GET /anuncios-meli/familias/:familyId) e
  // só então busca a margem, que o pré-carregamento nunca pede.
  // ===========================================================================

  function iconeChevronSvg() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
  }

  function plural(n, singular, pluralForma) {
    return n + " " + (n === 1 ? singular : pluralForma);
  }

  // Status do agrupador. A família não tem status no Mercado Livre — ela é
  // uma chave derivada de atributos. O que existe é o status de cada anúncio
  // dela, então a linha mostra o consenso e admite "Misto" quando não há:
  // inventar um status único seria afirmar algo que a API não diz.
  function statusGrupo(f) {
    var c = f.status_contagem || {};
    var total = f.total_itens || 0;
    if (total && c.ativos === total) return { label: "Ativo", classe: "is-success", titulo: "" };
    if (total && c.pausados === total) return { label: "Pausado", classe: "is-warning", titulo: "" };
    if (total && c.encerrados === total) return { label: "Encerrado", classe: "is-danger", titulo: "" };
    return {
      label: "Misto",
      classe: "is-info",
      titulo: (c.ativos || 0) + " ativos · " + (c.pausados || 0) + " pausados · " +
              (c.encerrados || 0) + " encerrados",
    };
  }

  // Preço do agrupador. "Preço por variação" é o nome da própria iniciativa do
  // ML: uma família existe justamente para ter preços diferentes por variação.
  // Faixa quando os extremos diferem, valor único quando coincidem.
  function precoGrupoHtml(f) {
    var min = f.preco_min, max = f.preco_max;
    if (min === null || min === undefined) return "—";
    if (max === null || max === undefined || Number(min) === Number(max)) {
      return escapeHtml(formatMoeda(min, f.moeda));
    }
    return '<span class="am-row__faixa">' + escapeHtml(formatMoeda(min, f.moeda)) +
      "<small>até " + escapeHtml(formatMoeda(max, f.moeda)) + "</small></span>";
  }

  // Uma linha de agrupador, na MESMA grade de 11 colunas de rowAnuncioHtml.
  // O painel de expansão é irmão da linha (não filho): .am-listagem é bloco,
  // não grade, então o painel simplesmente ocupa a largura inteira sem
  // precisar de caixa aninhada e sem desalinhar coluna nenhuma.
  function rowGrupoHtml(f, idx) {
    var painelId = "am-grupo-painel-" + idx;
    // A capa vem pronta em cover.thumbnail: o backend elege a variação que
    // representa a família (a mais relevante para a busca, quando há busca) a
    // cada leitura. O front NÃO deduz capa a partir dos itens — se fizesse
    // isso, a imagem só apareceria depois de expandir e poderia contradizer a
    // escolha da API.
    var capa = (f.cover && f.cover.thumbnail)
      ? '<img src="' + escapeHtml(f.cover.thumbnail) + '" alt="" loading="lazy" />'
      : iconeImagemSvg();
    var st = statusGrupo(f);
    var rotulo = f.family_name || "(família sem nome)";
    // Curva ABC CONSOLIDADA da família (Pareto sobre a receita somada dos
    // filhos, últ. 30d) — mesma tag/componente do card individual, nunca o
    // rótulo de um filho isolado. Wrapper SEMPRE renderizado (mesmo sem
    // classe ainda resolvida) para repintarLinhaDoGrupo/carregarFaturamento-
    // DasFamiliasVisiveis terem um alvo estável (ver AM.state.curvaAbcPorFamiliaCache).
    var badgesHtml = '<div class="am-row__badges"><span data-abc-familia="' + escapeAttr(f.family_id) + '">' +
      curvaAbcBadgeHtml(AM.state.curvaAbcPorFamiliaCache[f.family_id]) + "</span></div>";

    return '<div class="am-row am-row--grupo" data-familia="' + escapeAttr(f.family_id) + '" ' +
      'tabindex="0" role="button" aria-expanded="false" aria-controls="' + painelId + '" ' +
      'aria-label="Ver as variações de ' + escapeAttr(rotulo) + '">' +
      '<div class="am-row__thumb" aria-hidden="true">' + capa + "</div>" +
      '<div class="am-row__main">' +
        '<h3 class="am-row__titulo">' + escapeHtml(rotulo) + "</h3>" +
        '<div class="am-row__ids">' +
          // O identificador do AGRUPADOR, na mesma posição em que a linha do
          // anúncio individual mostra o MLB — é o "ID maior" do produto. Vem
          // rotulado porque, ao contrário de um MLB, family_id é um número
          // solto: sem o rótulo seria indistinguível de qualquer outro número
          // da linha. MLBU não aparece aqui nem em lugar nenhum da UI.
          '<span>Família <span class="vf-mono">' + escapeHtml(f.family_id) + "</span></span>" +
          "<span>" + plural(f.total_user_products || 0, "variação", "variações") + "</span>" +
          "<span>" + plural(f.total_itens || 0, "anúncio", "anúncios") + "</span>" +
        "</div>" +
        badgesHtml +
      "</div>" +
      '<span class="vf-status ' + st.classe + '"' +
        (st.titulo ? ' title="' + escapeAttr(st.titulo) + '"' : "") + ">" + st.label + "</span>" +
      '<span class="am-row__preco">' + precoGrupoHtml(f) + "</span>" +
      // A soma que dá sentido ao agrupador: estoque por User Product distinto.
      '<span class="am-row__num" title="Soma do estoque das ' +
        escapeAttr(plural(f.total_user_products || 0, "variação", "variações")) + '">' +
        (f.estoque_total != null ? f.estoque_total : "—") + "</span>" +
      '<span class="am-row__num">' + (f.vendidos_total != null ? f.vendidos_total : "—") + "</span>" +
      // % faturamento CONSOLIDADO da família — vem pronto do backend
      // (dados.faturamento.porFamilia), mesma regra da Curva ABC acima:
      // nunca o percentual de um filho isolado.
      faturamentoAgregadoCelulaHtml(f.family_id) +
      // Métricas 7d: soma dos filhos, buscada sozinha em BACKGROUND assim
      // que a família aparece na página — não depende de expandir (ver
      // carregarMetricasDosGruposVisiveis/metricas7dAgregadoCelulaHtml).
      // Margem NUNCA agrega num número único (regra do usuário mantida) —
      // mas a família mostra a FAIXA (mínimo–máximo) de Margem Projetada dos
      // filhos, quando disponível (ver margemFaixaFamiliaHtml).
      metricas7dAgregadoCelulaHtml(f.family_id) +
      margemFaixaFamiliaHtml(f) +
      scoreGaugeHtml(f.score_min) +
      '<div class="am-row__acao">' +
        '<span class="am-row__chevron" aria-hidden="true">' + iconeChevronSvg() + "</span>" +
      "</div>" +
    "</div>" +
    '<div class="am-grupo-painel" id="' + painelId + '" hidden></div>';
  }

  // Ponto ÚNICO de leitura do detalhe de uma família: cache -> Promise já em
  // voo (o pré-carregamento em background e um clique do operador na MESMA
  // família nunca disparam duas requisições) -> requisição nova. `época`
  // continua protegendo contra resposta tardia depois de trocar
  // cliente/conta — uma resposta cuja época não bate nunca escreve no cache
  // nem é devolvida (resolve pra null, e quem chamou trata como falha).
  function garantirFamiliaDetalhe(familyId) {
    var cache = AM.state.familyCache[familyId];
    if (cache) return Promise.resolve(cache);
    var emVoo = AM.state.familyFetchEmVoo[familyId];
    if (emVoo) return emVoo;

    var minhaEpoca = AM.familiaEpoca;
    var qs = "clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug);
    if (AM.contaMlId) qs += "&clienteContaId=" + encodeURIComponent(AM.contaMlId);

    var promessa = api("/anuncios-meli/familias/" + encodeURIComponent(familyId) + "?" + qs).then(function (r) {
      delete AM.state.familyFetchEmVoo[familyId];
      if (minhaEpoca !== AM.familiaEpoca) return null; // outro cliente/conta assumiu a tela
      if (!r.data || !r.data.ok || !r.data.familia) return null;
      AM.state.familyCache[familyId] = r.data.familia;
      return r.data.familia;
    });
    AM.state.familyFetchEmVoo[familyId] = promessa;
    return promessa;
  }

  // Garante metricas7d (+ margem, quando pedida) dos filhos de UMA família já
  // conhecida (precisa estar em AM.state.familyCache — quem ainda não tem
  // detalhe usa garantirFamiliaDetalhe antes). Delega a carregarPerformance,
  // que já dedupe por item/aspecto — chamar isto de novo sem nada pendente
  // não gasta requisição nenhuma.
  //
  // A CÉLULA de margem (percentual/status) NUNCA lê o resultado desta chamada
  // — já vem PRONTA no próprio detalhe da família (item.margemProjetadaPercent,
  // ver garantirFamiliaDetalhe/margemCelulaHtml). `incluirMargem` continua
  // pedido aqui só ao expandir porque `margem[itemId]` (a resposta de
  // /performance) TAMBÉM carrega `precoAtual`/`precoOriginal` (preço AO VIVO
  // do Motor, ver celulaPrecoHtml) — efeito colateral do mesmo lote, não
  // duplicado por uma chamada própria só de preço.
  function garantirPerformanceDaFamilia(familyId, incluirMargem) {
    var familia = AM.state.familyCache[familyId];
    if (!familia) return Promise.resolve();
    var ids = [];
    (familia.user_products || []).forEach(function (up) {
      (up.itens || []).forEach(function (item) { ids.push(item.item_id); });
    });
    if (!ids.length) return Promise.resolve();
    // % faturamento e Curva ABC INDIVIDUAIS do filho seguem a MESMA porta que
    // o preço ao vivo: só quando a família é EXPANDIDA (incluirMargem=true) —
    // bundlados de graça no mesmo lote (ver auditoria "Anúncios ML —
    // participação no faturamento em famílias" e "Curva ABC sempre visível +
    // faturamento absoluto"). Filho ainda oculto (pré-carregamento em
    // background, incluirMargem=false) continua sem gastar o Motor. A
    // consolidada da família (porFamilia/curvaAbc.porFamilia) não passa por
    // aqui — vem de carregarFaturamentoDasFamiliasVisiveis, sem relação com isto.
    return carregarPerformance(ids, { incluirMargem: incluirMargem, incluirFaturamento: incluirMargem, incluirCurvaAbc: incluirMargem });
  }

  // Depois do primeiro paint (nunca atrasa o render — mesmo padrão da busca
  // de performance dos itens avulsos), busca em BACKGROUND o detalhe de cada
  // agrupador VISÍVEL nesta página e, com os filhos já conhecidos, as
  // métricas 7d deles — só para preencher a SOMA na linha-mãe sem exigir
  // clique. Margem NUNCA entra aqui (incluirMargem: false): filho ainda
  // oculto não pode gastar o Motor de Margem só para calcular um agregado
  // que nem existe (ver rowGrupoHtml — margem é só por MLB). O resultado
  // fica em AM.state.familyCache/performanceCache — expandir depois lê
  // daqui, nunca refaz a chamada.
  function carregarMetricasDosGruposVisiveis() {
    AM.anuncios.forEach(function (l) {
      if (l.tipo !== "familia") return;
      var familyId = l.family_id;
      garantirFamiliaDetalhe(familyId).then(function (familia) {
        if (!familia) {
          // Detalhe não veio (rede, 404, época trocou): sem filhos conhecidos
          // não há soma possível — marca para a célula sair de "carregando"
          // e virar "—" em vez de ficar presa para sempre.
          AM.state.familyFetchFalhou[familyId] = true;
          repintarLinhaDoGrupo(familyId);
          return;
        }
        return garantirPerformanceDaFamilia(familyId, false).then(function () {
          // Cobre tanto o caminho feliz quanto a falha da chamada de
          // metricas7d: se o agregado ainda não é computável depois desta
          // tentativa, marca como falhou — mesma régua "—" de qualquer
          // célula desta tela, nunca um spinner permanente.
          AM.state.familyFetchFalhou[familyId] = !metricas7dAgregadoDoGrupo(familyId);
          repintarLinhaDoGrupo(familyId);
        });
      });
    });
  }

  // Expandir/colapsar. Colapsar NÃO descarta o que já foi renderizado, e
  // reabrir lê AM.state.familyCache — nenhuma requisição nova.
  function alternarGrupo(linha) {
    var painel = linha.nextElementSibling;
    if (!painel || !painel.classList.contains("am-grupo-painel")) return;
    var familyId = linha.getAttribute("data-familia");
    var abrindo = linha.getAttribute("aria-expanded") !== "true";

    linha.setAttribute("aria-expanded", abrindo ? "true" : "false");
    linha.classList.toggle("is-aberta", abrindo);
    painel.hidden = !abrindo;
    if (!abrindo) return;

    var cache = AM.state.familyCache[familyId];
    if (cache) {
      // Já conhecida (clique repetido, ou o pré-carregamento em background já
      // respondeu): pinta na hora. A margem dos filhos, porém, só é buscada
      // AGORA — o pré-carregamento nunca a pede (ver carregarMetricasDosGruposVisiveis).
      renderFamiliaDetalhe(cache, painel);
      garantirPerformanceDaFamilia(familyId, true).then(function () { repintarLinhaDoGrupo(familyId); });
      return;
    }
    if (painel.getAttribute("data-carregando") === "1") return; // já tem um clique em voo
    carregarFamiliaDetalhe(familyId, painel);
  }

  function carregarFamiliaDetalhe(familyId, painel) {
    painel.setAttribute("data-carregando", "1");
    painel.innerHTML = estadoHtml("loading", "Carregando produtos da família…");

    // Reaproveita a MESMA Promise do pré-carregamento em background, se
    // houver uma em voo para esta família — nunca duas requisições para o
    // mesmo family_id só porque uma partiu sozinha e a outra veio de um
    // clique.
    garantirFamiliaDetalhe(familyId).then(function (familia) {
      painel.removeAttribute("data-carregando");
      if (!familia) {
        painel.innerHTML = estadoHtml("error", "Erro ao carregar a família", "Tente novamente.");
        return;
      }
      renderFamiliaDetalhe(familia, painel);

      // Métricas 7d (se o pré-carregamento ainda não tiver respondido) +
      // margem (que o pré-carregamento NUNCA pede) dos filhos. Quando os
      // dois terminam (sucesso OU falha — o que importa é não estar mais em
      // voo), a linha-mãe repinta com a soma. Margem nunca agrega (ver
      // rowGrupoHtml) — só as métricas de tráfego/venda fazem sentido somadas.
      garantirPerformanceDaFamilia(familyId, true).then(function () {
        repintarLinhaDoGrupo(familyId);
      });
    });
  }

  function renderFamiliaDetalhe(familia, painel) {
    var ups = familia.user_products || [];
    if (!ups.length) {
      painel.innerHTML = estadoHtml("empty", "Família sem produtos visíveis",
        "Nenhum anúncio desta família pertence à operação selecionada.");
      return;
    }
    var html = "";
    ups.forEach(function (up) { html += variacaoHtml(up, familia); });
    painel.innerHTML = html;
    bindLinhasMlb(painel);
    bindEstoqueEditavel(painel);
    // Expandir não mexe na capa: ela já veio decidida na listagem.
  }

  // ===========================================================================
  // EXPANSÃO DO MODELO LEGADO — item_id -> variations[] do Mercado Livre
  //
  // Um anúncio "item" com variations_count > 0 (ver rowAnuncioHtml) não tem
  // User Product: no ML a hierarquia dele é só item_id -> variations[], sem
  // nível intermediário. Por isso a expansão pinta as variações DIRETO como
  // filhas da própria linha do item — nunca um agrupador/família/MLBU fake
  // entre elas.
  //
  //   Anúncio (item_id)
  //     ├─ Preto · 34 BR
  //     ├─ Preto · 35 BR
  //     └─ Nude · 34 BR
  //
  // Mesmo padrão de cache/dedupe de garantirFamiliaDetalhe, só que por
  // item_id em vez de family_id, e SEM pré-carregamento em background: a
  // família pré-carrega para somar métricas na linha-mãe (ver
  // carregarMetricasDosGruposVisiveis); o item avulso não tem soma nenhuma
  // para fazer, então só busca quando o operador clica.
  //
  // Preço é só leitura aqui (ver celulaPrecoVariacaoLegadoHtml). Estoque É
  // editável por variação (ver bloco "ESTOQUE DE VARIAÇÃO LEGADA" abaixo) —
  // o card PRINCIPAL do item, esse sim, nunca edita estoque quando há
  // variações (rowAnuncioHtml): o ML trata available_quantity da raiz como
  // agregado quando existe variations[] (variacoes.md, "Modificar estoque"),
  // então a única escrita seria por variação de qualquer forma.
  // podeEditarEstoque/motivoBloqueio já vêm decididos pelo backend
  // (mapearVariacaoLegado -> avaliarBloqueioEdicaoVariacaoLegado) — esta tela
  // nunca interpreta inventory_id/logistic_type sozinha.
  // ===========================================================================

  function garantirVariacoesLegado(itemId) {
    var cache = AM.state.variacoesLegadoCache[itemId];
    if (cache) return Promise.resolve(cache);
    var emVoo = AM.state.variacoesLegadoFetchEmVoo[itemId];
    if (emVoo) return emVoo;

    var minhaEpoca = AM.familiaEpoca;
    var qs = "clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug);
    if (AM.contaMlId) qs += "&clienteContaId=" + encodeURIComponent(AM.contaMlId);

    var promessa = api("/anuncios-meli/" + encodeURIComponent(itemId) + "/variacoes-legado?" + qs).then(function (r) {
      delete AM.state.variacoesLegadoFetchEmVoo[itemId];
      if (minhaEpoca !== AM.familiaEpoca) return null; // outro cliente/conta assumiu a tela
      if (!r.data || !r.data.ok || !Array.isArray(r.data.variacoes)) return null;
      AM.state.variacoesLegadoCache[itemId] = r.data.variacoes;
      return r.data.variacoes;
    });
    AM.state.variacoesLegadoFetchEmVoo[itemId] = promessa;
    return promessa;
  }

  // Expandir/colapsar o painel do item. O CLIQUE fica no botão (toggle), não
  // na linha inteira: a linha continua abrindo o modal de detalhe, como
  // qualquer outro anúncio (ver bindLinhasAnuncio/ehControleProprio).
  function alternarVariacoesLegado(row, toggle) {
    var painel = row.nextElementSibling;
    if (!painel || !painel.classList.contains("am-grupo-painel")) return;
    var itemId = row.getAttribute("data-item");
    var abrindo = toggle.getAttribute("aria-expanded") !== "true";

    toggle.setAttribute("aria-expanded", abrindo ? "true" : "false");
    row.classList.toggle("is-aberta", abrindo);
    painel.hidden = !abrindo;
    if (!abrindo) return;

    var cache = AM.state.variacoesLegadoCache[itemId];
    if (cache) { renderVariacoesLegadoDetalhe(cache, painel, itemId); return; }
    if (painel.getAttribute("data-carregando") === "1") return; // já tem um clique em voo
    carregarVariacoesLegado(itemId, painel);
  }

  function carregarVariacoesLegado(itemId, painel) {
    painel.setAttribute("data-carregando", "1");
    painel.innerHTML = estadoHtml("loading", "Carregando variações do Mercado Livre…");

    garantirVariacoesLegado(itemId).then(function (variacoes) {
      painel.removeAttribute("data-carregando");
      if (!variacoes) {
        painel.innerHTML = estadoHtml("error", "Erro ao carregar as variações", "Tente novamente.");
        return;
      }
      renderVariacoesLegadoDetalhe(variacoes, painel, itemId);
    });
  }

  function renderVariacoesLegadoDetalhe(variacoes, painel, itemId) {
    if (!variacoes.length) {
      painel.innerHTML = estadoHtml("empty", "Nenhuma variação encontrada",
        "O Mercado Livre não devolveu variações para este anúncio.");
      return;
    }
    var anuncio = AM.anuncios.find(function (a) { return a.item_id === itemId; });
    var moeda = anuncio && anuncio.moeda;
    var html = "";
    variacoes.forEach(function (v) { html += rowVariacaoLegadoHtml(v, moeda, itemId); });
    painel.innerHTML = html;
    bindEstoqueVariacaoLegadoEditavel(painel);
  }

  // Uma variação do modelo LEGADO — MESMA grade de rowMlbCompactaHtml (nunca
  // desalinha o cabeçalho), mas as células que o ML não reporta por variação
  // (status, métricas 7d, margem, score) ficam "—" explicado por título, em
  // vez de inventar um valor. O estoque é editável (ver bloco "ESTOQUE
  // EDITÁVEL DE VARIAÇÃO LEGADA" mais abaixo); as demais colunas sem dado por
  // variação continuam sem ação, porque não há o que editar nelas.
  function rowVariacaoLegadoHtml(v, moeda, itemId) {
    var rotulo = (v.atributos || []).length
      ? v.atributos.map(function (at) { return at.valor; }).join(" · ")
      : "Variação sem atributos";
    // image_url vem do backend já resolvida (variation.picture_ids ->
    // item.pictures, com fallback pra capa do item) — ver
    // meliVariacoesLegadoService.construirMapaImagensDoItem. Duas variações
    // podem legitimamente compartilhar a mesma URL (mesma capa do item); isso
    // não é bug, é o fallback documentado funcionando.
    var img = v.image_url
      ? '<img src="' + escapeHtml(v.image_url) + '" alt="" loading="lazy" />'
      : iconeImagemSvg();
    return '<div class="am-mlb am-mlb--variacao-legado" data-variacao="' + escapeAttr(v.id) + '">' +
      '<span class="am-mlb__thumb" aria-hidden="true">' + img + "</span>" +
      '<span class="am-mlb__main">' +
        '<span class="am-mlb__titulo">' + escapeHtml(rotulo) + "</span>" +
        '<span class="am-mlb__ids"><span class="vf-mono">Variação ' + escapeHtml(String(v.id)) + "</span></span>" +
      "</span>" +
      '<span class="vf-status is-empty" title="O Mercado Livre não reporta status por variação — só por anúncio (MLB)">—</span>' +
      celulaPrecoVariacaoLegadoHtml(v, itemId, moeda) +
      celulaEstoqueVariacaoLegadoHtml(v, itemId) +
      '<span class="am-mlb__num">' + (v.vendidos != null ? v.vendidos : "—") + "</span>" +
      '<span class="am-faturamento am-faturamento--indisponivel" title="O faturamento é calculado só por anúncio (MLB) — não existe um percentual por variação">—</span>' +
      '<span class="am-metricas7d am-metricas7d--indisponivel" title="Métricas últ. 7 dias são só por anúncio (MLB) — o Mercado Livre não as reporta por variação">—</span>' +
      '<span class="am-margem am-margem--indisponivel" title="Margem é só por anúncio (MLB) — o Mercado Livre não reporta custo por variação">—</span>' +
      '<span class="am-mlb__score">—</span>' +
      '<span class="am-mlb__acao"></span>' +
    "</div>";
  }

  // Condição comercial do anúncio: é o que distingue dois MLBs da MESMA
  // variação, e virou informação necessária quando o nível do MLBU saiu da
  // tela. Deriva de listing_type_id pelo mesmo mapa que o modal de detalhe já
  // usava (TIPO_ANUNCIO) — nenhum rótulo novo, nenhuma regra nova.
  function condicaoComercial(a) {
    if (!a.listing_type_id) return "";
    return TIPO_ANUNCIO[a.listing_type_id] || a.listing_type_id;
  }

  // Ordem dos filhos dentro de uma variação. O padrão operacional do negócio é
  // Clássico + Premium por variação, e é essa a leitura que o ML dá — mas o
  // padrão NÃO é regra: a ordem é só preferência de exibição, com desempate
  // por item_id. Um tipo desconhecido, ou variação com 1 ou com 5 MLBs,
  // continua funcionando sem caso especial.
  var ORDEM_CONDICAO = { gold_special: 1, gold_pro: 2 };

  function ordenarFilhos(itens) {
    return itens.slice().sort(function (a, b) {
      var pa = ORDEM_CONDICAO[a.listing_type_id] || 9;
      var pb = ORDEM_CONDICAO[b.listing_type_id] || 9;
      if (pa !== pb) return pa - pb;
      return String(a.item_id).localeCompare(String(b.item_id));
    });
  }

  // ---------------------------------------------------------------------------
  // NOME AMIGÁVEL DA VARIAÇÃO — o "Azul 36" da listagem oficial do ML.
  //
  // Sai do TÍTULO do próprio anúncio. No modelo de User Products o ML compõe o
  // título do item como family_name + os valores dos atributos que variam:
  //
  //     family_name : "Apple iPhone 256GB"
  //     title       : "Apple iPhone 256GB Rojo"   ->  variação: "Rojo"
  //
  // (documentacao_api_meli/preco-variacao.md, resposta de criação de item; e
  // "se o family_name for modificado, o título do item será recalculado").
  // E `title` está na lista de campos SINCRONIZADOS por User Product
  // (user-products.md): o título pertence à VARIAÇÃO, não à condição de venda.
  // É isso que autoriza o título a nomeá-la — os dois MLBs de uma variação têm
  // o mesmo título por definição do ML.
  //
  // Por que NÃO pelos atributos: quem define a variação são os atributos com
  // hierarchy CHILD_PK / tag variation_attribute, e meliSyncService grava
  // attributes_json só como {id, name, value} — descarta `tags` e `hierarchy`.
  // Sem eles não há como saber qual atributo varia, e o conjunto depende da
  // categoria: cravar COLOR/SIZE seria regra inventada. O caminho documentado
  // para resolver isso de verdade é GET /user-products-families/{family_id},
  // que devolve `child_attributes_ids` — mas é chamada e persistência novas,
  // ou seja, reabrir a sincronização. Fica registrado, não feito.
  //
  // Quando o título não começa pelo family_name (título legado, family_name
  // trocado depois, item que nunca passou por UPtin) não existe sufixo para
  // extrair — e aí o nome é o título INTEIRO, que é o melhor identificador
  // fiel do payload. Nunca um recorte adivinhado.
  // ---------------------------------------------------------------------------

  // O título que representa a variação. É o do primeiro item com título: eles
  // são iguais entre irmãos por sincronização do ML, e quando um difere (linha
  // velha no snapshot) esse item mostra o seu na própria linha.
  function tituloDaVariacao(itens) {
    for (var i = 0; i < itens.length; i++) {
      if (itens[i] && itens[i].titulo) return itens[i].titulo;
    }
    return "";
  }

  function skuDaVariacao(itens) {
    for (var i = 0; i < itens.length; i++) {
      if (itens[i] && itens[i].sku) return itens[i].sku;
    }
    return "";
  }

  function nomeVariacao(itens, familyName) {
    var base = tituloDaVariacao(itens);
    if (!base) {
      // Sem título, o próximo identificador fiel é o SKU. Sem nenhum dos dois
      // não se inventa nome: o MLBU já está na legenda, abaixo.
      var sku = skuDaVariacao(itens);
      return sku
        ? { nome: sku, origem: "sku" }
        : { nome: "Variação sem nome", origem: "vazio" };
    }
    var fam = String(familyName || "").trim();
    if (fam && base.length > fam.length &&
        base.slice(0, fam.length).toLowerCase() === fam.toLowerCase()) {
      // Separadores que o vendedor costuma pôr entre o nome do produto e a
      // variação ("Camiseta - Azul P"): saem do começo do sufixo para o rótulo
      // não abrir com pontuação solta.
      var sufixo = base.slice(fam.length).replace(/^[\s\-–—,:;/|]+/, "").trim();
      if (sufixo) return { nome: sufixo, origem: "sufixo" };
    }
    return { nome: base, origem: "titulo" };
  }

  // Bloco de uma variação: nome amigável em destaque, MLBU como legenda, e os
  // MLBs logo abaixo — a leitura da listagem oficial do ML.
  //
  // O nível é SUBTÍTULO, não entidade: não tem handler, não expande, não abre
  // nada e não é foco de teclado. O que se opera continua sendo o anúncio (a
  // linha abaixo) e o agrupador (a linha acima). O user_product_id aparece
  // como texto porque é o endereço do produto físico no ML — mas em tamanho de
  // legenda, nunca como manchete do nível.
  function variacaoHtml(up, familia) {
    var itens = ordenarFilhos(up.itens || []);
    var base = tituloDaVariacao(itens);
    var v = nomeVariacao(itens, familia && familia.family_name);

    var html = '<div class="am-variacao" data-user-product="' +
      escapeAttr(up.user_product_id) + '" data-nome-origem="' + v.origem + '">' +
      '<div class="am-variacao__head">' +
        '<span class="am-variacao__nome">' + escapeHtml(v.nome) + "</span>" +
        '<span class="am-variacao__id vf-mono" title="User Product — o produto físico do Mercado Livre que reúne estas condições de venda">' +
          escapeHtml(up.user_product_id) + "</span>" +
      "</div>";

    itens.forEach(function (item, i) {
      html += rowMlbCompactaHtml(item, {
        irma: i > 0,
        // O título só aparece na linha quando DIFERE do que nomeou a variação.
        // No caso normal ele seria a terceira repetição da mesma frase (linha
        // do agrupador, cabeçalho da variação, linha do anúncio) e o que
        // distingue os irmãos é a condição comercial e o preço. Quando difere,
        // aparece — é comparação de dado, não suposição.
        tituloProprio: (item.titulo || "") !== base,
      });
    });
    return html + "</div>";
  }

  // A linha do MLB dentro do agrupador — hoje filha DIRETA dele. Não reusa
  // rowAnuncioHtml() (a linha da lista é mais alta, com badges e medidor), mas
  // ocupa EXATAMENTE as mesmas 11 colunas: a expansão é a continuação da
  // tabela, não uma tabela própria. Enquanto ela era uma árvore separada tinha
  // grade própria, e preço/estoque caíam em colunas que não eram as do
  // cabeçalho. O recuo sai de padding, nunca de uma coluna extra.
  //
  // A condição comercial entra DENTRO da célula de identificação, junto do
  // MLB — não numa coluna nova. Uma coluna fora da grade compartilhada
  // desalinharia a expansão do cabeçalho, que é justamente o que a
  // unificação da tabela consertou.
  //
  // O que se reusa de verdade: o modelo de dados (/familias/:familyId devolve
  // os mesmos campos) e o handler abrirDetalhe().
  function rowMlbCompactaHtml(a, opcoes) {
    var op = opcoes || {};
    var st = statusInfo(a.status);
    var img = a.thumbnail
      ? '<img src="' + escapeHtml(a.thumbnail) + '" alt="" loading="lazy" />'
      : iconeImagemSvg();
    var sku = a.sku
      ? '<span class="vf-mono">' + escapeHtml(a.sku) + "</span>"
      : '<span class="vf-mono am-row__sem-sku">sem SKU</span>';
    var linkMl = a.permalink
      ? '<a class="am-row__link" href="' + escapeHtml(a.permalink) + '" target="_blank" rel="noopener" ' +
        'aria-label="Abrir ' + escapeAttr(a.titulo || a.item_id) + ' no Mercado Livre" title="Abrir no Mercado Livre">' +
        iconeExternoSvg() + "</a>"
      : "";
    // Mesmo medidor semicircular do card legado (rowAnuncioHtml) — o card do
    // MLB dentro da família precisa ter exatamente a mesma aparência, e um
    // número simples aqui seria um segundo estilo de score para o mesmo
    // dado (ver auditoria "padronizar card MLB dentro de agrupadores").
    var score = scoreGaugeHtml(a.score_venforce);

    var cond = condicaoComercial(a);
    var condHtml = cond
      ? '<span class="am-mlb__cond">' + escapeHtml(cond) + "</span>"
      : "";
    // Título na linha só quando ele NÃO é o que já nomeou a variação logo
    // acima (ver variacaoHtml): aí o que sobra — MLB, condição comercial e
    // preço — é exatamente o que diferencia dois anúncios do mesmo produto.
    var tituloHtml = op.tituloProprio
      ? '<span class="am-mlb__titulo">' + escapeHtml(a.titulo || "(sem título)") + "</span>"
      : "";
    // Mesmos badges do card legado (Catálogo/Full/fotos/Sem SKU/Revisado) —
    // é o MESMO anúncio, só que dentro de uma família; escondê-los aqui
    // seria o card de família mostrar menos informação que o avulso.
    // Wrapper SEMPRE renderizado (mesmo sem nenhum badge estático) porque a
    // Curva ABC do filho chega depois (só ao expandir, ver
    // garantirPerformanceDaFamilia) e precisa de um alvo já existente no DOM
    // para pintarPerformanceEmCelulas encontrar — um span vazio não aparece
    // visualmente, então não muda nada quando não há badge nenhum.
    var badges = badgesAnuncioHtml(a);
    var badgesHtml = '<span class="am-mlb__badges">' + badges +
      '<span data-abc-item="' + escapeAttr(a.item_id) + '">' + curvaAbcBadgeHtml(AM.state.curvaAbcCache[a.item_id]) + "</span>" +
    "</span>";

    return '<div class="am-mlb' + (op.irma ? " am-mlb--irma" : "") +
      '" data-item="' + escapeAttr(a.item_id) + '" tabindex="0" role="button" ' +
      'aria-label="Ver detalhes de ' +
      escapeAttr((a.titulo || a.item_id) + (cond ? " — " + cond : "")) + '">' +
      '<span class="am-mlb__thumb" aria-hidden="true">' + img + "</span>" +
      '<span class="am-mlb__main">' +
        tituloHtml +
        '<span class="am-mlb__ids"><span class="vf-mono">' + escapeHtml(a.item_id) + "</span>" +
          condHtml + sku + "</span>" +
        badgesHtml +
      "</span>" +
      '<span class="vf-status ' + st.classe + '">' + st.label + "</span>" +
      celulaPrecoHtml(a, "am-mlb__preco") +
      celulaEstoqueHtml(a, "am-mlb__num") +
      '<span class="am-mlb__num">' + (a.vendidos != null ? a.vendidos : "—") + "</span>" +
      faturamentoCelulaHtml(a.item_id) +
      metricas7dCelulaHtml(a.item_id) +
      margemCelulaHtml(a) +
      score +
      '<span class="am-mlb__acao">' + linkMl + "</span>" +
    "</div>";
  }

  // ===========================================================================
  // MÉTRICAS ÚLT. 7 DIAS — enriquecimento AO VIVO e ASSÍNCRONO
  //
  // Coluna própria, GET /anuncios-meli/performance. Nunca bloqueia a abertura
  // da página nem a expansão de um agrupador: a linha nasce com a célula em
  // "carregando…" e carregarPerformance() a resolve depois, só para os
  // item_id que estão de fato visíveis — nunca um recorte decidido aqui,
  // sempre a lista exata que o render acabou de montar.
  //
  // AM.state.performanceCache é o cache de sessão (por item_id, nunca
  // persistido): reabrir uma família já expandida antes, ou repintar uma
  // linha depois de editar o estoque, lê daqui — nenhuma das duas gasta uma
  // chamada nova ao Mercado Livre/Motor de Margem.
  //
  // Margem projetada NÃO passa mais por aqui (migrou pro snapshot — ver
  // margemCelulaHtml/anexarMargemProjetadaNaPagina): a célula é PRÓPRIA,
  // separada das métricas de tráfego/venda, nasce pronta (sem "carregando"),
  // e só existe por MLB — a linha do agrupador mostra "—" fixo (ver
  // rowGrupoHtml), mesmo depois de expandida. `performanceCache[id].margem`
  // (deste bloco) continua existindo só para a seção "Composição da margem"
  // do MODAL e para o preço ao vivo (celulaPrecoHtml/precoDetalheHtml) —
  // nunca mais para a célula da listagem.
  // ===========================================================================

  function formatarInteiroOuTraco(v) {
    if (v === null || v === undefined) return "—";
    return Number(v).toLocaleString("pt-BR");
  }

  function formatarPercentualCompacto(v) {
    if (v === null || v === undefined) return "—";
    return Number(v).toFixed(1).replace(".", ",") + "%";
  }

  function metricas7dConteudoHtml(m) {
    if (!m) return '<span class="am-metricas7d__linha am-metricas7d__vazio">—</span>';
    var conv = m.conversao == null ? "" : " · " + formatarPercentualCompacto(m.conversao);
    return (
      '<span class="am-metricas7d__linha" title="Visualizações nos últimos 7 dias">👁 ' +
        formatarInteiroOuTraco(m.views) + "</span>" +
      '<span class="am-metricas7d__linha" title="Vendas (e conversão) nos últimos 7 dias">🛒 ' +
        formatarInteiroOuTraco(m.vendas) + conv + "</span>"
    );
  }

  function metricas7dCelulaHtml(itemId) {
    var cache = AM.state.performanceCache[itemId];
    var pronto = cache && cache.temMetricas;
    var conteudo = pronto
      ? metricas7dConteudoHtml(cache.metricas7d)
      : '<span class="am-metricas7d__linha am-metricas7d__vazio">carregando…</span>';
    return '<span class="am-metricas7d' + (pronto ? "" : " am-metricas7d--carregando") +
      '" data-metricas-item="' + escapeAttr(itemId) + '">' + conteudo + "</span>";
  }

  // Soma das métricas 7d dos FILHOS — só do agrupador, nunca da margem (ver
  // rowGrupoHtml). Mesma régua "—" do backend: sem views não há conversão,
  // vendas ausente (chamada falhou) nunca vira 0 fingido.
  function agregarConversao(vendas, views) {
    if (views === null || views === undefined || views === 0) return null;
    if (vendas === null || vendas === undefined) return null;
    var pct = (vendas / views) * 100;
    if (!isFinite(pct)) return null;
    return Math.round(pct * 10) / 10;
  }

  // null enquanto os filhos ainda são desconhecidos (família sem detalhe em
  // cache — o pré-carregamento em background ainda não respondeu) OU
  // enquanto algum filho ainda não tem metricas7d — um agregado parcial
  // enganaria tanto quanto uma margem em média simples. Só sai quando TODOS
  // os filhos já responderam (sucesso ou falha, tanto faz — o que importa é
  // não estar mais em voo).
  function metricas7dAgregadoDoGrupo(familyId) {
    var familia = AM.state.familyCache[familyId];
    if (!familia) return null;
    var ids = [];
    (familia.user_products || []).forEach(function (up) {
      (up.itens || []).forEach(function (item) { ids.push(item.item_id); });
    });
    if (!ids.length) return null;
    if (!ids.every(function (id) {
      var c = AM.state.performanceCache[id];
      return !!(c && c.temMetricas);
    })) return null;

    var somaViews = 0, temViews = false;
    var somaVendas = 0, temVendas = true;
    ids.forEach(function (id) {
      var m = AM.state.performanceCache[id].metricas7d;
      if (m && m.views != null) { somaViews += m.views; temViews = true; }
      if (m && m.vendas != null) somaVendas += m.vendas; else temVendas = false;
    });

    var views = temViews ? somaViews : null;
    var vendas = temVendas ? somaVendas : null;
    return { views: views, vendas: vendas, conversao: agregarConversao(vendas, views) };
  }

  function metricas7dAgregadoCelulaHtml(familyId) {
    var agregado = metricas7dAgregadoDoGrupo(familyId);
    if (agregado) {
      return '<span class="am-metricas7d" title="Soma dos últimos 7 dias de todas as variações">' +
        metricas7dConteudoHtml(agregado) + "</span>";
    }
    // Ainda não: o pré-carregamento em background falhou de verdade (mostra
    // "—", igual à falha de qualquer célula de item) ou simplesmente ainda
    // está em voo (mostra "carregando…", nunca um "—" definitivo — a soma
    // chega sozinha quando a resposta voltar).
    if (AM.state.familyFetchFalhou[familyId]) {
      return '<span class="am-metricas7d am-metricas7d--indisponivel" title="Não foi possível calcular a soma agora">—</span>';
    }
    return '<span class="am-metricas7d am-metricas7d--carregando" title="Calculando a soma dos últimos 7 dias…">' +
      '<span class="am-metricas7d__linha am-metricas7d__vazio">carregando…</span>' +
    "</span>";
  }

  // Cor por STATUS real do Motor de Margem (marginStatus.js) — nunca um
  // limiar próprio reinventado aqui sobre o percentual.
  var MARGEM_CLASSE = {
    HEALTHY: "is-success",
    LOW_MARGIN: "is-warning",
    SUSPECT_DATA: "is-warning",
    RECONCILING: "is-info",
    LOSS: "is-danger",
    UNVALIDATED: "is-neutral",
  };

  // Selo discreto de explicação — mesmo componente vf-info/vf-info-dot da
  // Fundação (o ROAS em Ads usa o mesmo), não uma tooltip nova inventada.
  // `ariaLabel` é opcional pra reaproveitar o mesmo selo fora do contexto de
  // margem (ex.: estoque de variação bloqueado) sem herdar um rótulo errado.
  function infoDotHtml(texto, ariaLabel) {
    return '<span class="vf-info am-margem__info">' +
      '<button type="button" class="vf-info-dot" aria-label="' + escapeAttr(ariaLabel || "Sobre esta margem") + '"></button>' +
      '<span class="vf-info__tip" role="tooltip">' + escapeHtml(texto) + "</span>" +
    "</span>";
  }

  function margemConteudoHtml(m, margemIndisponivel) {
    // Nível de CONTEXTO (Base não vinculada, múltiplas bases, grant caído):
    // mesma mensagem que o Motor já gera — nunca um "Sem custo na Base"
    // genérico inventado aqui.
    if (margemIndisponivel) {
      return '<span class="am-margem__estado" title="' + escapeAttr(margemIndisponivel.mensagem || "") + '">' +
        escapeHtml(margemIndisponivel.mensagem || "Indisponível") + "</span>";
    }
    if (!m) return '<span class="am-margem__vazio">—</span>';

    var classe = MARGEM_CLASSE[m.status] || "is-neutral";
    // Margem = Margem Projetada, SOMENTE, nesta tela (decisão de produto) —
    // m.origem é sempre "projected" agora (ver montarMapaMargem no
    // controller), então não há mais alternância de rótulo pra comunicar.
    var tip = "Margem projetada com base no preço atual e custos configurados.";
    // Preço alvo é aditivo à explicação da margem (mesmo infoDot) — nunca um
    // segundo cálculo aqui, só o texto do que o Motor já resolveu em
    // item.margin.target (ver montarMapaMargem/computeTargetPrice).
    if (m.precoAlvo != null) {
      tip += " Preço alvo p/ bater a margem configurada: " + formatMoeda(m.precoAlvo) + ".";
    }

    if (m.marginPercent != null) {
      return '<span class="am-margem__valor ' + classe + '">' + formatarPercentualCompacto(m.marginPercent) + "</span>" +
        infoDotHtml(tip);
    }
    // Sem número (ex.: UNVALIDATED) — rótulo REAL do Motor, com a razão real
    // (statusReasons[0], já gerada por classifyStatus) como tooltip.
    var motivo = (m.statusReasons && m.statusReasons[0]) || "";
    return '<span class="am-margem__estado ' + classe + '" title="' + escapeAttr(motivo) + '">' +
      escapeHtml(m.statusLabel || "Indisponível") + "</span>" +
      infoDotHtml(tip);
  }

  // Rótulos REAIS do Motor de Margem (mesmas 6 chaves/textos de
  // server/services/motorMargem/core/marginStatus.js LABELS) — mapeados
  // aqui porque o snapshot só grava o CÓDIGO (margemProjetadaStatus), nunca
  // o rótulo pronto nem os motivos detalhados (statusReasons não existe na
  // tabela anuncios_margem_projetada_snapshot).
  var MARGEM_LABEL = {
    HEALTHY: "Saudável",
    LOW_MARGIN: "Margem baixa",
    SUSPECT_DATA: "Dado suspeito",
    RECONCILING: "Em conciliação",
    LOSS: "Prejuízo",
    UNVALIDATED: "Não validado",
  };

  // Quando o SNAPSHOT de margem projetada foi calculado — data/hora
  // ABSOLUTA ("28/09 às 03:34", fuso do navegador), nunca relativa: "Calculada
  // ontem" soava como se o ANÚNCIO tivesse sido atualizado ontem / a margem
  // estivesse velha, quando é só o horário do último cálculo do snapshot
  // (job fora do request). Timestamp exibido como veio, sem ajuste.
  function margemCalculadaEmTexto(calculadoEm) {
    if (!calculadoEm) return null;
    var d = new Date(calculadoEm);
    if (isNaN(d.getTime())) return null;
    function dois(n) { return (n < 10 ? "0" : "") + n; }
    return dois(d.getDate()) + "/" + dois(d.getMonth() + 1) + " às " + dois(d.getHours()) + ":" + dois(d.getMinutes());
  }

  function margemCalculadaEmFrase(calculadoEm) {
    var quando = margemCalculadaEmTexto(calculadoEm);
    return quando ? " Margem projetada calculada em " + quando + "." : "";
  }

  // Célula de Margem da LISTAGEM (linha avulsa e filho expandido de
  // família) — fonte ÚNICA é o snapshot de margem projetada que já vem
  // PRONTO no próprio `anuncio` (margemProjetadaPercent/Computable/Status/
  // CalculadaEm, ver anexarMargemProjetadaNaPagina no controller e
  // garantirFamiliaDetalhe). NUNCA lê AM.state.performanceCache/dados.margem
  // de GET /performance — esse endpoint continua vivo só para
  // faturamento/Curva ABC/métricas 7d e para a seção "Composição da margem"
  // do MODAL (live, Motor de Margem — ver margemConteudoHtml, função
  // irmã desta, usada só pelo modal).
  //
  // Sem "carregando": ao contrário de métricas/faturamento (assíncronos,
  // chegam DEPOIS do primeiro paint), o snapshot já está no MESMO objeto
  // que desenhou a linha — a célula nasce PRONTA.
  function margemProjetadaConteudoHtml(a) {
    var classe = MARGEM_CLASSE[a.margemProjetadaStatus] || "is-neutral";
    if (a.margemProjetadaComputable === true && a.margemProjetadaPercent != null) {
      var tip = "Margem projetada com base no preço atual e custos configurados." +
        margemCalculadaEmFrase(a.margemProjetadaCalculadaEm);
      return '<span class="am-margem__valor ' + classe + '">' + formatarPercentualCompacto(a.margemProjetadaPercent) + "</span>" +
        infoDotHtml(tip);
    }
    // Sem snapshot (job nunca rodou) e sem status algum: "—" simples, sem
    // rótulo/selo — não há nada real do Motor pra comunicar aqui.
    if (!a.margemProjetadaStatus) return '<span class="am-margem__vazio">—</span>';
    // Snapshot existe mas não é computável (ex.: UNVALIDATED) — rótulo REAL
    // do Motor (mesmo vocabulário de marginStatus.js), sem inventar motivo
    // detalhado (statusReasons não existe no snapshot).
    return '<span class="am-margem__estado ' + classe + '">' +
      escapeHtml(MARGEM_LABEL[a.margemProjetadaStatus] || "Indisponível") + "</span>";
  }

  function margemCelulaHtml(a) {
    return '<span class="am-margem" data-margem-item="' + escapeAttr(a.item_id) + '">' +
      margemProjetadaConteudoHtml(a) + "</span>";
  }

  // Célula de Margem do AGRUPADOR (linha da família na listagem, `rowGrupoHtml`)
  // — família não tem margem % única, mas mostra a FAIXA (mínimo/máximo) de
  // Margem Projetada dos filhos computáveis, fonte
  // `f.margemProjetadaMinPercent`/`MaxPercent` (mesmo snapshot da célula do
  // item, ver controller `anexarMargemProjetadaNaPagina`). Vem preenchido em
  // QUALQUER ordenação (Padrão, faturamento, Curva ABC, unidades, margem).
  //
  // Empilhado em DUAS linhas — mínimo em cima, máximo embaixo — com a MESMA
  // classe (`.am-margem__valor`): os dois são margens válidas, nenhum é
  // "secundário". Antes o mínimo usava um estilo apagado/menor inspirado no
  // preço riscado e parecia um valor antigo/desabilitado. `data-faixa`
  // (min/max) só identifica a linha, sem estilo próprio. Min === Max (1 único
  // filho computável) mostra só UM valor, nunca duas linhas iguais.
  function margemFaixaFamiliaHtml(f) {
    if (f.margemProjetadaMinPercent != null && f.margemProjetadaMaxPercent != null) {
      var min = formatarPercentualCompacto(f.margemProjetadaMinPercent);
      var max = formatarPercentualCompacto(f.margemProjetadaMaxPercent);
      var tip = "Faixa de Margem Projetada dos anúncios desta família (mínimo em cima, máximo embaixo). A ordenação por margem usa a média." +
        margemCalculadaEmFrase(f.margemProjetadaCalculadaEm);
      var linhas = min === max
        ? '<span class="am-margem__valor is-neutral" data-faixa="unico">' + max + "</span>"
        : '<span class="am-margem__valor is-neutral" data-faixa="min">' + min + "</span>" +
          '<span class="am-margem__valor is-neutral" data-faixa="max">' + max + "</span>";
      return '<span class="am-margem am-margem--faixa" data-margem-familia="' + escapeAttr(f.family_id) + '">' +
        linhas + infoDotHtml(tip) +
      "</span>";
    }
    return '<span class="am-margem am-margem--indisponivel" ' +
      'title="Nenhum anúncio desta família tem margem projetada calculada">—</span>';
  }

  // % do faturamento — coluna própria (ver auditoria "Ajuste visual —
  // métricas de performance"). Ao contrário de metricas7d/margem, não tem
  // pré-carregamento em background nem estado "carregando": o valor só entra
  // no cache quando o operador ordena por ele (ver
  // aplicarOrdenacaoPerformance/AM.state.faturamentoCache), e a célula fica
  // "—" fixo até lá — nunca um spinner para um dado que ninguém pediu ainda.
  function faturamentoConteudoHtml(v, valorAbsoluto) {
    if (v === null || v === undefined) return '<span class="am-faturamento__vazio">—</span>';
    // Backend manda FRAÇÃO 0–1 (receita/receitaTotalPeriodo — ver
    // montarFaturamento no controller), não um número já em escala 0–100
    // como marginPercent/conversao. formatarPercentualCompacto() é
    // compartilhada com esses dois campos e espera 0–100 — não mexer nela
    // (quebraria margem/conversão); o × 100 é só deste call site (ver
    // auditoria "Validação participação faturamento").
    // 2ª linha: valor ABSOLUTO (R$) que o backend já manda pronto
    // (faturamento.porItemValor/porFamiliaValor) — nunca derivado do
    // percentual aqui (perderia centavos por causa do arredondamento a 4
    // casas do percentual, ver auditoria "Curva ABC sempre visível +
    // faturamento absoluto").
    return '<span class="am-faturamento__valor">' + formatarPercentualCompacto(v * 100) + "</span>" +
      '<span class="am-faturamento__legenda">' + formatMoeda(valorAbsoluto) + "</span>";
  }

  function faturamentoCelulaHtml(itemId) {
    var v = Object.prototype.hasOwnProperty.call(AM.state.faturamentoCache, itemId)
      ? AM.state.faturamentoCache[itemId] : null;
    var valor = Object.prototype.hasOwnProperty.call(AM.state.faturamentoValorCache, itemId)
      ? AM.state.faturamentoValorCache[itemId] : null;
    return '<span class="am-faturamento" data-faturamento-item="' + escapeAttr(itemId) + '">' +
      faturamentoConteudoHtml(v, valor) + "</span>";
  }

  // Percentual CONSOLIDADO da família — soma dos filhos sobre o faturamento
  // total do período, calculada pelo backend (dados.faturamento.porFamilia).
  // Nunca o percentual de um filho isolado. Valor absoluto segue a mesma
  // regra (dados.faturamento.porFamiliaValor).
  function faturamentoAgregadoCelulaHtml(familyId) {
    var v = Object.prototype.hasOwnProperty.call(AM.state.faturamentoPorFamiliaCache, familyId)
      ? AM.state.faturamentoPorFamiliaCache[familyId] : null;
    var valor = Object.prototype.hasOwnProperty.call(AM.state.faturamentoValorPorFamiliaCache, familyId)
      ? AM.state.faturamentoValorPorFamiliaCache[familyId] : null;
    return '<span class="am-faturamento" data-faturamento-familia="' + escapeAttr(familyId) +
      '" title="Percentual consolidado da família sobre o faturamento total do período">' +
      faturamentoConteudoHtml(v, valor) + "</span>";
  }

  // Busca metricas7d, margem e/ou composição da margem para os item_id
  // pedidos — só o aspecto que FALTA em cada um (AM.state.performanceCache
  // guarda os três de forma independente: `temMetricas`/`temMargem`/
  // `temComposicao`). Isso é o que permite ao pré-carregamento em
  // background pedir só metricas7d dos filhos ocultos (opcoes.incluirMargem:
  // false), a expansão da família pedir só a margem que falta (sem repetir
  // a métrica que o pré-carregamento já trouxe), e o modal de detalhe pedir
  // só a composição (sem repetir margem/métricas já conhecidas da lista).
  //
  // `metricasEmVoo`/`margemEmVoo`/`composicaoEmVoo` (por item_id) dedupem
  // chamadas concorrentes para o MESMO item/aspecto: o pré-carregamento em
  // background, um clique do operador na mesma família, e abrir o modal de
  // um item já em voo nunca disparam duas requisições.
  //
  // Nunca bloqueia quem chamou: é sempre disparada DEPOIS que a linha (ou o
  // modal) já está pintada na tela. Devolve a Promise da leitura (resolvida
  // de imediato quando não há nada pendente — tudo já em cache/em voo):
  // quem precisa saber "os filhos desta família já são conhecidos" (ver
  // repintarLinhaDoGrupo) ou "a composição já chegou" (ver
  // garantirComposicaoDoItem) encadeia nela em vez de reimplementar a espera.
  //
  // Lotes de no máximo PERFORMANCE_LOTE_MAX (20) itens: o Motor de Margem processa
  // até 20 itens por chamada (motorMargemService PAGE_LIMIT_MAX, teto do
  // multiget /items?ids= do ML) e CORTA o excedente em silêncio. Mandar a
  // página inteira (24) numa chamada só deixava os últimos sem
  // `margem[itemId]` — e com ela sem precoAtual/precoOriginal — mas marcados
  // como resolvidos: a lista ficava no preço do snapshot até o modal pedir a
  // composição daquele item sozinho (bug "preço promocional só aparece depois
  // de abrir a composição da margem").
  var PERFORMANCE_LOTE_MAX = 20;

  function carregarPerformance(itemIds, opcoes) {
    if (!AM.clienteAtual) return Promise.resolve();
    var unicos = [];
    var vistosLote = {};
    (itemIds || []).forEach(function (id) {
      if (!id || vistosLote[id]) return;
      vistosLote[id] = true;
      unicos.push(id);
    });
    if (unicos.length > PERFORMANCE_LOTE_MAX) {
      var lotes = [];
      for (var i = 0; i < unicos.length; i += PERFORMANCE_LOTE_MAX) {
        lotes.push(carregarPerformance(unicos.slice(i, i + PERFORMANCE_LOTE_MAX), opcoes));
      }
      return Promise.all(lotes).then(function () {});
    }
    var incluirMargem = !opcoes || opcoes.incluirMargem !== false;
    // Composição é OPT-IN (ao contrário de métricas/margem): só o modal de
    // detalhe pede, explicitamente, ao abrir o modal (seção "Composição da margem").
    var incluirComposicao = !!(opcoes && opcoes.incluirComposicao);
    // % faturamento também é OPT-IN aqui: só quem pede (o carregamento
    // automático da lista, ver renderCatalogo) liga a flag — o
    // pré-carregamento em background de filhos ocultos (incluirMargem:false,
    // ver carregarMetricasDosGruposVisiveis) continua sem gastar o Motor de
    // Margem para uma família ainda fechada.
    var incluirFaturamento = !!(opcoes && opcoes.incluirFaturamento);
    // Curva ABC segue a MESMA regra de opt-in do faturamento: quem pede liga
    // a flag. O carregamento automático da lista (renderCatalogo) e a
    // expansão de família (garantirPerformanceDaFamilia) ligam os dois
    // juntos, sempre — ambos vêm do MESMO porMlb que a margem já buscou,
    // então pedir a Curva ABC junto não gasta uma chamada extra ao Motor.
    var incluirCurvaAbc = !!(opcoes && opcoes.incluirCurvaAbc);

    var vistos = {};
    var pendentesMetricas = [];
    var pendentesMargem = [];
    var pendentesComposicao = [];
    var pendentesFaturamento = [];
    var pendentesCurvaAbc = [];
    (itemIds || []).forEach(function (id) {
      if (!id || vistos[id]) return;
      vistos[id] = true;
      var cache = AM.state.performanceCache[id];
      if ((!cache || !cache.temMetricas) && !AM.state.metricasEmVoo[id]) pendentesMetricas.push(id);
      if (incluirMargem && (!cache || !cache.temMargem) && !AM.state.margemEmVoo[id]) pendentesMargem.push(id);
      if (incluirComposicao && (!cache || !cache.temComposicao) && !AM.state.composicaoEmVoo[id]) pendentesComposicao.push(id);
      if (incluirFaturamento && !Object.prototype.hasOwnProperty.call(AM.state.faturamentoCache, id) &&
          !AM.state.faturamentoEmVoo[id]) pendentesFaturamento.push(id);
      if (incluirCurvaAbc && !Object.prototype.hasOwnProperty.call(AM.state.curvaAbcCache, id) &&
          !AM.state.curvaAbcEmVoo[id]) pendentesCurvaAbc.push(id);
    });
    if (!pendentesMetricas.length && !pendentesMargem.length && !pendentesComposicao.length &&
        !pendentesFaturamento.length && !pendentesCurvaAbc.length) {
      return Promise.resolve();
    }

    var idsUniao = [];
    var vistosUniao = {};
    pendentesMetricas.concat(pendentesMargem, pendentesComposicao, pendentesFaturamento, pendentesCurvaAbc).forEach(function (id) {
      if (vistosUniao[id]) return;
      vistosUniao[id] = true;
      idsUniao.push(id);
    });

    var pendentesMetricasSet = {};
    pendentesMetricas.forEach(function (id) { pendentesMetricasSet[id] = true; AM.state.metricasEmVoo[id] = true; });
    var pendentesMargemSet = {};
    pendentesMargem.forEach(function (id) { pendentesMargemSet[id] = true; AM.state.margemEmVoo[id] = true; });
    var pendentesComposicaoSet = {};
    pendentesComposicao.forEach(function (id) { pendentesComposicaoSet[id] = true; AM.state.composicaoEmVoo[id] = true; });
    var pendentesFaturamentoSet = {};
    pendentesFaturamento.forEach(function (id) { pendentesFaturamentoSet[id] = true; AM.state.faturamentoEmVoo[id] = true; });
    var pendentesCurvaAbcSet = {};
    pendentesCurvaAbc.forEach(function (id) { pendentesCurvaAbcSet[id] = true; AM.state.curvaAbcEmVoo[id] = true; });

    var qs = "clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug) +
      "&itemIds=" + encodeURIComponent(idsUniao.join(",")) +
      "&incluirMetricas=" + (pendentesMetricas.length ? "1" : "0") +
      "&incluirMargem=" + (pendentesMargem.length || pendentesComposicao.length ? "1" : "0") +
      "&incluirComposicao=" + (pendentesComposicao.length ? "1" : "0") +
      "&incluirFaturamento=" + (pendentesFaturamento.length ? "1" : "0") +
      "&incluirCurvaAbc=" + (pendentesCurvaAbc.length ? "1" : "0");
    if (AM.contaMlId) qs += "&clienteContaId=" + encodeURIComponent(AM.contaMlId);
    // Rebate ML da promoção ATIVA (ver garantirComposicaoDoItem) — só entra
    // na querystring quando o item alvo faz parte deste próprio pedido
    // (nunca aplicado num id de outra chamada em voo). Zero chamada nova ao
    // Mercado Livre: o valor já está em AM.state.promocoesCache.
    if (opcoes && opcoes.subsidioMl && idsUniao.indexOf(opcoes.subsidioMl.itemId) !== -1) {
      qs += "&subsidioMlItemId=" + encodeURIComponent(opcoes.subsidioMl.itemId) +
        "&subsidioMl=" + encodeURIComponent(opcoes.subsidioMl.valor);
    }

    return api("/anuncios-meli/performance?" + qs).then(function (r) {
      pendentesMetricas.forEach(function (id) { delete AM.state.metricasEmVoo[id]; });
      pendentesMargem.forEach(function (id) { delete AM.state.margemEmVoo[id]; });
      pendentesComposicao.forEach(function (id) { delete AM.state.composicaoEmVoo[id]; });
      pendentesFaturamento.forEach(function (id) { delete AM.state.faturamentoEmVoo[id]; });
      pendentesCurvaAbc.forEach(function (id) { delete AM.state.curvaAbcEmVoo[id]; });

      var dados = r.data;
      if (dados && dados.ok) {
        idsUniao.forEach(function (id) {
          var atual = AM.state.performanceCache[id] || {
            metricas7d: null, temMetricas: false,
            margem: null, margemIndisponivel: null, temMargem: false,
            composicao: null, temComposicao: false,
          };
          if (pendentesMetricasSet[id]) {
            atual.metricas7d = (dados.metricas7d && dados.metricas7d[id]) || null;
            atual.temMetricas = true;
          }
          // A composição pediu margem "de carona" (qs acima): se ISSO foi
          // quem ligou incluirMargem=1 para este id (pendentesMargemSet não
          // tinha o id, mas pendentesComposicaoSet tem), a margem também
          // chega nesta resposta e precisa ser gravada — senão o badge da
          // seção ficaria "carregando" para sempre.
          if (pendentesMargemSet[id] || pendentesComposicaoSet[id]) {
            atual.margem = (dados.margem && dados.margem[id]) || null;
            atual.margemIndisponivel = dados.margemIndisponivel || null;
            atual.temMargem = true;
          }
          if (pendentesComposicaoSet[id]) {
            atual.composicao = (dados.composicao && dados.composicao[id]) || null;
            atual.temComposicao = true;
          }
          AM.state.performanceCache[id] = atual;
        });
        if (pendentesFaturamento.length) {
          var porItem = (dados.faturamento && dados.faturamento.porItem) || {};
          var porItemValor = (dados.faturamento && dados.faturamento.porItemValor) || {};
          pendentesFaturamento.forEach(function (id) {
            AM.state.faturamentoCache[id] = porItem[id] != null ? porItem[id] : null;
            AM.state.faturamentoValorCache[id] = porItemValor[id] != null ? porItemValor[id] : null;
          });
        }
        if (pendentesCurvaAbc.length) {
          var porItemAbc = (dados.curvaAbc && dados.curvaAbc.porItem) || {};
          pendentesCurvaAbc.forEach(function (id) {
            AM.state.curvaAbcCache[id] = porItemAbc[id] || null;
          });
        }
      }
      // Falha da chamada inteira: nada é marcado como resolvido (permite
      // uma tentativa futura), e as células pedidas só repintam com o que
      // JÁ está no cache — nunca apagam um aspecto que outra chamada
      // independente já tinha trazido com sucesso.
      pintarPerformanceEmCelulas(idsUniao);
    });
  }

  // Faturamento CONSOLIDADO + Curva ABC CONSOLIDADA das famílias visíveis na
  // página — chamada própria (não passa por carregarPerformance, que é por
  // item_id): o backend resolve os filhos pela family_id e soma a receita
  // deles (ver meliAnunciosController.performance/familias=). Os dois vêm
  // do MESMO porMlb, então pedir Curva ABC junto não gasta uma 2ª chamada ao
  // Motor (mesma razão de sempre — ver auditoria "Curva ABC sempre visível +
  // faturamento absoluto"). "Pendente" é OU faltando: uma família que já tem
  // faturamento mas ainda não tem Curva ABC (ou vice-versa) continua entrando
  // no lote. Dedupe por faturamentoFamiliaEmVoo, mesmo padrão dos demais
  // caches — reabrir a página ou reordenar sem famílias novas não gasta
  // chamada nenhuma.
  function carregarFaturamentoDasFamiliasVisiveis() {
    if (!AM.clienteAtual) return Promise.resolve();
    var pendentes = [];
    AM.anuncios.forEach(function (l) {
      if (l.tipo !== "familia") return;
      var familyId = l.family_id;
      var faltaFaturamento = !Object.prototype.hasOwnProperty.call(AM.state.faturamentoPorFamiliaCache, familyId);
      var faltaCurvaAbc = !Object.prototype.hasOwnProperty.call(AM.state.curvaAbcPorFamiliaCache, familyId);
      if ((faltaFaturamento || faltaCurvaAbc) && !AM.state.faturamentoFamiliaEmVoo[familyId]) {
        pendentes.push(familyId);
      }
    });
    if (!pendentes.length) return Promise.resolve();
    pendentes.forEach(function (familyId) { AM.state.faturamentoFamiliaEmVoo[familyId] = true; });

    var qs = "clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug) +
      "&itemIds=&incluirMetricas=0&incluirMargem=0&incluirComposicao=0&incluirFaturamento=1&incluirCurvaAbc=1" +
      "&familias=" + encodeURIComponent(pendentes.join("|"));
    if (AM.contaMlId) qs += "&clienteContaId=" + encodeURIComponent(AM.contaMlId);

    return api("/anuncios-meli/performance?" + qs).then(function (r) {
      pendentes.forEach(function (familyId) { delete AM.state.faturamentoFamiliaEmVoo[familyId]; });
      var dados = r.data;
      var porFamilia = (dados && dados.ok && dados.faturamento && dados.faturamento.porFamilia) || {};
      var porFamiliaValor = (dados && dados.ok && dados.faturamento && dados.faturamento.porFamiliaValor) || {};
      var porFamiliaAbc = (dados && dados.ok && dados.curvaAbc && dados.curvaAbc.porFamilia) || {};
      pendentes.forEach(function (familyId) {
        AM.state.faturamentoPorFamiliaCache[familyId] = porFamilia[familyId] != null ? porFamilia[familyId] : null;
        AM.state.faturamentoValorPorFamiliaCache[familyId] = porFamiliaValor[familyId] != null ? porFamiliaValor[familyId] : null;
        AM.state.curvaAbcPorFamiliaCache[familyId] = porFamiliaAbc[familyId] || null;
        repintarLinhaDoGrupo(familyId);
      });
    });
  }

  // Ponto único do modal de detalhe para buscar a composição da margem de
  // UM item — chamado só quando o operador abre a seção "Composição da
  // margem" (nunca ao abrir o modal). Força incluirMargem:true junto: o
  // item pode nunca ter passado pela lista (aberto direto, ou a lista não
  // tinha buscado a margem dele ainda), então a composição não pode supor
  // que a margem já está em cache. O dedupe de carregarPerformance garante
  // que isso não gasta chamada nova quando já está tudo pronto.
  function garantirComposicaoDoItem(itemId) {
    var opcoes = { incluirMargem: true, incluirComposicao: true };
    // Rebate ML da promoção ATIVA (ver promocaoAtivaComSubsidioDoItem) — só
    // existe se garantirPromocoesDoItem já resolveu (ver DET.promocoesPronto
    // em carregarComposicaoDoDetalhe); sem isso, composição segue sem rebate, exata-
    // mente como antes.
    var ativa = promocaoAtivaComSubsidioDoItem(itemId);
    if (ativa) opcoes.subsidioMl = { itemId: itemId, valor: ativa.subsidioMl };
    return carregarPerformance([itemId], opcoes);
  }

  // ===========================================================================
  // Ordenação por performance (margem / % faturamento / unidades vendidas
  // últ. 7d / Curva ABC últ. 30d) — ver auditoria "Anúncios ML — filtros de
  // performance". Escopo desta etapa: ordena só a PÁGINA ATUAL (≤24 linhas-
  // topo, mesmo teto de GET /anuncios-meli/performance) — nenhuma busca em
  // outras páginas, nenhum filtro de faixa/período.
  //
  // Família participa como entidade AGREGADA, nunca herda o valor de 1 filho:
  // margem/faturamento/Curva ABC vêm prontos do backend (`margemPorFamilia`/
  // `faturamento.porFamilia`/`curvaAbc.porFamilia` — ver
  // meliAnunciosController.performance), porque os três dependem do contexto
  // financeiro inteiro (receita do período/Base de custos). Unidades vendidas
  // é soma simples e fica só no cliente, a partir dos filhos já conhecidos
  // via garantirFamiliaDetalhe (mesmo ponto único de sempre — nunca refaz a
  // busca se a família já está em cache).
  // ===========================================================================

  // ===========================================================================
  // Combo de ordenação (filtro + direção) — UI apenas. O <select id="am-
  // ordenacao"> escondido continua sendo a fonte da verdade: este bloco só
  // lê/escreve o valor dele e dispara "change", nunca decide ordenação
  // sozinho. Cada filtro carrega sua direção PADRÃO (decisão aprovada);
  // trocar de filtro reseta pra ela, reselecionar o filtro já ativo preserva
  // a direção atual (ver selecionarFiltroOrdenacao).
  // ===========================================================================

  var ORDENACAO_FILTROS = [
    { base: "", label: "Padrão", dirType: "none" },
    { base: "margem", label: "Margem", dirType: "num", dirPadrao: "desc" },
    { base: "faturamento", label: "% Faturamento", dirType: "num", dirPadrao: "desc" },
    { base: "unidades", label: "Unidades vendidas 7d", dirType: "num", dirPadrao: "desc" },
    { base: "curvaAbc", label: "Curva ABC", dirType: "abc", dirPadrao: "asc" },
  ];

  function filtroOrdenacaoPorBase(base) {
    for (var i = 0; i < ORDENACAO_FILTROS.length; i++) {
      if (ORDENACAO_FILTROS[i].base === base) return ORDENACAO_FILTROS[i];
    }
    return ORDENACAO_FILTROS[0];
  }

  // "margem_desc" -> { base: "margem", dir: "desc" }; "" -> { base: "", dir: null }.
  function parseValorOrdenacao(value) {
    if (!value) return { base: "", dir: null };
    var idx = value.lastIndexOf("_");
    return { base: value.slice(0, idx), dir: value.slice(idx + 1) };
  }

  function rotuloDirecaoOrdenacao(filtro, dir) {
    if (filtro.dirType === "none") return "—";
    if (filtro.dirType === "abc") return dir === "asc" ? "A → C" : "C → A";
    return dir === "desc" ? "Maior → menor" : "Menor → maior";
  }

  function montarMenuOrdenacao() {
    var menu = el("am-ordenacao-menu");
    if (!menu) return;
    menu.innerHTML = ORDENACAO_FILTROS.map(function (f) {
      return '<button type="button" class="am-ordenacao-menu__item vf-menu__item" role="option" data-base="' +
        f.base + '">' +
        "<span>" + f.label + "</span>" +
        '<svg class="am-ordenacao-menu__check" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
        '<path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>' +
        "</button>";
    }).join("");
    menu.querySelectorAll("[data-base]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        selecionarFiltroOrdenacao(btn.getAttribute("data-base"));
      });
    });
  }

  // Repinta o combo a partir do <select> — chamado no boot, depois de
  // qualquer mudança de valor, e no reset de carregarAnuncios (o "Padrão"
  // forçado a cada busca/página nova precisa aparecer no combo também).
  function sincronizarComboOrdenacao() {
    var select = el("am-ordenacao");
    var trigger = el("am-ordenacao-trigger");
    if (!select || !trigger) return;

    var atual = parseValorOrdenacao(select.value);
    var filtro = filtroOrdenacaoPorBase(atual.base);
    var dir = atual.dir || filtro.dirPadrao || "desc";

    el("am-ordenacao-trigger-label").textContent = filtro.label;

    var dirBtn = el("am-ordenacao-dir");
    // Sem texto visível — vira ícone (2 setas, ver CSS). O rótulo continua
    // existindo, só que como aria-label/title (leitor de tela + tooltip).
    var rotulo = rotuloDirecaoOrdenacao(filtro, dir);
    dirBtn.setAttribute("aria-label", rotulo);
    dirBtn.title = rotulo;
    dirBtn.disabled = filtro.dirType === "none";
    if (filtro.dirType === "none") dirBtn.removeAttribute("data-dir");
    else dirBtn.setAttribute("data-dir", dir);

    var menu = el("am-ordenacao-menu");
    if (menu) {
      menu.querySelectorAll("[data-base]").forEach(function (btn) {
        var ativo = btn.getAttribute("data-base") === filtro.base;
        btn.classList.toggle("is-active", ativo);
        btn.setAttribute("aria-selected", ativo ? "true" : "false");
      });
    }
  }

  function aplicarValorOrdenacao(novoValor) {
    var select = el("am-ordenacao");
    if (!select) return;
    if (select.value === novoValor) {
      sincronizarComboOrdenacao();
      return;
    }
    select.value = novoValor;
    sincronizarComboOrdenacao();
    select.dispatchEvent(new Event("change"));
  }

  function selecionarFiltroOrdenacao(base) {
    fecharMenuOrdenacao();
    var select = el("am-ordenacao");
    if (!select) return;
    var atual = parseValorOrdenacao(select.value);
    var filtro = filtroOrdenacaoPorBase(base);

    if (filtro.dirType === "none") {
      aplicarValorOrdenacao("");
      return;
    }

    var dir = (atual.base === base && atual.dir) ? atual.dir : filtro.dirPadrao;
    aplicarValorOrdenacao(base + "_" + dir);
  }

  function alternarDirecaoOrdenacao() {
    var select = el("am-ordenacao");
    if (!select) return;
    var atual = parseValorOrdenacao(select.value);
    var filtro = filtroOrdenacaoPorBase(atual.base);
    if (filtro.dirType === "none") return;
    var dirAtual = atual.dir || filtro.dirPadrao;
    aplicarValorOrdenacao(atual.base + "_" + (dirAtual === "asc" ? "desc" : "asc"));
  }

  function alternarMenuOrdenacao() {
    var menu = el("am-ordenacao-menu");
    var trigger = el("am-ordenacao-trigger");
    if (!menu || !trigger) return;
    if (menu.hasAttribute("hidden")) {
      menu.removeAttribute("hidden");
      trigger.setAttribute("aria-expanded", "true");
    } else {
      fecharMenuOrdenacao();
    }
  }

  function fecharMenuOrdenacao() {
    var menu = el("am-ordenacao-menu");
    var trigger = el("am-ordenacao-trigger");
    if (!menu || !trigger) return;
    menu.setAttribute("hidden", "");
    trigger.setAttribute("aria-expanded", "false");
  }

  var CURVA_ABC_ORDEM = { A: 0, B: 1, C: 2 };

  // Critérios GLOBAIS (ordenam o catálogo inteiro no backend via
  // ordenarPor= na query de /anuncios-meli/familias — ver carregarAnuncios).
  // Unidades vendidas 7d entrou aqui porque buscarVendas7dPorItens já busca
  // a CONTA INTEIRA no período (globalizar não custa chamada extra — ver
  // ORDENACOES_GLOBAIS no controller).
  //
  // margem_asc/margem_desc entrou aqui (era ordenação LOCAL de página, via
  // ORDENACOES_PERFORMANCE/aplicarOrdenacaoPerformance, abaixo) — a leitura
  // do snapshot de margem projetada (`anuncios_margem_projetada_snapshot`,
  // fora do request) tornou viável ordenar o catálogo FILTRADO inteiro sem
  // passar pelo Motor/enrichBatch durante a listagem (ver
  // meliAnunciosController.listarAgrupadoOrdenadoPorMotor, branch
  // `margemProjetada`). O VALOR exibido na célula continua vindo de
  // /performance (live, ver carregarPerformance) — o backend só decide a
  // ORDEM aqui, nunca escreve no cache que a célula lê (mesma separação que
  // já existia pros outros 3 critérios: a célula sempre foi pintada por
  // /performance, o ordenarPor= só decide a posição da linha).
  var ORDENACOES_GLOBAIS = {
    faturamento_asc: 1, faturamento_desc: 1,
    curvaAbc_asc: 1, curvaAbc_desc: 1,
    unidades_asc: 1, unidades_desc: 1,
    margem_asc: 1, margem_desc: 1,
  };

  // Órfão: margem era o ÚLTIMO critério de ORDENACAO_FILTROS (linha ~1966)
  // que ainda ordenava localmente — com a migração acima, todo critério não-
  // vazio agora cai em ORDENACOES_GLOBAIS (ver o handler de "change" do
  // <select id="am-ordenacao">), então este mapa fica vazio e
  // aplicarOrdenacaoPerformance/valorOrdenacaoDaLinha/AM_ordemOriginalAnuncios
  // nunca mais são chamados. Não removido nesta missão (não é o escopo pedido
  // e mexer no fluxo de restauração de "Padrão" é risco desnecessário) — só
  // documentado, mesmo padrão de dívida registrada usado pra rota /familias
  // vencida (ver comentário de listarAgrupado no controller).
  var ORDENACOES_PERFORMANCE = {};

  // Soma unidadesVendidas.porItem dos filhos já conhecidos da família — null
  // enquanto a família não tem detalhe em cache (chamador garante isso antes
  // via garantirFamiliaDetalhe), não 0 fingido.
  function somarUnidadesDaFamilia(familyId, unidadesPorItem) {
    var familia = AM.state.familyCache[familyId];
    if (!familia) return null;
    var soma = null;
    (familia.user_products || []).forEach(function (up) {
      (up.itens || []).forEach(function (item) {
        var v = unidadesPorItem[item.item_id];
        if (v != null) soma = (soma || 0) + v;
      });
    });
    return soma;
  }

  // null (nunca 0/menor classe fingidos) sempre que o dado não existe para
  // esta linha — quem ordena trata null como "vai para o fim", nos dois
  // sentidos.
  function valorOrdenacaoDaLinha(linha, campo, dados) {
    if (linha.tipo === "familia") {
      var familyId = linha.family_id;
      if (campo === "margem") return dados.margemPorFamilia ? dados.margemPorFamilia[familyId] : null;
      if (campo === "faturamento") return dados.faturamento && dados.faturamento.porFamilia ? dados.faturamento.porFamilia[familyId] : null;
      if (campo === "curvaAbc") {
        var classeFam = dados.curvaAbc && dados.curvaAbc.porFamilia ? dados.curvaAbc.porFamilia[familyId] : null;
        return classeFam != null ? CURVA_ABC_ORDEM[classeFam] : null;
      }
      if (campo === "unidades") return somarUnidadesDaFamilia(familyId, (dados.unidadesVendidas && dados.unidadesVendidas.porItem) || {});
      return null;
    }
    var itemId = linha.item_id;
    // marginPercent — o MESMO valor que a coluna Margem mostra
    // (margemConteudoHtml lê esse campo do idêntico objeto dados.margem[itemId]).
    // NUNCA `profit` (R$ absoluto): profit não é o que o operador vê na tela,
    // e ordenar por ele produzia uma lista que parecia fora de ordem (bug
    // relatado — ver auditoria "Correção — ordenação margem e carregamento
    // faturamento").
    if (campo === "margem") return dados.margem && dados.margem[itemId] ? dados.margem[itemId].marginPercent : null;
    if (campo === "faturamento") return dados.faturamento && dados.faturamento.porItem ? dados.faturamento.porItem[itemId] : null;
    if (campo === "curvaAbc") {
      var classeItem = dados.curvaAbc && dados.curvaAbc.porItem ? dados.curvaAbc.porItem[itemId] : null;
      return classeItem != null ? CURVA_ABC_ORDEM[classeItem] : null;
    }
    if (campo === "unidades") return dados.unidadesVendidas && dados.unidadesVendidas.porItem ? dados.unidadesVendidas.porItem[itemId] : null;
    return null;
  }

  // Ordem original da página (a que o backend devolveu) — capturada na
  // primeira vez que o operador ordena, restaurada ao voltar para "Padrão"
  // sem recarregar do backend. Zerada a cada nova busca de página (ver
  // carregarAnuncios) — a ordem "original" de uma página velha não serve
  // para a página nova.
  var AM_ordemOriginalAnuncios = null;

  function aplicarOrdenacaoPerformance(criterio) {
    if (!AM.clienteAtual || !AM.anuncios.length) return;
    if (!AM_ordemOriginalAnuncios) AM_ordemOriginalAnuncios = AM.anuncios.slice();

    if (!criterio) {
      AM.anuncios = AM_ordemOriginalAnuncios.slice();
      renderCatalogo();
      return;
    }

    var config = ORDENACOES_PERFORMANCE[criterio];
    if (!config) return;

    var itemIdsIndividuais = [];
    var familyIds = [];
    AM.anuncios.forEach(function (l) {
      if (l.tipo === "familia") familyIds.push(l.family_id);
      else if (l.item_id) itemIdsIndividuais.push(l.item_id);
    });

    var qs = "clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug) +
      "&itemIds=" + encodeURIComponent(itemIdsIndividuais.join(",")) +
      "&incluirMetricas=0" +
      "&incluirMargem=" + (config.campo === "margem" ? "1" : "0") +
      "&incluirFaturamento=" + (config.campo === "faturamento" ? "1" : "0") +
      "&incluirCurvaAbc=" + (config.campo === "curvaAbc" ? "1" : "0") +
      "&incluirUnidades=" + (config.campo === "unidades" ? "1" : "0");
    if (familyIds.length) qs += "&familias=" + encodeURIComponent(familyIds.join("|"));
    if (AM.contaMlId) qs += "&clienteContaId=" + encodeURIComponent(AM.contaMlId);

    // Unidades por família precisa dos filhos já conhecidos (a única das 4
    // métricas que agrega no cliente) — garante o detalhe antes de somar.
    // Nos outros 3 critérios a família já vem agregada pronta do backend.
    var prontoFilhos = config.campo === "unidades" && familyIds.length
      ? Promise.all(familyIds.map(garantirFamiliaDetalhe))
      : Promise.resolve();

    prontoFilhos.then(function () {
      return api("/anuncios-meli/performance?" + qs);
    }).then(function (r) {
      var dados = (r.data && r.data.ok) ? r.data : {};

      // Escreve margem no MESMO cache que a célula da lista já lê — a coluna
      // Margem repinta com o valor real, sem duplicar estado.
      if (config.campo === "margem" && dados.margem) {
        itemIdsIndividuais.forEach(function (itemId) {
          var atual = AM.state.performanceCache[itemId] || {
            metricas7d: null, temMetricas: false, margem: null, margemIndisponivel: null, temMargem: false,
            composicao: null, temComposicao: false,
          };
          atual.margem = dados.margem[itemId] || null;
          atual.margemIndisponivel = dados.margemIndisponivel || null;
          atual.temMargem = true;
          AM.state.performanceCache[itemId] = atual;
        });
      }

      // Mesma lógica para % faturamento e Curva ABC: escreve no cache que as
      // CÉLULAS da lista leem (faturamentoCelulaHtml/badgesAnuncioHtml), para
      // o valor usado na ordenação ficar visível na linha — nunca um número
      // diferente do que decidiu a posição (ver auditoria "Ajuste visual —
      // métricas de performance"). Família usa o agregado pronto do backend
      // (porFamilia), nunca o de um filho isolado.
      if (config.campo === "faturamento" && dados.faturamento) {
        itemIdsIndividuais.forEach(function (itemId) {
          var porItem = dados.faturamento.porItem || {};
          AM.state.faturamentoCache[itemId] = porItem[itemId] != null ? porItem[itemId] : null;
        });
        familyIds.forEach(function (familyId) {
          var porFamilia = dados.faturamento.porFamilia || {};
          AM.state.faturamentoPorFamiliaCache[familyId] = porFamilia[familyId] != null ? porFamilia[familyId] : null;
        });
      }
      if (config.campo === "curvaAbc" && dados.curvaAbc) {
        itemIdsIndividuais.forEach(function (itemId) {
          var porItem = dados.curvaAbc.porItem || {};
          AM.state.curvaAbcCache[itemId] = porItem[itemId] || null;
        });
        familyIds.forEach(function (familyId) {
          var porFamilia = dados.curvaAbc.porFamilia || {};
          AM.state.curvaAbcPorFamiliaCache[familyId] = porFamilia[familyId] || null;
        });
      }

      var comValor = AM.anuncios.map(function (linha) {
        return { linha: linha, valor: valorOrdenacaoDaLinha(linha, config.campo, dados) };
      });
      // Sem valor conhecido sempre vai para o fim, nas duas direções — "não
      // sei" não pode competir com um valor real, em nenhum sentido.
      comValor.sort(function (a, b) {
        if (a.valor == null && b.valor == null) return 0;
        if (a.valor == null) return 1;
        if (b.valor == null) return -1;
        return config.direcao === "asc" ? a.valor - b.valor : b.valor - a.valor;
      });

      AM.anuncios = comValor.map(function (x) { return x.linha; });
      renderCatalogo();
    });
  }

  // Repinta SÓ a linha-mãe (nunca o painel, nunca renderCatalogo — fechar
  // todos os agrupadores abertos seria o mesmo bug que atualizarAgregadosDoGrupo
  // já evita). metricas7dAgregadoCelulaHtml lê o agregado do cache — não há
  // estado próprio para sincronizar, só um novo render a partir da MESMA
  // fonte de sempre (AM.state.familyCache + AM.state.performanceCache).
  function repintarLinhaDoGrupo(familyId) {
    var linha = document.querySelector('.am-row--grupo[data-familia="' + familyId + '"]');
    if (!linha) return;
    for (var i = 0; i < AM.anuncios.length; i++) {
      var g = AM.anuncios[i];
      if (g.tipo !== "familia" || String(g.family_id) !== String(familyId)) continue;
      var nova = document.createElement("div");
      nova.innerHTML = rowGrupoHtml(g, i);
      var substituta = nova.firstElementChild;
      var aberta = linha.getAttribute("aria-expanded") === "true";
      substituta.setAttribute("aria-expanded", aberta ? "true" : "false");
      if (aberta) substituta.classList.add("is-aberta");
      linha.parentNode.replaceChild(substituta, linha);
      substituta.addEventListener("click", function () { alternarGrupo(substituta); });
      substituta.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); alternarGrupo(substituta); }
      });
      return;
    }
  }

  // Só pinta células que ainda existem no DOM (trocar de página/cliente no
  // meio do caminho não pinta a tela errada — o item simplesmente não é
  // mais encontrado) e só as que fazem parte DESTE lote (`alvo`), nunca
  // sobrescrevendo a célula de um item de outra leitura em andamento.
  function pintarPerformanceEmCelulas(ids) {
    var alvo = {};
    ids.forEach(function (id) { alvo[id] = true; });

    document.querySelectorAll(".am-metricas7d[data-metricas-item]").forEach(function (cel) {
      var id = cel.getAttribute("data-metricas-item");
      if (!alvo[id]) return;
      var cache = AM.state.performanceCache[id];
      cel.classList.remove("am-metricas7d--carregando");
      cel.innerHTML = metricas7dConteudoHtml(cache ? cache.metricas7d : null);
    });
    // Margem projetada NÃO repinta mais aqui: a célula nasce pronta a partir
    // do snapshot (margemCelulaHtml lê direto do `anuncio`, sem estado
    // "carregando") — nada em /performance decide o valor dela nunca mais.
    document.querySelectorAll(".am-faturamento[data-faturamento-item]").forEach(function (cel) {
      var id = cel.getAttribute("data-faturamento-item");
      if (!alvo[id]) return;
      var v = Object.prototype.hasOwnProperty.call(AM.state.faturamentoCache, id) ? AM.state.faturamentoCache[id] : null;
      var valor = Object.prototype.hasOwnProperty.call(AM.state.faturamentoValorCache, id) ? AM.state.faturamentoValorCache[id] : null;
      cel.innerHTML = faturamentoConteudoHtml(v, valor);
    });
    // Curva ABC — tag própria (data-abc-item), separada dos badges estáticos
    // (ver curvaAbcBadgeHtml/badgesAnuncioHtml): chega assíncrona, então
    // precisa deste repaint pontual pra aparecer sem reconstruir a linha.
    document.querySelectorAll("[data-abc-item]").forEach(function (cel) {
      var id = cel.getAttribute("data-abc-item");
      if (!alvo[id]) return;
      cel.innerHTML = curvaAbcBadgeHtml(AM.state.curvaAbcCache[id]);
    });
    // Preço: atual e cheio têm a MESMA regra de prioridade (ver
    // celulaPrecoHtml) — quando a margem já resolveu (`temMargem`), os dois
    // vêm ao vivo do Motor (precoAtual/precoOriginal, sale_price via
    // resolverPrecosItem); antes disso, ou quando o Motor não tem preço,
    // caem no snapshot sincronizado (data-preco-sync/data-preco-original-db).
    // Reconstrói a célula inteira (não só o span "atual") porque o riscado
    // pode NASCER ou SUMIR ao vivo — uma promoção que só existe no
    // sale_price (ex. automação de preço) não tinha `preco_original` no
    // snapshot, e uma promoção que já acabou não pode continuar riscada só
    // porque o snapshot é antigo.
    document.querySelectorAll("[data-preco-item]").forEach(function (cel) {
      var id = cel.getAttribute("data-preco-item");
      if (!alvo[id]) return;
      var cache = AM.state.performanceCache[id];
      var m = cache && cache.margem;
      var classe = cel.getAttribute("data-preco-classe") || "am-mlb__preco";
      var moeda = cel.getAttribute("data-moeda") || "";
      var syncAttr = cel.getAttribute("data-preco-sync");
      var syncOriginalAttr = cel.getAttribute("data-preco-original-db");
      var atual = m && m.precoAtual != null ? m.precoAtual : (syncAttr !== "" ? Number(syncAttr) : null);
      var cheioBruto = cache && cache.temMargem
        ? (m && m.precoOriginal != null ? m.precoOriginal : null)
        : (syncOriginalAttr !== "" ? Number(syncOriginalAttr) : null);
      var cheio = precoCheioReal(atual, cheioBruto);
      cel.className = classe + (cheio ? " " + classe + "--promo" : "");
      cel.innerHTML = precoCelulaConteudoHtml(classe, atual, cheio, moeda);
    });
  }

  // ===========================================================================
  // ESTOQUE EDITÁVEL NA LINHA DO MLB
  //
  // A edição parte de um anúncio, mas o estoque NÃO é do anúncio: no modelo de
  // User Products o ML replica `available_quantity` em todos os itens do mesmo
  // user_product_id (documentacao_api_meli/user-products.md). Então salvar a
  // partir do Clássico muda o Premium da mesma variação junto — e a tela mostra
  // isso na hora, nos dois, porque é o que o ML garante. Quem faz a escrita é
  // PATCH /anuncios-meli/:itemId/estoque -> PUT /items { available_quantity };
  // os irmãos afetados voltam na resposta (itens_sincronizados), nunca são
  // deduzidos aqui.
  //
  // A célula ocupa a MESMA coluna de estoque de sempre. Nenhuma coluna nova:
  // a grade --am-cols é compartilhada com o cabeçalho e com a linha-mãe.
  // ===========================================================================

  function botaoEstoqueHtml(rotulo) {
    return '<button type="button" class="am-estoque__btn" ' +
      'title="Editar o estoque desta variação no Mercado Livre" ' +
      'aria-label="Estoque ' + escapeAttr(rotulo) + ' — editar no Mercado Livre">' +
      escapeHtml(rotulo) + "</button>";
  }

  // Célula de preço da lista (linha do agrupador/avulso e linha da expansão
  // compartilham a mesma grade --am-cols, ver rowMlbCompactaHtml/rowAnuncioHtml)
  // — mesmo padrão de celulaEstoqueHtml(a, classeColuna) logo abaixo.
  //
  // Conteúdo interno da célula de preço — compartilhado entre o primeiro
  // render (celulaPrecoHtml) e o repaint ao vivo (pintarPerformanceEmCelulas),
  // que precisa poder reconstruir a MESMA estrutura sem ter `a` à mão (só o
  // que ficou gravado em data-* na própria célula — ver celulaPrecoHtml).
  // Só é promoção de verdade quando existe diferença real de preço — sem
  // isso, `regular_amount` voltando igual (ou menor, por atraso de cotação)
  // a `amount` riscaria o MESMO valor que já é exibido como atual.
  function precoCheioReal(atual, cheio) {
    return cheio != null && atual != null && cheio > atual ? cheio : null;
  }

  function precoCelulaConteudoHtml(classe, atual, cheio, moeda) {
    if (!cheio) return formatMoeda(atual, moeda);
    return '<span class="' + classe + '-original">' + formatMoeda(cheio, moeda) + "</span>" +
      '<span class="' + classe + '-atual">' + formatMoeda(atual, moeda) + "</span>";
  }

  // O valor "atual" prioriza `margem[itemId].precoAtual` (`item.pricing.current`,
  // obtido AO VIVO pelo Motor de Margem via GET /performance — mesma cotação
  // de sale_price que a composição do modal usa como `venda`) sobre o preço
  // sincronizado (`a.preco`). O preço "cheio" riscado segue a MESMA regra,
  // com `margem[itemId].precoOriginal` (`item.pricing.list`,
  // sale_price.regular_amount) sobre `a.preco_original` — as duas fontes só
  // divergem enquanto a performance ainda não chegou, ou quando o Motor não
  // tem evidência de nenhum dos dois (nunca 0, nunca copiado de outro campo).
  //
  // `data-preco-item`/`data-preco-classe`/`data-preco-sync`/
  // `data-preco-original-db`/`data-moeda` são o que permite
  // pintarPerformanceEmCelulas reconstruir esta MESMA célula ao vivo sem
  // precisar de `a` de novo — necessário porque agora o riscado também pode
  // NASCER ou SUMIR quando a performance resolve (antes só o "atual" mudava).
  function celulaPrecoHtml(a, classeColuna) {
    var classe = classeColuna || "am-mlb__preco";
    var cache = AM.state.performanceCache[a.item_id];
    var m = cache && cache.margem;
    var atual = m && m.precoAtual != null ? m.precoAtual : a.preco;
    var cheioBruto = cache && cache.temMargem
      ? (m && m.precoOriginal != null ? m.precoOriginal : null)
      : (a.preco_original || null);
    var cheio = precoCheioReal(atual, cheioBruto);

    return '<span class="' + classe + (cheio ? " " + classe + "--promo" : "") +
      '" data-preco-item="' + escapeAttr(a.item_id) +
      '" data-preco-classe="' + escapeAttr(classe) +
      '" data-preco-sync="' + (a.preco == null ? "" : escapeAttr(a.preco)) +
      '" data-preco-original-db="' + (a.preco_original == null ? "" : escapeAttr(a.preco_original)) +
      '" data-moeda="' + escapeAttr(a.moeda || "") + '">' +
      precoCelulaConteudoHtml(classe, atual, cheio, a.moeda) +
    "</span>";
  }

  // ---------------------------------------------------------------------------
  // PREÇO DE UMA VARIAÇÃO LEGADA — investigação confirmou que o ML não
  // documenta sale_price/promoção por variação (só por ANÚNCIO, via
  // GET /items/{id}/sale_price). A origem dos dados não muda: variation.price
  // continua sendo o preço base da variação, e o preço promocional continua
  // vindo do contexto do anúncio (Motor de Margem) — nada novo é inventado
  // aqui, nenhum sale_price por variação é criado.
  //
  // O que mudou é só a APRESENTAÇÃO: em vez de uma nota secundária por
  // extenso, esta célula agora usa o MESMO componente visual da linha
  // principal (precoCheioReal + precoCelulaConteudoHtml, ver celulaPrecoHtml)
  // — cheio riscado em cima, vigente em destaque embaixo. A diferença é só
  // QUAL valor entra em cada papel: aqui é sempre variation.price no papel de
  // "cheio" e o preço ao vivo do anúncio no papel de "atual", nunca o
  // contrário — por isso variation.price nunca é riscado nem substituído
  // (precoCheioReal só risca o valor MAIOR, e variation.price é sempre >= o
  // preço promocional vigente do anúncio, nunca o contrário).
  //
  // Reaproveita só leitura de AM.state.performanceCache/precoCheioReal — não
  // participa do repaint ao vivo de pintarPerformanceEmCelulas (que usa
  // [data-preco-item] para RECONSTRUIR a célula a partir de a.preco/
  // a.preco_original, que não existem numa variação). Sem problema: o painel
  // de variações é sempre repintado do zero (reabrir o toggle, ou depois de
  // uma edição de estoque), e a essa altura a performance do item já veio do
  // pré-carregamento em background.
  function celulaPrecoVariacaoLegadoHtml(v, itemId, moeda) {
    var classe = "am-mlb__preco";
    var cache = AM.state.performanceCache[itemId];
    var m = cache && cache.temMargem && cache.margem;
    var atual = m && m.precoAtual != null ? m.precoAtual : null;
    var cheio = precoCheioReal(atual, v.preco);

    if (!cheio) return '<span class="' + classe + '">' + escapeHtml(formatMoeda(v.preco, moeda)) + "</span>";

    return '<span class="' + classe + " " + classe + '--promo">' +
      precoCelulaConteudoHtml(classe, atual, cheio, moeda) +
    "</span>";
  }

  // `classeColuna` é a classe de coluna do nível que está desenhando a linha
  // (.am-mlb__num no filho, .am-row__num no anúncio individual): a célula se
  // comporta igual nos dois, mas continua vestida como a coluna do seu nível.
  // `.am-estoque` é o que marca "esta célula é editável" — é por ela que o
  // bind acha as células e que os handlers de linha sabem não abrir o modal.
  function celulaEstoqueHtml(a, classeColuna) {
    var tem = a.estoque != null;
    return '<span class="' + (classeColuna || "am-mlb__num") + ' am-estoque" data-estoque-item="' +
      escapeAttr(a.item_id) + '" data-estoque-valor="' +
      escapeAttr(tem ? a.estoque : "") + '">' +
      botaoEstoqueHtml(tem ? String(a.estoque) : "—") + "</span>";
  }

  function bindEstoqueEditavel(raiz) {
    raiz.querySelectorAll(".am-estoque").forEach(function (cel) {
      cel.addEventListener("click", function (e) {
        // A célula fica DENTRO da linha, que abre o modal. O clique aqui é
        // sempre da célula — nunca escala para a linha.
        e.stopPropagation();
        if (e.target.closest(".am-estoque__btn")) abrirEditorEstoque(cel);
      });
    });
  }

  // Estados da célula, todos nela mesma: leitura -> edição -> salvando ->
  // leitura. O `data-estoque-valor` é a memória do valor de leitura, e é o que
  // o Esc restaura.
  function pintarEstoqueLeitura(cel) {
    var bruto = cel.getAttribute("data-estoque-valor");
    cel.removeAttribute("data-estoque-editando");
    cel.classList.remove("is-editando", "is-salvando");
    cel.innerHTML = botaoEstoqueHtml(bruto === "" || bruto === null ? "—" : bruto);
  }

  function abrirEditorEstoque(cel) {
    if (cel.getAttribute("data-estoque-editando") === "1") return;
    if (cel.classList.contains("is-salvando")) return;
    var atual = cel.getAttribute("data-estoque-valor") || "";
    cel.setAttribute("data-estoque-editando", "1");
    cel.classList.add("is-editando");
    // O campo é `number` com min 0 e sem casas: 0 é valor válido e
    // significativo (o ML pausa o anúncio por falta de estoque), então nada
    // aqui pode tratar 0 como "vazio".
    cel.innerHTML = '<input type="number" class="am-estoque__input" min="0" step="1" ' +
      'inputmode="numeric" value="' + escapeAttr(atual) + '" ' +
      'title="Enter salva no Mercado Livre, Esc cancela" ' +
      'aria-label="Estoque em unidades. Enter salva no Mercado Livre, Esc cancela." />';
    var input = cel.querySelector(".am-estoque__input");
    if (!input) return;
    input.focus();
    input.select();

    input.addEventListener("keydown", function (e) {
      // stopPropagation PRIMEIRO, antes de qualquer coisa que mexa no DOM.
      //
      // A linha é role="button" e trata Enter como "abrir o modal"; o guard
      // dela ignora eventos vindos da célula via `e.target.closest('.am-estoque')`.
      // Só que salvar/cancelar substitui o innerHTML da célula, o que
      // DESLIGA o input do documento — e um nó solto não tem `closest` que
      // chegue à célula. O guard passava a falhar e o Enter de salvar abria o
      // modal por cima. Barrar a subida antes de mexer no DOM é o que fecha
      // isso, e não depende de ordem de listener.
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        salvarEstoque(cel, input.value);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        pintarEstoqueLeitura(cel);
      }
    });

    // Sair do campo CANCELA — nunca salva. Escrever num anúncio real por
    // distração (um clique fora, um Tab) seria efeito colateral inaceitável
    // numa tela que lista centenas de anúncios. Salvar é sempre Enter.
    input.addEventListener("blur", function () {
      if (cel.classList.contains("is-salvando")) return;
      pintarEstoqueLeitura(cel);
    });
  }

  function salvarEstoque(cel, bruto) {
    var itemId = cel.getAttribute("data-estoque-item");
    var anterior = cel.getAttribute("data-estoque-valor") || "";
    var texto = String(bruto == null ? "" : bruto).trim();

    // Nada mudou: não gasta uma escrita no Mercado Livre.
    if (texto === anterior) { pintarEstoqueLeitura(cel); return; }
    if (!/^\d+$/.test(texto)) {
      toast("O estoque precisa ser um número inteiro igual ou maior que zero.", "is-danger");
      pintarEstoqueLeitura(cel);
      return;
    }

    cel.classList.remove("is-editando");
    cel.classList.add("is-salvando");
    cel.removeAttribute("data-estoque-editando");
    cel.innerHTML = '<span class="am-estoque__salvando" aria-live="polite">salvando…</span>';

    var corpo = { clienteSlug: AM.clienteAtual.slug, estoque: Number(texto) };
    if (AM.contaMlId) corpo.clienteContaId = AM.contaMlId;

    api("/anuncios-meli/" + encodeURIComponent(itemId) + "/estoque", {
      method: "PATCH",
      body: corpo,
    }).then(function (r) {
      var dados = r.data || {};
      if (!dados.ok) {
        // O snapshot não mudou no servidor, então a célula volta ao valor de
        // antes. A recusa do ML é mostrada como ela veio — não é traduzida
        // nem resumida em "erro ao salvar".
        cel.classList.remove("is-salvando");
        pintarEstoqueLeitura(cel);
        toast(dados.motivo || "Não foi possível salvar o estoque.", "is-danger");
        return;
      }
      cel.classList.remove("is-salvando");
      aplicarEstoqueConfirmado(cel, itemId, dados);
    });
  }

  // Reflete na tela o que o ML CONFIRMOU: o item editado, os irmãos do mesmo
  // MLBU (regra do ML, lista vinda do SERVIDOR — nunca deduzida aqui) e o
  // estoque agregado do agrupador. Sem reconsultar a lista, que colapsaria as
  // expansões e tiraria o operador do lugar onde ele estava.
  function aplicarEstoqueConfirmado(cel, itemId, dados) {
    var afetados = {};
    afetados[itemId] = true;
    (dados.itens_sincronizados || []).forEach(function (id) { afetados[id] = true; });

    var painel = cel.closest(".am-grupo-painel");
    var linha = painel && painel.previousElementSibling;
    var familyId = linha && linha.getAttribute("data-familia");
    var familia = familyId ? AM.state.familyCache[familyId] : null;

    if (familia) {
      // Dentro de um agrupador: o cache é a fonte do painel e do agregado, e
      // por isso é ele que tem de mudar primeiro — colapsar e reabrir lê o
      // cache, não a rede.
      (familia.user_products || []).forEach(function (up) {
        (up.itens || []).forEach(function (item) {
          if (!afetados[item.item_id]) return;
          item.estoque = dados.estoque;
          // Status só do item editado, e só o que o servidor devolveu: o ML
          // pausa/reativa por falta de estoque, mas `status` NÃO está na lista
          // de campos que ele replica por User Product — supor a transição do
          // irmão seria inventar.
          if (item.item_id === itemId && dados.anuncio && dados.anuncio.status) {
            item.status = dados.anuncio.status;
          }
        });
      });
      renderFamiliaDetalhe(familia, painel);
      atualizarAgregadosDoGrupo(familyId, familia, linha);
    }

    // Linhas de anúncio individual da lista (tipo "item"): o estado da lista
    // também tem de acompanhar, senão uma troca de página repinta o número
    // velho. Um anúncio individual não tem irmão de variação na prática (a
    // relação UP:item ali é 1:1), mas se o servidor disser que tem, o que ele
    // disse é que vale.
    AM.anuncios.forEach(function (g) {
      if (g.tipo !== "item" || !afetados[g.item_id]) return;
      g.estoque = dados.estoque;
      g.estoque_total = dados.estoque;
      var statusNovo = g.item_id === itemId && dados.anuncio && dados.anuncio.status;
      if (!statusNovo || statusNovo === g.status) return;
      // O ML pausa o anúncio quando o estoque vai a zero (e reativa quando
      // volta): deixar a linha dizendo "Ativo" seria a tela mentindo sobre o
      // que acabou de acontecer. Repinta a linha inteira, no lugar.
      g.status = statusNovo;
      var alvo = document.querySelector('.am-row[data-item="' + g.item_id + '"]');
      if (!alvo) return;
      // O painel de variações legadas (irmão de alvo, quando existe) NÃO é
      // tocado por este replaceChild — só a linha troca. Só falta repor o
      // aria-expanded do NOVO botão-toggle se o painel já estava aberto,
      // senão o chevron voltaria a "fechado" com o conteúdo ainda visível.
      var painelLegadoAberto = alvo.nextElementSibling &&
        alvo.nextElementSibling.classList.contains("am-grupo-painel") &&
        !alvo.nextElementSibling.hidden;
      var caixa = document.createElement("div");
      caixa.innerHTML = rowAnuncioHtml(g, AM.anuncios.indexOf(g));
      // Vincula com a linha ainda DENTRO da caixa temporária: os binds varrem
      // os descendentes da raiz, então passar o container da lista aqui
      // duplicaria os listeners de todas as outras linhas — e um clique
      // passaria a abrir o modal duas vezes. Listener sobrevive a mover o nó.
      bindLinhasAnuncio(caixa);
      bindEstoqueEditavel(caixa);
      var novaLinha = caixa.firstElementChild;
      if (painelLegadoAberto) {
        var novoToggle = novaLinha.querySelector(".am-row__variacoes-toggle");
        if (novoToggle) { novoToggle.setAttribute("aria-expanded", "true"); novaLinha.classList.add("is-aberta"); }
      }
      alvo.parentNode.replaceChild(novaLinha, alvo);
    });

    // Por último, qualquer célula ainda visível dos itens afetados que o
    // repinte acima não tenha alcançado (o irmão numa outra linha da lista, a
    // própria célula quando a edição partiu de um anúncio individual).
    pintarCelulasDeEstoque(afetados, dados.estoque);

    var irmaos = (dados.itens_sincronizados || []).length;
    toast(
      irmaos
        ? "Estoque atualizado no Mercado Livre — e nos outros " +
          plural(irmaos, "anúncio desta variação", "anúncios desta variação") + "."
        : "Estoque atualizado no Mercado Livre.",
      "is-success"
    );
  }

  function pintarCelulasDeEstoque(afetados, valor) {
    document.querySelectorAll(".am-estoque[data-estoque-item]").forEach(function (c) {
      if (!afetados[c.getAttribute("data-estoque-item")]) return;
      c.setAttribute("data-estoque-valor", String(valor));
      c.classList.remove("is-salvando");
      pintarEstoqueLeitura(c);
    });
  }

  // ===========================================================================
  // ESTOQUE EDITÁVEL DE VARIAÇÃO LEGADA (item_id -> variations[])
  //
  // Mesma interação do bloco "ESTOQUE EDITÁVEL NA LINHA DO MLB" acima (clique
  // no número, Enter salva, Esc/perder foco cancela, `botaoEstoqueHtml`
  // compartilhado) — mas a escrita e a reação a sucesso são outras:
  //
  //   PATCH /anuncios-meli/:itemId/variacoes-legado/:variationId/estoque
  //   -> meliVariacoesLegadoEstoqueService: GET fresco -> PUT /items com a
  //      propriedade `variations` INTEIRA -> GET de confirmação.
  //
  // Não existe replicação por User Product aqui (o modelo legado não tem
  // User Product) e não existe patch otimista de uma célula só: a escrita
  // reenvia o array inteiro de variações, então em caso de sucesso o PAINEL
  // INTEIRO é substituído pelas variações FRESCAS que o backend acabou de
  // confirmar (`dados.variacoes`) — nunca um número isolado calculado aqui.
  //
  // `dados.critico` (perda de variação detectada pelo backend DEPOIS do PUT)
  // nunca é tratado como falha comum: o cache local é descartado e o painel é
  // recarregado do zero, porque a tela não pode continuar mostrando um estado
  // que pode não existir mais no Mercado Livre.
  // ===========================================================================

  // podeEditarEstoque/motivoBloqueioTexto vêm PRONTOS do backend
  // (mapearVariacaoLegado -> avaliarBloqueioEdicaoVariacaoLegado): esta função
  // NUNCA interpreta inventory_id/logistic_type — só desenha o que o service
  // já decidiu. Bloqueada: valor em texto puro (sem botão, mesmo padrão do
  // preço travado por promoção em margemComposicaoLinhaPrecoHtml) + o motivo
  // visível de cara, nunca só descoberto depois de tentar salvar.
  function celulaEstoqueVariacaoLegadoHtml(v, itemId) {
    var tem = v.estoque != null;
    var valorHtml = tem ? String(v.estoque) : "—";
    if (v.podeEditarEstoque === false) {
      var motivo = v.motivoBloqueioTexto || "O estoque desta variação não pode ser editado aqui.";
      return '<span class="am-mlb__num am-estoque am-estoque--bloqueado" title="' + escapeAttr(motivo) + '">' +
        '<span class="am-estoque__valor">' + escapeHtml(valorHtml) + "</span>" +
        infoDotHtml(motivo, "Por que este estoque não pode ser editado") +
      "</span>";
    }
    return '<span class="am-mlb__num am-estoque" data-variacao-item="' + escapeAttr(itemId) +
      '" data-variacao-id="' + escapeAttr(v.id) +
      '" data-estoque-valor="' + escapeAttr(tem ? v.estoque : "") + '">' +
      botaoEstoqueHtml(valorHtml) + "</span>";
  }

  function bindEstoqueVariacaoLegadoEditavel(painel) {
    painel.querySelectorAll(".am-estoque[data-variacao-id]").forEach(function (cel) {
      cel.addEventListener("click", function (e) {
        e.stopPropagation();
        if (e.target.closest(".am-estoque__btn")) abrirEditorEstoqueVariacaoLegado(cel);
      });
    });
  }

  function pintarEstoqueVariacaoLegadoLeitura(cel) {
    var bruto = cel.getAttribute("data-estoque-valor");
    cel.removeAttribute("data-estoque-editando");
    cel.classList.remove("is-editando", "is-salvando");
    cel.innerHTML = botaoEstoqueHtml(bruto === "" || bruto === null ? "—" : bruto);
  }

  function abrirEditorEstoqueVariacaoLegado(cel) {
    if (cel.getAttribute("data-estoque-editando") === "1") return;
    if (cel.classList.contains("is-salvando")) return;
    var atual = cel.getAttribute("data-estoque-valor") || "";
    cel.setAttribute("data-estoque-editando", "1");
    cel.classList.add("is-editando");
    cel.innerHTML = '<input type="number" class="am-estoque__input" min="0" step="1" ' +
      'inputmode="numeric" value="' + escapeAttr(atual) + '" ' +
      'title="Enter salva no Mercado Livre, Esc cancela" ' +
      'aria-label="Estoque em unidades. Enter salva no Mercado Livre, Esc cancela." />';
    var input = cel.querySelector(".am-estoque__input");
    if (!input) return;
    input.focus();
    input.select();

    input.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        salvarEstoqueVariacaoLegado(cel, input.value);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        pintarEstoqueVariacaoLegadoLeitura(cel);
      }
    });

    // Sair do campo CANCELA — nunca salva (mesma decisão do editor do MLB).
    input.addEventListener("blur", function () {
      if (cel.classList.contains("is-salvando")) return;
      pintarEstoqueVariacaoLegadoLeitura(cel);
    });
  }

  function salvarEstoqueVariacaoLegado(cel, bruto) {
    var itemId = cel.getAttribute("data-variacao-item");
    var variationId = cel.getAttribute("data-variacao-id");
    var anterior = cel.getAttribute("data-estoque-valor") || "";
    var texto = String(bruto == null ? "" : bruto).trim();

    if (texto === anterior) { pintarEstoqueVariacaoLegadoLeitura(cel); return; }
    if (!/^\d+$/.test(texto)) {
      toast("O estoque precisa ser um número inteiro igual ou maior que zero.", "is-danger");
      pintarEstoqueVariacaoLegadoLeitura(cel);
      return;
    }

    cel.classList.remove("is-editando");
    cel.classList.add("is-salvando");
    cel.removeAttribute("data-estoque-editando");
    cel.innerHTML = '<span class="am-estoque__salvando" aria-live="polite">salvando…</span>';

    var corpo = { clienteSlug: AM.clienteAtual.slug, estoque: Number(texto) };
    if (AM.contaMlId) corpo.clienteContaId = AM.contaMlId;

    api(
      "/anuncios-meli/" + encodeURIComponent(itemId) +
      "/variacoes-legado/" + encodeURIComponent(variationId) + "/estoque",
      { method: "PATCH", body: corpo }
    ).then(function (r) {
      var dados = r.data || {};
      var painel = cel.closest(".am-grupo-painel");

      if (!dados.ok) {
        cel.classList.remove("is-salvando");
        pintarEstoqueVariacaoLegadoLeitura(cel);
        if (dados.critico) {
          // O backend detectou que a contagem de variações pode ter caído
          // depois do PUT: o cache local não é confiável. Descarta e força
          // uma releitura, em vez de deixar a tela mentir por omissão.
          delete AM.state.variacoesLegadoCache[itemId];
          toast(
            dados.motivo || "Uma ou mais variações deste anúncio podem ter sido alteradas de forma inesperada. Confira no Mercado Livre.",
            "is-danger"
          );
          if (painel) carregarVariacoesLegado(itemId, painel);
        } else {
          toast(dados.motivo || "Não foi possível salvar o estoque desta variação.", "is-danger");
        }
        return;
      }

      cel.classList.remove("is-salvando");
      // Sucesso: o painel inteiro é substituído pelas variações FRESCAS que o
      // backend acabou de confirmar — a escrita reenviou o array inteiro, e
      // qualquer variação pode ter mudado entre a leitura e a confirmação.
      AM.state.variacoesLegadoCache[itemId] = dados.variacoes;
      if (painel) renderVariacoesLegadoDetalhe(dados.variacoes, painel, itemId);
      toast("Estoque da variação atualizado no Mercado Livre.", "is-success");
    });
  }

  // Recalcula os agregados da linha-mãe a partir do cache da família, pela
  // MESMA régua do banco:
  //
  //   estoque_total   = soma do estoque por User Product DISTINTO
  //                     (CTE estoque_por_up usa MAX(estoque) por UP, porque o
  //                     ML replica o valor entre os itens do UP — somar item a
  //                     item duplicaria);
  //   status_contagem = contagem por status sobre TODOS os itens do grupo.
  //
  // É legítimo recalcular aqui porque o detalhe da família cobre exatamente o
  // mesmo conjunto que a linha agrega: os agregados da listagem são do grupo
  // inteiro e NÃO sofrem o filtro/busca (ver meliFamiliaService, CTE `grupos`
  // vs `selecionados`).
  function atualizarAgregadosDoGrupo(familyId, familia, linha) {
    var estoqueTotal = 0;
    var contagem = { ativos: 0, pausados: 0, encerrados: 0 };
    var totalItens = 0;

    (familia.user_products || []).forEach(function (up) {
      var maior = null;
      (up.itens || []).forEach(function (item) {
        totalItens++;
        if (item.status === "active") contagem.ativos++;
        else if (item.status === "paused") contagem.pausados++;
        else if (item.status === "closed") contagem.encerrados++;
        if (item.estoque != null && (maior === null || item.estoque > maior)) maior = item.estoque;
      });
      if (maior !== null) estoqueTotal += maior;
    });

    for (var i = 0; i < AM.anuncios.length; i++) {
      var g = AM.anuncios[i];
      if (g.tipo !== "familia" || String(g.family_id) !== String(familyId)) continue;
      g.estoque_total = estoqueTotal;
      g.status_contagem = contagem;
      g.total_itens = totalItens;
      if (linha) {
        // Repinta só a linha-mãe, no lugar: renderCatalogo() inteiro fecharia
        // todos os painéis abertos.
        var nova = document.createElement("div");
        nova.innerHTML = rowGrupoHtml(g, i);
        var substituta = nova.firstElementChild;
        var aberta = linha.getAttribute("aria-expanded") === "true";
        substituta.setAttribute("aria-expanded", aberta ? "true" : "false");
        if (aberta) substituta.classList.add("is-aberta");
        linha.parentNode.replaceChild(substituta, linha);
        substituta.addEventListener("click", function () { alternarGrupo(substituta); });
        substituta.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); alternarGrupo(substituta); }
        });
      }
      break;
    }
  }

  // Mesmo contrato de interação da linha do catálogo: clique ou Enter/Espaço
  // abrem o modal de sempre; o link externo continua sendo do navegador.
  function bindLinhasMlb(raiz) {
    raiz.querySelectorAll(".am-mlb[data-item]").forEach(function (row) {
      function abrir() { abrirDetalhe(row.getAttribute("data-item"), row); }
      // Duas exceções, e o motivo é o mesmo: são controles PRÓPRIOS dentro da
      // linha. O link externo é do navegador; a célula de estoque edita no
      // lugar. Nenhum dos dois pode abrir o modal por cima do que o operador
      // estava fazendo.
      function ehControleProprio(e) {
        return !!(e.target.closest(".am-row__link") || e.target.closest(".am-estoque"));
      }
      row.addEventListener("click", function (e) {
        if (ehControleProprio(e)) return;
        abrir();
      });
      row.addEventListener("keydown", function (e) {
        if (ehControleProprio(e)) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); abrir(); }
      });
    });
  }

  function iconeImagemSvg() {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5">' +
      '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/>' +
      '<path d="M21 15l-5-5-4 4-3-3-6 6"/></svg>';
  }

  function iconeExternoSvg() {
    return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">' +
      '<path d="M7 17 17 7M9 7h8v8"/></svg>';
  }

  // Uma linha do catálogo (V3 — grid, não mais card): imagem, título/MLB/SKU,
  // badges, status, preço, estoque, vendidos, score em medidor semicircular
  // e ação externa para o Mercado Livre. A linha inteira abre o drawer
  // existente (abrirDetalhe) — mesmo endpoint/handler de sempre.
  function rowAnuncioHtml(a, idx) {
    var st = statusInfo(a.status);
    var badges = badgesAnuncioHtml(a);
    // Modelo LEGADO de variações do ML (item_id -> variations[]), distinto do
    // agrupador família/User Product (rowGrupoHtml). Um anúncio nesta forma
    // ("item", sem family_id) pode mesmo assim ter variações reais de cor e
    // tamanho no Mercado Livre — o caso que motivou isto é real
    // (MLB2652739620, 24 variações, nunca migrado ao modelo novo). Aqui NÃO
    // existe User Product: a hierarquia do ML é só item_id -> variations[],
    // então a expansão (ver alternarVariacoesLegado) pinta as variações
    // DIRETO abaixo da própria linha do item — nenhum nível de família/UP
    // fake entre elas. Um item sem variações (variations_count 0 ou ausente)
    // não ganha chevron nem painel nenhum: nada para expandir.
    var temVariacoesLegado = (a.variations_count || 0) > 0;
    var painelLegadoId = "am-legado-painel-" + idx;
    // "N variações" NÃO é status do anúncio (não é Full, não é Sem SKU) —
    // é informação estrutural do próprio anúncio pai, do mesmo jeito que
    // item_id/SKU são: por isso mora junto deles em .am-row__ids, texto
    // plano sem aparência de badge, e sem o "no ML" redundante (a tela
    // inteira já é do Mercado Livre).
    var variacoesInfoHtml = temVariacoesLegado
      ? '<span class="am-row__variacoes-info" title="Este anúncio tem variações no modelo antigo do Mercado Livre (sem User Product) — a edição de preço desta tela trata isso à parte.">' +
        plural(a.variations_count, "variação", "variações") + "</span>"
      : "";

    var img = a.thumbnail
      ? '<img src="' + escapeHtml(a.thumbnail) + '" alt="" loading="lazy" />'
      : iconeImagemSvg();

    var skuHtml = a.sku
      ? '<span>SKU <span class="vf-mono">' + escapeHtml(a.sku) + "</span></span>"
      : '<span>SKU <span class="vf-mono am-row__sem-sku">—</span></span>';

    // Tipo do anúncio (Premium/Clássico) só existe no card PRINCIPAL: no
    // modelo legado (item_id -> variations[]) não há MLBU por variação —
    // todas as variações são o MESMO anúncio, logo o MESMO tipo (ver
    // condicaoComercial). Mesmo rótulo/classe (.am-mlb__cond) já usado para
    // a condição comercial no modelo de família — nenhum estilo novo.
    var cond = condicaoComercial(a);
    var condHtml = cond
      ? '<span class="am-mlb__cond">' + escapeHtml(cond) + "</span>"
      : "";

    var linkMl = a.permalink
      ? '<a class="am-row__link" href="' + escapeHtml(a.permalink) + '" target="_blank" rel="noopener" ' +
        'aria-label="Abrir ' + escapeHtml(a.titulo || a.item_id) + ' no Mercado Livre" title="Abrir no Mercado Livre">' +
        iconeExternoSvg() + "</a>"
      : "";

    // O toggle de variações é um BOTÃO próprio dentro da linha, não a linha
    // inteira (que continua abrindo o modal, como sempre) — mesma exceção de
    // .am-row__link/.am-estoque em bindLinhasAnuncio (ehControleProprio).
    var toggleLegado = temVariacoesLegado
      ? '<button type="button" class="am-row__variacoes-toggle" aria-expanded="false" ' +
        'aria-controls="' + painelLegadoId + '" aria-label="Ver as ' +
        escapeAttr(plural(a.variations_count, "variação", "variações")) + ' deste anúncio no Mercado Livre">' +
        '<span class="am-row__chevron" aria-hidden="true">' + iconeChevronSvg() + "</span>" +
      "</button>"
      : "";

    // Item legado COM variações: estoque não é editável no card principal. O
    // ML trata available_quantity da raiz do item como agregado quando existe
    // variations[] (documentacao_api_meli/variacoes.md, "Modificar estoque")
    // — a escrita de verdade é só por variação (ver rowVariacaoLegadoHtml /
    // celulaEstoqueVariacaoLegadoHtml). Sem .am-estoque aqui: nem botão, nem
    // listener (bindEstoqueEditavel só encontra `.am-estoque`), só o número.
    // Mesma decisão já tomada pra linha do AGRUPADOR (ver comentário abaixo).
    var estoqueItemHtml = temVariacoesLegado
      ? '<span class="am-row__num" title="O estoque deste anúncio é por variação — abra as variações para editar.">' +
        (a.estoque != null ? escapeHtml(String(a.estoque)) : "—") + "</span>"
      : celulaEstoqueHtml(a, "am-row__num");

    return '<div class="am-row" data-item="' + escapeHtml(a.item_id) + '" tabindex="0" role="button" ' +
      'aria-label="Ver detalhes de ' + escapeHtml(a.titulo || a.item_id) + '">' +
      '<div class="am-row__thumb" aria-hidden="true">' + img + "</div>" +
      '<div class="am-row__main">' +
        '<h3 class="am-row__titulo">' + escapeHtml(a.titulo || "(sem título)") + "</h3>" +
        '<div class="am-row__ids"><span class="vf-mono">' + escapeHtml(a.item_id) + "</span>" +
          condHtml + skuHtml + variacoesInfoHtml + "</div>" +
        '<div class="am-row__badges">' + badges +
          '<span data-abc-item="' + escapeAttr(a.item_id) + '">' + curvaAbcBadgeHtml(AM.state.curvaAbcCache[a.item_id]) + "</span>" +
        "</div>" +
      "</div>" +
      '<span class="vf-status ' + st.classe + '">' + st.label + "</span>" +
      celulaPrecoHtml(a, "am-row__preco") +
      // O anúncio individual SEM variações também é um MLB, e o estoque dele
      // se edita aqui pelo mesmo caminho da linha filha. A linha do
      // AGRUPADOR não tem esta célula: o estoque dela é soma de variações,
      // não um número que exista no Mercado Livre para ser escrito (ver
      // rowGrupoHtml). O item legado COM variações é a mesma exceção, pela
      // mesma razão de fundo (ver estoqueItemHtml acima).
      estoqueItemHtml +
      '<span class="am-row__num">' + (a.vendidos != null ? a.vendidos : "—") + "</span>" +
      faturamentoCelulaHtml(a.item_id) +
      metricas7dCelulaHtml(a.item_id) +
      margemCelulaHtml(a) +
      scoreGaugeHtml(a.score_venforce) +
      '<div class="am-row__acao">' + toggleLegado + linkMl + "</div>" +
    "</div>" +
    (temVariacoesLegado
      ? '<div class="am-grupo-painel" id="' + painelLegadoId + '" hidden></div>'
      : "");
  }

  // Uma implementação de paginação para as DUAS listas (anúncios e famílias).
  // `pag` é sempre { page, totalPaginas, total }; `prefixo` dá os ids dos
  // botões e `rotulo` o substantivo contado.
  function paginacaoHtml(pag, prefixo, rotulo) {
    var p = pag || { page: 1, totalPaginas: 1, total: 0 };
    var nome = rotulo || "anúncio";
    var aria = 'aria-label="Paginação de ' + nome + 's"';
    if (p.totalPaginas <= 1) {
      return '<nav class="vf-pagination am-paginacao" ' + aria + '><span class="vf-pagination__info">' +
        p.total + " " + nome + "(s)</span></nav>";
    }
    return '<nav class="vf-pagination am-paginacao" ' + aria + ">" +
      '<span class="vf-pagination__info">Página ' + p.page + " de " + p.totalPaginas + " · " + p.total + " " + nome + "s</span>" +
      '<div class="vf-pagination__actions">' +
      '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" id="' + prefixo + '-prev"' + (p.page <= 1 ? " disabled" : "") + ">← Anterior</button>" +
      '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" id="' + prefixo + '-next"' + (p.page >= p.totalPaginas ? " disabled" : "") + ">Próxima →</button></div>" +
      "</nav>";
  }

  function bindPaginacao(prefixo, pag, irPara) {
    var prev = el(prefixo + "-prev"), next = el(prefixo + "-next");
    if (prev) prev.addEventListener("click", function () {
      if (pag.page > 1) { irPara(pag.page - 1); window.scrollTo({ top: 0, behavior: "smooth" }); }
    });
    if (next) next.addEventListener("click", function () {
      if (pag.page < pag.totalPaginas) { irPara(pag.page + 1); window.scrollTo({ top: 0, behavior: "smooth" }); }
    });
  }

  // ===========================================================================
  // DETALHE DO ANÚNCIO — modal central de superfície única (canva aprovado)
  //
  // Substitui o drawer lateral + 5 abas. A arquitetura agora é: um modal
  // central grande, uma única superfície, rolagem vertical. Nada de tabs, nada
  // de drawer por baixo.
  //
  // O que mudou de verdade (além do visual):
  //  - Título, Modelo e Descrição são EDITÁVEIS e PERSISTEM no anúncio real
  //    (PATCH /:itemId/conteudo → API do Mercado Livre). O achado F-03 da
  //    auditoria ("campos que parecem edição e são rascunho") morre aqui;
  //  - cada conteúdo tem UMA representação principal. O título mora no
  //    cabeçalho; o modelo, no bloco Comercial & catálogo; a descrição, no
  //    campo editável da seção Descrição. As colunas "Atual" das comparações
  //    com a IA apontam para elas em vez de duplicá-las como campo;
  //  - "Aprovar" continua sendo decisão INTERNA (grava em
  //    meli_anuncio_otimizacoes). Quem altera o anúncio é "Salvar alterações".
  // ===========================================================================
  var detalheFocusAnterior = null;

  // Estado do modal aberto. `token` é a guarda de corrida: toda resposta traz
  // o token da abertura que a pediu e é descartada se não for mais a atual —
  // sem isso a resposta lenta da Conta A / do anúncio A pinta a tela do B.
  var DET = null;
  var detalheToken = 0;

  var TIPO_ANUNCIO = {
    gold_special: "Clássico",
    gold_pro: "Premium",
    gold_premium: "Ouro Premium",
    gold: "Ouro",
    silver: "Prata",
    bronze: "Bronze",
    free: "Grátis",
  };

  var CAMPOS_EDITAVEIS = [
    { chave: "titulo", rotulo: "Título" },
    { chave: "modelo", rotulo: "Modelo" },
    { chave: "descricao", rotulo: "Descrição" },
  ];

  // ---------------------------------------------------------------------------
  // Ícones (mesmos traços do canva aprovado)
  // ---------------------------------------------------------------------------
  function svgIcone(paths, tamanho, largura) {
    return '<svg width="' + tamanho + '" height="' + tamanho + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="' + (largura || 2) + '" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
  }
  function icFechar() { return svgIcone('<path d="M18 6 6 18M6 6l12 12"/>', 16); }
  function icImagem(t) { return svgIcone('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>', t || 24, 1.6); }
  function icCheck(t) { return svgIcone('<path d="M20 6 9 17l-5-5"/>', t || 13); }
  function icAlerta(t) { return svgIcone('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/>', t || 13); }
  function icDesfazer(t) { return svgIcone('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>', t || 13); }
  function icLapis(t) { return svgIcone('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>', t || 12, 1.8); }
  function icExterno(t) { return svgIcone('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>', t || 12); }
  function icIa(t) { return svgIcone('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>', t || 12, 1.75); }

  // ---------------------------------------------------------------------------
  // Formatações locais do detalhe
  // ---------------------------------------------------------------------------
  function formatRelativo(iso) {
    if (!iso) return "nunca sincronizado";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "sincronização desconhecida";
    var min = Math.round((Date.now() - d.getTime()) / 60000);
    if (min < 1) return "sincronizado agora";
    if (min < 60) return "sincronizado há " + min + "min";
    var h = Math.round(min / 60);
    if (h < 24) return "sincronizado há " + h + "h";
    return "sincronizado em " + formatData(iso);
  }

  function valorAtributo(a) {
    if (!a) return "";
    if (a.value) return String(a.value);
    if (a.value_name) return String(a.value_name);
    if (Array.isArray(a.values) && a.values[0] && a.values[0].name) return String(a.values[0].name);
    return "";
  }

  function nomeAtributo(a) { return (a && (a.name || a.id)) || "—"; }

  // ---------------------------------------------------------------------------
  // Abrir / fechar
  // ---------------------------------------------------------------------------
  function abrirDetalhe(itemId, trigger) {
    if (DET && DET.aberto) fecharDetalhe(true);

    AM.detalheAtual = null;
    AM.otimizacoes = { seo: null, descricao: null, ficha_tecnica: null };
    detalheFocusAnterior = trigger || document.activeElement;

    var meuToken = ++detalheToken;
    DET = {
      token: meuToken,
      aberto: true,
      itemId: String(itemId),
      contextoChave: (AM.clienteAtual ? AM.clienteAtual.slug : "") + ":" + (AM.contaMlId || ""),
      anuncio: null,
      descricao: null,
      descricaoEstado: null,
      descricaoErro: null,
      descricaoOrigem: null,
      descricaoOrigemHora: null,
      // Nome legível da categoria (ex. "Celulares e Smartphones"), resolvido
      // pelo backend. null até a resposta chegar OU quando a resolução falha
      // — nos dois casos o render cai para o category_id cru (fallback seguro).
      categoriaNome: null,
      original: { titulo: "", modelo: "", descricao: "" },
      rascunho: { titulo: "", modelo: "", descricao: "" },
      erros: {},
      salvando: false,
      confirmandoSaida: false,
      iaBloqueada: false,
      // Title Engine (SEO): sugestões de título geradas sob demanda. Vivem só
      // no modal (não são persistidas); "Usar" muda o rascunho, nunca o ML.
      titulosSeo: novoEstadoTitulos(),
      // Description Engine (SEO): UMA descrição por clique, validada no
      // backend. Mesma regra: só o rascunho muda, nunca o ML.
      descricaoSeo: novoEstadoDescricao(),
      carregado: false,
      // Preço: escrita REAL no Mercado Livre (PATCH .../preco). `salvando`
      // trava contra clique duplo/Enter duplo e contra o campo virar
      // editável de novo durante a chamada.
      precoMargem: { salvando: false },
      // Custo do produto / Custos adicionais / Preço (só para item legado com
      // variations[] reais no ML — ver margemComposicaoLadderHtml): overrides
      // de SIMULAÇÃO — nunca persistidos, nunca enviados ao Mercado Livre.
      // `resultado` é a última resposta de POST .../simular-margem; null
      // enquanto nenhum dos três campos estiver com override ativo (a
      // composição usa a margem REAL).
      simulacaoMargem: { custoProduto: null, custosAdicionais: null, preco: null, resultado: null },
      // Qual linha da tabela "Promoções disponíveis" está com o preço final
      // alimentando a simulação acima agora (id da promoção, ou null). Só
      // controla QUAL linha mostra "Você recebe" — nunca decide o valor em
      // si, que continua vindo inteiro de simulacaoMargem.resultado.
      promoLinhaSelecionada: null,
      // Adicionar imagem (seção Fotos): arquivo escolhido, preview local e
      // estado do envio — ver bloco "Fotos: adicionar imagem".
      imagem: imagemEstadoVazio(),
      // Anúncio com variações: grupos de foto lidos do ML sob demanda
      // (GET .../imagens/variacoes). null = ainda não pedido.
      imagemVar: null,
      // Editor de fotos por grupo — ver bloco "Fotos: editor por grupo".
      fotos: fotosEstadoVazio(),
    };
    chipUsadaAtual = null;

    var overlay = document.createElement("div");
    overlay.className = "am-det-overlay";
    overlay.id = "am-det-overlay";

    var modal = document.createElement("section");
    modal.className = "am-det-modal";
    modal.id = "am-det-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Detalhe do anúncio");
    modal.innerHTML =
      '<div class="am-det-modal__top">' +
        '<span class="am-det-eyebrow">Anúncios ML · Detalhe do anúncio</span>' +
        '<button type="button" class="am-det-close" data-acao="fechar" aria-label="Fechar">' + icFechar() + "</button>" +
      "</div>" +
      '<div id="am-det-savebar-slot"></div>' +
      '<div class="am-det-scroll" id="am-det-scroll">' + estadoHtml("loading", "Carregando detalhes…") + "</div>";

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.body.classList.add("vf-no-scroll");

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) fecharDetalhe();
    });
    modal.addEventListener("click", onCliqueDetalhe);
    var btnFechar = modal.querySelector('[data-acao="fechar"]');
    if (btnFechar) btnFechar.focus();

    var url = "/anuncios-meli/" + encodeURIComponent(itemId) +
              "?clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug) +
              (AM.contaMlId ? "&clienteContaId=" + encodeURIComponent(AM.contaMlId) : "");

    api(url).then(function (r) {
      if (!DET || DET.token !== meuToken) return; // outra abertura já assumiu a tela
      var alvo = el("am-det-scroll");
      if (!alvo) return;
      if (!r.data || !r.data.ok) {
        alvo.innerHTML = estadoHtml("error", "Erro ao carregar detalhes",
          (r.data && r.data.motivo) || "Não foi possível carregar.");
        return;
      }
      var a = r.data.anuncio;
      DET.anuncio = a;
      DET.descricao = r.data.descricao || null;
      // `descricaoEstado` é o contrato novo; sem ele (backend antigo) o
      // comportamento cai no que havia antes, só que sem afirmar nada.
      DET.descricaoEstado = r.data.descricaoEstado ||
        (r.data.descricao ? "ok" : "sem_descricao");
      DET.descricaoErro = r.data.descricaoErro || null;
      DET.categoriaNome = r.data.categoriaNome || null;
      DET.original = {
        titulo: a.titulo || "",
        modelo: a.modelo || "",
        descricao: r.data.descricao || "",
      };
      DET.rascunho = {
        titulo: DET.original.titulo,
        modelo: DET.original.modelo,
        descricao: DET.original.descricao,
      };
      DET.carregado = true;
      AM.detalheAtual = { anuncio: a, descricao: DET.descricao };
      renderDetalhe();
      carregarHistoricoOtimizacoes(a.item_id, meuToken);
      // Promoções: lazy, em segundo plano — NUNCA atrasa a abertura do modal
      // (que já pintou acima). A seção nasce com "Carregando…" e se repinta
      // sozinha quando a resposta chega (ver promocoesSecaoHtml/repintarPromocoesDoItem).
      // Guardada em DET.promocoesPronto: é o que permite à composição da
      // margem (ver carregarComposicaoDoDetalhe) saber se existe uma promoção
      // ATIVA com subsidioMl ANTES de pedir a margem — sem esperar por ela, a
      // composição poderia nascer sem o rebate.
      DET.promocoesPronto = garantirPromocoesDoItem(a.item_id).then(function () {
        if (!DET || DET.token !== meuToken) return; // modal fechado, ou outro MLB no meio do caminho
        repintarPromocoesDoItem(a.item_id);
      });
      carregarComposicaoDoDetalhe(a.item_id, meuToken);
    });
  }

  function fecharDetalhe(forcar) {
    if (!DET || !DET.aberto) return;
    // Salvar de fotos em curso: o modal só fecha quando o ML responder.
    if (DET.fotos && DET.fotos.salvando) {
      toast("Aguarde: as fotos estão sendo salvas no Mercado Livre.", "");
      return;
    }
    if (!forcar && camposSujos().length) { pedirConfirmacaoSaida(); return; }
    if (!forcar && fotosSujas() && !fotosTravadas()) {
      DET.fotos.pendente = { tipo: "fechar" };
      renderFotos();
      var pendFotos = document.querySelector("#am-det-fotos-corpo .am-det-fotos__pendente");
      if (pendFotos && pendFotos.scrollIntoView) pendFotos.scrollIntoView({ block: "center" });
      return;
    }

    detalheToken++; // invalida qualquer resposta em voo da abertura que morreu
    liberarPreviewImagem();
    liberarPreviewsFotos();
    var overlay = el("am-det-overlay");
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    document.body.classList.remove("vf-no-scroll");
    DET = null;
    AM.detalheAtual = null;
    AM.otimizacoes = { seo: null, descricao: null, ficha_tecnica: null };
    if (detalheFocusAnterior && typeof detalheFocusAnterior.focus === "function") {
      detalheFocusAnterior.focus();
    }
    detalheFocusAnterior = null;
  }

  function pedirConfirmacaoSaida() {
    if (!DET) return;
    DET.confirmandoSaida = true;
    renderSavebar();
  }

  // ---------------------------------------------------------------------------
  // Alterações pendentes
  // ---------------------------------------------------------------------------
  function camposSujos() {
    if (!DET || !DET.carregado) return [];
    return CAMPOS_EDITAVEIS.filter(function (c) {
      return DET.rascunho[c.chave] !== DET.original[c.chave];
    });
  }

  function campoSujo(chave) {
    return !!(DET && DET.carregado && DET.rascunho[chave] !== DET.original[chave]);
  }

  // ---------------------------------------------------------------------------
  // Render — superfície única
  // ---------------------------------------------------------------------------
  function renderDetalhe() {
    if (!DET || !DET.anuncio) return;
    var a = DET.anuncio;
    var pics = tryParseJSON(a.pictures_json, []) || [];
    var attrs = tryParseJSON(a.attributes_json, []) || [];

    var html =
      headHtml(a) +
      top2Html(a, pics, attrs) +
      fotosHtml(pics, a) +
      '<div class="am-det-margem-grid">' +
        margemComposicaoSecaoHtml(a) +
        promocoesSecaoHtml(a.item_id, a.moeda) +
      "</div>" +
      tituloEModeloHtml(a) +
      descricaoHtml() +
      fichaHtml(attrs);

    var scroll = el("am-det-scroll");
    scroll.innerHTML = html;
    bindCamposEditaveis();
    bindFotos();
    aplicarEstadosEdicao(); // já redesenha a barra de alterações
    bindMargemEditavel(el("am-det-margem-body"));
    bindAplicarPreco(el("am-det-margem-body"), a.item_id);
    bindRestaurarSimulacaoMargem(el("am-det-margem-body"), a.item_id);
    bindMargemEditavel(el("am-det-promo-body"));
    bindPromocoesAcoes(el("am-det-promo-body"), a.item_id);
  }

  // ----- Cabeçalho: identidade + título editável (representação única) -------
  function headHtml(a) {
    var st = statusInfo(a.status);
    var rev = a.revisado
      ? '<span class="vf-status is-success">Revisado</span>'
      : '<span class="vf-status is-empty">Não revisado</span>';
    var conta = a.cliente_conta_id
      ? "Conta ML #" + escapeHtml(String(a.cliente_conta_id))
      : (a.ml_user_id ? "Conta ML " + escapeHtml(String(a.ml_user_id)) : "Conta ML não identificada");
    var subStatus = a.sub_status
      ? ' <span class="am-det-head__dot">·</span> ' + escapeHtml(String(a.sub_status))
      : "";
    // Bloqueio de edição é mais amplo que a tag visual — ver comentário em
    // ehCatalogoOficial/tituloTravadoPorCatalogo. A tag só acende com
    // catalog_listing===true; o título pode ficar travado sem ela (família).
    var catalogoTag = ehCatalogoOficial(a);
    var tituloTravado = tituloTravadoPorCatalogo(a);

    var thumb = a.thumbnail
      ? '<img src="' + escapeHtml(a.thumbnail) + '" alt="" loading="lazy" />'
      : icImagem(24);

    return '<div class="am-det-head">' +
      '<div class="am-det-head__thumb" aria-hidden="true">' + thumb + "</div>" +
      '<div class="am-det-head__main">' +
        '<div class="am-det-title" id="am-det-title-wrap">' +
          '<div class="am-det-title__row">' +
            '<input class="am-det-title__input" id="am-det-titulo" maxlength="60" size="56" ' +
              (tituloTravado ? 'readonly aria-readonly="true" ' : '') +
              'aria-label="Título do anúncio" value="' + escapeAttr(DET.rascunho.titulo) + '" />' +
            '<button type="button" class="am-det-revert" data-acao="reverter" data-campo="titulo" ' +
              'id="am-det-revert-titulo" title="Descartar alteração no título" ' +
              'aria-label="Descartar alteração no título">' + icDesfazer() + "</button>" +
          "</div>" +
          '<div class="am-det-title__meta">' +
            '<span class="am-det-dirty" id="am-det-dirty-titulo"><span class="am-det-dot"></span>Alteração não salva</span>' +
            '<span class="am-det-title__count" id="am-det-count-titulo"></span>' +
            (tituloTravado
              ? '<span class="am-det-title__locknote">Gerenciado pelo Mercado Livre</span>'
              : (Number(a.vendidos) > 0
                // Aviso, NÃO bloqueio: o ML é a autoridade final e decide no
                // PUT. Só antecipa a regra dele (título muda até a 1ª venda).
                ? '<span class="am-det-title__locknote" id="am-det-title-vendas" title="A API do Mercado Livre pode recusar a alteração de título em alguns anúncios com vendas. A alteração é enviada mesmo assim — se o ML recusar, o motivo aparece aqui.">' +
                    "Anúncio com vendas — o Mercado Livre pode recusar a troca de título</span>"
                : "")) +
          "</div>" +
        "</div>" +
        '<div class="am-det-head__meta">' +
          '<span class="vf-mono">' + escapeHtml(a.item_id) + "</span>" +
          '<span class="am-det-head__dot">·</span>' +
          '<span class="vf-mono">SKU ' + escapeHtml(a.sku || "—") + "</span>" +
          '<span class="am-det-head__dot">·</span>' +
          '<span class="vf-status ' + st.classe + '">' + escapeHtml(st.label) + "</span>" + subStatus +
          (catalogoTag
            ? '<span class="am-det-head__dot">·</span><span class="vf-tag is-primary" title="Publicação de catálogo do Mercado Livre">Catálogo</span>'
            : "") +
          '<span class="am-det-head__dot">·</span>' +
          '<span id="am-det-revisado-chip">' + rev + "</span>" +
          '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" id="am-det-revisar" data-acao="revisar">' +
            icCheck(12) + (a.revisado ? "Desmarcar revisão" : "Marcar como revisado") +
          "</button>" +
        "</div>" +
        '<div class="am-det-head__sub">' + escapeHtml(AM.clienteAtual ? AM.clienteAtual.nome : "") +
          " — " + conta + ' <span class="am-det-head__dot">·</span> ' +
          escapeHtml(formatRelativo(a.last_synced_at)) + "</div>" +
      "</div>" +
      '<div class="am-det-head__actions">' +
        (a.permalink
          ? '<a class="vf-btn vf-btn--secondary vf-btn--sm" href="' + escapeHtml(a.permalink) +
            '" target="_blank" rel="noopener" id="am-det-abrir-ml">Abrir no Mercado Livre' + icExterno() + "</a>"
          : "") +
      "</div>" +
    "</div>";
  }

  // Preço do cabeçalho do modal — MESMA fonte da lista (celulaPrecoHtml) e da
  // composição (`precoPromocionalAtivo`): margem[itemId].precoAtual/
  // precoOriginal (item.pricing.current/list, sale_price via
  // resolverPrecosItem) sobre o snapshot sincronizado (a.preco/
  // a.preco_original) enquanto a margem deste item não chegou — a composição
  // é pedida ao abrir o modal (ver carregarComposicaoDoDetalhe).
  // `id="am-det-price"` é o que permite repintarComposicaoDoItem atualizar
  // este valor junto do resto quando a margem chega depois do modal já aberto.
  function precoDetalheHtml(a) {
    var cache = AM.state.performanceCache[a.item_id];
    var m = cache && cache.margem;
    var atual = m && m.precoAtual != null ? m.precoAtual : a.preco;
    var cheioBruto = cache && cache.temMargem
      ? (m && m.precoOriginal != null ? m.precoOriginal : null)
      : (a.preco_original || null);
    var cheio = precoCheioReal(atual, cheioBruto);
    return '<strong class="am-det-price" id="am-det-price">' + formatMoeda(atual, a.moeda) +
      (cheio ? "<small>" + formatMoeda(cheio, a.moeda) + "</small>" : "") + "</strong>";
  }

  // ----- Topo em 2 colunas: comercial/catálogo | qualidade ------------------
  function top2Html(a, pics, attrs) {
    var preco = precoDetalheHtml(a);

    var tipo = TIPO_ANUNCIO[a.listing_type_id] || a.listing_type_id || "—";
    var logistica = a.is_full ? "Full" : (a.logistic_type || "—");

    var comercial = '<h4>Comercial &amp; catálogo</h4>' +
      kvDet("Preço", preco) +
      kvDet("Estoque", "<strong>" + (a.estoque != null ? a.estoque : "—") + "</strong>") +
      kvDet("Vendidos", "<strong>" + (a.vendidos != null ? a.vendidos : "—") + "</strong>") +
      kvDet("Marca", "<strong>" + escapeHtml(a.marca || "—") + "</strong>") +
      kvDet("Modelo",
        '<strong><span class="am-det-inline" id="am-det-modelo-wrap">' +
          '<input class="am-det-inline__input" id="am-det-modelo" size="10" aria-label="Modelo do anúncio" ' +
            'placeholder="—" value="' + escapeAttr(DET.rascunho.modelo) + '" />' +
          '<button type="button" class="am-det-inline__pencil" data-acao="focar" data-campo="modelo" ' +
            'title="Editar modelo" aria-label="Editar modelo">' + icLapis() + "</button>" +
          '<button type="button" class="am-det-revert" data-acao="reverter" data-campo="modelo" ' +
            'id="am-det-revert-modelo" title="Descartar alteração no modelo" ' +
            'aria-label="Descartar alteração no modelo">' + icDesfazer(12) + "</button>" +
        "</span></strong>") +
      kvDet("Categoria", "<strong>" + escapeHtml(DET.categoriaNome || a.category_id || "—") + "</strong>") +
      kvDet("Tipo / logística", "<strong>" + escapeHtml(tipo) + " · " + escapeHtml(logistica) + "</strong>");

    var score = a.score_venforce == null ? 0 : Number(a.score_venforce) || 0;
    var classe = scoreClasse(score);
    var circ = 219.9;
    var offset = (circ * (1 - Math.max(0, Math.min(100, score)) / 100)).toFixed(1);

    var criterios = criteriosQualidade(a, pics, attrs).map(function (c) {
      return '<li class="' + c.estado + '">' +
        (c.estado === "ok" ? icCheck(13) : icAlerta(13)) + escapeHtml(c.texto) + "</li>";
    }).join("");

    var rodapeQualidade = escapeHtml("Principal ponto: " + (a.score_motivo || "—")) +
      (a.health != null ? " · health ML: " + escapeHtml(String(a.health)) : "");

    var qualidade = "<h4>Qualidade do anúncio</h4>" +
      '<div class="am-det-q__topo">' +
        '<div class="am-det-q__ring">' +
          '<svg width="84" height="84" viewBox="0 0 84 84" aria-hidden="true">' +
            '<circle cx="42" cy="42" r="35" fill="none" stroke="var(--vf-bg-2)" stroke-width="9"/>' +
            '<circle cx="42" cy="42" r="35" fill="none" class="am-det-q__arc ' + classe + '" stroke-width="9" ' +
              'stroke-linecap="round" stroke-dasharray="' + circ + '" stroke-dashoffset="' + offset + '" ' +
              'transform="rotate(-90 42 42)"/>' +
          "</svg>" +
          '<div class="am-det-q__ringval ' + classe + '">' + (a.score_venforce == null ? "—" : score) + "</div>" +
        "</div>" +
        "<div>" +
          '<p class="am-det-q__titulo">Score VenForce</p>' +
          '<p class="am-det-q__sub">de 100 pontos possíveis</p>' +
        "</div>" +
      "</div>" +
      '<ul class="am-det-q__crit">' + criterios + "</ul>" +
      '<p class="am-det-q__foot"><span class="am-det-newdata">' + rodapeQualidade + "</span></p>";

    return '<div class="am-det-top2">' +
      '<div class="am-det-top2__col">' + comercial + "</div>" +
      '<div class="am-det-top2__col">' + qualidade + "</div>" +
    "</div>";
  }

  function kvDet(rotulo, valorHtml) {
    return '<div class="am-det-kv"><span>' + escapeHtml(rotulo) + "</span>" + valorHtml + "</div>";
  }

  // Decomposição dos 5 critérios do Score VenForce — os mesmos pesos que o
  // backend usa (meliSyncService.calcularScore: título 32 · fotos 26 ·
  // marca 14 · modelo 14 · ficha 14). Até aqui a tela mostrava a nota e um
  // sintoma (`score_motivo`); agora mostra a decomposição inteira.
  function criteriosQualidade(a, pics, attrs) {
    var itens = [];
    var titulo = String(DET.rascunho.titulo || "").trim();
    if (!titulo) itens.push({ estado: "bad", texto: "Sem título" });
    else if (titulo.length < 20) itens.push({ estado: "bad", texto: "Título muito curto (" + titulo.length + " caracteres; o ideal é de 20 a 60)" });
    else if (titulo.length > 60) itens.push({ estado: "warn", texto: "Título acima de 60 caracteres (" + titulo.length + ")" });
    else itens.push({ estado: "ok", texto: "Título com " + titulo.length + " de 60 caracteres" });

    var n = pics.length;
    if (!n) itens.push({ estado: "bad", texto: "Sem fotos" });
    else if (n < 3) itens.push({ estado: "bad", texto: "Só " + n + (n === 1 ? " foto" : " fotos") + " (mínimo recomendado: 3)" });
    else if (n < 6) itens.push({ estado: "warn", texto: n + " fotos (6 ou mais é o ideal)" });
    else itens.push({ estado: "ok", texto: n + " fotos" });

    var total = attrs.length;
    var cheios = attrs.filter(function (x) { return valorAtributo(x); }).length;
    if (!total) itens.push({ estado: "warn", texto: "Ficha técnica não retornada pelo Mercado Livre" });
    else if (cheios / total < 0.6) itens.push({ estado: "warn", texto: "Ficha técnica incompleta (" + cheios + " de " + total + " atributos)" });
    else itens.push({ estado: "ok", texto: "Ficha técnica com " + cheios + " de " + total + " atributos" });

    itens.push(a.marca
      ? { estado: "ok", texto: "Marca preenchida" }
      : { estado: "bad", texto: "Marca não preenchida" });
    itens.push(String(DET.rascunho.modelo || "").trim()
      ? { estado: "ok", texto: "Modelo preenchido" }
      : { estado: "bad", texto: "Modelo não preenchido" });

    return itens;
  }

  // ----- Fotos: editor por grupo de variação ---------------------------------
  // GET /anuncios-meli/:itemId/fotos/variacoes (meliFotosService, ao vivo no
  // ML). Com variações: um chip por grupo (valor do atributo que define a foto,
  // ex.: Cor Robalo) e só as fotos do grupo selecionado; a primeira é a imagem
  // principal da variação. Sem variação: o mesmo componente com um grupo só (a
  // galeria), e a primeira foto é a capa do anúncio.
  //
  // Dois estados, separados de propósito:
  //   F.original — a resposta do GET, CONGELADA (Object.freeze em
  //                profundidade): nada na tela consegue alterá-la;
  //   F.rascunho — { sel, itens }: o grupo aberto e a lista em edição, cada
  //                item "existente" (pode estar marcado como removida) ou
  //                "nova" (arquivo + preview, só no navegador).
  // As pendências são sempre CALCULADAS da diferença entre os dois.
  //
  // Tudo fica em memória até "Salvar no Mercado Livre", que manda o rascunho
  // num único PUT /anuncios-meli/:itemId/fotos (multipart: plano + novas[]).
  // Depois do sucesso a tela RELÊ o GET — o estado final é o que o ML
  // devolve, nunca o payload enviado.
  var MOTIVO_FOTOS_CATALOGO =
    "Este anúncio é de catálogo: as fotos exibidas são do produto de catálogo do Mercado Livre e não podem ser alteradas por aqui.";
  var FOTOS_MAX_NOVAS = 10;                  // mesmo limite do multer no PUT /fotos
  var MOTIVO_FOTOS_INCERTO =
    "Não foi possível confirmar se o Mercado Livre aplicou a alteração. Confira o anúncio antes de tentar novamente.";

  function congelar(o) {
    if (o && typeof o === "object" && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach(function (k) { congelar(o[k]); });
    }
    return o;
  }

  function fotosEstadoVazio() {
    // salvando: null | "enviando" | "processando"; falhaSalvar: { tipo, titulo,
    // linhas } com tipo validacao | ml | conflito | incerto; sucesso: texto.
    return { estado: null, erro: null, original: null, rascunho: null, pendente: null, avisoLocal: null, arrastando: null,
             salvando: null, falhaSalvar: null, sucesso: null };
  }

  function fotosVariacoes() {
    var F = DET && DET.fotos;
    return !!(F && F.original && F.original.modo === "variacoes");
  }

  function grupoOriginal() {
    var F = DET.fotos;
    return F.original && F.rascunho ? F.original.grupos[F.rascunho.sel] || null : null;
  }

  function liberarPreviewsFotos() {
    var F = DET && DET.fotos;
    if (!F || !F.rascunho) return;
    F.rascunho.itens.forEach(function (it) {
      if (it.tipo === "nova" && it.previewUrl) {
        try { URL.revokeObjectURL(it.previewUrl); } catch (_) { /* nada a liberar */ }
        it.previewUrl = null;
      }
    });
  }

  // Rascunho novo = cópia do grupo original; libera os previews do anterior.
  function novoRascunho(sel) {
    liberarPreviewsFotos();
    var g = DET.fotos.original.grupos[sel];
    DET.fotos.rascunho = {
      sel: sel,
      seq: 0,
      itens: g.fotos.map(function (f) { return { tipo: "existente", id: f.id, url: f.url, removida: false }; }),
    };
    DET.fotos.pendente = null;
    DET.fotos.avisoLocal = null;
    DET.fotos.falhaSalvar = null;
    DET.fotos.sucesso = null;
  }

  // Estado incerto: o ML pode ou não ter aplicado o salvar. Nada é editável
  // nem reenviável até reler as fotos (foto-recarregar).
  function fotosTravadas() {
    var F = DET && DET.fotos;
    return !!(F && F.falhaSalvar && F.falhaSalvar.tipo === "incerto");
  }

  function limparMensagensFotos() {
    var F = DET.fotos;
    F.avisoLocal = null;
    F.sucesso = null;
    if (F.falhaSalvar && F.falhaSalvar.tipo !== "incerto") F.falhaSalvar = null;
  }

  function fotosAtivas() {
    return DET.fotos.rascunho.itens.filter(function (it) { return !it.removida; });
  }

  function pendenciasFotos() {
    var F = DET && DET.fotos;
    if (!F || F.estado !== "ok" || !F.rascunho) return { removidas: 0, novas: 0, reordenou: false, total: 0 };
    var itens = F.rascunho.itens;
    var removidas = itens.filter(function (it) { return it.tipo === "existente" && it.removida; }).length;
    var novas = itens.filter(function (it) { return it.tipo === "nova"; }).length;
    var ficam = itens.filter(function (it) { return it.tipo === "existente" && !it.removida; }).map(function (it) { return it.id; });
    var baseFicam = grupoOriginal().fotos.map(function (f) { return f.id; })
      .filter(function (id) { return ficam.indexOf(id) >= 0; });
    var reordenou = JSON.stringify(ficam) !== JSON.stringify(baseFicam);
    return { removidas: removidas, novas: novas, reordenou: reordenou, total: removidas + novas + (reordenou ? 1 : 0) };
  }

  function fotosSujas() {
    return pendenciasFotos().total > 0;
  }

  function limiteFotos() {
    var F = DET.fotos;
    return F.original && F.original.limite && F.original.limite.porGrupo ? F.original.limite.porGrupo : null;
  }

  function nomeGrupoFotos() {
    return fotosVariacoes() ? "A variação " + grupoOriginal().rotulo : "O anúncio";
  }

  function mesmoGrupoVariacao(a, b) {
    if (!a || !b) return !a && !b;
    if (a.attribute_id !== b.attribute_id) return false;
    if (a.value_id !== null && a.value_id !== undefined && b.value_id !== null && b.value_id !== undefined) {
      return String(a.value_id) === String(b.value_id);
    }
    return String(a.value_name || "").trim().toLowerCase() === String(b.value_name || "").trim().toLowerCase();
  }

  // opcoes.selecionar (grupoVariacao) reabre no mesmo grupo depois de reler;
  // opcoes.sucesso é a mensagem a mostrar sobre a leitura nova.
  function carregarFotos(forcar, opcoes) {
    if (!DET || !DET.anuncio || !DET.fotos) return;
    var F = DET.fotos;
    if (F.estado && !forcar) return;
    opcoes = opcoes || {};
    if (DET.anuncio.catalog_listing === true) {
      F.estado = "catalogo";
      renderFotos();
      return;
    }
    var meuToken = DET.token;
    liberarPreviewsFotos();
    F.estado = "carregando";
    F.erro = null;
    F.original = null;
    F.rascunho = null;
    F.pendente = null;
    F.salvando = null;
    F.falhaSalvar = null;
    F.sucesso = null;
    F.avisoLocal = null;
    var qs = "clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug) +
      (AM.contaMlId ? "&clienteContaId=" + encodeURIComponent(AM.contaMlId) : "");
    api("/anuncios-meli/" + encodeURIComponent(DET.anuncio.item_id) + "/fotos/variacoes?" + qs).then(function (r) {
      if (!DET || DET.token !== meuToken || DET.fotos !== F) return;
      var d = r.data || {};
      if (d.ok && Array.isArray(d.grupos) && d.grupos.length) {
        F.estado = "ok";
        F.original = congelar(d);
        var idx = 0;
        if (opcoes.selecionar !== undefined) {
          d.grupos.forEach(function (g, i) { if (mesmoGrupoVariacao(g.grupoVariacao, opcoes.selecionar)) idx = i; });
        }
        novoRascunho(idx);
        if (opcoes.sucesso) F.sucesso = opcoes.sucesso;
      } else {
        F.estado = "erro";
        F.erro = { status: r.status, dados: d };
      }
      renderFotos();
    });
  }

  function fotosHtml(pics) {
    var alerta = pics.length < 3
      ? '<span class="am-det-alert">' + icAlerta(12) + "Recomendado ter pelo menos 3 fotos</span>"
      : "";
    return '<div class="am-det-section">' +
      '<div class="am-det-section__head">' +
        '<h3 class="am-det-section__title">Fotos <span class="am-det-section__meta">(' + pics.length + ")</span></h3>" +
        alerta +
      "</div>" +
      '<div id="am-det-fotos-corpo" class="am-det-fotos">' + fotosCorpoHtml() + "</div>" +
    "</div>";
  }

  function fotoTileHtml(it, i, principal, podeRemover, n, editavel) {
    var chave = it.tipo === "nova" ? it.chave : it.id;
    var src = it.tipo === "nova" ? it.previewUrl : it.url;
    var selo = principal
      ? '<span class="am-det-fotos__selo">' + (fotosVariacoes() ? "Imagem principal da variação" : "Capa do anúncio") + "</span>"
      : "";
    var aviso = it.tipo === "nova" && it.width && it.height && Math.min(it.width, it.height) < IMAGEM_MIN_LADO_ML
      ? '<span class="am-det-fotos__pequena">' + icAlerta(10) + " abaixo de " + IMAGEM_MIN_LADO_ML + " px</span>"
      : "";
    var acoes = !editavel ? "" : it.removida
      ? '<span class="am-det-fotos__acoes">' +
          '<button type="button" class="am-det-fotos__btn am-det-fotos__btn--texto" data-acao="foto-desfazer" data-idx="' + i + '">Desfazer</button>' +
        "</span>"
      : podeRemover
        ? '<span class="am-det-fotos__acoes">' +
            '<button type="button" class="am-det-fotos__btn am-det-fotos__btn--remover" data-acao="foto-remover" data-idx="' + i + '"' +
              ' aria-label="Remover a foto ' + n + '">×</button>' +
          "</span>"
        : "";
    return '<div class="am-det-photo am-det-fotos__item' + (it.removida ? " is-removida" : "") + (it.tipo === "nova" ? " is-nova" : "") + '"' +
        ' data-foto="' + escapeAttr(chave) + '" data-idx="' + i + '"' + (it.removida || !editavel ? "" : ' draggable="true"') + ">" +
      (src
        ? '<img src="' + escapeAttr(src) + '" alt="' + (it.removida ? "Foto marcada para remoção" : "Foto " + n) +
          '" loading="lazy" draggable="false" />'
        : icImagem(20)) +
      selo +
      (it.removida ? '<span class="am-det-fotos__marca am-det-fotos__marca--removida">Será removida</span>' : "") +
      (it.tipo === "nova" ? '<span class="am-det-fotos__marca am-det-fotos__nova">Nova</span>' : "") +
      aviso + acoes +
    "</div>";
  }

  function fotosErroHtml(erro) {
    var d = (erro && erro.dados) || {};
    // Erro do ML (com detalhesMl): mensagem, código e causa originais, pelo
    // mesmo formatador do envio. Recusa do VenForce: só o motivo.
    var e = d.detalhesMl
      ? erroImagemDe(erro.status, d)
      : { titulo: "", linhas: [d.motivo || (erro && erro.status === 0 ? "Falha de conexão ao carregar as fotos." : "Não foi possível carregar as fotos do anúncio.")] };
    return '<div class="am-det-fotos__estado is-danger" role="alert">' +
      (e.titulo ? "<p><strong>" + escapeHtml(e.titulo) + "</strong></p>" : "") +
      e.linhas.map(function (l) { return "<p>" + escapeHtml(l) + "</p>"; }).join("") +
      '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-acao="foto-recarregar">Tentar de novo</button>' +
    "</div>";
  }

  function fotosRodapeHtml() {
    var F = DET.fotos;
    var partes = [];
    if (F.avisoLocal) partes.push('<p class="am-det-fotos__aviso-local" role="alert">' + escapeHtml(F.avisoLocal) + "</p>");

    if (F.salvando) {
      partes.push('<div class="am-det-fotos__estado" role="status">' +
        (F.salvando === "enviando" ? "Enviando imagens…" : "Salvando no Mercado Livre…") + "</div>");
      return partes.join("");
    }
    if (F.falhaSalvar) {
      var f = F.falhaSalvar;
      var reler = f.tipo === "incerto" || f.tipo === "conflito";
      partes.push('<div class="am-det-fotos__estado is-danger" role="alert">' +
        "<p><strong>" + escapeHtml(f.titulo) + "</strong></p>" +
        f.linhas.map(function (l) { return "<p>" + escapeHtml(l) + "</p>"; }).join("") +
        (reler ? '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-acao="foto-recarregar">Recarregar fotos do Mercado Livre</button>' : "") +
      "</div>");
      if (f.tipo === "incerto") return partes.join(""); // nada de salvar/reenviar
    }
    if (F.sucesso) {
      partes.push('<div class="am-det-fotos__estado is-success" role="status">' + icCheck(13) + " Concluído — " + escapeHtml(F.sucesso) + "</div>");
    }

    if (F.pendente) {
      var texto = F.pendente.tipo === "fechar"
        ? "Existem alterações pendentes nas fotos."
        : "Existem alterações pendentes neste grupo.";
      partes.push('<div class="am-det-fotos__pendente" role="alertdialog" aria-label="Alterações pendentes nas fotos">' +
        '<span class="am-det-fotos__barra-texto">' + texto + "</span>" +
        '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-acao="foto-pendente-salvar">Salvar</button>' +
        '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-acao="foto-pendente-descartar">Descartar</button>' +
        '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-acao="foto-pendente-cancelar">Cancelar</button>' +
      "</div>");
      return partes.join("");
    }

    var p = pendenciasFotos();
    if (p.total > 0) {
      var onde = fotosVariacoes() ? grupoOriginal().rotulo : "anúncio";
      // Anúncio de produto sem variação: o PUT /items replica as fotos aos
      // anúncios do mesmo produto (doc do ML, user-products item 17).
      if (!fotosVariacoes() && imagemReplicaEmProduto(DET.anuncio)) {
        partes.push('<p class="am-det-fotos__bloqueio">' + icAlerta(12) +
          " Este anúncio pertence a um produto do Mercado Livre. A alteração de imagem pode ser replicada para outros anúncios relacionados.</p>");
      }
      partes.push('<div class="am-det-fotos__barra" role="status">' +
        '<span class="am-det-fotos__barra-texto">' + p.total + (p.total === 1 ? " alteração" : " alterações") +
          " nas fotos de " + escapeHtml(onde) + "</span>" +
        '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-acao="foto-descartar">Descartar</button>' +
        '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-acao="foto-salvar">Salvar no Mercado Livre</button>' +
      "</div>");
    }
    return partes.join("");
  }

  function fotosCorpoHtml() {
    var F = DET && DET.fotos;
    if (F && F.estado === "catalogo") {
      return '<p class="am-det-fotos__bloqueio" role="status">' + escapeHtml(MOTIVO_FOTOS_CATALOGO) + "</p>";
    }
    if (F && F.estado === "erro") return fotosErroHtml(F.erro);
    if (!F || F.estado !== "ok") {
      // A grade existe desde o carregamento: a seção não muda de largura.
      return '<p class="am-det-fotos__info" role="status">Carregando as fotos do anúncio no Mercado Livre…</p>' +
        '<div class="am-det-photos"></div>';
    }

    var g = grupoOriginal();
    var R = F.rascunho;
    var ativos = fotosAtivas().length;
    var editavel = !F.salvando && !fotosTravadas();
    var chips = "";
    var titulo;
    if (fotosVariacoes()) {
      chips = '<div class="am-det-fotos__chips" role="group" aria-label="Grupos de variação">' +
        F.original.grupos.map(function (gr, i) {
          var n = i === R.sel ? ativos : gr.quantidade;
          return '<button type="button" class="am-det-fotos__chip" data-acao="foto-grupo" data-idx="' + i + '"' +
            ' aria-pressed="' + (i === R.sel) + '"' + (editavel ? "" : " disabled") + ">" +
            escapeHtml(gr.rotulo) + " · " + n + "</button>";
        }).join("") +
      "</div>";
      titulo = '<p class="am-det-fotos__titulo">Fotos da variação: ' + escapeHtml(g.rotulo) +
        (g.combinacoes && g.combinacoes.length
          ? ' <span class="am-det-section__meta">(' + escapeHtml(g.combinacoes.join(", ")) + ")</span>"
          : "") +
        "</p>";
    } else {
      titulo = '<p class="am-det-fotos__titulo">Fotos do anúncio</p>';
    }

    var primeiro = R.itens.findIndex(function (it) { return !it.removida; });
    var n = 0;
    var tiles = R.itens.map(function (it, i) {
      if (!it.removida) n += 1;
      return fotoTileHtml(it, i, i === primeiro, ativos > 1, n, editavel);
    }).join("");
    var lim = limiteFotos();
    var cheio = lim !== null && ativos >= lim;
    var adicionar = '<button type="button" class="am-det-photo am-det-photo--add" data-acao="foto-escolher"' +
      (cheio ? ' disabled title="' + escapeAttr(nomeGrupoFotos() + " pode ter no máximo " + lim + " imagens.") + '"'
        : editavel ? "" : " disabled") + ">" +
        '<span class="am-det-photo__add-plus" aria-hidden="true">+</span>' +
        '<span class="am-det-photo__add-label">Adicionar imagem</span>' +
      "</button>";
    var vazio = R.itens.length
      ? ""
      : '<p class="am-det-vazio">' + (fotosVariacoes()
        ? "Nenhuma foto nesta variação no Mercado Livre."
        : "Este anúncio não tem fotos no Mercado Livre.") + "</p>";
    return chips + titulo +
      '<div class="am-det-photos" id="am-det-fotos-grade">' + tiles + adicionar + "</div>" +
      vazio +
      '<input type="file" id="am-det-img-input" class="am-hidden" accept="' + IMAGEM_ACCEPT + '" multiple />' +
      fotosRodapeHtml();
  }

  function renderFotos() {
    if (!DET) return;
    var slot = el("am-det-fotos-corpo");
    if (slot) slot.innerHTML = fotosCorpoHtml();
  }

  function editorPronto() {
    var F = DET && DET.fotos;
    return !!(F && F.estado === "ok" && F.rascunho && !F.pendente && !F.salvando && !fotosTravadas());
  }

  // ----- Fotos: edição do rascunho (só memória) -------------------------------
  function moverFoto(de, para) {
    var itens = DET.fotos.rascunho.itens;
    if (!editorPronto() || de === para || de < 0 || para < 0 || de >= itens.length || para >= itens.length) return;
    if (itens[de].removida || itens[para].removida) return;
    itens.splice(para, 0, itens.splice(de, 1)[0]);
    limparMensagensFotos();
    renderFotos();
  }

  function removerFoto(i) {
    var F = DET.fotos;
    var it = editorPronto() ? F.rascunho.itens[i] : null;
    if (!it || it.removida || fotosAtivas().length <= 1) return; // a última foto nunca sai
    if (it.tipo === "nova") {
      // Nunca existiu no ML: sai do rascunho na hora.
      if (it.previewUrl) { try { URL.revokeObjectURL(it.previewUrl); } catch (_) { /* nada */ } }
      F.rascunho.itens.splice(i, 1);
    } else {
      it.removida = true; // só sai de verdade no salvar
    }
    limparMensagensFotos();
    renderFotos();
  }

  function desfazerFoto(i) {
    var F = DET.fotos;
    var it = editorPronto() ? F.rascunho.itens[i] : null;
    if (!it || !it.removida) return;
    var lim = limiteFotos();
    if (lim !== null && fotosAtivas().length >= lim) {
      F.avisoLocal = "Não é possível desfazer. " + nomeGrupoFotos() + " pode ter no máximo " + lim + " imagens.";
      renderFotos();
      return;
    }
    it.removida = false;
    limparMensagensFotos();
    renderFotos();
  }

  function descartarFotos() {
    var F = DET && DET.fotos;
    if (!F || F.estado !== "ok" || !F.rascunho) return;
    novoRascunho(F.rascunho.sel);
    renderFotos();
  }

  function selecionarGrupoFotos(i) {
    var F = DET && DET.fotos;
    if (!F || F.estado !== "ok" || !F.original.grupos[i] || i === F.rascunho.sel) return;
    if (F.salvando || fotosTravadas()) return;
    if (fotosSujas()) {
      F.pendente = { tipo: "grupo", destino: i };
      renderFotos();
      return;
    }
    novoRascunho(i);
    renderFotos();
  }

  // ----- Fotos: salvar no Mercado Livre -----------------------------------------
  // Validação local antes do PUT (o backend valida de novo).
  function validarRascunhoFotos() {
    var n = fotosAtivas().length;
    if (n === 0) return "Não é possível salvar. " + nomeGrupoFotos() + " precisa ter pelo menos uma imagem.";
    var lim = limiteFotos();
    if (lim !== null && n > lim) return "Não é possível salvar. " + nomeGrupoFotos() + " pode ter no máximo " + lim + " imagens.";
    return null;
  }

  // Rascunho → plano do PUT /fotos:
  //   grupoVariacao: o do GET ({ attribute_id, value_id, value_name } ou null);
  //   base: ids das fotos do grupo EXATAMENTE como vieram no GET;
  //   ordem: { existente: id } | { nova: i }, i = posição do arquivo em novas[];
  //   arquivos: só as novas ativas, na ordem em que aparecem.
  function planoFotos() {
    var arquivos = [];
    var ordem = [];
    DET.fotos.rascunho.itens.forEach(function (it) {
      if (it.removida) return;
      if (it.tipo === "nova") { ordem.push({ nova: arquivos.length }); arquivos.push(it); }
      else ordem.push({ existente: it.id });
    });
    var g = grupoOriginal();
    return {
      plano: { grupoVariacao: g.grupoVariacao, base: g.fotos.map(function (f) { return f.id; }), ordem: ordem },
      arquivos: arquivos,
    };
  }

  // Resposta de erro → o que a tela mostra. `incerto` (do backend) ou falha
  // sem resposta útil (conexão, 5xx sem código): o ML pode ter aplicado.
  function classificarFalhaFotos(status, d) {
    d = d || {};
    if (d.incerto || status === 0 || (status >= 500 && !d.codigo)) {
      var linhas = [];
      if (d.motivo) linhas.push(d.motivo);
      if (d.codigo) linhas.push("Código: " + d.codigo);
      return { tipo: "incerto", titulo: MOTIVO_FOTOS_INCERTO, linhas: linhas };
    }
    if (d.codigo === "FOTOS_DESATUALIZADAS" || d.codigo === "VARIACAO_GRUPO_INEXISTENTE") {
      return { tipo: "conflito", titulo: "O anúncio mudou no Mercado Livre", linhas: [d.motivo || "Recarregue as fotos."] };
    }
    if (d.detalhesMl) {
      var etapas = {
        leitura: "Ao consultar o anúncio no Mercado Livre.",
        upload: "No envio de uma imagem nova ao Mercado Livre — o anúncio não foi alterado.",
        vinculo: "Ao salvar as fotos no anúncio — o Mercado Livre recusou a alteração.",
      };
      var e = erroImagemDe(status, Object.assign({}, d, { etapa: null }));
      return { tipo: "ml", titulo: e.titulo, linhas: (etapas[d.etapa] ? [etapas[d.etapa]] : []).concat(e.linhas) };
    }
    var l = [d.motivo || "Não foi possível salvar as fotos."];
    if (d.codigo) l.push("Código: " + d.codigo);
    return { tipo: "validacao", titulo: "Não foi possível salvar", linhas: l };
  }

  // depois: null | { tipo: "grupo", destino } | { tipo: "fechar" } — o que
  // fazer quando o salvar terminar com sucesso.
  function salvarFotosNoMl(depois) {
    var F = DET && DET.fotos;
    if (!F || F.estado !== "ok" || !F.rascunho || F.salvando || fotosTravadas()) return;
    if (!fotosSujas()) {
      F.pendente = null;
      seguirDepoisDeSalvarFotos(depois, null);
      return;
    }
    var msg = validarRascunhoFotos();
    if (msg) { F.pendente = null; F.avisoLocal = msg; renderFotos(); return; }

    var meuToken = DET.token;
    var montado = planoFotos();
    var grupoAtual = grupoOriginal().grupoVariacao;
    var url = API_BASE + "/anuncios-meli/" + encodeURIComponent(DET.anuncio.item_id) + "/fotos" +
      "?clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug) +
      (AM.contaMlId ? "&clienteContaId=" + encodeURIComponent(AM.contaMlId) : "");
    var form = new FormData();
    form.append("plano", JSON.stringify(montado.plano));
    montado.arquivos.forEach(function (it) { form.append("novas", it.arquivo, it.nome || "imagem"); });

    F.pendente = null;
    F.avisoLocal = null;
    F.falhaSalvar = null;
    F.sucesso = null;
    F.salvando = montado.arquivos.length ? "enviando" : "processando";
    renderFotos();

    // XHR (não fetch) para separar "Enviando imagens" (bytes subindo) de
    // "Salvando no Mercado Livre" (o backend já tem tudo e fala com o ML).
    var xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Authorization", "Bearer " + (AM.token || ""));
    function vivo() { return DET && DET.token === meuToken && DET.fotos === F; }
    xhr.upload.onload = function () {
      if (!vivo() || F.salvando !== "enviando") return;
      F.salvando = "processando";
      renderFotos();
    };
    xhr.onload = function () {
      if (!vivo()) return;
      var d = {};
      try { d = JSON.parse(xhr.responseText || "{}"); } catch (_) { d = {}; }
      F.salvando = null;
      if (xhr.status >= 200 && xhr.status < 300 && d.ok) {
        if (d.anuncio) {
          DET.anuncio = d.anuncio;
          AM.detalheAtual = { anuncio: d.anuncio, descricao: DET.descricao };
        }
        toast("Fotos salvas no Mercado Livre.", "is-success");
        carregarAnuncios(); // contagem/capa de fotos da listagem atrás
        var sucesso = d.confirmacaoPendente
          ? "Fotos salvas no Mercado Livre. A lista local atualiza na próxima sincronização."
          : "Fotos salvas no Mercado Livre.";
        seguirDepoisDeSalvarFotos(depois, { grupo: grupoAtual, sucesso: sucesso });
        return;
      }
      F.falhaSalvar = classificarFalhaFotos(xhr.status, d);
      renderFotos();
    };
    xhr.onerror = function () {
      if (!vivo()) return;
      F.salvando = null;
      F.falhaSalvar = classificarFalhaFotos(0, {});
      renderFotos();
    };
    xhr.send(form);
  }

  // Depois do sucesso: fecha o modal ou RELÊ o GET (nunca assume que o
  // payload virou o estado final) e reabre no grupo certo.
  function seguirDepoisDeSalvarFotos(depois, salvo) {
    var F = DET && DET.fotos;
    if (!F) return;
    if (depois && depois.tipo === "fechar") { fecharDetalhe(true); return; }
    var selecionar = depois && depois.tipo === "grupo"
      ? F.original.grupos[depois.destino].grupoVariacao
      : salvo ? salvo.grupo : grupoOriginal().grupoVariacao;
    if (!salvo) {
      novoRascunho(depois && depois.tipo === "grupo" ? depois.destino : F.rascunho.sel);
      renderFotos();
      return;
    }
    renderDetalhe(); // cabeçalho "Fotos (N)" com a linha nova
    carregarFotos(true, { selecionar: selecionar, sucesso: salvo.sucesso });
    renderFotos();
  }

  // Assinatura do CONTEÚDO do arquivo (SHA-256): a mesma imagem com outro
  // nome também é duplicata. Sem crypto.subtle, cai para nome+tamanho+data.
  function assinaturaArquivo(f) {
    var alternativa = [f.name, f.size, f.lastModified].join("|");
    try {
      if (!window.crypto || !window.crypto.subtle || typeof f.arrayBuffer !== "function") return Promise.resolve(alternativa);
      return f.arrayBuffer()
        .then(function (buf) { return window.crypto.subtle.digest("SHA-256", buf); })
        .then(function (h) {
          return Array.prototype.map.call(new Uint8Array(h), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
        })
        .catch(function () { return alternativa; });
    } catch (_) {
      return Promise.resolve(alternativa);
    }
  }

  // Validação LOCAL, antes de o arquivo entrar no rascunho. Devolve o motivo
  // da recusa ou null.
  function recusaLocal(f, assinatura) {
    var mime = String(f.type || "").toLowerCase();
    if (!IMAGEM_TIPOS[mime]) return "Formato não aceito. Envie uma imagem JPG, PNG ou WebP.";
    if ((f.size || 0) > IMAGEM_MAX_BYTES) return "Arquivo com " + fmtTamanhoArquivo(f.size) + " — o limite é 10 MB.";
    var lim = limiteFotos();
    if (lim !== null && fotosAtivas().length >= lim) {
      return "Não é possível adicionar. " + nomeGrupoFotos() + " pode ter no máximo " + lim + " imagens.";
    }
    var novas = DET.fotos.rascunho.itens.filter(function (it) { return it.tipo === "nova"; });
    if (novas.length >= FOTOS_MAX_NOVAS) return "Adicione até " + FOTOS_MAX_NOVAS + " imagens novas por vez.";
    if (assinatura && novas.some(function (it) { return it.assinatura === assinatura; })) {
      return "Esta imagem já foi adicionada a esta variação.";
    }
    return null;
  }

  function adicionarArquivosFotos(files) {
    var F = DET && DET.fotos;
    if (!editorPronto()) return;
    var meuToken = DET.token;
    var R = F.rascunho;
    limparMensagensFotos();
    // Um arquivo por vez, na ordem escolhida: cada um enxerga o limite e as
    // duplicatas deixadas pelo anterior.
    Array.prototype.slice.call(files || []).reduce(function (fila, f) {
      return fila.then(function () {
        if (!DET || DET.token !== meuToken || DET.fotos !== F || F.rascunho !== R) return null;
        var antes = recusaLocal(f, null);
        if (antes) { F.avisoLocal = antes; return null; }
        return assinaturaArquivo(f).then(function (assinatura) {
          if (!DET || DET.token !== meuToken || DET.fotos !== F || F.rascunho !== R) return;
          var motivo = recusaLocal(f, assinatura);
          if (motivo) { F.avisoLocal = motivo; return; }
          R.seq += 1;
          var it = { tipo: "nova", chave: "nova-" + R.seq, arquivo: f, assinatura: assinatura, nome: f.name || "imagem",
                     bytes: f.size || 0, width: null, height: null, removida: false, previewUrl: null };
          try { it.previewUrl = URL.createObjectURL(f); } catch (_) { it.previewUrl = null; }
          R.itens.push(it);
          if (it.previewUrl) medirFotoNova(it, meuToken);
        });
      });
    }, Promise.resolve()).then(function () {
      if (DET && DET.token === meuToken && DET.fotos === F) renderFotos();
    });
  }

  function medirFotoNova(it, meuToken) {
    var probe = new Image();
    probe.onload = function () {
      if (!DET || DET.token !== meuToken) return;
      it.width = probe.naturalWidth;
      it.height = probe.naturalHeight;
      renderFotos();
    };
    probe.onerror = function () {
      if (!DET || DET.token !== meuToken || !DET.fotos.rascunho) return;
      var idx = DET.fotos.rascunho.itens.indexOf(it);
      if (idx >= 0) DET.fotos.rascunho.itens.splice(idx, 1);
      try { URL.revokeObjectURL(it.previewUrl); } catch (_) { /* nada */ }
      DET.fotos.avisoLocal = "Não foi possível ler este arquivo como imagem.";
      renderFotos();
    };
    probe.src = it.previewUrl;
  }

  // Eventos delegados no contêiner (#am-det-fotos-corpo sobrevive ao
  // renderFotos; só o renderDetalhe o recria, e ele chama bindFotos de novo).
  function bindFotos() {
    carregarFotos(false);
    var corpo = el("am-det-fotos-corpo");
    if (!corpo) return;
    // Captura: pega o change do <input type=file> mesmo quando ele não
    // borbulha, e o input é recriado a cada renderFotos.
    corpo.addEventListener("change", function (e) {
      if (!e.target || e.target.id !== "am-det-img-input") return;
      var files = Array.prototype.slice.call(e.target.files || []);
      e.target.value = ""; // escolher o MESMO arquivo de novo precisa disparar change
      if (files.length) adicionarArquivosFotos(files);
    }, true);
    function itemDe(e) {
      return e.target && e.target.closest ? e.target.closest(".am-det-fotos__item[draggable='true']") : null;
    }
    corpo.addEventListener("dragstart", function (e) {
      var it = itemDe(e);
      if (!it || !editorPronto()) return;
      DET.fotos.arrastando = Number(it.getAttribute("data-idx"));
      it.classList.add("is-arrastando");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", String(DET.fotos.arrastando)); } catch (_) { /* Firefox exige; ok */ }
      }
    });
    corpo.addEventListener("dragover", function (e) {
      if (!itemDe(e) || !DET.fotos || DET.fotos.arrastando === null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    });
    corpo.addEventListener("drop", function (e) {
      var alvo = itemDe(e);
      if (!alvo || !DET.fotos || DET.fotos.arrastando === null) return;
      e.preventDefault();
      var de = DET.fotos.arrastando;
      DET.fotos.arrastando = null;
      moverFoto(de, Number(alvo.getAttribute("data-idx")));
    });
    corpo.addEventListener("dragend", function () {
      if (DET && DET.fotos) DET.fotos.arrastando = null;
      var a = corpo.querySelector(".is-arrastando");
      if (a) a.classList.remove("is-arrastando");
    });
  }

  // ----- Fotos: LEGADO ----------------------------------------------------------
  // Seção de fotos anterior (grade da lista local + "+ Adicionar imagem" via
  // POST /imagens + lista "Fotos por cor" do PR #205). Fora da tela desde a
  // leitura por grupo; fica no arquivo até a etapa de edição substituir o
  // adicionar (plano, Tasks 5–6), quando sai de vez.
  function fotosHtmlLegado(pics, a) {
    var alerta = pics.length < 3
      ? '<span class="am-det-alert">' + icAlerta(12) + "Recomendado ter pelo menos 3 fotos</span>"
      : "";
    var bloqueio = imagemBloqueio(a);
    var ocupado = DET.imagem.estado === "enviando" || DET.imagem.estado === "processando";
    var adicionar =
      '<button type="button" class="am-det-photo am-det-photo--add" id="am-det-img-add" data-acao="img-escolher"' +
        (bloqueio || ocupado ? " disabled" : "") +
        (bloqueio ? ' title="' + escapeAttr(bloqueio) + '"' : "") + ">" +
        '<span class="am-det-photo__add-plus" aria-hidden="true">+</span>' +
        '<span class="am-det-photo__add-label">Adicionar imagem</span>' +
      "</button>";
    var grade = '<div class="am-det-photos">' + pics.map(function (u, i) {
        return '<div class="am-det-photo"><img src="' + escapeHtml(u) + '" alt="Foto ' + (i + 1) +
          ' do anúncio" loading="lazy" /></div>';
      }).join("") + adicionar + "</div>" +
      (pics.length ? "" : '<p class="am-det-vazio">Nenhuma imagem foi retornada para este anúncio.</p>') +
      imagemVariacoesHtml();

    return '<div class="am-det-section">' +
      '<div class="am-det-section__head">' +
        '<h3 class="am-det-section__title">Fotos <span class="am-det-section__meta">(' + pics.length + ")</span></h3>" +
        alerta +
      "</div>" + grade +
      (bloqueio ? '<p class="am-det-img-bloqueio" id="am-det-img-bloqueio">' + escapeHtml(bloqueio) + "</p>" : "") +
      '<input type="file" id="am-det-img-input" class="am-hidden" accept="' + IMAGEM_ACCEPT + '" />' +
      '<div id="am-det-img-envio">' + imagemEnvioHtml() + "</div>" +
    "</div>";
  }

  // ----- Fotos: adicionar imagem ---------------------------------------------
  // POST /anuncios-meli/:itemId/imagens (multipart) — o backend normaliza para
  // JPG, sobe ao CDN do ML e vincula ao anúncio (meliImagensService). Nesta
  // versão só ADICIONA: remover, trocar capa e reordenar ficam para depois.
  //
  // Bloqueios espelham meliImagensService.bloqueioDoAnuncio (o backend checa
  // de novo, inclusive ao vivo no ML — aqui é só para não oferecer o que vai
  // ser recusado).
  var IMAGEM_ACCEPT = "image/jpeg,image/png,image/webp";
  var IMAGEM_TIPOS = { "image/jpeg": "JPG", "image/jpg": "JPG", "image/png": "PNG", "image/webp": "WebP" };
  var IMAGEM_MAX_BYTES = 10 * 1024 * 1024;   // mesmo limite do multer no backend
  var IMAGEM_MIN_LADO_ML = 500;              // mínimo documentado pelo ML (só aviso)

  function imagemBloqueio(a) {
    if (!a) return null;
    if (a.catalog_listing === true) {
      return "Este anúncio é de catálogo: as fotos exibidas são do produto de catálogo do Mercado Livre e não podem ser alteradas por aqui.";
    }
    // Com variações a imagem vai para um grupo (atributo defines_picture) —
    // só libera depois que os grupos chegam do ML; se o ML/backend recusar
    // (User Product, categoria sem defines_picture…), o motivo é o dele.
    if (imagemTemVariacoes(a)) {
      var iv = DET && DET.imagemVar;
      if (!iv || iv.estado === "carregando") return "Carregando as variações do anúncio no Mercado Livre…";
      if (iv.estado === "erro") return iv.motivo || "Não foi possível carregar as variações do anúncio.";
    }
    return null;
  }

  function imagemTemVariacoes(a) {
    return !!(a && Number(a.variations_count) > 0);
  }

  // ----- Fotos: variações ----------------------------------------------------
  // GET /anuncios-meli/:itemId/imagens/variacoes — grupos pelo atributo que
  // define a foto (ex.: Cor). A imagem nova entra em TODAS as variações do
  // grupo escolhido (regra do ML: mesmo valor = mesmas fotos).
  function carregarGruposImagem() {
    if (!DET || !DET.anuncio || !imagemTemVariacoes(DET.anuncio) || DET.anuncio.catalog_listing === true) return;
    if (DET.imagemVar) return;
    var meuToken = DET.token;
    DET.imagemVar = { estado: "carregando" };
    var qs = "clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug) +
      (AM.contaMlId ? "&clienteContaId=" + encodeURIComponent(AM.contaMlId) : "");
    api("/anuncios-meli/" + encodeURIComponent(DET.anuncio.item_id) + "/imagens/variacoes?" + qs).then(function (r) {
      if (!DET || DET.token !== meuToken) return;
      var d = r.data || {};
      DET.imagemVar = d.ok && Array.isArray(d.grupos)
        ? { estado: "ok", atributo: d.atributo || null, grupos: d.grupos }
        : { estado: "erro", motivo: d.motivo || (r.status === 0 ? "Falha de conexão ao carregar as variações." : null) };
      renderFotosVariacoes();
    });
  }

  function grupoImagemRotulo(g, comAtributo) {
    var iv = DET && DET.imagemVar;
    var nomeAttr = iv && iv.atributo && iv.atributo.nome ? iv.atributo.nome : "";
    var combos = (g.variacoes || []).map(function (v) { return v.rotulo; }).filter(Boolean);
    return (comAtributo && nomeAttr ? nomeAttr + ": " : "") + g.valor +
      (combos.length ? " (" + combos.join(", ") + ")" : "");
  }

  function imagemVariacoesHtml() {
    var iv = DET && DET.imagemVar;
    if (!iv || iv.estado !== "ok") return '<div id="am-det-img-var"></div>';
    var nomeAttr = iv.atributo && iv.atributo.nome ? iv.atributo.nome : "variação";
    return '<div id="am-det-img-var" class="am-det-img-var">' +
      '<p class="am-det-img-var__titulo">Fotos por ' + escapeHtml(nomeAttr.toLowerCase()) + "</p>" +
      iv.grupos.map(function (g) {
        return '<div class="am-det-img-var__grupo" data-grupo="' + escapeAttr(g.chave) + '">' +
          '<span class="am-det-img-var__nome">' + escapeHtml(grupoImagemRotulo(g, false)) +
            ' <span class="am-det-section__meta">· ' + (g.fotos || []).length + " foto" + ((g.fotos || []).length === 1 ? "" : "s") + "</span></span>" +
          '<span class="am-det-img-var__fotos">' + (g.fotos || []).map(function (u) {
            return '<img src="' + escapeHtml(u) + '" alt="" loading="lazy" />';
          }).join("") + "</span>" +
        "</div>";
      }).join("") +
    "</div>";
  }

  // Grupos chegaram (ou falharam): atualiza bloqueio, lista por variação e o
  // painel de envio, sem recriar o resto do modal.
  function renderFotosVariacoes() {
    if (!DET) return;
    var slot = el("am-det-img-var");
    if (slot) slot.outerHTML = imagemVariacoesHtml();
    var bloq = el("am-det-img-bloqueio");
    var motivo = imagemBloqueio(DET.anuncio);
    if (bloq && !motivo) bloq.parentNode.removeChild(bloq);
    else if (bloq) bloq.textContent = motivo;
    var add = el("am-det-img-add");
    if (add) {
      if (motivo) add.setAttribute("title", motivo); else add.removeAttribute("title");
    }
    renderImagemEnvio();
  }

  // Sinais de User Product que o sync grava: family_name (modelo novo) ou
  // user_product_id. Só decide o AVISO de replicação, nunca bloqueia.
  function imagemReplicaEmProduto(a) {
    return !!(a && (a.family_name || a.user_product_id));
  }

  function imagemEstadoVazio() {
    return { estado: null, arquivo: null, previewUrl: null, nome: "", tipo: "", bytes: 0,
             width: null, height: null, progresso: null, erroLocal: null, erro: null, sucesso: null,
             grupo: "" };
  }

  function fmtTamanhoArquivo(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1).replace(".", ",") + " MB";
    return Math.max(1, Math.round(bytes / 1024)) + " KB";
  }

  function liberarPreviewImagem() {
    if (DET && DET.imagem && DET.imagem.previewUrl) {
      try { URL.revokeObjectURL(DET.imagem.previewUrl); } catch (_) { /* nada a liberar */ }
      DET.imagem.previewUrl = null;
    }
  }

  function imagemEnvioHtml() {
    var im = DET.imagem;
    if (!im.estado) return "";

    if (im.estado === "concluido") {
      return '<div class="am-det-img-envio is-success" role="status">' +
        '<p class="am-det-img-envio__status">' + icCheck(13) + " Concluído</p>" +
        '<p class="am-det-img-envio__msg">' + escapeHtml(im.sucesso || "") + "</p>" +
        '<div class="am-det-img-envio__acoes">' +
          '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-acao="img-cancelar">Fechar aviso</button>' +
        "</div>" +
      "</div>";
    }

    var tipo = IMAGEM_TIPOS[im.tipo] || (im.tipo ? im.tipo : "Formato desconhecido");
    var dims = im.width && im.height ? " · " + im.width + "×" + im.height + " px" : "";
    var aviso = im.width && im.height && Math.min(im.width, im.height) < IMAGEM_MIN_LADO_ML
      ? '<p class="am-det-img-envio__aviso">' + icAlerta(12) + " Abaixo de " + IMAGEM_MIN_LADO_ML + "×" +
        IMAGEM_MIN_LADO_ML + " px, o mínimo documentado pelo Mercado Livre — ele pode recusar a imagem.</p>"
      : "";
    var ocupado = im.estado === "enviando" || im.estado === "processando";
    // User Product: a doc do ML (user-products, item 17) diz que pictures
    // alteradas por PUT /items são replicadas, de forma assíncrona, a todos os
    // anúncios do mesmo produto. Se o POST /items/{id}/pictures usado aqui
    // replica igual NÃO está documentado — daí o "pode". Não bloqueia.
    var avisoProduto = imagemReplicaEmProduto(DET.anuncio)
      ? '<p class="am-det-img-envio__aviso am-det-img-envio__aviso--produto">' + icAlerta(12) +
        " Este anúncio pertence a um produto do Mercado Livre. A alteração de imagem pode ser replicada para outros anúncios relacionados.</p>"
      : "";

    // Com variações: escolha OBRIGATÓRIA do grupo (sem padrão — a foto errada
    // numa cor errada é pior que um clique a mais).
    var iv = DET.imagemVar;
    var comVariacao = imagemTemVariacoes(DET.anuncio) && iv && iv.estado === "ok";
    var nomeAttr = comVariacao && iv.atributo && iv.atributo.nome ? iv.atributo.nome : "variação";
    var seletor = comVariacao
      ? '<label class="am-det-img-envio__var" for="am-det-img-grupo">Adicionar às variações de ' +
          escapeHtml(nomeAttr.toLowerCase()) +
          '<select class="vf-select vf-select--sm" id="am-det-img-grupo"' + (ocupado ? " disabled" : "") + ">" +
            '<option value="">Escolha…</option>' +
            iv.grupos.map(function (g) {
              return '<option value="' + escapeAttr(g.chave) + '"' + (g.chave === im.grupo ? " selected" : "") + ">" +
                escapeHtml(grupoImagemRotulo(g, true)) + "</option>";
            }).join("") +
          "</select>" +
        "</label>" +
        '<p class="am-det-img-envio__aviso">' + icAlerta(12) +
          " A imagem entra em todas as variações da " + escapeHtml(nomeAttr.toLowerCase()) +
          " escolhida — é a regra do Mercado Livre para variações com o mesmo valor.</p>"
      : "";
    var faltaGrupo = comVariacao && !im.grupo;

    var status = "";
    if (im.estado === "enviando") {
      status = '<p class="am-det-img-envio__status" role="status">Enviando…' +
        (im.progresso != null ? " " + im.progresso + "%" : "") + "</p>";
    } else if (im.estado === "processando") {
      status = '<p class="am-det-img-envio__status" role="status">Processando no Mercado Livre…</p>';
    } else if (im.estado === "erro" && im.erro) {
      status = '<div class="am-det-img-envio__erro" role="alert">' +
        '<p class="am-det-img-envio__status">' + escapeHtml(im.erro.titulo) + "</p>" +
        im.erro.linhas.map(function (l) { return "<p>" + escapeHtml(l) + "</p>"; }).join("") +
      "</div>";
    }

    return '<div class="am-det-img-envio' + (im.estado === "erro" ? " is-danger" : "") + '">' +
      '<div class="am-det-img-envio__preview">' +
        (im.previewUrl ? '<img src="' + escapeAttr(im.previewUrl) + '" alt="Pré-visualização da imagem selecionada" />' : icImagem(20)) +
      "</div>" +
      '<div class="am-det-img-envio__info">' +
        '<p class="am-det-img-envio__nome">' + escapeHtml(im.nome || "imagem") + "</p>" +
        '<p class="am-det-img-envio__meta">' + escapeHtml(tipo + " · " + fmtTamanhoArquivo(im.bytes) + dims) + "</p>" +
        (im.erroLocal ? '<p class="am-det-img-envio__erro-local" role="alert">' + escapeHtml(im.erroLocal) + "</p>" : "") +
        aviso +
        avisoProduto +
        (im.erroLocal ? "" : seletor) +
        status +
        (ocupado ? "" :
          '<div class="am-det-img-envio__acoes">' +
            (im.erroLocal || (im.erro && im.erro.semRetry) ? "" :
              '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-acao="img-enviar"' +
                (faltaGrupo ? ' disabled title="Escolha a variação"' : "") + ">" +
                (im.estado === "erro" ? "Tentar novamente" : "Enviar ao Mercado Livre") + "</button>") +
            '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-acao="img-cancelar">Cancelar</button>' +
          "</div>") +
      "</div>" +
    "</div>";
  }

  // Redesenha só o painel e o botão "+" — sem renderDetalhe, para não
  // recriar a seção de margem/promoções a cada % de progresso.
  function renderImagemEnvio() {
    if (!DET) return;
    var slot = el("am-det-img-envio");
    if (slot) slot.innerHTML = imagemEnvioHtml();
    var add = el("am-det-img-add");
    if (add) {
      var ocupado = DET.imagem.estado === "enviando" || DET.imagem.estado === "processando";
      add.disabled = !!(imagemBloqueio(DET.anuncio) || ocupado);
    }
  }

  function bindFotosLegado() {
    carregarGruposImagem();
    var slot = el("am-det-img-envio");
    if (slot) {
      slot.addEventListener("change", function (e) {
        if (!e.target || e.target.id !== "am-det-img-grupo" || !DET) return;
        DET.imagem.grupo = e.target.value || "";
        renderImagemEnvio();
      });
    }
    var input = el("am-det-img-input");
    if (!input) return;
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      input.value = ""; // escolher o MESMO arquivo de novo precisa disparar change
      if (f) selecionarImagem(f);
    });
  }

  function selecionarImagem(f) {
    if (!DET || imagemBloqueio(DET.anuncio)) return;
    liberarPreviewImagem();
    var im = imagemEstadoVazio();
    im.estado = "selecionada";
    im.arquivo = f;
    im.nome = f.name || "imagem";
    im.tipo = String(f.type || "").toLowerCase();
    im.bytes = f.size || 0;
    // Validação LOCAL (do VenForce, não do ML): as mesmas regras do backend.
    if (!IMAGEM_TIPOS[im.tipo]) im.erroLocal = "Formato não aceito. Envie uma imagem JPG, PNG ou WebP.";
    else if (im.bytes > IMAGEM_MAX_BYTES) im.erroLocal = "Arquivo com " + fmtTamanhoArquivo(im.bytes) + " — o limite é 10 MB.";
    if (!im.erroLocal) {
      try { im.previewUrl = URL.createObjectURL(f); } catch (_) { im.previewUrl = null; }
    }
    DET.imagem = im;
    renderImagemEnvio();

    if (im.previewUrl) {
      var meuToken = DET.token;
      var probe = new Image();
      probe.onload = function () {
        if (!DET || DET.token !== meuToken || DET.imagem !== im) return;
        im.width = probe.naturalWidth;
        im.height = probe.naturalHeight;
        renderImagemEnvio();
      };
      probe.onerror = function () {
        if (!DET || DET.token !== meuToken || DET.imagem !== im) return;
        im.erroLocal = "Não foi possível ler este arquivo como imagem.";
        renderImagemEnvio();
      };
      probe.src = im.previewUrl;
    }
  }

  function cancelarImagem() {
    if (!DET) return;
    var st = DET.imagem.estado;
    if (st === "enviando" || st === "processando") return;
    liberarPreviewImagem();
    DET.imagem = imagemEstadoVazio();
    renderImagemEnvio();
  }

  // Erro exibido como o backend o recebeu. Com `detalhesMl` a recusa é DO
  // MERCADO LIVRE (mensagem, código e causa originais); sem ele é recusa do
  // VenForce (arquivo inválido, bloqueio, conexão) — e o título não finge
  // que foi o ML.
  function erroImagemDe(status, d) {
    d = d || {};
    var det = d.detalhesMl || null;
    // Estado do anúncio incerto (conexão caiu no vínculo, confirmação
    // divergente, perda detectada): reenviar pode duplicar a foto — a tela
    // não oferece "Tentar novamente", pede conferência no ML.
    var semRetry = !!(d.critico || d.codigo === "VINCULO_INCERTO" || d.codigo === "CONFIRMACAO_DIVERGENTE");
    if (!det) {
      var linhasLocal = [d.motivo || (status === 0 ? "Falha de conexão." : "Não foi possível enviar a imagem.")];
      if (d.codigo) linhasLocal.push("Código: " + d.codigo);
      return {
        titulo: d.critico ? "Atenção: confira o anúncio no Mercado Livre" : "Não foi possível enviar a imagem",
        linhas: linhasLocal,
        semRetry: semRetry,
      };
    }
    var etapas = {
      leitura: "Ao consultar o anúncio no Mercado Livre.",
      upload: "No envio do arquivo ao Mercado Livre.",
      vinculo: "Ao vincular a imagem ao anúncio — o arquivo chegou ao Mercado Livre" +
        (d.pictureId ? " (id " + d.pictureId + ")" : "") + ", mas não entrou no anúncio.",
    };
    var linhas = [];
    if (etapas[d.etapa]) linhas.push(etapas[d.etapa]);
    var original = det.message || det.error || d.motivo;
    if (original) linhas.push("Mensagem: “" + original + "”");
    if (d.codigo) linhas.push("Código: " + d.codigo + (det.status ? " (HTTP " + det.status + ")" : ""));
    else if (det.status) linhas.push("HTTP " + det.status);
    var causas = (det.causas || []).map(function (c) {
      return [c.code, c.message].filter(Boolean).join(" — ");
    }).filter(Boolean);
    if (!causas.length && det.causa) causas.push(det.causa);
    if (!causas.length && det.error && det.error !== original) causas.push(det.error);
    if (causas.length) linhas.push("Causa: " + causas.join("; "));
    return { titulo: "Erro do Mercado Livre", linhas: linhas };
  }

  function enviarImagem() {
    if (!DET || !DET.anuncio) return;
    var im = DET.imagem;
    if (!im.arquivo || im.erroLocal || im.estado === "enviando" || im.estado === "processando") return;
    if (imagemBloqueio(DET.anuncio)) return;
    var variacao = imagemTemVariacoes(DET.anuncio);
    if (variacao && !im.grupo) return;

    var meuToken = DET.token;
    var itemId = DET.anuncio.item_id;
    var url = API_BASE + "/anuncios-meli/" + encodeURIComponent(itemId) + "/imagens" +
      "?clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug) +
      (AM.contaMlId ? "&clienteContaId=" + encodeURIComponent(AM.contaMlId) : "") +
      (variacao ? "&grupoVariacao=" + encodeURIComponent(im.grupo) : "");

    var form = new FormData();
    form.append("imagem", im.arquivo, im.nome || "imagem");

    im.estado = "enviando";
    im.progresso = 0;
    im.erro = null;
    renderImagemEnvio();

    // XHR (e não fetch) só para ter o progresso do upload: "Enviando" enquanto
    // os bytes sobem, "Processando" quando o backend já tem o arquivo e está
    // falando com o ML.
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", "Bearer " + (AM.token || ""));
    function vivo() { return DET && DET.token === meuToken && DET.imagem === im; }
    xhr.upload.onprogress = function (e) {
      if (!vivo() || im.estado !== "enviando" || !e.lengthComputable) return;
      im.progresso = Math.min(100, Math.round((e.loaded / e.total) * 100));
      renderImagemEnvio();
    };
    xhr.upload.onload = function () {
      if (!vivo() || im.estado !== "enviando") return;
      im.estado = "processando";
      renderImagemEnvio();
    };
    xhr.onload = function () {
      if (!vivo()) return;
      var d = {};
      try { d = JSON.parse(xhr.responseText || "{}"); } catch (_) { d = {}; }
      if (xhr.status >= 200 && xhr.status < 300 && d.ok) {
        liberarPreviewImagem();
        var fim = imagemEstadoVazio();
        fim.estado = "concluido";
        var destino = d.grupo
          ? " (variações " + (d.grupo.atributo ? d.grupo.atributo + ": " : "") + d.grupo.valor + ")"
          : "";
        fim.sucesso = d.confirmacaoPendente
          ? "A imagem foi adicionada no Mercado Livre" + destino + ". A lista de fotos daqui atualiza na próxima sincronização."
          : "Imagem adicionada ao anúncio no Mercado Livre" + destino + ".";
        DET.imagem = fim;
        // As fotos por variação mudaram no ML: relê no próximo render.
        if (d.grupo) DET.imagemVar = null;
        if (d.anuncio) {
          DET.anuncio = d.anuncio;
          AM.detalheAtual = { anuncio: d.anuncio, descricao: DET.descricao };
        }
        renderDetalhe();
        toast("Imagem adicionada ao anúncio do Mercado Livre.", "is-success");
        carregarAnuncios(); // contagem/capa de fotos da listagem atrás
        return;
      }
      im.estado = "erro";
      im.erro = erroImagemDe(xhr.status, d);
      renderImagemEnvio();
    };
    xhr.onerror = function () {
      if (!vivo()) return;
      im.estado = "erro";
      im.erro = erroImagemDe(0, {});
      renderImagemEnvio();
    };
    xhr.send(form);
  }

  // ----- Título (comparação com a IA) e Modelo (dado factual) ---------------
  // A coluna "Atual" também é editável, mas NÃO é um segundo estado: os dois
  // inputs (este e o do cabeçalho/Catálogo) escrevem no MESMO
  // DET.rascunho[chave] e aplicarEstadosEdicao sincroniza o outro. Um valor,
  // duas vistas — salvar/descartar/reverter/usar sugestão continuam únicos.
  // O título aqui obedece à MESMA trava de catálogo/família do cabeçalho.
  //
  // O Modelo NÃO tem sugestão, geração nem IA (F4R): é dado factual/estrutural
  // do produto (PARENT_PK em todas as categorias reais — auditoria F4.1), não
  // superfície de SEO. Só edição manual, salva pelo mesmo PATCH /conteudo.
  function tituloEModeloHtml(a) {
    var tituloTravado = tituloTravadoPorCatalogo(a);
    return '<div class="am-det-section">' +
      '<div class="am-det-subhead">' +
        "<h4>Título</h4>" +
        '<span id="am-det-status-seo">' + chipTitulos() + "</span>" +
      "</div>" +
      '<div class="am-det-compare am-det-compare--compacto" id="am-det-compare-titulo">' +
        '<div class="am-det-compare__col">' +
          '<div class="am-det-compare__label"><span>' +
            (tituloTravado ? "Atual · gerenciado pelo Mercado Livre" : "Atual · editável aqui ou no cabeçalho") +
          "</span></div>" +
          '<input class="vf-input vf-input--sm am-det-compare__input" id="am-det-espelho-titulo" maxlength="60" ' +
            (tituloTravado ? 'readonly aria-readonly="true" ' : "") +
            'aria-label="Título do anúncio (comparação com a IA)" placeholder="(sem título)" ' +
            'data-campo="titulo" value="' + escapeAttr(DET.rascunho.titulo) + '" />' +
          '<span class="am-det-compare__count" id="am-det-count-espelho-titulo">' +
            DET.rascunho.titulo.length + "/60 caracteres</span>" +
        "</div>" +
        '<div class="am-det-compare__col" id="am-det-sug-titulo">' + sugestaoTitulosHtml() + "</div>" +
      "</div>" +

      '<div class="am-det-subhead">' +
        "<h4>Modelo</h4>" +
      "</div>" +
      '<div class="am-det-compare am-det-compare--compacto am-det-compare--unico" id="am-det-compare-modelo">' +
        '<div class="am-det-compare__col">' +
          '<div class="am-det-compare__label"><span>Dado do produto · editável aqui ou no Catálogo</span></div>' +
          '<input class="vf-input vf-input--sm am-det-compare__input" id="am-det-espelho-modelo" ' +
            'aria-label="Modelo do anúncio" placeholder="—" ' +
            'data-campo="modelo" value="' + escapeAttr(DET.rascunho.modelo) + '" />' +
        "</div>" +
      "</div>" +
    "</div>";
  }

  function rotuloIa() {
    return '<span>' + icIa() + "Sugestão da IA</span>";
  }

  // Estado do lado direito quando não há (ou não pode haver) sugestão.
  // Não-admin vê uma frase, não um 403 mudo — achado F-02.
  function vazioIaHtml(botao, tipo) {
    if (DET.iaBloqueada) {
      return '<p class="am-det-vazio">Otimização por IA disponível para administradores.</p>';
    }
    return '<p class="am-det-vazio">Nenhuma sugestão gerada ainda.</p>' +
      '<div class="am-det-compare__actions">' +
        '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-acao="gerar" data-tipo="' + tipo + '">' +
          escapeHtml(botao) + "</button>" +
      "</div>";
  }

  function acoesIaHtml(botoes) {
    return '<div class="am-det-compare__actions">' + botoes.join("") + "</div>";
  }

  function btnGhost(acao, rotulo, extras) {
    return '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-acao="' + acao + '"' +
      (extras || "") + ">" + escapeHtml(rotulo) + "</button>";
  }

  // ----- Título: sugestões do Title Engine (SEO) ----------------------------
  // POST /:itemId/seo/titulos devolve até 6 títulos com score CALCULADO pelo
  // backend (fatos do anúncio, nunca nota da IA). A tela lista todos como
  // "Sugestões" — sem destacar vencedor —, e "Usar" só muda o rascunho; quem
  // escreve no Mercado Livre continua sendo "Salvar alterações".
  function novoEstadoTitulos() {
    return { estado: null, sugestoes: [], limite: 60, aviso: null, erro: null, codigo: null, descartadas: 0, seq: 0 };
  }

  function sugestaoTitulosHtml() {
    var cabeca = '<div class="am-det-compare__label"><span>' + icIa() + "Sugestões da IA</span></div>";
    if (DET.iaBloqueada) return cabeca + vazioIaHtml("Gerar títulos", "titulos");
    if (tituloTravadoPorCatalogo(DET.anuncio)) {
      return cabeca + '<p class="am-det-vazio">O título é gerenciado pelo Mercado Livre — não há sugestões de título para este anúncio.</p>';
    }
    var T = DET.titulosSeo;
    var gerando = T.estado === "carregando";
    var botaoGerar = function (rotulo) {
      return '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-acao="gerar-titulos"' +
        (gerando ? " disabled" : "") + ">" + escapeHtml(gerando ? "Gerando…" : rotulo) + "</button>";
    };

    if (T.estado === "ok" && T.sugestoes.length) {
      var itens = T.sugestoes.map(function (sug, i) {
        return "<li><span>" +
            '<span class="vf-status is-info" title="Score calculado pelos fatos do anúncio">' + escapeHtml(String(sug.score)) + "</span> " +
            escapeHtml(sug.titulo) + " <b>(" + sug.chars + "/" + T.limite + ")</b>" +
          "</span>" +
          '<span class="am-det-alts__btns">' + btnGhost("usar-titulo", "Usar", ' data-idx="' + i + '"') + "</span></li>";
      }).join("");
      var notas = [];
      if (T.aviso) notas.push(escapeHtml(T.aviso));
      if (T.descartadas) {
        notas.push(T.descartadas + (T.descartadas === 1 ? " sugestão descartada" : " sugestões descartadas") +
          " por não se apoiar nos dados do anúncio.");
      }
      return cabeca + '<ul class="am-det-alts">' + itens + "</ul>" +
        (notas.length ? '<p class="am-det-compare__hint">' + notas.join(" ") + "</p>" : "") +
        acoesIaHtml([botaoGerar("Gerar novamente")]);
    }

    if (T.estado === "erro") {
      return cabeca + '<p class="am-det-vazio">' + escapeHtml(T.erro || "Não foi possível gerar títulos.") + "</p>" +
        (T.codigo === "TITULO_NAO_EDITAVEL" ? "" : acoesIaHtml([botaoGerar("Tentar novamente")]));
    }

    return cabeca + '<p class="am-det-vazio">' + (gerando ? "Gerando sugestões de título…" : "Nenhuma sugestão gerada ainda.") + "</p>" +
      acoesIaHtml([botaoGerar("Gerar títulos")]);
  }

  function chipTitulos() {
    if (DET.iaBloqueada) return '<span class="vf-status is-empty">IA restrita a administradores</span>';
    if (tituloTravadoPorCatalogo(DET.anuncio)) return '<span class="vf-status is-empty">Gerenciado pelo Mercado Livre</span>';
    var T = DET.titulosSeo;
    if (T.estado === "carregando") return '<span class="vf-status is-info">Gerando títulos…</span>';
    if (T.estado === "erro") return '<span class="vf-status is-danger">Não foi possível gerar</span>';
    if (T.estado === "ok") {
      return '<span class="vf-status is-info">' + T.sugestoes.length +
        (T.sugestoes.length === 1 ? " sugestão" : " sugestões") + "</span>";
    }
    return '<span class="vf-status is-empty">Aguardando geração</span>';
  }

  function repintarTitulos() {
    var col = el("am-det-sug-titulo");
    if (col) col.innerHTML = sugestaoTitulosHtml();
    var chip = el("am-det-status-seo");
    if (chip) chip.innerHTML = chipTitulos();
  }

  function gerarTitulos() {
    if (!DET || !DET.anuncio || DET.titulosSeo.estado === "carregando") return;
    if (tituloTravadoPorCatalogo(DET.anuncio)) return;
    var meuToken = DET.token;
    var T = DET.titulosSeo;
    var minhaSeq = ++T.seq;
    T.estado = "carregando";
    T.erro = null;
    T.codigo = null;
    repintarTitulos();

    var corpo = { clienteSlug: AM.clienteAtual.slug };
    if (AM.contaMlId) corpo.clienteContaId = AM.contaMlId;
    api("/anuncios-meli/" + encodeURIComponent(DET.anuncio.item_id) + "/seo/titulos", {
      method: "POST",
      body: corpo,
    }).then(function (r) {
      // Modal fechado, outro anúncio/conta, ou um "Gerar" mais novo no meio.
      if (!DET || DET.token !== meuToken || DET.titulosSeo !== T || T.seq !== minhaSeq) return;
      if (r.status === 403 && !(r.data && r.data.codigo)) {
        DET.iaBloqueada = true;
        renderDetalhe();
        return;
      }
      var d = r.data || {};
      if (!d.ok || !Array.isArray(d.sugestoes) || !d.sugestoes.length) {
        T.estado = "erro";
        T.erro = d.motivo || "Não foi possível gerar títulos.";
        T.codigo = d.codigo || null;
        T.sugestoes = [];
        repintarTitulos();
        toast(T.erro, "is-danger");
        return;
      }
      T.estado = "ok";
      T.sugestoes = d.sugestoes;
      T.limite = d.limite || 60;
      T.aviso = d.aviso || null;
      T.descartadas = d.descartadas || 0;
      repintarTitulos();
    });
  }

  function usarTitulo(idx) {
    var sug = DET && DET.titulosSeo.sugestoes[idx];
    if (!sug || tituloTravadoPorCatalogo(DET.anuncio)) return;
    usarSugestao("titulo", sug.titulo);
  }

  // Lista de melhorias (✓) e alertas (⚠) — mesmo desenho do canva.
  function listaIaHtml(melhorias, alertas) {
    var itens = (melhorias || []).map(function (m) {
      return '<li class="ok">' + icCheck(12) + escapeHtml(m) + "</li>";
    }).concat((alertas || []).map(function (al) {
      return '<li class="warn">' + icAlerta(12) + escapeHtml(al) + "</li>";
    }));
    if (!itens.length) return "";
    return '<ul class="am-det-compare__list">' + itens.join("") + "</ul>";
  }

  // Chip de estado por SEÇÃO. Título e Modelo saem da MESMA otimização (tipo
  // "seo"), mas a aprovação é por campo — `titulo_aprovado` e `modelo_aprovado`
  // são colunas distintas. Ler o campo, e não o `status` do registro, é o que
  // permite "Título aprovado, Modelo ainda não" como o canva mostra.
  var APROVACAO_POR_CAMPO = {
    titulo: "titulo_aprovado",
    modelo: "modelo_aprovado",
    descricao: "descricao_aprovada",
    ficha: "ficha_aprovada_json",
  };

  function chipOtimizacao(tipo, campo) {
    if (DET.iaBloqueada) return '<span class="vf-status is-empty">IA restrita a administradores</span>';
    var o = AM.otimizacoes[tipo];
    if (!o) return '<span class="vf-status is-empty">Aguardando geração</span>';

    // A coluna presente e NULA é informação: "esta otimização foi aprovada,
    // mas não neste campo". Só quando ela nem vem no payload é que o `status`
    // do registro serve de proxy.
    var coluna = APROVACAO_POR_CAMPO[campo];
    var aprovado = coluna && coluna in o
      ? !!o[coluna]
      : o.status === "aprovado";
    if (aprovado) {
      return '<span class="vf-status is-success">Aprovado em ' + escapeHtml(formatData(o.aprovado_at)) + "</span>";
    }
    // A ficha usa o rótulo curto do canva; título e modelo, o longo.
    return campo === "ficha"
      ? '<span class="vf-status is-info">Sugestão gerada</span>'
      : '<span class="vf-status is-empty">Sugestão gerada, aguardando decisão</span>';
  }

  // ----- Descrição: campo editável (única representação) × sugestão ----------
  function descricaoHtml() {
    var erro = DET.descricaoEstado === "erro";
    var texto = DET.rascunho.descricao || "";

    var rotuloEsq = erro
      ? "<span>Não foi possível carregar a descrição</span>"
      : "<span>Editável · <b id=\"am-det-count-descricao\">" + texto.length + "</b> caracteres</span>";

    var esquerda;
    if (erro) {
      esquerda = '<div class="am-det-compare__label">' + rotuloEsq + "</div>" +
        '<p class="am-det-erro-desc">' + escapeHtml(DET.descricaoErro ||
          "O Mercado Livre não devolveu a descrição deste anúncio.") +
        " Editar aqui sobrescreveria a descrição real por um texto que não conhecemos, " +
        "então o campo fica bloqueado até a leitura funcionar.</p>";
    } else {
      esquerda = '<div class="am-det-compare__label">' + rotuloEsq + "</div>" +
        '<div class="am-det-editable" id="am-det-editable-descricao">' +
          '<textarea class="vf-textarea am-det-textarea" id="am-det-descricao" aria-label="Descrição do anúncio" ' +
            'placeholder="Este anúncio não tem descrição preenchida. Escreva uma aqui.">' +
            escapeHtml(texto) + "</textarea>" +
          '<div class="am-det-editable__meta">' +
            '<span id="am-det-desc-origem">' + escapeHtml(origemDescricao()) + "</span>" +
            '<span class="am-det-editable__btns">' +
              '<button type="button" class="am-det-revert" data-acao="reverter" data-campo="descricao" ' +
                'id="am-det-revert-descricao" title="Descartar e voltar ao texto original" ' +
                'aria-label="Descartar alteração na descrição">' + icDesfazer() + "</button>" +
              btnGhost("copiar", "Copiar", ' data-fonte="descricao-atual"') +
            "</span>" +
          "</div>" +
        "</div>";
    }

    return '<div class="am-det-section">' +
      '<div class="am-det-section__head">' +
        '<h3 class="am-det-section__title">Descrição</h3>' +
        '<span class="am-det-dirty am-det-dirty--neutro" id="am-det-dirty-descricao">' +
          '<span class="am-det-dot"></span>Alteração não salva</span>' +
      "</div>" +
      '<div class="am-det-compare">' +
        '<div class="am-det-compare__col">' + esquerda + "</div>" +
        '<div class="am-det-compare__col" id="am-det-sug-descricao">' +
          sugestaoDescricaoHtml() + "</div>" +
      "</div>" +
    "</div>";
  }

  function origemDescricao() {
    if (DET.descricaoOrigem === "ia") {
      return "preenchida a partir da sugestão da IA" +
        (DET.descricaoOrigemHora ? " às " + DET.descricaoOrigemHora : "");
    }
    if (DET.descricaoEstado === "sem_descricao") return "este anúncio não tem descrição no Mercado Livre";
    return "descrição atual do anúncio no Mercado Livre";
  }

  // ----- Descrição: sugestão do Description Engine (SEO) --------------------
  // POST /:itemId/seo/descricao devolve UMA descrição, já validada pelo
  // backend contra os fatos do anúncio (sem score). "Usar" só muda o rascunho;
  // quem escreve no Mercado Livre continua sendo "Salvar alterações". O
  // histórico/aprovação do otimizador legado não alimenta mais esta coluna.
  function novoEstadoDescricao() {
    return { estado: null, texto: "", chars: 0, limite: 0, fatosUsados: [], avisos: [], ajustesEditoriais: [], autorreparo: null, erro: null, codigo: null, problemas: [], seq: 0 };
  }

  function descricaoSugeridaUsada() {
    var S = DET && DET.descricaoSeo;
    return !!(S && S.estado === "ok" && S.texto && DET.rascunho.descricao === S.texto);
  }

  function avisosDescricaoHtml(S) {
    var ajustes = { ACENTUACAO: "Acentuação corrigida", VALOR_SEM_INFORMACAO: "Valores sem informação removidos",
      MATERIAL_MINUSCULO: "Grafia dos materiais padronizada", ITEM_CONTIDO: "Itens redundantes removidos",
      SECAO_POBRE: "Seções redundantes removidas" };
    var linhas = (S.avisos || []).map(function (a) {
      if (!a || !a.acao) return "";
      return String(a.acao) + (a.trecho ? ": " + a.trecho : "") +
        (Array.isArray(a.termos) && a.termos.length ? " (" + a.termos.join(", ") + ")" : "");
    }).filter(Boolean);
    (S.ajustesEditoriais || []).forEach(function (codigo) {
      linhas.push(ajustes[codigo] || "Ajuste editorial realizado");
    });
    if (S.autorreparo && S.autorreparo.etapa === "remocao" && S.autorreparo.removidas && S.autorreparo.removidas.length) {
      linhas.push("Trechos sem suporte foram removidos antes da aprovação da descrição.");
    }
    if (S.autorreparo && S.autorreparo.etapa === "reparo_ia" && Array.isArray(S.autorreparo.trocas) &&
        S.autorreparo.trocas.some(function (t) { return t && t.depois != null && t.depois !== t.antes; })) {
      linhas.push("Trechos foram corrigidos pela IA e a descrição foi validada novamente.");
    }
    return linhas.length ? listaIaHtml([], linhas) : "";
  }

  function sugestaoDescricaoHtml() {
    var usada = descricaoSugeridaUsada();
    chipUsadaAtual = usada;
    var cabeca = '<div class="am-det-compare__label">' + rotuloIa() +
      (usada ? '<span class="vf-status is-success">Usada nesta edição</span>' : "") + "</div>";
    if (DET.iaBloqueada) {
      return cabeca + '<p class="am-det-vazio">Otimização por IA disponível para administradores.</p>';
    }
    // Sem saber o que o anúncio tem hoje, uma sugestão poderia apagar conteúdo
    // real — e o campo da esquerda está bloqueado pelo mesmo motivo.
    if (DET.descricaoEstado === "erro") {
      return cabeca + '<p class="am-det-vazio">A sugestão fica disponível quando a descrição atual puder ser lida.</p>';
    }

    var S = DET.descricaoSeo;
    var gerando = S.estado === "carregando";
    var botaoGerar = function (rotulo) {
      return '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-acao="gerar-descricao"' +
        (gerando ? " disabled" : "") + ">" + escapeHtml(gerando ? "Gerando…" : rotulo) + "</button>";
    };

    if (S.estado === "ok" && S.texto) {
      var base = (S.fatosUsados || []).map(function (f) { return f && f.label; }).filter(Boolean);
      return cabeca +
        '<p class="am-det-readtext am-det-readtext--sug am-det-readtext--bloco">' + escapeHtml(S.texto) + "</p>" +
        '<p class="am-det-compare__hint">' + S.chars + (S.limite ? "/" + S.limite : "") + " caracteres" +
          (base.length ? " · com base em: " + escapeHtml(base.join(", ")) : "") + "</p>" +
        avisosDescricaoHtml(S) + acoesIaHtml([
          btnGhost("usar-descricao", "Usar descrição", ""),
          btnGhost("copiar", "Copiar", ' data-fonte="descricao-sugerida"'),
          botaoGerar("Gerar novamente"),
        ]);
    }

    if (S.estado === "erro") {
      // Rejeição da checagem de fatos (DESCRICAO_INVALIDA): diz que NADA foi
      // aplicado e lista cada motivo do backend, um por linha, em vez do
      // parágrafo corrido. Outros erros (IA fora, resposta cortada) seguem
      // com o motivo como veio.
      var falhaReparo = S.autorreparo && S.autorreparo.etapa === "falha"
        ? '<p class="am-det-vazio">O reparo automático foi tentado, mas não resolveu a rejeição. ' + escapeHtml(S.erro || "") + "</p>"
        : "";
      if (S.codigo === "DESCRICAO_INVALIDA") {
        var vistos = {};
        var motivos = (S.problemas || []).map(function (p) {
          var t = p && p.detalhe ? String(p.detalhe) : "";
          if (t && p.termos && p.termos.length) t += " (" + p.termos.slice(0, 3).join(", ") + ")";
          return t;
        }).filter(function (t) { return t && !vistos[t] && (vistos[t] = true); });
        return cabeca +
          '<p class="am-det-vazio"><b>A descrição gerada foi rejeitada pela checagem de fatos.</b> ' +
            "Nada foi aplicado ao rascunho nem ao anúncio.</p>" + falhaReparo +
          (motivos.length
            ? listaIaHtml([], motivos)
            : '<p class="am-det-vazio">' + escapeHtml(S.erro || "") + "</p>") +
          acoesIaHtml([botaoGerar("Tentar novamente")]);
      }
      return cabeca + falhaReparo + '<p class="am-det-vazio">' + escapeHtml(S.erro || "Não foi possível gerar a descrição.") + "</p>" +
        acoesIaHtml([botaoGerar("Tentar novamente")]);
    }

    return cabeca + '<p class="am-det-vazio">' + (gerando ? "Gerando descrição…" : "Nenhuma sugestão gerada ainda.") + "</p>" +
      acoesIaHtml([botaoGerar("Gerar descrição")]);
  }

  function repintarDescricao() {
    var col = el("am-det-sug-descricao");
    if (col) col.innerHTML = sugestaoDescricaoHtml();
  }

  function gerarDescricao() {
    if (!DET || !DET.anuncio || DET.descricaoSeo.estado === "carregando") return;
    if (DET.descricaoEstado === "erro") return;
    var meuToken = DET.token;
    var S = DET.descricaoSeo;
    var minhaSeq = ++S.seq;
    S.estado = "carregando";
    S.erro = null;
    S.codigo = null;
    S.problemas = [];
    S.avisos = [];
    S.ajustesEditoriais = [];
    S.autorreparo = null;
    repintarDescricao();

    var corpo = { clienteSlug: AM.clienteAtual.slug };
    if (AM.contaMlId) corpo.clienteContaId = AM.contaMlId;
    api("/anuncios-meli/" + encodeURIComponent(DET.anuncio.item_id) + "/seo/descricao", {
      method: "POST",
      body: corpo,
    }).then(function (r) {
      // Modal fechado, outro anúncio/conta, ou um "Gerar" mais novo no meio.
      if (!DET || DET.token !== meuToken || DET.descricaoSeo !== S || S.seq !== minhaSeq) return;
      if (r.status === 403 && !(r.data && r.data.codigo)) {
        DET.iaBloqueada = true;
        renderDetalhe();
        return;
      }
      var d = r.data || {};
      S.avisos = Array.isArray(d.avisos) ? d.avisos : [];
      S.ajustesEditoriais = Array.isArray(d.ajustesEditoriais) ? d.ajustesEditoriais : [];
      S.autorreparo = d.autorreparo || null;
      if (!d.ok || typeof d.descricao !== "string" || !d.descricao) {
        S.estado = "erro";
        S.erro = d.motivo || "Não foi possível gerar a descrição.";
        S.codigo = d.codigo || null;
        S.problemas = Array.isArray(d.problemas) ? d.problemas : [];
        S.texto = "";
        repintarDescricao();
        toast(S.erro, "is-danger");
        return;
      }
      S.estado = "ok";
      S.texto = d.descricao;
      S.chars = d.chars || d.descricao.length;
      S.limite = d.limite || 0;
      S.fatosUsados = Array.isArray(d.fatosUsados) ? d.fatosUsados : [];
      repintarDescricao();
    });
  }

  function usarDescricao() {
    var S = DET && DET.descricaoSeo;
    if (!S || S.estado !== "ok" || !S.texto || DET.descricaoEstado === "erro") return;
    usarSugestao("descricao", S.texto);
  }

  // ----- Ficha técnica: atual × sugerida ------------------------------------
  function fichaHtml(attrs) {
    var cheios = attrs.filter(function (x) { return valorAtributo(x); }).length;

    var linhas = attrs.length
      ? attrs.map(function (x) {
          var v = valorAtributo(x);
          return "<tr" + (v ? "" : ' class="is-empty"') + "><td>" + escapeHtml(nomeAtributo(x)) +
            "</td><td>" + (v ? "<strong>" + escapeHtml(v) + "</strong>" : "Vazio") + "</td></tr>";
        }).join("")
      : '<tr><td colspan="2">Nenhum atributo retornado para este anúncio.</td></tr>';

    return '<div class="am-det-section">' +
      '<div class="am-det-section__head">' +
        '<h3 class="am-det-section__title">Ficha técnica <span class="am-det-section__meta">' +
          cheios + "/" + attrs.length + " preenchidos</span></h3>" +
        '<span id="am-det-status-ficha">' + chipOtimizacao("ficha_tecnica", "ficha") + "</span>" +
      "</div>" +
      '<div class="am-det-compare">' +
        '<div class="am-det-compare__col">' +
          '<div class="am-det-compare__label"><span>Atual — ' + attrs.length + " atributos possíveis</span></div>" +
          '<table class="am-det-ficha"><thead><tr><th>Campo</th><th>Atual</th></tr></thead><tbody>' +
            linhas + "</tbody></table>" +
        "</div>" +
        '<div class="am-det-compare__col" id="am-det-sug-ficha">' +
          sugestaoFichaHtml(AM.otimizacoes.ficha_tecnica, attrs) + "</div>" +
        '<div class="am-det-compare__foot" id="am-det-foot-ficha">' +
          footFichaHtml(AM.otimizacoes.ficha_tecnica, attrs) + "</div>" +
      "</div>" +
    "</div>";
  }

  function chaveCampo(s) {
    return String(s || "").trim().toLowerCase();
  }

  var CONFIANCA = { alta: "Alta", media: "Média", "média": "Média", baixa: "Baixa" };
  function rotuloConfianca(v) {
    var c = String(v || "media").toLowerCase();
    return CONFIANCA[c] || (c.charAt(0).toUpperCase() + c.slice(1));
  }

  // "A", "A e B", "A, B e C" — a enumeração que o canva usa no rodapé da ficha.
  function listaPt(itens) {
    if (itens.length <= 1) return itens[0] || "";
    return itens.slice(0, -1).join(", ") + " e " + itens[itens.length - 1];
  }

  function mapaSugestoesFicha(otim) {
    var mapa = {};
    var sug = otim ? (tryParseJSON(otim.ficha_tecnica_sugerida_json, []) || []) : [];
    sug.forEach(function (s) { if (s && s.campo) mapa[chaveCampo(s.campo)] = s; });
    return mapa;
  }

  function sugestaoFichaHtml(otim, attrs) {
    var cabeca = '<div class="am-det-compare__label">' + rotuloIa() + "</div>";
    if (!otim) return cabeca + vazioIaHtml("Sugerir ficha técnica", "ficha_tecnica");

    var mapa = mapaSugestoesFicha(otim);
    var alertas = tryParseJSON(otim.alertas_json, []) || [];
    var temSug = Object.keys(mapa).length > 0;

    if (!temSug) {
      return cabeca +
        '<p class="am-det-vazio">A IA não encontrou ajustes relevantes — a ficha técnica já está aceitável.</p>' +
        listaIaHtml([], alertas) +
        acoesIaHtml([btnGhost("gerar", "Gerar novamente", ' data-tipo="ficha_tecnica"')]);
    }

    var linhas = attrs.map(function (x) {
      var s = mapa[chaveCampo(nomeAtributo(x))] || mapa[chaveCampo(x && x.id)];
      if (!s || !s.valor_sugerido) {
        return "<tr><td>" + escapeHtml(nomeAtributo(x)) + "</td><td>—</td><td>—</td></tr>";
      }
      return "<tr><td>" + escapeHtml(nomeAtributo(x)) + "</td><td><strong>" +
        escapeHtml(s.valor_sugerido) + "</strong></td><td>" + escapeHtml(rotuloConfianca(s.confianca)) +
        (s.precisa_revisao ? " · revisar" : "") + "</td></tr>";
    });

    // Sugestões para campos que não estão na ficha atual entram no fim.
    var nomesAtuais = {};
    attrs.forEach(function (x) {
      nomesAtuais[chaveCampo(nomeAtributo(x))] = true;
      if (x && x.id) nomesAtuais[chaveCampo(x.id)] = true;
    });
    Object.keys(mapa).forEach(function (k) {
      if (nomesAtuais[k]) return;
      var s = mapa[k];
      linhas.push("<tr><td>" + escapeHtml(s.campo) + "</td><td><strong>" +
        escapeHtml(s.valor_sugerido || "—") + "</strong></td><td>" +
        escapeHtml(rotuloConfianca(s.confianca)) +
        (s.precisa_revisao ? " · revisar" : "") + "</td></tr>");
    });

    return cabeca +
      '<table class="am-det-ficha"><thead><tr><th>Campo</th><th>Sugerido</th><th>Conf.</th></tr></thead>' +
      "<tbody>" + linhas.join("") + "</tbody></table>" +
      listaIaHtml([], alertas) +
      acoesIaHtml([
        btnGhost("copiar-ficha", "Copiar como lista", ""),
        btnGhost("aprovar-ficha", "Aprovar", ""),
        btnGhost("gerar", "Gerar novamente", ' data-tipo="ficha_tecnica"'),
      ]);
  }

  function footFichaHtml(otim, attrs) {
    var vazios = attrs.filter(function (x) { return !valorAtributo(x); });
    var plural = vazios.length === 1 ? " atributo vazio" : " atributos vazios";
    if (!otim) {
      return '<span class="am-det-compare__scoreline">' + vazios.length + plural +
        " — nenhuma sugestão gerada ainda.</span>";
    }
    var mapa = mapaSugestoesFicha(otim);
    var cobertos = vazios.filter(function (x) {
      var s = mapa[chaveCampo(nomeAtributo(x))] || mapa[chaveCampo(x && x.id)];
      return s && s.valor_sugerido;
    });
    var descobertos = vazios.filter(function (x) {
      var s = mapa[chaveCampo(nomeAtributo(x))] || mapa[chaveCampo(x && x.id)];
      return !s || !s.valor_sugerido;
    }).map(nomeAtributo);

    var txt = cobertos.length + " sugest" + (cobertos.length === 1 ? "ão gerada" : "ões geradas") +
      " de " + vazios.length + plural;
    if (descobertos.length) {
      var visiveis = descobertos.slice(0, 4);
      if (descobertos.length > 4) visiveis.push("mais " + (descobertos.length - 4));
      txt += " — " + listaPt(visiveis) +
        (descobertos.length === 1 ? " segue" : " seguem") + " sem sugestão";
    }
    return '<span class="am-det-compare__scoreline">' + escapeHtml(txt) + "</span>";
  }

  // ===========================================================================
  // COMPOSIÇÃO DA MARGEM — seção secundária do modal de detalhe.
  //
  // Transparência sobre como a margem do MLB foi calculada, sem recalcular
  // nada: todo número vem do Motor de Margem (GET /anuncios-meli/performance
  // ?incluirComposicao=1 — mesmo endpoint que a lista já usa para a coluna
  // Margem, ver carregarPerformance/garantirComposicaoDoItem). A ÚNICA conta
  // feita fora do Motor é "venda × imposto%" no BACKEND (o Motor guarda
  // imposto como percentual, nunca em R$) — só para a linha Imposto virar
  // moeda como as demais; a margem final exibida é sempre
  // item.margin.<origem>.margin/profit, o número pronto do Motor, nunca uma
  // soma das linhas desta tela.
  //
  // Sempre aberta: a busca sai junto com a abertura do modal (ver
  // carregarComposicaoDoDetalhe). Reabrir o modal do MESMO item_id lê do
  // cache; abrir OUTRO MLB nunca herda a composição do anterior, porque o
  // cache é indexado por item_id, não por sessão de modal.
  // ===========================================================================

  function margemComposicaoCarregandoHtml() {
    return '<p class="am-margem-comp__dica">Carregando composição…</p>';
  }

  // Uma linha SOMENTE LEITURA da "escada" — omitida por completo quando o
  // valor não existe (nunca um "—" no lugar dela): é a régua pedida
  // ("mostrar apenas o que existe"). Usada por Comissão/Frete/Imposto —
  // valores calculados/determinados pelo Motor ou pelo Mercado Livre, nunca
  // editáveis nesta tela.
  function margemComposicaoLinhaHtml(rotulo, valor, moeda, tooltip) {
    if (valor == null) return "";
    return '<div class="am-margem-comp__linha">' +
      '<span class="am-margem-comp__rotulo">' + escapeHtml(rotulo) +
        (tooltip ? infoDotHtml(tooltip) : "") + "</span>" +
      '<span class="am-margem-comp__valor">' + formatMoeda(valor, moeda) + "</span>" +
    "</div>";
  }

  function botaoMargemEditHtml(rotulo, tituloBotao) {
    // Lápis sempre visível: o campo se anuncia editável sem depender do hover.
    return '<button type="button" class="am-margem-edit__btn" title="' + escapeAttr(tituloBotao) + '">' +
      escapeHtml(rotulo) + '<span class="am-margem-edit__lapis" aria-hidden="true">' + icLapis(11) + "</span></button>";
  }

  // Uma linha de SIMULAÇÃO (Custo do produto/Custos adicionais) — ao
  // contrário das somente-leitura, NUNCA some por valor ausente: é assim que
  // o operador simula um custo que a Base não tem. `campo` é o nome usado
  // pelo clique/teclado (bindMargemEditavel) e pelo contrato de POST
  // .../simular-margem ("custoProduto" | "custosAdicionais"). Nunca chama o
  // Mercado Livre — Preço tem seu próprio HTML/fluxo, ver
  // margemComposicaoLinhaPrecoHtml.
  function margemComposicaoLinhaEditavelHtml(rotulo, campo, valor, moeda, itemId, tituloBotao) {
    return '<div class="am-margem-comp__linha am-margem-comp__linha--editavel">' +
      '<span class="am-margem-comp__rotulo">' + escapeHtml(rotulo) + "</span>" +
      '<span class="am-margem-comp__valor am-margem-edit" data-margem-item="' + escapeAttr(itemId) +
        '" data-margem-campo="' + escapeAttr(campo) + '" data-margem-valor="' + escapeAttr(valor == null ? "" : valor) + '">' +
        botaoMargemEditHtml(formatMoeda(valor, moeda), tituloBotao) +
      "</span>" +
    "</div>";
  }

  // Linha de PREÇO quando está BLOQUEADA (promoção ativa no Mercado Livre —
  // o valor exibido é o promocional, e não existe hoje endpoint de escrita
  // pra ele, ver meliPrecoService): texto puro, sem botão nenhum (nem de
  // simulação) — o motivo aparece num ⓘ ao lado do rótulo, mesmo padrão do
  // título travado por catálogo. Fora deste caso, a linha de preço é só mais
  // uma célula de simulação (ver margemComposicaoLinhaEditavelHtml) — a
  // escrita real só acontece pela ação "Aplicar preço" + diálogo de
  // confirmação (ver abrirConfirmacaoAplicarPreco), nunca direto no clique.
  function margemComposicaoLinhaPrecoBloqueadoHtml(valor, moeda, motivoBloqueio) {
    var rotulo = '<span class="am-margem-comp__rotulo">Preço' + infoDotHtml(motivoBloqueio) + "</span>";
    var valorHtml = '<span class="am-margem-comp__valor am-margem-comp__valor--bloqueado" title="' +
      escapeAttr(motivoBloqueio) + '">' + formatMoeda(valor, moeda) + "</span>";
    return '<div class="am-margem-comp__linha am-margem-comp__linha--editavel">' + rotulo + valorHtml + "</div>";
  }

  // Prioridade de bloqueio da linha "Preço", do mais forte para o mais fraco
  // (decisão de produto — ver auditoria):
  //   1. promoção ativa (comp.precoPromocionalAtivo) — sem edição nenhuma,
  //      nem real nem simulada (ver margemComposicaoLinhaPrecoHtml);
  //   2. item legado com variations[] reais no ML (variations_count > 0) —
  //      PUT real NUNCA é tentado aqui (o backend recusaria com
  //      PRECO_ITEM_COM_VARIACAO, ver meliPrecoService.MOTIVO_VARIACAO,
  //      inalterado). A linha vira SIMULAÇÃO, reaproveitando o MESMO
  //      mecanismo de Custo do produto/Custos adicionais (POST
  //      .../simular-margem já aceita `preco` como override);
  //   3. caso normal — PUT real de verdade, ver margemComposicaoLinhaPrecoHtml.
  function precoBloqueadoPorVariacoesLegado(comp) {
    if (comp.precoPromocionalAtivo) return false;
    return !!(DET && DET.anuncio && (DET.anuncio.variations_count || 0) > 0);
  }

  function margemComposicaoLadderHtml(comp, cacheMargem, moeda, itemId) {
    var sim = (DET && DET.itemId === itemId) ? DET.simulacaoMargem : null;
    var simulando = !!(sim && (sim.custoProduto != null || sim.custosAdicionais != null || sim.preco != null));

    // Custo do produto e Custos adicionais mostram o OVERRIDE de simulação
    // quando ativo — nunca o valor real por baixo dele, para não sugerir que
    // o número simulado foi gravado em algum lugar.
    var custoExibido = sim && sim.custoProduto != null ? sim.custoProduto : comp.custoProduto;
    var custosAdicionaisExibido = sim && sim.custosAdicionais != null ? sim.custosAdicionais : comp.taxaFixa;

    // Escrita real de preço só é possível fora dos dois bloqueios abaixo —
    // usado tanto para escolher o HTML da linha quanto para decidir se a
    // ação "Aplicar preço" pode aparecer.
    var podeAplicarPrecoReal = !comp.precoPromocionalAtivo && !precoBloqueadoPorVariacoesLegado(comp);

    var linhaPreco;
    if (comp.precoPromocionalAtivo) {
      linhaPreco = margemComposicaoLinhaPrecoBloqueadoHtml(comp.venda, moeda,
        "Este anúncio está com uma promoção ativa no Mercado Livre — o valor mostrado é o preço promocional vigente, " +
        "que esta tela ainda não edita. Ajuste a promoção diretamente no Mercado Livre.");
    } else {
      var precoExibido = sim && sim.preco != null ? sim.preco : comp.venda;
      var dicaPreco = podeAplicarPrecoReal
        ? 'Simular outro preço — clique em "Aplicar preço" abaixo para gravar no Mercado Livre'
        : "Simular outro preço — não grava no Mercado Livre; este anúncio possui variações e o preço deve ser " +
          "alterado no nível do anúncio.";
      linhaPreco = margemComposicaoLinhaEditavelHtml("Preço de venda", "preco", precoExibido, moeda, itemId, dicaPreco);
    }

    // "Aplicar preço": só aparece quando há uma simulação de preço PENDENTE
    // (diferente do preço real) E a escrita real é possível — nunca para
    // promoção ativa nem item com variações legado, nos dois casos porque o
    // PUT real seria recusado (ou já está sendo mostrado outro preço).
    var precoSimuladoPendente = podeAplicarPrecoReal && sim && sim.preco != null &&
      Number(sim.preco) !== Number(comp.venda);
    var aplicarPrecoHtml = precoSimuladoPendente
      ? '<div class="am-margem-comp__linha am-margem-comp__linha--acao">' +
          '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-acao="aplicar-preco" ' +
            'data-margem-item="' + escapeAttr(itemId) + '">Aplicar preço no Mercado Livre</button>' +
        "</div>"
      : "";

    var linhas =
      linhaPreco +
      aplicarPrecoHtml +
      margemComposicaoLinhaEditavelHtml("Custo do produto", "custoProduto", custoExibido, moeda, itemId,
        "Simular outro custo — não altera a Base de Custos") +
      margemComposicaoLinhaHtml("Comissão Mercado Livre", comp.comissaoMl, moeda) +
      margemComposicaoLinhaHtml("Frete", comp.frete, moeda) +
      margemComposicaoLinhaEditavelHtml("Custos adicionais", "custosAdicionais", custosAdicionaisExibido, moeda, itemId,
        "Simular embalagem, operação ou outro custo extra — não é cobrado pelo Mercado Livre");

    // "Taxa de rebate": só aparece quando o anúncio tem uma promoção ATIVA
    // com retorno ML conhecido (subsidioMl, ver promocaoAtivaComSubsidioDoItem
    // / meliPromocoesService.normalizarPromocao) — some sozinha nos demais
    // casos, mesmo padrão de Imposto/taxaFixa. É SOMADA ao lucro (nunca
    // deduzida) — a "Margem" abaixo já vem do backend com esse valor
    // incluído (ver marginEngine.computeMargin`rebate`), esta linha só
    // explica de onde vem a diferença.
    if (comp.rebate != null) {
      linhas += margemComposicaoLinhaHtml("Taxa de rebate", comp.rebate, moeda,
        "Retorno ML da promoção ativa — somado ao lucro, não é um custo.");
    }

    if (comp.impostoValor != null) {
      var rotuloImposto = "Imposto" +
        (comp.impostoPercentual != null ? " (" + formatarPercentualCompacto(comp.impostoPercentual * 100) + ")" : "");
      linhas += margemComposicaoLinhaHtml(rotuloImposto, comp.impostoValor, moeda,
        "Guardado como percentual pelo Motor de Margem — este valor em R$ é só para exibição.");
    }

    // "= Margem": o valor REAL do Motor por padrão — nunca a soma das linhas
    // acima. Só vira "Margem simulada" enquanto Custo do produto ou Custos
    // adicionais tiverem um override ativo — e aí o número é sempre o que
    // veio de POST .../simular-margem, nunca recalculado aqui no front.
    var totalHtml = "";
    if (simulando && sim.resultado) {
      var r = sim.resultado;
      totalHtml = '<div class="am-margem-comp__linha am-margem-comp__total am-margem-comp__total--simulada">' +
        '<span class="am-margem-comp__rotulo">Margem simulada' + infoDotHtml(
          "Projeção com os valores digitados acima — nada foi gravado no Mercado Livre nem na Base de Custos."
        ) + "</span>" +
        '<span class="am-margem-comp__valor">' +
          (r.computable
            ? formatMoeda(r.profit, moeda) + (r.marginPercent != null ? " (" + formatarPercentualCompacto(r.marginPercent) + ")" : "")
            : "Sem dados suficientes para simular") +
          ' <button type="button" class="am-margem-comp__restaurar" data-acao="restaurar-simulacao-margem" ' +
            'title="Descartar a simulação e voltar para a margem real">↺ real</button>' +
        "</span>" +
      "</div>";
    } else if (cacheMargem && cacheMargem.profit != null) {
      totalHtml = '<div class="am-margem-comp__linha am-margem-comp__total">' +
        '<span class="am-margem-comp__rotulo">Margem</span>' +
        '<span class="am-margem-comp__valor">' + formatMoeda(cacheMargem.profit, moeda) +
          (cacheMargem.marginPercent != null ? " (" + formatarPercentualCompacto(cacheMargem.marginPercent) + ")" : "") +
        "</span>" +
      "</div>";
    }

    return '<div class="am-margem-comp__ladder">' + linhas + totalHtml + "</div>";
  }

  // Conteúdo pronto da seção — usado tanto no primeiro paint (quando o item
  // já estava em cache, ex.: reabrir o modal do mesmo MLB) quanto depois que
  // a busca sob demanda resolve (ver repintarComposicaoDoItem).
  function margemComposicaoConteudoHtml(itemId, moeda) {
    var cache = AM.state.performanceCache[itemId];
    if (!cache || !cache.temMargem) return margemComposicaoCarregandoHtml();

    // Badge de estado — a MESMA função que já pinta a célula de margem da
    // lista (mesmo rótulo, mesma cor, mesmo vocabulário real do Motor).
    // Cobre sozinha os dois casos de "sem número": contexto indisponível
    // (margemIndisponivel) e item não-computável (statusLabel/statusReasons)
    // — a composição segue exatamente a mesma disponibilidade da lista,
    // nunca um caminho alternativo.
    var badge = '<div class="am-margem-comp__badge">' +
      margemConteudoHtml(cache.margem, cache.margemIndisponivel) + "</div>";

    if (!cache.temComposicao) return badge + margemComposicaoCarregandoHtml();
    if (!cache.composicao) return badge; // contexto indisponível / item não-computável — sem ladder, sem número parcial

    return badge + margemComposicaoLadderHtml(cache.composicao, cache.margem, moeda, itemId);
  }

  // Resumo compacto à direita do título — só aparece quando a composição
  // já chegou.
  function margemComposicaoResumoHtml(itemId) {
    var cache = AM.state.performanceCache[itemId];
    if (!cache || !cache.temComposicao || !cache.margem || cache.margem.marginPercent == null) return "";
    // Margem = Margem Projetada, SOMENTE, nesta tela — sem alternância de
    // rótulo pra comunicar (cache.margem.origem é sempre "projected").
    return escapeHtml(formatarPercentualCompacto(cache.margem.marginPercent));
  }

  // Seção sempre aberta: a composição é pedida ao abrir o modal (ver
  // carregarComposicaoDoDetalhe) e, enquanto não chega, o corpo mostra
  // "Carregando composição…". Re-renders do modal reaproveitam o cache.
  function margemComposicaoSecaoHtml(a) {
    var itemId = a.item_id;
    var cache = AM.state.performanceCache[itemId];
    var corpo = cache && cache.temComposicao
      ? margemComposicaoConteudoHtml(itemId, a.moeda)
      : margemComposicaoCarregandoHtml();

    return '<div class="am-det-section am-margem-comp" id="am-det-margem" data-item="' + escapeAttr(itemId) + '">' +
      '<div class="am-det-section__head">' +
        '<h3 class="am-det-section__title">Composição da margem</h3>' +
        '<span class="am-det-section__meta" id="am-det-margem-resumo">' + margemComposicaoResumoHtml(itemId) + "</span>" +
      "</div>" +
      '<div class="am-margem-comp__body" id="am-det-margem-body">' + corpo + "</div>" +
    "</div>";
  }

  // Pedida uma vez por abertura do modal. Guardado por DET.token, mesmo
  // padrão de carregarHistoricoOtimizacoes: uma resposta tardia depois de
  // fechar o modal (ou abrir o de outro MLB) nunca escreve na tela errada.
  function carregarComposicaoDoDetalhe(itemId, meuToken) {
    // Espera promoções (em voo desde a abertura, ver DET.promocoesPronto)
    // ANTES de pedir a composição: se houver promoção ATIVA com subsidioMl,
    // a margem inicial já nasce com o rebate — sem depender de qual dos dois
    // pedidos volta primeiro. `promocoesPronto` nunca rejeita (ver
    // garantirPromocoesDoItem), então não precisa de tratamento de erro.
    var promocoesProntas = (DET && DET.promocoesPronto) || Promise.resolve();
    promocoesProntas.then(function () {
      if (!DET || DET.token !== meuToken) return;
      garantirComposicaoDoItem(itemId).then(function () {
        if (!DET || DET.token !== meuToken) return; // modal fechado, ou outro MLB aberto no meio do caminho
        repintarComposicaoDoItem(itemId);
      });
    });
  }

  function repintarComposicaoDoItem(itemId) {
    var corpo = el("am-det-margem-body");
    if (corpo) corpo.innerHTML = margemComposicaoConteudoHtml(itemId, DET.anuncio.moeda);
    var resumo = el("am-det-margem-resumo");
    if (resumo) resumo.innerHTML = margemComposicaoResumoHtml(itemId);
    // O preço do CABEÇALHO usa a mesma fonte que acabou de chegar — sem isso
    // ele ficaria preso ao snapshot (a.preco/a.preco_original) mesmo depois
    // da composição já mostrar o valor ao vivo do Motor logo abaixo.
    var precoWrap = el("am-det-price");
    if (precoWrap && DET.anuncio) precoWrap.outerHTML = precoDetalheHtml(DET.anuncio);
    bindMargemEditavel(corpo);
    bindAplicarPreco(corpo, itemId);
    bindRestaurarSimulacaoMargem(corpo, itemId);
  }

  // ===========================================================================
  // Composição da margem — EDIÇÃO. Preço de venda, Custo do produto e Custos
  // adicionais são TODOS simulação local primeiro (POST .../simular-margem,
  // via bindMargemEditavel/confirmarSimulacaoMargem — Enter confirma, Esc
  // cancela). A escrita REAL de preço no Mercado Livre (PATCH .../preco)
  // nunca acontece nesse clique: só quando existe uma simulação de preço
  // pendente aparece a ação "Aplicar preço no Mercado Livre" (ver
  // margemComposicaoLadderHtml), que abre um diálogo de confirmação
  // (Preço atual/Novo preço/Margem atual/Margem simulada — ver
  // abrirConfirmacaoEscrita) e só grava no clique explícito em "Confirmar"
  // dentro dele. Ver bindAplicarPreco/abrirConfirmacaoAplicarPreco/
  // aplicarPrecoReal.
  // ===========================================================================

  var CAMPOS_MARGEM_ROTULO = {
    custoProduto: "Custo do produto", custosAdicionais: "Custos adicionais", preco: "Preço de venda",
  };

  function bindMargemEditavel(raiz) {
    (raiz || document).querySelectorAll(".am-margem-edit").forEach(function (cel) {
      cel.addEventListener("click", function (e) {
        e.stopPropagation();
        if (e.target.closest(".am-margem-edit__btn")) abrirEditorMargemCampo(cel);
      });
    });
  }

  function bindRestaurarSimulacaoMargem(raiz, itemId) {
    var botao = (raiz || document).querySelector('[data-acao="restaurar-simulacao-margem"]');
    if (!botao) return;
    botao.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!DET || DET.itemId !== itemId) return;
      DET.simulacaoMargem = { custoProduto: null, custosAdicionais: null, preco: null, resultado: null };
      DET.promoLinhaSelecionada = null;
      repintarComposicaoDoItem(itemId);
      repintarPromocoesDoItem(itemId);
    });
  }

  // Valor de LEITURA de uma célula de simulação: o override quando existe,
  // senão o valor REAL do cache.
  function valorLeituraMargemCampo(campo, itemId) {
    var cache = AM.state.performanceCache[itemId];
    var comp = cache && cache.composicao;
    var sim = DET && DET.itemId === itemId ? DET.simulacaoMargem : null;
    if (campo === "custoProduto") {
      if (sim && sim.custoProduto != null) return sim.custoProduto;
      return comp ? comp.custoProduto : null;
    }
    if (campo === "custosAdicionais") {
      if (sim && sim.custosAdicionais != null) return sim.custosAdicionais;
      return comp ? comp.taxaFixa : null;
    }
    if (campo === "preco") {
      if (sim && sim.preco != null) return sim.preco;
      return comp ? comp.venda : null;
    }
    return null;
  }

  function pintarMargemCampoLeitura(cel) {
    var campo = cel.getAttribute("data-margem-campo");
    var itemId = cel.getAttribute("data-margem-item");
    var valor = valorLeituraMargemCampo(campo, itemId);
    cel.setAttribute("data-margem-valor", valor == null ? "" : valor);
    cel.classList.remove("is-editando", "is-salvando");
    cel.innerHTML = botaoMargemEditHtml(
      formatMoeda(valor, DET.anuncio.moeda),
      "Simular — não altera a Base de Custos nem o Mercado Livre"
    );
  }

  function abrirEditorMargemCampo(cel) {
    if (!DET) return;
    if (cel.classList.contains("is-editando") || cel.classList.contains("is-salvando")) return;

    var campo = cel.getAttribute("data-margem-campo");
    var atual = cel.getAttribute("data-margem-valor") || "";
    cel.classList.add("is-editando");
    var dica = "Enter simula a margem, Esc cancela";
    cel.innerHTML = '<input type="number" step="0.01" min="0" class="am-margem-edit__input" ' +
      'value="' + escapeAttr(atual) + '" title="' + escapeAttr(dica) + '" aria-label="' +
      escapeAttr((CAMPOS_MARGEM_ROTULO[campo] || campo) + ". " + dica) + '" />';
    var input = cel.querySelector(".am-margem-edit__input");
    if (!input) return;
    input.focus();
    input.select();

    // Mesma regra dos outros campos de simulação desta tela: Enter confirma,
    // Esc cancela, sair do campo CANCELA — nunca confirma por acidente (um
    // clique fora, um Tab).
    input.addEventListener("keydown", function (e) {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        confirmarSimulacaoMargem(cel, campo, input.value);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        pintarMargemCampoLeitura(cel);
      }
    });
    input.addEventListener("blur", function () {
      if (cel.classList.contains("is-salvando")) return;
      pintarMargemCampoLeitura(cel);
    });
  }

  // Custo do produto / Custos adicionais: só SIMULA. Nunca chama o Mercado
  // Livre, nunca grava na Base de Custos — só alimenta POST .../simular-margem
  // com o núcleo do Motor (marginEngine.computeMargin), o mesmo de sempre.
  function confirmarSimulacaoMargem(cel, campo, bruto) {
    var itemId = cel.getAttribute("data-margem-item");
    // Só existe em células da tabela "Promoções disponíveis" (ver
    // promocaoLinhaHtml) — null em todas as outras (composição). Marca QUAL
    // linha passa a mostrar "Você recebe" quando o campo é "preco". Chave
    // composta id::tipo (ver promocaoChave) — nunca só o id.
    var promoChave = cel.getAttribute("data-promo-key");
    var anterior = cel.getAttribute("data-margem-valor") || "";
    var texto = String(bruto == null ? "" : bruto).trim();

    if (texto === anterior) { pintarMargemCampoLeitura(cel); return; }

    if (texto === "") {
      // Campo esvaziado: o override some — volta a valer o número real do Motor.
      DET.simulacaoMargem[campo] = null;
      if (promoChave != null && campo === "preco") DET.promoLinhaSelecionada = null;
      pintarMargemCampoLeitura(cel);
      dispararSimulacaoMargem(itemId);
      return;
    }

    var n = Number(texto);
    if (!isFinite(n) || n < 0) {
      toast("Informe um número maior ou igual a zero.", "is-danger");
      pintarMargemCampoLeitura(cel);
      return;
    }

    DET.simulacaoMargem[campo] = Math.round((n + Number.EPSILON) * 100) / 100;
    if (promoChave != null && campo === "preco") DET.promoLinhaSelecionada = promoChave;
    pintarMargemCampoLeitura(cel);
    dispararSimulacaoMargem(itemId);
  }

  function dispararSimulacaoMargem(itemId) {
    if (!DET || DET.itemId !== itemId) return;
    var sim = DET.simulacaoMargem;
    if (sim.custoProduto == null && sim.custosAdicionais == null && sim.preco == null) {
      // Nenhum override ativo: some a projeção e volta para a margem real,
      // sem gastar chamada nenhuma.
      sim.resultado = null;
      DET.promoLinhaSelecionada = null;
      repintarComposicaoDoItem(itemId);
      repintarPromocoesDoItem(itemId);
      return;
    }

    var cache = AM.state.performanceCache[itemId];
    var origem = cache && cache.margem ? cache.margem.origem : "projected";
    var corpo = { clienteSlug: AM.clienteAtual.slug, origem: origem };
    if (AM.contaMlId) corpo.clienteContaId = AM.contaMlId;
    if (sim.custoProduto != null) corpo.custoProduto = sim.custoProduto;
    if (sim.custosAdicionais != null) corpo.custosAdicionais = sim.custosAdicionais;
    if (sim.preco != null) corpo.preco = sim.preco;
    // Simulação manual nascida de uma linha de promoção: soma o mesmo
    // retorno ML (subsidioMl) já mostrado na coluna "Subsídio ML" dessa
    // linha, pelo mesmo campo `rebate` do Motor — nunca uma conta à parte.
    // promocaoPorChave (id+tipo) — nunca só o id, pra nunca somar o
    // subsidioMl de uma promoção DIFERENTE que coincida de id (ver
    // promocaoChave).
    if (DET.promoLinhaSelecionada != null) {
      var promoAtual = promocaoPorChave(itemId, DET.promoLinhaSelecionada);
      if (promoAtual && promoAtual.subsidioMl != null) corpo.subsidioMl = promoAtual.subsidioMl;
    }

    var meuToken = DET.token;
    api("/anuncios-meli/" + encodeURIComponent(itemId) + "/simular-margem", { method: "POST", body: corpo })
      .then(function (r) {
        if (!DET || DET.token !== meuToken) return; // modal fechado, ou outro MLB no meio do caminho
        var d = r.data || {};
        if (!d.ok) {
          toast(d.motivo || "Não foi possível simular a margem.", "is-danger");
          return;
        }
        DET.simulacaoMargem.resultado = d.resultado;
        repintarComposicaoDoItem(itemId);
        repintarPromocoesDoItem(itemId);
      });
  }

  // ===========================================================================
  // Diálogo de confirmação — o único caminho pra qualquer escrita real que
  // nasce de uma simulação desta tela (preço da composição e
  // participação/alteração de promoção, ver mais abaixo). Sempre mostra o
  // "antes/depois" pedido pela auditoria; só age no clique explícito em
  // "Confirmar" dentro do diálogo — Cancelar (ou X) nunca envia nada.
  // ===========================================================================

  // opts: { titulo, linhas: [{rotulo, valor}], textoConfirmar, aoConfirmar(concluir) }
  // `aoConfirmar` recebe `concluir(mensagemErro)` — chame sem argumento pra
  // fechar o diálogo com sucesso, ou com uma mensagem pra mostrar o erro e
  // deixar o diálogo aberto (o operador tenta de novo ou cancela).
  function abrirConfirmacaoEscrita(opts) {
    var overlay = document.createElement("div");
    overlay.className = "am-confirm-overlay vf-overlay is-open";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "am-confirm-titulo");

    var linhasHtml = opts.linhas.map(function (l) {
      return '<div class="am-confirm__linha"><span class="am-confirm__rotulo">' + escapeHtml(l.rotulo) +
        '</span><span class="am-confirm__valor">' + escapeHtml(l.valor) + "</span></div>";
    }).join("");

    function pintarCorpo(bannerErroHtml) {
      var box = overlay.querySelector(".am-confirm-box");
      if (!box) return;
      box.innerHTML =
        '<div class="vf-modal__body">' +
          '<h3 id="am-confirm-titulo" class="am-confirm__titulo">' + escapeHtml(opts.titulo) + "</h3>" +
          '<div class="am-confirm__linhas">' + linhasHtml + "</div>" +
          (bannerErroHtml || "") +
        "</div>" +
        '<div class="vf-modal__footer">' +
          '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-acao="confirm-cancelar">Cancelar</button>' +
          '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-acao="confirm-ok">' +
            escapeHtml(opts.textoConfirmar || "Confirmar") + "</button>" +
        "</div>";
    }

    overlay.innerHTML = '<div class="am-confirm-box vf-modal vf-modal--sm"></div>';
    pintarCorpo();
    document.body.appendChild(overlay);
    document.body.classList.add("vf-no-scroll");

    function fechar() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.body.classList.remove("vf-no-scroll");
    }

    overlay.addEventListener("click", function (e) {
      if (e.target.closest('[data-acao="confirm-cancelar"]')) { fechar(); return; }
      if (!e.target.closest('[data-acao="confirm-ok"]')) return;

      var okBtn = overlay.querySelector('[data-acao="confirm-ok"]');
      var cancelBtn = overlay.querySelector('[data-acao="confirm-cancelar"]');
      if (okBtn) { okBtn.disabled = true; okBtn.classList.add("is-loading"); okBtn.textContent = "Confirmando…"; }
      if (cancelBtn) cancelBtn.disabled = true;

      opts.aoConfirmar(function (mensagemErro) {
        if (mensagemErro) {
          pintarCorpo(
            '<div class="vf-banner is-danger" role="alert"><div class="vf-banner__content">' +
              '<p class="vf-banner__description">' + escapeHtml(mensagemErro) + "</p>" +
            "</div></div>"
          );
          return;
        }
        fechar();
      });
    });
  }

  // ===========================================================================
  // Preço — escrita REAL no Mercado Livre (PATCH .../preco), mas só depois de
  // simular (ver campo "preco" acima) e confirmar no diálogo. O valor exibido
  // depois do sucesso NUNCA é o digitado — vem de reconsultar a composição
  // (que por sua vez lê o preço confirmado pela resposta do PUT, ver
  // meliPrecoService no backend).
  // ===========================================================================

  function bindAplicarPreco(raiz, itemId) {
    var botao = (raiz || document).querySelector('[data-acao="aplicar-preco"]');
    if (!botao) return;
    botao.addEventListener("click", function (e) {
      e.stopPropagation();
      abrirConfirmacaoAplicarPreco(itemId);
    });
  }

  function abrirConfirmacaoAplicarPreco(itemId) {
    if (!DET || DET.itemId !== itemId) return;
    var cache = AM.state.performanceCache[itemId];
    var comp = cache && cache.composicao;
    var sim = DET.simulacaoMargem;
    if (!comp || !sim || sim.preco == null) return;

    var moeda = DET.anuncio.moeda;
    var margemAtual = cache.margem && cache.margem.marginPercent != null ? cache.margem.marginPercent : null;
    var margemSimulada = (sim.resultado && sim.resultado.computable && sim.resultado.marginPercent != null)
      ? sim.resultado.marginPercent : null;

    abrirConfirmacaoEscrita({
      titulo: "Aplicar novo preço no Mercado Livre",
      textoConfirmar: "Confirmar",
      linhas: [
        { rotulo: "Preço atual", valor: formatMoeda(comp.venda, moeda) },
        { rotulo: "Novo preço", valor: formatMoeda(sim.preco, moeda) },
        { rotulo: "Margem atual", valor: margemAtual != null ? formatarPercentualCompacto(margemAtual) : "—" },
        { rotulo: "Margem simulada", valor: margemSimulada != null ? formatarPercentualCompacto(margemSimulada) : "—" },
      ],
      aoConfirmar: function (concluir) { aplicarPrecoReal(itemId, sim.preco, concluir); },
    });
  }

  // Nunca chamada fora do "Confirmar" do diálogo acima — sem clique
  // explícito, nada é enviado ao Mercado Livre.
  function aplicarPrecoReal(itemId, novoPreco, concluir) {
    if (!DET || DET.precoMargem.salvando) { concluir("Já existe uma gravação de preço em andamento."); return; }
    DET.precoMargem.salvando = true;

    var corpo = { clienteSlug: AM.clienteAtual.slug, preco: novoPreco };
    if (AM.contaMlId) corpo.clienteContaId = AM.contaMlId;

    var meuToken = DET.token;
    api("/anuncios-meli/" + encodeURIComponent(itemId) + "/preco", { method: "PATCH", body: corpo })
      .then(function (r) {
        if (!DET || DET.token !== meuToken) { concluir(); return; } // modal fechado, ou outro MLB no meio do caminho
        DET.precoMargem.salvando = false;
        var d = r.data || {};
        if (!d.ok) {
          concluir(d.motivo || "Não foi possível atualizar o preço.");
          return;
        }

        // Preço real mudou: qualquer simulação de custo/custos adicionais em
        // cima do preço antigo deixa de fazer sentido — some, e a composição
        // é reconsultada do zero (nunca assume o valor enviado).
        DET.simulacaoMargem = { custoProduto: null, custosAdicionais: null, preco: null, resultado: null };
        DET.promoLinhaSelecionada = null;
        var cache = AM.state.performanceCache[itemId];
        if (cache) { cache.temComposicao = false; cache.temMargem = false; }

        garantirComposicaoDoItem(itemId).then(function () {
          if (!DET || DET.token !== meuToken) return;
          repintarComposicaoDoItem(itemId);
        });
        repintarPromocoesDoItem(itemId);
        toast("Preço atualizado no Mercado Livre.");
        concluir();
      });
  }

  // ===========================================================================
  // PROMOÇÕES DISPONÍVEIS — bloco ao lado da composição da margem, inspirado
  // na tabela de promoções do próprio Mercado Livre.
  //
  // Fonte: GET /:itemId/promocoes (meliPromocoesService, que por sua vez lê
  // GET /seller-promotions/items/{id} — dado oficial do ML, nunca uma
  // estimativa própria). Lazy: buscado em segundo plano assim que o detalhe
  // termina de carregar (ver abrirDetalhe), NUNCA atrasando a abertura do
  // modal; cacheado por item_id (mesmo padrão de AM.state.performanceCache).
  //
  // A célula "Preço final" é SEMPRE simulação — reaproveita 100% do mecanismo
  // de Custo do produto/Custos adicionais da composição (mesma classe
  // .am-margem-edit, mesmo bindMargemEditavel/abrirEditorMargemCampo/
  // confirmarSimulacaoMargem, mesmo override DET.simulacaoMargem.preco e
  // mesmo POST .../simular-margem) — nunca grava nada no Mercado Livre, nunca
  // inscreve o anúncio em promoção nenhuma. `DET.promoLinhaSelecionada`
  // guarda só qual LINHA está com uma simulação MANUAL ativa — enquanto
  // nenhuma está selecionada, cada linha já chega com "Você recebe"
  // auto-preenchido em `p.voceRecebe` (calculado no backend, mesmo Motor,
  // ver ctrl.anexarVoceRecebe); ao selecionar uma linha, o valor manual de
  // DET.simulacaoMargem.resultado.profit passa a ter prioridade sobre o
  // auto-preenchido (ver promocaoVoceRecebeHtml). Nunca a fórmula da tela
  // "Promoções com Retorno ML".
  // ===========================================================================

  function garantirPromocoesDoItem(itemId) {
    var cache = AM.state.promocoesCache[itemId];
    if (cache) return Promise.resolve(cache);
    var emVoo = AM.state.promocoesFetchEmVoo[itemId];
    if (emVoo) return emVoo;

    var url = "/anuncios-meli/" + encodeURIComponent(itemId) + "/promocoes" +
      "?clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug) +
      (AM.contaMlId ? "&clienteContaId=" + encodeURIComponent(AM.contaMlId) : "");

    var p = api(url).then(function (r) {
      delete AM.state.promocoesFetchEmVoo[itemId];
      var d = r.data || {};
      var resultado = { ok: !!(d && d.ok), promocoes: (d && d.ok && Array.isArray(d.promocoes)) ? d.promocoes : [] };
      AM.state.promocoesCache[itemId] = resultado;
      return resultado;
    }).catch(function () {
      delete AM.state.promocoesFetchEmVoo[itemId];
      var resultado = { ok: false, promocoes: [] };
      AM.state.promocoesCache[itemId] = resultado;
      return resultado;
    });
    AM.state.promocoesFetchEmVoo[itemId] = p;
    return p;
  }

  // Identidade de UMA promoção nesta tela: id sozinho NÃO é garantido único
  // pelo Mercado Livre (o id só é único dentro do namespace de cada TIPO de
  // campanha — duas promoções de tipos diferentes podem coincidir de id por
  // acaso). O backend já deduplica por id+tipo (meliPromocoesService.
  // deduplicarPromocoes) — esta chave espelha a MESMA identidade no
  // frontend, pra nunca resolver o clique numa linha errada, nunca somar o
  // subsidioMl de uma promoção diferente na simulação de margem, e nunca
  // disparar o aviso de rebate por engano (ver auditoria: bug real com duas
  // promoções de tipos diferentes compartilhando o mesmo id).
  function promocaoChave(p) {
    return p.id + "::" + p.tipo;
  }

  function promocaoPorChave(itemId, chave) {
    var cache = AM.state.promocoesCache[itemId];
    if (!cache || !cache.promocoes) return null;
    for (var i = 0; i < cache.promocoes.length; i++) {
      if (promocaoChave(cache.promocoes[i]) === chave) return cache.promocoes[i];
    }
    return null;
  }

  // Promoção ATIVA do item (statusExibicao === "ATIVA" — mesma regra que já
  // libera a edição de promoção) com subsidioMl conhecido — fonte do rebate
  // da composição da margem (ver garantirComposicaoDoItem). Só lê o cache que
  // garantirPromocoesDoItem já preencheu; nunca dispara chamada nova.
  function promocaoAtivaComSubsidioDoItem(itemId) {
    var cache = AM.state.promocoesCache[itemId];
    if (!cache || !cache.promocoes) return null;
    for (var i = 0; i < cache.promocoes.length; i++) {
      var p = cache.promocoes[i];
      if (p.statusExibicao === "ATIVA" && p.subsidioMl != null) return p;
    }
    return null;
  }

  function promocoesDicaHtml(texto) {
    return '<p class="am-promo__dica">' + escapeHtml(texto) + "</p>";
  }

  // dd/mm/aaaa compacto — a tabela não tem espaço para o horário que
  // formatData() (usado no resto do modal) inclui.
  function promocaoDataCompacta(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("pt-BR");
  }

  function promocaoPeriodoTexto(p) {
    var ini = promocaoDataCompacta(p.inicio);
    var fim = promocaoDataCompacta(p.fim);
    if (ini && fim) return ini + " – " + fim;
    if (fim) return "até " + fim;
    if (ini) return "desde " + ini;
    return "";
  }

  // Vocabulário por FORMA (mesma régua do resto da Fundação, ver .vf-status)
  // além de cor: ATIVA (bolinha cheia) · NÃO APLICADA (losango — started mas
  // não é a que define o preço atual) · PROGRAMADA (círculo azul) · ELEGÍVEL
  // (contorno vazio). Chave é statusExibicao (backend), nunca o status bruto
  // do ML — só o backend sabe qual promoção o sale_price aponta como ATIVA.
  var PROMO_STATUS_CLASSE = { "ATIVA": "is-success", "NÃO APLICADA": "is-warning", "PROGRAMADA": "is-info", "ELEGÍVEL": "is-empty" };
  function promocaoStatusClasse(statusExibicao) { return PROMO_STATUS_CLASSE[statusExibicao] || "is-empty"; }

  // Coluna "Subsídio ML" — só informativa (não alimenta motor de margem/
  // simulação, nunca é usada em "Você recebe"). Vem pronta do backend
  // (meliPromocoesService: original_price*(meli_percentage/100) — fórmula
  // validada pela tela "Promoções com Retorno ML", server/services/
  // automacoes/promocoesRetornoService.js. Nome do campo mantido por
  // compatibilidade; semanticamente é "Retorno ML", não uma redução de
  // tarifa/comissão). "—" quando falta original_price ou meli_percentage.
  function promocaoSubsidioMlHtml(p, moeda) {
    if (p.subsidioMl == null) {
      return '<span class="am-promo__subsidio am-promo__subsidio--vazio">—</span>';
    }
    return '<span class="am-promo__subsidio">' + formatMoeda(p.subsidioMl, moeda) + "</span>";
  }

  function promocaoDescontoHtml(p, moeda) {
    if (p.descontoReais == null || p.descontoPercentual == null) {
      return '<span class="am-promo__desconto am-promo__desconto--vazio">Sem sugestão do Mercado Livre</span>';
    }
    return '<span class="am-promo__desconto">' + formatMoeda(p.descontoReais, moeda) +
      ' <span class="am-promo__desconto-pct">(' + formatarPercentualCompacto(p.descontoPercentual) + ")</span></span>";
  }

  // "Preço final": mostra o override de simulação quando ESTA linha é a
  // selecionada; senão o valor que o próprio ML devolveu (real quando
  // ativa/agendada, sugerido quando candidata — pode ser null, nunca
  // inventado, ver meliPromocoesService).
  function precoFinalExibidoDaLinha(p, itemId) {
    var sim = DET && DET.itemId === itemId ? DET.simulacaoMargem : null;
    if (sim && DET.promoLinhaSelecionada === promocaoChave(p) && sim.preco != null) return sim.preco;
    return p.precoFinal;
  }

  // Auto-preenchida ao abrir o modal (backend: ctrl.anexarVoceRecebe, mesmo
  // Motor de .../simular-margem, price=precoFinal + rebate=subsidioMl) —
  // "Simular" só existe pra alterações manuais; quando a linha está com uma
  // simulação ativa, ela sempre tem prioridade sobre o valor auto-preenchido.
  function promocaoVoceRecebeHtml(p) {
    var sim = DET && DET.simulacaoMargem;
    var selecionada = !!(sim && DET.promoLinhaSelecionada === promocaoChave(p) && sim.preco != null);
    if (selecionada) {
      if (!sim.resultado) return '<span class="am-promo__recebe am-promo__recebe--vazio">Simulando…</span>';
      var r = sim.resultado;
      if (!r.computable) return '<span class="am-promo__recebe am-promo__recebe--vazio">Sem dados suficientes</span>';
      return '<span class="am-promo__recebe">' + formatMoeda(r.profit, DET.anuncio.moeda) +
        (r.marginPercent != null
          ? ' <span class="am-promo__recebe-pct">(' + formatarPercentualCompacto(r.marginPercent) + ")</span>"
          : "") +
      "</span>";
    }
    if (!p.voceRecebe) return '<span class="am-promo__recebe am-promo__recebe--vazio">—</span>';
    if (!p.voceRecebe.computable) return '<span class="am-promo__recebe am-promo__recebe--vazio">Sem dados suficientes</span>';
    return '<span class="am-promo__recebe">' + formatMoeda(p.voceRecebe.profit, DET.anuncio.moeda) +
      (p.voceRecebe.marginPercent != null
        ? ' <span class="am-promo__recebe-pct">(' + formatarPercentualCompacto(p.voceRecebe.marginPercent) + ")</span>"
        : "") +
    "</span>";
  }

  // Escopo desta v1 (decisão de produto, ver auditoria de
  // documentacao_api_meli/*, mesmo escopo do backend — meliPromocoesEscritaService.
  // TIPOS_COM_ESCRITA): só DEAL e SELLER_CAMPAIGN têm um contrato de escrita
  // simétrico (POST participa/PUT altera) com preço escolhido pelo vendedor.
  // Todos os outros tipos continuam só simulação — o backend recusaria a
  // escrita mesmo que o botão tentasse, mas a UI já não oferece a opção pra
  // não sugerir uma ação que vai falhar.
  var PROMO_TIPOS_COM_ESCRITA = { DEAL: true, SELLER_CAMPAIGN: true };
  function promocaoSuportaEscrita(p) { return !!PROMO_TIPOS_COM_ESCRITA[p.tipo]; }

  // Verdadeiro quando ESTA linha já tem uma simulação de preço pendente
  // (mesmo sinal usado por precoFinalExibidoDaLinha/promocaoVoceRecebeHtml)
  // — é o que muda "Participar"/"Alterar" para "Confirmar participação"/
  // "Confirmar alteração".
  function promocaoJaSimulada(p, itemId) {
    var sim = DET && DET.itemId === itemId ? DET.simulacaoMargem : null;
    return !!(sim && DET.promoLinhaSelecionada === promocaoChave(p) && sim.preco != null);
  }

  // Rótulo por STATUS BRUTO do ML e por TIPO (decisão de produto revisada —
  // ver auditoria). A decisão NÃO usa mais statusExibicao sozinho:
  // statusExibicao só diz qual promoção está formando o preço AGORA, não se
  // o vendedor já participa dela. Uma promoção "started"/"active" já foi
  // aceita pelo vendedor e pode ser alterada de verdade — mesmo quando
  // statusExibicao é NÃO APLICADA (não é a que está formando o preço atual
  // neste momento).
  //  - tipo fora do escopo de escrita (nesta v1): sempre "Simular" — o botão
  //    nunca vai além de selecionar + simular, em qualquer status.
  //  - tipo com escrita, status "pending" (PROGRAMADA — ainda não começou):
  //    sempre "Simular", nunca escreve.
  //  - tipo com escrita, status "started"/"active" (já participada, ATIVA ou
  //    NÃO APLICADA): "Alterar", ainda não simulado; "Confirmar alteração",
  //    já simulado nesta linha — o próximo clique abre o diálogo de
  //    confirmação (ver bindPromocoesAcoes/abrirConfirmacaoPromocao). Se a
  //    promoção tem subsidioMl (retorno ML/rebate), o botão continua
  //    "Alterar" normalmente — o bloqueio (aviso, sem PUT) acontece só ao
  //    confirmar, dentro de abrirConfirmacaoPromocao.
  //  - tipo com escrita, status "candidate" (ELEGÍVEL): "Participar", ainda
  //    não simulado; "Confirmar participação", já simulado — fluxo normal
  //    de POST, nunca afetado pelo bloqueio de rebate acima.
  function promocaoJaParticipada(p) {
    return p.status === "started" || p.status === "active";
  }
  function promocaoPodeEscrever(p) {
    return promocaoJaParticipada(p) || p.status === "candidate";
  }
  function promocaoTarefaRotulo(p, itemId) {
    if (!promocaoSuportaEscrita(p) || !promocaoPodeEscrever(p)) return "Simular";
    var jaParticipada = promocaoJaParticipada(p);
    if (promocaoJaSimulada(p, itemId)) return jaParticipada ? "Confirmar alteração" : "Confirmar participação";
    return jaParticipada ? "Alterar" : "Participar";
  }

  function promocaoLinhaHtml(p, itemId, moeda) {
    var precoExibido = precoFinalExibidoDaLinha(p, itemId);
    var chave = promocaoChave(p);
    var precoCel = '<span class="am-margem-comp__valor am-margem-edit am-promo__preco" ' +
      'data-margem-item="' + escapeAttr(itemId) + '" data-margem-campo="preco" ' +
      'data-promo-key="' + escapeAttr(chave) + '" ' +
      'data-margem-valor="' + escapeAttr(precoExibido == null ? "" : precoExibido) + '">' +
      botaoMargemEditHtml(formatMoeda(precoExibido, moeda), "Simular — não grava no Mercado Livre nem inscreve na promoção") +
    "</span>";

    var periodo = promocaoPeriodoTexto(p);
    return '<tr class="am-promo__linha" data-promo-key="' + escapeAttr(chave) + '">' +
      '<td class="am-promo__col-nome">' +
        '<div class="am-promo__nome">' + escapeHtml(p.nome || p.tipoLabel) + "</div>" +
        '<div class="am-promo__meta">' +
          (periodo ? escapeHtml(periodo) + " · " : "") +
          '<span class="vf-status ' + promocaoStatusClasse(p.statusExibicao) + '">' + escapeHtml(p.statusExibicao) + "</span>" +
        "</div>" +
      "</td>" +
      '<td>' + promocaoDescontoHtml(p, moeda) + "</td>" +
      '<td>' + precoCel + "</td>" +
      '<td>' + promocaoSubsidioMlHtml(p, moeda) + "</td>" +
      '<td>' + promocaoVoceRecebeHtml(p) + "</td>" +
      '<td><button type="button" class="vf-btn vf-btn--ghost vf-btn--sm am-promo__acao" ' +
        'data-acao="promo-acao" data-promo-key="' + escapeAttr(chave) + '">' +
        promocaoTarefaRotulo(p, itemId) + "</button></td>" +
    "</tr>";
  }

  function promocoesTabelaHtml(lista, itemId, moeda) {
    var linhas = lista.map(function (p) { return promocaoLinhaHtml(p, itemId, moeda); }).join("");
    return '<div class="am-promo__scroll"><table class="am-promo__tabela">' +
      "<thead><tr><th>Promoção</th><th>Desconto</th><th>Preço final</th><th>Subsídio ML</th><th>Você recebe</th><th>Tarefas</th></tr></thead>" +
      "<tbody>" + linhas + "</tbody>" +
    "</table></div>";
  }

  function promocoesCorpoHtml(itemId, moeda) {
    var cache = AM.state.promocoesCache[itemId];
    if (!cache) return promocoesDicaHtml("Carregando promoções…");
    if (!cache.ok) return promocoesDicaHtml("Não foi possível carregar as promoções deste anúncio agora.");
    if (!cache.promocoes.length) return promocoesDicaHtml("Nenhuma promoção disponível para este anúncio no momento.");
    return promocoesTabelaHtml(cache.promocoes, itemId, moeda);
  }

  // Seção NÃO recolhível (ao contrário da composição da margem): a tabela já
  // nasce visível, lado a lado com a composição (ver .am-det-margem-grid no
  // CSS) — só o CONTEÚDO troca de "Carregando…" para a tabela quando a
  // resposta chega, sem exigir um clique extra do operador.
  function promocoesSecaoHtml(itemId, moeda) {
    return '<div class="am-det-section am-promo" id="am-det-promo" data-item="' + escapeAttr(itemId) + '">' +
      '<div class="am-det-section__head">' +
        '<h3 class="am-det-section__title">Promoções disponíveis</h3>' +
      "</div>" +
      '<div class="am-promo__body" id="am-det-promo-body">' + promocoesCorpoHtml(itemId, moeda) + "</div>" +
    "</div>";
  }

  function repintarPromocoesDoItem(itemId) {
    if (!DET || DET.itemId !== itemId || !DET.anuncio) return;
    var corpo = el("am-det-promo-body");
    if (!corpo) return;
    corpo.innerHTML = promocoesCorpoHtml(itemId, DET.anuncio.moeda);
    bindMargemEditavel(corpo);
    bindPromocoesAcoes(corpo, itemId);
  }

  // "Alterar"/"Participar": primeiro clique NUNCA grava nada no Mercado
  // Livre — só seleciona a linha e aplica o preço final dela (real quando já
  // ativa, sugerido quando candidata) na MESMA simulação de margem de
  // sempre. Quando o ML não deu preço nenhum para aquela linha (candidate
  // sem sugestão), só seleciona e abre o editor da célula para o operador
  // digitar um valor — nunca inventa um número.
  //
  // "Confirmar participação"/"Confirmar alteração": só aparece (ver
  // promocaoTarefaRotulo) depois desse primeiro clique, e só para
  // DEAL/SELLER_CAMPAIGN (promocaoSuportaEscrita) — abre o diálogo de
  // confirmação e só ESCREVE de verdade no clique em "Confirmar" dentro
  // dele (ver abrirConfirmacaoPromocao/aplicarPromocaoReal).
  function bindPromocoesAcoes(raiz, itemId) {
    (raiz || document).querySelectorAll('[data-acao="promo-acao"]').forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!DET || DET.itemId !== itemId) return;
        var chave = btn.getAttribute("data-promo-key");
        var linha = promocaoPorChave(itemId, chave);
        if (!linha) return;

        if (promocaoSuportaEscrita(linha) && promocaoPodeEscrever(linha) && promocaoJaSimulada(linha, itemId)) {
          abrirConfirmacaoPromocao(itemId, linha);
          return;
        }

        // "Selecionar a promoção" é incondicional (ver instrução de
        // produto); só o "aplicar preço sugerido" depende de o ML ter
        // devolvido um preço utilizável para esta linha.
        DET.promoLinhaSelecionada = chave;

        if (linha.precoFinal != null) {
          DET.simulacaoMargem.preco = linha.precoFinal;
          repintarPromocoesDoItem(itemId);
          dispararSimulacaoMargem(itemId);
          return;
        }

        repintarPromocoesDoItem(itemId);
        var cel = document.querySelector(
          '#am-det-promo-body [data-promo-key="' + chave + '"] .am-promo__preco'
        );
        if (cel) abrirEditorMargemCampo(cel);
      });
    });
  }

  // Defesa em profundidade (MESMA régua do gate em bindPromocoesAcoes,
  // tipo + status): só tipo com contrato de escrita nesta v1 (DEAL/
  // SELLER_CAMPAIGN — ver promocaoSuportaEscrita/PROMO_TIPOS_COM_ESCRITA) E
  // já-participada (Alterar) ou candidate (Participar) podem abrir este
  // diálogo — uma PROGRAMADA (pending) nunca chega a escrever, e um tipo fora
  // do escopo (SMART, PRICE_DISCOUNT, PRE_NEGOTIATED, PRICE_MATCHING,
  // LIGHTNING, ...) nunca chega a escrever mesmo se já participado
  // (started/active), mesmo se esta função for chamada de outro lugar no
  // futuro.
  function abrirConfirmacaoPromocao(itemId, linha) {
    if (!DET || DET.itemId !== itemId) return;
    if (!promocaoSuportaEscrita(linha) || !promocaoPodeEscrever(linha)) return;
    var sim = DET.simulacaoMargem;
    if (!sim || sim.preco == null) return;

    var jaParticipada = promocaoJaParticipada(linha);

    // Promoção "started"/"active" com retorno ML (subsidioMl != null): o
    // Mercado Livre já participa financeiramente dela, e a escrita de
    // "alterar" (PUT) para esse tipo ainda não está disponível (ver
    // auditoria). Mostra o aviso e para aqui — aplicarPromocaoReal (o único
    // lugar que chama POST/PUT real) nunca chega a ser referenciado neste
    // caminho, então nenhuma escrita pode ocorrer. Nunca afeta "Participar"
    // (candidate): o bloqueio é só para alteração de uma participação já
    // existente.
    if (jaParticipada && linha.subsidioMl != null) {
      toast(
        "Esta promoção possui participação do Mercado Livre (rebate). A alteração de valores ainda não está disponível para este tipo de promoção.",
        "is-warning"
      );
      return;
    }

    var moeda = DET.anuncio.moeda;
    var margemSimulada = (sim.resultado && sim.resultado.computable && sim.resultado.marginPercent != null)
      ? formatarPercentualCompacto(sim.resultado.marginPercent) : "—";

    abrirConfirmacaoEscrita({
      titulo: jaParticipada ? "Alterar participação na promoção" : "Participar da promoção",
      textoConfirmar: "Confirmar",
      linhas: [
        { rotulo: "Promoção", valor: linha.nome || linha.tipoLabel },
        { rotulo: "Preço atual", valor: formatMoeda(linha.precoOriginal, moeda) },
        { rotulo: "Novo preço", valor: formatMoeda(sim.preco, moeda) },
        { rotulo: "Impacto estimado na margem", valor: margemSimulada },
      ],
      aoConfirmar: function (concluir) { aplicarPromocaoReal(itemId, linha, sim.preco, concluir); },
    });
  }

  // Nunca chamada fora do "Confirmar" do diálogo acima. O backend relê o
  // estado AO VIVO da promoção antes de decidir POST (participar) x PUT
  // (alterar) — nunca confia no status que esta tela guardou em cache (ver
  // meliPromocoesEscritaService).
  function aplicarPromocaoReal(itemId, linha, precoNovo, concluir) {
    var corpo = { clienteSlug: AM.clienteAtual.slug, precoNovo: precoNovo };
    if (AM.contaMlId) corpo.clienteContaId = AM.contaMlId;

    var meuToken = DET ? DET.token : null;
    api(
      "/anuncios-meli/" + encodeURIComponent(itemId) + "/promocoes/" + encodeURIComponent(linha.id) + "/aplicar",
      { method: "POST", body: corpo }
    ).then(function (r) {
      if (!DET || DET.token !== meuToken) { concluir(); return; } // modal fechado, ou outro MLB no meio do caminho
      var d = r.data || {};
      if (!d.ok) {
        concluir(d.motivo || "Não foi possível aplicar a promoção.");
        return;
      }

      // A promoção pode ter mudado de status (candidate -> started) e de
      // preço — descarta o cache e relê do zero, nunca assume o que foi
      // enviado.
      DET.simulacaoMargem = { custoProduto: null, custosAdicionais: null, preco: null, resultado: null };
      DET.promoLinhaSelecionada = null;
      delete AM.state.promocoesCache[itemId];

      garantirPromocoesDoItem(itemId).then(function () {
        if (!DET || DET.token !== meuToken) return;
        repintarPromocoesDoItem(itemId);
      });
      toast(d.metodo === "POST" ? "Participação confirmada no Mercado Livre." : "Promoção alterada no Mercado Livre.");
      concluir();
    });
  }

  // ---------------------------------------------------------------------------
  // Barra de alterações pendentes — o único caminho de escrita no anúncio
  // ---------------------------------------------------------------------------
  function renderSavebar() {
    var slot = el("am-det-savebar-slot");
    if (!slot || !DET) return;
    var sujos = camposSujos();

    if (DET.confirmandoSaida) {
      slot.innerHTML =
        '<div class="am-det-savebar is-perigo" id="am-det-savebar" role="alert">' +
          '<span class="am-det-savebar__msg"><span class="am-det-dot"></span>' +
            "Fechar e descartar " + sujos.length + " alteraç" + (sujos.length === 1 ? "ão" : "ões") +
            " — " + sujos.map(function (c) { return c.rotulo; }).join(", ") + "?</span>" +
          '<span class="am-det-savebar__actions">' +
            '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-acao="cancelar-saida">Continuar editando</button>' +
            '<button type="button" class="vf-btn vf-btn--danger vf-btn--sm" data-acao="descartar-e-fechar">Descartar e fechar</button>' +
          "</span>" +
        "</div>";
      return;
    }

    if (!sujos.length) { slot.innerHTML = ""; return; }

    if (DET.salvando) {
      slot.innerHTML =
        '<div class="am-det-savebar" id="am-det-savebar" aria-live="polite">' +
          '<span class="am-det-savebar__msg"><span class="vf-spinner" aria-hidden="true"></span>' +
            "Salvando no Mercado Livre…</span>" +
          '<span class="am-det-savebar__actions">' +
            '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" disabled>Descartar tudo</button>' +
            '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm is-loading" disabled>Salvando…</button>' +
          "</span>" +
        "</div>";
      return;
    }

    var erros = Object.keys(DET.erros);
    if (erros.length) {
      slot.innerHTML =
        '<div class="am-det-savebar is-perigo" id="am-det-savebar" role="alert">' +
          '<span class="am-det-savebar__msg"><span class="am-det-dot"></span>' +
            escapeHtml(DET.erros[erros[0]]) + "</span>" +
          '<span class="am-det-savebar__actions">' +
            '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-acao="descartar">Descartar tudo</button>' +
            '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-acao="salvar">Tentar de novo</button>' +
          "</span>" +
        "</div>";
      return;
    }

    slot.innerHTML =
      '<div class="am-det-savebar" id="am-det-savebar" aria-live="polite">' +
        '<span class="am-det-savebar__msg"><span class="am-det-dot"></span>' +
          sujos.length + " alteraç" + (sujos.length === 1 ? "ão não salva" : "ões não salvas") +
          " — " + sujos.map(function (c) { return c.rotulo; }).join(", ") + "</span>" +
        '<span class="am-det-savebar__actions">' +
          '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-acao="descartar">Descartar tudo</button>' +
          '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-acao="salvar">Salvar alterações</button>' +
        "</span>" +
      "</div>";
  }

  // Atualizações leves (sem re-render): contadores, chips, espelhos e reverts.
  function aplicarEstadosEdicao() {
    if (!DET || !DET.carregado) return;

    var cTitulo = el("am-det-count-titulo");
    if (cTitulo) cTitulo.textContent = DET.rascunho.titulo.length + "/60 caracteres";
    var cEspelho = el("am-det-count-espelho-titulo");
    if (cEspelho) cEspelho.textContent = DET.rascunho.titulo.length + "/60 caracteres";
    var cDesc = el("am-det-count-descricao");
    if (cDesc) cDesc.textContent = String(DET.rascunho.descricao.length);

    // Título e Modelo têm DOIS inputs cada (cabeçalho/Catálogo + coluna
    // "Atual" da comparação com a IA) sobre o MESMO rascunho: quem não está
    // sendo digitado acompanha. Só escreve quando difere — nunca mexe no
    // cursor de quem está com o foco.
    ["am-det-titulo", "am-det-espelho-titulo"].forEach(function (id) {
      var e = el(id);
      if (e && e.value !== DET.rascunho.titulo) e.value = DET.rascunho.titulo;
    });
    ["am-det-modelo", "am-det-espelho-modelo"].forEach(function (id) {
      var e = el(id);
      if (e && e.value !== DET.rascunho.modelo) e.value = DET.rascunho.modelo;
    });

    ["titulo", "modelo", "descricao"].forEach(function (chave) {
      var sujo = campoSujo(chave);
      var chip = el("am-det-dirty-" + chave);
      if (chip) chip.hidden = !sujo;
      var revert = el("am-det-revert-" + chave);
      if (revert) revert.hidden = !sujo;
    });

    var wrapT = el("am-det-title-wrap");
    if (wrapT) wrapT.classList.toggle("is-dirty", campoSujo("titulo"));
    var wrapM = el("am-det-modelo-wrap");
    if (wrapM) wrapM.classList.toggle("is-dirty", campoSujo("modelo"));
    var espT = el("am-det-espelho-titulo");
    if (espT) espT.classList.toggle("is-dirty", campoSujo("titulo"));
    var espM = el("am-det-espelho-modelo");
    if (espM) espM.classList.toggle("is-dirty", campoSujo("modelo"));
    var wrapD = el("am-det-editable-descricao");
    if (wrapD) wrapD.classList.toggle("is-dirty", campoSujo("descricao"));

    renderSavebar();
  }

  function bindCamposEditaveis() {
    // Cabeçalho/Catálogo e coluna "Atual" da comparação com a IA: mesmo
    // handler, mesmo rascunho (ver tituloEModeloHtml).
    [["am-det-titulo", "titulo"], ["am-det-espelho-titulo", "titulo"],
     ["am-det-modelo", "modelo"], ["am-det-espelho-modelo", "modelo"]].forEach(function (par) {
      var campo = el(par[0]);
      if (!campo) return;
      campo.addEventListener("input", function () {
        DET.rascunho[par[1]] = this.value;
        DET.erros = {};
        aplicarEstadosEdicao();
      });
    });
    var desc = el("am-det-descricao");
    if (desc) desc.addEventListener("input", function () {
      DET.rascunho.descricao = this.value;
      DET.descricaoOrigem = null;
      DET.descricaoOrigemHora = null;
      DET.erros = {};
      aplicarEstadosEdicao();
      atualizarChipUsada();
    });
  }

  // Estado do chip "Usada nesta edição" desenhado agora na tela. Sem esta
  // guarda, cada tecla digitada na descrição reconstruía a coluna da IA
  // inteira; com ela, a coluna só é redesenhada quando o chip realmente vira.
  var chipUsadaAtual = null;
  function atualizarChipUsada() {
    // A origem ("preenchida a partir da sugestão da IA às …") muda nos mesmos
    // momentos (usar, digitar, reverter) e só era desenhada no render inteiro.
    var origem = el("am-det-desc-origem");
    if (origem) origem.textContent = origemDescricao();
    if (descricaoSugeridaUsada() === chipUsadaAtual) return;
    repintarDescricao();
  }

  function descartarTudo() {
    if (!DET) return;
    DET.rascunho = {
      titulo: DET.original.titulo,
      modelo: DET.original.modelo,
      descricao: DET.original.descricao,
    };
    DET.erros = {};
    DET.descricaoOrigem = null;
    DET.descricaoOrigemHora = null;
    DET.confirmandoSaida = false;
    renderDetalhe();
    toast("Alterações descartadas.");
  }

  function reverterCampo(chave) {
    if (!DET) return;
    DET.rascunho[chave] = DET.original[chave];
    delete DET.erros[chave];
    if (chave === "descricao") { DET.descricaoOrigem = null; DET.descricaoOrigemHora = null; }
    var input = el("am-det-" + chave);
    if (input) input.value = DET.rascunho[chave];
    aplicarEstadosEdicao();
    if (chave === "descricao") atualizarChipUsada();
  }

  function usarSugestao(chave, texto) {
    if (!DET || texto == null) return;
    DET.rascunho[chave] = String(texto);
    DET.erros = {};
    if (chave === "descricao") {
      DET.descricaoOrigem = "ia";
      DET.descricaoOrigemHora = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    }
    var input = el("am-det-" + chave);
    if (input) { input.value = DET.rascunho[chave]; input.focus(); }
    aplicarEstadosEdicao();
    if (chave === "descricao") atualizarChipUsada();
    toast("Sugestão aplicada ao campo. Use “Salvar alterações” para publicar no Mercado Livre.");
  }

  // Recusa de um campo, com o motivo REAL do Mercado Livre: explicação
  // amigável (quando o backend reconhece a recusa) + a mensagem original e o
  // código que o ML mandou. A mensagem crua do ML nunca é descartada — é ela
  // que permite conferir o motivo sem adivinhar.
  function mensagemFalhaCampo(c, res) {
    var artigo = c.chave === "descricao" ? "da descrição" : (c.chave === "modelo" ? "do modelo" : "do título");
    var det = res.detalhesMl || null;
    var original = det ? (det.causas && det.causas.length && det.causas[0].message) || det.error || det.message : null;
    // O formato atípico do título manda o código genérico em `message` e a
    // frase em `error` — a frase é a que explica.
    if (det && det.message && det.error && /^[A-Z0-9_]+$/.test(det.message)) original = det.error;
    var partes = ["Não foi possível salvar a alteração " + artigo + " deste anúncio."];
    if (res.explicacao) {
      partes.push("Motivo informado pelo Mercado Livre: " + res.explicacao);
      if (original) partes.push("Resposta original: “" + original + "”.");
    } else {
      partes.push("Motivo informado pelo Mercado Livre: " + (res.motivo || original || "o Mercado Livre recusou a alteração."));
    }
    if (res.codigo && !/^ML_HTTP_/.test(res.codigo)) partes.push("Código: " + res.codigo + ".");
    else if (det && det.status) partes.push("HTTP " + det.status + ".");
    return partes.join(" ");
  }

  // ---------------------------------------------------------------------------
  // Salvar — Portal → backend → ClienteConta → grant → API do ML → confirmação
  // ---------------------------------------------------------------------------
  function salvarAlteracoes() {
    if (!DET || DET.salvando) return;
    var sujos = camposSujos();
    if (!sujos.length) return;

    var corpo = { clienteSlug: AM.clienteAtual.slug };
    if (AM.contaMlId) corpo.clienteContaId = AM.contaMlId;
    sujos.forEach(function (c) { corpo[c.chave] = DET.rascunho[c.chave]; });

    DET.salvando = true;
    DET.erros = {};
    renderSavebar();

    var meuToken = DET.token;
    var itemId = DET.anuncio.item_id;

    api("/anuncios-meli/" + encodeURIComponent(itemId) + "/conteudo", {
      method: "PATCH",
      body: corpo,
    }).then(function (r) {
      if (!DET || DET.token !== meuToken) return; // o modal já é de outro anúncio/conta
      DET.salvando = false;
      var d = r.data || {};

      if (!d.resultados) {
        DET.erros = { geral: (d.motivo || "Não foi possível salvar as alterações.") };
        renderSavebar();
        toast(DET.erros.geral, "is-danger");
        return;
      }

      // Só o que o Mercado Livre CONFIRMOU vira "salvo".
      var falhas = [];
      CAMPOS_EDITAVEIS.forEach(function (c) {
        var res = d.resultados[c.chave];
        if (!res) return;
        if (res.ok) {
          DET.original[c.chave] = DET.rascunho[c.chave];
        } else {
          var msgFalha = mensagemFalhaCampo(c, res);
          falhas.push(msgFalha);
          DET.erros[c.chave] = msgFalha;
        }
      });

      if (d.descricaoEstado) {
        DET.descricao = d.descricao || null;
        DET.descricaoEstado = d.descricaoEstado;
        DET.descricaoErro = d.descricaoErro || null;
      }
      if (d.anuncio) {
        DET.anuncio = d.anuncio;
        AM.detalheAtual = { anuncio: d.anuncio, descricao: DET.descricao };
      }

      renderDetalhe();

      if (!falhas.length) {
        toast("Alterações salvas no anúncio do Mercado Livre.", "is-success");
        carregarAnuncios(); // o título/modelo mudou: a listagem atrás precisa refletir
      } else {
        toast(falhas[0], "is-danger");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Delegação de eventos do modal
  // ---------------------------------------------------------------------------
  function onCliqueDetalhe(e) {
    var alvo = e.target.closest("[data-acao]");
    if (!alvo || !DET) return;
    var acao = alvo.getAttribute("data-acao");

    if (acao === "fechar") { e.preventDefault(); fecharDetalhe(); return; }
    if (acao === "cancelar-saida") { DET.confirmandoSaida = false; renderSavebar(); return; }
    if (acao === "descartar-e-fechar") { fecharDetalhe(true); return; }
    if (acao === "descartar") { descartarTudo(); return; }
    if (acao === "salvar") { salvarAlteracoes(); return; }
    if (acao === "foto-grupo") { selecionarGrupoFotos(Number(alvo.getAttribute("data-idx"))); return; }
    if (acao === "foto-recarregar") { carregarFotos(true); renderFotos(); return; }
    if (acao === "foto-escolher") { var inpFoto = el("am-det-img-input"); if (inpFoto && !alvo.disabled) inpFoto.click(); return; }
    if (acao === "foto-remover") { removerFoto(Number(alvo.getAttribute("data-idx"))); return; }
    if (acao === "foto-desfazer") { desfazerFoto(Number(alvo.getAttribute("data-idx"))); return; }
    if (acao === "foto-descartar") { descartarFotos(); return; }
    if (acao === "foto-salvar") { salvarFotosNoMl(null); return; }
    if (acao === "foto-pendente-salvar") { if (DET && DET.fotos) salvarFotosNoMl(DET.fotos.pendente); return; }
    if (acao === "foto-pendente-descartar") {
      var pendFoto = DET && DET.fotos && DET.fotos.pendente;
      if (!pendFoto) return;
      if (pendFoto.tipo === "fechar") { fecharDetalhe(true); return; }
      novoRascunho(pendFoto.destino);
      renderFotos();
      return;
    }
    if (acao === "foto-pendente-cancelar") {
      if (DET && DET.fotos) { DET.fotos.pendente = null; renderFotos(); }
      return;
    }
    if (acao === "img-escolher") { var inp = el("am-det-img-input"); if (inp && !alvo.disabled) inp.click(); return; }
    if (acao === "img-enviar") { enviarImagem(); return; }
    if (acao === "img-cancelar") { cancelarImagem(); return; }
    if (acao === "reverter") { reverterCampo(alvo.getAttribute("data-campo")); return; }
    if (acao === "focar") {
      var campo = el("am-det-" + alvo.getAttribute("data-campo"));
      if (campo) { campo.focus(); campo.select(); }
      return;
    }
    if (acao === "revisar") { alternarRevisao(alvo); return; }
    if (acao === "gerar-titulos") { gerarTitulos(); return; }
    if (acao === "usar-titulo") { usarTitulo(Number(alvo.getAttribute("data-idx"))); return; }
    if (acao === "gerar-descricao") { gerarDescricao(); return; }
    if (acao === "usar-descricao") { usarDescricao(); return; }
    if (acao === "gerar") { gerar(alvo.getAttribute("data-tipo")); return; }
    if (acao === "copiar") { copiarTexto(textoDaFonte(alvo)); return; }
    if (acao === "copiar-ficha") { copiarFichaSugerida(); return; }
    if (acao === "usar-sugestao") {
      usarSugestao(alvo.getAttribute("data-campo"), textoDaFonte(alvo));
      return;
    }
    if (acao === "aprovar-ficha") { aprovarFicha(); return; }
  }

  // Textos vivem no estado, não em atributos — assim quebra de linha e aspas
  // da descrição não precisam sobreviver a uma viagem pelo HTML.
  function textoDaFonte(botao) {
    var fonte = botao.getAttribute("data-fonte");
    if (fonte === "descricao-sugerida") return DET.descricaoSeo.estado === "ok" ? DET.descricaoSeo.texto : "";
    if (fonte === "descricao-atual") return DET.rascunho.descricao;
    if (fonte === "titulo-atual") return DET.rascunho.titulo;
    if (fonte === "modelo-atual") return DET.rascunho.modelo;
    return "";
  }

  function alternarRevisao(btn) {
    var a = DET.anuncio;
    var novo = !a.revisado;
    btn.disabled = true;
    api("/anuncios-meli/" + encodeURIComponent(a.item_id) + "/revisao", {
      method: "PATCH",
      body: { clienteSlug: AM.clienteAtual.slug, revisado: novo },
    }).then(function (r) {
      if (!DET) return;
      btn.disabled = false;
      if (r.data && r.data.ok) {
        a.revisado = novo;
        var chip = el("am-det-revisado-chip");
        if (chip) {
          chip.innerHTML = novo
            ? '<span class="vf-status is-success">Revisado</span>'
            : '<span class="vf-status is-empty">Não revisado</span>';
        }
        btn.innerHTML = icCheck(12) + (novo ? "Desmarcar revisão" : "Marcar como revisado");
        carregarAnuncios();
        toast(novo ? "Anúncio marcado como revisado." : "Revisão desmarcada.");
      } else {
        toast((r.data && r.data.motivo) || "Não foi possível atualizar a revisão.", "is-danger");
      }
    });
  }

  // ===========================================================================
  // Histórico de otimizações — alimenta as colunas "Sugestão da IA"
  // ===========================================================================
  function carregarHistoricoOtimizacoes(itemId, meuToken) {
    var url = "/anuncios-meli/" + encodeURIComponent(itemId) +
              "/otimizacoes?clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug) +
              (AM.contaMlId ? "&clienteContaId=" + encodeURIComponent(AM.contaMlId) : "");
    api(url).then(function (r) {
      if (!DET || DET.token !== meuToken) return;
      // 403 = otimizador ainda é admin-only. Não é o modal quebrado: o resto
      // do detalhe funciona e a região de IA diz por que está vazia (F-02).
      if (r.status === 403) {
        DET.iaBloqueada = true;
        renderDetalhe();
        return;
      }
      if (!r.data || !r.data.ok) return;
      var porTipo = { seo: null, descricao: null, ficha_tecnica: null };
      (r.data.otimizacoes || []).forEach(function (o) {
        if (porTipo[o.tipo] === null) porTipo[o.tipo] = o;
      });
      AM.otimizacoes = porTipo;
      renderSecoesIa();
    });
  }

  // Redesenha só as colunas da IA e seus chips — o que o usuário está
  // editando à esquerda não é tocado.
  function renderSecoesIa() {
    if (!DET || !DET.carregado) return;
    var attrs = tryParseJSON(DET.anuncio.attributes_json, []) || [];
    var alvos = [
      ["am-det-sug-titulo", function () { return sugestaoTitulosHtml(); }],
      ["am-det-sug-descricao", function () { return sugestaoDescricaoHtml(); }],
      ["am-det-sug-ficha", function () { return sugestaoFichaHtml(AM.otimizacoes.ficha_tecnica, attrs); }],
      ["am-det-foot-ficha", function () { return footFichaHtml(AM.otimizacoes.ficha_tecnica, attrs); }],
      ["am-det-status-seo", function () { return chipTitulos(); }],
      ["am-det-status-ficha", function () { return chipOtimizacao("ficha_tecnica", "ficha"); }],
    ];
    alvos.forEach(function (par) {
      var no = el(par[0]);
      if (no) no.innerHTML = par[1]();
    });
  }

  // ===========================================================================
  // Gerar (chama IA) — não altera o anúncio, só produz sugestão
  // ===========================================================================
  function gerar(tipo) {
    if (!DET || !DET.anuncio) return;
    var meuToken = DET.token;
    var a = DET.anuncio;
    var botoes = document.querySelectorAll('[data-acao="gerar"][data-tipo="' + tipo + '"]');
    for (var i = 0; i < botoes.length; i++) {
      botoes[i].disabled = true;
      botoes[i].textContent = "Gerando…";
    }
    marcarChipsIa(tipo, '<span class="vf-status is-info">Consultando IA…</span>');

    // A sugestão é da operação selecionada: o backend confere que o anúncio
    // é desta conta (ClienteConta) antes de chamar a IA.
    var corpoGerar = { clienteSlug: AM.clienteAtual.slug, tipo: tipo };
    if (AM.contaMlId) corpoGerar.clienteContaId = AM.contaMlId;
    api("/anuncios-meli/" + encodeURIComponent(a.item_id) + "/otimizar", {
      method: "POST",
      body: corpoGerar,
    }).then(function (r) {
      if (!DET || DET.token !== meuToken) return;
      if (!r.data || !r.data.ok) {
        var motivo = (r.data && r.data.motivo) || "Erro ao consultar a IA.";
        if (r.status === 403) {
          DET.iaBloqueada = true;
          renderDetalhe();
          return;
        }
        marcarChipsIa(tipo, '<span class="vf-status is-danger">' + escapeHtml(motivo) + "</span>");
        renderSecoesIa();
        toast(motivo, "is-danger");
        return;
      }
      AM.otimizacoes[tipo] = r.data.otimizacao;
      renderSecoesIa();
    });
  }

  function marcarChipsIa(tipo, html) {
    var ids = tipo === "ficha_tecnica" ? ["am-det-status-ficha"] : [];
    ids.forEach(function (id) {
      var no = el(id);
      if (no) no.innerHTML = html;
    });
  }

  // ===========================================================================
  // Aprovação — decisão INTERNA. Não publica nada no Mercado Livre.
  // ===========================================================================
  // A descrição não tem mais "Aprovar" na tela: a sugestão vem do Description
  // Engine (POST /seo/descricao), que não gera registro no otimizador legado.
  // O PATCH /aprovar com descricaoAprovada segue aceito no backend (dívida em
  // CODIGO_LEGADO_AUDITORIA.md).
  function aprovarFicha() {
    var otim = AM.otimizacoes.ficha_tecnica;
    if (!otim) { toast("Gere a sugestão primeiro."); return; }
    var sug = tryParseJSON(otim.ficha_tecnica_sugerida_json, []) || [];
    aprovar(otim.id, { fichaAprovadaJson: sug }, "Sugestões aprovadas (decisão interna).");
  }

  function aprovar(otimId, dados, msgOk) {
    var meuToken = DET ? DET.token : 0;
    // Cliente/conta vão junto: o backend não aprova só pelo id.
    var corpoAprovar = Object.assign({}, dados);
    if (AM.clienteAtual) corpoAprovar.clienteSlug = AM.clienteAtual.slug;
    if (AM.contaMlId) corpoAprovar.clienteContaId = AM.contaMlId;
    api("/anuncios-meli/otimizacoes/" + otimId + "/aprovar", {
      method: "PATCH",
      body: corpoAprovar,
    }).then(function (r) {
      if (!DET || DET.token !== meuToken) return;
      if (r.data && r.data.ok) {
        toast(msgOk || "Aprovado.");
        var o = r.data.otimizacao;
        if (o && AM.otimizacoes[o.tipo] !== undefined) {
          AM.otimizacoes[o.tipo] = o;
          renderSecoesIa();
        }
      } else {
        toast((r.data && r.data.motivo) || "Erro ao aprovar.", "is-danger");
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
    // Sem operação escolhida o Shell nem exibe esta tela (scope="account"):
    // nenhuma guarda de cardinalidade própria aqui (R8).
    if (!AM.clienteAtual) return;
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
      body: { clienteSlug: AM.clienteAtual.slug, modo: modo, clienteContaId: AM.contaMlId || undefined },
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
