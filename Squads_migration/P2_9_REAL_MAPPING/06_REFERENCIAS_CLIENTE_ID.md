# 06 — Matriz de referências a `cliente_id`

> Levantada do banco real por `information_schema`, não por leitura de código —
> o código pode estar desatualizado, o catálogo não.

## Panorama

|  | quantidade |
|---|---|
| Colunas que referenciam `cliente_id`/`cliente_conta_id` | **38** |
| …com foreign key | 26 |
| …**sem** foreign key | **12** |
| FKs com `ON DELETE CASCADE` | **16** |

---

## ⚠️ As 12 referências SEM foreign key

Estas são as perigosas: **nada garante integridade nelas**. Uma consolidação
que reaponte `cliente_id` tem de atualizá-las **explicitamente** — nenhum
`CASCADE` vai fazer isso, e nenhum erro vai avisar se ficarem para trás.

| tabela.coluna | linhas |
|---|---|
| `central_vendas_componentes.cliente_id` | 535.348 |
| `central_vendas_imports.cliente_id` | 167 |
| `central_vendas_mp_payments.cliente_id` | 10.756 |
| `central_vendas_mp_settlement_movements.cliente_conta_id` | 0 |
| `central_vendas_mp_settlement_reports.cliente_id` | 1 |
| `central_vendas_pedido_itens.cliente_id` | 101.764 |
| `central_vendas_pedidos.cliente_id` | 101.764 |
| `meli_anuncio_otimizacoes.cliente_conta_id` | 0 |
| `meli_anuncio_otimizacoes.cliente_id` | 90 |
| `meli_anuncios.cliente_conta_id` | 133 |
| `meli_anuncios.cliente_id` | 8.892 |
| `promocoes_diagnosticos.cliente_id` | 7 |

O volume aqui não é trivial: `central_vendas_componentes` sozinha tem
**535.348** linhas,
e `central_vendas_pedidos` mais `central_vendas_pedido_itens` somam
**203.528**.
Consolidação aqui é migração de dados de verdade, não um `UPDATE` de uma linha.

---

## ⛔ As 16 FKs com `ON DELETE CASCADE`

**Este é o motivo técnico de "não deletar cliente".** Apagar um registro de
`clientes` não deixaria um órfão: **destruiria em cascata** grants, contas,
vínculos de base, diagnósticos, histórico e responsabilidades.

| tabela.coluna | o que seria destruído |
|---|---|
| `base_cliente_vinculos.cliente_id` | os vínculos de Base |
| `central_vendas_sync_runs.cliente_id` | dados operacionais |
| `cliente_360_diagnosticos.cliente_id` | dados operacionais |
| `cliente_360_frete_historico.cliente_id` | dados operacionais |
| `cliente_360_resumos_mensais.cliente_id` | dados operacionais |
| `cliente_360_sync_jobs.cliente_id` | dados operacionais |
| `cliente_contas.cliente_id` | **as contas do cliente** |
| `cliente_responsaveis.cliente_id` | as responsabilidades |
| `cliente_squad_history.cliente_id` | o histórico de Squad |
| `design_artworks.cliente_id` | dados operacionais |
| `design_client_profiles.cliente_id` | dados operacionais |
| `design_templates.cliente_id` | dados operacionais |
| `diagnosticos_iniciais.cliente_id` | dados operacionais |
| `ml_tokens.cliente_id` | **os Grants — o acesso ao marketplace** |
| `seller_clientes.cliente_id` | dados operacionais |
| `seller_custos_submissoes.cliente_id` | dados operacionais |

E não existe soft delete: `DELETE /clientes/:slug` é `DELETE` físico
(`clienteDependenciasService.js` declara isso explicitamente). A coluna `ativo`
é a única marcação de estado.

---

## Matriz completa

