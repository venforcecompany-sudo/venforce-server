// server/services/centralVendas/centralVendasComponenteLedger.js
//
// M6 — Ledger financeiro auditável da Central de Vendas V3.
//
// central_vendas_componentes já era, desde antes do M1, a evidência
// item-a-item do resultado (tipo/valor/fonte/confianca/obs). Este módulo NÃO
// cria um segundo motor de cálculo — classifica cada componente já produzido
// por buildMotorFromOrders (API-first, centralVendasSyncService.js) ou por
// processMeliForCentralVendas (planilha, meliFinanceiroService.js) em três
// eixos explícitos, nunca inferidos só pelo sinal do valor:
//
//   escopo                 "item" | "pedido"
//   efeito                 "credito" | "debito"
//   incluidoNoResultado    true | false | null (tipo desconhecido)
//
// escopo é um FATO já persistido (item_id presente ou não), nunca uma
// suposição — deriva de itemId, não de tipo. Auditoria do M6: os dois
// motores até divergem aqui para `cancelamento_reembolso` (pedido na API,
// item na planilha) — escopo captura isso corretamente por construção,
// sem precisar de um caso especial por origem.
//
// efeito é a natureza CONCEITUAL do tipo (aumenta ou reduz o resultado),
// fixa e igual nas duas origens.
//
// incluidoNoResultado — auditoria empírica do M6 (rodada real com
// processMeliForCentralVendas, não só leitura de código): nos dois motores,
// receita_produto/tarifa_venda/custo_produto/imposto_interno/frete_seller
// somam EXATAMENTE ao resultado_item quando o item é calculável. Isso vale
// inclusive para o motor de planilha, apesar do comentário original do
// código sugerir o contrário ("o resultado usa o total liquido") — esse
// comentário descreve resiliência a COLUNA AUSENTE (tarifa/frete não
// aparecem na planilha), não exclusão da fórmula.
//
// GAP REAL ENCONTRADO E DOCUMENTADO (não corrigido neste marco): quando o
// motor de planilha detecta `ajuste_plataforma_presente` (o total líquido
// reportado não bate com productRevenue+tarifa+tarifaEnvio+desconto — ou
// quando descontos_e_bonus é diferente de zero), existe um resíduo que
// NENHUM componente persistido captura, e a soma dos 5 componentes deixa
// de bater com resultado_item pelo valor exato desse ajuste. Esse pedido já
// fica marcado com a pendência `ajuste_plataforma_presente` (pré-existente,
// não criada pelo M6) — é o sinal de que a reconciliação não é garantida
// para aquele pedido específico. Ver docs/CENTRAL_VENDAS_V3_ARQUITETURA.md
// seção 14 para a prova reproduzida em teste
// (server/tests/centralVendasComponenteLedger.test.js). Persistir esse
// ajuste como seu próprio componente resolveria o gap, mas é uma decisão de
// schema/regra financeira fora do escopo deste marco — não foi feita aqui.
//
// receita_envio e cancelamento_reembolso continuam fora do Resultado Parcial
// nas duas origens (dado de conciliação, nunca somado de novo — mesma regra
// desde M5/antes).
//
// O achado do M5 sobre imposto_percentual > 1 vs <= 1 é preservado sem
// alteração — não é tocado por este módulo.

const EFEITO_POR_TIPO = {
  receita_produto: "credito",
  receita_envio: "credito",
  tarifa_venda: "debito",
  custo_produto: "debito",
  imposto_interno: "debito",
  frete_seller: "debito",
  cancelamento_reembolso: "debito",
};

// Entram no Resultado Parcial — igual nas duas origens (API-first e
// planilha; ver nota do gap de ajuste de plataforma acima).
const TIPOS_NO_RESULTADO = new Set([
  "receita_produto",
  "tarifa_venda",
  "custo_produto",
  "imposto_interno",
  "frete_seller",
]);
// Sempre fora do resultado (conciliação) — nas duas origens.
// Composição promocional (centralVendasComposicaoPromocional): preço cheio,
// descontos por financiador, comissão bruta, rebate e crédito comprovado.
// Explicam a venda; NUNCA entram no resultado (efeito null: não somam nem
// subtraem). Nos compactos, exigem o formato 2.
const TIPOS_PROMOCIONAIS = Object.freeze([
  "preco_cheio", "desconto_vendedor", "desconto_marketplace",
  "comissao_bruta", "rebate_marketplace", "credito_comissao_comprovado",
]);
const TIPOS_INFORMATIVOS = new Set(["receita_envio", "cancelamento_reembolso", ...TIPOS_PROMOCIONAIS]);

/**
 * Classifica um componente financeiro já produzido pelo motor (M5 ou
 * planilha) em escopo/efeito/incluidoNoResultado. Função pura, sem I/O —
 * usada tanto na escrita (centralVendasRepository.insertComponente) quanto
 * no backfill de linhas legadas (server/sql/central_vendas_schema.sql,
 * mesma regra replicada em SQL — nunca diverge desta).
 *
 * @param {{tipo: string, itemId?: string|null}} params
 */
function classificarComponenteFinanceiro({ tipo, itemId }) {
  const escopo = itemId ? "item" : "pedido";
  const efeito = Object.prototype.hasOwnProperty.call(EFEITO_POR_TIPO, tipo) ? EFEITO_POR_TIPO[tipo] : null;

  let incluidoNoResultado = null;
  if (TIPOS_NO_RESULTADO.has(tipo)) incluidoNoResultado = true;
  else if (TIPOS_INFORMATIVOS.has(tipo)) incluidoNoResultado = false;

  return { escopo, efeito, incluidoNoResultado };
}

module.exports = {
  classificarComponenteFinanceiro,
  EFEITO_POR_TIPO,
  TIPOS_NO_RESULTADO,
  TIPOS_INFORMATIVOS,
  TIPOS_PROMOCIONAIS,
};
