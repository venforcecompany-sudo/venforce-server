# Identificadores e relacionamentos

Fonte: leitura dos DDL citados em `TABELAS_POR_DOMINIO.md`. Tudo aqui é **[código]**, salvo marcação contrária. Não houve acesso ao banco: se uma FK que o código cria "só se não existir" (bloco `DO`) existe de fato em produção, isso é **[não verificado]**.

Legenda da matriz:
- **F**: coluna presente e com FK.
- **c**: coluna presente, sem FK.
- **N**: coluna presente, NOT NULL e sem FK.
- **—**: coluna ausente.

Colunas: cli_id = cliente_id, slug = cliente_slug, conta = cliente_conta_id, ext = seller_id / ml_user_id / external_account_id / shop_id, grant = grant_id, imp = import_id, run = sync_run_id ou run_id. A última coluna traz outros identificadores.

## Matriz tabela × identificadores

| Tabela | cli_id | slug | conta | ext | grant | imp | run | outros |
|---|---|---|---|---|---|---|---|---|
| clientes | (PK) | slug | — | — | — | — | — | merged_into_cliente_id F |
| cliente_contas | F (CASCADE) | slug próprio da conta | (PK) | external_account_id c | — | — | — | — |
| cliente_contas_pendencias | — | — | — | — | — | — | — | detalhes JSONB |
| cliente_imagens | F (PK, CASCADE) | — | — | — | — | — | — | — |
| cliente_unificacoes | cliente_canonico_id F (RESTRICT) | — | — | — | — | — | — | users F RESTRICT |
| cliente_unificacao_events | — | — | — | — | — | — | — | operation_id F RESTRICT |
| ml_tokens | F (CASCADE) | — | F (SET NULL) | ml_user_id N | (PK = grant) | — | — | superseded_by_grant_id F |
| users | — | — | — | — | — | — | — | — |
| squads | — | — | — | — | — | — | — | — |
| squad_members | — | — | — | — | — | — | — | squad_id F, user_id F |
| cliente_squad_history | F (CASCADE) | — | — | — | — | — | — | squad_id F RESTRICT |
| cliente_responsaveis | F (CASCADE) | — | — | — | — | — | — | user_id F |
| seller_clientes | F (CASCADE) | — | — | — | — | — | — | user_id F |
| user_bases | — | — | — | — | — | — | — | user_id F, base_id F |
| bases | — | — | — | — | — | — | — | slug |
| custos | — | — | — | — | — | — | — | base_id F CASCADE |
| base_cliente_vinculos | F (CASCADE) | — | F (SET NULL) | — | — | — | — | base_id F |
| seller_custos_submissoes | F (CASCADE) | — | — | — | — | — | — | base_id/user_id F **sem ON DELETE** |
| central_vendas_imports | **c** | N | F (SET NULL) | external_account_id c | F (SET NULL) | (PK) | F (SET NULL) | base_id F |
| central_vendas_pedidos | c | N | — | — | — | F (CASCADE) | — | — |
| central_vendas_pedido_itens | c | N | — | — | — | F (CASCADE) | — | pedido_row_id F |
| central_vendas_componentes | c | N | — | — | — | F (CASCADE) | — | pedido_row_id/item_row_id F |
| central_vendas_sync_runs | F (CASCADE) | N | F (SET NULL) | external_account_id c | F (SET NULL) | — | (PK) | base_id F, requested_by F |
| central_vendas_sync_sources | — | — | — | — | — | — | F (CASCADE) | — |
| central_vendas_mp_payments | c | — | F (SET NULL) | external_account_id c | — | — | F (CASCADE) | payment_id, order_id |
| central_vendas_mp_payment_charges | — | — | — | — | — | — | **N** | mp_payment_row_id F |
| central_vendas_mp_settlement_reports | c | — | F (SET NULL) | external_account_id c | — | — | F (CASCADE) | — |
| central_vendas_mp_settlement_movements | — | — | **c** | — | — | — | **N** | settlement_report_id F |
| painel_contas_lancamentos_manuais | F (CASCADE) | — | F (**CASCADE**) | — | — | — | — | — |
| painel_contas_lancamentos_manuais_historico | F (CASCADE) | — | **c** | — | — | — | — | — |
| cliente_360_resumos_mensais | F (CASCADE) | N | — | — | — | — | — | — |
| cliente_360_diagnosticos | F (CASCADE) | N | — | — | — | — | — | — |
| cliente_360_diagnostico_itens | — | — | — | — | — | — | — | diagnostico_id F |
| cliente_360_frete_historico | F (CASCADE) | N | — | — | — | — | — | — |
| cliente_360_sync_jobs | F (CASCADE) | N | — | — | — | — | — | — |
| cliente_360_acoes | **c** | N | — | — | — | — | — | mlb |
| margin_snapshot_runs | F (CASCADE) | N | F (CASCADE) | — | — | — | (PK) | base_id F |
| margin_projection_snapshots | F (CASCADE) | — | F (CASCADE) | — | — | — | run_id F SET NULL | item_id |
| anuncios_margem_projetada_snapshot | F (CASCADE) | — | **c** | — | — | — | — | item_id |
| margem_precificacao_aplicacoes | **N** | c | **N** | — | — | — | — | item_id, idempotency_key |
| promo_snapshot_runs | **N** | c | **N** | seller_id N | — | — | (PK) | resumed_from_run_id c |
| promo_snapshot_itens | **N** | — | **N** | seller_id N | — | — | run_id F CASCADE | origem_run_id c |
| promo_snapshot_run_lotes | — | — | — | — | — | — | run_id F CASCADE (PK) | — |
| promo_snapshot_contas | **N** | — | **N** (PK) | seller_id N (PK) | — | — | current/previous/last_attempt_run_id c | — |
| promocoes_diagnosticos | c | N | — | seller_id c | — | — | — | base_slug |
| promocoes_diagnostico_itens | — | — | — | — | — | — | — | diagnostico_id F |
| promocoes_rebate_jobs | **N** | c | c | ml_user_id c | — | — | — | — |
| meli_anuncios | **N** | N | c | ml_user_id c | — | — | — | item_id, user_product_id |
| meli_user_products | **N** | — | c | ml_user_id c | — | — | — | user_product_id |
| meli_anuncio_otimizacoes | c | c | c | — | — | — | — | item_id |
| meli_anuncio_publicacoes | **N** | N | — | ml_user_id c | — | — | — | item_id |
| sentinel_pedidos | F (CASCADE) | — | F (CASCADE) | — | — | — | — | pedido_id |
| sentinel_checkpoints | — | — | **N (PK)** | — | — | — | — | — |
| sentinel_pedido_excecoes | — | — | **N** | — | — | — | — | pedido_id |
| sentinel_incidentes | — | — | F (CASCADE) | — | — | — | — | tipo, chave |
| sentinel_incidente_eventos | — | — | — | — | — | — | — | incidente_id F |
| ads_acompanhamentos | — | **N (só slug)** | — | — | — | — | — | mes_ref, loja_campanha |
| ads_resumos_mensais | — | **N (só slug)** | — | — | — | — | — | mes_ref, loja_campanha |
| financeiro_ads_cache | — | N | **N (PK)** | — | — | — | — | mes_ref |
| relatorios | F (SET NULL) | N | — | — | — | — | — | base_id F, pasta_id F |
| relatorio_itens | — | — | — | — | — | — | — | relatorio_id F |
| relatorio_pastas | — | — | — | — | — | — | — | — |
| diagnosticos_iniciais | F (CASCADE) | — | — | — | — | — | — | — |
| entregas_cliente | F (SET NULL) | c | F (SET NULL) | — | — | — | — | token_publico, origem_id |
| fechamento_incidentes | F (SET NULL) | c | F (SET NULL) | — | — | — | — | codigo |
| fechamento_incidente_arquivos | — | — | — | — | — | — | — | incidente_id F |
| shopee_grants | — | — | F (CASCADE, via DO) | shop_id N | — | — | — | — |
| tiktok_shop_callback_logs | — | — | — | — | — | — | — | state (texto) |
| observability_requests | — | — | — | — | — | — | — | request_id, user_id c |
| observability_client_events | — | — | — | — | — | — | — | request_id, user_id c |
| activity_logs | — | — | — | — | — | — | — | user_id (DDL desconhecido) |
| callbacks | F (SET NULL) | — | — | — | — | — | — | base_slug texto |
| scans | — | — | — | conta_ml texto | — | — | — | user_id F, base_slug texto |
| design_client_profiles | F (PK, CASCADE) | — | — | — | — | — | — | — |
| design_templates | F (CASCADE) | — | — | — | — | — | — | — |
| design_artworks | F (CASCADE) | — | — | — | — | — | — | template_id F |
| design_template_versions | — | — | — | — | — | — | — | template_id F |
| design_artwork_versions | — | — | — | — | — | — | — | artwork_id F |
| venforce_schema_versoes | — | — | — | — | — | — | — | chave |

