// server/tests/centralVendasComponentesCompactos.test.js
//
// Unidade (sem banco) do formato compacto dos componentes da Central de
// Vendas. A equivalência contra PostgreSQL real está em
// centralVendasComponentesCompactos.postgres.test.js e no modo "compacto" de
// centralVendasPersistenciaEnxuta.postgres.test.js.

const assert = require("assert");
const cc = require("../services/centralVendas/centralVendasComponentesCompactos");
const ledger = require("../services/centralVendas/centralVendasComponenteLedger");
const pe = require("../services/centralVendas/centralVendasPersistenciaEnxuta");

let checks = 0;
const ok = (label, fn) => { fn(); checks += 1; console.log(`  ✓ ${label}`); };

(async () => {
  ok("regra do formato 2 = classificação M6 atual; o formato 1 é ela sem os tipos promocionais (mudar o ledger exige formato novo)", () => {
    assert.deepStrictEqual({ ...cc.REGRA_FORMATO_2.efeito }, { ...ledger.EFEITO_POR_TIPO });
    assert.deepStrictEqual([...cc.REGRA_FORMATO_2.noResultado].sort(), [...ledger.TIPOS_NO_RESULTADO].sort());
    assert.deepStrictEqual([...cc.REGRA_FORMATO_2.informativos].sort(), [...ledger.TIPOS_INFORMATIVOS].sort());
    assert.deepStrictEqual([...cc.TIPOS_PROMOCIONAIS_FORMATO_2].sort(), [...ledger.TIPOS_PROMOCIONAIS].sort());
    // formato 1 congelado: exatamente o formato 2 sem os promocionais (só acréscimo, nada reclassificado)
    assert.deepStrictEqual([...cc.REGRA_FORMATO_1.informativos].sort(), ["cancelamento_reembolso", "receita_envio"]);
    assert.deepStrictEqual({ ...cc.REGRA_FORMATO_1.efeito }, { ...cc.REGRA_FORMATO_2.efeito });
    for (const t of cc.TIPOS_PROMOCIONAIS_FORMATO_2) assert.ok(!(t in cc.REGRA_FORMATO_1.efeito) && !cc.REGRA_FORMATO_1.informativos.includes(t));
    assert.ok(Object.isFrozen(cc.REGRA_FORMATO_1) && Object.isFrozen(cc.REGRA_FORMATO_1.efeito));
    assert.ok(Object.isFrozen(cc.REGRA_FORMATO_2));
  });

  ok("escrita: flag + Sync + conta na lista; ausente = desligada", () => {
    const base = { fonte: "orders_api", syncRunId: 9, clienteContaId: 5 };
    assert.strictEqual(cc.isEscritaCompactaHabilitada(base, {}), false);
    assert.strictEqual(cc.isEscritaCompactaHabilitada(base, { [cc.ENV_NAME]: "true" }), false, "lista ausente = nenhuma conta");
    assert.strictEqual(cc.isEscritaCompactaHabilitada(base, { [cc.ENV_NAME]: "true", [cc.ENV_CONTAS]: "5" }), true);
    assert.strictEqual(cc.isEscritaCompactaHabilitada(base, { [cc.ENV_NAME]: "true", [cc.ENV_CONTAS]: "41, 87" }), false);
    assert.strictEqual(cc.isEscritaCompactaHabilitada(base, { [cc.ENV_NAME]: "true", [cc.ENV_CONTAS]: "*" }), true);
    assert.strictEqual(cc.isEscritaCompactaHabilitada({ ...base, fonte: "planilha_vendas" }, { [cc.ENV_NAME]: "true", [cc.ENV_CONTAS]: "*" }), false, "planilha manual nunca");
    assert.strictEqual(cc.isEscritaCompactaHabilitada({ ...base, syncRunId: null }, { [cc.ENV_NAME]: "true", [cc.ENV_CONTAS]: "*" }), false, "sem run nunca");
    assert.strictEqual(cc.isEscritaCompactaHabilitada({ ...base, clienteContaId: null }, { [cc.ENV_NAME]: "true", [cc.ENV_CONTAS]: "5" }), false);
    assert.strictEqual(cc.isEscritaCompactaHabilitada(base, { [cc.ENV_NAME]: "false", [cc.ENV_CONTAS]: "*" }), false);
  });

  const motor = () => ({
    pedidos: [{ pedidoId: "1" }, { pedidoId: "2" }],
    itens: [{ pedidoId: "1", itemId: "1:A" }, { pedidoId: "2", itemId: "2:B" }],
    componentes: [
      { pedidoId: "1", itemId: "1:A", tipo: "receita_produto", valor: 100, fonte: "orders_api", confianca: "real", obs: null },
      { pedidoId: "1", itemId: "1:A", tipo: "custo_produto", valor: null, fonte: "ausente", confianca: "bloqueado", obs: "MLB sem custo." },
      { pedidoId: "1", itemId: null, tipo: "receita_envio", valor: 0, fonte: "shipments_api", confianca: "real", obs: null },
      { pedidoId: "2", itemId: "2:B", tipo: "tarifa_venda", valor: -1.5, fonte: "orders_api", confianca: "real", obs: null },
      { pedidoId: "2", itemId: "2:B", tipo: "tarifa_venda", valor: -0.25, fonte: "orders_api", confianca: "real", obs: null, lote: 7 },
    ],
  });

  ok("avaliação: elegível e dicionário ordenado sem NULL/vazio", () => {
    const a = cc.avaliarImport(motor());
    assert.strictEqual(a.elegivel, true);
    assert.deepStrictEqual(a.textos, ["MLB sem custo.", "ausente", "bloqueado", "custo_produto", "orders_api", "real", "receita_envio", "receita_produto", "shipments_api", "tarifa_venda"]);
  });

  ok("avaliação: tudo que a linha antiga representaria diferente fica no formato antigo", () => {
    const casos = [
      [(m) => { m.componentes[0].pedidoId = "9"; }, "COMPONENTE_SEM_PEDIDO"],
      [(m) => { m.componentes[0].itemId = "X"; }, "COMPONENTE_ITEM_SEM_LINHA"],
      [(m) => { m.componentes[0].itemId = "2:B"; }, "COMPONENTE_ITEM_DE_OUTRO_PEDIDO"],
      [(m) => { m.componentes[0].valor = Number.NaN; }, "COMPONENTE_VALOR_NAO_NUMERICO"],
      [(m) => { m.componentes[0].valor = Infinity; }, "COMPONENTE_VALOR_NAO_NUMERICO"],
      [(m) => { m.componentes[0].valor = "10"; }, "COMPONENTE_VALOR_NAO_NUMERICO"],
      [(m) => { m.componentes[0].confianca = null; }, "COMPONENTE_CONFIANCA_INVALIDA"],
      [(m) => { m.componentes[0].tipo = ""; }, "COMPONENTE_TIPO_INVALIDO"],
      [(m) => { m.componentes[0].obs = 42; }, "COMPONENTE_TEXTO_INVALIDO"],
    ];
    for (const [mutar, motivo] of casos) {
      const m = motor(); mutar(m);
      assert.deepStrictEqual(cc.avaliarImport(m), { elegivel: false, motivo });
    }
  });

  ok("linhas: 1 por pedido, ordem do motor, NULL ≠ 0, repetidos preservados, extras por posição", () => {
    const m = motor();
    const a = cc.avaliarImport(m);
    const textos = new Map(a.textos.map((t, i) => [t, i + 1]));
    const linhas = cc.montarLinhas({
      componentes: m.componentes,
      pedidoRowsById: new Map([["1", 11], ["2", 12]]),
      itemRowsById: new Map([["1:A", 101], ["2:B", 102]]),
      textos,
      extrasDoComponente: pe.extrasDoComponente,
    });
    const id = (t) => textos.get(t);
    assert.deepStrictEqual(linhas, [
      { p: 11, f: 1, c: [id("receita_produto"), id("orders_api"), id("real"), 0, id("custo_produto"), id("ausente"), id("bloqueado"), id("MLB sem custo."), id("receita_envio"), id("shipments_api"), id("real"), 0],
        v: [100, null, 0], i: [101, 101, null], x: null },
      { p: 12, f: 1, c: [id("tarifa_venda"), id("orders_api"), id("real"), 0, id("tarifa_venda"), id("orders_api"), id("real"), 0],
        v: [-1.5, -0.25], i: [102, 102], x: { 2: { lote: 7 } } },
    ]);
  });

  ok("montagem: pedido ou item sem linha aborta (nunca vira componente de pedido em silêncio)", () => {
    const m = motor();
    const textos = new Map(cc.avaliarImport(m).textos.map((t, i) => [t, i + 1]));
    assert.throws(() => cc.montarLinhas({ componentes: m.componentes, pedidoRowsById: new Map([["1", 11]]), itemRowsById: new Map([["1:A", 101], ["2:B", 102]]), textos, extrasDoComponente: pe.extrasDoComponente }), /PEDIDO_SEM_LINHA:2/);
    assert.throws(() => cc.montarLinhas({ componentes: m.componentes, pedidoRowsById: new Map([["1", 11], ["2", 12]]), itemRowsById: new Map([["1:A", 101]]), textos, extrasDoComponente: pe.extrasDoComponente }), /ITEM_SEM_LINHA:2:B/);
  });

  ok("leitura: a união desempata pela ordem de gravação comparável entre formatos (linha do pedido, id | posição)", () => {
    const sql = cc.sqlUniao({ colunas: ["tipo", "valor"], filtroLegado: "pedido_row_id = $1", filtroCompacto: "pc.pedido_row_id = $1" });
    assert.ok(/FROM central_vendas_componentes WHERE pedido_row_id = \$1/.test(sql));
    assert.ok(/ORDER BY pedido_id ASC, item_id ASC NULLS LAST, pedido_row_id ASC, id ASC NULLS LAST, ordem_compacta ASC\s*$/.test(sql));
    assert.ok(/^SELECT tipo, valor FROM/.test(sql), "só as colunas pedidas saem (desempates ficam internos)");
    const det = cc.sqlUniao({ colunas: ["tipo"], filtroLegado: "x", filtroCompacto: "y", ordem: "item" });
    assert.ok(/ORDER BY item_id ASC NULLS LAST, pedido_row_id ASC, id ASC NULLS LAST/.test(det));
  });

  ok("leitura: classificação derivada na SQL espelha a regra congelada", () => {
    const sql = cc.sqlCompactos({ colunas: ["efeito", "incluido_no_resultado"], filtro: "TRUE" });
    for (const [tipo, efeito] of Object.entries(cc.REGRA_FORMATO_1.efeito)) {
      assert.ok(new RegExp(`WHEN tt.texto IN \\([^)]*'${tipo}'[^)]*\\) THEN '${efeito}'`).test(sql), tipo);
    }
    assert.ok(/ELSE|END/.test(sql));
    assert.ok(/WHEN pc\.formato >= 2 AND tt\.texto IN \([^)]*'rebate_marketplace'[^)]*\) THEN FALSE/.test(sql), "tipos promocionais só são informativos no formato 2");
  });

  ok("formato por pedido: 2 só quando o pedido tem tipo promocional; formato desconhecido é corrupção", () => {
    const componentes = [
      { pedidoId: "1", itemId: null, tipo: "receita_envio", valor: 5, fonte: "f", confianca: "real", obs: null },
      { pedidoId: "2", itemId: null, tipo: "rebate_marketplace", valor: 1.15, fonte: "billing_api", confianca: "comprovado", obs: "incorporado:comprovado" },
    ];
    const textos = new Map(["receita_envio", "f", "real", "rebate_marketplace", "billing_api", "comprovado", "incorporado:comprovado"].map((t, i) => [t, i + 1]));
    const linhas = cc.montarLinhas({ componentes, pedidoRowsById: new Map([["1", 11], ["2", 12]]), itemRowsById: new Map(), textos, extrasDoComponente: () => null });
    assert.deepStrictEqual(linhas.map((l) => [l.p, l.f]), [[11, 1], [12, 2]]);
    assert.throws(() => cc.validarLinhaCompacta({ formato: 3, pedido_row_id: "9", valores: ["1"], item_row_ids: [null], codigos: [1, 0, 3, 0] }), /FORMATO_3/);
    assert.strictEqual(cc.validarLinhaCompacta({ formato: 2, pedido_row_id: "9", valores: ["1"], item_row_ids: [null], codigos: [1, 0, 3, 0] }), 1);
  });

  await (async () => {
    // Existência: positivo em cache; negativo nunca; erro propaga.
    let n = 0;
    const dbNao = { query: async () => { n += 1; return { rows: [{ ok: false }] }; } };
    assert.strictEqual(await cc.tabelaCompactaDisponivel(dbNao), false);
    assert.strictEqual(await cc.tabelaCompactaDisponivel(dbNao), false);
    assert.strictEqual(n, 2, "negativo não é cacheado");
    let m = 0;
    const dbSim = { query: async () => { m += 1; return { rows: [{ ok: true }] }; } };
    assert.strictEqual(await cc.tabelaCompactaDisponivel(dbSim), true);
    assert.strictEqual(await cc.tabelaCompactaDisponivel(dbSim), true);
    assert.strictEqual(m, 1, "positivo é cacheado");
    await assert.rejects(() => cc.tabelaCompactaDisponivel({ query: async () => { throw new Error("timeout"); } }), /timeout/);
    await assert.rejects(() => cc.tabelaCompactaDisponivel({ query: async () => ({ rows: [{}] }) }), /INDETERMINADA/);
    checks += 1; console.log("  ✓ existência: positivo em cache, negativo nunca, erro propaga");
  })();

  await (async () => {
    // Mescla em JS: banco falso que devolve grupos (já na ordem do banco) e dicionário.
    const textos = { 1: "receita_produto", 2: "orders_api", 3: "real", 4: "tarifa_venda", 5: "receita_envio", 6: "MLB sem custo." };
    // Linhas da consulta de grupos na ordem do banco (pedido_id, item_id NULLS LAST, linha).
    const grupos = [
      { pedido_row_id: "10", pedido_id: "A", item_row_id: "100", item_id: "A:1" },   // linha antiga
      { pedido_row_id: "20", pedido_id: "A", item_row_id: "200", item_id: "A:1" },   // compacta, mesmo pedido_id/item_id (borda de mês)
    ];
    const db = (dic = textos) => ({ query: async (sql) => (/cv:componentes-grupos/.test(sql) ? { rows: grupos }
      : { rows: Object.entries(dic).map(([id, texto]) => ({ id: Number(id), texto })) }) });
    const colunas = ["id", "pedido_row_id", "item_row_id", "item_id", "tipo", "valor", "fonte", "confianca", "obs", "escopo", "efeito", "incluido_no_resultado"];
    const legado = [
      { id: "7", pedido_row_id: "10", item_row_id: "100", item_id: "A:1", tipo: "receita_produto", valor: "10.00", fonte: "orders_api", confianca: "real", obs: null, escopo: "item", efeito: "credito", incluido_no_resultado: true },
      { id: "9", pedido_row_id: "10", item_row_id: null, item_id: null, tipo: "receita_envio", valor: "0.00", fonte: "orders_api", confianca: "real", obs: null, escopo: "pedido", efeito: "credito", incluido_no_resultado: false },
    ];
    const compacta = (extra = {}) => ({ pedido_row_id: "20", formato: 1, import_id: "2", pedido_id: "A",
      codigos: [1, 2, 3, 0, 4, 2, 3, 6, 4, 2, 3, 0, 5, 0, 3, 0], valores: ["11.00", null, "-0.50", "0.00"], item_row_ids: ["200", "200", "200", null], ...extra });
    const rows = await cc.mesclarComponentes(db(), { linhasLegado: legado, linhasCompactas: [compacta()], colunas });
    assert.deepStrictEqual(rows.map((r) => [r.pedido_row_id, r.item_id, r.tipo, r.valor, r.obs]), [
      ["10", "A:1", "receita_produto", "10.00", null],
      ["20", "A:1", "receita_produto", "11.00", null],
      ["20", "A:1", "tarifa_venda", null, "MLB sem custo."],
      ["20", "A:1", "tarifa_venda", "-0.50", null],
      ["10", null, "receita_envio", "0.00", null],
      ["20", null, "receita_envio", "0.00", null],
    ], "ordem do banco por grupo; repetidos e NULL × 0 preservados; texto exato");
    assert.deepStrictEqual(Object.keys(rows[1]), colunas, "mesmas colunas, mesma ordem de chaves");
    assert.strictEqual(rows[5].fonte, null);
    assert.strictEqual(rows[1].efeito, "credito");
    const so = await cc.mesclarComponentes(db(), { linhasLegado: [], linhasCompactas: [compacta()], colunas: ["tipo", "valor"], tipos: ["tarifa_venda"] });
    assert.deepStrictEqual(so, [{ tipo: "tarifa_venda", valor: null }, { tipo: "tarifa_venda", valor: "-0.50" }], "filtro de tipo");
    // Fallback (null) quando a ordem depende de algo que só a SQL sabe ordenar.
    assert.strictEqual(await cc.mesclarComponentes(db(), { linhasLegado: [{ ...legado[0], item_row_id: null }], linhasCompactas: [compacta()], colunas }), null);
    assert.strictEqual(await cc.mesclarComponentes(db(), { linhasLegado: [{ ...legado[0], pedido_row_id: null }], linhasCompactas: [compacta()], colunas }), null);
    assert.strictEqual(await cc.mesclarComponentes(db(), { linhasLegado: [{ ...legado[0], item_id: "OUTRO" }], linhasCompactas: [compacta()], colunas }), null);
    assert.strictEqual(await cc.mesclarComponentes(db(), { linhasLegado: [], linhasCompactas: [compacta({ item_row_ids: ["999", "200", "200", null] })], colunas }), null);
    // Integridade: erro explícito, nunca componente perdido em silêncio.
    await assert.rejects(() => cc.mesclarComponentes(db(), { linhasLegado: [], linhasCompactas: [compacta({ valores: ["1.00"] })], colunas }), /DIMENSOES/);
    await assert.rejects(() => cc.mesclarComponentes(db(), { linhasLegado: [], linhasCompactas: [compacta({ formato: 9 })], colunas }), /FORMATO_9/);
    await assert.rejects(() => cc.mesclarComponentes(db({ 1: "receita_produto" }), { linhasLegado: [], linhasCompactas: [compacta()], colunas }), /TEXTO_2_AUSENTE/);
    checks += 1; console.log("  ✓ mescla em JS: ordem do banco, repetidos, NULL × 0, filtro de tipo, fallback e integridade");
    // Transporte em texto: '' = NULL nas posições; código '' = corrupção.
    assert.deepStrictEqual(cc.lerLinhaCrua({ pedido_row_id: 7, formato: 1, c: "1,2,3,0,4,0,3,6", v: "12.30,", i: "70," }),
      { pedido_row_id: "7", formato: 1, codigos: [1, 2, 3, 0, 4, 0, 3, 6], valores: ["12.30", null], item_row_ids: ["70", null] });
    assert.throws(() => cc.lerLinhaCrua({ pedido_row_id: 7, formato: 1, c: "1,,3,0", v: "1.00", i: "" }), /CODIGO_NULO/);
    // Grupos do pedido (item NULL) no fim de cada bloco de pedido_id, por linha numérica (9 antes de 10).
    assert.deepStrictEqual(cc.gruposEmOrdem([
      { pedido_row_id: "10", pedido_id: "A", item_row_id: "100", item_id: "A:1" },
      { pedido_row_id: "9", pedido_id: "A", item_row_id: "90", item_id: "A:2" },
      { pedido_row_id: "11", pedido_id: "B", item_row_id: null, item_id: null },
    ]).map((g) => `${g.pedido_row_id}|${g.item_row_id}`), ["10|100", "9|90", "9|null", "10|null", "11|null"]);
    checks += 1; console.log("  ✓ transporte em texto (NULL marcado, código nulo = erro) e grupos do pedido no fim do bloco");
  })();

  console.log(`centralVendasComponentesCompactos.test.js: ${checks} verificacoes OK`);
})().catch((err) => { console.error(err); process.exit(1); });
