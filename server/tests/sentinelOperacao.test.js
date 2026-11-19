// Operação do Sentinel (S1.5): avaliarSinais PURO + GET /sentinel/operacao com banco/acesso FALSOS. Sem banco/ML/rede.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const O = require("../services/sentinel/sentinelOperacao");

const AGORA = Date.parse("2026-11-19T12:00:00.000Z");
const MIN = 60000;
const HORA = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const CFG = { ...O.configOperacao({}), statementTimeoutMs: 5000 };

function linhaWorker({ hbAtras = MIN, commit = "abc123def456", anterior = null, encerramento = null, iniciadoAtras = 10 * MIN, polling = {}, billing = {}, base = AGORA } = {}) {
  return {
    chave: "worker_processo", pausado_ate: null, ocorrencias: 4, atualizado_em: new Date(base - hbAtras),
    motivo: JSON.stringify({
      v: 1, instancia: "srv-abc-1", commit, pid: 7, iniciadoEm: iso(base - iniciadoAtras), heartbeatEm: iso(base - hbAtras),
      encerradoEm: encerramento ? iso(base - hbAtras) : null, encerramento, memoria: { rssMb: 90, heapUsedMb: 40 },
      polling: { habilitado: true, contas: [3, 41, 86], intervaloMs: 180000, ultimoCicloEm: iso(base - 2 * MIN), ultimoCicloMs: 9000,
        ultimoCicloPedidos: 12, ultimoCicloEstado: "concluido", ultimoCicloErro: null, falhasSeguidas: 0, falhaBoot: null, ...polling },
      billing: { habilitado: true, contas: [41, 86], intervaloMs: 6 * HORA, emExecucao: false, ultimaVerificacaoEm: iso(base - MIN), ...billing },
      anterior,
    }),
  };
}
const ctx = (contaIds = [3, 41, 86]) => ({ agoraMs: AGORA, cfg: CFG, contaIds });

test("W1 estado do worker por idade do heartbeat: vivo, atrasado, parado, sem_dados (nunca finge saúde)", () => {
  assert.equal(O.lerWorker(linhaWorker({ hbAtras: MIN }), ctx()).estado, "vivo");
  assert.equal(O.lerWorker(linhaWorker({ hbAtras: 30 * MIN }), ctx()).estado, "atrasado");
  assert.equal(O.lerWorker(linhaWorker({ hbAtras: 3 * HORA }), ctx()).estado, "parado");
  const sem = O.lerWorker(null, ctx());
  assert.equal(sem.estado, "sem_dados");
  assert.equal(sem.fonte, "sem_heartbeat");
  const lixo = O.lerWorker({ chave: "worker_processo", ocorrencias: 1, motivo: "{não é json", atualizado_em: new Date(AGORA) }, ctx());
  assert.equal(lixo.estado, "sem_dados");
  // listas de contas publicadas pelo worker: só as da carteira
  const w = O.lerWorker(linhaWorker(), ctx([41]));
  assert.deepEqual(w.polling.contas, [41]);
  assert.equal(w.polling.totalContas, 3);
  assert.deepEqual(w.billing.contas, [41]);
});

test("W2 reinício inesperado (mesmo commit, anterior sem encerramento limpo) × deploy (commit diferente)", () => {
  const crash = O.lerWorker(linhaWorker({ anterior: { instancia: "srv-abc-0", commit: "abc123def456", heartbeatEm: iso(AGORA - 20 * MIN), encerramento: null } }), ctx());
  assert.equal(crash.reinicioInesperado, true);
  const deploy = O.lerWorker(linhaWorker({ anterior: { instancia: "srv-abc-0", commit: "000000000000", heartbeatEm: iso(AGORA - 20 * MIN), encerramento: null } }), ctx());
  assert.equal(deploy.reinicioInesperado, false);
  const limpo = O.lerWorker(linhaWorker({ anterior: { commit: "abc123def456", encerramento: "limpo" } }), ctx());
  assert.equal(limpo.reinicioInesperado, false);
  const semCommit = O.lerWorker(linhaWorker({ commit: null, anterior: { commit: null, encerramento: null } }), ctx());
  assert.equal(semCommit.reinicioInesperado, null);

  const snap = (worker) => ({ disponivel: true, worker, polling: { porCheckpoint: { estado: "ativo" } }, billing: null, contas: [] });
  const tipos = (w) => O.avaliarSinais(snap(w), ctx()).map((s) => s.tipo);
  assert.ok(tipos(crash).includes("worker_reinicio_inesperado"));
  assert.ok(!tipos(deploy).includes("worker_reinicio_inesperado"));
  // boot antigo (fora da janela de 24 h): informação no bloco do worker, sem sinal
  const antigo = O.lerWorker(linhaWorker({ iniciadoAtras: 30 * HORA, anterior: { commit: "abc123def456", encerramento: null } }), ctx());
  assert.equal(antigo.reinicioInesperado, true);
  assert.ok(!tipos(antigo).includes("worker_reinicio_inesperado"));
});

