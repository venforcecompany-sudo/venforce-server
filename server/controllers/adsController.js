const pool = require("../config/database");
const {
  ensureAdsTables,
  listarClientesAds,
  buscarAcompanhamentoAds,
  salvarAcompanhamentoAds,
  ensureAdsResumoTables,
  buscarResumoMensalAds,
  salvarResumoMensalAds,
} = require("../services/adsService");
const { buscarPerformanceML } = require("../services/ads/mlAdsService");
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

// ─── Resumo mensal ────────────────────────────────────────────────────────────

let _resumoTablesReady = false;
async function garantirTabelasResumo() {
  if (_resumoTablesReady) return;
  await ensureAdsResumoTables();
  _resumoTablesReady = true;
}

function parseNumField(body, key) {
  const v = body[key];
  if (v === undefined || v === null) return { ok: true, value: 0 };
  const n = Number(v);
  if (!Number.isFinite(n)) return { ok: false, erro: `${key} deve ser um número válido.` };
  if (n < 0) return { ok: false, erro: `${key} não pode ser negativo.` };
  return { ok: true, value: n };
}

async function getAdsResumoMensal(req, res) {
  try {
    await garantirTabelasResumo();
    const clienteSlug = String(req.query.clienteSlug || "").trim();
    const mes         = String(req.query.mes || "").trim();
    const lojaCampanha = String(req.query.lojaCampanha || "todas").trim();

    if (!clienteSlug) {
      return res.status(400).json({ ok: false, erro: "clienteSlug é obrigatório." });
    }
    if (!mes || !MES_REF_REGEX.test(mes)) {
      return res.status(400).json({ ok: false, erro: "mes é obrigatório no formato YYYY-MM." });
    }

    const resumo = await buscarResumoMensalAds({ clienteSlug, mes, lojaCampanha });
    return res.json({ ok: true, resumo });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
}

async function putAdsResumoMensal(req, res) {
  try {
    await garantirTabelasResumo();
    const body        = req.body || {};
    const clienteSlug = String(body.clienteSlug || "").trim();
    const mes         = String(body.mes || "").trim();
    const lojaCampanha = String(body.lojaCampanha || "todas").trim();

    if (!clienteSlug) {
      return res.status(400).json({ ok: false, erro: "clienteSlug é obrigatório." });
    }
    if (!mes || !MES_REF_REGEX.test(mes)) {
      return res.status(400).json({ ok: false, erro: "mes é obrigatório no formato YYYY-MM." });
    }

    const CAMPOS_NUMERICOS = [
      "investimentoAds", "gmvAds", "roas", "faturamentoTotal",
      "canceladosValor", "canceladosPct", "devolvidosValor", "tacos",
    ];
    const dados = {};
    for (const campo of CAMPOS_NUMERICOS) {
      const r = parseNumField(body, campo);
      if (!r.ok) return res.status(400).json({ ok: false, erro: r.erro });
      dados[campo] = r.value;
    }

    const clienteResult = await pool.query(
      "SELECT id FROM clientes WHERE slug = $1 AND ativo = true",
      [clienteSlug]
    );
    if (!clienteResult.rows.length) {
      return res.status(404).json({ ok: false, erro: `Cliente "${clienteSlug}" não encontrado.` });
    }

    const resumo = await salvarResumoMensalAds({
      clienteSlug,
      mes,
      lojaCampanha,
      dados,
      userId: req.user?.id ?? null,
    });

    try {
      registrarLog({
        ...dadosUsuarioDeReq(req),
        acao: "ads_resumo_mensal_salvo",
        detalhes: { cliente_slug: clienteSlug, mes, loja_campanha: lojaCampanha },
        ip: extrairIp(req),
        status: "sucesso",
      });
    } catch (_) {
      // falha de log não derruba a rota
    }

    return res.json({ ok: true, resumo });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
}

// ─── Performance via API Mercado Livre Ads ────────────────────────────────────
// Retorna o objeto completo de performance com métricas reais + lista de anúncios.

async function getAdsPerformance(req, res) {
  try {
    const clienteSlug = String(req.query.clienteSlug || "").trim();
    const mes         = String(req.query.mes || "").trim();

    if (!clienteSlug) {
      return res.status(400).json({ ok: false, erro: "clienteSlug é obrigatório." });
    }
    if (!mes || !MES_REF_REGEX.test(mes)) {
      return res.status(400).json({ ok: false, erro: "mes é obrigatório no formato YYYY-MM." });
    }

    const result = await buscarPerformanceML(clienteSlug, mes);

    // Erros sem dados (sem token, sem permissão, sem advertiser, erro de API)
    if (result.semDados) {
      return res.json({
        ok: true,
        semDados: true,
        codigo:   result.codigo,
        motivo:   result.motivo,
      });
    }

    // Sucesso: devolve o objeto inteiro como `performance`
    return res.json({ ok: true, performance: result });
  } catch (err) {
    console.error("[getAdsPerformance]", err.message);
    return res.status(500).json({ ok: false, erro: err.message });
  }
}

module.exports = {
  getAdsClientes,
  getAdsAcompanhamento,
  putAdsAcompanhamento,
  getAdsResumoMensal,
  putAdsResumoMensal,
  getAdsPerformance,
};
