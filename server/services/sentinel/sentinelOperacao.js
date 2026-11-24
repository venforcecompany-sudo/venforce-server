// server/services/sentinel/sentinelOperacao.js
//
// Leitura OPERACIONAL consolidada do Sentinel (S1.5): GET /sentinel/operacao. SOMENTE LEITURA.
// Responde, sem abrir o banco nem o Shell do Render: o worker está vivo? reiniciou sem deploy? o polling avança por
// conta? quando o Billing rodou e quando roda de novo? há pausa por 429? quanto da janela já foi conciliado e por que o
// resto não foi? o grant da conta está utilizável? — e (P2) SINAIS operacionais objetivos para avisos futuros.
//
// Contrato de origem: docs/sentinel/CONTRATO_S1_5_OPERACAO.md. As linhas `worker_processo`, `billing_agenda` e
// `billing_429` de sentinel_conciliacao_controle são GRAVADAS pelo worker; aqui só são LIDAS (campos em lista branca,
// textos sanitizados, nada é repassado cru).
//
// Garantias:
//   · nenhuma escrita: com pool (db.connect) tudo roda numa transação READ ONLY + REPEATABLE READ (fotografia
//     consistente) com statement_timeout local; sem pool (db só com query) as consultas são SELECTs simples;
//   · dados POR CONTA só das contas já autorizadas pela carteira (contaIds resolvidos no servidor pelo controller);
//     os blocos globais (worker, agenda do Billing, pausa 429) não têm dado de cliente — listas de contas publicadas
//     pelo worker são filtradas pela carteira;
//   · sem a migration 20261119 ⇒ `disponivel:false` e só o polling (por checkpoints) e os grants; nunca 500 por isso;
//   · ml_tokens: só status/datas/contadores (nunca access_token, refresh_token nem o TEXTO do erro de refresh);
//   · sinais ≠ incidentes: nada aqui lê/grava severidade de incidente nem fala em prejuízo (DIVERGENTE ≠ prejuízo).
//     `detectadoEm` é o instante da avaliação (a leitura não guarda estado); `dedupKey` é estável entre avaliações.
//
// Formato (resposta: { ok:true, operacao }):
//   operacao = {
//     versao: 1, geradoEm, disponivel, motivo?, efeitoNaMargem:"nenhum", alertasFinanceiros:"desligados",
//     config:   { janelaDias, maturidadeHoras, janelaReconsultaDias, limiteLeituraMin, ...limiares dos sinais },
//     worker:   { estado: vivo|atrasado|parado|sem_dados, fonte, instancia, commit, iniciadoEm, heartbeatEm,
//                 idadeSegundos, intervaloEsperadoSegundos, limiteSegundos, boots, encerramento, encerradoEm,
//                 reinicioInesperado: true|false|null, anterior, memoria, polling:{publicado}, billing:{publicado} },
//     polling:  { porCheckpoint:{estado,...} (resumoOperacional), contagem, checkpointIdadeMaxSegundos, ultimaColetaOkEm },
//     billing:  { habilitado, emExecucao, intervaloMs, ultimaExecucao, proximaExecucaoEm, falhasSeguidas,
//                 agendaAtualizadaEm, pausa429:{ ate, ativa, ocorrencias, motivo, atualizadoEm } } | null,
//     cobertura:{ totais das contas (mesmos campos de contas[].cobertura) } | null,
//     contas:   [{ contaId, clienteId, clienteNome, contaNome, squad, ativo,
//                  polling:{ monitorada, situacao, atrasoSegundos, checkpoint, ultimaExecucaoEm, ultimoErro,
//                            pedidosUltimoCiclo, ciclosSemProgresso, quarentena, retentando, quarentenaDesde, leituraSeveridade },
//                  cobertura:{ monitorados30d, elegiveis, consultados, semConsulta, desatualizados, porEstado, porStatusColeta,
//                              naoConciliadoEscopo, naoConciliadoTransitorio, naoConciliadoBloqueio, documentosProvisorios,
//                              documentosProvisoriosAntigos, reconsultasVencidas, reconsultasVencidasAntigas,
//                              reconsultasForaDaJanela, sairamDaJanelaSemConsulta7d, falhasColeta, custoAusente,
//                              motivosTop:[{motivo,categoria,transitorio,n}], ultimaConciliacaoEm, proximaReconsultaEm } | null,
//                  grant:{ situacao: ok|atencao|indisponivel|desconhecido, motivo, refreshFalhas, ultimaFalhaRefreshEm,
//                          proximaTentativaRefreshEm, expiraEm } }],
//     sinais:   [{ tipo, contaId|null, severidade, estado:"ativo", motivo, evidencia, detectadoEm, dedupKey, proximaAcao }],
//   }
//
// Custo: 7 consultas próprias, todas agregadas por conta (GROUP BY, sem N+1) e limitadas às contas da carteira + as do
// motor existente (saudeContas/resumoOperacional — o mesmo custo da rota /sentinel/saude).

const { conciliacaoSchemaPronto } = require("./sentinelSchema");
const { CATEGORIA_MOTIVO, MOTIVOS_TRANSITORIOS } = require("./sentinelConciliacaoComissao");
const { ELEGIBILIDADE_SQL, MOTIVO_COLETA_FALHOU, CHAVE_PAUSA_429 } = require("./sentinelConciliacaoRepositorio");

const VERSAO = 1;
const HORA_MS = 3600 * 1000;
const DIA_MS = 24 * HORA_MS;
const CHAVE_WORKER = "worker_processo";
const CHAVE_AGENDA = "billing_agenda";
const ESTADOS = Object.freeze(["TARIFA_LIQUIDA_COMPROVADA", "TARIFA_BRUTA_COMPROVADA", "DIVERGENTE", "NAO_CONCILIADO"]);
const STATUS_COLETA = Object.freeze(["concluida", "reconsultar", "falha", "esgotada"]);
const SEVERIDADES = Object.freeze(["critica", "alta", "media", "info"]);
const GRANT_PERMANENTE = new Set(["revoked", "blocked", "invalid"]); // mesma lista de mlTokenService (PERMANENT_STATUSES)
const GRANT_JANELA_RENOVACAO_MS = 5 * 60 * 1000; // REFRESH_WINDOW_MS de mlTokenService

// Motivos de NAO_CONCILIADO que podem sumir numa nova coleta (o coletor reconsulta) + falha de coleta.
const TRANSITORIOS = Object.freeze([...MOTIVOS_TRANSITORIOS, MOTIVO_COLETA_FALHOU]);
// NAO_CONCILIADO só por ESCOPO (cenário não validado, estável para o mesmo pedido): todos os motivos são escopo/aviso.
const ESCOPO_OU_AVISO = Object.freeze(Object.entries(CATEGORIA_MOTIVO).filter(([, c]) => c === "escopo" || c === "aviso").map(([m]) => m));

// ── utilitários ────────────────────────────────────────────────────────────────────────────────────
// Textos GLOBAIS (worker/pausa 429) são vistos por qualquer usuário interno, inclusive fora da carteira: tira o id da conta
// ("conta 41: X" → "conta: X"). O detalhe por conta só aparece em contas[] / billing.ultimaExecucao.contas filtrados.
function semIdConta(t) {
  return t === null || t === undefined ? t : String(t).replace(/\bconta\s+\d+/gi, "conta");
}

