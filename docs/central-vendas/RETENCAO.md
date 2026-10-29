# Central de Vendas: retenção controlada de imports

## Por que existe

Cada sync grava um import novo com o mês inteiro (`central_vendas_imports`, mais `pedidos`, `pedido_itens` e `componentes` em cascata). Os imports antigos da mesma tupla ficam no banco, mas nenhum leitor consegue mais selecioná-los. Números de produção em 29/10/2026:

- 2.061 imports para 193 tuplas, com até 47 versões numa mesma tupla.
- 580 mil pedidos estão em publicados substituídos; só 84 mil estão em imports vigentes.
- `mp_payments`: 969 mil linhas para 137 mil payments distintos.

A retenção apaga só o que comprovadamente nunca mais será selecionado. **O critério não é a idade.**

## Regra

**Tupla**: `(cliente_slug, marketplace, competencia, cliente_conta_id)`. É exata, e `NULL` é comparado como valor.

**Seleção canônica**: `selecionarMelhorImportPorCompetencia` (`server/services/centralVendas/centralVendasRepository.js`). O planner reusa essa função e não reescreve a regra.

| Classe | Quando |
|---|---|
| **substituído** (published) | A seleção sobre a tupla, para o segmento igual à própria cobertura de P, devolve outro import. Esse outro é um published mais recente (`published_at`, `id`) cuja cobertura contém a de P. Um published com cobertura NULL não domina ninguém. |
| **substituído** (legacy) | Existe legacy mais recente (`created_at`, `id`) na tupla, ou a seleção do mês inteiro devolve um published (cobertura do mês todo). |
| **resíduo** (candidate) | O run está terminal (completed, failed ou cancelled) e o run falhou ou existe published mais novo na tupla. Candidate de run queued ou running nunca entra. |
| **resíduo `cobertura_vazia`** | Published, ou candidate de run terminal, com `coverage_date_from > coverage_date_to`. Exemplo: competência 2026-09 com cobertura 2026-10-01 → 2026-09-30, gerada pelo bug de fuso da janela de Orders. Nenhum segmento real cabe nessa cobertura. Em 29/10 eram 515 imports. A origem foi corrigida na branch de margem; o planner continua tratando os que já existem. |
| **essencial** | Nunca é apagado, mesmo que dominado (ver abaixo). |
| **retido** | Não é elegível: published sem cobertura, candidate sem published mais novo, política desligada etc. |

**Essencial**:

1. Selecionável hoje, ou seja, o vigente de algum segmento.
2. Citado por outra persistência (ver "Referências protegidas").
3. De run queued ou running.
4. Mais novo que `minIdadeHoras`, considerando o maior entre `created_at` e `published_at`.
5. Os `manterUltimosSubstituidos` published dominados mais recentes da tupla, como margem de rollback.
6. **Carência desde a substituição** (`carencia_substituicao`): o dominado só é elegível se o **dominador** foi publicado ou criado há mais de `minIdadeHoras`. Isso vale além da idade própria do dominado. O dominador é:
   - para published, o published mais novo que cobre a cobertura dele, ou seja, o que a seleção devolve, usando `published_at`;
   - para legacy, o legacy mais novo (`created_at`) ou, na falta dele, o published do mês inteiro (`published_at`).

   Cobertura vazia e candidate não têm carência, porque nunca foram selecionáveis; só a idade própria conta.

### A garantia: invariante "referência JSON nunca é desreferenciada" + piso

A carência é **margem**. A **prova** de que não há lock a fazer com os escritores de referência JSON é esta invariante, coberta pelo teste de contrato `tests/centralVendasRetencaoContratoPainel.test.js`:

1. O Painel de Contas só usa o snapshot (`cliente_360_resumos_mensais`) quando `snapshot.centralImportIds` é exatamente o conjunto dos imports vigentes selecionados **ao vivo**. A comparação fica em `painelContasOperacional.consolidarCliente`, via `mesmoConjunto`, em `painelContasOperacional.js:423`. Se não casa, o consolidado vem da seleção ao vivo.
2. Pedidos, semanas e composição são lidos sempre pelos ids de `importPorConta`, que vem de `escolherImportPorConta`, a mesma seleção canônica (`painelContasService.js:365/410`). Nunca são lidos pelos ids gravados no snapshot.
3. `centralImportIds` só é extraído do JSON (`painelContasRepository.mapRow`) e comparado. O teste falha se surgir um terceiro uso.
4. O ramo "nenhuma conta com dado" (`snapshot_cliente`) mostra os agregados gravados no próprio snapshot e não lê import nenhum.

