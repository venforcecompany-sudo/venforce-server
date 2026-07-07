// server/services/bases/baseCustosService.js
// Regras e operações de custos por base (editor rápido).

const pool = require("../../config/database");

function normalizarSlug(valor) {
  return String(valor || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizarProdutoIdBase(valor) {
  let limpo = String(valor || "").replace(/^\uFEFF/, "").trim();
  if (!limpo) return "";

  // Remove aspas
  limpo = limpo.replace(/^['"]+|['"]+$/g, "").trim();
  if (!limpo) return "";

  // Excel serializa números como "12345.0"
  if (/^\d+\.0+$/.test(limpo)) limpo = limpo.replace(/\.0+$/, "");

  const upper = limpo.toUpperCase();

  // Se já contém MLB/MLBU num texto maior, extrai o padrão completo
  const match = upper.match(/MLB[U]?\d+/);
  if (match) return match[0];

  // Se for numérico puro, prefixa MLB
  if (/^\d+$/.test(limpo)) return `MLB${limpo}`;

  // Se já vier MLB/MLBU, normaliza para uppercase
  if (/^MLB[U]?\d+$/i.test(limpo)) return upper;

  // Outro formato (SKU customizado, etc): manter texto limpo
  return limpo;
}

function normalizarProdutoIdShopee(valor) {
  let limpo = String(valor || "").replace(/^﻿/, "").trim();
  if (!limpo) return "";
  limpo = limpo.replace(/^['"]+|['"]+$/g, "").trim();
  if (!limpo) return "";
  if (/^\d+\.0+$/.test(limpo)) limpo = limpo.replace(/\.0+$/, "");
  const sci = limpo.replace(",", ".");
  if (/^\d+(\.\d+)?[eE]\+?\d+$/.test(sci)) {
    const n = Number(sci);
    if (Number.isFinite(n)) return Math.trunc(n).toString();
  }
  return limpo;  // sem prefixo MLB
}

function criarHttpErro(statusCode, payload) {
  const err = new Error(payload?.erro || "Erro");
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

async function obterBaseAtivaPorSlug(baseSlugRaw) {
  const baseSlug = normalizarSlug(baseSlugRaw);
  if (!baseSlug) {
    throw criarHttpErro(400, { ok: false, erro: "baseSlug inválido." });
  }

  const r = await pool.query(
    "SELECT id, slug, marketplace FROM bases WHERE slug = $1 AND ativo = true",
    [baseSlug]
  );
  if (!r.rows.length) {
    throw criarHttpErro(404, { ok: false, erro: "Base não encontrada." });
  }
  return {
    id: r.rows[0].id,
    slug: r.rows[0].slug,
    marketplace: ["meli", "shopee"].includes(r.rows[0].marketplace) ? r.rows[0].marketplace : "meli",
  };
}

async function obterPadraoCustoBase(baseId) {
  const r = await pool.query(
    `SELECT imposto_percentual, taxa_fixa, COUNT(*) AS total
     FROM custos
     WHERE base_id = $1
     GROUP BY imposto_percentual, taxa_fixa
     ORDER BY total DESC
     LIMIT 1`,
    [baseId]
  );

  if (!r.rows.length) {
    return { imposto_percentual: 0, taxa_fixa: 0 };
  }

  const row = r.rows[0];
  const imposto = row.imposto_percentual != null ? Number(row.imposto_percentual) : 0;
  const taxa = row.taxa_fixa != null ? Number(row.taxa_fixa) : 0;

  return {
    imposto_percentual: Number.isFinite(imposto) ? imposto : 0,
    taxa_fixa: Number.isFinite(taxa) ? taxa : 0,
  };
}

function validarNumeroObrigatorio(valor, nomeCampo) {
  const n = typeof valor === "number" ? valor : Number(valor);
  if (!Number.isFinite(n)) {
    throw criarHttpErro(400, { ok: false, erro: `${nomeCampo} é obrigatório e numérico.` });
  }
  return n;
}

function validarNumeroOpcional(valor, nomeCampo) {
  if (valor === undefined) return { tem: false, numero: null };
  const n = typeof valor === "number" ? valor : Number(valor);
  if (!Number.isFinite(n)) {
    throw criarHttpErro(400, { ok: false, erro: `${nomeCampo} deve ser numérico.` });
  }
  return { tem: true, numero: n };
}

async function upsertCustoBase({ baseId, produtoIdNorm, custoProduto, impostoPercentualOpt, taxaFixaOpt, idModel }) {
  const existente = await pool.query(
    `SELECT base_id, produto_id, custo_produto, imposto_percentual, taxa_fixa, id_model
       FROM custos
      WHERE base_id = $1 AND produto_id = $2
      LIMIT 1`,
    [baseId, produtoIdNorm]
  );

  if (existente.rows.length) {
    const atual = existente.rows[0];
    const impostoFinal = impostoPercentualOpt.tem ? impostoPercentualOpt.numero : Number(atual.imposto_percentual);
    const taxaFinal = taxaFixaOpt.tem ? taxaFixaOpt.numero : Number(atual.taxa_fixa);
    const idModelFinal = idModel !== undefined ? (idModel || null) : (atual.id_model || null);

    const upd = await pool.query(
      `UPDATE custos
          SET custo_produto = $3,
              imposto_percentual = $4,
              taxa_fixa = $5,
              id_model = $6
        WHERE base_id = $1 AND produto_id = $2
        RETURNING base_id, produto_id, custo_produto, imposto_percentual, taxa_fixa, id_model`,
      [baseId, produtoIdNorm, custoProduto, impostoFinal, taxaFinal, idModelFinal]
    );

    return { acao: "atualizado", custo: upd.rows[0] };
  }

  const padrao = await obterPadraoCustoBase(baseId);
  const impostoFinal = impostoPercentualOpt.tem ? impostoPercentualOpt.numero : padrao.imposto_percentual;
  const taxaFinal = taxaFixaOpt.tem ? taxaFixaOpt.numero : padrao.taxa_fixa;

  const ins = await pool.query(
    `INSERT INTO custos (base_id, produto_id, custo_produto, imposto_percentual, taxa_fixa, id_model)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING base_id, produto_id, custo_produto, imposto_percentual, taxa_fixa, id_model`,
    [baseId, produtoIdNorm, custoProduto, impostoFinal, taxaFinal, idModel || null]
  );

  return { acao: "criado", custo: ins.rows[0] };
}

// ---------------------------------------------------------------------------
// Base vinculada para fechamento financeiro (MELI).
// Resolve a base (por id explícito OU pelo vínculo cliente+marketplace) e
// converte os custos do banco no MESMO formato de linha que o parser de custos
// do MELI já entende (ver parseMeliCostRows em meliFinanceiroService.js).
// Objetivo: mudar a ORIGEM dos custos sem tocar na fórmula de LC/MC.
// ---------------------------------------------------------------------------
async function resolverBaseVinculada({ baseId, clienteSlug, marketplace }) {
  const idNum = Number(baseId);
  if (Number.isInteger(idNum) && idNum > 0) {
    const r = await pool.query(
      "SELECT id, slug, nome FROM bases WHERE id = $1 AND ativo = true",
      [idNum]
    );
    if (r.rows.length) return r.rows[0];
  }

  const slug = String(clienteSlug || "").trim().toLowerCase();
  const mkt = String(marketplace || "").trim().toLowerCase();
  if (slug && mkt) {
    const r = await pool.query(
      `SELECT b.id, b.slug, b.nome
         FROM bases b
         JOIN base_cliente_vinculos v
           ON v.base_id = b.id AND v.ativo = true
         JOIN clientes c
           ON c.id = v.cliente_id
        WHERE LOWER(c.slug) = $1
          AND v.marketplace = $2
          AND b.ativo = true
        ORDER BY v.updated_at DESC
        LIMIT 1`,
      [slug, mkt]
    );
    if (r.rows.length) return r.rows[0];
  }

  return null;
}

async function buildCostRowsFromBase({ baseId, clienteSlug, marketplace }) {
  const base = await resolverBaseVinculada({ baseId, clienteSlug, marketplace });
  if (!base) {
    throw criarHttpErro(404, {
      ok: false,
      erro: "Nenhuma base vinculada encontrada para este cliente/marketplace.",
    });
  }

  const custos = await pool.query(
    `SELECT produto_id, custo_produto, imposto_percentual, id_model
       FROM custos
      WHERE base_id = $1`,
    [base.id]
  );

  if (!custos.rows.length) {
    throw criarHttpErro(422, {
      ok: false,
      erro: `A base vinculada "${base.nome || base.slug}" não possui custos cadastrados.`,
    });
  }

  // Chaves reconhecidas por findField/parseMeliCostRows (normalização por acento/caixa).
  const costRows = custos.rows.map((row) => ({
    "# de anúncio": row.produto_id,
    "preço de custo": row.custo_produto,
    imposto: row.imposto_percentual,
    model_id: row.id_model || "",
  }));

  return {
    base: { id: base.id, slug: base.slug, nome: base.nome },
    costRows,
  };
}

module.exports = {
  normalizarProdutoIdBase,
  normalizarProdutoIdShopee,
  obterBaseAtivaPorSlug,
  obterPadraoCustoBase,
  upsertCustoBase,
  validarNumeroObrigatorio,
  validarNumeroOpcional,
  criarHttpErro,
  resolverBaseVinculada,
  buildCostRowsFromBase,
};

