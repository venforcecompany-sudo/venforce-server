const express = require("express");
const router = express.Router();

const pool = require("../config/database");
const { requireExternalApiKey } = require("../middlewares/externalApiKeyMiddleware");

// ─── helpers ────────────────────────────────────────────────────────────────

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parsePagination(query) {
  const limit = Math.min(Math.max(Number(query.limit) || 500, 1), 1000);
  const offset = Math.max(Number(query.offset) || 0, 0);
  return { limit, offset };
}

function buildPaginationMeta(req, count, limit, offset) {
  const hasMore = count === limit;
  const nextOffset = hasMore ? offset + limit : null;
  const nextUrl = hasMore
    ? `${req.protocol}://${req.get("host")}${req.path}?limit=${limit}&offset=${nextOffset}`
    : null;
  return { hasMore, nextOffset, nextUrl };
}

// ─── catálogo de recursos permitidos ────────────────────────────────────────

const RESOURCES = [
  {
    id: "bases",
    label: "Bases de custo",
    description: "Lista todas as bases de custo ativas (sem dados de custo).",
    endpoint: "/external/firebase/bases",
    requiresParams: [],
  },
  {
    id: "custos_base",
    label: "Custos de uma base",
    description: "Exporta produto_id, custo_produto, imposto_percentual e taxa_fixa de uma base específica.",
    endpoint: "/external/firebase/base/:baseSlug",
    requiresParams: ["baseSlug"],
  },
  {
    id: "relatorios",
    label: "Relatórios",
    description: "Lista relatórios gerados, sem dados sensíveis de usuários ou tokens.",
    endpoint: "/external/firebase/relatorios",
    requiresParams: [],
  },
  {
    id: "relatorio_itens",
    label: "Itens de um relatório",
    description: "Exporta os itens calculados de um relatório específico pelo seu ID.",
    endpoint: "/external/firebase/relatorio/:relatorioId/itens",
    requiresParams: ["relatorioId"],
  },
];

// ─── GET /resources ──────────────────────────────────────────────────────────

router.get("/resources", requireExternalApiKey, (req, res) => {
  return res.json({
    success: true,
    source: "venforce-postgresql",
    count: RESOURCES.length,
    resources: RESOURCES,
  });
});

// ─── GET /bases ──────────────────────────────────────────────────────────────

