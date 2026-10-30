const fs = require("fs");
const path = require("path");
const pool = require("../../config/database");
const { classificarComponenteFinanceiro } = require("./centralVendasComponenteLedger");
const { comRetryTransitorio } = require("./centralVendasTransientRetry");
const { comPrazo } = require("../../utils/comPrazo");
const { prazos } = require("./centralVendasPrazos");

const schemaPath = path.join(__dirname, "..", "..", "sql", "central_vendas_schema.sql");

function asJson(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

// Usada tanto para escrever (input ISO string, ex.: pedido.dataPedido) quanto
// para ler colunas DATE de volta do pg (que chegam como objeto Date, não
// string — sem o branch abaixo, String(date).slice(0,10) corta um texto tipo
// "Mon Aug 10" em vez de "2026-08-10", quebrando qualquer comparação de
// cobertura em coberturaContemSegmento).
function asDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function normalizeSlug(slug) {
  return String(slug || "").trim().toLowerCase();
}

// O schema da Central contém ALTER/UPDATE/DROP INDEX/CREATE INDEX sobre as
// tabelas globais (imports, sync_runs, ...): ALTER TABLE ... IF NOT EXISTS
// pede ACCESS EXCLUSIVE mesmo quando nada muda. Várias execuções simultâneas
// (uma por conta no sync noturno) travavam em ordem oposta à do reuso de run
// (sync_runs → imports) e o PostgreSQL derrubava uma delas com 40P01.
//
// Duas proteções:
//   1. single-flight por processo (e por `db`): chamadas simultâneas esperam a
//      MESMA promise; depois do sucesso o schema não roda de novo; se falhar,
//      o estado é limpo e uma chamada futura tenta outra vez.
//   2. advisory lock transacional na MESMA conexão dedicada durante todo o
//      schema — serializa também contra outro processo/instância/restart.
//      (pool.query(lock) + pool.query(schema) usariam conexões diferentes e o
//      lock já teria terminado quando o schema rodasse.)
const SCHEMA_ADVISORY_LOCK_KEY = "venforce:central-vendas:schema";

// Estado por `db` (na prática, o pool único do processo). WeakMap para que um
// db injetado em teste tenha o seu próprio ciclo, sem vazar entre casos.
const ensurePorDb = new WeakMap();

// Pool = tem connect() e não é um client já emprestado (que tem release()).
// Um queryable sem connect() (client emprestado, fake simples) executa o
// schema direto — sem BEGIN próprio, para não interferir numa transação alheia.
function isPoolLike(db) {
  return typeof db?.connect === "function" && typeof db?.release !== "function";
}

async function executarSchemaComLock(db) {
  const sql = fs.readFileSync(schemaPath, "utf8");
  if (!isPoolLike(db)) {
    await db.query(sql);
    return;
  }
  const client = await db.connect();
  let descartar;
  try {
    await client.query("BEGIN");
    // hashtextextended → bigint estável; a forma de chave única (bigint) não
    // colide com as chaves (int,int) usadas por outros domínios.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [SCHEMA_ADVISORY_LOCK_KEY]);
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      descartar = rollbackErr; // conexão em estado desconhecido: não volta ao pool
    }
    throw err;
  } finally {
    client.release(descartar);
  }
}

async function ensureCentralVendasTables(db = pool) {
  let estado = ensurePorDb.get(db);
  if (!estado) {
    estado = { concluido: false, promise: null };
    ensurePorDb.set(db, estado);
  }
  if (estado.concluido) return;
  if (!estado.promise) {
    estado.promise = executarSchemaComLock(db).then(
      () => {
        estado.concluido = true;
        estado.promise = null;
      },
      (err) => {
        estado.promise = null;
        throw err;
      }
    );
  }
  await estado.promise;
}

async function getClienteBySlug(clienteSlug, db = pool) {
  const slug = normalizeSlug(clienteSlug);
  const result = await db.query(
    `SELECT id, nome, slug
       FROM clientes
      WHERE slug = $1
        AND ativo = true
      LIMIT 1`,
    [slug]
  );
  return result.rows[0] || null;
}

