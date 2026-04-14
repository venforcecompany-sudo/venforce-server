const XLSX = require("xlsx");

function toText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function toNumber(value) {
  if (value === null || value === undefined || value === "" || value === "-") {
    return 0;
  }

  if (typeof value === "number") return value;

  const raw = String(value).trim();
  if (!raw) return 0;

  const normalized = raw
    .replace(/\s/g, "")
    .replace(/R\$/gi, "")
    .replace(/%/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((acc, n) => acc + n, 0) / values.length;
}

function buildKey(idItem, produto) {
  return `${idItem}__${produto}`;
}

function classifyCurve(current, previous) {
  if (current <= 80 || previous < 80) return "A";
  if (current <= 95 || previous < 95) return "B";
  return "C";
}

function normalizeHeader(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function getValueByPossibleHeaders(row, possibleHeaders) {
  const entries = Object.entries(row);
  const normalizedMap = new Map();

  for (const [key, value] of entries) {
    normalizedMap.set(normalizeHeader(key), value);
  }

  for (const header of possibleHeaders) {
    const found = normalizedMap.get(normalizeHeader(header));
    if (found !== undefined) return found;
  }

  return "";
}

function getBaseMetrics(buffer) {
  if (!buffer) {
    return { error: "Arquivo não enviado." };
  }

  const isBuffer = Buffer.isBuffer(buffer);
  if (!isBuffer) {
    return { error: "Arquivo inválido." };
  }

  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = "Produtos com Melhor Desempenho";
  const worksheet = workbook.Sheets[sheetName];

  if (!worksheet) {
    return { error: 'Não encontrei a aba "Produtos com Melhor Desempenho".' };
  }

  const rows = XLSX.utils.sheet_to_json(worksheet, {
    defval: "",
  });

  if (!rows.length) {
    return { error: "A planilha está vazia." };
  }

  const sourceRows = rows
    .map((row) => {
      const idVariacao = toText(
        getValueByPossibleHeaders(row, ["ID da Variação", "ID da Variacao"])
      );

      return {
        idItem: toText(getValueByPossibleHeaders(row, ["ID do Item"])),
        produto: toText(getValueByPossibleHeaders(row, ["Produto"])),
        vendasPago: toNumber(
          getValueByPossibleHeaders(row, [
            "Vendas (Pedido pago) (BRL)",
            "Vendas (pedido pago) (BRL)",
          ])
        ),
        impressoes: toNumber(
          getValueByPossibleHeaders(row, ["Impressão do Produto", "Impressao do Produto"])
        ),
        cliques: toNumber(
          getValueByPossibleHeaders(row, ["Cliques Por Produto", "Cliques por Produto"])
        ),
        ctr: toNumber(getValueByPossibleHeaders(row, ["CTR"])) / 100,
        conversaoPedidoPago:
          toNumber(
            getValueByPossibleHeaders(row, [
              "Taxa de Conversão de Pedido (Pedido Pago)",
              "Taxa de Conversao de Pedido (Pedido Pago)",
              "Taxa de Conversão de Pedido (Pedido pago)",
              "Taxa de Conversao de Pedido (Pedido pago)",
            ])
          ) / 100,
        pedidosPago: toNumber(
          getValueByPossibleHeaders(row, [
            "Produto Pago",
            "Produto pago",
            "Produtos pagos",
            "Produtos pago",
            "Compradores (Pedidos pago)",
            "Compradores (Pedidos pagos)",
          ])
        ),
        unidadesPago: toNumber(
          getValueByPossibleHeaders(row, [
            "Unidades (Pedido pago)",
            "Unidades (pedido pago)",
          ])
        ),
        idVariacao,
        skuVariacao: toText(
          getValueByPossibleHeaders(row, ["SKU da Variação", "SKU da Variacao"])
        ),
        skuPrincipal: toText(
          getValueByPossibleHeaders(row, ["SKU Principle", "SKU Principal"])
        ),
        isPrincipal: idVariacao === "" || idVariacao === "-",
      };
    })
    .filter((row) => row.idItem || row.produto);

  if (!sourceRows.length) {
    return { error: "Não encontrei linhas válidas na planilha." };
  }

  // AGRUPA POR ITEM
  const groupedSource = new Map();

  for (const row of sourceRows) {
    const key = buildKey(row.idItem, row.produto);
    if (!groupedSource.has(key)) {
      groupedSource.set(key, []);
    }
    groupedSource.get(key).push(row);
  }

  const baseMetrics = [];

  for (const [, itemRows] of groupedSource.entries()) {
    const principal = itemRows.find((r) => r.isPrincipal) ?? itemRows[0];

    const variationRows = itemRows.filter((r) => !r.isPrincipal);

    const hasVariations = variationRows.length > 0;

    // REGRA CORRETA:
    // - se tem variação: usa SOMENTE variações para faturamento/unidades/pedidos
    // - se não tem: usa a principal
    const rowsForSales = hasVariations ? variationRows : [principal];

    const faturamento = rowsForSales.reduce((acc, row) => acc + row.vendasPago, 0);

    const unidades = rowsForSales.reduce((acc, row) => acc + row.unidadesPago, 0);

    const pedidosSomadosNasLinhasDeVenda = rowsForSales.reduce(
      (acc, row) => acc + row.pedidosPago,
      0
    );

    const pedidosPrincipal = principal.pedidosPago || 0;

    const pedidosMaiorValorDoGrupo = Math.max(...itemRows.map((row) => row.pedidosPago || 0));

    const pedidos =
      pedidosSomadosNasLinhasDeVenda > 0
        ? pedidosSomadosNasLinhasDeVenda
        : pedidosPrincipal > 0
          ? pedidosPrincipal
          : pedidosMaiorValorDoGrupo;

    baseMetrics.push({
      idItem: principal.idItem,
      produto: principal.produto,
      faturamento,
      unidades,
      pedidos,
      impressoes: principal.impressoes,
      cliques: principal.cliques,
      ctr: principal.ctr,
      conversao: principal.conversaoPedidoPago,
      skuReferencia: principal.skuPrincipal || principal.skuVariacao || "",
    });
  }

  return { baseMetrics };
}

function buildResultadoFromBaseMetrics(baseMetrics) {
  const faturamentoTotal = baseMetrics.reduce((acc, row) => acc + row.faturamento, 0);
  const unidadesTotais = baseMetrics.reduce((acc, row) => acc + row.unidades, 0);
  const pedidosTotais = baseMetrics.reduce((acc, row) => acc + row.pedidos, 0);

  const revenueSorted = [...baseMetrics].sort((a, b) => {
    if (b.faturamento !== a.faturamento) return b.faturamento - a.faturamento;
    return a.produto.localeCompare(b.produto, "pt-BR");
  });

  const revenueMap = new Map();

  let runningRevenue = 0;
  let previousRevenueCum = 0;

  for (const row of revenueSorted) {
    const percentualFaturamento = faturamentoTotal > 0 ? row.faturamento / faturamentoTotal : 0;
    runningRevenue += percentualFaturamento;
    const acumuladoFaturamento = runningRevenue;
    const curvaFat = classifyCurve(acumuladoFaturamento * 100, previousRevenueCum * 100);

    revenueMap.set(buildKey(row.idItem, row.produto), {
      percentualFaturamento,
      acumuladoFaturamento,
      curvaFat,
    });

    previousRevenueCum = acumuladoFaturamento;
  }

  const unitsSorted = [...baseMetrics].sort((a, b) => {
    if (b.unidades !== a.unidades) return b.unidades - a.unidades;
    return a.produto.localeCompare(b.produto, "pt-BR");
  });

  const unitsMap = new Map();

  let runningUnits = 0;
  let previousUnitsCum = 0;

  for (const row of unitsSorted) {
    const percentualUnidades = unidadesTotais > 0 ? row.unidades / unidadesTotais : 0;
    runningUnits += percentualUnidades;
    const acumuladoUnidades = runningUnits;
    const curvaUni = classifyCurve(acumuladoUnidades * 100, previousUnitsCum * 100);

    unitsMap.set(buildKey(row.idItem, row.produto), {
      percentualUnidades,
      acumuladoUnidades,
      curvaUni,
    });

    previousUnitsCum = acumuladoUnidades;
  }

  const mediaImpressoes = avg(baseMetrics.map((r) => r.impressoes));
  const mediaCliques = avg(baseMetrics.map((r) => r.cliques));
  const mediaCTR = avg(baseMetrics.filter((r) => r.ctr > 0).map((r) => r.ctr));
  const mediaConversao = avg(baseMetrics.filter((r) => r.conversao > 0).map((r) => r.conversao));

  const curvaAbcCompleta = baseMetrics
    .map((row) => {
      const key = buildKey(row.idItem, row.produto);
      const revenue = revenueMap.get(key);
      const units = unitsMap.get(key);

      return {
        id: row.idItem,
        produto: row.produto,
        faturamento: row.faturamento,
        unidades: row.unidades,
        percentualFaturamento: revenue.percentualFaturamento,
        acumuladoFaturamento: revenue.acumuladoFaturamento,
        percentualUnidades: units.percentualUnidades,
        acumuladoUnidades: units.acumuladoUnidades,
        curvaFat: revenue.curvaFat,
        curvaUni: units.curvaUni,
        curvaFinal: `${revenue.curvaFat}${units.curvaUni}`,
      };
    })
    .sort((a, b) => b.faturamento - a.faturamento);

  const produtosMaisImpressoes = [...baseMetrics]
    .sort((a, b) => b.impressoes - a.impressoes)
    .slice(0, 30)
    .map((row) => ({
      id: row.idItem,
      produto: row.produto,
      valor: row.impressoes,
    }));

  const produtosMaisCliques = [...baseMetrics]
    .sort((a, b) => b.cliques - a.cliques)
    .slice(0, 30)
    .map((row) => ({
      id: row.idItem,
      produto: row.produto,
      valor: row.cliques,
    }));

  const produtosMaiorCtr = [...baseMetrics]
    .sort((a, b) => b.ctr - a.ctr)
    .slice(0, 30)
    .map((row) => ({
      id: row.idItem,
      produto: row.produto,
      valor: row.ctr,
    }));

  const produtosMaiorConversao = [...baseMetrics]
    .sort((a, b) => b.conversao - a.conversao)
    .slice(0, 30)
    .map((row) => ({
      id: row.idItem,
      produto: row.produto,
      valor: row.conversao,
    }));

  const sugestaoKits = [...baseMetrics]
    .map((row) => {
      const pedidosPagos = row.pedidos > 0 ? row.pedidos : 0;
      const unidadesPagas = row.unidades > 0 ? row.unidades : 0;
      const unidadesPorPedido = pedidosPagos > 0 ? unidadesPagas / pedidosPagos : 0;

      return {
        id: row.idItem,
        produto: row.produto,
        pedidosPagos,
        unidadesPagas,
        unidadesPorPedido,
      };
    })
    .filter((row) => row.pedidosPagos > 0 && row.unidadesPorPedido > 1.2)
    .sort((a, b) => b.unidadesPorPedido - a.unidadesPorPedido)
    .slice(0, 50);

  const allAdsRows = baseMetrics.map((row) => {
    const aboveCount = [
      row.impressoes >= mediaImpressoes,
      row.cliques >= mediaCliques,
      row.ctr >= mediaCTR,
      row.conversao >= mediaConversao,
    ].filter(Boolean).length;

    return {
      id: row.idItem,
      produto: row.produto,
      cliques: row.cliques,
      ctr: row.ctr,
      conversao: row.conversao,
      aboveCount,
      motivo:
        row.conversao > mediaConversao
          ? "Conversão acima da média"
          : row.ctr > mediaCTR
            ? "CTR acima da média"
            : "Produto com sinais positivos para teste",
    };
  });

  const adsObrigatorios = allAdsRows
    .filter((row) => row.aboveCount === 4)
    .sort((a, b) => b.conversao - a.conversao)
    .slice(0, 50)
    .map(({ aboveCount, ...row }) => row);

  const adsPrioridade34 = allAdsRows
    .filter((row) => row.aboveCount === 3)
    .sort((a, b) => b.conversao - a.conversao)
    .slice(0, 50)
    .map(({ aboveCount, ...row }) => row);

  const adsPrioridade24 = allAdsRows
    .filter((row) => row.aboveCount === 2)
    .sort((a, b) => b.conversao - a.conversao)
    .slice(0, 50)
    .map(({ aboveCount, ...row }) => row);

  return {
    resumo: {
      faturamentoTotal,
      unidadesTotais,
      pedidosTotais,
      produtosConsiderados: baseMetrics.length,
    },
    curvaAbcCompleta,
    produtosMaisImpressoes,
    produtosMaisCliques,
    produtosMaiorCtr,
    produtosMaiorConversao,
    sugestaoKits,
    adsObrigatorios,
    adsPrioridade34,
    adsPrioridade24,
  };
}

function processarFechamento(buffer) {
  try {
    const baseMetricsResult = getBaseMetrics(buffer);
    if (baseMetricsResult.error) return baseMetricsResult;

    return buildResultadoFromBaseMetrics(baseMetricsResult.baseMetrics);
  } catch (error) {
    console.error("ERRO NA API:", error);
    return {
      error: error instanceof Error ? error.message : "Erro ao processar a planilha.",
    };
  }
}

function compilarFechamentos(buffers) {
  if (!Array.isArray(buffers)) {
    throw new Error("Lista de arquivos inválida.");
  }

  const combinedBaseMetrics = [];

  for (let i = 0; i < buffers.length; i++) {
    const buffer = buffers[i];

    const resultado = processarFechamento(buffer);
    if (resultado && resultado.error) continue;

    const baseMetricsResult = getBaseMetrics(buffer);
    if (baseMetricsResult.error) continue;

    combinedBaseMetrics.push(...baseMetricsResult.baseMetrics);
  }

  if (!combinedBaseMetrics.length) {
    return { error: "Nenhum fechamento válido para compilar." };
  }

  return buildResultadoFromBaseMetrics(combinedBaseMetrics);
}

module.exports = { processarFechamento, compilarFechamentos };
