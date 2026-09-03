/*
 * Portal/squads-rollout-ux-ui.test.js
 *
 * Prontidão do FRONTEND para o mapeamento REAL de Squads (P2.9) — a
 * pergunta que esta suíte responde é uma só:
 *
 *   "quando a Pessoa 2 inserir os dados reais de Squads, a experiência
 *    atual do Portal já sabe trabalhar corretamente com eles?"
 *
 * Tudo aqui é FIXTURE. Nenhuma requisição sai para produção (o harness é
 * same-origin com o servidor deste arquivo, e o último caso confere isso
 * lendo a lista de requisições do próprio Chrome). O mapeamento real ainda
 * não está aplicado; o que se prova é o COMPORTAMENTO do frontend diante do
 * payload que o backend já sabe emitir.
 *
 * Mesmo padrão de Portal/carteira-ui.test.js: servidor estático local + CDP
 * puro (sem puppeteer) + harness que monta `createCarteira()` de
 * Portal/carteira.js sobre a página real. Diferença deliberada: aqui NADA é
 * injetado em `getSquads` — o caminho exercitado é o de produção, em que os
 * squads vêm de GET /me/portfolio (Carteira) e de GET /me/context (store),
 * porque é justamente a relação entre esses dois payloads que o rollout põe
 * à prova.
 *
 * ─── O contrato real, que motiva metade dos casos ───────────────────────
 * server/services/meService.js devolve DUAS coisas diferentes com a palavra
 * "squad":
 *
 *   · `squads[]`         → as MEMBERSHIPS do usuário (squadsDoUsuario)
 *   · `clientes[].squad` → o squad REAL do cliente (squadsAtivosDeClientes)
 *
 * Elas não coincidem. Admin tem bypass de carteira e pode ter ZERO
 * memberships enquanto enxerga clientes de 6 squads; e o bucket
 * "Squad 8 · Legado" existe para clientes antigos, sem que ninguém precise
 * ser membro dele. Confundir as duas listas era o que fazia um squad com
 * nome no payload aparecer como "SEM SQUAD".
 *
 * ─── Regras canônicas que a suíte protege ───────────────────────────────
 *   · Squad é agrupamento/filtro da Carteira, NUNCA um passo antes do
 *     Cliente (MASTER_SPEC D5/D7, §10.6);
 *   · POSSO ACESSAR ≠ É MINHA RESPONSABILIDADE — `responsavelDireto` marca,
 *     ordena e destaca, mas nunca esconde cliente autorizado;
 *   · Squad principal é DEFAULT DE UX, nunca autorização, e só existe
 *     quando o backend o envia — jamais deduzido de ordem de array, menor
 *     id ou função no squad;
 *   · identidade operacional continua { clienteId, clienteSlug,
 *     clienteContaId }; Squad não entra nela (D6/D11);
 *   · com SQUADS_ENFORCEMENT=OFF, cliente sem squad é estado LEGÍTIMO —
 *     degradar honestamente, nunca tratar como erro.
 */
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PORTAL_DIR = __dirname;

/* ══════════════════════════ Fixtures ═════════════════════════════════════
   Os 6 squads operacionais + o bucket legado, exatamente como o modelo
   operacional confirmado os descreve. A ORDEM das listas de membership é
   propositalmente embaralhada em relação ao id: é o que permite provar que
   nada aqui escolhe "o primeiro do array" nem "o menor id". */

const S1 = { id: 1, nome: "Squad 1", slug: "squad-1" };
const S2 = { id: 2, nome: "Squad 2", slug: "squad-2" };
const S3 = { id: 3, nome: "Squad 3", slug: "squad-3" };
const S4 = { id: 4, nome: "Squad 4", slug: "squad-4" };
const S5 = { id: 5, nome: "Squad 5", slug: "squad-5" };
const S6 = { id: 6, nome: "Squad 6", slug: "squad-6" };
// Bucket especial do rollout: clientes reais antigos que não aparecem na
// relação operacional atual. O frontend precisa REPRESENTÁ-LO; quem o cria é
// a Pessoa 2, no backend.
const S8 = { id: 8, nome: "Squad 8 · Legado", slug: "squad-8-legado" };

function membership(squad, principal) {
  return { id: squad.id, nome: squad.nome, slug: squad.slug, principal: principal === true };
}

function conta(id, marketplace, nome, label, extras) {
  return Object.assign(
    {
      id,
      marketplace,
      nome,
      externalAccountLabel: label,
      external_account_id: String(100000000 + id),
      ativo: true,
      grantStatus: marketplace === "meli" ? "conectado" : null,
      baseVinculada: { id: 9, nome: "Custo 2026" },
      ultimaSync: null,
    },
    extras || {}
  );
}

/* `squad` null = cliente sem squad. Com enforcement OFF isso é um estado
   legítimo do banco de hoje, não uma anomalia — e é assim que a tela precisa
   tratá-lo. */
function cliente(id, slug, nome, squad, opts) {
  const o = opts || {};
  return {
    id,
    slug,
    nome,
    squadId: squad ? squad.id : null,
    squad: squad ? { id: squad.id, nome: squad.nome, slug: squad.slug, principalParaUsuario: o.principalParaUsuario === true } : null,
    responsavelDireto: o.responsavelDireto === true,
    papeisDiretos: o.papeisDiretos || [],
    statusOperacional: o.statusOperacional || "pronto",
    ultimaSincronizacao: o.ultimaSincronizacao || null,
    pendencias: o.pendencias || [],
    contas: o.contas || [conta(1000 + id, "meli", "Mercado Livre", slug + "-ml")],
  };
}

// GET /me/context é mais pobre que /me/portfolio de propósito (meService.js):
// sem `squad` por cliente, sem pendências, sem contas. Derivar o contexto do
// mesmo conjunto de clientes mantém as duas fontes coerentes, como em
// produção.
function contextoDe(portfolio, extras) {
  return Object.assign(
    {
      ok: true,
      user: { id: 12, nome: "Pedro Gomes", email: "pedro@venforce.com", role: "user" },
      squads: portfolio.squads.map((s) => Object.assign({ funcao: "analista", ativo: true }, s)),
      squadPrincipalId: (portfolio.squads.find((s) => s.principal) || {}).id || null,
      clientes: portfolio.clientes.map((c) => ({
        id: c.id,
        slug: c.slug,
        nome: c.nome,
        squadId: c.squadId,
        responsavelDireto: c.responsavelDireto,
        contasAtivas: c.contas.filter((x) => x.ativo !== false).length,
      })),
      portfolio: { totalClientes: portfolio.clientes.length },
      permissoes: { podeAdministrar: false },
    },
    extras || {}
  );
}

