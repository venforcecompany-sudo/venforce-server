/*
 * Teste VISUAL da Central de Margem (layout da Fase 3) com dados FAKE da
 * "Red Fish": 8 anúncios (2 em prejuízo, 2 abaixo da meta, 4 saudáveis), as
 * promoções do Promo Snapshot e a Bancada do drawer (Atual × Cenário).
 *
 * Não toca a rede real: o Chrome headless carrega Portal/ de um servidor
 * estático local e a rede de produção é interceptada via CDP. O client da
 * Central é o mock de central-margem-pricing-ui.test.js (extraído do próprio
 * arquivo e ajustado abaixo — se aquele mock mudar e algum ajuste não casar, o
 * teste falha dizendo qual).
 *
 * Gera PNGs em CM_SHOT_DIR (padrão: <tmp>/central-margem-visual) e imprime os
 * caminhos. Além das capturas confere o essencial do layout (4 KPIs, aviso
 * único do realizado, ordem da worklist, cascata da Bancada, sem rolagem
 * horizontal).
 */
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const PORTAL_DIR = __dirname;
const SHOT_DIR = process.env.CM_SHOT_DIR || path.join(os.tmpdir(), "central-margem-visual");
// 1440×900 por padrão; CM_W/CM_H para capturar em outra largura (ex.: 1920×1080).
const VIEW_W = Number(process.env.CM_W) || 1440;
const VIEW_H = Number(process.env.CM_H) || 900;

function startStaticServer() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relative = pathname === "/" ? "central-margem.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(PORTAL_DIR, relative);
    if (!target.startsWith(path.resolve(PORTAL_DIR) + path.sep)) { response.writeHead(403).end("forbidden"); return; }
    fs.readFile(target, (error, contents) => {
      if (error) { response.writeHead(404).end("not found"); return; }
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
      response.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
      response.end(contents);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitChrome(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return; } catch (_) { /* aguardando */ }
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
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
        return;
      }
      if (message.method && this.onEvent) this.onEvent(message.method, message.params);
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception && result.exceptionDetails.exception.description) || result.exceptionDetails.text || "Falha na avaliação do navegador");
    return result.result.value;
  }
  close() { this.socket.close(); }
}

async function waitFor(cdp, expression, message) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (await cdp.evaluate(`Boolean(${expression})`)) return;
    await sleep(50);
  }
  throw new Error(message || `Timeout: ${expression}`);
}

let checks = 0;
async function check(name, fn) { await fn(); checks += 1; console.log(`ok ${checks} - ${name}`); }

// ── Dados fake da Red Fish ─────────────────────────────────────────────────
// Margem = (0,78·P − 65)/P: é a conta do mock da Bancada (imposto 10%, comissão
// 12%, frete R$ 15, custo R$ 50), então a tabela e a Bancada contam a mesma história.
const REDFISH_ITENS = `[
      { id: "MLB1003", titulo: "Carretilha Marine Sports Sparta 7000", preco: 59.9, status: "LOSS", alvo: 95.6 },
      { id: "MLB1004", titulo: "Vara Telescópica Pro 3,60m Carbono", preco: 71.9, status: "LOSS", alvo: 95.6 },
      { id: "MLB1005", titulo: "Linha Multifilamento 0,30mm 300m", preco: 87, status: "LOW_MARGIN", alvo: 95.6 },
      { id: "MLB1006", titulo: "Anzol Circle 4/0 Caixa c/ 50", preco: 91, status: "LOW_MARGIN", alvo: 95.6 },
      { id: "MLB1001", titulo: "Isca Artificial Camarão Neon 9cm", preco: 110.48, status: "HEALTHY" },
      { id: "MLB1002", titulo: "Molinete Atlantic Pro 3000 5 Rolamentos", preco: 149.9, status: "HEALTHY" },
      { id: "MLB1007", titulo: "Bolsa Térmica de Pesca 25L", preco: 189.9, status: "HEALTHY" },
      { id: "MLB1008", titulo: "Caixa Organizadora 3 Gavetas", preco: 229.9, status: "HEALTHY" },
    ].map(function (i) { i.margem = Math.round(((0.78 * i.preco - 65) / i.preco) * 10000) / 10000; return i; })`;

function mockDaRedFish() {
  const origem = fs.readFileSync(path.join(PORTAL_DIR, "central-margem-pricing-ui.test.js"), "utf8");
  const achado = origem.match(/const MOCK_CLIENT = `([\s\S]*?)\n`;/);
  assert.ok(achado, "mock de central-margem-pricing-ui.test.js não encontrado");
  let mock = achado[1];
  const trocar = (de, para, rotulo) => {
    const antes = mock;
    mock = typeof de === "string" ? mock.split(de).join(para) : mock.replace(de, para);
    assert.notStrictEqual(mock, antes, `ajuste do mock não casou: ${rotulo}`);
  };
  trocar(/var ITENS = \[[\s\S]*?\n    \];/, `var ITENS = ${REDFISH_ITENS};`, "ITENS");
  trocar('margin: it.id === "MLB1003" ? { target: { marginTarget: 0.1, price: 79.9, computable: true } } : undefined,', "margin: it.alvo ? { target: { marginTarget: 0.1, price: it.alvo, computable: true } } : undefined,", "preço-alvo estimado");
  trocar(/var PRECO_TABELA = \{[^}]*\};/, "var PRECO_TABELA = { MLB9999: 99.9 }; ITENS.forEach(function (i) { PRECO_TABELA[i.id] = i.preco; });", "PRECO_TABELA");
  trocar("totalItens: 3", "totalItens: 8", "totalItens");
  trocar("kpis: { total: 3, porStatus: { HEALTHY: 2, LOW_MARGIN: 0, LOSS: 1,", "kpis: { lcPrejuizo: -27.2, total: 8, porStatus: { HEALTHY: 4, LOW_MARGIN: 2, LOSS: 2,", "KPIs do resumo");
  trocar("anuncios: { total: 3, ativos: 3, pausados: 0 }, comMargem: 3", "anuncios: { total: 8, ativos: 8, pausados: 0 }, comMargem: 8", "anúncios");
  trocar("paginacao: { page: 1, limit: 50, total: 3, totalPaginas: 1 }", "paginacao: { page: 1, limit: 50, total: 8, totalPaginas: 1 }", "paginação");
  trocar("preco: 81.5,", "preco: 95.59,", "preço-alvo cotado");
  trocar("Loja piloto", "Red Fish · ML Principal", "nome da conta");
  trocar("Produto X", "Isca Artificial Camarão Neon 9cm", "título MLB1001");
  trocar("Produto Y", "Molinete Atlantic Pro 3000 5 Rolamentos", "título MLB1002");
  trocar("Produto fora da página", "Chumbada Oliva 40g (fora da página)", "título MLB9999");
  trocar("Sem histórico", "Rede de Arremesso 2,5m (sem histórico)", "título MLB7777");
  return mock;
}

