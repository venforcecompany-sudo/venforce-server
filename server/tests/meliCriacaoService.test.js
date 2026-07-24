// server/tests/meliCriacaoService.test.js
// Testes unitários do serviço de criação de anúncios ML (sem rede / sem PG).
const assert = require("assert");
const Module = require("module");

const chamadasMl = [];
const consultasDb = [];
let mlFetchImpl = async () => ({ ok: true, status: 200, data: {} });

const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (
    request === "pg" ||
    request.endsWith("/config/database") ||
    request.endsWith("\\config\\database") ||
    request.includes("config/database") ||
    request.includes("utils/mlClient")
  ) {
    if (request === "pg" || request.includes("config/database")) {
      return {
        query: async (sql, params) => {
          consultasDb.push({ sql: String(sql), params });
          return { rows: [{ id: 1 }] };
        },
        pool: {
          query: async (sql, params) => {
            consultasDb.push({ sql: String(sql), params });
            return { rows: [{ id: 1 }] };
          },
        },
      };
    }
    if (request.includes("utils/mlClient")) {
      return {
        mlFetch: async (...args) => {
          chamadasMl.push(args);
          return mlFetchImpl(...args);
        },
        getValidMlTokenByCliente: async () => "fake-token",
      };
    }
  }
  if (request === "./meliAnunciosService") {
    return {
      resolverMlUserId: async () => "123456",
      upsertAnuncios: async () => {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  validarDadosPublicacao,
  montarPayloadItem,
  mapearErroMl,
  validarPrecoAtacado,
  normalizarFaixasPrecoAtacado,
  cadastrarPrecosAtacado,
  createMercadoLivreItem,
  retryPrecosAtacado,
  TITLE_MAX,
} = require("../services/meliAnuncios/meliCriacaoService");

Module._load = originalLoad;

function baseDados(overrides) {
  return Object.assign(
    {
      title: "Fone Bluetooth Premium Com Case",
      category_id: "MLB1234",
      price: 199.9,
      currency_id: "BRL",
      available_quantity: 5,
      condition: "new",
      buying_mode: "buy_it_now",
      listing_type_id: "gold_special",
      pictures: [{ source: "https://http2.mlstatic.com/exemplo.jpg" }],
      attributes: [{ id: "BRAND", value_name: "Genérica" }],
      requiredAttributeIds: ["BRAND"],
    },
    overrides || {}
  );
}

// 1) Anúncio simples — payload montado corretamente
{
  const payload = montarPayloadItem(baseDados());
  assert.strictEqual(payload.title, "Fone Bluetooth Premium Com Case");
  assert.strictEqual(payload.category_id, "MLB1234");
  assert.strictEqual(payload.price, 199.9);
  assert.strictEqual(payload.available_quantity, 5);
  assert.strictEqual(payload.condition, "new");
  assert.strictEqual(payload.pictures.length, 1);
  assert.strictEqual(payload.pictures[0].source, "https://http2.mlstatic.com/exemplo.jpg");
  assert.ok(Array.isArray(payload.attributes));
  assert.strictEqual(payload.attributes[0].id, "BRAND");
  console.log("ok — criar anúncio simples (payload)");
}

// 2) Atributos obrigatórios
{
  const erros = validarDadosPublicacao(
    baseDados({ attributes: [], requiredAttributeIds: ["BRAND", "MODEL"] })
  );
  assert.ok(erros.some((e) => e.campo === "attributes"));
  assert.ok(erros.some((e) => String(e.mensagem).includes("BRAND")));
  console.log("ok — validação atributos obrigatórios");
}

// 3) Erro de categoria inválida (API)
{
  const mapped = mapearErroMl(
    {
      message: "Validation error",
      error: "validation_error",
      cause: [
        {
          code: "item.category_id.invalid",
          message: "Invalid category",
        },
      ],
    },
    400
  );
  assert.strictEqual(mapped.ok, false);
  assert.strictEqual(mapped.erros[0].codigo, "item.category_id.invalid");
  assert.strictEqual(mapped.erros[0].campo, "category_id");
  assert.ok(mapped.erros[0].sugestao);
  console.log("ok — erro categoria inválida");
}

// 4) Sem imagem
{
  const erros = validarDadosPublicacao(baseDados({ pictures: [] }));
  assert.ok(erros.some((e) => e.campo === "pictures"));
  console.log("ok — validação sem imagem");
}

// 5) Sem permissão (seller.unable_to_list)
{
  const mapped = mapearErroMl(
    {
      message: "Seller unable to list",
      error: "seller.unable_to_list",
      cause: [{ code: "seller.unable_to_list", message: "Unable to list" }],
    },
    403
  );
  assert.strictEqual(mapped.erros[0].codigo, "seller.unable_to_list");
  assert.ok(/permissão/i.test(mapped.erros[0].mensagem));
  console.log("ok — erro sem permissão");
}

// 6) Descrição NÃO entra no payload do item (etapa separada)
{
  const payload = montarPayloadItem(
    baseDados({ description: "Texto longo da descrição do produto" })
  );
  assert.strictEqual(payload.description, undefined);
  assert.strictEqual(payload.plain_text, undefined);
  console.log("ok — descrição fora do payload do item");
}

// Extra: título acima do limite
{
  const longTitle = "A".repeat(TITLE_MAX + 1);
  const erros = validarDadosPublicacao(baseDados({ title: longTitle }));
  assert.ok(erros.some((e) => e.campo === "title"));
  console.log("ok — limite de título");
}

// Extra: variações genéricas
{
  const payload = montarPayloadItem(
    baseDados({
      variations: [
        {
          price: 210,
          available_quantity: 2,
          attribute_combinations: [
            { id: "COLOR", value_name: "Preto" },
            { id: "SIZE", value_name: "M" },
          ],
        },
      ],
    })
  );
  assert.ok(Array.isArray(payload.variations));
  assert.strictEqual(payload.variations.length, 1);
  assert.strictEqual(payload.variations[0].attribute_combinations.length, 2);
  assert.strictEqual(payload.available_quantity, undefined);
  console.log("ok — estrutura de variações");
}

// Extra: sale_terms flexíveis
{
  const payload = montarPayloadItem(
    baseDados({
      sale_terms: [
        { id: "WARRANTY_TYPE", value_name: "Garantia do vendedor" },
        { id: "WARRANTY_TIME", value_name: "90 dias" },
      ],
    })
  );
  assert.strictEqual(payload.sale_terms.length, 2);
  console.log("ok — sale_terms");
}

// Preço de atacado: regras locais e ordenação.
{
  const config = {
    habilitado: true,
    faixas: [
      { quantidadeMinima: 20, precoUnitario: 85 },
      { quantidadeMinima: 10, precoUnitario: 90 },
    ],
  };
  assert.deepStrictEqual(normalizarFaixasPrecoAtacado(config), [
    { quantidadeMinima: 10, precoUnitario: 90 },
    { quantidadeMinima: 20, precoUnitario: 85 },
  ]);
  assert.deepStrictEqual(validarPrecoAtacado(config, 100), []);

  assert.ok(
    validarPrecoAtacado(
      {
        habilitado: true,
        faixas: [
          { quantidadeMinima: 10, precoUnitario: 90 },
          { quantidadeMinima: 10, precoUnitario: 80 },
        ],
      },
      100
    ).some((e) => /repetida/i.test(e.mensagem))
  );
  assert.ok(
    validarPrecoAtacado(
      {
        habilitado: true,
        faixas: [
          { quantidadeMinima: 10, precoUnitario: 90 },
          { quantidadeMinima: 20, precoUnitario: 95 },
        ],
      },
      100
    ).some((e) => /diminuir/i.test(e.mensagem))
  );
  assert.ok(
    validarPrecoAtacado(
      {
        habilitado: true,
        faixas: [{ quantidadeMinima: 1, precoUnitario: 100 }],
      },
      100
    ).some((e) => /maior que 1/i.test(e.mensagem))
  );
  assert.ok(
    validarPrecoAtacado(
      {
        habilitado: true,
        faixas: Array.from({ length: 6 }, (_, index) => ({
          quantidadeMinima: index + 2,
          precoUnitario: 90 - index,
        })),
      },
      100
    ).some((e) => /máximo 5/i.test(e.mensagem))
  );
  console.log("ok — validação e ordenação do preço de atacado");
}

function respostaUsuarioBusiness() {
  return {
    ok: true,
    status: 200,
    data: {
      id: 123456,
      nickname: "VENDEDOR_TESTE",
      tags: ["business"],
      status: { site_status: "active", list: { allow: true } },
    },
  };
}

function respostaPrecos(faixas) {
  return {
    ok: true,
    status: 200,
    data: {
      prices: [
        {
          id: "standard-1",
          type: "standard",
          amount: 100,
          currency_id: "BRL",
          conditions: { context_restrictions: [] },
        },
        ...(faixas || []).map((faixa, index) => ({
          id: `atacado-${index + 1}`,
          type: "standard",
          amount: faixa.precoUnitario,
          currency_id: "BRL",
          conditions: {
            context_restrictions: [
              "channel_marketplace",
              "user_type_business",
            ],
            min_purchase_unit: faixa.quantidadeMinima,
          },
        })),
      ],
    },
  };
}

(async () => {
  const faixas = [
    { quantidadeMinima: 10, precoUnitario: 90 },
    { quantidadeMinima: 20, precoUnitario: 85 },
  ];

  // Cadastro: GET preços -> POST quantity -> GET confirmação.
  chamadasMl.length = 0;
  let consultaPrecos = 0;
  let payloadAtacado = null;
  mlFetchImpl = async (_clienteId, path, options) => {
    if (path.endsWith("/prices") && (!options || options.method !== "POST")) {
      consultaPrecos += 1;
      return respostaPrecos(consultaPrecos === 1 ? [] : faixas);
    }
    if (path.endsWith("/prices/standard/quantity")) {
      payloadAtacado = JSON.parse(options.body);
      return { ok: true, status: 200, data: {} };
    }
    throw new Error(`Chamada inesperada: ${path}`);
  };

  const cadastro = await cadastrarPrecosAtacado({
    clienteId: 1,
    itemId: "MLB123",
    precoAtacado: { habilitado: true, faixas: [...faixas].reverse() },
    precoNormal: 100,
    moeda: "BRL",
  });
  assert.strictEqual(cadastro.ok, true);
  assert.deepStrictEqual(cadastro.faixas, faixas);
  assert.strictEqual(payloadAtacado.prices[0].id, "standard-1");
  assert.strictEqual(payloadAtacado.prices[1].currency_id, "BRL");
  assert.deepStrictEqual(
    payloadAtacado.prices[1].conditions.context_restrictions,
    ["channel_marketplace", "user_type_business"]
  );
  assert.deepStrictEqual(
    chamadasMl.map((call) => [call[1], call[2] && call[2].method]),
    [
      ["/items/MLB123/prices", undefined],
      ["/items/MLB123/prices/standard/quantity", "POST"],
      ["/items/MLB123/prices", undefined],
    ]
  );
  console.log("ok — sequência e payload do cadastro de atacado");

  // O preço standard consultado é a referência final para a validação.
  chamadasMl.length = 0;
  mlFetchImpl = async (_clienteId, path) => {
    if (path === "/items/MLBSTANDARD/prices") {
      return {
        ok: true,
        status: 200,
        data: {
          prices: [
            {
              id: "standard-real",
              type: "standard",
              amount: 88,
              currency_id: "BRL",
              conditions: { context_restrictions: [] },
            },
          ],
        },
      };
    }
    throw new Error(`Chamada inesperada: ${path}`);
  };
  const standardAutoritativo = await cadastrarPrecosAtacado({
    clienteId: 1,
    itemId: "MLBSTANDARD",
    precoAtacado: {
      habilitado: true,
      faixas: [{ quantidadeMinima: 10, precoUnitario: 90 }],
    },
    precoNormal: 100,
    moeda: "BRL",
  });
  assert.strictEqual(standardAutoritativo.ok, false);
  assert.strictEqual(
    standardAutoritativo.codigo,
    "VALIDACAO_PRECO_ATACADO"
  );
  assert.strictEqual(
    chamadasMl.some(
      (call) =>
        call[1] === "/items/MLBSTANDARD/prices/standard/quantity"
    ),
    false
  );
  console.log("ok — preço standard consultado valida o desconto");

  // Vendedor sem tag business é bloqueado antes do POST /items.
  chamadasMl.length = 0;
  mlFetchImpl = async (_clienteId, path) => {
    if (path === "/users/123456") {
      const resposta = respostaUsuarioBusiness();
      resposta.data.tags = [];
      return resposta;
    }
    throw new Error(`Chamada inesperada: ${path}`);
  };
  const naoElegivel = await createMercadoLivreItem({
    clienteId: 1,
    clienteSlug: "cliente-teste",
    dados: baseDados({
      precoAtacado: { habilitado: true, faixas },
    }),
    createdBy: 10,
  });
  assert.strictEqual(naoElegivel.ok, false);
  assert.strictEqual(naoElegivel.codigo, "PRECO_ATACADO_NAO_ELEGIVEL");
  assert.strictEqual(
    chamadasMl.some((call) => call[1] === "/items"),
    false
  );
  console.log("ok — vendedor sem tag business não cria anúncio B2B");

  // Falha após POST /items mantém a criação como sucesso parcial.
  chamadasMl.length = 0;
  mlFetchImpl = async (_clienteId, path, options) => {
    if (path === "/users/123456") return respostaUsuarioBusiness();
    if (path === "/items" && options && options.method === "POST") {
      return {
        ok: true,
        status: 201,
        data: {
          id: "MLBCRIADO",
          title: "Produto criado",
          price: 100,
          currency_id: "BRL",
          status: "active",
        },
      };
    }
    if (path === "/items/MLBCRIADO/prices") return respostaPrecos([]);
    if (path === "/items/MLBCRIADO/prices/standard/quantity") {
      return {
        ok: false,
        status: 400,
        data: { error: "bad_request", message: "Falha simulada" },
      };
    }
    throw new Error(`Chamada inesperada: ${path}`);
  };

  const parcial = await createMercadoLivreItem({
    clienteId: 1,
    clienteSlug: "cliente-teste",
    dados: baseDados({
      price: 100,
      precoAtacado: { habilitado: true, faixas },
    }),
    createdBy: 10,
  });
  assert.strictEqual(parcial.ok, true);
  assert.strictEqual(parcial.item_id, "MLBCRIADO");
  assert.strictEqual(parcial.precoAtacadoSolicitado, true);
  assert.strictEqual(parcial.precoAtacadoSalvo, false);
  assert.strictEqual(parcial.precoAtacadoErro.codigo, "PRECO_ATACADO_GRAVACAO");
  assert.strictEqual(
    parcial.precoAtacadoErro.motivo,
    "Anúncio criado, mas não foi possível cadastrar os preços de atacado."
  );
  assert.strictEqual(
    chamadasMl.filter(
      (call) => call[1] === "/items" && call[2] && call[2].method === "POST"
    ).length,
    1
  );
  assert.ok(
    consultasDb.some(
      (query) =>
        query.sql.includes("preco_atacado_status") &&
        query.params &&
        query.params.includes("erro")
    )
  );
  console.log("ok — falha do atacado retorna criação parcial com ITEM_ID");

  // Retry usa o item existente e nunca recria o anúncio.
  chamadasMl.length = 0;
  consultaPrecos = 0;
  mlFetchImpl = async (_clienteId, path, options) => {
    if (path === "/users/123456") return respostaUsuarioBusiness();
    if (path === "/items/MLBCRIADO/prices") {
      consultaPrecos += 1;
      return respostaPrecos(consultaPrecos === 1 ? [] : faixas);
    }
    if (path === "/items/MLBCRIADO/prices/standard/quantity") {
      return { ok: true, status: 200, data: {} };
    }
    throw new Error(`Chamada inesperada no retry: ${path}`);
  };

  const retry = await retryPrecosAtacado({
    clienteId: 1,
    itemId: "MLBCRIADO",
    dados: { precoAtacado: { habilitado: true, faixas } },
  });
  assert.strictEqual(retry.ok, true);
  assert.strictEqual(retry.item_id, "MLBCRIADO");
  assert.strictEqual(retry.precoAtacadoSalvo, true);
  assert.strictEqual(
    chamadasMl.some((call) => call[1] === "/items"),
    false
  );
  assert.ok(
    consultasDb.some(
      (query) =>
        query.sql.includes("UPDATE meli_anuncio_publicacoes") &&
        query.params &&
        query.params.includes("salvo")
    )
  );
  console.log("ok — retry cadastra faixas sem recriar o anúncio");

  console.log("\nTodos os testes de meliCriacaoService passaram.");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
