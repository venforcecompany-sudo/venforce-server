// server/services/motorMargem/precificacao/precificacaoService.js
// Camada SEGURA de precificação da Central de Margem.
//
//   Central → simular (ao vivo, sem persistir; estimativas marcadas)
//           → preview (recalcula no backend em modo ESCRITA + gates +
//             fingerprint; persiste a intenção)
//           → confirmação humana (o MESMO usuário, devolvendo o fingerprint)
//           → aplicar:
//               rollout → idempotência → autor → fingerprint da confirmação
//               → reconcilia leases vencidos → claim (token + lease; 1 por
//               item; recusado se houve escrita depois do preview)
//               → REAVALIA TUDO ao vivo (com prazo) → heartbeat
//               → fingerprint ao vivo == fingerprint do preview?
//               → escritor existente com gancho antes do envio:
//                   [promoção] mesma promoção, mesma ação, mesmo preço atual
//                              (modo preco: aplicarPromocao com deal_price;
//                               modo aceite: participarPromocaoAceite, no
//                               preço SUGERIDO pelo ML — nunca um digitado)
//                   [preço]    preço efetivo lido logo antes == preço visto
//                   fencing: renova o lease pelo token + marca o envio
//                   envio com prazo local DENTRO do lease (deadlineAt)
//               → desfecho gravado SÓ pelo dono do token
//               → preço confirmado ≠ solicitado: 'divergente' + margem
//                 recalculada sobre o CONFIRMADO
//               → refresh do snapshot DURÁVEL (a linha é o job): só vira
//                 'atualizado' quando o snapshot contém o preço confirmado
//
// Não chama o endpoint de /anuncios: usa os MESMOS serviços que ele usa
// (meliPrecoService / meliPromocoesEscritaService) por parâmetros opt-in.
// /anuncios não muda.

const crypto = require("crypto");
const { modoEscritaPromocao } = require("../../meliAnuncios/promocaoTiposSuportados");
const avaliacao = require("./precificacaoAvaliacao");
const { escritaHabilitada, promocaoEscritaStatus, resolvePricingConfig } = require("./precificacaoConfig");
const fingerprintLib = require("./precificacaoFingerprint");

const { erroHttp, validarPreco, mesmoPreco, codigoDoGate } = avaliacao;

// Recusas ANTES de qualquer escrita (bloqueios do próprio escritor, da
// releitura ou do fencing) — viram `recusado`, não `falhou`.
const CODIGOS_RECUSA_SERVICO = new Set([
  "PRECO_ITEM_COM_VARIACAO",
  "PRECO_ITEM_COM_PROMOCAO",
  "PRECO_INVALIDO",
  "PRECO_AUSENTE",
  "PRECO_ALTERADO",
  "PRECO_ATUAL_INDISPONIVEL",
  "TIPO_SEM_ESCRITA",
  "PROMOCAO_NAO_ENCONTRADA",
  "PROMOCAO_NAO_APLICADA",
  "PROMOCAO_MUDOU",
  "PROMOCAO_INTENCAO_MUDOU",
  "ML_TIMEOUT_LEITURA",
  // participarPromocaoAceite (modo aceite): recusas da releitura, nada enviado.
  "PROMOCAO_JA_PARTICIPA",
  "OFFER_ID_AUSENTE",
  "TIPO_SEM_ACEITE",
  "ABAIXO_FRETE_GRATIS",
]);

// Não enviados por falta de prazo/posse: `falhou` (comprovadamente sem escrita).
const CODIGOS_NAO_ENVIADO = new Set(["FENCING_PERDIDO", "ML_DEADLINE_EXCEEDED", "ML_ABORTED"]);

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{8,100}$/;

function defaults(deps = {}) {
  return {
    repo: deps.repo || require("./precificacaoRepository"),
    atualizarPreco: deps.atualizarPreco || require("../../meliAnuncios/meliPrecoService").atualizarPreco,
    aplicarPromocao: deps.aplicarPromocao || require("../../meliAnuncios/meliPromocoesEscritaService").aplicarPromocao,
    participarPromocaoAceite:
      deps.participarPromocaoAceite || require("../../meliAnuncios/meliPromocoesEscritaService").participarPromocaoAceite,
    atualizarCamposConfirmados:
      deps.atualizarCamposConfirmados || require("../../meliAnuncios/meliAnunciosService").atualizarCamposConfirmados,
    registrarLog: deps.registrarLog || require("../../activityLogService").registrarLog,
    atualizarSnapshotDoItem: deps.atualizarSnapshotDoItem || require("./precificacaoSnapshotItem").atualizarSnapshotDoItem,
    resolverContaDoCliente: deps.resolverContaDoCliente || require("../marginSnapshotApiService").resolverContaDoCliente,
    listarPromocoesDoItem:
      deps.listarPromocoesDoItem || require("../../meliAnuncios/meliPromocoesService").listarPromocoesDoItem,
    lerPrecoAtual: deps.lerPrecoAtual || require("../../automacoes/precoItemService").resolverPrecosItem,
    agendar: deps.agendar || ((fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; }),
    leituraSnapshotHabilitada:
      deps.leituraSnapshotHabilitada || require("../marginSnapshotReadService").leituraHabilitada,
    novoToken: deps.novoToken || (() => crypto.randomUUID()),
    relogio: deps.relogio || (() => performance.now()),
    // Quem pode participar de promoção: admin ou coordenador do squad do cliente.
    podeEscreverPromocao: deps.podeEscreverPromocao || papelPodeEscreverPromocao,
    env: deps.env || process.env,
    now: deps.now || (() => new Date()),
  };
}

const MOTIVO_PAPEL_PROMOCAO = "Seu perfil não pode participar de promoções: só admin ou coordenador do squad do cliente.";

/**
 * Escrever em promoção é restrito a admin ou ao COORDENADOR (função de squad ativa) do squad
 * que atende o cliente. O acesso à conta (carteira) já foi garantido pela rota.
 * @returns {Promise<{ ok:boolean, papel:string|null }>}
 */
async function papelPodeEscreverPromocao({ user, clienteId }, db) {
  if (!user || user.id === null || user.id === undefined) return { ok: false, papel: null };
  if (String(user.role || "").toLowerCase() === "admin") return { ok: true, papel: "admin" };
  const squads = require("../../squads/squadsRepository");
  const atual = await squads.squadAtivoDoCliente(clienteId, db);
  if (atual && (await squads.ehCoordenadorDoSquad(user.id, atual.squad_id, db))) return { ok: true, papel: "coordenador" };
  return { ok: false, papel: null };
}

