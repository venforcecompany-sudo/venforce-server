// server/services/automacoes/contextoPrecificacaoService.js
// Resolução única do contexto de precificação ML de um cliente:
//   - cliente selecionado
//   - Conta ativa e seller/Grant exatos
//   - Base ativa da operação MELI (legado apenas com cardinalidade 1)
//
// Toda a lógica de "qual base do cliente usar" mora aqui. Nenhum outro
// service deve refazer a consulta em base_cliente_vinculos — precificação,
// diagnóstico e (compat) preview passam por estas funções.
//
// A base continua sendo a fonte de custo, imposto e taxa fixa; o grant ML
// continua sendo a fonte de anúncios, preço, promoção, comissão e frete.
// Este arquivo apenas RESOLVE qual base/grant usar; não calcula nada.

const pool = require("../../config/database");
const { resolveMarketplaceAccountContext, resolverContaParaVinculoLegado, obterConta } = require("../clienteContas/clienteContaService");
const { erroContexto, validarIdentidade, validarTitularidadeSeller } = require("../clienteContas/accountContextIdentityService");
const { CODIGOS_CANONICOS } = require("../../utils/erroContextoCanonico");

function normalizarSlug(nome) {
  return String(nome || "").trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function criarErroHttp(statusCode, payload) {
  const err = new Error(payload?.erro || "Erro");
  err.statusCode = statusCode;
  err.payload = payload;
  err.code = payload?.code || payload?.codigo;
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
//
// GRANT_ML_NAO_CONECTADO/BASE_MELI_NAO_VINCULADA/MULTIPLAS_BASES_MELI eram
// 400/409 — indistinguível de requisição malformada ou de ambiguidade de
// autorização. V3 Master Spec M5/§18.5: são falhas de INTEGRAÇÃO (a conta é
// legítima, é a conexão/base que está quebrada), não de autorização —
// convergem para 424, o único status que central-margem-api.js/vf-api.js
// (V3) tratam sem confundir com erro de validação. `codigo` (valor) não
// muda; só o HTTP e o `code` canônico adicional (ver CODE_POR_MOTIVO)
// mudam. Nenhum consumidor decide hoje por status nesta rota — confirmado
// em Portal/central-margem.js, que lê `codigo`/`code`, nunca `res.status`.
const STATUS_POR_MOTIVO = {
  [MOTIVOS.CLIENTE_NAO_ENCONTRADO]: 404,
  [MOTIVOS.GRANT_ML_NAO_CONECTADO]: 424,
  [MOTIVOS.BASE_MELI_NAO_VINCULADA]: 424,
  [MOTIVOS.MULTIPLAS_BASES_MELI]: 424,
};

// Nome canônico (V3) por motivo legado — aditivo: `codigo` continua exposto
// com o valor de sempre; `code` é a tradução para o vocabulário unificado.
const CODE_POR_MOTIVO = {
  [MOTIVOS.CLIENTE_NAO_ENCONTRADO]: CODIGOS_CANONICOS.CLIENTE_NAO_ENCONTRADO,
  [MOTIVOS.GRANT_ML_NAO_CONECTADO]: CODIGOS_CANONICOS.GRANT_DESCONECTADO,
  [MOTIVOS.BASE_MELI_NAO_VINCULADA]: CODIGOS_CANONICOS.BASE_AUSENTE,
  [MOTIVOS.MULTIPLAS_BASES_MELI]: CODIGOS_CANONICOS.BASE_AMBIGUA,
};

// Bases ATIVAS vinculadas ao cliente no marketplace MELI (vínculo ativo).
// Fonte única desta consulta em todo o backend.
// A projeção conserva a identidade e atividade do vínculo para o invariante.
// NULL é legado; a elegibilidade depende da cardinalidade comprovada.
async function buscarBasesMeliDoCliente(clienteId) {
  const result = await pool.query(
    `SELECT b.id, b.slug, b.nome, b.ativo, b.created_at, b.updated_at, b.marketplace, v.cliente_conta_id,
            v.cliente_id, v.marketplace AS vinculo_marketplace, v.ativo AS vinculo_ativo
       FROM base_cliente_vinculos v
       JOIN bases b ON b.id = v.base_id AND b.ativo = true
      WHERE v.cliente_id = $1
        AND v.ativo = true
        AND v.marketplace = 'meli'
        AND b.marketplace = 'meli'
      ORDER BY b.updated_at DESC NULLS LAST, b.id ASC`,
    [clienteId]
  );
  return result.rows;
}

// Uma Base NULL só tem dono operacional comprovável com uma Conta elegível.
// Sem essa prova, nem a seleção explícita de Conta autoriza o fallback.
function basesMeliDaConta(basesMeli, contaId, eligibleAccountCount = null) {
  if (contaId == null) return [];
  return basesMeli.filter((b) => Number(b.cliente_conta_id) === Number(contaId) ||
    (b.cliente_conta_id == null && Number(eligibleAccountCount) === 1));
}

// Quantas cliente_contas ATIVAS o cliente tem no marketplace MELI. MESMA
// consulta que centralVendasService.js já roda (3x) para decidir
// `includeLegacy` — não existe hoje um único ponto exportado no
// código-fonte (cada consumidor duplica esta query, ver também
// meliAnunciosService.js e clienteContaService.obterBaseDaConta); replicada
// aqui para o Motor de Margem seguir a MESMA política, nunca uma regra
// paralela (ver motorMargemService.resolverIncludeLegacy).
async function contarContasMeliAtivas(clienteId) {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS total FROM cliente_contas WHERE cliente_id = $1 AND marketplace = 'meli' AND ativo = true",
    [clienteId]
  );
  return result.rows[0]?.total || 0;
}

// Resolve o contexto. Incoerências/ambiguidades lançam erro; ausência de
// Grant ou Base produz prontidão negativa. Retorna:
// { cliente, conta|null, grant:{conectado, ml_user_id}, base|null, basesMeli[], pronto, motivo, mensagem }
//
// clienteContaId (opcional): a CONTA Mercado Livre selecionada no Shell V3.
// Resolvida via resolveMarketplaceAccountContext (Fundação de Contas) — a
// mesma porta de entrada usada por Central de Vendas, Ads e Anúncios ML —
// para nunca duplicar a regra de "conta pertence ao cliente" / cardinalidade
// (ver clienteContaService.js). Erros ESTRUTURAIS dessa resolução (conta de
// outro cliente, marketplace incompatível, conta inativa, conta ambígua sem
// seleção) sempre propagam intactos: nunca caem de volta no fallback
// legado, que escolheria uma conta em silêncio (o bug que esta função existe
// para corrigir). Sem clienteContaId, a compatibilidade exige exatamente uma Conta ativa.
// Zero Contas nunca aciona o Grant principal.
async function resolverContextoPrecificacao({ clienteSlugRaw, clienteContaId = null }) {
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
      code: CODE_POR_MOTIVO[MOTIVOS.CLIENTE_NAO_ENCONTRADO],
      erro: MENSAGENS[MOTIVOS.CLIENTE_NAO_ENCONTRADO],
    });
  }
  const cliente = c.rows[0];

  // Usa os resolvers existentes para cardinalidade e Conta; zero operações
  // não é autorização para selecionar Grant principal no caminho legado.
  const selecionada = clienteContaId != null && clienteContaId !== "";
  let conta = selecionada
    ? await obterConta(clienteContaId)
    : await resolverContaParaVinculoLegado({ clienteId: cliente.id, marketplace: "meli" });
  if (!conta) throw erroContexto("ACCOUNT_CONTEXT_NOT_FOUND", "Cliente sem operação MELI ativa.", 404);
  validarIdentidade({ cliente, conta });
  await validarTitularidadeSeller(cliente, conta);

  let mlUserId = null;
  let grantId = null;
  try {
    const accountContext = await resolveMarketplaceAccountContext({
      clienteSlug: cliente.slug, marketplace: "meli", clienteContaId: conta.id,
      requireUsableGrant: true,
    });
    validarIdentidade({ cliente, conta: accountContext.conta, grant: accountContext.grant, clienteContaId: conta.id });
    conta = accountContext.conta;
    mlUserId = accountContext.grant?.ml_user_id ?? null;
    grantId = accountContext.grant?.id ?? null;
  } catch (error) {
    // Só indisponibilidade conhecida de integração vira prontidão negativa.
    // Falhas de banco e incoerência de identidade sempre propagam.
    if (!["ML_GRANT_NOT_FOUND", "ML_GRANT_UNUSABLE", "ML_GRANT_REVOKED"].includes(error.code)) throw error;
  }
  const grant = { conectado: Boolean(mlUserId), ml_user_id: mlUserId, id: grantId };
  const basesMeli = await buscarBasesMeliDoCliente(cliente.id);
  const eligibleAccountCount = await contarContasMeliAtivas(cliente.id);
  const basesConta = basesMeliDaConta(basesMeli, conta.id, eligibleAccountCount);
  const baseLegadaAmbigua = eligibleAccountCount !== 1 && basesMeli.some((b) => b.cliente_conta_id == null);

  let base = null;
  let motivo = MOTIVOS.OK;

  if (!grant.conectado) {
    motivo = MOTIVOS.GRANT_ML_NAO_CONECTADO;
  } else if (basesConta.length === 0 && baseLegadaAmbigua) {
    throw erroContexto("ACCOUNT_CONTEXT_AMBIGUOUS", "Base legada sem Conta em Cliente com múltiplas operações MELI.");
  } else if (basesConta.length === 0) {
    motivo = MOTIVOS.BASE_MELI_NAO_VINCULADA;
  } else if (basesConta.length > 1) {
    motivo = MOTIVOS.MULTIPLAS_BASES_MELI;
  } else {
    base = basesConta[0];
    validarIdentidade({ cliente, conta, base, eligibleAccountCount });
  }

  const pronto = motivo === MOTIVOS.OK;

  return {
    cliente: { id: cliente.id, nome: cliente.nome, slug: cliente.slug },
    conta,
    grant,
    base,
    eligibleAccountCount,
    basesMeli,
    basesConta,
    pronto,
    motivo,
    mensagem: pronto ? null : MENSAGENS[motivo] || "Contexto de precificação indisponível.",
  };
}

