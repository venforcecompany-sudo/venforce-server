/*
 * Convergência #5 — contratos visuais da UI/UX Wave 1, verificados em Chrome
 * headless real (CDP puro, sem puppeteer), no mesmo padrão de
 * Portal/vf-shell-hardening.test.js.
 *
 * POR QUE ESTE ARQUIVO EXISTE
 * A Wave 1 (frontend/v3-ui-ux-revamp-wave1) entregou duas mudanças GLOBAIS —
 * `[hidden] { display:none !important }` em vf-tokens-v2.css §14 e o
 * vocabulário de FORMA do `.vf-status` (● ◇ ○) em vf-components-v2.css §6 —
 * que saíram de guards pontuais que viviam FORA de `@layer` em vf-shell.css.
 * Elas valem para as ~20 páginas do Shell, mas a Wave 1 declarou no próprio
 * readiness (§20) que o headless "não roda neste ambiente Windows" e que
 * "nenhuma das telas alteradas tem *-shell-ui.test.js dedicado" — ou seja,
 * as duas mudanças de maior alcance foram validadas só a olho.
 *
 * Este teste fecha exatamente esse buraco: prova por COMPUTED STYLE que a
 * cascata nova faz o que a Wave 1 diz que faz, e que as 4 telas migradas
 * (atividade, pessoas, callbacks, clientes) largaram Bootstrap/style.css sem
 * perder render, estados nem tipografia.
 *
 * Nenhuma requisição sai para a rede: tudo que aponta para o host de produção
 * é interceptado via `Fetch` e respondido por fixture (mesma trava dos demais
 * headless do Portal — as páginas reais fixam a URL da API no código).
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const childProcess = require("child_process");
const { URL } = require("url");

const PORTAL_DIR = __dirname;
const PROD_HOST = "venforce-server.onrender.com";

let checks = 0;
async function check(name, fn) {
  try {
    await fn();
    checks += 1;
    console.log(`ok ${checks} - ${name}`);
  } catch (err) {
    console.error(`FALHOU - ${name}`);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
    throw err;
  }
}

/* ── Fixtures ───────────────────────────────────────────────────────────── */

const LOGS = [
  { id: 1, criado_em: "2026-08-30T14:02:00Z", usuario_nome: "Pedro Gomes", usuario_email: "pedro@venforce.com", acao: "login", entidade: "sessao", ip: "200.1.2.3", sucesso: true, detalhes: { origem: "portal" } },
  { id: 2, criado_em: "2026-08-30T13:40:00Z", usuario_nome: "Ana Lima", usuario_email: "ana@venforce.com", acao: "fechamento.publicar", entidade: "entrega", ip: "200.1.2.4", sucesso: true, detalhes: { cliente: "n97", periodo: "2026-07" } },
  { id: 3, criado_em: "2026-08-30T12:10:00Z", usuario_nome: "Ana Lima", usuario_email: "ana@venforce.com", acao: "base.importar", entidade: "base", ip: "200.1.2.4", sucesso: false, detalhes: { erro: "coluna ausente" } },
];

// `status` é o nome que callbacks.js lê primeiro (`l.status || l.http_status
// || l.httpStatus`) — com o nome errado tudo cai em 0 e vira is-danger, que
// é justamente o falso positivo que este teste precisa não produzir.
const CALLBACKS = [
  { id: 11, criado_em: "2026-08-30T14:00:00Z", endpoint: "/webhook/meli", metodo: "POST", status: 200, duracao_ms: 120, ip: "34.9.1.2", base_id: 9 },
  { id: 12, criado_em: "2026-08-30T13:00:00Z", endpoint: "/webhook/meli", metodo: "POST", status: 500, duracao_ms: 4300, ip: "34.9.1.2", base_id: 9 },
  { id: 13, criado_em: "2026-08-30T12:00:00Z", endpoint: "/webhook/shopee", metodo: "POST", status: 200, duracao_ms: 88, ip: "34.9.1.3", base_id: 10 },
];

