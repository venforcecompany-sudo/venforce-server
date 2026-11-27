#!/usr/bin/env node
// server/scripts/central-vendas-custo-variacao-comparar.js
//
// Lacuna L1 numa conta REAL, SOMENTE LEITURA e sem chamada ao ML: compara, item a
// item, o custo que a Central usou (só MLB, primeiro custo vence) com o que o
// Financeiro/Sentinel resolveriam (model_id > SKU > MLB, ambiguidade acusada),
// sobre a base de custos ATUAL da conta (resolvida pelo MESMO caminho do sync,
// resolveMarketplaceAccountContext) e os itens já gravados na Central.
//
//   node scripts/central-vendas-custo-variacao-comparar.js --conta=<id> [--dias=30] [--saida=arquivo.json]
//
// Roda no shell do serviço (DATABASE_URL de lá; nada do server/.env). Sessão
// READ ONLY. Não muda nenhuma regra: produz a evidência para a decisão.
//
// Limite conhecido: a variação (variation_id) do item só existe na Central para
// imports gravados com a composição promocional ligada; sem ela, o lado do
// Financeiro resolve por SKU ou MLB — a comparação por model_id fica subestimada
// e o relatório diz quantos itens tinham variação.

const { compararResolucaoCusto } = require("../services/centralVendas/centralVendasCustoVariacaoComparador");

// Itens gravados na Central → itens no formato de order_items (só o que a resolução usa).
function pedidosDosItens(linhas) {
  const porPedido = new Map();
  for (const l of linhas) {
    const k = String(l.pedido_id);
    if (!porPedido.has(k)) porPedido.set(k, { id: k, order_items: [] });
    porPedido.get(k).order_items.push({
      item: { id: l.mlb, variation_id: l.variacao_id ?? null, seller_sku: l.sku || null },
      quantity: Number(l.quantidade) || 0,
    });
  }
  return [...porPedido.values()];
}

async function main(argv) {
  const args = Object.fromEntries(argv.map((a) => /^--([a-z-]+)(?:=(.*))?$/.exec(a)).filter(Boolean).map((m) => [m[1], m[2] ?? true]));
  if (!/^\d{1,9}$/.test(String(args.conta || ""))) { console.error("uso: central-vendas-custo-variacao-comparar.js --conta=<id> [--dias=30] [--saida=arquivo.json]"); return 2; }
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL ausente (rode no shell do serviço; nunca com o server/.env local)."); return 2; }
  console.error(`banco: host=${(() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch (_) { return "?"; } })()}`);
  const pool = require("../config/database");
  const client = await pool.connect();
  try {
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    const contaId = Number(args.conta);
    const dias = Number(args.dias) || 30;
    const { rows: [c] } = await client.query("SELECT id, cliente_id, marketplace FROM cliente_contas WHERE id = $1", [contaId]);
    if (!c || c.marketplace !== "meli") { console.error("conta inexistente ou não é Mercado Livre"); return 2; }
    const { resolveMarketplaceAccountContext } = require("../services/clienteContas/clienteContaService");
    const ctx = await resolveMarketplaceAccountContext({ clienteId: c.cliente_id, marketplace: "meli", clienteContaId: contaId, queryable: client });
    const baseId = ctx?.base?.base_id || null;
    if (!baseId) { console.error("conta sem base de custos vinculada"); return 2; }
    // Mesma projeção e mesma ausência de ORDER BY da Central (buscarCustosPorBaseId) + as chaves de variação.
    const custos = (await client.query("SELECT produto_id, custo_produto, imposto_percentual, id_model, sku FROM custos WHERE base_id = $1", [baseId])).rows;
    const itens = (await client.query(
      `WITH ped AS (
         SELECT DISTINCT ON (p.pedido_id) p.pedido_id, p.id
           FROM central_vendas_pedidos p JOIN central_vendas_imports i ON i.id = p.import_id
          WHERE i.cliente_conta_id = $1 AND i.publication_status = 'published' AND p.data_pedido >= (CURRENT_DATE - $2::int)
            AND p.status NOT IN ('cancelled')
          ORDER BY p.pedido_id, i.published_at DESC NULLS LAST, i.id DESC)
       SELECT ped.pedido_id, it.mlb, it.sku, it.quantidade, it.payload_json->>'variacaoId' AS variacao_id
         FROM ped JOIN central_vendas_pedido_itens it ON it.pedido_row_id = ped.id
        ORDER BY ped.pedido_id, it.id`, [contaId, dias])).rows;
    const r = compararResolucaoCusto({ custosRows: custos, orders: pedidosDosItens(itens) });
    const rel = {
      conta: contaId, baseId: String(baseId), dias,
      base: { linhas: custos.length, comVariacao: custos.filter((x) => x.id_model || x.sku).length },
      itensComVariacaoNaCentral: itens.filter((x) => x.variacao_id).length,
      resumo: r.resumo,
      // só os afetados, para revisão manual (ids de pedido/anúncio e valores; nenhum dado de comprador)
      afetados: r.itens.filter((i) => i.situacao !== "igual" && i.situacao !== "ambos_sem_custo"),
    };
    const texto = JSON.stringify(rel, null, 2);
    if (args.saida && args.saida !== true) require("fs").writeFileSync(String(args.saida), texto);
    console.log(texto);
    return 0;
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err?.message || err); process.exit(1); });
}

module.exports = { pedidosDosItens, main };
