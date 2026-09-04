/*
 * F5 — regressão do LOTE de páginas migradas do layout.js para o Shell V3.
 *
 * Nove páginas trocaram de shell numa transformação mecânica idêntica
 * (link do vf-shell.css · data-vf-scope/data-vf-module no <body> · o
 * wrapper .vf-main-with-sidebar vira neutro · <script src="layout.js">
 * vira <script type="module" src="vf-shell.js"> + o no-op de initLayout).
 * "Mecânica e idêntica" é justamente o que torna um erro fácil de repetir
 * nove vezes — por isso cada página é aberta de verdade, no navegador, e
 * medida pelo mesmo conjunto de invariantes:
 *
 *   1. o Shell V3 montou (.vf-shell__sidebar existe);
 *   2. o shell LEGADO não montou junto (.vf-sidebar ausente) — os dois no
 *      mesmo documento são duas sidebars empilhadas (vf-shell.js:192);
 *   3. escopo global nunca bloqueia o conteúdo (#vf-shell-main visível);
 *   4. o item da própria página aparece marcado na navegação
 *      (aria-current="page") — é o que prova que data-vf-module bate com
 *      o id declarado em vf-shell.js;
 *   5. o conteúdo ORIGINAL da página continua no DOM (a migração não pode
 *      ter engolido a tela);
 *   6. nenhuma exceção de JS não tratada.
 *
 * Estratégia de rede: mesma de Portal/vf-shell-adoption-ui.test.js — as
 * páginas têm API_BASE de produção hardcoded, então toda chamada ao host
 * de produção é interceptada via CDP Fetch e nunca sai da máquina. Só o
 * que o SHELL precisa (/me/context, /clientes/:slug/contas) recebe
 * fixture; o "motor" de cada página fica deliberadamente fora do ar, como
 * nos demais testes desta suíte — o que se mede aqui é a troca de shell,
 * não o dado de cada tela.
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

/* Página → { módulo esperado na navegação, marca de conteúdo próprio }.
   A "marca" é um seletor que só existe naquela página: se a migração
   tivesse comido o conteúdo, o shell subiria igual e só isto acusaria. */
const PAGINAS = [
  { arquivo: "clientes.html", modulo: "clientes-contas", marca: "#clientes-feedback" },
  { arquivo: "usuarios.html", modulo: "pessoas", marca: "#usuarios-content" },
  { arquivo: "guia-vendedor.html", modulo: "guia", marca: "#reputacao" },
  { arquivo: "atividade.html", modulo: "atividade", marca: "#act-sum-total" },
  { arquivo: "control-center.html", modulo: "control-center", marca: "#cc-main" },
  { arquivo: "callbacks.html", modulo: "callbacks", marca: "#filter-base" },
  { arquivo: "financeiro-debug.html", modulo: "debug", marca: "#fdbg-main" },
  { arquivo: "design-system-lab.html", modulo: "lab", marca: "#lab-component-search" },
  { arquivo: "bases.html", modulo: "bases", marca: "#btn-abrir-importar" },
  // Escopo CONTA (fix/automacoes-account-scope): um cliente pode ter 2+
  // contas Mercado Livre, e automacoesRoutes.js agora recebe clienteContaId
  // — sem ele, com 2+ contas, o backend bloqueia com 409
  // MULTIPLE_MARKETPLACE_ACCOUNTS em vez de escolher um grant em silêncio
  // (o bug original). `?cliente=n97` basta para sair do gating porque a
  // fixture só dá 1 conta ML ativa a n97 (auto-seleção de conta única).
  { arquivo: "automacoes.html", modulo: "automacoes", marca: "#auto-cliente-nome", escopo: "account", query: "?cliente=n97" },
  // Escopo CONTA: as duas mandam `clienteContaId` e o backend responde 409
  // MULTIPLE_MARKETPLACE_ACCOUNTS sem ele. `?conta=42` porque a fixture de
  // contas dá uma conta ML ativa a n97.
  { arquivo: "ads.html", modulo: "ads", marca: "#ads-filtro-mes", escopo: "account", query: "?cliente=n97&conta=42" },
  { arquivo: "anuncios-meli.html", modulo: "anuncios", marca: "#am-view-hud", escopo: "account", query: "?cliente=n97&conta=42" },
  // Hub de Relatórios: escopo GLOBAL (a lista é de vários clientes) e sem
  // entrada na sidebar V3 — chega-se a ela pelos dois links de automacoes.js.
  // Por isso `modulo: null`: não há item de navegação para ficar ativo, e
  // fingir um seria inventar navegação.
  { arquivo: "relatorios.html", modulo: null, marca: "#rh-cliente" },
];

