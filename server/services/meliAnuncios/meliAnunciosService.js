const { currentGrantSql } = require("../mlGrantIdentity");
// server/services/meliAnuncios/meliAnunciosService.js
// -----------------------------------------------------------------------------
// Módulo: Anúncios Meli — Central operacional de anúncios por cliente.
// Camada de banco de dados (PostgreSQL).
//
// Responsável por:
//  - garantir o schema da tabela meli_anuncios (idempotente);
//  - resolver clientes e ml_user_id reaproveitando as tabelas existentes;
//  - listar / paginar / filtrar anúncios já sincronizados no banco;
//  - gerar o resumo (cards do HUD);
//  - fazer upsert dos anúncios vindos da sincronização.
//
// NÃO mexe em OAuth, refresh de token ou em qualquer tabela existente.
// Apenas LÊ clientes / ml_tokens e LÊ/ESCREVE em meli_anuncios.
// -----------------------------------------------------------------------------

// O config/database exporta o pool PG. Importado de forma defensiva caso o
// módulo exporte { pool } em vez do pool direto.
const _dbModule = require("../../config/database");
const db =
  _dbModule && typeof _dbModule.query === "function"
    ? _dbModule
    : _dbModule.pool || _dbModule.default || _dbModule;
const { resolveMarketplaceAccountContext } = require("../clienteContas/clienteContaService");
// Só para garantir o schema de meli_user_products antes do filtro
// "sem_agrupamento" consultá-la. A tabela é de meliFamiliaService — este
// serviço lê dela, nunca escreve.
const familiaService = require("./meliFamiliaService");

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------
let _schemaPronto = false;

async function ensureSchema() {
  if (_schemaPronto) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS meli_anuncios (
      id              SERIAL PRIMARY KEY,
      cliente_id      INTEGER NOT NULL,
      cliente_slug    TEXT NOT NULL,
      item_id         TEXT NOT NULL,
      sku             TEXT,
      titulo          TEXT,
      marca           TEXT,
      modelo          TEXT,
      preco           NUMERIC,
      preco_original  NUMERIC,
      moeda           TEXT,
      estoque         INTEGER,
      vendidos        INTEGER,
      status          TEXT,
      sub_status      TEXT,
      listing_type_id TEXT,
      category_id     TEXT,
      permalink       TEXT,
      thumbnail       TEXT,
      pictures_count  INTEGER DEFAULT 0,
      pictures_json   JSONB,
      logistic_type   TEXT,
      is_full         BOOLEAN DEFAULT false,
      attributes_json JSONB,
      health          NUMERIC,
      score_venforce  INTEGER,
      score_motivo    TEXT,
      revisado        BOOLEAN DEFAULT false,
      last_synced_at  TIMESTAMPTZ DEFAULT NOW(),
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (cliente_id, item_id)
    );
  `);

  // cliente_conta_id/ml_user_id: identificam de qual conta ML (Cliente/Conta)
  // veio cada anúncio. Nullable — linhas sincronizadas antes desta coluna
  // existir ficam NULL (nunca inferidas por adivinhação); uma ressincronização
  // subsequente já corrige a linha com o valor real.
  await db.query(`
    ALTER TABLE meli_anuncios
      ADD COLUMN IF NOT EXISTS cliente_conta_id INTEGER,
      ADD COLUMN IF NOT EXISTS ml_user_id TEXT;
  `);

  // Catálogo do Mercado Livre: item com family_name (ou catalog_listing=true)
  // tem o título gerenciado pelo ML — PUT de título é recusado (achado da
  // investigação do BODY_INVALID_FIELDS). Nullable — linhas antigas ficam
  // NULL até a próxima ressincronização, igual ao padrão acima.
  await db.query(`
    ALTER TABLE meli_anuncios
      ADD COLUMN IF NOT EXISTS catalog_listing BOOLEAN,
      ADD COLUMN IF NOT EXISTS catalog_product_id TEXT,
      ADD COLUMN IF NOT EXISTS family_name TEXT;
  `);

  // user_product_id: chave estável do ML (User Product), lida de /items e até
  // aqui descartada no mapeamento. Fase 1 da evolução da modelagem — só
  // persiste, não agrupa. Nullable, sem índice, sem FK, sem backfill: linhas
  // antigas ficam NULL até a próxima ressincronização, mesmo padrão acima.
  await db.query(`
    ALTER TABLE meli_anuncios
      ADD COLUMN IF NOT EXISTS user_product_id TEXT;
  `);

  // Sinal do modelo LEGADO de variações (item_id -> variations[] do ML),
  // paralelo a user_product_id/family_name (modelo novo) acima — os dois
  // convivem porque são dois modelos legítimos e mutuamente exclusivos por
  // item no Mercado Livre. Nullable, sem índice, sem backfill: linha antiga
  // fica NULL até a próxima ressincronização, mesmo padrão de sempre.
  await db.query(`
    ALTER TABLE meli_anuncios
      ADD COLUMN IF NOT EXISTS variations_count INTEGER;
  `);

  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_meli_anuncios_cliente ON meli_anuncios (cliente_id);`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_meli_anuncios_status ON meli_anuncios (cliente_id, status);`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_meli_anuncios_score ON meli_anuncios (cliente_id, score_venforce);`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_meli_anuncios_conta ON meli_anuncios (cliente_conta_id);`
  );

  // user_product_id deixou de ser só atributo: virou a chave de relacionamento
  // com meli_user_products (onde mora o family_id). Parcial porque anúncio
  // legado, sem User Product, nunca participa do join.
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_meli_anuncios_user_product
       ON meli_anuncios (cliente_id, user_product_id) WHERE user_product_id IS NOT NULL;`
  );

  _schemaPronto = true;
}