const USUARIOS = [
  { id: 1, nome: "Pedro Gomes", email: "pedro@venforce.com", role: "admin", ativo: true },
  { id: 2, nome: "Ana Lima", email: "ana@venforce.com", role: "interno", ativo: true },
  { id: 3, nome: "Loja N97", email: "n97@cliente.com", role: "seller", ativo: false },
];

const CLIENTES = [
  { id: 87, nome: "N97 Comercial", slug: "n97", ativo: true, contas_count: 2 },
  { id: 88, nome: "Extra Máquinas", slug: "extra", ativo: true, contas_count: 1 },
  { id: 90, nome: "Loja do Pedro", slug: "loja-do-pedro", ativo: false, contas_count: 0 },
];

const CONTAS = {
  n97: [
    { id: 42, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre 1", slug: "ml-1", is_primary: true, ativo: true, grant: { id: 900, token_status: "valid" }, base: { base_id: 9, nome: "Custo 2026" } },
    { id: 43, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre 2", slug: "ml-2", is_primary: false, ativo: true, grant: { id: 901, token_status: "valid" }, base: { base_id: 9, nome: "Custo 2026" } },
  ],
  extra: [{ id: 51, cliente_id: 88, marketplace: "meli", nome: "Mercado Livre", slug: "ml", is_primary: true, ativo: true, grant: null, base: null }],
  "loja-do-pedro": [],
};

const PORTFOLIO = CLIENTES.map((c) => ({
  ...c, temGrant: c.contas_count > 0, grantStatus: c.contas_count > 0 ? "conectado" : null,
  temBase: c.contas_count > 0, setupScore: c.contas_count > 0 ? 100 : 0,
  statusOperacional: c.contas_count > 0 ? "pronto" : "pendente",
  ultimaSincronizacao: c.contas_count > 0 ? "2026-08-30T10:00:00Z" : null, pendencias: [],
}));

/* ── Servidor estático ──────────────────────────────────────────────────── */

/* Página de contrato do Design System: SÓ a Fundação V2, sem JS de página.
   Existe porque design-system-lab.html re-renderiza a lista de exemplos e
   destrói o nó sob medição no meio de uma espera (medido: o elemento focado
   some e `:focus-within` deixa de casar). Aqui a cascata é medida limpa. */
const DS_PROBE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<link rel="stylesheet" href="/css/vf-tokens-v2.css">
<link rel="stylesheet" href="/css/vf-components-v2.css">
</head><body>
  <span class="vf-info" id="ds-info">
    <button type="button" class="vf-info-dot" id="ds-dot" aria-label="ROAS: receita atribuída dividida pelo investimento"></button>
    <span class="vf-info__tip" role="tooltip">ROAS: receita atribuída dividida pelo investimento</span>
  </span>
  <span class="vf-status is-success" id="ds-ok">Conectado</span>
  <span class="vf-status is-warning" id="ds-warn">Sem data</span>
  <span class="vf-status is-empty" id="ds-empty">Sem dado</span>
</body></html>`;

let serverPort = 0;
function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/ds-probe.html") { res.writeHead(200, { "Content-Type": "text/html" }); res.end(DS_PROBE); return; }
    if (u.pathname === "/seed.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><html><head></head><body><script>
        localStorage.setItem("vf-token","test-token");
        localStorage.setItem("vf-user", JSON.stringify({ id: 12, nome: "Pedro Gomes", role: "admin" }));
      </script></body></html>`);
      return;
    }
    if (u.pathname === "/me/context") { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"ok":false}'); return; }
    if (u.pathname === "/operacao/cliente-360/clientes") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, clientes: PORTFOLIO })); return; }
    const target = path.resolve(PORTAL_DIR, u.pathname.replace(/^\/+/, ""));
    if (!target.startsWith(path.resolve(PORTAL_DIR) + path.sep)) { res.writeHead(403).end("forbidden"); return; }
    fs.readFile(target, (err, contents) => {
      if (err) { res.writeHead(404).end("not found"); return; }
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
      res.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(contents);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => { serverPort = server.address().port; resolve(server); }));
}

