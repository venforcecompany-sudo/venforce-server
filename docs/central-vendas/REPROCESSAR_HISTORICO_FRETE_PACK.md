# Reprocessar competências históricas com frete de pack duplicado

> Procedimento preparado, **não executado**. Cada run manual escreve em produção (import novo + publicação) e
> chama o Mercado Livre: exige autorização explícita, uma linha da fila por vez.

## Por que é preciso
O PR #362 (main 9d66c94f, 28/10/2026 17:38Z) corrigiu o motor: pedidos do mesmo pack rateiam o frete do shipment.
A margem realizada (`/margem` → `resolveImportsForRange` → `loadRealizadoByImportIds` → `agregarPorMlb`) lê sempre o
**fechamento vigente** de cada competência (published mais recente cuja cobertura contém o trecho pedido). O sync diário
só republica o mês corrente (e o anterior até o dia 5); competências mais antigas continuam com o fechamento publicado
antes do fix, com o frete cheio em cada pedido do pack. Nada no código está errado: o dado vigente é que é antigo.

Medição em produção (29/10/2026, somente leitura), excesso de frete nos vigentes publicados antes do fix:

| competência | contas | packs | pedidos | excesso de frete |
|---|---|---|---|---|
| 2026-07 | 2 | 49 | 104 | R$ 1.532,90 |
| 2026-08 | 5 | 110 | 258 | R$ 5.734,61 |
| 2026-09 | 35 | 399 | 927 | R$ 19.214,62 |
| 2026-10 | 3 | 556 | 1.284 | R$ 19.152,68 |

Os vigentes publicados depois do fix têm 985/985 packs rateados (marca "Frete do envio compartilhado por N pedidos").
Outubro só tem 3 contas pré-fix: a 41 (Red Fish, sem sync desde 28/10 16:41) e as 25 e 66 (runs falhando com
`SYNC_DB_CONNECTION_LOST`/`SYNC_RUN_STALE_QUEUED`; a 66 está parada desde 05/10). Essas três se corrigem quando o sync
voltar a completar; o resto da fila é histórico e só sai com run manual.

## 1. Fila (somente leitura)
```
\i server/sql/auditoria/central_vendas_historico_frete_pack.sql
```
Uma linha por (cliente, conta, competência) com `dateFrom`/`dateTo` prontos e o excesso estimado. A consulta replica a
seleção do mês inteiro (published de cobertura completa, `published_at DESC, id DESC`).

## 2. Reprocessar uma linha
Rota existente (admin, carteira): `POST /operacao/central-vendas/:slug/sync-runs` com
`{ "dateFrom": "YYYY-MM-01", "dateTo": "YYYY-MM-DD", "clienteContaId": <conta> }` → 202 com o run;
acompanhar em `GET /operacao/central-vendas/:slug/sync-runs/:runId`. É o mesmo botão manual da Central
(`reutilizarCompletedPublicado = false`): gera um import **novo** candidate e o publica ao completar
(`promoverCandidatesDoRun`). O import antigo não é editado nem apagado; passa a ser só histórico
(e elegível para a retenção — ver `RETENCAO.md` na branch `feat/otimizacao-banco-retencao`).

Ordem e ritmo:
- uma linha por vez, menores primeiro; não rodar em paralelo com a rodada noturna;
- **não** incluir as contas 25 e 66 até o `SYNC_DB_CONNECTION_LOST` estar resolvido (o run da conta grande derruba a
  conexão; repetir só soma run falho);
- cada pack custa +1 `GET /packs/:id`; acompanhe 429 e o tempo do run.

Parar se: o run terminar `failed`; a cobertura publicada não for o mês inteiro; o passo 3 mostrar excesso > 0 no import novo.

## 3. Validar cada linha (somente leitura)
Rodar de novo a consulta do passo 1: a linha deve **sumir** (o vigente passou a ser o import novo, publicado após o fix).
Conferir também, no import novo:
- Σ `frete_seller` por shipment compartilhado == custo do shipment (componentes com a marca de rateio);
- faturamento e número de pedidos da competência iguais ao vigente anterior (± pedidos que mudaram de status no ML);
- margem/LC sobem exatamente pelo excesso removido, salvo mudanças legítimas de status/claims desde a publicação antiga.

## 4. Efeitos colaterais (decisão de negócio, antes de executar)
- **Painel de Contas**: o snapshot mensal só é usado quando `centralImportIds` == imports vigentes. Ao republicar,
  o Painel passa a mostrar a soma ao vivo dos vigentes (e perde a "MC do fechamento oficial" do snapshot) até o
  snapshot daquela competência ser reconstruído.
- **Financeiro**: fechamentos já entregues ao cliente são snapshots selados e não mudam; a Central/Margem passa a
  divergir deles pelo valor do excesso. Avisar quem atende o cliente antes de reprocessar um mês já entregue.
- **Claims/devoluções**: um run de mês antigo relê o pós-venda atual; diferenças além do frete são dado mais novo, não regressão.

## Rollback
Não há edição a desfazer: o fechamento antigo continua no banco até uma retenção removê-lo. Para voltar a exibir o antigo
seria preciso despublicar o novo — não há rotina para isso; é decisão do Maestro. Por isso: validar cada linha antes da próxima.

## Testes
`server/tests/margemRealizadaRepublicacaoFretePack.test.js` prova, do repositório ao agregado por MLB: republicado
substitui o antigo e conserva o frete do pack; sem republicar o realizado continua duplicado; ordem por `published_at`;
cobertura parcial não responde o mês; outra conta nunca entra; candidate não substitui published.
