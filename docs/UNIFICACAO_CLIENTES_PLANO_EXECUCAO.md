# Unificação de Clientes e Contas — fases 2 a 5, execução stacked

## 1. Estado atual e autorização

A instrução explícita do usuário substituiu o Gate 0: avançar em formato
stacked antes do merge do #246, sem alterar o PR de fundação. A branch
`feat/unificacao-clientes-fase2-stacked` nasceu de
`d220e2713fe6537a2900bfa3472b54ead3d053d2` (`fix/account-context-foundation`).
A main ancestral é `936fc7d587c16eada35e05fdb0bcb7336063833c`. Merge e deploy
não foram executados. Após o merge futuro do #246, a pilha precisa de rebase,
resolução de conflitos, repetição de testes e revisão antes de qualquer merge.

O prompt master, Etapa 1 e auditoria integral foram lidos. A branch histórica
`feat/unificacao-clientes-contas` não foi usada como base nem seu executor
invocado. O workspace original e o worktree do #246 permaneceram preservados.

Nova fotografia de produção: SELECT direto em 13/10/2026, início
18:54:30 UTC. Conexão `default_transaction_read_only=on` confirmada; timeout
10s, lock timeout 1,5s, connection timeout 8s. Sem serviços/endpoints, sync,
refresh, DDL, DML ou transação longa. Dados nominais estão apenas no diretório
privado ignorado `tmp/unificacao-clientes/`; nenhum segredo foi exportado.

| Cadastro | Volume atual |
|---|---:|
| Clientes | 103 |
| ClienteContas | 156 |
| Grants ML | 84 |
| Bases | 76 |
| Vínculos de Base | 105 |
| Squads | 7 |
| Histórico de Squad | 106 |
| Responsáveis | 0 |
| Vínculo externo Seller | 1 |

Catálogo real: 67 tabelas físicas, 109 FKs. Foram agregadas 37 tabelas com
identidade operacional. Componentes da Central permanecem estimados em
1.293.502: não foi lançada contagem pesada. As leituras são fotografias próximas,
não snapshot transacional único, nem prova da versão/flags implantadas.

## 2. Modelo canônico e mapa real

Cliente é empresa/carteira/contrato/Squad/responsáveis; Conta é operação,
identificada por ID estável e marketplace/external. Grant e Base descrevem a
mesma operação; principal é preferência. O mapa estrutural cobre TODOS os 103
Clientes, inclusive sem Conta, com Contas/sellers/Grants/Bases, Squad/histórico,
responsáveis, ACL e módulos com dados por Conta. A empresa comercial verdadeira
e o canônico empresarial continuam não comprovados/aprovados.

A triagem atual contém 37 pares em 11 grupos: 12 MUITO_PROVAVEL, 20 PROVAVEL,
5 DECISAO_HUMANA; zero CERTO. Doze pares combinam seller e raiz de nome/slug,
mas não comprovam empresa/contrato. Score explicável prioriza revisão: seller
+30, raiz +10 (similaridade isolada +5), Squad igual +10, carteira divergente
-50. Nenhum score decide canônico. Dois pares da auditoria anterior abaixo do
limiar textual atual foram conservados para decisão humana, não apagados.

Há 6 sellers compartilhados quando se consideram Contas e Grants históricos;
9 Grants sem Conta. O inventário sinaliza 22 operações ML sem Grant exato
(incluindo inativas/identidade ausente), 97 operações sem Base ativa elegível
(incluindo operações manuais), e 2 ambiguidades de Base por operação. Esses
números não são somáveis e não significam 97 erros de operação manual. Estado
`valid` no banco não prova validade online da credencial.

## 3. Achados resolvidos por código

- Resolução estrita opt-in no resolver existente, com invariante reutilizado:
  valida pai/atividade/marketplace, seller exclusivo e Grant exato; Base direta
  coerente ou NULL somente com cardinalidade 1. Base de outra Conta, múltiplas
  Bases/Grants e zero Conta recusam. Single-account mantém seleção automática.
- A regra de titularidade do #246 foi extraída para helper compartilhado,
  sem duplicar a regra de coerência. O contexto de precificação conserva os
  testes e comportamento aprovados da fundação.
- OAuth callback salva Grant e vincula/provisiona Conta na mesma transação;
  falha de vínculo reverte tudo. Preflight rejeita seller em outro Cliente,
  Conta/seller divergentes e Grant já ligado a outra Conta. Seller é serializado
  entre callbacks e Cliente é bloqueado antes de Conta/Grant para manter ordem.
  ML2 não altera Grant1; reconexão mantém IDs. Não é backfill de dados reais.
- O alvo de ON CONFLICT do provisionamento inclui o predicado
  `WHERE external_account_id IS NOT NULL` do índice parcial real. Sem migration.
- Ads HTTP, Visão, Ads da 360 V3 e resumo de Métricas usam contexto estrito sem
  exigir Base. O contrato padrão de Ads usado pela Central permaneceu igual,
  explicitamente coberto por teste; não recebe consultas/guardrails novos.
