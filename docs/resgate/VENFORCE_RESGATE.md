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

## 5. Classificação

A classificação tem dois eixos, independentes.

**Origem do preço** (`resgateHistorico`, nada inventado):

- `SEM_ALTERACAO_REGISTRADA`, sempre com uma ressalva: até esta versão, o PUT de preço em /anuncios não deixava log.
- `ALTERADO_MANUAL`: há log `anuncios_meli.preco.alterar`.
- `ALTERADO_AUTOMACAO`: Central de Margem (`margem_precificacao_aplicacoes`), rebate ou transferência de promoção.
- `ALTERADO_ORIGEM_INDETERMINADA`: o preço observado mudou entre fontes datadas, sem evento que explique.
- `HISTORICO_INSUFICIENTE`.

As fontes do histórico são snapshot do Motor, cadastro sincronizado, relatórios salvos, leitura ao vivo, `items/{id}/prices.last_updated` e o preço unitário das vendas reais.

**Situação financeira:**

- `DADOS_INSUFICIENTES`: componente essencial desconhecido.
- `MARGEM_DESCONHECIDA`: frete não verificado, subsídio desconhecido com margem abaixo da meta, ou snapshot legado.
- `MARGEM_ANTIGA_INFLADA`: a margem exibida passa a real em mais de 1 p.p.
- `SNAPSHOT_DESATUALIZADO`.
- `PROMOCAO_SUBSIDIADA`.
- `ABAIXO_DA_META`: a meta é por conta. Ficar abaixo dela não é erro de cálculo.
- `PREJUIZO`.
- `PRECO_OK`.

**Meta da conta**, em ordem de prioridade:

1. Configurada (`resgate_config_contas`, ou `--metas` na CLI).
2. Último relatório salvo do cliente.
3. Padrão do Motor (10%), marcado como "não validada".

## 6. Auditoria: escala e segurança do PostgreSQL

`resgateAuditoriaService` audita **uma conta por vez**. Isso vale para a CLI e, no servidor, para a única execução `em_andamento`, garantida por um índice único.

- **Camada 1 (só banco):** páginas de 300 linhas por keyset `(cliente_conta_id, item_id)`. As vendas usam o import publicado canônico por competência e os eventos são agregados por conta. Nenhum join cartesiano. Sessão com `statement_timeout`.
- **Camada 2 (ao vivo, limitada a N anúncios por conta):**
  - Prioriza mudança recente, margem inflada, prejuízo, abaixo da meta, desconhecida e dados insuficientes com venda.
  - `criarFetchSomenteLeitura`: recusa método diferente de GET e qualquer corpo. Espaçamento mínimo entre chamadas e pausa global com Retry-After após 429. Falha vira motivo, não exceção.
  - Na CLI local, `noRefresh`: o processo **nunca** renova o token de produção.
- **Retomada:** checkpoint por conta (`aposItemId`, camada). Conta concluída não é relida.
- **Cancelamento:** `AbortSignal` (Ctrl+C na CLI, `cancelar=true` no servidor).
- **Abrir a tela não recalcula nada:** ela só lê a última execução concluída.
- **Retenção:** as três últimas execuções.

## 7. XLSX de recuperação (`resgatePlanoXlsx`)

O arquivo tem as abas **Resumo**, **Plano de preços**, **Pendências**, **Todos os anúncios** e **Contas** (matriz).

- O topo de cada aba identifica a auditoria (execução e datas) e avisa que os dados não vêm de relatório salvo e que a proposta só vale para o preço visto.
- As fórmulas exigem `ISNUMBER` em cada entrada. Célula vazia significa desconhecido.
- A coluna **Confere com backend** compara a margem calculada pela fórmula com a do contrato. O teste recalcula no LibreOffice.
- **Status da revisão** aceita PENDENTE, APROVADO, REJEITADO, AJUSTADO ou INVALIDADO.
- As correções de `fix/xlsx-frete-integridade` estão na base desta branch e não foram duplicadas: a Matriz das Automações continua com o próprio arquivo corrigido.

