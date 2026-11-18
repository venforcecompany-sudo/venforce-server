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
| `server/services/sentinel/sentinelConciliacaoRepositorio.js` | SQL: seleção, contas ativas, upsert, falha, pausa (novo) |
| `server/services/sentinel/sentinelConciliacaoLeitura.js` | leitura para o backend (novo) |
| `server/workers/sentinelConciliacaoWorker.js` | processo próprio, desligado por padrão (novo) |
| `server/scripts/sentinel-conciliacao.js` | **CLI de operação**: `status` (read-only), `aplicar-schema`, `executar`, `reverter-schema` (novo) |
| `server/sql/migrations/20261119_sentinel_conciliacao_comissao.sql` | migration aditiva (nova, **não aplicada**) |
| `server/services/sentinel/sentinelSchema.js` | `ensureSentinelConciliacaoSchema` (manual) / `conciliacaoSchemaPronto` (leitura; `{lancar:true}` no coletor) |
| `server/services/sentinel/sentinelPollingWorker.js` | `comLockDoCiclo({ chave })` (padrão inalterado) + export `resolverContaPadrao` |
| `server/controllers/sentinelController.js`, `server/routes/sentinelRoutes.js` | 3 handlers/rotas GET novos; os existentes intactos |
| `server/services/clientesUnificacao/references.js`, `server/services/raioX/raioXRegistro.js` | registro da tabela nova |
| `server/tests/sentinelConciliacao{Comissao,Coletor,Rotas}.test.js`, `server/tests/sentinelConciliacao.postgres.cjs` | testes |

## 6. Migration 20261119 (NÃO aplicada — confirmado em produção em 18/11/2026)
- `sentinel_conciliacao_comissao`: PK `(cliente_conta_id, pedido_id)`, **FK para `sentinel_pedidos` ON DELETE CASCADE** (isolamento por conta no banco; purge apaga junto),
  CHECK de estado/status/rebate, CHECK "comprovada exige os valores do Billing", centavos ≥ 0, ~0,6 KB/linha, sem dado de comprador. Sem `cliente_id` (o dono vem da Conta;
  unificação = "authoritative").
- `sentinel_conciliacao_controle`: pausa global após 429 (`chave='billing_429'`).
- Idempotente e **não depende** da 20261117 nem da 20261118 (também NÃO aplicadas em produção). Nenhum runner a aplica sozinho (nem o boot do servidor nem o worker).
- Aplicar: `node scripts/sentinel-conciliacao.js aplicar-schema --confirm-host=<host>` (runner serializado por advisory lock + marcador de versão).
- **Rollback**: `node scripts/sentinel-conciliacao.js reverter-schema --confirm-host=<host> --apagar-conciliacoes` — numa transação: DROP das 2 tabelas **e** o marcador
  `vf:schema:sentinel_conciliacao_comissao` em `venforce_schema_versoes`. (Achado desta revisão: um DROP manual sem apagar o marcador faz a reaplicação ser ignorada
  pelo runner; `aplicar-schema` agora detecta e explica.) Testado localmente: aplicar → reverter (com dados) → reaplicar. `sentinel_pedidos` intacta.

## 7. Configuração (todas opcionais exceto as duas primeiras)
| Variável | Padrão | Nota |
|---|---|---|
| `SENTINEL_CONCILIACAO_ENABLED` | off | sem ela o processo sai sem conexão |
| `SENTINEL_CONCILIACAO_CONTAS` | vazio | allowlist PRÓPRIA (não herda a do polling); só contas ML **ativas** com seller são processadas |
| `SENTINEL_CONCILIACAO_UMA_VEZ` | off | uma execução e sai |
| `SENTINEL_CONCILIACAO_INTERVAL_MS` | 6 h | piso 10 min |
| `SENTINEL_CONCILIACAO_MAX_CHAMADAS_EXECUCAO` / `_CONTA` | 20 / 8 | orçamento ML; **piso 2** (1 Billing + 1 `/discounts` é o mínimo útil) |
| `SENTINEL_CONCILIACAO_LOTE` / `_MAX_PEDIDOS_CONTA` | 60 / 60 | lote nunca > 60 |
| `SENTINEL_CONCILIACAO_JANELA_DIAS` / `_MATURIDADE_HORAS` | 30 / 6 | a janela é o fim real de qualquer retentativa |
| `SENTINEL_CONCILIACAO_RECONSULTA_HORAS` / `_RECONSULTA_NAO_CONCILIADO_HORAS` / `_MAX_RECONSULTAS` | 24 / 12 / 10 | PROCESSING nunca é definitivo |
| `SENTINEL_CONCILIACAO_MAX_FALHAS` / `_BACKOFF_FALHA_MIN` | 5 / 60 | backoff ×2, teto 24 h |
| `SENTINEL_CONCILIACAO_ESGOTADA_RETRY_DIAS` | 7 | `esgotada` volta sozinha depois disso (dentro da janela) |
| `SENTINEL_CONCILIACAO_PAUSA_429_MIN` | 30 | ×2 por 429 consecutivo; Retry-After se maior; teto 24 h |
| `SENTINEL_CONCILIACAO_INTERVALO_CHAMADAS_MS` / `_EXECUCAO_MAX_MS` | 1000 / 120000 | |

