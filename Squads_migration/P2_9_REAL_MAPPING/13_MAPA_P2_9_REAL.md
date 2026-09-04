# 13 — Mapa P2.9 real

> O mapa completo dos **83** clientes reais. Máquina:
> `artefatos/MAPA_P2_9_REAL.json` e `artefatos/plano-p2-9.json`.

## Squads

| slug | nome | tipo | clientes | memberships |
|---|---|---|---|---|
| `squad-1` | Squad 1 | operacional | 11 | 4 |
| `squad-2` | Squad 2 | operacional | 10 | 2 |
| `squad-3` | Squad 3 | operacional | 7 | 4 |
| `squad-4` | Squad 4 | operacional | 18 | 2 |
| `squad-5` | Squad 5 | operacional | 6 | 4 |
| `squad-6` | Squad 6 | operacional | 5 | 2 |
| `squad-8-legado` | Squad 8 · Legado | **legado especial** | 26 | 0 |

**6 operacionais + 1 legado.** Squad 8 não conta entre os operacionais. Não há
`squad-7` nem `squad-9`, e há exatamente **um** Squad legado — invariantes
`I15` e `I16`.

---

## Memberships

| squad | usuário | função | papel operacional | principal |
|---|---|---|---|---|
| squad-1 | micael.almeida@vendexcompany.com | `coordenador` | coordenador | **PENDENTE** |
| squad-1 | eliabe.almeida@vendexcompany.com | `membro` | gestor | sim |
| squad-1 | gustavo.nakamura@vendexcompany.com | `membro` | auxiliar | sim |
| squad-1 | gabrielly.ribeiro@vendexcompany.com | `membro` | design | sim |
| squad-2 | adrian.neves@vendexcompany.com | `membro` | gestor | sim |
| squad-2 | juliana.discher@vendexcompany.com | `membro` | auxiliar | sim |
| squad-3 | diogo-pinheiro2001@hotmail.com | `membro` | gestor | sim |
| squad-3 | mayara.cerbi@vendexcompany.com | `membro` | auxiliar | sim |
| squad-3 | thiago.zanini@vendexcompany.com | `membro` | auxiliar2 | sim |
| squad-3 | gabrielly.cavazotto@vendexcompany.com | `membro` | design | sim |
| squad-4 | anderson.santos@vendexcompany.com | `membro` | gestor | sim |
| squad-4 | giovanna.santos@vendexcompany.com | `membro` | auxiliar | sim |
| squad-5 | micael.almeida@vendexcompany.com | `coordenador` | coordenador | **PENDENTE** |
| squad-5 | witor.silva@vendexcompany.com | `membro` | gestor | sim |
| squad-5 | felipe.pitta@vendexcompany.com | `membro` | auxiliar | sim |
| squad-5 | sophia.costa@vendexcompany.com | `membro` | design | **PENDENTE** |
| squad-6 | matheus.leopoldo@vendexcompany.com | `membro` | gestor | sim |
| squad-6 | sophia.costa@vendexcompany.com | `membro` | design | **PENDENTE** |

`coordenador` vira `funcao = "coordenador"`; Gestor, Auxiliar e Design viram
`funcao = "membro"` — são papéis **operacionais**, registrados em
`_papelOperacional`, não papéis de autorização. **A correção de que Gestor não
é Coordenador está preservada.**

---

## Clientes por Squad

### `squad-1` — 11 clientes

