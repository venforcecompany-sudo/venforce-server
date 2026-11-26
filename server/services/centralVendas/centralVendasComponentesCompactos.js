// server/services/centralVendas/centralVendasComponentesCompactos.js
//
// Componentes financeiros COMPACTOS (formato v2) — uma linha por PEDIDO em
// central_vendas_pedido_componentes, no lugar de uma linha por componente em
// central_vendas_componentes. Ver a migration
// sql/migrations/20261126_central_vendas_pedido_componentes.sql e
// docs/banco-de-dados/10_COMPONENTES_COMPACTOS.md.
//
// O que muda é SÓ o armazenamento físico. O contrato de leitura é o mesmo:
// os leitores recebem linhas no formato de COMPONENTE_READ_COLUMNS
// (centralVendasRepository), com os mesmos valores, tipos e ordem — `id` vem
// NULL nas linhas compactas (nenhum leitor usa o id do componente).
//
//   - valor: NUMERIC(14,2) dos dois lados; o cast acontece na GRAVAÇÃO, como na
//     coluna antiga (mesmo arredondamento, mesmo erro de estouro);
//   - NULL (ausente) ≠ 0: arrays SQL guardam NULL;
//   - componentes repetidos do mesmo tipo: cada um é uma posição do array;
//   - escopo/efeito/incluido_no_resultado: derivados de (tipo, item) pela regra
//     do formato 1 (= classificarComponenteFinanceiro do M6). A regra fica
//     CONGELADA aqui (REGRA_FORMATO_1); mudar a classificação exige formato 2;
//   - import_id/cliente/marketplace/competencia/pedido_id/created_at/updated_at:
//     da linha do pedido (mesma transação, mesmos valores — medido);
//   - item_id: da linha do item (item_row_ids).
//
// Escrita: opt-in por flag + lista de contas, só imports do Sync (como a
// persistência enxuta). Leitura: sempre entende os dois formatos, então
// desligar a flag nunca deixa um import já gravado incompleto.

const ENV_NAME = "CENTRAL_VENDAS_COMPONENTES_COMPACTOS";
const ENV_CONTAS = "CENTRAL_VENDAS_COMPONENTES_COMPACTOS_CONTAS";
const TABELA = "central_vendas_pedido_componentes";
const TABELA_TEXTOS = "central_vendas_componente_textos";
const FORMATO = 1;
const VALORES_LIGADO = new Set(["true", "1", "on", "yes", "sim"]);

// Regra de classificação do formato 1 — cópia CONGELADA de
// centralVendasComponenteLedger (M6). Um teste garante que as duas são iguais
// hoje; se o ledger mudar, o teste falha e a mudança precisa de formato novo
// (senão o histórico gravado em v2 seria reclassificado na leitura).
const REGRA_FORMATO_1 = Object.freeze({
  efeito: Object.freeze({
    receita_produto: "credito",
    receita_envio: "credito",
    tarifa_venda: "debito",
    custo_produto: "debito",
    imposto_interno: "debito",
    frete_seller: "debito",
    cancelamento_reembolso: "debito",
  }),
  noResultado: Object.freeze(["receita_produto", "tarifa_venda", "custo_produto", "imposto_interno", "frete_seller"]),
  informativos: Object.freeze(["receita_envio", "cancelamento_reembolso"]),
});

function isEscritaCompactaHabilitada({ fonte, syncRunId, clienteContaId }, env = process.env) {
  const raw = env[ENV_NAME];
  if (raw == null || !VALORES_LIGADO.has(String(raw).trim().toLowerCase())) return false;
  if (fonte !== "orders_api" || syncRunId == null) return false;
  const lista = String(env[ENV_CONTAS] || "").split(",").map((v) => v.trim()).filter(Boolean);
  if (lista.includes("*")) return true;
  return clienteContaId != null && lista.includes(String(clienteContaId));
}

