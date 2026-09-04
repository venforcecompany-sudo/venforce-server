# 07 — Preservação de Grants

> **A regra mais importante da consolidação: NÃO PERDER GRANT.**
> Nenhum Grant pode sumir, trocar de seller, trocar de marketplace, trocar de
> conta, ser sobrescrito ou virar principal por acidente.

## Contagem

|  | quantidade |
|---|---|
| Grants no banco (total) | **63** |
| …de clientes canônicos (não se movem) | 50 |
| …de aliases (endereçados pelo plano) | **13** |
| **Grants perdidos** | **0** |
| Grants sem conta de destino | **3** |

- **I1** ✅ nenhum Grant some — grants de alias no banco=13 · grants endereçados no plano=13 · total no banco=63
- **I2** ✅ nenhum Grant troca de seller/conta — grants reapontados sem conta de mesmo ml_user_id: 0
- **I3** ✅ nenhuma conta muda de marketplace — contas movidas sem marketplace preservado: 0

---

## A regra de destino

Um Grant **nunca** é reapontado para uma conta que não seja a dele. O destino é
determinado pela **chave natural**: a `ClienteConta` cujo `external_account_id`
é o **mesmo `ml_user_id`** do Grant. Nunca por `is_primary`, nunca por ordem,
nunca por "a conta principal do cliente".

| ação | significado |
|---|---|
| `REAPONTAR_PARA_CONTA_EXISTENTE` | já existe, sob o canônico, uma conta com o mesmo `ml_user_id` — o Grant passa a apontar para ela |
| `SEGUE_A_CONTA_MOVIDA` | a conta do alias é movida para o canônico e o Grant vai junto, sem trocar de conta |
| `SEM_CONTA_CORRESPONDENTE` | **bloqueante** — não existe `ClienteConta` para esse `ml_user_id` em lugar nenhum |

> **`is_primary` tem de ser RECALCULADO sob o canônico, nunca herdado.** Dois
> aliases com grant primário viram, ao serem unidos, dois primários no mesmo
> cliente — exatamente o defeito que o índice parcial único existe para impedir.

---

## Matriz Grant → destino

| grant | cliente atual | ml_user_id | conta atual | cliente canônico | conta destino | ação |
|---|---|---|---|---|---|---|
| #6 | #60 `influencia_jeans_2` | 2650889738 | #24 | #15 `influencia_jeans` | `conta-movida:24` | SEGUE_A_CONTA_MOVIDA |
| #88 | #62 `wbs_2` | 710361722 | #25 | #32 `wbs_medical` | `conta-movida:25` | SEGUE_A_CONTA_MOVIDA |
| #52 | #65 `mercadao_enxovais_2` | 8682183 | **NULL** | #36 `mercadao_enxovais` | **—** | **SEM_CONTA_CORRESPONDENTE** |
| #103 | #65 `mercadao_enxovais_2` | 159560107 | #71 | #36 `mercadao_enxovais` | `conta-movida:71` | SEGUE_A_CONTA_MOVIDA |
| #46 | #66 `alma_2` | 2568436888 | #26 | #39 `alma` | `conta-movida:26` | SEGUE_A_CONTA_MOVIDA |
| #18 | #67 `dua_cosmeticos_2` | 636985802 | #27 | #40 `dua_cosmeticos` | `conta-movida:27` | SEGUE_A_CONTA_MOVIDA |
| #14 | #71 `maya_5` | 47597550 | #31 | #55 `maya` | `conta-movida:31` | SEGUE_A_CONTA_MOVIDA |
| #11 | #68 `maya_2` | 1078206002 | #28 | #55 `maya` | `conta-movida:28` | SEGUE_A_CONTA_MOVIDA |
| #12 | #69 `maya_3` | 606717549 | #29 | #55 `maya` | `conta-movida:29` | SEGUE_A_CONTA_MOVIDA |
| #13 | #70 `maya_4` | 450256632 | #30 | #55 `maya` | `conta-movida:30` | SEGUE_A_CONTA_MOVIDA |
| #47 | #82 `luli_1` | 3310587126 | **NULL** | #58 `luli` | **—** | **SEM_CONTA_CORRESPONDENTE** |
| #85 | #116 `william_modas` | 3589758095 | **NULL** | #123 `wmmodas` | **—** | **SEM_CONTA_CORRESPONDENTE** |
| #105 | #127 `teste2` | 484819600 | #74 | #126 `teste1` | `68` | REAPONTAR_PARA_CONTA_EXISTENTE |


### ⛔ Grants bloqueantes

- **Grant #52** (`ml_user_id` 8682183, cliente #65) — grant 52 (ml_user_id 8682183) não tem ClienteConta correspondente em lugar nenhum — precisa que a conta seja CRIADA a partir do dado real antes de qualquer movimento
- **Grant #47** (`ml_user_id` 3310587126, cliente #82) — grant 47 (ml_user_id 3310587126) não tem ClienteConta correspondente em lugar nenhum — precisa que a conta seja CRIADA a partir do dado real antes de qualquer movimento
- **Grant #85** (`ml_user_id` 3589758095, cliente #116) — grant 85 (ml_user_id 3589758095) não tem ClienteConta correspondente em lugar nenhum — precisa que a conta seja CRIADA a partir do dado real antes de qualquer movimento

Estes Grants são **legado client-level**: foram criados antes da entidade
`ClienteConta` e nunca foram associados a uma conta. Consolidar sem antes
criar a `ClienteConta` correspondente **a partir do dado real que já existe**
deixaria o Grant apontando para um cliente que passou a ter várias contas — e
aí não haveria como saber a qual operação ele pertence.

Criar essa `ClienteConta` **não é criar Cliente**: é normalizar operação
existente. Mas **não foi aplicado** nesta missão.


---

## Grants que NÃO se movem

Os 50 Grants restantes pertencem a clientes canônicos
e **não são tocados por nenhuma operação deste plano**. Continuam exatamente
onde estão, com o mesmo `cliente_conta_id`, o mesmo `ml_user_id` e o mesmo
`is_primary`.

> Nenhum valor de `access_token` ou `refresh_token` foi lido, em nenhum
> momento. A ferramenta de inventário seleciona colunas nominalmente e a de
> consolidação **recusa** ler colunas sensíveis por lista de bloqueio.

