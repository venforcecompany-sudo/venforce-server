// server/tests/centralVendasCliente360Adapter.test.js
//
// Adaptador Central de Vendas → cliente_360_resumos_mensais (snapshot lido
// pelo Painel de Contas). Cobre:
//   - FAT/LC/MC = cálculo oficial da Central (buildResumoCentralVendas), 1 e
//     2+ contas, cancelados fora, receita bloqueada no FAT e fora do MC;
//   - porDia/topProdutos no contrato do fluxo manual;
//   - precedência do fechamento oficial PUBLICADO da competência para MC;
//   - Ads preservado como null (nunca 0);
//   - snapshot NÃO reconstruído: conta sem import publicado, só legacy,
//     snapshot já mais novo, lock do Cliente 360 ocupado;
//   - falha no upsert fecha o job como erro;
//   - nenhuma chamada HTTP / Orders API.
//
// NENHUM banco real: dependências injetadas; DATABASE_URL aponta para porta
// morta antes de qualquer require.

process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/teste-sem-banco";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const adapter = require("../services/centralVendas/centralVendasCliente360Adapter");
const { buildResumoCentralVendas } = require("../services/centralVendas/centralVendasImportService");
const { calcularTacos } = require("../services/cliente360/cliente360SyncService");
const { deriveResumo, normalizarMcFracao } = require("../services/painelContas/painelContasMetricas");

let checks = 0;
// Uma promise pendurada esvazia o event loop e o Node sai com 0 sem terminar
// o teste — aqui isso vira falha.
let concluido = false;
process.on("exit", () => {
  if (!concluido) {
    console.error(`centralVendasCliente360Adapter.test.js: NÃO concluiu (parou após ${checks} verificações)`);
    process.exitCode = 1;
  }
});
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `FALHOU: ${label} — recebido ${JSON.stringify(actual)}`);
  checks += 1;
}

// ---------------------------------------------------------------------------
// Fixtures: linhas como o pg devolve (NUMERIC chega como string).
// ---------------------------------------------------------------------------
const PEDIDOS_A = [
  { id: 1, import_id: 501, data_pedido: "2026-09-02", status: "paid", confianca: "confiavel", faturamento: "100.00", lc: 20 },
  { id: 2, import_id: 501, data_pedido: "2026-09-02", status: "paid", confianca: "bloqueado", faturamento: "50.00", lc: null },
  { id: 3, import_id: 501, data_pedido: "2026-09-03", status: "cancelled", confianca: "confiavel", faturamento: "30.00", lc: 5 },
  { id: 4, import_id: 501, data_pedido: "2026-09-05", status: "paid", confianca: "parcial", faturamento: "70.00", lc: 10 },
];
const PEDIDOS_B = [
  { id: 9, import_id: 502, data_pedido: "2026-09-05", status: "paid", confianca: "confiavel", faturamento: "200.00", lc: 50 },
];
const ITENS = [
  { import_id: 501, pedido_row_id: 1, mlb: "MLB1", sku: "S1", titulo: "Produto 1", quantidade: 2, receita_produto: "100.00" },
  { import_id: 501, pedido_row_id: 2, mlb: "MLB2", sku: "S2", titulo: "Produto 2", quantidade: 1, receita_produto: "50.00" },
  { import_id: 501, pedido_row_id: 3, mlb: "MLB1", sku: "S1", titulo: "Produto 1", quantidade: 1, receita_produto: "30.00" }, // cancelado
  { import_id: 501, pedido_row_id: 4, mlb: "MLB1", sku: "S1", titulo: "Produto 1", quantidade: 1, receita_produto: "70.00" },
  { import_id: 502, pedido_row_id: 9, mlb: "MLB9", sku: "S9", titulo: "Produto 9", quantidade: 4, receita_produto: "200.00" },
];

