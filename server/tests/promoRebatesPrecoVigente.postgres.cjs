// server/tests/promoRebatesPrecoVigente.postgres.cjs
//
// A consulta do retorno ML (promoSnapshotRepository.lerRebatesAtivos) contra
// PostgreSQL LOCAL descartável — fora do run-all (os fakes da suíte não validam
// SQL). Schema versionado real do Promo Snapshot; nenhum ML, nenhum server/.env.
//
//   MARGIN_TEST_DATABASE_URL=postgres://vf@127.0.0.1:55433/postgres node tests/promoRebatesPrecoVigente.postgres.cjs
//
// Prova, com o SQL real: UMA consulta; conta sem leitura = promoSnapshot null;
// conta com run e sem promoção = mapa vazio com o run; por item traz TODAS as
// iniciadas (inclusive a campanha do vendedor sem subsídio) e a `pending`
// confirmada; modo conta só traz itens com iniciada subsidiada; outro seller ou
// conta nunca entram; e o classificador decide o retorno sobre essas linhas.

const assert = require("assert");
const { Client, Pool } = require("pg");

const baseUrl = process.env.MARGIN_TEST_DATABASE_URL;
if (!baseUrl) throw new Error("Defina MARGIN_TEST_DATABASE_URL (PostgreSQL local).");
const parsed = new URL(baseUrl);
if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) throw new Error("LOCAL_DATABASE_REQUIRED");

const dbName = `vf_promo_rebates_${Date.now()}`;
const testUrl = new URL(baseUrl);
testUrl.pathname = `/${dbName}`;
process.env.DATABASE_URL = testUrl.toString();

const repo = require("../services/promoSnapshot/promoSnapshotRepository");
const { margemAtualComRebate } = require("../services/motorMargem/margemAtualRebate");

