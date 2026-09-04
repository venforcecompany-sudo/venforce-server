// Portal/vf-shell.js
//
// Shell V3 (F0.5) — MASTER_SPEC §5 (contrato do shell), §9 (sidebar
// completa), §14 (marketplace × capacidade), §19 (responsividade).
//
// Responsabilidades (e só estas):
//   · ler data-vf-scope / data-vf-module / data-vf-marketplaces / data-vf-capability
//   · montar a sidebar de coluna única (logo, contexto, módulos, gestão
//     global, administração, rodapé)
//   · montar os dois dropdowns (Cliente, Operação) e refletir vf-context
//   · aplicar o gating (esconder `main`, mostrar o painel de estado)
//   · reparentar o bloco de contexto em telas estreitas (§19.1) — um nó só
//   · publicar window.VF.shell — espelho, nunca fonte
//
// NÃO decide cardinalidade (vf-context.js, e só lá — R8), não decide acesso
// (403 é estado, não filtro — I10), não busca dado de módulo. Portado de
// Squads_migration/preview_v3/js/vf-shell.js, adaptado para: (a) ES module
// real (vf-context.js exporta statusOperacao/rotuloExterno diretamente, sem
// namespace `contextFactory`); (b) wiring real com vf-api.js — o rascunho
// usava um mock; (c) fabricação do DOM da página migrada (o rascunho tinha
// mount points fixos no harness do protótipo; aqui a página real só troca 3
// atributos, então o shell precisa construir `.vf-shell` em volta do
// conteúdo existente, sem reescrevê-lo).
//
// ES Module. Espelhado em window.VF.shell.

import { vfContext } from "./vf-context.js";
import { vfApi } from "./vf-api.js";
import { format as fmt } from "./vf-format.js";
import { statusOperacao, rotuloExterno } from "./vf-context.js";

const TOKEN_KEY = "vf-token";
const USER_KEY = "vf-user";
const COLLAPSE_KEY = "vf-sidebar-collapsed"; // preferência de UI (§9.2) — localStorage é correto AQUI

/* ── Modelo de navegação (MASTER_SPEC §9.5) ──────────────────────────────
   30 links em 5 grupos incoerentes → 8 módulos contextuais + globais +
   admin. `rota: null` (nenhum módulo usa isso hoje) continua suportado pelo
   render() abaixo — vira item desabilitado com "ainda não disponível nesta
   versão", nunca link quebrado. `marketplaces` ausente = disponível em
   todos os marketplaces. */
export const MODULOS = [
  { id: "visao", label: "Visão", rota: "visao.html" },
  // Recuperação de navegação (VENFORCE_AUDITORIA_FORENSE_RECUPERACAO_TELAS.md
  // §8) — cliente-360-react.html é a Cliente 360 V2 REAL (não confundir com
  // o bundle Vue órfão `cliente-360-v2.html`, sem fonte, nunca linkado em
  // nenhuma origem). A própria página documenta o contrato de deep-link em
  // frontend-react/src/hooks/useCliente360.js:8-9 — por isso `linkParams`
  // manda `slug`/`marketplace`, nunca `cliente`/`conta` (semântica
  // diferente, o hook nem lê esses nomes).
  { id: "cliente-360-v2", label: "Cliente 360 V2", rota: "cliente-360-react.html", linkParams: linkParamsCliente360V2 },
  // Convergência #4 §15 — Financeiro V3 é o destino para MELI/Shopee (D-8/
  // D-9 não afetam isto: contrato já existe para os dois hoje). Marketplace
  // não suportado por V3 (TikTok legado) ou sem conta resolvida cai em
  // `rota` (o legado) — nunca fica sem destino algum. Ver resolverRota().
  { id: "financeiro", label: "Financeiro", rota: "financeiro.html", rotaPorMarketplace: { meli: "financeiro-v3.html", shopee: "financeiro-v3.html" } },
  { id: "central-vendas", label: "Central de Vendas", rota: "fechamentos-api.html" },
  { id: "ads", label: "Ads", rota: "ads.html", marketplaces: ["meli"] },
  { id: "anuncios", label: "Anúncios", rota: "anuncios-meli.html", marketplaces: ["meli"] },
  // F2.3 — Motor de Margem só resolve base MELI (contextoPrecificacaoService);
  // achado lendo o código real, não previsto no MASTER_SPEC original.
  { id: "margem", label: "Margem", rota: "central-margem.html", marketplaces: ["meli"] },
  { id: "diagnosticos", label: "Diagnósticos", rota: "diagnostico-inicial.html" },
  { id: "automacoes", label: "Automações", rota: "automacoes.html", marketplaces: ["meli"] },
];

export const GLOBAIS = [
  { id: "carteira", label: "Carteira", rota: "carteira.html" },
  { id: "bases", label: "Bases", rota: "bases.html" },
  // Recuperação de navegação (auditoria forense, seção 6.2/15) — estas 5
  // telas têm arquivo, backend e lógica ativos em ATUAL; só perderam a
  // entrada de menu quando o Shell V3 chegou. Nenhuma delas lê `cliente`/
  // `conta`/`periodo` da URL (cada uma tem seletor de cliente próprio, na
  // própria página) — por isso GLOBAIS, não MODULOS: exigir cliente+operação
  // escolhidos na Carteira antes de abri-las seria uma trava nova que essas
  // páginas nunca tiveram.
  { id: "cliente-operacao", label: "Cliente Operação", rota: "cliente-operacao.html" },
  { id: "cliente-360", label: "Cliente 360", rota: "cliente-360.html" },
  { id: "promocoes-ml", label: "Promoções ML", rota: "promocoes-retorno.html" },
  // Central Full lê `clienteContaId` (não `conta`) quando presente — ver
  // linkParamsCentralFull. Sem ele, a própria página mostra seu seletor de
  // cliente/conta (fallback já existente, não uma tela quebrada).
  { id: "central-full", label: "Central Full", rota: "full-gestao.html", linkParams: linkParamsCentralFull },
  { id: "curva-abc", label: "Curva ABC", rota: "fechamento.html" },
  { id: "clientes-contas", label: "Clientes e Contas", rota: "clientes.html" },
  { id: "ferramentas", label: "Ferramentas", rota: "ferramentas.html" },
  // 05a67f1 migrou relatorios.html para o Shell V3 sem entrada na sidebar
  // "de propósito", para não decidir arquitetura de navegação sozinho — o
  // MASTER_SPEC (§ "absorver → Financeiro › Relatórios") ainda planeja isto
  // como aba do Financeiro, não como item próprio. Enquanto essa absorção
  // não existe, o Hub é uma capacidade migrada e funcional sem NENHUM
  // caminho de navegação primário (só chegava por link direto de
  // automacoes.js) — bug de produção. Reintroduzido aqui como global
  // (mesmo escopo de bases.html, decidido em 05a67f1); remover quando a
  // aba Financeiro › Relatórios existir de verdade.
  { id: "relatorios", label: "Relatórios", rota: "relatorios.html" },
  { id: "pessoas", label: "Pessoas", rota: "usuarios.html" },
  { id: "guia", label: "Guia do Vendedor", rota: "guia-vendedor.html" },
];

