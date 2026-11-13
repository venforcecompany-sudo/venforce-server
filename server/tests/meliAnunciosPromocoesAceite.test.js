// server/tests/meliAnunciosPromocoesAceite.test.js
//
// Promoções em que o MERCADO LIVRE define o preço (modoEscrita ACEITE —
// MARKETPLACE_CAMPAIGN, SMART, PRICE_MATCHING, PRE_NEGOTIATED,
// UNHEALTHY_STOCK): o vendedor só PARTICIPA ou DEIXA DE PARTICIPAR.
//   POST /anuncios-meli/:itemId/promocoes/:promotionId/participar
//   POST /anuncios-meli/:itemId/promocoes/:promotionId/sair
//
// Regras protegidas por este teste:
//
//  1. a listagem expõe `modoEscrita` (PRECO/ACEITE/null) e `refId` (offer_id);
//  2. participar só a partir de candidate, SEM preço no corpo, com offer_id
//     só nos tipos cuja doc pede (MARKETPLACE_CAMPAIGN não leva);
//  3. sair de qualquer tipo em started/active/pending, por DELETE com os
//     parâmetros específicos do tipo, preservando eventuais recusas do ML;
//  4. participar sem preço continua restrito aos tipos ACEITE;
//  5. a decisão é sempre pela releitura AO VIVO, e `tipo` desambigua o id.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const Module = require("module");

let mlChamadas = [];
let mlHandler = null;

