// server/tests/centralVendasAdsJanela.test.js
//
// Ads da MESMA janela das vendas (por conta, gravado no run do sync noturno) e
// os estados do resultado depois de Ads e Full: consolidado, provisório,
// parcial e indisponível. Valores de exemplo = conta piloto real (Ads de
// novembro até 09/11 = R$ 747,56 no sync; Financeiro consultou em 10/11 de
// manhã = R$ 766,32, com parte do dia 10).
process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/teste-sem-banco";
const test = require("node:test");
const assert = require("node:assert/strict");
const ops = require("../services/centralVendas/centralVendasCustosOperacionais");
const aj = require("../services/centralVendas/centralVendasAdsJanela");
const { recortarPelaCobertura } = require("../services/centralVendas/centralVendasReadService");

const NOV_1_9 = { dateFrom: "2026-11-01", dateTo: "2026-11-09" };
const janela = (o = {}) => ({ escopo: "conta", clienteContaId: 21, cobertura: { tipo: "janela", ...NOV_1_9 }, disponivel: true, investimentoAds: 747.56, gmvAds: 4003.25, consultadoEm: "2026-11-10T06:17:54Z", origem: "mercado_ads_sync_noturno", ...o });
const cacheFinanceiro = (o = {}) => ({ escopo: "conta", clienteContaId: 21, cobertura: { tipo: "mes", mes: "2026-11" }, disponivel: true, investimentoAds: 766.32, gmvAds: 4154.55, consultadoEm: "2026-11-10T12:42:13Z", ...o });
const full = (mes, o = {}) => ({ clienteContaId: 21, mes, disponivel: true, definitivo: true, consultadoEm: "2026-12-12T10:00:00Z", componentes: [{ grupo: "armazenagem", valor: 100, lancamentos: 3 }], ...o });
const base = { clienteContaId: 21, resultadoVendaCentavos: 500000, receitaProdutoCentavos: 2000000 };

test("mês aberto: Ads da janela exata (provisório) + Full sem fonte ⇒ PARCIAL, desconta só o Ads e diz que faltou o Full", () => {
  const r = ops.resultadoOperacional({ ...base, periodo: NOV_1_9, fontesAds: [cacheFinanceiro(), janela()], fontesFull: [] });
  assert.equal(r.ads.situacao, "provisorio");
  assert.equal(r.ads.investimento.centavos, 74756, "usa a janela do sync, não o cache do Financeiro (outra janela)");
  assert.equal(r.ads.cobertura[0].origem, "mercado_ads_sync_noturno");
  assert.equal(r.full.situacao, "indisponivel");
  assert.equal(r.estado, "parcial");
  assert.deepEqual(r.resultadoParcial, { centavos: 500000 - 74756, margemPercentual: 21.26, incluidos: ["ads"], faltando: ["full"] });
  assert.equal(r.resultadoOperacional.centavos, null, "sem Full não há resultado após Ads e Full (nunca Full = 0)");
  assert.equal(r.resultadoAposAds.centavos, 500000 - 74756);
});

test("sem a janela: o cache do Financeiro de 10/11 continua fora (outra janela) ⇒ indisponível como antes", () => {
  const r = ops.resultadoOperacional({ ...base, periodo: NOV_1_9, fontesAds: [cacheFinanceiro()], fontesFull: [] });
  assert.equal(r.ads.situacao, "incompativel");
  assert.equal(r.ads.motivoIncompativel, "periodo_parcial_com_fonte_mensal");
  assert.equal(r.estado, "indisponivel");
  assert.equal(r.resultadoParcial, null);
});

test("janela com outras datas (1–8 para vendas 1–9) não é candidata", () => {
  const r = ops.avaliarAds({ periodo: NOV_1_9, clienteContaId: 21, fontesAds: [janela({ cobertura: { tipo: "janela", dateFrom: "2026-11-01", dateTo: "2026-11-08" } })], receitaProdutoCentavos: 1 });
  assert.equal(r.situacao, "indisponivel");
  assert.deepEqual(r.codigos, ["SEM_FONTE"]);
});

test("janela de OUTRA conta é recusada", () => {
  const r = ops.avaliarAds({ periodo: NOV_1_9, clienteContaId: 21, fontesAds: [janela({ clienteContaId: 22 })], receitaProdutoCentavos: 1 });
  assert.equal(r.situacao, "indisponivel");
  assert.equal(r.recusadas[0].motivo, "outra_conta");
});

test("mês fechado: Ads e Full consultados depois de consolidar ⇒ CONSOLIDADO", () => {
  const out = { dateFrom: "2026-10-01", dateTo: "2026-10-31" };
  const r = ops.resultadoOperacional({ ...base, periodo: out,
    fontesAds: [cacheFinanceiro({ cobertura: { tipo: "mes", mes: "2026-10" }, consultadoEm: "2026-11-05T10:00:00Z" })], fontesFull: [full("2026-10")] });
  assert.equal(r.estado, "consolidado");
  assert.equal(r.resultadoOperacional.centavos, 500000 - 76632 - 10000);
});

