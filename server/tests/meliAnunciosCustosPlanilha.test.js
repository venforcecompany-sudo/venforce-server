// server/tests/meliAnunciosCustosPlanilha.test.js
//
// "Importar base de custo" da lista de Anúncios ML
// (GET /custos/planilha + POST /custos/planilha/previa).
//
// O que este teste protege:
//
//  1. a planilha traz TODOS os MLB da conta — com custo (preenchido) e sem;
//  2. linha legada da Base sem prefixo MLB aparece no anúncio certo;
//  3. a prévia classifica atualizar / adicionar / inalterado / recusada e
//     NÃO grava nada (nenhum INSERT/UPDATE/DELETE);
//  4. custo vazio é ignorado (nunca zera), custo inválido, MLB de fora da
//     conta e MLB repetido com valores diferentes são recusados;
//  5. sem Base vinculada: 409 SEM_BASE, nada é lido da tabela de custos;
//  6. planilha sem as colunas ID/Custo: 400 COLUNAS_AUSENTES.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const XLSX = require("xlsx");
const servico = require("../services/meliAnuncios/meliCustosPlanilhaService");

function dbFalso({ anuncios, custos }) {
  const consultas = [];
  return {
    consultas,
    async query(sql, params) {
      consultas.push({ sql, params });
      if (/FROM meli_anuncios/.test(sql)) return { rows: anuncios };
      if (/FROM custos/.test(sql)) {
        const chaves = params[1];
        return { rows: custos.filter((c) => chaves.includes(c.produto_id)) };
      }
      throw new Error("consulta inesperada: " + sql);
    },
  };
}

function deps(db, { base = { id: 9, slug: "base-x", nome: "Base X" } } = {}) {
  return {
    db,
    resolverCliente: async (slug) => (slug === "cli" ? { id: 1, slug: "cli", nome: "Cliente" } : null),
    resolverContextoConta: async () => ({ contaId: 5, includeLegacy: false }),
    resolverBaseDeCustos: async () => (base ? { base, mensagem: null } : { base: null, mensagem: "Sem base vinculada." }),
  };
}

function xlsx(aoa) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Custos");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

const ANUNCIOS = [
  { item_id: "MLB1", titulo: "Perfume A", sku: "A", status: "active" },
  { item_id: "MLB2", titulo: "Perfume B", sku: null, status: "paused" },
  { item_id: "MLB3", titulo: "Perfume C", sku: "C", status: "active" },
];
const CUSTOS = [
  { produto_id: "MLB1", custo_produto: "10.50" },
  { produto_id: "3", custo_produto: "20" }, // legado sem prefixo
];

