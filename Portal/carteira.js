// Portal/carteira.js
//
// Carteira — a lista "qual Cliente/Operação vou trabalhar agora?"
// (MASTER_SPEC §10). Fábrica testável desde o primeiro commit (F1.1) —
// `createCarteira(options)` aceita `context`/`api`/`getSquads` injetados,
// o mesmo padrão de createVfShell/createVfContext/createVfApi. Isso é o
// que torna F1.2 ("troca o mock por dado real") uma troca de QUAL `api` é
// injetado no boot de produção, não uma reescrita: o caminho de produção
// (`bootProduction()`, fim do arquivo) já nasce falando com o backend
// real, e os testes/cenários (Portal/carteira-ui.test.js) exercitam essa
// mesma função de fábrica com fixtures via rede interceptada — nunca um
// segundo modo de operação dentro do bundle de produção.
//
// Regra de conteúdo (§10.1), dura: cada elemento visível precisa ajudar a
// ESCOLHER. Faturamento não ajuda a escolher; "sem base vinculada" ajuda.
//
// FONTE DE DADOS (C1, maratona Pessoa 1) — GET /me/portfolio, uma única
// requisição (server/routes/meRoutes.js + services/meService.js). Ela é a
// fonte AUTORITATIVA da carteira prevista no MASTER_SPEC §18.2 e resolve de
// uma vez o que antes exigia 1 + N chamadas: clientes autorizados, contas de
// CADA cliente (`listarContasDeClientesAtivos`, sem N+1), `squadId`/`squad`,
// `responsavelDireto`, `statusOperacional` e `pendencias`. Squad (D5/D7)
// continua sendo agrupamento e filtro, nunca um passo antes do cliente.
//
// QUEDA (ainda necessária, some em F6 quando /me/portfolio estiver
// confirmado em produção): se a chamada falhar por qualquer motivo, a tela
// volta exatamente ao comportamento anterior — lista via
// `context.getPortfolio()` (que o shell já carregou) e OPERAÇÕES sob demanda
// por linha visível (GET /clientes/:slug/contas, §10.5 nível A, com cache de
// sessão). Nenhuma linha inventa cardinalidade: 1 conta entra direto, 2+ só
// pelo chip, 0 mostra "Configurar →" (§10.4) — decidido só quando as contas
// daquela linha são conhecidas, pelos dois caminhos.
//
// SINCRONIZAÇÃO (D3, resolvido na Convergência #2): `/me/portfolio` passou a
// devolver `clientes[].ultimaSincronizacao` e `contas[].ultimaSync` REAIS
// (P2.6 — server/services/meService.js). Nada aqui precisou mudar: a tela
// sempre foi dirigida pelo dado, não por uma suposição sobre ele. A ordenação
// "Última sync" aparece quando ALGUM cliente tem o campo e some quando nenhum
// tem; um `?ordem=sync` colado numa URL sem dado cai para "Atenção primeiro";
// e o chip diz "sem dado de sync", nunca "nunca sincronizou" — porque `null`
// continua significando ausência de dado, não ausência de sincronização.
// Ver Squads_migration/VENFORCE_V3_F4_2_DEPENDENCIAS_P2_6.md.
//
// Destino ao entrar no contexto: Visão (MASTER_SPEC §11), a home operacional
// por Cliente+Operação (F3.3). Antes de F3 existir, este destino era
// fechamentos-api.html (a única tela operacional migrada até então).
//
// ES Module. Fábrica testável (mesmo padrão de createVfShell/createVfContext/
// createVfApi): tudo que toca o mundo externo é injetável.

import { vfContext, statusOperacao, rotuloExterno } from "./vf-context.js";
import { vfApi } from "./vf-api.js";
import { format as fmt } from "./vf-format.js";

const DESTINO_PADRAO = "visao.html";
const PREFETCH = 12; // §10.5 nível A — ~12 requisições no primeiro paint, não 120

function createProductionApi(api) {
  return {
    carteiraCompleta(opts) {
      return api.get("/me/portfolio", opts);
    },
    contasDoCliente(slug, opts) {
      return api
        .get(`/clientes/${encodeURIComponent(slug)}/contas`, opts)
        .catch((err) => ({ ok: false, code: err && err.code, erro: err && err.message }));
    },
  };
}

/* ── Adaptação do payload de /me/portfolio para o vocabulário da tela ─────
   Duas divergências de nome entre meService.js e o que statusOperacao()/
   chips() já leem em todo o resto do shell — traduzidas aqui, uma vez, em
   vez de espalhar `conta.baseVinculada || conta.base` por cinco lugares. */

export function adaptarContaDoPortfolio(conta) {
  if (!conta) return null;
  return {
    id: conta.id,
    marketplace: conta.marketplace,
    nome: conta.nome,
    ativo: conta.ativo !== false,
    external_account_id: conta.external_account_id,
    externalAccountLabel: conta.externalAccountLabel,
    // statusOperacao() prefere este campo quando ele existe (é o backend
    // quem confere expires_at); o objeto `grant` cru não vem neste payload.
    grantStatus: typeof conta.grantStatus === "string" ? conta.grantStatus : null,
    base: conta.baseVinculada ? { base_id: conta.baseVinculada.id, nome: conta.baseVinculada.nome } : null,
    ultimaSync: conta.ultimaSync || null,
  };
}

