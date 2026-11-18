# Fechamento Shopee — colunas reconhecidas

Referência das colunas usadas pelos dois motores do fechamento financeiro da
Shopee. **Nenhuma coluna fora desta lista entra em cálculo.**

## Motor real — `real_financial`

Arquivo: `server/services/fechamentoFinanceiro/shopeeOrderAllService.js`
(`processShopeeFinancialOrders`).

Acionado quando a planilha de vendas é a planilha de pedidos (tem `ID do pedido`
+ `Status do pedido` + sinais financeiros). Antes essa planilha era **rejeitada**.

| Conceito | Colunas aceitas (normalizadas, sem acento/caixa) |
| --- | --- |
| ID do pedido | `id do pedido`, `pedido id`, `order id` |
| Status do pedido | `status do pedido`, `status pedido` |
| Motivo de cancelamento | `cancelar motivo`, `motivo cancelamento`, `motivo do cancelamento`, `cancel reason` |
| Status de devolução | `status da devolucao / reembolso`, `status de devolucao/reembolso` |
| Produto | `nome do produto`, `produto`, `product name` |
| Nome da variação | `nome da variacao`, `nome da variação`, `opcao da variacao`, `opção da variação`, `variation name`, `variation option` |
| Quantidade | `quantidade`, `qty` |
| Receita bruta do item | `subtotal do produto` → `faturamento` → `preco acordado` × quantidade |
| Repasse (líquido) | `repasse` |
| Total global | `total global` |
| Taxa de transação | `taxa de transacao` |
| Taxa de comissão | `taxa de comissao liquida` (preferida) → `taxa de comissao bruta` |
| Taxa de serviço | `taxa de servico liquida` (preferida) → `taxa de servico bruta` |
| Frete | `valor estimado do frete`, `frete`, `shipping` |
| Imposto | `imposto` |
| CMV | `cmv` |
| SKU | `sku`, `sku da variacao`, `sku principal`, `no de referencia do sku principal`, `numero de referencia sku` |
| IDs | `id do item`, `id do produto`, `id da variacao`, `id do modelo` |

### Líquido do pedido sem Repasse (Total global × taxas líquidas)

O `Order.all` real **não tem** coluna `Repasse`. Conferido em 886 pedidos de
out/2026:

- `Total global = Subtotal − Cupom do vendedor − Cupom − Ajuste por pagamento
  via PIX − Compensar Moedas Shopee/100 + Taxa de envio pagas pelo comprador`
  (653 de 710 pedidos reconhecidos fecham ao centavo).
- `Ajuste por participação em ação comercial = (comissão bruta − líquida) +
  (serviço bruto − líquido)` em 886/886: as taxas **líquidas** já embutem a
  compensação da Shopee por cupom/PIX.

Por isso o líquido reconstruído é `Total global − frete pago pelo comprador −
taxas líquidas − frete negativo`. Usar o Subtotal com taxas líquidas contava a
compensação sem a dedução (pedido de referência: 261,20 em vez de 231,06; a
Renda da Shopee foi 230,57 por uma taxa de 0,49 que não está no arquivo).

Evidência por pedido (`detailedRows["Evidência do líquido"]`,
`summary.netRevenueEvidence`, `summary.netRevenueConfidence`):

| Nível | Quando |
| --- | --- |
| `comprovado` | coluna `Repasse` presente — nada é reaplicado |
| `reconstruido` | sem Repasse, Total global fecha com a identidade (ou ausente) |
| `estimado` | Total global não fecha, ou `Total descontado Cartão de Crédito` / `Taxa de Envio Reversa` preenchidos — usa Subtotal − descontos e declara o motivo (`netRevenueEstimatedReasons`, nota `NET_REVENUE_ESTIMATED`) |
| `ausente` | sem Repasse e sem taxas — líquido = bruto |

Pedido `estimado` ou `ausente` rebaixa `financialConfidence` de `confiavel`
para `parcial`. Reconstruído nunca é tratado como valor liquidado: tarifas
fora das colunas (ex.: Devolução Fácil) e o frete real não estão no arquivo.

### Conciliação de custo — Model ID como identidade da variação

O `Order.all` real expõe `Nome do Produto`, `Nome da variação`, `Nº de
referência do SKU principal` e `Número de referência SKU`. A Performance expõe
os mesmos nomes, além de `ID do Item` e `ID da Variação`; este último corresponde
ao `model id` da base de custos.

A planilha de **performance** (`parentskudetail`) entra como ponte de identidade:

```
Order.all (produto + variação) → Performance (Model ID exato) → base (model id → custo/imposto)
```

SKU é apenas auxiliar. Alterar `5444` para `5444-V` não troca a identidade se
produto + variação continuam apontando para o mesmo Model ID.

