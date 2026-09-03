# 09 — Identidades dos 23 membros

> **Sem fuzzy automático.** O casamento roda em duas camadas e a exata vem
> primeiro. Depois há **propagação por exclusão**: cada pessoa da planilha é
> uma pessoa distinta e cada usuário do banco é uma pessoa só, logo o
> casamento é **injetivo** — um nome com candidato único trava aquele usuário
> e os demais nomes têm de liberá-lo.

## Por que a camada exata vem antes

Sem isso, **`Witor` empatava com `Vitor`** — duas pessoas diferentes, uma letra
de distância. A ambiguidade era **inventada pelo próprio matcher**. Com a camada
exata primeiro, `Witor` casa com `Witor Silva` por igualdade e o empate nunca
acontece.

E há uma regra de segurança adicional: **um match aproximado que aponta para
uma conta `admin` nunca é aceito sozinho.** As contas admin são as poucas contas
de operação do sistema; confundir uma pessoa com uma delas por uma letra criaria
membership para quem talvez nem esteja no Squad.

---

## Resultado

|  | quantidade |
|---|---|
| MATCH_EXATO | 14 |
| NAO_ENCONTRADO | 3 |
| MATCH_APROXIMADO | 1 |
| MATCH_AMBIGUO | 4 |
| MATCH_POR_EXCLUSAO | 1 |
| **resolvidos** | **16 de 23** |

| nome na planilha | classe | camada | user_id | email | role | papéis |
|---|---|---|---|---|---|---|
| `Adrian` | **MATCH_EXATO** | `TOKEN_EXATO` | #9 | adrian.neves@vendexcompany.com | user | squad-2:gestor |
| `Anderson` | **MATCH_EXATO** | `TOKEN_EXATO` | #11 | anderson.santos@vendexcompany.com | user | squad-4:gestor |
| `Caique` | **NAO_ENCONTRADO** | `TOKEN_APROXIMADO` | — | — | — | squad-2:design |
| `Carol` | **NAO_ENCONTRADO** | `TOKEN_APROXIMADO` | — | — | — | squad-4:design |
| `Cavazzoto` | **MATCH_APROXIMADO** | `TOKEN_APROXIMADO` | #47 | gabrielly.cavazotto@vendexcompany.com | membro | squad-3:design |
| `Diogo` | **MATCH_EXATO** | `TOKEN_EXATO` | #32 | diogo-pinheiro2001@hotmail.com | user | squad-3:gestor |
| `Eliabe` | **MATCH_EXATO** | `TOKEN_EXATO` | #13 | eliabe.almeida@vendexcompany.com | user | squad-1:gestor |
| `Felipe` | **MATCH_EXATO** | `TOKEN_EXATO` | #37 | felipe.pitta@vendexcompany.com | user | squad-5:auxiliar |
| `Fernando` | **MATCH_AMBIGUO** | `TOKEN_EXATO` | — | — | — | squad-1:auxiliar2, squad-4:coordenador |
| `Gabrielly` | **MATCH_POR_EXCLUSAO** | `TOKEN_EXATO` | #16 | gabrielly.ribeiro@vendexcompany.com | user | squad-1:design |
| `Giovanna` | **MATCH_EXATO** | `TOKEN_EXATO` | #17 | giovanna.santos@vendexcompany.com | user | squad-4:auxiliar |
| `Gustavo` | **MATCH_EXATO** | `TOKEN_EXATO` | #46 | gustavo.nakamura@vendexcompany.com | membro | squad-1:auxiliar |
| `Juliana` | **MATCH_EXATO** | `TOKEN_EXATO` | #21 | juliana.discher@vendexcompany.com | user | squad-2:auxiliar |
| `Klayvert` | **MATCH_AMBIGUO** | `TOKEN_EXATO` | — | — | — | squad-2:coordenador, squad-3:coordenador, squad-6:coordenador |
| `Matheus` | **MATCH_EXATO** | `TOKEN_EXATO` | #23 | matheus.leopoldo@vendexcompany.com | user | squad-6:gestor |
| `Mayara` | **MATCH_EXATO** | `TOKEN_EXATO` | #38 | mayara.cerbi@vendexcompany.com | user | squad-3:auxiliar |
| `Micael` | **MATCH_EXATO** | `TOKEN_EXATO` | #24 | micael.almeida@vendexcompany.com | user | squad-1:coordenador, squad-5:coordenador |
| `Sophia` | **MATCH_EXATO** | `TOKEN_EXATO` | #28 | sophia.costa@vendexcompany.com | user | squad-5:design, squad-6:design |
| `Thiago` | **MATCH_EXATO** | `TOKEN_EXATO` | #48 | thiago.zanini@vendexcompany.com | user | squad-3:auxiliar2 |
| `Victor` | **MATCH_AMBIGUO** | `TOKEN_APROXIMADO` | — | — | — | squad-6:auxiliar |
| `Vinícius` | **MATCH_AMBIGUO** | `TOKEN_EXATO` | — | — | — | squad-2:auxiliar2 |
| `Witor` | **MATCH_EXATO** | `TOKEN_EXATO` | #31 | witor.silva@vendexcompany.com | user | squad-5:gestor |
| `Yuri` | **NAO_ENCONTRADO** | `TOKEN_APROXIMADO` | — | — | — | squad-4:auxiliar2 |

