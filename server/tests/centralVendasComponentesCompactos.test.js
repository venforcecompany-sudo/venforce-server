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
  ok("regra do formato 1 = classificação M6 atual (mudar o ledger exige formato novo)", () => {
    assert.deepStrictEqual({ ...cc.REGRA_FORMATO_1.efeito }, { ...ledger.EFEITO_POR_TIPO });
    assert.deepStrictEqual([...cc.REGRA_FORMATO_1.noResultado].sort(), [...ledger.TIPOS_NO_RESULTADO].sort());
    assert.deepStrictEqual([...cc.REGRA_FORMATO_1.informativos].sort(), [...ledger.TIPOS_INFORMATIVOS].sort());
    assert.ok(Object.isFrozen(cc.REGRA_FORMATO_1) && Object.isFrozen(cc.REGRA_FORMATO_1.efeito));
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
      { p: 11, c: [id("receita_produto"), id("orders_api"), id("real"), 0, id("custo_produto"), id("ausente"), id("bloqueado"), id("MLB sem custo."), id("receita_envio"), id("shipments_api"), id("real"), 0],
        v: [100, null, 0], i: [101, 101, null], x: null },
      { p: 12, c: [id("tarifa_venda"), id("orders_api"), id("real"), 0, id("tarifa_venda"), id("orders_api"), id("real"), 0],
        v: [-1.5, -0.25], i: [102, 102], x: { 2: { lote: 7 } } },
    ]);
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

  console.log(`centralVendasComponentesCompactos.test.js: ${checks} verificacoes OK`);
})().catch((err) => { console.error(err); process.exit(1); });
