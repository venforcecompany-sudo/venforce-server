// server/services/resgate/resgatePedidos.js
//
// Aba "Pedidos" da bancada do Resgate: os pedidos REAIS de um MLB e a
// comparação margem projetada × realizada. Puro (sem I/O).
//
// REGRA DE OURO: nenhuma fórmula financeira nova. Os valores de cada pedido
// (comissão, frete, custo, imposto, resultado, confiança) vêm PRONTOS da
// Central de Vendas (buildPedidoContrato / read service). Aqui só se
// seleciona, se rotula e se compara. A única divisão feita é a mesma que a
// Central usa para a margem de contribuição: resultado ÷ faturamento.
//
// "Comprovado" (resultado realizado que pode entrar na comparação):
//   · resultadoStatus === "real" (confiança "confiavel" na Central);
//   · pedido entra no resultado (não cancelado) e tem faturamento > 0;
//   · um único item (resultado de pedido multi-item mistura produtos);
//   · sem pendência "ajuste_plataforma_presente" (resíduo de desconto/
//     compensação do ML que a Central NÃO persiste como componente:
//     a soma dos componentes deixa de reproduzir o resultado);
//   · sem pós-venda (devolução/mediação) aberto.
// Fora disso o pedido é listado, mas o motivo aparece e ele NÃO entra na média.

const VERSAO = "resgate-pedidos/1";
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const r4 = (v) => Math.round((v + Number.EPSILON) * 10000) / 10000;

const ROTULO_COMPONENTE = {
  receita_produto: "Receita do produto", tarifa_venda: "Comissão cobrada", frete_seller: "Frete cobrado do vendedor",
  custo_produto: "Custo do produto", imposto_interno: "Imposto", receita_envio: "Receita de envio (conciliação)",
  cancelamento_reembolso: "Cancelamento / reembolso (conciliação)",
};
const PENDENCIA_AJUSTE = "ajuste_plataforma_presente";

function motivoNaoComprovado(p) {
  if (p.entraNoResultado === false) return `Pedido ${p.status || "fora do resultado"}: não entra no resultado.`;
  if (num(p.valor) === null || !(p.valor > 0)) return "Faturamento do pedido ausente.";
  if (p.multiItem) return `Pedido com ${p.qtdItens} itens: o resultado mistura produtos e não é atribuível só a este anúncio.`;
  if (p.posVendaTipo) return `Pós-venda em aberto (${p.posVendaTipo}): resultado ainda pode mudar.`;
  if ((p.pendencias || []).includes(PENDENCIA_AJUSTE)) return "Há ajuste da plataforma (desconto/compensação do ML) que a Central não detalha: o resultado não é reproduzível por componentes.";
  if (p.resultadoStatus !== "real") return p.resultadoStatus === "parcial" ? "Resultado parcial na Central de Vendas (faltam dados de custo, frete ou comissão)." : "Resultado bloqueado na Central de Vendas.";
  if (num(p.resultado) === null) return "Resultado do pedido ausente.";
  return null;
}

/** Uma linha de pedido (da Read API da Central, sem itens) para a aba. */
function linhaDoPedido(p) {
  const motivo = motivoNaoComprovado(p);
  const comprovado = motivo === null;
  const valor = num(p.valor), un = num(p.unidades);
  const ausentes = [];
  if (p.freteStatus === "ausente") ausentes.push("frete");
  if (p.taxasStatus === "ausente") ausentes.push("comissão");
  if (p.custoStatus === "ausente") ausentes.push("custo");
  return {
    rowId: p.rowId ?? null, pedidoId: p.pedidoId ?? p.id ?? null, data: p.data || null, status: p.status || null,
    unidades: un, valor, precoUnitario: !p.multiItem && valor !== null && un > 0 ? r2(valor / un) : null,
    multiItem: !!p.multiItem, qtdItens: p.qtdItens ?? null,
    comissao: num(p.taxas), frete: num(p.frete), custo: num(p.custo), imposto: num(p.imposto),
    receitaEnvio: num(p.receitaEnvio), reembolso: num(p.reembolso),
    resultado: num(p.resultado), resultadoStatus: p.resultadoStatus || null,
    margemRealizadaPercent: comprovado ? r2((p.resultado / valor) * 100) : null,
    comprovado, motivoNaoComprovado: motivo, dadosAusentes: ausentes,
    logistica: p.logistica || null, temAjusteDaPlataforma: (p.pendencias || []).includes(PENDENCIA_AJUSTE),
  };
}