export function adaptarClienteDoPortfolio(c) {
  if (!c) return null;
  return {
    id: c.id,
    slug: c.slug,
    nome: c.nome,
    squadId: c.squadId != null ? c.squadId : null,
    squad: c.squad || null,
    responsavelDireto: c.responsavelDireto === true,
    statusOperacional: c.statusOperacional || null,
    // D3 — o campo passou a existir em /me/portfolio (P2.6). Derrubá-lo aqui
    // deixava `temDadoDeSync()` falso para sempre: a ordenação "Última sync"
    // nunca reapareceria, mesmo com o bloqueio de backend já resolvido.
    // `null` continua `null` — ausência de dado, não "nunca sincronizou".
    ultimaSincronizacao: c.ultimaSincronizacao || null,
    // meService devolve [{ tipo }]; o resto da tela (e o payload legado)
    // trabalha com uma lista de strings.
    pendencias: (c.pendencias || [])
      .map((p) => (typeof p === "string" ? p : p && p.tipo))
      .filter(Boolean),
    contas: (c.contas || []).map(adaptarContaDoPortfolio).filter(Boolean),
  };
}

export function createCarteira(options = {}) {
  const doc = options.document || (typeof document !== "undefined" ? document : null);
  if (!doc) throw new Error("carteira.js requer um DOM (document).");

  const ctxStore = options.context || vfContext;
  const api = options.api || createProductionApi(vfApi);
  const onNavigate = options.onNavigate || ((href) => { window.location.href = href; });

  let host = null;
  let unsubscribe = null;
  let observer = null;
  const contasPorCliente = {}; // cache de sessão — nunca refaz a mesma chamada
  const carregandoContas = {};

  /* fonte: "carregando" enquanto /me/portfolio está em voo · "rica" quando
     ele respondeu · "queda" quando falhou (aí vale context.getPortfolio() +
     contas sob demanda, o caminho anterior a C1, intacto). */
  let fonte = "carregando";
  let clientesRicos = [];
  let squadsDoPayload = [];

  const getSquads =
    options.getSquads ||
    (() => (squadsDoPayload.length ? squadsDoPayload : ctxStore.getSquads ? ctxStore.getSquads() : []));

  /* ── Squad principal (P2.9) ───────────────────────────────────────────
     DEFAULT DE UX, nunca autorização: ele ordena e rotula, jamais filtra e
     jamais restringe os outros squads. Só existe quando o backend o diz —
     `principal` por membership em /me/portfolio, `squadPrincipalId` em
     /me/context. Ordem do array, menor id e função no squad NÃO elegem
     ninguém: existem usuários reais multi-squad (Klayvert em 2/3/6, Micael
     em 1/5, Fernando em 1/4) cujo principal ainda depende de decisão
     humana, e preencher esse vazio sozinho seria inventar. */
  function squadPrincipalId() {
    const lista = getSquads();
    const marcados = lista.filter((s) => s && s.principal === true);
    // Dois principais é anomalia de dado: desempatar seria escolher pela
    // ordem do array, exatamente o que não pode acontecer. Sem principal.
    if (marcados.length === 1) return marcados[0].id;
    if (marcados.length > 1) return null;
    const doContexto = ctxStore.getSquadPrincipalId ? ctxStore.getSquadPrincipalId() : null;
    if (doContexto == null) return null;
    // Um principal que não está entre os squads em mão não rotula nada.
    return lista.some((s) => s && String(s.id) === String(doContexto)) ? doContexto : null;
  }

  /* ── Os squads que ESTA carteira precisa representar ───────────────────
     Duas listas diferentes carregam a palavra "squad" no payload
     (server/services/meService.js) e confundi-las era um bug real:

       · `squads[]`         → MEMBERSHIPS do usuário (squadsDoUsuario)
       · `clientes[].squad` → o squad REAL do cliente (squadsAtivosDeClientes)

     Elas não coincidem. Admin tem bypass de carteira e pode ter ZERO
     memberships enquanto enxerga clientes de vários squads; e o bucket
     "Squad 8 · Legado" recebe clientes antigos sem que ninguém seja membro
     dele. Agrupar/filtrar só pelas memberships fazia um squad com nome no
     payload virar "SEM SQUAD" e sumir do filtro.

     A união é aditiva e não inventa nada: memberships na ordem do backend
     (com o principal à frente, quando existir), e depois os squads que só
     aparecem nos clientes, por id. */
  function squadsDaCarteira(clientes) {
    const principal = squadPrincipalId();
    const membros = getSquads().filter((s) => s && s.id != null);
    const ordenados = principal == null
      ? membros.slice()
      : membros
          .filter((s) => String(s.id) === String(principal))
          .concat(membros.filter((s) => String(s.id) !== String(principal)));

    const vistos = new Set();
    const out = [];
    ordenados.forEach((s) => {
      const chave = String(s.id);
      if (vistos.has(chave)) return;
      vistos.add(chave);
      out.push({ id: s.id, nome: s.nome, principal: principal != null && String(s.id) === String(principal) });
    });

    const extras = [];
    (clientes || []).forEach((c) => {
      if (!c || c.squadId == null || vistos.has(String(c.squadId))) return;
      vistos.add(String(c.squadId));
      extras.push({
        id: c.squadId,
        // O nome vem do próprio cliente quando o payload rico o traz. Na
        // queda (/me/context não manda `squad`) sobra só o id — e "Squad #8"
        // é honesto: sabemos QUAL squad é, só não sabemos o nome dele.
        nome: (c.squad && c.squad.nome) || `Squad #${c.squadId}`,
        principal: false,
      });
    });
    extras.sort((a, b) => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id)));
    return out.concat(extras);
  }

  /* Cliente sem squad é ESTADO LEGÍTIMO enquanto SQUADS_ENFORCEMENT=OFF —
     é o banco de hoje. Ele ganha uma chave própria (nunca o id de outro
     grupo) para nunca ser misturado em silêncio com um squad real. */
  const SEM_SQUAD = " sem-squad";
  function chaveSquad(c) {
    return c && c.squadId != null ? String(c.squadId) : SEM_SQUAD;
  }

  let busca = "";
  let filtro = "todos"; // todos · pendencia · sem-operacao
  let ordem = "atencao"; // atencao · nome · sync · meus
  let squad = "todos";

  /* ── URL: busca/filtro/ordem são compartilháveis (§10.7) — nunca sessão. */
  function lerFiltrosDaUrl() {
    if (typeof window === "undefined" || !window.location) return;
    const q = new URLSearchParams(window.location.search);
    if (q.get("q")) busca = q.get("q");
    if (q.get("filtro")) filtro = q.get("filtro");
    if (q.get("ordem")) ordem = q.get("ordem");
    if (q.get("squad")) squad = q.get("squad");
  }

  function escreverFiltrosNaUrl() {
    if (typeof window === "undefined" || !window.history) return;
    const q = new URLSearchParams(window.location.search);
    busca ? q.set("q", busca) : q.delete("q");
    filtro !== "todos" ? q.set("filtro", filtro) : q.delete("filtro");
    ordem !== "atencao" ? q.set("ordem", ordem) : q.delete("ordem");
    squad !== "todos" ? q.set("squad", squad) : q.delete("squad");
    const qs = q.toString();
    const url = window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
    window.history.replaceState(null, "", url);
  }

  function montar(container) {
    host = container;
    lerFiltrosDaUrl();
    carregarCarteiraCompleta();
    unsubscribe = ctxStore.subscribe(render);
  }

  /* Uma requisição para a carteira inteira (C1). Falhou? `fonte` vira
     "queda" e o render seguinte usa exatamente o caminho anterior — a tela
     nunca fica sem lista por causa deste endpoint. */
  function carregarCarteiraCompleta() {
    if (!api.carteiraCompleta) {
      fonte = "queda";
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(() => api.carteiraCompleta())
      .then((resp) => {
        if (!resp || resp.ok === false || !Array.isArray(resp.clientes)) {
          fonte = "queda";
          return;
        }
        clientesRicos = resp.clientes.map(adaptarClienteDoPortfolio).filter(Boolean);
        squadsDoPayload = Array.isArray(resp.squads) ? resp.squads : [];
        // As contas já vieram: o cache de linha nasce cheio e nenhuma
        // chamada por cliente chega a sair (buscarContas devolve na hora).
        clientesRicos.forEach((c) => { contasPorCliente[c.slug] = { lista: c.contas }; });
        fonte = "rica";
      })
      .catch(() => {
        fonte = "queda";
      })
      .then(() => {
        if (host) render(ctxStore.getSnapshot());
      });
  }

  /* A lista exibida. Na queda é a mesma do shell (context.getPortfolio()),
     que já foi carregada no boot — zero requisição duplicada. */
  function clientesVisiveisNaFonte() {
    return fonte === "rica" ? clientesRicos : ctxStore.getPortfolio();
  }

  // "Última sync" só é oferecida quando ALGUM cliente tem o dado. O payload
  // de /me/portfolio não traz `ultimaSincronizacao` — oferecer uma ordenação
  // que não ordena nada seria pior do que não oferecê-la.
  function temDadoDeSync(clientes) {
    return (clientes || []).some((c) => !!c.ultimaSincronizacao);
  }

  function desmontar() {
    if (observer) observer.disconnect();
    if (unsubscribe) unsubscribe();
    host = null;
  }

  /* ── filtro/ordenação/agrupamento ────────────────────────────────────── */

  // §10.6 — com 1 squad NADA aparece: um filtro de uma opção só é ruído e um
  // cabeçalho único gasta uma linha para repetir o que vale para a lista
  // inteira. "1 squad" aqui é o que a CARTEIRA representa, não a contagem de
  // memberships: um usuário de um squad só que também enxerga clientes do
  // bucket legado tem, de fato, dois grupos na tela.
  function agrupandoPorSquad(clientes) {
    return squadsDaCarteira(clientes).length > 1 && squad === "todos";
  }

  function visiveis(clientes) {
    const q = fmt.normalizarBusca(busca);
    let lista = clientes.filter((c) => {
      if (q && fmt.normalizarBusca(`${c.nome} ${c.slug}`).indexOf(q) < 0) return false;
      if (squad !== "todos" && String(c.squadId) !== String(squad)) return false;
      if (filtro === "pendencia" && !(c.pendencias || []).length) return false;
      if (filtro === "sem-operacao" && c.ativo !== false && contasResumoCliente(c).contasAtivas !== 0) return false;
      return true;
    });

    const ordemStatus = { critico: 0, atencao: 1, pronto: 2 };
    const ordemSquad = {};
    squadsDaCarteira(clientes).forEach((s, i) => { ordemSquad[String(s.id)] = i; });
    const porSquad = agrupandoPorSquad(clientes);

    function dentroDoGrupo(a, b) {
      if (ordem === "nome") return a.nome.localeCompare(b.nome, "pt-BR");
      if (ordem === "sync") return String(b.ultimaSincronizacao || "").localeCompare(String(a.ultimaSincronizacao || ""));
      if (ordem === "meus") return (b.responsavelDireto ? 1 : 0) - (a.responsavelDireto ? 1 : 0) || a.nome.localeCompare(b.nome, "pt-BR");
      return (ordemStatus[a.statusOperacional] ?? 9) - (ordemStatus[b.statusOperacional] ?? 9) || a.nome.localeCompare(b.nome, "pt-BR");
    }

    // Sem squad fecha a lista: é o resíduo do enforcement OFF, não um squad.
    const FIM = Number.MAX_SAFE_INTEGER;
    function posicao(c) {
      const chave = chaveSquad(c);
      if (chave === SEM_SQUAD) return FIM;
      return ordemSquad[chave] ?? FIM - 1;
    }

    lista = lista.slice().sort((a, b) => {
      if (porSquad) {
        const da = posicao(a);
        const db = posicao(b);
        if (da !== db) return da - db; // squad primeiro; a ordenação escolhida vale DENTRO dele (M36)
      }
      return dentroDoGrupo(a, b);
    });
    return lista;
  }

  // "0 contas" só é conhecido depois que as contas daquela linha chegaram.
  // Antes disso, o filtro "Sem operação" trata a linha como indeterminada
  // (não some da lista à toa) — ver contasResumoCliente().
  function contasResumoCliente(c) {
    const cache = contasPorCliente[c.slug];
    if (!cache || cache.erro) return { contasAtivas: null };
    return { contasAtivas: cache.lista.filter((x) => x.ativo !== false).length };
  }

  /* ── render ──────────────────────────────────────────────────────────── */

  function render(snap) {
    if (!host) return;
    const estado = snap.state;
    const S = ctxStore.STATES;

    if (estado === S.BOOT) { renderCarregando(); return; }
    if (estado === S.PORTFOLIO_ERROR) { renderErro(snap.error); return; }
    // O shell já resolveu, mas a carteira completa ainda está em voo:
    // esqueleto, nunca uma lista pobre que muda debaixo do cursor logo em
    // seguida.
    if (fonte === "carregando") { renderCarregando(); return; }

    // NO_PORTFOLIO é decisão do store (mesma autorização, mesma origem);
    // uma divergência transitória entre as duas chamadas não pode virar
    // "clique numa linha que o contexto não conhece".
    const clientes = clientesVisiveisNaFonte();
    if (estado === S.NO_PORTFOLIO || !clientes.length) { renderVazio(false); return; }

    renderLista(clientes);
  }

  function cabecalho(descricaoHtml) {
    return (
      '<header class="vf-page-header vf-portfolio-header">' +
      '<div class="vf-page-header__main">' +
      '<p class="vf-page-header__eyebrow">Gestão global</p>' +
      '<h1 class="vf-page-header__title">Carteira</h1>' +
      `<p class="vf-page-header__description" aria-live="polite" id="cart-contagem">${descricaoHtml}</p>` +
      "</div>" +
      "</header>"
    );
  }

  function renderCarregando() {
    host.innerHTML =
      cabecalho("Carregando…") +
      '<div class="vf-portfolio-list">' +
      new Array(8)
        .fill('<div class="vf-portfolio-row is-skeleton"><span class="vf-skeleton vf-skeleton--title"></span><span class="vf-skeleton vf-skeleton--row"></span></div>')
        .join("") +
      "</div>";
  }

  function renderErro(erro) {
    host.innerHTML =
      cabecalho("—") +
      '<div class="vf-banner is-danger" role="alert"><div class="vf-banner__content">' +
      '<p class="vf-banner__title">Não foi possível carregar a carteira</p>' +
      `<p class="vf-banner__description">${fmt.escapeHTML((erro && erro.mensagem) || "Falha de rede ou do servidor.")}</p></div>` +
      '<div class="vf-banner__actions"><button type="button" class="vf-btn vf-btn--sm" id="cart-retry">Tentar novamente</button></div></div>';
    const btn = host.querySelector("#cart-retry");
    if (btn) btn.addEventListener("click", () => window.location.reload());
  }

  /* Carteira vazia é ESTADO, não erro (M12 já separa isso de
     PORTFOLIO_ERROR) — mas a explicação precisa ser verdadeira. Com
     SQUADS_ENFORCEMENT=OFF um usuário pode legitimamente não ter squad
     nenhum, e o admin tem bypass sem membership: para os dois, "nenhum
     cliente atribuído aos SEUS SQUADS" culpa um vínculo que não existe e
     manda procurar um coordenador de squad que não há. */
  function vazioDaCarteira() {
    return getSquads().length
      ? { titulo: "Nenhum cliente atribuído aos seus squads", descricao: "Fale com o coordenador do seu squad." }
      : { titulo: "Nenhum cliente na sua carteira", descricao: "Fale com o seu coordenador para receber acesso a uma carteira." };
  }

  const VAZIO_DE_FILTRO = { titulo: "Nenhum cliente para os filtros atuais", descricao: "Ajuste a busca ou os filtros." };

  function htmlVazio(estado) {
    return (
      '<div class="vf-empty"><p class="vf-empty__title">' +
      fmt.escapeHTML(estado.titulo) +
      '</p><p class="vf-empty__description">' +
      fmt.escapeHTML(estado.descricao) +
      "</p></div>"
    );
  }

  function renderVazio(comFiltro) {
    host.innerHTML = cabecalho("0 clientes") + htmlVazio(comFiltro ? VAZIO_DE_FILTRO : vazioDaCarteira());
  }

  function renderLista(clientes) {
    const squads = squadsDaCarteira(clientes);
    // Um `?squad=` colado numa URL (ou herdado de outro usuário) que não
    // corresponde a nenhum squad desta carteira deixava a lista vazia com o
    // seletor exibindo "Todos" — filtro invisível, o pior dos dois mundos.
    // Mesmo tratamento já dado a `?ordem=sync` sem dado de sync.
    if (squad !== "todos" && !squads.some((s) => String(s.id) === String(squad))) squad = "todos";
    const comAtencao = clientes.filter((c) => (c.pendencias || []).length).length;
    const descricao =
      `${clientes.length} cliente${clientes.length === 1 ? "" : "s"}` +
      (comAtencao ? ` · ${comAtencao} precisa${comAtencao === 1 ? "" : "m"} de atenção` : "");

    // Um `?ordem=sync` colado numa URL não pode deixar a tela numa
    // ordenação que a fonte atual não sabe executar.
    const comSync = temDadoDeSync(clientes);
    if (ordem === "sync" && !comSync) ordem = "atencao";

    host.innerHTML =
      cabecalho(descricao) +
      barraFiltros(squads, comSync) +
      '<div id="cart-lista" class="vf-portfolio-list"></div>';

    const buscaEl = host.querySelector("#cart-busca");
    buscaEl.addEventListener("input", () => {
      busca = buscaEl.value;
      escreverFiltrosNaUrl();
      renderCorpo(clientes);
      atualizarContagem(clientes);
    });
    if (clientes.length > 12 && !busca) setTimeout(() => buscaEl.focus(), 0);

    host.querySelectorAll("[data-filtro]").forEach((b) => {
      b.addEventListener("click", () => { filtro = b.dataset.filtro; escreverFiltrosNaUrl(); renderLista(clientes); });
    });
    const selOrdem = host.querySelector("#cart-ordem");
    if (selOrdem) selOrdem.addEventListener("change", () => { ordem = selOrdem.value; escreverFiltrosNaUrl(); renderCorpo(clientes); });
    const selSquad = host.querySelector("#cart-squad");
    if (selSquad) selSquad.addEventListener("change", () => { squad = selSquad.value; escreverFiltrosNaUrl(); renderLista(clientes); });

    renderCorpo(clientes);
  }

  function barraFiltros(squads, comSync) {
    const filtros = [["todos", "Todos"], ["pendencia", "Com pendência"], ["sem-operacao", "Sem operação"]];
    const seletorSquad =
      squads.length > 1
        ? '<label class="vf-toolbar__field">Squad <select id="cart-squad" class="vf-select vf-select--sm">' +
          '<option value="todos">Todos</option>' +
          squads
            .map((s) => {
              // O principal é IDENTIFICADO, não pré-selecionado: nascer
              // filtrado esconderia carteira autorizada sem dizer que
              // escondeu (ver a decisão aberta sobre filtro por principal).
              const rotulo = s.nome + (s.principal ? " (principal)" : "");
              return `<option value="${fmt.escapeHTML(String(s.id))}"${String(squad) === String(s.id) ? " selected" : ""}>${fmt.escapeHTML(rotulo)}</option>`;
            })
            .join("") +
          "</select></label>"
        : "";
    return (
      '<div class="vf-toolbar vf-portfolio-toolbar">' +
      `<input id="cart-busca" class="vf-input vf-input--sm" type="search" placeholder="Buscar cliente…  (/)" aria-label="Buscar cliente" value="${fmt.escapeHTML(busca)}">` +
      '<div class="vf-filter-group" role="group" aria-label="Filtros">' +
      filtros
        .map(([id, label]) => `<button type="button" class="vf-filter-chip${filtro === id ? " is-active" : ""}" data-filtro="${id}" aria-pressed="${filtro === id}">${label}</button>`)
        .join("") +
      "</div>" +
      '<div class="vf-cluster">' +
      seletorSquad +
      '<label class="vf-toolbar__field">Ordenar <select id="cart-ordem" class="vf-select vf-select--sm">' +
      `<option value="atencao"${ordem === "atencao" ? " selected" : ""}>Atenção primeiro</option>` +
      `<option value="nome"${ordem === "nome" ? " selected" : ""}>Nome A→Z</option>` +
      (comSync ? `<option value="sync"${ordem === "sync" ? " selected" : ""}>Última sync</option>` : "") +
      `<option value="meus"${ordem === "meus" ? " selected" : ""}>Meus clientes primeiro</option>` +
      "</select></label></div></div>"
    );
  }

  function atualizarContagem(clientes) {
    const el = host.querySelector("#cart-contagem");
    if (!el) return;
    const n = visiveis(clientes).length;
    el.textContent = `${n} cliente${n === 1 ? "" : "s"}` + (busca ? ` para «${busca}»` : "");
  }

  function renderCorpo(clientes) {
    const box = host.querySelector("#cart-lista");
    if (!box) return;
    if (observer) { observer.disconnect(); observer = null; }

    const lista = visiveis(clientes);
    if (!lista.length) {
      // Um squad autorizado sem cliente visível não é falta de acesso nem
      // erro: é um filtro sem resultado, e é o que a tela precisa dizer.
      box.innerHTML = htmlVazio(clientes.length ? VAZIO_DE_FILTRO : vazioDaCarteira());
      return;
    }

    const squads = squadsDaCarteira(clientes);
    const agrupar = agrupandoPorSquad(clientes);
    let html = "";
    // `null` e não SEM_SQUAD: a primeira linha da lista TEM de abrir um
    // grupo. Com o valor inicial igual à chave do primeiro cliente, uma
    // carteira que começa por clientes sem squad ficava sem o cabeçalho
    // dele — e os clientes apareciam soltos, como se pertencessem ao
    // grupo seguinte.
    let chaveAtual = null;

    lista.forEach((c) => {
      const chave = chaveSquad(c);
      if (agrupar && chave !== chaveAtual) {
        chaveAtual = chave;
        const s = chave === SEM_SQUAD ? null : squads.find((x) => String(x.id) === chave);
        const n = lista.filter((x) => chaveSquad(x) === chave).length;
        const rotulo = chave === SEM_SQUAD ? "SEM SQUAD" : (s ? s.nome : `Squad #${chave}`).toUpperCase();
        // "Principal" INFORMA, nunca restringe: o grupo continua sendo um
        // grupo como os outros, com os mesmos clientes e o mesmo acesso.
        const marca = s && s.principal ? ' <span class="vf-portfolio-group__tag">principal</span>' : "";
        html += `<h2 class="vf-portfolio-group">${fmt.escapeHTML(rotulo)}${marca} <small>${n} cliente${n === 1 ? "" : "s"}</small></h2>`;
      }
      html += linhaCliente(c);
    });
    box.innerHTML = `<ul class="vf-portfolio-ul" role="list">${html}</ul>`;

    wireLinhas(box);
    observarVisiveis(box);
  }

  function rotuloPendencia(p) {
    // Só o que o payload REALMENTE tem hoje (§10.8). "Fechamento pendente"
    // é CONTRATO NECESSÁRIO e por isso não é renderizado.
    const mapa = { sem_grant: "Mercado Livre não conectado", sem_base: "Base não vinculada" };
    return fmt.escapeHTML(mapa[p] || p);
  }

  function linhaCliente(c) {
    const pend = c.pendencias || [];
    const cache = contasPorCliente[c.slug];
    const ativas = cache && !cache.erro ? cache.lista.filter((x) => x.ativo !== false) : null;
    const umaConta = ativas && ativas.length === 1;
    const semConta = ativas && ativas.length === 0;

    const alerta = pend.length
      ? `<span class="vf-status is-warning"><span aria-hidden="true"></span>${pend.length} alerta${pend.length === 1 ? "" : "s"}</span>`
      : semConta
      ? '<span class="vf-status"><span aria-hidden="true"></span>sem operação</span>'
      : "";

    // 1 conta ativa: a linha inteira é o alvo. 2+: o nome vira <h3> e só os
    // chips são acionáveis (§10.4/§10.10) — decidido só quando `ativas` é
    // conhecido; antes disso o nome não é clicável (evita "clicou, não
    // aconteceu nada" enquanto a operação ainda carrega).
    const titulo = umaConta
      ? `<button type="button" class="vf-portfolio-row__name is-clickable" data-entrar="${fmt.escapeHTML(c.slug)}">${fmt.escapeHTML(c.nome)}</button>`
      : `<h3 class="vf-portfolio-row__name">${fmt.escapeHTML(c.nome)}</h3>`;

    const rodape = semConta
      ? '<p class="vf-portfolio-row__foot">Nenhuma conta configurada · <a href="clientes.html">Configurar →</a></p>'
      : pend.length
      ? `<p class="vf-portfolio-row__foot">${pend.map(rotuloPendencia).join(" · ")}</p>`
      : "";

    return (
      `<li class="vf-portfolio-row" data-slug="${fmt.escapeHTML(c.slug)}">` +
      '<div class="vf-portfolio-row__head">' +
      titulo +
      (c.responsavelDireto ? '<span class="vf-tag">responsável: você</span>' : "") +
      '<span class="vf-portfolio-row__spacer"></span>' +
      alerta +
      "</div>" +
      `<div class="vf-portfolio-row__ops" data-ops="${fmt.escapeHTML(c.slug)}">${chips(c)}</div>` +
      rodape +
      "</li>"
    );
  }

  function chips(c) {
    const cache = contasPorCliente[c.slug];
    if (!cache) {
      // Skeleton neutro — sem saber ainda quantas contas existem, não dá
      // para prometer uma largura fixa por conta (diferente do resto do
      // shell, que já conhece a cardinalidade pelo contexto ativo).
      return '<span class="vf-op-chip is-skeleton"><span class="vf-skeleton vf-skeleton--row"></span></span>';
    }
    if (cache.erro) {
      return (
        '<span class="vf-op-chip is-error">não foi possível carregar as operações · ' +
        `<button type="button" class="vf-linklike" data-recarregar="${fmt.escapeHTML(c.slug)}">tentar de novo</button></span>`
      );
    }
    const ativas = cache.lista.filter((x) => x.ativo !== false);
    if (!ativas.length) return "";
    return ativas
      .map((conta) => {
        const st = statusOperacao(conta);
        const sub = [conta.base ? "base ok" : "sem base"];
        // "nunca sincronizou" seria uma AFIRMAÇÃO — e nenhum dos dois
        // payloads de conta (GET /clientes/:slug/contas não tem o campo;
        // /me/portfolio manda `null` fixo) sabe disso. Ausência é ausência.
        sub.push(conta.ultimaSync ? fmt.desde(conta.ultimaSync) : "sem dado de sync");
        return (
          `<button type="button" class="vf-op-chip" data-conta="${conta.id}" data-cliente="${fmt.escapeHTML(c.slug)}">` +
          `<span class="vf-op-chip__top"><span class="vf-status is-${st.tone}"><span aria-hidden="true"></span>` +
          `<span class="vf-visually-hidden">${fmt.escapeHTML(st.label)}</span></span>${fmt.escapeHTML(conta.nome)}</span>` +
          `<span class="vf-op-chip__label">${fmt.escapeHTML(rotuloExterno(conta))}</span>` +
          `<span class="vf-op-chip__meta">${fmt.escapeHTML(sub.join(" · "))}</span>` +
          "</button>"
        );
      })
      .join("");
  }

  function wireLinhas(box) {
    box.querySelectorAll("[data-entrar]").forEach((b) => {
      b.addEventListener("click", () => entrar(b.dataset.entrar, null));
    });
    box.querySelectorAll("[data-conta]").forEach((b) => {
      b.addEventListener("click", () => entrar(b.dataset.cliente, Number(b.dataset.conta)));
    });
    box.querySelectorAll("[data-recarregar]").forEach((b) => {
      b.addEventListener("click", () => {
        delete contasPorCliente[b.dataset.recarregar];
        buscarContas(b.dataset.recarregar);
      });
    });
    // Navegação vertical entre clientes (roving) — §10.10
    box.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const linhas = Array.prototype.slice.call(box.querySelectorAll(".vf-portfolio-row"));
      const atual = doc.activeElement && doc.activeElement.closest(".vf-portfolio-row");
      const i = linhas.indexOf(atual);
      const alvo = linhas[e.key === "ArrowDown" ? i + 1 : i - 1];
      if (!alvo) return;
      e.preventDefault();
      const foco = alvo.querySelector("[data-entrar], [data-conta]");
      if (foco) foco.focus();
    });
  }

  /* Carga sob demanda (§10.5 nível A): (a) prefetch imediato das primeiras
     PREFETCH linhas — não depende de paint nem do observer disparar, uma
     linha já na dobra não pode ficar em skeleton à toa; (b)
     IntersectionObserver para o resto, conforme o operador rola. */
  function observarVisiveis(box) {
    const nos = Array.prototype.slice.call(box.querySelectorAll("[data-ops]"));
    nos.slice(0, PREFETCH).forEach((n) => buscarContas(n.dataset.ops));

    if (typeof IntersectionObserver === "undefined") {
      nos.slice(PREFETCH).forEach((n) => buscarContas(n.dataset.ops));
      return;
    }
    observer = new IntersectionObserver((entradas) => {
      entradas.forEach((e) => {
        if (!e.isIntersecting) return;
        buscarContas(e.target.dataset.ops);
        observer.unobserve(e.target);
      });
    }, { rootMargin: "160px" });
    nos.slice(PREFETCH).forEach((n) => observer.observe(n));
  }

  function dedupe(lista) {
    const vistos = new Set();
    const out = [];
    (lista || []).forEach((c) => { if (c && !vistos.has(c.id)) { vistos.add(c.id); out.push(c); } });
    return out;
  }

  function buscarContas(slug) {
    if (!slug || contasPorCliente[slug] || carregandoContas[slug]) return;
    carregandoContas[slug] = true;
    api
      .contasDoCliente(slug)
      .then((resp) => {
        carregandoContas[slug] = false;
        // Dedupe aqui também: o fan-out de listarContasDoCliente
        // transformaria uma conta em duas (I6) — a Carteira também conta
        // operações, não só o seletor do shell.
        contasPorCliente[slug] = resp && resp.ok !== false ? { lista: dedupe(resp.contas || []) } : { erro: true };
        pintarLinha(slug);
      })
      .catch(() => {
        carregandoContas[slug] = false;
        contasPorCliente[slug] = { erro: true };
        pintarLinha(slug);
      });
  }

  function pintarLinha(slug) {
    if (!host) return;
    const antigo = host.querySelector(`.vf-portfolio-row[data-slug="${cssEscape(slug)}"]`);
    if (!antigo) return;
    const c = clientesVisiveisNaFonte().find((x) => x.slug === slug);
    if (!c) return;
    const tpl = doc.createElement("template");
    tpl.innerHTML = linhaCliente(c).trim();
    const novo = tpl.content.firstElementChild;
    antigo.replaceWith(novo);
    wireLinhas(novo.parentElement || host.querySelector("#cart-lista"));
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  /* Entrar no contexto a partir da Carteira. A conta só pode ser fixada
     DEPOIS de as contas carregarem no store — ele aplica a cardinalidade
     primeiro e só então aceita setConta (I2/I3). Por isso a espera é por
     estado, não por timeout — mesmo padrão do protótipo. */
  function entrar(slug, contaId) {
    let primeiro = true;
    const S = ctxStore.STATES;
    const un = ctxStore.subscribe((snap) => {
      if (primeiro) { primeiro = false; return; } // subscribe entrega o snapshot atual na hora — não conta
      if (snap.state === S.READY) {
        un();
        if (contaId && snap.context.clienteContaId !== contaId) ctxStore.setConta(contaId);
        onNavigate(destino(snap.context));
        return;
      }
      if (snap.state === S.ACCOUNT_CHOICE_REQUIRED) {
        un();
        // Clicou num chip: a escolha já foi explícita, é só fixá-la —
        // setConta() é síncrono aqui (as contas já estão carregadas), então
        // navegar logo em seguida já leva o contexto certo.
        if (contaId) ctxStore.setConta(contaId);
        onNavigate(destino(ctxStore.getContext()));
        return;
      }
      if (snap.state === S.NO_ACTIVE_ACCOUNT) { un(); onNavigate(destino(snap.context)); return; }
      if (snap.state === S.FORBIDDEN || snap.state === S.INVALID_CLIENT) un();
    });
    ctxStore.setCliente(slug);
  }

  function destino(ctx) {
    const qs = new URLSearchParams();
    qs.set("shell", "v3");
    if (ctx && ctx.clienteSlug) qs.set("cliente", ctx.clienteSlug);
    if (ctx && ctx.clienteContaId) qs.set("conta", String(ctx.clienteContaId));
    return `${DESTINO_PADRAO}?${qs.toString()}`;
  }

  function atalhoBusca(e) {
    if (e.key !== "/" || !host) return;
    const alvo = e.target;
    if (alvo && (alvo.tagName === "INPUT" || alvo.tagName === "TEXTAREA" || alvo.tagName === "SELECT")) return;
    const buscaEl = host.querySelector("#cart-busca");
    if (buscaEl) { e.preventDefault(); buscaEl.focus(); }
  }
  doc.addEventListener("keydown", atalhoBusca);

  return { montar, desmontar };
}

function bootProduction() {
  if (typeof document === "undefined") return null;
  const root = document.getElementById("carteira-root");
  if (!root) return null;
  const carteira = createCarteira({});
  carteira.montar(root);
  return carteira;
}

export const carteira = typeof document !== "undefined" ? bootProduction() : null;

if (typeof window !== "undefined") {
  window.VF = window.VF || {};
  window.VF.carteira = carteira;
}
