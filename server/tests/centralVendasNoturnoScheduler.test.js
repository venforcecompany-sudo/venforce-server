// server/tests/centralVendasNoturnoScheduler.test.js
//
// Scheduler interno da sincronização noturna (centralVendasNoturnoScheduler):
// opt-in, próximo disparo às 03:00 America/Sao_Paulo (independente do TZ do
// processo), boot depois das 03:00 → amanhã, nunca roda no boot, duas
// tentativas não iniciam duas rodadas (neste processo e entre instâncias via
// advisory lock), erro da rodada não derruba o processo e reagenda, parar()
// limpa o timer, integração no index.js.
//
// Timers, relógio, pool e rodada são falsos/injetados. NENHUM banco real:
// DATABASE_URL aponta para porta morta antes de qualquer require.

process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/teste-sem-banco";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const sched = require("../services/centralVendas/centralVendasNoturnoScheduler");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `FALHOU: ${label} — recebido ${JSON.stringify(actual)}`);
  checks += 1;
}

let unhandled = 0;
process.on("unhandledRejection", () => { unhandled += 1; });

// Uma promise pendurada esvazia o event loop e o Node sai com 0 sem terminar
// o teste — aqui isso vira falha.
let concluido = false;
process.on("exit", () => {
  if (!concluido) {
    console.error(`centralVendasNoturnoScheduler.test.js: NÃO concluiu (parou após ${checks} verificações)`);
    process.exitCode = 1;
  }
});

const iso = (ms) => new Date(ms).toISOString();
const T = (s) => Date.parse(s);
const H03 = { hora: 3, minuto: 0 };

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutFn(fn, ms) {
      const t = { fn, ms, unrefd: false, cleared: false, fired: false, unref() { this.unrefd = true; } };
      timers.push(t);
      return t;
    },
    clearTimeoutFn(t) { t.cleared = true; },
    ativos() { return timers.filter((t) => !t.cleared && !t.fired); },
  };
}

