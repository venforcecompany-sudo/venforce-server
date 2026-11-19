// server/services/sentinel/sentinelPollingWorker.js
// Sentinel — ciclo de polling incremental de pedidos ML por conta (V0-a).
//
// NÃO inicia nada sozinho e NÃO roda dentro do Express: o processo é o
// entrypoint server/workers/sentinelWorker.js (node direto), com pool próprio,
// flag SENTINEL_WORKER_ENABLED e allowlist de contas. Este módulo só exporta
// executarCiclo/processarConta (e o runner scripts/sentinel-run-once.js).
// `db` é SEMPRE explícito (nenhum serviço do Sentinel cai no pool global).
//
// Um ciclo é serializado entre instâncias por pg_try_advisory_lock numa conexão
// DEDICADA; a posse é verificada (pg_locks) antes de CADA conta e antes de gravar
// cada checkpoint — perdeu o lock ⇒ o ciclo aborta sem avançar checkpoint.
//
// Por conta (sequencial):
//   1. contexto via resolveMarketplaceAccountContext (grant utilizável exigido);
//   2. pedidos atualizados desde (checkpoint − SENTINEL_OVERLAP_MS), em janelas;
//   3. cada janela 100% processada avança o checkpoint até o FIM dela (nunca para
//      trás); a primeira janela com erro/truncada/sem orçamento para a conta;
//   4. pedido que falha vai para sentinel_pedido_excecoes (sentinelExcecoes.js):
//      retentando ⇒ o checkpoint não avança; quarentena (após SENTINEL_MAX_TENTATIVAS)
//      ⇒ pode avançar, mas só depois da exceção gravada;
//   5. provisórias recentes são reprocessadas, dentro do orçamento;
//   6. ML sem noRefresh nunca: token expirado/401 ⇒ SENTINEL_TOKEN_INDISPONIVEL
//      (sem retry, sem refresh, sem fallback).
// Erro não tratado na conta ⇒ ultimo_erro gravado e checkpoint NÃO avança.

const { configConexao } = require("../../config/databaseConexao");
const { Client } = require("pg");
const { resolveMarketplaceAccountContext } = require("../clienteContas/clienteContaService");
const { createCentralVendasFreteService } = require("../centralVendas/centralVendasFreteService");
const { iterarOrdersUpdatedSince, fetchOrderById, fetchPackById } = require("./sentinelOrdersFetch");
const { criarEnvioPack } = require("./sentinelEnvioPack");
const { processarPedido } = require("./sentinelPedidoService");
const { configRecalculo, planejarRecalculo, marcarRecalculadas, estadoPadrao: estadoRecalculoPadrao } = require("./sentinelRecalculoBase");
const { criarMlFetchSentinel, criarEscopoMl } = require("./sentinelMlClient");
const { incidentesDisponiveis } = require("./sentinelSchema");
const { avaliarIncidentesConta } = require("./sentinelIncidentes");
const {
  registrarExcecao, marcarResolvido, carregarExcecoesAbertas, maxTentativas,
} = require("./sentinelExcecoes");

const LOCK_KEY = "vf:sentinel:polling";
const HORA_MS = 3600 * 1000;

function lerInteiroPositivo(valor, padrao) {
  const n = Number.parseInt(valor, 10);
  return Number.isFinite(n) && n > 0 ? n : padrao;
}

function configWorker(env = process.env) {
  return {
    intervalMs: lerInteiroPositivo(env.SENTINEL_POLL_INTERVAL_MS, 180000),
    lookbackHours: lerInteiroPositivo(env.SENTINEL_LOOKBACK_HOURS, 24),
    overlapMs: lerInteiroPositivo(env.SENTINEL_OVERLAP_MS, 2 * HORA_MS),
    provisoriaDias: lerInteiroPositivo(env.SENTINEL_PROVISORIA_DIAS, 7),
    provisoriaMax: lerInteiroPositivo(env.SENTINEL_PROVISORIA_MAX, 100),
    cicloMaxMs: lerInteiroPositivo(env.SENTINEL_CICLO_MAX_MS, 300000),
    maxChamadasPorConta: lerInteiroPositivo(env.SENTINEL_MAX_CHAMADAS_POR_CONTA, 500),
    maxTentativas: maxTentativas(env),
    excecoesMax: lerInteiroPositivo(env.SENTINEL_EXCECOES_MAX, 50),
    alertaSemProgressoCiclos: lerInteiroPositivo(env.SENTINEL_ALERTA_SEM_PROGRESSO_CICLOS, 3),
  };
}