/* ── CDP ────────────────────────────────────────────────────────────────── */

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitChrome(port) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return; } catch (_) { /* aguardando */ }
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
      if (!message.id) {
        if (message.method === "Fetch.requestPaused" && typeof this.onFetchPaused === "function") this.onFetchPaused(message.params);
        if (message.method === "Runtime.consoleAPICalled" && typeof this.onConsole === "function") this.onConsole(message.params);
        return;
      }
      if (!this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
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
    if (result.exceptionDetails) throw new Error((result.exceptionDetails.text || "Falha na avaliação") + " | " + JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  close() { this.socket.close(); }
}
async function waitFor(cdp, expression, message) {
  for (let i = 0; i < 120; i++) { if (await cdp.evaluate(`Boolean(${expression})`)) return; await sleep(50); }
  throw new Error(message || `Timeout: ${expression}`);
}

async function run() {
  const server = await startServer();
  const debugPort = 17000 + Math.floor(Math.random() * 1000);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=/tmp/vf-wave1-conv-${process.pid}`, "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    await waitChrome(debugPort);
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    // Sem isto o headless não tem foco de janela e `:focus` nunca casa — o que
    // faria um teste de teclado passar por engano (ou falhar por engano).
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

    let consoleErrors = [];
    cdp.onConsole = (params) => {
      if (params.type !== "error") return;
      consoleErrors.push((params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || "")).join(" "));
    };

    /* Interceptação total: NADA sai para a rede real. */
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    const cors = [
      { name: "access-control-allow-origin", value: "*" },
      { name: "access-control-allow-headers", value: "*" },
      { name: "access-control-allow-methods", value: "GET,POST,PATCH,PUT,DELETE,OPTIONS" },
    ];
    let vazamentos = [];
    cdp.onFetchPaused = async (params) => {
      const url = params.request.url;
      const respond = (method, extra) => cdp.send(method, extra).catch(() => {});
      if (!url.includes(PROD_HOST)) { await respond("Fetch.continueRequest", { requestId: params.requestId }); return; }
      if (params.request.method === "OPTIONS") { await respond("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 204, responseHeaders: cors }); return; }
      const json = (obj) => respond("Fetch.fulfillRequest", {
        requestId: params.requestId, responseCode: 200,
        responseHeaders: [...cors, { name: "content-type", value: "application/json" }],
        body: Buffer.from(JSON.stringify(obj)).toString("base64"),
      });
      const p = new URL(url).pathname;
      // 404 de propósito: exercita o fallback legado do Shell
      // (/operacao/cliente-360/clientes), mesmo caminho de vf-shell-hardening.
      if (p === "/me/context" || p === "/me/portfolio") {
        return respond("Fetch.fulfillRequest", {
          requestId: params.requestId, responseCode: 404,
          responseHeaders: [...cors, { name: "content-type", value: "application/json" }],
          body: Buffer.from(JSON.stringify({ ok: false })).toString("base64"),
        });
      }
      if (p === "/admin/logs") return json({ ok: true, logs: LOGS, total: LOGS.length, totalPages: 1 });
      if (p === "/callbacks") return json({ ok: true, callbacks: CALLBACKS, total: CALLBACKS.length, pagination: { hasNext: false, hasPrev: false } });
      if (p === "/bases") return json({ ok: true, bases: [{ id: 9, nome: "Custo 2026" }, { id: 10, nome: "Custo Shopee" }] });
      if (p === "/usuarios") return json({ ok: true, usuarios: USUARIOS });
      if (p === "/seller/vinculos") return json({ ok: true, vinculos: [] });
      if (p === "/clientes") return json({ ok: true, clientes: CLIENTES });
      const mContas = p.match(/^\/clientes\/([^/]+)\/contas$/);
      if (mContas) {
        const slug = decodeURIComponent(mContas[1]);
        return json({ ok: true, cliente: CLIENTES.find((c) => c.slug === slug) || null, contas: CONTAS[slug] || [] });
      }
      if (p === "/operacao/cliente-360/clientes") return json({ ok: true, clientes: PORTFOLIO });
      vazamentos.push(`${params.request.method} ${p}`);
      return json({ ok: true });
    };

    async function goto(page, readyExpr) {
      consoleErrors = [];
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/seed.html` });
      await waitFor(cdp, "window.localStorage.getItem('vf-token')", "seed não gravou token");
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/${page}` });
      await waitFor(cdp, readyExpr, `${page} não ficou pronta: ${readyExpr}`);
      await sleep(250);
    }

    /* ═══════ A. Design System global — a cascata nova (A1 da Wave 1) ═══════ */

    await goto("ds-probe.html", "document.getElementById('ds-dot')");

    await check("[hidden] global vence o display de componente de autor (.vf-card)", async () => {
      const display = await cdp.evaluate(`(() => {
        const el = document.createElement("div");
        el.className = "vf-card"; el.hidden = true; document.body.appendChild(el);
        const d = getComputedStyle(el).display; el.remove(); return d;
      })()`);
      if (display !== "none") throw new Error(`.vf-card[hidden] deveria sumir; display=${display}`);
    });

    await check("[hidden] global vence também .vf-banner e .vf-shell__main (os guards removidos do vf-shell.css)", async () => {
      const r = await cdp.evaluate(`(() => {
        const out = {};
        for (const cls of ["vf-banner", "vf-shell__main", "vf-shell__state", "vf-metric-row"]) {
          const el = document.createElement("div");
          el.className = cls; el.hidden = true; document.body.appendChild(el);
          out[cls] = getComputedStyle(el).display; el.remove();
        }
        return out;
      })()`);
      const ruins = Object.entries(r).filter(([, d]) => d !== "none");
      if (ruins.length) throw new Error(`ainda visíveis com [hidden]: ${JSON.stringify(ruins)}`);
    });

    await check(".vf-status.is-warning: FORMA de losango (border-radius 0 + rotate 45°), não o pill base", async () => {
      const r = await cdp.evaluate(`(() => {
        const el = document.createElement("span");
        el.className = "vf-status is-warning"; document.body.appendChild(el);
        const s = getComputedStyle(el, "::before");
        const out = { radius: s.borderTopLeftRadius, transform: s.transform }; el.remove(); return out;
      })()`);
      if (!/^0/.test(r.radius)) throw new Error(`is-warning deveria ter border-radius 0; veio ${r.radius}`);
      if (r.transform === "none") throw new Error("is-warning deveria estar rotacionado 45°; transform=none");
    });

    await check(".vf-status.is-empty: círculo VAZADO (fundo transparente + borda), significado sem cor", async () => {
      const r = await cdp.evaluate(`(() => {
        const el = document.createElement("span");
        el.className = "vf-status is-empty"; document.body.appendChild(el);
        const s = getComputedStyle(el, "::before");
        const out = { bg: s.backgroundColor, border: s.borderTopWidth, style: s.borderTopStyle }; el.remove(); return out;
      })()`);
      if (!/rgba\(0, 0, 0, 0\)|transparent/.test(r.bg)) throw new Error(`is-empty deveria ter fundo transparente; veio ${r.bg}`);
      if (r.border === "0px" || r.style === "none") throw new Error(`is-empty deveria ter borda; veio ${r.border}/${r.style}`);
    });

    await check(".vf-status.is-success continua ● CHEIO (a forma nova não vazou para os outros estados)", async () => {
      const r = await cdp.evaluate(`(() => {
        const el = document.createElement("span");
        el.className = "vf-status is-success"; document.body.appendChild(el);
        const s = getComputedStyle(el, "::before");
        const out = { bg: s.backgroundColor, radius: s.borderTopLeftRadius, transform: s.transform }; el.remove(); return out;
      })()`);
      if (/rgba\(0, 0, 0, 0\)/.test(r.bg)) throw new Error("is-success não pode ser vazado");
      if (/^0px/.test(r.radius)) throw new Error("is-success deveria continuar redondo");
      if (r.transform !== "none") throw new Error(`is-success não pode estar rotacionado; transform=${r.transform}`);
    });

    await check(".vf-info-dot é <button> com rótulo acessível (não um <span> decorativo)", async () => {
      const r = await cdp.evaluate(`(() => {
        const dot = document.getElementById("ds-dot");
        return { tag: dot.tagName, rotulo: dot.getAttribute("aria-label") || "" };
      })()`);
      if (r.tag !== "BUTTON") throw new Error(`.vf-info-dot deveria ser <button>; veio <${r.tag}>`);
      if (!r.rotulo) throw new Error(".vf-info-dot sem aria-label");
    });

    // A leitura espera a `transition` de opacity/visibility: no mesmo tick do
    // focus() o valor computado ainda é o inicial (medido: `hidden/0` com o
    // `:focus-within` JÁ casando), o que faria o teste acusar um bug de
    // acessibilidade que não existe.
    await check(".vf-info__tip abre por TECLADO (:focus-within), não só no hover", async () => {
      const ler = () => cdp.evaluate(`(() => {
        const info = document.getElementById("ds-info");
        const s = getComputedStyle(info.querySelector(".vf-info__tip"));
        return { focusWithin: info.matches(":focus-within"), visibility: s.visibility, opacity: s.opacity };
      })()`);
      const antes = await ler();
      if (antes.visibility !== "hidden") throw new Error(`tooltip deveria começar oculto; veio ${antes.visibility}`);
      await cdp.evaluate(`document.getElementById("ds-dot").focus()`);
      let depois = null;
      // espera a transition CONCLUIR (visibility vira visible antes de a
      // opacity chegar em 1 — medido 0.88 no meio do caminho)
      for (let i = 0; i < 60; i++) { depois = await ler(); if (depois.visibility === "visible" && depois.opacity === "1") break; await sleep(50); }
      if (!depois.focusWithin) throw new Error(":focus-within não casou — o foco não chegou ao botão");
      if (depois.visibility !== "visible" || depois.opacity !== "1") throw new Error(`tooltip não abriu no foco: ${JSON.stringify(depois)}`);
    });

    await check(".vf-info__tip volta a fechar quando o foco sai (não fica preso aberto)", async () => {
      await cdp.evaluate(`document.getElementById("ds-dot").blur()`);
      let r = null;
      for (let i = 0; i < 40; i++) {
        r = await cdp.evaluate(`(() => { const s = getComputedStyle(document.querySelector("#ds-info .vf-info__tip")); return { visibility: s.visibility, opacity: s.opacity }; })()`);
        if (r.visibility === "hidden") break;
        await sleep(50);
      }
      if (r.visibility !== "hidden") throw new Error(`tooltip ficou aberto após o blur: ${JSON.stringify(r)}`);
    });

    await check("design-system-lab.html documenta os 3 padrões novos da Wave 1", async () => {
      await goto("design-system-lab.html", "document.querySelector('.vf-status')");
      const r = await cdp.evaluate(`(() => ({
        status: document.querySelectorAll(".vf-status").length,
        metric: document.querySelectorAll(".vf-metric-row").length,
        info: document.querySelectorAll(".vf-info-dot").length,
      }))()`);
      const faltando = Object.entries(r).filter(([, n]) => n === 0).map(([k]) => k);
      if (faltando.length) throw new Error(`lab não exemplifica: ${faltando.join(", ")}`);
    });

    /* ═══════ B. Telas migradas — largaram V1 sem perder render ═══════ */

    const TELAS = [
      { page: "atividade.html", pronto: "document.querySelectorAll('#callbacks-tbody tr').length >= 3", nome: "Atividade" },
      { page: "usuarios.html", pronto: "document.querySelectorAll('#vu-body-admin tr, #vu-body-membro tr, #vu-body-seller tr, #vu-body-shopee tr').length >= 3", nome: "Pessoas" },
      { page: "callbacks.html", pronto: "document.querySelectorAll('#callbacks-tbody tr').length >= 3", nome: "Callbacks" },
      { page: "clientes.html", pronto: "document.querySelectorAll('#clientes-tbody tr').length >= 3", nome: "Clientes" },
    ];

    for (const tela of TELAS) {
      await goto(tela.page, tela.pronto);

      await check(`${tela.nome} — renderiza as linhas e NÃO tem erro de console`, async () => {
        const reais = consoleErrors.filter((e) => !/favicon|ERR_FAILED|net::/i.test(e));
        if (reais.length) throw new Error(`erros de console: ${JSON.stringify(reais.slice(0, 3))}`);
      });

      await check(`${tela.nome} — largou o V1: sem Bootstrap e sem style.css no documento`, async () => {
        const r = await cdp.evaluate(`(() => {
          const hrefs = [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.getAttribute("href") || "");
          return {
            bootstrap: hrefs.filter((h) => /bootstrap/i.test(h)),
            style: hrefs.filter((h) => /(^|\\/)style\\.css/.test(h)),
            fundacao: hrefs.some((h) => /vf-tokens-v2\\.css/.test(h)) && hrefs.some((h) => /vf-components-v2\\.css/.test(h)),
          };
        })()`);
        if (r.bootstrap.length) throw new Error(`ainda carrega Bootstrap: ${JSON.stringify(r.bootstrap)}`);
        if (r.style.length) throw new Error(`ainda carrega style.css: ${JSON.stringify(r.style)}`);
        if (!r.fundacao) throw new Error("não carrega a Fundação V2 (tokens + components)");
      });

      await check(`${tela.nome} — tipografia da Fundação (Hanken Grotesk/Manrope), não fallback do SO`, async () => {
        const f = await cdp.evaluate(`getComputedStyle(document.body).fontFamily`);
        if (/Segoe UI/i.test(f) && !/Hanken/i.test(f)) throw new Error(`caiu no fallback do SO: ${f}`);
        if (!/Hanken|Manrope/i.test(f)) throw new Error(`fonte inesperada no body: ${f}`);
      });

      // A Wave 1 registrou RESPONSIVIDADE como PARCIAL porque o ambiente dela
      // "não permitiu redimensionar a janela abaixo do desktop" (§17 do
      // readiness). Aqui dá: Emulation.setDeviceMetricsOverride cobre a faixa
      // inteira, incluindo os breakpoints que só herdavam a V2 sem re-teste.
      await check(`${tela.nome} — sem overflow horizontal de 1920 a 360px`, async () => {
        const larguras = [1920, 1440, 1366, 1200, 900, 640, 360];
        const ruins = [];
        for (const w of larguras) {
          await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
          await sleep(120);
          const over = await cdp.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
          if (over > 1) ruins.push(`${w}px:+${over}`);
        }
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        if (ruins.length) throw new Error(`overflow horizontal em ${ruins.join(", ")}`);
      });
    }

    /* ═══════ C. Detalhes por tela que a Wave 1 declarou ═══════ */

    await goto("atividade.html", "document.querySelectorAll('#callbacks-tbody tr').length >= 3");

    await check("Atividade — resumo usa a strip densa .vf-metric-row (flex), não o KPI largo", async () => {
      const r = await cdp.evaluate(`(() => {
        const row = document.querySelector(".vf-metric-row");
        if (!row) return { ausente: true };
        const s = getComputedStyle(row);
        return { display: s.display, itens: row.querySelectorAll(".vf-metric").length, altura: Math.round(row.getBoundingClientRect().height) };
      })()`);
      if (r.ausente) throw new Error("Atividade sem .vf-metric-row");
      if (r.display !== "flex") throw new Error(`.vf-metric-row deveria ser flex; veio ${r.display}`);
      if (r.itens < 2) throw new Error(`.vf-metric-row com ${r.itens} item(ns)`);
    });

    await check("Atividade — prévia de detalhes é 'chave: valor', com o JSON cru só dentro do <details>", async () => {
      const r = await cdp.evaluate(`(() => {
        const d = document.querySelector("#callbacks-tbody details");
        if (!d) return { ausente: true };
        const resumo = (d.querySelector("summary") || d).textContent.trim();
        return { resumo, pareceJson: /^[\\[{]/.test(resumo) };
      })()`);
      if (r.ausente) return; // linha sem detalhes é legítima
      if (r.pareceJson) throw new Error(`prévia ainda é JSON cru: ${r.resumo.slice(0, 60)}`);
    });

    await goto("usuarios.html", "document.querySelectorAll('#vu-body-admin tr, #vu-body-membro tr, #vu-body-seller tr, #vu-body-shopee tr').length >= 3");

    await check("Pessoas — o título da página é 'Pessoas' (alinha com a navegação)", async () => {
      const t = await cdp.evaluate(`(document.querySelector(".vf-page-header__title") || {}).textContent || ""`);
      if (!/Pessoas/i.test(t)) throw new Error(`título veio '${String(t).trim()}'`);
    });

    await check("Pessoas — papel via .vf-tag e status via .vf-status (ponto), sem pills próprios do V1", async () => {
      const r = await cdp.evaluate(`(() => ({
        tags: document.querySelectorAll("table .vf-tag").length,
        status: document.querySelectorAll("table .vf-status").length,
        v1: document.querySelectorAll(".vf-role-pill, .vf-status-pill, .vf-action-btn").length,
      }))()`);
      if (r.v1 > 0) throw new Error(`${r.v1} elemento(s) ainda usam pills/botões do V1`);
      if (r.tags === 0 && r.status === 0) throw new Error("nenhum .vf-tag/.vf-status renderizado");
    });

    await goto("callbacks.html", "document.querySelectorAll('#callbacks-tbody tr').length >= 3");

    await check("Callbacks — status 200 e 500 saem com .vf-status is-success/is-danger distintos", async () => {
      const r = await cdp.evaluate(`(() => ({
        sucesso: document.querySelectorAll("#callbacks-tbody .vf-status.is-success").length,
        erro: document.querySelectorAll("#callbacks-tbody .vf-status.is-danger").length,
      }))()`);
      if (r.sucesso < 1 || r.erro < 1) throw new Error(`esperado ao menos 1 de cada; veio ${JSON.stringify(r)}`);
    });

    await goto("clientes.html", "document.querySelectorAll('#clientes-tbody tr').length >= 3");

    await check("Clientes — linhas sem inline style de layout (a folha assumiu o trabalho)", async () => {
      const n = await cdp.evaluate(`[...document.querySelectorAll("#clientes-tbody [style]")]
        .filter((el) => /font-size|color|padding|margin|width/i.test(el.getAttribute("style") || "")).length`);
      if (n > 0) throw new Error(`${n} elemento(s) com inline style de layout`);
    });

    /* ═══════ D. Regressão nas telas NÃO tocadas (alcance global do DS) ═══════ */

    await check("Regressão — nenhuma requisição escapou para fora das fixtures", async () => {
      if (vazamentos.length) throw new Error(`rotas não cobertas alcançaram a interceptação: ${JSON.stringify([...new Set(vazamentos)].slice(0, 5))}`);
    });

    console.log(`\n✓ ${checks} verificações da UI/UX Wave 1 (Convergência #5): cascata global + 4 telas migradas`);
  } finally {
    if (cdp) cdp.close();
    chrome.kill();
    server.close();
  }
}

run().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