test("mês fechado mas ainda dentro dos 3 dias / fatura aberta ⇒ PROVISÓRIO", () => {
  const out = { dateFrom: "2026-10-01", dateTo: "2026-10-31" };
  const r = ops.resultadoOperacional({ ...base, periodo: out,
    fontesAds: [janela({ cobertura: { tipo: "janela", ...out }, consultadoEm: "2026-11-01T06:28:00Z" })],
    fontesFull: [full("2026-10", { definitivo: false, consultadoEm: "2026-11-02T10:00:00Z" })] });
  assert.equal(r.ads.situacao, "provisorio");
  assert.equal(r.full.situacao, "provisorio");
  assert.equal(r.estado, "provisorio");
  assert.notEqual(r.resultadoOperacional.centavos, null);
});

test("dois meses: outubro consolidado + novembro pela janela ⇒ soma os dois pedaços, provisório", () => {
  const p = { dateFrom: "2026-10-01", dateTo: "2026-11-09" };
  const r = ops.avaliarAds({ periodo: p, clienteContaId: 21, receitaProdutoCentavos: 1,
    fontesAds: [cacheFinanceiro({ cobertura: { tipo: "mes", mes: "2026-10" }, investimentoAds: 2467.24, consultadoEm: "2026-11-05T06:01:29Z" }), janela()] });
  assert.equal(r.situacao, "provisorio");
  assert.equal(r.investimento.centavos, 246724 + 74756);
  assert.deepEqual(r.cobertura.map((c) => [c.mes, c.tipoFonte, c.situacao]), [["2026-10", "mes", "consolidado"], ["2026-11", "janela", "provisorio"]]);
});

test("só o Full cobre (Ads sem permissão) ⇒ PARCIAL com o Full", () => {
  const out = { dateFrom: "2026-10-01", dateTo: "2026-10-31" };
  const r = ops.resultadoOperacional({ ...base, periodo: out, fontesAds: [cacheFinanceiro({ cobertura: { tipo: "mes", mes: "2026-10" }, disponivel: false, codigo: "NO_ADS_PERMISSION" })], fontesFull: [full("2026-10")] });
  assert.equal(r.estado, "parcial");
  assert.deepEqual([r.resultadoParcial.centavos, r.resultadoParcial.incluidos, r.resultadoParcial.faltando], [490000, ["full"], ["ads"]]);
  assert.deepEqual(r.ads.codigos, ["NO_ADS_PERMISSION"]);
});

test("flag do Ads da janela: desligada por padrão; ligada só para as contas listadas ou *", () => {
  assert.equal(aj.isAdsDaJanelaHabilitado({ clienteContaId: 21 }, {}), false);
  assert.equal(aj.isAdsDaJanelaHabilitado({ clienteContaId: 21 }, { CENTRAL_VENDAS_ADS_JANELA: "true" }), false);
  assert.equal(aj.isAdsDaJanelaHabilitado({ clienteContaId: 21 }, { CENTRAL_VENDAS_ADS_JANELA: "true", CENTRAL_VENDAS_ADS_JANELA_CONTAS: "21" }), true);
  assert.equal(aj.isAdsDaJanelaHabilitado({ clienteContaId: 22 }, { CENTRAL_VENDAS_ADS_JANELA: "true", CENTRAL_VENDAS_ADS_JANELA_CONTAS: "21" }), false);
  assert.equal(aj.isAdsDaJanelaHabilitado({ clienteContaId: 9 }, { CENTRAL_VENDAS_ADS_JANELA: "on", CENTRAL_VENDAS_ADS_JANELA_CONTAS: "*" }), true);
});

test("registro: só números e datas válidas; valor ausente/negativo não vira zero", () => {
  assert.equal(aj.registroAdsDaJanela({ clienteContaId: 21, dateFrom: "2026-11-01", dateTo: "2026-11-09", investimentoAds: null, gmvAds: 1 }), null);
  assert.equal(aj.registroAdsDaJanela({ clienteContaId: 21, dateFrom: "2026-11-01", dateTo: "2026-11-09", investimentoAds: -1, gmvAds: 1 }), null);
  assert.equal(aj.registroAdsDaJanela({ clienteContaId: 21, dateFrom: "01/11", dateTo: "2026-11-09", investimentoAds: 1, gmvAds: 1 }), null);
  const r = aj.registroAdsDaJanela({ clienteContaId: 21, dateFrom: "2026-11-01", dateTo: "2026-11-09", investimentoAds: 747.564, gmvAds: 4003.25, consultadoEm: "2026-11-10T06:17:54Z" });
  assert.deepEqual(Object.keys(r).sort(), ["clienteContaId", "consultadoEm", "dateFrom", "dateTo", "fonte", "gmvAds", "investimentoAds", "v"]);
  assert.equal(r.investimentoAds, 747.56);
});

