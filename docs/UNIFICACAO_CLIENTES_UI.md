# Interface administrativa de Unificação de Clientes

A página `Portal/clientes-unificacao.html` entrega candidatos → busca manual → seleção explícita → preview → decisões → confirmação → execução → resultado → histórico → detalhe → rollback. Usa o backend transacional do PR #260 como autoridade. Nenhuma regra de Squad, identidade, Grant, Base, autorização empresarial, unicidade, locks, idempotência transacional ou reversão foi implementada no frontend.

## Base e escopo

- Base stacked: `feat/clientes-unificacao-executor-stacked`, PR #260.
- SHA inicial: `6aafd52aba419c229312c51d74c534a7a8d10b4b`.
- Branch: `feat/clientes-unificacao-ui-stacked`.
- Sem alteração da branch #260, migration, produção, merge ou deploy.
- Central de Vendas, Painel de Contas, Margem, Ads, Promoções, Financeiro, scheduler e recovery permanecem com arquivos e regras intactos.

## Arquivos e arquitetura

| Arquivo | Responsabilidade |
| --- | --- |
| `Portal/clientes-unificacao.html` | Página global, seleção, abas, revisão e áreas de resultado/auditoria. |
| `Portal/clientes-unificacao.js` | Estado efêmero e apresentação dos contratos HTTP reais. |
| `Portal/clientes-unificacao-access.js` | Configuração autenticada por sessão da página, com retry e sem persistir flags. |
| `Portal/css/pages/clientes-unificacao.css` | Namespace `cu-`, tokens e componentes V2, tabelas com scroll local e layout responsivo. |
| `Portal/vf-shell.js` | Item em Administração e atalho discreto no header existente de Clientes e Contas, condicionados à configuração do servidor. |
| `Portal/clientes-unificacao-ui.test.js` | Chrome/CDP, página e HTTP reais, escritas simuladas, planner/validator reais. |
| `Portal/clientes-unificacao.postgres.cjs` | E2E com autenticação, router, executor e rollback reais em PostgreSQL descartável. |
| `Portal/tests/unificacao-browser.cjs` | Harness CDP sem Puppeteer/dependências adicionais. |

A fonte atual da navegação de Clientes e Contas é `vf-shell.js`, identificado pela página real da base. `layout.js`, `clientes.js`, `clientes.html`, `vf-api.js` e o React existente não foram alterados. A nova página importa o Shell somente depois de verificar a configuração administrativa; não cria router/SPA/framework paralelo. Usa `vf-api` para URL, token, headers, parsing, timeout, abort e tratamento de 401; `vf-format.escapeHTML` para interpolação segura.

## Flags e acesso

Todas permanecem OFF por padrão, sem ajuste em produção:

```dotenv
CLIENTES_UNIFICACAO_UI_ENABLED=false
CLIENTES_UNIFICACAO_EXECUTE_ENABLED=false
CLIENTES_UNIFICACAO_ROLLBACK_ENABLED=false
```

Somente o valor explícito `true` habilita. A configuração é consultada no servidor em `GET /admin/clientes-unificacao/config`, protegido por `authMiddleware` e `requireAdmin`, incluindo validação de usuário ativo. Não existe override por query string, localStorage ou campo de formulário.

A página faz um gate inicial da sessão para redirecionar ausência de token ao login e bloquear as personas internas não administrativas e seller. Mesmo um storage adulterado como admin não libera a página: a configuração exige o admin ativo real no backend. A UI OFF bloqueia a página por URL e oculta a navegação e o atalho. Uma falha de configuração mantém o novo item oculto e oferece retry na página. O endpoint permanece disponível ao admin quando UI OFF para explicar esse estado; os endpoints existentes do #260 continuam sujeitos às suas flags independentes.

`config.actor.id/role` é seguro e deriva de `req.user`, nunca do corpo. A identidade do solicitante/confirmante da execução continua sendo definida pelo backend. O ID de aprovador declarado no manifesto é uma decisão empresarial externa, não prova de autenticação ou autorização independente.

## Contratos reais usados

Prefixo: `/admin/clientes-unificacao`.

