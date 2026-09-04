# 12 — Rollout gate: estado de hoje

> **BLOCO N.** Revalidação **não destrutiva** da matriz GO/NO-GO, separando o
> que falta **só pela relação humana** do que é bloqueador técnico real.
> Nada foi executado contra banco; nenhuma flag foi tocada.

---

## 1. Matriz GO/NO-GO reavaliada (2026-09-02)

Base: `P2_9_PRE_FLIGHT/08_GO_NO_GO.md`, já reclassificada por
`P2_9_PRE_FLIGHT/REVALIDACAO_2026-09-01.md` §6, agora reavaliada contra
`origin/main` @ `a642092` (PR #94 mergeado).

Legenda da coluna **Falta o quê**:
🟩 **JÁ VERDE** · 🟦 **AGUARDANDO CLIENTE→SQUAD** · 🟪 **AGUARDANDO USUÁRIO→SQUAD** ·
🟥 **OUTRO BLOQUEADOR REAL**

| # | Requisito | Status hoje | Falta o quê | Nota |
|---|---|---|---|---|
| 1 | Convergência #2 aprovada e mergeada | **GO** | 🟩 | Encerrada; PR #94 mergeado (`a642092`) |
| 2 | `JWT_SECRET` em produção (≥32 chars) | **PENDENTE** | 🟥 **T-5** | Não verificável do repositório — exige acesso ao Render |
| 3 | Deploy com `SQUADS_ENFORCEMENT=OFF` + smoke | **PENDENTE** | 🟥 **T-6** | Sem bloqueador de código; é ação humana de deploy |
| 4 | Mapeamento **Cliente→Squad** revisado por pessoa | **PENDENTE** | 🟦 | **O bloqueio central desta missão** |
| 5 | Mapeamento **Usuário→Squad** revisado por pessoa | **PENDENTE** | 🟪 | idem |
| 6 | Dry-run limpo (`--plan`, 0 erros) | **PENDENTE** | 🟦🟪 | Tooling testado; falta o plano real |
| 7 | `auditoria().pronto === true` após `--apply` | **PENDENTE** | 🟦🟪 | Consequência de 4+5 |
| 8 | `integridade.clientesComVinculoDuplicado === 0` | **PENDENTE** | 🟩* | Hoje trivialmente 0 (tabela vazia); reconferir pós-apply |
| 9 | `auditoria().atencao` revisado | **PENDENTE** | 🟦🟪 | Depende de responsáveis + squads |
| 10 | Duplicidade financeira D4 tratada | **PENDENTE** | 🟥 **T-1** | Independe de Squad; exige banco para auditar. Ver `08_DUPLICATAS_FINANCEIRO.md` |
| 11 | Plano de canário definido | **PENDENTE** | 🟦 | Escolher canário sem Cliente→Squad seria chute — ver `00_RESUMO.md` §BLOCO O |
| 12 | Responsável pelo rollback de plantão | **PENDENTE** | 🟥 **T-7** | Decisão de gestão; cartão pronto (`10_ROLLBACK_CARD.md`) |
| 13 | Contador de "403 de carteira/dia" | **GO** | 🟩 | Entregue em `ea10299` |
| 14 | Riscos abertos classificados | **GO** | 🟩 | `12_RISCOS_ABERTOS.md` + esta revisão |

### Contagem

| Categoria | Itens |
|---|---|
| 🟩 **JÁ VERDE** | 1, 8*, 13, 14 |
| 🟦🟪 **Aguardando SOMENTE a relação humana** | **4, 5, 6, 7, 9, 11** |
| 🟥 **Outro bloqueador real** | **2** (JWT/Render), **3** (deploy), **10** (D4, exige banco), **12** (plantão) |

> **A leitura que importa:** 6 dos 14 itens destravam **automaticamente** com a
> chegada da relação Cliente→Squad e Usuário→Squad. Os outros 4 pendentes são
> **independentes** dela e podem ser resolvidos em paralelo, hoje, por quem tem
> acesso ao Render e ao banco.

---

## 2. Bloqueadores técnicos reais (não são "falta a relação")

Numerados `T-n` para não colidir com os riscos `R-n` de
`P2_9_PRE_FLIGHT/12_RISCOS_ABERTOS.md`.

### T-1 — **Sem acesso ao banco neste ambiente** (o bloqueador desta missão)

`server/.env` **não existe** neste checkout (é gitignorado: `.gitignore:2,26`),
`DATABASE_URL` não está no ambiente, e não há Postgres local escutando.

Consequência: os BLOCOS **A, B, C, F, G, H, I** e a contagem do **E** não
puderam produzir números reais. Toda a **maquinaria** foi construída e testada;
falta apenas apontá-la para um banco.

| | |
|---|---|
| **Severidade** | **Alta para a auditoria**, nula para o produto |
| **Bloqueia P2.9?** | Bloqueia a *auditoria pré-migração*, não o código |
| **Destrava com** | `DATABASE_URL` de um usuário **somente-leitura** ou de uma réplica |
| **Custo depois de destravar** | **1 comando** — `node server/sql/squads-inventario-readonly.js --saida inventario.json` |

> Registrado sem drama: o ambiente anterior **tinha** esse `.env` apontando para
> o Postgres de produção no Render
> (`VENFORCE_V3_FINAL_CONVERGENCE_CLOSURE.md:252-254`). A ausência dele aqui é,
> na prática, uma **proteção** — tornou impossível tocar produção por engano.

### T-2 — `ROLES_INTERNAS` está triplicada com valores divergentes

| Arquivo | Valor |
|---|---|
| `server/services/squads/squadsMigracaoService.js:14` | `["user","membro","interno"]` ← **decide `pronto`** |
| `server/services/squads/authorizationService.js:17` | `["user","membro","interno"]` ← decide acesso |
| `server/services/squads/squadsMigracaoImportService.js:31` | `["user","membro","interno",**"admin"**]` ← só emite aviso |

Os dois que importam concordam; o divergente só controla um **aviso** do
importador ("role não interna"), então **não há bug de comportamento hoje**.
O risco é de manutenção: alguém adicionar uma role nova em um lugar só.

| | |
|---|---|
| **Severidade** | Baixa (latente) |
| **Bloqueia P2.9?** | **Não** |
| **Ação** | Extrair para uma constante compartilhada — fora do escopo desta missão (mexeria em runtime) |

O validador desta entrega usa deliberadamente a lista da **auditoria**, com o
motivo comentado no código (`server/sql/squads-preflight-relacao.js`).

### T-3 — O "dry-run" do tooling **não é read-only**: ele aplica DDL

`validarPlano()` começa com `await ensureSquadsTables(db)`
(`squadsMigracaoImportService.js:152`), que **reexecuta as 2 migrações**.
Portanto `node server/sql/squads-migrate.js --plan <arq>` — e também `--audit` —
**escrevem DDL** no banco alvo, mesmo sem `--apply`.

O DDL é aditivo e idempotente (`IF NOT EXISTS`), então é seguro na prática —
mas **não** satisfaz uma regra estrita de "zero escrita".

| | |
|---|---|
| **Severidade** | Média (para disciplina de auditoria read-only) |
| **Bloqueia P2.9?** | **Não** |
| **Mitigação já entregue** | `squads-inventario-readonly.js` (transação `READ ONLY`, nunca chama `ensureSquadsTables`) e `squads-preflight-relacao.js` (100% offline). Use-os para auditar; use `--plan` só quando aplicar DDL for aceitável. |

### T-4 — `auditoria().pronto` pode ser verdadeiro por vacuidade

Detalhado em `13_SIMULACAO_ENFORCEMENT_ATUAL.md` §5. Em base **zerada**
(sem clientes e sem internos) `pronto = true` sem migração nenhuma.
Irrelevante em produção; relevante em staging novo.

| | |
|---|---|
| **Severidade** | Baixa em produção · Média em ambiente novo |
| **Bloqueia P2.9?** | **Não** |

### T-5 — `JWT_SECRET` de produção não verificável (= item 2 da matriz)

Regra existe e é fail-fast (`server/config/jwtSecret.js`); o estado do Render
não é observável do repositório. Ligar `JWT_SECRET` **invalida todas as sessões**
(risco R9). Decisão/ação humana com acesso ao Render.

### T-6 — Deploy da `main` atual + smoke ainda não feito (= item 3)

Sem bloqueador de código. `VENFORCE_V3_FINAL_CONVERGENCE_CLOSURE.md:363-368`
já aponta isso como o próximo passo operacional.

### T-7 — Plantão de rollback não designado (= item 12)

Cartão pronto em `P2_9_PRE_FLIGHT/10_ROLLBACK_CARD.md`. Falta nomear a pessoa
com acesso ao Render e autoridade para `SQUADS_ENFORCEMENT=off`.

---

## 3. Riscos herdados (R1–R11) — sem mudança

`P2_9_PRE_FLIGHT/12_RISCOS_ABERTOS.md` + `REVALIDACAO_2026-09-01.md` §5.
Nenhum foi reaberto por esta missão.

| Risco | Estado | Bloqueia P2.9? |
|---|---|---|
| R1 (vazamento cross-marketplace com 0 contas) | **RESOLVIDO** (`037e051`) | Não |
| R2 (timezone Central de Vendas) | MITIGADO/PINADO (`70545a3`) | Não — **comunicar ao time antes do canário** |
| R3 (summary de conciliação MP) | **RESOLVIDO** (`26274d7`) | Não |
| R4 (`resolverBaseTikTokPorId` sem checagem de posse) | inalterado (deliberado) | Não |
| R5 (`despublicarEntrega` não rotaciona `token_publico`) | inalterado | Não — **comunicar antes do canário** |
| R6 (exclusão de entrega não implementada) | inalterado (deliberado) | Não |
| R7 (`GET /financeiro` só lê ~24 entregas recentes) | inalterado | Não |
| R8 (`resultado.escopoConta` só em entregas novas) | inalterado | Não |
| R9 (`JWT_SECRET` invalida sessões) | inalterado | Não ao enforcement · **SIM ao deploy** (= T-5) |
| R10 (índice único D4 falha se houver duplicata) | inalterado (`auto:false`) | Não — classe D exige decisão humana |
| R11 (403 do ML em cliente multi-conta) | **CORRIGIDO** (`1521ab4`) | Não |

---

## 4. Veredito do gate hoje

```
ROLLOUT GATE HOJE:  NO-GO

MOTIVO PRINCIPAL:   ausência da relação Cliente→Squad e Usuário→Squad
                    (itens 4, 5 → 6, 7, 9, 11 em cascata)

MOTIVOS INDEPENDENTES DA RELAÇÃO:
  T-1  sem DATABASE_URL neste ambiente → auditoria de dados reais não executada
  T-5  JWT_SECRET de produção não confirmado (item 2)
  T-6  deploy da main atual + smoke não feitos (item 3)
  T-7  plantão de rollback não designado (item 12)
  (10) duplicatas D4 não auditadas — depende de T-1

SQUADS_ENFORCEMENT:  OFF (inalterado)
BANCO ALTERADO:      NÃO
```

**Nenhum bloqueador é defeito de código.** O código de Squads segue
"PRONTO" conforme `VENFORCE_V3_FINAL_CONVERGENCE_CLOSURE.md` §5.