test("W3 sinais do worker: parado sem encerramento = crítica; encerrado limpo = alta; sem heartbeat = info", () => {
  const sev = (w) => O.avaliarSinais({ disponivel: true, worker: w, polling: { porCheckpoint: { estado: "ativo" } }, contas: [] }, ctx())
    .filter((s) => s.tipo === "worker_sem_heartbeat").map((s) => s.severidade);
  assert.deepEqual(sev(O.lerWorker(linhaWorker({ hbAtras: 3 * HORA }), ctx())), ["critica"]);
  assert.deepEqual(sev(O.lerWorker(linhaWorker({ hbAtras: 3 * HORA, encerramento: "limpo" }), ctx())), ["alta"]);
  assert.deepEqual(sev(O.lerWorker(linhaWorker({ hbAtras: 30 * MIN }), ctx())), ["media"]);
  assert.deepEqual(sev(O.lerWorker(linhaWorker(), ctx())), []);
  assert.deepEqual(sev(O.lerWorker(null, ctx())), ["info"]);
});

function billingSnap({ agenda, pausa, worker }) {
  const w = worker || O.lerWorker(linhaWorker(), ctx());
  return { disponivel: true, worker: w, polling: { porCheckpoint: { estado: "ativo" } }, billing: O.lerBilling(agenda, pausa, w, ctx()), contas: [] };
}
const agendaLinha = ({ proximaEm, ocorrencias = 0, resultado = "concluida", contas = [{ contaId: 41, gravados: 2 }, { contaId: 86, gravados: 1 }, { contaId: 999, gravados: 5 }] }) => ({
  chave: "billing_agenda", pausado_ate: proximaEm === null ? null : new Date(proximaEm), ocorrencias, atualizado_em: new Date(AGORA - 5 * HORA),
  motivo: JSON.stringify({ v: 1, execucaoId: "b-1-abcd", instancia: "srv-abc-1", inicioEm: iso(AGORA - 5 * HORA - MIN), fimEm: iso(AGORA - 5 * HORA),
    duracaoMs: 60000, resultado, chamadas: 9, gravados: 8, parou429: false, contas, erro: resultado === "erro" ? "falhou Bearer APP_USR-123-SEGREDO" : null, intervaloMs: 6 * HORA }),
});

test("B1 pausa 429 ativa gera sinal; expirada não; motivo sanitizado", () => {
  const ativa = billingSnap({ agenda: agendaLinha({ proximaEm: AGORA + HORA }), pausa: { chave: "billing_429", pausado_ate: new Date(AGORA + 20 * MIN), ocorrencias: 1, motivo: "429 em https://api.mercadolibre.com/x?access_token=APP_USR-9", atualizado_em: new Date(AGORA) } });
  assert.equal(ativa.billing.pausa429.ativa, true);
  assert.equal(JSON.stringify(ativa).includes("APP_USR"), false);
  assert.ok(O.avaliarSinais(ativa, ctx()).some((s) => s.tipo === "billing_pausado_429" && s.severidade === "media"));
  const exp = billingSnap({ agenda: agendaLinha({ proximaEm: AGORA + HORA }), pausa: { chave: "billing_429", pausado_ate: new Date(AGORA - MIN), ocorrencias: 3, motivo: "x", atualizado_em: new Date(AGORA) } });
  assert.equal(exp.billing.pausa429.ativa, false);
  assert.ok(!O.avaliarSinais(exp, ctx()).some((s) => s.tipo === "billing_pausado_429"));
});

