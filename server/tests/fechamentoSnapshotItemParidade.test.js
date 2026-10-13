// server/tests/fechamentoSnapshotItemParidade.test.js
//
// itemDoSnapshot (servidor, CJS) × normalizarLinhaProduto (tela, ESM) sobre
// as MESMAS linhas dos 3 formatos do motor: o filtro "Sem custo" do
// histórico (backend) tem que ser exatamente o "Sem custo" da tela ao vivo.
// E a contagem de pendências do snapshot = número de grupos de
// agruparPendencias (o "N pendências" que o operador vê).

const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");
const { itemDoSnapshot, contarItens } = require("../services/fechamentoSnapshot/itemDoSnapshot");

let checks = 0;
function eq(label, a, b) {
  assert.deepStrictEqual(a, b, `${label}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  checks += 1;
}

const LINHAS = [
  // MELI
  { "# de anúncio": "MLB1", "Título do anúncio": "Tênis Ação", Unidades: 2, "Venda Total": 200, "Total (BRL)": 150, "Preço de custo": 50, "Preço de custo total": 100, Imposto: 10, LC: 30, MC: 15, "Cobertura de custo": "com custo" },
  { "# de anúncio": "MLB2", "Título do anúncio": "Boné", "Venda Total": 80, LC: null, MC: null, "Cobertura de custo": "sem custo" },
  { "# de anúncio": "MLB3", "Venda Total": 80, "Preço de custo": 20, LC: 5, MC: 6, "Cobertura de custo": "financeiro pendente" },
  { "# de anúncio": "MLB4", "Venda Total": 80, LC: null, MC: null, "Cobertura de custo": "financeiro pendente" },
  { "# de anúncio": "MLB5", "Venda Total": 80, LC: null, MC: null, "Cobertura de custo": "custo ambíguo" },
  { "# de anúncio": "MLB6", "Venda Total": 80, "Preço de custo": 20, LC: -5, MC: -6, "Cobertura de custo": "com custo" },
  { "# de anúncio": "MLB7", "Venda Total": 80, "Preço de custo": 20, LC: 5, MC: null, "Cobertura de custo": "com custo" },
  // Shopee Performance
  { ID: "229977", "ID Model": "1100", Produto: "Saia", "Unidades (Pedido pago)": 3, "Vendas (Pedido pago) (BRL)": 90, Custo: 10, Imposto: 8, LC: 4, "LC POR ANÚNCIO": 12, MC: 13 },
  { ID: "229978", "ID Model": "", Produto: "Saia 2", "Vendas (Pedido pago) (BRL)": 90, Custo: null, LC: null, MC: null },
  // Shopee Order.all
  { "ID do pedido": "250901ABC", Produto: "Blusa", SKU: "B-1", Quantidade: 1, "Receita bruta": 70, "Receita líquida": 55, CMV: 20, Imposto: 5, "Match de custo": "direct_sku", "ID resolvido pela ponte": "229977", LC: 30, MC: 42.86, "Cobertura de custo": "com custo", "Status do pedido": "Concluído" },
  { "ID do pedido": "250901ABD", Produto: "Blusa", SKU: "B-2", "Receita bruta": 70, CMV: null, "Match de custo": "ambiguous", LC: null, MC: null, "Cobertura de custo": "sem custo", "Status do pedido": "Cancelado" },
  { "ID do pedido": "250901ABE", Produto: "Blusa", SKU: "B-3", "Receita bruta": 70, CMV: null, "Match de custo": "miss", LC: null, MC: null, "Cobertura de custo": "sem custo", "Status do pedido": "Devolução aprovada" },
  { "ID do pedido": "250901ABF", Produto: "Blusa", SKU: "B-3", "Receita bruta": 30, CMV: null, "Match de custo": "miss", LC: null, MC: null, "Cobertura de custo": "sem custo", "Status do pedido": "Concluído" },
  // formato desconhecido / lixo
  { qualquer: 1, LC: 3, MC: 20 },
  {},
];

async function main() {
  const tela = await import(pathToFileURL(path.join(__dirname, "..", "..", "frontend-react", "src", "utils", "financeiro", "produtos.js")).href);
  const pend = await import(pathToFileURL(path.join(__dirname, "..", "..", "frontend-react", "src", "utils", "financeiro", "pendencias.js")).href);
  const ambiguousIds = ["MLB4"];

  const normalizadas = tela.normalizarLinhas(LINHAS, { ambiguousIds });
  const itens = LINHAS.map((l, i) => itemDoSnapshot(l, i + 1, { ambiguousIds }));

  normalizadas.forEach((n, i) => {
    const it = itens[i];
    const r = `linha ${i + 1} (${n.formato})`;
    eq(`${r} formato`, it.formato, n.formato);
    eq(`${r} statusCusto`, it.status_custo, n.statusCusto);
    eq(`${r} statusFinanceiro`, it.status_financeiro, n.statusFinanceiro);
    eq(`${r} statusPrincipal`, it.status_principal, n.statusPrincipal);
    eq(`${r} cancelado`, it.cancelado, n.canceladoOuDevolvido);
    eq(`${r} ids/título`, [it.titulo, it.item_id, it.model_id, it.sku, it.pedido_id], [n.titulo, n.itemId, n.modelId, n.sku, n.pedidoId]);
    eq(`${r} receita/lc/mc`, [it.receita, it.lc, it.mc], [n.receita, n.lc, n.mc]);
    eq(`${r} linha gravada exata`, it.linha, LINHAS[i]);
  });
  console.log(`  ok  ${LINHAS.length} linhas dos 3 formatos: status, ids e números idênticos aos da tela`);

  // Filtros da tela × filtro do backend (status_principal / cancelado).
  for (const f of tela.FILTROS_PRODUTO) {
    const daTela = normalizadas.map((l, i) => (f.aceita(l) ? i : null)).filter((x) => x !== null);
    const doBackend = itens
      .map((it, i) => (f.id === "todos" || (f.id === "cancelados" ? it.cancelado : it.status_principal === {
        saudaveis: "saudavel", atencao: "atencao", criticos: "critico", sem_custo: "sem_custo", custo_ambiguo: "custo_ambiguo", aguardando_financeiro: "aguardando_financeiro",
      }[f.id]) ? i : null))
      .filter((x) => x !== null);
    eq(`filtro "${f.id}"`, doBackend, daTela);
  }
  console.log(`  ok  ${tela.FILTROS_PRODUTO.length} filtros da tela = filtros do backend`);

  const c = contarItens(itens);
  eq("pendências = grupos de agruparPendencias", c.pendencias, pend.agruparPendencias(normalizadas).length);
  eq("linhas pendentes", c.linhasPendentes, normalizadas.filter((l) => l.statusCusto !== "ok").length);
  eq("total", c.total, LINHAS.length);
  console.log(`  ok  contagens: ${c.pendencias} pendências (${c.linhasPendentes} linhas) = tela`);

  // Busca: mesma normalização (sem acento, minúscula) da tela.
  const termo = "acao";
  const telaBusca = tela.filtrarLinhas(normalizadas, { busca: termo }).length;
  const backBusca = itens.filter((it) => it.busca.includes(termo)).length;
  eq("busca sem acento", backBusca, telaBusca);
  console.log("  ok  busca sem acento = tela");

  console.log(`\n${checks} verificações OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
