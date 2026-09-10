// server/controllers/fechamentosFinanceiroController.js
// Controller da rota /fechamentos/financeiro.
// Extraído de server/index.js sem alterar comportamento.

const XLSX = require("xlsx");

const { parseMoneyValue } = require("../utils/numberUtils");
const {
  parseSpreadsheet,
  detectMeliHeader,
  detectShopeeHeaderRow,
  validateMeliHeaderAtRow,
} = require("../utils/excelUtils");
const {
  buildMeliBaseSheetRows,
} = require("../services/fechamentoFinanceiro/meliFinanceiroService");
const {
  processFechamentoFinanceiro,
} = require("../services/fechamentoFinanceiro");
const {
  buildCostRowsFromBase,
} = require("../services/bases/baseCustosService");
const {
  listarClientesAtivosFinanceiro,
} = require("../services/fechamentoFinanceiro/clientesFinanceiroService");
const {
  resolverClientePorIdOuSlug,
  obterConta,
} = require("../services/clienteContas/clienteContaService");
const { CODIGOS_CANONICOS } = require("../utils/erroContextoCanonico");
const { detectarIncidenteFechamento } = require("../services/fechamentoFinanceiro/incidente/detectarIncidenteFechamento");
const fechamentoIncidentStorageService = require("../services/fechamentoFinanceiro/incidente/fechamentoIncidentStorageService");
const { createDebugCollector } = require("../utils/fechamento/debugCollector");

// V3 Pós-Convergência #2 — BLOCO 8: quando o processamento se declara
// account-aware (clienteContaId informado), o backend PROVA cliente + conta +
// que a conta pertence a esse cliente e está ativa. Nunca aceita silenciosamente
// uma conta de outro cliente / conta primária / primeira conta / fallback.
async function validarContaDoCliente({ clienteSlug, clienteContaId }) {
  if (clienteContaId == null) return null; // fluxo client-level / legado: ok
  if (!clienteSlug) {
    const e = new Error("Para processar um fechamento por conta (clienteContaId), informe também cliente_slug.");
    e.statusCode = 400;
    throw e;
  }
  const cliente = await resolverClientePorIdOuSlug({ clienteSlug });
  const conta = await obterConta(clienteContaId);
  if (Number(conta.cliente_id) !== Number(cliente.id)) {
    const e = new Error("Esta conta não pertence ao cliente informado.");
    e.statusCode = 409;
    e.code = CODIGOS_CANONICOS.CONTA_NAO_PERTENCE_AO_CLIENTE;
    throw e;
  }
  if (conta.ativo === false) {
    const e = new Error(`A conta "${conta.nome}" foi desativada.`);
    e.statusCode = 409;
    e.code = CODIGOS_CANONICOS.CONTA_INATIVA;
    throw e;
  }
  return { clienteId: cliente.id, clienteContaId: Number(clienteContaId) };
}

const CALCULATION_MODE_LABEL = {
  real_financial: "Fechamento por dados financeiros (repasse e taxas reais)",
  estimated_performance: "Estimativa por performance (tarifas por faixa de ticket)",
  real_meli_vendas: "Fechamento pela planilha de vendas do Mercado Livre",
  real_tiktok_income: "Fechamento financeiro realizado do TikTok Shop",
};

const CONFIDENCE_LABEL = {
  confiavel: "Confiável — 100% da receita com custo identificado",
  parcial: "Parcial — existem vendas sem custo cadastrado",
  insuficiente: "Insuficiente — nenhuma receita com custo identificado",
};

// V3 P2.6 D2 - declaracao da competencia efetivamente processada.
const { detectarCompetenciaDeLinhas, compararCompetencias } = require("../utils/competenciaDetectada");

async function listarClientesFinanceiroController(req, res) {
  try {
    // V3 P2.7 BLOCO L — req.user passa a ser obrigatorio: a lista e a carteira
    // do usuario, nao a base inteira.
    const clientes = await listarClientesAtivosFinanceiro(req.user);
    return res.json({ ok: true, clientes });
  } catch (error) {
    console.error("Erro em GET /fechamentos/financeiro/clientes:", error);
    return res.status(500).json({
      ok: false,
      erro: "Erro ao listar clientes do Fechamento.",
    });
  }
}

