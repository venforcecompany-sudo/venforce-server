process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const XLSX = require("xlsx");
const pool = require("../config/database");
const mlClient = require("../utils/mlClient");
const contextoPrecificacao = require("../services/automacoes/contextoPrecificacaoService");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

function sellerSku(value) {
  return { id: "SELLER_SKU", value_name: value };
}

function baseBody(id, extras = {}) {
  return {
    id,
    title: `Produto ${id}`,
    seller_id: 222,
    status: "active",
    listing_type_id: "gold_special",
    category_id: "MLB1234",
    price: 100,
    shipping: { logistic_type: "cross_docking" },
    ...extras,
  };
}

// 3 variations, SELLER_SKU presente em 2 e fallback seller_custom_field na 3ª
// (attributes ausente) — obriga o multiget complementar include_attributes=all.
const legadoIncompleto = baseBody("MLBLEGACY1", {
  title: "Calça Legada",
  variations: [
    {
      id: 7001,
      seller_custom_field: "FALLBACK-36",
      attribute_combinations: [{ value_name: "Bege" }, { value_name: "36" }],
    },
    {
      id: 7002,
      attribute_combinations: [{ value_name: "Bege" }, { value_name: "38" }],
    },
    {
      id: 7003,
      seller_custom_field: "LEGACY-40",
      attribute_combinations: [{ value_name: "Bege" }, { value_name: "40" }],
    },
  ],
});

const legadoCompleto = baseBody("MLBLEGACY1", {
  title: "Calça Legada",
  variations: [
    {
      id: 7001,
      seller_custom_field: "FALLBACK-36",
      attributes: [sellerSku("SKU-36")],
      attribute_combinations: [{ value_name: "Bege" }, { value_name: "36" }],
    },
    {
      id: 7002,
      attributes: [sellerSku("SKU-38")],
      attribute_combinations: [{ value_name: "Bege" }, { value_name: "38" }],
    },
    {
      id: 7003,
      seller_custom_field: "LEGACY-40",
      attributes: [],
      attribute_combinations: [{ value_name: "Bege" }, { value_name: "40" }],
    },
  ],
});

// 2 variations com o MESMO SELLER_SKU — dedup só na célula, Variações continua 2.
const legadoSkuDuplicado = baseBody("MLBDUP1", {
  title: "Camiseta Duplicada",
  variations: [
    { id: 8001, attributes: [sellerSku("SKU-REPETIDO")], attribute_combinations: [{ value_name: "P" }] },
    { id: 8002, attributes: [sellerSku("SKU-REPETIDO")], attribute_combinations: [{ value_name: "M" }] },
  ],
});

// Variation sem SKU (nem SELLER_SKU nem seller_custom_field) — continua gerando linha.
const legadoSemSku = baseBody("MLBSEMSKU1", {
  title: "Produto Sem SKU",
  variations: [
    { id: 9001, attributes: [], attribute_combinations: [{ value_name: "Único" }] },
  ],
});

const simples = baseBody("MLBSIMPLE1", {
  title: "Produto Simples",
  attributes: [sellerSku("SKU-SIMPLES")],
  variations: [],
});

const familyIdGrande = "18446744073709551615";
const up1 = baseBody("MLBUP1", {
  title: "Tênis Corrida - Bege 36",
  family_name: "Tênis Corrida",
  family_id: familyIdGrande,
  user_product_id: "MLBU9000",
  attributes: [sellerSku("SKU-UP")],
  variations: [],
});
const up2 = baseBody("MLBUP2", {
  title: "Tênis Corrida - Bege 36 Premium",
  family_name: "Tênis Corrida",
  family_id: familyIdGrande,
  user_product_id: "MLBU9000",
  attributes: [sellerSku("SKU-UP")],
  variations: [],
});

let cenario = "legado";
const chamadas = [];

