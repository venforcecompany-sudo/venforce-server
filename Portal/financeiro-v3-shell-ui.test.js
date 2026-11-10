/*
 * Smoke test de interface em Chrome headless para o Financeiro V3 (F4.1) —
 * segunda ilha React sobre o Shell V3. Mesma estratégia de
 * Portal/visao-shell-ui.test.js: fixtures reais para o Shell e um payload
 * REALISTA para GET /financeiro/:cliente, moldado pelo shape real que
 * server/services/financeiroVisaoService.js compõe.
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
// Screenshots do smoke: VF_SHOTS_DIR, senão uma pasta temporária do sistema.
const SHOTS_DIR = process.env.VF_SHOTS_DIR || path.join(require("os").tmpdir(), "vf-fin-v3-shots");

const N97 = { id: 87, nome: "N97 Comercial", slug: "n97", ativo: true, temGrant: true, grantStatus: "conectado", temBase: true, setupScore: 100, statusOperacional: "pronto", ultimaSincronizacao: null, pendencias: [] };
const PORTFOLIO = { ok: true, clientes: [N97] };
const N97_CONTAS = [
  { id: 42, cliente_id: 87, marketplace: "meli", nome: "Mercado Livre 1", ativo: true, grant: { token_status: "valid" }, base: { base_id: 9 } },
];

// GET /base-vinculos — o que o Financeiro V3 lê para decidir se a operação
// já tem base de custos (e, portanto, se pede upload). Shape de
// server/services/baseVinculosService.mapearBaseComVinculo. Mutável: os
// cenários ligam/desligam o vínculo do marketplace da vez.
let baseVinculosFake = [
  {
    id: 9, slug: "base-n97-meli", nome: "Comprou_chegou_meli1", ativo: true,
    vinculo: { cliente_slug: "n97", marketplace: "meli", cliente_conta_id: 42, conta_nome: "Mercado Livre 1" },
  },
];

// Payload REALISTA — shape confirmado lendo server/services/
// financeiroVisaoService.js e centralVendasMp3ReadService.js.
function payloadFeliz() {
  return {
    ok: true,
    contexto: { clienteId: 87, clienteSlug: "n97", clienteContaId: 42, marketplace: "meli", periodo: "2026-08" },
    resultado: {
      disponivel: true, escopoConta: false,
      dados: {
        status: "publicado", geradoEm: "2026-08-26T10:00:00Z", publicadoEm: "2026-08-26T12:00:00Z",
        cards: [],
        composicao: [
          { chave: "faturamento_bruto", rotulo: "Faturamento bruto", valor: 412880.5, disponivel: true },
          { chave: "comissao", rotulo: "Comissão", valor: -41288.05, disponivel: true },
          { chave: "frete", rotulo: "Frete", valor: -12500, disponivel: true },
          { chave: "custo_produto", rotulo: "Custo de produto", valor: null, disponivel: false },
          { chave: "resultado", rotulo: "Resultado", valor: 96220.3, disponivel: true },
        ],
      },
    },
    conciliacao: {
      disponivel: true, escopoConta: true,
      dados: {
        mpReconciliationStatus: "partial",
        summary: {
          ordersTotal: 3201, ordersMatchedClean: 2900, ordersMatchedWithEvents: 100, ordersDivergent: 3,
          ordersSettlementPending: 50, coveragePercent: 93.8, paymentsUnique: 3100, paymentsSettlementPending: 50,
          totalPaymentNet: 380000.2,
        },
      },
    },
    relatorios: {
      disponivel: true, escopoConta: false,
      dados: [
        { periodo: "2026-08", status: "publicado", geradoEm: "2026-08-26T10:00:00Z", publicado: true, token: "tok-agosto" },
        { periodo: "2026-07", status: "publicado", geradoEm: "2026-07-28T10:00:00Z", publicado: true, token: "tok-julho" },
        { periodo: "2026-06", status: "rascunho", geradoEm: "2026-06-29T10:00:00Z", publicado: false, token: null },
      ],
    },
  };
}

/* UX pós-migração — processamento REALISTA e GRANDE (milhares de linhas) para
   provar a hierarquia da página, a paginação e as pendências na linha. Shapes
   confirmados em server/services/fechamentoFinanceiro/* (summary) e em
   frontend-react/src/utils/financeiro/produtos.js (detailedRows). */
function processamentoRicoMeli() {
  const detailedRows = Array.from({ length: 3625 }, (_, i) => {
    const semCusto = i < 4;
    return {
      "# de anúncio": `MLB${String(1000 + i)}`,
      "Título do anúncio": `Produto ${i} com um título bem comprido para testar a quebra de linha da coluna de nome ${i}`,
      Unidades: 1 + (i % 3), "Venda Total": 100 + (i % 50), "Total (BRL)": 80 + (i % 30),
      "Preço de custo": semCusto ? null : 30, "Preço de custo total": semCusto ? null : 30,
      Imposto: 10, LC: semCusto ? null : 12.5, MC: semCusto ? null : (i % 9 === 0 ? -3 : 18),
      "Cobertura de custo": semCusto ? "sem custo" : (i % 40 === 0 ? "financeiro pendente" : "com custo"),
    };
  });
  return {
    ok: true,
    marketplace: "meli",
    costsSource: "base",
    costsBase: { id: 9, slug: "base-n97-meli", nome: "Comprou_chegou_meli1" },
    summary: {
      marketplace: "meli", calculationMode: "real_meli_vendas", financialConfidence: "parcial",
      grossRevenueTotal: 412880.5, paidRevenueTotal: 371200.1, revenueWithCost: 398000, revenueWithoutCost: 14880.5,
      calculatedCoveragePercent: 96.4, revenueWithFinancialData: 390000, revenuePendingFinancial: 22880.5, financialDataCoveragePercent: 94.5,
      salesPendingFinancialCount: 91, contributionProfitTotal: 61250.4, contributionMarginCalculated: 0.1539, averageContributionMargin: 0.15,
      finalResult: 21400.2, finalMarginCalculated: 0.0538, tacos: 0.061, tacox: 0.092,
      adsTotal: 25200, venforceTotal: 9800, affiliatesTotal: 4850.2, fullCostTotal: 0, additionalCostsTotal: 0,
      refundsCount: 38, refundsTotal: -7120.4, lostRevenueTotal: 7120.4, excludedStatusCount: 12,
      ambiguousCostIds: ["MLB9999"], executiveNotes: ["Mês com 12 itens fora do LC por status.", "ADS informado manualmente."],
    },
    competencia: { periodoSolicitado: "2026-08", periodoDetectado: "2026-08", divergente: false },
    detailedRows,
    unmatchedIds: ["MLB1000", "MLB1001", "MLB1002", "MLB1003"],
    unmatchedCosts: [],
  };
}
function processamentoRicoShopee() {
  const detailedRows = Array.from({ length: 1800 }, (_, i) => ({
    Produto: `Kit ${i} título longo de produto Shopee para validar a coluna de produto ${i}`,
    ID: String(169417000000 + i), "ID Model": String(555000000000 + i),
    "Unidades (Pedido pago)": 1 + (i % 4), "Vendas (Pedido pago) (BRL)": 90 + (i % 40),
    Custo: i % 25 === 0 ? null : 28, Imposto: 8, "LC POR ANÚNCIO": i % 25 === 0 ? null : 14, MC: i % 25 === 0 ? null : 16,
    "Cobertura de custo": i % 25 === 0 ? "sem custo" : "com custo",
  }));
  // Uma pendência SEM ID do Item (só Model): vai para o grupo 3 (bloqueada).
  detailedRows.push({ Produto: "Kit sem ID do Item", "ID Model": "555000009999", "Unidades (Pedido pago)": 1, "Vendas (Pedido pago) (BRL)": 50, Custo: null, Imposto: 8, "LC POR ANÚNCIO": null, MC: null, "Cobertura de custo": "sem custo" });
  return {
    ok: true, marketplace: "shopee", costsSource: "base", costsBase: { id: 9, slug: "base-n97-shopee", nome: "Base Shopee N97" },
    summary: {
      marketplace: "shopee", calculationMode: "real_financial", financialConfidence: "parcial",
      grossRevenueTotal: 180400.2, paidRevenueTotal: 166100, revenueWithCost: 170000, revenueWithoutCost: 10400.2,
      calculatedCoveragePercent: 94.2, contributionProfitTotal: 31200.7, contributionMarginCalculated: 0.1729,
      finalResult: 9800.3, finalMarginCalculated: 0.054, tacos: 0.071, tacox: 0.088,
      adsTotal: 12800, venforceTotal: 5200, affiliatesTotal: 3400.4,
      cancellationsTotal: -4100, returnsTotal: -2200, marketplaceFeesTotal: -21300, shippingFeesTotal: -9800, taxValueTotal: -14400, cmvTotal: -88200,
      cancelledCount: 40, cancelledLostRevenue: 4100, unpaidCount: 22, unpaidLostRevenue: 2050, returnRefundCount: 15, returnRefundRevenue: 2200,
      orderAllTotalCount: 1540, orderAllTotalRevenue: 183900,
      orderAllCompletedCount: 1100, orderAllCompletedRevenue: 130000, orderAllDeliveredCount: 180, orderAllDeliveredRevenue: 21000,
      orderAllShippedCount: 120, orderAllShippedRevenue: 14000, orderAllIntermediateCount: 20, orderAllIntermediateRevenue: 2400,
      orderAllCancelledConfirmedCount: 40, orderAllCancelledConfirmedRevenue: 4100, orderAllUnpaidCount: 22, orderAllUnpaidRevenue: 2050,
      orderAllReturnRefundCount: 15, orderAllReturnRefundRevenue: 2200,
      orderAllTopCancelledItems: [{ productName: "Kit 5", count: 4, revenue: 1600 }],
      executiveNotes: ["Order.all cobre 100% do mês."],
    },
    competencia: { periodoSolicitado: "2026-08", periodoDetectado: "2026-08", divergente: false },
    detailedRows,
    unmatchedIds: Array.from({ length: 72 }, (_, i) => String(169417000000 + i * 25)),
    unmatchedCosts: [{ type: "variation_id", value: "555000000000", reason: "cost_only_on_parent_item", parentItemId: "169417000000", blockedBy: "multiple_variations_in_performance" }],
  };
}
let processamentoFake = null; // quando setado, POST /fechamentos/financeiro devolve isto
let upsertsFake = [];
let baseCustosFake = {}; // slug → dicionário `dados` de GET /bases/:slug
let previewPlanilhaFake = { ok: true, dados_importacao: [], resumo: { linhas_lidas: 0, linhas_ignoradas: 0 }, alertas: [] };