test("B2 agenda atrasada (habilitado) gera billing_atrasado; dentro da tolerância, em execução ou DESLIGADO não", () => {
  const tem = (snap) => O.avaliarSinais(snap, ctx()).some((s) => s.tipo === "billing_atrasado");
  assert.equal(tem(billingSnap({ agenda: agendaLinha({ proximaEm: AGORA - 2 * HORA }) })), true);
  assert.equal(tem(billingSnap({ agenda: agendaLinha({ proximaEm: AGORA - 30 * MIN }) })), false);
  assert.equal(tem(billingSnap({ agenda: agendaLinha({ proximaEm: AGORA + HORA }) })), false);
  const desligado = O.lerWorker(linhaWorker({ billing: { habilitado: false } }), ctx());
  assert.equal(tem(billingSnap({ agenda: agendaLinha({ proximaEm: AGORA - 10 * HORA }), worker: desligado })), false);
  const emExec = O.lerWorker(linhaWorker({ billing: { emExecucao: true } }), ctx());
  assert.equal(tem(billingSnap({ agenda: agendaLinha({ proximaEm: AGORA - 10 * HORA }), worker: emExec })), false);
  // habilitado e NUNCA agendado: atrasado só depois da tolerância desde o boot
  const bootVelho = O.lerWorker(linhaWorker({ iniciadoAtras: 3 * HORA }), ctx());
  assert.equal(tem(billingSnap({ agenda: null, worker: bootVelho })), true);
  assert.equal(tem(billingSnap({ agenda: null })), false);
  // worker sem heartbeat ⇒ habilitado desconhecido (null) ⇒ nunca billing_atrasado
  assert.equal(tem(billingSnap({ agenda: agendaLinha({ proximaEm: AGORA - 10 * HORA }), worker: O.lerWorker(null, ctx()) })), false);
});

test("B3 falhas seguidas ≥ 2 e última execução com contas SÓ da carteira e erro sanitizado", () => {
  const snap = billingSnap({ agenda: agendaLinha({ proximaEm: AGORA + HORA, ocorrencias: 2, resultado: "erro" }) });
  assert.deepEqual(snap.billing.ultimaExecucao.contas.map((c) => c.contaId), [41, 86]);
  assert.equal(JSON.stringify(snap.billing).includes("APP_USR"), false);
  assert.ok(O.avaliarSinais(snap, ctx()).some((s) => s.tipo === "billing_falhas_seguidas" && s.severidade === "alta"));
  const so41 = O.lerBilling(agendaLinha({ proximaEm: AGORA + HORA }), null, null, ctx([41]));
  assert.deepEqual(so41.ultimaExecucao.contas.map((c) => c.contaId), [41]);
  assert.equal(so41.habilitado, null);
});

function conta(id, over = {}) {
  return {
    contaId: id, ativo: true,
    polling: { monitorada: true, situacao: "ok", atrasoSegundos: 60, ciclosSemProgresso: 0, quarentena: 0, retentando: 0, leituraSeveridade: null, ...(over.polling || {}) },
    cobertura: { custoAusente: 0, reconsultasVencidas: 0, reconsultasVencidasAntigas: 0, reconsultasForaDaJanela: 0, sairamDaJanelaSemConsulta7d: 0, documentosProvisoriosAntigos: 0, ...(over.cobertura || {}) },
    grant: { situacao: "ok", motivo: null, ...(over.grant || {}) },
  };
}

