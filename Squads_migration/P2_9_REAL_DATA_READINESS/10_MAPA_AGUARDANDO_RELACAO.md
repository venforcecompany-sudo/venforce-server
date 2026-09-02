# 10 — O mapa que vai receber a relação

> **BLOCO J.** O arquivo que a operação preenche, o formato canônico que ele
> gera, e o gerador que preenche sozinho tudo que é objetivo.

---

## 1. Princípio: **não** foi criado um segundo formato

O formato canônico **já existe** e é a fonte de verdade:
`Squads_migration/SQUADS_MIGRATION_TEMPLATE.json`, consumido por
`server/services/squads/squadsMigracaoImportService.js`.

Esta entrega **não o substitui**. Ela adiciona uma **camada de entrada humana**
que **produz** esse formato:

```
   relacao-squads.txt              (humano escreve — formato de conversa)
            │
            ▼
   squads-preflight-relacao.js     (converte + valida OFFLINE)
            │
            ▼
   plano-p2-9.json                 (FORMATO CANÔNICO — inalterado)
            │
            ▼
   squads-migrate.js --plan        (tooling P2.3 existente, dry-run com banco)
            │
            ▼
   squads-migrate.js --plan --apply   (humano decide)
```

Por que uma camada de entrada e não JSON direto: a relação chega da gestão na
forma *"Squad X / Gestor A / Clientes: … / Membros: …"*. Pedir que alguém
transcreva isso à mão para JSON aninhado é onde os erros nascem. O formato de
entrada é **literalmente essa forma**.

---

## 2. O arquivo de entrada

`Squads_migration/P2_9_REAL_DATA_READINESS/entrada/relacao-squads.PENDENTE_HUMANO.txt`

```
SQUAD: Nome Oficial do Squad
SLUG: nome-oficial              (opcional — derivado do nome se ausente)
GESTOR: fulano@venforce.com
CLIENTES:
  - cliente-slug-a
  - 142
MEMBROS:
  - beltrano@venforce.com
```

- `#` inicia comentário.
- Clientes por **slug** (preferido) ou id. Usuários por **email** (preferido) ou id.
- **Não repetir o Gestor em `MEMBROS:`** — ele já entra por `GESTOR:`.
- Também aceita `.json` com o mesmo formato
  (`{ "squads": [ { nome, slug, gestor, clientes[], membros[] } ] }`).

### Como o Gestor vira dado

`squads` não tem coluna de gestor, e `cliente_responsaveis` **não aceita** o
papel `coordenador` (o CHECK só admite `gestor|auxiliar|designer`). No modelo,
quem responde por um Squad é representado pela **membership**:

```json
{ "squad": "<slug>", "usuario": "<gestor>", "funcao": "coordenador", "principal": true }
```

Isso é o que `01_DADOS_HUMANOS_NECESSARIOS.md` §4 já definia: *"coordenador é
atributo da membership, não da responsabilidade"*. A conversão é automática.

---

## 3. O mapa pré-preenchido (o entregável do BLOCO J)

Todos os campos **objetivos** — id, slug, nome, contas, marketplace, email,
role — são preenchidos por máquina, a partir do inventário. Restam à operação
**apenas as decisões**: nome do Squad, Gestor, e quem vai onde.

```bash
# 1. inventário read-only (1 comando)
DATABASE_URL="postgres://READONLY:...@host/db" \
  node server/sql/squads-inventario-readonly.js --saida inventario.json

# 2. esqueleto pré-preenchido
node server/sql/squads-preflight-relacao.js \
  --esqueleto --inventario inventario.json \
  --saida Squads_migration/P2_9_REAL_DATA_READINESS/entrada/relacao-squads.txt
```

O esqueleto sai com os 6 blocos vazios **e o catálogo completo comentado**:

```
# ── Squad 1 de 6 ──
SQUAD: PENDENTE_NOME_OFICIAL
GESTOR: PENDENTE_DADO_HUMANO
CLIENTES:
MEMBROS:
        ... (6 blocos)

# ═════════ CATÁLOGO — N CLIENTES ATIVOS (nenhum atribuído) ═════════
#   - acme        ·  Acme       ·  2 conta(s)  ·  meli/shopee
#   - beta-corp   ·  Beta Corp  ·  1 conta(s)  ·  meli
# ═════════ CATÁLOGO — M INTERNOS ATIVOS (nenhum alocado) ═════════
#   - ana@vf.com  ·  Ana        ·  role=membro
```

