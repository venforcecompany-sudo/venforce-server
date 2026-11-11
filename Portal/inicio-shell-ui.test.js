/*
 * Smoke test de interface em Chrome headless para o Início (visao.html) —
 * cópia da tela de Início do Lucratto 360 que substituiu a Visão, sobre o
 * Shell V3. Fixtures reais para o Shell (GET /me/context,
 * /operacao/cliente-360/clientes, /clientes/:slug/contas) e um payload com o
 * shape real de GET /operacao/inicio/:cliente (server/services/inicioService.js).
 */
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { URL } = require("url");

const PORTAL_DIR = __dirname;
const PROD_HOST = "venforce-server.onrender.com";
const SHOTS_DIR = process.env.VF_SHOTS_DIR || path.join(os.tmpdir(), "vf-inicio-shots");

const N97 = { id: 87, nome: "N97 Comercial", slug: "n97", ativo: true, temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100, statusOperacional: "pronto", ultimaSincronizacao: null, pendencias: [] };
const PORTFOLIO = { ok: true, clientes: [N97] };
const N97_CONTAS = [
  { id: 42, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre 1", ativo: true, grant: { token_status: "valid" }, base: { base_id: 9 } },
];

const env = (dados) => ({ disponivel: true, escopoConta: true, motivo: null, dados });
const indisponivel = (motivo) => ({ disponivel: false, escopoConta: true, motivo });

function serie30() {
  const out = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(Date.UTC(2026, 9, 13 + i)).toISOString().slice(0, 10);
    const fat = i % 7 === 3 ? 0 : 900 + ((i * 377) % 1400);
    out.push({ dia: d, vendas: fat ? 6 + (i % 5) : 0, faturamento: fat, lucro: fat ? Math.round(fat * (i % 9 === 4 ? -0.05 : 0.18)) : 0 });
  }
  return out;
}

// Shape real de inicioService.obterInicio (conferido numa conta de produção).
function payloadFeliz() {
  return {
    ok: true,
    contexto: { clienteId: 87, clienteSlug: "n97", clienteNome: "N97 Comercial", clienteContaId: 42, contaNome: "Mercado Livre 1", marketplace: "meli" },
    periodo: { id: "30d", rotulo: "30 dias", hoje: "2026-11-11", de: "2026-10-13", ate: "2026-11-11", anterior: { de: "2026-09-13", ate: "2026-10-12" } },
    metasMercadoLider: [
      { nivel: "silver", rotulo: "MercadoLíder", vendas: 230, faturamento: 37000 },
      { nivel: "gold", rotulo: "MercadoLíder Gold", vendas: 575, faturamento: 118400 },
      { nivel: "platinum", rotulo: "MercadoLíder Platinum", vendas: 1725, faturamento: 296000 },
    ],
    limitesMercadoLider: { reclamacoesPct: 0.5, cancelamentosPct: 0.5, atrasosPct: 6, mesesDeConta: 4 },
    vendas: env({
      sincronizado: true,
      atualizadoEm: "2026-11-11T12:00:00Z",
      totais: { faturamento: 41288.5, vendas: 318, unidades: 344, canceladas: 4, vendasCalculadas: 290, incompletas: 28, faturamentoCalculado: 38000, lucro: 6622.3, margemPct: 17.43, ticket: 129.84, semCusto: 28, confiancaFechamento: "parcial" },
      anterior: { faturamento: 36120, vendas: 290, unidades: 301, canceladas: 3, vendasCalculadas: 270, incompletas: 20, faturamentoCalculado: 34000, lucro: 6400, margemPct: 18.82, ticket: 124.55, semCusto: 20, periodo: { de: "2026-09-13", ate: "2026-10-12" } },
      serie: serie30(),
      lucraram: [
        { mlb: "MLB3001", titulo: "Kit 3 potes herméticos de vidro 1L", unidades: 48, faturamento: 4790, vendasCalculadas: 46, lucro: 1180.4, margemPct: 24.6 },
        { mlb: "MLB3002", titulo: "Garrafa térmica inox 1,2L", unidades: 31, faturamento: 3410, vendasCalculadas: 31, lucro: 702.1, margemPct: 20.6 },
      ],
      perdem: [{ mlb: "MLB3009", titulo: "Escorredor de louça dobrável", unidades: 12, faturamento: 588, vendasCalculadas: 12, lucro: -64.2, margemPct: -10.9 }],
      lider: { de: "2026-08-01", ate: "2026-11-11", vendas: 1120, faturamento: 142300 },
    }),
    catalogo: env({ porStatus: { saudavel: 212, margem_baixa: 41, prejuizo: 9, dado_suspeito: 3, nao_validado: 22, conciliando: 0 }, total: 287, margemAlvoPct: 15, piorMargemPct: -18.2, cobertura: { itensAnalisados: 287, totalItensMl: 287, parcial: false } }),
    reputacao: env({
      nivel: "5_green", mercadoLider: "gold", periodoDias: 60, vendasPeriodo: 702,
      reclamacoes: { taxaPct: 0.28, quantidade: 2 }, cancelamentos: { taxaPct: 0.14, quantidade: 1 }, atrasos: { taxaPct: 2.1, quantidade: 15 },
      contaDesde: "2021-03-02T10:00:00Z", lidaEm: "2026-11-11T15:02:00Z",
    }),
    ads: env({ codigo: "OK", investimentoAds: 4520.1, gmvAds: 31200.5, acos: 14.5, roas: 6.9, avisos: [] }),
    configuracao: {
      disponivel: true, escopoConta: false, motivo: null,
      dados: {
        setup: { score: 80, temBase: true, temGrant: true, temDiagnostico: true, temFechamentoMes: false, temAds: true, temFreteHistorico: false },
        sync: { status: "sincronizado", precisaSincronizar: false, ultimaSincronizacao: "2026-11-11T10:00:00Z", motivo: null },
      },
    },
  };
}

