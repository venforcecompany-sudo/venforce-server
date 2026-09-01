// server/controllers/automacoesController.js
// Controllers das rotas de automações, relatórios e diagnóstico.
// Extraído de server/index.js sem alterar endpoints, payloads ou comportamento.

const pool = require("../config/database");
const { resolveMlGrant } = require("../services/mlTokenService");
const { registrarLog, extrairIp, dadosUsuarioDeReq } = require("../services/activityLogService");
// P2.1 — seam de carteira para artefatos salvos por id (relatório / job de
// diagnóstico). O cliente está no registro (cliente_slug), não em
// clienteSlug de rota — então a autorização é aqui, via fonte única.
const {
  canAccessCliente,
  resolverClienteRef,
  resolvePortfolioClientes,
  ehAdmin,
} = require("../services/squads/authorizationService");

// `tabela` é sempre um literal do call-site (nunca entrada do usuário).
async function autorizarPorRegistroSalvo(req, tabela, idRaw) {
  const id = parseInt(idRaw, 10);
  if (!Number.isFinite(id) || id <= 0) return; // service valida o 400/404
  const r = await pool.query(`SELECT cliente_slug FROM ${tabela} WHERE id = $1`, [id]);
  const slug = r.rows[0] && r.rows[0].cliente_slug;
  if (!slug) return; // registro inexistente → service devolve 404
  const cliente = await resolverClienteRef(slug);
  if (!cliente) return;
  const ok = await canAccessCliente(req.user || {}, cliente.id);
  if (!ok) {
    const e = new Error("Cliente fora da sua carteira.");
    e.statusCode = 403;
    e.payload = { ok: false, code: "CLIENTE_FORA_DA_CARTEIRA", erro: e.message };
    throw e;
  }
}

const {
  gerarPreviewPrecificacao,
  gerarPreviewPrecificacaoMl,
} = require("../services/automacoes/precificacaoService");

const {
  gerarPreviewPromocoesRetorno,
} = require("../services/automacoes/promocoesRetornoService");

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

const {
  exigirContextoPronto,
} = require("../services/automacoes/contextoPrecificacaoService");

const {
  gerarPlanilhaPrecificacaoSemBase,
} = require("../services/automacoes/planilhaPrecificacaoSemBaseService");

const {
  gerarModeloBaseCustos,
} = require("../services/automacoes/modeloBaseCustosService");

const {
  criarJobDiagnostico,
  enfileirarDiagnostico,
  buscarStatusDiagnostico,
  buscarUltimoSnapshotPromocoes,
} = require("../services/automacoes/promocoesDiagnosticoService");

function responderErroService(res, err) {
  if (err.payload && err.statusCode) {
    return res.status(err.statusCode).json(err.payload);
  }
  // Erros estruturais de conta (resolveMarketplaceAccountContext, via
  // contextoPrecificacaoService) chegam com `statusCode`/`code` direto no
  // erro, não em `payload` — mesmo formato de controllers/adsController.js
  // (getAdsPerformance) para MULTIPLE_MARKETPLACE_ACCOUNTS e afins.
  if (Number.isFinite(Number(err.statusCode)) && Number(err.statusCode) >= 400) {
    const payload = { ok: false, erro: err.message };
    if (err.code) payload.code = err.code;
    if (Array.isArray(err.contas)) payload.contas = err.contas;
    return res.status(Number(err.statusCode)).json(payload);
  }
  return res.status(500).json({ ok: false, erro: err.message });
}

async function listarClientesAutomacoesController(req, res) {
  try {
    // Bases são agregadas em uma consulta; o grant passa pelo resolver único.
    const result = await pool.query(
      `SELECT
         c.id, c.nome, c.slug, c.ativo, c.created_at,
         COALESCE(bm.bases, '[]'::jsonb) AS bases_meli
       FROM clientes c
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
                  jsonb_build_object(
                    'id', b.id, 'slug', b.slug, 'nome', b.nome, 'updated_at', b.updated_at
                  ) ORDER BY b.updated_at DESC NULLS LAST, b.id ASC
                ) AS bases
           FROM base_cliente_vinculos v
           JOIN bases b ON b.id = v.base_id AND b.ativo = true
          WHERE v.cliente_id = c.id
            AND v.ativo = true
            AND v.marketplace = 'meli'
       ) bm ON true
       WHERE c.ativo = true
       ORDER BY c.nome ASC`
    );

    const clientes = await Promise.all(result.rows.map(async (row) => {
      const basesMeli = Array.isArray(row.bases_meli) ? row.bases_meli : [];
      let grant = null;
      try {
        grant = await resolveMlGrant({ clienteId: row.id, requireUsable: true });
      } catch (_) {}
      const hasGrantMl = Boolean(grant);
      let baseStatus;
      if (basesMeli.length === 0) baseStatus = "ausente";
      else if (basesMeli.length === 1) baseStatus = "ok";
      else baseStatus = "multiplas";
      const baseUnica = basesMeli.length === 1 ? basesMeli[0] : null;

      return {
        // Campos originais (compatibilidade)
        id: row.id,
        nome: row.nome,
        slug: row.slug,
        ativo: row.ativo,
        created_at: row.created_at,
        // Contexto de prontidão
        hasGrantMl,
        mlUserId: grant?.ml_user_id || null,
        baseMeli: baseUnica ? baseUnica.slug : null,
        baseMeliNome: baseUnica ? baseUnica.nome : null,
        baseMeliUpdatedAt: baseUnica ? baseUnica.updated_at : null,
        baseStatus,
        basesMeliCount: basesMeli.length,
        prontoParaAnalise: hasGrantMl && basesMeli.length === 1,
        prontoParaExportacaoCrua: hasGrantMl,
      };
    }));

    res.json({ ok: true, clientes });
  } catch (err) {
    res.status(500).json({ ok: false, erro: err.message });
  }
}

