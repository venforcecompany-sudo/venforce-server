# SEO de descrição — bloqueios proporcionais

## Escopo

Ajuste local do gerador de descrição de anúncios do Mercado Livre. Não altera o Title Engine, o campo Modelo, a aplicação da sugestão ao rascunho nem o salvamento no Mercado Livre. Sem commit, deploy ou mudança de configuração de produção.

Plano aprovado: `.hermes/plans/2026-10-02_143034-seo-descricao-bloqueios-proporcionais.md`.

O vault canônico `docs/obsidian-map` não está presente neste checkout. Esta nota registra o comportamento implementado e a pendência de sincronização com o vault; não cria um vault substituto nem modifica os relatórios históricos dos experimentos.

## Fluxo preservado

1. O backend monta a ficha a partir das fontes existentes do anúncio.
2. A IA propõe uma descrição; os validadores verificam fatos, marcas, números, compatibilidade, alegações e linguagem proibida.
3. Problemas SOFT podem receber correção determinística; problemas HARD não são ignorados.
4. Se habilitado, o autorreparo mantém seu contrato: remoção localizada ou uma única chamada adicional de IA restrita aos segmentos rejeitados, seguida de revalidação.
5. O texto aprovado recebe polimento editorial e é devolvido como sugestão.
6. A UI apresenta texto e contexto dos ajustes; “Usar descrição” altera somente o rascunho. “Salvar alterações” continua sendo o caminho de escrita.

`SEO_DESCRICAO_AUTORREPARO` permanece desligado por padrão. Apenas os valores existentes `1`, `true` e `on` o habilitam. Nenhum ambiente foi modificado.

## Exceções contextuais estreitas

### Compra sem complicação

A expressão `sem complicação` / `sem complicações` deixa de ser interpretada como facilidade técnica somente quando imediatamente associada a `compra` ou `comprar`. Exemplo: “Compra simples, segura e sem complicação.”

A exceção atua sobre essa ocorrência, não sobre toda a frase. Alegações de instalação fácil, limpeza sem esforço ou desempenho presentes na mesma frase continuam sujeitas às regras anteriores. Outros termos de facilidade não são liberados por uma menção genérica a compra.

### Posicionamento firme

A frase simples “Posicione o produto de forma firme.” é tratada como modo de execução da instrução, exclusivamente na seção COMO USAR. O padrão aceita os sujeitos genéricos definidos na regra (`produto`, `peça`, `item`), sem adjetivos, complementos ou resultados adicionais.

Não libera “estabilidade garantida”, “firmeza no uso”, “evita quedas”, “proteção”, “resistência” ou outros resultados técnicos. A mesma frase fora de COMO USAR segue bloqueada quando não existe fonte que a sustente. Uma linha sem pontuação final não deve receber a exceção quando texto corrido subsequente na mesma seção continua a instrução, como `de forma firme\nsob carga`; a fronteira da instrução também é validada.

Continuam vigentes os demais validadores, inclusive logística, preço, estoque, frete, garantia, marca, medidas, quantidade, certificações e compatibilidade.

## Correção de item factual rotulado

Para `TERMO_NAO_COMPROVADO`, antes da remoção genérica do item:

- exige item de lista `Rótulo: valor`;
- exige um único fato útil cujo rótulo corresponda exatamente;
- exige que o valor factual inteiro esteja literalmente no início do valor gerado;
- exige que o sufixo seja formado exclusivamente pelos termos rejeitados, sem outro conteúdo;
- conserva o valor original presente no texto e o marcador da lista, retirando somente o sufixo.

Exemplo: ficha `Cor = Azul`; `* Cor: Azul acetinado.` torna-se `* Cor: Azul.`. Valores compostos, números e unidades não são truncados. Se “acetinado” for comprovado na ficha, não é removido.

Rótulos ambíguos, valores não reconhecidos, negação, prefixos qualificadores e sufixos mistos não são reconstruídos à força; seguem os caminhos anteriores e a guarda factual.

## Preservação factual

A detecção lexical de presença e perda factual é compartilhada por `descricaoEngine.js` e `descricaoReparo.js`, sem dependência circular.

### Correção SOFT da primeira geração

Depois de cada rodada de correção, compara os fatos úteis presentes antes e depois. Se um fato útil sem relação com os termos rejeitados perder sua última ocorrência, retorna rejeição `FATO_PERDIDO`, sem aprovar o texto mutilado. Um fato não mencionado originalmente não passa a ser obrigatório. Se o fato permanece em outra parte da descrição, remover sua ocorrência redundante não é perda.

Metadados ocultos/não listáveis e valores sem informação não viram obrigação de conteúdo. Mantém os descartes editoriais intencionais, como “Sem validade” e valor vazio que apenas ecoa seu rótulo.

### Autorreparo