// ── Caso real: MLB5537622816 (Red Fish), o alvo do mockup da Bancada ─────────
// Os números da Bancada NÃO são fixture escrita à mão: saem do núcleo de verdade
// (core.calcularCenario) com os insumos do caso — preço 55,19, imposto 11%,
// comissão 6,35, frete 8,15, custo 22,42, retorno ML 2,24 (LC 14,44 · 26,16%) e
// as cotações nos preços dos cenários. A tela só os exibe.
const core = require(path.join(PORTAL_DIR, "..", "server", "services", "motorMargem", "core"));
const CASO_REAL = {
  mlb: "MLB5537622816",
  titulo: "Camisa Camiseta Blusa Pesca Proteção Solar Uv50 Aparecida",
  atual: { preco: 55.19, custo: 22.42, aliquota: 0.11, taxa_fixa: 0, comissao: 6.35, frete: 8.15, rebate: 2.24 },
  meta: { margem_alvo: 0.1, margem_minima: 0 },
  lidoEm: "2026-10-16T17:12:00Z",
  // id · nome · tipo · grupo do servidor · status exibido · período · preço sugerido · retorno ML · cotação em P'
  promos: [
    { id: "P-IMPULSIONE", nome: "Impulsione suas vendas", tipo: "SMART", grupo: "ativa", status: "ATIVA", inicio: "2026-08-23T12:00:00Z", fim: "2027-02-19T12:00:00Z", preco: 55.19, rebate: 2.24, cotacao: {} },
    { id: "P-1111", nome: "11.11 da Black", tipo: "DEAL", grupo: "pode", status: "ELEGÍVEL", inicio: "2026-10-19T12:00:00Z", fim: "2026-11-12T12:00:00Z", preco: 47.67, rebate: 0, cotacao: { comissao: 5.48, frete: 6.85 }, escrita: { suportada: true, acao: "PARTICIPAR", motivo: null } },
    { id: "P-VENDEX", nome: "Vendex – Outubro", tipo: "SELLER_CAMPAIGN", grupo: "participa", status: "NÃO APLICADA", inicio: "2026-09-30T12:00:00Z", fim: "2026-10-31T12:00:00Z", preco: 56.9, rebate: 0, cotacao: { comissao: 6.54, frete: 8.15 } },
    { id: "P-PESCAOFF", nome: "PESCAOFF", tipo: "MARKETPLACE_CAMPAIGN", grupo: "ml", status: "ELEGÍVEL", inicio: "2026-10-01T12:00:00Z", fim: "2026-10-31T12:00:00Z", preco: null, rebate: 0, cotacao: {} },
    { id: "P-CUPOM", nome: "Cupom para carrinho", tipo: "SELLER_COUPON_CAMPAIGN", grupo: "ml", status: "ELEGÍVEL", inicio: "2026-10-05T12:00:00Z", fim: "2026-10-31T12:00:00Z", preco: null, rebate: 0, cotacao: {} },
    { id: "P-RELAMPAGO", nome: "Oferta relâmpago", tipo: "LIGHTNING", grupo: "ml", status: "ELEGÍVEL", inicio: null, fim: null, preco: 67.92, rebate: 0, cotacao: { comissao: 7.81, frete: 8.15 } },
  ],
  // Preço digitado: a cotação real em 59,90 (mesma faixa de frete).
  manual: { 59.9: { comissao: 6.89, frete: 8.15 } },
};

function evidenciaCasoReal(promo) {
  const e = { comissao: { fonte: "ml_listing_prices", consultado_em: CASO_REAL.lidoEm }, frete: { fonte: "ml_shipping_options_free", consultado_em: CASO_REAL.lidoEm, aplicavel: true } };
  e.preco = promo ? { fonte: "promo_snapshot", observado_em: CASO_REAL.lidoEm } : { fonte: "informado", consultado_em: null };
  return e;
}

