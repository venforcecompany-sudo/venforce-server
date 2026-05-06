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
    "SELECT id, slug FROM bases WHERE slug = $1 AND ativo = true",
    [baseSlug]
  );
  if (!r.rows.length) {
    throw criarHttpErro(404, { ok: false, erro: "Base não encontrada." });
  }
  return { id: r.rows[0].id, slug: r.rows[0].slug };
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

async function upsertCustoBase({ baseId, produtoIdNorm, custoProduto, impostoPercentualOpt, taxaFixaOpt }) {
  const existente = await pool.query(
    `SELECT base_id, produto_id, custo_produto, imposto_percentual, taxa_fixa
       FROM custos
      WHERE base_id = $1 AND produto_id = $2
      LIMIT 1`,
    [baseId, produtoIdNorm]
  );

  if (existente.rows.length) {
    const atual = existente.rows[0];
    const impostoFinal = impostoPercentualOpt.tem ? impostoPercentualOpt.numero : Number(atual.imposto_percentual);
    const taxaFinal = taxaFixaOpt.tem ? taxaFixaOpt.numero : Number(atual.taxa_fixa);

    const upd = await pool.query(
      `UPDATE custos
          SET custo_produto = $3,
              imposto_percentual = $4,
              taxa_fixa = $5
        WHERE base_id = $1 AND produto_id = $2
        RETURNING base_id, produto_id, custo_produto, imposto_percentual, taxa_fixa`,
      [baseId, produtoIdNorm, custoProduto, impostoFinal, taxaFinal]
    );

    return { acao: "atualizado", custo: upd.rows[0] };
  }

  const padrao = await obterPadraoCustoBase(baseId);
  const impostoFinal = impostoPercentualOpt.tem ? impostoPercentualOpt.numero : padrao.imposto_percentual;
  const taxaFinal = taxaFixaOpt.tem ? taxaFixaOpt.numero : padrao.taxa_fixa;

  const ins = await pool.query(
    `INSERT INTO custos (base_id, produto_id, custo_produto, imposto_percentual, taxa_fixa)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING base_id, produto_id, custo_produto, imposto_percentual, taxa_fixa`,
    [baseId, produtoIdNorm, custoProduto, impostoFinal, taxaFinal]
  );

  return { acao: "criado", custo: ins.rows[0] };
}

module.exports = {
  normalizarProdutoIdBase,
  obterBaseAtivaPorSlug,
  obterPadraoCustoBase,
  upsertCustoBase,
  validarNumeroObrigatorio,
  validarNumeroOpcional,
  criarHttpErro,
};

