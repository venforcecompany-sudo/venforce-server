# 13 — Evolução da Central de Vendas: capacidades, lacunas, arquitetura e plano

Pedido de 26/11/2026. O objetivo é fazer da Central de Vendas a ferramenta de
análise financeira das vendas realizadas, começando pelo Mercado Livre. O
plano reaproveita o que o Financeiro, o Sentinel e a própria Central já sabem
fazer, sem duplicar regra, chamada de API ou persistência.

Nada aqui foi publicado ou ativado: não houve push, deploy, migration em
produção, flag nem sincronização real. O contrato financeiro está no
[doc 14](14_CONTRATO_FINANCEIRO.md).

## 1. Mapa de capacidades reaproveitáveis

| capacidade | onde está | o que entrega | como a Central usa |
|---|---|---|---|
| Ads por conta e competência | `financeiroAdsService.obterAdsDoFechamento` + `financeiro_ads_cache` | investimento, GMV atribuído, ROAS e nº de campanhas de **uma conta** num mês; cache definitivo depois de M+1 dia 3 e de 6 h com o mês aberto | fonte mensal do contrato de Ads (`centralVendasCustosOperacionais.fonteAdsDoCacheFinanceiro`) |
| Ads em janela qualquer | `mlAdsService.buscarPerformanceML(slug, mes, janela, conta, {strictIdentity})` | os mesmos totais numa janela `{from,to}` e **por anúncio (MLB)**: custo, receita direta e indireta, cliques, impressões | período parcial e rentabilidade por produto; precisa de cache próprio por janela (ver §4) |
| Ads do cliente | `centralVendasAdsSyncService` → `ads_resumos_mensais` | **soma das contas** do cliente, em janelas parciais | **não serve** para a visão por conta (o contrato recusa: `escopo_cliente_nao_e_da_conta`) |
| Full (billing) | `financeiroFullService.obterFullDoFechamento` + `financeiro_full_cache` | armazenagem (CFWA), prolongado (CFBA), coleta (CFCBI/CFCBE), retirada (CFRS) por conta e mês; paginação instável tratada (passadas até fechar o `total`); `definitivo` só com as duas faturas fechadas | composição Full do contrato; frete Full (CFFE/CFFI) excluído por construção |
| Central de Gestão Full | `services/full/*` | estoque, giro e cobertura por inventory; custo pela mesma base | referência para a aba de custos operacionais (estoque parado × armazenagem); fora do escopo desta fase |
| Evidência promocional | `sentinelEvidenciaFinanceira.extrairEvidencia` (pura) | por item: preço cheio (`gross_price`), preço efetivo, desconto, parte do vendedor e do ML, estado e confiança; identidade exata em centavos | `centralVendasComposicaoPromocional` (sem cópia) |
| Conciliação de comissão | `sentinelConciliacaoComissao.conciliarComissaoPedido` (pura) | tarifa do pedido × Billing (gross/net/rebate/discount) × cobranças CVV*; vínculo de pedido, item, pagamento e conta; estados `TARIFA_LIQUIDA_COMPROVADA` / `BRUTA` / `DIVERGENTE` / `NAO_CONCILIADO` | idem; base do "rebate já incorporado" e do crédito comprovado |
| Coletor de Billing e Discounts | `sentinelConciliacaoColetor` | lotes de até 60 pedidos, orçamento por execução e por conta, pausa global em 429, retomável | **padrão** para um coletor da Central (não reutilizável como está: lê `sentinel_pedidos` e grava `sentinel_conciliacao_*`) |
| Rateio de frete por pack | `centralVendasEnvioCompartilhado` (da própria Central; o Sentinel o usa) | rateio por receita em centavos, com soma exata | já no motor |
| Resolução de custo por variação | `sentinelCusto.resolverCustoItem` / `meliFinanceiroService.buildMeliCostIndex` | custo por `model_id`/SKU antes do MLB; conflito de custo registrado | **lacuna L1** (a Central resolve só por MLB) |
| Identidade da base de custos | `sentinelRecalculoBase.assinaturaBase` | `{n, hash}` do conteúdo da base | gravar no `resumo_json` do import (lacuna L5) |
| Fechamento (Visão) | `financeiroVisaoService` | composição do fechamento publicado (entrega) por conta e competência | comparação Central × Financeiro no mesmo escopo (validação) |
| Mercado Pago | `centralVendasMp*` | payments, settlement, `resultadoConciliadoMp` | já integrado; continua como conciliação, separado do resultado de venda |
| Persistência v2 | componentes compactos + reuso de pedidos (docs 10–12) | −77% nos componentes e −33% nas tabelas da Central, sobre o reuso | armazenamento dos componentes novos (§3.3) |

