// server/controllers/cliente360ResultadoController.js
// Handlers FINOS do cockpit de resultado da Cliente 360 (tela React).
// Padrão espelhado do cliente360Controller: validam params, chamam o service,
// mascaram dados sensíveis e traduzem erro em statusCode.
// NENHUMA regra financeira aqui — toda conta mora nos motores puros.

const resultadoService = require("../services/cliente360/cliente360ResultadoService");
const carteiraService = require("../services/cliente360/cliente360CarteiraService");
const simulacaoService = require("../services/cliente360/cliente360SimulacaoService");
const serieService = require("../services/cliente360/cliente360SerieService");
const placarService = require("../services/cliente360/cliente360PlacarService");
const acoesRepo = require("../services/cliente360/cliente360AcoesRepository");

// Guard final: remove recursivamente qualquer campo sensível que escape do service.
const CAMPOS_SENSIVEIS = new Set([
  "access_token", "refresh_token", "api_key", "apikey", "password",
  "authorization", "token", "secret", "client_secret",
]);

function maskSensitiveData(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(maskSensitiveData);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = CAMPOS_SENSIVEIS.has(k.toLowerCase()) ? "[REDACTED]" : maskSensitiveData(v);
  }
  return out;
}

function slugParam(req) { return String(req.params.slug || "").trim().toLowerCase(); }
function responder(res, code, body) { return res.status(code).json(maskSensitiveData(body)); }

function tratarErro(res, err, ctx) {
  const status = err?.statusCode || 500;
  if (status >= 500) console.error(`[cliente360Resultado] ${ctx}:`, err?.message);
  return responder(res, status, { ok: false, erro: err?.message || "Erro interno." });
}

// GET /operacao/cliente-360/carteira/resultado
//   ?competencia=YYYY-MM&compararCom=YYYY-MM&marketplace=meli&margemAlvo=0.15
async function obterCarteiraExecutiva(req, res) {
  try {
    const data = await carteiraService.getCarteiraExecutiva({
      competencia: req.query.competencia,
      compararCom: req.query.compararCom,
      margemAlvo: req.query.margemAlvo,
      marketplace: req.query.marketplace,
    });
    return responder(res, 200, data);
  } catch (err) { return tratarErro(res, err, "obterCarteiraExecutiva"); }
}

// GET /operacao/cliente-360/:slug/resultado
//   ?competencia=YYYY-MM&compararCom=YYYY-MM&marketplace=meli&margemAlvo=0.15
async function obterResultado(req, res) {
  try {
    const slug = slugParam(req);
    if (!slug) return responder(res, 400, { ok: false, erro: "slug é obrigatório." });
    const data = await resultadoService.getResultado(slug, {
      competencia: req.query.competencia,
      compararCom: req.query.compararCom,
      margemAlvo: req.query.margemAlvo,
      marketplace: req.query.marketplace,
    });
    return responder(res, 200, data);
  } catch (err) { return tratarErro(res, err, "obterResultado"); }
}

// POST /operacao/cliente-360/:slug/resultado/simular
// body: { competencia, cenario: { intervencoes: [...] }, cenarioRapido, elasticidades }
// Campos de Ads no cenário são ignorados de propósito (ver simulador).
async function simularResultado(req, res) {
  try {
    const slug = slugParam(req);
    if (!slug) return responder(res, 400, { ok: false, erro: "slug é obrigatório." });
    const { competencia, cenario, cenarioRapido, elasticidades, marketplace } = req.body || {};
    if (cenario && typeof cenario !== "object") {
      return responder(res, 400, { ok: false, erro: "cenario deve ser um objeto." });
    }
    if (cenario?.intervencoes && !Array.isArray(cenario.intervencoes)) {
      return responder(res, 400, { ok: false, erro: "cenario.intervencoes deve ser uma lista." });
    }
    const data = await simulacaoService.simular(slug, {
      competencia, cenario, cenarioRapido, elasticidades, marketplace,
    });
    return responder(res, 200, data);
  } catch (err) { return tratarErro(res, err, "simularResultado"); }
}

// GET /operacao/cliente-360/:slug/elasticidades?meses=6&ate=YYYY-MM
async function obterElasticidades(req, res) {
  try {
    const slug = slugParam(req);
    if (!slug) return responder(res, 400, { ok: false, erro: "slug é obrigatório." });
    const meses = Math.max(2, Math.min(24, Number(req.query.meses) || 6));
    const data = await serieService.getElasticidades(slug, {
      meses, marketplace: req.query.marketplace, ate: req.query.ate,
    });
    return responder(res, 200, data);
  } catch (err) { return tratarErro(res, err, "obterElasticidades"); }
}

// GET /operacao/cliente-360/:slug/placar?desde=YYYY-MM
async function obterPlacar(req, res) {
  try {
    const slug = slugParam(req);
    if (!slug) return responder(res, 400, { ok: false, erro: "slug é obrigatório." });
    const data = await placarService.getPlacar(slug, {
      desde: req.query.desde, marketplace: req.query.marketplace,
    });
    return responder(res, 200, data);
  } catch (err) { return tratarErro(res, err, "obterPlacar"); }
}

// POST /operacao/cliente-360/:slug/acoes  (registra ação operacional do consultor)
async function registrarAcao(req, res) {
  try {
    const slug = slugParam(req);
    if (!slug) return responder(res, 400, { ok: false, erro: "slug é obrigatório." });
    const b = req.body || {};
    if (!b.competencia || !b.fator || !b.tipo) {
      return responder(res, 400, { ok: false, erro: "competencia, fator e tipo são obrigatórios." });
    }
    const row = await acoesRepo.registrarAcao({
      clienteSlug: slug,
      competencia: b.competencia,
      fator: b.fator,
      tipo: b.tipo,
      mlb: b.mlb || null,
      titulo: b.titulo || null,
      descricao: b.descricao || null,
      valorDe: b.valorDe ?? null,
      valorPara: b.valorPara ?? null,
      autor: req.user?.email || req.user?.nome || null,
      marketplace: b.marketplace || "meli",
    });
    return responder(res, 201, { ok: true, acao: row });
  } catch (err) { return tratarErro(res, err, "registrarAcao"); }
}

// GET /operacao/cliente-360/:slug/acoes
async function listarAcoes(req, res) {
  try {
    const slug = slugParam(req);
    if (!slug) return responder(res, 400, { ok: false, erro: "slug é obrigatório." });
    const rows = await acoesRepo.listarAcoes(slug, {
      desde: req.query.desde, marketplace: req.query.marketplace,
    });
    return responder(res, 200, { ok: true, acoes: rows });
  } catch (err) { return tratarErro(res, err, "listarAcoes"); }
}

// DELETE /operacao/cliente-360/:slug/acoes/:id
async function removerAcao(req, res) {
  try {
    const slug = slugParam(req);
    const id = Number(req.params.id);
    if (!slug || !id) return responder(res, 400, { ok: false, erro: "slug e id são obrigatórios." });
    const removido = await acoesRepo.removerAcao(id, slug);
    return responder(res, removido ? 200 : 404, { ok: removido });
  } catch (err) { return tratarErro(res, err, "removerAcao"); }
}

module.exports = {
  obterCarteiraExecutiva,
  obterResultado,
  simularResultado,
  obterElasticidades,
  obterPlacar,
  registrarAcao,
  listarAcoes,
  removerAcao,
  maskSensitiveData,
};
