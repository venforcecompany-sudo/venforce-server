# Sentinel S1 — Conciliação da comissão por pedido (handoff)

Worktree `/home/user/Documentos/wt-sentinel-conciliador` · branch `feat/sentinel-conciliador-comissao-20261117` · base `origin/main` **f2f3eb49** (PR #416).
**Commits só locais (sem push/PR).** Nada aplicado em produção: nenhuma migration, flag, deploy ou chamada real ao ML nesta etapa.

## 1. O que existe (e o que NÃO existe)
- Conciliador **puro** da comissão (S1-B1) + coletor **assíncrono** de Billing + persistência compacta + leitura no backend (3 GETs).
- Tudo **desligado por padrão**: o processo do coletor sai sem abrir conexão sem `SENTINEL_CONCILIACAO_ENABLED=true` **e** uma allowlist própria.
- **Não** altera margem, lucro, comissão, severidade, incidentes, checkpoints nem dispara aviso. `efeito_na_margem`/`efeitoNaMargem` = `"nenhum"` sempre.
- **Não** existe: UI (a tela não mostra a conciliação), notificação financeira, uso do resultado por outro módulo.

## 2. Evidência que sustenta o desenho (S1-A, 17/11/2026, conta 41, 6 pedidos reais, 13 GET 200)
| Fato provado | n |
|---|---|
| `order_items[].sale_fee` = `billing.sale_fee.net` = Σ cobranças `CVVML+CVVPRC(+CVVFNU)` | 6/6 |
| `gross − net = rebate` | 6/6 |
| rebate do Billing = parte do ML (`total − seller`) em `/orders/{id}/discounts` com `funding_mode: sale_fee` | 3/3 |
| `sentinel_pedidos.comissao` (comissão OFICIAL do motor) = `sale_fee` do pedido | 6/6 |
| vínculo `order_id` / `item_id` / `payment_id` Billing ↔ pedido | 6/6 |

⇒ A comissão do motor **já é líquida do rebate**; somar o rebate seria dupla contagem. **Só** vale para 1 item, quantidade 1, pago, `funding_mode` `sale_fee`/`seller`, sem cupom/cashback. Documentos estavam `PROCESSING` (cobrança observada ≠ faturamento definitivo).

## 3. Arquitetura e fluxo
```
sentinel_pedidos (gravado pelo polling; só LIDO aqui)
   │  SELECIONAR_SQL: 1 item, qtd 1, paid, comissao, estado estável, janela 30 d, maturidade 6 h,
   │                  (nunca conciliado | hash do pedido mudou | reconsulta/falha vencida)
   ▼
workers/sentinelConciliacaoWorker.js ──► executarColeta (lock advisory "vf:sentinel:conciliacao", conexão dedicada)
   │   pausa 429 ativa? ⇒ sai sem chamadas
   │   por conta (allowlist): grant da conta (resolverContaPadrao) + mlFetch noRefresh + orçamento da conta
   │     lote ≤ 60 ids (UMA conta/seller) ─► GET /billing/integration/group/ML/order/details?order_ids=…
   │     por pedido com registro e sem descontos em cache ─► GET /orders/{id}/discounts (compactado e reaproveitado)
   │     conciliarComissaoPedido(pedido mínimo da linha, descontos, registro do Billing, conta) — PURO
   │     política de reconsulta ─► upsert monotônico em sentinel_conciliacao_comissao
   ▼
GET /sentinel/conciliacao/resumo · /sentinel/conciliacao?estado= · /sentinel/conciliacao/pedidos/:id?conta=
   (carteira do usuário; só leitura; interpretação fixa por estado)
```
- O polling **não** é tocado (nem o checkpoint). O lock é outro: um não bloqueia o outro (testado).
- O "pedido" conciliado é a **linha do Sentinel**: `sale_fee` = comissão oficial. Nenhum `GET /orders/{id}` extra.

## 4. Estados (contrato v1, `ESTADOS_CONCILIACAO`)
| Estado | Significado | Pode virar aviso? |
|---|---|---|
| `TARIFA_LIQUIDA_COMPROVADA` | comissão = net = Σ cobranças; identidade fecha; rebate `comprovado` (incorporado) ou `nao_aplicavel` | não precisa |
| `TARIFA_BRUTA_COMPROVADA` | comissão = gross com rebate > 0 não incorporado | **investigar** (não credita) |
| `DIVERGENTE` | números não fecham (escopo validado) | **investigar — NÃO é prejuízo confirmado** |
| `NAO_CONCILIADO` | dado ausente, vínculo ruim, coleta pendente ou cenário não validado | **nunca** |

Precedência: bloqueio → escopo não validado (ambos `NAO_CONCILIADO`) → divergência → líquida/bruta. Motivos em `motivos[]` com categoria
(`bloqueio`, `escopo`, `divergencia`, `aviso`, `coleta`). Documento: `documento` + `documento_definitivo` (só `true` com TODAS as cobranças de tarifa `PROCESSED`); **liquidação nunca é afirmada**.

## 5. Arquivos (vs. f2f3eb49)
| Arquivo | O quê |
|---|---|
| `server/services/sentinel/sentinelConciliacaoComissao.js` | conciliador puro (novo) |
| `server/services/sentinel/sentinelConciliacaoColetor.js` | coletor: políticas puras + orquestração (novo) |
| `server/services/sentinel/sentinelConciliacaoRepositorio.js` | SQL: seleção, upsert, falha, pausa (novo) |
| `server/services/sentinel/sentinelConciliacaoLeitura.js` | leitura para o backend (novo) |
| `server/workers/sentinelConciliacaoWorker.js` | processo próprio, desligado por padrão (novo) |
| `server/sql/migrations/20261119_sentinel_conciliacao_comissao.sql` | migration aditiva (nova, **não aplicada**) |
| `server/services/sentinel/sentinelSchema.js` | `ensureSentinelConciliacaoSchema` (manual) / `conciliacaoSchemaPronto` (leitura) |
| `server/services/sentinel/sentinelPollingWorker.js` | `comLockDoCiclo({ chave })` (padrão inalterado) + export `resolverContaPadrao` |
| `server/controllers/sentinelController.js`, `server/routes/sentinelRoutes.js` | 3 handlers/rotas GET novos; os existentes intactos |
| `server/services/clientesUnificacao/references.js`, `server/services/raioX/raioXRegistro.js` | registro da tabela nova |
| `server/tests/sentinelConciliacao{Comissao,Coletor,Rotas}.test.js`, `server/tests/sentinelConciliacao.postgres.cjs` | testes |

## 6. Migration 20261119 (NÃO aplicada)
- `sentinel_conciliacao_comissao`: PK `(cliente_conta_id, pedido_id)`, **FK para `sentinel_pedidos` ON DELETE CASCADE** (isolamento por conta no banco; purge apaga junto),
  CHECK de estado/status/rebate, CHECK "comprovada exige os valores do Billing", centavos ≥ 0, ~0,6 KB/linha, sem dado de comprador. Sem `cliente_id` (o dono vem da Conta;
  unificação = "authoritative").
- `sentinel_conciliacao_controle`: pausa global após 429 (`chave='billing_429'`).
- Idempotente; aplicar **só com autorização**: `ensureSentinelConciliacaoSchema(pool)` (runner serializado) ou `psql -f`. Independe da 20261117 e da 20261118.
- Rollback: `DROP TABLE IF EXISTS sentinel_conciliacao_comissao; DROP TABLE IF EXISTS sentinel_conciliacao_controle;` — o código detecta a ausência (coletor suspende; leitura responde `disponivel:false`).

## 7. Configuração (todas opcionais exceto as duas primeiras)
| Variável | Padrão | Nota |
|---|---|---|
| `SENTINEL_CONCILIACAO_ENABLED` | off | sem ela o processo sai sem conexão |
| `SENTINEL_CONCILIACAO_CONTAS` | vazio | allowlist PRÓPRIA (não herda a do polling) |
| `SENTINEL_CONCILIACAO_UMA_VEZ` | off | uma execução e sai (ativação controlada) |
| `SENTINEL_CONCILIACAO_INTERVAL_MS` | 6 h | piso 10 min |
| `SENTINEL_CONCILIACAO_MAX_CHAMADAS_EXECUCAO` / `_CONTA` | 20 / 8 | orçamento ML |
| `SENTINEL_CONCILIACAO_LOTE` / `_MAX_PEDIDOS_CONTA` | 60 / 60 | lote nunca > 60 |
| `SENTINEL_CONCILIACAO_JANELA_DIAS` / `_MATURIDADE_HORAS` | 30 / 6 | |
| `SENTINEL_CONCILIACAO_RECONSULTA_HORAS` / `_RECONSULTA_NAO_CONCILIADO_HORAS` / `_MAX_RECONSULTAS` | 24 / 12 / 10 | PROCESSING nunca é definitivo |
| `SENTINEL_CONCILIACAO_MAX_FALHAS` / `_BACKOFF_FALHA_MIN` | 5 / 60 | backoff ×2, teto 24 h |
| `SENTINEL_CONCILIACAO_PAUSA_429_MIN` | 30 | ×2 por 429 consecutivo; Retry-After se maior; teto 24 h |
| `SENTINEL_CONCILIACAO_INTERVALO_CHAMADAS_MS` / `_EXECUCAO_MAX_MS` | 1000 / 120000 | |

## 8. Comportamento em falha e concorrência
| Situação | Efeito |
|---|---|
| 429 (Billing ou descontos) | nenhuma nova chamada na execução (todas as contas); pausa persistida; execuções seguintes saem sem chamar até o fim; Billing normal zera a sequência |
| 5xx / timeout / 206 / `errors[]` / 404 do Billing | falha registrada por pedido do lote **sem apagar a conciliação anterior**; backoff; `esgotada` após `MAX_FALHAS`; a conta para |
| 401 / token expirado | conta para, nada gravado (nunca renova token) |
| 403 | conta para (grant sem acesso ao Billing), nada gravado |
| exceção de grant/conta | conta para, nada gravado (não gasta tentativas) |
| orçamento / prazo | pedidos não consultados são **adiados** (não gravados, não gastam observação) |
| dois coletores | o segundo é pulado (lock); upsert monotônico por `observado_em` como 2ª defesa |
| pedido muda (hash) | reconciliado; contadores recomeçam; leitura marca `desatualizada` até lá |

## 9. Testes (todos locais, sem ML nem produção)
```bash
cd /home/user/Documentos/wt-sentinel-conciliador/server
export NODE_PATH=/home/user/Documentos/venforce_scanner_x1/server/node_modules DATABASE_URL=postgres://127.0.0.1:1/x
node tests/sentinelConciliacaoComissao.test.js   # 46
node tests/sentinelConciliacaoColetor.test.js    # 13
node tests/sentinelConciliacaoRotas.test.js      # 7
# PostgreSQL LOCAL descartável (ver memória/handoffs: apt-get download postgresql-18 + dpkg -x + initdb; porta 57652, socket /tmp/pgs)
SENTINEL_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57652/postgres node tests/sentinelConciliacao.postgres.cjs   # 80
```
O teste PG cobre: os 6 cenários do S1-A, isolamento de contas com o **mesmo `pedido_id`**, lote sem mistura de sellers e sempre `noRefresh`, idempotência,
PROCESSING→PROCESSED, descontos reaproveitados, concorrência (2 coletores + lock do polling ocupado), 503/206/`errors[]`/timeout/401/403/429 (Billing e descontos),
orçamento por conta e por execução, cupom, cashback, cobrança duplicada, vários itens, quantidade 2, FK/CHECK/purge e invariância da margem oficial.
Mutações não equivalentes testadas (pausa não persistida, falha sobrescrevendo estado, PROCESSING definitivo, descontos não reaproveitados, seleção sem conta): todas detectadas.

**Regressão (worktree, PG local):** todos os testes do Sentinel (unit + 11 PG) verdes; servidor 425 arquivos com as **mesmas 5 falhas da main**
(`basesTiktok`, `designStudioWorkspace`, `meliAnunciosOrdenacaoGlobal`, `mlTokenService`, `raioXVisual` — esta com saída idêntica à da main);
Portal com as **mesmas 8 falhas da main**. `sentinelRotas.postgres` passou aqui (75) — na main oscila por ordem de lista (preexistente, não corrigido).

## 10. Limitações financeiras (NÃO comprovadas — o código mantém estado conservador)
- Cupom, cashback, quantidade > 1, vários itens, cancelamento/reembolso, `discount` > 0 no Billing, bonificação/nota de crédito, `funding_mode` ≠ `sale_fee` com parte do ML > 0,
  DEAL/LIGHTNING/`boosted_offer`: nunca observados ⇒ `NAO_CONCILIADO`.
- Só a conta 41 foi validada no Billing real. **Contas 3 e 86: acesso ao Billing não testado.**
- `/orders/{id}/discounts` de pedido SEM promoção não foi observado (404? `details: []`?). 404 ⇒ "não verificado" (conservador) — pode deixar esses pedidos sempre `NAO_CONCILIADO`.
- Formato real de `errors[]` por pedido não observado ⇒ o lote inteiro falha (conservador).
- Documento `PROCESSED`, nota fiscal e liquidação (`money_release`) não verificados; definitivo = documento, não dinheiro.
- O Billing é documentado como fonte de **conciliação pós-venda**, não operacional; excesso ⇒ 429 com bloqueio por IP (compartilhado com o Portal).

## 11. Ativação controlada (cada passo exige autorização explícita)
1. Revisão/PR desta branch; deploy com a flag **desligada** (nada muda: o worker novo não roda).
2. Aplicar a migration 20261119 (aditiva) — fora do horário de pico.
3. Teste de acesso nas contas 3 e 86: **1 execução** por conta, orçamento mínimo:
   `SENTINEL_CONCILIACAO_ENABLED=true SENTINEL_CONCILIACAO_CONTAS=41 SENTINEL_CONCILIACAO_UMA_VEZ=true SENTINEL_CONCILIACAO_MAX_CHAMADAS_EXECUCAO=3 SENTINEL_CONCILIACAO_MAX_CHAMADAS_CONTA=3 node server/workers/sentinelConciliacaoWorker.js`
   (depois `…CONTAS=3`, `…CONTAS=86`).
   O worker **não lê `server/.env`**: rodar no ambiente do Render (shell do serviço), nunca de uma máquina local apontada para produção.
4. Conferir (somente leitura): `SELECT cliente_conta_id, estado, status_coleta, COUNT(*) FROM sentinel_conciliacao_comissao GROUP BY 1,2,3;` e `GET /sentinel/conciliacao/resumo`.
   Esperado na conta 41: maioria `TARIFA_LIQUIDA_COMPROVADA`; qualquer `DIVERGENTE`/`TARIFA_BRUTA_COMPROVADA` é **caso para investigar manualmente** antes de seguir.
5. Só então: processo contínuo (intervalo 6 h) nas contas validadas. Alertas financeiros continuam **desligados** (não há código que os dispare).

## 12. Próximos passos sugeridos (não iniciados)
- Observar em produção pedidos com cupom / qtd > 1 / sem promoção / reembolso para ampliar o escopo **com evidência** (não por teste sintético).
- Decidir com o financeiro o que fazer com `TARIFA_BRUTA_COMPROVADA` e `DIVERGENTE` (fila de investigação, não prejuízo).
- Exibir a conciliação na tela do Sentinel (consumir `GET /sentinel/conciliacao/pedidos/:id?conta=`).