- Visão transmite Conta ao resumo de Margem, e este a transmite ao workspace.
  O bloco passa a declarar escopo de Conta. Nenhuma fórmula/snapshot/UI mudou.

## 4. P1 ainda abertos e limites

| Achado | Resultado / pendência |
|---|---|
| P1-01 empresa canônica | Aberto: 11 grupos precisam de evidência comercial e canônico aprovado |
| P1-02 Grants/externals | Guardrails nos fluxos endurecidos; 9 NULL e identidades compartilhadas não foram corrigidos por escrita |
| P1-03 Bases | Guardrails estritos; consumidores padrão compartilhados com Central e vínculos reais pendentes não foram alterados |
| P1-04 histórico | Plano conserva origem e exige política/lookup; payloads/arquivos/volumes completos em cópia ainda necessários |
| P1-05 TikTok | CHECK real aceita apenas meli/shopee; código cadastral/manual aceita TikTok; nenhuma migration aplicada |
| P1-06 Promoções | Dedupe/cooldown legado por Cliente permanece; plano separado abaixo, sem mudar recomendações |
| P1-07 UNIQUE | Colisões de identidade simuladas; UNIQUEs adicionais exigem ensaio/evidência em cópia e preferência explícita |
| P1-08 slug/URLs | Estratégia de lookup exigida, aliases runtime ainda não implementados/certificados |
| P1-09 legado | Consumidores selecionados endurecidos; resolver padrão, 360 legado/Seller/listagens e agregados comerciais permanecem com contrato legado |
| P1-10 OAuth | Predicado e atomicidade corrigidos; homologação/validação online autorizada ainda pendentes, nenhum callback real executado |

Refresh continua por Grant ID exato, com locks/backoff/SQL anteriores intactos.
Não se alterou seu comportamento global, compartilhado com integrações. A validação de `user_id` devolvido pelo refresh não foi adicionada ao contrato global: essa mudança afetaria o caminho compartilhado da Central e exige PR/homologação próprios. Em
produção futura, homologar concorrência OAuth/refresh e leitura do seller sem
exportar credenciais. Campos de retorno OAuth/roles/payloads não foram
validados pela chamada de API real nesta execução.

## 5. Módulos account-aware

Fundação/precificação/preview/diagnóstico do #246; resolver opt-in novo;
callback OAuth; Ads HTTP/Visão/360 V3; Métricas por Conta; resumo/workspace de
Margem; catálogo novo e margem persistida; Promo snapshot novo; Central nova;
Painel com parcelas/manuais por Conta; funções financeiras que recebem Conta.
Coerência estática e testes não são certificação de toda configuração runtime.

## 6. Módulos legados e convergência adiada

Ads mensal persiste agregado Cliente/slug/campanha, sem parcelas duráveis.
Não foi rateado ou reescrito. Central de Ads percorre Contas e consolida;
seu contrato padrão foi mantido. 360 legado e Seller possuem escopos comerciais/
relatórios por Cliente. A aba Fechamento da Visão permanece declarada como
Cliente; não houve alteração de Fechamento. Históricos NULL não recebem Conta
por principal. Margin Snapshot e seu trabalho independente ficaram intactos.

[Inventário global de fallbacks](auditorias/unificacao-stacked/INVENTARIO_FALLBACKS.csv):
3.089 ocorrências/488 arquivos; 2.682 UX_DEFAULT_OK,
1 LEGADO_SINGLE_ACCOUNT_OK, 406 OPERACIONAL_PERIGOSO para triagem/revisão.
Inclui testes/docs/bundles; exclui os próprios artefatos gerados desta auditoria; a classificação por função/módulo é conservadora,
não prova que todas as 406 ocorrências executem bug nem certifica cada UX.
Selecionadores operacionais conhecidos foram tratados nos fluxos acima;
contratos amplos compartilhados ou sem contexto explícito ficam para PR próprio.

Promoções legadas: antes de mudar dedupe/cooldown, ensaiar chave
`Cliente + Conta/seller + tipo`, migração de diagnósticos/itens e retomada de
jobs. A tabela antiga não contém Conta e recomendações podem mudar. Exigir
PR isolado, snapshots sintéticos/homologação, não repetir ação comercial.
Pipeline novo já congela Conta/seller e usa Grant exato; dados novos vazios não
certificam operação online. Nenhuma implementação de Promoções mudou.

Painel mantém Cliente → Contas e consolidado com origem/manual por Conta.
Ads mensal é agregado comercial explícito, sem rateio arbitrário. Squad e
responsáveis continuam Cliente. Não foi redesenhada UI nem chamado GET com
`ensure*`. Central mantém identidade de run/import/Conta/seller; nenhum sync,
scheduler/recovery/locks/pool/Postgres/publicação foi alterado ou invocado.

## 7. Ferramenta plan/validate

[Uso e contratos](../server/scripts/unificacaoClientes/README.md).
`cli.js --plan` e `--validate` operam offline, exclusivamente com snapshot
sanitizado e manifesto explícito. Mostram mudanças virtuais, FKs transitivas,
referências lógicas, volumes completos/estimados, UNIQUEs, Grant/Base,
carteira/responsáveis e histórico. Não existe modo apply/execute/commit.

