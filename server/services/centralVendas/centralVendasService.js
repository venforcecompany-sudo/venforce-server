function getRepository() {
  return require("./centralVendasRepository");
}

const MESES = [
  "Janeiro", "Fevereiro", "Marco", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

function normalizeSlug(slug) {
  return String(slug || "").trim().toLowerCase();
}

function normalizeCompetencia(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}$/.test(text)) return text;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function periodoFromCompetencia(competencia) {
  const [yearText, monthText] = String(competencia).split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const lastDay = new Date(year, month, 0).getDate();
  return {
    competencia,
    inicio: `${competencia}-01`,
    fim: `${competencia}-${String(lastDay).padStart(2, "0")}`,
    label: `${MESES[month - 1] || monthText}/${year}`,
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round2(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function jsonValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (_) {
      return fallback;
    }
  }
  return value;
}

function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function normalizePedidoStatus(status) {
  const text = String(status || "").toLowerCase();
  if (/cancel|devolu|reembolso/.test(text)) return "cancelado";
  if (/problema|mediacao|media/.test(text)) return "com_problema";
  if (/pend/.test(text)) return "pendente";
  return "pago";
}

function rowValue(row, camel, snake) {
  return row?.[camel] ?? row?.[snake];
}

function componentValue(component) {
  return numberOrNull(rowValue(component, "valor", "valor"));
}

function sumComponents(components, tipo) {
  const values = components
    .filter((component) => rowValue(component, "tipo", "tipo") === tipo)
    .map(componentValue)
    .filter((value) => value !== null);
  if (!values.length) return null;
  return round2(values.reduce((sum, value) => sum + value, 0));
}

function confidenceToResultadoStatus(confianca) {
  if (confianca === "confiavel") return "real";
  if (confianca === "parcial") return "parcial";
  return "bloqueado";
}

function buildProdutos(itens) {
  const produtos = {};

  for (const item of itens || []) {
    const mlb = rowValue(item, "mlb", "mlb");
    if (!mlb || produtos[mlb]) continue;

    const quantidade = numberOrNull(rowValue(item, "quantidade", "quantidade"));
    const custoTotal = numberOrNull(rowValue(item, "custoProduto", "custo_produto"));
    const receitaProduto = numberOrNull(rowValue(item, "receitaProduto", "receita_produto"));
    const impostoInterno = numberOrNull(rowValue(item, "impostoInterno", "imposto_interno"));
    const custoUnitario =
      custoTotal !== null && quantidade && quantidade > 0
        ? round2(custoTotal / quantidade)
        : null;
    const impostoPercentual =
      impostoInterno !== null && receitaProduto && receitaProduto > 0
        ? round2((impostoInterno / receitaProduto) * 100)
        : null;

    produtos[mlb] = {
      mlb,
      sku: rowValue(item, "sku", "sku") || null,
      titulo: rowValue(item, "titulo", "titulo") || mlb,
      full: null,
      ads: { status: "ausente" },
      base: {
        temCusto: custoUnitario !== null,
        custo: custoUnitario,
        imposto: impostoPercentual,
        status: custoUnitario !== null ? "real" : "ausente",
      },
      diag: {
        presente: false,
        mc: null,
        status: "ausente",
      },
    };
  }

  return produtos;
}

function buildPedidoContrato(pedido, itens, componentes) {
  const pedidoId = rowValue(pedido, "pedidoId", "pedido_id");
  const pedidoItens = itens.filter((item) => rowValue(item, "pedidoId", "pedido_id") === pedidoId);
  const pedidoComponentes = componentes.filter(
    (component) => rowValue(component, "pedidoId", "pedido_id") === pedidoId
  );
  const firstItem = pedidoItens[0] || null;
  const confianca = rowValue(pedido, "confianca", "confianca");
  const frete = sumComponents(pedidoComponentes, "frete_seller");
  const taxas = sumComponents(pedidoComponentes, "tarifa_venda");
  const custo = sumComponents(pedidoComponentes, "custo_produto");
  const imposto = sumComponents(pedidoComponentes, "imposto_interno");

  return {
    id: pedidoId,
    pedidoId,
    data: toIsoDate(rowValue(pedido, "dataPedido", "data_pedido")),
    status: normalizePedidoStatus(rowValue(pedido, "status", "status")),
    mlb: firstItem ? rowValue(firstItem, "mlb", "mlb") || null : null,
    sku: firstItem ? rowValue(firstItem, "sku", "sku") || null : null,
    produto: firstItem
      ? {
          mlb: rowValue(firstItem, "mlb", "mlb") || null,
          sku: rowValue(firstItem, "sku", "sku") || null,
          titulo: rowValue(firstItem, "titulo", "titulo") || rowValue(firstItem, "mlb", "mlb") || null,
        }
      : { mlb: null, sku: null, titulo: "(linha financeira sem produto)" },
    unidades: numberOrNull(rowValue(pedido, "quantidadeItens", "quantidade_itens")),
    valor: numberOrNull(rowValue(pedido, "faturamento", "faturamento")),
    frete: frete === null ? null : Math.abs(frete),
    freteStatus: frete === null ? "ausente" : "real",
    taxas: taxas === null ? null : Math.abs(taxas),
    taxasStatus: taxas === null ? "ausente" : "real",
    custo: custo === null ? null : Math.abs(custo),
    custoStatus: custo === null ? "ausente" : "real",
    imposto: imposto === null ? null : Math.abs(imposto),
    resultado: numberOrNull(rowValue(pedido, "resultado", "resultado")),
    resultadoStatus: confidenceToResultadoStatus(confianca),
    confianca,
    pendencias: jsonValue(rowValue(pedido, "pendencias", "pendencias_json"), []),
    logistica: null,
    full: null,
    adsStatus: "ausente",
    itens: pedidoItens.map((item) => ({
      id: rowValue(item, "itemId", "item_id"),
      itemId: rowValue(item, "itemId", "item_id"),
      mlb: rowValue(item, "mlb", "mlb") || null,
      sku: rowValue(item, "sku", "sku") || null,
      titulo: rowValue(item, "titulo", "titulo") || null,
      quantidade: numberOrNull(rowValue(item, "quantidade", "quantidade")),
      valorUnitario: numberOrNull(rowValue(item, "valorUnitario", "valor_unitario")),
      receitaProduto: numberOrNull(rowValue(item, "receitaProduto", "receita_produto")),
      custoProduto: numberOrNull(rowValue(item, "custoProduto", "custo_produto")),
      impostoInterno: numberOrNull(rowValue(item, "impostoInterno", "imposto_interno")),
      resultado: numberOrNull(rowValue(item, "resultado", "resultado")),
      confianca: rowValue(item, "confianca", "confianca"),
      pendencias: jsonValue(rowValue(item, "pendencias", "pendencias_json"), []),
    })),
    componentes: pedidoComponentes.map((component) => ({
      tipo: rowValue(component, "tipo", "tipo"),
      valor: numberOrNull(rowValue(component, "valor", "valor")),
      fonte: rowValue(component, "fonte", "fonte") || null,
      confianca: rowValue(component, "confianca", "confianca"),
      obs: rowValue(component, "obs", "obs") || null,
      itemId: rowValue(component, "itemId", "item_id") || null,
    })),
  };
}

function buildEmptyPayload(cliente, competencia) {
  return {
    ok: true,
    fonte: "central_vendas_db",
    cliente,
    periodo: periodoFromCompetencia(competencia),
    motor: {
      status: "sem_dados",
      etapaAtual: "aguardando_importacao",
      progresso: 0,
      confianca: "ausente",
      podeConcluir: false,
      motivoBloqueio: "Nenhuma importacao encontrada para esta competencia.",
      geradoEm: null,
      origemPrincipal: "planilha_vendas",
    },
    adsPorProdutoDisponivel: false,
    adsMensal: { investimento: null, status: "ausente" },
    resumo: {
      pedidosTotal: 0,
      pedidosConfiaveis: 0,
      pedidosParciais: 0,
      pedidosBloqueados: 0,
      faturamento: 0,
      faturamentoComCusto: 0,
      receitaBloqueada: 0,
      lucroContribuicao: null,
      margemContribuicaoPercentual: null,
      totaisPorTipo: {},
    },
    produtos: {},
    pedidos: [],
  };
}

function buildPayloadFromSnapshot(cliente, competencia, snapshot) {
  if (!snapshot) return buildEmptyPayload(cliente, competencia);

  const resumo = jsonValue(snapshot.importacao.resumo_json, {});
  const pedidos = buildPedidos(snapshot);
  const geradoEm = snapshot.importacao.created_at || snapshot.importacao.createdAt || null;

  return {
    ok: true,
    fonte: "central_vendas_db",
    cliente,
    periodo: periodoFromCompetencia(competencia),
    motor: {
      status: "persistido",
      etapaAtual: "importacao_persistida",
      progresso: 100,
      confianca: resumo.confianca || snapshot.importacao.confianca || "parcial",
      podeConcluir: !pedidos.some((pedido) => pedido.confianca === "bloqueado"),
      motivoBloqueio: pedidos.some((pedido) => pedido.confianca === "bloqueado")
        ? "Ha pedidos bloqueados por custo/produto ausente."
        : null,
      geradoEm: geradoEm instanceof Date ? geradoEm.toISOString() : geradoEm,
      origemPrincipal: snapshot.importacao.fonte || "planilha_vendas",
      importId: snapshot.importacao.id,
    },
    adsPorProdutoDisponivel: false,
    adsMensal: { investimento: null, status: "ausente" },
    resumo,
    produtos: buildProdutos(snapshot.itens || []),
    pedidos,
  };
}

function buildPedidos(snapshot) {
  const itens = snapshot.itens || [];
  const componentes = snapshot.componentes || [];
  return (snapshot.pedidos || []).map((pedido) => buildPedidoContrato(pedido, itens, componentes));
}

function createCentralVendasService(repository = getRepository()) {
  async function getCentralVendas(clienteSlug, { competencia, marketplace = "meli" } = {}) {
    const slug = normalizeSlug(clienteSlug);
    const competenciaNorm = normalizeCompetencia(competencia);
    const marketplaceNorm = String(marketplace || "meli").trim().toLowerCase();

    if (!slug) {
      const err = new Error("slug e obrigatorio.");
      err.statusCode = 400;
      throw err;
    }

    const cliente = await repository.getClienteBySlug(slug);
    if (!cliente) {
      const err = new Error("Cliente nao encontrado.");
      err.statusCode = 404;
      throw err;
    }

    const snapshot = await repository.getLatestCentralVendasImport({
      clienteSlug: slug,
      competencia: competenciaNorm,
      marketplace: marketplaceNorm,
    });

    return buildPayloadFromSnapshot(cliente, competenciaNorm, snapshot);
  }

  return {
    getCentralVendas,
  };
}

module.exports = {
  getCentralVendas: (...args) => createCentralVendasService().getCentralVendas(...args),
  createCentralVendasService,
  buildPayloadFromSnapshot,
  periodoFromCompetencia,
};