A CLI (`executar`) sobrepõe só o orçamento (`--max-chamadas`, 2..20, padrão 3, aplicado à execução **e** à conta); o resto vem destes padrões.

## 8. Comportamento em falha e concorrência
| Situação | Efeito |
|---|---|
| 429 (Billing ou descontos) | nenhuma nova chamada na execução (todas as contas); pausa persistida; execuções seguintes saem sem chamar até o fim; Billing normal zera a sequência |
| **429 embrulhado** (HTTP 4xx/5xx com corpo indicando 429/rate limit) | tratado como 429. Formato **real** visto em produção: `HTTP 400 … "message":"Http status error with code 429"` (log do venforce-server, 17/11, `/billing/…/monthly/periods`) |
| 5xx / timeout / 206 / 404 do Billing | falha registrada por pedido do lote **sem apagar a conciliação anterior**; backoff; a conta para |
| `errors[]` em que TODO erro aponta um pedido do lote (`order_id`/`orderId`/`id`) | só esses pedidos falham; os demais do lote são conciliados |
| `errors[]` em formato não reconhecido | o lote inteiro falha (conservador) |
| pedido "venenoso" que sempre derruba o lote | lotes encolhem por nº de falhas (60 → 15 → 3 → 1): o pedido é isolado e os outros seguem |
| `esgotada` (falhas ou reconsultas) | **não é definitiva**: nova tentativa após 7 dias (recuperação automática depois de indisponibilidade do ML); fim real = janela |
| 404 em `/discounts` | **1** consulta; marcador `{indisponivel_http:404}` gravado; `NAO_CONCILIADO` (`descontos_indisponiveis_nao_validado`, escopo estável) — nunca "sem desconto", sem reconsulta em loop |
| 401 / token expirado | conta para, nada gravado (nunca renova token) |
| 403 | conta para (grant sem acesso ao Billing), nada gravado |
| exceção de grant/conta | conta para, nada gravado (não gasta tentativas) |
| erro interno inesperado numa conta (ex.: FK de pedido apagado no meio) | só aquela conta para; as outras seguem |
| orçamento | o Billing só recebe os pedidos que poderão ser concluídos (vagas para `/discounts`); o resto fica na fila sem gastar observação |
| conta inativa / inexistente / não ML na allowlist | ignorada, sem lock e sem chamada |
| dois coletores | o segundo é pulado (lock); upsert monotônico por `observado_em` como 2ª defesa |
| pedido muda (hash) ou contrato do conciliador muda | reconciliado (descontos gravados reaproveitados); leitura marca `desatualizada` até lá |
| banco fora do ar | erro explícito (não é confundido com "migration ausente"); nenhuma chamada ao ML |