/** Respostas do /simular do caso real, calculadas pelo núcleo (o mesmo do servidor). */
function fixtureCasoReal() {
  const { atual, meta } = CASO_REAL;
  const cenarios = CASO_REAL.promos.map((pr) => ({
    tipo: "promo",
    entrada: { tipo: "promo", promotion_id: pr.id },
    promocao: {
      id: pr.id, chave: pr.id + "::" + pr.tipo, nome: pr.nome, tipo: pr.tipo, status_exibicao: pr.status, grupo: pr.grupo, inicio: pr.inicio, fim: pr.fim, preco_final: pr.preco,
      escrita: pr.escrita || { suportada: false, acao: null, motivo: "A inscrição desta promoção é feita no painel do Mercado Livre." },
    },
    ...core.calcularCenario({ atual, cenario: { tipo: "promo", preco: pr.preco, rebate: pr.rebate, status_exibicao: pr.status }, cotacao: pr.cotacao, meta }),
    evidencia: evidenciaCasoReal(true),
  }));
  const manual = {};
  for (const [preco, cotacao] of Object.entries(CASO_REAL.manual)) {
    manual[Number(preco).toFixed(2)] = {
      tipo: "preco", entrada: { tipo: "preco", preco: Number(preco) },
      ...core.calcularCenario({ atual, cenario: { tipo: "preco", preco: Number(preco) }, cotacao, meta }),
      evidencia: evidenciaCasoReal(false),
    };
  }
  const boot = {
    ok: true, mlb: CASO_REAL.mlb,
    item: { mlb: CASO_REAL.mlb, ml_promos_url: "https://www.mercadolivre.com.br/anuncios/lista/promos?page=1&search=5537622816" },
    // Topo da Bancada: alíquota, preço cheio do item e a Base vêm prontos do /simular.
    atual: { ...core.calcularAtual({ atual }).atual, aliquota: atual.aliquota, preco_cheio: 79.9, preco_cheio_fonte: "margin_snapshot", base: { id: 7, nome: "Red Fish" }, bloqueios: [], rebate_motivo: null },
    meta,
    promocoes: { disponivel: true, motivo: null, snapshot_em: CASO_REAL.lidoEm, parcial: false },
    fontePromocoes: { estado: "ok", ultimoBom: { geradoEm: CASO_REAL.lidoEm, parcial: false, itensHerdados: 0 }, legado: null, rotulo: null, progresso: null },
    cotacoes: { consultas: 4, precos_distintos: 4, limite_excedido: 0, maximo_por_requisicao: 40 },
    cenarios,
  };
  const bloqueado = { tipo: "preco", ...core.resultadoBloqueado("comissao_indisponivel", { meta }), evidencia: null };
  return `window.__casoReal = (function () {
    var BOOT = ${JSON.stringify(boot)};
    var MANUAL = ${JSON.stringify(manual)};
    var BLOQUEADO = ${JSON.stringify(bloqueado)};
    return function (params) {
      var c0 = (params.cenarios || [])[0] || {};
      var base = JSON.parse(JSON.stringify(BOOT));
      if (c0.tipo === "todas_promos") return base;
      if (c0.tipo === "preco") { base.cenarios = [MANUAL[Number(c0.preco).toFixed(2)] || Object.assign({}, BLOQUEADO, { entrada: c0 })]; return base; }
      base.cenarios = BOOT.cenarios.filter(function (c) { return c0.tipo === "promo" && c.promocao.id === c0.promotion_id; });
      return base;
    };
  })();`;
}

/** O mock da Red Fish com UM anúncio: o do caso real (preço, custos, vendas e retorno do header). */
function mockCasoReal(mockRedFish) {
  let mock = mockRedFish;
  const trocar = (de, para, rotulo) => {
    const antes = mock;
    mock = mock.split(de).join(para);
    assert.notStrictEqual(mock, antes, `ajuste do mock do caso real não casou: ${rotulo}`);
  };
  trocar(`var ITENS = ${REDFISH_ITENS};`, `var ITENS = [{ id: "${CASO_REAL.mlb}", titulo: "${CASO_REAL.titulo}", preco: 55.19, margem: 0.2616, status: "HEALTHY" }];`, "ITENS");
  trocar('cost: field(ev("VENFORCE_BASE", 50, "DECLARED")), taxRate: field(ev("VENFORCE_BASE", 0.1, "DECLARED"))', 'cost: field(ev("VENFORCE_BASE", 22.42, "DECLARED")), taxRate: field(ev("VENFORCE_BASE", 0.11, "DECLARED"))', "custo/imposto");
  trocar('commission: field(ev("MELI_API", 13.26)), commissionRate: field(ev("MELI_API", 0.12)), freight: field(ev("MELI_API", 20))', 'commission: field(ev("MELI_API", 6.35)), commissionRate: field(ev("MELI_API", 0.115)), freight: field(ev("MELI_API", 8.15))', "comissão/frete");
  trocar("projected: { margin: it.margem, profit: Math.round(it.margem * it.preco * 100) / 100, estimated: false }", "projected: { margin: it.margem, profit: 14.44, estimated: false, rebate: 2.24 }", "projetado + retorno ML");
  trocar("realized: { margin: 0.2083, profit: 23, pending: false }", "realized: { margin: 0.2073, profit: 11.44, pending: false }", "realizado");
  trocar("sales: { hasOrders: true, unidades: 21, pedidos: 20, receita: 2333, precoMedio: 111.1 }", "sales: { hasOrders: true, unidades: 46, pedidos: 44, receita: 2540.45, precoMedio: 55.23 }", "vendas 30d");
  trocar("      simular: function (params, signal) {\n",
    "      simular: function (params, signal) {\n        if (window.__casoReal && params.mlb === \"" + CASO_REAL.mlb + "\") { window.__pc.calls.simular.push(JSON.parse(JSON.stringify(params))); return Promise.resolve(window.__casoReal(params)); }\n",
    "simular do caso real");
  return mock;
}

