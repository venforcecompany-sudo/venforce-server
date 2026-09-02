# 01 — Inventário estrutural dos Clientes

> **BLOCO A.** Levantamento dos Clientes **sem nenhuma tentativa de atribuir
> Squad**. O campo `squad` fica, para todos, `PENDENTE_RELACAO_CLIENTE_SQUAD`.

---

## 1. Estado

| | |
|---|---|
| **Clientes inventariados** | **0 de N** — `REQUER BANCO` (bloqueador **T-1**) |
| **Extração pronta?** | **SIM** — 1 comando, read-only, testado |
| **Squad atribuído a alguém?** | **NÃO. Zero.** Por decisão explícita. |

Não há `DATABASE_URL` neste ambiente (ver `12_ROLLOUT_GATE_ATUAL.md` T-1), então
nenhum número real pôde ser produzido. O que foi entregue é a **máquina** que
produz o inventário completo assim que houver acesso de leitura.

---

## 2. Modelo de dados confirmado (por DDL, não por suposição)

`clientes` — criada em `server/index.js:549-556`:

```sql
CREATE TABLE IF NOT EXISTS clientes (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Estas 6 colunas são o conjunto completo** — busca por `ALTER TABLE clientes`
no repositório inteiro retorna zero ocorrências.

Achados estruturais relevantes para a migração:

- **Não existe soft delete.** `DELETE /clientes/:slug` é `DELETE` físico.
  `server/services/clientes/clienteDependenciasService.js:10` declara isso
  explicitamente. Consequência: um cliente removido **desaparece** do
  inventário — não vira "inativo". Se a relação humana citar um cliente que já
  não existe, o validador acusa `CLIENTE_INEXISTENTE`.
- `ativo` é a única marcação de estado. A auditoria de `pronto` só conta
  **clientes ativos**.
- `slug` é `UNIQUE NOT NULL` — por isso é a **chave natural preferida** no plano
  de migração (mais legível e estável que o id em revisão humana).

---

## 3. Como o inventário é produzido

```bash
DATABASE_URL="postgres://READONLY:...@host/db" \
  node server/sql/squads-inventario-readonly.js --saida inventario.json
```

Query executada (`server/sql/squads-inventario-readonly.js`, bloco A):

```sql
SELECT c.id, c.slug, c.nome, c.ativo,
       COALESCE(COUNT(cc.id), 0)::int                             AS contas_total,
       COALESCE(COUNT(cc.id) FILTER (WHERE cc.ativo), 0)::int     AS contas_ativas,
       COALESCE(COUNT(cc.id) FILTER (WHERE NOT cc.ativo), 0)::int AS contas_inativas,
       COALESCE(ARRAY_REMOVE(ARRAY_AGG(DISTINCT cc.marketplace)
                FILTER (WHERE cc.ativo), NULL), '{}')             AS marketplaces_ativos
  FROM clientes c
  LEFT JOIN cliente_contas cc ON cc.cliente_id = c.id
 GROUP BY c.id, c.slug, c.nome, c.ativo
 ORDER BY c.nome ASC;
```

Cobre, em uma linha por cliente, tudo que o BLOCO A pede:

| Campo pedido | Coluna |
|---|---|
| id · nome · slug · ativo/inativo | `id`, `nome`, `slug`, `ativo` |
| quantidade de ClienteContas | `contas_total` |
| contas ativas · contas inativas | `contas_ativas`, `contas_inativas` |
| marketplaces | `marketplaces_ativos` |
| Base | `07_BASES_AMBIGUIDADES.md` (bloco `base_vinculos`) |
| Grant | `06_GRANTS_AMBIGUIDADES.md` (bloco `grants`) |
| problemas estruturais | §4 abaixo |
| **squad** | **`PENDENTE_RELACAO_CLIENTE_SQUAD`** — não coletado, não inferido |

> Melhora sobre o pacote anterior: `P2_9_PRE_FLIGHT/queries/01_inventario.sql`
> SELECT 3 lista clientes **inativos sem** contagem de contas. A query acima
> trata ativos e inativos igual, numa passada só.

---

## 4. Problemas estruturais que o inventário já detecta

| Sinal | Como aparece | Por que importa para P2.9 |
|---|---|---|
| Cliente ativo **sem conta** | `contas_ativas = 0` | Recebe Squad normalmente (o vínculo é do Cliente), mas nenhum módulo account-aware funciona para ele |
| Cliente **multi-conta** | `contas_ativas > 1` | O Squad é do **Cliente** — as contas seguem por herança. **Não é suportado** separar contas do mesmo cliente em Squads diferentes |
| Cliente multi-conta **no mesmo marketplace** | 2+ contas com mesmo `marketplace` | Fonte de ambiguidade de Grant e de Base — ver docs 06 e 07 |
| Conta ativa sob cliente **inativo** | cruzamento `contas_ativas > 0 AND NOT ativo` | Conta órfã operacional |
| Cliente **inexistente** citado na relação | validador offline | `CLIENTE_INEXISTENTE` (erro estrutural) |

---

## 5. A regra que **não** foi violada

O BLOCO A é explícito: **não deduzir Squad** por Gestor histórico, nome do
Cliente, marketplace, Base, Grant, usuário que acessou ou responsável legado.

**Nenhuma dessas inferências foi feita.** Sinais desse tipo existem e foram
catalogados como **evidência auxiliar** em `09_RESPONSABILIDADES_EVIDENCIAS.md`,
classificados por força — mas **nenhum deles decide nada**, e o campo `squad`
de todo cliente permanece:

```
PENDENTE_RELACAO_CLIENTE_SQUAD
```

> **Por quê tanto rigor:** o rollout gate valida **completude**, não
> **correção** (`VENFORCE_V3_SQUADS_ROLLOUT_SAFETY.md` §9.8). Um mapa completo
> porém errado passa no gate e liga o enforcement com a carteira trocada. Um
> palpite plausível aqui vira acesso errado em produção, silenciosamente.
