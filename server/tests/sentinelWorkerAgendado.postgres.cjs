// server/tests/sentinelWorkerAgendado.postgres.cjs
//
// S1.5 — worker com polling + Billing agendado contra um PostgreSQL LOCAL descartável (fora do run-all):
//   SENTINEL_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57652/postgres node tests/sentinelWorkerAgendado.postgres.cjs
// Roda o WORKER REAL (iniciar → polling com lock real + agendador → executarColeta REAL → lock da conciliação → SQL)
// com um ML FALSO. Cria e dropa o PRÓPRIO banco. Nunca lê server/.env, nunca chama o Mercado Livre, nunca toca produção.
// Os timers do worker são "acelerados" (todo sono limitado a 150 ms): o agendador reverifica o tempo todo, e a única
// proteção contra execução dupla é a agenda relida DENTRO do lock — exatamente o que se quer provar.

const assert = require("assert");
const { Pool, Client } = require("pg");

const baseUrl = process.env.SENTINEL_TEST_DATABASE_URL;
if (!baseUrl) throw new Error("Defina SENTINEL_TEST_DATABASE_URL (PostgreSQL local).");
const parsed = new URL(baseUrl);
if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("LOCAL_DATABASE_REQUIRED");
console.log(`[sentinel.worker.agendado.postgres] host=${parsed.hostname} port=${parsed.port}`);
const dbName = `vf_sentinel_agenda_${Date.now()}`;
const testUrl = new URL(baseUrl);
testUrl.pathname = `/${dbName}`;
process.env.DATABASE_URL = testUrl.toString();

const { ensureSentinelSchema, ensureSentinelConciliacaoSchema, ensureSentinelIncidentesSchema } = require("../services/sentinel/sentinelSchema");
const { executarColeta } = require("../services/sentinel/sentinelConciliacaoColetor");
const { comLockDoCiclo } = require("../services/sentinel/sentinelPollingWorker");
const { CONCILIACAO_CONTRATO_VERSAO } = require("../services/sentinel/sentinelConciliacaoComissao");
const { CONTRATO_VERSAO } = require("../services/sentinel/sentinelEvidenciaFinanceira");
const repo = require("../services/sentinel/sentinelConciliacaoRepositorio");
const A = require("../services/sentinel/sentinelAgendaBilling");
const W = require("../workers/sentinelWorker");

