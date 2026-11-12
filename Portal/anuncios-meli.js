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
     GET   /anuncios-meli/custos                   (custo da Base por MLB da página)
     POST  /anuncios-meli/custos/lote              (grava custo na Base — pontual e em massa)
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
    // Cards de KPI selecionados como filtros rápidos (V3 — os cards do
    // resumo substituem os antigos <select> de Status/Qualidade). São
    // COMBINÁVEIS (ex.: Ativos + Sem custo + Sem SKU). Guarda só as CHAVES;
    // AM.filtros.status/filtro saem delas pelo mesmo mapa que monta os cards
    // (KPI_DEFS), como listas separadas por vírgula.
    kpisAtivos: [],
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
      // Preço vigente + cheio AO VIVO (só sale_price, GET /precos-ao-vivo) dos
      // filhos das famílias visíveis — pré-carregado em background para a
      // linha-mãe riscar a promoção sem precisar expandir.
      precoAoVivoCache: {},
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
      // Unidades vendidas no período do faturamento (mesma chave do % acima).
      faturamentoUnidadesCache: {},
      faturamentoPrecoMedioCache: {},
      faturamentoEmVoo: {},
      faturamentoPorFamiliaCache: {},
      faturamentoValorPorFamiliaCache: {},
      faturamentoUnidadesPorFamiliaCache: {},
      faturamentoPrecoMedioPorFamiliaCache: {},
      // Período (dias) que a resposta do faturamento disse — o cabeçalho mostra.
      faturamentoPeriodoDias: null,
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

  // MLB dentro de família (User Products): o título é COMPOSTO pelo ML —
  // family_name + a variação ("... Branca Feminina" + "Branco M") — e o PUT
  // de title é recusado. O que se edita no detalhe é o family_name (até 60),
  // que o ML aplica a todas as variações. Publicação de catálogo fica fora:
  // o nome dela é do produto do catálogo. Sem família (MLB avulso), o título
  // continua editável direto.
  function editaNomeDaFamilia(a, familia) {
    return !!(a && a.catalog_listing !== true && familia && familia.family_id);
  }

  // Trava do campo de título NO DETALHE: a de catálogo/família, menos quando
  // o campo passou a ser o nome da família.
  function tituloTravadoNoDetalhe() {
    return !!(DET && !DET.modoFamilia && tituloTravadoPorCatalogo(DET.anuncio));
  }

  // Nota sob o nome do produto: a quem ele vale e o título que o ML publica
  // hoje (nome + variação) — é o que explica um título de 67 caracteres.
  function nomeFamiliaNotaHtml(a) {
    var n = DET && DET.familia ? Number(DET.familia.total_itens) || 0 : 0;
    var alcance = n > 1 ? "vale para os " + n + " anúncios da família" : "vale para a família inteira";
    return '<span class="am-det-title__locknote" id="am-det-title-familia" title="' +
        escapeAttr("O Mercado Livre monta o título de cada variação como nome do produto + variação. " +
          "Título publicado hoje: " + (a.titulo || "—")) + '">' +
        "Nome do produto · " + alcance + " · o Mercado Livre acrescenta a variação</span>";
  }

  function rotuloCampo(c) {
    return c.chave === "titulo" && DET && DET.modoFamilia ? "Nome do produto" : c.rotulo;
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
    // Full usa o logo oficial (raio + FULL) em vez de uma vf-tag: é a marca
    // que o operador já reconhece no Mercado Livre.
    if (a.is_full) badges += '<img class="am-selo-full" src="assets/marketplaces/full.png" alt="Full" title="Full" />';
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
    // Selo compacto: a legenda ("Score muito bom") sai da vista e fica no
    // title + leitor de tela — com tudo em 90 ela não separava anúncio nenhum
    // e era o que mais alargava a coluna.
    return '<div class="am-gauge" title="' + escapeAttr(scoreTxt === "—" ? "Sem Score VenForce" : scoreLegenda(s) + " (" + scoreTxt + ")") + '">' +
      '<div class="am-gauge__wrap">' +
        '<svg viewBox="0 0 64 34" width="64" height="34" aria-hidden="true">' +
          '<path d="M4 32 A28 28 0 0 1 60 32" fill="none" stroke-width="6" stroke-linecap="round" class="am-gauge__track"/>' +
          '<path d="M4 32 A28 28 0 0 1 60 32" fill="none" stroke-width="6" stroke-linecap="round" ' +
            'class="am-gauge__arc ' + classe + '" stroke-dasharray="' + dash + ' 200"/>' +
        "</svg>" +
        '<span class="am-gauge__value ' + classe + '">' + scoreTxt + "</span>" +
      "</div>" +
      '<span class="am-gauge__legenda vf-visually-hidden">' + scoreLegenda(s) + "</span>" +
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
    // Conta a faixa 60–79 (mesmo recorte do filtro). Antes lia `scoreMedio`,
    // a MÉDIA do catálogo — o card dizia 91 e o clique trazia lista vazia.
    { key: "score_medio", label: "Score médio", campo: "scoreFaixaMedia", meta: "De 60 a 79 pontos", estado: "warning", accent: "warning", tipo: "filtro", valor: "score_medio" },
    { key: "score_baixo", label: "Score baixo", campo: "scoreBaixo", meta: "Abaixo de 60 pontos", estado: "danger", accent: "danger", tipo: "filtro", valor: "score_baixo" },
    { key: "mercado_full", label: "Mercado Full", campo: "full", meta: "Com logística Full", estado: "neutral", accent: "info", tipo: "filtro", valor: "mercado_full" },
    { key: "sem_sku", label: "Sem SKU", campo: "semSku", meta: "Sem identificação interna", estado: "danger", accent: "neutral", tipo: "filtro", valor: "sem_sku" },
    // Lê a Base de Custos do contexto do Motor (a mesma da coluna Custo).
    // Sem Base resolvida o número não existe: `semCusto` vem null e o card
    // fica fora, com o motivo no rodapé — nunca um zero enganoso.
    {
      key: "sem_custo", label: "Sem custo", campo: "semCusto", estado: "warning", accent: "warning", tipo: "filtro", valor: "sem_custo",
      meta: function (r) { return typeof r.semCusto === "number" ? "Sem custo na Base" : "Vincule uma Base de Custos"; },
      indisponivel: function (r) { return typeof r.semCusto !== "number"; },
    },
  ];

  function kpiDef(key) {
    for (var i = 0; i < KPI_DEFS.length; i++) if (KPI_DEFS[i].key === key) return KPI_DEFS[i];
    return null;
  }

  // Cards COMBINÁVEIS. Cada card liga/desliga o próprio recorte; o backend
  // combina por E entre eixos diferentes (Ativos E Sem custo E Sem SKU) e
  // por OU dentro do mesmo eixo (Ativos + Pausados = os dois status; Score
  // baixo + Score médio = as duas faixas) — ver meliFamiliaService.
  // predicadosDosFiltros. "Total" limpa tudo.
  function alternarFiltroKpi(key) {
    var def = kpiDef(key);

    if (key === "total" || !def || !def.tipo) {
      AM.kpisAtivos = [];
    } else if (AM.kpisAtivos.indexOf(key) >= 0) {
      AM.kpisAtivos = AM.kpisAtivos.filter(function (k) { return k !== key; });
    } else {
      AM.kpisAtivos = AM.kpisAtivos.concat([key]);
    }
    sincronizarFiltrosDosKpis();
    AM.paginacao.page = 1;
    atualizarIndicadorFiltros();
    renderResumo();
    carregarAnuncios();
  }

  function sincronizarFiltrosDosKpis() {
    var status = [];
    var filtros = [];
    AM.kpisAtivos.forEach(function (key) {
      var def = kpiDef(key);
      if (!def) return;
      if (def.tipo === "status") status.push(def.valor);
      else if (def.tipo === "filtro") filtros.push(def.valor);
    });
    AM.filtros.status = status.join(",");
    AM.filtros.filtro = filtros.join(",");
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
    var total = (AM.filtros.q ? 1 : 0) + AM.kpisAtivos.length;
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
    renderBarraCustos();
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
    resetarCustos();
    // Promoções com rebate: a análise é de UMA conta. O job continua no
    // servidor; aqui só se para de acompanhar.
    if (REB) fecharRebate(true, true);
    if (TRF) fecharTransf(true, true);

    if (!ctx) { AM.clienteAtual = null; AM.contaMlId = ""; atualizarBotaoRebate(); return; }

    AM.clienteAtual = { slug: ctx.slug, nome: ctx.nome };
    AM.contaMlId = ctx.contaId;
    renderBarraCustos();
    garantirCustos([]);
    AM.sync = null;
    AM.resumo = null;
    AM.anuncios = [];
    AM.paginacao.page = 1;
    AM.filtros = { q: "", status: "", filtro: "" };
    AM.kpisAtivos = [];
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
    AM.state.faturamentoUnidadesPorFamiliaCache = {};
    AM.state.faturamentoPrecoMedioPorFamiliaCache = {};
    AM.state.precoAoVivoCache = {};
    AM.familiaEpoca++;
  }

  function bindEventosFixos() {
    bindComparativoMetricas();
    document.addEventListener("vf:context", aplicarContextoDoShell);
    bindCustos(el("am-catalogo-container"));
    bindBarrasCustos();
    if (el("am-reb-abrir")) el("am-reb-abrir").addEventListener("click", abrirRebate);
    if (el("am-transf-abrir")) el("am-transf-abrir").addEventListener("click", abrirTransf);
    // O botão mora no cabeçalho da lista, que é recriado a cada render.
    el("am-catalogo-container").addEventListener("click", function (e) {
      if (e.target.closest("#am-expandir-todos")) alternarTodosGrupos();
    });
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
    // Data que mudou desde o último desenho (mesmo cliente) pisca uma vez:
    // é o retorno visual de que o sync/recálculo atualizou o card.
    var anteriores = AM.hudDatas && AM.hudDatas.slug === c.slug ? AM.hudDatas : null;
    function dataHud(campo) {
      var valor = resumo[campo] || null;
      var mudou = anteriores && anteriores[campo] !== undefined && anteriores[campo] !== valor;
      return "<strong" + (mudou ? ' class="is-atualizado"' : "") + ">" + formatData(valor) + "</strong>";
    }
    var subInfo = resumo
      ? '<span>Última sincronização: ' + dataHud("ultimaSync") + "</span>" +
        '<span>Total sincronizado: <strong>' + (resumo.total || 0) + " anúncios</strong></span>" +
        // Sem conta/snapshot o backend manda null: aí a linha nem aparece
        // (formatData diria "nunca", que não é verdade sem conta escolhida).
        (resumo.margemCalculadaEm ? '<span>Margem calculada: ' + dataHud("margemCalculadaEm") + "</span>" : "")
      : '<span class="vf-status is-info">Carregando resumo…</span>';
    if (resumo) AM.hudDatas = { slug: c.slug, ultimaSync: resumo.ultimaSync || null, margemCalculadaEm: resumo.margemCalculadaEm || null };

    el("am-hud-top").innerHTML =
      '<div class="am-cliente-contexto vf-card">' +
        '<div class="am-cliente-contexto__info">' +
          '<div class="am-cliente-contexto__title-row"><div>' +
            '<p class="am-cliente-contexto__eyebrow">Cliente selecionado</p>' +
            '<h2 id="am-cliente-contexto-titulo">' + escapeHtml(c.nome) + "</h2></div>" +
            '<span class="vf-status ' + conexao.cls + '">' + conexao.txt + "</span></div>" +
          '<div class="am-hud-sub">' + subInfo + "</div>" +
        "</div>" +
        '<div class="am-sync-area">' + syncAcoesHtml() + "</div>" +
      "</div>";

    el("am-sync-novos").addEventListener("click", function () { sincronizar("novos"); });
    el("am-sync-completo").addEventListener("click", function () { sincronizar("completo"); });
    renderSyncStatus();
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
      var ativo = AM.kpisAtivos.indexOf(k.key) >= 0;
      var meta = typeof k.meta === "function" ? k.meta(r) : k.meta;
      var indisponivel = !!(AM.resumo && k.indisponivel && k.indisponivel(r));
      var motivo = indisponivel && r.semCustoMotivo ? r.semCustoMotivo : "";
      html += '<button type="button" class="vf-metric am-kpi' +
        (k.accent ? " is-" + k.accent : "") +
        (ativo ? " is-active" : "") + '" data-kpi="' + k.key + '"' +
        (indisponivel ? " disabled" : "") +
        (motivo ? ' title="' + escapeAttr(motivo) + '"' : "") +
        (ativo ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' +
        '<span class="vf-metric__label">' + k.label + "</span>" +
        '<strong class="vf-metric__value">' + (indisponivel ? "—" : (r[k.campo] || 0)) + "</strong>" +
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
    atualizarBotaoExpandir();

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
      // Recorte que o backend não conseguiu aplicar (ex.: "Sem custo" sem
      // Base de Custos) — avisa em vez de deixar o card parecer que filtrou.
      (r.data.filtrosIgnorados || []).forEach(function (f) {
        var def = KPI_DEFS.filter(function (k) { return k.valor === f.filtro; })[0];
        toast("Filtro \"" + (def ? def.label : f.filtro) + "\" não aplicado: " + (f.motivo || "indisponível."), "is-warning");
      });

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
          if (linha.faturamentoUnidades !== undefined) {
            (linha.tipo === "familia" ? AM.state.faturamentoUnidadesPorFamiliaCache : AM.state.faturamentoUnidadesCache)[chave] = linha.faturamentoUnidades;
          }
          if (linha.faturamentoPrecoMedio !== undefined) {
            (linha.tipo === "familia" ? AM.state.faturamentoPrecoMedioPorFamiliaCache : AM.state.faturamentoPrecoMedioCache)[chave] = linha.faturamentoPrecoMedio;
          }
          if (linha.faturamentoPeriodoDias != null) registrarPeriodoFaturamento({ periodoDias: linha.faturamentoPeriodoDias });
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

    // Os rótulos são decorativos (aria-hidden); o botão "Expandir todos" no
    // cabeçalho, não — por isso o aria-hidden fica em cada rótulo.
    var temGrupo = AM.anuncios.some(function (l) { return l.tipo === "familia"; });
    var html = '<div class="am-listagem" aria-label="Lista de anúncios">' +
      '<div class="am-listagem__head">' +
        '<span aria-hidden="true"></span>' +
        '<span class="am-listagem__head-anuncio"><b class="am-listagem__head-rotulo" aria-hidden="true">Anúncio</b>' +
          (temGrupo ? '<button type="button" class="am-expandir-todos" id="am-expandir-todos" aria-pressed="false">Expandir todos</button>' : "") +
        "</span>" +
        // Vendidos, Faturamento e Métricas olham para PERÍODOS diferentes
        // (desde a criação, a janela do Motor, 7 dias) — sem dizer isso,
        // "1 vendido" ao lado de "—" de faturamento e "0" vendas em 7d
        // parecia contradição. O período vai embaixo de cada rótulo; o do
        // faturamento vem da própria resposta (registrarPeriodoFaturamento).
        [
          "Status", "Preço", "Estoque",
          { r: "Vendidos", p: "total", t: "Total vendido desde a criação do anúncio (Mercado Livre)" },
          { r: "Faturamento", id: "am-head-fat-periodo",
            p: AM.state.faturamentoPeriodoDias ? "últ. " + AM.state.faturamentoPeriodoDias + " dias" : "no período",
            t: "Participação no faturamento e valor faturado na janela de vendas do Motor de Margem" },
          { r: "Métricas", p: "últ. 7 dias", t: "Visualizações e vendas dos últimos 7 dias" },
          "Margem", "Score VenForce", "",
        ].map(function (c) {
          if (typeof c === "string") return '<span aria-hidden="true">' + c + "</span>";
          // Continua UM span por coluna (os testes de alinhamento leem
          // ".am-listagem__head > span" por posição): rótulo em <b>, período
          // em <small>, os dois dentro do mesmo span.
          return '<span class="am-listagem__head-col" aria-hidden="true" title="' + escapeAttr(c.t) + '">' +
            '<b class="am-listagem__head-rotulo">' + c.r + "</b>" +
            '<small class="am-listagem__head-periodo"' + (c.id ? ' id="' + c.id + '"' : "") + ">" + c.p + "</small>" +
          "</span>";
        }).join("") +
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
      bindLinhaGrupo(row);
    });
    atualizarBotaoExpandir();

    bindPaginacao("am-pag", AM.paginacao, function (pagina) {
      irParaPaginaComCustos(pagina, function (p) {
        AM.paginacao.page = p;
        carregarAnuncios();
      });
    });

    // Custo do produto por MLB (célula Margem) — leitura leve da Base, depois
    // do paint, nunca atrasando a lista.
    garantirCustos(AM.anuncios.filter(function (l) { return l.tipo === "item"; }).map(function (l) { return l.item_id; }));
    if (CUSTOS.modo) aplicarModoNaLista();
    renderBarraCustos();

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
    // "Misto" sozinho não diz o que está misturado: a contagem (só o que é
    // diferente de zero) aparece embaixo do selo, uma linha por status.
    var partes = [];
    if (c.ativos) partes.push(plural(c.ativos, "ativo", "ativos"));
    if (c.pausados) partes.push(plural(c.pausados, "pausado", "pausados"));
    if (c.encerrados) partes.push(plural(c.encerrados, "encerrado", "encerrados"));
    return {
      label: "Misto",
      classe: "is-info",
      titulo: (c.ativos || 0) + " ativos · " + (c.pausados || 0) + " pausados · " +
              (c.encerrados || 0) + " encerrados",
      detalhe: partes,
    };
  }

  function statusGrupoHtml(f) {
    var st = statusGrupo(f);
    var selo = '<span class="vf-status ' + st.classe + '"' +
      (st.titulo ? ' title="' + escapeAttr(st.titulo) + '"' : "") + ">" + st.label + "</span>";
    if (!st.detalhe || !st.detalhe.length) return selo;
    return '<span class="am-status-misto">' + selo +
      '<span class="am-status-misto__detalhe">' +
        st.detalhe.map(function (t) { return "<span>" + escapeHtml(t) + "</span>"; }).join("") +
      "</span></span>";
  }

  // Preço do agrupador. "Preço por variação" é o nome da própria iniciativa do
  // ML: uma família existe justamente para ter preços diferentes por variação.
  // Faixa quando os extremos diferem, valor único quando coincidem.
  //
  // Cada extremo carrega o preço cheio do MESMO anúncio que o gerou — nunca
  // um cheio de outro filho — para o riscado da família dizer a mesma coisa
  // que o riscado do MLB. Fonte: os extremos que a listagem já traz
  // (preco_min/preco_max + preco_min_original/preco_max_original); depois
  // que a família é expandida e o Motor responde pelos filhos, os filhos
  // (AM.state.familyCache) com a mesma regra de celulaPrecoHtml — a linha-mãe
  // passa a riscar também a promoção que só existe no sale_price ao vivo.
  function numeroOuNulo(v) {
    if (v === null || v === undefined || v === "") return null;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }

  function precoAtualECheioDoItem(a) {
    var cache = AM.state.performanceCache[a.item_id];
    var m = cache && cache.margem;
    // Sem o Motor ainda (filho de família fechada), o preço ao vivo leve
    // (sale_price, ver carregarPrecosAoVivoDaFamilia) vale mais que o
    // snapshot: é ele que enxerga a promoção de campanha.
    var vivo = AM.state.precoAoVivoCache[a.item_id];
    if (!(cache && cache.temMargem) && vivo) {
      var atualVivo = numeroOuNulo(vivo.precoAtual);
      return { atual: atualVivo, cheio: precoCheioReal(atualVivo, numeroOuNulo(vivo.precoOriginal)) };
    }
    var atual = numeroOuNulo(m && m.precoAtual != null ? m.precoAtual : a.preco);
    var cheioBruto = cache && cache.temMargem
      ? numeroOuNulo(m && m.precoOriginal)
      : numeroOuNulo(a.preco_original);
    return { atual: atual, cheio: precoCheioReal(atual, cheioBruto) };
  }

  function extremosPrecoGrupo(f) {
    var pares = [];
    var familia = AM.state.familyCache[f.family_id];
    var itens = [];
    if (familia) {
      (familia.user_products || []).forEach(function (up) { itens = itens.concat(up.itens || []); });
    }
    // Os filhos só assumem quando já existe preço AO VIVO de algum deles —
    // o leve (sale_price, pré-carregado em background para as famílias
    // visíveis) ou o do Motor (família expandida). Só com o detalhe da
    // família em mãos o dado é o mesmo snapshot da listagem, e trocar de
    // fonte faria a célula piscar sem nenhum dado novo.
    var aoVivo = itens.some(function (item) {
      var c = AM.state.performanceCache[item.item_id];
      return !!(c && c.temMargem) || !!AM.state.precoAoVivoCache[item.item_id];
    });
    if (aoVivo) {
      itens.forEach(function (item) {
        var p = precoAtualECheioDoItem(item);
        if (p.atual != null) pares.push(p);
      });
    }
    if (!pares.length) {
      [[f.preco_min, f.preco_min_original], [f.preco_max, f.preco_max_original]].forEach(function (par) {
        var atual = numeroOuNulo(par[0]);
        if (atual != null) pares.push({ atual: atual, cheio: precoCheioReal(atual, numeroOuNulo(par[1])) });
      });
    }
    if (!pares.length) return null;
    // Empate no vigente: fica o par COM riscado (o maior cheio).
    var melhor = function (a, b, maior) {
      if (a.atual !== b.atual) return (maior ? b.atual > a.atual : b.atual < a.atual) ? b : a;
      return (b.cheio || 0) > (a.cheio || 0) ? b : a;
    };
    return {
      min: pares.reduce(function (acc, p) { return melhor(acc, p, false); }),
      max: pares.reduce(function (acc, p) { return melhor(acc, p, true); }),
    };
  }

  // Valor único: a MESMA célula do MLB (riscado em cima, vigente embaixo).
  // Faixa: mesmo desenho da faixa de margem (margemFaixaFamiliaHtml) —
  // mínimo em cima, máximo embaixo, cada vigente com o seu cheio riscado
  // logo abaixo, no lugar em que a margem mostra o lucro.
  function precoGrupoHtml(f) {
    var classe = "am-row__preco";
    var ext = extremosPrecoGrupo(f);
    if (!ext) return '<span class="' + classe + '">—</span>';
    if (ext.min.atual === ext.max.atual) {
      var p = ext.min.cheio ? ext.min : ext.max;
      return '<span class="' + classe + (p.cheio ? " " + classe + "--promo" : "") + '">' +
        precoCelulaConteudoHtml(classe, p.atual, p.cheio, f.moeda) + "</span>";
    }
    var ponta = function (faixa, par) {
      return '<span class="am-preco-faixa__ponta" data-faixa="' + faixa + '">' +
        '<span class="am-preco-faixa__valor">' + escapeHtml(formatMoeda(par.atual, f.moeda)) + "</span>" +
        (par.cheio
          ? '<span class="am-preco-faixa__cheio" title="Preço cheio, antes da promoção">' +
              escapeHtml(formatMoeda(par.cheio, f.moeda)) + "</span>"
          : "") +
      "</span>";
    };
    return '<span class="' + classe + ' am-preco-faixa" ' +
      'title="Faixa de preço dos anúncios desta família (mínimo em cima, máximo embaixo)">' +
      ponta("min", ext.min) + ponta("max", ext.max) + "</span>";
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
    var rotulo = f.family_name || "(família sem nome)";
    var nVar = f.total_user_products || 0, nAnun = f.total_itens || 0;
    // Uma variação = um anúncio é o caso comum: dizer os dois números iguais
    // é ruído. Só quando diferem (Clássico + Premium da mesma variação) os
    // dois aparecem.
    var contagemHtml = nVar === nAnun
      ? '<span title="' + escapeAttr(plural(nAnun, "anúncio", "anúncios")) + '">' + plural(nVar, "variação", "variações") + "</span>"
      : "<span>" + plural(nVar, "variação", "variações") + "</span>" +
        "<span>" + plural(nAnun, "anúncio", "anúncios") + "</span>";

    return '<div class="am-row am-row--grupo" data-familia="' + escapeAttr(f.family_id) + '" ' +
      'tabindex="0" role="button" aria-expanded="false" aria-controls="' + painelId + '" ' +
      'aria-label="Ver as variações de ' + escapeAttr(rotulo) + '">' +
      '<div class="am-row__thumb" aria-hidden="true">' + capa + "</div>" +
      '<div class="am-row__main">' +
        '<h3 class="am-row__titulo">' + escapeHtml(rotulo) + "</h3>" +
        '<div class="am-row__ids">' +
          contagemHtml +
          // O identificador do AGRUPADOR (family_id), sempre visível e sem
          // rótulo: só "#<id>". Clicar nele copia o ID (sem expandir a
          // família). MLBU não aparece em lugar nenhum.
          '<button type="button" class="am-row__copiar-id" data-copiar-familia="' + escapeAttr(f.family_id) + '" ' +
            'title="Copiar ID" ' +
            'aria-label="Copiar o ID da família ' + escapeAttr(f.family_id) + '">#' + escapeHtml(f.family_id) + '</button>' +
        "</div>" +
      "</div>" +
      statusGrupoHtml(f) +
      precoGrupoHtml(f) +
      // A soma que dá sentido ao agrupador: estoque por User Product distinto.
      '<span class="am-row__num" title="Soma do estoque das ' +
        escapeAttr(plural(nVar, "variação", "variações")) + '">' +
        (f.estoque_total != null ? f.estoque_total : "—") + "</span>" +
      '<span class="am-row__num" title="Total vendido desde a criação do anúncio">' + (f.vendidos_total != null ? f.vendidos_total : "—") + "</span>" +
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
        // Preço ao vivo dos filhos em paralelo às métricas: só sale_price
        // (sem Motor), e repinta a linha-mãe sozinho quando chega.
        carregarPrecosAoVivoDaFamilia(familyId);
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

  // Preço vigente + cheio AO VIVO dos filhos de UMA família (GET
  // /anuncios-meli/precos-ao-vivo — só sale_price, nunca o Motor). Sem isso
  // a linha-mãe só riscava a promoção depois de expandir: o snapshot da
  // sincronização não enxerga promoção de campanha. Pede só o que falta no
  // cache, em lotes do teto da rota; falha deixa o snapshot, sem aviso.
  var PRECO_AO_VIVO_LOTE = 60;
  function carregarPrecosAoVivoDaFamilia(familyId) {
    var familia = AM.state.familyCache[familyId];
    if (!familia || !AM.clienteAtual) return Promise.resolve();
    var ids = [];
    (familia.user_products || []).forEach(function (up) {
      (up.itens || []).forEach(function (item) {
        var c = AM.state.performanceCache[item.item_id];
        if (!AM.state.precoAoVivoCache[item.item_id] && !(c && c.temMargem)) ids.push(item.item_id);
      });
    });
    if (!ids.length) return Promise.resolve();

    var minhaEpoca = AM.familiaEpoca;
    var lotes = [];
    for (var i = 0; i < ids.length; i += PRECO_AO_VIVO_LOTE) lotes.push(ids.slice(i, i + PRECO_AO_VIVO_LOTE));
    return Promise.all(lotes.map(function (lote) {
      var qs = "clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug) +
        "&itemIds=" + encodeURIComponent(lote.join(","));
      if (AM.contaMlId) qs += "&clienteContaId=" + encodeURIComponent(AM.contaMlId);
      return api("/anuncios-meli/precos-ao-vivo?" + qs).then(function (r) {
        if (minhaEpoca !== AM.familiaEpoca) return; // outro cliente/conta assumiu a tela
        var precos = (r && r.data && r.data.ok && r.data.precos) || {};
        Object.keys(precos).forEach(function (id) { AM.state.precoAoVivoCache[id] = precos[id]; });
      }, function () {});
    })).then(function () {
      if (minhaEpoca === AM.familiaEpoca) repintarLinhaDoGrupo(familyId);
    });
  }

  // Clique/Enter na linha expande; o botão "ID" copia o family_id e NUNCA
  // escala para a linha (copiar não pode abrir/fechar a família).
  function bindLinhaGrupo(row) {
    row.addEventListener("click", function (e) {
      var copiar = e.target.closest(".am-row__copiar-id");
      if (copiar) {
        e.stopPropagation();
        copiarTexto(copiar.getAttribute("data-copiar-familia"), "ID da família copiado.");
        return;
      }
      alternarGrupo(row);
    });
    row.addEventListener("keydown", function (e) {
      if (e.target.closest(".am-row__copiar-id")) return; // o botão trata o próprio Enter/Espaço
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); alternarGrupo(row); }
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
    atualizarBotaoExpandir();
    if (!abrindo) { renderBarraCustos(); return; }

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

  // "Expandir agrupadores": abre (ou fecha) TODAS as famílias da página pelo
  // mesmo alternarGrupo do clique — mesmo cache, mesma Promise em voo, nenhuma
  // requisição duplicada. Abre quando há alguma fechada; fecha quando todas
  // já estão abertas.
  function linhasDeGrupo() {
    return Array.prototype.slice.call(document.querySelectorAll("#am-catalogo-container .am-row--grupo[data-familia]"));
  }

  function atualizarBotaoExpandir() {
    var btn = el("am-expandir-todos");
    if (!btn) return;
    var grupos = linhasDeGrupo();
    btn.hidden = !grupos.length;
    if (!grupos.length) return;
    var todasAbertas = grupos.every(function (g) { return g.getAttribute("aria-expanded") === "true"; });
    btn.textContent = todasAbertas ? "Recolher todos" : "Expandir todos";
    btn.setAttribute("aria-pressed", todasAbertas ? "true" : "false");
  }

  function alternarTodosGrupos() {
    var grupos = linhasDeGrupo();
    if (!grupos.length) return;
    var abrir = grupos.some(function (g) { return g.getAttribute("aria-expanded") !== "true"; });
    grupos.forEach(function (g) {
      var aberta = g.getAttribute("aria-expanded") === "true";
      if (aberta !== abrir) alternarGrupo(g);
    });
    atualizarBotaoExpandir();
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
    var idsFilhos = [];
    painel.querySelectorAll(".am-margem[data-margem-item]").forEach(function (c) { idsFilhos.push(c.getAttribute("data-margem-item")); });
    garantirCustos(idsFilhos);
    // Com o custo dos filhos já no cache (família aberta antes, ou vista
    // antes de trocar o filtro), garantirCustos não lê nada e o aviso
    // "N sem custo nesta página" nunca seria recontado — reconta aqui.
    renderBarraCustos();
    if (CUSTOS.modo) aplicarModoNaLista();
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
      '<span class="am-metricas7d am-metricas7d--indisponivel" title="Métricas últ. 7 dias são só por anúncio (MLB) — o Mercado Livre não as reporta por variação"></span>' +
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
    // A Curva ABC do filho NÃO mora aqui: fica junto do % de faturamento
    // (ver faturamentoCelulaHtml), que é o dado que a define.
    var badges = badgesAnuncioHtml(a);
    var badgesHtml = '<span class="am-mlb__badges">' + badges + "</span>";

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
      '<span class="am-mlb__num" title="Total vendido desde a criação do anúncio">' + (a.vendidos != null ? a.vendidos : "—") + "</span>" +
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
    if (!m) return '';
    var campos = ["views", "vendas", "conversao"];
    var nomes = ["Visitas", "Unidades vendidas", "Conversão"];
    var paths = ['<path d="M2 12s3-6 10-6 10 6 10 6-3 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>', '<path d="M3 3h2l2 12h12l2-8H6M9 20h.01M18 20h.01"/>', '<path d="m3 17 6-6 4 4 8-10M15 5h6v6"/>'];
    return '<button type="button" class="am-metricas7d-trigger" aria-label="Comparar métricas com os 7 dias anteriores" aria-expanded="false" aria-controls="am-metricas-popup" data-metricas-info="' + escapeAttr(JSON.stringify(m)) + '">' +
      campos.map(function (campo, i) {
        return '<span class="am-metricas7d__linha"><span class="am-metricas7d__icone" aria-hidden="true">' + svgIcone(paths[i], 14, 1.6) + '</span><span aria-label="' + nomes[i] + '">' +
          (m[campo] == null ? '' : campo === "conversao" ? formatarPercentualCompacto(m[campo]) : formatarInteiroOuTraco(m[campo])) + '</span>' + variacaoMetricaHtml(m[campo], m.anterior && m.anterior[campo], campo === "conversao", true) + '</span>';
      }).join("") + '</button>';
  }

  function variacaoMetricaHtml(atual, anterior, pontos, apenasSeta) {
    if (atual == null || anterior == null) return '';
    if (!pontos && anterior === 0 && atual !== 0) return '';
    var delta = pontos ? atual - anterior : (anterior === 0 ? 0 : (atual - anterior) / anterior * 100);
    delta = Math.round(delta * 10) / 10;
    if (apenasSeta && delta === 0) return '';
    var descricao = (delta > 0 ? 'Aumento de ' : delta < 0 ? 'Queda de ' : 'Sem alteração: ') +
      Math.abs(delta).toFixed(1).replace('.', ',') + (pontos ? ' pp' : '%');
    var seta = delta > 0 ? '▲' : delta < 0 ? '▼' : '';
    return '<span class="am-metricas-delta ' + (delta > 0 ? 'is-success' : delta < 0 ? 'is-danger' : 'is-neutral') + '" aria-label="' + descricao + '">' +
      (apenasSeta ? seta : (seta ? seta + ' ' : '') + Math.abs(delta).toFixed(1).replace('.', ',') + (pontos ? ' pp' : '%')) + '</span>';
  }

  function bindComparativoMetricas() {
    var popup = document.createElement('div');
    popup.id = 'am-metricas-popup';
    popup.className = 'am-metricas-popup';
    popup.setAttribute('role', 'tooltip');
    popup.hidden = true;
    document.body.appendChild(popup);
    var ativo = null, timer;
    function fechar() {
      clearTimeout(timer);
      if (ativo) ativo.setAttribute('aria-expanded', 'false');
      ativo = null; popup.hidden = true;
    }
    function abrir(botao) {
      clearTimeout(timer);
      if (ativo && ativo !== botao) ativo.setAttribute('aria-expanded', 'false');
      ativo = botao;
      var m = JSON.parse(botao.getAttribute('data-metricas-info'));
      function datas(p) {
        if (!p) return 'Período indisponível';
        function fmt(d) { return d.split('-').reverse().join('/'); }
        return fmt(p.dateFrom) + ' a ' + fmt(p.dateTo);
      }
      popup.innerHTML = '<p class="am-metricas-popup__titulo">Comparação com a semana anterior</p>' +
        '<p class="am-metricas-popup__periodo">Atual: ' + escapeHtml(datas(m.periodos && m.periodos.atual)) + '<br>Anterior: ' + escapeHtml(datas(m.periodos && m.periodos.anterior)) + '</p>' +
        (m.anterior ? '<table><thead><tr><th></th><th>Anterior</th><th>Variação</th></tr></thead><tbody>' +
          ['views', 'vendas', 'conversao'].map(function (campo, i) {
            function fmt(v) { return v == null ? '' : campo === 'conversao' ? formatarPercentualCompacto(v) : formatarInteiroOuTraco(v); }
            return '<tr><th title="' + (campo === 'vendas' ? 'Unidades vendidas' : campo === 'conversao' ? 'Unidades vendidas ÷ visitas' : 'Visitas ao anúncio') + '">' + ['Visitas', 'Vendas', 'Conversão'][i] + '</th><td>' + fmt(m.anterior[campo]) + '</td><td>' + variacaoMetricaHtml(m[campo], m.anterior[campo], campo === 'conversao') + '</td></tr>';
          }).join('') + '</tbody></table>' : '<p>Comparativo indisponível para este anúncio.</p>');
      popup.hidden = false;
      botao.setAttribute('aria-expanded', 'true');
      botao.setAttribute('aria-describedby', popup.id);
      var r = botao.getBoundingClientRect();
      var largura = popup.getBoundingClientRect().width;
      var altura = popup.getBoundingClientRect().height;
      // Ao lado da célula: mantém a coluna livre para alcançar o próximo anúncio.
      var esquerda = r.left - largura - 10;
      var lateral = esquerda >= 8 || r.right + largura + 10 <= window.innerWidth - 8;
      if (esquerda < 8) esquerda = lateral ? r.right + 10 : r.left;
      popup.style.left = Math.max(8, Math.min(esquerda, window.innerWidth - largura - 8)) + 'px';
      var topo = lateral ? r.top : r.top - altura - 8;
      popup.style.top = Math.max(8, Math.min(window.innerHeight - altura - 8, topo)) + 'px';
    }
    document.addEventListener('mouseover', function (e) {
      var b = e.target.closest('.am-metricas7d-trigger');
      if (b) abrir(b);
      else if (!popup.contains(e.target)) { clearTimeout(timer); timer = setTimeout(fechar, 120); }
      else clearTimeout(timer);
    });
    document.addEventListener('mouseout', function (e) {
      if (!ativo) return;
      var proximo = e.relatedTarget;
      if (!proximo) { fechar(); return; }
      if (ativo.contains(proximo) || popup.contains(proximo)) { clearTimeout(timer); return; }
      clearTimeout(timer); timer = setTimeout(fechar, 120);
    });
    document.addEventListener('focusin', function (e) { var b = e.target.closest('.am-metricas7d-trigger'); if (b) abrir(b); else fechar(); });
    document.addEventListener('focusout', function (e) { if (ativo && ativo.contains(e.target) && !ativo.contains(e.relatedTarget)) fechar(); });
    document.addEventListener('click', function (e) {
      var b = e.target.closest('.am-metricas7d-trigger');
      if (b) { e.stopPropagation(); abrir(b); }
      else if (!popup.contains(e.target)) fechar();
    }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') fechar(); });
    window.addEventListener('resize', fechar);
    window.addEventListener('blur', fechar);
    window.addEventListener('scroll', function (e) {
      if (!ativo || (e.target instanceof Node && popup.contains(e.target))) return;
      fechar();
    }, true);
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
    var resultado = { views: views, vendas: vendas, conversao: agregarConversao(vendas, views) };
    var metricas = ids.map(function (id) { return AM.state.performanceCache[id].metricas7d; });
    if (metricas.every(function (m) { return m && m.anterior && m.periodos && JSON.stringify(m.periodos) === JSON.stringify(metricas[0].periodos); })) {
      function somar(campo) {
        return metricas.every(function (m) { return m.anterior[campo] != null; })
          ? metricas.reduce(function (total, m) { return total + m.anterior[campo]; }, 0) : null;
      }
      resultado.anterior = { views: somar('views'), vendas: somar('vendas') };
      resultado.anterior.conversao = agregarConversao(resultado.anterior.vendas, resultado.anterior.views);
      resultado.periodos = metricas[0].periodos;
    }
    return resultado;
  }

  function metricas7dAgregadoCelulaHtml(familyId) {
    var agregado = metricas7dAgregadoDoGrupo(familyId);
    if (agregado) {
      return '<span class="am-metricas7d" aria-label="Soma dos últimos 7 dias de todas as variações">' +
        metricas7dConteudoHtml(agregado) + "</span>";
    }
    // Ainda não: o pré-carregamento em background falhou de verdade (mostra
    // "—", igual à falha de qualquer célula de item) ou simplesmente ainda
    // está em voo (mostra "carregando…", nunca um "—" definitivo — a soma
    // chega sozinha quando a resposta voltar).
    if (AM.state.familyFetchFalhou[familyId]) {
      return '<span class="am-metricas7d am-metricas7d--indisponivel" title="Não foi possível calcular a soma agora"></span>';
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
    var motivo = m.margemIncompletaMotivo || (m.statusReasons && m.statusReasons[0]) || "";
    if (motivo) tip = motivo;
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

  // `fonte` (margemProjetadaFonte): "margin_snapshot" (fonte canônica) ou
  // "legado" (tabela antiga, só enquanto o item não tem cálculo canônico).
  // Só o tooltip diz qual — a célula não muda.
  function margemCalculadaEmFrase(calculadoEm, fonte) {
    var quando = margemCalculadaEmTexto(calculadoEm);
    if (!quando) return "";
    return " Margem projetada calculada em " + quando + "." +
      (fonte === "legado" ? " Cálculo antigo, aguardando o próximo recálculo." : "");
  }

  // Célula de Margem da LISTAGEM (linha avulsa e filho expandido de
  // família) — nasce PRONTA com o snapshot de margem projetada que já vem no
  // próprio `anuncio` (margemProjetadaPercent/Computable/Status/CalculadaEm,
  // ver anexarMargemProjetadaNaPagina no controller e garantirFamiliaDetalhe),
  // sem estado "carregando". Quando a margem AO VIVO do Motor chega (GET
  // /performance com incluirRebateAtivo, ver margemAoVivoHtml), ela substitui
  // o snapshot: o snapshot é uma foto do último job e erra quando o preço
  // muda depois dele (Oferta relâmpago) e não soma o retorno ML da promoção
  // ativa — caso real Red Fish 15/10/2026, 5 variações com 25,1% na lista e
  // 23,4%/29,0% no modal. A ORDENAÇÃO por margem continua no snapshot.
  // Lucro em R$ por unidade vendida, no preço atual — o `profit` que o Motor
  // já calcula junto com a margem (margin = profit / price). Aparece embaixo
  // do %, na MESMA cor dele: os dois são o mesmo resultado em escalas
  // diferentes. Negativo sai como "−R$ 3,20", nunca "R$ -3,20".
  function lucroMargemHtml(profit, classe) {
    if (profit === null || profit === undefined || isNaN(Number(profit))) return "";
    var n = Number(profit);
    var texto = (n < 0 ? "−" : "") + formatMoeda(Math.abs(n)) + "/un";
    return '<span class="am-margem__lucro ' + classe + '" title="Lucro por unidade vendida, no preço atual">' + texto + "</span>";
  }

  function margemProjetadaConteudoHtml(a) {
    var classe = MARGEM_CLASSE[a.margemProjetadaStatus] || "is-neutral";
    if (a.margemProjetadaComputable === true && a.margemProjetadaPercent != null) {
      var tip = "Margem projetada com base no preço atual e custos configurados." +
        margemCalculadaEmFrase(a.margemProjetadaCalculadaEm, a.margemProjetadaFonte);
      return '<span class="am-margem__valor ' + classe + '">' + formatarPercentualCompacto(a.margemProjetadaPercent) + "</span>" +
        lucroMargemHtml(a.margemProjetadaProfit, classe) +
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

  // A célula também carrega o custo do produto (ver bloco "CUSTO DO PRODUTO
  // NA LISTA"): "+ Custo"/"✎ R$ x" e, no modo massa, o campo. Depois de um
  // custo gravado, a margem AO VIVO do Motor substitui o snapshot.
  function margemCelulaHtml(a) {
    var sobre = margemSobrepostaHtml(a.item_id);
    return '<span class="am-margem' + (CUSTOS.modo ? " is-modo-custos" : "") + '" data-margem-item="' + escapeAttr(a.item_id) + '">' +
      (sobre != null ? sobre : margemProjetadaConteudoHtml(a)) + custoControleHtml(a.item_id) + "</span>";
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
  // "secundário". Cada ponta leva a cor do status do Motor do filho que a
  // gerou (`margemProjetadaMinStatus`/`MaxStatus`, mesma MARGEM_CLASSE da
  // célula do item) — antes era sempre `is-neutral` e a família ficava preta
  // enquanto o mesmo % num anúncio avulso aparecia verde. Antes o mínimo usava um estilo apagado/menor inspirado no
  // preço riscado e parecia um valor antigo/desabilitado. `data-faixa`
  // (min/max) só identifica a linha, sem estilo próprio. Min === Max (1 único
  // filho computável) mostra só UM valor, nunca duas linhas iguais.
  // Faixa AO VIVO da família: só quando TODOS os filhos já têm a margem do
  // Motor (família expandida) — uma faixa com parte ao vivo e parte snapshot
  // misturaria duas fotos de momentos diferentes. null = usa o snapshot.
  function faixaFamiliaAoVivo(familyId) {
    var fam = AM.state.familyCache[familyId];
    if (!fam) return null;
    var pontas = [];
    var completo = true;
    (fam.user_products || []).forEach(function (up) {
      (up.itens || []).forEach(function (item) {
        var c = AM.state.performanceCache[item.item_id];
        if (!c || !c.temMargem) { completo = false; return; }
        var m = c.margem;
        if (m && m.marginPercent != null) pontas.push({ pct: m.marginPercent, profit: m.profit, status: m.status });
      });
    });
    if (!completo || !pontas.length) return null;
    var min = pontas[0];
    var max = pontas[0];
    pontas.forEach(function (p) {
      if (p.pct < min.pct) min = p;
      if (p.pct > max.pct) max = p;
    });
    return { min: min, max: max };
  }

  function margemFaixaFamiliaHtml(f) {
    var vivo = faixaFamiliaAoVivo(f.family_id);
    if (vivo || (f.margemProjetadaMinPercent != null && f.margemProjetadaMaxPercent != null)) {
      var min = formatarPercentualCompacto(vivo ? vivo.min.pct : f.margemProjetadaMinPercent);
      var max = formatarPercentualCompacto(vivo ? vivo.max.pct : f.margemProjetadaMaxPercent);
      var tip = vivo
        ? "Faixa de margem dos anúncios desta família (mínimo em cima, máximo embaixo), calculada agora pelo Motor no preço atual de cada um, já com o retorno ML da promoção ativa quando há. A ordenação por margem usa o último cálculo salvo."
        : "Faixa de Margem Projetada dos anúncios desta família (mínimo em cima, máximo embaixo), cada uma com o lucro por unidade do anúncio que a gerou. A ordenação por margem usa a média." +
          margemCalculadaEmFrase(f.margemProjetadaCalculadaEm, f.margemProjetadaFonte);
      var classeMin = MARGEM_CLASSE[vivo ? vivo.min.status : f.margemProjetadaMinStatus] || "is-neutral";
      var classeMax = MARGEM_CLASSE[vivo ? vivo.max.status : f.margemProjetadaMaxStatus] || "is-neutral";
      var ponta = function (faixa, texto, classe, profit) {
        return '<span class="am-margem__ponta">' +
          '<span class="am-margem__valor ' + classe + '" data-faixa="' + faixa + '">' + texto + "</span>" +
          lucroMargemHtml(profit, classe) +
        "</span>";
      };
      var profitMin = vivo ? vivo.min.profit : f.margemProjetadaMinProfit;
      var profitMax = vivo ? vivo.max.profit : f.margemProjetadaMaxProfit;
      var linhas = min === max
        ? ponta("unico", max, classeMax, profitMax)
        : ponta("min", min, classeMin, profitMin) +
          ponta("max", max, classeMax, profitMax);
      return '<span class="am-margem am-margem--faixa" data-margem-familia="' + escapeAttr(f.family_id) + '">' +
        linhas + infoDotHtml(tip) +
      "</span>";
    }
    return '<span class="am-margem am-margem--indisponivel" data-margem-familia="' + escapeAttr(f.family_id) + '" ' +
      'title="Nenhum anúncio desta família tem margem projetada calculada">—</span>';
  }

  // Repinta a faixa das famílias que contêm algum destes MLB (a margem ao
  // vivo dos filhos acabou de chegar).
  function repintarFaixaDasFamilias(ids) {
    var alvo = {};
    ids.forEach(function (id) { alvo[id] = true; });
    AM.anuncios.forEach(function (f) {
      if (f.tipo !== "familia") return;
      var fam = AM.state.familyCache[f.family_id];
      var toca = fam && (fam.user_products || []).some(function (up) {
        return (up.itens || []).some(function (item) { return alvo[item.item_id]; });
      });
      if (!toca) return;
      document.querySelectorAll('[data-margem-familia="' + cssEscape(f.family_id) + '"]').forEach(function (cel) {
        cel.outerHTML = margemFaixaFamiliaHtml(f);
      });
    });
  }

  // % do faturamento — coluna própria (ver auditoria "Ajuste visual —
  // métricas de performance"). Ao contrário de metricas7d/margem, não tem
  // pré-carregamento em background nem estado "carregando": o valor só entra
  // no cache quando o operador ordena por ele (ver
  // aplicarOrdenacaoPerformance/AM.state.faturamentoCache), e a célula fica
  // "—" fixo até lá — nunca um spinner para um dado que ninguém pediu ainda.
  // `abcHtml`: a Curva ABC mora ao lado do %, que é o dado que a define
  // (antes ficava solta entre os badges do título).
  // `pedido`: o faturamento desta linha já foi pedido e voltou — aí "—" quer
  // dizer "sem venda no período", e diz isso no title (antes era igual ao
  // "ainda não pedido").
  // `unidades`/`precoMedio`: 3ª linha "N un · R$ X/un" — neutra, sem aviso
  // (o "↓" e o texto sobre promoção confundiam e saíram de vez).
  function faturamentoConteudoHtml(v, valorAbsoluto, abcHtml, pedido, unidades, precoMedio) {
    if (v === null || v === undefined) {
      var tituloVazio = pedido ? ' title="Sem venda ' + escapeAttr(periodoFaturamentoTexto()) + '"' : "";
      return '<span class="am-faturamento__topo"><span class="am-faturamento__vazio"' + tituloVazio + ">—</span>" + (abcHtml || "") + "</span>";
    }
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
    return '<span class="am-faturamento__topo"><span class="am-faturamento__valor">' + formatarPercentualCompacto(v * 100) + "</span>" +
        (abcHtml || "") + "</span>" +
      '<span class="am-faturamento__legenda">' + formatMoeda(valorAbsoluto) + "</span>" +
      (unidades === null || unidades === undefined ? "" :
        '<span class="am-faturamento__un" title="' + escapeAttr("Unidades vendidas " + periodoFaturamentoTexto() +
            (precoMedio != null ? " e preço médio por unidade vendida" : "")) + '">' +
          escapeHtml(Number(unidades).toLocaleString("pt-BR") + " un" +
            (precoMedio != null ? " · " + formatMoeda(precoMedio) + "/un" : "")) + "</span>");
  }

  // "nos últimos 30 dias" — o período que a resposta do faturamento disse.
  // Antes de qualquer resposta, "no período" (nunca um número inventado).
  function periodoFaturamentoTexto() {
    var d = AM.state.faturamentoPeriodoDias;
    return d ? "nos últimos " + d + " dias" : "no período";
  }

  function registrarPeriodoFaturamento(fat) {
    var d = fat && fat.periodoDias;
    if (!d || AM.state.faturamentoPeriodoDias === d) return;
    AM.state.faturamentoPeriodoDias = d;
    var alvo = el("am-head-fat-periodo");
    if (alvo) alvo.textContent = "últ. " + d + " dias";
  }

  function abcItemHtml(itemId) {
    return '<span data-abc-item="' + escapeAttr(itemId) + '">' + curvaAbcBadgeHtml(AM.state.curvaAbcCache[itemId]) + "</span>";
  }

  function faturamentoCelulaHtml(itemId) {
    var v = Object.prototype.hasOwnProperty.call(AM.state.faturamentoCache, itemId)
      ? AM.state.faturamentoCache[itemId] : null;
    var valor = Object.prototype.hasOwnProperty.call(AM.state.faturamentoValorCache, itemId)
      ? AM.state.faturamentoValorCache[itemId] : null;
    return '<span class="am-faturamento" data-faturamento-item="' + escapeAttr(itemId) + '">' +
      faturamentoConteudoHtml(v, valor, abcItemHtml(itemId),
        Object.prototype.hasOwnProperty.call(AM.state.faturamentoCache, itemId),
        AM.state.faturamentoUnidadesCache[itemId], AM.state.faturamentoPrecoMedioCache[itemId]) + "</span>";
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
      faturamentoConteudoHtml(v, valor,
        '<span data-abc-familia="' + escapeAttr(familyId) + '">' + curvaAbcBadgeHtml(AM.state.curvaAbcPorFamiliaCache[familyId]) + "</span>",
        Object.prototype.hasOwnProperty.call(AM.state.faturamentoPorFamiliaCache, familyId),
        AM.state.faturamentoUnidadesPorFamiliaCache[familyId], AM.state.faturamentoPrecoMedioPorFamiliaCache[familyId]) + "</span>";
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
      "&incluirComparativo=1" +
      "&incluirMargem=" + (pendentesMargem.length || pendentesComposicao.length ? "1" : "0") +
      // Margem da LISTA com o retorno ML da promoção ativa (ver margemAoVivoHtml).
      "&incluirRebateAtivo=1" +
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
          var porItemUnidades = (dados.faturamento && dados.faturamento.porItemUnidades) || {};
          var porItemPrecoMedio = (dados.faturamento && dados.faturamento.porItemPrecoMedio) || {};
          registrarPeriodoFaturamento(dados.faturamento);
          pendentesFaturamento.forEach(function (id) {
            AM.state.faturamentoCache[id] = porItem[id] != null ? porItem[id] : null;
            AM.state.faturamentoValorCache[id] = porItemValor[id] != null ? porItemValor[id] : null;
            AM.state.faturamentoUnidadesCache[id] = porItemUnidades[id] != null ? porItemUnidades[id] : null;
            AM.state.faturamentoPrecoMedioCache[id] = porItemPrecoMedio[id] != null ? porItemPrecoMedio[id] : null;
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
      var porFamiliaUnidades = (dados && dados.ok && dados.faturamento && dados.faturamento.porFamiliaUnidades) || {};
      var porFamiliaPrecoMedio = (dados && dados.ok && dados.faturamento && dados.faturamento.porFamiliaPrecoMedio) || {};
      var porFamiliaAbc = (dados && dados.ok && dados.curvaAbc && dados.curvaAbc.porFamilia) || {};
      if (dados && dados.ok) registrarPeriodoFaturamento(dados.faturamento);
      pendentes.forEach(function (familyId) {
        AM.state.faturamentoPorFamiliaCache[familyId] = porFamilia[familyId] != null ? porFamilia[familyId] : null;
        AM.state.faturamentoValorPorFamiliaCache[familyId] = porFamiliaValor[familyId] != null ? porFamiliaValor[familyId] : null;
        AM.state.faturamentoUnidadesPorFamiliaCache[familyId] = porFamiliaUnidades[familyId] != null ? porFamiliaUnidades[familyId] : null;
        AM.state.faturamentoPrecoMedioPorFamiliaCache[familyId] = porFamiliaPrecoMedio[familyId] != null ? porFamiliaPrecoMedio[familyId] : null;
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
      bindLinhaGrupo(substituta);
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
    // Margem: a célula nasceu com o snapshot; a margem ao vivo que acabou de
    // chegar a substitui (margemSobrepostaHtml → margemAoVivoHtml). Campo de
    // custo em edição não é repintado (perderia o foco) — ele se repinta ao
    // fechar.
    ids.forEach(function (id) {
      var c = AM.state.performanceCache[id];
      if (!c || !c.temMargem || CUSTOS.editando === id) return;
      repintarCustoDoItem(id);
    });
    repintarFaixaDasFamilias(ids);
    document.querySelectorAll(".am-faturamento[data-faturamento-item]").forEach(function (cel) {
      var id = cel.getAttribute("data-faturamento-item");
      if (!alvo[id]) return;
      var v = Object.prototype.hasOwnProperty.call(AM.state.faturamentoCache, id) ? AM.state.faturamentoCache[id] : null;
      var valor = Object.prototype.hasOwnProperty.call(AM.state.faturamentoValorCache, id) ? AM.state.faturamentoValorCache[id] : null;
      cel.innerHTML = faturamentoConteudoHtml(v, valor, abcItemHtml(id),
        Object.prototype.hasOwnProperty.call(AM.state.faturamentoCache, id),
        AM.state.faturamentoUnidadesCache[id], AM.state.faturamentoPrecoMedioCache[id]);
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
        bindLinhaGrupo(substituta);
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
      '<span class="am-row__num" title="Total vendido desde a criação do anúncio">' + (a.vendidos != null ? a.vendidos : "—") + "</span>" +
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

  // ===========================================================================
  // CUSTO DO PRODUTO NA LISTA — edição pontual e modo "Editar custos"
  //
  // Duas portas, de propósito separadas (protótipo aprovado):
  //  - PONTUAL: "+ Custo" (sem custo) ou "✎ R$ x" (com custo) dentro da
  //    célula Margem. Enter grava NA HORA, Esc/clique fora cancela (mesma
  //    regra do estoque: nunca grava por distração). Não pula para o próximo.
  //    Toast com "Desfazer" — a Base não guarda histórico, essa é a volta.
  //  - MASSA: botão "Editar custos" liga o modo. Cada MLB ganha um campo;
  //    nada é gravado até "Salvar N custos" (barra no rodapé). Enter desce
  //    para o campo de baixo. A margem mostrada é PRÉVIA, calculada pelo
  //    MESMO núcleo do Motor da Simulação do modal (POST .../simular-margem),
  //    nunca por uma conta feita aqui.
  //
  // Onde grava: Base de Custos do cliente, resolvida NO SERVIDOR pelo
  // contexto do Motor (POST /anuncios-meli/custos/lote) — a mesma Base de
  // Bases/Precificação/Financeiro. Custo é sempre por MLB, nunca por
  // variação. Depois de gravar, a margem do MLB é recalculada pelo Motor ao
  // vivo (GET /performance) — o snapshot da lista só se atualiza no job.
  // ===========================================================================
  var CUSTO_LOTE_MAX = 100;

  var CUSTOS = novoEstadoCustos();

  function novoEstadoCustos() {
    return {
      epoca: (CUSTOS && CUSTOS.epoca + 1) || 1,
      // itemId -> number | null (null = sem linha na Base). Ausente = não lido.
      cache: {},
      emVoo: {},
      // undefined = ainda não sei; null = sem Base pronta (motivo/mensagem);
      // objeto = Base resolvida pelo contexto do Motor.
      base: undefined,
      baseMensagem: null,
      editando: null,
      salvandoUm: {},
      modo: false,
      rascunhos: {},
      sel: {},
      erros: {},
      salvando: false,
      pergunta: null,
      soSemCusto: false,
      menuAberto: false, // menu do split "Editar custos" (Importar base de custo)
      previa: {},
      previaTimer: {},
      margemAoVivo: {},
      desfazer: null,
    };
  }

  // Troca de cliente/conta: tudo que foi lido/digitado era da conta anterior.
  function resetarCustos() {
    CUSTOS = novoEstadoCustos();
    renderBarraCustos();
    renderSavebarCustos();
  }

  function parseCusto(texto) {
    var s = String(texto == null ? "" : texto).trim().replace(/[R$\s]/g, "");
    if (!s) return { vazio: true };
    if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", ".");
    var n = Number(s);
    if (!isFinite(n) || n <= 0) return { invalido: true };
    return { n: Math.round(n * 100) / 100 };
  }

  function custoParaCampo(n) {
    return n == null ? "" : Number(n).toFixed(2).replace(".", ",");
  }

  function custoEditavel() {
    return !!(AM.clienteAtual && CUSTOS.base);
  }

  // --- Leitura -----------------------------------------------------------------
  function garantirCustos(itemIds) {
    if (!AM.clienteAtual) return;
    var faltam = [];
    (itemIds || []).forEach(function (id) {
      if (!id || CUSTOS.cache[id] !== undefined || CUSTOS.emVoo[id]) return;
      if (faltam.indexOf(id) < 0) faltam.push(id);
    });
    if (!faltam.length) {
      // Página só com famílias (ou já lida): ninguém pergunta pela Base e o
      // botão "Editar custos" ficaria escondido até expandir uma família.
      // Uma leitura sem itens só resolve a Base (o servidor aceita itemIds
      // vazio). Uma vez por conta: o flag mora no CUSTOS, recriado na troca.
      if (CUSTOS.base === undefined && !CUSTOS.sondandoBase) {
        CUSTOS.sondandoBase = true;
        lerLoteCustos([]);
      }
      return;
    }
    for (var i = 0; i < faltam.length; i += CUSTO_LOTE_MAX) {
      lerLoteCustos(faltam.slice(i, i + CUSTO_LOTE_MAX));
    }
  }

  function lerLoteCustos(ids) {
    var epoca = CUSTOS.epoca;
    ids.forEach(function (id) { CUSTOS.emVoo[id] = true; });
    var qs = "clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug) +
      "&itemIds=" + encodeURIComponent(ids.join(","));
    if (AM.contaMlId) qs += "&clienteContaId=" + encodeURIComponent(AM.contaMlId);
    api("/anuncios-meli/custos?" + qs).then(function (r) {
      if (epoca !== CUSTOS.epoca) return;
      ids.forEach(function (id) { delete CUSTOS.emVoo[id]; });
      var d = r.data || {};
      // Falha de leitura: a célula simplesmente não oferece edição — nunca
      // um "+ Custo" que sugeriria "não tem custo" sem saber.
      if (!d.ok) return;
      CUSTOS.base = d.base || null;
      CUSTOS.baseMensagem = d.base ? null : (d.mensagem || "Esta conta não tem Base de custos vinculada.");
      var custos = d.custos || {};
      ids.forEach(function (id) {
        if (d.base) CUSTOS.cache[id] = custos[id] != null ? Number(custos[id]) : null;
        repintarCustoDoItem(id);
      });
      renderBarraCustos();
      aplicarFiltroSemCusto();
    });
  }

  // --- Célula --------------------------------------------------------------------
  function custoControleHtml(itemId) {
    var inner = "";
    if (CUSTOS.modo && custoEditavel() && CUSTOS.cache[itemId] !== undefined) {
      inner = campoCustoMassaHtml(itemId);
    } else if (CUSTOS.salvandoUm[itemId]) {
      inner = '<span class="am-custo__salvando" aria-live="polite">Salvando…</span>';
    } else if (CUSTOS.editando === itemId) {
      inner = '<span class="am-custo__campo">' +
        '<span class="am-custo__prefixo" aria-hidden="true">R$</span>' +
        '<input type="text" class="am-custo__input" data-custo-inline="' + escapeAttr(itemId) + '" ' +
          'inputmode="decimal" autocomplete="off" placeholder="0,00" value="' + escapeAttr(custoParaCampo(CUSTOS.cache[itemId])) + '" ' +
          'title="Enter salva na Base de custos, Esc cancela" ' +
          'aria-label="Custo do produto. Enter salva na Base de custos, Esc cancela." />' +
        "</span>";
    } else if (custoEditavel() && CUSTOS.cache[itemId] !== undefined) {
      var c = CUSTOS.cache[itemId];
      inner = c == null
        ? '<button type="button" class="am-custo__add" data-custo-editar="' + escapeAttr(itemId) + '" ' +
            'title="Cadastrar o custo deste anúncio na Base de custos">+ Custo</button>'
        : '<button type="button" class="am-custo__btn" data-custo-editar="' + escapeAttr(itemId) + '" ' +
            'aria-label="Alterar custo (' + escapeAttr(formatMoeda(c)) + ')" title="Custo na Base: ' + escapeAttr(formatMoeda(c)) + '">' +
            icLapis(11) + "<span>" + escapeHtml(formatMoeda(c)) + "</span></button>";
    }
    return '<span class="am-custo" data-custo-item="' + escapeAttr(itemId) + '">' + inner + "</span>";
  }

  function campoCustoMassaHtml(itemId) {
    var val = CUSTOS.rascunhos[itemId] != null ? CUSTOS.rascunhos[itemId] : "";
    var r = val !== "" ? parseCusto(val) : null;
    var atual = CUSTOS.cache[itemId];
    var cls = r && r.invalido ? " is-invalid" : (r && r.n != null && r.n !== atual ? " is-dirty" : "");
    var html = '<span class="am-custo__campo' + cls + '">' +
      '<span class="am-custo__prefixo" aria-hidden="true">R$</span>' +
      '<input type="text" class="am-custo__input" data-custo-massa="' + escapeAttr(itemId) + '" ' +
        'inputmode="decimal" autocomplete="off" placeholder="' + escapeAttr(atual != null ? custoParaCampo(atual) : "0,00") + '" ' +
        'value="' + escapeAttr(val) + '"' + (CUSTOS.salvando ? " disabled" : "") +
        ' aria-label="Novo custo' + (atual != null ? " (atual " + escapeAttr(formatMoeda(atual)) + ")" : " (sem custo)") + '" />' +
      "</span>";
    html += '<span class="am-custo__atual">' + (atual != null ? "atual " + escapeHtml(formatMoeda(atual)) : "sem custo") + "</span>";
    if (r && r.invalido) html += '<span class="am-custo__erro">Use um valor maior que zero, ex.: 42,90</span>';
    if (CUSTOS.erros[itemId]) {
      html += '<span class="am-custo__erro">' + escapeHtml(CUSTOS.erros[itemId]) +
        ' <button type="button" class="am-custo__retry" data-custo-retry="' + escapeAttr(itemId) + '">Tentar de novo</button></span>';
    }
    return html;
  }

  // Margem exibida na célula: depois de gravar um custo, o valor AO VIVO do
  // Motor (o snapshot só se atualiza no job); no modo massa, com rascunho
  // válido, a PRÉVIA da simulação. Nos dois casos com rótulo explícito.
  function margemSobrepostaHtml(itemId) {
    var r = CUSTOS.modo && CUSTOS.rascunhos[itemId] != null ? parseCusto(CUSTOS.rascunhos[itemId]) : null;
    if (r && r.n != null && r.n !== CUSTOS.cache[itemId]) {
      var p = CUSTOS.previa[itemId];
      if (!p || p.valor !== r.n || p.carregando) {
        return '<span class="am-margem__vazio am-custo__previa-carregando">calculando…</span>';
      }
      if (p.pct == null) return '<span class="am-margem__estado is-neutral" title="' + escapeAttr(p.motivo || "") + '">Sem prévia</span>';
      return '<span class="am-margem__valor ' + classeMargemPct(p.pct) + '">' + formatarPercentualCompacto(p.pct) + "</span>" +
        lucroMargemHtml(p.profit, classeMargemPct(p.pct)) +
        '<span class="am-custo__tag" title="Margem simulada com o novo custo — ainda não gravada">prévia</span>';
    }
    var v = CUSTOS.margemAoVivo[itemId];
    if (v) {
      if (v.pct == null) {
        return '<span class="am-margem__estado ' + (MARGEM_CLASSE[v.status] || "is-neutral") + '">' +
          escapeHtml(MARGEM_LABEL[v.status] || "Indisponível") + "</span>";
      }
      var classeVivo = MARGEM_CLASSE[v.status] || classeMargemPct(v.pct);
      return '<span class="am-margem__valor ' + classeVivo + '">' + formatarPercentualCompacto(v.pct) + "</span>" +
        lucroMargemHtml(v.profit, classeVivo) +
        infoDotHtml("Margem recalculada agora pelo Motor com o custo novo. A lista volta a usar o snapshot no próximo cálculo.");
    }
    return margemAoVivoHtml(itemId);
  }

  // Margem AO VIVO do Motor (GET /performance): preço atual do ML + retorno
  // ML da promoção ativa. Uma resposta sem número também substitui o snapshot:
  // a leitura atual pode ter invalidado o frete usado no cálculo salvo.
  function margemAoVivoHtml(itemId) {
    var c = AM.state.performanceCache[itemId];
    var m = c && c.temMargem ? c.margem : null;
    if (c && c.temMargem && c.margemIndisponivel) return margemConteudoHtml(m, c.margemIndisponivel);
    if (!m) return null;
    if (m.marginPercent == null) return margemConteudoHtml(m, null);
    var classe = MARGEM_CLASSE[m.status] || "is-neutral";
    var tip = "Margem calculada agora pelo Motor, no preço atual do Mercado Livre" +
      (m.precoAtual != null ? " (" + formatMoeda(m.precoAtual) + ")" : "") +
      (m.rebate != null
        ? ", já com " + formatMoeda(m.rebate) + " de retorno ML" +
          (m.rebatePromocao && m.rebatePromocao.nome ? " da promoção “" + m.rebatePromocao.nome + "”" : "")
        : "") + ".";
    var anuncio = encontrarAnuncioNaTela(itemId);
    if (anuncio && anuncio.margemProjetadaComputable === true && anuncio.margemProjetadaPercent != null &&
        formatarPercentualCompacto(anuncio.margemProjetadaPercent) !== formatarPercentualCompacto(m.marginPercent)) {
      var quando = margemCalculadaEmTexto(anuncio.margemProjetadaCalculadaEm);
      tip += " O último cálculo salvo" + (quando ? " (" + quando + ")" : "") + " dava " +
        formatarPercentualCompacto(anuncio.margemProjetadaPercent) + " — é ele que a ordenação por margem usa.";
    }
    return '<span class="am-margem__valor ' + classe + '">' + formatarPercentualCompacto(m.marginPercent) + "</span>" +
      lucroMargemHtml(m.profit, classe) +
      infoDotHtml(tip);
  }

  // A simulação não devolve o status do Motor (que depende da margem alvo
  // configurada) — então a prévia só marca prejuízo, sem inventar faixa.
  function classeMargemPct(pct) {
    return pct < 0 ? "is-danger" : "is-neutral";
  }

  function encontrarCelulaMargem(itemId) {
    return document.querySelectorAll('.am-margem[data-margem-item="' + cssEscape(itemId) + '"]');
  }

  function cssEscape(v) {
    return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, "\\$&");
  }

  function repintarCustoDoItem(itemId) {
    var anuncio = encontrarAnuncioNaTela(itemId);
    encontrarCelulaMargem(itemId).forEach(function (cel) {
      var sobre = margemSobrepostaHtml(itemId);
      cel.innerHTML = (sobre != null ? sobre : (anuncio ? margemProjetadaConteudoHtml(anuncio) : "")) +
        custoControleHtml(itemId);
      cel.classList.toggle("is-modo-custos", CUSTOS.modo);
      var linha = cel.closest("[data-item]");
      if (linha) linha.classList.toggle("is-custo-erro", !!CUSTOS.erros[itemId]);
    });
  }

  function encontrarAnuncioNaTela(itemId) {
    for (var i = 0; i < AM.anuncios.length; i++) {
      if (AM.anuncios[i].tipo === "item" && AM.anuncios[i].item_id === itemId) return AM.anuncios[i];
    }
    for (var fid in AM.state.familyCache) {
      var fam = AM.state.familyCache[fid];
      var ups = (fam && fam.user_products) || [];
      for (var u = 0; u < ups.length; u++) {
        var itens = ups[u].itens || [];
        for (var k = 0; k < itens.length; k++) if (itens[k].item_id === itemId) return itens[k];
      }
    }
    return null;
  }

  function itensDeCustoNaTela(soVisiveis) {
    var ids = [];
    document.querySelectorAll("#am-catalogo-container .am-margem[data-margem-item]").forEach(function (cel) {
      // Família recolhida mantém os filhos no DOM (reabrir não refaz a
      // requisição) — eles não estão "nesta página" para o operador.
      if (soVisiveis && cel.closest(".am-grupo-painel[hidden]")) return;
      var id = cel.getAttribute("data-margem-item");
      if (ids.indexOf(id) < 0) ids.push(id);
    });
    return ids;
  }

  function repintarTodosOsCustos() {
    itensDeCustoNaTela().forEach(repintarCustoDoItem);
    aplicarFiltroSemCusto();
  }

  // Cliques/teclas dentro da célula de custo nunca chegam à linha (que abre
  // o modal) — mesmo motivo do estoque (ver bindEstoqueEditavel).
  function bindCustos(raiz) {
    if (!raiz || raiz.getAttribute("data-custos-bind") === "1") return;
    raiz.setAttribute("data-custos-bind", "1");
    raiz.addEventListener("click", function (e) {
      var alvo = e.target.closest(".am-custo, .am-custo-sel");
      if (!alvo) return;
      e.stopPropagation();
      var editar = e.target.closest("[data-custo-editar]");
      if (editar) { abrirCustoInline(editar.getAttribute("data-custo-editar")); return; }
      var retry = e.target.closest("[data-custo-retry]");
      if (retry) { delete CUSTOS.erros[retry.getAttribute("data-custo-retry")]; salvarCustosEmMassa(); }
    }, true);
    raiz.addEventListener("keydown", function (e) {
      var t = e.target;
      if (!t.closest || !t.closest(".am-custo, .am-custo-sel")) return;
      // stopPropagation ANTES de mexer no DOM: a linha trata Enter como
      // "abrir o modal" e o Esc global fecha o modal (ver salvarEstoque).
      e.stopPropagation();
      if (t.hasAttribute("data-custo-inline")) {
        if (e.key === "Enter") { e.preventDefault(); salvarCustoInline(t.getAttribute("data-custo-inline"), t.value); }
        else if (e.key === "Escape") { e.preventDefault(); fecharCustoInline(); }
        return;
      }
      if (t.hasAttribute("data-custo-massa") && e.key === "Enter") {
        e.preventDefault();
        var campos = Array.prototype.slice.call(document.querySelectorAll("#am-catalogo-container [data-custo-massa]"))
          .filter(function (c) { return c.offsetParent !== null; });
        var prox = campos[campos.indexOf(t) + 1];
        if (prox) prox.focus();
      }
    }, true);
    raiz.addEventListener("input", function (e) {
      var t = e.target;
      if (!t.hasAttribute || !t.hasAttribute("data-custo-massa")) return;
      var id = t.getAttribute("data-custo-massa");
      if (t.value.trim() === "") delete CUSTOS.rascunhos[id];
      else CUSTOS.rascunhos[id] = t.value;
      delete CUSTOS.erros[id];
      if (CUSTOS.pergunta) CUSTOS.pergunta = null;
      var r = t.value.trim() ? parseCusto(t.value) : null;
      var campo = t.closest(".am-custo__campo");
      if (campo) {
        campo.classList.toggle("is-invalid", !!(r && r.invalido));
        campo.classList.toggle("is-dirty", !!(r && r.n != null && r.n !== CUSTOS.cache[id]));
      }
      atualizarMargemDaLinhaSemPerderFoco(id);
      agendarPrevia(id);
      renderSavebarCustos();
    });
    raiz.addEventListener("change", function (e) {
      var t = e.target;
      if (!t.hasAttribute || !t.hasAttribute("data-custo-sel")) return;
      var id = t.getAttribute("data-custo-sel");
      CUSTOS.sel[id] = t.checked;
      var linha = t.closest("[data-item]");
      if (linha) linha.classList.toggle("is-custo-sel", t.checked);
      renderBarraCustos();
    });
    raiz.addEventListener("focusout", function (e) {
      var t = e.target;
      if (!t.hasAttribute || !t.hasAttribute("data-custo-inline")) return;
      // Sair do campo CANCELA, nunca salva — gravar por distração seria
      // efeito colateral numa lista de centenas de anúncios.
      var id = t.getAttribute("data-custo-inline");
      setTimeout(function () {
        if (CUSTOS.editando === id && !CUSTOS.salvandoUm[id]) fecharCustoInline();
      }, 120);
    });
  }

  // Repinta só o valor de margem da célula, mantendo o campo em foco.
  function atualizarMargemDaLinhaSemPerderFoco(itemId) {
    encontrarCelulaMargem(itemId).forEach(function (cel) {
      var custo = cel.querySelector(".am-custo");
      var anuncio = encontrarAnuncioNaTela(itemId);
      var sobre = margemSobrepostaHtml(itemId);
      Array.prototype.slice.call(cel.childNodes).forEach(function (n) { if (n !== custo) cel.removeChild(n); });
      var tmp = document.createElement("span");
      tmp.innerHTML = sobre != null ? sobre : (anuncio ? margemProjetadaConteudoHtml(anuncio) : "");
      while (tmp.firstChild) cel.insertBefore(tmp.firstChild, custo);
      var erroCampo = custo && custo.querySelector(".am-custo__erro");
      var r = CUSTOS.rascunhos[itemId] != null ? parseCusto(CUSTOS.rascunhos[itemId]) : null;
      if (custo) {
        if (r && r.invalido && !erroCampo) {
          custo.insertAdjacentHTML("beforeend", '<span class="am-custo__erro">Use um valor maior que zero, ex.: 42,90</span>');
        } else if (!(r && r.invalido) && erroCampo && !CUSTOS.erros[itemId]) {
          erroCampo.parentNode.removeChild(erroCampo);
        }
      }
      var linha = cel.closest("[data-item]");
      if (linha) linha.classList.remove("is-custo-erro");
    });
  }

  // --- Edição pontual ------------------------------------------------------------
  function abrirCustoInline(itemId) {
    if (!custoEditavel() || CUSTOS.modo) return;
    var anterior = CUSTOS.editando;
    CUSTOS.editando = itemId;
    if (anterior && anterior !== itemId) repintarCustoDoItem(anterior);
    repintarCustoDoItem(itemId);
    var input = document.querySelector('[data-custo-inline="' + cssEscape(itemId) + '"]');
    if (input) { input.focus(); input.select(); }
  }

  function fecharCustoInline() {
    var id = CUSTOS.editando;
    CUSTOS.editando = null;
    if (id) repintarCustoDoItem(id);
  }

  function salvarCustoInline(itemId, bruto) {
    var r = parseCusto(bruto);
    var atual = CUSTOS.cache[itemId];
    if (r.vazio || r.n === atual) { fecharCustoInline(); return; }
    if (r.invalido) {
      toast("Use um custo maior que zero, ex.: 42,90.", "is-danger");
      return;
    }
    CUSTOS.editando = null;
    CUSTOS.salvandoUm[itemId] = true;
    repintarCustoDoItem(itemId);
    enviarCustos([{ itemId: itemId, custo: r.n }]).then(function (res) {
      delete CUSTOS.salvandoUm[itemId];
      var item = res.porItem[itemId];
      if (!item || !item.ok) {
        repintarCustoDoItem(itemId);
        toast((item && item.motivo) || res.motivo || "Não foi possível salvar o custo.", "is-danger");
        return;
      }
      aplicarCustoGravado(itemId, item.custo);
      var anuncio = encontrarAnuncioNaTela(itemId);
      var nome = anuncio && anuncio.titulo ? anuncio.titulo : itemId;
      toastComAcao("Custo salvo na Base · " + (nome.length > 34 ? nome.slice(0, 34) + "…" : nome), "Desfazer", function () {
        desfazerCusto(itemId, item.custoAnterior);
      });
    });
  }

  function desfazerCusto(itemId, custoAnterior) {
    CUSTOS.salvandoUm[itemId] = true;
    repintarCustoDoItem(itemId);
    var pedido = custoAnterior == null ? { itemId: itemId, remover: true } : { itemId: itemId, custo: custoAnterior };
    enviarCustos([pedido]).then(function (res) {
      delete CUSTOS.salvandoUm[itemId];
      var item = res.porItem[itemId];
      if (!item || !item.ok) {
        repintarCustoDoItem(itemId);
        toast((item && item.motivo) || res.motivo || "Não foi possível desfazer.", "is-danger");
        return;
      }
      aplicarCustoGravado(itemId, custoAnterior == null ? null : item.custo);
      toast("Custo anterior restaurado.", "is-info");
    });
  }

  // --- Gravação (pontual e massa usam o MESMO endpoint) ----------------------------
  function enviarCustos(itens) {
    var corpo = { clienteSlug: AM.clienteAtual.slug, itens: itens };
    if (AM.contaMlId) corpo.clienteContaId = AM.contaMlId;
    var epoca = CUSTOS.epoca;
    return api("/anuncios-meli/custos/lote", { method: "POST", body: corpo }).then(function (r) {
      var d = r.data || {};
      var porItem = {};
      (d.resultados || []).forEach(function (x) { if (!porItem[x.itemId]) porItem[x.itemId] = x; });
      // O card "Sem custo" conta pela Base: recarrega só o resumo (a lista
      // fica como está, para não tirar da tela a linha que acabou de mudar).
      var mudou = (d.resultados || []).some(function (x) { return x.ok && x.acao !== "inalterado"; });
      if (mudou && epoca === CUSTOS.epoca) carregarResumo();
      return { ok: !!d.ok, motivo: d.motivo, porItem: porItem, valido: epoca === CUSTOS.epoca };
    });
  }

  function aplicarCustoGravado(itemId, custo) {
    CUSTOS.cache[itemId] = custo == null ? null : Number(custo);
    delete CUSTOS.previa[itemId];
    repintarCustoDoItem(itemId);
    recalcularMargemAoVivo([itemId]);
  }

  // A célula da lista lê o SNAPSHOT de margem, que só se atualiza no job.
  // Depois de gravar, pede ao Motor a margem AO VIVO só destes MLB.
  function recalcularMargemAoVivo(ids) {
    var epoca = CUSTOS.epoca;
    for (var i = 0; i < ids.length; i += PERFORMANCE_LOTE_MAX) {
      (function (lote) {
        var qs = "clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug) +
          "&itemIds=" + encodeURIComponent(lote.join(",")) + "&incluirMetricas=0&incluirMargem=1&incluirRebateAtivo=1";
        if (AM.contaMlId) qs += "&clienteContaId=" + encodeURIComponent(AM.contaMlId);
        api("/anuncios-meli/performance?" + qs).then(function (r) {
          if (epoca !== CUSTOS.epoca) return;
          var margem = (r.data && r.data.ok && r.data.margem) || {};
          lote.forEach(function (id) {
            var m = margem[id];
            if (!m) return;
            CUSTOS.margemAoVivo[id] = { pct: m.marginPercent, status: m.status, profit: m.profit };
            // O modal e o preço ao vivo leem este mesmo cache.
            var pc = AM.state.performanceCache[id] || (AM.state.performanceCache[id] = {});
            pc.margem = m;
            pc.temMargem = true;
            repintarCustoDoItem(id);
          });
        });
      })(ids.slice(i, i + PERFORMANCE_LOTE_MAX));
    }
  }

  function toastComAcao(msg, rotulo, acao) {
    var stack = el("am-toast-stack");
    if (!stack) return;
    var t = document.createElement("div");
    t.className = "vf-toast is-success am-toast-acao";
    t.setAttribute("role", "status");
    t.innerHTML = '<div class="vf-toast__content"><p class="vf-toast__description">' + escapeHtml(msg) + "</p></div>" +
      '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm am-toast-acao__btn">' + icDesfazer(12) + " " + escapeHtml(rotulo) + "</button>";
    var usado = false;
    t.querySelector("button").addEventListener("click", function () {
      if (usado) return;
      usado = true;
      if (t.parentNode) t.parentNode.removeChild(t);
      acao();
    });
    stack.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 6000);
  }

  // --- Modo massa ----------------------------------------------------------------
  function pendentesCustos() {
    return Object.keys(CUSTOS.rascunhos).filter(function (id) {
      var r = parseCusto(CUSTOS.rascunhos[id]);
      return r.n != null && r.n !== CUSTOS.cache[id];
    });
  }

  function temRascunhoInvalido() {
    return Object.keys(CUSTOS.rascunhos).some(function (id) { return parseCusto(CUSTOS.rascunhos[id]).invalido; });
  }

  function selecionadosCustos() {
    return Object.keys(CUSTOS.sel).filter(function (id) { return CUSTOS.sel[id]; });
  }

  function entrarModoCustos() {
    if (!custoEditavel()) return;
    CUSTOS.editando = null;
    CUSTOS.modo = true;
    aplicarModoNaLista();
    renderBarraCustos();
    renderSavebarCustos();
    var primeiro = document.querySelector("#am-catalogo-container [data-custo-massa]");
    if (primeiro) primeiro.focus();
  }

  function sairModoCustos(forcar) {
    if (!forcar && pendentesCustos().length) {
      CUSTOS.pergunta = { tipo: "sair" };
      renderSavebarCustos();
      return;
    }
    CUSTOS.modo = false;
    CUSTOS.rascunhos = {};
    CUSTOS.sel = {};
    CUSTOS.erros = {};
    CUSTOS.previa = {};
    CUSTOS.pergunta = null;
    CUSTOS.soSemCusto = false;
    aplicarModoNaLista();
    renderBarraCustos();
    renderSavebarCustos();
  }

  function aplicarModoNaLista() {
    var lista = document.querySelector("#am-catalogo-container .am-listagem");
    if (lista) lista.classList.toggle("is-modo-custos", CUSTOS.modo);
    document.querySelectorAll("#am-catalogo-container [data-item]").forEach(function (linha) {
      var id = linha.getAttribute("data-item");
      var acao = linha.querySelector(".am-row__acao, .am-mlb__acao");
      var sel = linha.querySelector(".am-custo-sel");
      if (!linha.querySelector('.am-margem[data-margem-item]')) return;
      if (CUSTOS.modo && !sel && acao) {
        acao.insertAdjacentHTML("afterbegin",
          '<label class="am-custo-sel"><input type="checkbox" data-custo-sel="' + escapeAttr(id) + '"' +
          (CUSTOS.sel[id] ? " checked" : "") + ' aria-label="Selecionar este anúncio" /></label>');
      } else if (!CUSTOS.modo && sel) {
        sel.parentNode.removeChild(sel);
      }
      linha.classList.toggle("is-custo-sel", CUSTOS.modo && !!CUSTOS.sel[id]);
    });
    repintarTodosOsCustos();
  }

  // "Só sem custo": filtro LOCAL da página carregada (e das famílias
  // abertas) — esconde MLB que já têm custo na Base e nada pendente.
  function aplicarFiltroSemCusto() {
    document.querySelectorAll("#am-catalogo-container [data-item]").forEach(function (linha) {
      var id = linha.getAttribute("data-item");
      if (!linha.querySelector(".am-margem[data-margem-item]")) return;
      var esconder = CUSTOS.modo && CUSTOS.soSemCusto && CUSTOS.cache[id] != null &&
        CUSTOS.rascunhos[id] == null && !CUSTOS.erros[id];
      linha.classList.toggle("am-custo-oculta", esconder);
    });
  }

  function agendarPrevia(itemId) {
    clearTimeout(CUSTOS.previaTimer[itemId]);
    var r = CUSTOS.rascunhos[itemId] != null ? parseCusto(CUSTOS.rascunhos[itemId]) : null;
    if (!r || r.n == null || r.n === CUSTOS.cache[itemId]) return;
    CUSTOS.previaTimer[itemId] = setTimeout(function () { pedirPrevia(itemId, r.n); }, 450);
  }

  // Prévia pelo MESMO núcleo do Motor da Simulação do modal — nunca uma
  // fórmula local. Só preço/custo podem ser simulados; comissão, frete e
  // imposto são sempre os do Motor.
  function pedirPrevia(itemId, valor) {
    var epoca = CUSTOS.epoca;
    CUSTOS.previa[itemId] = { valor: valor, carregando: true };
    var corpo = { clienteSlug: AM.clienteAtual.slug, custoProduto: valor };
    if (AM.contaMlId) corpo.clienteContaId = AM.contaMlId;
    api("/anuncios-meli/" + encodeURIComponent(itemId) + "/simular-margem", { method: "POST", body: corpo }).then(function (r) {
      if (epoca !== CUSTOS.epoca) return;
      var atual = CUSTOS.previa[itemId];
      if (!atual || atual.valor !== valor) return; // digitou outro valor no meio
      var d = r.data || {};
      var res = d.resultado || {};
      CUSTOS.previa[itemId] = {
        valor: valor,
        pct: d.ok && res.computable && res.marginPercent != null ? res.marginPercent : null,
        profit: d.ok && res.computable && res.profit != null ? res.profit : null,
        motivo: d.ok ? (res.missing && res.missing.length ? "Faltam dados do Motor: " + res.missing.join(", ") : "") : (d.motivo || ""),
      };
      atualizarMargemDaLinhaSemPerderFoco(itemId);
    });
  }

  function aplicarAosSelecionados() {
    var campo = el("am-custos-lote");
    var r = parseCusto(campo ? campo.value : "");
    if (r.n == null) {
      if (campo) { campo.focus(); campo.closest(".am-custo__campo").classList.add("is-invalid"); }
      return;
    }
    var valor = custoParaCampo(r.n);
    selecionadosCustos().forEach(function (id) {
      CUSTOS.rascunhos[id] = valor;
      delete CUSTOS.erros[id];
      agendarPrevia(id);
    });
    CUSTOS.sel = {};
    aplicarModoNaLista();
    renderBarraCustos();
    renderSavebarCustos();
  }

  function salvarCustosEmMassa(depois) {
    var ids = pendentesCustos();
    if (!ids.length) { if (depois) depois(); return; }
    if (temRascunhoInvalido()) return;
    CUSTOS.salvando = true;
    CUSTOS.pergunta = null;
    renderSavebarCustos();
    repintarTodosOsCustos();
    var itens = ids.map(function (id) { return { itemId: id, custo: parseCusto(CUSTOS.rascunhos[id]).n }; });
    var lotes = [];
    for (var i = 0; i < itens.length; i += CUSTO_LOTE_MAX) lotes.push(itens.slice(i, i + CUSTO_LOTE_MAX));
    Promise.all(lotes.map(enviarCustos)).then(function (resps) {
      if (resps.some(function (x) { return !x.valido; })) return;
      var porItem = {};
      var motivoGeral = null;
      resps.forEach(function (x) {
        for (var k in x.porItem) porItem[k] = x.porItem[k];
        if (!x.ok) motivoGeral = x.motivo || "Não foi possível salvar os custos.";
      });
      var ok = [];
      ids.forEach(function (id) {
        var item = porItem[id];
        if (item && item.ok) {
          CUSTOS.cache[id] = Number(item.custo);
          delete CUSTOS.rascunhos[id];
          delete CUSTOS.erros[id];
          delete CUSTOS.previa[id];
          ok.push(id);
        } else {
          CUSTOS.erros[id] = (item && item.motivo) || motivoGeral || "Não foi salvo.";
        }
      });
      CUSTOS.salvando = false;
      var falhas = ids.length - ok.length;
      repintarTodosOsCustos();
      renderBarraCustos();
      renderSavebarCustos();
      if (ok.length) recalcularMargemAoVivo(ok);
      if (ok.length || !falhas) {
        toast(ok.length + (ok.length === 1 ? " custo salvo na Base" : " custos salvos na Base") +
          (falhas ? " · " + falhas + (falhas === 1 ? " falhou" : " falharam") : "") + ".", falhas ? "is-warning" : "is-success");
      } else {
        toast(motivoGeral || "Nenhum custo foi salvo. Veja as linhas em vermelho.", "is-danger");
      }
      if (depois && !falhas) depois();
    });
  }

  // Paginação com rascunho pendente: pergunta na própria barra de salvar.
  function irParaPaginaComCustos(pagina, irPara) {
    if (CUSTOS.modo && pendentesCustos().length) {
      CUSTOS.pergunta = { tipo: "pagina", destino: function () { irPara(pagina); } };
      renderSavebarCustos();
      return;
    }
    irPara(pagina);
  }

  function concluirPerguntaCustos() {
    var p = CUSTOS.pergunta;
    CUSTOS.pergunta = null;
    if (!p) return;
    if (p.tipo === "pagina") { renderSavebarCustos(); p.destino(); }
    else sairModoCustos(true);
  }

  function descartarRascunhosCustos() {
    CUSTOS.rascunhos = {};
    CUSTOS.erros = {};
    CUSTOS.previa = {};
  }

  // --- Barras ----------------------------------------------------------------------
  function renderBarraCustos() {
    atualizarBotaoRebate();
    var box = el("am-custos-barra");
    if (!box) return;
    var slot = el("am-custos-acoes-slot");
    if (slot) slot.innerHTML = "";
    var indisponivel = !custoEditavel();
    box.innerHTML = "";

    if (CUSTOS.base === null) {
      box.innerHTML = '<div class="vf-alert is-info am-custos-aviso" role="status">' +
        "<span>" + escapeHtml(CUSTOS.baseMensagem || "Esta conta não tem Base de custos vinculada.") +
        " Sem Base, a margem não é calculada e o custo não pode ser editado aqui.</span>" +
        '<a class="vf-btn vf-btn--secondary vf-btn--sm" href="bases.html">Vincular base</a></div>';
      return;
    }

    if (!CUSTOS.modo) {
      var semCusto = itensDeCustoNaTela(true).filter(function (id) { return CUSTOS.cache[id] === null; }).length;
      // Na linha da busca quando há o slot; senão, na barra própria.
      var alvo = slot || box;
      if (slot && CUSTOS.base !== null) box.innerHTML = "";
      // Split (modelo B aprovado): o corpo entra em "Editar custos", a seta
      // abre o menu com "Importar base de custo". O aviso "N sem custo nesta
      // página" vira a segunda linha do botão. Altura inteira da barra, ao
      // lado do Radar de subsídios.
      alvo.innerHTML = '<div class="am-custos-acoes">' +
        '<div class="am-custos-split">' +
          '<button type="button" class="am-custos-split__main" data-custos-acao="entrar"' + (indisponivel ? ' disabled' : '') + '>' +
            '<span class="am-custos-split__ico" aria-hidden="true">' + icLapis(16) + "</span>" +
            '<span class="am-custos-split__txt"><span class="am-custos-split__titulo">Editar custos</span>' +
              (semCusto ? '<span class="am-custos-split__sub am-custos-acoes__aviso" title="Anúncios desta página sem custo na Base">' +
                semCusto + " sem custo nesta página</span>"
                : '<span class="am-custos-split__sub">Custo do produto na Base</span>') +
            "</span></button>" +
          '<button type="button" class="am-custos-split__seta" data-custos-acao="menu" aria-label="Mais opções de custo"' +
            (indisponivel ? ' disabled' : '') + ' aria-haspopup="menu" aria-expanded="' + (CUSTOS.menuAberto ? "true" : "false") + '" aria-controls="am-custos-menu">' +
            '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>' +
          "</button>" +
        "</div>" +
        '<div class="am-custos-menu vf-menu" id="am-custos-menu" role="menu"' + (CUSTOS.menuAberto ? "" : " hidden") + ">" +
          '<button type="button" class="am-custos-menu__opc" role="menuitem" data-custos-acao="importar">' +
            '<span class="am-custos-menu__ico" aria-hidden="true">' + icPlanilha(16) + "</span>" +
            '<span><span class="am-custos-menu__titulo">Importar base de custo</span>' +
            '<span class="am-custos-menu__desc">Baixe a planilha com todos os MLB, preencha e envie. Célula vazia não apaga nada.</span></span></button>' +
          '<div class="am-custos-menu__sep" role="separator"></div>' +
          '<button type="button" class="am-custos-menu__opc" role="menuitem" data-custos-acao="entrar">' +
            '<span class="am-custos-menu__ico" aria-hidden="true">' + icLapis(16) + "</span>" +
            '<span><span class="am-custos-menu__titulo">Editar custos na lista</span>' +
            '<span class="am-custos-menu__desc">Mesmo que clicar no botão.</span></span></button>' +
        "</div>" +
        "</div>";
      return;
    }

    var sel = selecionadosCustos();
    var html = '<div class="am-custos-modo" role="region" aria-label="Edição de custos">' +
      '<span class="am-custos-modo__titulo">' + icLapis(13) + " Editando custos</span>" +
      '<span class="am-custos-modo__dica">Digite o novo custo de cada anúncio. Nada é gravado na Base até você clicar em Salvar.</span>' +
      '<label class="am-custos-modo__check"><input type="checkbox" id="am-custos-so-sem"' + (CUSTOS.soSemCusto ? " checked" : "") +
        "> Só sem custo (nesta página)</label>" +
      '<button type="button" class="vf-btn vf-btn--sm am-custos-modo__btn" data-custos-acao="selecionar-pagina">Selecionar página</button>' +
      '<button type="button" class="vf-btn vf-btn--sm am-custos-modo__btn" data-custos-acao="sair">Sair</button>' +
    "</div>";
    if (sel.length) {
      var sobrescreve = sel.filter(function (id) {
        var r = CUSTOS.rascunhos[id] != null ? parseCusto(CUSTOS.rascunhos[id]) : null;
        return CUSTOS.cache[id] != null || (r && r.n != null);
      }).length;
      var anterior = el("am-custos-lote") ? el("am-custos-lote").value : "";
      html += '<div class="am-custos-sel">' +
        '<span class="am-custos-sel__total">' + sel.length + (sel.length > 1 ? " selecionados" : " selecionado") + "</span>" +
        '<span class="am-custo__campo"><span class="am-custo__prefixo" aria-hidden="true">R$</span>' +
          '<input type="text" class="am-custo__input" id="am-custos-lote" inputmode="decimal" autocomplete="off" placeholder="0,00" ' +
          'aria-label="Custo para os selecionados" value="' + escapeAttr(anterior) + '"></span>' +
        '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-custos-acao="aplicar">Aplicar aos selecionados</button>' +
        '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-custos-acao="limpar-sel">Limpar seleção</button>' +
        (sobrescreve ? '<span class="am-custos-sel__aviso">' + sobrescreve +
          (sobrescreve > 1 ? " deles já têm custo e serão sobrescritos." : " deles já tem custo e será sobrescrito.") + "</span>" : "") +
      "</div>";
    }
    box.innerHTML = html;
  }

  function renderSavebarCustos() {
    var bar = el("am-custos-savebar");
    if (!bar) return;
    var n = pendentesCustos().length;
    var nErr = Object.keys(CUSTOS.erros).length;
    var on = CUSTOS.modo && (n > 0 || nErr > 0 || CUSTOS.salvando || !!CUSTOS.pergunta);
    bar.classList.toggle("is-on", on);
    bar.classList.toggle("is-ask", !!CUSTOS.pergunta);
    document.body.classList.toggle("am-custos-savebar-on", on);
    if (!on) { bar.innerHTML = ""; return; }
    var inn;
    var rotuloN = n + (n === 1 ? " custo" : " custos");
    if (CUSTOS.salvando) {
      inn = '<div class="am-custos-savebar__msg"><span class="vf-spinner" aria-hidden="true"></span> Salvando ' + rotuloN + " na Base…</div>";
    } else if (CUSTOS.pergunta) {
      var destino = CUSTOS.pergunta.tipo === "pagina" ? "mudar de página" : "sair da edição";
      inn = '<div class="am-custos-savebar__msg">Salvar ' + rotuloN + " antes de " + destino + "?" +
          "<small>Se descartar, os valores digitados se perdem.</small></div>" +
        '<button type="button" class="vf-btn vf-btn--ghost" data-custos-acao="cancelar-pergunta">Continuar editando</button>' +
        '<button type="button" class="vf-btn vf-btn--secondary" data-custos-acao="descartar-continuar">Descartar</button>' +
        '<button type="button" class="vf-btn vf-btn--primary" data-custos-acao="salvar-continuar"' + (temRascunhoInvalido() ? " disabled" : "") + ">Salvar e continuar</button>";
    } else {
      var msg = n ? n + (n === 1 ? " custo alterado" : " custos alterados") : "Nenhuma alteração pendente";
      var sub = nErr
        ? '<small class="is-erro">' + nErr + (nErr > 1 ? " não foram salvos" : " não foi salvo") + " — veja as linhas em vermelho.</small>"
        : temRascunhoInvalido()
          ? '<small class="is-erro">Corrija os valores inválidos para salvar.</small>'
          : "<small>A margem mostrada é prévia até você salvar. O custo vale para Bases, Precificação, Financeiro e Simulação.</small>";
      inn = '<div class="am-custos-savebar__msg">' + msg + sub + "</div>" +
        '<button type="button" class="vf-btn vf-btn--ghost" data-custos-acao="descartar"' + (n || nErr ? "" : " disabled") + ">Descartar</button>" +
        '<button type="button" class="vf-btn vf-btn--primary" data-custos-acao="salvar"' + (n && !temRascunhoInvalido() ? "" : " disabled") + ">Salvar " + rotuloN + "</button>";
    }
    bar.innerHTML = '<div class="am-custos-savebar__in">' + inn + "</div>";
  }

  function bindBarrasCustos() {
    function onClick(e) {
      var b = e.target.closest("[data-custos-acao]");
      if (!b || b.disabled) return;
      var acao = b.getAttribute("data-custos-acao");
      if (acao === "menu") { alternarMenuCustos(!CUSTOS.menuAberto); return; }
      if (CUSTOS.menuAberto) alternarMenuCustos(false, true);
      switch (acao) {
        case "entrar": entrarModoCustos(); break;
        case "importar": abrirImportacaoCustos(); break;
        case "sair": sairModoCustos(false); break;
        case "selecionar-pagina":
          document.querySelectorAll("#am-catalogo-container [data-custo-sel]").forEach(function (c) {
            var linha = c.closest("[data-item]");
            if (linha && linha.classList.contains("am-custo-oculta")) return;
            CUSTOS.sel[c.getAttribute("data-custo-sel")] = true;
          });
          aplicarModoNaLista();
          renderBarraCustos();
          if (el("am-custos-lote")) el("am-custos-lote").focus();
          break;
        case "aplicar": aplicarAosSelecionados(); break;
        case "limpar-sel": CUSTOS.sel = {}; aplicarModoNaLista(); renderBarraCustos(); break;
        case "salvar": salvarCustosEmMassa(); break;
        case "descartar": descartarRascunhosCustos(); repintarTodosOsCustos(); renderSavebarCustos(); break;
        case "cancelar-pergunta": CUSTOS.pergunta = null; renderSavebarCustos(); break;
        case "descartar-continuar": descartarRascunhosCustos(); repintarTodosOsCustos(); concluirPerguntaCustos(); break;
        case "salvar-continuar": {
          var p = CUSTOS.pergunta;
          salvarCustosEmMassa(function () { CUSTOS.pergunta = p; concluirPerguntaCustos(); });
          break;
        }
      }
    }
    var barra = el("am-custos-barra");
    var savebar = el("am-custos-savebar");
    var slot = el("am-custos-acoes-slot");
    if (slot) slot.addEventListener("click", onClick);
    if (barra) {
      barra.addEventListener("click", onClick);
      barra.addEventListener("change", function (e) {
        if (e.target.id === "am-custos-so-sem") { CUSTOS.soSemCusto = e.target.checked; aplicarFiltroSemCusto(); }
      });
      barra.addEventListener("keydown", function (e) {
        if (e.target.id === "am-custos-lote" && e.key === "Enter") { e.preventDefault(); aplicarAosSelecionados(); }
      });
      barra.addEventListener("input", function (e) {
        if (e.target.id === "am-custos-lote") {
          var campo = e.target.closest(".am-custo__campo");
          if (campo) campo.classList.remove("is-invalid");
        }
      });
    }
    if (savebar) savebar.addEventListener("click", onClick);
    // Menu do split: fecha com clique fora e com Esc (foco volta à seta).
    document.addEventListener("click", function (e) {
      if (CUSTOS.menuAberto && !e.target.closest(".am-custos-acoes")) alternarMenuCustos(false, true);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && CUSTOS.menuAberto) { alternarMenuCustos(false); }
    });
  }

  // Abre/fecha o menu do split sem repintar a barra inteira. `semFoco` evita
  // roubar o foco quando o fechamento vem de outra ação.
  function alternarMenuCustos(abrir, semFoco) {
    CUSTOS.menuAberto = !!abrir;
    var menu = el("am-custos-menu");
    var seta = document.querySelector('[data-custos-acao="menu"]');
    if (menu) menu.hidden = !abrir;
    if (seta) seta.setAttribute("aria-expanded", abrir ? "true" : "false");
    if (abrir && menu) { var primeiro = menu.querySelector("[role=menuitem]"); if (primeiro) primeiro.focus(); }
    else if (!abrir && !semFoco && seta) seta.focus();
  }

  // ===========================================================================
  // IMPORTAR BASE DE CUSTO — planilha da conta inteira
  //
  // Mesmo fluxo da correção em lote do Financeiro, mas com TODOS os anúncios
  // da conta (com e sem custo):
  //   1. Baixar   GET  /anuncios-meli/custos/planilha (custo atual preenchido)
  //   2. Enviar   POST /anuncios-meli/custos/planilha/previa — só lê e diz o
  //               que mudaria (atualizar / adicionar / igual / recusada)
  //   3. Gravar   POST /anuncios-meli/custos/lote, de 100 em 100 — a MESMA
  //               porta da edição na lista (revalida tudo, loga, enfileira o
  //               Margin Snapshot)
  // Célula de custo vazia é ignorada: a importação nunca zera nem apaga.
  // ===========================================================================
  var IMP = null;

  function qsContaCustos() {
    var qs = "clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug);
    if (AM.contaMlId) qs += "&clienteContaId=" + encodeURIComponent(AM.contaMlId);
    return qs;
  }

  function abrirImportacaoCustos() {
    if (!AM.clienteAtual || !CUSTOS.base || IMP) return;
    var overlay = document.createElement("div");
    overlay.className = "am-imp-overlay vf-overlay is-open";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "am-imp-titulo");
    overlay.innerHTML = '<div class="am-imp-box vf-modal vf-modal--lg"></div>';
    document.body.appendChild(overlay);
    document.body.classList.add("vf-no-scroll");
    IMP = {
      overlay: overlay, epoca: CUSTOS.epoca, baixando: false, lendo: false, arquivo: null,
      previa: null, erro: null, gravando: false, progresso: 0, resultado: null,
    };

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay && !IMP.gravando) { fecharImportacaoCustos(); return; }
      var b = e.target.closest("[data-imp-acao]");
      if (!b || b.disabled) return;
      switch (b.getAttribute("data-imp-acao")) {
        case "fechar": fecharImportacaoCustos(); break;
        case "baixar": baixarPlanilhaCustos(); break;
        case "escolher": overlay.querySelector("#am-imp-arquivo").click(); break;
        case "gravar": gravarImportacaoCustos(); break;
      }
    });
    overlay.addEventListener("change", function (e) {
      if (e.target.id === "am-imp-arquivo" && e.target.files && e.target.files[0]) lerPlanilhaCustos(e.target.files[0]);
    });
    overlay.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !IMP.gravando) fecharImportacaoCustos();
    });
    renderImportacaoCustos();
    var primeiro = overlay.querySelector('[data-imp-acao="baixar"]');
    if (primeiro) primeiro.focus();
  }

  function fecharImportacaoCustos() {
    if (!IMP) return;
    if (IMP.overlay.parentNode) IMP.overlay.parentNode.removeChild(IMP.overlay);
    document.body.classList.remove("vf-no-scroll");
    IMP = null;
  }

  function baixarPlanilhaCustos() {
    var imp = IMP;
    imp.baixando = true;
    imp.erro = null;
    renderImportacaoCustos();
    fetch(API_BASE + "/anuncios-meli/custos/planilha?" + qsContaCustos(), {
      headers: { Authorization: "Bearer " + (AM.token || "") },
    }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          throw new Error(d.motivo || "Não foi possível gerar a planilha (HTTP " + r.status + ").");
        });
      }
      var m = /filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") || "");
      return r.blob().then(function (blob) { return { blob: blob, nome: m ? m[1] : "custos-anuncios-ml.xlsx" }; });
    }).then(function (x) {
      var url = URL.createObjectURL(x.blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = x.nome;
      document.body.appendChild(a);
      a.click();
      a.parentNode.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }).catch(function (err) {
      imp.erro = err && err.message ? err.message : "Falha de conexão.";
    }).then(function () {
      imp.baixando = false;
      if (IMP === imp) renderImportacaoCustos();
    });
  }

  function lerPlanilhaCustos(arquivo) {
    var imp = IMP;
    imp.arquivo = arquivo;
    imp.previa = null;
    imp.resultado = null;
    imp.erro = null;
    if (!/\.(xlsx|xls|csv)$/i.test(arquivo.name)) {
      imp.erro = "Arquivo inválido. Envie .xlsx, .xls ou .csv.";
      renderImportacaoCustos();
      return;
    }
    imp.lendo = true;
    renderImportacaoCustos();
    var form = new FormData();
    form.append("arquivo", arquivo);
    fetch(API_BASE + "/anuncios-meli/custos/planilha/previa?" + qsContaCustos(), {
      method: "POST",
      headers: { Authorization: "Bearer " + (AM.token || "") },
      body: form,
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || !d.ok) throw new Error(d.motivo || "Não foi possível ler a planilha (HTTP " + r.status + ").");
        return d;
      });
    }).then(function (d) {
      imp.previa = d;
    }).catch(function (err) {
      imp.erro = err && err.message ? err.message : "Falha de conexão.";
    }).then(function () {
      imp.lendo = false;
      if (IMP === imp) renderImportacaoCustos();
    });
  }

  function linhasParaGravar(previa) {
    return ((previa && previa.linhas) || []).filter(function (l) { return l.acao === "atualizar" || l.acao === "adicionar"; });
  }

  function gravarImportacaoCustos() {
    var imp = IMP;
    var linhas = linhasParaGravar(imp.previa);
    if (!linhas.length) return;
    imp.gravando = true;
    imp.progresso = 0;
    renderImportacaoCustos();
    var res = { gravados: 0, falhas: [] };
    var lotes = [];
    for (var i = 0; i < linhas.length; i += CUSTO_LOTE_MAX) lotes.push(linhas.slice(i, i + CUSTO_LOTE_MAX));

    function proximo(k) {
      if (k >= lotes.length) {
        imp.gravando = false;
        imp.resultado = res;
        if (IMP === imp) renderImportacaoCustos();
        return;
      }
      var lote = lotes[k];
      enviarCustos(lote.map(function (l) { return { itemId: l.itemId, custo: l.custo }; })).then(function (r) {
        lote.forEach(function (l) {
          var x = r.porItem[l.itemId];
          if (r.ok && x && x.ok) {
            res.gravados += 1;
            // Só o que está na tela agora precisa repintar — o resto a lista
            // lê da Base quando a página for carregada.
            if (r.valido && imp.epoca === CUSTOS.epoca && CUSTOS.cache[l.itemId] !== undefined) aplicarCustoGravado(l.itemId, x.custo);
          } else {
            res.falhas.push({ itemId: l.itemId, motivo: (x && x.motivo) || r.motivo || "Não foi salvo." });
          }
        });
        imp.progresso += lote.length;
        if (IMP === imp) renderImportacaoCustos();
        proximo(k + 1);
      });
    }
    proximo(0);
  }

  function renderImportacaoCustos() {
    if (!IMP) return;
    var imp = IMP;
    var box = imp.overlay.querySelector(".am-imp-box");
    var p = imp.previa;
    var paraGravar = linhasParaGravar(p);
    var nomeBase = CUSTOS.base ? (CUSTOS.base.nome || CUSTOS.base.slug) : "";
    var travado = imp.gravando || !!imp.resultado;

    var html = '<div class="vf-modal__header"><h3 class="vf-modal__title" id="am-imp-titulo">Importar base de custo</h3>' +
      '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-imp-acao="fechar" aria-label="Fechar"' + (imp.gravando ? " disabled" : "") + ">" + icFechar() + "</button></div>" +
      '<div class="vf-modal__body">' +
      '<p class="am-imp-intro">Atualiza a Base de custos <strong>' + escapeHtml(nomeBase) + "</strong> com uma planilha de todos os anúncios desta conta.</p>" +
      '<ol class="am-imp-passos">' +
        '<li class="am-imp-passo"><strong class="am-imp-passo__titulo">Baixar a planilha</strong>' +
          '<p class="vf-field__hint">Todos os anúncios da conta, com o custo que já está na Base. Os sem custo vêm com a célula vazia.</p>' +
          '<div class="am-imp-cluster"><button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-imp-acao="baixar"' + (imp.baixando || travado ? " disabled" : "") + ">" +
            (imp.baixando ? "Gerando…" : "Baixar XLSX") + "</button></div></li>" +
        '<li class="am-imp-passo"><strong class="am-imp-passo__titulo">Preencher</strong>' +
          '<p class="vf-field__hint">Preencha ou altere a coluna <strong>Custo</strong>. Não troque os IDs nem os cabeçalhos. Célula vazia é ignorada — nada é zerado.</p></li>' +
        '<li class="am-imp-passo"><strong class="am-imp-passo__titulo">Enviar a planilha preenchida</strong>' +
          '<input type="file" id="am-imp-arquivo" class="vf-visually-hidden" accept=".xlsx,.xls,.csv" aria-label="Planilha de custos preenchida">' +
          '<div class="am-imp-cluster">' +
            '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-imp-acao="escolher"' + (imp.lendo || travado ? " disabled" : "") + ">" +
              (imp.arquivo ? "Trocar arquivo" : "Selecionar arquivo") + "</button>" +
            (imp.arquivo ? '<span class="vf-field__hint vf-mono">' + escapeHtml(imp.arquivo.name) + "</span>" : "") +
            (imp.lendo ? '<span class="vf-field__hint" role="status">Lendo a planilha…</span>' : "") +
          "</div>";

    if (p) {
      var r = p.resumo || {};
      html += '<p class="am-imp-resumo" data-imp-resumo>' +
        '<span class="is-ok">' + r.atualizar + " para atualizar</span>" +
        '<span class="is-ok">' + r.adicionar + " para adicionar</span>" +
        "<span>" + r.inalterado + " iguais à Base</span>" +
        "<span>" + r.vazias + " sem custo (ignoradas)</span>" +
        (r.recusadas ? '<span class="is-erro">' + r.recusadas + " recusadas</span>" : "") +
      "</p>";
      if (paraGravar.length) {
        html += '<div class="vf-table-wrap am-imp-tabela"><table class="vf-table vf-table--compact" aria-label="Custos que serão gravados">' +
          '<thead><tr><th>Anúncio</th><th>ID</th><th class="is-numeric">Custo atual</th><th class="is-numeric">Novo custo</th></tr></thead><tbody>' +
          paraGravar.slice(0, 50).map(function (l) {
            return "<tr><td>" + escapeHtml(l.titulo || "—") + '</td><td class="vf-mono">' + escapeHtml(l.itemId) + "</td>" +
              '<td class="is-numeric">' + formatMoeda(l.custoAtual) + '</td><td class="is-numeric"><strong>' + formatMoeda(l.custo) + "</strong></td></tr>";
          }).join("") +
          "</tbody></table></div>" +
          (paraGravar.length > 50 ? '<p class="vf-field__hint">Mostrando 50 de ' + paraGravar.length + " — todos serão gravados.</p>" : "");
      }
      var recusadas = (p.linhas || []).filter(function (l) { return l.acao === "recusada"; });
      if (recusadas.length) {
        html += '<details class="am-imp-recusadas"><summary>Linhas recusadas (' + recusadas.length + ") — não serão gravadas</summary><ul>" +
          recusadas.slice(0, 200).map(function (l) {
            return '<li><span class="vf-mono">Linha ' + l.linha + " · " + escapeHtml(l.itemId || "—") + "</span> — " + escapeHtml(l.motivo) + "</li>";
          }).join("") + "</ul></details>";
      }
      if (!paraGravar.length && !imp.resultado) {
        html += '<p class="vf-field__hint">Nada a gravar: a planilha não muda nenhum custo da Base.</p>';
      }
    }
    html += "</li></ol>";

    if (imp.erro) {
      html += '<div class="vf-banner is-danger" role="alert"><div class="vf-banner__content"><p class="vf-banner__description">' + escapeHtml(imp.erro) + "</p></div></div>";
    }
    if (imp.gravando) {
      html += '<p class="vf-field__hint" role="status">Gravando na Base… ' + imp.progresso + " de " + paraGravar.length + "</p>";
    }
    if (imp.resultado) {
      var res = imp.resultado;
      html += '<div class="vf-banner ' + (res.falhas.length ? "is-warning" : "is-success") + '" role="status"><div class="vf-banner__content">' +
        '<p class="vf-banner__description">' + res.gravados + (res.gravados === 1 ? " custo gravado" : " custos gravados") + " na Base" +
        (res.falhas.length ? " · " + res.falhas.length + " não foram salvos" : "") +
        ". A margem dos anúncios é recalculada em seguida.</p>" +
        (res.falhas.length ? '<ul class="am-imp-falhas">' + res.falhas.slice(0, 20).map(function (f) {
          return '<li><span class="vf-mono">' + escapeHtml(f.itemId) + "</span> — " + escapeHtml(f.motivo) + "</li>";
        }).join("") + "</ul>" : "") +
        "</div></div>";
    }
    html += "</div>";

    html += '<div class="vf-modal__footer">' +
      '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-imp-acao="fechar"' + (imp.gravando ? " disabled" : "") + ">" + (imp.resultado ? "Fechar" : "Cancelar") + "</button>" +
      (imp.resultado ? "" :
        '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-imp-acao="gravar"' + (paraGravar.length && !imp.gravando && !imp.lendo ? "" : " disabled") + ">" +
          (imp.gravando ? "Gravando…" : "Gravar " + paraGravar.length + (paraGravar.length === 1 ? " custo" : " custos")) + "</button>") +
      "</div>";

    box.innerHTML = html;
  }

  // ===========================================================================
  // TRANSFERIR PROMOÇÃO — move anúncios de uma promoção (origem) para outra
  // (destino); o caso típico é a virada de mês. Só por clique.
  //   1. Seleção   GET  /anuncios-meli/promocoes-transferir/promocoes
  //   2. Prévia    GET  /anuncios-meli/promocoes-transferir/itens (anúncios da origem)
  //   3. Execução  POST /anuncios-meli/promocoes-transferir/executar em lotes
  //                de TRF_LOTE anúncios, sequenciais, com progresso.
  // No servidor cada anúncio ENTRA no destino e só depois SAI da origem; se a
  // entrada falha, nada muda. Reaproveita o painel lateral do Radar (am-reb-*).
  // ===========================================================================
  var TRF = null;
  // Lotes pequenos: cada anúncio faz ~10 chamadas ao ML, e uma requisição longa
  // demais cai por tempo. O que o servidor marca como transitório (limite de
  // requisições do ML) é refeito sozinho, até TRF_RODADAS_AUTO vezes.
  var TRF_LOTE = 5;
  var TRF_RODADAS_AUTO = 2;
  var TRF_PAUSA_RODADA_MS = 4000;

  function atualizarBotaoTransf() {
    var b = el("am-transf-abrir");
    if (!b) return;
    var semConta = !AM.clienteAtual;
    var editando = !!(CUSTOS && CUSTOS.modo);
    b.disabled = semConta || editando;
    b.title = semConta ? "Escolha um cliente e uma conta para transferir"
      : editando ? "Saia da edição de custos para transferir promoções"
      : "Mover anúncios de uma promoção para outra (ex.: virada de mês)";
  }

  function trfPromo(id) {
    var l = (TRF && TRF.promocoes) || [];
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  }

  function trfMarcados() {
    return TRF.itens.filter(function (it) { return TRF.marcados[it.itemId]; }).map(function (it) { return it.itemId; });
  }

  function trfFalhas() {
    // "parcial" (entrou no destino, não saiu da origem) também se refaz: o servidor só tira da origem.
    return Object.keys(TRF.resultados).filter(function (id) { var st = TRF.resultados[id].status; return st === "falha" || st === "parcial"; });
  }

  // Sugestão para a virada de mês: "Vendex - <mês seguinte>", do dia 1 ao último dia.
  function trfNovoPadrao() {
    var hoje = new Date();
    var ano = hoje.getFullYear(), mes = hoje.getMonth() + 1; // mês seguinte (0-based)
    if (mes > 11) { mes = 0; ano++; }
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var ultimo = new Date(ano, mes + 1, 0).getDate();
    var nomeMes = new Date(ano, mes, 1).toLocaleDateString("pt-BR", { month: "long" });
    nomeMes = nomeMes.charAt(0).toUpperCase() + nomeMes.slice(1);
    return {
      nome: "Vendex - " + nomeMes,
      inicio: ano + "-" + pad(mes + 1) + "-01",
      fim: ano + "-" + pad(mes + 1) + "-" + pad(ultimo),
    };
  }

  function criarPromocaoTransf() {
    var t = TRF;
    if (t.criandoEnvio) return;
    t.criandoEnvio = true; t.erroCriar = null;
    renderTransf();
    api("/anuncios-meli/promocoes-transferir/promocoes", {
      method: "POST", body: rebCorpo({ nome: t.novo.nome, inicio: t.novo.inicio, fim: t.novo.fim }),
    }).then(function (r) {
      if (TRF !== t) return;
      t.criandoEnvio = false;
      var d = r.data || {};
      if (d.ok && d.promocao) {
        var p = d.promocao;
        p.tipoLabel = p.tipoLabel || "Campanha própria";
        t.promocoes = (t.promocoes || []).filter(function (x) { return x.id !== p.id; }).concat([p]);
        t.destinoId = p.id;
        t.criando = false; t.erro = null;
        t.novo = trfNovoPadrao();
        renderTransf();
        trfFocar("#am-trf-destino");
        return;
      }
      t.erroCriar = rebMotivoResposta(r, "Não foi possível criar a promoção.");
      renderTransf();
    });
  }

  function abrirTransf() {
    if (!AM.clienteAtual || TRF || REB || (CUSTOS && CUSTOS.modo)) return;
    var overlay = document.createElement("div");
    overlay.className = "am-reb-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "am-trf-titulo");
    overlay.innerHTML = '<aside class="am-reb-box" aria-label="Transferir promoção"></aside>';
    document.body.appendChild(overlay);
    document.body.classList.add("vf-no-scroll");
    TRF = {
      overlay: overlay, focoAnterior: document.activeElement, passo: "selecao",
      promocoes: null, erroPromos: null, origemId: "", destinoId: "", remover: false,
      itens: [], marcados: {}, erro: null, confirmando: false,
      criando: false, novo: trfNovoPadrao(), criandoEnvio: false, erroCriar: null,
      resultados: {}, fila: [], alvos: [], total: 0, feitos: 0, enviando: false, executou: false,
    };
    overlay.addEventListener("click", onCliqueTransf);
    overlay.addEventListener("change", onMudancaTransf);
    overlay.addEventListener("keydown", onTeclaTransf);
    renderTransf();
    trfFocar("#am-trf-titulo");
    carregarPromocoesTransf();
  }

  function fecharTransf(forcar, trocaDeConta) {
    if (!TRF) return;
    var t = TRF;
    if (t.enviando && !forcar) return; // o lote em andamento não é interrompido
    t.fila = [];
    if (t.overlay.parentNode) t.overlay.parentNode.removeChild(t.overlay);
    document.body.classList.remove("vf-no-scroll");
    TRF = null;
    if (t.executou && !trocaDeConta) carregarAnuncios();
    if (!trocaDeConta && t.focoAnterior && t.focoAnterior.focus && document.contains(t.focoAnterior)) t.focoAnterior.focus();
  }

  function trfFocar(sel) {
    if (!TRF) return;
    var n = TRF.overlay.querySelector(sel);
    if (n) n.focus();
  }

  function onCliqueTransf(e) {
    if (!TRF) return;
    if (e.target === TRF.overlay) { if (TRF.passo === "selecao") fecharTransf(false); return; }
    var b = e.target.closest("[data-trf-acao]");
    if (!b || b.disabled) return;
    switch (b.getAttribute("data-trf-acao")) {
      case "fechar": fecharTransf(false); break;
      case "recarregar": carregarPromocoesTransf(); break;
      case "buscar": buscarItensTransf(); break;
      case "criar-abrir": TRF.criando = true; TRF.erroCriar = null; renderTransf(); trfFocar("#am-trf-novo-nome"); break;
      case "criar-cancelar": TRF.criando = false; TRF.erroCriar = null; renderTransf(); trfFocar("#am-trf-criar-abrir"); break;
      case "criar-enviar": criarPromocaoTransf(); break;
      case "voltar":
        TRF.passo = "selecao"; TRF.erro = null; TRF.itens = []; TRF.marcados = {}; TRF.confirmando = false;
        renderTransf(); trfFocar("#am-trf-titulo");
        break;
      case "transferir":
        if (!trfMarcados().length) return;
        TRF.confirmando = true; renderTransf(); trfFocar("#am-trf-confirmar");
        break;
      case "cancelar-confirmacao": TRF.confirmando = false; renderTransf(); trfFocar("#am-trf-transferir"); break;
      case "confirmar": executarTransf(trfMarcados()); break;
      case "retentar": { var f = trfFalhas(); if (f.length) executarTransf(f); break; }
    }
  }

  function onMudancaTransf(e) {
    if (!TRF) return;
    var t = e.target;
    if (t.id === "am-trf-origem") { TRF.origemId = t.value; if (TRF.destinoId === t.value) TRF.destinoId = ""; renderTransf(); return; }
    if (t.id === "am-trf-destino") { TRF.destinoId = t.value; renderTransf(); return; }
    // Campos do formulário de nova promoção: só guarda (sem render, para não perder o foco).
    if (t.id === "am-trf-novo-nome") { TRF.novo.nome = t.value; return; }
    if (t.id === "am-trf-novo-inicio") { TRF.novo.inicio = t.value; return; }
    if (t.id === "am-trf-novo-fim") { TRF.novo.fim = t.value; return; }
    if (t.id === "am-trf-remover") { TRF.remover = t.checked; TRF.confirmando = false; renderTransf(); return; }
    if (t.hasAttribute("data-trf-todos")) {
      TRF.itens.forEach(function (it) { TRF.marcados[it.itemId] = t.checked; });
      TRF.confirmando = false; renderTransf(); return;
    }
    var id = t.getAttribute("data-trf-marcar");
    if (id) { TRF.marcados[id] = t.checked; TRF.confirmando = false; renderTransf(); }
  }

  function onTeclaTransf(e) {
    if (!TRF) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (TRF.confirmando) { TRF.confirmando = false; renderTransf(); trfFocar("#am-trf-transferir"); return; }
      fecharTransf(false);
      return;
    }
    if (e.key === "Tab") {
      var foc = Array.prototype.filter.call(
        TRF.overlay.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled])'),
        function (n) { return n.offsetParent !== null; });
      if (!foc.length) return;
      var primeiro = foc[0], ultimo = foc[foc.length - 1];
      if (e.shiftKey && (document.activeElement === primeiro || !TRF.overlay.contains(document.activeElement))) { e.preventDefault(); ultimo.focus(); }
      else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
    }
  }

  function carregarPromocoesTransf() {
    var t = TRF;
    t.promocoes = null; t.erroPromos = null;
    renderTransf();
    api("/anuncios-meli/promocoes-transferir/promocoes?" + rebQs()).then(function (r) {
      if (TRF !== t) return;
      var d = r.data || {};
      if (!d.ok) {
        t.erroPromos = rebMotivoResposta(r, "Não foi possível carregar as promoções da conta.");
        t.promocoes = [];
      } else {
        t.promocoes = Array.isArray(d.referencias) ? d.referencias : [];
      }
      renderTransf();
    });
  }

  function buscarItensTransf() {
    var t = TRF;
    var o = trfPromo(t.origemId);
    if (!o || !t.destinoId || t.passo === "carregando") return;
    t.passo = "carregando"; t.erro = null;
    renderTransf();
    api("/anuncios-meli/promocoes-transferir/itens?" + rebQs() +
      "&origemId=" + encodeURIComponent(o.id) + "&origemTipo=" + encodeURIComponent(o.tipo)).then(function (r) {
      if (TRF !== t) return;
      var d = r.data || {};
      if (!d.ok) {
        t.passo = "selecao";
        t.erro = rebMotivoResposta(r, "Não foi possível listar os anúncios da promoção de origem.");
      } else {
        t.itens = Array.isArray(d.itens) ? d.itens : [];
        t.marcados = {};
        t.itens.forEach(function (it) { t.marcados[it.itemId] = true; });
        t.passo = "previa";
      }
      renderTransf();
      trfFocar("#am-trf-titulo");
    });
  }

  function executarTransf(ids) {
    var t = TRF;
    var o = trfPromo(t.origemId), dst = trfPromo(t.destinoId);
    if (!o || !dst || !ids.length || t.enviando) return;
    ids.forEach(function (id) { delete t.resultados[id]; });
    t.passo = "execucao"; t.confirmando = false; t.enviando = true;
    t.fila = ids.slice(); t.alvos = ids.slice(); t.total = ids.length; t.feitos = 0; t.rodada = 0; t.refazendo = 0;
    renderTransf();
    (function proximo() {
      if (TRF !== t) return;
      var lote = t.fila.splice(0, TRF_LOTE);
      if (!lote.length) {
        var refazer = t.alvos.filter(function (id) { var r = t.resultados[id]; return r && r.transitorio && !r.incerto && (r.status === "falha" || r.status === "parcial"); });
        if (refazer.length && t.rodada < TRF_RODADAS_AUTO) {
          t.rodada++; t.refazendo = refazer.length; t.fila = refazer;
          renderTransf();
          setTimeout(proximo, TRF_PAUSA_RODADA_MS);
          return;
        }
        t.refazendo = 0; t.enviando = false; renderTransf();
        trfFocar(trfFalhas().length ? "#am-trf-retentar" : "#am-trf-fechar-final");
        return;
      }
      api("/anuncios-meli/promocoes-transferir/executar", {
        method: "POST",
        body: rebCorpo({
          origem: { id: o.id, tipo: o.tipo }, destino: { id: dst.id, tipo: dst.tipo },
          itemIds: lote, removerOrigem: t.remover,
        }),
      }).then(function (r) {
        if (TRF !== t) return;
        var d = r.data || {};
        if (d.ok && Array.isArray(d.resultados)) {
          d.resultados.forEach(function (x) { t.resultados[x.itemId] = x; });
        } else {
          // Sem resposta (rede) o lote pode ter sido aplicado: marca como incerto.
          lote.forEach(function (id) {
            t.resultados[id] = { itemId: id, status: "falha", incerto: r.status === 0,
              motivo: rebMotivoResposta(r, "Não foi possível transferir este lote.") };
          });
        }
        if (!t.refazendo) t.feitos += lote.length;
        t.executou = true;
        renderTransf();
        proximo();
      });
    })();
  }

  // --- Render ------------------------------------------------------------------------
  function trfSelectHtml(id, rotulo, valor, excluirId) {
    return '<div class="vf-field am-reb-campo"><label class="vf-field__label" for="' + id + '">' + rotulo + "</label>" +
      '<select id="' + id + '" class="vf-select">' +
      (valor ? "" : '<option value="" selected>Escolha a promoção…</option>') +
      TRF.promocoes.filter(function (x) { return x.id !== excluirId; }).map(function (x) {
        var txt = (x.nome || x.id) + " · " + (x.tipoLabel || x.tipo || "") + " · " + rebVigencia(x);
        return '<option value="' + escapeAttr(x.id) + '"' + (x.id === valor ? " selected" : "") + ">" + escapeHtml(txt) + "</option>";
      }).join("") + "</select></div>";
  }

  // Criar a promoção de destino sem sair da tela (campanha do vendedor).
  function trfCriarHtml() {
    var t = TRF;
    if (!t.criando) {
      return '<div class="am-reb-campo"><button type="button" class="am-reb-link" id="am-trf-criar-abrir" data-trf-acao="criar-abrir">+ Criar nova promoção</button></div>';
    }
    var n = t.novo;
    var dis = t.criandoEnvio ? " disabled" : "";
    var pode = n.nome.trim() && n.inicio && n.fim && !t.criandoEnvio;
    return '<fieldset class="am-trf-criar"><legend class="vf-field__label">Nova promoção (campanha do vendedor)</legend>' +
      '<div class="vf-field"><label class="vf-field__label" for="am-trf-novo-nome">Nome</label>' +
        '<input type="text" id="am-trf-novo-nome" class="vf-input" maxlength="120" value="' + escapeAttr(n.nome) + '"' + dis + "></div>" +
      '<div class="am-trf-criar__datas">' +
        '<div class="vf-field"><label class="vf-field__label" for="am-trf-novo-inicio">Início</label>' +
          '<input type="date" id="am-trf-novo-inicio" class="vf-input" value="' + escapeAttr(n.inicio) + '"' + dis + "></div>" +
        '<div class="vf-field"><label class="vf-field__label" for="am-trf-novo-fim">Fim</label>' +
          '<input type="date" id="am-trf-novo-fim" class="vf-input" value="' + escapeAttr(n.fim) + '"' + dis + "></div></div>" +
      '<p class="vf-field__hint">O Mercado Livre usa o início e o fim do dia. O preço de cada anúncio é o que ele já tem na origem.</p>' +
      (t.erroCriar ? rebBannerHtml("danger", t.erroCriar) : "") +
      '<div class="am-reb-cluster">' +
        '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-trf-acao="criar-cancelar"' + dis + ">Cancelar</button>" +
        '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" id="am-trf-criar-enviar" data-trf-acao="criar-enviar"' + (pode ? "" : " disabled") + ">" +
          (t.criandoEnvio ? "Criando…" : "Criar promoção") + "</button></div></fieldset>";
  }

  function trfCorpoSelecaoHtml() {
    var t = TRF;
    var html = '<p class="am-reb-intro">Move os anúncios de uma promoção para outra — por exemplo, na virada do mês, da Vendex que acaba para a do mês seguinte. Cada anúncio entra primeiro no destino e só depois sai da origem; se a entrada falhar, nada muda. Nas promoções de preço do vendedor, o preço da origem é repetido no destino.</p>';
    if (t.passo === "carregando") return html + estadoHtml("loading", "Buscando os anúncios da promoção de origem…");
    if (t.promocoes === null) return html + estadoHtml("loading", "Carregando promoções da conta…");
    if (t.erroPromos) {
      return html + rebBannerHtml("danger", t.erroPromos) +
        '<div class="am-reb-cluster"><button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-trf-acao="recarregar">Tentar de novo</button></div>';
    }
    html += trfSelectHtml("am-trf-origem", "Promoção de origem (de onde sai)", t.origemId, "");
    html += trfSelectHtml("am-trf-destino", "Promoção de destino (para onde vai)", t.destinoId, t.origemId);
    html += trfCriarHtml();
    html += '<label class="am-reb-campo" style="display:flex;gap:8px;align-items:flex-start">' +
      '<input type="checkbox" id="am-trf-remover"' + (t.remover ? " checked" : "") + ' style="margin-top:3px">' +
      "<span>Tirar o anúncio da promoção de origem depois que entrar no destino</span></label>";
    if (t.erro) html += rebBannerHtml("danger", t.erro);
    return html;
  }

  function trfLinhaHtml(it, modo) {
    var preco = it.preco != null ? formatMoeda(it.preco) : "—";
    var lado;
    if (modo === "previa") {
      lado = '<span class="am-trf-linha__preco">' + preco + "</span>";
      return '<li class="am-trf-linha"><input type="checkbox" data-trf-marcar="' + escapeAttr(it.itemId) + '"' +
        (TRF.marcados[it.itemId] ? " checked" : "") + ' aria-label="Transferir ' + escapeAttr(it.itemId) + '">' +
        rebAnuncioHtml(it) + lado + "</li>";
    }
    var r = TRF.resultados[it.itemId];
    if (!r) lado = '<span class="am-trf-linha__res">aguardando…</span>';
    else if (r.status === "ok") lado = '<span class="am-trf-linha__res is-ok">Transferido</span>';
    else if (r.status === "ignorado") lado = '<span class="am-trf-linha__res is-ok">' + escapeHtml(r.motivo || "Já estava no destino") + "</span>";
    else if (r.status === "parcial") lado = '<span class="am-trf-linha__res is-parcial">' + escapeHtml(r.motivo || "Entrou no destino, mas não saiu da origem") + "</span>";
    else lado = '<span class="am-trf-linha__res is-falha">' + escapeHtml(r.motivo || "Falhou") + (r.incerto ? " Confira o anúncio antes de tentar de novo." : "") + "</span>";
    return '<li class="am-trf-linha">' + rebAnuncioHtml(it) + lado + "</li>";
  }

  function trfCorpoPreviaHtml() {
    var t = TRF;
    if (!t.itens.length) {
      return estadoHtml("empty", "Nenhum anúncio nesta promoção", "A promoção de origem não tem anúncios participando agora.");
    }
    var marcados = trfMarcados().length;
    return '<label class="am-reb-campo" style="display:flex;gap:8px;align-items:center">' +
        '<input type="checkbox" data-trf-todos' + (marcados === t.itens.length ? " checked" : "") + ">" +
        "<strong>Selecionar todos</strong> <span>(" + marcados + " de " + t.itens.length + ")</span></label>" +
      '<ul class="am-trf-lista">' + t.itens.map(function (it) { return trfLinhaHtml(it, "previa"); }).join("") + "</ul>";
  }

  // Placar ao vivo, no mesmo formato do Radar (am-reb-placar).
  function trfPlacarHtml(cont) {
    var item = function (n, rotulo, classe) {
      return '<div class="am-reb-placar__item' + (classe ? " " + classe : "") + '">' +
        '<span class="am-reb-placar__n">' + n + '</span><span class="am-reb-placar__rotulo">' + rotulo + "</span></div>";
    };
    return '<div class="am-reb-placar" aria-label="Resultado até agora">' +
      item(cont.ok + cont.ignorado, "transferidos", "is-ganho") +
      item(cont.parcial, "ficaram na origem") +
      item(cont.falha, "com falha") + "</div>";
  }

  function icPromo() {
    return '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2.5 10.2V3.5a1 1 0 0 1 1-1h6.7a1 1 0 0 1 .7.3l6.6 6.6a1 1 0 0 1 0 1.4l-6.7 6.7a1 1 0 0 1-1.4 0l-6.6-6.6a1 1 0 0 1-.3-.7Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="6.5" cy="6.5" r="1.3" fill="currentColor"/></svg>';
  }

  // Enquanto roda: anúncios fluindo da promoção de origem para a de destino
  // (o % mora no nó de destino). Reaproveita só o título/texto/barra/placar do Radar.
  function trfAnimacaoHtml(cont) {
    var t = TRF;
    var total = t.total || 0, p = Math.min(t.feitos, total || Infinity);
    var pct = total > 0 ? Math.round((p / total) * 100) : 0;
    // O corpo é recriado a cada lote: o atraso negativo mantém o fluxo contínuo.
    var base = Date.now() % 2000;
    var pacotes = "";
    for (var i = 0; i < 4; i++) pacotes += '<i class="am-trf-fluxo__pacote" style="animation-delay:' + -(base + i * 500) + 'ms"></i>';
    var o = trfPromo(t.origemId), dst = trfPromo(t.destinoId);
    var seta = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 10h12M11 5l5 5-5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var titulo = t.refazendo ? "Refazendo o que o Mercado Livre limitou" : "Transferindo anúncios";
    var txt = t.refazendo
      ? t.refazendo + (t.refazendo === 1 ? " anúncio" : " anúncios") + " em nova tentativa"
      : (total > 0 ? p + " de " + total + " anúncios" : "Preparando…");
    return '<div class="am-reb-radar-an" data-trf-progresso>' +
        '<div class="am-trf-fluxo" aria-hidden="true">' +
          '<div class="am-trf-fluxo__ponta"><span class="am-trf-fluxo__no">' + icPromo() + '</span>' +
            '<span class="am-trf-fluxo__nome">' + escapeHtml((o && o.nome) || "Origem") + "</span></div>" +
          '<span class="am-trf-fluxo__trilho">' + pacotes + "</span>" +
          '<div class="am-trf-fluxo__ponta"><span class="am-trf-fluxo__no am-trf-fluxo__no--destino">' + (total > 0 ? pct + "%" : seta) + "</span>" +
            '<span class="am-trf-fluxo__nome">' + escapeHtml((dst && dst.nome) || "Destino") + "</span></div></div>" +
        '<p class="am-reb-radar-an__titulo">' + titulo + "</p>" +
        '<p class="am-reb-radar-an__txt" aria-live="polite">' + txt + "</p>" +
        '<div class="vf-progress am-reb-radar-an__barra" role="progressbar" aria-label="Progresso da transferência" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + p + '">' +
          '<div class="vf-progress__bar" style="width:' + pct + '%"></div></div>' +
      "</div>" +
      trfPlacarHtml(cont) +
      '<p class="am-reb-radar-an__nota">Cada anúncio entra no destino antes de sair da origem. Aguarde: fechar o painel só é possível ao terminar.</p>';
  }

  function trfCorpoExecucaoHtml() {
    var t = TRF;
    var porId = {};
    t.itens.forEach(function (it) { porId[it.itemId] = it; });
    var linhas = t.alvos;
    var cont = { ok: 0, parcial: 0, falha: 0, ignorado: 0 };
    linhas.forEach(function (id) {
      var r = t.resultados[id];
      if (r && cont[r.status] !== undefined) cont[r.status]++;
    });
    if (t.enviando) return trfAnimacaoHtml(cont);
    return trfPlacarHtml(cont) +
      '<ul class="am-trf-lista">' + linhas.map(function (id) {
        return trfLinhaHtml(porId[id] || { itemId: id }, "execucao");
      }).join("") + "</ul>";
  }

  function renderTransf() {
    if (!TRF) return;
    var t = TRF;
    var box = t.overlay.querySelector(".am-reb-box");
    var focoId = document.activeElement && t.overlay.contains(document.activeElement) ? document.activeElement.id : "";
    var o = trfPromo(t.origemId), dst = trfPromo(t.destinoId);
    var sub = t.passo === "selecao" || t.passo === "carregando" ? "Escolha de onde e para onde mover os anúncios."
      : "<strong>" + escapeHtml((o && o.nome) || "origem") + "</strong> → <strong>" + escapeHtml((dst && dst.nome) || "destino") + "</strong>";
    var corpo, rodape;
    if (t.passo === "previa") {
      var n = trfMarcados().length;
      corpo = trfCorpoPreviaHtml();
      if (t.confirmando) {
        rodape = '<div class="am-reb-confirma" role="alert"><p class="am-reb-confirma__txt">Transferir ' + n + (n === 1 ? " anúncio" : " anúncios") +
          " para <strong>" + escapeHtml((dst && dst.nome) || "o destino") + "</strong>" +
          (t.remover ? " e tirá-" + (n === 1 ? "lo" : "los") + " de <strong>" + escapeHtml((o && o.nome) || "a origem") + "</strong>" : "") +
          "? Isso grava no Mercado Livre.</p>" +
          '<div class="am-reb-confirma__acoes">' +
          '<button type="button" class="vf-btn vf-btn--secondary" data-trf-acao="cancelar-confirmacao">Cancelar</button>' +
          '<button type="button" class="vf-btn vf-btn--primary" id="am-trf-confirmar" data-trf-acao="confirmar">Confirmar transferência</button></div></div>';
      } else {
        rodape = '<div class="am-reb-rodape__acoes">' +
          '<button type="button" class="vf-btn vf-btn--secondary" data-trf-acao="voltar">Voltar</button>' +
          '<button type="button" class="vf-btn vf-btn--primary" id="am-trf-transferir" data-trf-acao="transferir"' + (n ? "" : " disabled") + ">" +
          "Transferir " + n + (n === 1 ? " anúncio" : " anúncios") + "</button></div>";
      }
    } else if (t.passo === "execucao") {
      corpo = trfCorpoExecucaoHtml();
      var falhas = trfFalhas().length;
      rodape = '<div class="am-reb-rodape__acoes">' +
        (falhas && !t.enviando ? '<button type="button" class="vf-btn vf-btn--secondary" id="am-trf-retentar" data-trf-acao="retentar">Tentar de novo as falhas (' + falhas + ")</button>" : "") +
        '<button type="button" class="vf-btn vf-btn--primary" id="am-trf-fechar-final" data-trf-acao="fechar"' + (t.enviando ? " disabled" : "") + ">" +
        (t.enviando ? "Transferindo…" : "Concluir") + "</button></div>";
    } else {
      corpo = trfCorpoSelecaoHtml();
      var pode = !!o && !!dst && t.passo === "selecao";
      rodape = '<div class="am-reb-rodape__acoes">' +
        '<button type="button" class="vf-btn vf-btn--secondary" data-trf-acao="fechar">Cancelar</button>' +
        '<button type="button" class="vf-btn vf-btn--primary" id="am-trf-buscar" data-trf-acao="buscar"' + (pode ? "" : " disabled") + ">Ver anúncios</button></div>";
    }

    var scroll = box.querySelector(".am-reb-corpo");
    var scrollTop = scroll ? scroll.scrollTop : 0;
    box.innerHTML = '<header class="am-reb-head"><div class="am-reb-head__topo"><div class="am-reb-head__txt">' +
        '<h2 class="am-reb-titulo" id="am-trf-titulo" tabindex="-1">Transferir promoção</h2>' +
        '<p class="am-reb-sub">' + sub + "</p></div>" +
        '<button type="button" class="am-reb-x" id="am-trf-x" data-trf-acao="fechar" aria-label="Fechar"' + (t.enviando ? " disabled" : "") + ">" + icFechar() + "</button></div></header>" +
      '<div class="am-reb-corpo">' + corpo + "</div>" +
      '<footer class="am-reb-rodape">' + rodape + "</footer>";
    var novo = box.querySelector(".am-reb-corpo");
    if (novo && t.ultimoPasso === t.passo) novo.scrollTop = scrollTop;
    t.ultimoPasso = t.passo;
    if (focoId) {
      var n2 = document.getElementById(focoId);
      if (n2 && t.overlay.contains(n2)) n2.focus();
    }
  }

  // ===========================================================================
  // PROMOÇÕES COM REBATE — docs/specs/2026-10-15-anuncios-ml-promocoes-rebate.md
  //
  // Para os anúncios ATIVOS numa promoção de referência (em geral a Vendex do
  // mês), procura promoções com subsídio do Mercado Livre e preço menor que
  // deixem margem e/ou lucro maiores — e só participa com confirmação.
  //   1. Referência  GET  /anuncios-meli/promocoes-rebate/referencias
  //   2. Analisando  POST /anuncios-meli/promocoes-rebate/analises → jobId,
  //                  depois GET /analises/:jobId a cada REB_POLL_MS
  //   3. Prévia      grupos Recomendados / Escolha / Sem ganho / Descartados
  //   4. Execução    POST /analises/:jobId/executar (só as escolhas
  //                  confirmadas), progresso pelo mesmo GET (job.execucao)
  // A referência NUNCA é tocada. Falha esperada = 200 { ok:false, motivo }.
  // Nada roda sem clique: o polling para ao fechar, concluir ou falhar.
  // ===========================================================================
  var REB = null;
  var REB_POLL_MS = 1500;
  // Job que ficou processando quando o modal foi fechado (por conta). O
  // servidor aceita UMA análise ativa por cliente — reabrir retoma o
  // acompanhamento em vez de esbarrar em ANALISE_EM_ANDAMENTO.
  var rebJobEmCurso = {};

  var REB_MOTIVOS = {
    SEM_CUSTO: "Sem custo na Base de custos — não dá para calcular a margem.",
    COTACAO_INDISPONIVEL: "O Mercado Livre não devolveu comissão e frete para esse preço agora. Tente de novo mais tarde.",
    FORA_DA_REFERENCIA: "O anúncio não está ativo na promoção de referência.",
    SEM_CANDIDATA: "Nenhuma promoção com subsídio do Mercado Livre disponível para este anúncio.",
    PRECO_NAO_MENOR: "As promoções com subsídio têm preço igual ou maior que o preço de hoje — o rebate não entraria.",
    ERRO_ML: "O Mercado Livre não respondeu para este anúncio.",
    JA_EM_REBATE_MELHOR: "Já está numa promoção com rebate melhor — nenhuma outra melhora margem nem lucro.",
  };

  function rebChaveConta() {
    return AM.clienteAtual ? AM.clienteAtual.slug + ":" + (AM.contaMlId || "") : "";
  }

  function atualizarBotaoRebate() {
    atualizarBotaoTransf();
    var b = el("am-reb-abrir");
    if (!b) return;
    var semConta = !AM.clienteAtual;
    var editando = !!(CUSTOS && CUSTOS.modo);
    b.disabled = semConta || editando;
    b.title = semConta ? "Escolha um cliente e uma conta para analisar"
      : editando ? "Saia da edição de custos para analisar promoções"
      : "Procurar promoções com subsídio do Mercado Livre para os anúncios da promoção de referência";
  }

  function rebQs() {
    var qs = "clienteSlug=" + encodeURIComponent(AM.clienteAtual.slug);
    if (AM.contaMlId) qs += "&clienteContaId=" + encodeURIComponent(AM.contaMlId);
    return qs;
  }

  function rebCorpo(extra) {
    var corpo = { clienteSlug: AM.clienteAtual.slug };
    if (AM.contaMlId) corpo.clienteContaId = AM.contaMlId;
    Object.keys(extra || {}).forEach(function (k) { corpo[k] = extra[k]; });
    return corpo;
  }

  function rebMotivoResposta(r, padrao) {
    var d = (r && r.data) || {};
    return d.motivo || d.mensagem || padrao;
  }

  // --- Formatação ----------------------------------------------------------------
  function rebNum(v) { return v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v); }

  function rebPct(v) {
    var n = rebNum(v);
    return n === null ? "—" : n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
  }

  function rebSinal(n) { return n > 0 ? "+" : n < 0 ? "−" : ""; }

  // Ganho com sinal e cor de status (verde ganho / vermelho perda / neutro).
  function rebGanhoHtml(v, tipo, sufixo) {
    var n = rebNum(v);
    if (n === null) return '<span class="am-reb-ganho">—</span>';
    var abs = Math.abs(n);
    var txt = tipo === "pp"
      ? rebSinal(n) + abs.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " p.p."
      : rebSinal(n) + "R$ " + abs.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (sufixo || "");
    var classe = n > 0 ? " is-pos" : n < 0 ? " is-neg" : "";
    return '<span class="am-reb-ganho' + classe + '">' + txt + "</span>";
  }

  function rebData(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  }

  function rebVigencia(ref) {
    var ini = rebData(ref.inicio), fim = rebData(ref.fim);
    if (ini && fim) return ini + " a " + fim;
    if (fim) return "até " + fim;
    if (ini) return "desde " + ini;
    return "sem vigência informada";
  }

  function rebThumbHtml(url) {
    if (url && /^https?:\/\//i.test(String(url))) {
      return '<img class="am-reb-thumb" src="' + escapeAttr(url) + '" alt="" loading="lazy">';
    }
    return '<span class="am-reb-thumb am-reb-thumb--vazia" aria-hidden="true">' + icImagem(16) + "</span>";
  }

  function rebAnuncioHtml(it) {
    return '<div class="am-reb-anuncio">' + rebThumbHtml(it.thumbnail) +
      '<div class="am-reb-anuncio__txt"><span class="am-reb-anuncio__titulo">' + escapeHtml(it.titulo || "Anúncio sem título") + "</span>" +
      '<span class="am-reb-anuncio__id vf-mono">' + escapeHtml(it.itemId) + "</span></div></div>";
  }

  function rebMotivoTexto(it) {
    return it.motivoTexto || REB_MOTIVOS[it.motivo] || (it.motivo ? String(it.motivo) : "");
  }

  // --- Dados do resultado ----------------------------------------------------------
  function rebItens(status) {
    var res = REB && REB.job && REB.job.resultado;
    return ((res && res.itens) || []).filter(function (it) { return !status || it.status === status; });
  }

  function rebItemPorId(itemId) {
    var lista = rebItens();
    for (var i = 0; i < lista.length; i++) if (lista[i].itemId === itemId) return lista[i];
    return null;
  }

  function rebCandidata(it, promotionId) {
    if (!it || !promotionId) return null;
    var c = it.candidatas || [];
    for (var i = 0; i < c.length; i++) if (c[i].promotionId === promotionId) return c[i];
    return null;
  }

  // Escolha inicial: recomendados vêm marcados (a sugestão é a mesma nos dois
  // critérios); itens de Escolha começam em "Manter como está".
  function rebEscolhasIniciais() {
    var esc = {};
    rebItens().forEach(function (it) {
      if (it.status === "recomendado") {
        var s = it.sugestao || {};
        var pid = s.porMargem || s.porLucro || (it.candidatas && it.candidatas[0] && it.candidatas[0].promotionId) || "";
        esc[it.itemId] = rebCandidata(it, pid) ? [pid] : [];
      } else if (it.status === "escolha") {
        esc[it.itemId] = [];
      }
    });
    return esc;
  }

  // Cada anúncio guarda uma LISTA de promoções marcadas (pode participar de várias).
  function rebMarcadas(itemId) {
    var v = REB && REB.escolhas[itemId];
    return Array.isArray(v) ? v : [];
  }

  function rebEscolhasSelecionadas() {
    var out = [];
    rebItens().forEach(function (it) {
      if (it.status !== "recomendado" && it.status !== "escolha") return;
      rebMarcadas(it.itemId).forEach(function (pid) {
        var c = rebCandidata(it, pid);
        if (c) out.push({ itemId: it.itemId, promotionId: c.promotionId, tipo: c.tipo });
      });
    });
    return out;
  }

  // "Preferir margem/lucro em todos": só nos itens de Escolha, e só quando a
  // sugestão daquele critério melhora o próprio critério — senão a referência.
  // "ref" = Manter como está em todos (nenhuma participação nova).
  function rebPreferir(criterio) {
    rebItens("escolha").forEach(function (it) {
      if (criterio === "ref") { REB.escolhas[it.itemId] = []; return; }
      var s = it.sugestao || {};
      var c = rebCandidata(it, criterio === "margem" ? s.porMargem : s.porLucro);
      var ganho = c ? rebNum(criterio === "margem" ? c.ganhoMargemPp : c.ganhoLucro) : null;
      REB.escolhas[it.itemId] = c && ganho !== null && ganho > 0 ? [c.promotionId] : [];
    });
    REB.preferencia = criterio;
    REB.confirmando = false;
    renderRebate();
  }

  // Aba aberta quando a prévia chega: a primeira que tem anúncio.
  function rebAbaInicial() {
    var ordem = ["recomendado", "escolha", "sem_ganho", "descartado"];
    for (var i = 0; i < ordem.length; i++) if (rebItens(ordem[i]).length) return ordem[i];
    return "recomendado";
  }

  // Promoção que forma o preço HOJE (base das comparações): a referência ou
  // uma promoção com rebate em que o anúncio já entrou. Análises salvas antes
  // do campo `atual` caem na referência, como eram calculadas.
  function rebAtual(it) {
    if (it && it.atual) return it.atual;
    var ref = (it && it.referencia) || {};
    return {
      nome: (REB && REB.job && REB.job.referencia && REB.job.referencia.nome) || "Referência", ehReferencia: true,
      preco: ref.preco, subsidioMl: ref.subsidioMl, meliPercentage: ref.meliPercentage, margemPercent: ref.margemPercent, lucro: ref.lucro,
    };
  }

  // --- Abrir / fechar --------------------------------------------------------------
  function abrirRebate() {
    if (!AM.clienteAtual || REB || TRF || (CUSTOS && CUSTOS.modo)) return;
    var overlay = document.createElement("div");
    overlay.className = "am-reb-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "am-reb-titulo");
    overlay.innerHTML = '<aside class="am-reb-box" aria-label="Radar de subsídios"></aside>';
    document.body.appendChild(overlay);
    document.body.classList.add("vf-no-scroll");
    REB = {
      overlay: overlay, chave: rebChaveConta(), focoAnterior: document.activeElement,
      passo: "referencia", referencias: null, padraoId: null, refId: "", erroRefs: null,
      jobId: null, job: null, erro: null, iniciando: false,
      escolhas: {}, aba: "recomendado", preferencia: null,
      confirmando: false, enviando: false, erroExecutar: null,
      enviadas: [], pollsParado: 0, executou: false, avisoFechar: false,
      timer: null, seq: 0,
    };

    overlay.addEventListener("click", onCliqueRebate);
    overlay.addEventListener("change", onMudancaRebate);
    overlay.addEventListener("keydown", onTeclaRebate);

    var emCurso = rebJobEmCurso[REB.chave];
    if (emCurso) {
      // Retoma a análise/execução que ficou rodando no servidor.
      REB.jobId = emCurso.jobId;
      REB.passo = emCurso.fase === "execucao" ? "execucao" : "analisando";
      REB.enviadas = emCurso.enviadas || [];
      REB.retomado = true;
      if (REB.passo === "execucao") REB.executou = true;
      renderRebate();
      rebFocarInicio();
      rebPollar();
      return;
    }
    renderRebate();
    rebFocarInicio();
    carregarReferenciasRebate();
  }

  // `forcar` fecha sem perguntar (troca de conta). Fora isso, no meio da
  // execução, pergunta inline antes — o servidor continua gravando.
  function fecharRebate(forcar, trocaDeConta) {
    if (!REB) return;
    var reb = REB;
    var execEmCurso = reb.passo === "execucao" && rebProcessando();
    if (!forcar && execEmCurso && !reb.avisoFechar) {
      reb.avisoFechar = true;
      renderRebate();
      var b = reb.overlay.querySelector("#am-reb-continuar");
      if (b) b.focus();
      return;
    }
    // Lembra o job para retomar se ainda estava rodando.
    if (reb.jobId && (reb.passo === "analisando" || execEmCurso)) {
      rebJobEmCurso[reb.chave] = { jobId: reb.jobId, fase: reb.passo === "execucao" ? "execucao" : "analise", enviadas: reb.enviadas };
    } else {
      delete rebJobEmCurso[reb.chave];
    }
    if (reb.timer) clearTimeout(reb.timer);
    reb.timer = null;
    reb.seq++;
    if (reb.overlay.parentNode) reb.overlay.parentNode.removeChild(reb.overlay);
    document.body.classList.remove("vf-no-scroll");
    REB = null;
    // Depois de qualquer execução a lista é relida (preço/promoção mudaram).
    // Na troca de conta quem recarrega é aplicarContextoDoShell.
    if (reb.executou && !trocaDeConta) carregarAnuncios();
    if (!trocaDeConta && reb.focoAnterior && reb.focoAnterior.focus && document.contains(reb.focoAnterior)) reb.focoAnterior.focus();
  }

  function rebProcessando() {
    var j = REB && REB.job;
    if (!REB || REB.passo !== "execucao") return false;
    if (REB.enviando) return true;
    return !rebExecucaoConcluida(j);
  }

  function rebFocarInicio() {
    if (!REB) return;
    var t = REB.overlay.querySelector("#am-reb-titulo");
    if (t) t.focus();
  }

  // --- Eventos -----------------------------------------------------------------------
  function onCliqueRebate(e) {
    if (!REB) return;
    // Clique no fundo só fecha antes da prévia — depois disso há escolhas
    // (ou uma execução) que um clique perdido não pode descartar.
    if (e.target === REB.overlay) { if (REB.passo === "referencia") fecharRebate(false); return; }
    var b = e.target.closest("[data-reb-acao]");
    if (!b || b.disabled) return;
    switch (b.getAttribute("data-reb-acao")) {
      case "fechar": fecharRebate(false); break;
      case "fechar-mesmo": REB.avisoFechar = true; fecharRebate(true); break;
      case "continuar": REB.avisoFechar = false; renderRebate(); break;
      case "recarregar-refs": carregarReferenciasRebate(); break;
      case "analisar": iniciarAnaliseRebate(); break;
      case "voltar-ref":
      case "trocar-ref":
        REB.passo = "referencia"; REB.erro = null; REB.job = null; REB.jobId = null;
        REB.confirmando = false; REB.escolhas = {}; REB.confirmadas = {};
        delete rebJobEmCurso[REB.chave];
        renderRebate(); rebFocarInicio();
        if (!REB.referencias) carregarReferenciasRebate();
        break;
      case "preferir-margem": rebPreferir("margem"); break;
      case "preferir-lucro": rebPreferir("lucro"); break;
      case "preferir-ref": rebPreferir("ref"); break;
      case "aba":
        REB.aba = b.getAttribute("data-reb-aba") || "recomendado";
        renderRebate();
        rebFocar('[data-reb-aba="' + REB.aba + '"]');
        break;
      case "participar":
        if (!rebEscolhasSelecionadas().length) return;
        REB.confirmando = true; REB.erroExecutar = null; renderRebate();
        rebFocar("#am-reb-confirmar");
        break;
      case "cancelar-confirmacao": REB.confirmando = false; renderRebate(); rebFocar("#am-reb-participar"); break;
      case "confirmar": executarRebate(rebEscolhasSelecionadas()); break;
      case "retentar": {
        var falhas = rebFalhas();
        if (falhas.length) executarRebate(falhas);
        break;
      }
      case "copiar-msg": rebCopiarMensagem(b.getAttribute("data-reb-modo") === "feito" ? "feito" : "proposta"); break;
    }
  }

  function onMudancaRebate(e) {
    if (!REB) return;
    var t = e.target;
    if (t.id === "am-reb-ref") { REB.refId = t.value; renderRebate(); return; }
    if (t.hasAttribute("data-reb-todos")) {
      rebItens("recomendado").forEach(function (it) {
        var s = it.sugestao || {};
        var pid = s.porMargem || s.porLucro || "";
        REB.escolhas[it.itemId] = t.checked && pid ? [pid] : [];
      });
      REB.confirmando = false;
      renderRebate();
      return;
    }
    var chk = t.getAttribute("data-reb-marcar");
    if (chk) {
      var it = rebItemPorId(chk);
      var s = (it && it.sugestao) || {};
      var pidSug = s.porMargem || s.porLucro || "";
      REB.escolhas[chk] = t.checked && pidSug ? [pidSug] : [];
      REB.confirmando = false;
      renderRebate();
      return;
    }
    var radio = t.getAttribute("data-reb-escolha");
    if (radio) {
      // Valor vazio = "Manter como está": limpa as promoções marcadas.
      // Senão alterna a promoção (várias podem ficar marcadas).
      var atuais = rebMarcadas(radio).slice();
      if (!t.value) atuais = [];
      else {
        var pos = atuais.indexOf(t.value);
        if (t.checked && pos < 0) atuais.push(t.value);
        else if (!t.checked && pos >= 0) atuais.splice(pos, 1);
      }
      REB.escolhas[radio] = atuais;
      REB.preferencia = null;
      REB.confirmando = false;
      renderRebate();
    }
  }

  function onTeclaRebate(e) {
    if (!REB) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (REB.confirmando) { REB.confirmando = false; renderRebate(); rebFocar("#am-reb-participar"); return; }
      if (REB.avisoFechar) { REB.avisoFechar = false; renderRebate(); return; }
      fecharRebate(false);
      return;
    }
    if (e.key === "Tab") {
      // Foco preso no modal.
      var foc = Array.prototype.filter.call(
        REB.overlay.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'),
        function (n) { return n.offsetParent !== null; });
      if (!foc.length) return;
      var primeiro = foc[0], ultimo = foc[foc.length - 1];
      if (e.shiftKey && (document.activeElement === primeiro || !REB.overlay.contains(document.activeElement))) { e.preventDefault(); ultimo.focus(); }
      else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
    }
  }

  function rebFocar(sel) {
    if (!REB) return;
    var n = REB.overlay.querySelector(sel);
    if (n) n.focus();
  }

  // --- 1. Referência -------------------------------------------------------------
  function carregarReferenciasRebate() {
    var reb = REB;
    reb.referencias = null;
    reb.erroRefs = null;
    renderRebate();
    api("/anuncios-meli/promocoes-rebate/referencias?" + rebQs()).then(function (r) {
      if (REB !== reb) return;
      var d = r.data || {};
      if (!d.ok) {
        reb.erroRefs = rebMotivoResposta(r, "Não foi possível carregar as promoções da conta.");
        reb.referencias = [];
      } else {
        reb.referencias = Array.isArray(d.referencias) ? d.referencias : [];
        reb.padraoId = d.padraoId || null;
        var existe = function (id) { return reb.referencias.some(function (x) { return x.id === id; }); };
        reb.refId = reb.padraoId && existe(reb.padraoId) ? reb.padraoId : "";
      }
      var foco = document.activeElement && document.activeElement.id;
      renderRebate();
      if (foco === "am-reb-titulo" || !foco) rebFocar("#am-reb-ref");
    });
  }

  function rebRefSelecionada() {
    var lista = (REB && REB.referencias) || [];
    for (var i = 0; i < lista.length; i++) if (lista[i].id === REB.refId) return lista[i];
    return null;
  }

  function iniciarAnaliseRebate() {
    var reb = REB;
    var ref = rebRefSelecionada();
    if (!ref || reb.iniciando) return;
    reb.iniciando = true;
    reb.erro = null;
    renderRebate();
    api("/anuncios-meli/promocoes-rebate/analises", {
      method: "POST", body: rebCorpo({ referencia: { id: ref.id, tipo: ref.tipo } }),
    }).then(function (r) {
      if (REB !== reb) return;
      reb.iniciando = false;
      var d = r.data || {};
      // ANALISE_EM_ANDAMENTO com jobId: acompanha a que já está rodando.
      if (d.ok && d.jobId != null || (d.codigo === "ANALISE_EM_ANDAMENTO" && d.jobId != null)) {
        reb.jobId = d.jobId;
        reb.job = null;
        reb.passo = "analisando";
        renderRebate();
        rebFocarInicio();
        rebPollar();
        return;
      }
      reb.erro = rebMotivoResposta(r, "Não foi possível iniciar a análise.");
      renderRebate();
    });
  }

  // --- Polling (2 e 4) ---------------------------------------------------------------
  function rebPollar() {
    var reb = REB;
    if (!reb || !reb.jobId) return;
    if (reb.timer) clearTimeout(reb.timer);
    var meuSeq = ++reb.seq;
    api("/anuncios-meli/promocoes-rebate/analises/" + encodeURIComponent(reb.jobId) + "?" + rebQs()).then(function (r) {
      if (REB !== reb || reb.seq !== meuSeq) return;
      var d = r.data || {};
      if (!d.ok || !d.job) {
        // Falha de rede pontual não derruba o acompanhamento; resposta
        // explícita do servidor (ok:false) encerra.
        if (r.status === 0) { rebAgendar(reb); return; }
        reb.erro = rebMotivoResposta(r, "Não foi possível acompanhar a análise.");
        delete rebJobEmCurso[reb.chave];
        if (reb.passo === "execucao") reb.erroExecutar = reb.erro;
        renderRebate();
        return;
      }
      var job = d.job;
      // Logo depois do POST executar, o GET ainda pode trazer o job na fase
      // de análise: mantém a fila local até o servidor virar a fase.
      if (reb.passo === "execucao" && job.fase !== "execucao") {
        reb.job = Object.assign({}, job, { fase: reb.job && reb.job.fase, status: reb.job && reb.job.status, execucao: reb.job && reb.job.execucao });
        if (job.status === "erro") {
          reb.erroExecutar = job.erro || "A execução foi interrompida.";
          reb.job.status = "erro";
          delete rebJobEmCurso[reb.chave];
          renderRebate();
          return;
        }
        rebAgendar(reb);
        return;
      }
      reb.job = job;
      if (reb.passo === "execucao") {
        if (job.status === "processando") reb.viuProcessando = true;
        else reb.pollsParado++;
      }
      if (reb.passo === "analisando") {
        if (job.status === "erro") {
          reb.erro = job.erro || "A análise foi interrompida. Tente de novo.";
          delete rebJobEmCurso[reb.chave];
          renderRebate();
          return;
        }
        if (job.fase === "execucao" && job.execucao) {
          // Retomado depois de fechar no meio da execução.
          reb.passo = "execucao";
          reb.executou = true;
        } else if (job.status === "concluido" && job.resultado) {
          delete rebJobEmCurso[reb.chave];
          reb.passo = "previa";
          reb.escolhas = rebEscolhasIniciais();
          reb.aba = rebAbaInicial();
          reb.preferencia = null;
          renderRebate();
          rebFocarInicio();
          return;
        } else {
          renderRebate();
          rebAgendar(reb);
          return;
        }
      }
      if (reb.passo === "execucao") {
        if (job.status === "erro" && job.fase === "execucao") {
          reb.erroExecutar = job.erro || "A execução foi interrompida. Veja abaixo o que já foi feito.";
          delete rebJobEmCurso[reb.chave];
          renderRebate();
          return;
        }
        if (rebExecucaoConcluida(job)) {
          delete rebJobEmCurso[reb.chave];
          renderRebate();
          rebFocar(rebFalhas().length ? "#am-reb-retentar" : "#am-reb-fechar-final");
          return;
        }
        renderRebate();
        rebAgendar(reb);
      }
    });
  }

  function rebAgendar(reb) {
    reb.timer = setTimeout(function () { if (REB === reb) rebPollar(); }, REB_POLL_MS);
  }

  // A execução terminou quando o job saiu de "processando" na fase execucao
  // e nenhum item enviado está pendente. Num retry, o GET pode ainda trazer a
  // execução ANTERIOR (já concluída, com as falhas): por isso só se aceita
  // depois de ter visto "processando", ou com o total batendo com o que foi
  // enviado por 2 polls, ou — rede de segurança para um contrato diferente
  // do esperado — depois de 4 polls parados.
  function rebExecucaoConcluida(job) {
    if (!job || job.fase !== "execucao" || job.status === "processando" || !job.execucao) return false;
    if (job.status === "erro") return true;
    var itens = job.execucao.itens || [];
    if (itens.some(function (x) { return x.status === "pendente"; })) return false;
    if (!REB || REB.retomado) return true;
    var enviados = REB.enviadas || [];
    var cobre = enviados.every(function (e) {
      return itens.some(function (x) { return x.itemId === e.itemId && x.promotionId === e.promotionId; });
    });
    if (!cobre) return REB.pollsParado >= 4;
    if (REB.viuProcessando) return true;
    if (rebNum(job.execucao.total) === enviados.length && REB.pollsParado >= 2) return true;
    return REB.pollsParado >= 4;
  }

  // --- 4. Execução -------------------------------------------------------------------
  function executarRebate(escolhas) {
    var reb = REB;
    if (!reb || !escolhas.length || reb.enviando) return;
    reb.enviando = true;
    reb.erroExecutar = null;
    renderRebate();
    api("/anuncios-meli/promocoes-rebate/analises/" + encodeURIComponent(reb.jobId) + "/executar", {
      method: "POST", body: rebCorpo({ escolhas: escolhas }),
    }).then(function (r) {
      if (REB !== reb) return;
      reb.enviando = false;
      var d = r.data || {};
      if (!d.ok) {
        reb.erroExecutar = rebMotivoResposta(r, "Não foi possível iniciar a participação.");
        reb.confirmando = false;
        renderRebate();
        rebFocar(reb.passo === "execucao" ? "#am-reb-retentar" : "#am-reb-participar");
        return;
      }
      reb.enviadas = escolhas.slice();
      reb.passo = "execucao";
      reb.confirmando = false;
      reb.executou = true;
      reb.pollsParado = 0;
      reb.viuProcessando = false;
      reb.retomado = false;
      // O GET ainda pode trazer a execução anterior até o servidor trocar.
      reb.job = Object.assign({}, reb.job, {
        fase: "execucao", status: "processando",
        execucao: { total: escolhas.length, processados: 0, itens: escolhas.map(function (x) {
          return { itemId: x.itemId, promotionId: x.promotionId, tipo: x.tipo, status: "pendente", codigo: null, motivo: null };
        }) },
      });
      renderRebate();
      rebFocarInicio();
      rebPollar();
    });
  }

  function rebItensExecucao() {
    var ex = REB && REB.job && REB.job.execucao;
    var itens = (ex && ex.itens) || [];
    // Só o que foi enviado nesta rodada (o servidor pode manter as anteriores).
    var enviados = REB.enviadas || [];
    if (!enviados.length) return itens;
    var filtrados = itens.filter(function (x) { return enviados.some(function (e) { return e.itemId === x.itemId && e.promotionId === x.promotionId; }); });
    return filtrados.length ? filtrados : itens;
  }

  // --- Mensagem para o cliente (WhatsApp) ----------------------------------------
  // Texto pronto para colar no WhatsApp do seller: o que o radar encontrou
  // (prévia = proposta) ou o que de fato entrou (execução = feito), anúncio a
  // anúncio, com preço, rebate, margem e lucro antes → depois. Formatação do
  // WhatsApp: *negrito* e _itálico_. Nada sai do navegador — só a área de
  // transferência.

  // Participações confirmadas em TODAS as rodadas (o "tentar de novo" envia só
  // as falhas, e a lista da execução passa a mostrar só elas).
  function rebRegistrarConfirmadas() {
    if (!REB) return [];
    REB.confirmadas = REB.confirmadas || {};
    var ex = REB.job && REB.job.execucao;
    ((ex && ex.itens) || []).forEach(function (x) {
      if (x.status === "ok") REB.confirmadas[x.itemId + "|" + x.promotionId] = { itemId: x.itemId, promotionId: x.promotionId, precoConfirmado: x.precoConfirmado };
    });
    return Object.keys(REB.confirmadas).map(function (k) { return REB.confirmadas[k]; });
  }

  function rebWaPct(v) {
    var n = rebNum(v);
    return n === null ? "—" : n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
  }

  // "+0,8 p.p." / "−R$ 0,55"
  function rebWaSinal(n, tipo) {
    var abs = Math.abs(n);
    var txt = tipo === "pp"
      ? abs.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " p.p."
      : formatMoeda(abs);
    return (n > 0 ? "+" : n < 0 ? "−" : "") + txt;
  }

  function rebWaDelta(n, tipo) {
    return n === null || n === 0 ? "" : " (" + rebWaSinal(n, tipo) + ")";
  }

  // pares: [{ itemId, promotionId, precoConfirmado? }]; modo "proposta" | "feito".
  function rebMensagemCliente(pares, modo) {
    var reb = REB;
    var job = (reb && reb.job) || {};
    var nomeRef = (job.referencia && job.referencia.nome) || "promoção de referência";
    var analisados = rebItens().length;
    var porItem = {}, ordem = [];
    pares.forEach(function (p) {
      var it = rebItemPorId(p.itemId);
      var c = rebCandidata(it, p.promotionId);
      if (!it || !c) return;
      if (!porItem[p.itemId]) { porItem[p.itemId] = { it: it, promos: [] }; ordem.push(p.itemId); }
      porItem[p.itemId].promos.push({ c: c, preco: rebNum(p.precoConfirmado) !== null ? p.precoConfirmado : c.preco });
    });
    if (!ordem.length) return "";

    var feito = modo === "feito";
    var n = ordem.length;
    var somaRebate = 0, nRebate = 0, somaLucro = 0, nLucro = 0, somaMargem = 0, nMargem = 0;
    var linhas = [];
    linhas.push("*Radar de subsídios" + (AM.clienteAtual && AM.clienteAtual.nome ? " · " + AM.clienteAtual.nome : "") + "*");
    linhas.push("");
    linhas.push("Analisamos " + analisados + (analisados === 1 ? " anúncio" : " anúncios") + " da *" + nomeRef + "* atrás de promoções em que o Mercado Livre paga parte do desconto (rebate).");
    linhas.push("");
    linhas.push(feito
      ? "✅ *" + n + (n === 1 ? " anúncio entrou" : " anúncios entraram") + " em promoção com rebate:*"
      : "📋 *Encontramos " + n + (n === 1 ? " anúncio" : " anúncios") + " que ganham entrando em promoção com rebate:*");
    ordem.forEach(function (id, i) {
      var g = porItem[id];
      var hoje = rebAtual(g.it);
      linhas.push("");
      linhas.push((i + 1) + ". *" + (g.it.titulo || "Anúncio") + "* (" + id + ")");
      g.promos.forEach(function (p) {
        var c = p.c;
        var vig = (c.inicio || c.fim) ? " · " + rebVigencia({ inicio: c.inicio, fim: c.fim }) : "";
        var rebate = rebNum(c.subsidioMl);
        var dLucro = rebNum(c.ganhoLucro), dMargem = rebNum(c.ganhoMargemPp);
        if (rebate !== null && rebate > 0) { somaRebate += rebate; nRebate++; }
        if (dLucro !== null) { somaLucro += dLucro; nLucro++; }
        if (dMargem !== null) { somaMargem += dMargem; nMargem++; }
        linhas.push("   Promoção: " + (c.nome || c.promotionId) + vig);
        linhas.push("   Preço: " + formatMoeda(hoje.preco) + " → " + formatMoeda(p.preco) +
          (rebate !== null && rebate > 0 ? " · rebate do ML: " + formatMoeda(rebate) + " por venda" : ""));
        linhas.push("   Margem: " + rebWaPct(hoje.margemPercent) + " → " + rebWaPct(c.margemPercent) + rebWaDelta(dMargem, "pp") +
          " · Lucro/un: " + formatMoeda(hoje.lucro) + " → " + formatMoeda(c.lucro) + rebWaDelta(dLucro, "rs"));
      });
    });
    linhas.push("");
    linhas.push("*Resumo*");
    if (nRebate) linhas.push("• Rebate do Mercado Livre: " + formatMoeda(Math.round((somaRebate / nRebate) * 100) / 100) + " por venda, em média");
    if (nMargem) linhas.push("• Margem: " + rebWaSinal(Math.round((somaMargem / nMargem) * 10) / 10, "pp") + " por anúncio, em média");
    if (nLucro) linhas.push("• Lucro: " + rebWaSinal(Math.round((somaLucro / nLucro) * 100) / 100, "rs") + " por venda, em média");
    linhas.push("• A *" + nomeRef + "* continua ativa em todos os anúncios.");
    linhas.push("");
    linhas.push(feito
      ? "Seguimos acompanhando as vendas desses anúncios."
      : "Se estiver de acordo, a gente já coloca esses anúncios nas promoções.");
    return linhas.join("\n");
  }

  function rebCopiarMensagem(modo) {
    var pares = modo === "feito" ? rebRegistrarConfirmadas() : rebEscolhasSelecionadas();
    var txt = rebMensagemCliente(pares, modo);
    if (!txt) { toast("Nenhum anúncio para incluir na mensagem."); return; }
    copiarTexto(txt, "Mensagem copiada. Cole no WhatsApp do cliente.");
  }

  function rebFalhas() {
    if (!REB || REB.passo !== "execucao" || rebProcessando()) return [];
    return rebItensExecucao().filter(function (x) { return x.status === "falha"; }).map(function (x) {
      var tipo = x.tipo;
      if (!tipo) {
        var c = rebCandidata(rebItemPorId(x.itemId), x.promotionId);
        tipo = c ? c.tipo : undefined;
      }
      return { itemId: x.itemId, promotionId: x.promotionId, tipo: tipo };
    });
  }

  // --- Render ------------------------------------------------------------------------
  // Painel lateral (layout "A + B" aprovado no canvas): cabeçalho com a
  // referência, abas na prévia (Recomendados em tabela, Escolher em cards
  // margem × lucro, Sem ganho, Descartados) e rodapé fixo com o total.
  var REB_ABAS = [
    { chave: "recomendado", rotulo: "Recomendados" },
    { chave: "escolha", rotulo: "Escolher margem ou lucro" },
    { chave: "sem_ganho", rotulo: "Sem ganho" },
    { chave: "descartado", rotulo: "Descartados" },
  ];

  function rebBannerHtml(tipo, msg) {
    return '<div class="vf-banner is-' + tipo + '"' + (tipo === "danger" ? ' role="alert"' : ' role="status"') +
      '><div class="vf-banner__content"><p class="vf-banner__description">' + escapeHtml(msg) + "</p></div></div>";
  }

  function rebProgressoHtml(proc, total, rotulo) {
    var t = rebNum(total) || 0, p = Math.min(rebNum(proc) || 0, t || Infinity);
    var pct = t > 0 ? Math.round((p / t) * 100) : 0;
    return '<div class="am-reb-progresso" data-reb-progresso>' +
      '<div class="vf-progress" role="progressbar" aria-label="' + escapeAttr(rotulo) + '" aria-valuemin="0" aria-valuemax="' + t + '" aria-valuenow="' + p + '">' +
        '<div class="vf-progress__bar" style="width:' + pct + '%"></div></div>' +
      '<p class="am-reb-progresso__txt" aria-live="polite">' + (t > 0 ? p + " de " + t + " anúncios" : "Preparando…") + "</p></div>";
  }

  function rebSubtituloHtml() {
    var reb = REB;
    if (reb.passo === "referencia") return "Escolha a promoção de referência para comparar.";
    var job = reb.job || {};
    var nomeRef = (job.referencia && job.referencia.nome) || (rebRefSelecionada() || {}).nome || "";
    var txt = "Comparando com <strong>" + escapeHtml(nomeRef || "a referência") + "</strong>";
    if (reb.passo === "previa") {
      var total = rebItens().length;
      txt += " · " + total + (total === 1 ? " anúncio analisado" : " anúncios analisados") +
        ' · <button type="button" class="am-reb-link" id="am-reb-trocar" data-reb-acao="trocar-ref">trocar referência</button>';
    }
    return txt;
  }

  function rebAbasHtml() {
    var res = (REB.job && REB.job.resultado) || {};
    var r = res.resumo || {};
    return '<div class="am-reb-abas" role="tablist" aria-label="Grupos" data-reb-resumo>' + REB_ABAS.map(function (a) {
      var n = r[a.chave] != null ? r[a.chave] : rebItens(a.chave).length;
      var ativa = REB.aba === a.chave;
      return '<button type="button" role="tab" class="am-reb-aba' + (ativa ? " is-active" : "") + '" id="am-reb-aba-' + a.chave + '"' +
        ' aria-selected="' + (ativa ? "true" : "false") + '" aria-controls="am-reb-painel" tabindex="' + (ativa ? "0" : "-1") + '"' +
        ' data-reb-acao="aba" data-reb-aba="' + a.chave + '">' + a.rotulo +
        ' <span class="am-reb-aba__n">' + n + "</span></button>";
    }).join("") + "</div>";
  }

  function renderRebate() {
    if (!REB) return;
    var reb = REB;
    var box = reb.overlay.querySelector(".am-reb-box");
    var focoId = document.activeElement && reb.overlay.contains(document.activeElement) ? document.activeElement.id : "";
    var corpo = "", rodape = "";
    var p = reb.passo;
    if (p === "referencia") { corpo = rebPassoReferenciaHtml(); rodape = rebRodapeReferenciaHtml(); }
    else if (p === "analisando") { corpo = rebPassoAnalisandoHtml(); rodape = rebRodapeAnalisandoHtml(); }
    else if (p === "previa") { corpo = rebPassoPreviaHtml(); rodape = rebRodapePreviaHtml(); }
    else { corpo = rebPassoExecucaoHtml(); rodape = rebRodapeExecucaoHtml(); }

    if (reb.avisoFechar) {
      rodape = '<div class="am-reb-confirma" role="alert">' +
        '<p class="am-reb-confirma__txt">A participação continua no Mercado Livre mesmo se você fechar. Reabra o "Radar de subsídios" para acompanhar.</p>' +
        '<div class="am-reb-confirma__acoes">' +
          '<button type="button" class="vf-btn vf-btn--secondary" id="am-reb-fechar-mesmo" data-reb-acao="fechar-mesmo">Fechar mesmo assim</button>' +
          '<button type="button" class="vf-btn vf-btn--primary" id="am-reb-continuar" data-reb-acao="continuar">Continuar acompanhando</button>' +
        "</div></div>";
    }

    var scroll = box.querySelector(".am-reb-corpo");
    var scrollTop = scroll ? scroll.scrollTop : 0;
    var chaveRender = p + ":" + (p === "previa" ? reb.aba : "");
    var abas = p === "previa";

    box.innerHTML = '<header class="am-reb-head' + (abas ? " tem-abas" : "") + '">' +
        '<div class="am-reb-head__topo"><div class="am-reb-head__txt">' +
          '<h2 class="am-reb-titulo" id="am-reb-titulo" tabindex="-1">Radar de subsídios</h2>' +
          '<p class="am-reb-sub">' + rebSubtituloHtml() + "</p></div>" +
          '<button type="button" class="am-reb-x" id="am-reb-x" data-reb-acao="fechar" aria-label="Fechar">' + icFechar() + "</button></div>" +
        (abas ? rebAbasHtml() : "") +
      "</header>" +
      '<div class="am-reb-corpo"' + (abas ? ' id="am-reb-painel" role="tabpanel" aria-labelledby="am-reb-aba-' + reb.aba + '"' : "") + ">" + corpo + "</div>" +
      '<footer class="am-reb-rodape">' + rodape + "</footer>";

    var novoScroll = box.querySelector(".am-reb-corpo");
    if (novoScroll && chaveRender === reb.ultimoPassoRender) novoScroll.scrollTop = scrollTop;
    reb.ultimoPassoRender = chaveRender;
    if (focoId) {
      var n = document.getElementById(focoId);
      if (n && reb.overlay.contains(n)) n.focus();
    }
  }

  function rebPassoReferenciaHtml() {
    var reb = REB;
    var html = '<p class="am-reb-intro">Vamos olhar só os anúncios ativos nesta promoção e procurar promoções com subsídio do Mercado Livre e preço menor, que deixem margem ou lucro maiores. A promoção de referência não é alterada.</p>';
    if (reb.referencias === null) return html + estadoHtml("loading", "Carregando promoções da conta…");
    if (reb.erroRefs) {
      return html + rebBannerHtml("danger", reb.erroRefs) +
        '<div class="am-reb-cluster"><button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-reb-acao="recarregar-refs">Tentar de novo</button></div>';
    }
    if (!reb.referencias.length) {
      return html + estadoHtml("empty", "Nenhuma promoção ativa ou programada nesta conta",
        "Para usar esta análise, os anúncios precisam estar numa promoção de referência (por exemplo, a Vendex do mês).");
    }
    var ref = rebRefSelecionada();
    html += '<div class="vf-field am-reb-campo"><label class="vf-field__label" for="am-reb-ref">Promoção de referência</label>' +
      '<select id="am-reb-ref" class="vf-select">' +
      (reb.refId ? "" : '<option value="" selected>Escolha a promoção de referência…</option>') +
      reb.referencias.map(function (x) {
        var txt = (x.nome || x.id) + " · " + (x.tipoLabel || x.tipo || "") + " · " + rebVigencia(x);
        return '<option value="' + escapeAttr(x.id) + '"' + (x.id === reb.refId ? " selected" : "") + ">" + escapeHtml(txt) + "</option>";
      }).join("") + "</select>";
    if (ref) {
      html += '<p class="vf-field__hint">' + escapeHtml(ref.tipoLabel || ref.tipo || "") + " · " + escapeHtml(rebVigencia(ref)) +
        (ref.id === reb.padraoId ? " · sugerida para este mês" : "") + "</p>";
    } else if (!reb.padraoId) {
      html += '<p class="vf-field__hint">Não encontramos a Vendex deste mês — escolha a promoção de referência.</p>';
    }
    html += "</div>";
    if (reb.erro) html += rebBannerHtml("danger", reb.erro);
    return html;
  }

  function rebRodapeReferenciaHtml() {
    var reb = REB;
    var pode = !!rebRefSelecionada() && !reb.iniciando;
    return '<div class="am-reb-rodape__acoes">' +
      '<button type="button" class="vf-btn vf-btn--secondary" id="am-reb-cancelar" data-reb-acao="fechar">Cancelar</button>' +
      '<button type="button" class="vf-btn vf-btn--primary" id="am-reb-analisar" data-reb-acao="analisar"' + (pode ? "" : " disabled") + ">" +
      (reb.iniciando ? "Iniciando…" : "Analisar") + "</button></div>";
  }

  function rebPassoAnalisandoHtml() {
    var reb = REB;
    var job = reb.job || {};
    if (reb.erro) return rebBannerHtml("danger", reb.erro);
    var prog = job.progresso || {};
    var t = rebNum(prog.total) || 0, p = Math.min(rebNum(prog.processados) || 0, t || Infinity);
    var pct = t > 0 ? Math.round((p / t) * 100) : 0;
    var res = prog.resumo || {};
    var comGanho = (rebNum(res.recomendado) || 0) + (rebNum(res.escolha) || 0);
    // O corpo é recriado a cada consulta: o atraso negativo mantém a varredura
    // do radar contínua em vez de recomeçar do zero.
    var atraso = -(Date.now() % 2400);
    var placar = function (chave, n, rotulo, classe) {
      return '<div class="am-reb-placar__item' + (classe ? " " + classe : "") + '" data-reb-placar="' + chave + '">' +
        '<span class="am-reb-placar__n">' + n + "</span>" +
        '<span class="am-reb-placar__rotulo">' + rotulo + "</span></div>";
    };
    var eta = rebEtaTexto(p, t);
    return '<div class="am-reb-radar-an" data-reb-progresso>' +
        '<div class="am-reb-radar" aria-hidden="true"><span class="am-reb-radar__varredura" style="animation-delay:' + atraso + 'ms"></span>' +
          '<span class="am-reb-radar__pct">' + (t > 0 ? pct + "%" : "") + "</span></div>" +
        '<p class="am-reb-radar-an__titulo">Procurando subsídios melhores</p>' +
        '<p class="am-reb-radar-an__txt" aria-live="polite">' + (t > 0 ? p + " de " + t + " anúncios" : "Lendo os anúncios da promoção…") +
          (eta ? " · " + eta : "") + "</p>" +
        '<div class="vf-progress am-reb-radar-an__barra" role="progressbar" aria-label="Progresso da análise" aria-valuemin="0" aria-valuemax="' + t + '" aria-valuenow="' + p + '">' +
          '<div class="vf-progress__bar" style="width:' + pct + '%"></div></div>' +
      "</div>" +
      '<div class="am-reb-placar" aria-label="Encontrados até agora">' +
        placar("ganho", comGanho, "melhoram margem ou lucro", "is-ganho") +
        placar("sem_ganho", rebNum(res.sem_ganho) || 0, "sem ganho") +
        placar("descartado", rebNum(res.descartado) || 0, "descartados") +
      "</div>" +
      '<p class="am-reb-radar-an__nota">Margem e lucro cotados ao vivo no Mercado Livre. Pode fechar: a análise continua e você retoma ao reabrir.</p>';
  }

  // Tempo restante pelo ritmo observado desde que este modal começou a
  // acompanhar o job (só depois de alguns anúncios, para não chutar).
  function rebEtaTexto(p, t) {
    var reb = REB;
    var agora = Date.now();
    if (!reb.eta || reb.eta.jobId !== reb.jobId || p < reb.eta.p) reb.eta = { jobId: reb.jobId, t: agora, p: p };
    var feitos = p - reb.eta.p, passou = agora - reb.eta.t;
    if (!t || p >= t || feitos < 3 || passou < 3000) return "";
    var seg = Math.round(((passou / feitos) * (t - p)) / 1000);
    if (seg < 60) return "menos de 1 min restante";
    var min = Math.round(seg / 60);
    return "~" + min + " min restante" + (min > 1 ? "s" : "");
  }

  function rebRodapeAnalisandoHtml() {
    if (REB.erro) {
      return '<div class="am-reb-rodape__acoes">' +
        '<button type="button" class="vf-btn vf-btn--secondary" id="am-reb-fechar-erro" data-reb-acao="fechar">Fechar</button>' +
        '<button type="button" class="vf-btn vf-btn--primary" id="am-reb-voltar" data-reb-acao="voltar-ref">Voltar</button></div>';
    }
    return '<div class="am-reb-rodape__acoes"><button type="button" class="vf-btn vf-btn--secondary" id="am-reb-fechar-an" data-reb-acao="fechar">Fechar</button></div>';
  }

  // --- Prévia ------------------------------------------------------------------------
  function rebPassoPreviaHtml() {
    var reb = REB;
    var html = "";
    if (reb.erroExecutar) html += rebBannerHtml("danger", reb.erroExecutar);
    var rec = rebItens("recomendado"), esc = rebItens("escolha");
    if (!rec.length && !esc.length && (reb.aba === "recomendado" || reb.aba === "escolha")) {
      html += estadoHtml("empty", "Nenhuma promoção com rebate melhora estes anúncios agora",
        "Veja os motivos nas abas Sem ganho e Descartados. A referência continua como está.");
      return html;
    }
    if (reb.aba === "recomendado") return html + rebAbaRecomendadosHtml(rec);
    if (reb.aba === "escolha") return html + rebAbaEscolhaHtml(esc);
    if (reb.aba === "sem_ganho") {
      return html + rebAbaListaHtml("sem_ganho", rebItens("sem_ganho"), "Nenhuma promoção com subsídio melhora margem nem lucro destes anúncios.");
    }
    return html + rebAbaListaHtml("descartado", rebItens("descartado"), "");
  }

  function rebAbaRecomendadosHtml(rec) {
    if (!rec.length) return '<p class="am-reb-vazio">Nenhum anúncio em que a mesma promoção melhore margem e lucro.</p>';
    var reb = REB;
    var todos = rec.every(function (it) { return rebMarcadas(it.itemId).length > 0; });
    // Uma coluna por medida: valor com a promoção sugerida em destaque, o ganho
    // logo abaixo e o "hoje" por último, para comparar sem decifrar posição.
    var medida = function (novo, ganho, hoje, attr) {
      return '<span role="cell" class="am-reb-medida"' + (attr || "") + ">" +
        '<span class="am-reb-medida__valor">' + novo + "</span>" +
        '<span class="am-reb-medida__ganho">' + ganho + "</span>" +
        '<span class="am-reb-medida__hoje">hoje ' + hoje + "</span></span>";
    };
    return '<div class="am-reb-tab" role="table" aria-label="Anúncios recomendados" data-reb-grupo-sec="recomendado">' +
      '<div class="am-reb-tab__linha am-reb-tab__cab" role="row">' +
        '<span role="columnheader"><input type="checkbox" id="am-reb-todos" data-reb-todos aria-label="Selecionar todos"' + (todos ? " checked" : "") + "></span>" +
        '<span role="columnheader">Anúncio</span>' +
        '<span role="columnheader">Preço</span>' +
        '<span role="columnheader">Margem</span>' +
        '<span role="columnheader">Lucro/un</span>' +
        '<span role="columnheader">Promoção sugerida</span>' +
      "</div>" +
      rec.map(function (it, i) {
        var s = it.sugestao || {};
        var c = rebCandidata(it, s.porMargem || s.porLucro) || (it.candidatas || [])[0];
        var marcado = !!(c && rebMarcadas(it.itemId).indexOf(c.promotionId) >= 0);
        var hoje = rebAtual(it);
        var celulas = c
          ? medida(formatMoeda(c.preco),
              rebNum(c.subsidioMl) > 0 ? '<span class="am-reb-ganho is-pos" data-reb-rebate>+' + formatMoeda(c.subsidioMl) + " de rebate</span>" : "",
              formatMoeda(hoje.preco)) +
            medida(rebPct(c.margemPercent), rebGanhoHtml(c.ganhoMargemPp, "pp"), rebPct(hoje.margemPercent), " data-reb-margem") +
            medida(formatMoeda(c.lucro), rebGanhoHtml(c.ganhoLucro, "rs"), formatMoeda(hoje.lucro), " data-reb-lucro") +
            '<span role="cell" class="am-reb-medida am-reb-medida--promo">' +
              '<span class="am-reb-medida__nome"' + (c.tipoLabel ? ' title="' + escapeAttr(c.tipoLabel) + '"' : "") + ">" + escapeHtml(c.nome || c.promotionId) + "</span>" +
              '<span class="am-reb-medida__hoje" data-reb-hoje-nome>hoje ' + escapeHtml(hoje.nome || "") + "</span></span>"
          : '<span role="cell" class="am-reb-medida am-reb-medida--vazia">—</span>';
        return '<div class="am-reb-tab__linha" role="row" data-reb-item="' + escapeAttr(it.itemId) + '">' +
          '<span role="cell"><input type="checkbox" id="am-reb-chk-' + i + '" data-reb-marcar="' + escapeAttr(it.itemId) + '"' +
            (marcado ? " checked" : "") + (c ? "" : " disabled") + ' aria-label="Participar com ' + escapeAttr(it.titulo || it.itemId) + '"></span>' +
          '<span role="cell">' + rebAnuncioHtml(it) + "</span>" +
          celulas +
          "</div>";
      }).join("") + "</div>";
  }

  function rebAbaEscolhaHtml(esc) {
    if (!esc.length) return '<p class="am-reb-vazio">Nenhum anúncio pedindo escolha entre margem e lucro.</p>';
    var pref = REB.preferencia;
    var btn = function (id, acao, chave, rotulo) {
      var ativo = pref === chave;
      return '<button type="button" role="radio" class="am-reb-rapida__btn' + (ativo ? " is-active" : "") + '" id="' + id + '" data-reb-acao="' + acao + '"' +
        ' aria-checked="' + (ativo ? "true" : "false") + '">' + (ativo ? icCheck(14) : "") + rotulo + "</button>";
    };
    var n = esc.length;
    return '<section class="am-reb-rapida" aria-labelledby="am-reb-rapida-t">' +
        '<div class="am-reb-rapida__txt"><span class="am-reb-rapida__titulo" id="am-reb-rapida-t">Escolha rápida para ' +
          (n === 1 ? "o anúncio" : "os " + n + " anúncios") + "</span>" +
          '<span class="am-reb-rapida__dica">Marca a mesma opção em todos. Depois você ainda pode trocar card a card.</span></div>' +
        '<div class="am-reb-rapida__btns" role="radiogroup" aria-labelledby="am-reb-rapida-t">' +
          btn("am-reb-pref-margem", "preferir-margem", "margem", "Maior margem") +
          btn("am-reb-pref-lucro", "preferir-lucro", "lucro", "Maior lucro") +
          btn("am-reb-pref-ref", "preferir-ref", "ref", "Manter como está") +
        "</div></section>" +
      esc.map(function (it, i) { return rebEscolhaItemHtml(it, i); }).join("");
  }

  // tipo "preco": queda de preço de venda é boa (verde), alta é ruim.
  function rebDeltaHtml(v, tipo) {
    var n = rebNum(v);
    if (n === null) return '<span class="am-reb-delta">atual</span>';
    var abs = Math.abs(n);
    var txt = tipo === "pp"
      ? rebSinal(n) + abs.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " p.p."
      : rebSinal(n) + "R$ " + abs.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var bom = tipo === "preco" ? n < 0 : n > 0;
    var ruim = tipo === "preco" ? n > 0 : n < 0;
    return '<span class="am-reb-delta am-reb-ganho' + (bom ? " is-pos" : ruim ? " is-neg" : "") + '">' + txt + "</span>";
  }

  // Rebate pequeno sob o preço de venda — só quando a promoção tem subsídio.
  // Rebate pequeno sob o lucro (é dinheiro que entra no lucro) — só quando
  // a promoção tem subsídio.
  function rebRebateHtml(subsidio) {
    if (!(rebNum(subsidio) > 0)) return "";
    return '<span class="am-reb-rebate">+' + formatMoeda(subsidio) + " de rebate</span>";
  }

  function rebOpcaoHtml(o, nomeRadio, id, itemId, atual) {
    // atual = lista de promoções marcadas; "Manter como está" vale quando está vazia.
    var sel = o.valor ? atual.indexOf(o.valor) >= 0 : atual.length === 0;
    var vig = (o.inicio || o.fim) ? rebVigencia({ inicio: o.inicio, fim: o.fim }) : "";
    return '<label class="am-reb-opcao' + (sel ? " is-selecionada" : "") + '" for="' + id + '">' +
      '<span class="am-reb-opcao__cab"><input type="checkbox" id="' + id + '" name="' + nomeRadio + '" value="' + escapeAttr(o.valor) + '" data-reb-escolha="' + escapeAttr(itemId) + '"' +
        (sel ? " checked" : "") + '><span class="am-reb-opcao__nome" title="' + escapeAttr(o.promo || "") + '">' + escapeHtml(o.promo || "") + "</span>" +
        '<span class="am-reb-opcao__rotulo">' + escapeHtml(o.rotulo) + "</span></span>" +
      (vig ? '<span class="am-reb-opcao__vigencia" title="Vigência da promoção">' + escapeHtml(vig) + "</span>" : "") +
      '<span class="am-reb-metricas">' +
        '<span class="am-reb-metrica"><span class="am-reb-metrica__rotulo">Preço de venda</span>' +
          '<span class="am-reb-metrica__valor">' + formatMoeda(o.preco) + "</span>" + rebDeltaHtml(o.dPreco, "preco") + "</span>" +
        '<span class="am-reb-metrica"><span class="am-reb-metrica__rotulo">Margem</span>' +
          '<span class="am-reb-metrica__valor">' + rebPct(o.margem) + "</span>" + rebDeltaHtml(o.dMargem, "pp") + "</span>" +
        '<span class="am-reb-metrica"><span class="am-reb-metrica__rotulo">Lucro/un</span>' +
          '<span class="am-reb-metrica__valor">' + formatMoeda(o.lucro) + "</span>" + rebDeltaHtml(o.dLucro, "rs") + rebRebateHtml(o.subsidio) + "</span>" +
      "</span></label>";
  }

  function rebEscolhaItemHtml(it, i) {
    var s = it.sugestao || {};
    var atual = rebMarcadas(it.itemId);
    var nome = "am-reb-esc-" + i;
    var hoje = rebAtual(it);
    var refJob = (REB.job && REB.job.referencia) || {};
    var opcoes = [{
      valor: "", rotulo: "Manter como está", margem: hoje.margemPercent, lucro: hoje.lucro, dMargem: null, dLucro: null, dPreco: null,
      promo: hoje.nome, preco: hoje.preco, subsidio: hoje.subsidioMl, pct: hoje.meliPercentage,
      inicio: hoje.inicio || refJob.inicio || null, fim: hoje.fim || refJob.fim || null,
    }];
    var vistos = {};
    function add(pid, rotulo) {
      var c = rebCandidata(it, pid);
      if (!c || vistos[pid]) return;
      vistos[pid] = true;
      opcoes.push({
        valor: c.promotionId, rotulo: rotulo, margem: c.margemPercent, lucro: c.lucro, dMargem: c.ganhoMargemPp, dLucro: c.ganhoLucro,
        // Queda do preço de venda em relação ao de hoje (centavos, sem resíduo de float).
        dPreco: rebNum(c.preco) !== null && rebNum(hoje.preco) !== null ? Math.round(c.preco * 100 - hoje.preco * 100) / 100 : null,
        promo: c.nome || c.promotionId, preco: c.preco, subsidio: c.subsidioMl, pct: c.meliPercentage,
        inicio: c.inicio || null, fim: c.fim || null,
      });
    }
    if (s.porMargem && s.porMargem === s.porLucro) add(s.porMargem, "Maior margem e lucro");
    add(s.porMargem, "Maior margem");
    add(s.porLucro, "Maior lucro");
    (it.candidatas || []).forEach(function (c) { add(c.promotionId, "Outra opção"); });

    return '<article class="am-reb-escolha" data-reb-item="' + escapeAttr(it.itemId) + '">' +
      '<div class="am-reb-escolha__topo">' + rebThumbHtml(it.thumbnail) +
        '<h3 class="am-reb-escolha__titulo">' + escapeHtml(it.titulo || "Anúncio sem título") + "</h3>" +
        '<span class="am-reb-escolha__id vf-mono">' + escapeHtml(it.itemId) + "</span></div>" +
      '<fieldset class="am-reb-opcoes"><legend class="vf-visually-hidden">Promoções (pode marcar mais de uma) para' + escapeHtml(it.titulo || it.itemId) + "</legend>" +
        opcoes.map(function (o, k) { return rebOpcaoHtml(o, nome, nome + "-" + k, it.itemId, atual); }).join("") +
      "</fieldset></article>";
  }

  function rebAbaListaHtml(chave, itens, dica) {
    if (!itens.length) return '<p class="am-reb-vazio">Nenhum anúncio neste grupo.</p>';
    return (dica ? '<p class="am-reb-intro">' + escapeHtml(dica) + "</p>" : "") +
      '<ul class="am-reb-lista" data-reb-grupo="' + chave + '">' + itens.map(function (it) {
        var m = rebMotivoTexto(it);
        return '<li class="am-reb-lista__item" data-reb-item="' + escapeAttr(it.itemId) + '">' + rebAnuncioHtml(it) +
          (m ? '<span class="am-reb-lista__motivo">' + escapeHtml(m) + "</span>" : "") + "</li>";
      }).join("") + "</ul>";
  }

  function rebRodapePreviaHtml() {
    var reb = REB;
    var sel = rebEscolhasSelecionadas();
    var n = sel.length;
    var nRec = sel.filter(function (x) { var it = rebItemPorId(x.itemId); return it && it.status === "recomendado"; }).length;
    var nEsc = n - nRec;
    var vistosAn = {};
    sel.forEach(function (x) { vistosAn[x.itemId] = true; });
    var nAnuncios = Object.keys(vistosAn).length;
    var nomeRef = (reb.job.referencia && reb.job.referencia.nome) || "referência";
    if (reb.confirmando && n) {
      return '<div class="am-reb-confirma" role="alertdialog" aria-labelledby="am-reb-confirma-txt">' +
        '<p class="am-reb-confirma__txt" id="am-reb-confirma-txt">Participar de ' + n + (n === 1 ? " promoção" : " promoções") + " em " + nAnuncios + (nAnuncios === 1 ? " anúncio" : " anúncios") +
          "? A promoção <strong>" + escapeHtml(nomeRef) + "</strong> permanece ativa em todos — nada nela é alterado.</p>" +
        '<div class="am-reb-confirma__acoes">' +
          '<button type="button" class="vf-btn vf-btn--secondary" id="am-reb-cancelar-conf" data-reb-acao="cancelar-confirmacao"' + (reb.enviando ? " disabled" : "") + ">Voltar</button>" +
          '<button type="button" class="vf-btn vf-btn--primary" id="am-reb-confirmar" data-reb-acao="confirmar"' + (reb.enviando ? " disabled" : "") + ">" +
            (reb.enviando ? "Enviando…" : "Confirmar participação") + "</button>" +
        "</div></div>";
    }
    var det = nRec + (nRec === 1 ? " recomendada" : " recomendadas") + " + " + nEsc + (nEsc === 1 ? " escolhida" : " escolhidas") +
      " · a " + escapeHtml(nomeRef) + " continua ativa em todos.";
    return '<div class="am-reb-resumo-sel">' +
        '<span class="am-reb-contador" data-reb-contador aria-live="polite">' + (n === 1 ? "1 participação selecionada" : n + " participações selecionadas") + "</span>" +
        '<span class="am-reb-resumo-sel__det">' + det + "</span></div>" +
      '<div class="am-reb-rodape__acoes">' +
        '<button type="button" class="vf-btn vf-btn--secondary" id="am-reb-fechar-prev" data-reb-acao="fechar">Cancelar</button>' +
        '<button type="button" class="vf-btn vf-btn--secondary" id="am-reb-copiar-proposta" data-reb-acao="copiar-msg" data-reb-modo="proposta"' +
          (n ? "" : " disabled") + ' title="Copia uma mensagem com os anúncios selecionados para enviar ao cliente pelo WhatsApp">Copiar mensagem</button>' +
        '<button type="button" class="vf-btn vf-btn--primary" id="am-reb-participar" data-reb-acao="participar"' + (n ? "" : " disabled") + ">" +
          (n ? "Participar de " + n : "Participar") + "</button></div>";
  }

  // --- Execução ------------------------------------------------------------------------
  function rebPassoExecucaoHtml() {
    var reb = REB;
    var ex = (reb.job && reb.job.execucao) || {};
    var itens = rebItensExecucao();
    var proc = itens.length ? itens.filter(function (x) { return x.status !== "pendente"; }).length : ex.processados;
    var total = itens.length || ex.total;
    var concluida = !rebProcessando();
    var ok = itens.filter(function (x) { return x.status === "ok"; }).length;
    var falhas = itens.filter(function (x) { return x.status === "falha"; }).length;
    var html = "";
    if (reb.erroExecutar) html += rebBannerHtml("danger", reb.erroExecutar);
    if (concluida) {
      html += rebBannerHtml(falhas ? "warning" : "success",
        ok + (ok === 1 ? " participação confirmada" : " participações confirmadas") + " no Mercado Livre" +
        (falhas ? " · " + falhas + (falhas === 1 ? " falhou" : " falharam") : "") + ". A referência continua ativa.");
    } else {
      html += '<p class="am-reb-intro">Participando das promoções, um anúncio por vez. Cada um é relido no Mercado Livre antes de gravar.</p>' +
        rebProgressoHtml(proc, total, "Progresso da participação");
    }
    html += '<ul class="am-reb-lista am-reb-exec" data-reb-exec>' + itens.map(function (x) {
      var it = rebItemPorId(x.itemId) || { itemId: x.itemId };
      var c = rebCandidata(it, x.promotionId);
      var st = x.status === "ok" ? '<span class="vf-status is-success">Participando</span>'
        : x.status === "falha" ? '<span class="vf-status is-danger">Falhou</span>'
        : '<span class="vf-status is-empty">Na fila</span>';
      var det = x.status === "ok"
        ? (c ? escapeHtml(c.nome || c.promotionId) : "") + (rebNum(x.precoConfirmado) !== null ? " · " + formatMoeda(x.precoConfirmado) : "")
        : x.status === "falha" ? escapeHtml(x.motivo || REB_MOTIVOS[x.codigo] || "Não foi possível participar.")
        : (c ? escapeHtml(c.nome || c.promotionId) : "");
      return '<li class="am-reb-lista__item am-reb-exec__item is-' + escapeAttr(x.status || "pendente") + '" data-reb-exec-item="' + escapeAttr(x.itemId) + '">' +
        rebAnuncioHtml(it) + '<span class="am-reb-exec__st">' + st + "</span>" +
        (det ? '<span class="am-reb-lista__motivo">' + det + "</span>" : "") + "</li>";
    }).join("") + "</ul>";
    return html;
  }

  function rebRodapeExecucaoHtml() {
    var reb = REB;
    if (rebProcessando()) {
      return '<div class="am-reb-resumo-sel"><span class="am-reb-contador">Gravando no Mercado Livre…</span></div>' +
        '<div class="am-reb-rodape__acoes"><button type="button" class="vf-btn vf-btn--secondary" id="am-reb-fechar-exec" data-reb-acao="fechar">Fechar</button></div>';
    }
    var nFalhas = rebFalhas().length;
    var nOk = rebRegistrarConfirmadas().length;
    return '<div class="am-reb-rodape__acoes">' +
      (nFalhas ? '<button type="button" class="vf-btn vf-btn--secondary" id="am-reb-retentar" data-reb-acao="retentar"' + (reb.enviando ? " disabled" : "") + ">" +
        (reb.enviando ? "Enviando…" : "Tentar de novo as falhas (" + nFalhas + ")") + "</button>" : "") +
      (nOk ? '<button type="button" class="vf-btn vf-btn--secondary" id="am-reb-copiar-feito" data-reb-acao="copiar-msg" data-reb-modo="feito"' +
        ' title="Copia uma mensagem com o que entrou em promoção para enviar ao cliente pelo WhatsApp">Copiar mensagem para o cliente</button>' : "") +
      '<button type="button" class="vf-btn vf-btn--primary" id="am-reb-fechar-final" data-reb-acao="fechar">Fechar</button></div>';
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
  function icPlanilha(t) { return svgIcone('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h8M10 9H8"/>', t || 12, 1.8); }
  function icLapis(t) { return svgIcone('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>', t || 12, 1.8); }
  function icExterno(t) { return svgIcone('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>', t || 12); }
  function icAtualizar(t) { return svgIcone('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>', t || 13); }
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
      // Custo do produto / Custos adicionais / Preço — a coluna "Simulação"
      // da composição (ver margemComposicaoLadderHtml): overrides nunca
      // persistidos, nunca enviados ao Mercado Livre. `resultado`/`entradas`
      // são a última resposta de POST .../simular-margem; null enquanto
      // nenhum dos três campos estiver com override ativo (a composição usa
      // a margem REAL).
      simulacaoMargem: novaSimulacaoMargem(),
      // Qual promoção (chave id::tipo, ver promocaoChave) está escolhida na
      // lista "Promoções disponíveis" e alimentando a simulação acima, ou null.
      // Decide o cenário e a ação oferecida — nunca o valor da margem em
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
      DET.familia = r.data.familia || null;
      DET.modoFamilia = editaNomeDaFamilia(a, DET.familia);
      DET.original = {
        titulo: DET.modoFamilia ? (DET.familia.family_name || "") : (a.titulo || ""),
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
    bindComposicaoMargem(el("am-det-margem"), a.item_id);
    bindPromocoes(el("am-det-promo"), a.item_id);
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
    var tituloTravado = tituloTravadoNoDetalhe();

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
              'aria-label="' + (DET.modoFamilia ? "Nome do produto (família)" : "Título do anúncio") +
              '" value="' + escapeAttr(DET.rascunho.titulo) + '" />' +
            '<button type="button" class="am-det-revert" data-acao="reverter" data-campo="titulo" ' +
              'id="am-det-revert-titulo" title="Descartar alteração no título" ' +
              'aria-label="Descartar alteração no título">' + icDesfazer() + "</button>" +
          "</div>" +
          '<div class="am-det-title__meta">' +
            '<span class="am-det-dirty" id="am-det-dirty-titulo"><span class="am-det-dot"></span>Alteração não salva</span>' +
            '<span class="am-det-title__count" id="am-det-count-titulo"></span>' +
            (tituloTravado
              ? '<span class="am-det-title__locknote">Gerenciado pelo Mercado Livre</span>'
              : DET.modoFamilia
              ? nomeFamiliaNotaHtml(a)
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
        botaoAtualizarHtml() +
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
    // Na família o campo editado é o nome do produto; o critério mede o
    // título que o ML publica (nome + variação).
    var titulo = String((DET.modoFamilia ? a.titulo : DET.rascunho.titulo) || "").trim();
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
    var tituloTravado = tituloTravadoNoDetalhe();
    return '<div class="am-det-section">' +
      '<div class="am-det-subhead">' +
        "<h4>Título</h4>" +
        '<span id="am-det-status-seo">' + chipTitulos() + "</span>" +
      "</div>" +
      '<div class="am-det-compare am-det-compare--compacto" id="am-det-compare-titulo">' +
        '<div class="am-det-compare__col">' +
          '<div class="am-det-compare__label"><span>' +
            (tituloTravado ? "Atual · gerenciado pelo Mercado Livre"
              : DET.modoFamilia ? "Nome do produto · vale para todas as variações"
              : "Atual · editável aqui ou no cabeçalho") +
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
    if (DET.modoFamilia) {
      return cabeca + '<p class="am-det-vazio">Este anúncio faz parte de uma família: o título é o nome do produto mais a variação, e as sugestões da IA ainda não cobrem o nome do produto.</p>';
    }
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
    if (DET.modoFamilia) return '<span class="vf-status is-empty">Nome do produto da família</span>';
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
    return !!(S && (S.estado === "ok" || S.estado === "aviso") && S.texto && DET.rascunho.descricao === S.texto);
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

    if ((S.estado === "ok" || S.estado === "aviso") && S.texto) {
      var advertencia = "";
      if (S.estado === "aviso") {
        var motivosRevisao = (S.problemas || []).map(function (p) {
          var t = typeof p === "string" ? p : (p && p.detalhe ? String(p.detalhe) : "");
          if (t && p && Array.isArray(p.termos) && p.termos.length) t += " (" + p.termos.slice(0, 3).join(", ") + ")";
          return t;
        }).filter(function (t, i, todos) { return t && todos.indexOf(t) === i; });
        advertencia = '<p class="am-det-vazio" role="status"><b>A descrição foi gerada, mas contém pontos que precisam de revisão.</b> Nada foi aplicado automaticamente.</p>' +
          (S.autorreparo && S.autorreparo.etapa === "falha"
            ? '<p class="am-det-vazio">O reparo automático foi tentado, mas não resolveu os pontos de revisão. ' + escapeHtml(S.erro || "") + "</p>" : "") +
          (motivosRevisao.length ? listaIaHtml([], motivosRevisao) : '<p class="am-det-vazio">' + escapeHtml(S.erro || "Revise o texto antes de usar.") + "</p>");
      }
      var base = (S.fatosUsados || []).map(function (f) { return f && f.label; }).filter(Boolean);
      return cabeca + advertencia +
        '<p class="am-det-readtext am-det-readtext--sug am-det-readtext--bloco">' + escapeHtml(S.texto) + "</p>" +
        '<p class="am-det-compare__hint">' + escapeHtml(String(S.chars)) + (S.limite ? "/" + escapeHtml(String(S.limite)) : "") + " caracteres" +
          (base.length ? " · com base em: " + escapeHtml(base.join(", ")) : "") + "</p>" +
        avisosDescricaoHtml(S.estado === "aviso" ? { avisos: S.avisos } : S) + acoesIaHtml([
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
    S.texto = "";
    S.chars = 0;
    S.limite = 0;
    S.fatosUsados = [];
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
      var textoDisponivel = typeof d.descricao === "string" && d.descricao.trim().length > 0;
      var advisory = !d.ok && d.codigo === "DESCRICAO_INVALIDA";
      if (r.status < 200 || r.status >= 300 || (!d.ok && !advisory) || !textoDisponivel) {
        S.estado = "erro";
        S.erro = d.motivo || "Não foi possível gerar a descrição.";
        S.codigo = d.codigo || null;
        S.problemas = Array.isArray(d.problemas) ? d.problemas : [];
        S.texto = "";
        repintarDescricao();
        toast(S.erro, "is-danger");
        return;
      }
      S.estado = advisory ? "aviso" : "ok";
      S.erro = advisory ? (d.motivo || "Revise o texto antes de usar.") : null;
      S.codigo = advisory ? d.codigo : null;
      S.problemas = advisory && Array.isArray(d.problemas) ? d.problemas : [];
      S.texto = d.descricao;
      S.chars = d.chars || d.descricao.length;
      S.limite = d.limite || 0;
      S.fatosUsados = Array.isArray(d.fatosUsados) ? d.fatosUsados : [];
      repintarDescricao();
    });
  }

  function usarDescricao() {
    var S = DET && DET.descricaoSeo;
    if (!S || (S.estado !== "ok" && S.estado !== "aviso") || !S.texto || DET.descricaoEstado === "erro") return;
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

  // ===========================================================================
  // Composição da margem — HOJE × SIMULAÇÃO. Uma tabela de três colunas: o
  // número real do Motor ("Hoje") ao lado da simulação. Preço de venda, Custo
  // do produto e Custos adicionais são campos de verdade na coluna
  // "Simulação" — mudar um deles (Enter ou sair do campo) chama POST
  // .../simular-margem e nada mais. Clicar numa promoção ao lado (ver
  // selecionarPromocao) preenche a coluna com o cenário dela. Escrita real só
  // pela ação única de #am-det-margem-acoes + diálogo de confirmação.
  // ===========================================================================

  function novaSimulacaoMargem() {
    return { custoProduto: null, custosAdicionais: null, preco: null, resultado: null, entradas: null };
  }

  function promocaoSelecionadaDoItem(itemId) {
    if (!DET || DET.itemId !== itemId || DET.promoLinhaSelecionada == null) return null;
    return promocaoPorChave(itemId, DET.promoLinhaSelecionada);
  }

  function simulacaoTemOverride(sim) {
    return !!(sim && (sim.custoProduto != null || sim.custosAdicionais != null || sim.preco != null));
  }

  // "Mudou alguma coisa": uma promoção escolhida OU um valor digitado.
  function simulacaoAtiva(itemId) {
    if (!DET || DET.itemId !== itemId) return false;
    return DET.promoLinhaSelecionada != null || simulacaoTemOverride(DET.simulacaoMargem);
  }

  // started/active/pending — o vendedor já está inscrito (pending = programada).
  function promocaoParticipa(p) {
    return p.status === "started" || p.status === "active" || p.status === "pending";
  }

  // Preço na coluna Simulação: campo editável, ou travado com o motivo.
  //  · promoção ACEITE escolhida — o preço é do Mercado Livre;
  //  · nenhuma promoção escolhida e o anúncio está numa promoção ativa — o
  //    preço vem dela (mesma regra de antes: sem simulação de preço solta).
  function precoSimulacaoEstado(itemId, comp) {
    var sel = promocaoSelecionadaDoItem(itemId);
    if (sel && sel.modoEscrita === "ACEITE") {
      return { editavel: false, motivo: "Nesta promoção o preço é definido pelo Mercado Livre — você só escolhe participar ou não." };
    }
    if (!sel && comp.precoPromocionalAtivo) {
      return {
        editavel: false,
        motivo: "O anúncio está numa promoção ativa e o preço vem dela. Escolha uma promoção ao lado para simular outro cenário.",
      };
    }
    return { editavel: true, motivo: null };
  }

  function margemSimInputHtml(campo, valor, itemId, rotulo) {
    var v = valor == null || !isFinite(Number(valor)) ? "" : Number(valor).toFixed(2);
    return '<span class="am-margem-sim__campo">' +
      '<span class="am-margem-sim__moeda" aria-hidden="true">R$</span>' +
      '<input type="number" step="0.01" min="0" inputmode="decimal" class="am-margem-sim__input" ' +
        'data-margem-item="' + escapeAttr(itemId) + '" data-margem-campo="' + escapeAttr(campo) + '" ' +
        'value="' + escapeAttr(v) + '" placeholder="0,00" ' +
        'aria-label="' + escapeAttr(rotulo + " (simulação — Enter para calcular)") + '" />' +
    "</span>";
  }

  function margemSimValorHtml(valor, hoje, moeda) {
    var alterado = valor != null && hoje != null && Math.abs(Number(valor) - Number(hoje)) > 0.004;
    return '<span class="am-margem-sim__valor' + (alterado ? " is-alterado" : "") + '">' + formatMoeda(valor, moeda) + "</span>";
  }

  function margemSimPctHtml(pct) {
    return pct == null ? "" : '<span class="am-margem-sim__pct">' + escapeHtml(formatarPercentualCompacto(pct)) + "</span>";
  }

  function margemSimLinhaHtml(rotuloHtml, hojeHtml, simHtml, classe) {
    return '<div class="am-margem-sim__linha' + (classe ? " " + classe : "") + '">' +
      '<span class="am-margem-sim__rotulo">' + rotuloHtml + "</span>" +
      '<span class="am-margem-sim__hoje">' + hojeHtml + "</span>" +
      '<span class="am-margem-sim__sim">' + simHtml + "</span>" +
    "</div>";
  }

  // Selo "+R$ 2,44" / "−R$ 13,69" / "= hoje" — mesma régua na composição
  // (diferença da simulação) e na coluna "vs. hoje" das promoções.
  function margemDeltaHtml(d, moeda, dpp) {
    if (d == null || !isFinite(d)) return '<span class="am-delta is-vazio">—</span>';
    if (Math.abs(d) < 0.005) return '<span class="am-delta is-igual">= hoje</span>';
    var txt = (d > 0 ? "+" : "−") + formatMoeda(Math.abs(d), moeda);
    if (dpp != null && isFinite(dpp)) {
      txt += " · " + (dpp >= 0 ? "+" : "−") + Math.abs(dpp).toFixed(1).replace(".", ",") + " p.p.";
    }
    return '<span class="am-delta ' + (d > 0 ? "is-pos" : "is-neg") + '">' + escapeHtml(txt) + "</span>";
  }

  function margemComposicaoLadderHtml(comp, cacheMargem, moeda, itemId) {
    var sim = (DET && DET.itemId === itemId) ? DET.simulacaoMargem : null;
    var ativa = simulacaoAtiva(itemId);
    var calculada = !!(ativa && simulacaoTemOverride(sim) && sim.resultado);
    // Entradas que o Motor efetivamente usou (POST .../simular-margem devolve
    // `entradas`) — nunca recalculadas aqui. Sem simulação calculada, a
    // coluna repete o número de hoje.
    var ent = calculada && sim.entradas ? sim.entradas : null;

    var precoHoje = comp.venda;
    var precoSim = sim && sim.preco != null ? sim.preco : precoHoje;
    var custoSim = sim && sim.custoProduto != null ? sim.custoProduto : comp.custoProduto;
    var adicSim = sim && sim.custosAdicionais != null ? sim.custosAdicionais : comp.taxaFixa;

    var estPreco = precoSimulacaoEstado(itemId, comp);
    var precoSimHtml = estPreco.editavel
      ? margemSimInputHtml("preco", precoSim, itemId, "Preço de venda")
      : '<span class="am-margem-sim__valor am-margem-comp__valor--bloqueado' +
          (precoSim != null && precoHoje != null && Math.abs(precoSim - precoHoje) > 0.004 ? " is-alterado" : "") +
          '" title="' + escapeAttr(estPreco.motivo) + '">' + formatMoeda(precoSim, moeda) + "</span>";

    var linhas =
      margemSimLinhaHtml(
        "Preço de venda" + (estPreco.editavel ? "" : infoDotHtml(estPreco.motivo, "Por que o preço está travado")),
        formatMoeda(precoHoje, moeda), precoSimHtml, "am-margem-sim__linha--campo") +
      margemSimLinhaHtml(
        "Custo do produto" + infoDotHtml("Simulação — não altera a Base de Custos.", "Sobre o custo do produto"),
        formatMoeda(comp.custoProduto, moeda),
        margemSimInputHtml("custoProduto", custoSim, itemId, "Custo do produto"), "am-margem-sim__linha--campo");

    // Com preço simulado o servidor COTA comissão e frete no preço simulado
    // (P0 12/11/2026): a coluna mostra o que veio em `entradas` — inclusive
    // "—" quando a cotação falhou —, nunca o valor de hoje como se valesse no
    // preço novo.
    if (comp.comissaoMl != null) {
      linhas += margemSimLinhaHtml("Comissão Mercado Livre", formatMoeda(comp.comissaoMl, moeda),
        margemSimValorHtml(ent ? ent.commission : comp.comissaoMl, comp.comissaoMl, moeda));
    }
    if (comp.frete != null) {
      linhas += margemSimLinhaHtml("Frete", formatMoeda(comp.frete, moeda),
        margemSimValorHtml(ent ? ent.freight : comp.frete, comp.frete, moeda));
    }
    linhas += margemSimLinhaHtml(
      "Custos adicionais" + infoDotHtml("Embalagem, operação ou outro custo extra — simulação, não é cobrado pelo Mercado Livre.", "Sobre custos adicionais"),
      formatMoeda(comp.taxaFixa, moeda),
      margemSimInputHtml("custosAdicionais", adicSim, itemId, "Custos adicionais"), "am-margem-sim__linha--campo");

    // "Taxa de rebate": retorno ML da promoção — SOMADO ao lucro, nunca um
    // custo. Aparece quando hoje há rebate (promoção ATIVA com subsidioMl) ou
    // quando a simulação traz um (promoção escolhida com subsídio).
    var rebateHoje = comp.rebate != null ? comp.rebate : 0;
    var rebateSim = ent ? (ent.rebate || 0) : rebateHoje;
    if (comp.rebate != null || rebateSim > 0) {
      linhas += margemSimLinhaHtml(
        "Taxa de rebate" + infoDotHtml("Retorno ML da promoção — somado ao lucro, não é um custo.", "Sobre a taxa de rebate"),
        formatMoeda(rebateHoje, moeda), margemSimValorHtml(rebateSim, rebateHoje, moeda));
    }

    if (comp.impostoValor != null) {
      var rotuloImposto = "Imposto" +
        (comp.impostoPercentual != null ? " (" + formatarPercentualCompacto(comp.impostoPercentual * 100) + ")" : "");
      var impostoSim = ent && ent.taxRate != null && ent.price != null ? ent.price * ent.taxRate : comp.impostoValor;
      linhas += margemSimLinhaHtml(
        rotuloImposto + infoDotHtml("Guardado como percentual pelo Motor de Margem — o valor em R$ é só para exibição.", "Sobre o imposto"),
        formatMoeda(comp.impostoValor, moeda), margemSimValorHtml(impostoSim, comp.impostoValor, moeda));
    }

    // "Margem": o valor REAL do Motor em "Hoje" — nunca a soma das linhas.
    // Em "Simulação", sempre o que veio de POST .../simular-margem.
    var temHoje = cacheMargem && cacheMargem.profit != null;
    var hojeTotal = temHoje ? formatMoeda(cacheMargem.profit, moeda) + margemSimPctHtml(cacheMargem.marginPercent) : "—";
    var simTotal = hojeTotal;
    if (ativa && simulacaoTemOverride(sim)) {
      if (!sim.resultado) simTotal = '<span class="am-margem-sim__calculando">Calculando…</span>';
      else if (!sim.resultado.computable) simTotal = '<span class="am-margem-sim__calculando">Sem dados suficientes</span>';
      else simTotal = formatMoeda(sim.resultado.profit, moeda) + margemSimPctHtml(sim.resultado.marginPercent);
    }
    linhas += margemSimLinhaHtml("Margem", hojeTotal, simTotal, "am-margem-sim__linha--total");

    var difHtml = "";
    if (calculada && sim.resultado.computable && temHoje) {
      var dpp = sim.resultado.marginPercent != null && cacheMargem.marginPercent != null
        ? sim.resultado.marginPercent - cacheMargem.marginPercent : null;
      difHtml = '<div class="am-margem-sim__dif"><span>Diferença por venda</span>' +
        margemDeltaHtml(sim.resultado.profit - cacheMargem.profit, moeda, dpp) + "</div>";
    }

    var cab = '<div class="am-margem-sim__linha am-margem-sim__cab" aria-hidden="true">' +
      "<span></span><span>Hoje</span><span>Simulação</span></div>";
    return '<div class="am-margem-comp__ladder am-margem-sim' + (ativa ? " is-simulando" : "") + '">' +
      cab + linhas + difHtml + "</div>";
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
    if (!cache.composicao) {
      var motivo = cache.margemIndisponivel && cache.margemIndisponivel.mensagem;
      if (!motivo && cache.margem) {
        motivo = cache.margem.margemIncompletaMotivo || (cache.margem.statusReasons && cache.margem.statusReasons[0]);
      }
      return badge + '<p class="am-margem-comp__dica">' +
        escapeHtml(motivo || "Não há dados suficientes para carregar a composição da margem.") + "</p>";
    }

    if (cache.composicao.incompleta) {
      var comp = cache.composicao;
      var linhas = [
        ["Preço de venda", comp.venda],
        ["Custo do produto", comp.custoProduto],
        ["Comissão Mercado Livre", comp.comissaoMl],
        ["Frete", comp.frete, comp.freteAplicavel === false ? "Não se aplica" : "Indisponível"],
        ["Custos adicionais", comp.taxaFixa],
        ["Imposto", comp.impostoValor],
      ].map(function (linha) {
        var valor = linha[1] == null ? (linha[2] || "Indisponível") : formatMoeda(linha[1], moeda);
        return '<tr><th scope="row">' + escapeHtml(linha[0]) + '</th><td>' + escapeHtml(valor) + '</td></tr>';
      }).join("");
      var aviso = cache.margem && cache.margem.margemIncompletaMotivo;
      return badge + '<table class="am-margem-comp__parcial"><caption>Custos disponíveis</caption><tbody>' +
        linhas + '</tbody></table><p class="am-margem-comp__dica">' +
        escapeHtml(aviso || "A margem depende dos custos indisponíveis.") + '</p>';
    }
    return badge + margemComposicaoLadderHtml(cache.composicao, cache.margem, moeda, itemId);
  }

  // À direita do título: com uma promoção escolhida, o selo "Simulando:
  // <promoção>" (com ✕ para descartar); senão o resumo compacto da margem,
  // que só aparece quando a composição já chegou.
  function margemComposicaoResumoHtml(itemId) {
    var sel = promocaoSelecionadaDoItem(itemId);
    if (sel) {
      return '<span class="am-margem-sim__chip">' +
        '<span class="am-margem-sim__chip-nome">Simulando: ' + escapeHtml(sel.nome || sel.tipoLabel) + "</span>" +
        '<button type="button" class="am-margem-sim__chip-x" data-acao="restaurar-simulacao-margem" ' +
          'aria-label="Descartar a simulação" title="Descartar a simulação">×</button>' +
      "</span>";
    }
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
      '<div class="am-margem-acoes" id="am-det-margem-acoes">' + margemAcoesHtml(itemId) + "</div>" +
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
        repintarPromocoesDoItem(itemId); // "vs. hoje" depende da margem que acabou de chegar
      });
    });
  }

  function repintarComposicaoDoItem(itemId) {
    if (!DET || DET.itemId !== itemId || !DET.anuncio) return;
    var corpo = el("am-det-margem-body");
    if (corpo) {
      // O repaint troca os campos da coluna Simulação: devolve o foco ao
      // mesmo campo (ex.: Tab de Preço para Custo dispara a simulação do
      // Preço, e o operador continua no Custo) e, se ele estava no meio da
      // digitação quando a resposta de uma simulação anterior chegou, o que
      // já foi digitado não se perde.
      var ativo = document.activeElement;
      var focado = ativo && corpo.contains(ativo) && ativo.classList.contains("am-margem-sim__input") ? ativo : null;
      var campoFocado = focado ? focado.getAttribute("data-margem-campo") : null;
      var digitando = focado && focado.value !== focado.defaultValue ? focado.value : null;
      DET.repintandoComposicao = true;
      try {
        corpo.innerHTML = margemComposicaoConteudoHtml(itemId, DET.anuncio.moeda);
      } finally {
        DET.repintandoComposicao = false;
      }
      if (campoFocado) {
        var novo = corpo.querySelector('.am-margem-sim__input[data-margem-campo="' + campoFocado + '"]');
        if (novo) {
          if (digitando != null && Number(digitando) !== Number(novo.defaultValue)) novo.value = digitando;
          novo.focus();
        }
      }
    }
    var resumo = el("am-det-margem-resumo");
    if (resumo) resumo.innerHTML = margemComposicaoResumoHtml(itemId);
    var acoes = el("am-det-margem-acoes");
    if (acoes) acoes.innerHTML = margemAcoesHtml(itemId);
    // O preço do CABEÇALHO usa a mesma fonte que acabou de chegar — sem isso
    // ele ficaria preso ao snapshot (a.preco/a.preco_original) mesmo depois
    // da composição já mostrar o valor ao vivo do Motor logo abaixo.
    var precoWrap = el("am-det-price");
    if (precoWrap) precoWrap.outerHTML = precoDetalheHtml(DET.anuncio);
  }

  // ===========================================================================
  // Composição da margem — SIMULAÇÃO e AÇÃO. Tudo nasce como simulação local
  // (POST .../simular-margem). A escrita real só acontece pelo botão único de
  // #am-det-margem-acoes, cujo rótulo diz exatamente o que vai acontecer
  // ("Participar por R$ X", "Deixar de participar", "Aplicar R$ X no
  // anúncio"…), e sempre passa pelo diálogo de confirmação
  // (abrirConfirmacaoEscrita).
  // ===========================================================================

  // Item legado com variations[] reais no ML (variations_count > 0): o PUT de
  // preço seria recusado (PRECO_ITEM_COM_VARIACAO, ver meliPrecoService) —
  // o preço vira só simulação. Promoção ativa tem prioridade (o preço já
  // vem travado por ela, ver precoSimulacaoEstado).
  function precoBloqueadoPorVariacoesLegado(comp) {
    if (comp.precoPromocionalAtivo) return false;
    return !!(DET && DET.anuncio && (DET.anuncio.variations_count || 0) > 0);
  }

  // Delegação: um listener por seção, ligado em renderDetalhe — os repaints
  // trocam só o miolo e nunca precisam religar nada.
  function bindComposicaoMargem(secao, itemId) {
    if (!secao) return;
    // Sair do campo (Tab, clique fora) com um valor diferente do exibido
    // calcula. Ignorado durante um repaint (o campo antigo some do DOM).
    secao.addEventListener("focusout", function (e) {
      var input = e.target.closest(".am-margem-sim__input");
      if (!input || (DET && DET.repintandoComposicao)) return;
      if (input.value === input.defaultValue) return;
      confirmarSimulacaoMargem(itemId, input.getAttribute("data-margem-campo"), input.value);
    });
    secao.addEventListener("keydown", function (e) {
      var input = e.target.closest(".am-margem-sim__input");
      if (!input) return;
      // Enter calcula (o foco continua no campo); Esc desfaz o que foi
      // digitado sem calcular — e nunca fecha o modal por baixo.
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        confirmarSimulacaoMargem(itemId, input.getAttribute("data-margem-campo"), input.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        input.value = input.defaultValue;
        input.blur();
      }
    });
    secao.addEventListener("click", function (e) {
      var alvo = e.target.closest("[data-acao]");
      if (!alvo || !secao.contains(alvo) || alvo.disabled) return;
      var acao = alvo.getAttribute("data-acao");
      if (acao === "restaurar-simulacao-margem") {
        e.stopPropagation();
        descartarSimulacaoMargem(itemId);
      } else if (acao === "aplicar-preco") {
        e.stopPropagation();
        abrirConfirmacaoAplicarPreco(itemId);
      } else if (acao === "promo-aplicar") {
        e.stopPropagation();
        abrirConfirmacaoPromocao(itemId, promocaoSelecionadaDoItem(itemId));
      } else if (acao === "promo-participar" || acao === "promo-sair") {
        e.stopPropagation();
        abrirConfirmacaoAceite(itemId, promocaoSelecionadaDoItem(itemId), acao === "promo-sair");
      }
    });
  }

  // Valor digitado num campo da coluna Simulação. Vazio, ou igual ao número
  // real (sem promoção escolhida), desliga o override daquele campo.
  function confirmarSimulacaoMargem(itemId, campo, bruto) {
    if (!DET || DET.itemId !== itemId) return;
    var cache = AM.state.performanceCache[itemId];
    var comp = cache && cache.composicao;
    var real = !comp ? null
      : campo === "preco" ? comp.venda
      : campo === "custoProduto" ? comp.custoProduto
      : comp.taxaFixa;
    var texto = String(bruto == null ? "" : bruto).trim();

    if (texto === "") {
      DET.simulacaoMargem[campo] = null;
    } else {
      var n = Number(texto);
      if (!isFinite(n) || n < 0 || (campo === "preco" && n <= 0)) {
        toast(campo === "preco" ? "Informe um preço maior que zero." : "Informe um número maior ou igual a zero.", "is-danger");
        repintarComposicaoDoItem(itemId);
        return;
      }
      n = Math.round((n + Number.EPSILON) * 100) / 100;
      var voltouAoReal = real != null && Math.abs(n - real) < 0.005 &&
        !(campo === "preco" && DET.promoLinhaSelecionada != null);
      DET.simulacaoMargem[campo] = voltouAoReal ? null : n;
    }
    dispararSimulacaoMargem(itemId);
  }

  function descartarSimulacaoMargem(itemId) {
    if (!DET || DET.itemId !== itemId) return;
    DET.simulacaoMargem = novaSimulacaoMargem();
    DET.promoLinhaSelecionada = null;
    DET.simulacaoSeq = (DET.simulacaoSeq || 0) + 1; // resposta em voo vira lixo
    repintarComposicaoDoItem(itemId);
    repintarPromocoesDoItem(itemId);
  }

  function dispararSimulacaoMargem(itemId) {
    if (!DET || DET.itemId !== itemId) return;
    var sim = DET.simulacaoMargem;
    sim.resultado = null;
    sim.entradas = null;
    var seq = DET.simulacaoSeq = (DET.simulacaoSeq || 0) + 1;
    repintarComposicaoDoItem(itemId);
    repintarPromocoesDoItem(itemId);
    // Só promoção escolhida, sem nenhum valor a mudar (ex.: promoção sem
    // preço sugerido): a coluna Simulação repete hoje — nenhuma chamada.
    if (!simulacaoTemOverride(sim)) return;

    var cache = AM.state.performanceCache[itemId];
    var origem = cache && cache.margem ? cache.margem.origem : "projected";
    var corpo = { clienteSlug: AM.clienteAtual.slug, origem: origem };
    if (AM.contaMlId) corpo.clienteContaId = AM.contaMlId;
    if (sim.custoProduto != null) corpo.custoProduto = sim.custoProduto;
    if (sim.custosAdicionais != null) corpo.custosAdicionais = sim.custosAdicionais;
    if (sim.preco != null) corpo.preco = sim.preco;

    // Retorno ML (rebate) — mesmo campo `rebate` do Motor, nunca uma conta à
    // parte. promocaoPorChave (id+tipo) — nunca só o id.
    //  · promoção escolhida (qualquer uma, inclusive uma em que o anúncio já
    //    participa): o subsidioMl DELA — a simulação é sempre "o anúncio
    //    nesta promoção", a mesma conta do "Você recebe" da linha;
    //  · nenhuma escolhida: o da promoção ATIVA, que continua valendo —
    //    senão simular só o custo perderia o rebate que a margem de hoje já
    //    tem.
    var sel = promocaoSelecionadaDoItem(itemId);
    var subsidio = null;
    if (sel) {
      subsidio = sel.subsidioMl;
    } else {
      var ativa = promocaoAtivaComSubsidioDoItem(itemId);
      if (ativa) subsidio = ativa.subsidioMl;
    }
    if (subsidio != null) corpo.subsidioMl = subsidio;

    var meuToken = DET.token;
    api("/anuncios-meli/" + encodeURIComponent(itemId) + "/simular-margem", { method: "POST", body: corpo })
      .then(function (r) {
        // Modal fechado, outro MLB, ou uma simulação mais nova já saiu.
        if (!DET || DET.token !== meuToken || DET.simulacaoSeq !== seq) return;
        var d = r.data || {};
        if (!d.ok) {
          toast(d.motivo || "Não foi possível simular a margem.", "is-danger");
          DET.simulacaoMargem.resultado = { computable: false };
        } else {
          DET.simulacaoMargem.resultado = d.resultado;
          DET.simulacaoMargem.entradas = d.entradas || null;
        }
        repintarComposicaoDoItem(itemId);
        repintarPromocoesDoItem(itemId);
      });
  }

  // O que dá para FAZER com a simulação atual — uma explicação curta e os
  // botões que fazem sentido (no máximo dois: alterar e deixar de
  // participar), sempre no mesmo lugar, nunca um botão por linha.
  var BOTAO_SAIR = { acao: "promo-sair", rotulo: "Deixar de participar", classe: "vf-btn--secondary am-margem-acoes__btn--sair" };

  function margemAcaoAtual(itemId) {
    var sim = DET.simulacaoMargem;
    var moeda = DET.anuncio.moeda;
    var sel = promocaoSelecionadaDoItem(itemId);
    var cache = AM.state.performanceCache[itemId];
    var comp = cache && cache.composicao;

    if (sel) {
      var ativa = sel.statusExibicao === "ATIVA";
      // Já participa: sempre "Deixar de participar"; "Alterar" só quando o
      // preço é do vendedor (PRECO) — nas ACEITE o Mercado Livre define.
      if (promocaoParticipa(sel) && (sel.modoEscrita === "ACEITE" || sel.modoEscrita === "PRECO")) {
        var naoForma = ativa ? null
          : "Esta promoção não está formando o preço agora — a simulação mostra a margem se ela passar a valer.";
        if (sel.modoEscrita === "ACEITE") {
          return {
            nota: "O preço é definido pelo Mercado Livre — você só escolhe continuar ou deixar de participar." +
              (ativa ? " Saindo, o anúncio volta ao preço cheio e deixa de receber o subsídio." : " " + naoForma),
            tom: "texto",
            botoes: [BOTAO_SAIR],
          };
        }
        if (ativa && sel.subsidioMl != null) {
          return {
            nota: "Esta promoção tem participação do Mercado Livre (rebate) — a alteração de valores ainda não está disponível para ela.",
            tom: "warning",
            botoes: [BOTAO_SAIR],
          };
        }
        var alterar = sim.preco == null || (sel.precoFinal != null && Math.abs(sim.preco - sel.precoFinal) < 0.005)
          ? { rotulo: "Mude o preço para alterar a promoção", classe: "vf-btn--primary", desabilitado: true }
          : { acao: "promo-aplicar", rotulo: "Alterar preço da promoção para " + formatMoeda(sim.preco, moeda), classe: "vf-btn--primary" };
        return { nota: naoForma, tom: "texto", botoes: [alterar, BOTAO_SAIR] };
      }
      if (sel.modoEscrita === "ACEITE") {
        if (sel.status === "candidate") {
          return {
            nota: "O preço é definido pelo Mercado Livre — você só escolhe participar ou não.",
            tom: "texto",
            botoes: [{ acao: "promo-participar", rotulo: "Participar da promoção", classe: "vf-btn--primary" }],
          };
        }
        return { nota: "Esta promoção não aceita inscrição agora.", tom: "info" };
      }
      if (sel.modoEscrita === "PRECO") {
        if (sel.status === "candidate") {
          return {
            botoes: [sim.preco != null
              ? { acao: "promo-aplicar", rotulo: "Participar por " + formatMoeda(sim.preco, moeda), classe: "vf-btn--primary" }
              : { rotulo: "Informe um preço para participar", classe: "vf-btn--primary", desabilitado: true }],
          };
        }
        return { nota: "Esta promoção não aceita inscrição agora.", tom: "info" };
      }
      return {
        nota: "Este tipo de promoção é ativado no painel do Mercado Livre. A simulação serve para você decidir antes.",
        tom: "info",
      };
    }

    if (sim.preco != null && comp) {
      if (!comp.precoPromocionalAtivo && !precoBloqueadoPorVariacoesLegado(comp)) {
        return { botoes: [{ acao: "aplicar-preco", rotulo: "Aplicar " + formatMoeda(sim.preco, moeda) + " no anúncio", classe: "vf-btn--primary" }] };
      }
      return { nota: "Simulação apenas — este anúncio tem variações e o preço é alterado no nível do anúncio.", tom: "info" };
    }
    return { nota: "Custo simulado — não altera a Base de Custos.", tom: "texto" };
  }

  function margemAcoesHtml(itemId) {
    if (!DET || DET.itemId !== itemId || !DET.anuncio) return "";
    if (!simulacaoAtiva(itemId)) {
      return '<p class="am-margem-acoes__dica">Clique numa promoção ao lado ou mude um valor da coluna Simulação. ' +
        "Nada vai para o Mercado Livre sem você confirmar.</p>";
    }
    var a = margemAcaoAtual(itemId);
    var botoes = a.botoes || [];
    var html = "";
    if (a.nota) html += '<p class="am-margem-acoes__nota is-' + a.tom + '">' + escapeHtml(a.nota) + "</p>";
    botoes.forEach(function (b) {
      html += '<button type="button" class="vf-btn ' + b.classe + ' am-margem-acoes__principal"' +
        (b.acao ? ' data-acao="' + b.acao + '"' : "") + (b.desabilitado ? " disabled" : "") + ">" +
        escapeHtml(b.rotulo) + "</button>";
    });
    html += '<button type="button" class="vf-btn vf-btn--ghost am-margem-acoes__descartar" data-acao="restaurar-simulacao-margem">' +
      "Descartar simulação</button>";
    if (botoes.some(function (b) { return !b.desabilitado; })) {
      html += '<p class="am-margem-acoes__rodape">Você revisa e confirma antes de enviar ao Mercado Livre.</p>';
    }
    return html;
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
        DET.simulacaoMargem = novaSimulacaoMargem();
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
  // Cada linha é um controle de ESCOLHA: clicar seleciona a promoção
  // (`DET.promoLinhaSelecionada`) e preenche a coluna Simulação da
  // composição com o cenário dela (mesmo override DET.simulacaoMargem.preco
  // e mesmo POST .../simular-margem) — nunca grava nada no Mercado Livre.
  // A ação real (participar/alterar/deixar de participar) fica num botão
  // único em #am-det-margem-acoes. Enquanto nenhuma linha está escolhida,
  // cada uma já chega com "Você recebe"
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

  // "Preço final": mostra o override de simulação quando ESTA linha é a
  // selecionada; senão o valor que o próprio ML devolveu (real quando
  // ativa/agendada, sugerido quando candidata — pode ser null, nunca
  // inventado, ver meliPromocoesService). Linha ACEITE nunca troca: o preço
  // é do ML.
  function precoFinalExibidoDaLinha(p, itemId) {
    var sim = DET && DET.itemId === itemId ? DET.simulacaoMargem : null;
    if (sim && p.modoEscrita !== "ACEITE" && DET.promoLinhaSelecionada === promocaoChave(p) && sim.preco != null) return sim.preco;
    return p.precoFinal;
  }

  // "Você recebe" da linha. Auto-preenchido pelo backend (ctrl.anexarVoceRecebe,
  // mesmo Motor de .../simular-margem, price=precoFinal + rebate=subsidioMl);
  // a linha ESCOLHIDA com preço simulado mostra o resultado da simulação.
  // Linha ACEITE nunca troca: o preço dela é do ML (ver
  // precoFinalExibidoDaLinha).
  function promocaoRecebeDaLinha(p, itemId) {
    var sim = DET && DET.itemId === itemId ? DET.simulacaoMargem : null;
    var selecionada = !!(DET && DET.promoLinhaSelecionada === promocaoChave(p));
    if (selecionada && p.modoEscrita !== "ACEITE" && sim && sim.preco != null) {
      return sim.resultado ? sim.resultado : { calculando: true };
    }
    return p.voceRecebe || null;
  }

  function promocaoVoceRecebeHtml(p, itemId, moeda) {
    var r = promocaoRecebeDaLinha(p, itemId);
    if (r && r.calculando) return '<span class="am-promo__recebe am-promo__recebe--vazio">Simulando…</span>';
    if (!r) return '<span class="am-promo__recebe am-promo__recebe--vazio">—</span>';
    if (!r.computable) return '<span class="am-promo__recebe am-promo__recebe--vazio">Sem dados suficientes</span>';
    return '<span class="am-promo__recebe">' + formatMoeda(r.profit, moeda) + "</span>";
  }

  // "Margem": o percentual da mesma conta do "Você recebe" (Motor) — a
  // margem de cada promoção à vista, sem precisar escolher a linha.
  function promocaoMargemHtml(p, itemId) {
    var r = promocaoRecebeDaLinha(p, itemId);
    if (!r || r.calculando || !r.computable || r.marginPercent == null) {
      return '<span class="am-promo__margem am-promo__margem--vazio">—</span>';
    }
    return '<span class="am-promo__margem' + (r.marginPercent < 0 ? " is-neg" : "") + '">' +
      escapeHtml(formatarPercentualCompacto(r.marginPercent)) + "</span>";
  }

  // "vs. hoje": quanto a linha muda a margem por venda em relação à margem
  // real de hoje (cache.margem, a mesma da composição).
  function promocaoVsHojeHtml(p, itemId, moeda) {
    var r = promocaoRecebeDaLinha(p, itemId);
    var cache = AM.state.performanceCache[itemId];
    var hoje = cache && cache.margem ? cache.margem.profit : null;
    if (!r || r.calculando || !r.computable || r.profit == null || hoje == null) return margemDeltaHtml(null, moeda);
    return margemDeltaHtml(r.profit - hoje, moeda);
  }

  function promocaoPrecoHtml(p, itemId, moeda) {
    var preco = precoFinalExibidoDaLinha(p, itemId);
    if (preco == null) return '<span class="am-promo__preco am-promo__preco--vazio">Sem sugestão</span>';
    var desc = "";
    if (p.precoOriginal != null && p.precoOriginal > 0 && preco < p.precoOriginal) {
      desc = '<span class="am-promo__preco-desc">−' +
        escapeHtml(formatarPercentualCompacto(((p.precoOriginal - preco) / p.precoOriginal) * 100)) + "</span>";
    }
    return '<span class="am-promo__preco">' + formatMoeda(preco, moeda) + "</span>" + desc;
  }

  // Grupos por o que o operador PODE fazer — a ordem é a de leitura: o que
  // forma o preço agora, o que já está inscrito, o que dá para inscrever por
  // aqui, e o que só o painel do ML resolve. Chave é statusExibicao/status +
  // modoEscrita (ambos do backend — meliPromocoesService).
  var PROMO_GRUPOS = [
    { chave: "ativa", titulo: "Ativa agora", dica: "É ela que forma o preço de hoje" },
    { chave: "participa", titulo: "Você já participa", dica: "Inscrita, mas não é a que forma o preço agora" },
    { chave: "pode", titulo: "Pode participar pelo VenForce", dica: "Escolha, simule e confirme por aqui" },
    { chave: "ml", titulo: "Só pelo Mercado Livre", dica: "Dá para simular; a inscrição é feita no painel do Mercado Livre" },
  ];

  function promocaoGrupo(p) {
    if (p.statusExibicao === "ATIVA") return "ativa";
    if (promocaoParticipa(p)) return "participa";
    if (p.status === "candidate" && (p.modoEscrita === "PRECO" || p.modoEscrita === "ACEITE")) return "pode";
    return "ml";
  }

  // A LINHA INTEIRA é o controle: clicar escolhe a promoção e preenche a
  // coluna Simulação da composição (ver selecionarPromocao). Nenhum botão
  // por linha — a ação fica num lugar só (#am-det-margem-acoes).
  function promocaoLinhaHtml(p, itemId, moeda) {
    var chave = promocaoChave(p);
    var selecionada = !!(DET && DET.promoLinhaSelecionada === chave);
    var periodo = promocaoPeriodoTexto(p);
    return '<button type="button" class="am-promo__linha' + (selecionada ? " is-selecionada" : "") + '" ' +
        'data-acao="promo-selecionar" data-promo-key="' + escapeAttr(chave) + '" aria-pressed="' + (selecionada ? "true" : "false") + '">' +
      '<span class="am-promo__radio" aria-hidden="true"></span>' +
      '<span class="am-promo__col-nome">' +
        '<span class="am-promo__nome">' + escapeHtml(p.nome || p.tipoLabel) + "</span>" +
        '<span class="am-promo__meta">' +
          '<span class="vf-status ' + promocaoStatusClasse(p.statusExibicao) + '">' + escapeHtml(p.statusExibicao) + "</span>" +
          (periodo ? "<span>" + escapeHtml(periodo) + "</span>" : "") +
        "</span>" +
      "</span>" +
      '<span class="am-promo__col-num">' + promocaoPrecoHtml(p, itemId, moeda) + "</span>" +
      '<span class="am-promo__col-num">' + promocaoSubsidioMlHtml(p, moeda) + "</span>" +
      '<span class="am-promo__col-num">' + promocaoVoceRecebeHtml(p, itemId, moeda) + "</span>" +
      '<span class="am-promo__col-num">' + promocaoMargemHtml(p, itemId) + "</span>" +
      '<span class="am-promo__col-num am-promo__col-vs">' + promocaoVsHojeHtml(p, itemId, moeda) + "</span>" +
    "</button>";
  }

  function promocoesListaHtml(lista, itemId, moeda) {
    var grupos = PROMO_GRUPOS.map(function (g) {
      var itens = lista.filter(function (p) { return promocaoGrupo(p) === g.chave; });
      if (!itens.length) return "";
      return '<div class="am-promo__grupo" data-grupo="' + g.chave + '">' +
        '<div class="am-promo__grupo-cab">' +
          '<span class="am-promo__grupo-titulo">' + escapeHtml(g.titulo) + "</span>" +
          '<span class="am-promo__grupo-dica">' + escapeHtml(g.dica) + "</span>" +
        "</div>" +
        itens.map(function (p) { return promocaoLinhaHtml(p, itemId, moeda); }).join("") +
      "</div>";
    }).join("");
    return '<div class="am-promo__scroll"><div class="am-promo__lista">' +
      '<div class="am-promo__cab" aria-hidden="true">' +
        "<span></span><span>Promoção</span><span>Preço final</span><span>Subsídio ML</span><span>Você recebe</span><span>Margem</span><span>vs. hoje</span>" +
      "</div>" +
      grupos +
    "</div></div>";
  }

  function promocoesCorpoHtml(itemId, moeda) {
    var cache = AM.state.promocoesCache[itemId];
    if (!cache) return promocoesDicaHtml("Carregando promoções…");
    if (!cache.ok) return promocoesDicaHtml("Não foi possível carregar as promoções deste anúncio agora.");
    if (!cache.promocoes.length) return promocoesDicaHtml("Nenhuma promoção disponível para este anúncio no momento.");
    return promocoesListaHtml(cache.promocoes, itemId, moeda);
  }

  // Seção NÃO recolhível (ao contrário da composição da margem): a lista já
  // nasce visível, lado a lado com a composição (ver .am-det-margem-grid no
  // CSS) — só o CONTEÚDO troca de "Carregando…" para a lista quando a
  // resposta chega, sem exigir um clique extra do operador.
  function promocoesSecaoHtml(itemId, moeda) {
    return '<div class="am-det-section am-promo" id="am-det-promo" data-item="' + escapeAttr(itemId) + '">' +
      '<div class="am-det-section__head">' +
        '<h3 class="am-det-section__title">Promoções disponíveis</h3>' +
        '<span class="am-det-section__meta">Clique numa promoção para simular</span>' +
      "</div>" +
      '<div class="am-promo__body" id="am-det-promo-body">' + promocoesCorpoHtml(itemId, moeda) + "</div>" +
    "</div>";
  }

  function repintarPromocoesDoItem(itemId) {
    if (!DET || DET.itemId !== itemId || !DET.anuncio) return;
    var corpo = el("am-det-promo-body");
    if (!corpo) return;
    corpo.innerHTML = promocoesCorpoHtml(itemId, DET.anuncio.moeda);
  }

  function bindPromocoes(secao, itemId) {
    if (!secao) return;
    secao.addEventListener("click", function (e) {
      var linha = e.target.closest('[data-acao="promo-selecionar"]');
      if (!linha || !secao.contains(linha)) return;
      e.stopPropagation();
      selecionarPromocao(itemId, linha.getAttribute("data-promo-key"));
    });
  }

  // Escolher uma promoção NUNCA grava nada: só preenche a coluna Simulação
  // com o cenário "o anúncio nesta promoção" — preço final dela (real, ou
  // sugerido pelo ML) + o subsídio dela (ver dispararSimulacaoMargem). Vale
  // também para as que o anúncio já participa: a simulação bate com o
  // "Você recebe" da linha. Clicar de novo na mesma linha desmarca. Sem
  // preço sugerido, o campo de preço da simulação recebe o foco para o
  // operador digitar — nunca um número inventado.
  function selecionarPromocao(itemId, chave) {
    if (!DET || DET.itemId !== itemId) return;
    var p = promocaoPorChave(itemId, chave);
    if (!p) return;
    var sim = DET.simulacaoMargem;

    if (DET.promoLinhaSelecionada === chave) {
      DET.promoLinhaSelecionada = null;
      sim.preco = null;
      dispararSimulacaoMargem(itemId);
      return;
    }

    DET.promoLinhaSelecionada = chave;
    sim.preco = p.precoFinal != null ? p.precoFinal : null;
    dispararSimulacaoMargem(itemId);

    if (sim.preco == null && p.modoEscrita !== "ACEITE") {
      var campo = document.querySelector('#am-det-margem-body .am-margem-sim__input[data-margem-campo="preco"]');
      if (campo) campo.focus();
    }
  }

  // Margem simulada para os diálogos — sempre o que veio do Motor.
  function margemSimuladaTexto(moeda) {
    var r = DET && DET.simulacaoMargem && DET.simulacaoMargem.resultado;
    if (!r || !r.computable || r.profit == null) return "—";
    return formatMoeda(r.profit, moeda) + (r.marginPercent != null ? " (" + formatarPercentualCompacto(r.marginPercent) + ")" : "");
  }

  // PRECO (DEAL/SELLER_CAMPAIGN): participar com o preço escolhido, ou
  // alterar o preço de uma participação (formando o preço agora ou não —
  // `alterarParticipacao` pede isso explicitamente ao backend). Defesa em
  // profundidade — mesma régua de margemAcaoAtual; o backend relê tudo ao
  // vivo de novo antes de escrever (meliPromocoesEscritaService).
  function abrirConfirmacaoPromocao(itemId, linha) {
    if (!DET || DET.itemId !== itemId || !linha) return;
    if (linha.modoEscrita !== "PRECO") return;
    var sim = DET.simulacaoMargem;
    if (!sim || sim.preco == null) return;

    var jaParticipada = promocaoParticipa(linha);
    if (!jaParticipada && linha.status !== "candidate") return;

    // ATIVA com retorno ML: a alteração (PUT) para esse caso ainda não está
    // disponível — avisa e para aqui, sem escrita.
    if (jaParticipada && linha.statusExibicao === "ATIVA" && linha.subsidioMl != null) {
      toast(
        "Esta promoção possui participação do Mercado Livre (rebate). A alteração de valores ainda não está disponível para este tipo de promoção.",
        "is-warning"
      );
      return;
    }

    var moeda = DET.anuncio.moeda;
    abrirConfirmacaoEscrita({
      titulo: jaParticipada ? "Alterar o preço da promoção?" : "Participar da promoção?",
      textoConfirmar: jaParticipada ? "Alterar preço" : "Participar",
      linhas: [
        { rotulo: "Promoção", valor: linha.nome || linha.tipoLabel },
        { rotulo: jaParticipada ? "Preço na promoção" : "Preço atual",
          valor: formatMoeda(jaParticipada && linha.precoFinal != null ? linha.precoFinal : linha.precoOriginal, moeda) },
        { rotulo: "Novo preço", valor: formatMoeda(sim.preco, moeda) },
        { rotulo: "Margem por venda", valor: margemSimuladaTexto(moeda) },
      ],
      aoConfirmar: function (concluir) {
        var extra = { precoNovo: sim.preco };
        if (jaParticipada) extra.alterarParticipacao = true;
        escreverPromocao(itemId, "/promocoes/" + encodeURIComponent(linha.id) + "/aplicar", extra, concluir,
          function (d) { return d.metodo === "POST" ? "Participação confirmada no Mercado Livre." : "Promoção alterada no Mercado Livre."; });
      },
    });
  }

  // Participar sem preço (ACEITE — o Mercado Livre define) ou deixar de
  // participar (ACEITE e PRECO). Nenhum preço é enviado. Mesma régua de
  // margemAcaoAtual.
  function abrirConfirmacaoAceite(itemId, linha, sair) {
    if (!DET || DET.itemId !== itemId || !linha) return;
    if (sair) {
      if (!promocaoParticipa(linha) || (linha.modoEscrita !== "ACEITE" && linha.modoEscrita !== "PRECO")) return;
    } else if (linha.modoEscrita !== "ACEITE" || linha.status !== "candidate") {
      return;
    }

    var moeda = DET.anuncio.moeda;
    var cache = AM.state.performanceCache[itemId];
    var comp = cache && cache.composicao;
    var sim = DET.simulacaoMargem;
    var precoHoje = comp ? comp.venda : null;
    var margemHoje = cache && cache.margem && cache.margem.profit != null
      ? formatMoeda(cache.margem.profit, moeda) +
        (cache.margem.marginPercent != null ? " (" + formatarPercentualCompacto(cache.margem.marginPercent) + ")" : "")
      : "—";
    var linhas = [
      { rotulo: "Promoção", valor: linha.nome || linha.tipoLabel },
      { rotulo: "Preço hoje", valor: formatMoeda(precoHoje, moeda) },
    ];
    if (!sair) {
      linhas.push({ rotulo: "Preço na promoção", valor: formatMoeda(sim && sim.preco != null ? sim.preco : linha.precoFinal, moeda) });
      linhas.push({ rotulo: "Margem por venda", valor: simulacaoTemOverride(sim) ? margemSimuladaTexto(moeda) : margemHoje });
    } else if (linha.statusExibicao === "ATIVA") {
      // Sai a que forma o preço: o anúncio volta ao preço cheio (ou a outra
      // promoção em que participa — quem decide é o Mercado Livre).
      linhas.push({ rotulo: "Preço depois de sair", valor: formatMoeda(linha.precoOriginal, moeda) + " (preço cheio)" });
    } else {
      linhas.push({ rotulo: "Preço depois de sair", valor: formatMoeda(precoHoje, moeda) + " (não muda)" });
      linhas.push({ rotulo: "Margem por venda", valor: margemHoje + " (não muda)" });
    }

    abrirConfirmacaoEscrita({
      titulo: sair ? "Deixar de participar da promoção?" : "Participar da promoção?",
      textoConfirmar: sair ? "Deixar de participar" : "Participar",
      linhas: linhas,
      aoConfirmar: function (concluir) {
        escreverPromocao(itemId, "/promocoes/" + encodeURIComponent(linha.id) + (sair ? "/sair" : "/participar"),
          { tipo: linha.tipo }, concluir,
          function () { return sair ? "Você saiu da promoção no Mercado Livre." : "Participação confirmada no Mercado Livre."; });
      },
    });
  }

  // Nunca chamada fora do "Confirmar" dos diálogos acima. Depois do sucesso
  // a promoção pode ter mudado de status e o preço do anúncio também — a
  // simulação some, promoções e composição são relidas do zero, nunca se
  // assume o que foi enviado.
  function escreverPromocao(itemId, sufixo, extra, concluir, mensagemSucesso) {
    var corpo = { clienteSlug: AM.clienteAtual.slug };
    if (AM.contaMlId) corpo.clienteContaId = AM.contaMlId;
    Object.keys(extra).forEach(function (k) { corpo[k] = extra[k]; });

    var meuToken = DET ? DET.token : null;
    api("/anuncios-meli/" + encodeURIComponent(itemId) + sufixo, { method: "POST", body: corpo }).then(function (r) {
      if (!DET || DET.token !== meuToken) { concluir(); return; } // modal fechado, ou outro MLB no meio do caminho
      var d = r.data || {};
      if (!d.ok) {
        concluir(d.motivo || "Não foi possível atualizar a promoção.");
        return;
      }

      recarregarPromocoesEComposicao(itemId);
      toast(mensagemSucesso(d));
      concluir();
    });
  }

  // Relê do Mercado Livre, ao vivo, tudo o que uma promoção muda: a lista de
  // promoções (status, qual forma o preço) e a composição/margem (preço
  // atual, rebate). A simulação some — nunca se assume o que foi enviado.
  // Usada depois de cada escrita e pelo botão "Atualizar" do cabeçalho.
  // A promessa nunca rejeita.
  function recarregarPromocoesEComposicao(itemId) {
    if (!DET || DET.itemId !== itemId) return Promise.resolve();
    var meuToken = DET.token;
    DET.simulacaoMargem = novaSimulacaoMargem();
    DET.promoLinhaSelecionada = null;
    DET.simulacaoSeq = (DET.simulacaoSeq || 0) + 1;
    delete AM.state.promocoesCache[itemId];
    var cache = AM.state.performanceCache[itemId];
    if (cache) { cache.temComposicao = false; cache.temMargem = false; }
    repintarPromocoesDoItem(itemId);
    repintarComposicaoDoItem(itemId);

    // Promoções primeiro: a composição relida precisa saber qual promoção
    // ficou ATIVA (rebate) — mesma ordem de carregarComposicaoDoDetalhe.
    return garantirPromocoesDoItem(itemId).then(function () {
      if (!DET || DET.token !== meuToken) return null;
      repintarPromocoesDoItem(itemId);
      return garantirComposicaoDoItem(itemId);
    }).then(function () {
      if (!DET || DET.token !== meuToken) return;
      repintarComposicaoDoItem(itemId);
      repintarPromocoesDoItem(itemId);
    }, function () {});
  }

  // Botão "Atualizar" do cabeçalho: confere se uma promoção entrou/saiu sem
  // fechar o modal nem recarregar a página.
  function atualizarAnuncioAoVivo() {
    if (!DET || !DET.anuncio || DET.atualizando) return;
    var itemId = DET.anuncio.item_id;
    var meuToken = DET.token;
    DET.atualizando = true;
    pintarBotaoAtualizar();
    recarregarPromocoesEComposicao(itemId).then(function () {
      if (!DET || DET.token !== meuToken) return;
      DET.atualizando = false;
      pintarBotaoAtualizar();
      toast("Preço, promoções e margem atualizados com o Mercado Livre.");
    });
  }

  function botaoAtualizarHtml() {
    var ocupado = !!(DET && DET.atualizando);
    return '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm' + (ocupado ? " is-loading" : "") + '" ' +
      'id="am-det-atualizar" data-acao="atualizar-anuncio"' + (ocupado ? " disabled" : "") + " " +
      'title="Relê preço, promoções e margem direto do Mercado Livre">' +
      icAtualizar() + (ocupado ? "Atualizando…" : "Atualizar") + "</button>";
  }

  function pintarBotaoAtualizar() {
    var b = el("am-det-atualizar");
    if (b) b.outerHTML = botaoAtualizarHtml();
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
            " — " + sujos.map(rotuloCampo).join(", ") + "?</span>" +
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
          " — " + sujos.map(rotuloCampo).join(", ") + "</span>" +
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
    var artigo = c.chave === "descricao" ? "da descrição"
      : c.chave === "modelo" ? "do modelo"
      : DET && DET.modoFamilia ? "do nome do produto" : "do título";
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
  // Na família, o rascunho "titulo" é o family_name e vai como nomeFamilia.
  function chaveApi(c) {
    return c.chave === "titulo" && DET && DET.modoFamilia ? "nomeFamilia" : c.chave;
  }

  function salvarAlteracoes() {
    if (!DET || DET.salvando) return;
    var sujos = camposSujos();
    if (!sujos.length) return;

    var corpo = { clienteSlug: AM.clienteAtual.slug };
    if (AM.contaMlId) corpo.clienteContaId = AM.contaMlId;
    sujos.forEach(function (c) { corpo[chaveApi(c)] = DET.rascunho[c.chave]; });

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
        var res = d.resultados[chaveApi(c)];
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
      if (d.familia) DET.familia = d.familia;

      renderDetalhe();

      if (!falhas.length) {
        toast(d.resultados.nomeFamilia
          ? "Nome do produto salvo. O Mercado Livre atualiza o título de cada variação em instantes."
          : "Alterações salvas no anúncio do Mercado Livre.", "is-success");
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
    if (acao === "atualizar-anuncio") { atualizarAnuncioAoVivo(); return; }
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
    if (fonte === "descricao-sugerida") return (DET.descricaoSeo.estado === "ok" || DET.descricaoSeo.estado === "aviso") ? DET.descricaoSeo.texto : "";
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
  // Sincronização — NÃO bloqueia a tela. O lado direito do card do cliente
  // (.am-sync-area) tem dois modos:
  //   - parado: lista das duas ações, cada uma com a sua explicação;
  //   - rodando/terminado: painel de andamento (#am-sync-status) com uma linha
  //     do tempo de 2 etapas, relógio e contador do recálculo.
  // Etapas:
  //   1. "sincronizando": POST /anuncios-meli/sync (grava os anúncios);
  //   2. "recalculando": EXATAMENTE o "Atualizar leitura" da Central de
  //      Margem — POST .../snapshot/refresh (reaproveita o run que o backend
  //      já enfileirou no sync), polling do run, e a lista é relida quando ele
  //      termina (antes disso a data "calculada em" ainda é a antiga).
  // O painel só é redesenhado quando muda de estado (fase/etapas); progresso e
  // relógio são aplicados no lugar, para a barra e o pulso não reiniciarem a
  // cada polling. Antes era um modal que travava a tela e sumia no OK com a
  // margem ainda calculando — o operador achava que tinha acabado.
  // ===========================================================================
  var MARGEM_POLL_MS = Number(window.__VF_AM_MARGEM_POLL_MS__) || 4000;
  var margemRecalculo = { seq: 0, timer: null };
  var syncRelogio = null;

  function syncEmAndamento() {
    return !!(AM.sync && (AM.sync.fase === "sincronizando" || AM.sync.fase === "recalculando"));
  }

  function doisDigitos(n) { return (n < 10 ? "0" : "") + n; }

  function horaDe(ms) {
    var d = new Date(ms);
    return doisDigitos(d.getHours()) + ":" + doisDigitos(d.getMinutes());
  }

  function duracaoTexto(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ":" + doisDigitos(s % 60);
  }

  var SYNC_CHECK_SVG = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.3 5 8.7l4.6-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Tudo o que o painel mostra, derivado de AM.sync. `chave` muda só quando
  // a estrutura muda (fase, estado das etapas, rodapé).
  function syncVisao() {
    var s = AM.sync;
    if (!s || !AM.clienteAtual || s.slug !== AM.clienteAtual.slug) return null;
    var run = s.run || null;
    var total = run && run.totalItems ? run.totalItems : 0;
    var feitos = run ? Math.min(run.processedItems || 0, total || Infinity) : 0;
    var e1, e2;

    if (s.fase === "sincronizando") {
      e1 = { estado: "ativo", detalhe: "Consultando o Mercado Livre…" };
      e2 = { estado: "pendente", detalhe: "Começa quando a etapa 1 terminar." };
    } else if (s.fase === "erro") {
      e1 = { estado: "erro", detalhe: s.motivo };
      e2 = { estado: "pendente", detalhe: "Não começou." };
    } else {
      e1 = { estado: "feito", detalhe: s.resumoSync };
      if (s.fase === "recalculando") {
        e2 = { estado: "ativo", detalhe: s.refazendo
          ? "Só os " + s.refazendo + " que falharam no cálculo anterior."
          : (total ? "Com o preço e o custo atuais de cada anúncio." : "Aguardando o cálculo começar.") };
      } else if (s.margem === "pulada") {
        e2 = { estado: "pulado", detalhe: "Nenhum anúncio novo, margem mantida." };
      } else if (s.margem === "sem_base") {
        e2 = { estado: "aviso", detalhe: s.aviso };
      } else if (s.margem === "ok") {
        var falhas = (run && run.failedItems) || 0;
        var okN = (run && run.successItems) || 0;
        e2 = {
          estado: falhas ? "aviso" : "feito",
          detalhe: s.refazendo
            ? okN + " de " + s.refazendo + " recuperados" + (falhas ? " · " + falhas + " ainda com o valor anterior." : ".")
            : okN + " anúncio(s) recalculados" + (falhas ? " · " + falhas + " mantiveram o valor anterior." : "."),
        };
      } else {
        e2 = { estado: "aviso", detalhe: s.aviso };
      }
    }

    var andamento = s.fase === "sincronizando" || s.fase === "recalculando";
    var tom = andamento ? "is-andamento" : s.fase === "erro" ? "is-erro" : (e2.estado === "aviso" ? "is-aviso" : "is-ok");
    var rodape = "";
    if (s.fase === "erro") rodape = "Não foi possível sincronizar";
    else if (!andamento) rodape = (e2.estado === "aviso" ? "Anúncios sincronizados às " : "Concluído às ") + horaDe(s.tFim) + " · levou " + duracaoTexto(s.tFim - s.t0);
    // Recalcular só os que falharam: o run guardou os ids (podeRefazerFalhas).
    var refazerN = !andamento && s.margem === "ok" && run && run.podeRefazerFalhas ? (run.failedItems || 0) : 0;

    return {
      andamento: andamento,
      tom: tom,
      titulo: s.modo === "completo" ? "Sincronização completa" : "Atualizar novos",
      e1: e1,
      e2: e2,
      feitos: feitos,
      total: total,
      pct: total ? Math.round(feitos / total * 100) : 0,
      relogio: duracaoTexto((s.tFim || Date.now()) - s.t0),
      rodape: rodape,
      refazerN: refazerN,
      semBase: !andamento && s.margem === "sem_base",
      refazerRunId: refazerN ? run.runId : null,
      anuncio: s.fase === "sincronizando" ? "Sincronização em andamento, etapa 1 de 2: anúncios do Mercado Livre."
        : s.fase === "recalculando" ? "Etapa 2 de 2: recalculando a margem dos anúncios."
        : s.fase === "erro" ? "Não foi possível sincronizar. " + s.motivo
        : rodape + ".",
      chave: [s.fase, s.modo, e1.estado, e2.estado, total ? "n" : "-", refazerN, s.refazendo || 0, s.margem || ""].join("|"),
    };
  }

  function syncEtapaHtml(n, titulo, etapa, extra) {
    return '<li class="am-sync-etapa is-' + etapa.estado + '" data-etapa="' + n + '">' +
      '<span class="am-sync-etapa__marca" aria-hidden="true"><b>' + n + "</b>" + SYNC_CHECK_SVG + "</span>" +
      '<div class="am-sync-etapa__corpo">' +
        '<p class="am-sync-etapa__titulo">' + titulo + "</p>" +
        (extra || "") +
        '<p class="am-sync-etapa__detalhe" data-sync-bind="d' + n + '">' + escapeHtml(etapa.detalhe || "") + "</p>" +
      "</div>" +
    "</li>";
  }

  function syncPainelHtml(v) {
    var trilho1 = v.e1.estado === "ativo" ? '<div class="am-sync-trilho is-indeterminado"><i></i></div>' : "";
    var contador = v.e2.estado === "ativo" && v.total
      ? '<p class="am-sync-contador"><strong data-sync-bind="feitos">' + v.feitos + "</strong><span>de " + v.total + " recalculados</span></p>" +
        '<div class="am-sync-trilho" role="progressbar" aria-label="Recálculo da margem" aria-valuemin="0" aria-valuemax="' + v.total + '" aria-valuenow="' + v.feitos + '"><i data-sync-fill style="width:' + v.pct + '%"></i></div>'
      : v.e2.estado === "ativo" ? '<div class="am-sync-trilho is-indeterminado"><i></i></div>' : "";
    var rodape = v.andamento
      ? '<p class="am-sync-status__dica">Pode continuar usando a tela enquanto isso.</p>'
      : '<div class="am-sync-status__rodape">' +
          '<span class="am-sync-status__resultado">' + escapeHtml(v.rodape) + "</span>" +
          '<span class="am-sync-status__acoes">' +
            (v.tom === "is-erro" ? '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-sync-repetir>Tentar de novo</button>' : "") +
            (v.semBase ? '<a class="vf-btn vf-btn--secondary vf-btn--sm" href="bases.html" data-sync-vincular-base>Vincular base</a>' : "") +
            (v.refazerN ? '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" data-sync-refazer-falhas="' + escapeAttr(String(v.refazerRunId)) + '">' +
              "Recalcular só " + (v.refazerN === 1 ? "o que falhou" : "os " + v.refazerN + " que falharam") + "</button>" : "") +
            '<button type="button" class="vf-btn vf-btn--ghost vf-btn--sm" data-sync-fechar>Fechar</button>' +
          "</span>" +
        "</div>";
    return '<div class="am-sync-status ' + v.tom + '" id="am-sync-status" data-sync-chave="' + escapeHtml(v.chave) + '">' +
      '<p class="vf-visually-hidden" role="status" aria-live="polite">' + escapeHtml(v.anuncio) + "</p>" +
      '<div class="am-sync-status__topo">' +
        '<p class="am-sync-status__titulo">' + v.titulo + "</p>" +
        '<span class="am-sync-status__relogio" data-sync-bind="relogio" aria-hidden="true">' + v.relogio + "</span>" +
      "</div>" +
      '<ol class="am-sync-etapas">' +
        syncEtapaHtml(1, "Anúncios do Mercado Livre", v.e1, trilho1) +
        syncEtapaHtml(2, "Margem dos anúncios", v.e2, contador) +
      "</ol>" +
      rodape +
    "</div>";
  }

  // Lado direito parado: as duas ações, cada uma com a sua explicação.
  function syncAcoesHtml() {
    return '<div class="am-sync-acoes">' +
      '<div class="am-sync-acao">' +
        '<div><p class="am-sync-acao__titulo">Atualizar novos</p><p class="am-sync-acao__texto">Busca só os anúncios criados desde a última sincronização.</p></div>' +
        '<button type="button" class="vf-btn vf-btn--secondary vf-btn--sm" id="am-sync-novos">Atualizar</button>' +
      "</div>" +
      '<div class="am-sync-acao">' +
        '<div><p class="am-sync-acao__titulo">Sincronização completa</p><p class="am-sync-acao__texto">Revisa todo o catálogo e recalcula a margem.</p></div>' +
        '<button type="button" class="vf-btn vf-btn--primary vf-btn--sm" id="am-sync-completo">Sincronizar</button>' +
      "</div>" +
    "</div>";
  }

  // Atualiza só o lado direito do card — sem redesenhar o HUD inteiro.
  function renderSyncStatus() {
    var area = document.querySelector(".am-sync-area");
    if (!area) return;
    var v = syncVisao();
    var atual = el("am-sync-status");
    var acoes = area.querySelector(".am-sync-acoes");
    if (acoes) acoes.hidden = !!v;

    if (!v) {
      if (atual) atual.parentNode.removeChild(atual);
    } else if (atual && atual.getAttribute("data-sync-chave") === v.chave) {
      area.querySelectorAll("[data-sync-bind]").forEach(function (n) {
        var k = n.getAttribute("data-sync-bind");
        var valor = k === "d1" ? v.e1.detalhe : k === "d2" ? v.e2.detalhe : v[k];
        if (valor != null && n.textContent !== String(valor)) n.textContent = valor;
      });
      var fill = area.querySelector("[data-sync-fill]");
      if (fill) {
        fill.style.width = v.pct + "%";
        fill.parentNode.setAttribute("aria-valuenow", String(v.feitos));
      }
    } else {
      if (atual) atual.outerHTML = syncPainelHtml(v);
      else area.insertAdjacentHTML("beforeend", syncPainelHtml(v));
      var fechar = area.querySelector("[data-sync-fechar]");
      if (fechar) fechar.addEventListener("click", function () { setSync(null); });
      var repetir = area.querySelector("[data-sync-repetir]");
      if (repetir) repetir.addEventListener("click", function () { var m = AM.sync && AM.sync.modo; setSync(null); sincronizar(m || "completo"); });
      var refazer = area.querySelector("[data-sync-refazer-falhas]");
      if (refazer) refazer.addEventListener("click", function () {
        if (syncEmAndamento()) return;
        setSync({ refazendo: v.refazerN, t0: Date.now(), tFim: null });
        recalcularMargemAposSync({ refazerFalhasDoRun: refazer.getAttribute("data-sync-refazer-falhas") });
      });
    }

    var andamento = syncEmAndamento();
    ["am-sync-novos", "am-sync-completo"].forEach(function (id) {
      var b = el(id);
      if (b) b.disabled = andamento;
    });
    if (andamento && !syncRelogio) {
      syncRelogio = setInterval(function () {
        if (!syncEmAndamento()) { clearInterval(syncRelogio); syncRelogio = null; return; }
        var r = document.querySelector('#am-sync-status [data-sync-bind="relogio"]');
        if (r && AM.sync) r.textContent = duracaoTexto(Date.now() - AM.sync.t0);
      }, 1000);
    } else if (!andamento && syncRelogio) {
      clearInterval(syncRelogio); syncRelogio = null;
    }
  }

  // Mescla na sincronização atual; null limpa.
  function setSync(dados) {
    if (dados === null) AM.sync = null;
    else {
      AM.sync = Object.assign({}, AM.sync || {}, dados);
      if (!syncEmAndamento() && !AM.sync.tFim) AM.sync.tFim = Date.now();
    }
    renderSyncStatus();
  }

  // Recálculo que falhou por falta de Base de custos (códigos canônicos de
  // server/utils/erroContextoCanonico.js): mensagem própria + "Vincular base".
  var MSG_SEM_BASE = "Margem não calculada: esta conta não tem Base de custos vinculada.";
  var CODIGOS_SEM_BASE = {
    BASE_AUSENTE: MSG_SEM_BASE,
    BASE_AMBIGUA: "Margem não calculada: há mais de uma Base de custos vinculada a esta conta. Corrija o vínculo em Bases de custo.",
  };

  // opcoes.refazerFalhasDoRun: recalcula só os anúncios que falharam naquele run.
  function recalcularMargemAposSync(opcoes) {
    var refazerDe = opcoes && opcoes.refazerFalhasDoRun ? opcoes.refazerFalhasDoRun : null;
    if (!refazerDe && AM.sync && AM.sync.refazendo) setSync({ refazendo: 0 });
    if (!AM.clienteAtual || !AM.contaMlId) {
      setSync({ fase: "aviso", margem: "falhou", aviso: "Sem conta ML selecionada para recalcular a margem." });
      return;
    }
    margemRecalculo.seq += 1;
    if (margemRecalculo.timer) clearTimeout(margemRecalculo.timer);
    var seq = margemRecalculo.seq;
    var slug = AM.clienteAtual.slug;
    var conta = AM.contaMlId;
    var base = "/operacao/central-margem/" + encodeURIComponent(slug) + "/snapshot/refresh";
    function mesmaTela() {
      return seq === margemRecalculo.seq && AM.sync && AM.clienteAtual && AM.clienteAtual.slug === slug && AM.contaMlId === conta;
    }
    setSync({ fase: "recalculando", margem: null, run: null });
    var corpo = { clienteContaId: conta };
    if (refazerDe) corpo.refazerFalhasDoRun = refazerDe;
    api(base, { method: "POST", body: corpo }).then(function (r) {
      if (!mesmaTela()) return;
      var d = r.data || {};
      if (!d.ok || !d.runId) {
        setSync({ fase: "aviso", margem: "falhou",
          aviso: "Não foi possível recalcular a margem agora. Use \"Atualizar leitura\" na Central de Margem." });
        return;
      }
      function tick() {
        if (!mesmaTela()) return;
        api(base + "/" + encodeURIComponent(d.runId) + "?clienteContaId=" + encodeURIComponent(conta)).then(function (s) {
          if (!mesmaTela()) return;
          var run = s.data && s.data.ok ? s.data.run : null;
          // Falha pontual de rede não encerra o acompanhamento.
          if (!run || (run.status !== "completed" && run.status !== "failed")) {
            if (run) setSync({ run: run });
            margemRecalculo.timer = setTimeout(tick, MARGEM_POLL_MS);
            return;
          }
          if (run.status === "completed") {
            setSync({ fase: run.failedItems ? "aviso" : "ok", margem: "ok", run: run });
            toast(refazerDe
              ? (run.failedItems ? "Recálculo refeito; alguns anúncios ainda falharam." : "Os anúncios que tinham falhado foram recalculados.")
              : "Sincronização concluída e margem recalculada.", run.failedItems && refazerDe ? undefined : "is-success");
          } else if (CODIGOS_SEM_BASE[run.errorCode]) {
            // Não é falha passageira: tentar de novo falharia igual.
            setSync({ fase: "aviso", margem: "sem_base", aviso: CODIGOS_SEM_BASE[run.errorCode] });
          } else {
            setSync({ fase: "aviso", margem: "falhou",
              aviso: "O recálculo falhou; a margem mostrada é a do cálculo anterior. Tente \"Atualizar leitura\" na Central de Margem." });
            toast("O recálculo da margem falhou.", "is-danger");
          }
          carregarResumo(); carregarAnuncios();
        });
      }
      setSync({ run: d.run || null });
      margemRecalculo.timer = setTimeout(tick, MARGEM_POLL_MS);
    });
  }

  function sincronizar(modo) {
    // Sem operação escolhida o Shell nem exibe esta tela (scope="account"):
    // nenhuma guarda de cardinalidade própria aqui (R8).
    if (!AM.clienteAtual || syncEmAndamento()) return;
    var slug = AM.clienteAtual.slug;
    var conta = AM.contaMlId;
    AM.sync = null;
    setSync({ slug: slug, modo: modo, fase: "sincronizando", t0: Date.now(), tFim: null });

    api("/anuncios-meli/sync", {
      method: "POST",
      body: { clienteSlug: slug, modo: modo, clienteContaId: conta || undefined },
    }).then(function (r) {
      if (!AM.sync || !AM.clienteAtual || AM.clienteAtual.slug !== slug || AM.contaMlId !== conta) return;
      var d = r.data || {};
      if (!d.ok) {
        setSync({
          fase: "erro",
          motivo: (d.motivo || "Erro ao consultar o Mercado Livre.") +
            (d.codigo === "NO_TOKEN" ? " Conecte a conta do Mercado Livre deste cliente na tela de Clientes." : ""),
        });
        return;
      }
      var resumoSync = d.totalSalvos > 0
        ? (d.totalEncontrados || 0) + " na conta · " + d.totalSalvos + " gravados ou atualizados." +
          (d.limitado ? " O limite por sincronização foi atingido; rode de novo para continuar." : "")
        : (d.mensagem || "Nenhum anúncio novo para gravar.");
      // Lista relida já (anúncios novos aparecem); a margem é relida de novo
      // quando o recálculo terminar.
      carregarResumo(); carregarAnuncios();
      if (modo !== "completo" && !(d.totalSalvos > 0)) {
        setSync({ fase: "ok", margem: "pulada", resumoSync: resumoSync });
        return;
      }
      setSync({ resumoSync: resumoSync });
      // Sem Base já sabida pela tela: o recálculo falharia com certeza.
      if (CUSTOS.base === null) {
        setSync({ fase: "aviso", margem: "sem_base", aviso: MSG_SEM_BASE });
        return;
      }
      recalcularMargemAposSync();
    });
  }

  // ===========================================================================
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
