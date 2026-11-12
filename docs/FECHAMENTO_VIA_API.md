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
`server/tests/fechamentoViaApiService.test.js`, `server/tests/fechamentoViaApiCustos.test.js`
(custos: sync/base/upload) e `server/tests/fechamentoViaApiController.test.js` (contrato
HTTP, JSON e multipart).

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
  "runEmAndamento": null,
  "base": {
    "vinculada": true,
    "id": 3,
    "slug": "custos-rikam-meli",
    "nome": "Custos - RIKAM - MeLi",
    "atualizadaEm": "2026-11-10T14:00:00.000Z",
    "aplicadaNoSync": false
  }
}
```

- Sem import publicado: `sync.disponivel=false`, demais campos de `sync` `null`
  (exceto `completo:false`) e `motivoIncompleto:"Mês ainda não sincronizado."`.
- `runEmAndamento` = `{ id, status, criadoEm }` quando há sync `queued`/`running`
  da conta, senão `null`. É informativo; não bloqueia o fechamento.
- `base` = a base de custos vinculada **atual** da conta (mesma resolução do sync,
  `obterBaseDaConta`). Sem base: `vinculada:false` e os demais campos `null`/`false`.
  - `atualizadaEm` = o maior entre `bases.updated_at` e o `updated_at` dos custos da
    base (nem toda tela de custo toca a base).
  - `aplicadaNoSync` = o sync do import vigente usou **esta** base e ela não mudou
    depois. É `false` quando: não há import; o run não tinha base; a base do run é
    outra; ou `atualizadaEm` é posterior ao **início** do run que gerou o import
    (`started_at`, ou `created_at`/`publicadoEm` na falta dele). Usamos o início, e não o
    `publicadoEm`, porque o sync lê a base no começo: uma alteração durante o run já
    não entrou. Sem data de alteração conhecida, a mesma base conta como aplicada.
  - Com `aplicadaNoSync=false` o front usa `custosOrigem=base` por padrão.

### `POST /financeiro/:cliente/fechamento-api`

Body **JSON** ou **multipart/form-data**, com os mesmos campos:

```json
{ "clienteContaId": 48, "periodo": "2026-10", "ads": "1234,56", "venforce": "0",
  "affiliates": "0", "fullCost": "0", "additionalCosts": "0", "custosOrigem": "sync" }
```

`custosOrigem` diz de onde vêm os custos:

| Valor | Custos usados |
|---|---|
| `sync` (padrão) | os que o sync gravou no import (comportamento original; nada é recalculado) |
| `base` | a base vinculada **atual** da conta, reaplicada agora. Resolve base alterada depois do sync e base recém-salva |
| `upload` | a planilha enviada no campo de arquivo `costs` (só multipart), reaplicada agora |

A planilha de custos usa o mesmo upload do fechamento por planilha: `multer`
`memoryStorage`, limite de 20 MB, `parseSpreadsheet` do arquivo inteiro e as mesmas
colunas de `parseMeliCostRows` (`# de anúncio`/`MLB`/`ID`, `Preço de custo`/`Custo`,
`Imposto`), via `buildCentralCostMap`/`getCentralCostForAd`. Este endpoint **não grava**
a planilha: salvar como base de custos é o `POST /importar-base` existente (o front
chama antes e depois processa com `custosOrigem=base`).