// null/undefined viram vazio (ausência), nunca 0 falso.
function formatSummaryValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return Number.isFinite(value) ? Number(value.toFixed(6)) : "";
  }
  if (Array.isArray(value)) return value.map((item) => String(item)).join(" | ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function buildFechamentoContextRows(summary, marketplace) {
  const s = summary || {};
  const mode = String(s.calculationMode || "");
  const confidence = String(s.financialConfidence || "");

  const rows = [
    { Item: "Marketplace", Valor: marketplace },
    { Item: "Modo de cálculo", Valor: CALCULATION_MODE_LABEL[mode] || mode || "—" },
    { Item: "Status de confiança", Valor: CONFIDENCE_LABEL[confidence] || confidence || "—" },
    { Item: "Receita bruta total", Valor: formatSummaryValue(s.grossRevenueTotal) },
    { Item: "Receita com custo", Valor: formatSummaryValue(s.revenueWithCost) },
    { Item: "Receita sem custo", Valor: formatSummaryValue(s.revenueWithoutCost) },
    { Item: "Cobertura da base (%)", Valor: formatSummaryValue(s.calculatedCoveragePercent) },
    // Eixo financeiro: tarifas e repasse ainda não publicados pelo ML.
    { Item: "Faturamento com financeiro disponível", Valor: formatSummaryValue(s.revenueWithFinancialData) },
    { Item: "Faturamento com financeiro pendente", Valor: formatSummaryValue(s.revenuePendingFinancial) },
    { Item: "Cobertura financeira (%)", Valor: formatSummaryValue(s.financialDataCoveragePercent) },
    { Item: "Vendas aguardando financeiro", Valor: formatSummaryValue(s.salesPendingFinancialCount) },
    { Item: "LC calculado", Valor: formatSummaryValue(s.contributionProfitTotal) },
    { Item: "MC calculada", Valor: formatSummaryValue(s.contributionMarginCalculated) },
    { Item: "Resultado Final calculado", Valor: formatSummaryValue(s.finalResult) },
    { Item: "MC Final calculada", Valor: formatSummaryValue(s.finalMarginCalculated) },
    { Item: "TACoS", Valor: formatSummaryValue(s.tacos) },
    { Item: "TACoX", Valor: formatSummaryValue(s.tacox) },
  ];

  // Componentes financeiros: real quando veio da planilha, estimado no motor
  // de performance, vazio quando a coluna não existe.
  const componentes = [
    ["Taxas do marketplace", s.marketplaceFeesTotal],
    ["Frete", s.shippingFeesTotal],
    ["Imposto", s.taxValueTotal],
    ["CMV", s.cmvTotal],
    ["Descontos / bônus", s.discountsBonusesTotal],
  ];

  for (const [label, value] of componentes) {
    rows.push({
      Item: `Componente: ${label}`,
      Valor: formatSummaryValue(value),
      Origem:
        value === null || value === undefined
          ? "ausente na planilha"
          : mode === "estimated_performance"
            ? "estimado"
            : "real",
    });
  }

  // Bloco exclusivo do TikTok Shop: repasse e componentes do relatório
  // financeiro (leitura — não são reaplicados sobre o repasse) + Onhold.
  if (mode === "real_tiktok_income") {
    const tiktokRows = [
      ["Repasse total (valor liquidado)", s.paidRevenueTotal],
      ["Vendas líquidas dos produtos", s.productNetSalesTotal],
      ["Receita com LC calculado (base das margens)", s.revenueWithCalculatedProfit],
      ["Linhas com quantidade inválida", s.rowsWithInvalidQuantity],
      ["Linhas com possível duplicidade", s.possibleDuplicateRowsCount],
      // Reembolso total: venda preservada no faturamento, fora do lucro.
      ["Pedidos totalmente reembolsados", s.fullyRefundedCount],
      ["Faturamento original totalmente reembolsado", s.fullyRefundedGrossRevenue],
      ["Valor total reembolsado", s.fullyRefundedAmount],
      ["Componente TikTok: comissão da plataforma", s.platformCommissionTotal],
      ["Componente TikTok: taxas de serviço", s.serviceFeesTotal],
      ["Componente TikTok: frete líquido", s.shippingFeesTotal],
      ["Componente TikTok: comissões de afiliados (relatório)", s.affiliateFeesReportTotal],
      ["Componente TikTok: descontos do vendedor", s.sellerDiscountsTotal],
      ["Componente TikTok: reembolsos", s.refundsTotal],
      ["Componente TikTok: impostos cobrados pelo TikTok", s.tiktokTaxesTotal],
      ["Componente TikTok: ajustes", s.adjustmentsTotal],
      ["Linhas em aberto (Onhold)", s.onholdCount],
      ["Valor em aberto (Onhold)", s.onholdRevenueTotal],
    ];
    for (const [label, value] of tiktokRows) {
      rows.push({ Item: label, Valor: formatSummaryValue(value) });
    }
    rows.push({
      Item: "Observação",
      Valor:
        "Comissões, taxas de serviço, frete, afiliados, descontos e reembolsos já estão " +
        "descontados no repasse do TikTok — aparecem aqui apenas como leitura.",
    });
  }

  if (Array.isArray(s.missingColumns) && s.missingColumns.length > 0) {
    rows.push({ Item: "Colunas ausentes / indeterminadas", Valor: s.missingColumns.join(" | ") });
  }
  if (Array.isArray(s.detectedAdjustmentColumns) && s.detectedAdjustmentColumns.length > 0) {
    rows.push({
      Item: "Colunas de cupom/rebate detectadas (não reaplicadas)",
      Valor: s.detectedAdjustmentColumns.join(" | "),
    });
  }
  for (const note of Array.isArray(s.executiveNotes) ? s.executiveNotes : []) {
    rows.push({ Item: "Observação", Valor: String(note) });
  }

  return rows;
}