test("gravar: UPDATE no run com conta e janela no WHERE; 0 linhas ⇒ false", async () => {
  const chamadas = [];
  const db = { async query(sql, params) { chamadas.push({ sql, params }); return { rowCount: params[2] === 21 ? 1 : 0 }; } };
  const ok = await aj.gravarAdsDaJanela(db, { runId: 7, clienteContaId: 21, dateFrom: "2026-11-01", dateTo: "2026-11-09", investimentoAds: 1, gmvAds: 2 });
  assert.equal(ok, true);
  assert.match(chamadas[0].sql, /WHERE id = \$1 AND cliente_conta_id = \$3 AND date_from = \$4::date AND date_to = \$5::date/);
  assert.doesNotMatch(chamadas[0].sql, /updated_at/, "não mexe no updated_at do run");
  assert.equal(await aj.gravarAdsDaJanela(db, { runId: 7, clienteContaId: 22, dateFrom: "2026-11-01", dateTo: "2026-11-09", investimentoAds: 1, gmvAds: 2 }), false);
  assert.equal(await aj.gravarAdsDaJanela(db, { runId: 7, clienteContaId: 21, dateFrom: "2026-11-01", dateTo: "2026-11-09", investimentoAds: null, gmvAds: 2 }), false);
  assert.equal(chamadas.length, 2, "registro inválido nem chega ao banco");
});

test("ler → fonte: run de outra conta ou janela que não confere com o run é descartada", () => {
  const ads = { v: 1, clienteContaId: 21, dateFrom: "2026-11-01", dateTo: "2026-11-09", investimentoAds: 747.56, gmvAds: 4003.25, consultadoEm: "2026-11-10T06:17:54Z", fonte: "mercado_ads_sync_noturno" };
  const f = aj.fonteAdsDaJanela({ id: "5020", cliente_conta_id: "21", date_from: "2026-11-01", date_to: "2026-11-09", ads }, 21);
  assert.deepEqual([f.cobertura, f.investimentoAds, f.syncRunId], [{ tipo: "janela", dateFrom: "2026-11-01", dateTo: "2026-11-09" }, 747.56, "5020"]);
  assert.equal(aj.fonteAdsDaJanela({ id: "1", cliente_conta_id: "22", date_from: "2026-11-01", date_to: "2026-11-09", ads }, 21), null);
  assert.equal(aj.fonteAdsDaJanela({ id: "1", cliente_conta_id: "21", date_from: "2026-11-01", date_to: "2026-11-08", ads }, 21), null);
  assert.equal(aj.fonteAdsDaJanela({ id: "1", cliente_conta_id: "21", date_from: "2026-11-01", date_to: "2026-11-09", ads: { ...ads, clienteContaId: 22 } }, 21), null);
});

test("recorte do período pela cobertura das vendas: contínua recorta; buraco ou sem cobertura não recorta", () => {
  const imp = (de, ate, conta = 21) => ({ cliente_conta_id: conta, coverage_date_from: de, coverage_date_to: ate, sync_run_id: 1 });
  assert.deepEqual(recortarPelaCobertura({ dateFrom: "2026-11-01", dateTo: "2026-11-27" }, [imp("2026-11-01", "2026-11-09")], 21), NOV_1_9);
  assert.deepEqual(recortarPelaCobertura({ dateFrom: "2026-10-15", dateTo: "2026-11-27" }, [imp("2026-10-01", "2026-10-31"), imp("2026-11-01", "2026-11-09")], 21), { dateFrom: "2026-10-15", dateTo: "2026-11-09" });
  const p = { dateFrom: "2026-10-01", dateTo: "2026-11-27" };
  assert.deepEqual(recortarPelaCobertura(p, [imp("2026-10-01", "2026-10-20"), imp("2026-11-01", "2026-11-09")], 21), p, "buraco 21–31/10 ⇒ sem recorte");
  assert.deepEqual(recortarPelaCobertura(p, [imp("2026-10-01", "2026-10-31", 22)], 21), p, "import de outra conta não conta");
  assert.deepEqual(recortarPelaCobertura(p, [{ cliente_conta_id: 21, coverage_date_from: null, coverage_date_to: null }], 21), p);
  assert.deepEqual(recortarPelaCobertura({ dateFrom: "2026-11-01", dateTo: "2026-11-09" }, [imp(new Date(2026, 10, 1), new Date(2026, 10, 9))], 21), NOV_1_9, "aceita Date do pg (meia-noite local)");
});
