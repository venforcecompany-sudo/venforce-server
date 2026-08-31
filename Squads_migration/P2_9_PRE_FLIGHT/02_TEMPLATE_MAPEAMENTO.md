# 02 — Template de mapeamento (formato do tooling P2.3)

> **Formato canônico já existe:** `Squads_migration/SQUADS_MIGRATION_TEMPLATE.json`
> (esqueleto + doc inline) e `SQUADS_MIGRATION_TEMPLATE.example.json` (exemplo
> fictício). **NÃO criar outro formato.** Este documento só ensina a preencher
> o canônico. A cópia de trabalho fica em
> `templates/plano-p2-9.PENDENTE_HUMANO.json` (idêntica ao canônico, arrays
> vazios — pronta para receber os dados de `01`).

---

## 1. Estrutura (exata, aceita por `squadsMigracaoImportService.js`)

```jsonc
{
  "versao": 1,                       // qualquer coisa != 1 → aviso
  "descricao": "P2.9 — migração inicial de Squads",

  "squads": [
    { "slug": "PENDENTE_HUMANO", "nome": "PENDENTE_HUMANO", "ativo": true }
  ],

  "membros": [
    { "squad": "PENDENTE_HUMANO", "usuario": "PENDENTE_HUMANO@empresa.com",
      "funcao": "membro", "principal": true }
  ],

  "clientes": [
    { "cliente": "PENDENTE_HUMANO", "squad": "PENDENTE_HUMANO",
      "motivo": "migração inicial P2.9" }
  ],

  "responsaveis": [
    { "cliente": "PENDENTE_HUMANO", "usuario": "PENDENTE_HUMANO@empresa.com",
      "papel": "gestor" }
  ]
}
```

Chaves que começam com `_` (ex.: `_doc_squads`) são **ignoradas** pela
ferramenta — servem só para documentar o arquivo.

---

## 2. Campo a campo

### `squads[]`

| Campo | Obrigatório | Regras |
|---|---|---|
| `slug` | sim | minúsculo, sem espaço. É **normalizado** (`normalizarSlug`); se mudar, gera aviso. Duplicado no plano → **erro**. |
| `nome` | sim | não-vazio (`btrim(nome) <> ''` no schema). |
| `ativo` | não (default `true`) | boolean. `false` → o Squad existe mas **não concede carteira**; membership/atribuição para ele → **erro**. |

Idempotente: se o `slug` já existe no banco, `nome`/`ativo` são **atualizados**
(`ON CONFLICT (slug) DO UPDATE`).

### `membros[]` — vínculo usuário ↔ squad

| Campo | Obrigatório | Regras |
|---|---|---|
| `squad` | sim | slug (do plano **ou** já existente no banco). Inexistente → **erro**. |
| `usuario` | sim | **email** OU **id numérico**. Não encontrado em `users` → **erro**. Role não-interna → **aviso** (membership não faz efeito). |
| `funcao` | não (default `"membro"`) | `"membro"` \| `"coordenador"`. Outro valor → **erro**. |
| `principal` | não | boolean. No máx. 1 `true` por usuário **em todo o plano** → senão **erro**. Se nenhum `true` e o usuário não tem principal no banco → **aviso** (1ª membership auto-promovida). |

Idempotente: `ON CONFLICT (squad_id, user_id) DO UPDATE SET ativo=true, funcao, is_primary`.
Membership duplicada no plano (mesmo squad+usuário) → **erro**.

### `clientes[]` — vínculo cliente ↔ squad (a carteira)

| Campo | Obrigatório | Regras |
|---|---|---|
| `cliente` | sim | **slug** OU **id numérico**. Não encontrado → **erro**. Inativo → **aviso**. |
| `squad` | sim | slug. Inexistente → **erro**. Inativo → **erro**. |
| `motivo` | não | texto livre → vai para `cliente_squad_history.motivo`. |

Comportamento:
- cliente **sem** vínculo aberto → **atribuir** (nova linha em `cliente_squad_history`).
- cliente **já no mesmo** Squad → **no-op** (não gera nova linha de histórico).
- cliente **em outro** Squad → **transferência**: fecha a linha aberta
  (`fim_em = NOW()`) + abre a nova. **Nada é apagado.** Gera **aviso**.
  - Na transferência, responsabilidades de quem **não** é membro do Squad de
    destino são encerradas (`cliente_responsaveis.ativo=false`,
    `motivo='transferencia_squad'`). O passo 4 do plano pode reatribuir logo em
    seguida.
- mesmo cliente em **2 Squads diferentes no plano** → **erro**.

### `responsaveis[]` — OPCIONAL. **NÃO é autorização.**

| Campo | Obrigatório | Regras |
|---|---|---|
| `cliente` | sim | slug OU id. |
| `usuario` | sim | email OU id. |
| `papel` | sim | `"gestor"` \| `"auxiliar"` \| `"designer"`. Outro → **erro**. |

Idempotente: `ON CONFLICT (cliente_id, user_id, papel) DO UPDATE SET ativo=true`.
Repetido no plano → **aviso**.

---

## 3. De onde vem cada valor

| Coluna do plano | Fonte |
|---|---|
| `squads[]` | `03_CHECKLIST_GESTAO.md` perguntas 1–2 (decisão humana) |
| `membros[].squad` / `principal` / `funcao` | `01` seção 3 (decisão humana) |
| `membros[].usuario` | `queries/usuarios_internos.sql` (email é a chave preferida) |
| `clientes[].cliente` | `queries/clientes_ativos.sql` (slug é a chave preferida) |
| `clientes[].squad` | `01` seção 2 (decisão humana) |
| `responsaveis[]` | `01` seção 4 (decisão humana, opcional) |

---

## 4. O que a ferramenta faz com o plano (resumo — detalhe em `09`)

```
node server/sql/squads-migrate.js --audit                        # fotografia inicial (read-only)
node server/sql/squads-migrate.js --plan plano-p2-9.json         # DRY-RUN: valida, NÃO escreve
node server/sql/squads-migrate.js --plan plano-p2-9.json --apply --actor <userIdAdmin>
node server/sql/squads-migrate.js --plan plano-p2-9.json --json  # saída JSON crua p/ anexar ao registro
```

- Dry-run é o **padrão** (sem `--apply`). Valida schema + banco, produz
  relatório `antes` / `planejado` / `avisos` / `erros`. **Não abre transação de
  escrita.**
- `--apply` roda tudo em **uma transação** (`BEGIN … COMMIT`). Qualquer erro →
  `ROLLBACK` total. Idempotente.
- **Qualquer erro na validação → `--apply` recusa e nada é escrito.**
- Exit codes: `0` ok · `2` plano inválido · `3` erro de execução (rollback) ·
  `1` erro de ambiente.

---

## 5. Regra de ouro

> Se um valor não é conhecido, ele fica `PENDENTE_HUMANO` no rascunho e a linha
> **não entra** no plano final até a operação confirmar. Um plano com
> `PENDENTE_HUMANO` literal **falha no dry-run** (slug/usuário/cliente
> inexistente) — de propósito: o dry-run é a rede que impede aplicar um plano
> incompleto.
