# 18 — Dry-run final pré-APPLY

> **Executado contra o banco de PRODUÇÃO. Zero escrita**, provada por três
> camadas independentes — uma delas por comparação de hash do banco antes e
> depois.

| | |
|---|---|
| Momento | 2026-09-04 · rodada 2 (decisões completas) |
| Destino | `dpg-d75ce3cr85hc73f2r490-a.oregon-postgres.render.com/venforce` |
| Plano | `artefatos/plano-p2-9.json` (regerado com as decisões completas) |
| Comando | `node server/sql/squads-migrate.js --plan …/plano-p2-9.json` |
| `--apply` | **ausente** |
| Snapshot do inventário | `2026-09-04T18:23:46.199Z` |
| Exit code | **0** |
| Erros | **0** |
| Avisos | **0** |

---

## 1. As três camadas de garantia

**1. No código.** Sem `--apply`, `squads-migrate.js` chama
`migImport.importar(plano, { dryRun: true, garantirSchema: false })`. O
`garantirSchema: false` é o hardening T-3 desta branch: nem o DDL de schema é
emitido. "Simular" não pode mudar nada, especialmente em produção.

**2. No servidor.** A sessão foi aberta com
`options=-c default_transaction_read_only=on`. Verificado **antes** de rodar
qualquer coisa:

```
default_transaction_read_only = {"default_transaction_read_only":"on"}
escrita RECUSADA pelo Postgres: cannot execute CREATE TABLE in a read-only transaction
```

Mesmo que a camada 1 falhasse, o próprio Postgres recusaria.

**3. Na evidência, depois.** Um inventário completo foi coletado **antes** e
**depois** do dry-run e comparado por SHA-256 sobre as nove tabelas que a
migração tocaria:

| tabela | antes | depois |
|---|---|---|
| `clientes` | 83 | 83 |
| `cliente_contas` | 74 | 74 |
| `users` | 32 | 32 |
| `ml_tokens` (Grants) | 63 | 63 |
| `base_cliente_vinculos` | 45 | 45 |
| `squads` | 0 | 0 |
| `squad_members` | 0 | 0 |
| `cliente_squad_history` | 0 | 0 |
| `cliente_responsaveis` | 0 | 0 |

```
hash antes : 2193ab9296ca91f3b8a191fe26ec5ed398d33a77305e9c8484e9a2da5776b2e5
hash depois: 2193ab9296ca91f3b8a191fe26ec5ed398d33a77305e9c8484e9a2da5776b2e5
IGUAIS     : true
```

Não é "não vi escrita acontecer": é o conteúdo das nove tabelas, byte a byte,
idêntico. O mesmo hash da rodada 1 — o banco não se moveu entre as duas.

---

## 2. Saída do dry-run

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
  membros     → criar: 24 · reativar: 0 · atualizar: 0 · inalterado: 0
  clientes    → atribuir: 83 · transferir: 0 · inalterado: 0
  responsáveis → upsert: 0

