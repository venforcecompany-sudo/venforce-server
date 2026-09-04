# 18 — Dry-run final pré-APPLY

> **Executado contra o banco de PRODUÇÃO. Zero escrita**, provada por três
> camadas independentes — uma delas por comparação de hash do banco antes e
> depois.

| | |
|---|---|
| Momento | 2026-09-04 |
| Destino | `dpg-d75ce3cr85hc73f2r490-a.oregon-postgres.render.com/venforce` |
| Plano | `artefatos/plano-p2-9.json` (regerado com as decisões aprovadas) |
| Comando | `node server/sql/squads-migrate.js --plan …/plano-p2-9.json` |
| `--apply` | **ausente** |
| Exit code | **0** |

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
idêntico.

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
  membros     → criar: 20 · reativar: 0 · atualizar: 0 · inalterado: 0
  clientes    → atribuir: 83 · transferir: 0 · inalterado: 0
  responsáveis → upsert: 0

>> dry-run — nada foi escrito.
```

**Exit code 0 · 0 erros · 0 avisos.**

---

## 3. O que mudou desde o dry-run anterior

| | dry-run de 03/09 | **dry-run final** |
|---|---|---|
| memberships planejadas | 18 | **20** |
| **avisos** | **2** ⛔ | **0** ✅ |
| erros | 0 | 0 |
| squads a criar | 7 | 7 |
| clientes a atribuir | 83 | 83 |
| transferências | 0 | 0 |
| exit code | 0 | 0 |

**Os dois avisos eram o bloqueador anterior** e desapareceram:

```
⚠ usuário id=24 (Micael)  ficará sem principal explícito — a 1ª membership será auto-promovida
⚠ usuário id=28 (Sophia)  ficará sem principal explícito — a 1ª membership será auto-promovida
```

"A 1ª membership será auto-promovida" significava **escolher o Squad principal
pela ordem da planilha** — exatamente o critério que a missão proíbe. Com os
principais decididos pelo humano (Micael → Squad 1, Sophia → Squad 5), o plano
agora marca `principal: true` explicitamente e a ferramenta não precisa
escolher nada. **O bloqueador técnico do dry-run está fechado.**

As 20 memberships (contra 18) vêm de: **+2** os dois Fernandos, agora
desambiguados por email; e **−0** nas quatro pessoas sem conta, que antes
apareciam como bloqueio e agora saem por exclusão explícita.

---

## 4. Prova das escritas proibidas

| operação | contagem | como se sabe |
|---|---|---|
| `INSERT` | **0** | hash idêntico nas 9 tabelas; `squads`/`squad_members`/`cliente_squad_history` seguem em 0 |
| `UPDATE` | **0** | hash idêntico; nenhum `clientes.squad` mudou — 83 seguem "sem squad" |
| `DELETE` | **0** | hash idêntico; contagens de `clientes`, `cliente_contas`, `ml_tokens` inalteradas |
| **DDL** | **0** | `garantirSchema: false` sem `--apply` (T-3) **e** a sessão recusa DDL — provado empiricamente com o `CREATE TABLE` acima |
| **Cliente criado** | **0** | `clientes` 83 → 83 · invariante **I5** verde · plano não contém `CRIAR_CLIENTE` |
| **Cliente deletado** | **0** | `clientes` 83 → 83 |
| **Usuário criado** | **0** | `users` 32 → 32 · o plano não emite operação sobre `users` (teste `8h`) |
| **Grant alterado** | **0** | `ml_tokens` 63 → 63 · invariante **I1** (13 de alias endereçados = 13 no banco) · **I2** (0 troca de seller) · o grant cruzado #69 continua exatamente onde estava |
| **Base alterada** | **0** | `base_cliente_vinculos` 45 → 45 |
| **`ClienteConta` troca seller** | **0** | invariante **I2** |
| **`ClienteConta` troca marketplace** | **0** | invariante **I3** |

O plano de consolidação (`CLIENT_CONSOLIDATION_PLAN.json`) permanece
**`PLAN_ONLY`**: todas as operações têm `acao: "PLAN_ONLY"`, nenhuma foi
executada, e nenhuma entidade foi realmente consolidada.

---

## 5. Leitura do plano

| sinal | leitura |
|---|---|
| **0 erros** | o plano é **estruturalmente válido**: todo squad, usuário e cliente referenciado existe e resolve no banco |
| **0 avisos** | nenhuma decisão implícita sobrou para a ferramenta tomar |
| 7 squads a criar | 6 operacionais + Squad 8 · Legado. Nenhum existe — a base nunca foi migrada |
| **20 memberships** | das 28 posições da planilha. As 8 faltantes: 4 pessoas sem conta (decisão humana) + **4 bloqueadas por identidade** (Klayvert ×3, Vinícius ×1) |
| 83 clientes a atribuir | **todos**. Nenhum fica sem Squad |
| 0 transferências | nenhum cliente tem Squad hoje — é a primeira migração |
| `auditoria.pronto: false` | esperado: a migração ainda não rodou. É o que mantém o rollout gate fechado |

---

## 6. O plano diz, nele mesmo, que não está liberado

`plano-p2-9.json` agora carrega o próprio veredito:

```json
"_emitivel": false,
"_bloqueios": [
  { "tipo": "USUARIO_AMBIGUO", "nome": "Klayvert", "squad": "squad-2", "papel": "coordenador", "candidatos": [22, 35] },
  { "tipo": "USUARIO_AMBIGUO", "nome": "Vinícius", "squad": "squad-2", "papel": "auxiliar2",   "candidatos": [29, 44] },
  { "tipo": "USUARIO_AMBIGUO", "nome": "Klayvert", "squad": "squad-3", "papel": "coordenador", "candidatos": [22, 35] },
  { "tipo": "USUARIO_AMBIGUO", "nome": "Klayvert", "squad": "squad-6", "papel": "coordenador", "candidatos": [22, 35] }
]
```

Um plano bloqueado que circula sem dizer que está bloqueado é a forma mais
fácil de um `--apply` acontecer por engano. Agora o arquivo carrega o motivo.

Note a diferença entre os dois vereditos: o **dry-run** aprova (0 erro, 0
aviso, plano estruturalmente válido) e o **plano** se recusa (4 memberships
sem identidade resolvida). São coisas distintas — o dry-run responde "isto
roda?", o `_emitivel` responde "isto está completo?".

---

## 7. ⚠️ O inventário envelhece — regra operacional para o APPLY

Entre 03/09 e 04/09 o banco não se moveu (83 clientes nas duas leituras), mas
**durante** a missão anterior ele se moveu: 82 → 83 clientes, 72 → 74 contas,
por atividade de QA.

A regra continua valendo, e é condição do APPLY:

> **O plano precisa ser regerado a partir de um inventário fresco imediatamente
> antes do apply**, e a contagem de clientes no plano precisa bater com a
> contagem no banco no instante da execução.

Um cliente criado entre a geração e o apply ficaria **sem Squad** — e
invisível assim que o enforcement ligasse.

---

## 8. Testes

| suíte | resultado |
|---|---|
| `squadsMapeamentoReal` | **155** verificações ✅ (eram 109 — 46 novas nesta fase) |
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
| `authz*` (6 suítes) + `responsabilidadeNaoAutoriza` | ✅ |
| **backend completo** | **180 / 184 verdes** |

Os 4 vermelhos são os **mesmos pré-existentes**, já vermelhos antes desta
missão e sem relação com ela: `basesTiktok`, `designStudioWorkspace`,
`designTemplateEngine`, `mlTokenService`. Nenhum importa
`squads-mapeamento-real.js`. **Zero regressão.**
