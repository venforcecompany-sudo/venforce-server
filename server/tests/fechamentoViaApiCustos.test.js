// server/tests/fechamentoViaApiCustos.test.js
//
// Custos no fechamento pela API (custosOrigem = sync | base | upload):
//   - reaplicarCustos chega EXATAMENTE no que o sync gravaria com aquela base:
//     os pedidos são gerados pelo motor real (buildMotorFromOrders), "gravados"
//     no formato do banco com uma base e reaplicados com outra; o resultado tem
//     que ser igual ao do motor rodado direto com a outra base;
//   - upload cobrindo tudo e só parte (unmatchedIds), base atual ≠ base do
//     sync, conta sem base + base → 409, planilha inválida → 422, upload sem
//     arquivo → 400, origem inválida → 400;
//   - receita/tarifa/frete persistidos não mudam; regra de financeiro
//     pendente continua fora do LC;
//   - status.base (vinculada, aplicadaNoSync).
//
// NENHUM banco real: dependências injetadas.

process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/teste-sem-banco";

const assert = require("assert");
const XLSX = require("xlsx");

const { parseSpreadsheet } = require("../utils/excelUtils");
const { buildMotorFromOrders, buildCostMap } = require("../services/centralVendas/centralVendasSyncService");
const { buildCentralCostMap } = require("../services/fechamentoFinanceiro/meliFinanceiroService");
const {
  obterStatusFechamentoViaApi,
  gerarFechamentoViaApi,
  consolidarFechamentoApi,
  reaplicarCustos,
  montarBaseStatus,
} = require("../services/fechamentoFinanceiro/fechamentoViaApiService");

let checks = 0;
let concluido = false;
process.on("exit", () => {
  if (!concluido) {
    console.error(`fechamentoViaApiCustos.test.js: NÃO concluiu (parou após ${checks} verificações)`);
    process.exitCode = 1;
  }
});
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}
async function rejeita(label, promise, esperado) {
  let erro = null;
  try {
    await promise;
  } catch (err) {
    erro = err;
  }
  ok(`${label} (lançou)`, erro !== null);
  eq(`${label} status`, erro.statusCode, esperado.statusCode);
  if (esperado.code) eq(`${label} código`, erro.code, esperado.code);
}

// ─── fixtures: pedidos da Orders API pelo motor REAL ────────────────────────

function item({ mlb, qty, price, saleFee }) {
  return { item: { id: mlb, title: `Produto ${mlb}`, seller_sku: `SKU-${mlb}` }, quantity: qty, unit_price: price, sale_fee: saleFee };
}
function order({ id, status = "paid", shipmentId = null, items }) {
  return {
    id,
    pack_id: null,
    date_created: "2026-09-10T10:00:00.000-03:00",
    status,
    shipping: shipmentId ? { id: shipmentId, logistic_type: "cross_docking" } : {},
    order_items: items,
  };
}

const ORDERS = [
  // completo, 1 item
  order({ id: "P1", shipmentId: "S1", items: [item({ mlb: "MLB1", qty: 2, price: 50, saleFee: 8 })] }),
  // completo, multi-item (frete rateado)
  order({
    id: "P2",
    shipmentId: "S2",
    items: [item({ mlb: "MLB2", qty: 1, price: 100, saleFee: 10 }), item({ mlb: "MLB3", qty: 3, price: 50, saleFee: 5 })],
  }),
  // tarifa ausente → financeiro pendente (fora do LC)
  order({ id: "P3", shipmentId: "S3", items: [item({ mlb: "MLB1", qty: 1, price: 50, saleFee: null })] }),
  // sem frete real (sem shipment) → financeiro pendente
  order({ id: "P4", items: [item({ mlb: "MLB4", qty: 1, price: 80, saleFee: 8 })] }),
  // cancelado: fora do resultado
  order({ id: "P5", status: "cancelled", shipmentId: "S5", items: [item({ mlb: "MLB2", qty: 1, price: 100, saleFee: 10 })] }),
];
const FRETES = new Map([
  ["S1", { valor: 10, status: "real" }],
  ["S2", { valor: 20, status: "real" }],
  ["S3", { valor: 7, status: "real" }],
  ["S5", { valor: 9, status: "real" }],
]);

function rodarMotor(costMap) {
  return buildMotorFromOrders({ orders: ORDERS, costMap, freteMap: FRETES, clienteSlug: "rikam", competencia: "2026-09" });
}

