// server/tests/fechamentosApiAccountAware.test.js
//
// M8 — Frontend account-aware (Portal/fechamentos-api.js).
// M9 — atualizado para a Read API canônica: carregarTela() buscava
// GET .../read + .../read/daily + .../read/products em paralelo (nunca
// mais o GET legado do payload inteiro) — os 3 precisavam levar
// clienteContaId igualmente, e a resposta virava F.ok/F.summary/F.rows/
// F.daily/F.products (não mais F.rawPayload).
// M10 — carregarTela() passou a buscar GET .../read/bootstrap (1 request,
// backend resolve contexto e monta o payload do período 1x só). Os testes
// abaixo que usam o handler genérico "/operacao/central-vendas/" com
// {ok:true} continuam válidos sem alteração (bootstrap responde na mesma
// forma que /read + campos extras); só o cenário "legado" checava a URL
// literal ".../read?" e precisou trocar para ".../read/bootstrap?". Se o
// backend responder ok:false para o bootstrap, o frontend cai de volta para
// os 3 requests antigos (fetchBootstrap em fechamentos-api.js) — nenhum
// cenário aqui simula essa falha específica ainda.
//
// F2.2 — trocarContexto()/onContaChange()/carregarContasCliente() SAÍRAM
// de fechamentos-api.js: a cardinalidade (1 conta auto-seleciona, 2+ exige
// escolha, dedupe de fan-out) é resolvida por vf-context.js (F0.3), já
// testada exaustivamente em server/tests/vfContext.test.js (49 casos) —
// este arquivo não a reexercita. O que ele continua provando é a reação de
// fechamentos-api.js a um contexto JÁ resolvido: guard de corrida
// (loadSeq/AbortController), a conta certa chegando em cada request
// (read/daily/products/sync-runs/importar-vendas), e o fallback M10.
//
// Fake window.VF.context: um dublê mínimo com a MESMA forma pública de
// vf-context.js (STATES, getClienteAtual, getAccounts, getAccountMeta,
// getContext, signalContextError) — os testes chamam
// simularContexto(sandbox, {...}) para descrever o snapshot que o Shell
// JÁ teria resolvido (ex.: 1 conta ativa → READY com aquela conta), e então
// aplicarContextoDoShell(snap) — a mesma função que o listener real de
// 'vf:context' chama — reage exatamente como reagiria em produção.
//
// Portal/fechamentos-api.js é um script de browser sem module.exports (ver
// docs/CENTRAL_VENDAS_V3_ARQUITETURA.md seção 9.6, mesma limitação já
// registrada no hardening M1/M2 para este mesmo arquivo). Este teste carrega
// o arquivo REAL num contexto `vm` com um DOM/localStorage/fetch mínimos —
// não simula eventos de clique: chama as funções de wiring diretamente
// (aplicarContextoDoShell/executarSincronizacao/pollSyncRun/
// retomarSyncEmAndamento/executarImportacao), que é o que o listener de
// 'vf:context' e wireStatic() acabam chamando. Funções top-level
// (`function foo(){}`) viram propriedades do objeto global do contexto vm —
// acessíveis depois de carregar o script. `F` é `const` (não vira
// propriedade global sozinho), então um segundo script minúsculo o expõe
// via `this.__F = F`.
//
// GET .../read (e .../read/daily, .../read/products) é sempre mockado para
// responder { ok:false } — isso evita exercitar toda a renderização pesada
// (fora do escopo deste teste, que é só wiring de conta) sem esconder nada:
// renderAll() já trata "!F.ok" como um estado leve (branch 3), nunca
// chamando renderFechamentoSection/renderOrdersPanel.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let checks = 0;
function ok(label, cond) { assert.ok(cond, `FALHOU: ${label}`); checks += 1; }
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `FALHOU: ${label} — recebido ${JSON.stringify(actual)}, esperado ${JSON.stringify(expected)}`);
  checks += 1;
}