export const ADMIN = [
  // Tokens ML era `adminOnly` em layout.js (e ml-tokens.js:12 já redireciona
  // sozinho quem não é admin) — recuperado só aqui, no grupo Administração,
  // para preservar exatamente a mesma restrição de acesso que já existia.
  // NENHUMA lógica de Tokens ML foi tocada (achado de segurança da auditoria,
  // seção 11: a versão ATUAL já corrigiu o vazamento de access_token/
  // refresh_token em texto puro — não regredir isso nunca).
  { id: "ml-tokens", label: "Tokens ML", rota: "ml-tokens.html" },
  // Criação Anúncios ML era `adminOnly` em layout.js — mesma regra aqui.
  { id: "criar-anuncios-meli", label: "Criação Anúncios ML", rota: "criar-anuncios-meli.html" },
  { id: "atividade", label: "Atividade", rota: "atividade.html" },
  { id: "control-center", label: "Control Center", rota: "control-center.html" },
  { id: "callbacks", label: "Callbacks", rota: "callbacks.html" },
  { id: "debug", label: "Debug Financeiro", rota: "financeiro-debug.html" },
  { id: "lab", label: "Laboratório UI", rota: "design-system-lab.html" },
];

export const MARKETPLACE_LABEL = { meli: "Mercado Livre", shopee: "Shopee", tiktok: "TikTok Shop" };

/* ── linkParams — recuperação de navegação (VENFORCE_AUDITORIA_FORENSE_
   RECUPERACAO_TELAS.md) ─────────────────────────────────────────────────
   Válvula de escape usada por buildHref() para módulos cuja página de
   destino NÃO fala o contrato padrão cliente/conta/periodo. Cada função só
   lê o campo que a página de destino documenta/realmente consome — nunca
   inventa parâmetro novo nem reaproveita um nome com outra semântica. */

// frontend-react/src/hooks/useCliente360.js:8-9 documenta o contrato:
// "cliente-360-react.html?slug=cliente-x&competencia=...". `marketplace`
// só vai junto quando o Shell já resolveu a operação (meta real, não
// GLOBAIS/ADMIN) — nunca um valor chutado.
function linkParamsCliente360V2(ctx, meta) {
  if (!ctx || !ctx.clienteSlug) return null;
  return { slug: ctx.clienteSlug, marketplace: meta && meta.marketplace ? meta.marketplace : undefined };
}

// full-gestao.html lê só `clienteContaId` (confirmado no bundle: nenhuma
// outra chave de querystring é lida). Sem ele, a própria página mostra o
// seletor de cliente/conta dela — por isso null aqui não é regressão.
function linkParamsCentralFull(ctx) {
  if (!ctx || !ctx.clienteContaId) return null;
  return { clienteContaId: ctx.clienteContaId };
}

/* ── Estados (MASTER_SPEC §7.2) — tabela única; nenhuma lógica duplicada. */
const ESTADOS = {
  BOOT: { tom: "info", titulo: "Carregando…", texto: "Resolvendo a sua carteira." },
  PORTFOLIO_ERROR: {
    tom: "danger",
    titulo: "Não foi possível carregar a sua carteira",
    texto: "Isto é uma falha técnica, não uma carteira vazia.",
    acao: { label: "Tentar novamente", cmd: "retry" },
    alerta: true,
  },
  // O texto depende de o usuário TER squad: com SQUADS_ENFORCEMENT=OFF ele
  // pode legitimamente não ter nenhum, e o admin tem bypass sem membership.
  // Para os dois, "atribuído aos SEUS SQUADS" culpa um vínculo inexistente e
  // manda procurar um coordenador de squad que não há — ver textoNoPortfolio().
  NO_PORTFOLIO: {
    tom: "info",
    titulo: "Nenhum cliente atribuído aos seus squads",
    texto: "Fale com o coordenador do seu squad para receber acesso a uma carteira.",
  },
  NO_CLIENT: {
    tom: "info",
    titulo: "Selecione um cliente",
    texto: "Este módulo trabalha dentro de uma operação. Escolha o cliente e a operação na Carteira.",
    acao: { label: "Ir para a Carteira", cmd: "carteira" },
  },
  RESOLVING_CLIENT: { tom: "info", titulo: "Validando o cliente…", texto: "Conferindo se ele está na sua carteira." },
  INVALID_CLIENT: {
    tom: "warning",
    titulo: "Cliente indisponível",
    texto: "O cliente pedido não está disponível na sua carteira.",
    acao: { label: "Ver Carteira", cmd: "carteira" },
  },
  FORBIDDEN: {
    tom: "danger",
    titulo: "Você não tem acesso a este cliente",
    texto: "O contexto foi descartado. Isto é uma falha de autorização — diferente de uma integração caída.",
    acao: { label: "Voltar à Carteira", cmd: "carteira" },
    alerta: true,
  },
  RESOLVING_ACCOUNTS: { tom: "info", titulo: "Carregando operações…", texto: "Buscando as contas deste cliente." },
  NO_ACTIVE_ACCOUNT: {
    tom: "warning",
    titulo: "Este cliente ainda não tem operação configurada",
    texto: "Sem uma conta de marketplace ativa, os módulos operacionais não têm de onde ler.",
    acao: { label: "Configurar operação →", cmd: "clientes-contas" },
  },
  ACCOUNT_CHOICE_REQUIRED: {
    tom: "warning",
    titulo: "Escolha a operação",
    texto: "Este cliente tem mais de uma operação ativa. Nenhuma é escolhida automaticamente — é o que impede ler a loja errada.",
    acao: { label: "Escolher operação", cmd: "abrir-operacao" },
  },
  INVALID_ACCOUNT: {
    tom: "warning",
    titulo: "Operação inválida",
    texto: "A operação pedida não pertence a este cliente.",
    acao: { label: "Escolher operação", cmd: "abrir-operacao" },
  },
  ACCOUNT_INACTIVE: {
    tom: "warning",
    titulo: "Operação desativada",
    texto: "A operação que estava no contexto foi desativada. O cliente e a rota foram preservados.",
    acao: { label: "Escolher outra operação", cmd: "abrir-operacao" },
  },
  READY: null,
};