**O trabalho humano vira mover linhas do catálogo para dentro do Squad certo.**

Garantias verificadas por teste (`squadsPreflightRelacao.test.js` §18-19):

- exatamente **6** blocos `SQUAD:`;
- **nenhum** cliente vem pré-atribuído — o catálogo é 100% comentado;
- `admin` **não** aparece no catálogo de internos (é bypass, não precisa de Squad);
- o esqueleto gerado, relido e validado, dá **`AGUARDANDO_RELACAO`** — nunca erro.

---

## 4. Estado de hoje, rodado de verdade

```
$ node server/sql/squads-preflight-relacao.js \
    --relacao Squads_migration/P2_9_REAL_DATA_READINESS/entrada/relacao-squads.PENDENTE_HUMANO.txt

Squads:      6/6
Clientes:    0
Memberships: 0

VEREDITO: AGUARDANDO_RELACAO

PENDENTE_ESPERADO (19):
  … [SQUAD_NOME_PENDENTE]  squads[0]: nome ainda é o marcador "PENDENTE_NOME_OFICIAL".
  … [SQUAD_SEM_GESTOR]     squads[0]: Gestor ainda é o marcador "PENDENTE_DADO_HUMANO".
  … [SQUAD_SEM_CLIENTES]   squads[0]: nenhum Cliente atribuído — aguardando relação Cliente→Squad.
  … (idem para os 6)
  … [SEM_INVENTARIO]       existência de Cliente/Usuário não verificada offline.

>> Estrutura íntegra; 19 pendência(s) esperada(s) aguardando dado humano.
   Nada aqui é erro — é a fronteira da informação.
```

`ERRO_ESTRUTURAL: 0` · exit code `0`.

> Que o gabarito em branco dê **`AGUARDANDO_RELACAO`** e não um muro de erros é
> uma decisão de projeto, não um acidente: um Squad ainda sem nome oficial não
> vira linha de plano, então os 6 marcadores `PENDENTE_NOME_OFICIAL` **não
> colidem** em slug. Sem isso, o gabarito acusaria 10 "erros" que são, na
> verdade, o estado normal de hoje.

---

## 5. Onde os campos objetivos moram

| Campo | Preenchido por | Fonte |
|---|---|---|
| `cliente_id`, `cliente_slug`, `nome`, `ativo` | **máquina** | `inventario.clientes` |
| nº de contas, marketplaces | **máquina** | `inventario.clientes` |
| `user_id`, `email`, `nome`, `role` | **máquina** | `inventario.usuarios` |
| `cliente_conta_id`, marketplace | **máquina** | `inventario.cliente_contas` |
| **nome oficial do Squad** | **HUMANO** | gestão |
| **slug do Squad** | humano (ou derivado do nome) | gestão |
| **Gestor do Squad** | **HUMANO** | gestão |
| **Cliente → Squad** | **HUMANO** | gestão |
| **Membros → Squad** | **HUMANO** | gestão |
| `funcao` (`membro`/`coordenador`) | máquina (Gestor→coordenador) | derivado |
| `principal` | máquina (1º Squad do usuário) | derivado |
| `motivo` do histórico | máquina (`"migração inicial P2.9"`) | fixo |
| `responsaveis[]` | **HUMANO**, opcional | gestão — ver `09_...md` §6 |

---

## 6. O que **não** está pré-preenchido, de propósito

`squad_slug` de todo cliente: `PENDENTE_RELACAO_CLIENTE_SQUAD`.
`squad_principal` de todo usuário: `PENDENTE_RELACAO_USUARIO_SQUAD`.
Nome oficial dos 6 Squads: `PENDENTE_NOME_OFICIAL`.
Identidade dos 6 Gestores: `PENDENTE_DADO_HUMANO`.

Nenhum desses foi inferido de Gestor histórico, nome de cliente, marketplace,
Base, Grant ou responsável legado — ver `01_CLIENTES_REAIS.md` §5.