// Base explícita: ler TODOS os vínculos, sem LIMIT/ordem que esconda
// conflito. O mesmo invariante valida pai, Conta, marketplace e atividade.
async function validarBaseInformada({ contexto, baseSlugRaw }) {
  const baseSlug = normalizarSlug(baseSlugRaw);
  if (!baseSlug) return null;
  const r = await pool.query(
    `SELECT b.id, b.slug, b.nome, b.ativo, b.created_at, b.updated_at,
            b.marketplace, v.cliente_id, v.cliente_conta_id,
            v.marketplace AS vinculo_marketplace, v.ativo AS vinculo_ativo
       FROM bases b
       LEFT JOIN base_cliente_vinculos v ON v.base_id = b.id AND v.ativo = true
      WHERE b.slug = $1`,
    [baseSlug]
  );
  if (!r.rows.length) throw erroContexto("BASE_NOT_FOUND", "Base informada não encontrada.", 404);
  if (r.rows.length > 1) throw erroContexto("ACCOUNT_CONTEXT_AMBIGUOUS", "Base com mais de um vínculo ativo.");
  const base = r.rows[0];
  validarIdentidade({ cliente: contexto.cliente, conta: contexto.conta, base,
    eligibleAccountCount: contexto.eligibleAccountCount });
  return base;
}

