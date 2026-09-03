# VenForce V3 — Prontidão de UX do frontend para o rollout de Squads (P2.9)

Pessoa 1 · branch `frontend/v3-squads-rollout-ux-readiness`

Missão: responder **uma** pergunta, com evidência e não com opinião —

> quando a Pessoa 2 inserir os dados reais de Squads, a experiência atual do
> Portal já sabe trabalhar corretamente com eles?

Nada de backend foi tocado. Nada de P2.9 foi tocado. Nenhuma Wave nova de
redesenho foi feita. O que existe aqui é auditoria da jornada atual, correção
de bugs determinísticos encontrados nela, testes que os prendem, QA visual
real e a separação explícita entre "bug" e "decisão de produto".

---

## 1. Main base

```
origin/main (HEAD) = fd2671ae4f36d72c37013095bb25b3c7149c3343
```

Confirmado com `git fetch origin` + `git rev-parse origin/main` no início da
missão. O PR #95 (UI/UX Wave 1 da Pessoa 1) **está** na main — ele é o próprio
commit de merge do HEAD:

```
fd2671a Merge pull request #95 from venforcecompany-sudo/frontend/v3-ui-ux-wave1-recovery
```

A árvore local tinha apenas arquivos **não rastreados** (tooling: `.agents/`,
`.claude/`, `.codex/`, `.impeccable/`, `docs/…`, `experiments/`, `Central_vendas/`).
Zero arquivo rastreado modificado — nenhum `reset`/`restore`/`clean`/`stash`
foi executado, e nada de tooling local foi tocado. A branch de trabalho nasceu
direto de `fd2671a`.

---

## 2. Estado atual da jornada

A jornada que o código **realmente** suporta hoje, lida no fonte (não em doc):

```
LOGIN  (index.html → login-ui)
  ↓                       vf-shell.js bootProduction()
MEU TRABALHO              vfContext.init() → GET /me/context
  ↓                       (queda p/ /operacao/cliente-360/clientes só em 404)
CARTEIRA (carteira.html)  GET /me/portfolio, 1 requisição
  ├── agrupada por Squad quando a tela representa 2+ squads
  │   ├── SQUAD 6  [principal]      ← ordem: principal, memberships, extras, sem-squad
  │   │    ├── Everest Store
  │   │    └── Fênix Comercial
  │   ├── SQUAD 3
  │   ├── SQUAD 8 · LEGADO          ← bucket do rollout, com nome real
  │   └── SEM SQUAD                 ← resíduo legítimo do enforcement OFF
  └── filtro Squad (Todos ▾) · busca · Com pendência · Sem operação · ordenação
  ↓
CLIENTE                   1 conta ativa → a linha inteira entra
  ↓                       2+ contas     → só os chips entram (nada auto-selecionado)
CLIENTECONTA              0 contas      → "Configurar →"
  ↓
VISÃO (visao.html?shell=v3&cliente=…&conta=…)
  ↓
MÓDULOS                   Financeiro · Central de Vendas · Ads · Anúncios ·
                          Margem · Diagnósticos · Automações · Cliente 360 V2
```

**Squad nunca é um passo.** Não existe tela "Escolha seu Squad" e esta branch
não criou nenhuma. Squad é agrupamento e filtro da lista (MASTER_SPEC D5/D7,
§10.6), e o contexto operacional canônico continua sendo, e só,
`{ clienteId, clienteSlug, clienteContaId }` (D6/D11).

---

## 3. O que já estava pronto (e continua)

Auditado no código, não herdado de documento:

- **`vf-context.js`** — a máquina de estados já estava correta para Squads:
  `squads`/`squadPrincipalId` são lidos de `/me/context`, guardados como
  metadado e **nunca** entram na identidade do contexto. Ausência é `[]`/`null`,
  jamais fabricada. `getSquads()` e `getSquadPrincipalId()` já existiam.