// Converte o resultado do motor (camelCase) para as linhas que
// loadPedidosByImportIds devolve (snake_case, ids de linha), como o
// repositório grava.
function comoNoBanco(motor) {
  const pedidoRowId = new Map();
  const pedidos = motor.pedidos.map((p, i) => {
    pedidoRowId.set(p.pedidoId, i + 1);
    return {
      id: i + 1,
      pedido_id: p.pedidoId,
      data_pedido: "2026-09-10",
      status: p.status,
      confianca: p.confianca,
      quantidade_itens: p.quantidadeItens,
      faturamento: String(p.faturamento),
      lucro_contribuicao: p.lucroContribuicao === null ? null : String(p.lucroContribuicao),
      resultado: p.resultado === null ? null : String(p.resultado),
      margem_contribuicao_percentual: p.margemContribuicaoPercentual,
      pendencias_json: [...p.pendencias],
    };
  });
  const itemRowId = new Map();
  const itens = motor.itens.map((it, i) => {
    itemRowId.set(it.itemId, 100 + i);
    return {
      id: 100 + i,
      pedido_row_id: pedidoRowId.get(it.pedidoId),
      pedido_id: it.pedidoId,
      item_id: it.itemId,
      mlb: it.mlb,
      sku: it.sku,
      titulo: it.titulo,
      quantidade: String(it.quantidade),
      valor_unitario: it.valorUnitario === null ? null : String(it.valorUnitario),
      receita_produto: it.receitaProduto === null ? null : String(it.receitaProduto),
      custo_produto: it.custoProduto === null ? null : String(it.custoProduto),
      imposto_interno: it.impostoInterno === null ? null : String(it.impostoInterno),
      lucro_contribuicao: it.lucroContribuicao === null ? null : String(it.lucroContribuicao),
      resultado: it.resultado === null ? null : String(it.resultado),
      margem_contribuicao_percentual: it.margemContribuicaoPercentual,
      confianca: it.confianca,
      pendencias_json: [...it.pendencias],
    };
  });
  const componentes = motor.componentes.map((c, i) => ({
    id: 1000 + i,
    pedido_row_id: pedidoRowId.get(c.pedidoId),
    item_row_id: c.itemId ? itemRowId.get(c.itemId) : null,
    pedido_id: c.pedidoId,
    item_id: c.itemId,
    tipo: c.tipo,
    valor: c.valor === null ? null : String(c.valor),
    fonte: c.fonte,
    confianca: c.confianca,
  }));
  return { pedidos, itens, componentes };
}

const num = (v) => (v === null || v === undefined ? null : Number(v));
const resumoItens = (itens) =>
  itens.map((i) => ({
    mlb: i.mlb,
    custo: num(i.custo_produto ?? i.custoProduto),
    imposto: num(i.imposto_interno ?? i.impostoInterno),
    lc: num(i.lucro_contribuicao ?? i.lucroContribuicao),
    confianca: i.confianca,
    pendencias: [...(i.pendencias_json ?? i.pendencias)].sort(),
  }));
const resumoPedidos = (pedidos) =>
  pedidos.map((p) => ({
    fat: num(p.faturamento),
    lc: num(p.lucro_contribuicao ?? p.lucroContribuicao),
    confianca: p.confianca,
    pendencias: [...(p.pendencias_json ?? p.pendencias)].sort(),
  }));

// Base A (a do sync) e base B (a atual), com valores diferentes.
const CUSTOS_A = [
  { produto_id: "MLB1", custo_produto: 20, imposto_percentual: 10 },
  { produto_id: "MLB2", custo_produto: 40, imposto_percentual: 5 },
];
const CUSTOS_B = [
  { produto_id: "MLB1", custo_produto: 15, imposto_percentual: 6 },
  { produto_id: "MLB2", custo_produto: 30, imposto_percentual: 0.05 }, // fração: o motor trata como 5%
  { produto_id: "MLB3", custo_produto: 12, imposto_percentual: 6 },
  { produto_id: "MLB4", custo_produto: 25, imposto_percentual: 6 },
];

function planilhaCustos(linhas, header = ["# de anúncio", "Preço de custo", "Imposto"]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...linhas]), "Custos");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

const AJUSTES_ZERO = { ads: 0, venforce: 0, affiliates: 0, fullCost: 0, additionalCosts: 0 };

