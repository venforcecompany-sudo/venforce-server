# 03 — Inventário de usuários internos

> **BLOCO C.** Inventário dos usuários **sem atribuir Squad novo a ninguém**.
> Todos ficam `PENDENTE_RELACAO_USUARIO_SQUAD`, com **uma exceção prevista** —
> os 6 Gestores — que **não pôde ser exercida** (ver §4).

---

## 1. Estado

| | |
|---|---|
| **Usuários inventariados** | **0** — `REQUER BANCO` (bloqueador **T-1**) |
| **Extração pronta?** | **SIM** |
| **Squad atribuído a alguém?** | **NÃO. Zero.** |
| **Gestores registrados** | **0 / 6** — identidades não disponíveis em fonte confiável |

---

## 2. Modelo confirmado

`users` — `server/index.js:528-532`:

```sql
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
  nome TEXT NOT NULL DEFAULT '', ativo BOOLEAN NOT NULL DEFAULT true,
  role TEXT NOT NULL DEFAULT 'user', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Busca por `ALTER TABLE users`: zero ocorrências — 7 colunas, conjunto completo.

### `role` não tem CHECK no banco

É `TEXT` puro; toda a validação é de aplicação. Roles observadas:

| Role | Classe | Precisa de Squad? |
|---|---|---|
| `user` | interna (default da coluna) | **SIM** |
| `membro` | interna | **SIM** |
| `interno` | interna (nenhum caminho de código atribui; existe para dado legado) | **SIM** |
| `admin` | admin | **NÃO** — bypass global, idêntico com enforcement ON e OFF |
| `seller` | externa | **NÃO** — isolado por `seller_clientes`, o flag nunca o toca |
| `shopee_reviewer` | externa | **NÃO** — sem carteira operacional (`[]`) em qualquer estado |

> ⚠️ **`ROLES_INTERNAS` está triplicada no código com valores divergentes** —
> `squadsMigracaoImportService.js:31` inclui `"admin"`, os outros dois não.
> Registrado como risco **T-2** em `12_ROLLOUT_GATE_ATUAL.md`. Este inventário
> e o validador usam a lista da **auditoria** (`["user","membro","interno"]`),
> porque é ela que decide `pronto` e, portanto, o rollout gate.

---

## 3. Queries do inventário

```sql
-- identidade
SELECT id, nome, email, role, ativo FROM users ORDER BY id ASC;

-- memberships existentes (hoje: esperado vazio)
SELECT id, squad_id, user_id, is_primary, funcao, ativo
  FROM squad_members ORDER BY id ASC;
```

Cobre o BLOCO C:

| Campo pedido | Origem |
|---|---|
| id · nome · email · role · ativo/inativo | `users` |
| seller/interno | derivado de `role` (tabela §2) |
| memberships existentes | `squad_members` |
| Squad principal existente | `squad_members.is_primary` |
| responsabilidades existentes | `cliente_responsaveis` → `09_...md` |
| **squad novo** | **`PENDENTE_RELACAO_USUARIO_SQUAD`** |

> Melhora sobre o pacote anterior: antes era preciso cruzar manualmente
> `queries/01_inventario.sql` (identidade) com `queries/02_estado_squads.sql`
> (memberships), em arquivos diferentes. Agora sai num único JSON.

---

## 4. A exceção dos 6 Gestores — prevista, mas **não exercida**

O BLOCO C permite registrar os 6 Gestores *"se essa relação estiver
explicitamente disponível em fonte confiável"*.

**Ela não está.** Busca executada no repositório inteiro:

```
grep -ri "gestor(es) do squad | nome oficial | squad 1..6"  → só exemplos fictícios
grep -riE "(6|seis) squads"                                 → ZERO ocorrências
```

Os únicos nomes de Squad no repositório são `squad-exemplo-a/b`
(`SQUADS_MIGRATION_TEMPLATE.example.json:7-8`), `Squad Alpha`
(`VENFORCE_V3_SQUADS_AUTH_READINESS.md:354`) e as fixtures de teste
`alpha`/`arquivado`. Nenhum é fonte oficial.

**Portanto: `GESTOR: PENDENTE_DADO_HUMANO` para os 6.** Ver `04_ESTRUTURA_6_SQUADS.md`.

### Sobre `data/users.json` — por que **não** foi usado

O repositório versiona `data/users.json` com **23 pessoas de nome real**. Ele
**não** foi usado como fonte do inventário, por 4 razões objetivas:

| Motivo | Evidência |
|---|---|
| É o store **pré-Postgres** | não tem coluna `role`; a tabela `users` tem |
| Domínio **antigo** | `@vendexcompany.com`, não `@venforce.com` |
| Senhas em texto puro, todas iguais | `"senha": "123456"` em todas as 23 linhas — fixture de desenvolvimento |
| Não diz nada sobre Squad | não há campo de squad, gestor ou carteira |

Ele é, no máximo, **EVIDÊNCIA_FRACA** de quem *pode* estar no time — e
**nenhuma** evidência de quem é Gestor de qual Squad. Registrado em
`09_RESPONSABILIDADES_EVIDENCIAS.md`; **não** foi usado para decidir nada.

> Os nomes não são reproduzidos aqui: já estão versionados em `data/users.json`,
> e copiá-los para mais um documento só espalharia dado pessoal sem ganho.

---

## 5. Regras que o validador aplicará à relação de usuários

| Regra | Classe |
|---|---|
| usuário citado não existe em `users` | `ERRO_ESTRUTURAL` (`USUARIO_INEXISTENTE`) |
| mesmo usuário 2× no mesmo Squad | `ERRO_ESTRUTURAL` (`MEMBERSHIP_DUPLICADA`) |
| usuário em N Squads | **permitido** → `AVISO` (o 1º vira principal) |
| usuário marcado principal em 2 Squads | `ERRO_ESTRUTURAL` (tooling P2.3) |
| interno ativo fora de todo Squad | `PENDENTE_ESPERADO` (`USUARIO_SEM_MEMBERSHIP`) |
| `admin` fora de todo Squad | **nada** — admin é bypass, não precisa de membership |
| `seller` / `shopee_reviewer` num Squad | `AVISO` do tooling — membership não faz efeito para essas roles |
