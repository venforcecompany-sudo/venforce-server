# Fechamento financeiro pela API do Mercado Livre

Fechamento mensal de conta **Mercado Livre** sem planilha de vendas. Os números
vêm do que a Central de Vendas já sincronizou da API do ML (import `PUBLISHED`
vigente da competência). O resultado tem o **mesmo formato** que
`POST /fechamentos/financeiro` devolve para planilha ML, para o front reusar
`montarPayloadFechamento` (`frontend-react/src/utils/fechamentoPayload.js`) e o
salvamento de entrega, e para o relatório público (`Portal/relatorio-publico.js`,
`extractData`) renderizar igual.

Código: `server/services/fechamentoFinanceiro/fechamentoViaApiService.js`
(serviço), `server/controllers/financeiroVisaoController.js` (controller fino),
`server/routes/financeiroVisaoRoutes.js` (rotas). Testes:
`server/tests/fechamentoViaApiService.test.js`.

## Endpoints

Mesmos middlewares das demais rotas de `/financeiro/:cliente`:
`authMiddleware`, `requireAutomacoesAccess`, `requireClienteNaCarteira("cliente")`.

### `GET /financeiro/:cliente/fechamento-api/status?conta=<clienteContaId>&periodo=YYYY-MM`

Diz o que a API tem para a competência, sem calcular nada.

```json
{
  "ok": true,
  "marketplace": "meli",
  "periodo": "2026-10",
  "sync": {
    "disponivel": true,
    "importId": 123,
    "publicadoEm": "2026-11-09T03:12:00.000Z",
    "coberturaDe": "2026-10-01",
    "coberturaAte": "2026-10-31",
    "completo": true,
    "motivoIncompleto": null
  },
  "runEmAndamento": null
}
```

- Sem import publicado: `sync.disponivel=false`, demais campos de `sync` `null`
  (exceto `completo:false`) e `motivoIncompleto:"Mês ainda não sincronizado."`.
- `runEmAndamento` = `{ id, status, criadoEm }` quando há sync `queued`/`running`
  da conta, senão `null`. É informativo; não bloqueia o fechamento.

### `POST /financeiro/:cliente/fechamento-api`

Body JSON:

```json
{ "clienteContaId": 48, "periodo": "2026-10", "ads": "1234,56", "venforce": "0",
  "affiliates": "0", "fullCost": "0", "additionalCosts": "0" }
```

Ajustes em texto pt-BR ou número (`parseMoneyValue`). Campo vazio ou ausente vale
zero. Valor ambíguo é `400 AJUSTE_INVALIDO`.

Resposta `200`:

```json
{
  "ok": true,
  "fonteVendas": "api",
  "summary": { "...mesmas chaves do summary de processMeli..." },
  "competencia": { "periodoSolicitado": "2026-10", "periodoDetectado": "2026-10", "...": "..." },
  "detailedRows": [ "..." ],
  "unmatchedIds": ["MLB333"],
  "unmatchedCosts": [],
  "ignoredRowsWithoutCost": 1,
  "ignoredRevenue": 50,
  "emptySales": false,
  "message": "Alguns anúncios do MELI não possuem custo cadastrado. ...",
  "costsSource": "base",
  "costsBase": { "id": 2, "slug": "base-cliente", "nome": "Base Cliente" },
  "sync": { "...igual ao status..." },
  "runEmAndamento": null,
  "excelBase64": null
}
```

Diferenças em relação à planilha no envelope:

- `fonteVendas: "api"` diz a origem. `calculationMode` continua `"real_meli_vendas"`
  de propósito: é o valor que o front já rotula.
- `excelBase64` é `null`. A API não gera planilha.
- `unmatchedCosts` é sempre `[]`. A API não tem custo órfão (custo sem venda).
- `runEmAndamento` é acrescentado à resposta do POST, além do `sync`.

Sync incompleto **não é erro**: responde `200` com `sync.completo=false` e
`summary.executiveNotes` traz `"Sincronização incompleta: …"`. O front exige
confirmação antes de salvar.

### Erros (envelope `{ "ok": false, "error": "...", "code": "..." }`)

| HTTP | `code` | Quando |
|---|---|---|
| 400 | `PERIODO_OBRIGATORIO` / `PERIODO_INVALIDO` | período ausente ou fora de `YYYY-MM` (canônico, `competenciaCanonica`) |
| 400 | `CONTA_OBRIGATORIA` | `clienteContaId` ausente ou inválido |
| 400 | `FECHAMENTO_API_SO_MELI` | a conta não é Mercado Livre |
| 400 | `AJUSTE_INVALIDO` | ADS, Venforce, afiliados, FULL ou custos adicionais ambíguos |
| 403 | `CONTA_NAO_PERTENCE_AO_CLIENTE` | conta de outro cliente (`CODIGOS_CANONICOS`) |
| 409 | `CONTA_INATIVA` | conta desativada (`CODIGOS_CANONICOS`) |
| 409 | `CENTRAL_SEM_SYNC` | nenhum import publicado para a competência (só no POST) |