// retryTransient: opt-in EXPLÍCITO. Com true, 40P01/40001 (vítima de deadlock /
// falha de serialização) reexecutam a transação INTEIRA — ROLLBACK, client
// devolvido, client novo, BEGIN de novo — até 3 tentativas totais. Só habilitar
// com callback 100% banco e idempotente (nada de HTTP/efeito externo dentro):
// ele roda de novo do zero. Uma transação abortada nunca é reaproveitada.
// `pool: pg`, `sleep`, `random` existem para injeção em teste.
// queryTimeoutMs (OPT-IN): prazo POR QUERY dentro da transação. Sem ele o comportamento é o de sempre (o
// callback recebe o próprio client). Com ele, uma query/COMMIT sem resposta nesse prazo (conexão presa ou
// perdida — incidente P0 2026-10-02: a gravação do import grande esperava para sempre) rejeita com
// PG_QUERY_TIMEOUT e a conexão é DESCARTADA (release(err)): o servidor desfaz a transação ao perder a sessão.
// Nenhum ROLLBACK é enviado a uma conexão presa (ele também penduraria). O prazo é por query, não total:
// uma gravação grande e saudável não é cortada por demorar.
async function withTransaction(callback, {
  retryTransient = false, pool: pg = pool, sleep, random, baseMs, queryTimeoutMs = null,
} = {}) {
  const umaTentativa = async () => {
    const client = await pg.connect();
    let descartar;
    let liberado = false;
    let perdida = null;
    const liberar = (err) => {
      if (liberado) return;
      liberado = true;
      client.release(err);
    };
    let db = client;
    if (Number(queryTimeoutMs) > 0) {
      db = {
        query: (...args) => {
          if (perdida) return Promise.reject(perdida);
          return comPrazo(client.query(...args), queryTimeoutMs, {
            code: "PG_QUERY_TIMEOUT",
            message: `Query do PostgreSQL sem resposta em ${Math.round(queryTimeoutMs)} ms; conexão descartada.`,
            onTimeout: (err) => { perdida = err; liberar(err); },
          });
        },
      };
    }
    try {
      await db.query("BEGIN");
      if (Number(queryTimeoutMs) > 0) {
        // Cancelamento NO SERVIDOR (não só abandono no cliente): a query que passar do prazo é cancelada pelo
        // PostgreSQL (statement_timeout, que também cobre espera de lock) e uma transação aberta cujo cliente
        // sumiu é encerrada (idle_in_transaction_session_timeout). Margem de 5 s para o prazo do cliente vencer
        // primeiro no caso comum e devolver o erro PG_QUERY_TIMEOUT. SET LOCAL: vale só nesta transação.
        const ms = Math.ceil(Number(queryTimeoutMs)) + 5000;
        await db.query(`SET LOCAL statement_timeout = ${ms}`);
        await db.query(`SET LOCAL idle_in_transaction_session_timeout = ${ms * 2}`);
      }
      const result = await callback(db);
      await db.query("COMMIT");
      return result;
    } catch (err) {
      if (!perdida) {
        try {
          await db.query("ROLLBACK");
        } catch (rollbackErr) {
          descartar = rollbackErr; // não devolve ao pool uma conexão quebrada
        }
      }
      throw err;
    } finally {
      liberar(descartar);
    }
  };
  if (!retryTransient) return umaTentativa();
  return comRetryTransitorio(umaTentativa, {
    sleep,
    random,
    baseMs,
    onRetry: ({ tentativa, maxTentativas, err }) => {
      console.warn(`[central-vendas] persistência retry ${tentativa}/${maxTentativas} erro=${err.code}`);
    },
  });
}

async function createImport({
  cliente, marketplace, competencia, resumo, payload, fonte, status,
  clienteContaId = null, baseId = null, baseResolutionMode = null, grantId = null, externalAccountId = null,
  syncRunId = null,
  // M4 — candidate/published (seção 2/5). publicationStatus default 'legacy':
  // só quem produz o import via sync_run decide 'candidate' explicitamente
  // (centralVendasSyncService) — nunca escolhido por adivinhação aqui.
  publicationStatus = "legacy",
  coverageDateFrom = null,
  coverageDateTo = null,
}, db) {
  const result = await db.query(
    `INSERT INTO central_vendas_imports
      (cliente_id, cliente_slug, marketplace, competencia, fonte, status, confianca, resumo_json, payload_json,
       cliente_conta_id, base_id, base_resolution_mode, grant_id, external_account_id, sync_run_id,
       publication_status, coverage_date_from, coverage_date_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id, cliente_id, cliente_slug, marketplace, competencia, fonte, status, confianca,
               resumo_json, payload_json, created_at, updated_at,
               cliente_conta_id, base_id, base_resolution_mode, grant_id, external_account_id, sync_run_id,
               publication_status, coverage_date_from, coverage_date_to, published_at`,
    [
      cliente.id,
      cliente.slug,
      marketplace,
      competencia,
      fonte || "planilha_vendas",
      status || "processado",
      resumo?.confianca || null,
      asJson(resumo, {}),
      asJson(payload, {}),
      clienteContaId,
      baseId,
      baseResolutionMode,
      grantId,
      externalAccountId,
      syncRunId,
      publicationStatus,
      asDate(coverageDateFrom),
      asDate(coverageDateTo),
    ]
  );
  return result.rows[0];
}