test("S1 sinais por conta: limiares objetivos e contas fora da carteira não aparecem", () => {
  const w = O.lerWorker(linhaWorker(), ctx());
  const snap = {
    disponivel: true, worker: w, polling: { porCheckpoint: { estado: "ativo" } }, billing: O.lerBilling(agendaLinha({ proximaEm: AGORA + HORA }), null, w, ctx()),
    contas: [
      conta(41, { polling: { ciclosSemProgresso: 3, quarentena: 2 }, cobertura: { custoAusente: 4, sairamDaJanelaSemConsulta7d: 1, reconsultasVencidasAntigas: 3, reconsultasForaDaJanela: 1, documentosProvisoriosAntigos: 1 } }),
      conta(86, { grant: { situacao: "indisponivel", motivo: "expirado" }, polling: { ciclosSemProgresso: 9 } }),
      conta(3, { polling: { ciclosSemProgresso: 2 } }),
    ],
  };
  const sinais = O.avaliarSinais(snap, ctx([41, 3]));
  assert.equal(sinais.some((s) => s.contaId === 86), false);
  const de41 = sinais.filter((s) => s.contaId === 41).map((s) => s.tipo).sort();
  assert.deepEqual(de41, ["cobertura_perdida", "conta_sem_progresso", "custo_ausente", "documento_provisorio_antigo", "pedidos_em_quarentena", "reconsultas_fora_da_janela", "reconsultas_vencidas_acumuladas"]);
  assert.equal(sinais.some((s) => s.contaId === 3), false, "2 ciclos < limiar 3");
  // grant indisponível em conta monitorada
  const comGrant = O.avaliarSinais(snap, ctx([86]));
  assert.ok(comGrant.some((s) => s.tipo === "grant_indisponivel" && s.contaId === 86 && s.severidade === "alta"));
  // custo ausente é só informativo; ordenado por severidade
  assert.equal(sinais.find((s) => s.tipo === "custo_ausente").severidade, "info");
  const ordem = sinais.map((s) => O.SEVERIDADES.indexOf(s.severidade));
  assert.deepEqual(ordem, [...ordem].sort((a, b) => a - b));
  // nenhum sinal fala em prejuízo nem usa severidade de incidente "baixa"
  assert.equal(JSON.stringify(sinais).toLowerCase().includes("prejuízo"), false);
  assert.ok(sinais.every((s) => O.SEVERIDADES.includes(s.severidade) && s.estado === "ativo"));
});

test("S2 dedupKey estável entre avaliações (números e hora mudam, a chave não)", () => {
  const w = O.lerWorker(linhaWorker({ hbAtras: 3 * HORA }), ctx());
  const a = O.avaliarSinais({ disponivel: true, worker: w, polling: { porCheckpoint: { estado: "parado", idadeSegundos: 9000 } }, contas: [conta(41, { polling: { quarentena: 1 } })] }, ctx());
  const w2 = O.lerWorker(linhaWorker({ hbAtras: 5 * HORA }), { ...ctx(), agoraMs: AGORA + HORA });
  const b = O.avaliarSinais({ disponivel: true, worker: w2, polling: { porCheckpoint: { estado: "parado", idadeSegundos: 12000 } }, contas: [conta(41, { polling: { quarentena: 7 } })] }, { ...ctx(), agoraMs: AGORA + HORA });
  assert.deepEqual(a.map((s) => s.dedupKey).sort(), b.map((s) => s.dedupKey).sort());
  assert.deepEqual(a.map((s) => s.dedupKey).sort(), ["pedidos_em_quarentena:41", "polling_parado:global", "worker_sem_heartbeat:global"]);
  assert.notEqual(a[0].detectadoEm, b[0].detectadoEm);
});

test("S3 polling desligado por flag ⇒ polling_parado só informativo; falhas seguidas ⇒ alta", () => {
  const off = O.lerWorker(linhaWorker({ polling: { habilitado: false } }), ctx());
  const s1 = O.avaliarSinais({ disponivel: true, worker: off, polling: { porCheckpoint: { estado: "parado" } }, contas: [] }, ctx());
  assert.equal(s1.find((s) => s.tipo === "polling_parado").severidade, "info");
  const falhando = O.lerWorker(linhaWorker({ polling: { falhasSeguidas: 3, ultimoCicloEstado: "erro", ultimoCicloErro: "x" } }), ctx());
  const s2 = O.avaliarSinais({ disponivel: true, worker: falhando, polling: { porCheckpoint: { estado: "ativo" } }, contas: [] }, ctx());
  assert.equal(s2.find((s) => s.tipo === "polling_parado").severidade, "alta");
});

