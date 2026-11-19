// Coletor de Billing (S1): partes PURAS + processo desligado por padrão. Sem banco, sem ML.
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../services/sentinel/sentinelConciliacaoColetor");
const { MOTIVOS } = require("../services/sentinel/sentinelConciliacaoComissao");
const W = require("../workers/sentinelConciliacaoWorker");

const HORA = 3600000;
const cfg = C.configConciliacao({});
const agoraMs = Date.parse("2026-11-18T12:00:00Z");
const res = (estado, { definitivo = false, motivos = [] } = {}) => ({ estado, motivos, faturamento: { documento: definitivo ? "PROCESSED" : "PROCESSING", definitivo } });
const anterior = (o = {}) => ({ tem_conciliacao: true, pedido_payload_hash: "h1", observacoes: 0, falhas_consecutivas: 0, ...o });

test("P1 comprovada com documento DEFINITIVO ⇒ concluida (sem reconsulta)", () => {
  for (const e of ["TARIFA_LIQUIDA_COMPROVADA", "TARIFA_BRUTA_COMPROVADA", "DIVERGENTE"]) {
    const p = C.politicaAposObservacao(res(e, { definitivo: true }), anterior(), { hash: "h1", cfg, agoraMs });
    assert.deepEqual(p, { status: "concluida", proximaMs: null, observacoes: 1 }, e);
  }
});

test("P2 documento PROCESSING nunca é cache definitivo: reconsulta em reconsultaHoras, até o limite ⇒ esgotada", () => {
  const p = C.politicaAposObservacao(res("TARIFA_LIQUIDA_COMPROVADA"), anterior({ observacoes: 3 }), { hash: "h1", cfg, agoraMs });
  assert.equal(p.status, "reconsultar");
  assert.equal(p.proximaMs, agoraMs + cfg.reconsultaHoras * HORA);
  assert.equal(p.observacoes, 4);
  const fim = C.politicaAposObservacao(res("DIVERGENTE"), anterior({ observacoes: cfg.maxObservacoes - 1 }), { hash: "h1", cfg, agoraMs });
  // esgotada NÃO é definitiva: retentativa longa (a janela é o fim real)
  assert.deepEqual(fim, { status: "esgotada", proximaMs: agoraMs + cfg.esgotadaRetryMs, observacoes: cfg.maxObservacoes });
  assert.equal(cfg.esgotadaRetryMs, 7 * 24 * HORA);
});

test("P3 NAO_CONCILIADO transitório/bloqueio ⇒ reconsultar; só ESCOPO estável ⇒ concluida", () => {
  for (const m of [MOTIVOS.SEM_REGISTRO_BILLING, MOTIVOS.DESCONTOS_NAO_VERIFICADOS, MOTIVOS.PAGAMENTO_NAO_CONFERE, MOTIVOS.CAMPO_BILLING_AUSENTE]) {
    const p = C.politicaAposObservacao(res("NAO_CONCILIADO", { motivos: [m] }), null, { hash: "h1", cfg, agoraMs });
    assert.equal(p.status, "reconsultar", m);
    assert.equal(p.proximaMs, agoraMs + cfg.reconsultaNaoConciliadoHoras * HORA, m);
  }
  for (const m of [MOTIVOS.CUPOM_NAO_VALIDADO, MOTIVOS.CASHBACK_NAO_VALIDADO, MOTIVOS.CANCELAMENTO_OU_REEMBOLSO, MOTIVOS.FUNDING_MODE_NAO_VALIDADO]) {
    const p = C.politicaAposObservacao(res("NAO_CONCILIADO", { motivos: [m, MOTIVOS.DOCUMENTO_EM_PROCESSAMENTO] }), null, { hash: "h1", cfg, agoraMs });
    assert.equal(p.status, "concluida", m);
  }
});

test("P4 pedido mudou (hash) ⇒ contadores recomeçam", () => {
  const p = C.politicaAposObservacao(res("TARIFA_LIQUIDA_COMPROVADA"), anterior({ observacoes: 9 }), { hash: "h2", cfg, agoraMs });
  assert.equal(p.observacoes, 1);
  assert.equal(p.status, "reconsultar");
  const f = C.politicaFalha(anterior({ falhas_consecutivas: 4 }), { hash: "h2", cfg, agoraMs });
  assert.equal(f.falhas, 1);
});

