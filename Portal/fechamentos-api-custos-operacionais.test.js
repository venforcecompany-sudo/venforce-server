/* Portal/fechamentos-api-custos-operacionais.test.js
 *
 * Bloco "Depois da margem: Ads e Full" da aba de fechamento, alimentado pelo
 * contrato REAL do backend (centralVendasCustosOperacionais.resultadoOperacional):
 *   · mês inteiro: Ads e Full abatidos, consolidados, métricas com denominador;
 *   · período parcial: "Fora do período", referência do mês, resultado "Não calculável";
 *   · sem conta / sem fonte: motivo explícito, nunca R$ 0,00.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const ops = require(path.join(__dirname, "..", "server", "services/centralVendas/centralVendasCustosOperacionais"));

const src = fs.readFileSync(path.join(__dirname, "fechamentos-api.js"), "utf8");
const fakeEl = (id) => ({ id, innerHTML: "", dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute() {}, removeAttribute() {}, addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; }, closest() { return null; }, focus() {}, append() {} });
const sb = { window: { location: { replace() {}, hash: "" } }, document: { getElementById: fakeEl, querySelectorAll() { return []; }, querySelector() { return null; }, addEventListener() {}, createElement() { return fakeEl("t"); }, body: { classList: { add() {}, remove() {} } } },
  localStorage: { getItem() { return "T"; }, setItem() {} }, fetch: async () => { throw new Error("fetch"); }, history: { replaceState() {} }, navigator: {}, CSS: { escape: (s) => s },
  AbortController: function () { this.signal = {}; this.abort = () => {}; }, requestAnimationFrame: (f) => f(), console, setTimeout, clearTimeout };
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(`${src}\n;globalThis.__T__ = { buildCustosOperacionaisBloco, applyReadResponse, F };`, sb);
const { buildCustosOperacionaisBloco, applyReadResponse, F } = sb.__T__;

let checks = 0;
const ok = (l, c) => { assert.ok(c, `FALHOU: ${l}`); checks += 1; console.log(`  ✓ ${l}`); };
const adsMes = (mes, inv, gmv, consultadoEm) => ops.fonteAdsDoCacheFinanceiro({ disponivel: true, investimentoAds: inv, gmvAds: gmv, consultadoEm }, { clienteContaId: 21, mes });
const fullMes = { clienteContaId: 21, mes: "2026-10", disponivel: true, definitivo: true, consultadoEm: "2026-11-12T10:00:00Z", componentes: [{ grupo: "armazenagem", valor: 612.4, lancamentos: 31 }, { grupo: "coleta", valor: 95, lancamentos: 1 }] };
const json = (x) => JSON.parse(JSON.stringify({ disponivel: true, ...x }));

{
  const co = json(ops.resultadoOperacional({ periodo: { dateFrom: "2026-10-01", dateTo: "2026-10-31" }, clienteContaId: 21, resultadoVendaCentavos: 500000, receitaProdutoCentavos: 2500000,
    fontesAds: [adsMes("2026-10", 2150.1, 15200.33, "2026-11-05T10:00:00Z")], fontesFull: [fullMes] }));
  const h = buildCustosOperacionaisBloco(co);
  ok("mês inteiro: Ads, Full e resultado após Ads e Full", h.includes("− R$ 2.150,10") && h.includes("− R$ 707,40") && h.includes("R$ 2.142,50"));
  ok("consolidado e métricas com denominador no title", h.includes("Consolidado") && h.includes("TACOS 8,6%") && h.includes("receita de produtos da Central"));
  ok("composição do Full e aviso do frete Full", h.includes("armazenagem R$ 612,40") && h.includes("já está no frete de cada pedido"));
}
{
  const co = json(ops.resultadoOperacional({ periodo: { dateFrom: "2026-11-01", dateTo: "2026-11-25" }, clienteContaId: 21, resultadoVendaCentavos: 400000, receitaProdutoCentavos: 2000000,
    fontesAds: [adsMes("2026-11", 1760, 11500, "2026-11-26T06:00:00Z")], fontesFull: [] }));
  const h = buildCustosOperacionaisBloco(co);
  ok("período parcial: Ads fora do período com referência do mês, Full indisponível, resultado não calculável",
    h.includes("Fora do período") && h.includes("Referência do mês: R$ 1.760,00") && h.includes("Indisponível") && h.includes("Não calculável")
    && h.includes("não é um mês inteiro") && h.includes("sem consulta no Financeiro"));
  ok("nada vira R$ 0,00", !h.includes("R$ 0,00"));
}
{
  ok("sem conta: motivo explícito", buildCustosOperacionaisBloco({ disponivel: false, motivo: "conta_nao_resolvida" }).includes("escolha uma conta"));
  ok("sem dado: bloco vazio", buildCustosOperacionaisBloco(null) === "");
}
{
  applyReadResponse({ ok: true, summary: {}, rows: [], custosOperacionais: { disponivel: false, motivo: "x" } });
  applyReadResponse({ ok: true, summary: {}, rows: [] });
  ok("um /read de paginação não apaga os custos vindos do bootstrap", F.custosOperacionais && F.custosOperacionais.motivo === "x");
}
{
  const co = json(ops.resultadoOperacional({ periodo: { dateFrom: "2026-11-01", dateTo: "2026-11-30" }, clienteContaId: 21, resultadoVendaCentavos: 400000, receitaProdutoCentavos: 2000000,
    fontesAds: [adsMes("2026-11", 1760, 11500, "2026-11-26T06:00:00Z")], fontesFull: [] }));
  const h = buildCustosOperacionaisBloco(co);
  ok("mês ainda aberto: Ads consultado antes do fim do mês não é abatido e o motivo é dito", h.includes("consultada antes do fim do mês") && h.includes("Fora do período") && h.includes("Não calculável"));
}
console.log(`\nfechamentos-api-custos-operacionais.test.js: ${checks} verificações OK`);