const originalLoad = Module._load;
Module._load = function loadWithMlFetchStub(request, parent, isMain) {
  if (request === "../../utils/mlClient" || request === "../utils/mlClient") {
    return {
      async mlFetch(clienteId, path, options = {}) {
        const chamada = {
          clienteId,
          path,
          metodo: options.method || "GET",
          mlUserId: options.mlUserId,
          body: options.body ? JSON.parse(options.body) : null,
        };
        mlChamadas.push(chamada);
        return mlHandler ? mlHandler(chamada) : { ok: true, status: 200, data: [] };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const pool = require("../config/database");
const ctrl = require("../controllers/meliAnunciosController");

Module._load = originalLoad;

const cliente = { id: 1, nome: "Cliente A", slug: "cliente-a", ativo: true };

function anunciosFixture() {
  return [
    {
      id: 7, cliente_id: 1, cliente_slug: "cliente-a", item_id: "MLB-X",
      titulo: "Camiseta Azul P", preco: 100, preco_original: 100,
      cliente_conta_id: 10, ml_user_id: "111",
    },
  ];
}

class MockDb {
  constructor({ anuncios = [] } = {}) {
    this.anuncios = anuncios;
    this.updates = [];
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
    if (q.startsWith("UPDATE meli_anuncios")) {
      this.updates.push({ sql: q, params });
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

function chamar(acao, itemId, promotionId, body) {
  const res = fakeRes();
  const fn = acao === "participar" ? ctrl.participarPromocao : ctrl.sairPromocao;
  return Promise.resolve(
    fn({ params: { itemId, promotionId }, body: { clienteSlug: "cliente-a", ...body } }, res)
  ).then(() => res);
}

function listagem(promos, extra = {}) {
  return (chamada) => {
    if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: extra.saleData || {} };
    if (/\/seller-promotions\/promotions\//.test(chamada.path)) return { ok: false, status: 404, data: {} };
    if (chamada.metodo === "GET") return { ok: true, status: 200, data: promos };
    return extra.escrita ? extra.escrita(chamada) : { ok: true, status: 200, data: { price: 90, original_price: 100 } };
  };
}

function escritas() {
  return mlChamadas.filter((c) => c.metodo !== "GET");
}

let checks = 0;
function ok(msg) { checks += 1; console.log(`  ✓ ${msg}`); }

async function run() {
  // 1. Listagem: modoEscrita + refId.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = listagem([
      { id: "P-S", type: "SMART", status: "candidate", ref_id: "CANDIDATE-MLB-X-1", original_price: 100, meli_percentage: 2, seller_percentage: 8 },
      { id: "P-D", type: "DEAL", status: "candidate", original_price: 100, suggested_discounted_price: 90 },
      { id: "P-I", type: "PRICE_DISCOUNT", status: "candidate", original_price: 100 },
    ]);
    const res = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, res);
    const porId = Object.fromEntries(res.corpo.promocoes.map((p) => [p.id, p]));
    assert.strictEqual(porId["P-S"].modoEscrita, "ACEITE");
    assert.strictEqual(porId["P-S"].refId, "CANDIDATE-MLB-X-1");
    assert.strictEqual(porId["P-D"].modoEscrita, "PRECO");
    assert.strictEqual(porId["P-D"].refId, null);
    assert.strictEqual(porId["P-I"].modoEscrita, null);
    ok("listagem expõe modoEscrita (ACEITE/PRECO/null) e refId (offer_id)");
  });

  // 2. SMART candidate → POST sem preço, com offer_id da candidatura.
  await withMockDb({ anuncios: anunciosFixture() }, async (db) => {
    mlChamadas = [];
    mlHandler = listagem(
      [{ id: "P-S", type: "SMART", status: "candidate", ref_id: "CANDIDATE-MLB-X-1", original_price: 100, meli_percentage: 2 }],
      { escrita: () => ({ ok: true, status: 200, data: { offer_id: "OFFER-MLB-X-9", price: 90, original_price: 100 } }) }
    );
    const res = await chamar("participar", "MLB-X", "P-S", { tipo: "SMART" });
    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.acao, "PARTICIPAR");
    assert.strictEqual(res.corpo.precoConfirmado, 90);
    const e = escritas();
    assert.strictEqual(e.length, 1);
    assert.strictEqual(e[0].metodo, "POST");
    assert.strictEqual(e[0].path, "/seller-promotions/items/MLB-X?app_version=v2");
    assert.deepStrictEqual(e[0].body, { promotion_id: "P-S", promotion_type: "SMART", offer_id: "CANDIDATE-MLB-X-1" });
    assert.ok(mlChamadas.every((c) => c.mlUserId === "111"), "conta ML da própria linha do anúncio");
    assert.strictEqual(db.updates.length, 0, "não toca meli_anuncios");
    ok("SMART candidate: POST {promotion_id, promotion_type, offer_id}, nunca preço");
  });

  // 3. MARKETPLACE_CAMPAIGN candidate → POST sem offer_id (doc não leva).
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = listagem([{ id: "P-M", type: "MARKETPLACE_CAMPAIGN", status: "candidate", ref_id: "CANDIDATE-X", original_price: 100, meli_percentage: 5 }]);
    const res = await chamar("participar", "MLB-X", "P-M", { tipo: "MARKETPLACE_CAMPAIGN" });
    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.deepStrictEqual(escritas()[0].body, { promotion_id: "P-M", promotion_type: "MARKETPLACE_CAMPAIGN" });
    ok("MARKETPLACE_CAMPAIGN candidate: POST só com promotion_id + promotion_type");
  });

  // 4. Participar de algo que já participa → recusado, zero escrita.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = listagem([{ id: "P-S", type: "SMART", status: "started", ref_id: "OFFER-1", price: 90, original_price: 100 }]);
    const res = await chamar("participar", "MLB-X", "P-S", { tipo: "SMART" });
    assert.strictEqual(res.corpo.ok, false);
    assert.strictEqual(res.corpo.codigo, "PROMOCAO_JA_PARTICIPA");
    assert.strictEqual(escritas().length, 0);
    ok("participar de promoção já started: recusado pela releitura, zero escrita");
  });

  // 5. Tipo PRECO (DEAL) e fora do escopo (PRICE_DISCOUNT) → recusados.
  for (const tipo of ["DEAL", "PRICE_DISCOUNT"]) {
    await withMockDb({ anuncios: anunciosFixture() }, async () => {
      mlChamadas = [];
      mlHandler = listagem([{ id: "P-Z", type: tipo, status: "candidate", ref_id: "CANDIDATE-Z", original_price: 100 }]);
      const r1 = await chamar("participar", "MLB-X", "P-Z", { tipo });
      const r2 = await chamar("sair", "MLB-X", "P-Z", { tipo });
      assert.strictEqual(r1.corpo.codigo, "TIPO_SEM_ACEITE", tipo);
      // Sair independe do tipo — aqui recusa porque é candidate.
      assert.strictEqual(r2.corpo.codigo, "PROMOCAO_NAO_PARTICIPA", tipo);
      assert.strictEqual(escritas().length, 0);
    });
  }
  ok("participar sem preço recusa DEAL e PRICE_DISCOUNT; sair recusa qualquer candidate");

  // 6. Sair de SMART started → DELETE com os três parâmetros.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = listagem(
      [{ id: "P-S", type: "SMART", status: "started", ref_id: "OFFER-MLB-X-9", price: 90, original_price: 100 }],
      { saleData: { metadata: { promotion_id: "OFFER-MLB-X-9" } }, escrita: () => ({ ok: true, status: 200, data: null }) }
    );
    const res = await chamar("sair", "MLB-X", "P-S", { tipo: "SMART" });
    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.acao, "SAIR");
    const e = escritas();
    assert.strictEqual(e.length, 1);
    assert.strictEqual(e[0].metodo, "DELETE");
    assert.strictEqual(e[0].body, null, "DELETE não leva corpo");
    assert.strictEqual(
      e[0].path,
      "/seller-promotions/items/MLB-X?promotion_type=SMART&promotion_id=P-S&offer_id=OFFER-MLB-X-9&app_version=v2"
    );
    ok("sair de SMART started: DELETE com promotion_type + promotion_id + offer_id");
  });

  // 7. Sair também vale para pending (programada).
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = listagem([{ id: "P-P", type: "PRE_NEGOTIATED", status: "pending", ref_id: "MLB-X-abc", price: 80, original_price: 100 }]);
    const res = await chamar("sair", "MLB-X", "P-P", { tipo: "PRE_NEGOTIATED" });
    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(escritas()[0].metodo, "DELETE");
    ok("sair de PRE_NEGOTIATED pending (programada): DELETE permitido");
  });

  // 8. Sair de candidate → recusado; sair sem offer_id → recusado, zero escrita.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = listagem([
      { id: "P-C", type: "SMART", status: "candidate", ref_id: "CANDIDATE-1", original_price: 100 },
      { id: "P-N", type: "SMART", status: "started", price: 90, original_price: 100 },
    ]);
    const r1 = await chamar("sair", "MLB-X", "P-C", { tipo: "SMART" });
    const r2 = await chamar("sair", "MLB-X", "P-N", { tipo: "SMART" });
    assert.strictEqual(r1.corpo.codigo, "PROMOCAO_NAO_PARTICIPA");
    assert.strictEqual(r2.corpo.codigo, "OFFER_ID_AUSENTE");
    assert.strictEqual(escritas().length, 0);
    ok("sair de candidate ou sem offer_id: recusado, zero escrita");
  });

  // 9. `tipo` desambigua o id; promoção que sumiu → não encontrada.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = listagem([
      { id: "P-1", type: "DEAL", status: "candidate", original_price: 100, suggested_discounted_price: 90 },
      { id: "P-1", type: "SMART", status: "candidate", ref_id: "CANDIDATE-1", original_price: 100 },
    ]);
    const res = await chamar("participar", "MLB-X", "P-1", { tipo: "SMART" });
    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(escritas()[0].body.promotion_type, "SMART");

    mlChamadas = [];
    const sumiu = await chamar("participar", "MLB-X", "P-SUMIU", { tipo: "SMART" });
    assert.strictEqual(sumiu.corpo.codigo, "PROMOCAO_NAO_ENCONTRADA");
    assert.strictEqual(escritas().length, 0);
    ok("id repetido entre tipos é resolvido pelo `tipo`; promoção que sumiu é recusada");
  });

  // 10. Recusa do ML repassada; clienteSlug ausente é 400 sem chamar o ML.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = listagem(
      [{ id: "P-S", type: "SMART", status: "candidate", ref_id: "CANDIDATE-1", original_price: 100 }],
      { escrita: () => ({ ok: false, status: 400, data: { message: "Offer not available.", error: "OFFER_NOT_AVAILABLE" } }) }
    );
    const res = await chamar("participar", "MLB-X", "P-S", { tipo: "SMART" });
    assert.strictEqual(res.corpo.ok, false);
    assert.strictEqual(res.corpo.motivo, "Offer not available.");

    mlChamadas = [];
    const r400 = fakeRes();
    await ctrl.participarPromocao({ params: { itemId: "MLB-X", promotionId: "P-S" }, body: {} }, r400);
    assert.strictEqual(r400.statusCode, 400);
    assert.strictEqual(mlChamadas.length, 0);
    ok("recusa do ML é repassada; clienteSlug ausente é 400 sem tocar no ML");
  });
}

