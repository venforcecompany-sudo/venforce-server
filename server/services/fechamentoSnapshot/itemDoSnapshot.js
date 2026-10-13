// server/services/fechamentoSnapshot/itemDoSnapshot.js
//
// Uma linha do motor (`detailedRows`) → um item de fechamento_snapshot_itens.
//
// A linha é gravada EXATA (`linha`); as colunas tipadas existem só para o
// backend paginar, filtrar e buscar sem trazer milhares de linhas. Nenhum
// número é recalculado: receita, LC e MC são os campos que a linha já traz.
//
// ESPELHO de frontend-react/src/utils/financeiro/produtos.js
// (normalizarLinhaProduto) — a MESMA leitura dos 3 formatos e dos dois eixos
// de status, para "Sem custo" no filtro do histórico ser exatamente o "Sem
// custo" da tela ao vivo. O servidor não importa o código do frontend (deploy
// separado); a paridade é provada por
// tests/fechamentoSnapshotItemParidade.test.js, que roda os dois sobre as
// mesmas linhas. Mudou um, mude o outro.

"use strict";

const texto = (v) => (v === null || v === undefined ? "" : String(v).trim());
const textoOuNull = (v) => texto(v) || null;

function numOuNull(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = typeof valor === "number" ? valor : Number(valor);
  return Number.isFinite(n) ? n : null;
}

function formatoDaLinha(row) {
  if (!row || typeof row !== "object") return "desconhecido";
  if ("ID do pedido" in row || "Match de custo" in row) return "shopee_orderall";
  if ("Vendas (Pedido pago) (BRL)" in row || "ID Model" in row) return "shopee_performance";
  if ("# de anúncio" in row || "Venda Total" in row) return "meli";
  return "desconhecido";
}

function saudeDaMargem(mcPontos) {
  if (mcPontos === null) return "sem_mc";
  if (mcPontos < 0) return "critico";
  if (mcPontos < 15) return "atencao";
  return "saudavel";
}

const CANCELADO_RE = /cancel|devolu|reembols/i;

function camposDaLinha(row, formato) {
  if (formato === "meli") {
    return {
      titulo: textoOuNull(row["Título do anúncio"]),
      itemId: textoOuNull(row["# de anúncio"]),
      sku: null,
      modelId: null,
      pedidoId: null,
      receita: numOuNull(row["Venda Total"]),
      custoUnitario: numOuNull(row["Preço de custo"]),
      custoTotal: numOuNull(row["Preço de custo total"]),
      lc: numOuNull(row.LC),
      mc: numOuNull(row.MC),
      statusPedido: null,
      matchDeCusto: null,
    };
  }
  if (formato === "shopee_performance") {
    return {
      titulo: textoOuNull(row.Produto),
      itemId: textoOuNull(row.ID),
      sku: null,
      modelId: textoOuNull(row["ID Model"]),
      pedidoId: null,
      receita: numOuNull(row["Vendas (Pedido pago) (BRL)"]),
      custoUnitario: numOuNull(row.Custo),
      custoTotal: null,
      lc: numOuNull(row["LC POR ANÚNCIO"] !== undefined ? row["LC POR ANÚNCIO"] : row.LC),
      mc: numOuNull(row.MC),
      statusPedido: null,
      matchDeCusto: null,
    };
  }
  if (formato === "shopee_orderall") {
    return {
      titulo: textoOuNull(row.Produto),
      itemId: textoOuNull(row["ID resolvido pela ponte"]),
      sku: textoOuNull(row.SKU),
      modelId: null,
      pedidoId: textoOuNull(row["ID do pedido"]),
      receita: numOuNull(row["Receita bruta"]),
      custoUnitario: null,
      custoTotal: numOuNull(row.CMV),
      lc: numOuNull(row.LC),
      mc: numOuNull(row.MC),
      statusPedido: textoOuNull(row["Status do pedido"]),
      matchDeCusto: textoOuNull(row["Match de custo"]),
    };
  }
  return {
    titulo: null, itemId: null, sku: null, modelId: null, pedidoId: null, receita: null,
    custoUnitario: null, custoTotal: null, lc: numOuNull(row?.LC), mc: numOuNull(row?.MC),
    statusPedido: null, matchDeCusto: null,
  };
}

