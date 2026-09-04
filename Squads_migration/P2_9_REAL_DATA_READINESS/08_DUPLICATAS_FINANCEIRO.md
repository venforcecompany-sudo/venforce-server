# 08 — Duplicatas financeiras D4

> **BLOCO H.** Auditoria **estritamente read-only** de `entregas_cliente`
> tipo `fechamento_mensal`. **Nada é apagado. Nenhum UNIQUE é aplicado.
> Nada é resolvido.**

---

## 1. Estado

| | |
|---|---|
| **Duplicatas auditadas** | **0 grupos** — `REQUER BANCO` (bloqueador **T-1**) |
| **Query + classificador** | **PRONTOS e testados** |
| **Índice único D4 aplicado?** | **NÃO** — e continua não devendo ser, até auditoria humana |
| **Algo apagado?** | **NÃO** |

Este bloco **não depende do Squad** — poderia estar 100% concluído hoje se
houvesse acesso de leitura ao banco. É o item **10** da matriz GO/NO-GO.

---

## 2. O modelo e a regra de unicidade

`entregas_cliente` — DDL canônico em
`server/services/schema/schemaEnsure.js:61-111` (`ENTREGAS_CLIENTE_DDL`,
aplicado idempotentemente no boot).

Colunas que definem a competência:

| Coluna | Tipo | Observação |
|---|---|---|
| `tipo` | `VARCHAR(50) NOT NULL` | **sem CHECK no banco**; valores válidos só em código (`TIPOS_PERMITIDOS`, `entregasClienteService.js:6-11`). `'fechamento_mensal'` é o **único** tipo com competência única |
| `cliente_id` | `INTEGER` nullable | |
| **`cliente_conta_id`** | `INTEGER` **NULLABLE** | entregas antigas são `NULL` — e isso *é a verdade sobre elas*; a migração proíbe backfill retroativo |
| `periodo` | `VARCHAR(100)` nullable | **texto livre** — origem do modo "canônico" abaixo |
| `publicado` | `BOOLEAN DEFAULT FALSE` | **é a coluna que significa "publicada"** (o gate de leitura pública filtra por ela, não por `status`) |
| `status` | `VARCHAR(30) DEFAULT 'rascunho'` | move junto com `publicado`, mas não é o gate |

---

## 3. O índice único **não existe** — e isso é deliberado

`server/sql/migrations/20260828_entregas_cliente_unicidade_p26.sql` define:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_entregas_fechamento_competencia
  ON entregas_cliente (cliente_id, COALESCE(cliente_conta_id, 0), periodo)
  WHERE tipo = 'fechamento_mensal' AND periodo IS NOT NULL AND cliente_id IS NOT NULL;
```

Mas **nada o aplica automaticamente**, por três travas independentes:

1. não está em `migrationFiles` de `squadsRepository.js`;
2. não está em `ENTREGAS_CLIENTE_DDL` de `schemaEnsure.js` (comentário explícito, linhas 41-46);
3. está catalogado em `MIGRATIONS_INVENTARIO` como `auto: false, runner: null, risco: "ALTO"`.

Existe teste que **fixa esse invariante estaticamente**
(`server/tests/schemaEnsureEntregasCliente.test.js`).

> **O `COALESCE(cliente_conta_id, 0)` é essencial:** em Postgres `NULL` nunca
> colide com `NULL`. Sem ele, N entregas legadas do mesmo mês passariam pelo
> índice sem conflito.

**Enquanto o índice não existe**, a unicidade é garantida **só na aplicação**:
`encontrarEntregaDaCompetencia()` (`entregasClienteService.js:203-221`) faz um
`SELECT … LIMIT 1` antes do insert e devolve **409 `ENTREGA_JA_EXISTE`**.
É uma guarda sujeita a corrida — a rede de segurança contra escrita concorrente
é justamente o índice que ainda não existe.

---

## 4. Query de auditoria (agrupamento exigido pelo BLOCO H)

```sql
SELECT cliente_id, cliente_conta_id, periodo,
       COUNT(*)::int                          AS total,
       COUNT(*) FILTER (WHERE publicado)::int AS publicadas,
       ARRAY_AGG(id ORDER BY created_at DESC) AS ids
  FROM entregas_cliente
 WHERE tipo = 'fechamento_mensal'
   AND periodo IS NOT NULL
   AND cliente_id IS NOT NULL
 GROUP BY cliente_id, cliente_conta_id, periodo
HAVING COUNT(*) > 1
 ORDER BY COUNT(*) DESC;
```

> ⚠️ **Este é o modo "cru".** Como `periodo` é texto livre, ele **não** casa
> `"Maio 2026"` com `"2026-05"`. O pacote anterior já resolveu isso com um modo
> **canônico** que normaliza o período por regex —
> `P2_9_PRE_FLIGHT/queries/d4_duplicatas_fechamento.sql`, SELECT 2. **Rode os
> dois:** o cru é o que o índice enxergaria; o canônico é o que a operação
> enxerga. A diferença entre eles é, ela mesma, um achado.

---

## 5. Classificação A / B / C / D

| Classe | Regra | O que significa | Ação |
|---|---|---|---|
| **A** | nenhum grupo duplicado | base limpa | índice D4 pode ser aplicado com segurança |
| **B** | duplicatas, **0** publicadas | rascunhos repetidos | saneamento de baixo risco |
| **C** | duplicatas, **exatamente 1** publicada | uma verdade oficial + rascunhos | saneamento de baixo risco |
| **D** | duplicatas, **2+** publicadas | 🟥 **dois links públicos do mesmo mês circularam** | **decisão exclusiva do dono do dado** |

A classe **D** é a única que trava o índice, e a própria migração explica por
quê: *"sanear isso é escolher qual número o cliente viu, e ninguém além do dono
do dado pode decidir."*

Implementação: `classificarD4()`.
Testes: `server/tests/squadsInventarioReadonly.test.js` §3 (4 verificações).

---

## 6. Relação com o rollout de Squads

**Nenhuma direta.** D4 é item **10** da matriz GO/NO-GO e está marcado
"NÃO bloqueante para o enforcement; SIM para o índice D4" (risco **R10**).

Ligar `SQUADS_ENFORCEMENT` não cria nem agrava duplicata. Mas a auditoria deve
ser feita **antes do canário** por um motivo de observabilidade: se um
observador do canário topar com dois fechamentos do mesmo mês, precisa saber
que é dívida pré-existente e **não** regressão de Squads.

O mesmo vale para os riscos **R2** (timezone) e **R5** (`despublicarEntrega`
não rotaciona `token_publico`): **comunicar ao time de fechamento antes do
canário.**

---

## 7. O que NÃO foi feito

- ❌ Nenhuma entrega foi apagada.
- ❌ O índice `uq_entregas_fechamento_competencia` **não** foi criado.
- ❌ Nenhuma duplicata foi resolvida ou despublicada.
- ❌ Nenhuma consulta foi executada (sem banco).
