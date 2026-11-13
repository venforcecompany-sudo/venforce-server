// server/tests/margemCotacaoConfiabilidade.test.js
//
// P0 04/11/2026 — confiabilidade financeira da Central de Margem.
// Caso real: Alianza Jeans 2 (conta 87, grant 114, seller 2433262404) é a conta
// SECUNDÁRIA do cliente; a principal é a conta 86 (grant 113, seller
// 1587129755). Cinco runs: 532/532 "cotação incompleta".
//
// Um "Mercado Livre" falso com DOIS vendedores responde como o real: só o token
// do DONO lê o anúncio (multiget devolve 403 por entrada para token de outro
// usuário — doc erro-403: "access token de outro usuário"). O mlFetch falso
// resolve o token como o mlFetch real: sem `mlUserId` ⇒ grant PRINCIPAL.
//
// Cadeia REAL: enrichBatch → meliApiEvidenceAdapter → marketplaceCurrentQuoteService
// → núcleo → processor → repository (fake db em memória). Nenhuma chamada real.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://nobody@127.0.0.1:1/teste-sem-banco";

const assert = require("assert");
const motorMargem = require("../services/motorMargem/motorMargemService");
const meliApi = require("../services/motorMargem/adapters/meliApiEvidenceAdapter");
const { buscarComissaoEFrete } = require("../services/shared/marketplaceCurrentQuoteService");
const { buildCostIndex } = require("../services/motorMargem/adapters/baseCustosEvidenceAdapter");
const { processMarginSnapshotRun } = require("../services/motorMargem/marginSnapshotProcessor");
const { resolveMarginSnapshotConfig } = require("../services/motorMargem/marginSnapshotConfig");
const { createRateLimiter } = require("../services/motorMargem/marginSnapshotRateLimiter");
const snapshotRepository = require("../services/motorMargem/marginSnapshotRepository");
const runRepository = require("../services/motorMargem/marginSnapshotRunRepository");
const { makeMarginSnapshotFakeDb } = require("./helpers/marginSnapshotFakeDb");
const { MlTimeoutError } = require("../utils/mlClient");
const core = require("../services/motorMargem/core");

const NOW = new Date("2026-11-04T12:00:00.000Z");
const SILENCIOSO = { log() {}, warn() {}, error() {} };
const SELLER_1 = "1587129755"; // conta 86 — grant 113 PRINCIPAL
const SELLER_2 = "2433262404"; // conta 87 — grant 114 secundário

let checks = 0;
const casos = [];
function cenario(nome, fn) { casos.push({ nome, fn }); }
function ok(cond, msg) { assert.ok(cond, msg); checks += 1; }

// ── Mercado Livre falso ─────────────────────────────────────────────────────
function mundoMl({ listing = null, frete = null } = {}) {
  const anuncios = {
    MLB201: { seller: SELLER_2, price: 50, category_id: "MLB1430", listing_type_id: "gold_special", logistic_type: "fulfillment" },
    MLB202: { seller: SELLER_2, price: 80, category_id: "MLB1430", listing_type_id: "gold_special", logistic_type: "not_specified" },
    MLB101: { seller: SELLER_1, price: 60, category_id: "MLB1430", listing_type_id: "gold_pro", logistic_type: "cross_docking" },
    // Preço 33: listing_prices falha (403) só para ele — incompleto no meio dos completos.
    MLB203: { seller: SELLER_2, price: 33, category_id: "MLB1430", listing_type_id: "gold_special", logistic_type: "fulfillment" },
  };
  const chamadas = [];
  async function mlFetch(clienteId, path, opts = {}) {
    const dono = opts && opts.mlUserId ? String(opts.mlUserId) : SELLER_1; // sem mlUserId ⇒ principal
    chamadas.push({ path: String(path), dono });
    const p = String(path);
    if (p.startsWith("/items?ids=")) {
      const ids = p.slice("/items?ids=".length).split(",");
      return {
        ok: true, status: 200,
        data: ids.map((id) => {
          const a = anuncios[id];
          if (!a) return { code: 404, body: { message: "not found", error: "not_found", status: 404 } };
          if (a.seller !== dono) {
            return { code: 403, body: { id, message: "access to the requested resource is forbidden", error: "access_denied", status: 403 } };
          }
          return { code: 200, body: { id, seller_id: Number(a.seller), title: `Anúncio ${id}`, price: a.price, category_id: a.category_id,
            listing_type_id: a.listing_type_id, status: "active", shipping: { logistic_type: a.logistic_type } } };
        }),
      };
    }
    if (p.startsWith("/sites/MLB/listing_prices")) {
      if (listing) return listing({ path: p, dono });
      if (p.includes("price=33")) return { ok: false, status: 403, data: { status: 403 } };
      return { ok: true, status: 200, data: [{ sale_fee_amount: 7.0, sale_fee_details: { percentage_fee: 14 } }] };
    }
    const fr = p.match(/^\/users\/(\d+)\/shipping_options\/free/);
    if (fr) {
      if (frete) return frete({ path: p, dono });
      if (fr[1] !== dono) return { ok: false, status: 403, data: { status: 403, error: "access_denied" } };
      return { ok: true, status: 200, data: { coverage: { all_country: { list_cost: 9.5 } } } };
    }
    return { ok: false, status: 404, data: null };
  }
  // preço vigente (sale_price) pela mesma regra de dono.
  async function resolverPrecosItem({ itemId, precoListaFallback, mlUserId }) {
    const a = anuncios[itemId];
    const dono = mlUserId ? String(mlUserId) : SELLER_1;
    chamadas.push({ path: `/items/${itemId}/sale_price`, dono });
    if (!a || a.seller !== dono) {
      return { precoCheio: precoListaFallback, precoPromocional: null, precoEfetivo: precoListaFallback, fonte: "fallback_lista" };
    }
    return { precoCheio: a.price, precoPromocional: null, precoEfetivo: a.price, fonte: "sale_price", promotionIdAtivo: null };
  }
  return { anuncios, chamadas, mlFetch, resolverPrecosItem };
}