function parseFinancialInput(body, field, label) {
  const parsed = parseMoneyValue(body?.[field]);
  if (parsed.valid) return parsed.value;

  const error = new Error(
    `${label}: formato monetário inválido ou ambíguo. ` +
    "Use, por exemplo, 3011, 3011.00 ou 3.011,00."
  );
  error.statusCode = 400;
  throw error;
}

async function processarFechamentoFinanceiroController(req, res) {
  let meliHeaderDiagnostic = null;

  // Capturados fora do try: precisam estar disponíveis também no catch, para
  // a caixa-preta do fechamento (missão "captura automática de incidente")
  // conseguir preservar os arquivos mesmo quando o processamento lança
  // exceção. Nunca alteram o comportamento existente do fluxo normal.
  const salesFileEarly = req.files && req.files["sales"] && req.files["sales"][0];
  const costsFileEarly = req.files && req.files["costs"] && req.files["costs"][0];
  const ordersAllFileEarly = req.files?.ordersAll?.[0];
  const onholdFileEarly = req.files?.onhold?.[0];
  const marketplaceEarly = String(req.body?.marketplace || "").trim().toLowerCase();
  const incidentContext = {
    clienteSlug: req.body?.cliente_slug || req.body?.clienteSlug || null,
    clienteContaId: /^\d+$/.test(String(req.body?.clienteContaId || "")) ? Number(req.body.clienteContaId) : null,
    marketplace: marketplaceEarly,
    periodo: req.body?.periodo || null,
    usuarioId: req.user?.id ?? null,
  };
  const incidentFiles = [
    salesFileEarly && { tipoArquivo: "sales", originalName: salesFileEarly.originalname, mimeType: salesFileEarly.mimetype, buffer: salesFileEarly.buffer },
    costsFileEarly && { tipoArquivo: "costs", originalName: costsFileEarly.originalname, mimeType: costsFileEarly.mimetype, buffer: costsFileEarly.buffer },
    ordersAllFileEarly && { tipoArquivo: "ordersAll", originalName: ordersAllFileEarly.originalname, mimeType: ordersAllFileEarly.mimetype, buffer: ordersAllFileEarly.buffer },
    onholdFileEarly && { tipoArquivo: "onhold", originalName: onholdFileEarly.originalname, mimeType: onholdFileEarly.mimetype, buffer: onholdFileEarly.buffer },
  ].filter(Boolean);

  // debugCollector: mesma instrumentação opcional do Debug Financeiro
  // (utils/fechamento/debugCollector.js). Passá-lo sempre para MELI/Shopee
  // não muda nenhum valor calculado (todo ponto de instrumentação nesses
  // motores é `if (debugCollector) {...}`) — só habilita o snapshot para o
  // caso de precisarmos anexar a um incidente. TikTok ainda não é
  // instrumentado (mesma limitação do Debug Financeiro v1).
  const debugCollector = (marketplaceEarly === "meli" || marketplaceEarly === "shopee") ? createDebugCollector() : null;

  try {
    const salesFile = req.files && req.files["sales"] && req.files["sales"][0];
    const costsFile = req.files && req.files["costs"] && req.files["costs"][0];

    const marketplace = String(req.body.marketplace || "")
      .trim()
      .toLowerCase();

    const ads = parseFinancialInput(req.body, "ads", "ADS");
    const venforce = parseFinancialInput(req.body, "venforce", "Venforce");
    const affiliates = parseFinancialInput(req.body, "affiliates", "Afiliados");
    // Opcionais, só Mercado Livre. Campo vazio/ausente vale zero.
    const fullCost = parseFinancialInput(req.body, "fullCost", "FULL");
    const additionalCosts = parseFinancialInput(req.body, "additionalCosts", "Custos adicionais");

    // Origem alternativa dos custos: base vinculada ao cliente (sem upload).
    const costsBaseId = req.body.costsBaseId || req.body.baseId || null;
    const clienteSlug = req.body.cliente_slug || req.body.clienteSlug || null;
    const clienteContaIdRaw = req.body.clienteContaId;
    const clienteContaId = /^\d+$/.test(String(clienteContaIdRaw || "")) ? Number(clienteContaIdRaw) : null;

    if (!salesFile || !salesFile.buffer) {
      return res.status(400).json({ ok: false, error: "Arquivo de vendas não enviado." });
    }

    if (marketplace !== "meli" && marketplace !== "shopee" && marketplace !== "tiktok") {
      return res.status(400).json({ ok: false, error: "Marketplace inválido. Envie exatamente 'meli', 'shopee' ou 'tiktok'." });
    }

    // BLOCO 8 — se o request se declara account-aware, a conta tem que ser
    // provada (pertence ao cliente + ativa). Erro canônico, nunca fallback.
    await validarContaDoCliente({ clienteSlug, clienteContaId });

    // TikTok Shop: os custos vêm SEMPRE de uma Base TikTok escolhida
    // manualmente — não existe planilha de custos nem vínculo automático por
    // cliente para esse marketplace (a Base TikTok não exige cliente).
    if (marketplace === "tiktok" && !costsBaseId) {
      return res.status(400).json({
        ok: false,
        error: "Selecione uma Base TikTok antes de processar o fechamento.",
      });
    }

    // Resolve a origem dos custos: arquivo enviado OU base vinculada
    // (MELI quando existir vínculo; TikTok sempre).
    const podeUsarBaseVinculada =
      (marketplace === "meli" && (costsBaseId || clienteSlug)) ||
      marketplace === "tiktok";

    if ((!costsFile || !costsFile.buffer) && !podeUsarBaseVinculada) {
      return res.status(400).json({ ok: false, error: "Arquivo de custos não enviado." });
    }

    const salesBuffer = salesFile.buffer;
    const ordersAllFile = req.files?.ordersAll?.[0];
    // Onhold: opcional e exclusivo do TikTok Shop.
    const onholdFile = req.files?.onhold?.[0];

    // Cabeçalho detectado automaticamente: a exportação do ML nem sempre põe
    // o cabeçalho na linha 6.
    let salesRowsRaw;
    if (marketplace === "tiktok") {
      // O TikTok não passa por parseSpreadsheet: o parser próprio precisa do
      // buffer para saber se a célula do ID era texto ou número.
      salesRowsRaw = null;
    } else if (marketplace === "meli") {
      const detectedHeader = detectMeliHeader(salesBuffer);
      const validatedHeader = validateMeliHeaderAtRow(
        salesBuffer,
        detectedHeader.rowIndex
      );
      meliHeaderDiagnostic = {
        detectedHeaders: validatedHeader.headers,
        headerRow: detectedHeader.rowIndex + 1,
        relativeHeaderRowIndex: detectedHeader.relativeRowIndex,
        absoluteHeaderRowIndex: detectedHeader.rowIndex,
        headerRecognized: detectedHeader.found && validatedHeader.valid,
      };
      if (detectedHeader.found && !validatedHeader.valid) {
        const error = new Error(
          "Não foi possível reconhecer as vendas desta planilha do Mercado Livre. " +
          "Verifique o formato ou os cabeçalhos."
        );
        error.statusCode = 422;
        throw error;
      }
      salesRowsRaw = parseSpreadsheet(salesBuffer, detectedHeader.rowIndex);
    } else {
      salesRowsRaw = parseSpreadsheet(salesBuffer, detectShopeeHeaderRow(salesBuffer));
    }

    let costRowsRaw;
    let costsSource = "upload";
    let costsBase = null;
    if (costsFile && costsFile.buffer && marketplace !== "tiktok") {
      costRowsRaw = parseSpreadsheet(costsFile.buffer);
    } else {
      // Base vinculada: monta as linhas de custo a partir do banco, no formato
      // que o parser do marketplace entende (MELI ou TikTok).
      const resolved = await buildCostRowsFromBase({
        baseId: costsBaseId,
        clienteSlug,
        marketplace,
        clienteContaId,
      });
      costRowsRaw = resolved.costRows;
      costsSource = "base";
      costsBase = resolved.base;
    }

    let ordersAllRowsRaw = null;
    if (ordersAllFile && marketplace === "shopee") {
      try {
        // Mesma detecção de cabeçalho do arquivo principal: este upload deixou
        // de ser só reconciliação de status — com a performance no campo de
        // vendas, é ele que vira a fonte financeira real.
        ordersAllRowsRaw = parseSpreadsheet(
          ordersAllFile.buffer,
          detectShopeeHeaderRow(ordersAllFile.buffer)
        );
      } catch (e) {
        // Se o parse falhar, ignora silenciosamente — é opcional.
        ordersAllRowsRaw = null;
      }
    }

    const result = processFechamentoFinanceiro({
      marketplace,
      salesRowsRaw,
      costRowsRaw,
      ads,
      venforce,
      affiliates,
      fullCost,
      additionalCosts,
      ordersAllRowsRaw,
      // TikTok: buffers crus (Income obrigatório, Onhold opcional).
      salesBufferRaw: marketplace === "tiktok" ? salesBuffer : null,
      onholdBufferRaw:
        marketplace === "tiktok" && onholdFile?.buffer ? onholdFile.buffer : null,
      debugCollector,
    });

    if (marketplace === "meli") {
      const diagnostic = result.parsingDiagnostics || {};
      console.info("[fechamento-meli] parsing", {
        headerRow: meliHeaderDiagnostic?.headerRow,
        headerRecognized: meliHeaderDiagnostic?.headerRecognized,
        totalRowsRead: diagnostic.totalRowsRead,
        rowsWithSaleNumber: diagnostic.rowsWithSaleNumber,
        rowsWithAd: diagnostic.rowsWithAd,
        rowsWithUnits: diagnostic.rowsWithUnits,
        recognizedRows: diagnostic.recognizedRowsCount,
        recognizedSales: diagnostic.recognizedSalesCount,
        financialRows: diagnostic.financialRowsCount,
        revenueFound: diagnostic.revenueFound,
      });
    }

    const workbook = XLSX.utils.book_new();

    if (marketplace === "meli" && result.preparedRows && result.preparedRows.length > 0) {
      const baseSheet = buildMeliBaseSheetRows(result.preparedRows);
      XLSX.utils.book_append_sheet(workbook, baseSheet, "Base_MeLi");
    } else {
      const summaryRows = Object.entries(result.summary).map(([key, value]) => ({
        Métrica: key,
        Valor: formatSummaryValue(value),
      }));

      const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
      const detailSheet = XLSX.utils.json_to_sheet(result.detailedRows);

      XLSX.utils.book_append_sheet(workbook, summarySheet, "Painel");
      XLSX.utils.book_append_sheet(workbook, detailSheet, "Detalhamento");
    }

    // Aba de contexto do fechamento: modo de cálculo, confiança e cobertura.
    const contextSheet = XLSX.utils.json_to_sheet(
      buildFechamentoContextRows(result.summary, marketplace)
    );
    XLSX.utils.book_append_sheet(workbook, contextSheet, "Fechamento");

    if (result.auditRows && result.auditRows.length > 0) {
      const auditSheet = XLSX.utils.json_to_sheet(result.auditRows);
      XLSX.utils.book_append_sheet(workbook, auditSheet, "Auditoria");
    }

    // Onhold do TikTok: aba própria. Valores em aberto ficam separados do
    // resultado realizado, nunca somados a ele.
    if (marketplace === "tiktok" && Array.isArray(result.pendingRows) && result.pendingRows.length > 0) {
      const pendingSheet = XLSX.utils.json_to_sheet(result.pendingRows);
      XLSX.utils.book_append_sheet(workbook, pendingSheet, "Em_aberto_TikTok");
    }

    const excelBuffer = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    });

    const excelBase64 = Buffer.from(excelBuffer).toString("base64");

    // V3 P2.6 D2 — o endpoint NAO infere competencia (o recorte e o conteudo da
    // planilha) e nao vai passar a inferir. O que ele passa a fazer e DECLARAR
    // o que encontrou, para o Financeiro V3 — que tem seletor de competencia no
    // cabecalho — poder confrontar com o que esta em tela e avisar ANTES de
    // salvar. Processar Julho achando que processou Agosto e publicar isso para
    // o cliente e dinheiro.
    //
    // Aditivo e nao-bloqueante: `periodo` no request e OPCIONAL e nada e
    // rejeitado por divergencia. Sem coluna de data reconhecivel,
    // periodoDetectado e null — "nao deu para determinar", nunca "mes atual".
    const competencia = compararCompetencias({
      periodoSolicitado: req.body?.periodo,
      deteccao: detectarCompetenciaDeLinhas(salesRowsRaw),
    });

    // Caixa-preta do fechamento: 100% automática, nunca pode afetar a
    // resposta. Qualquer problema aqui vira log — saveIncidente() já
    // garante isso internamente, mas o try/catch aqui é uma segunda rede de
    // segurança contra erro de leitura de `result`/`competencia` etc.
    let incidenteResumo = null;
    try {
      const deteccao = detectarIncidenteFechamento(result);
      if (deteccao) {
        const salvo = await fechamentoIncidentStorageService.saveIncidente({
          context: {
            ...incidentContext,
            metadata: { costsSource, costsBaseId, competencia },
          },
          triggers: deteccao.triggers,
          triggerPrincipal: deteccao.triggerPrincipal,
          resumo: deteccao.resumo,
          diagnostico: {
            unmatchedIds: (result.unmatchedIds || []).slice(0, 1000),
            unmatchedCosts: (result.unmatchedCosts || []).slice(0, 1000),
            debug: debugCollector ? debugCollector.snapshot() : null,
          },
          files: incidentFiles,
        });
        if (salvo) {
          incidenteResumo = {
            codigo: salvo.codigo,
            mensagem: `Ocorrência de suporte ${salvo.codigo} criada. Os arquivos utilizados foram preservados temporariamente para diagnóstico.`,
          };
        }
      }
    } catch (incidentErr) {
      console.error("[FinanceiroIncident] erro inesperado na captura automática (ignorado):", incidentErr.message);
    }

    res.json({
      ok: true,
      summary: result.summary,
      competencia,
      detailedRows: result.detailedRows,
      excelBase64,
      unmatchedIds: result.unmatchedIds,
      unmatchedCosts: result.unmatchedCosts || [],
      unmatchedCancelled: result.unmatchedCancelled,
      ignoredRowsWithoutCost: result.ignoredRowsWithoutCost,
      ignoredRevenue: result.ignoredRevenue,
      message: result.message,
      emptySales: result.emptySales === true,
      costsSource,
      costsBase,
      ...(incidenteResumo ? { incidente: incidenteResumo } : {}),
      ...(marketplace === "tiktok" ? {
        pendingRows: result.pendingRows || [],
        onholdSummary: result.onholdSummary || null,
      } : {}),
      ...(marketplace === "meli" ? {
        diagnostico: {
          cabecalhosDetectados: meliHeaderDiagnostic.detectedHeaders,
          linhaCabecalho: meliHeaderDiagnostic.headerRow,
          totalLinhasLidas: result.parsingDiagnostics?.totalRowsRead ?? 0,
          totalLinhasReconhecidas: result.parsingDiagnostics?.recognizedRowsCount ?? 0,
          totalVendasReconhecidas: result.parsingDiagnostics?.recognizedSalesCount ?? 0,
        },
      } : {}),
    });
  } catch (error) {
    console.error("Erro em /fechamentos/financeiro:", error);
    const statusCode =
      Number.isFinite(Number(error?.statusCode)) && Number(error.statusCode) >= 400
        ? Number(error.statusCode)
        : 500;
    const payload = {
      ok: false,
      error: error instanceof Error ? error.message : "Erro ao processar os arquivos enviados."
    };
    if (error?.code) payload.code = error.code;
    if (Array.isArray(error?.contas)) payload.contas = error.contas;
    if (statusCode === 422 && meliHeaderDiagnostic) {
      payload.diagnostico = {
        cabecalhosDetectados: meliHeaderDiagnostic.detectedHeaders,
        linhaCabecalho: meliHeaderDiagnostic.headerRow,
        totalLinhasLidas: error?.diagnostics?.totalRowsRead ?? 0,
        totalLinhasReconhecidas: error?.diagnostics?.recognizedRowsCount ?? 0,
        totalVendasReconhecidas: error?.diagnostics?.recognizedSalesCount ?? 0,
      };
    }

    // Mesma regra da captura no caminho de sucesso: best-effort, nunca pode
    // mudar o que já foi decidido acima (statusCode/payload já estão prontos).
    try {
      if (incidentFiles.length > 0) {
        await fechamentoIncidentStorageService.saveIncidente({
          context: incidentContext,
          triggers: ["excecao_processamento"],
          triggerPrincipal: "excecao_processamento",
          resumo: { statusCode, mensagemErro: payload.error, codigoErro: payload.code || null },
          diagnostico: { stack: process.env.NODE_ENV === "production" ? null : String(error?.stack || "") },
          files: incidentFiles,
        });
      }
    } catch (incidentErr) {
      console.error("[FinanceiroIncident] erro inesperado na captura automática pelo catch (ignorado):", incidentErr.message);
    }

    res.status(statusCode).json(payload);
  }
}

module.exports = {
  listarClientesFinanceiroController,
  processarFechamentoFinanceiroController,
  buildFechamentoContextRows,
  formatSummaryValue,
  validarContaDoCliente,
};