// Sem fechamento gerado no período — shape real confirmado lendo
// financeiroVisaoService.js: `resultado.disponivel` é FALSE quando não há
// entrega para o período (não é `true` com `dados:null` — `dados` continua
// preenchido, no shape "nao_gerado", mas o envelope inteiro é indisponível
// com motivo; M6, "não é erro" mas também não é um bloco "disponível vazio").
function payloadSemFechamento() {
  return {
    ok: true,
    contexto: { clienteId: 87, clienteSlug: "n97", clienteContaId: 42, marketplace: "meli", periodo: "2026-09" },
    resultado: {
      disponivel: false, escopoConta: false,
      dados: { status: "nao_gerado", geradoEm: null, publicadoEm: null, cards: [], composicao: [] },
      motivo: "Nenhum fechamento gerado para este período.",
    },
    conciliacao: { disponivel: true, escopoConta: true, dados: { mpReconciliationStatus: "not_available", summary: { ordersTotal: 0 } } },
    relatorios: { disponivel: true, escopoConta: false, dados: [] },
  };
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

let financeiroPayload = payloadFeliz();

/* ── F4.2 — GET/POST /entregas-cliente, no shape real de
   server/services/entregasClienteService.js (o SELECT de `listarEntregas`
   e o RETURNING de `publicarEntrega`). Este fake é COM ESTADO de propósito:
   publicar/despublicar mudam o array, e é isso que permite ao teste provar
   que a tela relê do servidor em vez de remendar o estado local. ───────── */
let entregasFake = [];
let entregasFalham = false; // cenário do modo degradado
let entregasRequestCount = 0;
// Conv#3 — processamento nativo
let fechamentoRequestCount = 0;
let competenciaFake = { periodoSolicitado: "2026-08", periodoDetectado: "2026-08", divergente: false };
// Modo API (padrão em MELI): GET .../fechamento-api/status e POST .../fechamento-api.
// `statusSyncFake` é mutável: o cenário sem sincronização troca `disponivel`.
let statusSyncFake = {
  ok: true, marketplace: "meli", periodo: "2026-08",
  sync: { disponivel: true, importId: 7, publicadoEm: "2026-09-02T03:12:00Z", coberturaDe: "2026-08-01", coberturaAte: "2026-08-31", completo: true, motivoIncompleto: null },
  runEmAndamento: null,
};
let corposFechamentoApi = [];
// Fase 2 — custos no modo API: POST /importar-base (salvar a planilha como
// base da conta) e o corpo multipart do fechamento com a planilha de custos.
let corposImportarBase = [];

// Campos de um corpo multipart (o que o CDP entrega em postData). Arquivo vira
// { arquivo: nome }; texto vira o valor. Sem postData → null.
function camposMultipart(postData) {
  if (!postData) return null;
  const campos = {};
  const re = /Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?[^\n]*\r?\n(?:Content-Type:[^\n]*\r?\n)?\r?\n([\s\S]*?)\r?\n--/g;
  let m;
  while ((m = re.exec(postData))) campos[m[1]] = m[2] !== undefined ? { arquivo: m[2] } : m[3];
  return campos;
}
function corpoDoPedido(req) {
  const tipo = Object.entries(req.headers || {}).find(([k]) => k.toLowerCase() === "content-type")?.[1] || "";
  if (/multipart\/form-data/i.test(tipo)) return { multipart: true, campos: camposMultipart(req.postData) };
  return JSON.parse(req.postData || "{}");
}

function resetEntregas() {
  entregasFalham = false;
  entregasRequestCount = 0;
  // Paridade operacional: a lista vem filtrada por conta (+ legadas). 801–803
  // são DESTA conta (42); 804 é legada (sem operação registrada) e nunca pode
  // ser atribuída à conta em tela.
  entregasFake = [
    { id: 801, tipo: "fechamento_mensal", cliente_id: 87, cliente_slug: "n97", cliente_conta_id: 42, titulo: "Fechamento Agosto", periodo: "2026-08", status: "publicado", publicado: true, token_publico: "tok-agosto", created_at: "2026-08-26T10:00:00Z", published_at: "2026-08-26T12:00:00Z" },
    { id: 802, tipo: "fechamento_mensal", cliente_id: 87, cliente_slug: "n97", cliente_conta_id: 42, titulo: "Fechamento Julho", periodo: "2026-07", status: "publicado", publicado: true, token_publico: "tok-julho", created_at: "2026-07-28T10:00:00Z", published_at: "2026-07-28T11:00:00Z" },
    { id: 803, tipo: "fechamento_mensal", cliente_id: 87, cliente_slug: "n97", cliente_conta_id: 42, titulo: "Fechamento Junho", periodo: "2026-06", status: "rascunho", publicado: false, token_publico: null, created_at: "2026-06-29T10:00:00Z", published_at: null },
    { id: 804, tipo: "fechamento_mensal", cliente_id: 87, cliente_slug: "n97", cliente_conta_id: null, titulo: "Fechamento Maio (legado)", periodo: "2026-05", status: "rascunho", publicado: false, token_publico: null, created_at: "2026-05-30T10:00:00Z", published_at: null },
  ];
}
let ultimaListaEntregasUrl = null;
resetEntregas();

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
    // F4.2 — escrita ANTES da leitura: /entregas-cliente/:id/publicar tem
    // o mesmo prefixo da listagem.
    const acaoMatch = url.match(/\/entregas-cliente\/(\d+)\/(publicar|despublicar)/);
    if (acaoMatch) {
      const alvo = entregasFake.find((e) => e.id === Number(acaoMatch[1]));
      if (!alvo) { await respond("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 404, responseHeaders: [...cors, { name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify({ ok: false, erro: "Entrega não encontrada." })).toString("base64") }); return; }
      if (acaoMatch[2] === "publicar") {
        alvo.publicado = true;
        alvo.status = "publicado";
        alvo.token_publico = alvo.token_publico || `tok-${alvo.id}`;
        alvo.published_at = "2026-09-05T09:00:00Z";
      } else {
        alvo.publicado = false;
        alvo.status = "rascunho";
        alvo.token_publico = null;
        alvo.published_at = null;
      }
      await json({ ok: true, entrega: alvo });
      return;
    }
    // Conv#3 — processamento nativo (POST multipart). Devolve summary +
    // competência declarada; `competenciaFake` controla a divergência.
    if (url.includes("/fechamentos/financeiro")) {
      fechamentoRequestCount += 1;
      if (processamentoFake) { await json(processamentoFake); return; }
      await json({
        ok: true,
        summary: { marketplace: "meli", grossRevenueTotal: 120000, paidRevenueTotal: 110000, contributionProfitTotal: 21000, averageContributionMargin: 0.19, finalResult: 15000, tacos: 0.04 },
        competencia: competenciaFake,
        detailedRows: [{ id: "MLB1", mc: 0.19 }],
        unmatchedIds: [],
      });
      return;
    }
    // GET /entregas-cliente/:id — a apresentação da entrega (payload_json),
    // lida pelo painel "Entrega para o cliente". Shape do controller real.
    const umaMatch = url.match(/\/entregas-cliente\/(\d+)(?:[?#]|$)/);
    if (umaMatch && req.method === "GET") {
      const alvo = entregasFake.find((e) => e.id === Number(umaMatch[1]));
      if (!alvo) { await respond("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 404, responseHeaders: [...cors, { name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify({ ok: false, erro: "Entrega não encontrada." })).toString("base64") }); return; }
      await json({ ok: true, entrega: { ...alvo, payload_json: { entrega: { destaques: [], atencoes: [], prioridades: { alta: [], media: [], baixa: [] } } } } });
      return;
    }
    if (url.includes("/entregas-cliente")) {
      // POST sem sufixo /:id/(des)publicar = criar entrega
      if (req.method === "POST") {
        const nova = { id: 900, tipo: "fechamento_mensal", cliente_slug: "n97", cliente_conta_id: 42, periodo: "2026-08", status: "rascunho", publicado: false, token_publico: null, created_at: "2026-09-06T10:00:00Z", published_at: null };
        entregasFake = [nova, ...entregasFake];
        await respond("Fetch.fulfillRequest", { requestId: params.requestId, responseCode: 201, responseHeaders: [...cors, { name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify({ ok: true, entrega: nova })).toString("base64") });
        return;
      }
      entregasRequestCount += 1;
      ultimaListaEntregasUrl = url;
      if (entregasFalham) { await respond("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionRefused" }); return; }
      await json({ ok: true, total: entregasFake.length, entregas: entregasFake });
      return;
    }
    if (url.includes("/base-vinculos")) { await json({ ok: true, bases: baseVinculosFake }); return; }
    // Editor rápido de custo (mesmos endpoints de Bases): padrão + upsert.
    // Atualizar por planilha: o parser REAL só lê (não grava); o fake devolve o que
    // o leitor devolveria para a planilha "preenchida" do cenário.
    if (/\/bases\/assistente\/preview/.test(url) && req.method === "POST") { await json(previewPlanilhaFake); return; }
    if (/\/bases\/[^/]+\/custos\/padrao/.test(url)) { await json({ ok: true, padrao: { imposto_percentual: 0.08, taxa_fixa: 0 } }); return; } // fração, como o banco guarda
    if (/\/bases\/([^/?#]+)(?:[?#]|$)/.test(url) && req.method === "GET") {
      const slug = url.match(/\/bases\/([^/?#]+)/)[1];
      await json({ ok: true, baseId: slug, nome: slug, marketplace: "meli", total: 0, dados: baseCustosFake[slug] || {} });
      return;
    }
    if (/\/bases\/[^/]+\/custos\/upsert/.test(url) && req.method === "POST") {
      upsertsFake.push(JSON.parse(req.postData || "{}"));
      await json({ ok: true, acao: "criado" });
      return;
    }
    // Salvar a planilha de custos como base (o mesmo comando da tela Bases):
    // grava, vincula à conta — e a partir daí o status enxerga a base nova.
    if (/\/importar-base(?:[?#]|$)/.test(url) && req.method === "POST") {
      const corpo = corpoDoPedido(req);
      corposImportarBase.push(corpo);
      statusSyncFake = { ...statusSyncFake, base: { vinculada: true, id: 555, slug: "custos-n97-comercial-meli", nome: "Custos - N97 Comercial - MeLi", atualizadaEm: "2026-11-10T18:00:00Z", aplicadaNoSync: false } };
      await json({ ok: true, mensagem: "Base criada e planilha importada com sucesso", base: "custos-n97-comercial-meli", total: 3, vinculo: { base_id: 555, cliente_conta_id: 42 } });
      return;
    }
    // Modo API: status do sync da competência e o processamento pelos dados
    // sincronizados (mesmo formato da planilha, + sync usado).
    if (/\/financeiro\/[^/]+\/fechamento-api\/status/.test(url) && req.method === "GET") { await json(statusSyncFake); return; }
    if (/\/financeiro\/[^/]+\/fechamento-api(?:[?#]|$)/.test(url) && req.method === "POST") {
      fechamentoRequestCount += 1;
      corposFechamentoApi.push(corpoDoPedido(req));
      const base = processamentoFake || {
        ok: true,
        summary: { marketplace: "meli", grossRevenueTotal: 120000, paidRevenueTotal: 110000, contributionProfitTotal: 21000, averageContributionMargin: 0.19, finalResult: 15000, tacos: 0.04 },
        competencia: competenciaFake,
        detailedRows: [{ id: "MLB1", mc: 0.19 }],
        unmatchedIds: [],
      };
      await json({ ...base, fonteVendas: "api", sync: statusSyncFake.sync });
      return;
    }
    if (url.includes("/financeiro/")) { await json(financeiroPayload); return; }

    await respond("Fetch.failRequest", { requestId: params.requestId, errorReason: "ConnectionRefused" });
  };
  return consoleErrors;
}

async function run() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const server = await startServer();
  const serverPort = server.address().port;
  const debugPort = 27000 + Math.floor(Math.random() * 1000);
  const chrome = childProcess.spawn("google-chrome", [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--window-size=1440,1200",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=/tmp/vf-fin-v3-shell-ui-${process.pid}`, "about:blank",
  ], { stdio: "ignore" });

  let cdp;
  try {
    await waitChrome(debugPort);
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    const consoleErrors = wireFetchInterception(cdp);

    // As fixtures deste teste são ancoradas em Agosto/2026 ("período em
    // tela" default, quando a URL não traz `?periodo=`, vem de
    // competenciaAtual() = mês corrente REAL). Sem congelar o relógio da
    // página, o teste vira uma bomba-relógio: passa enquanto "hoje" cai em
    // agosto/2026 e falha sozinho a partir de setembro/2026, sem nenhuma
    // regressão de produto envolvida.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(function(){
        var FIXED_NOW = new Date("2026-08-26T15:00:00.000Z").getTime();
        var RealDate = Date;
        function FakeDate() {
          if (arguments.length === 0) return new RealDate(FIXED_NOW);
          return new (Function.prototype.bind.apply(RealDate, [null].concat(Array.prototype.slice.call(arguments))))();
        }
        FakeDate.prototype = RealDate.prototype;
        FakeDate.now = function () { return FIXED_NOW; };
        FakeDate.parse = RealDate.parse;
        FakeDate.UTC = RealDate.UTC;
        window.Date = FakeDate;
      })();`,
    });

    // Navegar com requisições da página anterior ainda em voo (pausadas no
    // Fetch) às vezes aborta as primeiras chamadas da página nova
    // (ERR_ABORTED em /me/context) e a página nunca chega a READY — corrida
    // do harness, não do produto, já presente na versão anterior deste smoke.
    // Passar por about:blank encerra a página antiga antes de abrir a nova.
    async function navegar(url) {
      await cdp.send("Page.navigate", { url: "about:blank" });
      await waitFor(cdp, "location.href === 'about:blank' && document.readyState === 'complete'", "about:blank não carregou");
      await sleep(100);
      await cdp.send("Page.navigate", { url });
    }

    async function seedAndGoto(qs) {
      await navegar(`http://127.0.0.1:${serverPort}/financeiro-v3.html`);
      await sleep(60);
      await cdp.evaluate(`
        localStorage.setItem("vf-token", "ui-test-token");
        localStorage.setItem("vf-user", JSON.stringify({ id: 12, nome: "Pedro Gomes", role: "admin" }));
        sessionStorage.clear();
      `);
      consoleErrors.length = 0;
      await navegar(`http://127.0.0.1:${serverPort}/financeiro-v3.html${qs ? "?" + qs : ""}`);
      await waitFor(cdp, "window.VF && window.VF.context", "vf-context não montou");
    }

    // ── Modelo B: uma tela só (a mesa do fechamento), sem abas. Histórico,
    // Relatórios, Preparar fechamento, Pendências, Detalhes e a Entrega
    // abrem em DRAWER (um por vez, renderizado em <body>). ───────────────────
    const MESA = ".vf-fin-mesa";
    const ETAPAS = 'aside[aria-label="Etapas do fechamento"]';
    const DRAWER = ".vf-drawer";
    const textoDe = (sel) => cdp.evaluate(`(function(){ var el = document.querySelector(${JSON.stringify(sel)}); return el ? el.innerText : null; })()`);
    // Clica no botão de texto exato dentro de `escopo` (seletor CSS).
    const clicarBotao = (escopo, rotulo) => cdp.evaluate(`
      (function(){ var raiz = document.querySelector(${JSON.stringify(escopo)}); if (!raiz) return false;
        var b = Array.prototype.find.call(raiz.querySelectorAll('button'), function(x){ return x.textContent.trim() === ${JSON.stringify(rotulo)}; });
        if (!b) return false; b.click(); return true; })()
    `);
    // Botão cujo texto COMEÇA com o rótulo (os CTAs do painel têm linha de apoio).
    const clicarBotaoQueComeca = (escopo, rotulo) => cdp.evaluate(`
      (function(){ var raiz = document.querySelector(${JSON.stringify(escopo)}); if (!raiz) return false;
        var b = Array.prototype.find.call(raiz.querySelectorAll('button'), function(x){ return x.textContent.trim().indexOf(${JSON.stringify(rotulo)}) === 0; });
        if (!b) return false; b.click(); return true; })()
    `);
    const botaoDesabilitado = (rotulo, escopo = "body") => cdp.evaluate(`
      (function(){ var raiz = document.querySelector(${JSON.stringify(escopo)}); var b = raiz && Array.prototype.find.call(raiz.querySelectorAll('button'), function(x){ return x.textContent.trim() === ${JSON.stringify(rotulo)}; }); return b ? b.disabled : null; })()
    `);
    async function esperarDrawer(titulo) {
      await waitFor(cdp, `(function(){ var d = document.querySelector(${JSON.stringify(DRAWER)}); return !!d && d.innerText.indexOf(${JSON.stringify(titulo)}) >= 0; })()`, `o drawer "${titulo}" não abriu`);
      await sleep(150);
    }
    async function fecharDrawer() {
      await cdp.evaluate(`(function(){ var b = document.querySelector(${JSON.stringify(`${DRAWER} button[aria-label="Fechar"]`)}); if (b) b.click(); })()`);
      await waitFor(cdp, `document.querySelector(${JSON.stringify(DRAWER)}) === null`, "o drawer não fechou");
      await sleep(80);
    }
    async function abrirDoCabecalho(rotulo) {
      assert.ok(await clicarBotao(".vf-fin-cabecalho-b__acoes", rotulo), `botão "${rotulo}" ausente no cabeçalho`);
      await esperarDrawer(rotulo);
    }
    // `origem`: rótulo do botão do seletor — "Planilha de vendas" (padrão
    // deste helper, para os fluxos de upload) ou "API do Mercado Livre". Só MELI
    // tem o seletor; Shopee segue sem ele.
    async function abrirPreparo(origem = "Planilha de vendas") {
      const ok = await cdp.evaluate(`(function(){ var b = document.querySelector(${JSON.stringify(`${ETAPAS} button[aria-label$=": Base de custos"]`)}); if (!b) return false; b.click(); return true; })()`);
      assert.ok(ok, "a etapa Base de custos deveria abrir o preparo");
      await esperarDrawer("Preparar fechamento");
      const escolhida = await cdp.evaluate(`(function(){
        var g = document.querySelector(${JSON.stringify(`${DRAWER} [role="group"][aria-label="Origem das vendas"]`)});
        if (!g) return null;
        var b = Array.prototype.find.call(g.querySelectorAll('button'), function(x){ return x.textContent.trim() === ${JSON.stringify(origem)}; });
        if (!b) return false; b.click(); return true; })()`);
      if (escolhida === false) throw new Error(`origem "${origem}" ausente no preparo`);
      if (escolhida) await sleep(120);
    }
    async function subirArquivo(seletor, arquivo) {
      const doc = await cdp.send("DOM.getDocument", { depth: -1 });
      const no = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: seletor });
      assert.ok(no.nodeId, `campo de arquivo ausente: ${seletor}`);
      await cdp.send("DOM.setFileInputFiles", { files: [arquivo], nodeId: no.nodeId });
      await sleep(150);
    }
    async function processarNoPreparo() {
      assert.ok(await clicarBotao(DRAWER, "Processar fechamento"), "botão Processar fechamento ausente no preparo");
      await waitFor(cdp, `document.querySelector('[data-testid="kpis-processamento"]') !== null`, "o resultado do processamento não apareceu na mesa");
      await semAnimacao();
    }
    // Medidas de layout só depois das animações de entrada (os cartões entram
    // deslocados por transform e falseariam o alinhamento).
    const semAnimacao = async () => {
      await waitFor(cdp, "document.getAnimations().every(function(a){ return a.playState !== 'running'; })", "as animações de entrada não terminaram");
      await sleep(80);
    };
    const ESPERA_MESA = `document.querySelector(${JSON.stringify(ETAPAS)}) !== null`;

    // O bundle que a página TEM que carregar é o que o build gravou em
    // financeiro-v3.html — o teste lê do disco, nunca de um hash fixo.
    const htmlDoBuild = fs.readFileSync(path.join(PORTAL_DIR, "financeiro-v3.html"), "utf8");
    const jsDoBuild = (htmlDoBuild.match(/src="\.\/(assets\/financeiro-v3\/financeiro-v3-[^"]+\.js)"/) || [])[1];
    const cssDoBuild = (htmlDoBuild.match(/href="\.\/(assets\/financeiro-v3\/financeiro-v3-[^"]+\.css)"/) || [])[1];

    // ═══ 1. Deep link com conta real, caminho feliz ═══
    financeiroPayload = payloadFeliz();
    await seedAndGoto("cliente=n97&conta=42");
    await waitFor(cdp, "window.VF.context.getState() === 'READY'", "n97/42 não chegou a READY");
    await waitFor(cdp, ESPERA_MESA, "a mesa do Financeiro não renderizou");
    await sleep(200);

    await check("F4.1 — Shell mostra Cliente/Operação corretos, item Financeiro ativo na sidebar", async () => {
      const texto = await cdp.evaluate("document.querySelector('.vf-shell__sidebar').innerText");
      assert.ok(texto.includes("N97 Comercial"), `sidebar deveria mostrar N97 Comercial: ${texto}`);
    });

    await check("F4.1 — link cruzado para o Financeiro legado presente no cabeçalho", async () => {
      const href = await cdp.evaluate(`(function(){ var a = document.querySelector('.vf-page-header__description a'); return a ? a.getAttribute('href') : null; })()`);
      assert.ok(href && href.includes("financeiro.html"), `link para o legado ausente/incorreto: ${href}`);
    });

    await check("Build — a página carrega o bundle gravado em financeiro-v3.html (JS e CSS existem e respondem 200)", async () => {
      assert.ok(jsDoBuild && cssDoBuild, `financeiro-v3.html deveria referenciar o JS e o CSS do build: ${jsDoBuild} / ${cssDoBuild}`);
      assert.ok(fs.existsSync(path.join(PORTAL_DIR, jsDoBuild)), `o JS referenciado não existe no disco: ${jsDoBuild}`);
      assert.ok(fs.existsSync(path.join(PORTAL_DIR, cssDoBuild)), `o CSS referenciado não existe no disco: ${cssDoBuild}`);
      const carregados = await cdp.evaluate(`(function(){
        var s = document.querySelector('script[src*="assets/financeiro-v3/"]');
        var l = document.querySelector('link[rel="stylesheet"][href*="assets/financeiro-v3/"]');
        var rec = performance.getEntriesByType('resource').map(function(e){ return { nome: e.name, status: e.responseStatus }; });
        return { js: s && s.getAttribute('src'), css: l && l.getAttribute('href'), rec: rec };
      })()`);
      assert.strictEqual(carregados.js, `./${jsDoBuild}`, `a página não carregou o JS do build: ${carregados.js}`);
      assert.strictEqual(carregados.css, `./${cssDoBuild}`, `a página não carregou o CSS do build: ${carregados.css}`);
      for (const arq of [jsDoBuild, cssDoBuild]) {
        const r = carregados.rec.find((e) => e.nome.endsWith(arq));
        assert.ok(r, `o navegador não buscou ${arq}`);
        if (r.status !== undefined && r.status !== 0) assert.strictEqual(r.status, 200, `${arq} respondeu ${r.status}`);
      }
    });

    await check("Modelo B — sem abas: cabeçalho com competência, status desta conta e os botões Histórico/Relatórios", async () => {
      const abas = await cdp.evaluate("document.querySelectorAll('.vf-tab, [role=\"tab\"]').length");
      assert.strictEqual(abas, 0, "o modelo B não tem abas");
      const competencia = await textoDe('[data-testid="competencia-extenso"]');
      assert.ok(/Agosto\/2026/.test(competencia || ""), `competência em tela: ${competencia}`);
      const status = await textoDe('[data-testid="status-competencia"]');
      assert.strictEqual(status, "Publicado", `Agosto tem entrega publicada desta conta: ${status}`);
      const botoes = await textoDe(".vf-fin-cabecalho-b__acoes");
      assert.ok(/Histórico/.test(botoes) && /Relatórios/.test(botoes), `os botões do cabeçalho deveriam existir: ${botoes}`);
      // Cliente e conta moram na sidebar do Shell: nada de barra de contexto.
      assert.strictEqual(await textoDe('[data-testid="contexto-fechamento"]'), null, "a barra de contexto saiu da página");
    });

    await check("Modelo B — painel com as seis etapas; fechamento salvo marca as etapas de preparo como feitas", async () => {
      const etapas = await cdp.evaluate(`Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(`${ETAPAS} [data-etapa]`)}), function(e){ return [e.dataset.etapa, e.dataset.estado]; })`);
      assert.deepStrictEqual(etapas.map((e) => e[0]), ["base", "arquivos", "ajustes", "processar", "pendencias", "publicar"]);
      assert.deepStrictEqual(etapas.find((e) => e[0] === "publicar"), ["publicar", "feita"], "Agosto publicado: a última etapa está feita");
      const texto = await textoDe(ETAPAS);
      assert.ok(/Fechamento de Agosto\/2026/.test(texto), `título do painel: ${texto.slice(0, 120)}`);
    });

    await check("Paridade — Fechamento salvo (legado, sem summary): composição renderiza, sem custo mostra '—', nunca R$0", async () => {
      const texto = await textoDe(`${MESA} .vf-fin-mesa-vazio.is-legado`);
      assert.ok(texto, "o cartão do fechamento salvo deveria estar na mesa");
      assert.ok(texto.includes("Faturamento bruto"), `composição ausente: ${texto}`);
      assert.ok(/Custo de produto[\s\S]*—/.test(texto), `custo ausente deveria mostrar '—', não R$0: ${texto}`);
      assert.ok(!texto.includes("R$ 0,00"), `nenhum valor ausente pode virar R$ 0,00: ${texto}`);
    });

    await check("Paridade — conciliação Mercado Pago continua à vista na mesa (MELI), com status e cobertura", async () => {
      const abriu = await cdp.evaluate(`(function(){ var d = document.querySelector(${JSON.stringify(`${MESA} details.vf-fin-disclosure`)}); if (!d) return false; d.open = true; return true; })()`);
      assert.ok(abriu, "o bloco de conciliação Mercado Pago deveria existir na mesa (MELI)");
      await sleep(80);
      const texto = await textoDe(`${MESA} details.vf-fin-disclosure`);
      assert.ok(/Conciliação Mercado Pago/.test(texto), `título do bloco ausente: ${texto}`);
      assert.ok(/Conciliação parcial/.test(texto), `status de conciliação ausente: ${texto}`);
      assert.ok(/93,8%|93.8%/.test(texto), `cobertura não encontrada: ${texto}`);
    });

    await check("F4.2 — entrega publicada: o painel oferece Copiar/Abrir link; a Entrega age sobre o período EM TELA, nomeado", async () => {
      const painel = await textoDe(ETAPAS);
      assert.ok(/Copiar link/.test(painel) && /Abrir link/.test(painel), `entrega publicada: o painel deveria oferecer o link: ${painel}`);
      const href = await cdp.evaluate(`(function(){ var a = Array.prototype.find.call(document.querySelectorAll(${JSON.stringify(`${ETAPAS} a`)}), function(x){ return x.textContent.trim() === 'Abrir link'; }); return a ? a.getAttribute('href') : null; })()`);
      assert.ok(href && href.includes("relatorio-publico.html?token=tok-agosto"), `link público: ${href}`);
      assert.ok(await clicarBotao(ETAPAS, "Apresentação e link"), "botão 'Apresentação e link' ausente");
      await esperarDrawer("Entrega para o cliente");
      const cliente = await cdp.evaluate(`(function(){ var dl = document.querySelector(${JSON.stringify(`${DRAWER} [data-testid="identidade-entrega"]`)}); if (!dl) return null; var dt = Array.prototype.find.call(dl.querySelectorAll('dt'), function(d){ return /cliente/i.test(d.textContent); }); return dt && dt.nextElementSibling ? dt.nextElementSibling.textContent : null; })()`);
      assert.strictEqual(cliente, "N97 Comercial", `"Entrega para o cliente" deveria mostrar o nome do cliente: ${cliente}`);
      // Entrega que já teve link abre com a apresentação RECOLHIDA e, aberta, em leitura.
      const apresentacao = await cdp.evaluate(`(function(){ var d = document.querySelector(${JSON.stringify(`${DRAWER} details.vf-fin-disclosure`)}); if (!d) return null; var fechada = !d.open; d.open = true; return { fechada: fechada }; })()`);
      assert.ok(apresentacao && apresentacao.fechada, "a apresentação de uma entrega histórica deveria abrir recolhida");
      await waitFor(cdp, `(document.querySelector(${JSON.stringify(DRAWER)}) || {innerText:''}).innerText.indexOf('o conteúdo é histórico') >= 0`, "a entrega que já teve link deveria se declarar histórica (somente leitura)");
      assert.strictEqual(await clicarBotao(DRAWER, "Salvar alterações"), false, "entrega histórica não pode oferecer 'Salvar alterações'");
      assert.ok(await clicarBotao(DRAWER, "Despublicar"), "botão Despublicar ausente");
      await sleep(120);
      const confirm = await textoDe(`${DRAWER} .vf-fin-confirm`);
      assert.ok(/Agosto\/2026/.test(confirm), `a confirmação tem que nomear o período em tela (Agosto/2026): ${confirm}`);
      assert.ok(await clicarBotao(`${DRAWER} .vf-fin-confirm`, "Cancelar"), "botão Cancelar ausente");
      await sleep(80);
      assert.strictEqual(entregasFake.find((e) => e.id === 801).publicado, true, "Cancelar não pode ter despublicado nada");
      await fecharDrawer();
    });

    await check("Paridade — Relatórios (drawer do cabeçalho): lista desta conta + legada, cada linha identificada", async () => {
      await abrirDoCabecalho("Relatórios");
      assert.ok(/cliente_conta_id=42/.test(ultimaListaEntregasUrl || ""), `a lista deveria ser pedida pela conta em tela: ${ultimaListaEntregasUrl}`);
      const linhas = await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(`${DRAWER} tbody tr`)}).length`);
      assert.strictEqual(linhas, 4, `esperado 3 entregas da conta + 1 legada, achei ${linhas}`);
      const daConta = await textoDe(`${DRAWER} tbody tr[data-entrega="801"]`);
      assert.ok(/Mercado Livre 1/.test(daConta), `entrega desta conta deveria nomear a conta: ${daConta}`);
      const legada = await textoDe(`${DRAWER} tbody tr[data-entrega="804"]`);
      assert.ok(/Legado · operação não registrada/.test(legada), `a legada não pode ser atribuída à conta em tela: ${legada}`);
      assert.ok(!/Mercado Livre 1/.test(legada), `a legada não pode levar o nome da conta: ${legada}`);
      const rascunho = await cdp.evaluate(`(function(){ var tr = document.querySelector(${JSON.stringify(`${DRAWER} tbody tr[data-entrega="803"]`)}); return { texto: tr.innerText, publicadoEm: tr.cells[6].innerText.trim() }; })()`);
      assert.ok(!/Abrir/.test(rascunho.texto), `rascunho não pode oferecer link público: ${rascunho.texto}`);
      assert.ok(/Publicar/.test(rascunho.texto), `rascunho deveria oferecer Publicar: ${rascunho.texto}`);
      assert.strictEqual(rascunho.publicadoEm, "—", `rascunho deveria mostrar '—' em "Publicado em": ${rascunho.publicadoEm}`);
    });

    await check("F4.2 — a linha da competência em tela é marcada", async () => {
      const marcadas = await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(`${DRAWER} tbody tr.is-destacada`)}).length`);
      assert.strictEqual(marcadas, 1, `esperado exatamente 1 linha marcada como período em tela, achei ${marcadas}`);
      const texto = await textoDe(`${DRAWER} tbody tr.is-destacada`);
      assert.ok(/Agosto\/2026/.test(texto), `a linha marcada deveria ser a de Agosto/2026: ${texto}`);
      const aviso = await textoDe(DRAWER);
      assert.ok(/Entregas desta operação e as legadas do cliente/.test(aviso), `o escopo da lista deveria estar dito na tela: ${aviso.slice(0, 200)}`);
    });

    const LINHA_JUNHO = `${DRAWER} tbody tr[data-entrega="803"]`;
    await check("F4.2 — um clique não publica: a confirmação aparece e NOMEIA a competência", async () => {
      const antes = entregasRequestCount;
      assert.ok(await clicarBotao(LINHA_JUNHO, "Publicar"), "botão Publicar ausente na linha de Junho");
      await sleep(120);
      const texto = await textoDe(`${LINHA_JUNHO} .vf-fin-confirm`);
      assert.ok(/Publicar Junho\/2026\?/.test(texto), `a confirmação deveria nomear a competência: ${texto}`);
      assert.strictEqual(entregasRequestCount, antes, "um clique só não pode ter disparado nenhuma requisição");
      assert.strictEqual(entregasFake.find((e) => e.id === 803).publicado, false, "nada podia ter sido publicado ainda");
    });

    await check("F4.2 — confirmar publica de verdade e a tela relê do servidor (estado autoritativo, não remendo local)", async () => {
      const antes = entregasRequestCount;
      assert.ok(await clicarBotao(`${LINHA_JUNHO} .vf-fin-confirm`, "Publicar"), "botão de confirmação ausente");
      await waitFor(cdp, `(document.querySelector(${JSON.stringify(LINHA_JUNHO)}) || {innerText:''}).innerText.indexOf('Despublicar') >= 0`, "a linha não passou a publicada");
      assert.strictEqual(entregasFake.find((e) => e.id === 803).publicado, true, "o servidor deveria ter registrado a publicação");
      assert.ok(entregasRequestCount > antes, "a tela deveria ter relido a lista depois da escrita");
      const linha = await cdp.evaluate(`(function(){ var tr = document.querySelector(${JSON.stringify(LINHA_JUNHO)}); return { texto: tr.innerText, publicadoEm: tr.cells[6].innerText.trim() }; })()`);
      assert.ok(/Abrir/.test(linha.texto), `entrega publicada deveria oferecer o link público: ${linha.texto}`);
      assert.notStrictEqual(linha.publicadoEm, "—", `"Publicado em" não pode continuar vazio: ${linha.publicadoEm}`);
    });

    await check("F4.2 — despublicar revoga o link (a válvula que o Financeiro legado nunca ligou)", async () => {
      assert.ok(await clicarBotao(LINHA_JUNHO, "Despublicar"), "botão Despublicar ausente");
      await sleep(120);
      const confirm = await textoDe(`${LINHA_JUNHO} .vf-fin-confirm`);
      assert.ok(/Despublicar Junho\/2026\?/.test(confirm), `confirmação de despublicar deveria nomear a competência: ${confirm}`);
      assert.ok(await clicarBotao(`${LINHA_JUNHO} .vf-fin-confirm`, "Despublicar"), "botão de confirmação ausente");
      await waitFor(cdp, `(document.querySelector(${JSON.stringify(LINHA_JUNHO)}) || {innerText:''}).innerText.indexOf('Publicar') >= 0`, "a linha não voltou a rascunho");
      const alvo = entregasFake.find((e) => e.id === 803);
      assert.strictEqual(alvo.publicado, false);
      assert.strictEqual(alvo.token_publico, null, "o token público precisa ser revogado");
      await fecharDrawer();
    });

    await check("Paridade — Histórico (drawer do cabeçalho): 12 competências desta conta, mais recente primeiro, legada sinalizada à parte", async () => {
      await abrirDoCabecalho("Histórico");
      const itens = await cdp.evaluate(`Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(`${DRAWER} .vf-fin-historico__item`)}), function(li){ return { m: li.getAttribute('data-competencia'), t: li.innerText }; })`);
      assert.strictEqual(itens.length, 12, `esperadas 12 competências, achei ${itens.length}`);
      assert.strictEqual(itens[0].m, "2026-08", `histórico deveria começar por Agosto/2026 (mais recente): ${itens[0].m}`);
      assert.ok(/Agosto\/2026/.test(itens[0].t) && /Publicado/.test(itens[0].t), `Agosto: ${itens[0].t}`);
      const junho = itens.find((i) => i.m === "2026-06");
      assert.ok(junho && /Rascunho salvo/.test(junho.t), `Junho voltou a rascunho: ${junho && junho.t}`);
      const maio = itens.find((i) => i.m === "2026-05");
      assert.ok(maio && /Sem fechamento/.test(maio.t), `a legada não conta como fechamento desta conta: ${maio && maio.t}`);
      assert.ok(/existe fechamento legado \(sem conta\)/.test(maio.t), `a legada deveria ser sinalizada: ${maio.t}`);
      await fecharDrawer();
    });

    await check("Paridade — abrir e fechar os drawers não muda a competência nem desmonta a mesa", async () => {
      const competencia = await textoDe('[data-testid="competencia-extenso"]');
      assert.ok(/Agosto\/2026/.test(competencia || ""), `a competência não podia mudar: ${competencia}`);
      const salvo = await textoDe(`${MESA} .vf-fin-mesa-vazio.is-legado`);
      assert.ok(salvo && salvo.includes("Faturamento bruto"), "o Fechamento salvo deveria continuar na mesa");
    });

    await check("Paridade — no Histórico, escolher um mês troca a competência e fecha o drawer", async () => {
      await abrirDoCabecalho("Histórico");
      await cdp.evaluate(`(function(){ var li = document.querySelector(${JSON.stringify(`${DRAWER} .vf-fin-historico__item[data-competencia="2026-07"] .vf-fin-historico__periodo`)}); li.click(); })()`);
      await waitFor(cdp, `document.querySelector(${JSON.stringify(DRAWER)}) === null`, "escolher Julho deveria fechar o Histórico");
      await waitFor(cdp, `/Julho\\/2026/.test((document.querySelector('[data-testid="competencia-extenso"]') || {}).innerText || '')`, "a competência deveria ser Julho/2026");
      await waitFor(cdp, `(document.querySelector('[data-testid="status-competencia"]') || {}).innerText === 'Publicado'`, "Julho tem entrega publicada desta conta");
    });

    /* ── F4.2 — modo degradado: a lista operacional cai, a leitura fica ── */
    entregasFalham = true;
    await navegar(`http://127.0.0.1:${serverPort}/financeiro-v3.html?cliente=n97&conta=42&_r=deg`);
    await waitFor(cdp, "window.VF && window.VF.context && window.VF.context.getState() === 'READY'", "reload não voltou a READY");
    await waitFor(cdp, ESPERA_MESA, "a mesa não renderizou");
    await sleep(200);

    await check("F4.2 — /entregas-cliente fora do ar: Relatórios continua em LEITURA, com motivo e retry, sem botão inerte", async () => {
      await abrirDoCabecalho("Relatórios");
      await sleep(100);
      const texto = await textoDe(DRAWER);
      assert.ok(/Ações indisponíveis no momento/.test(texto), `deveria explicar por que as ações sumiram: ${texto}`);
      assert.ok(/Tentar novamente/.test(texto), "o modo degradado precisa oferecer retry");
      assert.ok(!/Publicar/.test(texto), `sem id não existe ação — nenhum botão Publicar podia aparecer: ${texto}`);
      const linhas = await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(`${DRAWER} tbody tr`)}).length`);
      assert.strictEqual(linhas, 3, `a leitura do payload do Financeiro deveria sobreviver, achei ${linhas} linhas`);
      await fecharDrawer();
    });

    entregasFalham = false;
    resetEntregas();
    await navegar(`http://127.0.0.1:${serverPort}/financeiro-v3.html?cliente=n97&conta=42&_r=1b`);
    await waitFor(cdp, "window.VF && window.VF.context && window.VF.context.getState() === 'READY'", "reload não voltou a READY");
    await waitFor(cdp, ESPERA_MESA, "a mesa não renderizou");
    await sleep(300);

    const shot1 = path.join(SHOTS_DIR, "financeiro-v3-feliz.png");
    const png1 = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(shot1, Buffer.from(png1.data, "base64"));
    console.log(`   screenshot: ${shot1}`);

    // ═══ 2. Sem fechamento no período — estado vazio honesto, não erro ═══
    financeiroPayload = payloadSemFechamento();
    entregasFake = []; // nenhuma entrega desta conta (nem legada) no período
    await navegar(`http://127.0.0.1:${serverPort}/financeiro-v3.html?cliente=n97&conta=42&_r=2`);
    await waitFor(cdp, "window.VF && window.VF.context && window.VF.context.getState() === 'READY'", "reload não voltou a READY");
    await waitFor(cdp, ESPERA_MESA, "a mesa não renderizou após reload");
    await sleep(200);

    await check("Conv#3 §10 — sem fechamento no período: 'Sem fechamento', mesa vazia honesta e o próximo passo é processar as vendas sincronizadas", async () => {
      await waitFor(cdp, `(document.querySelector('[data-testid="status-competencia"]') || {}).innerText === 'Sem fechamento'`, "o status da competência deveria ser 'Sem fechamento'");
      const vazio = await textoDe(`${MESA} .vf-fin-mesa-vazio`);
      assert.ok(/Agosto\/2026 ainda não foi fechado/.test(vazio || ""), `estado vazio ausente: ${vazio}`);
      assert.ok(!/R\$ 0,00/.test(await textoDe(MESA)), "sem fechamento não é R\$ 0,00");
      const painel = await textoDe(ETAPAS);
      assert.ok(/Processar fechamento/.test(painel), `com as vendas sincronizadas, o painel deveria levar a processar: ${painel}`);
      assert.ok(!/Apresentação/.test(painel), "sem entrega desta conta, não existe atalho para a apresentação");
      const temFallback = await cdp.evaluate(`document.querySelector('.vf-page-header__description a[href*="financeiro.html"]') !== null`);
      assert.ok(temFallback, "o Financeiro legado deve continuar acessível como fallback");
    });

    await check("Modo API — MELI processa pelos dados sincronizados: sem upload de vendas nem de custos, o preparo mostra a API e o resultado nasce na mesa", async () => {
      const antes = fechamentoRequestCount;
      assert.ok(await clicarBotaoQueComeca(ETAPAS, "Processar fechamento"), "o próximo passo deveria ser processar pela API");
      await waitFor(cdp, `document.querySelector('[data-testid="kpis-processamento"]') !== null`, "o resultado do processamento pela API não apareceu na mesa");
      await semAnimacao();
      assert.strictEqual(fechamentoRequestCount, antes + 1, "processar deveria chamar POST /fechamento-api uma vez");
      const corpo = corposFechamentoApi.at(-1);
      assert.strictEqual(corpo.periodo, "2026-08", `o período enviado deveria ser o da tela: ${JSON.stringify(corpo)}`);
      assert.strictEqual(corpo.clienteContaId, 42, "a conta enviada deveria ser a da tela");
      await abrirPreparo("API do Mercado Livre");
      const apiAtiva = await cdp.evaluate(`(function(){ var g = document.querySelector(${JSON.stringify(`${DRAWER} [role="group"][aria-label="Origem das vendas"]`)}); var b = g && Array.prototype.find.call(g.querySelectorAll('button'), function(x){ return x.textContent.trim() === "API do Mercado Livre"; }); return !!b && b.getAttribute("aria-pressed") === "true"; })()`);
      assert.ok(apiAtiva, "o preparo deveria mostrar a API do Mercado Livre como origem");
      const temUpload = await cdp.evaluate(`!!document.querySelector(${JSON.stringify(`${DRAWER} input[type="file"]`)})`);
      assert.ok(!temUpload, "no modo API não existe campo de upload");
      await fecharDrawer();
    });

    const shot2 = path.join(SHOTS_DIR, "financeiro-v3-sem-fechamento.png");
    const png2 = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(shot2, Buffer.from(png2.data, "base64"));
    console.log(`   screenshot: ${shot2}`);

    // ═══ 2a. Fase 2 — custos no modo API. Conta SEM base: o card Custos
    // destaca a planilha de custos; com ela o fechamento vai em multipart
    // (custosOrigem=upload); "Salvar como base" grava pelo /importar-base e
    // reprocessa com a base nova (custosOrigem=base). Conta COM base (que
    // mudou depois do sync): salvar fica desabilitado, com link para Bases. ═══
    const custosFake = path.join(SHOTS_DIR, "custos-fake.xlsx");
    fs.writeFileSync(custosFake, "planilha-de-custos-fake");
    const statusSyncOriginal = statusSyncFake;
    statusSyncFake = { ...statusSyncOriginal, base: { vinculada: false, id: null, slug: null, nome: null, atualizadaEm: null, aplicadaNoSync: false } };
    corposImportarBase = [];
    entregasFake = [];
    await navegar(`http://127.0.0.1:${serverPort}/financeiro-v3.html?cliente=n97&conta=42&periodo=2026-08&_r=api-custos`);
    await waitFor(cdp, "window.VF && window.VF.context && window.VF.context.getState() === 'READY'", "reload não voltou a READY (custos API)");
    await waitFor(cdp, ESPERA_MESA, "a mesa não renderizou (custos API)");
    await sleep(200);

    await check("Custos API — conta sem base: o card avisa que sem custos não há lucro e destaca a planilha de custos", async () => {
      await abrirPreparo("API do Mercado Livre");
      await waitFor(cdp, `document.querySelector('[data-testid="custos-modo-api"]') !== null`, "o card Custos do modo API não apareceu");
      const card = await textoDe('[data-testid="custos-modo-api"]');
      assert.ok(/Esta conta não tem base de custos vinculada/.test(card), `o card deveria dizer que não há base: ${card}`);
      assert.ok(/lucro .* não é calculado/.test(card), `o card deveria avisar que sem custos o lucro não sai: ${card}`);
      const destaque = await cdp.evaluate(`(function(){ var b = Array.prototype.find.call(document.querySelectorAll('[data-testid="custos-modo-api"] button'), function(x){ return x.textContent.trim() === "Usar planilha de custos"; }); return !!b && b.classList.contains("vf-btn--primary"); })()`);
      assert.ok(destaque, "sem base, 'Usar planilha de custos' vem em destaque (primário)");
    });

    await check("Custos API — planilha de custos: processa em multipart com custosOrigem=upload e o arquivo em costs", async () => {
      assert.ok(await clicarBotao('[data-testid="custos-modo-api"]', "Usar planilha de custos"), "botão Usar planilha de custos ausente");
      await sleep(100);
      await subirArquivo('input[aria-label="Planilha de custos"]', custosFake);
      const antes = fechamentoRequestCount;
      await processarNoPreparo();
      assert.strictEqual(fechamentoRequestCount, antes + 1, "processar deveria chamar POST /fechamento-api uma vez");
      const corpo = corposFechamentoApi.at(-1);
      assert.ok(corpo.multipart, `com planilha de custos o corpo deveria ser multipart: ${JSON.stringify(corpo)}`);
      assert.strictEqual(corpo.campos.custosOrigem, "upload", `custosOrigem deveria ser upload: ${JSON.stringify(corpo)}`);
      assert.strictEqual(corpo.campos.clienteContaId, "42");
      assert.strictEqual(corpo.campos.periodo, "2026-08");
      assert.deepStrictEqual(corpo.campos.costs, { arquivo: "custos-fake.xlsx" }, `o arquivo deveria ir em costs: ${JSON.stringify(corpo)}`);
      assert.strictEqual(corposImportarBase.length, 0, "sem marcar 'Salvar como base', nada é gravado em Bases");
    });

    await check("Custos API — salvar como base: grava pelo /importar-base (nome, conta, meli, confirmar) e reprocessa com custosOrigem=base", async () => {
      await abrirPreparo("API do Mercado Livre");
      const marcado = await cdp.evaluate(`(function(){ var c = document.querySelector('[data-testid="custos-modo-api"] input[type=checkbox]'); if (!c || c.disabled) return false; c.click(); return true; })()`);
      assert.ok(marcado, "o checkbox 'Salvar como base de custos' deveria estar habilitado numa conta sem base");
      await sleep(100);
      const card = await textoDe('[data-testid="custos-modo-api"]');
      assert.ok(/Salvar como base de custos de N97 Comercial/.test(card), `o checkbox deveria nomear cliente e conta: ${card}`);
      const nome = await cdp.evaluate(`(document.querySelector('[data-testid="custos-modo-api"] input[type=text]') || {}).value`);
      assert.strictEqual(nome, "Custos - N97 Comercial - MeLi", "nome padrão da base");
      const shot = path.join(SHOTS_DIR, "financeiro-v3-custos-api-salvar-base.png");
      const png = await cdp.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(shot, Buffer.from(png.data, "base64"));
      console.log(`   screenshot: ${shot}`);
      const antes = fechamentoRequestCount;
      assert.ok(await clicarBotao(DRAWER, "Reprocessar"), "botão Reprocessar ausente no preparo");
      const ate = Date.now() + 8000;
      while (fechamentoRequestCount === antes && Date.now() < ate) await sleep(50);
      assert.strictEqual(corposImportarBase.length, 1, "deveria chamar /importar-base uma vez");
      const imp = corposImportarBase[0];
      assert.ok(imp.multipart, "importar-base é multipart");
      assert.strictEqual(imp.campos.nomeBase, "Custos - N97 Comercial - MeLi");
      assert.strictEqual(imp.campos.marketplace, "meli");
      assert.strictEqual(imp.campos.confirmar, "true");
      assert.strictEqual(imp.campos.cliente_conta_id, "42");
      assert.deepStrictEqual(imp.campos.arquivo, { arquivo: "custos-fake.xlsx" });
      assert.strictEqual(fechamentoRequestCount, antes + 1, "depois de salvar a base, processa uma vez");
      const corpo = corposFechamentoApi.at(-1);
      assert.ok(!corpo.multipart, "com a base salva, o fechamento volta a ser JSON (sem arquivo)");
      assert.strictEqual(corpo.custosOrigem, "base", `com a base recém-salva, custosOrigem=base: ${JSON.stringify(corpo)}`);
    });

    // Conta COM base, que mudou depois do sync.
    statusSyncFake = { ...statusSyncOriginal, base: { vinculada: true, id: 900, slug: "base-n97", nome: "Base N97", atualizadaEm: "2026-09-10T12:00:00Z", aplicadaNoSync: false } };
    await navegar(`http://127.0.0.1:${serverPort}/financeiro-v3.html?cliente=n97&conta=42&periodo=2026-08&_r=api-custos-base`);
    await waitFor(cdp, "window.VF && window.VF.context && window.VF.context.getState() === 'READY'", "reload não voltou a READY (custos API com base)");
    await waitFor(cdp, ESPERA_MESA, "a mesa não renderizou (custos API com base)");
    await sleep(200);

    await check("Custos API — base mudou depois do sync: avisa e processa com custosOrigem=base; salvar como base fica desabilitado com link para Bases", async () => {
      await abrirPreparo("API do Mercado Livre");
      await waitFor(cdp, `document.querySelector('[data-testid="custos-modo-api"]') !== null`, "o card Custos do modo API não apareceu");
      let card = await textoDe('[data-testid="custos-modo-api"]');
      assert.ok(/Base N97/.test(card) && /atualizada em/.test(card), `o card deveria mostrar a base e quando foi atualizada: ${card}`);
      assert.ok(/A base mudou depois da última sincronização/.test(card), `o card deveria avisar que a base mudou: ${card}`);
      assert.ok(await clicarBotao('[data-testid="custos-modo-api"]', "Usar planilha de custos"), "botão Usar planilha de custos ausente");
      await sleep(100);
      await subirArquivo('input[aria-label="Planilha de custos"]', custosFake);
      const desabilitado = await cdp.evaluate(`(function(){ var c = document.querySelector('[data-testid="custos-modo-api"] input[type=checkbox]'); return c ? c.disabled : null; })()`);
      assert.strictEqual(desabilitado, true, "com base vinculada, salvar como base fica desabilitado");
      card = await textoDe('[data-testid="custos-modo-api"]');
      assert.ok(/Para atualizar a base existente, use a tela Bases/.test(card), `deveria orientar a usar a tela Bases: ${card}`);
      const href = await cdp.evaluate(`(function(){ var a = document.querySelector('[data-testid="custos-modo-api"] a[href="bases.html"]'); return a ? a.getAttribute("href") : null; })()`);
      assert.strictEqual(href, "bases.html");
      // Volta para a base (sem planilha) e processa: o padrão é recalcular com a base atual.
      assert.ok(await clicarBotao('[data-testid="custos-modo-api"]', "Voltar a usar a base vinculada"), "botão Voltar a usar a base vinculada ausente");
      await sleep(100);
      await processarNoPreparo();
      assert.strictEqual(corposFechamentoApi.at(-1).custosOrigem, "base", `base alterada depois do sync: padrão custosOrigem=base: ${JSON.stringify(corposFechamentoApi.at(-1))}`);
    });
    statusSyncFake = statusSyncOriginal;

    // ═══ 2b. Conv#3 §25 — E2E do fluxo NATIVO: preparo → processar →
    // resultado na mesa → salvar, com a competência divergente pedindo
    // confirmação ═══
    const planilhaFake = path.join(SHOTS_DIR, "vendas-fake.xlsx");
    fs.writeFileSync(planilhaFake, "planilha-de-vendas-fake");
    competenciaFake = { periodoSolicitado: "2026-08", periodoDetectado: "2026-07", divergente: true, motivo: "As datas das vendas caem em julho/2026." };
    fechamentoRequestCount = 0;
    resetEntregas();
    entregasFake = []; // agosto ainda não tem entrega
    await navegar(`http://127.0.0.1:${serverPort}/financeiro-v3.html?cliente=n97&conta=42&periodo=2026-08&_r=2b`);
    await waitFor(cdp, "window.VF && window.VF.context && window.VF.context.getState() === 'READY'", "reload não voltou a READY");
    await waitFor(cdp, ESPERA_MESA, "a mesa não renderizou");
    await sleep(200);

    await check("Conv#3 §25 — MELI com base vinculada: o preparo só pede a planilha de vendas, processa e o resultado nasce na mesa", async () => {
      await abrirPreparo();
      await waitFor(cdp, "document.querySelector('.vf-fin-base.is-encontrada') !== null", "a base vinculada de MELI não foi reconhecida");
      const semUploadCustos = await cdp.evaluate(`document.querySelector('input[aria-label="Planilha de custos"]') === null`);
      assert.ok(semUploadCustos, "com base vinculada, MELI não pode pedir upload de custos");
      await subirArquivo('input[aria-label^="Planilha de vendas"]', planilhaFake);
      await processarNoPreparo();
      assert.strictEqual(fechamentoRequestCount, 1, "o processamento nativo deveria ter chamado o backend uma vez");
      assert.strictEqual(await cdp.evaluate(`document.querySelector(${JSON.stringify(DRAWER)}) === null`), true, "processar fecha o preparo");
      await waitFor(cdp, `(document.querySelector('[data-testid="status-competencia"]') || {}).innerText === 'Processado · não salvo'`, "o status deveria dizer que o processamento não foi salvo");
    });

    await check("Paridade — o resultado processado sobrevive a abrir e fechar Relatórios, sem reprocessar", async () => {
      await abrirDoCabecalho("Relatórios");
      await fecharDrawer();
      const ainda = await cdp.evaluate(`document.querySelector('[data-testid="kpis-processamento"]') !== null`);
      assert.ok(ainda, "abrir Relatórios não pode jogar fora o resultado processado");
      assert.strictEqual(fechamentoRequestCount, 1, "abrir um drawer não pode reprocessar");
    });

    await check("Conv#3 §13 — competência divergente: salvar fica travado até confirmação explícita", async () => {
      const texto = await textoDe(".vf-fin-mesa__principal");
      assert.ok(/não bate com o período em tela/.test(texto), `o aviso de divergência deveria aparecer: ${texto.slice(0, 200)}`);
      assert.ok(/julho\/2026/i.test(texto), "o aviso deve nomear a competência detectada");
      assert.strictEqual(await botaoDesabilitado("Salvar como rascunho", ETAPAS), true, "Salvar não pode estar habilitado antes da confirmação");
      await cdp.evaluate(`document.querySelector('.vf-fin-mesa__principal .vf-banner input[type=checkbox]').click()`);
      await sleep(80);
      assert.strictEqual(await botaoDesabilitado("Salvar como rascunho", ETAPAS), false, "depois de confirmar, Salvar libera");
    });

    await check("Conv#3 §16 — salvar cria a entrega e o painel passa a oferecer Publicar (sem ida ao legado)", async () => {
      assert.ok(await clicarBotao(ETAPAS, "Salvar como rascunho"), "botão Salvar como rascunho ausente");
      await waitFor(cdp, `(document.querySelector(${JSON.stringify(ETAPAS)}) || {innerText:''}).innerText.indexOf('Entrega salva como rascunho') >= 0`, "a confirmação de salvo não apareceu");
      assert.strictEqual(entregasFake.length, 1, "a entrega deveria ter sido criada no backend fake");
      assert.strictEqual(entregasFake[0].id, 900);
      await waitFor(cdp, `Array.prototype.some.call(document.querySelectorAll(${JSON.stringify(`${ETAPAS} button`)}), function(b){ return b.textContent.trim().indexOf('Publicar') === 0; })`, "a entrega recém-salva não virou publicável no painel");
      await waitFor(cdp, `(document.querySelector('[data-testid="status-competencia"]') || {}).innerText === 'Rascunho salvo'`, "o status deveria passar a 'Rascunho salvo'");
    });

    await check("Modelo B — Publicar no painel confirma nomeando a competência e publica a entrega desta conta", async () => {
      assert.ok(await clicarBotaoQueComeca(ETAPAS, "Publicar"), "CTA Publicar ausente no painel");
      await sleep(120);
      const confirm = await textoDe(`${ETAPAS} .vf-fin-mesa-confirmar`);
      assert.ok(/Publicar Agosto\/2026\?/.test(confirm || ""), `a confirmação deveria nomear a competência: ${confirm}`);
      assert.strictEqual(entregasFake[0].publicado, false, "um clique só não publica");
      assert.ok(await clicarBotao(`${ETAPAS} .vf-fin-mesa-confirmar`, "Publicar"), "botão de confirmação ausente");
      await waitFor(cdp, `(document.querySelector('[data-testid="status-competencia"]') || {}).innerText === 'Publicado'`, "o status deveria passar a 'Publicado'");
      assert.strictEqual(entregasFake[0].publicado, true, "o servidor deveria ter registrado a publicação");
    });
    competenciaFake = { periodoSolicitado: "2026-08", periodoDetectado: "2026-08", divergente: false };

    // ═══ 2c. Missão Financeiro V3 — Shopee ganha a MESMA experiência do MELI:
    // com base vinculada, nada de upload de custos; sem base, o upload vira
    // obrigatório e o preparo TRAVA até ele chegar. O marketplace é o da
    // operação (conta), não um seletor na tela. ═══
    fechamentoRequestCount = 0;
    resetEntregas();
    entregasFake = [];
    N97_CONTAS[0].marketplace = "shopee";
    N97_CONTAS[0].nome = "Shopee 1";
    baseVinculosFake = []; // Shopee ainda SEM base vinculada
    await navegar(`http://127.0.0.1:${serverPort}/financeiro-v3.html?cliente=n97&conta=42&periodo=2026-08&_r=shopee`);
    await waitFor(cdp, "window.VF && window.VF.context && window.VF.context.getState() === 'READY'", "reload não voltou a READY (cenário Shopee)");
    await waitFor(cdp, ESPERA_MESA, "a mesa não renderizou (cenário Shopee)");
    await sleep(200);

    await check("Missão FV3 §15 — Shopee sem base vinculada: o preparo pede planilha de custos e 'Processar' fica travado com o motivo", async () => {
      await waitFor(cdp, `(document.querySelector(${JSON.stringify(ETAPAS)}) || {innerText:''}).innerText.indexOf('Sem base vinculada') >= 0`, "o painel deveria dizer que não há base vinculada");
      await abrirPreparo();
      await waitFor(cdp, "document.querySelector('.vf-fin-base.is-ausente') !== null", "sem vínculo, a base de custos deveria aparecer como ausente");
      await subirArquivo('input[aria-label^="Planilha de vendas"]', planilhaFake);
      const texto = await textoDe(DRAWER);
      assert.ok(/Nenhuma base vinculada/.test(texto), `sem base, a tela precisa dizer isso: ${texto.slice(0, 300)}`);
      assert.ok(/Planilha de custos necessária/.test(texto), `o motivo do bloqueio fica à vista: ${texto.slice(-300)}`);
      const temCardCustos = await cdp.evaluate(`document.querySelector('input[aria-label="Planilha de custos"]') !== null`);
      assert.ok(temCardCustos, "sem base, o card de upload de custos tem que aparecer");
      assert.strictEqual(await botaoDesabilitado("Processar fechamento", DRAWER), true, "sem a planilha de custos, Shopee não pode deixar processar");
      assert.strictEqual(fechamentoRequestCount, 0, "nada podia ter sido enviado ao backend ainda");
    });

    await check("Missão FV3 §15 — Shopee com custos enviados: libera, processa e não mostra campos exclusivos de MELI", async () => {
      await subirArquivo('input[aria-label="Planilha de custos"]', planilhaFake);
      assert.strictEqual(await botaoDesabilitado("Processar fechamento", DRAWER), false, "com sales + costs, Shopee libera o processamento");
      const semCamposMeli = await cdp.evaluate(
        "Array.prototype.every.call(document.querySelectorAll('.vf-fin-ajuste__label'), function(l){ return !/FULL|Custos adicionais/.test(l.textContent); })"
      );
      assert.ok(semCamposMeli, "campos exclusivos de MELI (FULL/custos adicionais) não podem aparecer no fluxo Shopee");
      await processarNoPreparo();
      assert.strictEqual(fechamentoRequestCount, 1, "o processamento nativo do Shopee deveria ter chamado o backend uma vez");
    });

    await check("Missão FV3 — Shopee COM base vinculada: não pede upload de custos (paridade com o MELI)", async () => {
      fechamentoRequestCount = 0;
      baseVinculosFake = [
        {
          id: 12, slug: "base-n97-shopee", nome: "Comprou_chegou_shopee1", ativo: true,
          vinculo: { cliente_slug: "n97", marketplace: "shopee", cliente_conta_id: 42, conta_nome: "Shopee 1" },
        },
      ];
      await navegar(`http://127.0.0.1:${serverPort}/financeiro-v3.html?cliente=n97&conta=42&periodo=2026-08&_r=shopee-base`);
      await waitFor(cdp, "window.VF && window.VF.context && window.VF.context.getState() === 'READY'", "reload não voltou a READY (Shopee c/ base)");
      await waitFor(cdp, ESPERA_MESA, "a mesa não renderizou (Shopee c/ base)");
      await waitFor(cdp, `(document.querySelector(${JSON.stringify(ETAPAS)}) || {innerText:''}).innerText.indexOf('Comprou_chegou_shopee1 · vinculada') >= 0`, "o painel deveria nomear a base Shopee vinculada");
      await abrirPreparo();
      await waitFor(cdp, "document.querySelector('.vf-fin-base.is-encontrada') !== null", "a base Shopee vinculada não foi reconhecida");
      const semUploadCustos = await cdp.evaluate(`document.querySelector('input[aria-label="Planilha de custos"]') === null`);
      assert.ok(semUploadCustos, "com base Shopee vinculada, não pode aparecer upload de custos");
      const texto = await textoDe(DRAWER);
      assert.ok(/Comprou_chegou_shopee1/.test(texto), `a tela precisa dizer qual base será usada: ${texto.slice(0, 300)}`);
      await fecharDrawer();
    });

    // restaura o fixture para os blocos seguintes
    N97_CONTAS[0].marketplace = "meli";
    N97_CONTAS[0].nome = "Mercado Livre 1";
    baseVinculosFake = [
      { id: 9, slug: "base-n97-meli", nome: "Comprou_chegou_meli1", ativo: true, vinculo: { cliente_slug: "n97", marketplace: "meli", cliente_conta_id: 42, conta_nome: "Mercado Livre 1" } },
    ];

    // ═══ 2d. Convergência #4 §10 — Shopee nas áreas de LEITURA: o mesmo
    // Fechamento salvo / Relatórios / Histórico do MELI, contra um payload
    // marcado marketplace=shopee. A conciliação Mercado Pago é só do MELI. ═══
    N97_CONTAS[0].marketplace = "shopee";
    N97_CONTAS[0].nome = "Shopee 1";
    financeiroPayload = {
      ok: true,
      contexto: { clienteId: 87, clienteSlug: "n97", clienteContaId: 42, marketplace: "shopee", periodo: "2026-08" },
      resultado: {
        disponivel: true, escopoConta: false,
        dados: {
          status: "publicado", geradoEm: "2026-08-26T10:00:00Z", publicadoEm: "2026-08-26T12:00:00Z",
          cards: [],
          composicao: [
            { chave: "faturamento_bruto", rotulo: "Faturamento bruto", valor: 88400.2, disponivel: true },
            { chave: "comissao", rotulo: "Comissão", valor: -8840.02, disponivel: true },
            { chave: "custo_produto", rotulo: "Custo de produto", valor: null, disponivel: false },
            { chave: "resultado", rotulo: "Resultado", valor: 41230.1, disponivel: true },
          ],
        },
      },
      conciliacao: {
        disponivel: true, escopoConta: true,
        dados: {
          mpReconciliationStatus: "matched",
          summary: {
            ordersTotal: 400, ordersMatchedClean: 400, ordersMatchedWithEvents: 0, ordersDivergent: 0,
            ordersSettlementPending: 0, coveragePercent: 100, paymentsUnique: 400, paymentsSettlementPending: 0,
            totalPaymentNet: 80000,
          },
        },
      },
      relatorios: {
        disponivel: true, escopoConta: false,
        dados: [{ periodo: "2026-08", status: "rascunho", geradoEm: "2026-08-26T10:00:00Z", publicado: false, token: null }],
      },
    };
    resetEntregas();
    entregasFake = [
      { id: 950, tipo: "fechamento_mensal", cliente_id: 87, cliente_slug: "n97", cliente_conta_id: 42, titulo: "Fechamento Shopee Agosto", periodo: "2026-08", status: "rascunho", publicado: false, token_publico: null, created_at: "2026-08-26T10:00:00Z", published_at: null },
    ];
    await navegar(`http://127.0.0.1:${serverPort}/financeiro-v3.html?cliente=n97&conta=42&periodo=2026-08&_r=shopee-leitura`);
    await waitFor(cdp, "window.VF && window.VF.context && window.VF.context.getState() === 'READY'", "reload não voltou a READY (Shopee leitura)");
    await waitFor(cdp, ESPERA_MESA, "a mesa não renderizou (Shopee leitura)");
    await sleep(200);

    await check("Convergência #4 §10 — Shopee: Fechamento salvo renderiza a composição da fixture, sem R$0 fabricado e sem conciliação MP", async () => {
      await waitFor(cdp, `document.querySelector(${JSON.stringify(`${MESA} .vf-fin-mesa-vazio.is-legado`)}) !== null`, "o Fechamento salvo Shopee não apareceu");
      const texto = await textoDe(`${MESA} .vf-fin-mesa-vazio.is-legado`);
      assert.ok(texto.includes("Faturamento bruto"), `composição Shopee ausente: ${texto}`);
      assert.ok(/Custo de produto[\s\S]*—/.test(texto), `custo ausente deveria mostrar '—' também no Shopee: ${texto}`);
      assert.ok(!texto.includes("R$ 0,00"), `nenhum valor ausente pode virar R$ 0,00 no Shopee: ${texto}`);
      assert.ok(!/Conciliação Mercado Pago/.test(await textoDe(MESA)), "a conciliação Mercado Pago é só do MELI");
    });

    await check("Convergência #4 §10 — Shopee: Relatórios lista a entrega Shopee e Histórico mostra o período", async () => {
      await abrirDoCabecalho("Relatórios");
      const linhas = await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(`${DRAWER} tbody tr`)}).length`);
      assert.strictEqual(linhas, 1, `esperada 1 entrega Shopee, achei ${linhas}`);
      const linha = await textoDe(`${DRAWER} tbody tr`);
      assert.ok(/Shopee/.test(linha), `a linha deveria identificar o marketplace Shopee: ${linha}`);
      assert.ok(/Publicar/.test(linha), `rascunho Shopee deveria oferecer Publicar: ${linha}`);
      await fecharDrawer();

      await abrirDoCabecalho("Histórico");
      const periodo = await textoDe(`${DRAWER} .vf-fin-historico__item .vf-fin-historico__periodo`);
      assert.ok(/Agosto/i.test(periodo), `histórico Shopee deveria mostrar Agosto/2026: ${periodo}`);
      await fecharDrawer();
    });

    await check("Convergência #4 §10 — Shopee: Publicar/Despublicar escrevem de verdade e a tela relê do servidor", async () => {
      await abrirDoCabecalho("Relatórios");
      const LINHA = `${DRAWER} tbody tr[data-entrega="950"]`;
      assert.ok(await clicarBotao(LINHA, "Publicar"), "botão Publicar ausente na linha Shopee");
      await sleep(120);
      assert.ok(await clicarBotao(`${LINHA} .vf-fin-confirm`, "Publicar"), "confirmação de publicar ausente");
      await waitFor(cdp, `(document.querySelector(${JSON.stringify(LINHA)}) || {innerText:''}).innerText.indexOf('Despublicar') >= 0`, "a entrega Shopee não passou a publicada");
      assert.strictEqual(entregasFake.find((e) => e.id === 950).publicado, true, "o servidor deveria ter registrado a publicação Shopee");
      assert.ok(entregasFake.find((e) => e.id === 950).token_publico, "publicar Shopee deveria gerar token público");

      assert.ok(await clicarBotao(LINHA, "Despublicar"), "botão Despublicar ausente na linha Shopee");
      await sleep(120);
      assert.ok(await clicarBotao(`${LINHA} .vf-fin-confirm`, "Despublicar"), "confirmação de despublicar ausente");
      await waitFor(cdp, `(document.querySelector(${JSON.stringify(LINHA)}) || {innerText:''}).innerText.indexOf('Publicar') >= 0`, "a entrega Shopee não voltou a rascunho");
      const alvo = entregasFake.find((e) => e.id === 950);
      assert.strictEqual(alvo.publicado, false);
      assert.strictEqual(alvo.token_publico, null, "despublicar Shopee precisa revogar o token público também");
      await fecharDrawer();
    });
    N97_CONTAS[0].marketplace = "meli";
    N97_CONTAS[0].nome = "Mercado Livre 1";

    // ═══ 2e. UX do modelo B com processamento GRANDE (3.625 / 1.800 linhas):
    // a mesa (resultado + cascata | painel de etapas) e, embaixo, os produtos
    // em largura total, paginados. Larguras de notebook/desktop com o Shell
    // ocupando a lateral: nada de scroll horizontal na PÁGINA. ═══
    async function fotografar(nome, largura) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: largura, height: 1000, deviceScaleFactor: 1, mobile: false });
      await sleep(250);
      // O Shell pode rolar num contêiner interno: mede o maior scrollHeight.
      const altura = await cdp.evaluate(`(function(){ var m = document.documentElement.scrollHeight; document.querySelectorAll('*').forEach(function(e){ var o = getComputedStyle(e).overflowY; if ((o === 'auto' || o === 'scroll') && e.scrollHeight > m) m = e.scrollHeight; }); return m; })()`);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: largura, height: Math.min(Math.max(altura, 1000), 9000), deviceScaleFactor: 1, mobile: false });
      await sleep(350);
      const png = await cdp.send("Page.captureScreenshot", { format: "png" });
      const arquivo = path.join(SHOTS_DIR, `${nome}-${largura}.png`);
      fs.writeFileSync(arquivo, Buffer.from(png.data, "base64"));
      return arquivo;
    }
    const semScrollHorizontalNaPagina = () => cdp.evaluate(`(function(){ var d = document.documentElement; return d.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1; })()`);
    const PEND = `${DRAWER} [data-secao="pendencias"]`;
    async function abrirPendencias() {
      assert.ok(await clicarBotao(MESA, "Ver e corrigir"), "o aviso de pendências deveria oferecer 'Ver e corrigir'");
      await esperarDrawer("Pendências de custo");
    }

    resetEntregas();
    entregasFake = [];
    N97_CONTAS[0].marketplace = "meli";
    N97_CONTAS[0].nome = "Mercado Livre 1";
    baseVinculosFake = [
      { id: 9, slug: "base-n97-meli", nome: "Comprou_chegou_meli1", ativo: true, vinculo: { cliente_slug: "n97", marketplace: "meli", cliente_conta_id: 42, conta_nome: "Mercado Livre 1" } },
    ];
    processamentoFake = processamentoRicoMeli();
    upsertsFake = [];
    fechamentoRequestCount = 0;
    await navegar(`http://127.0.0.1:${serverPort}/financeiro-v3.html?cliente=n97&conta=42&periodo=2026-08&_r=ux-meli`);
    await waitFor(cdp, "window.VF && window.VF.context && window.VF.context.getState() === 'READY'", "reload não voltou a READY (UX MELI)");
    await waitFor(cdp, ESPERA_MESA, "a mesa não renderizou (UX MELI)");
    await abrirPreparo();
    await waitFor(cdp, "document.querySelector('.vf-fin-base.is-encontrada') !== null", "base vinculada MELI não reconhecida (UX MELI)");
    await subirArquivo('input[aria-label^="Planilha de vendas"]', planilhaFake);
    await processarNoPreparo();

    await check("UX — modelo B: destaque, aviso e cascata à esquerda; painel à direita terminando na borda da cascata; produtos depois, em largura total", async () => {
      const m = await cdp.evaluate(`(function(){
        var topo = document.querySelector('.vf-fin-mesa__topo').getBoundingClientRect();
        var principal = document.querySelector('.vf-fin-mesa__principal');
        var painel = document.querySelector(${JSON.stringify(ETAPAS)}).getBoundingClientRect();
        var cascata = principal.querySelector('.vf-fin-mesa-cascata').getBoundingClientRect();
        var destaque = principal.querySelector('[data-testid="kpis-processamento"]').getBoundingClientRect();
        var aviso = principal.querySelector('[data-testid="aviso-pendencias"]');
        var produtos = document.querySelector('.vf-fin-mesa-produtos').getBoundingClientRect();
        return {
          painelADireita: painel.left >= cascata.right - 1,
          fundoAlinhado: Math.abs(painel.bottom - cascata.bottom),
          ordem: destaque.bottom <= (aviso ? aviso.getBoundingClientRect().top : cascata.top) + 1 && cascata.top >= destaque.bottom - 1,
          avisoUmaLinha: aviso ? (function(){ var t = aviso.querySelector('.vf-fin-mesa-aviso__texto'); return t.getBoundingClientRect().height <= parseFloat(getComputedStyle(t).lineHeight || '20') * 1.5 + 1; })() : null,
          produtosDepois: produtos.top >= topo.bottom - 1,
          produtosLarguraTotal: Math.abs(produtos.width - topo.width) <= 2,
        };
      })()`);
      assert.ok(m.painelADireita, `o painel de etapas fica à direita: ${JSON.stringify(m)}`);
      assert.ok(m.fundoAlinhado <= 2, `o painel termina na borda de baixo de "Da receita ao resultado": ${JSON.stringify(m)}`);
      assert.ok(m.ordem, `destaque → aviso → cascata: ${JSON.stringify(m)}`);
      assert.strictEqual(m.avisoUmaLinha, true, `o aviso de pendências ocupa uma linha só: ${JSON.stringify(m)}`);
      assert.ok(m.produtosDepois && m.produtosLarguraTotal, `os produtos vêm depois da mesa, em largura total: ${JSON.stringify(m)}`);
    });

    await check("UX — MELI: 3.625 linhas mas só uma página renderizada (paginação real), com total e faixa visíveis", async () => {
      const linhas = await cdp.evaluate(`document.querySelectorAll('.vf-fin-mesa-produtos .vf-fin-mesa-lista__linha').length`);
      assert.strictEqual(linhas, 25, `esperadas 25 linhas na página, achei ${linhas}`);
      const texto = await textoDe(".vf-fin-mesa-produtos");
      assert.ok(/3\.625 linhas/.test(texto), `o total de linhas deveria aparecer: ${texto.slice(0, 200)}`);
      assert.ok(/Página 1 de 145/.test(texto), "a paginação deveria dizer Página 1 de 145");
    });

    await check("UX — MELI: busca à esquerda dos filtros; a lista não rola na horizontal (colunas secundárias saem pela largura)", async () => {
      const m = await cdp.evaluate(`(function(){
        var f = document.querySelector('.vf-fin-mesa-produtos__ferramentas');
        var busca = f.querySelector('input[type=search]').getBoundingClientRect(), filtros = f.querySelector('[aria-label="Filtrar produtos"]').getBoundingClientRect();
        var lista = document.querySelector('.vf-fin-mesa-lista');
        return { buscaAntes: busca.left < filtros.left, semRolagem: lista.scrollWidth <= lista.clientWidth + 1 };
      })()`);
      assert.ok(m.buscaAntes, "a busca fica à esquerda dos filtros por status");
      assert.ok(m.semRolagem, "a lista de produtos não pode rolar na horizontal");
    });

    await check("UX — MELI: destaque com o Resultado Final e seis números (receitas, LC, TACoS, TACoX, cobertura)", async () => {
      const kpi = await cdp.evaluate(`(function(){
        var r = document.querySelector('[data-testid="kpis-processamento"]');
        return { grade: Array.prototype.map.call(r.querySelectorAll('.vf-fin-mesa-destaque__grade [data-kpi]'), function(e){ return e.dataset.kpi; }), resultado: !!r.querySelector('.vf-fin-mesa-destaque__resultado[data-kpi="finalResult"]') };
      })()`);
      assert.deepStrictEqual(kpi.grade, ["grossRevenueTotal", "paidRevenueTotal", "contributionProfitTotal", "tacos", "tacox", "calculatedCoveragePercent"]);
      assert.ok(kpi.resultado, "Resultado Final deve ter o destaque");
    });

    await check("UX — MELI: poucas pendências → os 3 grupos com contagem (4 agora · 0 planilha · 0 bloqueadas), no drawer 'Ver e corrigir'", async () => {
      await abrirPendencias();
      const resumo = await cdp.evaluate(`Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(`${PEND} ul[aria-label="Resumo das pendências"] li`)}), function(li){ return [li.dataset.grupo, Number(li.querySelector('strong').textContent)]; })`);
      assert.deepStrictEqual(resumo, [["agora", 4], ["planilha", 0], ["bloqueadas", 0]]);
      const grupos = await cdp.evaluate(`Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(`${PEND} .vf-fin-pend-grupo`)}), function(g){ return g.dataset.grupo; })`);
      assert.deepStrictEqual(grupos, ["agora", "planilha", "bloqueadas"]);
      const txt = await textoDe(`${PEND} [data-grupo="planilha"].vf-fin-pend-grupo`);
      assert.ok(/Corrigir as 4 por planilha/.test(txt), `o grupo da planilha deveria oferecer o caminho: ${txt}`);
    });

    await check("UX — MELI: pendência corrigida NA LINHA (custo atual, novo custo, o que será gravado) e o fechamento NÃO é reprocessado sozinho", async () => {
      const cabecalhos = await cdp.evaluate(`Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(`${PEND} table[aria-label="Pendências para corrigir agora"] th`)}), function(t){ return t.textContent; })`);
      assert.deepStrictEqual(cabecalhos, ["Produto", "Identificação", "Motivo", "Receita impactada", "Custo atual", "Novo custo", "Imposto %", "Ação"]);
      const antes = fechamentoRequestCount;
      const doc = await cdp.send("DOM.getDocument", { depth: -1 });
      const campo = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: 'input[aria-label="Novo custo unitário de MLB1000"]' });
      assert.ok(campo.nodeId, "campo de Novo custo da primeira pendência ausente");
      await cdp.send("DOM.focus", { nodeId: campo.nodeId });
      await cdp.send("Input.insertText", { text: "12,50" });
      await sleep(80);
      const linha = `${PEND} tr:has(input[aria-label="Novo custo unitário de MLB1000"])`;
      assert.ok(await clicarBotao(linha, "Salvar na base"), "botão Salvar na base ausente");
      await waitFor(cdp, `(document.querySelector(${JSON.stringify(PEND)}) || {innerText:''}).innerText.indexOf('produto_id = MLB1000') >= 0`, "a confirmação deveria nomear exatamente o registro que será gravado");
      assert.strictEqual(upsertsFake.length, 0, "nada pode ser gravado antes da confirmação");
      assert.ok(await clicarBotao(PEND, "Confirmar e registrar"), "botão de confirmação ausente");
      await waitFor(cdp, `(document.querySelector(${JSON.stringify(PEND)}) || {innerText:''}).innerText.indexOf('Custo atualizado na base') >= 0`, "a linha deveria mostrar o sucesso");
      assert.strictEqual(upsertsFake.length, 1);
      assert.deepStrictEqual([upsertsFake[0].produto_id, upsertsFake[0].custo_produto, upsertsFake[0].imposto_percentual], ["MLB1000", 12.5, 0.08]); // imposto: padrão da base (fração), confirmado na tela
      assert.strictEqual(fechamentoRequestCount, antes, "corrigir custo não pode reprocessar sozinho");
      assert.ok(await clicarBotao(PEND, "Reprocessar fechamento"), "Reprocessar fechamento ausente");
      await waitFor(cdp, `document.querySelector(${JSON.stringify(DRAWER)}) === null`, "reprocessar fecha o drawer de pendências");
      await sleep(400);
      assert.strictEqual(fechamentoRequestCount, antes + 1, "Reprocessar deveria chamar o motor UMA vez");
    });

    await check("UX — MELI: nenhum valor do destaque é cortado e o painel acompanha a cascata em 1920, 1366 e 1200", async () => {
      for (const largura of [1920, 1366, 1200]) {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: largura, height: 1000, deviceScaleFactor: 1, mobile: false });
        await sleep(300);
        await semAnimacao();
        const m = await cdp.evaluate(`(function(){
          var r = document.querySelector('[data-testid="kpis-processamento"]');
          var valores = Array.prototype.map.call(r.querySelectorAll('.vf-fin-mesa-kpi__valor, .vf-fin-mesa-destaque__valor'), function(v){ return v.scrollWidth <= v.clientWidth + 1; });
          var painel = document.querySelector(${JSON.stringify(ETAPAS)}).getBoundingClientRect(), cascata = document.querySelector('.vf-fin-mesa-cascata').getBoundingClientRect();
          var lado = painel.left >= cascata.right - 1;
          return { valoresInteiros: valores.every(Boolean), lado: lado, fundo: lado ? Math.abs(painel.bottom - cascata.bottom) : 0 };
        })()`);
        assert.ok(m.valoresInteiros, `algum valor do destaque foi cortado em ${largura}px: ${JSON.stringify(m)}`);
        assert.ok(m.fundo <= 2, `com o painel ao lado, ele termina na borda da cascata em ${largura}px: ${JSON.stringify(m)}`);
      }
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
    });

    await check("UX — MELI: sem scroll horizontal na PÁGINA em 1920, 1366 e 1200; screenshots gravadas", async () => {
      for (const largura of [1920, 1366, 1200]) {
        const arquivo = await fotografar("financeiro-v3-meli", largura);
        assert.ok(fs.statSync(arquivo).size > 5000, `screenshot ${largura} vazia`);
        assert.ok(await semScrollHorizontalNaPagina(), `scroll horizontal na página em ${largura}px`);
        console.log(`   screenshot: ${arquivo}`);
      }
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
    });

    // Shopee com Order.all: a reconciliação abre o "Detalhes", antes da composição.
    N97_CONTAS[0].marketplace = "shopee";
    N97_CONTAS[0].nome = "Shopee 1";
    baseVinculosFake = [
      { id: 10, slug: "base-n97-shopee", nome: "Base Shopee N97", ativo: true, vinculo: { cliente_slug: "n97", marketplace: "shopee", cliente_conta_id: 42, conta_nome: "Shopee 1" } },
    ];
    processamentoFake = processamentoRicoShopee();
    fechamentoRequestCount = 0;
    await navegar(`http://127.0.0.1:${serverPort}/financeiro-v3.html?cliente=n97&conta=42&periodo=2026-08&_r=ux-shopee`);
    await waitFor(cdp, "window.VF && window.VF.context && window.VF.context.getState() === 'READY'", "reload não voltou a READY (UX Shopee)");
    await waitFor(cdp, ESPERA_MESA, "a mesa não renderizou (UX Shopee)");
    await abrirPreparo();
    await waitFor(cdp, "document.querySelector('.vf-fin-base.is-encontrada') !== null", "base vinculada Shopee não reconhecida (UX Shopee)");
    await subirArquivo('input[aria-label^="Planilha de vendas"]', planilhaFake);
    await processarNoPreparo();

    await check("UX — Shopee: em Detalhes, a reconciliação vem logo depois da leitura, como no legado (Performance → Reconciliação + um cartão por status)", async () => {
      assert.ok(await clicarBotao(".vf-fin-mesa-cascata", "Detalhes"), "botão Detalhes ausente na cascata");
      await esperarDrawer("Detalhes do fechamento");
      const secoes = await cdp.evaluate(`Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(`${DRAWER} [data-secao]`)}), function(e){ return e.dataset.secao; })`);
      assert.deepStrictEqual(secoes, ["leitura", "reconciliacao", "composicao", "cobertura"]);
      const estados = await cdp.evaluate(`Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(`${DRAWER} [data-secao="reconciliacao"] [data-estado]`)}), function(e){ return e.dataset.estado; })`);
      assert.deepStrictEqual(estados, ["Concluídos", "Entregues", "Enviados", "Em atenção", "Cancelados confirmados", "Não pagos", "Devoluções / Reembolsos"]);
      const texto = await textoDe(`${DRAWER} [data-secao="reconciliacao"]`);
      assert.ok(/Performance \(pedidos pagos\)/i.test(texto) && /Reconciliação \(visão completa\)/i.test(texto), "o comparativo do legado deve aparecer");
      assert.ok(/R\$\s?180\.400,20/.test(texto) && /R\$\s?183\.900,00/.test(texto), `os dois totais do comparativo deveriam aparecer: ${texto.slice(0, 300)}`);
    });

    await check("UX — Shopee: cobertura financeira indisponível vira nota compacta (sem card vazio)", async () => {
      const nota = await cdp.evaluate(`(function(){ var a = document.querySelector(${JSON.stringify(`${DRAWER} [data-secao="cobertura"] aside[data-eixo="financeiro"]`)}); return a ? a.getBoundingClientRect().height : null; })()`);
      assert.ok(nota !== null && nota < 90, `a nota de cobertura financeira deveria ser compacta, altura ${nota}`);
      const linhasCob = await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(`${DRAWER} [data-secao="cobertura"] .vf-fin-cob__linha`)}).length`);
      assert.strictEqual(linhasCob, 1, "a cobertura compacta deveria ter só a linha de custos");
      await fecharDrawer();
    });

    await check("UX — Shopee: 73 pendências → 0 agora · 72 por planilha · 1 bloqueada; o lote (5 passos) importa a planilha ali mesmo e atualiza a BASE", async () => {
      await abrirPendencias();
      const resumo = await cdp.evaluate(`Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(`${PEND} ul[aria-label="Resumo das pendências"] li`)}), function(li){ return [li.dataset.grupo, Number(li.querySelector('strong').textContent)]; })`);
      assert.deepStrictEqual(resumo, [["agora", 0], ["planilha", 72], ["bloqueadas", 1]]);
      const bloqueada = await textoDe(`${PEND} [data-grupo="bloqueadas"].vf-fin-pend-grupo`);
      assert.ok(/Kit sem ID do Item/.test(bloqueada) && /nem pela planilha/.test(bloqueada), `a pendência sem Item deveria estar no grupo 3 com o motivo: ${bloqueada.slice(0, 300)}`);
      const passos = await cdp.evaluate(`Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(`${PEND} [data-passo]`)}), function(e){ return e.dataset.passo; })`);
      assert.deepStrictEqual(passos, ["baixar", "preencher", "enviar", "importar", "reprocessar"]);
      assert.strictEqual(await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(`${PEND} [data-grupo="agora"] tbody input`)}).length`), 0, "no lote o grupo 1 não tem campos");
      assert.strictEqual(await cdp.evaluate(`Array.prototype.filter.call(document.querySelectorAll(${JSON.stringify(`${PEND} button`)}), function(b){ return b.textContent.trim() === 'Reprocessar fechamento'; }).length`), 1, "um único Reprocessar (passo 5)");

      // planilha preenchida: 2 linhas gravaveis (Itens novos na base), 70 sem Novo custo
      previewPlanilhaFake = {
        ok: true,
        dados_importacao: [
          { id: "169417000075", id_model: "555000000075", custo: 9.9, imposto: null },
          { id: "169417000275", id_model: "555000000275", custo: 8, imposto: 0.08 },
        ],
        resumo: { linhas_lidas: 72, linhas_ignoradas: 70 }, alertas: [],
      };
      upsertsFake = [];
      await subirArquivo('input[aria-label="Planilha de custos preenchida"]', planilhaFake);
      await waitFor(cdp, `(document.querySelector(${JSON.stringify(`${PEND} [data-previa]`)}) || {innerText:''}).innerText.indexOf('2 para adicionar') >= 0`, "o resumo da planilha deveria aparecer antes de gravar");
      assert.strictEqual(upsertsFake.length, 0, "ler a planilha não pode gravar");
      assert.ok(await clicarBotao(PEND, "Importar e atualizar base"), "botão Importar e atualizar base ausente");
      await waitFor(cdp, `(document.querySelector(${JSON.stringify(`${PEND} [data-resultado]`)}) || {innerText:''}).innerText.indexOf('2 custos atualizados na base') >= 0`, "o resultado da importação deveria aparecer");
      assert.strictEqual(upsertsFake.length, 2, "a base deveria receber 2 upserts (mesmo endpoint de Bases)");
      assert.deepStrictEqual([upsertsFake[0].produto_id, upsertsFake[0].id_model, upsertsFake[0].custo_produto], ["169417000075", "555000000075", 9.9]);
      const antes = fechamentoRequestCount;
      assert.ok(await clicarBotao(PEND, "Reprocessar fechamento"), "Reprocessar fechamento ausente");
      await waitFor(cdp, `document.querySelector(${JSON.stringify(DRAWER)}) === null`, "reprocessar fecha o drawer de pendências");
      await sleep(400);
      assert.strictEqual(fechamentoRequestCount, antes + 1, "só depois da base atualizada o operador reprocessa — e é um clique dele");
    });

    await check("UX — Shopee: no modo individual, Item que NÃO está na base é identidade SEGURA (campos de custo e imposto liberados)", async () => {
      await abrirPendencias();
      assert.ok(await clicarBotao(PEND, "Corrigir as 72 aqui no portal mesmo assim"), "botão para levar as pendências ao portal ausente");
      await sleep(200);
      const campos = await cdp.evaluate(`document.querySelectorAll(${JSON.stringify(`${PEND} [data-grupo="agora"] tbody tr[data-identidade="segura"] input`)}).length`);
      assert.ok(campos >= 2, `deveria haver campos de custo/imposto nas linhas seguras, achei ${campos}`);
      await fecharDrawer();
    });

    await check("UX — Shopee: sem scroll horizontal na PÁGINA em 1920, 1366 e 1200; screenshots gravadas", async () => {
      for (const largura of [1920, 1366, 1200]) {
        const arquivo = await fotografar("financeiro-v3-shopee", largura);
        assert.ok(await semScrollHorizontalNaPagina(), `scroll horizontal na página em ${largura}px`);
        console.log(`   screenshot: ${arquivo}`);
      }
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
    });
    processamentoFake = null;
    N97_CONTAS[0].marketplace = "meli";
    N97_CONTAS[0].nome = "Mercado Livre 1";

    // ═══ 3. REGRESSÃO P0 — sem vf-token: nunca pode ficar em branco pra
    // sempre. bootProduction() (vf-shell.js) só chama vfContext.init() se
    // hasToken() for true; sem isso nenhuma chamada de API acontece, então
    // o redirect-por-401 do vf-api nunca é acionado — a página HTML real
    // (não um harness com token pré-semeado) precisa mandar pro login
    // sozinha nesse caso. ═══
    await cdp.evaluate(`localStorage.removeItem("vf-token"); localStorage.removeItem("vf-user"); sessionStorage.clear();`);
    consoleErrors.length = 0;
    await navegar(`http://127.0.0.1:${serverPort}/financeiro-v3.html?cliente=n97&conta=42&_r=3`);
    await waitFor(cdp, "document.body.innerText.includes('E-mail')", "sem vf-token deveria redirecionar para o login (index.html) em vez de ficar em branco pra sempre");

    await check("F4.1 — sem vf-token: redireciona para o login em vez de ficar em branco pra sempre (regressão da tela branca)", async () => {
      const pathname = await cdp.evaluate("window.location.pathname");
      assert.ok(/index\.html$/.test(pathname), `esperava redirect para index.html, url atual: ${pathname}`);
      const temRootDoFinanceiro = await cdp.evaluate("document.getElementById('root') !== null");
      assert.strictEqual(temRootDoFinanceiro, false, "página de login não deveria ter o #root do Financeiro V3 sobrando no DOM");
    });

    await check("sem erros de console em nenhum cenário", async () => {
      const relevantes = consoleErrors.filter((m) => !/favicon/i.test(m));
      assert.strictEqual(relevantes.length, 0, `erros de console: ${JSON.stringify(relevantes)}`);
    });

    console.log(`\n✓ ${checks} verificações do Financeiro V3 (F4.1)`);
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
