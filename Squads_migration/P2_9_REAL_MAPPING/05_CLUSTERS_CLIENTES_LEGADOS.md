# 05 — Clusters de cliente legado

> **Sufixo não é evidência.** A regra de sufixo se autovalida: `Empresa X 2` só
> forma cluster com `Empresa X` se o radical resultante **casar com outro
> cliente real**. É o que impede `ER2` → `ER`, `Shopping 86` → `Shopping` e
> `Fenix Equipamentos1` → `Fenix Equipamentos` de virarem falsos clusters.

## O modelo que estamos corrigindo

```
ANTIGO                          NOVO
cliente "Empresa X"             cliente "Empresa X"
cliente "Empresa X 2"      →       ├── ClienteConta 1
cliente "Empresa X 3"              ├── ClienteConta 2
  (cada um = uma conta)            └── ClienteConta 3
```

## Hierarquia de evidências

| evidência | força | o que prova |
|---|---|---|
| `EXTERNAL_ACCOUNT_ID` | **CONFIRMADO** | duas `cliente_contas` apontam para a **mesma conta de marketplace** sob clientes diferentes |
| `ML_USER_ID` (ambos primários) | **CONFIRMADO** | duas entidades reivindicam a mesma conta como principal |
| `SUFIXO_LEGADO_AUTOVALIDADO` | FORTE | o radical existe como cliente real — o sufixo é sufixo mesmo |
| `RADICAL_LEGADO_COMUM` | FORTE | `maya 2` e `maya 3` reduzem ao mesmo radical |
| `SUFIXO_MARKETPLACE_CASCA_VAZIA` | FORTE | `zorza_shopee` sem conta, grant, base nem linha — fundir não pode perder nada |
| corroboração pela relação | eleva FORTE → CONFIRMADO | a operação listou o radical **uma vez** para N entidades: ela própria diz que é uma empresa só |

**Só `CONFIRMADO` pode chegar ao plano automático.** `FORTE` e `AMBIGUO` são
decisão humana — e, como a consolidação é `PLAN_ONLY` nesta missão, nada disso
foi aplicado de qualquer forma.

---

## Escolha do canônico

Não é "menor id sempre". O score é evidência de uso real:

| componente | peso | por quê |
|---|---|---|
| sem sufixo legado | **1000** | única propriedade que fala da **identidade comercial** |
| contas ativas | 60 cada | operação viva |
| grants | 50 cada | acesso vivo ao marketplace |
| vínculos de base ativos | 25 cada | custo operacional configurado |
| volume de dados | log₁₀ × 30 | custo de migrar, não identidade |
| id mais antigo | desempate | o registro original tende a ser o primeiro |

---

## Os 11 clusters

### Cluster `influencia_jeans` — **CONFIRMADO**

Radical comum: `influencia jeans`
Corroborado pela relação: **sim**
Ação: `PLAN_ONLY`

| id | slug | nome | score | contas | grants | bases | linhas ref. | papel |
|---|---|---|---|---|---|---|---|---|
| 15 | `influencia_jeans` | Influencia Jeans | 1397 | 1 | 1 | 1 | 372 | **CANÔNICO** |
| 60 | `influencia_jeans_2` | influencia_jeans 2 | 304 | 1 | 1 | 2 | 8 | alias |

**Evidências:**

- `SUFIXO_LEGADO_AUTOVALIDADO` **[FORTE]** entre #60 e #15 — "influencia_jeans 2" reduz ao radical "influencia jeans", que É o nome/slug do cliente #15 — sufixo confirmado por existir o original

---

### Cluster `wbs_medical` — **CONFIRMADO**

Radical comum: `wbs`
Corroborado pela relação: **sim**
Ação: `PLAN_ONLY`