test("G1 grant: mesma semântica do runtime (permanente/expirado ⇒ indisponível; error/falhas ⇒ atenção)", () => {
  const f = (g, o) => O.avaliarGrant(g, AGORA, o);
  const ok = { token_status: "valid", expires_at: new Date(AGORA + 3 * HORA), refresh_failures: 0 };
  assert.equal(f(ok).situacao, "ok");
  assert.equal(f({ ...ok, token_status: "revoked" }).situacao, "indisponivel");
  assert.equal(f({ ...ok, expires_at: new Date(AGORA - MIN) }).motivo, "expirado");
  assert.equal(f({ ...ok, token_status: "error" }).situacao, "atencao");
  assert.equal(f({ ...ok, refresh_failures: 2, last_refresh_error_at: new Date(AGORA - HORA) }).situacao, "atencao");
  assert.equal(f({ ...ok, expires_at: new Date(AGORA + 2 * MIN), next_refresh_attempt_at: new Date(AGORA + 10 * MIN) }).motivo, "renovacao_adiada");
  assert.equal(f(null).motivo, "sem_grant");
  assert.equal(f(undefined).situacao, "desconhecido");
  assert.equal(f(null, { semSeller: true }).motivo, "conta_sem_seller");
});

// ── rota (gate real do router; auth/acesso/db/motor falsos) ────────────────────────────────────────
function fakeDb({ semTabelas = false, falhar = false, linhas = {} } = {}) {
  const log = [];
  const r = (rows) => ({ rows });
  return {
    log,
    query: async (sql, params) => {
      log.push(sql);
      if (falhar) throw new Error('relation "sentinel_conciliacao_controle" does not exist — SELECT chave FROM ...');
      if (/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(sql)) throw new Error("ESCRITA PROIBIDA");
      if (sql.includes("to_regclass('public.sentinel_conciliacao_comissao')")) return r([{ ok: !semTabelas }]);
      if (sql.includes("to_regclass('public.ml_tokens')")) return r([{ ok: true }]);
      // simula um banco que devolveria contas fora da carteira: a leitura nunca as repassa
      if (sql.includes("OPERACAO_CHECKPOINTS")) return r([{ conta_id: 41, ciclos_sem_progresso: 0, pedidos_processados_ultima: 5, quarentena: 1, retentando: 0 }, { conta_id: 86, ciclos_sem_progresso: 9, quarentena: 9, retentando: 0 }]);
      if (sql.includes("OPERACAO_GRANTS")) return r([{ conta_id: 41, sem_seller: false, tem_grant: true, token_status: "valid", expires_at: new Date(Date.now() + 3 * HORA), refresh_failures: 0, access_token: "APP_USR-SEGREDO", refresh_token: "TG-SEGREDO", last_refresh_error: "invalid_grant refresh_token=TG-X" }]);
      if (sql.includes("OPERACAO_CONTROLE")) return r(linhas.controle || [linhaWorker({ base: Date.now() })]);
      if (sql.includes("OPERACAO_COBERTURA_PEDIDOS")) return r([{ conta_id: 41, monitorados: 10, elegiveis: 6, consultados: 4, desatualizados: 0, sairam7d: 0, custo_ausente: 1 }, { conta_id: 86, monitorados: 99, elegiveis: 99, consultados: 0, desatualizados: 0, sairam7d: 50, custo_ausente: 0 }]);
      if (sql.includes("OPERACAO_COBERTURA_CONCILIACOES")) return r([{ conta_id: 41, estado: "NAO_CONCILIADO", status_coleta: "concluida", na_janela: true, n: 4, doc_provisorio: 0, doc_provisorio_antigo: 0, vencidas: 0, vencidas_antigas: 0, fora_janela: 0, com_falha: 0, nc_transitorio: 0, nc_escopo: 4, ultima_obs: new Date(), proxima_reconsulta: null }]);
      if (sql.includes("OPERACAO_MOTIVOS")) return r([{ conta_id: 41, motivo: "cupom_nao_validado", n: 3 }, { conta_id: 86, motivo: "cobrancas_nao_somam_net", n: 9 }]);
      throw new Error(`SQL inesperado no fake: ${sql.slice(0, 60)}`);
    },
  };
}
const motorFake = {
  // devolve também uma conta FORA da carteira (86): a leitura nunca a repassa
  saudeContas: async (_db, { contaIds }) => contaIds.map((contaId) => ({
    contaId, clienteId: 1, clienteNome: "Cliente", contaNome: `Conta ${contaId}`, squad: null, ativo: true, monitorada: true,
    ultimaExecucaoEm: new Date(), checkpoint: new Date(), atrasoSegundos: 30, ultimoErro: null, situacao: "ok", limiteMin: 120,
  })).concat([{ contaId: 86, clienteNome: "INTRUSA", monitorada: true, situacao: "ok" }]),
  resumoOperacional: async (_db, { contaIds }) => ({
    worker: { estado: "ativo", ultimaExecucaoEm: new Date().toISOString(), idadeSegundos: 30, intervaloEsperadoSegundos: 480 },
    contas: { monitoradas: contaIds.length, ok: contaIds.length, atrasadas: 0, erroToken: 0, erroApi: 0, nuncaLidas: 0, semPedidosRecentes: 0 },
    checkpointIdadeMaxSegundos: 30, ultimaColetaOkEm: null, incidentesAbertosPorSeveridade: { critica: 9 }, alertas: [{ codigo: "INCIDENTES_CRITICOS" }], limiteLeituraMin: 120,
  }),
};