function comPrazo(promessa, ms, codigo = "REAVALIACAO_TIMEOUT") {
  if (!ms) return promessa;
  let timer;
  return Promise.race([
    promessa,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error("A releitura ao vivo não terminou a tempo. Nada foi enviado ao Mercado Livre.");
        err.code = codigo;
        err.name = "MlTimeoutError";
        err.enviado = false;
        reject(err);
      }, ms);
      if (timer && timer.unref) timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Cache curto do contexto — SÓ para a simulação durante a digitação e para a
// lista de promoções. Preview e aplicar sempre releem ao vivo.
// ---------------------------------------------------------------------------
const cacheContexto = new Map();

function chaveCache(clienteSlug, clienteContaId, itemId) {
  return `${String(clienteSlug).toLowerCase()}::${clienteContaId}::${String(itemId).toUpperCase()}`;
}

function contextoComCache(params, deps, ttlMs) {
  if (!ttlMs) return avaliacao.carregarContexto(params, deps);
  const chave = chaveCache(params.clienteSlug, params.clienteContaId, params.itemId);
  const agora = Date.now();
  const hit = cacheContexto.get(chave);
  if (hit && hit.expira > agora) return hit.promessa;
  const promessa = avaliacao.carregarContexto(params, deps);
  cacheContexto.set(chave, { expira: agora + ttlMs, promessa });
  // Erro não fica em cache.
  promessa.catch(() => cacheContexto.delete(chave));
  return promessa;
}

function invalidarCache(clienteSlug, clienteContaId, itemId) {
  cacheContexto.delete(chaveCache(clienteSlug, clienteContaId, itemId));
}

// ---------------------------------------------------------------------------

function tipoValido(tipo) {
  const t = String(tipo || "PRICE").toUpperCase();
  if (t !== "PRICE" && t !== "PROMOTION") throw erroHttp(400, "TIPO_INVALIDO", "tipo deve ser PRICE ou PROMOTION.");
  return t;
}

function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

// Modo de escrita da promoção de uma aplicação: "preco" (DEAL/SELLER_CAMPAIGN) | "aceite" (o ML define o preço) | null.
function modoDaPromocao(row) {
  if (!row || row.tipoAcao !== "PROMOTION") return null;
  const modo = modoEscritaPromocao(row.promotionType);
  return modo ? modo.toLowerCase() : null;
}

async function promocaoAoVivo(base, promotionId, d) {
  const lista = await d.listarPromocoesDoItem({
    clienteId: base.cliente.id,
    itemId: base.anuncio.itemId,
    mlUserId: base.conta.mlUserId,
  });
  const promo = (lista || []).find((p) => String(p.id) === String(promotionId)) || null;
  return { promo, lista: lista || [] };
}

/** Avaliação completa (contexto + promoção + recotação + gates). */
async function avaliarCompleto({ base, tipo, novoPreco, precoVisto, promotionId, modo }, deps, d) {
  let promo = null;
  let encontrada = true;
  if (tipo === "PROMOTION") {
    if (!promotionId) throw erroHttp(400, "PROMOTION_ID_AUSENTE", "Informe a promoção.");
    if (base.contaCorreta && base.motor) {
      const r = await promocaoAoVivo(base, promotionId, d);
      promo = r.promo;
      encontrada = Boolean(promo);
    }
  }
  let preco = novoPreco;
  if (tipo === "PROMOTION" && preco === null && promo && promo.precoFinal !== null && promo.precoFinal !== undefined) {
    preco = round2(promo.precoFinal);
  }
  const recote = base.contaCorreta && base.motor && preco !== null
    ? await avaliacao.recotar(base, preco, deps)
    : { comissao: null, comissaoFonte: "indisponivel", frete: null, freteFonte: "indisponivel" };
  const resultado = avaliacao.avaliar(
    { base, tipo, novoPreco: preco, precoVisto, recote, promocao: promo, promocaoEncontrada: encontrada, modo },
    deps
  );
  return { resultado, preco, promo };
}

// Rollout (e papel) da escrita para o tipo da avaliação: promoção tem flags e papel próprios.
function escritaPublica({ tipo, clienteSlug, env, papel }) {
  if (tipo === "PROMOTION") {
    const rollout = promocaoEscritaStatus({ clienteSlug }, env);
    if (!rollout.habilitada) return { habilitada: false, motivo: rollout.motivo, codigo: rollout.codigo };
    if (papel && papel.ok === false) return { habilitada: false, motivo: MOTIVO_PAPEL_PROMOCAO, codigo: "PAPEL_NAO_AUTORIZADO" };
    return { habilitada: true, motivo: null, codigo: null };
  }
  return escritaHabilitada({ clienteSlug }, env)
    ? { habilitada: true, motivo: null }
    : { habilitada: false, motivo: "Escrita no Mercado Livre desligada para este cliente (rollout). Simulação e preview seguem disponíveis." };
}

function publicoAvaliacao(base, resultado, { tipo, clienteSlug, env, papel = null }) {
  return {
    ok: true,
    tipo,
    modo: resultado.modo || "simulacao",
    item: {
      itemId: base.anuncio.itemId,
      titulo: base.anuncio.titulo,
      sku: base.anuncio.sku,
      statusAnuncio: base.anuncio.status,
    },
    conta: { id: base.conta.id, nome: base.conta.nome, mlUserId: base.conta.mlUserId },
    atual: resultado.atual,
    proposta: resultado.proposta,
    insumos: resultado.insumos || null,
    vendas: resultado.vendas || null,
    promocao: resultado.promocao,
    gates: resultado.gates,
    bloqueado: resultado.bloqueado,
    escrita: escritaPublica({ tipo, clienteSlug, env, papel }),
  };
}

/** Simulação AO VIVO para a digitação: nada é persistido, nada é escrito. */
async function simular(params = {}, deps = {}) {
  const d = defaults(deps);
  const config = resolvePricingConfig(d.env);
  const tipo = tipoValido(params.tipo);
  const v = validarPreco(params.novoPreco, { obrigatorio: tipo === "PRICE" });
  if (!v.ok) throw erroHttp(400, v.codigo, v.motivo);
  const visto = validarPreco(params.precoVisto, { campo: "precoVisto", obrigatorio: false });
  const base = await contextoComCache(
    { clienteSlug: params.clienteSlug, clienteContaId: params.clienteContaId, itemId: params.itemId },
    deps,
    config.simulacaoCacheMs
  );
  const { resultado } = await avaliarCompleto(
    { base, tipo, novoPreco: v.valor, precoVisto: visto.ok ? visto.valor : null, promotionId: params.promotionId, modo: "simulacao" },
    deps,
    d
  );
  return { ...publicoAvaliacao(base, resultado, { tipo, clienteSlug: base.cliente.slug, env: d.env }), simulado: true };
}

/** Preview confirmável: tudo relido ao vivo em modo ESCRITA + fingerprint persistido. */
async function preview(params = {}, deps = {}) {
  const d = defaults(deps);
  const config = resolvePricingConfig(d.env);
  const tipo = tipoValido(params.tipo);
  const v = validarPreco(params.novoPreco, { obrigatorio: tipo === "PRICE" });
  if (!v.ok) throw erroHttp(400, v.codigo, v.motivo);
  const visto = validarPreco(params.precoVisto, { campo: "precoVisto", obrigatorio: true });
  if (!visto.ok) throw erroHttp(400, visto.codigo === "PRECO_AUSENTE" ? "PRECO_VISTO_AUSENTE" : visto.codigo, "Informe o preço que a tela mostrou (precoVisto).");
  const user = params.user || {};
  if (user.id === null || user.id === undefined) throw erroHttp(401, "USUARIO_AUSENTE", "Usuário não identificado.");

  const depsVivos = { ...deps, mlTimeoutMs: config.mlTimeoutMs };
  const base = await avaliacao.carregarContexto(
    { clienteSlug: params.clienteSlug, clienteContaId: params.clienteContaId, itemId: params.itemId },
    depsVivos
  );
  const { resultado, preco, promo } = await avaliarCompleto(
    { base, tipo, novoPreco: v.valor, precoVisto: visto.valor, promotionId: params.promotionId, modo: "escrita" },
    depsVivos,
    d
  );
  const papel = tipo === "PROMOTION" ? await d.podeEscreverPromocao({ user, clienteId: base.cliente.id }, deps.db) : null;
  const publico = publicoAvaliacao(base, resultado, { tipo, clienteSlug: base.cliente.slug, env: d.env, papel });
  if (preco === null) return { ...publico, preview: null };

  const fingerprint = fingerprintLib.montarFingerprint({ base, tipo, precoVisto: visto.valor, precoSolicitado: preco, resultado, promo });
  const hash = fingerprintLib.hashFingerprint(fingerprint);
  const linha = await d.repo.inserirPreview(
    {
      clienteId: base.cliente.id,
      clienteSlug: base.cliente.slug,
      clienteContaId: base.conta.id,
      itemId: base.anuncio.itemId,
      titulo: base.anuncio.titulo,
      userId: user.id,
      userNome: user.nome || null,
      userEmail: user.email || null,
      tipoAcao: tipo,
      promotionId: tipo === "PROMOTION" ? String(params.promotionId) : null,
      promotionType: promo ? promo.tipo : null,
      promotionNome: promo ? promo.nome || promo.tipoLabel || null : null,
      promotionAcao: resultado.promocao && resultado.promocao.escrita ? resultado.promocao.escrita.acao : null,
      precoVisto: visto.valor,
      precoAnterior: resultado.atual ? resultado.atual.preco : null,
      precoSolicitado: preco,
      margemAntes: resultado.atual ? resultado.atual.margem : null,
      margemDepois: resultado.proposta ? resultado.proposta.margem : null,
      lucroAntes: resultado.atual ? resultado.atual.lucro : null,
      lucroDepois: resultado.proposta ? resultado.proposta.lucro : null,
      gates: resultado.gates,
      calculo: { atual: resultado.atual, proposta: resultado.proposta, insumos: resultado.insumos, promocao: resultado.promocao },
      previewFingerprint: hash,
      fingerprint,
      ttlMinutes: config.previewTtlMinutes,
    },
    deps.db
  );
  return { ...publico, preview: { id: linha.id, expiraEm: linha.expiraEm, fingerprint: hash } };
}

/** Situação da EXECUÇÃO para GET/polling (distingue viva × perdida × desconhecida). */
function execucaoDe(row) {
  if (!row) return null;
  if (row.status === "aplicando") return row.leaseValida === false ? "lease_expirado" : "viva";
  if (row.status === "resultado_desconhecido") return "resultado_desconhecido";
  if (row.status === "falhou" && row.erroCodigo === "APLICACAO_INTERROMPIDA_SEM_ESCRITA") return "processo_perdido";
  if (row.status === "preview") return "preview";
  return "finalizada";
}

function aplicacaoPublica(row) {
  if (!row) return null;
  return {
    id: row.id,
    itemId: row.itemId,
    titulo: row.titulo,
    tipoAcao: row.tipoAcao,
    promotionId: row.promotionId,
    promotionType: row.promotionType,
    promotionNome: row.promotionNome,
    promotionAcao: row.promotionAcao,
    promotionModo: modoDaPromocao(row),
    status: row.status,
    execucao: execucaoDe(row),
    precoVisto: row.precoVisto,
    precoAnterior: row.precoAnterior,
    precoSolicitado: row.precoSolicitado,
    precoConfirmado: row.precoConfirmado,
    margemAntes: row.margemAntes,
    margemDepois: row.margemDepois,
    lucroAntes: row.lucroAntes,
    lucroDepois: row.lucroDepois,
    atencaoCodigo: row.atencaoCodigo || null,
    gates: row.gates,
    erroCodigo: row.erroCodigo,
    erroMensagem: row.erroMensagem,
    mlStatus: row.mlStatus,
    leaseExpiraEm: row.leaseExpiraEm || null,
    escritaEnviadaEm: row.escritaEnviadaEm || null,
    resultadoTardio: row.resultadoTardio || null,
    snapshotStatus: row.snapshotStatus,
    snapshotAtualizadoEm: row.snapshotAtualizadoEm,
    snapshotPrecoObservado: row.snapshotPrecoObservado ?? null,
    snapshotTentativas: row.snapshotTentativas ?? 0,
    usuario: { id: row.userId, nome: row.userNome, email: row.userEmail },
    criadoEm: row.criadoEm,
    aplicadoEm: row.aplicadoEm,
  };
}

function statusHttpDeCodigo(codigo) {
  const m = /^ML_HTTP_(\d{3})$/.exec(String(codigo || ""));
  return m ? Number(m[1]) : null;
}

function ehRateLimit(codigo) {
  return /too_many|rate_limit|ML_HTTP_429|ML_RATE_LIMIT/i.test(String(codigo || ""));
}

function mesmoAutor(linha, user) {
  return Boolean(user && user.id !== null && user.id !== undefined && linha.userId !== null && linha.userId !== undefined &&
    String(user.id) === String(linha.userId));
}

function exigirAutor(linha, user) {
  if (!mesmoAutor(linha, user)) {
    throw erroHttp(403, "PREVIEW_DE_OUTRO_USUARIO", "Somente quem gerou este preview pode aplicá-lo. Gere o seu próprio preview.");
  }
}

function respostaReplay(row) {
  const ok = row.status === "aplicado" || row.status === "divergente";
  return {
    ok,
    replay: true,
    aplicacao: aplicacaoPublica(row),
    divergente: row.status === "divergente",
    codigo: ok ? null : row.status === "aplicando" ? "APLICACAO_EM_ANDAMENTO" : row.erroCodigo,
    motivo: ok ? null : row.status === "aplicando" ? "Esta aplicação ainda está em curso." : row.erroMensagem,
  };
}

/** Aplica UM preview. Idempotente pela chave; nunca escreve com gate bloqueado nem sem fencing válido. */
async function aplicar(params = {}, deps = {}) {
  const d = defaults(deps);
  const config = resolvePricingConfig(d.env);
  const idempotencyKey = String(params.idempotencyKey || "").trim();
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    throw erroHttp(400, "IDEMPOTENCY_KEY_INVALIDA", "Informe uma chave de idempotência (8 a 100 caracteres).");
  }
  const previewId = Number(params.previewId);
  if (!Number.isInteger(previewId) || previewId <= 0) throw erroHttp(400, "PREVIEW_ID_INVALIDO", "Informe o preview a aplicar.");
  const fingerprintConfirmado = String(params.fingerprint || "").trim().toLowerCase();
  if (!fingerprintLib.FINGERPRINT_RE.test(fingerprintConfirmado)) {
    throw erroHttp(400, "PREVIEW_FINGERPRINT_AUSENTE", "Informe o fingerprint do preview confirmado.");
  }
  const user = params.user || {};

  const { cliente, conta } = await d.resolverContaDoCliente(
    { clienteSlug: params.clienteSlug, clienteContaId: params.clienteContaId },
    deps
  );

  // Replay: mesma chave → mesma resposta, nunca uma 2ª escrita.
  let existente = await d.repo.obterPorIdempotencia(idempotencyKey, deps.db);
  if (existente) {
    if (existente.id !== previewId || existente.clienteContaId !== Number(conta.id)) {
      throw erroHttp(409, "IDEMPOTENCY_KEY_EM_USO", "Esta chave de idempotência já foi usada em outra aplicação.");
    }
    exigirAutor(existente, user);
    if (existente.status === "aplicando") {
      // Nunca "aplicando" para sempre: lease vencido (+ carência) é
      // reconciliado aqui, respeitando o fencing (sem reescrever).
      await d.repo.reconciliarLeasesVencidos({ id: existente.id, graceSeconds: config.carenciaLeaseSegundos }, deps.db);
      existente = (await d.repo.obterPorId({ id: existente.id, clienteContaId: conta.id }, deps.db)) || existente;
    }
    return respostaReplay(existente);
  }

  const linha = await d.repo.obterPorId({ id: previewId, clienteContaId: conta.id }, deps.db);
  if (!linha || linha.clienteId !== Number(cliente.id)) throw erroHttp(404, "PREVIEW_NAO_ENCONTRADO", "Preview não encontrado para esta conta.");
  // Rota por promoção (/promocoes/:promotionId/aplicar): o preview tem de ser
  // DESTA promoção — nunca aplicar a intenção de outra linha.
  if (params.promotionId !== undefined && params.promotionId !== null && String(linha.promotionId) !== String(params.promotionId)) {
    throw erroHttp(409, "PREVIEW_DE_OUTRA_PROMOCAO", "Este preview não pertence a esta promoção.");
  }
  // Autorização: o id sequencial nunca basta — só o autor aplica.
  exigirAutor(linha, user);
  if (linha.status !== "preview") {
    throw erroHttp(409, "PREVIEW_JA_UTILIZADO", "Este preview já foi usado. Gere um novo preview.", { aplicacao: aplicacaoPublica(linha) });
  }
  // A confirmação tem de ser DESTE preview (o que a tela mostrou).
  if (!linha.previewFingerprint || linha.previewFingerprint !== fingerprintConfirmado) {
    throw erroHttp(409, "PREVIEW_FINGERPRINT_DIVERGENTE", "A confirmação não corresponde ao preview gerado. Gere um novo preview.");
  }

  // Rollout: com a escrita desligada nada é tocado — nem a linha, nem o ML. Promoção tem flags
  // próprias (MARGIN_PROMO_WRITE_*: chave geral + lista de clientes do piloto) e papel restrito.
  if (linha.tipoAcao === "PROMOTION") {
    const rollout = promocaoEscritaStatus({ clienteSlug: cliente.slug }, d.env);
    if (!rollout.habilitada) throw erroHttp(403, rollout.codigo, `${rollout.motivo} Nenhuma alteração foi enviada.`);
    const papel = await d.podeEscreverPromocao({ user, clienteId: cliente.id }, deps.db);
    if (!papel.ok) throw erroHttp(403, "PAPEL_NAO_AUTORIZADO", `${MOTIVO_PAPEL_PROMOCAO} Nenhuma alteração foi enviada.`);
  } else if (!escritaHabilitada({ clienteSlug: cliente.slug }, d.env)) {
    throw erroHttp(403, "ESCRITA_DESABILITADA", "Escrita no Mercado Livre desligada para este cliente (rollout). Nenhuma alteração foi enviada.");
  }

  if (new Date(linha.expiraEm).getTime() <= d.now().getTime()) {
    const recusada = await d.repo.recusarPreview({ id: linha.id, clienteContaId: conta.id, erroCodigo: "PREVIEW_EXPIRADO", erroMensagem: "O preview expirou. Gere um novo preview." }, deps.db);
    throw erroHttp(409, "PREVIEW_EXPIRADO", "O preview expirou. Gere um novo preview.", { aplicacao: aplicacaoPublica(recusada) });
  }
  if ((linha.gates || []).some((g) => g && g.tom === "block")) {
    const recusada = await d.repo.recusarPreview({ id: linha.id, clienteContaId: conta.id, erroCodigo: "PREVIEW_BLOQUEADO", erroMensagem: "Este preview tinha bloqueios e não pode ser aplicado." }, deps.db);
    throw erroHttp(409, "PREVIEW_BLOQUEADO", "Este preview tinha bloqueios e não pode ser aplicado.", { aplicacao: aplicacaoPublica(recusada) });
  }

  await d.repo.reconciliarLeasesVencidos({ clienteContaId: conta.id, itemId: linha.itemId, graceSeconds: config.carenciaLeaseSegundos }, deps.db);

  const claimToken = d.novoToken();
  let claim;
  try {
    claim = await d.repo.reivindicar({ id: linha.id, clienteContaId: conta.id, idempotencyKey, claimToken, leaseSeconds: config.leaseSegundos }, deps.db);
  } catch (err) {
    if (err && err.name === "PrecificacaoConflitoError") {
      if (err.code === "PREVIEW_SUPERADO") {
        const recusada = await d.repo.recusarPreview({ id: linha.id, clienteContaId: conta.id, erroCodigo: err.code, erroMensagem: err.message }, deps.db);
        throw erroHttp(409, err.code, err.message, { aplicacao: aplicacaoPublica(recusada), novoPreviewNecessario: true });
      }
      throw erroHttp(409, err.code, err.message);
    }
    throw err;
  }
  if (!claim) {
    // Corrida: outro request com a MESMA chave pode ter vencido o claim.
    const venceu = await d.repo.obterPorIdempotencia(idempotencyKey, deps.db);
    if (venceu && venceu.id === linha.id) return respostaReplay(venceu);
    throw erroHttp(409, "PREVIEW_JA_UTILIZADO", "Este preview já foi usado ou expirou. Gere um novo preview.");
  }

  const modoPromocao = modoDaPromocao(claim);
  // Veredito/LC da reavaliação ao vivo (preenchido logo abaixo): vai para a auditoria.
  let vereditoAuditoria = null;

  const logBase = {
    userId: user.id ?? null,
    userEmail: user.email || null,
    userNome: user.nome || null,
    ip: params.ip || null,
    acao: claim.tipoAcao === "PROMOTION" ? "central_margem_promocao_aplicar" : "central_margem_preco_aplicar",
  };

  async function registrarAuditoria(row, status, extra) {
    await d.registrarLog({
      ...logBase,
      status: status === "aplicado" || status === "divergente" ? "sucesso" : "erro",
      detalhes: {
        aplicacaoId: claim.id,
        cliente: cliente.slug,
        clienteContaId: Number(conta.id),
        itemId: claim.itemId,
        tipo: claim.tipoAcao,
        promotionId: claim.promotionId,
        promotionAcao: claim.promotionAcao,
        promotionModo: modoPromocao,
        status,
        precoVisto: claim.precoVisto,
        precoSolicitado: claim.precoSolicitado,
        promotionType: claim.promotionType || null,
        promotionNome: claim.promotionNome || null,
        precoConfirmado: extra.precoConfirmado ?? null,
        margemAntes: claim.margemAntes,
        margemDepois: row ? row.margemDepois : null,
        lucroAntes: claim.lucroAntes ?? null,
        lucroDepois: row ? row.lucroDepois ?? null : null,
        veredito: vereditoAuditoria,
        atencaoCodigo: (row && row.atencaoCodigo) || extra.atencaoCodigo || null,
        erroCodigo: extra.erroCodigo || null,
      },
    });
  }

  // Desfecho: SÓ o dono do token grava. Fencing obsoleto → a resposta vira
  // evidência tardia e esta execução deixa de ser dona.
  async function finalizar(status, extra) {
    const final = await d.repo.finalizar({ id: claim.id, claimToken, status, ...extra }, deps.db);
    if (!final) {
      const tardio = await d.repo.registrarResultadoTardio({
        id: claim.id,
        claimToken,
        resultado: { status: extra.mlStatus ?? null, codigo: extra.erroCodigo || null, motivo: extra.erroMensagem || null, preco: extra.precoConfirmado ?? null, resultadoLocal: status },
      }, deps.db);
      const atual = tardio || (await d.repo.obterPorId({ id: claim.id, clienteContaId: conta.id }, deps.db));
      await registrarAuditoria(atual, "fencing_obsoleto", { erroCodigo: "FENCING_OBSOLETO", precoConfirmado: extra.precoConfirmado });
      return { row: atual, obsoleto: true };
    }
    await registrarAuditoria(final, status, extra);
    return { row: final, obsoleto: false };
  }

  function respostaFalha(r, codigo, extra = {}) {
    if (r.obsoleto) {
      return {
        ok: false,
        codigo: "FENCING_OBSOLETO",
        motivo: "Esta execução perdeu a posse da aplicação (lease vencido e reconciliado). O resultado foi anexado como evidência; confira o anúncio.",
        aplicacao: aplicacaoPublica(r.row),
      };
    }
    return { ok: false, codigo, motivo: r.row.erroMensagem, aplicacao: aplicacaoPublica(r.row), ...extra };
  }

  const depsVivos = { ...deps, mlTimeoutMs: config.mlTimeoutMs };

  // ── Reavaliação AO VIVO (com prazo): a UI não é autoridade ───────────────
  let reavaliacao;
  try {
    reavaliacao = await comPrazo((async () => {
      const base = await avaliacao.carregarContexto(
        { clienteSlug: cliente.slug, clienteContaId: conta.id, itemId: claim.itemId },
        depsVivos
      );
      const r = await avaliarCompleto(
        { base, tipo: claim.tipoAcao, novoPreco: claim.precoSolicitado, precoVisto: claim.precoVisto, promotionId: claim.promotionId, modo: "escrita" },
        depsVivos,
        d
      );
      return { base, ...r };
    })(), config.reavaliacaoTimeoutMs);
  } catch (err) {
    const codigo = err && err.code ? String(err.code) : "REAVALIACAO_FALHOU";
    const recusa = ehRateLimit(codigo) || (err && err.statusCode && err.statusCode < 500) || codigo === "REAVALIACAO_TIMEOUT" || codigo === "ML_TIMEOUT";
    const r = await finalizar(recusa ? "recusado" : "falhou", {
      erroCodigo: codigo,
      erroMensagem: (err && err.message) || "Não foi possível reavaliar a alteração ao vivo.",
      mlStatus: err && err.statusCode ? Number(err.statusCode) : null,
    });
    return respostaFalha(r, codigo);
  }

  const { base, resultado, promo: promoPreview } = reavaliacao;
  const calculo = { atual: resultado.atual, proposta: resultado.proposta, insumos: resultado.insumos, promocao: resultado.promocao };
  vereditoAuditoria = (resultado.promocao && resultado.promocao.veredito) || null;

  // Heartbeat: a reavaliação terminou; ainda somos donos?
  const vivo = await d.repo.renovarLease({ id: claim.id, claimToken, leaseSeconds: config.leaseSegundos }, deps.db);
  if (!vivo) {
    const r = await finalizar("falhou", { erroCodigo: "FENCING_PERDIDO", erroMensagem: "O lease desta aplicação venceu antes da escrita. Nada foi enviado ao Mercado Livre.", gates: resultado.gates, calculo });
    return respostaFalha(r, "FENCING_PERDIDO");
  }

  // ACEITE: o preço é o SUGERIDO pelo ML. Se a sugestão ao vivo não é mais a do preview,
  // a intenção confirmada não existe mais — aborta e pede novo preview (nunca participa "no novo preço").
  if (modoPromocao === "aceite" && promoPreview) {
    const sugeridoAgora = promoPreview.precoFinal === null || promoPreview.precoFinal === undefined ? null : round2(promoPreview.precoFinal);
    if (sugeridoAgora === null || !mesmoPreco(sugeridoAgora, claim.precoSolicitado)) {
      const r = await finalizar("recusado", {
        erroCodigo: "PRECO_SUGERIDO_MUDOU",
        erroMensagem: "O preço sugerido pelo Mercado Livre mudou desde o preview. Gere um novo preview e revise os números antes de confirmar.",
        gates: resultado.gates,
        calculo: { ...calculo, precoSugeridoAgora: sugeridoAgora },
      });
      return respostaFalha(r, "PRECO_SUGERIDO_MUDOU", { novoPreviewNecessario: true, precoSugeridoAgora: sugeridoAgora });
    }
  }

  if (resultado.bloqueado) {
    const primeiro = resultado.gates.find((g) => g.tom === "block");
    const codigo = codigoDoGate(primeiro);
    const r = await finalizar("recusado", {
      erroCodigo: codigo,
      erroMensagem: primeiro ? primeiro.titulo : "Alteração bloqueada pelos gates.",
      gates: resultado.gates,
      calculo,
    });
    return respostaFalha(r, codigo, { gates: resultado.gates });
  }

  // ── Preview imutável: o estado ao vivo tem de ser EXATAMENTE o confirmado ──
  const fpAoVivo = fingerprintLib.montarFingerprint({
    base, tipo: claim.tipoAcao, precoVisto: claim.precoVisto, precoSolicitado: claim.precoSolicitado, resultado, promo: promoPreview,
  });
  if (fingerprintLib.hashFingerprint(fpAoVivo) !== claim.previewFingerprint) {
    const diferencas = fingerprintLib.diferencas(claim.fingerprint || {}, fpAoVivo);
    const intencaoMudou = diferencas.some((x) => x.campo === "promocao.acao");
    const codigo = intencaoMudou ? "PROMOCAO_INTENCAO_MUDOU" : "PREVIEW_DESATUALIZADO";
    const r = await finalizar("recusado", {
      erroCodigo: codigo,
      erroMensagem: intencaoMudou
        ? "A ação possível nesta promoção mudou desde o preview (Participar × Alterar). Gere um novo preview."
        : "O cenário mudou desde o preview. Gere um novo preview e revise os números antes de confirmar.",
      gates: resultado.gates,
      calculo: { ...calculo, diferencas },
    });
    return respostaFalha(r, codigo, { diferencas, novoPreviewNecessario: true });
  }

  // ── Gancho imediatamente antes do envio (fencing + releituras finais) ────
  let envioMarcado = false;
  async function antesDeEscrever(ctx = {}) {
    if (claim.tipoAcao === "PROMOTION") {
      // Intenção humana é imutável: nunca Participar → Alterar em silêncio.
      if (ctx.acao !== claim.promotionAcao) {
        return { ok: false, codigo: "PROMOCAO_INTENCAO_MUDOU", motivo: "A ação possível nesta promoção mudou desde o preview (Participar × Alterar). Gere um novo preview." };
      }
      const promoFp = fingerprintLib.fingerprintPromocao(ctx.promo || {}, ctx.acao);
      const dif = fingerprintLib.diferencas((claim.fingerprint && claim.fingerprint.promocao) || {}, promoFp);
      if (dif.length) {
        return { ok: false, codigo: "PROMOCAO_MUDOU", motivo: `A promoção mudou desde o preview (${dif.map((x) => x.campo).join(", ")}). Gere um novo preview.` };
      }
      // O escritor de promoção não relê o preço do anúncio: releitura aqui.
      const cot = await comPrazo(
        d.lerPrecoAtual({ clienteId: base.cliente.id, itemId: claim.itemId, mlUserId: base.conta.mlUserId }),
        config.mlTimeoutMs,
        "ML_TIMEOUT"
      );
      const atual = cot ? Number(cot.precoEfetivo) : NaN;
      if (!Number.isFinite(atual)) return { ok: false, codigo: "PRECO_ATUAL_INDISPONIVEL", motivo: "Não foi possível confirmar o preço atual imediatamente antes da escrita." };
      if (!mesmoPreco(atual, claim.precoVisto)) return { ok: false, codigo: "PRECO_ALTERADO", motivo: "Preço alterado desde o preview. Atualize e tente novamente." };
    }
    // Fencing: renova o lease PELO TOKEN e marca o envio na mesma instrução.
    // O prazo local de envio começa ANTES da ida ao banco, então termina antes
    // do fim do lease no banco (menos a margem de segurança).
    const t0 = d.relogio();
    const renovado = await d.repo.renovarLease({ id: claim.id, claimToken, leaseSeconds: config.leaseEscritaSegundos, marcarEnvio: true }, deps.db);
    if (!renovado) return { ok: false, codigo: "FENCING_PERDIDO", motivo: "Esta execução não é mais dona da aplicação. Nada foi enviado." };
    envioMarcado = true;
    return { ok: true, deadlineAt: t0 + (config.leaseEscritaSegundos - config.margemSegurancaSegundos) * 1000 };
  }

  let escrita;
  try {
    escrita = modoPromocao === "aceite"
      // ACEITE: o ML define o preço — participa sem enviar preço (o sugerido foi conferido no fingerprint).
      ? await d.participarPromocaoAceite({
          clienteId: base.cliente.id,
          itemId: claim.itemId,
          mlUserId: base.conta.mlUserId,
          promotionId: claim.promotionId,
          tipo: claim.promotionType,
          timeoutMs: config.mlTimeoutMs,
          antesDeEscrever,
        })
      : claim.tipoAcao === "PROMOTION"
      ? await d.aplicarPromocao({
          clienteId: base.cliente.id,
          itemId: claim.itemId,
          mlUserId: base.conta.mlUserId,
          promotionId: claim.promotionId,
          precoNovo: claim.precoSolicitado,
          timeoutMs: config.mlTimeoutMs,
          antesDeEscrever,
        })
      : await d.atualizarPreco({
          clienteId: base.cliente.id,
          itemId: claim.itemId,
          novoPreco: claim.precoSolicitado,
          mlUserId: base.conta.mlUserId,
          timeoutMs: config.mlTimeoutMs,
          precoEsperado: claim.precoVisto,
          antesDeEscrever,
        });
  } catch (err) {
    // Exceção: se o envio já tinha sido liberado, o ML pode ter recebido.
    const r = await finalizar(envioMarcado ? "resultado_desconhecido" : "falhou", {
      erroCodigo: envioMarcado ? "ESCRITA_EXCECAO" : "ESCRITA_EXCECAO_ANTES_DO_ENVIO",
      erroMensagem: envioMarcado
        ? "Falha inesperada durante a escrita. A alteração pode ter ocorrido — confira o anúncio antes de tentar de novo."
        : "Falha inesperada antes do envio. Nada foi enviado ao Mercado Livre.",
      gates: resultado.gates,
      calculo,
    });
    return respostaFalha(r, envioMarcado ? "ESCRITA_EXCECAO" : "ESCRITA_EXCECAO_ANTES_DO_ENVIO");
  }

  invalidarCache(cliente.slug, conta.id, claim.itemId);

  if (!escrita || !escrita.ok) {
    const codigo = (escrita && escrita.codigo) || "ESCRITA_FALHOU";
    let status;
    if (escrita && escrita.incerto) status = "resultado_desconhecido";
    else if (CODIGOS_RECUSA_SERVICO.has(codigo) || ehRateLimit(codigo)) status = "recusado";
    else status = "falhou";
    const r = await finalizar(status, {
      erroCodigo: codigo,
      erroMensagem: (escrita && escrita.motivo) || "O Mercado Livre recusou a alteração.",
      mlStatus: statusHttpDeCodigo(codigo),
      respostaMl: CODIGOS_NAO_ENVIADO.has(codigo) || CODIGOS_RECUSA_SERVICO.has(codigo)
        ? null
        : { status: statusHttpDeCodigo(codigo), codigo, motivo: escrita && escrita.motivo },
      gates: resultado.gates,
      calculo,
    });
    return respostaFalha(r, codigo, codigo === "PRECO_ALTERADO" || codigo === "PROMOCAO_MUDOU" || codigo === "PROMOCAO_INTENCAO_MUDOU" ? { novoPreviewNecessario: true } : {});
  }

  const confirmado = claim.tipoAcao === "PROMOTION" ? escrita.precoConfirmado : escrita.preco;
  if (confirmado === null || confirmado === undefined || !Number.isFinite(Number(confirmado))) {
    // Nunca assumir o valor enviado: sem preço na resposta, o resultado é incerto.
    const r = await finalizar("resultado_desconhecido", {
      erroCodigo: claim.tipoAcao === "PROMOTION" ? "PROMOCAO_CONFIRMACAO_FALHOU" : "PRECO_CONFIRMACAO_FALHOU",
      erroMensagem: "O Mercado Livre respondeu sem o preço aplicado. A alteração pode ter ocorrido — confira o anúncio.",
      mlStatus: 200,
      respostaMl: { status: 200, codigo: "SEM_PRECO_NA_RESPOSTA", metodo: escrita.metodo || (modoPromocao === "aceite" ? "POST" : null) },
      gates: resultado.gates,
      calculo,
    });
    return respostaFalha(r, r.row ? r.row.erroCodigo : "PRECO_CONFIRMACAO_FALHOU");
  }

  const precoConfirmado = round2(confirmado);
  const divergente = !mesmoPreco(precoConfirmado, claim.precoSolicitado);
  const snapshotLigado = d.leituraSnapshotHabilitada({ clienteSlug: cliente.slug }, d.env);
  const final = await finalizar(divergente ? "divergente" : "aplicado", {
    precoConfirmado,
    precoAnterior: resultado.atual.preco,
    // Aplicado exato: a margem avaliada ao vivo É a do preço confirmado.
    // Divergente: começa NULA e é recalculada abaixo sobre o confirmado —
    // nunca fica a margem do solicitado.
    financeiro: divergente ? { margemDepois: null, lucroDepois: null } : { margemDepois: resultado.proposta.margem, lucroDepois: resultado.proposta.lucro },
    atencaoCodigo: divergente ? "PRECO_CONFIRMADO_DIVERGENTE" : null,
    mlStatus: 200,
    respostaMl: {
      status: 200,
      metodo: escrita.metodo || (claim.tipoAcao === "PRICE" ? "PUT" : modoPromocao === "aceite" ? "POST" : null),
      preco: precoConfirmado,
      ...(modoPromocao ? { modo: modoPromocao } : {}),
    },
    gates: resultado.gates,
    calculo,
    snapshotStatus: snapshotLigado ? "pendente" : "nao_aplicavel",
    snapshotDelaySeconds: Math.ceil(config.snapshotRefreshDelayMs / 1000),
    snapshotJanelaMinutos: config.snapshotJanelaMinutos,
  });
  if (final.obsoleto) return respostaFalha(final, "FENCING_OBSOLETO");
  let row = final.row;

  if (divergente) {
    row = (await recalcularSobreConfirmado({ row, base, promo: promoPreview, precoConfirmado, calculo, depsVivos, d, deps })) || row;
  }

  // Mesmo espelho local que /anuncios mantém após o ML confirmar o preço base.
  if (claim.tipoAcao === "PRICE") {
    try {
      await d.atualizarCamposConfirmados(base.cliente.id, claim.itemId, { preco: precoConfirmado });
    } catch (_) {
      /* espelho local é best-effort: a verdade é o ML + a auditoria */
    }
  }

  if (snapshotLigado) {
    d.agendar(() => {
      processarRefresh({ id: claim.id }, deps).catch(() => {});
    }, config.snapshotRefreshDelayMs);
  }

  return {
    ok: true,
    aplicacao: aplicacaoPublica(row),
    divergente,
    atencao: row.atencaoCodigo || null,
  };
}

