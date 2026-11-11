// server/tests/motorMargemCentralVendasContaScoped.test.js
//
// BUG real (achado investigando "% Faturamento sempre null" em Anúncios ML):
// motorMargemService.prepareWorkspaceContext recebe clienteContaId (usa para
// exigirContexto), mas nunca o repassava para
// centralVendasEvidenceAdapter.carregarVendasDoPeriodo — que por sua vez
// também não aceitava/repassava o parâmetro para
// centralVendasRepository.getCentralVendasByRange. A leitura sempre caía no
// ramo "cliente_conta_id IS NULL" (nenhuma conta informada): um cliente
// multi-conta com vendas importadas COM cliente_conta_id preenchido nunca
// tinha o realizado encontrado — porMlb ficava vazio, receitaTotalPeriodo
// zerava, % Faturamento (sem fallback) mostrava "—" para todo item. A margem
// "realized" tinha o mesmo buraco, mascarado pelo fallback "projected"
// (custo, não venda).
//
// Decisão de correção (auditoria "Investigação backend — faturamento
// Anúncios ML retornando null"): includeLegacy = true sempre neste caminho —
// prioriza o import vinculado à cliente_conta_id atual, aceita fallback para
// import legado (cliente_conta_id NULL, dado anterior à fundação multi-
// conta), mas NUNCA lê o import de outra cliente_conta_id.
//
// Este teste exercita a cadeia REAL (nenhum mock de SQL/filtro): chama
// centralVendasEvidenceAdapter.carregarVendasDoPeriodo (a função que
// motorMargemService chama) contra um fake db que filtra de verdade — mesmo
// padrão de server/tests/centralVendasGetAccountScoped.test.js, sem as
// tabelas de resolução de identidade (cliente_contas/ml_tokens/...) porque
// esta função recebe clienteContaId já resolvido, não resolve identidade.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const centralVendas = require("../services/motorMargem/adapters/centralVendasEvidenceAdapter");

const casos = [];
function cenario(nome, fn) {
  casos.push({ nome, fn });
}