async function servidor({ db, acesso, operacao } = {}) {
  const { criarSentinelRouter } = require("../routes/sentinelRoutes");
  const auth = (req, res, next) => {
    const u = req.headers["x-user"];
    if (!u) return res.status(401).json({ ok: false, erro: "sem token" });
    req.user = JSON.parse(u);
    next();
  };
  const acessoBase = {
    papelPermitido: (u) => u.role === "admin" || u.role === "interno",
    contasAutorizadas: async () => ({ contaIds: [41], contas: [{ id: 41, ativo: true }] }),
    contaAutorizadaInfo: async () => null,
    ...(acesso || {}),
  };
  const app = express();
  app.use("/sentinel", criarSentinelRouter({ auth, db: db || fakeDb(), acesso: acessoBase, motor: () => motorFake, ...(operacao ? { operacao } : {}) }));
  const srv = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  const get = async (user, path = "/sentinel/operacao") => {
    const headers = user ? { "x-user": JSON.stringify(user) } : {};
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, { headers });
    return { status: r.status, body: await r.json() };
  };
  return { get, fechar: () => new Promise((r) => srv.close(r)) };
}
const ADMIN = { id: 1, role: "admin" };

test("R1 gate existente: sem usuário 401, papel sem acesso 403 (não chega ao módulo); rota é só GET", async () => {
  const chamadas = [];
  const s = await servidor({ operacao: { lerOperacao: async (_db, a) => { chamadas.push(a); return {}; } } });
  try {
    assert.equal((await s.get(null)).status, 401);
    assert.equal((await s.get({ id: 7, role: "seller" })).status, 403);
    assert.equal(chamadas.length, 0);
  } finally { await s.fechar(); }
  const { criarSentinelRouter } = require("../routes/sentinelRoutes");
  const router = criarSentinelRouter({ auth: (_q, _s, n) => n(), db: {}, acesso: { papelPermitido: () => true }, motor: {} });
  const rotas = router.stack.filter((l) => l.route && l.route.path === "/operacao").map((l) => Object.keys(l.route.methods));
  assert.deepEqual(rotas, [["get"]]);
});

test("R2 carteira: módulo recebe só as contas autorizadas (filtros conta/cliente/squad repassados ao acesso)", async () => {
  const chamadas = [];
  const filtros = [];
  const s = await servidor({
    acesso: { contasAutorizadas: async (_u, f) => { filtros.push(f); return { contaIds: [41], contas: [{ id: 41 }] }; } },
    operacao: { lerOperacao: async (_db, a) => { chamadas.push(a.contaIds); return { contas: [], sinais: [] }; } },
  });
  try {
    const r = await s.get(ADMIN, "/sentinel/operacao?conta=86&squad=2");
    assert.equal(r.status, 200);
    assert.deepEqual(chamadas, [[41]]);
    assert.deepEqual(filtros[0], { squad: "2", cliente: undefined, conta: "86" });
  } finally { await s.fechar(); }
});