function prepared(mlUserId, extra = {}) {
  return {
    now: NOW,
    cliente: { id: 7, nome: "Alianza Jeans", slug: "alianza_jeans" },
    base: { id: 900, slug: "base-alianza", nome: "Base" },
    mlUserId,
    custos: {
      index: buildCostIndex([
        { produto_id: "MLB201", custo_produto: 22, imposto_percentual: 0.1, taxa_fixa: 0, produto_nome: "Calça", updated_at: NOW },
        { produto_id: "MLB202", custo_produto: 30, imposto_percentual: 0.1, taxa_fixa: 0, produto_nome: "Short", updated_at: NOW },
        { produto_id: "MLB101", custo_produto: 25, imposto_percentual: 0.1, taxa_fixa: 0, produto_nome: "Saia", updated_at: NOW },
        { produto_id: "MLB203", custo_produto: 10, imposto_percentual: 0.1, taxa_fixa: 0, produto_nome: "Top", updated_at: NOW },
      ]),
      total: 3,
    },
    porMlb: new Map(), reembolsoPorMlb: new Map(), fallbackObservedAt: null,
    periodo: { dateFrom: "2026-10-05", dateTo: "2026-11-03" },
    vendasRaw: { sincronizado: false, pedidos: [], itens: [], componentes: [], imports: [], importSnapshotAt: null },
    naoAtribuido: { reembolso: 0 },
    ...extra,
  };
}

function depsMundo(w) {
  return {
    buscarDetalhesItens: (args) => meliApi.buscarDetalhesItens(args, w.mlFetch),
    mlFetchFn: w.mlFetch,
    resolverPrecosItemFn: w.resolverPrecosItem,
  };
}

// ── 1. Duas contas ML, grants diferentes ────────────────────────────────────
cenario("conta SECUNDÁRIA: toda chamada ao ML sai com o seller da conta (nunca o grant principal)", async () => {
  const w = mundoMl();
  const r = await motorMargem.enrichBatch(prepared(SELLER_2), { itemIds: ["MLB201", "MLB202"] }, depsMundo(w));
  ok(w.chamadas.length > 0, "houve chamadas");
  ok(w.chamadas.every((c) => c.dono === SELLER_2), `chamada com outro grant: ${JSON.stringify(w.chamadas.filter((c) => c.dono !== SELLER_2))}`);
  ok(r.itens.length === 2 && r.errosDetalhe.length === 0, "os dois anúncios voltam");
  const i201 = r.itens.find((i) => i.identity.itemId === "MLB201");
  ok(i201.diagnostico.statusAnuncio === "active", "status do anúncio, não do erro");
  ok(i201.diagnostico.faltantesMeliApi.length === 0, "comissão, frete e preço presentes");
  // 50 − 5 (10%) − 7 (comissão) − 9,5 (frete) − 22 (custo) = 6,5 → 13%
  ok(Math.abs(i201.margin.projected.profit - 6.5) < 0.001, `lucro ${i201.margin.projected.profit}`);
  ok(i201.margin.projected.assumed.length === 0, "nada assumido como 0");
});

cenario("conta PRINCIPAL: usa só o próprio seller e não lê anúncios da secundária", async () => {
  const w = mundoMl();
  const r = await motorMargem.enrichBatch(prepared(SELLER_1), { itemIds: ["MLB101"] }, depsMundo(w));
  ok(w.chamadas.every((c) => c.dono === SELLER_1));
  ok(r.itens.length === 1 && r.itens[0].diagnostico.faltantesMeliApi.length === 0);
});

cenario("regressão do bug: multiget com o token principal → 403 por entrada vira ERRO, nunca anúncio com status 403", async () => {
  const w = mundoMl();
  const bodies = await meliApi.buscarDetalhesItens({ clienteId: 7, ids: ["MLB201", "MLB202"] }, w.mlFetch); // sem mlUserId = comportamento antigo
  ok(bodies.length === 0, "corpo de erro não é aceito como anúncio");
  ok(bodies.erros.length === 2 && bodies.erros.every((e) => e.status === 403 && e.id), JSON.stringify(bodies.erros));
  const comConta = await meliApi.buscarDetalhesItens({ clienteId: 7, ids: ["MLB201"], mlUserId: SELLER_2 }, w.mlFetch);
  ok(comConta.length === 1 && comConta[0].status === "active");
  // formato /items/bulk (status_code) também é entendido
  const bulk = await meliApi.buscarDetalhesItens({ clienteId: 7, ids: ["X"], mlUserId: SELLER_2 }, async () => ({
    ok: true, status: 200, data: [{ id: "MLB9", status_code: 200, body: { id: "MLB9", status: "active" } }, { id: "MLB8", status_code: 403, body: { status: 403 } }],
  }));
  ok(bulk.length === 1 && bulk.erros[0].id === "MLB8" && bulk.erros[0].status === 403);
});

cenario("sem mlUserId o Motor RECUSA ler (ML_USER_ID_AUSENTE) — não cai no grant da principal", async () => {
  const w = mundoMl();
  let erro = null;
  try { await motorMargem.enrichBatch(prepared(null), { itemIds: ["MLB201"] }, depsMundo(w)); } catch (e) { erro = e; }
  ok(erro && erro.code === "ML_USER_ID_AUSENTE", String(erro && erro.message));
  ok(w.chamadas.length === 0, "nenhuma chamada ao ML");
});

// ── 2. Cotação: cada falha com status e motivo; ausente nunca vira 0 ───────
const ARGS = { clienteId: 7, itemId: "MLB201", precoEfetivo: 50, listingTypeId: "gold_special", categoryId: "MLB1430", sellerId: SELLER_2, logisticType: "fulfillment", mlUserId: SELLER_2 };
const okListing = async () => ({ ok: true, status: 200, data: [{ sale_fee_amount: 7, sale_fee_details: { percentage_fee: 14 } }] });
const okFrete = async () => ({ ok: true, status: 200, data: { coverage: { all_country: { list_cost: 9.5 } } } });
function fetchCom(listing, frete, chamadas = []) {
  return async (cId, path, opts) => {
    chamadas.push({ path, opts });
    return String(path).includes("listing_prices") ? listing() : frete();
  };
}

cenario("cotação válida: valores + diagnóstico sem motivo; mlUserId nas DUAS chamadas", async () => {
  const chamadas = [];
  const r = await buscarComissaoEFrete(ARGS, fetchCom(okListing, okFrete, chamadas));
  ok(r.comissaoValor === 7 && r.fretePrevisto === 9.5);
  ok(r.diagnostico.comissao.motivo === null && r.diagnostico.frete.motivo === null);
  ok(r.diagnostico.comissao.status === 200 && r.diagnostico.frete.status === 200);
  ok(chamadas.length === 2 && chamadas.every((c) => c.opts && c.opts.mlUserId === SELLER_2), "listing_prices também com a conta");
});