Consequência: um snapshot que cita um import dominado já apagado pela retenção é ignorado, e nada é lido a partir do id dele. A retenção nunca apaga um vigente; os vigentes são essenciais.

**Piso**: o apply, tanto pelo CLI quanto pelo modo automático, recusa `minIdadeHoras` abaixo de **24** (`MIN_IDADE_ABAIXO_DO_PISO`), venha o valor de `CENTRAL_VENDAS_RETENCAO_MIN_IDADE_HORAS` ou de `--min-idade-horas`. O dry-run aceita qualquer valor, porque é só simulação. Assim, nem a carência nem a idade própria podem ser zeradas por configuração.

Invariante e piso juntos são a garantia; a carência de 72 h é margem adicional.

### Por que a carência dispensa lock com os escritores de referência

Alguns escritores gravam ids de import em JSON sem nenhum lock compartilhado com a retenção. Exemplos: o snapshot do Painel e do Cliente 360 (`upsertResumoMensal`, `cliente360Repository.js`) e qualquer leitura em voo que resolveu `importIds` e ainda vai carregar os pedidos.

Todos eles só pegam o import **vigente**, e um import só deixa de ser vigente quando o dominador aparece. Com a carência, quem viu o import como vigente fez isso antes do dominador existir, portanto há mais de `minIdadeHoras` (72 h por padrão). Nenhuma leitura ou escrita em voo usa ainda um import dominado há 72 h, e a próxima resolução já devolve o dominador.

Uma referência gravada depois disso continua protegida pelas refs, relidas dentro do lote. A re-avaliação do lote usa o mesmo planner: um dominador publicado entre o plano e o lote faz o lote desistir do dominado (há teste).

**Prova**: o teste de propriedade (`tests/centralVendasRetencaoPlanner.test.js`) roda 200 cenários aleatórios, todos os segmentos do mês e as variantes de conta (exata e `includeLegacy`). Em todos, a seleção é idêntica antes e depois da remoção. O teste em PostgreSQL faz a mesma verificação com `resolveImportsForRange` real.

A dominância na tupla exata vale em qualquer variante de conta: quem domina está na mesma tupla, portanto em qualquer união que contenha o dominado.

### mp_payments

Um run é elegível quando todas estas condições valem:

- Nenhum import retido aponta para ele. É por esses runs que `listMpPaymentsWithChargesTotalByRunIds` lê.
- Não é citado por import fora do escopo, porque um run gera imports em várias competências.
- É terminal e mais velho que `minIdadeHoras`.

O DELETE é por `sync_run_id` em `central_vendas_mp_payments` (usa o UNIQUE `(sync_run_id, payment_id)`). As charges saem por CASCADE de `mp_payment_row_id`. `sync_runs`, `sync_sources` e os settlement reports ficam, por serem auditoria e pequenos.

### Efeito colateral: conciliação por run antigo mostra 0 payments

A conciliação Mercado Pago por run (`GET /:slug/sync-runs/:runId/mercado-pago/reconciliation`) usa `getReconciliationForRun`, que lê `listMpPaymentsWithChargesTotalByRun(run.id)`.

Num run antigo cujos `mp_payments` foram limpos (nenhum import retido aponta para ele), essa tela passa a mostrar **0 payments**. Os settlement reports e movements do run continuam, então os movimentos aparecem sem payment vinculado.

A leitura da Central e do período (`/read/mercado-pago/reconciliation`, MP3) não muda, porque usa só os runs dos imports selecionados, e esses nunca são limpos. Para auditar um run antigo, rode o dry-run antes (`--json` lista `mp.elegiveis`) ou use `--sem-mp`.

### Referências protegidas

Busca feita com `grep -a` em `server/` e `Portal/` (out/2026). A extração é genérica em JSONB, em qualquer profundidade, pelas chaves `importId`, `importIds[]`, `centralImportIds[]` e `import_id`.

| Fonte | Onde | Protege |
|---|---|---|
| `painel_contas_snapshot` | `cliente_360_resumos_mensais.payload_json.centralVendas.contas[].importId` (lido por `painelContasRepository` como `centralImportIds`) | sim |
| `cliente360_sync_job` | `cliente_360_sync_jobs.payload_json.importIds[]`. Só auditoria: nenhum leitor do campo. | **não**, por padrão; protege só com `--proteger-auditoria-sync-jobs` (opt-in) |
| `entregas_cliente` | `payload_json`. Hoje nada grava importId ali; é varrido por garantia. | sim |
| `margin_snapshot_*`, `sentinel_*`, `fechamento_incidentes`, `financeiro_ads_cache` | não têm coluna nem campo de import | n/a |