test("R3 leitura real com banco falso: só contas da carteira, sem incidentes, sem campos sensíveis, sem escrita", async () => {
  const db = fakeDb();
  const s = await servidor({ db });
  try {
    const r = await s.get(ADMIN);
    assert.equal(r.status, 200);
    const op = r.body.operacao;
    assert.equal(op.disponivel, true);
    assert.deepEqual(op.contas.map((c) => c.contaId), [41]);
    assert.equal(op.worker.estado, "vivo");
    assert.deepEqual(op.worker.polling.contas, [41]);
    assert.equal(op.contas[0].cobertura.semConsulta, 2);
    assert.equal(op.contas[0].cobertura.naoConciliadoEscopo, 4);
    assert.equal(op.cobertura.elegiveis, 6, "totais só da carteira");
    assert.ok(!op.sinais.some((x) => x.contaId === 86));
    const json = JSON.stringify(r.body);
    for (const proibido of ["INTRUSA", "SEGREDO", "access", "refresh_token", "invalid_grant", "INCIDENTES_CRITICOS", "incidentesAbertos"]) {
      assert.equal(json.includes(proibido), false, proibido);
    }
    // nenhuma CHAVE com "token" (métricas renomeadas: erroGrant)
    const chaves = [];
    JSON.parse(json, (k, v) => { chaves.push(k); return v; });
    assert.equal(chaves.some((k) => /token/i.test(k)), false);
    assert.equal(db.log.some((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q)), false);
  } finally { await s.fechar(); }
});

test("R4 sem as tabelas da 20261119 ⇒ disponivel:false, só polling/grants, 200 (nunca 500)", async () => {
  const db = fakeDb({ semTabelas: true });
  const s = await servidor({ db });
  try {
    const r = await s.get(ADMIN);
    assert.equal(r.status, 200);
    assert.equal(r.body.operacao.disponivel, false);
    assert.equal(r.body.operacao.motivo, "migration_20261119_nao_aplicada");
    assert.equal(r.body.operacao.billing, null);
    assert.equal(r.body.operacao.cobertura, null);
    assert.equal(r.body.operacao.worker.estado, "sem_dados");
    assert.equal(r.body.operacao.contas[0].cobertura, null);
    assert.equal(r.body.operacao.contas[0].grant.situacao, "ok");
    assert.equal(db.log.some((q) => q.includes("sentinel_conciliacao_comissao c")), false);
  } finally { await s.fechar(); }
});

test("R5 erro de banco ⇒ 500 genérico, sem SQL/mensagem do banco", async () => {
  const s = await servidor({ db: fakeDb({ falhar: true }) });
  const orig = console.error; console.error = () => {};
  try {
    const r = await s.get(ADMIN);
    assert.equal(r.status, 500);
    assert.equal(r.body.code, "SENTINEL_ERRO");
    assert.equal(JSON.stringify(r.body).includes("SELECT"), false);
    assert.equal(JSON.stringify(r.body).includes("relation"), false);
  } finally { console.error = orig; await s.fechar(); }
});

test("R6 carteira vazia: blocos globais presentes, nenhuma conta, nenhuma consulta por conta", async () => {
  const db = fakeDb();
  const s = await servidor({ db, acesso: { contasAutorizadas: async () => ({ contaIds: [], contas: [] }) } });
  try {
    const r = await s.get(ADMIN);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.operacao.contas, []);
    assert.equal(r.body.operacao.worker.estado, "vivo");
    assert.deepEqual(r.body.operacao.worker.polling.contas, []);
    assert.equal(db.log.some((q) => q.includes("OPERACAO_COBERTURA") || q.includes("OPERACAO_GRANTS")), false);
  } finally { await s.fechar(); }
});
