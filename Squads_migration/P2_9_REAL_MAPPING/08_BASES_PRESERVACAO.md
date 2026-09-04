# 08 — Preservação de Bases

> **Não unir Bases só porque os Clientes foram unidos.** Uma empresa com várias
> contas pode ter uma Base **por conta** ou uma Base **client-level legada**. A
> semântica real tem de ser preservada.

## Classificação dos 45 vínculos

| classe | quantidade | significado |
|---|---|---|
| `ACCOUNT_EXACT` | 25 | `cliente_conta_id` preenchido — o vínculo é **de uma conta** |
| `CLIENT_LEVEL_LEGACY` | 20 | `cliente_conta_id` NULL — vale para **o cliente inteiro** |

**A diferença é operacionalmente perigosa na consolidação.** Um vínculo
`ACCOUNT_EXACT` segue a conta e mantém o alcance. Um vínculo
`CLIENT_LEVEL_LEGACY`, ao ser movido para um canônico que passa a ter **várias**
contas, **amplia o alcance**: uma Base que valia para uma operação passa a valer
para todas. Isso não é preservar semântica, é mudá-la em silêncio.

---

## Vínculos afetados pela consolidação

| vínculo | base | de cliente | para cliente | conta | mkt | classe | risco |
|---|---|---|---|---|---|---|---|
| #37 | `influencia_2` | #60 `influencia_jeans_2` | #15 `influencia_jeans` | #24 | meli | ACCOUNT_EXACT | preserva |
| #54 | `influ2` | #60 `influencia_jeans_2` | #15 `influencia_jeans` | #24 | meli | ACCOUNT_EXACT | preserva |

---

## Armadilha real encontrada no cadastro

O slug da Base **não** indica o dono. Dois exemplos verificados no banco:

| vínculo | slug da base | cliente real |
|---|---|---|
| #57 | `wbs1_-_custos_agosto` | #52 `tenda_medieval` — **não é a WBS** |
| #5 | `alma_2` | #39 `alma` — **não é o Alma 2** |

Qualquer heurística que casasse cliente por nome de Base produziria erro aqui.
É por isso que a camada `L6_EVIDENCIA_DE_BASE` do casamento exige **um único
candidato** e só é consultada depois de todas as camadas mais estritas.

---

## Bases ausentes

**34** clientes ativos com conta ativa **não têm nenhum vínculo de Base ativo**. Isso não bloqueia o mapeamento (Squad é do Cliente, não da Base), mas significa que os módulos que dependem de Base não funcionam para eles hoje — independentemente de Squad.

