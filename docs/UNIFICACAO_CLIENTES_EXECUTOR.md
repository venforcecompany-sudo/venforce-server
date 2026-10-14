# Unificação de Clientes — executor backend v1

PR de revisão: [#260](https://github.com/venforcecompany-sudo/venforce-server/pull/260),
base stacked #254.

Implementação para revisão e homologação; não habilitada em produção. Sem UI,
merge, deploy ou acesso ao banco de produção nesta etapa. A migration foi
aplicada apenas em PostgreSQL **local descartável com dados sintéticos**.

## 1. Base e arquitetura

Branch `feat/clientes-unificacao-executor-stacked`, baseada em
`feat/unificacao-clientes-fase2-stacked` no SHA
`fe100d97d8b331e4f55bbf633120d679c21dd7a7` (#254). #246, #251, #252,
#253 e #254 estavam abertos após fetch; seus refs não foram reescritos.
A pilha deverá ser rebaseada e revisada depois dos merges da fundação.

`server/services/clientesUnificacao/` contém o domínio, contratos, políticas,
repository, executor e rollback. A CLI importa o mesmo `planner.buildPlan`
usado pela API. Manifesto **v1** utiliza o mesmo algoritmo/hash/validator em
`--plan`, `--validate`, preview e revalidação do execute. A CLI continua
**offline**, sem modo execute/apply/commit.

O contrato anterior, sem `schemaVersion`, continua aceito exclusivamente como
perfil de compatibilidade read-only em `snapshotPlanner`, movido do #254.
Preserva suas validações, saídas, estados de migração e rollback offline;
**não é aceito pelo executor**. Não transforma aprovação de ensaio do #254
em autorização de escrita. Há um único executor e um único caminho de
aplicação/reversão por PK; não se importou executor da branch histórica.

O snapshot v1 usa catálogo estruturado de PKs/FKs/índices e projeções seguras
obtidas pelo repository. É diferente da fotografia agregada histórica v0.
Não adaptar estimativas ou amostras como se fossem linhas completas.

## 2. Manifesto versionado e normalização

[Schema](../server/services/clientesUnificacao/manifest.schema.json) e
[exemplo sintético não aprovado](../server/scripts/unificacaoClientes/manifest-v1.example.json).
A implementação do normalizador/validator é a autoridade semântica.

```json
{
  "schemaVersion": 1,
  "clienteCanonicoId": 1001,
  "clientesLegadosIds": [1002],
  "decisoes": {
    "primaryAccounts": {"meli": 12002},
    "primaryGrantId": 13002,
    "referencias": {}
  },
  "aprovacao": {
    "aprovada": false,
    "aprovadorUserId": null,
    "evidencia": "EXEMPLO-SINTETICO-SEM-APROVACAO"
  }
}
```

IDs acima são exemplos fictícios. O manifesto escolhe explicitamente Cliente
canônico e todos os legados. Todas as operações desses legados são movidas;
não é reassociação parcial de uma Conta. Não deduplicar duas Contas/sellers.
IDs positivos inteiros até int32; até 20 legados; sem duplicidades, origem igual
ao destino ou propriedades desconhecidas. Ordem de legados é normalizada.

Aprovação empresarial é externa/humana: `aprovada=true`, ID do aprovador e
referência documental curta são obrigatórios para zero blockers. O backend
registra essa declaração; não autentica CNPJ/contrato nem comprova a empresa
por nome/seller/score. Admin autenticado é o solicitante e confirmador; body
não pode falsificar os campos de ator do ledger.

Conflito de `is_primary` exige Conta ativa explícita por marketplace; Grant
principal tem decisão própria `primaryGrantId`, pois sua UNIQUE é por Cliente.
Sem decisão, blocker. Nunca escolher por ID, data, principal do destino ou
primeira linha. Preferências participantes são neutralizadas e reaplicadas
**dentro da transação**, para evitar colisões temporárias nos dois sentidos.

## 3. Planner, validator e referências

Reutiliza `checkAccountContext` da fundação. Confere owner/marketplace/seller,
Grants exatos e vínculos de Base, incluindo dados históricos/inativos e
Grants NULL exatos sem backfill. Base NULL permanece blocker. Conta manual
sem Base pode ter warning; nenhuma Base é inventada. Preserva Conta ID,
external, seller, Grant ID/Conta e Base ID/Conta; tokens não são consultados.

Categorias registradas em `references.js`:

| Categoria | Aplicação v1 |
|---|---|
| MOVE_TO_CANONICAL | Identidades redundantes de tabelas conhecidas: Conta, Grant, vínculo de Base, catálogo, snapshots, manual Painel, Ads, entregas/Fechamento, relatórios, Design e outros cadastros. Mantém valores, arquivos e payloads intactos. |
| KEEP_AS_LEGACY_ORIGIN | Histórico de Squad/responsáveis/Seller, callbacks e scans. Origem continua registrada e consultável pelo mapping, sem união de ACL. |
| ACCOUNT_ALREADY_AUTHORITATIVE | Custos/UserBases por Base, versões e itens por artefato/run; seguem IDs preservados e não são reescritos. |
| DERIVED_REBUILDABLE | Vocabulário reservado. Não há rebuild nem override para liberar uma família não suportada. |
| BLOCKED_UNKNOWN | Central com dados, família desconhecida, cobertura incompleta, trigger/custom CHECK/exclusion/UNIQUE não modelados. Impede execute. |

Fechamento não foi refatorado: planner classifica/move exclusivamente
identidade relacional/slug conhecida, preservando incidentes, arquivos e
valores. JSON/texto livre permanece intacto, sem inferência de empresa ou
substituição textual. Consumidores externos/embutidos precisam de homologação
e contrato de lookup; aprovação no manifesto não certifica esses consumidores.

FKs são percorridas transitivamente para incluir dependências indiretas.
Projeções contêm identidade, PK/FK, chaves UNIQUE, atividade/status e `xmin`;
excluem credenciais, API keys, payloads e blobs. Cada tabela tem limite de
5.000 linhas: exceder, não conseguir determinar escopo ou descobrir ciclo de
FK não suportado bloqueia. Núcleo usa projeções limitadas do catálogo para
checar seller compartilhado fora do lote. Não faz varredura ilimitada de
milhões de componentes.

Índices UNIQUE reais com chaves simples são simulados no estado virtual,
considerando NULL e predicados suportados. Cobre external/principal/Grant,
Squad preservado, Seller ACL preservada, manual, snapshots, Ads e PK comercial
por Cliente. Expressão/predicado desconhecido afetado é blocker, nunca waiver
por declaração humana. Constraints do PostgreSQL são a defesa final.

## 4. Blockers e warnings

Blockers incluem `SQUAD_MISMATCH`, `SELLER_AMBIGUOUS`, `GRANT_AMBIGUOUS`,
`BASE_AMBIGUOUS`, `ACCOUNT_OWNER_MISMATCH`, `MARKETPLACE_MISMATCH`,
`UNIQUE_COLLISION`, `CLIENT_ALREADY_MERGED`, `MERGE_CYCLE`,
`ORIGIN_EQUALS_TARGET`, `TARGET_INVALID`, `ACCOUNT_CONTEXT_AMBIGUOUS`,
`UNKNOWN_CRITICAL_REFERENCE`, aprovação ausente, ACL divergente,
preferência inválida e job conhecido em queued/running/aplicando/executing.

V1 exige exatamente o mesmo Squad efetivo ativo. Não transfere Squad e não
une responsáveis, direitos externos ou UserBases. ACL ativa de responsáveis
e Seller deve equivaler entre Clientes; divergência bloqueia.

Warnings: operação sem Base e estado de Grant que não foi validado online.
Não são permissões para fallback. Não há HTTP/refresh/OAuth na unificação.

**Central de Vendas:** qualquer linha da família no escopo vira blocker,
inclusive histórico do destino. As leituras atuais usam redundâncias
Cliente/slug/run/import; mover apenas Conta quebraria filtros. Resolver isso
exige trabalho próprio, preservando scheduler/recovery/imports/publication.
Nenhum arquivo da Central/P0/pool foi alterado. O motor fica funcional para
lotes comprovadamente sem esse blocker; não declara o piloto real liberado.

## 5. Preview e planHash

`POST /admin/clientes-unificacao/preview` recebe `{manifest}`. Snapshot em
REPEATABLE READ READ ONLY; zero escrita funcional de unificação. Depois da
leitura registra activity de preview/block, sem snapshot nominal no log.

Retorna manifesto normalizado, `planHash`, `validationReady`, `canExecute`,
blockers/warnings/info, canônico/legados, Contas, Grants sem credenciais,
Bases, Squad, responsáveis, impactos, decisões pendentes e confirmação.
`canExecute` também considera a flag; `validationReady` distingue estrutura
válida de flag OFF. `productionReady` é false: homologação e autorização de
produção não são automatizadas por validade estrutural.

SHA-256 de representação canônica do plano, decisões, catálogo e estado
material. Arrays sem ordem material são ordenados; Date vira ISO, IDs de
legados são ordenados; hora da requisição não participa. `xmin` detecta
escritas posteriores, inclusive financeiras/refresh sem expor seu conteúdo.
Mudança relevante no manifesto, dados, aprovação ou catálogo muda o hash.
Outra carteira sem seller/relacionamento compartilhado não invalida o plano.

Execute recalcula antes e sob locks. Divergência: **409 MERGE_PLAN_CHANGED**.
Não aceitar plano SQL, before/after ou rollback fornecido pelo cliente.

## 6. Ledger, eventos e mapping

Migration de infraestrutura:
`server/sql/migrations/20261014_clientes_unificacao_executor.sql`.
Aplicação manual futura em cópia/homologação. Não é chamada no boot.
Sem backfill, merge, movimentação, purge ou alteração de preferências.

`cliente_unificacoes` registra operation key UUID, schema, manifesto/plano/
validação, hash, chave de idempotência, atores, before/after, reversão,
status, códigos seguros e timestamps. `cliente_unificacao_events` registra
trilha append-only. Triggers protegem intenção/snapshots/timestamps, deleção,
TRUNCATE e eventos, permitindo apenas transições previstas. Não substitui
controle de privilégios/backup contra superusuário do banco.

Estados suportados: planned, validated, blocked, executing, completed,
failed, rolled_back, rollback_failed. Preview usa activity log, sem criar
lote empresarial. Execute reserva `validated` com UNIQUE de idempotência;
executing/completed e snapshots participam da transação funcional.

Único mapping: `clientes.merged_into_cliente_id`, FK restritiva e CHECK
anti-self. Legado fica `ativo=false`; ID/nome/slug/created_at continuam.
`resolveCanonicalCliente` retorna Cliente normal ou canônico e origem;
limita profundidade e detecta ciclos. Rollback restaura atividade/mapping.
Trigger anti-purge protege o legado unificado; FK restritiva protege o canônico.
Triggers somente DELETE não são executados no motor, que nunca deleta.
Não foi criado segundo alias/mapping nem URL de frontend.

Activity logs usam o mesmo schema de `activityLogService`, mas com o client
já adquirido, para execução/rollback/auditoria serem atômicos e sem aquisição
aninhada de pool. Eventos: PREVIEW, BLOCKED, EXECUTED, FAILED, ROLLED_BACK e
ROLLBACK_BLOCKED, todos com prefixo `CLIENT_UNIFICATION_`. Logs contêm somente
operation/Cliente IDs, hash e códigos. Não armazenam body, SQL/detail ou erro
bruto do PostgreSQL.

## 7. Execute, confirmação e idempotência

`POST /admin/clientes-unificacao/execute` recebe:

```json
{
  "manifest": {"schemaVersion": 1, "clienteCanonicoId": 1001, "clientesLegadosIds": [1002]},
  "planHash": "hash SHA-256 obtido no preview",
  "idempotencyKey": "chave-unica-do-lote",
  "confirmationText": "UNIFICAR 1002 EM 1001"
}
```

Exemplo acima é incompleto/não aprovado. Não executar contra produção.
Para várias origens: `UNIFICAR 1002,1003 EM 1001`, IDs ordenados e texto exato.
Backend valida mesmo sem frontend. Flag OFF retorna erro explícito 403.

Chave de 8–128 caracteres, UNIQUE global, ligada a manifesto/hash e ator.
Repetição em validated/executing retorna operação atual; completed retorna
resultado persistido, inclusive após perda da resposta; rolled_back retorna
reversão existente, sem aplicar novamente. Outra intenção/ator com mesma
chave: `IDEMPOTENCY_KEY_REUSED`. failed/blocked exige novo preview/validação
**e nova chave**; não retoma cegamente a transação anterior.

Crash pode deixar reserva validated pendente. Não há takeover automático por
TTL: UI deve consultar detail e exigir análise operacional do ledger antes de
nova intenção. Não se cria lease/scheduler ou rotina de recovery nesta fase.
Resultado de COMMIT desconhecido por perda da conexão não é marcado failed
sem observar o ledger; conexão ruim é descartada, retry consulta chave.

## 8. Locks e transação

Usa **uma conexão adquirida do pool já endurecido**, nunca pg.Client dedicado
ou pool aninhado. A espera de checkout usa os limites atuais. Conexão perdida
é descartada, sem alterar hardening/P0.

Advisory **xact** locks por Cliente, IDs crescentes, namespaces de
OAuth/Contas existentes 1296845907/1296845909; try-lock falha com MERGE_BUSY.
Row locks de Clientes e registros materiais em ordem determinística com
NOWAIT. Não há lock global; Squad/membership compartilhados não são bloqueados
como mutex de unificação. SERIALIZABLE protege conflitos de predicado;
40001 comprovadamente pré-commit pode repetir no máximo duas vezes,
recalculando hash/validação. Lotes independentes continuam progredindo.

Timeout de statement 10s, lock 1,5s, idle 15s e deadline lógico de transação
15s. Deadline é conferido antes/depois de queries e antes do COMMIT; query em
voo ainda tem seu timeout de 10s. São limites locais à operação, não globais.
Lotes/volume maiores bloqueiam em vez de ampliar prazos silenciosamente.
Não existe HTTP, refresh, chamadas ML/Shopee/Ads, rebuild ou cálculo financeiro
na transação. Nada do scheduler/recovery/pool foi refatorado.

Sob locks: snapshot → hash/validate → before/rollback → executing → updates
por PK/preimage → pós-validação de todas as identidades/chaves → after →
completed/activity → COMMIT. Falha intermediária: ROLLBACK integral e registro
seguro de failed separado da transação abortada.

After snapshot é capturado com a imagem que será commitada, e completed é
persistido **no mesmo commit**. Isso elimina a janela dados commitados/ledger
incompleto. Após COMMIT a resposta usa resultado durável; retry o relê.

## 9. Before/after e rollback

Snapshots mínimos incluem todas as identidades/chaves/versões no escopo,
inclusive destino, para detectar novas linhas/relações posteriores. Não copiam
segredos, blobs ou valores financeiros; valores não alterados não precisam de
restauração. `xmin` bloqueia reversão caso mudem, inclusive token rotacionado.

Plano reverso é derivado de before/preimages, nunca de SQL frontend. PK
comercial que muda com cliente_id tem endereço reverso ajustado; Conta/Grant/
Base IDs não mudam. Constraints/índices e catálogo também são comparados.

`POST /admin/clientes-unificacao/:id/rollback` recebe
`{"confirmationText":"REVERTER UNIFICACAO 123"}`. Exige flag própria ON e
completed/rollback_failed. Nova Conta/Grant/vínculo, mudança de primary,
alteração financeira, versão ou catálogo incompatível:
**409 ROLLBACK_STATE_DIVERGED**, sem sobrescrever estado novo.

Locks, transação e pós-validação restauram exatamente before, desconsiderando
somente `xmin`, que muda legitimamente com UPDATE. Mantém auditoria, marca
rolled_back e registra activity. Retry rolled_back é idempotente.
Rollback_failed só pode repetir se a mesma imagem after ainda for compatível;
não há force ou endpoint de waiver. Backup/PITR e homologação continuam
necessários antes de qualquer piloto real.

## 10. Flags e autorização

```
CLIENTES_UNIFICACAO_EXECUTE_ENABLED=false
CLIENTES_UNIFICACAO_ROLLBACK_ENABLED=false
```

Ausentes, false, vazias ou inválidas = OFF. Apenas `true` explícito, sem
sensibilidade a caixa/espaços, habilita. Leitura em tempo de chamada; nenhum
endpoint altera configuração. Exemplo env versionado mantém ambas OFF.

Todas as sete rotas usam `authMiddleware` + `requireAdmin`. Serviços mutáveis
e leituras administrativas também conferem ator admin. Coordenador, analista,
auxiliar, user e Seller não acessam. Não cria frontend, sidebar ou layout.

## 11. Endpoints e futura UI

| Método | Caminho sob `/admin/clientes-unificacao` | Contrato |
|---|---|---|
| POST | `/preview` | `{manifest}` → preview/hash/blockers/decisões/confirm. |
| POST | `/execute` | Manifesto, hash, idempotencyKey e confirmationText. |
| POST | `/:id/rollback` | ConfirmationText determinístico e flag própria. |
| GET | `/` | status, clienteId, limit 1–100, cursor por ID; resumos sem blobs do ledger. |
| GET | `/:id` | Manifesto/plano/validation, atores/timestamps, before/after resumidos e rollbackAvailable. |
| GET | `/candidatos` | Triagem explicável de raiz/similaridade/seller/Squad, sem canônico aprovado. |
| GET | `/busca?q=` | Até 30 Clientes, inclusive legado com mapping; sem API key. |

`rollbackAvailable` indica status elegível, não prova de estado atual nem flag
ON; a chamada revalida ambos. Histórico não transfere snapshots integrais;
detail retorna resumos/hashes e plano seguro, sem secrets.

Candidatos compartilham `candidates.js` com inventory.py. Paridade do inventário
anterior: 35 pares atuais; dois candidatos apenas históricos continuam na
camada offline de triagem, sem promovê-los a match atual. Limite 500 Clientes e
5.000 Contas/Grants; exceder retorna blocker de escopo, sem amostra silenciosa.
Nome/seller nunca aprova empresa. Não se consultou produção para esta paridade:
foi usada a fotografia privada já existente, sem exportá-la.

Futura tela: buscar/selecionar IDs → coletar aprovação externa → manifesto v1 →
preview → mostrar blockers/warnings/decisões → guardar exatamente o hash →
solicitar confirmação/chave única → execute → detail/history → rollback se
pedido e autorizado. Stale hash exige novo preview. Flags OFF mantêm UI futura
sem escrita. Não contornar blockers por checkbox.

Consumidores futuros do helper: contexto/URLs antigas, carteira/Clientes,
Seller externo, Visão/360, relatórios/entregas, Ads e históricos por slug.
Acesso deve preservar origem e validar ACL depois do lookup. Não se alteraram
páginas nem leitores globais nesta fase; Central com histórico permanece gate.

## 12. Validação e limites de entrega

[Resultados estruturados](auditorias/unificacao-executor/VALIDACAO.json).
Domínio/normalização/hash/UNIQUE/rollback-plan; HTTP com middleware real e
papéis negados; CLI v0/v1; PostgreSQL real em localhost, com schema sintético,
migration repetida, execute e reversão, constraints, concorrência,
rollback de terceira alteração, perda de resposta pós-COMMIT e fluxo HTTP.

Suíte completa da base #254: 331 arquivos, 328 passaram, três falhas históricas.
Nova suíte: 334 arquivos, 331 passaram, mesmas falhas e zero regressão nova.
A validação dirigida cobriu 173 arquivos; foram adicionados 41 cenários de
domínio, 52 verificações HTTP/auth e 39 casos de PostgreSQL, incluindo pool
max=1 e deadline.

Runner de verificação continua após falhas para executar todos os arquivos,
sem TEST_SKIP. Logs das três falhas foram comparados após normalizar paths.
A integração PostgreSQL separada exige URL local explícita e nome
`vf_unificacao_test_*`; não carrega .env de produção.

```bash
# Offline: os mesmos contratos de planner/validator da API v1.
node server/scripts/unificacaoClientes/cli.js --plan --manifest manifest.json --snapshot snapshot-v1.json
node server/scripts/unificacaoClientes/cli.js --validate --manifest manifest.json --snapshot snapshot-v1.json

# Somente LOCAL descartável, com dependências já instaladas e PostgreSQL em execução.
# O harness cria/apaga esse banco; não use banco existente ou credenciais reais.
UNIFICACAO_TEST_DATABASE_URL=postgresql://LOCAL_USER@127.0.0.1:5432/vf_unificacao_test_executor npm --prefix server run test:unificacao:postgres
```

Migration, flags, piloto real, escrita de produção, deployment e merges não
foram executados. Revisão de PR e homologação em cópia representativa são
pendências de habilitação, não conclusão automática por testes sintéticos.
Squads/ACL diferentes, sellers duplicados, Base NULL, Grants ambíguos,
UNIQUEs sem decisão, referências desconhecidas e histórico da Central continuam
blockers. Não se escolheu empresa real nem se autorizou lote empresarial.
