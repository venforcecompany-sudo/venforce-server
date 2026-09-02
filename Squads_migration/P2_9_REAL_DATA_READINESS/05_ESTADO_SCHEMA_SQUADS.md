# 05 — Estado real do schema de Squads

> **BLOCO E.** Auditoria feita por **leitura de código e DDL**, não por consulta
> ao banco — ver `00_RESUMO.md` §"Bloqueador técnico T-1" (não há
> `DATABASE_URL` neste checkout). Onde a resposta depende do banco, está
> marcado como **REQUER BANCO**.

---

## 1. O schema existe?

**SIM — o DDL existe, é canônico e é aplicado automaticamente no boot.**

| Tabela | Onde é criada | Aplicação |
|---|---|---|
| `squads` | `server/sql/migrations/20260827_squads_foundation.sql:23-45` | automática no boot |
| `squad_members` | idem `:56-87` | automática no boot |
| `cliente_squad_history` | idem `:97-119` | automática no boot |
| `cliente_responsaveis` | idem `:127-149` + `20260828_cliente_responsaveis_p24.sql:26-37` | automática no boot |

### Como é aplicado (não há runner de migração)

`server/services/squads/squadsRepository.js:19-37` relê os **dois** arquivos de
migração e os reexecuta:

```js
const migrationFiles = [
  "20260827_squads_foundation.sql",
  "20260828_cliente_responsaveis_p24.sql",
];
async function ensureSquadsTables(db = pool) {
  if (_ensured && db === pool) return;
  for (const nome of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, nome), "utf8");
    await db.query(sql);
  }
  ...
}
```

Chamado no boot em `server/index.js:1886-1890`, antes da auditoria do rollout
gate. Todo o DDL é idempotente (`CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`).

> **Não existe tabela de controle de migrações.** Busca por `schema_migrations`
> no repositório inteiro: **zero ocorrências**. Não há `knex`/`sequelize`/
> `umzug`/`node-pg-migrate` nas dependências. A idempotência do próprio SQL é o
> único mecanismo.
>
> **Consequência prática:** só é possível afirmar que as tabelas existem em
> produção se o processo tiver dado boot com sucesso. Não dá para provar pelo
> repositório. Ver §4.

---

## 2. Constraints que a migração já garante (relevantes para P2.9)

Estas são as travas que o banco impõe **independentemente do código** — valem
como rede de segurança para o rollout:

| Índice / constraint | Tabela | O que garante |
|---|---|---|
| `uq_squads_slug` (UNIQUE) | `squads` | slug único |
| `squads_nome_nao_vazio` (CHECK) | `squads` | `btrim(nome) <> ''` |
| `squads_slug_nao_vazio` (CHECK) | `squads` | `btrim(slug) <> ''` |
| `uq_squad_members_squad_user` (UNIQUE) | `squad_members` | 1 linha por (squad, usuário) — reativar é `UPDATE`, nunca 2ª linha |
| **`uq_squad_members_primary_por_user`** (UNIQUE **PARCIAL**) | `squad_members` | `WHERE is_primary = true AND ativo = true` → **no máximo 1 Squad principal ativo por usuário** |
| `squad_members_funcao_check` (CHECK) | `squad_members` | `funcao IN ('membro','coordenador')` |
| **`uq_cliente_squad_ativo`** (UNIQUE **PARCIAL**) | `cliente_squad_history` | `WHERE fim_em IS NULL` → **no máximo 1 Squad aberto por Cliente** |
| `cliente_responsaveis_papel_check` (CHECK) | `cliente_responsaveis` | `papel IN ('gestor','auxiliar','designer')` |
| `uq_cliente_responsaveis_cliente_user_papel` (UNIQUE) | `cliente_responsaveis` | idempotência do `ON CONFLICT` do importador |

