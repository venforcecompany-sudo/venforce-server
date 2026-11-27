# 11 — Rollout por conta: reuso de pedidos → componentes compactos

Decisão do responsável (26/11): **reuso primeiro** na conta piloto; só
depois os **componentes compactos**, na mesma conta. Nada aqui foi
executado em produção. Cada passo marcado **[A]** exige autorização
explícita. Todos os passos de validação são somente leitura.

## 0. Estado atual

| item | estado | fonte | confirmar com |
|---|---|---|---|
| migration 20261111 (vínculos do reuso) | **aplicada** em produção em 14/11 | registro da sessão de 14/11 | `central_vendas_rollout_estado.raiox_ro.sql` E1 |
| reuso (`CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS` / `_CONTAS`) | **desligado** em 14/11; 0 vínculos | idem | E2 (vínculos > 0 = alguém ligou) |
| persistência enxuta | ligada no Sync em 14/11 (payload ≈ 250 B/pedido = manifesto) | idem | E5 `bytes_payload_por_pedido` |
| migration 20261126 (compactos) | **não aplicada** (só existe nesta branch) | código | E1 |
| código desta branch | **não publicado** (sem push) | git | — |
| conta candidata a piloto | conta 21 (volume médio, 1 conta MELI, 0 falhas; linha de base de 14/11) | `~/venforce-backups/piloto_reuso` | E6–E8 |

**Não houve conexão ao banco nesta sessão.** O estado acima é o registrado
em 14/11 e precisa ser reconfirmado (passo R0) antes de qualquer ativação.

## 1. Pré-requisitos e decisões em aberto

1. **Trava S3 da retenção é GLOBAL** (`verificarReusoSemGuarda`). Um único
   vínculo de reuso, em qualquer conta, faz a retenção recusar o apply em
   **todas** as contas, inclusive a onda 3 (a que devolve os GB). Decida a ordem:
   - (a) rodar a onda 3 **antes** de ligar o reuso; ou
   - (b) ligar o reuso e adiar a retenção até S1+S2+S4 (doc 09).
2. **Publicar esta branch com flags desligadas** antes de ligar o compacto:
   - os leitores precisam entender o formato antes da 1ª gravação;
   - o código já trata o reuso e corrige o Resgate (que hoje **perde** os
     pedidos vinculados).

   Ligar o reuso com a `main` atual deixaria o Resgate incompleto na conta
   piloto. Portanto: **publicar esta branch antes do passo R2.**
3. **Concessão de leitura** para a paridade de valores:
   `componentes-v2/raiox_ro_paridade_central.sql` (admin, revogável). Sem
   ela, valem só as checagens de estado e completude da `raiox_ro` atual.
4. **Unificação Clientes×Contas** já fica bloqueada em produção com a tabela
   de vínculos (`CENTRAL_POLICY_DRIFT` em `central_vendas_import_pedidos`,
   PK composta). Isso é **pré-existente** e reproduzido nesta sessão. A tabela
   compacta foi desenhada para **não** agravar o problema (PK `id`).

## 2. Ferramentas (somente leitura)

| ferramenta | roda como | o que prova |
|---|---|---|
| `server/sql/observabilidade/central_vendas_rollout_estado.raiox_ro.sql` | `raiox_ro` **atual** | migrations, vínculos, formatos, tamanho, **completude por import** (pedidos lidos = pedidos do motor, sem repetição), saúde do sync |
| `server/scripts/central-vendas-componentes-paridade.js` | `raiox_ro` + concessão | **antes** do compacto: codifica e decodifica em memória os componentes atuais da conta; campo a campo + contrato (`buildPedidoContrato`) |
| `server/scripts/central-vendas-validar-conta.js` | `raiox_ro` + concessão | **depois** de cada ativação, por import publicado: C1 pedidos; C2 Σ por tipo relida = `totaisPorTipo` do motor; C3 ledger por item; C4 integridade compacta; C5 Resgate × Central |
| `server/sql/observabilidade/central_vendas_componentes_v2_medicao.sql` | `raiox_ro` + concessão | bytes por coluna, derivabilidade, textos de obs, cópias por pedido |

Todas imprimem o host, verificam `default_transaction_read_only = on` e não
leem `server/.env`.

## 3. Fase R — reuso de pedidos na conta piloto

