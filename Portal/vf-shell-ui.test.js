/*
 * Smoke test de interface em Chrome headless para vf-shell.js (F0.5) —
 * MASTER_SPEC §21.2, casos S01-S13, mais as verificações extra pedidas na
 * unidade: um único `.vf-shell__context` no documento, `[hidden]` realmente
 * escondido por estilo computado, ausência de overflow horizontal e
 * comportamento nos quatro breakpoints de §9.6/§19.
 *
 * Padrão idêntico a Portal/central-margem-ui.test.js: spawn de
 * `google-chrome --headless=new` e Chrome DevTools Protocol puro, sem
 * dependências externas (sem puppeteer).
 *
 * Em vez de mockar `window.__algumaCoisaApi__` (padrão do teste de
 * central-margem, que injeta um cliente HTTP fake), este teste roda o
 * caminho de PRODUÇÃO de vf-shell.js de verdade (`bootProduction()`,
 * vf-context real, vf-api real) contra um backend fake: o próprio
 * `http.createServer` deste teste responde `/operacao/cliente-360/clientes`
 * e `/clientes/:cliente/contas` com fixtures, e uma página `harness.html`
 * (também servida por ele) aponta `<meta name="vf-api-base">` para si
 * mesmo. É o mesmo contrato que o navegador real vai encontrar.
 */
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PORTAL_DIR = __dirname;

/* ── Fixtures — mesmo formato dos payloads reais (§18.1/§10.8) ──────────── */

function grant(status) {
  return status ? { id: 900, ml_user_id: "1099887766", token_status: status, is_primary: false } : null;
}
function base(id, nome) {
  return { vinculo_id: 500 + id, base_id: id, slug: "base-" + id, nome, resolvido_por: "conta" };
}