async function main() {
  const admin = new Client({ connectionString: baseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: testUrl.toString(), max: 2 });
  let consultas = 0;
  const db = { query: (sql, params) => { consultas += 1; return pool.query(sql, params); } };
  try {
    await repo.ensureTables(pool);

    // Conta sem leitura de promoções.
    const vazia = await repo.mapRebatesAtivosPorItem({ clienteContaId: 87, sellerId: "555", itemIds: ["MLB1"] }, db);
    assert.strictEqual(vazia.size, 0);
    assert.strictEqual(vazia.promoSnapshot, null, "sem linha em promo_snapshot_contas = sem leitura");

    const run = (await pool.query(
      `INSERT INTO promo_snapshot_runs (cliente_id, cliente_conta_id, marketplace, seller_id, reason, status)
       VALUES (133, 87, 'meli', '555', 'manual_sync', 'completed') RETURNING id`
    )).rows[0].id;
    await pool.query(
      `INSERT INTO promo_snapshot_contas (cliente_conta_id, cliente_id, marketplace, seller_id, current_run_id, snapshot_at)
       VALUES (87, 133, 'meli', '555', $1, '2026-11-12T18:44:00Z')`, [run]
    );
    const semPromo = await repo.mapRebatesAtivosPorItem({ clienteContaId: 87, sellerId: "555", itemIds: ["MLB9"] }, db);
    assert.strictEqual(semPromo.size, 0);
    assert.strictEqual(semPromo.promoSnapshot.runId, Number(run), "conta com run e sem promoção: o run vem");

    const ins = async (o) => pool.query(
      `INSERT INTO promo_snapshot_itens (run_id, cliente_id, cliente_conta_id, marketplace, seller_id, item_id, promocao_chave,
         promotion_id, ref_id, promotion_type, tipo_conhecido, nome, status, ativa, preco_original, preco_final,
         meli_percentage, seller_percentage, subsidio_ml, observed_at)
       VALUES ($1, 133, $2, 'meli', $3, $4, $5, $6, $7, $8, true, $9, $10, $11, $12, $13, $14, $15, $16, '2026-11-12T18:44:00Z')`,
      [o.run || run, o.conta || 87, o.seller || "555", o.item, `${o.id}::${o.tipo}`, o.id, o.ref || null, o.tipo, o.nome || o.tipo,
        o.status, o.ativa === undefined ? null : o.ativa, o.original, o.preco, o.meli ?? null, o.seller_pct ?? null,
        o.meli != null ? Math.round(o.original * o.meli) / 100 : null]
    );
    // MLB1 (caso do bug): preço 102,90 da campanha do vendedor; SMART iniciada a 109,51 com subsídio.
    await ins({ item: "MLB1", id: "C-1", tipo: "SELLER_CAMPAIGN", status: "started", ativa: true, original: 129.99, preco: 102.9 });
    await ins({ item: "MLB1", id: "P-2", ref: "OFFER-1", tipo: "SMART", status: "started", ativa: false, original: 129.99, preco: 109.51, meli: 1.5, seller_pct: 14.2 });
    // MLB2: SMART cofinanciada forma o preço.
    await ins({ item: "MLB2", id: "P-3", ref: "OFFER-2", tipo: "SMART", status: "started", ativa: true, original: 122.43, preco: 95.84, meli: 1.4, seller_pct: 20.3 });
    // MLB3: só campanha do vendedor (sem subsídio) — fora do modo conta.
    await ins({ item: "MLB3", id: "C-1", tipo: "SELLER_CAMPAIGN", status: "started", ativa: true, original: 149.9, preco: 129.9 });
    // MLB4: relâmpago pending confirmada + candidata (candidata nunca entra).
    await ins({ item: "MLB4", id: "L-1", ref: "OFFER-4", tipo: "SMART_LIGHTNING", status: "pending", ativa: true, original: 100, preco: 90, meli: 3, seller_pct: 7 });
    await ins({ item: "MLB4", id: "P-9", tipo: "SMART", status: "candidate", ativa: false, original: 100, preco: 80, meli: 5 });
    // Outra conta / outro seller: nunca entram.
    await ins({ item: "MLB1", id: "P-X", tipo: "SMART", status: "started", ativa: true, original: 129.99, preco: 102.9, meli: 9, conta: 86 });
    await ins({ item: "MLB1", id: "P-Y", tipo: "SMART", status: "started", ativa: true, original: 129.99, preco: 102.9, meli: 9, seller: "999" });

    consultas = 0;
    const porItem = await repo.mapRebatesAtivosPorItem({ clienteContaId: 87, sellerId: "555", itemIds: ["MLB1", "MLB2", "MLB3", "MLB4", "MLB5"] }, db);
    assert.strictEqual(consultas, 1, "UMA consulta");
    assert.deepStrictEqual(Array.from(porItem.keys()).sort(), ["MLB1", "MLB2", "MLB3", "MLB4"]);
    assert.deepStrictEqual(porItem.get("MLB1").linhas.map((l) => l.promotionId).sort(), ["C-1", "P-2"], "todas as iniciadas, sem outra conta/seller");
    assert.strictEqual(porItem.get("MLB1").promocoes, 1);
    assert.deepStrictEqual(porItem.get("MLB4").linhas.map((l) => l.promotionId), ["L-1"], "pending confirmada entra; candidata não");
    assert.strictEqual(porItem.get("MLB2").linhas[0].subsidioMl, 1.71);

    const conta = await repo.mapRebatesAtivosDaConta({ clienteContaId: 87, sellerId: "555" }, db);
    assert.deepStrictEqual(Array.from(conta.keys()).sort(), ["MLB1", "MLB2"], "modo conta: só itens com iniciada subsidiada");
    assert.deepStrictEqual(conta.get("MLB1").linhas.map((l) => l.promotionId).sort(), ["C-1", "P-2"], "…mas com TODAS as iniciadas do item");
    assert.strictEqual(conta.promoSnapshot.runId, Number(run));

    // O classificador decide sobre as linhas reais.
    const linha = (price, listPrice) => ({ price, listPrice, cost: 40, taxRate: 0.1, fixedFee: 0, commission: 14, freight: 16.85, margin: 0.1, profit: 10, quality: {} });
    const ctx = { promoSnapshot: porItem.promoSnapshot };
    assert.strictEqual(margemAtualComRebate(linha(102.9, 129.99), porItem.get("MLB1"), null, ctx).rebate, null, "bug: a SMART não forma o preço");
    assert.strictEqual(margemAtualComRebate(linha(95.84, 122.43), porItem.get("MLB2"), null, ctx).rebate, 1.71);
    assert.strictEqual(margemAtualComRebate(linha(129.9, 149.9), porItem.get("MLB3"), null, ctx).precoVigente.financiador, "VENDEDOR");
    assert.strictEqual(margemAtualComRebate(linha(90, 100), porItem.get("MLB4"), null, ctx).rebate, 3);
    console.log("promoRebatesPrecoVigente.postgres: ok (SQL real)");
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
