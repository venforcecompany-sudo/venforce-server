// server/tests/fechamentoViaApiService.test.js
//
// Fechamento financeiro do Mercado Livre pela API (Central de Vendas) —
// services/fechamentoFinanceiro/fechamentoViaApiService.js. Cobre:
//   - paridade de chaves do summary com processMeli (rodado de verdade sobre
//     uma planilha real, não sobre lista escrita à mão);
//   - FAT/cobertura = cálculo oficial da Central; LC = soma do LC dos pedidos
//     com financeiro completo e custo (como na planilha). Pendente fica fora do
//     LC, e LC sem nenhum pedido na base é null, nunca zero;
//   - pedido cancelado fora do resultado; item sem custo em unmatchedIds;
//   - financeiro pendente (tarifa/frete ausentes) e aviso correspondente;
//   - ADS/Venforce entram só no Resultado Final e nos índices; LC null → null;
//   - sync completo, incompleto (cobertura curta), mês em andamento (até ontem)
//     e ausência de sync (409 CENTRAL_SEM_SYNC, status com disponivel:false);
//   - validações: período, conta obrigatória, conta de outro cliente, conta
//     desativada, conta que não é Mercado Livre, ajuste monetário ambíguo.
//
// NENHUM banco real: dependências injetadas; DATABASE_URL aponta para porta
// morta antes de qualquer require.

process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/teste-sem-banco";

const assert = require("assert");
const XLSX = require("xlsx");

const { parseSpreadsheet } = require("../utils/excelUtils");
const { processMeli } = require("../services/fechamentoFinanceiro/meliFinanceiroService");
const {
  obterStatusFechamentoViaApi,
  gerarFechamentoViaApi,
  consolidarFechamentoApi,
  parseAjustesFechamentoApi,
  montarSync,
  hojeSaoPaulo,
  financeiroCompleto,
} = require("../services/fechamentoFinanceiro/fechamentoViaApiService");

