# Handoff S1.5: automação do Billing e observabilidade do Sentinel

- **Branch:** `feat/sentinel-s15-automacao-observabilidade`, no worktree `wt-sentinel-s15`, a partir da `origin/main` `b32f4d89` (PR #420).
- **Estado:** commits **locais**, sem push, PR, deploy, mudança no Render ou migration.
- **Contrato técnico compartilhado:** `docs/sentinel/CONTRATO_S1_5_OPERACAO.md`.

Legenda usada no documento: **[medido]** = dado real lido do Render ou do banco (só leitura); **[log]** = log do Render; **[inferido]** = dedução a partir do código ou dos dados; **[simulado]** = teste local; **[pendente]** = depende de ativação ou autorização.

---

## A. Ambiente real (Render e PostgreSQL, somente leitura, 19/11/2026)

### A.1 Worker `venforce-sentinel` (srv-dbh28b9srm7s73f26v9g)
- **Configuração [medido]:** plano 0,5 CPU / 512 MB, start `node workers/sentinelWorker.js`, rootDir `server`, **deploy automático em commits da `main`**.
- **Deploys [medido]:** 10 deploys em 7 dias. Todo merge na `main` reinicia o worker, inclusive os que não são do Sentinel (#418, #419, #421). Por isso a agenda do Billing **precisa** sobreviver a reinícios; caso contrário, cada deploy dispararia uma execução.
- **Memória [medido]:** de 80 a 147 MB por instância, com platô de cerca de 145 MB (28% do limite). Não houve OOM.
- **CPU [medido]:** média de 0,001 a 0,002 em 0,5 disponível.
- **Ciclos [log]:** a cada cerca de 3 min, com duração de 4 a 10 s. Por ciclo, cerca de 60 a 160 pedidos e 70 a 90 chamadas ao ML:

  | Conta | Chamadas ao ML por ciclo |
  |---|---|
  | 86 | 48 a 65 |
  | 41 | 16 a 21 |
  | 3 | 2 a 3 |

  **[inferido]** Isso dá cerca de 25 a 40 mil chamadas por dia só no polling.
- **Erros reais em 14 dias de log [log]:**
  - 2× `SENTINEL_ORDERS_HTTP_ERROR: Orders API respondeu HTTP 403` na conta 86 (15/11 e 17/11). O atraso chegou a cerca de 190 s e a conta se recuperou sozinha no ciclo seguinte.
  - 2× `SENTINEL_TRUNCATED` na conta 86 (17/11), quando um pico de volume passou do teto de páginas da janela mínima. Recuperou-se sozinho.
  - 1× timeout (`This operation was aborted`) em `/packs` (19/11).
  - 1× "ciclo pulado: outro ciclo detém o advisory lock" (12/11), na sobreposição de deploy. É o comportamento esperado.
  - Nenhum 401, 429 ou quarentena. Nenhuma linha em `sentinel_pedido_excecoes`.
  - **Falha de observabilidade:** esses erros saem só com nível `info`, dentro de `erro=…`. Um filtro por nível `warning`/`error` no Render não encontra nenhum deles. Foi corrigido na linha nova `[sentinel-op]` (seção B).
- **Eventos do Render [medido]:** em 28/10, o dia da criação do serviço, houve cerca de 30 eventos `server_failed` com `earlyExit:true` em cerca de 2 h, ou seja, um loop de reinício. **Um Background Worker que termina o processo é reiniciado em loop.** Com tudo desligado, o worker atual faz exatamente isso (`exit 0`). Foi corrigido: no Render, o processo fica ocioso em vez de sair (seção B).
- **Sobreposição de deploy [log]:** durante cerca de 2 min rodam duas instâncias. Os ciclos se alternam pelo advisory lock e a instância antiga recebe SIGTERM e encerra limpa.

### A.2 PostgreSQL (dpg-d75ce3cr85hc73f2r490-a)
- **Uso [medido]:** de 1 a 3 conexões ativas nas amostras de 12 h e cerca de 350 MB de memória, com um pico de 533 MB em 16/11.
- **Tabelas do Sentinel [medido]:** somam menos de 2,2 MB.

  | Tabela | Linhas | Tamanho |
  |---|---|---|
  | `sentinel_pedidos` | 2.325 | 1,6 MB |
  | `sentinel_conciliacao_comissao` | 6 | 64 kB |

- **`sentinel_conciliacao_controle` [medido]:** vazia, ou seja, nunca houve pausa por 429.
- **Marcador da 20261119 [medido]:** presente.
- **Checkpoints [medido]:** as 3 contas estão em dia, com atraso de 0 a 11 s, `ciclos_sem_progresso = 0` e `ultimo_erro` nulo.
- **Incidentes abertos [medido]:**
  - conta 41: 1 `margem_negativa`;
  - conta 86: 10 `margem_negativa` e 3 `custo_pendente`.
- **Grants [medido]:** como o polling funciona nas três contas, os grants funcionam. Não foram lidos tokens. A tabela `ml_tokens` oferece `token_status`, `refresh_failures`, `last_refresh_error_at` e `expires_at` para a leitura operacional.

## B. Resultados reais do piloto (6 pedidos, 9 chamadas)

| Conta | Pedido | Idade | Estado | Coleta | Leitura |
|---|---|---|---|---|---|
| 3 | …4020 | 29,95 d | TARIFA_LIQUIDA_COMPROVADA | reconsultar 20/11 | tarifa R$ 16,10 = CVVML + CVVPRC; desconto bancado pelo vendedor; **documento em processamento** |
| 3 | …0902 | 29,77 d | TARIFA_LIQUIDA_COMPROVADA | reconsultar 20/11 | igual ao anterior: R$ 14,42 |
| 41 | …7638 | 30,01 d | NAO_CONCILIADO | concluída | **cupom** (vendedor R$ 2,00) mais desconto `sale_fee`; rebate R$ 2,19; documento definitivo; fora do escopo provado no S1-A |
| 41 | …3386 | 30,01 d | NAO_CONCILIADO | concluída | **cupom e cashback**; rebate R$ 0,75; documento definitivo; fora do escopo |
| 86 | …1304 | 29,98 d | NAO_CONCILIADO | concluída | a tarifa **bate** (R$ 12,25 = gross = net = cobranças), mas há um cupom **bancado pelo ML** (vendedor R$ 0,00, total R$ 11,37), e cupom está fora do contrato S1. Documento em processamento. **É limitação de escopo, não divergência.** |
| 86 | …0102 | 29,97 d | NAO_CONCILIADO | reconsultar 20/11 05:19 | ver abaixo |

**Detalhe do pedido …0102 da conta 86:**
- A comissão oficial é R$ 24,68, igual a gross e net.
- As cobranças reconhecidas como tarifa são CVVML R$ 17,21 + CVVPRC R$ 3,57 = R$ 20,78.
- A diferença de **R$ 3,90 é uma cobrança `CVVFN`**, que o conciliador ainda **não reconhece** como subtipo de tarifa (`subtipo_cobranca_desconhecido` e `cobrancas_nao_somam_net`). Na conta 41 aparece um `CVVFNU`, que é reconhecido.
- `/discounts` respondeu 404 (marcador `indisponivel_http`) e o documento está em processamento.
- **[inferido]** `CVVFN` provavelmente é o custo fixo por unidade. Validar com a documentação do ML antes de mexer no contrato (S1 v2). **Nesta missão o motor financeiro não foi alterado.**

**Classificação do piloto:**
- 2 tarifas comprovadas, ambas com documento provisório;
- 3 limitações de escopo (cupom ou cashback);
- 1 limitação de contrato (subtipo `CVVFN`) somada a uma pendência documental;
- **nenhuma divergência** e nenhuma falha de coleta.

### B.1 Defeito real de seleção descoberto pelo piloto
**[medido]** Os 6 pedidos tinham **de 29,8 a 30,0 dias**. A ordenação antiga (`COALESCE(proxima_tentativa_em, data_pedido) ASC`) gastava o orçamento nos pedidos **mais antigos** da janela de 30 dias. Consequências:
- as 3 reconsultas agendadas (contas 3 e 86) **nunca aconteceriam**, porque os pedidos saem da janela antes da data;
- uma hora depois do piloto, a conta 41 já aparecia com 0 pedidos consultados dentro da janela;
- com o backlog atual de 814 elegíveis na conta 86, as reconsultas vencidas ficariam sempre atrás de pedidos antigos nunca consultados (inanição).

Foi corrigido na seção C.

### B.2 Cobertura (consulta leve, 19/11 cerca de 17:30Z)

| Conta | Pedidos em 30 d | Elegíveis (≥ 6 h) | Consultados na janela | Novos elegíveis por dia (7 d) | Fora do escopo (qtd > 1) |
|---|---:|---:|---:|---:|---:|
| 3 | 45 | 38 | 2 | 2,6 | 0 |
| 41 | 325 | 289 | 0 | 8,6 | 14 |
| 86 | 1010 | 814 | 2 | 67,3 | 4 |

Nenhum pedido tem mais de um item. Cobertura de consulta **não é** acurácia financeira.

## C. O que foi implementado

### C.1 Arquitetura escolhida: mesmo processo, dois agendamentos independentes (Alternativa B)
O worker já contratado (`node workers/sentinelWorker.js`, **start command inalterado**) passa a ter dois agendamentos:

| | Polling (sem mudança de lógica) | Billing agendado (novo, desligado) |
|---|---|---|
| Ativação | `SENTINEL_WORKER_ENABLED` + `SENTINEL_CONTAS_ALLOWLIST` | `SENTINEL_CONCILIACAO_AGENDADA_ENABLED=true` + `SENTINEL_CONCILIACAO_CONTAS`. É uma flag **dedicada**, então nenhuma variável antiga liga o Billing no deploy. A allowlist é própria e nunca herda a do polling. |
| Timer | 180 s, como hoje | `SENTINEL_CONCILIACAO_INTERVAL_MS` (padrão 6 h, mínimo 10 min) |
| Pool | próprio, `SENTINEL_DB_POOL_MAX` (2) + 1 conexão do lock | **próprio**, `SENTINEL_CONCILIACAO_DB_POOL_MAX` (1) + 1 conexão do lock. Não disputa o pool do polling. |
| Lock | `vf:sentinel:polling` | `vf:sentinel:conciliacao` |
| Orçamento ML | `SENTINEL_MAX_CHAMADAS_POR_CONTA` | por execução (20) e por conta (8), com prazo (120 s), intervalo entre chamadas (1 s) e pausa **global** por 429, inclusive o 429 embrulhado em 400 |
| Agenda | — | `billing_agenda.pausado_ate` em `sentinel_conciliacao_controle`, **relida dentro do lock**. Sobrevive a deploys e reinícios e nunca roda duas vezes na mesma janela entre instâncias. |

**Regras de convivência:**
- **Sem disputa de ciclo.** O polling nunca espera o Billing. O Billing espera o fim de um ciclo de polling em curso no mesmo processo por até `SENTINEL_CONCILIACAO_ADIAR_MAX_MS` (120 s) e depois executa mesmo assim, sem adiamento infinito.
- **Falha do Billing.** Exceção, 5xx, 429 ou banco fora não param o polling. A próxima tentativa fica em 10 min no erro e em 5 min com lock ocupado.
- **Falha do polling.** O Billing segue, e o heartbeat mostra `falhasSeguidas` e `falhaBoot`.
- **Boot do polling que falha com o Billing ligado:** retentado a cada 5 min.
- **SIGTERM e SIGINT** têm um handler único. Ele:
  - para os timers;
  - deixa o polling terminar a conta corrente;
  - faz o Billing parar **entre chamadas ao ML** (nova parada `parada_solicitada`, sem gravar falha nos pedidos);
  - grava o heartbeat `encerramento:"limpo"` com teto de 5 s;
  - fecha os **dois** pools.

  Em teste, isso encerrou em cerca de 140 ms. O Render dá cerca de 30 s até o SIGKILL.
- **SIGTERM no meio do Billing** (deploy): retoma em `min(intervalo, 10 min)` e **não** conta como falha. Isso foi corrigido na integração, porque antes empurrava a fila 6 h.
- **No Render, o processo nunca termina sozinho.** Com tudo OFF, fica **ocioso**, com 1 log por hora. Se o boot falha (banco fora no deploy), o `main` **retenta a cada 5 min**. A correção na integração evitou o polling parado até o próximo deploy. Fora do Render, o comportamento é o de sempre: `exit 0` com tudo OFF e `exit 1` em falha de boot.

### C.2 Seleção do coletor (corrige B.1)
A ordem passou a ser por prioridade. A prioridade decide quem é consultado primeiro, não o resultado:

| Tier | O que entra |
|---|---|
| **0** | já conciliado, com descontos em cache e reprocessamento devido (custa cerca de 0 chamada extra) |
| **1** | nunca consultado e citado por incidente aberto, reaberto ou reconhecido |
| **2** | nunca consultado, ou primeira consulta que falhou, **do mais recente para o mais antigo** |
| **3** | reprocessamento devido sem descontos em cache |
| **4** | esgotada, com a retentativa longa vencida |

- **Janela de reconsulta.** `SENTINEL_CONCILIACAO_JANELA_RECONSULTA_DIAS` (60, nunca abaixo de 30) mantém reconsultar, falha e esgotada elegíveis depois dos 30 d da primeira consulta. Assim, o documento provisório de um pedido com cerca de 30 dias passa a ser de fato reconsultado.
- **Rotação de contas.** A conta com a conciliação gravada mais antiga vai primeiro, então o orçamento global não penaliza sempre a última conta da lista.
- **Nada é descartado em silêncio.** O que sai da janela sem consulta aparece em `sairamDaJanelaSemConsulta7d` e no sinal `cobertura_perdida`.

### C.3 Observabilidade
- **Linha `[sentinel-op]` por ciclo de polling e por execução do Billing.**
  - É JSON compacto com tarefa, execução, início, duração, chamadas, pedidos, gravados, resultado e, por conta, parada e código de erro curto (ex.: `SENTINEL_ORDERS_HTTP_ERROR:403`).
  - É sanitizada: sem URL, token, e-mail ou payload.
  - Sai como **`warn`** quando há problema, o que corrige o caso A.1 em que os erros apareciam só como `info`.
  - As linhas antigas do polling foram mantidas.
- **Heartbeat `worker_processo`.** Uma linha única com instância, commit, pid, boots, memória (RSS e heap), estado do polling e do Billing e o dono anterior.
  - É atualizada a cada ciclo, a cada execução e a cada 3 min.
  - A posse é por instância: na sobreposição de deploy, só a instância nova escreve.
  - O UPDATE usa `CASE` para nunca aplicar o cast jsonb a outra chave, já que `billing_429` guarda texto puro.
- **`GET /sentinel/operacao`.** É somente leitura (`BEGIN … READ ONLY`, `statement_timeout` de 5 s), usa o mesmo gate do Sentinel e restringe os dados por conta à carteira. Ver `services/sentinel/sentinelOperacao.js`. Ela traz:

  | Bloco | Conteúdo |
  |---|---|
  | `worker` | vivo, atrasado, parado ou `sem_dados`; commit; boots; reinício inesperado (heurística: mesmo commit e anterior sem encerramento limpo); memória |
  | `polling` | reaproveita `resumoOperacional`; por conta: situação, atraso, ciclos sem progresso, quarentena e retentando |
  | `billing` | última execução (resultado, chamadas, gravados, por conta), próxima execução, falhas seguidas, pausa 429 |
  | `cobertura` (total e por conta) | monitorados, elegíveis, consultados, sem consulta, por estado e por status; NAO_CONCILIADO separado em **escopo**, **transitório** e **bloqueio**; documentos provisórios; reconsultas vencidas e fora da janela; saíram da janela sem consulta em 7 d; falhas; motivos mais frequentes; última conciliação |
  | `grant` por conta | ok, atenção, indisponível ou desconhecido, a partir de `ml_tokens`. Só colunas de status: nunca token nem o texto do erro. |
  | `sinais` (P2) | ver C.4 |

  Também traz `efeitoNaMargem:"nenhum"` e `alertasFinanceiros:"desligados"`.

### C.4 Sinais operacionais (P2)
Cada sinal traz tipo, conta, severidade, estado, motivo, evidência, `detectadoEm`, `dedupKey` (`tipo:conta|global`) e próxima ação. São calculados na leitura: sem tabela, sem envio externo e sem responsável inventado (só o squad do vínculo existente). **Nunca usam a severidade de incidente financeiro.**

| Sinal | Critério e severidade |
|---|---|
| `worker_sem_heartbeat` | média se atrasado (> 2× intervalo); crítica se parado (> 120 min); info se não há linha. Um worker anterior ao S1.5 não publica heartbeat e nunca aparece como "vivo". |
| `polling_parado` | regra do `resumoOperacional`; alta com ≥ 3 falhas seguidas ou `falhaBoot` |
| `conta_sem_progresso` | ciclos sem progresso ≥ 3, ou leitura atrasada pela regra existente |
| `grant_indisponivel` | alta |
| `pedidos_em_quarentena` | média |
| `custo_ausente` | info |
| `billing_pausado_429` | média; alta a partir de 3 ocorrências |
| `billing_falhas_seguidas` | alta, a partir de 2 |
| `billing_atrasado` | alta, quando a próxima execução está vencida há mais de min(2× intervalo, 1 h). Billing desligado nunca gera. |
| `reconsultas_vencidas_acumuladas` | vencidas há mais de 24 h |
| `reconsultas_fora_da_janela` | — |
| `cobertura_perdida` | — |
| `documento_provisorio_antigo` | mais de 45 d |
| `worker_reinicio_inesperado` | — |

### C.5 Recursos e PostgreSQL
- **Conexões:** no máximo 5 (polling 2 + lock 1, Billing 1 + lock 1), contra 3 hoje. A rota usa 1 conexão do pool do Portal por requisição.
- **Armazenamento novo:** **2 linhas de tamanho constante** (`worker_processo` e `billing_agenda`) na tabela que já existe. São atualizadas por UPDATE, sem histórico e sem evento por pedido. **Sem migration nova** e sem índice novo.
- **Lote:** até 60 pedidos com JSON compacto. Memória adicional esperada: poucos MB **[inferido]**, sobre o platô medido de cerca de 145 MB.

### C.6 Arquivos
| Arquivo | Mudança |
|---|---|
| `server/workers/sentinelWorker.js` | supervisor dos dois agendamentos, heartbeat, `[sentinel-op]`, modo ocioso e retentativa de boot no Render |
| `server/services/sentinel/sentinelAgendaBilling.js` | **novo**: agendador, gancho de agenda e heartbeat |
| `server/services/sentinel/sentinelConciliacaoColetor.js` | gancho `deps.agenda` dentro do lock, parada entre chamadas, rotação de contas |
| `server/services/sentinel/sentinelConciliacaoRepositorio.js` | `ELEGIBILIDADE_SQL` como fonte única, seleção por tiers, janela de reconsulta, ordenação de contas |
| `server/services/sentinel/sentinelOperacao.js` | **novo**: leitura consolidada e `avaliarSinais` |
| `server/controllers/sentinelController.js`, `server/routes/sentinelRoutes.js` | só o handler e a rota `GET /operacao` |
| `server/tests/sentinelWorkerAgendado.test.js`, `.postgres.cjs`, `sentinelOperacao.test.js`, `.postgres.cjs` | **novos** |
| `docs/sentinel/CONTRATO_S1_5_OPERACAO.md` | contrato entre runtime e leitura |

`sentinelPollingWorker.js` (lógica do polling), o conciliador financeiro, migrations, Portal, Central de Vendas, Central de Margem, Resgate e Anúncios: **não foram tocados**. O CLI `scripts/sentinel-conciliacao.js` e o worker standalone continuam funcionando.

### C.7 Execução multiagente, revisão e correções integradas
O trabalho foi dividido em três frentes, cada uma com arquivos exclusivos, e só o líder fez commits:

| Frente | Responsável | O que fez |
|---|---|---|
| Runtime | agente A | worker, agendador, coletor e repositório |
| Observabilidade | agente B | `sentinelOperacao`, rota e testes |
| Ambiente real e integração | líder | Render e banco em leitura, integração, correções e commits |

Depois houve uma revisão independente, só em leitura, focada em bloqueadores. O Codex não foi usado, porque trava na aprovação do sandbox. **Resultado: nenhum bloqueador.** Todos os achados foram corrigidos e cada um tem teste de regressão:

| # | Achado | Severidade | Correção |
|---|---|---|---|
| R1 | Falha por conta silenciosa: 403, token, 5xx e erro interno saíam como `concluida`, zeravam o contador e nenhum sinal disparava | ALTO | resultado `concluida_com_falhas`, que incrementa `ocorrencias`, e o sinal `billing_falhas_seguidas` dispara |
| R2 | O LIMIT de 60 era todo ocupado pelo tier 0 e nenhum pedido novo era consultado mesmo com orçamento sobrando | MÉDIO | **cota própria** de vagas para o tier 0 (ROW_NUMBER por partição) |
| R3 | Falso "reinício inesperado" em todo restart com o mesmo commit, inclusive troca de variável, e o "limpo" do dono antigo se perdia | MÉDIO | `anterior` preservado e marcado como limpo pelo dono antigo |
| R4 | O shutdown podia passar de 30 s (pool pendurado, chamada ao ML de até 30 s) | MÉDIO | tetos: 20 s para o trabalho, 5 s para o heartbeat e 3 s por pool. Abandonar é seguro: checkpoint por janela e gravação idempotente. |
| R5 | Id de conta em textos globais visíveis fora da carteira, e um fallback de serialização que perdia `instancia` | baixo | removidos |

Correções do líder na integração, antes da revisão:
- SIGTERM no meio do Billing empurrava a fila 6 h.
- O `motivo::jsonb` do UPDATE dependia da ordem de avaliação do planner; agora usa `CASE`.
- No Render, um boot que falhava deixava o polling parado até o próximo deploy; agora é retentado a cada 5 min.
- Uma primeira consulta que falhou ficava atrás de todo o backlog; agora entra no tier 2.

### C.8 Testes (locais: PostgreSQL 18 local e ML falso, sem produção)

| Suíte | Resultado |
|---|---|
| `node --test tests/sentinel*.test.js` | **255/255** |
| `sentinelWorkerAgendado.postgres` | **80 verificações** |
| `sentinelOperacao.postgres` | **54** |
| `sentinelConciliacao.postgres` | 95 |
| `sentinel.v0a` | 113 |
| `sentinelRotas` | 75 |
| `sentinel` | 24 |
| `sentinelEvidencia` | 59 |
| `sentinelRecalculoBase` | 56 |
| `sentinelFretePack` | 60 |
| `sentinelPurge` | 4 |
| `sentinelUnificacao` | 19 |
| `sentinelIncidentes` | falha no passo "persistência após restart" (57P01), **igual na base b32f4d89**: já existia antes |

**Cobertos:**
- 8 h simuladas de polling e Billing;
- polling ligado com Billing desligado;
- falha de um lado sem derrubar o outro;
- duas instâncias e dois agendadores ao mesmo tempo, com um único Billing por janela e nenhum polling duplicado (lock real);
- 429 e 429 embrulhado em 400;
- reinício que preserva a agenda e as tentativas;
- SIGTERM no meio do Billing;
- PG indisponível e recuperação;
- orçamento global e por conta ao longo de várias execuções, com rotação;
- grant expirado e 401;
- 403;
- nenhum timer, pool ou listener órfão;
- schema 20261119 sem migration nova;
- margem oficial e checkpoints intactos;
- rota somente leitura (hash de 8 tabelas antes e depois) e sem campos sensíveis.

**Não cobertos:**
- o `executarCiclo` **real** do polling rodando junto com o Billing (o polling dos testes conjuntos é um falso que disputa o lock real; o polling real continua coberto pelas suítes v0a e `sentinel`);
- queda real do servidor PG (foi simulada por proxy);
- tempo real longo;
- qualquer coisa no Render ou no ML real.

## D. Capacidade operacional

Medidas reais estão em A e B. **O resto desta seção é projeção.**

**Custo por pedido novo:** 1 chamada a `/discounts` mais uma fração de uma chamada ao Billing, que aceita até 60 pedidos por lote. Reconsultas com descontos em cache custam cerca de 1/60 de chamada.

| Configuração | Chamadas ao ML por dia (teto) | Pedidos novos por dia (teto) | Demanda real |
|---|---|---|---|
| **Conservadora** (6 h, 20 por execução, 8 por conta) | 80 | cerca de 68 (cerca de 17 por execução) | **cerca de 78 novos/dia**, dos quais 67 na conta 86 |
| **Recomendada após o piloto** (1 h, 20 por execução, 12 por conta) | 480; consumo real deve convergir para 110–150 | cerca de 260 por conta | backlog atual (cerca de 1.100 na janela) zerado em cerca de 4 dias, depois só o fluxo novo |

- **Configuração conservadora:** **não acompanha** a conta 86. O backlog dela cresce, mas a ordem por recência mantém os pedidos novos cobertos e a perda fica visível em `cobertura_perdida`.
- **Comparação com o polling:** o polling já faz cerca de 25 a 40 mil chamadas por dia, então o Billing acrescenta **de 0,3% a 1,5%** sobre ele.
- **Quando o ML limita (429, ou 400 com 429 no corpo):**
  - nenhuma chamada nova na execução;
  - pausa **global** persistida, com Retry-After e backoff exponencial até 24 h;
  - a agenda respeita a pausa;
  - **o polling não é afetado**.
- **PostgreSQL:** cerca de 1 linha por pedido elegível (1 a 2 kB) dá cerca de 80 linhas por dia, ou cerca de 30 a 60 MB por ano. O S1.5 em si é constante. A retenção das conciliações segue a de `sentinel_pedidos`, por FK com CASCADE. Hoje **não há retenção automática** para nenhuma das duas, e essa é uma pendência fora desta missão.
- **Instância de 512 MB:** o Billing roda no máximo 120 s, de forma sequencial, com 1 conexão. O impacto esperado é baixo em CPU, que hoje está em cerca de 0,4% do limite, e em memória.

## E. Painel de acompanhamento
**Já implementado no backend:** `GET /sentinel/operacao`, com os campos de C.3. A origem de cada dado é:

| Bloco | Origem |
|---|---|
| `worker` | heartbeat (`sentinel_conciliacao_controle.worker_processo`) |
| `polling` | `sentinel_checkpoints`, `sentinel_pedido_excecoes` e o `resumoOperacional` existente |
| `billing` | `billing_agenda` e `billing_429` |
| `cobertura` | `sentinel_pedidos` com `sentinel_conciliacao_comissao` |
| `grants` | colunas de status de `ml_tokens` |

Os sinais são derivados de tudo isso.

**Ainda vem só do Render** (não inventado no banco): CPU, memória da plataforma, eventos `server_failed` e OOM, e o histórico de logs. Consultar por logs com o filtro `[sentinel-op]` e nível `warning`.

**Exige frontend (não feito):**
- cartão Worker/Polling/Billing com a pausa 429;
- tabela por conta com cobertura e grant;
- lista de sinais por severidade;
- legenda das categorias de NAO_CONCILIADO.

## F. Publicação futura (nada disto foi executado)

1. **PR e merge.** O merge reimplanta o `venforce-sentinel` (deploy automático) **com o Billing desligado**. O polling continua igual, mais o heartbeat (1 UPDATE a cada 3 min) e a linha `[sentinel-op]`. O `venforce-server` precisa de **deploy manual** para publicar `GET /sentinel/operacao`.
2. **Verificação pós-merge, só em leitura.**
   - O log mostra `[sentinel-worker] ON — contas 41,86,3` e **não** mostra "Billing agendado ON".
   - `/sentinel/operacao` mostra `worker.estado = vivo` e `billing.habilitado = false`.
   - Os ciclos seguem a cada 3 min com `erro=-`.
3. **Configuração do Render para ativar** (cada mudança de variável reinicia o worker):
   - `SENTINEL_CONCILIACAO_AGENDADA_ENABLED=true`
   - `SENTINEL_CONCILIACAO_CONTAS=41`
   - Opcional, para começar conservador: `SENTINEL_CONCILIACAO_INTERVAL_MS=21600000`, `SENTINEL_CONCILIACAO_MAX_CHAMADAS_EXECUCAO=20`, `SENTINEL_CONCILIACAO_MAX_CHAMADAS_CONTA=8`.
4. **Ordem das contas:** **41** (validada no S1-A), depois **3** e por último **86** (maior volume). Esperar pelo menos 2 execuções limpas, sem 429, entre uma etapa e outra. Depois, se a cobertura da 86 pedir, mudar para a configuração recomendada em D.
5. **Monitoramento após cada etapa:**
   - `/sentinel/operacao`: `billing.ultimaExecucao.resultado = concluida`, `falhasSeguidas = 0`, `pausa429.ativa = false`, cobertura subindo e nenhum sinal alto ou crítico novo;
   - Render: nenhuma linha `[sentinel-op]` em `warning` repetida;
   - polling: atraso estável.
6. **Critérios objetivos de rollback do Billing.** Qualquer um destes dispara o rollback:
   - mais de uma pausa por 429 em 24 h;
   - `billing_falhas_seguidas` ≥ 2 com causa não transitória;
   - piora do polling depois da ativação: `falhasSeguidas` ≥ 3, atraso acima do limite ou quarentena nova;
   - memória acima de 400 MB;
   - execução abortada por lock perdido mais de uma vez.

   Um `DIVERGENTE` **não** é motivo de rollback: vai para revisão manual e não significa prejuízo.
7. **Desligar só o Billing:** tirar `SENTINEL_CONCILIACAO_AGENDADA_ENABLED` ou colocar `false`. O worker reinicia, e o **polling segue igual**. Para desfazer tudo, reverter o merge, o que reimplanta o worker anterior.
8. **Veredito:** ver o relatório final.
