// server/controllers/automacoesController.js
// Controllers das rotas de automações, relatórios e diagnóstico.
// Extraído de server/index.js sem alterar endpoints, payloads ou comportamento.

const pool = require("../config/database");
const { registrarLog, extrairIp, dadosUsuarioDeReq } = require("../services/activityLogService");

const {
  gerarPreviewPrecificacao,
  gerarPreviewPrecificacaoMl,
} = require("../services/automacoes/precificacaoService");

const {
  salvarRelatorioAutomacoes,
  listarRelatoriosAutomacoes,
  listarPastasRelatorios,
  criarPastaRelatorios,
  atualizarPastaRelatorios,
  excluirPastaRelatorios,
  moverRelatorioParaPasta,
  buscarDetalheRelatorioAutomacoes,
  excluirRelatorioAutomacoes,
  gerarExportRelatorioCsv,
  gerarExportRelatorioXlsx,
} = require("../services/automacoes/relatoriosService");

const {
  executarDiagnosticoCompleto,
} = require("../services/automacoes/diagnosticoService");

function responderErroService(res, err) {
  if (err.payload && err.statusCode) {
    return res.status(err.statusCode).json(err.payload);
  }
  return res.status(500).json({ ok: false, erro: err.message });
}

async function listarClientesAutomacoesController(req, res) {
  try {
    const result = await pool.query(
      `SELECT id, nome, slug, ativo, created_at
       FROM clientes
       WHERE ativo = true
       ORDER BY nome ASC`
    );
    res.json({ ok: true, clientes: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
}

async function previewPrecificacaoController(req, res) {
  try {
    const resultado = await gerarPreviewPrecificacao({
      clienteSlugRaw: req.query.clienteSlug,
      baseSlugRaw: req.query.baseSlug,
    });

    return res.json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function previewPrecificacaoMlController(req, res) {
  try {
    const resultado = await gerarPreviewPrecificacaoMl({
      clienteSlugRaw: req.query.clienteSlug,
      baseSlugRaw: req.query.baseSlug,
      pageRaw: req.query.page,
      limitRaw: req.query.limit,
      margemAlvoRaw: req.query.margemAlvo,
    });

    return res.json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function salvarRelatorioAutomacoesController(req, res) {
  try {
    const resultado = await salvarRelatorioAutomacoes({ userId: req.user.id, body: req.body });

    registrarLog({
      ...dadosUsuarioDeReq(req),
      acao: "automacoes.relatorio.salvar",
      detalhes: {
        relatorio_id: resultado.relatorio_id,
        cliente_slug: resultado?._logContext?.clienteSlugNorm,
        base_slug: resultado?._logContext?.baseSlugNorm,
        escopo: resultado?._logContext?.escopoNorm,
        total_itens: resultado?._logContext?.totalItens,
      },
      ip: extrairIp(req),
      status: "sucesso",
    });

    return res.status(201).json({
      ok: true,
      relatorio_id: resultado.relatorio_id,
      created_at: resultado.created_at,
    });
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function listarRelatoriosAutomacoesController(req, res) {
  try {
    const resultado = await listarRelatoriosAutomacoes({ query: req.query });
    return res.json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function listarPastasRelatoriosController(req, res) {
  try {
    const resultado = await listarPastasRelatorios();
    return res.json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function criarPastaRelatoriosController(req, res) {
  try {
    const resultado = await criarPastaRelatorios({ body: req.body });
    return res.status(201).json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function atualizarPastaRelatoriosController(req, res) {
  try {
    const resultado = await atualizarPastaRelatorios({ idRaw: req.params.id, body: req.body });
    return res.json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function excluirPastaRelatoriosController(req, res) {
  try {
    const resultado = await excluirPastaRelatorios({ idRaw: req.params.id });
    return res.json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function moverRelatorioParaPastaController(req, res) {
  try {
    const resultado = await moverRelatorioParaPasta({ idRaw: req.params.id, body: req.body });
    return res.json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function buscarDetalheRelatorioAutomacoesController(req, res) {
  try {
    const resultado = await buscarDetalheRelatorioAutomacoes({ idRaw: req.params.id });
    return res.json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function excluirRelatorioAutomacoesController(req, res) {
  try {
    const resultado = await excluirRelatorioAutomacoes({ idRaw: req.params.id });
    return res.json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function exportRelatorioCsvController(req, res) {
  try {
    const arquivo = await gerarExportRelatorioCsv({ idRaw: req.params.id });
    res.setHeader("Content-Type", arquivo.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${arquivo.filename}"`);
    return res.send(arquivo.bufferOrText);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function exportRelatorioXlsxController(req, res) {
  try {
    const arquivo = await gerarExportRelatorioXlsx({ idRaw: req.params.id });
    res.setHeader("Content-Type", arquivo.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${arquivo.filename}"`);
    return res.send(arquivo.buffer);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function iniciarDiagnosticoCompletoController(req, res) {
  try {
    const { clienteSlug, baseSlug, margemAlvo, observacoes } = req.body || {};
    if (!clienteSlug) return res.status(400).json({ ok: false, erro: "clienteSlug é obrigatório." });
    if (!baseSlug) return res.status(400).json({ ok: false, erro: "baseSlug é obrigatório." });

    const clienteSlugNorm = normalizarSlug(clienteSlug);
    const baseSlugNorm = normalizarSlug(baseSlug);

    const c = await pool.query("SELECT id, slug FROM clientes WHERE slug = $1", [clienteSlugNorm]);
    if (!c.rows.length) return res.status(404).json({ ok: false, erro: "Cliente não encontrado." });

    const b = await pool.query("SELECT id, slug FROM bases WHERE slug = $1", [baseSlugNorm]);
    if (!b.rows.length) return res.status(404).json({ ok: false, erro: "Base não encontrada." });

    const t = await pool.query("SELECT 1 FROM ml_tokens WHERE cliente_id = $1", [c.rows[0].id]);
    if (!t.rows.length) return res.status(400).json({ ok: false, erro: "Cliente sem conta ML vinculada." });

    const emAndamento = await pool.query(
      `SELECT id FROM relatorios
        WHERE cliente_id = $1 AND escopo = 'loja_completa' AND status = 'processando'
        ORDER BY id DESC LIMIT 1`,
      [c.rows[0].id]
    );
    if (emAndamento.rows.length) {
      return res.status(409).json({
        ok: false,
        erro: "Já existe um diagnóstico completo em andamento para este cliente.",
        relatorio_id: emAndamento.rows[0].id,
      });
    }

    const margemNum = Number(margemAlvo);
    const margem = Number.isFinite(margemNum) && margemNum > 0 && margemNum < 1 ? margemNum : null;

    const ins = await pool.query(
      `INSERT INTO relatorios
       (user_id, cliente_id, cliente_slug, base_id, base_slug, margem_alvo,
        escopo, status, total_itens, observacoes)
       VALUES ($1,$2,$3,$4,$5,$6,'loja_completa','processando',0,$7)
       RETURNING id, created_at`,
      [
        req.user.id,
        c.rows[0].id,
        c.rows[0].slug,
        b.rows[0].id,
        b.rows[0].slug,
        margem,
        observacoes || null,
      ]
    );
    const relatorioId = ins.rows[0].id;

    registrarLog({
      ...dadosUsuarioDeReq(req),
      acao: "automacoes.diagnostico_completo.start",
      detalhes: { relatorio_id: relatorioId, cliente_slug: clienteSlugNorm, base_slug: baseSlugNorm },
      ip: extrairIp(req),
      status: "sucesso",
    });

    setImmediate(() => {
      executarDiagnosticoCompleto(relatorioId).catch((err) => {
        console.error(`[diag ${relatorioId}] falha não tratada:`, err);
      });
    });

    return res.status(202).json({
      ok: true,
      relatorio_id: relatorioId,
      status: "processando",
      created_at: ins.rows[0].created_at,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
}

async function buscarDiagnosticoCompletoController(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, erro: "id inválido." });
    }
    const r = await pool.query(
      `SELECT id, cliente_slug, base_slug, margem_alvo, escopo, status,
              total_itens, itens_com_base, itens_sem_base,
              itens_criticos, itens_atencao, itens_saudaveis,
              mc_media, observacoes, created_at
         FROM relatorios WHERE id = $1`,
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ ok: false, erro: "Relatório não encontrado." });
    return res.json({ ok: true, relatorio: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, erro: err.message });
  }
}

function normalizarSlug(nome) {
  return String(nome || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

module.exports = {
  listarClientesAutomacoesController,
  previewPrecificacaoController,
  previewPrecificacaoMlController,
  salvarRelatorioAutomacoesController,
  listarRelatoriosAutomacoesController,
  listarPastasRelatoriosController,
  criarPastaRelatoriosController,
  atualizarPastaRelatoriosController,
  excluirPastaRelatoriosController,
  moverRelatorioParaPastaController,
  buscarDetalheRelatorioAutomacoesController,
  excluirRelatorioAutomacoesController,
  exportRelatorioCsvController,
  exportRelatorioXlsxController,
  iniciarDiagnosticoCompletoController,
  buscarDiagnosticoCompletoController,
};

