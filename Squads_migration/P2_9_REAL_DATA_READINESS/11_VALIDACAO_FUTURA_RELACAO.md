# 11 — Validação da futura relação

> **BLOCOS K + L.** O validador que recebe a relação humana, e a separação
> entre `PENDENTE_ESPERADO` e `ERRO_ESTRUTURAL`.
>
> **Entregue, implementado e testado: 74 verificações verdes.**

---

## 1. O que existe e o que foi adicionado

O tooling P2.3 (`validarPlano`) **já validava muita coisa** — e não foi
reimplementado. O validador novo o **reutiliza literalmente**, offline.

### Já existia no tooling P2.3 (reaproveitado, não reescrito)

| Checagem | Classe |
|---|---|
| slug de Squad duplicado no plano | erro |
| Squad inexistente / inativo (referenciado por membro ou cliente) | erro |
| Cliente inexistente · Cliente inativo | erro · aviso |
| mesmo Cliente em 2 Squads no plano | erro |
| Usuário inexistente · role não interna · usuário inativo | erro · aviso · aviso |
| `funcao` inválida (fora de `membro`/`coordenador`) | erro |
| usuário marcado principal em 2+ Squads | erro |
| membership duplicada no plano | erro |
| `papel` inválido em `responsaveis` | erro |
| transferência de Squad (histórico preservado) | aviso |

### Adicionado por esta entrega (o tooling **não** tinha)

| Checagem | Código | Classe | Por quê o tooling não tem |
|---|---|---|---|
| **exatamente 6 Squads** | `SQUADS_QUANTIDADE_INVALIDA` | erro | regra de produto, não de schema |
| **nome de Squad duplicado** | `SQUAD_NOME_DUPLICADO` | erro | o tooling só checa **slug**; dois Squads podem ter nomes iguais e slugs diferentes |
| **1 Gestor por Squad** | `SQUAD_SEM_GESTOR` / `SQUAD_MULTIPLOS_GESTORES` | pendente / erro | "Gestor" não existe no formato canônico — é derivado |
| **identificador temporário vazado** | `SQUAD_IDENTIFICADOR_TEMPORARIO` | erro | `SQUAD_1..6` são de documentação; nunca podem ir ao banco |
| **marcador `PENDENTE_*` vazado** | `SQUAD_NOME_PENDENTE`, `CLIENTE_PENDENTE`, `MEMBRO_PENDENTE` | pendente | conceito desta fase |
| **Cliente ativo sem Squad** (completude) | `CLIENTE_SEM_SQUAD` | pendente | o tooling valida o plano, não a **cobertura** do universo |
| **interno ativo sem membership** | `USUARIO_SEM_MEMBERSHIP` | pendente | idem |
| **usuário em vários Squads** | `USUARIO_EM_VARIOS_SQUADS` | aviso | permitido; explicita qual vira principal |
| **Gestor repetido em `MEMBROS`** | `MEMBERSHIP_DUPLICADA` | erro | erro típico de digitação humana |
| **validação sem banco** | — | — | `validarPlano` exige um `db`; aqui ele recebe um adaptador falso |

---

## 2. Como o reuso funciona (sem sistema paralelo)

`validarPlano(plano, db)` aceita um **`db` injetável**. O validador constrói um
adaptador que responde, a partir do snapshot de inventário, exatamente as 5
consultas marcadas que `resolverEntidades()` emite:

| Marcador | Respondido com |
|---|---|
| `/* squads:MIG_RESOLVE_SQUADS */` | `inventario.squads` |
| `/* squads:MIG_RESOLVE_USERS */` | `inventario.usuarios` (por id ou email) |
| `/* squads:MIG_RESOLVE_CLIENTES */` | `inventario.clientes` (por id ou slug) |
| `/* squads:MIG_MEMBERSHIPS_EXISTENTES */` | `inventario.squad_members` |
| `/* squads:MIG_VINCULOS_EXISTENTES */` | `inventario.cliente_squad_history` abertos |
| qualquer outra (DDL do `ensureSquadsTables`) | `{ rows: [] }` — inerte |

É o **mesmo padrão** que `server/tests/squadsMigracaoImport.test.js` já usava
para testar o importador sem Postgres. A **lógica de validação executada é a
real**, não uma cópia.

> ⚠️ Isso também revela o risco **T-3**: `validarPlano` chama
> `ensureSquadsTables()`, que **aplica DDL**. Contra um banco real, o
> "dry-run" **escreve DDL**. Offline, o adaptador o torna inofensivo.

---

## 3. `PENDENTE_ESPERADO` × `ERRO_ESTRUTURAL` (BLOCO L)

A distinção é o que torna o validador útil **hoje**, com o mapa vazio.

| Classe | Significa | Efeito no veredito |
|---|---|---|
| **`ERRO_ESTRUTURAL`** | a relação está **errada**. Ninguém corrige isso esperando. | bloqueia · exit `2` · **nenhum plano é emitido** |
| **`PENDENTE_ESPERADO`** | a relação ainda **não chegou**. Não é defeito. | não bloqueia · exit `0` · veredito `AGUARDANDO_RELACAO` |
| **`AVISO`** | vale conferir, mas é legítimo. | não bloqueia |

