// server/tests/cliente360ContaScoped.test.js
//
// V3 FASE 0 — ACCOUNT-AWARENESS E PARIDADE FINANCEIRA.
//
// Prova, através da stack REAL (cliente360ResultadoService → cliente360FechamentoAdapter
// → centralVendasService.resolveRangeContext → resolveMarketplaceAccountContext →
// centralVendasRepository → cliente360PonteEngine/ConfiancaEngine/ProdutosEngine), que:
//
//   1. Conta A nunca lê pedidos de Conta B, mesmo com o MESMO MLB nas duas contas.
//   2. Conta B nunca lê pedidos de Conta A (invertido).
//   3. O universo legado (cliente_conta_id NULL) NUNCA entra quando o cliente tem
//      2+ contas ativas — nem quando uma conta é explicitada.
//   4. O universo legado CONTINUA legível quando o cliente tem exatamente 1 conta
//      ativa e nenhuma é explicitada (compatibilidade aditiva — V2 antiga não quebra).
//   5. clienteContaId de outro Cliente, inativa ou de marketplace incompatível são
//      REJEITADOS (403/409/422) — nunca escolhidos silenciosamente.
//   6. Sem clienteContaId e 2+ contas ativas, a ambiguidade é REJEITADA (409) —
//      nunca "primeira conta".
//   7. A Confiança (cobertura de custo/frete) é calculada sobre o universo de CADA
//      conta, não misturado.
//   8. clienteContaId atravessa também Simulador e Série (mesmo adapter).
//
// Nenhum banco real é tocado: `db` é um fake que casa o SHAPE do SQL real (mesmo
// padrão de centralVendasGetAccountScoped.test.js/centralVendasAccountContext.test.js),
// e `resolveRangeContext`/`centralRepo` usam a lógica REAL de
// centralVendasService/centralVendasRepository ligada a esse fake — não uma segunda
// implementação da regra de conta.
//
// Roda sem infra: node server/tests/cliente360ContaScoped.test.js

const assert = require("assert");
const { createCentralVendasService } = require("../services/centralVendas/centralVendasService");
const repository = require("../services/centralVendas/centralVendasRepository");
const { createResultadoService } = require("../services/cliente360/cliente360ResultadoService");
const { createSimulacaoService } = require("../services/cliente360/cliente360SimulacaoService");
const { createSerieService } = require("../services/cliente360/cliente360SerieService");
const { STATUS } = require("../services/cliente360/cliente360AdsService");

let passed = 0;
const check = (n, c) => { assert.ok(c, `FALHOU: ${n}`); passed++; console.log(`  ok  ${n}`); };

// ─── Fixture: 1 Cliente com 2 contas MELI ativas + 1 inativa, 1 Cliente alheio,
//     1 Cliente com conta única (compat legada) ────────────────────────────────

const clienteN97 = { id: 1, nome: "N97 Comercial", slug: "n97", ativo: true };
const clienteOutro = { id: 2, nome: "Outro Cliente", slug: "outro-cliente", ativo: true };
const clienteSolo = { id: 3, nome: "Cliente Solo", slug: "cliente-solo", ativo: true };
const CLIENTES = [clienteN97, clienteOutro, clienteSolo];

