// server/services/sentinel/sentinelAgendaBilling.js
//
// S1.5 — Billing agendado DENTRO do worker existente (workers/sentinelWorker.js) + heartbeat do processo.
// Contrato: docs/sentinel/CONTRATO_S1_5_OPERACAO.md (linhas `billing_agenda` e `worker_processo` de
// sentinel_conciliacao_controle; nenhuma migration nova).
//
// Desenho (Alternativa B — mesmo processo, dois agendamentos independentes):
//   · o polling continua idêntico (timer, lock `vf:sentinel:polling`, pool e logs próprios);
//   · o Billing tem timer PRÓPRIO, pool PRÓPRIO (SENTINEL_CONCILIACAO_DB_POOL_MAX, padrão 1) e a conexão dedicada do lock
//     `vf:sentinel:conciliacao` (comLockDoCiclo com `chave`, dentro de executarColeta);
//   · a agenda persistida (`billing_agenda.pausado_ate`) é RELIDA DENTRO do lock (gancho deps.agenda do coletor): duas
//     instâncias / dois agendadores nunca executam a mesma janela; reinício/deploy não dispara Billing se não estiver devido;
//   · o timer do processo só usa a agenda (lida FORA do lock) para saber quanto dormir — a decisão é sempre dentro do lock;
//   · se um ciclo de polling DESTE processo estiver em curso, o Billing espera o fim até SENTINEL_CONCILIACAO_ADIAR_MAX_MS
//     (padrão 120 s) e depois executa mesmo assim. O polling NUNCA espera o Billing;
//   · parar(): limpa o timer, interrompe a espera e pede parada ENTRE chamadas ao ML (deveParar), aguarda a execução.
//
// Nada aqui chama o Mercado Livre diretamente; nada aqui lança para o chamador (falhas viram log + próxima tentativa).

const os = require("os");
const { executarColeta } = require("./sentinelConciliacaoColetor");
const { conciliacaoSchemaPronto } = require("./sentinelSchema");

const CHAVE_AGENDA = "billing_agenda";
const CHAVE_PROCESSO = "worker_processo";
const FLAGS_ON = new Set(["true", "1", "on", "yes"]);
const MIN_MS = 60 * 1000;
const HORA_MS = 60 * MIN_MS;
const INTERVALO_MIN_MS = 10 * MIN_MS;
const MOTIVO_MAX = 4000;
const SONO_PISO_MS = 1000;           // nunca acorda em laço apertado
const SONO_TETO_MS = 30 * MIN_MS;    // relê a agenda (1 SELECT) pelo menos a cada 30 min
const SCHEMA_RECHECK_MS = 10 * MIN_MS;
const AVISO_RATE_MS = 10 * MIN_MS;
const RETOMADA_APOS_PARADA_MS = 10 * MIN_MS;

const ligado = (v) => FLAGS_ON.has(String(v || "").trim().toLowerCase());
const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

function inteiro(v, padrao, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, n));
}

