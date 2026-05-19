// server/services/meliAnuncios/otimizadorMeliService.js
// -----------------------------------------------------------------------------
// Service do Agente Otimizador Textual de Anúncios Meli.
//
// Fluxo:
//   1. garante o schema da tabela meli_anuncio_otimizacoes;
//   2. busca o anúncio salvo (meli_anuncios) via meliAnunciosService;
//   3. monta o prompt do tipo pedido;
//   4. chama a IA pela camada aiProvider (gerarJSON);
//   5. valida a resposta conforme o tipo;
//   6. salva a sugestão no banco;
//   7. devolve a sugestão.
//
// Fase 1: SOMENTE leitura/sugestão. Nada é atualizado no Mercado Livre.
// Apenas o tipo "seo" está liberado (ver TIPOS_VALIDOS). Os prompts de
// "descricao" e "ficha_tecnica" existem no arquivo de prompts mas não são
// aceitos pelo service ainda.
// -----------------------------------------------------------------------------

const _dbModule = require("../../config/database");
const db =
  _dbModule && typeof _dbModule.query === "function"
    ? _dbModule
    : _dbModule.pool || _dbModule.default || _dbModule;

const aiProvider = require("../ai/aiProvider");
const prompts = require("./otimizadorMeliPrompts");
const anunciosService = require("./meliAnunciosService");

// ETAPA 1: somente "seo" liberado. Os prompts de "descricao" e "ficha_tecnica"
// existem em otimizadorMeliPrompts.js, mas NÃO são aceitos pelo service ainda.
// Para liberar depois, basta adicionar o tipo a este array.
const TIPOS_VALIDOS = ["seo"];
const TITULO_MIN = 55;
const TITULO_MAX = 60;

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
let _schemaPronto = false;

async function ensureSchema() {
  if (_schemaPronto) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS meli_anuncio_otimizacoes (
      id          SERIAL PRIMARY KEY,
      cliente_id  INTEGER,
      cliente_slug TEXT,
      item_id     TEXT NOT NULL,
      sku         TEXT,

      tipo        TEXT NOT NULL,
      status      TEXT DEFAULT 'rascunho',

      titulo_atual          TEXT,
      titulo_sugerido       TEXT,
      titulo_sugerido_chars INTEGER,

      modelo_atual    TEXT,
      modelo_sugerido TEXT,

      descricao_atual   TEXT,
      descricao_sugerida TEXT,

      ficha_tecnica_atual_json    JSONB,
      ficha_tecnica_sugerida_json JSONB,

      score_seo      NUMERIC,
      motivo         TEXT,
      melhorias_json JSONB,
      alertas_json   JSONB,

      ai_provider    TEXT,
      ai_model       TEXT,
      prompt_version TEXT,

      usage_json    JSONB,
      input_tokens  INTEGER,
      output_tokens INTEGER,

      raw_response_json JSONB,

      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // ALTERs idempotentes: garantem as colunas de usage mesmo que a tabela
  // já tenha sido criada por uma versão anterior sem esses campos.
  await db.query(
    `ALTER TABLE meli_anuncio_otimizacoes ADD COLUMN IF NOT EXISTS usage_json JSONB;`
  );
  await db.query(
    `ALTER TABLE meli_anuncio_otimizacoes ADD COLUMN IF NOT EXISTS input_tokens INTEGER;`
  );
  await db.query(
    `ALTER TABLE meli_anuncio_otimizacoes ADD COLUMN IF NOT EXISTS output_tokens INTEGER;`
  );

  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_meli_otimizacoes_item_id ON meli_anuncio_otimizacoes (item_id);`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_meli_otimizacoes_cliente_slug ON meli_anuncio_otimizacoes (cliente_slug);`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_meli_otimizacoes_tipo ON meli_anuncio_otimizacoes (tipo);`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_meli_otimizacoes_status ON meli_anuncio_otimizacoes (status);`
  );

  _schemaPronto = true;
}

// -----------------------------------------------------------------------------
// Validações por tipo. Retornam { ok, erro? }.
// -----------------------------------------------------------------------------
function validarSeo(d) {
  if (!d || typeof d !== "object") return { ok: false, erro: "Resposta vazia." };
  if (!d.titulo_sugerido || !String(d.titulo_sugerido).trim()) {
    return { ok: false, erro: "A IA não retornou um título sugerido." };
  }
  const titulo = String(d.titulo_sugerido).trim();
  if (titulo.length > TITULO_MAX) {
    return {
      ok: false,
      erro:
        "O título sugerido tem " +
        titulo.length +
        " caracteres (limite do Mercado Livre é " +
        TITULO_MAX +
        ").",
    };
  }
  if (titulo.length < TITULO_MIN) {
  return {
    ok: false,
    erro:
      "O título sugerido tem " +
      titulo.length +
      " caracteres. O objetivo é usar entre " +
      TITULO_MIN +
      " e " +
      TITULO_MAX +
      " caracteres para aproveitar melhor o limite do Mercado Livre.",
  };
}
  if (!d.modelo_sugerido || !String(d.modelo_sugerido).trim()) {
    return { ok: false, erro: "A IA não retornou um campo modelo sugerido." };
  }
  return { ok: true };
}