| id | slug | nome | score | contas | grants | bases | linhas ref. | papel |
|---|---|---|---|---|---|---|---|---|
| 32 | `wbs_medical` | WBS Medical | 1307 | 1 | 1 | 0 | 8 | **CANÔNICO** |
| 62 | `wbs_2` | wbs 2 | 273 | 1 | 1 | 0 | 6 | alias |

**Evidências:**

- `EXTERNAL_ACCOUNT_ID` **[CONFIRMADO]** entre #32 e #62 — cliente_contas com o mesmo external_account_id 234836231 (meli) sob clientes distintos

---

### Cluster `j_meira` — **FORTE**

Radical comum: `j meira`
Corroborado pela relação: **não**
Ação: `PLAN_ONLY`

| id | slug | nome | score | contas | grants | bases | linhas ref. | papel |
|---|---|---|---|---|---|---|---|---|
| 34 | `j_meira` | J Meira | 1175 | 0 | 0 | 0 | 1 | **CANÔNICO** |
| 63 | `j_meira_2` | J Meira 2 | 137 | 0 | 0 | 0 | 0 | alias |
| 64 | `j_meira_3` | J Meira 3 | 136 | 0 | 0 | 0 | 0 | alias |

**Evidências:**

- `SUFIXO_LEGADO_AUTOVALIDADO` **[FORTE]** entre #63 e #34 — "J Meira 2" reduz ao radical "j meira", que É o nome/slug do cliente #34 — sufixo confirmado por existir o original
- `RADICAL_LEGADO_COMUM` **[FORTE]** entre #63 e #64 — ambos reduzem ao mesmo radical legado "j meira"
- `SUFIXO_LEGADO_AUTOVALIDADO` **[FORTE]** entre #34 e #64 — "J Meira 3" reduz ao radical "j meira", que É o nome/slug do cliente #34 — sufixo confirmado por existir o original

---

### Cluster `mercadao_enxovais` — **CONFIRMADO**

Radical comum: `mercadao enxovais`
Corroborado pela relação: **sim**
Ação: `PLAN_ONLY`

| id | slug | nome | score | contas | grants | bases | linhas ref. | papel |
|---|---|---|---|---|---|---|---|---|
| 36 | `mercadao_enxovais` | Mercadao enxovais | 1364 | 2 | 1 | 0 | 9 | **CANÔNICO** |
| 65 | `mercadao_enxovais_2` | Mercadao enxovais 2 | 322 | 1 | 2 | 0 | 7 | alias |

**Evidências:**

- `ML_USER_ID` **[CONFIRMADO]** entre #36 e #65 — mesmo ml_user_id 8682183 marcado PRIMÁRIO nos dois clientes — a mesma conta de marketplace está cadastrada duas vezes
- `SUFIXO_LEGADO_AUTOVALIDADO` **[FORTE]** entre #36 e #65 — "Mercadao enxovais 2" reduz ao radical "mercadao enxovais", que É o nome/slug do cliente #36 — sufixo confirmado por existir o original

---

### Cluster `alma` — **CONFIRMADO**

Radical comum: `alma`
Corroborado pela relação: **sim**
Ação: `PLAN_ONLY`

| id | slug | nome | score | contas | grants | bases | linhas ref. | papel |
|---|---|---|---|---|---|---|---|---|
| 39 | `alma` | Alma | 1419 | 1 | 1 | 2 | 12689 | **CANÔNICO** |
| 66 | `alma_2` | Alma 2 | 320 | 1 | 1 | 0 | 339 | alias |

**Evidências:**

- `SUFIXO_LEGADO_AUTOVALIDADO` **[FORTE]** entre #66 e #39 — "Alma 2" reduz ao radical "alma", que É o nome/slug do cliente #39 — sufixo confirmado por existir o original

---

### Cluster `dua_cosmeticos` — **CONFIRMADO**

Radical comum: `dua cosmeticos`
Corroborado pela relação: **sim**
Ação: `PLAN_ONLY`

