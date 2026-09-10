// server/tests/baseCustosShopeeBaseVinculada.test.js
//
// Missão Financeiro V3 — Shopee passa a poder fechar por BASE VINCULADA
// (paridade operacional com o MELI). A resolução da base já era
// marketplace-agnóstica (resolverBaseVinculada); o que faltava era
// buildCostRowsFromBase emitir as linhas de custo nas chaves que o parser
// de custos da Shopee (parseCostRows em shopeePerformanceService) já
// reconhece — sem tocar em regra de match, fórmula ou motor.
//
// Cobre o checklist da missão:
//   · 2 variações do mesmo produto (model_id distintos, custos distintos)
//     chegam ao motor preservadas, endereçáveis por model_id;
//   · a base resolvida é a da clienteContaId informada;
//   · conta A nunca usa a base da conta B (isolamento + 409 sem contaId);
//   · sem vínculo → 404 (volta para upload obrigatório no controller);
//   · base sem NENHUM identificador de produto/variação → 422 (bloqueia,
//     não faz fallback por produto-pai).

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const pool = require("../config/database");
const {
  resolverBaseVinculada,
  buildCostRowsFromBase,
} = require("../services/bases/baseCustosService");
const { buildShopeeCostMap } = require("../services/fechamentoFinanceiro/shopeePerformanceService");
const { normalizeMatchKey } = require("../utils/textUtils");
const { podeResolverCustosSemUpload } = require("../controllers/fechamentosFinanceiroController");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}
async function rejeitaCom(label, promise, verificar) {
  let erro = null;
  try { await promise; } catch (e) { erro = e; }
  assert.ok(erro, `FALHOU (nao rejeitou): ${label}`);
  if (verificar) {
    assert.ok(
      verificar(erro),
      `FALHOU (erro inesperado): ${label} — status=${erro.statusCode} code=${erro.code} msg=${erro.message}`
    );
  }
  checks += 1;
  console.log(`  ok  ${label}`);
}

class MockDb {
  constructor({ bases = [], vinculos = [], contas = [], custos = {} } = {}) {
    this.bases = bases;
    this.vinculos = vinculos;
    this.contas = contas;
    this.custos = custos;
  }

  async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, " ").trim();

    if (q.includes("FROM bases b") && q.includes("JOIN base_cliente_vinculos v")) {
      const [slug, mkt] = params;
      const rows = this.vinculos
        .filter((v) => v.cliente_slug === slug && v.marketplace === mkt && v.ativo !== false)
        .map((v) => {
          const base = this.bases.find((b) => b.id === v.base_id);
          if (!base || base.ativo === false) return null;
          return {
            id: base.id,
            slug: base.slug,
            nome: base.nome,
            cliente_conta_id: v.cliente_conta_id ?? null,
            updated_at: v.updated_at,
          };
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      return { rows };
    }

    if (q.startsWith("SELECT * FROM cliente_contas WHERE id = ANY")) {
      const ids = params[0] || [];
      return { rows: this.contas.filter((c) => ids.includes(c.id)) };
    }

    if (q.includes("FROM custos") && q.includes("WHERE base_id = $1")) {
      return { rows: this.custos[Number(params[0])] || [] };
    }

    throw new Error(`Query nao mockada: ${q.slice(0, 140)}`);
  }
}

async function withMockDb(fixture, fn) {
  const original = pool.query;
  pool.query = (sql, params) => new MockDb(fixture).query(sql, params);
  try { await fn(); } finally { pool.query = original; }
}

// Duas variações do MESMO produto-pai (produto_id 777), model_id distintos,
// custos distintos. É o cenário que a missão pede provar: o custo não pode
// "achatar" para o produto-pai.
const custosDuasVariacoes = [
  { produto_id: "777", sku_id: "", sku: "AZUL-P", custo_produto: 12.5, imposto_percentual: 4, id_model: "5001", produto_nome: "Camiseta", variacao_nome: "Azul P" },
  { produto_id: "777", sku_id: "", sku: "AZUL-G", custo_produto: 19.9, imposto_percentual: 4, id_model: "5002", produto_nome: "Camiseta", variacao_nome: "Azul G" },
];