test("P5 falha: backoff exponencial com teto e esgotada após maxFalhas", () => {
  const f1 = C.politicaFalha(null, { hash: "h", cfg, agoraMs });
  assert.deepEqual(f1, { status: "falha", proximaMs: agoraMs + cfg.backoffFalhaMs, falhas: 1 });
  const f3 = C.politicaFalha(anterior({ falhas_consecutivas: 2 }), { hash: "h1", cfg, agoraMs });
  assert.equal(f3.proximaMs, agoraMs + cfg.backoffFalhaMs * 4);
  const teto = C.politicaFalha(anterior({ falhas_consecutivas: 3 }), { hash: "h1", cfg: { ...cfg, backoffFalhaMs: 20 * HORA, maxFalhas: 50 }, agoraMs });
  assert.equal(teto.proximaMs, agoraMs + 24 * HORA);
  const fim = C.politicaFalha(anterior({ falhas_consecutivas: cfg.maxFalhas - 1 }), { hash: "h1", cfg, agoraMs });
  assert.deepEqual(fim, { status: "esgotada", proximaMs: agoraMs + cfg.esgotadaRetryMs, falhas: cfg.maxFalhas });
  // depois de esgotada, a nova falha continua esgotada (retentativa longa, sem crescer)
  const depois = C.politicaFalha(anterior({ falhas_consecutivas: cfg.maxFalhas + 2 }), { hash: "h1", cfg, agoraMs });
  assert.deepEqual(depois, { status: "esgotada", proximaMs: agoraMs + cfg.esgotadaRetryMs, falhas: cfg.maxFalhas + 3 });
});

test("B1 errors[] por pedido: isola só quando TODO erro aponta um pedido do lote; qualquer ambiguidade ⇒ null (lote inteiro)", () => {
  const ids = ["111", "222", "333"];
  assert.deepEqual([...C.pedidosDosErros([], ids)], []);
  assert.deepEqual([...C.pedidosDosErros([{ order_id: 222, code: "x" }], ids)], ["222"]);
  assert.deepEqual([...C.pedidosDosErros([{ order_id: "111" }, { id: 333 }], ids)].sort(), ["111", "333"]);
  assert.equal(C.pedidosDosErros([{ code: "x" }], ids), null); // sem id
  assert.equal(C.pedidosDosErros([{ order_id: 999 }], ids), null); // id fora do lote
  assert.equal(C.pedidosDosErros([{ order_id: 111, id: 222 }], ids), null); // ambíguo
  assert.equal(C.pedidosDosErros(["texto"], ids), null);
  assert.equal(C.pedidosDosErros([{ order_id: "1;DROP" }], ids), null);
});

test("B2 lotes: isolamento progressivo por falhas (60, 15, 3, 1) e orçamento — sem Billing para pedido que não cabe", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((f) => C.tamanhoLote(60, f)), [60, 15, 3, 1, 1]);
  const lin = (id, o = {}) => ({ pedido_id: id, falhas_consecutivas: 0, descontos_min: null, ...o });
  // 1 vaga de descontos: entra 1 pedido sem cache + todos os que já têm descontos; o resto fica na fila
  const fila = [lin("1"), lin("2"), lin("3", { descontos_min: { details: [] } }), lin("4")];
  const lote = C.tirarLote(fila, { loteMax: 60, vagasDescontos: 1 });
  assert.deepEqual(lote.map((l) => l.pedido_id), ["1", "3"]);
  assert.deepEqual(fila.map((l) => l.pedido_id), ["2", "4"]);
  assert.deepEqual(C.tirarLote(fila, { loteMax: 60, vagasDescontos: 0 }), []); // nada cabe ⇒ parar sem chamar
  // pedidos em falha vão em lotes menores e não se misturam com os limpos
  const f2 = [lin("a", { falhas_consecutivas: 1 }), lin("b"), ...Array.from({ length: 20 }, (_, i) => lin(`x${i}`, { falhas_consecutivas: 1 }))];
  const l1 = C.tirarLote(f2, { loteMax: 60, vagasDescontos: 100 });
  assert.equal(l1.length, 15);
  assert.ok(l1.every((l) => l.falhas_consecutivas === 1));
});

test("P6 pausa 429: maior entre Retry-After e backoff exponencial, teto 24 h", () => {
  assert.equal(C.duracaoPausa429({ retryAfterSeg: null, ocorrenciasAnteriores: 0, cfg }), cfg.pausa429Ms);
  assert.equal(C.duracaoPausa429({ retryAfterSeg: null, ocorrenciasAnteriores: 2, cfg }), cfg.pausa429Ms * 4);
  assert.equal(C.duracaoPausa429({ retryAfterSeg: 7200, ocorrenciasAnteriores: 0, cfg }), 7200000);
  assert.equal(C.duracaoPausa429({ retryAfterSeg: 10, ocorrenciasAnteriores: 0, cfg }), cfg.pausa429Ms);
  assert.equal(C.duracaoPausa429({ retryAfterSeg: null, ocorrenciasAnteriores: 99, cfg }), 24 * HORA);
});