**Recálculo sem segunda matemática.** Em `base` e `upload`, os itens persistidos
passam de novo pela MESMA função do sync, `calcularResultadoItem`
(`centralVendasSyncService.js`, extraída de `buildMotorFromOrders`), e o pedido por
`acumularItemNoPedido` + `finalizarResultadoPedido`. Ficam os valores persistidos de
receita (`receita_produto`), tarifa (componente `tarifa_venda`), frete (componente
`frete_seller`, já rateado) e reembolso (vieram da API). Mudam só `custo_produto`,
`imposto_interno` e o que deriva deles: LC e MC do item e do pedido, confiança
(`bloqueado` sem custo), pendências de custo/imposto, `unmatchedIds` e cobertura. As
regras de financeiro pendente (tarifa/frete fora do LC) continuam. O teste
`fechamentoViaApiCustos.test.js` prova isso: pedidos gerados pelo motor real com a
base A e reaplicados com a base B ficam iguais ao motor rodado direto com a base B.

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
  "costsSource": "sync",
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
- `costsSource` é `"sync" | "base" | "upload"` (o `custosOrigem` usado). `costsBase` é a
  base usada: a do run em `sync`, a atual em `base`, `null` em `upload`.
  `summary.executiveNotes` diz de onde vieram os custos quando não são os do sync.

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
| 400 | `CUSTOS_ORIGEM_INVALIDA` | `custosOrigem` fora de `sync`/`base`/`upload`, ou arquivo `costs` enviado com origem que não é `upload` (seria ignorado em silêncio) |
| 400 | `CUSTOS_ARQUIVO_OBRIGATORIO` | `custosOrigem=upload` sem o arquivo `costs` |
| 409 | `BASE_NAO_VINCULADA` | `custosOrigem=base` e a conta não tem base vinculada |
| 422 | `CUSTOS_PLANILHA_INVALIDA` | nenhuma linha de custo reconhecida (arquivo ilegível, sem coluna de anúncio/custo ou só custo zero) |
| 413 | `CUSTOS_ARQUIVO_GRANDE` | planilha de custos acima de 20 MB |
| 400 | `UPLOAD_INVALIDO` | outro erro do multipart (ex.: campo de arquivo que não é `costs`) |

Base vinculada sem nenhum custo cadastrado com `custosOrigem=base` não é erro (igual
ao sync): as vendas ficam sem custo e a nota do `summary` avisa.

### `GET /financeiro/:cliente/full?conta=<clienteContaId>&periodo=YYYY-MM[&atualizar=1]`

Valor sugerido para o ajuste **FULL** (o mesmo `fullCost` acima e do fechamento por
planilha). O drawer preenche o campo sozinho, com o selo "Faturamento ML", igual ao
ADS (`/ads`). Editar o campo vira "Manual". O payload salvo guarda
`metadados.fullCostOrigem`. Código: `server/services/financeiroFullService.js`.

- **Fonte:** API de billing do ML da conta exata (identidade estrita),
  `/billing/integration/periods/key/{key}/group/ML/details?document_type=BILL`.
- **Entram** (lista fechada; o prefixo `CF` sozinho não serve, porque `CFONPN` é
  taxa de parcelamento): `CFWA` armazenagem diária, `CFBA` armazenamento
  prolongado, `CFCBI`/`CFCBE` coleta e `CFRS` retirada/descarte. O resumo da
  fatura rotula o `CFWA` como "Estorno por Fulfillment Warehousing", mas cada
  lançamento é `CHARGE` "Tarifa pelo serviço de armazenamento Full": é custo.
- **Não entram** `CFFE`/`CFFI` (nem os estornos `BFFE`/`BFFI`): são o frete de cada
  venda Full, igual ao `senders[].cost` que o fechamento já desconta por venda.
  Conferido em 12/11/2026 (shopping_86, 5 vendas: valores iguais centavo por
  centavo).
- **Competência ≠ fatura:** a fatura `2026-10-01` cobre ~10/set a 09/out. O mês M
  soma os lançamentos com `creation_date_time` em M, lidos das faturas M e M+1.
  Sobras atrasadas que caem em M+2 ficam de fora (R$ 0,72 em out/2026 na
  shopping_86). O mês fica `definitivo` quando M e M+1 estão `CLOSED`; antes disso
  o cache (`financeiro_full_cache`) vale 6 h. `atualizar=1` ignora o cache.
- **Ritmo:** o `/details` aceita ~1 chamada a cada 14 s e no máximo 1000 itens por
  página. Uma conta grande leva ~1 min na primeira consulta (shopping_86 out/2026:
  4 páginas, 54 s, **R$ 1.005,78**).
- **Paginação instável:** a ordem entre páginas não é estável. Cada fatura é lida
  até os `detail_id` únicos fecharem com o `total` (até 3 passadas). Se não
  fechar, a resposta é `ML_BILLING_INCOMPLETO`, nunca um valor a menor.