async function insertPedido({ importacao, cliente, marketplace, competencia, pedido }, db) {
  const result = await db.query(
    `INSERT INTO central_vendas_pedidos
      (import_id, cliente_id, cliente_slug, marketplace, competencia, pedido_id, pack_id, shipment_id,
       data_pedido, status, confianca, quantidade_itens, faturamento, lucro_contribuicao, resultado,
       margem_contribuicao_percentual, pendencias_json, payload_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb)
     RETURNING id, pedido_id`,
    [
      importacao.id,
      cliente.id,
      cliente.slug,
      marketplace,
      competencia,
      pedido.pedidoId,
      pedido.packId || null,
      pedido.shipmentId || null,
      asDate(pedido.dataPedido),
      pedido.status || null,
      pedido.confianca,
      pedido.quantidadeItens ?? null,
      pedido.faturamento ?? null,
      pedido.lucroContribuicao ?? null,
      pedido.resultado ?? null,
      pedido.margemContribuicaoPercentual ?? null,
      asJson(pedido.pendencias, []),
      asJson(pedido, {}),
    ]
  );
  return result.rows[0];
}

async function insertItem({ importacao, pedidoRowId, cliente, marketplace, competencia, item }, db) {
  const result = await db.query(
    `INSERT INTO central_vendas_pedido_itens
      (import_id, pedido_row_id, cliente_id, cliente_slug, marketplace, competencia, pedido_id,
       item_id, mlb, sku, titulo, quantidade, valor_unitario, receita_produto, custo_produto,
       imposto_interno, lucro_contribuicao, resultado, margem_contribuicao_percentual,
       confianca, pendencias_json, payload_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,$22::jsonb)
     RETURNING id, item_id`,
    [
      importacao.id,
      pedidoRowId,
      cliente.id,
      cliente.slug,
      marketplace,
      competencia,
      item.pedidoId,
      item.itemId,
      item.mlb || null,
      item.sku || null,
      item.titulo || null,
      item.quantidade ?? null,
      item.valorUnitario ?? null,
      item.receitaProduto ?? null,
      item.custoProduto ?? null,
      item.impostoInterno ?? null,
      item.lucroContribuicao ?? null,
      item.resultado ?? null,
      item.margemContribuicaoPercentual ?? null,
      item.confianca,
      asJson(item.pendencias, []),
      asJson(item, {}),
    ]
  );
  return result.rows[0];
}

async function insertComponente({
  importacao,
  pedidoRowId,
  itemRowId,
  cliente,
  marketplace,
  competencia,
  componente,
}, db) {
  // M6 — classificação explícita (escopo/efeito/incluido_no_resultado),
  // nunca inferida só pelo sinal de `valor`. Ver
  // centralVendasComponenteLedger.js: mesma regra nas duas origens
  // (API-first e planilha), com um gap documentado (não corrigido aqui)
  // quando o motor de planilha sinaliza `ajuste_plataforma_presente`.
  const { escopo, efeito, incluidoNoResultado } = classificarComponenteFinanceiro({
    tipo: componente.tipo,
    itemId: componente.itemId || null,
  });

  const result = await db.query(
    `INSERT INTO central_vendas_componentes
      (import_id, pedido_row_id, item_row_id, cliente_id, cliente_slug, marketplace, competencia,
       pedido_id, item_id, tipo, valor, fonte, confianca, obs, payload_json,
       escopo, efeito, incluido_no_resultado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18)
     RETURNING id`,
    [
      importacao.id,
      pedidoRowId,
      itemRowId || null,
      cliente.id,
      cliente.slug,
      marketplace,
      competencia,
      componente.pedidoId,
      componente.itemId || null,
      componente.tipo,
      componente.valor ?? null,
      componente.fonte || null,
      componente.confianca,
      componente.obs || null,
      asJson(componente, {}),
      escopo,
      efeito,
      incluidoNoResultado,
    ]
  );
  return result.rows[0];
}

async function persistCentralVendasImport({
  cliente, marketplace, competencia, motorPayload, resumo, fonte,
  clienteContaId = null, baseId = null, baseResolutionMode = null, grantId = null, externalAccountId = null,
  syncRunId = null,
  publicationStatus = "legacy",
  coverageDateFrom = null,
  coverageDateTo = null,
}) {
  return withTransaction(async (db) => {
    const importacao = await createImport({
      cliente,
      marketplace,
      competencia,
      resumo,
      payload: motorPayload,
      fonte,
      clienteContaId,
      baseId,
      baseResolutionMode,
      grantId,
      externalAccountId,
      syncRunId,
      publicationStatus,
      coverageDateFrom,
      coverageDateTo,
    }, db);

    const pedidoRowsById = new Map();
    for (const pedido of motorPayload.pedidos || []) {
      const pedidoRow = await insertPedido({ importacao, cliente, marketplace, competencia, pedido }, db);
      pedidoRowsById.set(pedido.pedidoId, pedidoRow.id);
    }

    const itemRowsById = new Map();
    for (const item of motorPayload.itens || []) {
      const pedidoRowId = pedidoRowsById.get(item.pedidoId) || null;
      const itemRow = await insertItem({
        importacao,
        pedidoRowId,
        cliente,
        marketplace,
        competencia,
        item,
      }, db);
      itemRowsById.set(item.itemId, itemRow.id);
    }

    for (const componente of motorPayload.componentes || []) {
      await insertComponente({
        importacao,
        pedidoRowId: pedidoRowsById.get(componente.pedidoId) || null,
        itemRowId: componente.itemId ? itemRowsById.get(componente.itemId) : null,
        cliente,
        marketplace,
        competencia,
        componente,
      }, db);
    }

    return {
      importacao,
      pedidosPersistidos: pedidoRowsById.size,
      itensPersistidos: itemRowsById.size,
      componentesPersistidos: (motorPayload.componentes || []).length,
    };
    // Só INSERTs a partir de motorPayload já em memória (a coleta HTTP acontece
    // ANTES): reexecutar do zero depois de 40P01/40001 é seguro e idempotente,
    // porque a tentativa abortada foi revertida por inteiro.
  }, { retryTransient: true, queryTimeoutMs: prazos().dbQueryMs });
}

