// server/services/centralVendas/centralVendasPedidosCompartilhados.js
//
// Pedidos de um import = linhas próprias (central_vendas_pedidos.import_id)
// ∪ linhas vinculadas (central_vendas_import_pedidos) — reuso de pedidos
// inalterados entre imports do Sync. Ver a migration
// sql/migrations/20261111_central_vendas_import_pedidos.sql.
//
// Este módulo é o ÚNICO lugar que sabe disso: todo leitor que buscava
// pedidos por `import_id` passa a usar `fontePedidosSql`, que devolve
// (pedido_row_id, import_lido) — `import_lido` é o import PEDIDO pelo leitor
// (não o dono da linha), para que agrupamentos por import continuem certos.
// Itens e componentes seguem o pedido por pedido_row_id.
//
// Sem a tabela (migration não aplicada) o fragmento é só a parte das linhas
// próprias: SQL e resultado idênticos aos de antes.

const ENV_NAME = "CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS";
const TABELA = "central_vendas_import_pedidos";

const cache = new WeakMap();

const ENV_CONTAS = "CENTRAL_VENDAS_SYNC_REUSO_CONTAS";

// Rollout por conta (só ESCRITA — os leitores entendem vínculos sempre, então
// desligar/trocar a lista nunca deixa um import já gravado incompleto):
//   CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS=true  E
//   CENTRAL_VENDAS_SYNC_REUSO_CONTAS="41,87" (cliente_conta_id) ou "*" (todas).
// Lista ausente/vazia = nenhuma conta (opt-in explícito).
function isReusoHabilitado(env = process.env, clienteContaId = null) {
  if (!["true", "1", "on", "sim"].includes(String(env[ENV_NAME] || "").trim().toLowerCase())) return false;
  const lista = String(env[ENV_CONTAS] || "").split(",").map((v) => v.trim()).filter(Boolean);
  if (lista.includes("*")) return true;
  return clienteContaId != null && lista.includes(String(clienteContaId));
}

// Existência da tabela, por pool/client.
//  - "Existe" fica em cache para sempre (tabela não some em operação).
//  - "Não existe" só vale se o PostgreSQL CONFIRMOU (to_regclass = NULL) e
//    NUNCA é cacheado: assim, no instante em que a migration é aplicada, todo
//    leitor passa a enxergar os vínculos na leitura seguinte (um negativo
//    velho faria o leitor ignorar pedidos vinculados e devolver valores
//    incompletos). Custo: uma consulta de catálogo por leitura enquanto a
//    tabela não existe.
//  - Qualquer erro (timeout, conexão caída, transação abortada) PROPAGA: um
//    leitor nunca pode concluir "sem vínculos" por não ter conseguido
//    perguntar. Quem chama falha em vez de devolver/persistir dado parcial.
async function tabelaVinculosDisponivel(db) {
  const chave = db && typeof db === "object" ? db : cache;
  if (cache.get(chave) === true) return true;
  const r = await db.query(`SELECT to_regclass('public.${TABELA}') IS NOT NULL AS ok`);
  const linha = r && r.rows && r.rows[0];
  if (!linha || typeof linha.ok !== "boolean") {
    throw new Error("PEDIDOS_COMPARTILHADOS_EXISTENCIA_INDETERMINADA");
  }
  if (linha.ok) cache.set(chave, true);
  return linha.ok;
}

// Fragmento FROM: ( ... ) AS <alias> com colunas pedido_row_id, import_lido.
// `param` é o placeholder do array de import ids (ex.: "$1").
function fontePedidosSql(param, { comVinculos, alias = "fp" } = {}) {
  const proprias = `SELECT p0.id AS pedido_row_id, p0.import_id AS import_lido
                      FROM central_vendas_pedidos p0 WHERE p0.import_id = ANY(${param}::bigint[])`;
  if (!comVinculos) return `(${proprias}) ${alias}`;
  return `(${proprias}
           UNION ALL
           SELECT v0.pedido_row_id, v0.import_id AS import_lido
             FROM ${TABELA} v0 WHERE v0.import_id = ANY(${param}::bigint[])) ${alias}`;
}

async function fontePedidos(db, param, opts = {}) {
  return fontePedidosSql(param, { ...opts, comVinculos: await tabelaVinculosDisponivel(db) });
}

// Linhas de pedido de `SELECT p.*, fp.import_lido`: import_id passa a ser o
// import lido (mesmo formato de linha de antes).
function normalizarImportLido(rows) {
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(row, "import_lido")) {
      row.import_id = row.import_lido;
      delete row.import_lido;
    }
  }
  return rows;
}

// Itens/componentes seguem o pedido por pedido_row_id; numa linha vinculada o
// import_id gravado é o do DONO. Reescreve para o import lido do pedido — só
// quando difere (linhas próprias: objetos devolvidos intactos).
function itensComImportLido(pedidos, itens, componentes) {
  const lido = new Map(pedidos.map((p) => [String(p.id), p.import_id]));
  const ajustar = (rows) => rows.map((r) => {
    const imp = lido.get(String(r.pedido_row_id));
    return imp !== undefined && String(imp) !== String(r.import_id) ? { ...r, import_id: imp } : r;
  });
  return { itens: ajustar(itens), componentes: ajustar(componentes) };
}

module.exports = {
  itensComImportLido,
  ENV_NAME,
  ENV_CONTAS,
  TABELA,
  isReusoHabilitado,
  tabelaVinculosDisponivel,
  fontePedidosSql,
  fontePedidos,
  normalizarImportLido,
};