function validarDescricao(d) {
  if (!d || typeof d !== "object") return { ok: false, erro: "Resposta vazia." };
  if (!d.descricao_sugerida || !String(d.descricao_sugerida).trim()) {
    return { ok: false, erro: "A IA não retornou uma descrição sugerida." };
  }
  return { ok: true };
}

function validarFichaTecnica(d) {
  if (!d || typeof d !== "object") return { ok: false, erro: "Resposta vazia." };
  if (!Array.isArray(d.ficha_tecnica_sugerida)) {
    return {
      ok: false,
      erro: "A IA não retornou a lista de ficha técnica sugerida.",
    };
  }
  return { ok: true };
}

function arr(v) {
  return Array.isArray(v) ? v : [];
}

// -----------------------------------------------------------------------------
// Persistência da sugestão. Monta o registro conforme o tipo e insere.
// raw_response_json só é gravado quando informado (falha de JSON, p/ debug).
// -----------------------------------------------------------------------------
async function salvarOtimizacao(reg) {
  const { rows } = await db.query(
    `INSERT INTO meli_anuncio_otimizacoes (
        cliente_id, cliente_slug, item_id, sku,
        tipo, status,
        titulo_atual, titulo_sugerido, titulo_sugerido_chars,
        modelo_atual, modelo_sugerido,
        descricao_atual, descricao_sugerida,
        ficha_tecnica_atual_json, ficha_tecnica_sugerida_json,
        score_seo, motivo, melhorias_json, alertas_json,
        ai_provider, ai_model, prompt_version,
        usage_json, input_tokens, output_tokens,
        raw_response_json,
        created_by, updated_at
      ) VALUES (
        $1,$2,$3,$4,
        $5,$6,
        $7,$8,$9,
        $10,$11,
        $12,$13,
        $14,$15,
        $16,$17,$18,$19,
        $20,$21,$22,
        $23,$24,$25,
        $26,
        $27, NOW()
      )
      RETURNING *;`,
    [
      reg.cliente_id,
      reg.cliente_slug,
      reg.item_id,
      reg.sku,
      reg.tipo,
      reg.status || "rascunho",
      reg.titulo_atual,
      reg.titulo_sugerido,
      reg.titulo_sugerido_chars,
      reg.modelo_atual,
      reg.modelo_sugerido,
      reg.descricao_atual,
      reg.descricao_sugerida,
      reg.ficha_tecnica_atual_json
        ? JSON.stringify(reg.ficha_tecnica_atual_json)
        : null,
      reg.ficha_tecnica_sugerida_json
        ? JSON.stringify(reg.ficha_tecnica_sugerida_json)
        : null,
      reg.score_seo,
      reg.motivo,
      reg.melhorias_json ? JSON.stringify(reg.melhorias_json) : null,
      reg.alertas_json ? JSON.stringify(reg.alertas_json) : null,
      reg.ai_provider,
      reg.ai_model,
      reg.prompt_version,
      reg.usage_json ? JSON.stringify(reg.usage_json) : null,
      reg.input_tokens != null ? reg.input_tokens : null,
      reg.output_tokens != null ? reg.output_tokens : null,
      reg.raw_response_json ? JSON.stringify(reg.raw_response_json) : null,
      reg.created_by || null,
    ]
  );
  return rows[0];
}