`SKU da Variação` e `SKU Principle` possuem índices separados. Um valor que
aparece nos dois campos nunca faz as variações do SKU principal contaminarem
os candidatos do SKU da variação.

Ordem de resolução por linha (`resolveShopeeLineCost`):

1. **Match direto** — se `variationId`/`modelId` existir no `Order.all`, somente
   essa identidade é consultada; sua ausência na base não permite cair para SKU
   ou ponte, e só cai no item pai pelas regras do item 3. Sem Model ID direto,
   seguem `itemId → productId → skuVariation → skuPrinciple → skuMainRef →
   skuRefNumber → sku`.
2. **Ponte** (só em MISS, e só quando a performance foi enviada):
   - `Número de referência SKU` consulta primeiro e exclusivamente o índice
     `SKU da Variação`;
   - se o SKU da variação aparecer em vários anúncios, produto + nome da
     variação exatos precisam deixar uma única identidade;
   - produto + variação exatos preservam o caso de SKU renomeado;
   - `SKU Principle` é consultado por último, em índice separado, e somente
     resolve quando os campos disponíveis deixam uma identidade inequívoca.
   - se o SKU exato não existir, o fallback histórico aceita somente adição ou
     remoção dos sufixos `-V` e `-0`; os nomes de produto/variação continuam
     sendo usados quando houver mais de um candidato.
3. Encontrado um Model ID, o custo vem desse Model ID. Se ele não existir na
   base, o custo do ID do Item pai só é usado com **evidência** de que ele
   representa a variação vendida (`bridge_parent_item_single_model`), e todas
   estas condições são obrigatórias:
   - o anúncio tem **um único** Model ID na performance (a exportação lista
     inclusive as variações sem venda) e é o Model ID resolvido;
   - o pai está na base pelo ID do item (nunca por SKU), com custo válido e
     maior que zero;
   - todas as linhas da base com esse ID concordam em custo e imposto, e
     nenhuma delas é linha de variação (`model id` preenchido);
   - não há linhas **sem ID** logo abaixo do pai na planilha (custo por
     variação com o ID apagado, que o sistema não consegue endereçar);
   - a quantidade explícita da variação não contradiz o kit do título
     (`2 ...` num título sem kit, `Kit 2` num `Kit 4`).
   Sem a performance não há como provar a variação única, então o pai nunca é
   usado. Faltando qualquer evidência, a linha fica sem custo e a pendência sai
   como `cost_only_on_parent_item`, com `parentItemId`, `parentCost` e
   `blockedBy` (`multiple_variations_in_performance`,
   `unidentified_rows_below_parent`, `pack_conflict`, `conflicting_parent_rows`,
   `cost_base_has_variation_rows_for_item`, `parent_cost_invalid`,
   `model_not_in_performance`). A correção é cadastrar o custo por ID da
   Variação.
4. Se ainda restarem vários Model IDs, o cálculo só prossegue quando **todos**
   existirem na base e tiverem custo e imposto numericamente idênticos. A
   identidade permanece informativamente ambígua, mas o resultado financeiro é
   equivalente. Qualquer diferença de custo ou imposto mantém a linha sem custo.

`summary.detailedRows["Match de custo"]` registra qual caminho resolveu:
`direct_variation_id`, `direct_model_id`, `direct_item_id`, `direct_product_id`,
`direct_sku`, `bridge_variation_id`, `bridge_item_id`,
`bridge_equivalent_cost`, `bridge_parent_item_single_model`, `miss`, `ambiguous`.

Pendência com custo zero/vazio/inválido continua com o motivo
`zero_cost_in_base`, agora com `costIssue` (`zero`, `empty` ou `invalid`).
`summary.costBaseDiagnostics` lista o que a base perde no parse: linhas sem
identificador (e os itens logo acima delas) e IDs em notação científica
(`2.28812E+11`, dígitos perdidos pelo Excel — formatar a coluna como texto).

**A ponte é SÓ identidade.** Nenhum número da performance (vendas, unidades,
ticket, comissão estimada, taxa fixa) entra no motor real: receita, taxas,
frete, status, cancelamentos e devoluções continuam vindo integralmente do
`Order.all`. Por isso o `calculationMode` continua `real_financial`.

**Ambiguidade nunca é resolvida por arbitragem.** Se os campos da venda não
distinguirem uma única identidade e os candidatos não forem financeiramente
equivalentes, o custo fica `null`, a linha entra como "sem custo" e o fechamento
reporta `COST_BRIDGE_AMBIGUOUS`, incluindo os IDs candidatos.

SKU é **texto**: `0007654352998` nunca vira `7654352998`. Valores de
preenchimento da performance (`-`, `--`, `N/A`, `0`) não viram identidade.