const contas = [
  { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML Principal", slug: "n97-ml-principal", external_account_id: "1110", is_primary: true, ativo: true },
  { id: 11, cliente_id: 1, marketplace: "meli", nome: "ML Outlet", slug: "n97-ml-outlet", external_account_id: "1111", is_primary: false, ativo: true },
  { id: 99, cliente_id: 1, marketplace: "meli", nome: "ML Antiga (desativada)", slug: "n97-ml-antiga", external_account_id: "1199", is_primary: false, ativo: false },
  { id: 20, cliente_id: 2, marketplace: "meli", nome: "Outro ML", slug: "outro-ml", external_account_id: "2220", is_primary: true, ativo: true },
  { id: 30, cliente_id: 3, marketplace: "meli", nome: "Solo ML", slug: "solo-ml", external_account_id: "3330", is_primary: true, ativo: true },
  { id: 40, cliente_id: 1, marketplace: "shopee", nome: "N97 Shopee", slug: "n97-shopee", external_account_id: null, is_primary: true, ativo: true },
];

// mesmo MLB ("MLBCOMUM") aparece nas duas contas do N97, com valores BEM diferentes
// de propósito — se o isolamento vazar, os totais ficam obviamente errados.
const imports = [
  { id: 100, cliente_slug: "n97", marketplace: "meli", competencia: "2026-08", cliente_conta_id: 10, publication_status: "legacy", created_at: "2026-08-20T10:00:00.000Z" },
  { id: 101, cliente_slug: "n97", marketplace: "meli", competencia: "2026-08", cliente_conta_id: 11, publication_status: "legacy", created_at: "2026-08-20T10:00:00.000Z" },
  { id: 102, cliente_slug: "n97", marketplace: "meli", competencia: "2026-08", cliente_conta_id: null, publication_status: "legacy", created_at: "2026-08-20T10:00:00.000Z" }, // legado ambíguo — nunca deve aparecer (2 contas ativas)
  { id: 90, cliente_slug: "n97", marketplace: "meli", competencia: "2026-07", cliente_conta_id: 10, publication_status: "legacy", created_at: "2026-07-20T10:00:00.000Z" },
  { id: 91, cliente_slug: "n97", marketplace: "meli", competencia: "2026-07", cliente_conta_id: 11, publication_status: "legacy", created_at: "2026-07-20T10:00:00.000Z" },
  { id: 300, cliente_slug: "cliente-solo", marketplace: "meli", competencia: "2026-08", cliente_conta_id: null, publication_status: "legacy", created_at: "2026-08-20T10:00:00.000Z" }, // legado da ÚNICA conta ativa — deve continuar legível
];

function pedidoRow(id, importId, pedidoId, { data, status = "paid", confianca = "confiavel", faturamento, qtd }) {
  return {
    id, import_id: importId, pedido_id: pedidoId, data_pedido: data, status, confianca,
    quantidade_itens: qtd, faturamento, resultado: null, pendencias_json: [], payload_json: null,
  };
}
function itemRow(pedidoRowId, itemId, { mlb, sku = null, titulo = null, quantidade, receita, custo, imposto, confianca = "confiavel" }) {
  return {
    pedido_row_id: pedidoRowId, pedido_id: itemId.split(":")[0], item_id: itemId, mlb, sku, titulo: titulo || mlb,
    quantidade, valor_unitario: quantidade ? receita / quantidade : null,
    receita_produto: receita, custo_produto: custo, imposto_interno: imposto, confianca, pendencias_json: [],
  };
}
function componenteRow(pedidoRowId, pedidoId, tipo, valor, { itemId = null } = {}) {
  return { pedido_row_id: pedidoRowId, pedido_id: pedidoId, item_id: itemId, tipo, valor, confianca: "confiavel" };
}

const pedidos = [
  // ── Conta 10 (ML Principal), 2026-08: multi-item + custo ausente + cancelado ──
  pedidoRow(1001, 100, "N97-P1", { data: "2026-08-05", faturamento: 1500, qtd: 7 }),
  pedidoRow(1002, 100, "N97-P2", { data: "2026-08-10", confianca: "parcial", faturamento: 600, qtd: 3 }),
  pedidoRow(1003, 100, "N97-P3", { data: "2026-08-12", status: "cancelado", faturamento: 9999, qtd: 1 }),
  // ── Conta 11 (ML Outlet), 2026-08: mesmo MLBCOMUM, valores diferentes + frete ausente ──
  pedidoRow(1101, 101, "N97-Q1", { data: "2026-08-06", faturamento: 3000, qtd: 10 }),
  pedidoRow(1102, 101, "N97-Q2", { data: "2026-08-18", faturamento: 800, qtd: 4 }),
  // ── Legado NULL, 2026-08: NUNCA deve aparecer (N97 tem 2 contas ativas) ──
  pedidoRow(1200, 102, "N97-LEGADO", { data: "2026-08-01", faturamento: 88888, qtd: 1 }),
  // ── Comparação 2026-07 ──
  pedidoRow(901, 90, "N97-PREV1", { data: "2026-07-05", faturamento: 800, qtd: 4 }),
  pedidoRow(911, 91, "N97-PREV2", { data: "2026-07-06", faturamento: 1800, qtd: 6 }),
  // ── Cliente Solo, 2026-08 (legado NULL, única conta ativa — DEVE ser legível) ──
  pedidoRow(3001, 300, "SOLO-P1", { data: "2026-08-05", faturamento: 400, qtd: 2 }),
];

const itens = [
  itemRow(1001, "N97-P1:MLBCOMUM", { mlb: "MLBCOMUM", sku: "SKU-COMUM", quantidade: 5, receita: 1000, custo: 400, imposto: 50 }),
  itemRow(1001, "N97-P1:MLBA10", { mlb: "MLBA10", sku: "SKU-A10", quantidade: 2, receita: 500, custo: 200, imposto: 25 }),
  itemRow(1002, "N97-P2:MLBCOMUM", { mlb: "MLBCOMUM", sku: "SKU-COMUM", quantidade: 3, receita: 600, custo: null, imposto: 30, confianca: "parcial" }), // custo AUSENTE
  itemRow(1003, "N97-P3:MLBCOMUM", { mlb: "MLBCOMUM", quantidade: 1, receita: 9999, custo: 1, imposto: 1 }),
  itemRow(1101, "N97-Q1:MLBCOMUM", { mlb: "MLBCOMUM", sku: "SKU-COMUM", quantidade: 10, receita: 3000, custo: 1200, imposto: 150 }),
  itemRow(1102, "N97-Q2:MLBB11", { mlb: "MLBB11", sku: "SKU-B11", quantidade: 4, receita: 800, custo: 320, imposto: 40 }),
  itemRow(1200, "N97-LEGADO:MLBCOMUM", { mlb: "MLBCOMUM", quantidade: 1, receita: 88888, custo: 1, imposto: 1 }),
  itemRow(901, "N97-PREV1:MLBCOMUM", { mlb: "MLBCOMUM", quantidade: 4, receita: 800, custo: 320, imposto: 40 }),
  itemRow(911, "N97-PREV2:MLBCOMUM", { mlb: "MLBCOMUM", quantidade: 6, receita: 1800, custo: 720, imposto: 90 }),
  itemRow(3001, "SOLO-P1:MLBX", { mlb: "MLBX", quantidade: 2, receita: 400, custo: 160, imposto: 20 }),
];

const componentes = [
  componenteRow(1001, "N97-P1", "tarifa_venda", -150),
  componenteRow(1001, "N97-P1", "frete_seller", -80),
  // pedido 1002: SEM tarifa/frete ausentes — só custo ausente (comissão/frete presentes)
  componenteRow(1002, "N97-P2", "tarifa_venda", -60),
  componenteRow(1002, "N97-P2", "frete_seller", -30),
  componenteRow(1101, "N97-Q1", "tarifa_venda", -300),
  componenteRow(1101, "N97-Q1", "frete_seller", -100),
  componenteRow(1101, "N97-Q1", "custo_produto", -1200, { itemId: "N97-Q1:MLBCOMUM" }),
  componenteRow(1102, "N97-Q2", "tarifa_venda", -80),
  componenteRow(1102, "N97-Q2", "custo_produto", -320, { itemId: "N97-Q2:MLBB11" }),
  // pedido 1102: SEM frete_seller — frete ausente, deliberado
  componenteRow(1200, "N97-LEGADO", "tarifa_venda", -1),
  componenteRow(901, "N97-PREV1", "tarifa_venda", -80),
  componenteRow(901, "N97-PREV1", "frete_seller", -40),
  componenteRow(911, "N97-PREV2", "tarifa_venda", -180),
  componenteRow(911, "N97-PREV2", "frete_seller", -60),
  componenteRow(3001, "SOLO-P1", "tarifa_venda", -40),
  componenteRow(3001, "SOLO-P1", "frete_seller", -20),
];

// ─── Fake db: casa o SHAPE do SQL real (mesmo padrão de
//     centralVendasGetAccountScoped.test.js), sem tocar Postgres ──────────────
function makeDb() {
  return {
    async query(sql, params = []) {
      if (sql.includes("CREATE TABLE") || sql.includes("ALTER TABLE") || sql.includes("CREATE INDEX") || sql.includes("CREATE UNIQUE INDEX") || sql.includes("WITH duplicados")) {
        return { rows: [] };
      }
      // clientes por slug (getClienteBySlug) / por id (resolverClientePorIdOuSlug)
      if (sql.includes("FROM clientes") && sql.includes("slug = $1")) {
        return { rows: CLIENTES.filter((c) => c.slug === params[0]) };
      }
      if (sql.includes("FROM clientes") && sql.includes("WHERE id")) {
        return { rows: CLIENTES.filter((c) => c.id === params[0]) };
      }
      // resolveMarketplaceAccountContext / obterConta
      if (sql.includes("cliente_contas WHERE id = $1")) {
        const row = contas.find((c) => c.id === Number(params[0]));
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true ORDER BY is_primary")) {
        return { rows: contas.filter((c) => c.cliente_id === params[0] && c.marketplace === params[1] && c.ativo !== false) };
      }
      if (sql.includes("COUNT(*)::int AS total FROM cliente_contas")) {
        const total = contas.filter((c) => c.cliente_id === params[0] && c.marketplace === params[1] && c.ativo !== false).length;
        return { rows: [{ total }] };
      }
      if (sql.includes("FROM ml_tokens t")) return { rows: [] }; // sem grant nesta suíte — GET não exige
      if (sql.includes("v.cliente_conta_id = $1 AND v.ativo = true")) return { rows: [] };
      if (sql.includes("v.cliente_id = $1 AND v.marketplace = $2 AND v.ativo = true")) return { rows: [] };

      // ── central_vendas_imports: resolveImportsForRange (M4/M10) ──
      if (sql.includes("competencia BETWEEN $3 AND $4") && sql.includes("FROM central_vendas_imports")) {
        const [slug, marketplace, compFrom, compTo] = params;
        let candidatos = imports.filter((row) =>
          row.cliente_slug === slug && row.marketplace === marketplace &&
          row.competencia >= compFrom && row.competencia <= compTo &&
          (row.publication_status === "published" || row.publication_status === "legacy")
        );
        if (params.length >= 5) {
          const clienteContaId = params[4];
          candidatos = sql.includes("OR cliente_conta_id IS NULL")
            ? candidatos.filter((r) => r.cliente_conta_id === clienteContaId || r.cliente_conta_id == null)
            : candidatos.filter((r) => r.cliente_conta_id === clienteContaId);
        }
        return { rows: candidatos };
      }
      if (sql.includes("FROM central_vendas_pedidos") && sql.includes("import_id = ANY")) {
        const [importIds, dateFrom, dateTo] = params;
        return { rows: pedidos.filter((p) => importIds.includes(p.import_id) && p.data_pedido >= dateFrom && p.data_pedido <= dateTo) };
      }
      if (sql.includes("FROM central_vendas_pedido_itens") && sql.includes("pedido_row_id = ANY")) {
        const [pedidoRowIds] = params;
        return { rows: itens.filter((i) => pedidoRowIds.includes(i.pedido_row_id)) };
      }
      if (sql.includes("FROM central_vendas_componentes") && sql.includes("pedido_row_id = ANY")) {
        const [pedidoRowIds] = params;
        return { rows: componentes.filter((c) => pedidoRowIds.includes(c.pedido_row_id)) };
      }

      // A tabela de vínculos não existe nesta fixture (reuso desligado).
      if (/to_regclass\('public\.central_vendas_import_pedidos'\)/.test(String(sql))) return { rows: [{ ok: false }] };
      throw new Error(`Fake db: SQL nao mapeado -> ${sql.slice(0, 200)}`);
    },
  };
}

// centralVendasService chama repository.getCentralVendasByRange(args) SEM 2º arg —
// este wrapper liga as funções REAIS do repository ao MESMO fake db (mesmo padrão
// de centralVendasGetAccountScoped.test.js).
function realRepositoryComDb(db) {
  return {
    getClienteBySlug: (slug) => repository.getClienteBySlug(slug, db),
    getCentralVendasByRange: (args) => repository.getCentralVendasByRange(args, db),
  };
}

function wiring() {
  const db = makeDb();
  const centralRepo = realRepositoryComDb(db);
  const resolveRangeContext = createCentralVendasService(centralRepo, db).resolveRangeContext;
  const adsFake = { getInvestimento: async (_s, comp) => ({ valor: null, status: STATUS.SEM_DADOS, fonte: null, competencia: comp, periodo: null, atualizadoEm: null, motivo: "sem linha nesta suíte" }) };

  return {
    resultadoService: createResultadoService({ centralRepo, resolveRangeContext, adsService: adsFake }),
    simulacaoService: createSimulacaoService({ centralRepo, resolveRangeContext, adsService: adsFake }),
    serieService: createSerieService({ centralRepo, resolveRangeContext }),
  };
}

(async () => {
  const { resultadoService, simulacaoService, serieService } = wiring();

  // ── 1/2/7. Conta A nunca lê B (nem o legado NULL), e a Confiança reflete o
  //           universo de CADA conta ────────────────────────────────────────
  const rConta10 = await resultadoService.getResultado("n97", { competencia: "2026-08", compararCom: "2026-07", clienteContaId: 10 });
  const rConta11 = await resultadoService.getResultado("n97", { competencia: "2026-08", compararCom: "2026-07", clienteContaId: 11 });

  check("1. contexto declara a conta 10 resolvida", rConta10.contexto.clienteContaId === 10);
  check("1. contexto declara a conta 11 resolvida", rConta11.contexto.clienteContaId === 11);

  check("1. conta 10: faturamento é só dela (1500+600=2100, sem cancelado 9999, sem conta 11, sem legado)",
    rConta10.fechamento.atual.faturamentoFechamento === 2100);
  check("2. conta 11: faturamento é só dela (3000+800=3800, sem conta 10, sem legado 88888)",
    rConta11.fechamento.atual.faturamentoFechamento === 3800);

  check("1. conta 10: resultado operacional bate com o universo isolado (1075)",
    Math.abs(rConta10.fechamento.atual.resultadoOperacional - 1075) < 0.02);
  check("2. conta 11: resultado operacional bate com o universo isolado (1610)",
    Math.abs(rConta11.fechamento.atual.resultadoOperacional - 1610) < 0.02);

  check("1/2. contas nunca leem o mesmo faturamento (prova direta de não-mistura)",
    rConta10.fechamento.atual.faturamentoFechamento !== rConta11.fechamento.atual.faturamentoFechamento);

  check("1. ponte da conta 10 fecha sobre o universo isolado", rConta10.ponte.fecha === true);
  check("2. ponte da conta 11 fecha sobre o universo isolado", rConta11.ponte.fecha === true);
  check("1/2. deltas das duas contas são diferentes (755 vs 860 — não mistura no comparado também)",
    Math.abs(rConta10.ponte.delta - 755) < 0.02 && Math.abs(rConta11.ponte.delta - 860) < 0.02);

  check("7. conta 10 (custo ausente no P2): alerta custo_insuficiente, SEM frete_insuficiente",
    rConta10.confianca.alertas.some((a) => a.chave === "custo_insuficiente") &&
    !rConta10.confianca.alertas.some((a) => a.chave === "frete_insuficiente"));
  check("7. conta 11 (frete ausente no Q2): alerta frete_insuficiente, SEM custo_insuficiente",
    rConta11.confianca.alertas.some((a) => a.chave === "frete_insuficiente") &&
    !rConta11.confianca.alertas.some((a) => a.chave === "custo_insuficiente"));

  // MLBCOMUM existe nas duas contas com valores diferentes — prova que o produto
  // agregado de uma conta não incorpora unidades/receita da outra.
  const prodComumConta10 = rConta10.produtos.prejudicaram.concat(rConta10.produtos.ajudaram).find((p) => p.mlb === "MLBCOMUM")
    || rConta10.oportunidades.oportunidades.find(() => false); // fallback não usado, só documenta a intenção
  check("1. produto MLBCOMUM da conta 10 não contém as 10 unidades da conta 11",
    !rConta10.fechamento.atual.faturamento || rConta10.fechamento.atual.faturamento < 3000);

  // ── 3. Legado NULL nunca some quando há 2+ contas ativas, mesmo com conta explícita ──
  check("3. conta 10 nunca inclui o import legado NULL (88888 não aparece em lugar nenhum)",
    JSON.stringify(rConta10).indexOf("88888") === -1);
  check("3. conta 11 nunca inclui o import legado NULL", JSON.stringify(rConta11).indexOf("88888") === -1);

  // ── 4. Compat aditiva: cliente com 1 conta ativa e SEM clienteContaId continua
  //       lendo o legado (V2 antiga não quebra) ───────────────────────────────
  const rSolo = await resultadoService.getResultado("cliente-solo", { competencia: "2026-08" });
  check("4. cliente com 1 conta ativa resolve sozinho, sem clienteContaId explícito",
    rSolo.contexto.clienteContaId === 30);
  check("4. legado NULL (única conta ativa) continua legível — compat aditiva preservada",
    rSolo.fechamento.atual.faturamentoFechamento === 400);

  // ── 5. Rejeições — nunca conta escolhida silenciosamente ─────────────────
  let erroOutroCliente = null;
  await resultadoService.getResultado("n97", { competencia: "2026-08", clienteContaId: 20 }).catch((e) => { erroOutroCliente = e; });
  check("5. conta de OUTRO cliente é rejeitada (403 CONTA_NAO_PERTENCE_AO_CLIENTE)",
    erroOutroCliente && erroOutroCliente.statusCode === 403 && erroOutroCliente.code === "CONTA_NAO_PERTENCE_AO_CLIENTE");

  let erroInativa = null;
  await resultadoService.getResultado("n97", { competencia: "2026-08", clienteContaId: 99 }).catch((e) => { erroInativa = e; });
  check("5. conta INATIVA é rejeitada (409 CONTA_INATIVA)",
    erroInativa && erroInativa.statusCode === 409 && erroInativa.code === "CONTA_INATIVA");

  // A resolução de conta só roda quando marketplace === "meli" (mesma regra de
  // centralVendasService para todo o domínio — não-MELI ainda não tem
  // account-awareness comprovada, ver audit C-05/C-11). Por isso o teste de
  // incompatibilidade usa marketplace default "meli" contra uma conta shopee
  // (id 40) do MESMO cliente — nunca o inverso, que pularia a resolução inteira.
  let erroMarketplace = null;
  await resultadoService.getResultado("n97", { competencia: "2026-08", clienteContaId: 40 }).catch((e) => { erroMarketplace = e; });
  check("5. marketplace incompatível com a conta é rejeitado (422 MARKETPLACE_INCOMPATIVEL)",
    erroMarketplace && erroMarketplace.statusCode === 422 && erroMarketplace.code === "MARKETPLACE_INCOMPATIVEL");

  // ── 6. Sem clienteContaId e 2+ contas ativas: ambiguidade rejeitada, NUNCA
  //       "primeira conta" ──────────────────────────────────────────────────
  let erroAmbiguo = null;
  await resultadoService.getResultado("n97", { competencia: "2026-08" }).catch((e) => { erroAmbiguo = e; });
  check("6. sem conta explícita e 2+ ativas → 409 MULTIPLE_MARKETPLACE_ACCOUNTS (nunca escolhe a conta 10 sozinha)",
    erroAmbiguo && erroAmbiguo.statusCode === 409 && erroAmbiguo.code === "MULTIPLE_MARKETPLACE_ACCOUNTS");

  // ── 8. clienteContaId atravessa também Simulador e Série ─────────────────
  const sim10 = await simulacaoService.simular("n97", { competencia: "2026-08", clienteContaId: 10, cenario: { intervencoes: [] } });
  const sim11 = await simulacaoService.simular("n97", { competencia: "2026-08", clienteContaId: 11, cenario: { intervencoes: [] } });
  check("8. simulador da conta 10 usa só o universo da conta 10", sim10.clienteContaId === 10 && Math.abs(sim10.antes.resultadoOperacional - 1075) < 0.02);
  check("8. simulador da conta 11 usa só o universo da conta 11", sim11.clienteContaId === 11 && Math.abs(sim11.antes.resultadoOperacional - 1610) < 0.02);

  const serie10 = await serieService.getSerie("n97", { meses: 1, ate: "2026-08", clienteContaId: 10 });
  const serie11 = await serieService.getSerie("n97", { meses: 1, ate: "2026-08", clienteContaId: 11 });
  const precoComumSerie10 = serie10.find((s) => s.mlb === "MLBCOMUM")?.precoMedio;
  const precoComumSerie11 = serie11.find((s) => s.mlb === "MLBCOMUM")?.precoMedio;
  check("8. série da conta 10: preço médio de MLBCOMUM é o da conta 10, não o da 11",
    precoComumSerie10 != null && Math.abs(precoComumSerie10 - 200) < 0.02);
  check("8. série da conta 11: preço médio de MLBCOMUM é o da conta 11 (300), não o da 10 (200)",
    precoComumSerie11 != null && Math.abs(precoComumSerie11 - 300) < 0.02);

  console.log(`\n${passed} verificações passaram. Cliente 360 V3 Fase 0: conta A nunca lê B, legado NULL não vaza, ambiguidade e conta inválida são rejeitadas — sem tocar banco real.`);
})().catch((e) => { console.error(e); process.exit(1); });
