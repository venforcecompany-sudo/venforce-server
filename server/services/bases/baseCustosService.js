// server/services/bases/baseCustosService.js
// Regras e operações de custos por base (editor rápido).

const pool = require("../../config/database");
const {
  MARKETPLACES_SUPORTADOS,
  isMarketplaceSuportado,
} = require("./marketplacesBases");
const { sanitizarConta } = require("../clienteContas/clienteContaService");

// Mensagem única para IDs TikTok que o Excel já destruiu (notação científica).
// Vale para as DUAS colunas numéricas do TikTok — "ID" (product_id) e
// "ID do SKU" (sku_id) —, por isso o rótulo é parametrizado.
function erroCientificoTikTok(rotulo) {
  return `${rotulo} TikTok em notação científica. Formate a coluna como texto antes de importar.`;
}

const ERRO_ID_TIKTOK_CIENTIFICO = erroCientificoTikTok("ID do SKU");

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

// ---------------------------------------------------------------------------
// IDs numéricos do TikTok Shop — DOIS campos distintos, mesma regra de tipo:
//
//   produto_id  ← coluna "ID"         da planilha = product_id do TikTok
//   sku_id      ← coluna "ID DO SKU"  da planilha = sku_id da VARIAÇÃO
//
// Ambos têm 18–19 dígitos e precisam chegar ao PostgreSQL exatamente como
// vieram. Nada de Number/parseInt/parseFloat/Math.trunc aqui: qualquer
// conversão numérica perderia dígitos silenciosamente.
//
// A chave de custo do TikTok é sku_id (ver buildTikTokCostMap). O produto_id
// é informativo e PODE repetir — cada variação tem seu próprio sku_id.
// ---------------------------------------------------------------------------
function normalizarIdNumericoTikTok(valor, rotulo) {
  if (valor === null || valor === undefined) return "";

  // Um número já chegou convertido pela camada anterior (Excel/JSON). Só é
  // seguro se ainda for inteiro exato; caso contrário os dígitos já se foram.
  if (typeof valor === "number") {
    if (!Number.isFinite(valor) || !Number.isSafeInteger(valor)) {
      throw criarHttpErro(400, {
        ok: false,
        erro: `${rotulo} TikTok chegou como número e perdeu precisão. Envie o ID como texto.`,
      });
    }
    return String(valor);
  }

  let limpo = String(valor).replace(/^﻿/, "").trim();
  if (!limpo) return "";

  limpo = limpo.replace(/^['"]+|['"]+$/g, "").trim();
  if (!limpo) return "";

  // "1735907463738524810.0" → "1735907463738524810" (só dígitos seguidos de .0…)
  if (/^\d+\.0+$/.test(limpo)) limpo = limpo.replace(/\.0+$/, "");

  // Notação científica é rejeitada: o Excel já perdeu os dígitos finais e
  // reconstruir o ID a partir do float produziria um ID errado.
  if (/^\d+(?:[.,]\d+)?[eE][+-]?\d+$/.test(limpo)) {
    throw criarHttpErro(400, { ok: false, erro: erroCientificoTikTok(rotulo) });
  }

  return limpo;
}

// Coluna "ID" da planilha TikTok → custos.produto_id (product_id).
function normalizarProdutoIdTikTok(valor) {
  return normalizarIdNumericoTikTok(valor, "ID");
}

// Coluna "ID DO SKU" da planilha TikTok → custos.sku_id (sku_id da variação).
// É a chave autoritativa de custo do TikTok.
function normalizarSkuIdTikTok(valor) {
  return normalizarIdNumericoTikTok(valor, "ID do SKU");
}

// LEGADO — SKU textual. Continua existindo apenas para as bases de
// Mercado Livre/Shopee (onde a coluna fica '') e para linhas TikTok antigas
// importadas antes do modelo product_id × sku_id. NÃO participa de nenhuma
// chave de custo do TikTok: o cruzamento é exclusivamente por sku_id.
function normalizarSkuTikTok(valor) {
  return String(valor == null ? "" : valor).trim();
}

// Mensagem única para sku_id repetido com valores divergentes dentro do mesmo
// lote/base — usada pela importação e pelo preview.
function erroSkuIdDuplicadoTikTok(skuId, contexto) {
  const sufixo = contexto ? ` ${contexto}` : "";
  return (
    `O ID DO SKU ${skuId} aparece em mais de uma linha com custo ou imposto ` +
    `diferentes. Corrija a planilha: cada ID DO SKU só pode ter um custo.${sufixo}`
  );
}

function criarHttpErro(statusCode, payload) {
  const err = new Error(payload?.erro || "Erro");
  err.statusCode = statusCode;
  err.payload = payload;
  if (payload?.code) err.code = payload.code;
  if (payload?.contas) err.contas = payload.contas;
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
  // Marketplace desconhecido no banco NÃO vira MELI silenciosamente: seria
  // aplicar a normalização de ID errada (prefixo MLB) em base de outro canal.
  const marketplace = String(r.rows[0].marketplace || "").trim().toLowerCase();
  if (!isMarketplaceSuportado(marketplace)) {
    throw criarHttpErro(422, {
      ok: false,
      erro: `Base "${r.rows[0].slug}" tem marketplace inválido ("${r.rows[0].marketplace || "vazio"}"). Suportados: ${MARKETPLACES_SUPORTADOS.join(", ")}.`,
    });
  }

  return {
    id: r.rows[0].id,
    slug: r.rows[0].slug,
    marketplace,
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

// Texto vazio/ausente não sobrescreve o nome já gravado — só nome preenchido atualiza.
function textoOpcional(valor) {
  const texto = String(valor == null ? "" : valor).trim();
  return texto ? texto : null;
}

const COLUNAS_CUSTO_RETORNO =
  "base_id, produto_id, sku_id, custo_produto, imposto_percentual, taxa_fixa, id_model, produto_nome, variacao_nome, sku, updated_at";

async function upsertCustoBase({
  baseId,
  produtoIdNorm,
  skuIdNorm,
  custoProduto,
  impostoPercentualOpt,
  taxaFixaOpt,
  idModel,
  produtoNome,
  variacaoNome,
  marketplace,
}) {
  // TikTok não usa taxa fixa nem id_model. A identidade de custo é
  // base_id + sku_id (uma linha por VARIAÇÃO): o mesmo produto_id aparece em
  // várias linhas, uma por sku_id, cada uma com seu próprio custo/imposto.
  // Nunca localizar/atualizar pelo produto_id, pelo SKU textual ou por nome.
  const isTikTok = String(marketplace || "").trim().toLowerCase() === "tiktok";
  const taxaOpt = isTikTok ? { tem: true, numero: 0 } : taxaFixaOpt;
  const idModelEntrada = isTikTok ? null : idModel;
  const produtoNomeFinal = textoOpcional(produtoNome);
  const variacaoNomeFinal = textoOpcional(variacaoNome);
  // SKU textual (legado) nunca é escrito por este upsert: MELI/Shopee não têm
  // o campo e o TikTok passou a identificar a variação por sku_id. null =
  // "não mexer" no UPDATE (COALESCE) e '' no INSERT.
  const skuFinal = null;
  const skuIdFinal = isTikTok ? String(skuIdNorm || "").trim() : "";

  if (isTikTok && !skuIdFinal) {
    throw criarHttpErro(400, {
      ok: false,
      erro: "ID DO SKU é obrigatório nas bases TikTok — é a chave do custo da variação.",
    });
  }

  // Localização da linha: TikTok por sku_id; MELI/Shopee por produto_id (o
  // caminho histórico, inalterado).
  const existente = await pool.query(
    isTikTok
      ? `SELECT ${COLUNAS_CUSTO_RETORNO} FROM custos WHERE base_id = $1 AND sku_id = $2 LIMIT 1`
      : `SELECT ${COLUNAS_CUSTO_RETORNO} FROM custos WHERE base_id = $1 AND produto_id = $2 LIMIT 1`,
    [baseId, isTikTok ? skuIdFinal : produtoIdNorm]
  );

  if (existente.rows.length) {
    const atual = existente.rows[0];
    const impostoFinal = impostoPercentualOpt.tem ? impostoPercentualOpt.numero : Number(atual.imposto_percentual);
    const taxaFinal = taxaOpt.tem ? taxaOpt.numero : Number(atual.taxa_fixa);
    const idModelFinal = isTikTok
      ? null
      : (idModelEntrada !== undefined ? (idModelEntrada || null) : (atual.id_model || null));

    if (isTikTok) {
      // produto_id só é sobrescrito quando vem preenchido: base antiga que não
      // conhecia o product_id ganha o valor, e nunca o perde.
      const upd = await pool.query(
        `UPDATE custos
            SET produto_id = COALESCE(NULLIF($3, ''), produto_id),
                custo_produto = $4,
                imposto_percentual = $5,
                taxa_fixa = 0,
                id_model = NULL,
                produto_nome = COALESCE($6, produto_nome),
                variacao_nome = COALESCE($7, variacao_nome),
                updated_at = CURRENT_TIMESTAMP
          WHERE base_id = $1 AND sku_id = $2
          RETURNING ${COLUNAS_CUSTO_RETORNO}`,
        [baseId, skuIdFinal, produtoIdNorm || "", custoProduto, impostoFinal, produtoNomeFinal, variacaoNomeFinal]
      );

      await tocarUpdatedAtBase(baseId);
      return { acao: "atualizado", custo: upd.rows[0] };
    }

    const upd = await pool.query(
      `UPDATE custos
          SET custo_produto = $3,
              imposto_percentual = $4,
              taxa_fixa = $5,
              id_model = $6,
              produto_nome = COALESCE($7, produto_nome),
              variacao_nome = COALESCE($8, variacao_nome),
              sku = COALESCE($9, sku),
              updated_at = CURRENT_TIMESTAMP
        WHERE base_id = $1 AND produto_id = $2
        RETURNING ${COLUNAS_CUSTO_RETORNO}`,
      [baseId, produtoIdNorm, custoProduto, impostoFinal, taxaFinal, idModelFinal, produtoNomeFinal, variacaoNomeFinal, skuFinal]
    );

    await tocarUpdatedAtBase(baseId);

    return { acao: "atualizado", custo: upd.rows[0] };
  }

  const padrao = await obterPadraoCustoBase(baseId);
  const impostoFinal = impostoPercentualOpt.tem ? impostoPercentualOpt.numero : padrao.imposto_percentual;
  const taxaFinal = taxaOpt.tem ? taxaOpt.numero : (isTikTok ? 0 : padrao.taxa_fixa);

  const ins = await pool.query(
    `INSERT INTO custos (base_id, produto_id, sku_id, custo_produto, imposto_percentual, taxa_fixa, id_model, produto_nome, variacao_nome, sku, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
     RETURNING ${COLUNAS_CUSTO_RETORNO}`,
    [baseId, produtoIdNorm || "", skuIdFinal, custoProduto, impostoFinal, taxaFinal, idModelEntrada || null, produtoNomeFinal, variacaoNomeFinal, skuFinal || ""]
  );

  await tocarUpdatedAtBase(baseId);

  return { acao: "criado", custo: ins.rows[0] };
}

// Colunas novas de `custos` + índices de unicidade. Idempotente: roda no boot e
// na rota /setup sem quebrar bases já existentes. Espelha a migration
// 20260810_add_sku_id_tiktok.sql — as duas precisam continuar equivalentes.
async function ensureColunasCustos() {
  await pool.query(`ALTER TABLE custos ADD COLUMN IF NOT EXISTS produto_nome TEXT`);
  await pool.query(`ALTER TABLE custos ADD COLUMN IF NOT EXISTS variacao_nome TEXT`);
  await pool.query(`ALTER TABLE custos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);
  // LEGADO: SKU textual. MELI/Shopee nunca preenchem (fica ''); TikTok deixou
  // de usar quando a identidade passou a ser sku_id.
  await pool.query(`ALTER TABLE custos ADD COLUMN IF NOT EXISTS sku TEXT NOT NULL DEFAULT ''`);
  // TikTok Shop: sku_id = ID DO SKU (id da variação, 18–19 dígitos, TEXT).
  // É a identidade de custo do TikTok — o mesmo produto_id repete entre as
  // variações. MELI/Shopee nunca preenchem esta coluna (fica '').
  await pool.query(`ALTER TABLE custos ADD COLUMN IF NOT EXISTS sku_id TEXT NOT NULL DEFAULT ''`);
  await pool.query(`
    DO $$
    BEGIN
      ALTER TABLE custos DROP CONSTRAINT IF EXISTS custos_base_id_produto_id_key;
    EXCEPTION WHEN undefined_object THEN NULL;
    END $$;
  `);
  await pool.query(`DROP INDEX IF EXISTS uq_custos_base_produto_sku`);
  // TikTok: uma linha por variação.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_custos_base_sku_id
       ON custos (base_id, sku_id) WHERE sku_id <> ''`
  );
  // MELI/Shopee (e linhas TikTok legadas sem sku_id): identidade histórica.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_custos_base_produto_sku_legado
       ON custos (base_id, produto_id, sku) WHERE sku_id = ''`
  );
}

// Marca a base como atualizada agora sempre que um custo é criado/alterado.
async function tocarUpdatedAtBase(baseId) {
  await pool.query(`UPDATE bases SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [baseId]);
}

// ---------------------------------------------------------------------------
// Base vinculada para fechamento financeiro (MELI).
// Resolve a base (por id explícito OU pelo vínculo cliente+marketplace) e
// converte os custos do banco no MESMO formato de linha que o parser de custos
// do MELI já entende (ver parseMeliCostRows em meliFinanceiroService.js).
// Objetivo: mudar a ORIGEM dos custos sem tocar na fórmula de LC/MC.
// ---------------------------------------------------------------------------
// Resolve a base de custos vinculada a um cliente+marketplace para o
// fechamento financeiro (MELI/Shopee — TikTok usa a variante estrita abaixo).
//
// baseId explícito sempre vence (comportamento pré-existente). Sem baseId,
// busca os vínculos ativos e só escolhe sozinha quando não há ambiguidade
// REAL entre contas: múltiplos vínculos com o MESMO cliente_conta_id
// (histórico de reimportação) ou com cliente_conta_id NULL (legado) não são
// ambíguos — o ORDER BY updated_at DESC continua decidindo entre eles como
// sempre decidiu. Só quando existem 2+ cliente_conta_id DISTINTOS e não-nulos
// (o cliente tem 2+ contas do marketplace, cada uma vinculada a uma base) é
// que a escolha automática pararia de ser segura — nesse caso o erro
// MULTIPLE_MARKETPLACE_ACCOUNTS pede clienteContaId em vez de escolher a
// vinculação mais recente em silêncio (mesma classe de bug já corrigida em
// Ads/Métricas ML, aqui manifestada como "base de custos errada").
async function resolverBaseVinculada({ baseId, clienteSlug, marketplace, clienteContaId = null }) {
  const idNum = Number(baseId);
  const temBaseId = Number.isInteger(idNum) && idNum > 0;

  const slug = String(clienteSlug || "").trim().toLowerCase();
  const mkt = String(marketplace || "").trim().toLowerCase();

  // V3 P2.7 BLOCO L — sem cliente nao ha como PROVAR posse da base. Antes,
  // um baseId sem cliente resolvia direto pelo id; agora e recusado
  // (fail-closed) em vez de devolver a base de quem quer que seja.
  if (!slug || !mkt) {
    if (temBaseId) {
      throw criarHttpErro(400, {
        ok: false,
        code: "BASE_SEM_CONTEXTO_DE_CLIENTE",
        erro: "Informe o cliente e o marketplace para usar uma base de custos especifica.",
      });
    }
    return null;
  }

  const r = await pool.query(
    `SELECT b.id, b.slug, b.nome, v.cliente_conta_id
       FROM bases b
       JOIN base_cliente_vinculos v
         ON v.base_id = b.id AND v.ativo = true
       JOIN clientes c
         ON c.id = v.cliente_id
      WHERE LOWER(c.slug) = $1
        AND v.marketplace = $2
        AND b.ativo = true
      ORDER BY v.updated_at DESC`,
    [slug, mkt]
  );
  const candidatos = r.rows;

  // V3 P2.7 BLOCO L — IDOR fechado. O baseId explicito CONTINUA tendo
  // prioridade sobre a escolha automatica (segue sem disparar o 409 de
  // ambiguidade), mas agora so vale se a base estiver ativa E vinculada a
  // ESTE cliente NESTE marketplace. Antes, `SELECT ... FROM bases WHERE
  // id = $1 AND ativo = true` retornava antes de qualquer leitura de
  // vinculo: como `costsBaseId` vem do corpo do request, dava para fechar o
  // Cliente A com a base de custos do Cliente B so trocando o numero.
  // Mesma resposta para "base de outro cliente", "base inativa" e "base
  // inexistente": nao vazamos se o id existe.
  if (temBaseId) {
    const daBase = candidatos.find((c) => Number(c.id) === idNum);
    if (daBase) return { id: daBase.id, slug: daBase.slug, nome: daBase.nome };
    throw criarHttpErro(403, {
      ok: false,
      code: "BASE_NAO_PERTENCE_AO_CLIENTE",
      erro: "A base de custos informada nao esta ativa e vinculada a este cliente neste marketplace.",
    });
  }

  if (!candidatos.length) return null;

  const contaIdNum = Number(clienteContaId);
  const temContaId = Number.isInteger(contaIdNum) && contaIdNum > 0;

  if (temContaId) {
    // clienteContaId explícito é a fonte de verdade: só o vínculo daquela
    // conta (ou o legado cliente_conta_id IS NULL, se a conta ainda não tiver
    // vínculo próprio). Nunca cai para a base de outra conta.
    const daConta = candidatos.find((c) => c.cliente_conta_id === contaIdNum);
    if (daConta) return { id: daConta.id, slug: daConta.slug, nome: daConta.nome };
    const legado = candidatos.find((c) => c.cliente_conta_id == null);
    return legado ? { id: legado.id, slug: legado.slug, nome: legado.nome } : null;
  }

  const contaIdsDistintos = [...new Set(candidatos.map((c) => c.cliente_conta_id).filter((id) => id != null))];
  if (contaIdsDistintos.length > 1) {
    const contasResult = await pool.query(
      "SELECT * FROM cliente_contas WHERE id = ANY($1::int[]) ORDER BY is_primary DESC, created_at ASC, id ASC",
      [contaIdsDistintos]
    );
    throw criarHttpErro(409, {
      ok: false,
      code: "MULTIPLE_MARKETPLACE_ACCOUNTS",
      erro: "O cliente possui mais de uma conta vinculada a bases de custos diferentes para este marketplace; informe clienteContaId.",
      contas: contasResult.rows.map(sanitizarConta),
    });
  }

  const escolhido = candidatos[0];
  return { id: escolhido.id, slug: escolhido.slug, nome: escolhido.nome };
}

// ---------------------------------------------------------------------------
// Vínculo estrito (TikTok).
// resolverBaseVinculada aceita um baseId explícito só conferindo "base ativa",
// o que permitiria fechar um cliente com a base de OUTRO cliente/marketplace.
// Para o TikTok a base só vale quando o vínculo prova a posse: cliente certo,
// vínculo ativo e marketplace do vínculo igual ao do fechamento.
// ---------------------------------------------------------------------------
const MARKETPLACES_VINCULO_ESTRITO = new Set(["tiktok"]);

function exigeVinculoEstrito(marketplace) {
  return MARKETPLACES_VINCULO_ESTRITO.has(
    String(marketplace || "").trim().toLowerCase()
  );
}

function normalizarComparacao(valor) {
  return String(valor == null ? "" : valor).trim().toLowerCase();
}

// Pura e testável sem banco: decide se um candidato (base + vínculo + cliente)
// serve para o fechamento pedido. Qualquer "não" aqui bloqueia o cálculo.
function vinculoBaseEhValido(candidato, { clienteSlug, marketplace, baseId }) {
  if (!candidato) return false;

  const mkt = normalizarComparacao(marketplace);
  const slug = normalizarComparacao(clienteSlug);
  if (!mkt || !slug) return false;

  // O vínculo precisa ser deste cliente e estar ativo.
  if (normalizarComparacao(candidato.cliente_slug) !== slug) return false;
  if (candidato.vinculo_ativo !== true) return false;
  if (normalizarComparacao(candidato.vinculo_marketplace) !== mkt) return false;

  // A base precisa estar ativa e, quando declara marketplace, ser do mesmo
  // canal. Base sem marketplace preenchido (legado) é decidida pelo vínculo.
  if (candidato.base_ativa === false) return false;
  const baseMkt = normalizarComparacao(candidato.base_marketplace);
  if (baseMkt && baseMkt !== mkt) return false;

  // baseId explícito nunca "cai" para outra base: ou é aquela, ou nada.
  if (baseId !== null && baseId !== undefined && Number(candidato.id) !== Number(baseId)) {
    return false;
  }

  return true;
}

// Motivo legível da recusa — vira mensagem de erro para quem opera a tela.
function motivoVinculoInvalido(candidato, { clienteSlug, marketplace }) {
  const mkt = normalizarComparacao(marketplace);
  if (!candidato) return "não existe vínculo ativo desta base com o cliente";
  if (normalizarComparacao(candidato.cliente_slug) !== normalizarComparacao(clienteSlug)) {
    return "a base está vinculada a outro cliente";
  }
  if (candidato.vinculo_ativo !== true) return "o vínculo da base com o cliente está inativo";
  if (normalizarComparacao(candidato.vinculo_marketplace) !== mkt) {
    return `o vínculo é do marketplace "${candidato.vinculo_marketplace || "vazio"}", não "${mkt}"`;
  }
  if (candidato.base_ativa === false) return "a base está inativa";
  const baseMkt = normalizarComparacao(candidato.base_marketplace);
  if (baseMkt && baseMkt !== mkt) {
    return `a base é do marketplace "${baseMkt}", não "${mkt}"`;
  }
  return "a base informada não é a base vinculada a este cliente";
}

const SQL_CANDIDATOS_VINCULO = `
  SELECT b.id,
         b.slug,
         b.nome,
         b.ativo            AS base_ativa,
         b.marketplace      AS base_marketplace,
         v.ativo            AS vinculo_ativo,
         v.marketplace      AS vinculo_marketplace,
         LOWER(c.slug)      AS cliente_slug,
         v.updated_at
    FROM base_cliente_vinculos v
    JOIN bases b    ON b.id = v.base_id
    JOIN clientes c ON c.id = v.cliente_id
   WHERE LOWER(c.slug) = $1
     AND ($2::int IS NULL OR b.id = $2::int)
   ORDER BY v.updated_at DESC NULLS LAST`;

// Devolve { base } ou lança erro explicando por que a base foi recusada.
async function resolverBaseVinculadaEstrita({ baseId, clienteSlug, marketplace }) {
  const mkt = normalizarComparacao(marketplace);
  const slug = normalizarComparacao(clienteSlug);
  const idNum = Number(baseId);
  const temId = Number.isInteger(idNum) && idNum > 0;

  if (!slug) {
    throw criarHttpErro(400, {
      ok: false,
      erro: `Selecione o cliente para localizar a base vinculada de ${mkt || "marketplace"}.`,
    });
  }

  const r = await pool.query(SQL_CANDIDATOS_VINCULO, [slug, temId ? idNum : null]);
  const candidatos = r.rows || [];

  const valido = candidatos.find((candidato) =>
    vinculoBaseEhValido(candidato, {
      clienteSlug: slug,
      marketplace: mkt,
      baseId: temId ? idNum : null,
    })
  );

  if (valido) {
    return { id: valido.id, slug: valido.slug, nome: valido.nome };
  }

  if (candidatos.length > 0) {
    throw criarHttpErro(422, {
      ok: false,
      erro:
        `Base recusada para o fechamento de ${mkt}: ` +
        `${motivoVinculoInvalido(candidatos[0], { clienteSlug: slug, marketplace: mkt })}. ` +
        "Ajuste o vínculo na tela de Bases.",
    });
  }

  throw criarHttpErro(404, {
    ok: false,
    erro:
      `Nenhuma base de ${mkt} ativa e vinculada a este cliente. ` +
      "Cadastre ou vincule a base na tela de Bases antes de processar o fechamento.",
  });
}

// ---------------------------------------------------------------------------
// Base TikTok — seleção manual (sem vínculo com cliente).
// A tela /financeiro carrega um select "Base de custos TikTok" com as bases
// ativas de marketplace=tiktok e o usuário escolhe qual usar. O backend só
// precisa confirmar que a base existe, está ativa e é mesmo do TikTok — não
// há cliente/vínculo envolvido nesta validação.
// ---------------------------------------------------------------------------
async function resolverBaseTikTokPorId(baseId) {
  const idNum = Number(baseId);
  if (!Number.isInteger(idNum) || idNum <= 0) {
    throw criarHttpErro(400, {
      ok: false,
      erro: "Selecione uma Base TikTok antes de processar o fechamento.",
    });
  }

  const r = await pool.query(
    "SELECT id, slug, nome, marketplace, ativo FROM bases WHERE id = $1",
    [idNum]
  );
  if (!r.rows.length) {
    throw criarHttpErro(404, { ok: false, erro: "Base TikTok não encontrada." });
  }

  const base = r.rows[0];
  if (base.ativo !== true) {
    throw criarHttpErro(422, {
      ok: false,
      erro: `A base "${base.nome || base.slug}" está inativa.`,
    });
  }
  if (normalizarComparacao(base.marketplace) !== "tiktok") {
    throw criarHttpErro(422, {
      ok: false,
      erro: `A base "${base.nome || base.slug}" não é uma Base TikTok (marketplace: "${base.marketplace || "vazio"}").`,
    });
  }

  return { id: base.id, slug: base.slug, nome: base.nome };
}

async function buildCostRowsFromBase({ baseId, clienteSlug, marketplace, clienteContaId = null }) {
  const mkt = String(marketplace || "").trim().toLowerCase();
  const isTikTok = mkt === "tiktok";

  // TikTok: seleção manual da base (sem vínculo com cliente — ver
  // resolverBaseTikTokPorId). MELI/Shopee seguem exatamente o caminho histórico.
  const base = isTikTok
    ? await resolverBaseTikTokPorId(baseId)
    : exigeVinculoEstrito(marketplace)
      ? await resolverBaseVinculadaEstrita({ baseId, clienteSlug, marketplace })
      : await resolverBaseVinculada({ baseId, clienteSlug, marketplace, clienteContaId });

  if (!base) {
    throw criarHttpErro(404, {
      ok: false,
      erro: "Nenhuma base vinculada encontrada para este cliente/marketplace.",
    });
  }

  const custos = await pool.query(
    `SELECT produto_id, sku_id, sku, custo_produto, imposto_percentual, id_model, produto_nome, variacao_nome
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

  // O formato depende do marketplace porque cada motor tem o seu parser de
  // custos. MELI mantém exatamente o retorno histórico (parseMeliCostRows).
  // TikTok recebe as chaves do seu parser: "ID" (product_id, informativo) e
  // "ID do SKU" (sku_id — a ÚNICA chave de cruzamento). Ambos continuam
  // STRING, sem qualquer conversão numérica (IDs de 18–19 dígitos).
  const isShopee = mkt === "shopee";
  let costRows;
  if (isTikTok) {
    costRows = custos.rows.map((row) => ({
      "ID": row.produto_id || "",
      "ID do SKU": row.sku_id || "",
      "Custo unitário": row.custo_produto,
      "Imposto (%)": row.imposto_percentual,
      "Nome do produto": row.produto_nome || "",
      "Nome da variação": row.variacao_nome || "",
    }));
  } else if (isShopee) {
    // Missão Financeiro V3 — paridade operacional com o MELI: quando existe
    // base Shopee vinculada à conta, o fechamento usa os custos dela em vez
    // de exigir upload. As chaves aqui são exatamente as que o parser de
    // custos da Shopee (parseCostRows em shopeePerformanceService) já
    // reconhece — nenhuma regra de match/fórmula/motor é tocada, só a
    // ORIGEM das linhas muda (banco em vez de planilha).
    //
    // Uma linha por registro de `custos` = uma linha por variação: o mesmo
    // produto_id repete entre variações, cada uma com seu id_model/sku e seu
    // custo próprio. O motor endereça o custo por model_id antes de cair no
    // produto-pai (mesma prioridade de sempre: saleModelId → id → itemId).
    const temIdentificador = custos.rows.some(
      (row) =>
        String(row.produto_id || "").trim() !== "" ||
        String(row.id_model || "").trim() !== "" ||
        String(row.sku || "").trim() !== ""
    );
    if (!temIdentificador) {
      // Bloqueia em vez de "achatar" tudo num produto-pai sem identidade —
      // um fechamento com custo errado silencioso é pior do que pedir ajuste.
      throw criarHttpErro(422, {
        ok: false,
        erro:
          `A base vinculada "${base.nome || base.slug}" não tem nenhum identificador ` +
          "de produto/variação (ID do item, ID Model ou SKU) para cruzar com as vendas Shopee. " +
          "Ajuste a base na tela de Bases ou envie a planilha de custos manualmente.",
      });
    }
    costRows = custos.rows.map((row) => ({
      "id do item": row.produto_id || "",
      "id model": row.id_model || "",
      sku: row.sku || "",
      custo: row.custo_produto,
      imposto: row.imposto_percentual,
    }));
  } else {
    // MELI — chaves reconhecidas por findField/parseMeliCostRows (normalização
    // por acento/caixa). Retorno histórico, inalterado.
    costRows = custos.rows.map((row) => ({
      "# de anúncio": row.produto_id,
      "preço de custo": row.custo_produto,
      imposto: row.imposto_percentual,
      model_id: row.id_model || "",
    }));
  }

  return {
    base: { id: base.id, slug: base.slug, nome: base.nome },
    costRows,
  };
}

module.exports = {
  MARKETPLACES_SUPORTADOS,
  ERRO_ID_TIKTOK_CIENTIFICO,
  erroCientificoTikTok,
  normalizarProdutoIdBase,
  normalizarProdutoIdShopee,
  normalizarProdutoIdTikTok,
  normalizarSkuIdTikTok,
  normalizarSkuTikTok,
  erroSkuIdDuplicadoTikTok,
  ensureColunasCustos,
  obterBaseAtivaPorSlug,
  obterPadraoCustoBase,
  upsertCustoBase,
  validarNumeroObrigatorio,
  validarNumeroOpcional,
  criarHttpErro,
  resolverBaseVinculada,
  resolverBaseVinculadaEstrita,
  resolverBaseTikTokPorId,
  vinculoBaseEhValido,
  motivoVinculoInvalido,
  exigeVinculoEstrito,
  buildCostRowsFromBase,
};

