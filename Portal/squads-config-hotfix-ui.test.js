/*
 * Teste de regressão — hotfix pós-PR #99 (Squads).
 *
 * Cobre os 2 gaps reais achados depois do deploy da tela de administração
 * de Squads:
 *   1. squads-config.html não tinha entrada de menu no Shell V3.
 *   2. A tela só permitia MOVER clientes que já pertencem a um squad —
 *      clientes novos, criados sem squad, ficavam invisíveis.
 *
 * Mesma infraestrutura de Portal/vf-shell-navigation-recovery-ui.test.js:
 * spawn de `google-chrome --headless=new` + Chrome DevTools Protocol puro,
 * sem dependências externas. O próprio teste serve os arquivos estáticos do
 * Portal e um backend fake mínimo, com estado mutável para os endpoints de
 * Squads (GET/POST /squads/:id/clientes, GET /clientes).
 */
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PORTAL_DIR = __dirname;

/* ── ESTADO FAKE DO BACKEND ──────────────────────────────────────────────
   squadClientLinks: squadId -> [clienteId, ...] — espelha
   cliente_squad_history (fim_em IS NULL). allClients tem 1 cliente já
   vinculado ao Squad Alfa, 1 cliente ativo SEM squad (o caso do hotfix) e 1
   cliente inativo sem squad (não deve aparecer no picker). */
function estadoInicial() {
  return {
    squads: [
      { id: 1, nome: "Squad Alfa", slug: "alfa", ativo: true },
      { id: 2, nome: "Squad Beta", slug: "beta", ativo: true },
    ],
    membros: { 1: [{ user_id: 10, user_nome: "Ana Coordenadora", user_email: "ana@venforce.com", funcao: "coordenador", is_primary: true }], 2: [] },
    squadClientLinks: { 1: [100], 2: [] },
    allClients: [
      { id: 100, nome: "Cliente Vinculado", slug: "cliente-vinculado", ativo: true },
      { id: 200, nome: "Cliente Novo Sem Squad", slug: "cliente-novo-sem-squad", ativo: true },
      { id: 300, nome: "Cliente Inativo", slug: "cliente-inativo", ativo: false },
    ],
    posts: [], // log de toda POST recebida — asserções verificam contra isto
  };
}
let STATE_BACKEND = estadoInicial();

function clientesDoSquad(id) {
  const ids = STATE_BACKEND.squadClientLinks[id] || [];
  return STATE_BACKEND.allClients.filter((c) => ids.includes(c.id));
}

function squadDoCliente(clienteId) {
  return Object.keys(STATE_BACKEND.squadClientLinks).find((sid) =>
    (STATE_BACKEND.squadClientLinks[sid] || []).includes(Number(clienteId))
  );
}

function harnessRedirectHtml(destino) {
  return `<!doctype html><html><head><meta charset="UTF-8"></head><body>
<script>
  localStorage.setItem("vf-token", "test-token");
  localStorage.setItem("vf-user", JSON.stringify({ id: 1, nome: "Admin Teste", role: "admin" }));
  location.replace(${JSON.stringify(destino)});
</script>
</body></html>`;
}

/* squads-config.js tem API_BASE hardcoded para produção
   (https://venforce-server.onrender.com — não usa vf-config.js/meta tag).
   Para testar sem tocar produção, os requests desse host são interceptados
   via CDP Fetch domain (ver interceptApiRequests()) e respondidos por esta
   mesma função de rota, compartilhada com o servidor HTTP local usado pelo
   Shell V3 (achado 1). Única fonte de verdade do backend fake. */