/* ── A · usuário com 1 Squad ─────────────────────────────────────────── */
const CENARIO_A = {
  squads: [membership(S1, true)],
  clientes: [
    cliente(101, "aurora", "Aurora Comercial", S1, { responsavelDireto: true }),
    cliente(102, "bravo", "Bravo Distribuidora", S1),
  ],
};

/* ── B · 3 Squads com principal DEFINIDO ──────────────────────────────
   Micael/Fernando/Klayvert são reais e participam de vários squads. O
   principal aqui é o ÚLTIMO do array E o de maior id — se algum dia alguém
   voltar a "escolher o primeiro" ou "o menor id", este cenário quebra. */
const CENARIO_B = {
  squads: [membership(S3), membership(S1), membership(S6, true)],
  clientes: [
    cliente(201, "cedro", "Cedro Atacado", S3, { responsavelDireto: true }),
    cliente(202, "delta", "Delta Varejo", S1),
    cliente(203, "everest", "Everest Store", S6, { principalParaUsuario: true }),
    cliente(204, "fenix", "Fênix Comercial", S6, { principalParaUsuario: true }),
  ],
};

/* ── C · 3 Squads com principal NULL ──────────────────────────────────
   Decisão humana ainda pendente para esses usuários. Nada pode preencher
   esse vazio sozinho. */
const CENARIO_C = {
  squads: [membership(S3), membership(S1), membership(S6)],
  clientes: [
    cliente(301, "gaia", "Gaia Comercial", S3),
    cliente(302, "horizonte", "Horizonte Ltda", S1),
    cliente(303, "ipe", "Ipê Distribuidora", S6),
  ],
};

/* ── D · Admin com bypass ─────────────────────────────────────────────
   Zero memberships (`squads: []`) e ainda assim carteira inteira — é o
   contrato real: resolvePortfolioClientes dá tudo ao admin, squadsDoUsuario
   dá só as memberships dele, que podem não existir. */
const CENARIO_D = {
  squads: [],
  clientes: [
    cliente(401, "jacaranda", "Jacarandá SA", S1),
    cliente(402, "kiwi", "Kiwi Comércio", S4),
    cliente(403, "lotus", "Lótus Store", S8),
  ],
};

/* ── E · Clientes no Squad 8 · Legado ─────────────────────────────────
   O usuário é membro de 1 e 5; ninguém é membro do bucket legado. Os
   clientes antigos precisam continuar visíveis, com o NOME certo, e
   filtráveis. */
const CENARIO_E = {
  squads: [membership(S1, true), membership(S5)],
  clientes: [
    cliente(501, "manaus", "Manaus Comercial", S1, { responsavelDireto: true }),
    cliente(502, "natal", "Natal Distribuidora", S5),
    cliente(503, "olinda", "Olinda Antiga", S8),
    cliente(504, "petropolis", "Petrópolis Antiga", S8),
  ],
};

/* ── F/G/H/I/J · cardinalidade de ClienteConta e responsabilidade ─────
   Ipiranga tem ML1 (is_primary no legado), ML2 e Shopee: escolher a SEGUNDA
   conta é o que prova que nada volta para is_primary nem para a primeira. */
const CENARIO_CONTAS = {
  squads: [membership(S2, true), membership(S3)],
  clientes: [
    // F — 1 conta ativa
    cliente(601, "quixada", "Quixadá Comércio", S2, { responsavelDireto: true }),
    // G — 3 contas ativas
    cliente(602, "ipiranga", "Ipiranga Multi", S2, {
      responsavelDireto: false,
      contas: [
        conta(6021, "meli", "Mercado Livre 1", "ipiranga-ml1"),
        conta(6022, "meli", "Mercado Livre 2", "ipiranga-ml2"),
        conta(6023, "shopee", "Shopee", "ipiranga-shopee"),
      ],
    }),
    // H — autorizado, responsabilidade de OUTRA pessoa
    cliente(603, "recife", "Recife Atacado", S3, { responsavelDireto: false }),
    // I — autorizado E responsável
    cliente(604, "salvador", "Salvador Varejo", S3, { responsavelDireto: true }),
    // J — sem operação configurada
    cliente(605, "teresina", "Teresina Nova", S3, {
      contas: [],
      statusOperacional: "critico",
      pendencias: [{ tipo: "sem_grant" }, { tipo: "sem_base" }],
    }),
  ],
};

/* ── K · Squad autorizado SEM clientes visíveis ───────────────────────
   Membership existe, carteira daquele squad está vazia. Não é erro. */
const CENARIO_K = {
  squads: [membership(S2, true), membership(S4)],
  clientes: [cliente(701, "uberaba", "Uberaba Comercial", S2)],
};

/* ── L · portfolio vazio LEGÍTIMO ─────────────────────────────────────── */
const CENARIO_L = { squads: [membership(S1, true)], clientes: [] };
const CENARIO_L_SEM_SQUAD = { squads: [], clientes: [] };

/* ── Enforcement OFF · clientes sem squad convivendo com clientes com squad
   Antes do apply, `squadId` null é o estado NORMAL do banco. */
const CENARIO_ENFORCEMENT_OFF = {
  squads: [membership(S1, true), membership(S5)],
  clientes: [
    // O primeiro da lista é de propósito um SEM squad: o cabeçalho do
    // primeiro grupo já foi perdido uma vez por causa disso.
    cliente(801, "antigo-um", "Antigo Um", null),
    cliente(802, "antigo-dois", "Antigo Dois", null),
    cliente(803, "vitoria", "Vitória Comercial", S1),
    cliente(804, "xique", "Xique-Xique Ltda", S5),
  ],
};

/* ── Responsivo · o pior caso de agrupamento numa tela só ─────────────
   Principal + squad comum + bucket legado + resíduo sem squad, para as
   asserções de tela estreita medirem tudo de uma vez. Cenário próprio de
   propósito: os de cima já são asserido linha a linha e mexer neles para
   caber mais um caso enfraqueceria os dois. */
const CENARIO_RESPONSIVO = {
  squads: [membership(S1, true), membership(S5)],
  clientes: [
    cliente(901, "vitoria", "Vitória Comercial", S1, { responsavelDireto: true }),
    cliente(902, "salinas", "Salinas Distribuidora", S5),
    cliente(903, "olinda", "Olinda Comércio Antigo", S8),
    cliente(904, "petropolis", "Petrópolis Importadora Antiga", S8),
    cliente(905, "antigo", "Antigo Sem Squad", null),
  ],
};

