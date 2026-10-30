# Preview de Unificação: escopo, tempo e diagnóstico

## Diagnóstico e limites da medição

O preview executava `readSnapshot()` sob o mesmo prazo global de 15 segundos
da transação de escrita. O coletor carregava as sete tabelas core completas
(LIMIT 5001), filtrava os Clientes apenas depois dessas leituras e carregava
cada tabela dependente com uma consulta separada. O catálogo de columns ainda
unia duas views extensas do information_schema.

A reprodução local usa PostgreSQL 18 descartável, 60 tabelas dependentes e
4.000 Clientes/Contas de outras carteiras. No ensaio registrado:

| Medida | main 257b6ef0 | Otimizado |
| --- | ---: | ---: |
| Consultas de snapshot | 77 | 11 |
| Tempo total local | 103,16 ms | 36,91 ms |
| Clientes/Contas fora do manifesto | carregados antes de filtrar | não carregados |

Etapas individuais mais lentas do coletor antigo nesse ensaio: columns
30,10 ms; clientes 16,95 ms; cliente_contas 11,18 ms; constraints 6,26 ms;
indexes 4,82 ms. Tempos locais variam com cache/CPU e **não são medições do
banco de produção**. A quantidade de viagens ao banco independe desse efeito.

Um segundo teste aplica um relógio determinístico com 200 ms de transporte por
consulta PostgreSQL real. O coletor antigo excede o teto de 15 segundos; o
otimizado conclui com o mesmo teto. Não depende de sleeps nem eleva o timeout
para mascarar o custo. A fixture pequena cai de 17 para 7 consultas.

O terminal Maestri “Banco de dados” estava no shell, desconectado, durante esta
tarefa. Foi solicitada a reconexão para diagnóstico read-only. Não foram
procuradas credenciais nem criada conexão com produção; a atribuição do custo
real de #36/#65 a uma etapa específica fica pendente dessa medição. Os eventos
de instrumentação abaixo permitem identificar essa etapa após homologação.

## Coletor compartilhado

Preview, preflight do execute, revalidação sob locks, pós-validação e rollback
continuam usando **o mesmo readSnapshot**. Não há modo leve, cache de catálogo,
cache de dados ou amostragem diferente para o preview. O isolamento de cada
transação existente é preservado.

As leituras core agora usam predicados SQL e uma expansão explícita:

* Clientes do manifesto e cadeia `merged_into_cliente_id`, com UNION recursivo
  que termina inclusive em ciclos;
* Contas/Grants do conjunto, contas ligadas aos Grants, e outras titularidades
  do mesmo seller, inclusive terceiro Cliente, inativos e histórico superseded;
* Bases e vínculos necessários, incluindo vínculos de terceiros da mesma Base;
* Squads/membros associados ao histórico dos Clientes envolvidos.

Os catálogos completos de columns, FKs, PKs, UNIQUEs, CHECKs, índices, triggers
e exclusões continuam sendo lidos. A descoberta de dependências continua
atravessando FKs e referências lógicas e preserva falhas de escopo desconhecido,
ciclos e referências críticas desconhecidas. Não usa apenas uma lista fixa de
tabelas conhecidas. A união redundante com information_schema.tables foi
substituída por um filtro de tabelas r/p de pg_class; privilégios e data_type
continuam vindo de information_schema.columns.

Dependências prontas no mesmo nível são agrupadas em statements de até 16
tabelas. A profundidade do grafo continua determinando os níveis seguintes;
nenhum filho usa um pai ainda não carregado. Predicados idênticos são eliminados.
O limite de 5000 linhas é aplicado individualmente a cada resultado relevante,
mantendo BOUNDED_VOLUME_EXCEEDED. Carteiras alheias não consomem esse limite.

O transporte em lote contém células em texto e OIDs de tipo são usados apenas
internamente para aplicar os parsers nativos do pg. Isso preserva bigint de 64
bits, numeric, domains, timestamp e arrays, sem arredondamento por JSON numérico.
`_type_oid` e métricas não entram em snapshot, catálogo canônico ou planHash.

O teste com oracle congelado da main compara plano completo, validator,
materialSnapshot, planHash e plano reverso. Pré-visualizações e operações
anteriores seguem sujeitas às verificações de materialidade e catálogo.

