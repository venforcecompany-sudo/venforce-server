# Classificação e retenção

Colunas:
- **Reconstr.**: dá para reconstruir a tabela? (sim / não / parcial, e de onde).
- **Manual/protegida**: contém dado digitado ou enviado por pessoa, que não pode ser apagado por rotina.
- **Ret. atual**: o que o código apaga hoje. "nenhuma" significa que não há DELETE automático em código de produção ([código], por ausência de `DELETE FROM <tabela>` fora de `tests/` e `scripts/`).
- **Ret. recomendada**: proposta; nada disso foi validado com volume real ([não verificado], sem acesso ao banco).
- **Risco**: perda ao excluir a tabela ou as linhas.

Etiqueta padrão das colunas classe, reconstr. e ret. atual: **[código]**. As recomendações são, por natureza, **[inferido]**.

| Tabela | Classe | Reconstr. | Manual/protegida | Ret. atual | Ret. recomendada | Risco |
|---|---|---|---|---|---|---|
| clientes | canônica | não | sim | nenhuma (purge manual) | manter | ALTO |
| cliente_contas | canônica | parcial (OAuth recria a conta ML; nickname/config se perdem) | sim | nenhuma | manter | ALTO |
| cliente_contas_pendencias | auditoria de migração | não (foto do backfill) | não | nenhuma | arquivar após revisão | baixo |
| cliente_imagens | canônica | não | sim (upload) | DELETE pela UI (`removerImagem`) | manter | médio |
| cliente_unificacoes | auditoria | não | sim | nenhuma | permanente | ALTO |
| cliente_unificacao_events | auditoria (append) | não | sim | nenhuma | permanente | ALTO |
| ml_tokens | canônica (credencial) | parcial (exige reautorização do cliente) | sim | DELETE ao desconectar | manter; arquivar superseded > 90 d | ALTO |
| users | canônica | não | sim | DELETE manual | manter | ALTO |
| squads | configuração | não | sim | nenhuma | manter | médio |
| squad_members | configuração | não | sim | nenhuma (soft: ativo) | manter | médio |
| cliente_squad_history | histórico + canônica | não | sim | nenhuma | permanente | ALTO (gate de acesso) |
| cliente_responsaveis | configuração | não | sim | nenhuma (soft) | manter | médio |
| seller_clientes | configuração | não | sim | nenhuma (soft) | manter | médio |
| user_bases | configuração legada | não | sim | nenhuma | avaliar remoção [inferido: 2 refs] | baixo |
| bases | canônica | não | sim (planilha) | DELETE manual | manter | ALTO |
| custos | canônica | não (planilha de custo do cliente) | **sim** | sobrescrita ao reimportar (DELETE por base) | manter; [inferido] guardar versão anterior antes de reimportar | ALTO |
| base_cliente_vinculos | canônica | não | sim | nenhuma (soft: desativar) | manter | ALTO |
| seller_custos_submissoes | canônica | não | sim | nenhuma | manter | ALTO |
| central_vendas_imports (sync) | snapshot | sim (novo sync ML, dentro da janela da API) | não | retenção por dominância: CLI ou `CENTRAL_VENDAS_RETENCAO_AUTO` (opt-in), 72 h, mantém 1 substituído | ligar a auto; zerar `payload_json` (sem leitor) | baixo |
| central_vendas_imports (planilha, `fonte='planilha_vendas'`, legacy) | canônica manual | **não** | **sim, protegida** | **elegível**: `incluirLegacy: true` por padrão (retencao/centralVendasRetencaoPlanner.js:42) | **nunca apagar**; padrão `incluirLegacy=false` ou filtrar por `fonte` | ALTO |
| central_vendas_pedidos | snapshot (filho) | sim (com o import) | herda do import | CASCADE do import | idem import | herda |
| central_vendas_pedido_itens | snapshot (filho) | idem | herda | CASCADE | idem; remover `payload_json` (sem leitor) | herda |
| central_vendas_componentes | snapshot (filho) | idem | herda | CASCADE | idem; remover `payload_json` | herda |
| central_vendas_sync_runs | auditoria/controle | não (histórico de execução) | não | nenhuma | 13 meses (sem import nem MP vinculado) | baixo |
| central_vendas_sync_sources | auditoria | não | não | CASCADE do run | idem run | baixo |
| central_vendas_mp_payments | evidência (1 cópia por run) | sim (API MP) | não | executor apaga payments de run terminal > 72 h sem import retido | manter só o run mais recente por payment_id | baixo |
| central_vendas_mp_payment_charges | evidência | sim | não | CASCADE do payment (DELETE+INSERT por run) | idem | baixo |
| central_vendas_mp_settlement_reports | evidência | parcial (o relatório MP precisa ser regerado) | não | **nenhuma** (o executor não toca) | incluir na retenção: último por período | baixo |
| central_vendas_mp_settlement_movements | evidência | parcial | não | **nenhuma** | idem | baixo |
| painel_contas_lancamentos_manuais | canônica manual | **não** | **sim** | DELETE pela UI; **CASCADE ao excluir a conta** | manter; trocar o FK de conta para RESTRICT | ALTO |
| painel_contas_lancamentos_manuais_historico | auditoria (append) | não | sim | nenhuma | permanente | ALTO |
| cliente_360_resumos_mensais | derivada (agregado) | sim (imports + Ads) | não | nenhuma (upsert) | manter (1 linha por mês) | médio |
| cliente_360_diagnosticos | histórico derivado | parcial (recalculável, mas o histórico se perde) | não | nenhuma | últimos 12 por cliente | baixo |
| cliente_360_diagnostico_itens | histórico derivado | idem | não | CASCADE | idem | baixo |
| cliente_360_frete_historico | histórico | **desconhecido**: não há escritor no código | [não verificado] | nenhuma | investigar origem antes de qualquer ação | médio |
| cliente_360_sync_jobs | controle | não | não | nenhuma | 90 dias | baixo |
| cliente_360_acoes | canônica manual | **não** | **sim** | DELETE pela UI | permanente | ALTO |
| margin_snapshot_runs | controle/auditoria | não | não | nenhuma | 90 dias (manter o último por conta) | baixo |
| margin_projection_snapshots | snapshot (estado atual) | sim (worker) | não | nenhuma (upsert, 1 por item) | não precisa | baixo |
| anuncios_margem_projetada_snapshot | snapshot legado | sim | não | nenhuma | aposentar (duplica margin_projection_snapshots) | baixo |
| margem_precificacao_aplicacoes | auditoria (escrita no ML) | não | sim (ato do usuário) | nenhuma | permanente (ou ≥ 24 meses) | ALTO |
| promo_snapshot_runs | controle | sim | não | poda por conta: `PROMO_SNAPSHOT_RUNS_RETIDOS` = 20 | 5–20 | baixo |
| promo_snapshot_itens | snapshot | sim (API ML) | não | `finalizarRun` mantém só os itens do snapshot atual e do anterior do seller (promoSnapshotRepository.js:660-663), mais a poda | ok | baixo |
| promo_snapshot_run_lotes | controle | sim | não | idem (poda) | idem | baixo |
| promo_snapshot_contas | ponteiro de vigência | sim | não | DELETE ao trocar de seller | não precisa | baixo |
| promocoes_diagnosticos | histórico derivado (legado) | sim | não | nenhuma | congelar e aposentar | baixo |
| promocoes_diagnostico_itens | idem | sim | não | CASCADE | idem | baixo |
| promocoes_rebate_jobs | auditoria/controle | não | sim (ação do usuário) | nenhuma | 180 dias | médio |
| meli_anuncios | cache (+campos confirmados manualmente) | parcial (sync ML; a marcação "revisado"/confirmados se perde) | parcial | nenhuma | manter | médio |
| meli_user_products | cache | sim (sync ML) | não | nenhuma | manter | baixo |
| meli_anuncio_otimizacoes | histórico + aprovação | não (custo de IA, aprovação humana) | sim | nenhuma | 12 meses para as não aprovadas | médio |
| meli_anuncio_publicacoes | auditoria | não | sim | nenhuma | permanente | médio |
| sentinel_pedidos | derivada | sim (polling, dentro da janela ML) | não | **nenhuma** | 90 dias | baixo |
| sentinel_checkpoints | controle | sim | não | nenhuma (1 por conta) | não precisa | baixo |
| sentinel_pedido_excecoes | canônica (resolução) | não | sim | nenhuma | 12 meses após resolvida | médio |
| sentinel_incidentes | estado + histórico | não | parcial (reconhecer/resolver) | nenhuma | 12 meses após resolvido | médio |
| sentinel_incidente_eventos | auditoria | não | sim | CASCADE do incidente | idem incidente | médio |
| ads_acompanhamentos | canônica manual | **não** | **sim** | nenhuma | permanente | ALTO |
| ads_resumos_mensais | misto (planilha + sync) | parcial (sync sim; upload manual não) | parcial | nenhuma (upsert, último vence) | manter; [inferido] separar a origem | médio |
| financeiro_ads_cache | cache | sim (API Ads) | não | nenhuma | 13 meses | baixo |
| relatorios | histórico | parcial (gera de novo, mas com foto diferente) | sim (o relatório foi entregue) | DELETE manual | manter; [inferido] avaliar 24 meses para diagnósticos automáticos | médio |
| relatorio_itens | histórico | idem | herda | CASCADE | idem | médio |
| relatorio_pastas | configuração | não | sim | DELETE manual | manter | baixo |
| diagnosticos_iniciais | canônica manual | não | sim | nenhuma | permanente | ALTO |
| entregas_cliente | canônica (documento entregue, link público) | **não** | **sim** | DELETE manual | permanente | ALTO |
| fechamento_incidentes | temporária | não | não | `expires_at`, 15 d, job a cada 6 h | ok | baixo |
| fechamento_incidente_arquivos | temporária | não | não | CASCADE | ok | baixo |
| shopee_grants | canônica (credencial) | parcial (reautorização) | sim | nenhuma | manter | ALTO |
| tiktok_shop_callback_logs | log bruto | não | não | **nenhuma** | 30 dias | baixo |
| observability_requests | log | não | não | 7 dias / 50 mil linhas (`OBSERVABILITY_RETENTION_DAYS`/`MAX_ROWS`) | ok | baixo |
| observability_client_events | log | não | não | idem | ok | baixo |
| activity_logs | auditoria de negócio | não | sim | **nenhuma** (e sem DDL no código) | 24 meses, particionada por mês | médio |
| callbacks | log de uso da API | não | não | **nenhuma** | 90 dias | baixo |
| scans | histórico (extensão) | não | não | DELETE manual | 12 meses | baixo |
| design_client_profiles | canônica | não | sim | nenhuma | manter | ALTO |
| design_templates / design_artworks | canônica | não | sim | soft (`archived_at`) | manter | ALTO |
| design_template_versions / design_artwork_versions | histórico (append) | não | sim | nenhuma | manter as N últimas versões | médio |
| venforce_schema_versoes | configuração | sim (o boot reaplica) | não | nenhuma | manter | baixo |