function makeDb({ imports = [], pedidos = [], itens = [], componentes = [] }) {
  return {
    async query(sql, params = []) {
      // ── central_vendas_imports (resolveImportsForRange) ──
      if (sql.includes("FROM central_vendas_imports") && sql.includes("competencia BETWEEN $3 AND $4")) {
        const [slug, marketplace, compFrom, compTo] = params;
        let candidatos = imports.filter((row) =>
          row.cliente_slug === slug && row.marketplace === marketplace &&
          row.competencia >= compFrom && row.competencia <= compTo &&
          (row.publication_status === "published" || row.publication_status === "legacy")
        );
        if (params.length >= 5) {
          const clienteContaId = params[4];
          if (sql.includes("OR cliente_conta_id IS NULL")) {
            candidatos = candidatos.filter((r) => r.cliente_conta_id === clienteContaId || r.cliente_conta_id == null);
          } else {
            candidatos = candidatos.filter((r) => r.cliente_conta_id === clienteContaId);
          }
        } else {
          candidatos = candidatos.filter((r) => r.cliente_conta_id == null);
        }
        return { rows: candidatos };
      }
      // ── central_vendas_pedidos (loadPedidosByImportIds) ──
      if (sql.includes("FROM central_vendas_pedidos") && sql.includes("import_id = ANY")) {
        const [importIds, dateFrom, dateTo] = params;
        return {
          rows: pedidos.filter((p) => importIds.includes(p.import_id) && p.data_pedido >= dateFrom && p.data_pedido <= dateTo),
        };
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
      throw new Error(`Fake db: SQL nao mapeado -> ${sql.slice(0, 160)}`);
    },
  };
}

const CLIENTE_SLUG = "cliente-a";

// Conta 10 e conta 11, MESMA competência (2026-07) — prova que a conta errada
// nunca entra mesmo dentro do mesmo mês. Import legado (NULL) fica numa
// competência DIFERENTE (2026-08) — prova que o fallback funciona por
// competência, não some/mistura com as contas.
const IMPORTS = [
  { id: 100, cliente_slug: CLIENTE_SLUG, marketplace: "meli", competencia: "2026-07", cliente_conta_id: 10, publication_status: "legacy", created_at: "2026-07-31T10:00:00Z" },
  { id: 101, cliente_slug: CLIENTE_SLUG, marketplace: "meli", competencia: "2026-07", cliente_conta_id: 11, publication_status: "legacy", created_at: "2026-07-31T11:00:00Z" },
  { id: 200, cliente_slug: CLIENTE_SLUG, marketplace: "meli", competencia: "2026-08", cliente_conta_id: null, publication_status: "legacy", created_at: "2026-08-10T10:00:00Z" },
];

const PEDIDOS = [
  { id: 1, import_id: 100, pedido_id: "P_CONTA10", status: "pago", data_pedido: "2026-07-10" },
  { id: 2, import_id: 101, pedido_id: "P_CONTA11", status: "pago", data_pedido: "2026-07-12" },
  { id: 3, import_id: 200, pedido_id: "P_LEGADO", status: "pago", data_pedido: "2026-08-05" },
];

// mlb precisa ser um MLB "de verdade" (MLB + dígitos) — normalizeId()
// stripa qualquer letra que não seja o prefixo MLB, então um id como
// "MLB-CONTA10" viraria só "MLB10" e mascararia o teste.
const MLB_CONTA10 = "MLB1000000010";
const MLB_CONTA11 = "MLB1000000011";
const MLB_LEGADO = "MLB1000000099";

const ITENS = [
  { id: 10, pedido_row_id: 1, mlb: MLB_CONTA10, quantidade: 1, valor_unitario: 100, receita_produto: 100 },
  { id: 11, pedido_row_id: 2, mlb: MLB_CONTA11, quantidade: 1, valor_unitario: 200, receita_produto: 200 },
  { id: 12, pedido_row_id: 3, mlb: MLB_LEGADO, quantidade: 1, valor_unitario: 50, receita_produto: 50 },
];

function db() {
  return makeDb({ imports: IMPORTS, pedidos: PEDIDOS, itens: ITENS, componentes: [] });
}

const RANGE = { clienteSlug: CLIENTE_SLUG, dateFrom: "2026-07-01", dateTo: "2026-08-31", marketplace: "meli" };

cenario("1. cliente_conta_id informado: retorna dados da conta correta", async () => {
  const vendas = await centralVendas.carregarVendasDoPeriodo({ ...RANGE, clienteContaId: 10, includeLegacy: true }, db());
  const mlbs = vendas.itens.map((i) => i.mlb).sort();
  assert.ok(mlbs.includes(MLB_CONTA10), "precisa trazer o item da própria conta");
});

cenario("2. cliente_conta_id informado + dados legados: aceita fallback legado", async () => {
  const vendas = await centralVendas.carregarVendasDoPeriodo({ ...RANGE, clienteContaId: 10, includeLegacy: true }, db());
  const mlbs = vendas.itens.map((i) => i.mlb).sort();
  assert.ok(mlbs.includes(MLB_LEGADO), "import legado (cliente_conta_id NULL) precisa entrar como fallback");
});

cenario("3. cliente_conta_id informado: nunca retorna dados de outra cliente_conta_id", async () => {
  const vendas = await centralVendas.carregarVendasDoPeriodo({ ...RANGE, clienteContaId: 10, includeLegacy: true }, db());
  const mlbs = vendas.itens.map((i) => i.mlb);
  assert.ok(!mlbs.includes(MLB_CONTA11), "item da conta 11 nunca pode aparecer para quem pediu a conta 10");
  const pedidoIds = vendas.pedidos.map((p) => p.pedido_id);
  assert.ok(!pedidoIds.includes("P_CONTA11"), "pedido da conta 11 nunca pode aparecer para quem pediu a conta 10");

  // Espelhado (conta 11 pedindo não vê a 10) — mesma regra nos dois sentidos.
  const vendas11 = await centralVendas.carregarVendasDoPeriodo({ ...RANGE, clienteContaId: 11, includeLegacy: true }, db());
  const mlbs11 = vendas11.itens.map((i) => i.mlb);
  assert.ok(!mlbs11.includes(MLB_CONTA10), "item da conta 10 nunca pode aparecer para quem pediu a conta 11");
});

cenario("agregarPorMlb sobre o realizado da conta 10 produz receita > 0 (o sintoma original some)", async () => {
  const vendas = await centralVendas.carregarVendasDoPeriodo({ ...RANGE, clienteContaId: 10, includeLegacy: true }, db());
  const { porMlb } = centralVendas.agregarPorMlb({
    pedidosTodos: vendas.pedidosTodos,
    pedidosResultado: vendas.pedidos,
    itens: vendas.itens,
    componentes: vendas.componentes,
  });
  let receitaTotalPeriodo = 0;
  for (const agregado of porMlb.values()) receitaTotalPeriodo += agregado.receita || 0;
  assert.ok(receitaTotalPeriodo > 0, "receitaTotalPeriodo não pode ficar zerada quando a conta tem vendas");
  assert.strictEqual(porMlb.get(MLB_CONTA10).receita, 100);
});

async function main() {
  let falhas = 0;
  for (const caso of casos) {
    try {
      await caso.fn();
      console.log(`  ✓ ${caso.nome}`);
    } catch (err) {
      falhas += 1;
      console.error(`  ✗ ${caso.nome}\n    ${err.message}`);
    }
  }
  if (falhas > 0) {
    console.error(`motorMargemCentralVendasContaScoped: ${falhas} de ${casos.length} cenários falharam`);
    process.exitCode = 1;
  } else {
    console.log(`motorMargemCentralVendasContaScoped: ok (${casos.length} cenários)`);
  }
}

main();