| id | slug | nome | origem | nome na relação |
|---|---|---|---|---|
| 29 | `loja_da_isa` | Loja da Isa | `MATCH_EXATO` | Loja da Isa |
| 30 | `dm` | DM | `MATCH_ALIAS_COMPROVADO` | DM Comércio |
| 32 | `wbs_medical` | WBS Medical | `MATCH_CLUSTER_LEGADO` | WBS |
| 33 | `carpei` | Carpei | `MATCH_EXATO` | Carpei |
| 35 | `extra` | Extra | `MATCH_EXATO` | Extra |
| 36 | `mercadao_enxovais` | Mercadao enxovais | `MATCH_CLUSTER_LEGADO` | Mercadao |
| 37 | `jf_shopp` | JF Shopp | `MATCH_ALIAS_COMPROVADO` | JF |
| 52 | `tenda_medieval` | Tenda Medieval | `MATCH_ALIAS_COMPROVADO` | Tenda |
| 62 | `wbs_2` | wbs 2 | `ALIAS_HERDA_CANONICO` | WBS |
| 65 | `mercadao_enxovais_2` | Mercadao enxovais 2 | `ALIAS_HERDA_CANONICO` | Mercadao |
| 125 | `power_game` | Power Game | `MATCH_EXATO` | Power Game |

### `squad-2` — 10 clientes

| id | slug | nome | origem | nome na relação |
|---|---|---|---|---|
| 9 | `mwm` | MWM | `MATCH_EXATO` | MWM |
| 11 | `calhas_kairos` | Calhas Kairos | `MATCH_ALIAS_COMPROVADO` | Calhas |
| 13 | `cegil` | Cegil | `MATCH_EXATO` | Cegil |
| 16 | `up_vendas` | Up Vendas | `MATCH_EXATO` | Up Vendas |
| 21 | `adb_supply` | ADB Supply | `MATCH_EXATO` | ADB Supply |
| 23 | `emprio_luz` | Empório Luz | `MATCH_EXATO` | Empório Luz |
| 97 | `brasil_tek` | BrasilTek | `MATCH_EXATO` | BrasilTek |
| 110 | `tevixcomercio` | tevix.comercio | `MATCH_ALIAS_COMPROVADO` | Tevix |
| 111 | `inmatec` | in.matec | `MATCH_ALIAS_COMPROVADO` | Eletro in Matec |
| 124 | `jw_presentes` | jw presentes | `MATCH_EXATO` | J&W Presentes |

### `squad-3` — 7 clientes

| id | slug | nome | origem | nome na relação |
|---|---|---|---|---|
| 41 | `brilha_kids` | Brilha Kids | `MATCH_EXATO` | Brilha Kids |
| 101 | `infinite_solucoes` | Infinite Solucoes | `MATCH_ALIAS_COMPROVADO` | Infinite |
| 108 | `rios_shop` | Rios Shop | `MATCH_EXATO` | Rios Shop |
| 112 | `zorzaloja` | zorza.loja | `MATCH_CLUSTER_LEGADO` | Zorza |
| 114 | `beleza_chic` | Beleza Chic | `MATCH_EXATO` | Beleza Chic |
| 115 | `plispack_embalagens` | PlisPack Embalagens | `MATCH_ALIAS_COMPROVADO` | Plispack |
| 121 | `zorza_shopee` | zorza_shopee | `ALIAS_HERDA_CANONICO` | Zorza |

### `squad-4` — 18 clientes