function exigirDb(db) {
  if (!db || typeof db.query !== "function") {
    const err = new Error("Sentinel exige `db` explícito (pool próprio do worker); nenhum serviço usa o pool global.");
    err.code = "SENTINEL_DB_OBRIGATORIO";
    throw err;
  }
  return db;
}

function erroLockPerdido(motivo) {
  const err = new Error(`Advisory lock do Sentinel perdido: ${motivo}`);
  err.code = "SENTINEL_LOCK_PERDIDO";
  return err;
}

async function listarContasMeli(db) {
  const r = await db.query(
    `SELECT id FROM cliente_contas
      WHERE ativo = true AND marketplace = 'meli' AND external_account_id IS NOT NULL
      ORDER BY id`
  );
  return r.rows.map((row) => row.id);
}

async function lerCheckpoint(db, contaId) {
  const r = await db.query(
    "SELECT ultimo_date_last_updated FROM sentinel_checkpoints WHERE cliente_conta_id = $1",
    [contaId]
  );
  return r.rows[0]?.ultimo_date_last_updated || null;
}

// ultimoDateLastUpdated null = não mexe no checkpoint; nunca recua (GREATEST).
async function gravarCheckpoint(db, contaId, { ultimoDateLastUpdated = null, erro = null, processados = 0, atrasoSegundos = null, semProgresso = false }) {
  const r = await db.query(
    `INSERT INTO sentinel_checkpoints
       (cliente_conta_id, ultimo_date_last_updated, ultima_execucao_em, ultimo_erro, pedidos_processados_ultima,
        atraso_segundos, atraso_medido_em, ciclos_sem_progresso)
     -- Só grava se a Conta existe; FOR KEY SHARE serializa com o purge (sem FK aqui:
     -- é isto que impede checkpoint órfão herdável por uma conta futura com o mesmo id).
     SELECT cc.id, $2::timestamptz, NOW(), $3::text, $4::int, $5::int, CASE WHEN $5::int IS NULL THEN NULL ELSE NOW() END, CASE WHEN $6::boolean THEN 1 ELSE 0 END
       FROM cliente_contas cc WHERE cc.id = $1 FOR KEY SHARE
     ON CONFLICT (cliente_conta_id) DO UPDATE SET
       ultimo_date_last_updated = GREATEST(EXCLUDED.ultimo_date_last_updated, sentinel_checkpoints.ultimo_date_last_updated),
       ultima_execucao_em = NOW(),
       ultimo_erro = EXCLUDED.ultimo_erro,
       pedidos_processados_ultima = EXCLUDED.pedidos_processados_ultima,
       atraso_segundos = COALESCE(EXCLUDED.atraso_segundos, sentinel_checkpoints.atraso_segundos),
       atraso_medido_em = COALESCE(EXCLUDED.atraso_medido_em, sentinel_checkpoints.atraso_medido_em),
       ciclos_sem_progresso = CASE WHEN $6::boolean THEN sentinel_checkpoints.ciclos_sem_progresso + 1 ELSE 0 END
     RETURNING ciclos_sem_progresso`,
    [contaId, ultimoDateLastUpdated, erro, processados, atrasoSegundos, semProgresso]
  );
  return r.rows[0]?.ciclos_sem_progresso ?? 0;
}

async function resolverContaPadrao(contaId, db) {
  const conta = await db.query("SELECT id, cliente_id FROM cliente_contas WHERE id = $1", [contaId]);
  if (!conta.rows.length) {
    const err = new Error(`Conta ${contaId} não encontrada.`);
    err.code = "SENTINEL_CONTA_NAO_ENCONTRADA";
    throw err;
  }
  const ctx = await resolveMarketplaceAccountContext({
    clienteId: conta.rows[0].cliente_id,
    marketplace: "meli",
    clienteContaId: contaId,
    requireUsableGrant: true,
    queryable: db,
  });
  return {
    clienteId: ctx.cliente.id,
    clienteSlug: ctx.cliente.slug,
    clienteContaId: ctx.conta.id,
    sellerId: ctx.mlUserId,
    baseId: ctx.base?.base_id || null,
  };
}