// clienteContaId + includeLegacy implementam a política de escopo de conta
// (P0 do hardening M1/M2): quando uma conta foi resolvida, a leitura NUNCA
// pode devolver o snapshot de outra conta. includeLegacy só é true quando o
// chamador (centralVendasService) provou que cliente+marketplace têm no
// máximo 1 conta ativa — aí um snapshot legado (cliente_conta_id NULL,
// anterior à fundação de contas) pode ser lido com segurança, porque só
// pode pertencer a essa conta. Com 2+ contas ativas, includeLegacy é
// sempre false: misturar cliente_conta_id=X com NULL seria arriscar dado
// de outra conta (ver seção 2 da spec de hardening).
//
// V3 Pós-Convergência #2 — BLOCO 12 (fail-safe de conta não resolvida):
// quando `clienteContaId` chega NULL — 0 contas ativas, marketplace sem
// resolução de conta (ex.: shopee), ou qualquer caminho em que
// resolveMarketplaceAccountContext devolveu `conta: null` — esta função
// ANTES retornava `null`, ou seja, NENHUM filtro de conta: a query voltava a
// UNIÃO SILENCIOSA de todas as contas do cliente (cliente_conta_id = 5, = 6,
// NULL, …). Um cliente que teve contas, perdeu todas (desativadas) e ainda
// tem imports marcados por conta via essa porta enxergaria dados de contas
// que não são mais dele. Agora o piso é `cliente_conta_id IS NULL`: só o
// legado sem operação registrada — nunca dados atribuídos a uma conta
// específica. Para um cliente puramente legado (tudo NULL) o resultado é
// idêntico; para um cliente com mistura, os imports de conta ficam
// invisíveis até uma conta ser realmente selecionada (resultado
// explicitamente parcial em vez de vazamento). Decisão de UX restante
// (mostrar aviso "selecione uma conta" vs. tela vazia) é da Pessoa 1.
function condicaoContaSql(paramsList, clienteContaId, includeLegacy) {
  if (clienteContaId == null) return "cliente_conta_id IS NULL";
  paramsList.push(clienteContaId);
  const idx = paramsList.length;
  return includeLegacy
    ? `(cliente_conta_id = $${idx} OR cliente_conta_id IS NULL)`
    : `cliente_conta_id = $${idx}`;
}

// M4 — Candidate/Published (seções 5-7): nunca escolhe um import 'candidate'
// aqui — só 'published' (com cobertura comprovada) ou 'legacy' (fallback sem
// garantia de cobertura, mesma regra de sempre). `segmentStart`/`segmentEnd`
// é o trecho REAL que o chamador precisa cobrir: a competência inteira na
// leitura mensal legada, ou a interseção do intervalo pedido com o mês em
// getCentralVendasByRange. Um published só serve se sua cobertura CONTÉM
// esse trecho inteiro — nunca um snapshot 10→15 respondendo uma pergunta
// 01→31 (seção 5). Entre published válidos, o mais recentemente publicado
// vence (published_at DESC, id DESC — seção 6); sem published qualificado,
// cai no legacy mais recente (created_at DESC, id DESC — comportamento
// pré-M4 preservado para dado antigo).
function coberturaContemSegmento(row, segmentStart, segmentEnd) {
  const coverageFrom = asDate(row.coverage_date_from);
  const coverageTo = asDate(row.coverage_date_to);
  if (!coverageFrom || !coverageTo) return false;
  return coverageFrom <= segmentStart && coverageTo >= segmentEnd;
}

function selecionarMelhorImportPorCompetencia(rows, { segmentStart, segmentEnd }) {
  const publicados = rows
    .filter((row) => row.publication_status === "published" && coberturaContemSegmento(row, segmentStart, segmentEnd))
    .sort((a, b) => {
      const pubA = a.published_at ? new Date(a.published_at).getTime() : 0;
      const pubB = b.published_at ? new Date(b.published_at).getTime() : 0;
      if (pubB !== pubA) return pubB - pubA;
      return Number(b.id) - Number(a.id);
    });
  if (publicados.length) return publicados[0];

  const legados = rows
    .filter((row) => row.publication_status === "legacy")
    .sort((a, b) => {
      const createdA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const createdB = b.created_at ? new Date(b.created_at).getTime() : 0;
      if (createdB !== createdA) return createdB - createdA;
      return Number(b.id) - Number(a.id);
    });
  return legados[0] || null;
}