- **Sem dado** (`disponivel:false`, nada cacheado): `NO_TOKEN`,
  `ML_BILLING_SEM_PERMISSAO` (401/403), `ML_BILLING_LENTO` (prazo de 120 s),
  `ML_BILLING_INCOMPLETO` ou `ML_BILLING_API_ERROR`. O campo fica manual.

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
é `buildResumoCentralVendas` para o faturamento (o mesmo cálculo que gravou
`resumo_json`). O **LC segue a planilha**: é a soma, pedido a pedido, do LC dos pedidos
com financeiro completo e custo. Não se usa o `lucroContribuicao` do `resumo_json`.

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
| `contributionProfitTotal` | derivado | soma do LC dos pedidos da **base do LC** (financeiro completo e com custo). `null` se a base estiver vazia, nunca 0 |
| `averageContributionMargin` | derivado | LC / `revenueCalculable` (fração). `null` sem LC ou sem base |
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
| `revenueCalculable` | derivado | FAT dos pedidos da **base do LC** (financeiro completo e com custo). Base do LC, MC e Resultado Final |
| `financialDataCoveragePercent` | derivado | `revenueWithFinancialData / grossRevenueTotal` |
| `salesWithFinancialDataCount` | derivado | pedidos com financeiro completo (planilha conta linhas) |
| `salesPendingFinancialCount` | derivado | pedidos com financeiro pendente |
| `pendingFinancialWarning` | derivado | texto do aviso, ou `null` sem pendência |
| `costConflicts`, `costConflictWarnings`, `ambiguousCostIds` | **null** | conflito de custo por MLB não é gravado pelo sync |
| `contributionMarginCalculated` | derivado | LC / `revenueCalculable` (mesma base). `null` sem LC |
| `finalMarginCalculated` | derivado | `finalResult` / `revenueCalculable` (mesma base). `null` sem LC |
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
`"Preço de custo total"`, `LC`, `MC` (em percentual, como na planilha). `LC` e `MC` somam só os itens da base do LC; a receita de itens com financeiro pendente continua em `"Venda Total"`, mas fica fora da margem. Anúncio sem nenhum item na base tem `LC` e `MC` `null`.
`"Cobertura de custo"` (`com custo`, `sem custo`, `financeiro pendente` ou
`parcial`). Acrescentam-se `SKU` e `"Total (BRL)"`/`"Ajuste plataforma (BRL)"`
com `null` (sem fonte na API). Só entram itens de pedidos que contam no resultado.

### `unmatchedIds`

MLBs de itens sem custo (`custo_produto_ausente`) na fonte de custos usada: base do
sync, base atual ou planilha enviada.
Anúncio sem MLB aparece como `SEM_ID`.

## Diferenças conhecidas em relação à planilha

1. **Financeiro pendente fica fora do LC, como na planilha.** Pedido com tarifa de
   venda ou frete pendentes (não vieram da API) entra no faturamento
   (`grossRevenueTotal`), mas não entra no LC, no MC nem no Resultado Final. Não se
   desconta zero no lugar do componente ausente. O aviso `pendingFinancialWarning`
   e `revenuePendingFinancial` informam o valor. Se todos os pedidos estiverem
   pendentes, o LC é `null`, nunca zero.
   **Diferença para a Central:** o LC do motor da Central (usado no Painel de
   Contas e na Central de Margem) não exclui o financeiro pendente: a tarifa e o
   frete ausentes contam como zero. Por isso o LC do fechamento pode ser diferente
   do LC mostrado nessas telas. Essa regra do motor não foi alterada aqui.
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
6. **Custos.** Por padrão (`custosOrigem=sync`) são os da base vinculada, aplicados
   no sync (`custo_produto`), e `costsBase` é a base do run. Se a base mudou depois
   do sync (`status.base.aplicadaNoSync=false`) ou a conta não tem base, o front usa
   `custosOrigem=base` ou `upload`, que reaplicam os custos sem re-sincronizar (ver
   POST acima). Imposto: `parseMeliCostRows` converte fração em percentual (0,06 →
   6) e o motor divide por 100 o que for maior que 1, como no sync.
7. **Cancelados e devolvidos** seguem `pedidoEntraNoResultado` /
   `normalizePedidoStatus`, as regras da Central. Pedido de devolução parcial
   continua no resultado (`posVendaParcial`).
8. **Frete ausente** (`frete_seller_ausente`) é pendência de financeiro, igual à tarifa
   de venda: o pedido fica fora da base do LC (ver item 1).
