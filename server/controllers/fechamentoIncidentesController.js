// server/controllers/fechamentoIncidentesController.js
// Área admin/TI da caixa-preta do fechamento. Autorização (requireAdmin) é
// feita na rota — este controller assume que quem chegou aqui já é admin.

const fechamentoIncidentStorageService = require("../services/fechamentoFinanceiro/incidente/fechamentoIncidentStorageService");

async function listarIncidentesController(req, res) {
  try {
    const incidentes = await fechamentoIncidentStorageService.listarIncidentes({
      clienteSlug: req.query.clienteSlug || null,
      marketplace: req.query.marketplace || null,
      status: req.query.status || null,
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return res.json({ ok: true, incidentes });
  } catch (error) {
    console.error("Erro em GET /fechamentos/incidentes:", error.message);
    return res.status(500).json({ ok: false, erro: "Erro ao listar incidentes." });
  }
}

async function detalharIncidenteController(req, res) {
  try {
    const incidente = await fechamentoIncidentStorageService.getIncidenteDetalhado(req.params.codigo);
    if (!incidente) return res.status(404).json({ ok: false, erro: "Incidente não encontrado ou expirado." });
    return res.json({ ok: true, incidente });
  } catch (error) {
    console.error("Erro em GET /fechamentos/incidentes/:codigo:", error.message);
    return res.status(500).json({ ok: false, erro: "Erro ao buscar incidente." });
  }
}

async function baixarArquivoIncidenteController(req, res) {
  try {
    const arquivo = await fechamentoIncidentStorageService.getArquivoParaDownload(req.params.codigo, req.params.arquivoId);
    if (!arquivo) return res.status(404).json({ ok: false, erro: "Arquivo não encontrado, expirado ou indisponível." });
    res.set({
      "Content-Type": arquivo.mimeType,
      "Content-Disposition": `attachment; filename="${arquivo.nomeOriginal.replace(/"/g, "")}"`,
      "Content-Length": String(arquivo.buffer.length),
      "Cache-Control": "no-store",
    });
    return res.send(arquivo.buffer);
  } catch (error) {
    console.error("Erro em GET /fechamentos/incidentes/:codigo/arquivos/:arquivoId:", error.message);
    return res.status(500).json({ ok: false, erro: "Erro ao baixar arquivo do incidente." });
  }
}

module.exports = { listarIncidentesController, detalharIncidenteController, baixarArquivoIncidenteController };
