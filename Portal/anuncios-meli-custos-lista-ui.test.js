/* Custo do produto na LISTA de Anúncios ML — edição pontual ("+ Custo" /
   "✎ R$ x", Enter grava, Esc cancela, Desfazer) e modo "Editar custos" em
   massa (rascunho, prévia pelo Motor, seleção, salvar em lote, falha parcial,
   pergunta ao sair). Harness e fixtures copiados da lista visual. */
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
const CAPA_FAM1 = "https://http2.mlstatic.com/capa-fam1.jpg";
const IMAGEM_DO_PRIMEIRO_ITEM = "https://http2.mlstatic.com/item-a1.jpg";
const IMAGEM_DO_ITEM_DA_FAM2 = "https://http2.mlstatic.com/item-b9.jpg";








const ESTOQUE_FAM1 = 300;
const LINHAS_CONTA_42 = [
  {
    tipo: "familia", key: "fam:FAM-1", family_id: "FAM-1",
    family_name: "Camiseta Dry Fit Masculina", titulo: "Camiseta Dry Fit Masculina",
    total_user_products: 3, total_itens: 4,
    estoque_total: ESTOQUE_FAM1, vendidos_total: 31,
    preco_min: 89.9, preco_max: 129.9, moeda: "BRL", score_min: 40,
    status_contagem: { ativos: 4, pausados: 0, encerrados: 0 },
    cover: { thumbnail: CAPA_FAM1, user_product_id: "MLBU-200" },
  },
  {
    tipo: "familia", key: "fam:FAM-2", family_id: "FAM-2",
    family_name: "Caneca Térmica 500ml", titulo: "Caneca Térmica 500ml",
    total_user_products: 1, total_itens: 1,
    estoque_total: 12, vendidos_total: 0,
    preco_min: 39.9, preco_max: 39.9, moeda: "BRL", score_min: 80,
    status_contagem: { ativos: 1, pausados: 0, encerrados: 0 },
    cover: { thumbnail: null, user_product_id: "MLBU-300" },
  },




  {
    tipo: "item", key: "item:MLB-SEMUP", item_id: "MLB-SEMUP", family_id: null,
    titulo: "Anúncio legado sem agrupamento", sku: null,
    preco: 49.9, preco_original: 69.9, moeda: "BRL", estoque: 3, vendidos: 1, status: "active",
    permalink: null, thumbnail: null, pictures_count: 1, is_full: false,
    catalog_listing: false, family_name: null, variations_count: 24,
    listing_type_id: "gold_special",
    score_venforce: 40, revisado: false,
    total_itens: 1, total_user_products: 0, estoque_total: 3, vendidos_total: 1,
    cover: { thumbnail: null, user_product_id: null },
    margemProjetadaPercent: 25, margemProjetadaProfit: 12.5, margemProjetadaComputable: true,
    margemProjetadaStatus: "HEALTHY", margemProjetadaCalculadaEm: "2026-09-20T10:00:00Z", margemProjetadaOrigemJob: "manual_cli",
  },
  {
    tipo: "item", key: "item:MLB-SEMVAR", item_id: "MLB-SEMVAR", family_id: null,
    titulo: "Anúncio simples, sem variações no ML", sku: "SKU-SEMVAR",
    preco: 29.9, preco_original: null, moeda: "BRL", estoque: 8, vendidos: 0, status: "active",
    permalink: null, thumbnail: null, pictures_count: 3, is_full: false,
    catalog_listing: false, family_name: null, variations_count: 0,
    score_venforce: 55, revisado: false,
    total_itens: 1, total_user_products: 0, estoque_total: 8, vendidos_total: 0,
    cover: { thumbnail: null, user_product_id: null },
  },
];






function item(id, titulo, up, extra) {
  return Object.assign({
    item_id: id, user_product_id: up, family_id: "FAM-1", titulo: titulo,
    status: "active", preco: 89.9, moeda: "BRL", estoque: 100, vendidos: 5, score_venforce: 62, sku: "SKU-" + id,
    thumbnail: null, permalink: "https://produto.mercadolivre.com.br/" + id,
    listing_type_id: "gold_special",
    pictures_count: 5, is_full: false, revisado: false, catalog_listing: false,

    margemProjetadaPercent: 20, margemProjetadaProfit: 15, margemProjetadaComputable: true,
    margemProjetadaStatus: "HEALTHY", margemProjetadaCalculadaEm: "2026-09-20T10:00:00Z", margemProjetadaOrigemJob: "manual_cli",
  }, extra || {});
}