/**
 * O ML confirmou um preço DIFERENTE do solicitado: LC, margem e break-even
 * são refeitos sobre o CONFIRMADO, com comissão e frete recotados nele. Sem
 * cotação real, a margem fica NULA (nunca estimada como se fosse real).
 */
async function recalcularSobreConfirmado({ row, base, promo, precoConfirmado, calculo, depsVivos, d, deps }) {
  let margemDepois = null;
  let lucroDepois = null;
  let atencao = "PRECO_CONFIRMADO_SEM_RECOTACAO";
  let confirmadoCalc = null;
  try {
    const recote = await comPrazo(avaliacao.recotar(base, precoConfirmado, depsVivos), resolvePricingConfig(d.env).mlTimeoutMs, "ML_TIMEOUT");
    const r = avaliacao.avaliar(
      { base, tipo: row.tipoAcao, novoPreco: precoConfirmado, precoVisto: null, recote, promocao: promo, modo: "escrita" },
      depsVivos
    );
    const cotacaoOk = !r.gates.some((g) => (g.id === "comissao" || g.id === "frete") && g.tom === "block");
    confirmadoCalc = r.proposta;
    if (cotacaoOk && r.proposta && r.proposta.lucro !== null && r.proposta.lucro !== undefined) {
      margemDepois = r.proposta.margem;
      lucroDepois = r.proposta.lucro;
      atencao = lucroDepois < 0 ? "PRECO_CONFIRMADO_ABAIXO_BREAK_EVEN" : "PRECO_CONFIRMADO_DIVERGENTE";
    }
  } catch (_) {
    /* sem cotação: margem fica nula e a atenção diz por quê */
  }
  return d.repo.atualizarFinanceiroConfirmado({
    id: row.id,
    margemDepois,
    lucroDepois,
    atencaoCodigo: atencao,
    calculo: { ...calculo, confirmado: confirmadoCalc, precoConfirmado },
  }, deps.db);
}