9. **Ajuste de plataforma não vem da API.** A planilha calcula o LC a partir do
   `Total (BRL)`. Em parte das vendas, o `Total (BRL)` traz um desconto que não está
   em nenhuma coluna (receita − tarifa − frete ≠ Total). A `sale_fee` da Orders API
   e o custo do envio não incluem esse valor, então o LC da API fica maior nessas
   vendas. Ver o caso real abaixo.
10. **Venda devolvida.** A planilha mostra a venda devolvida pelo número do pack, com
    a receita no faturamento, `Total (BRL)` 0 e o reembolso na coluna de
    cancelamentos. A API grava o pedido como `cancelled`: ele sai do faturamento e
    vai para `excludedStatusRevenue`. O reembolso é o `transaction_amount_refunded`
    do pagamento, o valor inteiro devolvido ao comprador.

## Validação contra a planilha

`server/scripts/comparar-fechamento-api-vs-planilha.js` roda os dois caminhos sobre
a mesma competência e imprime a diferença por chave do `summary` e as maiores
divergências por MLB.

```
node server/scripts/comparar-fechamento-api-vs-planilha.js --cliente <slug> --conta <clienteContaId> --periodo YYYY-MM --planilha <vendas.xlsx> [--custos <custos.xlsx> | --custos-origem sync|base]
```

- Usa `DATABASE_URL` do shell e faz **somente leitura** (nenhum `INSERT`/`UPDATE`).
- Exige que a planilha seja a do mesmo período e da mesma conta.
- `--custos`: o mesmo arquivo vai para os dois caminhos (upload de custos na planilha
  e `custosOrigem=upload` na API). Sem ele, a planilha usa a base vinculada e a API
  usa `--custos-origem` (padrão `sync`).
- **Não rodar contra produção sem autorização.**

### Caso real: Rikam (`rikam_loja`, conta 48), set/2026 — rodado em 10/11/2026

A conta não tem base de custos vinculada. Por isso o sync gravou tudo sem custo, e
com `custosOrigem=sync` a API dava LC `null` e cobertura 0%. Com a planilha de vendas
e a planilha de custos, o fechamento por planilha dava LC R$ 892,04 (cobertura 98,67%).

Resultado com a mesma planilha de custos enviada à API (`custosOrigem=upload`):

| Chave | Planilha | API | Δ |
|---|---|---|---|
| `grossRevenueTotal` | 2.632,08 | 2.570,18 | −61,90 |
| `contributionProfitTotal` (LC) | 892,04 | 906,24 | +14,20 |
| `calculatedCoveragePercent` | 98,67 | 98,64 | −0,03 |
| `revenueWithoutCost` | 34,90 | 34,90 | 0 |
| `revenuePendingFinancial` | 0 | 0 | 0 |
| `refundsTotal` | −43,44 | −61,90 | −18,46 |
| `excludedStatusRevenue` | 0 | 61,90 | +61,90 |

Nos dois caminhos fica 1 MLB sem custo, o mesmo.

- **Faturamento, −61,90:** é a venda devolvida. Na planilha ela aparece como o pack
  2000015086373729; na API é o pedido 2000018516534370, `cancelled`, do
  MLB6250826876. A planilha soma a receita dela no faturamento; a API tira o pedido
  do resultado (diferença 10). Essa venda **não muda o LC**: na planilha, o `Total
  (BRL)` dela é 0 (receita − tarifa − frete − reembolso de 43,44), então não soma LC;
  na API, ela está fora do resultado.
- **LC, +14,20:** vem do ajuste de plataforma (diferença 9). Em 16 linhas da
  planilha, o `Total (BRL)` é menor que a soma das colunas, e essas diferenças somam
  −15,20:
  - 14 vendas com tarifa de 10,05: −1,00 cada;
  - 1 venda com tarifa de 10,18: −0,20;
  - 1 venda de um MLB sem custo: −1,00. Esta fica fora do LC nos dois caminhos.

  Sobram 14,00 + 0,20 = **14,20**, exatamente a diferença do LC: MLB6250826876
  +11,20, MLB7692121774 +2,00 e MLB5277206959 +1,00. A API não tem fonte para esse
  desconto.
- **Reembolso:** a planilha mostra 43,44, que é o `Total` da venda antes do
  reembolso. A API mostra 61,90, o valor devolvido ao comprador.
