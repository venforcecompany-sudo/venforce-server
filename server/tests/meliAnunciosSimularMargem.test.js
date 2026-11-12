// server/tests/meliAnunciosSimularMargem.test.js
//
// POST /anuncios-meli/:itemId/simular-margem — simulação LOCAL de margem para
// a seção "Composição da margem" do modal de detalhe do MLB (evolução da
// composição somente-leitura para permitir simulações controladas).
//
// O que este teste protege:
//
//  1. é simulação SEM ESCRITA: nunca grava no Mercado Livre nem na Base de
//     Custos, nunca persiste preço/custo/custos adicionais em lugar nenhum —
//     só invoca o MESMO núcleo puro do Motor (marginEngine.computeMargin),
//     nunca uma segunda fórmula. Sem preço simulado, nenhuma chamada ao ML;
//  2. comissão, frete e imposto não têm override. Com PREÇO simulado ≠ atual
//     (P0 12/11/2026), comissão e frete são COTADOS no preço simulado (GET,
//     token da conta do anúncio) — nunca herdados do preço atual; sem cotação
//     a margem é bloqueada. Overrides só para preço, custo e custos
//     adicionais (que no contrato do Motor é o campo `fixedFee`);
//  3. sem override, o resultado bate com o que a composição já mostraria
//     (mesmos insumos, mesma fórmula);
//  4. cliente sem Base de Custos (custo ausente) fica não-computável, A MENOS
//     que o operador informe um custo de simulação — a simulação pode suprir
//     uma ausência que o Motor sozinho não supre;
//  5. margem negativa (LOSS) é resultado válido e computável, não um erro;
//  6. contexto do Motor não-pronto (Base não vinculada etc.) responde com a
//     mensagem REAL do erro tipado, nunca 500.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const Module = require("module");

let margemHandler = null;
let chamadasMargem = [];
let chamadasMl = [];
let mlHandler = null;
// Linha de meli_anuncios do item (conta 10, seller 111) — o cotador em P' a usa.
let anuncioRow = { id: 7, cliente_id: 1, item_id: "MLB-A", cliente_conta_id: 10, ml_user_id: "111", listing_type_id: "gold_special", category_id: "MLB1", logistic_type: "cross_docking" };

