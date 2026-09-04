# 00 — RESUMO · P2.9 REAL MAPPING

> **Estado:** `SQUADS_ENFORCEMENT` = **OFF** · migração **NÃO APLICADA** ·
> banco **NÃO ALTERADO** · `--apply` **NÃO EXECUTADO**.
> Toda leitura desta fase rodou em transação read-only, e o dry-run rodou com a
> sessão do Postgres forçada em `default_transaction_read_only=on` — o próprio
> servidor recusaria qualquer escrita.

| | |
|---|---|
| Base da branch | `09f6a96` (`backend/v3-p2-9-structure-readiness (contém origin/main fd2671a)`) |
| Branch | `backend/v3-p2-9-real-mapping` |
| Banco lido | produção (Render) · somente leitura |
| Snapshot | `2026-09-03T21:33:05.678Z` |

---

## 1. O que esta fase resolveu

A fase anterior parou na fronteira da informação humana: faltava
**Cliente → Squad**. Ela chegou, e com ela três problemas que só apareciam com
dado real na mão.

**Primeiro: a relação não casa com o cadastro por igualdade de string.** Dos 52
nomes, só 26 batem exatamente. O resto discorda em
pontuação (`J&W Presentes` × `jw presentes`), em abreviação (`Tenda` ×
`Tenda Medieval`), em conectivo (`Toque de Ouro` × `Toque ouro`) ou em grafia
(`Kirus` × `Kirius`). Casar isso por fuzzy silencioso seria dar carteira errada
para gente real, então o casamento roda em **camadas determinísticas** e a
primeira camada que produzir **exatamente um** candidato decide. Duas ou mais →
`MATCH_AMBIGUO`, que volta para o humano.

**Segundo: existem entidades `clientes` que são a mesma empresa.** São
11 clusters, 16 aliases. Mas — e isto importa — **sufixo
não é evidência**. `ER2`, `Shopping 86` e `Fenix Equipamentos1` terminam em
número e não são duplicata de ninguém. A regra usada se autovalida: só forma
cluster se o radical resultante **casar com outro cliente real**. A prova forte
é chave natural — mesmo `ml_user_id` ou mesmo `external_account_id` sob
clientes distintos.

**Terceiro: uma colisão de chave natural nem sempre é identidade.** Um caso
(`#102` × `#105`) tem a assinatura de **grant cruzado**: alguém conectou a
conta de um cliente de dentro do outro. Fundir seria pior que não fundir, e o
caso está marcado `NAO_MERGEAR`.

---

## 2. Números reais

|  | valor |
|---|---|
| Clientes reais no banco | **83** (todos ativos) |
| Nomes na relação | **52** |
| → MATCH_EXATO | 26 |
| → MATCH_ALIAS_COMPROVADO | 12 |
| → MATCH_CLUSTER_LEGADO | 8 |
| → MATCH_AMBIGUO | 1 |
| → NAO_EXISTE_NO_BANCO | **5** — não criados |
| Clusters legados | 11 |
| Aliases a consolidar | 16 |
| Clientes canônicos projetados | 67 |
| Identidades resolvidas | **16 de 23** |
| Invariantes | **13/13 verdes** |

### Clientes por Squad

| Squad | clientes reais |
|---|---|
| squad-1 | 11 |
| squad-2 | 10 |
| squad-3 | 7 |
| squad-4 | 18 |
| squad-5 | 6 |
| squad-6 | 5 |
| **Squad 8 · Legado** | 26 |

Soma = **83** = todos os clientes reais.
Nenhum cliente ficou de fora; nenhum ficou em dois Squads.

---

## 3. O princípio que governa o mapa

> **Squad 8 é o default seguro.**

Squad 8 · Legado é **quarentena, não descarte**. Colocar um cliente nele por
engano se desfaz movendo-o depois; colocá-lo no Squad operacional **errado** é
acesso indevido em produção no dia em que o enforcement ligar. Por isso toda
incerteza cai para o Squad 8, e **nenhuma** cai num Squad 1–6.

É isso que permite fechar o mapa dos 83 clientes sem inventar
nada, deixando para o humano só o que é genuinamente decisão de negócio.

---

## 4. Índice

| # | arquivo | conteúdo |
|---|---|---|
| 00 | este resumo | — |
| 01 | `01_RELACAO_SQUADS_NORMALIZADA.md` | a planilha, literal e normalizada |
| 02 | `02_MATCH_CLIENTES_PLANILHA_BANCO.md` | os 52 nomes, um a um, com a camada que decidiu |
| 03 | `03_CLIENTES_NAO_CRIADOS.md` | **os que não existem — e continuam não existindo** |
| 04 | `04_CLIENTES_SQUAD_8_LEGADO.md` | os clientes em quarentena |
| 05 | `05_CLUSTERS_CLIENTES_LEGADOS.md` | as entidades que são a mesma empresa |
| 06 | `06_REFERENCIAS_CLIENTE_ID.md` | matriz de referências · FK · ON DELETE |
| 07 | `07_GRANTS_PRESERVACAO.md` | **prova de que nenhum Grant se perde** |
| 08 | `08_BASES_PRESERVACAO.md` | Bases por conta × client-level |
| 09 | `09_IDENTIDADES_USUARIOS.md` | as 23 pessoas → user_id |
| 10 | `10_MULTI_SQUAD_PRINCIPAL_PENDENTE.md` | quem está em 2+ Squads |
| 11 | `11_HARDENING_T2_T3_T4.md` | os três bloqueadores técnicos, resolvidos |
| 12 | `12_CLIENT_CONSOLIDATION_PLAN.md` | o plano de consolidação, em português |
| 13 | `13_MAPA_P2_9_REAL.md` | o mapa completo |
| 14 | `14_DRY_RUN_RESULTADO.md` | o dry-run real, contra produção |
| 15 | `15_GO_NO_GO_PRE_APPLY.md` | **o veredito** |
| 16 | `16_DECISOES_FINAIS_HUMANAS.md` | o que, naquele momento, só o humano podia decidir |
| 17 | `17_DECISOES_APROVADAS_RECONCILIADAS.md` | as decisões aprovadas × o banco, item a item |
| 18 | `18_DRY_RUN_FINAL_PRE_APPLY.md` | o dry-run final — 0 aviso, banco com hash idêntico |
| 19 | **`19_GO_NO_GO_FINAL_PRE_APPLY.md`** | **← comece por aqui: os dois vereditos** |

> **Atualização de 04/09** — as decisões humanas chegaram
> (`VENFORCE_V3_P2_9_DECISOES_FINAIS_APROVADAS.md`) e foram reconciliadas
> contra o banco. Os documentos 00–16 ficam como estão: são o registro do que
> se sabia em 03/09. O estado corrente está em **17, 18 e 19**.

Artefatos de máquina em `artefatos/`:
`plano-p2-9.json` (canônico do `squads-migrate.js`),
`CLIENT_CONSOLIDATION_PLAN.json`, `MAPA_P2_9_REAL.json`.
Entrada em `entrada/relacao-squads-v2.json`.