## Orçamentos de transação

| Limite | READ ONLY | WRITE |
| --- | ---: | ---: |
| Prazo global | 30.000 ms por padrão | 15.000 ms, inalterado |
| statement_timeout | 10.000 ms | 10.000 ms |
| lock_timeout | 1.500 ms | 1.500 ms |
| idle_in_transaction_session_timeout | 15.000 ms | 15.000 ms |

`CLIENTES_UNIFICACAO_PREVIEW_TIMEOUT_MS` configura somente o orçamento global
das transações READ ONLY (preview e preflight/leituras do serviço). Aceita
inteiros entre 15000 e 300000 ms; ausente ou inválido usa 120000 (também é o statement_timeout do preview). Não habilita
EXECUTE/ROLLBACK. Nenhuma variável de produção foi alterada nesta tarefa.

Os 30 segundos são uma margem conservadora para catálogo frio e leituras
remotas após reduzir o número de consultas. Não substituem a otimização e não
certificam um tempo de produção que não foi medido. O teto por statement e o
timeout de lock permanecem iguais; não há prazo de minutos ou timeout removido.
As verificações de deadline e ROLLBACK do executor continuam ativas, inclusive
se o orçamento READ ONLY for configurado no máximo.

## Instrumentação sem secrets

`client_unification_snapshot` registra:

* catalog.columns, catalog.constraints, catalog.indexes e catalog.triggers;
* core.identity e core.bases, com tabelas e contagens;
* references.discovery e references.level, com nível e conjunto descoberto;
* references.load, por lote de no máximo 16 tabelas;
* table.loaded, com tempo no servidor para cada tabela;
* table.decode, com custo dos parsers no Node por tabela;
* total, com última etapa, quantidade de consultas e duração.

Eventos lentos (>=250 ms), erros e o resumo total são registrados por padrão.
Um callback `onStage` permite coletar todas as etapas durante o perfil local.
Erro preserva o código original no evento, sem message, stack, SQL ou params.
Falha no logger não altera o resultado da transação. As métricas não contêm
tokens, credenciais, valores de linhas ou manifesto e não afetam hashes.

## Testes

* clientesUnificacaoPreviewTimeout: reprodução do teto antigo, leitura acima de
  15 s permitida, escrita ainda limitada, configuração limitada e sigilo dos logs.
* clientesUnificacaoSnapshot.postgres: equivalência do plano/hash/rollback,
  redução de consultas, transporte lento modelado, terceiro proprietário,
  referência desconhecida, parsers precisos, escopo >5000 alheios e limite
  relevante preservado. Usa banco LOCAL validado pelo helper.
* 39 cenários PostgreSQL existentes de executor/rollback, 6 de identidade,
  15 cenários de domínio de identidade, 41 do domínio legado e 42 de Chrome.
* Backend completo: branch 356/360; base origin/main 355/359. Mesmas quatro
  falhas: basesTiktok, designStudioWorkspace, meliAnunciosOrdenacaoGlobal e
  mlTokenService. Nenhuma foi contornada ou corrigida fora do escopo.

`npm run test:unificacao:postgres` inclui as três suítes PostgreSQL. Banco de
produção não é aceito pelo helper. Sem migration, deploy ou unificação reais.

## Central de Vendas: escopo de referências históricas (pós-PR #350)

A captura de produção fornecida em 21/10/2026 mostrou `57014` em
`references.load`, após aproximadamente 10.064 ms. O statement agrupava
`central_vendas_mp_payment_charges`, `central_vendas_settlement_movements` e
`central_vendas_pedidos`. Esse tempo é do **statement inteiro**, não prova qual
ramo o consumiu. `central_vendas_mp_payments` retornou 5.001 linhas em cerca de
3,5 s. Esses dados não permitem afirmar que as 5.001 linhas sejam alheias.

O coletor genérico aplicava Cliente/slug/Conta/Base/Grant **ou** FK do pai em
todos os níveis. Uma Base/Grant compartilhada podia expandir runs/imports de
outra Conta e, daí, todos os filhos. A carga passa a usar a autoridade abaixo,
confirmada no schema versionado `server/sql/central_vendas_schema.sql` e
verificada contra as FKs do catálogo em cada snapshot:

