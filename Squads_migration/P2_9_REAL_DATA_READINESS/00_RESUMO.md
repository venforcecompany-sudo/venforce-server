# P2.9 — REAL DATA READINESS

> **Objetivo desta fase:** avançar tudo que é tecnicamente possível **até a
> fronteira** da informação humana, para que — quando a relação
> Cliente→Squad e Usuário→Squad chegar — não seja preciso começar nenhuma
> investigação estrutural nova.
>
> **Estado:** `SQUADS_ENFORCEMENT` = **OFF** · migração **NÃO EXECUTADA** ·
> banco **NÃO ALTERADO** · nenhuma conexão de banco aberta.

| Item | Valor |
|---|---|
| Base | `origin/main` @ `a6420923cdd1e876bf0ea5633f86899b93107399` (PR #94 mergeado) |
| Branch | `backend/v3-p2-9-structure-readiness` |
| P2.9 PRE-FLIGHT | **já pronto — usado como base, não refeito** |
| Fase de Convergências V3 | ENCERRADA |

---

## 0. ATUALIZAÇÃO — A RELAÇÃO DOS MEMBROS CHEGOU

> **A composição humana dos 6 Squads foi recebida.** A fronteira desta fase se
> moveu: **Usuário → Squad está resolvido**; **Cliente → Squad continua pendente**.
>
> A estrutura real da empresa é **`Coordenador → Gestor → Auxiliar → Auxiliar 2
> → Design`**, não "Squad → Gestor → membros". **Coordenador e Gestor são pessoas
> e funções distintas** — o tooling V1 convertia Gestor em
> `squad_members.funcao = "coordenador"`, o que estava **semanticamente errado** e
> foi corrigido.
>
> | Item | Estado |
> |---|---|
> | Relação recebida | **PROCESSADA** — 6 blocos, 23 pessoas, 24 memberships |
> | Membership map | **PARCIALMENTE RESOLVIDO** |
> | Client map | **PENDENTE** (`PENDENTE_RELACAO_CLIENTE_SQUAD`) |
> | Rollout | **NO-GO** · APPLY **NÃO** · banco **NÃO ALTERADO** |
>
> **Leia:** `15_MEMBERSHIPS_RECEBIDAS.md` (a composição e a matriz) e
> `16_DECISOES_HUMANAS_PENDENTES.md` (as 5 decisões que sobraram).
> **Entrada:** `entrada/relacao-squads-operacao-v1.txt`.
>
> As seções abaixo descrevem o estado **anterior** à relação e ficam preservadas
> como registro; onde um pressuposto foi corrigido, há nota no ponto.

---

## 1. A fronteira

> **SUPERSEDIDO em parte** — ver §0. A composição dos Squads chegou; o que
> permanece verdadeiro aqui é a ausência de Cliente→Squad e o bloqueador T-1.

**O que sabíamos:** existem exatamente **6 Squads**, cada um com **1 Gestor
conhecido pela operação**.

**O que não sabíamos:** os nomes oficiais, a identidade dos Gestores, quais
Clientes pertencem a cada Squad, e quais usuários compõem cada Squad.

Buscamos essas informações no repositório antes de declará-las ausentes. Todos
os nomes de Squad encontrados são **fictícios de exemplo ou fixtures de teste**
(`squad-exemplo-a`, `Squad Alpha`, `alpha`/`arquivado`), e a expressão
"6 squads" **não aparece em lugar nenhum** do código ou dos documentos — o
número vem só da declaração desta missão.

**Nada foi inventado.** Os 6 slots existem como `SQUAD_1`…`SQUAD_6`,
explicitamente marcados como **identificador temporário de documentação** —
e o validador **recusa** um plano que ainda os contenha.

---

## 2. Bloqueador técnico T-1 — sem acesso ao banco

**`server/.env` não existe neste checkout** (é gitignorado: `.gitignore:2,26`),
`DATABASE_URL` não está no ambiente, e não há Postgres local escutando.

Consequência honesta: **nenhum número real foi produzido.** Os BLOCOS A, B, C,
F, G, H, I e a contagem do E ficaram com inventário **0**.

O que foi feito no lugar: construir e testar a **máquina completa** que produz
todos eles. Quando houver uma `DATABASE_URL` de leitura, é **1 comando**.

> O ambiente da missão anterior **tinha** esse `.env`, apontando para o Postgres
> de **produção** no Render (`VENFORCE_V3_FINAL_CONVERGENCE_CLOSURE.md:252-254`).
> A ausência dele aqui, na prática, **tornou impossível** tocar produção por
> engano — o que é coerente com a exigência de read-only desta missão.

Demais bloqueadores (T-2 a T-7) em `12_ROLLOUT_GATE_ATUAL.md` §2.

---

## 3. O que foi entregue

### Ferramentas (novas, read-only, testadas)

| Arquivo | O que faz | Segurança |
|---|---|---|
| `server/sql/squads-inventario-readonly.js` | inventário completo dos BLOCOS A, B, C, E, F, G, H, I em **1 comando** | `BEGIN; SET TRANSACTION READ ONLY;` … `ROLLBACK`. Nunca `COMMIT`, nunca DDL, nunca lê `access_token`/`refresh_token` |
| `server/sql/squads-preflight-relacao.js` | converte a relação humana → formato canônico, valida (BLOCOS J, K, L), gera o mapa pré-preenchido | **100% offline**. Não carrega `.env`, não abre conexão |
| `server/tests/squadsInventarioReadonly.test.js` | 38 verificações | inclui prova **estática** de que o extrator não escreve |
| `server/tests/squadsPreflightRelacao.test.js` | **191** verificações | round-trip esqueleto→parser→validação, estrutura real V2, recusa de principal implícito, resolução determinística de identidade, prova de zero-escrita |

**229 verificações novas. Suíte completa do backend: 176 arquivos verdes**
(174 do baseline + 2 novos), com os 4 pré-existentes conhecidos em `TEST_SKIP`.
**Zero regressão.**

### Arquitetura — por que não é um segundo sistema

```
relacao-squads.txt  →  squads-preflight-relacao.js  →  plano-p2-9.json  →  squads-migrate.js
   (humano)              (NOVO: offline)                (CANÔNICO,           (P2.3 EXISTENTE)
                                                         inalterado)
```

O validador novo **reutiliza literalmente** `validarPlano()` do tooling P2.3,
injetando um adaptador de banco falso alimentado pelo inventário. A lógica de
validação executada é **a real** — não uma cópia. Só foram **adicionadas** as
regras que o tooling não tem: os 6 Squads, 1 Coordenador **e** 1 Gestor por
Squad (distintos), marcadores temporários, completude Cliente/Usuário, resolução
determinística de nome humano → email/id, e a **recusa de escolher o Squad
principal** de quem está em 2+ Squads.

---

## 4. Índice

| # | Arquivo | Bloco | Estado |
|---|---|---|---|
| 00 | este resumo | — | — |
| 01 | `01_CLIENTES_REAIS.md` | A | método pronto · **0 inventariados (T-1)** |
| 02 | `02_CLIENTE_CONTAS_REAIS.md` | B | método pronto · **0 (T-1)** · *gap do pacote anterior, fechado* |
| 03 | `03_USUARIOS_REAIS.md` | C | método pronto · **0 (T-1)** · Gestores **0/6** |
| 04 | `04_ESTRUTURA_6_SQUADS.md` | D | **completo** — 6 slots, nada inventado |
| 05 | `05_ESTADO_SCHEMA_SQUADS.md` | E | **schema provado por DDL** · contagens (T-1) |
| 06 | `06_GRANTS_AMBIGUIDADES.md` | F | classificador pronto · **0 (T-1)** |
| 07 | `07_BASES_AMBIGUIDADES.md` | G | classificador pronto · **0 (T-1)** · *cobertura anterior era zero* |
| 08 | `08_DUPLICATAS_FINANCEIRO.md` | H | query + classificador prontos · **0 (T-1)** |
| 09 | `09_RESPONSABILIDADES_EVIDENCIAS.md` | I | query pronta (inclui histórico) · **0 (T-1)** |
| 10 | `10_MAPA_AGUARDANDO_RELACAO.md` | J | **completo** — gerador automático |
| 11 | `11_VALIDACAO_FUTURA_RELACAO.md` | K, L | **completo** — 74 verificações |
| 12 | `12_ROLLOUT_GATE_ATUAL.md` | N | **completo** — matriz reavaliada + T-1..T-7 |
| 13 | `13_SIMULACAO_ENFORCEMENT_ATUAL.md` | M | **completo** — provado por código |
| 14 | `14_O_QUE_FALTA_QUANDO_RELACAO_CHEGAR.md` | — | handoff da fase anterior |
| 15 | **`15_MEMBERSHIPS_RECEBIDAS.md`** | — | **← a relação real processada: composição, mapeamento de cargos, matriz PESSOA×SQUAD** |
| 16 | **`16_DECISOES_HUMANAS_PENDENTES.md`** | — | **← o handoff atual. Comece por ele.** |
| — | `entrada/relacao-squads-operacao-v1.txt` | — | **a relação REAL recebida** (formato V2) |
| — | `entrada/relacao-squads.PENDENTE_HUMANO.txt` | J | gabarito em branco (preservado; V1) |

---

## 5. Achados que não existiam antes desta auditoria

| # | Achado | Impacto |
|---|---|---|
| **T-3** | O "dry-run" do tooling **não é read-only**: `validarPlano` chama `ensureSquadsTables`, que **aplica DDL**. Vale também para `--audit`. | disciplina de auditoria — motivou o extrator read-only dedicado |
| **T-4** | `auditoria().pronto` pode ser **verdadeiro por vacuidade**: numa base sem clientes e sem internos, todos os contadores são 0 e o gate **libera** sem migração nenhuma. | irrelevante em produção · **relevante em staging novo** |
| **T-2** | `ROLES_INTERNAS` está definida **3 vezes com valores divergentes** (o importador inclui `admin`, os outros dois não). | sem bug hoje; risco de manutenção |
| — | O gate valida **completude**, não **correção** — um mapa completo porém errado passa e liga o enforcement com a carteira trocada. | é exatamente a lacuna que o validador novo cobre |
| — | `resumo.squadsCriados`/`squadsAtualizados` do `--apply` são inicializados em 0 e **nunca incrementados** — sempre reportam 0. | use `planejado.squads.criar.length` |
| — | Duplicata D4 em modo "cru" **não** casa `"Maio 2026"` com `"2026-05"` (período é texto livre). | rodar também o modo canônico do pacote anterior |

---

## 6. Veredito

```
ROLLOUT GATE HOJE:   NO-GO
MOTIVO PRINCIPAL:    aguardando relação CLIENTE→SQUAD
                     (Usuário→Squad JÁ CHEGOU — ver 15_MEMBERSHIPS_RECEBIDAS.md)
AINDA PENDENTE:      rótulo do 6º bloco · Design do 6º bloco ·
                     Squad principal de 3 pessoas multi-Squad ·
                     email/id das 23 pessoas · a carteira
OUTROS BLOQUEADORES: T-1 (banco), T-5 (JWT/Render), T-6 (deploy), T-7 (plantão)

SE ENFORCEMENT FOSSE LIGADO HOJE:  nada muda — o gate segura, ninguém perde acesso.

SQUADS_ENFORCEMENT:  OFF        BANCO ALTERADO:  NÃO
MIGRATION:           NÃO        APPLY:           NÃO
```

**Nenhum bloqueador é defeito de código.**