/**
 * Uma rodada da fila DURÁVEL de refresh pós-escrita. Só vira 'atualizado'
 * quando o snapshot recalculado contém o preço confirmado; enquanto o ML
 * devolve o antigo: 'aguardando_propagacao' com backoff; estourou a janela:
 * 'propagacao_pendente'. Chamada logo depois da escrita, pelo polling da
 * aplicação e pelo histórico — sobrevive a restart porque o estado é da linha.
 */
async function processarRefresh({ id = null, limit = 3 } = {}, deps = {}) {
  const d = defaults(deps);
  const config = resolvePricingConfig(d.env);
  const linhas = await d.repo.reivindicarRefresh({ id, limit, lockSeconds: 120 }, deps.db);
  const saida = [];
  for (const row of linhas) {
    const tentativa = Math.max(1, row.snapshotTentativas || 1);
    const backoff = Math.min(config.snapshotBackoffMaxSegundos, config.snapshotBackoffBaseSegundos * 2 ** (tentativa - 1));
    let r;
    try {
      r = await d.atualizarSnapshotDoItem(
        { clienteSlug: row.clienteSlug, clienteId: row.clienteId, clienteContaId: row.clienteContaId, itemId: row.itemId, precoEsperado: row.precoConfirmado },
        deps
      );
    } catch (_) {
      r = { ok: false, motivo: "ERRO_LEITURA" };
    }
    let status;
    if (r && r.ok) status = "atualizado";
    else if (r && r.motivo === "PRECO_NAO_PROPAGADO") status = "aguardando_propagacao";
    else status = "pendente";
    const atualizado = await d.repo.registrarRefresh({
      id: row.id,
      status,
      precoObservado: r && r.preco !== undefined ? r.preco : null,
      proximaEmSeconds: status === "atualizado" ? null : backoff,
    }, deps.db);
    saida.push(atualizado || row);
  }
  return saida;
}