| id | slug | nome | score | contas | grants | bases | linhas ref. | papel |
|---|---|---|---|---|---|---|---|---|
| 40 | `dua_cosmeticos` | Dua Cosmeticos | 1404 | 1 | 1 | 1 | 4352 | **CANÔNICO** |
| 67 | `dua_cosmeticos_2` | Dua Cosmeticos 2 | 264 | 1 | 1 | 0 | 4 | alias |

**Evidências:**

- `SUFIXO_LEGADO_AUTOVALIDADO` **[FORTE]** entre #67 e #40 — "Dua Cosmeticos 2" reduz ao radical "dua cosmeticos", que É o nome/slug do cliente #40 — sufixo confirmado por existir o original

---

### Cluster `maya` — **CONFIRMADO**

Radical comum: `maya`
Corroborado pela relação: **sim**
Ação: `PLAN_ONLY`

| id | slug | nome | score | contas | grants | bases | linhas ref. | papel |
|---|---|---|---|---|---|---|---|---|
| 55 | `maya` | Maya | 1269 | 1 | 1 | 0 | 2 | **CANÔNICO** |
| 71 | `maya_5` | maya 5 | 257 | 1 | 1 | 0 | 3 | alias |
| 68 | `maya_2` | maya 2 | 256 | 1 | 1 | 0 | 2 | alias |
| 69 | `maya_3` | maya 3 | 255 | 1 | 1 | 0 | 2 | alias |
| 70 | `maya_4` | maya 4 | 254 | 1 | 1 | 0 | 2 | alias |

**Evidências:**

- `SUFIXO_LEGADO_AUTOVALIDADO` **[FORTE]** entre #68 e #55 — "maya 2" reduz ao radical "maya", que É o nome/slug do cliente #55 — sufixo confirmado por existir o original
- `RADICAL_LEGADO_COMUM` **[FORTE]** entre #68 e #69 — ambos reduzem ao mesmo radical legado "maya"
- `RADICAL_LEGADO_COMUM` **[FORTE]** entre #68 e #70 — ambos reduzem ao mesmo radical legado "maya"
- `RADICAL_LEGADO_COMUM` **[FORTE]** entre #68 e #71 — ambos reduzem ao mesmo radical legado "maya"
- `SUFIXO_LEGADO_AUTOVALIDADO` **[FORTE]** entre #55 e #69 — "maya 3" reduz ao radical "maya", que É o nome/slug do cliente #55 — sufixo confirmado por existir o original
- `SUFIXO_LEGADO_AUTOVALIDADO` **[FORTE]** entre #55 e #70 — "maya 4" reduz ao radical "maya", que É o nome/slug do cliente #55 — sufixo confirmado por existir o original
- `SUFIXO_LEGADO_AUTOVALIDADO` **[FORTE]** entre #55 e #71 — "maya 5" reduz ao radical "maya", que É o nome/slug do cliente #55 — sufixo confirmado por existir o original

---

### Cluster `luli` — **CONFIRMADO**

Radical comum: `luli`
Corroborado pela relação: **não**
Ação: `PLAN_ONLY`

| id | slug | nome | score | contas | grants | bases | linhas ref. | papel |
|---|---|---|---|---|---|---|---|---|
| 58 | `luli` | Luli | 1215 | 0 | 1 | 0 | 5 | **CANÔNICO** |
| 82 | `luli_1` | Luli_1 | 177 | 0 | 1 | 0 | 1 | alias |

**Evidências:**

- `ML_USER_ID` **[CONFIRMADO]** entre #58 e #82 — mesmo ml_user_id 3310587126 marcado PRIMÁRIO nos dois clientes — a mesma conta de marketplace está cadastrada duas vezes
- `SUFIXO_LEGADO_AUTOVALIDADO` **[FORTE]** entre #58 e #82 — "Luli_1" reduz ao radical "luli", que É o nome/slug do cliente #58 — sufixo confirmado por existir o original

---

