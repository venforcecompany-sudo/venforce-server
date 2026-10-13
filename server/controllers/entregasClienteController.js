const {
  criarEntrega,
  listarEntregas,
  buscarEntregaPorId,
  atualizarEntrega,
  publicarEntrega,
  despublicarEntrega,
  excluirEntrega,
  buscarEntregaPublicaPorToken,
} = require("../services/entregasClienteService");
// P2.1 — seam de carteira. Fonte única (authorizationService), sem SQL de
// Squad aqui. Entrega é client-scoped: cliente vem do body na criação, da
// query na lista e do registro nas rotas por `:id`.
const {
  canAccessCliente,
  assertClienteNaCarteira,
  resolvePortfolioClientes,
  ehAdmin,
} = require("../services/squads/authorizationService");
const { registrarLog, extrairIp, dadosUsuarioDeReq } = require("../services/activityLogService");

// Trilha de auditoria (activity_logs, reutilizada — não há tabela de eventos
// própria). Só depois do sucesso; registrarLog nunca lança. `snapshotId` diz
// QUAL revisão do fechamento a entrega apresentava no momento da ação — é o
// que responde "qual versão o cliente recebeu?" depois.
function registrarEventoEntrega(req, acao, entrega, extra = {}) {
  if (!entrega) return;
  registrarLog({
    ...dadosUsuarioDeReq(req),
    acao,
    detalhes: {
      entregaId: entrega.id ?? null,
      tipo: entrega.tipo ?? null,
      clienteSlug: entrega.cliente_slug ?? null,
      clienteContaId: entrega.cliente_conta_id ?? null,
      periodo: entrega.periodo ?? null,
      snapshotId: entrega.snapshot_id ?? null,
      ...extra,
    },
    ip: extrairIp(req),
  });
}

// V3 P2.7 BLOCO U — erro conhecido nunca vira 500 generico. Antes so dois
// codigos eram mapeados por nome; qualquer erro novo com statusCode+code caia
// no 500 final, escondendo um 403/404/409 legitimo do frontend.
function responderErro(res, err) {
  if (err?.payload && err?.statusCode) {
    return res.status(err.statusCode).json(err.payload);
  }
  const status = Number(err?.statusCode);
  if (Number.isFinite(status) && status >= 400 && status < 500) {
    const corpo = { ok: false, erro: err.message };
    if (err.code) corpo.code = err.code;
    return res.status(status).json(corpo);
  }
  // 5xx: mensagem generica para fora, detalhe tecnico so no log.
  console.error("[entregas-cliente]", err?.message);
  return res.status(500).json({ ok: false, erro: "Erro interno do servidor" });
}

function erroCarteira(status, code, mensagem) {
  const e = new Error(mensagem);
  e.statusCode = status;
  e.code = code;
  return e;
}

// Resolve a entrega e confirma acesso ao cliente dela.
async function autorizarPorEntrega(req, idRaw) {
  const resultado = await buscarEntregaPorId({ idRaw }); // lança se não existe
  const clienteId = resultado?.entrega?.cliente_id;

  // V3 P2.7 BLOCO L — entrega ÓRFÃ (cliente_id NULL) pulava a autorização
  // inteira: `if (clienteId != null)` deixava GET/PATCH/publicar/despublicar/
  // DELETE liberados para qualquer papel de automações. E órfãs não são
  // hipotéticas — a FK é `ON DELETE SET NULL`, então apagar um cliente
  // CONVERTE todas as entregas dele em órfãs, e `criarEntrega` grava
  // cliente_id NULL quando o body não traz referência de cliente.
  //
  // Sem cliente não há carteira contra a qual verificar, então a única regra
  // canônica aplicável é o bypass de admin.
  if (clienteId == null) {
    if (!ehAdmin(req.user || {})) {
      throw erroCarteira(403, "ENTREGA_SEM_CLIENTE", "Esta entrega não está vinculada a um cliente; só um admin pode acessá-la.");
    }
    return resultado;
  }

  const ok = await canAccessCliente(req.user || {}, clienteId);
  if (!ok) throw erroCarteira(403, "CLIENTE_FORA_DA_CARTEIRA", "Cliente fora da sua carteira.");
  return resultado;
}