## 9. Testes (todos locais, sem ML nem produção)
```bash
cd /home/user/Documentos/wt-sentinel-conciliador/server
export NODE_PATH=/home/user/Documentos/venforce_scanner_x1/server/node_modules DATABASE_URL=postgres://127.0.0.1:1/x
node --test tests/sentinelConciliacaoComissao.test.js tests/sentinelConciliacaoColetor.test.js tests/sentinelConciliacaoRotas.test.js   # 47 + 17 + 7 = 71
# PostgreSQL LOCAL descartável (apt-get download postgresql-18 + dpkg -x + initdb; porta 57652, socket /tmp/pgs; ssl=on com cert autoassinado para a CLI)
SENTINEL_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57652/postgres node tests/sentinelConciliacao.postgres.cjs   # 95
```
O teste PG cobre: os 6 cenários do S1-A, isolamento de contas com o **mesmo `pedido_id`**, lote sem mistura de sellers e sempre `noRefresh`, idempotência,
PROCESSING→PROCESSED, descontos reaproveitados, concorrência (2 coletores + lock do polling ocupado), 503/206/`errors[]`/timeout/401/403/429/429-embrulhado
(Billing e descontos), orçamento por conta e por execução, cupom, cashback, cobrança duplicada, vários itens, quantidade 2, FK/CHECK/purge, invariância da margem
oficial e (seção 13) recuperação de `esgotada`, `errors[]` por pedido, isolamento do pedido venenoso, 404 em `/discounts`, reinterpretação por contrato e conta inativa.
Mutações (S1): pausa não persistida, falha sobrescrevendo estado, PROCESSING definitivo, descontos não reaproveitados, seleção sem conta.
Mutações (pré-publicação): 429 embrulhado ignorado, `esgotada` sem retorno, 404 como "sem desconto", sem isolamento por falhas, Billing sem olhar o orçamento,
`errors[]` com id derrubando o lote, conta inativa processada — **todas detectadas**.
CLI testada contra PG local com a rede bloqueada por preload (status read-only, aplicar 2×, reverter com/sem dados, reaplicar, host remoto exige `--confirm-host`).

**Regressão (18/11, worktree, PG local):** Sentinel unit 221/221; suítes PG do Sentinel verdes (`sentinelIncidentes` cai no **encerramento** depois das 46 verificações —
idêntico na `origin/main`); servidor 425 arquivos com as **mesmas 5 falhas da main** (`basesTiktok`, `designStudioWorkspace`, `meliAnunciosOrdenacaoGlobal`,
`mlTokenService`, `raioXVisual` — confirmadas na `origin/main` 2c640661; `raioXVisual` com saída idêntica). Portal: a branch não toca em `Portal/`.

## 10. Limitações financeiras (NÃO comprovadas — o código mantém estado conservador)
- Cupom, cashback, quantidade > 1, vários itens, cancelamento/reembolso, `discount` > 0 no Billing, bonificação/nota de crédito, `funding_mode` ≠ `sale_fee` com parte do ML > 0,
  DEAL/LIGHTNING/`boosted_offer`: nunca observados ⇒ `NAO_CONCILIADO`. (Em produção, 18/11: nenhum pedido do Sentinel tem mais de 1 item; 54 têm quantidade > 1.)
- Só a conta 41 foi validada no Billing real. **Contas 3 e 86: acesso ao Billing não testado** (o polling delas funciona com o mesmo grant).
- `/orders/{id}/discounts` de pedido SEM promoção continua **não observado**. Se vier `200 {details:[]}` ⇒ concilia (ausência verificada); se vier 404 ⇒ `NAO_CONCILIADO`
  estável com marcador gravado. Se a 1ª execução mostrar que 404 = "sem promoção", uma versão nova do contrato pode reinterpretar as linhas **sem nova chamada a /discounts**.
- `errors[]` por pedido: formato real não observado; isolado só quando inequívoco, senão o lote falha.
- Documento `PROCESSED`, nota fiscal e liquidação (`money_release`) não verificados; definitivo = documento, não dinheiro.
- O Billing é documentado como fonte de **conciliação pós-venda**, não operacional; excesso ⇒ 429 com bloqueio por IP (compartilhado com o Portal). O próprio
  venforce-server já recebeu 429 do Billing (embrulhado em 400) em 17/11 — o coletor agora pausa também nesse formato.

## 11. Publicação e ativação controlada (cada passo exige autorização explícita)
**Atenção ao publicar:** o serviço `venforce-sentinel` tem **auto-deploy ligado na `main`** (o `venforce-server` não). O merge redeploya o polling com esta branch:
o único código compartilhado que ele executa é `comLockDoCiclo` (chave padrão inalterada) — comportamento idêntico, testado (`sentinel*.postgres`). O worker novo
**não é iniciado por nenhum serviço** (start command continua `node workers/sentinelWorker.js`). No deploy, o Render sobrepõe instâncias por ~2 min (visto em 17/11);
o lock do polling já cobre.