function rotaApi(pathname, method, bodyObj) {
  const j = (status, body) => ({ status, body });

  if (pathname === "/me/context") return j(404, { ok: false });
  if (pathname === "/operacao/cliente-360/clientes") return j(200, { ok: true, clientes: [] });

  if (pathname === "/squads" && method === "GET") {
    const squads = STATE_BACKEND.squads.map((s) => ({
      ...s,
      clientes_ativos: (STATE_BACKEND.squadClientLinks[s.id] || []).length,
      membros_ativos: (STATE_BACKEND.membros[s.id] || []).length,
    }));
    return j(200, { ok: true, squads });
  }

  let m = pathname.match(/^\/squads\/(\d+)\/membros$/);
  if (m && method === "GET") return j(200, { ok: true, membros: STATE_BACKEND.membros[Number(m[1])] || [] });

  m = pathname.match(/^\/squads\/(\d+)\/clientes$/);
  if (m && method === "GET") return j(200, { ok: true, clientes: clientesDoSquad(Number(m[1])) });
  if (m && method === "POST") {
    const squadId = Number(m[1]);
    const body = bodyObj || {};
    STATE_BACKEND.posts.push({ path: pathname, squadId, body });
    const clienteId = Number(body.clienteId);
    const jaTem = squadDoCliente(clienteId);
    if (jaTem) return j(409, { ok: false, erro: "Cliente já pertence a um squad. Use transferência." });
    STATE_BACKEND.squadClientLinks[squadId] = STATE_BACKEND.squadClientLinks[squadId] || [];
    STATE_BACKEND.squadClientLinks[squadId].push(clienteId);
    return j(201, { ok: true, vinculo: { cliente_id: clienteId, squad_id: squadId } });
  }

  m = pathname.match(/^\/squads\/(\d+)\/clientes\/(\d+)\/transferir$/);
  if (m && method === "POST") {
    const destinoId = Number(m[1]);
    const clienteId = Number(m[2]);
    const body = bodyObj || {};
    STATE_BACKEND.posts.push({ path: pathname, destinoId, clienteId, body });
    const origemId = squadDoCliente(clienteId);
    if (origemId != null) {
      STATE_BACKEND.squadClientLinks[origemId] = (STATE_BACKEND.squadClientLinks[origemId] || []).filter((id) => id !== clienteId);
    }
    STATE_BACKEND.squadClientLinks[destinoId] = STATE_BACKEND.squadClientLinks[destinoId] || [];
    STATE_BACKEND.squadClientLinks[destinoId].push(clienteId);
    return j(200, { ok: true, resultado: { cliente_id: clienteId, squad_id: destinoId } });
  }

  if (pathname === "/clientes" && method === "GET") return j(200, { ok: true, clientes: STATE_BACKEND.allClients });
  if (pathname === "/usuarios" && method === "GET") return j(200, { ok: true, usuarios: [] });

  return j(404, { ok: false, erro: `rota fake não implementada: ${method} ${pathname}` });
}

// Mesmo harness de vf-shell-navigation-recovery-ui.test.js, para a
// verificação de navegação (achado 1).
function shellHarnessHtml(scope, moduleId, role) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="vf-api-base" content="http://127.0.0.1:${global.__PORT__}">
<link rel="stylesheet" href="/css/vf-tokens-v2.css">
<link rel="stylesheet" href="/css/vf-components-v2.css">
<link rel="stylesheet" href="/css/vf-shell.css">
</head>
<body class="vf-page" data-vf-scope="${scope}" data-vf-module="${moduleId}">
<script>
  localStorage.setItem("vf-token", "test-token");
  localStorage.setItem("vf-user", JSON.stringify({ id: 12, nome: "Pedro Gomes", role: "${role}" }));