async function casos() {
  const testes = [];
  const t = (nome, fn) => testes.push({ nome, fn });

  t("1/2 — planilha traz todos os MLB, com o custo atual (inclusive chave legada)", async () => {
    const db = dbFalso({ anuncios: ANUNCIOS, custos: CUSTOS });
    const r = await servico.gerarPlanilha({ clienteSlug: "cli", clienteContaId: 5 }, deps(db));
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.comCusto, 2);
    assert.ok(/^custos-anuncios-ml-cli-\d{4}-\d{2}-\d{2}\.xlsx$/.test(r.filename));
    const wb = XLSX.read(r.buffer, { type: "buffer" });
    const m = XLSX.utils.sheet_to_json(wb.Sheets.Custos, { header: 1, defval: null });
    assert.deepStrictEqual(m[0], servico.COLUNAS);
    assert.deepStrictEqual(m.slice(1).map((l) => [l[0], l[4]]), [["MLB1", 10.5], ["MLB2", null], ["MLB3", 20]]);
    // conta exclusiva (includeLegacy false) entra na cláusula
    assert.ok(/cliente_conta_id = \$2/.test(db.consultas[0].sql));
    assert.deepStrictEqual(db.consultas[0].params, [1, 5]);
  });

  t("3/4 — prévia classifica e não grava", async () => {
    const db = dbFalso({ anuncios: ANUNCIOS, custos: CUSTOS });
    const buffer = xlsx([
      ["ID", "Título", "SKU", "Status", "Custo"],
      ["MLB1", "Perfume A", "A", "active", 12],        // atualizar
      ["MLB2", "Perfume B", null, "paused", "R$ 7,90"], // adicionar
      ["MLB3", "Perfume C", "C", "active", 20],         // inalterado
      ["MLB4", "De outra conta", null, null, 5],        // recusada
      ["XYZ", null, null, null, 5],                     // recusada (ID)
      ["MLB2", null, null, null, 8],                    // repetida diferente → MLB2 recusada
      ["MLB1", null, null, null, 12],                   // repetida igual → ignora
      ["MLB3", null, null, null, null],                 // vazia
    ]);
    const r = await servico.lerPlanilha({ clienteSlug: "cli", clienteContaId: 5, buffer }, deps(db));
    const porId = Object.fromEntries(r.linhas.filter((l) => /^MLB/.test(l.itemId)).map((l) => [l.itemId, l]));
    assert.strictEqual(porId.MLB1.acao, "atualizar");
    assert.strictEqual(porId.MLB1.custoAtual, 10.5);
    assert.strictEqual(porId.MLB1.custo, 12);
    assert.strictEqual(porId.MLB2.acao, "recusada");
    assert.ok(/repetido/.test(porId.MLB2.motivo));
    assert.strictEqual(porId.MLB3.acao, "inalterado");
    assert.strictEqual(porId.MLB4.acao, "recusada");
    assert.deepStrictEqual(r.resumo, { atualizar: 1, adicionar: 0, inalterado: 1, recusadas: 3, vazias: 1, anunciosNaConta: 3 });
    assert.ok(db.consultas.every((c) => /^\s*SELECT/i.test(c.sql)), "prévia nunca escreve");
  });

  t("4 — custo pt-BR, número puro como ID e cabeçalho 'Novo custo'", async () => {
    const db = dbFalso({ anuncios: ANUNCIOS, custos: [] });
    const buffer = xlsx([["id", "Novo custo"], [2, "1.234,56"], ["MLB1", "0"]]);
    const r = await servico.lerPlanilha({ clienteSlug: "cli", buffer }, deps(db));
    assert.strictEqual(r.linhas[0].itemId, "MLB2");
    assert.strictEqual(r.linhas[0].acao, "adicionar");
    assert.strictEqual(r.linhas[0].custo, 1234.56);
    assert.strictEqual(r.linhas[1].acao, "recusada");
    assert.ok(/Custo inválido/.test(r.linhas[1].motivo));
  });

  t("5 — sem Base: 409 SEM_BASE e a tabela de custos não é lida", async () => {
    const db = dbFalso({ anuncios: ANUNCIOS, custos: CUSTOS });
    await assert.rejects(
      servico.gerarPlanilha({ clienteSlug: "cli" }, deps(db, { base: null })),
      (e) => e.statusCode === 409 && e.payload.codigo === "SEM_BASE" && e.payload.motivo === "Sem base vinculada."
    );
    assert.strictEqual(db.consultas.length, 0);
  });

  t("6 — planilha sem colunas ID/Custo: 400 COLUNAS_AUSENTES", async () => {
    const db = dbFalso({ anuncios: ANUNCIOS, custos: CUSTOS });
    await assert.rejects(
      servico.lerPlanilha({ clienteSlug: "cli", buffer: xlsx([["Produto", "Preço"], ["x", 1]]) }, deps(db)),
      (e) => e.statusCode === 400 && e.payload.codigo === "COLUNAS_AUSENTES"
    );
  });

  t("cliente inexistente: 404", async () => {
    const db = dbFalso({ anuncios: [], custos: [] });
    await assert.rejects(servico.gerarPlanilha({ clienteSlug: "outro" }, deps(db)), (e) => e.statusCode === 404);
  });

  let falhas = 0;
  for (const { nome, fn } of testes) {
    try {
      await fn();
      console.log("  ✓", nome);
    } catch (err) {
      falhas += 1;
      console.error("  ✗", nome, "\n   ", err.message);
    }
  }
  if (falhas) {
    console.error(`\n${falhas} falha(s) em meliAnunciosCustosPlanilha`);
    process.exit(1);
  }
  console.log(`\nmeliAnunciosCustosPlanilha: ${testes.length}/${testes.length} ok`);
}

casos();