1. PR → merge (auto-deploy do `venforce-sentinel`) → deploy **manual** do `venforce-server` (3 rotas GET respondem `disponivel:false` até a migration).
2. No **Shell do serviço `venforce-sentinel`** no Render (Dashboard → venforce-sentinel → Shell, ou `ssh srv-dbh28b9srm7s73f26v9g@ssh.oregon.render.com`; se o prompt não abrir em `server/`, `cd /opt/render/project/src/server`; `DATABASE_URL` e grants
   já estão no ambiente; **nenhuma variável do Render precisa mudar**):
   ```bash
   node scripts/sentinel-conciliacao.js status --contas=41,3,86          # read-only: imprime o host do banco e confirma "ausente"
   node scripts/sentinel-conciliacao.js aplicar-schema --confirm-host=<host impresso>
   node scripts/sentinel-conciliacao.js executar --contas=41 --max-chamadas=3 --confirm-host=<host>
   node scripts/sentinel-conciliacao.js status --contas=41              # resultado + lista de DIVERGENTE/TARIFA_BRUTA para investigar
   ```
   Com 3 chamadas: 1 Billing (lote só com o que cabe) + até 2 `/discounts` ⇒ até 2 pedidos conciliados. Saída em JSON (chamadas, estados, parada, erro).
3. Repetir `executar --contas=3` e `--contas=86` (acesso ao Billing não testado nessas contas: 403 ⇒ `sem_permissao_billing`, nada gravado).
4. **Interromper**: Ctrl+C (termina o pedido corrente e sai) ou fechar o shell/matar o processo — o lock cai com a conexão; gravações são por pedido e idempotentes;
   nada fica pela metade. Uma execução tem teto de 120 s e de `--max-chamadas`. Em 429 a pausa fica gravada e vale para qualquer execução seguinte.
5. Desfazer tudo: `reverter-schema --confirm-host=<host> --apagar-conciliacoes`.
6. Só depois de conferir os resultados: processo contínuo (intervalo 6 h) — exige **novo serviço/worker ou cron no Render** com
   `SENTINEL_CONCILIACAO_ENABLED=true SENTINEL_CONCILIACAO_CONTAS=<validadas>` e start `node workers/sentinelConciliacaoWorker.js` (decisão e autorização à parte).
   Alertas financeiros continuam **desligados** (não há código que os dispare).

## 12. Estado de produção confirmado via Render (18/11/2026, somente leitura)
- Workspace único; Postgres `venforce-db` (PG 18.6, 0.5c-1g, 10 GB, banco ≈ 5,25 GB, ~15 conexões de 103).
- `venforce-server` (web): live = `2c640661` (#417, deploy manual 17/11 19:28); auto-deploy **off**. Sem erros do Sentinel no log; vigia ativo a cada 900 s.
- `venforce-sentinel` (worker): live = `f2f3eb49` (#416, auto-deploy 17/11 17:09); `[sentinel-worker] ON — contas 41,86,3, intervalo 180000ms, pool max 2`;
  ciclos a cada ~3 min, `erro=-`, `quarentena=0` nas 3 contas; nenhum log de warn/error desde o deploy; ~90–120 chamadas ML/ciclo na conta 86.
- Banco: tabelas `sentinel_*` = pedidos, incidentes, incidente_eventos, checkpoints, pedido_excecoes; **20261117, 20261118 e 20261119 NÃO aplicadas**
  (sem colunas de evidência/recálculo, sem tabelas de conciliação, sem marcador em `venforce_schema_versoes`).
- Elegíveis hoje (1 item, qtd 1, pagos, 6 h–30 d): conta 3 = 32, conta 41 = 300, conta 86 = 698.
- Grants: as 3 contas operam no polling com o mesmo caminho de grant (`resolverContaPadrao`, noRefresh) — inferido do log, não testado contra o Billing nas contas 3/86.
- Flags: a ferramenta Render disponível **não lê variáveis de ambiente**; o estado ON do polling vem do log de boot. As flags `SENTINEL_CONCILIACAO_*` não existem
  em código publicado — nada a desligar.

## 13. Próximos passos sugeridos (não iniciados)
- Observar em produção pedidos com cupom / qtd > 1 / sem promoção / reembolso para ampliar o escopo **com evidência** (não por teste sintético).
- Decidir com o financeiro o que fazer com `TARIFA_BRUTA_COMPROVADA` e `DIVERGENTE` (fila de investigação, não prejuízo).
- Exibir a conciliação na tela do Sentinel (consumir `GET /sentinel/conciliacao/pedidos/:id?conta=`).
- Quando a 20261117 (evidência) for aplicada e ligada, os `payload_hash` mudam ⇒ todos os elegíveis são reselecionados (custo: 1 Billing/60 pedidos; descontos reaproveitados).
