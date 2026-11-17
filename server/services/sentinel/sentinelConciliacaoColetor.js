// server/services/sentinel/sentinelConciliacaoColetor.js
//
// Coletor ASSÍNCRONO de Billing do Sentinel (S1). Concilia a comissão OFICIAL gravada pelo motor
// (sentinel_pedidos.comissao) com GET /billing/integration/group/ML/order/details (lotes ≤ 60) e, quando necessário,
// GET /orders/{id}/discounts — pelo conciliador PURO (sentinelConciliacaoComissao). Não é um segundo motor: não calcula,
// não corrige e não credita nada; `efeito_na_margem` é sempre "nenhum".
//
// Independente do polling crítico de pedidos:
//   · processo próprio (server/workers/sentinelConciliacaoWorker.js), flag SENTINEL_CONCILIACAO_ENABLED DESLIGADA por padrão;
//   · advisory lock PRÓPRIO (CONCILIACAO_LOCK_KEY) numa conexão dedicada — nunca disputa o lock do polling; dois
//     coletores ⇒ o segundo é pulado; perdeu o lock ⇒ aborta sem gravar;
//   · não lê nem grava sentinel_checkpoints; só LÊ sentinel_pedidos e grava sentinel_conciliacao_*.
//
// Proteção do ML (IP compartilhado com o restante do Portal):
//   · grant da PRÓPRIA conta, sempre noRefresh (token expirado/401 ⇒ conta parada nesta execução, sem refresh);
//   · um lote só tem pedidos de UMA conta (um seller); orçamento por execução e por conta; prazo da execução;
//     intervalo entre chamadas;
//   · 429 (Billing OU descontos) ⇒ nenhuma nova chamada nesta execução + pausa GLOBAL persistida
//     (sentinel_conciliacao_controle), com Retry-After e backoff exponencial — toda execução respeita;
//   · 5xx/timeout/206/errors[]/404 ⇒ falha do lote (registrada por pedido, com backoff), a conta para nesta execução;
//   · 403 ⇒ grant sem acesso ao Billing: a conta para, nada é gravado.
//
// Retomável e idempotente: o estado é a tabela (o que falta/venceu é selecionado de novo); a gravação é upsert monotônico.
// Documento PROCESSING nunca é cache definitivo: reconsulta controlada (intervalo e número máximo configuráveis).

const { comLockDoCiclo, resolverContaPadrao } = require("./sentinelPollingWorker");
const { criarMlFetchSentinel, criarEscopoMl } = require("./sentinelMlClient");
const { conciliacaoSchemaPronto } = require("./sentinelSchema");
const { conciliarComissaoPedido, CATEGORIA_MOTIVO, MOTIVOS_TRANSITORIOS } = require("./sentinelConciliacaoComissao");
const repo = require("./sentinelConciliacaoRepositorio");

const CONCILIACAO_LOCK_KEY = "vf:sentinel:conciliacao";
const LOTE_MAX_ML = 60; // limite documentado de order_ids por consulta (boas-praticas…faturamento.md)
const HORA_MS = 3600 * 1000;
const MIN_MS = 60 * 1000;
const PAUSA_MAX_MS = 24 * HORA_MS;
const BIGINT_CAMPOS = ["order_id", "operation_id", "payment_id", "detail_id", "document_id", "pack_id", "shipping_id", "charge_bonified_id", "id"];

function inteiro(v, padrao, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, n));
}

function configConciliacao(env = process.env) {
  return {
    loteMax: inteiro(env.SENTINEL_CONCILIACAO_LOTE, LOTE_MAX_ML, 1, LOTE_MAX_ML),
    maxPedidosConta: inteiro(env.SENTINEL_CONCILIACAO_MAX_PEDIDOS_CONTA, 60, 1, 600),
    maxChamadasExecucao: inteiro(env.SENTINEL_CONCILIACAO_MAX_CHAMADAS_EXECUCAO, 20, 1, 500),
    maxChamadasConta: inteiro(env.SENTINEL_CONCILIACAO_MAX_CHAMADAS_CONTA, 8, 1, 200),
    janelaDias: inteiro(env.SENTINEL_CONCILIACAO_JANELA_DIAS, 30, 1, 365),
    maturidadeHoras: inteiro(env.SENTINEL_CONCILIACAO_MATURIDADE_HORAS, 6, 1, 24 * 30),
    reconsultaHoras: inteiro(env.SENTINEL_CONCILIACAO_RECONSULTA_HORAS, 24, 1, 24 * 30),
    reconsultaNaoConciliadoHoras: inteiro(env.SENTINEL_CONCILIACAO_RECONSULTA_NAO_CONCILIADO_HORAS, 12, 1, 24 * 30),
    maxObservacoes: inteiro(env.SENTINEL_CONCILIACAO_MAX_RECONSULTAS, 10, 1, 100),
    maxFalhas: inteiro(env.SENTINEL_CONCILIACAO_MAX_FALHAS, 5, 1, 50),
    backoffFalhaMs: inteiro(env.SENTINEL_CONCILIACAO_BACKOFF_FALHA_MIN, 60, 1, 24 * 60) * MIN_MS,
    pausa429Ms: inteiro(env.SENTINEL_CONCILIACAO_PAUSA_429_MIN, 30, 1, 24 * 60) * MIN_MS,
    intervaloEntreChamadasMs: inteiro(env.SENTINEL_CONCILIACAO_INTERVALO_CHAMADAS_MS, 1000, 0, 60000),
    execucaoMaxMs: inteiro(env.SENTINEL_CONCILIACAO_EXECUCAO_MAX_MS, 120000, 1000, 3600000),
  };
}