// Limites de calendário do mês da competência — só aritmética de data, não
// regra de negócio (duplicar isso localmente evita acoplar o repository ao
// centralVendasService, que já expõe periodoFromCompetencia para outros
// usos).
function monthBounds(competencia) {
  const [yearText, monthText] = String(competencia).split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const lastDay = new Date(year, month, 0).getDate();
  return { inicio: `${competencia}-01`, fim: `${competencia}-${String(lastDay).padStart(2, "0")}` };
}

async function getLatestCentralVendasImport(
  { clienteSlug, competencia, marketplace = "meli", clienteContaId = null, includeLegacy = false },
  db = pool
) {
  const params = [normalizeSlug(clienteSlug), competencia, marketplace];
  const condicoes = [
    "cliente_slug = $1", "competencia = $2", "marketplace = $3",
    "publication_status IN ('published', 'legacy')",
  ];
  const condicaoConta = condicaoContaSql(params, clienteContaId, includeLegacy);
  if (condicaoConta) condicoes.push(condicaoConta);

  const rowsResult = await db.query(
    `SELECT id, cliente_id, cliente_slug, marketplace, competencia, fonte, status, confianca,
            resumo_json, payload_json, created_at, updated_at, cliente_conta_id,
            publication_status, coverage_date_from, coverage_date_to, published_at
       FROM central_vendas_imports
      WHERE ${condicoes.join(" AND ")}`,
    params
  );

  const { inicio, fim } = monthBounds(competencia);
  const importacao = selecionarMelhorImportPorCompetencia(rowsResult.rows, { segmentStart: inicio, segmentEnd: fim });
  if (!importacao) return null;

  const [pedidosResult, itensResult, componentesResult] = await Promise.all([
    db.query(
      `SELECT *
         FROM central_vendas_pedidos
        WHERE import_id = $1
        ORDER BY data_pedido ASC NULLS LAST, pedido_id ASC, id ASC`,
      [importacao.id]
    ),
    db.query(
      `SELECT ${ITEM_READ_COLUMNS}
         FROM central_vendas_pedido_itens
        WHERE import_id = $1
        ORDER BY pedido_id ASC, id ASC`,
      [importacao.id]
    ),
    db.query(
      `SELECT ${COMPONENTE_READ_COLUMNS}
         FROM central_vendas_componentes
        WHERE import_id = $1
        ORDER BY pedido_id ASC, item_id ASC NULLS LAST, id ASC`,
      [importacao.id]
    ),
  ]);

  return {
    importacao,
    pedidos: pedidosResult.rows,
    itens: itensResult.rows,
    componentes: componentesResult.rows,
  };
}

// Colunas realmente lidas de central_vendas_pedido_itens/componentes pelo
// caminho de leitura (buildPedidoContrato/buildProdutos em
// centralVendasService.js e centralVendasEvidenceAdapter.js — auditado no
// M10): nenhum dos dois lê `payload_json` dessas duas tabelas (só
// `central_vendas_pedidos.payload_json` é lido, para logistica/full/pós-venda
// — ver rowValue(pedido, "payload", "payload_json") em buildPedidoContrato).
// Excluir esse JSONB da leitura em massa reduz bytes trafegados sem tirar
// nenhum campo do contrato canônico (M10, seção 9).
const ITEM_READ_COLUMNS = `id, import_id, pedido_row_id, cliente_id, cliente_slug, marketplace, competencia,
       pedido_id, item_id, mlb, sku, titulo, quantidade, valor_unitario, receita_produto, custo_produto,
       imposto_interno, lucro_contribuicao, resultado, margem_contribuicao_percentual, confianca,
       pendencias_json, created_at, updated_at`;
const COMPONENTE_READ_COLUMNS = `id, import_id, pedido_row_id, item_row_id, cliente_id, cliente_slug, marketplace,
       competencia, pedido_id, item_id, tipo, valor, fonte, confianca, obs, escopo, efeito,
       incluido_no_resultado, created_at, updated_at`;

