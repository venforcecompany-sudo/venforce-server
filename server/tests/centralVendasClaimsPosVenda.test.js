const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const {
  buildClaimsMap,
  buildShipmentOrderIndex,
  resolveClaimOrderLink,
  buildClaimsSearchPath,
  buildClaimsWindow,
  classificarClaim,
  createCentralVendasClaimsService,
  extrairReturnDetalhe,
  extractReturnDetalheDiagnostic,
  CLAIMS_LOOKAHEAD_DAYS,
  CLAIMS_SITE_ID,
  CLAIMS_RETURNS_DIAGNOSTIC_MAX,
} = require("../services/centralVendas/centralVendasClaimsService");
const {
  buildCostMap,
  buildMotorFromOrders,
  extrairReembolso,
} = require("../services/centralVendas/centralVendasSyncService");
const {
  extrairFreteSeller,
  extrairReceitaComprador,
} = require("../services/centralVendas/centralVendasFreteService");
const { buildPayloadFromRange, buildResumoFromRange } = require("../services/centralVendas/centralVendasService");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `FALHOU: ${label} — recebido ${JSON.stringify(actual)}`);
  checks += 1;
}

// Captura os console.log do serviço sem poluir a saída do teste.
async function capturandoLogs(fn) {
  const linhas = [];
  const original = console.log;
  console.log = (...args) => { linhas.push(args); };
  try {
    return { resultado: await fn(), linhas };
  } finally {
    console.log = original;
  }
}

const HOJE = new Date("2026-08-15T00:00:00.000Z");
const PERIODO = { dateFrom: "2026-07-01", dateTo: "2026-07-31" };

function order(id, extra = {}) {
  return {
    id,
    date_created: "2026-07-10T10:00:00.000-03:00",
    status: "paid",
    tags: ["paid", "delivered"],
    shipping: { id: `SHIP-${id}`, logistic_type: "cross_docking" },
    order_items: [{
      item: { id: "MLB111", title: "Produto", seller_sku: "SKU-1" },
      quantity: 1,
      unit_price: 100,
      sale_fee: 10,
    }],
    ...extra,
  };
}

const COST_MAP = buildCostMap([{ produto_id: "MLB111", custo_produto: 40, imposto_percentual: 5 }]);

function freteMapDe(orders, entry = { valor: 5, status: "real" }) {
  return new Map(orders.map((o) => [o.shipping.id, { receitaComprador: null, ...entry }]));
}

function componenteDe(motor, pedidoId, tipo) {
  return motor.componentes.find((c) => c.pedidoId === pedidoId && c.tipo === tipo);
}

function snapshotFromMotor(motor, resumo = motor.resumo) {
  const rowIds = new Map(motor.pedidos.map((pedido, index) => [pedido.pedidoId, index + 1]));
  return {
    importacao: {
      id: 77,
      fonte: "orders_api",
      created_at: "2026-07-31T12:00:00.000Z",
      resumo_json: resumo,
    },
    pedidos: motor.pedidos.map((pedido) => ({
      id: rowIds.get(pedido.pedidoId),
      pedido_id: pedido.pedidoId,
      data_pedido: pedido.dataPedido,
      status: pedido.status,
      quantidade_itens: pedido.quantidadeItens,
      faturamento: pedido.faturamento,
      resultado: pedido.resultado,
      confianca: pedido.confianca,
      pendencias_json: pedido.pendencias,
      payload_json: pedido,
    })),
    itens: motor.itens.map((item) => ({
      ...item,
      pedido_row_id: rowIds.get(item.pedidoId),
      pedido_id: item.pedidoId,
      item_id: item.itemId,
      receita_produto: item.receitaProduto,
      custo_produto: item.custoProduto,
      imposto_interno: item.impostoInterno,
    })),
    componentes: motor.componentes.map((component) => ({
      ...component,
      pedido_row_id: rowIds.get(component.pedidoId),
      pedido_id: component.pedidoId,
      item_id: component.itemId,
    })),
  };
}

