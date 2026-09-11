/*
 * Smoke test de interface em Chrome headless para a Carteira (F1.1/F1.2) —
 * MASTER_SPEC §21.3, casos P01-P13.
 *
 * Mesmo padrão de Portal/vf-shell-adoption-ui.test.js: servidor estático
 * local + CDP puro (sem puppeteer) + interceptação via `Fetch` de qualquer
 * chamada ao host de produção (nunca toca a rede real). Diferença: a
 * página servida é um harness (`carteira-harness.html`, escrito por este
 * teste, nunca commitado) que monta `createCarteira()` de
 * Portal/carteira.js diretamente — assim o teste controla `getSquads()`
 * (P04) sem precisar de um parâmetro de URL na página de produção, que
 * não expõe esse gancho (a Carteira real não inventa squad; ver
 * carteira.js).
 *
 * A LISTA em si nunca é buscada pelo teste: como no código de produção,
 * ela vem de vf-context.js (GET /operacao/cliente-360/clientes) — a
 * fixture desta rota é a MESMA usada pela Carteira e pela sidebar.
 */
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PORTAL_DIR = __dirname;

function grant(status) {
  return status ? { id: 900, ml_user_id: "1099887766", token_status: status, is_primary: false } : null;
}
function base(id, nome) {
  return { vinculo_id: 500 + id, base_id: id, slug: "base-" + id, nome, resolvido_por: "conta" };
}

/* ── Fixtures (mesmo formato de GET /operacao/cliente-360/clientes e
   GET /clientes/:cliente/contas — MASTER_SPEC §3.1/§18.1) ─────────────── */

