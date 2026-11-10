/*
 * Smoke test de interface em Chrome headless para login.js (F1.3) —
 * MASTER_SPEC D2/D3/D12/§20.3.
 *
 * Mesmo padrão de Portal/vf-shell-adoption-ui.test.js: servidor estático
 * local + CDP puro + interceptação via `Fetch` de POST /auth/login (o
 * único endpoint que login.js chama, com API_BASE hardcoded para
 * produção — igual fechamentos-api.js). Nunca toca o backend real.
 */
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PORTAL_DIR = __dirname;
const PROD_HOST = "venforce-server.onrender.com";

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    const target = path.resolve(PORTAL_DIR, u.pathname.replace(/^\/+/, "") || "index.html");
    if (!target.startsWith(path.resolve(PORTAL_DIR) + path.sep)) { res.writeHead(403).end("forbidden"); return; }
    fs.readFile(target, (err, contents) => {
      if (err) { res.writeHead(404).end("not found"); return; }
      const ext = path.extname(target);
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
      res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(contents);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
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
  for (let i = 0; i < 100; i++) {
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

let loginResponse = { ok: true, status: 200, body: { token: "tok-1", user: { id: 12, nome: "Pedro Gomes", role: "user" } } };

function wireFetchInterception(cdp) {
  const consoleErrors = [];
  // Uma navegação real (about:blank → index.html) pode deixar uma
  // Fetch.requestPaused (ex.: favicon) presa entre páginas: quando a
  // resposta chega, o Chrome já descartou aquele requestId e
  // Fetch.continueRequest/fulfillRequest rejeita com "Invalid
  // InterceptionId". Como onEvent roda fire-and-forget, essa rejeição virava
  // unhandled rejection e derrubava o processo inteiro (Node >=15). Mesmo
  // padrão de Portal/financeiro-v3-shell-ui.test.js e
  // Portal/fechamentos-api-shell-ui.test.js: engolir só esse erro benigno.
  const respond = async (method, params) => {
    try { await cdp.send(method, params); } catch (err) { if (!/Invalid InterceptionId/.test(err.message || "")) throw err; }
  };
  cdp.onEvent = async (method, params) => {
    if (method === "Runtime.consoleAPICalled" && params.type === "error") {
      consoleErrors.push((params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || "")).join(" "));
    }
    if (method !== "Fetch.requestPaused") return;
    const url = params.request.url;
    if (!url.includes(PROD_HOST)) { await respond("Fetch.continueRequest", { requestId: params.requestId }); return; }
    const cors = [
      { name: "access-control-allow-origin", value: "*" },
      { name: "access-control-allow-headers", value: "authorization,content-type" },
      { name: "access-control-allow-methods", value: "GET,POST,OPTIONS" },
    ];
    if (params.request.method === "OPTIONS") { await respond("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 204, responseHeaders: cors }); return; }
    if (url.includes("/auth/login")) {
      const body = Buffer.from(JSON.stringify(loginResponse.body)).toString("base64");
      await respond("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: loginResponse.status, responseHeaders: [...cors, { name: "content-type", value: "application/json" }], body });
      return;
    }
    await respond("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionRefused" });
  };
  return consoleErrors;
}

async function run() {
  const server = await startStaticServer();
  const serverPort = server.address().port;
  const debugPort = 20000 + Math.floor(Math.random() * 1000);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=/tmp/vf-login-ui-${process.pid}`, "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    await waitChrome(debugPort);
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    const consoleErrors = wireFetchInterception(cdp);

    async function gotoLoginLimpo() {
      // Storage.clearDataForOrigin (não localStorage.clear() DEPOIS de
      // navegar): login.js lê localStorage.vf-token de forma SÍNCRONA na
      // primeira linha executada (redirect "já logado"). Limpar via
      // evaluate() só depois do load perde a corrida — index.html já
      // redirecionou para o destino do cenário anterior antes do clear
      // rodar. Limpar a origem inteira ANTES de navegar elimina a corrida.
      await cdp.send("Storage.clearDataForOrigin", {
        origin: `http://127.0.0.1:${serverPort}`,
        storageTypes: "local_storage,session_storage",
      });
      await cdp.send("Page.navigate", { url: "about:blank" });
      await sleep(60);
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/index.html` });
      await waitFor(cdp, "document.readyState === 'complete' && document.getElementById('login-form')", "index.html não terminou de carregar");
    }

    async function submeter() {
      // dispatchEvent(submit) devolve false porque o handler chama
      // e.preventDefault() (é o comportamento esperado, não um erro).
      await cdp.evaluate(`
        document.getElementById("login-email").value = "pedro@venforce.com.br";
        document.getElementById("login-senha").value = "qualquer";
        document.getElementById("login-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      `);
    }

    /* ═══════ 1. login interno → painel-contas.html ═══════ */
    loginResponse = { ok: true, status: 200, body: { token: "tok-1", user: { id: 12, nome: "Pedro Gomes", role: "user" } } };
    await gotoLoginLimpo();
    await submeter();
    await waitFor(cdp, "window.location.href.indexOf('painel-contas.html') >= 0", "papel interno não redirecionou para painel-contas.html");
    await check("1. login interno (role=user) → painel-contas.html", async () => {
      const href = await cdp.evaluate("window.location.href");
      assert.ok(href.endsWith("/painel-contas.html"), `destino inesperado: ${href}`);
    });

    /* ═══════ 2. seller preservado ═══════ */
    loginResponse = { ok: true, status: 200, body: { token: "tok-2", user: { id: 20, nome: "Loja Seller", role: "seller" } } };
    await gotoLoginLimpo();
    await submeter();
    await waitFor(cdp, "window.location.href.indexOf('seller.html') >= 0", "seller não foi para seller.html");
    await check("2. seller → seller.html (destino preservado)", async () => {
      assert.ok((await cdp.evaluate("window.location.href")).endsWith("/seller.html"));
    });

    /* ═══════ 3. shopee_reviewer preservado ═══════ */
    loginResponse = { ok: true, status: 200, body: { token: "tok-3", user: { id: 30, nome: "Revisor Shopee", role: "shopee_reviewer" } } };
    await gotoLoginLimpo();
    await submeter();
    await waitFor(cdp, "window.location.href.indexOf('cliente-operacao.html') >= 0", "shopee_reviewer não foi para cliente-operacao.html");
    await check("3. shopee_reviewer → cliente-operacao.html (destino preservado)", async () => {
      assert.ok((await cdp.evaluate("window.location.href")).endsWith("/cliente-operacao.html"));
    });

    /* ═══════ 4. contexto de usuário anterior não sobrevive a um login novo ═══════ */
    loginResponse = { ok: true, status: 200, body: { token: "tok-4", user: { id: 12, nome: "Pedro Gomes", role: "user" } } };
    await gotoLoginLimpo();
    await cdp.evaluate(`
      sessionStorage.setItem("vf-ctx", JSON.stringify({ v: 1, userId: 999, clienteId: 87, clienteSlug: "n97", clienteContaId: 42 }));
    `);
    await submeter();
    await waitFor(cdp, "window.location.href.indexOf('painel-contas.html') >= 0", "login novo não chegou ao painel");
    await check("4. contexto do usuário anterior (userId=999) é eliminado ANTES da Carteira", async () => {
      const raw = await cdp.evaluate("sessionStorage.getItem('vf-ctx')");
      assert.strictEqual(raw, null, `vf-ctx deveria ter sido limpo, veio: ${raw}`);
      const href = await cdp.evaluate("window.location.href");
      assert.ok(!href.includes("cliente=") && !href.includes("conta="), `URL não deveria carregar contexto antigo: ${href}`);
    });

    /* ═══════ 5. login sem contexto anterior → normal ═══════ */
    loginResponse = { ok: true, status: 200, body: { token: "tok-5", user: { id: 12, nome: "Pedro Gomes", role: "user" } } };
    await gotoLoginLimpo();
    await submeter();
    await waitFor(cdp, "window.location.href.indexOf('painel-contas.html') >= 0", "login normal (sem contexto prévio) falhou");
    await check("5. login sem contexto anterior: fluxo normal, sem erro", async () => {
      assert.strictEqual(await cdp.evaluate("sessionStorage.getItem('vf-ctx')"), null);
    });

    /* ═══════ 6. falha no login NÃO limpa contexto de sessão autenticada existente ═══════ */
    await gotoLoginLimpo();
    await cdp.evaluate(`
      localStorage.setItem("vf-token", "sessao-existente-valida");
      localStorage.setItem("vf-user", JSON.stringify({ id: 55, nome: "Outra Sessão", role: "user" }));
      sessionStorage.setItem("vf-ctx", JSON.stringify({ v: 1, userId: 55, clienteId: 87, clienteSlug: "n97", clienteContaId: 42 }));
    `);
    // index.html redireciona sozinho se vf-token já existir (linha 15-19 de
    // login.js) — para testar o FORMULÁRIO de login com uma falha, a página
    // precisa ser recarregada SEM localStorage.vf-token (senão nunca
    // renderiza o form), mas o contexto de sessão (sessionStorage) precisa
    // sobreviver: é exatamente o cenário "usuário abriu uma aba nova de
    // login por engano, com sessionStorage ainda vivo de uma aba irmã, e
    // digitou a senha errada".
    await cdp.evaluate(`localStorage.removeItem("vf-token"); localStorage.removeItem("vf-user");`);
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/index.html` });
    await waitFor(cdp, "document.readyState === 'complete' && document.getElementById('login-form')", "index.html não terminou de carregar (cenário 6)");
    loginResponse = { ok: false, status: 401, body: { erro: "E-mail ou senha incorretos." } };
    await submeter();
    await waitFor(cdp, "document.getElementById('form-error').className.indexOf('show') >= 0", "banner de erro não apareceu após falha de login");
    await check("6. falha no login (401) não altera um vf-ctx de sessão existente", async () => {
      const raw = await cdp.evaluate("sessionStorage.getItem('vf-ctx')");
      assert.ok(raw, "vf-ctx não deveria ter sido removido numa falha de login");
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.clienteSlug, "n97");
      // continua na página de login (não navegou)
      assert.ok((await cdp.evaluate("window.location.href")).endsWith("/index.html"));
    });

    await check("sem erros de console em nenhum cenário (rede de produção sempre interceptada)", async () => {
      const relevantes = consoleErrors.filter((m) => !/favicon/i.test(m));
      assert.strictEqual(relevantes.length, 0, `erros de console: ${JSON.stringify(relevantes)}`);
    });

    console.log(`\n✓ ${checks} verificações de F1.3 (login → Painel de Contas)`);
  } finally {
    if (cdp) { try { await cdp.send("Fetch.disable"); } catch (_) { /* já pode estar fechado */ } cdp.close(); }
    chrome.kill("SIGTERM");
    server.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