let checks = 0;
function ok(label, cond) { assert.ok(cond, `FALHOU: ${label}`); checks += 1; console.log(`  ok  ${label}`); }
function eq(label, a, b) { assert.deepStrictEqual(a, b, `FALHOU: ${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); checks += 1; console.log(`  ok  ${label}`); }

const HORA = 3600000;
const DIA = 24 * HORA;
const T0 = Date.now();
const SELLER = { 3: "5503", 41: "5541", 86: "5586" };
const CLIENTE_DA_CONTA = { 3: 1, 41: 2, 86: 3 };
const CONTA_DO_SELLER = Object.fromEntries(Object.entries(SELLER).map(([c, s]) => [s, Number(c)]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timersRapidos = { setTimeout: (fn, ms) => setTimeout(fn, Math.min(Math.max(0, ms), 150)), clearTimeout: (t) => clearTimeout(t) };

const FIXTURE_SQL = `
CREATE TABLE clientes (id integer PRIMARY KEY, nome text, slug text UNIQUE, ativo boolean DEFAULT true);
CREATE TABLE cliente_contas (id integer PRIMARY KEY, cliente_id integer REFERENCES clientes(id) ON DELETE CASCADE, marketplace text,
  nome text, slug text, external_account_id text, is_primary boolean, ativo boolean);
INSERT INTO clientes VALUES (1, 'Cliente A', 'cliente-a', true), (2, 'Cliente B', 'cliente-b', true), (3, 'Cliente C', 'cliente-c', true);
INSERT INTO cliente_contas VALUES (3, 1, 'meli', 'Conta 3', 'conta-3', '5503', true, true), (41, 2, 'meli', 'Conta 41', 'conta-41', '5541', true, true),
  (86, 3, 'meli', 'Conta 86', 'conta-86', '5586', true, true);
`;

// ML FALSO: todo pedido conhecido tem Billing (cofinanciado zero, PROCESSED salvo indicação) e descontos do vendedor.
function criarMl() {
  const ml = { log: [], violacoes: [], atrasoMs: 0, billingResposta: null, processing: new Set(), dono: { 5503: new Set(), 5541: new Set(), 5586: new Set() } };
  ml.fn = async (_clienteId, path, opts = {}) => {
    const seller = String(opts.mlUserId);
    ml.log.push({ seller, path, em: Date.now() });
    if (opts.noRefresh !== true) ml.violacoes.push(`sem noRefresh: ${path}`);
    if (ml.atrasoMs) await sleep(ml.atrasoMs);
    if (path.startsWith("/billing/integration/group/ML/order/details?order_ids=")) {
      const ids = path.split("order_ids=")[1].split(",");
      for (const id of ids) if (!ml.dono[seller].has(id)) ml.violacoes.push(`lote do seller ${seller} contém pedido alheio ${id}`);
      if (ml.billingResposta) { const f = ml.billingResposta(seller, ids); if (f) return f; }
      const results = ids.map((id) => {
        const doc = ml.processing.has(id) ? "PROCESSING" : "PROCESSED";
        return {
          order_id: id, payment_info: [{ payment_id: `P${id}`, status: "approved" }],
          sale_fee: { gross: 6.21, net: 6.21, rebate: 0, discount: 0, discount_reason: null },
          details: [["CVVML", 6.16], ["CVVPRC", 0.05]].map(([sub, valor]) => ({
            charge_info: { detail_id: `${id}-${sub}`, detail_amount: valor, detail_type: "CHARGE", detail_sub_type: sub, legal_document_status: doc },
            discount_info: { rebate: null }, items_info: [{ item_id: `MLB${id}`, order_id: id }], marketplace_info: { marketplace: "CORE" },
          })),
        };
      });
      return { ok: true, status: 200, data: { results, errors: [] } };
    }
    const m = path.match(/^\/orders\/(\d+)\/discounts$/);
    if (m) {
      if (!ml.dono[seller].has(m[1])) ml.violacoes.push(`descontos de pedido alheio ${m[1]}`);
      return { ok: true, status: 200, data: { details: [{ type: "discount", supplier: { funding_mode: "seller" }, items: [{ id: `MLB${m[1]}`, quantity: 1, amounts: { total: 1, seller: 1 } }] }] } };
    }
    ml.violacoes.push(`rota inesperada ${path}`);
    return { ok: false, status: 404, data: null };
  };
  ml.contar = (filtro) => ml.log.filter((l) => !filtro || l.path.includes(filtro)).length;
  ml.zerar = () => { ml.log.length = 0; };
  return ml;
}

function criarLogger() {
  const l = { logs: [], warns: [], errors: [] };
  l.log = (m) => l.logs.push(String(m));
  l.warn = (m) => l.warns.push(String(m));
  l.error = (m) => l.errors.push(String(m));
  l.op = (tarefa) => [...l.logs, ...l.warns].filter((m) => m.startsWith("[sentinel-op] {")).map((m) => JSON.parse(m.slice(14))).filter((o) => !tarefa || o.tarefa === tarefa);
  return l;
}

async function main() {
  const admin = new Pool({ connectionString: baseUrl, ssl: false, max: 1, idleTimeoutMillis: 0 }); // sem timer de ocioso: a contagem de timers no fim é só dos workers
  const avisos = [];
  admin.on("error", (e) => avisos.push(`admin: ${e.message}`));
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const pool = new Pool({ connectionString: testUrl.toString(), ssl: false, max: 4, idleTimeoutMillis: 0 });
  pool.on("error", (e) => avisos.push(`pool: ${e.message}`));
  const q = async (sql, p) => (await pool.query(sql, p)).rows;
  const criarClient = () => new Client({ connectionString: testUrl.toString(), ssl: false });
  const novoPool = (max) => { const p = new Pool({ connectionString: testUrl.toString(), ssl: false, max }); p.on("error", (e) => avisos.push(`wpool: ${e.message}`)); return p; };
  const ml = criarMl();
  const resolverOk = async (contaId) => ({ clienteId: CLIENTE_DA_CONTA[contaId], clienteContaId: contaId, sellerId: SELLER[contaId] });
  const silenciar = async (fn) => { const o = [console.log, console.warn]; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { [console.log, console.warn] = o; } };
  const conexoesDoBanco = async () => Number((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname = $1", [dbName])).rows[0].n) - pool.totalCount;
  const agenda = async () => (await q("SELECT * FROM sentinel_conciliacao_controle WHERE chave = 'billing_agenda'"))[0] || null;
  const controle = async (chave) => (await q("SELECT * FROM sentinel_conciliacao_controle WHERE chave = $1", [chave]))[0] || null;
  const linhas = async (conta) => Object.fromEntries((await q("SELECT * FROM sentinel_conciliacao_comissao WHERE cliente_conta_id = $1", [conta])).map((r) => [r.pedido_id, r]));
  const snapshotMargem = async () => JSON.stringify(await q("SELECT cliente_conta_id, pedido_id, faturamento, comissao, frete, custo, imposto, margem_valor, margem_pct, estado_margem, payload_hash FROM sentinel_pedidos ORDER BY 1, 2"));
  let seqPedido = 100000;
  const pedido = async (conta, { diasAtras = 2, hash = null, id = null } = {}) => {
    const pid = String(id || (seqPedido += 1));
    ml.dono[SELLER[conta]].add(pid);
    await q(`INSERT INTO sentinel_pedidos (cliente_id, cliente_conta_id, pedido_id, competencia, data_pedido, status_ml, itens, faturamento, comissao, frete, custo, imposto, margem_valor, margem_pct, estado_margem, payload_hash)
             VALUES ($1, $2, $3, '2026-11', $4, 'paid', $5::jsonb, 57.54, 6.21, 8.15, 30, 7.48, 6.44, 11.19, 'confirmada', $6)`,
    [CLIENTE_DA_CONTA[conta], conta, pid, new Date(T0 - diasAtras * DIA).toISOString(), JSON.stringify([{ item_id: `MLB${pid}`, variation_id: null, quantidade: 1 }]), hash || `h-${pid}`]);
    return pid;
  };
  const DESC = (pid) => JSON.stringify({ details: [{ type: "discount", supplier: { funding_mode: "seller" }, items: [{ id: `MLB${pid}`, quantity: 1, amounts: { total: 1, seller: 1 } }] }] });
  const conciliacao = async (conta, pid, { status, descontos = false, proximaMs = T0 - HORA, observacoes = 1, hash = `h-${pid}`, falhas = 0 }) => {
    await q(`INSERT INTO sentinel_conciliacao_comissao (cliente_conta_id, pedido_id, estado, motivos, contrato_versao, evidencia_versao, pedido_payload_hash,
               status_coleta, observacoes, falhas_consecutivas, proxima_tentativa_em, descontos_min, atualizado_em)
             VALUES ($1, $2, 'NAO_CONCILIADO', ARRAY['documento_em_processamento'], $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
    [conta, pid, CONCILIACAO_CONTRATO_VERSAO, CONTRATO_VERSAO, hash, status, observacoes, falhas, proximaMs ? new Date(proximaMs).toISOString() : null,
      descontos ? DESC(pid) : null, new Date(T0 - 10 * DIA).toISOString()]);
  };
  const cfgColeta = { intervaloEntreChamadasMs: 0 };
  const depsBilling = (extra = {}) => ({ mlFetchBase: ml.fn, resolverConta: resolverOk, criarClient, dormir: async () => {}, ...extra, config: { ...cfgColeta, ...(extra.config || {}) } });
  // polling falso que disputa o LOCK REAL do polling (prova: o agendador não cria um segundo polling)
  const criarPolling = (duracaoMs = 40) => {
    const p = { ciclos: 0, pulados: 0, emCurso: 0, max: 0 };
    p.executar = async ({ contaIds }) => {
      const r = await comLockDoCiclo(async () => { p.emCurso += 1; p.max = Math.max(p.max, p.emCurso); await sleep(duracaoMs); p.emCurso -= 1; p.ciclos += 1; }, { criarClient });
      if (r.pulado) { p.pulados += 1; return { pulado: true, contas: [] }; }
      return { pulado: false, abortado: null, contas: contaIds.map((id) => ({ contaId: id, processados: 0, chamadasMl: 0, porResultado: {}, erro: null })) };
    };
    return p;
  };
  const ENV = { SENTINEL_WORKER_ENABLED: "true", SENTINEL_CONTAS_ALLOWLIST: "3,41,86", SENTINEL_POLL_INTERVAL_MS: "100",
    SENTINEL_CONCILIACAO_AGENDADA_ENABLED: "true", SENTINEL_CONCILIACAO_CONTAS: "41,86" };
  const subir = ({ env = ENV, instancia, polling, logger = criarLogger(), extra = {}, agora, criarPool, criarPoolBilling } = {}) => W.iniciar({
    env, logger, timers: timersRapidos, agora, identidade: { instancia, commit: "c0ffee000000", pid: 1 },
    criarPool: criarPool || (() => novoPool(2)), criarPoolBilling: criarPoolBilling || ((_e, cfg) => novoPool(cfg.poolMax)),
    executar: (polling || criarPolling()).executar, depsBilling: depsBilling(extra),
  }).then((w) => Object.assign(w, { logger }));
  const esperar = async (cond, ms = 5000) => { const t = Date.now(); while (!(await cond())) { if (Date.now() - t > ms) return false; await sleep(25); } return true; };
  const baseTimeouts = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;

  try {
    await q(FIXTURE_SQL);
    await ensureSentinelSchema(pool);
    await ensureSentinelIncidentesSchema(pool);

    console.log("\n1) sem a migration 20261119: worker sobe, polling roda, Billing/heartbeat não gravam nada, 0 chamadas ao ML");
    await pedido(41, { diasAtras: 1 });
    const polling0 = criarPolling();
    const w0 = await subir({ instancia: "sem-schema", polling: polling0 });
    await sleep(800);
    await w0.parar("SIGTERM");
    ok("polling rodou com o lock real", polling0.ciclos >= 3);
    eq("0 chamadas ao ML", ml.contar(), 0);
    eq("tabela de controle continua inexistente (nenhum DDL)", (await q("SELECT to_regclass('public.sentinel_conciliacao_controle') IS NULL AS ok"))[0].ok, true);
    eq("nenhum erro/aviso de heartbeat (ausência de schema não é falha)", w0.logger.warns.filter((m) => /heartbeat não gravado/.test(m)).length, 0);
    await ensureSentinelConciliacaoSchema(pool);
    const margemInicio = await snapshotMargem();

    console.log("\n2) seleção (S1.5): tiers, mais recente primeiro, janela de reconsulta 60 d, incidentes");
    const P = {};
    P.novoAntigo = await pedido(86, { diasAtras: 29.9 });
    P.novoRecente = await pedido(86, { diasAtras: 1 });
    P.novoMeio = await pedido(86, { diasAtras: 10 });
    P.novoIncidente = await pedido(86, { diasAtras: 20 });
    P.novoIncResolvido = await pedido(86, { diasAtras: 21 });
    P.recCache = await pedido(86, { diasAtras: 29.8 }); await conciliacao(86, P.recCache, { status: "reconsultar", descontos: true, proximaMs: T0 - 2 * HORA });
    P.rec45 = await pedido(86, { diasAtras: 45 }); await conciliacao(86, P.rec45, { status: "reconsultar", descontos: true, proximaMs: T0 - HORA });
    P.recSemCache = await pedido(86, { diasAtras: 5 }); await conciliacao(86, P.recSemCache, { status: "falha", proximaMs: T0 - HORA, falhas: 1 });
    P.esg = await pedido(86, { diasAtras: 3 }); await conciliacao(86, P.esg, { status: "esgotada", descontos: true, proximaMs: T0 - HORA });
    P.esgNaoVencida = await pedido(86, { diasAtras: 3 }); await conciliacao(86, P.esgNaoVencida, { status: "esgotada", proximaMs: T0 + DIA });
    P.novo45 = await pedido(86, { diasAtras: 45 });
    P.rec70 = await pedido(86, { diasAtras: 70 }); await conciliacao(86, P.rec70, { status: "reconsultar", descontos: true });
    P.concluida = await pedido(86, { diasAtras: 4 }); await conciliacao(86, P.concluida, { status: "concluida", proximaMs: null });
    P.concHash45 = await pedido(86, { diasAtras: 45 }); await conciliacao(86, P.concHash45, { status: "concluida", proximaMs: null, hash: "antigo" });
    P.recNaoVencida = await pedido(86, { diasAtras: 2 }); await conciliacao(86, P.recNaoVencida, { status: "reconsultar", descontos: true, proximaMs: T0 + HORA });
    const inc = (status, pids) => q(`INSERT INTO sentinel_incidentes (cliente_conta_id, tipo, chave, status, severidade, confiabilidade, titulo, motivo, proxima_acao, fingerprint, pedidos_ids)
      VALUES (86, 'margem_negativa', $1, $2, 'alta', 'calculado', 't', 'm', 'a', 'f', $3)`, [`k-${status}`, status, pids]);
    await inc("aberto", [P.novoIncidente]);
    await inc("resolvido", [P.novoIncResolvido]);
    const sel = (extra = {}) => repo.selecionarCandidatos(pool, 86, { agoraIso: new Date(T0).toISOString(), janelaDias: 30, maturidadeHoras: 6, limite: 60, ...extra });
    const s1 = await sel();
    const nome = Object.fromEntries(Object.entries(P).map(([k, v]) => [v, k]));
    eq("ordem: tier0 (cache, por vencimento) → incidente → novos do MAIS RECENTE ao mais antigo → sem cache → esgotada",
      s1.map((r) => nome[r.pedido_id]), ["recCache", "rec45", "novoIncidente", "novoRecente", "recSemCache", "novoMeio", "novoIncResolvido", "novoAntigo", "esg"]);
    // (integração) recSemCache = 1ª consulta que FALHOU sem observar nada ⇒ tier 2 por recência (5 d), não atrás do backlog
    eq("tiers expostos", s1.map((r) => r.tier), [0, 0, 1, 2, 2, 2, 2, 2, 4]);
    ok("fora: novo de 45 d (1ª consulta só em 30 d), reconsulta de 70 d, concluída, esgotada/reconsulta não vencidas, concluída de 45 d com hash novo",
      ["novo45", "rec70", "concluida", "esgNaoVencida", "concHash45", "recNaoVencida"].every((k) => !s1.some((r) => r.pedido_id === P[k])));
    const s2 = await sel({ comIncidentes: false });
    eq("sem a tabela de incidentes (variante): o citado vira tier 2 na posição da data", s2.map((r) => nome[r.pedido_id]),
      ["recCache", "rec45", "novoRecente", "recSemCache", "novoMeio", "novoIncidente", "novoIncResolvido", "novoAntigo", "esg"]);
    const s3 = await sel({ janelaReconsultaDias: 30 });
    ok("janelaReconsultaDias nunca abaixo de janelaDias; com 30, a reconsulta de 45 d sai", !s3.some((r) => r.pedido_id === P.rec45) && s3.some((r) => r.pedido_id === P.recCache));
    {
      const c = await pool.connect();
      try {
        await c.query("SET enable_seqscan = off");
        const plano = (await c.query(`EXPLAIN ${repo.SELECIONAR_INCIDENTES_SQL}`, [86, new Date(T0).toISOString(), 30, 6, 60, CONCILIACAO_CONTRATO_VERSAO, 60])).rows.map((r) => r["QUERY PLAN"]).join("\n");
        ok("plano usa índice existente em sentinel_pedidos (sem índice novo)", /Index.*(uq_sentinel_pedidos_conta_pedido|idx_sentinel_pedidos)/.test(plano));
      } finally { c.release(); }
    }
    eq("rotação: conta nunca conciliada primeiro, depois a de conciliação mais antiga", await repo.ordenarContasPorAntiguidade(pool, [86, 41, 3]), [3, 41, 86]);
    // limpa o cenário de seleção da conta 86 (não interfere no resto)
    await q("DELETE FROM sentinel_incidentes");
    await q("DELETE FROM sentinel_pedidos WHERE cliente_conta_id = 86");

    console.log("\n3) starvation (19/11): com orçamento curto, o coletor REAL concilia os MAIS RECENTES e as reconsultas baratas — e reconsulta depois de 30 d");
    const novos86 = [];
    for (let i = 0; i < 40; i += 1) novos86.push(await pedido(86, { diasAtras: 0.5 + i * 0.75 })); // 0,5 … 29,75 d
    const rA = await pedido(86, { diasAtras: 29.9 }); await conciliacao(86, rA, { status: "reconsultar", descontos: true, proximaMs: T0 - HORA });
    const rB = await pedido(86, { diasAtras: 29.95 }); await conciliacao(86, rB, { status: "reconsultar", descontos: true, proximaMs: T0 - HORA });
    ml.processing.add(rA); // documento continua provisório
    ml.zerar();
    const st1 = await silenciar(() => executarColeta({ db: pool, contaIds: [86], ...depsBilling({ config: { maxChamadasConta: 4, maxChamadasExecucao: 20 } }), agoraMs: T0 }));
    eq("1 Billing + 3 /discounts (orçamento da conta = 4)", [ml.contar("/billing"), ml.contar("/discounts")], [1, 3]);
    const l86 = await linhas(86);
    eq("os 3 novos conciliados são os 3 MAIS RECENTES", novos86.filter((id) => l86[id]).sort(), novos86.slice(0, 3).sort());
    eq("as 2 reconsultas de ~30 d foram no mesmo lote (0 chamada extra): observações 1 → 2", [l86[rA].observacoes, l86[rB].observacoes], [2, 2]);
    eq("rB (agora PROCESSED) concluída; rA (PROCESSING) volta a reconsultar", [l86[rB].status_coleta, l86[rA].status_coleta], ["concluida", "reconsultar"]);
    ok("execução concluída", st1.executado && st1.resultado === "concluida");
    ml.zerar();
    await silenciar(() => executarColeta({ db: pool, contaIds: [86], ...depsBilling({ config: { maxChamadasConta: 4 } }), agoraMs: T0 + 3 * DIA }));
    const l86b = await linhas(86);
    eq("+3 d: rA tem 32,9 d (fora dos 30) e AINDA é reconsultada (janela de reconsulta 60 d)", l86b[rA].observacoes, 3);
    eq("+3 d: os 3 próximos mais recentes entram", novos86.filter((id) => l86b[id]).length, 6);

    console.log("\n4) orçamento global e por conta em várias execuções + rotação de contas");
    for (const c of [3, 41]) for (let i = 0; i < 10; i += 1) await pedido(c, { diasAtras: 1 + i });
    const primeiros = [];
    for (let k = 0; k < 3; k += 1) {
      ml.zerar();
      await silenciar(() => executarColeta({ db: pool, contaIds: [3, 41, 86], ...depsBilling({ config: { maxChamadasExecucao: 6, maxChamadasConta: 4 } }), agoraMs: T0 + 4 * DIA + k * HORA }));
      const porSeller = {};
      for (const l of ml.log) porSeller[l.seller] = (porSeller[l.seller] || 0) + 1;
      ok(`execução ${k + 1}: ≤ 6 chamadas no total (${ml.log.length}) e ≤ 4 por conta (${JSON.stringify(porSeller)})`, ml.log.length <= 6 && Object.values(porSeller).every((n) => n <= 4));
      primeiros.push(CONTA_DO_SELLER[ml.log[0].seller]);
    }
    eq("rotação: cada conta foi a PRIMEIRA em uma das 3 execuções", [...primeiros].sort((a, b) => a - b), [3, 41, 86]);

    console.log("\n5) grant expirado / token: conta parada sem chamadas e sem refresh; as outras seguem");
    await pedido(41, { diasAtras: 1 });
    await pedido(86, { diasAtras: 1 });
    ml.zerar();
    const antes86 = JSON.stringify(await linhas(86));
    const rG = await silenciar(() => executarColeta({ db: pool, contaIds: [41, 86], agoraMs: T0 + 5 * DIA, ...depsBilling({
      resolverConta: async (id) => { if (id === 86) throw Object.assign(new Error("grant expirado (refresh não permitido)"), { code: "ML_GRANT_EXPIRED" }); return resolverOk(id); },
    }) }));
    eq("conta 86: conta_indisponivel, 0 chamadas, nada gravado", [rG.contas.find((c) => c.contaId === 86).parada, ml.log.filter((l) => l.seller === "5586").length, JSON.stringify(await linhas(86)) === antes86], ["conta_indisponivel", 0, true]);
    ok("conta 41 seguiu na mesma execução", rG.contas.find((c) => c.contaId === 41).gravados >= 1);
    ml.billingResposta = (seller) => (seller === "5541" ? { ok: false, status: 401, data: null } : null);
    await pedido(41, { diasAtras: 1 });
    const r401 = await silenciar(() => executarColeta({ db: pool, contaIds: [41], agoraMs: T0 + 5 * DIA + HORA, ...depsBilling() }));
    eq("401: token_indisponivel (sem refresh, sem retry)", [r401.contas[0].parada, ml.log.filter((l) => l.seller === "5541" && l.path.startsWith("/billing")).length >= 1], ["token_indisponivel", true]);
    ml.billingResposta = null;

    console.log("\n6) gancho da agenda + dois coletores ao mesmo tempo: UMA execução por janela");
    await q("DELETE FROM sentinel_conciliacao_controle");
    ml.zerar(); ml.atrasoMs = 80;
    const g = () => A.criarGanchoAgenda({ intervaloMs: 6 * HORA, instancia: "teste", execucaoId: A.novoExecucaoId(Date.now()) });
    const [c1, c2] = await silenciar(() => Promise.all([0, 1].map(() => executarColeta({ db: pool, contaIds: [41, 86], agenda: g(), ...depsBilling() }))));
    eq("um executou, o outro: lock_ocupado", [c1.executado ? "x" : c1.motivo, c2.executado ? "x" : c2.motivo].sort(), ["lock_ocupado", "x"]);
    const c3 = await silenciar(() => executarColeta({ db: pool, contaIds: [41, 86], agenda: g(), ...depsBilling() }));
    eq("logo depois: nao_devida (agenda relida DENTRO do lock), sem chamada", [c3.motivo, ml.log.filter((l) => l.em > Date.now() - 50).length], ["nao_devida", 0]);
    const ag6 = await agenda();
    ok("agenda: pausado_ate = fim + 6 h, ocorrencias 0, motivo v1 ≤ 4000", Math.abs(new Date(ag6.pausado_ate).getTime() - (new Date(ag6.atualizado_em).getTime() + 6 * HORA)) < 1000
      && ag6.ocorrencias === 0 && JSON.parse(ag6.motivo).v === 1 && ag6.motivo.length <= 4000);
    ok("motivo da agenda sem token/URL/comprador", !/APP_USR|https?:|token|COMPRADOR|nickname/i.test(ag6.motivo));
    ml.atrasoMs = 0;

    console.log("\n7) duas instâncias do worker (mesmo PG): um único Billing por janela, nenhum polling duplicado, posse do heartbeat");
    await q("DELETE FROM sentinel_conciliacao_controle");
    for (let i = 0; i < 4; i += 1) { await pedido(41, { diasAtras: 1 }); await pedido(86, { diasAtras: 1 }); }
    ml.zerar(); ml.atrasoMs = 30;
    const pollingAB = criarPolling(40);
    const [wA, wB] = await Promise.all([subir({ instancia: "inst-A", polling: pollingAB }), subir({ instancia: "inst-B", polling: pollingAB })]);
    await esperar(async () => (await agenda()) !== null && !wA.estado.billing.emExecucao && !wB.estado.billing.emExecucao);
    await sleep(1500); // agendadores "acelerados" reverificando o tempo todo
    const execs = [...wA.logger.op("billing"), ...wB.logger.op("billing")].filter((o) => !["nao_devida", "lock_ocupado"].includes(o.resultado));
    eq("exatamente UMA execução de Billing entre as duas instâncias", execs.map((o) => o.resultado), ["concluida"]);
    eq("a execução registrada na agenda é a mesma", JSON.parse((await agenda()).motivo).execucaoId, execs[0].execucao);
    eq("polling: nunca dois ciclos ao mesmo tempo (lock real)", pollingAB.max, 1);
    ok(`polling seguiu nas duas instâncias (${pollingAB.ciclos} ciclos, ${pollingAB.pulados} pulados pelo lock)`, pollingAB.ciclos >= 10);
    const hb7 = JSON.parse((await controle("worker_processo")).motivo);
    ok("heartbeat: dono é uma das instâncias, 2 boots", ["inst-A", "inst-B"].includes(hb7.instancia) && (await controle("worker_processo")).ocorrencias === 2);
    eq("heartbeat v1 com polling e billing", [hb7.v, hb7.polling.habilitado, hb7.billing.habilitado, hb7.billing.contas, hb7.commit], [1, true, true, [41, 86], "c0ffee000000"]);
    const dono = hb7.instancia === "inst-A" ? wA : wB;
    const outro = dono === wA ? wB : wA;
    await outro.parar("SIGTERM");
    eq("encerramento do NÃO dono não rouba a linha", [JSON.parse((await controle("worker_processo")).motivo).instancia, JSON.parse((await controle("worker_processo")).motivo).encerramento], [hb7.instancia, null]);
    await dono.parar("SIGTERM");
    eq("encerramento do dono: limpo", JSON.parse((await controle("worker_processo")).motivo).encerramento, "limpo");
    await sleep(100);
    eq("todas as conexões dos dois workers fechadas (pools + locks)", await conexoesDoBanco(), 0);
    ml.atrasoMs = 0;

    console.log("\n8) reinício/deploy preserva a agenda (não roda no boot) e as tentativas; vencida ⇒ roda uma vez");
    const agAntes = await agenda();
    const concAntes = JSON.stringify(await q("SELECT cliente_conta_id, pedido_id, observacoes, falhas_consecutivas, status_coleta FROM sentinel_conciliacao_comissao ORDER BY 1, 2"));
    ml.zerar();
    const wC = await subir({ instancia: "inst-C" });
    await sleep(1000);
    await wC.parar("SIGTERM");
    eq("boot com agenda não vencida: 0 chamadas ao ML", ml.contar(), 0);
    eq("agenda intacta", [(await agenda()).pausado_ate.getTime(), (await agenda()).motivo], [agAntes.pausado_ate.getTime(), agAntes.motivo]);
    eq("tentativas/observações intactas", JSON.stringify(await q("SELECT cliente_conta_id, pedido_id, observacoes, falhas_consecutivas, status_coleta FROM sentinel_conciliacao_comissao ORDER BY 1, 2")), concAntes);
    const hb8 = JSON.parse((await controle("worker_processo")).motivo);
    eq("heartbeat do novo boot: anterior = dono anterior com encerramento limpo", [hb8.instancia, hb8.anterior.instancia, hb8.anterior.encerramento], ["inst-C", hb7.instancia, "limpo"]);
    await pedido(41, { diasAtras: 1 });
    const wD = await subir({ instancia: "inst-D", agora: () => Date.now() + 6 * HORA + 60000 });
    await esperar(async () => wD.logger.op("billing").some((o) => o.resultado === "concluida"));
    await sleep(800);
    await wD.parar("SIGTERM");
    eq("relógio +6 h: agenda vencida ⇒ exatamente uma execução", wD.logger.op("billing").filter((o) => o.resultado === "concluida").length, 1);
    ok("nova execução registrada (execucaoId diferente)", JSON.parse((await agenda()).motivo).execucaoId !== JSON.parse(agAntes.motivo).execucaoId);

    console.log("\n9) Billing falha (5xx; 429 embrulhado em 400) e o polling segue; 429 pausa só o Billing");
    const devida = () => q("UPDATE sentinel_conciliacao_controle SET pausado_ate = now() - interval '1 second' WHERE chave IN ('billing_agenda', 'billing_429')");
    await devida();
    const p5 = [await pedido(41, { diasAtras: 1 }), await pedido(41, { diasAtras: 1 })];
    ml.billingResposta = (seller) => (seller === "5541" ? { ok: false, status: 503, data: null } : null);
    const poll9 = criarPolling();
    const w9 = await subir({ instancia: "inst-9", polling: poll9 });
    // (integração) conta com 5xx ⇒ "concluida_com_falhas" (conta como falha seguida; antes saía "concluida" e zerava)
    await esperar(async () => w9.logger.op("billing").some((o) => o.resultado === "concluida_com_falhas"));
    await sleep(400);
    await w9.parar("SIGTERM");
    const o9 = w9.logger.op("billing").find((o) => o.resultado === "concluida_com_falhas");
    eq("5xx: execução concluida_com_falhas, conta 41 parada billing_erro_servidor", o9.contas.find((c) => c.id === 41).parada, "billing_erro_servidor");
    ok("5xx: a linha [sentinel-op] foi como WARN", w9.logger.warns.some((m) => m.includes("billing_erro_servidor")));
    const l41 = await linhas(41);
    ok("5xx: pedidos do lote em 'falha'", p5.every((id) => l41[id] && l41[id].status_coleta === "falha" && l41[id].net_centavos === null));
    ok(`polling seguiu (${poll9.ciclos} ciclos)`, poll9.ciclos >= 3);
    await devida();
    ml.billingResposta = (seller) => (seller === "5541" ? { ok: false, status: 400, data: { status: 400, message: "Http status error with code 429" } } : null);
    await q("UPDATE sentinel_conciliacao_comissao SET proxima_tentativa_em = now() - interval '1 second' WHERE cliente_conta_id = 41 AND status_coleta = 'falha'");
    const poll9b = criarPolling();
    ml.zerar();
    const w9b = await subir({ instancia: "inst-9b", polling: poll9b, env: { ...ENV, SENTINEL_CONCILIACAO_CONTAS: "41" } });
    await esperar(async () => w9b.logger.op("billing").some((o) => o.resultado === "pausa_429"));
    const ciclosNo429 = poll9b.ciclos;
    await sleep(800);
    await w9b.parar("SIGTERM");
    const ag9 = await agenda();
    const p429 = await controle("billing_429");
    eq("429 embrulhado: 1 chamada, resultado pausa_429 na agenda, ocorrencias da agenda 2 (5xx antes + 429 = 2 falhas seguidas)", [ml.contar(), JSON.parse(ag9.motivo).resultado, ag9.ocorrencias], [1, "pausa_429", 2]);
    ok("pausa global registrada (≥ 29 min) e agenda ≥ fim + 6 h", new Date(p429.pausado_ate).getTime() - Date.now() > 29 * 60000
      && new Date(ag9.pausado_ate).getTime() >= new Date(ag9.atualizado_em).getTime() + 6 * HORA - 1000);
    ok(`polling NÃO foi afetado pelo 429 (${ciclosNo429} → ${poll9b.ciclos})`, poll9b.ciclos >= ciclosNo429 + 4);
    ml.billingResposta = null;
    await q("UPDATE sentinel_conciliacao_controle SET pausado_ate = NULL, ocorrencias = 0 WHERE chave = 'billing_429'");

    console.log("\n10) SIGTERM durante o Billing: para entre chamadas, sem falha nos não consultados, pools fechados, heartbeat limpo");
    await devida();
    const p10 = [];
    for (let i = 0; i < 10; i += 1) p10.push(await pedido(41, { diasAtras: 1 }));
    ml.zerar(); ml.atrasoMs = 150;
    const w10 = await subir({ instancia: "inst-10", env: { SENTINEL_CONCILIACAO_AGENDADA_ENABLED: "true", SENTINEL_CONCILIACAO_CONTAS: "41" },
      extra: { config: { maxChamadasExecucao: 30, maxChamadasConta: 30 } } });
    await esperar(async () => ml.contar("/discounts") >= 2);
    const falhasAntes10 = Number((await agenda())?.ocorrencias ?? 0);
    const t10 = Date.now();
    await w10.parar("SIGTERM");
    const dur10 = Date.now() - t10;
    ok(`encerrou rápido (${dur10} ms < 1500; Render dá ~30 s)`, dur10 < 1500);
    const l10 = await linhas(41);
    const gravados10 = p10.filter((id) => l10[id]);
    ok(`parou ENTRE chamadas: ${ml.contar("/discounts")} /discounts de 10, ${gravados10.length} gravados`, ml.contar("/discounts") <= 4 && gravados10.length < 10);
    eq("nenhuma falha gravada nos pedidos não consultados", p10.filter((id) => l10[id] && l10[id].status_coleta === "falha").length, 0);
    eq("agenda: parada_solicitada", JSON.parse((await agenda()).motivo).resultado, "parada_solicitada");
    // integração (líder): SIGTERM de deploy NÃO empurra a fila um intervalo inteiro (6 h) nem conta como falha
    {
      const ag = await agenda();
      const retomaMin = (new Date(ag.pausado_ate).getTime() - new Date(ag.atualizado_em).getTime()) / 60000;
      ok(`parada_solicitada retoma em ≤ 10 min (${retomaMin.toFixed(1)} min), não em 6 h`, retomaMin > 0 && retomaMin <= 10.01);
      eq("parada_solicitada não incrementa falhas seguidas", Number(ag.ocorrencias), falhasAntes10);
    }
    eq("heartbeat: encerramento limpo, billing habilitado e polling desligado", [JSON.parse((await controle("worker_processo")).motivo).encerramento,
      JSON.parse((await controle("worker_processo")).motivo).polling.habilitado], ["limpo", false]);
    await sleep(100);
    eq("conexões fechadas", await conexoesDoBanco(), 0);
    ml.atrasoMs = 0;

    console.log("\n10b) heartbeat com a linha billing_429 em texto puro (não-JSON) e seq scan forçado");
    {
      await q("INSERT INTO sentinel_conciliacao_controle (chave, motivo) VALUES ('billing_429', 'HTTP 429 do ML (conta 41)') ON CONFLICT (chave) DO UPDATE SET motivo = EXCLUDED.motivo");
      const c = await pool.connect();
      try {
        await c.query("SET enable_indexscan = off; SET enable_bitmapscan = off");
        const hb = await c.query("SELECT motivo FROM sentinel_conciliacao_controle WHERE chave = 'worker_processo'");
        const inst = JSON.parse(hb.rows[0].motivo).instancia;
        const r = await c.query(`UPDATE sentinel_conciliacao_controle SET atualizado_em = now()
          WHERE chave = $1 AND (CASE WHEN chave = $1 THEN motivo::jsonb ->> 'instancia' END) = $2`, ["worker_processo", inst]);
        eq("UPDATE de posse do heartbeat convive com motivo não-JSON em outra chave", r.rowCount, 1);
      } finally { c.release(); }
    }

    console.log("\n11) PG indisponível e recuperação: heartbeat/agenda falham sem derrubar; voltam sozinhos");
    await devida();
    let fora = true;
    const proxy = (real) => ({ options: real.options, end: () => real.end(),
      query: (...a) => (fora ? Promise.reject(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" })) : real.query(...a)) });
    const poll11 = criarPolling();
    const w11 = await subir({ instancia: "inst-11", polling: poll11, criarPool: () => proxy(novoPool(2)), criarPoolBilling: () => proxy(novoPool(1)) });
    await sleep(700);
    ok("com o banco fora: nenhuma execução de Billing; boot do polling falha e é retentado (processo vivo)", w11.logger.op("billing").length === 0
      && w11.logger.errors.filter((m) => /polling (NÃO|ainda não) iniciou/.test(m)).length >= 2 && poll11.ciclos === 0);
    ok("heartbeat em memória registra polling.falhaBoot", /ECONNREFUSED|ERRO/.test(w11.estado.polling.falhaBoot || ""));
    ok("aviso do heartbeat com rate-limit (1 só)", w11.logger.warns.filter((m) => /heartbeat não gravado/.test(m)).length === 1);
    fora = false;
    await esperar(async () => w11.logger.op("billing").some((o) => o.resultado === "concluida"));
    await sleep(300);
    await w11.parar("SIGTERM");
    ok("recuperou: Billing executou, polling iniciou sozinho (falhaBoot zerado)", w11.logger.op("billing").some((o) => o.resultado === "concluida") && poll11.ciclos >= 1
      && w11.estado.polling.falhaBoot === null);
    eq("heartbeat assumiu a linha depois da volta do banco", JSON.parse((await controle("worker_processo")).motivo).instancia, "inst-11");

    console.log("\n12a) achados da revisão independente (integração): falha por conta visível, cota do tier 0, encerramento limpo do dono antigo");
    {
      const { avaliarSinais } = require("../services/sentinel/sentinelOperacao");
      // (1) 403 sem permissão de Billing numa conta ⇒ resultado concluida_com_falhas e falhas seguidas sobem (antes: "concluida", 0)
      await q("DELETE FROM sentinel_conciliacao_controle WHERE chave IN ('billing_agenda', 'billing_429')");
      await pedido(41, { diasAtras: 1 });
      ml.billingResposta = () => ({ ok: false, status: 403, data: { message: "forbidden" } });
      const gancho = () => A.criarGanchoAgenda({ intervaloMs: 1, instancia: "rev", execucaoId: "rev" });
      for (let i = 0; i < 2; i += 1) {
        await q("UPDATE sentinel_conciliacao_controle SET pausado_ate = now() - interval '1 second' WHERE chave = 'billing_agenda'");
        const r = await silenciar(() => executarColeta({ ...depsBilling(), db: pool, contaIds: [41], agenda: gancho() }));
        eq(`403 (execução ${i + 1}): resultado concluida_com_falhas`, r.resultado, "concluida_com_falhas");
      }
      const ag = await agenda();
      eq("403 duas vezes ⇒ billing_agenda.ocorrencias = 2", Number(ag.ocorrencias), 2);
      eq("conta parada aparece no resumo da agenda", JSON.parse(ag.motivo).contas[0].parada, "sem_permissao_billing");
      ml.billingResposta = null;
      const sinais = avaliarSinais({ disponivel: true, worker: { estado: "vivo" }, billing: { habilitado: true, falhasSeguidas: 2, ultimaExecucao: { resultado: "concluida_com_falhas" } }, contas: [] }, { agoraMs: Date.now() });
      ok("sinal billing_falhas_seguidas dispara", Array.isArray(sinais) && sinais.some((x) => x.tipo === "billing_falhas_seguidas"));
      await q("DELETE FROM sentinel_conciliacao_controle WHERE chave = 'billing_agenda'");

      // (2) ≥ limite de reconsultas com cache (tier 0) NÃO tomam todas as vagas: novos (tier 2) também são selecionados
      for (let i = 0; i < 70; i += 1) { const pid = await pedido(3, { diasAtras: 3 }); await conciliacao(3, pid, { status: "reconsultar", descontos: true }); }
      const novos = []; for (let i = 0; i < 15; i += 1) novos.push(await pedido(3, { diasAtras: 2 }));
      const sel = await repo.selecionarCandidatos(pool, 3, { agoraIso: new Date().toISOString(), janelaDias: 30, maturidadeHoras: 6, limite: 60, janelaReconsultaDias: 60 });
      eq("cota: 60 do tier 0", sel.filter((r) => Number(r.tier) === 0).length, 60);
      eq("cota: os 15 novos também entram (antes: 0)", sel.filter((r) => novos.includes(String(r.pedido_id))).length, 15);
      ml.zerar();
      const r2 = await silenciar(() => executarColeta({ ...depsBilling({ config: { maxChamadasExecucao: 8, maxChamadasConta: 8 } }), db: pool, contaIds: [3] }));
      ok(`com 8 chamadas, novos são conciliados na MESMA execução (${r2.contas[0].gravados} gravados, ${ml.contar("/discounts")} /discounts)`, ml.contar("/discounts") >= 5);

      // (3) sobreposição de deploy: a nova assume; o "limpo" da antiga vai para `anterior` da nova (sem falso reinício inesperado)
      await q("DELETE FROM sentinel_conciliacao_controle WHERE chave = 'worker_processo'");
      const est = { polling: { habilitado: true }, billing: { habilitado: false } };
      const velho = A.criarHeartbeat({ db: pool, identidade: { instancia: "velha", commit: "c0ffee000000", pid: 1 }, logger: criarLogger(), estado: est });
      await velho.boot();
      const novo = A.criarHeartbeat({ db: pool, identidade: { instancia: "nova", commit: "c0ffee000000", pid: 2 }, logger: criarLogger(), estado: est });
      await novo.boot();
      await velho.encerrar();
      await novo.gravar();
      const hb = JSON.parse((await controle("worker_processo")).motivo);
      eq("dono atual = nova", hb.instancia, "nova");
      eq("anterior = velha com encerramento limpo (mesmo após heartbeat da nova)", [hb.anterior.instancia, hb.anterior.encerramento], ["velha", "limpo"]);
    }

    console.log("\n12) invariantes finais");
    const margemFim = JSON.parse(await snapshotMargem());
    const inicioMap = new Map(JSON.parse(margemInicio).map((r) => [`${r.cliente_conta_id}:${r.pedido_id}`, JSON.stringify(r)]));
    eq("margem oficial (sentinel_pedidos) nunca alterada pelo Billing", margemFim.filter((r) => inicioMap.has(`${r.cliente_conta_id}:${r.pedido_id}`) && inicioMap.get(`${r.cliente_conta_id}:${r.pedido_id}`) !== JSON.stringify(r)), []);
    eq("checkpoints do polling intocados pelo Billing", (await q("SELECT COUNT(*)::int n FROM sentinel_checkpoints"))[0].n, 0);
    {
      const chaves = (await q("SELECT chave FROM sentinel_conciliacao_controle ORDER BY chave")).map((r) => r.chave);
      ok(`controle com tamanho constante: só chaves do contrato (${chaves.join(",")})`,
        chaves.length >= 1 && chaves.every((c) => ["billing_429", "billing_agenda", "worker_processo"].includes(c)));
    }
    eq("violações do ML falso (noRefresh, lote misturado, rota)", ml.violacoes, []);
    await sleep(200);
    const timeoutsFim = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
    ok(`nenhum timer órfão dos workers (Timeout: base ${baseTimeouts}, fim ${timeoutsFim})`, timeoutsFim <= baseTimeouts);
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
  if (avisos.length) console.log(`(avisos de conexão no encerramento: ${avisos.length})`);
  console.log(`\n✓ sentinelWorkerAgendado.postgres: ${checks} verificações`);
}

main().catch((err) => { console.error(err); process.exit(1); });