async function runPreco() {
  // 11. Sair de DEAL/SELLER_CAMPAIGN em que participa (mesmo não aplicada):
  //     DELETE só com promotion_type + promotion_id — sem offer_id.
  for (const tipo of ["DEAL", "SELLER_CAMPAIGN"]) {
    await withMockDb({ anuncios: anunciosFixture() }, async () => {
      mlChamadas = [];
      mlHandler = listagem(
        [
          { id: "P-A", type: tipo, status: "started", price: 85, original_price: 100 },
          { id: "P-B", type: tipo, status: "started", price: 90, original_price: 100 },
        ],
        { saleData: { metadata: { promotion_id: "P-A" } }, escrita: () => ({ ok: true, status: 200, data: null }) }
      );
      const res = await chamar("sair", "MLB-X", "P-B", { tipo });
      assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
      const e = escritas();
      assert.strictEqual(e.length, 1);
      assert.strictEqual(e[0].metodo, "DELETE");
      assert.strictEqual(e[0].path, `/seller-promotions/items/MLB-X?promotion_type=${tipo}&promotion_id=P-B&app_version=v2`);
    });
  }
  ok("sair de DEAL/SELLER_CAMPAIGN (mesmo NÃO APLICADA): DELETE sem offer_id, como na doc");
}