### Cluster `zorzaloja` — **FORTE**

Radical comum: _(nenhum — o cluster foi provado por chave natural, não por nome)_
Corroborado pela relação: **não**
Ação: `PLAN_ONLY`

| id | slug | nome | score | contas | grants | bases | linhas ref. | papel |
|---|---|---|---|---|---|---|---|---|
| 112 | `zorzaloja` | zorza.loja | 1241 | 1 | 1 | 1 | 3 | **CANÔNICO** |
| 121 | `zorza_shopee` | zorza_shopee | 1079 | 0 | 0 | 0 | 0 | alias |

**Evidências:**

- `SUFIXO_MARKETPLACE_CASCA_VAZIA` **[FORTE]** entre #121 e #112 — "zorza_shopee" é o cadastro legado do marketplace "shopee" de "zorza.loja" e não tem conta, grant, base nem linha referenciada — casca vazia

---

### Cluster `wmmodas` — **CONFIRMADO**

Radical comum: _(nenhum — o cluster foi provado por chave natural, não por nome)_
Corroborado pela relação: **não**
Ação: `PLAN_ONLY`

| id | slug | nome | score | contas | grants | bases | linhas ref. | papel |
|---|---|---|---|---|---|---|---|---|
| 123 | `wmmodas` | wm.modas | 1166 | 0 | 1 | 1 | 2 | **CANÔNICO** |
| 116 | `william_modas` | William Modas | 1143 | 0 | 1 | 0 | 1 | alias |

**Evidências:**

- `ML_USER_ID` **[CONFIRMADO]** entre #116 e #123 — mesmo ml_user_id 3589758095 marcado PRIMÁRIO nos dois clientes — a mesma conta de marketplace está cadastrada duas vezes

---

### Cluster `teste1` — **CONFIRMADO**

Radical comum: _(nenhum — o cluster foi provado por chave natural, não por nome)_
Corroborado pela relação: **não**
Ação: `PLAN_ONLY`

| id | slug | nome | score | contas | grants | bases | linhas ref. | papel |
|---|---|---|---|---|---|---|---|---|
| 126 | `teste1` | teste1 | 1267 | 2 | 1 | 0 | 5 | **CANÔNICO** |
| 127 | `teste2` | teste2 | 1197 | 1 | 1 | 0 | 2 | alias |
| 109 | `teste_01` | Teste 01 | 112 | 0 | 0 | 0 | 4 | alias |

**Evidências:**

- `EXTERNAL_ACCOUNT_ID` **[CONFIRMADO]** entre #109 e #126 — cliente_contas com o mesmo external_account_id 484819600 (meli) sob clientes distintos
- `EXTERNAL_ACCOUNT_ID` **[CONFIRMADO]** entre #109 e #127 — cliente_contas com o mesmo external_account_id 484819600 (meli) sob clientes distintos
- `ML_USER_ID` **[CONFIRMADO]** entre #126 e #127 — mesmo ml_user_id 484819600 marcado PRIMÁRIO nos dois clientes — a mesma conta de marketplace está cadastrada duas vezes

---

## ⛔ Pares explicitamente NÃO mergeados

### `GRANT_CRUZADO_DEFEITO` — clientes #102 `fenix_equipamentos1` × #105 `elizamarket`

**Confiança: `NAO_MERGEAR`**

ml_user_id 2661771367 aparece como grant SECUNDÁRIO em um cliente e PRIMÁRIO em outro, com nomes sem parentesco — assinatura de grant cruzado (defeito de dado), não de identidade

> **Por que isto importa mesmo sem consolidação:** os dois clientes vão para
> Squads diferentes. Se o grant cruzado permanecer, no dia do enforcement o
> Squad de um deles alcança a conta de marketplace do outro. Isso é **defeito de
> dado com consequência de acesso** — precisa ser resolvido no cadastro, não no
> mapeamento. Ver `16`.