// Resolve o contexto e EXIGE que esteja pronto para análise. Usado pelos
// endpoints que precisam de uma base concreta (preview-ml, diagnóstico).
// - Se baseSlugRaw vier (compat), valida a identidade completa da operação.
// - Se não vier, resolve automaticamente a base vinculada.
// Lança erro controlado (statusCode + payload.codigo) quando não é possível.
async function exigirContextoPronto({ clienteSlugRaw, baseSlugRaw, clienteContaId = null }) {
  const contexto = await resolverContextoPrecificacao({ clienteSlugRaw, clienteContaId });

  // Grant é pré-requisito em qualquer caminho.
  if (!contexto.grant.conectado) {
    throw criarErroHttp(STATUS_POR_MOTIVO[MOTIVOS.GRANT_ML_NAO_CONECTADO], {
      ok: false,
      codigo: MOTIVOS.GRANT_ML_NAO_CONECTADO,
      code: CODE_POR_MOTIVO[MOTIVOS.GRANT_ML_NAO_CONECTADO],
      erro: MENSAGENS[MOTIVOS.GRANT_ML_NAO_CONECTADO],
    });
  }

  const baseSlugStr = String(baseSlugRaw || "").trim();
  if (baseSlugStr) {
    // Caminho de compatibilidade: baseSlug foi informado pelo frontend antigo.
    const base = await validarBaseInformada({ contexto, baseSlugRaw: baseSlugStr });
    if (!base) {
      throw criarErroHttp(STATUS_POR_MOTIVO[MOTIVOS.BASE_MELI_NAO_VINCULADA], {
        ok: false,
        codigo: MOTIVOS.BASE_MELI_NAO_VINCULADA,
        code: CODE_POR_MOTIVO[MOTIVOS.BASE_MELI_NAO_VINCULADA],
        erro: "Base informada não pertence ao cliente ou não está vinculada ao MELI. Ajuste o vínculo em Bases de Custo.",
      });
    }
    return {
      cliente: contexto.cliente,
      conta: contexto.conta,
      grant: contexto.grant,
      mlUserId: contexto.grant.ml_user_id,
      base,
    };
  }

  // Caminho automático: resolver a base vinculada.
  if (!contexto.pronto) {
    throw criarErroHttp(STATUS_POR_MOTIVO[contexto.motivo] || 424, {
      ok: false,
      codigo: contexto.motivo,
      code: CODE_POR_MOTIVO[contexto.motivo] || null,
      erro: contexto.mensagem,
    });
  }

  return {
    cliente: contexto.cliente,
    conta: contexto.conta,
    grant: contexto.grant,
    mlUserId: contexto.grant.ml_user_id,
    base: contexto.base,
  };
}