// M10 — extraído de getCentralVendasByRange (mesma regra M4 exata, apenas
// separada da carga pesada de pedidos/itens/componentes): resolve SÓ os
// imports elegíveis (published com cobertura, senão legacy mais recente) por
// competência tocada pelo range. Usado tanto pela leitura completa do
// período (loadPedidosByImportIds abaixo) quanto pelo detalhe de 1 pedido
// (getPedidoDetailByRowId) — nunca uma segunda implementação da seleção.
//
// MP3 — `sync_run_id` entrou no SELECT (aditivo, mesma regra de seleção
// inalterada) para o caller poder derivar os sync_run_ids elegíveis do
// range sem uma segunda query: a conciliação Mercado Pago é escopada por
// sync_run_id (central_vendas_mp_payments/settlement_movements), nunca por
// import_id — ver centralVendasMp3ReadService.
// Diagnóstico da seleção por competência — SÓ LEITURA do que a seleção M4
// acima já decidiu (nenhuma regra nova de escolha). Para cada mês tocado pelo
// intervalo: qual import foi escolhido e, quando nenhum serviu, o published
// mais recente que existia e até onde ele cobre. É o que permite a quem lê
// dizer "o mês corrente foi sincronizado até 27/09" em vez de mostrar o mês
// como se não tivesse venda (ver docs/AUDITORIA_REALIZADO_MARGIN_SYNC.md R-01).
function competenciasDoIntervalo(dateFrom, dateTo) {
  const [yIni, mIni] = String(dateFrom).slice(0, 7).split("-").map(Number);
  const [yFim, mFim] = String(dateTo).slice(0, 7).split("-").map(Number);
  const out = [];
  let y = yIni;
  let m = mIni;
  while (y < yFim || (y === yFim && m <= mFim)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    if (out.length > 240) break; // defesa: intervalo absurdo nunca vira loop longo
  }
  return out;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function resumoDoImport(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    publicationStatus: row.publication_status || null,
    coverageFrom: asDate(row.coverage_date_from),
    coverageTo: asDate(row.coverage_date_to),
    publishedAt: toIsoOrNull(row.published_at),
    createdAt: toIsoOrNull(row.created_at),
  };
}

function diagnosticarCompetencias({ dateFrom, dateTo, porCompetencia, imports }) {
  return competenciasDoIntervalo(dateFrom, dateTo).map((competencia) => {
    const { inicio, fim } = monthBounds(competencia);
    const segmento = { dateFrom: inicio > dateFrom ? inicio : dateFrom, dateTo: fim < dateTo ? fim : dateTo };
    const escolhido = imports.find((row) => String(row.competencia) === competencia) || null;
    let publicadoMaisRecente = null;
    if (!escolhido) {
      const publicados = (porCompetencia.get(competencia) || [])
        .filter((row) => row.publication_status === "published")
        .sort((a, b) => {
          const pubA = a.published_at ? new Date(a.published_at).getTime() : 0;
          const pubB = b.published_at ? new Date(b.published_at).getTime() : 0;
          return pubB !== pubA ? pubB - pubA : Number(b.id) - Number(a.id);
        });
      publicadoMaisRecente = resumoDoImport(publicados[0] || null);
    }
    return { competencia, segmento, selecionado: resumoDoImport(escolhido), publicadoMaisRecente };
  });
}

async function resolveImportsForRange(
  { clienteSlug, dateFrom, dateTo, marketplace = "meli", clienteContaId = null, includeLegacy = false },
  db = pool
) {
  const slug = normalizeSlug(clienteSlug);
  const compFrom = String(dateFrom).slice(0, 7);
  const compTo = String(dateTo).slice(0, 7);

  const params = [slug, marketplace, compFrom, compTo];
  const condicoes = [
    "cliente_slug = $1", "marketplace = $2", "competencia BETWEEN $3 AND $4",
    "publication_status IN ('published', 'legacy')",
  ];
  const condicaoConta = condicaoContaSql(params, clienteContaId, includeLegacy);
  if (condicaoConta) condicoes.push(condicaoConta);

  const rowsResult = await db.query(
    `SELECT id, competencia, fonte, status, confianca, resumo_json, payload_json, created_at, updated_at,
            cliente_conta_id, publication_status, coverage_date_from, coverage_date_to, published_at, sync_run_id
       FROM central_vendas_imports
      WHERE ${condicoes.join(" AND ")}`,
    params
  );

  // M4 — um published só serve para a fatia daquela competência realmente
  // pedida (interseção de [dateFrom, dateTo] com o mês da competência —
  // seção 5). Reduz em JS (não em SQL) porque o trecho exigido varia por
  // competência dentro do mesmo range multi-mês.
  const porCompetencia = new Map();
  for (const row of rowsResult.rows) {
    if (!porCompetencia.has(row.competencia)) porCompetencia.set(row.competencia, []);
    porCompetencia.get(row.competencia).push(row);
  }

  const imports = [];
  for (const [comp, rows] of porCompetencia) {
    const { inicio, fim } = monthBounds(comp);
    const segmentStart = inicio > dateFrom ? inicio : dateFrom;
    const segmentEnd = fim < dateTo ? fim : dateTo;
    const escolhido = selecionarMelhorImportPorCompetencia(rows, { segmentStart, segmentEnd });
    if (escolhido) imports.push(escolhido);
  }
  imports.sort((a, b) => String(a.competencia).localeCompare(String(b.competencia)));

  return {
    imports,
    importIds: imports.map((row) => row.id),
    // Aditivo (Central de Margem): diagnóstico da MESMA seleção acima.
    competencias: diagnosticarCompetencias({ dateFrom, dateTo, porCompetencia, imports }),
  };
}

