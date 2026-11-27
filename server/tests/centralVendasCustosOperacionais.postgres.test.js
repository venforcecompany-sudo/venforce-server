// server/tests/centralVendasCustosOperacionais.postgres.test.js
//
// Ads e Full do Financeiro na Central, contra PostgreSQL REAL e LOCAL:
//
//   CENTRAL_VENDAS_PG_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57661/postgres \
//     node tests/centralVendasCustosOperacionais.postgres.test.js
//
// Sem a variável o teste PULA. Host fora de localhost ⇒ recusa.
//   · sem as tabelas de cache: sem fonte (nunca zero), sem erro;
//   · com as migrations reais do Financeiro: só a conta e o slug pedidos voltam;
//   · valores NUMERIC lidos como texto (centavos exatos);
//   · mês inteiro ⇒ resultado operacional; período parcial ⇒ incompatível;
//     mês sem cache ⇒ indisponível.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

async function main() {
  const baseUrl = process.env.CENTRAL_VENDAS_PG_TEST_DATABASE_URL;
  if (!baseUrl) { console.log("centralVendasCustosOperacionais.postgres.test.js: PULADO (defina CENTRAL_VENDAS_PG_TEST_DATABASE_URL)"); return; }
  if (!LOCAL.has(new URL(baseUrl).hostname)) throw new Error("LOCAL_DATABASE_REQUIRED");
  const nome = `cv_custos_op_${process.pid}`;
  const adm = new Client({ connectionString: baseUrl });
  await adm.connect();
  await adm.query(`DROP DATABASE IF EXISTS ${nome}`);
  await adm.query(`CREATE DATABASE ${nome}`);
  const url = new URL(baseUrl); url.pathname = `/${nome}`;
  const db = new Client({ connectionString: url.toString() });
  await db.connect();
  let checks = 0;
  const ok = (label, cond) => { assert.ok(cond, `FALHOU: ${label}`); checks += 1; console.log(`  ✓ ${label}`); };
  try {
    const repo = require("../services/centralVendas/centralVendasRepository");
    const ops = require("../services/centralVendas/centralVendasCustosOperacionais");

    const semTabela = await repo.getCustosOperacionaisDoFinanceiro({ clienteContaId: 21, clienteSlug: "loja", meses: ["2026-10"] }, db);
    ok("sem as tabelas de cache: nenhuma fonte, sem erro", semTabela.ads.length === 0 && semTabela.full.length === 0 && !semTabela.tabelas.ads && !semTabela.tabelas.full);

    for (const f of ["20261020_financeiro_ads_cache.sql", "20261112_financeiro_full_cache.sql"]) {
      await db.query(fs.readFileSync(path.join(__dirname, "..", "sql", "migrations", f), "utf8"));
    }
    const comp = (a, b, c, d) => JSON.stringify([
      { grupo: "armazenagem", valor: a, lancamentos: 31 }, { grupo: "armazenamento_prolongado", valor: b, lancamentos: 2 },
      { grupo: "coleta", valor: c, lancamentos: 1 }, { grupo: "retirada", valor: d, lancamentos: 0 },
    ]);
    await db.query(`INSERT INTO financeiro_ads_cache (cliente_conta_id, mes_ref, cliente_slug, investimento_ads, gmv_ads, roas, campanhas, consultado_em) VALUES
      (21, '2026-10', 'loja', 2150.10, 15200.33, 7.07, 4, '2026-11-05T10:00:00Z'),
      (21, '2026-11', 'loja', 1760.00, 11500.00, 6.53, 4, '2026-11-26T06:00:00Z'),
      (22, '2026-10', 'loja', 9999.99, 1.00, 0, 1, '2026-11-05T10:00:00Z'),
      (21, '2026-09', 'outra-loja', 7777.77, 1.00, 0, 1, '2026-10-05T10:00:00Z')`);
    await db.query(`INSERT INTO financeiro_full_cache (cliente_conta_id, mes_ref, cliente_slug, custo_full, lancamentos, componentes, faturas, definitivo, consultado_em) VALUES
      (21, '2026-10', 'loja', 755.50, 34, $1::jsonb, '[]', TRUE, '2026-11-12T10:00:00Z'),
      (22, '2026-10', 'loja', 99.00, 1, $2::jsonb, '[]', TRUE, '2026-11-12T10:00:00Z')`, [comp(612.4, 48.1, 95, 0), comp(99, 0, 0, 0)]);

    const lido = await repo.getCustosOperacionaisDoFinanceiro({ clienteContaId: 21, clienteSlug: "loja", meses: ["2026-09", "2026-10", "2026-11"] }, db);
    ok("só a conta 21 e o slug pedidos voltam (outra conta e outro cliente ficam fora)",
      lido.ads.map((r) => r.mes_ref).sort().join(",") === "2026-10,2026-11" && lido.full.length === 1);
    ok("NUMERIC lido como texto exato", lido.ads.find((r) => r.mes_ref === "2026-10").investimento_ads === "2150.10");

    const fontes = ops.fontesDosCachesDoFinanceiro(lido, 21);
    const out = ops.resultadoOperacional({ periodo: { dateFrom: "2026-10-01", dateTo: "2026-10-31" }, clienteContaId: 21,
      resultadoVendaCentavos: 500000, receitaProdutoCentavos: 2500000, ...fontes });
    ok("outubro inteiro: Ads 2.150,10 e Full 755,50 entram; resultado operacional = 5.000 − 2.150,10 − 755,50",
      out.ads.investimento.centavos === 215010 && out.full.total.centavos === 75550 && out.resultadoOperacional.centavos === 500000 - 215010 - 75550);
    ok("Ads consolidado (consulta depois de M+1 dia 3) e Full consolidado", out.ads.cobertura[0].consolidado === true && out.full.estado === "consolidado");
    ok("TACOS com denominador da Central", out.ads.metricas.tacos.valor === 8.6 && out.ads.metricas.tacos.denominador.centavos === 2500000);

    const parcial = ops.resultadoOperacional({ periodo: { dateFrom: "2026-11-01", dateTo: "2026-11-25" }, clienteContaId: 21,
      resultadoVendaCentavos: 400000, receitaProdutoCentavos: 2000000, ...fontes });
    ok("novembro parcial: Ads mensal visível mas incompatível; Full sem fonte ⇒ indisponível; nada abatido",
      parcial.ads.compativel === false && parcial.ads.investimento.centavos === 176000 && parcial.full.disponivel === false
      && parcial.resultadoAposAds.centavos === null && parcial.resultadoOperacional.centavos === null);

    const outraConta = ops.resultadoOperacional({ periodo: { dateFrom: "2026-10-01", dateTo: "2026-10-31" }, clienteContaId: 22,
      resultadoVendaCentavos: 1, receitaProdutoCentavos: 1, ...fontes });
    ok("fontes lidas para a conta 21 nunca servem à conta 22", outraConta.ads.disponivel === false && outraConta.full.disponivel === false);

    // Ads da janela no run (centralVendasAdsJanela): SQL real de gravação e leitura.
    const aj = require("../services/centralVendas/centralVendasAdsJanela");
    await db.query(`CREATE TABLE central_vendas_sync_runs (id BIGSERIAL PRIMARY KEY, cliente_conta_id BIGINT, date_from DATE NOT NULL, date_to DATE NOT NULL,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT '2026-11-10T06:00:00Z')`);
    await db.query(`INSERT INTO central_vendas_sync_runs (cliente_conta_id, date_from, date_to, metadata_json) VALUES
      (21, '2026-11-01', '2026-11-09', '{"ordersLidos": 103}'), (22, '2026-11-01', '2026-11-09', '{}'), (21, '2026-10-01', '2026-10-31', '{}')`);
    const ads = { clienteContaId: 21, dateFrom: "2026-11-01", dateTo: "2026-11-09", investimentoAds: 747.56, gmvAds: 4003.25, consultadoEm: "2026-11-10T06:17:54Z" };
    ok("grava no run da conta com a mesma janela", await aj.gravarAdsDaJanela(db, { runId: 1, ...ads }) === true);
    ok("run de outra conta ou de outra janela: não grava",
      await aj.gravarAdsDaJanela(db, { runId: 2, ...ads }) === false && await aj.gravarAdsDaJanela(db, { runId: 3, ...ads }) === false);
    const run1 = (await db.query("SELECT metadata_json, updated_at FROM central_vendas_sync_runs WHERE id = 1")).rows[0];
    ok("preserva o metadata existente e não mexe no updated_at",
      run1.metadata_json.ordersLidos === 103 && run1.metadata_json.adsDaJanela.investimentoAds === 747.56 && new Date(run1.updated_at).toISOString() === "2026-11-10T06:00:00.000Z");
    const lidas = await aj.lerAdsDaJanela(db, { clienteContaId: 21, syncRunIds: ["1", 2, "3"] });
    const fonte = aj.fonteAdsDaJanela(lidas[0], 21);
    ok("lê só runs da conta com o registro; vira fonte janela exata",
      lidas.length === 1 && lidas[0].date_from === "2026-11-01" && fonte.cobertura.dateTo === "2026-11-09" && fonte.investimentoAds === 747.56);
    const r = ops.resultadoOperacional({ periodo: { dateFrom: "2026-11-01", dateTo: "2026-11-09" }, clienteContaId: 21, resultadoVendaCentavos: 500000, receitaProdutoCentavos: 2000000,
      fontesAds: [fonte], fontesFull: [] });
    ok("mês aberto com a janela: PARCIAL = venda − Ads da janela, Full declarado como faltando",
      r.estado === "parcial" && r.resultadoParcial.centavos === 425244 && r.resultadoParcial.faltando[0] === "full" && r.resultadoOperacional.centavos === null);
  } finally {
    await db.end();
    await adm.query(`DROP DATABASE IF EXISTS ${nome}`);
    await adm.end();
  }
  console.log(`centralVendasCustosOperacionais.postgres.test.js: ${checks} verificacoes OK`);
}

main().catch((err) => { console.error(err); process.exit(1); });
