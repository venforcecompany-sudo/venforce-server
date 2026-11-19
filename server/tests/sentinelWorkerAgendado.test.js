// S1.5 — worker com polling + Billing agendado no MESMO processo. Sem banco real, sem ML: relógio e timers FALSOS
// (tempo simulado), banco em memória que entende só o SQL de sentinel_conciliacao_controle/cliente_contas/schema.
//   node --test tests/sentinelWorkerAgendado.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const W = require("../workers/sentinelWorker");
const A = require("../services/sentinel/sentinelAgendaBilling");

const S = 1000;
const MIN = 60 * S;
const HORA = 60 * MIN;
const T0 = Date.parse("2026-11-19T12:00:00Z");

// ── relógio + timers falsos ─────────────────────────────────────────────────────────────────────────
function criarRelogio(inicio = T0) {
  let agora = inicio;
  let seq = 0;
  const fila = [];
  const drenar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  const timers = {
    setTimeout: (fn, ms) => { const h = { id: ++seq, em: agora + Math.max(0, Number(ms) || 0), fn }; fila.push(h); return h; },
    clearTimeout: (h) => { const i = fila.indexOf(h); if (i >= 0) fila.splice(i, 1); },
  };
  return {
    agora: () => agora,
    timers,
    pendentes: () => fila.length,
    dormir: (ms) => new Promise((r) => timers.setTimeout(r, ms)),
    drenar,
    async avancar(ms) {
      const alvo = agora + ms;
      for (;;) {
        await drenar();
        fila.sort((a, b) => a.em - b.em || a.id - b.id);
        const h = fila[0];
        if (!h || h.em > alvo) break;
        fila.shift();
        agora = Math.max(agora, h.em);
        h.fn();
      }
      agora = alvo;
      await drenar();
    },
  };
}

