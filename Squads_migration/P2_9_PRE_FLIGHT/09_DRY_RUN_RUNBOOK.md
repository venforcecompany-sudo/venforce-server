# 09 — Runbook do dry-run (e do apply, quando os dados estiverem prontos)

> O tooling P2.3 **já existe e já está provado**. Este documento não
> reimplementa nada — só descreve como operá-lo com o plano real quando ele
> existir, e registra a prova de que **o dry-run não escreve**.

---

## 1. Prova de que o tooling funciona e não escreve (rehearsal — feita neste pré-flight)

Rodado em `backend/v3-squads-auth` @ `6126ee1` (Node v24), **sem banco real**
(os testes mockam `pool` com uma fake in-memory):

| Comando | Resultado |
|---|---|
| `node server/tests/squadsMigracaoImport.test.js` | **43 verificações passaram** — cobre: dry-run (`ok=true`, `aplicado=false`, **nada escrito**, `planejado` correto), matriz de validação (slug duplicado, squad/usuário/cliente inexistente, membership em squad inativo, principal duplicado, membership duplicada, cliente em 2 squads), sem-principal vira aviso, transferência, apply (escreve + auto-promoção de principal), **idempotência** (2ª execução = 0 linhas novas), **transacional** (erro no lote → `ROLLBACK` total, nada persiste), P2.4 (transferência encerra responsabilidade de quem não é do Squad destino) |
| `node server/tests/squadsMigracaoAuditoriaY.test.js` | **19 verificações passaram** — inclui explicitamente *"auditoria é 100% somente-leitura (nenhum INSERT/UPDATE/DELETE)"* |
| `node server/sql/squads-migrate.js --audit` **sem `DATABASE_URL`** | `Erro: DATABASE_URL não definida.` → **exit 1**, nada executado |
| `node server/sql/squads-migrate.js --plan <exemplo>` **sem `DATABASE_URL`** | idem — para no ambiente antes de tocar qualquer coisa |
| `node server/sql/squads-migrate.js --help` | imprime o uso |

**Conclusão:** `template → validarPlano → dry-run → relatório → nenhuma escrita`
está comprovado. Não reimplementar. O que falta é **só** os dados humanos
(`01`/`02`/`03`).

Prova adicional no código:
- `squadsMigracaoImportService.importar()`: `if (dryRun) return { ..., aplicado:false, motivo:"dry-run — nada foi escrito." }` **antes** de qualquer `db.connect()` / `BEGIN`.
- `if (!validacao.ok) return { ..., aplicado:false }` — plano inválido nunca chega ao apply.
- o apply inteiro roda dentro de um `client.query("BEGIN") … "COMMIT"`, com
  `catch → "ROLLBACK"` e retorno `{ aplicado:false, erroExecucao }`.

---

## 2. Sequência de execução na P2.9 (NÃO executar agora)

Pré-requisitos: Convergência #2 mergeada, código deployado com
`SQUADS_ENFORCEMENT=OFF`, `JWT_SECRET` OK, `plano-p2-9.json` preenchido e
revisado por pessoa.

