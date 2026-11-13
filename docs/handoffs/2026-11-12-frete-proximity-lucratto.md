# Frete regular e Envios Agora: revisão para o Lucratto 360

## Descoberta confirmada no VenForce

Em 12/11/2026, anúncios da Alianza Jeans, Mercado Livre 1 (conta 86),
devolviam R$ 7,75 em `GET /users/{seller}/shipping_options/free?item_id=...`.
O painel do vendedor mostrava dois custos diferentes no mesmo anúncio:
**Mercado Envios regular** e **Envios Agora**. No MLB3596426877, eram
R$ 19,05 e R$ 7,75, respectivamente.

Repetir a consulta com as tags do anúncio, excluindo `proximity`, selecionou
a modalidade regular. Não foi necessário cadastrar medidas, consultar vendas
antigas nem alterar qualquer configuração do anúncio no Mercado Livre.

Exemplo da diferença, no mesmo item e preço de R$ 128,80:

```text
GET /users/{seller}/shipping_options/free
    ?item_id=MLB3596426877
    &item_price=128.8
    &listing_type_id=gold_pro
    &mode=me2
    &logistic_type=cross_docking
    &verbose=true

Sem tags explícitas, ou incluindo proximity:
  list_cost = 7.75; discount.type = none; discount.rate = 0

Com tags=self_service_in,mandatory_free_shipping (sem proximity):
  list_cost = 19.05; discount.type = mandatory; discount.rate = 0.5
```

**Excluir a tag da consulta não significa desabilitar Envios Agora no anúncio.**
A mudança só seleciona qual modalidade está sendo cotada para a margem projetada.

## Resultados reais pelo serviço corrigido

Valores consultados no preço vigente em 12/11/2026; são cotações projetadas,
não cobranças realizadas e não constantes para reutilizar em outros preços.

| MLB | Preço consultado | Frete regular |
| --- | ---: | ---: |
| MLB3596426877 | R$ 128,80 | R$ 19,05 |
| MLB4445876846 | R$ 79,90 | R$ 14,45 |
| MLB4454087502 | R$ 136,80 | R$ 19,05 |
| MLB3596401769 | R$ 122,99 | R$ 19,05 |
| MLB3596414529 | R$ 102,88 | R$ 16,15 |
| MLB5619920790 | R$ 105,90 | R$ 16,85 |
| MLB5965203530 | R$ 89,90 | R$ 12,95 |

Todos foram resolvidos sem leitura de dimensões ou histórico de pedidos.
Para MLB3596426877, a mesma consulta regular retornou R$ 8,45 em R$ 78,99
e R$ 14,45 em R$ 79,00: precisa ser refeita no preço efetivo de cada cenário.

## O que verificar com o Claude no Lucratto

Na implementação inspecionada em `margate`,
`apps/api/src/ml/tarifas.ts::buscarFrete` usa `item_id` no Full e exige
dimensões para as outras logísticas. Sem dimensões, retorna frete faltante
antes de consultar o ML. Isso pode impedir a recuperação de anúncios como os
acima. As versões `main` e `naga-seo` inspecionadas tinham implementação
anterior; confirmar qual revisão está publicada antes de concluir sobre o app.

Verificar se a cotação identifica explicitamente Mercado Envios regular versus
Envios Agora, inclusive na sincronização, composição da margem e simulação de
preços/promoções. Avaliar a consulta regular por `item_id` com as tags corretas
antes de exigir medidas ou recorrer a histórico.

A extensão é outro fluxo: `apps/extensao/src/ml/ganhos.ts` consulta o tooltip
autenticado do painel (`/anuncios/api/listing/tooltip?type=earnings&documentId=...`).
O resultado da extensão não comprova que a API do 360 está usando a mesma fonte.

Referência da API: https://developers.mercadolivre.com.br/pt_br/api-docs-pt-br/custos-de-envio
(o parâmetro `tags` consta na documentação de custos de envio).

## Implementação no VenForce

`server/services/shared/freteCotacaoConfiavel.js::avaliarFrete` agora tenta a
modalidade regular após identificar a cotação suspeita de `proximity`. A leitura
mantém o token da conta selecionada, as demais tags, o preço vigente e a
logística, e exige resposta válida com desconto obrigatório. O resultado é
registrado como `cotado_ml`, com `modalidadeCotada = mercado_envios_regular`.

As alternativas por medidas atuais e histórico continuam para falhas dessa
consulta. As cotações já válidas seguem o caminho anterior. A liberação segue
`FRETE_COTACAO_CONFIAVEL_SELLERS`, uma flag específica do VenForce que não aparece
na implementação do Lucratto inspecionada.

Os testes cobrem os sete anúncios, faixas de preço, isolamento de conta,
falhas da consulta e persistência do frete/margem pelo worker na sincronização.

Não foi alterado código do Lucratto nem foram escritos dados de produção
durante esta investigação.
