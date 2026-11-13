/*
 * Hotfix de navegação — ROLE global `admin` recupera as ferramentas operacionais
 * (Cliente 360 V3, Sentinel, Central de Vendas, Central de Margem) sem mexer no
 * menu novo dos demais perfis.
 *
 * Navegação REAL em Chrome headless (CDP puro, sem dependências): o teste serve
 * as páginas reais do Portal e intercepta as chamadas à API de produção
 * (venforce-server.onrender.com) com respostas falsas — nada sai para a rede.
 *
 * Prova:
 *  1. admin vê o menu novo + os 4 itens, cada um UMA vez, com a rota certa;
 *  2. user / membro / interno / gestor / coordenador veem EXATAMENTE o menu atual
 *     (nenhum dos 4);
 *  3. sem contexto os itens de módulo ficam inertes (aria-disabled), com contexto
 *     recebem ?cliente=&conta=; Margem (só Mercado Livre) some para conta Shopee;
 *  4. admin clica e ABRE as 4 telas (Central de Vendas sem redirecionar ao Financeiro);
 *  5. não-admin que abre fechamentos-api.html por URL segue para o Financeiro,
 *     preservando a query; admin não;
 *  6. nenhuma exceção não tratada nas telas abertas.
 *
 * DUMP=1 imprime os ids do menu por papel (para atualizar as baselines).
 */
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORTAL_DIR = __dirname;
const PROD_HOST = "venforce-server.onrender.com";

// Menu atual (sidebar) dos perfis NÃO admin — baseline lida da main (61344c17).
const MENU_NAO_ADMIN = ["visao", "painel-contas", "financeiro", "ads", "anuncios", "central-full", "curva-abc", "automacoes", "diagnosticos", "promocoes-ml", "resgate", "pessoas", "clientes-contas", "relatorios", "bases", "ferramentas"];
// Os 4 itens restaurados SÓ para admin, com a rota esperada.
const ITENS_ADMIN = [
  { id: "cliente-360-v3", rota: "cliente-360-v3.html" },
  { id: "sentinel", rota: "sentinel.html" },
  { id: "central-vendas", rota: "fechamentos-api.html" },
  { id: "margem", rota: "central-margem.html" },
];
const PAPEIS_NAO_ADMIN = ["user", "membro", "interno", "gestor", "coordenador"];

const g = (id, status) => ({ id, ml_user_id: String(1000 + id), token_status: status || "valid", is_primary: true });
const CLIENTES = [
  { id: 87, nome: "N97 Comercial", slug: "n97", ativo: true, temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100, statusOperacional: "pronto", ultimaSincronizacao: "2026-08-25T14:00:00Z", pendencias: [] },
  { id: 90, nome: "Loja Shopee", slug: "loja-shopee", ativo: true, temGrant: false, grantStatus: "n/a", temBase: true, setupScore: 100, statusOperacional: "pronto", ultimaSincronizacao: "2026-08-25T14:00:00Z", pendencias: [] },
];
const CONTAS = {
  n97: [{ id: 42, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre", slug: "ml", external_account_id: "182993004", is_primary: true, ativo: true, grant: g(900), base: { vinculo_id: 509, base_id: 9, slug: "base-9", nome: "Custo 2026", resolvido_por: "conta" } }],
  "loja-shopee": [{ id: 61, cliente_id: 90, marketplace: "shopee", nome: "Shopee", slug: "shp", external_account_id: "555", is_primary: true, ativo: true, grant: null, base: { vinculo_id: 610, base_id: 10, slug: "base-10", nome: "Custo Shopee", resolvido_por: "conta" } }],
};

let papelAtual = "admin";
function meContext() {
  const clientes = CLIENTES.map((c) => ({ id: c.id, slug: c.slug, nome: c.nome, squadId: null, responsavelDireto: false, contasAtivas: null }));
  return { ok: true, user: { id: 12, nome: "Pedro Gomes", email: null, role: papelAtual }, squads: [], squadPrincipalId: null, clientes, portfolio: { totalClientes: clientes.length }, permissoes: { podeAdministrar: papelAtual === "admin" } };
}

function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    const target = path.resolve(PORTAL_DIR, u.pathname.replace(/^\/+/, ""));
    if (!target.startsWith(path.resolve(PORTAL_DIR) + path.sep)) { res.writeHead(403).end("forbidden"); return; }
    fs.readFile(target, (err, contents) => {
      if (err) { res.writeHead(404).end("not found"); return; }
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };
      res.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(contents);
    });
  });
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitChrome(port) {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return; } catch (_) { /* aguardando */ } await sleep(50); }
  throw new Error("Chrome DevTools não iniciou.");
}
class Cdp {
  constructor(url) { this.socket = new WebSocket(url); this.nextId = 1; this.pending = new Map(); this.onEvent = null; }
  async open() {
    await new Promise((resolve, reject) => { this.socket.addEventListener("open", resolve, { once: true }); this.socket.addEventListener("error", reject, { once: true }); });
    this.socket.addEventListener("message", (event) => {
      const m = JSON.parse(event.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); return; }
      if (m.method && this.onEvent) this.onEvent(m.method, m.params);
    });
  }
  send(method, params = {}) { const id = this.nextId++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "Falha na avaliação do navegador");
    return r.result.value;
  }
  close() { this.socket.close(); }
}
async function waitFor(cdp, expression, message) {
  for (let i = 0; i < 200; i++) { if (await cdp.evaluate(`Boolean(${expression})`)) return; await sleep(50); }
  throw new Error(message || `Timeout: ${expression}`);
}