const FALHAS = [
  ["HTTP 403", async () => ({ ok: false, status: 403, data: { status: 403 } }), "ml_sem_permissao", 403],
  ["HTTP 429", async () => ({ ok: false, status: 429, data: null }), "ml_rate_limit", 429],
  ["HTTP 503", async () => ({ ok: false, status: 503, data: null }), "ml_indisponivel", 503],
  ["timeout", async () => { throw new MlTimeoutError("ML_DEADLINE_EXCEEDED", "prazo", { enviado: true }); }, "ml_timeout", null],
  ["exceção de rede", async () => { throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }); }, "ml_indisponivel", null],
];
for (const [nome, resposta, motivo, status] of FALHAS) {
  cenario(`comissão com ${nome}: null (nunca 0) + motivo ${motivo}`, async () => {
    const r = await buscarComissaoEFrete(ARGS, fetchCom(resposta, okFrete));
    ok(r.comissaoValor === null && r.comissaoPercentual === null, "ausente fica null");
    ok(r.diagnostico.comissao.motivo === motivo, `${r.diagnostico.comissao.motivo} ≠ ${motivo}`);
    ok(r.diagnostico.comissao.status === status);
    ok(r.fretePrevisto === 9.5, "o frete que veio fica");
  });
  cenario(`frete com ${nome}: null (nunca 0) + motivo ${motivo}`, async () => {
    const r = await buscarComissaoEFrete(ARGS, fetchCom(okListing, resposta));
    ok(r.fretePrevisto === null && r.diagnostico.frete.motivo === motivo && r.diagnostico.frete.aplicavel === true);
  });
}

cenario("payload incompleto (200 sem sale_fee_amount / sem list_cost): ausente + ml_sem_tarifa / ml_sem_frete", async () => {
  const r = await buscarComissaoEFrete(ARGS, fetchCom(async () => ({ ok: true, status: 200, data: [{}] }), async () => ({ ok: true, status: 200, data: { coverage: {} } })));
  ok(r.comissaoValor === null && r.diagnostico.comissao.motivo === "ml_sem_tarifa" && r.diagnostico.comissao.status === 200);
  ok(r.fretePrevisto === null && r.diagnostico.frete.motivo === "ml_sem_frete");
});

cenario("logística combinável: frete NÃO consultado, não aplicável, sem motivo (ausência legítima)", async () => {
  const chamadas = [];
  const r = await buscarComissaoEFrete({ ...ARGS, logisticType: "not_specified" }, fetchCom(okListing, okFrete, chamadas));
  ok(chamadas.length === 1 && String(chamadas[0].path).includes("listing_prices"));
  ok(r.fretePrevisto === null && r.diagnostico.frete.aplicavel === false && r.diagnostico.frete.motivo === null);
});

cenario("anúncio sem categoria/tipo: comissão nem é consultada, motivo explícito", async () => {
  const chamadas = [];
  const r = await buscarComissaoEFrete({ ...ARGS, categoryId: null, listingTypeId: null }, fetchCom(okListing, okFrete, chamadas));
  ok(chamadas.length === 0);
  ok(r.diagnostico.comissao.motivo === "anuncio_sem_tipo_ou_categoria");
});

// ── 3. Margem incompleta nunca é "saudável" ────────────────────────────────
cenario("comissão e frete ausentes: margem (R$ 50 → 46%) é Dado suspeito, nunca Saudável, e o processor não grava", async () => {
  const w = mundoMl({ listing: async () => ({ ok: false, status: 403, data: null }), frete: async () => ({ ok: false, status: 403, data: null }) });
  const r = await motorMargem.enrichBatch(prepared(SELLER_2), { itemIds: ["MLB201"] }, depsMundo(w));
  const item = r.itens[0];
  ok(item.margin.projected.assumed.includes("commission") && item.margin.projected.assumed.includes("freight"));
  ok(item.quality.status !== "HEALTHY", `status ${item.quality.status}`);
  ok(item.quality.status === core.STATUS.SUSPECT_DATA, item.quality.status);
  // O núcleo calcularia 46%; o enrichBatch neutraliza antes de qualquer consumidor.
  ok(item.margin.projected.margin === null && item.margin.projected.profit === null && item.margin.projected.incompleta === true,
    JSON.stringify(item.margin.projected.margin));
  ok(item.diagnostico.cotacao.comissao.motivo === "ml_sem_permissao" && item.diagnostico.cotacao.comissao.status === 403);
});

// ── 4. Processor: snapshot anterior preservado + motivo por item e no run ──
async function rodarProcessor(w, { sementes = [] } = {}) {
  const db = makeMarginSnapshotFakeDb();
  for (const s of sementes) await snapshotRepository.upsertProjectionSnapshot(s, db);
  let run = await runRepository.createRun({ clienteId: 7, clienteSlug: "alianza_jeans", clienteContaId: 87, marketplace: "meli", reason: "manual_refresh", db });
  run = await runRepository.updateRunStatus({ runId: run.id, status: "running", db });
  const cfg = { ...resolveMarginSnapshotConfig({}), batchPauseMs: 0, batchBackoffBaseMs: 1, batchBackoffMaxMs: 1 };
  const relogio = { t: 0 };
  const sleep = async (ms) => { relogio.t += ms; };
  let erro = null;
  try {
    await processMarginSnapshotRun(run, {
      db, logger: SILENCIOSO, config: cfg, sleep,
      rateLimiter: createRateLimiter({ minIntervalMs: 0, now: () => relogio.t, sleep }),
      prepareWorkspaceContext: async () => prepared(SELLER_2),
      listarIdsCatalogo: async () => ({ ids: ["MLB201", "MLB202"], total: 2, totalAtivos: 2, totalPausados: 0 }),
      ...depsMundo(w),
    });
  } catch (e) { erro = e; }
  const runFinal = await runRepository.getRunById({ runId: run.id, clienteContaId: 87, db });
  return { db, erro, run: runFinal };
}

function semente(itemId) {
  return {
    clienteId: 7, clienteSlug: "alianza_jeans", clienteContaId: 87, marketplace: "meli", itemId,
    titulo: "anterior", price: 50, profit: 3.1, margin: 0.062, marginPercent: 6.2, status: "LOW_MARGIN",
    confidenceLevel: "HIGH", quality: {}, missing: [], assumed: [], divergences: [], calculatedAt: new Date("2026-10-30T10:00:00Z"),
    sourceUpdatedAt: null, runId: null, refreshStatus: "fresh",
  };
}