// ── banco em memória (compartilhável entre "instâncias") ─────────────────────────────────────────────
function criarStore() { return { controle: new Map(), lock: false, schemaConciliacao: true }; }
function criarDbFalso(store, { contas = [3, 41, 86], nome = "db" } = {}) {
  const db = {
    nome, falhar: false, encerrado: false, consultas: 0, options: { max: 1 },
    async query(sql, p = []) {
      db.consultas += 1;
      if (db.encerrado) throw new Error(`${nome}: pool encerrado`);
      if (db.falhar) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" });
      const s = String(sql);
      if (/unnest\(\$1::text\[\]\)/.test(s)) return { rows: p[0].map((t) => ({ nome: t, existe: true })) };
      if (/information_schema\.columns/.test(s)) {
        return { rows: [["sentinel_pedidos", "payload_hash"], ["sentinel_checkpoints", "atraso_segundos"], ["sentinel_checkpoints", "atraso_medido_em"],
          ["sentinel_checkpoints", "ciclos_sem_progresso"]].map(([table_name, column_name]) => ({ table_name, column_name })) };
      }
      if (/to_regclass\('public\.sentinel_conciliacao_comissao'\)/.test(s)) return { rows: [{ ok: store.schemaConciliacao }] };
      if (/FROM cliente_contas/.test(s)) return { rows: contas.filter((id) => p[0].includes(id)).map((id) => ({ id })) };
      if (!store.schemaConciliacao && /sentinel_conciliacao_controle/.test(s)) throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      if (/SELECT pausado_ate, ocorrencias, atualizado_em FROM sentinel_conciliacao_controle/.test(s)) {
        const l = store.controle.get(p[0]);
        return { rows: l ? [l] : [] };
      }
      if (/SELECT pausado_ate FROM sentinel_conciliacao_controle WHERE chave = 'billing_429'/.test(s)) {
        const l = store.controle.get("billing_429");
        return { rows: l ? [l] : [] };
      }
      if (/SELECT motivo FROM sentinel_conciliacao_controle/.test(s)) {
        const l = store.controle.get(p[0]);
        return { rows: l ? [{ motivo: l.motivo }] : [] };
      }
      if (/AGENDA_BILLING/.test(s)) {
        const [chave, ate, motivo, em, contador] = p; // contador: zera | mantem | incrementa (mesma semântica do SQL)
        const ant = store.controle.get(chave);
        const ocorrencias = contador === "zera" ? 0 : contador === "mantem" ? (ant ? ant.ocorrencias : 0) : (ant ? ant.ocorrencias + 1 : 1);
        store.controle.set(chave, { pausado_ate: ate, ocorrencias, motivo, atualizado_em: em });
        return { rows: [] };
      }
      if (/INSERT INTO sentinel_conciliacao_controle/.test(s)) { // boot do heartbeat
        const [chave, motivo, em] = p;
        const ant = store.controle.get(chave);
        store.controle.set(chave, { pausado_ate: null, ocorrencias: ant ? ant.ocorrencias + 1 : 1, motivo, atualizado_em: em });
        return { rows: [] };
      }
      if (/UPDATE sentinel_conciliacao_controle\s+SET motivo = jsonb_set\(\$2/.test(s)) { // heartbeat do dono (preserva `anterior`)
        const [chave, motivo, em, inst] = p;
        const l = store.controle.get(chave);
        if (l && JSON.parse(l.motivo).instancia === inst) {
          const novo = JSON.parse(motivo);
          novo.anterior = JSON.parse(l.motivo).anterior ?? null;
          l.motivo = JSON.stringify(novo); l.atualizado_em = em; return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (/\{anterior,encerramento\}/.test(s)) { // dono antigo marca o próprio encerramento limpo no `anterior` do novo
        const [chave, inst, em] = p;
        const l = store.controle.get(chave);
        const m = l ? JSON.parse(l.motivo) : null;
        if (m && m.anterior && m.anterior.instancia === inst) {
          m.anterior.encerramento = "limpo"; m.anterior.encerradoEm = em; l.motivo = JSON.stringify(m); return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`SQL inesperado no banco falso: ${s.slice(0, 80)}`);
    },
    async end() { db.encerrado = true; },
  };
  return db;
}

// ── polling falso (ciclo de ~10 s simulados) e Billing falso (emula o contrato do coletor) ────────────
function criarPollingFalso(relogio, { duracaoMs = 10 * S } = {}) {
  const p = { ciclos: 0, emCurso: 0, maxEmCurso: 0, falhar: null, erroConta: null, inicios: [] };
  p.executar = async ({ contaIds, deveParar }) => {
    p.ciclos += 1;
    p.emCurso += 1;
    p.maxEmCurso = Math.max(p.maxEmCurso, p.emCurso);
    p.inicios.push(relogio.agora());
    try {
      await relogio.dormir(duracaoMs);
      if (p.falhar) throw p.falhar;
      return { pulado: false, abortado: null, contas: contaIds.map((id) => ({ contaId: id, processados: 5, chamadasMl: 3, porResultado: { gravado: 2, pulado: 3 },
        erro: p.erroConta && p.erroConta.conta === id ? p.erroConta.texto : null, atrasoSegundos: 30 })) };
    } finally { p.emCurso -= 1; }
  };
  return p;
}

function criarBillingFalso(relogio, store, { chamadas = 6, msPorChamada = 1 * S } = {}) {
  const b = { execucoes: 0, naoDevidas: 0, lockOcupado: 0, chamadasMl: 0, inicios: [], modo: "ok", durantePolling: 0, polling: null, chamadasFeitas: [] };
  b.executar = async (a) => {
    if (b.modo === "excecao") throw Object.assign(new Error("boom interno"), { code: "XYZ" });
    if (store.lock) { b.lockOcupado += 1; return { executado: false, motivo: "lock_ocupado", contas: [] }; }
    store.lock = true;
    try {
      if (!(await a.agenda.devida(a.db))) { b.naoDevidas += 1; return { executado: false, motivo: "nao_devida", contas: [] }; }
      b.execucoes += 1;
      b.inicios.push(relogio.agora());
      if (b.polling && b.polling.emCurso > 0) b.durantePolling += 1;
      let feitas = 0;
      let resultado = "concluida";
      let parou429 = false;
      for (let i = 0; i < chamadas; i += 1) {
        if (a.deveParar()) { resultado = "parada_solicitada"; break; }
        await relogio.dormir(msPorChamada);
        feitas += 1;
        b.chamadasMl += 1;
        if (b.modo === "429") {
          store.controle.set("billing_429", { pausado_ate: new Date(a.agora() + 30 * MIN).toISOString(), ocorrencias: 1, motivo: "429", atualizado_em: null });
          parou429 = true; resultado = "pausa_429"; break;
        }
      }
      b.chamadasFeitas.push(feitas);
      const contas = a.contaIds.map((id) => ({ contaId: id, candidatos: 2, chamadasBilling: 1, chamadasDescontos: 1, gravados: 1, falhas: 0,
        parada: b.modo === "5xx" ? "billing_erro_servidor" : resultado === "parada_solicitada" ? "parada_solicitada" : null }));
      await a.agenda.registrar(a.db, { resultado, chamadas: feitas, gravados: 3, parou429, contas, erro: null, inicioMs: a.agoraMs, fimMs: a.agora() });
      return { executado: true, resultado, chamadas: feitas, parou429, contas };
    } finally { store.lock = false; }
  };
  return b;
}

function criarLogger() {
  const l = { logs: [], warns: [], errors: [] };
  l.log = (m) => l.logs.push(String(m));
  l.warn = (m) => l.warns.push(String(m));
  l.error = (m) => l.errors.push(String(m));
  l.op = () => [...l.logs, ...l.warns].filter((m) => m.startsWith("[sentinel-op] {")).map((m) => JSON.parse(m.slice("[sentinel-op] ".length)));
  return l;
}

const ENV_AMBOS = { SENTINEL_WORKER_ENABLED: "true", SENTINEL_CONTAS_ALLOWLIST: "3,41,86", SENTINEL_CONCILIACAO_AGENDADA_ENABLED: "true", SENTINEL_CONCILIACAO_CONTAS: "41,86" };

async function subir({ env = ENV_AMBOS, relogio, store, polling, billing, logger = criarLogger(), instancia = "inst-A", dbP, dbB } = {}) {
  const dbPolling = dbP || criarDbFalso(store, { nome: "polling" });
  const dbBilling = dbB || criarDbFalso(store, { nome: "billing" });
  const w = await W.iniciar({
    env, logger, agora: relogio.agora, timers: relogio.timers,
    criarPool: () => dbPolling, criarPoolBilling: () => dbBilling,
    executar: polling ? polling.executar : async () => ({ contas: [] }),
    executarBilling: billing ? billing.executar : undefined,
    identidade: { instancia, commit: "abc123def456", pid: 1 },
  });
  return { w, dbPolling, dbBilling, logger };
}
const motivoDe = (store, chave) => JSON.parse(store.controle.get(chave).motivo);

// ────────────────────────────────────────────────────────────────────────────────────────────────────

test("F1 flags: tudo desligado por padrão; Billing exige flag dedicada + allowlist PRÓPRIA; defaults do contrato", async () => {
  const relogio = criarRelogio();
  const naoCriar = () => { throw new Error("não deveria criar pool"); };
  for (const env of [{}, { SENTINEL_CONCILIACAO_ENABLED: "true", SENTINEL_CONCILIACAO_CONTAS: "41" }, // flag do standalone NÃO liga o agendado
    { SENTINEL_CONCILIACAO_AGENDADA_ENABLED: "true" }, // sem allowlist própria
    { SENTINEL_CONCILIACAO_AGENDADA_ENABLED: "true", SENTINEL_CONTAS_ALLOWLIST: "41" }, // não herda a do polling
    { SENTINEL_CONCILIACAO_AGENDADA_ENABLED: "false", SENTINEL_CONCILIACAO_CONTAS: "41" }]) {
    const r = await W.iniciar({ env, logger: criarLogger(), criarPool: naoCriar, criarPoolBilling: naoCriar, timers: relogio.timers });
    assert.equal(r.iniciado, false, JSON.stringify(env));
  }
  assert.equal(relogio.pendentes(), 0, "nenhum timer criado com tudo OFF");
  const c = A.configAgenda({});
  assert.deepEqual([c.habilitado, c.contas, c.intervaloMs, c.poolMax, c.adiarMaxMs, c.heartbeatMs], [false, [], 6 * HORA, 1, 120000, 180000]);
  assert.equal(A.configAgenda({ SENTINEL_CONCILIACAO_INTERVAL_MS: "1000" }).intervaloMs, 10 * MIN);
  assert.equal(A.configAgenda({ SENTINEL_HEARTBEAT_MS: "1000" }).heartbeatMs, 60000);
  assert.equal(A.configAgenda({ SENTINEL_CONCILIACAO_DB_POOL_MAX: "50" }).poolMax, 5);
  assert.deepEqual(A.configAgenda({ SENTINEL_CONCILIACAO_CONTAS: "41, x,86,41,-1" }).contas, [41, 86]);
  assert.equal(A.configAgenda({ SENTINEL_CONCILIACAO_INTERVAL_MS: String(HORA) }).lockOcupadoRetryMs, 5 * MIN);
});

test("S1 8 h simuladas, polling + Billing: ~160 ciclos de polling sem sobreposição, Billing no boot e a cada 6 h (2 execuções), heartbeat vivo", async () => {
  const relogio = criarRelogio();
  const store = criarStore();
  const polling = criarPollingFalso(relogio);
  const billing = criarBillingFalso(relogio, store);
  billing.polling = polling;
  const { w, dbPolling, dbBilling, logger } = await subir({ relogio, store, polling, billing });
  assert.equal(w.iniciado, true);
  await relogio.avancar(8 * HORA);
  // 8 h / (180 s de intervalo + 10 s de ciclo) ≈ 151,6 ⇒ 152 ciclos
  assert.ok(polling.ciclos >= 150 && polling.ciclos <= 162, `ciclos de polling: ${polling.ciclos}`);
  assert.equal(polling.maxEmCurso, 1, "nunca dois ciclos de polling ao mesmo tempo");
  assert.equal(billing.execucoes, 2, "Billing no boot (agenda vazia) e +6 h");
  assert.ok(billing.inicios[1] - billing.inicios[0] >= 6 * HORA && billing.inicios[1] - billing.inicios[0] < 6 * HORA + 2 * MIN);
  assert.equal(billing.durantePolling, 0, "Billing não começou com um ciclo de polling deste processo em curso");
  // o Billing do boot esperou o primeiro ciclo de polling (~10 s), não mais que o teto
  const opB = logger.op().filter((o) => o.tarefa === "billing");
  assert.equal(opB.length, 2);
  assert.ok(opB[0].adiadoMs >= 10 * S && opB[0].adiadoMs <= 120 * S, `adiado ${opB[0].adiadoMs}`);
  // intervalos do polling inalterados pelo Billing: o gap entre inícios é sempre 190 s (180 + 10 de ciclo)
  const gaps = polling.inicios.slice(1).map((t, i) => t - polling.inicios[i]);
  assert.ok(gaps.every((g) => g === 190 * S), `gaps do polling: ${[...new Set(gaps)]}`);
  // agenda: próxima = fim + 6 h; 0 execuções com falha
  const ag = store.controle.get("billing_agenda");
  assert.equal(ag.ocorrencias, 0);
  assert.equal(new Date(ag.pausado_ate).getTime() > relogio.agora(), true);
  const mAg = motivoDe(store, "billing_agenda");
  assert.equal(mAg.v, 1);
  assert.match(mAg.execucaoId, /^b-\d+-[0-9a-f]{4}$/);
  assert.deepEqual([mAg.resultado, mAg.instancia, mAg.intervaloMs], ["concluida", "inst-A", 6 * HORA]);
  assert.ok(store.controle.get("billing_agenda").motivo.length <= 4000);
  // heartbeat
  const hb = motivoDe(store, "worker_processo");
  assert.equal(hb.instancia, "inst-A");
  assert.equal(hb.commit, "abc123def456");
  assert.equal(hb.polling.habilitado, true);
  assert.deepEqual(hb.polling.contas, [3, 41, 86]);
  assert.equal(hb.polling.ultimoCicloEstado, "concluido");
  assert.equal(hb.polling.falhasSeguidas, 0);
  assert.deepEqual([hb.billing.habilitado, hb.billing.contas, hb.billing.emExecucao], [true, [41, 86], false]);
  assert.ok(Date.parse(hb.heartbeatEm) >= relogio.agora() - 4 * MIN, "heartbeat recente");
  assert.equal(store.controle.get("worker_processo").ocorrencias, 1);
  // log estruturado: uma linha por ciclo/execução, sem dados sensíveis
  const opP = logger.op().filter((o) => o.tarefa === "polling");
  assert.equal(opP.length, polling.ciclos);
  assert.deepEqual(Object.keys(opP[0]), ["tarefa", "execucao", "inicio", "duracaoMs", "chamadas", "pedidos", "gravados", "resultado", "erro", "contas"]);
  assert.deepEqual([opP[0].chamadas, opP[0].pedidos, opP[0].gravados, opP[0].duracaoMs], [9, 15, 6, 10 * S]);
  assert.equal(logger.warns.filter((m) => m.startsWith("[sentinel-op]")).length, 0, "tudo limpo ⇒ nenhum warn");
  // SIGTERM: tudo para, pools fechados, heartbeat limpo, nenhum timer órfão
  await Promise.all([w.parar("SIGTERM"), relogio.avancar(30 * S)]);
  await w.fim;
  assert.equal(relogio.pendentes(), 0, "nenhum timer pendente depois de parar()");
  assert.deepEqual([dbPolling.encerrado, dbBilling.encerrado], [true, true]);
  const fimHb = motivoDe(store, "worker_processo");
  assert.equal(fimHb.encerramento, "limpo");
  assert.ok(fimHb.encerradoEm);
});

test("S2 polling ativo + Billing OFF: comportamento do polling idêntico, nenhum pool de Billing, heartbeat pelo pool do polling", async () => {
  const relogio = criarRelogio();
  const store = criarStore();
  const polling = criarPollingFalso(relogio);
  let poolsBilling = 0;
  const logger = criarLogger();
  const dbP = criarDbFalso(store, { nome: "polling" });
  const w = await W.iniciar({
    env: { SENTINEL_WORKER_ENABLED: "true", SENTINEL_CONTAS_ALLOWLIST: "41" }, logger, agora: relogio.agora, timers: relogio.timers,
    criarPool: () => dbP, criarPoolBilling: () => { poolsBilling += 1; }, executar: polling.executar, identidade: { instancia: "i1", commit: null, pid: 1 },
  });
  await relogio.avancar(1 * HORA);
  assert.equal(poolsBilling, 0);
  assert.equal(w.agendador, null);
  assert.ok(polling.ciclos >= 18 && polling.ciclos <= 20, `ciclos ${polling.ciclos}`);
  assert.equal(store.controle.has("billing_agenda"), false, "Billing nunca agendado");
  const hb = motivoDe(store, "worker_processo");
  assert.deepEqual([hb.billing.habilitado, hb.polling.habilitado], [false, true]);
  assert.ok(logger.logs.some((m) => /\[sentinel-worker\] ON — contas 41/.test(m)), "log de boot atual mantido");
  await Promise.all([w.parar("SIGTERM"), relogio.avancar(20 * S)]);
  assert.equal(relogio.pendentes(), 0);
  assert.equal(dbP.encerrado, true);
});

test("S3 polling com erro em conta: [sentinel-op] vai como WARN com código curto; falhasSeguidas conta ciclos seguidos e zera no ciclo limpo", async () => {
  const relogio = criarRelogio();
  const store = criarStore();
  const polling = criarPollingFalso(relogio);
  const { w, logger } = await subir({ env: { SENTINEL_WORKER_ENABLED: "true", SENTINEL_CONTAS_ALLOWLIST: "41,86" }, relogio, store, polling });
  polling.erroConta = { conta: 86, texto: "SENTINEL_ORDERS_HTTP_ERROR: Orders API respondeu HTTP 403. https://api.mercadolibre.com/orders?access_token=APP_USR-123" };
  await relogio.avancar(190 * S * 3 - S);
  let hb = motivoDe(store, "worker_processo");
  assert.equal(hb.polling.falhasSeguidas, 3);
  assert.equal(hb.polling.ultimoCicloErro, "conta 86: SENTINEL_ORDERS_HTTP_ERROR:403");
  const warns = logger.warns.filter((m) => m.startsWith("[sentinel-op]"));
  assert.equal(warns.length, 3);
  const o = JSON.parse(warns[0].slice(14));
  assert.deepEqual(o.contas.find((c) => c.id === 86).erro, "SENTINEL_ORDERS_HTTP_ERROR:403");
  assert.equal(o.contas.find((c) => c.id === 41).erro, null);
  assert.doesNotMatch(warns.join("\n"), /APP_USR|access_token|https?:/, "sem token nem URL na linha");
  polling.erroConta = { conta: 86, texto: "SENTINEL_TRUNCATED: janela mínima 2026-11-19T00:00 → ... não coube" };
  await relogio.avancar(190 * S);
  assert.equal(JSON.parse(logger.warns.at(-1).slice(14)).contas.find((c) => c.id === 86).erro, "SENTINEL_TRUNCATED");
  polling.erroConta = null;
  await relogio.avancar(190 * S);
  hb = motivoDe(store, "worker_processo");
  assert.deepEqual([hb.polling.falhasSeguidas, hb.polling.ultimoCicloErro, hb.polling.ultimoCicloEstado], [0, null, "concluido"]);
  assert.ok(logger.logs.at(-1).startsWith("[sentinel-op]") || logger.logs.some((m) => m.startsWith("[sentinel-op]")), "ciclo limpo ⇒ console.log");
  await Promise.all([w.parar("SIGTERM"), relogio.avancar(20 * S)]);
});

test("S4 Billing falha (exceção / 5xx por conta / 429) e o polling segue no mesmo ritmo; exceção não vira laço (retry em 10 min)", async () => {
  const relogio = criarRelogio();
  const store = criarStore();
  const polling = criarPollingFalso(relogio);
  const billing = criarBillingFalso(relogio, store);
  billing.modo = "excecao";
  const { w, logger } = await subir({ relogio, store, polling, billing });
  await relogio.avancar(1 * HORA);
  const opB = logger.op().filter((o) => o.tarefa === "billing");
  assert.ok(opB.length >= 5 && opB.length <= 7, `exceção: tentativas a cada 10 min (${opB.length})`);
  assert.ok(opB.every((o) => o.resultado === "erro" && o.erro === "XYZ"));
  assert.ok(logger.warns.some((m) => m.startsWith("[sentinel-op]") && /"tarefa":"billing"/.test(m)), "falha do Billing vai como warn");
  assert.ok(polling.ciclos >= 18, `polling seguiu: ${polling.ciclos}`);
  // 5xx: execução concluída com parada por conta (warn), agenda empurrada (+6 h)
  billing.modo = "5xx";
  await relogio.avancar(11 * MIN);
  assert.equal(billing.execucoes, 1);
  const o5 = logger.op().filter((o) => o.tarefa === "billing").at(-1);
  assert.equal(o5.contas[0].parada, "billing_erro_servidor");
  assert.ok(logger.warns.at(-1).includes("billing_erro_servidor") || logger.warns.some((m) => m.includes("billing_erro_servidor")));
  // 429: agenda = max(fim da pausa, fim + intervalo); ocorrencias++ ; o polling não é afetado
  store.controle.get("billing_agenda").pausado_ate = new Date(relogio.agora()).toISOString(); // força devida
  billing.modo = "429";
  const ciclosAntes = polling.ciclos;
  await relogio.avancar(31 * MIN);
  const ag = store.controle.get("billing_agenda");
  assert.equal(motivoDe(store, "billing_agenda").resultado, "pausa_429");
  assert.equal(ag.ocorrencias, 1);
  assert.ok(new Date(ag.pausado_ate).getTime() >= relogio.agora() + 5 * HORA, "429 não encurta o intervalo");
  assert.ok(polling.ciclos - ciclosAntes >= 9, "polling seguiu durante o 429");
  await Promise.all([w.parar("SIGTERM"), relogio.avancar(20 * S)]);
  assert.equal(relogio.pendentes(), 0);
});

test("S5 polling falha (exceção) e o Billing segue; heartbeat mostra erro e falhasSeguidas", async () => {
  const relogio = criarRelogio();
  const store = criarStore();
  const polling = criarPollingFalso(relogio);
  polling.falhar = Object.assign(new Error("Orders API caiu"), { code: "SENTINEL_ORDERS_HTTP_ERROR" });
  const billing = criarBillingFalso(relogio, store);
  const { w, logger } = await subir({ relogio, store, polling, billing });
  await relogio.avancar(7 * HORA);
  assert.equal(billing.execucoes, 2);
  const hb = motivoDe(store, "worker_processo");
  assert.equal(hb.polling.ultimoCicloEstado, "erro");
  assert.ok(hb.polling.falhasSeguidas > 100);
  assert.ok(logger.errors.some((m) => /ciclo falhou: Orders API caiu/.test(m)), "log atual do worker mantido");
  await Promise.all([w.parar("SIGTERM"), relogio.avancar(20 * S)]);
});

test("S6 boot do polling falha (schema): com Billing ⇒ Billing roda e heartbeat registra polling.falhaBoot; sem Billing ⇒ lança como antes", async () => {
  const relogio = criarRelogio();
  const store = criarStore();
  const billing = criarBillingFalso(relogio, store);
  const dbP = criarDbFalso(store, { nome: "polling" });
  const orig = dbP.query;
  dbP.query = async (sql, p) => (/unnest/.test(sql) ? { rows: p[0].map((t) => ({ nome: t, existe: false })) } : orig(sql, p));
  const logger = criarLogger();
  const polling = criarPollingFalso(relogio);
  const w = await W.iniciar({
    env: ENV_AMBOS, logger, agora: relogio.agora, timers: relogio.timers, criarPool: () => dbP, executar: polling.executar,
    criarPoolBilling: () => criarDbFalso(store, { nome: "billing" }), executarBilling: billing.executar, identidade: { instancia: "x", commit: null, pid: 1 },
  });
  assert.equal(w.iniciado, true);
  assert.equal(dbP.encerrado, true, "pool do polling fechado na falha de boot");
  await relogio.avancar(1 * MIN);
  assert.equal(billing.execucoes, 1);
  const hb = motivoDe(store, "worker_processo");
  assert.equal(hb.polling.habilitado, true, "configurado");
  assert.match(hb.polling.falhaBoot, /^SENTINEL_SCHEMA_AUSENTE: /);
  assert.equal(hb.polling.ultimoCicloEm, null, "polling não rodou");
  // retentativa do boot a cada 5 min: schema aparece ⇒ polling começa sem reiniciar o processo
  dbP.encerrado = false;
  dbP.query = orig;
  await relogio.avancar(5 * MIN);
  const hb2 = motivoDe(store, "worker_processo");
  assert.equal(hb2.polling.falhaBoot, null);
  assert.ok(hb2.polling.ultimoCicloEm, "polling rodou depois da retentativa");
  assert.equal(billing.execucoes, 1, "Billing não foi afetado");
  await Promise.all([w.parar("SIGTERM"), relogio.avancar(5 * S)]);
  assert.equal(relogio.pendentes(), 0);
  // sem Billing: o boot lança (main: exit 1 fora do Render)
  const dbP2 = criarDbFalso(store, { nome: "p2" });
  const orig2 = dbP2.query;
  dbP2.query = async (sql, p) => (/unnest/.test(sql) ? { rows: p[0].map((t) => ({ nome: t, existe: false })) } : orig2(sql, p));
  await assert.rejects(W.iniciar({ env: { SENTINEL_WORKER_ENABLED: "true", SENTINEL_CONTAS_ALLOWLIST: "41" }, logger, criarPool: () => dbP2, timers: relogio.timers }),
    (e) => e.code === "SENTINEL_SCHEMA_AUSENTE");
});

test("S7 modo só Billing (polling OFF): processo vive, heartbeat periódico, Billing não roda a cada boot (agenda persistida)", async () => {
  const relogio = criarRelogio();
  const store = criarStore();
  const billing = criarBillingFalso(relogio, store);
  const env = { SENTINEL_CONCILIACAO_AGENDADA_ENABLED: "true", SENTINEL_CONCILIACAO_CONTAS: "41" };
  const a = await subir({ env, relogio, store, billing, instancia: "boot-1" });
  await relogio.avancar(20 * MIN);
  assert.equal(billing.execucoes, 1);
  const hb1 = store.controle.get("worker_processo").atualizado_em;
  await relogio.avancar(10 * MIN);
  assert.ok(Date.parse(store.controle.get("worker_processo").atualizado_em) > Date.parse(hb1), "heartbeat periódico sem polling");
  await Promise.all([a.w.parar("SIGTERM"), relogio.avancar(5 * S)]);
  // reinício (deploy) 1 h depois: a agenda diz +6 h ⇒ NÃO roda no boot
  await relogio.avancar(1 * HORA);
  const b = await subir({ env, relogio, store, billing, instancia: "boot-2" });
  await relogio.avancar(2 * HORA);
  assert.equal(billing.execucoes, 1, "reinício não dispara Billing antes de devido");
  const hb = motivoDe(store, "worker_processo");
  assert.deepEqual(hb.anterior, { instancia: "boot-1", commit: "abc123def456", heartbeatEm: hb.anterior.heartbeatEm, encerramento: "limpo" });
  assert.equal(store.controle.get("worker_processo").ocorrencias, 2);
  await relogio.avancar(4 * HORA);
  assert.equal(billing.execucoes, 2, "roda quando a agenda vence (≈ 6 h após a 1ª)");
  await Promise.all([b.w.parar("SIGTERM"), relogio.avancar(5 * S)]);
  assert.equal(relogio.pendentes(), 0);
});

test("S8 duas instâncias (mesmo banco) e dois agendadores ao mesmo tempo ⇒ uma execução por janela; heartbeat: só o dono escreve", async () => {
  const relogio = criarRelogio();
  const store = criarStore();
  const billing = criarBillingFalso(relogio, store); // lock compartilhado no store
  const pA = criarPollingFalso(relogio);
  const pB = criarPollingFalso(relogio);
  const a = await subir({ relogio, store, polling: pA, billing, instancia: "A" });
  const b = await subir({ relogio, store, polling: pB, billing, instancia: "B" });
  await relogio.avancar(13 * HORA);
  assert.equal(billing.execucoes, 3, "boot + 6 h + 12 h — nunca duplicado");
  assert.ok(billing.lockOcupado + billing.naoDevidas >= 1, "a outra instância foi barrada (lock ou agenda relida no lock)");
  // posse do heartbeat: B assumiu por último; A não sobrescreve mais
  assert.equal(motivoDe(store, "worker_processo").instancia, "B");
  assert.equal(motivoDe(store, "worker_processo").anterior.instancia, "A");
  await Promise.all([a.w.parar("SIGTERM"), relogio.avancar(20 * S)]);
  assert.equal(motivoDe(store, "worker_processo").instancia, "B", "encerramento de A não rouba a linha");
  assert.equal(motivoDe(store, "worker_processo").encerramento, null);
  await Promise.all([b.w.parar("SIGTERM"), relogio.avancar(20 * S)]);
  assert.equal(motivoDe(store, "worker_processo").encerramento, "limpo");
});

test("S9 adiamento: ciclo de polling longo (5 min) ⇒ Billing espera no máximo 120 s e executa; Billing longo NUNCA atrasa o polling", async () => {
  const relogio = criarRelogio();
  const store = criarStore();
  const polling = criarPollingFalso(relogio, { duracaoMs: 5 * MIN });
  const billing = criarBillingFalso(relogio, store, { chamadas: 20, msPorChamada: 60 * S }); // 20 min de Billing
  billing.polling = polling;
  const { w, logger } = await subir({ relogio, store, polling, billing });
  await relogio.avancar(30 * MIN);
  const o = logger.op().find((x) => x.tarefa === "billing");
  assert.equal(o.adiadoMs, 120 * S);
  assert.equal(o.adiamentoExcedido, true);
  assert.equal(billing.durantePolling, 1, "passou do teto ⇒ executa mesmo com o polling em curso");
  // polling: gap entre inícios = 5 min + 3 min, mesmo com 20 min de Billing rodando
  const gaps = polling.inicios.slice(1).map((t, i) => t - polling.inicios[i]);
  assert.ok(gaps.length >= 2 && gaps.every((g) => g === 8 * MIN), `gaps ${gaps}`);
  await Promise.all([w.parar("SIGTERM"), relogio.avancar(6 * MIN)]);
});

test("S10 SIGTERM durante o Billing: para ENTRE chamadas, registra parada_solicitada, fecha os dois pools, heartbeat limpo, sem timers", async () => {
  const relogio = criarRelogio();
  const store = criarStore();
  const billing = criarBillingFalso(relogio, store, { chamadas: 50, msPorChamada: 2 * S });
  const env = { SENTINEL_CONCILIACAO_AGENDADA_ENABLED: "true", SENTINEL_CONCILIACAO_CONTAS: "41" };
  const { w, dbBilling } = await subir({ env, relogio, store, billing });
  await relogio.avancar(7 * S); // ~3 chamadas
  assert.equal(motivoDe(store, "worker_processo").billing.emExecucao, false); // heartbeat de boot (antes)
  assert.equal(w.estado.billing.emExecucao, true);
  const antes = relogio.agora();
  await Promise.all([w.parar("SIGTERM"), relogio.avancar(10 * S)]);
  await w.fim;
  assert.ok(billing.chamadasFeitas[0] <= 4, `parou entre chamadas: ${billing.chamadasFeitas[0]}`);
  assert.equal(motivoDe(store, "billing_agenda").resultado, "parada_solicitada");
  assert.equal(motivoDe(store, "worker_processo").encerramento, "limpo");
  assert.equal(dbBilling.encerrado, true);
  assert.equal(relogio.pendentes(), 0);
  assert.ok(relogio.agora() - antes <= 10 * S);
});

test("S11 PG indisponível: heartbeat/agenda falham sem derrubar polling; warn com rate-limit; volta sozinho", async () => {
  const relogio = criarRelogio();
  const store = criarStore();
  const polling = criarPollingFalso(relogio);
  const dbP = criarDbFalso(store, { nome: "polling" });
  const logger = criarLogger();
  const w = await W.iniciar({
    env: { SENTINEL_WORKER_ENABLED: "true", SENTINEL_CONTAS_ALLOWLIST: "41" }, logger, agora: relogio.agora, timers: relogio.timers,
    criarPool: () => dbP, executar: polling.executar, identidade: { instancia: "pg", commit: null, pid: 1 },
    depsPolling: {},
  });
  // banco cai DEPOIS do boot: o polling (falso, não usa o banco) segue; heartbeat falha
  await relogio.avancar(1 * S);
  dbP.falhar = true;
  const ciclos = polling.ciclos;
  await relogio.avancar(1 * HORA);
  // selecionarContas usa o banco ⇒ o tick falha (log atual) mas o timer continua
  assert.ok(logger.errors.filter((m) => /ciclo falhou/.test(m)).length >= 15, "ticks continuam com o banco fora");
  const avisosHb = logger.warns.filter((m) => /heartbeat não gravado/.test(m));
  assert.ok(avisosHb.length >= 1 && avisosHb.length <= 7, `rate-limit do aviso (${avisosHb.length} em 1 h)`);
  dbP.falhar = false;
  await relogio.avancar(10 * MIN);
  assert.ok(polling.ciclos > ciclos, "polling voltou");
  assert.equal(motivoDe(store, "worker_processo").polling.ultimoCicloEstado, "concluido", "heartbeat voltou");
  await Promise.all([w.parar("SIGTERM"), relogio.avancar(20 * S)]);
  // banco fora DESDE o boot: a 1ª escrita que der certo assume a linha
  const store2 = criarStore();
  const db2 = criarDbFalso(store2, { nome: "p2" });
  const p2 = criarPollingFalso(relogio);
  const w2Prom = W.iniciar({ env: { SENTINEL_WORKER_ENABLED: "true", SENTINEL_CONTAS_ALLOWLIST: "41" }, logger, agora: relogio.agora, timers: relogio.timers,
    criarPool: () => db2, executar: p2.executar, identidade: { instancia: "late", commit: null, pid: 1 } });
  const w2 = await w2Prom;
  db2.falhar = true;
  await relogio.avancar(10 * MIN);
  db2.falhar = false;
  await relogio.avancar(10 * MIN);
  assert.equal(motivoDe(store2, "worker_processo").instancia, "late");
  await Promise.all([w2.parar("SIGTERM"), relogio.avancar(20 * S)]);
});

test("S12 sem a migration 20261119: heartbeat e agenda não gravam nada e nada lança", async () => {
  const relogio = criarRelogio();
  const store = criarStore();
  store.schemaConciliacao = false;
  const polling = criarPollingFalso(relogio);
  const billing = { execucoes: 0, executar: async () => { billing.execucoes += 1; return { executado: false, motivo: "schema_ausente", contas: [] }; } };
  const { w, logger } = await subir({ relogio, store, polling, billing });
  await relogio.avancar(2 * HORA);
  assert.equal(store.controle.size, 0, "nenhuma linha gravada");
  assert.equal(billing.execucoes, 0, "sem a tabela da agenda, o agendador nem chama o coletor (que suspenderia sem ML)");
  assert.ok(polling.ciclos >= 35);
  assert.equal(logger.warns.filter((m) => /heartbeat não gravado/.test(m)).length, 0, "ausência do schema não é erro");
  // migration aplicada com o worker no ar: Billing começa em ≤ 30 min e o heartbeat aparece em ≤ 10 min
  store.schemaConciliacao = true;
  await relogio.avancar(31 * MIN);
  assert.equal(billing.execucoes, 1);
  assert.equal(motivoDe(store, "worker_processo").instancia, "inst-A");
  await Promise.all([w.parar("SIGTERM"), relogio.avancar(20 * S)]);
});

test("M1 main(): no Render com tudo OFF fica OCIOSO até SIGTERM; fora do Render resolve; boot falho no Render também fica ocioso; listeners removidos", async () => {
  const logger = criarLogger();
  const timers = { setInterval: () => ({ id: 1 }), clearInterval: () => { timers.limpos += 1; }, limpos: 0 };
  // fora do Render: resolve imediatamente (exit 0 como sempre)
  const fora = await W.main({ env: {}, processo: new EventEmitter(), logger, timers });
  assert.equal(fora.iniciado, false);
  // no Render: não resolve até o SIGTERM
  const proc = new EventEmitter();
  let resolvido = false;
  const p = W.main({ env: { RENDER: "true" }, processo: proc, logger, timers }).then((r) => { resolvido = true; return r; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(resolvido, false, "ocioso no Render");
  assert.equal(proc.listenerCount("SIGTERM"), 1);
  assert.ok(logger.logs.some((m) => /OCIOSO \(motivo=flag_off\)/.test(m)));
  proc.emit("SIGTERM");
  const r = await p;
  assert.equal(r.ocioso, true);
  assert.equal(timers.limpos, 1, "timer do log horário limpo");
  assert.deepEqual([proc.listenerCount("SIGTERM"), proc.listenerCount("SIGINT")], [0, 0]);
  // boot que lança: fora do Render rejeita (exit 1); no Render fica ocioso
  const lancar = async () => { throw Object.assign(new Error("schema"), { code: "SENTINEL_SCHEMA_AUSENTE" }); };
  await assert.rejects(W.main({ env: {}, iniciarFn: lancar, processo: new EventEmitter(), logger, timers }), /schema/);
  const proc2 = new EventEmitter();
  const p2 = W.main({ env: { RENDER: "true" }, iniciarFn: lancar, processo: proc2, logger, timers });
  await new Promise((r2) => setTimeout(r2, 20));
  proc2.emit("SIGINT");
  assert.equal((await p2).motivo, "falha_boot");
  // ligado: um único handler para os dois agendamentos
  const proc3 = new EventEmitter();
  let parou = 0;
  let resolverFim;
  const falso = { iniciado: true, fim: new Promise((x) => { resolverFim = x; }), parar: async () => { parou += 1; resolverFim(); } };
  const p3 = W.main({ env: {}, iniciarFn: async () => falso, processo: proc3, logger });
  await new Promise((r3) => setTimeout(r3, 10));
  assert.equal(proc3.listenerCount("SIGTERM"), 1);
  proc3.emit("SIGTERM");
  await p3;
  assert.equal(parou, 1);
});

test("L1 sanitização e limites: códigos curtos, sem URL/token/e-mail, JSON ≤ 4000", () => {
  assert.equal(A.codigoErro("SENTINEL_TRUNCATED: janela mínima x"), "SENTINEL_TRUNCATED");
  assert.equal(A.codigoErro("SENTINEL_ORDERS_HTTP_ERROR: Orders API respondeu HTTP 403."), "SENTINEL_ORDERS_HTTP_ERROR:403");
  assert.equal(A.codigoErro("falhou algo"), "ERRO");
  const s = A.sanitizar("erro em https://api.x.com/a?access_token=APP_USR-99 Bearer abc.def para fulano@x.com");
  assert.doesNotMatch(s, /https|APP_USR|abc\.def|fulano/);
  const grande = { v: 1, contas: Array.from({ length: 300 }, (_, i) => ({ contaId: i, parada: "x".repeat(30) })), erro: "y".repeat(5000) };
  assert.ok(A.serializarLimitado(grande).length <= 4000);
  assert.match(A.novoExecucaoId(123), /^b-123-[0-9a-f]{4}$/);
});

test("L2 sem timers/recursos órfãos do processo real (getActiveResourcesInfo) com timers reais", async () => {
  const antes = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
  const store = criarStore();
  const relogioReal = { agora: Date.now };
  const billing = criarBillingFalso({ agora: Date.now, dormir: (ms) => new Promise((r) => setTimeout(r, ms)) }, store, { chamadas: 3, msPorChamada: 5 });
  const polling = criarPollingFalso({ agora: Date.now, dormir: (ms) => new Promise((r) => setTimeout(r, ms)) }, { duracaoMs: 5 });
  const w = await W.iniciar({
    env: { ...ENV_AMBOS, SENTINEL_POLL_INTERVAL_MS: "20" }, logger: criarLogger(), agora: relogioReal.agora,
    criarPool: () => criarDbFalso(store), criarPoolBilling: () => criarDbFalso(store), executar: polling.executar, executarBilling: billing.executar,
    identidade: { instancia: "real", commit: null, pid: 1 },
  });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(polling.ciclos >= 3 && billing.execucoes === 1);
  await w.parar("SIGTERM");
  await new Promise((r) => setImmediate(r));
  const depois = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
  assert.ok(depois <= antes, `timers ativos: antes=${antes} depois=${depois}`);
});

test("M2 main() no Render: boot que FALHA (banco fora no deploy) é retentado sozinho; sobe na 3ª tentativa; SIGTERM limpo", async () => {
  const logger = criarLogger();
  let tentativas = 0;
  let parou = 0;
  let resolverFim;
  const ligado = { iniciado: true, fim: new Promise((x) => { resolverFim = x; }), parar: async () => { parou += 1; resolverFim(); } };
  const iniciarFn = async () => {
    tentativas += 1;
    if (tentativas < 3) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    return ligado;
  };
  const proc = new EventEmitter();
  const p = W.main({ env: { RENDER: "true" }, iniciarFn, processo: proc, logger, bootRetryMs: 15 });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(tentativas, 3, "retentou até subir");
  assert.ok(logger.logs.some((m) => /OCIOSO \(motivo=falha_boot\)/.test(m)));
  proc.emit("SIGTERM");
  const r = await p;
  assert.equal(r, ligado);
  assert.equal(parou, 1);
  assert.deepEqual([proc.listenerCount("SIGTERM"), proc.listenerCount("SIGINT")], [0, 0]);
  // fora do Render a falha de boot continua rejeitando (exit 1, como sempre)
  await assert.rejects(W.main({ env: {}, iniciarFn: async () => { throw new Error("x"); }, processo: new EventEmitter(), logger }), /x/);
});
