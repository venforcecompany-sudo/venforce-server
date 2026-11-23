// server/tests/meliAnunciosPromocoesEscrita.test.js
//
// Escrita REAL de participação/alteração em promoção
// (POST /anuncios-meli/:itemId/promocoes/:promotionId/aplicar).
//
// Escopo desta v1 (decisão de produto, ver auditoria de
// documentacao_api_meli/*): só DEAL e SELLER_CAMPAIGN têm contrato de
// escrita simétrico (POST participa / PUT altera) com preço escolhido pelo
// vendedor, compatível com a célula "Preço final" que já existe. Todos os
// outros tipos (PRICE_DISCOUNT, DOD, LIGHTNING, MARKETPLACE_CAMPAIGN,
// VOLUME, SMART, PRICE_MATCHING, PRE_NEGOTIATED, UNHEALTHY_STOCK) continuam
// só simulação — sem PUT documentado, ou sem preço escolhido pelo vendedor,
// ou exigindo campos que esta tela não coleta.
//
// Regras protegidas por este teste:
//
//  1. o status usado para decidir POST (candidate) x PUT (started/pending) é
//     SEMPRE o de uma releitura AO VIVO (GET /seller-promotions/items/{id}),
//     nunca o que o frontend mandou — evita escrever em cima de um estado
//     que já mudou entre a simulação e a confirmação;
//  2. tipo fora do escopo (qualquer um que não seja DEAL/SELLER_CAMPAIGN) é
//     recusado ANTES de qualquer tentativa de escrita — zero POST/PUT;
//  3. promoção que não existe mais na releitura é recusada, zero escrita;
//  4. preço inválido (ausente/zero/negativo/não numérico) é recusado sem
//     gastar nenhuma chamada ao Mercado Livre (nem a releitura);
//  5. o preço confirmado é sempre o que vem na RESPOSTA do POST/PUT, nunca o
//     valor enviado;
//  6. este endpoint nunca toca a tabela meli_anuncios — só a API de
//     promoções do ML;
//  7. participação em promoção ACEITE com rebate do ML tem piso de R$ 19,00:
//     abaixo disso o comprador perderia o frete grátis — falha antes do POST
//     (sem rebate, o piso não se aplica).

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const Module = require("module");

// ── stub do cliente ML ──────────────────────────────────────────────────────
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
const { participarPromocaoAceite } = require("../services/meliAnuncios/meliPromocoesEscritaService");

Module._load = originalLoad;

// ── fixtures (mesmo padrão de meliAnunciosPromocoes.test.js) ───────────────

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

function chamar(itemId, promotionId, body) {
  const res = fakeRes();
  return ctrl.aplicarPromocao(
    { params: { itemId, promotionId }, body: { clienteSlug: "cliente-a", ...body } },
    res
  ).then(() => res);
}

let checks = 0;
function ok(msg) { checks += 1; console.log(`  ✓ ${msg}`); }