cenario("listing_prices 403 em todos: run falha, snapshot anterior INTACTO, last_error e metadata com HTTP 403", async () => {
  const w = mundoMl({ listing: async () => ({ ok: false, status: 403, data: { status: 403 } }) });
  const { db, erro, run } = await rodarProcessor(w, { sementes: [semente("MLB201")] });
  ok(erro && erro.code === "MARGIN_SNAPSHOT_NENHUM_ITEM_CALCULADO", String(erro && (erro.code || erro.message)));
  const s = await snapshotRepository.getProjectionSnapshot({ clienteContaId: 87, itemId: "MLB201", db });
  ok(s.margin === 0.062 && s.profit === 3.1 && s.marginPercent === 6.2, `valores anteriores preservados: ${JSON.stringify({ m: s.margin, p: s.profit })}`);
  ok(s.refreshStatus === "failed", "identificado como não revalidado");
  ok(/comissão: o Mercado Livre recusou o acesso .* \(HTTP 403\)/.test(s.lastError), s.lastError);
  const motivos = run.metadata.processor.motivos;
  ok(motivos.comissao.ml_sem_permissao === 2, JSON.stringify(motivos));
});

cenario("multiget recusado (403) para os itens: last_error diz HTTP 403 na leitura do anúncio; nada gravado", async () => {
  const w = mundoMl();
  // simula o comportamento ANTIGO: detalhe sem a conta (principal) → 403 por entrada
  const deps = depsMundo(w);
  deps.buscarDetalhesItens = (args) => meliApi.buscarDetalhesItens({ ...args, mlUserId: null }, w.mlFetch);
  const db = makeMarginSnapshotFakeDb();
  await snapshotRepository.upsertProjectionSnapshot(semente("MLB201"), db);
  let run = await runRepository.createRun({ clienteId: 7, clienteSlug: "alianza_jeans", clienteContaId: 87, marketplace: "meli", reason: "manual_refresh", db });
  run = await runRepository.updateRunStatus({ runId: run.id, status: "running", db });
  const relogio = { t: 0 };
  const sleep = async (ms) => { relogio.t += ms; };
  let erro = null;
  try {
    await processMarginSnapshotRun(run, {
      db, logger: SILENCIOSO, config: { ...resolveMarginSnapshotConfig({}), batchPauseMs: 0 }, sleep,
      rateLimiter: createRateLimiter({ minIntervalMs: 0, now: () => relogio.t, sleep }),
      prepareWorkspaceContext: async () => prepared(SELLER_2),
      listarIdsCatalogo: async () => ({ ids: ["MLB201", "MLB202"], total: 2, totalAtivos: 2, totalPausados: 0 }),
      ...deps,
    });
  } catch (e) { erro = e; }
  ok(erro && erro.code === "MARGIN_SNAPSHOT_NENHUM_ITEM_CALCULADO");
  const s = await snapshotRepository.getProjectionSnapshot({ clienteContaId: 87, itemId: "MLB201", db });
  ok(s.margin === 0.062 && s.refreshStatus === "failed" && /HTTP 403/.test(s.lastError), s.lastError);
  const runFinal = await runRepository.getRunById({ runId: run.id, clienteContaId: 87, db });
  ok(runFinal.metadata.processor.motivos.detalhe["403"] === 2, JSON.stringify(runFinal.metadata.processor.motivos));
});

cenario("conta secundária com o código novo: run conclui e grava margem com comissão e frete reais", async () => {
  const w = mundoMl();
  const { db, erro } = await rodarProcessor(w, { sementes: [semente("MLB201")] });
  ok(!erro, String(erro && erro.message));
  const s = await snapshotRepository.getProjectionSnapshot({ clienteContaId: 87, itemId: "MLB201", db });
  ok(s.refreshStatus === "fresh" && Math.abs(s.profit - 6.5) < 0.001 && (s.assumed || []).length === 0, JSON.stringify({ p: s.profit, a: s.assumed }));
});

cenario("próxima sincronização recota medidas atuais no preço vigente e substitui frete antigo no snapshot", async () => {
  const flagAnterior = process.env.FRETE_COTACAO_CONFIAVEL_SELLERS;
  process.env.FRETE_COTACAO_CONFIAVEL_SELLERS = SELLER_2;
  try {
    const precosCotados = [];
    const w = mundoMl({ frete: async ({ path }) => {
      const p = new URLSearchParams(path.split("?")[1]);
      const porDimensoes = p.has("dimensions");
      if (porDimensoes) {
        precosCotados.push(Number(p.get("item_price")));
        ok(!p.has("item_id"), "consulta por medidas não envia item_id");
      }
      return { ok: true, status: 200, data: { coverage: { all_country: {
        list_cost: porDimensoes ? (Number(p.get("item_price")) === 50 ? 19.05 : 20.05) : 7.75,
        discount: { type: porDimensoes ? "mandatory" : "none", rate: porDimensoes ? 0.5 : 0 },
      } } } };
    } });
    w.anuncios.MLB201.logistic_type = "cross_docking";
    const original = w.mlFetch;
    w.mlFetch = async (cid, path, opts) => {
      if (String(path).startsWith("/items/MLB201?")) {
        ok(opts.mlUserId === SELLER_2, "leitura atual usa a conta selecionada");
        return { ok: true, status: 200, data: { id: "MLB201", attributes: [], shipping: {
          dimensions: "32x23x5,680", tags: ["mandatory_free_shipping", "proximity"],
        } } };
      }
      ok(!String(path).startsWith("/orders/"), "sync com medidas atuais não depende de vendas antigas");
      return original(cid, path, opts);
    };
    for (const price of [50, 60]) {
      w.anuncios.MLB201.price = price;
      const { db, erro } = await rodarProcessor(w, { sementes: [{ ...semente("MLB201"), freight: 7.75, refreshStatus: "failed", lastError: "frete indisponível" }] });
      ok(!erro, String(erro && erro.message));
      const s = await snapshotRepository.getProjectionSnapshot({ clienteContaId: 87, itemId: "MLB201", db });
      ok(s.price === price && s.freight === (price === 50 ? 19.05 : 20.05), JSON.stringify({ price: s.price, freight: s.freight }));
      ok(s.refreshStatus === "fresh" && s.lastError === null, "recálculo substitui a falha anterior");
      ok(s.quality.freteQualidade.fonteMedidas === "shipping.dimensions", "fonte das medidas atuais persistida");
    }
    assert.deepStrictEqual(precosCotados, [50, 60]);
  } finally {
    if (flagAnterior === undefined) delete process.env.FRETE_COTACAO_CONFIAVEL_SELLERS;
    else process.env.FRETE_COTACAO_CONFIAVEL_SELLERS = flagAnterior;
  }
});

