# Caixa-preta do Fechamento Financeiro

Preserva automaticamente, de forma temporária e segura, os arquivos exatos e o
diagnóstico técnico de um fechamento financeiro (MELI/Shopee/TikTok) quando
ele apresenta uma anomalia real — sem depender do gestor reenviar planilhas
por WhatsApp e sem alterar o resultado/erro que o usuário recebe.

## Arquitetura

```
Portal/financeiro.js (legado)  ──┐
                                  ├──►  POST /fechamentos/financeiro  ──►  processFechamentoFinanceiro()
NovoFechamento.jsx (V3)        ──┘         (fechamentosFinanceiroController.js)   (meli/shopee/tiktok)
                                                        │                                │
                                                        │                        debugCollector (opcional,
                                                        │                        meli/shopee — mesma
                                                        │                        instrumentação do Debug
                                                        │                        Financeiro)
                                                        ▼
                                       detectarIncidenteFechamento(result)
                                       (função pura — só lê campos reais do motor)
                                                        │
                                                 anomalia? ──não──► responde normalmente
                                                        │
                                                       sim
                                                        ▼
                                       fechamentoIncidentStorageService.saveIncidente()
                                       (nunca lança — falha vira log, fechamento segue)
                                                        │
                                              fechamentoIncidenteRepository
                                          (Postgres: fechamento_incidentes +
                                           fechamento_incidente_arquivos, BYTEA)
                                                        │
                                       resposta ganha `incidente: {codigo, mensagem}`
```

A mesma instrumentação cobre **Financeiro legado e V3**, porque os dois
chamam o mesmo endpoint (`POST /fechamentos/financeiro`,
`server/controllers/fechamentosFinanceiroController.js`). Nenhum motor
financeiro (`meliFinanceiroService`, `shopeePerformanceService`,
`shopeeOrderAllService`, `tiktokFinanceiroService`) foi alterado.

No caminho de **exceção** (algo lança durante o processamento), o `catch` do
controller tenta a mesma captura com o contexto e os arquivos já recebidos
antes de devolver — sem alterar — o erro original (`statusCode`/`payload`
inalterados).

## Critério de incidente — `detectarIncidenteFechamento`

`server/services/fechamentoFinanceiro/incidente/detectarIncidenteFechamento.js`
é uma função pura que só lê campos **reais** do resultado do motor (nenhum
campo foi inventado):

| Trigger | Condição real |
|---|---|
| `identidade_ambigua` | algum item de `result.unmatchedCosts` tem `type === "ambiguous_ids"` (conflito de IDs resolvidos pela ponte Shopee — Order.all → Performance → Base) |
| `custo_nao_encontrado` | `result.unmatchedIds.length > 0` OU `result.unmatchedCosts.length > 0` |
| `receita_sem_custo` | `result.summary.revenueWithoutCost > 0` |
| `cobertura_incompleta` | `result.summary.financialConfidence !== "confiavel"` (ou seja, `"parcial"` ou `"insuficiente"`) |
| `excecao_processamento` | processamento lançou exceção (capturado só no `catch` do controller) |

Um fechamento **sem nenhum** desses sinais não cria incidente — nenhum
arquivo é persistido (fechamento perfeito: processa → responde → descarta).

`unmatchedCosts` com o diagnóstico tipado (`type`/`value`/`sku`/`candidates`/
`reason`) só existe hoje para **Shopee**, e só quando o Order.all é enviado
(`shopeeOrderAllService.js` → `describeShopeeCostGap`). Para MELI e TikTok a
detecção usa `unmatchedIds` (lista simples) e os campos de `summary`.

## Diagnóstico técnico (`debugCollector`)

`server/utils/fechamento/debugCollector.js` já existe e alimenta o Debug
Financeiro (`POST /fechamentos/financeiro/debug`, admin-only). A caixa-preta
passa a instanciar esse mesmo coletor (`createDebugCollector()`) em **todo**
fechamento MELI/Shopee — não só nos problemáticos — porque cada ponto de
instrumentação dentro dos motores é `if (debugCollector) {...}`: passar o
coletor não muda nenhum valor calculado, só habilita registrar tentativas de
match (`recordMatchAttempt`), warnings e o estado da ponte Shopee. O
`snapshot()` do coletor só é persistido quando um incidente é criado; para
fechamentos normais ele é descartado ao fim do request.