// -----------------------------------------------------------------------------
// Clientes / tokens (reaproveita tabelas existentes)
// -----------------------------------------------------------------------------

// Lista clientes ativos com flag de ML conectado e total já sincronizado.
async function listarClientes() {
  await ensureSchema();

  const { rows } = await db.query(`
    SELECT
      c.*,
      EXISTS (
        SELECT 1 FROM ml_tokens t WHERE t.cliente_id = c.id AND ${currentGrantSql("t")}
      ) AS ml_conectado,
      (
        SELECT COUNT(*)::int FROM meli_anuncios m WHERE m.cliente_id = c.id
      ) AS total_anuncios
    FROM clientes c
    WHERE c.ativo = true
    ORDER BY c.slug ASC;
  `);

  return rows.map((c) => ({
    id: c.id,
    slug: c.slug,
    nome: c.nome || c.name || c.razao_social || c.slug,
    mlConectado: !!c.ml_conectado,
    totalAnuncios: c.total_anuncios || 0,
  }));
}

// Resolve um cliente pelo slug. Retorna { id, slug, nome } ou null.
async function resolverCliente(clienteSlug) {
  if (!clienteSlug) return null;
  const slug = String(clienteSlug).trim().toLowerCase();

  const { rows } = await db.query(
    `SELECT * FROM clientes WHERE LOWER(slug) = $1 LIMIT 1;`,
    [slug]
  );
  if (!rows.length) return null;

  const c = rows[0];
  return {
    id: c.id,
    slug: c.slug,
    nome: c.nome || c.name || c.razao_social || c.slug,
  };
}

// Resolve a conta ML exata do cliente (Cliente/Conta/Grant). Nunca escolhe
// "a conta principal" em silêncio: com 2+ contas ML ativas sem clienteContaId
// explícito, propaga o erro estrutural (err.statusCode=409,
// err.code='MULTIPLE_MARKETPLACE_ACCOUNTS', err.contas) para o chamador.
//
// includeLegacy só é true quando a conta resolvida é comprovadamente a única
// ativa do marketplace — assim linhas históricas (cliente_conta_id IS NULL)
// continuam aparecendo quando não há ambiguidade real, e somem só quando há
// 2+ contas e uma foi escolhida.
async function resolverContextoConta({ clienteId, clienteContaId = null, requireUsableGrant = true }) {
  const context = await resolveMarketplaceAccountContext({
    clienteId,
    marketplace: "meli",
    clienteContaId: clienteContaId || null,
    requireUsableGrant,
    queryable: db,
  });

  const contaId = context.conta?.id ?? null;
  let includeLegacy = true;
  if (contaId) {
    const totalAtivas = await db.query(
      "SELECT COUNT(*)::int AS total FROM cliente_contas WHERE cliente_id = $1 AND marketplace = 'meli' AND ativo = true",
      [clienteId]
    );
    includeLegacy = (totalAtivas.rows[0]?.total || 0) <= 1;
  }

  return {
    mlUserId: context.mlUserId || null,
    contaId,
    contaNome: context.conta?.nome ?? null,
    includeLegacy,
  };
}