| id | slug | nome | origem | nome na relação |
|---|---|---|---|---|
| 15 | `influencia_jeans` | Influencia Jeans | `MATCH_CLUSTER_LEGADO` | Influencia Jeans |
| 40 | `dua_cosmeticos` | Dua Cosmeticos | `MATCH_CLUSTER_LEGADO` | Dua cosmeticos |
| 48 | `comprou_enviou_chegou` | Comprou Enviou Chegou | `MATCH_ALIAS_COMPROVADO` | Comprou Enviou |
| 49 | `kirius` | Kirius | `MATCH_ALIAS_COMPROVADO` | Kirus |
| 55 | `maya` | Maya | `MATCH_CLUSTER_LEGADO` | Maya |
| 56 | `exclusiva_jeans` | Exclusiva Jeans | `MATCH_EXATO` | Exclusiva Jeans |
| 60 | `influencia_jeans_2` | influencia_jeans 2 | `ALIAS_HERDA_CANONICO` | Influencia Jeans |
| 67 | `dua_cosmeticos_2` | Dua Cosmeticos 2 | `ALIAS_HERDA_CANONICO` | Dua cosmeticos |
| 68 | `maya_2` | maya 2 | `ALIAS_HERDA_CANONICO` | Maya |
| 69 | `maya_3` | maya 3 | `ALIAS_HERDA_CANONICO` | Maya |
| 70 | `maya_4` | maya 4 | `ALIAS_HERDA_CANONICO` | Maya |
| 71 | `maya_5` | maya 5 | `ALIAS_HERDA_CANONICO` | Maya |
| 85 | `a_venda` | a_venda | `MATCH_EXATO` | AVENDA |
| 86 | `shopping_86` | shopping_86 | `MATCH_EXATO` | Shopping 86 |
| 99 | `paula_anselmo` | Paula e Anselmo | `MATCH_EXATO` | Paula e Anselmo |
| 100 | `zenite_loja` | Zenite | `MATCH_EXATO` | Zenite |
| 116 | `william_modas` | William Modas | `ALIAS_HERDA_CANONICO` | WM |
| 123 | `wmmodas` | wm.modas | `MATCH_CLUSTER_LEGADO` | WM |

### `squad-5` — 6 clientes

| id | slug | nome | origem | nome na relação |
|---|---|---|---|---|
| 39 | `alma` | Alma | `MATCH_CLUSTER_LEGADO` | Alma |
| 66 | `alma_2` | Alma 2 | `ALIAS_HERDA_CANONICO` | Alma |
| 93 | `castro_company` | Castro Company | `MATCH_EXATO` | Castro Company |
| 98 | `er_2` | er2 | `MATCH_EXATO` | ER2 |
| 117 | `giro_max` | Giro Max | `MATCH_EXATO` | Giromax |
| 119 | `rikam_loja` | Rikam Loja | `MATCH_ALIAS_COMPROVADO` | Rikam |

### `squad-6` — 5 clientes

| id | slug | nome | origem | nome na relação |
|---|---|---|---|---|
| 38 | `lps_fitness` | LPS Fitness | `MATCH_EXATO` | LPS Fitness |
| 102 | `fenix_equipamentos1` | Fenix Equipamentos1 | `MATCH_ALIAS_COMPROVADO` | Fênix |
| 104 | `red_fish` | Red Fish | `MATCH_EXATO` | Red Fish |
| 113 | `toque_ouro` | Toque ouro | `MATCH_EXATO` | Toque de Ouro |
| 120 | `fitassul_comercio` | Fitassul Comercio | `MATCH_EXATO` | Fitassul Comércio |

### `squad-8-legado` — 26 clientes

| id | slug | nome | origem | nome na relação |
|---|---|---|---|---|
| 14 | `maximus_feramentas` | Maximus Feramentas | `FORA_DA_RELACAO` | — |
| 17 | `deluche` | Deluche | `FORA_DA_RELACAO` | — |
| 19 | `vent_solues` | Vent soluções | `FORA_DA_RELACAO` | — |
| 25 | `maria_eduarda` | Maria Eduarda | `FORA_DA_RELACAO` | — |
| 28 | `pro_fit` | Pro Fit | `FORA_DA_RELACAO` | — |
| 34 | `j_meira` | J Meira | `FORA_DA_RELACAO` | — |
| 50 | `pedro_baby` | Pedro Baby | `FORA_DA_RELACAO` | — |
| 51 | `envm` | ENVM | `FORA_DA_RELACAO` | — |
| 53 | `macedo_materiais_construo` | Macedo Materiais Construção | `FORA_DA_RELACAO` | — |
| 54 | `mm_importes` | MM Importes | `FORA_DA_RELACAO` | — |
| 57 | `mais_estilo` | Mais Estilo | `FORA_DA_RELACAO` | — |
| 58 | `luli` | Luli | `FORA_DA_RELACAO` | — |
| 59 | `trevo` | Trevo | `FORA_DA_RELACAO` | — |
| 63 | `j_meira_2` | J Meira 2 | `FORA_DA_RELACAO` | — |
| 64 | `j_meira_3` | J Meira 3 | `FORA_DA_RELACAO` | — |
| 75 | `jfx` | JFX | `FORA_DA_RELACAO` | — |
| 82 | `luli_1` | Luli_1 | `FORA_DA_RELACAO` | — |
| 90 | `shalom_industria` | Shalom_industria | `FORA_DA_RELACAO` | — |
| 94 | `demo-shopee` | Cliente Demo Shopee | `FORA_DA_RELACAO` | — |
| 105 | `elizamarket` | Eliza.Market | `FORA_DA_RELACAO` | — |
| 106 | `teste_x01` | Teste_x01 | `FORA_DA_RELACAO` | — |
| 107 | `mm_comercio` | MM Comercio | `FORA_DA_RELACAO` | — |
| 109 | `teste_01` | Teste 01 | `FORA_DA_RELACAO` | — |
| 122 | `canastra` | cafe | `FORA_DA_RELACAO` | — |
| 126 | `teste1` | teste1 | `FORA_DA_RELACAO` | — |
| 127 | `teste2` | teste2 | `FORA_DA_RELACAO` | — |

