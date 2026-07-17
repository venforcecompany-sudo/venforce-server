// server/tests/meliCriacaoService.test.js
// Testes unitários do serviço de criação de anúncios ML (sem rede / sem PG).
const assert = require("assert");
const Module = require("module");

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
        query: async () => ({ rows: [] }),
        pool: { query: async () => ({ rows: [] }) },
      };
    }
    if (request.includes("utils/mlClient")) {
      return {
        mlFetch: async () => ({ ok: true, status: 200, data: {} }),
        getValidMlTokenByCliente: async () => "fake-token",
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  validarDadosPublicacao,
  montarPayloadItem,
  mapearErroMl,
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

console.log("\nTodos os testes de meliCriacaoService passaram.");
