// server/tests/freteConfiabilidadeFluxo.postgres.cjs
//
// P0 12/11/2026 — fluxo integrado do frete confiável contra PostgreSQL LOCAL descartável
// (fora do run-all, como os demais *.postgres.cjs):
//   MARGIN_TEST_DATABASE_URL=postgres://vf@127.0.0.1:55439/postgres node tests/freteConfiabilidadeFluxo.postgres.cjs
//
// SQL real; Mercado Livre e contexto de conta são fakes (nenhum GET sai da máquina).
// Fixtures SIMULADOS com os números do caso real MLB4150917539 (conta 86): preço 94,99,
// custo 44, imposto 13%, comissão 13,30; frete item_id 7,75 × recalculado 13,85.
//   A) a MESMA linha de snapshot lida por /anuncios, pela Bancada (/simular) e pelo ranking de
//      Promoções dá o MESMO veredito: antiga (sem verificação) → sem margem nos três;
//      verificada → 11,49 de lucro (12,10%) nos dois que compõem a margem;
//   B) Diagnóstico completo → relatorio_itens → export CSV: frete corrigido, origem exportada,
//      frete desconhecido sem preço sugerido; isolamento de token por conta.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Client, Pool } = require("pg");

const baseUrl = process.env.MARGIN_TEST_DATABASE_URL;
if (!baseUrl) throw new Error("Defina MARGIN_TEST_DATABASE_URL (PostgreSQL local).");
const parsed = new URL(baseUrl);
if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("LOCAL_DATABASE_REQUIRED");

const dbName = `vf_frete_fluxo_${Date.now()}`;
const testUrl = new URL(baseUrl);
testUrl.pathname = `/${dbName}`;
process.env.DATABASE_URL = testUrl.toString();
// Lidas na carga dos módulos: definidas ANTES dos requires.
process.env.FRETE_LEGADO_BLOQUEAR_CONTAS = "86,87";
process.env.FRETE_COTACAO_CONFIAVEL_SELLERS = "1587129755,2433262404";

const S86 = "1587129755";
const S87 = "2433262404";
const TAGS_PROX = ["self_service_in", "mandatory_free_shipping", "proximity"];
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks += 1; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); checks += 1; };
const r2 = (n) => (n === null || n === undefined ? n : Math.round(Number(n) * 100) / 100);

