# 14 — O que falta, e o que fazer quando a relação chegar

> **ESTE É O ARQUIVO DE HANDOFF.** Se você só vai ler um documento desta pasta,
> leia este.

---

## 1. Estado em uma tela

```
ESTRUTURA TÉCNICA:            PRONTA
6 SQUADS:                     CONFIRMADOS (como fato de produto)
GESTORES:                     0/6 confirmados documentalmente
                              ↳ a operação os conhece; o repositório não.
                                Nada foi inventado.

CLIENTES INVENTARIADOS:       0 / N   ← bloqueado por falta de acesso ao banco
CONTAS INVENTARIADAS:         0       ← idem
USUÁRIOS INVENTARIADOS:       0       ← idem
                              ↳ a MÁQUINA de inventário está pronta e testada.
                                É 1 comando quando houver DATABASE_URL.

SCHEMA DE SQUADS:             EXISTE (DDL canônico, aplicado no boot)
SQUADS REAIS NO BANCO:        0 (esperado — a confirmar)
MEMBERSHIPS REAIS:            0 (esperado — a confirmar)
CLIENTES JÁ VINCULADOS:       0 (esperado — a confirmar)

GRANTS:                       classificador PRONTO · 0 auditados (sem banco)
BASES:                        classificador PRONTO · 0 auditados (sem banco)
DUPLICATAS D4:                query + classificador PRONTOS · 0 auditadas (sem banco)
RESPONSABILIDADES:            query PRONTA (inclui histórico) · 0 auditadas

MAPA PRÉ-PREENCHIDO:          PRONTO (gerador automático a partir do inventário)
VALIDADOR DA RELAÇÃO:         PRONTO — 74 verificações verdes

SQUADS_ENFORCEMENT:           OFF
BANCO ALTERADO:               NÃO
MIGRAÇÃO EXECUTADA:           NÃO
```

---

## 2. Falta receber (a fronteira desta missão)

1. **Relação Cliente → Squad** — qual Cliente pertence a qual Squad.
2. **Relação demais membros → Squad** — quem participa de qual Squad.
3. **Squad principal**, quando um usuário estiver em mais de um Squad.
4. **Nome oficial de cada um dos 6 Squads.**
5. **Identidade dos 6 Gestores** (email ou id).

Itens 4 e 5 são conhecidos pela operação, mas não constam de nenhuma fonte
confiável no repositório — por isso ficaram `PENDENTE_*` em vez de adivinhados.

---

## 3. Falta destravar (independe da relação — pode ser feito **hoje, em paralelo**)

| # | Bloqueador | Quem destrava | Custo |
|---|---|---|---|
| **T-1** | `DATABASE_URL` de leitura ausente neste ambiente | quem tem o Render | 1 variável de ambiente |
| **T-5** | `JWT_SECRET` de produção não confirmado (item 2 do GO/NO-GO) | quem tem o Render | conferência + risco R9 (invalida sessões) |
| **T-6** | deploy da `main` atual + smoke (item 3) | quem faz deploy | — |
| **T-7** | plantão de rollback não designado (item 12) | gestão | nomear pessoa |
| **10** | duplicatas financeiras D4 não auditadas | depende de **T-1** | 1 comando |

Detalhe de cada um em `12_ROLLOUT_GATE_ATUAL.md` §2.

> Se **T-1** for destravado antes da relação chegar, os BLOCOS A, B, C, E, F, G,
> H e I ficam **integralmente concluídos** sem depender de decisão humana
> nenhuma — e o mapa já sai pré-preenchido esperando só as decisões.

---

## 4. QUANDO A RELAÇÃO CHEGAR — o fluxo exato

### Passo 0 — inventário (uma vez, e sempre que a base mudar)

```bash
DATABASE_URL="postgres://READONLY:...@host/db" \
  node server/sql/squads-inventario-readonly.js --saida inventario.json --resumo
```

Read-only garantido: `BEGIN; SET TRANSACTION READ ONLY;` … `ROLLBACK`.
Nunca `COMMIT`, nunca DDL. Fecha os BLOCOS A, B, C, E, F, G, H, I de uma vez.

### Passo 1 — gerar o mapa pré-preenchido

```bash
node server/sql/squads-preflight-relacao.js \
  --esqueleto --inventario inventario.json \
  --saida Squads_migration/P2_9_REAL_DATA_READINESS/entrada/relacao-squads.txt
```

Sai com 6 blocos de Squad vazios + catálogo completo de Clientes e internos.

### Passo 2 — preencher (**o único trabalho humano**)

Em `relacao-squads.txt`, para cada Squad: `SQUAD:` (nome oficial),
`GESTOR:` (email), e mover as linhas do catálogo para `CLIENTES:` / `MEMBROS:`.

### Passo 3 — validar offline (sem banco, quantas vezes quiser)

```bash
node server/sql/squads-preflight-relacao.js \
  --relacao ...entrada/relacao-squads.txt --inventario inventario.json
```

Repita até `ERRO_ESTRUTURAL: 0`. Depois feche com `--estrito` (pendência vira erro).

### Passo 4 — emitir o plano canônico