// M9 — Portal/fechamentos-api.js não tem mais fórmula financeira própria
// (computeOrder/buildFechamentoResumo/buildFechamentoComponentes foram
// removidas: a tela só consulta a Read API). Este carregador continua
// existindo só para a seção 17 provar, no arquivo REAL, que essas
// declarações de fato não existem mais — a composição em si é validada
// contra `buildResumoFromRange` (centralVendasService.js), que é quem
// calcula esses agregados agora.
function carregarTelaFechamento() {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "Portal", "fechamentos-api.js"), "utf8");
  const ctx = vm.createContext({
    document: { addEventListener() {}, getElementById() { return null; } },
    window: { location: { replace() {} } },
    localStorage: { getItem() { return "token-fake"; }, setItem() {}, removeItem() {} },
    console: { log() {}, warn() {}, error() {} },
    fetch() {},
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(src, ctx, { filename: "fechamentos-api.js" });
  return ctx;
}

/* ── Claims de referência ──────────────────────────────────────────────── */

const devolucao = {
  id: 501,
  resource: "order",
  resource_id: "DEVOLVIDO",
  status: "closed",
  type: "returns",
  stage: "claim",
  related_entities: ["return"],
  resolution: { reason: "item_returned", benefited: ["complainant"] },
};
const mediacao = {
  id: 502,
  resource: "order",
  resource_id: "MEDIACAO",
  status: "opened",
  type: "mediations",
  stage: "dispute",
  related_entities: [],
  resolution: null,
};
const favorVendedor = {
  id: 503,
  resource: "order",
  resource_id: "FAVOR_VENDEDOR",
  status: "closed",
  type: "mediations",
  stage: "dispute",
  related_entities: [],
  resolution: { reason: "coverage_decision", benefited: ["respondent"] },
};
const recursoErrado = {
  id: 504,
  resource: "shipment",
  resource_id: "SEM_CLAIM",
  status: "closed",
  type: "returns",
  related_entities: ["return"],
  resolution: { reason: "item_returned", benefited: ["complainant"] },
};

function servicoComRespostas(handler) {
  const paths = [];
  const mlUserIds = [];
  const service = createCentralVendasClaimsService({
    sleepFn: async () => {},
    mlFetchFn: async (_clienteId, requestPath, options = {}) => {
      paths.push(requestPath);
      mlUserIds.push(options.mlUserId);
      return handler(requestPath, paths.length - 1);
    },
  });
  return { service, paths, mlUserIds };
}

function rangeDe(requestPath) {
  return new URL(`https://api.test${requestPath}`).searchParams.get("range");
}

async function run() {
  /* ── Classificação e cruzamento (6, 7) ──────────────────────────────── */

  eq("classifica devolução efetivada como cancelado", classificarClaim(devolucao), {
    status: "cancelado", tipo: "devolucao", motivo: "item_returned",
  });
  eq("classifica mediação aberta como com_problema", classificarClaim(mediacao), {
    status: "com_problema", tipo: "mediacao", motivo: "mediacao_em_aberto",
  });
  eq("claim a favor do vendedor não impacta", classificarClaim(favorVendedor), null);

  // 6. Claim de order cruza por resource_id · 7. sem vínculo confiável não cruza.
  const claimsMap = buildClaimsMap([devolucao, mediacao, favorVendedor, recursoErrado]);
  eq("6. claims de order entram no mapa por resource_id", claimsMap.size, 3);
  ok("6. devolução cruzada por resource_id", claimsMap.has("DEVOLVIDO"));
  ok("7. claim de shipment não é associado ao pedido por chute", !claimsMap.has("SEM_CLAIM"));

  const orders = [order("DEVOLVIDO"), order("MEDIACAO"), order("FAVOR_VENDEDOR"), order("SEM_CLAIM")];
  const motor = buildMotorFromOrders({
    orders,
    costMap: COST_MAP,
    freteMap: freteMapDe(orders),
    claimsMap,
    claimsIndisponivel: false,
    clienteSlug: "cliente-teste",
    competencia: "2026-07",
  });

  eq("devolução sai do resultado mas continua visível",
    motor.pedidos.find((p) => p.pedidoId === "DEVOLVIDO").status, "cancelado");
  eq("mediação vira com_problema",
    motor.pedidos.find((p) => p.pedidoId === "MEDIACAO").status, "com_problema");
  eq("claim a favor do vendedor mantém o pedido pago",
    motor.pedidos.find((p) => p.pedidoId === "FAVOR_VENDEDOR").status, "paid");
  eq("pedido sem claim não é afetado",
    motor.pedidos.find((p) => p.pedidoId === "SEM_CLAIM").status, "paid");
  eq("agregados excluem devolução e mediação", motor.resumo.pedidosValidos, 2);
  eq("faturamento só dos pedidos válidos", motor.resumo.faturamento, 200);
  eq("contador de devoluções", motor.resumo.devolucoes, 1);
  eq("contador de mediações", motor.resumo.mediacoes, 1);

  const payload = buildPayloadFromRange(
    { id: 1, slug: "cliente-teste", nome: "Cliente Teste" },
    PERIODO,
    snapshotFromMotor(motor)
  );
  eq("payload preserva os 4 pedidos", payload.pedidos.length, 4);
  eq("payload exclui devolvido do resultado",
    payload.pedidos.find((p) => p.id === "DEVOLVIDO").entraNoResultado, false);

  /* ── 1. HTTP 400 propaga status, motivo e corpo ─────────────────────── */

  const corpo400 = {
    error: "bad_request",
    message: "Invalid parameter",
    cause: [{ code: "range.invalid", description: "range format not accepted" }],
  };
  const cenario400 = servicoComRespostas(() => ({ ok: false, status: 400, data: corpo400 }));
  const { resultado: falha400, linhas: logs400 } = await capturandoLogs(() =>
    cenario400.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: 999, ...PERIODO, hoje: HOJE,
    })
  );
  eq("1. motivo http_400 propagado", falha400.motivo, "http_400");
  eq("1. status HTTP preservado", falha400.status, 400);
  eq("1. mapa vazio e indisponível", [falha400.indisponivel, falha400.claimsMap.size], [true, 0]);
  const log400 = logs400.find((l) => l[0] === "[centralVendas] claims indisponivel");
  ok("1. log estruturado emitido", !!log400);
  eq("1. log carrega error do ML", log400[1].error, "bad_request");
  eq("1. log carrega message do ML", log400[1].message, "Invalid parameter");
  eq("1. log carrega cause do ML", log400[1].cause, corpo400.cause);
  eq("1. log carrega a query rejeitada", log400[1].query.sellerId, "999");
  ok("1. log não expõe token nem resposta completa",
    !JSON.stringify(log400).match(/token|authorization|Bearer/i));

  /* ── 0. Regressão do CLAIMS_HTTP_400 real (players.* rejeitado pela API) ─
     Causa raiz comprovada com probes reais em 21/08: a API responde
     `atLeastOneFilterProvided` para `players.user_id`/`players.role`, mesmo
     combinados com `range`, e `range` isolado também não conta como filtro.
     `site_id` é reconhecido. Este mock reproduz o contrato real descoberto —
     não a implementação — para travar a causa, não o sintoma. */

  const path0 = buildClaimsSearchPath({
    dateFrom: PERIODO.dateFrom, dateTo: PERIODO.dateTo, timezoneFormat: "-03:00", limit: 100, offset: 0,
  });
  const query0 = new URL(`https://api.test${path0}`).searchParams;
  ok("0. query não usa players.user_id (API rejeita)", !query0.has("players.user_id"));
  ok("0. query não usa players.role (API rejeita)", !query0.has("players.role"));
  eq("0. query usa site_id (filtro exigido, aceito pela API real)", query0.get("site_id"), CLAIMS_SITE_ID);
  ok("0. range continua presente", !!query0.get("range"));

  function mlRealContract(requestPath) {
    const q = new URL(`https://api.test${requestPath}`).searchParams;
    const temFiltroReconhecido = q.has("site_id") || q.has("stage") || q.has("status") || q.has("order_id");
    if (!temFiltroReconhecido) {
      return {
        ok: false, status: 400,
        data: { error: "bad_request_error", message: "atLeastOneFilterProvided: at least one filter parameter must be provided", cause: null },
      };
    }
    return { ok: true, status: 200, data: { data: [devolucao], paging: { total: 1 } } };
  }

  const cenarioContratoReal = servicoComRespostas(mlRealContract);
  const { resultado: comContratoReal } = await capturandoLogs(() =>
    cenarioContratoReal.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: "222", ...PERIODO, hoje: HOJE,
    })
  );
  eq("0. com o filtro exigido pela API real, claims são recuperados", comContratoReal.indisponivel, false);
  eq("0. claim do pedido é encontrado", comContratoReal.claimsMap.size, 1);
  ok("0. sellerId vai como mlUserId da request, nunca na query",
    cenarioContratoReal.mlUserIds.every((id) => id === "222")
      && !cenarioContratoReal.paths.some((p) => p.includes("222")));

  /* ── 3. As duas variantes de fuso falham ────────────────────────────── */

  eq("3. duas variantes tentadas em toda a sincronização", cenario400.paths.length, 2);
  ok("3. primeira variante usa -03:00", rangeDe(cenario400.paths[0]).includes("-03:00"));
  ok("3. segunda variante usa -0300",
    rangeDe(cenario400.paths[1]).includes("-0300") && !rangeDe(cenario400.paths[1]).includes("-03:00"));
  eq("3. falha nas duas mantém claims indisponíveis", falha400.indisponivel, true);

  /* ── 2. Primeira variante falha, segunda funciona ───────────────────── */

  const cenarioFallback = servicoComRespostas((requestPath) => {
    if (rangeDe(requestPath).includes("-03:00")) {
      return { ok: false, status: 400, data: { error: "bad_request", message: "bad range" } };
    }
    const offset = Number(new URL(`https://api.test${requestPath}`).searchParams.get("offset"));
    const paginas = [[devolucao], [mediacao]];
    return { ok: true, status: 200, data: { paging: { total: 2 }, data: paginas[offset] || [] } };
  });
  const { resultado: comFallback } = await capturandoLogs(() =>
    cenarioFallback.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: 999, ...PERIODO, limit: 1, hoje: HOJE,
    })
  );
  eq("2. claims recuperados na segunda variante", comFallback.indisponivel, false);
  eq("2. variante vencedora registrada", comFallback.timezoneFormato, "-0300");
  eq("2. dois pedidos com claims", comFallback.claimsMap.size, 2);
  eq("2. fallback tentado uma única vez (1 falha + 2 páginas)", cenarioFallback.paths.length, 3);
  ok("2. páginas seguintes já usam a variante que funcionou",
    cenarioFallback.paths.slice(1).every((p) => rangeDe(p).includes("-0300")));

  /* ── 4. HTTP 401/403 não vira lista vazia confiável ─────────────────── */

  for (const status of [401, 403]) {
    const cenario = servicoComRespostas(() => ({ ok: false, status, data: { message: "forbidden" } }));
    const { resultado } = await capturandoLogs(() =>
      cenario.service.buscarClaimsPorPeriodo({ clienteId: 1, sellerId: 999, ...PERIODO, hoje: HOJE })
    );
    eq(`4. http_${status} propagado como motivo`, resultado.motivo, `http_${status}`);
    eq(`4. http_${status} mantém claims indisponíveis`, resultado.indisponivel, true);
    eq(`4. http_${status} não vira lista vazia`, resultado.claims.length, 0);
    eq(`4. http_${status} não dispara fallback de fuso`, cenario.paths.length, 1);
  }

  /* ── 5. Falha depois da 1ª página descarta as páginas parciais ──────── */

  const cenarioParcial = servicoComRespostas((requestPath) => {
    const offset = Number(new URL(`https://api.test${requestPath}`).searchParams.get("offset"));
    if (offset === 0) return { ok: true, status: 200, data: { paging: { total: 2 }, data: [devolucao] } };
    return { ok: false, status: 500, data: { message: "boom" } };
  });
  const { resultado: parcial } = await capturandoLogs(() =>
    cenarioParcial.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: 999, ...PERIODO, limit: 1, hoje: HOJE,
    })
  );
  eq("5. falha em página posterior marca indisponível", parcial.indisponivel, true);
  eq("5. página parcial descartada", parcial.claimsMap.size, 0);
  eq("5. motivo da falha preservado", parcial.motivo, "http_500");

  /* ── 8. Pós-venda posterior ao mês da venda ─────────────────────────── */

  const janela = buildClaimsWindow("2026-07-01", "2026-07-31", { hoje: HOJE });
  eq("8. janela começa no início do período", janela.from, "2026-07-01");
  eq("8. janela ampliada limitada por hoje", janela.to, "2026-08-15");
  eq("8. lookahead é a constante única", janela.lookaheadDays, CLAIMS_LOOKAHEAD_DAYS);
  const janelaPassado = buildClaimsWindow("2026-01-01", "2026-01-31", { hoje: HOJE });
  eq("8. período antigo usa o lookahead cheio", janelaPassado.to, "2026-05-01");

  const claimDeAgosto = {
    id: 601,
    resource: "order",
    resource_id: "VENDA_JULHO",
    date_created: "2026-08-09T10:00:00.000-03:00",
    status: "closed",
    type: "returns",
    related_entities: ["return"],
    resolution: { reason: "item_returned", benefited: ["complainant"] },
  };
  const claimDeOutroPedido = { ...claimDeAgosto, id: 602, resource_id: "VENDA_DE_JUNHO" };
  const cenarioJanela = servicoComRespostas(() => ({
    ok: true, status: 200, data: { paging: { total: 2 }, data: [claimDeAgosto, claimDeOutroPedido] },
  }));
  const { resultado: loteJanela } = await capturandoLogs(() =>
    cenarioJanela.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: 999, ...PERIODO, hoje: HOJE,
      orderIds: new Set(["VENDA_JULHO"]),
    })
  );
  ok("8. consulta usa a janela ampliada", rangeDe(cenarioJanela.paths[0]).includes("2026-08-16"));
  ok("8. claim de agosto vincula à venda de julho", loteJanela.claimsMap.has("VENDA_JULHO"));
  ok("8. claim de pedido fora do período é descartado", !loteJanela.claimsMap.has("VENDA_DE_JUNHO"));
  eq("8. descartes contabilizados", loteJanela.claimsForaDoPeriodo, 1);

  const motorJanela = buildMotorFromOrders({
    orders: [order("VENDA_JULHO")],
    costMap: COST_MAP,
    freteMap: freteMapDe([order("VENDA_JULHO")]),
    claimsMap: loteJanela.claimsMap,
    clienteSlug: "cliente-teste",
    competencia: "2026-07",
  });
  eq("8. devolução de agosto sai do resultado de julho",
    motorJanela.pedidos[0].status, "cancelado");

  /* ── Detalhe de returns: vínculo só com order_id da API ─────────────── */

  // O serviço anota o detalhe resolvido no próprio claim, então cada cenário
  // recebe uma cópia nova.
  const claimReturnSemOrder = () => ({
    id: 700, resource: "shipment", resource_id: "SHIP-XYZ",
    status: "closed", type: "returns", related_entities: ["return"],
    resolution: { reason: "item_returned", benefited: ["complainant"] },
  });
  const cenarioDetalhe = servicoComRespostas((requestPath) => {
    if (requestPath.includes("/returns")) {
      return { ok: true, status: 200, data: { order_id: "PEDIDO_RESOLVIDO", status: "closed" } };
    }
    return { ok: true, status: 200, data: { paging: { total: 1 }, data: [claimReturnSemOrder()] } };
  });
  const { resultado: loteDetalhe } = await capturandoLogs(() =>
    cenarioDetalhe.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: 999, ...PERIODO, hoje: HOJE,
      orderIds: new Set(["PEDIDO_RESOLVIDO"]),
    })
  );
  ok("detalhe v2 consultado só para devolução sem vínculo",
    cenarioDetalhe.paths.filter((p) => p.includes("/returns")).length === 1);
  ok("vínculo usa o order_id devolvido pela API", loteDetalhe.claimsMap.has("PEDIDO_RESOLVIDO"));
  eq("devoluções resolvidas contabilizadas", loteDetalhe.returnsResolvidos, 1);
  // Hardening account-aware: o detalhe de devolução (GET .../claims/:id/returns)
  // também propaga mlUserId=sellerId — antes só a busca por período recebia a
  // conta explícita (ver docs/AUDITORIA_IDENTIDADE_CENTRAL_VENDAS_CLAIMS_FRETE.md).
  ok("detalhe v2 de devolução propaga mlUserId=sellerId",
    cenarioDetalhe.mlUserIds.every((id) => id === 999));

  const cenarioDetalheFalha = servicoComRespostas((requestPath) => {
    if (requestPath.includes("/returns")) return { ok: false, status: 500, data: null };
    return { ok: true, status: 200, data: { paging: { total: 1 }, data: [claimReturnSemOrder()] } };
  });
  const { resultado: loteDetalheFalha } = await capturandoLogs(() =>
    cenarioDetalheFalha.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: 999, ...PERIODO, hoje: HOJE,
      orderIds: new Set(["PEDIDO_RESOLVIDO"]),
    })
  );
  eq("falha no detalhe não vira 'pedido sem devolução'", loteDetalheFalha.returnsNaoResolvidos, 1);
  eq("claim sem vínculo não entra no mapa por suposição", loteDetalheFalha.claimsMap.size, 0);

  const motorReturnsIncompleto = buildMotorFromOrders({
    orders: [order("PEDIDO_RESOLVIDO")],
    costMap: COST_MAP,
    freteMap: freteMapDe([order("PEDIDO_RESOLVIDO")]),
    claimsMap: loteDetalheFalha.claimsMap,
    claimsIndisponivel: false,
    claimsReturnsNaoResolvidos: loteDetalheFalha.returnsNaoResolvidos,
    clienteSlug: "cliente-teste",
    competencia: "2026-07",
  });
  eq("16b. devolução não resolvida rebaixa a confiança",
    motorReturnsIncompleto.resumo.confianca, "parcial");
  const payloadReturns = buildPayloadFromRange(
    { id: 1, slug: "cliente-teste", nome: "Cliente Teste" },
    PERIODO,
    snapshotFromMotor(motorReturnsIncompleto)
  );
  eq("16b. tela não pode concluir com pós-venda incompleto", payloadReturns.motor.podeConcluir, false);
  eq("16b. contagem exposta no payload", payloadReturns.resumo.claimsReturnsNaoResolvidos, 1);

  /* ── Diagnóstico seguro de returns não resolvidos (rodada do 21/08:
     syncRunId 6, cliente red_fish, RETURNS_UNRESOLVED com 1/1 devolução sem
     vínculo). Antes só existia o contador agregado — a causa real do único
     caso nunca sobrevivia além do console.log do worker. ──────────────── */

  // extractReturnDetalheDiagnostic: extrai só a whitelist fixa de campos
  // estruturais, nunca o payload inteiro nem dado de comprador/endereço.
  eq("diag. resposta OK sem order_id expõe estrutura (hasOrderId=false)",
    extractReturnDetalheDiagnostic({ status: "closed", subtype: "dispute", resource: "shipment", items: [{ quantity: 1 }] }),
    { hasOrderId: false, resource: "shipment", hasResourceId: false, itemsCount: 1, status: "closed", subtype: "dispute" });
  eq("diag. resposta com order_id expõe hasOrderId=true", extractReturnDetalheDiagnostic({ order_id: "X" }).hasOrderId, true);
  eq("diag. resposta vazia/nula não gera diagnóstico", extractReturnDetalheDiagnostic(null), null);
  ok("diag. nunca inclui campos além da whitelist",
    Object.keys(extractReturnDetalheDiagnostic({
      order_id: "X", buyer: { nickname: "fulano" }, shipping_address: "Rua X, 123", token: "abc",
    })).every((k) => ["hasOrderId", "resource", "hasResourceId", "itemsCount", "status", "subtype"].includes(k)));

  // Caso 1: detalhe responde OK mas SEM order_id (estrutura ausente, não erro
  // HTTP) — é o caso que a rodada real (syncRunId 6) mais provavelmente
  // encontrou, já que Claims Search fechou 39/39 (permissão OK).
  const claimReturnSemOrderDiag = () => ({
    id: 900, resource: "shipment", resource_id: "SHIP-DIAG",
    status: "opened", type: "returns", related_entities: ["return"],
    resolution: null,
  });
  const cenarioSemOrderId = servicoComRespostas((requestPath) => {
    if (requestPath.includes("/returns")) {
      return { ok: true, status: 200, data: { status: "opened", subtype: "dispute", items: [] } };
    }
    return { ok: true, status: 200, data: { paging: { total: 1 }, data: [claimReturnSemOrderDiag()] } };
  });
  const { resultado: loteSemOrderId } = await capturandoLogs(() =>
    cenarioSemOrderId.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: 999, ...PERIODO, hoje: HOJE,
    })
  );
  eq("diag. resposta OK sem order_id conta como não resolvido", loteSemOrderId.returnsNaoResolvidos, 1);
  eq("diag. 1 entrada de diagnóstico gerada", loteSemOrderId.returnsDiagnosticos.length, 1);
  eq("diag. claimId preservado", loteSemOrderId.returnsDiagnosticos[0].claimId, "900");
  eq("diag. httpStatus 200 quando a resposta foi OK", loteSemOrderId.returnsDiagnosticos[0].httpStatus, 200);
  eq("diag. estrutura do detalhe exposta (hasOrderId=false)",
    loteSemOrderId.returnsDiagnosticos[0].detalhe,
    { hasOrderId: false, resource: null, hasResourceId: false, itemsCount: 0, status: "opened", subtype: "dispute" });
  eq("diag. resource do PRÓPRIO claim (busca por período) também vai junto",
    loteSemOrderId.returnsDiagnosticos[0].claimResource, "shipment");

  // Caso 2: detalhe falha por HTTP (ex.: 404/403) — diagnóstico carrega
  // httpStatus + error/message/cause do ML, nunca token/Authorization.
  const cenarioHttpFalha = servicoComRespostas((requestPath) => {
    if (requestPath.includes("/returns")) {
      return { ok: false, status: 404, data: { error: "not_found", message: "claim return not found", cause: null } };
    }
    return { ok: true, status: 200, data: { paging: { total: 1 }, data: [claimReturnSemOrderDiag()] } };
  });
  const { resultado: loteHttpFalha } = await capturandoLogs(() =>
    cenarioHttpFalha.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: 999, ...PERIODO, hoje: HOJE,
    })
  );
  eq("diag. httpStatus 404 propagado", loteHttpFalha.returnsDiagnosticos[0].httpStatus, 404);
  eq("diag. motivo http_404 propagado", loteHttpFalha.returnsDiagnosticos[0].motivo, "http_404");
  eq("diag. error/message do ML propagados, nunca o corpo inteiro",
    [loteHttpFalha.returnsDiagnosticos[0].detalhe.mlError, loteHttpFalha.returnsDiagnosticos[0].detalhe.mlMessage],
    ["not_found", "claim return not found"]);
  ok("diag. nenhum diagnóstico contém token/Authorization",
    !JSON.stringify(loteHttpFalha.returnsDiagnosticos).match(/token|authorization|Bearer/i));
  ok("diag. nenhum diagnóstico contém dado de comprador/endereço/nome",
    !JSON.stringify(loteHttpFalha.returnsDiagnosticos).match(/buyer|nickname|address|endereco/i));

  // Teto: diagnóstico nunca cresce sem limite mesmo com muitas devoluções
  // sem vínculo no mesmo run.
  const muitosClaimsSemVinculo = Array.from({ length: CLAIMS_RETURNS_DIAGNOSTIC_MAX + 5 }, (_, i) => ({
    id: 1000 + i, resource: "shipment", resource_id: `SHIP-${i}`,
    status: "opened", type: "returns", related_entities: ["return"], resolution: null,
  }));
  const cenarioTeto = servicoComRespostas((requestPath) => {
    if (requestPath.includes("/returns")) return { ok: true, status: 200, data: { status: "opened" } };
    return { ok: true, status: 200, data: { paging: { total: muitosClaimsSemVinculo.length }, data: muitosClaimsSemVinculo } };
  });
  const { resultado: loteTeto } = await capturandoLogs(() =>
    cenarioTeto.service.buscarClaimsPorPeriodo({ clienteId: 1, sellerId: 999, ...PERIODO, hoje: HOJE })
  );
  eq("diag. lista de diagnóstico respeita o teto", loteTeto.returnsDiagnosticos.length, CLAIMS_RETURNS_DIAGNOSTIC_MAX);
  eq("diag. contador agregado continua contando TODOS, não só o teto",
    loteTeto.returnsNaoResolvidos, muitosClaimsSemVinculo.length);

  /* ── RUN 7 — claim.resource="shipment" vinculado por order.shipping.id
     (síndrome do claim 5553953268: detalhe HTTP 200, sem order_id, porque o
     claim está associado a um SHIPMENT, não a um order) ──────────────────── */

  // buildShipmentOrderIndex: índice em memória, só com Orders do período.
  eq("shipment. índice vazio sem orders", buildShipmentOrderIndex(null).size, 0);

  const orderUnico = order("UNICO"); // shipping.id = "SHIP-UNICO"
  const indexUnico = buildShipmentOrderIndex([orderUnico]);
  eq("shipment. índice mapeia shipmentId -> Set(orderId)",
    [...indexUnico.get("SHIP-UNICO")], ["UNICO"]);

  // resolveClaimOrderLink: só relações oficiais (resource=order direto, ou
  // resource=shipment cruzado com o índice), nunca heurística.
  eq("shipment. resource=order continua resolvendo direto, sem depender do índice",
    resolveClaimOrderLink({ resource: "order", resource_id: "PEDIDO_X" }, indexUnico),
    { orderId: "PEDIDO_X", source: "resource_order", ambiguous: false });

  eq("shipment. resource=shipment unívoco resolve o order",
    resolveClaimOrderLink({ resource: "shipment", resource_id: "SHIP-UNICO" }, indexUnico),
    { orderId: "UNICO", source: "shipment_resource", ambiguous: false });

  eq("shipment. 0 orders correspondentes não inventa vínculo",
    resolveClaimOrderLink({ resource: "shipment", resource_id: "SHIP-INEXISTENTE" }, indexUnico),
    { orderId: null, source: null, ambiguous: false });

  // Pack: mesmo shipment cobrindo 2 orders — nunca escolher um dos dois.
  const orderPackA = order("PACK_A", { shipping: { id: "SHIP-PACK" } });
  const orderPackB = order("PACK_B", { shipping: { id: "SHIP-PACK" } });
  const indexPack = buildShipmentOrderIndex([orderPackA, orderPackB]);
  eq("shipment. 2+ orders no mesmo shipment fica ambíguo (nunca A, nunca B)",
    resolveClaimOrderLink({ resource: "shipment", resource_id: "SHIP-PACK" }, indexPack),
    { orderId: null, source: null, ambiguous: true });

  // Nenhuma heurística de SKU/MLB/valor/data: dois orders com item/preço
  // idênticos e shipments DIFERENTES não se confundem.
  const orderGemeoA = order("GEMEO_A");
  const orderGemeoB = order("GEMEO_B");
  const indexGemeos = buildShipmentOrderIndex([orderGemeoA, orderGemeoB]);
  eq("shipment. orders com item/preço idênticos não cruzam por acidente (só por shipping.id)",
    resolveClaimOrderLink({ resource: "shipment", resource_id: "SHIP-GEMEO_A" }, indexGemeos).orderId,
    "GEMEO_A");

  // Cenário end-to-end (o próprio RUN 7): Claims 1/1, resource=shipment,
  // shipment pertence unicamente a um order do período, /returns responde
  // HTTP 200 sem order_id => vínculo resolvido, sem RETURNS_UNRESOLVED.
  const orderRun7 = order("PEDIDO_RUN7"); // shipping.id = "SHIP-PEDIDO_RUN7"
  const claimRun7 = () => ({
    id: "5553953268", resource: "shipment", resource_id: "SHIP-PEDIDO_RUN7",
    status: "closed", type: "returns", related_entities: ["return"],
    resolution: { reason: "item_returned", benefited: ["complainant"] },
  });
  const cenarioRun7 = servicoComRespostas((requestPath) => {
    if (requestPath.includes("/returns")) {
      // Reprodução exata do diagnóstico real: 200 OK, sem order_id, resource null.
      return { ok: true, status: 200, data: { status: "delivered", subtype: null, resource: null, items: [] } };
    }
    return { ok: true, status: 200, data: { paging: { total: 1 }, data: [claimRun7()] } };
  });
  const { resultado: loteRun7 } = await capturandoLogs(() =>
    cenarioRun7.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: 999, ...PERIODO, hoje: HOJE,
      orderIds: new Set(["PEDIDO_RUN7"]),
      orders: [orderRun7],
    })
  );
  eq("run7. shipment unívoco resolve o order mesmo sem order_id no detalhe",
    [...loteRun7.claimsMap.keys()], ["PEDIDO_RUN7"]);
  eq("run7. NÃO fica RETURNS_UNRESOLVED só por falta de order_id no detalhe",
    loteRun7.returnsNaoResolvidos, 0);
  eq("run7. devolução contabilizada como resolvida", loteRun7.returnsResolvidos, 1);
  eq("run7. nenhum diagnóstico de não-resolvido gerado", loteRun7.returnsDiagnosticos.length, 0);

  const motorRun7 = buildMotorFromOrders({
    orders: [orderRun7],
    costMap: COST_MAP,
    freteMap: freteMapDe([orderRun7]),
    claimsMap: loteRun7.claimsMap,
    claimsIndisponivel: false,
    claimsReturnsNaoResolvidos: loteRun7.returnsNaoResolvidos,
    clienteSlug: "cliente-teste",
    competencia: "2026-07",
  });
  eq("run7. pedido vira devolução (cancelado) via vínculo por shipment",
    motorRun7.pedidos[0].status, "cancelado");
  eq("run7. confiança não é rebaixada por RETURNS_UNRESOLVED",
    motorRun7.resumo.confianca, undefined);

  // Devolução PARCIAL: vínculo por shipment + detalhe com quantidade —
  // enriquece returnDetalhe (não perde a informação de parcialidade).
  const orderRun7Parcial = order("PEDIDO_RUN7_PARCIAL", {
    order_items: [{
      item: { id: "MLB111", title: "Produto", seller_sku: "SKU-1" },
      quantity: 3, unit_price: 100, sale_fee: 10,
    }],
  });
  const claimRun7Parcial = () => ({
    id: "5553953269", resource: "shipment", resource_id: "SHIP-PEDIDO_RUN7_PARCIAL",
    status: "closed", type: "returns", related_entities: ["return"],
    resolution: { reason: "partial_refunded", benefited: ["complainant"] },
  });
  const cenarioRun7Parcial = servicoComRespostas((requestPath) => {
    if (requestPath.includes("/returns")) {
      return { ok: true, status: 200, data: { status: "closed", items: [{ quantity: 3, quantity_returned: 1 }] } };
    }
    return { ok: true, status: 200, data: { paging: { total: 1 }, data: [claimRun7Parcial()] } };
  });
  const { resultado: loteRun7Parcial } = await capturandoLogs(() =>
    cenarioRun7Parcial.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: 999, ...PERIODO, hoje: HOJE,
      orderIds: new Set(["PEDIDO_RUN7_PARCIAL"]),
      orders: [orderRun7Parcial],
    })
  );
  const motorRun7Parcial = buildMotorFromOrders({
    orders: [orderRun7Parcial],
    costMap: COST_MAP,
    freteMap: freteMapDe([orderRun7Parcial]),
    claimsMap: loteRun7Parcial.claimsMap,
    claimsIndisponivel: false,
    claimsReturnsNaoResolvidos: loteRun7Parcial.returnsNaoResolvidos,
    clienteSlug: "cliente-teste",
    competencia: "2026-07",
  });
  eq("run7. shipment unívoco + detalhe com parcialidade preserva/enriquece returnDetalhe",
    motorRun7Parcial.pedidos[0].posVendaParcial, true);
  eq("run7. quantidade devolvida parcial preservada",
    motorRun7Parcial.pedidos[0].posVendaQuantidadeDevolvida, 1);
  eq("run7. pedido parcial não é removido do resultado",
    motorRun7Parcial.resumo.pedidosValidos, 1);

  // Shipment ambíguo (pack de 2 orders do período) SEM order_id explícito no
  // detalhe: nunca escolhe A nem B — continua unresolved.
  const orderPackReal1 = order("PACK_REAL_1", { shipping: { id: "SHIP-PACK-REAL" } });
  const orderPackReal2 = order("PACK_REAL_2", { shipping: { id: "SHIP-PACK-REAL" } });
  const claimPackAmbiguo = () => ({
    id: "9001", resource: "shipment", resource_id: "SHIP-PACK-REAL",
    status: "closed", type: "returns", related_entities: ["return"],
    resolution: { reason: "item_returned", benefited: ["complainant"] },
  });
  const cenarioPackAmbiguo = servicoComRespostas((requestPath) => {
    if (requestPath.includes("/returns")) {
      return { ok: true, status: 200, data: { status: "closed", resource: null } }; // sem order_id
    }
    return { ok: true, status: 200, data: { paging: { total: 1 }, data: [claimPackAmbiguo()] } };
  });
  const { resultado: lotePackAmbiguo } = await capturandoLogs(() =>
    cenarioPackAmbiguo.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: 999, ...PERIODO, hoje: HOJE,
      orderIds: new Set(["PACK_REAL_1", "PACK_REAL_2"]),
      orders: [orderPackReal1, orderPackReal2],
    })
  );
  eq("run7. pack ambíguo sem order_id explícito continua unresolved (nunca escolhe A nem B)",
    lotePackAmbiguo.returnsNaoResolvidos, 1);
  ok("run7. pack ambíguo nunca entra no mapa de nenhum dos dois orders",
    !lotePackAmbiguo.claimsMap.has("PACK_REAL_1") && !lotePackAmbiguo.claimsMap.has("PACK_REAL_2"));

  /* ── RUN 8 — diagnóstico de resolveClaimOrderLink/buildShipmentOrderIndex
     no unresolvedDiagnostics (A: 0 matches · B: 1 match usado · C: 2+ pack
     ambíguo). Sem isso, syncRunId 7/8 só provavam o contador agregado, nunca
     QUAL dos 3 cenários realmente ocorreu para o claim 5553953268 ─────────── */

  // C) pack ambíguo (2 matches): o mesmo cenário acima, agora auditando o
  // diagnóstico persistido — nunca só o contador.
  const diagPack = lotePackAmbiguo.returnsDiagnosticos[0];
  eq("run8. diag pack: claimResourceId é o shipment do próprio claim",
    diagPack.claimResourceId, "SHIP-PACK-REAL");
  eq("run8. diag pack: shipmentMatchCount = 2", diagPack.shipmentMatchCount, 2);
  eq("run8. diag pack: shipmentCandidateOrderIds lista os 2 orders (máx 5)",
    [...diagPack.shipmentCandidateOrderIds].sort(), ["PACK_REAL_1", "PACK_REAL_2"]);
  eq("run8. diag pack: shipmentAmbiguous = true", diagPack.shipmentAmbiguous, true);
  eq("run8. diag pack: resolvedOrderId continua null (nunca escolhe A nem B)",
    diagPack.resolvedOrderId, null);
  eq("run8. diag pack: ordersWithShippingIdCount = 2 (as 2 orders do período)",
    diagPack.ordersWithShippingIdCount, 2);

  // A) 0 matches: shipment do claim não bate com NENHUM order.shipping.id
  // dos orders do período — orders chegou (ordersWithShippingIdCount > 0),
  // só não existe o shipment procurado (índice não inventa vínculo).
  const orderSemMatch = order("SEM_MATCH"); // shipping.id = "SHIP-SEM_MATCH"
  const claimZeroMatch = () => ({
    id: "9002", resource: "shipment", resource_id: "SHIP-INEXISTENTE-RUN8",
    status: "closed", type: "returns", related_entities: ["return"],
    resolution: { reason: "item_returned", benefited: ["complainant"] },
  });
  const cenarioZeroMatch = servicoComRespostas((requestPath) => {
    if (requestPath.includes("/returns")) {
      return { ok: true, status: 200, data: { status: "delivered", resource: null } };
    }
    return { ok: true, status: 200, data: { paging: { total: 1 }, data: [claimZeroMatch()] } };
  });
  const { resultado: loteZeroMatch } = await capturandoLogs(() =>
    cenarioZeroMatch.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: 999, ...PERIODO, hoje: HOJE,
      orderIds: new Set(["SEM_MATCH"]),
      orders: [orderSemMatch],
    })
  );
  eq("run8. diag 0-match: continua unresolved", loteZeroMatch.returnsNaoResolvidos, 1);
  const diagZero = loteZeroMatch.returnsDiagnosticos[0];
  eq("run8. diag 0-match: claimResourceId preservado", diagZero.claimResourceId, "SHIP-INEXISTENTE-RUN8");
  eq("run8. diag 0-match: shipmentMatchCount = 0", diagZero.shipmentMatchCount, 0);
  eq("run8. diag 0-match: shipmentCandidateOrderIds vazio", diagZero.shipmentCandidateOrderIds, []);
  eq("run8. diag 0-match: shipmentAmbiguous = false", diagZero.shipmentAmbiguous, false);
  eq("run8. diag 0-match: resolvedOrderId null", diagZero.resolvedOrderId, null);
  eq("run8. diag 0-match: resolvedOrderSource null", diagZero.resolvedOrderSource, null);
  eq("run8. diag 0-match: ordersWithShippingIdCount prova que orders chegou (1, mesmo sem bater)",
    diagZero.ordersWithShippingIdCount, 1);

  // B) 1 match único: prova que, quando há exatamente 1 candidato, ele É
  // usado (nunca fica preso no diagnóstico com shipmentMatchCount=1 e
  // resolvedOrderId=null) — a lista de não-resolvidos fica vazia porque o
  // vínculo se resolveu de verdade, exatamente como o cenário RUN7 já prova
  // acima (loteRun7.returnsDiagnosticos.length === 0). Reforça aqui, ao lado
  // dos outros 2 cenários, que a cobertura A/B/C está completa neste arquivo.
  eq("run8. diag 1-match (B): resolve e não aparece em unresolvedDiagnostics",
    loteRun7.returnsDiagnosticos.length, 0);

  // Shipment ambíguo + detalhe COM order_id explícito: aí sim resolve.
  const cenarioPackResolvidoPorDetalhe = servicoComRespostas((requestPath) => {
    if (requestPath.includes("/returns")) {
      return { ok: true, status: 200, data: { order_id: "PACK_REAL_1", status: "closed" } };
    }
    return { ok: true, status: 200, data: { paging: { total: 1 }, data: [claimPackAmbiguo()] } };
  });
  const { resultado: lotePackResolvidoPorDetalhe } = await capturandoLogs(() =>
    cenarioPackResolvidoPorDetalhe.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: 999, ...PERIODO, hoje: HOJE,
      orderIds: new Set(["PACK_REAL_1", "PACK_REAL_2"]),
      orders: [orderPackReal1, orderPackReal2],
    })
  );
  eq("run7. pack ambíguo + order_id explícito no detalhe resolve",
    lotePackResolvidoPorDetalhe.returnsNaoResolvidos, 0);
  ok("run7. detalhe explícito resolve exatamente o order indicado pela API",
    lotePackResolvidoPorDetalhe.claimsMap.has("PACK_REAL_1"));

  // resource=order não regressa: continua ignorando o índice de shipment.
  const orderComShipmentEmOutroPedido = order("ORDER_DIRETO");
  const claimOrderDireto = {
    id: "9100", resource: "order", resource_id: "ORDER_DIRETO",
    status: "closed", type: "returns", related_entities: ["return"],
    resolution: { reason: "item_returned", benefited: ["complainant"] },
  };
  const cenarioOrderDireto = servicoComRespostas(() => ({
    ok: true, status: 200, data: { paging: { total: 1 }, data: [claimOrderDireto] },
  }));
  const { resultado: loteOrderDireto } = await capturandoLogs(() =>
    cenarioOrderDireto.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: 999, ...PERIODO, hoje: HOJE,
      orderIds: new Set(["ORDER_DIRETO"]),
      orders: [orderComShipmentEmOutroPedido],
    })
  );
  eq("run7. resource=order continua resolvendo direto (sem chamar /returns)",
    cenarioOrderDireto.paths.filter((p) => p.includes("/returns")).length, 0);
  ok("run7. resource=order vincula normalmente com o índice de shipment presente",
    loteOrderDireto.claimsMap.has("ORDER_DIRETO"));

  /* ── 9. Devolução parcial não cancela o pedido inteiro ──────────────── */

  const detalheParcial = extrairReturnDetalhe({
    order_id: "PARCIAL",
    status: "closed",
    items: [{ quantity: 3, quantity_returned: 1 }],
  });
  eq("9. detalhe identifica devolução parcial", detalheParcial.parcial, true);
  eq("9. quantidades preservadas",
    [detalheParcial.quantidadeComprada, detalheParcial.quantidadeDevolvida], [3, 1]);
  const detalheTotal = extrairReturnDetalhe({ order_id: "TOTAL", items: [{ quantity: 2, quantity_returned: 2 }] });
  eq("9. devolução total não é marcada como parcial", detalheTotal.parcial, false);
  const detalheSemQtd = extrairReturnDetalhe({ order_id: "SEM_QTD", status: "closed" });
  eq("9. sem quantidades na API, nada é inventado", detalheSemQtd.quantidadeDevolvida, null);
  eq("9. sem quantidades o comportamento total é preservado", detalheSemQtd.parcial, false);

  const claimParcial = {
    id: 801, resource: "order", resource_id: "PARCIAL",
    status: "closed", type: "returns", related_entities: ["return"],
    resolution: { reason: "partial_refunded", benefited: ["complainant"] },
    returnDetalhe: detalheParcial,
  };
  const classificacaoParcial = classificarClaim(claimParcial);
  eq("9. devolução parcial não zera o pedido", classificacaoParcial.status, null);
  eq("9. tipo próprio para devolução parcial", classificacaoParcial.tipo, "devolucao_parcial");

  const ordersParcial = [order("PARCIAL", {
    order_items: [{
      item: { id: "MLB111", title: "Produto", seller_sku: "SKU-1" },
      quantity: 3, unit_price: 100, sale_fee: 10,
    }],
  })];
  const motorParcial = buildMotorFromOrders({
    orders: ordersParcial,
    costMap: COST_MAP,
    freteMap: freteMapDe(ordersParcial),
    claimsMap: buildClaimsMap([claimParcial]),
    clienteSlug: "cliente-teste",
    competencia: "2026-07",
  });
  const pedidoParcial = motorParcial.pedidos[0];
  eq("9. status original da Orders API preservado", pedidoParcial.status, "paid");
  eq("9. pedido parcial continua no resultado", motorParcial.resumo.pedidosValidos, 1);
  eq("9. receita do pedido não é removida", pedidoParcial.faturamento, 300);
  eq("9. pedido marcado como parcial", pedidoParcial.posVendaParcial, true);
  eq("9. quantidade devolvida persistida", pedidoParcial.posVendaQuantidadeDevolvida, 1);
  eq("9. contador de devoluções parciais", motorParcial.resumo.devolucoesParciais, 1);
  eq("9. devolução parcial não conta como devolução total", motorParcial.resumo.devolucoes, 0);

  /* ── 10, 11, 12, 13. receiver.cost × senders[].cost ─────────────────── */

  const costsComReceiver = {
    senders: [{ user_id: 999, cost: 12.5, base_cost: 30, compensation: 4 }],
    receiver: { cost: 0, base_cost: 21.9, save: 21.9 },
    gross_amount: 99,
  };
  eq("10. receiver.cost = 0 permanece zero real", extrairReceitaComprador(costsComReceiver), 0);
  eq("11. receiver.cost ausente permanece null",
    extrairReceitaComprador({ senders: [{ user_id: 999, cost: 12.5 }] }), null);
  eq("11. receiver.cost null permanece null",
    extrairReceitaComprador({ receiver: { cost: null, base_cost: 30 } }), null);
  eq("12. custo seller vem só de senders[].cost", extrairFreteSeller(costsComReceiver, 999), 12.5);
  eq("12. receiver.cost não vira custo seller",
    extrairFreteSeller({ receiver: { cost: 40 }, senders: [] }, 999), null);

  const ordersEnvio = [order("COM_ENVIO"), order("ZERO_ENVIO"), order("SEM_ENVIO")];
  const freteMapEnvio = new Map([
    ["SHIP-COM_ENVIO", { valor: 5, custoSeller: 5, receitaComprador: 18.9, status: "real" }],
    ["SHIP-ZERO_ENVIO", { valor: 5, custoSeller: 5, receitaComprador: 0, status: "real" }],
    ["SHIP-SEM_ENVIO", { valor: 5, custoSeller: 5, receitaComprador: null, status: "real" }],
  ]);
  const motorEnvio = buildMotorFromOrders({
    orders: ordersEnvio,
    costMap: COST_MAP,
    freteMap: freteMapEnvio,
    clienteSlug: "cliente-teste",
    competencia: "2026-07",
  });
  const envioPositivo = componenteDe(motorEnvio, "COM_ENVIO", "receita_envio");
  eq("13. receita_envio é positiva", envioPositivo.valor, 18.9);
  eq("13. receita_envio vem da shipments API", envioPositivo.fonte, "shipments_api");
  eq("13. receita_envio real", envioPositivo.confianca, "real");
  eq("10. receita_envio zero real persistida como 0",
    componenteDe(motorEnvio, "ZERO_ENVIO", "receita_envio").valor, 0);
  eq("10. zero real não é ausência",
    componenteDe(motorEnvio, "ZERO_ENVIO", "receita_envio").confianca, "real");
  eq("11. receita_envio ausente fica null",
    componenteDe(motorEnvio, "SEM_ENVIO", "receita_envio").valor, null);
  eq("11. receita_envio ausente é marcada ausente",
    componenteDe(motorEnvio, "SEM_ENVIO", "receita_envio").confianca, "ausente");
  eq("12. frete_seller continua negativo e do sender",
    componenteDe(motorEnvio, "COM_ENVIO", "frete_seller").valor, -5);
  eq("13. receita_envio não entra no resultado do pedido",
    motorEnvio.pedidos.find((p) => p.pedidoId === "COM_ENVIO").resultado, 40);

  /* ── 14, 15. Reembolso ──────────────────────────────────────────────── */

  eq("14. reembolso somado de payments[]", extrairReembolso({
    payments: [
      { status: "refunded", transaction_amount: 100, transaction_amount_refunded: 60 },
      { status: "approved", transaction_amount: 100, transaction_amount_refunded: 40 },
    ],
  }), 100);
  eq("15. pedido sem payments não tem reembolso", extrairReembolso({}), null);
  eq("15. reembolso 0 não vira reembolso", extrairReembolso({
    payments: [{ status: "approved", transaction_amount_refunded: 0 }],
  }), null);
  eq("15. campo ausente não vira zero", extrairReembolso({
    payments: [{ status: "approved", total_paid_amount: 120, shipping_cost: 20 }],
  }), null);

  const ordersReembolso = [
    order("REEMBOLSADO", { payments: [{ status: "refunded", transaction_amount_refunded: 100 }] }),
    order("SEM_REEMBOLSO", { payments: [{ status: "approved", transaction_amount_refunded: 0 }] }),
  ];
  const motorReembolso = buildMotorFromOrders({
    orders: ordersReembolso,
    costMap: COST_MAP,
    freteMap: freteMapDe(ordersReembolso),
    clienteSlug: "cliente-teste",
    competencia: "2026-07",
  });
  const compReembolso = componenteDe(motorReembolso, "REEMBOLSADO", "cancelamento_reembolso");
  eq("14. cancelamento_reembolso é negativo", compReembolso.valor, -100);
  eq("14. fonte do reembolso", compReembolso.fonte, "orders_api_payments");
  eq("14. reembolso é dado real", compReembolso.confianca, "real");
  eq("15. ausência de reembolso não gera componente",
    componenteDe(motorReembolso, "SEM_REEMBOLSO", "cancelamento_reembolso"), undefined);
  // Sem dupla contagem: o resultado do pedido não desconta o reembolso.
  eq("14. reembolso não é somado ao resultado do pedido",
    motorReembolso.pedidos.find((p) => p.pedidoId === "REEMBOLSADO").resultado, 40);

  /* ── 16. Guard-rail com claims indisponíveis ────────────────────────── */

  const cenarioFalhaTecnica = servicoComRespostas(() => ({ ok: false, status: 503, data: null }));
  const { resultado: falha503 } = await capturandoLogs(() =>
    cenarioFalhaTecnica.service.buscarClaimsPorPeriodo({
      clienteId: 1, sellerId: 999, ...PERIODO, hoje: HOJE,
    })
  );
  eq("16. retries esgotados em 5xx", cenarioFalhaTecnica.paths.length, 3);
  eq("16. motivo técnico propagado", falha503.motivo, "http_503");
  eq("16. mapa descartado", falha503.claimsMap.size, 0);

  const motorSemClaims = buildMotorFromOrders({
    orders: [order("NAO_VERIFICADO")],
    costMap: COST_MAP,
    freteMap: freteMapDe([order("NAO_VERIFICADO")]),
    claimsMap: falha503.claimsMap,
    claimsIndisponivel: falha503.indisponivel,
    claimsMotivo: falha503.motivo,
    clienteSlug: "cliente-teste",
    competencia: "2026-07",
  });
  eq("16. motor marca claims indisponíveis", motorSemClaims.resumo.claimsIndisponivel, true);
  eq("16. motivo chega ao resumo", motorSemClaims.resumo.claimsMotivo, "http_503");
  eq("16. confiança rebaixada", motorSemClaims.resumo.confianca, "parcial");

  const payloadSemClaims = buildPayloadFromRange(
    { id: 1, slug: "cliente-teste", nome: "Cliente Teste" },
    PERIODO,
    snapshotFromMotor(motorSemClaims)
  );
  eq("16. tela recebe o motivo técnico", payloadSemClaims.resumo.claimsMotivo, "http_503");
  eq("16. confiança parcial na tela", payloadSemClaims.motor.confianca, "parcial");
  eq("16. fechamento não pode concluir", payloadSemClaims.motor.podeConcluir, false);

  /* ── 17. M9 — a composição fecha matematicamente NO BACKEND (a tela não
     tem mais fórmula própria: buildFechamentoResumo/buildFechamentoComponentes/
     fechamentoComposicaoResiduo foram removidas de Portal/fechamentos-api.js;
     Composição/Qualidade da Visão Geral agora só formatam os campos que
     buildResumoFromRange já calcula) ─────────────────────────────────── */

  const tela = carregarTelaFechamento();
  ok("17. computeOrder não existe mais no arquivo real (M9)", tela.computeOrder === undefined);
  ok("17. buildFechamentoResumo não existe mais (M9 — virou buildResumoFromRange no backend)", tela.buildFechamentoResumo === undefined);
  ok("17. buildFechamentoComponentes não existe mais (M9 — Composição só formata summary/filteredSummary)", tela.buildFechamentoComponentes === undefined);
  const fonte = fs.readFileSync(path.join(__dirname, "..", "..", "Portal", "fechamentos-api.js"), "utf8");
  ok("17. a fórmula 'valor - frete - taxas - custo - imposto' não existe mais no arquivo",
    !/valor\s*-\s*\(?o?\.?frete/.test(fonte));

  // Cenário misto: pedido completo, pedido sem frete real, pedido bloqueado por
  // custo ausente (receita existe, resultado não é calculável) e uma devolução.
  const ordersComposicao = [
    order("OK"),
    order("SEM_FRETE"),
    order("BLOQUEADO", {
      order_items: [{
        item: { id: "MLB999", title: "Sem custo", seller_sku: "SKU-9" },
        quantity: 1, unit_price: 591.1, sale_fee: 59,
      }],
    }),
    order("DEVOLVIDO"),
  ];
  const freteMapComposicao = new Map([
    ["SHIP-OK", { valor: 7.5, custoSeller: 7.5, receitaComprador: 19.9, status: "real" }],
    ["SHIP-SEM_FRETE", { valor: null, custoSeller: null, receitaComprador: null, status: "ausente" }],
    ["SHIP-BLOQUEADO", { valor: 9, custoSeller: 9, receitaComprador: null, status: "real" }],
    ["SHIP-DEVOLVIDO", { valor: 3, custoSeller: 3, receitaComprador: null, status: "real" }],
  ]);
  const motorComposicao = buildMotorFromOrders({
    orders: ordersComposicao,
    costMap: COST_MAP,
    freteMap: freteMapComposicao,
    claimsMap: buildClaimsMap([devolucao]),
    claimsIndisponivel: false,
    clienteSlug: "cliente-teste",
    competencia: "2026-07",
  });
  const payloadComposicao = buildPayloadFromRange(
    { id: 1, slug: "cliente-teste", nome: "Cliente Teste" },
    PERIODO,
    snapshotFromMotor(motorComposicao)
  );

  // buildResumoFromRange é a MESMA função que Portal/fechamentos-api.js
  // consome via GET /read (summary/filteredSummary) — não existe mais
  // segunda implementação no frontend para reconciliar contra.
  const resumo = buildResumoFromRange({}, payloadComposicao.pedidos);

  ok("17. receita bloqueada existe e é > 0 (pedido BLOQUEADO sem custo)", resumo.receitaBloqueada > 0);
  eq("17. receita bloqueada bate com o valor real do pedido sem custo", resumo.receitaBloqueada, 591.1);
  ok("17. faturamento dos cards não é reduzido pela receita bloqueada", resumo.faturamento > resumo.receitaBloqueada);

  // A composição (Receita − bloqueada − comissão − custo − imposto − frete)
  // tem de fechar EXATAMENTE no Resultado Parcial exibido — mesma
  // propriedade que a tela antiga provava localmente; agora é uma
  // propriedade do backend, auditada aqui sem nenhuma segunda fórmula.
  const linhas = [
    resumo.faturamento,
    -resumo.receitaBloqueada,
    resumo.comissao == null ? 0 : -resumo.comissao,
    resumo.custoTotal == null ? 0 : -resumo.custoTotal,
    resumo.impostoTotal == null ? 0 : -resumo.impostoTotal,
    resumo.freteTotal == null ? 0 : -resumo.freteTotal,
  ];
  const somaLinhas = Math.round(linhas.reduce((s, v) => s + v, 0) * 100) / 100;
  eq("17. soma das linhas da Composição = Resultado Parcial (resíduo zero)", somaLinhas, resumo.lucroContribuicao);

  // Mesma propriedade também precisa valer sobre um recorte real (não o
  // universo inteiro) — aqui, só os pedidos com resultado calculável.
  const { pedidoMatchesQuick } = require("../services/centralVendas/centralVendasReadService");
  const calculaveis = payloadComposicao.pedidos.filter((p) => pedidoMatchesQuick(p, "calculavel"));
  const resumoCalculaveis = buildResumoFromRange({}, calculaveis);
  const linhasCalc = [
    resumoCalculaveis.faturamento,
    -resumoCalculaveis.receitaBloqueada,
    resumoCalculaveis.comissao == null ? 0 : -resumoCalculaveis.comissao,
    resumoCalculaveis.custoTotal == null ? 0 : -resumoCalculaveis.custoTotal,
    resumoCalculaveis.impostoTotal == null ? 0 : -resumoCalculaveis.impostoTotal,
    resumoCalculaveis.freteTotal == null ? 0 : -resumoCalculaveis.freteTotal,
  ];
  const somaLinhasCalc = Math.round(linhasCalc.reduce((s, v) => s + v, 0) * 100) / 100;
  eq("17. composição também fecha no recorte 'calculável' (resíduo zero)", somaLinhasCalc, resumoCalculaveis.lucroContribuicao);

  console.log(`\n${checks} verificacoes passaram. Pos-venda, receita de envio, reembolso e composicao OK.`);
  console.log("centralVendasClaimsPosVenda.test.js passed");
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