async function criarEntregaController(req, res) {
  try {
    const ref = req.body?.cliente_id ?? req.body?.cliente_slug;
    if (ref !== undefined && ref !== null && ref !== "") {
      await assertClienteNaCarteira(req.user || {}, ref);
    }
    const resultado = await criarEntrega({ userId: req.user?.id, body: req.body });
    registrarEventoEntrega(req, "entrega_salva", resultado.entrega, { substituir: req.body?.substituir === true });
    return res.status(201).json({ ok: true, entrega: resultado.entrega });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function listarEntregasController(req, res) {
  try {
    const user = req.user || {};
    const ref = req.query?.cliente_id ?? req.query?.cliente_slug;
    if (ref !== undefined && ref !== null && ref !== "") {
      await assertClienteNaCarteira(user, ref);
    }
    // V3 P2.7 BLOCO L — a carteira agora entra NO SQL. Antes o filtro rodava
    // sobre o array já paginado pelo LIMIT/OFFSET e o `total` devolvido era o
    // global, sem filtro: vazava a contagem de entregas de outros Squads e
    // produzia páginas curtas ou vazias sem indicar o porquê.
    const clienteIdsPermitidos = ehAdmin(user)
      ? null
      : (await resolvePortfolioClientes(user)).map((c) => c.id);

    const resultado = await listarEntregas({ query: req.query, clienteIdsPermitidos });
    return res.json({ ok: true, entregas: resultado.entregas, total: resultado.total });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function buscarEntregaPorIdController(req, res) {
  try {
    const resultado = await autorizarPorEntrega(req, req.params.id);
    return res.json({ ok: true, entrega: resultado.entrega });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function atualizarEntregaController(req, res) {
  try {
    await autorizarPorEntrega(req, req.params.id);
    const novoRef = req.body?.cliente_id ?? req.body?.cliente_slug;
    if (novoRef !== undefined && novoRef !== null && novoRef !== "") {
      await assertClienteNaCarteira(req.user || {}, novoRef);
    }
    const resultado = await atualizarEntrega({ idRaw: req.params.id, body: req.body });
    registrarEventoEntrega(req, "entrega_editada", resultado.entrega, { campos: Object.keys(req.body || {}) });
    return res.json({ ok: true, entrega: resultado.entrega });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function publicarEntregaController(req, res) {
  try {
    await autorizarPorEntrega(req, req.params.id);
    const resultado = await publicarEntrega({ idRaw: req.params.id });
    registrarEventoEntrega(req, "entrega_publicada", resultado.entrega);
    return res.json({ ok: true, entrega: resultado.entrega });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function despublicarEntregaController(req, res) {
  try {
    await autorizarPorEntrega(req, req.params.id);
    const resultado = await despublicarEntrega({ idRaw: req.params.id });
    registrarEventoEntrega(req, "entrega_despublicada", resultado.entrega);
    return res.json({ ok: true, entrega: resultado.entrega });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function excluirEntregaController(req, res) {
  try {
    await autorizarPorEntrega(req, req.params.id);
    const resultado = await excluirEntrega({ idRaw: req.params.id });
    if (!resultado.ok) return res.status(500).json({ ok: false, erro: "Falha ao excluir entrega." });
    return res.json({ ok: true });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function buscarEntregaPublicaPorTokenController(req, res) {
  try {
    const resultado = await buscarEntregaPublicaPorToken({ tokenRaw: req.params.token });
    return res.json({ ok: true, entrega: resultado.entrega });
  } catch (err) {
    return responderErro(res, err);
  }
}

module.exports = {
  criarEntregaController,
  listarEntregasController,
  buscarEntregaPorIdController,
  atualizarEntregaController,
  publicarEntregaController,
  despublicarEntregaController,
  excluirEntregaController,
  buscarEntregaPublicaPorTokenController,
};

