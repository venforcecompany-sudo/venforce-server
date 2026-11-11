# Entrega 1 — Coleta automática de Mercado Pago Payments

Commit `af8523cd` (branch `feat/pg-reorganizacao`, sem push).

## O que foi verificado no código

| Pergunta | Resposta | Evidência |
|---|---|---|
| Quem faz o GET | `coletarPaymentsMp` → `GET api.mercadopago.com/v1/payments/{id}` para cada `order.payments[].id` dos pedidos do run | `centralVendasSyncService.js` (bloco frete/pós-venda/pagamentos), `centralVendasMpPaymentsService.js` |
| Quem grava | `persistMpPayments` → `central_vendas_mp_payments` + `central_vendas_mp_payment_charges`, chave `(sync_run_id, payment_id)` ⇒ **uma cópia por run** | `centralVendasMpPaymentsRepository.js` |
| Quem lê | Só a **Conciliação MP**: `GET /central-vendas/:slug/read/mercado-pago/reconciliation` e o bloco `conciliacao` de `financeiroVisaoService` (aba Conciliação do Financeiro V3, `frontend-react/.../ConciliacaoTab.jsx`); `GET /sync-runs/:id/mercado-pago/reconciliation` | `centralVendasMp3ReadService.js`, `financeiroVisaoService.js:248`, `centralVendasController.js` |
| Entra em pedidos/margem/fechamento? | **Não.** `payments` está fora de `REQUIRED_SOURCES_BASE`; reembolso dos pedidos vem de `order.payments[]` da Orders API; Motor de Margem usa `mercadoPagoDisponivel()=false`; fechamento via API (`fechamentoViaApiService`) não lê MP | `centralVendasSyncSourceService.js:38`, `extrairReembolso` no sync |
| MP1/MP2/MP3 necessários para a operação atual? | MP1 (coleta) só alimenta MP3 (conciliação auxiliar). MP2 (Settlement) já é opt-in (`CENTRAL_VENDAS_MP_SETTLEMENT_AUTOSTART`, desligado). Nenhum fluxo operacional (Painel, Central, Margem, Sentinel, fechamento) depende deles | idem |
| O que se perde desligando | Runs feitos com a coleta desligada não terão Payments: a aba Conciliação passa a mostrar **"coleta desligada"** (`mpReconciliationStatus = "collection_disabled"`) para esses meses. Meses já coletados continuam conciliáveis | `centralVendasMp3ReadService.js` |

## O que mudou

- Flag `CENTRAL_VENDAS_MP_PAYMENTS_COLETA_ENABLED` (`centralVendasMpColetaFlag.js`).
  **Ausente = ligada** (deploy não muda nada). `false`/`0`/`off` desliga.
- Desligada: zero chamadas ao MP, zero linhas novas em `mp_payments`/`charges`;
  a fonte `payments` do run fica `not_applicable` com
  `metadata_json.motivo = "MP_PAYMENTS_COLETA_DESLIGADA"` (evidência por run).
- Conciliação: sem Payments + run marcado ⇒ `collection_disabled` (+ bloco
  `coletaPayments`), nunca `pending` e nunca zero. Front atual mostra
  "Indisponível" (fallback de status desconhecido do `ConciliacaoTab`); um rótulo
  próprio exige rebuild do bundle React — fora do escopo.
- Nada é apagado; fórmulas intactas; Settlement inalterado.

## Testes

- `centralVendasMp1PaymentsIntegration.test.js` cenário F: flag ausente/true/false
  sobre os mesmos orders — desligada não chama MP nem grava, fonte
  `not_applicable` com motivo, completude global e demais fontes iguais,
  **pedidos/itens/componentes idênticos** (deepStrictEqual).
- `centralVendasMp3ReadService.test.js` cenário 9: `collection_disabled` × `pending`.
- SQL novo validado em PG 18 local. Suíte completa: mesmas 4 falhas preexistentes da main.

## Rollout e reversão

1. Merge (no-op: flag ausente).
2. Decisão da equipe → `CENTRAL_VENDAS_MP_PAYMENTS_COLETA_ENABLED=false` no Render + restart.
3. Reverter = remover a env + restart. Histórico nunca foi tocado.
4. Limpeza das cópias antigas de `mp_payments` é da frente de retenção (lote próprio).