let checks = 0;
async function check(name, fn) { await fn(); checks += 1; console.log(`ok ${checks} - ${name}`); }

const excecoes = [];
function wireFetch(cdp) {
  const respond = async (m, p) => { try { await cdp.send(m, p); } catch (err) { if (!/Invalid InterceptionId/.test(err.message || "")) throw err; } };
  cdp.onEvent = async (method, params) => {
    if (method === "Runtime.exceptionThrown") excecoes.push(`${params.exceptionDetails.text} ${(params.exceptionDetails.exception || {}).description || ""} @${params.exceptionDetails.url || ""}`.trim());
    if (method !== "Fetch.requestPaused") return;
    const req = params.request, url = req.url;
    if (!url.includes(PROD_HOST)) { await respond("Fetch.continueRequest", { requestId: params.requestId }); return; }
    const cors = [{ name: "access-control-allow-origin", value: "*" }, { name: "access-control-allow-headers", value: "authorization,content-type" }, { name: "access-control-allow-methods", value: "GET,POST,PATCH,OPTIONS" }];
    if (req.method === "OPTIONS") { await respond("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 204, responseHeaders: cors }); return; }
    const json = (obj) => respond("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 200, responseHeaders: [...cors, { name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(obj)).toString("base64") });
    if (url.includes("/me/context")) { await json(meContext()); return; }
    if (url.includes("/operacao/cliente-360/clientes")) { await json({ ok: true, clientes: CLIENTES }); return; }
    const m = url.match(/\/clientes\/([^/?]+)\/contas/);
    if (m) { const slug = decodeURIComponent(m[1]); const c = CLIENTES.find((x) => x.slug === slug); await json({ ok: true, cliente: c || { id: 1, nome: slug, slug, ativo: true }, contas: CONTAS[slug] || [] }); return; }
    // Tudo o mais fica fora do ar de propósito: as telas têm estado de erro próprio; aqui só
    // importa que a navegação, o Shell e o gate de papel funcionem. NADA vai para produção.
    await respond("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionRefused" });
  };
}

async function run() {
  const server = await startServer();
  const porta = server.address().port;
  const base = `http://127.0.0.1:${porta}`;
  const debugPort = 26000 + Math.floor(Math.random() * 1000);
  const chrome = childProcess.spawn("google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--remote-debugging-port=${debugPort}`, `--user-data-dir=/tmp/vf-admin-nav-${process.pid}`, "about:blank"], { stdio: "ignore" });
  let cdp;
  try {
    await waitChrome(debugPort);
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    wireFetch(cdp);

    // Define o papel (localStorage) e abre a URL; espera o Shell montar.
    async function abrirComo(papel, url, { semShell = false } = {}) {
      papelAtual = papel;
      await cdp.send("Page.navigate", { url: `${base}/painel-contas.html` });
      await sleep(80);
      await cdp.evaluate(`localStorage.setItem("vf-token","ui-test-token"); localStorage.setItem("vf-user", JSON.stringify({ id: 12, nome: "Pedro Gomes", role: ${JSON.stringify(papel)} })); sessionStorage.clear();`);
      await cdp.send("Page.navigate", { url: `${base}/${url}` });
      if (!semShell) await waitFor(cdp, "window.VF && window.VF.shell && document.querySelector('.vf-shell__nav')", `Shell não montou em ${url} (${papel})`);
    }
    const idsMenu = () => cdp.evaluate(`Array.from(document.querySelectorAll('.vf-shell__nav .vf-shell__item[data-module]')).filter(function(a){return !a.closest('.vf-shell__admin');}).map(function(a){return a.dataset.module;})`);

    if (process.env.DUMP) {
      for (const p of ["admin", ...PAPEIS_NAO_ADMIN]) { await abrirComo(p, "painel-contas.html"); await sleep(300); console.log(`MENU ${p}: ${JSON.stringify(await idsMenu())}`); }
      return;
    }

    // ═══ 1. admin: menu novo + os 4 itens, uma vez cada, rota correta ═══
    await abrirComo("admin", "painel-contas.html");
    await sleep(300);
    await check("admin: o menu novo continua inteiro e os 4 itens operacionais aparecem", async () => {
      const ids = await idsMenu();
      for (const id of MENU_NAO_ADMIN) assert.ok(ids.includes(id), `item do menu novo ausente para admin: ${id}`);
      for (const it of ITENS_ADMIN) assert.ok(ids.includes(it.id), `item restaurado ausente para admin: ${it.id}`);
      assert.strictEqual(ids.length, MENU_NAO_ADMIN.length + ITENS_ADMIN.length, `itens inesperados no menu admin: ${JSON.stringify(ids)}`);
    });
    await check("admin: nenhum item duplicado na sidebar", async () => {
      const ids = await idsMenu();
      assert.strictEqual(new Set(ids).size, ids.length, `duplicados: ${JSON.stringify(ids)}`);
    });
    await check("admin: Sentinel (global) aponta direto para sentinel.html; os de módulo ficam inertes (#) até haver contexto", async () => {
      const href = (id) => cdp.evaluate(`(function(){var a=document.querySelector('.vf-shell__nav .vf-shell__item[data-module="${id}"]');return a?(a.getAttribute('href')||''):null;})()`);
      assert.strictEqual((await href("sentinel")).split("?")[0], "sentinel.html");
      for (const id of ["cliente-360-v3", "central-vendas", "margem"]) assert.strictEqual(await href(id), "#", `${id}: sem contexto o link deveria ser inerte`);
    });
    await check("admin: sem cliente/operação, itens de módulo ficam inertes (aria-disabled) — Sentinel (global) não", async () => {
      const dis = (id) => cdp.evaluate(`(function(){var a=document.querySelector('.vf-shell__nav .vf-shell__item[data-module="${id}"]');return a?a.getAttribute('aria-disabled')==='true'||a.classList.contains('is-disabled'):null;})()`);
      for (const id of ["cliente-360-v3", "central-vendas", "margem"]) assert.strictEqual(await dis(id), true, `${id} deveria exigir contexto`);
      assert.notStrictEqual(await dis("sentinel"), true, "Sentinel é global: não pode exigir contexto");
    });

    // ═══ 2. demais perfis: EXATAMENTE o menu atual ═══
    for (const p of PAPEIS_NAO_ADMIN) {
      await abrirComo(p, "painel-contas.html");
      await sleep(250);
      await check(`${p}: menu idêntico ao atual, sem nenhum dos 4 itens`, async () => {
        const ids = await idsMenu();
        assert.deepStrictEqual(ids, MENU_NAO_ADMIN, `menu de ${p} mudou: ${JSON.stringify(ids)}`);
        for (const it of ITENS_ADMIN) assert.ok(!ids.includes(it.id), `${it.id} apareceu para ${p}`);
        assert.strictEqual(await cdp.evaluate("Boolean(document.querySelector('.vf-shell__admin'))"), false, `Administração apareceu para ${p}`);
      });
    }

    // ═══ 3. contexto e marketplace (admin) ═══
    await abrirComo("admin", "painel-contas.html?cliente=n97&conta=42");
    await waitFor(cdp, "window.VF.context && window.VF.context.getState() === 'READY'", "contexto n97/42 não chegou a READY");
    await sleep(200);
    await check("admin + n97/ML: itens de módulo habilitados e com ?cliente=n97&conta=42", async () => {
      for (const id of ["cliente-360-v3", "central-vendas", "margem"]) {
        const info = await cdp.evaluate(`(function(){var a=document.querySelector('.vf-shell__nav .vf-shell__item[data-module="${id}"]');return a?{href:a.getAttribute('href')||'',dis:a.getAttribute('aria-disabled')==='true'||a.classList.contains('is-disabled')}:null;})()`);
        assert.ok(info, `${id} ausente`);
        assert.strictEqual(info.dis, false, `${id} deveria estar habilitado com contexto`);
        assert.strictEqual(info.href.split("?")[0], ITENS_ADMIN.find((x) => x.id === id).rota, `${id}: rota errada em "${info.href}"`);
        assert.ok(/[?&]cliente=n97\b/.test(info.href) && /[?&]conta=42\b/.test(info.href), `${id}: contrato cliente/conta ausente em "${info.href}"`);
      }
    });
    await abrirComo("admin", "painel-contas.html?cliente=loja-shopee&conta=61");
    await waitFor(cdp, "window.VF.context && window.VF.context.getState() === 'READY'", "contexto Shopee não chegou a READY");
    await sleep(250);
    await check("admin + conta Shopee: Margem (só Mercado Livre) fica indisponível; Central de Vendas e Cliente 360 V3 seguem disponíveis", async () => {
      const disponivel = (id) => cdp.evaluate(`Boolean(document.querySelector('.vf-shell__nav .vf-shell__item[data-module="${id}"]:not(.is-disabled):not([aria-disabled="true"])')) && !document.querySelector('.vf-shell__unavailable .vf-shell__item[data-module="${id}"]')`);
      assert.strictEqual(await disponivel("central-vendas"), true, "Central de Vendas deveria estar disponível");
      assert.strictEqual(await disponivel("cliente-360-v3"), true, "Cliente 360 V3 deveria estar disponível");
      assert.strictEqual(await disponivel("margem"), false, "Margem não deveria estar disponível para conta Shopee");
    });

    // ═══ 4. admin ABRE as 4 telas por clique real ═══
    await abrirComo("admin", "painel-contas.html?cliente=n97&conta=42");
    await waitFor(cdp, "window.VF.context && window.VF.context.getState() === 'READY'", "contexto n97/42 não chegou a READY");
    const telas = [
      { id: "central-vendas", arquivo: "fechamentos-api.html", modulo: "central-vendas", classe: "vf-page-fechamentos-api" },
      { id: "cliente-360-v3", arquivo: "cliente-360-v3.html", modulo: "cliente-360-v3" },
      { id: "sentinel", arquivo: "sentinel.html", modulo: "sentinel" },
      { id: "margem", arquivo: "central-margem.html", modulo: "margem" },
    ];
    for (const t of telas) {
      await abrirComo("admin", "painel-contas.html?cliente=n97&conta=42");
      await waitFor(cdp, "window.VF.context && window.VF.context.getState() === 'READY'", "contexto não chegou a READY");
      await waitFor(cdp, `document.querySelector('.vf-shell__nav .vf-shell__item[data-module="${t.id}"]:not(.is-disabled):not([aria-disabled="true"])')`, `${t.id} continuou inerte na sidebar`);
      await cdp.evaluate(`document.querySelector('.vf-shell__nav .vf-shell__item[data-module="${t.id}"]').click()`);
      await waitFor(cdp, `location.pathname.indexOf('${t.arquivo}') >= 0`, `clique em ${t.id} não navegou para ${t.arquivo}`);
      await waitFor(cdp, "window.VF && window.VF.shell && document.querySelector('.vf-shell__nav')", `${t.arquivo} não montou o Shell`);
      await sleep(400);
      await check(`admin: clique abre ${t.arquivo} (sem redirecionar), com Shell, contexto e item ativo`, async () => {
        assert.ok((await cdp.evaluate("location.pathname")).endsWith(t.arquivo), "foi redirecionado para outra página");
        const ctx = await cdp.evaluate("window.VF.context.getContext()");
        assert.ok(ctx && ctx.clienteSlug === "n97" && ctx.clienteContaId === 42, `contexto perdido em ${t.arquivo}: ${JSON.stringify(ctx)}`);
        if (t.classe) assert.ok(await cdp.evaluate(`document.body.classList.contains(${JSON.stringify(t.classe)})`), "corpo da página restaurada ausente");
        assert.strictEqual(await cdp.evaluate("document.body.dataset.vfModule"), t.modulo);
        const ativo = await cdp.evaluate(`(function(){var a=document.querySelector('.vf-shell__nav .vf-shell__item[data-module="${t.id}"]');return a?(a.classList.contains('is-active')||a.getAttribute('aria-current')==='page'):false;})()`);
        assert.strictEqual(ativo, true, `${t.id} deveria aparecer como item ativo`);
      });
    }

    // ═══ 5. Central de Vendas por URL: admin fica; não-admin vai ao Financeiro com a mesma query ═══
    await abrirComo("admin", "fechamentos-api.html?cliente=n97&conta=42&periodo=2026-09");
    await sleep(500);
    await check("admin: fechamentos-api.html por URL permanece na Central de Vendas (sem redirecionar ao Financeiro)", async () => {
      const loc = await cdp.evaluate("location.pathname + location.search");
      assert.ok(loc.startsWith("/fechamentos-api.html"), `redirecionado para ${loc}`);
      assert.ok(await cdp.evaluate("Boolean(document.querySelector('.vf-shell__nav'))"));
    });
    for (const p of ["user", "membro", "interno", "gestor", "coordenador"]) {
      await abrirComo(p, "fechamentos-api.html?cliente=n97&conta=42&periodo=2026-09", { semShell: true });
      await waitFor(cdp, "location.pathname.indexOf('financeiro-v3.html') >= 0", `${p} não foi levado ao Financeiro`);
      await check(`${p}: fechamentos-api.html segue para o Financeiro preservando cliente/conta/período`, async () => {
        const loc = await cdp.evaluate("location.search");
        assert.ok(/cliente=n97/.test(loc) && /conta=42/.test(loc) && /periodo=2026-09/.test(loc), `query perdida: ${loc}`);
      });
    }

    await check("nenhuma exceção não tratada nas telas abertas", async () => {
      // "Transition was skipped": o CSS compartilhado (vf-shell.css / vf-tokens-v2.css) ativa
      // @view-transition entre documentos; quando o teste navega logo em seguida, o navegador
      // descarta a transição anterior. É artefato da navegação programática, presente em todas
      // as páginas — não é erro de tela.
      const reais = excecoes.filter((e) => !/AbortError: Transition was skipped/.test(e));
      assert.deepStrictEqual(reais, [], `exceções: ${reais.join(" | ")}`);
    });
    console.log(`\n✓ ${checks} verificações de navegação admin (hotfix admin-nav-restore-vendas)`);
  } finally {
    if (cdp) cdp.close();
    chrome.kill("SIGTERM");
    server.close();
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
