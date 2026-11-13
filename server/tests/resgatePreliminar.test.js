// Simulação PRELIMINAR (sem ML) e propostas em lote: mesmo núcleo do Resgate, sempre marcada
// PRELIMINAR, nunca apresentada como recotada; exceções com motivo; nada é aplicado.
const assert = require("assert");
const { simularPreliminar, propostasEmLote, entradaDoContratoAuditado } = require("../services/resgate/resgateSimulacaoPreliminar");
const { montarContratoFinanceiro } = require("../services/resgate/resgateContrato");
const { classificarFinanciamento } = require("../services/resgate/resgatePromocaoFinanciamento");
const { montarBancada, passaFiltro } = require("../services/resgate/resgateBancada");

let ok = 0;
const pend = [];
function t(n, fn) { pend.push(async () => { try { await fn(); ok++; console.log(`  ✓ ${n}`); } catch (e) { console.error(`  ✗ ${n}\n    ${e.stack}`); process.exitCode = 1; } }); }

const entrada = (o = {}) => ({
  conta: { clienteContaId: 86 }, anuncio: { itemId: "MLB1", logisticType: "cross_docking" },
  precos: { cheio: 149.9, vigente: 129.9, promocional: 129.9, fonte: "snapshot do Motor (sale_price)" },
  promocao: { ativa: true, subsidioMl: null }, comissao: { valor: 24.68, percentual: 0.19, precoBase: 129.9, fonte: "snapshot (listing_prices)" },
  frete: { valor: 19.05, freteQualidade: { nivel: "estimado_dimensoes_declaradas", confianca: "media" } },
  custo: { valor: 62, fonte: "base de custos" }, imposto: { percentual: 0.13, fonte: "base de custos" }, taxaFixa: { valor: 0, fonte: "base de custos" }, ...o,
});
const fin = classificarFinanciamento({ iniciadas: [{ id: "C-1", type: "SELLER_CAMPAIGN", status: "started", price: 129.9, original_price: 149.9, meli_percentage: null, seller_percentage: null, name: "PROMO", camposBoost: [] }], vigente: 129.9, cheio: 149.9 });
const item = (o = {}) => ({ itemId: "MLB1", titulo: "Calça", contrato: montarContratoFinanceiro(entrada()), promocaoFinanciamento: fin, fingerprint: { precoVisto: 129.9 }, vendas30d: { unidades: 10 }, meta: { valor: 0.15 }, ...o });