const N97 = {
  id: 87, nome: "N97 Comercial", slug: "n97", ativo: true,
  temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100,
  statusOperacional: "pronto", ultimaSincronizacao: "2026-08-25T14:00:00Z", pendencias: [],
};
const N97_CONTAS = [
  { id: 42, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre 1", slug: "ml-1", external_account_id: "182993004", is_primary: true, ativo: true, grant: grant("valid"), base: base(9, "Custo 2026") },
  { id: 43, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre 2", slug: "ml-2", external_account_id: "204118872", is_primary: false, ativo: true, grant: grant("valid"), base: base(9, "Custo 2026") },
  { id: 44, cliente_id: 87, marketplace: "shopee", nome: "Shopee", slug: "shopee", external_account_id: "SP-77120", is_primary: true, ativo: true, grant: null, base: base(14, "Custo Shopee") },
  { id: 45, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre (antiga)", slug: "ml-antiga", external_account_id: "288100933", is_primary: false, ativo: false, grant: null, base: null },
];

const EXTRA = { id: 88, nome: "Extra Máquinas", slug: "extra", ativo: true, temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100, statusOperacional: "pronto", ultimaSincronizacao: "2026-08-25T16:00:00Z", pendencias: [] };
const EXTRA_CONTAS = [
  { id: 51, cliente_id: 88, marketplace: "meli", nome: "Mercado Livre", slug: "ml", external_account_id: "119847221", is_primary: true, ativo: true, grant: grant("valid"), base: base(11, "Custo Extra") },
];

const FILLERS = Array.from({ length: 7 }, (_, i) => ({
  id: 200 + i, nome: `Filler ${i + 1}`, slug: `filler-${i + 1}`, ativo: true,
  temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100,
  statusOperacional: "pronto", ultimaSincronizacao: null, pendencias: [],
}));
const FILLER_CONTAS = Object.fromEntries(
  FILLERS.map((c) => [c.slug, [{ id: 300 + c.id, cliente_id: c.id, marketplace: "meli", nome: "Mercado Livre", slug: "ml", external_account_id: String(600000 + c.id), is_primary: true, ativo: true, grant: grant("valid"), base: base(20, "Custo") }]])
);

const PORTFOLIO_MAIN = { ok: true, clientes: [N97, EXTRA, ...FILLERS] };
const CONTAS_MAIN = { n97: N97_CONTAS, extra: EXTRA_CONTAS, ...FILLER_CONTAS };

const PORTFOLIO_SMALL = { ok: true, clientes: [N97, EXTRA] };

/* ── C1 — fixture no formato real de GET /me/context (meService.js:66-90).
   Mais pobre que o legado de propósito: sem prontidão, sem pendências. O
   que ele tem e o outro não: `squads`, `squadPrincipalId` e `contasAtivas`
   por cliente. ─────────────────────────────────────────────────────────── */
const ME_CONTEXT = {
  ok: true,
  user: { id: 12, nome: "Pedro Gomes", email: "pedro@venforce.com", role: "user" },
  squads: [{ id: 3, nome: "Squad Alpha", slug: "alpha", principal: true, funcao: "analista", ativo: true }],
  squadPrincipalId: 3,
  clientes: [
    { id: 87, slug: "n97", nome: "N97 Comercial", squadId: 3, responsavelDireto: true, contasAtivas: 3 },
    { id: 88, slug: "extra", nome: "Extra Máquinas", squadId: 3, responsavelDireto: false, contasAtivas: 1 },
    ...FILLERS.map((c) => ({ id: c.id, slug: c.slug, nome: c.nome, squadId: 3, responsavelDireto: false, contasAtivas: 1 })),
  ],
  portfolio: { totalClientes: 9 },
  permissoes: { podeAdministrar: false },
};

/* ── Servidor: arquivos estáticos do Portal + backend fake ──────────────── */

let currentFixture = { portfolio: PORTFOLIO_MAIN, contas: CONTAS_MAIN, failPortfolio: false };
let serverPort = 0;
let meContextRequestCount = 0;
let legadoPortfolioRequestCount = 0;

function harnessHtml(scope, moduleId) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="vf-api-base" content="http://127.0.0.1:${serverPort}">
<link rel="stylesheet" href="/css/vf-tokens-v2.css">
<link rel="stylesheet" href="/css/vf-components-v2.css">
<link rel="stylesheet" href="/css/vf-shell.css">
</head>
<body class="vf-page" data-vf-scope="${scope}" data-vf-module="${moduleId}">
<script>
  var qs = new URLSearchParams(location.search);
  localStorage.setItem("vf-token", "test-token");
  localStorage.setItem("vf-user", JSON.stringify({ id: Number(qs.get("uid") || 12), nome: qs.get("nome") || "Pedro Gomes", role: qs.get("role") || "user" }));
  if (qs.get("preseed")) {
    sessionStorage.setItem("vf-ctx", JSON.stringify({ v: 1, userId: Number(qs.get("uid") || 12), clienteId: 87, clienteSlug: "n97", clienteContaId: 42 }));
  }
</script>
<main id="conteudo-de-teste"><p>Conteúdo da página migrada.</p></main>
<script type="module" src="/vf-shell.js"></script>
</body></html>`;
}

function startServer() {
  const server = http.createServer((req, res) => {
    res.setHeader("Connection", "close"); // ver nota sobre o flake de socket, no fim de startServer()
    const u = new URL(req.url, "http://localhost");

    if (u.pathname === "/harness.html") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(harnessHtml(u.searchParams.get("scope") || "account", u.searchParams.get("module") || "central-vendas"));
      return;
    }

    // C1 — GET /me/context é a carteira autoritativa do shell. Sem fixture,
    // responde 404 e o shell cai para /operacao/cliente-360/clientes: é essa
    // queda que todos os cenários S01-S13 abaixo continuam exercitando.
    if (u.pathname === "/me/context") {
      if (!currentFixture.meContext) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"ok":false}'); return; }
      meContextRequestCount += 1;
      if (currentFixture.meContext === "erro") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, erro: "Falha simulada em /me/context." }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(currentFixture.meContext));
      return;
    }

    if (u.pathname === "/operacao/cliente-360/clientes") {
      legadoPortfolioRequestCount += 1;
      res.writeHead(currentFixture.failPortfolio ? 500 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(currentFixture.failPortfolio ? { ok: false, erro: "Falha simulada." } : currentFixture.portfolio));
      return;
    }

    const contasMatch = u.pathname.match(/^\/clientes\/([^/]+)\/contas$/);
    if (contasMatch) {
      const slug = decodeURIComponent(contasMatch[1]);
      const contas = currentFixture.contas[slug];
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
    if (!target.startsWith(path.resolve(PORTAL_DIR) + path.sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(target, (err, contents) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      const ext = path.extname(target);
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
      res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(contents);
    });
  });
  /* Flake PRÉ-EXISTENTE do harness (nunca do produto) — medido nesta missão
     com Network/Log/Runtime instrumentados: em ~40% das execuções UMA
     requisição desta suíte não era entregue ao Chrome, sem exceção de JS,
     sem `Network.loadingFailed` e sem entrada de Log. Como a vítima é
     sorteada, o sintoma variava: ora `/vf-config.js` (importado por
     vf-api.js) ficava pendente e o grafo de módulos nunca executava — daí
     `window.VF === undefined` com `document.readyState === "complete"` —,
     ora era `/me/context` ou `/clientes/:slug/contas`, e o contexto caía em
     PORTFOLIO_ERROR/NO_ACTIVE_ACCOUNT com a fixture mandando o contrário.
     A causa é reúso de socket keep-alive entre cenários (o Node fecha a
     conexão ociosa em 5s, padrão, enquanto o Chrome ainda a considera
     reutilizável). Fechar a conexão a cada resposta e afrouxar o timeout
     ocioso derruba a taxa de falha; o retorno explícito de `goto()` cobre o
     resto. Nada aqui é produto: é o servidor do próprio teste. */
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { serverPort = server.address().port; resolve(server); }));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitChrome(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch (_) { /* aguardando */ }
    await sleep(50);
  }
  throw new Error("Chrome DevTools não iniciou.");
}

class Cdp {
  constructor(url) { this.socket = new WebSocket(url); this.nextId = 1; this.pending = new Map(); }
  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
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
  for (let i = 0; i < 120; i++) {
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

async function run() {
  const server = await startServer();
  const debugPort = 14000 + Math.floor(Math.random() * 1000);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=/tmp/vf-shell-ui-${process.pid}`,
    "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    await waitChrome(debugPort);
    const targetResponse = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" });
    const target = await targetResponse.json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    /* Renavega quando o boot terminou num estado que a fixture ATIVA não
       pede — nunca quando ela pede (failPortfolio / meContext="erro"
       continuam falhando de verdade, que é o que S13 e o cenário de 500
       medem). Os contadores são zerados a cada tentativa para a asserção de
       "1 GET /me/context" medir só a carga que vingou. Ver a nota do flake
       de socket em startServer(). */
    async function goto(qs) {
      const url = `http://127.0.0.1:${serverPort}/harness.html?${qs}`;
      let ultimo = null;
      for (let tentativa = 1; tentativa <= 3; tentativa++) {
        meContextRequestCount = 0;
        legadoPortfolioRequestCount = 0;
        await cdp.send("Page.navigate", { url });
        try {
          await waitFor(cdp, "window.VF && window.VF.shell", "vf-shell não montou");
          await waitFor(cdp, "window.VF.context.getState() !== 'BOOT'", "contexto não saiu de BOOT");
        } catch (err) {
          ultimo = err;
          continue;
        }
        const erroDeCarteiraNaoPedido =
          !currentFixture.failPortfolio &&
          currentFixture.meContext !== "erro" &&
          (await cdp.evaluate("window.VF.context.getState() === 'PORTFOLIO_ERROR'"));
        if (!erroDeCarteiraNaoPedido) return;
        ultimo = new Error("boot caiu em PORTFOLIO_ERROR com a fixture pedindo carteira válida");
      }
      throw ultimo;
    }

    /* ══════════════════════ NAV MAIN — scope=account, usuário comum ═══ */
    currentFixture = { portfolio: PORTFOLIO_MAIN, contas: CONTAS_MAIN, failPortfolio: false };
    await goto("scope=account&module=central-vendas");

    await check("S11 — scope=account sem contexto: conteúdo não renderiza, painel de estado aparece", async () => {
      assert.strictEqual(await cdp.evaluate("window.VF.context.getState()"), "NO_CLIENT");
      assert.strictEqual(await cdp.evaluate("document.getElementById('vf-shell-main').hidden"), true);
      assert.strictEqual(await cdp.evaluate("document.querySelector('.vf-shell__state').hidden"), false);
      assert.ok((await cdp.evaluate("document.querySelector('.vf-shell__state').innerText")).includes("Selecione um cliente"));
    });

    await check("único .vf-shell__context no documento", async () => {
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-shell__context').length"), 1);
    });

    await check("S02 — dropdown de cliente: listbox, busca a partir de 8, typeahead filtra", async () => {
      await cdp.evaluate("document.getElementById('vf-cliente-trigger').click()");
      await waitFor(cdp, "document.querySelector('.vf-shell__dropdown')", "dropdown não abriu");
      assert.strictEqual(await cdp.evaluate("document.querySelector('.vf-shell__dropdown').getAttribute('role')"), "listbox");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-shell__dropdown [role=option]').length"), 9);
      assert.ok(await cdp.evaluate("Boolean(document.querySelector('.vf-shell__dropdown-search input'))"), "busca não apareceu com 9 clientes");
      await cdp.evaluate(`
        var i = document.querySelector('.vf-shell__dropdown-search input');
        i.focus(); i.value = 'n97'; i.dispatchEvent(new Event('input', { bubbles: true }));
      `);
      const visiveis = await cdp.evaluate("Array.prototype.filter.call(document.querySelectorAll('.vf-menu__item'), function(x){return !x.hidden;}).length");
      assert.strictEqual(visiveis, 1, "busca não filtrou para 1 item");
      await cdp.evaluate("document.querySelector('.vf-shell__dropdown-search input').value=''; document.querySelector('.vf-shell__dropdown-search input').dispatchEvent(new Event('input',{bubbles:true}))");
    });

    await check("S02 — teclado: ArrowDown/Home/End movem foco entre itens visíveis", async () => {
      await cdp.evaluate("document.querySelector('.vf-shell__dropdown-search input').focus()");
      await cdp.evaluate("document.querySelector('.vf-shell__dropdown-search input').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))");
      const primeiro = await cdp.evaluate("document.activeElement.textContent.trim().startsWith('N97')");
      assert.ok(primeiro, "ArrowDown não foi para o primeiro item (N97)");
      await cdp.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))");
      const ultimoTxt = await cdp.evaluate("document.activeElement.textContent");
      assert.ok(ultimoTxt.includes("Filler 7"), "End não foi para o último item");
      await cdp.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");
      const primeiroDeNovo = await cdp.evaluate("document.activeElement.textContent");
      assert.ok(primeiroDeNovo.startsWith("N97"), "Home não voltou ao primeiro item");
    });

    await check("S09 — Esc fecha o dropdown e devolve o foco ao gatilho", async () => {
      await cdp.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await waitFor(cdp, "!document.querySelector('.vf-shell__dropdown')", "dropdown não fechou com Esc");
      assert.strictEqual(await cdp.evaluate("document.activeElement && document.activeElement.id"), "vf-cliente-trigger");
    });

    await check("S04/S05 — selecionar N97 (2+ contas ativas): ACCOUNT_CHOICE_REQUIRED, dropdown habilitado, sem pré-marcação; conta inativa esmaecida", async () => {
      await cdp.evaluate("document.getElementById('vf-cliente-trigger').click()");
      await waitFor(cdp, "document.querySelector('.vf-shell__dropdown')", "dropdown não abriu");
      await cdp.evaluate("Array.prototype.find.call(document.querySelectorAll('.vf-menu__item'), function(x){return x.textContent.trim().startsWith('N97');}).click()");
      await waitFor(cdp, "window.VF.context.getState() === 'ACCOUNT_CHOICE_REQUIRED'", "não chegou a ACCOUNT_CHOICE_REQUIRED");

      assert.strictEqual(await cdp.evaluate("document.getElementById('vf-op-trigger').disabled"), false, "seletor de operação deveria estar habilitado com 3 contas ativas");
      await cdp.evaluate("document.getElementById('vf-op-trigger').click()");
      await waitFor(cdp, "document.querySelector('.vf-shell__dropdown')", "dropdown de operação não abriu");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-shell__dropdown [role=option][aria-selected=true]').length"), 0, "não deveria haver pré-marcação");

      const inativo = await cdp.evaluate(`
        (function(){
          var it = Array.prototype.find.call(document.querySelectorAll('.vf-menu__item'), function(x){ return x.textContent.indexOf('antiga') >= 0; });
          if (!it) return null;
          return { disabled: it.getAttribute('aria-disabled'), classe: it.className, texto: it.textContent };
        })();
      `);
      assert.ok(inativo, "conta inativa não apareceu no dropdown");
      assert.strictEqual(inativo.disabled, "true");
      assert.ok(inativo.classe.includes("is-disabled"));
      assert.ok(inativo.texto.includes("(inativa)"));

      const estadoAntes = await cdp.evaluate("window.VF.context.getState()");
      await cdp.evaluate("Array.prototype.find.call(document.querySelectorAll('.vf-menu__item'), function(x){return x.textContent.indexOf('antiga')>=0;}).click()");
      await sleep(80);
      assert.strictEqual(await cdp.evaluate("window.VF.context.getState()"), estadoAntes, "clicar na conta inativa não deveria mudar o estado");
    });

    await check("S06/S07/S10 — escolher Shopee: 4 módulos ML-only colapsam, aria-live anuncia o contexto", async () => {
      await cdp.evaluate("Array.prototype.find.call(document.querySelectorAll('.vf-menu__item'), function(x){return x.textContent.indexOf('Shopee')>=0;}).click()");
      await waitFor(cdp, "window.VF.context.getState() === 'READY'", "não chegou a READY na conta Shopee");

      const grupo = await cdp.evaluate(`
        (function(){
          var det = document.querySelector('.vf-shell__unavailable');
          if (!det) return null;
          return { summary: det.querySelector('summary').textContent, itens: det.querySelectorAll('.vf-shell__item').length };
        })();
      `);
      // F2.3 — "margem" ganhou marketplaces:["meli"] (achado lendo o código
      // real: Motor de Margem só resolve base MELI). 3 → 4 módulos ML-only.
      assert.ok(grupo, "grupo de indisponíveis não apareceu com 4 módulos ML-only");
      assert.ok(grupo.summary.includes("Shopee") && grupo.summary.includes("4"));
      assert.strictEqual(grupo.itens, 4);

      const adsItem = await cdp.evaluate(`
        (function(){ var a = document.querySelector('.vf-shell__item[data-module=ads]'); return a ? { disabled: a.getAttribute('aria-disabled'), title: a.title } : null; })();
      `);
      assert.strictEqual(adsItem.disabled, "true");
      assert.ok(adsItem.title.includes("Shopee"));

      assert.strictEqual(await cdp.evaluate("document.getElementById('vf-shell-announcer').textContent"), "Contexto: N97 Comercial, Shopee");

      assert.strictEqual(await cdp.evaluate("document.getElementById('vf-shell-main').hidden"), false, "conteúdo deveria renderizar em READY");
    });

    await check("Convergência #4 §15 — Financeiro roteia para V3 com conta Shopee em tela", async () => {
      const href = await cdp.evaluate("document.querySelector('.vf-shell__item[data-module=financeiro]').getAttribute('href')");
      assert.ok(href && href.startsWith("financeiro-v3.html"), `esperado financeiro-v3.html com Shopee em tela, achei: ${href}`);
      assert.strictEqual(await cdp.evaluate("document.querySelector('.vf-shell__item[data-module=financeiro]').getAttribute('aria-disabled')"), null, "Financeiro não pode ficar desabilitado nem para Shopee");
    });

    await check("Convergência #4 §15 — Financeiro roteia para V3 com conta Mercado Livre em tela (não é hardcode de um marketplace só)", async () => {
      await cdp.evaluate("document.getElementById('vf-op-trigger').click()");
      await waitFor(cdp, "document.querySelector('.vf-shell__dropdown')", "dropdown de operação não abriu");
      await cdp.evaluate("Array.prototype.find.call(document.querySelectorAll('.vf-menu__item'), function(x){return x.textContent.indexOf('Mercado Livre 1')>=0;}).click()");
      await waitFor(cdp, "window.VF.context.getState() === 'READY'", "não voltou a READY na conta Mercado Livre 1");
      const href = await cdp.evaluate("document.querySelector('.vf-shell__item[data-module=financeiro]').getAttribute('href')");
      assert.ok(href && href.startsWith("financeiro-v3.html"), `esperado financeiro-v3.html com MELI em tela, achei: ${href}`);
      const outrosItens = await cdp.evaluate(`
        (function(){
          var mods = ['visao', 'central-vendas', 'ads', 'anuncios', 'margem', 'diagnosticos', 'automacoes'];
          return mods.map(function(id){
            var a = document.querySelector('.vf-shell__item[data-module=' + id + ']');
            return a ? a.getAttribute('href') : 'AUSENTE';
          });
        })();
      `);
      assert.ok(!outrosItens.some((h) => h === "AUSENTE" || /financeiro-v3\.html/.test(h)), `só o item Financeiro pode ter ganhado rotaPorMarketplace, os outros continuam com rota fixa: ${JSON.stringify(outrosItens)}`);
    });

    await check("S01 — collapse: alterna classe e persiste em localStorage, sem escolher width em transition", async () => {
      assert.strictEqual(await cdp.evaluate("localStorage.getItem('vf-sidebar-collapsed')"), null);
      await cdp.evaluate("document.querySelector('.vf-shell__collapse').click()");
      assert.strictEqual(await cdp.evaluate("document.querySelector('.vf-shell__sidebar').classList.contains('is-collapsed')"), true);
      assert.strictEqual(await cdp.evaluate("localStorage.getItem('vf-sidebar-collapsed')"), "1");
      const transProp = await cdp.evaluate("getComputedStyle(document.querySelector('.vf-shell__sidebar')).transitionProperty");
      assert.ok(!String(transProp).includes("width"), `transição não pode animar width (achou: ${transProp})`);
      await cdp.evaluate("document.querySelector('.vf-shell__collapse').click()");
      assert.strictEqual(await cdp.evaluate("localStorage.getItem('vf-sidebar-collapsed')"), "0");
    });

    await check("S03 — cliente com 1 conta: auto-seleciona e o seletor de operação fica desabilitado (visível, não escondido)", async () => {
      await cdp.evaluate("document.getElementById('vf-cliente-trigger').click()");
      await waitFor(cdp, "document.querySelector('.vf-shell__dropdown')", "dropdown não abriu");
      await cdp.evaluate("Array.prototype.find.call(document.querySelectorAll('.vf-menu__item'), function(x){return x.textContent.trim().startsWith('Extra');}).click()");
      await waitFor(cdp, "window.VF.context.getState() === 'READY'", "Extra Máquinas não chegou a READY (auto-seleção falhou)");
      assert.strictEqual(await cdp.evaluate("document.getElementById('vf-op-trigger').disabled"), true);
      assert.strictEqual(await cdp.evaluate("document.getElementById('vf-op-trigger').hidden"), false, "seletor de 1 conta deve continuar visível, só desabilitado");
    });

    await check("S12 (negativo) — usuário comum não vê Administração", async () => {
      assert.strictEqual(await cdp.evaluate("Boolean(document.querySelector('.vf-shell__admin'))"), false);
    });

    await check("sem overflow horizontal em 1440px", async () => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(150);
      const overflow = await cdp.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
      assert.ok(overflow <= 1, `overflow horizontal em 1440px: ${overflow}px`);
    });

    await check("breakpoint 861–1200: contexto reparenta para a barra horizontal, continua único no documento", async () => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
      await cdp.evaluate("window.dispatchEvent(new Event('resize'))");
      await sleep(250);
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-shell__context').length"), 1);
      assert.strictEqual(await cdp.evaluate("document.getElementById('vf-shell-contextbar').hidden"), false);
      assert.strictEqual(await cdp.evaluate("document.getElementById('vf-shell-contextbar').contains(document.querySelector('.vf-shell__context'))"), true);
      const overflow = await cdp.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
      assert.ok(overflow <= 1, `overflow horizontal em 1000px: ${overflow}px`);
    });

    await check("breakpoint ≤860: barra horizontal continua, ainda um único contexto", async () => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
      await cdp.evaluate("window.dispatchEvent(new Event('resize'))");
      await sleep(250);
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-shell__context').length"), 1);
      assert.strictEqual(await cdp.evaluate("document.getElementById('vf-shell-contextbar').hidden"), false);
      const overflow = await cdp.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
      assert.ok(overflow <= 1, `overflow horizontal em 700px: ${overflow}px`);
    });

    await check("voltando a ≥1440: contexto reparenta de volta para a sidebar, ainda único", async () => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await cdp.evaluate("window.dispatchEvent(new Event('resize'))");
      await sleep(250);
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-shell__context').length"), 1);
      assert.strictEqual(await cdp.evaluate("document.getElementById('vf-shell-contextbar').hidden"), true);
      assert.strictEqual(await cdp.evaluate("document.querySelector('.vf-shell__sidebar').contains(document.querySelector('.vf-shell__context'))"), true);
    });

    await cdp.send("Emulation.clearDeviceMetricsOverride", {});

    /* ══════════════════════ NAV GLOBAL — contexto preservado, rebaixado ═ */
    currentFixture = { portfolio: PORTFOLIO_SMALL, contas: CONTAS_MAIN, failPortfolio: false };
    await goto("scope=global&module=ferramentas&preseed=1");

    await check("S08 — página global: contexto rebaixado com rótulo 'contexto ativo', nunca 'pausado'", async () => {
      await waitFor(cdp, "window.VF.context.getState() === 'READY'", "contexto pré-semeado não chegou a READY");
      assert.strictEqual(await cdp.evaluate("document.querySelector('.vf-shell__context').classList.contains('is-muted')"), true);
      assert.ok((await cdp.evaluate("document.querySelector('.vf-shell__context').innerText")).includes("contexto ativo"));
      assert.ok(!(await cdp.evaluate("document.body.innerText")).toLowerCase().includes("pausado"), "termo 'pausado' está proibido (D15)");
    });

    await check("S11 (positivo) — scope=global nunca bloqueia o conteúdo, mesmo sem interação", async () => {
      assert.strictEqual(await cdp.evaluate("document.getElementById('vf-shell-main').hidden"), false);
      assert.strictEqual(await cdp.evaluate("document.body.classList.contains('vf-shell-blocked')"), false);
    });

    /* ══════════════════════ NAV ADMIN ══════════════════════════════════ */
    currentFixture = { portfolio: PORTFOLIO_SMALL, contas: CONTAS_MAIN, failPortfolio: false };
    await goto("scope=global&module=ferramentas&role=admin&nome=Ana%20Ribeiro");

    await check("S12 (positivo) — role=admin mostra a seção Administração", async () => {
      const admin = await cdp.evaluate(`
        (function(){ var d = document.querySelector('.vf-shell__admin'); return d ? d.querySelector('summary').textContent : null; })();
      `);
      assert.strictEqual(admin, "Administração");
    });

    /* ══════════════════════ NAV PORTFOLIO_ERROR ════════════════════════ */
    currentFixture = { portfolio: PORTFOLIO_SMALL, contas: CONTAS_MAIN, failPortfolio: true };
    await goto("scope=global&module=ferramentas");

    await check("S13 — PORTFOLIO_ERROR: banner de erro com Tentar novamente, módulos contextuais desabilitados", async () => {
      await waitFor(cdp, "window.VF.context.getState() === 'PORTFOLIO_ERROR'", "não chegou a PORTFOLIO_ERROR");
      const banner = await cdp.evaluate("document.querySelector('.vf-shell__state .vf-banner')");
      assert.ok(banner, "banner de erro não apareceu");
      assert.strictEqual(await cdp.evaluate("document.querySelector('.vf-shell__state .vf-banner').getAttribute('role')"), "alert");
      assert.ok(await cdp.evaluate("Boolean(document.querySelector('[data-cmd=retry]'))"), "botão Tentar novamente não apareceu");
      const financeiro = await cdp.evaluate("document.querySelector('.vf-shell__item[data-module=financeiro]')");
      assert.ok(financeiro, "item Financeiro deveria continuar visível (desabilitado, não escondido)");
      assert.strictEqual(await cdp.evaluate("document.querySelector('.vf-shell__item[data-module=financeiro]').getAttribute('aria-disabled')"), "true");
    });

    /* ═════════════ C1 — GET /me/context é a carteira do shell ══════════ */
    currentFixture = { portfolio: PORTFOLIO_MAIN, contas: CONTAS_MAIN, failPortfolio: false, meContext: ME_CONTEXT };
    meContextRequestCount = 0;
    legadoPortfolioRequestCount = 0;
    await goto("scope=account&module=central-vendas");
    await waitFor(cdp, "window.VF.context.getPortfolio().length === 9", "shell não resolveu a carteira por /me/context");

    await check("C1 — com /me/context disponível, o shell NÃO chama mais /operacao/cliente-360/clientes", async () => {
      assert.strictEqual(meContextRequestCount, 1, `esperado 1 GET /me/context, veio ${meContextRequestCount}`);
      assert.strictEqual(legadoPortfolioRequestCount, 0, `o endpoint legado ainda foi chamado ${legadoPortfolioRequestCount}x`);
      assert.strictEqual(await cdp.evaluate("window.VF.context.getPortfolio().length"), 9);
    });

    await check("C1 — squads do usuário ficam disponíveis no store (getSquads), sem inventar nada", async () => {
      const squads = await cdp.evaluate("window.VF.context.getSquads()");
      assert.strictEqual(squads.length, 1);
      assert.strictEqual(squads[0].nome, "Squad Alpha");
      assert.strictEqual(await cdp.evaluate("window.VF.context.getSquadPrincipalId()"), 3);
    });

    await check("C1 — 'N operações' aparece no dropdown de Cliente (campo que só o payload novo tem)", async () => {
      await cdp.evaluate("document.getElementById('vf-cliente-trigger').click()");
      await waitFor(cdp, "document.querySelector('.vf-shell__dropdown')", "dropdown de Cliente não abriu");
      const texto = await cdp.evaluate(`
        (function(){ var it = document.querySelector('.vf-shell__dropdown .vf-menu__item small'); return it ? it.textContent : null; })();
      `);
      assert.ok(texto && /3 operaç(ão|ões)/.test(texto), `esperado o sub-rótulo de operações a partir de contasAtivas, veio: ${texto}`);
      await cdp.evaluate("document.getElementById('vf-cliente-trigger').click()");
    });

    /* Queda: servidor antigo, /me ainda não existe (404) → legado assume. */
    currentFixture = { portfolio: PORTFOLIO_SMALL, contas: CONTAS_MAIN, failPortfolio: false };
    meContextRequestCount = 0;
    legadoPortfolioRequestCount = 0;
    await goto("scope=account&module=central-vendas");
    await waitFor(cdp, "window.VF.context.getPortfolio().length === 2", "queda não resolveu a carteira pelo endpoint legado");

    await check("C1 — servidor sem /me (404): o shell cai para o endpoint legado e a carteira continua funcionando", async () => {
      assert.strictEqual(legadoPortfolioRequestCount, 1, "a queda deveria ter chamado /operacao/cliente-360/clientes");
      assert.strictEqual(await cdp.evaluate("window.VF.context.getPortfolio().length"), 2);
      assert.deepStrictEqual(await cdp.evaluate("window.VF.context.getSquads()"), [], "sem /me/context não existe squad — e nada pode ser fabricado");
    });

    /* 500 NÃO cai: um servidor doente não pode se esconder atrás do legado. */
    currentFixture = { portfolio: PORTFOLIO_SMALL, contas: CONTAS_MAIN, failPortfolio: false, meContext: "erro" };
    legadoPortfolioRequestCount = 0;
    await goto("scope=global&module=ferramentas");
    await waitFor(cdp, "window.VF.context.getState() === 'PORTFOLIO_ERROR'", "500 em /me/context não virou PORTFOLIO_ERROR");

    await check("C1 — 500 em /me/context vira PORTFOLIO_ERROR; NÃO é mascarado pelo endpoint legado", async () => {
      assert.strictEqual(legadoPortfolioRequestCount, 0, "um 500 não pode ser escondido atrás de uma segunda chamada");
      assert.ok(await cdp.evaluate("Boolean(document.querySelector('[data-cmd=retry]'))"), "estado de erro deveria oferecer 'Tentar novamente'");
    });

    console.log(`\n✓ ${checks} verificações do vf-shell (S01–S13 + responsividade + C1 /me/context)`);
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
