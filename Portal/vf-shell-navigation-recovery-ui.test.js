/*
 * Teste de regressão de navegação — VENFORCE_AUDITORIA_FORENSE_RECUPERACAO_TELAS.md
 *
 * A auditoria forense provou que 9 telas de produto + 2 telas admin tinham
 * arquivo, backend e lógica ativos em ATUAL, mas ficaram sem entrada de
 * menu quando o Shell V3 (`Portal/vf-shell.js`) substituiu `layout.js` em
 * 20 páginas. Este teste protege a recuperação feita em
 * `fix/v3-navigation-recovery` contra a mesma regressão acontecer de novo:
 * congela, por asserção, quais telas devem (e quais NÃO devem) ter link no
 * Shell V3.
 *
 * Mesmo padrão de infraestrutura de Portal/vf-shell-ui.test.js (spawn de
 * `google-chrome --headless=new` + Chrome DevTools Protocol puro, sem
 * dependências externas): o próprio teste serve os arquivos estáticos do
 * Portal e um backend fake mínimo, e roda o boot de produção real de
 * vf-shell.js contra ele.
 */
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const PORTAL_DIR = __dirname;

const N97 = {
  id: 87, nome: "N97 Comercial", slug: "n97", ativo: true,
  temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100,
  statusOperacional: "pronto", ultimaSincronizacao: "2026-08-25T14:00:00Z", pendencias: [],
};
const N97_CONTAS = [
  { id: 42, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre", slug: "ml", external_account_id: "182993004", is_primary: true, ativo: true,
    grant: { id: 900, ml_user_id: "1099887766", token_status: "valid", is_primary: true },
    base: { vinculo_id: 509, base_id: 9, slug: "base-9", nome: "Custo 2026", resolvido_por: "conta" } },
];
const PORTFOLIO = { ok: true, clientes: [N97] };
const CONTAS = { n97: N97_CONTAS };

let currentRole = "user";