| Método / caminho | Entrada | Dados consumidos |
| --- | --- | --- |
| GET `/config` | Sessão autenticada | `uiEnabled`, `executeEnabled`, `rollbackEnabled`, `actor`. |
| GET `/candidatos` | — | `candidatos[]`: IDs A/B, `classificacao`, `score_priorizacao`, `motivos`, `decisao`. |
| GET `/busca?q=` | Texto até 100 caracteres | `clientes[]`: `id`, `nome`, `slug`, `ativo`, `merged_into_cliente_id`. |
| POST `/preview` | `{manifest}` | `manifest`, `planHash`, `canExecute`, `validationReady`, `blockers`, `warnings`, `info`, `decisionsRequired`, `confirmationText`, identidades, contas, Grants, Bases, vínculos, Squad, responsáveis, plano e impacto. |
| POST `/execute` | `{manifest, planHash, idempotencyKey, confirmationText}` | `operation` com status efetivo. |
| GET raiz | `limit=25`, `cursor` | `operations`, `nextCursor`. |
| GET `/:id` | ID real da operação | `operation`: manifesto, plano, validação, atores, datas e resumos before/after. |
| POST `/:id/rollback` | `{confirmationText}` | `operation` com resultado real da reversão. |

Envelope real: `ok: true` com os campos de cada endpoint; erro `ok: false`, `code`, `erro`. O frontend não exibe `erro`, stack ou mensagens SQL arbitrárias. Traduz códigos conhecidos e usa mensagem genérica para os demais.

### Complementos mínimos de apresentação no backend

O #260 já fornecia regras e os sete endpoints funcionais. Para consumir a UI sem inferências locais, foram necessárias apenas estas adições compatíveis:

1. Endpoint admin-only `/config`, anterior a `/:id`, com flags e ator verificado.
2. `baseVinculos` no preview, usando a mesma projeção segura `selected(...).map(safe)` do snapshot já carregado. Permite apresentar a Base da Conta sem inventar uma associação por marketplace ou cliente.
3. `rollbackConfirmationText` no DTO HTTP de detalhe/execute/rollback, reutilizando `rollbackConfirmation` do próprio backend. Nenhum formato é derivado no frontend.

Planner, validator, manifest schema, cálculo de hash, repository, executor, estados, transações, audit, locks, rollback e migration do #260 não foram modificados. O serviço recebeu uma única linha aditiva na projeção do preview. Essas adições não transformam blockers em warnings e não habilitam qualquer operação.

## Candidatos e busca

Os candidatos reais só retornam IDs e sinais de triagem; não retornam nomes, volumes de contas, marketplaces, nomes de Squads ou blockers. A tabela mostra exatamente esses sinais, com pontuação identificada como priorização, sem percentual de certeza empresarial. Os dados completos e os bloqueios aparecem no preview.

Revisar um candidato abre a área de seleção e busca os dois IDs. **Não seleciona** canônico ou legado automaticamente. O canônico depende de clique explícito. A busca manual permanece disponível quando candidatos estiverem vazios, com erro ou além do limite do backend.

Busca com debounce de 300 ms, AbortController e geração de request: resultados atrasados são descartados. Canônico e legados escolhidos são excluídos dos resultados; a seleção também protege contra duplicidade. Legados são múltiplos e removíveis. Não há regra local dizendo se um cliente inativo ou já unificado pode executar: os dados são apresentados e o backend valida.

O contrato de busca não retorna Squad, quantidade de contas ou marketplaces; esses campos não são fabricados. A UI trabalha com IDs/nomes/slugs reais. O limite de 20 legados é validado no manifesto pelo backend.

## Manifesto, preview e decisões

A UI envia manifesto v1 com os campos reais:

```json
{
  "schemaVersion": 1,
  "clienteCanonicoId": 1,
  "clientesLegadosIds": [2],
  "decisoes": {"primaryAccounts": {}, "primaryGrantId": null, "referencias": {}},
  "aprovacao": {"aprovada": false, "aprovadorUserId": null, "evidencia": null}
}
```

A seleção de clientes só habilita a solicitação de preview. O backend retorna a versão normalizada; essa versão exata será usada em execute.

A apresentação tem quatro seções: empresa canônica e legados, Contas após o plano, impacto/preservação, e validação/decisões. O estado previsto de `is_primary` é lido de `plan.changes[].after`, sem regra local de escolha. Identidades, origem, seller, IDs, status registrado do Grant e vínculos de Base são visíveis. Grants legados com Conta NULL aparecem como tal na seção de integrações; não são associados por heurística no navegador. `valid` é status registrado, não promessa de token online; o backend informa `NO_ONLINE_GRANT_CHECK`.

`impactCounts` mostra o nome real da referência, volume e estratégia real traduzida. Só `plan.preserved` sustenta a lista de IDs preservados. Não se inventa garantia de migração de Central, reconstrução de derivados ou redirecionamento de slugs. `plan.changes` pode ser consultado por tabela/PK e campos alterados, sem dump de snapshots ou JSON bruto.