/** Projetado por unidade, vindo da bancada (cascata) — nada recalculado. */
function projetadoDaBancada(bancada) {
  if (!bancada) return null;
  const c = Object.fromEntries((bancada.cascata || []).map((l) => [l.chave, l]));
  const comprador = num(bancada.precos && bancada.precos.comprador);
  const r = bancada.resultado || {};
  const v = (k) => (c[k] && c[k].status === "ok" ? num(c[k].valor) : null);
  return {
    precoComprador: comprador, lucroUnidade: r.calculavel ? num(r.lucro) : null, margemPercent: r.calculavel ? num(r.margemPercent) : null,
    limiteInferior: !!r.limiteInferior, comissao: v("comissao"), frete: v("frete"), custo: v("custo"), imposto: v("imposto"),
    freteConfianca: c.frete ? c.frete.confianca || null : null, status: bancada.status || null,
  };
}

/**
 * Comparação projetada × realizada. Só pedidos COMPROVADOS entram na média.
 * Cada diferença só existe quando os dois lados existem.
 */
function compararProjetadoRealizado(linhas, projetado) {
  const comp = linhas.filter((l) => l.comprovado);
  const faltantes = [];
  const naoComp = linhas.length - comp.length;
  if (!linhas.length) faltantes.push("Nenhum pedido deste anúncio no período consultado.");
  if (naoComp) faltantes.push(`${naoComp} de ${linhas.length} pedido(s) sem resultado comprovado na Central de Vendas (motivo em cada linha).`);
  if (!projetado) { faltantes.push("Margem projetada indisponível (anúncio sem bancada)."); }
  else {
    if (projetado.margemPercent === null) faltantes.push("Margem projetada não calculável hoje (veja as pendências da aba Margem).");
    if (projetado.limiteInferior) faltantes.push("Margem projetada é um limite inferior (compensação do ML não comprovada).");
    if (projetado.freteConfianca === "baixa") faltantes.push("Frete projetado é uma estimativa (confiança baixa).");
  }
  const soma = (f) => comp.reduce((s, l) => s + (f(l) || 0), 0);
  const fat = soma((l) => l.valor), un = soma((l) => l.unidades), res = soma((l) => l.resultado);
  const todos = (k) => comp.length > 0 && comp.every((l) => l[k] !== null);
  const realizado = comp.length && fat > 0 ? {
    pedidos: comp.length, unidades: un, faturamento: r2(fat), resultado: r2(res), margemPercent: r2((res / fat) * 100),
    precoMedio: un > 0 ? r2(fat / un) : null,
    comissaoPercent: todos("comissao") ? r2((soma((l) => l.comissao) / fat) * 100) : null,
    comissaoUnidade: todos("comissao") && un > 0 ? r2(soma((l) => l.comissao) / un) : null,
    freteUnidade: todos("frete") && un > 0 ? r2(soma((l) => l.frete) / un) : null,
    custoUnidade: todos("custo") && un > 0 ? r2(soma((l) => l.custo) / un) : null,
    impostoUnidade: todos("imposto") && un > 0 ? r2(soma((l) => l.imposto) / un) : null,
  } : null;
  if (comp.length && !realizado) faltantes.push("Faturamento comprovado zerado.");
  const diferencas = [];
  if (realizado && projetado) {
    const par = (rotulo, proj, real, unid) => { if (proj !== null && real !== null && proj !== undefined && real !== undefined) diferencas.push({ rotulo, projetado: proj, realizado: real, diferenca: r2(real - proj), unidade: unid }); else faltantes.push(`${rotulo}: ${proj === null || proj === undefined ? "sem valor projetado" : "sem valor realizado em todos os pedidos comprovados"}.`); };
    par("Margem", projetado.margemPercent, realizado.margemPercent, "pp");
    par("Preço por unidade", projetado.precoComprador, realizado.precoMedio, "R$");
    par("Comissão por unidade", projetado.comissao, realizado.comissaoUnidade, "R$");
    par("Frete por unidade", projetado.frete, realizado.freteUnidade, "R$");
    par("Custo por unidade", projetado.custo, realizado.custoUnidade, "R$");
    par("Imposto por unidade", projetado.imposto, realizado.impostoUnidade, "R$");
  }
  const dm = diferencas.find((d) => d.rotulo === "Margem");
  const dp = diferencas.find((d) => d.rotulo === "Preço por unidade");
  const nota = dp && Math.abs(dp.diferenca) / (dp.projetado || 1) > 0.01 ? "O preço médio vendido difere do preço atual: parte da diferença de margem é efeito do preço, não de custo, comissão ou frete." : null;
  return {
    realizado, projetado, diferencas, faltantes, nota,
    conclusao: !realizado ? "Sem resultado realizado comprovado para comparar." : !dm ? "Há resultado realizado, mas a margem projetada não está disponível." : dm.diferenca >= -0.5 ? "Realizado em linha com o projetado (ou melhor)." : "Realizado abaixo do projetado.",
  };
}

