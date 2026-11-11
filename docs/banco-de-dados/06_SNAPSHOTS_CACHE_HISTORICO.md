# Snapshots, cache e históricos — o que pode ser sobrescrito, expirar ou nunca mudar

Nenhuma limpeza foi executada. Detalhe por tabela em `inventario/CLASSIFICACAO_E_RETENCAO.md`.

| Classe | Tabelas | Duplicação | Política | Reconstruível? |
|---|---|---|---|---|
| **A. Pedidos/financeiro canônico (Central de Vendas)** | `central_vendas_imports`, `_pedidos`, `_pedido_itens`, `_componentes` | **Legítima:** 1 import vigente por conta×competência + manuais. **Desnecessária:** cópias superadas de cada noite (até ~15×/mês) e, por import, os JSONs repetidos (Entrega 2) | Vigente e manuais: imutáveis. Superados automáticos: retenção (com carência e trava de origem). Candidates de run falho: retenção | Automáticos: sim, pela API ML, **enquanto a API devolver o período** (claims/devoluções antigas podem não voltar iguais). Planilhas: **não** |
| **B. Margem projetada** | `margin_projection_snapshots` (canônica, por conta), `anuncios_margem_projetada_snapshot` (legado, fallback), `margin_snapshot_runs` | Legado × canônica guardam o mesmo conceito (achado 5 do inventário) | Sobrescrever (é foto do "agora"); runs: expirar | Sim (recalcula do anúncio/custo) |
| **C. Margem realizada** | não tem tabela própria: derivada em leitura de A (`loadRealizadoByImportIds`) | — | — | Sim, de A |
| **D. Sentinel** | `sentinel_pedidos`, `_incidentes(+eventos)`, `_checkpoints`, `_pedido_excecoes` | Incremental por pedido (sem cópia por run) | Pedidos/incidentes: histórico, definir horizonte (ex.: 13 meses). Checkpoints: sobrescrever. Exceções: manuais, nunca apagar por rotina | Parcial (polling só alcança janela recente) |
| **E. Snapshot mensal Cliente 360/Painel** | `cliente_360_resumos_mensais`, `cliente_360_sync_jobs` | Resumo: 1 por cliente×competência (upsert). Jobs: acumulam | Resumo: sobrescrever (vale só com os imports vigentes ao vivo). Jobs: auditoria — expirar após N meses (decisão) | Resumo: sim, de A. Jobs: não (auditoria) |
| **F. Mercado Pago** | `central_vendas_mp_payments(+charges)`, `_mp_settlement_reports(+movements)` | **Desnecessária:** chave `(sync_run_id, payment_id)` ⇒ 1 cópia por run (Raio-X mostra `copiasPorPayment`) | Coleta: flag (Entrega 1). Cópias de runs superados: retenção. Settlement: sem retenção hoje (achado 8) | Sim, pela API MP |
| **G. Histórico financeiro e dados manuais** | `entregas_cliente` (fechamentos publicados, links públicos), `painel_contas_lancamentos_manuais(+historico)`, planilhas legacy da Central, `base_cliente_vinculos`/custos, `ads_acompanhamentos`, `cliente_360_acoes`, exceções do Sentinel | Revisões de fechamento são imutáveis por desenho | **Nunca apagar por rotina.** Lançamento manual cascateia ao excluir a conta (achado 2) | **Não** |

## Caches que devem expirar

- `meli_anuncios`, `promo_snapshot_*` (já mantém 20 runs por conta), `financeiro_ads_cache`, `cliente_360_diagnosticos`, `promocoes_diagnosticos`.
- Observabilidade (`observability_*`): já expira (7 d / 50 mil linhas).

## O que NÃO pode ser reconstruído com segurança

Planilhas manuais da Central, `entregas_cliente`, lançamentos manuais do Painel e
histórico, custos/bases, ações e exceções digitadas, `margem_precificacao_aplicacoes`
(registro do que foi aplicado no ML), `central_vendas_sync_runs` (auditoria).