// -----------------------------------------------------------------------------
// otimizar — função principal chamada pelo controller.
//
// Parâmetros: { clienteSlug, itemId, tipo, userId? }
//
// Retorno padronizado (NUNCA lança):
//   sucesso        -> { ok:true, tipo, otimizacao }
//   erro validável -> { ok:false, http, codigo, motivo }
//     http 400 -> tipo inválido / faltando dado
//     http 404 -> cliente ou anúncio não encontrado
//     http 200 -> falha da IA (NO_API_KEY, JSON_INVALIDO, etc.) -> ok:false
// -----------------------------------------------------------------------------
async function otimizar({ clienteSlug, itemId, tipo, userId }) {
  await ensureSchema();

  // --- validação de entrada
  if (!clienteSlug) {
    return { ok: false, http: 400, codigo: "SEM_CLIENTE", motivo: "Informe o clienteSlug." };
  }
  if (!itemId) {
    return { ok: false, http: 400, codigo: "SEM_ITEM", motivo: "Informe o itemId." };
  }
  if (!tipo || TIPOS_VALIDOS.indexOf(tipo) === -1) {
    return {
      ok: false,
      http: 400,
      codigo: "TIPO_INVALIDO",
      motivo:
        "Tipo inválido. Use um destes: " + TIPOS_VALIDOS.join(", ") + ".",
    };
  }

  // --- resolve cliente
  const cliente = await anunciosService.resolverCliente(clienteSlug);
  if (!cliente) {
    return {
      ok: false,
      http: 404,
      codigo: "NO_CLIENT",
      motivo: "Cliente não encontrado.",
    };
  }

  // --- busca o anúncio já sincronizado
  const anuncio = await anunciosService.obterAnuncio(cliente.id, itemId);
  if (!anuncio) {
    return {
      ok: false,
      http: 404,
      codigo: "NO_ITEM",
      motivo:
        "Anúncio não encontrado no banco. Sincronize os anúncios deste cliente antes de otimizar.",
    };
  }

  // --- monta prompt
  const promptTexto = prompts.montarPrompt(tipo, anuncio);
  if (!promptTexto) {
    return {
      ok: false,
      http: 400,
      codigo: "TIPO_INVALIDO",
      motivo: "Tipo de otimização não suportado.",
    };
  }

  // --- chama a IA
  const ia = await aiProvider.gerarJSON({
    system: prompts.SYSTEM_BASE,
    prompt: promptTexto,
    maxTokens: tipo === "descricao" ? 2200 : 1400,
    temperature: 0.4,
  });

  if (!ia.ok) {
    // falha esperada da IA -> HTTP 200 + ok:false para o frontend tratar bonito
    return {
      ok: false,
      http: 200,
      codigo: ia.codigo || "IA_ERRO",
      motivo: ia.erro || "Falha ao gerar a sugestão com a IA.",
    };
  }

  // --- valida o JSON conforme o tipo
  const d = ia.data;
  let validacao;
  if (tipo === "seo") validacao = validarSeo(d);
  else if (tipo === "descricao") validacao = validarDescricao(d);
  else validacao = validarFichaTecnica(d);

  if (!validacao.ok) {
    return {
      ok: false,
      http: 200,
      codigo: "RESPOSTA_INVALIDA",
      motivo: validacao.erro,
    };
  }

  // --- monta o registro para salvar
  const usage = ia.usage || null;
  const base = {
    cliente_id: cliente.id,
    cliente_slug: cliente.slug,
    item_id: anuncio.item_id,
    sku: anuncio.sku || null,
    tipo: tipo,
    status: "rascunho",
    ai_provider: ia.provider,
    ai_model: ia.model,
    prompt_version: prompts.PROMPT_VERSION,
    usage_json: usage,
    input_tokens: usage && usage.input_tokens != null ? usage.input_tokens : null,
    output_tokens:
      usage && usage.output_tokens != null ? usage.output_tokens : null,
    created_by: userId || null,
  };

  if (tipo === "seo") {
    const titulo = String(d.titulo_sugerido).trim();
    base.titulo_atual = anuncio.titulo || null;
    base.titulo_sugerido = titulo;
    base.titulo_sugerido_chars = titulo.length;
    base.modelo_atual = anuncio.modelo || null;
    base.modelo_sugerido = String(d.modelo_sugerido).trim();
    base.score_seo =
      typeof d.score_seo === "number" ? d.score_seo : null;
    base.motivo = d.motivo ? String(d.motivo) : null;
    base.alertas_json = arr(d.alertas);
  } else if (tipo === "descricao") {
    base.descricao_atual = anuncio.descricao_atual || null;
    base.descricao_sugerida = String(d.descricao_sugerida).trim();
    base.melhorias_json = arr(d.melhorias);
    base.alertas_json = arr(d.alertas);
  } else {
    // ficha_tecnica
    let atual = [];
    try {
      atual = Array.isArray(anuncio.attributes_json)
        ? anuncio.attributes_json
        : JSON.parse(anuncio.attributes_json || "[]");
    } catch (e) {
      atual = [];
    }
    base.ficha_tecnica_atual_json = atual;
    base.ficha_tecnica_sugerida_json = arr(d.ficha_tecnica_sugerida);
    base.alertas_json = arr(d.alertas);
  }

  // --- salva
  let salvo;
  try {
    salvo = await salvarOtimizacao(base);
  } catch (err) {
    console.error("[otimizador-meli] salvar:", err.message);
    return {
      ok: false,
      http: 500,
      codigo: "ERRO_BANCO",
      motivo: "Sugestão gerada, mas houve erro ao salvar no banco.",
    };
  }

  return { ok: true, tipo: tipo, otimizacao: salvo };
}

// -----------------------------------------------------------------------------
// listarOtimizacoes — histórico de sugestões de um anúncio (uso futuro/curl).
// -----------------------------------------------------------------------------
async function listarOtimizacoes({ clienteSlug, itemId, tipo }) {
  await ensureSchema();

  const cliente = await anunciosService.resolverCliente(clienteSlug);
  if (!cliente) {
    return { ok: false, http: 404, motivo: "Cliente não encontrado." };
  }

  const params = [cliente.id, String(itemId)];
  let sql =
    `SELECT * FROM meli_anuncio_otimizacoes
       WHERE cliente_id = $1 AND item_id = $2`;
  if (tipo) {
    params.push(tipo);
    sql += ` AND tipo = $3`;
  }
  sql += ` ORDER BY created_at DESC LIMIT 50;`;

  const { rows } = await db.query(sql, params);
  return { ok: true, otimizacoes: rows };
}

module.exports = {
  ensureSchema,
  otimizar,
  listarOtimizacoes,
  TIPOS_VALIDOS,
  TITULO_MIN,
  TITULO_MAX,
};