/** Resposta da lista: pedidos do MLB (filtro estrito por MLB) + comparação. */
function montarPedidosDoItem({ itemId, rows, bancada, periodo = null, completude = null, snapshot = null, totalNoPeriodo = null }) {
  const doItem = (rows || []).filter((p) => String(p.mlb || "").toUpperCase() === String(itemId).toUpperCase());
  const linhas = doItem.map(linhaDoPedido);
  const projetado = projetadoDaBancada(bancada);
  const aviso = [];
  if (totalNoPeriodo !== null && totalNoPeriodo > (rows || []).length) aviso.push(`A Central devolveu ${(rows || []).length} de ${totalNoPeriodo} pedidos: mostrando só os mais recentes.`);
  aviso.push("A busca da Central considera o primeiro item de cada pedido: pedidos em que este anúncio é o 2º item ou posterior não aparecem.");
  return { versao: VERSAO, itemId, periodo, snapshot, completude, pedidos: linhas, comparacao: compararProjetadoRealizado(linhas, projetado), avisos: aviso };
}

/** Detalhe financeiro de UM pedido (objeto completo de getCentralVendasReadOrderDetail). */
function montarDetalhePedido({ pedido, itemId, bancada }) {
  const base = linhaDoPedido(pedido);
  const itens = (pedido.itens || []).map((i) => ({ itemId: i.itemId, mlb: i.mlb, sku: i.sku, titulo: i.titulo, quantidade: num(i.quantidade), valorUnitario: num(i.valorUnitario), receitaProduto: num(i.receitaProduto), custoProduto: num(i.custoProduto), impostoInterno: num(i.impostoInterno), resultado: num(i.resultado), confianca: i.confianca || null, pendencias: i.pendencias || [], doAnuncio: String(i.mlb || "").toUpperCase() === String(itemId).toUpperCase() }));
  const componentes = (pedido.componentes || []).map((c) => ({
    tipo: c.tipo, rotulo: ROTULO_COMPONENTE[c.tipo] || c.tipo, valor: num(c.valor), fonte: c.fonte || null, confianca: c.confianca || null, obs: c.obs || null,
    escopo: c.escopo || null, efeito: c.efeito || null, incluidoNoResultado: c.incluidoNoResultado === null || c.incluidoNoResultado === undefined ? null : !!c.incluidoNoResultado, itemId: c.itemId || null,
  }));
  // Conferência (sem fórmula nova): os componentes marcados como incluídos no resultado
  // devem somar ao resultado do pedido; senão o detalhe mostra a diferença, não a esconde.
  const inc = componentes.filter((c) => c.incluidoNoResultado === true && c.valor !== null);
  const conferencia = inc.length && base.resultado !== null ? (() => {
    const s = r2(inc.reduce((t, c) => t + (c.efeito === "debito" ? -Math.abs(c.valor) : c.valor), 0));
    const dif = r2(base.resultado - s);
    return { somaComponentes: s, resultadoPedido: base.resultado, diferenca: dif, confere: Math.abs(dif) <= 0.05 };
  })() : null;
  const informativos = componentes.filter((c) => c.incluidoNoResultado === false);
  const dadosFaltantes = [...base.dadosAusentes.map((d) => `${d} ausente neste pedido`)];
  if (base.temAjusteDaPlataforma) dadosFaltantes.push("ajuste da plataforma (desconto/compensação do ML) sem componente detalhado");
  if (conferencia && !conferencia.confere) dadosFaltantes.push(`componentes não reproduzem o resultado (diferença de R$ ${conferencia.diferenca})`);
  return {
    versao: VERSAO, itemId, pedido: base, itens, componentes, informativos, conferencia, dadosFaltantes,
    compensacoes: {
      receitaEnvio: base.receitaEnvio, reembolso: base.reembolso,
      observacao: "Receita de envio e reembolso são dados de conciliação: não entram no resultado do pedido e não são somados de novo aqui.",
      descontosEBonusDoMl: base.temAjusteDaPlataforma ? "Existem, mas a Central de Vendas não os detalha por componente." : "Nenhum ajuste da plataforma sinalizado pela Central.",
    },
    posVenda: pedido.posVendaTipo ? { tipo: pedido.posVendaTipo, motivo: pedido.posVendaMotivo || null } : null,
    projetado: projetadoDaBancada(bancada),
  };
}

module.exports = { VERSAO, linhaDoPedido, projetadoDaBancada, compararProjetadoRealizado, montarPedidosDoItem, montarDetalhePedido, motivoNaoComprovado, ROTULO_COMPONENTE };