async function obterAplicacao(params = {}, deps = {}) {
  const d = defaults(deps);
  const config = resolvePricingConfig(d.env);
  const { conta } = await d.resolverContaDoCliente({ clienteSlug: params.clienteSlug, clienteContaId: params.clienteContaId }, deps);
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw erroHttp(400, "APLICACAO_ID_INVALIDO", "Aplicação inválida.");
  let row = await d.repo.obterPorId({ id, clienteContaId: conta.id }, deps.db);
  if (!row) throw erroHttp(404, "APLICACAO_NAO_ENCONTRADA", "Aplicação não encontrada para esta conta.");
  if (row.status === "aplicando" && row.leaseValida === false) {
    await d.repo.reconciliarLeasesVencidos({ id, graceSeconds: config.carenciaLeaseSegundos }, deps.db);
    row = (await d.repo.obterPorId({ id, clienteContaId: conta.id }, deps.db)) || row;
  }
  // O polling também move a fila durável (uma tentativa vencida por vez).
  if (row.snapshotStatus === "pendente" || row.snapshotStatus === "aguardando_propagacao") {
    d.agendar(() => { processarRefresh({ id }, deps).catch(() => {}); }, 0);
  }
  return { ok: true, aplicacao: aplicacaoPublica(row) };
}

async function historico(params = {}, deps = {}) {
  const d = defaults(deps);
  const { conta } = await d.resolverContaDoCliente({ clienteSlug: params.clienteSlug, clienteContaId: params.clienteContaId }, deps);
  const itemId = String(params.itemId || "").trim().toUpperCase();
  if (!/^MLB\d+$/.test(itemId)) throw erroHttp(400, "ITEM_ID_INVALIDO", "Informe um anúncio (MLB) válido.");
  const linhas = await d.repo.listarHistorico({ clienteContaId: conta.id, itemId, limit: params.limit }, deps.db);
  for (const row of linhas.filter((r) => r.snapshotStatus === "pendente" || r.snapshotStatus === "aguardando_propagacao").slice(0, 3)) {
    d.agendar(() => { processarRefresh({ id: row.id }, deps).catch(() => {}); }, 0);
  }
  return { ok: true, itemId, historico: linhas.map(aplicacaoPublica) };
}