function el(tag, cls, html) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

function safeLocalStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/* ── Adaptador padrão de API (real) para vf-context.init({ api }) ────────
   C1 (maratona Pessoa 1) — a carteira do shell passa a vir de
   GET /me/context (server/routes/meRoutes.js + services/meService.js), a
   fonte AUTORITATIVA por Squad prevista no MASTER_SPEC §18.2. Ela traz três
   coisas que o endpoint anterior não tinha: `squads`, `squadPrincipalId` e
   `contasAtivas` por cliente (o sub-rótulo "· N operações" do dropdown de
   Cliente existia no código e nunca aparecia, porque o payload antigo não
   tem esse campo).

   /operacao/cliente-360/clientes continua como QUEDA, e só para um caso: o
   servidor implantado ainda não conhece /me (404). Qualquer outra falha —
   500, rede, timeout — propaga como PORTFOLIO_ERROR, porque mascarar um 500
   atrás de um segundo endpoint esconderia um servidor doente atrás de uma
   carteira que "quase" funciona. Os dois resolvem a mesma carteira
   (resolvePortfolioClientes), então o fallback não muda quem o usuário vê,
   só empobrece o payload. Remoção: F6, depois de confirmado em produção. */
function createProductionContextApi(api) {
  const comoErro = (err) => ({ ok: false, code: err && err.code, erro: err && err.message });
  return {
    carteira: () =>
      api.get("/me/context").catch((err) => {
        if (err && err.status === 404) {
          return api.get("/operacao/cliente-360/clientes").catch(comoErro);
        }
        return comoErro(err);
      }),
    contasDoCliente: (ref, opts) =>
      api
        .get(`/clientes/${encodeURIComponent(ref)}/contas`, opts)
        .catch((err) => {
          if (err && err.name === "VfApiError" && err.status === 0 && err.code === "REDE") throw err; // deixa a rede real propagar (AbortError já é null)
          return comoErro(err);
        }),
  };
}