---

## Os não resolvidos, um a um

### `Caique` — NAO_ENCONTRADO

Candidatos: _nenhum_
Papéis: squad-2 · design

Não existe usuário com esse nome. É o **Design do Squad 2** — uma pessoa da operação **sem conta no sistema**.

### `Carol` — NAO_ENCONTRADO

Candidatos: _nenhum_
Papéis: squad-4 · design

Não existe usuário com esse nome nem variação (`Carol`, `Carolina`). É o **Design do Squad 4** — pessoa sem conta.

### `Fernando` — MATCH_AMBIGUO

Candidatos: #5 **Fernando Salgado** `<admin>` fernando.salgado@vendexcompany.com · #45 **Fernando Montoro** `<membro>` fernando.montoro@vendexcompany.com
Papéis: squad-1 · auxiliar2 · squad-4 · coordenador

**Duas pessoas diferentes chamadas Fernando.** Uma é `admin`, a outra `membro`. Fernando é **Coordenador do Squad 4 e Auxiliar 2 do Squad 1** — a escolha errada dá coordenação de Squad para a pessoa errada.

### `Klayvert` — MATCH_AMBIGUO

Candidatos: #22 **Klayvert Rodrigues** `<user>` klayvert.rodrigues@vendexcompany.com · #35 **Klayvert Rodrigues** `<user>` klayvert.rodrigues@vendexcompany.com.br
Papéis: squad-2 · coordenador · squad-3 · coordenador · squad-6 · coordenador

**A mesma pessoa com DUAS contas** — `@vendexcompany.com` e `@vendexcompany.com.br`. Não é ambiguidade de identidade, é **conta duplicada no cadastro**. Klayvert é Coordenador de **três** Squads.

### `Victor` — MATCH_AMBIGUO

Candidatos: #6 **Vitor Capeli** `<admin>` vitor.capeli@vendexcompany.com
Papéis: squad-6 · auxiliar

Casou **só por aproximação** (`Victor` ≈ `Vitor`) e o único candidato é conta **`admin`**. Pela regra, não é aceito sozinho. É o **Auxiliar do Squad 6**.

### `Vinícius` — MATCH_AMBIGUO

Candidatos: #29 **Vinicius Bergo** `<admin>` vinicius.bergo@vendexcompany.com · #44 **Vinicius Dias** `<membro>` vinicius.dias@vendexcompany.com
Papéis: squad-2 · auxiliar2

**Duas pessoas diferentes.** Uma é `admin`, a outra `membro`. É o **Auxiliar 2 do Squad 2**.

### `Yuri` — NAO_ENCONTRADO

Candidatos: _nenhum_
Papéis: squad-4 · auxiliar2

Não existe usuário com esse nome. É o **Auxiliar 2 do Squad 4** — pessoa sem conta.

---

## Efeito no plano

As 7 pessoas não resolvidas
**não entram no plano** — o plano tem
**18 memberships** em vez das 24 posições da planilha.
Nenhuma membership foi inventada.