function contar(resumo, r) {
  resumo.processados += 1;
  resumo.porResultado[r.resultado] = (resumo.porResultado[r.resultado] || 0) + 1;
  if (r.estado) resumo.porEstado[r.estado] = (resumo.porEstado[r.estado] || 0) + 1;
}

function contarErro(resumo, r) {
  resumo.porResultado[r.resultado] = (resumo.porResultado[r.resultado] || 0) + 1;
}

// deps: { db (leituras; obrigatório), dbEscrita (TODAS as escritas — no ciclo é a conexão que
//         detém o advisory lock; ausente = db), nowMs, resolverConta, mlFetchBase, buscarFrete,
//         fetchOrderByIdFn, iterarJanelasFn | fetchOrdersFn (legado), fetchOpts, config,
//         cacheCusto, verificarLock, deadlineMs, redefinirCheckpoint (ISO; run-once --since) }
async function processarConta(contaId, deps = {}) {
  const db = exigirDb(deps.db);
  const dbW = deps.dbEscrita || db;
  const cfg = { ...configWorker(), ...(deps.config || {}) };
  const nowMs = deps.nowMs ?? Date.now();
  const deadlineMs = deps.deadlineMs ?? (Date.now() + cfg.cicloMaxMs);
  const resolverConta = deps.resolverConta || resolverContaPadrao;
  const verificarLock = deps.verificarLock || (async () => {});

  // Escopo ML da conta: noRefresh em TODA chamada, contagem p/ orçamento, sinal de token.
  const escopo = criarEscopoMl({ maxChamadas: cfg.maxChamadasPorConta });
  const mlFetchFn = criarMlFetchSentinel({ base: deps.mlFetchBase, escopo });
  const buscarFrete = deps.buscarFrete || createCentralVendasFreteService({
    mlFetchFn: criarMlFetchSentinel({ base: deps.mlFetchBase, escopo, modoFrete: true }),
  }).buscarFreteShipment;
  const fetchOrder = deps.fetchOrderByIdFn || ((ctx, id) => fetchOrderById(ctx, id, { mlFetchFn }));
  const iterar = deps.iterarJanelasFn
    || (deps.fetchOrdersFn
      ? async function* (ctx, since, opts) { yield* (await deps.fetchOrdersFn(ctx, since, opts)).janelas; }
      : iterarOrdersUpdatedSince);
  const pedidoDeps = { db, dbEscrita: dbW, buscarFrete, cacheCusto: deps.cacheCusto || new Map() };
  const resumo = {
    contaId, processados: 0, porResultado: {}, porEstado: {}, checkpoint: null, erro: null,
    quarentena: 0, retentando: 0, atrasoSegundos: null, chamadasMl: 0, alerta: null, cicloSemProgresso: 0,
  };

  const gravarCheckpointSeguro = async (dados) => {
    await verificarLock(); // perdeu o lock ⇒ lança SENTINEL_LOCK_PERDIDO, nada é gravado
    return gravarCheckpoint(dbW, contaId, dados);
  };

  let ctx;
  try {
    ctx = await resolverConta(contaId, db);
    if (!ctx.sellerId) {
      const err = new Error("Conta sem seller Mercado Livre (external_account_id).");
      err.code = "SENTINEL_SEM_SELLER";
      throw err;
    }
  } catch (err) {
    resumo.erro = `${err.code || "ERRO"}: ${err.message}`;
    await gravarCheckpointSeguro({ erro: resumo.erro, processados: 0 });
    return resumo;
  }

  // Envio compartilhado (pack): contexto da conta neste ciclo — pedidos conhecidos, /packs e
  // irmãos buscados (mlFetch noRefresh, no orçamento da conta) e frete por shipment.
  const fetchPack = deps.fetchPackByIdFn || ((c, packId) => fetchPackById(c, packId, { mlFetchFn }));
  pedidoDeps.envio = criarEnvioPack({ ctx, fetchPack, fetchOrder });
  // prazo do ciclo / orçamento de chamadas: checado DENTRO do laço de irmãos (estouro ⇒ pack incompleto).
  pedidoDeps.envio.orcamentoOk = () => {
    if (escopo.chamadas >= escopo.maxChamadas) escopo.orcamentoEsgotado = true; // a conta reporta e para
    return !(Date.now() > deadlineMs || escopo.tokenIndisponivel || escopo.chamadas >= escopo.maxChamadas);
  };

  if (deps.redefinirCheckpoint) {
    // Redefinição explícita (run-once --since): SOB o lock, pela conexão detentora, antes de ler.
    await verificarLock();
    await dbW.query(
      `INSERT INTO sentinel_checkpoints (cliente_conta_id, ultimo_date_last_updated)
       SELECT cc.id, $2::timestamptz FROM cliente_contas cc WHERE cc.id = $1 FOR KEY SHARE
       ON CONFLICT (cliente_conta_id) DO UPDATE SET ultimo_date_last_updated = EXCLUDED.ultimo_date_last_updated`,
      [contaId, deps.redefinirCheckpoint]
    );
  }
  const checkpointAtual = await lerCheckpoint(db, contaId);
  const checkpointMs = checkpointAtual ? new Date(checkpointAtual).getTime() : null;
  // Sobreposição: relê SENTINEL_OVERLAP_MS antes do checkpoint (ML pode indexar
  // atualizações com atraso; o UPSERT é idempotente/monotônico).
  const sinceMs = checkpointMs !== null ? checkpointMs - cfg.overlapMs : nowMs - cfg.lookbackHours * HORA_MS;
  const sinceIso = new Date(sinceMs).toISOString();
  // Idade do checkpoint ANTES do ciclo: só diagnóstico (após --since é a idade da
  // janela pedida, não falha). O atraso gravado é medido no fim do ciclo, abaixo.
  resumo.atrasoInicialSegundos = checkpointMs !== null ? Math.max(0, Math.round((nowMs - checkpointMs) / 1000)) : null;

  const excecoes = await carregarExcecoesAbertas(db, contaId);
  const vistos = new Set(); // pedidos já tratados neste ciclo (janelas) — não contam tentativa 2x
  let novoCheckpointMs = null;
  let erroConta = null;
  let erroNaoTratado = false;
  let excecaoNaoGravada = false; // QUALQUER escrita de exceção que falhe no ciclo ⇒ checkpoint não avança
  const esgotou = () => Date.now() > deadlineMs;
  const semOrcamento = () => esgotou() || escopo.tokenIndisponivel || escopo.chamadas >= escopo.maxChamadas;

  // Protocolo de exceção (janelas, provisórias e retentando): tentativas++ ⇒ retentando;
  // ≥ limite ⇒ quarentena. Devolve 'quarentena' | 'retentando' | 'nao_gravada'. Se a conexão
  // do lock caiu, a escrita falha e verificarLock() lança SENTINEL_LOCK_PERDIDO.
  const tratarErro = async (id, motivo) => {
    await verificarLock();
    try {
      const ex = await registrarExcecao(dbW, contaId, id, motivo, { limite: cfg.maxTentativas });
      if (ex.status === "quarentena") {
        resumo.quarentena += 1;
        excecoes.quarentena.add(id);
        excecoes.retentando.delete(id);
        console.warn(`[sentinel] conta ${contaId} pedido ${id} em QUARENTENA após ${ex.tentativas} tentativa(s): ${motivo}`);
        return "quarentena";
      }
      resumo.retentando += 1;
      excecoes.retentando.add(id);
      return "retentando";
    } catch (errEx) {
      await verificarLock();
      console.warn(`[sentinel] exceção do pedido ${id} NÃO gravada: ${errEx.message}`);
      excecaoNaoGravada = true;
      return "nao_gravada";
    }
  };
  const tratarSucesso = async (id) => {
    if (!excecoes.retentando.has(id)) return;
    await marcarResolvido(dbW, contaId, id).catch((e) => console.warn(`[sentinel] marcarResolvido ${id}: ${e.message}`));
    excecoes.retentando.delete(id);
  };

  try {
    const fetchOpts = { nowMs, mlFetchFn, ...(deps.fetchOpts || {}) };
    for await (const janela of iterar(ctx, sinceIso, fetchOpts)) {
      if (esgotou()) { erroConta = "SENTINEL_CICLO_ORCAMENTO: SENTINEL_CICLO_MAX_MS esgotado; retoma no próximo ciclo."; break; }
      await verificarLock();
      let falhou = false;
      let parar = false;
      for (const o of janela.orders) pedidoDeps.envio.conhecidos.set(String(o.id), o);
      for (const order of janela.orders) {
        const id = String(order.id);
        if (excecoes.quarentena.has(id)) continue; // quarentena: não reprocessa nem conta
        if (esgotou()) { erroConta = "SENTINEL_CICLO_ORCAMENTO: SENTINEL_CICLO_MAX_MS esgotado no meio da janela."; parar = true; break; }
        const r = await processarPedido(ctx, order, pedidoDeps);
        vistos.add(id);
        if (escopo.tokenIndisponivel) {
          erroConta = `SENTINEL_TOKEN_INDISPONIVEL: ${escopo.motivoToken}`;
          parar = true;
          break;
        }
        if (escopo.orcamentoEsgotado) {
          erroConta = `SENTINEL_ORCAMENTO_CHAMADAS: SENTINEL_MAX_CHAMADAS_POR_CONTA=${cfg.maxChamadasPorConta} esgotado; retoma no próximo ciclo.`;
          if (r.resultado !== "erro") contar(resumo, r);
          parar = true;
          break;
        }
        if (r.resultado === "erro") {
          contarErro(resumo, r);
          const st = await tratarErro(id, `${r.codigo ? `${r.codigo}: ` : ""}${r.erro}`);
          if (st === "nao_gravada") {
            falhou = true; // exceção não ficou durável ⇒ não avança
            erroConta = `SENTINEL_EXCECAO_NAO_GRAVADA: pedido ${id}`;
          } else if (st === "retentando") {
            falhou = true; // checkpoint não avança; retenta no próximo ciclo
          }
          continue;
        }
        contar(resumo, r);
        await tratarSucesso(id);
      }
      if (parar) break;
      if (falhou) {
        erroConta = erroConta
          || `SENTINEL_PEDIDO_ERRO: pedido(s) com erro na janela ${new Date(janela.fromMs).toISOString()} → ${new Date(janela.toMs).toISOString()}; checkpoint parado no início dela.`;
        break;
      }
      if (!janela.complete) {
        erroConta = `SENTINEL_TRUNCATED: janela mínima ${new Date(janela.fromMs).toISOString()} → ${new Date(janela.toMs).toISOString()} não coube no teto de páginas (total=${janela.total ?? "?"}).`;
        break;
      }
      novoCheckpointMs = janela.toMs;
    }
  } catch (err) {
    if (err && err.code === "SENTINEL_LOCK_PERDIDO") throw err;
    if (err && err.code === "SENTINEL_TOKEN_INDISPONIVEL") {
      erroConta = `SENTINEL_TOKEN_INDISPONIVEL: ${err.message}`; // tratado: avança só janelas completas
    } else if (err && err.code === "SENTINEL_ORCAMENTO_CHAMADAS") {
      erroConta = `SENTINEL_ORCAMENTO_CHAMADAS: ${err.message}`;
    } else {
      erroConta = `${err.code || "ERRO"}: ${err.message}`;
      erroNaoTratado = true; // erro não tratado ⇒ checkpoint NÃO avança neste ciclo
    }
  }

  // Reprocessamento POR ID, independente do checkpoint e dentro do orçamento:
  //   1) exceções 'retentando' (inclusive reabertas por reabrirExcecao), até excecoesMax;
  //   2) provisórias recentes (frete/imposto podem chegar sem o ML mexer no pedido).
  // Erro (fetch ou processarPedido) segue o protocolo de exceção e NÃO afeta o checkpoint.
  // opcoes.forcar (padrão true): refaz a leitura do frete. O recálculo por base de custos passa false: só custo/imposto mudaram,
  // então o frete GRAVADO é reaproveitado (sem chamada extra). Devolve { processados, falhas, interrompido } p/ o chamador.
  const reprocessarPorId = async (ids, { forcar = true } = {}) => {
    const st = { processados: 0, falhas: 0, interrompido: false };
    for (const id of ids) {
      if (semOrcamento()) { st.interrompido = true; return st; }
      if (vistos.has(id) || excecoes.quarentena.has(id)) continue;
      vistos.add(id);
      let r;
      try {
        const order = await fetchOrder(ctx, id);
        pedidoDeps.envio.conhecidos.set(String(order.id), order);
        r = await processarPedido(ctx, order, { ...pedidoDeps, forcar });
      } catch (err) {
        if (err && err.code === "SENTINEL_LOCK_PERDIDO") throw err;
        if (escopo.tokenIndisponivel || (err && (err.code === "SENTINEL_TOKEN_INDISPONIVEL" || err.code === "SENTINEL_ORCAMENTO_CHAMADAS"))) { st.interrompido = true; return st; }
        r = { resultado: "erro", erro: `${err.code ? `${err.code}: ` : ""}${err.message}`, codigo: err.code || null };
      }
      if (escopo.tokenIndisponivel || escopo.orcamentoEsgotado) { if (r.resultado !== "erro") contar(resumo, r); st.interrompido = true; return st; }
      if (r.resultado === "erro") {
        contarErro(resumo, r);
        await tratarErro(id, r.erro);
        st.falhas += 1;
      } else {
        contar(resumo, r);
        await tratarSucesso(id);
        st.processados += 1;
      }
    }
    return st;
  };
  if (!erroNaoTratado) {
    try {
      const retentando = await db.query(
        `SELECT pedido_id FROM sentinel_pedido_excecoes
          WHERE cliente_conta_id = $1 AND status = 'retentando'
          ORDER BY ultimo_erro_em ASC LIMIT $2`,
        [contaId, cfg.excecoesMax]
      );
      await reprocessarPorId(retentando.rows.map((x) => String(x.pedido_id)));
      if (!semOrcamento()) {
        const provisorias = await db.query(
          `SELECT pedido_id FROM sentinel_pedidos
            WHERE cliente_conta_id = $1 AND estado_margem = 'provisoria'
              AND data_pedido >= NOW() - ($2 || ' days')::interval
            ORDER BY data_pedido DESC
            LIMIT $3`,
          [ctx.clienteContaId, String(cfg.provisoriaDias), cfg.provisoriaMax]
        );
        await reprocessarPorId(provisorias.rows.map((x) => String(x.pedido_id)));
      }
      // Recálculo por alteração da base de custos/impostos (SENTINEL_RECALC_BASE_ENABLED; padrão desligado): linhas estáveis cujo
      // custo/imposto gravado difere do que a base ATUAL resolve, independentemente de ml_date_last_updated. Mesmo fluxo por id,
      // mesmo orçamento/lock/exceções; teto por ciclo; não mexe no checkpoint.
      if (!semOrcamento()) {
        const cfgRec = { ...configRecalculo(), ...(deps.recalculoConfig || {}) };
        const plano = await planejarRecalculo({ db, ctx, cfg: cfgRec, estado: deps.recalculoEstado || estadoRecalculoPadrao, cacheCusto: pedidoDeps.cacheCusto, nowMs });
        if (plano) {
          const st = plano.ids.length ? await reprocessarPorId(plano.ids, { forcar: false }) : { processados: 0, falhas: 0, interrompido: false };
          let marcados = 0;
          try {
            marcados = await marcarRecalculadas({ db, dbEscrita: dbW, contaId: ctx.clienteContaId, plano, agoraIso: new Date(nowMs).toISOString(), verificarLock });
          } finally {
            plano.concluir(st); // o estado do recálculo é registrado MESMO que a marcação falhe
          }
          resumo.recalculo = { divergentes: plano.divergentes, tentados: plano.ids.length, marcados, falhas: st.falhas, pendente: plano.pendente || st.interrompido || st.falhas > 0 };
          if (plano.ids.length) console.log(`[sentinel] conta ${contaId}: recálculo por base de custos: divergentes=${plano.divergentes} tentados=${plano.ids.length} marcados=${marcados} falhas=${st.falhas}`);
        }
      }
    } catch (err) {
      if (err && err.code === "SENTINEL_LOCK_PERDIDO") throw err;
      console.warn(`[sentinel] falha no reprocessamento por id da conta ${contaId}: ${err.message}`);
    }
  }

  if (escopo.tokenIndisponivel && !/SENTINEL_TOKEN_INDISPONIVEL/.test(erroConta || "")) {
    erroConta = `SENTINEL_TOKEN_INDISPONIVEL: ${escopo.motivoToken}`;
  }
  if (escopo.orcamentoEsgotado && !erroConta) {
    erroConta = `SENTINEL_ORCAMENTO_CHAMADAS: SENTINEL_MAX_CHAMADAS_POR_CONTA=${cfg.maxChamadasPorConta} esgotado; retoma no próximo ciclo.`;
  }
  resumo.chamadasMl = escopo.chamadas;
  // Nunca recua o checkpoint (a sobreposição faz as primeiras janelas terminarem antes dele).
  if (excecaoNaoGravada && !/SENTINEL_EXCECAO_NAO_GRAVADA/.test(erroConta || "")) {
    erroConta = `SENTINEL_EXCECAO_NAO_GRAVADA: escrita de exceção falhou neste ciclo; checkpoint não avança.${erroConta ? ` (${erroConta})` : ""}`;
    resumo.erro = erroConta;
  }
  const avancou = !erroNaoTratado && !excecaoNaoGravada && novoCheckpointMs !== null && (checkpointMs === null || novoCheckpointMs > checkpointMs);
  const novoCheckpoint = avancou ? new Date(novoCheckpointMs).toISOString() : null;
  resumo.checkpoint = novoCheckpoint || (checkpointAtual ? new Date(checkpointAtual).toISOString() : null);
  resumo.erro = erroConta;
  // Atraso = o quanto a leitura está atrás do relógio DEPOIS deste ciclo: se o
  // checkpoint avançou, mede contra o novo; se não avançou, contra o antigo (aí o
  // atraso é real e cresce). Relógio fixo (deps.nowMs) em testes.
  {
    const fimMs = deps.nowMs ?? Date.now();
    const refMs = avancou ? novoCheckpointMs : checkpointMs;
    resumo.atrasoSegundos = refMs !== null ? Math.max(0, Math.round((fimMs - refMs) / 1000)) : null;
  }
  // Sem progresso por ORÇAMENTO (chamadas/ciclo) = o checkpoint não andou e o motivo foi orçamento.
  const semProgresso = !avancou && /^SENTINEL_(ORCAMENTO_CHAMADAS|CICLO_ORCAMENTO)/.test(erroConta || "");
  resumo.cicloSemProgresso = await gravarCheckpointSeguro({
    ultimoDateLastUpdated: novoCheckpoint,
    erro: erroConta,
    processados: resumo.processados,
    atrasoSegundos: resumo.atrasoSegundos,
    semProgresso,
  });
  if (semProgresso && resumo.cicloSemProgresso >= cfg.alertaSemProgressoCiclos) {
    resumo.alerta = "SENTINEL_SEM_PROGRESSO";
    console.error(`[sentinel] ALERTA SENTINEL_SEM_PROGRESSO conta ${contaId}: ${resumo.cicloSemProgresso} ciclo(s) seguidos sem avançar o checkpoint por orçamento `
      + `(atraso_s=${resumo.atrasoSegundos ?? "n/a"}); aumente SENTINEL_MAX_CHAMADAS_POR_CONTA/SENTINEL_CICLO_MAX_MS ou investigue o volume.`);
  }
  console.log(`[sentinel] conta ${contaId}: processados=${resumo.processados} quarentena=${resumo.quarentena} retentando=${resumo.retentando} `
    + `atraso_s=${resumo.atrasoSegundos ?? "n/a"} chamadas_ml=${resumo.chamadasMl} checkpoint=${resumo.checkpoint ?? "null"} erro=${resumo.erro ?? "-"}`);
  return resumo;
}