const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (request === "../services/motorMargem/motorMargemService") {
    return {
      async montarItens(args) {
        chamadasMargem.push(args);
        if (!margemHandler) return { itens: [] };
        return margemHandler(args);
      },
    };
  }
  if (request === "../../utils/mlClient" || request === "../utils/mlClient") {
    return {
      async mlFetch(clienteId, path, options = {}) {
        const chamada = { clienteId, path, metodo: options.method || "GET", mlUserId: options.mlUserId || null };
        chamadasMl.push(chamada);
        return mlHandler ? mlHandler(chamada) : { ok: true, status: 200, data: {} };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const pool = require("../config/database");
const ctrl = require("../controllers/meliAnunciosController");

Module._load = originalLoad;

const cliente = { id: 1, nome: "Cliente A", slug: "cliente-a", ativo: true };

class MockDb {
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
    if (q.includes("base_cliente_vinculos")) return { rows: [] };
    if (q.startsWith("SELECT * FROM meli_anuncios WHERE cliente_id = $1 AND item_id = $2")) {
      return { rows: anuncioRow && anuncioRow.cliente_id === params[0] && anuncioRow.item_id === String(params[1]) ? [anuncioRow] : [] };
    }
    if (q.startsWith("CREATE TABLE") || q.startsWith("ALTER TABLE") || q.startsWith("CREATE INDEX")) {
      return { rows: [] };
    }
    return { rows: [] };
  }
}

function withMockDb(fn) {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  const db = new MockDb();
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
  chamadasMargem = [];
  chamadasMl = [];
  margemHandler = null;
  mlHandler = null;
}

// Mesmo shape de item que o Motor de Margem produz (ver meliAnunciosPerformance.test.js).
function evid(valor) {
  return valor == null ? null : { value: valor };
}

function itemFixture({ itemId, venda, custo, imposto, comissao, frete, fixedFee = null }) {
  return {
    identity: { itemId },
    pricing: { current: evid(venda), sold: evid(venda) },
    costs: {
      cost: { projected: evid(custo), realized: evid(custo) },
      taxRate: { projected: evid(imposto), realized: evid(imposto) },
      fixedFee: { projected: evid(fixedFee), realized: null },
    },
    marketplaceCosts: {
      commissionProjected: evid(comissao), commissionRealized: evid(comissao),
      freightProjected: evid(frete), freightRealized: evid(frete),
    },
  };
}

let checks = 0;
function ok(msg) { checks += 1; console.log(`  ✓ ${msg}`); }

async function run() {
  // 1. Sem overrides: usa os valores do item, mesma fórmula do Motor.
  await withMockDb(async () => {
    reset();
    margemHandler = () => ({ itens: [itemFixture({ itemId: "MLB-A", venda: 100, custo: 40, imposto: 0.05, comissao: 12, frete: 8 })] });

    const res = fakeRes();
    await ctrl.simularMargem({ params: { itemId: "MLB-A" }, body: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.simulado, true);
    // lucro = 100 - 100*0.05 - 12 - 8 - 0(fixedFee) - 40 = 35
    assert.strictEqual(res.corpo.resultado.computable, true);
    assert.strictEqual(res.corpo.resultado.profit, 35);
    assert.ok(Math.abs(res.corpo.resultado.marginPercent - 35) < 0.001);
    assert.strictEqual(chamadasMl.length, 0, "simulação não pode chamar o Mercado Livre");
    ok("sem overrides: mesma fórmula do Motor, zero chamada ao Mercado Livre");
  });

  // 2. Override de preço (P0 12/11/2026): comissão e frete COTADOS no preço
  //    simulado — nunca herdados do preço atual (tarifa é % do preço; frete muda
  //    de faixa). Imposto e custo continuam do Motor. Só GET, com o token da conta.
  await withMockDb(async () => {
    reset();
    margemHandler = () => ({ itens: [itemFixture({ itemId: "MLB-A", venda: 100, custo: 40, imposto: 0.05, comissao: 12, frete: 8 })] });
    mlHandler = (c) => (String(c.path).includes("listing_prices")
      ? { ok: true, status: 200, data: { sale_fee_amount: 21, sale_fee_details: { percentage_fee: 14 } } }
      : String(c.path).includes("shipping_options/free")
        ? { ok: true, status: 200, data: { coverage: { all_country: { list_cost: 18, discount: { type: "mandatory", rate: 0.5 } } } } }
        : { ok: false, status: 404, data: null });

    const res = fakeRes();
    await ctrl.simularMargem(
      { params: { itemId: "MLB-A" }, body: { clienteSlug: "cliente-a", preco: 150 } },
      res
    );

    // lucro = 150 - 150*0.05 - 21 - 18 - 40 = 63.5
    assert.strictEqual(res.corpo.resultado.profit, 63.5, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.entradas.commission, 21);
    assert.strictEqual(res.corpo.entradas.freight, 18);
    assert.strictEqual(res.corpo.cotacaoEmP.preco, 150);
    assert.ok(chamadasMl.length >= 2 && chamadasMl.every((c) => c.metodo === "GET" && c.mlUserId === "111"), JSON.stringify(chamadasMl));
    assert.ok(chamadasMl.some((c) => /[?&]price=150(&|$)/.test(c.path)) && chamadasMl.some((c) => /item_price=150(&|$)/.test(c.path)));
    ok("override de preço: comissão e frete cotados no preço simulado (só GET, token da conta do anúncio)");
  });

  // 2b. Preço simulado igual ao atual: nenhuma cotação, valores do Motor.
  await withMockDb(async () => {
    reset();
    margemHandler = () => ({ itens: [itemFixture({ itemId: "MLB-A", venda: 100, custo: 40, imposto: 0.05, comissao: 12, frete: 8 })] });
    const res = fakeRes();
    await ctrl.simularMargem({ params: { itemId: "MLB-A" }, body: { clienteSlug: "cliente-a", preco: 100 } }, res);
    assert.strictEqual(res.corpo.resultado.profit, 35);
    assert.strictEqual(chamadasMl.length, 0);
    ok("preço simulado = preço atual: valores do Motor, sem chamada ao ML");
  });

  // 2c. Cotação indisponível no preço simulado ou anúncio de OUTRA conta: margem bloqueada.
  await withMockDb(async () => {
    reset();
    margemHandler = () => ({ itens: [itemFixture({ itemId: "MLB-A", venda: 100, custo: 40, imposto: 0.05, comissao: 12, frete: 8 })] });
    mlHandler = (c) => (String(c.path).includes("listing_prices")
      ? { ok: true, status: 200, data: { sale_fee_amount: 21 } }
      : { ok: false, status: 429, data: null });
    const res = fakeRes();
    await ctrl.simularMargem({ params: { itemId: "MLB-A" }, body: { clienteSlug: "cliente-a", preco: 150 } }, res);
    assert.strictEqual(res.corpo.resultado.computable, false, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.resultado.profit, null);
    assert.strictEqual(res.corpo.resultado.motivoCotacao, "ml_rate_limit");
    assert.notStrictEqual(res.corpo.entradas.freight, 8, "nunca cai no frete do preço atual");

    reset();
    margemHandler = () => ({ itens: [itemFixture({ itemId: "MLB-A", venda: 100, custo: 40, imposto: 0.05, comissao: 12, frete: 8 })] });
    const res2 = fakeRes();
    await ctrl.simularMargem({ params: { itemId: "MLB-A" }, body: { clienteSlug: "cliente-a", clienteContaId: 99, preco: 150 } }, res2);
    assert.strictEqual(res2.corpo.resultado.computable, false);
    assert.strictEqual(res2.corpo.resultado.motivoCotacao, "anuncio_de_outra_conta");
    assert.strictEqual(chamadasMl.length, 0, "não cota com o token de outra conta");
    ok("sem cotação em P' (429) ou anúncio de outra conta: margem bloqueada, nunca o frete/comissão do preço atual");
  });

  // 3. Override de custo e de custos adicionais (mapeado para fixedFee).
  await withMockDb(async () => {
    reset();
    margemHandler = () => ({ itens: [itemFixture({ itemId: "MLB-A", venda: 100, custo: 40, imposto: 0.05, comissao: 12, frete: 8, fixedFee: 0 })] });

    const res = fakeRes();
    await ctrl.simularMargem(
      { params: { itemId: "MLB-A" }, body: { clienteSlug: "cliente-a", custoProduto: 30, custosAdicionais: 5 } },
      res
    );

    // lucro = 100 - 5 - 12 - 8 - 5(custosAdicionais/fixedFee) - 30(custo) = 40
    assert.strictEqual(res.corpo.resultado.profit, 40, JSON.stringify(res.corpo));
    ok("override de custo + custos adicionais: custos adicionais usa o mesmo contrato fixedFee do Motor");
  });

  // 4. Cliente sem Base de Custos (custo ausente) e SEM override: não-computável.
  await withMockDb(async () => {
    reset();
    margemHandler = () => ({ itens: [itemFixture({ itemId: "MLB-A", venda: 100, custo: null, imposto: 0.05, comissao: 12, frete: 8 })] });

    const res = fakeRes();
    await ctrl.simularMargem({ params: { itemId: "MLB-A" }, body: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.ok, true);
    assert.strictEqual(res.corpo.resultado.computable, false);
    assert.ok(res.corpo.resultado.missing.includes("cost"));
    ok("sem Base de Custos e sem override: não-computável, custo ausente sinalizado em missing");
  });

  // 5. Mesmo caso, mas com override de custo: passa a ser computável — a
  //    simulação pode suprir o que o Motor sozinho não supre.
  await withMockDb(async () => {
    reset();
    margemHandler = () => ({ itens: [itemFixture({ itemId: "MLB-A", venda: 100, custo: null, imposto: 0.05, comissao: 12, frete: 8 })] });

    const res = fakeRes();
    await ctrl.simularMargem(
      { params: { itemId: "MLB-A" }, body: { clienteSlug: "cliente-a", custoProduto: 40 } },
      res
    );

    assert.strictEqual(res.corpo.resultado.computable, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.resultado.profit, 35);
    ok("override de custo supre a ausência de Base de Custos e torna a simulação computável");
  });

  // 6. Margem LOSS: resultado negativo é válido, não é erro.
  await withMockDb(async () => {
    reset();
    margemHandler = () => ({ itens: [itemFixture({ itemId: "MLB-A", venda: 50, custo: 40, imposto: 0.05, comissao: 12, frete: 8 })] });

    const res = fakeRes();
    await ctrl.simularMargem({ params: { itemId: "MLB-A" }, body: { clienteSlug: "cliente-a" } }, res);

    // lucro = 50 - 2.5 - 12 - 8 - 40 = -12.5
    assert.strictEqual(res.corpo.resultado.computable, true);
    assert.strictEqual(res.corpo.resultado.profit, -12.5);
    assert.ok(res.corpo.resultado.marginPercent < 0);
    ok("margem negativa (LOSS): computable=true, profit negativo — resultado válido, não um erro");
  });

  // 6b. subsidioMl (retorno ML da promoção selecionada): soma ao lucro sem
  //     alterar comissão/frete/imposto/custo — mesmo motor, sem fórmula paralela.
  await withMockDb(async () => {
    reset();
    margemHandler = () => ({ itens: [itemFixture({ itemId: "MLB-A", venda: 112.42, custo: 40, imposto: 0.05, comissao: 12, frete: 8 })] });

    const res = fakeRes();
    await ctrl.simularMargem(
      { params: { itemId: "MLB-A" }, body: { clienteSlug: "cliente-a", subsidioMl: 1.35 } },
      res
    );

    // lucro = 112.42 - 112.42*0.05 - 12 - 8 - 40 + 1.35 = 48.149
    assert.strictEqual(res.corpo.resultado.computable, true, JSON.stringify(res.corpo));
    assert.ok(Math.abs(res.corpo.resultado.profit - 48.15) < 0.01, `profit inesperado: ${res.corpo.resultado.profit}`);
    ok("subsidioMl informado: soma ao lucro (mesmo Motor, campo rebate do computeMargin)");
  });

  // 6c. Sem subsidioMl: comportamento atual preservado (rebate=0, igual ao teste 1).
  await withMockDb(async () => {
    reset();
    margemHandler = () => ({ itens: [itemFixture({ itemId: "MLB-A", venda: 100, custo: 40, imposto: 0.05, comissao: 12, frete: 8 })] });

    const res = fakeRes();
    await ctrl.simularMargem({ params: { itemId: "MLB-A" }, body: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.resultado.profit, 35, "sem subsidioMl, resultado idêntico ao cenário sem overrides");
    ok("sem subsidioMl: resultado idêntico ao comportamento anterior (nenhum rebate aplicado)");
  });

  // 6d. subsidioMl inválido (negativo): 400 sem chamar o Motor.
  await withMockDb(async () => {
    reset();
    const res = fakeRes();
    await ctrl.simularMargem(
      { params: { itemId: "MLB-A" }, body: { clienteSlug: "cliente-a", subsidioMl: -1 } },
      res
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(chamadasMargem.length, 0, "subsidioMl inválido não pode gastar chamada ao Motor");
    ok("subsidioMl negativo: 400 sem chamar o Motor de Margem");
  });

  // 7. Item não encontrado no Motor: 404.
  await withMockDb(async () => {
    reset();
    margemHandler = () => ({ itens: [] });

    const res = fakeRes();
    await ctrl.simularMargem({ params: { itemId: "MLB-INEXISTENTE" }, body: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.statusCode, 404);
    ok("item não encontrado no Motor de Margem: 404");
  });

  // 8. clienteSlug ausente: 400 sem chamar o Motor.
  await withMockDb(async () => {
    reset();
    const res = fakeRes();
    await ctrl.simularMargem({ params: { itemId: "MLB-A" }, body: {} }, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(chamadasMargem.length, 0);
    ok("clienteSlug ausente: 400 sem chamar o Motor de Margem");
  });

  // 9. Contexto do Motor não-pronto: mensagem real, nunca 500.
  await withMockDb(async () => {
    reset();
    margemHandler = () => {
      const err = new Error("Base de custos MELI não vinculada.");
      err.statusCode = 424;
      err.payload = { ok: false, codigo: "BASE_MELI_NAO_VINCULADA", erro: "Base de custos MELI não vinculada." };
      throw err;
    };

    const res = fakeRes();
    await ctrl.simularMargem({ params: { itemId: "MLB-A" }, body: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.statusCode, 424, "contexto não-pronto não pode virar 500");
    assert.strictEqual(res.corpo.codigo, "BASE_MELI_NAO_VINCULADA");
    assert.match(res.corpo.motivo, /não vinculada/);
    ok("contexto do Motor não-pronto: mensagem real do erro tipado, nunca 500 genérico");
  });

  // 10. Overrides inválidos (não numéricos, negativos): 400 sem chamar o Motor.
  await withMockDb(async () => {
    reset();
    const res = fakeRes();
    await ctrl.simularMargem(
      { params: { itemId: "MLB-A" }, body: { clienteSlug: "cliente-a", preco: -10 } },
      res
    );
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(chamadasMargem.length, 0, "override inválido não pode gastar chamada ao Motor");
    ok("override de preço negativo: 400 sem chamar o Motor de Margem");
  });
}

run()
  .then(() => {
    console.log(`\n✓ ${checks} verificações de simulação de margem (Anúncios ML)`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n✗ FALHOU:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
