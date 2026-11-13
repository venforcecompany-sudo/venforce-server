// VenForce Resgate — store PostgreSQL contra um PG REAL LOCAL (nunca produção).
//   RESGATE_TEST_DATABASE_URL=postgres://vf@127.0.0.1:55439/postgres node tests/resgateStore.postgres.cjs
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { criarStorePg } = require("../services/resgate/resgateStorePg");

const url = process.env.RESGATE_TEST_DATABASE_URL;
if (!url || !/127\.0\.0\.1|localhost/.test(url)) { console.log("RESGATE_TEST_DATABASE_URL local ausente: teste PULADO"); process.exit(0); }

(async () => {
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const banco = `vf_resgate_teste_${process.pid}`;
  await admin.query(`CREATE DATABASE ${banco}`);
  const db = new Client({ connectionString: url.replace(/\/[^/]*$/, `/${banco}`) });
  await db.connect();
  let ok = 0;
  const t = async (n, fn) => { await fn(); ok++; console.log(`  ✓ ${n}`); };
  try {
    const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", "20261112_venforce_resgate.sql"), "utf8");
    await db.query(sql);
    await db.query(sql); // idempotente
    const store = criarStorePg(db);
    await t("migration idempotente e tabelas disponíveis", async () => assert.strictEqual(await store.tabelasDisponiveis(), true));
    const id = await store.iniciarExecucao({ contas: [86] });
    await t("no máximo UMA execução em andamento", async () => {
      await assert.rejects(() => store.iniciarExecucao({ contas: [87] }), /duplicate key|uq_resgate_execucoes_em_andamento/);
    });
    const item = (preco, sit = "ABAIXO_DA_META") => ({ itemId: "MLB1", clienteId: 133, situacao: sit, acao: "REVISAR_PRECO", historico: { origem: "SEM_ALTERACAO_REGISTRADA", mudancaRecente: false }, prioridade: 40, vendas30d: { unidades: 3 }, exposicao: { valor: 12.5 }, fingerprint: { precoVisto: preco }, titulo: "Camisa", sku: "SKU1" });
    await store.salvarItens(id, 86, [item(100), { ...item(50), itemId: "MLB2", prioridade: 10 }]);
    await t("paginação por prioridade, filtro e busca", async () => {
      const p = await store.paginaItens(id, 86, { limite: 1 });
      assert.strictEqual(p.total, 2); assert.strictEqual(p.itens[0].itemId, "MLB1");
      assert.strictEqual((await store.paginaItens(id, 86, { busca: "sku1" })).total, 2);
      assert.strictEqual((await store.paginaItens(id, 86, { situacao: "PRECO_OK" })).total, 0);
      assert.strictEqual((await store.paginaItens(id, 87, {})).total, 0, "isolamento por conta");
    });
    await t("filtros simples da bancada no SQL = montarBancada/passaFiltro item a item (meta da bancada ou do item)", async () => {
      const { montarContratoFinanceiro } = require("../services/resgate/resgateContrato");
      const { montarBancada, passaFiltro, FILTROS } = require("../services/resgate/resgateBancada");
      const mk = (itemId, { cheio, vigente, custo = 40, subsidioMl = null, comissao = 14, frete = 18, metaItem = 0.15 }) => ({
        itemId, clienteId: 133, situacao: "X", acao: "Y", historico: { origem: "SEM_ALTERACAO_REGISTRADA", mudancaRecente: false }, prioridade: 1, vendas30d: { unidades: 0 }, exposicao: {}, fingerprint: { precoVisto: vigente }, sku: "S", titulo: itemId,
        meta: { valor: metaItem },
        contrato: montarContratoFinanceiro({ conta: { clienteContaId: 88 }, anuncio: { itemId, logisticType: "cross_docking" }, precos: { cheio, vigente, promocional: cheio > vigente ? vigente : null },
          comissao: { valor: comissao, percentual: 0.14, precoBase: vigente }, frete: { valor: frete, freteQualidade: { nivel: "cotado_ml", avaliadoEm: "2026-11-12T00:00:00Z" } }, custo: { valor: custo }, imposto: { percentual: 0.13 }, taxaFixa: { valor: 0 },
          promocao: cheio > vigente ? { ativa: true, subsidioMl } : { ativa: false } }),
      });
      const casos = [mk("OK", { cheio: 100, vigente: 100 }), mk("BAIXO", { cheio: 100, vigente: 100, custo: 50 }), mk("PREJ", { cheio: 80, vigente: 80, custo: 60 }),
        mk("SEMCUSTO", { cheio: 100, vigente: 100, custo: null }), mk("PROMO_LB_BAIXO", { cheio: 120, vigente: 100, custo: 50 }), mk("PROMO_LB_OK", { cheio: 150, vigente: 130, custo: 40 }),
        mk("PROMO_SUB", { cheio: 120, vigente: 100, custo: 50, subsidioMl: 2 }), mk("META_ITEM_10", { cheio: 100, vigente: 100, custo: 45, metaItem: 0.1 })];
      await store.salvarItens(id, 88, casos);
      for (const meta of [null, 0.15, 0.05]) for (const f of FILTROS) {
        const sql = (await store.paginaItens(id, 88, { filtro: f, meta, limite: 100 })).itens.map((x) => x.itemId).sort();
        const js = casos.filter((x) => passaFiltro(montarBancada(x, { meta }), f)).map((x) => x.itemId).sort();
        assert.deepStrictEqual(sql, js, `filtro ${f} meta ${meta}`);
      }
    });
    await t("revisão só aceita o preço visto da proposta; reprocesso com outro preço INVALIDA a revisão", async () => {
      assert.strictEqual(await store.registrarRevisao(id, 86, "MLB1", { status: "APROVADO", precoVisto: 99 }), false);
      assert.strictEqual(await store.registrarRevisao(id, 86, "MLB1", { status: "APROVADO", precoVisto: 100, userId: 7 }), true);
      await store.salvarItens(id, 86, [item(100)]);
      assert.strictEqual((await store.item(id, 86, "MLB1")).revisao.status, "APROVADO");
      await store.salvarItens(id, 86, [item(94.9)]);
      assert.strictEqual((await store.item(id, 86, "MLB1")).revisao.status, "INVALIDADO");
    });
    await t("checkpoint, conta, cancelamento e retenção", async () => {
      await store.salvarCheckpoint(id, 86, { aposItemId: "MLB2", camada: 2 });
      assert.strictEqual((await store.lerCheckpoint(id, 86)).aposItemId, "MLB2");
      await store.salvarConta(id, 86, { resumo: { clienteId: 133, itens: 2 }, matriz: { decisao: "SEM_DADOS" } });
      assert.strictEqual((await store.listarContas(id, [133])).length, 1);
      assert.strictEqual((await store.listarContas(id, [999])).length, 0, "carteira filtra");
      assert.strictEqual(await store.solicitarCancelamento(id), true);
      assert.strictEqual(await store.pedidoDeCancelamento(id), true);
      await store.finalizarExecucao(id, "cancelada", {});
      for (let i = 0; i < 4; i++) { const x = await store.iniciarExecucao({}); await store.finalizarExecucao(x, "concluida", {}); }
      await store.aplicarRetencao(3);
      const { rows } = await db.query("SELECT count(*)::int n FROM resgate_execucoes");
      assert.strictEqual(rows[0].n, 3);
    });
    console.log(`\nresgateStore.postgres: ${ok} verificações`);
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${banco}`);
    await admin.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
