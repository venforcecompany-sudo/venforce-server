# 07 — Bases: auditoria e ambiguidades

> **BLOCO G.** Auditoria da cadeia `Cliente → ClienteConta → Base`.
> Nada é corrigido. **Cobertura anterior: zero** — nenhuma query do pacote
> P2.9 PRE-FLIGHT tocava Bases. Este era o maior gap do pacote.

---

## 1. O que é uma "Base" (e onde ela **não** está)

⚠️ **`data/bases/*.json` NÃO é a fonte.** O diretório existe
(`alma.json`, `alma_1.json`, `etx.json`, `meira_1.json`, `meira_2.json`), mas
uma busca no repositório inteiro por referências a esse caminho retorna
**zero**: nenhum código o lê. É dado órfão/legado. **Não escrever SQL nem
tirar conclusões dele.**

A Base real é a tabela `bases` (`server/index.js:534-537` + 2 colunas aditivas):

```sql
CREATE TABLE IF NOT EXISTS bases (
  id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, nome TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
-- + updated_at (server/index.js:665-667)
-- + marketplace TEXT NOT NULL DEFAULT 'meli' (server/index.js:670-672)
```

**`bases` não tem `cliente_id` nem `cliente_conta_id`.** O vínculo vive numa
tabela de junção.

---

## 2. A tabela que importa: `base_cliente_vinculos`

`server/index.js:557-570`:

```sql
CREATE TABLE IF NOT EXISTS base_cliente_vinculos (
  id SERIAL PRIMARY KEY,
  base_id INTEGER REFERENCES bases(id) ON DELETE CASCADE,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  marketplace TEXT,
  origem TEXT DEFAULT 'manual',
  ativo BOOLEAN DEFAULT true,
  confirmado_por INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_base_cliente_vinculos_base_ativo
  ON base_cliente_vinculos (base_id) WHERE ativo = true;
```

E a coluna decisiva, aditiva e **NULLABLE** —
`20260817_cliente_contas_foundation.sql:87-90`:

```sql
ALTER TABLE base_cliente_vinculos
  ADD COLUMN IF NOT EXISTS cliente_conta_id INTEGER REFERENCES cliente_contas(id) ON DELETE SET NULL;
```

> **É exatamente o caso que o BLOCO G pede para caçar:**
> `cliente_conta_id NULL` + Cliente com múltiplas contas.

Uma Base tem no máximo **um** vínculo ativo; um Cliente pode ter **várias** Bases.

---

## 3. Por que existem `NULL` (e por que alguns são insolúveis)

O backfill da própria migração (linhas 192-237) preencheu `cliente_conta_id`
**apenas** quando o cliente tinha **exatamente uma** conta ativa naquele
marketplace. Os casos ambíguos foram **deixados NULL de propósito** e
registrados em `cliente_contas_pendencias` com `tipo = 'base_vinculo_ambiguo'`
(linhas 202-221), aguardando decisão humana **desde 2026-08-17**.

Em leitura, `listarContasDoCliente()` (`clienteContaService.js:152-194`)
**re-deriva** a resolução ao vivo — mas, de novo, só quando existe exatamente 1
conta ativa (`resolvido_por: "legado"`). Com 2+, permanece indefinido.

---

## 4. Classificação (BLOCO G)

| Classe | Regra | Gravidade |
|---|---|---|
| **EXATA** | `cliente_conta_id IS NOT NULL` | ✅ |
| **CLIENT_LEVEL_LEGADA** | `NULL` **e** cliente tem **exatamente 1** conta ativa naquele marketplace | 🟨 resolúvel deterministicamente |
| **AMBÍGUA** | `NULL` **e** cliente tem **2+** contas ativas naquele marketplace | 🟥 **decisão humana** |
| **AUSENTE** | cliente **ativo** com conta ativa e **nenhum** vínculo de Base ativo | 🟥 módulos que dependem de Base não funcionam |

Vínculos com `ativo = false` são ignorados. Clientes **inativos** não geram
`AUSENTE` (não seria pendência real) — verificado por teste.

Implementação: `classificarBases()`.
Testes: `server/tests/squadsInventarioReadonly.test.js` §2 (6 verificações).

---

## 5. Query

```sql
SELECT v.id, v.base_id, b.slug AS base_slug, v.cliente_id, v.cliente_conta_id,
       v.marketplace, v.origem, v.ativo
  FROM base_cliente_vinculos v
  LEFT JOIN bases b ON b.id = v.base_id
 ORDER BY v.cliente_id ASC, v.id ASC;
```

Saída (`resumo.bases`):

```json
{ "EXATA": 0, "CLIENT_LEVEL_LEGADA": 0, "AMBIGUA": 0, "AUSENTE": 0, "casos": [] }
```

---

## 6. Estado

| | |
|---|---|
| **Bases auditadas** | **0** — `REQUER BANCO` (**T-1**) |
| **Classificador** | **PRONTO e testado** |
| **Cobertura no pacote anterior** | **NENHUMA** — gap fechado por esta entrega |
| **Alguma base corrigida?** | **NÃO** |
| **Relação com Squad** | **nenhuma** — bloco independente da relação humana |

> **Nota de segurança de autorização:** o isolamento de Base já é validado por
> posse no backend (`assertBaseNaCarteira`), e o IDOR de bases está fechado
> (`VENFORCE_V3_FINAL_CONVERGENCE_CLOSURE.md` §2). As ambiguidades acima são de
> **resolução operacional** (qual conta a Base representa), não buracos de
> autorização.