## Seleção do import (fonte canônica)

Não há "pegar o mais recente" próprio. A seleção é a mesma da leitura da Central
e do Painel, em `resolveImportsForRange` (`centralVendasRepository.js`), com
`includeLegacy: false`:

1. Procura um publicado que cubra o **trecho esperado** da competência: o mês
   inteiro, ou do dia 1 até **ontem** (fuso `America/Sao_Paulo`) no mês em
   andamento. Mesma regra do noturno: nunca o dia de hoje.
2. Se nenhum publicado cobre esse trecho, usa o **publicado mais recente** da
   competência, indicado pelo diagnóstico da mesma seleção
   (`competencias[].publicadoMaisRecente`). O sync sai `completo=false`.
3. `legacy` nunca conta: não tem cobertura comprovada.

`sync.completo` = a cobertura começa no dia 1 da competência **e** termina em
pelo menos o trecho esperado. `motivoIncompleto` diz o que falta.

## Mapeamento do `summary`

Fonte dos números: `central_vendas_pedidos`, `_pedido_itens`, `_componentes` e o
`resumo_json` do import, tudo lido por `loadPedidosByImportIds`. O cálculo oficial
é `buildResumoCentralVendas` (o mesmo que gravou `resumo_json`). Nenhuma fórmula
de LC/FAT/MC foi reimplementada.

Legenda da coluna **Fonte**: `oficial` = cálculo da Central sem alteração;
`derivado` = agregação simples dos pedidos/itens/componentes persistidos;
`ajuste` = depende dos ADS/Venforce/afiliados/custos fixos informados;
`null` = a API não tem fonte honesta (nunca vira 0).

| Chave | Fonte | Como é calculada |
|---|---|---|
| `grossRevenueTotal` | oficial | FAT dos pedidos que entram no resultado (com e sem custo) |
| `refundsTotal` | derivado | soma dos componentes `cancelamento_reembolso` (negativos, como na planilha) |
| `cancelledRevenue` | derivado | igual a `refundsTotal` (como processMeli) |
| `refundsCount` | derivado | pedidos com reembolso (planilha conta linhas) |
| `lostRevenueTotal` | derivado | receita dos itens de pedidos com reembolso (planilha mede por linha) |
| `paidRevenueTotal` | **null** | "Total (BRL)" do relatório de vendas não é gravado pelo motor da API |
| `contributionProfitTotal` | oficial | `resumo_json.lucroContribuicao` do import. `null` se não há LC |
| `averageContributionMargin` | derivado | LC / base do LC (fração). `null` sem LC ou sem base |
| `finalResult` | ajuste | LC − ADS − Venforce − afiliados − FULL − custos adicionais. `null` sem LC |
| `fullCostTotal`, `additionalCostsTotal` | ajuste | valores informados |
| `tacos` | ajuste | `computeTacos(ads, FAT)` (`financeiroShared`) |
| `tacox` | ajuste | `computeTacox(ads, venforce, afiliados, FAT)` |
| `platformAdjustmentTotal`, `platformAdjustmentRowsCount` | **null** | ajuste de plataforma só existe no motor da planilha |
| `calculationMode` | — | `"real_meli_vendas"` (ver nota de envelope acima) |
| `revenueWithCost` | oficial | FAT dos pedidos com custo (`faturamentoComCusto`) |
| `revenueWithoutCost` | oficial | FAT dos pedidos bloqueados por custo (`receitaBloqueada`) |
| `calculatedCoveragePercent` | oficial | `buildCoverage` (mesma função da planilha) |
| `financialConfidence` | derivado | `buildCoverage`; vira `parcial` se há financeiro pendente |
| `revenueWithFinancialData` | derivado | FAT dos pedidos sem pendência de tarifa de venda nem frete |
| `revenuePendingFinancial` | derivado | FAT dos pedidos com tarifa ou frete pendente |
| `revenueCalculable` | derivado | FAT dos pedidos válidos com LC calculado (base do MC) |
| `financialDataCoveragePercent` | derivado | `revenueWithFinancialData / grossRevenueTotal` |
| `salesWithFinancialDataCount` | derivado | pedidos com financeiro completo (planilha conta linhas) |
| `salesPendingFinancialCount` | derivado | pedidos com financeiro pendente |
| `pendingFinancialWarning` | derivado | texto do aviso, ou `null` sem pendência |
| `costConflicts`, `costConflictWarnings`, `ambiguousCostIds` | **null** | conflito de custo por MLB não é gravado pelo sync |
| `contributionMarginCalculated` | derivado | LC / `revenueCalculable`. `null` sem LC |
| `finalMarginCalculated` | derivado | `finalResult` / `revenueCalculable`. `null` sem LC |
| `profitCoversRevenue` | derivado | igual a `revenueCalculable` |
| `excludedStatusRevenue` | derivado | FAT dos pedidos fora do resultado (cancelado, devolvido, reembolsado, mediação) |
| `excludedStatusCount` | derivado | pedidos fora do resultado (planilha conta itens) |
| `adsTotal`, `venforceTotal`, `affiliatesTotal` | ajuste | valores informados |
| `executiveNotes` | derivado | avisos: anúncio sem custo, financeiro pendente, pedidos fora, sync incompleto e fonte API |

