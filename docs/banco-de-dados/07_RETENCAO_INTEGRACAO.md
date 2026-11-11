# Retenção — como se encaixa (sem novo sistema)

A frente de retenção tem dono próprio. Esta missão **não** alterou
`~/venforce-dev/wt-retencao-manuais`, não refez dry-run e não executou limpeza.

## Estado lido

- Ondas 1 e 2 feitas (30/10). Dry-run de 09/11: 1.623 imports, **242 propostos**,
  26 contas, ~190 MB reutilizáveis internamente.
- Lote piloto pronto, **não executado**: conta 30 [1117], 92 [3648], 58 [3880, 3967, 4001]
  (`~/venforce-backups/retencao-p0/onda3/lote1_20261109_contas_30_92_58/`).
- **Na main, o planner ainda tem `incluirLegacy: true` e `incluirMpPayments: true`**
  (`centralVendasRetencaoPlanner.js:42`) — apagaria planilhas manuais legacy.
  A trava de origem existe só na worktree de retenção (sem commit). Não ligar
  `CENTRAL_VENDAS_RETENCAO_AUTO` antes dessa correção chegar à main.

## Impacto no mapa de dados

| Remove | Mantém | Dependências que a retenção já respeita |
|---|---|---|
| imports automáticos superados (+ pedidos/itens/componentes por CASCADE); `mp_payments` desses runs (charges por CASCADE) | vigente por conta×competência; manuais; candidates em carência | seleção canônica (dominância), refs JSON em `entregas_cliente`/Cliente 360, carência ≥ 24 h, NOWAIT por tupla |

## Reuso de pedidos × retenção (novo)

Com o reuso ligado, linhas de um import superado podem estar em uso pelo vigente
(vínculo em `central_vendas_import_pedidos`). A FK impede apagá-lo (23503 — o
lote falha sem remover nada). O planner precisa da guarda descrita em
`PENDENCIAS_E_ROLLOUT.md` (bloqueio 2) e, no futuro, de um GC próprio: apagar os
vínculos do superado e as versões dele que ninguém referencia.

## Interação com as Entregas 1 e 2

- Entrega 1 reduz o que a retenção precisa apagar de MP daqui para frente.
- Entrega 2 reduz o tamanho de cada cópia (~34% nas 4 tabelas) — não reduz o
  **número** de cópias; isso continua papel da retenção (e da etapa 2/mosaico).
- O manifesto e `metadata_json.persistencia` não mudam nenhuma regra da retenção.

## Políticas futuras por classe

Ver `06_SNAPSHOTS_CACHE_HISTORICO.md`. Ordem sugerida: (1) correção de origem na
main; (2) lote piloto; (3) lotes restantes; (4) `RETENCAO_AUTO` com política fixa;
(5) `VACUUM` normal/autovacuum (nunca `VACUUM FULL` sem janela e autorização).