TikTok não tem `debugCollector` ainda — mesma limitação da v1 do Debug
Financeiro (`services/fechamentoFinanceiro/index.js` não repassa
`debugCollector` para `processTikTok`).

## Tabelas

`server/sql/migrations/20260910_fechamento_incidentes.sql` (aditiva,
idempotente, aplicação manual — mesmo padrão de
`20260817_cliente_contas_foundation.sql`). Como rede de segurança, o boot do
servidor também garante as tabelas via
`repositories/fechamentoIncidenteRepository.js` (`ensureFechamentoIncidenteTables`),
igual a `ensureObservabilityTables`/`ensureSquadsTables`.

**`fechamento_incidentes`**: `id`, `codigo` (`FIN-<id>`, único), `cliente_id`,
`cliente_slug`, `cliente_conta_id`, `marketplace`, `periodo`, `usuario_id`,
`trigger_tipo`, `status` (`aberto`/`em_analise`/`resolvido`), `resumo_json`,
`diagnostico_json`, `metadata_json`, `created_at`, `expires_at`,
`resolved_at`.

**`fechamento_incidente_arquivos`**: `id`, `incidente_id` (FK cascade),
`tipo_arquivo` (`sales`/`costs`/`ordersAll`/`onhold` — os mesmos nomes de
campo do `multer.fields()` da rota real), `nome_original` (sanitizado),
`mime_type`, `tamanho_bytes`, `sha256`, `conteudo` (BYTEA — o buffer EXATO
recebido, nunca reconstruído), `conteudo_truncado`, `created_at`.

Toda persistência passa por `fechamentoIncidentStorageService`
(`server/services/fechamentoFinanceiro/incidente/`) — trocar Postgres/BYTEA
por S3/R2/Supabase Storage no futuro é reimplementar só esse arquivo.

## Endpoints (admin-only)

Todos exigem `authMiddleware` + `requireAdmin`
(`server/middlewares/authMiddleware.js`, mesmo gate do Debug Financeiro):

- `GET /fechamentos/incidentes` — lista recente (filtros opcionais
  `clienteSlug`, `marketplace`, `status`, `limit`, `offset`).
- `GET /fechamentos/incidentes/:codigo` — detalhe (inclui `arquivos[]` com
  metadados e hash, **sem** o conteúdo binário).
- `GET /fechamentos/incidentes/:codigo/arquivos/:arquivoId` — download do
  arquivo original (binário, `Content-Disposition: attachment`). O
  `arquivoId` é validado contra o `incidente_id` do `:codigo` — um id de
  arquivo de outro incidente nunca é aceito.

Sem URL pública, sem token na query string, nada em `entregas_cliente`/links
públicos existentes é tocado.

## Retenção e limites (ENV)

| Variável | Default | Efeito |
|---|---|---|
| `FECHAMENTO_INCIDENT_RETENTION_DAYS` | `15` | TTL do incidente (`expires_at`). Incidente e arquivos expirados somem das consultas mesmo antes da limpeza física rodar (`getIncidenteByCodigo`/`getArquivo` já filtram `expires_at > NOW()`). |
| `FECHAMENTO_INCIDENT_MAX_FILE_MB` | `20` | Se um arquivo exceder o limite, o incidente ainda é criado (hash/metadados preservados), mas o conteúdo binário não é salvo (`conteudo_truncado = true`) e o download devolve 404. |

Limpeza física roda por `startRetentionJob()`
(`fechamentoIncidentStorageService.js`), acionado no boot igual ao
`observabilityService.js` (timer `setInterval` de 6h, `unref()`, idempotente
— `DELETE ... WHERE expires_at < NOW()`).

## Segurança