const CENARIOS = {
  responsivo: CENARIO_RESPONSIVO,
  a: CENARIO_A,
  b: CENARIO_B,
  c: CENARIO_C,
  d: CENARIO_D,
  e: CENARIO_E,
  contas: CENARIO_CONTAS,
  k: CENARIO_K,
  l: CENARIO_L,
  "l-sem-squad": CENARIO_L_SEM_SQUAD,
  "enforcement-off": CENARIO_ENFORCEMENT_OFF,
};

/* ══════════════════════════ Harness ══════════════════════════════════════
   NADA é injetado em getSquads: o caminho medido é o de produção. O id da
   raiz é diferente de "carteira-root" de propósito — importar carteira.js
   também executa o bootProduction() dele (efeito de módulo), e sem esse id
   no DOM ele não monta uma segunda instância por cima desta. */
/* `escopo` existe só para o cenário do painel de estado do Shell: em
   scope="global" (o da Carteira real) NO_PORTFOLIO é estado satisfeito e o
   painel nem aparece — quem o vê é uma página operacional. */
function harnessHtml(escopo) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="vf-api-base" content="__API_BASE__">
<link rel="stylesheet" href="/css/vf-tokens-v2.css">
<link rel="stylesheet" href="/css/vf-components-v2.css">
<link rel="stylesheet" href="/css/pages/carteira-v2.css">
<link rel="stylesheet" href="/css/vf-shell.css">
</head>
<body class="vf-page vf-page-carteira" data-vf-scope="${escopo || "global"}" data-vf-module="carteira">
<script>
  var qs = new URLSearchParams(location.search);
  localStorage.setItem("vf-token", "squads-ux-token");
  localStorage.setItem("vf-user", JSON.stringify({ id: 12, nome: "Pedro Gomes", role: qs.get("role") || "user" }));
</script>
<div><main class="vf-content"><div class="vf-page-shell"><div class="vf-page-container">
  <div id="carteira-test-root"></div>
</div></div></main></div>
<script type="module" src="/vf-shell.js"></script>
<script type="module">
  import { createCarteira } from "/carteira.js";
  window.__navegacoes = [];
  window.__cart = createCarteira({ onNavigate: function (href) { window.__navegacoes.push(href); } });
  window.__cart.montar(document.getElementById("carteira-test-root"));
</script>
</body></html>`;
}

let serverPort = 0;
let currentFixture = { cenario: "a", falhaMePortfolio: false, falhaMeContext: false, contasPorSlug: null };

function contasDoCenarioPorSlug(cenario) {
  const mapa = {};
  (CENARIOS[cenario] || CENARIOS.a).clientes.forEach((c) => {
    // formato de GET /clientes/:slug/contas (legado): `base` no lugar de
    // `baseVinculada`, `grant` cru no lugar de `grantStatus`.
    mapa[c.slug] = c.contas.map((x) => ({
      id: x.id,
      cliente_id: c.id,
      marketplace: x.marketplace,
      nome: x.nome,
      slug: x.nome.toLowerCase().replace(/\s+/g, "-"),
      external_account_id: x.external_account_id,
      externalAccountLabel: x.externalAccountLabel,
      // is_primary só existe no payload para PROVAR que ninguém o usa como
      // identidade: a primeira conta de cada cliente é a "primária".
      is_primary: c.contas.indexOf(x) === 0,
      ativo: x.ativo !== false,
      grant: x.marketplace === "meli" ? { id: 900 + x.id, ml_user_id: String(x.id), token_status: "valid" } : null,
      base: x.baseVinculada ? { vinculo_id: 500 + x.id, base_id: x.baseVinculada.id, slug: "base", nome: x.baseVinculada.nome } : null,
      ultimaSync: x.ultimaSync || null,
    }));
  });
  return mapa;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    const cenario = currentFixture.cenario;
    const fixture = CENARIOS[cenario] || CENARIOS.a;

    if (u.pathname === "/harness.html") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(harnessHtml(u.searchParams.get("escopo")).replace("__API_BASE__", `http://127.0.0.1:${serverPort}`));
      return;
    }

    if (u.pathname === "/me/context") {
      if (currentFixture.falhaMeContext) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, erro: "Falha simulada em /me/context." }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(contextoDe(fixture)));
      return;
    }

    if (u.pathname === "/me/portfolio") {
      if (currentFixture.falhaMePortfolio) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, erro: "Falha simulada em /me/portfolio." }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, squads: fixture.squads, clientes: fixture.clientes }));
      return;
    }

    const contasMatch = u.pathname.match(/^\/clientes\/([^/]+)\/contas$/);
    if (contasMatch) {
      const slug = decodeURIComponent(contasMatch[1]);
      const contas = contasDoCenarioPorSlug(cenario)[slug];
      if (!contas) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, erro: "Cliente não encontrado." }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, cliente: { id: 1, nome: slug, slug, ativo: true }, contas }));
      return;
    }

    const target = path.resolve(PORTAL_DIR, u.pathname.replace(/^\/+/, ""));
    if (!target.startsWith(path.resolve(PORTAL_DIR) + path.sep)) { res.writeHead(403).end("forbidden"); return; }
    fs.readFile(target, (err, contents) => {
      if (err) { res.writeHead(404).end("not found"); return; }
      const ext = path.extname(target);
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
      res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(contents);
    });
  });
  // Flake de harness diagnosticado em Portal/vf-shell-ui.test.js: o Node
  // fecha a conexão keep-alive ociosa em 5s enquanto o Chrome ainda a
  // considera reutilizável, e entre cenários passam segundos de asserções
  // CDP. Sem isto, uma requisição qualquer morre no meio e o sintoma
  // aparece longe da causa.
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { serverPort = server.address().port; resolve(server); }));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitChrome(port) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return; } catch (_) { /* aguardando */ }
    await sleep(50);
  }
  throw new Error("Chrome DevTools não iniciou.");
}

class Cdp {
  constructor(url) { this.socket = new WebSocket(url); this.nextId = 1; this.pending = new Map(); this.onEvent = null; }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const m = JSON.parse(event.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
        return;
      }
      if (m.method && this.onEvent) this.onEvent(m.method, m.params);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Falha na avaliação do navegador");
    return result.result.value;
  }
  close() { this.socket.close(); }
}