## 2. Diagnóstico: lacunas financeiras da Central

| # | lacuna | efeito hoje | prova | tratamento |
|---|---|---|---|---|
| L1 | **Custo resolvido só por MLB**: `buscarCustosPorBaseId` não tem `ORDER BY` e o `buildCostMap` guarda o primeiro custo de cada MLB | anúncio com variações de custos diferentes recebe o custo de uma variação qualquer (ordem física); Financeiro e Sentinel resolvem por `model_id`/SKU e acusam conflito | código: `centralVendasSyncService.js` (`buscarCustosPorBaseId`, `buildCostMap`) × `meliFinanceiroService.buildMeliCostIndex` | **muda fórmula ⇒ pendente de prova.** Antes: comparador sobre bases e pedidos reais (somente leitura) que lista os pedidos cujo custo muda. Depois: trocar pelo índice do Financeiro atrás de flag, com o import comparado ao anterior |
| L2 | Preço cheio, desconto e quem bancou não aparecem | a receita já é líquida do desconto (`unit_price`), mas a tela não mostra o tamanho da promoção nem o subsídio do ML | evidência S1-A (17/11): `gross_price` em 100% dos itens MLB; `discounts[]` ausente em `/orders/search` (0 de 284 itens) | contrato pronto (`centralVendasComposicaoPromocional`). Só `/orders`: preço cheio **observado**, desconto **inferido**, quem bancou **desconhecido**. Com `/discounts`: **observado**. Com Billing: **comprovado** |
| L3 | Comissão sem conciliação | o motor usa `sale_fee × q`. A amostra provou que é a tarifa **líquida** do rebate (6/6 pedidos, 1 conta), mas fora dessa amostra nada foi verificado | `sentinelConciliacaoComissao` (cabeçalho) | estado por pedido: líquida comprovada ⇒ crédito 0; bruta comprovada ⇒ crédito = gross − net; resto ⇒ não comprovado. **Resultado oficial inalterado** |
| L4 | Cupom não modelado | o efeito no repasse do vendedor é desconhecido | `VALIDACOES_PENDENTES.cupom_do_vendedor_nao_modelado` | exposto como sinal (total e parte do vendedor) e bloqueia a conciliação daquele pedido |
| L5 | Base de custos sem identidade no import | não se sabe com qual versão da base o import foi calculado; alteração na base não é detectada | o Sentinel resolve por conteúdo (`assinaturaBase`) | gravar `{baseId, n, hash}` no `resumo_json` e, na leitura, avisar "base mudou desde o cálculo" (sem recálculo automático) |
| L6 | Ads e Full fora da Central | só resultado de venda; não existe resultado operacional | — | contrato pronto (`centralVendasCustosOperacionais`): por conta e período, compatibilidade temporal explícita |
| L7 | Ajuste de plataforma (planilha) sem componente | a soma dos componentes difere do resultado pelo valor do ajuste; o pedido já carrega a pendência | `centralVendasComponenteLedger` (comentário M6) | a cascata expõe o resíduo pedido a pedido (`identidade.residuos`) |
| L8 | Devolução, mediação e logística reversa | o pós-venda marca o pedido, mas o custo da reversa não entra | — | lacuna declarada no catálogo; precisa de fonte (claims/returns e shipment da devolução) |
| L9 | Full: estornos não abatidos | o serviço soma só `CHARGE`; um estorno de armazenagem deixaria o custo superestimado | `financeiroFullService.somarDoMes` | declarado em `limitacoes`; abater estorno só com lançamento real observado |
| L10 | Ads por produto | — | `buscarPerformanceML` já traz o custo por anúncio | só na janela compatível; a receita indireta pode ser de outros produtos (atribuição do ML), declarada |

