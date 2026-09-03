# 11 — Hardening T-2 · T-3 · T-4

> Os três bloqueadores foram resolvidos com **TDD estrito**: o teste que falha
> primeiro, a correção depois. Sem isso, nenhum dry-run contra produção seria
> confiável.

---

## T-3 — o dry-run **não era** read-only

### O defeito

`validarPlano()` e `auditoria()` chamavam `ensureSquadsTables(db)`, que lê os
arquivos de migration e **os executa**. Rodar o "dry-run" contra produção
**aplicava DDL em produção**. O mesmo valia para `--audit`, que existe
justamente para ser a leitura inofensiva.

### Prova RED — em teste

Um fake de `db` que registra toda query e reprova qualquer statement de
escrita. Detalhe que quase escondeu o problema: arquivos `.sql` começam com
comentário `--` e contêm vários statements, então olhar só o começo do texto
deixaria passar. O detector remove comentários dos dois estilos, quebra em
statements e testa a primeira palavra de cada um.

```
FALHOU: validarPlano zero-write não emite escrita
  (emitiu 2: -- FASE S — Fundação de Squads + Autoriz | -- FASE P2.4 — Responsabilidades de Clie)
```

### Prova RED — contra o banco de produção

Com a sessão forçada em `default_transaction_read_only=on`, o próprio Postgres
recusa. O caminho antigo:

```
RECUSADO pelo Postgres -> cannot execute CREATE TABLE in a read-only transaction
```

O caminho novo, no mesmo banco, na mesma guarda: **passa, sem tentar escrever**.

### A correção

`prepararSchemaSquads(db, { garantirSchema })` é o ponto único de decisão:

- `true` (default) → `ensureSquadsTables`, comportamento histórico preservado;
- `false` → `verificarSchemaSquads`, que só **pergunta** com `to_regclass`
  (SELECT puro) e devolve a lista de tabelas ausentes.

Schema ausente vira **erro explícito** — "rode a migração antes" — nunca criação
silenciosa. `squads-migrate.js` usa o modo zero-write em **todo** caminho que
não seja `--apply`. O default **não** foi invertido: inverter quebraria
chamadores existentes, e o zero-write é opt-in.

**Estado: RESOLVIDO.** `server/tests/squadsDryRunZeroWrite.test.js`, 23 verificações.

---

## T-2 — `ROLES_INTERNAS` divergente

### O defeito, e por que "consertar" seria pior

A constante existia em **7 lugares**, dois com valor diferente. Parecia bug.
Não era: são **duas perguntas diferentes**.

| pergunta | conjunto | inclui `admin`? |
|---|---|---|
| quem **PODE** ter membership? | `ROLES_ELEGIVEIS_MEMBERSHIP` | **sim** |
| de quem se **COBRA** membership? | `ROLES_COBRADAS_NA_AUDITORIA` | **não** |

Admin tem **bypass** de carteira. Se `admin` entrasse no conjunto **cobrado**,
`auditoria().pronto` exigiria que todo admin tivesse membership; como admin
naturalmente não tem, `semMembership` nunca zeraria e o rollout gate ficaria
**BLOQUEADO para sempre** — o enforcement nunca poderia ser ligado, mesmo com a
migração 100% correta.

**Unificar os dois conjuntos teria sido uma regressão grave, não uma limpeza.**

### A correção

`server/services/squads/rolesInternas.js` é a fonte canônica, com os **dois**
conjuntos nomeados e a diferença declarada em `DIVERGENCIA_INTENCIONAL` — uma
constante **testável**, para que qualquer "unificação" futura quebre o teste e
leia o porquê. Cada conjunto é exposto como `set` (para `.has()`) e `lista`
(para `$1::text[]`), porque os consumidores precisam das duas formas.

Os 5 consumidores importam de lá. E foi corrigido um oitavo caso que ainda não
estava catalogado: o **test double** em `squadsMigracaoImport.test.js` simulava a
query da **auditoria** usando a lista do **importador** (com `admin`) — inerte
hoje porque nenhuma fixture tem role admin, mas no dia em que tivesse, o double
e a produção discordariam em silêncio.

**Estado: RESOLVIDO.** `server/tests/squadsRolesInternas.test.js`, 24 verificações.

---

## T-4 — `auditoria().pronto` verdadeiro por vacuidade

### O defeito

`pronto` era a conjunção de sete contadores `=== 0`. Todos medem **defeito**.
Base vazia não tem defeito nenhum:

```
ANTES da correção, base 100% vazia -> pronto = true
```

`rolloutGateBoot` lê exatamente esse booleano. Num banco onde a migração nunca
aconteceu, o gate diria **LIBERADO** e o enforcement subiria com carteira
nenhuma — todo mundo sem acesso a nada.

### A correção

Contadores de **presença**, expostos em `vacuidade` para inspeção. O estado é
vácuo — e portanto `pronto = false` — se qualquer uma valer:

- 0 Squads ativos · 0 memberships ativas · 0 clientes ativos ·
  0 clientes ativos com Squad ativo · 0 usuários internos ativos.

A regra é **assimétrica de propósito**: vacuidade só transforma `true` em
`false`, nunca o contrário. Há teste de monotonicidade cobrindo os sete estados
que já reprovavam, mais o caso legítimo que precisa continuar liberando.

### Efeito imediato, no banco real

```json
"vacuidade": { "squadsAtivos": 0, "membershipsAtivas": 0, "clientesAtivos": 83,
               "clientesComSquadAtivo": 0, "internosAtivos": 26, "vazio": true,
               "motivos": ["nenhum Squad ativo","nenhuma membership ativa",
                           "nenhum Cliente ativo com Squad ativo"] }
```

O gate hoje reprova por **dois** motivos independentes — os defeitos (83
clientes sem Squad, 26 internos sem membership) **e** a vacuidade. Antes, só o
primeiro. Numa base recém-criada, só o segundo existiria — e era exatamente o
caso que passava.

**Estado: RESOLVIDO.** `server/tests/squadsAuditoriaVacuidade.test.js`, 27 verificações.

---

## Resumo

| bloqueador | estado | teste | verificações |
|---|---|---|---|
| T-2 · roles divergentes | **RESOLVIDO** | `squadsRolesInternas.test.js` | 24 |
| T-3 · dry-run com DDL | **RESOLVIDO** (provado contra produção) | `squadsDryRunZeroWrite.test.js` | 23 |
| T-4 · gate por vacuidade | **RESOLVIDO** | `squadsAuditoriaVacuidade.test.js` | 27 |

Suíte completa do backend: **179 arquivos verdes**, zero regressão, com os 4
vermelhos pré-existentes (`basesTiktok`, `designStudioWorkspace`,
`designTemplateEngine`, `mlTokenService`) em `TEST_SKIP`.

