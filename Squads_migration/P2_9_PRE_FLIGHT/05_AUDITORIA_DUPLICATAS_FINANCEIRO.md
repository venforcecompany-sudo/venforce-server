# 05 — Auditoria de duplicatas financeiras (D4)

> O Release Candidate deixou a migration
> `server/sql/migrations/20260828_entregas_cliente_unicidade_p26.sql`
> **deliberadamente NÃO auto-aplicada**: criar o índice único numa base que já
> tem duplicatas **falha**, e escolher qual duplicata sobrevive é decisão
> **humana** sobre dado real de cliente.
>
> Enquanto o índice não existe, a garantia é dada na aplicação
> (`encontrarEntregaDaCompetencia` → `409 ENTREGA_JA_EXISTE`). O índice é a rede
> contra escrita concorrente, não a regra primária.
>
> **Este documento só produz relatório. NÃO deletar nada.**

---

## 1. O índice que se quer criar

```sql
CREATE UNIQUE INDEX uq_entregas_fechamento_competencia
  ON entregas_cliente (cliente_id, COALESCE(cliente_conta_id, 0), periodo)
  WHERE tipo = 'fechamento_mensal' AND periodo IS NOT NULL AND cliente_id IS NOT NULL;
```

Chave de unicidade: **(cliente, operação, competência)**. `COALESCE(...,0)`
porque `NULL` nunca conflita com `NULL` em Postgres — sem isso, N entregas
legadas sem operação do mesmo mês continuariam passando.

**Importante:** o índice compara `periodo` **cru** (texto). `entregas_cliente.periodo`
é texto livre ("Maio 2026", "2026-05", "2026-07 a 2026-08", `NULL`, …). A
canonização de P2.6 é só no **caminho de leitura** (`GET /financeiro`), não no
valor gravado. Portanto:
- o índice só bloqueia duplicatas com `periodo` **textualmente idêntico**;
- a auditoria abaixo roda em **dois modos**: (a) cru — o que o índice enxerga;
  (b) canônico — o que um humano consideraria o mesmo mês.

---

## 2. Como rodar

```bash
psql "$DATABASE_URL" -f Squads_migration/P2_9_PRE_FLIGHT/queries/d4_duplicatas_fechamento.sql \
  | tee p2-9-d4-duplicatas.txt
psql "$DATABASE_URL" -f Squads_migration/P2_9_PRE_FLIGHT/queries/d4_classificacao.sql \
  | tee p2-9-d4-classificacao.txt
```

Só leitura. Rodar em réplica / usuário readonly se possível.

---

## 3. Classificação (a saída de `d4_classificacao.sql`)

| Classe | Definição | O que fazer |
|---|---|---|
| **A** | Nenhum grupo `(cliente, conta, periodo)` com `COUNT(*) > 1` (modo cru) | **Índice é seguro de aplicar.** Registrar a evidência (a query volta vazia). Aplicar `20260828_entregas_cliente_unicidade_p26.sql` **no passo de migração de P2.9**, não antes. |
| **B** | Grupos duplicados onde **nenhuma** entrega está `publicado = true` | Baixo risco: nenhum link público circulou. Decisão humana simples (manter a mais recente). **Não** deletar automaticamente — a operação confirma qual fica; só então o índice pode ser criado. |
| **C** | Grupos com **exatamente 1** entrega `publicado = true` + outras não publicadas | Provável estado "rascunhos + a versão final publicada". Decisão humana: a publicada é a canônica? As não publicadas podem ser encerradas? |
| **D** | Grupos com **2+** entregas `publicado = true` | **BLOQUEIA o passo do índice.** Dois links públicos do mesmo mês circulando — escolher qual sobrevive é escolher qual número o cliente já viu. **Só o dono do dado decide.** Levar cada caso D para a gestão, individualmente, com os `id`s e as datas. |

**A classificação NÃO bloqueia o enforcement de Squads** — o enforcement é
sobre carteira, não sobre entregas. Ela bloqueia apenas a criação do índice
único D4, que é um passo independente e opcional do rollout (a guarda de
aplicação `409 ENTREGA_JA_EXISTE` funciona sem ele).

Recomendação: tratar A/B/C antes do canário (limpa a base), e resolver D
caso a caso — mas **não** deixar D atrasar o rollout de Squads se a gestão
preferir adiar a decisão das entregas.

---

## 4. Saída esperada em produção

Não sabemos — `PENDENTE_HUMANO` até rodar. O RELEASE CANDIDATE §10 registra que
`GET /financeiro` hoje lê só as ~24 entregas mais recentes e que
`entregas_cliente.periodo` como texto livre torna um filtro SQL não confiável —
o que sugere que competências antigas com formato legado ("Maio 2026") são
comuns. Esperar que o **modo canônico** encontre mais grupos que o **modo cru**.

---

## 5. Registro (preencher após rodar)

```
D4 AUDITORIA — data: ____________  base: ____________ (prod-readonly | staging)

grupos duplicados (modo cru):        ____
grupos duplicados (modo canônico):   ____
classe A?  ____  (sim = índice seguro)
classe B (não publicadas):           ____ grupos
classe C (1 publicada):              ____ grupos
classe D (2+ publicadas):            ____ grupos   <-- cada um vai para a gestão

Decisão da gestão sobre D:  PENDENTE_HUMANO
Índice D4 pode ser aplicado?  SIM / NÃO / ADIADO
```
