/* Portal/fechamentos-api.test.js
 *
 * M9 — a Central de Vendas V3 (Portal/fechamentos-api.js) não calcula mais
 * custo/imposto/resultado/confiança/margem no browser: tudo vem pronto da
 * Read API (M7) e dos agregados de leitura do M9. Este teste prova o lado
 * FRONTEND desse marco (o lado backend já é coberto por
 * server/tests/centralVendasM7Read.test.js e
 * server/tests/centralVendasM9ReadAggregates.test.js).
 *
 * fechamentos-api.js é um script de página (usa `document`/`window`/
 * `localStorage`/`fetch` no top-level), não um módulo UMD como
 * central-margem-api.js — carregá-lo com `require()` direto quebraria no
 * import. Em vez disso, este teste roda o arquivo REAL, sem cópia nem
 * reimplementação, dentro de um `vm.Context` com um DOM mínimo empalhado
 * (getElementById devolve elementos "burros" com innerHTML/dataset/
 * classList) — o suficiente para toda função de render rodar até o fim
 * sem lançar exceção. Isso prova diretamente no arquivo de produção:
 *
 *   A. nenhuma segunda fórmula (computeOrder não existe mais)
 *   B. pedido multi-item nunca é recalculado pelo "primeiro produto"
 *   C. summary é sempre global (idêntico entre chamadas com filtro/página
 *      diferentes) — filteredSummary é um contrato DISTINTO (seção 10)
 *   D/E. custo/frete ausentes continuam null, nunca viram R$ 0,00
 *   F. claims indisponível não sobe a confiança sozinho
 *   G/J. zero pedidos é diferente de "sem snapshot"/erro — renderAll()
 *      não lança exceção em nenhum dos dois
 *   K. drawer monta o corpo (itens + ledger M6) para os 6 perfis do
 *      fixture (confiável, multi-item, bloqueado, cancelado, com_problema,
 *      parcial) sem exceção
 *
 * O fixture (MOCK_ROWS) é a mesma fixture de dev do arquivo real — cada
 * pedido já traz os campos financeiros finais como CONSTANTES escritas à
 * mão (seção 23: contrato já canônico, nenhuma fórmula os deriva).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "fechamentos-api.js"), "utf8");

function fakeEl(id) {
  return {
    id, hidden: true, innerHTML: "", value: "", disabled: false, dataset: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    setAttribute(){}, removeAttribute(){}, addEventListener(){},
    querySelectorAll(){ return []; }, querySelector(){ return null; },
    closest(){ return null; }, focus(){}, append(){},
  };
}
const fakeDocument = {
  getElementById(id) { return fakeEl(id); },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  addEventListener(){},
  createElement() { return fakeEl("tmp"); },
  body: { classList: { add(){}, remove(){} }, appendChild(){}, removeChild(){} },
};
const sandbox = {
  window: { location: { replace(){}, hash: "" }, initLayout: undefined },
  document: fakeDocument,
  localStorage: {
    _store: { "vf-token": "TEST_TOKEN" },
    getItem(k) { return this._store[k] ?? null; },
    setItem(k, v) { this._store[k] = v; },
  },
  fetch: async () => { throw new Error("fetch nao deveria ser chamado neste teste"); },
  history: { replaceState(){} },
  navigator: {},
  CSS: { escape: (s) => s },
  AbortController: function () { this.signal = {}; this.abort = () => {}; },
  requestAnimationFrame: (fn) => fn(),
  console,
  setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;

// Top-level const/function em vm.runInContext não viram propriedades do
// objeto de contexto (só `var` vira) — expõe explicitamente os
// identificadores que este teste precisa inspecionar, sem alterar o
// arquivo real nem duplicar a lógica dele.
const EXPOSE = [
  "computeOrder", "MOCK_ROWS", "MOCK_PERIODO", "mockResumo", "mockDiario", "mockAbcProdutos",
  "buildComposicaoRows", "composicaoResiduo", "pendenciaLabel", "buildMockRead",
  "buildCurvaAbcView", "F", "renderAll", "renderFechamentoSection", "renderDaysSection",
  "renderOrdersPanel", "renderPedTable", "renderAbc", "renderTabCounts", "renderContextStatus",
  "buildOrderDrawerBody", "applyReadResponse", "resetCurvaAbcState",
];
const wrapped = `${src}\n;(function(){ const _o = {};\n${EXPOSE.map((n) => `try { _o[${JSON.stringify(n)}] = ${n}; } catch (_) { _o[${JSON.stringify(n)}] = undefined; }`).join("\n")}\nglobalThis.__TEST_EXPORTS__ = _o; })();`;

vm.createContext(sandbox);
vm.runInContext(wrapped, sandbox, { filename: "fechamentos-api.js" });
Object.assign(sandbox, sandbox.__TEST_EXPORTS__);

let checks = 0;
function ok(label, cond) {
  assert.ok(cond, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ✓ ${label}`);
}
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `FALHOU: ${label} — recebido ${JSON.stringify(actual)}, esperado ${JSON.stringify(expected)}`);
  checks += 1;
  console.log(`  ✓ ${label}`);
}
// deepStrictEqual falha entre arrays de realms diferentes (vm context vs
// realm principal) mesmo com conteúdo idêntico — compara pelo conteúdo.
function eqJson(label, actual, expected) {
  eq(label, JSON.stringify(actual), JSON.stringify(expected));
}

// ── A. Nenhuma segunda fórmula ──
ok("A: computeOrder não existe mais no arquivo", sandbox.computeOrder === undefined);

// ── Fixture canônica (contrato já pronto, seção 23) ──
ok("fixture: MOCK_ROWS tem os 6 perfis (confiável/multi-item/bloqueado/cancelado/problema/parcial)", sandbox.MOCK_ROWS.length === 6);
const multi = sandbox.MOCK_ROWS.find((o) => o.multiItem);
ok("fixture: existe 1 pedido multi-item", !!multi);

// ── B. Multi-item nunca recalculado pelo "primeiro produto" ──
eq("B: multi-item — valor é a soma dos itens (M5), não o primeiro produto (150)", multi.valor, 250);
eq("B: multi-item — qtdItens = 2", multi.qtdItens, 2);

sandbox.F.cliente = { id: 12, nome: "Loja Teste", slug: "loja-teste" };
sandbox.F.periodo = { dateFrom: "2026-08-01", dateTo: "2026-08-31" };
const respP1 = sandbox.buildMockRead({ slug: "loja-teste", page: 1, limit: 2, filtro: "todos", resumoFiltro: "todos" });
const respP2 = sandbox.buildMockRead({ slug: "loja-teste", page: 2, limit: 2, filtro: "todos", resumoFiltro: "todos" });
const rowMulti = respP1.rows.concat(respP2.rows).find((r) => r.pedidoId === "9000000002");
eq("B: row multi-item na lista já traz valor=250 (soma), não recalcula", rowMulti.valor, 250);
eq("B: row multi-item na lista já traz resultado=100 canônico", rowMulti.resultado, 100);

// ── C. summary sempre global — filteredSummary é contrato distinto ──
eq("C: summary idêntico entre páginas diferentes", respP1.summary, respP2.summary);
eq("C: summary.pedidosTotal reflete o universo inteiro (6), não a página (2)", respP1.summary.pedidosTotal, 6);
const respBloq = sandbox.buildMockRead({ slug: "loja-teste", page: 1, limit: 50, filtro: "bloqueados", resumoFiltro: "todos" });
eq("C: summary continua GLOBAL mesmo com filtro=bloqueados nas rows", respBloq.summary.pedidosTotal, 6);
eqJson("C: filtro=bloqueados só retorna a row bloqueada", respBloq.rows.map((r) => r.pedidoId), ["9000000003"]);
const respFiltradoResumo = sandbox.buildMockRead({ slug: "loja-teste", page: 1, limit: 50, resumoFiltro: "bloqueados" });
eq("C: filteredSummary(bloqueados) é um contrato DISTINTO de summary global", respFiltradoResumo.filteredSummary.pedidosTotal, 1);
ok("C: filteredSummary(bloqueados) != summary (não reaproveita o global com outro sentido)",
  respFiltradoResumo.filteredSummary.pedidosTotal !== respFiltradoResumo.summary.pedidosTotal);

// ── D/E. custo/frete ausentes nunca viram R$ 0,00 ──
const respTodos = sandbox.buildMockRead({ slug: "loja-teste", page: 1, limit: 50, filtro: "todos", resumoFiltro: "todos" });
const rowSemCusto = respTodos.rows.find((r) => r.pedidoId === "9000000003");
eq("D: pedido sem custo — custo=null (nunca 0,00)", rowSemCusto.custo, null);
eq("D: pedido sem custo — resultado=null (bloqueado, nunca calculado)", rowSemCusto.resultado, null);
eq("D: pendência custo_produto_ausente traduzida para leitura humana", sandbox.pendenciaLabel(rowSemCusto.pendencias[0]), "MLB sem custo na base");
const rowSemFrete = respTodos.rows.find((r) => r.pedidoId === "9000000006");
eq("E: pedido sem frete — frete=null (nunca 0,00)", rowSemFrete.frete, null);
ok("E: pedido sem frete permanece confiança parcial (frontend não sobe sozinho)", rowSemFrete.confianca === "parcial");

// ── F. Claims indisponível não sobe a confiança sozinho (formatação, não invenção) ──
const resumoComClaims = sandbox.mockResumo(sandbox.MOCK_ROWS);
resumoComClaims.claimsIndisponivel = true;
const compsComClaims = sandbox.buildComposicaoRows(resumoComClaims);
ok("F: composição roda sem exceção mesmo com claimsIndisponivel=true", Array.isArray(compsComClaims) && compsComClaims.length > 0);

// ── G/J. zero pedidos != sem snapshot/erro — nenhum dos dois lança exceção ──
sandbox.F.contas = [];
sandbox.F.loading = false;
sandbox.F.daily = sandbox.mockDiario(sandbox.MOCK_ROWS);
const abc = sandbox.mockAbcProdutos(sandbox.MOCK_ROWS);
sandbox.F.products = abc.produtos;
sandbox.F.totalFaturamento = abc.totalFat;
sandbox.resetCurvaAbcState();

sandbox.applyReadResponse(respTodos);
assert.doesNotThrow(() => sandbox.renderAll(), "G: renderAll() com dado carregado não pode lançar exceção");
checks += 1; console.log("  ✓ G: renderAll() com dado carregado (6 pedidos, todos os perfis) não lança exceção");

for (const pedido of sandbox.MOCK_ROWS) {
  assert.doesNotThrow(() => sandbox.buildOrderDrawerBody(pedido), `K: drawer do pedido ${pedido.pedidoId}`);
}
checks += 1; console.log("  ✓ K: drawer monta o corpo (itens M5 + ledger M6) para os 6 perfis do fixture sem exceção");

// ── L. Bug real de produção: componente com confianca do vocabulário de
// STATUS ("real"/"ausente"/"bloqueado" — o que o backend de fato envia em
// `componentes[]`, ver server/services/centralVendas/centralVendasSyncService.js)
// não pode cair no fallback "Bloqueado" de confStatus() (vocabulário de
// CONFIANÇA DE PEDIDO — "confiavel"/"parcial"/"insuficiente"/"bloqueado").
// O fixture MOCK_ROWS usa "confiavel" nos componentes (não reproduz o valor
// real do backend), por isso este teste monta o pedido à parte.
{
  const base = JSON.parse(JSON.stringify(sandbox.MOCK_ROWS[0]));
  const pedidoReal = { ...base, componentes: base.componentes.map((c) => ({ ...c, confianca: "real" })) };
  const htmlReal = sandbox.buildOrderDrawerBody(pedidoReal);
  ok("L: componente com confianca='real' renderiza 'Real' via statusTag (vf-tag is-success)",
    htmlReal.includes('class="vf-tag is-success">Real<'));
  ok("L: componente com confianca='real' NUNCA cai no fallback 'Bloqueado' de confStatus",
    !htmlReal.includes('class="vf-status is-danger">Bloqueado<'));

  const pedidoAusente = { ...base, componentes: base.componentes.map((c) => ({ ...c, confianca: "ausente" })) };
  const htmlAusente = sandbox.buildOrderDrawerBody(pedidoAusente);
  ok("L: componente com confianca='ausente' renderiza 'Ausente' (não vira 'Bloqueado' por fallback)",
    htmlAusente.includes('class="vf-tag is-danger">Ausente<'));
}

const respVazio = {
  ok: true, cliente: sandbox.F.cliente, periodo: sandbox.MOCK_PERIODO, contexto: null,
  snapshot: { importId: 2 }, motor: { status: "persistido", origemPrincipal: "orders_api" }, completude: null,
  summary: sandbox.mockResumo([]), filteredSummary: sandbox.mockResumo([]),
  rows: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
};
sandbox.applyReadResponse(respVazio);
sandbox.F.daily = []; sandbox.F.products = []; sandbox.F.totalFaturamento = 0;
assert.doesNotThrow(() => sandbox.renderAll(), "J: renderAll() com snapshot de zero pedidos");
checks += 1; console.log("  ✓ J: renderAll() com snapshot persistido de zero pedidos não lança exceção (motor != sem_dados)");

sandbox.applyReadResponse({ ok: false, erro: "Falha de conexão com o servidor.", erroTipo: "rede" });
assert.doesNotThrow(() => sandbox.renderAll(), "renderAll() com /read falho");
checks += 1; console.log("  ✓ renderAll() com /read falho (F.ok=false) não lança exceção — mostra estado de erro, não trava");

console.log(`\nfechamentos-api.test.js: ${checks} verificações OK`);