```bash
node server/sql/squads-preflight-relacao.js \
  --relacao ...entrada/relacao-squads.txt --inventario inventario.json \
  --estrito --emitir-plano plano-p2-9.json
```

Só é escrito com veredito `PRONTO_PARA_DRY_RUN`.

### Passo 5 — dry-run REAL com banco (tooling P2.3 existente)

```bash
DATABASE_URL="..." node server/sql/squads-migrate.js --plan plano-p2-9.json
```

> ⚠️ Este passo **aplica DDL** (`ensureSquadsTables`) — aditivo e idempotente,
> mas não é "zero escrita". Risco **T-3**. Não escreve **dado** sem `--apply`.

Exit `0` = válido. Revise **todos** os avisos, principalmente transferências.

### Passo 6 — auditoria + conferência humana

```bash
DATABASE_URL="..." node server/sql/squads-migrate.js --audit > auditoria-ANTES.json
```

Conferir à mão, **antes de aplicar**:
- `atencao.responsaveisForaDoSquad` — quem responde por um cliente sem estar no
  Squad dele **perde acesso** quando o enforcement ligar. **Não bloqueia
  `pronto`** — tem de ser olhado por pessoa (`09_...md` §5);
- `atencao.membershipsDeUsuarioInativo`;
- a lista de transferências do dry-run.

### Passo 7 — GO/NO-GO

Reavaliar `12_ROLLOUT_GATE_ATUAL.md` §1. Os 6 itens 🟦🟪 destravam aqui.
Confirmar os 🟥 (T-5, T-6, T-7, item 10).

### Passo 8 — aplicar (decisão humana, transacional)

```bash
DATABASE_URL="..." node server/sql/squads-migrate.js \
  --plan plano-p2-9.json --apply --actor <userIdAdmin>
```

Uma transação; qualquer erro → `ROLLBACK` total; idempotente.

### Passo 9 — confirmar prontidão

```bash
DATABASE_URL="..." node server/sql/squads-migrate.js --audit > auditoria-DEPOIS.json
# esperado: pronto = true
```

### Passo 10 — canário (só agora faz sentido escolher)

`P2_9_PRE_FLIGHT/07_PLANO_CANARIO.md`. Antes: comunicar ao time de fechamento
os riscos **R2** (timezone) e **R5** (`token_publico` não rotaciona), para que
um observador não confunda dívida conhecida com regressão de Squads.

### Passo 11 — ativar

`SQUADS_ENFORCEMENT=on` no Render + restart. O rollout gate só libera com
`auditoria().pronto === true`. Rollback = remover a var + restart (segundos,
sem apagar dado). Cartão: `P2_9_PRE_FLIGHT/10_ROLLBACK_CARD.md`.

---

## 5. Resumo do fluxo

```
RELAÇÃO HUMANA
   │
   ├─ passo 0  inventário read-only ........... 1 comando   (BLOCOS A,B,C,E,F,G,H,I)
   ├─ passo 1  esqueleto pré-preenchido ....... 1 comando   (BLOCO J)
   ├─ passo 2  PREENCHER ...................... trabalho humano
   ├─ passo 3  validar offline ................ 1 comando   (BLOCOS K,L)
   ├─ passo 4  emitir plano canônico .......... 1 comando
   ├─ passo 5  dry-run com banco .............. tooling P2.3 existente
   ├─ passo 6  auditoria + conferência ........ humano
   ├─ passo 7  GO/NO-GO ....................... humano
   ├─ passo 8  --apply ........................ humano
   ├─ passo 9  pronto = true .................. verificação
   ├─ passo 10 canário ........................ humano
   └─ passo 11 SQUADS_ENFORCEMENT=on .......... humano
```

**Nenhuma nova investigação estrutural é necessária.** Tudo que não dependia da
relação humana está feito ou é 1 comando.

---

## 6. Se o enforcement fosse ligado hoje

**Nada aconteceria.** O rollout gate ficaria `bloqueado` (a auditoria reprova
com clientes sem Squad e internos sem membership), e o enforcement permaneceria
**OFF**. Admin, interno e seller: **nenhuma mudança**, nenhum 403 em cascata.
Provado por código em `13_SIMULACAO_ENFORCEMENT_ATUAL.md`.

---

## 7. O que esta missão deliberadamente NÃO fez

- ❌ não inventou nome de Squad, Gestor, ou vínculo Cliente→Squad;
- ❌ não inferiu Squad a partir de responsável, marketplace, Base, Grant ou histórico;
- ❌ não criou 7º Squad nem fundiu Squads;
- ❌ não criou registro em `squads`, `squad_members` ou `cliente_squad_history`;
- ❌ não rodou `--apply`, migração, seed ou bootstrap;
- ❌ não ligou `SQUADS_ENFORCEMENT` nem `ALLOW_INCOMPLETE`;
- ❌ não abriu conexão com banco nenhum;
- ❌ não alterou frontend, Cliente 360, Render, `JWT_SECRET`;
- ❌ não fez deploy, não mergeou na `main`;
- ❌ não escolheu canário (sem Cliente→Squad seria chute);
- ❌ não refez o pacote P2.9 PRE-FLIGHT — ele foi usado como base.