// Teto de recotações por abertura de lista (cada uma = até 2 chamadas ao ML
// só deste item). Preços repetidos compartilham a mesma recotação.
const MAX_RECOTACOES_PROMOCOES = 6;

/**
 * Promoções do ITEM ABERTO com margem/LC em cada uma, recotando comissão e
 * frete no preço promocional (limiar de frete grátis e faixas de tarifa).
 */
async function promocoes(params = {}, deps = {}) {
  const d = defaults(deps);
  const config = resolvePricingConfig(d.env);
  const base = await contextoComCache(
    { clienteSlug: params.clienteSlug, clienteContaId: params.clienteContaId, itemId: params.itemId },
    deps,
    config.simulacaoCacheMs
  );
  const escrita = escritaHabilitada({ clienteSlug: base.cliente.slug }, d.env);
  const escritaPromocao = promocaoEscritaStatus({ clienteSlug: base.cliente.slug }, d.env).habilitada;
  if (!base.contaCorreta || !base.motor) {
    const r = avaliacao.avaliar({ base, tipo: "PRICE", novoPreco: null, precoVisto: null, recote: {} }, deps);
    return { ok: true, itemId: base.anuncio.itemId, contaCorreta: false, gates: r.gates, promocoes: [], escritaHabilitada: escrita, escritaPromocaoHabilitada: escritaPromocao };
  }
  const { lista } = await promocaoAoVivo(base, null, d);
  const recotes = new Map();
  const saida = [];
  for (const promo of lista) {
    const preco = promo.precoFinal !== null && promo.precoFinal !== undefined ? round2(promo.precoFinal) : null;
    let recote = { comissao: null, comissaoFonte: "indisponivel", frete: null, freteFonte: "indisponivel" };
    if (preco !== null) {
      const chave = preco.toFixed(2);
      if (!recotes.has(chave)) {
        recotes.set(
          chave,
          recotes.size < MAX_RECOTACOES_PROMOCOES || avaliacao.mesmoPreco(preco, base.motor.precoAtual)
            ? await avaliacao.recotar(base, preco, deps)
            : await avaliacao.recotar(base, preco, { ...deps, buscarComissaoEFrete: async () => ({ comissaoValor: null, fretePrevisto: null }) })
        );
      }
      recote = recotes.get(chave);
    }
    const r = avaliacao.avaliar({ base, tipo: "PROMOTION", novoPreco: preco, precoVisto: null, recote, promocao: promo }, deps);
    saida.push({
      ...r.promocao,
      precoFinal: preco,
      margem: r.proposta ? r.proposta.margem : null,
      lucro: r.proposta ? r.proposta.lucro : null,
      comissao: recote.comissao,
      comissaoFonte: recote.comissaoFonte,
      frete: recote.frete,
      freteFonte: recote.freteFonte,
      bloqueios: r.gates.filter((g) => g.tom === "block" && g.id !== "preco_confirmado").map((g) => g.titulo),
    });
  }
  const atual = avaliacao.avaliar(
    { base, tipo: "PRICE", novoPreco: base.motor.precoAtual, precoVisto: base.motor.precoAtual, recote: { comissao: base.motor.comissao, comissaoFonte: "motor", frete: base.motor.frete, freteFonte: "motor" } },
    deps
  ).atual;
  return {
    ok: true,
    itemId: base.anuncio.itemId,
    contaCorreta: true,
    atual,
    vendas: base.motor.vendas,
    promocoes: saida,
    escritaHabilitada: escrita,
    escritaPromocaoHabilitada: escritaPromocao,
  };
}

module.exports = {
  simular,
  preview,
  aplicar,
  obterAplicacao,
  historico,
  promocoes,
  processarRefresh,
  aplicacaoPublica,
  execucaoDe,
  invalidarCache,
  _papelPodeEscreverPromocao: papelPodeEscreverPromocao,
  CODIGOS_RECUSA_SERVICO,
  _cacheContexto: cacheContexto,
};
