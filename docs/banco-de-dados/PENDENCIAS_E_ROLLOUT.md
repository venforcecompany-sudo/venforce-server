# Pendências que exigem decisão + rollout por mudança

## Decisões (curtas)

1. **Desligar a coleta MP?** Ligar `CENTRAL_VENDAS_MP_PAYMENTS_COLETA_ENABLED=false`.
   Efeito: aba Conciliação dos meses novos mostra "coleta desligada". Nada mais muda.
2. **Ligar a persistência enxuta?** `CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA=true`.
   Recomendado após merge + 2–3 noites de conferência em 1–2 contas.
3. **Etapa 2 (mosaico) entra no roadmap?** Mudança de modelo de leitura; decidir
   depois de medir a taxa real de pedidos alterados em produção.
4. **Retenção:** levar a trava de origem (worktree de retenção) para a main antes
   de qualquer `RETENCAO_AUTO` — a main ainda apaga planilhas legacy (planner `incluirLegacy: true`).
5. **Excluir conta apaga lançamentos manuais do Painel** (`ON DELETE CASCADE`). Manter ou trocar para RESTRICT?
6. **Horizontes de histórico** para tabelas que só crescem: `central_vendas_sync_runs/sources`,
   `cliente_360_sync_jobs`, `margin_snapshot_runs`, `sentinel_pedidos`, `callbacks`,
   `tiktok_shop_callback_logs`, `activity_logs`, `scans`.
7. **Legado de margem projetada** (`anuncios_margem_projetada_snapshot`): desligar o scheduler próprio quando o fallback não for mais necessário?
8. Rodar `raio-x-cliente.js` e `pg-relatorio-armazenamento.js` **contra produção** (leitura) — precisa de autorização.

## Achados registrados (sem ação nesta missão)

- `activity_logs` não tem DDL no código de produção; algumas tabelas só nascem por migration manual (`cliente_360_acoes`, `cliente_unificacoes*`).
- `cliente_360_frete_historico` é lida e nunca gravada.
- Settlement MP sem retenção; nenhum código apaga `central_vendas_sync_runs`.
- Ads chaveado só por `cliente_slug` (sem FK); várias tabelas novas sem FK para cliente/conta; tipos INTEGER × BIGINT para `cliente_conta_id`.
- `central_vendas_imports` sem índice em `cliente_id` (tabela pequena; ok hoje).
- `resolveImportsForRange` seleciona `payload_json` de **todos** os imports da competência (incluindo superados) a cada leitura — custo de leitura proporcional ao acúmulo; com a Entrega 2 o payload novo fica pequeno, mas a coluna poderia sair do SELECT (ninguém a usa).

## Rollout e reversão por mudança

| Mudança | Merge | Ligar | Verificar | Reverter |
|---|---|---|---|---|
| E1 flag MP | no-op | env `=false` + restart | run seguinte: fonte `payments` = `not_applicable`; zero linhas novas em `mp_payments` | remover env |
| E2 persistência enxuta | no-op (só medição nova no metadata) | env `=true` + restart | relatório `syncs_escrita_24h`; Painel/Central/Margem/Fechamento-API em 1–2 contas | remover env; imports enxutos continuam legíveis |
| E3 inventário | só docs | — | — | — |
| E4 Raio-X | código sem rota | — | rodar CLI (autorizado) | remover arquivos |
| E5 métricas | código sem rota/agenda | rodar diário | comparar relatórios | — |

Nada foi enviado ao remoto, mesclado, publicado ou executado em produção.
