# 12 — Plano de consolidação de clientes (em português)

> **`PLAN_ONLY`. Nada disto foi executado.** Nenhum cliente foi criado, nenhum
> foi deletado, nenhum grant foi movido, nenhuma base foi alterada.
> Máquina: `artefatos/CLIENT_CONSOLIDATION_PLAN.json`.

## O que o plano faz e o que ele nunca faz

| faz | nunca faz |
|---|---|
| reassocia contas de alias ao cliente canônico | **cria** cliente |
| reaponta grants para a conta de **mesma chave natural** | **deleta** cliente |
| move vínculos de Base preservando a semântica | muda seller, marketplace ou dono de conta |
| lista as referências que precisam de UPDATE manual | confia em `CASCADE` para migrar dado |
| marca conta duplicada como `DEDUPLICAR_CONTA` | cria uma segunda `ClienteConta` para a mesma operação |

---

## Estratégia para o alias: **não deletar**

A matriz de `06` mostra 16 FKs com
`ON DELETE CASCADE`, entre elas `ml_tokens.cliente_id`. Apagar um alias
**destruiria os Grants dele em cascata**. Por isso a estratégia é:

1. mover contas, grants, bases e referências para o canônico;
2. **manter o registro alias existindo**;
3. decidir depois, com evidência, se ele vira inativo.

### A questão da `api_key` — medida, não suposta

Cada registro de `clientes` tem `api_key UNIQUE NOT NULL`. Uma única rota
autentica por ela — `GET /api/bases/:baseSlug`, via `apiKeyMiddleware`, que
exige `ativo = true`.

| cenário | impacto |
|---|---|
| consolidar mantendo os dois registros ativos | **nenhum**. `api_key` não é FK de nada e nenhum registro é apagado ou alterado. |
| marcar o alias `ativo = false` | a `api_key` dele passa a devolver **401**. Não existe rota para fazer isso: não há `UPDATE clientes` no código — só SQL direto. |

**A evidência de uso está na tabela `callbacks`, e ela está VAZIA — 0 linhas.**
Essa rota registra um callback em ambos os caminhos (404 e 200), então zero
linhas significa **zero uso registrado**. O risco `API_KEY_LEGACY_DEPENDENCY`
existe no papel, mas **não tem nenhuma evidência de consumidor ativo**.

> Ressalva honesta: `callbacks` estar vazia hoje não prova que nunca houve uso —
> a tabela pode ter sido limpa. A verificação deve ser **repetida imediatamente
> antes** de qualquer desativação.

---

## As 11 operações

### `influencia_jeans` — CONFIRMADO

- **Canônico:** #15 `influencia_jeans` (Influencia Jeans)
- **Aliases:** #60 `influencia_jeans_2`
- **Contas a mover:** 1 · **a deduplicar:** 0
- **Grants a reapontar:** 1 (bloqueantes: 0)
- **Bases a mover:** 2
- **Tabelas com linhas a migrar:** 5



### `wbs_medical` — CONFIRMADO

- **Canônico:** #32 `wbs_medical` (WBS Medical)
- **Aliases:** #62 `wbs_2`
- **Contas a mover:** 1 · **a deduplicar:** 1
- **Grants a reapontar:** 1 (bloqueantes: 0)
- **Bases a mover:** 0
- **Tabelas com linhas a migrar:** 4

- ⚠️ conta 59 tem a mesma chave natural da conta 66 do canônico — NÃO criar segunda; decidir qual sobrevive preservando as referências de ambas

### `j_meira` — FORTE · **não automático**

- **Canônico:** #34 `j_meira` (J Meira)
- **Aliases:** #63 `j_meira_2` · #64 `j_meira_3`
- **Contas a mover:** 0 · **a deduplicar:** 0
- **Grants a reapontar:** 0 (bloqueantes: 0)
- **Bases a mover:** 0
- **Tabelas com linhas a migrar:** 0



### `mercadao_enxovais` — CONFIRMADO · **não automático**

- **Canônico:** #36 `mercadao_enxovais` (Mercadao enxovais)
- **Aliases:** #65 `mercadao_enxovais_2`
- **Contas a mover:** 1 · **a deduplicar:** 0
- **Grants a reapontar:** 2 (bloqueantes: 1)
- **Bases a mover:** 0
- **Tabelas com linhas a migrar:** 3
- ⛔ **Bloqueadores:** grant 52 sem conta correspondente


### `alma` — CONFIRMADO

- **Canônico:** #39 `alma` (Alma)
- **Aliases:** #66 `alma_2`
- **Contas a mover:** 1 · **a deduplicar:** 0
- **Grants a reapontar:** 1 (bloqueantes: 0)
- **Bases a mover:** 0
- **Tabelas com linhas a migrar:** 9 — **4 SEM FK (UPDATE manual obrigatório)**