function payloadShopee() {
  const p = payloadFeliz();
  p.contexto.marketplace = "shopee";
  p.catalogo = indisponivel("A saúde do catálogo está disponível só para operações Mercado Livre.");
  p.reputacao = indisponivel("A reputação está disponível só para operações Mercado Livre.");
  p.ads = indisponivel("Ads está disponível só para operações Mercado Livre.");
  return p;
}

function payloadSemLucro() {
  const p = payloadFeliz();
  Object.assign(p.vendas.dados.totais, { vendasCalculadas: 0, lucro: null, margemPct: null, faturamentoCalculado: 0 });
  p.vendas.dados.anterior = null;
  p.ads.dados.acos = null;
  return p;
}

/* C1 — o Shell V3 pede GET /me/context antes de qualquer coisa (a carteira
   autoritativa por Squad, server/services/meService.js). Este backend falso
   passa a respondê-lo derivando do MESMO fixture de carteira já usado aqui:
   sem isto o harness simularia um servidor sem /me, que não é o servidor
   real que a página vai encontrar. */
function meContextDe(portfolio) {
  const clientes = (portfolio.clientes || []).map((c) => ({
    id: c.id, slug: c.slug, nome: c.nome, squadId: null, responsavelDireto: false, contasAtivas: null,
  }));
  return {
    ok: true,
    user: { id: 12, nome: "Pedro Gomes", email: null, role: "user" },
    squads: [], squadPrincipalId: null,
    clientes,
    portfolio: { totalClientes: clientes.length },
    permissoes: { podeAdministrar: false },
  };
}

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

let inicioPayload = payloadFeliz();
const pedidosInicio = [];