// ── políticas PURAS ──────────────────────────────────────────────────────────────────────────────

// Depois de uma observação do Billing bem-sucedida: o que fazer com o pedido.
//   comprovada/divergente + documento definitivo  ⇒ concluida (sem reconsulta)
//   comprovada/divergente + documento provisório  ⇒ reconsultar em reconsultaHoras (até maxObservacoes ⇒ esgotada)
//   NAO_CONCILIADO com bloqueio/motivo transitório ⇒ reconsultar em reconsultaNaoConciliadoHoras (até o limite)
//   NAO_CONCILIADO só por ESCOPO estável (cupom, cashback, reembolso…) ⇒ concluida (refeita só se o pedido mudar)
function politicaAposObservacao(res, anterior, { hash, cfg, agoraMs }) {
  const mesmoPedido = anterior && anterior.tem_conciliacao && anterior.pedido_payload_hash === (hash || null);
  const observacoes = (mesmoPedido ? Number(anterior.observacoes) || 0 : 0) + 1;
  const reconsultar = (horas) => (observacoes >= cfg.maxObservacoes
    ? { status: "esgotada", proximaMs: null, observacoes }
    : { status: "reconsultar", proximaMs: agoraMs + horas * HORA_MS, observacoes });
  if (res.estado !== "NAO_CONCILIADO") {
    if (res.faturamento.definitivo === true) return { status: "concluida", proximaMs: null, observacoes };
    return reconsultar(cfg.reconsultaHoras);
  }
  const instavel = res.motivos.some((m) => CATEGORIA_MOTIVO[m] === "bloqueio" || MOTIVOS_TRANSITORIOS.includes(m));
  if (instavel) return reconsultar(cfg.reconsultaNaoConciliadoHoras);
  return { status: "concluida", proximaMs: null, observacoes };
}

// Falha de coleta: backoff exponencial (base × 2^(n−1), teto 24 h); após maxFalhas ⇒ esgotada.
function politicaFalha(anterior, { hash, cfg, agoraMs }) {
  const mesmoPedido = anterior && anterior.tem_conciliacao && anterior.pedido_payload_hash === (hash || null);
  const falhas = (mesmoPedido ? Number(anterior.falhas_consecutivas) || 0 : 0) + 1;
  if (falhas >= cfg.maxFalhas) return { status: "esgotada", proximaMs: null, falhas };
  return { status: "falha", proximaMs: agoraMs + Math.min(PAUSA_MAX_MS, cfg.backoffFalhaMs * 2 ** (falhas - 1)), falhas };
}

// 429: a maior entre Retry-After e base × 2^(ocorrências anteriores), teto 24 h.
function duracaoPausa429({ retryAfterSeg, ocorrenciasAnteriores, cfg }) {
  const exp = cfg.pausa429Ms * 2 ** Math.min(10, Math.max(0, Number(ocorrenciasAnteriores) || 0));
  const ra = Number.isFinite(Number(retryAfterSeg)) && Number(retryAfterSeg) > 0 ? Number(retryAfterSeg) * 1000 : 0;
  return Math.min(PAUSA_MAX_MS, Math.max(exp, ra));
}

// Resposta/erro do ML → classe. Nunca lança.
function classificar(resp, err) {
  if (err) {
    if (err.code === "SENTINEL_TOKEN_INDISPONIVEL" || err.code === "ML_TOKEN_EXPIRED") return "token";
    if (err.code === "SENTINEL_ORCAMENTO_CHAMADAS") return "orcamento";
    if (err.name === "MlTimeoutError") return "timeout";
    return "erro";
  }
  const s = Number(resp?.status);
  if (s === 200) return resp.data && typeof resp.data === "object" ? "ok" : "erro";
  if (s === 206) return "parcial";
  if (s === 429) return "limite";
  if (s === 401) return "token";
  if (s === 403) return "proibido";
  if (s === 404) return "nao_encontrado";
  if (s >= 500) return "erro_servidor";
  return "erro";
}