const N97 = { id: 87, nome: "N97 Comercial", slug: "n97", ativo: true, temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100, statusOperacional: "pronto", ultimaSincronizacao: null, pendencias: [] };
const PORTFOLIO = { ok: true, clientes: [N97] };
const N97_CONTAS = [{ id: 42, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre", ativo: true, grant: { token_status: "valid" }, base: { base_id: 9, nome: "Custo" } }];
const ME_CONTEXT = {
  ok: true,
  user: { id: 12, nome: "Pedro Gomes", email: null, role: "admin" },
  squads: [], squadPrincipalId: null,
  clientes: [{ id: 87, slug: "n97", nome: "N97 Comercial", squadId: null, responsavelDireto: false, contasAtivas: 1 }],
  portfolio: { totalClientes: 1 },
  permissoes: { podeAdministrar: true },
};

/* O harness precisa semear token/usuário ANTES de a página rodar. Como as
   páginas de produção são servidas como estão (é esse o ponto do teste),
   a semeadura entra por um Page.addScriptToEvaluateOnNewDocument. */
const SEMENTE = `
  try {
    localStorage.setItem("vf-token", "f5-lote-token");
    localStorage.setItem("vf-user", JSON.stringify({ id: 12, nome: "Pedro Gomes", role: "admin" }));
  } catch (e) {}
`;

function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    const target = path.resolve(PORTAL_DIR, u.pathname.replace(/^\/+/, ""));
    if (!target.startsWith(path.resolve(PORTAL_DIR) + path.sep)) { res.writeHead(403).end("forbidden"); return; }
    fs.readFile(target, (err, contents) => {
      if (err) { res.writeHead(404).end("not found"); return; }
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
      res.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(contents);
    });
  });
  /* Mesmo flake de harness diagnosticado em Portal/vf-shell-ui.test.js: esta
     suíte abre 13 páginas REAIS em sequência, e entre elas passam segundos
     de asserções CDP. O Node fecha a conexão keep-alive ociosa em 5s
     (padrão) enquanto o Chrome ainda a considera reutilizável, e a
     requisição seguinte morre no meio — o sintoma que aparecia aqui era
     "o Shell V3 não montou", porque a vítima sorteada era um dos módulos
     ES da página. Nada disto é produto: é o servidor do próprio teste. */
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
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
  for (let i = 0; i < 200; i++) {
    let ok = false;
    try { ok = await cdp.evaluate(`Boolean(${expression})`); } catch (_) { ok = false; }
    if (ok) return;
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

function wireInterception(cdp) {
  const excecoes = [];
  /* Nunca propaga. Um throw aqui roda dentro de um handler de evento async
     sem catch: a requisição interceptada fica PAUSADA para sempre e a página
     nunca termina de carregar — o erro real (seja qual for) apareceria
     depois, disfarçado de "o Shell V3 não montou". Interceptação morta
     (navegação trocou a página no meio) é o caso comum e é benigna. */
  const respond = async (m, p) => {
    try { await cdp.send(m, p); } catch (_) { /* interceptação já morreu */ }
  };
  cdp.onEvent = async (method, params) => {
    // Exceção NÃO TRATADA é o que este teste persegue; falha de rede
    // (deliberada, o motor de cada página está fora do ar) não é.
    if (method === "Runtime.exceptionThrown") {
      const texto = params?.exceptionDetails?.text || "";
      const desc = params?.exceptionDetails?.exception?.description || "";
      excecoes.push(`${texto} ${desc}`.trim());
    }
    if (method !== "Fetch.requestPaused") return;
    const url = params.request.url;
    // O harness serve o Portal em 127.0.0.1; SÓ ele continua de verdade.
    // Um recurso externo (as fontes do Google, presentes em quase toda
    // página) saindo para a internet real torna a suíte refém da rede da
    // máquina — e o sintoma não seria "a fonte não carregou": uma folha de
    // estilo PENDENTE bloqueia a execução dos <script> seguintes, então o
    // módulo /vf-shell.js nunca roda e o teste acusa "o Shell V3 não
    // montou". Foi o flake residual desta suíte (~1 em 5, sempre na
    // design-system-lab.html, a página mais pesada e a última do lote).
    // Devolver CSS vazio mantém a página funcional: os testes daqui medem
    // montagem do Shell, escopo e exceções de JS, nunca tipografia.
    if (!url.includes(PROD_HOST)) {
      if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
        await respond("Fetch.fulfillRequest", {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "text/css" }],
          body: "",
        });
        return;
      }
      await respond("Fetch.continueRequest", { requestId: params.requestId });
      return;
    }
    const cors = [
      { name: "access-control-allow-origin", value: "*" },
      { name: "access-control-allow-headers", value: "authorization,content-type" },
      { name: "access-control-allow-methods", value: "GET,POST,PATCH,PUT,DELETE,OPTIONS" },
    ];
    if (params.request.method === "OPTIONS") { await respond("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 204, responseHeaders: cors }); return; }
    const json = (obj) => respond("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 200, responseHeaders: [...cors, { name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(obj)).toString("base64") });

    if (url.includes("/me/context")) { await json(ME_CONTEXT); return; }
    if (url.includes("/operacao/cliente-360/clientes")) { await json(PORTFOLIO); return; }
    if (/\/clientes\/[^/?]+\/contas/.test(url)) { await json({ ok: true, cliente: N97, contas: N97_CONTAS }); return; }
    await respond("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionRefused" });
  };
  return excecoes;
}