// Prova que um anúncio JÁ CARREGADO (obterAnuncio) pertence à operação
// selecionada e devolve a conta/usuário ML a usar. Não é uma segunda
// resolução de conta: toda validação de conta passa por resolverContextoConta
// acima; aqui só se compara o resultado com o que o próprio anúncio sabe de
// si (cliente_conta_id / ml_user_id, gravados na sincronização).
//
// Com clienteContaId explícito:
//   - a conta é validada (pertence ao cliente, é meli, está ativa);
//   - o anúncio tem que ser dela: cliente_conta_id igual, ou — linha sem
//     cliente_conta_id — ml_user_id igual ao external_account_id da conta;
//   - linha sem nenhum dos dois só passa quando o cliente tem uma única conta
//     ML ativa (mesma regra de includeLegacy da listagem); com 2+ não há como
//     provar de qual conta ela veio → 409 ANUNCIO_SEM_CONTA.
// Sem clienteContaId:
//   - o anúncio que sabe a própria conta é inequívoco: usa a dele;
//   - linha legada cai em resolverContextoConta sem conta, que com 2+ contas
//     ativas lança MULTIPLE_MARKETPLACE_ACCOUNTS (409). Nunca "a principal".
//
// Lança erro com statusCode/code (mesmo formato de resolveMarketplaceAccountContext).
// Retorna { contaId: number|null, mlUserId: string|null }.
function erroConta(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

async function resolverContaDoAnuncio({ clienteId, anuncio, clienteContaId = null, requireUsableGrant = false }) {
  const contaDoItem = anuncio && anuncio.cliente_conta_id != null ? Number(anuncio.cliente_conta_id) : null;
  const mlDoItem = anuncio && anuncio.ml_user_id ? String(anuncio.ml_user_id) : null;

  if (clienteContaId != null) {
    const pedida = Number(clienteContaId);
    const ctx = await resolverContextoConta({ clienteId, clienteContaId: pedida, requireUsableGrant });
    const mlDaConta = ctx.mlUserId ? String(ctx.mlUserId) : null;

    if (contaDoItem != null) {
      if (contaDoItem !== pedida) {
        throw erroConta(409, "ANUNCIO_DE_OUTRA_CONTA", "Este anúncio não pertence à conta selecionada.");
      }
    } else if (mlDoItem && mlDaConta) {
      if (mlDoItem !== mlDaConta) {
        throw erroConta(409, "ANUNCIO_DE_OUTRA_CONTA", "Este anúncio não pertence à conta selecionada.");
      }
    } else if (!ctx.includeLegacy) {
      throw erroConta(
        409,
        "ANUNCIO_SEM_CONTA",
        "Não foi possível confirmar a conta deste anúncio. Sincronize os anúncios desta conta e tente novamente."
      );
    }
    return { contaId: pedida, mlUserId: mlDoItem || mlDaConta };
  }

  if (contaDoItem != null) {
    if (mlDoItem) return { contaId: contaDoItem, mlUserId: mlDoItem };
    const ctx = await resolverContextoConta({ clienteId, clienteContaId: contaDoItem, requireUsableGrant });
    return { contaId: contaDoItem, mlUserId: ctx.mlUserId || null };
  }
  if (mlDoItem) return { contaId: null, mlUserId: mlDoItem };

  const ctx = await resolverContextoConta({ clienteId, clienteContaId: null, requireUsableGrant });
  return { contaId: ctx.contaId, mlUserId: ctx.mlUserId || null };
}

// -----------------------------------------------------------------------------
// Catálogo
// -----------------------------------------------------------------------------

// Conjunto de item_ids já gravados para um cliente (usado no modo "novos").
async function itemIdsExistentes(clienteId) {
  const { rows } = await db.query(
    `SELECT item_id FROM meli_anuncios WHERE cliente_id = $1;`,
    [clienteId]
  );
  return new Set(rows.map((r) => String(r.item_id)));
}

// Ids já gravados cujo status NÃO é "active" (pausado, em revisão, encerrado…).
// O sync "novos" os rebusca: um anúncio reativado direto no Mercado Livre
// continuaria "pausado" aqui para sempre, já que ele nunca é "novo".
async function itemIdsNaoAtivos(clienteId) {
  const { rows } = await db.query(
    `SELECT item_id FROM meli_anuncios
      WHERE cliente_id = $1 AND status IS DISTINCT FROM 'active';`,
    [clienteId]
  );
  return new Set(rows.map((r) => String(r.item_id)));
}

// Linhas já gravadas de um item para um vendedor do ML (user_id da
// notificação). Só devolve o que o portal já conhece — nada é inferido.
async function localizarItemPorVendedorMl(itemId, mlUserId) {
  await ensureSchema();
  const { rows } = await db.query(
    `SELECT cliente_id, cliente_slug, cliente_conta_id, ml_user_id, item_id
       FROM meli_anuncios
      WHERE item_id = $1 AND ml_user_id = $2;`,
    [String(itemId), String(mlUserId)]
  );
  return rows;
}

// Linhas já gravadas de vários itens de UM cliente (slug/conta/vendedor do ML
// para refazer a leitura com o token certo).
async function contextoDosItens(clienteId, itemIds) {
  await ensureSchema();
  const { rows } = await db.query(
    `SELECT cliente_id, cliente_slug, cliente_conta_id, ml_user_id, item_id
       FROM meli_anuncios
      WHERE cliente_id = $1 AND item_id = ANY($2::text[]);`,
    [clienteId, itemIds.map(String)]
  );
  return rows;
}

// Listagem paginada com filtros. Filtros possíveis em `filtro`:
//   sem_fotos | score_baixo | sem_sku | ficha_incompleta | pausados |
//   score_muito_bom | score_medio | mercado_full | sem_agrupamento
// (score_muito_bom/score_medio/mercado_full foram adicionados junto com os
// cards de KPI clicáveis da listagem — mesmos limiares 60/80 já usados em
// scoreClasse() no front; sem_agrupamento alimenta a aba da visão agrupada.)
async function listarAnuncios({
  clienteId,
  clienteContaId = null,
  includeLegacy = true,
  q = "",
  status = "",
  filtro = "",
  page = 1,
  limit = 24,
}) {
  await ensureSchema();

  const where = ["cliente_id = $1"];
  const params = [clienteId];
  let i = 2;

  if (clienteContaId != null) {
    where.push(includeLegacy
      ? `(cliente_conta_id = $${i} OR cliente_conta_id IS NULL)`
      : `cliente_conta_id = $${i}`);
    params.push(clienteContaId);
    i++;
  }

  const termo = String(q || "").trim();
  if (termo) {
    where.push(`(titulo ILIKE $${i} OR item_id ILIKE $${i} OR sku ILIKE $${i})`);
    params.push(`%${termo}%`);
    i++;
  }

  if (status) {
    where.push(`status = $${i}`);
    params.push(status);
    i++;
  }

  // O predicado de "sem_agrupamento" correlaciona com meli_user_products, que
  // pertence a meliFamiliaService. Num deploy novo (sync ainda não rodado) a
  // tabela pode não existir — garantir o schema aqui evita um 500 na aba.
  if (filtro === "sem_agrupamento") await familiaService.ensureSchema();

  switch (filtro) {
    case "sem_fotos":
      where.push(`COALESCE(pictures_count, 0) < 3`);
      break;
    case "score_baixo":
      where.push(`COALESCE(score_venforce, 0) < 60`);
      break;
    case "sem_sku":
      where.push(`(sku IS NULL OR sku = '')`);
      break;
    case "ficha_incompleta":
      where.push(`(score_motivo = 'Ficha técnica incompleta')`);
      break;
    case "pausados":
      where.push(`status = 'paused'`);
      break;
    case "score_muito_bom":
      where.push(`COALESCE(score_venforce, 0) >= 80`);
      break;
    case "score_medio":
      where.push(`COALESCE(score_venforce, 0) >= 60 AND COALESCE(score_venforce, 0) < 80`);
      break;
    case "mercado_full":
      where.push(`is_full = true`);
      break;
    // "Sem agrupamento" NÃO é "sem família": são os anúncios que a visão
    // Família -> User Product -> Item não alcança, por três caminhos —
    //   1. anúncio sem user_product_id (legado, nunca migrado ao modelo UP);
    //   2. UP existe mas o ML não devolveu family_id (não agrupado);
    //   3. UP referenciado sem linha em meli_user_products (órfão).
    // O caso 3 não acontece hoje em produção (auditoria dos clientes 32 e 35:
    // zero órfão), mas está no predicado de propósito: sem ele, um órfão
    // futuro sumiria das DUAS abas em vez de aparecer em uma.
    case "sem_agrupamento":
      where.push(`(user_product_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM meli_user_products up
         WHERE up.cliente_id = meli_anuncios.cliente_id
           AND up.user_product_id = meli_anuncios.user_product_id
           AND up.family_id IS NOT NULL
      ))`);
      break;
    default:
      break;
  }

  const whereSql = where.join(" AND ");

  const totalRes = await db.query(
    `SELECT COUNT(*)::int AS total FROM meli_anuncios WHERE ${whereSql};`,
    params
  );
  const total = totalRes.rows[0] ? totalRes.rows[0].total : 0;

  const lim = Math.min(Math.max(parseInt(limit, 10) || 24, 1), 100);
  const pag = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (pag - 1) * lim;

  const dataParams = params.slice();
  dataParams.push(lim, offset);

  const { rows } = await db.query(
    `SELECT
        item_id, sku, titulo, marca, modelo, preco, preco_original, moeda,
        estoque, vendidos, status, sub_status, listing_type_id, category_id,
        permalink, thumbnail, pictures_count, logistic_type, is_full,
        health, score_venforce, score_motivo, revisado, last_synced_at,
        catalog_listing, family_name
       FROM meli_anuncios
       WHERE ${whereSql}
       ORDER BY revisado ASC, score_venforce ASC NULLS FIRST, updated_at DESC
       LIMIT $${i} OFFSET $${i + 1};`,
    dataParams
  );

  return {
    anuncios: rows,
    paginacao: {
      page: pag,
      limit: lim,
      total,
      totalPaginas: Math.max(Math.ceil(total / lim), 1),
    },
  };
}

// Resumo agregado para os cards do HUD.
async function obterResumo(clienteId, clienteContaId = null, includeLegacy = true) {
  await ensureSchema();

  const where = ["cliente_id = $1"];
  const params = [clienteId];
  if (clienteContaId != null) {
    where.push(includeLegacy
      ? `(cliente_conta_id = $2 OR cliente_conta_id IS NULL)`
      : `cliente_conta_id = $2`);
    params.push(clienteContaId);
  }
  const whereSql = where.join(" AND ");

  const { rows } = await db.query(
    `SELECT
        COUNT(*)::int                                                  AS total,
        COUNT(*) FILTER (WHERE status = 'active')::int                 AS ativos,
        COUNT(*) FILTER (WHERE status = 'paused')::int                 AS pausados,
        COUNT(*) FILTER (WHERE status = 'closed')::int                 AS encerrados,
        COUNT(*) FILTER (WHERE COALESCE(pictures_count,0) < 3)::int     AS fotos_insuficientes,
        COUNT(*) FILTER (WHERE sku IS NULL OR sku = '')::int            AS sem_sku,
        COUNT(*) FILTER (WHERE COALESCE(score_venforce,0) < 60)::int    AS score_baixo,
        COUNT(*) FILTER (WHERE COALESCE(score_venforce,0) >= 80)::int   AS score_muito_bom,
        COUNT(*) FILTER (WHERE COALESCE(score_venforce,0) >= 60
                           AND COALESCE(score_venforce,0) < 80)::int    AS score_faixa_media,
        COUNT(*) FILTER (WHERE is_full = true)::int                     AS full,
        ROUND(AVG(score_venforce))::int                                AS score_medio,
        MAX(last_synced_at)                                            AS ultima_sync
       FROM meli_anuncios
       WHERE ${whereSql};`,
    params
  );

  const r = rows[0] || {};
  return {
    total: r.total || 0,
    ativos: r.ativos || 0,
    pausados: r.pausados || 0,
    encerrados: r.encerrados || 0,
    fotosInsuficientes: r.fotos_insuficientes || 0,
    semSku: r.sem_sku || 0,
    scoreBaixo: r.score_baixo || 0,
    scoreMuitoBom: r.score_muito_bom || 0,
    full: r.full || 0,
    // Quantos anúncios estão na faixa 60–79 — o número do card "Score médio",
    // com o mesmo limiar do filtro `score_medio`. Não confundir com
    // `scoreMedio`, que é a MÉDIA dos scores (o card mostrava a média, e o
    // filtro recortava a faixa: 91 no card, lista vazia ao clicar).
    scoreFaixaMedia: r.score_faixa_media || 0,
    scoreMedio: r.score_medio || 0,
    ultimaSync: r.ultima_sync || null,
  };
}

// Detalhe de um anúncio específico já gravado.
async function obterAnuncio(clienteId, itemId) {
  await ensureSchema();
  const { rows } = await db.query(
    `SELECT * FROM meli_anuncios WHERE cliente_id = $1 AND item_id = $2 LIMIT 1;`,
    [clienteId, String(itemId)]
  );
  return rows.length ? rows[0] : null;
}

// Atualiza o SNAPSHOT local de campos que o Mercado Livre já confirmou.
// Chamado só depois da escrita no ML (meliConteudoService) — nunca antes, para
// não existir um "salvo" local que o anúncio real desconhece. `attributes_json`
// acompanha o modelo porque a ficha técnica lê MODEL de lá.
async function atualizarCamposConfirmados(clienteId, itemId, campos = {}) {
  await ensureSchema();

  const sets = [];
  const params = [clienteId, String(itemId)];

  if (campos.titulo !== undefined) {
    params.push(campos.titulo);
    sets.push(`titulo = $${params.length}`);
  }
  if (campos.preco !== undefined) {
    params.push(campos.preco);
    sets.push(`preco = $${params.length}`);
  }
  if (campos.modelo !== undefined) {
    params.push(campos.modelo);
    sets.push(`modelo = $${params.length}`);
    // jsonb_set não cria o elemento se MODEL ainda não existir no array, então
    // o valor é recalculado em JS a partir da linha atual (ver controller).
    if (campos.attributesJson !== undefined) {
      params.push(JSON.stringify(campos.attributesJson || []));
      sets.push(`attributes_json = $${params.length}::jsonb`);
    }
  }

  if (!sets.length) return null;

  const { rows } = await db.query(
    `UPDATE meli_anuncios
        SET ${sets.join(", ")}, updated_at = NOW()
      WHERE cliente_id = $1 AND item_id = $2
      RETURNING *;`,
    params
  );
  return rows.length ? rows[0] : null;
}

// Snapshot local das FOTOS depois que o Mercado Livre confirmou a lista
// (releitura de GET /items/{id} em meliImagensService). Mesmo formato do sync:
// pictures_json = URLs, pictures_count = tamanho, thumbnail = capa do ML.
// score_venforce/score_motivo (que contam fotos) NÃO são recalculados aqui —
// dependem do item inteiro e continuam sendo trabalho do sync.
async function atualizarFotosConfirmadas(clienteId, itemId, fotos) {
  await ensureSchema();
  if (!fotos || !Array.isArray(fotos.pictures_json)) return null;
  const { rows } = await db.query(
    `UPDATE meli_anuncios
        SET pictures_json = $3::jsonb, pictures_count = $4,
            thumbnail = COALESCE($5, thumbnail), updated_at = NOW()
      WHERE cliente_id = $1 AND item_id = $2
      RETURNING *;`,
    [
      clienteId,
      String(itemId),
      JSON.stringify(fotos.pictures_json),
      fotos.pictures_json.length,
      fotos.thumbnail || null,
    ]
  );
  return rows.length ? rows[0] : null;
}

// Snapshot local do estoque JÁ CONFIRMADO pelo Mercado Livre.
//
// Duas escritas, porque são duas afirmações diferentes:
//
//  1. o item editado recebe o estoque confirmado e, quando o ML devolveu,
//     também o status/sub_status que ELE reportou (available_quantity = 0
//     pausa o anúncio, e um valor acima de 0 reativa o que estava
//     out_of_stock — ver meliEstoqueService);
//  2. os IRMÃOS do mesmo user_product_id recebem SÓ o estoque. É a regra
//     documentada do ML ("available_quantity" está na lista de campos
//     replicados por User Product), e a réplica lá é assíncrona: gravar aqui
//     o valor final evita que a tela mostre números diferentes para o mesmo
//     produto físico enquanto o ML converge. `status` NÃO entra na propagação
//     — ele não está na lista de campos sincronizados por UP, então supor a
//     transição do irmão seria inventar.
//
// Sem user_product_id (anúncio individual, relação UP:item 1:1 antes da tag
// user_product_seller) a segunda escrita simplesmente não acontece.
async function aplicarEstoqueConfirmado(
  clienteId,
  itemId,
  { estoque, status = null, subStatus = null, definirSubStatus = false, userProductId = null } = {}
) {
  await ensureSchema();

  const params = [clienteId, String(itemId), estoque];
  const sets = ["estoque = $3"];
  if (status) {
    params.push(status);
    sets.push(`status = $${params.length}`);
  }
  if (definirSubStatus) {
    params.push(subStatus);
    sets.push(`sub_status = $${params.length}`);
  }

  const { rows } = await db.query(
    `-- ESTOQUE_CONFIRMADO_ITEM
     UPDATE meli_anuncios
        SET ${sets.join(", ")}, updated_at = NOW()
      WHERE cliente_id = $1 AND item_id = $2
      RETURNING *;`,
    params
  );
  const anuncio = rows.length ? rows[0] : null;

  let sincronizados = [];
  if (userProductId) {
    const { rows: irmaos } = await db.query(
      `-- ESTOQUE_CONFIRMADO_IRMAOS_DO_UP
       UPDATE meli_anuncios
          SET estoque = $4, updated_at = NOW()
        WHERE cliente_id = $1
          AND user_product_id = $2
          AND item_id <> $3
        RETURNING item_id;`,
      [clienteId, String(userProductId), String(itemId), estoque]
    );
    sincronizados = irmaos.map((r) => String(r.item_id));
  }

  return { anuncio, sincronizados };
}

// Candidatos ao backfill: anúncios já gravados que ainda não têm
// user_product_id (não passaram pelo sync novo). Não chama o ML — só lê o
// que já está no banco.
async function itemIdsSemUserProduct(clienteId) {
  await ensureSchema();
  const { rows } = await db.query(
    `SELECT item_id FROM meli_anuncios WHERE cliente_id = $1 AND user_product_id IS NULL;`,
    [clienteId]
  );
  return rows.map((r) => String(r.item_id));
}

// UPDATE estreito do backfill: só a coluna user_product_id, e só quando ela
// ainda está NULL. Nunca sobrescreve um valor já existente (proteção contra
// corrida com um sync normal que já tenha resolvido o item nesse intervalo).
// Retorna true/false conforme a escrita aconteceu ou não.
async function preencherUserProductId(clienteId, itemId, userProductId) {
  await ensureSchema();
  const { rows } = await db.query(
    `UPDATE meli_anuncios
        SET user_product_id = $3, updated_at = NOW()
      WHERE cliente_id = $1 AND item_id = $2
        AND user_product_id IS NULL
      RETURNING item_id;`,
    [clienteId, String(itemId), userProductId]
  );
  return rows.length > 0;
}

// Marca/desmarca um anúncio como revisado.
async function marcarRevisado(clienteId, itemId, revisado) {
  await ensureSchema();
  await db.query(
    `UPDATE meli_anuncios
        SET revisado = $3, updated_at = NOW()
      WHERE cliente_id = $1 AND item_id = $2;`,
    [clienteId, String(itemId), !!revisado]
  );
}

// -----------------------------------------------------------------------------
// Upsert (chamado pela sincronização)
// -----------------------------------------------------------------------------
async function upsertAnuncios(registros) {
  if (!Array.isArray(registros) || registros.length === 0) return 0;
  await ensureSchema();

  const sql = `
    INSERT INTO meli_anuncios (
      cliente_id, cliente_slug, item_id, sku, titulo, marca, modelo,
      preco, preco_original, moeda, estoque, vendidos, status, sub_status,
      listing_type_id, category_id, permalink, thumbnail, pictures_count,
      pictures_json, logistic_type, is_full, attributes_json, health,
      score_venforce, score_motivo, cliente_conta_id, ml_user_id,
      catalog_listing, catalog_product_id, family_name, user_product_id,
      variations_count,
      last_synced_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13, $14,
      $15, $16, $17, $18, $19,
      $20, $21, $22, $23, $24,
      $25, $26, $27, $28,
      $29, $30, $31, $32,
      $33,
      NOW(), NOW()
    )
    ON CONFLICT (cliente_id, item_id) DO UPDATE SET
      sku             = EXCLUDED.sku,
      titulo          = EXCLUDED.titulo,
      marca           = EXCLUDED.marca,
      modelo          = EXCLUDED.modelo,
      preco           = EXCLUDED.preco,
      preco_original  = EXCLUDED.preco_original,
      moeda           = EXCLUDED.moeda,
      estoque         = EXCLUDED.estoque,
      vendidos        = EXCLUDED.vendidos,
      status          = EXCLUDED.status,
      sub_status      = EXCLUDED.sub_status,
      listing_type_id = EXCLUDED.listing_type_id,
      category_id     = EXCLUDED.category_id,
      permalink       = EXCLUDED.permalink,
      thumbnail       = EXCLUDED.thumbnail,
      pictures_count  = EXCLUDED.pictures_count,
      pictures_json   = EXCLUDED.pictures_json,
      logistic_type   = EXCLUDED.logistic_type,
      is_full         = EXCLUDED.is_full,
      attributes_json = EXCLUDED.attributes_json,
      health          = EXCLUDED.health,
      score_venforce  = EXCLUDED.score_venforce,
      score_motivo    = EXCLUDED.score_motivo,
      cliente_conta_id = EXCLUDED.cliente_conta_id,
      ml_user_id      = EXCLUDED.ml_user_id,
      catalog_listing = EXCLUDED.catalog_listing,
      catalog_product_id = EXCLUDED.catalog_product_id,
      family_name     = EXCLUDED.family_name,
      user_product_id = EXCLUDED.user_product_id,
      variations_count = EXCLUDED.variations_count,
      last_synced_at  = NOW(),
      updated_at      = NOW();
  `;

  let salvos = 0;
  for (const r of registros) {
    await db.query(sql, [
      r.cliente_id,
      r.cliente_slug,
      r.item_id,
      r.sku,
      r.titulo,
      r.marca,
      r.modelo,
      r.preco,
      r.preco_original,
      r.moeda,
      r.estoque,
      r.vendidos,
      r.status,
      r.sub_status,
      r.listing_type_id,
      r.category_id,
      r.permalink,
      r.thumbnail,
      r.pictures_count,
      JSON.stringify(r.pictures_json || []),
      r.logistic_type,
      r.is_full,
      JSON.stringify(r.attributes_json || []),
      r.health,
      r.score_venforce,
      r.score_motivo,
      r.cliente_conta_id ?? null,
      r.ml_user_id != null ? String(r.ml_user_id) : null,
      r.catalog_listing ?? null,
      r.catalog_product_id ?? null,
      r.family_name ?? null,
      r.user_product_id ?? null,
      r.variations_count ?? null,
    ]);
    salvos++;
  }
  return salvos;
}

module.exports = {
  ensureSchema,
  listarClientes,
  resolverCliente,
  resolverContextoConta,
  resolverContaDoAnuncio,
  itemIdsExistentes,
  itemIdsNaoAtivos,
  localizarItemPorVendedorMl,
  contextoDosItens,
  listarAnuncios,
  obterResumo,
  obterAnuncio,
  atualizarCamposConfirmados,
  atualizarFotosConfirmadas,
  aplicarEstoqueConfirmado,
  marcarRevisado,
  upsertAnuncios,
  itemIdsSemUserProduct,
  preencherUserProductId,
};