(async function main() {
  // ─── 1. reaplicar = motor com a outra base ──────────────────────────────

  console.log("\n▸ reaplicarCustos chega no mesmo resultado que o sync com a outra base");

  const gravadoComA = comoNoBanco(rodarMotor(buildCostMap(CUSTOS_A)));
  const mapaB = buildCostMap(CUSTOS_B);
  const { getCost } = require("../services/centralVendas/centralVendasSyncService");
  const reaplicado = reaplicarCustos({ ...gravadoComA, obterCusto: (mlb) => getCost(mapaB, mlb) });
  const esperadoB = rodarMotor(mapaB);

  eq("itens: custo/imposto/LC/confiança/pendências iguais ao motor com B", resumoItens(reaplicado.itens), resumoItens(esperadoB.itens));
  eq("pedidos: faturamento/LC/confiança/pendências iguais ao motor com B", resumoPedidos(reaplicado.pedidos), resumoPedidos(esperadoB.pedidos));
  eq(
    "receita do item não muda (é da API)",
    reaplicado.itens.map((i) => i.receita_produto),
    gravadoComA.itens.map((i) => i.receita_produto)
  );
  eq(
    "tarifa/frete/reembolso persistidos não mudam",
    reaplicado.componentes.filter((c) => !["custo_produto", "imposto_interno"].includes(c.tipo)),
    gravadoComA.componentes.filter((c) => !["custo_produto", "imposto_interno"].includes(c.tipo))
  );
  const custoCompB = reaplicado.componentes.find((c) => c.tipo === "custo_produto" && c.item_id.startsWith("P2:MLB3"));
  eq("componente de custo acompanha o item (MLB3 com B: 12 × 3)", custoCompB.valor, -36);
  ok("não muta as linhas de entrada", gravadoComA.itens.find((i) => i.mlb === "MLB3").custo_produto === null);

  // Consolidado com B reaplicado = consolidado do "sync com B".
  const consReaplicado = consolidarFechamentoApi({ ...reaplicado, ajustes: AJUSTES_ZERO });
  const consSyncB = consolidarFechamentoApi({ ...comoNoBanco(esperadoB), ajustes: AJUSTES_ZERO });
  eq("summary igual ao do sync com B", consReaplicado.summary, consSyncB.summary);
  eq("detailedRows iguais ao do sync com B", consReaplicado.detailedRows, consSyncB.detailedRows);

  // ─── 2. gerarFechamentoViaApi com dependências fake ─────────────────────

  const impSet = {
    id: 9, competencia: "2026-09", publication_status: "published",
    coverage_date_from: "2026-09-01", coverage_date_to: "2026-09-30", published_at: "2026-10-02T03:00:00Z", sync_run_id: 3,
  };

  function fakeDeps({ linhas, baseSync = null, baseAtual = null, custosBase = [], imports = [impSet] } = {}) {
    const chamadas = { custosBaseId: [] };
    return {
      chamadas,
      db: {
        async query(sql) {
          if (sql.includes("JOIN bases b ON b.id = COALESCE")) return { rows: baseSync ? [baseSync] : [] };
          if (sql.includes("FROM bases b")) return { rows: baseAtual ? [baseAtual] : [] };
          if (sql.includes("status IN ('queued','running')")) return { rows: [] };
          if (sql.match(/^\s*(INSERT|UPDATE|DELETE)/i)) throw new Error("o fechamento pela API não grava nada");
          throw new Error(`SQL inesperado no teste: ${sql.slice(0, 80)}`);
        },
      },
      async resolverClientePorIdOuSlug() {
        return { id: 7, slug: "rikam_loja" };
      },
      async obterConta() {
        return { id: 48, cliente_id: 7, nome: "Rikam", ativo: true, marketplace: "meli" };
      },
      async resolveImportsForRange() {
        return { imports, competencias: [] };
      },
      async loadPedidosByImportIds() {
        return linhas;
      },
      async obterBaseDaConta() {
        return baseAtual ? { base_id: baseAtual.id, slug: baseAtual.slug, nome: baseAtual.nome } : { base_id: null };
      },
      async buscarCustosPorBaseId(baseId) {
        chamadas.custosBaseId.push(baseId);
        return custosBase;
      },
      hojeIso: "2026-11-10",
    };
  }
  const pedir = (extra, deps) =>
    gerarFechamentoViaApi(
      { clienteSlugRaw: "rikam_loja", clienteContaIdRaw: 48, periodoRaw: "2026-09", ajustesRaw: {}, ...extra },
      deps
    );

  // Conta SEM base no sync: tudo gravado sem custo (o caso real da Rikam).
  const gravadoSemBase = comoNoBanco(rodarMotor(buildCostMap([])));

  console.log("\n▸ sync (padrão): sem base no sync, LC null");

  const respSync = await pedir({}, fakeDeps({ linhas: gravadoSemBase }));
  eq("costsSource sync", respSync.costsSource, "sync");
  eq("costsBase null (run sem base)", respSync.costsBase, null);
  eq("LC null (nunca 0)", respSync.summary.contributionProfitTotal, null);
  eq("cobertura 0%", respSync.summary.calculatedCoveragePercent, 0);

  console.log("\n▸ upload cobrindo tudo");

  const linhasTodas = [["MLB1", 15, 6], ["MLB2", 30, 5], ["MLB3", 12, 6], ["MLB4", 25, 6]];
  const bufferTodas = planilhaCustos(linhasTodas);
  const respTodas = await pedir(
    { custosOrigemRaw: "upload", custosArquivo: { buffer: bufferTodas, originalname: "Custos - RIKAM - MeLi.xlsx" } },
    fakeDeps({ linhas: gravadoSemBase })
  );
  const esperadoPlanilha = consolidarFechamentoApi({
    ...comoNoBanco(rodarMotor(buildCentralCostMap(parseSpreadsheet(bufferTodas)))),
    ajustes: AJUSTES_ZERO,
  });
  eq("costsSource upload", respTodas.costsSource, "upload");
  eq("costsBase null em upload", respTodas.costsBase, null);
  eq("unmatchedIds vazio", respTodas.unmatchedIds, []);
  eq("LC = sync com a planilha como base", respTodas.summary.contributionProfitTotal, esperadoPlanilha.summary.contributionProfitTotal);
  ok("LC calculado (não null)", typeof respTodas.summary.contributionProfitTotal === "number");
  eq("cobertura 100%", respTodas.summary.calculatedCoveragePercent, 100);
  eq("FAT não muda com o custo", respTodas.summary.grossRevenueTotal, respSync.summary.grossRevenueTotal);
  ok("financeiro pendente continua fora do LC", respTodas.summary.revenuePendingFinancial > 0
    && respTodas.summary.revenueCalculable === respTodas.summary.grossRevenueTotal - respTodas.summary.revenuePendingFinancial);
  ok("nota cita a planilha enviada", respTodas.summary.executiveNotes.some((n) => n.includes("Custos - RIKAM - MeLi.xlsx")));

  console.log("\n▸ upload cobrindo só parte");

  const bufferParte = planilhaCustos([["MLB1", 15, 6], ["MLB2", 30, 5]]);
  const respParte = await pedir(
    { custosOrigemRaw: "upload", custosArquivo: { buffer: bufferParte } },
    fakeDeps({ linhas: gravadoSemBase })
  );
  eq("unmatchedIds = anúncios sem custo na planilha", [...respParte.unmatchedIds].sort(), ["MLB3", "MLB4"]);
  ok("cobertura parcial", respParte.summary.calculatedCoveragePercent > 0 && respParte.summary.calculatedCoveragePercent < 100);
  const detalheMlb3 = respParte.detailedRows.find((r) => r["# de anúncio"] === "MLB3");
  eq("anúncio sem custo: custo total null", detalheMlb3["Preço de custo total"], null);

  console.log("\n▸ base atual ≠ base do sync");

  const gravadoComA2 = comoNoBanco(rodarMotor(buildCostMap(CUSTOS_A)));
  const depsBase = fakeDeps({
    linhas: gravadoComA2,
    baseSync: { id: 2, slug: "base-a", nome: "Base A", aplicada_em: "2026-10-02T02:00:00Z" },
    baseAtual: { id: 3, slug: "base-b", nome: "Base B", atualizada_em: "2026-10-20T12:00:00Z" },
    custosBase: CUSTOS_B,
  });
  const respBase = await pedir({ custosOrigemRaw: "base" }, depsBase);
  eq("costsSource base", respBase.costsSource, "base");
  eq("costsBase = base atual", respBase.costsBase, { id: 3, slug: "base-b", nome: "Base B" });
  eq("custos lidos da base atual", depsBase.chamadas.custosBaseId, [3]);
  eq("LC = sync com a base B", respBase.summary.contributionProfitTotal, consSyncB.summary.contributionProfitTotal);
  const respSyncA = await pedir({}, depsBase);
  eq("sync continua com a base do run", respSyncA.costsBase, { id: 2, slug: "base-a", nome: "Base A" });
  ok("e com o LC gravado (A ≠ B)", respSyncA.summary.contributionProfitTotal !== respBase.summary.contributionProfitTotal);

  console.log("\n▸ erros");

  await rejeita(
    "sem base + custosOrigem=base",
    pedir({ custosOrigemRaw: "base" }, fakeDeps({ linhas: gravadoSemBase })),
    { statusCode: 409, code: "BASE_NAO_VINCULADA" }
  );
  await rejeita(
    "upload sem arquivo",
    pedir({ custosOrigemRaw: "upload" }, fakeDeps({ linhas: gravadoSemBase })),
    { statusCode: 400, code: "CUSTOS_ARQUIVO_OBRIGATORIO" }
  );
  await rejeita(
    "origem inválida",
    pedir({ custosOrigemRaw: "planilha" }, fakeDeps({ linhas: gravadoSemBase })),
    { statusCode: 400, code: "CUSTOS_ORIGEM_INVALIDA" }
  );
  await rejeita(
    "arquivo com origem sync (seria ignorado em silêncio)",
    pedir({ custosOrigemRaw: "sync", custosArquivo: { buffer: bufferTodas } }, fakeDeps({ linhas: gravadoSemBase })),
    { statusCode: 400, code: "CUSTOS_ORIGEM_INVALIDA" }
  );
  await rejeita(
    "arquivo que não é planilha",
    pedir({ custosOrigemRaw: "upload", custosArquivo: { buffer: Buffer.from("isto não é xlsx") } }, fakeDeps({ linhas: gravadoSemBase })),
    { statusCode: 422, code: "CUSTOS_PLANILHA_INVALIDA" }
  );
  await rejeita(
    "planilha sem coluna de custo reconhecida",
    pedir(
      { custosOrigemRaw: "upload", custosArquivo: { buffer: planilhaCustos([["MLB1", "abc"]], ["Produto", "Observação"]) } },
      fakeDeps({ linhas: gravadoSemBase })
    ),
    { statusCode: 422, code: "CUSTOS_PLANILHA_INVALIDA" }
  );
  await rejeita(
    "planilha só com custo zero",
    pedir(
      { custosOrigemRaw: "upload", custosArquivo: { buffer: planilhaCustos([["MLB1", 0, 6]]) } },
      fakeDeps({ linhas: gravadoSemBase })
    ),
    { statusCode: 422, code: "CUSTOS_PLANILHA_INVALIDA" }
  );
  await rejeita(
    "upload sem sync publicado continua 409 CENTRAL_SEM_SYNC",
    pedir({ custosOrigemRaw: "upload", custosArquivo: { buffer: bufferTodas } }, fakeDeps({ linhas: gravadoSemBase, imports: [] })),
    { statusCode: 409, code: "CENTRAL_SEM_SYNC" }
  );

  // ─── 3. status.base ─────────────────────────────────────────────────────

  console.log("\n▸ status.base");

  const statusSemBase = await obterStatusFechamentoViaApi(
    { clienteSlugRaw: "rikam_loja", clienteContaIdRaw: 48, periodoRaw: "2026-09" },
    fakeDeps({ linhas: gravadoSemBase })
  );
  eq("sem base vinculada", statusSemBase.base, {
    vinculada: false, id: null, slug: null, nome: null, atualizadaEm: null, aplicadaNoSync: false,
  });

  const statusTrocada = await obterStatusFechamentoViaApi(
    { clienteSlugRaw: "rikam_loja", clienteContaIdRaw: 48, periodoRaw: "2026-09" },
    depsBase
  );
  eq("base trocada depois do sync", statusTrocada.base, {
    vinculada: true, id: 3, slug: "base-b", nome: "Base B", atualizadaEm: "2026-10-20T12:00:00.000Z", aplicadaNoSync: false,
  });

  const baseSyncA = { id: 2, slug: "base-a", nome: "Base A", aplicadaEm: "2026-10-02T02:00:00.000Z" };
  eq(
    "mesma base, alterada depois do sync",
    montarBaseStatus({ id: 2, slug: "base-a", nome: "Base A", atualizadaEm: "2026-10-05T00:00:00.000Z" }, baseSyncA).aplicadaNoSync,
    false
  );
  eq(
    "mesma base, sem alteração depois do sync",
    montarBaseStatus({ id: 2, slug: "base-a", nome: "Base A", atualizadaEm: "2026-09-30T00:00:00.000Z" }, baseSyncA).aplicadaNoSync,
    true
  );
  eq(
    "run sem base: não foi aplicada",
    montarBaseStatus({ id: 2, slug: "base-a", nome: "Base A", atualizadaEm: null }, null).aplicadaNoSync,
    false
  );

  const statusSemSync = await obterStatusFechamentoViaApi(
    { clienteSlugRaw: "rikam_loja", clienteContaIdRaw: 48, periodoRaw: "2026-09" },
    fakeDeps({ linhas: gravadoSemBase, imports: [], baseAtual: { id: 3, slug: "base-b", nome: "Base B", atualizada_em: null } })
  );
  eq("sem sync: base vinculada mas não aplicada", [statusSemSync.base.vinculada, statusSemSync.base.aplicadaNoSync], [true, false]);

  concluido = true;
  console.log(`\n✓ fechamentoViaApiCustos.test.js — ${checks} verificações`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
