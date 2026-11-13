// Aba Pedidos do Resgate: seleção/rotulagem/comparação sobre dados que a Central de
// Vendas já calculou. Nenhuma fórmula financeira nova; nada inventado quando falta dado.
const assert = require("assert");
const { linhaDoPedido, projetadoDaBancada, compararProjetadoRealizado, montarPedidosDoItem, montarDetalhePedido } = require("../services/resgate/resgatePedidos");

let ok = 0;
function t(nome, fn) { try { fn(); ok++; console.log(`  ✓ ${nome}`); } catch (e) { console.error(`  ✗ ${nome}\n    ${e.stack}`); process.exitCode = 1; } }

const ped = (o = {}) => ({ rowId: 1, pedidoId: "P1", data: "2026-11-01", status: "pago", entraNoResultado: true, multiItem: false, qtdItens: 1, mlb: "MLB1", unidades: 2, valor: 200, taxas: 38, taxasStatus: "real", frete: 30, freteStatus: "real", custo: 90, custoStatus: "real", imposto: 26, receitaEnvio: null, reembolso: null, resultado: 16, resultadoStatus: "real", confianca: "confiavel", pendencias: [], ...o });
const bancada = { status: "ABAIXO_DA_META", precos: { comprador: 100 }, resultado: { calculavel: true, lucro: 8, margemPercent: 8, limiteInferior: false },
  cascata: [{ chave: "comissao", status: "ok", valor: 19, confianca: "alta" }, { chave: "frete", status: "ok", valor: 15, confianca: "alta" }, { chave: "custo", status: "ok", valor: 45 }, { chave: "imposto", status: "ok", valor: 13 }] };