// Existência das DUAS tabelas, por pool/client — mesma semântica de
// centralVendasPedidosCompartilhados.tabelaVinculosDisponivel: "existe" fica
// em cache; "não existe" só vale confirmado e nunca é cacheado; erro PROPAGA
// (um leitor nunca conclui "sem componentes compactos" por não ter conseguido
// perguntar — devolveria pedidos sem composição).
const cache = new WeakMap();
async function tabelaCompactaDisponivel(db) {
  const chave = db && typeof db === "object" ? db : cache;
  if (cache.get(chave) === true) return true;
  const r = await db.query(
    `SELECT to_regclass('public.${TABELA}') IS NOT NULL AND to_regclass('public.${TABELA_TEXTOS}') IS NOT NULL AS ok`
  );
  const linha = r && r.rows && r.rows[0];
  if (!linha || typeof linha.ok !== "boolean") throw new Error("COMPONENTES_COMPACTOS_EXISTENCIA_INDETERMINADA");
  if (linha.ok) cache.set(chave, true);
  return linha.ok;
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------
function textoOuNull(v) { return v === null || v === undefined || v === "" ? null : v; }

// O import pode ir para o formato compacto sem NENHUMA diferença de leitura?
// Qualquer caso que a linha antiga representaria e a compacta não — fica no
// formato antigo (o import inteiro), nunca uma aproximação.
function avaliarImport(motorPayload) {
  const pedidos = new Set((motorPayload.pedidos || []).map((p) => p.pedidoId));
  const pedidoDoItem = new Map((motorPayload.itens || []).map((i) => [i.itemId, i.pedidoId]));
  const textos = new Set();
  for (const c of motorPayload.componentes || []) {
    if (!pedidos.has(c.pedidoId)) return { elegivel: false, motivo: "COMPONENTE_SEM_PEDIDO" };
    if (c.itemId && !pedidoDoItem.has(c.itemId)) return { elegivel: false, motivo: "COMPONENTE_ITEM_SEM_LINHA" };
    // Item de OUTRO pedido: a linha antiga ordenaria pelo item_id do item; aqui
    // a composição é do pedido — fica no formato antigo.
    if (c.itemId && pedidoDoItem.get(c.itemId) !== c.pedidoId) return { elegivel: false, motivo: "COMPONENTE_ITEM_DE_OUTRO_PEDIDO" };
    if (typeof c.tipo !== "string" || c.tipo === "") return { elegivel: false, motivo: "COMPONENTE_TIPO_INVALIDO" };
    if (typeof c.confianca !== "string" || c.confianca === "") return { elegivel: false, motivo: "COMPONENTE_CONFIANCA_INVALIDA" };
    const v = c.valor;
    if (!(v === null || v === undefined || (typeof v === "number" && Number.isFinite(v)))) {
      return { elegivel: false, motivo: "COMPONENTE_VALOR_NAO_NUMERICO" };
    }
    for (const t of [c.tipo, textoOuNull(c.fonte), c.confianca, textoOuNull(c.obs)]) {
      if (t === null) continue;
      if (typeof t !== "string") return { elegivel: false, motivo: "COMPONENTE_TEXTO_INVALIDO" };
      textos.add(t);
    }
  }
  return { elegivel: true, textos: [...textos].sort() };
}

// Dicionário: grava os textos que faltarem numa transação PRÓPRIA e curta
// (autocommit), ANTES da transação do import — a linha nova do dicionário
// nunca fica travada durante a gravação inteira de outro import (o histórico
// de 40P01 do sync noturno). Append-only e idempotente: texto sobrando num
// import abortado é inofensivo. Ordem fixa ⇒ sem deadlock entre dois imports.
async function garantirTextos(textos, db) {
  if (!textos.length) return new Map();
  await db.query(
    `INSERT INTO ${TABELA_TEXTOS} (texto) SELECT t FROM unnest($1::text[]) AS t ORDER BY t ON CONFLICT (texto) DO NOTHING`,
    [textos]
  );
  const { rows } = await db.query(`SELECT id, texto FROM ${TABELA_TEXTOS} WHERE texto = ANY($1::text[])`, [textos]);
  const mapa = new Map(rows.map((r) => [r.texto, Number(r.id)]));
  for (const t of textos) if (!mapa.has(t)) throw new Error("COMPONENTES_COMPACTOS_TEXTO_NAO_GRAVADO");
  return mapa;
}

// Monta as linhas por pedido, na ordem do motor (= ordem do antigo `id`).
function montarLinhas({ componentes, pedidoRowsById, itemRowsById, textos, extrasDoComponente }) {
  const porPedido = new Map();
  for (const c of componentes) {
    const p = pedidoRowsById.get(c.pedidoId);
    if (p == null) throw new Error(`COMPONENTES_COMPACTOS_PEDIDO_SEM_LINHA:${c.pedidoId}`);
    if (!porPedido.has(p)) porPedido.set(p, { p, c: [], v: [], i: [], x: null });
    const l = porPedido.get(p);
    const fonte = textoOuNull(c.fonte);
    const obs = textoOuNull(c.obs);
    l.c.push(textos.get(c.tipo), fonte === null ? 0 : textos.get(fonte), textos.get(c.confianca), obs === null ? 0 : textos.get(obs));
    l.v.push(c.valor ?? null);
    const itemRow = c.itemId ? itemRowsById.get(c.itemId) : null;
    // Nunca rebaixar um componente de item a componente de pedido em silêncio.
    if (c.itemId && itemRow == null) throw new Error(`COMPONENTES_COMPACTOS_ITEM_SEM_LINHA:${c.itemId}`);
    l.i.push(itemRow ?? null);
    const extras = extrasDoComponente(c);
    if (extras && Object.keys(extras).length) {
      l.x = l.x || {};
      l.x[String(l.v.length)] = extras;
    }
  }
  return [...porPedido.values()];
}

async function gravarCompactos(linhas, db) {
  if (!linhas.length) return 0;
  // Um único INSERT para o import inteiro. Os valores chegam como texto do
  // JSON (mesma representação que o node-pg manda para a coluna antiga) e são
  // convertidos para NUMERIC(14,2) AQUI — mesmo arredondamento e mesmo erro
  // de estouro da coluna `valor`.
  const r = await db.query(
    `/* cv:componentes-compactos-insert */
     INSERT INTO ${TABELA} (pedido_row_id, formato, codigos, valores, item_row_ids, extras)
     SELECT (e->>'p')::bigint, ${FORMATO},
            ARRAY(SELECT t::int FROM jsonb_array_elements_text(e->'c') WITH ORDINALITY AS a(t, o) ORDER BY o),
            ARRAY(SELECT t::numeric(14,2) FROM jsonb_array_elements_text(e->'v') WITH ORDINALITY AS a(t, o) ORDER BY o),
            ARRAY(SELECT t::bigint FROM jsonb_array_elements_text(e->'i') WITH ORDINALITY AS a(t, o) ORDER BY o),
            NULLIF(e->'x', 'null'::jsonb)
       FROM jsonb_array_elements($1::jsonb) AS e`,
    [JSON.stringify(linhas)]
  );
  // Atomicidade: exatamente uma linha por pedido, senão a transação do import aborta.
  if (r.rowCount !== linhas.length) throw new Error(`COMPONENTES_COMPACTOS_INSERT_PARCIAL:${r.rowCount}/${linhas.length}`);
  return r.rowCount;
}

// ---------------------------------------------------------------------------
// Leitura — linhas no formato antigo (COMPONENTE_READ_COLUMNS) + `ordem`.
// ---------------------------------------------------------------------------
const lista = (xs) => xs.map((x) => `'${x}'`).join(",");
function casosEfeito() {
  const porEfeito = {};
  for (const [tipo, efeito] of Object.entries(REGRA_FORMATO_1.efeito)) (porEfeito[efeito] = porEfeito[efeito] || []).push(tipo);
  return Object.entries(porEfeito).map(([efeito, tipos]) => `WHEN tt.texto IN (${lista(tipos)}) THEN '${efeito}'`).join(" ");
}
const SQL_EFEITO = `CASE ${casosEfeito()} END`;
const SQL_INCLUIDO = `CASE WHEN tt.texto IN (${lista(REGRA_FORMATO_1.noResultado)}) THEN TRUE
                           WHEN tt.texto IN (${lista(REGRA_FORMATO_1.informativos)}) THEN FALSE END`;

// `filtro` é uma condição sobre `pc` (a linha compacta) e/ou `p` (o pedido
// DONO da linha). Devolve o SELECT (sem ORDER BY) com as colunas pedidas.
const COLUNAS_COMPLETAS = {
  id: "NULL::bigint", import_id: "p.import_id", pedido_row_id: "pc.pedido_row_id", item_row_id: "u.item_row_id",
  cliente_id: "p.cliente_id", cliente_slug: "p.cliente_slug", marketplace: "p.marketplace", competencia: "p.competencia",
  pedido_id: "p.pedido_id", item_id: "i.item_id", tipo: "tt.texto", valor: "u.valor", fonte: "tf.texto",
  confianca: "tc.texto", obs: "tob.texto",
  escopo: "CASE WHEN u.item_row_id IS NOT NULL THEN 'item' ELSE 'pedido' END",
  efeito: SQL_EFEITO, incluido_no_resultado: SQL_INCLUIDO, created_at: "p.created_at", updated_at: "p.updated_at",
};

function sqlCompactos({ colunas, filtro }) {
  const proj = colunas.map((c) => `${COLUNAS_COMPLETAS[c]} AS ${c}`).join(", ");
  return `SELECT ${proj}, u.ordem AS ordem_compacta
    FROM ${TABELA} pc
    JOIN central_vendas_pedidos p ON p.id = pc.pedido_row_id
    CROSS JOIN LATERAL unnest(pc.valores, pc.item_row_ids) WITH ORDINALITY AS u(valor, item_row_id, ordem)
    JOIN ${TABELA_TEXTOS} tt ON tt.id = pc.codigos[4 * u.ordem - 3]
    JOIN ${TABELA_TEXTOS} tc ON tc.id = pc.codigos[4 * u.ordem - 1]
    LEFT JOIN ${TABELA_TEXTOS} tf ON tf.id = NULLIF(pc.codigos[4 * u.ordem - 2], 0)
    LEFT JOIN ${TABELA_TEXTOS} tob ON tob.id = NULLIF(pc.codigos[4 * u.ordem], 0)
    LEFT JOIN central_vendas_pedido_itens i ON i.id = u.item_row_id
   WHERE ${filtro}`;
}

// UNION ALL das duas origens com a ordem da consulta antiga (pedido_id,
// item_id NULLS LAST, ordem de gravação). A "ordem de gravação" precisa ser
// comparável ENTRE formatos (o mesmo pedido_id pode estar num import antigo em
// linhas e num compacto — borda de mês, planilha): (linha do pedido, id antigo
// | posição no array). Para linhas de um mesmo import isso é exatamente o id
// antigo (pedidos e componentes são gravados na mesma ordem, numa transação);
// só diferiria do `ORDER BY id` antigo entre dois imports gravados em
// transações intercaladas, sem efeito no contrato (que agrupa por linha do
// pedido). Sem a tabela compacta o repositório usa a consulta antiga, literal.
//   legado:    { filtro: "<condição em central_vendas_componentes>" }
//   compacto:  { filtro: "<condição em pc/p>" }
//   ordem:     "pedido" (pedido_id, item_id) | "item" (item_id) — detalhe de 1 pedido
function sqlUniao({ colunas, filtroLegado, filtroCompacto, ordem = "pedido", comentario = "" }) {
  const cols = colunas.join(", ");
  const chaves = ordem === "pedido" ? "pedido_id ASC, item_id ASC NULLS LAST" : "item_id ASC NULLS LAST";
  const precisa = ["pedido_id", "item_id", "id", "pedido_row_id"].filter((c) => !colunas.includes(c));
  const colsInternas = [...colunas, ...precisa];
  return `${comentario}SELECT ${cols} FROM (
      SELECT ${colsInternas.join(", ")}, NULL::bigint AS ordem_compacta FROM central_vendas_componentes WHERE ${filtroLegado}
      UNION ALL
      SELECT ${colsInternas.join(", ")}, ordem_compacta FROM (${sqlCompactos({ colunas: colsInternas, filtro: filtroCompacto })}) cpt
    ) cv
    ORDER BY ${chaves}, pedido_row_id ASC, id ASC NULLS LAST, ordem_compacta ASC`;
}

// ---------------------------------------------------------------------------
// Leitura com decodificação em JS (caminho padrão). O banco faz só o que tem
// de fazer: devolve UMA linha crua por pedido (arrays, sem unnest nem junções
// com o dicionário) e a ORDEM dos grupos (pedido_id, item_id NULLS LAST, linha
// do pedido) — a ordenação de texto continua com a collation do banco, nunca
// do JS. O JS expande os arrays e intercala as linhas antigas e as compactas
// grupo a grupo. Qualquer coisa que não encaixe exatamente devolve `null`, e
// o chamador usa a união em SQL (sqlUniao) — nunca uma aproximação.
// ---------------------------------------------------------------------------

// Arrays como UMA string cada (array_to_string), divididos em JS: o parser de
// arrays do node-pg custava 4× mais que a consulta no servidor (66 ms × 17 ms
// em 3.000 pedidos). Valores ficam TEXTO — a mesma string que a coluna `valor`
// antiga devolve ("12.30"; NUMERIC[] viraria número JS e perderia o formato).
// '' marca NULL nos três arrays: sem o marcador, array_to_string DESCARTA os
// NULLs e as posições desalinhariam em silêncio (em `codigos`, '' é corrupção).
function sqlCompactosCrus(filtro) {
  return `/* cv:componentes-compactos-crus */
    SELECT pc.pedido_row_id::text AS pedido_row_id, pc.formato,
           array_to_string(pc.codigos, ',', '') AS c, array_to_string(pc.valores, ',', '') AS v,
           array_to_string(pc.item_row_ids, ',', '') AS i
      FROM ${TABELA} pc JOIN central_vendas_pedidos p ON p.id = pc.pedido_row_id
     WHERE ${filtro}`;
}

function lerLinhaCrua(r) {
  if (r.codigos) return r; // já decodificada
  const codigos = String(r.c).split(",").map((t) => {
    if (t === "") throw new ComponentesCompactosCorrompidos("CODIGO_NULO", r.pedido_row_id);
    return Number(t);
  });
  return {
    pedido_row_id: String(r.pedido_row_id), formato: r.formato, codigos,
    valores: String(r.v).split(",").map((t) => (t === "" ? null : t)),
    item_row_ids: String(r.i).split(",").map((t) => (t === "" ? null : t)),
  };
}

// Ordem dos grupos (pedido_id, item_id NULLS LAST, linha do pedido) = a da
// consulta antiga, ordenada PELO BANCO (collation). Uma linha por item; pedido
// sem item vem com item NULL. Os grupos "do pedido" (item NULL) de cada bloco
// de pedido_id são postos no fim do bloco, por linha do pedido (NULLS LAST).
// Colunas do pedido só quando o leitor as pede.
const COLUNAS_DO_PEDIDO = ["import_id", "cliente_id", "cliente_slug", "marketplace", "competencia", "created_at", "updated_at"];
function sqlGrupos(colunasPedido) {
  const extra = colunasPedido.map((c) => `, p.${c}`).join("");
  return `/* cv:componentes-grupos */
    SELECT p.id::text AS pedido_row_id, p.pedido_id, i.id::text AS item_row_id, i.item_id${extra}
      FROM central_vendas_pedidos p LEFT JOIN central_vendas_pedido_itens i ON i.pedido_row_id = p.id
     WHERE p.id = ANY($1::bigint[])
     ORDER BY p.pedido_id ASC, i.item_id ASC NULLS LAST, p.id ASC`;
}
function gruposEmOrdem(rows) {
  const grupos = [];
  let bloco = null;
  let linhasDoBloco = [];
  const fecharBloco = () => {
    const unicas = [...new Set(linhasDoBloco)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    for (const pr of unicas) grupos.push({ pedido_row_id: pr, item_row_id: null, item_id: null });
    linhasDoBloco = [];
  };
  rows.forEach((r, n) => {
    if (n === 0 || r.pedido_id !== bloco) { if (n > 0) fecharBloco(); bloco = r.pedido_id; }
    linhasDoBloco.push(r.pedido_row_id);
    if (r.item_row_id != null) grupos.push({ pedido_row_id: r.pedido_row_id, item_row_id: r.item_row_id, item_id: r.item_id });
  });
  if (rows.length) fecharBloco();
  return grupos;
}

const INCLUIDO_SIM = new Set(REGRA_FORMATO_1.noResultado);
const INCLUIDO_NAO = new Set(REGRA_FORMATO_1.informativos);
const EFEITO = REGRA_FORMATO_1.efeito;

class ComponentesCompactosCorrompidos extends Error {
  constructor(motivo, pedidoRowId) {
    super(`COMPONENTES_COMPACTOS_CORROMPIDOS:${motivo}:pedido_row_id=${pedidoRowId}`);
    this.code = "COMPONENTES_COMPACTOS_CORROMPIDOS";
  }
}

// Integridade de UMA linha compacta: formato conhecido, posições alinhadas.
// Linha inconsistente é ERRO (nunca componente perdido em silêncio).
function validarLinhaCompacta(r) {
  if (Number(r.formato) !== FORMATO) throw new ComponentesCompactosCorrompidos(`FORMATO_${r.formato}`, r.pedido_row_id);
  const n = Array.isArray(r.valores) ? r.valores.length : -1;
  if (n < 1 || !Array.isArray(r.item_row_ids) || r.item_row_ids.length !== n
    || !Array.isArray(r.codigos) || r.codigos.length !== 4 * n) {
    throw new ComponentesCompactosCorrompidos("DIMENSOES", r.pedido_row_id);
  }
  return n;
}

// Contadores do processo (observabilidade e testes): qual caminho cada leitura usou.
const estatisticas = { legado: 0, legadoComTabela: 0, mesclaJs: 0, uniaoSql: 0 };

const chaveGrupo = (pedidoRowId, itemRowId) => `${pedidoRowId}|${itemRowId == null ? "" : itemRowId}`;

/**
 * Mescla as linhas antigas (já filtradas e ordenadas pelo SQL antigo) com as
 * compactas, no formato e na ordem de sempre.
 *   linhasLegado: linhas de central_vendas_componentes com `colunas` + as
 *                 internas id/pedido_row_id/item_row_id/item_id (podem já estar em `colunas`)
 *   linhasCompactas: resultado de sqlCompactosCrus
 *   tipos: filtro por tipo (só para as compactas; o SQL antigo já filtrou as suas)
 * Devolve as linhas, ou null quando o caminho em SQL deve ser usado.
 */
async function mesclarComponentes(db, { linhasLegado, linhasCompactas, colunas, tipos = null, internas = [], paralelo = false }) {
  const pedidoIds = new Set();
  linhasCompactas = linhasCompactas.map(lerLinhaCrua);
  for (const r of linhasCompactas) { validarLinhaCompacta(r); pedidoIds.add(String(r.pedido_row_id)); }
  for (const r of linhasLegado) {
    // Componente antigo sem linha de pedido, ou com item sem linha de item: a
    // ordem dele depende do item_id do próprio componente — só a SQL ordena.
    if (r.pedido_row_id == null) return null;
    if (r.item_row_id == null && r.item_id != null) return null;
    pedidoIds.add(String(r.pedido_row_id));
  }
  const ids = new Set();
  for (const r of linhasCompactas) for (let k = 0; k < r.codigos.length; k += 1) if (r.codigos[k]) ids.add(r.codigos[k]);
  const colunasPedido = COLUNAS_DO_PEDIDO.filter((c) => colunas.includes(c));
  const consultas = [
    () => db.query(sqlGrupos(colunasPedido), [[...pedidoIds]]),
    () => db.query(`/* cv:componentes-textos */ SELECT id, texto FROM ${TABELA_TEXTOS} WHERE id = ANY($1::int[])`, [[...ids]]),
  ];
  const [grupos, dicionario] = paralelo
    ? await Promise.all(consultas.map((f) => f()))
    : [await consultas[0](), await consultas[1]()];
  const texto = new Map(dicionario.rows.map((d) => [Number(d.id), d.texto]));
  for (const id of ids) if (!texto.has(id)) throw new ComponentesCompactosCorrompidos(`TEXTO_${id}_AUSENTE`, "?");

  const doPedido = new Map();
  for (const g of grupos.rows) if (!doPedido.has(g.pedido_row_id)) doPedido.set(g.pedido_row_id, g);
  const ordem = gruposEmOrdem(grupos.rows);
  const itemDoGrupo = new Map();
  const baldes = new Map();
  for (const g of ordem) {
    const k = chaveGrupo(g.pedido_row_id, g.item_row_id);
    itemDoGrupo.set(k, g.item_id);
    baldes.set(k, []);
  }
  for (const r of linhasLegado) {
    const k = chaveGrupo(r.pedido_row_id, r.item_row_id);
    // O item_id do componente antigo precisa ser o da linha do item (a ordem vem dele).
    if (!baldes.has(k) || (r.item_row_id != null && itemDoGrupo.get(k) !== r.item_id)) return null;
    if (internas.length) {
      const o = {};
      for (const c of colunas) o[c] = r[c];
      baldes.get(k).push(o);
    } else {
      baldes.get(k).push(r);
    }
  }
  const quer = (c) => colunas.includes(c);
  const filtroTipos = tipos ? new Set(tipos) : null;
  let compactas = 0;
  for (const r of linhasCompactas) {
    const n = r.valores.length;
    const pedidoRowId = String(r.pedido_row_id);
    const ped = doPedido.get(pedidoRowId);
    if (!ped) return null;
    for (let k = 0; k < n; k += 1) {
      const tipo = texto.get(r.codigos[4 * k]);
      if (filtroTipos && !filtroTipos.has(tipo)) continue;
      const itemRowId = r.item_row_ids[k] == null ? null : String(r.item_row_ids[k]);
      const chave = chaveGrupo(pedidoRowId, itemRowId);
      if (!baldes.has(chave)) return null; // item de outro pedido: a SQL ordena pelo item_id do item
      const valores = {
        id: null, import_id: ped.import_id, pedido_row_id: pedidoRowId, item_row_id: itemRowId,
        cliente_id: ped.cliente_id, cliente_slug: ped.cliente_slug, marketplace: ped.marketplace, competencia: ped.competencia,
        pedido_id: ped.pedido_id, item_id: itemRowId == null ? null : itemDoGrupo.get(chave),
        tipo, valor: r.valores[k],
        fonte: r.codigos[4 * k + 1] ? texto.get(r.codigos[4 * k + 1]) : null,
        confianca: texto.get(r.codigos[4 * k + 2]),
        obs: r.codigos[4 * k + 3] ? texto.get(r.codigos[4 * k + 3]) : null,
        escopo: itemRowId == null ? "pedido" : "item",
        efeito: Object.prototype.hasOwnProperty.call(EFEITO, tipo) ? EFEITO[tipo] : null,
        incluido_no_resultado: INCLUIDO_SIM.has(tipo) ? true : INCLUIDO_NAO.has(tipo) ? false : null,
        created_at: ped.created_at, updated_at: ped.updated_at,
      };
      const o = {};
      for (const c of colunas) if (quer(c)) o[c] = valores[c];
      baldes.get(chave).push(o);
      compactas += 1;
    }
  }
  const saida = [];
  for (const g of ordem) for (const r of baldes.get(chaveGrupo(g.pedido_row_id, g.item_row_id))) saida.push(r);
  // Conservação: nenhuma linha some nem duplica na mescla.
  if (saida.length !== linhasLegado.length + compactas) throw new ComponentesCompactosCorrompidos("CONTAGEM_MESCLA", "*");
  return saida;
}

module.exports = {
  estatisticas,
  ComponentesCompactosCorrompidos,
  sqlCompactosCrus,
  lerLinhaCrua,
  gruposEmOrdem,
  mesclarComponentes,
  validarLinhaCompacta,
  ENV_NAME,
  ENV_CONTAS,
  TABELA,
  TABELA_TEXTOS,
  FORMATO,
  REGRA_FORMATO_1,
  isEscritaCompactaHabilitada,
  tabelaCompactaDisponivel,
  avaliarImport,
  garantirTextos,
  montarLinhas,
  gravarCompactos,
  sqlCompactos,
  sqlUniao,
};
