/*
 * Smoke test de interface da Central de Margem em MODO LEITURA PERSISTIDA
 * (Margin Snapshot), em Chrome headless, sem dependências externas.
 *
 * Mesmo harness de central-margem-ui.test.js: servidor estático de Portal/ +
 * Shell V3 com a rede de produção interceptada via CDP (nunca toca a rede
 * real). O client da Central é mockado em window.__VF_CENTRAL_MARGEM_API_CLIENT__
 * com os métodos de snapshot servindo 5.000 itens por conta, PAGINADOS no
 * "servidor" e normalizados pelo normalizador REAL
 * (VFCentralMargemApi.normalizeSnapshotItens/normalizeSnapshotResumo).
 *
 * Prova: nenhuma chamada ao workspace ao vivo; paginação/busca/filtro no
 * servidor; nunca mais que 1 página no browser; refresh não congela a tela
 * e mantém a leitura anterior visível; progresso processados/total; polling
 * para no estado terminal; falha não zera dados; troca de conta troca o
 * dataset e mata o polling antigo; estado missing explícito.
 */
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORTAL_DIR = __dirname;

function startStaticServer() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const relative = pathname === "/" ? "central-margem.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(PORTAL_DIR, relative);
    if (!target.startsWith(path.resolve(PORTAL_DIR) + path.sep)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(target, (error, contents) => {
      if (error) {
        response.writeHead(404).end("not found");
        return;
      }
      const ext = path.extname(target);
      const contentTypes = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
      response.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream", "Cache-Control": "no-store" });
      response.end(contents);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitChrome(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch (_) { /* aguardando */ }
    await sleep(50);
  }
  throw new Error("Chrome DevTools não iniciou.");
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.onEvent = null;
  }

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
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      if (message.method && this.onEvent) this.onEvent(message.method, message.params);
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
  for (let attempt = 0; attempt < 160; attempt += 1) {
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

// Mock do client injetado no browser. Dataset gerado lá (5.000 itens por
// conta) para não serializar megabytes pelo CDP.
const MOCK_CLIENT = `
  (function () {
    var TOTAL = 5000;
    var STATUS = ["HEALTHY", "LOW_MARGIN", "LOSS", "UNVALIDATED", "SUSPECT_DATA"];
    var MARGEM = [0.2, 0.05, -0.1, null, 0.15];
    function ev(source, value, quality) {
      return { source: source, kind: "PROJECTED", value: value, quality: quality || "MEASURED", observedAt: "2026-09-27T10:00:00Z", note: null };
    }
    function field(e) {
      return { present: !!e, selectedValue: e ? e.value : null, selectedSource: e ? e.source : null, selectedKind: e ? "PROJECTED" : null,
        projected: e, realized: null, evidences: e ? [e] : [], divergences: [], hasConflict: false, hasDrift: false };
    }
    function rawItem(conta, i) {
      var status = STATUS[i % 5];
      var margin = MARGEM[i % 5];
      var custo = 40;
      // Item de custo acima do preço: o backend manda a margem como FRAÇÃO
      // (−1,1309 = −113,09%); o custo é o que fecha a conta na Composição
      // (100 − 10 − 12 − 20 − 171,09 = −113,09 sobre preço 100).
      if (i === 12) { margin = -1.1309; custo = 171.09; }
      // Anúncio em promoção com retorno ML de R$ 3,30: o backend já soma o
      // retorno à margem atual (100 + 3,30 − 10 − 12 − 20 − 40 = 21,30 → 21,3%).
      var rebate = null;
      if (i === 15) { margin = 0.213; rebate = 3.3; }
      return {
        itemId: "C" + conta + "-MLB" + (100000 + i), title: "Produto " + i + " da conta " + conta, titulo: "Produto " + i + " da conta " + conta,
        sku: skuDe(i), status: status, confidence: "HIGH", marketplace: "meli", targetMargin: 0.1,
        fields: {
          price: field(ev("MELI_API", 100)), cost: field(status === "UNVALIDATED" ? null : ev("VENFORCE_BASE", custo, "DECLARED")),
          taxRate: field(ev("VENFORCE_BASE", 0.1, "DECLARED")), fixedFee: field(ev("VENFORCE_BASE", 0, "DECLARED")),
          commission: field(ev("MELI_API", 12)), commissionRate: field(ev("MELI_API", 0.12)), freight: field(ev("MELI_API", 20)),
        },
        projected: { margin: margin, profit: margin === null ? null : margin * 100, estimated: false, rebate: rebate },
        realized: { margin: null, profit: null, pending: true },
        quality: { confidence: "HIGH", confidenceByField: {}, reasons: [], divergences: [], statusReasons: ["status " + status] },
        diagnostico: { statusAnuncio: statusAnuncioDe(i) },
        snapshot: { refreshStatus: i === 3 ? "failed" : "fresh", lastError: i === 3 ? "ML 503" : null, calculatedAt: "2026-09-27T10:00:00Z" },
        statusBase: "projected",
        realizado_motivo: window.__cmRealizadoFalha ? "CENTRAL_VENDAS_FALHOU" : null,
        sales: vendasDe(i), settlement: { available: false },
        projectedVsRealized: comparacaoDe(i, margin),
      };
    }
    // i%5===0 vendeu (comparável), i%5===2 vendeu sem custo histórico,
    // demais sem venda no período — o backend manda o bloco pronto.
    function vendasDe(i) {
      if (i % 5 === 0) return { hasOrders: true, unidades: 73, pedidos: 62, receita: 7037.2, precoMedio: 96.4,
        cobertura: { frete: { linhas: 20, linhasComValor: 17, unidades: 73, unidadesComValor: 61, fracao: 0.8356, completa: false, linhasRateadas: 1 } },
        reembolso: null, resultadoPersistido: 800, resultadoRecalculado: 796.43 };
      if (i % 5 === 2) return { hasOrders: true, unidades: 2, pedidos: 2, receita: 180, precoMedio: 90, cobertura: null, reembolso: null, resultadoPersistido: null, resultadoRecalculado: null };
      return { hasOrders: false };
    }
    function comparacaoDe(i, margin) {
      var projetado = { price: 100, commission: 12, freight: 20, cost: 40, taxRate: 0.1, fixedFee: 0, profit: margin === null ? null : margin * 100, margin: margin, marginPercent: margin === null ? null : margin * 100, computable: margin !== null, assumed: [] };
      if (i % 5 === 0) {
        return { status: "COMPARABLE", projected: projetado,
          realized: { available: true, price: 96.4, commission: 12.5, freight: 23.3, cost: 40, taxRate: 0.1, fixedFee: null, profit: 16.2, margin: 0.168, marginPercent: 16.8, computable: true, assumed: ["fixedFee"], missing: [], units: 73, orders: 62, revenue: 7037.2, lastSaleAt: "2026-09-20", totalProfit: 1182.6, coverage: vendasDe(i).cobertura },
          drift: { price: -3.6, commission: 0.5, freight: 3.3, cost: 0, taxRate: 0, taxRatePp: 0, fixedFee: null, profit: -3.8, marginPercentagePoints: -3.2 },
          notComparable: [{ field: "fixedFee", reason: "SEM_HISTORICO", projectedValue: 0 }] };
      }
      if (i % 5 === 2) {
        return { status: "REALIZED_NOT_COMPUTABLE", projected: projetado,
          realized: { available: true, price: 90, commission: null, freight: null, cost: null, taxRate: null, fixedFee: null, profit: null, margin: null, marginPercent: null, computable: false, assumed: [], missing: ["cost"], units: 2, orders: 2, revenue: 180, lastSaleAt: "2026-09-10", totalProfit: null, coverage: null },
          drift: { price: -10, commission: null, freight: null, cost: null, taxRate: null, taxRatePp: null, fixedFee: null, profit: null, marginPercentagePoints: null }, notComparable: [] };
      }
      return { status: "NO_SALES", projected: projetado, realized: { available: false, units: null }, drift: null, notComparable: [] };
    }
    function realizadoDe(conta, periodo) {
      // Central de Vendas fora do ar: o backend manda realizado null + motivo e KPIs null.
      if (window.__cmRealizadoFalha) {
        return window.VFCentralMargemApi.normalizeSnapshotRealizado({
          ok: true, habilitado: true, realizado: null, realizado_motivo: "CENTRAL_VENDAS_FALHOU",
          realizado_mensagem: "A leitura de vendas da Central de Vendas falhou para este período. O realizado está indisponível — nenhum valor foi zerado.",
          periodo: { dateFrom: "2026-07-01", dateTo: "2026-07-27", modo: "mes", periodo: periodo, rotulo: "mês " + periodo },
          cobertura: null, freshness: { estado: "INDISPONIVEL", sincronizadoAte: null, syncEmAndamento: false, syncAtivo: null }, kpis: null,
        });
      }
      return window.VFCentralMargemApi.normalizeSnapshotRealizado({
        ok: true, habilitado: true,
        periodo: periodo
          ? { dateFrom: periodo + "-01", dateTo: periodo + "-27", modo: "mes", periodo: periodo, rotulo: "mês " + periodo }
          : { dateFrom: "2026-08-29", dateTo: "2026-09-27", modo: "ultimos30", periodo: null, rotulo: "Últimos 30 dias (até 27/09/2026)" },
        cobertura: { estado: "PARCIAL", origem: "published", sincronizadoAte: "2026-09-27", ultimaPublicacaoEm: "2026-09-28T06:10:00.000Z", meses: 2, mesesComImport: 1,
          lacunas: [{ competencia: "2026-09", segmento: { dateFrom: "2026-09-01", dateTo: "2026-09-28" }, motivo: "COBERTURA_INSUFICIENTE", publicadoDe: "2026-09-01", publicadoAte: "2026-09-27", publicadoEm: "2026-09-28T06:10:00.000Z" }] },
        freshness: { estado: "PARCIAL", sincronizadoAte: "2026-09-27", ultimaPublicacaoEm: "2026-09-28T06:10:00.000Z", syncEmAndamento: false, syncAtivo: null },
        kpis: { receita: Number(conta) * 1000, receitaSemMlb: 0, unidades: 14, pedidos: 4, produtosComVenda: 3, lucro: { valor: 410, produtos: 2 },
          margem: { percent: 37.27, estado: "parcial", coberturaReceita: 0.9016, produtosCalculaveis: 2, produtosSemMargem: 1, produtosEstimados: 1, semMargemPorMotivo: { cost: 1 } },
          drift: { disponivel: true, pp: -4.55, margemRealizadaMixPercent: 37.27, margemProjetadaMixPercent: 41.82, produtosComparados: 2, limitePp: 2, produtosNegativos: 1, piores: [{ itemId: "MLB1", titulo: "Produto 0", driftPp: -5 }] } },
      });
    }
    function statusDe(i) { return STATUS[i % 5]; }
    function skuDe(i) { return i === 3 ? "SKU-NULL-STATUS" : i === 4 ? "SKU-UNKNOWN-STATUS" : "SKU-" + i; }
    function statusAnuncioDe(i) {
      if (i === 3) return null;
      if (i === 4) return "under_review";
      return i % 4 === 0 ? "paused" : "active";
    }

    window.__cmCalls = { workspace: 0, resumo: [], itens: [], refresh: [], status: [], realizado: [] };
    window.__cmHoldRealizado = null;
    window.__cmResolveRealizado = null;
    window.__cmItemsRecebidos = 0;
    window.__cmMissing = { "901": true };
    window.__cmRuns = {};            // conta -> run
    window.__cmOutcome = "completed"; // completed | failed | slow
    window.__cmHoldResumoSemConta = sessionStorage.getItem("cmSkipHoldSemConta") !== "1";
    window.__cmResolveResumoSemConta = null;
    window.__cmHoldResumoConta = null;
    window.__cmResolveResumoConta = null;

    function runPublico(run) {
      return run ? { runId: run.runId, status: run.status, totalItems: run.totalItems, processedItems: run.processedItems,
        successItems: run.successItems, failedItems: run.failedItems, errorCode: run.errorCode || null, errorMessage: run.errorMessage || null } : null;
    }
    function ativo(conta) { var r = window.__cmRuns[conta]; return r && r.status !== "completed" && r.status !== "failed" ? r : null; }
    function ultimo(conta) { var r = window.__cmRuns[conta]; return r && (r.status === "completed" || r.status === "failed") ? r : null; }

    window.__VF_CENTRAL_MARGEM_POLL_MS__ = 120;
    window.__VF_CENTRAL_MARGEM_API_CLIENT__ = {
      getWorkspace: function () { window.__cmCalls.workspace += 1; return Promise.resolve({ ok: false, status: 500, error: "workspace ao vivo NÃO deveria ser chamado" }); },
      getSnapshotResumo: function (params) {
        window.__cmCalls.resumo.push(params);
        // Cenário de compatibilidade: backend sem a rota de snapshot.
        if (sessionStorage.getItem("cmResumo404") === "1") {
          return Promise.resolve({ ok: false, status: 404, error: "not found", type: "not-found" });
        }
        if (!params.clienteContaId) {
          var semConta = { ok: false, status: 400, code: "CLIENTE_CONTA_ID_OBRIGATORIO", error: "clienteContaId é obrigatório" };
          if (window.__cmHoldResumoSemConta) {
            return new Promise(function (resolve) {
              window.__cmResolveResumoSemConta = function () {
                window.__cmHoldResumoSemConta = false;
                window.__cmResolveResumoSemConta = null;
                resolve(semConta);
              };
            });
          }
          return Promise.resolve(semConta);
        }
        var conta = String(params.clienteContaId);
        var missing = window.__cmMissing[conta] === true;
        var porStatus = { HEALTHY: 0, LOW_MARGIN: 0, LOSS: 0, UNVALIDATED: 0, SUSPECT_DATA: 0, RECONCILING: 0 };
        var anuncios = { total: TOTAL, ativos: 0, pausados: 0 };
        for (var i = 0; i < TOTAL; i += 1) {
          porStatus[statusDe(i)] += 1;
          if (statusAnuncioDe(i) === "active") anuncios.ativos += 1;
          if (statusAnuncioDe(i) === "paused") anuncios.pausados += 1;
        }
        var payload = {
          habilitado: true, estado: missing ? "missing" : "ready", acao: missing && !ativo(conta) ? "refresh" : null,
          mensagem: missing ? "Esta conta ainda não tem leitura de margem calculada." : null,
          conta: { id: Number(conta), nome: "Conta " + conta },
          snapshot: { totalItens: missing ? null : TOTAL, ultimoCalculoEm: missing ? null : "2026-09-27T10:00:00Z", foraDoCatalogo: missing ? null : 0 },
          kpis: missing ? null : { total: TOTAL, porStatus: porStatus, porRefreshStatus: { fresh: TOTAL - 1, stale: 0, failed: 1 }, anuncios: anuncios, comMargem: TOTAL - porStatus.UNVALIDATED },
          refresh: { runAtivo: runPublico(ativo(conta)), ultimoRun: runPublico(ultimo(conta)) },
        };
        var normalizado = window.VFCentralMargemApi.normalizeSnapshotResumo(payload);
        if (window.__cmHoldResumoConta === conta) {
          return new Promise(function (resolve) {
            window.__cmResolveResumoConta = function () {
              window.__cmHoldResumoConta = null;
              window.__cmResolveResumoConta = null;
              resolve(normalizado);
            };
          });
        }
        return Promise.resolve(normalizado);
      },
      getSnapshotItens: function (params) {
        window.__cmCalls.itens.push(JSON.parse(JSON.stringify(params)));
        var conta = String(params.clienteContaId);
        var context = { client: { slug: params.clientSlug, name: params.clientName }, marketplace: "meli" };
        if (window.__cmMissing[conta] === true) {
          return Promise.resolve(window.VFCentralMargemApi.normalizeSnapshotItens({ estado: "missing", itens: [], paginacao: { page: 1, limit: params.limit, total: null } }, context));
        }
        var idx = [];
        var termo = (params.search || "").toLowerCase();
        for (var i = 0; i < TOTAL; i += 1) {
          if (params.status && params.status.indexOf(statusDe(i)) === -1) continue;
          if (params.statusAnuncio && statusAnuncioDe(i) !== params.statusAnuncio) continue;
          if (termo && skuDe(i).toLowerCase().indexOf(termo) === -1 && ("produto " + i).indexOf(termo) === -1) continue;
          idx.push(i);
        }
        var limit = params.limit || 50;
        var page = params.page || 1;
        var fatia = idx.slice((page - 1) * limit, page * limit);
        window.__cmItemsRecebidos += fatia.length;
        var payload = {
          estado: "ready",
          paginacao: { page: page, limit: limit, total: idx.length, totalPaginas: Math.max(Math.ceil(idx.length / limit), 1) },
          periodo: { dateFrom: "2026-08-29", dateTo: "2026-09-27" },
          ultimoCalculoEm: "2026-09-27T10:00:00Z",
          itens: fatia.map(function (i) { return rawItem(conta, i); }),
          refresh: { runAtivo: runPublico(ativo(conta)), ultimoRun: runPublico(ultimo(conta)) },
        };
        return Promise.resolve(window.VFCentralMargemApi.normalizeSnapshotItens(payload, context));
      },
      getSnapshotRealizado: function (params) {
        window.__cmCalls.realizado.push(JSON.parse(JSON.stringify(params)));
        var conta = String(params.clienteContaId);
        var resposta = realizadoDe(conta, params.periodo || null);
        if (window.__cmHoldRealizado === conta) {
          return new Promise(function (resolve) {
            window.__cmResolveRealizado = function () {
              window.__cmHoldRealizado = null;
              window.__cmResolveRealizado = null;
              resolve(resposta);
            };
          });
        }
        return Promise.resolve(resposta);
      },
      requestSnapshotRefresh: function (params) {
        window.__cmCalls.refresh.push(params);
        var conta = String(params.clienteContaId);
        var existente = ativo(conta);
        if (existente) return Promise.resolve({ ok: true, runId: existente.runId, reused: true, run: runPublico(existente) });
        var run = { runId: 700 + window.__cmCalls.refresh.length, conta: conta, status: "queued", totalItems: null, processedItems: 0, successItems: 0, failedItems: 0 };
        window.__cmRuns[conta] = run;
        return Promise.resolve({ ok: true, runId: run.runId, reused: false, run: runPublico(run) });
      },
      getSnapshotRefreshStatus: function (params) {
        window.__cmCalls.status.push(params);
        var run = window.__cmRuns[String(params.clienteContaId)];
        if (!run || run.runId !== params.runId) return Promise.resolve({ ok: false, status: 404, error: "run não encontrado" });
        if (run.status === "queued") { run.status = "running"; run.totalItems = TOTAL; }
        else if (run.status === "running" && window.__cmOutcome !== "slow") {
          run.processedItems = Math.min(TOTAL, run.processedItems + 2500);
          run.successItems = run.processedItems;
          if (run.processedItems >= TOTAL) {
            if (window.__cmOutcome === "failed") { run.status = "failed"; run.errorCode = "MARGIN_SNAPSHOT_LOTES_FALHANDO"; run.errorMessage = "3 lote(s) seguidos falharam; run interrompido."; }
            else { run.status = "completed"; delete window.__cmMissing[run.conta]; }
          }
        }
        return Promise.resolve({ ok: true, run: runPublico(run) });
      },
    };
  })();
`;

async function run() {
  const server = await startStaticServer();
  const serverPort = server.address().port;
  const debugPort = 14000 + Math.floor(Math.random() * 1000);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=/tmp/vf-central-margem-snapshot-ui-${process.pid}`,
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

    // Shell V3 contra o host de produção hardcoded — interceptado via CDP
    // Fetch, nunca toca a rede real. O cliente tem MÚLTIPLAS contas MELI ativas:
    // o Shell nunca escolhe sozinho (ACCOUNT_CHOICE_REQUIRED).
    const PROD_HOST = "venforce-server.onrender.com";
    let contasFixture = "multiple";
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    cdp.onEvent = async (method, params) => {
      if (method !== "Fetch.requestPaused") return;
      const url = params.request.url;
      const respond = async (m, p) => {
        try { await cdp.send(m, p); } catch (err) { if (!/Invalid InterceptionId/.test(err.message || "")) throw err; }
      };
      if (!url.includes(PROD_HOST)) { await respond("Fetch.continueRequest", { requestId: params.requestId }); return; }
      const cors = [
        { name: "access-control-allow-origin", value: "*" },
        { name: "access-control-allow-headers", value: "authorization,content-type" },
        { name: "access-control-allow-methods", value: "GET,POST,OPTIONS" },
      ];
      const json = async (obj) => respond("Fetch.fulfillRequest", {
        requestId: params.requestId, responseCode: 200,
        responseHeaders: [...cors, { name: "content-type", value: "application/json" }],
        body: Buffer.from(JSON.stringify(obj)).toString("base64"),
      });
      if (params.request.method === "OPTIONS") { await respond("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 204, responseHeaders: cors }); return; }
      if (url.includes("/me/context")) {
        await json({
          ok: true,
          user: { id: 12, nome: "Pedro Gomes", email: null, role: "user" },
          squads: [], squadPrincipalId: null,
          clientes: [{ id: 1, slug: "loja-teste", nome: "Loja Teste", squadId: null, responsavelDireto: false, contasAtivas: null }],
          portfolio: { totalClientes: 1 },
          permissoes: { podeAdministrar: false },
        });
        return;
      }
      if (url.includes("/operacao/cliente-360/clientes")) {
        await json({ ok: true, clientes: [{ id: 1, nome: "Loja Teste", slug: "loja-teste", ativo: true, temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100, statusOperacional: "pronto", ultimaSincronizacao: null, pendencias: [] }] });
        return;
      }
      if (/\/clientes\/[^/?]+\/contas/.test(url)) {
        const conta = (id, nome) => ({ id, cliente_id: 1, marketplace: "meli", nome, slug: `ml-${id}`, external_account_id: String(id * 1000), externalAccountLabel: nome, is_primary: id === 900, ativo: true, grant: { id, token_status: "valid" }, base: { vinculo_id: id, base_id: id, nome: "Base " + id }, ultimaSync: null });
        const contas = contasFixture === "single"
          ? [conta(10, "Loja piloto")]
          : [conta(10, "Loja piloto"), conta(11, "Loja secundária"), conta(900, "Loja principal"), conta(901, "Loja outlet")];
        await json({ ok: true, cliente: { id: 1, nome: "Loja Teste", slug: "loja-teste", ativo: true }, contas });
        return;
      }
      await respond("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionRefused" });
    };

    const injection = `
      localStorage.setItem("vf-token", "ui-test-token");
      localStorage.setItem("vf-user", JSON.stringify({ nome: "Teste UI", role: "admin" }));
      ${MOCK_CLIENT}
    `;
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: injection });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/central-margem.html?cliente=loja-teste` });

    const st = (expr) => cdp.evaluate(`(function(){var s=window.VFCentralMargemUi.getState();return ${expr};})()`);
    const rowCount = () => cdp.evaluate("document.querySelectorAll('#cm-table-host tbody tr[data-item-id]').length");
    const firstRowId = () => cdp.evaluate("(document.querySelector('#cm-table-host tbody tr[data-item-id]')||{}).getAttribute ? document.querySelector('#cm-table-host tbody tr[data-item-id]').getAttribute('data-item-id') : null");
    const pageState = () => cdp.evaluate("document.getElementById('cm-page-state').innerText");
    const ultimaChamadaItens = () => cdp.evaluate("window.__cmCalls.itens[window.__cmCalls.itens.length-1]");
    const esperarCarregado = (msg) => waitFor(cdp, "window.VFCentralMargemUi && window.VFCentralMargemUi.getState().data && !window.VFCentralMargemUi.getState().loading", msg);
    let itensAoLimparConta = 0;

    await check("conta resolvida durante resumo sem conta: resposta antiga refaz a leitura com a conta atual", async () => {
      await waitFor(cdp, "typeof window.__cmResolveResumoSemConta === 'function'", "resumo inicial sem conta não ficou pendente");
      assert.strictEqual(await cdp.evaluate("window.__cmCalls.resumo.length"), 1);
      assert.strictEqual(await cdp.evaluate("window.__cmCalls.resumo[0].clienteContaId"), null);

      // As contas do Shell chegam depois do carregamento: repete até a conta entrar (setConta antes disso é ignorado).
      for (let i = 0; i < 60; i += 1) {
        await cdp.evaluate("window.VF.context.setConta(10)");
        if (await cdp.evaluate("window.VFCentralMargemUi.getState().contaId === 10")) break;
        await sleep(100);
      }
      await waitFor(cdp, "window.VFCentralMargemUi.getState().contaId === 10", "contexto não entregou a conta durante a request");
      assert.strictEqual(await cdp.evaluate("window.__cmCalls.resumo.length"), 1, "a resposta sem conta ainda estava pendente");

      await cdp.evaluate("window.__cmResolveResumoSemConta()");
      await esperarCarregado("a Central não refez automaticamente a leitura com a conta resolvida");
      const chamadas = await cdp.evaluate("window.__cmCalls.resumo.map(function (c) { return c.clienteContaId; })");
      assert.deepStrictEqual(chamadas.slice(0, 2), [null, 10]);
      assert.strictEqual(await st("s.awaitingAccount"), false);

      await cdp.evaluate("window.VF.context.clearConta()");
      await waitFor(cdp, "window.VFCentralMargemUi.getState().contaId === null && window.VFCentralMargemUi.getState().awaitingAccount", "contexto sem escolha não foi restaurado");
      itensAoLimparConta = await cdp.evaluate("window.__cmCalls.itens.length");
    });

    await check("2+ contas sem escolha: modo persistido pede a operação e nunca escolhe conta sozinho", async () => {
      await waitFor(cdp, "document.querySelector('[data-cm-snapshot-state=\"conta\"]')", "banner de escolha de conta não apareceu");
      assert.strictEqual(await st("s.mode"), "snapshot");
      assert.strictEqual(await st("s.contaId"), null);
      assert.strictEqual(await cdp.evaluate("window.__cmCalls.itens.length"), itensAoLimparConta, "nenhuma página adicional lida sem conta");
      assert.strictEqual(await cdp.evaluate("document.getElementById('cm-refresh').disabled"), true);
    });

    await check("conta escolhida: 1ª página (50) do servidor, KPIs da conta inteira, nenhuma chamada ao workspace ao vivo", async () => {
      await cdp.evaluate("window.VF.context.setConta(900)");
      await esperarCarregado("página 1 não carregou");
      assert.strictEqual(await rowCount(), 50);
      assert.strictEqual(await cdp.evaluate("window.__cmCalls.workspace"), 0, "Motor ao vivo nunca é chamado no modo persistido");
      const chamada = await ultimaChamadaItens();
      assert.strictEqual(chamada.clienteContaId, 900);
      assert.strictEqual(chamada.page, 1);
      assert.strictEqual(chamada.limit, 50);
      assert.ok((await cdp.evaluate("document.getElementById('cm-result-count').innerText")).includes("5000"));
      assert.ok((await cdp.evaluate("document.getElementById('cm-pagination').innerText")).includes("Página 1 de 100"));
      const kpis = await cdp.evaluate("document.getElementById('cm-kpis-financial').innerText");
      assert.ok(kpis.includes("5000") && kpis.includes("1000"), "placar da conta inteira (5.000; 1.000 por status), não da página");
      const anuncios = await cdp.evaluate("document.getElementById('cm-kpis-listing').innerText");
      assert.ok(anuncios.includes("5000") && anuncios.includes("3749") && anuncios.includes("1249"), "KPIs de anúncios usam a conta inteira");
      assert.ok((await pageState()).includes("não puderam ser recalculados"), "aviso de itens com refresh falho");
      assert.ok(await cdp.evaluate("Boolean(document.querySelector('[data-cm-refresh-failed]'))"), "linha marcada com valor anterior");
    });

    await check("realizado da conta: KPIs ponderados, freshness e lacuna explícita no período padrão (até ontem)", async () => {
      await waitFor(cdp, "!document.getElementById('cm-realized').hidden && window.VFCentralMargemUi.getState().realizado", "bloco do realizado não apareceu");
      const ultima = await cdp.evaluate("window.__cmCalls.realizado[window.__cmCalls.realizado.length-1]");
      assert.strictEqual(ultima.clienteContaId, 900);
      assert.ok(!ultima.periodo, "período padrão é resolvido no servidor");
      const texto = await cdp.evaluate("document.getElementById('cm-realized').innerText");
      for (const trecho of ["Receita realizada", "Margem realizada", "37,27%", "Parcial", "27/09/2026", "publicadas só até", "Desvio de margem"]) {
        assert.ok(texto.toLowerCase().includes(trecho.toLowerCase()), `falta "${trecho}" no bloco do realizado: ${texto}`);
      }
      assert.ok((await cdp.evaluate("document.getElementById('cm-context-meta').innerText")).includes("sincronizado até 27/09/2026"));
      assert.strictEqual(await cdp.evaluate("document.getElementById('cm-period-wrap').hidden"), false, "seletor de período visível no modo persistido");
    });

    await check("Diagnóstico mostra vendas, margem projetada × realizada e Δ do Motor; sem venda e realizado indisponível são explícitos (a worklist só decide)", async () => {
      // A worklist de Precificar não carrega colunas de realizado: tudo isso mora no Diagnóstico.
      const colunas = await cdp.evaluate("Array.from(document.querySelectorAll('#cm-table-host thead th')).map(function (th) { return th.textContent.trim().toLowerCase(); })");
      assert.deepStrictEqual(colunas, ["produto", "preço", "lc/un", "margem", "próxima ação", "abrir produto"]);
      await cdp.evaluate("document.querySelector('[data-view=composition]').click()");
      const vendido = await cdp.evaluate("document.querySelector('tr[data-item-id=\"C900-MLB100000\"]').innerText");
      assert.ok(vendido.includes("73 un") && vendido.includes("62 ped."), vendido);
      const real = await cdp.evaluate("document.querySelector('tr[data-item-id=\"C900-MLB100000\"] [data-cm-cmp]').textContent");
      assert.ok(/16,8%/.test(real), `margem realizada ausente: ${real}`);
      assert.ok(/-3,2 pp/.test(real), `Δ margem ausente: ${real}`);
      assert.ok(await cdp.evaluate("Boolean(document.querySelector('tr[data-item-id=\"C900-MLB100000\"] [data-cm-coverage-partial]'))"), "cobertura parcial sinalizada");
      const semVenda = await cdp.evaluate("document.querySelector('tr[data-item-id=\"C900-MLB100001\"]').innerText");
      assert.ok(semVenda.includes("sem venda no período"), semVenda);
      assert.strictEqual(await cdp.evaluate("document.querySelector('tr[data-item-id=\"C900-MLB100001\"] [data-cm-cmp]').textContent"), "sem venda");
      const semCusto = await cdp.evaluate("document.querySelector('tr[data-item-id=\"C900-MLB100002\"] [data-cm-cmp]').innerText");
      assert.strictEqual(semCusto, "realizado indisponível");

      // O painel Projetado × Realizado mora em Evidências (Resumo virou o topo fixo do drawer).
      await cdp.evaluate("window.VFCentralMargemUi.openDrawer('C900-MLB100000', 'evidence')");
      await waitFor(cdp, "document.querySelector('[data-cm-cmp-panel=\"COMPARABLE\"]')", "painel Projetado × Realizado não apareceu no drawer");
      const painel = await cdp.evaluate("document.querySelector('[data-cm-cmp-panel=\"COMPARABLE\"]').closest('section').textContent");
      // A coluna de desvio virou "Impacto no lucro" (#316); o Δ margem do núcleo (marginPercentagePoints) aparece no total.
      for (const trecho of ["Projetado", "Realizado", "Impacto no lucro", "sem histórico", "-3,2 pp", "rateado", "Contraprova"]) {
        assert.ok(painel.toLowerCase().includes(trecho.toLowerCase()), `falta "${trecho}" no painel: ${painel}`);
      }
      await cdp.evaluate("window.VFCentralMargemUi.closeDrawer()");
    });

    await check("margem −1,1309 do backend (fração) aparece −113,09% na tabela, no drawer e na Composição; nunca −1,13%", async () => {
      const id = "C900-MLB100012";
      const celula = (seletor) => cdp.evaluate(`(function(){var e=document.querySelector('tr[data-item-id="${id}"] ${seletor}');return e?e.textContent.trim():null;})()`);
      assert.strictEqual(await celula(".cm-mc-value"), "-113,09%", "visão Operacional (coluna Margem Proj.)");

      await cdp.evaluate("window.VFCentralMargemUi.openDrawer('" + id + "', 'evidence')");
      await waitFor(cdp, "document.getElementById('cm-drawer-summary').textContent.indexOf('Margem projetada') !== -1", "resumo do drawer não abriu");
      const resumo = await cdp.evaluate("document.getElementById('cm-drawer-summary').textContent");
      assert.ok(resumo.includes("-113,09%"), `drawer: ${resumo}`);
      assert.ok(!resumo.includes("-1,13%"), `drawer converteu a fração em silêncio: ${resumo}`);
      await cdp.evaluate("window.VFCentralMargemUi.closeDrawer()");

      await cdp.evaluate("document.querySelector('[data-view=\"composition\"]').click()");
      await waitFor(cdp, "document.querySelector('table.cm-table--comp')", "visão Composição não abriu");
      assert.strictEqual(await celula(".cm-mc-value"), "-113,09%", "visão Composição");
      await cdp.evaluate("document.querySelector('[data-view=\"operational\"]').click()");
      await waitFor(cdp, "document.querySelector('table.cm-table--op')", "visão Operacional não voltou");
      assert.deepStrictEqual(await st("s.data.items.filter(function(i){return i.id==='" + id + "';}).map(function(i){return i.projected.margin;})"), [-1.1309]);
    });

    await check("promoção em andamento com retorno ML: a MESMA margem atual na tabela, no drawer e na Composição, com o retorno explicado", async () => {
      const id = "C900-MLB100015";
      const celula = (seletor) => cdp.evaluate(`(function(){var e=document.querySelector('tr[data-item-id="${id}"] ${seletor}');return e?e.textContent.trim():null;})()`);
      assert.strictEqual(await celula(".cm-mc-value"), "21,3%", "tabela (Operacional)");
      assert.ok((await celula("[data-cm-rebate]")).includes("inclui retorno ML"), "a linha explica o retorno somado");

      await cdp.evaluate("window.VFCentralMargemUi.openDrawer('" + id + "', 'evidence')");
      await waitFor(cdp, "document.getElementById('cm-drawer-summary').textContent.indexOf('Margem projetada') !== -1", "resumo do drawer não abriu");
      const resumo = (await cdp.evaluate("document.getElementById('cm-drawer-summary').textContent")).replace(/\u00a0/g, " ");
      assert.ok(resumo.includes("21,3%") && resumo.includes("LC R$ 21,30 / un"), `drawer: ${resumo}`);
      // Sub do topo numa linha só: o retorno ML somado é explicado no title do "LC / un".
      assert.ok((await cdp.evaluate("(document.querySelector('#cm-drawer-summary [title*=\"inclui retorno ML\"]') || {}).title || ''")).includes("inclui retorno ML"), "o topo explica o retorno somado");
      await cdp.evaluate("window.VFCentralMargemUi.closeDrawer()");

      await cdp.evaluate("document.querySelector('[data-view=\"composition\"]').click()");
      await waitFor(cdp, "document.querySelector('table.cm-table--comp')", "visão Composição não abriu");
      assert.strictEqual(await celula(".cm-mc-value"), "21,3%", "Composição (fórmula local com o retorno ML do backend)");
      await cdp.evaluate("document.querySelector('[data-view=\"operational\"]').click()");
      await waitFor(cdp, "document.querySelector('table.cm-table--op')", "visão Operacional não voltou");
    });

    await check("trocar o período relê itens e realizado com periodo=YYYY-MM (Shell) e NÃO pede refresh do snapshot", async () => {
      const refreshAntes = await cdp.evaluate("window.__cmCalls.refresh.length");
      const valor = await cdp.evaluate("document.getElementById('cm-period').options[2].value");
      assert.ok(/^\d{4}-\d{2}$/.test(valor), valor);
      await cdp.evaluate(`(function(){var s=document.getElementById('cm-period');s.value='${valor}';s.dispatchEvent(new Event('change'));})()`);
      await waitFor(cdp, `window.__cmCalls.realizado[window.__cmCalls.realizado.length-1].periodo === '${valor}' && window.__cmCalls.itens[window.__cmCalls.itens.length-1].periodo === '${valor}' && !window.VFCentralMargemUi.getState().loading && !window.VFCentralMargemUi.getState().realizadoLoading`, "troca de período não releu itens e realizado");
      assert.strictEqual(await cdp.evaluate("window.VF.context.getPeriodoParam()"), valor, "período vive no parâmetro global do Shell");
      assert.strictEqual(await cdp.evaluate("window.__cmCalls.refresh.length"), refreshAntes, "trocar período nunca recalcula o projetado");
      assert.ok((await cdp.evaluate("document.getElementById('cm-realized-period').innerText")).includes(valor));

      await cdp.evaluate("(function(){var s=document.getElementById('cm-period');s.value='';s.dispatchEvent(new Event('change'));})()");
      await waitFor(cdp, "!window.__cmCalls.realizado[window.__cmCalls.realizado.length-1].periodo && !window.VFCentralMargemUi.getState().realizadoLoading", "volta ao padrão não releu o realizado");
      assert.strictEqual(await cdp.evaluate("window.VF.context.getPeriodoParam()"), null);
    });

    await check("Central de Vendas falhando: UM aviso 'Realizado indisponível · motivo' (nenhum R$ 0 nem 0), bloco detalhado oculto, e as linhas não dizem 'sem venda'", async () => {
      await cdp.evaluate("window.__cmRealizadoFalha = true");
      await cdp.evaluate("(function(){var s=document.getElementById('cm-period');s.value='2026-07';s.dispatchEvent(new Event('change'));})()");
      await waitFor(cdp, "document.querySelector('[data-cm-realized-unavailable]') && !window.VFCentralMargemUi.getState().loading && !window.VFCentralMargemUi.getState().realizadoLoading", "estado indisponível do realizado não apareceu");
      assert.strictEqual(await cdp.evaluate("document.querySelectorAll('[data-cm-realized-unavailable]').length"), 1, "aviso ÚNICO");
      const aviso = await cdp.evaluate("document.getElementById('cm-top-realized').textContent");
      assert.ok(aviso.startsWith("Realizado indisponível ·"), aviso);
      assert.ok(aviso.includes("nenhum valor foi zerado"), aviso);
      assert.ok(!/R\$\s*0[,\s]/.test(aviso), `R$ 0 no aviso: ${aviso}`);
      assert.strictEqual(await cdp.evaluate("document.getElementById('cm-realized').hidden"), true, "o bloco detalhado do realizado some (não repete 'Indisponível' em cada KPI)");
      const topo = await cdp.evaluate("document.getElementById('cm-kpis-top').textContent");
      assert.ok(!/R\$\s*0[,\s]/.test(topo), `R$ 0 no topo: ${topo}`);
      // O realizado por produto mora no Diagnóstico (a worklist de Precificar só decide).
      await cdp.evaluate("document.querySelector('[data-view=composition]').click()");
      const linha = await cdp.evaluate("document.querySelector('tr[data-item-id=\"C900-MLB100000\"]').textContent");
      assert.ok(/indisponível/i.test(linha), linha);
      assert.ok(!/sem venda/i.test(linha), `linha afirma 'sem venda' sem saber: ${linha}`);
      await cdp.evaluate("document.querySelector('[data-view=operational]').click()");

      await cdp.evaluate("window.__cmRealizadoFalha = false");
      await cdp.evaluate("(function(){var s=document.getElementById('cm-period');s.value='';s.dispatchEvent(new Event('change'));})()");
      await waitFor(cdp, "!document.querySelector('[data-cm-realized-unavailable]') && !window.VFCentralMargemUi.getState().loading && !window.VFCentralMargemUi.getState().realizadoLoading", "realizado não voltou ao normal");
    });

    await check("filtro de anúncio: active, paused e todos combinam com busca/status sem perder paginação", async () => {
      await cdp.evaluate("(function(){var s=document.getElementById('cm-listing-status-filter');s.value='active';s.dispatchEvent(new Event('change'));})()");
      await waitFor(cdp, "window.__cmCalls.itens[window.__cmCalls.itens.length-1].statusAnuncio === 'active' && !window.VFCentralMargemUi.getState().loading", "filtro active não foi ao servidor");
      assert.ok((await cdp.evaluate("document.getElementById('cm-result-count').innerText")).includes("3749"));
      assert.ok(await cdp.evaluate("Array.from(document.querySelectorAll('#cm-table-host .cm-listing-status')).every(function(e){return e.innerText.indexOf('Ativo') !== -1;})"));

      await cdp.evaluate("(function(){var i=document.getElementById('cm-search');i.value='SKU-4997';i.dispatchEvent(new Event('input'));var s=document.getElementById('cm-financial-filter');s.value='LOSS';s.dispatchEvent(new Event('change'));})()");
      await waitFor(cdp, "window.__cmCalls.itens.some(function(c){return c.statusAnuncio==='active' && c.search==='SKU-4997' && JSON.stringify(c.status)==='[\"LOSS\"]';}) && !window.VFCentralMargemUi.getState().loading", "combinação active + busca + status financeiro não chegou ao servidor");
      assert.strictEqual(await rowCount(), 1);

      await cdp.evaluate("(function(){var i=document.getElementById('cm-search');i.value='';i.dispatchEvent(new Event('input'));var f=document.getElementById('cm-financial-filter');f.value='';f.dispatchEvent(new Event('change'));var s=document.getElementById('cm-listing-status-filter');s.value='paused';s.dispatchEvent(new Event('change'));})()");
      await waitFor(cdp, "window.__cmCalls.itens[window.__cmCalls.itens.length-1].statusAnuncio === 'paused' && !window.__cmCalls.itens[window.__cmCalls.itens.length-1].search && !window.VFCentralMargemUi.getState().loading", "filtro paused não foi ao servidor");
      assert.ok((await cdp.evaluate("document.getElementById('cm-result-count').innerText")).includes("1249"));
      assert.ok((await cdp.evaluate("document.getElementById('cm-pagination').innerText")).includes("Página 1 de 25"));
      assert.ok(await cdp.evaluate("Array.from(document.querySelectorAll('#cm-table-host .cm-listing-status')).every(function(e){return e.innerText.indexOf('Pausado') !== -1;})"));

      await cdp.evaluate("(function(){var s=document.getElementById('cm-listing-status-filter');s.value='';s.dispatchEvent(new Event('change'));})()");
      await waitFor(cdp, "!window.__cmCalls.itens[window.__cmCalls.itens.length-1].statusAnuncio && !window.VFCentralMargemUi.getState().loading", "opção Todos não removeu o filtro");
      assert.ok((await cdp.evaluate("document.getElementById('cm-result-count').innerText")).includes("5000"));
    });

    await check("status de anúncio nulo ou desconhecido aparece neutro e não quebra a linha", async () => {
      await cdp.evaluate("(function(){var i=document.getElementById('cm-search');i.value='SKU-NULL-STATUS';i.dispatchEvent(new Event('input'));})()");
      await waitFor(cdp, "window.__cmCalls.itens[window.__cmCalls.itens.length-1].search === 'SKU-NULL-STATUS' && !window.VFCentralMargemUi.getState().loading");
      assert.ok((await cdp.evaluate("document.querySelector('#cm-table-host .cm-listing-status').innerText")).includes("não informado"));
      await cdp.evaluate("(function(){var i=document.getElementById('cm-search');i.value='SKU-UNKNOWN-STATUS';i.dispatchEvent(new Event('input'));})()");
      await waitFor(cdp, "window.__cmCalls.itens[window.__cmCalls.itens.length-1].search === 'SKU-UNKNOWN-STATUS' && !window.VFCentralMargemUi.getState().loading");
      assert.ok((await cdp.evaluate("document.querySelector('#cm-table-host .cm-listing-status').innerText")).includes("under_review"));
      await cdp.evaluate("(function(){var i=document.getElementById('cm-search');i.value='';i.dispatchEvent(new Event('input'));})()");
      await waitFor(cdp, "!window.__cmCalls.itens[window.__cmCalls.itens.length-1].search && !window.VFCentralMargemUi.getState().loading");
    });

    await check("troca 10 → 11 durante request: resposta antiga não substitui a conta nova", async () => {
      await cdp.evaluate("window.VF.context.setConta(10)");
      await esperarCarregado("conta 10 não carregou antes do teste stale");
      await cdp.evaluate("window.__cmHoldResumoConta='10';window.VFCentralMargemUi.reload();void 0");
      await waitFor(cdp, "typeof window.__cmResolveResumoConta === 'function'", "resumo da conta 10 não ficou pendente");
      await cdp.evaluate("window.VF.context.setConta(11)");
      await waitFor(cdp, "window.VFCentralMargemUi.getState().contaId === 11 && !window.VFCentralMargemUi.getState().loading", "conta 11 não venceu a request anterior");
      await cdp.evaluate("window.__cmResolveResumoConta()");
      await sleep(150);
      assert.strictEqual(await st("s.contaId"), 11);
      assert.strictEqual(await st("s.snapshot.account.id"), 11);

      await cdp.evaluate("window.VF.context.setConta(900)");
      await esperarCarregado("conta 900 não foi restaurada depois do teste stale");
    });

    await check("realizado stale: resposta da conta 10 que chega depois da troca para 11 é descartada", async () => {
      await cdp.evaluate("window.__cmHoldRealizado='10';window.VF.context.setConta(10);void 0");
      await waitFor(cdp, "typeof window.__cmResolveRealizado === 'function'", "realizado da conta 10 não ficou pendente");
      await cdp.evaluate("window.VF.context.setConta(11)");
      await waitFor(cdp, "window.VFCentralMargemUi.getState().contaId === 11 && window.VFCentralMargemUi.getState().realizado && !window.VFCentralMargemUi.getState().realizadoLoading", "realizado da conta 11 não carregou");
      await cdp.evaluate("window.__cmResolveRealizado()");
      await sleep(150);
      const receita = await cdp.evaluate("document.getElementById('cm-kpis-realized').innerText");
      assert.ok(receita.includes("11.000"), `KPIs devem ser da conta 11: ${receita}`);
      assert.ok(!receita.includes("10.000"), "resposta da conta 10 nunca sobrescreve a 11");
      await cdp.evaluate("window.VF.context.setConta(900)");
      await esperarCarregado("conta 900 não foi restaurada depois do teste stale do realizado");
    });

    await check("5.000 itens navegados sem carregar tudo: próxima página, 200 por página, nunca > 1 página no DOM", async () => {
      const antes = await firstRowId();
      await cdp.evaluate("document.getElementById('cm-page-next').click()");
      await waitFor(cdp, "window.VFCentralMargemUi.getState().serverPage === 2 && !window.VFCentralMargemUi.getState().loading");
      assert.notStrictEqual(await firstRowId(), antes);
      assert.strictEqual((await ultimaChamadaItens()).page, 2);

      await cdp.evaluate("(function(){var s=document.getElementById('cm-page-size');s.value='200';s.dispatchEvent(new Event('change'));})()");
      await waitFor(cdp, "document.querySelectorAll('#cm-table-host tbody tr[data-item-id]').length === 200 && !window.VFCentralMargemUi.getState().loading");
      assert.ok((await cdp.evaluate("document.getElementById('cm-pagination').innerText")).includes("Página 1 de 25"));
      for (let i = 0; i < 3; i += 1) {
        await cdp.evaluate("document.getElementById('cm-page-next').click()");
        await waitFor(cdp, `window.VFCentralMargemUi.getState().serverPage === ${i + 2} && !window.VFCentralMargemUi.getState().loading`);
        assert.ok(await rowCount() <= 200);
      }
      const recebidos = await cdp.evaluate("window.__cmItemsRecebidos");
      assert.ok(recebidos < 5000, `browser recebeu só as páginas navegadas (${recebidos} itens), nunca o catálogo inteiro`);
    });

    await check("busca e filtro vão ao servidor (página 1), com o status canônico", async () => {
      await cdp.evaluate("(function(){var i=document.getElementById('cm-search');i.value='SKU-4999';i.dispatchEvent(new Event('input'));})()");
      await waitFor(cdp, "window.__cmCalls.itens[window.__cmCalls.itens.length-1].search === 'SKU-4999' && !window.VFCentralMargemUi.getState().loading", "busca não foi ao servidor");
      assert.strictEqual(await rowCount(), 1);
      assert.strictEqual((await ultimaChamadaItens()).page, 1);

      await cdp.evaluate("(function(){var i=document.getElementById('cm-search');i.value='';i.dispatchEvent(new Event('input'));})()");
      await waitFor(cdp, "!window.__cmCalls.itens[window.__cmCalls.itens.length-1].search && !window.VFCentralMargemUi.getState().loading");
      await cdp.evaluate("(function(){var s=document.getElementById('cm-financial-filter');s.value='LOSS';s.dispatchEvent(new Event('change'));})()");
      await waitFor(cdp, "JSON.stringify(window.__cmCalls.itens[window.__cmCalls.itens.length-1].status) === '[\"LOSS\"]' && !window.VFCentralMargemUi.getState().loading", "filtro não foi ao servidor");
      assert.ok((await cdp.evaluate("document.getElementById('cm-result-count').innerText")).includes("1000"));
      await cdp.evaluate("(function(){var s=document.getElementById('cm-financial-filter');s.value='';s.dispatchEvent(new Event('change'));})()");
      await waitFor(cdp, "!window.__cmCalls.itens[window.__cmCalls.itens.length-1].status && !window.VFCentralMargemUi.getState().loading");
    });

    await check("refresh manual: não congela a tela, mostra progresso, mantém a leitura anterior e para o polling no fim", async () => {
      await cdp.evaluate("document.getElementById('cm-refresh').click()");
      await waitFor(cdp, "window.__cmCalls.refresh.length === 1", "refresh não foi solicitado");
      assert.strictEqual((await cdp.evaluate("window.__cmCalls.refresh[0]")).clienteContaId, 900);
      assert.ok(await rowCount() > 0, "a leitura anterior continua visível durante a atualização");
      await waitFor(cdp, "document.getElementById('cm-page-state').innerText.indexOf('Atualizando leitura') !== -1 || document.getElementById('cm-page-state').innerText.indexOf('Na fila') !== -1", "banner de progresso não apareceu");

      // Tela responde durante o refresh: navegar de página funciona.
      await cdp.evaluate("document.getElementById('cm-page-next').click()");
      await waitFor(cdp, "!window.VFCentralMargemUi.getState().loading && window.VFCentralMargemUi.getState().serverPage >= 2", "navegação travou durante o refresh");

      await waitFor(cdp, "document.getElementById('cm-page-state').innerText.indexOf('2500 / 5000') !== -1 || window.__cmRuns['900'].status === 'completed'", "progresso processados/total não apareceu");
      await waitFor(cdp, "window.__cmRuns['900'].status === 'completed' && !window.VFCentralMargemUi.getState().pollTimer", "polling não terminou");
      await waitFor(cdp, "document.getElementById('cm-page-state').innerText.indexOf('Atualizando') === -1");
      const chamadas = await cdp.evaluate("window.__cmCalls.status.length");
      await sleep(600);
      assert.strictEqual(await cdp.evaluate("window.__cmCalls.status.length"), chamadas, "nenhum polling depois do estado terminal");
    });

    await check("refresh que falha: erro visível e dados anteriores mantidos (nada zerado)", async () => {
      await cdp.evaluate("window.__cmOutcome='failed';document.getElementById('cm-refresh').click()");
      await waitFor(cdp, "document.querySelector('[data-cm-snapshot-state=\"failed\"]')", "falha não apareceu");
      assert.ok((await pageState()).includes("último snapshot válido"));
      assert.ok(await rowCount() > 0);
      assert.ok((await cdp.evaluate("document.getElementById('cm-kpis-financial').innerText")).includes("5000"));
    });

    await check("troca de conta troca o dataset e mata o polling da conta anterior", async () => {
      await cdp.evaluate("window.__cmOutcome='slow';document.getElementById('cm-refresh').click()");
      await waitFor(cdp, "window.VFCentralMargemUi.getState().pollTimer", "polling da conta 900 não começou");
      await cdp.evaluate("window.VF.context.setConta(901)");
      await waitFor(cdp, "window.VFCentralMargemUi.getState().contaId === 901 && !window.VFCentralMargemUi.getState().loading", "troca de conta não recarregou");
      const status900 = await cdp.evaluate("window.__cmCalls.status.filter(function(c){return c.clienteContaId===900;}).length");
      await sleep(600);
      assert.strictEqual(await cdp.evaluate("window.__cmCalls.status.filter(function(c){return c.clienteContaId===900;}).length"), status900, "polling da conta 900 parou");
      assert.strictEqual((await cdp.evaluate("window.__cmCalls.resumo[window.__cmCalls.resumo.length-1]")).clienteContaId, 901);
    });

    await check("conta sem leitura: estado 'missing' explícito (nunca '0 itens'), KPIs '—' e ação de atualizar", async () => {
      await waitFor(cdp, "document.querySelector('[data-cm-snapshot-state=\"missing\"]')", "estado missing não apareceu");
      assert.ok((await cdp.evaluate("document.getElementById('cm-table-host').innerText")).includes("Leitura ainda não calculada"));
      const kpis = await cdp.evaluate("document.getElementById('cm-kpis-financial').innerText");
      assert.ok(kpis.includes("—") && !/\b0\b/.test(kpis), "placar de conta missing nunca vira zeros");
      await cdp.evaluate("window.__cmOutcome='completed';document.getElementById('cm-snapshot-start').click()");
      await waitFor(cdp, "window.__cmCalls.refresh.some(function(c){return c.clienteContaId===901;})", "ação do banner não pediu refresh da conta 901");
      await waitFor(cdp, "window.__cmRuns['901'] && window.__cmRuns['901'].status === 'completed' && document.querySelectorAll('#cm-table-host tbody tr[data-item-id]').length > 0", "conta 901 não passou a mostrar a leitura calculada");
      assert.ok((await firstRowId()).startsWith("C901-"), "dataset é o da conta 901");
    });

    await check("backend sem a rota de snapshot (404): a tela cai no workspace legado, sem ficar em erro", async () => {
      await cdp.evaluate("sessionStorage.setItem('cmResumo404','1'); location.reload()");
      await waitFor(cdp, "window.__cmCalls && window.__cmCalls.workspace === 1", "workspace legado não foi chamado após 404 do resumo");
      assert.strictEqual(await st("s.mode"), "legacy");
      await cdp.evaluate("sessionStorage.removeItem('cmResumo404')");
    });

    await check("1 conta ativa: vf-context auto-resolve e a Central carrega o snapshot da conta", async () => {
      contasFixture = "single";
      await cdp.evaluate("sessionStorage.removeItem('vf-ctx');sessionStorage.setItem('cmSkipHoldSemConta','1')");
      await cdp.send("Page.navigate", { url: `http://127.0.0.1:${serverPort}/central-margem.html?cliente=loja-teste` });
      await esperarCarregado("snapshot da conta única não carregou");
      assert.strictEqual(await cdp.evaluate("window.VF.context.getContext().clienteContaId"), 10);
      assert.strictEqual(await st("s.contaId"), 10);
      assert.strictEqual(await st("s.mode"), "snapshot");
      assert.strictEqual(await st("s.awaitingAccount"), false);
      assert.strictEqual(await cdp.evaluate("window.__cmCalls.resumo[window.__cmCalls.resumo.length-1].clienteContaId"), 10);
      assert.strictEqual((await ultimaChamadaItens()).clienteContaId, 10);
    });

    console.log(`# ${checks} smoke tests de UI (leitura persistida) concluídos`);
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
