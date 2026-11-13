// server/tests/meliAnunciosPerformance.test.js
//
// GET /anuncios-meli/performance — enriquecimento AO VIVO e ASSÍNCRONO da
// listagem (métricas últ. 7 dias + margem por MLB). Ver
// server/controllers/meliAnunciosController.js (performance) e o plano em
// docs (commit desta entrega).
//
// O que este teste protege:
//
//  1. a lista de itemIds é cortada em PERFORMANCE_MAX_ITENS — proteção da
//     rota, não regra de domínio — e NUNCA um itemId além do teto chega aos
//     dois serviços de baixo;
//  2. métricas e margem são blocos INDEPENDENTES: falha de um nunca derruba
//     o outro (Promise.allSettled);
//  3. contexto do Motor de Margem não-pronto (Base não vinculada etc.) vira
//     `margemIndisponivel` com a MESMA mensagem do erro tipado — nunca 500,
//     nunca texto inventado;
//  4. margem por item é SEMPRE `projected` — nunca `realized`, mesmo quando
//     `item.margin.realized` está presente e computável (decisão de produto
//     da missão "fechar integração funcional da tela": Anúncios ML mostra
//     só Margem Projetada; `item.margin.realized` continua existindo no
//     Motor, só não é mais LIDO por este endpoint);
//  5. clienteContaId chega aos dois serviços de baixo — margem da conta
//     ERRADA para cliente multi-conta seria pior que não mostrar margem;
//  6. clienteSlug ausente é 400; lote de itemIds vazio não gasta chamada
//     nenhuma; ambiguidade de conta (2+ contas, sem seleção) é 409.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const Module = require("module");

let metricasHandler = null; // ({clienteId, mlUserId, itemIds}) => valor ou throw
let margemHandler = null;   // ({clienteSlug, clienteContaId, itemIds}) => valor ou throw
let vendasSoHandler = null; // ({clienteId, mlUserId, itemIds}) => {ok, porItem} ou throw — só vendas, sem visitas
let familiaHandler = null;  // ({clienteId, clienteContaId, familyIds}) => Map(familyId -> [itemId]) ou throw
let chamadasMetricas = [];
let chamadasMargem = [];
let chamadasVendasSo = [];
let chamadasFamilia = [];
let rebateHandler = null;   // ({clienteId, itemId, mlUserId}) => {ok, rebate, promocao} ou throw
let chamadasRebate = [];