// ── 4b. Linhas antigas com comissão/frete assumidos 0 (o "45% em R$ 50") ──
cenario("sync recupera frete regular sem dimensões nem histórico e persiste a nova margem", async () => {
  const flagAnterior = process.env.FRETE_COTACAO_CONFIAVEL_SELLERS;
  process.env.FRETE_COTACAO_CONFIAVEL_SELLERS = SELLER_2;
  try {
    const w = mundoMl({ frete: async ({ path }) => {
      const params = new URLSearchParams(path.split("?")[1]);
      const regular = params.has("tags") && !params.get("tags").includes("proximity");
      return { ok: true, status: 200, data: { coverage: { all_country: {
        list_cost: regular ? 19.05 : 7.75, discount: { type: regular ? "mandatory" : "none", rate: regular ? 0.5 : 0 },
      } } } };
    } });
    w.anuncios.MLB201.logistic_type = "cross_docking";
    const original = w.mlFetch;
    w.mlFetch = async (cid, path, opts) => {
      ok(!String(path).startsWith("/orders/") && !String(path).includes("include_attributes"), "modalidade regular não depende de histórico nem medidas");
      if (String(path).startsWith("/items/MLB201?")) return { ok: true, status: 200, data: { shipping: { tags: ["mandatory_free_shipping", "proximity"], dimensions: null }, attributes: [] } };
      return original(cid, path, opts);
    };
    const { db, erro } = await rodarProcessor(w, { sementes: [{ ...semente("MLB201"), freight: 7.75, refreshStatus: "failed", lastError: "frete indisponível" }] });
    ok(!erro, String(erro && erro.message));
    const s = await snapshotRepository.getProjectionSnapshot({ clienteContaId: 87, itemId: "MLB201", db });
    ok(s.freight === 19.05 && s.refreshStatus === "fresh" && s.lastError === null, "snapshot antigo substituído por cotação regular");
    ok(s.quality.freteQualidade.nivel === "cotado_ml" && s.quality.freteQualidade.modalidadeCotada === "mercado_envios_regular", "fonte da modalidade persistida");
    ok(Math.abs(s.profit - (-3.05)) < 0.001, "margem usa o frete regular obtido na sync");
  } finally {
    if (flagAnterior === undefined) delete process.env.FRETE_COTACAO_CONFIAVEL_SELLERS;
    else process.env.FRETE_COTACAO_CONFIAVEL_SELLERS = flagAnterior;
  }
});

cenario("Central: linha antiga inflada fica fora de comMargem e no FIM da ordenação por margem (asc e desc)", async () => {
  const db = makeMarginSnapshotFakeDb();
  const base = { clienteId: 7, clienteSlug: "alianza_jeans", clienteContaId: 87, marketplace: "meli", confidenceLevel: "HIGH",
    quality: {}, missing: [], divergences: [], calculatedAt: new Date("2026-10-30T10:00:00Z"), runId: null, refreshStatus: "fresh" };
  await snapshotRepository.upsertProjectionSnapshot({ ...base, itemId: "MLB1", price: 50, profit: 22.5, margin: 0.45, marginPercent: 45,
    status: "SUSPECT_DATA", assumed: ["commission", "freight"] }, db);
  await snapshotRepository.upsertProjectionSnapshot({ ...base, itemId: "MLB2", price: 80, profit: 8, margin: 0.1, marginPercent: 10,
    status: "HEALTHY", assumed: [] }, db);
  await snapshotRepository.upsertProjectionSnapshot({ ...base, itemId: "MLB3", price: 60, profit: 3, margin: 0.05, marginPercent: 5,
    status: "LOW_MARGIN", assumed: [] }, db);
  const filtro = snapshotRepository.montarFiltroSnapshots({ clienteId: 7, clienteContaId: 87 });
  const kpis = await snapshotRepository.summarizeProjectionSnapshots({ filtro, db });
  ok(kpis.comMargem === 2 && kpis.margemIncompleta === 1, JSON.stringify(kpis));
  for (const ordenacao of ["margem_desc", "margem_asc"]) {
    const { orderBy } = snapshotRepository.resolverOrdenacao({ ordenacao });
    const linhas = await snapshotRepository.queryProjectionSnapshotsPage({ filtro, orderBy, limit: 10, offset: 0, db });
    const ids = linhas.map((r) => r.itemId || r.item_id);
    ok(ids[ids.length - 1] === "MLB1", `${ordenacao}: ${ids}`);
  }
});

// ── 5. Cenário promocional bloqueado sem comissão/frete ────────────────────
cenario("promoção/simulação: comissão ausente bloqueia o cenário (nunca aprova)", async () => {
  const svc = require("../services/meliAnuncios/meliPromocoesRebateService");
  const r = svc.margemNoPreco({ preco: 45, custo: 22, aliquota: 0.1, cotacao: { comissao: null, frete: 9.5, frete_aplicavel: true, motivos: { comissao: "ml_sem_permissao" } } });
  ok(r.ok === false && r.motivo === "ml_sem_permissao", JSON.stringify(r));
  const r2 = svc.margemNoPreco({ preco: 45, custo: 22, aliquota: 0.1, cotacao: { comissao: 6.3, frete: null, frete_aplicavel: true, motivos: { frete: "ml_timeout" } } });
  ok(r2.ok === false, JSON.stringify(r2));
});

// ── 6. Revisão do Codex: todos os caminhos que exibem/usam a margem ──────
async function itemAoVivo({ comissao = true, itemId = "MLB201" } = {}) {
  const w = mundoMl(comissao ? {} : { listing: async () => ({ ok: false, status: 403, data: null }) });
  const r = await motorMargem.enrichBatch(prepared(SELLER_2), { itemIds: [itemId] }, depsMundo(w));
  return r.itens[0];
}

