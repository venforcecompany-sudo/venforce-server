# 14 — Resultado do DRY-RUN

> **Executado contra o banco de PRODUÇÃO.** Zero escrita, comprovada por duas
> camadas independentes.

## As duas camadas de garantia

1. **No código** — T-3 resolvido: `--apply` ausente ⇒ `garantirSchema: false`
   ⇒ nenhum DDL é sequer tentado.
2. **No servidor** — a sessão foi aberta com
   `options=-c default_transaction_read_only=on`. Mesmo que a camada 1
   falhasse, **o Postgres recusaria**.

A camada 2 foi verificada antes de rodar qualquer coisa:

```
default_transaction_read_only = {"default_transaction_read_only":"on"}
escrita RECUSADA pelo Postgres: cannot execute CREATE TABLE in a read-only transaction
```

E provou o T-3 empiricamente: **o caminho antigo é recusado, o novo passa.**

---

## Saída do dry-run

```
═══════════════════════════════════════════════════════════
  MIGRAÇÃO DE SQUADS — DRY-RUN (nada escrito)
═══════════════════════════════════════════════════════════

ANTES:
  squads: 0 (0 ativos) · memberships ativas: 0 · vínculos ativos: 0
  clientes ativos: 83 — com squad ativo: 0 · em squad inativo: 0 · sem squad: 83
  internos: 26 — com membership: 0 · sem membership: 26 · só em squad inativo: 0 · sem principal: 0
  auditoria.pronto: false

PLANEJADO:
  squads      → criar: 7 squad-1, squad-2, squad-3, squad-4, squad-5, squad-6, squad-8-legado | atualizar: 0 | inalterado: 0
  membros     → criar: 18 · reativar: 0 · atualizar: 0 · inalterado: 0
  clientes    → atribuir: 83 · transferir: 0 · inalterado: 0
  responsáveis → upsert: 0

AVISOS (2):
  ⚠ [membros] usuário id=24 ficará sem principal explícito — a 1ª membership será auto-promovida a principal.
  ⚠ [membros] usuário id=28 ficará sem principal explícito — a 1ª membership será auto-promovida a principal.

>> dry-run — nada foi escrito.
```

**Exit code 0. Zero erros. Plano estruturalmente VÁLIDO.**

---

## Leitura

| sinal | leitura |
|---|---|
| 0 erros | o plano é **estruturalmente** válido: todo squad, usuário e cliente referenciado existe e resolve |
| 7 squads a criar | 6 operacionais + Squad 8 · Legado. Nenhum já existe — a base nunca foi migrada |
| 18 memberships | das 24 posições da planilha. As 6 faltantes são as pessoas não resolvidas em `09` |
| 83 clientes a atribuir | **todos**. Nenhum fica sem Squad |
| 0 transferências | nenhum cliente tem Squad hoje — é a primeira migração |
| **2 avisos** | **o bloqueador real** — ver abaixo |

---

## ⛔ Os 2 avisos são o bloqueador

```
usuário id=24 (Micael)  → Squad 1 e Squad 5
usuário id=28 (Sophia)  → Squad 5 e Squad 6
```

"A 1ª membership será auto-promovida a principal" significa: **a ferramenta
escolhe pela ordem do array**, que vem da ordem da planilha. É **exatamente** o
critério que esta missão proíbe.

Não é bug do tooling — é o comportamento documentado dele ("1ª membership vira
principal"). O que ele não pode fazer é adivinhar a intenção da operação. Por
isso: **NO-GO por decisão humana**, e não por defeito técnico.

Klayvert e Fernando também são multi-Squad, mas nem chegam a este aviso: a
identidade deles não foi resolvida, então não estão no plano.

---

## `--audit`, também zero-write

```json
"vacuidade": { "squadsAtivos": 0, "membershipsAtivas": 0, "clientesAtivos": 83,
               "clientesComSquadAtivo": 0, "internosAtivos": 26, "vazio": true,
               "motivos": ["nenhum Squad ativo","nenhuma membership ativa",
                           "nenhum Cliente ativo com Squad ativo"] },
"pronto": false
```

---

## ⚠️ O banco se moveu durante a missão

|  | snapshot 1 | snapshot 2 |
|---|---|---|
| momento | 2026-09-03T18:32:50Z | 2026-09-03T21:33:05Z |
| clientes | 82 | **83** |
| cliente_contas | 72 | **74** |
| grants | 63 | 63 |

Delta: cliente `teste2` (#127) criado e `teste1` ganhou uma conta — atividade de
QA. Ambos vão para o Squad 8, então o mapa não muda de forma significativa.

**Mas a lição é operacional e vale para o apply:** o inventário **envelhece**.
O plano precisa ser **regerado a partir de um inventário fresco imediatamente
antes** do apply, e a contagem de clientes no plano precisa bater com a contagem
no banco no instante da execução. Um cliente criado entre a geração e o apply
ficaria **sem Squad** — e invisível assim que o enforcement ligasse.