async function runOutrosTipos() {
  for (const tipo of ["PRICE_DISCOUNT", "DOD", "LIGHTNING", "VOLUME", "BANK", "NOVO_TIPO_ML"]) {
    for (const status of ["started", "active", "pending"]) {
      await withMockDb({ anuncios: anunciosFixture() }, async () => {
        mlChamadas = [];
        mlHandler = listagem([{ id: "P-OUTRA", type: tipo, status, ref_id: "OFFER-OUTRA", price: 90, original_price: 100 }]);
        const res = await chamar("sair", "MLB-X", "P-OUTRA", { tipo });
        assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
        const e = escritas();
        assert.strictEqual(e.length, 1);
        assert.strictEqual(e[0].metodo, "DELETE");
        assert.strictEqual(e[0].body, null);
        assert.strictEqual(e[0].mlUserId, "111");
        const parametros = ["PRICE_DISCOUNT", "DOD", "LIGHTNING"].includes(tipo)
          ? "" : "&promotion_id=P-OUTRA&offer_id=OFFER-OUTRA";
        assert.strictEqual(e[0].path, `/seller-promotions/items/MLB-X?promotion_type=${tipo}${parametros}&app_version=v2`);
      });
    }
  }
  ok("saída de tipos sem criação na tela: desconto individual, DOD, LIGHTNING, VOLUME, BANK e novos tipos");

  for (const tipo of ["VOLUME", "BANK"]) {
    await withMockDb({ anuncios: anunciosFixture() }, async () => {
      mlChamadas = [];
      mlHandler = listagem([{ id: "P-OUTRA", type: tipo, status: "started", price: 90, original_price: 100 }]);
      const res = await chamar("sair", "MLB-X", "P-OUTRA", { tipo });
      assert.strictEqual(res.corpo.codigo, "OFFER_ID_AUSENTE");
      assert.strictEqual(escritas().length, 0);
    });
  }
  ok("VOLUME/BANK sem offer_id são recusadas antes do DELETE");

  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = listagem(
      [{ id: "P-DOD", type: "DOD", status: "started", price: 90, original_price: 100 }],
      { escrita: () => ({ ok: false, status: 400, data: { error: "OFFER_STARTED", message: "A oferta já iniciada não pode ser removida." } }) }
    );
    const res = await chamar("sair", "MLB-X", "P-DOD", { tipo: "DOD" });
    assert.strictEqual(res.corpo.ok, false);
    assert.strictEqual(res.corpo.motivo, "A oferta já iniciada não pode ser removida.");
    assert.strictEqual(escritas().length, 1);
  });
  ok("restrições de cancelamento do ML são devolvidas sem indicar sucesso");
}

run()
  .then(runPreco)
  .then(runOutrosTipos)
  .then(() => {
    console.log(`\n✓ ${checks} verificações de participar/sair de promoção (preço do ML)`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n✗ FALHOU:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