cenario("Central AO VIVO: item sem comissão não mostra margem nem ordena como 46%; combinável sem frete continua com margem", async () => {
  const inc = await itemAoVivo({ comissao: false });
  const l = motorMargem.comAliasesDeCompatibilidade(inc);
  ok(l.projected.margin === null && l.projected.profit === null && l.projected.incompleta === true, JSON.stringify(l.projected));
  const comb = await itemAoVivo({ itemId: "MLB202" }); // not_specified: frete não aplicável
  ok(comb.margin.projected.assumed.includes("freight"), "frete entrou como 0 (não aplicável)");
  const lc = motorMargem.comAliasesDeCompatibilidade(comb);
  ok(lc.projected.margin !== null && lc.projected.incompleta === false, "frete NÃO aplicável não esconde a margem");
});

cenario("Anúncios ao vivo (montarMapaMargem): célula sem número quando falta comissão; com rebate também", async () => {
  const { _paraTeste } = require("../controllers/meliAnunciosController");
  const inc = await itemAoVivo({ comissao: false });
  const { margem } = _paraTeste.montarMapaMargem([inc], false, { itemId: "MLB201", valor: 5 });
  const m = margem.MLB201;
  ok(m.marginPercent === null && m.margin === null && m.profit === null && m.margemIncompleta === true, JSON.stringify(m));
  const okItem = await itemAoVivo();
  const m2 = _paraTeste.montarMapaMargem([okItem], false, null).margem.MLB201;
  ok(m2.marginPercent !== null && m2.margemIncompleta === false);
});

cenario("Anúncios: frete desconhecido mostra insumos disponíveis, sem margem e com motivo para corrigir", async () => {
  const { _paraTeste } = require("../controllers/meliAnunciosController");
  const inc = await itemAoVivo();
  inc.margin.projected = { ...inc.margin.projected, computable: false, margin: null, marginPercent: null, profit: null, assumed: ["freight"] };
  inc.marketplaceCosts.freightProjected = null;
  inc.diagnostico.cotacao = { frete: { aplicavel: true, motivo: "frete_cotacao_nao_confiavel", status: 200 } };
  inc.quality.status = "SUSPECT_DATA";
  const r = _paraTeste.montarMapaMargem([inc], true, { itemId: "MLB201", valor: 5 });
  const m = r.margem.MLB201;
  const c = r.composicao.MLB201;
  ok(m.marginPercent === null && m.profit === null && m.rebate === null, "sem margem ou rebate calculado com frete ausente");
  ok(m.margemIncompletaMotivo.includes("medidas da embalagem"), m.margemIncompletaMotivo);
  ok(c.incompleta === true && c.frete === null && c.freteAplicavel === true, JSON.stringify(c));
  ok(c.venda === 50 && c.custoProduto === 22 && c.comissaoMl === 7, "os insumos obtidos continuam visíveis");
  ok(_paraTeste.montarMapaMargem([inc], false, null).composicao.MLB201 === undefined, "composição continua opt-in");
  const valido = await itemAoVivo();
  const completo = _paraTeste.montarMapaMargem([valido], true, null);
  ok(!completo.composicao.MLB201.incompleta && completo.composicao.MLB201.frete === 9.5, "frete válido preservado");
});

cenario("'Você recebe' e POST simular-margem: sem comissão/frete → sem margem (R$ 45 nunca vira 41%)", async () => {
  const ctrl = require("../controllers/meliAnunciosController");
  const anunciosService = require("../services/meliAnuncios/meliAnunciosService");
  const origMontar = motorMargem.montarItens;
  const origResolver = anunciosService.resolverCliente;
  try {
    const inc = await itemAoVivo({ comissao: false });
    motorMargem.montarItens = async () => ({ itens: [inc] });
    const linhas = await ctrl._paraTeste.anexarVoceRecebe({ cliente: { slug: "alianza_jeans" }, clienteContaId: 87, itemId: "MLB201",
      promocoesItem: [{ id: "P1", precoFinal: 45, subsidioMl: 0 }] });
    ok(linhas[0].voceRecebe.computable === false && linhas[0].voceRecebe.marginPercent === null && linhas[0].voceRecebe.motivo === "comissao_ou_frete_ausente", JSON.stringify(linhas[0].voceRecebe));

    anunciosService.resolverCliente = async () => ({ id: 7, slug: "alianza_jeans" });
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await ctrl.simularMargem({ params: { itemId: "MLB201" }, body: { clienteSlug: "alianza_jeans", clienteContaId: 87, preco: 45 } }, res);
    ok(res.body && res.body.ok === true && res.body.resultado.computable === false && res.body.resultado.marginPercent === null, JSON.stringify(res.body));

    const bom = await itemAoVivo();
    motorMargem.montarItens = async () => ({ itens: [bom] });
    // P0 12/11/2026: no preço ATUAL a simulação usa a cotação completa do Motor;
    // num preço diferente comissão/frete são cotados em P' (ver
    // meliAnunciosSimularMargem.test.js) — sem cotação (aqui: anúncio fora do
    // banco), bloqueia em vez de herdar os valores do preço atual.
    const precoAtual = bom.pricing.current.value;
    const res2 = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await ctrl.simularMargem({ params: { itemId: "MLB201" }, body: { clienteSlug: "alianza_jeans", clienteContaId: 87, preco: precoAtual } }, res2);
    ok(res2.body.resultado.computable === true && res2.body.resultado.marginPercent !== null, "com a cotação completa a simulação continua");
    const origObter = anunciosService.obterAnuncio;
    anunciosService.obterAnuncio = async () => null;
    try {
      const res3 = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await ctrl.simularMargem({ params: { itemId: "MLB201" }, body: { clienteSlug: "alianza_jeans", clienteContaId: 87, preco: 45 } }, res3);
      ok(res3.body.resultado.computable === false && res3.body.resultado.motivoCotacao === "anuncio_sem_conta_ml", JSON.stringify(res3.body.resultado));
    } finally {
      anunciosService.obterAnuncio = origObter;
    }
  } finally {
    motorMargem.montarItens = origMontar;
    anunciosService.resolverCliente = origResolver;
  }
});

