// server/controllers/inicioController.js
// GET /operacao/inicio/:cliente?conta=&periodo= — ver services/inicioService.js.
const { obterInicio } = require("../services/inicioService");

function responderErro(res, err) {
  const statusCode = Number.isFinite(Number(err?.statusCode)) && Number(err.statusCode) >= 400 ? Number(err.statusCode) : 500;
  if (statusCode >= 500) console.error("[inicio]", err?.message);
  const payload = { ok: false, erro: err?.message || "Erro interno." };
  if (err?.code) payload.code = err.code;
  return res.status(statusCode).json(payload);
}

async function inicio(req, res) {
  try {
    const dados = await obterInicio({
      clienteSlugRaw: req.params.cliente,
      clienteContaIdRaw: req.query.conta,
      periodoRaw: req.query.periodo,
    });
    return res.json({ ok: true, ...dados });
  } catch (err) {
    return responderErro(res, err);
  }
}

module.exports = { inicio };