const NOME_FAM1 = "Camiseta Dry Fit Masculina";
const DETALHE_CONTA_42 = {
  "FAM-1": {
    family_id: "FAM-1", family_name: NOME_FAM1,
    user_products: [








      { user_product_id: "MLBU-100", site_id: "MLB", domain_id: "MLB-T_SHIRTS", total_itens: 2,
        itens: [item("MLB-A1", NOME_FAM1 + " Azul P (12 parcelas)", "MLBU-100",
                  {
                    thumbnail: IMAGEM_DO_PRIMEIRO_ITEM, listing_type_id: "gold_pro",
                    pictures_count: 1, is_full: true, revisado: true, catalog_listing: true,
                    margemProjetadaPercent: -5, margemProjetadaProfit: -10, margemProjetadaStatus: "LOSS",
                  }),
                item("MLB-A2", NOME_FAM1 + " Azul P", "MLBU-100",
                  {
                    listing_type_id: "gold_special",
                    margemProjetadaPercent: null, margemProjetadaProfit: null, margemProjetadaComputable: false,
                    margemProjetadaStatus: "UNVALIDATED", margemProjetadaCalculadaEm: null,
                  })] },
      { user_product_id: "MLBU-200", site_id: "MLB", domain_id: "MLB-T_SHIRTS", total_itens: 1,
        itens: [item("MLB-A3", NOME_FAM1 + " Azul M", "MLBU-200",
          { listing_type_id: "gold_special" })] },
      { user_product_id: "MLBU-300", site_id: "MLB", domain_id: "MLB-T_SHIRTS", total_itens: 1,
        itens: [item("MLB-A4", NOME_FAM1 + " Azul G", "MLBU-300",
          { listing_type_id: "gold_pro" })] },
    ],
  },
  "FAM-2": {
    family_id: "FAM-2", family_name: "Caneca Térmica 500ml",
    user_products: [
      { user_product_id: "MLBU-300C", site_id: "MLB", domain_id: "MLB-MUGS", total_itens: 1,
        itens: [item("MLB-B9", "Caneca Térmica Inox 500ml", "MLBU-300C",
          {
            family_id: "FAM-2", estoque: 12, thumbnail: IMAGEM_DO_ITEM_DA_FAM2,
            margemProjetadaPercent: null, margemProjetadaProfit: null, margemProjetadaComputable: false,
            margemProjetadaStatus: null, margemProjetadaCalculadaEm: null,
          })] },
    ],
  },
};
const METRICAS_FIXTURE = {
  "MLB-SEMUP": { views: 259, vendas: 3, conversao: 1.2 },
  "MLB-A1": { views: null, vendas: 0, conversao: null },
  "MLB-A2": { views: 100, vendas: 0, conversao: 0 },
};


const MARGEM_FIXTURE = {
  "MLB-SEMUP": { origem: "projected", margin: 0.25, marginPercent: 25, status: "HEALTHY", statusLabel: "Saudável", statusReasons: [], precoOriginal: 69.9 },
  "MLB-A1": { origem: "projected", margin: -0.05, marginPercent: -5, status: "LOSS", statusLabel: "Prejuízo", statusReasons: ["Margem negativa (-5.00%)."] },
  "MLB-A2": { origem: "projected", margin: null, marginPercent: null, status: "UNVALIDATED", statusLabel: "Não validado", statusReasons: ["Variáveis obrigatórias ausentes: custo."] },
};

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
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return; } catch (_) {  }
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
let failures = 0;
async function check(name, fn) {
  checks += 1;
  try { await fn(); console.log(`ok ${checks} - ${name}`); }
  catch (err) { failures += 1; console.error(`not ok ${checks} - ${name}: ${err.message}`); }
}

// --- Custo do produto na lista ------------------------------------------------
// Estado do "servidor" falso: custo por MLB na Base, Base vinculada ou não,
// falha forçada num item, e o registro de todo POST que a tela fez.
const SERVIDOR = {
  base: { slug: "base-n97", nome: "Custo" },
  mensagemSemBase: "Cliente sem base MELI vinculada. Ajuste o vínculo em Bases de Custo.",
  custos: { "MLB-SEMUP": 30, "MLB-SEMVAR": null, "MLB-A1": 50, "MLB-A2": null, "MLB-A3": null, "MLB-A4": 22 },
  falhar: {},
  lotes: [],
  simulacoes: [],
  margemLidas: [],
  planilhasBaixadas: [],
  previas: [],
};

// Prévia que o "servidor" devolve para qualquer planilha enviada: uma linha
// de cada ação. Só "atualizar"/"adicionar" podem ir para /custos/lote.
const PREVIA_FIXTURE = {
  ok: true,
  base: { slug: "base-n97", nome: "Base N97" },
  resumo: { atualizar: 1, adicionar: 1, inalterado: 1, recusadas: 1, vazias: 2, anunciosNaConta: 11 },
  linhas: [
    { linha: 2, itemId: "MLB-SEMUP", titulo: "Anúncio sem UP", custoAtual: 30, custo: 33, acao: "atualizar", motivo: null },
    { linha: 3, itemId: "MLB-SEMVAR", titulo: "Anúncio sem variação", custoAtual: null, custo: 15, acao: "adicionar", motivo: null },
    { linha: 4, itemId: "MLB-A3", titulo: "A3", custoAtual: 12, custo: 12, acao: "inalterado", motivo: null },
    { linha: 5, itemId: "MLB999", titulo: null, custoAtual: null, custo: 5, acao: "recusada", motivo: "Anúncio não encontrado nesta conta." },
  ],
};