const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === "../services/meliAnuncios/meliMetricas7dService") {
    return {
      JANELA_DIAS: 7,
      async montarMetricas7d(args) {
        chamadasMetricas.push(args);
        if (!metricasHandler) return {};
        return metricasHandler(args);
      },
      async buscarVendas7dPorItens(args) {
        chamadasVendasSo.push(args);
        if (!vendasSoHandler) return { ok: true, porItem: {} };
        return vendasSoHandler(args);
      },
    };
  }
  if (request === "../services/meliAnuncios/meliFamiliaService") {
    return {
      async resolverItensDeFamilias(args) {
        chamadasFamilia.push(args);
        if (!familiaHandler) return new Map();
        return familiaHandler(args);
      },
    };
  }
  if (request === "../services/meliAnuncios/meliPromocoesService") {
    return {
      async obterRebatePromocaoAtiva(args) {
        chamadasRebate.push(args);
        if (!rebateHandler) return { ok: true, rebate: null, promocao: null };
        return rebateHandler(args);
      },
    };
  }
  if (request === "../services/motorMargem/motorMargemService") {
    return {
      async mapWithConcurrency(items, _limit, fn) {
        return Promise.all(items.map((it, i) => fn(it, i)));
      },
      async montarItens(args) {
        chamadasMargem.push(args);
        if (!margemHandler) return { itens: [] };
        return margemHandler(args);
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const pool = require("../config/database");
const ctrl = require("../controllers/meliAnunciosController");

Module._load = originalLoad;

// ── fixtures de conta (mesmo padrão de meliAnunciosEstoque.test.js) ────────

const cliente = { id: 1, nome: "Cliente A", slug: "cliente-a", ativo: true };

function grantFixture({ id, cliente_id, ml_user_id }) {
  return {
    id, cliente_id, ml_user_id,
    access_token: "tok", refresh_token: "ref",
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    token_status: "valid", is_primary: false,
    refresh_failures: 0, updated_at: new Date().toISOString(),
  };
}

const UMA_CONTA = {
  contas: [{ id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", external_account_id: "111", is_primary: true, ativo: true }],
  grants: [grantFixture({ id: 100, cliente_id: 1, ml_user_id: "111" })],
};

const DUAS_CONTAS = {
  contas: [
    { id: 10, cliente_id: 1, marketplace: "meli", nome: "ML 1", external_account_id: "111", is_primary: true, ativo: true },
    { id: 11, cliente_id: 1, marketplace: "meli", nome: "ML 2", external_account_id: "222", is_primary: false, ativo: true },
  ],
  grants: [
    grantFixture({ id: 100, cliente_id: 1, ml_user_id: "111" }),
    grantFixture({ id: 101, cliente_id: 1, ml_user_id: "222" }),
  ],
};

class MockDb {
  constructor({ contas = [], grants = [] } = {}) {
    this.contas = contas;
    this.grants = grants;
  }

  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }

  async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, " ").trim();

    if (q.includes("FROM clientes WHERE id = $1")) {
      return { rows: cliente.id === Number(params[0]) ? [cliente] : [] };
    }
    if (q.includes("FROM clientes WHERE LOWER(slug) = $1")) {
      return { rows: cliente.slug === params[0] ? [cliente] : [] };
    }
    if (q.startsWith("SELECT * FROM cliente_contas WHERE id = $1")) {
      const conta = this.contas.find((c) => c.id === Number(params[0]));
      return { rows: conta ? [conta] : [] };
    }
    if (q.includes("FROM cliente_contas WHERE cliente_id = $1 AND marketplace = $2 AND ativo = true ORDER BY is_primary")) {
      return { rows: this.contas.filter((c) => c.cliente_id === params[0] && c.marketplace === params[1] && c.ativo !== false) };
    }
    if (q.includes("COUNT(*)::int AS total FROM cliente_contas")) {
      const total = this.contas.filter((c) => c.cliente_id === params[0] && c.ativo !== false && c.marketplace === "meli").length;
      return { rows: [{ total }] };
    }
    if (q.includes("t.cliente_id = $1 AND t.ml_user_id = $2")) {
      const row = this.grants.find((g) => g.cliente_id === params[0] && String(g.ml_user_id) === String(params[1]));
      return { rows: row ? [row] : [] };
    }
    if (q.includes("FROM ml_tokens t") && q.includes("WHERE t.cliente_id = $1")) {
      return { rows: this.grants.filter((g) => g.cliente_id === params[0]) };
    }
    if (q.includes("base_cliente_vinculos")) return { rows: [] };
    if (q.startsWith("CREATE TABLE") || q.startsWith("ALTER TABLE") || q.startsWith("CREATE INDEX")) {
      return { rows: [] };
    }
    return { rows: [] };
  }
}

function withMockDb(opts, fn) {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const db = new MockDb(opts);
  pool.query = (sql, params) => db.query(sql, params);
  pool.connect = () => db.connect();
  return Promise.resolve()
    .then(() => fn(db))
    .finally(() => {
      pool.query = originalQuery;
      pool.connect = originalConnect;
    });
}

function fakeRes() {
  return {
    statusCode: 200,
    corpo: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.corpo = obj; return this; },
  };
}

function reset() {
  chamadasMetricas = [];
  chamadasMargem = [];
  chamadasVendasSo = [];
  chamadasFamilia = [];
  metricasHandler = null;
  margemHandler = null;
  vendasSoHandler = null;
  familiaHandler = null;
  rebateHandler = null;
  chamadasRebate = [];
  ctrl._limparRebateCache();
}

// `composicao`, quando informado, monta o shape REAL de pricing/costs/
// marketplaceCosts que core/marginItem.js produz (ver montarComposicaoDoItem
// no controller) — só os campos que o item precisa pra decompor a margem.
function evid(valor) {
  return valor == null ? null : { value: valor };
}

function itemDeMargem({
  itemId, realizedComputable, realizedMargin, realizedProfit, projectedMargin, projectedProfit, projectedComputable = true,
  status, statusLabel, statusReasons, composicao, precoAtual, precoAlvo, precoOriginal,
}) {
  const item = {
    identity: { itemId },
    margin: {
      realized: {
        computable: !!realizedComputable, margin: realizedMargin ?? null,
        marginPercent: realizedMargin != null ? realizedMargin * 100 : null, profit: realizedProfit ?? null,
      },
      projected: {
        computable: projectedComputable, margin: projectedMargin ?? null,
        marginPercent: projectedMargin != null ? projectedMargin * 100 : null, profit: projectedProfit ?? null,
      },
      // Preço alvo — mesmo shape de core/marginItem.js (margin.target). Só
      // `computable` quando o teste passa `precoAlvo` explicitamente; do
      // contrário fica exatamente como o Motor devolve quando não consegue
      // calcular (nunca um preço inventado).
      target: precoAlvo != null ? { computable: true, price: precoAlvo } : { computable: false, price: null },
    },
    quality: { status, statusLabel, statusReasons: statusReasons || [] },
  };
  if (precoAtual !== undefined || precoOriginal !== undefined) {
    item.pricing = {};
    if (precoAtual !== undefined) item.pricing.current = evid(precoAtual);
    if (precoOriginal !== undefined) item.pricing.list = evid(precoOriginal);
  }
  if (composicao) {
    item.pricing = { current: evid(composicao.vendaProjetada), sold: evid(composicao.vendaRealizada) };
    item.costs = {
      cost: { projected: evid(composicao.custoProjetado), realized: evid(composicao.custoRealizado) },
      taxRate: { projected: evid(composicao.impostoProjetado), realized: evid(composicao.impostoRealizado) },
      fixedFee: { projected: evid(composicao.taxaFixaProjetada), realized: evid(composicao.taxaFixaRealizada) },
    };
    item.marketplaceCosts = {
      commissionProjected: evid(composicao.comissaoProjetada),
      commissionRealized: evid(composicao.comissaoRealizada),
      freightProjected: evid(composicao.freteProjetado),
      freightRealized: evid(composicao.freteRealizado),
    };
  }
  return item;
}

let checks = 0;
function ok(msg) { checks += 1; console.log(`  ✓ ${msg}`); }

async function run() {
  // 1. Caminho feliz: métricas e margem combinadas, margem é SEMPRE
  //    projected — mesmo quando o item tem realized computável (decisão de
  //    produto: Anúncios ML mostra só Margem Projetada, nunca Realizada).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({
      "MLB-A": { views: 100, vendas: 3, conversao: 3 },
      "MLB-B": { views: 50, vendas: 0, conversao: 0 },
    });
    margemHandler = () => ({
      itens: [
        // MLB-A tem realized computável (25%) E projected (40%) — o
        // endpoint precisa mostrar projected (40%), nunca realized (25%).
        itemDeMargem({ itemId: "MLB-A", realizedComputable: true, realizedMargin: 0.25, projectedMargin: 0.4, status: "HEALTHY", statusLabel: "Saudável" }),
        itemDeMargem({ itemId: "MLB-B", realizedComputable: false, projectedMargin: 0.05, status: "LOW_MARGIN", statusLabel: "Margem baixa", statusReasons: ["Margem de 5.00% abaixo da meta de 10.00%."] }),
      ],
    });

    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-A,MLB-B" } }, res);

    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.metricas7d["MLB-A"].views, 100);
    assert.strictEqual(res.corpo.margem["MLB-A"].origem, "projected", "MLB-A: origem é SEMPRE projected, mesmo com realized computável (25%) disponível");
    assert.strictEqual(res.corpo.margem["MLB-A"].marginPercent, 40, "MLB-A: mostra projected (40%), nunca realized (25%) — realized computável não muda nada");
    assert.strictEqual(res.corpo.margem["MLB-B"].origem, "projected", "MLB-B sem realized computável — projected de qualquer forma");
    assert.strictEqual(res.corpo.margem["MLB-B"].marginPercent, 5);
    assert.strictEqual(res.corpo.margem["MLB-B"].statusLabel, "Margem baixa");
    assert.strictEqual(res.corpo.margemIndisponivel, null);
    ok("caminho feliz: métricas + margem combinadas, margem é SEMPRE projected — realized computável não tem nenhuma precedência");
  });

  // 1a. Item com realized COMPUTÁVEL mas projected NÃO computável: mostra
  //     indisponível ("—" no front, via statusLabel) — NUNCA cai para
  //     realized como fallback. Este é o teste que prova a garantia central
  //     da missão: "sem margem projetada NUNCA usa margem realizada".
  await withMockDb(UMA_CONTA, async () => {
    reset();
    margemHandler = () => ({
      itens: [
        itemDeMargem({
          itemId: "MLB-SOREAL", realizedComputable: true, realizedMargin: 0.5, realizedProfit: 100,
          projectedComputable: false, projectedMargin: null,
          status: "UNVALIDATED", statusLabel: "Não validado", statusReasons: ["Variáveis obrigatórias ausentes: custo."],
        }),
      ],
    });

    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-SOREAL", incluirMetricas: "0" } }, res);

    assert.strictEqual(res.corpo.margem["MLB-SOREAL"].origem, "projected", "origem continua projected mesmo não-computável — nunca vira realized");
    assert.strictEqual(res.corpo.margem["MLB-SOREAL"].marginPercent, null, "marginPercent NUNCA usa os 50% de realized — fica null (indisponível)");
    assert.strictEqual(res.corpo.margem["MLB-SOREAL"].profit, null, "profit NUNCA usa os 100 de realized");
    assert.strictEqual(res.corpo.margem["MLB-SOREAL"].statusLabel, "Não validado", "front mostra o motivo REAL (não computável), nunca inventa um percentual a partir de realized");
    ok("item com realized computável (50%) mas projected NÃO computável: margem indisponível — NUNCA cai para realized como fallback");
  });

  // 1b. precoAtual (obtido ao vivo) e precoAlvo (calculado p/ margem-alvo) do
  //     Motor chegam em margem[itemId] — a Tela de Anúncios lê exatamente
  //     esses dois campos para alimentar o preço da linha (ver
  //     Portal/anuncios-meli.js precoCelulaHtml/margemConteudoHtml). Item sem
  //     nenhum dos dois (Motor não resolveu) fica `null`, nunca 0.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    margemHandler = () => ({
      itens: [
        itemDeMargem({
          itemId: "MLB-A", realizedComputable: false, projectedMargin: 0.18, status: "HEALTHY", statusLabel: "Saudável",
          precoAtual: 129.9, precoAlvo: 139.5,
        }),
        itemDeMargem({
          itemId: "MLB-B", realizedComputable: false, projectedComputable: false, status: "UNVALIDATED", statusLabel: "Sem custo",
        }),
      ],
    });

    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-A,MLB-B", incluirMetricas: "0" } }, res);

    assert.strictEqual(res.corpo.margem["MLB-A"].precoAtual, 129.9, "precoAtual vem de item.pricing.current (obtido pelo Motor)");
    assert.strictEqual(res.corpo.margem["MLB-A"].precoAlvo, 139.5, "precoAlvo vem de item.margin.target (calculado pelo Motor)");
    assert.strictEqual(res.corpo.margem["MLB-B"].precoAtual, null, "sem pricing no item, precoAtual é null — nunca 0");
    assert.strictEqual(res.corpo.margem["MLB-B"].precoAlvo, null, "target não-computável vira null — nunca um preço inventado");
    ok("precoAtual/precoAlvo do Motor chegam em margem[itemId], com null (nunca 0) quando o Motor não resolveu");
  });

  // 1c. precoOriginal (preço cheio/regular AO VIVO, item.pricing.list —
  //     sale_price.regular_amount via resolverPrecosItem) chega em
  //     margem[itemId] — a MESMA fonte que a composição já usa. Sem
  //     evidência (sem promoção ativa, ou Motor não resolveu), fica `null`,
  //     nunca 0 e nunca um valor "inventado" a partir de outro campo.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    margemHandler = () => ({
      itens: [
        itemDeMargem({
          itemId: "MLB-A", realizedComputable: false, projectedMargin: 0.18, status: "HEALTHY", statusLabel: "Saudável",
          precoAtual: 89.9, precoOriginal: 129.9,
        }),
        itemDeMargem({
          itemId: "MLB-B", realizedComputable: false, projectedMargin: 0.18, status: "HEALTHY", statusLabel: "Saudável",
          precoAtual: 89.9,
        }),
      ],
    });

    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-A,MLB-B", incluirMetricas: "0" } }, res);

    assert.strictEqual(res.corpo.margem["MLB-A"].precoOriginal, 129.9, "precoOriginal vem de item.pricing.list (sale_price.regular_amount)");
    assert.strictEqual(res.corpo.margem["MLB-B"].precoOriginal, null, "sem promoção/evidência de list price, precoOriginal é null — nunca inventado a partir do preço atual");
    ok("precoOriginal (preço cheio ao vivo, sale_price.regular_amount) chega em margem[itemId], null quando o Motor não tem a evidência");
  });

  // 2. Contexto do Motor não-pronto (Base não vinculada) vira
  //    margemIndisponivel com a mensagem REAL do erro — nunca 500, e
  //    métricas continuam chegando normalmente (independência dos blocos).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({ "MLB-A": { views: 10, vendas: 1, conversao: 10 } });
    margemHandler = () => {
      const err = new Error("Base de custos MELI não vinculada.");
      err.statusCode = 424;
      err.payload = { ok: false, codigo: "BASE_MELI_NAO_VINCULADA", erro: "Base de custos MELI não vinculada." };
      throw err;
    };

    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-A" } }, res);

    assert.strictEqual(res.statusCode, 200, "contexto de margem não-pronto não pode virar 500");
    assert.strictEqual(res.corpo.ok, true);
    assert.deepStrictEqual(res.corpo.margem, {});
    assert.deepStrictEqual(res.corpo.margemIndisponivel, {
      codigo: "BASE_MELI_NAO_VINCULADA",
      mensagem: "Base de custos MELI não vinculada.",
    });
    assert.strictEqual(res.corpo.metricas7d["MLB-A"].views, 10, "métricas não podem ser afetadas pela margem indisponível");
    ok("Base não vinculada: margemIndisponivel com a mensagem real do Motor, listagem de métricas intacta, 200 (nunca 500)");
  });

  // 3. Falha das MÉTRICAS não derruba a margem (independência no outro
  //    sentido).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => { throw new Error("Falha ao buscar visitas"); };
    margemHandler = () => ({
      itens: [itemDeMargem({ itemId: "MLB-A", projectedMargin: 0.3, status: "HEALTHY", statusLabel: "Saudável" })],
    });

    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-A" } }, res);

    assert.strictEqual(res.corpo.ok, true);
    assert.deepStrictEqual(res.corpo.metricas7d, {}, "métricas falhas viram objeto vazio, não derrubam a resposta");
    assert.strictEqual(res.corpo.margem["MLB-A"].marginPercent, 30, "margem segue intacta mesmo com métricas falhando");
    ok("falha das métricas não derruba a margem — resposta continua 200 com margem íntegra");
  });

  // 4. Teto PERFORMANCE_MAX_ITENS: itemIds além do teto nunca chegam aos
  //    serviços de baixo.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({});
    margemHandler = () => ({ itens: [] });

    const muitos = Array.from({ length: 40 }, (_, i) => `MLB-${i}`);
    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: muitos.join(",") } }, res);

    assert.strictEqual(res.corpo.ok, true);
    assert.ok(chamadasMetricas[0].itemIds.length <= 24, "métricas não podem receber mais itens que o teto");
    assert.ok(chamadasMargem[0].itemIds.length <= 24, "margem não pode receber mais itens que o teto");
    assert.strictEqual(chamadasMetricas[0].itemIds.length, chamadasMargem[0].itemIds.length, "os dois serviços recebem o MESMO lote cortado");
    ok("PERFORMANCE_MAX_ITENS: itemIds além do teto são cortados antes de chegar aos dois serviços");
  });

  // 5. clienteContaId chega aos dois serviços de baixo.
  await withMockDb(DUAS_CONTAS, async () => {
    reset();
    metricasHandler = () => ({});
    margemHandler = () => ({ itens: [] });

    const res = fakeRes();
    await ctrl.performance(
      { query: { clienteSlug: "cliente-a", itemIds: "MLB-A", clienteContaId: "11" } },
      res
    );

    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(chamadasMetricas[0].mlUserId, "222", "métricas têm de usar o ml_user_id da conta selecionada, não a primeira");
    assert.strictEqual(chamadasMargem[0].clienteContaId, 11, "margem tem de saber de qual conta é — senão calcula a conta errada");
    ok("clienteContaId chega correto aos dois serviços (métricas via mlUserId, margem via clienteContaId)");
  });

  // 6. Lote vazio: zero chamadas aos serviços de baixo.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "" } }, res);
    assert.strictEqual(res.corpo.ok, true);
    assert.deepStrictEqual(res.corpo.metricas7d, {});
    assert.deepStrictEqual(res.corpo.margem, {});
    assert.strictEqual(chamadasMetricas.length, 0, "lote vazio não pode gastar chamada nenhuma");
    assert.strictEqual(chamadasMargem.length, 0);
    ok("itemIds vazio: 200 com mapas vazios, zero chamadas aos serviços de baixo");
  });

  // 7. clienteSlug ausente: 400 sem tocar nos serviços.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    const res = fakeRes();
    await ctrl.performance({ query: { itemIds: "MLB-A" } }, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(chamadasMetricas.length, 0);
    assert.strictEqual(chamadasMargem.length, 0);
    ok("clienteSlug ausente: 400 sem chamar nenhum serviço");
  });

  // 8. Ambiguidade de conta (2+ contas, sem seleção): 409, não chute.
  await withMockDb(DUAS_CONTAS, async () => {
    reset();
    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-A" } }, res);
    assert.strictEqual(res.statusCode, 409, "duas contas sem seleção não pode resolver sozinho — é ambiguidade");
    ok("duas contas sem clienteContaId: 409 (ambiguidade), nunca uma conta escolhida em silêncio");
  });

  // 9. incluirMargem=0 — usado pelo pré-carregamento em background do
  //    agrupador ainda fechado: métricas rodam normalmente, o Motor de
  //    Margem NUNCA é chamado (zero chamadas ao motorMargemService).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({ "MLB-A": { views: 10, vendas: 1, conversao: 10 } });
    margemHandler = () => ({ itens: [itemDeMargem({ itemId: "MLB-A", realizedComputable: true, realizedMargin: 0.3, status: "HEALTHY", statusLabel: "Saudável" })] });

    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-A", incluirMargem: "0" } }, res);

    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.metricas7d["MLB-A"].views, 10, "métricas continuam vindo com incluirMargem=0");
    assert.deepStrictEqual(res.corpo.margem, {}, "margem some da resposta quando incluirMargem=0");
    assert.strictEqual(res.corpo.margemIndisponivel, null);
    assert.strictEqual(chamadasMargem.length, 0, "o Motor de Margem não pode ser chamado quando incluirMargem=0");
    assert.strictEqual(chamadasMetricas.length, 1, "métricas seguem chamadas normalmente");
    ok("incluirMargem=0: zero chamadas ao Motor de Margem, métricas intactas — o pré-carregamento do agrupador fechado nunca gasta margem");
  });

  // 10. incluirMetricas=0 — usado quando a expansão só precisa da margem
  //     (as métricas já vieram do pré-carregamento em background).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({ "MLB-A": { views: 10, vendas: 1, conversao: 10 } });
    margemHandler = () => ({ itens: [itemDeMargem({ itemId: "MLB-A", projectedMargin: 0.3, status: "HEALTHY", statusLabel: "Saudável" })] });

    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-A", incluirMetricas: "0" } }, res);

    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.deepStrictEqual(res.corpo.metricas7d, {}, "métricas somem da resposta quando incluirMetricas=0");
    assert.strictEqual(res.corpo.margem["MLB-A"].marginPercent, 30, "margem continua vindo com incluirMetricas=0");
    assert.strictEqual(chamadasMetricas.length, 0, "meliMetricas7dService não pode ser chamado quando incluirMetricas=0");
    assert.strictEqual(chamadasMargem.length, 1, "margem segue chamada normalmente");
    ok("incluirMetricas=0: zero chamadas a meliMetricas7dService, margem intacta — expandir depois do pré-carregamento não refaz a métrica");
  });

  // 11. Os dois desligados ao mesmo tempo: 200 com mapas vazios, zero
  //     chamadas aos dois serviços — mesmo com itemIds preenchido.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-A", incluirMetricas: "0", incluirMargem: "0" } }, res);
    assert.strictEqual(res.corpo.ok, true);
    assert.deepStrictEqual(res.corpo.metricas7d, {});
    assert.deepStrictEqual(res.corpo.margem, {});
    assert.strictEqual(chamadasMetricas.length, 0);
    assert.strictEqual(chamadasMargem.length, 0);
    ok("incluirMetricas=0 e incluirMargem=0 juntos: zero chamadas aos dois serviços, mesmo com itemIds preenchido");
  });

  // 12. incluirComposicao=1 + item com realized E projected computáveis:
  //     mesmo com realized presente/computável (e sua própria composição
  //     realizada, ladder completo, taxa fixa ausente como sempre foi),
  //     a resposta usa EXCLUSIVAMENTE o lado projected — margem, profit e
  //     composição inteira. Prova que "realized computável" não muda mais
  //     nada nesta rota (decisão de produto da missão).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({});
    margemHandler = () => ({
      itens: [itemDeMargem({
        itemId: "MLB-R1",
        realizedComputable: true, realizedMargin: 0.32, realizedProfit: 64,
        projectedMargin: 0.20, projectedProfit: 30,
        status: "HEALTHY", statusLabel: "Saudável",
        composicao: {
          vendaRealizada: 200, custoRealizado: 80, impostoRealizado: 0.05, comissaoRealizada: 25, freteRealizado: 15,
          vendaProjetada: 150, custoProjetado: 60, impostoProjetado: 0.04, comissaoProjetada: 18, freteProjetado: 12, taxaFixaProjetada: 3,
        },
      })],
    });

    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-R1", incluirComposicao: "1" } }, res);

    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.margem["MLB-R1"].origem, "projected", "origem é sempre projected, mesmo com realized computável presente");
    assert.strictEqual(res.corpo.margem["MLB-R1"].marginPercent, 20, "mostra 20% (projected), nunca 32% (realized) — realized computável não muda a precedência");
    assert.strictEqual(res.corpo.margem["MLB-R1"].profit, 30,
      "profit é o do lado projected (30), nunca o de realized (64), mesmo com os dois presentes e computáveis");
    assert.deepStrictEqual(res.corpo.composicao["MLB-R1"], {
      venda: 150, custoProduto: 60, comissaoMl: 18, frete: 12, taxaFixa: 3, impostoPercentual: 0.04, impostoValor: 6,
      precoPromocionalAtivo: false, rebate: null,
    }, JSON.stringify(res.corpo.composicao));
    ok("item com realized E projected computáveis: composição inteira vem do lado projected — a composição realizada (presente no item) nunca é lida por esta rota");
  });

  // 13. incluirComposicao=1 + margem PROJETADA (sem venda realizada): usa os
  //     campos projetados, incluindo taxa fixa (que só existe do lado
  //     projetado).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({});
    margemHandler = () => ({
      itens: [itemDeMargem({
        itemId: "MLB-P1", realizedComputable: false, projectedMargin: 0.20, projectedProfit: 30, status: "HEALTHY", statusLabel: "Saudável",
        composicao: { vendaProjetada: 150, custoProjetado: 60, impostoProjetado: 0.04, comissaoProjetada: 18, freteProjetado: 12, taxaFixaProjetada: 3 },
      })],
    });

    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-P1", incluirComposicao: "1" } }, res);

    assert.strictEqual(res.corpo.margem["MLB-P1"].origem, "projected");
    assert.strictEqual(res.corpo.margem["MLB-P1"].profit, 30);
    assert.deepStrictEqual(res.corpo.composicao["MLB-P1"], {
      venda: 150, custoProduto: 60, comissaoMl: 18, frete: 12, taxaFixa: 3, impostoPercentual: 0.04, impostoValor: 6,
      precoPromocionalAtivo: false, rebate: null,
    }, JSON.stringify(res.corpo.composicao));
    ok("incluirComposicao=1 + margem projetada: ladder completo, incluindo taxa fixa (só existe do lado projetado)");
  });

  // 14. Item NÃO computável (nem realizada nem projetada — ex. UNVALIDATED):
  //     composicao fica de fora, o front cai no statusLabel/statusReasons
  //     de sempre. Nunca uma composição parcial.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({});
    margemHandler = () => ({
      itens: [itemDeMargem({
        itemId: "MLB-U1", realizedComputable: false, projectedComputable: false, projectedMargin: null,
        status: "UNVALIDATED", statusLabel: "Não validado", statusReasons: ["Variáveis obrigatórias ausentes: custo."],
      })],
    });

    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-U1", incluirComposicao: "1" } }, res);

    assert.strictEqual(res.corpo.margem["MLB-U1"].statusLabel, "Não validado");
    assert.strictEqual(res.corpo.composicao["MLB-U1"], undefined, "item não-computável não pode ter composição, nem parcial");
    ok("item não-computável (UNVALIDATED): composicao fica de fora — sem número, sem estimativa, só o rótulo real do Motor");
  });

  // 15. incluirComposicao ausente (default "0"): composicao vem vazia mesmo
  //     com item perfeitamente computável — é opt-in, ao contrário de
  //     incluirMetricas/incluirMargem.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({});
    margemHandler = () => ({
      itens: [itemDeMargem({
        itemId: "MLB-R2", projectedMargin: 0.30, status: "HEALTHY", statusLabel: "Saudável",
        composicao: { vendaProjetada: 100, custoProjetado: 50, impostoProjetado: 0.05, comissaoProjetada: 10, freteProjetado: 5 },
      })],
    });

    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-R2" } }, res);

    assert.strictEqual(res.corpo.margem["MLB-R2"].marginPercent, 30, "margem continua vindo normalmente");
    assert.deepStrictEqual(res.corpo.composicao, {}, "composicao é opt-in — sem incluirComposicao=1, fica sempre vazia");
    ok("incluirComposicao ausente: default desligado (opt-in), composicao vazia mesmo com item computável");
  });

  // 16. incluirComposicao=1 mas incluirMargem=0: composicao depende de
  //     margem ter sido buscada — sem margem, não tem o que decompor.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({ "MLB-R3": { views: 10, vendas: 1, conversao: 10 } });
    margemHandler = () => ({
      itens: [itemDeMargem({
        itemId: "MLB-R3", realizedComputable: true, realizedMargin: 0.30, status: "HEALTHY", statusLabel: "Saudável",
        composicao: { vendaRealizada: 100, custoRealizado: 50, impostoRealizado: 0.05, comissaoRealizada: 10, freteRealizado: 5 },
      })],
    });

    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-R3", incluirMargem: "0", incluirComposicao: "1" } }, res);

    assert.deepStrictEqual(res.corpo.margem, {}, "margem desligada continua vazia");
    assert.deepStrictEqual(res.corpo.composicao, {}, "composicao sem margem não tem o que decompor — fica vazia também");
    assert.strictEqual(chamadasMargem.length, 0, "o Motor de Margem não pode ser chamado quando incluirMargem=0, mesmo pedindo composicao");
    ok("incluirComposicao=1 com incluirMargem=0: composicao vazia, Motor de Margem não é chamado");
  });

  // 17. subsidioMl/subsidioMlItemId (promoção ATIVA do modal, ver
  //     meliPromocoesService.normalizarPromocao) — o front já tem esse valor
  //     em cache (garantirPromocoesDoItem roda ao abrir o modal, antes da
  //     composição), então chega pronto na querystring — zero chamada ML
  //     nova aqui. Reaproveita EXATAMENTE marginEngine.computeMargin (mesmo
  //     campo `rebate` de POST .../simular-margem), nunca uma fórmula
  //     paralela: profit/marginPercent do item recalculados COM rebate,
  //     "Taxa de rebate" aparece na composição com o valor aplicado.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({});
    margemHandler = () => ({
      itens: [itemDeMargem({
        itemId: "MLB-REB1", projectedMargin: 0.35, projectedProfit: 35, status: "HEALTHY", statusLabel: "Saudável",
        composicao: { vendaProjetada: 100, custoProjetado: 40, impostoProjetado: 0.05, comissaoProjetada: 12, freteProjetado: 8 },
      })],
    });

    const res = fakeRes();
    await ctrl.performance({
      query: {
        clienteSlug: "cliente-a", itemIds: "MLB-REB1", incluirComposicao: "1",
        subsidioMlItemId: "MLB-REB1", subsidioMl: "1.35",
      },
    }, res);

    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.margem["MLB-REB1"].profit, 36.35, "profit final precisa somar o rebate (35 + 1.35)");
    assert.strictEqual(res.corpo.margem["MLB-REB1"].marginPercent, 36.35, "marginPercent recalculado com o lucro já com rebate (36.35/100)");
    assert.strictEqual(res.corpo.composicao["MLB-REB1"].rebate, 1.35, "composição mostra a Taxa de rebate aplicada");
    ok("subsidioMl da promoção ATIVA: margem inicial (sem clicar em Simular) já soma o rebate, composição ganha a linha Taxa de rebate");
  });

  // 18. Sem subsidioMl (nenhuma promoção ativa, ou modal fora do fluxo de
  //     rebate): comportamento idêntico ao anterior — rebate: null na
  //     composição, margem sem alteração nenhuma.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({});
    margemHandler = () => ({
      itens: [itemDeMargem({
        itemId: "MLB-REB2", projectedMargin: 0.35, projectedProfit: 35, status: "HEALTHY", statusLabel: "Saudável",
        composicao: { vendaProjetada: 100, custoProjetado: 40, impostoProjetado: 0.05, comissaoProjetada: 12, freteProjetado: 8 },
      })],
    });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-REB2", incluirComposicao: "1" },
    }, res);

    assert.strictEqual(res.corpo.margem["MLB-REB2"].profit, 35, "sem subsidioMl, profit continua o valor real do Motor — comportamento anterior preservado");
    assert.strictEqual(res.corpo.composicao["MLB-REB2"].rebate, null, "sem promoção ativa, a linha Taxa de rebate não aparece (rebate: null)");
    ok("sem subsidioMl: comportamento idêntico ao anterior, rebate: null na composição");
  });

  // 18b. incluirRebateAtivo=1 (margem da LISTA): o retorno ML da promoção
  //      ATIVA é lido ao vivo só para os itens que o Motor viu em promoção
  //      (pricing.promo) e somado na margem pela mesma computeMargin. Caso
  //      real Red Fish: relâmpago `pending` formando o preço a 112,81.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({});
    const comPromo = itemDeMargem({
      itemId: "MLB-PROMO", projectedMargin: 0.35, projectedProfit: 35, status: "HEALTHY", statusLabel: "Saudável",
      composicao: { vendaProjetada: 100, custoProjetado: 40, impostoProjetado: 0.05, comissaoProjetada: 12, freteProjetado: 8 },
    });
    comPromo.pricing.promo = evid(100);
    const semPromo = itemDeMargem({
      itemId: "MLB-CHEIO", projectedMargin: 0.35, projectedProfit: 35, status: "HEALTHY", statusLabel: "Saudável",
      composicao: { vendaProjetada: 100, custoProjetado: 40, impostoProjetado: 0.05, comissaoProjetada: 12, freteProjetado: 8 },
    });
    margemHandler = () => ({ itens: [comPromo, semPromo] });
    rebateHandler = () => ({ ok: true, rebate: 7.45, promocao: { id: "P-MLB18055120", nome: "OFERTAS RELÂMPAGOS", tipoLabel: "Oferta relâmpago" } });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-PROMO,MLB-CHEIO", incluirRebateAtivo: "1" },
    }, res);

    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.deepStrictEqual(chamadasRebate.map((c) => c.itemId), ["MLB-PROMO"], "só item em promoção gasta leitura de rebate");
    assert.strictEqual(chamadasRebate[0].mlUserId, "111", "conta ML resolvida chega à leitura");
    const m = res.corpo.margem["MLB-PROMO"];
    assert.strictEqual(m.profit, 42.45, "profit soma o rebate (35 + 7,45)");
    assert.strictEqual(m.marginPercent, 42.45);
    assert.strictEqual(m.rebate, 7.45);
    assert.strictEqual(m.rebatePromocao.nome, "OFERTAS RELÂMPAGOS");
    assert.strictEqual(res.corpo.margem["MLB-CHEIO"].profit, 35, "sem promoção, margem do Motor intacta");
    assert.strictEqual(res.corpo.margem["MLB-CHEIO"].rebate, null);
    ok("incluirRebateAtivo: rebate da promoção ativa somado só nos itens em promoção, com a promoção exposta");

    // Falha da leitura do rebate: margem do Motor como antes, nunca 500.
    reset();
    metricasHandler = () => ({});
    margemHandler = () => ({ itens: [comPromo] });
    rebateHandler = () => { throw new Error("429"); };
    const res2 = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-PROMO", incluirRebateAtivo: "1" } }, res2);
    assert.strictEqual(res2.corpo.ok, true);
    assert.strictEqual(res2.corpo.margem["MLB-PROMO"].profit, 35);
    assert.strictEqual(res2.corpo.margem["MLB-PROMO"].rebate, null);

    // Sem a flag: zero leitura de rebate (modal e chamadas antigas iguais).
    reset();
    metricasHandler = () => ({});
    margemHandler = () => ({ itens: [comPromo] });
    const res3 = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-PROMO" } }, res3);
    assert.strictEqual(chamadasRebate.length, 0);
    assert.strictEqual(res3.corpo.margem["MLB-PROMO"].profit, 35);

    // subsidioMl explícito do modal vence: o item dele não é relido.
    reset();
    metricasHandler = () => ({});
    margemHandler = () => ({ itens: [comPromo] });
    rebateHandler = () => ({ ok: true, rebate: 7.45, promocao: null });
    const res4 = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-PROMO", incluirRebateAtivo: "1", subsidioMlItemId: "MLB-PROMO", subsidioMl: "1.35" },
    }, res4);
    assert.strictEqual(chamadasRebate.length, 0, "item com subsidioMl do modal não gasta leitura");
    assert.strictEqual(res4.corpo.margem["MLB-PROMO"].profit, 36.35);
    ok("incluirRebateAtivo: falha vira margem do Motor, sem a flag nada muda, subsidioMl do modal tem prioridade");
  });

  // 18c. Peso da lista: o sale_price que o Motor JÁ leu decide a promoção
  //      (saleInfo, sem reler) e o rebate fica em cache por (item, oferta) —
  //      recarregar a página não gasta leitura; trocar a oferta gasta.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({});
    const item = itemDeMargem({
      itemId: "MLB-REL", projectedMargin: 0.35, projectedProfit: 35, status: "HEALTHY", statusLabel: "Saudável",
      composicao: { vendaProjetada: 100, custoProjetado: 40, impostoProjetado: 0.05, comissaoProjetada: 12, freteProjetado: 8 },
    });
    item.pricing.promo = evid(100);
    item.diagnostico = { promotionIdAtivo: "OFFER-MLB-REL-1" };
    margemHandler = () => ({ itens: [item] });
    rebateHandler = () => ({ ok: true, rebate: 7.45, promocao: { nome: "Relâmpago" } });
    const pedir = async () => {
      const res = fakeRes();
      await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-REL", incluirRebateAtivo: "1" } }, res);
      return res.corpo.margem["MLB-REL"];
    };

    assert.strictEqual((await pedir()).profit, 42.45);
    assert.deepStrictEqual(chamadasRebate[0].saleInfo, { promotionId: "OFFER-MLB-REL-1", amount: 100, regularAmount: null }, "sale_price do Motor reaproveitado");
    assert.strictEqual((await pedir()).profit, 42.45, "do cache, mesmo valor");
    assert.strictEqual(chamadasRebate.length, 1, "2º carregamento da mesma oferta não lê o ML");

    item.diagnostico = { promotionIdAtivo: "OFFER-MLB-REL-2" };
    rebateHandler = () => ({ ok: true, rebate: 4.62, promocao: { nome: "Impulsione" } });
    assert.strictEqual((await pedir()).profit, 39.62, "oferta trocada = leitura nova");
    assert.strictEqual(chamadasRebate.length, 2);

    item.diagnostico = { promotionIdAtivo: undefined }; // preço fora do sale_price
    await pedir();
    await pedir();
    assert.strictEqual(chamadasRebate.length, 4, "sem saber a promoção, nada vai ao cache");
    assert.strictEqual(chamadasRebate[3].saleInfo, null);

    item.diagnostico = { promotionIdAtivo: "OFFER-MLB-REL-3" };
    rebateHandler = () => ({ ok: false, rebate: null, promocao: null });
    await pedir();
    rebateHandler = () => ({ ok: true, rebate: 1, promocao: null });
    assert.strictEqual((await pedir()).profit, 36, "falha não fica em cache");
    ok("rebate da lista: 1 leitura por oferta (sale_price do Motor reaproveitado) e cache por (item, oferta)");
  });

  // 19. subsidioMl negativo: 400, sem gastar chamada nenhuma (mesma postura
  //     de validação de POST .../simular-margem).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-A", subsidioMlItemId: "MLB-A", subsidioMl: "-1" },
    }, res);

    assert.strictEqual(res.statusCode, 400, "subsidioMl negativo precisa ser rejeitado");
    assert.strictEqual(chamadasMargem.length, 0, "validação falha antes de qualquer chamada ao Motor");
    ok("subsidioMl negativo: 400, zero chamada ao Motor de Margem");
  });

  // 20. subsidioMlItemId aponta para um item que não está no lote pedido:
  //     nunca aplica o rebate em outro item por engano — margem do item
  //     realmente pedido fica intacta.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({});
    margemHandler = () => ({
      itens: [itemDeMargem({ itemId: "MLB-A", projectedMargin: 0.3, projectedProfit: 30, status: "HEALTHY", statusLabel: "Saudável" })],
    });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-A", subsidioMlItemId: "MLB-OUTRO", subsidioMl: "1.35" },
    }, res);

    assert.strictEqual(res.corpo.margem["MLB-A"].profit, 30, "subsidioMlItemId de outro item nunca contamina a margem do item pedido");
    ok("subsidioMlItemId que não bate com nenhum item do lote: rebate não é aplicado em lugar nenhum");
  });

  // 21. Item não-computável: subsidioMl presente não força um cálculo —
  //     continua sem composição, sem margem inventada (mesma regra do teste 14).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({});
    margemHandler = () => ({
      itens: [itemDeMargem({
        itemId: "MLB-U2", realizedComputable: false, projectedComputable: false, projectedMargin: null,
        status: "UNVALIDATED", statusLabel: "Não validado", statusReasons: ["Variáveis obrigatórias ausentes: custo."],
      })],
    });

    const res = fakeRes();
    await ctrl.performance({
      query: {
        clienteSlug: "cliente-a", itemIds: "MLB-U2", incluirComposicao: "1",
        subsidioMlItemId: "MLB-U2", subsidioMl: "1.35",
      },
    }, res);

    assert.strictEqual(res.corpo.margem["MLB-U2"].statusLabel, "Não validado");
    assert.strictEqual(res.corpo.composicao["MLB-U2"], undefined, "item não-computável não ganha composição só porque subsidioMl foi passado");
    ok("item não-computável + subsidioMl presente: sem composição, sem margem inventada — mesma regra de sempre");
  });

  // ── Filtros de performance (% faturamento / unidades vendidas / Curva ABC) ─
  // Ver docs da auditoria "Anúncios ML — análise de viabilidade de novos
  // filtros de performance": as 3 capacidades novas são opt-in (mesmo padrão
  // de incluirComposicao) e carregam CONTEXTO DE PERÍODO no próprio campo
  // (periodoDias), em vez de nomes como "unidadesVendidas7d"/"curvaAbc30d" —
  // o período pode mudar no futuro sem quebrar o contrato.

  // 22. incluirFaturamento=1: percentual = receita do item / receita de TODO
  //     o período (porMlb inteiro do Motor de Margem), nunca só do lote de
  //     itemIds pedido — Curva ABC depende da mesma base, então os dois
  //     precisam do catálogo inteiro, não de uma fatia arbitrária da tela.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    margemHandler = () => ({
      itens: [],
      porMlb: new Map([
        ["MLB-A", { receita: 300 }],
        ["MLB-B", { receita: 100 }],
        ["MLB-OUTRO", { receita: 600 }], // fora do lote pedido — ainda assim conta no total
      ]),
      periodo: { dateFrom: "2026-08-01", dateTo: "2026-08-30" },
    });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-A,MLB-B", incluirMetricas: "0", incluirFaturamento: "1" },
    }, res);

    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.faturamento.receitaTotalPeriodo, 1000, "total é o porMlb INTEIRO (300+100+600), não só o lote pedido (300+100)");
    assert.strictEqual(res.corpo.faturamento.porItem["MLB-A"], 0.3, "300/1000");
    assert.strictEqual(res.corpo.faturamento.porItem["MLB-B"], 0.1, "100/1000");
    assert.strictEqual(res.corpo.faturamento.periodoDias, 30, "01/08 a 30/08 inclusive = 30 dias");
    ok("incluirFaturamento=1: percentual usa o total do PERÍODO INTEIRO (porMlb), não só o lote de itemIds");
  });

  // 23. incluirFaturamento ausente (default off, opt-in como incluirComposicao).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    margemHandler = () => ({ itens: [], porMlb: new Map([["MLB-A", { receita: 100 }]]), periodo: { dateFrom: "2026-08-01", dateTo: "2026-08-30" } });

    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-A", incluirMetricas: "0" } }, res);

    assert.strictEqual(res.corpo.faturamento, null, "incluirFaturamento é opt-in — ausente, fica null");
    ok("incluirFaturamento ausente: default desligado, faturamento null");
  });

  // 24. incluirCurvaAbc=1: reaproveita cliente360ProdutosEngine.classificarCurvaAbc
  //     (Pareto 80/95), nunca uma fórmula paralela.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    margemHandler = () => ({
      itens: [],
      porMlb: new Map([
        ["MLB-A", { receita: 800 }],
        ["MLB-B", { receita: 150 }],
        ["MLB-C", { receita: 50 }],
      ]),
      periodo: { dateFrom: "2026-08-01", dateTo: "2026-08-30" },
    });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-A,MLB-B,MLB-C", incluirMetricas: "0", incluirCurvaAbc: "1" },
    }, res);

    assert.strictEqual(res.corpo.curvaAbc.porItem["MLB-A"], "A", "80% acumulado — classe A");
    assert.strictEqual(res.corpo.curvaAbc.porItem["MLB-B"], "B", "95% acumulado — classe B");
    assert.strictEqual(res.corpo.curvaAbc.porItem["MLB-C"], "C", "resto — classe C");
    assert.strictEqual(res.corpo.curvaAbc.periodoDias, 30);
    ok("incluirCurvaAbc=1: classificação A/B/C via cliente360ProdutosEngine.classificarCurvaAbc, mesmo critério do Cliente 360");
  });

  // 25. incluirUnidades=1 COM incluirMetricas=1: reaproveita metricas7d.vendas
  //     já buscado — zero chamada extra a buscarVendas7dPorItens.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    metricasHandler = () => ({ "MLB-A": { views: 10, vendas: 5, conversao: 50 } });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-A", incluirMargem: "0", incluirUnidades: "1" },
    }, res);

    assert.strictEqual(res.corpo.unidadesVendidas.porItem["MLB-A"], 5, "reaproveita metricas7d[itemId].vendas");
    assert.strictEqual(res.corpo.unidadesVendidas.periodoDias, 7);
    assert.strictEqual(chamadasVendasSo.length, 0, "incluirMetricas já trouxe vendas — buscarVendas7dPorItens não pode ser chamado de novo");
    ok("incluirUnidades=1 com incluirMetricas=1: reaproveita metricas7d.vendas, zero chamada extra");
  });

  // 26. incluirUnidades=1 SEM incluirMetricas: chama só buscarVendas7dPorItens
  //     (sem visitas — mais barato para listas grandes).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    vendasSoHandler = () => ({ ok: true, porItem: { "MLB-A": 3 } });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-A", incluirMetricas: "0", incluirMargem: "0", incluirUnidades: "1" },
    }, res);

    assert.strictEqual(res.corpo.unidadesVendidas.porItem["MLB-A"], 3);
    assert.deepStrictEqual(res.corpo.metricas7d, {}, "incluirMetricas=0 continua sem devolver metricas7d");
    assert.strictEqual(chamadasMetricas.length, 0, "montarMetricas7d (que também busca visitas) não pode ser chamado só por causa de incluirUnidades");
    assert.strictEqual(chamadasVendasSo.length, 1, "busca só as vendas, sem visitas");
    ok("incluirUnidades=1 sem incluirMetricas: busca só vendas (buscarVendas7dPorItens), nunca as visitas");
  });

  // 27. Anúncio sem venda no período: unidadesVendidas = 0 (fato, não
  //     ausência); faturamento/curvaAbc = null (sem receita não tem % nem
  //     classe — 0% e "C" seriam inventados).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    vendasSoHandler = () => ({ ok: true, porItem: {} });
    margemHandler = () => ({
      itens: [],
      porMlb: new Map([["MLB-OUTRO", { receita: 500 }]]),
      periodo: { dateFrom: "2026-08-01", dateTo: "2026-08-30" },
    });

    const res = fakeRes();
    await ctrl.performance({
      query: {
        clienteSlug: "cliente-a", itemIds: "MLB-Z", incluirMetricas: "0",
        incluirUnidades: "1", incluirFaturamento: "1", incluirCurvaAbc: "1",
      },
    }, res);

    assert.strictEqual(res.corpo.unidadesVendidas.porItem["MLB-Z"], 0, "sem pedido no período é fato: 0 unidades");
    assert.strictEqual(res.corpo.faturamento.porItem["MLB-Z"], null, "sem receita no período — null, nunca 0% inventado");
    assert.strictEqual(res.corpo.faturamento.porItemValor["MLB-Z"], null, "sem receita no período — null, nunca 0 inventado (mesma regra do percentual)");
    assert.strictEqual(res.corpo.curvaAbc.porItem["MLB-Z"], null, "sem receita no período — sem classe, nunca 'C' inventado");
    ok("anúncio sem venda no período: unidadesVendidas=0 (fato), faturamento/curvaAbc=null (nada a classificar)");
  });

  // 28. Falha na busca de vendas (ok:false — pedidos indisponíveis):
  //     unidadesVendidas vira null (não sabemos), mesma régua do metricas7d.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    vendasSoHandler = () => ({ ok: false, porItem: {} });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-Z", incluirMetricas: "0", incluirMargem: "0", incluirUnidades: "1" },
    }, res);

    assert.strictEqual(res.corpo.unidadesVendidas.porItem["MLB-Z"], null, "busca de pedidos falhou — não sabemos, nunca 0 fingido");
    ok("falha ao buscar vendas do período: unidadesVendidas vira null, nunca 0 fingido");
  });

  // 29. incluirFaturamento=1 com incluirMargem=0: o Motor de Margem AINDA
  //     PRECISA rodar (é dali que vem o porMlb), mas `margem` continua vazio
  //     — o comportamento de incluirMargem=0 sobre o campo `margem` não muda.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    margemHandler = () => ({
      itens: [itemDeMargem({ itemId: "MLB-A", realizedComputable: true, realizedMargin: 0.3, status: "HEALTHY", statusLabel: "Saudável" })],
      porMlb: new Map([["MLB-A", { receita: 100 }]]),
      periodo: { dateFrom: "2026-08-01", dateTo: "2026-08-30" },
    });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-A", incluirMetricas: "0", incluirMargem: "0", incluirFaturamento: "1" },
    }, res);

    assert.strictEqual(chamadasMargem.length, 1, "faturamento depende do porMlb do Motor — precisa chamar montarItens mesmo com incluirMargem=0");
    assert.deepStrictEqual(res.corpo.margem, {}, "margem continua vazia — incluirMargem=0 não muda de comportamento");
    assert.strictEqual(res.corpo.faturamento.porItem["MLB-A"], 1, "100/100 — único item do período");
    ok("incluirFaturamento=1 com incluirMargem=0: Motor roda (porMlb), mas campo margem continua vazio");
  });

  // ── família agregada (familias=FAM1|FAM2) ───────────────────────────────
  // Backend resolve os MLBs filhos por family_id (o front nunca enumera) e
  // agrega margem/faturamento/Curva ABC — nunca soma percentuais prontos,
  // nunca herda a classe de 1 filho só.

  // 30. familias=FAM1: os filhos resolvidos entram no MESMO pedido ao Motor
  //     de Margem/vendas — nunca uma segunda rodada de chamadas.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    familiaHandler = () => new Map([["FAM1", ["MLB-F1", "MLB-F2"]]]);
    margemHandler = () => ({
      itens: [itemDeMargem({ itemId: "MLB-A", realizedComputable: true, realizedMargin: 0.3, realizedProfit: 30, status: "HEALTHY", statusLabel: "Saudável" })],
      porMlb: new Map(),
      periodo: { dateFrom: "2026-08-01", dateTo: "2026-08-30" },
    });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-A", incluirMetricas: "0", familias: "FAM1" },
    }, res);

    assert.strictEqual(chamadasFamilia.length, 1, "resolverItensDeFamilias precisa ser chamado quando familias= é passado");
    assert.deepStrictEqual(chamadasFamilia[0].familyIds, ["FAM1"]);
    assert.deepStrictEqual(chamadasMargem[0].itemIds.slice().sort(), ["MLB-A", "MLB-F1", "MLB-F2"],
      "os filhos resolvidos entram no MESMO lote pedido ao Motor — nunca uma segunda chamada");
    ok("familias=FAM1: filhos resolvidos entram no mesmo lote do Motor de Margem, uma chamada só");
  });

  // 31. margemPorFamilia: soma o PROFIT (R$, absoluto) dos filhos — nunca a
  //     margem percentual (não é somável).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    familiaHandler = () => new Map([["FAM1", ["MLB-F1", "MLB-F2"]]]);
    margemHandler = () => ({
      itens: [
        itemDeMargem({ itemId: "MLB-F1", projectedMargin: 0.25, projectedProfit: 100, status: "HEALTHY", statusLabel: "Saudável" }),
        itemDeMargem({ itemId: "MLB-F2", projectedMargin: 0.10, projectedProfit: 50, status: "HEALTHY", statusLabel: "Saudável" }),
      ],
      porMlb: new Map(),
      periodo: { dateFrom: "2026-08-01", dateTo: "2026-08-30" },
    });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "", incluirMetricas: "0", familias: "FAM1" },
    }, res);

    assert.strictEqual(res.corpo.margemPorFamilia["FAM1"], 150, "soma de profit: 100 + 50 = 150");
    ok("margemPorFamilia: soma o profit (R$) dos filhos, nunca a margem percentual");
  });

  // 32. faturamento.porFamilia: receita SOMADA dos filhos / receita TOTAL do
  //     período (mesmo total de faturamento.porItem) — nunca soma percentuais.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    familiaHandler = () => new Map([["FAM1", ["MLB-F1", "MLB-F2"]]]);
    margemHandler = () => ({
      itens: [],
      porMlb: new Map([
        ["MLB-F1", { receita: 200 }],
        ["MLB-F2", { receita: 100 }],
        ["MLB-OUTRO", { receita: 700 }],
      ]),
      periodo: { dateFrom: "2026-08-01", dateTo: "2026-08-30" },
    });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "", incluirMetricas: "0", incluirFaturamento: "1", familias: "FAM1" },
    }, res);

    assert.strictEqual(res.corpo.faturamento.receitaTotalPeriodo, 1000);
    assert.strictEqual(res.corpo.faturamento.porFamilia["FAM1"], 0.3, "(200+100)/1000 — receita somada dos filhos sobre o total do período");
    ok("faturamento.porFamilia: receita somada dos filhos / receita total do período");
  });

  // 33. curvaAbc.porFamilia: a família vira 1 produto (receita SOMADA) no
  //     Pareto — o teste é desenhado para provar SOMA de verdade, não só
  //     "devolveu uma classe plausível": A=300, B=250, C=200, F1=140, F2=140
  //     (total 1030). Se os filhos NÃO fossem somados (ex.: bug que usasse a
  //     classe do primeiro filho isolado), o resultado seria "B" (F1 sozinho,
  //     890/1030=86%) — nunca "A". A família consolidada (F1+F2=280) reordena
  //     ACIMA de B/C (300+280=580/1030=56%) e vira "A" — um resultado que
  //     NENHUM filho isolado alcançaria sozinho, prova de soma real.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    familiaHandler = () => new Map([["FAM1", ["MLB-F1", "MLB-F2"]]]);
    margemHandler = () => ({
      itens: [],
      porMlb: new Map([
        ["MLB-A", { receita: 300 }],
        ["MLB-B", { receita: 250 }],
        ["MLB-C", { receita: 200 }],
        ["MLB-F1", { receita: 140 }],
        ["MLB-F2", { receita: 140 }],
      ]),
      periodo: { dateFrom: "2026-08-01", dateTo: "2026-08-30" },
    });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-A,MLB-B,MLB-C", incluirMetricas: "0", incluirCurvaAbc: "1", familias: "FAM1" },
    }, res);

    assert.strictEqual(res.corpo.curvaAbc.porFamilia["FAM1"], "A",
      "consolidada (140+140=280) reordena acima de B/C e vira classe A — nenhum filho isolado (B ou C) chegaria lá sozinho");
    assert.strictEqual(res.corpo.curvaAbc.porItem["MLB-B"], "B",
      "com a família consolidada à frente, B (250) cai para depois dos 80% acumulados — prova que a família realmente entrou na ordenação, não só ganhou um rótulo");
    ok("curvaAbc.porFamilia: soma real dos filhos muda a ORDEM do Pareto (não só o rótulo) — resultado inatingível por qualquer filho isolado");
  });

  // 34. unidadesVendidas nunca ganha porFamilia do backend — é soma simples,
  //     o front agrega a partir de porItem (nenhuma regra financeira aqui).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    familiaHandler = () => new Map([["FAM1", ["MLB-F1", "MLB-F2"]]]);
    vendasSoHandler = () => ({ ok: true, porItem: { "MLB-F1": 2, "MLB-F2": 3 } });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "", incluirMetricas: "0", incluirMargem: "0", incluirUnidades: "1", familias: "FAM1" },
    }, res);

    assert.strictEqual(res.corpo.unidadesVendidas.porItem["MLB-F1"], 2);
    assert.strictEqual(res.corpo.unidadesVendidas.porItem["MLB-F2"], 3);
    assert.strictEqual(res.corpo.unidadesVendidas.porFamilia, undefined, "unidadesVendidas não tem agregação no backend — soma é responsabilidade do front");
    ok("unidadesVendidas: filhos vêm em porItem, sem porFamilia — agregação simples fica no front");
  });

  // 35. Teto PERFORMANCE_MAX_ITENS aplica-se à UNIÃO (itemIds + filhos de
  //     família resolvidos) — nunca só ao itemIds explícito.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    const muitosFilhos = Array.from({ length: 30 }, (_, i) => `MLB-F${i}`);
    familiaHandler = () => new Map([["FAM1", muitosFilhos]]);
    margemHandler = () => ({ itens: [], porMlb: new Map(), periodo: { dateFrom: "2026-08-01", dateTo: "2026-08-30" } });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-A", incluirMetricas: "0", familias: "FAM1" },
    }, res);

    assert.ok(chamadasMargem[0].itemIds.length <= 24, "união de itemIds+filhos de família nunca pode passar do teto");
    ok("teto PERFORMANCE_MAX_ITENS aplica-se à união de itemIds explícitos + filhos de família resolvidos");
  });

  // 37. faturamento.porItemValor: valor ABSOLUTO (R$) que a receita do item
  //     representa no período — mesma fonte (porMlb.receita) que já monta
  //     porItem (percentual), campo ADITIVO: porItem continua exatamente
  //     como antes (ver auditoria "Curva ABC sempre visível + faturamento
  //     absoluto"). Nunca derivado do percentual arredondado (perderia
  //     precisão de centavos).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    margemHandler = () => ({
      itens: [],
      porMlb: new Map([
        ["MLB-A", { receita: 300 }],
        ["MLB-B", { receita: 100 }],
        ["MLB-OUTRO", { receita: 600 }],
      ]),
      periodo: { dateFrom: "2026-08-01", dateTo: "2026-08-30" },
    });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-A,MLB-B", incluirMetricas: "0", incluirFaturamento: "1" },
    }, res);

    assert.strictEqual(res.corpo.faturamento.porItemValor["MLB-A"], 300, "valor absoluto real (receita), não percentual × total");
    assert.strictEqual(res.corpo.faturamento.porItemValor["MLB-B"], 100);
    assert.strictEqual(res.corpo.faturamento.porItem["MLB-A"], 0.3, "percentual continua exatamente como antes — campo aditivo, não substituição");
    ok("faturamento.porItemValor: valor absoluto (R$) por item, aditivo ao percentual existente");
  });

  // 38. faturamento.porFamiliaValor: receita SOMADA (R$) dos filhos — mesma
  //     soma que já alimenta porFamilia (percentual), nunca derivada de
  //     receitaTotalPeriodo × porFamilia (arredondaria diferente).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    familiaHandler = () => new Map([["FAM1", ["MLB-F1", "MLB-F2"]]]);
    margemHandler = () => ({
      itens: [],
      porMlb: new Map([
        ["MLB-F1", { receita: 200 }],
        ["MLB-F2", { receita: 100 }],
        ["MLB-OUTRO", { receita: 700 }],
      ]),
      periodo: { dateFrom: "2026-08-01", dateTo: "2026-08-30" },
    });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "", incluirMetricas: "0", incluirFaturamento: "1", familias: "FAM1" },
    }, res);

    assert.strictEqual(res.corpo.faturamento.porFamiliaValor["FAM1"], 300, "200+100 — soma bruta dos filhos, não derivada do percentual");
    assert.strictEqual(res.corpo.faturamento.porFamilia["FAM1"], 0.3, "percentual continua igual ao teste 32");
    ok("faturamento.porFamiliaValor: soma bruta (R$) dos filhos, aditivo ao percentual existente");
  });

  // 38b. Unidades vendidas e preço MÉDIO vendido no período (item e família) —
  //      mesmo agregado do Motor que dá a receita. Sem venda: null, nunca 0.
  //      O médio divide só pelas unidades das linhas COM receita.
  await withMockDb(UMA_CONTA, async () => {
    reset();
    familiaHandler = () => new Map([["FAM1", ["MLB-F1", "MLB-F2"]]]);
    margemHandler = () => ({
      itens: [],
      porMlb: new Map([
        ["MLB-A", { receita: 114.9, unidades: 1 }],
        ["MLB-F1", { receita: 200, unidades: 3, receitaCobertura: { unidadesComValor: 2 } }], // 1 un sem receita
        ["MLB-F2", { receita: 100, unidades: 1 }],
      ]),
      periodo: { dateFrom: "2026-08-01", dateTo: "2026-08-30" },
    });

    const res = fakeRes();
    await ctrl.performance({
      query: { clienteSlug: "cliente-a", itemIds: "MLB-A,MLB-SEM", incluirMetricas: "0", incluirFaturamento: "1", familias: "FAM1" },
    }, res);

    const f = res.corpo.faturamento;
    assert.strictEqual(f.porItemUnidades["MLB-A"], 1);
    assert.strictEqual(f.porItemUnidades["MLB-SEM"], null, "sem venda no período: null, nunca 0 inventado");
    assert.strictEqual(f.porFamiliaUnidades["FAM1"], 4, "3 + 1 unidades dos filhos");
    assert.strictEqual(f.porItemPrecoMedio["MLB-A"], 114.9);
    assert.strictEqual(f.porItemPrecoMedio["MLB-SEM"], null);
    assert.strictEqual(f.porFamiliaPrecoMedio["FAM1"], 100, "300 ÷ 3 unidades COM receita (2 + 1), não ÷ 4");
    ok("faturamento: unidades vendidas e preço médio por item/família (médio só sobre unidades com receita)");
  });

  // 39. familias ausente: zero chamada a resolverItensDeFamilias, comporta-
  //     mento idêntico ao anterior (nenhuma regressão nos testes 1-29).
  await withMockDb(UMA_CONTA, async () => {
    reset();
    margemHandler = () => ({
      itens: [itemDeMargem({ itemId: "MLB-A", realizedComputable: true, realizedMargin: 0.3, status: "HEALTHY", statusLabel: "Saudável" })],
    });

    const res = fakeRes();
    await ctrl.performance({ query: { clienteSlug: "cliente-a", itemIds: "MLB-A", incluirMetricas: "0" } }, res);

    assert.strictEqual(chamadasFamilia.length, 0, "sem familias=, resolverItensDeFamilias não pode ser chamado");
    assert.strictEqual(res.corpo.margemPorFamilia, null);
    ok("familias ausente: zero chamada a resolverItensDeFamilias, margemPorFamilia null");
  });
}

run()
  .then(() => {
    console.log(`\n✓ ${checks} verificações de GET /anuncios-meli/performance`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n✗ FALHOU:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