Chaves estrangeiras relevantes:
`squad_members.squad_id → squads(id) ON DELETE CASCADE` ·
`cliente_squad_history.squad_id → squads(id) **ON DELETE RESTRICT**` (um Squad
com histórico não pode ser apagado) ·
`cliente_squad_history.cliente_id → clientes(id) ON DELETE CASCADE`.

**Não há triggers** em nenhuma das 4 tabelas (verificado: zero `CREATE TRIGGER`
nos dois arquivos de migração).

---

## 3. Quantos registros existem? Há dados reais?

**REQUER BANCO.** Não foi possível contar — sem `DATABASE_URL`.

O que se sabe **sem** banco, por evidência documental convergente:

| Evidência | Diz |
|---|---|
| `VENFORCE_V3_FINAL_CONVERGENCE_CLOSURE.md:189-194` | "Rollout real de dados: **NÃO EXECUTADO**" |
| `P2_9_PRE_FLIGHT/04_AUDITORIA_PRE_MIGRACAO.md:41-50` | estado esperado hoje: `squads = 0`, `squad_members = 0`, `cliente_squad_history = 0` |
| `20260827_squads_foundation.sql:154-160` | "**NENHUM BACKFILL AUTOMÁTICO**" — clientes sem squad são pendências, nunca atribuídos a squad aleatório |
| Ausência de qualquer invocação de `--apply` em CI ou `package.json` | nada aplicou o plano automaticamente |

**Conclusão declarada (a confirmar com banco):**

```
SCHEMA PRONTO
DADOS OPERACIONAIS AINDA NÃO MIGRADOS
```

### Fixtures indevidas? Migração parcial?

Não há evidência de fixture no banco. As únicas fixtures de Squad no
repositório vivem **em memória, dentro de testes**
(`server/tests/squadsMigracaoImport.test.js` — squads `alpha`/`arquivado`) e
nunca tocam Postgres: o teste monkey-patcha o `pool` antes de qualquer uso.

`cliente_responsaveis` é a única que pode legitimamente ter linhas hoje sem
migração — a API de responsáveis (P2.4) está no ar e alguém pode tê-la usado.
`04_AUDITORIA_PRE_MIGRACAO.md:45` já previa isso ("ou pouquíssimos, se alguém
testou a API"). Conferir no inventário.

---

## 4. Como confirmar em 1 comando quando houver acesso

```bash
DATABASE_URL="postgres://READONLY:...@host/db" \
  node server/sql/squads-inventario-readonly.js --saida inventario.json --resumo
```

O bloco `resumo.squads` responde as 4 perguntas de uma vez:

```json
"squads": { "squads": 0, "memberships": 0, "vinculosAbertos": 0, "responsaveisAtivos": 0 }
```

E `schema.tabelas` responde "o schema existe?" com `to_regclass` — sem aplicar
DDL nenhum:

```json
"schema": { "tabelas": { "squads": true, "squad_members": true, ... } }
```

> ⚠️ **Não use `squads-migrate.js --audit` para responder "o schema existe?".**
> Esse caminho chama `ensureSquadsTables()`, que **aplica DDL** — ver
> `12_ROLLOUT_GATE_ATUAL.md` risco **T-3**. O inventário read-only foi escrito
> exatamente para evitar isso.

---

## 5. Estado consolidado

| Pergunta do BLOCO E | Resposta |
|---|---|
| Schema existe? | **SIM** (DDL canônico + aplicado no boot) |
| Quantos registros? | **REQUER BANCO** |
| Existem dados reais? | **Muito provavelmente não** (4 evidências convergentes) — confirmar |
| Existem dados parciais? | Não há evidência; `cliente_responsaveis` é a única plausível |
| Existem fixtures indevidas? | **Não** — as fixtures são em memória, dentro de testes |
| Existe migração parcial? | **Não** — o DDL é tudo-ou-nada e idempotente; dados nunca rodaram |
| Algo foi modificado por esta auditoria? | **NÃO. Zero escrita, zero DDL, zero conexão.** |
