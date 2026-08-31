# 01 — Dados humanos necessários para P2.9

> Inventário completo do que a **operação** precisa fornecer antes do rollout.
> Nada aqui é inventado. Onde o valor real não é conhecido: **`PENDENTE_HUMANO`**.
>
> Fonte dos requisitos: `VENFORCE_V3_BACKEND_RELEASE_CANDIDATE.md` §13 (gate
> GO/NO-GO), `VENFORCE_V3_SQUADS_DATA_MIGRATION_RUNBOOK.md` §3/§8, e o formato
> aceito por `server/services/squads/squadsMigracaoImportService.js`.

---

## 0. Princípios

1. **Squad = carteira.** Define QUAIS clientes um interno acessa. Nada mais.
2. **Responsabilidade ≠ autorização.** `gestor`/`auxiliar`/`designer` é
   organização; o acesso vem do Squad. `authorizationService` não lê
   `cliente_responsaveis`.
3. **`is_primary` (membership) não limita acesso** — é só default de UX.
   Multi-Squad = **união** dos Squads ativos.
4. **Sem backfill automático.** Cliente ativo sem Squad e interno sem
   membership são **pendências de migração**, nunca atribuídos a um Squad
   fictício. Com enforcement ON, essas pendências viram carteira vazia / 403.
5. O vínculo Squad é no **Cliente**, não na ClienteConta. ML1 e ML2 de um
   cliente **não** podem ficar em Squads diferentes.

---

## 1. SQUADS — quais unidades operacionais existem

Para **cada** Squad real:

| Campo | Origem | Regras | Valor |
|---|---|---|---|
| `nome` | gestão | obrigatório, não-vazio | `PENDENTE_HUMANO` |
| `slug` | derivado do nome | minúsculo, sem espaço (a ferramenta normaliza) | `PENDENTE_HUMANO` |
| `ativo` | gestão | default `true`; um Squad `ativo:false` **não concede carteira** | `PENDENTE_HUMANO` |

> Quantos Squads? Quais nomes oficiais? → `03_CHECKLIST_GESTAO.md` perguntas 1–2.

---

## 2. CLIENTES — qual cliente pertence a qual Squad

A lista-base de clientes sai da auditoria read-only (`04`, `queries/clientes_ativos.sql`).
A operação preenche a coluna **Squad desejado**.

| Campo | Como obter | Preenchido por |
|---|---|---|
| `cliente_id` | `SELECT id FROM clientes` (query 04) | auditoria |
| `cliente_slug` | `SELECT slug FROM clientes` | auditoria |
| `nome` | `SELECT nome FROM clientes` | auditoria |
| `ativo` | `SELECT ativo FROM clientes` | auditoria |
| **Squad atual desejado** | decisão da gestão | **`PENDENTE_HUMANO`** |
| possui conta? | `queries/clientes_sem_conta.sql` | auditoria |
| nº de ClienteContas | `queries/clientes_multi_conta.sql` | auditoria |
| observação de migração | gestão (ex.: "sem Squad por ora", "encerrando contrato") | `PENDENTE_HUMANO` |

**Planilha de trabalho sugerida** (uma linha por cliente ativo):

```
cliente_id | cliente_slug | nome | ativo | contas | squad_slug_desejado | observacao
-----------+--------------+------+-------+--------+---------------------+-----------
   <auto>  |    <auto>    | <auto>| <auto>| <auto> |   PENDENTE_HUMANO    | PENDENTE_HUMANO
```

Casos que precisam de decisão explícita (ver `03` perguntas 8, 10):
- **Cliente ativo que ficará temporariamente sem Squad** → **não** colocar no
  plano. Ele fica como pendência conhecida; com enforcement ON ninguém interno
  o vê até receber Squad. Registrar em `observacao`.
- **Cliente inativo** → em geral **não** entra no plano (a auditoria só conta
  clientes ativos para `pronto`). Se precisar de carteira mesmo inativo,
  decisão humana.
- **Cliente com 2+ contas** → o Squad é do cliente; as contas seguem por
  herança. Só confirmar que não há intenção de separar as contas em Squads
  diferentes (não é suportado).

---

## 3. USUÁRIOS — quem participa de qual Squad

Lista-base: `04`, `queries/usuarios_internos.sql` (roles `user`/`membro`/`interno`;
`admin` é bypass e **não precisa** de membership; `seller`/`shopee_reviewer`
**não entram** em Squad).