function wireInterception(cdp, excecoes) {
  cdp.onEvent = async (method, params) => {
    if (method === "Runtime.exceptionThrown") {
      excecoes.push(`${params?.exceptionDetails?.text || ""} ${params?.exceptionDetails?.exception?.description || ""}`.trim());
    }
    if (method !== "Fetch.requestPaused") return;
    const url = params.request.url;
    const requestId = params.requestId;
    if (!url.includes(PROD_HOST)) {
      await cdp.send("Fetch.continueRequest", { requestId }); return;
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
    try { corpo = params.request.postData ? JSON.parse(params.request.postData) : null; } catch (_) { corpo = null; } // multipart
    if (pathname.includes("/me/context")) return respond(ME_CONTEXT);
    if (pathname.includes("/operacao/cliente-360/clientes")) return respond({ ok: true, clientes: [N97] });
    if (/\/clientes\/[^/?]+\/contas/.test(pathname)) return respond({ ok: true, cliente: N97, contas: N97_CONTAS });
    if (pathname === "/anuncios-meli/clientes") return respond({ ok: true, clientes: [{ id: 87, nome: N97.nome, slug: "n97", mlConectado: true, totalAnuncios: 5 }] });
    if (pathname === "/anuncios-meli/resumo") return respond({ ok: true, resumo: { total: 11, ativos: 9, pausados: 2, scoreBaixo: 3, semSku: 1, semCusto: 2, full: 2, ultimaSync: new Date().toISOString() } });
    if (pathname === "/anuncios-meli/custos") {
      if (!SERVIDOR.base) return respond({ ok: true, base: null, motivo: "BASE_MELI_NAO_VINCULADA", mensagem: SERVIDOR.mensagemSemBase, custos: {} });
      const custos = {};
      (u.searchParams.get("itemIds") || "").split(",").filter(Boolean).forEach((id) => {
        custos[id] = SERVIDOR.custos[id] === undefined ? null : SERVIDOR.custos[id];
      });
      return respond({ ok: true, base: SERVIDOR.base, motivo: "OK", mensagem: null, custos });
    }
    if (pathname === "/anuncios-meli/custos/planilha") {
      SERVIDOR.planilhasBaixadas.push(Object.fromEntries(u.searchParams));
      await cdp.send("Fetch.fulfillRequest", {
        requestId, responseCode: 200,
        responseHeaders: [
          ...headers.filter((h) => h.name !== "content-type"),
          { name: "content-type", value: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
          { name: "access-control-expose-headers", value: "content-disposition" },
          { name: "content-disposition", value: 'attachment; filename="custos-anuncios-ml-n97.xlsx"' },
        ],
        body: Buffer.from("PK-fake-xlsx").toString("base64"),
      });
      return;
    }
    if (pathname === "/anuncios-meli/custos/planilha/previa") {
      SERVIDOR.previas.push(Object.fromEntries(u.searchParams));
      return respond(PREVIA_FIXTURE);
    }
    if (pathname === "/anuncios-meli/custos/lote") {
      SERVIDOR.lotes.push(corpo);
      const resultados = corpo.itens.map((it) => {
        if (SERVIDOR.falhar[it.itemId]) {
          return { itemId: it.itemId, ok: false, codigo: "FALHA_GRAVACAO", motivo: "Não foi salvo: a Base recusou a gravação. Tente de novo." };
        }
        const anterior = SERVIDOR.custos[it.itemId] === undefined ? null : SERVIDOR.custos[it.itemId];
        if (it.remover) {
          SERVIDOR.custos[it.itemId] = null;
          return { itemId: it.itemId, ok: true, acao: "removido", custoAnterior: anterior, custo: null };
        }
        SERVIDOR.custos[it.itemId] = it.custo;
        return { itemId: it.itemId, ok: true, acao: anterior == null ? "criado" : "atualizado", custoAnterior: anterior, custo: it.custo };
      });
      return respond({ ok: true, base: SERVIDOR.base, resultados, salvos: resultados.filter((r) => r.ok).length, falhas: resultados.filter((r) => !r.ok).length });
    }
    const sim = pathname.match(/^\/anuncios-meli\/([^/]+)\/simular-margem$/);
    if (sim) {
      SERVIDOR.simulacoes.push({ itemId: decodeURIComponent(sim[1]), corpo });
      // Prévia vem do "Motor": 50% − custo/2, só para o teste enxergar o número.
      const pct = 50 - corpo.custoProduto / 2;
      return respond({ ok: true, simulado: true, resultado: { computable: true, marginPercent: pct, profit: pct, missing: [], assumed: [] } });
    }
    const family = pathname.match(/^\/anuncios-meli\/familias\/([^/]+)/);
    if (family) return respond({ ok: true, cliente: N97, familia: DETALHE_CONTA_42[decodeURIComponent(family[1])] });
    if (pathname === "/anuncios-meli/familias") return respond({ ok: true, cliente: N97, anuncios: LINHAS_CONTA_42, paginacao: { page: 1, limit: 20, total: LINHAS_CONTA_42.length, totalPaginas: 1 } });
    if (pathname === "/anuncios-meli/performance") {
      const qs = u.searchParams;
      const metricas7d = {}, margem = {};
      (qs.get("itemIds") || "").split(",").filter(Boolean).forEach((id) => {
        if (qs.get("incluirMetricas") !== "0") metricas7d[id] = METRICAS_FIXTURE[id] || { views: 10, vendas: 1, conversao: 10 };
        if (qs.get("incluirMargem") !== "0") {
          if (qs.get("incluirMetricas") === "0") SERVIDOR.margemLidas.push(id);
          const custo = SERVIDOR.custos[id];
          // Margem "ao vivo" depende do custo atual: muda quando o custo muda.
          margem[id] = custo == null
            ? { origem: "projected", margin: null, marginPercent: null, status: "UNVALIDATED", statusLabel: "Não validado", statusReasons: [] }
            : { origem: "projected", margin: 0.4 - custo / 200, marginPercent: 40 - custo / 2, status: "HEALTHY", statusLabel: "Saudável", statusReasons: [] };
        }
      });
      return respond({ ok: true, metricas7d, margem, margemIndisponivel: null, faturamento: null, unidadesVendidas: null, curvaAbc: null, margemPorFamilia: null });
    }
    await cdp.send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" });
  };
}

const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const custoCel = (id) => q(`.am-margem[data-margem-item="${id}"] .am-custo`);
const texto = (sel) => `((${q(sel)} || {}).textContent || "").replace(/\\s+/g, " ").trim()`;

async function digitar(cdp, seletor, valor) {
  await cdp.evaluate(`(() => {
    const i = ${q(seletor)};
    i.focus();
    i.value = ${JSON.stringify(valor)};
    i.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
}

async function tecla(cdp, seletor, key) {
  await cdp.evaluate(`${q(seletor)}.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }))`);
}

// VF_SHOTS=<pasta> grava PNGs dos estados principais (conferência visual).
async function foto(cdp, nome) {
  if (!process.env.VF_SHOTS) return;
  const r = await cdp.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(process.env.VF_SHOTS, nome + ".png"), Buffer.from(r.data, "base64"));
}

async function abrirPagina(cdp, porta) {
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${porta}/anuncios-meli.html?cliente=n97&conta=42` });
  await waitFor(cdp, "document.querySelector('.am-row--grupo[data-familia=\"FAM-1\"]') && document.querySelector('.am-row[data-item]')", "Lista não renderizou");
}