function inteiro(v, padrao, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, n));
}
const msDe = (d) => {
  if (d === null || d === undefined || d === "") return null;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
};
const isoDe = (d) => { const t = msDe(d); return t === null ? null : new Date(t).toISOString(); };
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const int0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const bool = (v) => (v === true ? true : v === false ? false : null);
const ids = (arr) => (Array.isArray(arr) ? arr.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

// Texto vindo do worker/ML: sem credencial/URL e curto (reaproveita a regra do motor; carregada sob demanda).
function sanitizar(v) {
  if (v === null || v === undefined || v === "") return null;
  return require("./sentinelIncidentes").sanitizarErro(typeof v === "string" ? v : JSON.stringify(v));
}
const texto = (v, max = 80) => (typeof v === "string" && v ? sanitizar(v.slice(0, max)) : null);

function lerJson(s) {
  if (s === null || s === undefined) return null;
  if (typeof s === "object") return s;
  try {
    const o = JSON.parse(String(s));
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch (_) {
    return null;
  }
}

// ── configuração ───────────────────────────────────────────────────────────────────────────────────
// Janela/maturidade: FONTE ÚNICA configConciliacao (o coletor) — carregada sob demanda. Limiares dos sinais por env
// (todos com padrão; só ajustar se a operação pedir).
function configOperacao(env = process.env) {
  const { configConciliacao } = require("./sentinelConciliacaoColetor");
  const { configIncidentes } = require("./sentinelIncidentes");
  const cc = configConciliacao(env);
  const ci = configIncidentes(env);
  const janelaDias = cc.janelaDias;
  // Janela de RECONSULTA (pedidos já consultados): a do coletor se ele a expuser; senão o env/padrão do contrato S1.5.
  const janelaReconsultaDias = Math.max(janelaDias, Number.isInteger(cc.janelaReconsultaDias)
    ? cc.janelaReconsultaDias : inteiro(env.SENTINEL_CONCILIACAO_JANELA_RECONSULTA_DIAS, 60, 1, 365));
  const heartbeatMs = Math.max(60000, inteiro(env.SENTINEL_HEARTBEAT_MS, 180000, 60000, 24 * HORA_MS));
  return {
    janelaDias,
    maturidadeHoras: cc.maturidadeHoras,
    janelaReconsultaDias,
    limiteLeituraMin: ci.leituraLimiteMin,
    heartbeatMs,
    pollIntervalMs: inteiro(env.SENTINEL_POLL_INTERVAL_MS, 180000, 1000, 24 * HORA_MS),
    cicloMaxMs: inteiro(env.SENTINEL_CICLO_MAX_MS, 300000, 1000, 24 * HORA_MS),
    billingIntervaloPadraoMs: inteiro(env.SENTINEL_CONCILIACAO_INTERVAL_MS, 6 * HORA_MS, 10 * 60000, 7 * DIA_MS),
    // ── limiares dos sinais (documentados em avaliarSinais) ──
    semProgressoCiclos: inteiro(env.SENTINEL_ALERTA_SEM_PROGRESSO_CICLOS, 3, 1, 1000),
    pollingFalhasSeguidas: inteiro(env.SENTINEL_ALERTA_POLLING_FALHAS, 3, 1, 1000),
    billingFalhasSeguidas: inteiro(env.SENTINEL_ALERTA_BILLING_FALHAS, 2, 1, 1000),
    billingAtrasoMaxMs: inteiro(env.SENTINEL_ALERTA_BILLING_ATRASO_MIN, 60, 1, 7 * 24 * 60) * 60000,
    reconsultaAtrasoHoras: inteiro(env.SENTINEL_ALERTA_RECONSULTA_ATRASO_HORAS, 24, 1, 24 * 60),
    docProvisorioDias: inteiro(env.SENTINEL_ALERTA_DOC_PROVISORIO_DIAS, 45, 1, 365),
    reinicioJanelaHoras: inteiro(env.SENTINEL_ALERTA_REINICIO_HORAS, 24, 1, 24 * 30),
    statementTimeoutMs: inteiro(env.SENTINEL_OPERACAO_STATEMENT_TIMEOUT_MS, 5000, 500, 60000),
  };
}

// ── worker (worker_processo) — PURO ───────────────────────────────────────────────────────────────
function lerWorker(linha, { agoraMs, cfg, contaIds }) {
  const permitidas = new Set(ids(contaIds));
  const filtrar = (lista) => ids(lista).filter((id) => permitidas.has(id));
  const m = linha ? lerJson(linha.motivo) : null;
  const vazio = {
    estado: "sem_dados", fonte: "sem_heartbeat", instancia: null, commit: null, iniciadoEm: null, heartbeatEm: null,
    idadeSegundos: null, intervaloEsperadoSegundos: null, limiteSegundos: cfg.limiteLeituraMin * 60, boots: linha ? int0(linha.ocorrencias) : 0,
    encerramento: null, encerradoEm: null, reinicioInesperado: null, anterior: null, memoria: null, polling: null, billing: null,
  };
  if (!m) return vazio;
  const p = m.polling && typeof m.polling === "object" ? m.polling : null;
  const b = m.billing && typeof m.billing === "object" ? m.billing : null;
  const a = m.anterior && typeof m.anterior === "object" ? m.anterior : null;
  // Idade do heartbeat: `atualizado_em` (o contrato define como "último heartbeat"); o ISO do JSON é o reserva.
  const hbMs = msDe(linha.atualizado_em) ?? msDe(m.heartbeatEm);
  const intervaloPolling = num(p && p.intervaloMs) || cfg.pollIntervalMs;
  // Heartbeat esperado: o maior entre o timer e um ciclo de polling completo (intervalo + teto do ciclo).
  const esperadoMs = Math.max(cfg.heartbeatMs, intervaloPolling + cfg.cicloMaxMs);
  const limiteMs = cfg.limiteLeituraMin * 60000;
  const idadeMs = hbMs === null ? null : Math.max(0, agoraMs - hbMs);
  let estado = "sem_dados";
  if (idadeMs !== null) estado = idadeMs <= 2 * esperadoMs ? "vivo" : idadeMs <= limiteMs ? "atrasado" : "parado";
  const commit = texto(m.commit, 40);
  const commitAnterior = a ? texto(a.commit, 40) : null;
  // Heurística do contrato (§2): mesmo commit do dono anterior e o anterior sem encerramento limpo ⇒ reinício sem
  // deploy (crash/OOM). Commit desconhecido (null) ⇒ não dá para afirmar (null).
  let reinicioInesperado = null;
  if (a && commit && commitAnterior) reinicioInesperado = commit === commitAnterior && a.encerramento !== "limpo";
  return {
    estado,
    fonte: "heartbeat",
    instancia: texto(m.instancia, 80),
    commit,
    iniciadoEm: isoDe(m.iniciadoEm),
    heartbeatEm: hbMs === null ? null : new Date(hbMs).toISOString(),
    idadeSegundos: idadeMs === null ? null : Math.round(idadeMs / 1000),
    intervaloEsperadoSegundos: Math.round(esperadoMs / 1000),
    limiteSegundos: Math.round(limiteMs / 1000),
    boots: int0(linha.ocorrencias),
    encerramento: m.encerramento === "limpo" ? "limpo" : null,
    encerradoEm: isoDe(m.encerradoEm),
    reinicioInesperado,
    anterior: a ? { instancia: texto(a.instancia, 80), commit: commitAnterior, heartbeatEm: isoDe(a.heartbeatEm), encerramento: a.encerramento === "limpo" ? "limpo" : null } : null,
    memoria: m.memoria && typeof m.memoria === "object" ? { rssMb: num(m.memoria.rssMb), heapUsedMb: num(m.memoria.heapUsedMb) } : null,
    polling: p ? {
      habilitado: bool(p.habilitado), contas: filtrar(p.contas), totalContas: ids(p.contas).length, intervaloMs: num(p.intervaloMs),
      ultimoCicloEm: isoDe(p.ultimoCicloEm), ultimoCicloMs: num(p.ultimoCicloMs), ultimoCicloPedidos: num(p.ultimoCicloPedidos),
      ultimoCicloEstado: texto(p.ultimoCicloEstado, 20), ultimoCicloErro: semIdConta(sanitizar(p.ultimoCicloErro)),
      falhasSeguidas: int0(p.falhasSeguidas), falhaBoot: sanitizar(p.falhaBoot),
    } : null,
    billing: b ? {
      habilitado: bool(b.habilitado), contas: filtrar(b.contas), totalContas: ids(b.contas).length, intervaloMs: num(b.intervaloMs),
      emExecucao: bool(b.emExecucao), ultimaVerificacaoEm: isoDe(b.ultimaVerificacaoEm),
    } : null,
  };
}

// ── Billing (billing_agenda + billing_429) — PURO ─────────────────────────────────────────────────
function lerBilling(agenda, pausa, worker, { agoraMs, cfg, contaIds }) {
  const permitidas = new Set(ids(contaIds));
  const m = agenda ? lerJson(agenda.motivo) : null;
  const wb = worker && worker.billing;
  let ultimaExecucao = null;
  if (m) {
    const contas = (Array.isArray(m.contas) ? m.contas : [])
      .filter((c) => c && permitidas.has(Number(c.contaId)))
      .map((c) => ({
        contaId: Number(c.contaId), candidatos: int0(c.candidatos), chamadasBilling: int0(c.chamadasBilling),
        chamadasDescontos: int0(c.chamadasDescontos), gravados: int0(c.gravados), falhas: int0(c.falhas), parada: texto(c.parada, 40),
      }));
    ultimaExecucao = {
      execucaoId: texto(m.execucaoId, 40), inicioEm: isoDe(m.inicioEm), fimEm: isoDe(m.fimEm), duracaoMs: num(m.duracaoMs),
      resultado: texto(m.resultado, 30), chamadas: int0(m.chamadas), gravados: int0(m.gravados), parou429: m.parou429 === true,
      erro: sanitizar(m.erro), contas, totalContas: Array.isArray(m.contas) ? m.contas.length : 0,
    };
  }
  const ate = pausa ? msDe(pausa.pausado_ate) : null;
  return {
    habilitado: wb ? wb.habilitado : null,
    emExecucao: wb ? wb.emExecucao : null,
    intervaloMs: num(m && m.intervaloMs) || (wb && wb.intervaloMs) || null,
    ultimaExecucao,
    proximaExecucaoEm: agenda ? isoDe(agenda.pausado_ate) : null,
    falhasSeguidas: agenda ? int0(agenda.ocorrencias) : 0,
    agendaAtualizadaEm: agenda ? isoDe(agenda.atualizado_em) : null,
    pausa429: pausa ? {
      ate: ate === null ? null : new Date(ate).toISOString(), ativa: ate !== null && ate > agoraMs,
      ocorrencias: int0(pausa.ocorrencias), motivo: semIdConta(sanitizar(pausa.motivo)), atualizadoEm: isoDe(pausa.atualizado_em),
    } : null,
    intervaloPadraoMs: cfg.billingIntervaloPadraoMs,
  };
}

// ── grant da conta (ml_tokens) — PURO ─────────────────────────────────────────────────────────────
// Mesma semântica do runtime (mlTokenService.isGrantUsable + Sentinel sempre noRefresh):
//   indisponivel — sem grant atual, status permanente (revoked/blocked/invalid) ou expirado (o Sentinel não renova);
//   atencao      — status 'error', falhas de renovação > 0 ou renovação adiada com o grant perto de expirar;
//   ok           — demais; desconhecido — leitura de ml_tokens indisponível.
function avaliarGrant(g, agoraMs, { semSeller = false } = {}) {
  if (g === undefined) return { situacao: "desconhecido", motivo: "leitura_indisponivel", refreshFalhas: null, ultimaFalhaRefreshEm: null, proximaTentativaRefreshEm: null, expiraEm: null };
  if (semSeller) return { situacao: "indisponivel", motivo: "conta_sem_seller", refreshFalhas: null, ultimaFalhaRefreshEm: null, proximaTentativaRefreshEm: null, expiraEm: null };
  if (!g) return { situacao: "indisponivel", motivo: "sem_grant", refreshFalhas: null, ultimaFalhaRefreshEm: null, proximaTentativaRefreshEm: null, expiraEm: null };
  const status = String(g.token_status || "valid").trim().toLowerCase();
  const expira = msDe(g.expires_at);
  const proxima = msDe(g.next_refresh_attempt_at);
  const falhas = int0(g.refresh_failures);
  const base = { refreshFalhas: falhas, ultimaFalhaRefreshEm: isoDe(g.last_refresh_error_at), proximaTentativaRefreshEm: isoDe(g.next_refresh_attempt_at), expiraEm: isoDe(g.expires_at) };
  if (GRANT_PERMANENTE.has(status)) return { situacao: "indisponivel", motivo: `status_${status}`, ...base };
  if (expira === null || expira <= agoraMs) return { situacao: "indisponivel", motivo: "expirado", ...base };
  if (status === "error") return { situacao: "atencao", motivo: "status_error", ...base };
  if (falhas > 0) return { situacao: "atencao", motivo: "falhas_de_renovacao", ...base };
  if (expira - agoraMs <= GRANT_JANELA_RENOVACAO_MS && proxima !== null && proxima > agoraMs) return { situacao: "atencao", motivo: "renovacao_adiada", ...base };
  return { situacao: "ok", motivo: null, ...base };
}

// ── SQL (todas SELECT; agregadas por conta) ────────────────────────────────────────────────────────
// Parâmetros comuns: $1 contas int[], $2 agora, $3 janelaDias, $4 maturidadeHoras.
const NA_JANELA = `p.data_pedido >= $2::timestamptz - make_interval(days => $3::int)
            AND p.data_pedido <= $2::timestamptz - make_interval(hours => $4::int)`;

const SQL_COBERTURA_PEDIDOS = `/* sentinel:OPERACAO_COBERTURA_PEDIDOS */
  SELECT p.cliente_conta_id AS conta_id,
         COUNT(*) FILTER (WHERE p.data_pedido >= $2::timestamptz - make_interval(days => $3::int))::int AS monitorados,
         COUNT(*) FILTER (WHERE f.elegivel AND f.na_janela)::int AS elegiveis,
         COUNT(*) FILTER (WHERE f.elegivel AND f.na_janela AND c.pedido_id IS NOT NULL)::int AS consultados,
         COUNT(*) FILTER (WHERE f.elegivel AND f.na_janela AND c.pedido_id IS NOT NULL
                            AND c.pedido_payload_hash IS DISTINCT FROM p.payload_hash)::int AS desatualizados,
         COUNT(*) FILTER (WHERE f.elegivel AND c.pedido_id IS NULL
                            AND p.data_pedido < $2::timestamptz - make_interval(days => $3::int)
                            AND p.data_pedido >= $2::timestamptz - make_interval(days => $3::int + 7))::int AS sairam7d,
         COUNT(*) FILTER (WHERE p.data_pedido >= $2::timestamptz - make_interval(days => $3::int) AND p.status_ml = 'paid'
                            AND p.estado_margem IN ('sem_custo', 'custo_ambiguo'))::int AS custo_ausente
    FROM sentinel_pedidos p
    LEFT JOIN sentinel_conciliacao_comissao c ON c.cliente_conta_id = p.cliente_conta_id AND c.pedido_id = p.pedido_id
    CROSS JOIN LATERAL (SELECT (${ELEGIBILIDADE_SQL}) AS elegivel, (${NA_JANELA}) AS na_janela) f
   WHERE p.cliente_conta_id = ANY($1::int[])
     AND p.data_pedido >= $2::timestamptz - make_interval(days => $3::int + 7)
   GROUP BY 1`;

// $5 janelaReconsultaDias, $6 transitórios text[], $7 escopo/aviso text[], $8 docProvisorioDias, $9 reconsultaAtrasoHoras
const VENCIDA = `((c.status_coleta IN ('reconsultar', 'falha') AND (c.proxima_tentativa_em IS NULL OR c.proxima_tentativa_em <= $2::timestamptz))
                OR (c.status_coleta = 'esgotada' AND c.proxima_tentativa_em <= $2::timestamptz))`;
// Mesmo critério da seleção do coletor (montarSelecionarSql): reconsulta só de pedido ainda elegível e dentro da janela
// de reconsulta.
const NA_JANELA_RECONSULTA = `p.data_pedido >= $2::timestamptz - make_interval(days => $5::int)`;
const SQL_COBERTURA_CONCILIACOES = `/* sentinel:OPERACAO_COBERTURA_CONCILIACOES */
  SELECT c.cliente_conta_id AS conta_id, c.estado, c.status_coleta, (${NA_JANELA}) AS na_janela,
         COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE c.documento IS NOT NULL AND NOT c.documento_definitivo)::int AS doc_provisorio,
         COUNT(*) FILTER (WHERE c.documento IS NOT NULL AND NOT c.documento_definitivo
                            AND p.data_pedido < $2::timestamptz - make_interval(days => $8::int))::int AS doc_provisorio_antigo,
         COUNT(*) FILTER (WHERE ${VENCIDA} AND ${NA_JANELA_RECONSULTA} AND f.elegivel)::int AS vencidas,
         COUNT(*) FILTER (WHERE ${VENCIDA} AND ${NA_JANELA_RECONSULTA} AND f.elegivel
                            AND COALESCE(c.proxima_tentativa_em, c.atualizado_em) < $2::timestamptz - make_interval(hours => $9::int))::int AS vencidas_antigas,
         COUNT(*) FILTER (WHERE c.status_coleta IN ('reconsultar', 'falha', 'esgotada') AND NOT (${NA_JANELA_RECONSULTA}))::int AS fora_janela,
         COUNT(*) FILTER (WHERE c.falhas_consecutivas > 0)::int AS com_falha,
         COUNT(*) FILTER (WHERE c.estado = 'NAO_CONCILIADO' AND c.motivos && $6::text[])::int AS nc_transitorio,
         COUNT(*) FILTER (WHERE c.estado = 'NAO_CONCILIADO' AND NOT (c.motivos && $6::text[]) AND c.motivos <@ $7::text[])::int AS nc_escopo,
         MAX(c.observado_em) AS ultima_obs,
         MIN(c.proxima_tentativa_em) FILTER (WHERE c.status_coleta <> 'concluida' AND ${NA_JANELA_RECONSULTA}) AS proxima_reconsulta
    FROM sentinel_conciliacao_comissao c
    JOIN sentinel_pedidos p ON p.cliente_conta_id = c.cliente_conta_id AND p.pedido_id = c.pedido_id
    CROSS JOIN LATERAL (SELECT (${ELEGIBILIDADE_SQL}) AS elegivel) f
   WHERE c.cliente_conta_id = ANY($1::int[])
   GROUP BY 1, 2, 3, 4`;

const SQL_MOTIVOS = `/* sentinel:OPERACAO_MOTIVOS */
  SELECT c.cliente_conta_id AS conta_id, m.motivo, COUNT(*)::int AS n
    FROM sentinel_conciliacao_comissao c
    JOIN sentinel_pedidos p ON p.cliente_conta_id = c.cliente_conta_id AND p.pedido_id = c.pedido_id
    CROSS JOIN LATERAL unnest(c.motivos) AS m(motivo)
   WHERE c.cliente_conta_id = ANY($1::int[]) AND ${NA_JANELA}
   GROUP BY 1, 2`;

const SQL_CHECKPOINTS_EXCECOES = `/* sentinel:OPERACAO_CHECKPOINTS */
  SELECT x.id AS conta_id, ck.ciclos_sem_progresso, ck.pedidos_processados_ultima,
         COALESCE(e.quarentena, 0)::int AS quarentena, COALESCE(e.retentando, 0)::int AS retentando, e.quarentena_desde
    FROM unnest($1::int[]) AS x(id)
    LEFT JOIN sentinel_checkpoints ck ON ck.cliente_conta_id = x.id
    LEFT JOIN (
      SELECT cliente_conta_id,
             COUNT(*) FILTER (WHERE status = 'quarentena') AS quarentena,
             COUNT(*) FILTER (WHERE status = 'retentando') AS retentando,
             MIN(primeiro_erro_em) FILTER (WHERE status = 'quarentena') AS quarentena_desde
        FROM sentinel_pedido_excecoes
       WHERE cliente_conta_id = ANY($1::int[]) AND status <> 'resolvido'
       GROUP BY 1
    ) e ON e.cliente_conta_id = x.id`;

const SQL_CONTROLE = `/* sentinel:OPERACAO_CONTROLE */
  SELECT chave, pausado_ate, ocorrencias, motivo, atualizado_em
    FROM sentinel_conciliacao_controle WHERE chave = ANY($1::text[])`;

// Grant ATUAL da conta pela mesma chave do runtime (mlTokenService.resolveMlGrant: cliente + ml_user_id = seller da
// conta, não substituído). Só colunas de status — nunca tokens nem o texto do erro.
const SQL_GRANTS = `/* sentinel:OPERACAO_GRANTS */
  SELECT cc.id AS conta_id, (cc.external_account_id IS NULL) AS sem_seller, (t.existe IS NOT NULL) AS tem_grant,
         t.token_status, t.expires_at, t.refresh_failures, t.last_refresh_error_at, t.next_refresh_attempt_at
    FROM cliente_contas cc
    LEFT JOIN LATERAL (
      SELECT 1 AS existe, g.token_status, g.expires_at, g.refresh_failures, g.last_refresh_error_at, g.next_refresh_attempt_at
        FROM ml_tokens g
       WHERE g.cliente_id = cc.cliente_id AND g.ml_user_id::text = cc.external_account_id::text AND g.superseded_at IS NULL
       ORDER BY g.is_primary DESC NULLS LAST, g.updated_at DESC NULLS LAST, g.id DESC
       LIMIT 1
    ) t ON TRUE
   WHERE cc.id = ANY($1::int[])`;

// ── execução (uma conexão, READ ONLY) ─────────────────────────────────────────────────────────────
async function comLeitura(db, cfg, fn) {
  // Pool (connect → client com release): transação READ ONLY. pg.Client avulso ou fake (só query): consultas simples.
  const ehPool = db && typeof db.connect === "function" && typeof db.release !== "function" && !("connectionParameters" in db);
  if (!ehPool) return fn(db, { tentar: async (_n, f) => { try { return await f(); } catch (_) { return undefined; } } });
  const client = await db.connect();
  let aberta = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    aberta = true;
    await client.query(`SET LOCAL statement_timeout = ${Number(cfg.statementTimeoutMs) | 0}`);
    // Parte opcional (ex.: ml_tokens sem as colunas novas): falha isolada por SAVEPOINT, sem abortar a fotografia.
    const tentar = async (nome, f) => {
      await client.query(`SAVEPOINT ${nome}`);
      try {
        const r = await f();
        await client.query(`RELEASE SAVEPOINT ${nome}`);
        return r;
      } catch (_) {
        await client.query(`ROLLBACK TO SAVEPOINT ${nome}`);
        return undefined;
      }
    };
    const r = await fn(client, { tentar });
    await client.query("COMMIT");
    aberta = false;
    return r;
  } finally {
    if (aberta) await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

function coberturaVazia() {
  return {
    monitorados30d: 0, elegiveis: 0, consultados: 0, semConsulta: 0, desatualizados: 0,
    porEstado: Object.fromEntries(ESTADOS.map((e) => [e, 0])), porStatusColeta: Object.fromEntries(STATUS_COLETA.map((s) => [s, 0])),
    naoConciliadoEscopo: 0, naoConciliadoTransitorio: 0, naoConciliadoBloqueio: 0,
    documentosProvisorios: 0, documentosProvisoriosAntigos: 0, reconsultasVencidas: 0, reconsultasVencidasAntigas: 0,
    reconsultasForaDaJanela: 0, sairamDaJanelaSemConsulta7d: 0, falhasColeta: 0, custoAusente: 0,
    motivosTop: [], ultimaConciliacaoEm: null, proximaReconsultaEm: null,
  };
}
const categoriaMotivo = (m) => CATEGORIA_MOTIVO[m] || (m === MOTIVO_COLETA_FALHOU ? "coleta" : "outro");
const maxIso = (a, b) => { const x = msDe(a); const y = msDe(b); if (x === null) return y === null ? null : new Date(y).toISOString(); return new Date(y !== null && y > x ? y : x).toISOString(); };
const minIso = (a, b) => { const x = msDe(a); const y = msDe(b); if (x === null) return y === null ? null : new Date(y).toISOString(); return new Date(y !== null && y < x ? y : x).toISOString(); };

async function lerCobertura(q, contas, { agoraIso, cfg }) {
  const base = [contas, agoraIso, cfg.janelaDias, cfg.maturidadeHoras];
  // Sequencial de propósito: é UMA conexão (pg não aceita consultas simultâneas no mesmo client).
  const peds = await q(SQL_COBERTURA_PEDIDOS, base);
  const concs = await q(SQL_COBERTURA_CONCILIACOES, [...base, cfg.janelaReconsultaDias, TRANSITORIOS, ESCOPO_OU_AVISO, cfg.docProvisorioDias, cfg.reconsultaAtrasoHoras]);
  const mots = await q(SQL_MOTIVOS, base);
  const porConta = new Map(contas.map((id) => [id, coberturaVazia()]));
  for (const r of peds) {
    const c = porConta.get(Number(r.conta_id));
    if (!c) continue;
    c.monitorados30d = r.monitorados; c.elegiveis = r.elegiveis; c.consultados = r.consultados;
    c.semConsulta = Math.max(0, r.elegiveis - r.consultados); c.desatualizados = r.desatualizados;
    c.sairamDaJanelaSemConsulta7d = r.sairam7d; c.custoAusente = r.custo_ausente;
  }
  for (const r of concs) {
    const c = porConta.get(Number(r.conta_id));
    if (!c) continue;
    // Retrato da janela (porEstado/status/NAO_CONCILIADO): só pedidos na janela de 1ª consulta, para somar = consultados.
    if (r.na_janela) {
      c.porEstado[r.estado] = (c.porEstado[r.estado] || 0) + r.n;
      c.porStatusColeta[r.status_coleta] = (c.porStatusColeta[r.status_coleta] || 0) + r.n;
      if (r.estado === "NAO_CONCILIADO") {
        c.naoConciliadoTransitorio += r.nc_transitorio;
        c.naoConciliadoEscopo += r.nc_escopo;
        c.naoConciliadoBloqueio += r.n - r.nc_transitorio - r.nc_escopo;
      }
      c.documentosProvisorios += r.doc_provisorio;
    }
    // Fila e pendências: qualquer idade (é justamente o que sai da janela que precisa aparecer).
    c.documentosProvisoriosAntigos += r.doc_provisorio_antigo;
    c.reconsultasVencidas += r.vencidas;
    c.reconsultasVencidasAntigas += r.vencidas_antigas;
    c.reconsultasForaDaJanela += r.fora_janela;
    c.falhasColeta += r.com_falha;
    c.ultimaConciliacaoEm = maxIso(c.ultimaConciliacaoEm, r.ultima_obs);
    c.proximaReconsultaEm = minIso(c.proximaReconsultaEm, r.proxima_reconsulta);
  }
  const motivos = new Map();
  for (const r of mots) {
    const id = Number(r.conta_id);
    if (!porConta.has(id)) continue;
    if (!motivos.has(id)) motivos.set(id, []);
    motivos.get(id).push({ motivo: r.motivo, categoria: categoriaMotivo(r.motivo), transitorio: TRANSITORIOS.includes(r.motivo), n: r.n });
  }
  for (const [id, lista] of motivos) {
    porConta.get(id).motivosTop = lista.sort((a, b) => b.n - a.n || a.motivo.localeCompare(b.motivo)).slice(0, 10);
  }
  return porConta;
}

function somarCobertura(lista) {
  const t = coberturaVazia();
  const motivos = new Map();
  for (const c of lista) {
    for (const k of Object.keys(t)) {
      if (typeof t[k] === "number") t[k] += c[k] || 0;
    }
    for (const e of ESTADOS) t.porEstado[e] += c.porEstado[e] || 0;
    for (const s of STATUS_COLETA) t.porStatusColeta[s] += c.porStatusColeta[s] || 0;
    for (const m of c.motivosTop) motivos.set(m.motivo, { ...m, n: (motivos.get(m.motivo)?.n || 0) + m.n });
    t.ultimaConciliacaoEm = maxIso(t.ultimaConciliacaoEm, c.ultimaConciliacaoEm);
    t.proximaReconsultaEm = minIso(t.proximaReconsultaEm, c.proximaReconsultaEm);
  }
  t.motivosTop = [...motivos.values()].sort((a, b) => b.n - a.n || a.motivo.localeCompare(b.motivo)).slice(0, 10);
  return t;
}

// Severidade da leitura atrasada pela regra EXISTENTE (detectarLeituraAtrasada): null quando não está atrasada.
function severidadeLeitura(inc, s, agoraMs, cfgInc) {
  if (!s.monitorada || typeof inc.detectarLeituraAtrasada !== "function") return null;
  const cand = inc.detectarLeituraAtrasada({ ultimo_date_last_updated: s.checkpoint, ultima_execucao_em: s.ultimaExecucaoEm, ultimo_erro: s.ultimoErro }, agoraMs, cfgInc);
  return cand && cand[0] ? cand[0].severidade : null;
}

// Leitura consolidada. contaIds = carteira JÁ autorizada; contas = metadados da carteira (opcional).
async function lerOperacao(db, { contaIds, agora, env = process.env, incidentes, cfg: cfgExtra } = {}) {
  const inc = incidentes || require("./sentinelIncidentes");
  const cfg = { ...configOperacao(env), ...(cfgExtra || {}) };
  const agoraMs = agora !== undefined && agora !== null ? msDe(agora) : Date.now();
  const agoraIso = new Date(agoraMs).toISOString();
  const contas = [...new Set(ids(contaIds))];
  const cfgInc = inc.configIncidentes ? inc.configIncidentes(env) : { leituraLimiteMin: cfg.limiteLeituraMin };

  const snap = await comLeitura(db, cfg, async (conn, { tentar }) => {
    const q = async (sql, params) => (await conn.query(sql, params)).rows;
    const disponivel = await conciliacaoSchemaPronto(conn);
    // Polling por checkpoints: o motor EXISTENTE (mesma regra da rota /saude). Só os campos de leitura — incidentes e
    // cobertura financeira ficam de fora de propósito (sinal operacional ≠ incidente).
    const saude = contas.length ? await inc.saudeContas(conn, { contaIds: contas, agora: agoraMs, env }) : [];
    const resumo = contas.length ? await inc.resumoOperacional(conn, { contaIds: contas, agora: agoraMs, env }) : null;
    const extras = contas.length ? await q(SQL_CHECKPOINTS_EXCECOES, [contas]) : [];
    const grantsRows = contas.length ? await tentar("sp_grants", async () => {
      const ok = await q("SELECT to_regclass('public.ml_tokens') IS NOT NULL AS ok");
      if (!ok[0] || ok[0].ok !== true) throw new Error("ml_tokens ausente");
      return q(SQL_GRANTS, [contas]);
    }) : [];
    let controle = [];
    let cobertura = null;
    if (disponivel) {
      controle = await q(SQL_CONTROLE, [[CHAVE_WORKER, CHAVE_AGENDA, CHAVE_PAUSA_429]]);
      cobertura = contas.length ? await lerCobertura(q, contas, { agoraIso, cfg }) : new Map();
    }
    return { disponivel, saude, resumo, extras, grantsRows, controle, cobertura };
  });

  const ctrl = new Map(snap.controle.map((r) => [r.chave, r]));
  const worker = lerWorker(ctrl.get(CHAVE_WORKER) || null, { agoraMs, cfg, contaIds: contas });
  const billing = snap.disponivel ? lerBilling(ctrl.get(CHAVE_AGENDA) || null, ctrl.get(CHAVE_PAUSA_429) || null, worker, { agoraMs, cfg, contaIds: contas }) : null;
  const extras = new Map(snap.extras.map((r) => [Number(r.conta_id), r]));
  const grants = snap.grantsRows === undefined ? undefined : new Map(snap.grantsRows.map((r) => [Number(r.conta_id), r]));
  const permitidas = new Set(contas);

  const linhas = (snap.saude || []).filter((s) => permitidas.has(Number(s.contaId))).map((s) => {
    const id = Number(s.contaId);
    const x = extras.get(id) || {};
    const g = grants === undefined ? undefined : grants.get(id);
    return {
      contaId: id, clienteId: s.clienteId ?? null, clienteNome: s.clienteNome ?? null, contaNome: s.contaNome ?? null,
      squad: s.squad || null, ativo: s.ativo !== false,
      polling: {
        monitorada: s.monitorada === true, situacao: s.situacao, atrasoSegundos: s.atrasoSegundos ?? null,
        checkpoint: isoDe(s.checkpoint), ultimaExecucaoEm: isoDe(s.ultimaExecucaoEm), ultimoErro: s.ultimoErro || null,
        pedidosUltimoCiclo: num(x.pedidos_processados_ultima), ciclosSemProgresso: int0(x.ciclos_sem_progresso),
        quarentena: int0(x.quarentena), retentando: int0(x.retentando), quarentenaDesde: isoDe(x.quarentena_desde),
        leituraSeveridade: severidadeLeitura(inc, s, agoraMs, cfgInc),
      },
      cobertura: snap.cobertura ? snap.cobertura.get(id) || coberturaVazia() : null,
      grant: g === undefined ? avaliarGrant(undefined, agoraMs)
        : avaliarGrant(g && g.tem_grant ? g : null, agoraMs, { semSeller: !!(g && g.sem_seller) }),
    };
  });

  const r = snap.resumo;
  const polling = {
    porCheckpoint: r ? r.worker : { estado: "sem_dados", ultimaExecucaoEm: null, idadeSegundos: null, intervaloEsperadoSegundos: null },
    contagem: r ? {
      monitoradas: r.contas.monitoradas, ok: r.contas.ok, atrasadas: r.contas.atrasadas, erroGrant: r.contas.erroToken,
      erroApi: r.contas.erroApi, nuncaLidas: r.contas.nuncaLidas, semPedidosRecentes: r.contas.semPedidosRecentes,
    } : { monitoradas: 0, ok: 0, atrasadas: 0, erroGrant: 0, erroApi: 0, nuncaLidas: 0, semPedidosRecentes: 0 },
    checkpointIdadeMaxSegundos: r ? r.checkpointIdadeMaxSegundos : null,
    ultimaColetaOkEm: r ? r.ultimaColetaOkEm : null,
    limiteLeituraMin: r ? r.limiteLeituraMin : cfg.limiteLeituraMin,
  };

  const operacao = {
    versao: VERSAO,
    geradoEm: agoraIso,
    disponivel: snap.disponivel,
    ...(snap.disponivel ? {} : { motivo: "migration_20261119_nao_aplicada" }),
    efeitoNaMargem: "nenhum",
    alertasFinanceiros: "desligados",
    config: {
      janelaDias: cfg.janelaDias, maturidadeHoras: cfg.maturidadeHoras, janelaReconsultaDias: cfg.janelaReconsultaDias,
      limiteLeituraMin: cfg.limiteLeituraMin, semProgressoCiclos: cfg.semProgressoCiclos, pollingFalhasSeguidas: cfg.pollingFalhasSeguidas,
      billingFalhasSeguidas: cfg.billingFalhasSeguidas, billingAtrasoMaxMin: Math.round(cfg.billingAtrasoMaxMs / 60000),
      reconsultaAtrasoHoras: cfg.reconsultaAtrasoHoras, docProvisorioDias: cfg.docProvisorioDias, reinicioJanelaHoras: cfg.reinicioJanelaHoras,
    },
    worker,
    polling,
    billing,
    cobertura: snap.cobertura ? somarCobertura(linhas.map((l) => l.cobertura).filter(Boolean)) : null,
    contas: linhas,
  };
  operacao.sinais = avaliarSinais(operacao, { agoraMs, cfg, contaIds: contas });
  return operacao;
}

// ── SINAIS (P2) — função PURA ─────────────────────────────────────────────────────────────────────
// Critérios OBJETIVOS (limiares em cfg; padrões em configOperacao):
//   worker_sem_heartbeat     — heartbeat atrasado (> 2× intervalo esperado: media) ou parado (> limite de leitura:
//                              critica; alta se o último dono encerrou de forma limpa). Sem a linha (worker anterior ao
//                              S1.5): info — a saúde vem só dos checkpoints, nunca se finge "vivo".
//   polling_parado           — checkpoints da carteira sem execução (regra do resumoOperacional): atrasado=media,
//                              parado=critica (info se o heartbeat diz polling desligado); ou falhasSeguidas do polling
//                              ≥ pollingFalhasSeguidas (alta); ou falhaBoot publicada (alta).
//   conta_sem_progresso      — ciclos_sem_progresso ≥ semProgressoCiclos (alta) ou leitura atrasada pela regra existente
//                              (detectarLeituraAtrasada: alta/critica).
//   grant_indisponivel       — grant da conta indisponível (sem grant/expirado/revogado) em conta monitorada ou do Billing (alta).
//   pedidos_em_quarentena    — exceções em quarentena > 0 (media).
//   custo_ausente            — pedidos pagos sem_custo/custo_ambiguo na janela > 0 (info; NÃO é sinal financeiro).
//   billing_pausado_429      — pausa global por 429 ativa (media; alta com ≥ 3 ocorrências seguidas).
//   billing_falhas_seguidas  — execuções seguidas com falha/aborto ≥ billingFalhasSeguidas (alta).
//   billing_atrasado         — Billing HABILITADO, fora de execução, worker não parado e a próxima execução vencida há mais
//                              de min(2× intervalo, billingAtrasoMaxMs) — ou habilitado sem agenda há mais desse prazo
//                              desde o boot (alta). Billing desligado nunca gera este sinal.
//   reconsultas_vencidas_acumuladas — reconsultas vencidas há > reconsultaAtrasoHoras (media; info com Billing desligado).
//   reconsultas_fora_da_janela      — reconsultar/falha/esgotada além da janela de reconsulta: nunca serão retomadas (media).
//   cobertura_perdida        — elegíveis que saíram da janela nos últimos 7 dias sem nenhuma consulta (media).
//   documento_provisorio_antigo     — documento ainda não definitivo em pedido com mais de docProvisorioDias (info).
//   worker_reinicio_inesperado      — heurística do contrato (mesmo commit, anterior sem encerramento limpo) num boot
//                              das últimas reinicioJanelaHoras (media; não distingue troca de instância da plataforma).
const ORDEM_SEV = Object.fromEntries(SEVERIDADES.map((s, i) => [s, i]));

function avaliarSinais(snapshot, { agoraMs = Date.now(), cfg = {}, contaIds = null } = {}) {
  const c = {
    semProgressoCiclos: 3, pollingFalhasSeguidas: 3, billingFalhasSeguidas: 2, billingAtrasoMaxMs: HORA_MS,
    reconsultaAtrasoHoras: 24, docProvisorioDias: 45, reinicioJanelaHoras: 24, janelaReconsultaDias: 60, janelaDias: 30, ...cfg,
  };
  const detectadoEm = new Date(agoraMs).toISOString();
  const out = [];
  const add = (tipo, contaId, severidade, motivo, evidencia, proximaAcao) => out.push({
    tipo, contaId: contaId ?? null, severidade, estado: "ativo", motivo, evidencia, detectadoEm,
    dedupKey: `${tipo}:${contaId ?? "global"}`, proximaAcao,
  });
  const s = snapshot || {};
  const w = s.worker || { estado: "sem_dados" };
  const b = s.billing || null;
  const pc = (s.polling && s.polling.porCheckpoint) || { estado: "sem_dados" };

  // worker
  if (w.estado === "sem_dados" && s.disponivel) {
    add("worker_sem_heartbeat", null, "info", "O worker não publica heartbeat (versão anterior ao S1.5, desligado ou nunca iniciou); a saúde do polling vem só dos checkpoints.",
      { estado: w.estado, boots: w.boots ?? 0 }, "Conferir se o worker do Sentinel com o S1.5 está implantado e ligado.");
  } else if (w.estado === "atrasado") {
    add("worker_sem_heartbeat", null, "media", `Último heartbeat do worker há ${Math.round((w.idadeSegundos || 0) / 60)} min (esperado ≤ ${Math.round((2 * (w.intervaloEsperadoSegundos || 0)) / 60)} min).`,
      { estado: w.estado, heartbeatEm: w.heartbeatEm, idadeSegundos: w.idadeSegundos, instancia: w.instancia }, "Verificar o log do worker do Sentinel.");
  } else if (w.estado === "parado") {
    const limpo = w.encerramento === "limpo";
    add("worker_sem_heartbeat", null, limpo ? "alta" : "critica",
      limpo ? `Worker encerrado de forma limpa e sem novo boot há ${Math.round((w.idadeSegundos || 0) / 60)} min.` : `Nenhum heartbeat do worker há ${Math.round((w.idadeSegundos || 0) / 60)} min, sem encerramento limpo.`,
      { estado: w.estado, heartbeatEm: w.heartbeatEm, idadeSegundos: w.idadeSegundos, encerramento: w.encerramento, encerradoEm: w.encerradoEm, instancia: w.instancia },
      limpo ? "Confirmar se o worker foi desligado de propósito; se não, religar o serviço." : "Verificar o serviço do worker no Render (crash, OOM ou suspensão).");
  }
  if (w.reinicioInesperado === true && w.iniciadoEm && agoraMs - msDe(w.iniciadoEm) <= c.reinicioJanelaHoras * HORA_MS) {
    add("worker_reinicio_inesperado", null, "media", "O worker reiniciou com o mesmo commit e o processo anterior não encerrou de forma limpa (indício de crash/OOM; troca de instância da plataforma também aparece assim).",
      { commit: w.commit, iniciadoEm: w.iniciadoEm, boots: w.boots, anteriorHeartbeatEm: w.anterior && w.anterior.heartbeatEm, memoria: w.memoria },
      "Ver o log do worker em torno do horário do boot (erro fatal ou memória).");
  }

  // polling (global)
  const wp = w.polling;
  if (pc.estado === "parado" || pc.estado === "atrasado") {
    const desligado = wp && wp.habilitado === false;
    add("polling_parado", null, desligado ? "info" : pc.estado === "parado" ? "critica" : "media",
      desligado ? "Checkpoints sem execução recente; o worker publica o polling como DESLIGADO." : `Última execução do polling há ${Math.round((pc.idadeSegundos || 0) / 60)} min (${pc.estado}).`,
      { estado: pc.estado, ultimaExecucaoEm: pc.ultimaExecucaoEm, idadeSegundos: pc.idadeSegundos, habilitado: wp ? wp.habilitado : null },
      desligado ? "Confirmar se o polling deve estar desligado (SENTINEL_WORKER_ENABLED)." : "Verificar se o worker do Sentinel está ativo e lendo as contas.");
  } else if (wp && wp.habilitado === true && (wp.falhasSeguidas >= c.pollingFalhasSeguidas || wp.falhaBoot)) {
    add("polling_parado", null, "alta", wp.falhaBoot ? "O polling falhou no boot do worker." : `${wp.falhasSeguidas} ciclos de polling seguidos com falha.`,
      { falhasSeguidas: wp.falhasSeguidas, ultimoCicloEstado: wp.ultimoCicloEstado, ultimoCicloErro: wp.ultimoCicloErro, falhaBoot: wp.falhaBoot, ultimoCicloEm: wp.ultimoCicloEm },
      "Investigar o erro do ciclo no log do worker.");
  }

  // Billing (global)
  if (b) {
    const p = b.pausa429;
    if (p && p.ativa) {
      add("billing_pausado_429", null, p.ocorrencias >= 3 ? "alta" : "media", `Billing pausado por HTTP 429 do Mercado Livre até ${p.ate}.`,
        { ate: p.ate, ocorrencias: p.ocorrencias }, "Aguardar a pausa; se repetir, reduzir orçamento/lote do Billing.");
    }
    if (b.falhasSeguidas >= c.billingFalhasSeguidas) {
      add("billing_falhas_seguidas", null, "alta", `${b.falhasSeguidas} execuções seguidas do Billing sem concluir.`,
        { falhasSeguidas: b.falhasSeguidas, ultimoResultado: b.ultimaExecucao && b.ultimaExecucao.resultado, ultimoErro: b.ultimaExecucao && b.ultimaExecucao.erro, fimEm: b.ultimaExecucao && b.ultimaExecucao.fimEm },
        "Ver o resultado da última execução e o log do worker.");
    }
    if (b.habilitado === true && b.emExecucao !== true && w.estado !== "parado" && !(p && p.ativa)) {
      const intervalo = b.intervaloMs || b.intervaloPadraoMs || 6 * HORA_MS;
      const tolerancia = Math.min(2 * intervalo, c.billingAtrasoMaxMs);
      const prox = msDe(b.proximaExecucaoEm);
      const boot = msDe(w.iniciadoEm);
      const atrasoMs = prox !== null ? agoraMs - prox : boot !== null && !b.ultimaExecucao ? agoraMs - boot : null;
      if (atrasoMs !== null && atrasoMs > tolerancia) {
        add("billing_atrasado", null, "alta", prox !== null ? `Execução do Billing devida desde ${b.proximaExecucaoEm} e não realizada.` : "Billing habilitado e nenhuma execução registrada desde o boot.",
          { proximaExecucaoEm: b.proximaExecucaoEm, atrasoMinutos: Math.round(atrasoMs / 60000), toleranciaMinutos: Math.round(tolerancia / 60000), intervaloMs: intervalo },
          "Verificar o agendador do Billing no log do worker (lock ocupado, polling longo ou erro).");
      }
    }
  }

  // por conta
  const permitidas = contaIds ? new Set(ids(contaIds)) : null;
  const billingContas = new Set((w.billing && w.billing.contas) || []);
  for (const ct of s.contas || []) {
    if (permitidas && !permitidas.has(ct.contaId)) continue;
    const id = ct.contaId;
    const pl = ct.polling || {};
    const cov = ct.cobertura;
    if (ct.ativo !== false && pl.monitorada) {
      if (pl.ciclosSemProgresso >= c.semProgressoCiclos || pl.leituraSeveridade) {
        add("conta_sem_progresso", id, pl.leituraSeveridade === "critica" ? "critica" : "alta",
          pl.leituraSeveridade ? `Leitura da conta atrasada (${pl.situacao}).` : `${pl.ciclosSemProgresso} ciclos seguidos sem avançar o checkpoint.`,
          { ciclosSemProgresso: pl.ciclosSemProgresso, situacao: pl.situacao, atrasoSegundos: pl.atrasoSegundos, checkpoint: pl.checkpoint, ultimoErro: pl.ultimoErro },
          "Revisar orçamento de chamadas da conta e o erro da última coleta.");
      }
      if (pl.quarentena > 0) {
        add("pedidos_em_quarentena", id, "media", `${pl.quarentena} pedido(s) em quarentena (falharam no processamento repetidas vezes).`,
          { quarentena: pl.quarentena, retentando: pl.retentando, desde: pl.quarentenaDesde }, "Investigar os pedidos em quarentena (sentinel_pedido_excecoes).");
      }
    }
    if (ct.grant && ct.grant.situacao === "indisponivel" && (pl.monitorada || billingContas.has(id))) {
      add("grant_indisponivel", id, "alta", `Grant do Mercado Livre indisponível para a conta (${ct.grant.motivo}); o Sentinel não renova.`,
        { motivo: ct.grant.motivo, refreshFalhas: ct.grant.refreshFalhas, ultimaFalhaRefreshEm: ct.grant.ultimaFalhaRefreshEm, expiraEm: ct.grant.expiraEm },
        "Reconectar a conta pelo Portal (Clientes → Contas).");
    }
    if (!cov) continue;
    if (cov.custoAusente > 0) {
      add("custo_ausente", id, "info", `${cov.custoAusente} pedido(s) pago(s) na janela sem custo ou com custo ambíguo (informativo).`,
        { custoAusente: cov.custoAusente, janelaDias: c.janelaDias }, "Completar a base de custos da conta.");
    }
    if (cov.reconsultasVencidasAntigas > 0) {
      add("reconsultas_vencidas_acumuladas", id, b && b.habilitado === true ? "media" : "info",
        `${cov.reconsultasVencidasAntigas} reconsulta(s) do Billing vencida(s) há mais de ${c.reconsultaAtrasoHoras} h${b && b.habilitado === true ? "" : " (Billing não habilitado)"}.`,
        { reconsultasVencidas: cov.reconsultasVencidas, reconsultasVencidasAntigas: cov.reconsultasVencidasAntigas, proximaReconsultaEm: cov.proximaReconsultaEm },
        "Conferir orçamento e frequência do Billing.");
    }
    if (cov.reconsultasForaDaJanela > 0) {
      add("reconsultas_fora_da_janela", id, "media", `${cov.reconsultasForaDaJanela} conciliação(ões) pendente(s) fora da janela de reconsulta (${c.janelaReconsultaDias} dias): não serão retomadas.`,
        { reconsultasForaDaJanela: cov.reconsultasForaDaJanela, janelaReconsultaDias: c.janelaReconsultaDias }, "Registrar a perda de cobertura; avaliar ampliar a janela de reconsulta.");
    }
    if (cov.sairamDaJanelaSemConsulta7d > 0) {
      add("cobertura_perdida", id, "media", `${cov.sairamDaJanelaSemConsulta7d} pedido(s) elegível(is) saíram da janela nos últimos 7 dias sem nenhuma consulta ao Billing.`,
        { sairamDaJanelaSemConsulta7d: cov.sairamDaJanelaSemConsulta7d, janelaDias: c.janelaDias }, "Aumentar orçamento/frequência do Billing para a conta.");
    }
    if (cov.documentosProvisoriosAntigos > 0) {
      add("documento_provisorio_antigo", id, "info", `${cov.documentosProvisoriosAntigos} conciliação(ões) com documento ainda não definitivo em pedido com mais de ${c.docProvisorioDias} dias.`,
        { documentosProvisoriosAntigos: cov.documentosProvisoriosAntigos, docProvisorioDias: c.docProvisorioDias }, "Acompanhar; nenhuma ação na margem.");
    }
  }

  return out.sort((x, y) => ORDEM_SEV[x.severidade] - ORDEM_SEV[y.severidade] || x.tipo.localeCompare(y.tipo) || String(x.contaId ?? "").localeCompare(String(y.contaId ?? "")));
}

module.exports = {
  VERSAO,
  SEVERIDADES,
  configOperacao,
  lerOperacao,
  avaliarSinais,
  lerWorker,
  lerBilling,
  avaliarGrant,
  SQL_COBERTURA_PEDIDOS,
  SQL_COBERTURA_CONCILIACOES,
  SQL_MOTIVOS,
  SQL_CHECKPOINTS_EXCECOES,
  SQL_CONTROLE,
  SQL_GRANTS,
};