| Campo | Como obter | Preenchido por |
|---|---|---|
| `user_id` | query 04 | auditoria |
| `nome` | `SELECT nome FROM users` | auditoria |
| `email` | `SELECT email FROM users` (chave natural preferida no plano) | auditoria |
| `role` | `SELECT role FROM users` | auditoria |
| `ativo` | `SELECT ativo FROM users` | auditoria |
| **Squad principal desejado** | gestão | **`PENDENTE_HUMANO`** |
| **Squads adicionais** | gestão (multi-Squad = união) | **`PENDENTE_HUMANO`** |
| **função no Squad** (`membro` \| `coordenador`) | gestão | **`PENDENTE_HUMANO`** |

**Planilha de trabalho sugerida** (uma linha por membership — um usuário
multi-Squad tem N linhas):

```
user_id | email | nome | role | ativo | squad_slug | principal | funcao
--------+-------+------+------+-------+------------+-----------+-------
 <auto> | <auto>| <auto>| <auto>| <auto>| PENDENTE_HUMANO | PENDENTE_HUMANO | PENDENTE_HUMANO
```

Regras que a ferramenta impõe (dry-run rejeita se violado):
- **1 principal por usuário** (índice parcial único). Se nenhuma linha marcar
  `principal:true`, a 1ª membership vira principal automaticamente (só aviso).
- Membership para **Squad inativo** → **erro** (não concede carteira).
- `funcao` fora de `membro`/`coordenador` → **erro**.
- Usuário não encontrado em `users` → **erro**.

Casos que precisam de decisão (ver `03` perguntas 6, 9, 11):
- **Interno que não deve entrar em nenhum Squad** → **não** colocar no plano.
  Com enforcement ON, ele fica com carteira vazia (403). Se isso não for
  desejado, ele precisa de Squad OU não deveria ter role interna. Decisão
  humana. Registrar.
- **Coordenador** → `funcao: "coordenador"` na(s) membership(s) do Squad que ele
  coordena. Coordenador administra o **próprio** Squad; **não** herda permissão
  global; **não** transfere cliente entre Squads (admin-only).
- **Usuário inativo com role interna** → em geral **não** entra no plano
  (membership de usuário inativo só suja a contagem — a auditoria a reporta em
  `atencao`). Decisão humana se for reativado.

---

## 4. RESPONSABILIDADES (opcional, não bloqueia o isolamento)

Por cliente, quem é `gestor` / `auxiliar` / `designer`. **Não** é autorização.
Alimenta o flag `responsavelDireto` na Carteira (`/me/portfolio`).

| Campo | Preenchido por |
|---|---|
| `cliente` (slug ou id) | auditoria + gestão |
| `usuario` (email ou id) | gestão |
| `papel` (`gestor` \| `auxiliar` \| `designer`) | gestão |

**Planilha de trabalho sugerida:**

```
cliente_slug | gestor (email) | auxiliar (email) | designer (email)
-------------+----------------+------------------+----------------
   <auto>    | PENDENTE_HUMANO| PENDENTE_HUMANO  | PENDENTE_HUMANO
```

> "coordenador quando aplicável": coordenador é atributo da **membership**
> (`funcao` na seção 3), não da responsabilidade. Não há papel "coordenador"
> em `cliente_responsaveis` (CHECK aceita só `gestor`/`auxiliar`/`designer`).

**Alerta de consistência (auditoria P2.8 BLOCO Y):** se uma pessoa for
responsável (`gestor`/etc.) por um cliente mas **não** for membro do Squad
desse cliente, quando o enforcement ligar ela **deixa de conseguir abrir** o
cliente pelo qual responde. A auditoria mostra isso em
`atencao.responsaveisForaDoSquad`. Corrigir = mover o cliente de Squad **ou** a
pessoa para o Squad. Decisão humana **antes** do canário.

---

## 5. Resumo do que é `PENDENTE_HUMANO`

| Bloco | Item pendente |
|---|---|
| Squads | lista completa: nome oficial, slug, ativo |
| Clientes | `squad_slug_desejado` por cliente ativo; lista de clientes que ficam sem Squad |
| Usuários | `squad` principal + adicionais + `funcao` por interno; lista de internos que não entram em Squad nenhum |
| Responsáveis | gestor/auxiliar/designer por cliente (opcional) |
| Canário | qual Squad vai primeiro (ver `07`, `03` pergunta 12) |
| JWT | ver `06` — pode já estar configurado; precisa confirmação humana com acesso ao Render |
| Rollback | quem fica de plantão com autoridade para `SQUADS_ENFORCEMENT=off` (ver `08`) |

Nada além dos dados de auditoria (que saem das queries read-only de `04`/`05`)
pode ser preenchido sem a operação.