cenario("pipeline B (legado): grava sem o número inflado; leitura não aceita linha antiga 'Dado suspeito' como calculável", async () => {
  const repoB = require("../services/motorMargem/margemProjetadaSnapshotRepository");
  const inc = await itemAoVivo({ comissao: false });
  let params = null;
  await repoB.upsertSnapshot({ clienteId: 7, clienteContaId: 87, itemId: "MLB201", item: inc, origemJob: "teste" },
    { query: async (_sql, p) => { params = p; return { rows: [{ inserted: true }] }; } });
  ok(params[3] === null && params[4] === null && params[5] === false, `margin_percent/profit/computable gravados: ${params.slice(3, 6)}`);
  ok(JSON.parse(params[9]).includes("commission"), "faltantes registra a comissão");
  const lido = await repoB.lerSnapshotPorItens({ clienteId: 7, itemIds: ["MLB9"] }, { query: async () => ({ rows: [
    { item_id: "MLB9", margin_percent: "46.00", profit: "23", computable: true, status: "SUSPECT_DATA", calculado_em: null, origem_job: "x" },
  ] }) });
  ok(lido.get("MLB9").computable === false, "46% antigo no legado não volta à célula/ranking");
  ok(lido.get("MLB9").profit === null && lido.get("MLB9").marginPercent === null, "nem o lucro (somado na família) nem o %");
});

cenario("fonte de Anúncios: frete NÃO aplicável (combinável) mantém a margem; frete aplicável ausente esconde; desconhecido mantém", async () => {
  const fonte = require("../services/motorMargem/anunciosMargemProjetadaFonte");
  const db = { async query() { return { rows: [
    { item_id: "A", margin_percent: "20", profit: "10", status: "SUSPECT_DATA", calculated_at: null, assumed_json: ["freight"], refresh_status: "fresh", frete_aplicavel: "false" },
    { item_id: "B", margin_percent: "40", profit: "20", status: "SUSPECT_DATA", calculated_at: null, assumed_json: ["freight"], refresh_status: "fresh", frete_aplicavel: "true" },
    { item_id: "C", margin_percent: "18", profit: "9", status: "SUSPECT_DATA", calculated_at: null, assumed_json: ["freight"], refresh_status: "fresh", frete_aplicavel: null },
  ] }; } };
  const m = await fonte.lerMarginSnapshotPorItens({ clienteId: 7, clienteContaId: 87, itemIds: ["A", "B", "C"] }, db);
  ok(m.get("A").computable === true && m.get("A").marginPercent === 20, "combinável: margem válida");
  ok(m.get("B").computable === false && m.get("B").marginPercent === null, "frete aplicável ausente: escondida");
  ok(m.get("C").computable === true, "aplicabilidade desconhecida (linha antiga): não esconde — status já é Dado suspeito");
});

cenario("desvio projetada × realizada (/realizado): projeção inflada não entra (mapProjectionsForItems)", async () => {
  const db = makeMarginSnapshotFakeDb();
  const base = { clienteId: 7, clienteSlug: "alianza_jeans", clienteContaId: 87, marketplace: "meli", confidenceLevel: "HIGH",
    quality: {}, missing: [], divergences: [], calculatedAt: new Date(), runId: null, refreshStatus: "fresh" };
  await snapshotRepository.upsertProjectionSnapshot({ ...base, itemId: "MLB1", price: 50, profit: 23, margin: 0.46, marginPercent: 46, status: "SUSPECT_DATA", assumed: ["commission", "freight"] }, db);
  await snapshotRepository.upsertProjectionSnapshot({ ...base, itemId: "MLB2", price: 80, profit: 8, margin: 0.1, marginPercent: 10, status: "HEALTHY", assumed: [] }, db);
  const mapa = await snapshotRepository.mapProjectionsForItems({ clienteId: 7, clienteContaId: 87, itemIds: ["MLB1", "MLB2"], db });
  ok(mapa.get("MLB1").margin === null && mapa.get("MLB1").margemIncompleta === true);
  ok(mapa.get("MLB2").margin === 0.1);
});

cenario("processor grava freteAplicavel/logística no quality_json (a leitura distingue não aplicável de ausente)", async () => {
  const w = mundoMl();
  const { db, erro } = await rodarProcessor(w);
  ok(!erro, String(erro && erro.message));
  const s201 = await snapshotRepository.getProjectionSnapshot({ clienteContaId: 87, itemId: "MLB201", db });
  const s202 = await snapshotRepository.getProjectionSnapshot({ clienteContaId: 87, itemId: "MLB202", db });
  ok(s201.quality.freteAplicavel === true && s201.quality.logisticType === "fulfillment", JSON.stringify(s201.quality.freteAplicavel));
  ok(s202.quality.freteAplicavel === false && (s202.assumed || []).includes("freight"), "combinável gravado e marcado como frete não aplicável");
});

// ── 7. Revisão do Codex (2ª rodada) ────────────────────────────────────────
function depsWorkspace(w) {
  return {
    ...depsMundo(w),
    prepareWorkspaceContext: async () => prepared(SELLER_2),
    buscarItensAtivos: async () => ({ ids: ["MLB201", "MLB203"], total: 2 }),
  };
}

cenario("resumo AO VIVO da Central: média, calculáveis e exceções ignoram o item sem comissão", async () => {
  const w = mundoMl();
  const r = await motorMargem.obterResumo({ clienteSlug: "alianza_jeans", clienteContaId: 87 }, depsWorkspace(w));
  const s = JSON.stringify(r);
  // MLB201: 13% (6,5/50). MLB203 sem comissão daria (33−3,3−9,5−10)/33 ≈ 31% — não pode entrar.
  ok(Math.abs(r.placar.margemMedia - 0.13) < 0.001, `margemMedia ${r.placar.margemMedia}`);
  ok(r.placar.itensComMargem === 1 && r.placar.itensSemMargem === 1, JSON.stringify(r.placar));
  const exc203 = (r.excecoes || []).find((e) => e.itemId === "MLB203");
  ok(exc203 && exc203.margemProjetadaPercent === null, `exceção do incompleto: ${JSON.stringify(exc203)}`);
  ok((r.excecoes || []).every((e) => e.itemId !== "MLB203" || e.margemProjetadaPercent === null), s.slice(0, 200));
});

cenario("lista AO VIVO, ordem decrescente: o item sem comissão fica no FIM (não no topo)", async () => {
  const w = mundoMl();
  const desc = await motorMargem.listarItens({ clienteSlug: "alianza_jeans", clienteContaId: 87, ordenacao: "margem_desc" }, depsWorkspace(w));
  const ids = desc.itens.map((i) => i.identity.itemId);
  ok(ids[ids.length - 1] === "MLB203", ids.join());
});

