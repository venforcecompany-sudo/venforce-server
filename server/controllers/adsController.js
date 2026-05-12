const pool = require("../config/database");
const {
  ensureAdsTables,
  listarClientesAds,
  buscarAcompanhamentoAds,
  salvarAcompanhamentoAds,
} = require("../services/adsService");
const { registrarLog, extrairIp, dadosUsuarioDeReq } = require("../services/activityLogService");

const MES_REF_REGEX = /^\d{4}-\d{2}$/;

let _tablesReady = false;
async function garantirTabelas() {
  if (_tablesReady) return;
  await ensureAdsTables();
  _tablesReady = true;
}

async function getAdsClientes(req, res) {
  try {
    await garantirTabelas();
    const clientes = await listarClientesAds();
    return res.json({ ok: true, clientes });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
}

async function getAdsAcompanhamento(req, res) {
  try {
    await garantirTabelas();
    const clienteSlug = String(req.query.clienteSlug || "").trim();
    const mes = String(req.query.mes || "").trim();
    const lojaCampanha = String(req.query.lojaCampanha || "todas").trim();

    if (!clienteSlug) {
      return res.status(400).json({ ok: false, erro: "clienteSlug é obrigatório." });
    }
    if (!mes || !MES_REF_REGEX.test(mes)) {
      return res.status(400).json({ ok: false, erro: "mes é obrigatório no formato YYYY-MM." });
    }

    const acompanhamento = await buscarAcompanhamentoAds({ clienteSlug, mes, lojaCampanha });
    return res.json({ ok: true, acompanhamento });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
}

async function putAdsAcompanhamento(req, res) {
  try {
    await garantirTabelas();
    const body = req.body || {};
    const clienteSlug = String(body.clienteSlug || "").trim();
    const mes = String(body.mes || "").trim();
    const lojaCampanha = String(body.lojaCampanha || "todas").trim();
    const checklist = body.checklist;
    const feedbackText = body.feedbackText;

    if (!clienteSlug) {
      return res.status(400).json({ ok: false, erro: "clienteSlug é obrigatório." });
    }
    if (!mes || !MES_REF_REGEX.test(mes)) {
      return res.status(400).json({ ok: false, erro: "mes é obrigatório no formato YYYY-MM." });
    }
    if (checklist === undefined || checklist === null || typeof checklist !== "object" || Array.isArray(checklist)) {
      return res.status(400).json({ ok: false, erro: "checklist deve ser um objeto." });
    }
    if (feedbackText !== undefined && typeof feedbackText !== "string") {
      return res.status(400).json({ ok: false, erro: "feedbackText deve ser string." });
    }
    if (typeof feedbackText === "string" && feedbackText.length > 10000) {
      return res.status(400).json({ ok: false, erro: "feedbackText excede 10000 caracteres." });
    }

    const clienteResult = await pool.query(
      "SELECT id FROM clientes WHERE slug = $1 AND ativo = true",
      [clienteSlug]
    );
    if (!clienteResult.rows.length) {
      return res.status(404).json({ ok: false, erro: `Cliente "${clienteSlug}" não encontrado.` });
    }

    const acompanhamento = await salvarAcompanhamentoAds({
      clienteSlug,
      mes,
      lojaCampanha,
      checklist,
      feedbackText: feedbackText ?? "",
      userId: req.user?.id ?? null,
    });

    try {
      registrarLog({
        ...dadosUsuarioDeReq(req),
        acao: "ads_acompanhamento_salvo",
        detalhes: { cliente_slug: clienteSlug, mes, loja_campanha: lojaCampanha },
        ip: extrairIp(req),
        status: "sucesso",
      });
    } catch (_) {
      // falha de log não derruba a rota
    }

    return res.json({ ok: true, acompanhamento });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
}

module.exports = { getAdsClientes, getAdsAcompanhamento, putAdsAcompanhamento };
