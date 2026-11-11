process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";
process.env.SQUADS_ENFORCEMENT = "on";

const assert = require("assert");
const pool = require("../config/database");

const originalQuery = pool.query;
let pedidosQueries = 0;

pool.query = async (sql, params = []) => {
  const q = String(sql).replace(/\s+/g, " ");
  if (q.includes("authz:RESOLVE_CLIENTE_ID")) return { rows: [{ id: 7, slug: "amr", nome: "AMR" }] };
  if (q.includes("authz:CAN_ACCESS_ADMIN")) return { rows: [{ ok: 1 }] };
  if (q.includes("painelContas:CONTAS_DOS_CLIENTES")) return { rows: [
    { id: 11, cliente_id: 7, marketplace: "meli", nome: "Loja 1", ativo: true },
    { id: 12, cliente_id: 7, marketplace: "meli", nome: "Loja 2", ativo: true },
    { id: 13, cliente_id: 7, marketplace: "meli", nome: "Loja 3", ativo: true },
  ] };
  if (q.includes("painelContas:IMPORTS_DA_COMPETENCIA")) return { rows: [
    { id: 101, cliente_conta_id: 11, competencia: "2026-09", publication_status: "published", coverage_date_from: "2026-09-01", coverage_date_to: "2026-09-30", published_at: "2026-10-01T01:00:00Z" },
    { id: 102, cliente_conta_id: 12, competencia: "2026-09", publication_status: "published", coverage_date_from: "2026-09-01", coverage_date_to: "2026-09-30", published_at: "2026-10-01T01:00:00Z" },
  ] };
  if (q.includes("painelContas:PEDIDOS_DOS_IMPORTS")) {
    pedidosQueries += 1;
    assert.deepStrictEqual(params[0], [101, 102]);
    assert.strictEqual(params[1], "2026-09-01");
    assert.strictEqual(params[2], "2026-09-30");
    return { rows: [
      { import_id: 101, data_pedido: "2026-09-02", status: "paid", confianca: "confiavel", faturamento: 100, resultado: 20 },
      { import_id: 101, data_pedido: "2026-09-03", status: "cancelled", confianca: "confiavel", faturamento: 999, resultado: 999 },
      { import_id: 102, data_pedido: "2026-09-03", status: "paid", confianca: "bloqueado", faturamento: 50, resultado: null },
    ] };
  }
  // A tabela de vínculos não existe nesta fixture (reuso desligado).
  if (/to_regclass\('public\.central_vendas_import_pedidos'\)/.test(String(q))) return { rows: [{ ok: false }] };
  throw new Error(`Query inesperada: ${q}`);
};

const service = require("../services/painelContas/painelContasService");

(async () => {
  try {
    const resposta = await service.listarSemanasDasContas({ id: 1, role: "admin" }, "7", "2026-09");
    assert.strictEqual(resposta.contas.length, 3);
    assert.strictEqual(resposta.contas[0].semanas[0].resumo.fat, 100);
    assert.strictEqual(resposta.contas[0].semanas[0].resumo.lc, 20);
    assert.strictEqual(resposta.contas[0].semanas[0].resumo.mc, 0.2);
    assert.strictEqual(resposta.contas[1].semanas[0].resumo.fat, 50);
    assert.strictEqual(resposta.contas[1].semanas[0].resumo.lc, null);
    assert.deepStrictEqual(resposta.contas[2].semanas, []);
    assert.strictEqual(pedidosQueries, 1, "pedidos devem ser carregados em um único batch");
    console.log("\npainelContasSemanasContasService.test.js: endpoint batch validado.");
  } finally {
    pool.query = originalQuery;
  }
})().catch((err) => {
  pool.query = originalQuery;
  console.error(err);
  process.exitCode = 1;
});