async function run() {
  // ── 1. costRows preserva as duas variações, endereçáveis por model_id ────
  await withMockDb(
    {
      bases: [{ id: 900, slug: "shopee-zenite", nome: "Shopee Zenite", ativo: true }],
      vinculos: [{ base_id: 900, cliente_slug: "zenite", marketplace: "shopee", ativo: true, cliente_conta_id: 38, updated_at: "2026-09-01" }],
      custos: { 900: custosDuasVariacoes },
    },
    async () => {
      const resolved = await buildCostRowsFromBase({
        clienteSlug: "zenite",
        marketplace: "shopee",
        clienteContaId: 38,
      });
      ok("resolveu a base vinculada da conta 38", resolved.base.id === 900);
      ok("emitiu uma linha de custo por variação", resolved.costRows.length === 2);

      // As chaves têm que ser as que o parseCostRows da Shopee reconhece.
      const linha = resolved.costRows[0];
      ok("linha tem chave de item reconhecível", "id do item" in linha);
      ok("linha tem chave de model/variação reconhecível", "id model" in linha);
      ok("linha tem SKU", "sku" in linha);
      ok("linha tem custo", "custo" in linha);
      ok("linha tem imposto", "imposto" in linha);

      // O motor da Shopee tem que conseguir separar os custos por model_id.
      const costMap = buildShopeeCostMap(resolved.costRows);
      const custoP = costMap.get(normalizeMatchKey("5001"));
      const custoG = costMap.get(normalizeMatchKey("5002"));
      ok("model_id 5001 mapeia para o custo da variação P (12.5)", custoP && custoP.cost === 12.5);
      ok("model_id 5002 mapeia para o custo da variação G (19.9)", custoG && custoG.cost === 19.9);
      ok("os dois custos são de fato distintos no map", custoP.cost !== custoG.cost);
    }
  );

  // ── 2. conta A nunca usa a base da conta B ──────────────────────────────
  const basesDuasContas = [
    { id: 900, slug: "shopee-conta-38", nome: "Shopee Conta 38", ativo: true },
    { id: 901, slug: "shopee-conta-39", nome: "Shopee Conta 39", ativo: true },
  ];
  const vinculosDuasContas = [
    { base_id: 900, cliente_slug: "zenite", marketplace: "shopee", ativo: true, cliente_conta_id: 38, updated_at: "2026-08-01" },
    { base_id: 901, cliente_slug: "zenite", marketplace: "shopee", ativo: true, cliente_conta_id: 39, updated_at: "2026-09-01" },
  ];
  const contas = [
    { id: 38, cliente_id: 1, marketplace: "shopee", nome: "Shopee 38", is_primary: true, ativo: true },
    { id: 39, cliente_id: 1, marketplace: "shopee", nome: "Shopee 39", is_primary: false, ativo: true },
  ];

  await withMockDb(
    { bases: basesDuasContas, vinculos: vinculosDuasContas, contas, custos: { 900: custosDuasVariacoes, 901: custosDuasVariacoes } },
    async () => {
      const c38 = await resolverBaseVinculada({ clienteSlug: "zenite", marketplace: "shopee", clienteContaId: 38 });
      ok("conta 38 → base 900", c38.id === 900);
      const c39 = await resolverBaseVinculada({ clienteSlug: "zenite", marketplace: "shopee", clienteContaId: 39 });
      ok("conta 39 → base 901 (nunca a 900 da outra conta)", c39.id === 901);

      const buildC38 = await buildCostRowsFromBase({ clienteSlug: "zenite", marketplace: "shopee", clienteContaId: 38 });
      ok("buildCostRowsFromBase respeita a conta 38", buildC38.base.id === 900);

      await rejeitaCom(
        "sem clienteContaId, 2 contas distintas → 409 (não escolhe sozinho)",
        buildCostRowsFromBase({ clienteSlug: "zenite", marketplace: "shopee" }),
        (e) => e.statusCode === 409 && e.code === "MULTIPLE_MARKETPLACE_ACCOUNTS"
      );
    }
  );

  // ── 3. sem vínculo → resolve null / 404 (controller cai no upload) ──────
  await withMockDb(
    { bases: [{ id: 900, slug: "shopee-zenite", nome: "Shopee Zenite", ativo: true }], vinculos: [], custos: {} },
    async () => {
      const base = await resolverBaseVinculada({ clienteSlug: "zenite", marketplace: "shopee", clienteContaId: 38 });
      ok("sem vínculo Shopee: resolverBaseVinculada devolve null", base === null);
      await rejeitaCom(
        "sem vínculo Shopee: buildCostRowsFromBase → 404",
        buildCostRowsFromBase({ clienteSlug: "zenite", marketplace: "shopee", clienteContaId: 38 }),
        (e) => e.statusCode === 404
      );
    }
  );

  // ── 4. base sem NENHUM identificador → 422 (bloqueia, não achata) ───────
  await withMockDb(
    {
      bases: [{ id: 900, slug: "shopee-zenite", nome: "Shopee Zenite", ativo: true }],
      vinculos: [{ base_id: 900, cliente_slug: "zenite", marketplace: "shopee", ativo: true, cliente_conta_id: 38, updated_at: "2026-09-01" }],
      custos: {
        900: [
          { produto_id: "", sku_id: "", sku: "", custo_produto: 10, imposto_percentual: 0, id_model: "", produto_nome: "X", variacao_nome: "" },
        ],
      },
    },
    async () => {
      await rejeitaCom(
        "base Shopee sem produto_id/id_model/sku → 422, com motivo",
        buildCostRowsFromBase({ clienteSlug: "zenite", marketplace: "shopee", clienteContaId: 38 }),
        (e) => e.statusCode === 422 && /identificador/i.test(e.message)
      );
    }
  );

  // ── 5. MELI inalterado: continua emitindo as chaves do parser do MELI ──
  await withMockDb(
    {
      bases: [{ id: 900, slug: "meli-zenite", nome: "MELI Zenite", ativo: true }],
      vinculos: [{ base_id: 900, cliente_slug: "zenite", marketplace: "meli", ativo: true, cliente_conta_id: 10, updated_at: "2026-09-01" }],
      custos: { 900: [{ produto_id: "MLB1", sku_id: "", sku: "", custo_produto: 10, imposto_percentual: 5, id_model: "V1", produto_nome: "P", variacao_nome: "" }] },
    },
    async () => {
      const resolved = await buildCostRowsFromBase({ clienteSlug: "zenite", marketplace: "meli", clienteContaId: 10 });
      ok("MELI segue com a chave '# de anúncio'", "# de anúncio" in resolved.costRows[0]);
      ok("MELI segue com 'preço de custo'", "preço de custo" in resolved.costRows[0]);
      ok("MELI segue com 'model_id'", "model_id" in resolved.costRows[0]);
    }
  );

  // ── 6. gate do controller: Shopee agora vale igual ao MELI ─────────────
  ok("gate: shopee + clienteSlug → pode resolver custos sem upload",
    podeResolverCustosSemUpload({ marketplace: "shopee", clienteSlug: "zenite" }) === true);
  ok("gate: shopee + costsBaseId → pode",
    podeResolverCustosSemUpload({ marketplace: "shopee", costsBaseId: 12 }) === true);
  ok("gate: shopee sem cliente nem base → não pode (cai no upload obrigatório)",
    podeResolverCustosSemUpload({ marketplace: "shopee" }) === false);
  ok("gate: meli + clienteSlug → pode (inalterado)",
    podeResolverCustosSemUpload({ marketplace: "meli", clienteSlug: "zenite" }) === true);
  ok("gate: tiktok → sempre pode (Base TikTok)",
    podeResolverCustosSemUpload({ marketplace: "tiktok" }) === true);
  ok("gate: marketplace desconhecido → não pode",
    podeResolverCustosSemUpload({ marketplace: "amazon", clienteSlug: "x" }) === false);

  console.log(`\nbaseCustosShopeeBaseVinculada.test.js: ${checks} verificações passaram.`);
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