router.get("/bases", requireExternalApiKey, async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);

    const result = await pool.query(
      `SELECT slug, nome, created_at, updated_at
       FROM bases
       WHERE ativo = true
       ORDER BY nome ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const { hasMore, nextOffset, nextUrl } = buildPaginationMeta(req, result.rows.length, limit, offset);

    return res.json({
      success: true,
      source: "venforce-postgresql",
      collection: "bases",
      count: result.rows.length,
      limit,
      offset,
      hasMore,
      nextOffset,
      nextUrl,
      data: result.rows,
    });
  } catch (error) {
    console.error("[external/firebase] Erro ao listar bases:", error);
    return res.status(500).json({ success: false, error: "Erro interno ao buscar bases." });
  }
});

// ─── GET /base/:baseSlug ─────────────────────────────────────────────────────

router.get("/base/:baseSlug", requireExternalApiKey, async (req, res) => {
  try {
    const slug = slugify(req.params.baseSlug);
    const { limit, offset } = parsePagination(req.query);

    const baseResult = await pool.query(
      "SELECT id, slug, nome FROM bases WHERE slug = $1 AND ativo = true",
      [slug]
    );

    if (!baseResult.rows.length) {
      return res.status(404).json({ success: false, error: "Base não encontrada ou inativa." });
    }

    const base = baseResult.rows[0];

    const custosResult = await pool.query(
      `SELECT produto_id, custo_produto, imposto_percentual, taxa_fixa
       FROM custos
       WHERE base_id = $1
       ORDER BY produto_id ASC
       LIMIT $2 OFFSET $3`,
      [base.id, limit, offset]
    );

    const { hasMore, nextOffset, nextUrl } = buildPaginationMeta(req, custosResult.rows.length, limit, offset);

    return res.json({
      success: true,
      source: "venforce-postgresql",
      collection: "custos",
      base: { slug: base.slug, nome: base.nome },
      count: custosResult.rows.length,
      limit,
      offset,
      hasMore,
      nextOffset,
      nextUrl,
      data: custosResult.rows.map((row) => ({
        produto_id: row.produto_id,
        custo_produto: parseFloat(row.custo_produto),
        imposto_percentual: parseFloat(row.imposto_percentual),
        taxa_fixa: parseFloat(row.taxa_fixa),
      })),
    });
  } catch (error) {
    console.error("[external/firebase] Erro ao exportar base:", error);
    return res.status(500).json({ success: false, error: "Erro interno ao buscar dados da base." });
  }
});

// ─── GET /relatorios ─────────────────────────────────────────────────────────

router.get("/relatorios", requireExternalApiKey, async (req, res) => {
  try {
    const { limit, offset } = parsePagination(req.query);

    const result = await pool.query(
      `SELECT
         id,
         cliente_slug,
         base_slug,
         margem_alvo,
         escopo,
         status,
         total_itens,
         itens_com_base,
         itens_sem_base,
         itens_criticos,
         itens_atencao,
         itens_saudaveis,
         mc_media,
         created_at
       FROM relatorios
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const { hasMore, nextOffset, nextUrl } = buildPaginationMeta(req, result.rows.length, limit, offset);

    return res.json({
      success: true,
      source: "venforce-postgresql",
      collection: "relatorios",
      count: result.rows.length,
      limit,
      offset,
      hasMore,
      nextOffset,
      nextUrl,
      data: result.rows,
    });
  } catch (error) {
    console.error("[external/firebase] Erro ao listar relatorios:", error);
    return res.status(500).json({ success: false, error: "Erro interno ao buscar relatórios." });
  }
});

// ─── GET /relatorio/:relatorioId/itens ───────────────────────────────────────

router.get("/relatorio/:relatorioId/itens", requireExternalApiKey, async (req, res) => {
  try {
    const relatorioId = parseInt(req.params.relatorioId, 10);
    if (!relatorioId || relatorioId <= 0) {
      return res.status(400).json({ success: false, error: "relatorioId inválido." });
    }

    const { limit, offset } = parsePagination(req.query);

    const relResult = await pool.query(
      "SELECT id, cliente_slug, base_slug, status FROM relatorios WHERE id = $1",
      [relatorioId]
    );

    if (!relResult.rows.length) {
      return res.status(404).json({ success: false, error: "Relatório não encontrado." });
    }

    const relatorio = relResult.rows[0];

    const itensResult = await pool.query(
      `SELECT
         id,
         item_id,
         sku,
         titulo,
         status_anuncio,
         listing_type_id,
         preco_original,
         preco_promocional,
         preco_efetivo,
         custo,
         imposto_percentual,
         taxa_fixa,
         frete,
         comissao,
         comissao_percentual,
         lc,
         mc,
         preco_alvo,
         preco_sugerido,
         diferenca_preco,
         acao_recomendada,
         diagnostico,
         tem_base
       FROM relatorio_itens
       WHERE relatorio_id = $1
       ORDER BY id ASC
       LIMIT $2 OFFSET $3`,
      [relatorioId, limit, offset]
    );

    const { hasMore, nextOffset, nextUrl } = buildPaginationMeta(req, itensResult.rows.length, limit, offset);

    return res.json({
      success: true,
      source: "venforce-postgresql",
      collection: "relatorio_itens",
      relatorio: {
        id: relatorio.id,
        cliente_slug: relatorio.cliente_slug,
        base_slug: relatorio.base_slug,
        status: relatorio.status,
      },
      count: itensResult.rows.length,
      limit,
      offset,
      hasMore,
      nextOffset,
      nextUrl,
      data: itensResult.rows,
    });
  } catch (error) {
    console.error("[external/firebase] Erro ao listar itens do relatorio:", error);
    return res.status(500).json({ success: false, error: "Erro interno ao buscar itens do relatório." });
  }
});

module.exports = router;