// Só o que o conciliador lê de /orders/{id}/discounts. Formato inesperado ⇒ null (= não verificado, nunca "sem desconto").
function compactarDescontos(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.details)) return null;
  return {
    details: data.details.slice(0, 20).filter((d) => d && typeof d === "object").map((d) => ({
      type: typeof d.type === "string" ? d.type.slice(0, 30) : null,
      supplier: { funding_mode: typeof d.supplier?.funding_mode === "string" ? d.supplier.funding_mode.slice(0, 30) : null },
      items: (Array.isArray(d.items) ? d.items : []).slice(0, 20).filter(Boolean).map((i) => ({
        id: i.id ?? null, variation_id: i.variation_id ?? null, quantity: i.quantity ?? null,
        amounts: { total: i.amounts?.total ?? null, seller: i.amounts?.seller ?? null },
      })),
    })),
  };
}

// Pedido mínimo a partir da linha do Sentinel (1 item, quantidade 1 — garantido pela seleção). A "sale_fee" comparada é a
// COMISSÃO OFICIAL do motor: no S1-A ela coincidiu com order_items[].sale_fee em 6/6 — é ela que a margem usa.
function pedidoDaLinha(linha) {
  const item = Array.isArray(linha.itens) ? linha.itens[0] || {} : {};
  return {
    id: String(linha.pedido_id),
    status: linha.status_ml,
    order_items: [{ item: { id: item.item_id ?? null, variation_id: item.variation_id ?? null }, quantity: item.quantidade, sale_fee: linha.comissao }],
  };
}

