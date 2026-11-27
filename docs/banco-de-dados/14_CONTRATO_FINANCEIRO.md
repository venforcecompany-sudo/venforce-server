# 14 — Contrato financeiro da Central de Vendas (v1; Ads/Full v2)

O código é a fonte da verdade: este documento resume o contrato e o código o
implementa. Os módulos são puros e têm testes.

| módulo | contrato | testes |
|---|---|---|
| `centralVendasComposicaoFinanceira.js` | catálogo de linhas + cascata do período | `centralVendasCustosOperacionais.test.js` (cascata/catálogo) |
| `centralVendasComposicaoPromocional.js` | preço cheio, descontos, comissão, rebate, crédito, divergências | `centralVendasComposicaoPromocional.test.js` (14) |
| `centralVendasCustosOperacionais.js` | Ads, Full, resultado operacional | `centralVendasCustosOperacionais.test.js` (12) |

Nenhum deles muda o resultado oficial nem grava dados.

## 1. Os quatro resultados

| resultado | fórmula | denominador da margem | quando é `null` |
|---|---|---|---|
| **Margem de contribuição** (`resultado_venda`) | receita de produto − comissão − frete do vendedor − CMV − imposto (fórmula atual do motor) | receita de produto dos pedidos no resultado | pedido bloqueado (sem produto ou sem custo); cancelado sai do resultado |
| **Resultado após Ads** | MC − investimento em Ads | idem | Ads indisponível ou de período incompatível |
| **Resultado operacional** | MC − Ads − Full | idem | Ads **ou** Full indisponível ou incompatível |
| **Conciliação** | — (não é resultado) | — | — |

Regras gerais:
- nunca somar conciliação ao resultado;
- nunca ratear Ads ou Full por pedido;
- nunca usar total mensal em período parcial;
- ausência é `null` com motivo, nunca zero.

## 2. Linhas da composição

Escopo: item (I), pedido (P), pack (K), produto (R), conta (C), período (T).
Sinal: + aumenta, − reduz, 0 não entra.

| linha | escopo | sinal | entra em | fonte | estado |
|---|---|---|---|---|---|
| Faturamento a preço cheio | I P R C T | 0 | informativo | `gross_price` (total das q unidades) | contrato pronto |
| Descontos (vendedor + ML) | I P R C T | 0 | informativo | `gross − unit×q`; parte do vendedor e do ML via `/orders/{id}/discounts` | contrato pronto |
| Subsídio do ML | I P | 0 | informativo | `/discounts` (total − seller) | contrato pronto |
| Cupons | P | 0 | informativo | `/discounts` type=coupon | **lacuna** (efeito no repasse não validado) |
| Receita de produtos | I P R C T | + | MC | `unit_price × q` | implementado |
| Receita de envio | P | 0 | conciliação | shipment receiver | informativo |
| Comissão (tarifa de venda) | I P R C T | − | MC | `sale_fee × q` | implementado |
| Comissão bruta | P | 0 | conciliação | Billing `sale_fee.gross` | contrato pronto |
| Rebate | P | 0 | conciliação | Billing `sale_fee.rebate`, cruzado com `/discounts` | contrato pronto |
| Crédito adicional comprovado | P | 0 | conciliação | Billing `gross − net`, só com a tarifa bruta comprovada | contrato pronto |
| Tarifa fixa | I | − | MC (dentro da comissão) | CVVFNU no Billing | implementado (não separado) |
| Frete do vendedor | I P K | − | MC | shipment senders, rateado por pack | implementado |
| CMV | I P R | − | MC | base de custos | implementado (L1: só por MLB) |
| Impostos | I P R | − | MC | alíquota da base × receita | implementado |
| Cancelamentos | P | 0 | — | status | implementado (sai do resultado) |
| Reembolsos | P | 0 | conciliação | payments refunded | informativo |
| Devoluções | P | 0 | conciliação | claims/returns | informativo (reversa não modelada) |
| Mediações | P | 0 | conciliação | claims | **lacuna** |
| Ajustes de plataforma | P | 0 | conciliação | planilha / Billing BONUS | **lacuna** (resíduo exposto na cascata) |
| Ads | C T R | − | operacional | Mercado Ads | externo |
| Full | C T | − | operacional | Billing CFWA/CFBA/CFCBI/CFCBE/CFRS | externo |

