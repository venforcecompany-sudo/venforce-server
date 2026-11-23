/* Promoções com rebate — botão na barra da lista de Anúncios ML + modal em 4
   passos (referência → análise com polling → prévia com grupos → execução
   com resultado por item e retry só das falhas). API mockada via CDP Fetch,
   no contrato de docs/specs/2026-10-15-anuncios-ml-promocoes-rebate.md.
   Harness copiado de anuncios-meli-custos-lista-ui.test.js. */
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
const USER_DATA_DIR = path.join(os.platform() === "win32" ? "C:\\tmp" : "/tmp", `vf-promo-rebate-${process.pid}`);

const N97 = { id: 87, nome: "N97 Comercial", slug: "n97", ativo: true, temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100, statusOperacional: "pronto", ultimaSincronizacao: null, pendencias: [] };
const N97_CONTAS = [
  { id: 42, cliente_id: 87, marketplace: "meli", nome: "Loja A", externalAccountLabel: "lojaa", ativo: true, grant: { token_status: "valid" }, base: { base_id: 9, nome: "Custo" } },
  { id: 43, cliente_id: 87, marketplace: "meli", nome: "Loja B", externalAccountLabel: "lojab", ativo: true, grant: { token_status: "valid" }, base: { base_id: 9, nome: "Custo" } },
];
const ME_CONTEXT = {
  ok: true,
  user: { id: 12, nome: "Pedro Gomes", email: null, role: "user" },
  squads: [], squadPrincipalId: null,
  clientes: [{ id: 87, slug: "n97", nome: "N97 Comercial", squadId: null, responsavelDireto: false, contasAtivas: 2 }],
  portfolio: { totalClientes: 1 },
  permissoes: { podeAdministrar: false },
};

function linhaItem(id, titulo) {
  return {
    tipo: "item", key: "item:" + id, item_id: id, family_id: null,
    titulo, sku: "SKU-" + id, preco: 99.9, preco_original: null, moeda: "BRL", estoque: 3, vendidos: 1, status: "active",
    permalink: null, thumbnail: null, pictures_count: 3, is_full: false,
    catalog_listing: false, family_name: null, variations_count: 0, listing_type_id: "gold_special",
    score_venforce: 80, revisado: false, total_itens: 1, total_user_products: 0, estoque_total: 3, vendidos_total: 1,
    cover: { thumbnail: null, user_product_id: null },
  };
}
const LINHAS = [linhaItem("MLB-R1", "Garrafa térmica 1L"), linhaItem("MLB-E1", "Copo inox 500ml")];

// --- Contrato da spec -------------------------------------------------------
const XSS_TITULO = '<img src=x onerror="window.__rebXss=1">Kit Facas';
const REFERENCIAS = [
  { id: "C-VDX10", tipo: "SELLER_CAMPAIGN", tipoLabel: "Campanha própria", nome: "Vendex - Outubro", status: "started",
    inicio: "2026-10-01T03:00:00Z", fim: "2026-11-01T02:59:00Z", padrao: true },
  { id: "C-VDX09", tipo: "SELLER_CAMPAIGN", tipoLabel: "Campanha própria", nome: "Vendex Setembro", status: "started",
    inicio: "2026-09-01T03:00:00Z", fim: "2026-10-31T02:59:00Z", padrao: false },
  { id: "P-DEAL1", tipo: "DEAL", tipoLabel: "Oferta do dia", nome: "<b>Black</b> Week", status: "pending",
    inicio: "2026-11-20T03:00:00Z", fim: "2026-11-30T02:59:00Z", padrao: false },
];

function cand(pid, tipo, nome, preco, margem, lucro, gm, gl, extra) {
  return Object.assign({ promotionId: pid, tipo, tipoLabel: tipo === "SMART" ? "Campanha co-participada" : "Campanha do ML", nome,
    preco, subsidioMl: 4.99, meliPercentage: 5, margemPercent: margem, lucro, ganhoMargemPp: gm, ganhoLucro: gl, fim: "2026-10-31T02:59:00Z",
    melhorMargem: false, melhorLucro: false }, extra || {});
}
const REF_VAL = { preco: 99.9, subsidioMl: 0, margemPercent: 12.3, lucro: 12.29 };
const RESULTADO = {
  resumo: { recomendado: 2, escolha: 2, sem_ganho: 1, descartado: 3 },
  itens: [
    { itemId: "MLB-R1", titulo: "Garrafa térmica 1L", thumbnail: null, status: "recomendado", motivo: null, motivoTexto: null,
      referencia: REF_VAL, candidatas: [cand("P-1", "SMART", "Smart Outubro", 94.9, 14.1, 13.38, 1.8, 1.09, { melhorMargem: true, melhorLucro: true })],
      sugestao: { porMargem: "P-1", porLucro: "P-1" } },
    { itemId: "MLB-R2", titulo: XSS_TITULO, thumbnail: "javascript:alert(1)", status: "recomendado", motivo: null, motivoTexto: null,
      referencia: REF_VAL, candidatas: [cand("P-2", "MARKETPLACE_CAMPAIGN", "Campanha <ML>", 95.5, 13, 12.9, 0.7, 0.61, { melhorMargem: true, melhorLucro: true })],
      sugestao: { porMargem: "P-2", porLucro: "P-2" } },
    { itemId: "MLB-E1", titulo: "Copo inox 500ml", thumbnail: null, status: "escolha", motivo: null, motivoTexto: null,
      referencia: REF_VAL, candidatas: [
        cand("P-3M", "SMART", "Smart margem", 92, 14.3, 11.8, 2.0, -0.5, { melhorMargem: true }),
        cand("P-3L", "PRICE_MATCHING", "Preço competitivo", 89, 12.0, 13.49, -0.3, 1.2, { melhorLucro: true }),
        cand("P-3X", "UNHEALTHY_STOCK", "Estoque parado", 90, 12.5, 12.4, 0.2, 0.11),
      ], sugestao: { porMargem: "P-3M", porLucro: "P-3L" } },
    { itemId: "MLB-E2", titulo: "Tábua de corte", thumbnail: null, status: "escolha", motivo: null, motivoTexto: null,
      referencia: { preco: 99.9, subsidioMl: 0, margemPercent: null, lucro: null },
      // Já numa promoção com rebate fora da Vendex: ela é o "hoje".
      atual: { promotionId: "P-JA", tipo: "SMART", nome: "Smart já ativa", ehReferencia: false, preco: 96, subsidioMl: 3, meliPercentage: 3, margemPercent: 12.3, lucro: 12.29 },
      candidatas: [
        cand("P-4M", "SMART", "Smart tábua", 93, 13.3, 11.29, 1.0, -1.0, { melhorMargem: true }),
        cand("P-4L", "SMART", "Smart tábua 2", 94, 12.8, 12.09, 0.5, -0.2, { melhorLucro: true }),
      ], sugestao: { porMargem: "P-4M", porLucro: "P-4L" } },
    { itemId: "MLB-S1", titulo: "Pote hermético", thumbnail: null, status: "sem_ganho", motivo: "JA_EM_REBATE_MELHOR", motivoTexto: null,
      referencia: REF_VAL, candidatas: [], sugestao: { porMargem: null, porLucro: null } },
    { itemId: "MLB-D1", titulo: "Faqueiro 24 peças", thumbnail: null, status: "descartado", motivo: "SEM_CUSTO", motivoTexto: null,
      referencia: null, candidatas: [], sugestao: { porMargem: null, porLucro: null } },
    { itemId: "MLB-D2", titulo: "Panela pressão", thumbnail: null, status: "descartado", motivo: "PRECO_NAO_MENOR", motivoTexto: "Texto do servidor <i>sem HTML</i>",
      referencia: null, candidatas: [], sugestao: { porMargem: null, porLucro: null } },
    { itemId: "MLB-D3", titulo: "Jogo de lençol", thumbnail: null, status: "descartado", motivo: "ABAIXO_FRETE_GRATIS", motivoTexto: null,
      referencia: null, candidatas: [], sugestao: { porMargem: null, porLucro: null } },
  ],
};