function readUser() {
  const storage = safeLocalStorage();
  try {
    const raw = storage ? storage.getItem(USER_KEY) : null;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function hasToken() {
  const storage = safeLocalStorage();
  try {
    return !!(storage && storage.getItem(TOKEN_KEY));
  } catch {
    return false;
  }
}

/* ── Fabricação do DOM em volta do conteúdo existente (migração mínima) ──
   A página migrada NÃO ganha mount points novos no HTML — o shell constrói
   `.vf-shell` (MASTER_SPEC §16.3) e move o conteúdo atual para
   `.vf-shell__main`, sem alterar as classes internas dele. */
function buildShellDom() {
  if (document.querySelector(".vf-sidebar")) return null; // layout.js já montado — nunca junto (§5.3)
  const existing = document.querySelector(".vf-shell");
  if (existing) {
    return {
      root: existing,
      sidebar: existing.querySelector(".vf-shell__sidebar"),
      contextbar: existing.querySelector(".vf-shell__contextbar"),
      stateHost: existing.querySelector(".vf-shell__state"),
      main: existing.querySelector(".vf-shell__main"),
    };
  }

  const children = Array.from(document.body.childNodes);

  const root = el("div", "vf-shell");
  const sidebar = el("aside", "vf-shell__sidebar");
  sidebar.id = "vf-shell-sidebar";

  const bodyCol = el("div", "vf-shell__body");
  const contextbar = el("div", "vf-shell__contextbar");
  contextbar.id = "vf-shell-contextbar";
  contextbar.hidden = true;

  const stateHost = el("div", "vf-shell__state");
  stateHost.id = "vf-shell-state";
  stateHost.hidden = true;

  const main = el("main", "vf-shell__main");
  main.id = "vf-shell-main";
  children.forEach((node) => main.appendChild(node));

  bodyCol.appendChild(contextbar);
  bodyCol.appendChild(stateHost);
  bodyCol.appendChild(main);
  root.appendChild(sidebar);
  root.appendChild(bodyCol);
  document.body.appendChild(root);

  return { root, sidebar, contextbar, stateHost, main };
}

/* ── Fábrica testável (mesmo padrão de createVfApi/createVfContext) ──────
   Tudo que toca o mundo externo (DOM, matchMedia, localStorage) é
   injetável para o teste headless (S01–S13) poder controlar o ambiente. */
export function createVfShell(options = {}) {
  const win = options.window || (typeof window !== "undefined" ? window : null);
  const doc = options.document || (typeof document !== "undefined" ? document : null);
  if (!doc) throw new Error("vf-shell.js requer um DOM (document).");

  const ctxStore = options.context || vfContext;
  const onNavigate = options.onNavigate || ((href) => { if (win) win.location.href = href; });
  const onCommand = options.onCommand || defaultCommand;
  const getUser = options.getUser || readUser;
  const storage = options.storage || safeLocalStorage();

  const dom = options.dom || buildShellDom();
  if (!dom) return null; // abortou: .vf-sidebar (layout.js) já presente

  const host = dom.sidebar;
  const main = dom.main;
  const stateHost = dom.stateHost;
  const contextbar = dom.contextbar;

  // aria-live="polite" que anuncia a troca de contexto (§9.3) — não existe
  // no resto da página, então o shell é quem precisa garantir um só.
  let announcer = dom.root.querySelector("#vf-shell-announcer");
  if (!announcer) {
    announcer = el("div", "vf-visually-hidden");
    announcer.id = "vf-shell-announcer";
    announcer.setAttribute("aria-live", "polite");
    announcer.setAttribute("role", "status");
    dom.root.appendChild(announcer);
  }
  let ultimoAnuncio = null;

  let dropdownAberto = null; // "cliente" | "operacao" | null
  let colapsada = false;
  try {
    colapsada = storage ? storage.getItem(COLLAPSE_KEY) === "1" : false;
  } catch {
    /* preferência de UI — falha aqui não impede o shell de renderizar */
  }

  function defaultCommand(cmd) {
    if (cmd === "logout") doLogout();
    if (cmd === "retry" && win) win.location.reload();
  }

  function doLogout() {
    ctxStore.clearOperationalContext(); // D12 — logout limpa o contexto operacional
    try {
      storage && storage.removeItem(TOKEN_KEY);
      storage && storage.removeItem(USER_KEY);
    } catch {
      /* ignora — o redirect ainda acontece */
    }
    onNavigate("index.html");
  }

  function mq(query) {
    return !!(win && typeof win.matchMedia === "function" && win.matchMedia(query).matches);
  }

  /* DOIS predicados, não um (§19.1) — ver MASTER_SPEC para a distinção. */
  function contextoNaBarra() {
    return mq("(max-width: 1200px)");
  }
  function railEstreito() {
    return mq("(min-width: 861px) and (max-width: 1200px)");
  }

  function abreviar(label) {
    const p = String(label).split(/\s+/);
    if (p.length > 1) return (p[0][0] + p[p.length - 1][0]).toUpperCase();
    return label.slice(0, 2);
  }

  function moduloDisponivel(mod, meta) {
    if (!mod.marketplaces) return true;
    if (!meta) return true; // sem contexto: não pré-julga (§14.2)
    return mod.marketplaces.indexOf(meta.marketplace) >= 0;
  }

  function motivoIndisponivel(mod, meta) {
    const mkt = MARKETPLACE_LABEL[meta.marketplace] || meta.marketplace;
    return `${mod.label} — indisponível para operações ${mkt}`;
  }

  /* ── Render ──────────────────────────────────────────────────────────── */

  function render(snap) {
    if (!host) return;
    const estado = snap.state;
    const ctx = snap.context;
    const meta = snap.meta;
    const user = getUser();
    const carregando = estado === "BOOT" || estado === "RESOLVING_CLIENT" || estado === "RESOLVING_ACCOUNTS";

    host.innerHTML = "";
    host.className = "vf-shell__sidebar" + (colapsada ? " is-collapsed" : "");

    const logo = el("div", "vf-shell__logo");
    logo.innerHTML =
      '<span class="vf-shell__brand"><span class="vf-shell__brand-mark">VF</span>' +
      '<span class="vf-shell__brand-text">Venforce</span></span>';
    const toggle = el("button", "vf-shell__collapse", colapsada ? "›" : "‹");
    toggle.type = "button";
    toggle.setAttribute("aria-label", colapsada ? "Expandir menu" : "Recolher menu");
    toggle.setAttribute("aria-expanded", colapsada ? "false" : "true");
    toggle.addEventListener("click", () => {
      colapsada = !colapsada;
      try {
        storage && storage.setItem(COLLAPSE_KEY, colapsada ? "1" : "0");
      } catch {
        /* preferência de UI — segue sem persistir */
      }
      render(ctxStore.getSnapshot());
    });
    logo.appendChild(toggle);
    host.appendChild(logo);

    const bloco = blocoContexto(estado, ctx, meta, carregando, snap);
    if (contextoNaBarra() && contextbar) {
      contextbar.hidden = false;
      contextbar.innerHTML = "";
      contextbar.appendChild(bloco);
    } else {
      if (contextbar) {
        contextbar.hidden = true;
        contextbar.innerHTML = "";
      }
      host.appendChild(bloco);
    }

    const nav = el("nav", "vf-shell__nav");
    nav.setAttribute("aria-label", "Módulos da operação");
    const indisponiveis = [];
    MODULOS.forEach((mod) => {
      if (meta && !moduloDisponivel(mod, meta)) {
        indisponiveis.push(mod);
        return;
      }
      nav.appendChild(itemNav(mod, estado === "READY" ? null : "Escolha um cliente e uma operação para abrir este módulo", meta));
    });

    if (indisponiveis.length >= 3) {
      const mkt = MARKETPLACE_LABEL[meta.marketplace] || meta.marketplace;
      const det = el("details", "vf-shell__unavailable");
      det.innerHTML = `<summary>Indisponíveis para ${fmt.escapeHTML(mkt)} (${indisponiveis.length})</summary>`;
      indisponiveis.forEach((mod) => det.appendChild(itemNav(mod, motivoIndisponivel(mod, meta), meta)));
      nav.appendChild(det);
    } else {
      indisponiveis.forEach((mod) => nav.appendChild(itemNav(mod, motivoIndisponivel(mod, meta), meta)));
    }
    host.appendChild(nav);

    host.appendChild(el("div", "vf-shell__section-label", "Gestão global"));
    const navG = el("nav", "vf-shell__nav");
    navG.setAttribute("aria-label", "Gestão global");
    GLOBAIS.forEach((mod) => navG.appendChild(itemNav(mod, null, null)));
    host.appendChild(navG);

    if (String(user.role || "").toLowerCase() === "admin") {
      const admin = el("details", "vf-shell__admin");
      admin.innerHTML = "<summary>Administração</summary>";
      const navA = el("nav", "vf-shell__nav");
      ADMIN.forEach((mod) => navA.appendChild(itemNav(mod, null, null)));
      admin.appendChild(navA);
      host.appendChild(admin);
    }

    const footer = el("div", "vf-shell__footer");
    footer.innerHTML =
      `<span class="vf-shell__avatar">${fmt.escapeHTML(fmt.iniciais(user.nome))}</span>` +
      `<span class="vf-shell__user"><b>${fmt.escapeHTML(user.nome || "Usuário")}</b>` +
      `<small>${fmt.escapeHTML(String(user.role || "").toLowerCase() === "admin" ? "Administrador" : "Usuário")}</small></span>`;
    const sair = el("button", "vf-shell__logout", "⏻");
    sair.type = "button";
    sair.title = "Sair";
    sair.setAttribute("aria-label", "Sair");
    sair.addEventListener("click", () => onCommand("logout"));
    footer.appendChild(sair);
    host.appendChild(footer);

    aplicarGating(snap);

    // Anuncia só quando cliente+conta MUDA de verdade — um resize ou um
    // re-render por outro motivo não pode repetir o mesmo anúncio (§9.3).
    if (estado === "READY" && ctx) {
      const chave = `${ctx.clienteId}:${ctx.clienteContaId}`;
      if (chave !== ultimoAnuncio) {
        ultimoAnuncio = chave;
        const clienteAtual = ctxStore.getClienteAtual();
        const nomeCliente = clienteAtual ? clienteAtual.nome : "";
        const nomeConta = meta ? meta.nome : "";
        announcer.textContent = `Contexto: ${nomeCliente}, ${nomeConta}`;
      }
    } else if (!ctx) {
      ultimoAnuncio = null;
    }
  }

  function itemNav(mod, motivoDesabilitado, meta) {
    const futuro = !!mod.futuro || !mod.rota;
    const desabilitado = motivoDesabilitado || futuro;
    const isActive = doc.body.dataset.vfModule === mod.id;
    const a = el("a", "vf-shell__item" + (isActive ? " is-active" : "") + (desabilitado ? " is-disabled" : ""));
    a.href = desabilitado ? "#" : buildHref(mod, meta);
    const rail = railEstreito() || colapsada;
    a.textContent = rail ? abreviar(mod.label) : mod.label;
    if (rail) {
      a.setAttribute("aria-label", mod.label);
      a.title = motivoDesabilitado || (futuro ? "Ainda não disponível nesta versão" : mod.label);
    }
    a.dataset.module = mod.id;
    if (isActive) a.setAttribute("aria-current", "page");
    if (desabilitado) {
      // aria-disabled + title, NUNCA `disabled` puro (§9.3) — alcançável por
      // teclado, motivo legível.
      a.setAttribute("aria-disabled", "true");
      a.title = motivoDesabilitado || "Ainda não disponível nesta versão";
      a.addEventListener("click", (e) => e.preventDefault());
    } else {
      // O href acima é um retrato do momento do render; o `periodo` pode
      // mudar DEPOIS dele sem passar pelo store — as ilhas React escrevem
      // `?periodo=` direto na URL (frontend-react/src/utils/periodoUrl.js) e
      // não têm como notificar o shell. Recalcular no clique é o único jeito
      // de o destino refletir a competência que está na tela agora.
      //
      // Só o clique principal: ctrl/cmd/shift/meio abrem em outra aba e ali
      // vale o href renderizado, que continua correto para copiar o link.
      a.addEventListener("click", (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onNavigate(buildHref(mod, meta));
      });
    }
    return a;
  }

  // Convergência #4 §15 — resolve a rota de um módulo pelo marketplace da
  // conta em tela. `rotaPorMarketplace` é opcional e aditivo: um módulo sem
  // ele (todo mundo, exceto `financeiro`) continua resolvendo `mod.rota`
  // direto, sempre. Sem meta/marketplace resolvido, ou marketplace fora do
  // mapa (TikTok legado), cai em `mod.rota` — nunca fica sem destino algum
  // (§17: TikTok precisa manter um caminho funcional).
  function resolverRota(mod, meta) {
    if (mod.rotaPorMarketplace && meta && meta.marketplace && mod.rotaPorMarketplace[meta.marketplace]) {
      return mod.rotaPorMarketplace[meta.marketplace];
    }
    return mod.rota;
  }

  // Links normais entre os dois mundos (§20.1): a página migrada passa
  // ?cliente=&conta= para a que ainda não migrou; ela ignora o que não
  // entende e usa o próprio seletor. Nenhuma quebra.
  //
  // `periodo` viaja junto (§8.5: "preservado ao trocar módulo/conta,
  // resetado ao trocar cliente"). Faltava aqui: quem estava olhando julho na
  // Visão e clicava em Financeiro chegava em outro mês, sem nada indicar a
  // troca. Trocar de CLIENTE continua zerando o período — setCliente() limpa
  // o parâmetro antes de qualquer navegação, então não há o que propagar.
  function buildHref(mod, meta) {
    const rota = resolverRota(mod, meta);
    const ctx = ctxStore.getContext();
    // `linkParams` é a válvula de escape para páginas que NÃO falam o
    // contrato padrão cliente/conta/periodo (recuperação de navegação —
    // ver linkParamsCliente360V2/linkParamsCentralFull). Nunca inventa
    // parâmetro: cada função só lê o campo que a página de destino
    // realmente documenta ler.
    if (mod.linkParams) {
      const params = mod.linkParams(ctx, meta) || {};
      const qs = new URLSearchParams();
      Object.keys(params).forEach((chave) => {
        const valor = params[chave];
        if (valor !== null && valor !== undefined && valor !== "") qs.set(chave, String(valor));
      });
      const s = qs.toString();
      return s ? `${rota}?${s}` : rota;
    }
    if (!ctx || !ctx.clienteSlug) return rota;
    const qs = new URLSearchParams();
    qs.set("cliente", ctx.clienteSlug);
    if (ctx.clienteContaId) qs.set("conta", String(ctx.clienteContaId));
    const periodo = ctxStore.getPeriodoParam ? ctxStore.getPeriodoParam() : null;
    if (periodo) qs.set("periodo", periodo);
    return `${rota}?${qs.toString()}`;
  }

  function blocoContexto(estado, ctx, meta, carregando, snap) {
    const escopoPagina = doc.body.dataset.vfScope || "global";
    const bloco = el("div", "vf-shell__context" + (escopoPagina === "global" ? " is-muted" : ""));
    const cliente = ctxStore.getClienteAtual();

    const rotuloEscopo = escopoPagina === "global" ? '<span class="vf-shell__context-flag">contexto ativo</span>' : "";
    bloco.innerHTML = `<div class="vf-shell__context-label">Cliente${rotuloEscopo}</div>`;

    const btnC = el("button", "vf-ctx-selector" + (dropdownAberto === "cliente" ? " is-open" : ""));
    btnC.type = "button";
    btnC.id = "vf-cliente-trigger";
    btnC.setAttribute("aria-haspopup", "listbox");
    btnC.setAttribute("aria-expanded", dropdownAberto === "cliente" ? "true" : "false");
    if (carregando && !cliente) {
      btnC.innerHTML = '<span class="vf-skeleton vf-skeleton--row" style="width:100%;height:14px"></span>';
      btnC.disabled = true;
    } else {
      btnC.innerHTML =
        `<span class="vf-ctx-selector__value${cliente ? "" : " is-empty"}">` +
        fmt.escapeHTML(cliente ? cliente.nome : "Selecione um cliente") +
        '</span><span aria-hidden="true">▾</span>';
    }
    btnC.addEventListener("click", () => abrirDropdown(dropdownAberto === "cliente" ? null : "cliente"));
    bloco.appendChild(btnC);
    if (dropdownAberto === "cliente") bloco.appendChild(dropdownClientes());

    bloco.appendChild(el("div", "vf-shell__context-label", "Operação"));
    const contas = ctxStore.getAccounts().filter((c) => c.ativo !== false);
    const btnO = el("button", "vf-ctx-selector" + (dropdownAberto === "operacao" ? " is-open" : ""));
    btnO.type = "button";
    btnO.id = "vf-op-trigger";
    btnO.setAttribute("aria-haspopup", "listbox");
    btnO.setAttribute("aria-expanded", dropdownAberto === "operacao" ? "true" : "false");

    if (estado === "RESOLVING_ACCOUNTS") {
      btnO.innerHTML = '<span class="vf-skeleton vf-skeleton--row" style="width:100%;height:14px"></span>';
      btnO.disabled = true;
    } else if (!cliente) {
      btnO.innerHTML = '<span class="vf-ctx-selector__value is-empty">—</span>';
      btnO.disabled = true;
    } else if (!contas.length) {
      btnO.innerHTML = '<span class="vf-ctx-selector__value is-empty">Sem operação</span>';
      btnO.disabled = true; // visível e desabilitado, nunca escondido (§9.2)
    } else if (meta) {
      btnO.innerHTML =
        `<span class="vf-ctx-selector__value"><span class="vf-status is-${meta.status.tone}">` +
        '<span aria-hidden="true"></span></span>' +
        fmt.escapeHTML(meta.nome) +
        '</span><span aria-hidden="true">▾</span>' +
        `<small class="vf-ctx-selector__sub">${fmt.escapeHTML(meta.externalAccountLabel)}</small>`;
      btnO.disabled = contas.length === 1; // 1 ativa: nada a escolher (precedente fechamentos-api.js:820)
    } else {
      btnO.innerHTML = '<span class="vf-ctx-selector__value is-empty">Selecione a operação…</span><span aria-hidden="true">▾</span>';
    }
    btnO.addEventListener("click", () => abrirDropdown(dropdownAberto === "operacao" ? null : "operacao"));
    bloco.appendChild(btnO);
    if (dropdownAberto === "operacao") bloco.appendChild(dropdownOperacoes());

    if (meta) {
      const integ = snap.integration || {};
      const linhas = [];
      if (meta.marketplace === "meli" && integ.grant && integ.grant !== "conectado") {
        linhas.push('<span class="vf-shell__integ is-warning">⚠ Mercado Livre desconectado</span>');
      }
      linhas.push(
        meta.base
          ? `<span class="vf-shell__integ">Base: ${fmt.escapeHTML(meta.base.nome)}</span>`
          : '<span class="vf-shell__integ is-warning">⚠ sem base vinculada</span>'
      );
      bloco.appendChild(el("div", "vf-shell__integrations", linhas.join("")));
    }

    return bloco;
  }

  function dropdownClientes() {
    const lista = ctxStore.getPortfolio();
    const box = el("div", "vf-menu vf-shell__dropdown");
    box.setAttribute("role", "listbox");
    box.setAttribute("aria-label", "Clientes da carteira");

    if (lista.length >= 8) {
      const wrap = el("div", "vf-shell__dropdown-search");
      const input = el("input", "vf-input vf-input--sm");
      input.type = "search";
      input.placeholder = "Buscar cliente…";
      input.setAttribute("aria-label", "Buscar cliente");
      input.addEventListener("input", () => {
        const q = fmt.normalizarBusca(input.value);
        Array.prototype.forEach.call(box.querySelectorAll(".vf-menu__item"), (it) => {
          it.hidden = q ? fmt.normalizarBusca(it.dataset.busca).indexOf(q) < 0 : false;
        });
      });
      wrap.appendChild(input);
      box.appendChild(wrap);
      setTimeout(() => input.focus(), 0);
    }

    const atual = ctxStore.getContext();
    lista.forEach((c) => {
      const it = el("button", "vf-menu__item");
      it.type = "button";
      it.setAttribute("role", "option");
      it.dataset.busca = `${c.nome} ${c.slug}`;
      const selecionado = atual && atual.clienteId === c.id;
      it.setAttribute("aria-selected", selecionado ? "true" : "false");
      const subOperacoes = typeof c.contasAtivas === "number" ? ` · ${c.contasAtivas} operaç${c.contasAtivas === 1 ? "ão" : "ões"}` : "";
      it.innerHTML =
        fmt.escapeHTML(c.nome) +
        (selecionado ? ' <span class="vf-menu__check" aria-hidden="true">✓</span>' : "") +
        `<small>${fmt.escapeHTML(c.slug)}${subOperacoes}</small>`;
      it.addEventListener("click", () => {
        abrirDropdown(null);
        ctxStore.setCliente(c.slug); // I1 — zera conta, revalida cardinalidade
      });
      box.appendChild(it);
    });
    wireTeclado(box);
    return box;
  }

  function dropdownOperacoes() {
    const contas = ctxStore.getAccounts();
    const cliente = ctxStore.getClienteAtual();
    const atual = ctxStore.getContext();
    const box = el("div", "vf-menu vf-shell__dropdown");
    box.setAttribute("role", "listbox");
    box.setAttribute("aria-label", `Operações de ${cliente ? cliente.nome : ""}`);
    box.appendChild(el("div", "vf-menu__label", `Operações de ${fmt.escapeHTML(cliente ? cliente.nome : "")}`));

    contas.forEach((c) => {
      const st = statusOperacao(c);
      const inativa = c.ativo === false;
      const it = el("button", "vf-menu__item" + (inativa ? " is-disabled" : ""));
      it.type = "button";
      it.setAttribute("role", "option");
      const sel = atual && atual.clienteContaId === c.id;
      it.setAttribute("aria-selected", sel ? "true" : "false");
      if (inativa) it.setAttribute("aria-disabled", "true");
      it.innerHTML =
        `<span class="vf-status is-${st.tone}"><span aria-hidden="true"></span>` +
        `<span class="vf-visually-hidden">${fmt.escapeHTML(st.label)}</span></span>` +
        fmt.escapeHTML(c.nome) +
        (inativa ? " (inativa)" : "") +
        (sel ? ' <span class="vf-menu__check" aria-hidden="true">✓</span>' : "") +
        `<small>${fmt.escapeHTML(rotuloExterno(c))} · ${fmt.escapeHTML(st.label)}</small>`;
      if (!inativa) {
        it.addEventListener("click", () => {
          abrirDropdown(null);
          ctxStore.setConta(c.id); // troca de operação MANTÉM a rota (§9, fluxo 6)
        });
      }
      box.appendChild(it);
    });

    const ger = el("button", "vf-menu__item vf-menu__item--footer");
    ger.type = "button";
    ger.textContent = "Gerenciar operações →";
    ger.addEventListener("click", () => {
      abrirDropdown(null);
      onNavigate("clientes.html");
    });
    box.appendChild(ger);
    wireTeclado(box);
    return box;
  }

  function wireTeclado(box) {
    box.addEventListener("keydown", (e) => {
      const itens = Array.prototype.filter.call(box.querySelectorAll(".vf-menu__item"), (i) => !i.hidden);
      const i = itens.indexOf(doc.activeElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        (itens[i + 1] || itens[0])?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        (itens[i - 1] || itens[itens.length - 1])?.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        itens[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        itens[itens.length - 1]?.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        const gatilhoId = dropdownAberto === "operacao" ? "vf-op-trigger" : dropdownAberto === "cliente" ? "vf-cliente-trigger" : null;
        abrirDropdown(null);
        if (gatilhoId) doc.getElementById(gatilhoId)?.focus(); // Esc devolve o foco ao gatilho (§9.3)
      }
    });
  }

  function abrirDropdown(qual) {
    dropdownAberto = qual;
    render(ctxStore.getSnapshot());
    if (qual) {
      const primeiro = host.querySelector(".vf-shell__dropdown .vf-menu__item:not(.is-disabled)");
      if (primeiro) setTimeout(() => primeiro.focus(), 0);
    }
  }

  /* ── Gating por escopo (MASTER_SPEC §5.4) ────────────────────────────── */

  /* Carteira vazia continua sendo ESTADO (nunca erro — M12 já separa os
     dois); o que muda é a EXPLICAÇÃO. Só quem tem squad pode ser mandado ao
     coordenador do squad dele. `getSquads()` vem de /me/context e é `[]`
     tanto para quem ainda não foi mapeado (enforcement OFF) quanto para o
     admin, que enxerga por bypass e não precisa ser membro de nada. */
  function textoNoPortfolio() {
    const squads = ctxStore.getSquads ? ctxStore.getSquads() : [];
    if (squads && squads.length) return null;
    return {
      titulo: "Nenhum cliente na sua carteira",
      texto: "Fale com o seu coordenador para receber acesso a uma carteira.",
    };
  }

  function aplicarGating(snap) {
    const escopo = doc.body.dataset.vfScope || "global";
    const estado = snap.state;

    const satisfeito =
      escopo === "global"
        ? estado !== "BOOT" && estado !== "PORTFOLIO_ERROR"
        : escopo === "client"
        ? !!(snap.context && snap.context.clienteId)
        : estado === "READY"; // "account"

    doc.body.classList.toggle("vf-shell-blocked", !satisfeito);
    if (main) main.hidden = !satisfeito;
    if (!stateHost) return;

    if (satisfeito) {
      stateHost.innerHTML = "";
      stateHost.hidden = true;
      return;
    }

    let def = ESTADOS[estado];
    if (!def) {
      stateHost.innerHTML = "";
      stateHost.hidden = true;
      return;
    }
    if (estado === "NO_PORTFOLIO") def = Object.assign({}, def, textoNoPortfolio());

    stateHost.hidden = false;
    const acao = def.acao
      ? `<div class="vf-banner__actions"><button type="button" class="vf-btn vf-btn--primary vf-btn--sm" data-cmd="${def.acao.cmd}">${fmt.escapeHTML(def.acao.label)}</button></div>`
      : "";
    const detalhe = snap.error && snap.error.mensagem ? `<p class="vf-banner__description"><small>${fmt.escapeHTML(snap.error.mensagem)}</small></p>` : "";

    stateHost.innerHTML =
      `<div class="vf-banner is-${def.tom}" role="${def.alerta ? "alert" : "status"}">` +
      '<div class="vf-banner__content">' +
      `<p class="vf-banner__title">${fmt.escapeHTML(def.titulo)}</p>` +
      `<p class="vf-banner__description">${fmt.escapeHTML(def.texto)}</p>${detalhe}` +
      `</div>${acao}</div>` +
      `<p class="vf-state-machine">estado do contexto: <code>${fmt.escapeHTML(estado)}</code></p>`;

    const btn = stateHost.querySelector("[data-cmd]");
    if (btn) {
      btn.addEventListener("click", () => {
        const cmd = btn.dataset.cmd;
        if (cmd === "carteira") onNavigate("carteira.html");
        else if (cmd === "clientes-contas") onNavigate("clientes.html");
        else if (cmd === "abrir-operacao") abrirDropdown("operacao");
        else onCommand(cmd);
      });
    }
  }

  /* Cruzar qualquer uma das duas faixas muda a montagem — precisa de
     re-render. Redimensionar DENTRO da mesma faixa não redesenha nada. */
  let timerResize = null;
  let faixaAnterior = `${contextoNaBarra()}${railEstreito()}`;
  if (win && typeof win.addEventListener === "function") {
    win.addEventListener("resize", () => {
      clearTimeout(timerResize);
      timerResize = setTimeout(() => {
        const faixa = `${contextoNaBarra()}${railEstreito()}`;
        if (faixa === faixaAnterior) return;
        faixaAnterior = faixa;
        render(ctxStore.getSnapshot());
      }, 120);
    });
  }

  // Clique fora fecha o dropdown aberto (§9 — faltava: só Esc e escolher um
  // item fechavam; clicar em qualquer outro lugar da página deixava o menu
  // aberto por cima do conteúdo, sem jeito óbvio de sair sem usar teclado).
  // Delegado no `document`, não em `host` — o bloco de contexto reparenta
  // para a contextbar em telas estreitas (§19.1) e sai de dentro de `host`.
  if (doc && typeof doc.addEventListener === "function") {
    doc.addEventListener("click", (e) => {
      if (!dropdownAberto) return;
      const dentro = typeof e.target.closest === "function" && e.target.closest(".vf-shell__context");
      if (dentro) return; // gatilhos e itens já fecham pelo próprio handler
      abrirDropdown(null);
    });
  }

  const unsubscribe = ctxStore.subscribe((snap) => render(snap));

  return {
    render,
    dom,
    abrirOperacao: () => abrirDropdown("operacao"),
    fecharDropdowns: () => {
      if (dropdownAberto) abrirDropdown(null);
    },
    destroy: unsubscribe,
    MODULOS,
    GLOBAIS,
    ADMIN,
  };
}

/* ── Cliente de depuração (paridade com layout.js) ───────────────────────
   layout.js:23-64 carrega vf-debug-client.js para ADMIN quando
   localStorage["vf-debug-enabled"] === "true" (ou ?vf_debug=1). Toda página
   já migrada para o Shell V3 tinha perdido isso em silêncio — inclusive as
   que existem para depurar. Portado aqui, com o mesmo gate (admin + token +
   opt-in explícito) e a mesma tolerância a falha: o Portal segue inteiro se
   o script não carregar. A duplicação com layout.js é deliberada e morre
   com ele em F6 — mexer no layout.js legado afetaria 26 páginas de uma vez. */
const DEBUG_ENABLED_KEY = "vf-debug-enabled";
const DEBUG_CLIENT_SRC = "vf-debug-client.js";

function loadDebugClientIfSafe() {
  try {
    const storage = safeLocalStorage();
    if (!storage) return;
    const urlFlag = new URLSearchParams(window.location.search || "").get("vf_debug");
    if (urlFlag === "0" || urlFlag === "false" || urlFlag === "off") {
      storage.setItem(DEBUG_ENABLED_KEY, "false");
      return;
    }
    if (String(readUser().role || "").toLowerCase() !== "admin" || !hasToken()) return;
    if (urlFlag === "1" || urlFlag === "true" || urlFlag === "on") storage.setItem(DEBUG_ENABLED_KEY, "true");
    if (storage.getItem(DEBUG_ENABLED_KEY) !== "true") return;
    if (window.__VF_DEBUG_CLIENT_LOADING__ || window.VFDebugClient) return;
    if (document.querySelector('script[data-vf-debug-client="true"]')) return;

    window.__VF_DEBUG_CLIENT_LOADING__ = true;
    const script = document.createElement("script");
    script.src = DEBUG_CLIENT_SRC;
    script.async = true;
    script.dataset.vfDebugClient = "true";
    script.onerror = () => { window.__VF_DEBUG_CLIENT_LOADING__ = false; };
    (document.head || document.documentElement).appendChild(script);
  } catch {
    /* auxiliar: nenhuma falha aqui pode derrubar o shell */
  }
}

/* ── Boot de produção — só roda em página real, autenticada, sem admin
   próprio de teste (o teste headless usa createVfShell() diretamente com
   um `api`/`context` injetados). */
function bootProduction() {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  // Sem token não existe nenhuma chamada de API em trânsito para um 401
  // acionar o redirect (vf-api só entra em cena depois de vfContext.init(),
  // que este `return` evita) — sem isto a página fica em branco pra sempre,
  // sem shell/erro/loading, em vez de mandar pro login.
  if (!hasToken()) { window.location.replace("index.html"); return null; }
  const user = readUser();
  // Paridade com layout.js:319-323 — `seller` é uma persona EXTERNA, com
  // área própria. Sem este desvio ela veria a navegação interna inteira
  // (Carteira, Bases, Pessoas, Administração) e só descobriria que não pode
  // usá-la pelos 403 de cada tela. O backend continua sendo quem autoriza;
  // isto é sobre não oferecer a porta errada.
  if (String(user.role || "").toLowerCase() === "seller") { window.location.replace("seller.html"); return null; }
  loadDebugClientIfSafe();
  const scope = document.body ? document.body.dataset.vfScope || "global" : "global";

  const shell = createVfShell({ getUser: readUser });
  if (!shell) return null; // abortou: .vf-sidebar já presente (layout.js)

  vfContext.init({ api: createProductionContextApi(vfApi), user, scope });
  return shell;
}

export const vfShell = typeof document !== "undefined" ? bootProduction() : null;

if (typeof window !== "undefined") {
  window.VF = window.VF || {};
  window.VF.shell = vfShell;
}
