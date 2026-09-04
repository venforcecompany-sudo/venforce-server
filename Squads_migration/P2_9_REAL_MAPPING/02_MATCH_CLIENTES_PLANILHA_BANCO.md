# 02 — Match: planilha ↔ cliente real

> **Regra:** nenhum fuzzy silencioso. O casamento roda em camadas
> determinísticas e a **primeira camada que produzir exatamente um candidato
> decide**. Duas ou mais → `MATCH_AMBIGUO`. Nenhuma → `NAO_EXISTE_NO_BANCO`.

## As camadas, da mais estrita para a mais frouxa

| camada | o que compara | por que é segura |
|---|---|---|
| `L1_IGUALDADE_EXATA` | nome/slug normalizado idêntico | identidade literal |
| `L1B_IGUALDADE_COMPACTA` | mesma sequência de letras, sem separador | `J&W Presentes` ≡ `jw presentes` — não é fuzzy, é a mesma string sem pontuação |
| `L1C_..._SEM_CONECTIVOS` | idem, ignorando `de/da/do/e` | `Toque de Ouro` ≡ `Toque ouro` |
| `L2_RADICAL_DO_CLUSTER` | o radical comum de um cluster | a relação nomeia a empresa, não a entidade |
| `L3_RADICAL_LEGADO` | nome sem o sufixo legado | `Alma` para `Alma 2` |
| `L4_PREFIXO_DE_TOKENS` | a relação abrevia o cadastro | `Tenda` → `Tenda Medieval` |
| `L4B_CLIENTE_PREFIXO...` | o cadastro abrevia a relação | `DM Comércio` → cliente `DM` |
| `L5_CONTENCAO_DE_TOKENS` | todos os tokens presentes | só a partir de 5 caracteres |
| `L6_EVIDENCIA_DE_BASE` | **evidência de banco**, não de string | `Eletro in Matec` → base `eletroinmatec_ml` do cliente #111 |
| `L7_DISTANCIA_1_COMPACTA` | uma letra de diferença, mín. 5 letras | `Kirus` ↔ `Kirius` — última camada, a mais frouxa |

Nomes com menos de 5 caracteres **não** podem ser resolvidos por contenção nem
por distância. É o que impede `MM`, `MW`, `GS` e `ADS` de casarem por acidente.

---

## Os 52 nomes