const SERVIDOR = {
  referencias: REFERENCIAS,
  padraoId: "C-VDX10",
  proximoJob: 77,
  jobs: {},
  refsLidas: [],
  analises: [],
  execucoes: [],
  gets: 0,
  familiasLidas: 0,
  falharExec: { "MLB-R2": "A promoção não está mais disponível para este anúncio." },
  analiseOcupada: false,
};

function jobJson(job) {
  const base = { id: job.id, erro: null, referencia: { id: job.ref.id, tipo: job.ref.tipo, nome: "Vendex - Outubro" } };
  if (job.exec) {
    job.exec.polls += 1;
    const fim = job.exec.polls > 3;
    const itens = job.exec.escolhas.map((e, i) => {
      if (!fim && i > 0) return { itemId: e.itemId, promotionId: e.promotionId, tipo: e.tipo, status: "pendente", codigo: null, motivo: null, precoConfirmado: null };
      const motivo = job.exec.falhas[e.itemId];
      return motivo
        ? { itemId: e.itemId, promotionId: e.promotionId, tipo: e.tipo, status: "falha", codigo: "PROMOCAO_INDISPONIVEL", motivo, precoConfirmado: null }
        : { itemId: e.itemId, promotionId: e.promotionId, tipo: e.tipo, status: "ok", codigo: null, motivo: null, precoConfirmado: 90 };
    });
    return Object.assign(base, {
      fase: "execucao", status: fim ? "concluido" : "processando",
      progresso: { total: 8, processados: 8 }, resultado: RESULTADO,
      execucao: { total: itens.length, processados: itens.filter((x) => x.status !== "pendente").length, itens },
    });
  }
  job.polls += 1;
  if (job.polls <= 2) {
    return Object.assign(base, { fase: "analise", status: "processando", progresso: { total: 8, processados: job.polls, resumo: { recomendado: 1, escolha: 0, sem_ganho: 0, descartado: job.polls - 1 } }, resultado: null, execucao: null });
  }
  return Object.assign(base, { fase: "analise", status: "concluido", progresso: { total: 8, processados: 8 }, resultado: RESULTADO, execucao: null });
}

const SEMENTE = `
  try {
    localStorage.setItem("vf-token", "lista-token");
    localStorage.setItem("vf-user", JSON.stringify({ id: 12, nome: "Pedro Gomes", role: "user" }));
    sessionStorage.removeItem("vf-ctx");
  } catch (e) {}
`;