## 3. Promoções, rebate e comissão (prioridade de 26/11)

### 3.1 Valores e estados

Cada valor tem a forma `{ centavos, estado, fonte }`, com `estado` em:
- `comprovado`: duas fontes fecham;
- `observado`: lido de uma fonte, sem contradição;
- `calculado`: derivado de campos observados;
- `inferido`: deduzido sem a fonte própria;
- `desconhecido`;
- `contraditorio`.

| valor | Orders | + Discounts | + Billing |
|---|---|---|---|
| preço cheio | observado (`gross_price`) | observado | observado |
| preço efetivo | observado | observado | observado |
| desconto total | **inferido** (gross − unit) | observado | observado |
| quanto o vendedor bancou | desconhecido | observado | observado |
| quanto o ML bancou | desconhecido | observado | observado |
| comissão do pedido (a do motor) | observado | observado | observado |
| comissão bruta / líquida | desconhecido | desconhecido | **comprovado** quando concilia |
| rebate identificado | desconhecido | calculado (parte do ML com `funding_mode=sale_fee`) | observado → **comprovado** |
| rebate já incorporado | desconhecido | desconhecido | comprovado / não / não se aplica |
| crédito adicional comprovado | — | — | 0 ou `gross − net` |

### 3.2 Regra anti-dupla-contagem (invariante testado)

O motor desconta `sale_fee × q`. Então:

| o Billing prova que a tarifa do pedido é… | rebate | crédito adicional |
|---|---|---|
| a **líquida** (`= net`) | já está na comissão | **0** |
| a **bruta** (`= gross ≠ net`) | não está | **`gross − net`** (comprovado) |
| outra coisa (`DIVERGENTE`) | — | `null`; as pontas são expostas (ex.: pedido = net − rebate ⇒ `rebate_possivelmente_contado_duas_vezes`) |
| não concilia (escopo, ausência) | — | `null` |

Garantias adicionais:
- o `limiteSuperiorNaoComprovado` (`credito_max` da evidência) é hipótese e some quando há conciliação: ela o **substitui**, nunca se soma;
- o crédito comprovado aparece **ao lado** do resultado oficial, como proposta de ajuste. Entrar no oficial exige decisão explícita e comparação com o cálculo anterior;
- `efeitoNoResultadoOficial` é sempre `"nenhum"`.

### 3.3 Divergências

Cada divergência traz `{ codigo, entre, origem, detalhe }`, com `entre` em
`orders×billing`, `discounts×billing`, `orders×discounts`, `billing`,
`orders` ou `discounts`. Exemplos:

| código | entre | significado |
|---|---|---|
| `sale_fee_pedido_difere_do_net` | orders×billing | tarifa do pedido ≠ líquida do Billing (pontas no `detalhe`) |
| `rebate_possivelmente_contado_duas_vezes` | orders×billing | tarifa do pedido = net − rebate |
| `rebate_billing_difere_do_calculado` | discounts×billing | rebate do Billing ≠ parte do ML em `/discounts` |
| `cobrancas_nao_somam_net` | billing | CVV* ≠ net |
| `identidade_gross_net_violada` | billing | gross − net ≠ rebate + discount |
| `gross_nao_reconcilia` | orders×discounts | gross ≠ (unit + desconto) × q |

### 3.4 Escopo validado e pendências

Concilia só o que o S1-A provou: item único, quantidade 1, pago, sem cupom e
sem cashback, `funding_mode=sale_fee` e `discount` do Billing igual a 0.

Fora disso, o estado é `NAO_CONCILIADO` com o motivo; a composição por item
continua disponível.

As pendências seguem `VALIDACOES_PENDENTES` do Sentinel e são listadas no
doc 13 §7.

**Validação real de 27/11** (segunda conta, depois da S1-A; 10 pedidos, 22
chamadas, nenhum 429, nada gravado):
- nos 10 pedidos, `sale_fee` do pedido = tarifa gravada na Central = `net`
  do Billing. O rebate já vem descontado da comissão;
