# 04 — Squad 8 · Legado

> **`squad-8-legado` · "Squad 8 · Legado"** — o número 8 é **deliberado**.
> Não renomear para Squad 7. Squad 8 **não conta** entre os 6 Squads
> operacionais: o modelo é **6 operacionais + 1 legado especial**.

## O que Squad 8 é, e o que não é

Squad 8 existe para impedir que cliente antigo ou fora da relação fique **sem
Squad, órfão, descartado ou invisível no modelo de dados**. É **quarentena
operacional**, não lixeira.

**Nesta missão, Squad 8 não recebe nenhuma pessoa:** sem Coordenador, sem
Gestor, sem Auxiliar, sem Designer, sem membro comum. Atribuir responsabilidade
sobre esses clientes seria inventar decisão de negócio. Admin continua com
bypass, e como `SQUADS_ENFORCEMENT` está **OFF**, Squad 8 **não muda acesso
nenhum em produção hoje**.

> ⚠️ **Antes de ligar o enforcement é preciso decidir o que acontece com este
> bucket.** Com enforcement ON e Squad 8 sem membros, estes 26 clientes
> ficam acessíveis **apenas para admin**. Para clientes de teste isso é o
> desejado; para um cliente real de operação, não. Ver `16`.

---

## Os 26 clientes em quarentena

| id | slug | nome | papel | contas | grants | por que está aqui |
|---|---|---|---|---|---|---|
| 14 | `maximus_feramentas` | Maximus Feramentas | canônico | 0 | 0 | não aparece na relação dos Squads 1–6 |
| 17 | `deluche` | Deluche | canônico | 1 | 1 | não aparece na relação dos Squads 1–6 |
| 19 | `vent_solues` | Vent soluções | canônico | 1 | 1 | não aparece na relação dos Squads 1–6 |
| 25 | `maria_eduarda` | Maria Eduarda | canônico | 0 | 0 | não aparece na relação dos Squads 1–6 |
| 28 | `pro_fit` | Pro Fit | canônico | 1 | 1 | não aparece na relação dos Squads 1–6 |
| 34 | `j_meira` | J Meira | canônico | 0 | 0 | não aparece na relação dos Squads 1–6 |
| 50 | `pedro_baby` | Pedro Baby | canônico | 0 | 0 | não aparece na relação dos Squads 1–6 |
| 51 | `envm` | ENVM | canônico | 0 | 0 | não aparece na relação dos Squads 1–6 |
| 53 | `macedo_materiais_construo` | Macedo Materiais Construção | canônico | 0 | 0 | não aparece na relação dos Squads 1–6 |
| 54 | `mm_importes` | MM Importes | canônico | 1 | 1 | não aparece na relação dos Squads 1–6 |
| 57 | `mais_estilo` | Mais Estilo | canônico | 1 | 1 | não aparece na relação dos Squads 1–6 |
| 58 | `luli` | Luli | canônico | 0 | 1 | não aparece na relação dos Squads 1–6 |
| 59 | `trevo` | Trevo | canônico | 1 | 1 | não aparece na relação dos Squads 1–6 |
| 63 | `j_meira_2` | J Meira 2 | alias → #34 | 0 | 0 | herda o Squad do canônico, que também está aqui |
| 64 | `j_meira_3` | J Meira 3 | alias → #34 | 0 | 0 | herda o Squad do canônico, que também está aqui |
| 75 | `jfx` | JFX | canônico | 1 | 1 | não aparece na relação dos Squads 1–6 |
| 82 | `luli_1` | Luli_1 | alias → #58 | 0 | 1 | herda o Squad do canônico, que também está aqui |
| 90 | `shalom_industria` | Shalom_industria | canônico | 0 | 0 | não aparece na relação dos Squads 1–6 |
| 94 | `demo-shopee` | Cliente Demo Shopee | canônico | 0 | 0 | não aparece na relação dos Squads 1–6 |
| 105 | `elizamarket` | Eliza.Market | canônico | 0 | 1 | não aparece na relação dos Squads 1–6 |
| 106 | `teste_x01` | Teste_x01 | canônico | 0 | 0 | não aparece na relação dos Squads 1–6 |
| 107 | `mm_comercio` | MM Comercio | canônico | 1 | 1 | não aparece na relação dos Squads 1–6 |
| 109 | `teste_01` | Teste 01 | alias → #126 | 0 | 0 | herda o Squad do canônico, que também está aqui |
| 122 | `canastra` | cafe | canônico | 1 | 1 | não aparece na relação dos Squads 1–6 |
| 126 | `teste1` | teste1 | canônico | 2 | 1 | não aparece na relação dos Squads 1–6 |
| 127 | `teste2` | teste2 | alias → #126 | 1 | 1 | herda o Squad do canônico, que também está aqui |

---

## Leitura do conteúdo

O perfil deste bucket é exatamente o esperado de um cadastro com anos de uso:

- **clientes de teste/demonstração** — `teste1`, `teste2`, `Teste 01`,
  `Teste_x01`, `Cliente Demo Shopee`, `seller-teste`. São artefatos de QA e o
  lugar deles é a quarentena.
- **os dois lados de uma ambiguidade** — `MM Importes` (#54) e `MM Comercio`
  (#107). A relação diz `MM` uma vez; enquanto não se souber qual, **os dois**
  ficam aqui. É a aplicação direta do default seguro.
- **`JFX` (#75)** — tem conta e grant próprios e não aparece na relação. Pode
  ser uma conta da `JF` (Squad 1) cadastrada como entidade separada. Confirmar
  é decisão humana; enquanto isso, quarentena.
- **`Eliza.Market` (#105)** — envolvida no grant cruzado com `Fenix`. Ver `05`.
- **clientes reais antigos sem menção na relação** — `Deluche`, `Pro Fit`,
  `Trevo`, `Mais Estilo`, `Vent soluções` e outros. Todos têm conta e grant
  ativos; simplesmente não constam da operação atual dos 6 Squads.