**Gargalos de desempenho (entrega 1, resolvidos nesta rodada):**
- `buildPedidos` era P×C: 16,3 s → 53 ms em 3.000 pedidos e 34 mil componentes, resultado idêntico (`deepEqual`);
- a leitura de período não carrega mais `imports.payload_json`, que era lido de todos os imports candidatos de cada competência.

Continuam abertos:
- leituras filtradas por tipo +30–64% com arrays (doc 12 §4), cerca de +10 ms em 500 pedidos por mês;
- C360 sem `ORDER BY` nos itens.

## 3. Arquitetura proposta

### 3.1 Motor

```
Orders API ──► motor (buildMotorFromOrders) ──► componentes do resultado (inalterados)
     │                                     └──► componentes INFORMATIVOS (flag, formato 2)
     ├─ /orders/{id}/discounts (orçamento) ┐
     └─ Billing order/details (lotes ≤60) ─┴──► composição promocional por pedido (pura)
Financeiro (caches por conta×mês) ──► custos operacionais (Ads, Full)  [nunca por pedido]
                                          └──► resultado operacional (só se compatível)
```

- **Resultado de venda**: a fórmula do motor fica intocada. Mudança de fórmula (ex.: L1) só com flag, comparação com o cálculo anterior e aprovação.
- **Informativos**: preço cheio, desconto do vendedor e do ML, comissão bruta, rebate, crédito comprovado. Ficam fora do resultado, como `receita_envio` hoje.
- **Conciliação**: estado por pedido (`CONCILIADO` / `PARCIAL` / `DIVERGENTE` / `NAO_VERIFICADO`), com as pontas preservadas.
- **Operacional**: Ads e Full por conta × período. O resultado operacional é `null` quando falta fonte compatível.

### 3.2 Coleta

- **Discounts e Billing** em coletor próprio da Central, no padrão do coletor do Sentinel:
  - lote de 60 no Billing;
  - orçamento por conta e por execução;
  - pausa global em 429;
  - retomável e idempotente.

  Fora do caminho de publicação: o import é publicado com o que tem, e a composição fica `PARCIAL`/`NAO_VERIFICADO` até a coleta chegar. A Central não depende do Sentinel monitorar a conta. Quando o Sentinel já conciliou o mesmo pedido, a Central pode **ler** o resultado em vez de chamar a API de novo (otimização, não dependência).
- **Ads e Full**: leitura dos caches do Financeiro. Para período parcial de Ads, um cache por janela (mesmo padrão do `financeiro_ads_cache`), só quando a tela pedir.
- **Incremental**: o reuso de pedidos já evita regravar pedido inalterado. O próximo passo é buscar pedidos por `order.date_last_updated` para capturar alterações tardias (reembolso, frete atrasado) sem varrer o mês inteiro. Fica pendente, porque depende de validar o filtro na API com conta real.

### 3.3 Armazenamento

| dado | onde | custo medido | por quê |
|---|---|---|---|
| componentes do resultado | arrays tipados (v2) | 56 B/componente | doc 10 |
| composição promocional | **mesmos arrays**, componentes informativos | **~188 B/pedido** conciliado; ~36 B só com Orders | evidência JSON do Sentinel: 988 B; respostas cruas de Billing + Discounts: ~1,3 KB. Nenhuma resposta de endpoint é guardada |
| estado da conciliação | `obs` do componente (`natureza:…`, `incorporado:…`) via dicionário | 4 B/código | sem tabela nova |
| Ads e Full | caches do Financeiro (conta × mês) | 1 linha por conta e mês | nunca por pedido |
| identidade da base | `resumo_json` do import | ~60 B/import | L5 |

- **Formato 2** dos compactos: a regra de classificação congelada (`REGRA_FORMATO_1`) ganha os tipos informativos novos. O formato 1 continua sendo lido como está.
- Os pedidos sem os tipos novos continuam gravados em formato 1.
- Nada histórico é migrado nem apagado.

## 4. Funcionalidades úteis para a tela

Priorizadas por decisão que habilitam:

