# 01 — A relação operacional, literal e normalizada

> Extração **literal** de `Squads_migration/Squads.xlsx`. Nenhum nome foi
> corrigido, traduzido ou inferido na entrada. A normalização acontece depois,
> no casamento, e cada decisão fica registrada em `02`.

## O rótulo do 6º bloco

O readiness anterior deixou pendente o rótulo do 6º bloco, porque a versão que
chegou antes o escrevia como `squad 5` pela segunda vez. **A planilha atual
resolve isso na própria fonte:** o bloco está rotulado `squad 6`.

| bloco | rótulo lido na planilha | slug canônico |
|---|---|---|
| 1 | `squad 1` | `squad-1` |
| 2 | `squad 2` | `squad-2` |
| 3 | `squad 3` | `squad-3` |
| 4 | `squad 4` | `squad-4` |
| 5 | `squad 5` | `squad-5` |
| 6 | `squad 6` | `squad-6` |

A estrutura confirmada é **Coordenador → Gestor → Auxiliar → Auxiliar 2 →
Design**, e **Coordenador não é Gestor** — a correção da fase anterior está
preservada. No plano canônico, `coordenador` vira
`squad_members.funcao = "coordenador"`; Gestor, Auxiliar e Design viram
`funcao = "membro"`, porque são papéis **operacionais**, não de autorização.

Dois Squads têm a posição de **Auxiliar 2 vazia** (Squads 5 e 6). Isso não é
erro de leitura: a célula está em branco na planilha.

---

### Squad 1  ·  rótulo na planilha: `squad 1`

| papel | nome na planilha | resolvido |
|---|---|---|
| coordenador | `Micael` | #24 · micael.almeida@vendexcompany.com |
| gestor | `Eliabe` | #13 · eliabe.almeida@vendexcompany.com |
| auxiliar | `Gustavo` | #46 · gustavo.nakamura@vendexcompany.com |
| auxiliar2 | `Fernando` | **MATCH_AMBIGUO** |
| design | `Gabrielly` | #16 · gabrielly.ribeiro@vendexcompany.com |

**Clientes (9):**

| nome na relação | classe | cliente real |
|---|---|---|
| `Carpei` | MATCH_EXATO | #33 `carpei` |
| `Power Game` | MATCH_EXATO | #125 `power_game` |
| `DM Comércio` | MATCH_ALIAS_COMPROVADO | #30 `dm` |
| `Extra` | MATCH_EXATO | #35 `extra` |
| `JF` | MATCH_ALIAS_COMPROVADO | #37 `jf_shopp` |
| `WBS` | MATCH_CLUSTER_LEGADO | #32 `wbs_medical` |
| `Loja da Isa` | MATCH_EXATO | #29 `loja_da_isa` |
| `Mercadao` | MATCH_CLUSTER_LEGADO | #36 `mercadao_enxovais` |
| `Tenda` | MATCH_ALIAS_COMPROVADO | #52 `tenda_medieval` |

---

### Squad 2  ·  rótulo na planilha: `squad 2`

| papel | nome na planilha | resolvido |
|---|---|---|
| coordenador | `Klayvert` | **MATCH_AMBIGUO** |
| gestor | `Adrian` | #9 · adrian.neves@vendexcompany.com |
| auxiliar | `Juliana` | #21 · juliana.discher@vendexcompany.com |
| auxiliar2 | `Vinícius` | **MATCH_AMBIGUO** |
| design | `Caique` | **NAO_ENCONTRADO** |

**Clientes (11):**

| nome na relação | classe | cliente real |
|---|---|---|
| `ADB Supply` | MATCH_EXATO | #21 `adb_supply` |
| `BrasilTek` | MATCH_EXATO | #97 `brasil_tek` |
| `J&W Presentes` | MATCH_EXATO | #124 `jw_presentes` |
| `GS` | NAO_EXISTE_NO_BANCO | — |
| `Calhas` | MATCH_ALIAS_COMPROVADO | #11 `calhas_kairos` |
| `Cegil` | MATCH_EXATO | #13 `cegil` |
| `Eletro in Matec` | MATCH_ALIAS_COMPROVADO | #111 `inmatec` |
| `Empório Luz` | MATCH_EXATO | #23 `emprio_luz` |
| `MWM` | MATCH_EXATO | #9 `mwm` |
| `Tevix` | MATCH_ALIAS_COMPROVADO | #110 `tevixcomercio` |
| `Up Vendas` | MATCH_EXATO | #16 `up_vendas` |

---

### Squad 3  ·  rótulo na planilha: `squad 3`

| papel | nome na planilha | resolvido |
|---|---|---|
| coordenador | `Klayvert` | **MATCH_AMBIGUO** |
| gestor | `Diogo` | #32 · diogo-pinheiro2001@hotmail.com |
| auxiliar | `Mayara` | #38 · mayara.cerbi@vendexcompany.com |
| auxiliar2 | `Thiago` | #48 · thiago.zanini@vendexcompany.com |
| design | `Cavazzoto` | #47 · gabrielly.cavazotto@vendexcompany.com |