async function run() {
  const server = await startServer();
  const porta = server.address().port;
  const debugPort = 24000 + Math.floor(Math.random() * 900);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--window-size=1600,900", `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=/tmp/vf-custos-lista-${process.pid}`, "about:blank",
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

    // ── Leitura ────────────────────────────────────────────────────────────
    await check("C1 — MLB sem custo mostra '+ Custo'; com custo mostra o valor da Base", async () => {
      await waitFor(cdp, `${custoCel("MLB-SEMVAR")} && ${custoCel("MLB-SEMVAR")}.querySelector(".am-custo__add")`, "+ Custo não apareceu");
      assert.match(await cdp.evaluate(texto('.am-margem[data-margem-item="MLB-SEMUP"] .am-custo__btn')), /R\$ 30,00/);
    });
    await check("C2 — barra mostra 'Editar custos' e a contagem sem custo da página", async () => {
      await waitFor(cdp, q('[data-custos-acao="entrar"]'), "botão Editar custos ausente");
      assert.match(await cdp.evaluate(texto(".am-custos-acoes")), /1 sem custo nesta página/);
    });

    // ── Pontual ────────────────────────────────────────────────────────────
    await check("C3 — '+ Custo' abre o campo na célula sem abrir o modal", async () => {
      await cdp.evaluate(`${custoCel("MLB-SEMVAR")}.querySelector(".am-custo__add").click()`);
      await waitFor(cdp, q('[data-custo-inline="MLB-SEMVAR"]'), "campo inline não abriu");
      assert.strictEqual(await cdp.evaluate(`!!document.getElementById("am-det-modal")`), false);
      assert.strictEqual(await cdp.evaluate(`document.activeElement === ${q('[data-custo-inline="MLB-SEMVAR"]')}`), true);
    });
    await foto(cdp, "01-inline-aberto");
    await check("C4 — Enter grava na Base pelo lote (cliente + conta, sem slug de base) e não abre o modal", async () => {
      await digitar(cdp, '[data-custo-inline="MLB-SEMVAR"]', "12,5");
      await tecla(cdp, '[data-custo-inline="MLB-SEMVAR"]', "Enter");
      await waitFor(cdp, `/R\\$ 12,50/.test(${texto('.am-margem[data-margem-item="MLB-SEMVAR"] .am-custo')})`, "custo salvo não apareceu");
      assert.deepStrictEqual(SERVIDOR.lotes[0], { clienteSlug: "n97", itens: [{ itemId: "MLB-SEMVAR", custo: 12.5 }], clienteContaId: "42" });
      assert.strictEqual(await cdp.evaluate(`!!document.getElementById("am-det-modal")`), false);
    });
    await foto(cdp, "02-inline-salvo");
    await check("C5 — depois de gravar, a margem do MLB é relida AO VIVO no Motor", async () => {
      await waitFor(cdp, `/33,8%|33,75%/.test(${texto('.am-margem[data-margem-item="MLB-SEMVAR"]')})`, "margem ao vivo não pintou");
      assert.ok(SERVIDOR.margemLidas.includes("MLB-SEMVAR"));
    });
    await check("C6 — toast com 'Desfazer' remove o custo recém-criado (a Base volta a não ter)", async () => {
      await waitFor(cdp, q(".am-toast-acao__btn"), "toast com Desfazer ausente");
      await cdp.evaluate(`${q(".am-toast-acao__btn")}.click()`);
      await waitFor(cdp, `${custoCel("MLB-SEMVAR")}.querySelector(".am-custo__add")`, "não voltou para + Custo");
      assert.deepStrictEqual(SERVIDOR.lotes[1].itens, [{ itemId: "MLB-SEMVAR", remover: true }]);
    });
    await check("C7 — Esc cancela sem gravar; não pula para o próximo anúncio", async () => {
      const antes = SERVIDOR.lotes.length;
      await cdp.evaluate(`${q('.am-margem[data-margem-item="MLB-SEMUP"] .am-custo__btn')}.click()`);
      await waitFor(cdp, q('[data-custo-inline="MLB-SEMUP"]'), "campo não abriu");
      await digitar(cdp, '[data-custo-inline="MLB-SEMUP"]', "99");
      await tecla(cdp, '[data-custo-inline="MLB-SEMUP"]', "Escape");
      await waitFor(cdp, `!${q('[data-custo-inline="MLB-SEMUP"]')}`, "campo não fechou");
      assert.strictEqual(SERVIDOR.lotes.length, antes);
      assert.match(await cdp.evaluate(texto('.am-margem[data-margem-item="MLB-SEMUP"] .am-custo')), /R\$ 30,00/);
      assert.strictEqual(await cdp.evaluate(`document.querySelectorAll("[data-custo-inline]").length`), 0);
      assert.strictEqual(await cdp.evaluate(`!!document.getElementById("am-det-modal")`), false);
    });
    await check("C8 — custo editado (com valor anterior) e Desfazer restaura o valor anterior", async () => {
      await cdp.evaluate(`${q('.am-margem[data-margem-item="MLB-SEMUP"] .am-custo__btn')}.click()`);
      await digitar(cdp, '[data-custo-inline="MLB-SEMUP"]', "35");
      await tecla(cdp, '[data-custo-inline="MLB-SEMUP"]', "Enter");
      await waitFor(cdp, `/R\\$ 35,00/.test(${texto('.am-margem[data-margem-item="MLB-SEMUP"] .am-custo')})`, "35 não apareceu");
      await waitFor(cdp, q(".am-toast-acao__btn"), "toast ausente");
      await cdp.evaluate(`Array.from(document.querySelectorAll(".am-toast-acao__btn")).pop().click()`);
      await waitFor(cdp, `/R\\$ 30,00/.test(${texto('.am-margem[data-margem-item="MLB-SEMUP"] .am-custo')})`, "não restaurou 30");
      assert.deepStrictEqual(SERVIDOR.lotes[SERVIDOR.lotes.length - 1].itens, [{ itemId: "MLB-SEMUP", custo: 30 }]);
    });

    // ── Massa ──────────────────────────────────────────────────────────────
    await check("M1 — 'Editar custos' liga o modo: faixa, campos por MLB e checkbox; família expandida também", async () => {
      await cdp.evaluate(`document.querySelector('.am-row--grupo[data-familia="FAM-1"]').click()`);
      await waitFor(cdp, "document.querySelectorAll('.am-mlb').length === 4 && document.querySelector('.am-mlb .am-custo__btn, .am-mlb .am-custo__add')", "FAM-1 não expandiu com custos");
      await cdp.evaluate(`${q('[data-custos-acao="entrar"]')}.click()`);
      await waitFor(cdp, q(".am-custos-modo"), "faixa do modo ausente");
      const n = await cdp.evaluate(`document.querySelectorAll("[data-custo-massa]").length`);
      assert.strictEqual(n, 6, "2 avulsos + 4 MLB da família");
      assert.strictEqual(await cdp.evaluate(`document.querySelectorAll("[data-custo-sel]").length`), 6);
      assert.strictEqual(await cdp.evaluate(`${q(".am-listagem")}.classList.contains("is-modo-custos")`), true);
    });
    await foto(cdp, "03-modo-massa");
    await check("M2 — valor inválido não deixa salvar; valor válido vira prévia do Motor (simular-margem)", async () => {
      await digitar(cdp, '[data-custo-massa="MLB-SEMVAR"]', "abc");
      await waitFor(cdp, `${q(".am-custos-savebar")}.classList.contains("is-on") === false || /Corrija/.test(${texto(".am-custos-savebar")}) || true`);
      assert.match(await cdp.evaluate(texto('.am-margem[data-margem-item="MLB-SEMVAR"]')), /maior que zero/);
      await digitar(cdp, '[data-custo-massa="MLB-SEMVAR"]', "20");
      await waitFor(cdp, `/prévia/.test(${texto('.am-margem[data-margem-item="MLB-SEMVAR"]')})`, "prévia não apareceu");
      assert.match(await cdp.evaluate(texto('.am-margem[data-margem-item="MLB-SEMVAR"]')), /40,0%/);
      const s = SERVIDOR.simulacoes.find((x) => x.itemId === "MLB-SEMVAR");
      assert.ok(s && s.corpo.custoProduto === 20 && s.corpo.clienteContaId === "42");
      assert.strictEqual(await cdp.evaluate(`document.activeElement === ${q('[data-custo-massa="MLB-SEMVAR"]')}`), true, "o campo não perde o foco");
      assert.match(await cdp.evaluate(texto(".am-custos-savebar")), /Salvar 1 custo/);
    });
    await foto(cdp, "04-previa");
    await check("M3 — nada é gravado antes de 'Salvar'", async () => {
      assert.strictEqual(SERVIDOR.lotes.length, 4);
    });
    await check("M4 — Enter desce para o próximo campo (só no modo massa)", async () => {
      const ordem = await cdp.evaluate(`Array.from(document.querySelectorAll("[data-custo-massa]")).map(i => i.getAttribute("data-custo-massa"))`);
      const atual = ordem.indexOf("MLB-SEMVAR");
      await tecla(cdp, '[data-custo-massa="MLB-SEMVAR"]', "Enter");
      assert.strictEqual(await cdp.evaluate(`document.activeElement && document.activeElement.getAttribute("data-custo-massa")`), ordem[atual + 1] || "MLB-SEMVAR");
      assert.strictEqual(await cdp.evaluate(`!!document.getElementById("am-det-modal")`), false);
    });
    await check("M5 — seleção + 'Aplicar aos selecionados' preenche os rascunhos e avisa sobrescrita", async () => {
      for (const id of ["MLB-A2", "MLB-A4"]) {
        await cdp.evaluate(`(() => { const c = ${q(`[data-custo-sel="${id}"]`)}; c.click(); })()`);
      }
      await waitFor(cdp, q(".am-custos-sel"), "barra de seleção ausente");
      assert.match(await cdp.evaluate(texto(".am-custos-sel")), /2 selecionados/);
      assert.match(await cdp.evaluate(texto(".am-custos-sel")), /1 deles já tem custo e será sobrescrito/);
      await digitar(cdp, "#am-custos-lote", "7");
      await cdp.evaluate(`${q('[data-custos-acao="aplicar"]')}.click()`);
      await waitFor(cdp, `${q('[data-custo-massa="MLB-A2"]')}.value === "7,00" && ${q('[data-custo-massa="MLB-A4"]')}.value === "7,00"`, "rascunhos não aplicados");
      assert.match(await cdp.evaluate(texto(".am-custos-savebar")), /3 custos alterados/);
      assert.strictEqual(await cdp.evaluate(`!!${q(".am-custos-sel")}`), false, "seleção limpa depois de aplicar");
      assert.strictEqual(await cdp.evaluate(`!!document.getElementById("am-det-modal")`), false);
    });
    await foto(cdp, "05-selecao-aplicada");
    await check("M6 — 'Salvar' grava em lote; falha parcial pinta só a linha que falhou", async () => {
      SERVIDOR.falhar["MLB-A4"] = true;
      await cdp.evaluate(`${q('[data-custos-acao="salvar"]')}.click()`);
      await waitFor(cdp, `/não foi salvo/.test(${texto(".am-custos-savebar")})`, "savebar não reportou a falha");
      const lote = SERVIDOR.lotes[SERVIDOR.lotes.length - 1];
      assert.deepStrictEqual(lote.itens.map((i) => i.itemId).sort(), ["MLB-A2", "MLB-A4", "MLB-SEMVAR"]);
      assert.ok(!("baseSlug" in lote), "o front nunca informa a Base");
      assert.strictEqual(await cdp.evaluate(`${q('.am-mlb[data-item="MLB-A4"]')}.classList.contains("is-custo-erro")`), true);
      assert.match(await cdp.evaluate(texto('.am-margem[data-margem-item="MLB-SEMVAR"]')), /atual R\$ 20,00/);
      assert.match(await cdp.evaluate(texto('.am-margem[data-margem-item="MLB-A4"]')), /Tentar de novo/);
    });
    await foto(cdp, "06-falha-parcial");
    await check("M7 — 'Tentar de novo' regrava só o que falhou", async () => {
      delete SERVIDOR.falhar["MLB-A4"];
      await cdp.evaluate(`${q('[data-custo-retry="MLB-A4"]')}.click()`);
      await waitFor(cdp, `/atual R\\$ 7,00/.test(${texto('.am-margem[data-margem-item="MLB-A4"]')})`, "retry não gravou");
      assert.deepStrictEqual(SERVIDOR.lotes[SERVIDOR.lotes.length - 1].itens, [{ itemId: "MLB-A4", custo: 7 }]);
      assert.strictEqual(await cdp.evaluate(`${q('.am-mlb[data-item="MLB-A4"]')}.classList.contains("is-custo-erro")`), false);
    });
    await check("M8 — 'Só sem custo' esconde os MLB que já têm custo", async () => {
      await cdp.evaluate(`(() => { const c = document.getElementById("am-custos-so-sem"); c.click(); })()`);
      const visiveis = await cdp.evaluate(`Array.from(document.querySelectorAll("[data-custo-massa]")).filter(i => i.offsetParent !== null).map(i => i.getAttribute("data-custo-massa")).sort()`);
      assert.deepStrictEqual(visiveis, ["MLB-A3"]);
      await cdp.evaluate(`document.getElementById("am-custos-so-sem").click()`);
    });
    await check("M9 — 'Sair' com pendência pergunta na barra; 'Descartar' sai sem gravar", async () => {
      const antes = SERVIDOR.lotes.length;
      await digitar(cdp, '[data-custo-massa="MLB-A3"]', "9");
      await cdp.evaluate(`${q('[data-custos-acao="sair"]')}.click()`);
      await waitFor(cdp, `/antes de sair da edição/.test(${texto(".am-custos-savebar")})`, "pergunta não apareceu");
      assert.strictEqual(await cdp.evaluate(`!!${q(".am-custos-modo")}`), true, "ainda no modo enquanto pergunta");
      await cdp.evaluate(`${q('[data-custos-acao="descartar-continuar"]')}.click()`);
      await waitFor(cdp, `!${q(".am-custos-modo")} && !document.querySelector("[data-custo-massa]")`, "não saiu do modo");
      assert.strictEqual(SERVIDOR.lotes.length, antes);
      assert.strictEqual(await cdp.evaluate(`${q(".am-custos-savebar")}.classList.contains("is-on")`), false);
      assert.strictEqual(await cdp.evaluate(`document.querySelectorAll(".am-custo-sel").length`), 0);
    });
    await foto(cdp, "07-pergunta-sair-ok");
    await check("M10 — fora do modo, o clique na linha volta a abrir o modal normalmente", async () => {
      await cdp.evaluate(`${q('.am-row[data-item="MLB-SEMVAR"] .am-row__titulo')}.click()`);
      await waitFor(cdp, `document.getElementById("am-det-modal")`, "modal não abriu");
      await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
      await waitFor(cdp, `!document.getElementById("am-det-modal") || document.getElementById("am-det-modal").hidden`, "modal não fechou");
    });

    // ── Importar base de custo ───────────────────────────────────────────────
    await check("I1 — 'Importar base de custo' abre o modal com os 3 passos", async () => {
      await waitFor(cdp, q('[data-custos-acao="importar"]'), "botão importar ausente");
      await cdp.evaluate(`${q('[data-custos-acao="importar"]')}.click()`);
      await waitFor(cdp, q(".am-imp-box"), "modal de importação não abriu");
      assert.match(await cdp.evaluate(texto(".am-imp-box")), /Base de custos Custo com uma planilha/);
      assert.strictEqual(await cdp.evaluate(`document.querySelectorAll(".am-imp-passo").length`), 3);
      assert.strictEqual(await cdp.evaluate(`${q('[data-imp-acao="gravar"]')}.disabled`), true, "nada a gravar antes da prévia");
    });
    await check("I2 — 'Baixar XLSX' pede a planilha da conta (cliente + conta)", async () => {
      await cdp.evaluate(`${q('[data-imp-acao="baixar"]')}.click()`);
      await waitFor(cdp, `${q('[data-imp-acao="baixar"]')} && !${q('[data-imp-acao="baixar"]')}.disabled`, "download não terminou");
      assert.strictEqual(SERVIDOR.planilhasBaixadas.length, 1);
      assert.strictEqual(SERVIDOR.planilhasBaixadas[0].clienteSlug, "n97");
      assert.ok(SERVIDOR.planilhasBaixadas[0].clienteContaId, "conta vai junto");
      assert.strictEqual(await cdp.evaluate(`!!${q(".am-imp-box .vf-banner.is-danger")}`), false);
    });
    await check("I3 — enviar a planilha mostra a prévia e não grava nada", async () => {
      const antes = SERVIDOR.lotes.length;
      const arquivo = path.join(os.tmpdir(), "vf-imp-custos-teste.xlsx");
      fs.writeFileSync(arquivo, "PK-fake-xlsx");
      const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#am-imp-arquivo" });
      await cdp.send("DOM.setFileInputFiles", { nodeId, files: [arquivo] });
      await waitFor(cdp, q("[data-imp-resumo]"), "prévia não apareceu");
      assert.strictEqual(SERVIDOR.previas.length, 1);
      assert.strictEqual(SERVIDOR.previas[0].clienteSlug, "n97");
      const resumo = await cdp.evaluate(texto("[data-imp-resumo]"));
      assert.match(resumo, /1 para atualizar/);
      assert.match(resumo, /1 para adicionar/);
      assert.match(resumo, /1 recusadas/);
      assert.strictEqual(await cdp.evaluate(`document.querySelectorAll(".am-imp-tabela tbody tr").length`), 2);
      assert.match(await cdp.evaluate(texto(".am-imp-recusadas")), /MLB999/);
      assert.match(await cdp.evaluate(texto('[data-imp-acao="gravar"]')), /Gravar 2 custos/);
      assert.strictEqual(SERVIDOR.lotes.length, antes, "prévia nunca grava");
    });
    await foto(cdp, "07a-importar-previa");
    await check("I4 — 'Gravar' manda só atualizar/adicionar pelo /custos/lote e repinta a lista", async () => {
      const antes = SERVIDOR.lotes.length;
      await cdp.evaluate(`${q('[data-imp-acao="gravar"]')}.click()`);
      await waitFor(cdp, `/2 custos gravados/.test(${texto(".am-imp-box")})`, "resultado não apareceu");
      assert.strictEqual(SERVIDOR.lotes.length, antes + 1);
      const lote = SERVIDOR.lotes[SERVIDOR.lotes.length - 1];
      assert.strictEqual(lote.clienteSlug, "n97");
      assert.deepStrictEqual(lote.itens, [{ itemId: "MLB-SEMUP", custo: 33 }, { itemId: "MLB-SEMVAR", custo: 15 }]);
      await cdp.evaluate(`${q('.am-imp-box [data-imp-acao="fechar"]')}.click()`);
      await waitFor(cdp, `!${q(".am-imp-overlay")}`, "modal não fechou");
      await waitFor(cdp, `${texto('.am-margem[data-margem-item="MLB-SEMVAR"] .am-custo')}.includes("R$ 15,00")`, "célula não repintou");
      assert.match(await cdp.evaluate(texto('.am-margem[data-margem-item="MLB-SEMUP"] .am-custo')), /R\$ 33,00/);
      assert.strictEqual(await cdp.evaluate(`document.body.classList.contains("vf-no-scroll")`), false);
    });
    await foto(cdp, "07b-importar-base-custo");

    // ── Expandir agrupadores ─────────────────────────────────────────────────
    await check("X1 — 'Expandir todos' no cabeçalho abre todas as famílias; depois vira 'Recolher todos' e fecha todas", async () => {
      const grupos = `Array.from(document.querySelectorAll("#am-catalogo-container .am-row--grupo[data-familia]"))`;
      assert.ok(await cdp.evaluate(`${grupos}.length >= 2`), "a página do teste tem 2 famílias");
      // O botão não pode mudar a contagem de colunas do cabeçalho: os testes
      // de alinhamento leem ".am-listagem__head span" por posição.
      assert.strictEqual(await cdp.evaluate(`document.querySelectorAll(".am-listagem__head span").length`), 11);
      assert.strictEqual(await cdp.evaluate(`document.querySelectorAll(".am-listagem__head > span").length`), 11);
      assert.ok(await cdp.evaluate(`!!document.querySelector(".am-listagem__head-anuncio #am-expandir-todos")`), "botão fica ao lado de 'Anúncio'");
      assert.strictEqual(await cdp.evaluate(`document.getElementById("am-expandir-todos").hidden`), false);
      // Começa com tudo recolhido (checks anteriores podem ter aberto famílias).
      for (let i = 0; i < 2 && await cdp.evaluate(`${grupos}.some(g => g.getAttribute("aria-expanded") === "true")`); i += 1) {
        await cdp.evaluate(`document.getElementById("am-expandir-todos").click()`);
      }
      await cdp.evaluate(`document.querySelector('.am-row--grupo[data-familia="FAM-1"]').click()`); // uma aberta, outra fechada
      assert.strictEqual(await cdp.evaluate(texto("#am-expandir-todos")), "Expandir todos");
      await cdp.evaluate(`document.getElementById("am-expandir-todos").click()`);
      await waitFor(cdp, `${grupos}.every(g => g.getAttribute("aria-expanded") === "true" && !g.nextElementSibling.hidden)`, "nem todas abriram");
      assert.strictEqual(await cdp.evaluate(texto("#am-expandir-todos")), "Recolher todos");
      assert.strictEqual(await cdp.evaluate(`!!document.getElementById("am-det-modal")`), false);
      await cdp.evaluate(`document.getElementById("am-expandir-todos").click()`);
      assert.strictEqual(await cdp.evaluate(`${grupos}.every(g => g.getAttribute("aria-expanded") === "false" && g.nextElementSibling.hidden)`), true);
      assert.strictEqual(await cdp.evaluate(texto("#am-expandir-todos")), "Expandir todos");
    });

    // ── Sem Base ───────────────────────────────────────────────────────────
    await check("B1 — sem Base vinculada: aviso com 'Vincular base', sem '+ Custo' nem 'Editar custos'", async () => {
      SERVIDOR.base = null;
      await abrirPagina(cdp, porta);
      await waitFor(cdp, q(".am-custos-aviso"), "aviso sem base ausente");
      assert.match(await cdp.evaluate(texto(".am-custos-aviso")), /sem base MELI vinculada/i);
      assert.strictEqual(await cdp.evaluate(`${q(".am-custos-aviso a")}.getAttribute("href")`), "bases.html");
      assert.strictEqual(await cdp.evaluate(`document.querySelectorAll(".am-custo__add, .am-custo__btn, [data-custos-acao='entrar'], [data-custos-acao='importar']").length`), 0);
    });

    await foto(cdp, "08-sem-base");
    await check("Z — nenhuma exceção de JavaScript durante os fluxos", async () => {
      assert.deepStrictEqual(excecoes, []);
    });

    console.log(`\n${failures ? "RED" : "GREEN"}: ${checks - failures}/${checks} checks passaram; ${failures} falharam.`);
    if (failures) process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    chrome.kill("SIGTERM");
    server.close();
  }
}
run().catch((err) => { console.error(err); process.exitCode = 1; });
