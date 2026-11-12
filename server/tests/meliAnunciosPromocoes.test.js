// server/tests/meliAnunciosPromocoes.test.js
//
// Promoções oficiais do item (GET /anuncios-meli/:itemId/promocoes), para o
// bloco "Promoções disponíveis" do modal de detalhe.
//
// Regras protegidas por este teste:
//
//  1. read-only de ponta a ponta: o endpoint só faz GET /seller-promotions/
//     items/{id} — nunca POST/PUT/DELETE (nunca inscreve o item, nunca grava
//     preço). Nenhum teste aqui deve produzir uma chamada de escrita.
//  2. nunca inventa desconto: candidate sem suggested_discounted_price vira
//     precoFinal=null (não cai para original_price nem para 0); started/
//     pending com price<=0 (candidato "cru" devolvido com price:0) também
//     vira precoFinal=null.
//  3. ordenação reaproveita escolherPromocao (mesma função da tela
//     "Promoções com Retorno ML") — ativa/agendada primeiro, maior
//     meli_percentage antes, nunca uma heurística nova.
//  4. a conta ML usada na chamada ao Mercado Livre é a da própria linha do
//     anúncio (mesma regra dos vizinhos GET /:itemId e /variacoes-legado).

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const Module = require("module");

// ── stub do cliente ML ──────────────────────────────────────────────────────
let mlChamadas = [];
let mlHandler = null;
let cotacaoChamadas = [];
const COTACAO_PADRAO = (chamada) => (String(chamada.path).includes("listing_prices")
  ? { ok: true, status: 200, data: { sale_fee_amount: 12, sale_fee_details: { percentage_fee: 12 } } }
  : { ok: true, status: 200, data: { coverage: { all_country: { list_cost: 8, discount: { type: "mandatory", rate: 0.5 } } } } });
let cotacaoHandler = COTACAO_PADRAO;

// ── stub do Motor de Margem — mesmo padrão de meliAnunciosSimularMargem.
// test.js: evita que "Você recebe" dispare I/O real (banco/ML) por baixo do
// motorMargemService; controla por teste só o que cada cenário precisa.
// Default (margemHandler null) = { itens: [] }, ou seja "Motor sem dado
// nenhum pro item" — voceRecebe fica null em todos os testes que não setam
// margemHandler, sem gerar nenhuma chamada extra ao Mercado Livre (o que
// quebraria a asserção read-only do teste 5, que audita mlChamadas).
let margemHandler = null;
let chamadasMargem = [];