- Nunca loga conteúdo de planilha — só `[FinanceiroIncident] FIN-184 criado marketplace=... clienteContaId=... trigger=...`.
- Nome de arquivo sanitizado (`sanitizeFileName`) antes de gravar — sem
  separadores de caminho, sem caracteres de controle.
- Download só para `role === "admin"`.
- SHA-256 de cada arquivo prova qual planilha exata foi usada.
- Captura nunca é obrigatória para o usuário — é automática; existe um botão
  opcional apenas se um motivo técnico real justificar (não implementado
  nesta primeira versão — a captura automática já cobre o caso de uso
  pedido).

## Teste manual

1. Suba o backend contra um ambiente de fechamento Shopee que hoje produz
   "produtos sem custo identificado" / "IDs conflitantes" (planilha `sales`
   + `costs` + `ordersAll` reais, com algum SKU que resolve para mais de um
   ID na ponte).
2. Processe o fechamento pelo Financeiro (legado ou V3). A resposta HTTP
   continua `200 ok:true`, mas agora também traz `incidente: {codigo,
   mensagem}` — a tela mostra um banner discreto: "Ocorrência de suporte
   FIN-184 criada. Os arquivos utilizados foram preservados temporariamente
   para diagnóstico." com um botão **Copiar código** e, para admin, **Abrir
   diagnóstico**.
3. Como admin, abra `Portal/financeiro-debug.html` (ou clique em "Abrir
   diagnóstico") → seção **Incidentes de suporte** → busque `FIN-184`.
4. Confira cliente/conta/marketplace/período/usuário/data, os triggers
   (`identidade_ambigua`, `custo_nao_encontrado`, ...), o resumo e o
   diagnóstico técnico (JSON com `unmatchedIds`/`unmatchedCosts`/snapshot do
   `debugCollector`).
5. Baixe `sales.xlsx`/`costs.xlsx`/`ordersAll.xlsx` pelos botões da lista de
   arquivos e confira que são **exatamente** os arquivos enviados (abra e
   compare, ou confira o SHA-256 mostrado contra o arquivo original).
6. Repita o teste sem `?incidente=` na URL: a lista "Recentes" já mostra o
   `FIN-184` sem precisar saber o código de antemão.

## Migrations e variáveis pendentes de aplicação em produção

- **Migration**: `server/sql/migrations/20260910_fechamento_incidentes.sql`
  — aditiva e idempotente; aplicação manual (mesmo processo de
  `20260817_cliente_contas_foundation.sql`). O boot do servidor também cria
  as tabelas via `ensureFechamentoIncidenteTables()`, então em ambientes que
  já sobem o servidor a aplicação manual é redundante (mas é a referência
  canônica do schema).
- **ENV novas** (opcionais, com default seguro): `FECHAMENTO_INCIDENT_RETENTION_DAYS=15`,
  `FECHAMENTO_INCIDENT_MAX_FILE_MB=20`.

## Limitações conhecidas

- TikTok não passa `debugCollector` (mesma limitação já existente do Debug
  Financeiro v1) — o incidente ainda é criado normalmente (via
  `unmatchedIds`/`summary`), só sem o snapshot detalhado de match.
- `unmatchedCosts` com diagnóstico tipado (`type: "ambiguous_ids"` etc.) só
  existe quando Shopee processa o arquivo `ordersAll` — sem ele, a detecção
  de identidade ambígua não tem como acontecer (o próprio motor não produz
  esse dado).
- Quando o parse do `ordersAll` falha, o controller hoje ignora o erro
  silenciosamente (`ordersAllRowsRaw = null`, comportamento pré-existente,
  não alterado por esta missão) — esse caso específico não vira incidente
  porque o motor nunca chega a reportar a anomalia. Fora do escopo desta
  missão (que era observar o que o motor real já expõe, não mudar o que ele
  expõe).
- Não há painel de "resolver incidente" no frontend — o campo `status`
  existe no schema para uso futuro, mas hoje todo incidente fica `aberto`
  até expirar.