| nome na relação | squad | classe | camada | cliente real | candidatos |
|---|---|---|---|---|---|
| `Carpei` | squad-1 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #33 `carpei` |  |
| `Power Game` | squad-1 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #125 `power_game` |  |
| `DM Comércio` | squad-1 | **MATCH_ALIAS_COMPROVADO** | `L4B_CLIENTE_PREFIXO_DA_RELACAO` | #30 `dm` |  |
| `Extra` | squad-1 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #35 `extra` |  |
| `JF` | squad-1 | **MATCH_ALIAS_COMPROVADO** | `L4_PREFIXO_DE_TOKENS` | #37 `jf_shopp` |  |
| `WBS` | squad-1 | **MATCH_CLUSTER_LEGADO** | `L2_RADICAL_DO_CLUSTER` | #32 `wbs_medical` |  |
| `Loja da Isa` | squad-1 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #29 `loja_da_isa` |  |
| `Mercadao` | squad-1 | **MATCH_CLUSTER_LEGADO** | `L4_PREFIXO_DE_TOKENS` | #36 `mercadao_enxovais` |  |
| `Tenda` | squad-1 | **MATCH_ALIAS_COMPROVADO** | `L4_PREFIXO_DE_TOKENS` | #52 `tenda_medieval` |  |
| `ADB Supply` | squad-2 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #21 `adb_supply` |  |
| `BrasilTek` | squad-2 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #97 `brasil_tek` |  |
| `J&W Presentes` | squad-2 | **MATCH_EXATO** | `L1B_IGUALDADE_COMPACTA` | #124 `jw_presentes` |  |
| `GS` | squad-2 | **NAO_EXISTE_NO_BANCO** | — | — | _nenhum_ |
| `Calhas` | squad-2 | **MATCH_ALIAS_COMPROVADO** | `L4_PREFIXO_DE_TOKENS` | #11 `calhas_kairos` |  |
| `Cegil` | squad-2 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #13 `cegil` |  |
| `Eletro in Matec` | squad-2 | **MATCH_ALIAS_COMPROVADO** | `L6_EVIDENCIA_DE_BASE` | #111 `inmatec` |  |
| `Empório Luz` | squad-2 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #23 `emprio_luz` |  |
| `MWM` | squad-2 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #9 `mwm` |  |
| `Tevix` | squad-2 | **MATCH_ALIAS_COMPROVADO** | `L4_PREFIXO_DE_TOKENS` | #110 `tevixcomercio` |  |
| `Up Vendas` | squad-2 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #16 `up_vendas` |  |
| `ADS` | squad-3 | **NAO_EXISTE_NO_BANCO** | — | — | _nenhum_ |
| `Beleza Chic` | squad-3 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #114 `beleza_chic` |  |
| `Brilha Kids` | squad-3 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #41 `brilha_kids` |  |
| `Infinite` | squad-3 | **MATCH_ALIAS_COMPROVADO** | `L4_PREFIXO_DE_TOKENS` | #101 `infinite_solucoes` |  |
| `MW` | squad-3 | **NAO_EXISTE_NO_BANCO** | — | — | _nenhum_ |
| `MM` | squad-3 | **MATCH_AMBIGUO** | `L4_PREFIXO_DE_TOKENS` | — | #107 `mm_comercio` · #54 `mm_importes` |
| `Plispack` | squad-3 | **MATCH_ALIAS_COMPROVADO** | `L4_PREFIXO_DE_TOKENS` | #115 `plispack_embalagens` |  |
| `Rios Shop` | squad-3 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #108 `rios_shop` |  |
| `Zorza` | squad-3 | **MATCH_CLUSTER_LEGADO** | `L4_PREFIXO_DE_TOKENS` | #112 `zorzaloja` |  |
| `AVENDA` | squad-4 | **MATCH_EXATO** | `L1B_IGUALDADE_COMPACTA` | #85 `a_venda` |  |
| `Comprou Enviou` | squad-4 | **MATCH_ALIAS_COMPROVADO** | `L4_PREFIXO_DE_TOKENS` | #48 `comprou_enviou_chegou` |  |
| `Dua cosmeticos` | squad-4 | **MATCH_CLUSTER_LEGADO** | `L1_IGUALDADE_EXATA` | #40 `dua_cosmeticos` |  |
| `Exclusiva Jeans` | squad-4 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #56 `exclusiva_jeans` |  |
| `Influencia Jeans` | squad-4 | **MATCH_CLUSTER_LEGADO** | `L1_IGUALDADE_EXATA` | #15 `influencia_jeans` |  |
| `Kirus` | squad-4 | **MATCH_ALIAS_COMPROVADO** | `L7_DISTANCIA_1_COMPACTA` | #49 `kirius` |  |
| `Maya` | squad-4 | **MATCH_CLUSTER_LEGADO** | `L1_IGUALDADE_EXATA` | #55 `maya` |  |
| `Nikolly Fashion` | squad-4 | **NAO_EXISTE_NO_BANCO** | — | — | _nenhum_ |
| `Paula e Anselmo` | squad-4 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #99 `paula_anselmo` |  |
| `Shopping 86` | squad-4 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #86 `shopping_86` |  |
| `WM` | squad-4 | **MATCH_CLUSTER_LEGADO** | `L4_PREFIXO_DE_TOKENS` | #123 `wmmodas` |  |
| `Zenite` | squad-4 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #100 `zenite_loja` |  |
| `Alma` | squad-5 | **MATCH_CLUSTER_LEGADO** | `L1_IGUALDADE_EXATA` | #39 `alma` |  |
| `Castro Company` | squad-5 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #93 `castro_company` |  |
| `ER2` | squad-5 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #98 `er_2` |  |
| `Giromax` | squad-5 | **MATCH_EXATO** | `L1B_IGUALDADE_COMPACTA` | #117 `giro_max` |  |
| `Rikam` | squad-5 | **MATCH_ALIAS_COMPROVADO** | `L4_PREFIXO_DE_TOKENS` | #119 `rikam_loja` |  |
| `Thiago Moreno` | squad-5 | **NAO_EXISTE_NO_BANCO** | — | — | _nenhum_ |
| `Fênix` | squad-6 | **MATCH_ALIAS_COMPROVADO** | `L4_PREFIXO_DE_TOKENS` | #102 `fenix_equipamentos1` |  |
| `Fitassul Comércio` | squad-6 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #120 `fitassul_comercio` |  |
| `LPS Fitness` | squad-6 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #38 `lps_fitness` |  |
| `Red Fish` | squad-6 | **MATCH_EXATO** | `L1_IGUALDADE_EXATA` | #104 `red_fish` |  |
| `Toque de Ouro` | squad-6 | **MATCH_EXATO** | `L1C_IGUALDADE_COMPACTA_SEM_CONECTIVOS` | #113 `toque_ouro` |  |