Diagnóstico adicional no `summary` (aditivo, não substitui `revenueWithCost` /
`calculatedCoveragePercent`): `costBridgeAvailable`, `costBridgeSkuCount`,
`costBridgeIdentityCount`, `directCostMatchCount`, `bridgeCostMatchCount`, `bridgeMissCount`,
`bridgeEquivalentCostMatchCount`, `bridgeHistoricalSkuMatchCount`,
`bridgeAmbiguousCount`, `bridgeAmbiguousKeys`, `zeroCostRowsCount`,
`directCoverage`, `bridgeResolvedCoverage`, `finalCoverage`.

### Regras que evitam contagem dupla

1. **Comissão e serviço: líquida OU bruta, nunca as duas.** `resolveFeeComponent`
   usa a líquida quando a célula existe (mesmo valendo zero) e só cai para a
   bruta quando a líquida está ausente.
2. **Campos de nível pedido não são multiplicados por item.** Numa planilha com
   uma linha por produto, `repasse`, `total global` e as taxas se repetem em
   todas as linhas do mesmo pedido. `collapseOrderLevelValue` detecta isso: se
   todos os valores preenchidos do pedido são idênticos, o valor conta **uma
   vez**; se divergem, é um campo por linha e é somado.
3. **Repasse manda.** Quando `repasse` existe, ele já é líquido de taxas, frete,
   cupons e rebates. A receita líquida do pedido **é** o repasse, e os
   componentes ficam apenas informativos. Descontá-los de novo seria contar duas
   vezes.
4. **Sem repasse**, a receita líquida é `receita bruta − transação − comissão −
   serviço − frete(quando for custo do vendedor)`.

### Cupom / rebate / promoção / ajuste — deliberadamente NÃO aplicados

Não existe coluna de cupom/rebate no contrato conhecido da planilha, e não foi
possível confirmar sinal e significado num arquivo real. Portanto:

- `detectShopeeAdjustmentColumns` lista as colunas cujo nome contém `cupom`,
  `voucher`, `rebate`, `promocao`, `subsidio`, `desconto` ou `ajuste`;
- elas aparecem em `summary.detectedAdjustmentColumns` e na aba **Fechamento**
  do Excel;
- **não entram em nenhuma soma**, porque o repasse já as embute.

Para passar a aplicá-las é preciso primeiro confirmar, num arquivo real, o nome
exato e o sinal da coluna — e só então trocar a regra junto com um teste.

### Componentes marcados como ausentes

| Situação | Efeito |
| --- | --- |
| `valor estimado do frete` positivo (sinal ambíguo: não dá para afirmar se é custo do vendedor) | frete **não** aplicado; entra em `summary.missingColumns` e vira nota executiva |
| pedido sem `repasse` e sem nenhuma taxa | receita líquida = receita bruta; pedido sinalizado em nota executiva |
| produto sem `cmv` e sem custo na base | receita **preservada** no faturamento, LC `null`, fechamento `parcial` |

## Motor estimado — `estimated_performance`

Arquivo: `server/services/fechamentoFinanceiro/shopeePerformanceService.js`.

Planilha de performance por produto/variação. **Não tem repasse, frete nem taxas
reais**: a comissão e a taxa fixa são estimadas por faixa de ticket
(`getShopeeFeesByTicket`). O resultado é sempre marcado como estimativa e nunca
deve ser apresentado como fechamento financeiro definitivo.

Colunas: `id do item`, `id da variacao`, `produto`, `vendas (pedido pago) (brl)`,
`unidades (pedido pago)`, `impressao do produto`, `cliques por produto`, `ctr`.

Este motor só é escolhido quando **não há `Order.all` válido junto**. Se a
performance e o `Order.all` forem enviados na mesma requisição, o fechamento usa
o motor real (`real_financial`) com a performance apenas como ponte de
identidade — ver "Conciliação de custo" acima.

Quando o segundo arquivo existe mas **não** é um `Order.all` reconhecível, ele
continua servindo apenas à reconciliação de status (cancelados, não pagos,
devoluções) — contados **por pedido**.

## Qual motor roda (prioridade)

| Arquivos enviados | Motor | `calculationMode` |
| --- | --- | --- |
| performance + custos + `Order.all` | real, com ponte variação → Model ID | `real_financial` |
| `Order.all` + custos + performance (ordem invertida dos uploads) | idem — o papel é decidido pelo conteúdo | `real_financial` |
| `Order.all` + custos | real, só match direto | `real_financial` |
| performance + custos | estimado por faixa de ticket | `estimated_performance` |
| ponte insuficiente / chave ambígua | custo `null`, faturamento preservado | inalterado |