// Lock de SESSÃO numa conexão dedicada (fora do pool), liberado no fim do ciclo. Essa MESMA
// conexão executa todas as ESCRITAS do ciclo (fencing real: se ela cair, o lock cai e as
// escritas falham junto). fn recebe { verificar, dbEscrita }. verificar() confirma conexão viva
// + a CHAVE exata no pg_locks (classid/objid de hashtext(chave), pid do lock). `chave` padrão = LOCK_KEY do
// polling; o coletor de Billing usa a SUA (nunca disputa o lock do polling);
// perdeu ⇒ SENTINEL_LOCK_PERDIDO.
async function comLockDoCiclo(fn, { criarClient, chave = LOCK_KEY } = {}) {
  const client = criarClient ? criarClient() : new Client({ ...configConexao(), query_timeout: 10000 });
  const estado = { perdido: false, motivo: null, pid: null };
  const marcarPerdido = (motivo) => { if (!estado.perdido) { estado.perdido = true; estado.motivo = motivo; } };
  client.on("error", (err) => {
    marcarPerdido(`erro de conexão: ${err.message}`);
    console.error(`[sentinel] conexão do lock perdida: ${err.message}`);
  });
  client.on("end", () => marcarPerdido("conexão do lock encerrada"));
  await client.connect();
  try {
    const r = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok, pg_backend_pid() AS pid", [chave]);
    if (!r.rows[0]?.ok) return { pulado: true };
    estado.pid = r.rows[0].pid;
    const verificar = async () => {
      if (estado.perdido) throw erroLockPerdido(estado.motivo);
      let q;
      try {
        // pg_try_advisory_lock(int8): classid = 32 bits altos, objid = 32 bits baixos, objsubid = 1.
        q = await client.query(
          `SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND pid = $1 AND granted AND objsubid = 1
              AND classid = (((hashtext($2)::bigint) >> 32) & 4294967295)::bigint::oid
              AND objid   = ((hashtext($2)::bigint) & 4294967295)::bigint::oid`,
          [estado.pid, chave]);
      } catch (err) {
        marcarPerdido(`verificação falhou: ${err.message}`);
        throw erroLockPerdido(estado.motivo);
      }
      if (!q.rows.length) {
        marcarPerdido("a chave do lock do Sentinel não consta mais em pg_locks para a sessão");
        throw erroLockPerdido(estado.motivo);
      }
    };
    const dbEscrita = { query: (sql, params) => client.query(sql, params) };
    try {
      return { pulado: false, resultado: await fn({ verificar, dbEscrita }) };
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [chave]).catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}

// contaIds: opcional (run-once/worker). Sem ele, todas as contas ML ativas.
// deps.deveParar(): checado ENTRE contas (a conta corrente termina).
// deps.dbEscrita: só para teste (injeção de falha); em produção = a conexão do lock.
async function executarCiclo({ contaIds = null, ...deps } = {}) {
  const db = exigirDb(deps.db);
  const cfg = { ...configWorker(), ...(deps.config || {}) };
  const inicio = Date.now();
  const deadlineMs = inicio + cfg.cicloMaxMs;
  const contas = [];
  let abortado = null;
  const lock = await comLockDoCiclo(async ({ verificar, dbEscrita }) => {
    const ids = contaIds || await listarContasMeli(db);
    const cacheCusto = new Map(); // índice de custo por baseId, só neste ciclo
    // Incidentes (V0-b): só se as tabelas existirem e não for desligado. Falha na
    // avaliação nunca derruba a coleta (fica em resumo.incidentesErro).
    const avaliarIncidentes = deps.avaliarIncidentes !== false
      && process.env.SENTINEL_INCIDENTES_ENABLED !== "0"
      && await incidentesDisponiveis(db).catch(() => false);
    try {
      for (const id of ids) {
        if (deps.deveParar && deps.deveParar()) { console.log("[sentinel] parada solicitada: ciclo encerrado entre contas."); break; }
        if (Date.now() > deadlineMs) { console.warn("[sentinel] SENTINEL_CICLO_MAX_MS esgotado: contas restantes ficam para o próximo ciclo."); break; }
        await verificar();
        const resumoConta = await processarConta(id, { ...deps, db, dbEscrita: deps.dbEscrita || dbEscrita, cacheCusto, verificarLock: verificar, deadlineMs });
        if (avaliarIncidentes) {
          try {
            resumoConta.incidentes = await avaliarIncidentesConta(db, id, { agora: deps.nowMs ?? Date.now() });
          } catch (err) {
            resumoConta.incidentesErro = String(err?.message || err).slice(0, 300);
            console.error(`[sentinel] conta ${id}: avaliação de incidentes falhou (coleta mantida): ${resumoConta.incidentesErro}`);
          }
        }
        contas.push(resumoConta);
      }
    } catch (err) {
      if (err && err.code === "SENTINEL_LOCK_PERDIDO") {
        abortado = err.message;
        console.error(`[sentinel] ciclo ABORTADO sem avançar checkpoint: ${err.message}`);
      } else {
        throw err;
      }
    }
    return contas;
  }, { criarClient: deps.criarClient });
  if (lock.pulado) {
    console.log("[sentinel] ciclo pulado: outro ciclo detém o advisory lock.");
    return { pulado: true, contas: [] };
  }
  const total = contas.reduce((s, c) => s + c.processados, 0);
  console.log(`[sentinel] ciclo ${abortado ? "abortado" : "concluído"}: ${contas.length} conta(s), ${total} pedido(s), ${Date.now() - inicio}ms`);
  return { pulado: false, abortado, contas };
}

module.exports = {
  executarCiclo,
  processarConta,
  comLockDoCiclo,
  configWorker,
  listarContasMeli,
  resolverContaPadrao,
  LOCK_KEY,
};