let checks = 0;
let concluido = false;
process.on("exit", () => {
  if (!concluido) {
    console.error(`fechamentoViaApiService.test.js: NÃO concluiu (parou após ${checks} verificações)`);
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

// ─── fixtures ───────────────────────────────────────────────────────────────

(async function main() {

// Linhas no formato de linha de pedido/item usado por loadPedidosByImportIds.
const PEDIDOS = [
  { id: 1, pedido_id: "P1", status: "pago", confianca: "confiavel", faturamento: "300", lucro_contribuicao: "100", pendencias_json: [], data_pedido: "2026-10-10" },
  { id: 2, pedido_id: "P2", status: "pago", confianca: "parcial", faturamento: "100", lucro_contribuicao: "20", pendencias_json: ["tarifa_venda_ausente"], data_pedido: "2026-10-11" },
  { id: 3, pedido_id: "P3", status: "pago", confianca: "bloqueado", faturamento: "50", lucro_contribuicao: null, pendencias_json: ["custo_produto_ausente"], data_pedido: "2026-10-12" },
  { id: 4, pedido_id: "P4", status: "cancelado", confianca: "confiavel", faturamento: "80", lucro_contribuicao: "10", pendencias_json: [], data_pedido: "2026-10-13" },
];

const ITENS = [
  { pedido_row_id: 1, mlb: "MLB111", sku: "S1", titulo: "Produto A", quantidade: 1, valor_unitario: "300", receita_produto: "300", custo_produto: "80", lucro_contribuicao: "100", pendencias_json: [] },
  { pedido_row_id: 2, mlb: "MLB222", sku: "S2", titulo: "Produto B", quantidade: 1, valor_unitario: "100", receita_produto: "100", custo_produto: "30", lucro_contribuicao: "20", pendencias_json: ["tarifa_venda_ausente"] },
  { pedido_row_id: 3, mlb: "MLB333", sku: null, titulo: "Produto C", quantidade: 1, valor_unitario: "50", receita_produto: "50", custo_produto: null, lucro_contribuicao: null, pendencias_json: ["custo_produto_ausente"] },
  { pedido_row_id: 4, mlb: "MLB444", sku: "S4", titulo: "Produto D", quantidade: 1, valor_unitario: "80", receita_produto: "80", custo_produto: "40", lucro_contribuicao: "10", pendencias_json: [] },
];

const COMPONENTES = [
  { pedido_row_id: 4, item_id: null, tipo: "cancelamento_reembolso", valor: "-80", fonte: "orders_api_payments", confianca: "real" },
];

const AJUSTES_ZERO = { ads: 0, venforce: 0, affiliates: 0, fullCost: 0, additionalCosts: 0 };

// ─── 1. paridade de chaves com processMeli (planilha real) ──────────────────

console.log("\n▸ Paridade: chaves do summary = chaves de processMeli");

const HEADER = [
  "N.º de venda", "Data da venda", "# de anúncio", "Título do anúncio", "Unidades",
  "Preço unitário de venda do anúncio (BRL)", "Receita por produtos (BRL)", "Total (BRL)",
  "Tarifa de venda e impostos (BRL)", "Tarifas de envio (BRL)", "Cancelamentos e reembolsos (BRL)",
  "Descontos e bônus", "Estado",
];
const LINHAS_PLANILHA = [
  ["5001", "2026-06-10", "", "", "", "", 300, 260, -40, 0, 0, 0, "Pago"],
  ["5001", "2026-06-10", "MLB111", "Produto A", 1, 200, "", "", "", "", "", "", "Pago"],
  ["5001", "2026-06-10", "MLB222", "Produto B", 1, 100, "", "", "", "", "", "", "Pago"],
  ["5002", "2026-06-11", "MLB333", "Produto C", 2, 50, 100, 90, -10, 0, 0, 0, "Pago"],
];
const CUSTOS_PLANILHA = [
  { "# de anuncio": "MLB111", custo: 80, imposto: 10 },
  { "# de anuncio": "MLB222", custo: 30, imposto: 10 },
  { "# de anuncio": "MLB333", custo: 20, imposto: 10 },
];
const aoa = [HEADER, ...LINHAS_PLANILHA];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Vendas");
const bufferPlanilha = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
const salesRowsRaw = parseSpreadsheet(bufferPlanilha, 0);
const referencia = processMeli(salesRowsRaw, CUSTOS_PLANILHA, 10, 20, 5).summary;

const consolidadoParidade = consolidarFechamentoApi({
  pedidos: PEDIDOS,
  itens: ITENS,
  componentes: COMPONENTES,
  ajustes: { ads: 10, venforce: 20, affiliates: 5, fullCost: 0, additionalCosts: 0 },
});
eq(
  "summary tem exatamente as chaves de processMeli",
  Object.keys(consolidadoParidade.summary).sort(),
  Object.keys(referencia).sort()
);

// ─── 2. consolidação: números oficiais, cobertura, pendências ───────────────

console.log("\n▸ Consolidação do mês completo");

const c = consolidarFechamentoApi({
  pedidos: PEDIDOS,
  itens: ITENS,
  componentes: COMPONENTES,
  ajustes: { ...AJUSTES_ZERO, ads: 100, venforce: 50 },
});
const s = c.summary;
eq("FAT bruto = validos (sem o cancelado)", s.grossRevenueTotal, 450);
eq("receita com custo = confiavel+parcial", s.revenueWithCost, 400);
eq("receita sem custo = bloqueada", s.revenueWithoutCost, 50);
eq("cobertura da base (%)", s.calculatedCoveragePercent, 88.89);
eq("confiança parcial (há receita sem custo)", s.financialConfidence, "parcial");
// Base do LC = pedidos com financeiro completo e custo. P2 (tarifa pendente) e
// P3 (sem custo) ficam fora: só P1 entra. Não é o LC do resumo_json (120).
eq("LC = soma do LC dos pedidos com financeiro completo e custo", s.contributionProfitTotal, 100);
eq("base do LC = FAT dos pedidos da base (P1)", s.revenueCalculable, 300);
eq("MC = LC / base do LC (fração)", s.averageContributionMargin, 100 / 300);
eq("Resultado Final = LC - ADS - Venforce", s.finalResult, -50);
eq("MC final = Resultado / base do LC", s.finalMarginCalculated, -50 / 300);
eq("MC de contribuição usa a mesma base", s.contributionMarginCalculated, 100 / 300);
eq("profitCoversRevenue = base do LC", s.profitCoversRevenue, 300);
eq("TACoS = ADS / FAT total", s.tacos, 100 / 450);
eq("TACoX = (ADS+Venforce) / FAT total", s.tacox, 150 / 450);
eq("ADS registrado no summary", s.adsTotal, 100);
eq("pedido cancelado fora do resultado: contagem", s.excludedStatusCount, 1);
eq("pedido cancelado fora do resultado: valor", s.excludedStatusRevenue, 80);
eq("reembolso total (negativo, como a planilha)", s.refundsTotal, -80);
eq("pedidos com reembolso", s.refundsCount, 1);
eq("receita dos pedidos reembolsados", s.lostRevenueTotal, 80);
eq("financeiro pendente = pedido sem tarifa", s.revenuePendingFinancial, 100);
eq("financeiro disponível", s.revenueWithFinancialData, 350);
eq("cobertura financeira (%)", s.financialDataCoveragePercent, 77.78);
eq("aviso de financeiro pendente existe", s.pendingFinancialWarning !== null, true);
eq("sem fonte na API: lucro pago null", s.paidRevenueTotal, null);
eq("sem fonte na API: ajuste de plataforma null", s.platformAdjustmentTotal, null);
eq("sem fonte na API: conflito de custo null", s.costConflicts, null);
eq("item sem custo vira unmatchedIds", c.unmatchedIds, ["MLB333"]);
eq("receita sem custo vai para ignoredRevenue", c.ignoredRevenue, 50);
eq("emptySales = false com vendas", c.emptySales, false);
eq("message com anúncio sem custo", c.message.startsWith("Alguns anúncios"), true);

const porMlb = Object.fromEntries(c.detailedRows.map((r) => [r["# de anúncio"], r]));
eq("detalhe: 3 anúncios válidos (cancelado fora)", c.detailedRows.length, 3);
eq("detalhe: anúncio sem custo fica 'sem custo'", porMlb.MLB333["Cobertura de custo"], "sem custo");
eq("detalhe: custo do anúncio sem custo é null (não 0)", porMlb.MLB333["Preço de custo total"], null);
eq("detalhe: tarifa pendente vira 'financeiro pendente'", porMlb.MLB222["Cobertura de custo"], "financeiro pendente");
eq("detalhe: anúncio com financeiro pendente fica fora do LC (null, não 20)", porMlb.MLB222.LC, null);
eq("detalhe: anúncio com financeiro pendente sem MC", porMlb.MLB222.MC, null);
eq("detalhe: receita pendente continua em Venda Total", porMlb.MLB222["Venda Total"], 100);
eq("detalhe: único anúncio com LC é o da base (MLB111); soma = LC do summary", porMlb.MLB111.LC, s.contributionProfitTotal);
eq("detalhe: cancelado (MLB444) não aparece no detalhamento", porMlb.MLB444, undefined);
eq("detalhe: anúncio completo fica 'com custo'", porMlb.MLB111["Cobertura de custo"], "com custo");
eq("detalhe: MC em percentual como na planilha", porMlb.MLB111.MC, 33.33);

ok("nota de fechamento parcial presente", s.executiveNotes.some((n) => n.startsWith("Fechamento parcial")));
ok("nota da fonte API presente", s.executiveNotes.some((n) => n.includes("API do Mercado Livre")));

// ─── 3. LC null nunca vira 0 ────────────────────────────────────────────────

console.log("\n▸ Sem LC: nada vira 0 inventado");

const semLc = consolidarFechamentoApi({
  pedidos: [PEDIDOS[2]],
  itens: [ITENS[2]],
  componentes: [],
  ajustes: { ...AJUSTES_ZERO, ads: 30 },
});
eq("LC null", semLc.summary.contributionProfitTotal, null);
eq("Resultado Final null (não -30)", semLc.summary.finalResult, null);
eq("MC null", semLc.summary.averageContributionMargin, null);
eq("MC final null", semLc.summary.finalMarginCalculated, null);
eq("TACoS ainda calculável (usa FAT)", semLc.summary.tacos, 30 / 50);

console.log("\n▸ Todos os pedidos com financeiro pendente: LC null, nunca zero");

const tudoPendente = consolidarFechamentoApi({
  pedidos: [PEDIDOS[1]], // P2: com custo, mas tarifa de venda pendente
  itens: [ITENS[1]],
  componentes: [],
  ajustes: { ...AJUSTES_ZERO, ads: 10 },
});
eq("LC null quando nenhum pedido tem financeiro completo", tudoPendente.summary.contributionProfitTotal, null);
eq("base do LC zero (nada calculável)", tudoPendente.summary.revenueCalculable, 0);
eq("Resultado Final null", tudoPendente.summary.finalResult, null);
eq("MC null", tudoPendente.summary.averageContributionMargin, null);
eq("faturamento continua incluindo o pendente", tudoPendente.summary.grossRevenueTotal, 100);
eq("pendente aparece como receita pendente", tudoPendente.summary.revenuePendingFinancial, 100);
ok("aviso de financeiro pendente presente", tudoPendente.summary.pendingFinancialWarning !== null);

console.log("\n▸ Pedido com tarifa pendente não entra no LC mesmo com custo e LC calculado");

const mistoPendente = consolidarFechamentoApi({
  pedidos: [PEDIDOS[0], PEDIDOS[1]], // P1 completo (LC 100) + P2 pendente (LC 20 não entra)
  itens: [ITENS[0], ITENS[1]],
  componentes: [],
  ajustes: AJUSTES_ZERO,
});
eq("LC só do pedido completo (100, não 120)", mistoPendente.summary.contributionProfitTotal, 100);
eq("base do LC só do completo (300)", mistoPendente.summary.revenueCalculable, 300);
eq("pendente contado à parte (100)", mistoPendente.summary.revenuePendingFinancial, 100);

// ─── 4. financeiroCompleto e parse de ajustes ───────────────────────────────

console.log("\n▸ Financeiro completo e ajustes monetários");

eq("pedido com tarifa e frete é completo", financeiroCompleto({ pendencias_json: [] }), true);
eq("pedido sem tarifa é pendente", financeiroCompleto({ pendencias_json: ["tarifa_venda_ausente"] }), false);
eq("pedido sem frete é pendente", financeiroCompleto({ pendencias_json: ["frete_seller_ausente"] }), false);
eq("pendências como texto JSON", financeiroCompleto({ pendencias_json: '["frete_seller_ausente"]' }), false);

const aj = parseAjustesFechamentoApi({ ads: "1.234,56", venforce: "", affiliates: "0", fullCost: undefined, additionalCosts: 10 });
eq("ADS pt-BR", aj.ads, 1234.56);
eq("campo vazio vale zero", aj.venforce, 0);
eq("ausente vale zero", aj.fullCost, 0);
eq("número puro", aj.additionalCosts, 10);

// ─── 5. sync: completo, incompleto, em andamento ────────────────────────────

console.log("\n▸ Sincronização");

const CTX_BASE = {
  cliente: { id: 7, slug: "cli" },
  conta: { id: 48, nome: "Conta A", marketplace: "meli" },
  competencia: "2026-10",
  inicio: "2026-10-01",
  fim: "2026-10-31",
  esperadoAte: "2026-10-31",
};
const syncCompleto = montarSync(
  { id: 9, coverage_date_from: "2026-10-01", coverage_date_to: "2026-10-31", published_at: "2026-11-09T03:12:00Z" },
  CTX_BASE
);
eq("mês passado completo", syncCompleto.completo, true);
eq("cobertura de/até", [syncCompleto.coberturaDe, syncCompleto.coberturaAte], ["2026-10-01", "2026-10-31"]);
eq("publicadoEm em ISO", syncCompleto.publicadoEm, "2026-11-09T03:12:00.000Z");
eq("sem motivo quando completo", syncCompleto.motivoIncompleto, null);

const syncCurto = montarSync(
  { id: 9, coverage_date_from: "2026-10-01", coverage_date_to: "2026-10-20", published_at: null },
  CTX_BASE
);
eq("cobertura curta = incompleto", syncCurto.completo, false);
ok("motivo cita até quando foi sincronizado", syncCurto.motivoIncompleto.includes("até 2026-10-20"));

const syncComecoTarde = montarSync(
  { id: 9, coverage_date_from: "2026-10-05", coverage_date_to: "2026-10-31", published_at: null },
  CTX_BASE
);
eq("início tardio = incompleto", syncComecoTarde.completo, false);

// Mês em andamento: o esperado é até ontem (09/11 com hoje 10/11).
const hojeDeps = { hojeIso: "2026-11-10" };
const depsCorrente = (imp, extra = {}) => fakeDeps({ imports: [imp], ...extra, ...hojeDeps });
const impCorrenteAteOntem = {
  id: 21, competencia: "2026-11", resumo_json: { lucroContribuicao: 50 }, publication_status: "published",
  coverage_date_from: "2026-11-01", coverage_date_to: "2026-11-09", published_at: "2026-11-10T03:00:00Z", sync_run_id: 5,
};
const statusCorrente = await obterStatusFechamentoViaApi(
  { clienteSlugRaw: "cli", clienteContaIdRaw: 48, periodoRaw: "2026-11" },
  depsCorrente(impCorrenteAteOntem)
);
eq("mês em andamento até ontem é completo", statusCorrente.sync.completo, true);

// ─── 6. entradas públicas com dependências fake ─────────────────────────────

function fakeDeps({
  imports = [],
  competencias = [],
  pedidos = PEDIDOS,
  itens = ITENS,
  componentes = COMPONENTES,
  publicado = null,
  runs = [],
  base = null,
  baseAtual = null,
  custosBase = [],
  conta = { id: 48, cliente_id: 7, nome: "Conta A", ativo: true, marketplace: "meli" },
  hojeIso = "2026-11-10",
} = {}) {
  return {
    db: {
      async query(sql) {
        // Base do sync (import + run) antes do import publicado: as duas SQL citam central_vendas_imports.
        if (sql.includes("JOIN bases b ON b.id = COALESCE")) return { rows: base ? [base] : [] };
        if (sql.includes("FROM bases b")) return { rows: baseAtual ? [baseAtual] : [] };
        if (sql.includes("FROM central_vendas_imports")) return { rows: publicado ? [publicado] : [] };
        if (sql.includes("status IN ('queued','running')")) return { rows: runs };
        throw new Error(`SQL inesperado no teste: ${sql.slice(0, 60)}`);
      },
    },
    async resolverClientePorIdOuSlug() {
      return { id: 7, slug: "cli" };
    },
    async obterConta() {
      return conta;
    },
    async resolveImportsForRange() {
      return { imports, competencias };
    },
    async loadPedidosByImportIds() {
      return { pedidos, itens, componentes };
    },
    async obterBaseDaConta() {
      return baseAtual ? { base_id: baseAtual.id, slug: baseAtual.slug, nome: baseAtual.nome } : { base_id: null };
    },
    async buscarCustosPorBaseId() {
      return custosBase;
    },
    hojeIso,
  };
}

console.log("\n▸ POST gerar: mês completo com sync publicado");

const impCompleto = {
  id: 9, competencia: "2026-10", resumo_json: { lucroContribuicao: 120 }, publication_status: "published",
  coverage_date_from: "2026-10-01", coverage_date_to: "2026-10-31", published_at: "2026-11-09T03:12:00Z", sync_run_id: 3,
};
const respCompleta = await gerarFechamentoViaApi(
  { clienteSlugRaw: "cli", clienteContaIdRaw: 48, periodoRaw: "2026-10", ajustesRaw: { ads: "100", venforce: "50" } },
  fakeDeps({
    imports: [impCompleto],
    base: { id: 2, slug: "base-cli", nome: "Base Cliente" },
    runs: [{ id: 77, status: "running", created_at: "2026-11-10T10:00:00Z" }],
  })
);
eq("resposta marca fonteVendas api", respCompleta.fonteVendas, "api");
eq("resposta ok", respCompleta.ok, true);
eq("padrão: custos aplicados no sync", respCompleta.costsSource, "sync");
eq("base do sync documentada", respCompleta.costsBase, { id: 2, slug: "base-cli", nome: "Base Cliente" });
eq("sync completo na resposta", respCompleta.sync.completo, true);
eq("summary Resultado Final com ajustes (LC da base 100, não o 120 do resumo_json)", respCompleta.summary.finalResult, -50);
eq("LC não usa o resumo_json do import", respCompleta.summary.contributionProfitTotal, 100);
eq("unmatchedCosts vazio (API não tem custo órfão)", respCompleta.unmatchedCosts, []);
eq("excelBase64 nulo (sem planilha)", respCompleta.excelBase64, null);
eq("competência declarada", respCompleta.competencia.periodoSolicitado, "2026-10");
eq("run em andamento informado", respCompleta.runEmAndamento, { id: 77, status: "running", criadoEm: "2026-11-10T10:00:00.000Z" });

console.log("\n▸ POST gerar: sync incompleto não é erro");

const impCurto = { ...impCompleto, id: 10, coverage_date_to: "2026-10-15" };
const respCurta = await gerarFechamentoViaApi(
  { clienteSlugRaw: "cli", clienteContaIdRaw: 48, periodoRaw: "2026-10", ajustesRaw: {} },
  fakeDeps({ imports: [impCurto] })
);
eq("200 com sync incompleto", respCurta.sync.completo, false);
ok("nota de sincronização incompleta no summary", respCurta.summary.executiveNotes.some((n) => n.startsWith("Sincronização incompleta")));

console.log("\n▸ POST gerar: sem sync publicado");

await rejeita(
  "sem import publicado",
  gerarFechamentoViaApi(
    { clienteSlugRaw: "cli", clienteContaIdRaw: 48, periodoRaw: "2026-10", ajustesRaw: {} },
    fakeDeps({ imports: [], competencias: [{ competencia: "2026-10", publicadoMaisRecente: null }] })
  ),
  { statusCode: 409, code: "CENTRAL_SEM_SYNC" }
);

console.log("\n▸ Sync parcial: usa o publicado mais recente indicado pela seleção canônica");

const respParcialSelecionada = await gerarFechamentoViaApi(
  { clienteSlugRaw: "cli", clienteContaIdRaw: 48, periodoRaw: "2026-10", ajustesRaw: {} },
  fakeDeps({
    imports: [],
    competencias: [{ competencia: "2026-10", publicadoMaisRecente: { id: 10 } }],
    publicado: { ...impCurto },
  })
);
eq("parcial vira sync incompleto, não erro", respParcialSelecionada.sync.completo, false);

console.log("\n▸ Status sem sync");

const statusVazio = await obterStatusFechamentoViaApi(
  { clienteSlugRaw: "cli", clienteContaIdRaw: 48, periodoRaw: "2026-10" },
  fakeDeps({ imports: [], competencias: [] })
);
eq("status: disponivel false", statusVazio.sync.disponivel, false);
eq("status: completo false", statusVazio.sync.completo, false);
eq("status: motivo fixo", statusVazio.sync.motivoIncompleto, "Mês ainda não sincronizado.");
eq("status: sem run", statusVazio.runEmAndamento, null);

// ─── 7. validações de contexto ──────────────────────────────────────────────

console.log("\n▸ Validações");

await rejeita(
  "período obrigatório",
  obterStatusFechamentoViaApi({ clienteSlugRaw: "cli", clienteContaIdRaw: 48, periodoRaw: undefined }, fakeDeps()),
  { statusCode: 400, code: "PERIODO_OBRIGATORIO" }
);
await rejeita(
  "período inválido",
  obterStatusFechamentoViaApi({ clienteSlugRaw: "cli", clienteContaIdRaw: 48, periodoRaw: "2026-13" }, fakeDeps()),
  { statusCode: 400, code: "PERIODO_INVALIDO" }
);
await rejeita(
  "conta obrigatória",
  obterStatusFechamentoViaApi({ clienteSlugRaw: "cli", clienteContaIdRaw: undefined, periodoRaw: "2026-10" }, fakeDeps()),
  { statusCode: 400 }
);
await rejeita(
  "conta de outro cliente",
  obterStatusFechamentoViaApi(
    { clienteSlugRaw: "cli", clienteContaIdRaw: 48, periodoRaw: "2026-10" },
    fakeDeps({ conta: { id: 48, cliente_id: 99, nome: "Outra", ativo: true, marketplace: "meli" } })
  ),
  { statusCode: 403, code: "CONTA_NAO_PERTENCE_AO_CLIENTE" }
);
await rejeita(
  "conta desativada",
  obterStatusFechamentoViaApi(
    { clienteSlugRaw: "cli", clienteContaIdRaw: 48, periodoRaw: "2026-10" },
    fakeDeps({ conta: { id: 48, cliente_id: 7, nome: "Parada", ativo: false, marketplace: "meli" } })
  ),
  { statusCode: 409, code: "CONTA_INATIVA" }
);
await rejeita(
  "conta que não é Mercado Livre",
  gerarFechamentoViaApi(
    { clienteSlugRaw: "cli", clienteContaIdRaw: 48, periodoRaw: "2026-10", ajustesRaw: {} },
    fakeDeps({ conta: { id: 48, cliente_id: 7, nome: "Shopee", ativo: true, marketplace: "shopee" } })
  ),
  { statusCode: 400, code: "FECHAMENTO_API_SO_MELI" }
);
await rejeita(
  "ajuste monetário ambíguo",
  gerarFechamentoViaApi(
    { clienteSlugRaw: "cli", clienteContaIdRaw: 48, periodoRaw: "2026-10", ajustesRaw: { ads: "12,3.4" } },
    fakeDeps({ imports: [impCompleto] })
  ),
  { statusCode: 400, code: "AJUSTE_INVALIDO" }
);

// ─── 8. data de hoje no fuso do negócio ────────────────────────────────────

console.log("\n▸ Fuso");

ok("hojeSaoPaulo no formato YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(hojeSaoPaulo()));
eq(
  "02:30Z do dia 10 ainda é dia 9 em São Paulo (UTC-3)",
  hojeSaoPaulo(new Date("2026-11-10T02:30:00Z")),
  "2026-11-09"
);

concluido = true;
console.log(`\n✓ fechamentoViaApiService.test.js — ${checks} verificações`);
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
