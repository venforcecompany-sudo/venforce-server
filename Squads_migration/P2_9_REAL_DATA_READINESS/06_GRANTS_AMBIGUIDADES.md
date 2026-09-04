# 06 — Grants: auditoria e ambiguidades

> **BLOCO F.** Auditoria possível **sem Squad**. Nada é corrigido, nenhum
> backfill é feito. Só classificação e lista de casos ambíguos.

---

## 1. O que é um "Grant" neste código (definição objetiva)

**Um Grant = uma linha de `ml_tokens`** — uma concessão OAuth do Mercado Livre
para uma conta de vendedor. Isso não é interpretação: é o vocabulário do próprio
código.

| Evidência | Onde |
|---|---|
| `findGrantById`, `listGrantsByCliente`, `setPrimaryGrant`, `resolveMlGrant`, `isGrantUsable`, `sanitizedGrant` | `server/services/mlTokenService.js:132,143,158,208,54,60` |
| coluna FK chamada `grant_id` apontando para `ml_tokens` | `server/sql/central_vendas_schema.sql:102` |

**Não existe Grant de Google, nem tabela genérica de permissões.** E
**não existe Grant de Shopee** — não há tabela de tokens Shopee no repositório.
Grant é exclusivamente um conceito Mercado Livre.

### Colunas relevantes de `ml_tokens`

Montadas a partir da criação (`server/index.js:581-589`) + migrações aditivas:

| Coluna | Origem | Papel na auditoria |
|---|---|---|
| `id`, `ml_user_id` | base | identidade |
| `cliente_id` | `server/index.js:727` | dono legado (nível cliente) |
| **`cliente_conta_id`** | `20260817_cliente_contas_foundation.sql:78-81` — **NULLABLE** | **o eixo da ambiguidade** |
| `is_primary` | `20260806_ml_tokens_primary_refresh_safety.sql` | desempate legado |
| `token_status` | idem | `revoked`/`blocked`/`invalid` ⇒ inutilizável |
| `refresh_failures`, `expires_at` | idem | saúde |

Índice relevante: `ml_tokens_one_primary_per_cliente` — `UNIQUE (cliente_id) WHERE is_primary = true`.

> **A auditoria nunca lê `access_token` nem `refresh_token`.** O extrator não os
> seleciona, e há teste estático provando isso
> (`server/tests/squadsInventarioReadonly.test.js` §6).

---

## 2. Classificação (BLOCO F)

| Classe | Regra | Gravidade |
|---|---|---|
| **EXATO** | `cliente_conta_id IS NOT NULL` | ✅ nenhuma |
| **LEGADO_SINGLE_ACCOUNT** | `cliente_conta_id IS NULL` **e** o cliente tem **exatamente 1** conta `meli` ativa | 🟨 resolúvel sem decisão humana |
| **AMBÍGUO** | `cliente_conta_id IS NULL` **e** o cliente tem **2+** contas `meli` ativas | 🟥 **exige decisão humana** |
| **DESCONECTADO** | `token_status ∈ {revoked, blocked, invalid}` | 🟥 conta sem acesso real ao ML |

Precedência implementada: `DESCONECTADO` vence `EXATO` — um token revogado é
inútil mesmo com a conta resolvida.

Implementação: `classificarGrants()` em `server/sql/squads-inventario-readonly.js`.
Testes: `server/tests/squadsInventarioReadonly.test.js` §1 (6 verificações).

---

## 3. Por que "AMBÍGUO" é o caso perigoso (com o código que o produz)

Quando não há conta explícita e há 2+ grants utilizáveis sem `is_primary`,
`resolveMlGrant()` (`mlTokenService.js:250-276`) ordena por
`is_primary DESC, updated_at DESC, id DESC` e **escolhe `usable[0]`** —
uma escolha **arbitrária** —, loga `ml_grant_primary_missing` e **persiste**
essa escolha como o novo primário.

Ou seja: a ambiguidade **não fica parada esperando**; ela se resolve sozinha,
pela ordem de atualização, e vira estado permanente. É por isso que a lista de
casos `AMBÍGUO` importa **antes** do rollout: depois, alguém já escolheu — e
pode ter sido a conta errada.

Na camada de ClienteConta o mesmo formato aparece como **409
`MULTIPLE_MARKETPLACE_ACCOUNTS`** (`clienteContaService.js:283-288`, `:726-730`),
que é o comportamento **correto e explícito** — falha em vez de adivinhar.

---

## 4. Query e saída

```sql
SELECT id, cliente_id, cliente_conta_id, ml_user_id, is_primary,
       token_status, refresh_failures, (expires_at < NOW()) AS expirado
  FROM ml_tokens
 ORDER BY cliente_id ASC, id ASC;
```

Saída no inventário (`resumo.grants`):

```json
{
  "EXATO": 0, "LEGADO_SINGLE_ACCOUNT": 0, "AMBIGUO": 0, "DESCONECTADO": 0,
  "casos": [ { "grant_id": 0, "cliente_id": 0, "ml_user_id": "...", "classe": "AMBIGUO" } ]
}
```

Só `AMBIGUO` e `DESCONECTADO` entram em `casos` — são os que exigem olho humano.

---

## 5. Estado

| | |
|---|---|
| **Grants auditados** | **0** — `REQUER BANCO` (**T-1**) |
| **Classificador** | **PRONTO e testado** |
| **Algum grant corrigido?** | **NÃO** |
| **Algum backfill feito?** | **NÃO** |
| **Relação com Squad** | **nenhuma** — este bloco não precisa da relação humana |

Complemento importante: `cliente_contas_pendencias` já contém ambiguidades
**registradas pelo próprio sistema** desde o backfill de 2026-08-17, com
`tipo = 'ml_user_id_duplicado_entre_clientes'`. O extrator lê as não resolvidas
— podem ser a lista mais rápida de casos reais.