// M10 — extraído de getCentralVendasByRange: carga pesada (pedidos + itens +
// componentes) de um conjunto de imports JÁ resolvido por
// resolveImportsForRange. Comportamento idêntico ao bloco que existia dentro
// de getCentralVendasByRange antes do M10 — só separado para poder ser
// pulado no caminho de detalhe de 1 pedido.
async function loadPedidosByImportIds({ importIds, dateFrom, dateTo }, db = pool) {
  if (!Array.isArray(importIds) || !importIds.length) {
    return { pedidos: [], itens: [], componentes: [] };
  }

  const pedidosResult = await db.query(
    `SELECT *
       FROM central_vendas_pedidos
      WHERE import_id = ANY($1::bigint[])
        AND data_pedido BETWEEN $2 AND $3
      ORDER BY data_pedido ASC NULLS LAST, pedido_id ASC, id ASC`,
    [importIds, dateFrom, dateTo]
  );
  const pedidos = pedidosResult.rows;

  const pedidoRowIds = pedidos.map((row) => row.id);
  if (!pedidoRowIds.length) {
    return { pedidos: [], itens: [], componentes: [] };
  }

  const [itensResult, componentesResult] = await Promise.all([
    db.query(
      `SELECT ${ITEM_READ_COLUMNS}
         FROM central_vendas_pedido_itens
        WHERE pedido_row_id = ANY($1::bigint[])
        ORDER BY pedido_id ASC, id ASC`,
      [pedidoRowIds]
    ),
    db.query(
      `SELECT ${COMPONENTE_READ_COLUMNS}
         FROM central_vendas_componentes
        WHERE pedido_row_id = ANY($1::bigint[])
        ORDER BY pedido_id ASC, item_id ASC NULLS LAST, id ASC`,
      [pedidoRowIds]
    ),
  ]);

  return { pedidos, itens: itensResult.rows, componentes: componentesResult.rows };
}

// Leitura ENXUTA para o REALIZADO do Motor de Margem
// (centralVendasEvidenceAdapter.agregarPorMlb). Mesmos imports (já
// resolvidos por resolveImportsForRange — seleção M4 única), mesmo filtro de
// data e a MESMA ordem de itens de loadPedidosByImportIds (a ordem decide
// qual sku/título "primeiro" o agregado guarda) — só lê as colunas que a
// agregação usa e só os 3 tipos de componente que entram nela. Sem isso,
// cada página/filtro da Central de Margem transferia `payload_json` de todos
// os pedidos do período e 4 tipos de componente que a agregação descarta.
const TIPOS_COMPONENTE_REALIZADO = ["tarifa_venda", "frete_seller", "cancelamento_reembolso"];

async function loadRealizadoByImportIds({ importIds, dateFrom, dateTo }, db = pool) {
  if (!Array.isArray(importIds) || !importIds.length) {
    return { pedidos: [], itens: [], componentes: [] };
  }

  const pedidosResult = await db.query(
    `/* cv:realizado-pedidos */ SELECT id, pedido_id, data_pedido, status
       FROM central_vendas_pedidos
      WHERE import_id = ANY($1::bigint[])
        AND data_pedido BETWEEN $2 AND $3
      ORDER BY data_pedido ASC NULLS LAST, pedido_id ASC, id ASC`,
    [importIds, dateFrom, dateTo]
  );
  const pedidos = pedidosResult.rows;
  const pedidoRowIds = pedidos.map((row) => row.id);
  if (!pedidoRowIds.length) return { pedidos: [], itens: [], componentes: [] };

  const [itensResult, componentesResult] = await Promise.all([
    db.query(
      `/* cv:realizado-itens */ SELECT id, pedido_row_id, pedido_id, mlb, sku, titulo, quantidade, valor_unitario,
              receita_produto, custo_produto, imposto_interno, resultado
         FROM central_vendas_pedido_itens
        WHERE pedido_row_id = ANY($1::bigint[])
        ORDER BY pedido_id ASC, id ASC`,
      [pedidoRowIds]
    ),
    db.query(
      `/* cv:realizado-componentes */ SELECT item_row_id, pedido_row_id, tipo, valor
         FROM central_vendas_componentes
        WHERE pedido_row_id = ANY($1::bigint[])
          AND tipo = ANY($2::text[])
        ORDER BY pedido_id ASC, item_id ASC NULLS LAST, id ASC`,
      [pedidoRowIds, TIPOS_COMPONENTE_REALIZADO]
    ),
  ]);

  return { pedidos, itens: itensResult.rows, componentes: componentesResult.rows };
}