| Tabela | Raiz/pai autoritativo |
| --- | --- |
| `central_vendas_sync_runs` | `cliente_conta_id → cliente_contas.id` |
| `central_vendas_imports` | `cliente_conta_id → cliente_contas.id`; também `sync_run_id → central_vendas_sync_runs.id` |
| `central_vendas_pedidos` | `import_id → central_vendas_imports.id` |
| `central_vendas_pedido_itens` | `import_id` e `pedido_row_id` |
| `central_vendas_componentes` | `import_id`, `pedido_row_id` e `item_row_id` |
| `central_vendas_mp_payments` | `sync_run_id → central_vendas_sync_runs.id` |
| `central_vendas_mp_payment_charges` | `mp_payment_row_id → central_vendas_mp_payments.id` |
| `central_vendas_mp_settlement_reports` | `sync_run_id → central_vendas_sync_runs.id` |
| `central_vendas_mp_settlement_movements` | `settlement_report_id → central_vendas_mp_settlement_reports.id` |

`sync_run_id` em charges/movements é redundante e não possui FK no schema
versionado; não inventamos um caminho com esse campo. O nome sem `mp_`
`central_vendas_settlement_movements`, presente na captura, não está nesse
schema. Se existir em produção, suas FKs reais serão descobertas: segue pais
Central com FK validada simples; sem caminho reconhecido continua bloqueado.
Não se assume que seja sinônimo da tabela versionada.

Raízes legadas sem Conta (`cliente_conta_id IS NULL`) continuam visíveis por
Cliente/slug. Não se escolhe apenas a última execução, um período recente,
status completed/published ou apenas Grants correntes para reduzir volume:
histórico relevante permanece relevante.

Para as **raízes** (`sync_runs`, `imports`), uma consulta `SELECT EXISTS`
separada por tabela verifica identidade direta fora do subgrafo carregado,
incluindo Cliente/slug/Conta/Grant/Base/seller quando presentes. Uma
contradição vira `CENTRAL_IDENTITY_OUTSIDE_PARENT_SCOPE`; não carregamos o
histórico inteiro dessa Conta externa. FKs não validadas, compostas ou
desconhecidas continuam fail-closed, assim como referências desconhecidas,
catálogo e blockers históricos.

`MAX_ROWS=5000` e todos os timeouts permanecem inalterados. Se uma raiz
relevante retorna 5.001 linhas, mantém `BOUNDED_VOLUME_EXCEEDED`; os
descendentes recebem `CENTRAL_PARENT_SCOPE_INCOMPLETE` sem expandir IDs de um
pai truncado. Uma tabela histórica é carregada por statement, evitando somar
leituras no mesmo orçamento de 10 s e identificando exatamente a tabela que
falhar. Sem SQL, parâmetros ou secrets nos eventos.

## Central de Vendas: alto volume histórico relevante

O diagnóstico real da Conta #71 mostrou que o histórico **realmente
relevante** já passa de 5.000: 7.291 payments, 7.064 pedidos, 35.079 charges,
19 sync runs e 24 imports. O escopo por Conta (acima) remove histórico alheio,
mas sozinho não resolve: carregar cada filho linha a linha no snapshot
estoura `MAX_ROWS`, e subir `MAX_ROWS` criaria snapshot, planHash, ledger e
locks enormes. Além disso, até aqui **toda** tabela `central_vendas_*` era
`BLOCKED_UNKNOWN`: qualquer histórico da Central bloqueava a unificação.

### Auditoria: quem depende de quê

Fonte de verdade: `server/sql/central_vendas_schema.sql` e todos os leitores
(`centralVendasRepository`, MP payments/settlement repositories, sync
run/source services, `painelContasRepository`, `centralVendasCliente360Adapter`,
`meService`, `clientePurgeService`, `clienteDependenciasService`).