**Clientes (9):**

| nome na relação | classe | cliente real |
|---|---|---|
| `ADS` | NAO_EXISTE_NO_BANCO | — |
| `Beleza Chic` | MATCH_EXATO | #114 `beleza_chic` |
| `Brilha Kids` | MATCH_EXATO | #41 `brilha_kids` |
| `Infinite` | MATCH_ALIAS_COMPROVADO | #101 `infinite_solucoes` |
| `MW` | NAO_EXISTE_NO_BANCO | — |
| `MM` | MATCH_AMBIGUO | — |
| `Plispack` | MATCH_ALIAS_COMPROVADO | #115 `plispack_embalagens` |
| `Rios Shop` | MATCH_EXATO | #108 `rios_shop` |
| `Zorza` | MATCH_CLUSTER_LEGADO | #112 `zorzaloja` |

---

### Squad 4  ·  rótulo na planilha: `squad 4`

| papel | nome na planilha | resolvido |
|---|---|---|
| coordenador | `Fernando` | **MATCH_AMBIGUO** |
| gestor | `Anderson` | #11 · anderson.santos@vendexcompany.com |
| auxiliar | `Giovanna` | #17 · giovanna.santos@vendexcompany.com |
| auxiliar2 | `Yuri` | **NAO_ENCONTRADO** |
| design | `Carol` | **NAO_ENCONTRADO** |

**Clientes (12):**

| nome na relação | classe | cliente real |
|---|---|---|
| `AVENDA` | MATCH_EXATO | #85 `a_venda` |
| `Comprou Enviou` | MATCH_ALIAS_COMPROVADO | #48 `comprou_enviou_chegou` |
| `Dua cosmeticos` | MATCH_CLUSTER_LEGADO | #40 `dua_cosmeticos` |
| `Exclusiva Jeans` | MATCH_EXATO | #56 `exclusiva_jeans` |
| `Influencia Jeans` | MATCH_CLUSTER_LEGADO | #15 `influencia_jeans` |
| `Kirus` | MATCH_ALIAS_COMPROVADO | #49 `kirius` |
| `Maya` | MATCH_CLUSTER_LEGADO | #55 `maya` |
| `Nikolly Fashion` | NAO_EXISTE_NO_BANCO | — |
| `Paula e Anselmo` | MATCH_EXATO | #99 `paula_anselmo` |
| `Shopping 86` | MATCH_EXATO | #86 `shopping_86` |
| `WM` | MATCH_CLUSTER_LEGADO | #123 `wmmodas` |
| `Zenite` | MATCH_EXATO | #100 `zenite_loja` |

---

### Squad 5  ·  rótulo na planilha: `squad 5`

| papel | nome na planilha | resolvido |
|---|---|---|
| coordenador | `Micael` | #24 · micael.almeida@vendexcompany.com |
| gestor | `Witor` | #31 · witor.silva@vendexcompany.com |
| auxiliar | `Felipe` | #37 · felipe.pitta@vendexcompany.com |
| auxiliar2 | _(vazio)_ | — posição vaga |
| design | `Sophia` | #28 · sophia.costa@vendexcompany.com |

**Clientes (6):**

| nome na relação | classe | cliente real |
|---|---|---|
| `Alma` | MATCH_CLUSTER_LEGADO | #39 `alma` |
| `Castro Company` | MATCH_EXATO | #93 `castro_company` |
| `ER2` | MATCH_EXATO | #98 `er_2` |
| `Giromax` | MATCH_EXATO | #117 `giro_max` |
| `Rikam` | MATCH_ALIAS_COMPROVADO | #119 `rikam_loja` |
| `Thiago Moreno` | NAO_EXISTE_NO_BANCO | — |

---

### Squad 6  ·  rótulo na planilha: `squad 6`

| papel | nome na planilha | resolvido |
|---|---|---|
| coordenador | `Klayvert` | **MATCH_AMBIGUO** |
| gestor | `Matheus` | #23 · matheus.leopoldo@vendexcompany.com |
| auxiliar | `Victor` | **MATCH_AMBIGUO** |
| auxiliar2 | _(vazio)_ | — posição vaga |
| design | `Sophia` | #28 · sophia.costa@vendexcompany.com |

**Clientes (5):**

| nome na relação | classe | cliente real |
|---|---|---|
| `Fênix` | MATCH_ALIAS_COMPROVADO | #102 `fenix_equipamentos1` |
| `Fitassul Comércio` | MATCH_EXATO | #120 `fitassul_comercio` |
| `LPS Fitness` | MATCH_EXATO | #38 `lps_fitness` |
| `Red Fish` | MATCH_EXATO | #104 `red_fish` |
| `Toque de Ouro` | MATCH_EXATO | #113 `toque_ouro` |

