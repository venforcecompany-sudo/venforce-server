# Promoções do MLB6414829980 — Alianza Jeans

Consulta em 13/11/2026, cliente `alianza_jeans`, conta 86 (Mercado Livre 1).
Somente SELECT no banco e GET no ML; sem alteração de participação ou preço.

## Resposta real

`GET /seller-promotions/items/MLB6414829980?app_version=v2`

| Campanha | ID | Status | price | original_price | meli_percentage | seller_percentage |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Queima estoque | P-MLB18211012 | started | 99,00 | 139,99 | 4,5 | 24,7 |
| Novembro Feminino | P-MLB18211016 | candidate | 99,00 | 139,99 | 4,5 | 24,7 |
| Moda Nov26 | P-MLB18197010 | candidate | 99,00 | 139,99 | 4,2 | 25,0 |
| Impulsione suas vendas | P-MLB17937078 | candidate | 96,99 | 139,99 | 0,6 | 30,1 |
| OFERTAS RELÂMPAGOS IMPERDÍVEIS | P-MLB18055120 | candidate | 96,02 | 139,99 | 2,2 | 29,3 |

`GET /items/MLB6414829980/sale_price?context=channel_marketplace` retornou
`amount=99`, `regular_amount=139.99`, `metadata.campaign_id=P-MLB18211012`
e `metadata.promotion_id=OFFER-MLB6414829980-14376018364`.
A campanha ativa está identificada diretamente pela oferta.

Os GETs dos detalhes das campanhas confirmaram os mesmos nomes. Os GETs
`/seller-promotions/promotions/{id}/items?promotion_type=SMART&item_id=MLB6414829980&app_version=v2`
confirmaram preços e percentuais de Queima estoque, Novembro Feminino,
Moda Nov26 e Impulsione suas vendas.

Nenhum desses payloads do item trouxe `boosted_offer`,
`discount_meli_boost_amount` ou `total_price_for_boosted_offer`.
Não há evidência de boost neste item nas respostas consultadas.

## Correção confirmada

O normalizador ignorava `price` positivo em candidatas e reconstruía o preço
com percentuais arredondados. Para Novembro Feminino e Moda Nov26, produzia
R$ 99,11 em vez dos R$ 99,00 oficiais; para Impulsione suas vendas, R$ 97,01
em vez de R$ 96,99. Agora usa o preço retornado antes desse cálculo. Para
campanhas com sugestão de preço, mantém a prioridade da sugestão existente.
O snapshot registra a origem desse preço como `ml`.

Campos numéricos null ou vazios também deixam de virar zero. Em particular,
`suggested_discounted_price: null` não pode substituir um preço válido por zero.

## Diferenças ainda sem confirmação

O painel ML no print usa textos comerciais como “Com redução de tarifas”,
“Nova proposta!” e “Aumente sua competitividade”. A API consultada retorna os
nomes de campanha acima; não fornece esses textos nem uma associação deles
às propostas do print. Não substituir nomes por associação de posição ou preço.

O subsídio atual é derivado de `original_price * meli_percentage / 100`.
Queima estoque e Novembro Feminino produzem R$ 6,30; Moda Nov26, R$ 5,88;
Impulsione suas vendas, R$ 0,84. O ML no print mostra R$ 6,36 na ativa e
propostas com outros preços/reduções (por exemplo R$ 79,99 e R$ 4,80).
Esses valores exatos não estão nas respostas consultadas. A precisão limitada
dos percentuais pode explicar diferenças pequenas, mas não comprova a causa.

No código local, a resposta atual de Queima estoque produz `ATIVA` e
`subsidioMl=6.30`; não reproduz o “—” do print. Não foi possível atribuir esse
“—” a uma versão publicada ou a um payload anterior. A correção de preços
não deve ser apresentada como solução completa das diferenças de subsídio.

Testes de regressão usam os dados reais acima, com rede e banco simulados.