## Tabelas que só têm `cliente_slug` (sem cliente_id e sem FK)

| Tabela | Consequência |
|---|---|
| ads_acompanhamentos | Renomear o slug do cliente deixa a tabela órfã. O purge precisa casar por slug, e de fato casa: clienteDependenciasService.js:51 usa `"slug"`. **Dado manual.** |
| ads_resumos_mensais | Mesmo problema (clienteDependenciasService.js:52). Mesmo assim aparece na lista `move` da unificação (clientesUnificacao/references.js:22). [inferido] A unificação precisa reescrever o slug, não o id. |

Tabelas cujo cliente_id existe **sem FK** e que dependem do slug (NOT NULL) para casar: central_vendas_imports, central_vendas_pedidos, central_vendas_pedido_itens, central_vendas_componentes, cliente_360_acoes, meli_anuncios, meli_anuncio_publicacoes, promocoes_diagnosticos. Nelas não há integridade referencial com `clientes`, então nada impede órfãos. [código]

## Tabelas sem nenhum identificador de cliente/conta

- users, squads, squad_members, user_bases, bases, custos, relatorio_pastas, venforce_schema_versoes: configuração ou catálogo; o vínculo com o cliente é indireto (custos → bases → base_cliente_vinculos).
- cliente_contas_pendencias, tiktok_shop_callback_logs, observability_*, activity_logs: auditoria/log.
- Filhos que dependem da FK do pai: relatorio_itens, cliente_360_diagnostico_itens, promocoes_diagnostico_itens, central_vendas_sync_sources, central_vendas_mp_payment_charges, central_vendas_mp_settlement_movements, design_*_versions, fechamento_incidente_arquivos, sentinel_incidente_eventos, promo_snapshot_run_lotes, cliente_unificacao_events.
- **scans**: identifica a conta só por `conta_ml` texto, sem ligação com cliente_contas nem com clientes. [código] index.js:672