### Decisão: a auditoria do job do Cliente 360 não protege (29/10/2026)

Medição em produção (somente leitura), feita pelo Maestro:

- 1.248 jobs em `cliente_360_sync_jobs` citam 1.304 imports, com 614.340 pedidos.
- Isso é ≈ 79% do que a retenção deve liberar.
- Nenhum leitor usa `payload_json.importIds`: só `finalizeSyncJob` escreve o campo (grep em `server/` e `Portal/`).

A linha do job continua existindo e continua sendo a auditoria. O import citado sair não quebra nenhuma leitura. Por isso essa fonte **não protege por padrão**; `--proteger-auditoria-sync-jobs` (opt-in) volta a proteger.

O dry-run continua lendo essa fonte de forma informativa. Ele reporta `citadosSoPorAuditoria`, com o total, a contagem por classe e os ids dos imports do escopo citados só por ela. O snapshot do Painel (`centralImportIds`) e `entregas_cliente` continuam protegendo.

## Flags e política

| Env | Padrão | Arg do CLI |
|---|---|---|
| `CENTRAL_VENDAS_RETENCAO_MIN_IDADE_HORAS` | 72 | `--min-idade-horas=` |
| `CENTRAL_VENDAS_RETENCAO_MANTER_ULTIMOS` | 1 | `--manter-ultimos=` |
| `CENTRAL_VENDAS_RETENCAO_INCLUIR_LEGACY` | true | `--sem-legacy` |
| `CENTRAL_VENDAS_RETENCAO_INCLUIR_CANDIDATES` | true | `--sem-candidates` |
| `CENTRAL_VENDAS_RETENCAO_INCLUIR_MP_PAYMENTS` | true | `--sem-mp` |
| `CENTRAL_VENDAS_RETENCAO_APPLY` | ausente (recusa apply) | necessário junto com `--apply` |
| `CENTRAL_VENDAS_RETENCAO_AUTO` | ausente (desligado) | n/a |

Um valor inválido cai no padrão, nunca numa política mais agressiva. **Piso do apply**: `minIdadeHoras` ≥ 24; abaixo disso o apply é recusado com `MIN_IDADE_ABAIXO_DO_PISO` (o dry-run aceita qualquer valor).

## Como rodar

O CLI não lê `server/.env`; o banco vem só do `DATABASE_URL` do shell. O host é impresso antes de qualquer query.

```bash
# DRY-RUN (padrão): só SELECT, numa transação READ ONLY
DATABASE_URL=... node server/scripts/central-vendas-retencao.js
DATABASE_URL=... node server/scripts/central-vendas-retencao.js --conta=41 --json > plano.json
DATABASE_URL=... node server/scripts/central-vendas-retencao.js --cliente=red_fish --sem-estimativa

# APLICAR: exige as 3 travas; comece pequeno e com backup lógico
CENTRAL_VENDAS_RETENCAO_APPLY=true DATABASE_URL=... node server/scripts/central-vendas-retencao.js \
  --apply --confirm-host=<host> --conta=41 --limite-lotes=5 --export-dir=$HOME/venforce-backups/retencao/$(date +%F)
```

- Escopo: `--conta=<id>`, `--conta=legado` (`cliente_conta_id IS NULL`) e `--cliente=<slug>`.
- Execução: `--tamanho-lote=20`, `--limite-lotes=N` e `--limite-minutos=15`.
- Ctrl+C termina depois do lote corrente. Um segundo Ctrl+C sai na hora, e o servidor desfaz a transação em voo.
- Códigos de saída: `0` ok, `1` erro (inclusive erro num lote), `2` argumento inválido ou sem `DATABASE_URL`, `3` apply recusado.

## Como o apply é feito (executor)

1. **Gate**, antes de qualquer query: `--apply`, `CENTRAL_VENDAS_RETENCAO_APPLY=true` e host local ou `--confirm-host` igual ao host, no mesmo padrão do `sentinel-run-once.js`.
2. **Plano** numa transação READ ONLY.
3. **Lotes de imports**, cada um numa transação curta com `statement_timeout` e `lock_timeout`:
   1. `SELECT … FOR UPDATE NOWAIT` em todas as linhas de cada tupla do lote.
   2. Releitura de runs e refs.
   3. Replanejamento da tupla.
   4. `DELETE` só dos ids que continuam elegíveis.

   **Lock**: o sync e a publicação não usam advisory lock por tupla. A publicação (`promoverCandidatesDoRun`) é um UPDATE atômico que trava as linhas candidate, e o FOR UPDATE nas linhas da tupla serializa contra ele. Com NOWAIT a retenção nunca espera: se a tupla estiver ocupada, o lote é adiado para a próxima execução. Assim a retenção nunca participa de um ciclo de espera em que o detector de deadlock poderia abortar a publicação.