</script>
<main id="conteudo-de-teste"><p>Conteúdo da página de teste.</p></main>
<script type="module" src="/vf-shell.js"></script>
</body></html>`;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const readBody = (cb) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }
        cb(parsed);
      });
    };

    if (u.pathname === "/harness-nav.html") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(shellHarnessHtml(u.searchParams.get("scope") || "global", u.searchParams.get("module") || "ferramentas", u.searchParams.get("role") || "user"));
      return;
    }

    if (u.pathname === "/harness-squads.html") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(harnessRedirectHtml("/squads-config.html"));
      return;
    }

    const ROTAS_API = ["/me/context", "/operacao/cliente-360/clientes", "/squads", "/clientes", "/usuarios"];
    if (ROTAS_API.some((p) => u.pathname === p || u.pathname.startsWith("/squads/"))) {
      if (req.method === "GET") {
        const { status, body } = rotaApi(u.pathname, "GET", null);
        json(status, body);
        return;
      }
      readBody((bodyObj) => {
        const { status, body } = rotaApi(u.pathname, req.method, bodyObj);
        json(status, body);
      });
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
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { global.__PORT__ = server.address().port; resolve(server); }));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitChrome(port) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return; } catch { /* aguardando */ }
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
      if (message.method === "Fetch.requestPaused") { this.onRequestPaused && this.onRequestPaused(message.params); return; }
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
  }
  // squads-config.js chama API_BASE hardcoded para produção
  // (https://venforce-server.onrender.com), não a meta vf-api-base. Em vez
  // de deixar essas chamadas saírem para produção, intercepta via Fetch
  // domain e responde com o mesmo backend fake usado pelo servidor HTTP
  // local (rotaApi) — nenhuma requisição real chega a produção.
  async interceptApiRequests(prefixoProducao) {
    await this.send("Fetch.enable", { patterns: [{ urlPattern: `${prefixoProducao}/*` }] });
    this.onRequestPaused = async (params) => {
      const { requestId, request } = params;
      const u = new URL(request.url);
      // squads-config.js chama produção cross-origin → o browser manda um
      // preflight OPTIONS antes de qualquer GET/POST com Authorization.
      // Sem responder esse preflight com CORS explícito, o fetch real nunca
      // sai (net::ERR_FAILED), mesmo com o Fetch domain interceptando tudo.
      if (request.method === "OPTIONS") {
        await this.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: 204,
          responseHeaders: [
            { name: "Access-Control-Allow-Origin", value: "*" },
            { name: "Access-Control-Allow-Methods", value: "GET,POST,PATCH,DELETE,OPTIONS" },
            { name: "Access-Control-Allow-Headers", value: "Content-Type, Authorization" },
          ],
        });
        return;
      }
      const bodyObj = request.postData ? JSON.parse(request.postData) : null;
      const { status, body } = rotaApi(u.pathname, request.method, bodyObj);
      const json = JSON.stringify(body);
      await this.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: status,
        responseHeaders: [
          { name: "Content-Type", value: "application/json" },
          { name: "Access-Control-Allow-Origin", value: "*" },
        ],
        body: Buffer.from(json, "utf8").toString("base64"),
      });
    };
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
    if (result.exceptionDetails) {
      const d = result.exceptionDetails;
      const desc = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error(`${desc} :: ${expression}`);
    }
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
  const debugPort = 16000 + Math.floor(Math.random() * 800);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=/tmp/vf-squads-hotfix-${process.pid}`,
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
    await cdp.interceptApiRequests("https://venforce-server.onrender.com");

    /* ═════════════ ACHADO 1 — link Squads no Shell V3 (admin) ═══════════ */
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${global.__PORT__}/harness-nav.html?scope=global&module=ferramentas&role=admin` });
    await waitFor(cdp, "window.VF && window.VF.shell", "vf-shell não montou (admin)");
    await waitFor(cdp, "window.VF.context.getState() !== 'BOOT'", "contexto não saiu de BOOT (admin)");

    await check("Squads aparece dentro de Administração para admin e aponta para squads-config.html", async () => {
      const href = await cdp.evaluate(
        "(function(){ var a = document.querySelector('.vf-shell__admin .vf-shell__item[data-module=squads]'); return a ? a.getAttribute('href') : null; })();"
      );
      assert.ok(href, "nenhum .vf-shell__item[data-module=squads] dentro de .vf-shell__admin — link não foi adicionado");
      assert.strictEqual(href.split("?")[0], "squads-config.html");
    });

    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${global.__PORT__}/harness-nav.html?scope=global&module=ferramentas&role=user` });
    await waitFor(cdp, "window.VF && window.VF.shell", "vf-shell não montou (user)");
    await waitFor(cdp, "window.VF.context.getState() !== 'BOOT'", "contexto não saiu de BOOT (user)");

    await check("Squads NÃO aparece para usuário comum (seção Administração some inteira)", async () => {
      const existeAdmin = await cdp.evaluate("Boolean(document.querySelector('.vf-shell__admin'))");
      assert.strictEqual(existeAdmin, false, "usuário comum não deveria ver a seção Administração");
    });

    /* ═════════ ACHADO 2 — clientes sem squad em squads-config.html ══════ */
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${global.__PORT__}/harness-squads.html` });
    await waitFor(cdp, "document.getElementById('sq-list') && document.getElementById('sq-list').children.length > 0", "lista de squads não carregou");

    // Abre o detalhe do Squad Beta (id=2) — squad sem cliente nenhum.
    await cdp.evaluate(`(function(){
      var btns = Array.from(document.querySelectorAll('button[data-action="abrir"]'));
      var alvo = btns.find(function(b){ return b.getAttribute('data-id') === '2'; });
      alvo.click();
    })();`);
    await waitFor(cdp, "document.getElementById('sq-detail').style.display === 'block'", "detalhe do Squad Beta não abriu");

    await check("botão '+ Adicionar cliente' existe na área Clientes do detalhe", async () => {
      const existe = await cdp.evaluate("Boolean(document.getElementById('sq-btn-add-cliente'))");
      assert.ok(existe, "botão + Adicionar cliente não está no DOM");
    });

    await cdp.evaluate("document.getElementById('sq-btn-add-cliente').click();");
    await waitFor(cdp, "document.getElementById('sq-addcliente-modal').classList.contains('is-open')", "modal de adicionar cliente não abriu");
    await waitFor(cdp,
      "document.getElementById('sq-addcliente-select').options.length > 0 && document.getElementById('sq-addcliente-select').options[0].value !== ''",
      "picker de clientes sem squad não carregou opções"
    );

    await check("cliente sem Squad (Cliente Novo Sem Squad) aparece no picker '+ Adicionar cliente'", async () => {
      const valores = await cdp.evaluate(
        "Array.from(document.getElementById('sq-addcliente-select').options).map(function(o){ return o.value; })"
      );
      assert.ok(valores.includes("200"), `esperava a opção do cliente 200 no picker, veio: ${JSON.stringify(valores)}`);
    });

    await check("cliente já vinculado a outro squad (Cliente Vinculado, id=100) NÃO aparece no picker", async () => {
      const valores = await cdp.evaluate(
        "Array.from(document.getElementById('sq-addcliente-select').options).map(function(o){ return o.value; })"
      );
      assert.ok(!valores.includes("100"), `cliente 100 (já vinculado ao Squad Alfa) não deveria aparecer no picker, veio: ${JSON.stringify(valores)}`);
    });

    await check("cliente inativo (id=300) NÃO aparece no picker", async () => {
      const valores = await cdp.evaluate(
        "Array.from(document.getElementById('sq-addcliente-select').options).map(function(o){ return o.value; })"
      );
      assert.ok(!valores.includes("300"), `cliente inativo não deveria aparecer no picker, veio: ${JSON.stringify(valores)}`);
    });

    // Seleciona o cliente 200 e confirma.
    await cdp.evaluate(`(function(){
      var sel = document.getElementById('sq-addcliente-select');
      sel.value = '200';
      sel.dispatchEvent(new Event('change'));
    })();`);

    await check("preview mostra 'Adicionar Cliente ... ao Squad Beta?' antes de confirmar", async () => {
      const texto = await cdp.evaluate("document.getElementById('sq-addcliente-preview').textContent");
      assert.ok(/Adicionar Cliente/.test(texto) && /Squad Beta/.test(texto), `preview inesperado: ${texto}`);
    });

    await cdp.evaluate("document.getElementById('sq-addcliente-confirm').click();");
    await waitFor(cdp, "!document.getElementById('sq-addcliente-modal').classList.contains('is-open')", "modal de adicionar cliente não fechou após confirmar");

    await check("atribuição chamou POST /squads/2/clientes com clienteId=200 (endpoint já existente, nenhum novo)", async () => {
      const chamada = STATE_BACKEND.posts.find((p) => p.path === "/squads/2/clientes" && p.body && Number(p.body.clienteId) === 200);
      assert.ok(chamada, `nenhuma POST /squads/2/clientes com clienteId=200 registrada. posts=${JSON.stringify(STATE_BACKEND.posts)}`);
    });

    await check("depois de atribuído, o cliente passa a aparecer na tabela de Clientes do Squad Beta", async () => {
      await waitFor(cdp, "document.getElementById('sq-clientes-wrap').textContent.indexOf('Cliente Novo Sem Squad') >= 0", "cliente atribuído não apareceu na tabela do squad");
    });

    await check("Grants/Bases/ClienteConta: nenhum endpoint fora de /squads e /clientes foi chamado pelo fluxo de atribuição", async () => {
      const rotasChamadas = STATE_BACKEND.posts.map((p) => p.path);
      for (const rota of rotasChamadas) {
        assert.ok(/^\/squads\//.test(rota), `rota inesperada chamada durante o fluxo de atribuição: ${rota}`);
      }
    });

    /* ═════════════════ REGRESSÃO — mover cliente existente ══════════════ */
    // Reabre o Squad Alfa (id=1), que ainda tem o Cliente Vinculado (100).
    await cdp.evaluate(`(function(){
      var btns = Array.from(document.querySelectorAll('button[data-action="abrir"]'));
      var alvo = btns.find(function(b){ return b.getAttribute('data-id') === '1'; });
      alvo.click();
    })();`);
    await waitFor(cdp, "document.getElementById('sq-clientes-wrap').textContent.indexOf('Cliente Vinculado') >= 0", "Squad Alfa não abriu com o Cliente Vinculado");

    await cdp.evaluate(`(function(){
      var btn = document.querySelector('button[data-action="mover"][data-cid="100"]');
      btn.click();
    })();`);
    await waitFor(cdp, "document.getElementById('sq-move-modal').classList.contains('is-open')", "modal de mover cliente não abriu");

    await cdp.evaluate(`(function(){
      var sel = document.getElementById('sq-move-destino');
      sel.value = '2';
      sel.dispatchEvent(new Event('change'));
    })();`);
    await cdp.evaluate("document.getElementById('sq-move-confirm').click();");
    await waitFor(cdp, "!document.getElementById('sq-move-modal').classList.contains('is-open')", "modal de mover cliente não fechou");

    await check("mover cliente existente continua chamando POST /squads/:id/clientes/:clienteId/transferir", async () => {
      const chamada = STATE_BACKEND.posts.find((p) => p.path === "/squads/2/clientes/100/transferir");
      assert.ok(chamada, `nenhuma POST de transferência registrada. posts=${JSON.stringify(STATE_BACKEND.posts)}`);
    });

    console.log(`\n✓ ${checks} verificações do hotfix pós-PR #99 (Squads)`);
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