## 8. Dry-run e futura execução em lote (`resgateDryRun`)

`ESCRITA_REAL_DISPONIVEL = false` é uma constante, não depende de variável de ambiente. `executarLote()` sempre lança erro.

O dry-run aplica, a cada proposta:

1. Exige aprovação humana.
2. Recusa restrições (promoção ativa, variações).
3. Aplica o limite de variação (30%), o limite por lote (20) e o limite por conta (100).
4. Revalida o preço atual com GET. **Se o preço mudou desde a análise, a proposta é invalidada e nada é sobrescrito.**
5. Reconfere a meta no preço proposto com cotação ao vivo.
6. Descreve a escrita que seria feita, a verificação pós-escrita (GET `sale_price`) e a compensação (PUT com o preço visto).

O tratamento de 429 e de falha parcial vem do fetch somente leitura.

Para ligar a escrita é preciso outra entrega, com revisão. Ela deve incluir: lease por item (reaproveitando o fencing do cockpit `margem_precificacao_aplicacoes`), idempotência, `antesDeEscrever` do `meliPrecoService` e auditoria em `activity_logs`.

## 9. API e tela

**API** em `/resgate`, com JWT, acesso de automações e carteira em toda rota por conta:

- `GET /visao-global`
- `GET /contas/:id`
- `GET /contas/:id/itens` (paginada, com filtros)
- `GET /contas/:id/itens/:mlb`
- `POST /contas/:id/itens/:mlb/simular` (GET ao vivo)
- `POST /contas/:id/itens/:mlb/revisao` (exige o preço visto; se divergir, responde 409)
- `GET /plano.xlsx` (global: só os anúncios com ação)
- `GET /contas/:id/plano.xlsx`
- `POST /contas/:id/dry-run`

Sem a migration `20261112_venforce_resgate.sql`, todas as rotas respondem 503. A migration não é aplicada no boot.

**Como a tela recebe dados:** a auditoria roda pela CLI em modo somente leitura e grava em arquivo. Depois, `scripts/resgate/importarParaPg.js --dados <dir> --confirmar` carrega o resultado. Esse importador **escreve**, e só nas tabelas `resgate_*`; por isso exige autorização. Validação no PostgreSQL local: 39.968 anúncios importados em 12,6 s.

**XLSX global do servidor:** inclui só os anúncios que exigem ação imediata, isto é, revisar preço, margem inflada, prejuízo e pendências com venda nos últimos 30 dias. São até 1.500 por conta, em ordem de prioridade. Medição: 3,2 MB e 2.925 linhas, contra 1,3 GB de RSS sem o filtro. A planilha completa sai pela CLI ou pelo XLSX por conta.

**Tela:** `Portal/resgate.html` (menu Execução → Resgate). Fluxo:

1. Visão global: KPIs e contas.
2. Conta: matriz, filtros e tabela paginada.
3. Gaveta do anúncio: componentes com fonte e confiança, bloqueios, histórico, simulação ao vivo e revisão.
4. Aba Ativação.

## 10. Ativação por conta (sem hotfix por seller)

`resgateAtivacao.planoDeAtivacao` lê as matrizes e propõe a próxima onda, com até 5 contas: primeiro as `LIBERAVEL`, depois as `LIBERAVEL_COM_RESSALVAS`, ordenadas por risco. Ele devolve os valores **explícitos** das duas variáveis existentes, sempre juntas:

- `FRETE_COTACAO_CONFIAVEL_SELLERS` (ml_user_id)
- `FRETE_LEGADO_BLOQUEAR_CONTAS` (cliente_conta_id)

Procedimento:

1. Atualizar as duas variáveis no Render e reiniciar.
2. Recalcular **só** as contas da onda, uma por vez.
3. Acompanhar no Resgate a porcentagem de linhas com frete avaliado, as falhas e os desconhecidos.
4. Rodar a próxima onda.

Para reverter, remover os ids das duas listas e reiniciar. **Nunca usar `*`.**