1. **Cascata do resultado**: receita a preço cheio → descontos (vendedor / ML) → receita → comissão → frete → CMV → imposto → MC → Ads → Full → resultado operacional. Cada degrau mostra fonte e estado.
2. **Resultado antes e depois de Ads e Full**, com o motivo quando não é calculável (período parcial, fonte ausente).
3. **Produtos que geram ou destroem resultado**: MC por MLB/SKU/variação e, com Ads por anúncio na mesma janela, MC após Ads.
4. **Curva ABC por faturamento e por lucro**, lado a lado: o produto A em faturamento e C em lucro é o alerta.
5. **Pedidos com prejuízo** e **pedidos com divergência** (Orders × Discounts × Billing) como filas de trabalho.
6. **Central de pendências financeiras**: custo ausente, conflito de custo por variação (L1), frete ausente, pós-venda não verificado, conciliação pendente, base alterada desde o cálculo.
7. **Promoções**: desconto total, quanto o vendedor bancou e quanto o ML bancou, por produto e por campanha.
8. **Filtro por qualidade do dado** (comprovado / observado / inferido / desconhecido) em toda tabela.
9. **Comparação entre períodos** (mesmo intervalo do mês anterior), série diária de faturamento, MC e resultado.
10. **Exportações**: pedidos com a composição auditável (CSV) e o resumo da cascata.

O protótipo navegável está publicado à parte da tela real (§6).

## 5. Plano de implementação (entregas independentes)

| # | entrega | commits | critério de aceite | estado |
|---|---|---|---|---|
| E1 | desempenho: `buildPedidos` indexado; período sem `imports.payload_json` | `1d07b561`, `11f651e2` | resultado `deepEqual` ao caminho antigo; suíte da Central e testes Postgres de 5 modos (392 verificações) verdes | **feito** |
| E2 | contrato da composição + cascata | `2b63d8e5` | identidade com o resultado do motor; resíduo exposto | **feito** (puro) |
| E3 | contrato de Ads e Full | `1fd2fb9d` | 12 cenários: escopo, período parcial, zero × ausente, frete Full | **feito** (puro) |
| E4 | composição promocional e de comissão | `31190f33` | 14 cenários + invariante anti-dupla-contagem | **feito** (puro) |
| E5 | protótipo visual | artefato | navegável, dados sintéticos | **feito** |
| E6 | Read API: `/read/composicao` (cascata + custos operacionais por conta e período, lendo os caches do Financeiro) | — | sem chamada ao ML no GET; `null` + motivo quando incompatível | próximo |
| E7 | formato 2 dos compactos + componentes informativos no motor (flag `CENTRAL_VENDAS_COMPOSICAO_PROMOCIONAL`, desligada) | — | 5 modos verdes; com a flag desligada, bytes e leitores idênticos | próximo |
| E8 | coletor de Discounts e Billing da Central (flag, orçamento) | — | piloto em 1 conta; 0 chamadas no caminho de publicação | precisa de autorização para chamadas reais |
| E9 | L1, custo por variação: comparador somente leitura → decisão → flag | — | relatório de pedidos afetados e Δ MC antes da troca | precisa de decisão |
| E10 | identidade da base no import (L5) + aviso de base alterada | — | sem recálculo automático | próximo |
| E11 | tela: redesign aprovado sobre o protótipo | — | nenhuma função atual removida | após aprovação |

A correção de armazenamento (docs 10–12) continua publicável sozinha:
- E1 a E4 não mudam schema;
- E7 é a única entrega que toca a persistência, e vem atrás de flag.

## 6. Protótipo

Publicado como artefato privado à parte (https://claude.ai/artifact/KbwyPRrtCNut4XL6kpGSZ8), com dados **sintéticos**. A tela real não foi
alterada. A organização visual segue a tela de Anúncios: cabeçalho de
contexto, KPIs, abas e tabela paginada com drawer de detalhe.

## 7. Pendências explícitas (não comprovadas)

- O rebate incorporado à comissão foi provado só em 6 pedidos de uma conta, todos com item único e quantidade 1. Multi-item e quantidade maior que 1 ficam `NAO_CONCILIADO` até haver evidência.
- O efeito do cupom do vendedor no repasse ainda não foi validado.
- O `discount` do Billing nunca foi observado; ele bloqueia a conciliação.
- O significado de `funding_mode` é só indício.
- A atribuição de Ads por produto (receita indireta) é a do ML, não comprovada pela venda.
- Estornos de Full não foram observados.
- O filtro incremental por `date_last_updated` em `/orders/search` ainda não foi validado com conta real.
- Na troca da resolução de custo por variação (L1), cada pedido afetado vai mudar de margem; precisa da sua decisão.