function makeScheduler({ env = { CENTRAL_VENDAS_NOTURNO_ENABLED: "true" }, agoraInicial, rodada, recuperacao, lock, esperar } = {}) {
  let agora = T(agoraInicial || "2026-09-24T05:00:00Z"); // 02:00 em SP
  const timers = fakeTimers();
  const logs = [];
  const chamadas = { rodada: [], recuperacao: [], lock: 0, liberar: 0 };
  const logger = {
    log: (...a) => logs.push(`LOG ${a.join(" ")}`),
    warn: (...a) => logs.push(`WARN ${a.join(" ")}`),
    error: (...a) => logs.push(`ERROR ${a.join(" ")}`),
  };
  const s = sched.createScheduler({
    env,
    agora: () => agora,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    getPool: () => ({ fake: true }),
    executarRodadaNoturna: async (opts) => {
      chamadas.rodada.push(opts);
      return rodada ? rodada(opts) : { elegiveis: 2, sucesso: 2, parcial: 0, falha: 0, ignorados: 0 };
    },
    recuperarRodadasPendentes: async (opts) => {
      chamadas.recuperacao.push(opts);
      return recuperacao ? recuperacao(opts) : { recuperada: false, motivo: "SEM_PENDENCIAS" };
    },
    adquirirLockGlobal: async () => {
      chamadas.lock += 1;
      if (lock) return lock();
      return { adquirido: true, liberar: async () => { chamadas.liberar += 1; } };
    },
    ...(esperar ? { esperar } : {}),
    logger,
  });
  return {
    s, timers, logs, chamadas,
    setAgora: (v) => { agora = typeof v === "number" ? v : T(v); },
    getAgora: () => agora,
    // Dispara o timer ativo: relógio vai para o alvo e o callback é aguardado.
    async disparar(atrasoMs = 0) {
      const t = timers.ativos()[0];
      assert.ok(t, "nenhum timer ativo para disparar");
      agora += t.ms + atrasoMs;
      t.fired = true;
      await t.fn();
    },
  };
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

async function run() {
  // =========================================================================
  // 1. Configuração
  // =========================================================================
  eq("habilitado: ausente → desligado (opt-in)", sched.habilitado({}), false);
  eq("habilitado: 'true' → ligado", sched.habilitado({ CENTRAL_VENDAS_NOTURNO_ENABLED: "true" }), true);
  eq("habilitado: ' TRUE ' → ligado", sched.habilitado({ CENTRAL_VENDAS_NOTURNO_ENABLED: " TRUE " }), true);
  for (const v of ["false", "0", "1", "yes", ""]) {
    eq(`habilitado: '${v}' → desligado`, sched.habilitado({ CENTRAL_VENDAS_NOTURNO_ENABLED: v }), false);
  }
  eq("hora: 03:00", sched.parseHora("03:00"), { hora: 3, minuto: 0 });
  eq("hora: 3:05", sched.parseHora("3:05"), { hora: 3, minuto: 5 });
  eq("hora: 23:59", sched.parseHora("23:59"), { hora: 23, minuto: 59 });
  for (const v of ["24:00", "03:60", "3h", "", null, "03:0", "abc"]) {
    eq(`hora: ${JSON.stringify(v)} inválida`, sched.parseHora(v), null);
  }

  // =========================================================================
  // 2. Próximo disparo — 03:00 America/Sao_Paulo = 06:00 UTC
  // =========================================================================
  eq("próximo: 02:59 SP → hoje 03:00 SP", iso(sched.calcularProximoDisparo(T("2026-09-24T05:59:00Z"), H03)), "2026-09-24T06:00:00.000Z");
  eq("próximo: exatamente 03:00 SP → amanhã (nunca imediato)", iso(sched.calcularProximoDisparo(T("2026-09-24T06:00:00Z"), H03)), "2026-09-25T06:00:00.000Z");
  eq("próximo: 03:00:00.001 SP → amanhã", iso(sched.calcularProximoDisparo(T("2026-09-24T06:00:00.001Z"), H03)), "2026-09-25T06:00:00.000Z");
  eq("próximo: boot às 09:00 SP → amanhã", iso(sched.calcularProximoDisparo(T("2026-09-24T12:00:00Z"), H03)), "2026-09-25T06:00:00.000Z");
  eq("próximo: 22:00 SP de 31/12 → 01/01", iso(sched.calcularProximoDisparo(T("2027-01-01T01:00:00Z"), H03)), "2027-01-01T06:00:00.000Z");
  eq("próximo: fim de mês (30/09 10:00 SP → 01/10)", iso(sched.calcularProximoDisparo(T("2026-09-30T13:00:00Z"), H03)), "2026-10-01T06:00:00.000Z");
  eq("próximo: 29/02 em ano bissexto", iso(sched.calcularProximoDisparo(T("2028-02-28T12:00:00Z"), H03)), "2028-02-29T06:00:00.000Z");
  eq("próximo: hora 23:30 SP → 02:30 UTC do dia seguinte", iso(sched.calcularProximoDisparo(T("2026-09-24T12:00:00Z"), { hora: 23, minuto: 30 })), "2026-09-25T02:30:00.000Z");
  eq("próximo: hora 00:00 às 23:59 SP → 1 minuto depois", iso(sched.calcularProximoDisparo(T("2026-09-24T02:59:00Z"), { hora: 0, minuto: 0 })), "2026-09-24T03:00:00.000Z");
  {
    // Um ano inteiro, um disparo por dia: sempre 06:00 UTC e sempre < 24h+ε à frente.
    let agora = T("2026-01-01T12:00:00Z");
    let sempre06 = true;
    let dias = 0;
    for (let i = 0; i < 366; i++) {
      const prox = sched.calcularProximoDisparo(agora, H03);
      if (new Date(prox).getUTCHours() !== 6 || new Date(prox).getUTCMinutes() !== 0 || prox - agora > 24 * 3600 * 1000) sempre06 = false;
      agora = prox;
      dias += 1;
    }
    ok("próximo: 366 disparos seguidos, todos às 03:00 SP (06:00 UTC)", sempre06 && dias === 366);
  }
  {
    // Independe do TZ do processo (o container do Render é UTC; aqui força outro).
    const tzOriginal = process.env.TZ;
    const esperado = sched.calcularProximoDisparo(T("2026-09-24T05:00:00Z"), H03);
    for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles"]) {
      process.env.TZ = tz;
      eq(`próximo: igual com TZ=${tz} no processo`, sched.calcularProximoDisparo(T("2026-09-24T05:00:00Z"), H03), esperado);
    }
    if (tzOriginal === undefined) delete process.env.TZ; else process.env.TZ = tzOriginal;
  }
  // A conta é genérica: dia de horário de verão em outro fuso.
  eq("DST: 03:00 NY no dia que entra EDT → 07:00 UTC", iso(sched.calcularProximoDisparo(T("2026-03-07T12:00:00Z"), H03, "America/New_York")), "2026-03-08T07:00:00.000Z");
  eq("DST: 03:00 NY na véspera (EST) → 08:00 UTC", iso(sched.calcularProximoDisparo(T("2026-03-06T12:00:00Z"), H03, "America/New_York")), "2026-03-07T08:00:00.000Z");
  eq("DST: 03:00 NY no dia que volta EST → 08:00 UTC", iso(sched.calcularProximoDisparo(T("2026-10-31T12:00:00Z"), H03, "America/New_York")), "2026-11-01T08:00:00.000Z");
  eq("formatação no fuso", sched.formatarNoFuso(T("2026-09-24T06:00:00Z")), "2026-09-24 03:00 America/Sao_Paulo");

  // =========================================================================
  // 3. Desabilitado
  // =========================================================================
  for (const env of [{}, { CENTRAL_VENDAS_NOTURNO_ENABLED: "false" }]) {
    const h = makeScheduler({ env });
    eq(`desabilitado ${JSON.stringify(env)}: iniciar → false`, h.s.iniciar(), false);
    eq(`desabilitado ${JSON.stringify(env)}: nenhum timer`, h.timers.timers.length, 0);
    ok(`desabilitado ${JSON.stringify(env)}: log`, h.logs.some((l) => l.includes("[sync-scheduler] desabilitado")));
    eq(`desabilitado ${JSON.stringify(env)}: nenhuma rodada/lock`, [h.chamadas.rodada.length, h.chamadas.lock], [0, 0]);
  }

  // =========================================================================
  // 4. Boot: agenda, não roda
  // =========================================================================
  {
    const h = makeScheduler({ agoraInicial: "2026-09-24T05:00:00Z" }); // 02:00 SP
    eq("boot: iniciar → true", h.s.iniciar(), true);
    eq("boot: um timer", h.timers.ativos().length, 1);
    eq("boot 02:00 SP: dispara em 1h", h.timers.ativos()[0].ms, 3600 * 1000);
    ok("boot: timer com unref (não segura o processo)", h.timers.ativos()[0].unrefd);
    ok("boot: log do próximo sync no fuso", h.logs.some((l) => l.includes("[sync-scheduler] próximo sync: 2026-09-24 03:00 America/Sao_Paulo (2026-09-24T06:00:00.000Z)")));
    await flush();
    eq("boot: NÃO roda imediatamente", [h.chamadas.rodada.length, h.chamadas.lock], [0, 0]);
    eq("boot: iniciar de novo não cria segundo timer", [h.s.iniciar(), h.timers.ativos().length], [true, 1]);
    eq("estado exposto", h.s.estado(), { iniciado: true, emExecucao: false, proximoEm: T("2026-09-24T06:00:00Z"), temTimer: true });
  }
  {
    const h = makeScheduler({ agoraInicial: "2026-09-24T13:30:00Z" }); // 10:30 SP (deploy de manhã)
    h.s.iniciar();
    eq("boot depois das 03:00: agenda para amanhã 03:00 (16h30)", h.timers.ativos()[0].ms, 16.5 * 3600 * 1000);
    eq("boot depois das 03:00: próximoEm", iso(h.s.estado().proximoEm), "2026-09-25T06:00:00.000Z");
  }
  {
    const h = makeScheduler({ env: { CENTRAL_VENDAS_NOTURNO_ENABLED: "true", CENTRAL_VENDAS_NOTURNO_HORA: "04:15" } });
    h.s.iniciar();
    eq("HORA customizada: 04:15 SP", iso(h.s.estado().proximoEm), "2026-09-24T07:15:00.000Z");
  }
  {
    const h = makeScheduler({ env: { CENTRAL_VENDAS_NOTURNO_ENABLED: "true", CENTRAL_VENDAS_NOTURNO_HORA: "25:99" } });
    h.s.iniciar();
    ok("HORA inválida: aviso", h.logs.some((l) => l.startsWith("WARN") && l.includes("CENTRAL_VENDAS_NOTURNO_HORA inválida")));
    eq("HORA inválida: cai no padrão 03:00", iso(h.s.estado().proximoEm), "2026-09-24T06:00:00.000Z");
  }

  // =========================================================================
  // 5. Disparo: roda uma vez, libera o lock, reagenda para o dia seguinte
  // =========================================================================
  {
    const h = makeScheduler();
    h.s.iniciar();
    await h.disparar();
    eq("disparo: uma rodada", h.chamadas.rodada.length, 1);
    eq("disparo: mesma entrada do job, origem do scheduler", h.chamadas.rodada[0].origem, "scheduler-central");
    ok("disparo: env repassado (SYNC_CENTRAL_CONCURRENCY etc.)", h.chamadas.rodada[0].env && h.chamadas.rodada[0].env.CENTRAL_VENDAS_NOTURNO_ENABLED === "true");
    eq("disparo: lock obtido e liberado", [h.chamadas.lock, h.chamadas.liberar], [1, 1]);
    ok("disparo: logs iniciada/concluída", h.logs.some((l) => l.includes("[sync-scheduler] rodada iniciada")) && h.logs.some((l) => l.includes("[sync-scheduler] rodada concluída:") && l.includes("elegíveis=2") && l.includes("completed=2")));
    eq("disparo: reagendado (1 timer ativo)", h.timers.ativos().length, 1);
    eq("disparo: próximo = amanhã 03:00 SP", iso(h.s.estado().proximoEm), "2026-09-25T06:00:00.000Z");
    eq("disparo: 24h até o próximo", h.timers.ativos()[0].ms, 24 * 3600 * 1000);
    await h.disparar();
    eq("disparo: segunda noite roda de novo", h.chamadas.rodada.length, 2);
  }
  {
    // Rodada longa: próximo agendamento é calculado a partir do FIM dela.
    const h = makeScheduler({ rodada: async () => { h.setAgora(h.getAgora() + 2 * 3600 * 1000); return {}; } });
    h.s.iniciar();
    await h.disparar();
    eq("rodada longa: próximo continua sendo amanhã 03:00", iso(h.s.estado().proximoEm), "2026-09-25T06:00:00.000Z");
    eq("rodada longa: espera 22h", h.timers.ativos()[0].ms, 22 * 3600 * 1000);
  }
  {
    // Timer disparou cedo (relógio ajustado): reagenda sem rodar.
    const h = makeScheduler();
    h.s.iniciar();
    const t = h.timers.ativos()[0];
    h.setAgora(h.getAgora() + t.ms - 60 * 1000);
    t.fired = true;
    await t.fn();
    eq("disparo cedo: não roda", h.chamadas.rodada.length, 0);
    eq("disparo cedo: reagendado para o mesmo alvo", [h.timers.ativos().length, iso(h.s.estado().proximoEm)], [1, "2026-09-24T06:00:00.000Z"]);
  }

  // =========================================================================
  // 6. Duas tentativas simultâneas
  // =========================================================================
  {
    // Só a PRIMEIRA rodada fica pendurada até liberarRodada(); as seguintes resolvem na hora.
    let liberarRodada;
    let n = 0;
    const h = makeScheduler({ rodada: () => (++n === 1 ? new Promise((resolve) => { liberarRodada = () => resolve({}); }) : {}) });
    const primeira = h.s.dispararRodada();
    await flush();
    const segunda = await h.s.dispararRodada();
    eq("mesmo processo: segunda tentativa ignorada", segunda, { executada: false, motivo: "EM_ANDAMENTO_NESTE_PROCESSO" });
    ok("mesmo processo: estado emExecucao", h.s.estado().emExecucao === true);
    liberarRodada();
    eq("mesmo processo: primeira executou", (await primeira).executada, true);
    eq("mesmo processo: UMA rodada", h.chamadas.rodada.length, 1);
    ok("mesmo processo: aviso logado", h.logs.some((l) => l.includes("rodada já em andamento neste processo")));
    eq("mesmo processo: depois de terminar, pode rodar de novo", (await h.s.dispararRodada()).executada, true);
  }
  {
    // Outra instância segura o advisory lock.
    const h = makeScheduler({ lock: () => ({ adquirido: false }) });
    h.s.iniciar();
    await h.disparar();
    eq("outra instância: rodada não executada", h.chamadas.rodada.length, 0);
    ok("outra instância: log", h.logs.some((l) => l.includes("outra instância já está executando a rodada")));
    eq("outra instância: reagendado", h.timers.ativos().length, 1);
  }
  {
    // Advisory lock REAL (adquirirLockGlobal) contra um pool falso que imita
    // pg_try_advisory_lock de sessão: dois schedulers disparando juntos → uma rodada.
    const seguros = new Map(); // chave → id da conexão dona
    let nextConn = 0;
    const releases = [];
    const pool = {
      async connect() {
        const id = ++nextConn;
        return {
          async query(sql, params) {
            const chave = params.join(":");
            if (sql.includes("pg_try_advisory_lock")) {
              if (seguros.has(chave) && seguros.get(chave) !== id) return { rows: [{ locked: false }] };
              seguros.set(chave, id);
              return { rows: [{ locked: true }] };
            }
            if (sql.includes("pg_advisory_unlock")) {
              if (seguros.get(chave) === id) seguros.delete(chave);
              return { rows: [{ pg_advisory_unlock: true }] };
            }
            throw new Error(`SQL inesperado: ${sql}`);
          },
          release(err) { releases.push({ id, err: err || null }); },
        };
      },
    };
    let rodadas = 0;
    let liberar;
    const bloqueio = new Promise((r) => { liberar = r; });
    const mk = () => sched.createScheduler({
      env: { CENTRAL_VENDAS_NOTURNO_ENABLED: "true" },
      getPool: () => pool,
      executarRodadaNoturna: async () => { rodadas += 1; await bloqueio; return {}; },
      logger: { log() {}, warn() {}, error() {} },
    });
    const a = mk();
    const b = mk();
    const pa = a.dispararRodada();
    const pb = b.dispararRodada();
    await flush();
    liberar();
    const [ra, rb] = await Promise.all([pa, pb]);
    eq("instâncias: exatamente uma rodada", rodadas, 1);
    eq("instâncias: uma executou, a outra viu o lock", [ra.executada, rb.executada].sort(), [false, true]);
    eq("instâncias: motivo da ignorada", [ra, rb].find((r) => !r.executada).motivo, "RODADA_EM_OUTRA_INSTANCIA");
    eq("instâncias: lock liberado ao fim", seguros.size, 0);
    eq("instâncias: as duas conexões voltaram ao pool", releases.length, 2);
    eq("instâncias: próxima tentativa consegue o lock", (await a.dispararRodada()).executada, true);
    eq("namespace próprio do lock", [sched.LOCK_NAMESPACE, sched.LOCK_CHAVE_RODADA], [1296845920, 1]);
  }
  {
    // Unlock falhou → conexão descartada (release(err)), não devolvida segurando o lock.
    const releases = [];
    const pool = {
      async connect() {
        return {
          async query(sql) {
            if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
            throw new Error("conexão caiu");
          },
          release(err) { releases.push(err || null); },
        };
      },
    };
    const lock = await sched.adquirirLockGlobal(pool);
    await lock.liberar();
    ok("unlock falhou: conexão descartada com erro", releases.length === 1 && releases[0] instanceof Error);
  }

  // =========================================================================
  // 7. Erros não matam o Web Service e reagendam
  // =========================================================================
  {
    const h = makeScheduler({
      rodada: async () => {
        const e = new Error("pool esgotado Authorization: Bearer APP_USR-777-segredo refresh_token=TG-xyz password=hunter2");
        e.code = "ECONNRESET";
        throw e;
      },
    });
    h.s.iniciar();
    let lancou = false;
    try { await h.disparar(); } catch (_) { lancou = true; }
    ok("erro na rodada: callback do timer não lança", !lancou);
    ok("erro na rodada: log [sync-scheduler] erro", h.logs.some((l) => l.startsWith("ERROR") && l.includes("[sync-scheduler] erro na rodada: ECONNRESET")));
    eq("erro na rodada: lock liberado mesmo assim", h.chamadas.liberar, 1);
    eq("erro na rodada: próxima rodada agendada", [h.timers.ativos().length, iso(h.s.estado().proximoEm)], [1, "2026-09-25T06:00:00.000Z"]);
    eq("erro na rodada: não fica preso em execução", h.s.estado().emExecucao, false);
    const texto = h.logs.join("\n");
    ok("erro na rodada: nenhum segredo no log", !texto.includes("APP_USR-777") && !texto.includes("TG-xyz") && !texto.includes("hunter2"));
    await h.disparar();
    eq("erro na rodada: noite seguinte roda de novo", h.chamadas.rodada.length, 2);
  }
  {
    const h = makeScheduler({ lock: async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:5432"); } });
    h.s.iniciar();
    await h.disparar();
    ok("banco fora no disparo: log de erro do lock", h.logs.some((l) => l.includes("[sync-scheduler] erro ao obter lock da rodada")));
    eq("banco fora no disparo: rodada não executada", h.chamadas.rodada.length, 0);
    eq("banco fora no disparo: reagendado", h.timers.ativos().length, 1);
  }

  // =========================================================================
  // 8. Encerramento limpa o timer
  // =========================================================================
  {
    const h = makeScheduler();
    h.s.iniciar();
    const t = h.timers.ativos()[0];
    h.s.parar();
    ok("parar: clearTimeout no timer ativo", t.cleared === true);
    eq("parar: estado", h.s.estado(), { iniciado: false, emExecucao: false, proximoEm: null, temTimer: false });
    ok("parar: log", h.logs.some((l) => l.includes("[sync-scheduler] parado (timer limpo)")));
    await t.fn(); // callback atrasado depois de parar
    eq("parar: callback tardio não roda nem reagenda", [h.chamadas.rodada.length, h.timers.ativos().length], [0, 0]);
    eq("parar: pode reiniciar", [h.s.iniciar(), h.timers.ativos().length], [true, 1]);
  }
  {
    // Parar DURANTE uma rodada: ela termina, mas não reagenda.
    let liberarRodada;
    const h = makeScheduler({ rodada: () => new Promise((resolve) => { liberarRodada = () => resolve({}); }) });
    h.s.iniciar();
    const disparo = h.disparar();
    await flush();
    h.s.parar();
    liberarRodada();
    await disparo;
    eq("parar durante rodada: não reagenda", h.timers.ativos().length, 0);
  }
  {
    let liberarRodada;
    const h = makeScheduler({
      rodada: (opts) => new Promise((resolve) => {
        opts.onProgresso({ concluidas: 3, total: 10, unidade: "cliente-3#3" });
        liberarRodada = () => resolve({});
      }),
      esperar: async () => {},
    });
    const disparo = h.s.dispararRodada();
    await flush();
    const parada = await h.s.parar({ aguardarMs: 20_000 });
    eq("shutdown: timeout informa rodada não drenada", parada.drenada, false);
    ok("shutdown: log informa progresso e recuperação", h.logs.some((l) => l.includes("após 3/10") && l.includes("serão recuperados")));
    liberarRodada();
    await disparo;
  }
  {
    const h = makeScheduler({ recuperacao: async () => ({ recuperada: true, resumo: { total: 10, elegiveis: 10, execucoes: 10, completed: 10, partial: 0, failed: 0, ignorados: 0, snapshots: { atualizados: 10 } } }) });
    const r = await h.s.recuperarPendencias();
    eq("restart: recuperação usa o mesmo lock global", [r.executada, h.chamadas.lock, h.chamadas.liberar], [true, 1, 1]);
    eq("restart: chama o recuperador uma vez", h.chamadas.recuperacao.length, 1);
    ok("restart: resumo observável", h.logs.some((l) => l.includes("recuperação concluída") && l.includes("tentadas=10")));
  }
  {
    // Instância padrão do módulo: parar() sem iniciar é seguro.
    sched.parar();
    ok("módulo: parar() sem iniciar não lança", true);
  }

  // =========================================================================
  // 9. Integração no index.js
  // =========================================================================
  {
    const index = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
    ok("index: importa o scheduler", index.includes('require("./services/centralVendas/centralVendasNoturnoScheduler")'));
    ok("index: inicia só depois de ensureCentralVendasTables", /ensureCentralVendasTables\(\)\.then\(\s*\(\) => \{[\s\S]*centralVendasNoturnoScheduler\.iniciar\(\)/.test(index));
    ok("index: recupera pendências depois de iniciar", index.includes("centralVendasNoturnoScheduler.recuperarPendencias()"));
    const encerrar = index.slice(index.indexOf("function encerrarComGraca"), index.indexOf('process.on("SIGTERM"'));
    ok("index: encerrarComGraca drena o scheduler com prazo", encerrar.includes("centralVendasNoturnoScheduler.parar({ aguardarMs: 20000 })"));
    ok("index: não chama a rodada direto", !index.includes("executarRodada"));
  }

  eq("nenhuma unhandled rejection", unhandled, 0);
  concluido = true;
  console.log(`centralVendasNoturnoScheduler.test.js: ${checks} verificacoes OK`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