### `dua_cosmeticos` — CONFIRMADO

- **Canônico:** #40 `dua_cosmeticos` (Dua Cosmeticos)
- **Aliases:** #67 `dua_cosmeticos_2`
- **Contas a mover:** 1 · **a deduplicar:** 0
- **Grants a reapontar:** 1 (bloqueantes: 0)
- **Bases a mover:** 0
- **Tabelas com linhas a migrar:** 3



### `maya` — CONFIRMADO

- **Canônico:** #55 `maya` (Maya)
- **Aliases:** #71 `maya_5` · #68 `maya_2` · #69 `maya_3` · #70 `maya_4`
- **Contas a mover:** 5 · **a deduplicar:** 0
- **Grants a reapontar:** 4 (bloqueantes: 0)
- **Bases a mover:** 0
- **Tabelas com linhas a migrar:** 8



### `luli` — CONFIRMADO · **não automático**

- **Canônico:** #58 `luli` (Luli)
- **Aliases:** #82 `luli_1`
- **Contas a mover:** 0 · **a deduplicar:** 0
- **Grants a reapontar:** 1 (bloqueantes: 1)
- **Bases a mover:** 0
- **Tabelas com linhas a migrar:** 1
- ⛔ **Bloqueadores:** grant 47 sem conta correspondente


### `zorzaloja` — FORTE · **não automático**

- **Canônico:** #112 `zorzaloja` (zorza.loja)
- **Aliases:** #121 `zorza_shopee`
- **Contas a mover:** 0 · **a deduplicar:** 0
- **Grants a reapontar:** 0 (bloqueantes: 0)
- **Bases a mover:** 0
- **Tabelas com linhas a migrar:** 0



### `wmmodas` — CONFIRMADO · **não automático**

- **Canônico:** #123 `wmmodas` (wm.modas)
- **Aliases:** #116 `william_modas`
- **Contas a mover:** 0 · **a deduplicar:** 0
- **Grants a reapontar:** 1 (bloqueantes: 1)
- **Bases a mover:** 0
- **Tabelas com linhas a migrar:** 1
- ⛔ **Bloqueadores:** grant 85 sem conta correspondente


### `teste1` — CONFIRMADO

- **Canônico:** #126 `teste1` (teste1)
- **Aliases:** #127 `teste2` · #109 `teste_01`
- **Contas a mover:** 0 · **a deduplicar:** 2
- **Grants a reapontar:** 1 (bloqueantes: 0)
- **Bases a mover:** 0
- **Tabelas com linhas a migrar:** 5

- ⚠️ conta 74 tem a mesma chave natural da conta 68 do canônico — NÃO criar segunda; decidir qual sobrevive preservando as referências de ambas
- ⚠️ conta 44 tem a mesma chave natural da conta 68 do canônico — NÃO criar segunda; decidir qual sobrevive preservando as referências de ambas

---

## Histórico: o que a consolidação pode destruir sem apagar nada

Reapontar `cliente_id` de um alias para o canônico **não perde linhas**, mas
pode perder **a capacidade de saber a qual operação a linha pertencia**.

| situação | tratamento correto |
|---|---|
| a linha tem `cliente_conta_id` preenchido | seguro — a conta identifica a operação, e ela é preservada |
| a linha é genuinamente **client-level** | seguro — apontar para o canônico é correto |
| a linha **deveria** ser account-aware mas tem `cliente_conta_id` NULL | **perigoso** — depois da fusão não há como saber de qual conta veio |

O caso concreto no banco: `meli_anuncios` tem
**8.892** linhas e `cliente_conta_id` **NULL em 8.759** delas. Se um cluster
com anúncios for consolidado, a origem por conta fica irrecuperável. Nenhum dos
clusters atuais tem esse volume — mas a regra tem de ser respeitada antes de
qualquer apply.

---

## Responsabilidades: deliberadamente vazias

O plano tem `responsaveis: []`. **Não por esquecimento.**

A planilha dá a **estrutura do Squad** (Gestor, Auxiliar, Design). Ela **não**
diz que todo Gestor é responsável por **todos** os clientes do Squad. Essa regra
de negócio não está documentada em lugar nenhum do produto, e
`cliente_responsaveis` tem semântica própria (papel `gestor`/`auxiliar`/
`designer` por **cliente**, não por Squad).

- **MEMBERSHIP** — pode ser preparado. Está no plano.
- **CLIENT_RESPONSIBILITY** — **não** foi gerado. É decisão de rollout separada.

Vale notar que responsabilidade **nunca concedeu acesso** e continua não
concedendo; deixá-la vazia não tira permissão de ninguém.