`decisionsRequired` do #260 é uma lista de paths, não um objeto de formulário. São suportados os paths reais `aprovacao`, `decisoes.primaryAccounts.<marketplace>` e `decisoes.primaryGrantId`. As opções vêm das Contas/Grants retornados, e o backend valida a escolha. A referência empresarial é apenas referência documental curta. Uma decisão desconhecida aparece explicitamente sem oferecer bypass.

Controles resolvidos permanecem editáveis para revisão. Qualquer alteração invalida imediatamente o preview/confirmacão locais, zera o hash utilizável e solicita novo preview com debounce de 500 ms. Hash é exclusivamente retornado pelo backend e vive só em memória; o frontend nunca calcula, edita ou persiste esse valor. Loading bloqueia alteração/execute, e respostas antigas não sobrescrevem estado novo.

## Execução e recuperação de resposta

O botão depende de `canExecute === true`, sem blockers/decisões pendentes, checkbox de revisão e texto idêntico a `confirmationText`. Exemplos reais são `UNIFICAR 2 EM 1` e `UNIFICAR 2,3 EM 1`; quem produz o texto e ordena IDs é o backend.

Uma tentativa recebe `crypto.randomUUID()`. Duplo clique fica bloqueado imediatamente. Retry de uma tentativa com resposta incerta mantém a mesma chave, o mesmo manifesto normalizado e o mesmo hash. Preview materialmente diferente gera outra tentativa; `IDEMPOTENCY_RETRY_REQUIRES_NEW_KEY` também exige novo preview/tentativa.

Execute usa timeout HTTP de 45 s para acomodar a transação/retries limitados do backend. `REDE`, `TIMEOUT` e `MERGE_CONNECTION_LOST` não são interpretados como falha definitiva: a UI mantém seleção/decisões travadas, oferece repetir a **mesma** tentativa e consultar auditoria. Uma resposta `validated`/`executing` não vira sucesso nem libera uma nova unificação. O admin pode atualizar o detalhe; só um status terminal libera o editor.

`MERGE_PLAN_CHANGED` invalida o plano e exige outra validação. Flag OFF tem explicação própria, sem erro genérico. Não existe ignorar bloqueio ou forçar execução.

Sucesso é dedicado, sem redirect automático, com canônico, legados, contas preservadas e operation key. O link abre a tela existente Clientes e Contas; não foi inventado parâmetro de deep-link para uma página que não o suporta. A auditoria é acessível imediatamente.

Estado e chave não persistem após reload. Se a resposta ficou incerta e a página foi fechada/recarregada, consulte o histórico antes de iniciar outra tentativa. Reservas pendentes sem conclusão continuam dependendo de revisão operacional do #260; a UI não implementa takeover, scheduler ou recuperação paralela.

## Histórico e rollback

Histórico com paginação por cursor real, estados de loading/vazio/erro e detalhe. Detalhe mostra operação, datas, atores, IDs, manifesto resumido, impacto, validação, resultado e resumos de auditoria. Dados técnicos colapsáveis contêm apenas hashes/IDs/tabelas/código seguro, sem tokens, payloads financeiros ou snapshots brutos. Gerações de request descartam detalhes atrasados.

Rollback é apresentado somente dentro do detalhe quando `rollbackAvailable === true` e `config.rollbackEnabled === true`. Disponibilidade é elegibilidade de status, **não garantia** de que a preimagem ainda é compatível; a validação transacional continua no backend. O texto exato vem em `rollbackConfirmationText` (ex.: `REVERTER UNIFICACAO 1`). Duplo clique é bloqueado e o retry opera sobre o mesmo ID, cuja idempotência já é do backend.

Flag desligada após abrir a tela e `ROLLBACK_STATE_DIVERGED` são tratados explicitamente. Divergência oculta a confirmação daquela tentativa e não oferece opção de forçar. O detalhe pode ser atualizado para ler o status posterior registrado. Nenhuma promessa de rollback incondicional é feita.

## UX e segurança