Validação distingue não migrado/já migrado/parcial/conflito, identifica PK e
catálogo incompletos, exige aprovação empresarial, estratégia de URL/lookup e
revisão de UNIQUE/referências lógicas. Cobertura incompleta bloqueia, sem
transformar estimativa em zero. Grant NULL exato não é associado automaticamente;
Base NULL não é movida automaticamente. Nenhum Cliente é apagado/desativado.

`validation.ok` significa estrutura pronta para ensaio em cópia, não autorização
de produção. `productionReady:false` e `writeCapability:false` são permanentes.
A ferramenta de coleta é separada, SELECT pré-definido com read-only confirmado;
plan/validate não importam driver nem usam DATABASE_URL.

## 8. Primeiro piloto preparado

Selecionado somente como candidato de revisão: Clientes #40/#67, mesmo Squad
#4, três operações no grupo, uma Conta na origem, sem seller compartilhado
entre eles e Grant/Base dessa Conta coerentes. Cenário explícito NÃO aprovado:
Conta #27 de #67 para hipótese de canônico #40, sem mudar nenhum ID externo,
Grant, Base ou cadastro legado. Não se decidiu que são a mesma empresa.

Dossiê privado `tmp/unificacao-clientes/piloto-01/` contém README, manifesto,
plan, validate, impacto, rollback.md e rollback.json. Plan prevê três mudanças
virtuais de identidade; validate retorna bloqueado (exit 2). Nenhum SQL de
escrita foi gerado ou executado. Não há candidato empresarialmente liberado
para migração real nesta fotografia.

## 9. Blockers humanos

DECISÃO HUMANA NECESSÁRIA — candidatos #40/#67: mesma raiz de nome/slug e
Squad favorecem revisão; não há contrato/CNPJ/titularidade comprovados e há
histórico/URLs/preferências a preservar. Escolhas documentadas: A mesma empresa
(com evidência/canônico/ACL), B empresas diferentes, C manter pendente. Estado C.

O piloto também exige resolver explicitamente colisões de Conta principal e
Grant principal, aprovar lookup/origem de históricos e ensaiar UNIQUEs/URLs.
Componentes da Central precisam de validação de volume em cópia. Esses blockers
não foram usados para interromper as partes independentes da execução.

## 10. Ordem recomendada

Revisar PRs em ordem A resolvers → B OAuth → C consumidores → D inventário/
planejamento:

- [PR A #251](https://github.com/venforcecompany-sudo/venforce-server/pull/251): base #246.
- [PR B #252](https://github.com/venforcecompany-sudo/venforce-server/pull/252): base PR A.
- [PR C #253](https://github.com/venforcecompany-sudo/venforce-server/pull/253): base PR B.
- [PR D #254](https://github.com/venforcecompany-sudo/venforce-server/pull/254): base PR C.

 Nenhum foi mergeado por este trabalho. Após merge do #246,
rebase de todos os segmentos, testes, review e homologação. Depois: comprovar
empresa por grupo, aprovar manifesto/ACL/preferências, implementar/testar
lookup e executor em PR próprio, ensaiar ida/volta em cópia integral e só então
pedir autorização própria para piloto real. DELETE não pertence às primeiras fases.

## 11. Rollback

Gerado automaticamente por PK com preimages apenas de identidade, versão e
hash de snapshot/manifesto. Reverte before/after, conserva ID da Conta/seller/
Grant/Base. Não contém credenciais nem restaura tokens rotacionados. Plano
reverso não substitui backup ou executor. Requer backup/PITR testado, writers
coordenados em janela aprovada, política para novas linhas posteriores ao lote,
comparação de resultados financeiros/ACL/contagens e lookup de origem.
Nenhuma rotina foi parada/coordenada em produção nesta execução.

## 12. Critérios para produção e validação desta entrega

Antes de qualquer escrita: merge/rebase/review/homologação; empresa/canônico e
ACL aprovados com evidência; vínculos/UNIQUEs/aliases/histórico determinísticos;
catálogo/volumes vivos completos em cópia; financeiro preservado; backup e
rollback ensaiados; executor idempotente auditado; autorização explícita do lote.
Nada disso é liberado automaticamente por pontuação, plan ou validate.

Testes locais sem env de produção, com rede externa bloqueada e banco/API
falsos. Suíte completa compara a fundação temporária com a pilha e conserva
somente as três falhas históricas: designStudioWorkspace,
meliAnunciosOrdenacaoGlobal e mlTokenService. Logs comparados após normalizar
caminhos. [Resultados estruturados](auditorias/unificacao-stacked/VALIDACAO.json)
registram os totais finais, casos novos, diretórios protegidos e privacidade.

Fase 2: inventário/mapa estrutural concluídos; identidade empresarial pendente.
Fase 3: correções seguras e auditoria concluídas parcialmente; dados/contratos
legados amplos adiados. Fase 4: plan/validate/rollback sem executor concluídos.
Fase 5: dossiê de candidato concluído; piloto real bloqueado por aprovação e
ensaio. Não houve migration, alteração de produção, merge ou deploy.
