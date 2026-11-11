# Inventário de tabelas por domínio — PostgreSQL Venforce

Inventário feito **só lendo o código** da worktree `wt-pg-reorg` (branch `feat/pg-reorganizacao`), em 11/11/2026.
Nenhum banco foi consultado: volumes, existência real de índices e linhas órfãs **não** foram verificados.

## Etiquetas de evidência

- **[código]**: confirmado lendo o código. Caminhos relativos a `server/`, salvo quando indicado.
- **[inferido]**: dedução a partir do código. O motivo vem junto.
- **[não verificado]**: não encontrei evidência no código (por exemplo, nenhuma chamada da rota no Portal).

Abreviações usadas nas fichas: **W** = quem grava, **R** = quem lê, **UI** = telas do Portal, **Id** = colunas de identidade, **Ret.** = retenção atual / recomendada.
Caminhos `Portal/...` e `frontend-react/src/...` são relativos à raiz do repositório.

## Como as tabelas nascem (fonte do DDL)

| Mecanismo | Tabelas | Evidência |
|---|---|---|
| Inline no boot (`server/index.js`) | users, bases, user_bases, custos, clientes, base_cliente_vinculos, callbacks, ml_tokens, scans, relatorios, relatorio_itens, relatorio_pastas | [código] index.js:609-852 |
| Arquivo `.sql` lido por um `ensure*` | central_vendas_* (schema), cliente_360_* (exceto ações), design_*, diagnosticos_iniciais, margin_snapshot_*, observability_*, painel_contas_*, promocoes_diagnostico* | [código] centralVendasRepository.js:10, cliente360Repository.js:15, designStudioRepository.js:6, diagnosticoInicialRepository.js:8, marginSnapshotRepository.js:15, observabilityRepository.js:12, painelContasRepository.js:18, promocoesDiagnosticoService.js:34 |
| Migration aplicada por `schemaEnsure`/`sentinelSchema` com marcador de versão | cliente_contas(+pendências), squads/*, entregas (colunas), anuncios_margem_projetada_snapshot, margem_precificacao_aplicacoes, promo_snapshot_*, promocoes_rebate_jobs, financeiro_ads_cache, shopee_grants, sentinel_* | [código] schema/schemaEnsure.js:246-537, sentinel/sentinelSchema.js:10-76 |
| DDL inline em service (lazy, na 1ª chamada) | ads_*, cliente_imagens, meli_anuncios, meli_user_products, meli_anuncio_otimizacoes, meli_anuncio_publicacoes, seller_clientes, seller_custos_submissoes, tiktok_shop_callback_logs, fechamento_incidente* (duplicado na migration), entregas_cliente | [código] adsService.js:5/96, clienteImagemService.js:57, meliAnunciosService.js:40, meliFamiliaService.js:40, otimizadorMeliService.js:48, meliCriacaoService.js:36, sellerService.js:52/65, controllers/tiktokShopController.js:5, repositories/fechamentoIncidenteRepository.js:9/33, schema/schemaEnsure.js:62 |
| **Só migration manual (nenhum código aplica)** | cliente_360_acoes, cliente_unificacoes, cliente_unificacao_events (+ `clientes.merged_into_cliente_id`, `ml_tokens.superseded_*`) | [código] não há `readFileSync` desses arquivos fora de `tests/`. docs/CLIENTE_360_REACT_MIGRACAO.md:404 manda rodar `psql -f` |
| **Sem DDL nenhum no código** | activity_logs | [código] só `INSERT` (activityLogService.js:15) e `SELECT` (controllers/logsController.js:60). O DDL só existe no fake PGlite `scripts/lib/custosPglite.js:51` |
| Infraestrutura | venforce_schema_versoes | [código] schema/schemaVersionado.js:37/109 |

Observação: o `index.js` da **raiz** do repositório (fora de `server/`) também tem `CREATE TABLE` de users, bases, user_bases, custos, clientes, callbacks, ml_tokens e scans ([código] /index.js:142-191). O `server/package.json:5` aponta `main` para `server/index.js`. [inferido] É um servidor legado duplicado; se ainda estiver rodando em algum lugar, é uma segunda fonte de DDL divergente.

---

## 1. Clientes e contas (7)

**clientes**: cadastro do cliente (slug, api_key, ativo, `merged_into_cliente_id`).
DDL: index.js:630; coluna de merge em migrations/20261014_clientes_unificacao_executor.sql:4. Classe: canônica. Origem: usuário.
- W: `squadService.criarClienteComSquad` (squads/squadService.js:386); `PATCH /clientes/:slug/desativar` (index.js:1743); `clientePurgeService` faz DELETE (clientes/clientePurgeService.js:132). [código]
- R: praticamente todos os serviços (são 110 referências SQL). UI: Portal/clientes.html e clientes.js. [código]
- PK id. FK `merged_into_cliente_id` → clientes ON DELETE RESTRICT. Id: o próprio id/slug.
- Escrita: upsert por clique. Ret.: nenhuma / manter. Risco de excluir: **ALTO**, porque a raiz de CASCADE derruba quase todo o domínio. [código]

**cliente_contas**: conta de marketplace de um cliente (ML/Shopee/TikTok), com `external_account_id` e `is_primary`.
DDL: migrations/20260817_cliente_contas_foundation.sql:24. Classe: canônica. Origem: usuário + OAuth.
- W: clienteContas/clienteContaService.js (`criarConta`:342, `garantirContaMlParaGrant`:427, `vincularGrantMlNaConta`:490, `atualizarConta`:593, `definirContaPrincipal`:610); `shopeeGrantService.salvarGrantLive` (shopee/shopeeGrantService.js:152). [código]
- R: Sentinel, Central, Painel, Margem, Promo, Shopee e outros. UI: Portal/clientes.js, vf-context.js, vf-shell.js (`/contas`). [código]
- PK id. FK cliente_id → clientes ON DELETE CASCADE. UNIQUE (cliente_id, marketplace, external_account_id) e índice parcial de principal.
- Ret.: nenhuma / manter. Risco: **ALTO**, porque cascateia painel manual, margin snapshot, Sentinel e shopee_grants. [código]

**cliente_contas_pendencias**: conflitos do backfill de contas (ml_user_id duplicado entre clientes).
DDL: 20260817_cliente_contas_foundation.sql:65. Classe: auditoria de migração.
- W: só a própria migration (INSERT ... SELECT, linha 96). [código]
- R: nenhum leitor no código. [código]
- Sem FK e sem identificadores de cliente (os dados ficam em `detalhes` JSONB).
- Ret.: nenhuma / revisar e arquivar. Risco: baixo. [inferido] Tabela de uso único.

**cliente_imagens**: logo/foto do cliente.
DDL: clienteImagens/clienteImagemService.js:57. PK cliente_id → clientes ON DELETE CASCADE.
- W/R: clienteImagemService (`salvarImagem`:101, `removerImagem`:117). UI: Portal/clientes.js e bases.js (`/cliente-imagens`). Classe: canônica (upload manual).
- Ret.: manter. Risco: médio, porque é upload manual. [código]

**cliente_unificacoes**: operação de unificação de clientes (idempotência, plano, status).
DDL: migrations/20261014_clientes_unificacao_executor.sql:17, **manual**.
- W/R: clientesUnificacao/repository.js:831/872. UI: Portal/clientes-unificacao.js (`/admin/clientes-unificacao`).
- FK cliente_canonico_id → clientes ON DELETE RESTRICT; requested_by e confirmed_by → users RESTRICT. Classe: auditoria.
- Ret.: nenhuma / manter para sempre. Risco: **ALTO**, porque é a trilha de uma operação irreversível. [código]

**cliente_unificacao_events**: eventos append-only da unificação.
DDL: mesma migration, :43. W: clientesUnificacao/repository.js:881 (`audit`). R: nenhum `SELECT` no código. [código]
- FK operation_id → cliente_unificacoes RESTRICT; actor_user_id → users RESTRICT. Classe: auditoria (append-only).
- Ret.: manter. Risco: ALTO.

**ml_tokens**: grants OAuth do Mercado Livre (access/refresh token, ml_user_id, is_primary, `superseded_*`, cliente_conta_id).
DDL: index.js:662, mais ALTERs em index.js:814-835 e nas migrations 20260806, 20260817:78 e 20261020 (manual).
- W: mlTokenService.js (`saveMlToken`:668, `renovarComLock`:576, `setPrimaryGrant`:337, falhas/validade:430-495); clienteContaService.js:447/496/747 (DELETE ao desconectar); `DELETE /clientes/:slug/ml-token` (index.js:1553). [código]
- Frequência: worker de refresh (`startTokenRefreshWorker`, utils/tokenRefreshWorker.js:62) e OAuth por clique. UI: Portal/ml-tokens.html e clientes.js (`/ml/`).
- PK id. FKs: cliente_id → clientes CASCADE (index.js:814); cliente_conta_id → cliente_contas SET NULL; superseded_by_grant_id → ml_tokens (sem ON DELETE). Id: cliente_id, cliente_conta_id, ml_user_id.
- Classe: canônica (credencial). Ret.: manter (os superseded podem ser arquivados). Risco: **ALTO**, porque o cliente teria de reautorizar a conta.
- Problema: o UNIQUE original `ml_user_id` foi derrubado e substituído por `(cliente_id, ml_user_id)`. A versão parcial (`WHERE superseded_by_grant_id IS NULL`) só existe na migration manual 20261020. [código] index.js:824-831 e migrations/20261020_ml_grants_superseded.sql

## 2. Squads e permissões (7)

**users**: usuários internos e sellers.
DDL: index.js:609. W: `POST /usuarios` (index.js:1876), `DELETE /usuarios/:id` (index.js:1950), `authController.register` (controllers/authController.js:14). UI: Portal/usuarios.html. Classe: canônica. Ret.: manter. Risco: ALTO. [código]

**squads**: squads da operação.
DDL: migrations/20260827_squads_foundation.sql:23. W: squadService.js:90/127, squadsRepository.js:138/156, squadsMigracaoImportService.js:401. UI: Portal/squads-config.js. PK id. Classe: configuração. Risco: médio. [código]

**squad_members**: membros de cada squad, com função (incluindo gestor).
DDL: squads_foundation.sql:56. FKs squad_id → squads CASCADE; user_id → users CASCADE. W: squadService.js:172-301. R: authorizationService.js, painelContasAcesso.js. Classe: configuração. [código]

**cliente_squad_history**: vínculo cliente↔squad com vigência (histórico).
DDL: squads_foundation.sql:97. FKs cliente_id → clientes CASCADE; squad_id → squads **RESTRICT**; alterado_por → users SET NULL.
- W: squadService.js:343/398/449/480. R: authorizationService, Sentinel, Painel, Unificação. UI: squads-config.js, clientes.js.
- Classe: histórico + canônica (a linha ativa, garantida por índice parcial único). Modo: append e fecha a vigência. Ret.: manter. Risco: ALTO, porque decide o acesso. [código]

**cliente_responsaveis**: responsáveis (papel) por cliente.
DDL: squads_foundation.sql:127, mais colunas P2.4. FKs cliente_id e user_id CASCADE. W: squadsRepository.js:366/385/403. UI: `/clientes/:id/responsaveis` em clientes.js [inferido pelo prefixo `/clientes`]. Classe: configuração. [código]

**seller_clientes**: permissão de um usuário seller sobre um cliente/marketplace.
DDL: sellerService.js:52. FKs user_id e cliente_id CASCADE. W: sellerService.js:567/603. R: authorizationService.js. UI: Portal/usuarios.js e seller.js. Classe: configuração. [código]

**user_bases**: N:N usuário × base (acesso legado).
DDL: index.js:619. PK (user_id, base_id), as duas FKs CASCADE. W: baseImportService.criarBaseComCustos (bases/baseImportService.js:111). R: index.js. Classe: configuração legada. [inferido] Pouco usada hoje (2 referências no código).

## 3. Custos e bases (4)

**bases**: base de custos (planilha de custos de um cliente/marketplace).
DDL: index.js:615. W: baseImportService.js:98, baseCustosService.js:507, meliCustosLoteService.js:121, `DELETE /bases/:baseId` (index.js:1272). UI: Portal/bases.html e bases.js. PK id, slug UNIQUE. **Não tem cliente_id**: o vínculo é feito por base_cliente_vinculos. Classe: canônica (manual). Risco: **ALTO**. [código]

**custos**: linha de custo por SKU/variação.
DDL: index.js:624, mais colunas e índices em index.js:752-806 e migrations 20260810 e 20261014_custos_shopee_item_model.
- FK base_id → bases CASCADE. W: baseCustosService.js:303/381 (upsert), baseImportService.js:8/39 (DELETE+INSERT ao reimportar), meliCustosLoteService.js:117.
- R: precificação, Central, Sentinel, Margem, Financeiro. Origem: **planilha manual** e edição pela UI.
- Classe: canônica. Modo: sobrescrito ao reimportar (DELETE da base inteira em baseImportService.js:8). Ret.: manter. Risco: **ALTO** (irreconstruível). [código]
- Problema: há três UNIQUE parciais convivendo (`uq_custos_base_sku_id`, `uq_custos_base_produto_sku_legado`, `uq_custos_base_produto_sku_model`). [código] migrations/20260810 e 20261014

**base_cliente_vinculos**: base ↔ cliente/conta (uma ativa por base).
DDL: index.js:638 (+cliente_conta_id em 20260817:87). FKs base_id e cliente_id CASCADE; cliente_conta_id SET NULL; confirmado_por → users SET NULL.
- W: baseVinculosService.js:338/402, clienteContaService.js:701. R: 18 serviços. UI: Portal/bases.js, financeiro.js, cliente-360.js (`/base-vinculos`). Classe: canônica. Risco: ALTO. [código]

**seller_custos_submissoes**: custos enviados pelo seller para revisão.
DDL: sellerService.js:65. FKs cliente_id CASCADE; user_id, base_id e revisado_por → users/bases **sem ON DELETE** (default NO ACTION).
- W: sellerService.js:421/654. UI: Portal/seller.js. Classe: canônica (dado do usuário). Risco: ALTO. [código]
- Problema: a FK sem ON DELETE em base_id/user_id impede excluir uma base ou um usuário que tenha submissões. [inferido pelo default do PG]

## 4. Central de Vendas (6)

Origem: API ML (Orders/Shipments/Claims/Billing) pelo sync, ou **planilha manual** (`fonte='planilha_vendas'`, `publication_status='legacy'`, sem sync_run_id).
Gravação: `persistCentralVendasImport` (centralVendas/centralVendasRepository.js:389), chamado por centralVendasImportService.js (planilha) e centralVendasSyncService.js (API). [código]
Frequência: sync manual "Sincronizar agora" (`POST /operacao/central-vendas/:slug/sync-runs`) e scheduler noturno opt-in `CENTRAL_VENDAS_NOTURNO_ENABLED` (centralVendasNoturnoScheduler.js:53), que grava toda noite o mês corrente 01→ontem como **import novo**. [código]

**central_vendas_imports**: um snapshot (import) por cliente/conta/marketplace/competência.
- Guarda resumo_json e payload_json (o motorPayload inteiro, **sem leitor**). Colunas de publicação: publication_status, coverage_date_*, published_at.
- DDL: sql/central_vendas_schema.sql:1 (+ALTERs :95-297). PK id.
- FKs: cliente_conta_id → cliente_contas SET NULL; base_id → bases SET NULL; grant_id → ml_tokens SET NULL; sync_run_id → central_vendas_sync_runs SET NULL. **cliente_id sem FK.**
- Id: cliente_id, cliente_slug (NOT NULL), cliente_conta_id, external_account_id, grant_id, sync_run_id.
- W: centralVendasRepository.js:203 (`createImport`), :948 (`promoverCandidatesDoRun`), retencao/centralVendasRetencaoExecutor.js:169 (DELETE).
- R: centralVendasReadService, centralVendasService, fechamentoViaApiService (Financeiro), painelContasRepository.js:135, centralVendasNoturnoService, centralVendasEvidenceAdapter (Margem).
- UI: frontend-react/src/services/fechamentoViaApiApi.js:131 (sync-runs). As leituras de vendas chegam à UI indiretamente via `/financeiro`, `/painel-contas` e `/operacao/cliente-360`.
- Classe: snapshot. Planilhas legacy: canônico manual. Modo: append (um import por execução).
- Índices: (cliente_slug, competencia, created_at DESC), (cliente_conta_id, competencia), (sync_run_id), (cliente_slug, marketplace, competencia, publication_status).
- Ret.: retenção por dominância. CLI em scripts/central-vendas-retencao.js; automática opt-in `CENTRAL_VENDAS_RETENCAO_AUTO=true` (retencao/centralVendasRetencaoAuto.js), padrão 72 h e 1 substituído mantido; **`incluirLegacy: true` por padrão** (retencao/centralVendasRetencaoPlanner.js:42). Rec.: ligar a retenção automática **com `incluirLegacy=false`** e zerar payload_json.
- Risco: **ALTO** para imports de planilha; baixo para candidates substituídos (refaz-se com novo sync). [código]

**central_vendas_pedidos**: pedidos de um import.
- DDL: central_vendas_schema.sql:16. FK import_id → imports CASCADE. UNIQUE (import_id, pedido_id). Id: cliente_id e cliente_slug (sem FK), import_id.
- W: centralVendasRepository.js:238. R: centralVendasRepository (`loadPedidosByImportIds`:785), centralVendasCliente360Adapter, painelContasRepository.
- Classe: snapshot (filho). Modo: append por import; uma cópia completa do mês **a cada import**. Ret.: cai junto com o import (CASCADE). [código]

**central_vendas_pedido_itens**: itens do pedido.
- DDL: :41. FKs import_id e pedido_row_id CASCADE. UNIQUE (import_id, item_id). W: :270. R: Read API (ITEM_READ_COLUMNS, que **não** inclui payload_json) e adapter C360.
- Classe: snapshot (filho). Problema: payload_json gravado e nunca lido. [código + fato dado]

**central_vendas_componentes**: componentes financeiros (comissão, frete, rebate etc.) por pedido/item.
- DDL: :70 (+escopo/efeito/incluido_no_resultado :330). FKs import_id, pedido_row_id e item_row_id CASCADE (índice item_row: migrations/20261030).
- W: :327. R: Read API (COMPONENTE_READ_COLUMNS, sem payload_json), sql/auditoria/central_vendas_historico_frete_pack.sql.
- Classe: snapshot (filho, o maior volume). Problema: payload_json sem leitor. [código]

**central_vendas_sync_runs**: execução de um sync (status, intervalo, completeness).
- DDL: :154. FKs cliente_id → clientes **CASCADE**; cliente_conta_id → cliente_contas SET NULL; grant_id → ml_tokens SET NULL; base_id → bases SET NULL; requested_by → users SET NULL.
- Índice único "ativo" (uq_..._ativo_v2). W: centralVendasSyncRunService.js:204-555. R: Painel, Financeiro, meService, publicação, retenção. UI: fechamentoViaApiApi.js:140.
- Classe: auditoria/controle. Modo: append + update de status. Ret.: **nenhuma**. Rec.: manter 13 meses. Risco: baixo (metadado). [código]

**central_vendas_sync_sources**: status por fonte dentro do run.
- DDL: :240. FK sync_run_id CASCADE. UNIQUE (sync_run_id, source). W: centralVendasSyncSourceService.js:94/116/169. R: o mesmo service e centralVendasMpPaymentsRepository.
- Classe: auditoria. Ret.: nenhuma (cai com o run). [código]

## 5. Mercado Pago (4)

**central_vendas_mp_payments**: Payments do MP observados num run. Origem: API MP.
- DDL: central_vendas_schema.sql:363. FKs sync_run_id → sync_runs CASCADE; cliente_conta_id SET NULL. **UNIQUE (sync_run_id, payment_id): uma cópia por run.** Id: cliente_id (sem FK), cliente_conta_id, external_account_id, sync_run_id.
- W: centralVendasMpPaymentsRepository.js:43 (`upsertMpPayment`, chamado em centralVendasSyncService.js:45). R: centralVendasMpReconciliationService, Mp3ReadService → financeiroVisaoService (`/financeiro`).
- Classe: evidência/snapshot. Modo: append por run. Ret.: o executor da retenção apaga os payments de runs terminais sem import retido e com mais de 72 h (retencao/centralVendasRetencaoExecutor.js:189). Rec.: guardar só o último run por payment.
- Risco: baixo (refaz-se pela API, dentro da janela do MP). [código]
- Índices de run/payment/order removidos por estarem sem uso (migrations/20261029_central_vendas_mp_indices_sem_uso.sql).

**central_vendas_mp_payment_charges**: charges/fees de cada payment.
- DDL: :405. FK mp_payment_row_id → mp_payments CASCADE. **sync_run_id NOT NULL sem FK.** W: :104 (`replaceMpPaymentCharges`, DELETE+INSERT). Classe: evidência (filho). Ret.: cai com o payment. [código]

**central_vendas_mp_settlement_reports**: relatório de liquidação do MP, um por run.
- DDL: :445. FKs sync_run_id CASCADE; cliente_conta_id SET NULL. UNIQUE (sync_run_id). W: centralVendasMpSettlementRepository.js:85/131. R: o mesmo repo e o reconciliation.
- Classe: evidência. Ret.: **nenhuma** (o executor só apaga mp_payments; o relatório só cai via CASCADE do run, e não há DELETE de runs). Rec.: incluir na retenção. [código]

**central_vendas_mp_settlement_movements**: linhas do CSV de settlement.
- DDL: :485. FK settlement_report_id CASCADE. sync_run_id NOT NULL e cliente_conta_id **sem FK**. W: :169 (DELETE+INSERT). Classe: evidência. Ret.: nenhuma. Risco: baixo. [código]

## 6. Painel de Contas (2)

**painel_contas_lancamentos_manuais**: faturamento/resultado lançado à mão por conta/competência (TikTok, ajustes).
- DDL: sql/painel_contas_schema.sql:14. FKs cliente_id → clientes CASCADE; **cliente_conta_id → cliente_contas CASCADE**; created_by/updated_by SET NULL. UNIQUE (cliente_conta_id, competencia).
- W: painelContasRepository.js:358 (`salvarLancamentoManual`), :392 (DELETE). UI: Portal/painel-contas.html, frontend-react/src/pages/PainelContasPage.jsx, services/painelContasApi.js.
- Origem: **usuário**. Classe: canônica manual. Modo: upsert por clique. Ret.: manter. Risco: **ALTO**, e é apagado em cascata se a conta for removida. [código]

**painel_contas_lancamentos_manuais_historico**: histórico append-only dos lançamentos.
- DDL: :42. FK cliente_id CASCADE; user_id SET NULL; **cliente_conta_id sem FK** (sobrevive à conta, mas não ao cliente).
- W: painelContasRepository.js:379/401. R: o mesmo repo. Classe: auditoria. Ret.: nenhuma / manter. [código]

## 7. Cliente 360 (6)

**cliente_360_resumos_mensais**: snapshot mensal consolidado do cliente (Central + Ads).
- DDL: sql/cliente360_schema.sql:8. FK cliente_id CASCADE. UNIQUE (cliente_id, competencia). **Não tem cliente_conta_id.**
- W: cliente360Repository.js:248 (`upsertResumoMensal`), chamado por cliente360SyncService e centralVendasCliente360Adapter (sync noturno).
- R: dashboardService, painelContasRepository, sellerService, centralVendasSyncRunService. UI: Portal/cliente-360.js, dashboard.js, painel-contas.
- Classe: derivada (cache de agregação). Modo: upsert. Ret.: manter. Risco: médio (refaz-se a partir dos imports). [código]

**cliente_360_diagnosticos** / **cliente_360_diagnostico_itens**: diagnósticos gerados (cabeçalho e itens).
- DDL: :35/:51. FKs cliente_id CASCADE; gerado_por SET NULL; diagnostico_id CASCADE.
- W: cliente360Repository.js:287/315, chamado pelo cliente360DiagnosticoEngine. Itens: **sem SELECT no código**.
- Classe: histórico derivado. Modo: append. Ret.: nenhuma. Rec.: manter só os N últimos por cliente. [código]

**cliente_360_frete_historico**: histórico de frete por competência.
- DDL: :69. FK cliente_id CASCADE. R: cliente360Repository.js:348. **W: nenhum INSERT/UPDATE no código.**
- [inferido] A tabela é lida mas nunca preenchida pelo código atual: ou está vazia, ou foi preenchida por script fora do repo. Classe: histórico. [código]

**cliente_360_sync_jobs**: lock/registro de jobs de sync do C360.
- DDL: :91. FKs cliente_id CASCADE; iniciado_por SET NULL. W: cliente360Repository.js:376/394.
- Classe: controle/auditoria. Modo: append. Ret.: **nenhuma**. Rec.: 90 dias. [código]

**cliente_360_acoes**: ações do consultor para o Placar de Impacto.
- DDL: sql/cliente_360_acoes.sql:13, **aplicado manualmente**. Id: cliente_id (**sem FK**), cliente_slug (NOT NULL).
- W/R: cliente360AcoesRepository.js:57/80/90. Rota `/operacao/cliente-360` (cliente360ResultadoRoutes). UI: Portal/cliente-360.js. Origem: usuário.
- Classe: canônica manual. Risco: **ALTO** (irreconstruível). Não tem FK, então o purge precisa tratar a tabela explicitamente (está em clienteDependenciasService.js:48). [código]

## 8. Central de Margem / Motor de Margem / Margin Snapshot (4)

**margin_snapshot_runs**: execuções do worker de margin snapshot.
- DDL: sql/margin_snapshot_schema.sql:42. FKs cliente_id CASCADE; cliente_conta_id CASCADE; base_id SET NULL; requested_by SET NULL. Único "ativo" por conta/marketplace.
- W: motorMargem/marginSnapshotRunRepository.js:78-306. Frequência: worker opt-in `MARGIN_SNAPSHOT_WORKER_ENABLED` (marginSnapshotRuntime.js:5) e gatilhos pós-sync/base (marginSnapshotTriggers.js).
- Classe: auditoria/controle. Ret.: **nenhuma**. Rec.: 90 dias. [código]

**margin_projection_snapshots**: margem projetada por anúncio, a fonte canônica da Central de Margem.
- DDL: :105. FKs cliente_id e cliente_conta_id CASCADE; base_id SET NULL; run_id → runs SET NULL. UNIQUE (cliente_id, cliente_conta_id, marketplace, item_id).
- W: marginSnapshotRepository.js:113/194/217. R: anunciosMargemProjetadaFonte.js, precificacaoOportunidadesSql.js, marginSnapshotApiService. Rotas `/operacao/central-margem` e `/anuncios-meli`.
- UI: Portal/central-margem.js, central-margem-api.js, anuncios-meli.js.
- Classe: snapshot (estado atual). Modo: upsert. Ret.: não precisa (uma linha por item). Risco: baixo (recalculável). [código]

**anuncios_margem_projetada_snapshot**: pipeline B legado da margem projetada (uma linha por item, **sem conta**).
- DDL: migrations/20260925_anuncios_margem_projetada_snapshot.sql:55. FK cliente_id CASCADE; cliente_conta_id sem FK. UNIQUE (cliente_id, item_id).
- W: margemProjetadaSnapshotRepository.js:67, via o scheduler opt-in `MARGEM_PROJETADA_SCHEDULER_ENABLED` (margemProjetadaScheduler.js:60) e jobs/margemProjetadaGlobal.js. R: anunciosMargemProjetadaFonte.js (só como fallback).
- Classe: snapshot legado. **Duplica margin_projection_snapshots** (anunciosMargemProjetadaFonte.js:6-15). Rec.: aposentar. [código]

**margem_precificacao_aplicacoes**: preview → aplicação de preço no ML (fingerprint, lease, auditoria, refresh).
- DDL: migrations/20260930_margem_precificacao_aplicacoes.sql:31. **Sem FKs** (cliente_id e cliente_conta_id NOT NULL soltos). Idempotency UNIQUE; único "em voo" por item.
- W: precificacao/precificacaoRepository.js:125-412. Rota `/operacao/central-margem`. UI: central-margem.js. Origem: usuário + API ML.
- Classe: auditoria (registro de escrita no marketplace). Ret.: nenhuma / manter. Risco: **ALTO** (trilha de alteração de preço real). [código]

## 9. Promoções (7)

**promo_snapshot_runs / promo_snapshot_itens / promo_snapshot_run_lotes / promo_snapshot_contas**: snapshot de promoções ML por conta, feito pelo worker.
- DDL: migrations/20261001_promo_snapshot_account_sync.sql:27/110/168/187. **Sem FK para clientes/cliente_contas** (só itens/lotes → runs CASCADE). Id: cliente_id, cliente_slug, cliente_conta_id, seller_id (ml_user_id), run_id.
- W: promoSnapshot/promoSnapshotRepository.js (createRun:166, inserirLinhas:340, registrarLote:375, finalizarRun:586/622/663, podarHistoricoDaConta:789).
- Frequência: worker opt-in `PROMO_SNAPSHOT_WORKER_ENABLED`, orquestrador a cada 300 s (promoSnapshotConfig.js:160/225).
- R: o mesmo repo e precificacaoOportunidadesService. Rota `/operacao/central-margem` (promoSnapshotRoutes). UI: Portal/central-margem-api.js.
- Classe: runs = controle; itens/lotes = snapshot; contas = ponteiro do snapshot vigente (current/previous run).
- Ret.: poda por conta mantendo `PROMO_SNAPSHOT_RUNS_RETIDOS` (padrão 20) runs terminados (promoSnapshotConfig.js:221, promoSnapshotService.js:238). Rec.: 20 runs basta; reduzir para 5 se o volume pesar.
- Risco: baixo (vem da API). [código]

**promocoes_diagnosticos / promocoes_diagnostico_itens**: diagnóstico legado de promoções (fila de jobs).
- DDL: sql/promocoes_diagnostico_schema.sql:14/59. Sem FK de cliente; itens → diagnostico CASCADE. Id: cliente_id, cliente_slug, seller_id.
- W: automacoes/promocoesDiagnosticoService.js:100-366. R: o mesmo service, promoSnapshotLegado.js, precificacaoOportunidadesService. Rota via automacoesController. UI: Portal/promocoes-retorno.js, automacoes.js.
- Classe: histórico derivado. Ret.: **nenhuma**. [inferido] Fica redundante com promo_snapshot_* (há `promoSnapshotLegado.js` como ponte). Rec.: congelar e aposentar. [código]

**promocoes_rebate_jobs**: job de transferência/rebate de promoções.
- DDL: migrations/20261015_promocoes_rebate_jobs.sql:15. Sem FKs. Id: cliente_id, cliente_slug, cliente_conta_id, ml_user_id. Único ativo por cliente.
- W: meliAnuncios/meliPromocoesRebateService.js:502. Rota `/anuncios-meli`. UI: anuncios-meli.js.
- Classe: auditoria/controle. Ret.: nenhuma. Rec.: 180 dias. [código]

## 10. Anúncios (4)

**meli_anuncios**: catálogo local de anúncios ML (cache da API, mais campos confirmados pelo usuário).
- DDL: meliAnuncios/meliAnunciosService.js:40 (+ALTERs). **cliente_id NOT NULL sem FK**; cliente_conta_id e ml_user_id sem FK. UNIQUE (cliente_id, item_id).
- W: meliAnunciosService.js:534-680 (upsert vindo do meliSyncService), meliFamiliaService.js:720. R: 12 serviços (Margem, Promo, Financeiro, Seller). UI: Portal/anuncios-meli.js.
- Classe: cache. Modo: upsert. Ret.: não precisa. Risco: médio, porque tem campos "confirmados"/"revisado" manuais (marcarRevisado:665). [código]

**meli_user_products**: User Products / família do ML.
- DDL: meliFamiliaService.js:40. Sem FK. Id: cliente_id, cliente_conta_id, ml_user_id. W: meliFamiliaService.js:117/714. Classe: cache. [código]

**meli_anuncio_otimizacoes**: sugestões de otimização (IA) e aprovação.
- DDL: otimizadorMeliService.js:48 (+cliente_conta_id :103). Sem FK. W: :298/633. UI: anuncios-meli.js. Classe: histórico + aprovação manual. Risco: médio. [código]

**meli_anuncio_publicacoes**: anúncios criados pelo Portal.
- DDL: meliCriacaoService.js:36. Sem FK. W: :980/1017. UI: Portal/criar-anuncios-meli.js. Classe: auditoria. [código]

## 11. Sentinel (5)

Frequência: worker opt-in `SENTINEL_WORKER_ENABLED` (workers/sentinelWorker.js:31), que faz polling dos pedidos ML. DDL em sentinel/sentinelSchema.js. UI: Portal/sentinel.js e sentinel.html (`/sentinel`). [código]

- **sentinel_pedidos**: margem por pedido ao vivo. migrations/20261023_sentinel_pedidos.sql:16. FKs cliente_id e cliente_conta_id CASCADE. UNIQUE (cliente_conta_id, pedido_id). W: sentinelPedidoService.js:193 (upsert). Classe: derivada/cache. Ret.: **nenhuma**; rec.: 90 dias. [código]
- **sentinel_checkpoints**: cursor de polling por conta. :50. PK cliente_conta_id, **sem FK**. W: sentinelPollingWorker.js:99/216. Classe: controle. [código]
- **sentinel_pedido_excecoes**: exceções/resoluções por pedido. migrations/20261027_sentinel_v0a.sql:21. cliente_conta_id **sem FK**. W: sentinelExcecoes.js:27/50/58. Classe: canônica (resolução manual). Risco: médio. [código]
- **sentinel_incidentes**: incidentes agregados. migrations/20261028_sentinel_incidentes.sql:14. FK cliente_conta_id CASCADE. UNIQUE (conta, tipo, chave). W: sentinelIncidentes.js:398/499. Classe: canônica + estado. Ret.: nenhuma. [código]
- **sentinel_incidente_eventos**: trilha de cada incidente. :66. FK incidente_id CASCADE. W: sentinelIncidentes.js:347. Classe: auditoria (append-only). Ret.: nenhuma. [código]

## 12. Ads (3)

**ads_acompanhamentos**: checklist/feedback mensal de Ads.
- DDL: adsService.js:5. **Só cliente_slug** (sem cliente_id, sem FK). UNIQUE (cliente_slug, mes_ref, loja_campanha).
- W: adsService.js:69. UI: Portal/ads.js. Origem: usuário. Classe: canônica manual. Risco: **ALTO**. [código]

**ads_resumos_mensais**: resumo mensal de Ads (investimento/ACOS).
- DDL: adsService.js:96. **Só cliente_slug.** W: adsService.js:203 (`salvarResumoMensalAds`), chamado por controllers/adsController.js (upload) e centralVendasAdsSyncService (sync noturno).
- R: cliente360Repository, painelContasRepository. UI: ads.js, cliente-360.js. Classe: misto. [inferido] Planilha manual e sync gravam na mesma chave, então o último a gravar vence. Risco: médio. [código]

**financeiro_ads_cache**: cache de Ads por conta/mês para o fechamento.
- DDL: migrations/20261020_financeiro_ads_cache.sql:17. PK (cliente_conta_id, mes_ref), sem FK. Id: cliente_conta_id, cliente_slug.
- W/R: financeiroAdsService.js:105. Rota `/financeiro`. Classe: cache. Ret.: nenhuma; rec.: 13 meses.
- [inferido] Sobrepõe-se a ads_resumos_mensais (mesmo dado de Ads, em chaves diferentes: conta × slug). [código]

## 13. Relatórios / Automações (4)

**relatorios**: relatório de precificação/diagnóstico.
- DDL: index.js:685 (+pasta_id :851). FKs user_id, cliente_id e base_id SET NULL; pasta_id → relatorio_pastas SET NULL. Id: cliente_id, cliente_slug (NOT NULL).
- W: automacoes/relatoriosService.js:138/371/436, diagnosticoService.js:262-291, automacoesController.js:528. UI: Portal/relatorios.js, automacoes.js. Classe: histórico. Ret.: nenhuma (só exclusão manual). [código]

**relatorio_itens**: itens do relatório.
- DDL: index.js:708. FK relatorio_id CASCADE. W: relatoriosService.js:158, diagnosticoService.js:255. R: relatoriosService, cliente360Repository, sellerService, externalFirebaseRoutes. Classe: histórico. [código]

**relatorio_pastas**: pastas de organização. DDL: index.js:842. Sem cliente. W: relatoriosService.js:291-354. Classe: configuração. [código]

**diagnosticos_iniciais**: diagnóstico inicial de onboarding.
- DDL: sql/diagnostico_inicial_schema.sql:1. FKs cliente_id CASCADE; responsavel SET NULL. W: diagnosticoInicialRepository.js:90/123/135.
- UI: Portal/diagnostico-inicial.js. Origem: usuário. Classe: canônica manual. Risco: ALTO. [código]

## 14. Financeiro / fechamentos / entregas (3)

**entregas_cliente**: fechamentos e entregas publicadas (payload_json do fechamento, token_publico imutável).
- DDL: schema/schemaEnsure.js:62 (+cliente_conta_id e unicidade, migrations p26). FKs cliente_id SET NULL; cliente_conta_id SET NULL; created_by SET NULL.
- UNIQUE token_publico; UNIQUE (cliente_id, COALESCE(conta,0), periodo) só para fechamento (20260828_entregas_cliente_unicidade_p26).
- W: entregasClienteService.js:320-695. R: entregasClienteService, dashboardService, cliente360Repository, centralVendasCliente360Adapter (MC oficial).
- UI: Portal/financeiro.js, relatorio-publico.js, cliente-360.js; frontend-react/src/services/entregasApi.js.
- Classe: canônica (documento entregue ao cliente). Ret.: nenhuma / manter sempre. Risco: **ALTO** (link público e documento entregue). [código]

**fechamento_incidentes / fechamento_incidente_arquivos**: incidentes de fechamento com arquivos anexados.
- DDL: **duplicado** em repositories/fechamentoIncidenteRepository.js:9/33 e migrations/20260910_fechamento_incidentes.sql:14/56. FKs cliente_id/conta/usuario SET NULL; arquivos → incidente CASCADE.
- W: fechamentoIncidenteRepository.js:66/92/149. UI: `/fechamentos` (Portal/financeiro-debug.js) [inferido pelo prefixo].
- Classe: temporária/diagnóstico. Ret.: `expires_at` com `FECHAMENTO_INCIDENT_RETENTION_DAYS` (padrão 15) e job a cada 6 h (fechamentoIncidentStorageService.js:24/117). Já adequada. [código]

## 15. Shopee / TikTok (2)

**shopee_grants**: token OAuth Shopee (cifrado) por conta.
- DDL: migrations/20261029_shopee_grants.sql:20 (+refresh 20261106). FK cliente_conta_id → cliente_contas CASCADE (bloco DO, :55). UNIQUE (ambiente, app, shop_id) e (cliente_conta_id, ambiente, app).
- W: shopee/shopeeGrantService.js:131/341/381 e o worker shopeeRefreshWorker (index.js, etapa shopee-grants). UI: Portal/shopee-admin.js.
- Classe: canônica (credencial). Risco: ALTO. [código]

**tiktok_shop_callback_logs**: log bruto dos callbacks OAuth do TikTok (code, state, query_json, ip).
- DDL: controllers/tiktokShopController.js:5. W: :31. **Sem leitor e sem identificador de cliente.**
- Classe: auditoria/temporária. Ret.: **nenhuma**. Rec.: 30 dias. [inferido] Pode guardar `code` de autorização em claro. [código]

## 16. Auditoria, logs e observabilidade (5)

- **observability_requests**: uma linha por request HTTP. sql/observability_schema.sql:5. W: observabilityRepository.js:81. UI: Portal/control-center.js (`/admin/observability`). Ret.: `OBSERVABILITY_RETENTION_DAYS` = 7 e `OBSERVABILITY_MAX_ROWS` = 50000, com cleanup periódico (observabilityService.js:38-39/1006; observabilityRepository.js:508-548). Adequada. [código]
- **observability_client_events**: eventos do front (erros, latência). :40. Mesma retenção. [código]
- **activity_logs**: auditoria de negócio (tela Atividade). **Sem DDL no código.** W: activityLogService.js:15 (chamado por 9 controllers), clientesUnificacao/repository.js:886. R: logsController.js:60 → Portal/atividade.js. Ret.: **nenhuma**. Rec.: 24 meses, com particionamento por mês. Risco: médio. [código]
- **callbacks**: log de consumo de base via API key (extensão/externos). index.js:652. FK cliente_id SET NULL. W: `GET /api/bases/:baseSlug` (index.js:1001). R: `GET /callbacks` (index.js:1842) → Portal/callbacks.js. Ret.: **nenhuma**. Rec.: 90 dias. [código]
- **venforce_schema_versoes**: marcador de versão das migrations aplicadas no boot. schema/schemaVersionado.js:109. Classe: configuração. Risco de excluir: baixo (o boot reaplica, mais lento). [código]

## 17. Design Studio (5)

- **design_client_profiles** (PK cliente_id → clientes CASCADE), **design_templates**, **design_artworks** (cliente_id CASCADE; template_id SET NULL), **design_template_versions** e **design_artwork_versions** (→ pai CASCADE; UNIQUE (pai, version_number)). DDL: sql/design_studio_schema.sql:1-59.
- W/R: designStudio/designStudioRepository.js (tabela escolhida dinamicamente, :26/:29). UI: Portal/design-studio-api.js, design-templates.js (`/design/studio`).
- Origem: usuário. Classe: canônica + versões (histórico append-only). Ret.: nenhuma; rec.: manter as N últimas versões. Risco: ALTO (arte manual). [código]

## 18. Outros (1)

- **scans**: resumo de scans de conta ML (total de anúncios, MC médio). index.js:672. FK user_id CASCADE. **Sem cliente_id** (só `conta_ml` texto e `base_slug`). W: `POST /scans` (index.js:933), `DELETE /scans` (:970/:992). R: `GET /scans` (LIMIT 500). UI: [não verificado] (nenhuma chamada a `/scans` no Portal; [inferido] vem da extensão). Ret.: nenhuma. Rec.: 12 meses. [código]

---

## Contagem por domínio

| Domínio | Nº |
|---|---|
| Clientes e contas | 7 |
| Squads e permissões | 7 |
| Custos e bases | 4 |
| Central de Vendas | 6 |
| Mercado Pago | 4 |
| Painel de Contas | 2 |
| Cliente 360 | 6 |
| Margem (Central/Motor/Snapshot) | 4 |
| Promoções | 7 |
| Anúncios | 4 |
| Sentinel | 5 |
| Ads | 3 |
| Relatórios/Automações | 4 |
| Financeiro/fechamentos/entregas | 3 |
| Shopee/TikTok | 2 |
| Auditoria/logs/observabilidade | 5 |
| Design Studio | 5 |
| Outros | 1 |
| **Total** | **79** |

Tabelas que só existem em scripts e fakes de teste (não contadas): `logs` (scripts/sentinel-demo-seed.js:37). [código]