>> dry-run — nada foi escrito.
```

**Exit code 0 · 0 erros · 0 avisos.**

---

## 3. A evolução dos três dry-runs

| | 03/09 | 04/09 · rodada 1 | **04/09 · rodada 2** |
|---|---|---|---|
| memberships planejadas | 18 | 20 | **24** |
| **avisos** | **2** ⛔ | 0 | **0** ✅ |
| erros | 0 | 0 | **0** |
| identidades ambíguas | 4 | 2 | **0** ✅ |
| `_emitivel` do plano | — | `false` ⛔ | **`true`** ✅ |
| squads a criar | 7 | 7 | 7 |
| clientes a atribuir | 83 | 83 | 83 |
| transferências | 0 | 0 | 0 |
| exit code | 0 | 0 | **0** |

**O que fechou, em ordem:**

1. **Os 2 avisos** (rodada 1). Eram o bloqueador técnico: *"a 1ª membership será
   auto-promovida a principal"* significava escolher o Squad principal pela
   ordem da planilha — exatamente o critério que a missão proíbe. Com Micael →
   Squad 1 e Sophia → Squad 5 decididos, o plano marca `principal: true`
   explicitamente e a ferramenta não escolhe nada.
2. **As 4 memberships bloqueadas** (rodada 2). Klayvert → **#35** e Vinícius →
   **#44** resolveram os últimos assentos ambíguos: +3 Coordenadores (squads 2,
   3, 6) e +1 auxiliar2 do squad-2. **`_emitivel` virou `true`.**

As 24 memberships são todas as 28 posições da planilha **menos** as 4 pessoas
que ainda não têm conta (Caique, Yuri, Carol, Victor) — ausência esperada,
aprovada e explícita.

---

## 4. Prova das escritas proibidas

| operação | contagem | como se sabe |
|---|---|---|
| `INSERT` | **0** | hash idêntico nas 9 tabelas; `squads`/`squad_members`/`cliente_squad_history` seguem em 0 |
| `UPDATE` | **0** | hash idêntico; nenhum `clientes.squad` mudou — 83 seguem "sem squad" |
| `DELETE` | **0** | hash idêntico; contagens de `clientes`, `cliente_contas`, `ml_tokens` inalteradas |
| **DDL** | **0** | `garantirSchema: false` sem `--apply` (T-3) **e** a sessão recusa DDL — provado empiricamente com o `CREATE TABLE` acima |
| **Clientes criados** | **0** | `clientes` 83 → 83 · invariante **I5** verde · plano não contém `CRIAR_CLIENTE` |
| **Clientes deletados** | **0** | `clientes` 83 → 83 |
| **Usuários criados** | **0** | `users` 32 → 32 · o plano não emite operação sobre `users` (teste `8h`) · contas #22, #29 e #6 continuam existindo, ativas e fora do plano |
| **Grants alterados** | **0** | `ml_tokens` 63 → 63 · **I1** (13 de alias endereçados = 13 no banco) · **I2** (0 troca de seller) · os grants #69 e #70 do cruzamento Fênix × Eliza conferidos um a um, antes e depois |
| **Bases alteradas** | **0** | `base_cliente_vinculos` 45 → 45 |
| **`ClienteConta` troca seller** | **0** | invariante **I2** |
| **`ClienteConta` troca marketplace** | **0** | invariante **I3** |

Conferência explícita do grant cruzado, por decisão humana de **não mexer**:

```
grant cruzado ANTES : #69 cliente102 primary=false | #70 cliente105 primary=true
grant cruzado DEPOIS: #69 cliente102 primary=false | #70 cliente105 primary=true
```

O plano de consolidação (`CLIENT_CONSOLIDATION_PLAN.json`) permanece
**`PLAN_ONLY`**: as 11 operações têm `acao: "PLAN_ONLY"`, nenhuma foi
executada, nenhuma entidade foi realmente consolidada.

---

## 5. Leitura do plano

| sinal | leitura |
|---|---|
| **0 erros** | o plano é **estruturalmente válido**: todo squad, usuário e cliente referenciado existe e resolve no banco |
| **0 avisos** | nenhuma decisão implícita sobrou para a ferramenta tomar |
| **`_emitivel: true`** | nenhum bloqueio de identidade: as 24 memberships aplicáveis estão todas resolvidas |
| 7 squads a criar | 6 operacionais + Squad 8 · Legado. Nenhum existe — a base nunca foi migrada |
| **24 memberships** | das 28 posições da planilha. As 4 faltantes são as pessoas sem conta, por decisão humana |
| 83 clientes a atribuir | **todos**. Nenhum fica sem Squad |
| 0 transferências | nenhum cliente tem Squad hoje — é a primeira migração |
| `auditoria.pronto: false` | esperado: a migração ainda não rodou. É o que mantém o rollout gate fechado |

O plano carrega o próprio veredito:

```json
"_emitivel": true,
"_bloqueios": []
```

---

## 6. ⚠️ O inventário envelhece — condição do APPLY

Entre 03/09 e 04/09 o banco não se moveu (83 clientes em todas as leituras),
mas **durante** a missão anterior ele se moveu: 82 → 83 clientes, 72 → 74
contas, por atividade de QA.

A regra continua valendo, e é **condição de execução** do APPLY:

> **Regerar o plano a partir de um inventário fresco imediatamente antes do
> apply**, e conferir que a contagem de clientes no plano bate com a contagem
> no banco no instante da execução.

Um cliente criado entre a geração e o apply ficaria **sem Squad** — e invisível
assim que o enforcement ligasse.

---

## 7. Testes

| suíte | resultado |
|---|---|
| `squadsMapeamentoReal` | **163** verificações ✅ (109 antes desta fase) |
| `squadsDryRunZeroWrite` | 23 ✅ |
| `squadsAuditoriaVacuidade` | 27 ✅ |
| `squadsMigracaoImport` | 43 ✅ |
| `squadsRolesInternas` | 24 ✅ |
| `squadsRolloutGate` | 48 ✅ |
| `squadsRolloutGateBoot` | 22 ✅ |
| `squadsIsolamento` | 47 ✅ |
| `squadsPreflightRelacao` | 191 ✅ |
| `squadsInventarioReadonly` | 38 ✅ |
| `squadsMigracaoAuditoriaY` · `squadsMiddlewareEAuditoria` · `squadServiceMutacoes` · `squadsRolloutSafety` | ✅ |
| **hotfix da main** — `clienteContasAuthPerRoute` · `clienteContasGuards` | 11 ✅ · 35 ✅ |
| **backend completo** | **181 / 185 verdes** |

Os 4 vermelhos são os **mesmos pré-existentes**, já vermelhos antes desta
missão e sem relação com ela: `basesTiktok`, `designStudioWorkspace`,
`designTemplateEngine`, `mlTokenService`. Nenhum importa
`squads-mapeamento-real.js`. **Zero regressão** — inclusive depois do merge da
`origin/main`, cujos dois testes de `cliente_contas` passam.