const originalLoad = Module._load;
Module._load = function loadWithMlFetchStub(request, parent, isMain) {
  if (request === "../../utils/mlClient" || request === "../utils/mlClient") {
    return {
      async mlFetch(clienteId, path, options = {}) {
        const chamada = { clienteId, path, metodo: options.method || "GET", mlUserId: options.mlUserId };
        // P0 12/11/2026: "Você recebe" cota comissão/frete NO PREÇO DA PROMOÇÃO
        // (listing_prices + shipping_options). Ficam numa lista própria para não
        // mudar as auditorias de chamadas das promoções; padrão: 12 e 8 em qualquer preço.
        if (/\/sites\/MLB\/listing_prices|\/shipping_options\/free/.test(String(path))) {
          cotacaoChamadas.push(chamada);
          return cotacaoHandler(chamada);
        }
        mlChamadas.push(chamada);
        return mlHandler ? mlHandler(chamada) : { ok: true, status: 200, data: [] };
      },
    };
  }
  if (request === "../services/motorMargem/motorMargemService") {
    return {
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
const promocoesService = require("../services/meliAnuncios/meliPromocoesService");

Module._load = originalLoad;

// ── fixtures (mesmo padrão de meliAnunciosPreco.test.js) ───────────────────

const cliente = { id: 1, nome: "Cliente A", slug: "cliente-a", ativo: true };

function anunciosFixture() {
  return [
    {
      id: 7, cliente_id: 1, cliente_slug: "cliente-a", item_id: "MLB-X",
      titulo: "Camiseta Azul P", preco: 100, preco_original: 100,
      cliente_conta_id: 10, ml_user_id: "111",
      listing_type_id: "gold_special", category_id: "MLB1", logistic_type: "cross_docking",
    },
  ];
}

// Mesmo shape de item que o Motor de Margem produz (ver meliAnunciosSimularMargem.test.js).
function evid(valor) {
  return valor == null ? null : { value: valor };
}
function itemFixtureMotor({ itemId, venda, custo, imposto, comissao, frete }) {
  return {
    identity: { itemId },
    pricing: { current: evid(venda), sold: evid(venda) },
    costs: {
      cost: { projected: evid(custo), realized: evid(custo) },
      taxRate: { projected: evid(imposto), realized: evid(imposto) },
      fixedFee: { projected: evid(0), realized: null },
    },
    marketplaceCosts: {
      commissionProjected: evid(comissao), commissionRealized: evid(comissao),
      freightProjected: evid(frete), freightRealized: evid(frete),
    },
  };
}

class MockDb {
  constructor({ anuncios = [] } = {}) {
    this.anuncios = anuncios;
  }
  async connect() { return { query: (sql, params) => this.query(sql, params), release() {} }; }
  async query(sql, params = []) {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (q.includes("FROM clientes WHERE LOWER(slug) = $1")) {
      return { rows: cliente.slug === params[0] ? [cliente] : [] };
    }
    if (q.startsWith("SELECT * FROM meli_anuncios WHERE cliente_id = $1 AND item_id = $2")) {
      const row = this.anuncios.find((a) => a.cliente_id === params[0] && a.item_id === String(params[1]));
      return { rows: row ? [row] : [] };
    }
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
  return Promise.resolve().then(() => fn(db)).finally(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
  });
}

function fakeRes() {
  return {
    statusCode: 200, corpo: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.corpo = obj; return this; },
  };
}

let checks = 0;
function ok(msg) { checks += 1; console.log(`  ✓ ${msg}`); }

async function run() {
  // 1. Promoção ATIVA (started): desconto real calculado, preço da resposta.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = () => ({
      ok: true, status: 200,
      data: [{ id: "P-1", type: "DEAL", status: "started", price: 134.9, original_price: 149.9, name: "HOTSALE" }],
    });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.promocoes.length, 1);
    const linha = res.corpo.promocoes[0];
    assert.strictEqual(linha.status, "started");
    assert.strictEqual(linha.statusLabel, "ATIVA");
    assert.strictEqual(linha.precoFinal, 134.9);
    assert.strictEqual(linha.precoOriginal, 149.9);
    assert.strictEqual(linha.descontoReais, 15);
    assert.ok(Math.abs(linha.descontoPercentual - 10.01) < 0.1, `desconto% inesperado: ${linha.descontoPercentual}`);
    assert.strictEqual(linha.editavelPrecoFinal, true);
    ok("promoção ativa: desconto real calculado a partir do price/original_price do ML");
  });

  // 2. CANDIDATE com sugestão: precoFinal = suggested_discounted_price (nunca
  //    o price bruto, que vem 0 nesse status).
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = () => ({
      ok: true, status: 200,
      data: [{
        type: "PRICE_DISCOUNT", status: "candidate", price: 0, original_price: 149.9,
        suggested_discounted_price: 134.9, min_discounted_price: 120, max_discounted_price: 145,
      }],
    });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    const linha = res.corpo.promocoes[0];
    assert.strictEqual(linha.status, "candidate");
    assert.strictEqual(linha.statusLabel, "ELEGÍVEL");
    assert.strictEqual(linha.precoFinal, 134.9, "candidate usa suggested_discounted_price, nunca o price bruto (0)");
    assert.strictEqual(linha.descontoReais, 15);
    ok("candidate com sugestão do ML: preço final vem de suggested_discounted_price");
  });

  // 3. CANDIDATE SEM sugestão: nunca inventar desconto.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = () => ({
      ok: true, status: 200,
      data: [{ type: "PRICE_DISCOUNT", status: "candidate", price: 0, original_price: 149.9 }],
    });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    const linha = res.corpo.promocoes[0];
    assert.strictEqual(linha.precoFinal, null, "sem suggested_discounted_price, precoFinal não pode ser inventado");
    assert.strictEqual(linha.descontoReais, null);
    assert.strictEqual(linha.descontoPercentual, null);
    assert.strictEqual(linha.editavelPrecoFinal, true, "célula continua editável como simulação, mesmo sem sugestão do ML");
    ok("candidate sem sugestão do ML: precoFinal/desconto ficam null, nunca um cálculo próprio");
  });

  // 4. MÚLTIPLAS promoções: ordenação reaproveita escolherPromocao (ativa
  //    primeiro, maior meli_percentage antes) — sem esconder as demais.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = () => ({
      ok: true, status: 200,
      data: [
        { type: "PRICE_DISCOUNT", status: "candidate", price: 0, original_price: 100, suggested_discounted_price: 90 },
        { id: "P-2", type: "DEAL", status: "started", price: 82, original_price: 100, meli_percentage: 3 },
        { id: "P-3", type: "PRE_NEGOTIATED", status: "started", price: 80, original_price: 100, meli_percentage: 8 },
      ],
    });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.promocoes.length, 3, "as três promoções devem aparecer — nunca esconder atrás de uma só");
    assert.strictEqual(res.corpo.promocoes[0].id, "P-3", "ativa com maior meli_percentage vem primeiro");
    assert.strictEqual(res.corpo.promocoes[1].id, "P-2", "ativa com menor meli_percentage vem em seguida");
    assert.strictEqual(res.corpo.promocoes[2].status, "candidate", "candidate fica por último, depois das ativas");
    ok("múltiplas promoções: todas aparecem, ordenadas por prioridade (ativa > candidate, maior retorno ML antes)");
  });

  // 5. Read-only: nenhuma chamada de escrita é feita (só GET).
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = () => ({ ok: true, status: 200, data: [{ type: "DEAL", status: "started", price: 90, original_price: 100 }] });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.ok, true);
    assert.ok(mlChamadas.length >= 1, "esperava pelo menos uma chamada ao Mercado Livre");
    assert.ok(mlChamadas.every((c) => c.metodo === "GET"), "o endpoint de promoções nunca pode fazer POST/PUT/DELETE");
    assert.ok(
      mlChamadas.every((c) => /seller-promotions\/items\//.test(c.path) || /\/sale_price/.test(c.path)),
      "só pode chamar /seller-promotions/items/{id} e /items/{id}/sale_price (fonte da promoção ATIVA)"
    );
    assert.ok(mlChamadas.every((c) => c.mlUserId === "111"), "a conta ML usada é a da própria linha do anúncio, nas duas chamadas");
    ok("read-only: só GET /seller-promotions/items/{id} e /items/{id}/sale_price, usando a conta ML da linha do anúncio");
  });

  // 6. ML sem promoção nenhuma para o item: lista vazia, sem quebrar.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = () => ({ ok: true, status: 200, data: [] });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.ok, true);
    assert.deepStrictEqual(res.corpo.promocoes, []);
    ok("sem promoção nenhuma: lista vazia, sem erro");
  });

  // 7. Falha do Mercado Livre ao consultar: não derruba a tela, devolve vazio.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = () => ({ ok: false, status: 500, data: { message: "erro" } });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.ok, true, "falha ao consultar promoções não pode derrubar o endpoint inteiro");
    assert.deepStrictEqual(res.corpo.promocoes, []);
    ok("falha do Mercado Livre ao consultar promoções: devolve lista vazia, sem quebrar a resposta");
  });

  // 8. clienteSlug ausente e anúncio inexistente: 400/404 sem chamar o ML.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: {} }, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(mlChamadas.length, 0);

    const res2 = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-NAOEXISTE" }, query: { clienteSlug: "cliente-a" } }, res2);
    assert.strictEqual(res2.statusCode, 404);
    assert.strictEqual(mlChamadas.length, 0);
    ok("clienteSlug ausente é 400 e anúncio inexistente é 404, sem chamada ao Mercado Livre");
  });

  // 9. Normalizador direto — casos de borda.
  assert.strictEqual(promocoesService.normalizarPromocao({ status: "started", price: 0, original_price: 100 }, 0).precoFinal, null,
    "started com price 0 não é preço real");
  assert.strictEqual(promocoesService.normalizarPromocao({ status: "pending", price: 50, original_price: 100 }, 0).statusLabel, "AGENDADA");
  assert.strictEqual(promocoesService.rotuloTipoPromocao("DOD"), "Oferta do dia");
  assert.strictEqual(promocoesService.rotuloTipoPromocao("TIPO_DESCONHECIDO"), "TIPO_DESCONHECIDO");
  ok("normalizarPromocao: started com price=0 não vira preço real; statusLabel e rótulo de tipo corretos");

  // 10. subsidioMl — fórmula validada (auditoria de promocoesRetornoService.js,
  //     tela "Promoções com Retorno ML"): original_price * (meli_percentage/100).
  //     Caso real confirmado: item MLB4147165927, promoção "Impulsione suas
  //     vendas" (SMART), original_price=119.90, meli_percentage=0.5 →
  //     0.5995 → R$0,60, a 1 centavo do "Reduzimos R$0,61" mostrado pelo ML
  //     (diferença compatível com a precisão de 1 casa decimal da API).
  {
    const linha = promocoesService.normalizarPromocao(
      { status: "started", price: 110.48, original_price: 119.9, meli_percentage: 0.5 }, 0
    );
    assert.ok(Math.abs(linha.subsidioMl - 0.5995) < 0.01, `subsidioMl esperado ≈0.60, veio ${linha.subsidioMl}`);
    assert.strictEqual(linha.subsidioMl, 0.6, "arredondado para 2 casas, igual ao formato de moeda exibido");
  }
  ok("subsidioMl: fórmula original_price*(meli_percentage/100) — caso real MLB4147165927 dá ≈R$0,60, a 1 centavo do R$0,61 do ML");

  // 11. subsidioMl null quando falta meli_percentage — nunca inventa a
  //     partir de outro campo.
  {
    const linha = promocoesService.normalizarPromocao(
      { status: "started", price: 82, original_price: 100 }, 0
    );
    assert.strictEqual(linha.subsidioMl, null, "sem meli_percentage, subsidioMl fica null (UI mostra —)");
  }
  ok("subsidioMl: null quando a promoção não tem meli_percentage");

  // 12. subsidioMl null quando falta original_price (mesmo com meli_percentage
  //     presente) — os DOIS campos são exigidos, nunca um cálculo parcial.
  {
    const linha = promocoesService.normalizarPromocao(
      { status: "started", price: 82, meli_percentage: 3 }, 0
    );
    assert.strictEqual(linha.subsidioMl, null, "sem original_price, subsidioMl fica null mesmo com meli_percentage presente");
  }
  ok("subsidioMl: null quando falta original_price, mesmo com meli_percentage presente");

  // 13. subsidioMl NUNCA usa seller_percentage — nem como fonte alternativa,
  //     nem somado ao meli_percentage.
  {
    const soSeller = promocoesService.normalizarPromocao(
      { status: "started", price: 80, original_price: 100, seller_percentage: 30 }, 0
    );
    assert.strictEqual(soSeller.subsidioMl, null, "só seller_percentage (sem meli_percentage) nunca calcula subsídio");

    const ambos = promocoesService.normalizarPromocao(
      { status: "started", price: 80, original_price: 100, meli_percentage: 3, seller_percentage: 30 }, 0
    );
    assert.strictEqual(ambos.subsidioMl, 3, "usa só meli_percentage (100*0.03=3) — nunca soma com seller_percentage (que daria 33)");
  }
  ok("subsidioMl: nunca usa seller_percentage como fonte nem soma com meli_percentage");

  // 13b. discount_meli_boost_amount/boosted_offer/benefits NUNCA mais
  //      alimentam subsidioMl (fonte trocada pela auditoria) — mesmo
  //      presentes, são ignorados.
  {
    const linha = promocoesService.normalizarPromocao(
      {
        status: "started", price: 110.48, original_price: 119.9, meli_percentage: 0.5,
        boosted_offer: true, discount_meli_boost_amount: 999, benefits: { type: "REBATE", meli_percent: 999 },
      }, 0
    );
    assert.strictEqual(linha.subsidioMl, 0.6, "discount_meli_boost_amount/boosted_offer/benefits são ignorados, mesmo presentes");
  }
  ok("subsidioMl: discount_meli_boost_amount/boosted_offer/benefits nunca mais são a fonte, mesmo presentes no payload");

  // 14. statusExibicao — casamento por id: só a promoção cujo id bate com o
  //     promotion_id do sale_price vira ATIVA; outra started vira NÃO APLICADA.
  {
    const ativa = promocoesService.normalizarPromocao({ id: "123", status: "started" }, 0, "123");
    const naoAplicada = promocoesService.normalizarPromocao({ id: "456", status: "started" }, 1, "123");
    assert.strictEqual(ativa.statusExibicao, "ATIVA", "id bate com sale_price.metadata.promotion_id");
    assert.strictEqual(naoAplicada.statusExibicao, "NÃO APLICADA", "started que não bate com o promotion_id não pode ser ATIVA");
  }
  ok("statusExibicao: só a promoção cujo id casa com promotion_id vira ATIVA; as demais started viram NÃO APLICADA");

  // 15. statusExibicao — casamento por ref_id, quando a promoção não expõe id.
  {
    const ativa = promocoesService.normalizarPromocao({ ref_id: "abc", status: "started" }, 0, "abc");
    assert.strictEqual(ativa.statusExibicao, "ATIVA", "casamento também funciona por ref_id");
  }
  ok("statusExibicao: casamento por ref_id (quando a promoção não tem id) também identifica a ATIVA");

  // 16. statusExibicao — sem promotion_id (sale_price sem metadata ou falhou):
  //     nenhuma promoção started pode virar ATIVA por eliminação.
  {
    const linha1 = promocoesService.normalizarPromocao({ id: "123", status: "started" }, 0, null);
    const linha2 = promocoesService.normalizarPromocao({ ref_id: "abc", status: "started" }, 1, null);
    assert.strictEqual(linha1.statusExibicao, "NÃO APLICADA");
    assert.strictEqual(linha2.statusExibicao, "NÃO APLICADA");
  }
  ok("statusExibicao: sem promotion_id, nenhuma promoção started vira ATIVA — nunca por eliminação/heurística");

  // 17. statusExibicao — pending e candidate seguem vocabulário próprio,
  //     independente de promotion_id.
  {
    const agendada = promocoesService.normalizarPromocao({ status: "pending" }, 0, "qualquer");
    const elegivel = promocoesService.normalizarPromocao({ status: "candidate" }, 0, "qualquer");
    assert.strictEqual(agendada.statusExibicao, "PROGRAMADA");
    assert.strictEqual(elegivel.statusExibicao, "ELEGÍVEL");
  }
  ok("statusExibicao: pending vira PROGRAMADA e candidate vira ELEGÍVEL, sempre — não dependem de promotion_id");

  // 17b. Oferta relâmpago formando o preço AINDA `pending` na listagem —
  //      payload real (Red Fish, MLB7337265348, 15/10/2026): sale_price
  //      amount 112,81 com promotion_id = ref_id da SMART_LIGHTNING pending.
  //      Casamento pelo ref_id (exclusivo da oferta) → ATIVA, com o rebate.
  {
    const relampago = promocoesService.normalizarPromocao(
      {
        id: "P-MLB18055120", type: "SMART_LIGHTNING", ref_id: "OFFER-MLB7337265348-14075355025",
        status: "pending", price: 112.81, meli_percentage: 5, seller_percentage: 19.3, original_price: 149,
      },
      0,
      "OFFER-MLB7337265348-14075355025"
    );
    assert.strictEqual(relampago.statusExibicao, "ATIVA");
    assert.strictEqual(relampago.subsidioMl, 7.45);
    const outraOferta = promocoesService.normalizarPromocao(
      { id: "P-1", type: "SMART_LIGHTNING", ref_id: "OFFER-MLB7337265348-1", status: "pending", price: 110 },
      0,
      "OFFER-MLB7337265348-14075355025"
    );
    assert.strictEqual(outraOferta.statusExibicao, "PROGRAMADA");
  }
  ok("statusExibicao: pending apontada pelo sale_price via ref_id (relâmpago no ar) vira ATIVA; outra oferta pending segue PROGRAMADA");

  // 17c. obterRebatePromocaoAtiva (margem da LISTA): mesma ATIVA do modal,
  //      só as duas leituras que a decidem (sem vigência), read-only.
  {
    mlChamadas = [];
    mlHandler = ({ path }) => {
      if (path.includes("/sale_price")) {
        return { ok: true, status: 200, data: { amount: 112.81, regular_amount: 149, metadata: { promotion_id: "OFFER-MLB7337265348-14075355025" } } };
      }
      return {
        ok: true, status: 200, data: [
          { id: "C-MLB5771741", type: "SELLER_CAMPAIGN", status: "started", price: 119.9, original_price: 149, name: "Vendex - Outubro" },
          { id: "P-MLB17937078", type: "SMART", ref_id: "OFFER-MLB7337265348-14028184124", status: "started", price: 116.3, meli_percentage: 3.1, seller_percentage: 18.8, original_price: 149, name: "Impulsione suas vendas" },
          { id: "P-MLB18055120", type: "SMART_LIGHTNING", ref_id: "OFFER-MLB7337265348-14075355025", status: "pending", price: 112.81, meli_percentage: 5, seller_percentage: 19.3, original_price: 149, name: "OFERTAS RELÂMPAGOS IMPERDÍVEIS" },
        ],
      };
    };
    const r = await promocoesService.obterRebatePromocaoAtiva({ clienteId: 1, itemId: "MLB7337265348", mlUserId: "111" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.rebate, 7.45);
    assert.strictEqual(r.promocao.nome, "OFERTAS RELÂMPAGOS IMPERDÍVEIS");
    assert.strictEqual(mlChamadas.length, 2, "só seller-promotions + sale_price — nenhuma leitura de vigência");
    assert.ok(mlChamadas.every((c) => c.metodo === "GET"));

    // sale_price já lido pelo Motor (saleInfo): UMA chamada, mesmo resultado.
    mlChamadas = [];
    const comSale = await promocoesService.obterRebatePromocaoAtiva({
      clienteId: 1, itemId: "MLB7337265348", mlUserId: "111",
      saleInfo: { promotionId: "OFFER-MLB7337265348-14075355025", amount: 112.81 },
    });
    assert.strictEqual(comSale.rebate, 7.45);
    assert.deepStrictEqual(mlChamadas.map((c) => c.path.split("?")[0]), ["/seller-promotions/items/MLB7337265348"]);

    mlHandler = () => ({ ok: false, status: 429, data: null });
    const falha = await promocoesService.obterRebatePromocaoAtiva({ clienteId: 1, itemId: "MLB7337265348", mlUserId: "111" });
    assert.deepStrictEqual(falha, { ok: false, rebate: null, promocao: null });
    mlHandler = null;
  }
  ok("obterRebatePromocaoAtiva: rebate da ATIVA (relâmpago pending) com 2 GETs; falha do ML vira ok:false, nunca rebate 0");

  // 18. Fluxo completo via controller: /seller-promotions/items e /sale_price
  //     rodam em paralelo; só a promoção apontada por metadata.promotion_id
  //     vira ATIVA, a outra started vira NÃO APLICADA.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) {
        return { ok: true, status: 200, data: { amount: 80, regular_amount: 100, metadata: { promotion_id: "P-3" } } };
      }
      return {
        ok: true, status: 200,
        data: [
          { id: "P-2", type: "DEAL", status: "started", price: 82, original_price: 100, meli_percentage: 3, discount_meli_boost_amount: 1.2 },
          { id: "P-3", type: "PRE_NEGOTIATED", status: "started", price: 80, original_price: 100, meli_percentage: 8, discount_meli_boost_amount: 0.61 },
        ],
      };
    };

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    const porId = {};
    res.corpo.promocoes.forEach((p) => { porId[p.id] = p; });
    assert.strictEqual(porId["P-3"].statusExibicao, "ATIVA", "P-3 é a que o sale_price aponta — só ela vira ATIVA");
    assert.strictEqual(porId["P-2"].statusExibicao, "NÃO APLICADA", "P-2 está started mas não define o preço atual");
    // subsidioMl = original_price*(meli_percentage/100) — 100*8/100=8, 100*3/100=3.
    // discount_meli_boost_amount (0.61/1.2) fica no fixture só pra provar que é ignorado.
    assert.strictEqual(porId["P-3"].subsidioMl, 8, "100*(8/100)=8 — discount_meli_boost_amount (0.61) é ignorado");
    assert.strictEqual(porId["P-2"].subsidioMl, 3, "100*(3/100)=3 — discount_meli_boost_amount (1.2) é ignorado");
    assert.ok(mlChamadas.some((c) => /seller-promotions\/items\//.test(c.path)), "precisa ter chamado /seller-promotions/items/{id}");
    assert.ok(mlChamadas.some((c) => /\/sale_price/.test(c.path)), "precisa ter chamado /items/{id}/sale_price em paralelo");
    assert.ok(mlChamadas.every((c) => c.metodo === "GET"), "as duas chamadas continuam GET, nunca escrita");
    ok("fluxo completo: /sale_price roda em paralelo com /seller-promotions/items e decide qual promoção é ATIVA");
  });

  // 19b. Enriquecimento de vigência: promoção chega SEM start_date/finish_date
  //      do endpoint principal, mas tem id+type — busca em
  //      /seller-promotions/promotions/{id}?promotion_type={tipo} e preenche
  //      inicio/fim com o que essa segunda chamada devolver.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: {} };
      if (/seller-promotions\/promotions\//.test(chamada.path)) {
        assert.ok(/\/seller-promotions\/promotions\/P-9/.test(chamada.path), "precisa consultar pelo promotion_id certo");
        assert.ok(/promotion_type=SMART/.test(chamada.path), "precisa mandar promotion_type na consulta de detalhe");
        return {
          ok: true, status: 200,
          data: { id: "P-9", type: "SMART", status: "started", start_date: "2026-04-22T01:00:00Z", finish_date: "2026-05-22T01:00:00Z" },
        };
      }
      return {
        ok: true, status: 200,
        data: [{ id: "P-9", type: "SMART", status: "started", price: 80, original_price: 100 }],
      };
    };

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    const linha = res.corpo.promocoes[0];
    assert.strictEqual(linha.inicio, "2026-04-22T01:00:00Z", "vigência enriquecida via /seller-promotions/promotions/{id}");
    assert.strictEqual(linha.fim, "2026-05-22T01:00:00Z");
    assert.ok(
      mlChamadas.some((c) => /seller-promotions\/promotions\/P-9/.test(c.path)),
      "precisa ter chamado o detalhe da campanha para a promoção sem data"
    );
    ok("enriquecimento de vigência: promoção SMART sem data no endpoint principal recebe inicio/fim do detalhe da campanha");
  });

  // 19c. Enriquecimento falha (ok:false ou exceção) — não derruba a
  //      listagem; a promoção continua com inicio/fim null, nunca inventado.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: {} };
      if (/seller-promotions\/promotions\//.test(chamada.path)) {
        return { ok: false, status: 500, data: { message: "erro" } };
      }
      return {
        ok: true, status: 200,
        data: [{ id: "P-9", type: "SMART", status: "started", price: 80, original_price: 100 }],
      };
    };

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.ok, true, "falha no enriquecimento não pode derrubar a listagem inteira");
    const linha = res.corpo.promocoes[0];
    assert.strictEqual(linha.inicio, null, "sem detalhe disponível, inicio continua null (nunca inventado)");
    assert.strictEqual(linha.fim, null, "sem detalhe disponível, fim continua null (nunca inventado)");
    ok("enriquecimento de vigência: falha (ok:false) do detalhe da campanha não derruba a listagem, inicio/fim seguem null");
  });

  // 19d. Enriquecimento lança exceção (ex.: erro de rede) — mesma garantia
  //      de resiliência, via try/catch.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: {} };
      if (/seller-promotions\/promotions\//.test(chamada.path)) throw new Error("timeout");
      return {
        ok: true, status: 200,
        data: [{ id: "P-9", type: "SMART", status: "started", price: 80, original_price: 100 }],
      };
    };

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.ok, true, "exceção no enriquecimento não pode derrubar a listagem inteira");
    assert.strictEqual(res.corpo.promocoes[0].inicio, null);
    ok("enriquecimento de vigência: exceção de rede no detalhe da campanha não derruba a listagem");
  });

  // 19e. Promoção que já veio com start_date/finish_date do endpoint
  //      principal NÃO dispara a chamada extra de enriquecimento.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: {} };
      return {
        ok: true, status: 200,
        data: [{
          id: "P-9", type: "DEAL", status: "started", price: 80, original_price: 100,
          start_date: "2026-01-01T00:00:00Z", finish_date: "2026-01-31T23:59:59Z",
        }],
      };
    };

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.promocoes[0].inicio, "2026-01-01T00:00:00Z");
    assert.strictEqual(res.corpo.promocoes[0].fim, "2026-01-31T23:59:59Z");
    assert.ok(
      !mlChamadas.some((c) => /seller-promotions\/promotions\//.test(c.path)),
      "promoção que já tem data não pode disparar a chamada extra de enriquecimento"
    );
    ok("enriquecimento de vigência: promoção que já tem start_date/finish_date não faz chamada extra");
  });

  // 19f. Sem promotion_id (id ausente) ou sem type: nunca tenta enriquecer
  //      (não há como montar a consulta de detalhe da campanha).
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: {} };
      return {
        ok: true, status: 200,
        data: [{ type: "PRICE_DISCOUNT", status: "candidate", price: 0, original_price: 100, suggested_discounted_price: 90 }],
      };
    };

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.promocoes[0].inicio, null);
    assert.ok(
      !mlChamadas.some((c) => /seller-promotions\/promotions\//.test(c.path)),
      "sem id de promoção não há como montar a consulta de detalhe — não deve nem tentar"
    );
    ok("enriquecimento de vigência: promoção sem id não dispara tentativa de enriquecimento");
  });

  // 19h. Promoção sem `id` (campanha) mas com `ref_id` (oferta/candidato):
  //      fallback defensivo usa ref_id como promotion_id — nenhum caso
  //      documentado do ML faz isso sozinho (ref_id sempre vem junto de id
  //      nos exemplos oficiais), mas o fallback é seguro: se o ref_id não
  //      servir como promotion_id, o ML só devolve erro/ok:false, que já é
  //      tratado sem quebrar a listagem.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: {} };
      if (/seller-promotions\/promotions\//.test(chamada.path)) {
        assert.ok(/\/seller-promotions\/promotions\/OFFER-MLB1-999/.test(chamada.path), "precisa usar o ref_id quando não há id");
        return { ok: true, status: 200, data: { start_date: "2026-02-01T00:00:00Z", finish_date: "2026-02-10T00:00:00Z" } };
      }
      return {
        ok: true, status: 200,
        data: [{ ref_id: "OFFER-MLB1-999", type: "SMART", status: "started", price: 80, original_price: 100 }],
      };
    };

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.promocoes[0].inicio, "2026-02-01T00:00:00Z", "fallback por ref_id preenche a vigência quando não há id");
    assert.strictEqual(res.corpo.promocoes[0].fim, "2026-02-10T00:00:00Z");
    ok("enriquecimento de vigência: sem id, cai para ref_id como promotion_id (fallback defensivo)");
  });

  // 19i. Deduplicação: duas promoções diferentes (mesmo id+type) sem data —
  //      só UMA chamada a /seller-promotions/promotions/{id}, e as DUAS
  //      recebem a mesma vigência. Nunca cache persistente — só dentro
  //      desta execução de listarPromocoesDoItem.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    let chamadasDetalhe = 0;
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: {} };
      if (/seller-promotions\/promotions\//.test(chamada.path)) {
        chamadasDetalhe += 1;
        return { ok: true, status: 200, data: { start_date: "2026-03-01T00:00:00Z", finish_date: "2026-03-10T00:00:00Z" } };
      }
      return {
        ok: true, status: 200,
        data: [
          { id: "P-9", type: "SMART", status: "started", price: 80, original_price: 100 },
          { id: "P-9", type: "SMART", status: "pending", price: 82, original_price: 100 },
        ],
      };
    };

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(chamadasDetalhe, 1, "mesmo id+type entre duas promoções deve gerar só UMA chamada de detalhe");
    assert.ok(res.corpo.promocoes.every((p) => p.inicio === "2026-03-01T00:00:00Z"), "as duas promoções recebem a mesma vigência deduplicada");
    ok("enriquecimento de vigência: duas promoções com o mesmo id+type deduplicam em uma única chamada ao detalhe da campanha");
  });

  // 19. Fallback: sale_price sem metadata/promotion_id — nenhuma promoção
  //     vira ATIVA, mesmo com duas started (nunca inferir pelo menor preço).
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: {} };
      return {
        ok: true, status: 200,
        data: [
          { id: "P-2", type: "DEAL", status: "started", price: 82, original_price: 100 },
          { id: "P-3", type: "PRE_NEGOTIATED", status: "started", price: 80, original_price: 100 },
        ],
      };
    };

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.ok(
      res.corpo.promocoes.every((p) => p.statusExibicao !== "ATIVA"),
      "sem metadata.promotion_id, nenhuma promoção started pode virar ATIVA"
    );
    ok("fallback: sale_price sem metadata.promotion_id — nenhuma promoção vira ATIVA, mesmo com duas started");
  });

  // ── "Você recebe" auto-preenchido (sem clicar em Simular) ─────────────────
  // Ao abrir o modal, cada promoção já vem com voceRecebe calculado usando o
  // MESMO Motor (motorMargemService.montarItens + marginEngine.computeMargin)
  // que .../simular-margem usa — nunca uma fórmula paralela. O botão
  // "Simular" continua existindo só para alterações manuais.

  // 20. Promoção ATIVA com preço final: voceRecebe vem preenchido, sem
  //     precisar de nenhum clique em Simular.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    chamadasMargem = [];
    mlHandler = () => ({
      ok: true, status: 200,
      data: [{ id: "P-1", type: "DEAL", status: "started", price: 82, original_price: 100 }],
    });
    margemHandler = () => ({ itens: [itemFixtureMotor({ itemId: "MLB-X", venda: 100, custo: 40, imposto: 0.05, comissao: 12, frete: 8 })] });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    const linha = res.corpo.promocoes[0];
    // lucro = 82 - 82*0.05 - 12 - 8 - 0 - 40 = 17.9
    assert.ok(linha.voceRecebe, "voceRecebe precisa vir preenchido sem clicar em Simular");
    assert.strictEqual(linha.voceRecebe.computable, true, JSON.stringify(linha.voceRecebe));
    assert.strictEqual(linha.voceRecebe.profit, 17.9);
    assert.strictEqual(chamadasMargem.length, 1, "reaproveita uma única chamada ao Motor pro item, não uma por promoção");
    ok("Você recebe: preenchido automaticamente ao abrir o modal, usando o preço final da promoção e o mesmo Motor");
  });

  // 21. Promoção com subsidioMl: o resultado de margem soma o retorno ML
  //     (mesmo campo `rebate` de computeMargin usado em simular-margem).
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    chamadasMargem = [];
    mlHandler = () => ({
      ok: true, status: 200,
      data: [{ id: "P-1", type: "SMART", status: "started", price: 112.42, original_price: 119.9, meli_percentage: 0.5 }],
    });
    margemHandler = () => ({ itens: [itemFixtureMotor({ itemId: "MLB-X", venda: 112.42, custo: 40, imposto: 0.05, comissao: 12, frete: 8 })] });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    const linha = res.corpo.promocoes[0];
    // subsidioMl = 119.9*(0.5/100) = 0.5995 → 0.6 (arredondado)
    assert.strictEqual(linha.subsidioMl, 0.6);
    // lucro = 112.42 - 112.42*0.05 - 12 - 8 - 40 + 0.6 = 47.399
    assert.ok(Math.abs(linha.voceRecebe.profit - 47.4) < 0.01, `profit inesperado: ${linha.voceRecebe.profit}`);
    ok("Você recebe: com subsidioMl, o cálculo reflete o retorno ML somado ao lucro");
  });

  // 22. Promoção sem rebate (subsidioMl null): voceRecebe calculado sem
  //     nenhum benefício somado — comportamento equivalente a rebate=0.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    chamadasMargem = [];
    mlHandler = () => ({
      ok: true, status: 200,
      data: [{ id: "P-1", type: "DEAL", status: "started", price: 82, original_price: 100 }],
    });
    margemHandler = () => ({ itens: [itemFixtureMotor({ itemId: "MLB-X", venda: 100, custo: 40, imposto: 0.05, comissao: 12, frete: 8 })] });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    const linha = res.corpo.promocoes[0];
    assert.strictEqual(linha.subsidioMl, null, "sem meli_percentage, subsidioMl continua null");
    assert.strictEqual(linha.voceRecebe.profit, 17.9, "sem rebate, resultado idêntico ao cenário sem promoção com retorno ML");
    ok("Você recebe: promoção sem rebate preserva o comportamento atual (nenhum benefício somado)");
  });

  // 23. Candidate sem preço final (precoFinal null): voceRecebe fica null —
  //     nunca inventa um preço pra calcular margem.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    chamadasMargem = [];
    mlHandler = () => ({
      ok: true, status: 200,
      data: [{ type: "PRICE_DISCOUNT", status: "candidate", price: 0, original_price: 100 }],
    });
    margemHandler = () => ({ itens: [itemFixtureMotor({ itemId: "MLB-X", venda: 100, custo: 40, imposto: 0.05, comissao: 12, frete: 8 })] });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.promocoes[0].voceRecebe, null, "sem precoFinal, voceRecebe não pode ser calculado");
    ok("Você recebe: candidate sem preço final (nunca inventado) fica com voceRecebe null");
  });

  // 24. Motor sem custo/Base vinculada: voceRecebe fica não-computável, sem
  //     derrubar a listagem de promoções.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    chamadasMargem = [];
    mlHandler = () => ({
      ok: true, status: 200,
      data: [{ id: "P-1", type: "DEAL", status: "started", price: 82, original_price: 100 }],
    });
    margemHandler = () => ({ itens: [itemFixtureMotor({ itemId: "MLB-X", venda: 100, custo: null, imposto: 0.05, comissao: 12, frete: 8 })] });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.ok, true, "Motor sem custo não pode derrubar a listagem de promoções");
    const linha = res.corpo.promocoes[0];
    assert.ok(linha.voceRecebe, "voceRecebe vem preenchido mesmo não-computável, pra frontend distinguir de precoFinal ausente");
    assert.strictEqual(linha.voceRecebe.computable, false);
    ok("Você recebe: Motor sem Base de Custos não derruba a listagem — voceRecebe fica não-computável");
  });

  // 25. Motor lança exceção (ex.: contexto não-pronto): não derruba a
  //     listagem de promoções — mesma garantia de resiliência do enriquecimento
  //     de vigência.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    chamadasMargem = [];
    mlHandler = () => ({
      ok: true, status: 200,
      data: [{ id: "P-1", type: "DEAL", status: "started", price: 82, original_price: 100 }],
    });
    margemHandler = () => { throw new Error("Base de custos MELI não vinculada."); };

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.ok, true, "exceção do Motor não pode derrubar a listagem de promoções");
    assert.strictEqual(res.corpo.promocoes[0].voceRecebe, null);
    ok("Você recebe: exceção do Motor (contexto não-pronto) não derruba a listagem — voceRecebe fica null");
  });

  // 26. Read-only continua valendo com o Motor ligado: nenhuma chamada de
  //     escrita nasce do cálculo de voceRecebe.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    chamadasMargem = [];
    mlHandler = () => ({
      ok: true, status: 200,
      data: [{ id: "P-1", type: "DEAL", status: "started", price: 82, original_price: 100 }],
    });
    margemHandler = () => ({ itens: [itemFixtureMotor({ itemId: "MLB-X", venda: 100, custo: 40, imposto: 0.05, comissao: 12, frete: 8 })] });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.ok(mlChamadas.every((c) => c.metodo === "GET"), "voceRecebe não pode introduzir nenhuma chamada de escrita ao ML");
    assert.ok(cotacaoChamadas.every((c) => c.metodo === "GET"), "cotação em P' é só leitura");
    ok("Você recebe: continua read-only mesmo com o Motor de Margem ligado no carregamento das promoções");
  });

  // 26b. P0 12/11/2026 — comissão/frete do PREÇO DA PROMOÇÃO, não do preço atual.
  //      Preço atual 100 (comissão 12, frete 8); promoção a 82: o ML cota 9,84
  //      de tarifa e 13,85 de frete. lucro = 82 − 4,10 − 9,84 − 13,85 − 40 = 14,21.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = []; chamadasMargem = []; cotacaoChamadas = [];
    mlHandler = () => ({ ok: true, status: 200, data: [{ id: "P-1", type: "DEAL", status: "started", price: 82, original_price: 100 }] });
    cotacaoHandler = (c) => (String(c.path).includes("listing_prices")
      ? { ok: true, status: 200, data: { sale_fee_amount: 9.84, sale_fee_details: { percentage_fee: 12 } } }
      : { ok: true, status: 200, data: { coverage: { all_country: { list_cost: 13.85, discount: { type: "mandatory", rate: 0.5 } } } } });
    margemHandler = () => ({ itens: [itemFixtureMotor({ itemId: "MLB-X", venda: 100, custo: 40, imposto: 0.05, comissao: 12, frete: 8 })] });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);
    const v = res.corpo.promocoes[0].voceRecebe;
    assert.strictEqual(v.computable, true, JSON.stringify(v));
    assert.ok(Math.abs(v.profit - 14.21) < 0.01, `profit ${v.profit}`);
    assert.strictEqual(v.comissao, 9.84);
    assert.strictEqual(v.frete, 13.85);
    assert.ok(cotacaoChamadas.length >= 2 && cotacaoChamadas.every((c) => c.mlUserId === "111"), "cota com o token da conta do anúncio");
    assert.ok(cotacaoChamadas.some((c) => /[?&](item_)?price=82(&|$)/.test(c.path)), "cota no preço 82");

    // Cotação de frete indisponível no preço da promoção: bloqueia (não cai no frete atual).
    cotacaoHandler = (c) => (String(c.path).includes("listing_prices")
      ? { ok: true, status: 200, data: { sale_fee_amount: 9.84 } }
      : { ok: false, status: 503, data: null });
    const res2 = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res2);
    const v2 = res2.corpo.promocoes[0].voceRecebe;
    assert.strictEqual(v2.computable, false, JSON.stringify(v2));
    assert.strictEqual(v2.profit, null);
    assert.ok(v2.motivoCotacao, "motivo da cotação indisponível");
    cotacaoHandler = COTACAO_PADRAO;
    ok("Você recebe: comissão/frete cotados no preço da promoção (conta do anúncio); sem cotação, margem bloqueada");
  });

  // ── Deduplicação por id+type (auditoria: "Vendex - Setembro" aparecia com
  // subsidioMl null na tabela, mas o clique em Alterar resolvia por id e
  // caía numa OUTRA entrada duplicada com subsidioMl preenchido, disparando
  // o aviso de rebate indevidamente — promocaoPorId no frontend sempre
  // resolve pela PRIMEIRA ocorrência do id no array, então duas entradas
  // com o mesmo id+type é uma inconsistência visual-vs-lógica garantida).
  // Prioridade de desempate (nunca junta campos das duas, só ESCOLHE uma):
  // 1) statusExibicao ATIVA, 2) subsidioMl preenchido, 3) datas preenchidas,
  // 4) maior quantidade de campos preenchidos.

  // 27. Prioridade 2 isolada: nenhuma das duas é ATIVA (nenhuma bate com o
  //     promotion_id do sale_price) — a com subsidioMl preenchido vence.
  {
    const semSubsidio = promocoesService.normalizarPromocao(
      { id: "P-VDX", type: "SELLER_CAMPAIGN", status: "started", price: 149.9, original_price: 149.9 }, 0
    );
    const comSubsidio = promocoesService.normalizarPromocao(
      { id: "P-VDX", type: "SELLER_CAMPAIGN", status: "started", price: 134.9, original_price: 149.9, meli_percentage: 0.5 }, 1
    );
    const resultado = promocoesService.deduplicarPromocoes([semSubsidio, comSubsidio]);
    assert.strictEqual(resultado.length, 1, "id+type repetido deve colapsar em uma única promoção");
    assert.strictEqual(resultado[0].subsidioMl, 0.75, "prioridade 2 (subsidioMl preenchido) vence quando nenhuma é ATIVA");
  }
  ok("deduplicarPromocoes: sem nenhuma ATIVA, vence a duplicata com subsidioMl preenchido");

  // 28. Prioridade 1 vence a 2: entre duas entradas com o mesmo id (mesma
  //     campanha, uma started e outra pending — caso real documentado em
  //     enriquecerVigencia), a ATIVA (started, id bate com promotion_id do
  //     sale_price) vence mesmo sem subsidioMl, sobre a pending (nunca vira
  //     ATIVA, independente do id) que tem subsidioMl preenchido.
  {
    const ativaSemSubsidio = promocoesService.normalizarPromocao(
      { id: "P-77", type: "SELLER_CAMPAIGN", status: "started", price: 90, original_price: 100 }, 0, "P-77"
    );
    const pendingComSubsidio = promocoesService.normalizarPromocao(
      { id: "P-77", type: "SELLER_CAMPAIGN", status: "pending", price: 85, original_price: 100, meli_percentage: 4 }, 1, "P-77"
    );
    assert.strictEqual(ativaSemSubsidio.statusExibicao, "ATIVA");
    assert.strictEqual(pendingComSubsidio.statusExibicao, "PROGRAMADA", "pending nunca vira ATIVA, mesmo com id igual ao promotion_id ativo");

    const resultado = promocoesService.deduplicarPromocoes([ativaSemSubsidio, pendingComSubsidio]);
    assert.strictEqual(resultado.length, 1);
    assert.strictEqual(resultado[0].statusExibicao, "ATIVA", "prioridade 1 (statusExibicao ATIVA) vence a prioridade 2 (subsidioMl)");
    assert.strictEqual(resultado[0].subsidioMl, null, "a vencedora é a ATIVA, mesmo sem subsidioMl — nunca junta o subsidioMl da outra");
  }
  ok("deduplicarPromocoes: statusExibicao ATIVA vence subsidioMl preenchido quando as duas competem");

  // 29. Empate nas 3 primeiras prioridades: vence quem tem mais campos
  //     preenchidos (nome presente é o campo extra que desempata aqui).
  {
    const semNome = promocoesService.normalizarPromocao(
      { id: "P-88", type: "DEAL", status: "candidate", suggested_discounted_price: 90, original_price: 100 }, 0
    );
    const comNome = promocoesService.normalizarPromocao(
      { id: "P-88", type: "DEAL", status: "candidate", suggested_discounted_price: 90, original_price: 100, name: "Campanha X" }, 1
    );
    const resultado = promocoesService.deduplicarPromocoes([semNome, comNome]);
    assert.strictEqual(resultado.length, 1);
    assert.strictEqual(resultado[0].nome, "Campanha X", "empatadas nas 3 primeiras prioridades, vence quem tem mais campos preenchidos");
  }
  ok("deduplicarPromocoes: em empate total, vence a duplicata com mais campos preenchidos");

  // ── Revisão de segurança da deduplicação ───────────────────────────────────

  // 29b. A chave é id+type, NUNCA só id — mesmo id com tipos diferentes é
  //      duas promoções REALMENTE diferentes (ex.: uma DEAL e uma
  //      SELLER_CAMPAIGN podem coincidir de id por acaso), nunca podem
  //      colapsar em uma só.
  {
    const tipoA = promocoesService.normalizarPromocao(
      { id: "X-1", type: "DEAL", status: "candidate", suggested_discounted_price: 90, original_price: 100 }, 0
    );
    const tipoB = promocoesService.normalizarPromocao(
      { id: "X-1", type: "SELLER_CAMPAIGN", status: "candidate", suggested_discounted_price: 85, original_price: 100 }, 1
    );
    const resultado = promocoesService.deduplicarPromocoes([tipoA, tipoB]);
    assert.strictEqual(resultado.length, 2, "mesmo id com tipos diferentes não pode colapsar — a chave é id+type, não só id");
  }
  ok("deduplicarPromocoes: mesmo id com tipos diferentes nunca colapsa — confirma que a chave é id+type");

  // 29c. Promoções SEM id (fallback sintético do normalizador inclui o índice
  //      da posição — ver normalizarPromocao) nunca podem ser removidas pela
  //      deduplicação: cada uma nasce com uma chave sintética própria, então
  //      nunca colidem entre si por engano.
  {
    const semId1 = promocoesService.normalizarPromocao(
      { type: "PRICE_DISCOUNT", status: "candidate", suggested_discounted_price: 90, original_price: 100 }, 0
    );
    const semId2 = promocoesService.normalizarPromocao(
      { type: "PRICE_DISCOUNT", status: "candidate", suggested_discounted_price: 85, original_price: 100 }, 1
    );
    assert.notStrictEqual(semId1.id, semId2.id, "sem id/ref_id, o fallback usa o índice da posição — nunca pode colidir entre duas promoções diferentes");
    const resultado = promocoesService.deduplicarPromocoes([semId1, semId2]);
    assert.strictEqual(resultado.length, 2, "promoções sem id nunca podem ser removidas pela deduplicação");
  }
  ok("deduplicarPromocoes: promoções sem id (fallback por índice da posição) nunca são removidas");

  // 30. Fim a fim via endpoint real: duplicata sem rebate + duplicata com
  //     rebate (mesmo id+type) — a tabela e o botão "Alterar" passam a ver
  //     uma ÚNICA promoção, com o subsidioMl correto (nunca "—" com um clique
  //     que discorda do que a tela mostrou).
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = () => ({
      ok: true, status: 200,
      data: [
        { id: "P-VDX-E2E", type: "SELLER_CAMPAIGN", status: "started", price: 149.9, original_price: 149.9, name: "Vendex - Setembro" },
        { id: "P-VDX-E2E", type: "SELLER_CAMPAIGN", status: "started", price: 134.9, original_price: 149.9, meli_percentage: 0.5, name: "Vendex - Setembro" },
      ],
    });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.promocoes.length, 1, "o endpoint nunca pode devolver duas linhas para a mesma promoção (mesmo id+type)");
    assert.strictEqual(res.corpo.promocoes[0].subsidioMl, 0.75, "a versão mantida é a que tem subsidioMl preenchido — a UI mostra o valor real, não '—'");
    ok("endpoint: duplicata sem rebate + duplicata com rebate (mesmo id+type) colapsa em uma linha só, com o subsidioMl real");
  });

  // 31. Fim a fim: duplicata sem rebate em AMBAS as entradas — resultado
  //     continua com subsidioMl null, então o gate de escrita do frontend
  //     (jaParticipada && subsidioMl != null, ver anuncios-meli.js) não tem
  //     motivo pra bloquear "Alterar" com o aviso de rebate.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = () => ({
      ok: true, status: 200,
      data: [
        { id: "P-VDX2-E2E", type: "SELLER_CAMPAIGN", status: "started", price: 149.9, original_price: 149.9, name: "Vendex - Outubro" },
        { id: "P-VDX2-E2E", type: "SELLER_CAMPAIGN", status: "active", price: 149.9, original_price: 149.9, name: "Vendex - Outubro" },
      ],
    });

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(res.corpo.promocoes.length, 1, "duas entradas sem rebate para a mesma promoção também colapsam em uma só");
    assert.strictEqual(res.corpo.promocoes[0].subsidioMl, null, "sem subsidioMl em nenhuma duplicata, o resultado continua null — Alterar não deve ser bloqueado");
    ok("endpoint: duplicata sem rebate nas duas entradas colapsa em uma só, subsidioMl continua null (Alterar não é bloqueado)");
  });

  // ── Fallback secundário por preço (auditoria: "Vendex - Setembro" é
  // SELLER_CAMPAIGN — esse tipo não segue o mecanismo de "oferta" (ref_id no
  // formato OFFER-...) que os outros 5 tipos usam para bater com
  // sale_price.metadata.promotion_id, então nunca casa por id/ref_id mesmo
  // sendo a promoção que o ML realmente aplicou no preço). Quando NENHUMA
  // promoção started/active bate por promotion_id, usa igualdade EXATA entre
  // precoFinal (promo.price) e sale_price.amount — nunca percentual de
  // desconto, meli_percentage, maior desconto ou prioridade de campanha.
  // Ambiguidade (duas batendo no mesmo preço) nunca escolhe arbitrariamente:
  // nenhuma vira ATIVA.

  // 32. Fallback ativa quando não há match de promotion_id mas o preço bate.
  {
    const semMatch = promocoesService.normalizarPromocao(
      { id: "C-VDX-SET", type: "SELLER_CAMPAIGN", status: "started", price: 56.05, original_price: 79.9 },
      0,
      "OFFER-MLB-X-999"
    );
    assert.strictEqual(semMatch.statusExibicao, "NÃO APLICADA", "id não bate com o promotion_id (formatos de mecanismos diferentes)");
    promocoesService.aplicarFallbackPrecoAtivo([semMatch], 56.05);
    assert.strictEqual(semMatch.statusExibicao, "ATIVA", "fallback: price bate com sale_price.amount, mesmo sem match de promotion_id");
  }
  ok("fallback por preço: SELLER_CAMPAIGN sem match de promotion_id vira ATIVA quando price == sale_price.amount");

  // 33. Caminho antigo (ref_id) intocado — e uma vez já ATIVA por
  //     promotion_id, o fallback não reavalia nem desfaz.
  {
    const ativaPorRefId = promocoesService.normalizarPromocao(
      { id: "P-SMART-1", type: "SMART", ref_id: "OFFER-MLB-X-777", status: "started", price: 120, original_price: 150 },
      0,
      "OFFER-MLB-X-777"
    );
    assert.strictEqual(ativaPorRefId.statusExibicao, "ATIVA", "ref_id bate com promotion_id — caminho antigo intocado");
    promocoesService.aplicarFallbackPrecoAtivo([ativaPorRefId], 999);
    assert.strictEqual(ativaPorRefId.statusExibicao, "ATIVA", "já havia ATIVA por promotion_id — fallback não reavalia nem desfaz, mesmo com amount que não bateria");
  }
  ok("fallback por preço: promoção já ATIVA por ref_id/id não é reavaliada pelo fallback");

  // 34. Empate: duas started batem no mesmo preço — ambíguo, nenhuma vira
  //     ATIVA por acaso (nunca escolhe arbitrariamente).
  {
    const a = promocoesService.normalizarPromocao(
      { id: "C-A", type: "SELLER_CAMPAIGN", status: "started", price: 56.05, original_price: 79.9 }, 0
    );
    const b = promocoesService.normalizarPromocao(
      { id: "C-B", type: "SELLER_CAMPAIGN", status: "started", price: 56.05, original_price: 90 }, 1
    );
    promocoesService.aplicarFallbackPrecoAtivo([a, b], 56.05);
    assert.strictEqual(a.statusExibicao, "NÃO APLICADA", "duas promoções batem no mesmo preço — ambíguo, nenhuma vira ATIVA");
    assert.strictEqual(b.statusExibicao, "NÃO APLICADA", "idem — o fallback nunca escolhe arbitrariamente entre empatadas");
  }
  ok("fallback por preço: empate entre duas started no mesmo preço é ambíguo — comportamento definido é NÃO ativar nenhuma");

  // 35. candidate nunca vira ATIVA pelo fallback, mesmo com preço igual ao
  //     amount (fallback só considera started/active).
  {
    const cand = promocoesService.normalizarPromocao(
      { id: "C-CAND", type: "SELLER_CAMPAIGN", status: "candidate", suggested_discounted_price: 90, original_price: 100 }, 0
    );
    assert.strictEqual(cand.statusExibicao, "ELEGÍVEL");
    promocoesService.aplicarFallbackPrecoAtivo([cand], 90);
    assert.strictEqual(cand.statusExibicao, "ELEGÍVEL", "candidate nunca vira ATIVA pelo fallback de preço, mesmo com price/suggested igual ao amount");
  }
  ok("fallback por preço: candidate nunca vira ATIVA, mesmo com preço igual ao sale_price.amount");

  // 36. Sem amount (sale_price falhou ou veio sem o campo): comportamento
  //     atual preservado, fallback não pode ativar nada.
  {
    const p = promocoesService.normalizarPromocao(
      { id: "C-X", type: "SELLER_CAMPAIGN", status: "started", price: 56.05, original_price: 79.9 }, 0
    );
    promocoesService.aplicarFallbackPrecoAtivo([p], null);
    assert.strictEqual(p.statusExibicao, "NÃO APLICADA", "sem amount, o fallback não pode ativar nada — comportamento atual preservado");
  }
  ok("fallback por preço: sem amount, comportamento atual é preservado (nenhuma ativação)");

  // 37. Fim a fim via endpoint real: obterPromotionIdAtivo passa a capturar
  //     amount e listarPromocoesDoItem aplica o fallback antes de deduplicar.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) {
        return { ok: true, status: 200, data: { amount: 56.05, regular_amount: 79.9, metadata: { promotion_id: "OFFER-MLB-X-999" } } };
      }
      return {
        ok: true, status: 200,
        data: [
          { id: "C-VDX-SET", type: "SELLER_CAMPAIGN", status: "started", price: 56.05, original_price: 79.9, name: "Vendex - Setembro" },
        ],
      };
    };

    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);

    assert.strictEqual(
      res.corpo.promocoes[0].statusExibicao,
      "ATIVA",
      "fim a fim: SELLER_CAMPAIGN sem match de promotion_id (mecanismo OFFER- é de outros tipos) mas com price == sale_price.amount vira ATIVA"
    );
    ok("fim a fim: fallback por preço corrige statusExibicao de SELLER_CAMPAIGN real, sem tocar escrita/motor de margem");
  });

  // ── precoFinal de candidatas SMART/PRICE_MATCHING sem suggested_discounted_
  // price (auditoria: "Impulsione suas vendas", SMART, item MLB4147165927 —
  // essas campanhas cofinanciadas automáticas nunca enviam
  // suggested_discounted_price em candidate, só original_price+meli_percentage,
  // que já são a fonte do subsidioMl. precoFinal ficava null → "Preço final"
  // e "Você recebe" vazios, mesmo com subsidioMl preenchido). Fallback usa a
  // MESMA fórmula já validada do subsidioMl, só quando suggested_discounted_
  // price não vier — nunca sobrepõe o valor do ML quando ele existe.

  // 38. SMART candidate sem suggested_discounted_price: precoFinal derivado
  //     de original_price*(1-meli_percentage/100).
  {
    const linha = promocoesService.normalizarPromocao(
      { type: "SMART", status: "candidate", original_price: 100, meli_percentage: 8 }, 0
    );
    assert.strictEqual(linha.precoFinal, 92, "sem suggested_discounted_price, cai para 100*(1-8/100)=92");
    assert.strictEqual(linha.subsidioMl, 8, "subsidioMl continua pela mesma fórmula, sem relação com o cálculo novo");
  }
  ok("precoFinal candidate: SMART sem suggested_discounted_price deriva do mesmo par original_price/meli_percentage do subsidioMl");

  // 39. PRICE_MATCHING candidate segue a mesma regra.
  {
    const linha = promocoesService.normalizarPromocao(
      { type: "PRICE_MATCHING", status: "candidate", original_price: 100, meli_percentage: 1.3 }, 0
    );
    assert.strictEqual(linha.precoFinal, 98.7, "sem suggested_discounted_price, cai para 100*(1-1.3/100)=98.7");
  }
  ok("precoFinal candidate: PRICE_MATCHING segue a mesma regra de fallback do SMART");

  // 40. suggested_discounted_price tem prioridade sobre o cálculo — nunca
  //     sobrepõe o valor que o próprio ML mandou.
  {
    const linha = promocoesService.normalizarPromocao(
      {
        type: "SMART", status: "candidate", original_price: 100, meli_percentage: 8,
        suggested_discounted_price: 95,
      },
      0
    );
    assert.strictEqual(linha.precoFinal, 95, "suggested_discounted_price do ML (95) vence o cálculo derivado (que daria 92)");
  }
  ok("precoFinal candidate: suggested_discounted_price do ML tem prioridade sobre o cálculo derivado");

  // 41. candidate sem meli_percentage (e sem suggested_discounted_price)
  //     continua sem precoFinal — nunca inventa desconto sem nenhum dado.
  {
    const linha = promocoesService.normalizarPromocao(
      { type: "SMART", status: "candidate", original_price: 100 }, 0
    );
    assert.strictEqual(linha.precoFinal, null, "sem meli_percentage nem suggested_discounted_price, precoFinal continua null");
  }
  ok("precoFinal candidate: sem meli_percentage, continua null — nunca inventa desconto");

  // 42. started continua usando price existente — fallback é exclusivo de
  //     candidate, não pode mudar o caminho já validado das ativas.
  {
    const linha = promocoesService.normalizarPromocao(
      { type: "SMART", status: "started", price: 82, original_price: 100, meli_percentage: 8 }, 0
    );
    assert.strictEqual(linha.precoFinal, 82, "started continua usando price bruto do ML, nunca o cálculo derivado (que daria 92)");
  }
  ok("precoFinal: started continua inteiramente pelo caminho antigo (price bruto), fallback não se aplica");

  // ── precoFinal do fallback de candidate precisa do desconto TOTAL (meli+
  // seller), nunca só a fatia do subsídio ML (auditoria: item MLB4162633919,
  // "Impulsione suas vendas" — hipótese inicial era subtração dupla
  // desconto+subsídio, mas a causa real é o fallback anterior usar só
  // meli_percentage como se fosse o desconto inteiro, ignorando
  // seller_percentage. Confirmado com 3 exemplos oficiais independentes:
  // campanha-com-co-participacao.md (1000→700, meli=5+seller=25=30% real),
  // campanhas-smart-price-matching.md PRICE_MATCHING_MELI_ALL (135→121,5,
  // meli=10+seller=0=10%) e o exemplo com boost (76287→73001, ≈4,3%).
  // subsidioMl continua só meli_percentage — é "quanto o vendedor recebe de
  // volta", nunca o desconto total; as duas fórmulas são propositalmente
  // diferentes e nenhuma delas soma a outra por cima do resultado final.

  // Caso 1: promoção normal, sem subsídio nenhum — o campo oficial (price)
  // é usado como está, nenhuma matemática entra em jogo.
  {
    const linha = promocoesService.normalizarPromocao(
      { type: "DEAL", status: "started", price: 56.9, original_price: 79.9 }, 0
    );
    assert.strictEqual(linha.precoFinal, 56.9, "promoção normal: price oficial do ML usado como está, sem cálculo");
  }
  ok("precoFinal: Caso 1 — promoção normal sem subsídio, price oficial intocado (79.90 → 56.90)");

  // Caso 2: candidate SMART com subsídio 100% do ML (seller_percentage=0,
  // mesmo shape do exemplo real "Impulsione suas vendas") — confirma que o
  // subsídio NÃO é subtraído uma segunda vez em cima do desconto (o desconto
  // aqui É o subsídio inteiro, então 77.70 é o valor certo, nunca 75.50 como
  // uma subtração dupla desconto+subsídio produziria).
  {
    const linha = promocoesService.normalizarPromocao(
      { type: "SMART", status: "candidate", original_price: 79.9, meli_percentage: 2.75, seller_percentage: 0 }, 0
    );
    assert.strictEqual(linha.subsidioMl, 2.2, "subsidioMl (100*2.75/100 sobre 79.90) continua 2.20, fórmula do subsídio intocada");
    assert.strictEqual(linha.precoFinal, 77.7, "precoFinal correto é 77.70 (desconto real = subsídio, seller_percentage=0)");
    assert.notStrictEqual(linha.precoFinal, 75.5, "nunca 75.50 — isso seria subtrair o subsídio uma segunda vez em cima do desconto");
  }
  ok("precoFinal: Caso 2 — subsídio 100% ML não é subtraído duas vezes (79.90 → 77.70, nunca 75.50)");

  // Caso 2b: candidate com seller_percentage > 0 — a fatia do vendedor
  // TAMBÉM reduz o preço pago pelo comprador (é desconto real, só não é
  // "subsídio ML"). Números iguais ao exemplo oficial de campanha com
  // co-participação (1000→700, meli=5+seller=25=30%) para validar contra
  // dado real da doc, não um número inventado.
  {
    const linha = promocoesService.normalizarPromocao(
      { type: "SMART", status: "candidate", original_price: 100, meli_percentage: 5, seller_percentage: 25 }, 0
    );
    assert.strictEqual(linha.subsidioMl, 5, "subsidioMl continua só a fatia do ML (100*5/100=5), nunca soma seller_percentage");
    assert.strictEqual(linha.precoFinal, 70, "precoFinal usa o desconto TOTAL (5+25=30%): 100*(1-30/100)=70, igual ao exemplo real da doc (1000→700)");
  }
  ok("precoFinal: Caso 2b — seller_percentage também compõe o desconto real, provado contra exemplo oficial da doc (1000→700)");

  // Caso 3: sem suggested_discounted_price e sem meli_percentage — fallback
  // não tem dado nenhum pra calcular, precoFinal continua null.
  {
    const linha = promocoesService.normalizarPromocao(
      { type: "SMART", status: "candidate", original_price: 79.9, seller_percentage: 10 }, 0
    );
    assert.strictEqual(linha.precoFinal, null, "sem meli_percentage (mesmo com seller_percentage presente), precoFinal continua null");
  }
  ok("precoFinal: Caso 3 — sem campo oficial e sem meli_percentage, fallback não inventa desconto");
}

run()
  .then(() => {
    console.log(`\n✓ ${checks} verificações de promoções do anúncio ML`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n✗ FALHOU:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