Regra de ouro implementada: **sem inventário, "não encontrado" vira
`PENDENTE_ESPERADO`, não `ERRO_ESTRUTURAL`** — porque a ausência é consequência
do inventário vazio, não da relação. Com inventário, o erro do tooling vale.

### Os três vereditos

| Veredito | Quando | Exit |
|---|---|---|
| `AGUARDANDO_RELACAO` | zero erros, mas há pendências | `0` |
| `PRONTO_PARA_DRY_RUN` | zero erros e zero pendências | `0` |
| `ERRO_ESTRUTURAL` | ≥1 erro (ou pendência com `--estrito`) | `2` |

`--estrito` transforma pendência em erro — é o modo para **fechar** a relação,
quando ela deveria estar completa.

---

## 4. Regras do BLOCO L, uma a uma

| Regra exigida | Implementada como | Classe |
|---|---|---|
| exatamente 6 Squads | `SQUADS_QUANTIDADE_INVALIDA` | erro (0 Squads = **pendente**) |
| nome único | `SQUAD_NOME_DUPLICADO` | erro |
| slug único | `SQUAD_SLUG_DUPLICADO` + o do tooling | erro |
| 1 Gestor principal por Squad | `SQUAD_SEM_GESTOR` / `SQUAD_MULTIPLOS_GESTORES` | pendente / erro |
| Cliente ativo → exatamente 1 Squad | `CLIENTE_EM_DOIS_SQUADS` + `CLIENTE_SEM_SQUAD` | erro / pendente |
| usuário pode estar em N Squads | `USUARIO_EM_VARIOS_SQUADS` | aviso |
| exatamente 1 principal quando há membership | derivação automática + erro do tooling | erro |
| **não exigir Cliente em Squad agora** | `CLIENTE_SEM_SQUAD` é **pendente**, nunca erro | ✅ |

> **Sutileza corrigida durante a implementação:** "Squad sem clientes" era
> tratado como pendência sempre — o que travava o veredito num cenário
> perfeitamente legítimo (6 Squads, poucos clientes ⇒ algum Squad fica vazio).
> Hoje a regra é: **enquanto nenhum** Squad tem cliente, é pendência (a relação
> não chegou); **depois que algum** tem, um Squad vazio é só **aviso**. A regra
> de produto é *"todo Cliente ativo tem 1 Squad"*, não *"todo Squad tem Cliente"*.

---

## 5. Uso

```bash
# validar (offline, sem banco)
node server/sql/squads-preflight-relacao.js --relacao <rel.txt> --inventario inventario.json

# fechar: pendência vira erro
node server/sql/squads-preflight-relacao.js --relacao <rel.txt> --inventario inventario.json --estrito

# emitir o plano canônico (só se veredito for PRONTO_PARA_DRY_RUN)
node server/sql/squads-preflight-relacao.js --relacao <rel.txt> --inventario inventario.json \
  --emitir-plano plano-p2-9.json
```

> O plano **só é escrito** com veredito `PRONTO_PARA_DRY_RUN`. Um plano
> incompleto nunca chega ao `squads-migrate.js` — é a trava que impede aplicar
> um mapa pela metade.

---

## 6. Cobertura de teste

`server/tests/squadsPreflightRelacao.test.js` — **74 verificações**:

| Seção | Cobre |
|---|---|
| 1 | parser do formato de texto (blocos, listas, comentários, slug ausente) |
| 2 | conversão para o formato canônico (nenhum campo fora do formato) |
| 3 | 1 único principal por usuário em todo o plano |
| 4 | regra dos 6 Squads (5 / 7 / 6 / 0) |
| 5 | unicidade de nome e de slug (inclusive nome duplicado com slugs distintos) |
| 6 | 1 Gestor por Squad (ausente / marcador / múltiplos) |
| 7 | identificadores temporários e marcadores não vazam |
| 8 | Cliente em 2 Squads · repetido · membership duplicada · Gestor repetido em MEMBROS |
| 9 | usuário em vários Squads é aviso, nunca erro |
| 10 | existência contra inventário; admin não vira pendência |
| 11 | sem inventário → pendência, não erro |
| 12 | adaptador falso responde os 5 marcadores + DDL inerte |
| 13-14 | o `validarPlano` **real** é chamado e seus erros atravessam |
| 15-16 | estado de hoje → `AGUARDANDO_RELACAO`; `--estrito` → erro |
| 17 | relação completa → `PRONTO_PARA_DRY_RUN` + plano canônico |
| 18-19 | esqueleto (BLOCO J) e round-trip esqueleto→parser→validação |

Suíte completa do backend após a entrega: **176 arquivos verdes**
(174 do baseline + 2 novos), com os 4 pré-existentes conhecidos em `TEST_SKIP`.