---

## Invariantes

| # | invariante | resultado | evidência |
|---|---|---|---|
| I1 | nenhum Grant some | ✅ **OK** | grants de alias no banco=13 · grants endereçados no plano=13 · total no banco=63 |
| I2 | nenhum Grant troca de seller/conta | ✅ **OK** | grants reapontados sem conta de mesmo ml_user_id: 0 |
| I3 | nenhuma conta muda de marketplace | ✅ **OK** | contas movidas sem marketplace preservado: 0 |
| I4 | nenhuma ClienteConta duplicada é criada | ✅ **OK** | 3 conta(s) com chave natural já existente marcadas DEDUPLICAR_CONTA (nunca criar segunda) |
| I5 | nenhum Cliente novo é criado | ✅ **OK** | plano não contém nenhuma operação de criação de cliente |
| I6 | todo Cliente ativo termina em exatamente 1 Squad | ✅ **OK** | sem squad: 0 · com 2+ squads: 0 · conflitos de relação: 0 |
| I7 | Cliente da relação vai para Squad 1–6 | ✅ **OK** | clientes resolvidos pela relação que caíram no Squad 8: 0 |
| I8 | Cliente fora da relação vai para Squad 8 | ✅ **OK** | clientes fora da relação que NÃO foram para o Squad 8: 0 |
| I9 | alias não ganha Squad próprio | ✅ **OK** | aliases com Squad decidido independentemente do canônico: 0 |
| I14 | nenhum cliente inexistente entra no plano | ✅ **OK** | entradas do plano sem cliente real correspondente: 0 |
| I15 | exatamente 6 Squads operacionais + 1 legado | ✅ **OK** | operacionais=6 (squad-1, squad-2, squad-3, squad-4, squad-5, squad-6) · legado=1 |
| I16 | nenhum Squad 7 ou 9 acidental | ✅ **OK** | todos os operacionais são squad-1..squad-6 |
| I17 | todo id do mapa existe no banco | ✅ **OK** | 83 entradas conferidas |

### As que não são verificáveis por este módulo

| # | invariante | onde é provada |
|---|---|---|
| 10 | Admin bypass preservado | `authorizationService.ehAdmin` roda antes de qualquer checagem de Squad; `squadsIsolamento.test.js` (47 verificações) cobre |
| 11 | `SQUADS_ENFORCEMENT` continua OFF | nenhuma variável de ambiente foi alterada; `squadsRolloutGate` e `squadsRolloutGateBoot` verdes |
| 12 | dry-run faz zero escrita | `squadsDryRunZeroWrite.test.js` + prova contra produção sob `default_transaction_read_only=on` — ver `11` e `14` |
| 13 | apply não é executado | nenhum comando com `--apply` foi emitido nesta missão |