## Tabelas chaveadas só pela conta (sem cliente_id)

sentinel_checkpoints, sentinel_pedido_excecoes, sentinel_incidentes, shopee_grants, financeiro_ads_cache. A unificação trata essas tabelas como "ACCOUNT_ALREADY_AUTHORITATIVE" (clientesUnificacao/references.js:41-60). Entre elas, sentinel_checkpoints, sentinel_pedido_excecoes e financeiro_ads_cache **não têm FK** para cliente_contas: excluir uma conta deixa essas linhas órfãs. [código]

## Lista de FKs (filho.coluna → pai, ON DELETE)

**CASCADE**
- cliente_contas.cliente_id, ml_tokens.cliente_id, cliente_imagens.cliente_id, cliente_squad_history.cliente_id, cliente_responsaveis.cliente_id/user_id, seller_clientes.user_id/cliente_id, user_bases.user_id/base_id, custos.base_id, base_cliente_vinculos.base_id/cliente_id, seller_custos_submissoes.cliente_id, squad_members.squad_id/user_id
- central_vendas_pedidos.import_id, central_vendas_pedido_itens.import_id/pedido_row_id, central_vendas_componentes.import_id/pedido_row_id/item_row_id
- central_vendas_sync_runs.cliente_id, central_vendas_sync_sources.sync_run_id, central_vendas_mp_payments.sync_run_id, central_vendas_mp_payment_charges.mp_payment_row_id, central_vendas_mp_settlement_reports.sync_run_id, central_vendas_mp_settlement_movements.settlement_report_id
- painel_contas_lancamentos_manuais.cliente_id/**cliente_conta_id**, painel_contas_lancamentos_manuais_historico.cliente_id
- cliente_360_resumos_mensais/diagnosticos/frete_historico/sync_jobs.cliente_id, cliente_360_diagnostico_itens.diagnostico_id
- margin_snapshot_runs.cliente_id/cliente_conta_id, margin_projection_snapshots.cliente_id/cliente_conta_id, anuncios_margem_projetada_snapshot.cliente_id
- promo_snapshot_itens.run_id, promo_snapshot_run_lotes.run_id, promocoes_diagnostico_itens.diagnostico_id
- sentinel_pedidos.cliente_id/cliente_conta_id, sentinel_incidentes.cliente_conta_id, sentinel_incidente_eventos.incidente_id
- shopee_grants.cliente_conta_id, diagnosticos_iniciais.cliente_id, relatorio_itens.relatorio_id, fechamento_incidente_arquivos.incidente_id
- design_client_profiles/templates/artworks.cliente_id, design_template_versions.template_id, design_artwork_versions.artwork_id
- scans.user_id

**SET NULL**
- ml_tokens.cliente_conta_id, base_cliente_vinculos.cliente_conta_id/confirmado_por
- central_vendas_imports.cliente_conta_id/base_id/grant_id/sync_run_id; central_vendas_sync_runs.cliente_conta_id/grant_id/base_id/requested_by; central_vendas_mp_payments.cliente_conta_id; central_vendas_mp_settlement_reports.cliente_conta_id
- cliente_squad_history.alterado_por, painel_contas_*.created_by/updated_by/user_id, cliente_360_diagnosticos.gerado_por, cliente_360_sync_jobs.iniciado_por
- margin_snapshot_runs.base_id/requested_by, margin_projection_snapshots.base_id/run_id
- relatorios.user_id/cliente_id/base_id/pasta_id, entregas_cliente.cliente_id/cliente_conta_id/created_by, fechamento_incidentes.cliente_id/cliente_conta_id/usuario_id
- callbacks.cliente_id, diagnosticos_iniciais.responsavel_user_id, design_*.created_by/updated_by, design_artworks.template_id

**RESTRICT**
- clientes.merged_into_cliente_id, cliente_squad_history.squad_id, cliente_unificacoes.cliente_canonico_id/requested_by/confirmed_by, cliente_unificacao_events.operation_id/actor_user_id

**Sem ON DELETE (NO ACTION implícito)**
- seller_custos_submissoes.user_id/base_id/revisado_por, ml_tokens.superseded_by_grant_id

## Pontos de atenção nos relacionamentos

1. **Excluir uma conta apaga o lançamento manual.** `painel_contas_lancamentos_manuais.cliente_conta_id` é ON DELETE CASCADE (painel_contas_schema.sql:17). O histórico sobrevive porque não tem FK de conta. [código]
2. **Excluir um cliente apaga sync_runs e, em cascata, toda a evidência MP.** Os imports da Central, por outro lado, ficam (cliente_id sem FK; sync_run_id SET NULL). [código] central_vendas_schema.sql:154/222/365. O clientePurgeService compensa: apaga explicitamente as tabelas sem FK (central_vendas_imports, cliente_360_acoes etc.) e as que só têm slug (`TABELAS_SEM_FK_POR_SLUG`, clientes/clientePurgeService.js:46-51/120). [código] Qualquer outro caminho que remova o cliente (por exemplo, um DELETE manual) deixa os imports órfãos. [inferido]
3. **Dois identificadores de vendedor ML convivem:** `ml_user_id` (ml_tokens, meli_*, promocoes_rebate_jobs), `seller_id` (promo_snapshot_*, promocoes_diagnosticos) e `external_account_id` (cliente_contas, central_vendas_*). Os três nomes guardam o mesmo valor. [inferido pelo uso em clienteContaService, que casa external_account_id com ml_user_id]
4. **Tipos divergentes para o mesmo id:** cliente_id é INTEGER em clientes, mas BIGINT em central_vendas_*, margin_*, promo_*, promocoes_rebate_jobs e margem_precificacao_aplicacoes. Já cliente_conta_id é INTEGER em cliente_contas e BIGINT nas tabelas de margem/promo/MP. Funciona (o PG converte), mas mostra a falta de padrão. [código]
5. `central_vendas_mp_payment_charges.sync_run_id` e `central_vendas_mp_settlement_movements.sync_run_id` são NOT NULL sem FK. É redundância desnormalizada para filtro. [código]
