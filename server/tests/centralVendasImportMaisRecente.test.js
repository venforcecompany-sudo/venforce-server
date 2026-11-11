// Prova que a leitura por intervalo (getCentralVendasByRange) usa somente o
// import MAIS RECENTE de cada competencia — persistir dois imports da mesma
// competencia (ex.: uma resync apos a correcao do frete) nao deve somar nem
// misturar pedidos/componentes do import anterior.

const assert = require("assert");
const { getCentralVendasByRange } = require("../services/centralVendas/centralVendasRepository");

const CLIENTE_SLUG = "cliente-teste";
const MARKETPLACE = "meli";
const COMPETENCIA = "2026-07";

// ── "banco" em memoria ───────────────────────────────────────────────────────

const imports = [
  {
    id: 100,
    competencia: COMPETENCIA,
    fonte: "orders_api",
    status: "processado",
    confianca: "parcial",
    resumo_json: "{}",
    payload_json: "{}",
    created_at: "2026-07-05T10:00:00.000Z", // import ANTIGO (antes da correcao do frete)
    updated_at: "2026-07-05T10:00:00.000Z",
    cliente_slug: CLIENTE_SLUG,
    marketplace: MARKETPLACE,
    publication_status: "legacy",
  },
  {
    id: 200,
    competencia: COMPETENCIA,
    fonte: "orders_api",
    status: "processado",
    confianca: "confiavel",
    resumo_json: "{}",
    payload_json: "{}",
    created_at: "2026-07-06T10:00:00.000Z", // import NOVO (depois da correcao do frete)
    updated_at: "2026-07-06T10:00:00.000Z",
    cliente_slug: CLIENTE_SLUG,
    marketplace: MARKETPLACE,
    publication_status: "legacy",
  },
];

const pedidos = [
  { id: 1, import_id: 100, pedido_id: "P_ANTIGO", data_pedido: "2026-07-10", shipment_id: "S_OLD" },
  { id: 2, import_id: 200, pedido_id: "P_NOVO", data_pedido: "2026-07-10", shipment_id: "S_NEW" },
];

const componentes = [
  { id: 1, pedido_row_id: 1, pedido_id: "P_ANTIGO", tipo: "frete_seller", valor: null, confianca: "ausente" },
  { id: 2, pedido_row_id: 2, pedido_id: "P_NOVO", tipo: "frete_seller", valor: -12.5, confianca: "real" },
];

const fakeDb = {
  async query(sql, params) {
    // M4: o repository real agora busca TODAS as linhas candidatas
    // (published/legacy) e reduz em JS (selecionarMelhorImportPorCompetencia)
    // — este fake só filtra, sem escolher a "mais recente" por competência.
    if (/competencia BETWEEN \$3 AND \$4/.test(sql) && /FROM central_vendas_imports/.test(sql)) {
      const [slug, marketplace, compFrom, compTo] = params;
      const candidatos = imports.filter(
        (row) =>
          row.cliente_slug === slug &&
          row.marketplace === marketplace &&
          row.competencia >= compFrom &&
          row.competencia <= compTo &&
          (row.publication_status === "published" || row.publication_status === "legacy")
      );
      return { rows: candidatos };
    }

    if (/FROM central_vendas_pedidos/.test(sql) && /import_id = ANY/.test(sql)) {
      const [importIds, dateFrom, dateTo] = params;
      const rows = pedidos.filter(
        (p) => importIds.includes(p.import_id) && p.data_pedido >= dateFrom && p.data_pedido <= dateTo
      );
      return { rows };
    }

    if (/FROM central_vendas_pedido_itens/.test(sql)) {
      return { rows: [] };
    }

    if (/FROM central_vendas_componentes/.test(sql) && /pedido_row_id = ANY/.test(sql)) {
      const [pedidoRowIds] = params;
      return { rows: componentes.filter((c) => pedidoRowIds.includes(c.pedido_row_id)) };
    }

    // A tabela de vínculos não existe nesta fixture (reuso desligado).
    if (/to_regclass\('public\.central_vendas_import_pedidos'\)/.test(String(sql))) return { rows: [{ ok: false }] };
    throw new Error(`Query nao esperada no fake db: ${sql}`);
  },
};

async function run() {
  const snapshot = await getCentralVendasByRange(
    { clienteSlug: CLIENTE_SLUG, dateFrom: "2026-07-01", dateTo: "2026-07-31", marketplace: MARKETPLACE },
    fakeDb
  );

  assert.ok(snapshot, "deve retornar um snapshot quando ha imports no periodo");
  assert.strictEqual(snapshot.imports.length, 1, "so 1 import por competencia deve ser selecionado");
  assert.strictEqual(snapshot.imports[0].id, 200, "deve escolher o import mais recente (id=200)");
  assert.strictEqual(snapshot.importacao.id, 200);

  assert.strictEqual(snapshot.pedidos.length, 1, "nao pode misturar pedidos do import antigo");
  assert.strictEqual(snapshot.pedidos[0].pedido_id, "P_NOVO");
  assert.strictEqual(
    snapshot.pedidos.some((p) => p.pedido_id === "P_ANTIGO"),
    false,
    "pedido do import antigo nao pode aparecer na leitura"
  );

  assert.strictEqual(snapshot.componentes.length, 1);
  assert.strictEqual(snapshot.componentes[0].valor, -12.5, "componente deve vir do import novo (frete real)");

  console.log("  ✓ GET por periodo usa somente o import mais recente por competencia");
  console.log("  ✓ nao soma nem mistura pedidos/componentes do import anterior");
  console.log("centralVendasImportMaisRecente.test.js passed");
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