t("preliminar no preço atual reproduz o contrato auditado (sem o subsídio, que não passa para preço novo)", async () => {
  const x = item(), r = await simularPreliminar(x, [129.9]);
  assert.strictEqual(r.tipo, "PRELIMINAR"); assert.strictEqual(r.simulacoes[0].tipo, "PRELIMINAR");
  assert.strictEqual(r.simulacoes[0].resultado.lucro, x.contrato.resultado.lucro);
});
t("preliminar mantém o % e a parte fixa da comissão e o frete de hoje; avisa ao cruzar R$ 79", async () => {
  const r = await simularPreliminar(item(), [152.93, 75]);
  assert.strictEqual(r.simulacoes[0].comissao.valor, 29.06); assert.strictEqual(r.simulacoes[0].frete.valor, 19.05);
  assert.ok(r.simulacoes[1].avisos.some((a) => /R\$ 79/.test(a)));
  assert.ok(r.simulacoes[0].avisos.some((a) => /confirma no Mercado Livre/.test(a)));
});
t("preliminar sem contrato → recusa com motivo", async () => {
  assert.strictEqual((await simularPreliminar({ itemId: "X" }, [10])).ok, false);
  assert.strictEqual(entradaDoContratoAuditado({}), null);
});
t("bancada: campanha do vendedor por baixo da promoção que forma o preço fica visível", () => {
  const f = classificarFinanciamento({ iniciadas: [
    { id: "C-1", type: "SELLER_CAMPAIGN", status: "started", price: 118.8, original_price: 137.5, meli_percentage: null, seller_percentage: null, name: "PROMO", camposBoost: [] },
    { id: "P-2", type: "SMART", status: "started", price: 114, original_price: 137.5, meli_percentage: 3.1, seller_percentage: 14, name: "Moda", camposBoost: [] }], vigente: 114, cheio: 137.5 });
  assert.strictEqual(f.iniciadas.length, 2); assert.strictEqual(f.iniciadas.find((x) => x.formaPreco).id, "P-2");
  const b = montarBancada(item({ contrato: montarContratoFinanceiro(entrada({ precos: { cheio: 137.5, vigente: 114, promocional: 114 } })), promocaoFinanciamento: f }), { meta: 0.15 });
  assert.deepStrictEqual(b.precos.campanhaVendedor, { id: "C-1", nome: "PROMO", tipoRotulo: "Campanha própria do vendedor", preco: 118.8 });
  assert.strictEqual(b.promocao.subsidio, 4.26);
});
t("filtros novos: atencao = tudo que não está na meta; na_meta = status OK", () => {
  const b = montarBancada(item(), { meta: 0.15 });
  assert.strictEqual(b.status, "ABAIXO_DA_META"); assert.ok(passaFiltro(b, "atencao")); assert.ok(!passaFiltro(b, "na_meta"));
  const ok2 = montarBancada(item(), { meta: 0.02 }); assert.ok(passaFiltro(ok2, "na_meta")); assert.ok(!passaFiltro(ok2, "atencao"));
});
t("lote: campanha própria abaixo da meta → proposta PRELIMINAR (fim ,90); o resto vira exceção com motivo", async () => {
  const semPromo = item({ itemId: "MLB2", contrato: montarContratoFinanceiro(entrada({ precos: { cheio: 129.9, vigente: 129.9 }, promocao: { ativa: false } })), promocaoFinanciamento: null });
  const bloq = item({ itemId: "MLB3", contrato: montarContratoFinanceiro(entrada({ custo: { valor: null } })) });
  const r = await propostasEmLote([item(), semPromo, bloq], { estrategia: "SAIR_CAMPANHA", meta: 15, tetoAumento: 30, terminarEm90: true });
  assert.strictEqual(r.prontos.length, 1); const p = r.prontos[0];
  assert.strictEqual(p.tipo, "PRELIMINAR"); assert.ok(/,?\.9$/.test(String(p.precoProposto)) || String(p.precoProposto).endsWith(".9"), String(p.precoProposto));
  assert.ok(p.margemProposta >= 15); assert.strictEqual(p.precoVisto, 129.9);
  const tipos = r.excecoes.map((e) => [e.itemId, e.tipo]);
  assert.deepStrictEqual(tipos, [["MLB2", "NAO_SE_APLICA"], ["MLB3", "BLOQUEADO"]]);
});
t("lote: aumento acima do teto vira exceção (decisão do gestor), não proposta pronta", async () => {
  const r = await propostasEmLote([item()], { estrategia: "SAIR_CAMPANHA", meta: 15, tetoAumento: 5 });
  assert.strictEqual(r.prontos.length, 0); assert.strictEqual(r.excecoes[0].tipo, "ACIMA_DO_TETO"); assert.ok(r.excecoes[0].precoProposto > 0);
});
t("lote: preço RECOTADO é usado como está (sem arredondar) e marcado RECOTADO", async () => {
  const rec = { ok: true, meta: 0.15, recotadoEm: "2026-11-13T00:00:00Z", preco: 152.92, comissao: 29.05, comissaoPct: 0.19, frete: 19.05, freteNivel: "cotado_ml", freteConfianca: "alta", margem: 0.1502, lucro: 22.97, margemConfiavel: true };
  const r = await propostasEmLote([item({ recotacao: rec })], { estrategia: "SAIR_CAMPANHA", meta: 15, tetoAumento: 30, terminarEm90: true });
  assert.strictEqual(r.prontos[0].tipo, "RECOTADO"); assert.strictEqual(r.prontos[0].precoProposto, 152.92); assert.strictEqual(r.prontos[0].margemProposta, 15.02);
});
t("lote: ajustar promocional não vale para promoção em que o ML define o preço; estratégia inválida é recusada", async () => {
  const r = await propostasEmLote([item({ itemId: "MLB9" })], { estrategia: "AJUSTAR_PROMOCIONAL", meta: 15, tetoAumento: 100 });
  assert.ok(r.prontos.length + r.excecoes.length === 1);
  assert.strictEqual((await propostasEmLote([item()], { estrategia: "X" })).ok, false);
});
t("financiamento: arredondamento dos percentuais do ML (0,1 p.p.) aceito como na Central de Margem; fora disso, não comprovado", () => {
  const caso = (price) => classificarFinanciamento({ iniciadas: [{ id: "P-1", type: "SMART", status: "started", price, original_price: 186.3, meli_percentage: 4, seller_percentage: 30.1, name: "x", camposBoost: [] }], vigente: price, cheio: 186.3 });
  const ok1 = caso(122.92); assert.strictEqual(ok1.financiamento, "ML_COFINANCIA"); assert.strictEqual(ok1.subsidio, 7.45); // MLB4454087500 real: Δ 0,15 ≤ 0,197
  const ko = caso(123.2); assert.strictEqual(ko.financiamento, "NAO_DETERMINADO"); assert.strictEqual(ko.pendencia, "INCONSISTENCIA_PRECO_PROMO");
});
t("serviço não importa nada que fale com o ML nem com o banco", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "services", "resgate", "resgateSimulacaoPreliminar.js"), "utf8");
  assert.ok(!/fetch|criarFetch|lerAnuncioAoVivo|pool|\.query\(|config\/database/.test(src));
});
(async () => { for (const p of pend) await p(); console.log(`\n${ok} verificações da simulação preliminar e do lote`); })();