function centavosComissao(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const pedacos = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();

// ── uma conta ────────────────────────────────────────────────────────────────────────────────────
// ctl: estado COMPARTILHADO da execução { chamadas, maxChamadas, parar429, deadlineMs, pausaOcorrencias }
async function processarContaConciliacao(contaId, deps) {
  const { db, dbW, cfg, agoraMs, ctl, verificar } = deps;
  const resolverConta = deps.resolverConta || resolverContaPadrao;
  const dormirFn = deps.dormir || dormir;
  const resumo = {
    contaId, candidatos: 0, lotes: 0, chamadasBilling: 0, chamadasDescontos: 0, gravados: 0, falhas: 0,
    porEstado: {}, parada: null, erro: null,
  };
  let ctx;
  try {
    ctx = await resolverConta(contaId, db);
    if (!ctx || !ctx.sellerId) throw Object.assign(new Error("Conta sem seller Mercado Livre."), { code: "SENTINEL_SEM_SELLER" });
  } catch (err) {
    resumo.parada = "conta_indisponivel";
    resumo.erro = `${err.code || "ERRO"}: ${String(err.message).slice(0, 200)}`;
    return resumo;
  }

  const candidatos = await repo.selecionarCandidatos(db, contaId, {
    agoraIso: iso(agoraMs), janelaDias: cfg.janelaDias, maturidadeHoras: cfg.maturidadeHoras, limite: cfg.maxPedidosConta,
  });
  resumo.candidatos = candidatos.length;
  if (!candidatos.length) return resumo;

  const escopo = criarEscopoMl({ maxChamadas: cfg.maxChamadasConta });
  const mlFetch = criarMlFetchSentinel({ base: deps.mlFetchBase, escopo });
  let primeiraChamada = true;
  // Toda chamada passa por aqui: orçamento (execução e conta), prazo, 429 global; espaçamento entre chamadas.
  const chamar = async (path) => {
    if (ctl.parar429) return { classe: "limite_ativo" };
    if (ctl.chamadas >= ctl.maxChamadas) return { classe: "orcamento" };
    if (escopo.chamadas >= escopo.maxChamadas) return { classe: "orcamento" };
    if (Date.now() > ctl.deadlineMs) return { classe: "prazo" };
    if (!primeiraChamada && cfg.intervaloEntreChamadasMs > 0) await dormirFn(cfg.intervaloEntreChamadasMs);
    primeiraChamada = false;
    ctl.chamadas += 1;
    let resp = null;
    let err = null;
    try {
      resp = await mlFetch(ctx.clienteId, path, { mlUserId: ctx.sellerId, bigIntFields: BIGINT_CAMPOS });
    } catch (e) { err = e; }
    if (err && err.code === "SENTINEL_ORCAMENTO_CHAMADAS") ctl.chamadas -= 1; // não saiu do processo
    const classe = classificar(resp, err);
    if (classe === "limite") await pausar429(resp?.retryAfter);
    return { classe, resp, status: resp?.status ?? null, erro: err ? `${err.code || err.name || "ERRO"}` : null };
  };
  const pausar429 = async (retryAfterSeg) => {
    ctl.parar429 = true;
    const dur = duracaoPausa429({ retryAfterSeg, ocorrenciasAnteriores: ctl.pausaOcorrencias, cfg });
    await verificar();
    await repo.registrarPausa(dbW, { ateIso: iso(Date.now() + dur), motivo: `HTTP 429 do ML (conta ${contaId})`, agoraIso: iso(Date.now()) });
    console.warn(`[sentinel-conciliacao] 429 do ML: novas chamadas suspensas por ${Math.round(dur / 60000)} min (todas as contas).`);
  };
  const falharLote = async (linhas, motivo) => {
    await verificar();
    for (const l of linhas) {
      const p = politicaFalha(l, { hash: l.payload_hash, cfg, agoraMs });
      await repo.registrarFalha(dbW, contaId, l.pedido_id, { hash: l.payload_hash, status: p.status, falhas: p.falhas,
        proximaIso: p.proximaMs ? iso(p.proximaMs) : null, erro: motivo, agoraIso: iso(agoraMs) });
      resumo.falhas += 1;
    }
  };
  const PARADAS = { limite: "limite_429", limite_ativo: "limite_429", token: "token_indisponivel", proibido: "sem_permissao_billing",
    orcamento: "orcamento", prazo: "prazo" };

  for (const lote of pedacos(candidatos, cfg.loteMax)) {
    if (resumo.parada) break;
    const ids = lote.map((l) => String(l.pedido_id));
    const r = await chamar(`/billing/integration/group/ML/order/details?order_ids=${ids.join(",")}`);
    if (PARADAS[r.classe]) { resumo.parada = PARADAS[r.classe]; break; } // nada gravado: o lote volta na próxima execução
    resumo.lotes += 1;
    resumo.chamadasBilling += 1;
    const errosLote = r.classe === "ok" && Array.isArray(r.resp.data.errors) && r.resp.data.errors.length > 0;
    if (r.classe !== "ok" || errosLote) {
      // 206/5xx/timeout/404/errors[]: falha do LOTE inteiro (o formato de errors[] por pedido não foi observado ⇒ conservador).
      await falharLote(lote, errosLote ? "billing_errors" : `billing_${r.classe}${r.status ? `_${r.status}` : ""}`);
      resumo.parada = `billing_${r.classe}`;
      break;
    }
    await verificar();
    await repo.zerarOcorrencias(dbW);
    ctl.pausaOcorrencias = 0;
    const resultados = Array.isArray(r.resp.data.results) ? r.resp.data.results : [];
    const porPedido = new Map();
    for (const reg of resultados) {
      const k = reg && reg.order_id !== undefined && reg.order_id !== null ? String(reg.order_id) : null;
      if (!k) continue;
      if (!porPedido.has(k)) porPedido.set(k, []);
      porPedido.get(k).push(reg);
    }

    for (const linha of lote) {
      const pid = String(linha.pedido_id);
      const regs = porPedido.get(pid) || [];
      // descontos: reaproveita o que já foi lido (não muda para pedido pago de 1 item); só consulta com registro de Billing.
      let descontosMin = linha.descontos_min || null;
      let descontosConsultadoEm = null;
      if (!descontosMin && regs.length) {
        // Sem orçamento/prazo/429/token, a consulta NÃO aconteceu: o pedido não é gravado (nem gasta uma observação) e
        // volta inteiro na próxima execução. Só uma tentativa REAL que falha (404, 5xx, timeout) conta como observação.
        if (resumo.parada) { resumo.adiados = (resumo.adiados || 0) + 1; continue; }
        const d = await chamar(`/orders/${pid}/discounts`);
        if (PARADAS[d.classe]) { resumo.parada = PARADAS[d.classe]; resumo.adiados = (resumo.adiados || 0) + 1; continue; }
        resumo.chamadasDescontos += 1;
        if (d.classe === "ok") {
          descontosMin = compactarDescontos(d.resp.data);
          if (descontosMin) descontosConsultadoEm = iso(agoraMs);
        }
      }
      const res = conciliarComissaoPedido({
        pedido: pedidoDaLinha(linha),
        descontos: descontosMin,
        billing: { results: regs, errors: [] },
        conta: { id: contaId, sellerId: ctx.sellerId },
        origem_billing: { contaId },
      });
      const pol = politicaAposObservacao(res, linha, { hash: linha.payload_hash, cfg, agoraMs });
      await verificar();
      const g = await repo.gravarConciliacao(dbW, contaId, pid, res, {
        comissaoCentavos: centavosComissao(linha.comissao), descontosMin: descontosConsultadoEm ? descontosMin : null,
        descontosConsultadoEm, hash: linha.payload_hash, status: pol.status, observacoes: pol.observacoes,
        proximaIso: pol.proximaMs ? iso(pol.proximaMs) : null, agoraIso: iso(agoraMs),
      });
      if (g.gravado) {
        resumo.gravados += 1;
        resumo.porEstado[res.estado] = (resumo.porEstado[res.estado] || 0) + 1;
      }
    }
  }
  return resumo;
}

// ── uma execução ─────────────────────────────────────────────────────────────────────────────────
// deps: { db (obrigatório), contaIds (obrigatório; allowlist), mlFetchBase, resolverConta, criarClient, dormir,
//         agoraMs, config, deveParar, dbEscrita (teste) }
async function executarColeta({ contaIds, ...deps } = {}) {
  const db = deps.db;
  if (!db || typeof db.query !== "function") throw Object.assign(new Error("Coletor exige `db` explícito."), { code: "SENTINEL_DB_OBRIGATORIO" });
  const ids = [...new Set((contaIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return { executado: false, motivo: "sem_contas", contas: [] };
  if (!(await conciliacaoSchemaPronto(db))) {
    console.warn("[sentinel-conciliacao] tabelas da migration 20261119 ausentes: conciliação suspensa (nenhuma chamada ao ML).");
    return { executado: false, motivo: "schema_ausente", contas: [] };
  }
  const cfg = { ...configConciliacao(), ...(deps.config || {}) };
  const agoraMs = deps.agoraMs ?? Date.now();
  const inicio = Date.now();
  const contas = [];
  let abortado = null;
  let pausa = null;
  let chamadas = 0;
  let parou429 = false;
  const lock = await comLockDoCiclo(async ({ verificar, dbEscrita }) => {
    const dbW = deps.dbEscrita || dbEscrita;
    const p = await repo.lerPausa(db);
    if (p.pausado_ate && new Date(p.pausado_ate).getTime() > Date.now()) {
      pausa = { ate: new Date(p.pausado_ate).toISOString(), ocorrencias: p.ocorrencias };
      return;
    }
    const ctl = { chamadas: 0, maxChamadas: cfg.maxChamadasExecucao, parar429: false, deadlineMs: inicio + cfg.execucaoMaxMs,
      pausaOcorrencias: Number(p.ocorrencias) || 0 };
    try {
      for (const id of ids) {
        if (ctl.parar429) break;
        if (deps.deveParar && deps.deveParar()) break;
        if (ctl.chamadas >= ctl.maxChamadas || Date.now() > ctl.deadlineMs) break;
        await verificar();
        contas.push(await processarContaConciliacao(id, { ...deps, db, dbW, cfg, agoraMs, ctl, verificar }));
      }
    } catch (err) {
      if (err && err.code === "SENTINEL_LOCK_PERDIDO") abortado = err.message;
      else throw err;
    }
    chamadas = ctl.chamadas;
    parou429 = ctl.parar429;
  }, { criarClient: deps.criarClient, chave: CONCILIACAO_LOCK_KEY });
  if (lock.pulado) {
    console.log("[sentinel-conciliacao] execução pulada: outra instância detém o lock da conciliação.");
    return { executado: false, motivo: "lock_ocupado", contas: [] };
  }
  if (pausa) {
    console.log(`[sentinel-conciliacao] em pausa por 429 até ${pausa.ate}: nenhuma chamada.`);
    return { executado: false, motivo: "pausa_429", pausa, contas: [] };
  }
  const gravados = contas.reduce((s, c) => s + c.gravados, 0);
  console.log(`[sentinel-conciliacao] execução ${abortado ? "ABORTADA" : "concluída"}: ${contas.length} conta(s), ${chamadas} chamada(s) ao ML, ${gravados} conciliação(ões) gravada(s), ${Date.now() - inicio}ms`);
  return { executado: true, abortado, chamadas, parou429, contas };
}

module.exports = {
  CONCILIACAO_LOCK_KEY,
  LOTE_MAX_ML,
  configConciliacao,
  politicaAposObservacao,
  politicaFalha,
  duracaoPausa429,
  classificar,
  compactarDescontos,
  pedidoDaLinha,
  processarContaConciliacao,
  executarColeta,
};