- Shell V3, tokens/componentes V2 e assets locais de Mercado Livre/Shopee/TikTok.
- Área de revisão na página, sem modal/drawer próprio ou wizard adicional.
- Tabelas com cabeçalhos semânticos e scroll horizontal local; seleção vira uma coluna em viewport pequeno.
- Labels, fieldsets, botões reais, foco nas áreas abertas, abas com teclado e roving tabindex, status com aria-live. Não há modal para exigir Esc/focus trap.
- Conteúdo externo interpolado sempre com `escapeHTML`; mensagens arbitrárias de erros nunca entram no DOM. Detalhes técnicos usam whitelist de campos escalares, sem JSON cru.
- Sem CSS inline, framework, biblioteca, logos externos ou nova dependência de produto.
- Sem exportar sessão, credenciais OAuth, DATABASE_URL ou segredos em artefatos. O teste local usa apenas dados sintéticos e não publica tokens.

## Habilitar e validar somente localmente

Para navegação manual em ambiente isolado já preparado, configurar apenas o processo local:

```dotenv
CLIENTES_UNIFICACAO_UI_ENABLED=true
CLIENTES_UNIFICACAO_EXECUTE_ENABLED=false
CLIENTES_UNIFICACAO_ROLLBACK_ENABLED=false
```

Servir o Portal com `<meta name="vf-api-base" content="http://127.0.0.1:PORTA_BACKEND_LOCAL">` no HTML entregue pelo servidor local. O `vf-config` padrão tem fallback de produção; **não** testar manualmente flags ON sem substituir essa base por loopback. Não comitar a substituição local ou alterar configuração do serviço hospedado. A infra do #260 precisa existir no banco local; esta implementação não aplica migration no boot.

A validação automatizada elimina esse risco: os harnesses injetam o meta local, bloqueiam URLs externas pelo CDP e fazem fixtures/auth próprios, sem usar sessão humana.

```bash
node Portal/clientes-unificacao-ui.test.js
node server/tests/clientesUnificacaoApi.test.js
node server/tests/clientesUnificacaoDomain.test.js
```

Para o E2E com backend real, fornecer uma URL **explícita** de PostgreSQL descartável em loopback e com nome `vf_unificacao_test_*` (sem banco previamente existente):

```bash
NODE_ENV=test \
UNIFICACAO_TEST_DATABASE_URL=postgresql://USUARIO_LOCAL@127.0.0.1:55478/vf_unificacao_test_ui \
node Portal/clientes-unificacao.postgres.cjs
```

O helper cria o banco, aplica duas vezes a migration **somente nele**, cria fixtures sintéticas, testa e apaga o banco ao finalizar. Hosts externos e nomes fora do prefixo são recusados. Execute/rollback ON são flags injetadas exclusivamente no serviço local do teste; nenhuma env/flag de produção é alterada. Requer Chrome, Node compatível com WebSocket e dependências já existentes do backend. Sem dependências adicionais.

## Evidências desta entrega

- UI Chrome: 41 cenários cobrindo acesso, flags, candidatos, loading/error/empty, debounce/abort, escolha explícita/múltiplos legados, contratos de preview, decisões, hash, confirmação, idempotência, pending/response loss, sucesso, histórico, paginação, detalhe, rollback e XSS/responsividade (1440/1024/390).
- E2E UI + PostgreSQL 18.6: 7 cenários, com execução e rollback reais, mapping/ownership/ledger, flags OFF e divergência posterior sem mutação.
- Backend PostgreSQL #260: 39 cenários aprovados no banco local descartável.
- HTTP/auth: 65 verificações, incluindo configuração admin-only, inativo, roles negados e default OFF.
- Domínio: 41 cenários aprovados; CLI e suíte backend incluídos na rodada completa.
- Backend completo: **331/334** tanto na base #260 quanto nesta branch. As falhas `designStudioWorkspace.test.js`, `meliAnunciosOrdenacaoGlobal.test.js` e `mlTokenService.test.js` têm logs idênticos após normalização do path; zero regressão nova.
- Regressões Portal: oito arquivos aprovados (Clientes criar/diagnóstico/exclusão/Squad e Shell adoption/lote/hardening/navigation). `vf-shell-ui.test.js` falha em `grupo.summary.includes("Shopee") && grupo.summary.includes("4")`, linha 409, **também na base limpa #260**, com log idêntico após normalização do path. Não foi alterado o módulo protegido para corrigir uma expectativa histórica de navegação.
- `git diff --check` e validação sintática aprovados. Nenhuma regra/arquivo dos módulos protegidos alterado.

## Gates restantes

Não há blocker de implementação da UI. Antes de qualquer uso de dados reais: revisar PR stacked, integrar/rebasear a cadeia conforme os PRs anteriores forem aprovados e obter homologação/autorização empresarial/operacional. UI, execute e rollback continuam OFF por padrão e em produção. Blockers de dados/referências/integração Central continuam sendo os do backend #260; esta interface não os ignora.