Chaves de nível superior: `emptySales` (sem pedidos no resultado), `message`,
`ignoredRowsWithoutCost` (anúncios sem custo), `ignoredRevenue` (receita sem custo).

### `detailedRows`

Uma linha por anúncio (MLB), com as mesmas chaves da planilha:
`"# de anúncio"`, `"Título do anúncio"`, `Unidades`,
`"Preço unitário de venda do anúncio (BRL)"`, `"Venda Total"`,
`"Preço de custo total"`, `LC`, `MC` (em percentual, como na planilha),
`"Cobertura de custo"` (`com custo`, `sem custo`, `financeiro pendente` ou
`parcial`). Acrescentam-se `SKU` e `"Total (BRL)"`/`"Ajuste plataforma (BRL)"`
com `null` (sem fonte na API). Só entram itens de pedidos que contam no resultado.

### `unmatchedIds`

MLBs de itens sem custo cadastrado na base do sync (`custo_produto_ausente`).
Anúncio sem MLB aparece como `SEM_ID`.

## Diferenças conhecidas em relação à planilha

1. **Tarifa de venda ou frete ausentes contam como zero no LC.** O LC da Central
   (`resumo_json.lucroContribuicao`) é o número oficial e é usado sem alteração.
   Quando a tarifa de venda ou o frete de um pedido não vieram da API, o motor
   não os desconta. A planilha, por outro lado, deixa essas vendas fora do LC
   (LC `null`). O aviso `pendingFinancialWarning` diz isso ao usuário. Antes de
   publicar, vale conferir os pedidos com `revenuePendingFinancial > 0`. Mudar
   essa regra no motor da Central exige decisão de produto e está fora do escopo
   desta entrega.
2. **Granularidade.** A planilha conta linhas (item de venda). A API conta pedidos
   (`salesPendingFinancialCount`, `salesWithFinancialDataCount`, `refundsCount`,
   `excludedStatusCount`).
3. **Reembolso é pedido-level.** A API grava o reembolso por pedido, não por item.
   `lostRevenueTotal` soma a receita de todos os itens do pedido reembolsado.
4. **Margem sem base é `null`.** A planilha devolve `0` quando não há base para a
   margem. Aqui vai `null`, pela regra de não inventar zero.
5. **Chaves sem fonte na API** voltam `null`: `paidRevenueTotal`,
   `platformAdjustmentTotal`, `platformAdjustmentRowsCount`, `costConflicts`,
   `costConflictWarnings`, `ambiguousCostIds`.
6. **Custos.** Os custos são os da base vinculada, aplicados no sync (`custo_produto`).
   `costsBase` é a base usada pelo run (`central_vendas_sync_runs.base_id`). Se a
   base mudou depois do sync, o resultado **não é recalculado**. O usuário
   re-sincroniza.
7. **Cancelados e devolvidos** seguem `pedidoEntraNoResultado` /
   `normalizePedidoStatus`, as regras da Central. Pedido de devolução parcial
   continua no resultado (`posVendaParcial`).
8. **Frete ausente** (`frete_seller_ausente`) é pendência de financeiro. O LC não
   desconta o frete que não veio da API.

## Validação contra a planilha

`server/scripts/comparar-fechamento-api-vs-planilha.js` roda os dois caminhos sobre
a mesma competência e imprime a diferença por chave do `summary` e as maiores
divergências por MLB.

```
node server/scripts/comparar-fechamento-api-vs-planilha.js --cliente <slug> --conta <clienteContaId> --periodo YYYY-MM --planilha <vendas.xlsx>
```

- Usa `DATABASE_URL` do shell e faz **somente leitura** (nenhum `INSERT`/`UPDATE`).
- Exige que a planilha seja a do mesmo período e da mesma conta.
- **Não rodar contra produção sem autorização.** Esta entrega só deixa o script
  pronto e documentado.
