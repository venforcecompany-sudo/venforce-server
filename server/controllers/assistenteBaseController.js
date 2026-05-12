// server/controllers/assistenteBaseController.js
// Controller do Assistente de Base. Não salva nada no banco.

const { analisarPlanilhaBase } = require("../services/bases/assistenteBaseService");

async function previewAssistenteBaseController(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, erro: "Nenhum arquivo enviado." });
    }

    let config = {};
    if (req.body && req.body.config) {
      try {
        config = JSON.parse(req.body.config);
      } catch (_) {
        return res.status(400).json({ ok: false, erro: "Campo 'config' inválido: deve ser JSON." });
      }
    }

    const resultado = await analisarPlanilhaBase(
      req.file.buffer,
      req.file.originalname,
      config
    );

    return res.json(resultado);
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ ok: false, erro: err.message || "Erro interno." });
  }
}

module.exports = { previewAssistenteBaseController };