test("K1 classificação de respostas e erros do ML (nunca lança)", () => {
  const casos = [[{ status: 200, data: {} }, "ok"], [{ status: 200, data: null }, "erro"], [{ status: 206, data: {} }, "parcial"],
    [{ status: 429 }, "limite"], [{ status: 401 }, "token"], [{ status: 403 }, "proibido"], [{ status: 404 }, "nao_encontrado"],
    [{ status: 500 }, "erro_servidor"], [{ status: 503 }, "erro_servidor"], [{ status: 418 }, "erro"]];
  for (const [r, c] of casos) assert.equal(C.classificar(r, null), c, String(r.status));
  assert.equal(C.classificar(null, { code: "SENTINEL_TOKEN_INDISPONIVEL" }), "token");
  assert.equal(C.classificar(null, { code: "ML_TOKEN_EXPIRED" }), "token");
  assert.equal(C.classificar(null, { name: "MlTimeoutError" }), "timeout");
  assert.equal(C.classificar(null, { code: "SENTINEL_ORCAMENTO_CHAMADAS" }), "orcamento");
  assert.equal(C.classificar(null, new Error("x")), "erro");
});

test("K2 compactarDescontos guarda só o que o conciliador lê; formato inesperado ⇒ null (não verificado)", () => {
  const bruto = { details: [{ type: "discount", offer_id: "OFF9", meli_campaign: "C1", supplier: { funding_mode: "sale_fee", id: 1, nome: "x" },
    items: [{ id: "MLB1", variation_id: 7, quantity: 1, amounts: { total: 20.46, seller: 19.31, extra: 1 }, title: "Produto" }] }], buyer: { nickname: "N" } };
  const c = C.compactarDescontos(bruto);
  assert.deepEqual(c, { details: [{ type: "discount", supplier: { funding_mode: "sale_fee" }, items: [{ id: "MLB1", variation_id: 7, quantity: 1, amounts: { total: 20.46, seller: 19.31 } }] }] });
  assert.equal(JSON.stringify(c).includes("nickname"), false);
  for (const x of [null, undefined, {}, { details: "x" }, "texto"]) assert.equal(C.compactarDescontos(x), null);
  assert.deepEqual(C.compactarDescontos({ details: [] }), { details: [] });
});

test("K3 pedidoDaLinha usa a COMISSÃO OFICIAL como sale_fee e não inventa pagamento/seller", () => {
  const p = C.pedidoDaLinha({ pedido_id: "123", status_ml: "paid", comissao: "5.47", itens: [{ item_id: "MLB1", variation_id: null, quantidade: 1 }] });
  assert.deepEqual(p, { id: "123", status: "paid", order_items: [{ item: { id: "MLB1", variation_id: null }, quantity: 1, sale_fee: "5.47" }] });
  assert.equal("payments" in p, false);
  assert.equal("seller" in p, false);
});

test("K4 configuração: lote nunca passa de 60; limites com piso/teto; padrões conservadores", () => {
  assert.equal(C.configConciliacao({ SENTINEL_CONCILIACAO_LOTE: "500" }).loteMax, 60);
  assert.equal(C.configConciliacao({ SENTINEL_CONCILIACAO_LOTE: "0" }).loteMax, 1);
  assert.equal(C.configConciliacao({ SENTINEL_CONCILIACAO_MAX_CHAMADAS_EXECUCAO: "abc" }).maxChamadasExecucao, 20);
  assert.equal(cfg.maxChamadasConta, 8);
  assert.equal(C.configConciliacao({ SENTINEL_CONCILIACAO_MAX_CHAMADAS_CONTA: "1" }).maxChamadasConta, 2); // piso útil
  assert.equal(C.configConciliacao({ SENTINEL_CONCILIACAO_MAX_CHAMADAS_EXECUCAO: "3" }).maxChamadasExecucao, 3); // ativação controlada
  assert.equal(cfg.intervaloEntreChamadasMs, 1000);
  assert.equal(C.LOTE_MAX_ML, 60);
  assert.notEqual(C.CONCILIACAO_LOCK_KEY, require("../services/sentinel/sentinelPollingWorker").LOCK_KEY); // nunca disputa o polling
});

