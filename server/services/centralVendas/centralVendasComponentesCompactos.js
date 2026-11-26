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
  const itens = new Set((motorPayload.itens || []).map((i) => i.itemId));
  const textos = new Set();
  for (const c of motorPayload.componentes || []) {
    if (!pedidos.has(c.pedidoId)) return { elegivel: false, motivo: "COMPONENTE_SEM_PEDIDO" };
    if (c.itemId && !itens.has(c.itemId)) return { elegivel: false, motivo: "COMPONENTE_ITEM_SEM_LINHA" };
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
    if (!porPedido.has(p)) porPedido.set(p, { p, c: [], v: [], i: [], x: null });
    const l = porPedido.get(p);
    const fonte = textoOuNull(c.fonte);
    const obs = textoOuNull(c.obs);
    l.c.push(textos.get(c.tipo), fonte === null ? 0 : textos.get(fonte), textos.get(c.confianca), obs === null ? 0 : textos.get(obs));
    l.v.push(c.valor ?? null);
    l.i.push(c.itemId ? itemRowsById.get(c.itemId) ?? null : null);
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

module.exports = {
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
