# 04 — Auditoria pré-migração (READ-ONLY)

> **Todas as queries deste arquivo e da pasta `queries/` são `SELECT`.** Nenhuma
> escreve. Podem ser executadas numa cópia de desenvolvimento/staging **ou** em
> produção **em modo leitura** (idealmente com um usuário DB `readonly` ou numa
> réplica). **NUNCA rodar com intenção de escrita em produção.**
>
> Objetivo: a fotografia que a reunião de `03` precisa + o baseline `ANTES` que
> o `--audit` do tooling P2.3 vai comparar.

---

## 1. Duas fontes, mesma verdade

| Fonte | O que dá | Quando usar |
|---|---|---|
| `node server/sql/squads-migrate.js --audit` | JSON completo: `auditoria` (categorias de cliente/usuário, `pronto`, `integridade`, `atencao`) + `totais`. **É a fonte canônica** — usa exatamente a mesma lógica que `GET /squads/migracao/auditoria`. | sempre que houver acesso a rodar Node com `DATABASE_URL` |
| `queries/*.sql` (abaixo) | as mesmas contagens em SQL cru, linha a linha, para imprimir/planilhar | reunião com a gestão; quando só há um cliente SQL |

As duas **devem bater**. Se divergirem, a do tooling vence (ela é a que o gate
`pronto` usa).

---

## 2. Arquivos de query (todos `SELECT`)

| Arquivo | Cobre | Categoria da auditoria do tooling |
|---|---|---|
| `queries/01_inventario.sql` | clientes ativos/inativos; clientes sem conta; clientes multi-conta; usuários internos ativos/inativos; sellers; admins; contas órfãs; entregas órfãs | `clientesAtivos.total`, `usuariosInternos.total`, "possui conta?", "nº de ClienteContas" |
| `queries/02_estado_squads.sql` | squads; memberships ativas; vínculos Cliente→Squad abertos; responsáveis ativos; coordenadores; clientes ativos sem Squad; internos sem membership | `clientesAtivos.semSquad` (0 p/ `pronto`), `usuariosInternos.semMembership` (0 p/ `pronto`) |
| `queries/03_inconsistencias.sql` | vínculo Cliente→Squad duplicado (**BLOQUEANTE**); principal duplicado; usuário só em Squad inativo; membership de usuário desativado; responsável fora do Squad; cliente em Squad inativo | `integridade.*`, `atencao.*`, `usuariosInternos.comPrincipalDuplicado` / `apenasEmSquadInativo` |
| `queries/d4_duplicatas_fechamento.sql` | ver `05_AUDITORIA_DUPLICATAS_FINANCEIRO.md` | — (D4, unicidade de `entregas_cliente`) |
| `queries/d4_classificacao.sql` | classifica as duplicatas D4 em A/B/C/D | — |

---

## 3. Estado esperado HOJE (produção, pré-P2.9)

Como a migração **nunca rodou**:

```
squads                     = 0
squad_members              = 0
cliente_squad_history      = 0
cliente_responsaveis       = 0 (ou pouquíssimos, se alguém testou a API)

auditoria.clientesAtivos.semSquad      = <total de clientes ativos>   (todos)
auditoria.usuariosInternos.semMembership = <total de internos>        (todos)
auditoria.pronto                        = false
```

Isso é **normal** e é exatamente o que o enforcement OFF cobre: interno vê tudo.
O trabalho de P2.9 é levar `semSquad` e `semMembership` a `0` (ou a exceções
explicitamente aceitas), e então `pronto` vira `true`.

---

## 4. Como rodar

```bash
# tooling (canônico) — precisa DATABASE_URL apontando para a base a auditar
DATABASE_URL="postgres://READONLY_USER:...@host/db" \
  node server/sql/squads-migrate.js --audit | tee p2-9-auditoria-ANTES.json

# queries cruas — psql (cada arquivo tem vários SELECT com \echo de cabeçalho)
psql "$DATABASE_URL" -f Squads_migration/P2_9_PRE_FLIGHT/queries/01_inventario.sql
psql "$DATABASE_URL" -f Squads_migration/P2_9_PRE_FLIGHT/queries/02_estado_squads.sql
psql "$DATABASE_URL" -f Squads_migration/P2_9_PRE_FLIGHT/queries/03_inconsistencias.sql
```

Guardar `p2-9-auditoria-ANTES.json` — é a evidência do item "Auditoria inicial"
da matriz `08_GO_NO_GO.md`.

---

## 5. O que NÃO fazer

- Não rodar `--apply`.
- Não rodar as queries num cliente com transação de escrita aberta "por
  garantia" — elas são `SELECT`, ponto.
- Não popular `squads`/`squad_members`/`cliente_squad_history` "só para testar
  a auditoria". O teste da auditoria já existe (`squadsMigracaoAuditoriaY.test.js`,
  `squadsMigracaoImport.test.js`).