## Retenção que já existe no código (resumo)

| Mecanismo | Tabelas | Ligado por padrão? | Evidência |
|---|---|---|---|
| Cleanup de observabilidade (7 d / 50 mil linhas, `setInterval`) | observability_requests, observability_client_events | sim (etapa de boot `observability-cleanup`) | [código] observabilityService.js:38-39/1006; index.js (etapa observability-cleanup) |
| Expiração de incidentes de fechamento (15 d, job a cada 6 h) | fechamento_incidentes (+arquivos) | sim | [código] fechamentoIncidentStorageService.js:24/117 |
| Poda de promo snapshot (20 runs/conta, após cada run) | promo_snapshot_runs/itens/run_lotes | só com o worker ligado (`PROMO_SNAPSHOT_WORKER_ENABLED`) | [código] promoSnapshotService.js:238; promoSnapshotConfig.js:221 |
| Retenção por dominância da Central | central_vendas_imports (+filhos), central_vendas_mp_payments | **não**: CLI `scripts/central-vendas-retencao.js` ou `CENTRAL_VENDAS_RETENCAO_AUTO=true` | [código] retencao/centralVendasRetencaoAuto.js; centralVendasRetencaoPlanner.js:40-42 |

## Lacunas de retenção (crescem sem limite)

[código] Não há DELETE automático para nenhuma destas tabelas:
- central_vendas_sync_runs e central_vendas_sync_sources
- central_vendas_mp_settlement_reports e central_vendas_mp_settlement_movements
- margin_snapshot_runs
- cliente_360_sync_jobs e cliente_360_diagnosticos
- sentinel_pedidos e sentinel_incidente_eventos
- promocoes_diagnosticos
- promocoes_rebate_jobs
- activity_logs, callbacks, tiktok_shop_callback_logs, scans
- design_*_versions

[inferido] Pelo padrão append-only, as que mais crescem são sentinel_pedidos (uma linha por pedido de cada conta monitorada), activity_logs e callbacks (uma por chamada da extensão).
