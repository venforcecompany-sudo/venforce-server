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

function responderErro(res, err) {
  if (err?.payload && err?.statusCode) {
    return res.status(err.statusCode).json(err.payload);
  }
  return res.status(500).json({ ok: false, erro: err?.message || "Erro interno do servidor" });
}

async function criarEntregaController(req, res) {
  try {
    const resultado = await criarEntrega({ userId: req.user?.id, body: req.body });
    return res.status(201).json({ ok: true, entrega: resultado.entrega });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function listarEntregasController(req, res) {
  try {
    const resultado = await listarEntregas({ query: req.query });
    return res.json({ ok: true, entregas: resultado.entregas, total: resultado.total });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function buscarEntregaPorIdController(req, res) {
  try {
    const resultado = await buscarEntregaPorId({ idRaw: req.params.id });
    return res.json({ ok: true, entrega: resultado.entrega });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function atualizarEntregaController(req, res) {
  try {
    const resultado = await atualizarEntrega({ idRaw: req.params.id, body: req.body });
    return res.json({ ok: true, entrega: resultado.entrega });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function publicarEntregaController(req, res) {
  try {
    const resultado = await publicarEntrega({ idRaw: req.params.id });
    return res.json({ ok: true, entrega: resultado.entrega });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function despublicarEntregaController(req, res) {
  try {
    const resultado = await despublicarEntrega({ idRaw: req.params.id });
    return res.json({ ok: true, entrega: resultado.entrega });
  } catch (err) {
    return responderErro(res, err);
  }
}

async function excluirEntregaController(req, res) {
  try {
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

