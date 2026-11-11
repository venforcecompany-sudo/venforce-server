# Mercado Pago — o acumulado (análise e plano de retenção próprio)

A flag que interrompe a coleta já existe (Entrega 1). Este documento trata do
**que já está gravado**. Nada foi apagado.

## Valor operacional real (código)

| Dado | Consumidor efetivo | Valor |
|---|---|---|
| Payments + charges dos **runs dos imports vigentes** | Conciliação MP (aba do Financeiro V3; `read/mercado-pago/reconciliation`) — `deriveSyncRunIds` usa só os runs do snapshot escolhido | auxiliar (conciliação, não entra em pedido/margem/fechamento) |
| Payments + charges de **runs superados** | **nenhum** | zero |
| Settlement reports/movements (MP2) | Conciliação MP | auxiliar; volume pequeno |
| Reembolso dos pedidos | vem de `order.payments[]` da **Orders API**, não destas tabelas | — |

## Únicos × cópias por run (produção, diagnóstico de 05/11 — estimativas do PG)

- `mp_payments`: 1.122.694 linhas · ~79.935 `payment_id` distintos (pg_stats) ⇒ **~14 cópias por payment** (chave `(sync_run_id, payment_id)`).
- `mp_payment_charges`: 4.618.153 linhas (~4,1 por payment-run).
- Tamanho: payments 476 MB + charges 1.240 MB = **1.716 MB**.
- Redundância estimada: 1.716 × (1 − 1/14) ≈ **1,59 GB (~93%)**; uma cópia de cada payment ≈ 0,12 GB.
- Índices sem uso desde o último reset (diag): `idx_central_vendas_mp_payment_charges_run` 35 MB,
  `idx_central_vendas_mp_payments_order` 19 MB, `idx_central_vendas_mp_payments_payment` 17 MB.

> `n_distinct` vem de amostra do ANALYZE e costuma **subestimar** colunas de alta
> cardinalidade (o fator real pode ser menor que 14). O número exato sai de
> `server/sql/observabilidade/mp_redundancia.sql` (read-only; validada em PG 18
> local), que também separa as linhas **com** e **sem** consumidor.

## Plano de retenção do MP (independente da retenção dos imports)

0. **Parar o crescimento:** `CENTRAL_VENDAS_MP_PAYMENTS_COLETA_ENABLED=false` (decisão da equipe).
1. **Medir exato (leitura, autorizar):** rodar `mp_redundancia.sql` em produção fora do pico.
2. **Conjunto a manter** (conservador): runs de imports published mais recentes de cada tupla
   + runs de imports dos últimos 7 dias + runs com Settlement Report + runs dos últimos 7 dias.
3. **Nunca apagar a última cópia:** um payment que só existe em run sem consumidor
   (`mp_payments_sem_nenhuma_copia_mantida`) é preservado.
4. **Apagar por run, em lotes pequenos** (ex.: 20 runs por transação, `lock_timeout` curto,
   export CSV antes): `DELETE FROM central_vendas_mp_payments WHERE sync_run_id = ANY($lote)`
   (charges saem por CASCADE). É o que a frente de retenção já sabe executar (`aplicarRunMp`),
   só que com o **critério de consumidor acima**, sem depender de o import ser apagado.
5. Depois: `VACUUM` normal (não FULL) e, com autorização, `DROP INDEX CONCURRENTLY` dos 3 índices sem uso (~71 MB).
6. **Se a coleta voltar a ser autorizada:** mudar a chave para o payment
   (`payment_id` único por conta, com `ultimo_sync_run_id`) — 1 linha por payment, atualizada quando
   `date_last_updated` mudar. Migração de modelo; só faz sentido se a conciliação virar operacional.

Ganho esperado de 2–5: ≈ 1,5 GB (estimativa; confirmar no passo 1).