- **Cardinalidade de ClienteConta** — escrita **uma vez**, em
  `applyCardinality()`: 0 contas → `NO_ACTIVE_ACCOUNT`; 1 → única
  auto-seleção permitida no sistema inteiro; 2+ → `ACCOUNT_CHOICE_REQUIRED`,
  nunca escolhe. `is_primary` não desambigua nada em lugar nenhum do frontend.
- **Trocar cliente zera conta** (I1), **trocar conta preserva cliente**,
  **403 descarta contexto** e **424 preserva** (falha de integração ≠ falha de
  autorização).
- **Responsabilidade ≠ acesso** — `responsavelDireto` já era só marca na linha
  e opção de ordenação; nunca filtro.
- **Carteira** — busca, filtros, ordenação, chips por operação, pendências,
  última sync, estado de erro separado de estado vazio (M12), carga sob
  demanda por linha visível, queda completa quando `/me/portfolio` falha.
- **Recuperação de navegação** (PR #93) — as 8 telas recuperadas.

Isso tudo passou pela auditoria sem alteração.

---

## 4. Gaps encontrados

Todos determinísticos, todos reproduzidos, nenhum é "decisão de produto".

### G1 · A tela confundia duas listas diferentes de squad — **raiz de 4 defeitos**

`server/services/meService.js` devolve **duas coisas distintas** com a palavra
squad, e elas não coincidem por desenho:

| campo | origem | significa |
|---|---|---|
| `squads[]` | `squadsDoUsuario(user.id)` | as **memberships do usuário** |
| `clientes[].squad` | `squadsRepo.squadsAtivosDeClientes(ids)` | o **squad real do cliente** |

`carteira.js` agrupava e filtrava só pelas memberships. Consequências reais:

1. **Squad 8 · Legado aparecia como `SEM SQUAD`.** Ninguém é membro do bucket
   legado — então ele não estava em `squads[]`, e o `find()` falhava e caía no
   rótulo genérico. O nome correto vinha no payload, em `clientes[].squad.nome`,
   e era descartado.
2. **O bucket legado não era filtrável.** O `<select>` era montado só com as
   memberships.
3. **Cabeçalho `SEM SQUAD` repetido no meio da lista.** Dois squads
   desconhecidos diferentes caíam no mesmo balde de ordenação (`?? 99`) e eram
   intercalados pela ordenação interna, reemitindo o cabeçalho a cada troca.
4. **Admin não via dimensão de Squad nenhuma.** `resolvePortfolioClientes` dá
   a carteira inteira ao admin, mas `squadsDoUsuario` dá só as memberships
   dele — que podem ser zero. Resultado: sem agrupamento, sem filtro, e todos
   os clientes sob `SEM SQUAD`. Justamente quem mais precisa conferir o
   mapeamento no dia do rollout.

### G2 · O primeiro grupo da lista sumia

`renderCorpo()` emitia cabeçalho quando `c.squadId !== squadAtual`, com
`squadAtual` iniciado em `null`. Se a lista **começava** por clientes sem
squad (`squadId === null`), `null !== null` é falso e o cabeçalho **nunca era
emitido**: esses clientes apareciam soltos no topo, dando a impressão de
pertencerem ao grupo seguinte. Com enforcement OFF, "a lista começa por
clientes sem squad" é o caso comum, não o exótico.

### G3 · `squadPrincipalId` existia e não era usado por ninguém

`vf-context.js` expunha `getSquadPrincipalId()` e `/me/portfolio` mandava
`principal` por membership. Nenhum dos dois era lido. O squad principal não
ordenava, não rotulava, não fazia nada.

### G4 · `?squad=` inválido virava filtro invisível

Um `?squad=8` colado numa URL (ou herdado da carteira de outro usuário) que
não correspondesse a nenhum squad da carteira atual deixava a lista vazia com
o seletor exibindo **"Todos"** — o pior dos dois mundos: parece que não há
filtro, e o usuário conclui que perdeu acesso.

### G5 · O estado vazio culpava um squad que pode não existir

"Nenhum cliente atribuído aos seus squads · Fale com o coordenador do seu
squad" era dito **sempre** — inclusive para quem legitimamente não tem squad
nenhum (estado normal com `SQUADS_ENFORCEMENT=OFF`) e para o admin, que
enxerga por bypass e não é membro de nada. Mesma frase no painel de estado do
Shell (`NO_PORTFOLIO`).

### G6 · Duas regressões de responsividade da Wave 1 (pré-existentes na main)

Achadas no QA visual e **confirmadas idênticas em `origin/main`** — não são
desta branch, mas são a Carteira em tela estreita, exatamente onde o rollout
vai ser conferido.

- **Bloco de contexto vazando por cima do conteúdo (≤1200px).** A regra base
  é `position: sticky; top: 59px`. Quando `contextoNaBarra()` reparenta o
  bloco para a barra horizontal, a folha troca `position` para `relative` — e
  o `top: 59px` continuava valendo. Em `relative`, `top` **desloca a pintura
  sem ocupar espaço no fluxo**: medido com CDP em 390px, a barra ia de 253 a
  359 e o bloco era pintado de 320 a 409, com `main` começando em 359. O
  rótulo "OPERAÇÃO" caía em cima do "GESTÃO GLOBAL" do cabeçalho da página.
- **Campo de busca com 240px de ALTURA (≤900px).** A toolbar é
  `.vf-toolbar` + `.vf-portfolio-toolbar`, e `vf-components-v2.css` vira a
  primeira para `flex-direction: column` em ≤900px. O eixo principal passa a
  ser a vertical, e o `flex: 1 1 240px` que dava à busca a **largura** certa
  em linha passou a valer como **altura**. Barra inteira com ~350px em 900 e
  ~396px em 390.
- (Menor, mesmo bloco) `justify-content: space-between` só separa "CLIENTE" de
  "contexto ativo" enquanto o rótulo ocupa a largura da sidebar; na barra ele
  é `flex: 0 0 auto` e as duas palavras encostavam: "Clientecontexto ativo".

### G7 · Suíte `vf-shell-ui` flakeando na própria main (~40%)

Não é produto. Diagnosticado com `Network`/`Log`/`Runtime` instrumentados —
detalhe na §16.

---

## 5. Correções implementadas

| Gap | Correção | Arquivo |
|---|---|---|
| G1 | `squadsDaCarteira()`: os squads da tela passam a ser a **união aditiva** das memberships com os squads que vêm nos próprios clientes. Sem nome no payload (queda para `/me/context`), o rótulo é `Squad #8` — honesto: sabemos qual squad é, só não o nome. | `carteira.js` |
| G2 | Chave de grupo própria (`SEM_SQUAD`) em vez de comparar `squadId` cru contra `null`; o grupo sem squad passa a ter cabeçalho próprio e a **fechar** a lista, nunca a se misturar a um squad real. | `carteira.js` |
| G3 | `squadPrincipalId()` lê `principal` do payload ou `getSquadPrincipalId()` do store (validado contra a lista em mão). O principal **ordena à frente e rotula**, e nada mais. Dois principais marcados = anomalia = ninguém é principal, porque desempatar seria escolher pela ordem do array. | `carteira.js` |
| G4 | `?squad=` que não existe na carteira cai para `Todos` — mesmo tratamento que `?ordem=sync` já recebia sem dado de sync. | `carteira.js` |
| G5 | Texto do vazio passa a depender de o usuário ter squad, na Carteira e no painel do Shell. | `carteira.js`, `vf-shell.js` |
| G6 | `top: auto` junto com a troca de `position`; `flex: 0 0 auto` na busca em ≤900px; `gap` no rótulo da barra. | `vf-shell.css`, `carteira-v2.css` |
| G7 | `keepAliveTimeout` folgado + renavegação explícita em `goto()`. | 3 harnesses |

**Não implementado de propósito:** nada que dependa de decisão de produto —
ver §17.

---

## 6. Cenários de Squad testados

Suíte nova `Portal/squads-rollout-ux-ui.test.js`, 36 verificações, Chrome
headless via CDP puro, **100% fixtures**. Os 6 squads operacionais + o bucket
`Squad 8 · Legado`. Diferença deliberada em relação a `carteira-ui.test.js`:
**nada** é injetado em `getSquads` — o caminho medido é o de produção, com
`/me/portfolio` e `/me/context` respondendo de verdade, porque é a relação
entre esses dois payloads que o rollout põe à prova.

| Cenário | O que prova |
|---|---|
| **A** · 1 squad | Sem cabeçalho e sem seletor (§10.6); os dois clientes aparecem. |
| **B** · 3 squads + principal | Os 3 viram grupo; o principal abre a lista e é rotulado; **só um** é rotulado; o filtro nasce em `Todos`; os 4 clientes continuam na tela. |
| **C** · 3 squads + principal NULL | Nenhum grupo rotulado; ordem **do backend** preservada (`3, 1, 6` — o menor id não abre a lista); os 3 clientes visíveis. |
| **D** · Admin, `squads: []` | Carteira inteira; os squads reais dos clientes viram grupo, incluindo o legado; **zero** `SEM SQUAD`; nenhum banner de erro. |
| **E** · Squad 8 · Legado | Nome correto (`SQUAD 8 · LEGADO`), um grupo só, contagem certa; filtrável; o filtro vai para a URL e não para a sessão; `?squad=8` reabre já filtrado. |
| **F** · 1 ClienteConta | Linha inteira entra, com a conta certa no destino. |
| **G** · 3 ClienteContas | Nome não clicável, 3 chips; escolher a **segunda** manda a segunda (`conta=6022`, nunca a `is_primary` `6021`) e o contexto acompanha. |
| **H/I** · responsabilidade | `responsavelDireto=false` não esconde; `=true` só marca; "Meus primeiro" ordena sem filtrar. |
| **J** · sem operação | Não clicável, 0 chips, "Configurar →". |
| **K** · squad sem clientes | Vazio **de filtro**, nunca "sem acesso"/"erro". |
| **L** · portfolio vazio | Estado, não erro; com squad pode falar de squad, sem squad não culpa squad — na Carteira e no painel do Shell. |
| **M** · `/me/context` falha | Erro explícito, `main` escondido, nunca "você não tem clientes", nunca estado vazio. |
| **N** · `/me/portfolio` falha | Queda para `/me/context` sem banner de erro, **com o agrupamento por Squad vivo** e o principal respeitado. |
| extra | Filtro de Squad não encosta em `getContext()` nem tira o contexto de `READY`; enforcement OFF (com e sem squad convivendo) não quebra; zero requisição fora das fixtures; zero erro de console. |

---

## 7. Multi-Squad

**APROVADO.** Todos os squads autorizados viram grupo; nenhum some. O usuário
multi-squad (Klayvert 2/3/6, Micael 1/5, Fernando 1/4) vê a carteira inteira,
agrupada, com filtro opcional.

Duas armadilhas fechadas por teste:

- as memberships da fixture chegam **fora de ordem de id** (`3, 1, 6`) e o
  principal do cenário B é o **último do array e o de maior id** — se alguém
  reintroduzir "escolhe o primeiro" ou "escolhe o menor id", o cenário quebra;
- o principal **não filtra**: o cenário B confere que os 4 clientes dos 3
  squads continuam na tela e que o `<select>` está em `Todos`.

---

## 8. Squad principal

**APROVADO como default de UX · uma decisão de produto pendente (D1).**

O que ele faz agora: ordena o grupo à frente, rotula `principal` no cabeçalho
e `(principal)` na opção do filtro. Só isso.

O que ele **nunca** faz: filtrar, restringir, conceder ou esconder.

De onde ele vem, em ordem: `principal: true` numa membership de
`/me/portfolio`; senão `squadPrincipalId` de `/me/context`, **validado contra
a lista em mão** (um principal que não está entre os squads não rotula nada).
Se **duas** memberships vierem marcadas como principal, ninguém é principal —
desempatar seria escolher pela ordem do array, que é exatamente o proibido.

Sem principal no payload: ordem do backend intacta, nada rotulado. É o
cenário C, e ele existe porque para vários usuários reais essa decisão humana
ainda não foi tomada.

---

## 9. Squad 8 · Legado

**APROVADO.** O frontend representa o bucket sem nenhuma regra especial
destrutiva e sem que ele precise existir no backend hoje:

- renderiza com o **nome real** vindo de `clientes[].squad.nome`;
- agrupa os clientes legados juntos, com contagem;
- é filtrável como qualquer outro squad, e o filtro é compartilhável por URL;
- **não** é confundido com `SEM SQUAD` — são grupos diferentes, com chaves
  diferentes, e o teste proíbe explicitamente a mistura;
- não desaparece, não parece erro, não tem cor de alerta.

Se o backend mandar um cliente no Squad 8, a Carteira mostra. Ponto.

Ordem e recolhimento continuam sendo **decisão aberta (D2)** — hoje ele fica
depois dos squads operacionais por consequência do id, não por uma regra
"legado vai para o fim".

---

## 10. ClienteConta

**APROVADO — preservada, e a regra não foi tocada.**

A cardinalidade continua escrita uma vez só, em `applyCardinality()`:

| contas ativas | comportamento |
|---|---|
| 0 | `NO_ACTIVE_ACCOUNT` → "Configurar →" |
| 1 | única auto-seleção permitida no sistema |
| 2+ | `ACCOUNT_CHOICE_REQUIRED` — **nunca** escolhe |

Provado no cenário G com Ipiranga (ML1 `is_primary`, ML2, Shopee): clicar no
chip de **ML2** leva `conta=6022` ao destino e deixa
`getContext().clienteContaId === 6022`. Nada volta para `is_primary`, para a
primeira conta ou para o marketplace sozinho. A jornada representativa
completa (Carteira → N97 → ML2 → Visão → Central de Vendas → Margem →
Diagnóstico → Ads → Anúncios → Automações → Relatórios → Clientes e Contas →
Carteira → Extra → Visão) continua verde em `e2e-jornada-completa`.

Squad não interfere: trocar o filtro de Squad com contexto ativo mantém
`getContext()` byte a byte e o estado em `READY`.

---

## 11. Responsabilidade × Acesso

**PROVADO.** `responsavelDireto` marca (`responsável: você`), ordena ("Meus
clientes primeiro") e destaca. Não filtra, não esconde, não autoriza.

O cenário H/I mede as duas metades no mesmo payload: Recife (autorizado,
`responsavelDireto=false`) aparece **sem** a marca e continua na lista mesmo
com a ordenação "Meus" ativa; Salvador (`=true`) traz a marca e sobe dentro do
grupo dele. A contagem de linhas é conferida antes e depois da ordenação —
ordenar nunca pode filtrar.

Autorização continua sendo do backend (`resolvePortfolioClientes`); o frontend
não infere nem restringe nada (I10 — 403 é estado, não filtro).

---

## 12. Admin

**APROVADO.** O admin com `squads: []` e carteira inteira funciona: a lista
aparece, nenhum banner de erro, e agora os squads **reais dos clientes** viram
grupo e filtro — antes a dimensão Squad simplesmente sumia para ele.

O frontend não exige membership para nada e não infere autorização. O
`role === "admin"` continua servindo só para o que já servia: mostrar a seção
Administração na sidebar (e `ml-tokens.js` continua com o próprio redirect).

Confirmar que o admin **deve** ver agrupado é a decisão D5 — mas a alternativa
(voltar a jogar fora a informação que o backend manda) é pior em todas as
leituras.

---

## 13. Prontidão para enforcement OFF/ON

O frontend tolera as quatro fases sem tela branca:

| fase | dados | frontend |
|---|---|---|
| **ANTES DO APPLY** — enforcement OFF, dados antigos | `squadId` null na maioria | Grupo `SEM SQUAD` neutro, por último, com cabeçalho próprio. Sem squad nenhum, nem agrupamento nem filtro aparecem (§10.6), e o vazio não culpa squad. |
| **DEPOIS DO APPLY** — enforcement OFF, Squads presentes | memberships + `clientes[].squad` | Agrupamento e filtro ligam sozinhos; principal ordena se vier; Squad 8 renderiza; resíduo sem squad continua visível e honesto. |
| **CANÁRIO** — enforcement parcial | carteira menor para quem está no gate | A carteira é o que o backend mandar — o frontend não infere. Carteira vazia é estado (nunca erro) e 403 continua descartando contexto. |
| **PÓS-ROLLOUT** — dados + enforcement | tudo mapeado | Mesmo caminho da segunda linha. |

Não existe em lugar nenhum a lógica "se não houver Squad, erro" — isso foi
verificado explicitamente, e o cenário de enforcement OFF (clientes com e sem
squad no mesmo payload) prova que nada some e nada vira erro.

**Ressalva honesta:** o frontend **não sabe em que fase está** — nenhum dos
dois endpoints informa isso. Por isso "cliente sem squad" é neutro nas duas
fases. Tratá-lo como anomalia depois do apply exige um campo de fase no
payload: é a decisão D4, e a única que pede algo da Pessoa 2.

---

## 14. Navigation recovery

**8/8 intactas.** `vf-shell-navigation-recovery-ui.test.js` verde, 18
verificações:

| Tela | Rota | Onde |
|---|---|---|
| Cliente Operação | `cliente-operacao.html` | GLOBAIS |
| Cliente 360 | `cliente-360.html` | GLOBAIS |
| Cliente 360 V2 React | `cliente-360-react.html` (`?slug=`) | MODULOS |
| Promoções ML | `promocoes-retorno.html` | GLOBAIS |
| Central Full | `full-gestao.html` (`?clienteContaId=`) | GLOBAIS |
| Curva ABC | `fechamento.html` | GLOBAIS |
| Tokens ML | `ml-tokens.html` | ADMIN |
| Criação Anúncios ML | `criar-anuncios-meli.html` | ADMIN |

**Cliente 360 não foi tocada** — nem a vanilla, nem a V2 React, nem absorvida
pela Visão. **Cliente Operação não foi redesenhada** — só verificada presente
e navegável.

---

## 15. QA

Chrome real headless, três larguras, 16 recortes, com screenshots inspecionados
um a um (não só métricas).

Cenas: Carteira com 1 squad · Carteira multi-Squad · Carteira com Squad 8 ·
Carteira filtrada no Squad 8 · Cliente multi-conta · Shell depois de entrar na
operação (conta ML2 escolhida pelo chip).

| Medida | 1440 | 900 | 390 |
|---|---|---|---|
| overflow horizontal | 0 | 0 | 0 |
| elementos estourando a própria caixa | 0 | 0 | 0 |
| chips cortados no viewport | 0 | 0 | 0 |
| altura do campo de busca | 30px | **30px** (era 240) | **30px** (era 240) |
| altura da toolbar | 56px | **140px** (era 350) | **186px** (era 396) |
| foco por teclado nas linhas | ok | ok | ok |
| erros de console | 0 | 0 | 0 |
| requisições fora das fixtures | 0 | 0 | 0 |

Agrupamento conferido visualmente em todas as larguras, incluindo o caso
completo `SQUAD 1 [principal] · SQUAD 5 · SQUAD 8 · LEGADO · SEM SQUAD`.

Teclado: `/` foca a busca, `↑/↓` navegam entre linhas, `Esc` devolve o foco ao
gatilho do dropdown (coberto por `vf-shell-ui`).

**Produção:** nenhuma escrita, nenhum smoke contra produção. Todo cenário
futuro foi exercitado por fixture — e o próprio teste confere na lista de
requisições do Chrome que nada escapou. Não se conclui daqui que "Squads
reais funcionam em produção": o mapeamento ainda não foi aplicado, e ausência
de dado não é evidência.

---

## 16. Testes

21 suítes, **~496 verificações**, todas verdes na branch:

```
squads-rollout-ux-ui              36   ← NOVA
carteira-ui                       30
vf-shell-ui                       25
vf-shell-hardening               101
vf-shell-adoption-ui               5
vf-shell-f5-lote-ui               52
vf-shell-navigation-recovery-ui   18
visao-shell-ui                     8
login-ui                           7
ui-ux-wave1-convergence           32
e2e-jornada-completa              13
ads-anuncios-shell-ui             12
automacoes-shell-ui               11
diagnostico-inicial-shell-ui       9
fechamentos-api-shell-ui          12
financeiro-v3-shell-ui            24
central-margem-ui                 24
central-margem-api                24
fechamentos-api                   26
financeiro-entrega-conta          27
```

### O flake de harness (G7) — diagnóstico completo, para ninguém repetir

`vf-shell-ui` falhava em ~40% das execuções **na própria main**, em pontos
diferentes a cada vez. Instrumentando `Network`, `Log` e `Runtime` no Chrome
ficou claro que nunca era o produto: em cada falha **uma** requisição do
servidor do próprio teste não chegava ao navegador — sem exceção de JS, sem
`Network.loadingFailed`, sem entrada de Log.

Como a vítima era sorteada, o sintoma variava e apontava para longe da causa:

- `/vf-config.js` (importado por `vf-api.js`) ficava pendente → o grafo de
  módulos nunca executava → `window.VF === undefined` com
  `document.readyState === "complete"` → "vf-shell não montou";
- `/me/context` ou `/clientes/:slug/contas` morriam → contexto caía em
  `PORTFOLIO_ERROR`/`NO_ACTIVE_ACCOUNT` contrariando a fixture ativa.

**Causa:** reúso de socket keep-alive ocioso. Entre um cenário e o seguinte
passam vários segundos de asserções CDP; o Node fecha a conexão ociosa em 5s
(padrão) enquanto o Chrome ainda a considera reutilizável.

**Correção (só nos harnesses, zero linha de produto):** `keepAliveTimeout`
maior que a suíte inteira, e `goto()` renavega até 3× quando o shell não
monta, o contexto não sai de `BOOT` ou o boot cai em `PORTFOLIO_ERROR` **sem
que a fixture ativa tenha pedido falha** — `failPortfolio` e
`meContext: "erro"` continuam falhando de verdade, que é o que S13 e o cenário
de 500 medem. Contadores zerados por tentativa, para "1 GET /me/context"
medir só a carga que vingou.

Resultado: `vf-shell-ui` 10/10 seguidas (era ~6/10), `e2e-jornada-completa`
5/5, `squads-rollout-ux-ui` 3/3.

Uma medição adicional vale registrar: fechar a conexão a cada resposta
(`Connection: close`) também resolvia no harness leve, mas **piorou** a
`e2e-jornada-completa` — ela carrega páginas reais do Portal, com dezenas de
módulos, e uma conexão nova por recurso multiplica a churn de TCP contra o
limite de 6 conexões por host. Ficou só o afrouxamento do timeout.

### Segundo flake, causa diferente: os testes não eram herméticos

`vf-shell-f5-lote-ui` continuou falhando ~1 em 5 depois do conserto acima —
mas **sempre na mesma página**: `design-system-lab.html`, a mais pesada
(98KB de HTML + `style.css` de 151KB + 42 recursos) e a última do lote.
"Sempre a mesma" já descartava sorteio de socket. Instrumentando o tempo de
cada espera, todas resolviam em menos de 1s nas execuções boas: não era
lentidão, era travamento.

**Causa:** o interceptador usa `Fetch.enable` com `urlPattern: "*"` e
deixava passar **para a internet real** tudo que não fosse o host de
produção — inclusive a folha de estilo das fontes do Google, que quase toda
página do Portal carrega. E o sintoma de uma folha pendente não é "a fonte
não carregou": **folha de estilo pendente bloqueia a execução dos `<script>`
seguintes**, então `/vf-shell.js` nunca rodava e o teste acusava "o Shell V3
não montou".

**Correção:** só `127.0.0.1` continua de verdade; recurso externo recebe CSS
vazio. Seguro nessa suíte, que mede montagem do Shell, escopo e exceções de
JS — nunca tipografia. Junto, `respond()` deixou de propagar erro: um throw
dentro de um handler de evento `async` sem catch deixa a requisição
interceptada **pausada para sempre**. Resultado: 8 execuções seguidas, 52/52.

**Duas ressalvas medidas, para quem for replicar:**

1. A **mesma** mudança foi tentada em `e2e-jornada-completa` e **piorou**
   (3 falhas em 5, sempre em `ads.html`). Foi revertida; lá basta o
   `keepAliveTimeout` (5/5 verdes).
2. Outras **8 suítes** têm o mesmo furo de rede externa
   (`ads-anuncios`, `automacoes`, `central-margem-ui`, `diagnostico-inicial`,
   `financeiro-v3`, `login-ui`, `ui-ux-wave1-convergence`, `vf-shell-hardening`,
   além da `e2e`). Nenhuma flakeou nesta missão, e algumas medem **layout** —
   trocar a fonte real por fallback muda métrica de texto e pode quebrar
   asserção legítima. Aplicar caso a caso, medindo, nunca em lote.

---

## 17. Decisões abertas

Seis, no documento dedicado
[`VENFORCE_V3_SQUADS_UX_DECISOES_ABERTAS.md`](VENFORCE_V3_SQUADS_UX_DECISOES_ABERTAS.md):

| # | Pergunta | Recomendação | Precisa de backend? |
|---|---|---|---|
| D1 | O squad principal deve filtrar a Carteira por padrão? | Não | Não |
| D2 | Onde fica o Squad 8 · Legado, e ele vem recolhido? | Por id, aberto — reavaliar com o volume real | Não |
| D3 | O Shell ganha seletor global de Squad? | Não | Não |
| D4 | "Sem squad" vira anomalia depois do apply? | Sim, mas só com um campo de fase no payload | **Sim, 1 campo** |
| D5 | Admin sem membership vê a carteira agrupada? | Sim (já implementado) | Não |
| D6 | Cargo (Coordenador/Gestor/…) aparece na UI? | Não por enquanto | Não |

Nenhuma bloqueia o P2.9. O comportamento atual é correto na fase em que
estamos, em todas as seis.

---

## 18. Veredito

# FRONTEND PRONTO PARA RECEBER P2.9

A jornada `Login → Meu trabalho → Carteira (agrupada/filtrável por Squad) →
Cliente → ClienteConta → Visão → Módulos` está auditada, corrigida onde havia
regra determinística quebrada, e presa por 36 verificações novas em cima do
payload que o backend já sabe emitir.

Quando o mapeamento real chegar, a Carteira vai:

- agrupar pelos squads **reais dos clientes**, não só pelas memberships de
  quem está olhando;
- mostrar o `Squad 8 · Legado` com o nome dele, agrupável e filtrável;
- respeitar `squadPrincipalId` como default de UX e **só** como isso;
- não eleger principal nenhum quando o backend não elegeu;
- continuar tratando cliente sem squad como estado legítimo, sem alarme falso;
- funcionar para o admin sem exigir que ele seja membro de coisa alguma;
- manter `clienteContaId` intacto em toda a travessia.

**Duas ressalvas, ditas como ressalvas e não como aprovação:**

1. Isto é prontidão medida contra **fixtures** do contrato real. O mapeamento
   da Pessoa 2 ainda não foi aplicado, e ausência de dado em produção não
   prova nada — nem a favor, nem contra.
2. O frontend não sabe distinguir "antes" de "depois" do apply. Enquanto não
   houver um campo de fase no payload (D4), "cliente sem squad" continua
   neutro nas duas fases — que é o comportamento correto **hoje**, e vira
   informação faltando **depois**.

Nenhuma decisão de produto aberta foi tratada como bug; nenhum dado ainda não
aplicado foi tratado como regressão.