async function previewPrecificacaoController(req, res) {
  try {
    const resultado = await gerarPreviewPrecificacao({
      clienteSlugRaw: req.query.clienteSlug,
      baseSlugRaw: req.query.baseSlug,
      clienteContaId: req.query.clienteContaId,
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
      clienteContaId: req.query.clienteContaId,
    });

    return res.json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function previewPromocoesRetornoController(req, res) {
  try {
    const resultado = await gerarPreviewPromocoesRetorno({
      clienteSlugRaw: req.query.clienteSlug,
      baseSlugRaw: req.query.baseSlug,
      margemAlvoRaw: req.query.margemAlvo,
      toleranciaRaw: req.query.tolerancia,
      pageRaw: req.query.page,
      limitRaw: req.query.limit,
      campanhaRaw: req.query.campanha,
      statusRaw: req.query.status,
      apenasComRetornoRaw: req.query.apenasComRetorno,
      clienteContaId: req.query.clienteContaId,
    });

    return res.json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

// ─── Diagnóstico assíncrono de promoções (start / status / snapshot) ─────────
async function iniciarDiagnosticoPromocoesController(req, res) {
  try {
    const resultado = await criarJobDiagnostico({ userId: req.user?.id, body: req.body });

    // Se já havia um job em andamento para este CLIENTE, devolve-o para polling.
    if (resultado.jaEmAndamento) {
      // Defensivo: se o job existente está 'aguardando' mas caiu da fila em
      // memória (restart), reenfileira — enfileirar é idempotente.
      if (resultado.status === "aguardando") enfileirarDiagnostico(resultado.id);
      return res.status(200).json({
        ok: true,
        diagnostico_id: resultado.id,
        status: resultado.status,
        jaEmAndamento: true,
        cliente: resultado.cliente,
        base: resultado.base,
      });
    }

    registrarLog({
      ...dadosUsuarioDeReq(req),
      acao: "automacoes.promocoes.diagnostico.start",
      detalhes: {
        diagnostico_id: resultado.id,
        cliente_slug: resultado?.cliente?.slug,
        base_slug: resultado?.base?.slug,
      },
      ip: extrairIp(req),
      status: "sucesso",
    });

    // Entra na FILA (no máximo 1 diagnóstico pesado por vez no servidor).
    enfileirarDiagnostico(resultado.id);

    return res.status(202).json({
      ok: true,
      diagnostico_id: resultado.id,
      status: "aguardando",
      created_at: resultado.created_at,
      cliente: resultado.cliente,
      base: resultado.base,
    });
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function statusDiagnosticoPromocoesController(req, res) {
  try {
    await autorizarPorRegistroSalvo(req, "promocoes_diagnosticos", req.params.id);
    const resultado = await buscarStatusDiagnostico({ idRaw: req.params.id });
    return res.json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function buscarSnapshotPromocoesController(req, res) {
  try {
    const resultado = await buscarUltimoSnapshotPromocoes({
      clienteSlugRaw: req.query.clienteSlug,
      baseSlugRaw: req.query.baseSlug,
      clienteContaId: req.query.clienteContaId,
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
    const user = req.user || {};
    const resultado = await listarRelatoriosAutomacoes({ query: req.query });
    if (!ehAdmin(user) && resultado && Array.isArray(resultado.relatorios)) {
      const permitidos = new Set((await resolvePortfolioClientes(user)).map((c) => c.slug));
      resultado.relatorios = resultado.relatorios.filter(
        (r) => r.cliente_slug == null || permitidos.has(r.cliente_slug)
      );
    }
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
    await autorizarPorRegistroSalvo(req, "relatorios", req.params.id);
    const resultado = await moverRelatorioParaPasta({ idRaw: req.params.id, body: req.body });
    return res.json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function buscarDetalheRelatorioAutomacoesController(req, res) {
  try {
    await autorizarPorRegistroSalvo(req, "relatorios", req.params.id);
    const resultado = await buscarDetalheRelatorioAutomacoes({ idRaw: req.params.id });
    return res.json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function excluirRelatorioAutomacoesController(req, res) {
  try {
    await autorizarPorRegistroSalvo(req, "relatorios", req.params.id);
    const resultado = await excluirRelatorioAutomacoes({ idRaw: req.params.id });
    return res.json(resultado);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function exportRelatorioCsvController(req, res) {
  try {
    await autorizarPorRegistroSalvo(req, "relatorios", req.params.id);
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
    await autorizarPorRegistroSalvo(req, "relatorios", req.params.id);
    const arquivo = await gerarExportRelatorioXlsx({ idRaw: req.params.id });
    res.setHeader("Content-Type", arquivo.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${arquivo.filename}"`);
    return res.send(arquivo.buffer);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function exportPlanilhaPrecificacaoSemBaseController(req, res) {
  try {
    const arquivo = await gerarPlanilhaPrecificacaoSemBase({
      clienteSlugRaw: req.params.clienteSlug,
      clienteContaId: req.query.clienteContaId,
    });
    res.setHeader("Content-Type", arquivo.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${arquivo.filename}"`);
    return res.send(arquivo.buffer);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function exportModeloBaseCustosController(req, res) {
  try {
    const arquivo = await gerarModeloBaseCustos({
      clienteSlugRaw: req.params.clienteSlug,
      clienteContaId: req.query.clienteContaId,
    });
    res.setHeader("Content-Type", arquivo.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${arquivo.filename}"`);
    return res.send(arquivo.buffer);
  } catch (err) {
    return responderErroService(res, err);
  }
}

async function iniciarDiagnosticoCompletoController(req, res) {
  try {
    const { clienteSlug, baseSlug, margemAlvo, observacoes, clienteContaId } = req.body || {};
    if (!clienteSlug) return res.status(400).json({ ok: false, erro: "clienteSlug é obrigatório." });

    // baseSlug é opcional: resolve automaticamente a base MELI vinculada ao
    // cliente (e valida grant + baseSlug informado, quando houver).
    // clienteContaId é a conta ML selecionada no Shell V3 — sem ela (e com
    // 2+ contas ML no cliente), exigirContextoPronto bloqueia com
    // MULTIPLE_MARKETPLACE_ACCOUNTS em vez de escolher uma em silêncio.
    const contexto = await exigirContextoPronto({
      clienteSlugRaw: clienteSlug,
      baseSlugRaw: baseSlug,
      clienteContaId,
    });
    const cliente = contexto.cliente;
    const base = contexto.base;

    const emAndamento = await pool.query(
      `SELECT id FROM relatorios
        WHERE cliente_id = $1 AND escopo = 'loja_completa' AND status = 'processando'
        ORDER BY id DESC LIMIT 1`,
      [cliente.id]
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
        cliente.id,
        cliente.slug,
        base.id,
        base.slug,
        margem,
        observacoes || null,
      ]
    );
    const relatorioId = ins.rows[0].id;

    registrarLog({
      ...dadosUsuarioDeReq(req),
      acao: "automacoes.diagnostico_completo.start",
      detalhes: { relatorio_id: relatorioId, cliente_slug: cliente.slug, base_slug: base.slug },
      ip: extrairIp(req),
      status: "sucesso",
    });

    // mlUserId já resolvido acima (conta selecionada, ou fallback legado
    // quando o cliente não tem cliente_contas cadastradas) viaja direto para
    // o worker — a tabela `relatorios` não tem coluna de conta/seller, e o
    // worker roda no mesmo processo, então não há por que persistir só para
    // reler em seguida (ver diagnosticoService.executarDiagnosticoCompleto).
    setImmediate(() => {
      executarDiagnosticoCompleto(relatorioId, { mlUserId: contexto.mlUserId }).catch((err) => {
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
    return responderErroService(res, err);
  }
}

async function buscarDiagnosticoCompletoController(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, erro: "id inválido." });
    }
    await autorizarPorRegistroSalvo(req, "relatorios", id);
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
    return responderErroService(res, err);
  }
}

module.exports = {
  listarClientesAutomacoesController,
  previewPrecificacaoController,
  previewPrecificacaoMlController,
  previewPromocoesRetornoController,
  iniciarDiagnosticoPromocoesController,
  statusDiagnosticoPromocoesController,
  buscarSnapshotPromocoesController,
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
  exportPlanilhaPrecificacaoSemBaseController,
  exportModeloBaseCustosController,
  iniciarDiagnosticoCompletoController,
  buscarDiagnosticoCompletoController,
};