const N97 = { // P09/P13 — 2 contas ML (rótulo externo distingue) + 1 Shopee
  id: 87, nome: "N97 Comercial", slug: "n97", ativo: true,
  temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100,
  statusOperacional: "atencao", ultimaSincronizacao: "2026-08-25T14:00:00Z", pendencias: [],
};
const N97_CONTAS = [
  { id: 42, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre 1", slug: "ml-1", external_account_id: "182993004", externalAccountLabel: "n97store", is_primary: true, ativo: true, grant: grant("valid"), base: base(9, "Custo 2026"), ultimaSync: "2026-08-25T14:00:00Z" },
  { id: 43, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre 2", slug: "ml-2", external_account_id: "204118872", externalAccountLabel: "n97outlet", is_primary: false, ativo: true, grant: grant("valid"), base: base(9, "Custo 2026"), ultimaSync: "2026-08-25T14:00:00Z" },
];

const EXTRA = { // P08 — 1 conta ativa, entra em 1 clique
  id: 88, nome: "Extra Máquinas", slug: "extra", ativo: true,
  temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100,
  statusOperacional: "pronto", ultimaSincronizacao: "2026-08-25T16:00:00Z", pendencias: [],
};
const EXTRA_CONTAS = [
  { id: 51, cliente_id: 88, marketplace: "meli", nome: "Mercado Livre", slug: "ml", external_account_id: "119847221", externalAccountLabel: "extramaquinas", is_primary: true, ativo: true, grant: grant("valid"), base: base(11, "Custo Extra"), ultimaSync: "2026-08-25T16:00:00Z" },
];

const PEDRO = { // P10 — 0 contas, "Configurar →"; também cobre P03 (pendência)
  id: 90, nome: "Loja do Pedro", slug: "loja-do-pedro", ativo: true,
  temGrant: false, grantStatus: "ausente", temBase: false, setupScore: 0,
  statusOperacional: "critico", ultimaSincronizacao: null, pendencias: ["sem_grant", "sem_base"],
};
const PEDRO_CONTAS = [];

const CASA = { // P11 — a rota de contas deste cliente falha; só a linha dele erra
  id: 89, nome: "Casa & Cia", slug: "casa-e-cia", ativo: true,
  temGrant: true, grantStatus: "expirado", temBase: false, setupScore: 50,
  statusOperacional: "atencao", ultimaSincronizacao: "2026-08-19T10:00:00Z", pendencias: ["sem_base"],
};
// sem entrada em CONTAS_MAIN["casa-e-cia"] — o servidor de teste responde 500

const PORTFOLIO_PADRAO = { ok: true, clientes: [N97, EXTRA, PEDRO, CASA] };
const CONTAS_PADRAO = { n97: N97_CONTAS, extra: EXTRA_CONTAS, "loja-do-pedro": PEDRO_CONTAS };

/* ── C1 — fixture no formato REAL de GET /me/portfolio (server/services/
   meService.js:134-171): contas EMBUTIDAS, `pendencias` como [{tipo}],
   `baseVinculada` no lugar de `base`, `grantStatus` já resolvido pelo
   backend e `ultimaSync` literalmente null (meService.js:150). É de
   propósito que este payload não se pareça com o legado — o que o teste
   prova é justamente a adaptação. ────────────────────────────────────── */
function contaMe(id, marketplace, nome, label, extras) {
  return Object.assign(
    { id, marketplace, nome, externalAccountLabel: label, external_account_id: String(100000000 + id), ativo: true, grantStatus: marketplace === "meli" ? "conectado" : null, baseVinculada: { id: 9, nome: "Custo 2026" }, ultimaSync: null },
    extras || {}
  );
}
const ME_PORTFOLIO = {
  ok: true,
  squads: [
    { id: 3, nome: "Squad Alpha", slug: "alpha", principal: true },
    { id: 5, nome: "Squad Beta", slug: "beta", principal: false },
  ],
  clientes: [
    { id: 87, slug: "n97", nome: "N97 Comercial", squadId: 3, squad: { id: 3, nome: "Squad Alpha", slug: "alpha", principalParaUsuario: true }, responsavelDireto: true, statusOperacional: "atencao", pendencias: [],
      contas: [contaMe(42, "meli", "Mercado Livre 1", "n97store"), contaMe(43, "meli", "Mercado Livre 2", "n97outlet")] },
    { id: 88, slug: "extra", nome: "Extra Máquinas", squadId: 5, squad: { id: 5, nome: "Squad Beta", slug: "beta", principalParaUsuario: false }, responsavelDireto: false, statusOperacional: "pronto", pendencias: [],
      contas: [contaMe(51, "meli", "Mercado Livre", "extramaquinas")] },
    { id: 90, slug: "loja-do-pedro", nome: "Loja do Pedro", squadId: 5, squad: { id: 5, nome: "Squad Beta", slug: "beta", principalParaUsuario: false }, responsavelDireto: false, statusOperacional: "critico", pendencias: [{ tipo: "sem_grant" }, { tipo: "sem_base" }],
      contas: [] },
    { id: 89, slug: "casa-e-cia", nome: "Casa & Cia", squadId: 3, squad: { id: 3, nome: "Squad Alpha", slug: "alpha", principalParaUsuario: true }, responsavelDireto: false, statusOperacional: "atencao", pendencias: [{ tipo: "sem_base" }],
      contas: [contaMe(60, "meli", "Mercado Livre", "casaecia", { grantStatus: "atencao", baseVinculada: null })] },
  ],
};

function carteiraGrande(n) {
  const nomes = ["Aurora", "Bravo", "Cedro", "Delta", "Everest", "Fênix", "Gaia", "Horizonte"];
  const out = [];
  const contas = {};
  for (let i = 0; i < n; i++) {
    const slug = "cli-" + (100 + i);
    const qtd = i % 7 === 0 ? 0 : i % 3 === 0 ? 2 : 1;
    const lista = [];
    for (let k = 0; k < qtd; k++) {
      lista.push({
        id: 1000 + i * 10 + k, cliente_id: 200 + i, marketplace: "meli",
        nome: "Mercado Livre " + (k + 1), slug: "conta-" + k,
        external_account_id: String(500000000 + i * 137 + k), externalAccountLabel: slug + (k ? "-b" : ""),
        is_primary: k === 0, ativo: true, grant: grant("valid"), base: base(300 + i, "Custo " + slug),
        ultimaSync: "2026-08-25T10:00:00Z",
      });
    }
    contas[slug] = lista;
    out.push({
      id: 200 + i, nome: nomes[i % nomes.length] + " " + (i + 1), slug, ativo: true,
      temGrant: qtd > 0, grantStatus: qtd > 0 ? "conectado" : "ausente", temBase: qtd > 0, setupScore: qtd > 0 ? 100 : 0,
      statusOperacional: qtd > 0 ? "pronto" : "critico", ultimaSincronizacao: qtd > 0 ? "2026-08-25T10:00:00Z" : null,
      pendencias: qtd > 0 ? [] : ["sem_grant", "sem_base"],
    });
  }
  return { portfolio: { ok: true, clientes: out }, contas };
}
const GRANDE = carteiraGrande(120);

function harnessHtml(squadsJson) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="vf-api-base" content="__API_BASE__">
<link rel="stylesheet" href="/css/vf-tokens-v2.css">
<link rel="stylesheet" href="/css/vf-components-v2.css">
<link rel="stylesheet" href="/css/vf-shell.css">
<link rel="stylesheet" href="/css/pages/carteira-v2.css">
</head>
<body class="vf-page vf-page-carteira" data-vf-scope="global" data-vf-module="carteira">
<script>
  var qs = new URLSearchParams(location.search);
  localStorage.setItem("vf-token", "ui-test-token");
  localStorage.setItem("vf-user", JSON.stringify({ id: 12, nome: "Pedro Gomes", role: qs.get("role") || "user" }));
</script>
<div><main class="vf-content"><div class="vf-page-shell"><div class="vf-page-container">
  <div id="carteira-test-root"></div>
</div></div></main></div>
<script type="module" src="/vf-shell.js"></script>
<script type="module">
  // id propositalmente DIFERENTE de "carteira-root": o import abaixo
  // também executa o bootProduction() de carteira.js (efeito de módulo, o
  // mesmo padrão de vf-shell.js) — sem #carteira-root no DOM, ele não
  // monta uma segunda instância por cima desta, injetada com fixtures.
  import { createCarteira } from "/carteira.js";
  var squads = ${squadsJson};
  window.__navegacoes = [];
  // squads === null: NADA injetado — é o caminho de produção, em que os
  // squads vêm do próprio payload de /me/portfolio (C1).
  var opts = { onNavigate: function (href) { window.__navegacoes.push(href); } };
  if (squads !== null) opts.getSquads = function () { return squads; };
  window.__cart = createCarteira(opts);
  window.__cart.montar(document.getElementById("carteira-test-root"));
</script>
</body></html>`;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/harness.html") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(harnessHtml(u.searchParams.get("squads") || "[]").replace("__API_BASE__", `http://127.0.0.1:${serverPort}`));
      return;
    }
    // API_BASE aponta para este mesmo servidor (meta vf-api-base) — o
    // harness é servido same-origin, então nem precisa de CORS/Fetch
    // interception (diferença deliberada de vf-shell-adoption-ui.test.js,
    // que testa páginas com API_BASE hardcoded para produção).
    // C1 — GET /me/portfolio só existe quando a fixture o define. Sem ele,
    // 404: é EXATAMENTE o que exercita a queda para o caminho anterior, que
    // todos os cenários P01-P13 abaixo continuam medindo.
    if (u.pathname === "/me/portfolio") {
      if (!currentFixture.mePortfolio) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"ok":false}'); return; }
      if (currentFixture.mePortfolio === "erro") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, erro: "Falha simulada em /me/portfolio." }));
        return;
      }
      mePortfolioRequestCount += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(currentFixture.mePortfolio));
      return;
    }
    if (u.pathname === "/operacao/cliente-360/clientes") {
      if (currentFixture.failPortfolio) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, erro: "Falha simulada." }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(currentFixture.portfolio));
      return;
    }
    const contasMatch = u.pathname.match(/^\/clientes\/([^/]+)\/contas$/);
    if (contasMatch) {
      const slug = decodeURIComponent(contasMatch[1]);
      contasRequestCount += 1;
      if (slug === currentFixture.failContasSlug) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, erro: "Falha simulada." }));
        return;
      }
      const lista = currentFixture.contas[slug] || [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, cliente: { id: 1, nome: slug, slug, ativo: true }, contas: lista }));
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
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { serverPort = server.address().port; resolve(server); }));
}
let serverPort = 0;

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