| tabela | coluna | FK? | ON DELETE | linhas | chaves distintas |
|---|---|---|---|---|---|
| `base_cliente_vinculos` | `cliente_conta_id` | sim | `SET NULL` | 25 | 21 |
| `base_cliente_vinculos` | `cliente_id` | sim | `CASCADE` | 45 | 28 |
| `callbacks` | `cliente_id` | sim | `SET NULL` | 0 | 0 |
| `central_vendas_componentes` | `cliente_id` | **NÃO** | — | 535348 | 11 |
| `central_vendas_imports` | `cliente_conta_id` | sim | `SET NULL` | 40 | 9 |
| `central_vendas_imports` | `cliente_id` | **NÃO** | — | 167 | 11 |
| `central_vendas_mp_payments` | `cliente_conta_id` | sim | `SET NULL` | 10756 | 8 |
| `central_vendas_mp_payments` | `cliente_id` | **NÃO** | — | 10756 | 8 |
| `central_vendas_mp_settlement_movements` | `cliente_conta_id` | **NÃO** | — | 0 | 0 |
| `central_vendas_mp_settlement_reports` | `cliente_conta_id` | sim | `SET NULL` | 1 | 1 |
| `central_vendas_mp_settlement_reports` | `cliente_id` | **NÃO** | — | 1 | 1 |
| `central_vendas_pedido_itens` | `cliente_id` | **NÃO** | — | 101764 | 11 |
| `central_vendas_pedidos` | `cliente_id` | **NÃO** | — | 101764 | 11 |
| `central_vendas_sync_runs` | `cliente_conta_id` | sim | `SET NULL` | 37 | 9 |
| `central_vendas_sync_runs` | `cliente_id` | sim | `CASCADE` | 37 | 9 |
| `cliente_360_diagnosticos` | `cliente_id` | sim | `CASCADE` | 0 | 0 |
| `cliente_360_frete_historico` | `cliente_id` | sim | `CASCADE` | 0 | 0 |
| `cliente_360_resumos_mensais` | `cliente_id` | sim | `CASCADE` | 17 | 11 |
| `cliente_360_sync_jobs` | `cliente_id` | sim | `CASCADE` | 45 | 11 |
| `cliente_contas` | `cliente_id` | sim | `CASCADE` | 74 | 58 |
| `cliente_responsaveis` | `cliente_id` | sim | `CASCADE` | 0 | 0 |
| `cliente_squad_history` | `cliente_id` | sim | `CASCADE` | 0 | 0 |
| `design_artworks` | `cliente_id` | sim | `CASCADE` | 1 | 1 |
| `design_client_profiles` | `cliente_id` | sim | `CASCADE` | 1 | 1 |
| `design_templates` | `cliente_id` | sim | `CASCADE` | 28 | 2 |
| `diagnosticos_iniciais` | `cliente_id` | sim | `CASCADE` | 32 | 19 |
| `entregas_cliente` | `cliente_conta_id` | sim | `SET NULL` | 1 | 1 |
| `entregas_cliente` | `cliente_id` | sim | `SET NULL` | 91 | 30 |
| `meli_anuncio_otimizacoes` | `cliente_conta_id` | **NÃO** | — | 0 | 0 |
| `meli_anuncio_otimizacoes` | `cliente_id` | **NÃO** | — | 90 | 5 |
| `meli_anuncios` | `cliente_conta_id` | **NÃO** | — | 133 | 1 |
| `meli_anuncios` | `cliente_id` | **NÃO** | — | 8892 | 8 |
| `ml_tokens` | `cliente_conta_id` | sim | `SET NULL` | 54 | 54 |
| `ml_tokens` | `cliente_id` | sim | `CASCADE` | 63 | 61 |
| `promocoes_diagnosticos` | `cliente_id` | **NÃO** | — | 7 | 6 |
| `relatorios` | `cliente_id` | sim | `SET NULL` | 89 | 25 |
| `seller_clientes` | `cliente_id` | sim | `CASCADE` | 1 | 1 |
| `seller_custos_submissoes` | `cliente_id` | sim | `CASCADE` | 6 | 1 |