cenario("Cliente 360: margem exibível não usa a projetada incompleta", async () => {
  const { margemExibivel } = require("../services/cliente360/cliente360V3MargemCompositor");
  const inc = await itemAoVivo({ comissao: false });
  ok(margemExibivel(inc).margemPercent === null);
});

cenario("POST /api/margem/composicao (núcleo): comissão ausente → não computável (preço 50 nunca vira 46%)", async () => {
  const c = core.calcularComposicao({ preco: 50, custo: 22, aliquota: 0.1, comissao: null, frete: null });
  ok(c.computavel === false && c.lc === null && c.margem_ratio === null && c.faltando.includes("commission"), JSON.stringify(c));
  const ok2 = core.calcularComposicao({ preco: 50, custo: 22, aliquota: 0.1, comissao: 7, frete: 9.5 });
  ok(ok2.computavel === true && Math.abs(ok2.lc - 6.5) < 0.001);
});

cenario("Precificação (avaliar): atual/proposta sem margem quando falta comissão/frete; combinável continua", async () => {
  const { avaliar } = require("../services/motorMargem/precificacao/precificacaoAvaliacao");
  const base = (motor, logisticType = "fulfillment") => ({
    cliente: { id: 7, slug: "alianza_jeans" }, conta: { id: 87, nome: "Alianza Jeans 2", mlUserId: SELLER_2 },
    anuncio: { itemId: "MLB201", logisticType, titulo: "x" }, contaCorreta: true,
    motor: { precoAtual: 50, precoLista: 50, precoPromocional: null, custo: 22, imposto: 0.1, taxaFixa: 0, comissaoTaxa: null,
      metaMargem: 0.1, breakEven: null, precoAlvo: null, status: "SUSPECT_DATA", confianca: "UNKNOWN", temConflito: false, vendas: null, ...motor },
  });
  const r = avaliar({ base: base({ comissao: null, frete: null }), tipo: "PRICE", novoPreco: 45, precoVisto: 50,
    recote: { comissao: null, comissaoFonte: "indisponivel", frete: null, freteFonte: "indisponivel" } });
  ok(r.atual.margem === null && r.atual.lucro === null, `atual ${r.atual.margem}`);
  ok(r.proposta.margem === null && r.proposta.lucro === null, `proposta ${r.proposta.margem}`);
  ok(r.bloqueado === true);
  const comb = avaliar({ base: base({ comissao: 7, frete: null }, "not_specified"), tipo: "PRICE", novoPreco: 45, precoVisto: 50,
    recote: { comissao: 6.3, comissaoFonte: "recotada", frete: null, freteFonte: "nao_aplicavel" } });
  ok(comb.atual.margem !== null && comb.proposta.margem !== null, "frete combinável não esconde a margem");
});

cenario("SQL: aplicabilidade do frete desconhecida não some dos KPIs (nem comMargem nem margemIncompleta perdem a linha)", async () => {
  const db = makeMarginSnapshotFakeDb();
  const base = { clienteId: 7, clienteSlug: "alianza_jeans", clienteContaId: 87, marketplace: "meli", confidenceLevel: "UNKNOWN",
    missing: [], divergences: [], calculatedAt: new Date(), runId: null, refreshStatus: "fresh" };
  await snapshotRepository.upsertProjectionSnapshot({ ...base, itemId: "MLB7", price: 70, profit: 14, margin: 0.2, marginPercent: 20,
    status: "SUSPECT_DATA", assumed: ["freight"], quality: {} }, db);
  const k = await snapshotRepository.summarizeProjectionSnapshots({ filtro: snapshotRepository.montarFiltroSnapshots({ clienteId: 7, clienteContaId: 87 }), db });
  ok(k.comMargem === 1 && k.margemIncompleta === 0, JSON.stringify(k));
});

cenario("projetada × realizada (bloco de desvio da Central): sem 46% nem −33 pp quando a projetada é incompleta", async () => {
  const { neutralizarMargemIncompleta } = require("../services/motorMargem/margemConfiavel");
  const item = {
    diagnostico: { logisticType: "fulfillment" },
    margin: { projected: { computable: true, margin: 0.46, profit: 23, marginPercent: 46, assumed: ["commission", "freight"], missing: [] },
      realized: { computable: true, margin: 0.13, profit: 6.5 }, projectionError: { comparable: true, deltaPp: -33, deltaRelative: -0.7 } },
    projectedVsRealized: {
      status: "COMPARABLE",
      projected: { price: 50, commission: null, freight: null, profit: 23, margin: 0.46, marginPercent: 46, computable: true, assumed: ["commission", "freight"] },
      realized: { profit: 6.5, margin: 0.13, marginPercent: 13, computable: true },
      drift: { price: 0, commission: null, freight: null, cost: 0, profit: 16.5, marginPercentagePoints: 33 },
      notComparable: [],
    },
  };
  const n = neutralizarMargemIncompleta(item);
  const pvr = n.projectedVsRealized;
  ok(pvr.status === "PROJECTED_NOT_COMPUTABLE", pvr.status);
  ok(pvr.projected.margin === null && pvr.projected.profit === null && pvr.projected.marginPercent === null && pvr.projected.computable === false);
  ok(pvr.drift.profit === null && pvr.drift.marginPercentagePoints === null && pvr.drift.price === 0, "desvios financeiros fora; componentes ficam");
  ok(pvr.realized.margin === 0.13, "realizado intacto");
  ok(n.margin.projectionError.comparable === false && n.margin.projectionError.deltaPp === null);
  ok(item.projectedVsRealized.projected.margin === 0.46, "não muta o item original");
  // e na cadeia real (enrichBatch) o bloco também sai neutralizado
  const inc = await itemAoVivo({ comissao: false });
  ok(inc.projectedVsRealized.projected.margin === null && inc.projectedVsRealized.projected.computable === false, JSON.stringify(inc.projectedVsRealized.projected.margin));
});

(async () => {
  let falhas = 0;
  for (const { nome, fn } of casos) {
    try { await fn(); console.log(`  ✓ ${nome}`); } catch (err) { falhas += 1; console.log(`  ✗ ${nome}\n    ${err && err.stack ? err.stack.split("\n").slice(0, 3).join("\n    ") : err}`); }
  }
  console.log(`\nmargemCotacaoConfiabilidade: ${casos.length - falhas}/${casos.length} cenários, ${checks} checks`);
  if (falhas) process.exit(1);
})();
