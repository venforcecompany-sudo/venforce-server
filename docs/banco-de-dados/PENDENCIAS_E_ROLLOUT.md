# Bloqueios reais para publicação + rollout

## Bloqueios reais

1. **Migration do reuso** (`server/sql/migrations/20261111_central_vendas_import_pedidos.sql`)
   precisa ser aplicada manualmente, com autorização, **antes** de ligar o reuso.
   Aditiva (1 tabela + 1 índice), não entra no boot.
2. **Retenção × reuso — PROIBIDA** para contas com imports vinculados (manual e automática).
   A FK impede perda de dados, mas **não** torna a retenção segura: o lote aborta (23503), o
   run inteiro para (inclusive outras contas) e a exportação não leva os vínculos
   (restauração incompleta). Nenhum caminho (CLI `--apply`, modo auto) consulta os vínculos.
   Evidência e especificação exata (S1–S4) para o agente da retenção:
   [`09_RETENCAO_X_REUSO_ESPECIFICACAO.md`](09_RETENCAO_X_REUSO_ESPECIFICACAO.md).
   **Etapa 1 (S3) implementada nesta branch**: `apply` (CLI e auto) recusa enquanto existir vínculo — piloto
   sem limpeza liberado. Retenção em contas com reuso continua dependendo de S1+S2+S4 (outra frente).
   Conferência read-only: `server/sql/observabilidade/reuso_vinculos.sql`.
3. **Retenção na main ainda apaga planilhas legacy** (`incluirLegacy: true`): a trava
   de origem está só na worktree de retenção. Bloqueia ligar retenção automática, não estas entregas.

Não são bloqueios (decisão/ajuste posterior): desligar a coleta MP; GC dos imports
superados em modo reuso (apagar vínculos do superado + versões não referenciadas —
crescimento pequeno, definir antes de ~meses de uso); retenção própria do MP
(`08_MERCADO_PAGO_ACUMULADO.md`); autorizar leituras em produção
(`mp_redundancia.sql`, relatório de armazenamento, Raio-X).

## Rollout e reversão por mudança

| Mudança | Ligar | Por conta? | Verificar | Reverter |
|---|---|---|---|---|
| Flag MP (E1) | `CENTRAL_VENDAS_MP_PAYMENTS_COLETA_ENABLED=false` | não (global) | fonte `payments` = `not_applicable`; zero linhas novas | remover env |
| Persistência enxuta (E2) | `CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA=true` | não (sem efeito em leitura) | `syncs_escrita_24h` | remover env |
| Reuso de pedidos | migration → restart → `CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS=true` + `CENTRAL_VENDAS_SYNC_REUSO_CONTAS=41,87` | **sim** | Painel/Central/Margem/Cliente 360/Fechamento via API das contas; inalterados × alterados no relatório | tirar a conta da lista; imports com vínculo seguem legíveis |
| Retenção MP | plano `08_` | por run | `mp_redundancia.sql` antes/depois | restaurar do export |
| Raio-X / métricas | rodar CLIs (leitura) | — | — | — |

## Achados registrados (sem ação)

`activity_logs` sem DDL no código; tabelas que só nascem por migration manual;
`cliente_360_frete_historico` lida e nunca gravada; Settlement sem retenção;
Ads só por `cliente_slug`; FKs ausentes nas tabelas novas; excluir conta apaga
lançamentos manuais do Painel (CASCADE); `resolveImportsForRange` seleciona
`payload_json` de todos os imports da competência a cada leitura.

Nada foi enviado ao remoto, mesclado, publicado ou executado em produção.