// Mesma remoção de acento da busca da tela (filtrarLinhas).
function normalizarBusca(v) {
  return String(v || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

function itemDoSnapshot(row, ordem, { ambiguousIds = [] } = {}) {
  const formato = formatoDaLinha(row);
  const base = camposDaLinha(row, formato);
  const cobertura = texto(row?.["Cobertura de custo"]).toLowerCase();
  const ambiguos = ambiguousIds instanceof Set ? ambiguousIds : new Set((ambiguousIds || []).map((x) => String(x)));

  const statusFinanceiro = cobertura === "financeiro pendente" ? "pendente" : "ok";

  let statusCusto;
  if (cobertura === "custo ambíguo" || base.matchDeCusto === "ambiguous") statusCusto = "ambiguo";
  else if (cobertura === "sem custo") statusCusto = "sem_custo";
  else if (cobertura === "com custo") statusCusto = "ok";
  else if (cobertura === "financeiro pendente") {
    if (base.custoUnitario !== null) statusCusto = "ok";
    else statusCusto = base.itemId && ambiguos.has(base.itemId) ? "ambiguo" : "sem_custo";
  } else statusCusto = base.custoUnitario !== null || base.custoTotal !== null ? "ok" : "sem_custo";

  const cancelado = !!base.statusPedido && CANCELADO_RE.test(base.statusPedido);

  let statusPrincipal;
  if (statusFinanceiro === "pendente") statusPrincipal = "aguardando_financeiro";
  else if (statusCusto === "ambiguo") statusPrincipal = "custo_ambiguo";
  else if (statusCusto === "sem_custo") statusPrincipal = "sem_custo";
  else statusPrincipal = saudeDaMargem(base.mc);

  return {
    ordem,
    formato,
    titulo: base.titulo,
    item_id: base.itemId,
    model_id: base.modelId,
    sku: base.sku,
    pedido_id: base.pedidoId,
    receita: base.receita,
    lc: base.lc,
    mc: base.mc,
    status_custo: statusCusto,
    status_financeiro: statusFinanceiro,
    status_principal: statusPrincipal,
    cancelado,
    busca: [base.titulo, base.itemId, base.sku, base.modelId, base.pedidoId].map(normalizarBusca).filter(Boolean).join(" "),
    linha: row && typeof row === "object" ? row : { valor: row ?? null },
  };
}

const STATUS_PRINCIPAIS = ["saudavel", "atencao", "critico", "sem_mc", "sem_custo", "custo_ambiguo", "aguardando_financeiro"];

// Contagens derivadas na gravação (imutáveis com o snapshot).
//   pendencias       → PRODUTOS pendentes, com o MESMO agrupamento da tela
//                      (utils/financeiro/pendencias.js agruparPendencias:
//                      statusCusto + modelId||itemId||sku||titulo) — é o
//                      número que o operador vê como "N pendências";
//   linhasPendentes  → linhas cujo eixo de CUSTO não está ok.
function contarItens(itens) {
  const c = { total: 0, cancelados: 0, pendencias: 0, linhasPendentes: 0 };
  for (const s of STATUS_PRINCIPAIS) c[s] = 0;
  const grupos = new Set();
  for (const it of itens) {
    c.total += 1;
    c[it.status_principal] = (c[it.status_principal] || 0) + 1;
    if (it.cancelado) c.cancelados += 1;
    if (it.status_custo !== "ok") {
      c.linhasPendentes += 1;
      grupos.add(`${it.status_custo}|${it.model_id || it.item_id || it.sku || it.titulo || "—"}`);
    }
  }
  c.pendencias = grupos.size;
  return c;
}

module.exports = { itemDoSnapshot, contarItens, formatoDaLinha, normalizarBusca, STATUS_PRINCIPAIS };
