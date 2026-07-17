// server/services/automacoes/contextoPrecificacaoService.js
// Resolução única do contexto de precificação ML de um cliente:
//   - cliente selecionado
//   - grant/token ML vinculado
//   - base ATIVA vinculada ao cliente no marketplace MELI
//
// Toda a lógica de "qual base do cliente usar" mora aqui. Nenhum outro
// service deve refazer a consulta em base_cliente_vinculos — precificação,
// diagnóstico e (compat) preview passam por estas funções.
//
// A base continua sendo a fonte de custo, imposto e taxa fixa; o grant ML
// continua sendo a fonte de anúncios, preço, promoção, comissão e frete.
// Este arquivo apenas RESOLVE qual base/grant usar; não calcula nada.

const pool = require("../../config/database");

function normalizarSlug(nome) {
  return String(nome || "").trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function criarErroHttp(statusCode, payload) {
  const err = new Error(payload?.erro || "Erro");
  err.statusCode = statusCode;
  err.payload = payload;
  return err;
}

// Códigos controlados devolvidos ao frontend em `payload.codigo`.
const MOTIVOS = {
  OK: "OK",
  CLIENTE_NAO_ENCONTRADO: "CLIENTE_NAO_ENCONTRADO",
  GRANT_ML_NAO_CONECTADO: "GRANT_ML_NAO_CONECTADO",
  BASE_MELI_NAO_VINCULADA: "BASE_MELI_NAO_VINCULADA",
  MULTIPLAS_BASES_MELI: "MULTIPLAS_BASES_MELI",
};

const MENSAGENS = {
  [MOTIVOS.CLIENTE_NAO_ENCONTRADO]: "Cliente não encontrado.",
  [MOTIVOS.GRANT_ML_NAO_CONECTADO]: "Cliente sem conta ML conectada. Conecte o grant do Mercado Livre.",
  [MOTIVOS.BASE_MELI_NAO_VINCULADA]: "Cliente sem base MELI vinculada. Ajuste o vínculo em Bases de Custo.",
  [MOTIVOS.MULTIPLAS_BASES_MELI]: "Cliente com mais de uma base MELI vinculada. Corrija os vínculos em Bases de Custo.",
};

// Status HTTP por motivo (usado quando o contexto vira erro controlado).
const STATUS_POR_MOTIVO = {
  [MOTIVOS.CLIENTE_NAO_ENCONTRADO]: 404,
  [MOTIVOS.GRANT_ML_NAO_CONECTADO]: 400,
  [MOTIVOS.BASE_MELI_NAO_VINCULADA]: 409,
  [MOTIVOS.MULTIPLAS_BASES_MELI]: 409,
};

// Bases ATIVAS vinculadas ao cliente no marketplace MELI (vínculo ativo).
// Fonte única desta consulta em todo o backend.
async function buscarBasesMeliDoCliente(clienteId) {
  const result = await pool.query(
    `SELECT b.id, b.slug, b.nome, b.ativo, b.created_at, b.updated_at
       FROM base_cliente_vinculos v
       JOIN bases b ON b.id = v.base_id AND b.ativo = true
      WHERE v.cliente_id = $1
        AND v.ativo = true
        AND v.marketplace = 'meli'
      ORDER BY b.updated_at DESC NULLS LAST, b.id ASC`,
    [clienteId]
  );
  return result.rows;
}

// Resolve o contexto de um cliente SEM lançar erro para condições de negócio.
// Lança apenas 404 quando o cliente não existe. Retorna:
// { cliente, grant:{conectado, ml_user_id}, base|null, basesMeli[], pronto, motivo, mensagem }
async function resolverContextoPrecificacao({ clienteSlugRaw }) {
  const clienteSlug = normalizarSlug(clienteSlugRaw);
  if (!clienteSlug) {
    throw criarErroHttp(400, { ok: false, erro: "clienteSlug é obrigatório.", codigo: "CLIENTE_SLUG_OBRIGATORIO" });
  }

  const c = await pool.query(
    "SELECT id, nome, slug FROM clientes WHERE slug = $1 AND ativo = true",
    [clienteSlug]
  );
  if (!c.rows.length) {
    throw criarErroHttp(404, {
      ok: false,
      codigo: MOTIVOS.CLIENTE_NAO_ENCONTRADO,
      erro: MENSAGENS[MOTIVOS.CLIENTE_NAO_ENCONTRADO],
    });
  }
  const cliente = c.rows[0];

  const tok = await pool.query(
    "SELECT ml_user_id FROM ml_tokens WHERE cliente_id = $1 LIMIT 1",
    [cliente.id]
  );
  const mlUserId = tok.rows[0]?.ml_user_id ?? null;
  const grant = { conectado: Boolean(mlUserId), ml_user_id: mlUserId };

  const basesMeli = await buscarBasesMeliDoCliente(cliente.id);

  let base = null;
  let motivo = MOTIVOS.OK;

  if (!grant.conectado) {
    motivo = MOTIVOS.GRANT_ML_NAO_CONECTADO;
  } else if (basesMeli.length === 0) {
    motivo = MOTIVOS.BASE_MELI_NAO_VINCULADA;
  } else if (basesMeli.length > 1) {
    motivo = MOTIVOS.MULTIPLAS_BASES_MELI;
  } else {
    base = basesMeli[0];
  }

  const pronto = motivo === MOTIVOS.OK;

  return {
    cliente: { id: cliente.id, nome: cliente.nome, slug: cliente.slug },
    grant,
    base: base
      ? {
          id: base.id,
          slug: base.slug,
          nome: base.nome,
          ativo: base.ativo,
          created_at: base.created_at,
          updated_at: base.updated_at,
        }
      : null,
    basesMeli,
    pronto,
    motivo,
    mensagem: pronto ? null : MENSAGENS[motivo] || "Contexto de precificação indisponível.",
  };
}

// Valida um baseSlug informado explicitamente (compatibilidade): a base precisa
// existir, estar ativa e estar vinculada ao cliente no marketplace MELI.
async function validarBaseInformada({ clienteId, baseSlugRaw }) {
  const baseSlug = normalizarSlug(baseSlugRaw);
  if (!baseSlug) return null;
  const r = await pool.query(
    `SELECT b.id, b.slug, b.nome, b.ativo, b.created_at, b.updated_at
       FROM base_cliente_vinculos v
       JOIN bases b ON b.id = v.base_id AND b.ativo = true
      WHERE v.cliente_id = $1
        AND v.ativo = true
        AND v.marketplace = 'meli'
        AND b.slug = $2
      LIMIT 1`,
    [clienteId, baseSlug]
  );
  return r.rows[0] || null;
}

// Resolve o contexto e EXIGE que esteja pronto para análise. Usado pelos
// endpoints que precisam de uma base concreta (preview-ml, diagnóstico).
// - Se baseSlugRaw vier (compat), valida se pertence ao cliente + MELI + ativa.
// - Se não vier, resolve automaticamente a base vinculada.
// Lança erro controlado (statusCode + payload.codigo) quando não é possível.
async function exigirContextoPronto({ clienteSlugRaw, baseSlugRaw }) {
  const contexto = await resolverContextoPrecificacao({ clienteSlugRaw });

  // Grant é pré-requisito em qualquer caminho.
  if (!contexto.grant.conectado) {
    throw criarErroHttp(STATUS_POR_MOTIVO[MOTIVOS.GRANT_ML_NAO_CONECTADO], {
      ok: false,
      codigo: MOTIVOS.GRANT_ML_NAO_CONECTADO,
      erro: MENSAGENS[MOTIVOS.GRANT_ML_NAO_CONECTADO],
    });
  }

  const baseSlugStr = String(baseSlugRaw || "").trim();
  if (baseSlugStr) {
    // Caminho de compatibilidade: baseSlug foi informado pelo frontend antigo.
    const base = await validarBaseInformada({ clienteId: contexto.cliente.id, baseSlugRaw: baseSlugStr });
    if (!base) {
      throw criarErroHttp(409, {
        ok: false,
        codigo: MOTIVOS.BASE_MELI_NAO_VINCULADA,
        erro: "Base informada não pertence ao cliente ou não está vinculada ao MELI. Ajuste o vínculo em Bases de Custo.",
      });
    }
    return {
      cliente: contexto.cliente,
      grant: contexto.grant,
      mlUserId: contexto.grant.ml_user_id,
      base,
    };
  }

  // Caminho automático: resolver a base vinculada.
  if (!contexto.pronto) {
    throw criarErroHttp(STATUS_POR_MOTIVO[contexto.motivo] || 409, {
      ok: false,
      codigo: contexto.motivo,
      erro: contexto.mensagem,
    });
  }

  return {
    cliente: contexto.cliente,
    grant: contexto.grant,
    mlUserId: contexto.grant.ml_user_id,
    base: contexto.base,
  };
}

// Resolve e EXIGE apenas cliente + grant ML — usado por rotas somente-leitura
// que não dependem de base de custos (ex.: planilha de precificação sem base).
// Não valida nem exige base MELI vinculada; o chamador decide o que fazer com
// basesMeli (0, 1 ou várias).
async function exigirContextoGrantMl({ clienteSlugRaw }) {
  const contexto = await resolverContextoPrecificacao({ clienteSlugRaw });

  if (!contexto.grant.conectado) {
    throw criarErroHttp(STATUS_POR_MOTIVO[MOTIVOS.GRANT_ML_NAO_CONECTADO], {
      ok: false,
      codigo: MOTIVOS.GRANT_ML_NAO_CONECTADO,
      erro: MENSAGENS[MOTIVOS.GRANT_ML_NAO_CONECTADO],
    });
  }

  return {
    cliente: contexto.cliente,
    grant: contexto.grant,
    mlUserId: contexto.grant.ml_user_id,
    basesMeli: contexto.basesMeli,
    base: contexto.base,
  };
}

module.exports = {
  MOTIVOS,
  MENSAGENS,
  normalizarSlug,
  criarErroHttp,
  buscarBasesMeliDoCliente,
  resolverContextoPrecificacao,
  exigirContextoPronto,
  exigirContextoGrantMl,
};
