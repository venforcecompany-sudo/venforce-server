// server/tests/anunciosMargemProjetadaFonte.test.js
//
// Fonte da margem projetada de Anúncios ML (passo 3 de
// docs/PLANO_FONTE_CANONICA_MARGEM.md): Margin Snapshot primeiro, legado só
// para o que faltar, rollback por ANUNCIOS_MARGEM_FONTE=legado e queda
// para o legado quando a leitura canônica falha.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const fonte = require("../services/motorMargem/anunciosMargemProjetadaFonte");

const silencioso = { error() {} };

function legadoFake(mapa, chamadas) {
  return async ({ clienteId, itemIds }) => {
    chamadas.push({ clienteId, itemIds });
    return new Map(Object.entries(mapa).filter(([id]) => itemIds.includes(id)));
  };
}

async function run() {
  // 1. SQL canônico: escopo por cliente + marketplace, conta só quando existe.
  {
    const consultas = [];
    const db = { async query(sql, params) { consultas.push({ sql, params }); return { rows: [
      { item_id: "MLB1", margin_percent: "18.25", profit: "7.10", status: "HEALTHY", calculated_at: "2026-10-12T06:00:00Z" },
      { item_id: "MLB2", margin_percent: null, profit: null, status: "UNVALIDATED", calculated_at: "2026-10-12T06:00:00Z" },
      // P0 04/11/2026: gravada com comissão/frete assumidos 0 (R$ 50 → 45%) e não revalidada.
      { item_id: "MLB3", margin_percent: "45.10", profit: "22.55", status: "SUSPECT_DATA", calculated_at: "2026-10-01T06:00:00Z",
        assumed_json: ["commission", "freight"], refresh_status: "failed" },
      { item_id: "MLB4", margin_percent: "45", profit: "22", status: "HEALTHY", assumed_json: ["commission"] },
      { item_id: "MLB5", margin_percent: null, profit: null, status: "UNVALIDATED", assumed_json: ["commission"] },
    ] }; } };

    const comConta = await fonte.lerMarginSnapshotPorItens({ clienteId: 1, clienteContaId: 10, itemIds: ["MLB1", "MLB2", "MLB1", "MLB3", "MLB4", "MLB5"] }, db);
    assert.ok(consultas[0].sql.includes("FROM margin_projection_snapshots"));
    assert.ok(consultas[0].sql.includes("s.cliente_conta_id = $4"));
    assert.ok(!consultas[0].sql.includes("meli_anuncios"), "conta resolvida: filtro direto pela chave canônica");
    assert.deepStrictEqual(consultas[0].params, [1, "meli", ["MLB1", "MLB2", "MLB3", "MLB4", "MLB5"], 10]);
    assert.deepStrictEqual(comConta.get("MLB1"), {
      marginPercent: 18.25, profit: 7.1, computable: true, status: "HEALTHY",
      margemIncompleta: false, assumidos: [], refreshStatus: null,
      calculadoEm: "2026-10-12T06:00:00Z", origemJob: "margin_snapshot", fonte: "margin_snapshot",
    });
    const inflada = comConta.get("MLB3");
    assert.strictEqual(inflada.computable, false, "comissão/frete assumidos 0: margem não computável (fora de ordenação/média)");
    assert.strictEqual(inflada.marginPercent, null, "o 45% inflado não chega à célula");
    assert.strictEqual(inflada.profit, null);
    assert.strictEqual(inflada.margemIncompleta, true);
    assert.strictEqual(inflada.refreshStatus, "failed", "valor antigo não revalidado fica identificado");
    assert.strictEqual(inflada.status, "SUSPECT_DATA");
    assert.strictEqual(comConta.get("MLB4").status, "SUSPECT_DATA", "custo ausente invalida o status saudável salvo");
    assert.strictEqual(comConta.get("MLB5").status, "UNVALIDATED", "ausência de Base mantém precedência do Motor");
    assert.strictEqual(comConta.get("MLB2").computable, false, "margin_percent null = não computável");
    assert.strictEqual(comConta.get("MLB2").marginPercent, null);

    await fonte.lerMarginSnapshotPorItens({ clienteId: 1, clienteContaId: null, itemIds: ["MLB1"] }, db);
    assert.ok(consultas[1].sql.includes("JOIN meli_anuncios a"), "sem conta resolvida: item só lê a conta dona dele no catálogo");
    assert.ok(consultas[1].sql.includes("a.cliente_conta_id = s.cliente_conta_id OR a.cliente_conta_id IS NULL"));
    assert.ok(!consultas[1].sql.includes("is_primary"), "nunca cai na conta principal em silêncio");
    assert.deepStrictEqual(consultas[1].params, [1, "meli", ["MLB1"]]);

    const vazio = await fonte.lerMarginSnapshotPorItens({ clienteId: 1, itemIds: [] }, db);
    assert.strictEqual(vazio.size, 0);
    assert.strictEqual(consultas.length, 2, "lista vazia não consulta o banco");
    console.log("  ✓ 1. leitura canônica: escopo por conta (resolvida = chave canônica; não resolvida = conta dona no catálogo)");
  }

  // 2. Canônico vence; legado só para os faltantes.
  {
    const chamadasLegado = [];
    const r = await fonte.lerMargemProjetadaPorItens({ clienteId: 1, clienteContaId: 10, itemIds: ["A", "B"] }, {
      env: {},
      lerMarginSnapshot: async () => new Map([["A", { marginPercent: 10, origemJob: "margin_snapshot" }]]),
      lerLegado: legadoFake({ A: { marginPercent: 99 }, B: { marginPercent: 20, origemJob: "manual_cli" } }, chamadasLegado),
      logger: silencioso,
    });
    assert.strictEqual(r.get("A").marginPercent, 10);
    assert.strictEqual(r.get("B").marginPercent, 20);
    assert.strictEqual(r.get("B").fonte, "legado", "linha do legado sai marcada como legado");
    assert.deepStrictEqual(chamadasLegado, [{ clienteId: 1, itemIds: ["B"] }]);
    console.log("  ✓ 2. Margin Snapshot vence; legado consultado só para o que falta");
  }

  // 3. Cobertura canônica completa: legado nem é consultado.
  {
    const chamadasLegado = [];
    await fonte.lerMargemProjetadaPorItens({ clienteId: 1, itemIds: ["A"] }, {
      env: {},
      lerMarginSnapshot: async () => new Map([["A", { marginPercent: 10 }]]),
      lerLegado: legadoFake({}, chamadasLegado),
      logger: silencioso,
    });
    assert.strictEqual(chamadasLegado.length, 0);
    console.log("  ✓ 3. cobertura canônica completa: nenhuma leitura do legado");
  }

  // 4. Falha na leitura canônica (ex.: tabela ausente) cai inteira no legado.
  {
    const chamadasLegado = [];
    const r = await fonte.lerMargemProjetadaPorItens({ clienteId: 1, itemIds: ["A", "B"] }, {
      env: {},
      lerMarginSnapshot: async () => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); },
      lerLegado: legadoFake({ A: { marginPercent: 5 } }, chamadasLegado),
      logger: silencioso,
    });
    assert.strictEqual(r.get("A").marginPercent, 5);
    assert.strictEqual(r.get("A").fonte, "legado");
    assert.strictEqual(r.has("B"), false, "ausente nas duas fontes: ausente (nunca 0)");
    assert.deepStrictEqual(chamadasLegado[0].itemIds, ["A", "B"]);
    console.log("  ✓ 4. erro no Margin Snapshot: cai no legado, nunca derruba a listagem");
  }

  // 5. Rollback: ANUNCIOS_MARGEM_FONTE=legado nunca lê o canônico.
  {
    let lidoCanonico = false;
    const chamadasLegado = [];
    await fonte.lerMargemProjetadaPorItens({ clienteId: 1, itemIds: ["A"] }, {
      env: { ANUNCIOS_MARGEM_FONTE: " Legado " },
      lerMarginSnapshot: async () => { lidoCanonico = true; return new Map(); },
      lerLegado: legadoFake({}, chamadasLegado),
      logger: silencioso,
    });
    assert.strictEqual(lidoCanonico, false);
    assert.strictEqual(chamadasLegado.length, 1);
    assert.strictEqual(fonte.fonteConfigurada({}), "snapshot", "padrão é o Margin Snapshot");
    assert.strictEqual(fonte.fonteConfigurada({ ANUNCIOS_MARGEM_FONTE: "qualquer" }), "snapshot");
    console.log("  ✓ 5. ANUNCIOS_MARGEM_FONTE=legado: rollback sem deploy; padrão é o Margin Snapshot");
  }

  // 6. Erro no legado (quando necessário) propaga — o controller já trata.
  {
    await assert.rejects(
      fonte.lerMargemProjetadaPorItens({ clienteId: 1, itemIds: ["A"] }, {
        env: {},
        lerMarginSnapshot: async () => new Map(),
        lerLegado: async () => { throw new Error("timeout"); },
        logger: silencioso,
      }),
      /timeout/
    );
    console.log("  ✓ 6. erro do legado propaga para o fallback do chamador");
  }

  console.log("anunciosMargemProjetadaFonte.test.js passed");
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
