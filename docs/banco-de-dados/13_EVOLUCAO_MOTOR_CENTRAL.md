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

## 4. Interface: adaptações pontuais (decisão de 26/11)

**Sem redesign.** A tela atual fica como está; o protótipo visual foi
descartado. Entraram só duas adaptações, com os componentes e classes que a
tela já usa:

1. **Extrato do pedido** (drawer existente): detalhamento financeiro completo, vindo
   de `composicaoFinanceira` (§5, E6b). Mostra:
   - identificação, itens, SKUs e variações;
   - preço cheio × efetivo, desconto e quem financiou;
   - comissão do pedido × bruta × líquida, rebate, se já está na comissão e crédito comprovado;
   - como o resultado foi calculado, com a identidade conferida;
   - cancelamentos, reembolsos e ajustes;
   - origem dos valores e estado da conciliação;
   - divergências e pendências.
2. **Fechamento** ("Para onde vai o dinheiro"): bloco "Depois da margem: Ads e
   Full" com estado, motivo e métricas com denominador (§5, E6a).

## 5. Plano de implementação (entregas independentes)

| # | entrega | commits | critério de aceite | estado |
|---|---|---|---|---|
| E1 | desempenho: `buildPedidos` indexado; período sem `imports.payload_json` | `1d07b561`, `11f651e2` | `deepEqual` ao caminho antigo; 5 modos (392 verificações) verdes | **feito** |
| E2 | contrato da composição + cascata | `2b63d8e5` | identidade com o resultado do motor; resíduo exposto | **feito** |
| E3 | contrato de Ads e Full | `1fd2fb9d` | 12 cenários: escopo, período parcial, zero × ausente, frete Full | **feito** |
| E4 | composição promocional e de comissão | `31190f33` | 14 cenários + invariante anti-dupla-contagem | **feito** |
| E5 | protótipo visual | — | — | **descartado** (sem redesign) |
| E6a | Ads e Full no `/read/bootstrap` (caches do Financeiro) + bloco no fechamento | `1c136a2f`, `bd38e7a6` | sem chamada ao ML; período parcial ⇒ incompatível; PG real (8) + tela (8) | **feito** |
| E6b | detalhamento financeiro do pedido (`composicaoFinanceira`) + extrato | `c30fa39b`, `120c3d38` | identidade fecha; "não coletado" ≠ "sem desconto"; HTML sem a composição igual ao anterior; PG real + tela (18) | **feito** |
| E7 | formato 2 dos compactos + motor grava a composição (flag `CENTRAL_VENDAS_COMPOSICAO_PROMOCIONAL` + `_CONTAS`, desligada) | `e804d290`, `fd4dd27c` | flag desligada ⇒ motor `deepEqual`; ligada ⇒ resultado, totais e pendências idênticos; PG real linhas × compacto; 5 modos verdes | **feito** |
| E8 | coleta de Discounts e Billing no sync da Central | — | ver §5.1 | **desenhado**; precisa de autorização para chamadas reais |
| E9 | L1, custo por variação: comparador | `4473284d` | Δ de CMV por item antes de qualquer troca | comparador **feito**; troca = **decisão** |
| E10 | identidade da base no import (L5) + pendência "base alterada" no extrato | `38ec104d` (+ E6b) | por conteúdo; 14 ms em 20 mil linhas; sem recálculo | **feito** |

A correção de armazenamento (docs 10–12) continua publicável sozinha:
- E1–E4, E6 e E10 não mudam schema. E10 só acrescenta `baseCustos` ao `resumo_json`.
- E7 muda a migration ainda não aplicada (`CHECK formato IN (1, 2)`) e só grava algo novo com a flag ligada.

### 5.1 Coleta de Discounts e Billing (E8): desenho

Hoje o motor compõe só com o que a Orders API traz:
- preço cheio: **observado**;
- desconto: **inferido**;
- quem bancou e rebate: **desconhecidos**.

Para chegar a **comprovado**, o motor já aceita `evidenciasPorPedido` (Discounts e Billing por pedido). Falta a coleta:

1. **Onde**: etapa própria do sync, depois de Orders e antes do motor. Fica atrás de `CENTRAL_VENDAS_COMPOSICAO_COLETA`, com orçamento por conta e por execução e prazo. A publicação nunca espera: estourou o orçamento ou o prazo, o pedido sai como `NAO_VERIFICADO`.
2. **Quais pedidos**:
   - Billing em lotes de até 60 (`/billing/integration/group/ML/order/details?order_ids=`);
   - `/orders/{id}/discounts` só para pedidos com desconto (`gross_price > unit_price × q`) que tenham registro de Billing.

   Mesmas regras do coletor do Sentinel: 429 (inclusive embrulhado em 400) ⇒ parar; 404 de `/discounts` ⇒ marcador, nunca "sem desconto"; `errors[]` ⇒ isolar o pedido.
3. **Carry-over (obrigatório)**: a evidência comprovada de uma noite não pode ser perdida na seguinte. Antes de compor, o sync relê os componentes promocionais e o `composicaoPromocional` do pedido no import vigente da mesma conta. Se a tarifa e os preços do pedido não mudaram, reaproveita a evidência sem nova chamada. Sem isso, com o reuso de pedidos, um pedido já conciliado seria regravado com menos informação.
4. **Reaproveitar o Sentinel** quando ele já conciliou o mesmo pedido (`sentinel_conciliacao_*`): só leitura, como otimização, nunca como dependência.
5. **Validação antes de ligar**:
   - piloto em 1 conta, com o orçamento medido;
   - comparação dos estados com a conciliação do Sentinel nos pedidos em comum.

Fica para depois porque as chamadas reais e o comportamento de 429 precisam de autorização.

## 6. Pendências explícitas (não comprovadas)

- O rebate incorporado à comissão foi provado só em 6 pedidos de uma conta, todos com item único e quantidade 1. Multi-item e quantidade maior que 1 ficam `NAO_CONCILIADO` até haver evidência.
- O efeito do cupom do vendedor no repasse ainda não foi validado.
- O `discount` do Billing nunca foi observado; ele bloqueia a conciliação.
- O significado de `funding_mode` é só indício.
- A atribuição de Ads por produto (receita indireta) é a do ML, não comprovada pela venda.
- Estornos de Full não foram observados.
- O filtro incremental por `date_last_updated` em `/orders/search` ainda não foi validado com conta real.
- Na troca da resolução de custo por variação (L1), cada pedido afetado vai mudar de margem; precisa da sua decisão.