t("linha comprovada: margem = resultado ÷ faturamento (a mesma da Central), preço unitário do pedido", () => {
  const l = linhaDoPedido(ped());
  assert.strictEqual(l.comprovado, true); assert.strictEqual(l.margemRealizadaPercent, 8); assert.strictEqual(l.precoUnitario, 100);
});
t("não comprovado: multi-item, cancelado, parcial, bloqueado, pós-venda e ajuste da plataforma — com o motivo", () => {
  const casos = [[{ multiItem: true, qtdItens: 3 }, /3 itens/], [{ entraNoResultado: false, status: "cancelado" }, /não entra no resultado/], [{ resultadoStatus: "parcial" }, /parcial/], [{ resultadoStatus: "bloqueado" }, /bloqueado/],
    [{ posVendaTipo: "mediacao" }, /Pós-venda/], [{ pendencias: ["ajuste_plataforma_presente"] }, /ajuste da plataforma/], [{ valor: null }, /Faturamento/]];
  for (const [o, re] of casos) { const l = linhaDoPedido(ped(o)); assert.strictEqual(l.comprovado, false, JSON.stringify(o)); assert.ok(re.test(l.motivoNaoComprovado), l.motivoNaoComprovado); assert.strictEqual(l.margemRealizadaPercent, null, "nunca inventa margem"); }
});
t("dados ausentes viram lista, nunca zero", () => {
  const l = linhaDoPedido(ped({ frete: null, freteStatus: "ausente" }));
  assert.deepStrictEqual(l.dadosAusentes, ["frete"]); assert.strictEqual(l.frete, null);
});
t("projetado vem da bancada (cascata), sem recalcular; não calculável → null", () => {
  const p = projetadoDaBancada(bancada); assert.strictEqual(p.margemPercent, 8); assert.strictEqual(p.frete, 15);
  assert.strictEqual(projetadoDaBancada({ ...bancada, resultado: { calculavel: false } }).margemPercent, null);
  assert.strictEqual(projetadoDaBancada(null), null);
});
t("comparação: só comprovados entram; diferenças por unidade; frete/comissão/custo reais × projetados", () => {
  const linhas = [linhaDoPedido(ped()), linhaDoPedido(ped({ rowId: 2, resultadoStatus: "bloqueado" }))];
  const c = compararProjetadoRealizado(linhas, projetadoDaBancada(bancada));
  assert.strictEqual(c.realizado.pedidos, 1); assert.strictEqual(c.realizado.margemPercent, 8);
  const d = Object.fromEntries(c.diferencas.map((x) => [x.rotulo, x]));
  assert.strictEqual(d["Margem"].diferenca, 0); assert.strictEqual(d["Frete por unidade"].realizado, 15); assert.strictEqual(d["Comissão por unidade"].realizado, 19);
  assert.ok(c.faltantes.some((f) => /1 de 2 pedido/.test(f)));
  assert.strictEqual(c.conclusao, "Realizado em linha com o projetado (ou melhor).");
});
t("realizado abaixo do projetado e nota de preço diferente", () => {
  const linhas = [linhaDoPedido(ped({ valor: 180, resultado: 0, unidades: 2 }))];
  const c = compararProjetadoRealizado(linhas, projetadoDaBancada(bancada));
  assert.strictEqual(c.conclusao, "Realizado abaixo do projetado."); assert.ok(/preço médio vendido difere/.test(c.nota));
});
t("sem pedidos / sem comprovados / sem bancada: informa a pendência e não compara", () => {
  let c = compararProjetadoRealizado([], projetadoDaBancada(bancada));
  assert.strictEqual(c.realizado, null); assert.deepStrictEqual(c.diferencas, []); assert.ok(c.faltantes.some((f) => /Nenhum pedido/.test(f)));
  c = compararProjetadoRealizado([linhaDoPedido(ped({ resultadoStatus: "parcial" }))], projetadoDaBancada(bancada));
  assert.strictEqual(c.realizado, null); assert.ok(/Sem resultado realizado comprovado/.test(c.conclusao));
  c = compararProjetadoRealizado([linhaDoPedido(ped())], null);
  assert.ok(c.realizado && c.diferencas.length === 0 && /Margem projetada indisponível/.test(c.faltantes.join("|")) && /não está disponível/.test(c.conclusao));
});
t("frete projetado estimado e limite inferior aparecem como dado faltante", () => {
  const b = { ...bancada, resultado: { ...bancada.resultado, limiteInferior: true }, cascata: bancada.cascata.map((l) => (l.chave === "frete" ? { ...l, confianca: "baixa" } : l)) };
  const c = compararProjetadoRealizado([linhaDoPedido(ped())], projetadoDaBancada(b));
  assert.ok(c.faltantes.some((f) => /limite inferior/.test(f)) && c.faltantes.some((f) => /estimativa/.test(f)));
});
t("lista: filtro ESTRITO por MLB (a busca da Central também casa título/status) e avisos honestos", () => {
  const r = montarPedidosDoItem({ itemId: "MLB1", rows: [ped(), ped({ rowId: 2, mlb: "MLB2" })], bancada, totalNoPeriodo: 300 });
  assert.strictEqual(r.pedidos.length, 1); assert.strictEqual(r.pedidos[0].rowId, 1);
  assert.ok(r.avisos.some((a) => /1 de 300|devolveu 2 de 300/.test(a))); assert.ok(r.avisos.some((a) => /primeiro item/.test(a)));
});
t("detalhe: componentes com origem, informativos fora do resultado, conferência da soma e compensações sem somar em dobro", () => {
  const pedido = ped({ receitaEnvio: 12, reembolso: null, itens: [{ itemId: "I1", mlb: "MLB1", quantidade: 2, valorUnitario: 100, receitaProduto: 200, custoProduto: 90, impostoInterno: 26, resultado: 16 }],
    componentes: [
      { tipo: "receita_produto", valor: 200, efeito: "credito", incluidoNoResultado: true, fonte: "api", confianca: "confiavel" },
      { tipo: "tarifa_venda", valor: 38, efeito: "debito", incluidoNoResultado: true }, { tipo: "frete_seller", valor: 30, efeito: "debito", incluidoNoResultado: true },
      { tipo: "custo_produto", valor: 90, efeito: "debito", incluidoNoResultado: true }, { tipo: "imposto_interno", valor: 26, efeito: "debito", incluidoNoResultado: true },
      { tipo: "receita_envio", valor: 12, efeito: "credito", incluidoNoResultado: false }] });
  const d = montarDetalhePedido({ pedido, itemId: "MLB1", bancada });
  assert.strictEqual(d.conferencia.confere, true); assert.strictEqual(d.conferencia.somaComponentes, 16);
  assert.strictEqual(d.informativos.length, 1); assert.strictEqual(d.compensacoes.receitaEnvio, 12);
  assert.ok(/não entram no resultado/.test(d.compensacoes.observacao)); assert.strictEqual(d.itens[0].doAnuncio, true);
  assert.strictEqual(d.componentes.find((c) => c.tipo === "tarifa_venda").rotulo, "Comissão cobrada");
});
t("detalhe: componentes que não reproduzem o resultado aparecem como dado faltante (não escondidos)", () => {
  const pedido = ped({ pendencias: ["ajuste_plataforma_presente"], resultado: 40, itens: [], componentes: [{ tipo: "receita_produto", valor: 200, efeito: "credito", incluidoNoResultado: true }, { tipo: "tarifa_venda", valor: 38, efeito: "debito", incluidoNoResultado: true }] });
  const d = montarDetalhePedido({ pedido, itemId: "MLB1", bancada });
  assert.strictEqual(d.conferencia.confere, false);
  assert.ok(d.dadosFaltantes.some((f) => /ajuste da plataforma/.test(f)) && d.dadosFaltantes.some((f) => /não reproduzem/.test(f)));
  assert.ok(/não os detalha/.test(d.compensacoes.descontosEBonusDoMl));
});
console.log(`\n${ok} verificações dos pedidos do Resgate`);