test("W1 processo DESLIGADO por padrão: não cria pool nem executa", async () => {
  let pools = 0, execucoes = 0;
  const logs = [];
  const logger = { log: (m) => logs.push(m), error: (m) => logs.push(m) };
  for (const env of [{}, { SENTINEL_CONCILIACAO_ENABLED: "false" }, { SENTINEL_CONCILIACAO_ENABLED: "0", SENTINEL_CONCILIACAO_CONTAS: "41" }]) {
    const r = await W.iniciar({ env, logger, criarPool: () => { pools += 1; }, executar: async () => { execucoes += 1; } });
    assert.deepEqual(r, { iniciado: false, motivo: "flag_off" });
  }
  // ligado, mas sem allowlist PRÓPRIA (a do polling não vale)
  const r = await W.iniciar({ env: { SENTINEL_CONCILIACAO_ENABLED: "true", SENTINEL_CONTAS_ALLOWLIST: "41" }, logger, criarPool: () => { pools += 1; }, executar: async () => { execucoes += 1; } });
  assert.deepEqual(r, { iniciado: false, motivo: "allowlist_vazia" });
  assert.equal(pools, 0);
  assert.equal(execucoes, 0);
});

test("W2 ligado + allowlist + UMA_VEZ: uma execução com as contas da allowlist e encerra o pool", async () => {
  let fechado = false;
  const chamadas = [];
  const w = await W.iniciar({
    env: { SENTINEL_CONCILIACAO_ENABLED: "true", SENTINEL_CONCILIACAO_CONTAS: "41, 86,x", SENTINEL_CONCILIACAO_UMA_VEZ: "true" },
    logger: { log() {}, error() {} },
    criarPool: () => ({ end: async () => { fechado = true; } }),
    executar: async (a) => { chamadas.push(a.contaIds); },
  });
  assert.equal(w.iniciado, true);
  await w.fim;
  assert.deepEqual(chamadas, [[41, 86]]);
  assert.equal(fechado, true);
  assert.equal(W.intervaloMs({ SENTINEL_CONCILIACAO_INTERVAL_MS: "1000" }), 10 * 60 * 1000); // piso de 10 min
});

test("E1 executarColeta sem contas ou sem schema: nenhuma chamada ao ML, nenhum lock", async () => {
  let ml = 0;
  const mlFetchBase = async () => { ml += 1; return { status: 200, data: {} }; };
  const r1 = await C.executarColeta({ db: { query: async () => ({ rows: [] }) }, contaIds: [], mlFetchBase });
  assert.equal(r1.motivo, "sem_contas");
  const r2 = await C.executarColeta({ db: { query: async () => ({ rows: [{ ok: false }] }) }, contaIds: [41], mlFetchBase, criarClient: () => { throw new Error("não deveria abrir lock"); } });
  assert.equal(r2.motivo, "schema_ausente");
  assert.equal(ml, 0);
});

test("CLI1 sentinel-conciliacao: --contas só aceita ids numéricos; sem --contas ⇒ null (status lê todas)", () => {
  const { lerContas, lerArgs } = require("../scripts/sentinel-conciliacao");
  assert.deepEqual(lerContas("41"), [41]);
  assert.deepEqual(lerContas("41, 3,86,41"), [41, 3, 86]);
  assert.equal(lerContas(undefined), null);
  for (const v of ["", "41;DROP", "abc", "4.1", "-1"]) assert.equal(lerContas(v), undefined, v);
  assert.deepEqual(lerArgs(["executar", "--contas=41", "--max-chamadas=3", "--confirm-host=h"]), { _: ["executar"], contas: "41", "max-chamadas": "3", "confirm-host": "h" });
});

test("K1b 429 EMBRULHADO (visto em produção: HTTP 400 'Http status error with code 429') ⇒ limite (pausa global)", () => {
  const real = { status: 400, data: { timestamp: "2026-11-17T21:06:26Z", status: 400, type: "BAD_REQUEST_ERROR", message: "Http status error with code 429", path: "/monthly/periods" } };
  assert.equal(C.classificar(real, null), "limite");
  assert.equal(C.classificar({ status: 503, data: { error: "too_many_requests" } }, null), "limite");
  assert.equal(C.classificar({ status: 403, data: { status: 429 } }, null), "limite");
  assert.equal(C.classificar({ status: 400, data: { message: "invalid order_ids" } }, null), "erro");
  assert.equal(C.classificar({ status: 400, data: { message: "order 4290001 not found" } }, null), "erro"); // número que contém 429 ≠ 429
  assert.equal(C.classificar({ status: 401, data: { message: "code 429" } }, null), "token"); // 401 continua token
  assert.equal(C.classificar({ status: 404, data: null }, null), "nao_encontrado");
});