// "41, 86,x" → [41, 86] (allowlist PRÓPRIA do Billing — nunca herda SENTINEL_CONTAS_ALLOWLIST)
function lerIds(texto) {
  return [...new Set(String(texto || "").split(",").map((x) => x.trim()).filter(Boolean)
    .map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

function configAgenda(env = process.env) {
  const intervaloMs = (() => {
    const n = Number.parseInt(env.SENTINEL_CONCILIACAO_INTERVAL_MS, 10);
    return Number.isFinite(n) ? Math.max(INTERVALO_MIN_MS, n) : 6 * HORA_MS;
  })();
  return {
    habilitado: ligado(env.SENTINEL_CONCILIACAO_AGENDADA_ENABLED),
    contas: lerIds(env.SENTINEL_CONCILIACAO_CONTAS),
    intervaloMs,
    poolMax: inteiro(env.SENTINEL_CONCILIACAO_DB_POOL_MAX, 1, 1, 5),
    adiarMaxMs: inteiro(env.SENTINEL_CONCILIACAO_ADIAR_MAX_MS, 120000, 0, 30 * MIN_MS),
    heartbeatMs: inteiro(env.SENTINEL_HEARTBEAT_MS, 180000, 60000, 24 * HORA_MS),
    // lock ocupado (outra instância executando) ⇒ tenta de novo em min(intervalo, 5 min); erro ⇒ min(intervalo, 10 min)
    lockOcupadoRetryMs: Math.min(intervaloMs, 5 * MIN_MS),
    erroRetryMs: Math.min(intervaloMs, 10 * MIN_MS),
  };
}

// Texto seguro para log/JSON: sem URL, sem token/Bearer, sem e-mail; curto.
function sanitizar(texto, max = 200) {
  if (texto === null || texto === undefined) return null;
  return String(texto)
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\b(bearer|access_token|refresh_token|token|authorization)\b\s*[:=]?\s*\S+/gi, "$1=<oculto>")
    .replace(/APP_USR-[\w-]+/g, "<oculto>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max) || null;
}

// "SENTINEL_TRUNCATED: janela…" → "SENTINEL_TRUNCATED"; "SENTINEL_ORDERS_HTTP_ERROR: … HTTP 403." → "SENTINEL_ORDERS_HTTP_ERROR:403"
function codigoErro(texto) {
  if (!texto) return null;
  const s = String(texto);
  const m = s.match(/^\s*([A-Z][A-Z0-9_]{2,60})/);
  const http = s.match(/\bHTTP\s*(\d{3})\b/i);
  const base = m ? m[1] : "ERRO";
  return http ? `${base}:${http[1]}` : base;
}

// JSON ≤ 4000 caracteres: corta o detalhe por conta antes de qualquer outra coisa.
function serializarLimitado(obj, max = MOTIVO_MAX) {
  let s = JSON.stringify(obj);
  if (s.length <= max) return s;
  const copia = { ...obj, contas: Array.isArray(obj.contas) ? obj.contas.slice(0, 5) : obj.contas, truncado: true };
  s = JSON.stringify(copia);
  if (s.length <= max) return s;
  s = JSON.stringify({ ...copia, contas: [], erro: sanitizar(copia.erro, 100) });
  // último recurso: SEMPRE com `instancia` (a posse do heartbeat depende dela; sem ela todo UPDATE afetaria 0 linhas)
  return s.length <= max ? s : JSON.stringify({ v: 1, truncado: true, instancia: obj.instancia ?? null });
}

function identidadeProcesso(env = process.env) {
  const instancia = sanitizar(env.RENDER_INSTANCE_ID, 120) || `${os.hostname()}-${process.pid}`;
  const commit = env.RENDER_GIT_COMMIT ? String(env.RENDER_GIT_COMMIT).slice(0, 12) : null;
  return { instancia, commit, pid: process.pid };
}

function novoExecucaoId(agoraMs) {
  return `b-${agoraMs}-${Math.random().toString(16).slice(2, 6).padEnd(4, "0")}`;
}

// Resumo compacto por conta (sem pedidos, sem payload).
function contasCompactas(contas) {
  return (contas || []).map((c) => ({
    contaId: c.contaId, candidatos: c.candidatos ?? 0, chamadasBilling: c.chamadasBilling ?? 0,
    chamadasDescontos: c.chamadasDescontos ?? 0, gravados: c.gravados ?? 0, falhas: c.falhas ?? 0, parada: c.parada ?? null,
    erro: c.erro ? codigoErro(c.erro) : null,
  }));
}

// ── agenda (gancho deps.agenda do coletor; roda com a conexão do lock) ─────────────────────────────

async function lerAgenda(db) {
  const r = await db.query("SELECT pausado_ate, ocorrencias, atualizado_em FROM sentinel_conciliacao_controle WHERE chave = $1", [CHAVE_AGENDA]);
  const row = r.rows[0];
  return row
    ? { pausadoAteMs: row.pausado_ate ? new Date(row.pausado_ate).getTime() : null, ocorrencias: Number(row.ocorrencias) || 0 }
    : { pausadoAteMs: null, ocorrencias: 0 };
}

const GRAVAR_AGENDA_SQL = `/* sentinel:AGENDA_BILLING */
  INSERT INTO sentinel_conciliacao_controle (chave, pausado_ate, ocorrencias, motivo, atualizado_em)
  VALUES ($1, $2::timestamptz, CASE $5::text WHEN 'zera' THEN 0 WHEN 'mantem' THEN 0 ELSE 1 END, $3, $4::timestamptz)
  ON CONFLICT (chave) DO UPDATE SET
    pausado_ate = EXCLUDED.pausado_ate,
    ocorrencias = CASE $5::text WHEN 'zera' THEN 0 WHEN 'mantem' THEN sentinel_conciliacao_controle.ocorrencias
                  ELSE sentinel_conciliacao_controle.ocorrencias + 1 END,
    motivo = EXCLUDED.motivo, atualizado_em = EXCLUDED.atualizado_em`;

function criarGanchoAgenda({ intervaloMs, instancia, execucaoId, agora = Date.now }) {
  const gancho = {
    execucaoId,
    registrou: false,
    async devida(dbW) {
      const a = await lerAgenda(dbW);
      return a.pausadoAteMs === null || a.pausadoAteMs <= agora();
    },
    async registrar(dbW, r) {
      const fimMs = r.fimMs ?? agora();
      let proximaMs = fimMs + intervaloMs;
      // SIGTERM (deploy/reinício) no meio da execução NÃO é falha e não pode empurrar o resto da fila um intervalo inteiro
      // (≈1,5 deploy/dia medido no Render): a próxima instância retoma em min(intervalo, 10 min), e o contador de falhas
      // seguidas fica como estava.
      if (r.resultado === "parada_solicitada") proximaMs = fimMs + Math.min(intervaloMs, RETOMADA_APOS_PARADA_MS);
      if (r.resultado === "pausa_429") {
        // maior entre o fim da pausa global e fim + intervalo (contrato §3)
        const p = await dbW.query("SELECT pausado_ate FROM sentinel_conciliacao_controle WHERE chave = 'billing_429'");
        const ate = p.rows[0]?.pausado_ate ? new Date(p.rows[0].pausado_ate).getTime() : null;
        if (ate) proximaMs = Math.max(proximaMs, ate);
      }
      const motivo = serializarLimitado({
        v: 1, execucaoId, instancia: instancia || null,
        inicioEm: iso(r.inicioMs ?? fimMs), fimEm: iso(fimMs), duracaoMs: Math.max(0, fimMs - (r.inicioMs ?? fimMs)),
        resultado: r.resultado, chamadas: r.chamadas ?? 0, gravados: r.gravados ?? 0, parou429: r.parou429 === true,
        contas: contasCompactas(r.contas), erro: sanitizar(r.erro, 200), intervaloMs,
      });
      const contador = r.resultado === "concluida" ? "zera" : r.resultado === "parada_solicitada" ? "mantem" : "incrementa";
      await dbW.query(GRAVAR_AGENDA_SQL, [CHAVE_AGENDA, iso(proximaMs), motivo, iso(fimMs), contador]);
      gancho.registrou = true;
      return { proximaMs };
    },
  };
  return gancho;
}

// ── heartbeat (`worker_processo`) ───────────────────────────────────────────────────────────────────
// boot: assume a linha (upsert, ocorrencias+1, copia o dono anterior para `anterior`); depois: UPDATE condicionado à posse.
// Escritas serializadas numa fila; NUNCA lança; sem a 20261119 não grava (checa no boot e a cada 10 min).

function criarHeartbeat({ db, identidade, agora = Date.now, logger = console, estado }) {
  const aviso = typeof logger.warn === "function" ? logger.warn.bind(logger) : logger.log.bind(logger);
  let fila = Promise.resolve();
  let schemaOk = null;
  let schemaVistoEm = 0;
  let ultimoAviso = 0;
  let anterior = null;
  let iniciadoEm = null;
  let encerrado = false;
  let ultimaEscritaMs = 0;
  const dbAtual = db;
  let escritas = 0;
  let falhas = 0;

  const avisar = (msg) => {
    const t = agora();
    if (t - ultimoAviso < AVISO_RATE_MS) return;
    ultimoAviso = t;
    aviso(`[sentinel-op] heartbeat não gravado: ${sanitizar(msg, 160)}`);
  };
  const schemaPronto = async () => {
    const t = agora();
    if (schemaOk === true) return true;
    if (schemaOk === false && t - schemaVistoEm < SCHEMA_RECHECK_MS) return false;
    // lancar: banco fora do ar LANÇA (vira aviso e a próxima escrita tenta de novo) — nunca é memorizado como "ausente".
    const ok = await conciliacaoSchemaPronto(dbAtual, { lancar: true });
    schemaOk = ok;
    schemaVistoEm = t;
    return ok;
  };
  const motivo = (extra = {}) => {
    const m = process.memoryUsage();
    return serializarLimitado({
      v: 1, instancia: identidade.instancia, commit: identidade.commit, pid: identidade.pid,
      iniciadoEm, heartbeatEm: iso(agora()), encerradoEm: null, encerramento: null,
      memoria: { rssMb: Math.round(m.rss / 1048576), heapUsedMb: Math.round(m.heapUsed / 1048576) },
      polling: estado.polling, billing: estado.billing, anterior, ...extra,
    });
  };
  const enfileirar = (fn) => {
    fila = fila.then(async () => {
      try {
        if (!(await schemaPronto())) return;
        await fn();
        ultimaEscritaMs = agora();
        escritas += 1;
      } catch (err) {
        falhas += 1;
        if (err && err.code === "42P01") { schemaOk = false; schemaVistoEm = agora(); return; }
        avisar(`${err && err.code ? err.code : "ERRO"} ${err && err.message}`);
      }
    });
    return fila;
  };

  // Assumir a linha (boot): upsert, ocorrencias+1, dono anterior copiado para `anterior`. Se o banco estava fora (ou a
  // 20261119 ausente) no boot, a PRIMEIRA escrita que der certo assume a linha — o heartbeat volta sozinho.
  let assumiu = false;
  const assumir = async (extra) => {
    const r = await dbAtual.query("SELECT motivo FROM sentinel_conciliacao_controle WHERE chave = $1", [CHAVE_PROCESSO]);
    if (r.rows[0]?.motivo) {
      try {
        const o = JSON.parse(r.rows[0].motivo);
        if (o && o.instancia !== identidade.instancia) {
          anterior = { instancia: o.instancia ?? null, commit: o.commit ?? null, heartbeatEm: o.heartbeatEm ?? null, encerramento: o.encerramento ?? null };
        }
      } catch (_) { anterior = null; }
    }
    await dbAtual.query(
      `INSERT INTO sentinel_conciliacao_controle (chave, pausado_ate, ocorrencias, motivo, atualizado_em)
       VALUES ($1, NULL, 1, $2, $3::timestamptz)
       ON CONFLICT (chave) DO UPDATE SET pausado_ate = NULL, ocorrencias = sentinel_conciliacao_controle.ocorrencias + 1,
         motivo = EXCLUDED.motivo, atualizado_em = EXCLUDED.atualizado_em`,
      [CHAVE_PROCESSO, motivo(extra), iso(agora())]);
    assumiu = true;
  };
  const boot = () => {
    iniciadoEm = iso(agora());
    return enfileirar(() => assumir());
  };
  // Depois de assumir: UPDATE condicionado à posse (a instância antiga para de escrever assim que a nova assume).
  // `anterior` é PRESERVADO do banco (fixado no boot; só o dono antigo o completa com o próprio encerramento limpo).
  const atualizar = (extra, { podeAssumir = true, marcarAnteriorLimpo = false } = {}) => enfileirar(async () => {
    if (!assumiu) { if (podeAssumir) await assumir(extra); return; }
    const r = await dbAtual.query(
      `UPDATE sentinel_conciliacao_controle
          SET motivo = jsonb_set($2::jsonb, '{anterior}', COALESCE(motivo::jsonb -> 'anterior', 'null'::jsonb))::text,
              atualizado_em = $3::timestamptz
        WHERE chave = $1 AND (CASE WHEN chave = $1 THEN motivo::jsonb ->> 'instancia' END) = $4`,
      [CHAVE_PROCESSO, motivo(extra), iso(agora()), identidade.instancia]);
    // Sobreposição de deploy: a instância NOVA já assumiu a linha. Encerramento limpo da antiga vai para `anterior` da
    // nova (senão todo restart com o mesmo commit — troca de env var, por exemplo — pareceria "reinício inesperado").
    if (marcarAnteriorLimpo && (r?.rowCount ?? 0) === 0) {
      await dbAtual.query(
        `UPDATE sentinel_conciliacao_controle
            SET motivo = jsonb_set(jsonb_set(motivo::jsonb, '{anterior,encerramento}', '"limpo"'),
                                   '{anterior,encerradoEm}', to_jsonb($3::text))::text
          WHERE chave = $1 AND (CASE WHEN chave = $1 THEN motivo::jsonb #>> '{anterior,instancia}' END) = $2`,
        [CHAVE_PROCESSO, identidade.instancia, iso(agora())]);
    }
  });
  return {
    boot,
    gravar: () => (encerrado ? fila : atualizar()),
    // periódico: só se nada foi gravado na última metade do intervalo
    periodico: (heartbeatMs) => (encerrado || agora() - ultimaEscritaMs < heartbeatMs / 2 ? fila : atualizar()),
    encerrar: () => {
      if (encerrado) return fila;
      encerrado = true;
      // nunca assumiu (banco fora o tempo todo) ⇒ não rouba a linha de uma instância mais nova no encerramento
      return atualizar({ encerradoEm: iso(agora()), encerramento: "limpo" }, { podeAssumir: false, marcarAnteriorLimpo: true });
    },
    aguardar: () => fila,
    get schemaOk() { return schemaOk; },
    get escritas() { return escritas; },
    get falhas() { return falhas; },
  };
}

// ── agendador do Billing ────────────────────────────────────────────────────────────────────────────
// deps: { db (pool PRÓPRIO do Billing), cfg (configAgenda), instancia, agora, timers {setTimeout, clearTimeout}, logger,
//         executar (padrão executarColeta), depsColeta (mlFetchBase, resolverConta, criarClient, config… — teste),
//         pollingEmCurso() → Promise|null, aoTerminar(resumoExecucao) }
function criarAgendadorBilling(deps) {
  const { db, cfg } = deps;
  const agora = deps.agora || Date.now;
  const timers = deps.timers || { setTimeout, clearTimeout };
  const logger = deps.logger || console;
  const executar = deps.executar || executarColeta;
  const pollingEmCurso = deps.pollingEmCurso || (() => null);
  const aviso = typeof logger.warn === "function" ? logger.warn.bind(logger) : logger.log.bind(logger);
  let timer = null;
  let parando = false;
  let emCurso = null;      // Promise da execução (ou da verificação) corrente
  let pisoLocalMs = 0;     // não executa de novo antes disto NESTE processo (defesa se a agenda não pôde ser gravada)
  let acordarEspera = null;
  const estado = { emExecucao: false, ultimaVerificacaoEm: null, ultimaExecucao: null };

  const dormir = (ms) => {
    if (parando) return;
    if (timer) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      const p = ciclo().catch((err) => { aviso(`[sentinel-op] agendador do Billing: erro inesperado (${sanitizar(err && err.message, 120)})`); dormir(cfg.erroRetryMs); });
      emCurso = p;
      p.finally(() => { if (emCurso === p) emCurso = null; });
    }, Math.max(0, ms));
  };
  const limitar = (ms) => Math.min(SONO_TETO_MS, Math.max(SONO_PISO_MS, ms));

  // Quanto dormir até a próxima verificação (agenda lida FORA do lock — só para dormir).
  const calcularSono = async () => {
    let alvo = pisoLocalMs;
    try {
      const a = await lerAgenda(db);
      if (a.pausadoAteMs !== null) alvo = Math.max(alvo, a.pausadoAteMs);
    } catch (err) {
      if (err && err.code === "42P01") return cfg.intervaloMs; // sem a 20261119: o coletor nem chamaria o ML
      return cfg.erroRetryMs;
    }
    return Math.max(0, alvo - agora());
  };

  // Espera o ciclo de polling deste processo (até adiarMaxMs). Interrompida por parar().
  const esperarPolling = async () => {
    const p = pollingEmCurso();
    if (!p || cfg.adiarMaxMs <= 0) return { esperouMs: 0, excedeu: false };
    const t0 = agora();
    let excedeu = false;
    let t = null;
    await Promise.race([
      Promise.resolve(p).catch(() => {}),
      new Promise((r) => { t = timers.setTimeout(() => { excedeu = true; r(); }, cfg.adiarMaxMs); }),
      new Promise((r) => { acordarEspera = r; }),
    ]);
    if (t) timers.clearTimeout(t);
    acordarEspera = null;
    return { esperouMs: agora() - t0, excedeu };
  };

  const ciclo = async () => {
    if (parando) return;
    estado.ultimaVerificacaoEm = iso(agora());
    // fora do lock: só decide se vale a pena tentar agora (a decisão real é dentro do lock)
    const espera = await calcularSono();
    if (espera > 0) { dormir(limitar(espera)); return; }
    const adiamento = await esperarPolling();
    if (parando) return;
    const inicioMs = agora();
    const execucaoId = novoExecucaoId(inicioMs);
    const gancho = criarGanchoAgenda({ intervaloMs: cfg.intervaloMs, instancia: deps.instancia, execucaoId, agora });
    estado.emExecucao = true;
    let r = null;
    let erro = null;
    const t0 = agora();
    try {
      r = await executar({
        ...(deps.depsColeta || {}), db, contaIds: cfg.contas, deveParar: () => parando, agenda: gancho, agora, agoraMs: inicioMs,
      });
    } catch (err) {
      erro = err;
    }
    estado.emExecucao = false;
    const duracaoMs = agora() - t0;
    const resumo = resumirExecucao({ r, erro, execucaoId, inicioMs, duracaoMs, adiamento });
    estado.ultimaExecucao = resumo;
    logExecucao(resumo);
    if (typeof deps.aoTerminar === "function") {
      try { await deps.aoTerminar(resumo); } catch (_) { /* heartbeat nunca derruba o Billing */ }
    }
    if (parando) return;
    // próxima tentativa
    if (erro) { dormir(cfg.erroRetryMs); return; }
    if (r.motivo === "lock_ocupado") { dormir(cfg.lockOcupadoRetryMs); return; }
    // a agenda persistida é a fonte; o piso local só cobre o caso em que ela NÃO pôde ser gravada (banco caiu no fim)
    if ((r.executado || r.motivo === "pausa_429") && !gancho.registrou) pisoLocalMs = agora() + cfg.intervaloMs;
    // sem schema/contas: nada foi chamado; reverifica em ≤ 30 min (a migration pode ser aplicada com o worker no ar)
    if (["schema_ausente", "sem_contas", "sem_contas_ativas"].includes(r.motivo)) { dormir(limitar(cfg.intervaloMs)); return; }
    const prox = await calcularSono();
    dormir(limitar(prox));
  };

  const resumirExecucao = ({ r, erro, execucaoId, inicioMs, duracaoMs, adiamento }) => {
    const resultado = erro ? "erro" : r.executado ? r.resultado : r.motivo;
    return {
      tarefa: "billing", execucao: execucaoId, inicio: iso(inicioMs), duracaoMs,
      chamadas: r?.chamadas ?? 0,
      pedidos: (r?.contas || []).reduce((s, c) => s + (c.candidatos || 0), 0),
      gravados: (r?.contas || []).reduce((s, c) => s + (c.gravados || 0), 0),
      resultado, parou429: r?.parou429 === true,
      adiadoMs: adiamento.esperouMs || 0, adiamentoExcedido: adiamento.excedeu === true,
      erro: erro ? codigoErro(`${erro.code || "ERRO"}`) : null,
      contas: (r?.contas || []).map((c) => ({ id: c.contaId, candidatos: c.candidatos ?? 0, chamadas: (c.chamadasBilling || 0) + (c.chamadasDescontos || 0),
        gravados: c.gravados ?? 0, falhas: c.falhas ?? 0, parada: c.parada ?? null, erro: c.erro ? codigoErro(c.erro) : null })),
    };
  };
  const logExecucao = (resumo) => {
    // Paradas ROTINEIRAS (orçamento/prazo de uma execução com fila) não são problema; o resto vai como warn.
    const rotineira = (p) => p === null || p === "orcamento" || p === "prazo";
    const problema = !["concluida", "nao_devida"].includes(resumo.resultado)
      || resumo.contas.some((c) => c.erro || !rotineira(c.parada));
    const linha = `[sentinel-op] ${JSON.stringify(resumo)}`;
    if (problema) aviso(linha); else logger.log(linha);
  };

  return {
    estado,
    iniciar() { dormir(0); },
    get emCurso() { return emCurso; },
    async parar() {
      parando = true;
      if (timer) { timers.clearTimeout(timer); timer = null; }
      if (acordarEspera) acordarEspera();
      if (emCurso) await emCurso.catch(() => {});
    },
  };
}

module.exports = {
  CHAVE_AGENDA,
  CHAVE_PROCESSO,
  MOTIVO_MAX,
  configAgenda,
  lerIds,
  sanitizar,
  codigoErro,
  serializarLimitado,
  identidadeProcesso,
  novoExecucaoId,
  lerAgenda,
  criarGanchoAgenda,
  criarHeartbeat,
  criarAgendadorBilling,
};