// resumo_json exatamente como o sync produz: buildResumoCentralVendas sobre o
// motor, com LC do motor = soma dos LCs dos pedidos válidos com LC.
function resumoJsonOficial(pedidos) {
  const { pedidoEntraNoResultado } = require("../services/centralVendas/centralVendasService");
  const comLc = pedidos.filter(pedidoEntraNoResultado).filter((p) => p.lc !== null);
  const lucroContribuicao = comLc.length ? Math.round(comLc.reduce((s, p) => s + p.lc, 0) * 100) / 100 : null;
  return buildResumoCentralVendas({ pedidos, resumo: { lucroContribuicao } });
}

function importRow({ id, contaId, pedidos, publication = "published", publishedAt = "2026-09-24T06:05:00Z", coverageTo = "2026-09-23", competencia = "2026-09" }) {
  return {
    id, competencia, cliente_conta_id: contaId, publication_status: publication,
    published_at: publishedAt, coverage_date_from: `${competencia}-01`, coverage_date_to: coverageTo,
    sync_run_id: id + 1000, resumo_json: resumoJsonOficial(pedidos),
  };
}

function makeDeps({ importsPorConta, fechamentos = [], existente = null, lockConflito = false, upsertErro = null, ads = { disponivel: false, adsInvestido: null, gmvAds: null, roas: null, faturamentoAds: null, updatedAt: null } } = {}) {
  const chamadas = { lock: [], upsert: [], finalize: [], sql: [], resolve: [] };
  const todosPedidos = [...PEDIDOS_A, ...PEDIDOS_B];
  const deps = {
    db: {
      async query(sql, params) {
        chamadas.sql.push(sql);
        if (sql.includes("FROM central_vendas_pedidos")) {
          return { rows: todosPedidos.filter((p) => params[0].includes(p.import_id)).map(({ lc, ...row }) => row) };
        }
        if (sql.includes("FROM central_vendas_pedido_itens")) {
          return { rows: ITENS.filter((i) => params[0].includes(i.import_id)) };
        }
        if (sql.includes("FROM entregas_cliente")) return { rows: fechamentos };
        throw new Error(`SQL inesperado: ${sql.slice(0, 80)}`);
      },
    },
    async resolveImportsForRange(args) {
      chamadas.resolve.push(args);
      return { imports: importsPorConta[args.clienteContaId] || [] };
    },
    async ensureCliente360Tables() {},
    async findResumoMensal() { return existente; },
    async upsertResumoMensal(p) {
      chamadas.upsert.push(p);
      if (upsertErro) throw upsertErro;
      return { ...p, sincronizado_em: "2026-09-24T06:10:00.000Z" };
    },
    async lockSyncJob(...args) {
      chamadas.lock.push(args);
      return lockConflito ? { conflito: { id: 77 } } : { job: { id: 55 } };
    },
    async finalizeSyncJob(...args) { chamadas.finalize.push(args); },
    async findRelatoriosByCliente() { return [{ itens_sem_base: "4", itens_criticos: "2", mc_media: "0.33" }]; },
    async countDiagnosticos() { return 3; },
    async consolidarAdsMes() { return ads; },
    async consolidarFechamentosMes() { return 1; },
    calcularTacos,
  };
  return { deps, chamadas };
}

const CLIENTE = { id: 10, slug: "alfa" };
const SEGMENTO = { dateFrom: "2026-09-01", dateTo: "2026-09-23" };