function startServer() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    const target = path.resolve(PORTAL_DIR, u.pathname.replace(/^\/+/, ""));
    if (!target.startsWith(path.resolve(PORTAL_DIR) + path.sep)) { res.writeHead(403).end("forbidden"); return; }
    fs.readFile(target, (err, contents) => {
      if (err) { res.writeHead(404).end("not found"); return; }
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
      res.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(contents);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitChrome(port) {
  for (let i = 0; i < 200; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return; } catch (_) { /* ainda subindo */ }
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

async function waitFor(cdp, expression, message, tentativas = 200) {
  for (let i = 0; i < tentativas; i++) {
    let ok = false;
    try { ok = await cdp.evaluate(`Boolean(${expression})`); } catch (_) { ok = false; }
    if (ok) return;
    await sleep(50);
  }
  throw new Error(message || `Timeout: ${expression}`);
}

let checks = 0;
let failures = 0;
async function check(name, fn) {
  checks += 1;
  try { await fn(); console.log(`ok ${checks} - ${name}`); }
  catch (err) { failures += 1; console.error(`not ok ${checks} - ${name}: ${err.message}`); }
}

function wireInterception(cdp, excecoes) {
  cdp.onEvent = async (method, params) => {
    if (method === "Runtime.exceptionThrown") {
      excecoes.push(`${params?.exceptionDetails?.text || ""} ${params?.exceptionDetails?.exception?.description || ""}`.trim());
    }
    if (method !== "Fetch.requestPaused") return;
    const url = params.request.url;
    const requestId = params.requestId;
    if (!url.includes(PROD_HOST)) {
      if (url.startsWith("http://127.0.0.1")) { await cdp.send("Fetch.continueRequest", { requestId }); return; }
      await cdp.send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" }); return;
    }
    const headers = [
      { name: "access-control-allow-origin", value: "*" },
      { name: "access-control-allow-headers", value: "authorization,content-type" },
      { name: "access-control-allow-methods", value: "GET,POST,OPTIONS" },
      { name: "content-type", value: "application/json" },
    ];
    async function respond(obj, code = 200) {
      await cdp.send("Fetch.fulfillRequest", {
        requestId, responseCode: code, responseHeaders: headers,
        body: Buffer.from(JSON.stringify(obj)).toString("base64"),
      });
    }
    if (params.request.method === "OPTIONS") { await respond({}, 204); return; }
    const u = new URL(url);
    const pathname = u.pathname;
    let corpo = null;
    try { corpo = params.request.postData ? JSON.parse(params.request.postData) : null; } catch (_) { corpo = null; }
    if (pathname.includes("/me/context")) return respond(ME_CONTEXT);
    if (pathname.includes("/operacao/cliente-360/clientes")) return respond({ ok: true, clientes: [N97] });
    if (/\/clientes\/[^/?]+\/contas/.test(pathname)) return respond({ ok: true, cliente: N97, contas: N97_CONTAS });
    if (pathname === "/anuncios-meli/clientes") return respond({ ok: true, clientes: [{ id: 87, nome: N97.nome, slug: "n97", mlConectado: true, totalAnuncios: 2 }] });
    if (pathname === "/anuncios-meli/resumo") return respond({ ok: true, resumo: { total: 2, ativos: 2, pausados: 0, scoreBaixo: 0, semSku: 0, semCusto: 0, full: 0, ultimaSync: new Date().toISOString() } });
    if (pathname === "/anuncios-meli/custos") {
      const custos = {};
      (u.searchParams.get("itemIds") || "").split(",").filter(Boolean).forEach((id) => { custos[id] = 30; });
      return respond({ ok: true, base: { slug: "base-n97", nome: "Custo" }, motivo: "OK", mensagem: null, custos });
    }
    if (pathname === "/anuncios-meli/familias") {
      SERVIDOR.familiasLidas += 1;
      return respond({ ok: true, cliente: N97, anuncios: LINHAS, paginacao: { page: 1, limit: 24, total: LINHAS.length, totalPaginas: 1 } });
    }
    if (pathname === "/anuncios-meli/performance") return respond({ ok: true, metricas7d: {}, margem: {}, margemIndisponivel: null, faturamento: null, unidadesVendidas: null, curvaAbc: null, margemPorFamilia: null });

    // --- Promoções com rebate ---
    if (pathname === "/anuncios-meli/promocoes-rebate/referencias") {
      SERVIDOR.refsLidas.push(Object.fromEntries(u.searchParams));
      return respond({ ok: true, padraoId: SERVIDOR.padraoId, referencias: SERVIDOR.referencias });
    }
    if (pathname === "/anuncios-meli/promocoes-rebate/analises" && params.request.method === "POST") {
      SERVIDOR.analises.push(corpo);
      if (SERVIDOR.analiseOcupada) return respond({ ok: false, codigo: "ANALISE_EM_ANDAMENTO", motivo: "Já existe uma análise em andamento para este cliente." });
      const id = SERVIDOR.proximoJob++;
      SERVIDOR.jobs[id] = { id, ref: corpo.referencia, polls: 0, exec: null };
      return respond({ ok: true, jobId: id });
    }
    const exec = pathname.match(/^\/anuncios-meli\/promocoes-rebate\/analises\/([^/]+)\/executar$/);
    if (exec && params.request.method === "POST") {
      const job = SERVIDOR.jobs[decodeURIComponent(exec[1])];
      SERVIDOR.execucoes.push(corpo);
      const falhas = Object.assign({}, SERVIDOR.falharExec);
      SERVIDOR.falharExec = {}; // o retry passa
      job.exec = { escolhas: corpo.escolhas, polls: 0, falhas };
      return respond({ ok: true });
    }
    const get = pathname.match(/^\/anuncios-meli\/promocoes-rebate\/analises\/([^/]+)$/);
    if (get) {
      SERVIDOR.gets += 1;
      const job = SERVIDOR.jobs[decodeURIComponent(get[1])];
      if (!job) return respond({ ok: false, codigo: "JOB_NAO_ENCONTRADO", motivo: "Análise não encontrada." });
      return respond({ ok: true, job: jobJson(job) });
    }
    await cdp.send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" });
  };
}

const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const texto = (sel) => `((${q(sel)} || {}).textContent || "").replace(/\\s+/g, " ").trim()`;
const clicar = (cdp, sel) => cdp.evaluate(`${q(sel)}.click()`);
const contador = texto("[data-reb-contador]");
const REC = (itemId) => `[data-reb-grupo-sec="recomendado"] [data-reb-item="${itemId}"]`;
const escolhaMarcada = (itemId) => `(${q(`.am-reb-escolha[data-reb-item="${itemId}"] input[type=checkbox]:checked`)} || {}).value`;

async function tecla(cdp, seletor, key) {
  await cdp.evaluate(`(${q(seletor)} || document.activeElement).dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`);
}

async function foto(cdp, nome) {
  if (!process.env.VF_SHOTS) return;
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(process.env.VF_SHOTS, nome + ".png"), Buffer.from(r.data, "base64"));
}

async function abrirPagina(cdp, porta) {
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
  await waitFor(cdp, "document.querySelector('.am-row[data-item]')", "Lista não renderizou");
}

async function analisarAtePrevia(cdp) {
  await clicar(cdp, "#am-reb-abrir");
  await waitFor(cdp, `${q("#am-reb-ref")} && ${q("#am-reb-ref")}.value === "C-VDX10"`, "referências não carregaram");
  await clicar(cdp, "#am-reb-analisar");
  await waitFor(cdp, q("[data-reb-resumo]"), "prévia não apareceu", 300);
}

async function run() {
  const server = await startServer();
  const porta = server.address().port;
  const debugPort = 24000 + Math.floor(Math.random() * 900);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--window-size=1600,900", `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${USER_DATA_DIR}`, "about:blank",
  ], { stdio: "ignore" });
  let cdp;
  const excecoes = [];
  try {
    await waitChrome(debugPort);
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    wireInterception(cdp, excecoes);
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: SEMENTE });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
    await abrirPagina(cdp, porta);

    // ── Botão e passo 1 ──────────────────────────────────────────────────────
    await check("P1 — botão 'Radar de subsídios' na barra da lista, habilitado com cliente+conta", async () => {
      await waitFor(cdp, `${q("#am-reb-abrir")} && !${q("#am-reb-abrir")}.disabled`, "botão não habilitou");
      assert.strictEqual(await cdp.evaluate(texto("#am-reb-abrir .am-reb-abrir__titulo")), "Radar de subsídios");
      // Ocupa a altura inteira da barra (menos o padding dela).
      assert.ok(await cdp.evaluate(`(() => { const b = document.querySelector("#am-reb-abrir").getBoundingClientRect();
        const t = document.querySelector(".am-filtros").getBoundingClientRect(); return b.height >= t.height - 34; })()`), "botão não cobre a altura da barra");
      assert.ok(await cdp.evaluate(`!!document.querySelector(".am-filtros .vf-toolbar__actions #am-reb-abrir")`), "fica nas ações da barra da lista");
    });
    await check("P2 — fica desabilitado no modo 'Editar custos' e volta ao sair", async () => {
      await waitFor(cdp, q('[data-custos-acao="entrar"]'), "Editar custos ausente");
      await clicar(cdp, '[data-custos-acao="entrar"]');
      await waitFor(cdp, `${q("#am-reb-abrir")}.disabled`, "não desabilitou no modo custos");
      await clicar(cdp, '[data-custos-acao="sair"]');
      await waitFor(cdp, `!${q("#am-reb-abrir")}.disabled`, "não reabilitou");
    });
    await check("P3 — abre o modal, busca as referências da conta e pré-seleciona o padraoId", async () => {
      await clicar(cdp, "#am-reb-abrir");
      await waitFor(cdp, `${q("#am-reb-ref")} && ${q("#am-reb-ref")}.value === "C-VDX10"`, "padrão não pré-selecionado");
      assert.deepStrictEqual(SERVIDOR.refsLidas[0], { clienteSlug: "n97", clienteContaId: "42" });
      assert.strictEqual(await cdp.evaluate(`document.querySelector(".am-reb-overlay").getAttribute("role")`), "dialog");
      assert.ok(await cdp.evaluate(`document.querySelector(".am-reb-overlay").contains(document.activeElement)`), "foco dentro do modal");
      const opcoes = await cdp.evaluate(`Array.from(document.querySelectorAll("#am-reb-ref option")).map(o => o.textContent)`);
      assert.strictEqual(opcoes.length, 3);
      assert.match(opcoes[0], /Vendex - Outubro · Campanha própria · 01\/10\/2026 a 31\/10\/2026/);
      assert.match(opcoes[2], /<b>Black<\/b> Week/, "nome com HTML aparece como texto");
      assert.match(await cdp.evaluate(texto(".am-reb-intro")), /A promoção de referência não é alterada/);
      assert.match(await cdp.evaluate(`document.querySelector('label[for="am-reb-ref"]').textContent`), /Promoção de referência/);
    });
    await foto(cdp, "rebate-01-referencia");
    await check("P4 — Esc fecha o modal no passo de referência", async () => {
      await tecla(cdp, "#am-reb-ref", "Escape");
      await waitFor(cdp, `!${q(".am-reb-overlay")}`, "Esc não fechou");
      assert.strictEqual(await cdp.evaluate(`document.body.classList.contains("vf-no-scroll")`), false);
    });

    // ── Falha esperada do servidor ───────────────────────────────────────────
    await check("P5 — POST analises com ok:false mostra o motivo e fica no passo 1", async () => {
      SERVIDOR.analiseOcupada = true;
      await clicar(cdp, "#am-reb-abrir");
      await waitFor(cdp, `${q("#am-reb-ref")} && ${q("#am-reb-ref")}.value === "C-VDX10"`);
      await clicar(cdp, "#am-reb-analisar");
      await waitFor(cdp, `/Já existe uma análise em andamento/.test(${texto(".am-reb-box")})`, "motivo não apareceu");
      assert.ok(await cdp.evaluate(`!!${q("#am-reb-analisar")}`));
      SERVIDOR.analiseOcupada = false;
    });

    // ── Passo 2: polling; fechar para; reabrir retoma ────────────────────────
    await check("A1 — Analisar envia a referência escolhida e mostra o progresso", async () => {
      await clicar(cdp, "#am-reb-analisar");
      await waitFor(cdp, q("[data-reb-progresso]"), "progresso ausente");
      const corpo = SERVIDOR.analises[SERVIDOR.analises.length - 1];
      assert.deepStrictEqual(corpo, { clienteSlug: "n97", clienteContaId: "42", referencia: { id: "C-VDX10", tipo: "SELLER_CAMPAIGN" } });
      await waitFor(cdp, `/de 8 anúncios/.test(${texto("[data-reb-progresso]")})`, "contador do progresso ausente");
      assert.strictEqual(await cdp.evaluate(texto('[data-reb-placar="ganho"] .am-reb-placar__n')), "1", "placar ao vivo: anúncios com ganho até agora");
      assert.match(await cdp.evaluate(texto(".am-reb-placar")), /melhoram margem ou lucro/);
      await foto(cdp, "rebate-01b-analisando");
    });
    await check("A2 — fechar no meio da análise para o polling", async () => {
      await clicar(cdp, "#am-reb-fechar-an");
      await waitFor(cdp, `!${q(".am-reb-overlay")}`, "não fechou");
      const antes = SERVIDOR.gets;
      await sleep(3500);
      assert.strictEqual(SERVIDOR.gets, antes, "continuou consultando o job com o modal fechado");
    });
    await check("A3 — reabrir retoma a mesma análise (sem novo POST) até a prévia", async () => {
      const posts = SERVIDOR.analises.length;
      await clicar(cdp, "#am-reb-abrir");
      await waitFor(cdp, q("[data-reb-resumo]"), "não retomou até a prévia", 300);
      assert.strictEqual(SERVIDOR.analises.length, posts);
      const gets = SERVIDOR.gets;
      await sleep(2000);
      assert.strictEqual(SERVIDOR.gets, gets, "polling continuou depois de concluir");
    });

    // ── Passo 3: prévia ──────────────────────────────────────────────────────
    await check("V1 — resumo por grupo e Recomendados marcados por padrão", async () => {
      const r = await cdp.evaluate(texto("[data-reb-resumo]"));
      assert.match(r, /Recomendados 2/); assert.match(r, /Escolher margem ou lucro 2/); assert.match(r, /Sem ganho 1/); assert.match(r, /Descartados 3/);
      assert.strictEqual(await cdp.evaluate(`${q('[data-reb-aba="recomendado"]')}.getAttribute("aria-selected")`), "true", "abre na aba Recomendados");
      assert.match(await cdp.evaluate(texto(".am-reb-sub")), /Comparando com Vendex - Outubro · 8 anúncios analisados · trocar referência/);
      assert.strictEqual(await cdp.evaluate(`document.querySelectorAll("[data-reb-marcar]:checked").length`), 2);
      assert.strictEqual(await cdp.evaluate(contador), "2 participações selecionadas");
      assert.match(await cdp.evaluate(texto(".am-reb-resumo-sel__det")), /2 recomendadas \+ 0 escolhidas · a Vendex - Outubro continua ativa em todos/);
      assert.strictEqual(await cdp.evaluate(texto("#am-reb-participar")), "Participar de 2");
      assert.strictEqual(await cdp.evaluate(texto(".am-reb-tab__cab")), "AnúncioPreçoMargemLucro/unPromoção sugerida", "uma coluna por medida");
      assert.match(await cdp.evaluate(texto(`${REC("MLB-R1")} [data-reb-hoje-nome]`)), /hoje Vendex - Outubro/, "o hoje mostra o nome da promoção que forma o preço");
      const linha = await cdp.evaluate(texto(REC("MLB-R1")));
      assert.match(linha, /MLB-R1/); assert.match(linha, /Smart Outubro/); assert.ok(!/ ML/.test(linha), "sem '+ R$ x ML'");
      const celulas = JSON.parse(await cdp.evaluate(`JSON.stringify(Array.from(document.querySelectorAll('${REC("MLB-R1")} .am-reb-medida')).map(n => Array.from(n.children).map(c => c.textContent)))`));
      assert.deepStrictEqual(celulas.slice(0, 3), [
        ["R$ 94,90", "+R$ 4,99 de rebate", "hoje R$ 99,90"],
        ["14,1%", "+1,8 p.p.", "hoje 12,3%"],
        ["R$ 13,38", "+R$ 1,09", "hoje R$ 12,29"],
      ], "valor sugerido → ganho → hoje, na mesma ordem em todas as medidas");
      assert.ok(await cdp.evaluate(`!!document.querySelector('${REC("MLB-R1")} [data-reb-margem] .am-reb-ganho.is-pos')`), "ganho pintado de verde");
      const ys = JSON.parse(await cdp.evaluate(`JSON.stringify(Array.from(document.querySelectorAll('${REC("MLB-R1")} .am-reb-medida__valor')).map(n => Math.round(n.getBoundingClientRect().top)))`));
      assert.ok(ys.every((y) => y === ys[0]), "valores alinhados na mesma linha");
      await foto(cdp, "rebate-02a-recomendados");
      assert.ok(!/Ganho/.test(await cdp.evaluate(texto(".am-reb-tab__cab"))), "sem coluna Ganho");
    });
    await check("V2 — Escolha: 'Manter como está' por padrão; margem e lucro lado a lado + opção extra", async () => {
      await clicar(cdp, '[data-reb-aba="escolha"]');
      await waitFor(cdp, q(".am-reb-escolha"), "aba Escolher não abriu");
      assert.match(await cdp.evaluate(texto(".am-reb-rapida")), /Escolha rápida para os 2 anúncios/);
      assert.strictEqual(await cdp.evaluate(escolhaMarcada("MLB-E1")), "");
      assert.strictEqual(await cdp.evaluate(escolhaMarcada("MLB-E2")), "");
      const rotulos = await cdp.evaluate(`Array.from(document.querySelectorAll('.am-reb-escolha[data-reb-item="MLB-E1"] .am-reb-opcao__rotulo')).map(n => n.textContent)`);
      assert.deepStrictEqual(rotulos, ["Manter como está", "Maior margem", "Maior lucro", "Outra opção"]);
      const card = await cdp.evaluate(texto('.am-reb-escolha[data-reb-item="MLB-E1"]'));
      assert.match(card, /Copo inox 500ml/); assert.match(card, /MLB-E1/);
      assert.ok(!/Rebate ML/.test(await cdp.evaluate(texto('.am-reb-escolha[data-reb-item="MLB-E1"] .am-reb-opcao'))), "a Vendex sem subsídio não mostra rebate");
      assert.match(card, /\+R\$ 4,99 de rebate/); assert.ok(!/Rebate ML/.test(card), "sem a linha 'Rebate ML x%' sob o rebate");
      const nomes = await cdp.evaluate(`Array.from(document.querySelectorAll('.am-reb-escolha[data-reb-item="MLB-E1"] .am-reb-opcao__cab .am-reb-opcao__nome')).map(n => n.textContent)`);
      assert.deepStrictEqual(nomes, ["Vendex - Outubro", "Smart margem", "Preço competitivo", "Estoque parado"], "nome da promoção no topo de cada card");
      const colunas = await cdp.evaluate(`Array.from(document.querySelectorAll('.am-reb-escolha[data-reb-item="MLB-E1"] label.am-reb-opcao:nth-of-type(2) .am-reb-metrica__rotulo')).map(n => n.textContent)`);
      assert.deepStrictEqual(colunas, ["Preço de venda", "Margem", "Lucro/un"]);
      const preco = await cdp.evaluate(texto('.am-reb-escolha[data-reb-item="MLB-E1"] label.am-reb-opcao:nth-of-type(2) .am-reb-metrica'));
      assert.match(preco, /R\$ 92,00/); assert.match(preco, /−R\$ 7,90/, "queda do preço de venda contra o de hoje");
      assert.ok(!/rebate/.test(preco), "o rebate saiu do preço de venda");
      assert.ok(await cdp.evaluate(`!!document.querySelector('.am-reb-escolha[data-reb-item="MLB-E1"] label.am-reb-opcao:nth-of-type(2) .am-reb-metrica:first-child .am-reb-ganho.is-pos')`), "queda de preço pintada de verde");
      const lucroCol = await cdp.evaluate(texto('.am-reb-escolha[data-reb-item="MLB-E1"] label.am-reb-opcao:nth-of-type(2) .am-reb-metrica:last-child'));
      assert.match(lucroCol, /R\$ 11,80/); assert.match(lucroCol, /\+R\$ 4,99 de rebate/, "rebate pequeno sob o lucro"); assert.ok(!/de rebate/.test(lucroCol.replace(/\+R\$ 4,99 de rebate/, "")) && !/\/un de rebate/.test(lucroCol), "sem /un no rebate");
      assert.match(card, /Margem/i); assert.match(card, /Lucro\/un/i); assert.match(card, /atual/);
      assert.match(card, /Vendex - Outubro/, "'Manter como está' mostra a referência quando é ela que forma o preço");
      const cardJa = await cdp.evaluate(texto('.am-reb-escolha[data-reb-item="MLB-E2"] .am-reb-opcao'));
      assert.match(cardJa, /Manter como está/); assert.match(cardJa, /Smart já ativa/); assert.match(cardJa, /R\$ 96,00/);
      assert.match(cardJa, /\+R\$ 3,00 de rebate/, "já em rebate: a 1ª opção traz o rebate da promoção ativa");
      await foto(cdp, "rebate-03b-escolha");
      assert.ok(await cdp.evaluate(`!!document.querySelector('.am-reb-escolha[data-reb-item="MLB-E1"] .am-reb-ganho.is-neg')`), "perda pintada");
      assert.strictEqual(await cdp.evaluate(`document.querySelectorAll('.am-reb-escolha label.am-reb-opcao:not([for])').length`), 0, "toda opção tem label");
    });
    await check("V3 — 'Preferir margem em todos' / 'Preferir lucro em todos' mudam as escolhas e o contador", async () => {
      await clicar(cdp, "#am-reb-pref-margem");
      assert.strictEqual(await cdp.evaluate(escolhaMarcada("MLB-E1")), "P-3M");
      assert.strictEqual(await cdp.evaluate(escolhaMarcada("MLB-E2")), "P-4M");
      assert.strictEqual(await cdp.evaluate(contador), "4 participações selecionadas");
      await clicar(cdp, "#am-reb-pref-lucro");
      assert.strictEqual(await cdp.evaluate(escolhaMarcada("MLB-E1")), "P-3L");
      assert.strictEqual(await cdp.evaluate(escolhaMarcada("MLB-E2")), "", "a sugestão por lucro não melhora o lucro → mantém a referência");
      assert.strictEqual(await cdp.evaluate(contador), "3 participações selecionadas");
      assert.strictEqual(await cdp.evaluate(`${q("#am-reb-pref-lucro")}.getAttribute("aria-checked")`), "true");
      await clicar(cdp, "#am-reb-pref-ref");
      assert.strictEqual(await cdp.evaluate(escolhaMarcada("MLB-E1")), "");
      assert.strictEqual(await cdp.evaluate(contador), "2 participações selecionadas");
      await clicar(cdp, "#am-reb-pref-lucro");
      assert.strictEqual(await cdp.evaluate(contador), "3 participações selecionadas");
    });
    await check("V4 — rádio e checkbox individuais atualizam o contador", async () => {
      await clicar(cdp, '.am-reb-escolha[data-reb-item="MLB-E2"] input[value="P-4L"]');
      assert.strictEqual(await cdp.evaluate(contador), "4 participações selecionadas");
      assert.strictEqual(await cdp.evaluate(`${q("#am-reb-pref-lucro")}.getAttribute("aria-checked")`), "false", "troca manual desmarca a escolha rápida");
      await clicar(cdp, '.am-reb-escolha[data-reb-item="MLB-E2"] input[value=""]');
      await clicar(cdp, '[data-reb-aba="recomendado"]');
      await clicar(cdp, '[data-reb-marcar="MLB-R2"]');
      assert.strictEqual(await cdp.evaluate(contador), "2 participações selecionadas");
      await clicar(cdp, '[data-reb-marcar="MLB-R2"]');
      assert.strictEqual(await cdp.evaluate(contador), "3 participações selecionadas");
    });
    await check("V5 — abas Sem ganho e Descartados, com motivo amigável (ou motivoTexto), inclusive ABAIXO_FRETE_GRATIS", async () => {
      await clicar(cdp, '[data-reb-aba="descartado"]');
      await waitFor(cdp, q('[data-reb-grupo="descartado"]'), "aba Descartados não abriu");
      assert.match(await cdp.evaluate(texto('[data-reb-grupo="descartado"] [data-reb-item="MLB-D1"]')), /Sem custo na Base de custos/);
      assert.match(await cdp.evaluate(texto('[data-reb-grupo="descartado"] [data-reb-item="MLB-D2"]')), /Texto do servidor <i>sem HTML<\/i>/);
      assert.match(await cdp.evaluate(texto('[data-reb-grupo="descartado"] [data-reb-item="MLB-D3"]')), /deixariam o preço abaixo de R\$ 19,00 — o comprador perderia o frete grátis/, "ABAIXO_FRETE_GRATIS com texto amigável");
      assert.ok(!/ABAIXO_FRETE_GRATIS/.test(await cdp.evaluate(texto('[data-reb-grupo="descartado"] [data-reb-item="MLB-D3"]'))), "não mostra o código cru");
      await clicar(cdp, '[data-reb-aba="sem_ganho"]');
      await waitFor(cdp, q('[data-reb-grupo="sem_ganho"]'), "aba Sem ganho não abriu");
      assert.match(await cdp.evaluate(texto('[data-reb-grupo="sem_ganho"]')), /Pote hermético/);
      assert.match(await cdp.evaluate(texto('[data-reb-grupo="sem_ganho"]')), /promoção com rebate melhor/, "JA_EM_REBATE_MELHOR com texto amigável");
      assert.strictEqual(await cdp.evaluate(contador), "3 participações selecionadas", "trocar de aba não perde escolhas");
      await clicar(cdp, '[data-reb-aba="recomendado"]');
    });
    await check("V6 — escape de HTML em todo dado da API (título, nome de promoção, thumbnail)", async () => {
      assert.strictEqual(await cdp.evaluate(`window.__rebXss`), undefined);
      assert.match(await cdp.evaluate(texto(REC("MLB-R2"))), /<img src=x onerror=/);
      assert.match(await cdp.evaluate(texto(REC("MLB-R2"))), /Campanha <ML>/);
      assert.strictEqual(await cdp.evaluate(`document.querySelectorAll('.am-reb-box img').length`), 0, "thumbnail não-http não vira <img>");
      assert.strictEqual(await cdp.evaluate(`document.querySelectorAll('.am-reb-box i, .am-reb-box b').length`), 0);
    });
    await check("V7 — 360px: sem scroll horizontal da página; o modal cabe na tela", async () => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 740, deviceScaleFactor: 1, mobile: true });
      await sleep(300);
      const m = await cdp.evaluate(`({ doc: document.documentElement.scrollWidth, vw: window.innerWidth, box: document.querySelector(".am-reb-box").getBoundingClientRect().right })`);
      assert.ok(m.doc <= m.vw, `scrollWidth ${m.doc} > ${m.vw}`);
      assert.ok(m.box <= m.vw, `modal passa da tela (${m.box})`);
      await foto(cdp, "rebate-02-previa-360");
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
    });
    await foto(cdp, "rebate-03-previa");

    // ── Mensagem para o cliente (WhatsApp) ───────────────────────────────────
    await check("W1 — 'Copiar mensagem' na prévia copia a proposta com os anúncios selecionados, antes → depois", async () => {
      await cdp.evaluate(`navigator.clipboard.writeText = (t) => { window.__copiado = t; return Promise.resolve(); }; window.__copiado = null;`);
      await clicar(cdp, "#am-reb-copiar-proposta");
      await waitFor(cdp, "window.__copiado", "nada foi copiado");
      const msg = await cdp.evaluate("window.__copiado");
      assert.match(msg, /^\*Radar de subsídios · N97 Comercial\*/);
      assert.match(msg, /Analisamos 8 anúncios da \*Vendex - Outubro\*/);
      assert.match(msg, /Encontramos 3 anúncios que ganham/);
      assert.match(msg, /1\. \*Garrafa térmica 1L\* \(MLB-R1\)/);
      assert.match(msg, /Promoção: Smart Outubro · até 30\/10\/2026/);
      assert.match(msg, /Preço: R\$ 99,90 → R\$ 94,90 · rebate do ML: R\$ 4,99 por venda/);
      assert.match(msg, /Margem: 12,3% → 14,1% \(\+1,8 p\.p\.\) · Lucro\/un: R\$ 12,29 → R\$ 13,38 \(\+R\$ 1,09\)/);
      assert.match(msg, /\(MLB-E1\)[\s\S]*Preço competitivo/, "item de Escolha entra com a opção marcada");
      assert.doesNotMatch(msg, /MLB-E2|MLB-S1|MLB-D1/, "só o que está selecionado");
      assert.match(msg, /A \*Vendex - Outubro\* continua ativa/);
      assert.match(msg, /Se estiver de acordo/);
      await waitFor(cdp, `/Mensagem copiada/.test(${texto("#am-toast-stack")})`, "toast de confirmação ausente");
    });

    // ── Passo 4: execução ────────────────────────────────────────────────────
    await check("E1 — Participar pede confirmação inline (sem confirm nativo) dizendo quantos e que a referência fica", async () => {
      await cdp.evaluate(`window.confirm = () => { window.__confirmNativo = true; return true; }; window.alert = () => { window.__alertNativo = true; };`);
      await clicar(cdp, "#am-reb-participar");
      await waitFor(cdp, q("#am-reb-confirmar"), "confirmação inline ausente");
      const t = await cdp.evaluate(texto(".am-reb-confirma"));
      assert.match(t, /3 promoções em 3 anúncios/);
      assert.match(t, /Vendex - Outubro/); assert.match(t, /permanece ativa/);
      assert.strictEqual(SERVIDOR.execucoes.length, 0, "nada enviado antes de confirmar");
      await clicar(cdp, "#am-reb-cancelar-conf");
      await waitFor(cdp, q("#am-reb-participar"));
      await clicar(cdp, "#am-reb-participar");
      await waitFor(cdp, q("#am-reb-confirmar"));
    });
    await foto(cdp, "rebate-04-confirmacao");
    await check("E2 — Confirmar envia exatamente as escolhas (itemId, promotionId, tipo)", async () => {
      await clicar(cdp, "#am-reb-confirmar");
      await waitFor(cdp, q("[data-reb-exec]"), "passo de execução ausente");
      assert.deepStrictEqual(SERVIDOR.execucoes[0], {
        clienteSlug: "n97", clienteContaId: "42",
        escolhas: [
          { itemId: "MLB-R1", promotionId: "P-1", tipo: "SMART" },
          { itemId: "MLB-R2", promotionId: "P-2", tipo: "MARKETPLACE_CAMPAIGN" },
          { itemId: "MLB-E1", promotionId: "P-3L", tipo: "PRICE_MATCHING" },
        ],
      });
    });
    await check("E3 — Esc no meio da execução não fecha: avisa inline; 'Continuar acompanhando' volta", async () => {
      await waitFor(cdp, `/Gravando no Mercado Livre/.test(${texto(".am-reb-rodape")})`, "não está processando");
      await tecla(cdp, ".am-reb-overlay", "Escape");
      await waitFor(cdp, q("#am-reb-continuar"), "aviso inline ausente");
      assert.ok(await cdp.evaluate(`!!${q(".am-reb-overlay")}`), "fechou no meio da execução");
      assert.match(await cdp.evaluate(texto(".am-reb-rodape")), /continua no Mercado Livre/);
      await clicar(cdp, "#am-reb-continuar");
      await waitFor(cdp, `!${q("#am-reb-continuar")}`);
    });
    await check("E4 — resultado por item (ok/falha com motivo) e 'Tentar de novo as falhas'", async () => {
      await waitFor(cdp, q("#am-reb-retentar"), "botão de retry ausente", 300);
      assert.ok(await cdp.evaluate(`!!document.querySelector('[data-reb-exec-item="MLB-R1"] .vf-status.is-success')`));
      assert.ok(await cdp.evaluate(`!!document.querySelector('[data-reb-exec-item="MLB-R2"] .vf-status.is-danger')`));
      assert.match(await cdp.evaluate(texto('[data-reb-exec-item="MLB-R2"]')), /não está mais disponível/);
      assert.match(await cdp.evaluate(texto(".am-reb-box .vf-banner")), /2 participações confirmadas.*1 falhou/);
      assert.match(await cdp.evaluate(texto("#am-reb-retentar")), /Tentar de novo as falhas \(1\)/);
    });
    await foto(cdp, "rebate-05-resultado");
    await check("E5 — retry reenvia SÓ as falhas e mostra o novo resultado", async () => {
      await clicar(cdp, "#am-reb-retentar");
      await waitFor(cdp, `/1 participação confirmada/.test(${texto(".am-reb-box .vf-banner")})`, "retry não concluiu", 300);
      assert.deepStrictEqual(SERVIDOR.execucoes[1], { clienteSlug: "n97", clienteContaId: "42", escolhas: [{ itemId: "MLB-R2", promotionId: "P-2", tipo: "MARKETPLACE_CAMPAIGN" }] });
      assert.strictEqual(await cdp.evaluate(`!!${q("#am-reb-retentar")}`), false);
      assert.strictEqual(await cdp.evaluate(`document.querySelectorAll("[data-reb-exec-item]").length`), 1);
    });
    await check("W2 — depois da execução, 'Copiar mensagem para o cliente' lista o que entrou em TODAS as rodadas", async () => {
      await cdp.evaluate("window.__copiado = null");
      await clicar(cdp, "#am-reb-copiar-feito");
      await waitFor(cdp, "window.__copiado", "nada foi copiado");
      const msg = await cdp.evaluate("window.__copiado");
      assert.match(msg, /3 anúncios entraram em promoção com rebate/);
      assert.match(msg, /MLB-R1/); assert.match(msg, /MLB-E1/); assert.match(msg, /MLB-R2/);
      assert.match(msg, /Preço: R\$ 99,90 → R\$ 90,00/, "usa o preço confirmado pelo ML");
      assert.match(msg, /Seguimos acompanhando/);
    });
    await check("E6 — Fechar depois da execução recarrega a lista de anúncios", async () => {
      const antes = SERVIDOR.familiasLidas;
      await clicar(cdp, "#am-reb-fechar-final");
      await waitFor(cdp, `!${q(".am-reb-overlay")}`, "não fechou");
      for (let i = 0; i < 60 && SERVIDOR.familiasLidas === antes; i++) await sleep(50);
      assert.ok(SERVIDOR.familiasLidas > antes, "lista não recarregou");
      assert.strictEqual(await cdp.evaluate(`!!window.__confirmNativo || !!window.__alertNativo`), false);
    });

    // ── Lista vazia ──────────────────────────────────────────────────────────
    await check("L1 — conta sem promoções de referência: mensagem clara e Analisar desabilitado", async () => {
      SERVIDOR.referencias = [];
      SERVIDOR.padraoId = null;
      await clicar(cdp, "#am-reb-abrir");
      await waitFor(cdp, `/Nenhuma promoção ativa ou programada/.test(${texto(".am-reb-box")})`, "mensagem de vazio ausente");
      assert.strictEqual(await cdp.evaluate(`${q("#am-reb-analisar")}.disabled`), true);
      await clicar(cdp, "#am-reb-cancelar");
      await waitFor(cdp, `!${q(".am-reb-overlay")}`);
    });

    await check("Z — nenhuma exceção de JavaScript durante os fluxos", async () => {
      assert.deepStrictEqual(excecoes, []);
    });

    console.log(`\n${failures ? "RED" : "GREEN"}: ${checks - failures}/${checks} checks passaram; ${failures} falharam.`);
    if (failures) process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    chrome.kill("SIGTERM");
    server.close();
    await sleep(500);
    try { fs.rmSync(USER_DATA_DIR, { recursive: true, force: true }); } catch (_) { /* Chrome ainda segurando arquivos */ }
  }
}
run().catch((err) => { console.error(err); process.exitCode = 1; });