| passo | ação | GO | NO-GO / ação |
|---|---|---|---|
| R0 | `rollout_estado` com a conta piloto | E1 vínculos presente; E2 = 0; E6 `OK` em todos os imports; E7 0 falhas e 0 presos em 7 dias | qualquer divergência: parar e investigar |
| R1 | linha de base: `validar-conta --conta=<p> --dias=14 --saida=base.json` (com concessão; guarda `temposMs`) + print das telas (Central, Painel, Cliente 360, Margem) do mês corrente | `veredito: GO` | — |
| R2 **[A]** | env: `CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS=true`, `CENTRAL_VENDAS_SYNC_REUSO_CONTAS=<p>` (com o código desta branch já publicado) | — | — |
| R3 | manhã seguinte: `rollout_estado` + `validar-conta` | E2 vínculos > 0 só na conta piloto; E6 `OK` (lidos = motor, repetidos = 0); C1–C5 sem problema; `metadata_json…persistencia.gravados.pedidos = diff.novos + diff.alterados`; telas iguais à linha de base (mesmos totais do mês) | rollback R |
| R4 | 7 noites seguidas iguais a R3 + duração mediana do sync ≤ 1,2× a da linha de base | 7/7 | rollback R |

**Rollback R** (flag): tirar a conta de `_REUSO_CONTAS`.
- **Não** voltar o código.
- **Não** apagar vínculos.
- **Não** rodar retenção (trava S3).
- Os imports vinculados continuam legíveis pelos leitores novos.

## 4. Fase C — componentes compactos na mesma conta

| passo | ação | GO | NO-GO / ação |
|---|---|---|---|
| C0 | `componentes-paridade --conta=<p>` sobre o mês corrente e o anterior (formato atual) | `PARIDADE_OK`, `naoElegiveis` vazio | divergência: não aplicar |
| C1 **[A]** | migration `20261126_central_vendas_pedido_componentes.sql` (2 tabelas vazias) | E1 mostra as tabelas; latência das telas sem regressão por 1 dia (todo leitor passa a consultar a tabela vazia, custo de 1 busca por PK) | `DROP` das 2 tabelas **enquanto vazias** + reinício do serviço (o cache de existência é por processo) |
| C2 **[A]** | env: `CENTRAL_VENDAS_COMPONENTES_COMPACTOS=true`, `…_COMPACTOS_CONTAS=<p>` | — | — |
| C3 | manhã seguinte: `validar-conta` | C2 (Σ por tipo = motor) e C4 sem problema; `persistencia.componentes.formato = compacto_v1`; `componentesCompactos > 0` só nos imports novos; telas iguais à véspera; **latência**: `temposMs` do validador (carga da Central, realizado da Margem, Resgate da conta, leitores reais) ≤ 1,25× a linha de base medida da mesma forma em R1; as leituras filtradas por tipo custam +30–64% no benchmark (≈ +10 ms numa conta de 500 pedidos/mês). `observability_requests` serve só de sinal global, porque não registra a conta | rollback C |
| C4 | 7 noites seguidas iguais a C3; crescimento diário de `central_vendas_componentes` da conta ≈ 0 e `central_vendas_pedido_componentes` ≈ pedidos novos/alterados | 7/7 | rollback C |
| C5 | expandir por lotes (5 → 20 → `*`), repetindo C3 em 1 conta por lote, a maior primeiro | por lote | rollback C do lote |

**Rollback C** (flag): tirar a conta de `…_COMPACTOS_CONTAS` (ou desligar a flag).
- Os próximos imports voltam a gravar em linhas.
- Os já gravados em compacto **continuam lidos**.
- **Nunca** dropar as tabelas depois da 1ª gravação compacta.
- **Nunca** publicar um código anterior a esta branch: ele não leria os
  compactos e os pedidos apareceriam sem composição.

Sinal de alerta em qualquer fase:
- um erro `COMPONENTES_COMPACTOS_CORROMPIDOS` ou `…_INSERT_PARCIAL` nos logs;
- `COMPONENTE_*` em `persistencia.componentes.motivo` (import que caiu para
  linhas: não é erro, mas mostra um caso que o formato não cobre).

## 5. Fora deste rollout

- Migrar o histórico em linhas para o compacto (F6 do doc 10): só depois de
  C5 e com autorização.
- Retenção com vínculos (S1+S2+S4).
- Unificação com a tabela de vínculos (drift pré-existente).