async function run() {
  // =========================================================================
  // 1. consolidarCentral — contrato oficial FAT/LC/MC
  // =========================================================================
  {
    const imp = importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A });
    const c = adapter.consolidarCentral({ imports: [imp], pedidos: PEDIDOS_A, itens: ITENS.filter((i) => i.import_id === 501) });
    // Válidos: 1 (100, LC 20), 2 (50 bloqueado), 4 (70 parcial, LC 10). Cancelado fora.
    eq("1 conta: FAT inclui receita bloqueada", c.faturamento, 220);
    eq("1 conta: faturamento com custo", c.faturamentoComCusto, 170);
    eq("1 conta: LC do motor", c.lucroContribuicao, 30);
    eq("1 conta: MC = LC / receita com custo", c.margemContribuicaoPercentual, 17.65);
    eq("1 conta: idêntico ao resumo_json persistido pelo sync",
      [c.faturamento, c.lucroContribuicao, c.margemContribuicaoPercentual],
      [imp.resumo_json.faturamento, imp.resumo_json.lucroContribuicao, imp.resumo_json.margemContribuicaoPercentual]);
    eq("1 conta: pedidos válidos / cancelados", [c.pedidos, c.cancelados], [3, 1]);
    eq("1 conta: porDia (só válidos)", c.porDia, [
      { data: "2026-09-02", vendasBrutas: 150, quantidadeVendas: 2 },
      { data: "2026-09-05", vendasBrutas: 70, quantidadeVendas: 1 },
    ]);
    eq("1 conta: soma de porDia = FAT", c.porDia.reduce((s, d) => s + d.vendasBrutas, 0), c.faturamento);
    eq("1 conta: topProdutos agrupado por MLB, sem cancelado", c.topProdutos, [
      { mlb: "MLB1", sku: "S1", titulo: "Produto 1", unidades: 3, faturamento: 170 },
      { mlb: "MLB2", sku: "S2", titulo: "Produto 2", unidades: 1, faturamento: 50 },
    ]);
    eq("1 conta: confiança parcial (há bloqueado)", c.confianca, "parcial");
  }
  {
    const impA = importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A });
    const impB = importRow({ id: 502, contaId: 2, pedidos: PEDIDOS_B });
    const c = adapter.consolidarCentral({ imports: [impA, impB], pedidos: [...PEDIDOS_A, ...PEDIDOS_B], itens: ITENS });
    eq("2 contas: FAT somado", c.faturamento, 420);
    eq("2 contas: LC somado", c.lucroContribuicao, 80);
    eq("2 contas: MC recalculado sobre a união (80/370)", c.margemContribuicaoPercentual, 21.62);
    eq("2 contas: pedidos", c.pedidos, 4);
  }
  {
    const semLc = PEDIDOS_A.map((p) => ({ ...p, lc: null }));
    const imp = importRow({ id: 501, contaId: 1, pedidos: semLc });
    const c = adapter.consolidarCentral({ imports: [imp], pedidos: semLc, itens: [] });
    eq("sem LC: LC null (nunca 0)", c.lucroContribuicao, null);
    eq("sem LC: MC null", c.margemContribuicaoPercentual, null);
    eq("sem LC: FAT continua", c.faturamento, 220);
  }
  {
    const itens = Array.from({ length: 55 }, (_, i) => ({ pedido_row_id: 1, mlb: `MLB${i}`, quantidade: 1, receita_produto: String(i + 1) }));
    const { topProdutos, truncado } = adapter.montarTopProdutos(itens, new Set(["1"]));
    eq("topProdutos: limite 50", topProdutos.length, 50);
    ok("topProdutos: truncado sinalizado", truncado === true);
    eq("topProdutos: ordenado por faturamento", topProdutos[0].mlb, "MLB54");
  }
  eq("zero pedidos: snapshot válido zerado",
    (({ faturamento, pedidos, porDia }) => ({ faturamento, pedidos, porDia }))(adapter.consolidarCentral({ imports: [importRow({ id: 501, contaId: 1, pedidos: [] })], pedidos: [], itens: [] })),
    { faturamento: 0, pedidos: 0, porDia: [] });

  // =========================================================================
  // 2. reconstruirSnapshotMensal — caminho feliz (1 conta, sem fechamento)
  // =========================================================================
  {
    const { deps, chamadas } = makeDeps({ importsPorConta: { 1: [importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A })] } });
    const r = await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }], segmento: SEGMENTO }, deps);
    eq("feliz: atualizado", r.atualizado, true);
    eq("feliz: sincronizadoEm vem do upsert", r.sincronizadoEm, "2026-09-24T06:10:00.000Z");
    eq("feliz: resolve estritamente por conta, sem legado", chamadas.resolve[0],
      { clienteSlug: "alfa", dateFrom: "2026-09-01", dateTo: "2026-09-23", marketplace: "meli", clienteContaId: 1, includeLegacy: false });
    const u = chamadas.upsert[0];
    eq("feliz: campos do snapshot", {
      clienteId: u.clienteId, clienteSlug: u.clienteSlug, competencia: u.competencia, faturamento: u.faturamento,
      mcMedia: u.mcMedia, pedidos: u.pedidos, cancelados: u.cancelados, problemas: u.problemas,
      fechamentosCount: u.fechamentosCount, diagnosticosCount: u.diagnosticosCount,
      itensSemCusto: u.itensSemCusto, itensCriticos: u.itensCriticos, freteConfianca: u.freteConfianca,
    }, {
      clienteId: 10, clienteSlug: "alfa", competencia: "2026-09", faturamento: 220,
      mcMedia: 0.1765, pedidos: 3, cancelados: 1, problemas: null,
      fechamentosCount: 1, diagnosticosCount: 3, itensSemCusto: 4, itensCriticos: 2, freteConfianca: "sem_amostra",
    });
    eq("feliz: Ads ausente continua null (nunca 0)", [u.adsInvestido, u.tacos], [null, null]);
    eq("feliz: payload identifica a fonte", [u.payloadJson.fonte, u.payloadJson.metricasOk], ["central_vendas", true]);
    eq("feliz: MC da Central sem fechamento publicado", [u.payloadJson.centralVendas.mcFonte, u.payloadJson.centralVendas.mcPrecedenciaMotivo], ["central_vendas", "SEM_FECHAMENTO_PUBLICADO"]);
    eq("feliz: LC oficial preservado no payload", u.payloadJson.centralVendas.lucroContribuicao, 30);
    eq("feliz: proveniência por conta", u.payloadJson.centralVendas.contas, [{
      clienteContaId: 1, importId: 501, syncRunId: 1501, publishedAt: "2026-09-24T06:05:00.000Z",
      coverageDateFrom: "2026-09-01", coverageDateTo: "2026-09-23",
    }]);
    eq("feliz: dadosAte", u.payloadJson.centralVendas.dadosAte, "2026-09-23");
    ok("feliz: porDia e topProdutos gravados", Array.isArray(u.payloadJson.porDia) && Array.isArray(u.payloadJson.topProdutos));
    eq("feliz: mesmo lock do Cliente 360 (cliente, competência)", chamadas.lock[0], [10, "alfa", "2026-09", adapter.LOCK_TIPO, null]);
    eq("feliz: job finalizado ok", chamadas.finalize[0].slice(0, 3), [55, "ok", null]);
    ok("feliz: SQL de pedidos/itens só leitura por import_id",
      chamadas.sql.filter((s) => s.includes("central_vendas_pedido")).every((s) => /^\s*SELECT/.test(s) && s.includes("import_id = ANY")));
  }

  // Escala de mc_media: fração — o Painel lê MC 0,8% como 0,008 (não 80%).
  {
    const pedidos = [{ id: 1, import_id: 501, data_pedido: "2026-09-02", status: "paid", confianca: "confiavel", faturamento: "1000.00", lc: 8 }];
    const imp = importRow({ id: 501, contaId: 1, pedidos });
    const { deps, chamadas } = makeDeps({ importsPorConta: { 1: [imp] } });
    deps.db.query = async (sql) => (sql.includes("pedido_itens") ? { rows: [] } : sql.includes("entregas_cliente") ? { rows: [] } : { rows: pedidos.map(({ lc, ...r }) => r) });
    await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }], segmento: SEGMENTO }, deps);
    const u = chamadas.upsert[0];
    eq("escala: mcMedia gravado como fração", u.mcMedia, 0.008);
    eq("escala: Painel normaliza para 0,008", normalizarMcFracao(u.mcMedia), 0.008);
    eq("contrato Painel: LC usa o valor real da Central", deriveResumo({
      faturamento: u.faturamento,
      mcMedia: u.mcMedia,
      lucroContribuicao: u.payloadJson.centralVendas.lucroContribuicao,
      lucroContribuicaoPresente: true,
    }).lc, 8);
  }

  // Ads presente em ads_resumos_mensais → usado como está, TACoS oficial.
  {
    const { deps, chamadas } = makeDeps({
      importsPorConta: { 1: [importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A })] },
      ads: { disponivel: true, adsInvestido: 22, gmvAds: 90, roas: 4.09, faturamentoAds: 0, updatedAt: "2026-09-24T06:06:00Z" },
    });
    await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }], segmento: SEGMENTO }, deps);
    eq("ads: investido preservado", chamadas.upsert[0].adsInvestido, 22);
    eq("ads: TACoS pela função do fluxo manual", chamadas.upsert[0].tacos, calcularTacos(220, 22));
    eq("ads: investimento e GMV persistidos na mesma versão do snapshot", chamadas.upsert[0].payloadJson.ads, {
      investimentoAds: 22,
      gmvAds: 90,
      roas: 4.09,
      resumoAtualizadoEm: "2026-09-24T06:06:00.000Z",
    });
  }

  // =========================================================================
  // 3. Precedência do fechamento oficial para MC
  // =========================================================================
  const fech = (over) => ({ id: 1, periodo: "2026-09", status: "publicado", publicado: true, cliente_conta_id: 1, created_at: "2026-10-03T10:00:00Z", mc_calculada: "0.12", ...over });
  {
    const { deps, chamadas } = makeDeps({ importsPorConta: { 1: [importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A })] }, fechamentos: [fech({})] });
    const r = await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }], segmento: SEGMENTO }, deps);
    const u = chamadas.upsert[0];
    eq("fechamento: MC do fechamento publicado vence a Central", u.mcMedia, 0.12);
    eq("fechamento: fonte registrada", [u.payloadJson.centralVendas.mcFonte, u.payloadJson.centralVendas.fechamentoEntregaId], ["fechamento_oficial", 1]);
    eq("fechamento: FAT continua da Central", u.faturamento, 220);
    eq("fechamento: MC da Central preservado no payload", u.payloadJson.centralVendas.margemContribuicaoPercentual, 17.65);
    eq("fechamento: retorno informa a fonte", r.detalhe.mcFonte, "fechamento_oficial");
    const sqlEntregas = chamadas.sql.find((s) => s.includes("FROM entregas_cliente"));
    ok("fechamento: consulta só fechamento_mensal publicado", sqlEntregas.includes("tipo = 'fechamento_mensal'") && sqlEntregas.includes("publicado = true OR status = 'publicado'"));
    ok("fechamento: lê só mcCalculada do payload", sqlEntregas.includes("'metricasDerivadas'->>'mcCalculada'"));
  }
  {
    // Fechamento legado sem conta registrada também vale para cliente de 1 conta.
    const { deps, chamadas } = makeDeps({ importsPorConta: { 1: [importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A })] }, fechamentos: [fech({ cliente_conta_id: null, mc_calculada: "0.2" })] });
    await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }], segmento: SEGMENTO }, deps);
    eq("fechamento sem conta: aplica", chamadas.upsert[0].mcMedia, 0.2);
  }
  for (const [label, fechamentos, motivo] of [
    ["outra competência", [fech({ periodo: "2026-08" })], "SEM_FECHAMENTO_PUBLICADO"],
    ["outra conta", [fech({ cliente_conta_id: 999 })], "SEM_FECHAMENTO_PUBLICADO"],
    ["sem mcCalculada", [fech({ mc_calculada: null })], "FECHAMENTO_SEM_MC"],
  ]) {
    const { deps, chamadas } = makeDeps({ importsPorConta: { 1: [importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A })] }, fechamentos });
    await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }], segmento: SEGMENTO }, deps);
    eq(`fechamento ${label}: MC da Central`, chamadas.upsert[0].mcMedia, 0.1765);
    eq(`fechamento ${label}: motivo`, chamadas.upsert[0].payloadJson.centralVendas.mcPrecedenciaMotivo, motivo);
  }
  {
    // 2+ contas: fechamento por conta não representa o cliente → Central.
    const { deps, chamadas } = makeDeps({
      importsPorConta: { 1: [importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A })], 2: [importRow({ id: 502, contaId: 2, pedidos: PEDIDOS_B })] },
      fechamentos: [fech({})],
    });
    await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }, { clienteContaId: 2 }], segmento: SEGMENTO }, deps);
    const u = chamadas.upsert[0];
    eq("multi-conta: FAT das duas contas", u.faturamento, 420);
    eq("multi-conta: MC da Central", [u.mcMedia, u.payloadJson.centralVendas.mcPrecedenciaMotivo], [0.2162, "MULTIPLAS_CONTAS"]);
    eq("multi-conta: proveniência das 2 contas", u.payloadJson.centralVendas.contas.map((c) => c.clienteContaId), [1, 2]);
  }

  // =========================================================================
  // 4. Quando o snapshot NÃO pode ser reconstruído
  // =========================================================================
  {
    // Conta 2 sem import publicado (run falhou): somar só a conta 1 esconderia faturamento.
    const { deps, chamadas } = makeDeps({ importsPorConta: { 1: [importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A })], 2: [] } });
    const r = await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }, { clienteContaId: 2 }], segmento: SEGMENTO }, deps);
    eq("conta faltando: não atualizado", [r.atualizado, r.motivo, r.detalhe.contasSemPublicacao], [false, "CONTA_SEM_IMPORT_PUBLICADO", [2]]);
    eq("conta faltando: nem lock nem upsert", [chamadas.lock.length, chamadas.upsert.length], [0, 0]);
  }
  {
    const { deps, chamadas } = makeDeps({ importsPorConta: { 1: [importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A, publication: "legacy" })] } });
    const r = await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }], segmento: SEGMENTO }, deps);
    eq("só legacy: não conta como publicado", [r.atualizado, r.motivo, chamadas.upsert.length], [false, "CONTA_SEM_IMPORT_PUBLICADO", 0]);
  }
  {
    const { deps, chamadas } = makeDeps({ importsPorConta: { 1: [importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A, competencia: "2026-08", coverageTo: "2026-08-31" })] } });
    const r = await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }], segmento: SEGMENTO }, deps);
    eq("import de outra competência: ignorado", [r.atualizado, chamadas.upsert.length], [false, 0]);
  }
  {
    // Snapshot gravado DEPOIS da publicação usada → já está atualizado; não regrava nem mexe em sincronizado_em.
    const { deps, chamadas } = makeDeps({
      importsPorConta: { 1: [importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A, publishedAt: "2026-09-24T06:05:00Z" })] },
      existente: { sincronizado_em: "2026-09-24T14:00:00Z" },
    });
    const r = await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }], segmento: SEGMENTO }, deps);
    eq("ordem: snapshot mais novo preservado", [r.atualizado, r.motivo], [false, "SNAPSHOT_JA_ATUALIZADO"]);
    eq("ordem: nem lock nem upsert", [chamadas.lock.length, chamadas.upsert.length], [0, 0]);
  }
  {
    const { deps, chamadas } = makeDeps({
      importsPorConta: { 1: [importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A, publishedAt: "2026-09-24T06:05:00Z" })] },
      existente: { sincronizado_em: "2026-09-24T14:00:00Z" },
      ads: { disponivel: true, adsInvestido: 22, gmvAds: 90, roas: 4.09, updatedAt: "2026-09-24T15:00:00Z" },
    });
    const r = await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }], segmento: SEGMENTO }, deps);
    eq("ordem: Ads mais novo força reconstrução mesmo com vendas já incorporadas", [r.atualizado, chamadas.upsert.length], [true, 1]);
  }
  {
    const { deps, chamadas } = makeDeps({
      importsPorConta: { 1: [importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A, publishedAt: "2026-09-24T06:05:00Z" })] },
      existente: { sincronizado_em: "2026-09-23T14:00:00Z" },
    });
    const r = await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }], segmento: SEGMENTO }, deps);
    eq("ordem: snapshot mais antigo é reconstruído", [r.atualizado, chamadas.upsert.length], [true, 1]);
  }
  {
    const { deps, chamadas } = makeDeps({ importsPorConta: { 1: [importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A })] }, lockConflito: true });
    const r = await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }], segmento: SEGMENTO }, deps);
    eq("lock ocupado: não atualiza", [r.atualizado, r.motivo, chamadas.upsert.length], [false, "SYNC_CLIENTE360_EM_ANDAMENTO", 0]);
  }
  {
    const { deps, chamadas } = makeDeps({ importsPorConta: {} });
    const r = await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [], segmento: SEGMENTO }, deps);
    eq("sem contas: não atualiza", [r.atualizado, r.motivo, chamadas.resolve.length], [false, "SEM_CONTAS", 0]);
  }
  {
    const { deps, chamadas } = makeDeps({ importsPorConta: { 1: [importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A })] }, upsertErro: new Error("deadlock") });
    let erro = null;
    try {
      await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }], segmento: SEGMENTO }, deps);
    } catch (err) { erro = err; }
    ok("upsert falha: erro propaga (orquestrador registra ERRO_ADAPTADOR)", erro && erro.message === "deadlock");
    eq("upsert falha: job do Cliente 360 fechado como erro", chamadas.finalize[0].slice(0, 3), [55, "erro", "deadlock"]);
  }

  // =========================================================================
  // 5. Nenhuma Orders API / HTTP para gerar o snapshot
  // =========================================================================
  {
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async () => { fetches += 1; throw new Error("rede proibida no teste"); };
    try {
      const { deps } = makeDeps({ importsPorConta: { 1: [importRow({ id: 501, contaId: 1, pedidos: PEDIDOS_A })] } });
      await adapter.reconstruirSnapshotMensal({ cliente: CLIENTE, competencia: "2026-09", contas: [{ clienteContaId: 1 }], segmento: SEGMENTO }, deps);
      eq("sem HTTP: zero fetch", fetches, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const fonte = fs.readFileSync(path.join(__dirname, "../services/centralVendas/centralVendasCliente360Adapter.js"), "utf8")
      .replace(/\/\/.*$/gm, ""); // ignora comentários
    ok("sem HTTP: adaptador não usa mlFetch", !fonte.includes("mlFetch"));
    ok("sem HTTP: adaptador não usa metricasService/buscarResumo", !fonte.includes("buscarResumo") && !fonte.includes("metricasService"));
    ok("sem HTTP: adaptador não chama consolidarMetricasMes", !fonte.includes("consolidarMetricasMes"));
    ok("sem HTTP: adaptador não chama fetch", !/\bfetch\s*\(/.test(fonte));
    ok("sem HTTP: adaptador não dispara sync", !fonte.includes("sincronizarVendasMeli") && !fonte.includes("executarSyncRun") && !fonte.includes("criarSyncRun"));
  }

  concluido = true;
  console.log(`centralVendasCliente360Adapter.test.js: ${checks} verificacoes OK`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
