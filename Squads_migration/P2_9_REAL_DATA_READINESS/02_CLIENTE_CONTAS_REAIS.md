# 02 — Inventário de ClienteContas

> **BLOCO B.** Inventário e classificação das contas. **Independe totalmente do
> Squad** — pôde ser totalmente especificado, e será totalmente executado assim
> que houver banco.

---

## 1. Estado

| | |
|---|---|
| **Contas inventariadas** | **0** — `REQUER BANCO` (bloqueador **T-1**) |
| **Extração + classificação prontas?** | **SIM**, testadas com fixtures |
| **Cobertura anterior** | **Nenhuma** — este era um **gap real** do pacote P2.9 PRE-FLIGHT |

> `P2_9_PRE_FLIGHT/queries/01_inventario.sql` só produzia **agregados**
> (`STRING_AGG(marketplace||':'||slug)`, contagens). Nenhuma query existente
> devolvia as linhas de `cliente_contas` com `id`, `external_account_id` e
> `is_primary`. Este documento e o extrator fecham essa lacuna.

---

## 2. Modelo confirmado

`server/sql/migrations/20260817_cliente_contas_foundation.sql:24-59`:

```sql
CREATE TABLE IF NOT EXISTS cliente_contas (
  id SERIAL PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  nome TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  external_account_id TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  ativo BOOLEAN NOT NULL DEFAULT true,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE cliente_contas
  ADD CONSTRAINT cliente_contas_marketplace_check
  CHECK (marketplace IN ('meli', 'shopee'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_cliente_contas_primary_por_marketplace
  ON cliente_contas (cliente_id, marketplace)
  WHERE is_primary = true AND ativo = true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cliente_contas_external_account
  ON cliente_contas (cliente_id, marketplace, external_account_id)
  WHERE external_account_id IS NOT NULL;
```

Dois pontos que mudam como a auditoria deve ser lida:

1. **Não existe coluna `ml_user_id` / `seller_id` / `shop_id`.** O identificador
   externo é genérico: **`external_account_id TEXT`** (nullable). Para `meli`
   ele guarda o `ml_user_id`.
2. **`marketplace` só aceita `'meli'` e `'shopee'`.** **TikTok não existe** em
   `cliente_contas` — segue 100% no fluxo legado. Isso é decisão de produto
   registrada em `VENFORCE_V3_FINAL_CONVERGENCE_CLOSURE.md:113`, não um bug.

---

## 3. Query do inventário

```sql
SELECT id, cliente_id, marketplace, nome, slug, external_account_id,
       is_primary, ativo, created_at
  FROM cliente_contas
 ORDER BY cliente_id ASC, marketplace ASC, id ASC;
```

Mapeamento direto para o que o BLOCO B pede:

| Campo pedido | Coluna |
|---|---|
| id · cliente_id · marketplace | idem |
| seller / mlUserId | **`external_account_id`** |
| ativo · is_primary | idem |
| Grant resolvido? | cruzamento com `grants` → `06_GRANTS_AMBIGUIDADES.md` |
| Base resolvida? | cruzamento com `base_vinculos` → `07_BASES_AMBIGUIDADES.md` |
| ambiguidade? · vínculo legado? | classificação §4 |

---

## 4. Classificação exigida pelo BLOCO B

Calculada por funções puras (`classificarGrants` / `classificarBases`) sobre o
inventário — sem banco, testadas em `server/tests/squadsInventarioReadonly.test.js`.

| Classe | Definição operacional |
|---|---|
| **OK** | conta ativa, com Grant `EXATO` e Base `EXATA` |
| **SEM_GRANT** | conta `meli` ativa sem nenhuma linha em `ml_tokens` apontando para ela |
| **GRANT_AMBIGUO** | Grant com `cliente_conta_id IS NULL` e o cliente tem **2+** contas `meli` ativas |
| **GRANT_DESCONECTADO** | `token_status ∈ {revoked, blocked, invalid}` |
| **SEM_BASE** | cliente ativo com conta ativa e **nenhum** vínculo ativo em `base_cliente_vinculos` |
| **BASE_AMBIGUA** | vínculo com `cliente_conta_id IS NULL` e o cliente tem **2+** contas ativas naquele marketplace |
| **VINCULO_LEGADO** | Grant ou Base com `cliente_conta_id IS NULL` e o cliente tem **exatamente 1** conta ativa daquele marketplace — resolúvel sem ambiguidade |
| **CONTA_INATIVA** | `ativo = false` |

> **Shopee não tem Grant.** Não existe tabela de tokens Shopee no repositório.
> Portanto `SEM_GRANT` só faz sentido para `meli` — aplicar a classe a uma conta
> Shopee seria um falso positivo. O extrator respeita isso (a classificação de
> Grant só percorre `ml_tokens`, que é exclusivamente ML).

---

## 5. Fonte de ambiguidade que o próprio sistema já registra

`cliente_contas_pendencias` (mesma migração, linhas 65-71) é a tabela em que o
sistema **grava sozinho** os casos que não conseguiu resolver:

```sql
CREATE TABLE IF NOT EXISTS cliente_contas_pendencias (
  id SERIAL PRIMARY KEY, tipo TEXT, detalhes JSONB,
  resolvido BOOLEAN, created_at TIMESTAMP
);
```

Tipos observados no código: `'ml_user_id_duplicado_entre_clientes'` (linha 100)
e `'base_vinculo_ambiguo'` (linha 213).

O extrator lê as pendências **não resolvidas**. Isso é valioso: são
ambiguidades **já detectadas e registradas** pelo backfill de 2026-08-17,
esperando decisão humana desde então.

```sql
SELECT id, tipo, resolvido, created_at
  FROM cliente_contas_pendencias
 WHERE resolvido = false ORDER BY id ASC;
```

---

## 6. Relação com o Squad

**Nenhuma.** O vínculo de Squad é do **Cliente**, nunca da ClienteConta —
`P2_9_PRE_FLIGHT/01_DADOS_HUMANOS_NECESSARIOS.md:24`: *"ML1 e ML2 de um cliente
não podem ficar em Squads diferentes."*

Portanto este bloco inteiro é **100% executável sem a relação humana** e não
produz nenhum campo `squad`.