- 2 pedidos cofinanciados (comissão bruta R$ 17,50, líquida R$ 10,00,
  rebate R$ 7,50): 1 `CONCILIADO` com crédito 0
  (`rebate_ja_incorporado_na_comissao`); o outro tem os mesmos números, mas
  fica `PARCIAL` por cashback no Discounts (regra conservadora mantida);
- 3 pedidos `CONCILIADO` sem rebate (desconto bancado só pelo vendedor);
- 2 pedidos com cupom: o cupom está DENTRO da diferença preço cheio →
  preço pago (desconto do Discounts = cheio − efetivo ao centavo, todo do
  vendedor). A receita da Central (`unit_price × q`) já está líquida dele;
- nenhum caso de diferença financeira (crédito comprovado = 0). Sem pedido
  multi-item, quantidade > 1 ou Full na amostra: continuam `NAO_CONCILIADO`.

### 3.5 Armazenamento

Componentes informativos nos mesmos arrays compactos (formato 2, entrega E7):

| tipo | escopo | grava quando |
|---|---|---|
| `preco_cheio` | item | há desconto (sem desconto = receita) |
| `desconto_vendedor` | item | há desconto e a parte é conhecida |
| `desconto_marketplace` | item | idem |
| `comissao_bruta` | pedido | Billing lido (`obs` = `natureza:<…>`) |
| `rebate_marketplace` | pedido | rebate identificado (`obs` = `incorporado:<…>`) |
| `credito_comissao_comprovado` | pedido | conciliado |

`fonte` e `confianca` carregam a fonte e o estado, como códigos do dicionário.

Valor desconhecido não vira componente nem zero.

Custo medido no PG local:

| conteúdo | custo |
|---|---|
| pedido conciliado nos arrays compactos | ~188 B |
| pedido só com Orders nos arrays compactos | ~36 B |
| evidência JSON do Sentinel | 988 B |
| respostas cruas de Billing + Discounts (não guardadas) | ~1,3 KB |

## 4. Ads

Fontes aceitas são só as da **conta**:
- `financeiro_ads_cache` (conta × mês), só para mês inteiro consultado
  depois do fim do mês;
- ou uma **janela exata**: o Ads que o sync noturno consulta por conta na
  janela que sincronizou (`buscarPerformanceML`, a mesma função do
  Financeiro), gravado no run da conta
  (`central_vendas_sync_runs.metadata_json.adsDaJanela`, flag
  `CENTRAL_VENDAS_ADS_JANELA` + `_CONTAS`, desligada).

`ads_resumos_mensais` (soma do cliente) é recusado.

O período é partido por mês. Cada pedaço precisa de uma fonte que o cubra
exatamente: a janela com as mesmas datas, ou a fonte mensal quando o pedaço
é o mês inteiro. Com a flag, o período dos custos é o período pedido ∩ a
cobertura contínua dos imports da conta (até onde há vendas sincronizadas);
com buraco na cobertura não há recorte.

Situação de cada fonte: `consolidado` (consultada depois do fim do mês + 3
dias, a regra do Financeiro), `provisorio` (cobre a janela, o ML ainda pode
ajustar), `incompativel` (valor de outra janela, só referência),
`indisponivel`.

| situação | estado | entra no resultado? |
|---|---|---|
| API respondeu com custo > 0 | `observado` | sim, se compatível |
| API respondeu com custo 0 | `zero_observado` | sim (0 real) |
| sem token, sem permissão, sem anunciante, erro ou sem cache | `indisponivel` + código | não; resultado após Ads `null` |
| período parcial com fonte mensal | valor visível, `compativel:false` | não |

Métricas, cada uma com numerador e denominador nomeados:

| métrica | numerador | denominador | observação |
|---|---|---|---|
| ROAS | receita atribuída | investimento | `null` sem investimento |
| ACOS | investimento | receita atribuída | — |
| TACOS | investimento | receita de produtos da Central, mesma conta e período | `null` com período incompatível |

Por produto: custo por anúncio (MLB), receita direta e indireta, só na janela
compatível. A receita indireta pode vir de outros produtos.

## 5. Full

Entram, por conta e mês:

| grupo | subtipos |
|---|---|
| armazenagem | CFWA |
| armazenamento prolongado | CFBA |
| coleta | CFCBI / CFCBE |
| retirada ou descarte | CFRS |