let currentFixture = { portfolio: PORTFOLIO_PADRAO, contas: CONTAS_PADRAO, failPortfolio: false, failContasSlug: "casa-e-cia" };
let contasRequestCount = 0;
let mePortfolioRequestCount = 0;

// A API é same-origin (meta vf-api-base aponta para este servidor de
// teste), então não precisa de Fetch domain/CORS — só captura de erros de
// console (nenhuma requisição desta suíte toca produção).
function wireConsoleCapture(cdp) {
  const consoleErrors = [];
  cdp.onEvent = (method, params) => {
    if (method === "Runtime.consoleAPICalled" && params.type === "error") {
      consoleErrors.push((params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || "")).join(" "));
    }
  };
  return consoleErrors;
}

async function run() {
  const server = await startServer();
  const debugPort = 17000 + Math.floor(Math.random() * 1000);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=/tmp/vf-carteira-ui-${process.pid}`, "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    await waitChrome(debugPort);
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const consoleErrors = wireConsoleCapture(cdp);

    async function goto(qs) {
      contasRequestCount = 0;
      mePortfolioRequestCount = 0;
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/harness.html?${qs}` });
      await waitFor(cdp, "window.__cart", "Carteira não montou");
    }

    /* ═══════════════════════ Cenário padrão ═══════════════════════════ */
    currentFixture = { portfolio: PORTFOLIO_PADRAO, contas: CONTAS_PADRAO, failPortfolio: false, failContasSlug: "casa-e-cia" };
    await goto("");
    await waitFor(cdp, "document.querySelectorAll('.vf-portfolio-row').length === 4", "4 linhas não renderizaram");
    await sleep(300); // contas sob demanda (prefetch) resolvem

    await check("P08 — cliente com 1 conta ativa: nome é <button>, entra em 1 clique", async () => {
      const el = await cdp.evaluate(`
        (function(){ var li = document.querySelector('.vf-portfolio-row[data-slug=extra]'); var b = li.querySelector('[data-entrar]'); return b ? { tag: b.tagName, texto: b.textContent } : null; })();
      `);
      assert.ok(el, "Extra Máquinas deveria ter um botão [data-entrar]");
      assert.strictEqual(el.tag, "BUTTON");
    });

    await check("P09 — cliente com 2+ contas: nome é <h3> (não clicável), só os chips entram", async () => {
      const el = await cdp.evaluate(`
        (function(){ var li = document.querySelector('.vf-portfolio-row[data-slug=n97]'); var h3 = li.querySelector('h3.vf-portfolio-row__name'); var btn = li.querySelector('button[data-entrar]'); var chips = li.querySelectorAll('[data-conta]'); return { temH3: !!h3, temBotaoNome: !!btn, nChips: chips.length }; })();
      `);
      assert.strictEqual(el.temH3, true, "nome do cliente com 2+ contas deveria ser <h3>, não botão");
      assert.strictEqual(el.temBotaoNome, false);
      assert.strictEqual(el.nChips, 2);
    });

    await check("P13 — duas contas ML do mesmo cliente: rótulo externo distingue (n97store × n97outlet)", async () => {
      const labels = await cdp.evaluate(`
        Array.prototype.map.call(document.querySelectorAll('.vf-portfolio-row[data-slug=n97] .vf-op-chip__label'), function(e){return e.textContent;})
      `);
      assert.deepStrictEqual(labels.sort(), ["n97outlet", "n97store"]);
    });

    await check("P10 — cliente com 0 contas: linha não clicável, 'Configurar →' presente", async () => {
      const el = await cdp.evaluate(`
        (function(){ var li = document.querySelector('.vf-portfolio-row[data-slug="loja-do-pedro"]'); return { temEntrar: !!li.querySelector('[data-entrar]'), rodape: li.querySelector('.vf-portfolio-row__foot') ? li.querySelector('.vf-portfolio-row__foot').textContent : null }; })();
      `);
      assert.strictEqual(el.temEntrar, false);
      assert.ok(el.rodape && el.rodape.includes("Configurar"), `rodapé deveria oferecer 'Configurar →', veio: ${el.rodape}`);
    });

    await check("P11 — falha ao carregar as contas de 1 cliente: erro só naquela linha, resto intacto", async () => {
      const el = await cdp.evaluate(`
        (function(){ var li = document.querySelector('.vf-portfolio-row[data-slug="casa-e-cia"]'); var erro = li.querySelector('.vf-op-chip.is-error'); var recarregar = li.querySelector('[data-recarregar]'); return { temErro: !!erro, temRecarregar: !!recarregar }; })();
      `);
      assert.strictEqual(el.temErro, true);
      assert.strictEqual(el.temRecarregar, true);
      const outrasLinhasOk = await cdp.evaluate(`document.querySelectorAll('.vf-portfolio-row[data-slug=n97] .vf-op-chip:not(.is-error)').length`);
      assert.ok(outrasLinhasOk > 0, "linha de N97 não deveria ter sido afetada pela falha de Casa & Cia");
    });

    await check("entrar() — cliente com 1 conta: clique navega direto para a operação certa (cliente=extra&conta=51)", async () => {
      await cdp.evaluate("document.querySelector('.vf-portfolio-row[data-slug=extra] [data-entrar]').click()");
      await waitFor(cdp, "window.__navegacoes.length === 1", "onNavigate não disparou para o cliente de 1 conta");
      const href = await cdp.evaluate("window.__navegacoes[0]");
      assert.ok(href.includes("cliente=extra"), `destino sem cliente=extra: ${href}`);
      assert.ok(href.includes("conta=51"), `destino sem a conta correta (51): ${href}`);
    });

    await check("entrar() — cliente com 2+ contas: clique num CHIP (não no nome) fixa a conta e navega (ACCOUNT_CHOICE_REQUIRED → READY)", async () => {
      await cdp.evaluate(`
        Array.prototype.find.call(document.querySelectorAll('.vf-portfolio-row[data-slug=n97] [data-conta]'), function(b){ return b.dataset.conta === "43"; }).click()
      `);
      await waitFor(cdp, "window.__navegacoes.length === 2", "onNavigate não disparou para a conta escolhida via chip (2+ contas)");
      const href = await cdp.evaluate("window.__navegacoes[1]");
      assert.ok(href.includes("cliente=n97") && href.includes("conta=43"), `destino incorreto após escolher o chip: ${href}`);
    });

    await check("P03 — filtro 'Com pendência': só clientes com pendencias.length > 0", async () => {
      await cdp.evaluate("document.querySelector('[data-filtro=pendencia]').click()");
      await sleep(80);
      const slugs = await cdp.evaluate(`Array.prototype.map.call(document.querySelectorAll('.vf-portfolio-row'), function(li){return li.dataset.slug;})`);
      assert.deepStrictEqual(slugs.sort(), ["casa-e-cia", "loja-do-pedro"]);
      await cdp.evaluate("document.querySelector('[data-filtro=todos]').click()");
      await sleep(80);
    });

    await check("P01 — busca por nome e slug, sem acento, filtra local", async () => {
      await cdp.evaluate(`
        var i = document.getElementById('cart-busca'); i.focus(); i.value = 'nao existe'; i.dispatchEvent(new Event('input', { bubbles: true }));
      `);
      await sleep(80);
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-portfolio-row').length"), 0);
      await cdp.evaluate(`
        var i = document.getElementById('cart-busca'); i.value = 'n97'; i.dispatchEvent(new Event('input', { bubbles: true }));
      `);
      await sleep(80);
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-portfolio-row').length"), 1);
      assert.strictEqual(await cdp.evaluate("document.querySelector('.vf-portfolio-row').dataset.slug"), "n97");
      await cdp.evaluate(`
        var i = document.getElementById('cart-busca'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
      `);
      await sleep(80);
    });

    await check("P12 — teclado: '/' foca a busca; ArrowDown/ArrowUp navegam entre clientes", async () => {
      await cdp.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()");
      await cdp.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }))");
      assert.strictEqual(await cdp.evaluate("document.activeElement && document.activeElement.id"), "cart-busca");
      await cdp.evaluate("document.querySelector('.vf-portfolio-row [data-entrar], .vf-portfolio-row [data-conta]').focus()");
      const primeiro = await cdp.evaluate("document.activeElement.closest('.vf-portfolio-row').dataset.slug");
      await cdp.evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))");
      const segundo = await cdp.evaluate("document.activeElement.closest('.vf-portfolio-row').dataset.slug");
      assert.notStrictEqual(segundo, primeiro, "ArrowDown deveria mover o foco para outra linha");
    });

    /* ═══════════════════════ P04 — agrupamento por squad ══════════════ */
    await goto("squads=" + encodeURIComponent(JSON.stringify([{ id: 3, nome: "Squad Alpha" }, { id: 5, nome: "Squad Beta" }])));
    await waitFor(cdp, "document.querySelectorAll('.vf-portfolio-row').length === 4", "linhas não renderizaram no cenário de squad");
    await check("P04 — 2+ squads: cabeçalhos de grupo aparecem; ausentes com 1 squad (cenário padrão)", async () => {
      const grupos = await cdp.evaluate("document.querySelectorAll('.vf-portfolio-group').length");
      assert.ok(grupos >= 1, "cabeçalho de squad deveria aparecer com 2+ squads");
    });

    /* ═══════════════════════ P07 — carteira vazia ═════════════════════ */
    currentFixture = { portfolio: { ok: true, clientes: [] }, contas: {}, failPortfolio: false, failContasSlug: null };
    await goto("");
    await check("P07 — vazio: .vf-empty, sem ação técnica", async () => {
      await waitFor(cdp, "document.querySelector('.vf-empty')", "estado vazio não apareceu");
      const texto = await cdp.evaluate("document.querySelector('.vf-empty').textContent");
      assert.ok(texto.includes("coordenador"), `mensagem de carteira vazia inesperada: ${texto}`);
    });

    /* ═══════════════════════ P05 — erro ao carregar a carteira ════════ */
    currentFixture = { portfolio: PORTFOLIO_PADRAO, contas: CONTAS_PADRAO, failPortfolio: true, failContasSlug: null };
    await goto("");
    await check("P05 — erro de carga: banner + 'Tentar novamente'", async () => {
      await waitFor(cdp, "document.querySelector('.vf-banner.is-danger')", "banner de erro não apareceu");
      assert.ok(await cdp.evaluate("Boolean(document.getElementById('cart-retry'))"));
    });

    /* ═══════════════════════ P02/P06 — 120 clientes ═══════════════════ */
    currentFixture = { portfolio: GRANDE.portfolio, contas: GRANDE.contas, failPortfolio: false, failContasSlug: null };
    const t0 = Date.now();
    await goto("");
    await waitFor(cdp, "document.querySelectorAll('.vf-portfolio-row').length === 120", "120 linhas não renderizaram");
    const renderMs = Date.now() - t0;
    await sleep(400); // prefetch das primeiras linhas resolve

    await check(`P02 — 120 clientes: render completo em ${renderMs}ms (limite generoso de teste: 4000ms)`, async () => {
      assert.ok(renderMs < 4000, `render de 120 clientes levou ${renderMs}ms`);
    });

    await check("P02 — chips carregam sob demanda: não dispara 120 chamadas de contas no primeiro paint", async () => {
      assert.ok(contasRequestCount <= 20, `esperado ~12 (prefetch), veio ${contasRequestCount}`);
      assert.ok(contasRequestCount > 0, "nenhuma chamada de contas disparou");
    });

    await check("P06 (skeleton) — chip de conta ainda não resolvida usa o esqueleto de largura fixa", async () => {
      const temSkeletonEmAlgumMomento = contasRequestCount < 120; // ainda há linhas fora do prefetch
      assert.ok(temSkeletonEmAlgumMomento, "todas as 120 linhas já teriam contas resolvidas, o que contradiz 'sob demanda'");
    });

    /* ════════════ C1 — GET /me/portfolio como fonte da Carteira ═══════ */
    currentFixture = { portfolio: PORTFOLIO_PADRAO, contas: CONTAS_PADRAO, failPortfolio: false, failContasSlug: null, mePortfolio: ME_PORTFOLIO };
    await goto("squads=null");
    await waitFor(cdp, "document.querySelectorAll('.vf-portfolio-row').length === 4", "linhas não renderizaram a partir de /me/portfolio");
    await sleep(300); // se alguma chamada por cliente fosse sair, sairia aqui

    await check("C1 — a Carteira inteira vem de UMA chamada: nenhuma requisição por cliente a /clientes/:slug/contas", async () => {
      assert.strictEqual(mePortfolioRequestCount, 1, `esperado 1 GET /me/portfolio, veio ${mePortfolioRequestCount}`);
      assert.strictEqual(contasRequestCount, 0, `contas já vieram embutidas; ainda assim saíram ${contasRequestCount} chamadas por cliente`);
    });

    await check("C1 — contas embutidas viram chips com o rótulo externo certo (n97store × n97outlet)", async () => {
      const labels = await cdp.evaluate(`
        Array.prototype.map.call(document.querySelectorAll('.vf-portfolio-row[data-slug=n97] .vf-op-chip__label'), function(e){return e.textContent;})
      `);
      assert.deepStrictEqual(labels.sort(), ["n97outlet", "n97store"]);
    });

    /* ════ D3 (Convergência #2) — /me/portfolio passou a devolver
       `clientes[].ultimaSincronizacao` de verdade (P2.6). Até aqui a fixture
       nunca tinha o campo, porque o backend nunca o mandava: o caso "o dado
       EXISTE" nunca foi exercido, e por isso ninguém viu que a adaptação
       derrubava o campo pelo caminho. Sem ele em `clientesRicos`,
       `temDadoDeSync()` é falso para sempre e a ordenação nunca reaparece —
       a funcionalidade seguiria degradada com o bloqueio já resolvido. ══ */
    currentFixture = {
      portfolio: PORTFOLIO_PADRAO, contas: CONTAS_PADRAO, failPortfolio: false, failContasSlug: null,
      mePortfolio: {
        ...ME_PORTFOLIO,
        clientes: ME_PORTFOLIO.clientes.map((c) =>
          c.slug === "n97" ? { ...c, ultimaSincronizacao: "2026-08-30T09:12:00Z" }
          : c.slug === "extra" ? { ...c, ultimaSincronizacao: "2026-08-28T09:12:00Z" }
          : { ...c, ultimaSincronizacao: null }),
      },
    };
    await goto("squads=null");
    await waitFor(cdp, "document.querySelectorAll('.vf-portfolio-row').length === 4", "linhas não renderizaram no cenário de sync");
    await sleep(300);

    await check("D3 — com ultimaSincronizacao no payload, a ordenação 'Última sync' volta a ser oferecida", async () => {
      const opcoes = await cdp.evaluate(`
        Array.prototype.map.call(document.querySelectorAll('#cart-ordem option'), function(o){return o.value;})
      `);
      assert.ok(opcoes.includes("sync"), `a opção 'Última sync' não apareceu mesmo com o campo presente no payload: ${JSON.stringify(opcoes)}`);
    });

    await check("D3 — e ela ordena de verdade: mais recente primeiro", async () => {
      await cdp.evaluate(`
        (function(){
          var sel = document.getElementById('cart-ordem');
          sel.value = 'sync';
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        })();
      `);
      await sleep(250);
      const slugs = await cdp.evaluate(`
        Array.prototype.map.call(document.querySelectorAll('.vf-portfolio-row'), function(e){return e.getAttribute('data-slug');})
      `);
      assert.strictEqual(slugs[0], "n97", `n97 (sync 30/08) deveria vir antes de extra (28/08); veio ${JSON.stringify(slugs)}`);
      assert.ok(slugs.indexOf("extra") < slugs.indexOf("loja-do-pedro"),
        `cliente com sync deveria vir antes dos sem sync; veio ${JSON.stringify(slugs)}`);
    });

    await check("D3 — cliente sem sync continua sem afirmar 'nunca sincronizou'", async () => {
      const txt = await cdp.evaluate("document.body.innerText");
      assert.ok(!/nunca sincroniz/i.test(txt), "ausência de dado virou afirmação sobre o cliente");
    });

    // Devolve a fixture SEM `ultimaSincronizacao` — os checks C1 seguintes
    // (inclusive o que prova o caso negativo da ordenação) contam com ela.
    currentFixture = { portfolio: PORTFOLIO_PADRAO, contas: CONTAS_PADRAO, failPortfolio: false, failContasSlug: null, mePortfolio: ME_PORTFOLIO };
    await goto("squads=null");
    await waitFor(cdp, "document.querySelectorAll('.vf-portfolio-row').length === 4", "linhas não voltaram após restaurar a fixture");
    await sleep(300);

    await check("C1 — squads vêm do payload (sem getSquads injetado): agrupamento aparece e o seletor de Squad é oferecido", async () => {
      const grupos = await cdp.evaluate("document.querySelectorAll('.vf-portfolio-group').length");
      assert.ok(grupos >= 2, `esperado ≥2 cabeçalhos de squad vindos de /me/portfolio, veio ${grupos}`);
      assert.ok(await cdp.evaluate("Boolean(document.getElementById('cart-squad'))"), "seletor de Squad deveria existir com 2 squads no payload");
    });

    await check("C1 — pendencias [{tipo}] são traduzidas: 'Base não vinculada' aparece, nunca '[object Object]'", async () => {
      const rodape = await cdp.evaluate(`
        (function(){ var li = document.querySelector('.vf-portfolio-row[data-slug="casa-e-cia"]'); var f = li.querySelector('.vf-portfolio-row__foot'); return f ? f.textContent : null; })();
      `);
      assert.ok(rodape && rodape.includes("Base não vinculada"), `rodapé inesperado: ${rodape}`);
      assert.ok(!/object Object/.test(rodape), `pendência não adaptada vazou para a UI: ${rodape}`);
    });

    await check("C1 — responsavelDireto do payload marca a linha ('responsável: você')", async () => {
      const tag = await cdp.evaluate(`
        (function(){ var li = document.querySelector('.vf-portfolio-row[data-slug=n97]'); var t = li.querySelector('.vf-tag'); return t ? t.textContent : null; })();
      `);
      assert.ok(tag && tag.includes("responsável"), `esperado a marca de responsável direto em N97, veio: ${tag}`);
    });

    await check("C1 — ausência de sync NÃO vira 'nunca sincronizou' (ultimaSync é null no payload)", async () => {
      const metas = await cdp.evaluate(`
        Array.prototype.map.call(document.querySelectorAll('.vf-op-chip__meta'), function(e){return e.textContent;}).join(' | ')
      `);
      assert.ok(!/nunca sincronizou/.test(metas), `afirmação indevida sobre sync: ${metas}`);
      assert.ok(/sem dado de sync/.test(metas), `esperado 'sem dado de sync' como ausência honesta, veio: ${metas}`);
    });

    await check("C1 — sem ultimaSincronizacao no payload, a ordenação 'Última sync' não é oferecida", async () => {
      const opcoes = await cdp.evaluate(`
        Array.prototype.map.call(document.querySelectorAll('#cart-ordem option'), function(o){return o.value;})
      `);
      assert.ok(!opcoes.includes("sync"), `ordenação por sync foi oferecida sem dado para ordenar: ${JSON.stringify(opcoes)}`);
      assert.ok(opcoes.includes("atencao") && opcoes.includes("nome") && opcoes.includes("meus"), `demais ordenações sumiram: ${JSON.stringify(opcoes)}`);
    });

    await check("C1 — grantStatus resolvido pelo backend vence: conta com 'atencao' fica em tom de aviso", async () => {
      const tom = await cdp.evaluate(`
        (function(){ var c = document.querySelector('.vf-portfolio-row[data-slug="casa-e-cia"] .vf-op-chip .vf-status'); return c ? c.className : null; })();
      `);
      assert.ok(tom && tom.includes("is-warning"), `esperado tom de aviso a partir de grantStatus='atencao', veio: ${tom}`);
    });

    await check("C1 — entrar() continua funcionando com a fonte nova (chip fixa a conta e navega)", async () => {
      await cdp.evaluate(`
        Array.prototype.find.call(document.querySelectorAll('.vf-portfolio-row[data-slug=n97] [data-conta]'), function(b){ return b.dataset.conta === "43"; }).click()
      `);
      await waitFor(cdp, "window.__navegacoes.length === 1", "onNavigate não disparou a partir da fonte /me/portfolio");
      const href = await cdp.evaluate("window.__navegacoes[0]");
      assert.ok(href.includes("cliente=n97") && href.includes("conta=43"), `destino incorreto: ${href}`);
    });

    /* ════════════ C1 — queda: /me/portfolio falha, tela não cai ═══════ */
    currentFixture = { portfolio: PORTFOLIO_PADRAO, contas: CONTAS_PADRAO, failPortfolio: false, failContasSlug: null, mePortfolio: "erro" };
    await goto("squads=null");
    await waitFor(cdp, "document.querySelectorAll('.vf-portfolio-row').length === 4", "queda não renderizou a lista pelo caminho anterior");
    await sleep(300);

    await check("C1 — /me/portfolio com 500: a Carteira cai para context.getPortfolio() + contas sob demanda, sem banner de erro", async () => {
      assert.ok(contasRequestCount > 0, "a queda deveria voltar a buscar contas por cliente");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-banner.is-danger').length"), 0, "falha do endpoint novo não pode virar erro de carteira");
      const labels = await cdp.evaluate(`
        Array.prototype.map.call(document.querySelectorAll('.vf-portfolio-row[data-slug=n97] .vf-op-chip__label'), function(e){return e.textContent;})
      `);
      assert.deepStrictEqual(labels.sort(), ["n97outlet", "n97store"], "chips não voltaram pelo caminho anterior");
    });

    /* Refinamento: fixtures adicionais, mantendo intactos os casos P01–C1. */
    const nomes = ['Aurora Comercial', 'N97 Comercial', 'Extra Máquinas', 'Casa & Cia', 'Loja do Pedro', 'Horizonte Distribuidora', 'Fênix Store', 'Ipê Atacado', 'Cedro Comércio', 'Olinda Antiga', 'Petrópolis Antiga'];
    function carteiraRefino(n) {
      const squads = [{ id: 3, nome: 'Squad Alpha', principal: true }, { id: 5, nome: 'Squad Beta' }, { id: 8, nome: 'Squad 8 · Legado' }];
      const clientes = Array.from({ length: n }, (_, i) => {
        const qtd = [1, 2, 1, 4, 0, 1, 2, 1, 1, 1, 0][i % 11];
        const s = squads[i % 11 < 5 ? 0 : i % 11 < 9 ? 1 : 2];
        const contas = Array.from({ length: qtd }, (_, k) => contaMe(2000 + i * 10 + k, k === 3 ? 'shopee' : 'meli', k === 3 ? 'Shopee' : `Mercado Livre ${k + 1}`, `loja-${i + 1}${k ? '-outlet' : ''}`, {
          external_account_id: String(2000585272 + i * 10 + k),
          grantStatus: k === 3 ? null : i % 11 === 0 ? 'sem_grant' : i % 11 === 3 && k === 0 ? 'atencao' : 'conectado',
          baseVinculada: i % 11 === 1 || (i % 11 === 3 && k === 1) ? null : { id: 9, nome: 'Custo 2026' },
          ultimaSync: i % 2 ? '2026-09-10T14:00:00Z' : null,
        }));
        return { id: 1000 + i, slug: `refino-${i}`, nome: nomes[i % 11] + (i >= 11 ? ` ${i + 1}` : ''), squadId: s.id, squad: s, responsavelDireto: i % 3 === 0,
          statusOperacional: !qtd || i % 11 === 0 ? 'critico' : i % 11 === 1 || i % 11 === 3 ? 'atencao' : 'pronto',
          pendencias: !qtd ? [{ tipo: 'sem_grant' }, { tipo: 'sem_base' }] : i % 11 === 0 ? [{ tipo: 'sem_grant' }] : i % 11 === 1 || i % 11 === 3 ? [{ tipo: 'sem_base' }] : [],
          ultimaSincronizacao: i % 2 ? '2026-09-10T14:00:00Z' : null, contas };
      });
      return { ok: true, squads, clientes };
    }
    const refino = carteiraRefino(11);
    currentFixture = { portfolio: { ok: true, clientes: refino.clientes }, contas: {}, mePortfolio: refino };
    await goto('squads=null');
    await waitFor(cdp, "document.querySelectorAll('.vf-portfolio-row').length === 11");

    // Fonte opcional local para screenshots: a suíte não baixa assets da rede.
    if (process.env.VF_UI_FONT_DIR) {
      for (const peso of [400, 500, 600, 700]) {
        const font = fs.readFileSync(path.join(process.env.VF_UI_FONT_DIR, `${peso}.ttf`)).toString('base64');
        await cdp.evaluate(`(async () => { const f = new FontFace('Hanken Grotesk', 'url(data:font/ttf;base64,${font})', { weight: '${peso}' }); await f.load(); document.fonts.add(f); })()`);
      }
    }
    async function screenshot(nome) {
      if (!process.env.VF_UI_SCREENSHOTS) return;
      fs.mkdirSync(process.env.VF_UI_SCREENSHOTS, { recursive: true });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(process.env.VF_UI_SCREENSHOTS, `${nome}.png`), Buffer.from(shot.data, 'base64'));
    }
    for (const width of [1440, 1280, 1024, 900, 768, 390]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
      await cdp.evaluate('document.activeElement.blur(); window.scrollTo(0, 0)');
      await sleep(300); // Shell reorganiza o contexto após debounce de 120ms.
      await screenshot(`carteira-${width}`);
      await check(`refino ${width}px — toolbar compacta, conteúdo inteiro e status legíveis`, async () => {
        const m = await cdp.evaluate(`(() => {
          const rect = s => document.querySelector(s).getBoundingClientRect();
          return { overflow: document.documentElement.scrollWidth - innerWidth, busca: rect('#cart-busca').height,
            toolbar: rect('.vf-portfolio-toolbar').height,
            cortados: [...document.querySelectorAll('[data-conta]')].filter(e => e.scrollWidth > e.clientWidth + 1).length,
            meta: getComputedStyle(document.querySelector('.vf-op-chip__meta')).fontSize,
            quatro: document.querySelectorAll('[data-slug="refino-3"] [data-conta]').length,
            contextoContido: !document.querySelector('.vf-shell__contextbar .vf-shell__context') ||
              (rect('.vf-shell__contextbar .vf-shell__context').top >= rect('.vf-shell__contextbar').top &&
              rect('.vf-shell__contextbar .vf-shell__context').bottom <= rect('.vf-shell__contextbar').bottom),
            primeiraLinha: rect('.vf-portfolio-row').height };
        })()`);
        assert.ok(m.overflow <= 0, JSON.stringify(m));
        assert.ok(m.busca >= 30 && m.busca < 60, JSON.stringify(m));
        assert.ok(m.toolbar < 180, JSON.stringify(m));
        assert.strictEqual(m.cortados, 0, JSON.stringify(m));
        assert.ok(parseFloat(m.meta) >= 12, JSON.stringify(m));
        assert.strictEqual(m.quatro, 4);
        assert.strictEqual(m.contextoContido, true, JSON.stringify(m));
        if (width >= 768) assert.ok(m.primeiraLinha < 160, JSON.stringify(m));
        console.log('  medidas:', JSON.stringify(m));
      });
    }
    await cdp.evaluate("document.querySelector('[data-slug=\"refino-3\"]').scrollIntoView({ block: 'start' })");
    await screenshot('carteira-390-quatro-operacoes');
    await cdp.evaluate("document.querySelectorAll('.vf-portfolio-group')[2].scrollIntoView({ block: 'start' })");
    await screenshot('carteira-390-legado');
    await cdp.evaluate('window.scrollTo(0, 0)');
    await check('refino — conexão é texto visível; ausência de sync continua honesta', async () => {
      const states = await cdp.evaluate(`[...document.querySelectorAll('.vf-op-chip__health .vf-status')].map(e => ({text:e.innerText, width:e.getBoundingClientRect().width}))`);
      assert.ok(states.some(s => s.text === 'Sem Grant' && s.width > 30));
      assert.ok(states.some(s => s.text === 'Conectado' && s.width > 30));
      assert.ok(states.some(s => s.text === 'Grant com problema'));
      assert.ok(states.some(s => s.text === 'Configurada'));
    });
    async function buscar(texto) {
      await cdp.evaluate(`(() => { const b = document.querySelector('#cart-busca'); b.value = ${JSON.stringify(texto)}; b.dispatchEvent(new Event('input')); })()`);
    }
    await check('refino — busca nome, slug, conta, label e seller já carregados; zero chamadas extras', async () => {
      const antes = contasRequestCount;
      for (const [q, n] of [['maquinas', 1], ['refino-2', 1], ['Mercado Livre 2', 3], ['loja-4-outlet', 1], ['2000585272', 1]]) {
        await buscar(q);
        assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-portfolio-row').length"), n, q);
      }
      assert.strictEqual(contasRequestCount, antes);
      await screenshot('carteira-busca-seller');
      await buscar('');
    });
    await check('refino — filtros preservam foco, contagem, aria-pressed e URL', async () => {
      await cdp.evaluate(`(() => { const b = document.querySelector('[data-filtro=pendencia]'); b.focus(); b.click(); })()`);
      assert.strictEqual(await cdp.evaluate('document.activeElement.dataset.filtro'), 'pendencia');
      assert.strictEqual(await cdp.evaluate("document.activeElement.getAttribute('aria-pressed')"), 'true');
      assert.ok(await cdp.evaluate("document.querySelector('#cart-contagem').textContent.includes('5 de 11 clientes · 5 com pendência')"));
      assert.strictEqual(await cdp.evaluate("new URLSearchParams(location.search).get('filtro')"), 'pendencia');
      await cdp.evaluate("document.querySelector('[data-filtro=todos]').click()");
    });
    await check('refino — resumo acompanha Squad e limpar filtros recupera a lista e o foco', async () => {
      await cdp.evaluate(`(() => { const s = document.querySelector('#cart-squad'); s.focus(); s.value = '8'; s.dispatchEvent(new Event('change')); })()`);
      assert.strictEqual(await cdp.evaluate('document.activeElement.id'), 'cart-squad');
      assert.ok(await cdp.evaluate("document.querySelector('#cart-contagem').textContent.includes('2 de 11 clientes · 1 com pendência · Squad 8 · Legado')"));
      await buscar('nenhum resultado');
      await screenshot('carteira-filtro-vazio');
      await cdp.evaluate("document.querySelector('#cart-limpar').click()");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-portfolio-row').length"), 11);
      assert.strictEqual(await cdp.evaluate('document.activeElement.id'), 'cart-busca');
    });
    await check('refino — uma seta move exatamente uma linha após várias buscas e ordenações', async () => {
      for (const value of ['nome', 'meus', 'sync', 'atencao']) {
        await cdp.evaluate(`(() => { const s = document.querySelector('#cart-ordem'); s.value = '${value}'; s.dispatchEvent(new Event('change')); })()`);
      }
      const r = await cdp.evaluate(`(() => {
        const linhas = [...document.querySelectorAll('.vf-portfolio-row')];
        const atual = linhas.findIndex(e => e.querySelector('[data-conta]'));
        linhas[atual].querySelector('[data-conta]').focus();
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        const depois = linhas.indexOf(document.activeElement.closest('.vf-portfolio-row'));
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        return { atual, depois, voltou: linhas.indexOf(document.activeElement.closest('.vf-portfolio-row')) };
      })()`);
      assert.strictEqual(r.depois, r.atual + 1);
      assert.strictEqual(r.voltou, r.atual);
    });
    for (const n of [30, 80, 100]) {
      currentFixture = { portfolio: { ok: true, clientes: refino.clientes }, contas: {}, mePortfolio: carteiraRefino(n) };
      await goto('squads=null');
      await waitFor(cdp, `document.querySelectorAll('.vf-portfolio-row').length === ${n}`);
      await check(`refino — ${n} clientes, busca local e uma chamada rica sem N+1`, async () => {
        await buscar(`refino-${n - 1}`);
        assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-portfolio-row').length"), 1);
        assert.strictEqual(contasRequestCount, 0);
        assert.strictEqual(mePortfolioRequestCount, 1);
      });
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    await check("sem erros de console em nenhum cenário (rede de produção sempre interceptada)", async () => {
      const relevantes = consoleErrors.filter((m) => !/favicon/i.test(m) && !/Failed to load resource/i.test(m));
      assert.strictEqual(relevantes.length, 0, `erros de console: ${JSON.stringify(relevantes)}`);
    });

    console.log(`\n✓ ${checks} verificações da Carteira (P01-P13 + C1 /me/portfolio e sua queda)`);
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