function criarElementoGenerico() {
  const attrs = {};
  const classes = new Set();
  return {
    hidden: false, value: "", disabled: false, _html: "", _text: "",
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v == null ? "" : String(v); },
    get textContent() { return this._text; },
    set textContent(v) { this._text = v == null ? "" : String(v); },
    dataset: {},
    classList: {
      add: (...ns) => ns.forEach((n) => classes.add(n)),
      remove: (...ns) => ns.forEach((n) => classes.delete(n)),
      toggle: (n, force) => { if (force === undefined) { classes.has(n) ? classes.delete(n) : classes.add(n); } else if (force) classes.add(n); else classes.delete(n); },
      contains: (n) => classes.has(n),
    },
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, focus() {}, click() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function criarDocumentoMock() {
  const cache = new Map();
  return {
    getElementById(id) {
      if (!cache.has(id)) cache.set(id, criarElementoGenerico());
      return cache.get(id);
    },
    body: criarElementoGenerico(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
    _cache: cache,
  };
}

function criarLocalStorageMock(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}

// Dublê de vf-context.js: só a forma pública que aplicarContextoDoShell()
// consome. Não reimplementa cardinalidade — quem decide o snapshot é o
// próprio teste, via simularContexto(). ativo!==false já filtrado pelo
// vf-context real (I3); os fixtures aqui já vêm só com contas ativas,
// então getAccounts() devolve a lista tal como recebida.
function criarFakeVfContext() {
  const STATES = {
    BOOT: "BOOT", PORTFOLIO_ERROR: "PORTFOLIO_ERROR", NO_PORTFOLIO: "NO_PORTFOLIO",
    NO_CLIENT: "NO_CLIENT", RESOLVING_CLIENT: "RESOLVING_CLIENT", INVALID_CLIENT: "INVALID_CLIENT",
    FORBIDDEN: "FORBIDDEN", RESOLVING_ACCOUNTS: "RESOLVING_ACCOUNTS", NO_ACTIVE_ACCOUNT: "NO_ACTIVE_ACCOUNT",
    ACCOUNT_CHOICE_REQUIRED: "ACCOUNT_CHOICE_REQUIRED", INVALID_ACCOUNT: "INVALID_ACCOUNT",
    ACCOUNT_INACTIVE: "ACCOUNT_INACTIVE", READY: "READY",
  };
  let portfolio = [];
  let accounts = [];
  let context = null; // { clienteId, clienteSlug, clienteContaId }
  const signaledErrors = [];

  return {
    STATES,
    getClienteAtual: () => (context ? portfolio.find((c) => c.id === context.clienteId) || null : null),
    getAccounts: () => accounts,
    getAccountMeta: () => {
      if (!context || !context.clienteContaId) return null;
      const conta = accounts.find((c) => c.id === context.clienteContaId);
      return conta ? { id: conta.id, nome: conta.nome, marketplace: conta.marketplace } : null;
    },
    getContext: () => context,
    signalContextError(err) { signaledErrors.push(err); },
    __signaledErrors: signaledErrors,
    __set({ portfolio: p, accounts: a, context: c }) {
      if (p) portfolio = p;
      if (a) accounts = a;
      context = c || null;
    },
  };
}

// Fetch mock: roteia por prefixo de URL, registra toda chamada (URL + init)
// em `log` para asserções, e responde conforme `handlers` (ordenados —
// primeiro prefixo que casa vence). Cada teste monta seus próprios handlers.
function serializeBody(body) {
  if (body && typeof body.entries === 'function' && typeof body.append === 'function') {
    // FormData: representa como "chave=valor;chave2=valor2" para asserções simples.
    return Array.from(body.entries()).map(([k, v]) => `${k}=${v}`).join(';');
  }
  return body ? String(body) : null;
}

function criarFetchMock(handlers, log) {
  return async function fetchMock(url, init = {}) {
    log.push({ url: String(url), method: init.method || 'GET', body: serializeBody(init.body), signal: init.signal || null });
    // Casa pelo ÚLTIMO handler cujo prefixo aparece na URL (não o primeiro):
    // rotas mais específicas (ex.: /sync-runs) são substring de uma rota
    // mais genérica (/operacao/central-vendas/) — a convenção nestes testes
    // é listar handlers do mais genérico para o mais específico.
    let melhor = null;
    for (const [prefix, handler] of handlers) {
      if (String(url).includes(prefix)) melhor = handler;
    }
    if (melhor) return melhor(url, init);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

// Roteia as 3 formas de /sync-runs (criar via POST, listar via GET ?query,
// pollar 1 run via GET /sync-runs/:id) sem depender de ordem de prefixo —
// registrado sob o único prefixo "/sync-runs" (ver criarFetchMock: último
// handler cujo prefixo aparece na URL vence, então isto precisa vir DEPOIS
// do handler genérico de /operacao/central-vendas/ na lista de handlers).
function syncRunsHandler({ onCreate, onPoll, onList }) {
  return (url, init) => {
    const u = String(url);
    if (init.method === "POST") return onCreate(u, init);
    if (/\/sync-runs\/\d+/.test(u)) return onPoll(u, init);
    return onList(u, init);
  };
}

const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "Portal", "fechamentos-api.js"), "utf8");

function bootScript({ handlers = [], log = [], token = "tok-teste" } = {}) {
  const fakeCtx = criarFakeVfContext();
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    URLSearchParams, AbortController,
    FormData: global.FormData,
    document: criarDocumentoMock(),
    window: { location: { replace() {} }, VF: { context: fakeCtx } },
    localStorage: criarLocalStorageMock({ "vf-token": token }),
    fetch: criarFetchMock(handlers, log),
    CSS: { escape: (s) => String(s) },
    requestAnimationFrame: (cb) => cb(),
  };
  vm.createContext(sandbox);
  new vm.Script(SRC, { filename: "fechamentos-api.js" }).runInContext(sandbox);
  // F é const (não vira propriedade global) — expõe por referência. As
  // funções (function declarations) já viram propriedades do sandbox.
  new vm.Script("this.__F = F;", { filename: "expose-F.js" }).runInContext(sandbox);
  sandbox.__fakeCtx = fakeCtx;
  return sandbox;
}

// Descreve o snapshot que vf-context.js JÁ teria resolvido e chama
// aplicarContextoDoShell() — a mesma função que o listener real de
// 'vf:context' invoca em produção. `portfolio`/`accounts` populam o dublê
// ANTES do snapshot, exatamente como getClienteAtual()/getAccounts()
// precisam encontrar dado.
function simularContexto(sandbox, { state, clienteId = null, clienteSlug = null, clienteContaId = null, portfolio, accounts }) {
  const context = clienteId ? { clienteId, clienteSlug, clienteContaId } : null;
  sandbox.__fakeCtx.__set({ portfolio, accounts, context });
  return sandbox.aplicarContextoDoShell({ state, context });
}

async function flush() {
  // Deixa promises pendentes (fetch mock + .then encadeados) resolverem.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

async function run() {
  // ── 1 conta: auto-seleciona (Shell já decidiu) e as chamadas levam seu id ──
  {
    const log = [];
    const contas = [{ id: 501, nome: "ML Loja A", marketplace: "meli", is_primary: true, ativo: true }];
    const sandbox = bootScript({
      log,
      handlers: [
        ["/operacao/central-vendas/", () => jsonResponse(200, { ok: false, erro: "sem dados neste teste" })],
        ["/sync-runs", () => jsonResponse(202, { ok: true, run: { id: 1, status: "queued" } })],
      ],
    });
    const F = sandbox.__F;
    F.periodo = { mode: "mes_atual", dateFrom: "2026-08-01", dateTo: "2026-08-31" };

    simularContexto(sandbox, {
      state: sandbox.__fakeCtx.STATES.READY,
      clienteId: 1, clienteSlug: "cliente-a", clienteContaId: 501,
      portfolio: [{ id: 1, slug: "cliente-a", nome: "Cliente A" }],
      accounts: contas,
    });
    await flush();

    eq("1conta: F.contas tem 1 conta", F.contas.length, 1);
    ok("1conta: conta aplicada é a resolvida pelo Shell", F.clienteConta?.id === 501);
    const getCall = log.find((c) => c.url.includes("/operacao/central-vendas/cliente-a/read?"));
    ok("1conta: GET .../read foi chamado", !!getCall);
    ok("1conta: GET leva clienteContaId=501", getCall.url.includes("clienteContaId=501"));
    const dailyCall = log.find((c) => c.url.includes("/operacao/central-vendas/cliente-a/read/daily?"));
    ok("1conta: GET .../read/daily também é chamado (M9)", !!dailyCall);
    ok("1conta: .../read/daily leva clienteContaId=501", dailyCall.url.includes("clienteContaId=501"));
    const productsCall = log.find((c) => c.url.includes("/operacao/central-vendas/cliente-a/read/products?"));
    ok("1conta: GET .../read/products também é chamado (M9)", !!productsCall);
    ok("1conta: .../read/products leva clienteContaId=501", productsCall.url.includes("clienteContaId=501"));
    console.log("  ✓ 1 conta: contexto do Shell aplicado e as 3 chamadas de leitura (read/daily/products) levam seu id");
  }

  // ── 2 contas, nenhuma escolhida (ACCOUNT_CHOICE_REQUIRED): nenhum GET/sync é disparado ──
  {
    const log = [];
    const contas = [
      { id: 10, nome: "ML 1", marketplace: "meli", is_primary: true, ativo: true },
      { id: 11, nome: "ML 2", marketplace: "meli", is_primary: false, ativo: true },
    ];
    const sandbox = bootScript({
      log,
      handlers: [
        ["/operacao/central-vendas/", () => jsonResponse(200, { ok: false, erro: "nao deveria ser chamado" })],
      ],
    });
    const F = sandbox.__F;
    F.periodo = { mode: "mes_atual", dateFrom: "2026-08-01", dateTo: "2026-08-31" };

    simularContexto(sandbox, {
      state: sandbox.__fakeCtx.STATES.ACCOUNT_CHOICE_REQUIRED,
      clienteId: 1, clienteSlug: "cliente-a", clienteContaId: null,
      portfolio: [{ id: 1, slug: "cliente-a", nome: "Cliente A" }],
      accounts: contas,
    });
    await flush();

    ok("2contas: F.cliente já é conhecido mesmo sem conta escolhida", F.cliente?.slug === "cliente-a");
    eq("2contas: F.contas tem 2", F.contas.length, 2);
    eq("2contas: nenhuma conta pré-selecionada (nunca contas[0])", F.clienteConta, null);
    const getCall = log.find((c) => c.url.includes("/operacao/central-vendas/cliente-a/read"));
    ok("2contas: nenhuma leitura (read/daily/products) disparada sem escolha explicita", !getCall);

    // Tentar sincronizar sem conta escolhida também não deve chamar o backend financeiro.
    await sandbox.executarSincronizacao();
    await flush();
    const syncCall = log.find((c) => c.url.includes("/sync-runs") && c.method === "POST");
    ok("2contas: POST /sync-runs NUNCA disparado sem conta escolhida", !syncCall);

    console.log("  ✓ 2 contas (ACCOUNT_CHOICE_REQUIRED): cliente já conhecido, mas nenhum GET/sync dispara para conta arbitrária");
  }

  // ── troca A→B: resposta atrasada de A não substitui B ──
  {
    const log = [];
    const contas = [
      { id: 10, nome: "ML A", marketplace: "meli", is_primary: true, ativo: true },
      { id: 11, nome: "ML B", marketplace: "meli", is_primary: false, ativo: true },
    ];
    let resolveA;
    const pendenteA = new Promise((r) => { resolveA = r; });
    const sandbox = bootScript({
      log,
      handlers: [
        ["/operacao/central-vendas/", async (url) => {
          // M9: as 3 chamadas (read/read-daily/read-products) da conta A
          // ficam pendentes no MESMO promise — resolvem juntas quando
          // resolveA() é chamado, simulando uma resposta atrasada de rede.
          if (url.includes("clienteContaId=10")) {
            await pendenteA;
            return jsonResponse(200, { ok: true, motor: { status: "persistido", origemPrincipal: "A" }, summary: {}, filteredSummary: {}, rows: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 }, dias: [], produtos: [], periodo: {}, cliente: {} });
          }
          return jsonResponse(200, { ok: true, motor: { status: "persistido", origemPrincipal: "B" }, summary: {}, filteredSummary: {}, rows: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 }, dias: [], produtos: [], periodo: {}, cliente: {} });
        }],
      ],
    });
    const F = sandbox.__F;
    F.periodo = { mode: "mes_atual", dateFrom: "2026-08-01", dateTo: "2026-08-31" };
    const portfolio = [{ id: 1, slug: "cliente-a", nome: "Cliente A" }];

    simularContexto(sandbox, { state: sandbox.__fakeCtx.STATES.ACCOUNT_CHOICE_REQUIRED, clienteId: 1, clienteSlug: "cliente-a", clienteContaId: null, portfolio, accounts: contas });
    await flush();
    eq("trocaAB: 2 contas, nenhuma selecionada ainda", F.clienteConta, null);

    simularContexto(sandbox, { state: sandbox.__fakeCtx.STATES.READY, clienteId: 1, clienteSlug: "cliente-a", clienteContaId: 10, portfolio, accounts: contas }); // A escolhida — dispara leituras que ficam pendentes (pendenteA)
    await flush();
    ok("trocaAB: conta A selecionada", F.clienteConta?.id === 10);

    simularContexto(sandbox, { state: sandbox.__fakeCtx.STATES.READY, clienteId: 1, clienteSlug: "cliente-a", clienteContaId: 11, portfolio, accounts: contas }); // troca para B ANTES de A responder
    await flush();
    ok("trocaAB: conta B selecionada", F.clienteConta?.id === 11);
    eq("trocaAB: dado apos B ja resolvido e o de B", F.motor?.origemPrincipal, "B");

    resolveA(); // A finalmente responde
    await flush();
    eq("trocaAB: resposta atrasada de A NUNCA sobrescreve B", F.motor?.origemPrincipal, "B");
    eq("trocaAB: conta continua B", F.clienteConta?.id, 11);
    console.log("  ✓ troca A→B: resposta atrasada de A não substitui B (read/daily/products)");
  }

  // ── sync: POST /sync-runs recebe a conta correta ──
  {
    const log = [];
    const contas = [{ id: 77, nome: "ML Unica", marketplace: "meli", is_primary: true, ativo: true }];
    const sandbox = bootScript({
      log,
      handlers: [
        ["/operacao/central-vendas/", () => jsonResponse(200, { ok: false })],
        ["/sync-runs", syncRunsHandler({
          onCreate: () => jsonResponse(202, { ok: true, run: { id: 555, status: "queued" } }),
          onPoll: () => jsonResponse(200, { ok: true, run: { id: 555, status: "queued" }, sources: [] }),
          onList: () => jsonResponse(200, { ok: true, runs: [] }),
        })],
      ],
    });
    const F = sandbox.__F;
    F.periodo = { mode: "mes_atual", dateFrom: "2026-08-01", dateTo: "2026-08-31" };
    simularContexto(sandbox, { state: sandbox.__fakeCtx.STATES.READY, clienteId: 1, clienteSlug: "cliente-a", clienteContaId: 77, portfolio: [{ id: 1, slug: "cliente-a", nome: "Cliente A" }], accounts: contas });
    await flush();

    await sandbox.executarSincronizacao();
    await flush();
    const post = log.find((c) => c.url.includes("/sync-runs") && c.method === "POST");
    ok("sync: POST /sync-runs disparado", !!post);
    const body = JSON.parse(post.body);
    eq("sync: body leva clienteContaId correto", body.clienteContaId, 77);
    eq("sync: F.sync.clienteContaId gravado", F.sync.clienteContaId, 77);
    sandbox.pararPollingSync(); // limpa o timer real de retry (poll fica "queued" de propósito)
    console.log("  ✓ sync: POST /sync-runs recebe a conta correta");
  }

  // ── retomada: listagem usa clienteContaId + período ──
  {
    const log = [];
    const contas = [
      { id: 10, nome: "ML A", marketplace: "meli", is_primary: true, ativo: true },
      { id: 11, nome: "ML B", marketplace: "meli", is_primary: false, ativo: true },
    ];
    const sandbox = bootScript({
      log,
      handlers: [
        ["/operacao/central-vendas/", () => jsonResponse(200, { ok: false })],
        ["/sync-runs", syncRunsHandler({
          onCreate: () => jsonResponse(202, { ok: true, run: { id: 999, status: "queued" } }),
          onPoll: () => jsonResponse(200, { ok: true, run: { id: 999, status: "running" }, sources: [] }),
          onList: () => jsonResponse(200, { ok: true, runs: [{ id: 999, status: "running" }] }),
        })],
      ],
    });
    const F = sandbox.__F;
    F.periodo = { mode: "mes_atual", dateFrom: "2026-08-01", dateTo: "2026-08-31" };
    const portfolio = [{ id: 1, slug: "cliente-a", nome: "Cliente A" }];
    simularContexto(sandbox, { state: sandbox.__fakeCtx.STATES.READY, clienteId: 1, clienteSlug: "cliente-a", clienteContaId: 11, portfolio, accounts: contas });
    await flush();

    const listagem = log.find((c) => c.url.includes("/sync-runs?"));
    ok("retomada: GET /sync-runs (listagem) chamado", !!listagem);
    ok("retomada: leva clienteContaId=11", listagem.url.includes("clienteContaId=11"));
    ok("retomada: leva dateFrom/dateTo do periodo aberto", listagem.url.includes("dateFrom=2026-08-01") && listagem.url.includes("dateTo=2026-08-31"));
    eq("retomada: F.sync aponta pro run retomado da conta certa", F.sync.runId, 999);
    eq("retomada: F.sync.clienteContaId == conta ativa", F.sync.clienteContaId, 11);
    sandbox.pararPollingSync(); // limpa o timer real de retry (poll fica "running" de propósito)
    console.log("  ✓ retomada: listagem/retomada usa clienteContaId + período");
  }

  // ── importação: envia a conta correta ──
  {
    const log = [];
    const contas = [{ id: 42, nome: "ML Unica", marketplace: "meli", is_primary: true, ativo: true }];
    const sandbox = bootScript({
      log,
      handlers: [
        ["/operacao/central-vendas/", (url) => (url.includes("importar-vendas") ? jsonResponse(201, { ok: true, pedidosPersistidos: 3 }) : jsonResponse(200, { ok: false }))],
      ],
    });
    const F = sandbox.__F;
    F.periodo = { mode: "mes_atual", dateFrom: "2026-08-01", dateTo: "2026-08-31" };
    simularContexto(sandbox, { state: sandbox.__fakeCtx.STATES.READY, clienteId: 1, clienteSlug: "cliente-a", clienteContaId: 42, portfolio: [{ id: 1, slug: "cliente-a", nome: "Cliente A" }], accounts: contas });
    await flush();
    F.arquivoImport = { name: "vendas.xlsx" }; // FormData real aceita qualquer Blob-like em teste sem File real
    await sandbox.executarImportacao();
    await flush();

    const post = log.find((c) => c.url.includes("importar-vendas"));
    ok("import: POST importar-vendas chamado", !!post);
    ok("import: body (FormData) contem clienteContaId=42", String(post.body).includes("42"));
    console.log("  ✓ importação: envia a conta correta");
  }

  // ── legado: cliente sem cliente_contas continua funcionando (clienteContaId nunca enviado) ──
  {
    const log = [];
    const sandbox = bootScript({
      log,
      handlers: [
        ["/operacao/central-vendas/", () => jsonResponse(200, { ok: true, motor: { status: "persistido" }, summary: {}, filteredSummary: {}, rows: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 }, dias: [], produtos: [], periodo: {}, cliente: {} })],
      ],
    });
    const F = sandbox.__F;
    F.periodo = { mode: "mes_atual", dateFrom: "2026-08-01", dateTo: "2026-08-31" };
    // Cliente sem nenhuma cliente_conta: o Shell chega a NO_ACTIVE_ACCOUNT,
    // não READY — mas o cliente já é conhecido (clienteId setado), então
    // F.cliente é aplicado mesmo assim (mesma lógica do cenário
    // ACCOUNT_CHOICE_REQUIRED acima). Este teste histórico previa READY
    // com 0 contas, que vf-context.js não produz de verdade (§7.2:
    // NO_ACTIVE_ACCOUNT é o estado real para 0 contas) — corrigido aqui
    // para refletir o contrato real da máquina de estados.
    simularContexto(sandbox, { state: sandbox.__fakeCtx.STATES.NO_ACTIVE_ACCOUNT, clienteId: 9, clienteSlug: "cliente-legado", clienteContaId: null, portfolio: [{ id: 9, slug: "cliente-legado", nome: "Cliente Legado" }], accounts: [] });
    await flush();

    eq("legado: 0 contas", F.contas.length, 0);
    eq("legado: nenhuma conta selecionada", F.clienteConta, null);
    ok("legado: cliente já é conhecido (F.cliente populado)", F.cliente?.slug === "cliente-legado");
    // carregarTela() só dispara /read/bootstrap quando F.cliente existe E
    // (F.contas.length <= 1 || F.clienteConta) — com 0 contas, essa segunda
    // condição é F.contas.length<=1 (0<=1, verdadeiro): carrega igual,
    // igual a um cliente sem cliente_contas hoje.
    const getCall = log.find((c) => c.url.includes("/operacao/central-vendas/cliente-legado/read/bootstrap?"));
    ok("legado: GET .../read/bootstrap ainda e chamado normalmente", !!getCall);
    ok("legado: clienteContaId NUNCA enviado", !getCall.url.includes("clienteContaId"));
    ok("legado: dado carregado com sucesso", F.ok === true);
    console.log("  ✓ legado: cliente sem cliente_contas continua funcionando, sem enviar clienteContaId");
  }

  // ── M10: bootstrap falha (backend antigo sem a rota / erro pontual) →
  // fallback automático para os 3 endpoints antigos, cada um com o
  // clienteContaId correto ──
  {
    const log = [];
    const contas = [{ id: 501, nome: "ML Loja A", marketplace: "meli", is_primary: true, ativo: true }];
    const sandbox = bootScript({
      log,
      handlers: [
        ["/operacao/central-vendas/", (url) => {
          const u = String(url);
          if (u.includes("/read/bootstrap")) return jsonResponse(200, { ok: false, erro: "rota indisponivel neste teste" });
          if (u.includes("/read/daily")) return jsonResponse(200, { ok: true, dias: [{ data: "2026-08-01" }] });
          if (u.includes("/read/products")) return jsonResponse(200, { ok: true, produtos: [{ mlb: "MLB1" }], totalFaturamento: 42 });
          return jsonResponse(200, { ok: true, motor: { status: "persistido" }, summary: {}, filteredSummary: {}, rows: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 }, periodo: {}, cliente: {} });
        }],
      ],
    });
    const F = sandbox.__F;
    F.periodo = { mode: "mes_atual", dateFrom: "2026-08-01", dateTo: "2026-08-31" };

    simularContexto(sandbox, { state: sandbox.__fakeCtx.STATES.READY, clienteId: 1, clienteSlug: "cliente-a", clienteContaId: 501, portfolio: [{ id: 1, slug: "cliente-a", nome: "Cliente A" }], accounts: contas });
    await flush();

    eq("fallback: bootstrap foi tentado primeiro", log.filter((c) => c.url.includes("/read/bootstrap?")).length, 1);
    ok("fallback: leva clienteContaId=501", log.find((c) => c.url.includes("/read/bootstrap?")).url.includes("clienteContaId=501"));
    const getCall = log.find((c) => c.url.includes("/operacao/central-vendas/cliente-a/read?"));
    ok("fallback: bootstrap falhou -> GET .../read é chamado em seguida", !!getCall);
    ok("fallback: .../read leva clienteContaId=501", getCall.url.includes("clienteContaId=501"));
    const dailyCall = log.find((c) => c.url.includes("/read/daily?"));
    ok("fallback: .../read/daily também é chamado", !!dailyCall);
    const productsCall = log.find((c) => c.url.includes("/read/products?"));
    ok("fallback: .../read/products também é chamado", !!productsCall);
    ok("fallback: F.ok fica true (dado veio pelo caminho antigo)", F.ok === true);
    eq("fallback: F.daily vem do /read/daily", F.daily, [{ data: "2026-08-01" }]);
    eq("fallback: F.products vem do /read/products", F.products, [{ mlb: "MLB1" }]);
    eq("fallback: F.totalFaturamento vem do /read/products", F.totalFaturamento, 42);
    console.log("  ✓ M10 fallback: bootstrap falho refaz pelo caminho antigo (3 requests), sem perder a tela");
  }

  console.log(`fechamentosApiAccountAware.test.js: ${checks} verificacoes OK`);
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