`FATO_PERDIDO` identifica informação que deve permanecer; seus termos não são autorização para remover essa informação. O prompt restrito mantém esses fatos como obrigatórios. A resposta de reparo que os apaga é rejeitada; a resposta que conserva o fato e retira somente o trecho sem fonte pode ser aprovada.

### Polimento editorial

Uma regra editorial que eliminaria a única ocorrência de um fato útil é descartada, mesmo se o texto reduzido passasse na validação comum. Os descartes intencionais de valores sem informação continuam permitidos no motor; a política já existente de preservação mais conservadora no autorreparo permanece.

**Limite:** presença factual usa palavras normalizadas e números. É uma guarda lexical, não uma prova semântica nem um verificador completo de relações entre medidas e atributos.

## Interface

O estado de SEO da descrição conserva `avisos`, `ajustesEditoriais` e `autorreparo` para a resposta atual e os limpa no início de nova geração e em novo modal.

- Sucesso: apresenta avisos e ajustes editoriais em linguagem legível, além de explicar remoção localizada ou reparo por IA quando presentes.
- Falha de autorreparo: explica que o reparo foi tentado e não resolveu, preservando o motivo original e os problemas do backend.
- Não expõe a descrição rejeitada nem adiciona “Usar” em resposta inválida.
- Textos provenientes do backend são escapados antes da inserção em HTML.
- Os controles existentes de sequência/token continuam impedindo resposta atrasada de contaminar outro modal/contexto.
- Exibir ajuste/autorreparo não aplica nem salva a sugestão automaticamente.

## Validação

Casos determinísticos foram exercitados em ciclos RED → GREEN para as exceções, conservação do valor rotulado, perda SOFT, preservação no reparo e polimento. Testes adicionais exercitam a rota HTTP real com dependências externas simuladas e a UI em seu harness existente.

Comandos principais:

- `node server/tests/descricaoEngine.test.js`
- `node server/tests/descricaoReparo.test.js`
- `node server/tests/descricaoSeoHttp.test.js`
- `node server/tests/seoText.test.js`
- `node server/tests/tituloEngine.test.js`
- `node server/tests/tituloSeoHttp.test.js`
- `node Portal/anuncios-meli-detalhe-modal-ui.test.js`
- `npm --prefix server test`
- `git diff --check` e `node --check` dos arquivos de produção alterados

IA e Mercado Livre são simulados nos testes; não houve rodada de IA real nem aferição da taxa de aprovação em produção.

Resultados finais das suítes específicas: Description Engine 70 verificações; autorreparo 22; HTTP de descrição 13; seoText 59; Title Engine 50; HTTP de título 8; modal de anúncios 129. Total: **351 verificações aprovadas em sete suítes**. Os casos novos cobrem também a recusa de reconstrução com rótulo parcial: material de uma parte não é promovido a material genérico do produto e o reconhecimento da fronteira real de uma instrução sem pontuação, inclusive com continuação após linha vazia.

A revisão independente encontrou regressão na análise por linha de claims compostos atravessando newline. A implementação final mantém a análise global anterior e mascara somente a palavra “firme” na cópia interna da instrução exata autorizada em COMO USAR. A descrição devolvida não é alterada por essa máscara. Claims como `Baixo\nconsumo` e `Revestimento\neletrostático` continuam rejeitados, inclusive na rota HTTP com autorreparo desligado; testes também cobrem instrução segura junto de claim inseguro e repetição da instrução em outra seção.

Após as duas correções localizadas apontadas pela revisão, a re-verificação independente final foi aprovada, sem erro de lógica ou segurança pendente no escopo examinado. O revisor reproduziu 16 casos de fronteira e validação global e confirmou a preservação do texto original nos casos seguros. A revisão é adicional à execução das sete suítes pelo agente principal, não substitui o gate manual autenticado.

A suíte geral `npm --prefix server test` parou em `server/tests/basesTiktok.test.js:768` com “cliente é opcional para TikTok (só MELI exige)”. A mesma falha foi reproduzida executando esse teste numa cópia limpa do HEAD, criada com `git archive`, usando apenas as dependências já instaladas. Nenhum stash/reset ou alteração no checkout foi feito para essa comparação. A suíte geral não é GREEN; os arquivos posteriores à falha não foram executados pelo runner e nenhuma exclusão `TEST_SKIP` foi aplicada.

## Gate manual autenticado

Pendente: as portas locais verificadas (3000, 3001, 5173, 8080) não apresentaram serviço ativo e não foi identificado ambiente local patched autenticado. Não foi iniciado um backend com configuração de produção nem feita escrita no Mercado Livre.

Para concluir o gate, disponibilizar ambiente de teste com backend e frontend contendo o patch e sessão autenticada autorizada. Validar geração, avisos, uso apenas no rascunho, nova geração e reabertura/troca de contexto, sem clicar Salvar alterações.

Aplicar somente o JavaScript novo sobre backend publicado não valida as novas regras de backend. Testes simulados não substituem esse gate.