| Tabela | PK | FKs Central | Identidade redundante | Lida/apagada por | Estratégia |
| --- | --- | --- | --- | --- | --- |
| `central_vendas_sync_runs` | `id` | — | cliente_id (FK `clientes` **ON DELETE CASCADE**), slug, conta, grant, base, seller | `cliente_id` + conta; `JOIN clientes c ON c.id=r.cliente_id` | `MOVE_TO_CANONICAL` |
| `central_vendas_imports` | `id` | `sync_run_id` | cliente_id, slug, conta, grant, base, seller | `cliente_slug` + conta; purge `DELETE … WHERE cliente_id` | `MOVE_TO_CANONICAL` |
| `central_vendas_sync_sources` | `id` | `sync_run_id` | — | `sync_run_id` | `PRESERVE_BY_PARENT` |
| `central_vendas_pedidos` | `id` | `import_id` | cliente_id, slug | `import_id` | `PRESERVE_BY_PARENT` |
| `central_vendas_pedido_itens` | `id` | `import_id`, `pedido_row_id` | cliente_id, slug | `import_id`, `pedido_row_id` | `PRESERVE_BY_PARENT` |
| `central_vendas_componentes` | `id` | `import_id`, `pedido_row_id`, `item_row_id` | cliente_id, slug | `import_id`, `pedido_row_id` | `PRESERVE_BY_PARENT` |
| `central_vendas_mp_payments` | `id` | `sync_run_id` | cliente_id, conta, seller | `sync_run_id` + conta | `PRESERVE_BY_PARENT` |
| `central_vendas_mp_payment_charges` | `id` | `mp_payment_row_id` | — (sync_run_id sem FK) | `mp_payment_row_id` | `PRESERVE_BY_PARENT` |
| `central_vendas_mp_settlement_reports` | `id` | `sync_run_id` | cliente_id, conta, seller | `sync_run_id` + conta | `PRESERVE_BY_PARENT` |
| `central_vendas_mp_settlement_movements` | `id` | `settlement_report_id` | conta (sem FK) | `sync_run_id`/report + conta | `PRESERVE_BY_PARENT` |
| qualquer outra `central_vendas_*` | | | | | `BLOCKED_UNKNOWN` |

Conclusões:

- **Raízes precisam mudar.** A leitura de imports filtra `cliente_slug`, a de
  runs filtra `cliente_id`, e `sync_runs.cliente_id` cascateia de `clientes`:
  deixá-las no legado esconderia o histórico do canônico e um purge do legado
  apagaria a operação preservada. São poucas linhas (19 + 24 para a Conta
  #71), então usam o motor existente `MOVE_TO_CANONICAL` linha a linha (PK +
  before-image, rowCount 1, ledger e rollback simétricos), trocando só
  `cliente_id`/`cliente_slug`. Conta, Grant histórico, Base e seller ficam.
  Nenhuma operação bulk foi necessária.
- **Filhos não precisam mudar.** Nenhum leitor e nenhum purge usa o
  `cliente_id`/`cliente_slug` redundante deles; tudo passa pela FK do pai,
  cujo ID não muda (e cascateia junto com ele). Reescrever dezenas de
  milhares de linhas de evidência financeira seria trabalho e risco sem
  benefício. O valor redundante fica como origem histórica.

### `PRESERVE_BY_PARENT`

O snapshot não carrega linhas dos filhos. Para cada um registra
`{table, strategy, parents, rows, fingerprint}`, onde `fingerprint` é
`md5` de `id:xmin` ordenado por `id` sobre o subgrafo alcançado a partir das
raízes carregadas. Qualquer INSERT/UPDATE/DELETE no subgrafo muda o
fingerprint. A consulta devolve uma linha só; nenhum dado de negócio sai do
banco.

- `plan.historicalFootprints` entra no `planHash` (footprints com 0 linhas
  ficam de fora, então planos sem histórico Central não mudam). Preview e
  execute recalculam o mesmo coletor; se o histórico mudou, `planHash`
  diverge → `MERGE_PLAN_CHANGED`, sem escrita.
- O ledger (`before/after_snapshot_json`) guarda o material das raízes e os
  footprints em `@historical_footprints`, alguns KB em vez de 35 mil linhas.
  A pós-validação do execute exige footprints idênticos antes/depois; o
  rollback exige footprints iguais ao estado pós-merge
  (`ROLLBACK_STATE_DIVERGED` caso contrário) e os compara de novo após
  restaurar.
- `impactCounts` mostra cada filho com sua contagem e estratégia
  `PRESERVE_BY_PARENT` na UI.