// Resolve e EXIGE apenas cliente + grant ML — usado por rotas somente-leitura
// que não dependem de base de custos (ex.: planilha de precificação sem base).
// Não valida nem exige base MELI vinculada; o chamador decide o que fazer com
// basesMeli (0, 1 ou várias).
async function exigirContextoGrantMl({ clienteSlugRaw, clienteContaId = null }) {
  const contexto = await resolverContextoPrecificacao({ clienteSlugRaw, clienteContaId });

  if (!contexto.grant.conectado) {
    throw criarErroHttp(STATUS_POR_MOTIVO[MOTIVOS.GRANT_ML_NAO_CONECTADO], {
      ok: false,
      codigo: MOTIVOS.GRANT_ML_NAO_CONECTADO,
      code: CODE_POR_MOTIVO[MOTIVOS.GRANT_ML_NAO_CONECTADO],
      erro: MENSAGENS[MOTIVOS.GRANT_ML_NAO_CONECTADO],
    });
  }

  return {
    cliente: contexto.cliente,
    conta: contexto.conta,
    grant: contexto.grant,
    mlUserId: contexto.grant.ml_user_id,
    basesMeli: contexto.basesMeli,
    basesConta: contexto.basesConta,
    base: contexto.base,
  };
}

module.exports = {
  MOTIVOS,
  MENSAGENS,
  CODE_POR_MOTIVO,
  normalizarSlug,
  criarErroHttp,
  buscarBasesMeliDoCliente,
  basesMeliDaConta,
  contarContasMeliAtivas,
  resolverContextoPrecificacao,
  exigirContextoPronto,
  exigirContextoGrantMl,
};