async function run() {
  const server = await startServer();
  const porta = server.address().port;
  const debugPort = 19000 + Math.floor(Math.random() * 900);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=/tmp/vf-f5-lote-${process.pid}`, "about:blank",
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
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SEMENTE });
    const excecoes = wireInterception(cdp);

    for (const pagina of PAGINAS) {
      const antes = excecoes.length;
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/${pagina.arquivo}${pagina.query || ""}` });
      await waitFor(cdp, "document.querySelector('.vf-shell__sidebar')", `${pagina.arquivo}: o Shell V3 não montou`);
      await sleep(250); // o boot do contexto e o motor da página resolvem

      await check(`F5 — ${pagina.arquivo}: Shell V3 montou, layout.js NÃO montou junto`, async () => {
        assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-shell__sidebar').length"), 1);
        assert.strictEqual(
          await cdp.evaluate("document.querySelectorAll('.vf-sidebar').length"),
          0,
          "a sidebar do layout.js apareceu junto com a do Shell V3 — duas sidebars no mesmo documento"
        );
        assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-topbar').length"), 0, "topbar legada ainda presente");
      });

      const escopo = pagina.escopo || "global";
      await check(`F5 — ${pagina.arquivo}: escopo "${escopo}" satisfeito, e o conteúdo original continua lá`, async () => {
        assert.strictEqual(await cdp.evaluate("document.body.dataset.vfScope"), escopo);
        if (escopo !== "global") await waitFor(cdp, "document.getElementById('vf-shell-main').hidden === false", `${pagina.arquivo}: conteúdo continuou bloqueado pelo gating`);
        assert.strictEqual(await cdp.evaluate("document.getElementById('vf-shell-main').hidden"), false);
        assert.strictEqual(await cdp.evaluate("document.body.classList.contains('vf-shell-blocked')"), false);
        assert.ok(
          await cdp.evaluate(`Boolean(document.querySelector(${JSON.stringify(pagina.marca)}))`),
          `o conteúdo próprio da página (${pagina.marca}) sumiu na migração`
        );
      });

      if (pagina.modulo) await check(`F5 — ${pagina.arquivo}: item "${pagina.modulo}" marcado como página atual na navegação`, async () => {
        const ativo = await cdp.evaluate(`
          (function(){ var a = document.querySelector('.vf-shell__item[data-module=${JSON.stringify(pagina.modulo)}]');
            return a ? { current: a.getAttribute('aria-current'), classe: a.className } : null; })();
        `);
        assert.ok(ativo, `nenhum item de navegação com data-module="${pagina.modulo}" — data-vf-module não bate com vf-shell.js`);
        assert.strictEqual(ativo.current, "page");
        assert.ok(ativo.classe.includes("is-active"));
      });

      await check(`F5 — ${pagina.arquivo}: nenhuma exceção de JS não tratada`, async () => {
        const novas = excecoes.slice(antes).filter((m) => !/Failed to fetch|NetworkError|ERR_/i.test(m));
        assert.deepStrictEqual(novas, [], `exceções: ${JSON.stringify(novas)}`);
      });
    }

    /* Persona errada: `seller` tem área própria. Antes do lote, quem
       barrava era o layout.js (:319-323); agora é o shell. Sem isto, um
       consultor externo veria a navegação interna inteira. */
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `try { localStorage.setItem("vf-token","f5-lote-token"); localStorage.setItem("vf-user", JSON.stringify({ id: 77, nome: "Seller", role: "seller" })); } catch (e) {}`,
    });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/clientes.html` });
    await waitFor(cdp, "location.pathname.indexOf('seller.html') >= 0", "seller não foi desviado para a própria área");

    await check("F5 — role=seller numa página migrada é desviado para seller.html (paridade com layout.js)", async () => {
      assert.ok((await cdp.evaluate("location.pathname")).includes("seller.html"));
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.vf-shell__sidebar').length"), 0, "a navegação interna não pode ter sido montada para um seller");
    });

    console.log(`\n✓ ${checks} verificações do lote F5 (${PAGINAS.length} páginas migradas do layout.js para o Shell V3)`);
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