function wireFetchInterception(cdp) {
  const consoleErrors = [];
  const respond = async (m, p) => {
    try { await cdp.send(m, p); } catch (err) { if (!/Invalid InterceptionId/.test(err.message || "")) throw err; }
  };
  cdp.onEvent = async (method, params) => {
    if (method === "Runtime.consoleAPICalled" && params.type === "error") {
      consoleErrors.push((params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || "")).join(" "));
    }
    if (method !== "Fetch.requestPaused") return;
    const req = params.request;
    const url = req.url;
    if (!url.includes(PROD_HOST)) { await respond("Fetch.continueRequest", { requestId: params.requestId }); return; }
    const cors = [
      { name: "access-control-allow-origin", value: "*" },
      { name: "access-control-allow-headers", value: "authorization,content-type" },
      { name: "access-control-allow-methods", value: "GET,POST,OPTIONS" },
    ];
    if (req.method === "OPTIONS") { await respond("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 204, responseHeaders: cors }); return; }
    const json = (obj) => respond("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 200, responseHeaders: [...cors, { name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(obj)).toString("base64") });

    if (url.includes("/me/context")) { await json(meContextDe(PORTFOLIO)); return; }
    if (url.includes("/operacao/cliente-360/clientes")) { await json(PORTFOLIO); return; }
    const contasMatch = url.match(/\/clientes\/([^/?]+)\/contas/);
    if (contasMatch) { await json({ ok: true, cliente: { id: 87, nome: "N97 Comercial", slug: "n97", ativo: true }, contas: N97_CONTAS }); return; }
    if (url.includes("/operacao/inicio/")) { pedidosInicio.push(url); await json(inicioPayload); return; }

    await respond("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionRefused" });
  };
  return consoleErrors;
}

async function run() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const server = await startServer();
  const serverPort = server.address().port;
  const debugPort = 26000 + Math.floor(Math.random() * 1000);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--window-size=1440,1600",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(os.tmpdir(), `vf-inicio-shell-ui-${process.pid}`)}`, "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    await waitChrome(debugPort);
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1600, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    const consoleErrors = wireFetchInterception(cdp);

    async function seedAndGoto(qs) {
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/visao.html` });
      await sleep(60);
      await cdp.evaluate(`
        localStorage.setItem("vf-token", "ui-test-token");
        localStorage.setItem("vf-user", JSON.stringify({ id: 12, nome: "Pedro Gomes", role: "admin" }));
        sessionStorage.clear();
      `);
      consoleErrors.length = 0;
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/visao.html${qs ? "?" + qs : ""}` });
      await waitFor(cdp, "window.VF && window.VF.context", "vf-context não montou");
    }

    const TITULOS = ["Precisa de atenção", "Saúde da conta", "Saúde do catálogo", "MercadoLíder", "Faturamento e lucro por dia", "Os que mais lucraram", "Os que mais perdem dinheiro", "Ads", "Configuração da operação"];
    const titulosNaTela = "Array.prototype.map.call(document.querySelectorAll('#root h2'), function(h){ return h.childNodes[0] ? h.childNodes[0].textContent.trim() : ''; })";
    async function prontoComBlocos() {
      await waitFor(cdp, "window.VF.context.getState() === 'READY'", "contexto não chegou a READY");
      await waitFor(cdp, "document.querySelector('.vf-inicio-cartoes')", "o Início não renderizou");
      await sleep(250);
    }
    async function print(nome) {
      const arquivo = path.join(SHOTS_DIR, nome);
      const png = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      fs.writeFileSync(arquivo, Buffer.from(png.data, "base64"));
      console.log(`   screenshot: ${arquivo}`);
    }
    const sobraHorizontal = "document.documentElement.scrollWidth - document.documentElement.clientWidth";

    // ═══ 1. Caminho feliz ═══
    inicioPayload = payloadFeliz();
    await seedAndGoto("cliente=n97&conta=42");
    await prontoComBlocos();

    await check("Início — item da sidebar se chama Início", async () => {
      const label = await cdp.evaluate("(document.querySelector('.vf-shell__item[data-module=visao]') || {}).textContent || ''");
      assert.ok(label.includes("Início"), `item da sidebar: ${label}`);
    });

    await check("Início — pede GET /operacao/inicio com cliente, conta e o período padrão", async () => {
      const u = new URL(pedidosInicio[pedidosInicio.length - 1]);
      assert.ok(u.pathname.endsWith("/operacao/inicio/n97"), u.pathname);
      assert.strictEqual(u.searchParams.get("conta"), "42");
      assert.strictEqual(u.searchParams.get("periodo"), "30d");
    });

    await check("Início — todos os blocos do Lucratto + Ads e Configuração aparecem", async () => {
      const titulos = await cdp.evaluate(titulosNaTela);
      for (const t of TITULOS) assert.ok(titulos.includes(t), `bloco "${t}" ausente: ${JSON.stringify(titulos)}`);
    });

    await check("Início — números formatados, nenhum 'undefined' ou 'NaN'", async () => {
      const texto = await cdp.evaluate("document.body.innerText");
      assert.ok(!/undefined|NaN/.test(texto), `texto suspeito: ${texto.slice(0, 400)}`);
      assert.ok(texto.includes("R$ 41.288,50"), `faturamento não encontrado: ${texto.slice(0, 600)}`);
      assert.ok(texto.includes("R$ 6.622,30"), "lucro não encontrado");
    });

    await check("Início — gráfico desenha barras e a linha do lucro", async () => {
      const barras = await cdp.evaluate("document.querySelectorAll('.vf-inicio-grafico__barra').length");
      const linha = await cdp.evaluate("Boolean(document.querySelector('.vf-inicio-grafico__linha'))");
      assert.ok(barras >= 20 && linha, `barras=${barras} linha=${linha}`);
    });

    await check("Início — nada estoura a largura da página", async () => {
      const sobra = await cdp.evaluate(sobraHorizontal);
      assert.ok(sobra <= 1, `rolagem horizontal de ${sobra}px`);
    });
    await print("inicio-feliz-1440.png");

    // ═══ 2. Troca de período pelos atalhos ═══
    await check("Início — atalho '7 dias' pede o período novo e grava na URL", async () => {
      const antes = pedidosInicio.length;
      await cdp.evaluate("Array.prototype.find.call(document.querySelectorAll('.vf-inicio-atalho'), function(b){ return b.textContent.trim() === '7 dias'; }).click()");
      for (let i = 0; i < 60 && pedidosInicio.length === antes; i++) await sleep(50);
      assert.ok(pedidosInicio.length > antes, "nenhum pedido novo depois do clique");
      assert.strictEqual(new URL(pedidosInicio[pedidosInicio.length - 1]).searchParams.get("periodo"), "7d");
      const busca = await cdp.evaluate("window.location.search");
      assert.ok(busca.includes("periodo=7d"), busca);
    });

    // ═══ 3. Celular ═══
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1600, deviceScaleFactor: 1, mobile: true });
    await sleep(400);
    await check("Início — no celular nada estoura a largura", async () => {
      const sobra = await cdp.evaluate(sobraHorizontal);
      assert.ok(sobra <= 1, `rolagem horizontal de ${sobra}px no celular`);
    });
    await print("inicio-celular-390.png");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1600, deviceScaleFactor: 1, mobile: false });

    // ═══ 4. Conta Shopee: blocos só-ML mostram o motivo ═══
    inicioPayload = payloadShopee();
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/visao.html?cliente=n97&conta=42&_r=2` });
    await waitFor(cdp, "window.VF && window.VF.context && window.VF.context.getState() === 'READY'", "reload não voltou a READY");
    await prontoComBlocos();
    await check("Início — conta Shopee: catálogo, reputação e Ads mostram o motivo, o resto continua", async () => {
      const texto = await cdp.evaluate("document.body.innerText");
      assert.ok(texto.includes("A reputação está disponível só para operações Mercado Livre."), "motivo da reputação ausente");
      assert.ok(texto.includes("Ads está disponível só para operações Mercado Livre."), "motivo do Ads ausente");
      assert.ok(texto.includes("R$ 41.288,50"), "vendas deveriam continuar");
    });

    // ═══ 5. Sem lucro calculado: ausência nunca vira zero ═══
    inicioPayload = payloadSemLucro();
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/visao.html?cliente=n97&conta=42&_r=3` });
    await waitFor(cdp, "window.VF && window.VF.context && window.VF.context.getState() === 'READY'", "reload não voltou a READY");
    await prontoComBlocos();
    await check("Início — lucro e margem ausentes mostram '—', nunca R$ 0,00 / 0,0%", async () => {
      const cartoes = await cdp.evaluate("document.querySelector('.vf-inicio-cartoes').innerText");
      assert.ok(!cartoes.includes("R$ 0,00") && !cartoes.includes("0,0%"), cartoes);
      assert.ok(cartoes.includes("nenhuma venda com todos os dados"), cartoes);
    });

    await check("sem erros de console em nenhum cenário", async () => {
      const relevantes = consoleErrors.filter((m) => !/favicon/i.test(m));
      assert.strictEqual(relevantes.length, 0, `erros de console: ${JSON.stringify(relevantes)}`);
    });

    console.log(`\n✓ ${checks} verificações do Início`);
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