```bash
export DATABASE_URL="postgres://…@…/…"     # a base de produção, mas o dry-run é read-only
PLANO=Squads_migration/P2_9_PRE_FLIGHT/plano-p2-9.json   # o REAL, preenchido

# ── PASSO 1 — fotografia inicial (read-only) ────────────────────────────────
node server/sql/squads-migrate.js --audit | tee p2-9-auditoria-ANTES.json
#   esperar: clientesAtivos.semSquad = <todos>, usuariosInternos.semMembership = <todos>,
#            pronto = false  (normal — a migração nunca rodou)

# ── PASSO 2 — DRY-RUN (valida contra o banco, NÃO escreve) ─────────────────
node server/sql/squads-migrate.js --plan "$PLANO" | tee p2-9-dryrun-1.txt
node server/sql/squads-migrate.js --plan "$PLANO" --json > p2-9-dryrun-1.json
#   critério para seguir:  ERROS = 0
#   revisar TODOS os AVISOS um a um (transferências, sem-principal, roles não-internas,
#   clientes/usuários inativos, linhas redundantes). Cada aviso é uma decisão consciente.
#   exit code: 0 = dry-run válido · 2 = plano inválido (corrigir o plano/dados e repetir)

# ── PASSO 3 — APPLY (transacional, idempotente) ───────────────────────────
node server/sql/squads-migrate.js --plan "$PLANO" --apply --actor <USER_ID_ADMIN> \
  --json | tee p2-9-apply.json
#   exit 0 = aplicado · 3 = erro de execução → ROLLBACK total, nada escrito → investigar e repetir

# ── PASSO 4 — validar (read-only) ────────────────────────────────────────
node server/sql/squads-migrate.js --audit | tee p2-9-auditoria-DEPOIS.json
#   GATE (ver 08 itens 7, 8):
#     auditoria.pronto === true
#     auditoria.integridade.clientesComVinculoDuplicado === 0
#     auditoria.atencao revisado e aceito
#   se pronto=false → ajustar o plano/dados e repetir PASSO 2–4 (idempotente, seguro)

# opcional: conferir com as queries cruas
psql "$DATABASE_URL" -f Squads_migration/P2_9_PRE_FLIGHT/queries/02_estado_squads.sql
psql "$DATABASE_URL" -f Squads_migration/P2_9_PRE_FLIGHT/queries/03_inconsistencias.sql
```

**O enforcement continua OFF durante todos esses passos.** Ligar o flag é a
FASE 3 de `07`, um passo separado e explícito.

---

## 3. Interpretação do relatório

```
ANTES:      totais + auditoria (semSquad, emSquadInativo, semMembership, semPrincipal, pronto)
PLANEJADO:  squads criar/atualizar/inalterado · membros criar/reativar/atualizar/inalterado
            clientes atribuir/transferir/inalterado · responsáveis upsert
AVISOS:     [contexto] mensagem   — decisão consciente, não bloqueia
ERROS:      [contexto] mensagem   — se houver, NADA é escrito; --apply recusa
APLICADO:   (só com --apply) resumo dos writes
DEPOIS:     (só com --apply) auditoria pós + auditoria.pronto
```

`--json` devolve `{ antes, planejado, avisos, erros, aplicado, resumo, depois }`
completo — **anexar ao registro da P2.9** (é a evidência dos itens 6/7/8 de `08`).

---

## 4. Se algo der errado no apply

- `erroExecucao` presente → **`ROLLBACK` total já aconteceu**. Nada foi escrito.
  Ler a mensagem, corrigir a causa (plano ou dado), repetir do PASSO 2. É
  idempotente — rodar de novo não duplica.
- `--apply` recusou com `ok:false` → o plano tem **erro de validação** (algo
  mudou no banco desde o dry-run, ou o plano foi editado). Ver `ERROS`, corrigir.
- Enforcement **ainda OFF** → nenhum usuário foi afetado por nada disso. A
  janela de risco só começa na FASE 3 de `07`.

---

## 5. Rehearsal opcional com banco de staging (se existir)

Se houver uma **cópia de desenvolvimento/staging** com dados fictícios:

```bash
export DATABASE_URL="postgres://…@staging/…"
# usar o exemplo canônico FICTÍCIO — nunca dados reais num rehearsal
node server/sql/squads-migrate.js --plan Squads_migration/SQUADS_MIGRATION_TEMPLATE.example.json
node server/sql/squads-migrate.js --plan Squads_migration/SQUADS_MIGRATION_TEMPLATE.example.json --apply --actor 1
node server/sql/squads-migrate.js --audit
```

Isso exercita o caminho completo sem tocar produção. **Não** é obrigatório — os
43+19 testes já cobrem o comportamento.