async function run() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const mock = mockDaRedFish();
  const server = await startStaticServer();
  const serverPort = server.address().port;
  const debugPort = 16000 + Math.floor(Math.random() * 1000);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=/tmp/vf-central-margem-visual-${process.pid}`, "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    await waitChrome(debugPort);
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    const PROD_HOST = "venforce-server.onrender.com";
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    cdp.onEvent = async (method, params) => {
      if (method !== "Fetch.requestPaused") return;
      const url = params.request.url;
      const respond = async (m, p) => { try { await cdp.send(m, p); } catch (err) { if (!/Invalid InterceptionId/.test(err.message || "")) throw err; } };
      if (!url.includes(PROD_HOST)) { await respond("Fetch.continueRequest", { requestId: params.requestId }); return; }
      const cors = [
        { name: "access-control-allow-origin", value: "*" },
        { name: "access-control-allow-headers", value: "authorization,content-type" },
        { name: "access-control-allow-methods", value: "GET,POST,OPTIONS" },
      ];
      const json = (obj) => respond("Fetch.fulfillRequest", {
        requestId: params.requestId, responseCode: 200,
        responseHeaders: [...cors, { name: "content-type", value: "application/json" }],
        body: Buffer.from(JSON.stringify(obj)).toString("base64"),
      });
      if (params.request.method === "OPTIONS") { await respond("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 204, responseHeaders: cors }); return; }
      if (url.includes("/me/context")) {
        await json({ ok: true, user: { id: 12, nome: "Pedro Gomes", email: null, role: "user" }, squads: [], squadPrincipalId: null,
          clientes: [{ id: 90, slug: "red_fish", nome: "Red Fish", squadId: null, responsavelDireto: false, contasAtivas: null }], portfolio: { totalClientes: 1 }, permissoes: { podeAdministrar: false } });
        return;
      }
      if (url.includes("/operacao/cliente-360/clientes")) {
        await json({ ok: true, clientes: [{ id: 90, nome: "Red Fish", slug: "red_fish", ativo: true, temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100, statusOperacional: "pronto", ultimaSincronizacao: null, pendencias: [] }] });
        return;
      }
      if (/\/clientes\/[^/?]+\/contas/.test(url)) {
        await json({ ok: true, cliente: { id: 90, nome: "Red Fish", slug: "red_fish", ativo: true }, contas: [
          { id: 10, cliente_id: 90, marketplace: "meli", nome: "Red Fish · ML Principal", slug: "ml-10", external_account_id: "10000", externalAccountLabel: "Red Fish · ML Principal", is_primary: true, ativo: true, grant: { id: 10, token_status: "valid" }, base: null },
        ] });
        return;
      }
      await respond("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionRefused" });
    };

    const roteiroRedFish = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      localStorage.setItem("vf-token", "ui-test-token");
      localStorage.setItem("vf-user", JSON.stringify({ nome: "Teste UI", role: "admin" }));
      ${mock}
    ` });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/central-margem.html?cliente=red_fish` });

    const arquivos = [];
    const shot = async (name) => {
      await sleep(300);
      const r = await cdp.send("Page.captureScreenshot", { format: "png" });
      const arquivo = path.join(SHOT_DIR, name + ".png");
      fs.writeFileSync(arquivo, Buffer.from(r.data, "base64"));
      arquivos.push(arquivo);
    };
    const texto = async (seletor) => (await cdp.evaluate(`document.querySelector(${JSON.stringify(seletor)}).innerText`)).replace(/ /g, " ");
    const semRolagemHorizontal = () => cdp.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1");

    // Com uma Conta única, o Shell pode concluir a resolução antes deste poll.
    // Aceitar esse estado estável evita depender da duração do estado transitório;
    // as asserções seguintes continuam exigindo Conta #10 e os oito anúncios.
    await waitFor(cdp, "window.VFCentralMargemUi && window.VF && window.VF.context && (window.VFCentralMargemUi.getState().awaitingAccount || (window.VF.context.getState() === 'READY' && window.VFCentralMargemUi.getState().contaId === 10))", "Shell não resolveu a conta nem pediu seleção");
    for (let i = 0; i < 60; i += 1) {
      await cdp.evaluate("window.VF.context.setConta(10)");
      if (await cdp.evaluate("window.VFCentralMargemUi.getState().contaId === 10")) break;
      await sleep(100);
    }
    await waitFor(cdp, "window.VFCentralMargemUi.getState().mode === 'snapshot' && window.VFCentralMargemUi.getState().data && !window.VFCentralMargemUi.getState().loading && document.querySelectorAll('#cm-table-host tbody tr[data-item-id]').length === 8", "a worklist da Red Fish não carregou");
    await waitFor(cdp, "window.VFCentralMargemUi.getState().realizado && window.VFCentralMargemUi.getState().promoSummary && window.VFCentralMargemUi.getState().promoSummary.status === 'ok'", "realizado/resumo de promoções não carregaram");

    await check("Precificar: 4 KPIs de decisão, realizado numa linha só e worklist ordenada (prejuízo → abaixo da meta → saudáveis)", async () => {
      assert.ok((await cdp.evaluate("document.body.innerText")).includes("Red Fish"), "o cliente da tela é a Red Fish");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#cm-kpis-top .cm-topk').length"), 4);
      const kpis = (await texto("#cm-kpis-top")).replace(/\n/g, " ");
      assert.ok(/EM PREJUÍZO\s*2/i.test(kpis), kpis);
      assert.ok(/PROMOS COM \+LC\s*2/i.test(kpis), kpis);
      assert.strictEqual(await cdp.evaluate("document.getElementById('cm-top-realized').hasAttribute('data-cm-realized-unavailable')"), false);
      const ordem = await cdp.evaluate("Array.prototype.map.call(document.querySelectorAll('#cm-table-host tbody tr[data-item-id]'), function (tr) { return tr.getAttribute('data-item-id'); }).join(',')");
      assert.strictEqual(ordem, "MLB1003,MLB1004,MLB1005,MLB1006,MLB1001,MLB1002,MLB1007,MLB1008");
      const cabecalho = (await texto("#cm-table-host thead")).replace(/\s+/g, " ").toLowerCase();
      for (const coluna of ["produto", "preço", "lc/un", "margem", "próxima ação"]) assert.ok(cabecalho.includes(coluna), `coluna ${coluna}: ${cabecalho}`);
      assert.ok(await semRolagemHorizontal(), "sem rolagem horizontal");
      await shot("01-precificar");
    });

    await check("Promoções: uma linha por anúncio com a melhor promoção, veredito e flags", async () => {
      await cdp.evaluate("document.querySelector('[data-view=promotions]').click()");
      await waitFor(cdp, "document.querySelector('#cm-opps-host tr[data-opp]') && document.getElementById('cm-promos-live').getAttribute('data-cm-live') === 'ok'", "promoções não apareceram");
      assert.ok(await semRolagemHorizontal(), "sem rolagem horizontal");
      const badge = (await texto("#cm-opps-meta")) + " | " + (await texto("#cm-promos-live"));
      assert.ok(/^Lista: Promo Snapshot · /.test(badge) && /Números: cotação ao vivo/.test(badge), badge);
      await shot("02-promocoes");
    });

    await check("Promoções: linha expandida mostra a cascata Hoje × Promo, quem banca e a origem dos números", async () => {
      await cdp.evaluate("document.querySelector('tr.cm-promo-row .cm-c-produto').click()");
      await waitFor(cdp, "document.querySelector('tr.cm-promo-detail:not([hidden]) [data-cm-bancada-cascata]')", "o detalhe da linha não abriu");
      const detalhe = (await texto("tr.cm-promo-detail:not([hidden])")).replace(/\s+/g, " ");
      for (const t of ["Desconto total", "ML banca", "Você banca", "Lista: Promo Snapshot", "Números: cotação ao vivo"]) assert.ok(detalhe.includes(t), `falta ${t}: ${detalhe}`);
      assert.ok(await semRolagemHorizontal(), "sem rolagem horizontal");
      await shot("03-promocoes-expandida");
      await cdp.evaluate("document.querySelector('tr.cm-promo-row .cm-c-produto').click()");
    });

    await check("Diagnóstico: divergências e a tabela Composição atual", async () => {
      await cdp.evaluate("document.querySelector('[data-view=composition]').click()");
      await waitFor(cdp, "document.getElementById('cm-divergences').hidden === false", "o Diagnóstico não abriu");
      await shot("07-diagnostico");
      await cdp.evaluate("document.querySelector('[data-view=operational]').click()");
    });

    await check("Bancada (promoção): resposta + frase do backend, Hoje × Cenário, efeitos e botão primário no rodapé fixo", async () => {
      await cdp.evaluate("document.querySelector('tr[data-item-id=\"MLB1001\"]').click()");
      await waitFor(cdp, "document.querySelector('[data-cm-cenarios]')", "a Bancada não carregou");
      await cdp.evaluate("document.querySelector('[data-cenario=\"P-DEAL\"]').click()");
      await waitFor(cdp, "document.querySelector('[data-cm-promo-info=\"P-DEAL\"]') && document.getElementById('cm-bancada-review')", "a promoção não foi selecionada");
      const resultado = await texto("#cm-banc-resultado");
      for (const t of ["Só se vender mais", "Perde R$ 3,05 por unidade", "Hoje", "Cenário", "Diferença", "LC por unidade", "De onde sai a diferença no lucro", "Total no LC por unidade"]) assert.ok(resultado.includes(t), `falta ${t}: ${resultado}`);
      // Retorno ML e quem banca ficam dentro de "Ver conta completa" (fechado por padrão) — abre e confere.
      await cdp.evaluate("document.querySelector('[data-cm-conta-completa]').setAttribute('open', '')");
      const comContaAberta = await texto("#cm-banc-resultado");
      for (const t of ["Retorno ML", "Desconto total", "Precisa vender"]) assert.ok(comContaAberta.includes(t), `falta ${t}: ${comContaAberta}`);
      await cdp.evaluate("document.querySelector('[data-cm-conta-completa]').removeAttribute('open')");
      assert.strictEqual(await cdp.evaluate("document.getElementById('cm-bancada-review').textContent"), "Participar desta promoção");
      assert.strictEqual(await cdp.evaluate("Boolean(document.getElementById('cm-bancada-review').closest('.vf-drawer__footer'))"), true, "botão no rodapé fixo do drawer");
      assert.ok(await semRolagemHorizontal(), "sem rolagem horizontal");
      await shot("04-bancada-promocao");
    });

    await check("Bancada (preço manual): o cenário digitado é cotado pelo backend e a linha 'Seu preço' fica selecionada", async () => {
      await cdp.evaluate("(function(){var i=document.getElementById('cm-new-price');i.value='114,90';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
      await waitFor(cdp, "document.getElementById('cm-banc-resultado').textContent.indexOf('114,90') !== -1 && document.getElementById('cm-bancada-review') && document.getElementById('cm-bancada-review').disabled === false", "o cenário de preço não apareceu");
      assert.strictEqual(await cdp.evaluate("document.querySelector('[data-cenario=\"preco\"]').getAttribute('aria-checked')"), "true", "digitar seleciona 'Seu preço'");
      assert.strictEqual(await cdp.evaluate("document.getElementById('cm-bancada-review').textContent"), "Revisar novo preço");
      await shot("05-bancada-preco-manual");
      await cdp.evaluate("window.VFCentralMargemUi.closeDrawer()");
    });

    await check("Bancada (ativa agora): promoção que já forma o preço de hoje — 'Em vigor', Δ 0 e botão 'Já em vigor' desabilitado", async () => {
      await cdp.evaluate("document.querySelector('tr[data-item-id=\"MLB1001\"]').click()");
      await waitFor(cdp, "document.querySelector('[data-cm-cenarios]')", "a Bancada não carregou");
      await cdp.evaluate("document.querySelector('[data-cenario=\"P-ATIVA\"]').click()");
      await waitFor(cdp, "document.getElementById('cm-bancada-vigor')", "o botão 'Já em vigor' não apareceu");
      const resultado = await texto("#cm-banc-resultado");
      assert.ok(resultado.includes("Em vigor") && resultado.includes("É a promoção que forma o preço de hoje."), resultado);
      assert.ok(!/bloqueado/i.test(resultado), resultado);
      assert.strictEqual(await cdp.evaluate("document.getElementById('cm-bancada-review')"), null, "sem botão de escrita");
      assert.strictEqual(await cdp.evaluate("document.getElementById('cm-bancada-vigor').disabled"), true);
      assert.ok(await semRolagemHorizontal(), "sem rolagem horizontal");
      await shot("06-bancada-ativa");
      await cdp.evaluate("window.VFCentralMargemUi.closeDrawer()");
    });

    await check("Bancada de anúncio em prejuízo: botão 'Subir p/ R$ X' com o preço-alvo cotado", async () => {
      await cdp.evaluate("document.querySelector('tr[data-item-id=\"MLB1003\"]').click()");
      await waitFor(cdp, "document.querySelector('[data-cm-chip=\"alvo\"]')", "o preço-alvo cotado não apareceu");
      assert.ok(/Subir p\/ R\$\s95,59/.test(await texto("[data-cm-chip=\"alvo\"]")));
      await shot("08-bancada-prejuizo");
      await cdp.evaluate("window.VFCentralMargemUi.closeDrawer()");
    });

    // ── Fase 2: o caso real do mockup (MLB5537622816), números do núcleo de verdade ──
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: roteiroRedFish.identifier });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      localStorage.setItem("vf-token", "ui-test-token");
      localStorage.setItem("vf-user", JSON.stringify({ nome: "Teste UI", role: "admin" }));
      ${mockCasoReal(mock)}
      ${fixtureCasoReal()}
    ` });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/central-margem.html?cliente=red_fish` });
    await waitFor(cdp, "window.VFCentralMargemUi && window.VF && window.VF.context && (window.VFCentralMargemUi.getState().awaitingAccount || (window.VF.context.getState() === 'READY' && window.VFCentralMargemUi.getState().contaId === 10))", "caso real: Shell não resolveu a conta");
    for (let i = 0; i < 60; i += 1) {
      await cdp.evaluate("window.VF.context.setConta(10)");
      if (await cdp.evaluate("window.VFCentralMargemUi.getState().contaId === 10")) break;
      await sleep(100);
    }
    await waitFor(cdp, `document.querySelector('#cm-table-host tbody tr[data-item-id="${CASO_REAL.mlb}"]')`, "caso real: a linha do MLB5537622816 não apareceu");
    const resultadoReal = () => cdp.evaluate("document.getElementById('cm-banc-resultado').innerText").then((t) => t.replace(/ /g, " "));
    const celulasComTraco = () => cdp.evaluate("Array.prototype.filter.call(document.querySelectorAll('#cm-drawer td, #cm-drawer th, #cm-drawer .cm-cen > span, #cm-drawer .cm-dsum__value'), function (c) { return c.textContent.trim() === '—'; }).length");

    await check("caso real · 11.11 da Black: 'Só se vender mais', frase do backend (−6,76 · 88%), −7,52 (−14%); 1 card, 1 cabeçalho, 4 colunas, 0 '—', nada aberto", async () => {
      await cdp.evaluate(`document.querySelector('tr[data-item-id="${CASO_REAL.mlb}"]').click()`);
      await waitFor(cdp, "document.getElementById('cm-drawer').classList.contains('is-open') && document.querySelector('[data-cm-cenarios]') && document.querySelector('[data-cenario=\"P-1111\"]')", "caso real: a Bancada não carregou");
      await sleep(300);
      // Topo: 6 números do caso, cada um com o sub numa linha (tudo do backend).
      const topo = (await cdp.evaluate("document.getElementById('cm-drawer-summary').textContent")).replace(/\s+/g, " ");
      for (const t of ["Preço atual", "R$ 55,19", "cheio R$ 79,90", "Custo", "R$ 22,42", "Base Red Fish", "Imposto", "11,0%", "R$ 6,07 / un", "Margem projetada", "26,16%", "LC R$ 14,44 / un", "Margem realizada", "20,73%", "últimos 30 dias", "46 un.", "receita R$ 2.540,45"]) assert.ok(topo.includes(t), `topo sem ${t}: ${topo}`);
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#cm-drawer-summary .cm-dsum__cell').length"), 6);
      assert.ok(await cdp.evaluate("document.getElementById('cm-drawer-summary').getBoundingClientRect().height <= 90"), "bloco dos números ≤ 90px");
      assert.ok((await cdp.evaluate("document.querySelector('#cm-drawer-summary [title*=\"inclui retorno ML\"]').title")).replace(/\u00a0/g, " ").includes("R$ 2,24"), "retorno ML explicado no title");
      const meta = (await cdp.evaluate("document.getElementById('cm-drawer-meta').innerText")).replace(/\s+/g, " ");
      assert.ok(/^MLB5537622816 Ativo Dados confiáveis Ver na Base$/.test(meta), meta);
      const manualAntes = await cdp.evaluate("window.__marcaManual = document.getElementById('cm-banc-manual'); window.__pc.calls.simular.length");
      await cdp.evaluate("document.querySelector('[data-cenario=\"P-1111\"]').click()");
      await waitFor(cdp, "document.querySelector('[data-cm-promo-info=\"P-1111\"]')", "o 11.11 não foi selecionado");
      const res = await resultadoReal();
      for (const t of ["Pode participar pelo VenForce", "11.11 da Black", "Deal · 19/10 a 12/11", "Só se vender mais", "Perde R$ 6,76 por unidade. Para empatar o lucro de hoje, precisa vender 88% a mais.", "55,19", "47,67", "14,44", "7,68", "−6,76", "26,2%", "16,1%"]) assert.ok(res.includes(t), `falta ${t}: ${res}`);
      const linha = (await cdp.evaluate("document.querySelector('[data-cenario=\"P-1111\"]').innerText")).replace(/\s+/g, " ");
      for (const t of ["11.11 da Black", "Deal · 19/10 a 12/11", "47,67", "−7,52 (−14%)", "7,68", "−6,76", "Só se vender mais"]) assert.ok(linha.includes(t), `linha sem ${t}: ${linha}`);
      // Clicar numa linha atualiza a esquerda SEM recarregar o drawer e sem nova chamada ao servidor.
      assert.strictEqual(await cdp.evaluate("window.__marcaManual === document.getElementById('cm-banc-manual')"), true, "o drawer não foi recarregado");
      assert.strictEqual(await cdp.evaluate("window.__pc.calls.simular.length"), manualAntes, "trocar de linha não chama o /simular");
      // UMA tabela num único card: 1 cabeçalho de 4 colunas, "Preço manual" primeiro, grupos dentro, só os simuláveis.
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#cm-drawer .cm-cens').length"), 1, "1 card");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#cm-drawer .cm-cens__cab').length"), 1, "1 cabeçalho");
      assert.strictEqual(await cdp.evaluate("document.querySelector('.cm-cens__cab').innerText.replace(/\\s*\\n\\s*/g, ' | ')"), "Cenário | Preço · mudança | LC / un · vs hoje | Resultado");
      assert.strictEqual(await cdp.evaluate("getComputedStyle(document.querySelector('.cm-cens__cab')).gridTemplateColumns.split(' ').length"), 4, "4 colunas");
      assert.strictEqual(await cdp.evaluate("JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.cm-cens .cm-cen'), function (l) { return l.children.length; }).filter(function (v, i, a) { return a.indexOf(v) === i; }))"), "[4]", "toda linha tem 4 células");
      assert.strictEqual(await cdp.evaluate("document.querySelector('.cm-cens [data-cenario]').getAttribute('data-cenario')"), "preco", "Preço manual é a primeira linha");
      assert.strictEqual(await cdp.evaluate("Boolean(document.querySelector('[data-cenario=\"preco\"] #cm-new-price'))"), true, "campo inline na linha");
      const grupos = await cdp.evaluate("Array.prototype.map.call(document.querySelectorAll('.cm-cens__grupo'), function (g) { return g.textContent; }).join(' | ')");
      assert.strictEqual(grupos, "Ativa agora | Pode participar pelo VenForce", "só grupos com cenário simulável");
      // Sem simulação: fora da tabela, recolhidas no fim do card, com nome · grupo · motivo.
      assert.strictEqual(await cdp.evaluate("document.querySelector('[data-cm-sem-simulacao] > summary').textContent"), "4 promoções sem efeito no preço");
      for (const [id, txt] of [["P-VENDEX", "Você já participa · Não reduz o preço"], ["P-PESCAOFF", "Só pelo Mercado Livre · Sem preço sugerido"], ["P-CUPOM", "Só pelo Mercado Livre · Sem preço sugerido"], ["P-RELAMPAGO", "Só pelo Mercado Livre · Não reduz o preço"]]) {
        assert.strictEqual(await cdp.evaluate(`document.querySelector('[data-cenario="${id}"]')`), null, `${id} fora da tabela`);
        assert.ok((await cdp.evaluate(`document.querySelector('[data-cm-sem="${id}"]').textContent`)).includes(txt), `${id}: ${txt}`);
      }
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('#cm-drawer details[open]').length"), 0, "nada aberto por padrão");
      assert.strictEqual(await cdp.evaluate("Array.prototype.filter.call(document.querySelectorAll('.cm-cen__sub, .cm-dsum__value'), function (e) { return e.scrollWidth > e.clientWidth + 1; }).map(function (e) { return e.textContent; }).join(' | ')"), "", "mudança e números sem reticências");
      // Em 1440 o resultado cabe numa linha (mais estreito, quebra em vez de cortar).
      if (VIEW_W >= 1440) assert.strictEqual(await cdp.evaluate("Array.prototype.filter.call(document.querySelectorAll('.cm-cen__res .cm-res'), function (e) { return e.getBoundingClientRect().height > 22; }).map(function (e) { return e.textContent; }).join(' | ')"), "", "resultado numa linha em 1440px");
      assert.strictEqual(await celulasComTraco(), 0, "nenhuma coluna com '—'");
      // Números tabulares e alinhados à direita (mesma coluna sempre).
      const alinhamentos = await cdp.evaluate("JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.cm-banc__cmp td.num, .cm-efeitos td.num, .cm-cen__preco, .cm-cen__lc'), function (c) { var s = getComputedStyle(c); return s.textAlign + '/' + s.fontVariantNumeric; }).filter(function (v, i, a) { return a.indexOf(v) === i; }))");
      assert.deepStrictEqual(JSON.parse(alinhamentos), ["right/tabular-nums"], alinhamentos);
      const bordasPreco = await cdp.evaluate("JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.cm-cen__preco'), function (c) { return Math.round(c.getBoundingClientRect().right); }).filter(function (v, i, a) { return a.indexOf(v) === i; }))");
      assert.strictEqual(JSON.parse(bordasPreco).length, 1, `preço final na mesma coluna: ${bordasPreco}`);
      assert.strictEqual(await cdp.evaluate("document.getElementById('cm-bancada-review').textContent"), "Participar desta promoção");
      assert.ok(await semRolagemHorizontal(), "sem rolagem horizontal");
      await shot("20-caso-real-1111");
    });

    await check("caso real · Preço manual 59,90 (1ª linha, campo inline): 'Vale entrar', 'Ganha R$ 1,41…', +4,71 (+9%) e +0,3 pp; a linha fica selecionada", async () => {
      await cdp.evaluate("(function(){var i=document.getElementById('cm-new-price');i.focus();i.value='59,90';i.dispatchEvent(new Event('input',{bubbles:true}));})()");
      await waitFor(cdp, "document.getElementById('cm-banc-resultado').textContent.indexOf('Ganha R$') !== -1", "o preço digitado não foi simulado");
      const res = await resultadoReal();
      for (const t of ["Seu preço", "Preço manual", "sai da promoção ativa", "Vale entrar", "Ganha R$ 1,41 por unidade em relação a hoje.", "59,90", "+4,71", "15,85", "+1,41", "26,5%", "+0,3 pp"]) assert.ok(res.includes(t), `falta ${t}: ${res}`);
      const linha = (await cdp.evaluate("document.querySelector('[data-cenario=\"preco\"]').innerText")).replace(/\s+/g, " ");
      for (const t of ["Preço manual", "sai da promoção ativa", "+4,71 (+9%)", "15,85", "+1,41", "Vale entrar"]) assert.ok(linha.includes(t), `linha sem ${t}: ${linha}`);
      assert.strictEqual(await cdp.evaluate("document.getElementById('cm-new-price').value"), "59,90", "o campo inline mantém o que foi digitado");
      assert.strictEqual(await cdp.evaluate("document.querySelector('[data-cenario=\"preco\"]').getAttribute('aria-checked')"), "true");
      assert.strictEqual(await cdp.evaluate("document.activeElement && document.activeElement.id"), "cm-new-price", "o foco continua no campo");
      assert.strictEqual(await cdp.evaluate("document.getElementById('cm-bancada-review').textContent"), "Revisar novo preço");
      assert.strictEqual(await celulasComTraco(), 0, "nenhuma coluna com '—'");
      await cdp.evaluate("document.activeElement.blur(); document.getElementById('cm-drawer-body').scrollTop = 0");
      await shot("21-caso-real-seu-preco");
    });

    await check("caso real · ativa selecionada: 'Em vigor', 0,00 e 'Já em vigor' desabilitado", async () => {
      await cdp.evaluate("document.querySelector('[data-cenario=\"P-IMPULSIONE\"]').click()");
      await waitFor(cdp, "document.getElementById('cm-bancada-vigor')", "o botão 'Já em vigor' não apareceu");
      const res = await resultadoReal();
      for (const t of ["Ativa agora", "Impulsione suas vendas", "Smart · 23/08 a 19/02", "Em vigor", "É a promoção que forma o preço de hoje."]) assert.ok(res.includes(t), `falta ${t}: ${res}`);
      const linha = (await cdp.evaluate("document.querySelector('[data-cenario=\"P-IMPULSIONE\"]').innerText")).replace(/\s+/g, " ");
      for (const t of ["Impulsione suas vendas", "ML paga R$ 2,24", "55,19", "sem mudança", "0,00", "Em vigor"]) assert.ok(linha.includes(t), `linha sem ${t}: ${linha}`);
      assert.strictEqual(await cdp.evaluate("Boolean(document.querySelector('[data-cm-efeitos]'))"), false, "cenário = hoje: sem 'de onde sai a diferença'");
      assert.strictEqual(await cdp.evaluate("document.getElementById('cm-bancada-vigor').disabled"), true);
      assert.strictEqual(await celulasComTraco(), 0, "nenhuma coluna com '—'");
      await shot("22-caso-real-ativa");
    });

    await check("caso real · Evidências com a linha Frete selecionada: tabela-padrão, detalhe compacto em pares, 0 '—', sem botão da Bancada no rodapé", async () => {
      await cdp.evaluate("document.querySelector('[data-tab=evidence]').click()");
      await waitFor(cdp, "document.querySelector('[data-evidence-var=freight]')", "Evidências não abriu");
      await cdp.evaluate("document.querySelector('[data-evidence-var=freight]').click()");
      await waitFor(cdp, "document.querySelector('[data-cm-ev-detalhe=freight]')", "o detalhe do Frete não apareceu");
      const detalhe = (await texto("[data-cm-ev-detalhe=freight]")).replace(/\s+/g, " ");
      for (const t of ["Frete", "R$ 8,15", "selecionada", "Escolha do Motor", "Conflito", "Por que esta fonte"]) assert.ok(detalhe.includes(t), `detalhe sem ${t}: ${detalhe}`);
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('.cm-evidence-card').length"), 0, "os cards grandes de fonte saíram");
      assert.strictEqual(await celulasComTraco(), 0, "nenhuma coluna com '—'");
      assert.strictEqual(await cdp.evaluate("document.getElementById('cm-banc-botao').innerHTML"), "", "fora de Precificar não há botão da Bancada");
      await shot("23-caso-real-evidencias");
    });

    console.log(`# ${checks} testes visuais concluídos`);
    for (const arquivo of arquivos) console.log(`  screenshot: ${arquivo}`);
  } finally {
    if (cdp) {
      try { await cdp.send("Fetch.disable"); } catch (_) { /* já pode estar fechado */ }
      cdp.close();
    }
    chrome.kill("SIGTERM");
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
