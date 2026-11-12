# VenForce Resgate — correção financeira e recuperação de preços (todas as contas)

Código: `server/services/resgate/`. Testes: `server/tests/resgate*.test.js`.
Nada aqui escreve no Mercado Livre. A escrita em lote **não existe** nesta versão (só dry-run).

## 1. Princípio

Há dois problemas, e cada um tem sua própria correção:

- **A. Cálculo.** Todo consumidor financeiro usa a mesma cotação (`shared/marketplaceCurrentQuoteService.buscarComissaoEFrete`), a mesma fórmula (`motorMargem/core.computeMargin`) e o mesmo contrato (`resgate/resgateContrato`).
- **B. Recuperação.** Os preços já definidos com cálculo errado são auditados, classificados, simulados e exportados.

## 2. Consumidores financeiros mapeados (12/11/2026)

| Consumidor | Caminho | Cotação de comissão/frete | Situação |
|---|---|---|---|
| Central de Margem: snapshot (worker) | `motorMargem/marginSnapshotProcessor` → `adapters/meliApiEvidenceAdapter` | `obterCotacaoAtual` → `buscarComissaoEFrete` | compartilhado (PR #402) |
| Central de Margem: leitura, lista, KPIs | `marginSnapshotReadService` + `margemConfiavel` | snapshot (sem nova cotação) | margem neutralizada se comissão/frete estão ausentes ou se a linha é legado |
| Central: Simular | `margemSimularService` → `margemCotacaoEmP` | recotado em P′ | compartilhado |
| Cockpit de precificação e Oportunidades | `motorMargem/precificacao/*` | `margemCotacaoEmP` | compartilhado |
| /anuncios: simular margem e "Você recebe" | `meliAnunciosController` → `margemCotacaoEmP` | recotado em P′ (PR #402) | compartilhado |
| /anuncios: alteração de preço | `meliAnunciosController.atualizarPreco` → `meliPrecoService` | — | **passa a gravar `anuncios_meli.preco.alterar` em activity_logs (esta branch)** |
| Automações: preview e precificação | `automacoes/precificacaoService` | `buscarComissaoEFrete` | compartilhado |
| Diagnóstico | `automacoes/diagnosticoService` | `buscarComissaoEFrete` | compartilhado |
| Rebate (promoções) | `meliAnuncios/meliPromocoesRebateService` | `buscarComissaoEFrete` | compartilhado |
| Transferência de promoções | `meliPromocoesTransferenciaService` | não calcula margem | — |
| Planilha Matriz (relatório salvo e "sem base") | `automacoes/relatoriosService`, `planilhaPrecificacaoSemBaseService` | fórmulas no XLSX | **corrigido em `fix/xlsx-frete-integridade` (base desta branch)**: ISNUMBER, rótulo histórico × recotado |
| Portal: relatórios salvos | `Portal/relatorios.js` | — | corrigido na mesma base (`Number(null)`) |
| Cliente 360 | lê `relatorios.mc` / `margem_alvo` | histórico | só leitura, sem nova cotação |
| Central de Vendas, Sentinel, Painel de Contas, Financeiro | realizado (`shipments_api`, `orders`) | custo **cobrado** | fonte do realizado (régua do Resgate) |
| Extensão do Chrome (`extension/content.js`) | cópia própria da fórmula (DOM) | — | **fora do backend: não migrada**, registrada como limitação |
| VenForce Resgate | `resgate/*` | `buscarComissaoEFrete` com `avaliarFreteSempre` (somente auditoria) | novo |

Travas por teste: `resgateNucleo.test.js` verifica que nenhum consumidor de produção passa `avaliarFreteSempre` e que o Resgate não usa constante de frete.

## 3. Ordem e confiabilidade das evidências de frete

Esta é a mesma ordem de `freteCotacaoConfiavel.avaliarFrete` (PR #402), declarada em `resgateEvidencias.ORDEM_EVIDENCIA_FRETE`:

1. `cotado_ml` (alta): `shipping_options/free?item_id`, quando a resposta é confiável (desconto `mandatory` com taxa > 0, ou anúncio sem `proximity`).
2. `estimado_dimensoes_historicas` (média): medidas de pelo menos 2 envios recentes (até 90 dias) que concordam em 60% ou mais.
3. `estimado_custo_cobrado` (baixa): mediana do custo cobrado em pelo menos 3 envios de item único, com preço dentro de ±3% e dispersão de até 10%.
4. `estimado_dimensoes_declaradas` (média): medidas `SELLER_PACKAGE_*` declaradas no anúncio.
5. Histórico antigo, com mais de 90 dias (baixa).
6. `desconhecido`: frete `null`, margem bloqueada e pendência "declarar medidas".

Estados adicionais:

- `cotado_ml_nao_verificado`: valor do ML gravado sem essa avaliação, ou seja, conta fora de `FRETE_COTACAO_CONFIAVEL_SELLERS`. Calcula margem, mas `margemConfiavel=false`.
- Verificado pelo realizado: o snapshot passa a ter confiança média quando bate com pelo menos 2 vendas reais comparáveis.
- `nao_aplicavel`: logística `not_specified` ou `custom`.

Modalidades:

- **Full:** cotação por `item_id`. As `SELLER_PACKAGE` de anúncios Full não são confiáveis.
- **Coleta** (`cross_docking`) e **Agência** (`xd_drop_off`/`drop_off`): cotação por `item_id`, avaliada quando o anúncio tem `proximity`.
- **Flex** (`self_service`): a margem não inclui o entregador próprio (pendência `FLEX_ENTREGADOR_FORA`). Por isso a modalidade nunca é marcada como "validada".
- **Abaixo de R$ 79:** a cotação por dimensões não força `free_shipping`.

## 4. Contrato financeiro (`resgate-contrato/1`)

`resgateContrato.montarContratoFinanceiro` devolve:

- **Componentes**, cada um com `{valor, fonte, observadoEm, confianca, status}`: `precoCheio`, `precoVigente`, `precoPromocional`, `precoComprador`, `subsidioMl`, `valorReconhecidoVendedor`, `descontoVendedor`, `comissao`, `frete`, `custo`, `imposto` e `taxaFixa`.
- **`resultado`:** lucro e margem existem **só** quando todos os essenciais são conhecidos. Com promoção ativa e subsídio desconhecido, sai `limiteInferior: true`.
- **`bloqueios[]`:** código, texto e `resolveCom`, que diz o que resolve a ausência.
- **`pendencias[]`** e **`inconsistencias[]`**.
- **`margemConfiavel`, `confiancaGeral`** e as datas da evidência mais antiga e da mais recente.

Regras:

- `null`, vazio ou ausente nunca vira 0.
- O subsídio do ML entra uma única vez, como `rebate` do núcleo.
- Comissão e frete são **recotados em cada preço simulado** (`resgateRecomendacao`). A faixa de R$ 79 e as tarifas por faixa são respeitadas.