function harnessHtml(scope, moduleId) {
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="vf-api-base" content="http://127.0.0.1:${global.__PORT__}">
<link rel="stylesheet" href="/css/vf-tokens-v2.css">
<link rel="stylesheet" href="/css/vf-components-v2.css">
<link rel="stylesheet" href="/css/vf-shell.css">
</head>
<body class="vf-page" data-vf-scope="${scope}" data-vf-module="${moduleId}">
<script>
  var qs = new URLSearchParams(location.search);
  localStorage.setItem("vf-token", "test-token");
  localStorage.setItem("vf-user", JSON.stringify({ id: 12, nome: "Pedro Gomes", role: qs.get("role") || "user" }));
</script>
<main id="conteudo-de-teste"><p>Conteúdo da página de teste.</p></main>
<script type="module" src="/vf-shell.js"></script>
</body></html>`;
}

function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");

    if (u.pathname === "/harness.html") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(harnessHtml(u.searchParams.get("scope") || "global", u.searchParams.get("module") || "ferramentas"));
      return;
    }

    if (u.pathname === "/me/context") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"ok":false}');
      return;
    }

    if (u.pathname === "/operacao/cliente-360/clientes") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(PORTFOLIO));
      return;
    }

    const contasMatch = u.pathname.match(/^\/clientes\/([^/]+)\/contas$/);
    if (contasMatch) {
      const slug = decodeURIComponent(contasMatch[1]);
      const contas = CONTAS[slug];
      if (!contas) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, erro: "Cliente não encontrado." }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, cliente: { id: 87, nome: "N97 Comercial", slug, ativo: true }, contas }));
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
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { global.__PORT__ = server.address().port; resolve(server); }));
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

// TELA · ROTA · GRUPO esperado no Shell V3 — a fonte única de verdade deste
// teste. Qualquer mudança aqui é uma decisão de produto, não um detalhe de
// implementação.
// GLOBAIS: sempre habilitadas, independente de cliente/operação selecionados
// (nenhuma delas exige contexto — cada uma tem seletor próprio na página).
const TELAS_RESTAURADAS = [
  { modulo: "cliente-operacao", rotaEsperada: "cliente-operacao.html" },
  { modulo: "promocoes-ml", rotaEsperada: "promocoes-retorno.html" },
  { modulo: "curva-abc", rotaEsperada: "fechamento.html" },
];
const TELAS_ADMIN_RESTAURADAS = [
  { modulo: "ml-tokens", rotaEsperada: "ml-tokens.html" },
  { modulo: "criar-anuncios-meli", rotaEsperada: "criar-anuncios-meli.html" },
];
// Telas que a missão de recuperação deliberadamente NÃO devolve ao menu —
// nenhuma delas tem `data-module` correspondente hoje; se aparecerem aqui é
// porque viraram vf-shell.js sem essa decisão ser revisada.
const IDS_QUE_NAO_DEVEM_EXISTIR = ["dashboard", "design-templates", "clickup-executivo", "estudio-templates", "cliente-360", "cliente-360-v2"];

async function run() {
  const server = await startServer();
  const debugPort = 15200 + Math.floor(Math.random() * 800);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=/tmp/vf-shell-nav-recovery-${process.pid}`,
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

    async function goto(qs) {
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${global.__PORT__}/harness.html?${qs}` });
      await waitFor(cdp, "window.VF && window.VF.shell", "vf-shell não montou");
      await waitFor(cdp, "window.VF.context.getState() !== 'BOOT'", "contexto não saiu de BOOT");
    }

    /* ═══════════ Usuário comum, sem cliente selecionado (scope=global) ═══ */
    await goto("scope=global&module=ferramentas&role=user");

    for (const tela of TELAS_RESTAURADAS) {
      await check(`recuperação — "${tela.modulo}" existe no Shell V3 e aponta para ${tela.rotaEsperada}`, async () => {
        const href = await cdp.evaluate(
          `(function(){ var a = document.querySelector('.vf-shell__item[data-module=${JSON.stringify(tela.modulo)}]'); return a ? a.getAttribute('href') : null; })();`
        );
        assert.ok(href, `nenhum item de navegação com data-module="${tela.modulo}" — tela não foi recuperada`);
        const arquivo = href.split("?")[0];
        assert.strictEqual(arquivo, tela.rotaEsperada, `"${tela.modulo}" aponta para "${arquivo}", esperado "${tela.rotaEsperada}"`);
      });
    }

    await check("Visão continua presente e não foi substituída por nenhuma tela recuperada", async () => {
      const existe = await cdp.evaluate("Boolean(document.querySelector('.vf-shell__item[data-module=visao]'))");
      assert.ok(existe, "Visão sumiu do Shell V3");
    });

    await check("Dashboard, Estúdio de Templates e ClickUp Executivo NÃO têm entrada de menu (usuário comum)", async () => {
      for (const id of IDS_QUE_NAO_DEVEM_EXISTIR) {
        const existe = await cdp.evaluate(`Boolean(document.querySelector('.vf-shell__item[data-module=${JSON.stringify(id)}]'))`);
        assert.strictEqual(existe, false, `"${id}" apareceu no Shell V3 — não deveria, esta missão manteve essas telas fora do menu`);
      }
    });

    for (const tela of TELAS_ADMIN_RESTAURADAS) {
      await check(`admin — "${tela.modulo}" NÃO aparece para usuário comum`, async () => {
        const existe = await cdp.evaluate(`Boolean(document.querySelector('.vf-shell__item[data-module=${JSON.stringify(tela.modulo)}]'))`);
        assert.strictEqual(existe, false, `"${tela.modulo}" deveria estar escondido de um usuário não-admin`);
      });
    }

    await check("seção Administração inteira não aparece para usuário comum", async () => {
      const existe = await cdp.evaluate("Boolean(document.querySelector('.vf-shell__admin'))");
      assert.strictEqual(existe, false, "usuário comum não deveria ver a seção Administração");
    });

    /* ═══════════════════════════ Usuário admin ═══════════════════════════ */
    await goto("scope=global&module=ferramentas&role=admin");

    await check("seção Administração aparece para admin", async () => {
      const admin = await cdp.evaluate(
        "(function(){ var d = document.querySelector('.vf-shell__admin'); return d ? d.querySelector('summary').textContent : null; })()"
      );
      assert.strictEqual(admin, "Administração");
    });

    for (const tela of TELAS_ADMIN_RESTAURADAS) {
      await check(`admin — "${tela.modulo}" aparece dentro de Administração e aponta para ${tela.rotaEsperada}`, async () => {
        const href = await cdp.evaluate(
          `(function(){ var a = document.querySelector('.vf-shell__admin .vf-shell__item[data-module=${JSON.stringify(tela.modulo)}]'); return a ? a.getAttribute('href') : null; })();`
        );
        assert.ok(href, `"${tela.modulo}" não apareceu dentro de .vf-shell__admin para o admin`);
        assert.strictEqual(href.split("?")[0], tela.rotaEsperada);
      });
    }

    await check("Dashboard, Estúdio de Templates e ClickUp Executivo continuam fora do menu mesmo para admin", async () => {
      for (const id of IDS_QUE_NAO_DEVEM_EXISTIR) {
        const existe = await cdp.evaluate(`Boolean(document.querySelector('.vf-shell__item[data-module=${JSON.stringify(id)}]'))`);
        assert.strictEqual(existe, false, `"${id}" apareceu no Shell V3 para admin — não deveria`);
      }
    });

    /* ═══════ Contextualização mínima: Cliente 360 V2 e Central Full ══════ */
    await goto("scope=account&module=visao&role=user");
    await cdp.evaluate("document.getElementById('vf-cliente-trigger').click()");
    await waitFor(cdp, "document.querySelector('.vf-shell__dropdown')", "dropdown de cliente não abriu");
    await cdp.evaluate("document.querySelector('.vf-menu__item').click()");
    await waitFor(cdp, "window.VF.context.getState() === 'READY'", "contexto não chegou a READY com 1 conta ativa");

    await check("Cliente 360 usa V3; V1 e V2 ficam fora da sidebar", async () => {
      const href = await cdp.evaluate("document.querySelector('.vf-shell__item[data-module=cliente-360-v3]').getAttribute('href')");
      assert.ok(href.startsWith("cliente-360-v3.html"));
      for (const id of ["cliente-360", "cliente-360-v2"]) {
        assert.strictEqual(await cdp.evaluate(`Boolean(document.querySelector('.vf-shell__item[data-module="${id}"]'))`), false);
      }
    });

    // Central Full virou MÓDULO de conta (modelo C): lê Cliente+Operação do
    // contexto, então o link segue o contrato padrão cliente/conta.
    await check("com cliente/operação selecionados, Central Full recebe o contrato padrão ?cliente=&conta=", async () => {
      const href = await cdp.evaluate(
        "document.querySelector('.vf-shell__item[data-module=central-full]').getAttribute('href')"
      );
      assert.ok(href.startsWith("full-gestao.html"), `href inesperado para Central Full: ${href}`);
      assert.ok(/[?&]conta=42\b/.test(href), `esperado conta=42 no link de Central Full, veio: ${href}`);
    });

    await check("Cliente Operacao preserva o link no Shell", async () => {
      const hrefOperacao = await cdp.evaluate("document.querySelector('.vf-shell__item[data-module=cliente-operacao]').getAttribute('href')");
      assert.ok(hrefOperacao.startsWith("cliente-operacao.html"), `href inesperado para Cliente Operação: ${hrefOperacao}`);
    });

    console.log(`\n✓ ${checks} verificações de recuperação de navegação (fix/v3-navigation-recovery)`);
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