async function mlFetchFake(clienteId, path, options = {}) {
  chamadas.push({ clienteId, path, options });

  if (path.startsWith("/users/222/items/search?")) {
    return {
      ok: true,
      status: 200,
      data: {
        results: cenario === "legado"
          ? ["MLBLEGACY1", "MLBSIMPLE1"]
          : cenario === "legado_completo" ? ["MLBLEGACY1"]
          : cenario === "dup_sem_sku" ? ["MLBDUP1", "MLBSEMSKU1"]
          : ["MLBUP1", "MLBUP2"],
        scroll_id: null,
      },
    };
  }

  if (path.startsWith("/items?ids=")) {
    const bodies = cenario === "legado"
      ? [legadoIncompleto, simples]
      : cenario === "legado_completo" ? [legadoCompleto]
      : cenario === "dup_sem_sku" ? [legadoSkuDuplicado, legadoSemSku]
      : [up1, up2];
    return { ok: true, status: 200, data: bodies.map((body) => ({ code: 200, body })) };
  }

  if (path === "/items/MLBLEGACY1?include_attributes=all") {
    return { ok: true, status: 200, data: legadoCompleto };
  }

  const salePrice = path.match(/^\/items\/([^/]+)\/sale_price\?context=channel_marketplace$/);
  if (salePrice) {
    const amount = {
      MLBLEGACY1: 120,
      MLBSIMPLE1: 80,
      MLBDUP1: 60,
      MLBSEMSKU1: 70,
      MLBUP1: 90,
      MLBUP2: 140,
    }[salePrice[1]];
    return { ok: true, status: 200, data: { amount, regular_amount: amount } };
  }

  if (path.startsWith("/sites/MLB/listing_prices?")) {
    return {
      ok: true,
      status: 200,
      data: { sale_fee_amount: 12, sale_fee_details: { percentage_fee: 10 } },
    };
  }

  if (path.startsWith("/users/222/shipping_options/free?")) {
    return { ok: true, status: 200, data: { coverage: { all_country: { list_cost: 18 } } } };
  }

  throw new Error(`Caminho ML não mapeado no teste: ${path}`);
}

function lerWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellNF: true });
  const matriz = workbook.Sheets["Matriz Mercado Livre"];
  const resumo = workbook.Sheets.Resumo;
  return {
    workbook,
    matriz,
    matrizRows: XLSX.utils.sheet_to_json(matriz, { header: 1, defval: null, raw: true }),
    resumoRows: XLSX.utils.sheet_to_json(resumo, { header: 1, defval: null, raw: true }),
  };
}

function valorResumo(rows, rotulo) {
  return rows.find((row) => row[0] === rotulo)?.[1];
}

function chamadasDe(trecho) {
  return chamadas.filter((call) => call.path.includes(trecho));
}

async function gerar(gerarPlanilhaPrecificacaoSemBase) {
  chamadas.length = 0;
  return gerarPlanilhaPrecificacaoSemBase({ clienteSlugRaw: "cliente-x", clienteContaId: 102 });
}