4. **mp_payments**: um run por transação. O run é travado (`FOR UPDATE NOWAIT`) e o executor confere se é terminal e antigo e se nenhum import ainda aponta para ele. Só então faz `DELETE … WHERE sync_run_id`.
5. **Idempotência**: cada execução replaneja do zero. Sem mudança de estado, a seguinte remove 0.

## Retenção automática (prevenção)

Com `CENTRAL_VENDAS_RETENCAO_AUTO=true`, o worker de sync roda o executor depois de um `publicarRun` bem-sucedido, só para as tuplas dos imports publicados:

- Roda agendado (`setImmediate`), fora do caminho da publicação.
- Usa a mesma política do env, então com 72 h saem só substituídos há mais de 3 dias.
- Nunca lança: erro vira log.

Proteções do pool do servidor:

- **Fila single-flight por processo**: no máximo uma retenção rodando. Uma publicação durante a execução só acrescenta seus imports ao conjunto pendente, que a mesma tarefa drena em seguida, com as tuplas deduplicadas.
- **Pool com espera** (`pool.waitingCount > 0`): a rodada é pulada com o log `adiada: pool com espera`. Os pendentes ficam para a próxima publicação.
- `statement_timeout` de 15 s e `lock_timeout` de 2 s, também no **planejamento** (o CLI usa 300 s e 5 s).
- No máximo 10 lotes e 2 min por tupla, com `limiteTempoMs` checado entre as etapas (plano → lotes → mp).

Sem a flag, nada acontece (há teste). Esse modo não exige `CENTRAL_VENDAS_RETENCAO_APPLY` nem `--confirm-host`: a própria flag é o opt-in.

## Espaço

O relatório estima, por classe e por (conta, competência): média de `pg_column_size` da linha (amostra `TABLESAMPLE`) × linhas, mais os índices da tabela proporcionais às linhas (`reltuples`). Em tabela minúscula ou sem `ANALYZE`, a parte de índices fica superestimada.

**DELETE não encolhe o banco.** O espaço volta para **reuso** dentro das mesmas tabelas e índices depois do (auto)vacuum, o que freia o crescimento. Para devolver espaço ao disco é preciso `VACUUM FULL` (lock exclusivo) ou `pg_repack`, em janela própria.

## Rollback

**Não há rollback.** O dado removido só volta reprocessando o sync do período, ou restaurando de backup. Por isso:

- Sempre rode o dry-run antes e revise o plano (`--json`).
- No apply, use `--export-dir=<dir>`. Para cada lote, antes do DELETE e dentro da mesma transação, ficam gravados `lote-NNNN-{imports,pedidos,itens,componentes}.csv` com todas as colunas. É backup lógico para auditoria ou reimportação manual; os mp_payments não são exportados.
- Comece com `--conta=` e `--limite-lotes=` pequenos.

## Testes

- `tests/centralVendasRetencaoPlanner.test.js`: regras e propriedade. Puro, sempre roda.
- `tests/centralVendasRetencaoPostgres.test.js`: integração em PG real (dry-run não escreve, recusas, órfãos, re-avaliação concorrente, idempotência, lock, export, mp, hook).
- `tests/centralVendasRetencaoContratoPainel.test.js`: contrato do Painel (snapshot só vale com os vigentes ao vivo; pedidos e composição só pela seleção ao vivo). Sem banco.
- `tests/centralVendasRetencaoAuto.test.js`: fila single-flight, pool com espera e timeouts do modo automático. Sem banco.
- `tests/centralVendasRetencaoVolume.test.js`: 30 syncs × 500 pedidos. Sem retenção a tupla vai a 30 imports e 15.000 pedidos; com retenção fica em 2 imports e 1.000 pedidos.

Os dois testes de PG pulam sem `CENTRAL_VENDAS_RETENCAO_TEST_DATABASE_URL` e recusam host não local:

```bash
CENTRAL_VENDAS_RETENCAO_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57651/postgres node server/tests/centralVendasRetencaoPostgres.test.js
```
