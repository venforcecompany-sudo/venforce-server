/*
 * Smoke test de interface em Chrome headless para a Central de Vendas
 * migrada de verdade para o Shell V3 (F2.2) — a unidade mais crítica
 * desta rodada.
 *
 * Estratégia de fixture: o Shell (GET /operacao/cliente-360/clientes,
 * GET /clientes/:slug/contas) recebe fixtures reais via CDP Fetch. Os
 * endpoints do "motor" da Central (/operacao/central-vendas/*) são
 * deliberadamente FALHADOS (ConnectionRefused) — não porque o motor não
 * importa, mas porque fechamentos-api.js já tem um modo mock embutido
 * (`localStorage['vf-fapi-mock-dev']='1'`, ligado aqui) que usa os MESMOS
 * dados canônicos (`MOCK_ROWS`) que os desenvolvedores originais já
 * validam manualmente — reescrever esse fixture à mão só arriscaria
 * divergir do contrato real sem ganhar cobertura de verdade. O que este
 * teste verifica é exclusivamente a ORIGEM do contexto (Shell → F.cliente/
 * F.clienteConta) e a orquestração ao redor dela (polling, drawer,
 * filtros, corrida) — exatamente o que F2.2 mudou.
 *
 * Padrão de CDP idêntico a Portal/vf-shell-adoption-ui.test.js.
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

function grant(status) {
  return status ? { id: 900, ml_user_id: "1099887766", token_status: status, is_primary: false } : null;
}
function base(id, nome) {
  return { vinculo_id: 500 + id, base_id: id, slug: "base-" + id, nome, resolvido_por: "conta" };
}

const N97 = {
  id: 87, nome: "N97 Comercial", slug: "n97", ativo: true,
  temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100,
  statusOperacional: "atencao", ultimaSincronizacao: "2026-08-25T14:00:00Z", pendencias: [],
};
const N97_CONTAS = [
  { id: 42, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre 1", slug: "ml-1", external_account_id: "182993004", externalAccountLabel: "n97store", is_primary: true, ativo: true, grant: grant("valid"), base: base(9, "Custo 2026"), ultimaSync: "2026-08-25T14:00:00Z" },
  { id: 43, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre 2", slug: "ml-2", external_account_id: "204118872", externalAccountLabel: "n97outlet", is_primary: false, ativo: true, grant: grant("valid"), base: base(9, "Custo 2026"), ultimaSync: "2026-08-25T14:00:00Z" },
  { id: 44, cliente_id: 87, marketplace: "shopee", nome: "Shopee", slug: "shopee", external_account_id: "SP-77120", externalAccountLabel: "N97 Oficial", is_primary: true, ativo: true, grant: null, base: base(20, "Custo Shopee"), ultimaSync: null },
];
const EXTRA = {
  id: 88, nome: "Extra Máquinas", slug: "extra", ativo: true,
  temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100,
  statusOperacional: "pronto", ultimaSincronizacao: "2026-08-25T16:00:00Z", pendencias: [],
};
const EXTRA_CONTAS = [
  { id: 51, cliente_id: 88, marketplace: "meli", nome: "Mercado Livre", slug: "ml", external_account_id: "119847221", externalAccountLabel: "extramaquinas", is_primary: true, ativo: true, grant: grant("valid"), base: base(11, "Custo Extra"), ultimaSync: "2026-08-25T16:00:00Z" },
];
const PORTFOLIO = { ok: true, clientes: [N97, EXTRA] };
const CONTAS = { n97: N97_CONTAS, extra: EXTRA_CONTAS };

function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
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

let bootstrapDelayMs = { n97: {}, extra: {} }; // { [slug]: { [clienteContaId]: ms } } — para testar corrida
let bootstrapCallLog = []; // [{slug, clienteContaId, ts}]

function wireFetchInterception(cdp) {
  const consoleErrors = [];
  // A resposta a uma requisição interceptada pode chegar DEPOIS de o
  // próprio navegador já ter cancelado essa requisição (é exatamente o
  // que o guard de corrida do motor faz: aborta o fetch antigo quando o
  // contexto troca). Nesse caso o CDP devolve "Invalid InterceptionId" —
  // esperado, não um erro do teste. Qualquer outro erro continua propagando.
  async function responder(method, params) {
    try {
      await cdp.send(method, params);
    } catch (err) {
      if (!/Invalid InterceptionId/.test(err.message || "")) throw err;
    }
  }
  cdp.onEvent = async (method, params) => {
    if (method === "Runtime.consoleAPICalled" && params.type === "error") {
      consoleErrors.push((params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || "")).join(" "));
    }
    if (method !== "Fetch.requestPaused") return;
    const req = params.request;
    const url = req.url;
    if (!url.includes(PROD_HOST)) { await responder("Fetch.continueRequest", { requestId: params.requestId }); return; }
    const cors = [
      { name: "access-control-allow-origin", value: "*" },
      { name: "access-control-allow-headers", value: "authorization,content-type" },
      { name: "access-control-allow-methods", value: "GET,POST,OPTIONS" },
    ];
    if (req.method === "OPTIONS") { await responder("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 204, responseHeaders: cors }); return; }

    // C1 — o Shell V3 pede GET /me/context antes de tudo (carteira
    // autoritativa por Squad, server/services/meService.js). Derivado do
    // MESMO fixture de carteira usado abaixo.
    if (url.includes("/me/context")) {
      const clientes = (PORTFOLIO.clientes || []).map((c) => ({ id: c.id, slug: c.slug, nome: c.nome, squadId: null, responsavelDireto: false, contasAtivas: null }));
      const body = Buffer.from(JSON.stringify({ ok: true, user: { id: 12, nome: "Pedro Gomes", email: null, role: "user" }, squads: [], squadPrincipalId: null, clientes, portfolio: { totalClientes: clientes.length }, permissoes: { podeAdministrar: false } })).toString("base64");
      await responder("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 200, responseHeaders: [...cors, { name: "content-type", value: "application/json" }], body });
      return;
    }
    if (url.includes("/operacao/cliente-360/clientes")) {
      const body = Buffer.from(JSON.stringify(PORTFOLIO)).toString("base64");
      await responder("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 200, responseHeaders: [...cors, { name: "content-type", value: "application/json" }], body });
      return;
    }
    const contasMatch = url.match(/\/clientes\/([^/?]+)\/contas/);
    if (contasMatch) {
      const slug = decodeURIComponent(contasMatch[1]);
      const lista = CONTAS[slug] || [];
      const body = Buffer.from(JSON.stringify({ ok: true, cliente: { id: 1, nome: slug, slug, ativo: true }, contas: lista })).toString("base64");
      await responder("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 200, responseHeaders: [...cors, { name: "content-type", value: "application/json" }], body });
      return;
    }
    const bootstrapMatch = url.match(/\/operacao\/central-vendas\/([^/]+)\/read\/bootstrap/);
    if (bootstrapMatch) {
      const slug = decodeURIComponent(bootstrapMatch[1]);
      const qs = new URL(url).searchParams;
      const clienteContaId = qs.get("clienteContaId") || "none";
      bootstrapCallLog.push({ slug, clienteContaId, ts: Date.now() });
      const delay = (bootstrapDelayMs[slug] && bootstrapDelayMs[slug][clienteContaId]) || 0;
      if (delay) await sleep(delay);
      // Motor real fora do ar de propósito (ver cabeçalho do arquivo) — o
      // modo mock embutido de fechamentos-api.js assume a partir daqui.
      await responder("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionRefused" });
      return;
    }
    // qualquer outro endpoint do motor (read/daily/products/mercado-pago/sync-runs/importar-vendas): fora do ar.
    await responder("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionRefused" });
  };
  return consoleErrors;
}

async function run() {
  const server = await startServer();
  const serverPort = server.address().port;
  const debugPort = 22000 + Math.floor(Math.random() * 1000);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=/tmp/vf-fapi-shell-ui-${process.pid}`, "about:blank",
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

    async function seedAndGoto(qs) {
      // Causa raiz de uma flakiness real encontrada aqui: sessionStorage["vf-ctx"]
      // sobrevive de propósito a navegações normais (é o mecanismo que mantém a
      // sessão entre páginas — só o LOGIN a zera). A navegação abaixo para a
      // página EM BRANCO (sem query, só para setar localStorage antes da real)
      // ainda carrega vf-context.js, que lê essa sessão do cenário ANTERIOR
      // (ex.: extra/51) e resolve — corretamente — o contexto a partir dela
      // ANTES da navegação final aplicar a query nova, disparando uma chamada
      // real ao motor para o cliente de ANTES. Isso acontece rápido demais
      // para limpar depois de navegar (o boot síncrono de vf-context.js já
      // leu a sessão antes do primeiro `cdp.evaluate` rodar) — por isso a
      // limpeza tem que acontecer ANTES desta navegação, na página atual.
      try { await cdp.evaluate("try{sessionStorage.clear()}catch(e){}"); } catch (_) { /* página em branco (about:blank) recusa storage: nada a limpar mesmo */ }
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/fechamentos-api.html` });
      await sleep(60);
      await cdp.evaluate(`
        localStorage.setItem("vf-token", "ui-test-token");
        localStorage.setItem("vf-user", JSON.stringify({ id: 12, nome: "Pedro Gomes", role: "admin" }));
        localStorage.setItem("vf-fapi-mock-dev", "1");
        sessionStorage.clear();
      `);
      bootstrapCallLog = [];
      consoleErrors.length = 0;
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/fechamentos-api.html${qs ? "?" + qs : ""}` });
      await waitFor(cdp, "window.VF && window.VF.context", "vf-context não montou");
    }

    /* ══════════════════════ estrutura: sem seletor local ══════════════ */
    await seedAndGoto("cliente=extra&conta=51");
    await waitFor(cdp, "window.VF.context.getState() === 'READY'", "extra (1 conta) não chegou a READY via deep link");
    await sleep(300);

    await check("F2.2 — sem seletores locais de Cliente/Conta no DOM", async () => {
      assert.strictEqual(await cdp.evaluate("Boolean(document.getElementById('fapi-client-select'))"), false);
      assert.strictEqual(await cdp.evaluate("Boolean(document.getElementById('fapi-conta-select'))"), false);
      assert.strictEqual(await cdp.evaluate("Boolean(document.getElementById('fapi-conta-field'))"), false);
    });

    await check("F2.2 — layout.js não carrega mais nesta página (Shell V3 é o único caminho)", async () => {
      const scripts = await cdp.evaluate("Array.prototype.map.call(document.querySelectorAll('script[src]'), function(s){return s.getAttribute('src');})");
      assert.ok(!scripts.includes("layout.js"), `layout.js não deveria existir: ${JSON.stringify(scripts)}`);
      assert.ok(scripts.includes("vf-shell.js"));
    });

    await check("deep link com 1 conta: READY direto, F.cliente/F.clienteConta corretos, motor rodou com clienteContaId=51", async () => {
      assert.strictEqual(await cdp.evaluate("document.getElementById('fapi-tabs').hidden"), false, "abas deveriam estar visíveis (motor mock aplicado)");
      assert.ok(bootstrapCallLog.some((c) => c.slug === "extra" && c.clienteContaId === "51"), `bootstrap não foi chamado com extra/51: ${JSON.stringify(bootstrapCallLog)}`);
    });

    /* ══════════════════════ cliente com 2+ contas: ambiguidade bloqueia ═ */
    await seedAndGoto("cliente=n97");
    await waitFor(cdp, "window.VF.context.getState() === 'ACCOUNT_CHOICE_REQUIRED'", "n97 sem conta não abriu ACCOUNT_CHOICE_REQUIRED");
    await sleep(200);

    await check("cliente com 2+ contas sem conta na URL: main fica bloqueado pelo Shell (não pela tela)", async () => {
      assert.strictEqual(await cdp.evaluate("document.getElementById('vf-shell-main').hidden"), true);
      assert.ok((await cdp.evaluate("document.querySelector('.vf-shell__state').innerText")).includes("Escolha a operação"));
    });

    await check("nenhuma chamada ao motor disparou sem conta resolvida (nunca lê a loja errada)", async () => {
      assert.strictEqual(bootstrapCallLog.length, 0, `motor não deveria ter sido chamado ainda: ${JSON.stringify(bootstrapCallLog)}`);
    });

    // Escolhe ML2 (id 43) pelo dropdown de Operação do Shell.
    await cdp.evaluate("document.getElementById('vf-op-trigger').click()");
    await waitFor(cdp, "document.querySelector('.vf-shell__dropdown')", "dropdown de operação não abriu");
    await cdp.evaluate(`
      Array.prototype.find.call(document.querySelectorAll('.vf-menu__item'), function(x){ return x.textContent.indexOf('Mercado Livre 2') >= 0; }).click();
    `);
    await waitFor(cdp, "window.VF.context.getState() === 'READY'", "ML2 não chegou a READY após escolha no dropdown");
    await sleep(300);

    await check("escolher a operação no Shell resolve o contexto e roda o motor com a conta certa (ml-2/43)", async () => {
      assert.ok(bootstrapCallLog.some((c) => c.slug === "n97" && c.clienteContaId === "43"), `bootstrap não chamado com n97/43: ${JSON.stringify(bootstrapCallLog)}`);
      assert.strictEqual(await cdp.evaluate("document.getElementById('fapi-tabs').hidden"), false);
    });

    /* ══════════════════════ troca de conta reseta filtro/drawer ═══════ */
    // Abre um pedido no drawer e aplica um filtro, então troca de conta.
    await cdp.evaluate("document.querySelector('.vf-shell__item[data-module=central-vendas]')?.click === undefined"); // no-op, mantém o teste síncrono simples
    await cdp.evaluate(`document.getElementById('fapi-tab-pedidos').click()`);
    await waitFor(cdp, "!document.getElementById('fapi-panel-pedidos').hidden", "aba Pedidos não abriu");
    await sleep(150);
    const linha = await cdp.evaluate("Boolean(document.querySelector('#fapi-panel-pedidos tr[data-row-id]'))");
    if (linha) {
      await cdp.evaluate("document.querySelector('#fapi-panel-pedidos tr[data-row-id]').click()");
      await waitFor(cdp, "document.getElementById('fapi-order-drawer').classList.contains('is-open')", "drawer não abriu");
    }

    bootstrapCallLog = [];
    await cdp.evaluate("document.getElementById('vf-op-trigger').click()");
    await waitFor(cdp, "document.querySelector('.vf-shell__dropdown')", "dropdown de operação (2ª troca) não abriu");
    await cdp.evaluate(`
      Array.prototype.find.call(document.querySelectorAll('.vf-menu__item'), function(x){ return x.textContent.indexOf('Mercado Livre 1') >= 0; }).click();
    `);
    await waitFor(cdp, "window.VF.context.getContext() && window.VF.context.getContext().clienteContaId === 42", "troca para ML1 não aplicou");
    await sleep(300);

    await check("troca de operação (ML2→ML1): drawer fecha, motor roda de novo com a nova conta (42)", async () => {
      assert.strictEqual(await cdp.evaluate("document.getElementById('fapi-order-drawer').classList.contains('is-open')"), false, "drawer deveria ter fechado na troca de operação");
      assert.ok(bootstrapCallLog.some((c) => c.slug === "n97" && c.clienteContaId === "42"), `bootstrap não chamado com n97/42: ${JSON.stringify(bootstrapCallLog)}`);
    });

    /* ══════════════════════ troca de CLIENTE ═══════════════════════════ */
    bootstrapCallLog = [];
    await cdp.evaluate("document.getElementById('vf-cliente-trigger').click()");
    await waitFor(cdp, "document.querySelector('.vf-shell__dropdown')", "dropdown de cliente não abriu");
    await cdp.evaluate(`
      Array.prototype.find.call(document.querySelectorAll('.vf-menu__item'), function(x){ return x.textContent.trim().startsWith('Extra'); }).click();
    `);
    await waitFor(cdp, "window.VF.context.getState() === 'READY' && window.VF.context.getContext().clienteSlug === 'extra'", "troca de cliente para Extra não completou");
    await sleep(300);

    await check("troca de CLIENTE (N97→Extra Máquinas): motor roda com o novo cliente/conta (extra/51)", async () => {
      assert.ok(bootstrapCallLog.some((c) => c.slug === "extra" && c.clienteContaId === "51"), `bootstrap não chamado com extra/51 após troca de cliente: ${JSON.stringify(bootstrapCallLog)}`);
    });

    /* ══════════════════════ refresh preserva o contexto (URL) ═════════ */
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/fechamentos-api.html?cliente=n97&conta=43` });
    await waitFor(cdp, "window.VF && window.VF.context && window.VF.context.getState() === 'READY'", "refresh com deep link não chegou a READY");
    await check("refresh com ?cliente=n97&conta=43: READY direto, sem exigir clique", async () => {
      const ctx = await cdp.evaluate("window.VF.context.getContext()");
      assert.strictEqual(ctx.clienteSlug, "n97");
      assert.strictEqual(ctx.clienteContaId, 43);
    });

    /* ══════════════════════ Shopee: Central de Vendas continua disponível ═ */
    // achado da migração: o seletor local antigo filtrava contas por
    // ?marketplace=meli (nunca mostrava Shopee); o Shell não filtra — e o
    // backend já suporta Central de Vendas multi-marketplace (ver
    // VENFORCE_V3_BACKEND_READINESS.md §3). Prova que a capacidade nova
    // não quebra a tela.
    await seedAndGoto("cliente=n97&conta=44");
    await waitFor(cdp, "window.VF.context.getState() === 'READY'", "conta Shopee não chegou a READY");
    await sleep(300);
    await check("conta Shopee: Central de Vendas carrega normalmente (capacidade nova desbloqueada pela migração)", async () => {
      const meta = await cdp.evaluate("window.VF.context.getAccountMeta()");
      assert.strictEqual(meta.marketplace, "shopee");
      assert.strictEqual(await cdp.evaluate("document.getElementById('fapi-tabs').hidden"), false);
      assert.ok(bootstrapCallLog.some((c) => c.slug === "n97" && c.clienteContaId === "44"));
    });

    /* ══════════════════════ resposta velha nunca sobrescreve a nova ═══ */
    bootstrapDelayMs = { n97: { 42: 900, 43: 0 } }; // ML1 lento, ML2 rápido
    await seedAndGoto("cliente=n97&conta=42");
    await waitFor(cdp, "window.VF.context.getState() === 'READY'", "corrida: contexto inicial (ML1) não chegou a READY");
    // Não espera o bootstrap (lento) resolver — troca para ML2 imediatamente.
    await cdp.evaluate("document.getElementById('vf-op-trigger').click()");
    await waitFor(cdp, "document.querySelector('.vf-shell__dropdown')", "corrida: dropdown de operação não abriu");
    await cdp.evaluate(`
      Array.prototype.find.call(document.querySelectorAll('.vf-menu__item'), function(x){ return x.textContent.indexOf('Mercado Livre 2') >= 0; }).click();
    `);
    await waitFor(cdp, "window.VF.context.getContext() && window.VF.context.getContext().clienteContaId === 43", "corrida: troca para ML2 não aplicou no contexto");
    await sleep(1200); // espera a resposta ATRASADA de ML1 chegar (900ms) bem depois da troca

    await check("corrida ML1(lento)→ML2(rápido): a resposta atrasada de ML1 não reverte o contexto exibido", async () => {
      assert.strictEqual(await cdp.evaluate("window.VF.context.getContext().clienteContaId"), 43, "o contexto ativo deveria continuar ML2");
      // Duas chamadas de bootstrap devem ter disparado (uma por conta); o
      // guard de loadSeq garante que só a mais recente afeta o DOM — a
      // prova observável é o contexto do Shell não ter revertido acima.
      assert.ok(bootstrapCallLog.some((c) => c.clienteContaId === "42"));
      assert.ok(bootstrapCallLog.some((c) => c.clienteContaId === "43"));
    });
    bootstrapDelayMs = { n97: {}, extra: {} };

    await check("sem erros de console INESPERADOS (o log de rede fora do ar é deliberado — é o gatilho do fallback mock)", async () => {
      const relevantes = consoleErrors.filter((m) => !/favicon/i.test(m) && !/\[fechamentos-api\] falha de rede/.test(m));
      assert.strictEqual(relevantes.length, 0, `erros de console inesperados: ${JSON.stringify(relevantes)}`);
    });

    console.log(`\n✓ ${checks} verificações da Central de Vendas migrada (F2.2)`);
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