// Lê pedidos por INTERVALO de datas (não preso a um mês). Para cada competência
// que toca o intervalo, usa o ÚLTIMO import (evita duplicar re-sincronizações) e
// retorna só os pedidos com data_pedido dentro de [dateFrom, dateTo]. Itens e
// componentes são escopados pelos pedidos em range via pedido_row_id.
//
// M10 — reimplementado em cima de resolveImportsForRange +
// loadPedidosByImportIds (mesmas duas queries, mesma ordem, mesmo resultado
// final); comportamento e assinatura inalterados — centralVendasEvidenceAdapter
// (Motor de Margem) chama esta função diretamente.
async function getCentralVendasByRange(
  { clienteSlug, dateFrom, dateTo, marketplace = "meli", clienteContaId = null, includeLegacy = false },
  db = pool
) {
  const { imports, importIds } = await resolveImportsForRange(
    { clienteSlug, dateFrom, dateTo, marketplace, clienteContaId, includeLegacy },
    db
  );
  if (!imports.length) return null;

  const { pedidos, itens, componentes } = await loadPedidosByImportIds({ importIds, dateFrom, dateTo }, db);
  return { importacao: imports[0], imports, pedidos, itens, componentes };
}

// M10 — detalhe de UM pedido (drawer da Central), sem carregar/reconstruir o
// período inteiro. `importIds` já vem resolvido pela MESMA seleção M4
// (resolveImportsForRange, chamada por centralVendasService.resolveRangeImports)
// — aqui só valida que o rowId pedido pertence a um desses imports e está
// dentro do range, e carrega SÓ aquele pedido + seus itens + seus
// componentes. Nunca aceita rowId sem essa validação (evita IDOR por
// construção, seção 9 do M7 preservada).
async function getPedidoDetailByRowId({ importIds, dateFrom, dateTo, rowId }, db = pool) {
  if (!Array.isArray(importIds) || !importIds.length) return null;
  if (!Number.isFinite(Number(rowId))) return null;

  const pedidoResult = await db.query(
    `SELECT *
       FROM central_vendas_pedidos
      WHERE id = $1
        AND import_id = ANY($2::bigint[])
        AND data_pedido BETWEEN $3 AND $4
      LIMIT 1`,
    [rowId, importIds, dateFrom, dateTo]
  );
  const pedido = pedidoResult.rows[0];
  if (!pedido) return null;

  const [itensResult, componentesResult] = await Promise.all([
    db.query(
      `SELECT ${ITEM_READ_COLUMNS}
         FROM central_vendas_pedido_itens
        WHERE pedido_row_id = $1
        ORDER BY id ASC`,
      [pedido.id]
    ),
    db.query(
      `SELECT ${COMPONENTE_READ_COLUMNS}
         FROM central_vendas_componentes
        WHERE pedido_row_id = $1
        ORDER BY item_id ASC NULLS LAST, id ASC`,
      [pedido.id]
    ),
  ]);

  return { pedido, itens: itensResult.rows, componentes: componentesResult.rows };
}

// M4, seção 9 — promove TODOS os candidates de um sync_run para published de
// uma vez (um run pode ter gerado 1 import por competência tocada). Nunca
// mexe em published_at de linhas já published (WHERE publication_status =
// 'candidate' as exclui) — rodar duas vezes para o mesmo runId na segunda
// vez não encontra candidate nenhum e é um no-op: idempotente por
// construção, sem precisar de lock ou verificação extra.
async function promoverCandidatesDoRun(syncRunId, db = pool) {
  const result = await db.query(
    `UPDATE central_vendas_imports
        SET publication_status = 'published', published_at = NOW(), updated_at = NOW()
      WHERE sync_run_id = $1 AND publication_status = 'candidate'
      RETURNING id, competencia`,
    [syncRunId]
  );
  return result.rows;
}

module.exports = {
  ensureCentralVendasTables,
  withTransaction,
  getClienteBySlug,
  persistCentralVendasImport,
  getLatestCentralVendasImport,
  getCentralVendasByRange,
  // M10 — leitura otimizada (ver comentários acima das funções).
  resolveImportsForRange,
  loadPedidosByImportIds,
  loadRealizadoByImportIds,
  TIPOS_COMPONENTE_REALIZADO,
  getPedidoDetailByRowId,
  promoverCandidatesDoRun,
  selecionarMelhorImportPorCompetencia,
  coberturaContemSegmento,
  monthBounds,
  competenciasDoIntervalo,
  diagnosticarCompetencias,
  // M6 — expostas para teste direto do ledger (insertComponente em
  // particular) contra uma fake db, sem depender de withTransaction/pool
  // real (persistCentralVendasImport não aceita db injetado — ver
  // centralVendasM4Publication.test.js para o mesmo motivo já documentado).
  createImport,
  insertPedido,
  insertItem,
  insertComponente,
  // BLOCO 13 — exposta para o teste de fronteira de timezone: prova que a
  // data do pedido é lida LITERALMENTE da string do Mercado Livre
  // (String(x).slice(0,10)), nunca via new Date() (que deslocaria o dia).
  asDate,
};