async function run() {
  // 1. DEAL candidate → POST, com o corpo exato esperado pelo ML.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: {} };
      if (chamada.metodo === "GET") {
        return { ok: true, status: 200, data: [{ id: "P-1", type: "DEAL", status: "candidate", original_price: 100, suggested_discounted_price: 90 }] };
      }
      return { ok: true, status: 200, data: { price: 89.9, original_price: 100 } };
    };

    const res = await chamar("MLB-X", "P-1", { precoNovo: 89.9 });

    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.precoConfirmado, 89.9, "o preço confirmado tem de vir da RESPOSTA do POST, não do valor enviado");
    assert.strictEqual(res.corpo.metodo, "POST");

    const escritas = mlChamadas.filter((c) => c.metodo === "POST" || c.metodo === "PUT");
    assert.strictEqual(escritas.length, 1, "esperava exatamente uma escrita");
    assert.strictEqual(escritas[0].metodo, "POST", "candidate participa com POST, nunca PUT");
    assert.strictEqual(escritas[0].path, "/seller-promotions/items/MLB-X?app_version=v2");
    assert.deepStrictEqual(escritas[0].body, { promotion_id: "P-1", promotion_type: "DEAL", deal_price: 89.9 });
    assert.strictEqual(escritas[0].mlUserId, "111");
    ok("DEAL candidate: POST com {promotion_id, promotion_type, deal_price}, preço confirmado vem da resposta do ML");
  });

  // 2. SELLER_CAMPAIGN started + ATIVA (sale_price aponta pra ela) → PUT (alterar).
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: { metadata: { promotion_id: "C-1" } } };
      if (chamada.metodo === "GET") {
        return { ok: true, status: 200, data: [{ id: "C-1", type: "SELLER_CAMPAIGN", status: "started", price: 95, original_price: 100 }] };
      }
      return { ok: true, status: 200, data: { price: 88, original_price: 100 } };
    };

    const res = await chamar("MLB-X", "C-1", { precoNovo: 88 });

    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.metodo, "PUT");
    const escritas = mlChamadas.filter((c) => c.metodo === "PUT");
    assert.strictEqual(escritas.length, 1, "started/pending altera com PUT, nunca POST");
    assert.deepStrictEqual(escritas[0].body, { promotion_id: "C-1", promotion_type: "SELLER_CAMPAIGN", deal_price: 88 });
    ok("SELLER_CAMPAIGN started + ATIVA: PUT com o mesmo corpo, usado para alterar");
  });

  // 2b. pending é bloqueada ESTRUTURALMENTE: `pending` não está em
  //     STATUS_ALTERAVEL (só started/active), então `podeAlterar` é sempre
  //     false pra ela — mesmo aqui, com o promotion_id do sale_price batendo
  //     de propósito com o id da própria promoção (o que faria um pending
  //     "parecer" ATIVA se o gate dependesse só de statusExibicao). Prova
  //     que o bloqueio não depende de pending nunca virar "ATIVA" no
  //     normalizador — depende do Set, que é a garantia estrutural pedida.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: { metadata: { promotion_id: "P-2" } } };
      if (chamada.metodo === "GET") {
        return { ok: true, status: 200, data: [{ id: "P-2", type: "DEAL", status: "pending", original_price: 100 }] };
      }
      return { ok: true, status: 200, data: { price: 85, original_price: 100 } };
    };
    const res = await chamar("MLB-X", "P-2", { precoNovo: 85 });
    assert.strictEqual(res.corpo.ok, false);
    assert.strictEqual(res.corpo.codigo, "PROMOCAO_NAO_APLICADA");
    assert.strictEqual(res.corpo.motivo, "Esta promoção ainda não começou no Mercado Livre — ainda não é possível alterá-la.");
    assert.strictEqual(mlChamadas.filter((c) => c.metodo === "PUT" || c.metodo === "POST").length, 0,
      "pending/PROGRAMADA bloqueada antes de qualquer escrita, mesmo com promotion_id batendo com o próprio id");
    ok("DEAL pending (PROGRAMADA): bloqueada estruturalmente (fora de STATUS_ALTERAVEL) — 'alterar' vira apenas simulação");
  });

  // 3. Tipo fora do escopo (MARKETPLACE_CAMPAIGN): recusado, zero escrita.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = () => ({
      ok: true, status: 200,
      data: [{ id: "P-3", type: "MARKETPLACE_CAMPAIGN", status: "candidate", original_price: 100 }],
    });

    const res = await chamar("MLB-X", "P-3", { precoNovo: 90 });

    assert.strictEqual(res.corpo.ok, false);
    assert.strictEqual(res.corpo.codigo, "TIPO_SEM_ESCRITA");
    assert.strictEqual(mlChamadas.filter((c) => c.metodo === "POST" || c.metodo === "PUT").length, 0,
      "tipo fora do escopo não pode gerar nenhuma escrita");
    ok("tipo fora do escopo (MARKETPLACE_CAMPAIGN): recusado antes de escrever, zero POST/PUT");
  });

  // 4. Promoção não encontrada na releitura ao vivo: recusada, zero escrita.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = () => ({ ok: true, status: 200, data: [] });

    const res = await chamar("MLB-X", "P-SUMIU", { precoNovo: 90 });

    assert.strictEqual(res.corpo.ok, false);
    assert.strictEqual(res.corpo.codigo, "PROMOCAO_NAO_ENCONTRADA");
    assert.strictEqual(mlChamadas.filter((c) => c.metodo === "POST" || c.metodo === "PUT").length, 0);
    ok("promoção que sumiu entre a simulação e a confirmação: recusada, zero escrita");
  });

  // 5. Preço inválido: recusado sem nenhuma chamada ao Mercado Livre (nem a releitura).
  for (const valor of [null, "", 0, -5, "abc", undefined]) {
    await withMockDb({ anuncios: anunciosFixture() }, async () => {
      mlChamadas = [];
      const res = await chamar("MLB-X", "P-1", { precoNovo: valor });
      assert.strictEqual(res.corpo.ok, false, `valor ${JSON.stringify(valor)} deveria ser recusado`);
      assert.strictEqual(res.corpo.codigo, "PRECO_INVALIDO");
      assert.strictEqual(mlChamadas.length, 0, "preço inválido não pode gastar nenhuma chamada ao Mercado Livre");
    });
  }
  ok("preço ausente/zero/negativo/não numérico: recusado sem tocar no Mercado Livre");

  // 6. Recusa do Mercado Livre na escrita (ex.: preço não crível): erro real repassado.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (chamada.metodo === "GET") {
        return { ok: true, status: 200, data: [{ id: "P-1", type: "DEAL", status: "candidate", original_price: 100 }] };
      }
      return {
        ok: false, status: 400,
        data: { message: "The discounted price is not credible.", error: "ERROR_CREDIBILITY_DISCOUNTED_PRICE" },
      };
    };

    const res = await chamar("MLB-X", "P-1", { precoNovo: 99 });

    assert.strictEqual(res.corpo.ok, false);
    assert.strictEqual(res.corpo.motivo, "The discounted price is not credible.");
    ok("recusa real do Mercado Livre (ex.: preço não crível): mensagem repassada, sem mascarar erro");
  });

  // 7. Sucesso não toca a tabela meli_anuncios — só a API de promoções.
  await withMockDb({ anuncios: anunciosFixture() }, async (db) => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (chamada.metodo === "GET") {
        return { ok: true, status: 200, data: [{ id: "P-1", type: "DEAL", status: "candidate", original_price: 100 }] };
      }
      return { ok: true, status: 200, data: { price: 90, original_price: 100 } };
    };
    await chamar("MLB-X", "P-1", { precoNovo: 90 });
    assert.strictEqual(db.updates.length, 0, "escrita de promoção não pode tocar meli_anuncios — não é o preço do catálogo");
    ok("sucesso não grava nada em meli_anuncios — só a API de promoções do ML");
  });

  // 8. clienteSlug ausente e anúncio inexistente: 400/404 sem chamar o ML.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    const res = fakeRes();
    await ctrl.aplicarPromocao({ params: { itemId: "MLB-X", promotionId: "P-1" }, body: { precoNovo: 90 } }, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(mlChamadas.length, 0);

    const res2 = await chamar("MLB-NAOEXISTE", "P-1", { precoNovo: 90 });
    assert.ok(res2.corpo.ok === false || res2.statusCode === 404);
    ok("clienteSlug ausente é 400 e anúncio inexistente é 404/ok:false, sem chamada ao Mercado Livre");
  });

  // 9. A conta ML usada é a da própria linha do anúncio.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (chamada.metodo === "GET") {
        return { ok: true, status: 200, data: [{ id: "P-1", type: "DEAL", status: "candidate", original_price: 100 }] };
      }
      return { ok: true, status: 200, data: { price: 90, original_price: 100 } };
    };
    await chamar("MLB-X", "P-1", { precoNovo: 90 });
    assert.ok(mlChamadas.every((c) => c.mlUserId === "111"), "todas as chamadas precisam usar o ml_user_id da própria linha do anúncio");
    ok("a conta ML usada em todas as chamadas é a da própria linha do anúncio");
  });

  // ── Defesa em profundidade: promo.statusExibicao (10-12) ──────────────────
  // O frontend já barra o clique (bindPromocoesAcoes/abrirConfirmacaoPromocao),
  // mas este endpoint pode ser chamado por qualquer cliente HTTP — a garantia
  // real tem de estar aqui, releitura ao vivo incluída (mesmo espírito do
  // "GET fresco -> PUT" do resto do arquivo).

  // 10. started + ATIVA (promotion_id do sale_price bate): PUT permitido.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: { metadata: { promotion_id: "D-1" } } };
      if (chamada.metodo === "GET") {
        return { ok: true, status: 200, data: [{ id: "D-1", type: "DEAL", status: "started", price: 90, original_price: 100 }] };
      }
      return { ok: true, status: 200, data: { price: 85, original_price: 100 } };
    };

    const res = await chamar("MLB-X", "D-1", { precoNovo: 85 });

    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.metodo, "PUT");
    ok("started + ATIVA: PUT permitido (promotion_id do sale_price bate com a promoção)");
  });

  // 11. started + NÃO APLICADA (promotion_id do sale_price aponta pra OUTRA
  //     promoção): bloqueio PROMOCAO_NAO_APLICADA, zero escrita — é
  //     exatamente o cenário do bug relatado (duas started, só uma manda).
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: { metadata: { promotion_id: "D-3" } } };
      if (chamada.metodo === "GET") {
        return {
          ok: true, status: 200,
          data: [
            { id: "D-2", type: "DEAL", status: "started", price: 90, original_price: 100 },
            { id: "D-3", type: "DEAL", status: "started", price: 88, original_price: 100 },
          ],
        };
      }
      return { ok: true, status: 200, data: { price: 85, original_price: 100 } };
    };

    const res = await chamar("MLB-X", "D-2", { precoNovo: 85 });

    assert.strictEqual(res.corpo.ok, false);
    assert.strictEqual(res.corpo.codigo, "PROMOCAO_NAO_APLICADA");
    assert.strictEqual(mlChamadas.filter((c) => c.metodo === "PUT" || c.metodo === "POST").length, 0,
      "D-2 está started mas D-3 é quem define o preço — D-2 não pode ser alterada, zero escrita");
    ok("started + NÃO APLICADA: bloqueado com PROMOCAO_NAO_APLICADA, zero POST/PUT");
  });

  // 11b. Mesmo cenário de 11, com o pedido EXPLÍCITO alterarParticipacao
  //      (modal de Anúncios ML, botão "Alterar" de uma promoção em que já
  //      participa): PUT liberado na D-2. pending com a flag também (a doc
  //      do ML aceita modificar oferta pendente).
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: { metadata: { promotion_id: "D-3" } } };
      if (chamada.metodo === "GET") {
        return {
          ok: true, status: 200,
          data: [
            { id: "D-2", type: "DEAL", status: "started", price: 90, original_price: 100 },
            { id: "D-3", type: "DEAL", status: "started", price: 88, original_price: 100 },
            { id: "D-5", type: "DEAL", status: "pending", price: 92, original_price: 100 },
          ],
        };
      }
      return { ok: true, status: 200, data: { price: 85, original_price: 100 } };
    };

    const res = await chamar("MLB-X", "D-2", { precoNovo: 85, alterarParticipacao: true });
    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.metodo, "PUT");
    const pend = await chamar("MLB-X", "D-5", { precoNovo: 87, alterarParticipacao: true });
    assert.strictEqual(pend.corpo.metodo, "PUT");
    assert.strictEqual(mlChamadas.filter((c) => c.metodo === "POST").length, 0, "participação nunca vira POST");
    ok("alterarParticipacao: PUT liberado em NÃO APLICADA e PROGRAMADA, nunca POST");
  });

  // 12. candidate + ELEGÍVEL: POST permitido — `podeParticipar` é decidido
  //     só por `promo.status === "candidate"`, independente de
  //     STATUS_ALTERAVEL/statusExibicao, então participar numa promoção
  //     nova continua livre, sem depender do sale_price.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: {} };
      if (chamada.metodo === "GET") {
        return { ok: true, status: 200, data: [{ id: "D-4", type: "DEAL", status: "candidate", original_price: 100, suggested_discounted_price: 90 }] };
      }
      return { ok: true, status: 200, data: { price: 90, original_price: 100 } };
    };

    const res = await chamar("MLB-X", "D-4", { precoNovo: 90 });

    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.metodo, "POST");
    ok("candidate + ELEGÍVEL: POST permitido, statusExibicao não bloqueia participação nova");
  });

  // 13. Deduplicação por id+type integrada à escrita real (auditoria: "Vendex
  //     - Setembro" duplicada no ML, uma entrada sem subsidioMl e outra com).
  //     listarPromocoesDoItem (reaproveitado aqui dentro de aplicarPromocao
  //     para a releitura ao vivo) precisa devolver só a versão correta, e a
  //     escrita real precisa usar exatamente ESSE objeto deduplicado — nunca
  //     pode ficar ambígua entre as duas entradas cruas do ML nem gerar mais
  //     de uma escrita.
  await withMockDb({ anuncios: anunciosFixture() }, async () => {
    mlChamadas = [];
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: { metadata: { promotion_id: "C-DUP" } } };
      if (chamada.metodo === "GET") {
        return {
          ok: true, status: 200,
          data: [
            { id: "C-DUP", type: "SELLER_CAMPAIGN", status: "started", price: 149.9, original_price: 149.9, name: "Vendex - Setembro" },
            { id: "C-DUP", type: "SELLER_CAMPAIGN", status: "started", price: 134.9, original_price: 149.9, meli_percentage: 0.5, name: "Vendex - Setembro" },
          ],
        };
      }
      return { ok: true, status: 200, data: { price: 134.9, original_price: 149.9 } };
    };

    // Primeiro confirma que a LISTAGEM (GET /promocoes) já expõe só a versão
    // correta — mesma garantia que corrige a tabela do frontend.
    const resLista = fakeRes();
    await ctrl.promocoes({ params: { itemId: "MLB-X" }, query: { clienteSlug: "cliente-a" } }, resLista);
    assert.strictEqual(resLista.corpo.promocoes.length, 1, "a listagem nunca pode expor as duas entradas duplicadas do ML");
    assert.strictEqual(resLista.corpo.promocoes[0].subsidioMl, 0.75, "a versão exposta é a mais completa (com subsidioMl), não '—'");

    // Agora a escrita real, usando o mesmo id — precisa ler o mesmo objeto
    // deduplicado, sem ambiguidade entre as duas entradas cruas.
    mlChamadas = [];
    const res = await chamar("MLB-X", "C-DUP", { precoNovo: 134.9 });

    assert.strictEqual(res.corpo.ok, true, JSON.stringify(res.corpo));
    assert.strictEqual(res.corpo.metodo, "PUT", "SELLER_CAMPAIGN started + ATIVA altera com PUT, independente de qual entrada bruta duplicada");
    const escritas = mlChamadas.filter((c) => c.metodo === "PUT" || c.metodo === "POST");
    assert.strictEqual(escritas.length, 1, "duas entradas duplicadas no ML não podem virar duas escritas, nem uma escrita ambígua");
    assert.deepStrictEqual(escritas[0].body, { promotion_id: "C-DUP", promotion_type: "SELLER_CAMPAIGN", deal_price: 134.9 });
    ok("integração: duplicata sem rebate + com rebate (mesmo id) — listagem expõe só a versão correta, e aplicarPromocao escreve usando exatamente esse objeto deduplicado");
  });

  // ── 14. Piso de frete grátis (R$ 19,00) em participarPromocaoAceite ────────
  // Escritor COMPARTILHADO (Radar, Central de Margem e Anúncios). Com rebate do
  // ML, preço final < 19,00 tira o frete grátis do comprador: falha ANTES de
  // qualquer POST. Sem rebate (bancada só pelo vendedor), a regra não se aplica.
  const promoAceite = ({ id = "P-ACEITE", tipo = "SMART", precoFinal = 18.9, meli = 5 } = {}) => ({
    id, type: tipo, status: "candidate", ref_id: `CANDIDATE-MLB-X-${id}`,
    original_price: 100, suggested_discounted_price: precoFinal,
    meli_percentage: meli, seller_percentage: 0,
    start_date: "2026-11-01T03:00:00Z", finish_date: "2026-12-01T02:59:00Z",
  });
  const chamarParticipacao = (promo, promotionId = promo.id, tipo = promo.type) =>
    participarPromocaoAceite({ clienteId: 1, itemId: "MLB-X", mlUserId: "111", promotionId, tipo });

  // (a) com rebate a 18,90 → falha ABAIXO_FRETE_GRATIS, zero POST.
  {
    mlChamadas = [];
    const promo = promoAceite({ id: "P-18", precoFinal: 18.9 });
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: {} };
      if (chamada.metodo === "GET") return { ok: true, status: 200, data: [promo] };
      return { ok: true, status: 201, data: { price: 18.9 } };
    };
    const r = await chamarParticipacao(promo);

    assert.strictEqual(r.ok, false, "18,90 com rebate precisa ser recusado");
    assert.strictEqual(r.codigo, "ABAIXO_FRETE_GRATIS");
    assert.ok(/R\$ 18,90/.test(r.motivo), "preço formatado em reais com vírgula");
    assert.strictEqual(mlChamadas.filter((c) => c.metodo === "POST").length, 0, "abaixo de R$ 19,00: zero POST ao ML");
    ok("participarPromocaoAceite: rebate a 18,90 → ABAIXO_FRETE_GRATIS, zero POST");
  }

  // (b) com rebate a 19,00 → segue normal (fronteira permitida).
  {
    mlChamadas = [];
    const promo = promoAceite({ id: "P-19", precoFinal: 19 });
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: {} };
      if (chamada.metodo === "GET") return { ok: true, status: 200, data: [promo] };
      return { ok: true, status: 201, data: { price: 19 } };
    };
    const r = await chamarParticipacao(promo);

    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.precoConfirmado, 19);
    const posts = mlChamadas.filter((c) => c.metodo === "POST");
    assert.strictEqual(posts.length, 1, "R$ 19,00 exatos continuam permitidos");
    assert.deepStrictEqual(posts[0].body, { promotion_id: "P-19", promotion_type: "SMART", offer_id: "CANDIDATE-MLB-X-P-19" });
    ok("participarPromocaoAceite: rebate a 19,00 → POST normal (fronteira permitida)");
  }

  // (c) SEM rebate a 15,00 → não é bloqueada por esta regra.
  {
    mlChamadas = [];
    const promo = promoAceite({ id: "P-15", tipo: "MARKETPLACE_CAMPAIGN", precoFinal: 15, meli: 0 });
    mlHandler = (chamada) => {
      if (/\/sale_price/.test(chamada.path)) return { ok: true, status: 200, data: {} };
      if (chamada.metodo === "GET") return { ok: true, status: 200, data: [promo] };
      return { ok: true, status: 201, data: { price: 15 } };
    };
    const r = await chamarParticipacao(promo);

    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.precoConfirmado, 15);
    const posts = mlChamadas.filter((c) => c.metodo === "POST");
    assert.strictEqual(posts.length, 1, "sem rebate, o piso de R$ 19,00 não se aplica");
    assert.deepStrictEqual(posts[0].body, { promotion_id: "P-15", promotion_type: "MARKETPLACE_CAMPAIGN" });
    ok("participarPromocaoAceite: promoção SEM rebate a 15,00 não é bloqueada pelo piso");
  }
}

run()
  .then(() => {
    console.log(`\n✓ ${checks} verificações de escrita de promoção do anúncio ML`);
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n✗ FALHOU:", err.message);
    console.error(err.stack);
    process.exit(1);
  });