**Nunca entram** CFFE/CFFI/BFFE/BFFI: é o frete de cada venda Full, já contado no `frete_seller`.

Estados:
- `consolidado`: as duas faturas fechadas;
- `observado_faturas_abertas`;
- `zero_observado`;
- `indisponivel`. Sem fonte é indisponível **mesmo sem venda Full**, porque a armazenagem é cobrada pelo estoque.

Limitações declaradas na resposta:
- estornos não são abatidos;
- a competência é a data do lançamento;
- sobras da fatura M+2 ficam fora;
- não há janela parcial: o Billing do Full só existe por mês no Financeiro.
  Cada lançamento tem data, então dá para recortar, mas exige coleta nova
  (mudança no serviço do Financeiro ou duplicá-lo). Mês aberto ⇒ Full fora.

### 5.1 Estado do resultado depois de Ads e Full

| estado | quando | o que a resposta traz |
|---|---|---|
| `consolidado` | Ads e Full cobrem o período e estão consolidados | `resultadoOperacional` |
| `provisorio` | Ads e Full cobrem exatamente o período; algum ainda pode mudar | `resultadoOperacional` |
| `parcial` | só um dos dois cobre (ex.: mês aberto: Ads da janela, Full sem fonte) | `resultadoParcial` = venda − o que tem fonte, com `incluidos` e `faltando`; `resultadoOperacional` = `null` |
| `indisponivel` | nenhum cobre | nada abatido |

O que falta nunca é tratado como zero. A tela mostra "Resultado após Ads
(Full não incluído)" com a etiqueta Parcial.

## 6. Cascata

`cascataDoPeriodo(pedidos)` soma as linhas do contrato de pedido.

Ela prova, pedido a pedido, que `valor − taxas − frete − custo − imposto =
resultado`. Qualquer resíduo (ex.: ajuste de plataforma da planilha) vai para
`identidade.residuos`, nunca é escondido.

Ela também conta:
- as linhas ausentes por pedido (`ausentes`);
- os cancelados;
- os bloqueados, com a receita que ficou fora do resultado.

## 7. Detalhamento do pedido (`composicaoFinanceira`)

`GET /read/orders/:rowId` devolve `composicaoFinanceira` ao lado de `pedido`.
O contrato do pedido não muda. O montador é
`centralVendasDetalheFinanceiro.detalharPedido`, puro, sobre o que já foi
gravado:

| bloco | conteúdo |
|---|---|
| `identificacao` | pedido, status, logística, multi-item |
| `itens[]` | MLB, SKU, variação, preço cheio × efetivo, desconto, parte do vendedor e do ML |
| `precos` | totais do pedido (soma com parte desconhecida = `null`) |
| `comissao` | do pedido (usada no resultado), bruta, líquida, natureza, rebate, incorporado, crédito comprovado (fora do oficial) |
| `composicao` | linhas receita − comissão − frete − CMV − imposto, fonte e estado de cada uma, resultado, margem e identidade (`fecha`, `residuo`) |
| `conciliacao` | receita de envio, reembolso, cancelamento, pós-venda, ajuste (resíduo) |
| `evidencias` | estado da conciliação (`CONCILIADO`, `PARCIAL`, `DIVERGENTE`, `NAO_VERIFICADO`, `NAO_COLETADO`), fontes, base de custos (`igual`, `alterada`, `base_trocada`, `sem_registro`) |
| `divergencias[]`, `pendencias[]` | códigos com origem (motor, composição, base) |

Regras:

- **`NAO_COLETADO`**: o import que gravou o pedido não tinha a composição ligada (sem `resumo_json.composicaoPromocional`). Nunca é lido como "sem desconto".
- **Com composição e sem `preco_cheio`**: o pedido não teve desconto. O preço cheio é igual à receita (`inferido`).
- **Base de custos**: `resumo_json.baseCustos` (assinatura por conteúdo) é comparado com a base atual da conta. A diferença vira pendência; nada é recalculado.
- **Custo**: duas leituras por chave mais a assinatura da base, cerca de 14 ms numa base de 20 mil linhas. Falha de metadado não derruba o detalhe.