async function waitFor(cdp, expression, message) {
  for (let i = 0; i < 160; i++) {
    if (await cdp.evaluate(`Boolean(${expression})`)) return;
    await sleep(50);
  }
  throw new Error(message || `Timeout: ${expression}`);
}

let checks = 0;
async function check(name, fn) {
  await fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

/* ── leitores de tela ─────────────────────────────────────────────────── */

const LER_GRUPOS = `Array.prototype.map.call(document.querySelectorAll('.vf-portfolio-group'), function(h){ return h.textContent.replace(/\\s+/g,' ').trim(); })`;
const LER_LINHAS = `Array.prototype.map.call(document.querySelectorAll('.vf-portfolio-row'), function(li){ return li.dataset.slug; })`;
const LER_OPCOES_SQUAD = `(function(){ var s = document.getElementById('cart-squad'); return s ? Array.prototype.map.call(s.options, function(o){ return o.value + '|' + o.textContent.trim(); }) : null; })()`;

async function run() {
  const server = await startServer();
  const debugPort = 18000 + Math.floor(Math.random() * 1000);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=/tmp/vf-squads-ux-${process.pid}`, "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    await waitChrome(debugPort);
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");

    const consoleErrors = [];
    const urlsPedidas = [];
    cdp.onEvent = (method, params) => {
      if (method === "Runtime.consoleAPICalled" && params.type === "error") {
        consoleErrors.push((params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || "")).join(" "));
      }
      if (method === "Network.requestWillBeSent") urlsPedidas.push(params.request.url);
    };

    /* Renavega quando a montagem não acontece: ver a nota do flake de socket
       em Portal/vf-shell-ui.test.js — entre cenários, uma requisição do
       próprio harness pode morrer e o grafo de módulos nunca executa. É
       ruído de ambiente, nunca produto, e renavegar é idempotente aqui. */
    async function goto(cenario, extraQs) {
      currentFixture = { cenario, falhaMePortfolio: false, falhaMeContext: false };
      const qs = extraQs ? `&${extraQs}` : "";
      const url = `http://127.0.0.1:${serverPort}/harness.html?cenario=${cenario}${qs}`;
      let ultimo = null;
      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        await cdp.send("Page.navigate", { url });
        try {
          await waitFor(cdp, "window.__cart", "Carteira não montou");
          await waitFor(cdp, "window.VF && window.VF.context && window.VF.context.getState() !== 'BOOT'", "contexto não saiu de BOOT");
          return;
        } catch (err) {
          ultimo = err;
        }
      }
      throw ultimo;
    }

    // Igual a goto(), mas preserva o currentFixture já configurado — os
    // cenários M/N precisam entrar na página COM a falha armada.
    async function navegarCru(cenario, mensagem) {
      const url = `http://127.0.0.1:${serverPort}/harness.html?cenario=${cenario}`;
      let ultimo = null;
      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        await cdp.send("Page.navigate", { url });
        try {
          await waitFor(cdp, "window.__cart", mensagem);
          return;
        } catch (err) {
          ultimo = err;
        }
      }
      throw ultimo;
    }

    async function esperarLinhas(n) {
      await waitFor(cdp, `document.querySelectorAll('.vf-portfolio-row').length === ${n}`, `esperado ${n} linhas de cliente`);
      await sleep(220); // chips (prefetch/cache) terminam de pintar
    }

    /* ═════════ CENÁRIO A — usuário com 1 Squad ═══════════════════════════
       MASTER_SPEC §10.6: com 1 squad NADA aparece. Um filtro de squad com
       uma opção só é ruído, e um cabeçalho de grupo único é uma linha
       inteira gasta para dizer o que já é verdade de toda a lista. */
    await goto("a");
    await esperarLinhas(2);

    await check("A — 1 Squad: sem cabeçalho de grupo e sem seletor de Squad (§10.6)", async () => {
      assert.deepStrictEqual(await cdp.evaluate(LER_GRUPOS), [], "com 1 squad nenhum cabeçalho deveria aparecer");
      assert.strictEqual(await cdp.evaluate(LER_OPCOES_SQUAD), null, "com 1 squad não existe seletor de Squad");
    });

    await check("A — 1 Squad: os dois clientes autorizados aparecem, nenhum escondido", async () => {
      assert.deepStrictEqual((await cdp.evaluate(LER_LINHAS)).sort(), ["aurora", "bravo"]);
    });

    /* ═════════ CENÁRIO B — 3 Squads com principal DEFINIDO ═══════════════ */
    await goto("b");
    await esperarLinhas(4);

    await check("B — multi-Squad: TODOS os squads autorizados viram grupo (nenhum some)", async () => {
      const grupos = await cdp.evaluate(LER_GRUPOS);
      assert.strictEqual(grupos.length, 3, `esperados 3 grupos, veio: ${JSON.stringify(grupos)}`);
      ["SQUAD 6", "SQUAD 3", "SQUAD 1"].forEach((nome) => {
        assert.ok(grupos.some((g) => g.indexOf(nome) === 0), `grupo ${nome} sumiu: ${JSON.stringify(grupos)}`);
      });
    });

    await check("B — squadPrincipalId explícito é respeitado: o principal vem primeiro e é rotulado", async () => {
      const grupos = await cdp.evaluate(LER_GRUPOS);
      assert.ok(grupos[0].indexOf("SQUAD 6") === 0, `o squad principal deveria abrir a lista, veio: ${JSON.stringify(grupos)}`);
      assert.ok(/principal/i.test(grupos[0]), `o grupo principal deveria ser identificado como tal: ${grupos[0]}`);
      const outros = grupos.slice(1).join(" | ");
      assert.ok(!/principal/i.test(outros), `só UM grupo pode ser marcado como principal: ${outros}`);
    });

    await check("B — principal é default de UX, NÃO autorização: os 4 clientes continuam na tela", async () => {
      assert.deepStrictEqual((await cdp.evaluate(LER_LINHAS)).sort(), ["cedro", "delta", "everest", "fenix"]);
      assert.strictEqual(await cdp.evaluate("document.getElementById('cart-squad').value"), "todos",
        "o filtro NÃO pode nascer preso ao squad principal — isso esconderia carteira sem dizer");
    });

    await check("B — o seletor de Squad oferece os 3 squads + Todos, com o principal identificado", async () => {
      const ops = await cdp.evaluate(LER_OPCOES_SQUAD);
      assert.ok(ops, "seletor de Squad deveria existir com 3 squads");
      assert.strictEqual(ops.length, 4, `esperado Todos + 3 squads, veio: ${JSON.stringify(ops)}`);
      assert.ok(ops[0].indexOf("todos|") === 0);
      assert.ok(/principal/i.test(ops[1]), `a primeira opção real deveria ser o principal identificado: ${JSON.stringify(ops)}`);
    });

    /* ═════════ CENÁRIO C — 3 Squads com principal NULL ═══════════════════
       Nenhuma regra pode preencher a decisão humana que ainda não existe. */
    await goto("c");
    await esperarLinhas(3);

    await check("C — principal NULL: nenhum grupo é rotulado como principal", async () => {
      const grupos = await cdp.evaluate(LER_GRUPOS);
      assert.strictEqual(grupos.length, 3, `esperados 3 grupos, veio: ${JSON.stringify(grupos)}`);
      assert.ok(!/principal/i.test(grupos.join(" | ")), `sem squadPrincipalId nada pode ser marcado principal: ${JSON.stringify(grupos)}`);
    });

    await check("C — principal NULL: a ordem é a do backend, nunca 'o primeiro' nem 'o menor id'", async () => {
      const grupos = await cdp.evaluate(LER_GRUPOS);
      // memberships chegam como [3, 1, 6]: nem ordem crescente de id, nem
      // reordenadas. O menor id (1) NÃO abre a lista.
      assert.ok(grupos[0].indexOf("SQUAD 3") === 0, `ordem do backend não foi preservada: ${JSON.stringify(grupos)}`);
      assert.ok(grupos[1].indexOf("SQUAD 1") === 0, `ordem do backend não foi preservada: ${JSON.stringify(grupos)}`);
      assert.ok(grupos[2].indexOf("SQUAD 6") === 0, `ordem do backend não foi preservada: ${JSON.stringify(grupos)}`);
    });

    await check("C — principal NULL não vira filtro: os 3 clientes continuam visíveis", async () => {
      assert.deepStrictEqual((await cdp.evaluate(LER_LINHAS)).sort(), ["gaia", "horizonte", "ipe"]);
    });

    /* ═════════ CENÁRIO D — Admin com bypass ══════════════════════════════
       `squads: []` + carteira inteira. Autorização é do backend; o frontend
       não pode exigir membership para mostrar o que já recebeu. */
    await goto("d", "role=admin");
    await esperarLinhas(3);

    await check("D — Admin sem membership nenhuma: a carteira inteira continua na tela", async () => {
      assert.deepStrictEqual((await cdp.evaluate(LER_LINHAS)).sort(), ["jacaranda", "kiwi", "lotus"]);
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-banner.is-danger').length"), 0, "carteira de admin não pode virar erro");
    });

    await check("D — Admin: o squad REAL de cada cliente é representado, mesmo sem membership", async () => {
      const grupos = await cdp.evaluate(LER_GRUPOS);
      assert.strictEqual(grupos.length, 3, `admin deveria ver os 3 squads da carteira dele, veio: ${JSON.stringify(grupos)}`);
      const texto = grupos.join(" | ");
      assert.ok(/SQUAD 1/.test(texto) && /SQUAD 4/.test(texto), `squads dos clientes sumiram: ${texto}`);
      assert.ok(/SQUAD 8 · LEGADO/.test(texto), `o bucket legado sumiu da carteira do admin: ${texto}`);
      assert.ok(!/SEM SQUAD/.test(texto), `nenhum cliente do admin está sem squad — 'SEM SQUAD' aqui é bug: ${texto}`);
    });

    /* ═════════ CENÁRIO E — Squad 8 · Legado ══════════════════════════════ */
    await goto("e");
    await esperarLinhas(4);

    await check("E — Squad 8 · Legado renderiza com o NOME dele, nunca como 'SEM SQUAD'", async () => {
      const grupos = await cdp.evaluate(LER_GRUPOS);
      const legado = grupos.filter((g) => /LEGADO/.test(g));
      assert.strictEqual(legado.length, 1, `o bucket legado deveria ser um grupo só: ${JSON.stringify(grupos)}`);
      assert.ok(legado[0].indexOf("SQUAD 8 · LEGADO") === 0, `nome do bucket legado errado: ${legado[0]}`);
      assert.ok(/2 clientes/.test(legado[0]), `contagem do bucket legado errada: ${legado[0]}`);
      assert.ok(!/SEM SQUAD/.test(grupos.join(" | ")), "cliente com squad real nunca pode cair em 'SEM SQUAD'");
    });

    await check("E — os clientes legados não desaparecem: 4 linhas, as 2 antigas incluídas", async () => {
      assert.deepStrictEqual((await cdp.evaluate(LER_LINHAS)).sort(), ["manaus", "natal", "olinda", "petropolis"]);
    });

    await check("E — o bucket legado é filtrável como qualquer outro squad", async () => {
      const ops = await cdp.evaluate(LER_OPCOES_SQUAD);
      assert.ok(ops && ops.some((o) => o.indexOf("8|") === 0), `Squad 8 não é oferecido no filtro: ${JSON.stringify(ops)}`);
      await cdp.evaluate(`
        (function(){ var s = document.getElementById('cart-squad'); s.value = '8'; s.dispatchEvent(new Event('change')); })();
      `);
      await waitFor(cdp, "document.querySelectorAll('.vf-portfolio-row').length === 2", "filtrar por Squad 8 não isolou os 2 clientes legados");
      assert.deepStrictEqual((await cdp.evaluate(LER_LINHAS)).sort(), ["olinda", "petropolis"]);
    });

    await check("E — filtrar por Squad é compartilhável: o estado vai para a URL, nunca para a sessão", async () => {
      assert.ok((await cdp.evaluate("location.search")).includes("squad=8"), "o filtro de squad deveria estar na URL");
      assert.strictEqual(await cdp.evaluate("sessionStorage.getItem('vf-squad') || sessionStorage.getItem('vf-carteira-squad')"), null,
        "filtro de squad não pode virar estado de sessão");
    });

    await check("E — ?squad=8 colado numa URL reabre a Carteira já filtrada", async () => {
      await goto("e", "squad=8");
      await waitFor(cdp, "document.querySelectorAll('.vf-portfolio-row').length === 2", "o filtro de squad da URL não foi aplicado no load");
      assert.strictEqual(await cdp.evaluate("document.getElementById('cart-squad').value"), "8");
    });

    /* ═════════ Squad × contexto operacional ══════════════════════════════
       D6/D11: a identidade operacional é { clienteId, clienteSlug,
       clienteContaId }. Squad não entra nela — e trocar o filtro não pode
       encostar nela. */
    await goto("contas");
    await esperarLinhas(5);

    await check("F — cliente com 1 ClienteConta: a linha inteira entra, com a conta certa no destino", async () => {
      await cdp.evaluate("document.querySelector('.vf-portfolio-row[data-slug=quixada] [data-entrar]').click()");
      await waitFor(cdp, "window.__navegacoes.length === 1", "entrar() não navegou para o cliente de 1 conta");
      const href = await cdp.evaluate("window.__navegacoes[0]");
      assert.ok(href.includes("cliente=quixada"), `destino sem o cliente: ${href}`);
      assert.ok(href.includes("conta=1601"), `destino sem a única conta ativa: ${href}`);
    });

    await check("G — cliente com 3 ClienteContas: nome não é clicável, 3 chips acionáveis (nada auto-selecionado)", async () => {
      const r = await cdp.evaluate(`
        (function(){ var li = document.querySelector('.vf-portfolio-row[data-slug=ipiranga]');
          return { temH3: !!li.querySelector('h3.vf-portfolio-row__name'), temEntrar: !!li.querySelector('[data-entrar]'), chips: li.querySelectorAll('[data-conta]').length }; })();
      `);
      assert.strictEqual(r.temH3, true, "com 2+ contas o nome não pode ser clicável");
      assert.strictEqual(r.temEntrar, false);
      assert.strictEqual(r.chips, 3);
    });

    await check("G — escolher a SEGUNDA conta manda a segunda conta: nada volta para is_primary nem para a primeira", async () => {
      await cdp.evaluate(`
        Array.prototype.find.call(document.querySelectorAll('.vf-portfolio-row[data-slug=ipiranga] [data-conta]'), function(b){ return b.dataset.conta === "6022"; }).click()
      `);
      await waitFor(cdp, "window.__navegacoes.length === 2", "entrar() não navegou pela conta escolhida no chip");
      const href = await cdp.evaluate("window.__navegacoes[1]");
      assert.ok(href.includes("cliente=ipiranga"), `destino sem o cliente: ${href}`);
      assert.ok(href.includes("conta=6022"), `destino não levou a conta escolhida: ${href}`);
      assert.ok(!href.includes("conta=6021"), `destino caiu na conta primária: ${href}`);
      assert.strictEqual(await cdp.evaluate("window.VF.context.getContext().clienteContaId"), 6022,
        "o contexto operacional não acompanhou a conta escolhida");
    });

    await check("filtro de Squad NÃO toca o contexto operacional (Squad não é identidade — D6/D11)", async () => {
      const antes = await cdp.evaluate("JSON.stringify(window.VF.context.getContext())");
      await cdp.evaluate(`
        (function(){ var s = document.getElementById('cart-squad'); s.value = '3'; s.dispatchEvent(new Event('change')); })();
      `);
      await sleep(180);
      assert.strictEqual(await cdp.evaluate("JSON.stringify(window.VF.context.getContext())"), antes,
        "trocar o filtro de Squad alterou cliente/conta em contexto");
      assert.strictEqual(await cdp.evaluate("window.VF.context.getState()"), "READY", "o contexto operacional saiu de READY por causa de um filtro de lista");
      // e volta ao estado anterior para os casos seguintes
      await cdp.evaluate(`
        (function(){ var s = document.getElementById('cart-squad'); s.value = 'todos'; s.dispatchEvent(new Event('change')); })();
      `);
      await sleep(120);
    });

    /* ═════════ Responsabilidade ≠ Autorização ════════════════════════════ */
    await check("H/I — responsavelDireto=false NÃO esconde cliente autorizado; =true só marca", async () => {
      const r = await cdp.evaluate(`
        (function(){
          function tag(slug){ var li = document.querySelector('.vf-portfolio-row[data-slug=' + slug + ']'); return li ? !!li.querySelector('.vf-tag') : null; }
          return { recife: tag('recife'), salvador: tag('salvador') };
        })();
      `);
      assert.strictEqual(r.recife, false, "cliente autorizado de outra pessoa deveria aparecer, sem a marca de responsável");
      assert.strictEqual(r.salvador, true, "cliente sob responsabilidade direta deveria trazer a marca");
    });

    await check("H/I — ordenar por 'Meus clientes primeiro' SOBE os meus, mas não some com nenhum", async () => {
      await cdp.evaluate(`
        (function(){ var s = document.getElementById('cart-ordem'); s.value = 'meus'; s.dispatchEvent(new Event('change')); })();
      `);
      await sleep(180);
      const linhas = await cdp.evaluate(LER_LINHAS);
      assert.strictEqual(linhas.length, 5, `ordenação não pode filtrar: ${JSON.stringify(linhas)}`);
      assert.ok(linhas.indexOf("recife") >= 0, "cliente sem responsabilidade direta sumiu ao ordenar por 'Meus'");
      // dentro do Squad 3 (quixada/ipiranga estão no Squad 2), salvador é o
      // responsável direto e precisa vir antes de recife/teresina
      assert.ok(linhas.indexOf("salvador") < linhas.indexOf("recife"), `'Meus' não priorizou o responsável direto: ${JSON.stringify(linhas)}`);
    });

    await check("J — cliente sem operação ativa: estado de configuração, nunca linha clicável", async () => {
      const r = await cdp.evaluate(`
        (function(){ var li = document.querySelector('.vf-portfolio-row[data-slug=teresina]');
          return { temEntrar: !!li.querySelector('[data-entrar]'), chips: li.querySelectorAll('[data-conta]').length, rodape: (li.querySelector('.vf-portfolio-row__foot') || {}).textContent || "" }; })();
      `);
      assert.strictEqual(r.temEntrar, false, "cliente sem conta não pode ser clicável");
      assert.strictEqual(r.chips, 0);
      assert.ok(/Configurar/.test(r.rodape), `estado de configuração não foi oferecido: ${r.rodape}`);
    });

    /* ═════════ CENÁRIO K — Squad autorizado sem clientes visíveis ════════ */
    await goto("k");
    await esperarLinhas(1);

    await check("K — Squad sem clientes: filtrar por ele dá 'nenhum para os filtros', não 'sem carteira'", async () => {
      const ops = await cdp.evaluate(LER_OPCOES_SQUAD);
      assert.ok(ops && ops.some((o) => o.indexOf("4|") === 0), `o squad vazio deveria continuar filtrável: ${JSON.stringify(ops)}`);
      await cdp.evaluate(`
        (function(){ var s = document.getElementById('cart-squad'); s.value = '4'; s.dispatchEvent(new Event('change')); })();
      `);
      await waitFor(cdp, "document.querySelectorAll('.vf-empty').length === 1", "estado vazio de filtro não apareceu");
      const texto = await cdp.evaluate("document.querySelector('.vf-empty').innerText");
      assert.ok(/filtros atuais/i.test(texto), `esperado o vazio DE FILTRO, veio: ${texto}`);
      assert.ok(!/não tem acesso|erro|falha/i.test(texto), `um squad vazio não é erro nem falta de acesso: ${texto}`);
    });

    /* ═════════ CENÁRIO L — portfolio vazio LEGÍTIMO ══════════════════════ */
    await goto("l");
    await waitFor(cdp, "document.querySelectorAll('.vf-empty').length === 1", "vazio legítimo não renderizou");

    await check("L — portfolio vazio é ESTADO, não erro: nenhum banner de falha", async () => {
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-banner.is-danger').length"), 0);
      const texto = await cdp.evaluate("document.querySelector('.vf-empty').innerText");
      assert.ok(/squad/i.test(texto), `com squads, o vazio pode falar de squad: ${texto}`);
    });

    await goto("l-sem-squad");
    await waitFor(cdp, "document.querySelectorAll('.vf-empty').length === 1", "vazio sem squad não renderizou");

    await check("L — usuário SEM squad e sem clientes: a tela não culpa um squad que não existe", async () => {
      const texto = await cdp.evaluate("document.querySelector('.vf-empty').innerText");
      assert.ok(!/aos seus squads/i.test(texto), `mensagem enganosa para quem não tem squad nenhum: ${texto}`);
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-banner.is-danger').length"), 0);
    });

    /* ═════════ Enforcement OFF — cliente sem squad é legítimo ════════════ */
    await goto("enforcement-off");
    await esperarLinhas(4);

    await check("enforcement OFF — clientes com e sem squad convivem; nada some e nada vira erro", async () => {
      assert.deepStrictEqual((await cdp.evaluate(LER_LINHAS)).sort(), ["antigo-dois", "antigo-um", "vitoria", "xique"]);
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-banner.is-danger').length"), 0,
        "squad ausente com enforcement OFF é estado legítimo, não falha");
    });

    await check("enforcement OFF — o grupo 'sem squad' tem cabeçalho próprio, mesmo abrindo a lista", async () => {
      const grupos = await cdp.evaluate(LER_GRUPOS);
      const semSquad = grupos.filter((g) => /SEM SQUAD/.test(g));
      assert.strictEqual(semSquad.length, 1, `'sem squad' deveria ser UM grupo com cabeçalho: ${JSON.stringify(grupos)}`);
      assert.ok(/2 clientes/.test(semSquad[0]), `contagem do grupo sem squad errada: ${semSquad[0]}`);
      assert.strictEqual(grupos.length, 3, `esperados Squad 1, Squad 5 e 'sem squad': ${JSON.stringify(grupos)}`);
    });

    await check("enforcement OFF — 'sem squad' fica por último; squad real nunca é misturado nele", async () => {
      const grupos = await cdp.evaluate(LER_GRUPOS);
      assert.ok(/SEM SQUAD/.test(grupos[grupos.length - 1]), `'sem squad' deveria fechar a lista: ${JSON.stringify(grupos)}`);
      const linhas = await cdp.evaluate(LER_LINHAS);
      assert.ok(linhas.indexOf("vitoria") < linhas.indexOf("antigo-um"), `cliente com squad real caiu depois do bucket sem squad: ${JSON.stringify(linhas)}`);
    });

    /* ═════════ Shell — carteira vazia numa página operacional ════════════
       Na Carteira (scope=global) NO_PORTFOLIO é estado satisfeito e o painel
       do Shell nem aparece; quem o vê é uma página operacional. */
    await goto("l", "escopo=account");
    await waitFor(cdp, "window.VF.context.getState() === 'NO_PORTFOLIO'", "shell não chegou a NO_PORTFOLIO");

    await check("Shell — carteira vazia COM squad: pode mandar ao coordenador do squad", async () => {
      const texto = await cdp.evaluate("document.querySelector('.vf-shell__state').innerText");
      assert.ok(/squad/i.test(texto), `com squad, o texto pode falar de squad: ${texto}`);
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-shell__state .vf-banner.is-danger').length"), 0,
        "carteira vazia é estado, nunca erro");
    });

    await goto("l-sem-squad", "escopo=account");
    await waitFor(cdp, "window.VF.context.getState() === 'NO_PORTFOLIO'", "shell não chegou a NO_PORTFOLIO sem squad");

    await check("Shell — carteira vazia SEM squad nenhum: não culpa um vínculo que não existe", async () => {
      const texto = await cdp.evaluate("document.querySelector('.vf-shell__state').innerText");
      assert.ok(!/aos seus squads/i.test(texto), `mensagem enganosa para quem não tem squad: ${texto}`);
      assert.ok(/carteira/i.test(texto), `o texto ainda precisa dizer o que houve: ${texto}`);
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-shell__state .vf-banner.is-danger').length"), 0);
    });

    /* ═════════ M/N — falhas dos dois endpoints ═══════════════════════════ */
    currentFixture = { cenario: "b", falhaMePortfolio: true, falhaMeContext: false };
    await navegarCru("b", "Carteira não montou na queda de /me/portfolio");
    await waitFor(cdp, "document.querySelectorAll('.vf-portfolio-row').length === 4", "a queda não listou a carteira pelo /me/context");
    await sleep(260);

    await check("N — /me/portfolio falhando: a Carteira cai para /me/context, sem banner de erro", async () => {
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-banner.is-danger').length"), 0,
        "falha do endpoint rico não pode virar erro de carteira");
      assert.deepStrictEqual((await cdp.evaluate(LER_LINHAS)).sort(), ["cedro", "delta", "everest", "fenix"]);
    });

    await check("N — na queda o agrupamento por Squad sobrevive (squadId existe nos dois payloads)", async () => {
      const grupos = await cdp.evaluate(LER_GRUPOS);
      assert.strictEqual(grupos.length, 3, `agrupamento perdido na queda: ${JSON.stringify(grupos)}`);
      assert.ok(grupos[0].indexOf("SQUAD 6") === 0, `principal de /me/context ignorado na queda: ${JSON.stringify(grupos)}`);
    });

    currentFixture = { cenario: "b", falhaMePortfolio: false, falhaMeContext: true };
    await navegarCru("b", "Carteira não montou com /me/context falhando");
    await waitFor(cdp, "window.VF.context.getState() === 'PORTFOLIO_ERROR'", "500 em /me/context deveria virar PORTFOLIO_ERROR");

    await check("M — /me/context falhando: erro de carteira EXPLÍCITO, distinto de carteira vazia", async () => {
      // O painel de estado do Shell é o que o usuário VÊ: com scope=global e
      // PORTFOLIO_ERROR o shell esconde o `main` inteiro, então o banner que
      // a própria Carteira renderiza fica atrás dele. Medir o visível.
      await waitFor(cdp, "document.querySelector('.vf-shell__state .vf-banner.is-danger')", "banner de erro do Shell não apareceu");
      const texto = await cdp.evaluate("document.querySelector('.vf-shell__state').innerText");
      assert.ok(/não foi possível carregar/i.test(texto), `esperado erro de carregamento, veio: ${texto}`);
      assert.ok(!/nenhum cliente/i.test(texto), `falha técnica não pode virar 'você não tem clientes': ${texto}`);
      assert.strictEqual(await cdp.evaluate("document.getElementById('vf-shell-main').hidden"), true,
        "com a carteira sem carregar, o conteúdo não pode ser exibido como se estivesse completo");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-empty').length"), 0,
        "erro técnico nunca pode aparecer como estado vazio");
    });

    /* ═════════ Responsividade — as duas regressões da Wave 1 ═════════════
       Corrigidas nesta branch e, até aqui, sem NADA que as prendesse: as
       duas passavam por baixo de toda a bateria porque nenhuma suíte media
       a Carteira dentro do Shell em tela estreita. Ambas foram achadas no
       QA visual e confirmadas idênticas em origin/main (pré-existentes).

       O agrupamento por Squad é justamente o que se vai conferir no celular
       no dia do rollout, então estas asserções moram aqui e não numa suíte
       genérica de layout. */
    async function medirEmLargura(w, h) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });
      await goto("responsivo");
      await esperarLinhas(5);
      await cdp.evaluate("window.scrollTo(0, 0)");
      await sleep(200);
      return cdp.evaluate(`(function(){
        function caixa(sel){ var e = document.querySelector(sel); if (!e) return null; var r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; }
        var barra = caixa('.vf-shell__contextbar');
        var bloco = caixa('.vf-shell__context');
        var busca = document.getElementById('cart-busca');
        return {
          naBarra: !!(barra && document.querySelector('.vf-shell__contextbar .vf-shell__context')),
          barra: barra,
          bloco: bloco,
          alturaBusca: busca ? Math.round(busca.getBoundingClientRect().height) : null,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          grupos: Array.prototype.map.call(document.querySelectorAll('.vf-portfolio-group'), function(g){ return g.textContent.replace(/\s+/g, ' ').trim(); })
        };
      })()`);
    }

    for (const [largura, altura] of [[900, 800], [390, 780]]) {
      const m = await medirEmLargura(largura, altura);

      await check(`responsividade ${largura}px — bloco de contexto NÃO vaza para fora da barra`, async () => {
        // A regra base do bloco é `position: sticky; top: 59px`. Ao ser
        // reparentado para a barra ele vira `relative`, e ali um `top`
        // herdado DESLOCA a pintura sem ocupar espaço no fluxo: a barra
        // media 106px enquanto o bloco era pintado 59px abaixo, caindo em
        // cima do `main`. Medido em 390px antes do conserto: barra
        // 253→359, bloco 320→409.
        assert.ok(m.naBarra, `em ${largura}px o contexto deveria estar reparentado na barra`);
        assert.ok(m.bloco.top >= m.barra.top, `bloco começa acima da barra (${m.bloco.top} < ${m.barra.top})`);
        assert.ok(m.bloco.bottom <= m.barra.bottom, `bloco vaza ${m.bloco.bottom - m.barra.bottom}px abaixo da barra — volta a cair em cima do conteúdo`);
      });

      await check(`responsividade ${largura}px — busca não vira um campo de 240px de altura`, async () => {
        // Em coluna (`.vf-toolbar` vira `flex-direction: column` em ≤900px)
        // o `flex-basis: 240px` da busca passa a valer na ALTURA. Antes do
        // conserto: 240px de campo e ~350-396px de barra inteira.
        assert.ok(m.alturaBusca !== null, "o campo de busca deveria existir");
        assert.ok(m.alturaBusca > 0 && m.alturaBusca < 60, `campo de busca com altura implausível: ${m.alturaBusca}px`);
      });

      await check(`responsividade ${largura}px — sem overflow horizontal, agrupamento de Squad intacto`, async () => {
        assert.ok(m.overflow <= 0, `overflow horizontal de ${m.overflow}px`);
        const texto = m.grupos.join(" | ");
        assert.ok(/SQUAD 8 · LEGADO/.test(texto), `o bucket legado sumiu em ${largura}px: ${texto}`);
        assert.ok(/SEM SQUAD/.test(texto), `o grupo sem squad sumiu em ${largura}px: ${texto}`);
        assert.ok(/principal/i.test(texto), `a marca do squad principal sumiu em ${largura}px: ${texto}`);
      });
    }

    await cdp.send("Emulation.clearDeviceMetricsOverride", {});

    /* ═════════ Higiene ═══════════════════════════════════════════════════ */
    await check("nenhuma requisição escapou para fora das fixtures (zero rede de produção)", async () => {
      const fora = urlsPedidas.filter((u) => !u.startsWith(`http://127.0.0.1:${serverPort}/`) && !u.startsWith("data:") && u !== "about:blank");
      assert.deepStrictEqual(fora, [], `requisições fora do harness: ${JSON.stringify(fora)}`);
    });

    await check("sem erros de console em nenhum cenário", async () => {
      const relevantes = consoleErrors.filter((m) => !/favicon/i.test(m) && !/Failed to load resource/i.test(m));
      assert.strictEqual(relevantes.length, 0, `erros de console: ${JSON.stringify(relevantes)}`);
    });

    console.log(`\n✓ ${checks} verificações de prontidão de UX para o rollout de Squads (A–N)`);
  } finally {
    if (cdp) cdp.close();
    chrome.kill("SIGTERM");
    server.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