async function run() {
  const originalPoolQuery = pool.query;
  const originalMlFetch = mlClient.mlFetch;
  const originalExigir = contextoPrecificacao.exigirContextoGrantMl;

  pool.query = async (sql, params = []) => {
    const q = String(sql).replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT produto_id, custo_produto, imposto_percentual, taxa_fixa FROM custos")) {
      ok("Base é carregada somente pelo base_id selecionado", params[0] === 77);
      return {
        rows: [{
          produto_id: "MLBLEGACY1",
          custo_produto: 25,
          imposto_percentual: 8,
          taxa_fixa: 3,
        }],
      };
    }
    throw new Error(`Query não mapeada: ${q}`);
  };
  mlClient.mlFetch = mlFetchFake;
  contextoPrecificacao.exigirContextoGrantMl = async () => ({
    cliente: { id: 90, nome: "Cliente X", slug: "cliente-x" },
    mlUserId: "222",
    basesMeli: [{ id: 77 }],
    basesConta: [{ id: 77 }],
    base: { id: 77, nome: "Base MLB" },
  });

  for (const modulo of [
    "../services/automacoes/precoItemService",
    "../services/automacoes/diagnosticoService",
    "../services/automacoes/planilhaPrecificacaoSemBaseService",
  ]) {
    delete require.cache[require.resolve(modulo)];
  }

  try {
    const { gerarPlanilhaPrecificacaoSemBase } = require("../services/automacoes/planilhaPrecificacaoSemBaseService");

    cenario = "legado";
    const resultadoLegado = await gerar(gerarPlanilhaPrecificacaoSemBase);
    const legado = lerWorkbook(resultadoLegado.buffer);
    const headers = legado.matrizRows[2];
    const dataRows = legado.matrizRows.slice(3);
    const linhasLegado = dataRows.filter((row) => row[0] === "MLBLEGACY1");

    ok("Workbook adota as 6 colunas iniciais exigidas", JSON.stringify(headers.slice(0, 6)) === JSON.stringify([
      "MLB", "MLBU", "SKU(s)", "Variações", "Título", "Marketplace",
    ]));
    ok("ID Variação Legada não aparece mais na planilha", !headers.includes("ID Variação Legada"));
    ok("Family ID não aparece mais na planilha", !headers.includes("Family ID"));
    ok("Chave Base não aparece mais na planilha", !headers.includes("Chave Base"));

    ok("MLB legado com 3 variations gera 1 linha (não 3)", linhasLegado.length === 1);
    ok("SKU(s) contém os 3 SKUs na ordem das variations", linhasLegado[0][2] === "SKU-36; SKU-38; LEGACY-40");
    ok("Variações reporta a quantidade real (3)", linhasLegado[0][3] === 3);
    ok("preço efetivo é o único valor do MLB", linhasLegado[0][15] === 120);
    ok("comissão percentual é o único valor do MLB", linhasLegado[0][10] === 0.1);
    ok("frete é o único valor do MLB", linhasLegado[0][9] === 18);
    ok("custo da Base por MLB é aplicado uma vez", linhasLegado[0][7] === 25);
    ok("imposto da Base por MLB é aplicado uma vez", linhasLegado[0][8] === 0.08);
    ok("taxa fixa da Base por MLB é aplicada uma vez", linhasLegado[0][11] === 3);

    ok("fallback include_attributes=all ocorre uma vez para o MLB afetado", chamadasDe("/items/MLBLEGACY1?include_attributes=all").length === 1);
    ok("sale_price ocorre uma vez para o MLB legado", chamadasDe("/items/MLBLEGACY1/sale_price").length === 1);
    ok("listing_prices ocorre uma vez por MLB, não por variation", chamadasDe("/sites/MLB/listing_prices").length === 2);
    ok("shipping_options ocorre uma vez por MLB, não por variation", chamadasDe("/shipping_options/free").length === 2);
    ok("todos os requests preservam mlUserId da Conta B", chamadas.length > 0 && chamadas.every((call) => call.options.mlUserId === "222"));
    ok("multiget preserva family_id via bigIntFields", chamadas.find((call) => call.path.startsWith("/items?ids="))?.options.bigIntFields?.includes("family_id"));
    ok("consulta complementar preserva family_id via bigIntFields", chamadas.find((call) => call.path.includes("include_attributes=all"))?.options.bigIntFields?.includes("family_id"));

    ok("Resumo separa 2 MLBs ativos", valorResumo(legado.resumoRows, "Total de MLBs ativos") === 2);
    ok("Resumo agora conta 1 linha por MLB (2, não 4)", valorResumo(legado.resumoRows, "Total de linhas de precificação") === 2);
    ok("Resumo conta o MLB legado multivariante", valorResumo(legado.resumoRows, "MLBs legados multivariantes") === 1);
    ok("Resumo expõe a quantidade de linhas sem SKU", valorResumo(legado.resumoRows, "Linhas sem SKU") === 0);

    const formulasEsperadas = {
      R4: 'IFERROR(P4-P4*I4-P4*K4-J4-H4-L4,"")',
      S4: 'IFERROR(R4/P4,"")',
      V4: 'IFERROR((H4+J4+L4)/(1-I4-K4-U4),"")',
      W4: 'IFERROR(V4*U4,"")',
      Y4: 'IF(AC4="sem_base","Revisar custo/base",IF(AC4="sem_frete","Revisar frete",IF(AC4="sem_comissao","Revisar comissão",IF(P4<V4,"Subir preço",IF(P4>V4,"Avaliar redução","Manter")))))',
      Z4: 'IF(Y4="Subir preço",V4,P4)',
      AA4: 'IFERROR(Z4-P4,"")',
      AB4: 'IFERROR(AA4/P4,"")',
    };
    Object.entries(formulasEsperadas).forEach(([address, formula]) => {
      ok(`fórmula ${address} preserva a mesma matemática nas novas colunas`, legado.matriz[address]?.f === formula);
    });
    const formulas = Object.values(legado.matriz).map((cell) => cell?.f).filter(Boolean);
    ok("não há SUM/AVG/COUNT financeiro sobre linhas", formulas.every((formula) => !/\b(?:SUM|AVG|COUNT)\s*\(/i.test(formula)));
    ok("autofilter cobre a nova última coluna AE", legado.matriz["!autofilter"]?.ref === "A3:AE5");

    cenario = "legado_completo";
    const resultadoLegadoCompleto = await gerar(gerarPlanilhaPrecificacaoSemBase);
    const legadoJaCompleto = lerWorkbook(resultadoLegadoCompleto.buffer);
    ok("multiget legado já completo também consolida em 1 linha", legadoJaCompleto.matrizRows.slice(3).length === 1);
    ok("multiget legado já completo não dispara chamada complementar", chamadasDe("include_attributes=all").length === 0);
    ok("multiget legado já completo ainda enriquece finanças só uma vez", chamadasDe("/sale_price").length === 1 && chamadasDe("/sites/MLB/listing_prices").length === 1 && chamadasDe("/shipping_options/free").length === 1);

    cenario = "dup_sem_sku";
    const resultadoDupSemSku = await gerar(gerarPlanilhaPrecificacaoSemBase);
    const dupSemSku = lerWorkbook(resultadoDupSemSku.buffer);
    const linhasDupSemSkuRows = dupSemSku.matrizRows.slice(3);
    const linhaDup = linhasDupSemSkuRows.find((row) => row[0] === "MLBDUP1");
    const linhaSemSku = linhasDupSemSkuRows.find((row) => row[0] === "MLBSEMSKU1");

    ok("SKU duplicado aparece uma vez na célula SKU(s)", linhaDup[2] === "SKU-REPETIDO");
    ok("Variações continua contando as 2 variations reais mesmo com SKU repetido", linhaDup[3] === 2);
    ok("item sem SKU continua gerando linha", !!linhaSemSku);
    ok("SKU ausente não é inventado na célula SKU(s)", linhaSemSku[2] === "");
    ok("Variações do item sem SKU é 1 (1 variation, sem SKU)", linhaSemSku[3] === 1);
    ok("Resumo conta a linha sem SKU", valorResumo(dupSemSku.resumoRows, "Linhas sem SKU") === 1);

    cenario = "up";
    const resultadoUp = await gerar(gerarPlanilhaPrecificacaoSemBase);
    const up = lerWorkbook(resultadoUp.buffer);
    const upRows = up.matrizRows.slice(3);
    ok("dois MLBs do mesmo MLBU continuam duas linhas", upRows.length === 2 && new Set(upRows.map((row) => row[0])).size === 2);
    ok("MLBU e SKU iguais não colapsam os MLBs", upRows.every((row) => row[1] === "MLBU9000" && row[2] === "SKU-UP"));
    ok("User Product sem variations reporta Variações = 1", upRows.every((row) => row[3] === 1));
    ok("preços diferentes permanecem por MLB", JSON.stringify(upRows.map((row) => row[15])) === JSON.stringify([90, 140]));
    ok("User Products sem variations não disparam consulta complementar", chamadasDe("include_attributes=all").length === 0);
    ok("User Products continuam com enriquecimento financeiro uma vez por MLB", chamadasDe("/sale_price").length === 2 && chamadasDe("/sites/MLB/listing_prices").length === 2 && chamadasDe("/shipping_options/free").length === 2);
    ok("requests do cenário UP também preservam mlUserId da Conta B", chamadas.every((call) => call.options.mlUserId === "222"));

    console.log(`\n✓ planilhaPrecificacaoVariacoes: ${checks} verificações`);
  } finally {
    pool.query = originalPoolQuery;
    mlClient.mlFetch = originalMlFetch;
    contextoPrecificacao.exigirContextoGrantMl = originalExigir;
    for (const modulo of [
      "../services/automacoes/precoItemService",
      "../services/automacoes/diagnosticoService",
      "../services/automacoes/planilhaPrecificacaoSemBaseService",
    ]) {
      delete require.cache[require.resolve(modulo)];
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