// ── Mercado Livre falso (registrando cada chamada) ───────────────────────────
const ml = { chamadas: [], itens: {} };
function atributos(dims) {
  if (!dims) return [];
  const [d, peso] = dims.split(",");
  const [h, w, l] = d.split("x").map(Number);
  const at = (id, n, unit) => ({ id, values: [{ struct: { number: n, unit } }] });
  return [at("SELLER_PACKAGE_HEIGHT", h, "cm"), at("SELLER_PACKAGE_WIDTH", w, "cm"), at("SELLER_PACKAGE_LENGTH", l, "cm"), at("SELLER_PACKAGE_WEIGHT", Number(peso), "g")];
}
const corpo = (id) => {
  const it = ml.itens[id];
  return { id, title: `Anúncio ${id}`, status: "active", price: it.preco, listing_type_id: "gold_special", category_id: "MLB1", seller_id: Number(it.seller),
    seller_custom_field: `SKU-${id}`, shipping: { logistic_type: it.logistica || "cross_docking", tags: it.tags } };
};
async function mlFetch(clienteId, caminho, opts = {}) {
  const p = String(caminho);
  ml.chamadas.push({ p, mlUserId: opts.mlUserId || null, method: opts.method || "GET" });
  if (p === "/users/me") return { ok: true, status: 200, data: { id: Number(opts.mlUserId) } };
  if (p.includes("/items/search")) {
    const doSeller = Object.keys(ml.itens).filter((id) => p.startsWith(`/users/${ml.itens[id].seller}/`));
    return p.includes("scroll_id=") ? { ok: true, status: 200, data: { results: [] } } : { ok: true, status: 200, data: { results: doSeller, scroll_id: "s1" } };
  }
  if (p.startsWith("/items?ids=")) return { ok: true, status: 200, data: p.split("=")[1].split(",").map((id) => ({ code: 200, body: corpo(id) })) };
  const unico = p.match(/^\/items\/([^?]+)\?/);
  if (unico) return { ok: true, status: 200, data: { id: unico[1], shipping: { tags: ml.itens[unico[1]].tags }, attributes: atributos(ml.itens[unico[1]].dims) } };
  if (p.startsWith("/sites/MLB/listing_prices")) {
    const preco = Number(new URLSearchParams(p.split("?")[1]).get("price"));
    return { ok: true, status: 200, data: { sale_fee_amount: Math.round(preco * 14) / 100, sale_fee_details: { percentage_fee: 14 } } };
  }
  if (p.includes("/shipping_options/free")) {
    const q = new URLSearchParams(p.split("?")[1]);
    if (String(opts.mlUserId) !== p.match(/^\/users\/(\d+)\//)[1]) return { ok: false, status: 403, data: null };
    const mand = (v) => ({ list_cost: v, discount: { rate: 0.5, type: "mandatory", promoted_amount: v } });
    if (q.get("dimensions")) return { ok: true, status: 200, data: { coverage: { all_country: mand(13.85) } } };
    return { ok: true, status: 200, data: { coverage: { all_country: ml.itens[q.get("item_id")].cotacaoItem } } };
  }
  if (p.startsWith("/orders/search")) return { ok: true, status: 200, data: { results: [] } };
  return { ok: false, status: 404, data: null };
}
const NONE = { list_cost: 7.75, discount: { rate: 0, type: "none", promoted_amount: 7.75 } };
const contexto = { atual: null };
function stub(rel, exportsObj) {
  const abs = require.resolve(rel);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
}
stub("../utils/mlClient", { mlFetch });
stub("../services/automacoes/precoItemService", {
  resolverPrecosItem: async ({ itemId }) => ({ precoCheio: ml.itens[itemId].preco, precoPromocional: null, precoEfetivo: ml.itens[itemId].preco, fonte: "sale_price", promotionIdAtivo: null }),
});
stub("../services/automacoes/contextoPrecificacaoService", {
  exigirContextoPronto: async () => contexto.atual,
  criarErroHttp: (status, payload) => Object.assign(new Error(payload && payload.erro), { statusCode: status, payload }),
});

// config/database força SSL (produção); o PostgreSQL local não tem: pool próprio no lugar do módulo.
const pool = new Pool({ connectionString: testUrl.toString(), ssl: false, max: 4 });
stub("../config/database", pool);
const fonteAnuncios = require("../services/motorMargem/anunciosMargemProjetadaFonte");
const snapshotRepo = require("../services/motorMargem/marginSnapshotRepository");
const simular = require("../services/motorMargem/margemSimularService");
const { sqlOportunidadesElegiveis } = require("../services/motorMargem/precificacao/precificacaoOportunidadesSql");
const { executarDiagnosticoCompleto } = require("../services/automacoes/diagnosticoService");
const relatorios = require("../services/automacoes/relatoriosService");
const { buscarComissaoEFrete } = require("../services/shared/marketplaceCurrentQuoteService");

async function inserirSnapshot(contaId, item, { frete, quality }) {
  const preco = 94.99, custo = 44, imposto = 0.13, comissao = 13.3;
  const lucro = r2(preco - preco * imposto - comissao - frete - custo);
  await pool.query(
    `INSERT INTO margin_projection_snapshots
       (cliente_id, cliente_conta_id, marketplace, item_id, titulo, price, cost, tax_rate, fixed_fee, commission, commission_rate, freight,
        profit, margin, margin_percent, status, refresh_status, calculated_at, observed_at, quality_json, assumed_json, missing_json)
     VALUES (133, $1, 'meli', $2, $2, $3, $4, $5, 0, $6, 0.14, $7, $8, $9, $10, 'HEALTHY', 'fresh', now(), now(), $11::jsonb, '[]'::jsonb, '[]'::jsonb)`,
    [contaId, item, preco, custo, imposto, comissao, frete, lucro, lucro / preco, (lucro / preco) * 100, JSON.stringify(quality)]
  );
}

function depsSimular(contaId, seller) {
  return {
    db: pool, now: () => new Date(), logger: { error() {}, warn() {}, info() {} },
    assertContaNaCarteira: async () => ({ contaId, clienteId: 133, clienteSlug: "alianza", clienteNome: "Alianza", clienteAtivo: true }),
    obterConta: async () => ({ id: contaId, cliente_id: 133, marketplace: "meli", nome: `Conta ${contaId}`, ativo: true, external_account_id: seller }),
    snapshotRepo, // SQL real
    obterAnuncio: async (clienteId, itemId) => ({ item_id: itemId, ml_user_id: seller, listing_type_id: "gold_special", category_id: "MLB1", logistic_type: "cross_docking", shipping_tags: TAGS_PROX }),
    promoService: { estadoSincronizacao: async () => ({ hasSnapshot: false }) }, promoRepo: {}, carregarRebates: async () => ({ porItem: new Map(), indisponivel: null }),
    buscarComissaoEFrete, mlFetch, // cotador REAL sobre o ML falso
  };
}

async function main() {
  const admin = new Client({ connectionString: baseUrl, ssl: false });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  try {
    await pool.query(`CREATE TABLE clientes (id BIGSERIAL PRIMARY KEY, slug TEXT);
      CREATE TABLE cliente_contas (id BIGSERIAL PRIMARY KEY, cliente_id BIGINT);
      CREATE TABLE bases (id BIGSERIAL PRIMARY KEY, nome TEXT);
      CREATE TABLE users (id BIGSERIAL PRIMARY KEY);
      CREATE TABLE meli_anuncios (cliente_id BIGINT, cliente_conta_id BIGINT, item_id TEXT, logistic_type TEXT);
      CREATE TABLE custos (id SERIAL PRIMARY KEY, base_id INTEGER NOT NULL, produto_id TEXT NOT NULL, custo_produto NUMERIC NOT NULL DEFAULT 0,
        imposto_percentual NUMERIC NOT NULL DEFAULT 0, taxa_fixa NUMERIC NOT NULL DEFAULT 0);
      CREATE TABLE relatorios (id SERIAL PRIMARY KEY, user_id INTEGER, cliente_id INTEGER, cliente_slug TEXT NOT NULL, base_id INTEGER, base_slug TEXT NOT NULL,
        margem_alvo NUMERIC(6,4), escopo TEXT NOT NULL DEFAULT 'pagina_atual', status TEXT NOT NULL DEFAULT 'concluido', total_itens INTEGER NOT NULL DEFAULT 0,
        itens_com_base INTEGER NOT NULL DEFAULT 0, itens_sem_base INTEGER NOT NULL DEFAULT 0, itens_criticos INTEGER NOT NULL DEFAULT 0,
        itens_atencao INTEGER NOT NULL DEFAULT 0, itens_saudaveis INTEGER NOT NULL DEFAULT 0, mc_media NUMERIC(10,6), observacoes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, pasta_id INTEGER);
      CREATE TABLE relatorio_itens (id SERIAL PRIMARY KEY, relatorio_id INTEGER NOT NULL REFERENCES relatorios(id) ON DELETE CASCADE, item_id TEXT NOT NULL, sku TEXT,
        titulo TEXT, status_anuncio TEXT, listing_type_id TEXT, preco_original NUMERIC(14,4), preco_promocional NUMERIC(14,4), preco_efetivo NUMERIC(14,4),
        custo NUMERIC(14,4), imposto_percentual NUMERIC(8,4), taxa_fixa NUMERIC(14,4), frete NUMERIC(14,4), comissao NUMERIC(14,4), comissao_percentual NUMERIC(8,4),
        lc NUMERIC(14,4), mc NUMERIC(10,6), preco_alvo NUMERIC(14,4), preco_sugerido NUMERIC(14,4), diferenca_preco NUMERIC(14,4), acao_recomendada TEXT,
        explicacao_calculo TEXT, diagnostico TEXT, tem_base BOOLEAN NOT NULL DEFAULT false);
      INSERT INTO clientes (id, slug) VALUES (133, 'alianza');
      INSERT INTO cliente_contas (id, cliente_id) VALUES (86, 133), (87, 133), (55, 133);
      INSERT INTO bases (id, nome) VALUES (1, 'Base Alianza 1');`);
    await pool.query(fs.readFileSync(path.join(__dirname, "../sql/margin_snapshot_schema.sql"), "utf8"));

    // ── A) Uma linha, três leitores ────────────────────────────────────────
    const ESTIMADO = { targetMargin: 0.1, freteAplicavel: true, freteQualidade: { nivel: "estimado_dimensoes_historicas", confirmado: false, confianca: "media", cotacaoRejeitada: 7.75 } };
    await inserirSnapshot(86, "MLB9000000001", { frete: 7.75, quality: { targetMargin: 0.1, freteAplicavel: true } });
    await inserirSnapshot(86, "MLB4150917539", { frete: 13.85, quality: ESTIMADO });
    await inserirSnapshot(55, "MLB9000000055", { frete: 7.75, quality: { targetMargin: 0.1, freteAplicavel: true } });
    await pool.query(`INSERT INTO meli_anuncios (cliente_id, cliente_conta_id, item_id, logistic_type) VALUES
      (133, 86, 'MLB9000000001', 'cross_docking'), (133, 86, 'MLB4150917539', 'cross_docking'), (133, 55, 'MLB9000000055', 'cross_docking')`);

    // 1) /anuncios (coluna de margem)
    const lista = await fonteAnuncios.lerMarginSnapshotPorItens({ clienteId: 133, clienteContaId: 86, itemIds: ["MLB9000000001", "MLB4150917539"] }, pool);
    eq([lista.get("MLB9000000001").marginPercent, lista.get("MLB9000000001").margemIncompleta], [null, true], "/anuncios: linha antiga sem margem");
    eq([r2(lista.get("MLB4150917539").profit), r2(lista.get("MLB4150917539").marginPercent), lista.get("MLB4150917539").freteNivel], [11.49, 12.1, "estimado_dimensoes_historicas"],
      "/anuncios: linha verificada = 11,49 (12,10%), rotulada como estimada");

    // 2) Ranking de Promoções (SQL real)
    const q = sqlOportunidadesElegiveis({
      fonteSql: "SELECT x.item_id, x.item_id AS chave, 82.29::numeric AS preco_promo, 0::numeric AS retorno, 'candidate'::text AS promo_status FROM (VALUES ('MLB9000000001'), ('MLB4150917539')) AS x(item_id)",
      clienteContaId: 86, clienteId: 133,
    });
    const linhas = (await pool.query(q.sql, q.params)).rows;
    const porItem = Object.fromEntries(linhas.map((l) => [l.item_id, l]));
    eq(porItem.MLB9000000001.freight, null, "ranking: frete antigo da conta bloqueada sai ausente");
    eq(Number(porItem.MLB4150917539.freight), 13.85, "ranking: frete verificado segue");
    const q55 = sqlOportunidadesElegiveis({
      fonteSql: "SELECT 'MLB9000000055'::text AS item_id, 'k'::text AS chave, 82.29::numeric AS preco_promo, 0::numeric AS retorno, 'candidate'::text AS promo_status",
      clienteContaId: 55, clienteId: 133,
    });
    eq(Number((await pool.query(q55.sql, q55.params)).rows[0].freight), 7.75, "conta fora do bloqueio: intocada");

    // 3) Bancada (/simular) — snapshot lido do banco, cotação em P' pelo cotador real
    ml.itens = { MLB9000000001: { preco: 94.99, seller: S86, tags: TAGS_PROX, cotacaoItem: NONE, dims: "22x20x2,310" }, MLB4150917539: { preco: 94.99, seller: S86, tags: TAGS_PROX, cotacaoItem: NONE, dims: "22x20x2,310" } };
    const sim = (mlb) => simular.simular({ user: { id: 1, role: "user" }, body: { cliente_conta_id: 86, mlb, cenarios: [{ tipo: "preco", preco: 82.29 }] } }, depsSimular(86, S86));
    const antiga = (await sim("MLB9000000001")).cenarios[0];
    eq([antiga.veredito, antiga.motivos.includes("frete_atual_ausente")], ["bloqueado", true], "Bancada: linha antiga bloqueia (mesmo veredito de /anuncios e do ranking)");
    const resBoa = await sim("MLB4150917539");
    const boa = resBoa.cenarios[0];
    eq([r2(resBoa.atual.lc), r2(resBoa.atual.margem_ratio * 100)], [11.49, 12.1], "Bancada hoje = /anuncios: 11,49 (12,10%)");
    eq([boa.cenario.preco, boa.cenario.comissao, boa.cenario.frete, r2(boa.cenario.lc), r2(boa.cenario.margem_ratio * 100)], [82.29, 11.52, 13.85, 2.22, 2.7],
      "Bancada simulando 82,29: comissão e frete COTADOS em 82,29 → 2,22 (2,70%)");
    ok(ml.chamadas.every((c) => c.method === "GET" && c.mlUserId === S86), "somente GET, sempre com o token da conta 86");

    // ── B) Diagnóstico completo → relatorio_itens → CSV ────────────────────
    ml.chamadas = [];
    ml.itens = {
      MLB4445939340: { preco: 84.9, seller: S86, tags: TAGS_PROX, cotacaoItem: NONE, dims: "28x23x4,324" },
      MLB9000000002: { preco: 84.9, seller: S86, tags: TAGS_PROX, cotacaoItem: NONE, dims: null },
      MLB9000000003: { preco: 99.9, seller: S86, tags: ["self_service_in", "mandatory_free_shipping"], cotacaoItem: { list_cost: 14.45, discount: { rate: 0.5, type: "mandatory", promoted_amount: 14.45 } } },
      MLB9000000087: { preco: 169.66, seller: S87, tags: TAGS_PROX, cotacaoItem: NONE, dims: "40x30x8,1200" },
    };
    await pool.query(`INSERT INTO custos (base_id, produto_id, custo_produto, imposto_percentual, taxa_fixa) VALUES
      (1, 'MLB4445939340', 40, 13, 0), (1, 'MLB9000000002', 40, 13, 0), (1, 'MLB9000000003', 40, 13, 0)`);
    contexto.atual = { cliente: { id: 133, slug: "alianza" }, base: { id: 1, slug: "base-1" }, mlUserId: S86, conta: { id: 86 } };
    const rel = await pool.query(`INSERT INTO relatorios (cliente_id, cliente_slug, base_id, base_slug, margem_alvo, escopo, status)
      VALUES (133, 'alianza', 1, 'base-1', 0.15, 'loja_completa', 'processando') RETURNING id`);
    const relId = rel.rows[0].id;
    await executarDiagnosticoCompleto(relId, { mlUserId: S86, clienteContaId: 86 });

    const gravado = (await pool.query("SELECT status, total_itens FROM relatorios WHERE id = $1", [relId])).rows[0];
    eq([gravado.status, gravado.total_itens], ["concluido", 3], "só os anúncios do seller 86 (o da 87 nem é listado)");
    const itens = Object.fromEntries((await pool.query("SELECT * FROM relatorio_itens WHERE relatorio_id = $1", [relId])).rows.map((i) => [i.item_id, i]));
    eq([Number(itens.MLB4445939340.frete), r2(itens.MLB4445939340.lc), itens.MLB4445939340.diagnostico], [13.85, 8.12, "atencao"], "caso real: 84,90 → lucro 8,12 (9,57% < meta 15%)");
    ok(/ESTIMADO/.test(itens.MLB4445939340.explicacao_calculo) && /7,75/.test(itens.MLB4445939340.explicacao_calculo), itens.MLB4445939340.explicacao_calculo);
    eq([itens.MLB9000000002.frete, itens.MLB9000000002.lc, itens.MLB9000000002.preco_sugerido, itens.MLB9000000002.diagnostico], [null, null, null, "sem_frete"],
      "frete desconhecido: NULL no banco (nunca 0), sem preço sugerido");
    eq([Number(itens.MLB9000000003.frete), /cotado pelo Mercado Livre/.test(itens.MLB9000000003.explicacao_calculo)], [14.45, true], "controle sem proximity: cotação do ML mantida");
    ok(ml.chamadas.length > 0 && ml.chamadas.every((c) => c.method === "GET" && c.mlUserId === S86), "diagnóstico: só GET, só token da conta 86");
    ok(!ml.chamadas.some((c) => c.p.includes("MLB9000000087") || c.p.includes(`/users/${S87}/`)), "nenhuma leitura de item/seller da conta 87");

    const csv = (await relatorios.gerarExportRelatorioCsv({ idRaw: String(relId) }));
    const texto = String(csv.conteudo || csv.csv || csv.buffer || csv.body || Object.values(csv).find((v) => typeof v === "string" && v.includes("MLB")) || "");
    const linhaCsv = texto.split("\n").find((l) => l.includes("MLB4445939340")) || "";
    ok(/13\.85/.test(linhaCsv) && /ESTIMADO/.test(linhaCsv), `CSV exporta o frete corrigido e a origem: ${linhaCsv.slice(0, 260)}`);
    const linhaDesc = texto.split("\n").find((l) => l.includes("MLB9000000002")) || "";
    ok(/sem_frete/.test(linhaDesc) && /medidas da embalagem/.test(linhaDesc) && !/7\.75/.test(linhaDesc), `CSV não exporta 7,75 como frete: ${linhaDesc.slice(0, 260)}`);

    console.log(`freteConfiabilidadeFluxo.postgres: ${checks} checks`);
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