O subgrafo segue só as FKs que são caminho real de leitura **e** têm índice.
Em `componentes`, `item_row_id` é apenas cascata, sem índice e sem leitor;
não define escopo. As linhas continuam intocadas de qualquer forma, mas um
componente ligado **somente** por `item_row_id` a um item relevante (dado
inconsistente, o writer grava os três FKs do mesmo import) não entra no
fingerprint. Se uma FK de escopo perder o índice, o preview bloqueia com
`CENTRAL_SCOPE_INDEX_MISSING` em vez de arriscar seq scan e `57014`.

Desempenho: ramos de raiz usam `fk = ANY($ids)`; ramos via pai preservado usam
`CROSS JOIN LATERAL (… WHERE fk = pai.id OFFSET 0)`. O `OFFSET 0` impede o
planner de achatar o LATERAL em hash join com seq scan, então o trabalho é
proporcional ao histórico relevante e não ao tamanho global da tabela. A
primeira versão com `= ANY(ARRAY(subselect))` levou 947 ms só em componentes
(filtro linear), e um semi-join simples fazia seq scan das tabelas inteiras.

Para filhos preservados não há mais a verificação `EXISTS` de identidade
redundante fora do pai. Ela exigia varrer as maiores tabelas por colunas sem
índice e não protegia nada: uma linha dessas não é alterada pela unificação,
continua presa ao próprio pai e nenhum leitor a acha pela identidade
redundante.

Continua blocker (fail-closed):

- raiz do legado com `cliente_conta_id IS NULL` →
  `ACCOUNT_CONTEXT_AMBIGUOUS/CENTRAL_ROOT_WITHOUT_ACCOUNT` (movê-la misturaria
  o legado de duas operações no fallback do canônico; Conta nunca é inferida);
- run `queued/running` no escopo → `ACTIVE_OPERATION`;
- raiz com identidade direta fora do subgrafo →
  `CENTRAL_IDENTITY_OUTSIDE_PARENT_SCOPE`, e seus filhos ficam sem footprint
  (`CENTRAL_PARENT_SCOPE_INCOMPLETE`);
- PK, FK Central ou coluna de identidade diferente do auditado →
  `CENTRAL_POLICY_DRIFT`; filho preservado com FK para `clientes` →
  `CENTRAL_PRESERVED_CLIENT_FK`; tabela não auditada que referencia um filho
  preservado → `CENTRAL_PRESERVED_PARENT_UNSUPPORTED`; qualquer outra tabela
  `central_vendas_*` com linhas → `BLOCKED_UNKNOWN`.

O índice único parcial `uq_central_vendas_sync_runs_ativo_v2` tem chave de
expressão (`COALESCE`). O planner passa a aceitar índice parcial quando toda
linha alterada fica fora do predicado (runs concluídos não entram no índice de
ativos e não colidem). Expressões não modeladas continuam bloqueando.

### Evidência local

`clientesUnificacaoCentralScope.postgres.cjs` aplica o schema real em
PostgreSQL 18 local descartável, com o volume da Conta #71 (19 runs, 24
imports, 7.064 pedidos/itens, 14.128 componentes, 7.291 payments, 35.079
charges, 2.000 movements) e 6.001+ linhas de terceiro: snapshot sem
`BOUNDED_VOLUME_EXCEEDED`, filhos nunca em `references.load`, plano
executável; histórico alheio não muda o hash; UPDATE/INSERT em neto muda o
hash e DELETE o restaura; mudança entre preview e execute dá
`MERGE_PLAN_CHANGED` sem escrita; execute move as 43 raízes e mantém
id/xmin/identidade de todos os filhos (oráculo SQL independente); retry
idempotente; rollback bloqueia com histórico divergente, restaura e é
idempotente; blockers de raiz sem Conta, run ativo, conflito externo, tabela
desconhecida, drift, índice ausente e FK de Conta ausente; caso sanitizado
#36/#65 (seller duplicado com decisão de Grant, Conta #71 + Grant #103,
histórico Central) chega às decisões, executa e reverte.

Benchmark local separado com ruído de 60 operações alheias (2,1 M charges,
854 k componentes, 427 k payments) mais a Conta #71: snapshot 122–142 ms,
preview 144 ms, execute 584 ms, rollback 457 ms, sem seq scan em nenhum plano.
O mesmo cenário levava ~4,8 s no execute e 1,2 s por snapshot antes do LATERAL.

**Limite:** não houve sessão psql de produção nesta rodada e nenhuma
credencial foi procurada. Não há EXPLAIN nem contagem de produção desta
versão. O índice exigido em cada FK de escopo é checado no catálogo real a
cada preview: se faltar, o preview mostra blocker em vez de timeout. Nenhuma
mudança de produção, flag, deploy, merge ou unificação foi feita.

Operação: qualquer escrita no subgrafo preservado entre preview e execute
(sync noturno da Conta, reprocessamento de run) invalida o plano com
`MERGE_PLAN_CHANGED`. Isso é intencional. Execute fora da janela de sync e,
se acontecer, gere um novo preview.

Validação desta revisão: 62 cenários PostgreSQL (39 executor/rollback, 6
identidade, 8 snapshot, 9 Central), 42 cenários de domínio, 42 cenários
Chrome e 7 E2E UI + PostgreSQL. Todas as suítes de unificação,
accountContextFoundation, oauthAccountBindingAtomic e Central de Vendas
passaram. Backend completo: **356/360 na branch e 356/360 em origin/main
03d92dca**, com as mesmas quatro falhas históricas e mensagens idênticas
(basesTiktok, designStudioWorkspace, meliAnunciosOrdenacaoGlobal,
mlTokenService). Nenhuma falha nova.

## Finalização: owner, placeholder e labels

- **Owner (`ACCOUNT_OWNER_MISMATCH`)**: linhas MOVE com `cliente_conta_id` são avaliadas pelo estado final. Conta do merge + linha de cliente do merge → reconciliada para o canônico (`cliente_id` muda, reversível). Conta fora do merge ou linha de cliente fora dele continua bloqueando.
- **Placeholder** (`identity.js`): Conta ML sem seller, sem Grant/Base ativos e não escolhida pode ser desativada (nunca apagada) se toda referência está numa tabela conhecida, sem operação em andamento e sem seller externo. Histórico fica no ID da Conta (`action: PRESERVE_ON_INACTIVE`). Tabela desconhecida → `EMPTY_ACCOUNT_NOT_SAFE`.
- **Labels** (`labels.js`): contas ativas com nome automático ("Mercado Livre 2") são renumeradas por marketplace: principal final, depois canônico, depois id. Nomes personalizados e contas inativas ficam intactos; rollback restaura via `before`.
- **UI**: 3 passos; detalhes técnicos em accordion; aprovador = usuário autenticado; desativação de placeholder e Conta única de seller são sugeridas automaticamente (seguem explícitas no manifesto e desfazíveis).

## Timeout de escrita (execute/rollback)

`CLIENTES_UNIFICACAO_EXECUTE_TIMEOUT_MS` (15000–300000, default 120000; inválido → default) define o orçamento global da transação SERIALIZABLE de execute/rollback e o `statement_timeout` dela. Substitui o teto fixo de 15s, que estourava em planos grandes (~1000 alterações, ~21s). Preview segue em `CLIENTES_UNIFICACAO_PREVIEW_TIMEOUT_MS`; `lock_timeout` (1,5s) e `idle_in_transaction_session_timeout` (15s) não mudam. Limites de linhas, planner, planHash, locks, ledger e rollback ficam como estavam.

## Fluxo simples (quem fica + quem entra)

O operador informa só o canônico e os legados. O backend resolve de forma determinística (e o resultado entra no planHash/ledger):

- **Aprovação**: o admin autenticado que valida/executa é o aprovador (`ADMIN_AUTENTICADO`) quando o manifesto não traz aprovador/referência. Aprovação explícita (API/CLI) continua valendo.
- **Conta principal por marketplace**: a do canônico; senão menor id. **Grant principal**: o da Conta ML principal, do canônico, menor id.
- **Grant duplicado do mesmo seller**: mantém o vinculado à Conta > válido > do canônico > menor id; os demais viram `superseded` (histórico).
- **Conta do seller**: automática se uma Conta já declara o seller ou é a única possível. **Duas candidatas → única pergunta humana.**
- **Placeholder** (ML sem seller, com histórico em tabelas conhecidas): desativado sem pergunta. Sem histórico fica como está.
- Ausência de Base é só aviso. Confirmação textual e checkbox saíram da UI (o rollback mantém a confirmação).
