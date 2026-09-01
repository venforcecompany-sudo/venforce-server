# VENFORCE V3 — CONVERGÊNCIA #5 · READINESS

> Integração da onda de UI/UX da Pessoa 1 (`frontend/v3-ui-ux-revamp-wave1`)
> sobre a `main` pós-Convergência #4, com a cascata global do Design System
> verificada por computed style em Chrome real.
>
> **Estado: APROVADA.** Uma regressão real foi encontrada e corrigida dentro da
> convergência; nenhum bloqueador restou.
>
> **Nada foi promovido para `main`. Nada foi deployado. Enforcement continua
> OFF. Nenhuma migração foi executada em banco real. P2.9 não foi tocada.**

**DATA:** 01/09/2026

---

## 0. Nota de origem — o prompt de partida estava vencido

Esta missão foi disparada com o documento
`Squads_migration/VENFORCE_V3_PROMPT_CONVERGENCIA_2_OPUS (1).md`, que descreve a
**Convergência #2**. Verificação antes de executar:

| Afirmação do prompt | Estado real em 01/09/2026 |
|---|---|
| `origin/main` = `1949c760` | `origin/main` = `07134b5` (PR #90 / Convergência #4) |
| integrar `frontend/v3-marathon-pessoa1 @ 7f877e3` | **já é ancestral de `main`** |
| integrar `backend/v3-squads-auth @ 6126ee1` | **já é ancestral de `main`** |
| criar `integration/v3-convergence-2` | já existe no origin (`650c8f3`) |
| produzir `VENFORCE_V3_CONVERGENCE_2_READINESS.md` | já commitado, datado 31/08/2026 |

Executar aquele prompt ao pé da letra mergearia dois commits que já estão na
`main` — zero mudança de conteúdo e um readiness duplicado. A missão foi então
**readequada ao que de fato estava pendente**, com a mesma metodologia e o mesmo
rigor: a Wave 1 de UI/UX, único trabalho relevante fora da `main` (8 commits à
frente, 0 atrás). Decisão confirmada com o solicitante antes de qualquer merge.

---

## 1. IDENTIFICAÇÃO

| Item | Valor |
|---|---|
| **MAIN BASE** | `origin/main` = `07134b537c794dc6b3952601edd5ea9fbb9bd56a` (`07134b5`) |
| **PESSOA 1** | `origin/frontend/v3-ui-ux-revamp-wave1` = `43816ecef2c6d328fabb1e8b176085182f697ce1` (`43816ec`) |
| **PESSOA 2** | **nenhuma branch pendente** — `backend/v3-rollout-preflight-account-audit` e `frontend/v3-final-qa-cutover-prep` entraram na `main` pela Convergência #4 |
| **BRANCH DE INTEGRAÇÃO** | `integration/v3-convergence-5` |
| **ÚLTIMO COMMIT DE CÓDIGO** | `e6811173dcb4eb34def4f39f8c17f00c2355dc74` (`e681117`) |
| **HEAD FINAL** | o commit `docs(convergence-5)` deste arquivo, imediatamente acima de `e681117` — todos os testes reportados aqui foram rodados em `e681117`, e o commit de documentação não toca código |

Os refs bateram exatamente no `git fetch`; nenhum avanço inesperado.

---

## 2. MERGES E CONFLITOS

| | |
|---|---|
| Merges | 1 — `frontend/v3-ui-ux-revamp-wave1` em `--no-ff` |
| **Conflitos mecânicos** | **0** |
| **Conflitos semânticos** | **0** (analisados, não presumidos — §4) |
| `git diff --check` | limpo |
| Arquivos alterados vs `main` | 20 (19 da Wave 1 + 1 teste da convergência) |
| `server/**` alterado | **0 arquivos** |
| `frontend-react/**` alterado | **0 arquivos** |

A Wave 1 estava 0 commits atrás da `main`, então o merge foi trivial no plano
mecânico. **Isso não encerrou a análise:** o valor desta convergência está em
provar a cascata global, que nenhum merge detecta (§4).

### Commits

| SHA | Mensagem |
|---|---|
| `a2da97c` | `merge(convergence-5): integra frontend UI/UX Wave 1 (Pessoa 1)` |
| `3bbb744` | `test(convergence-5): cobre a cascata global da Wave 1 em Chrome real` |
| `e681117` | `fix(pessoas): corrige regressao de responsividade da Wave 1 abaixo de 900px` |

---

## 3. O RISCO REAL DESTA CONVERGÊNCIA

A Wave 1 tocou 5 telas, mas o alcance verdadeiro está em **3 arquivos globais**
que valem para as **20 páginas** que carregam o Shell:

- `vf-tokens-v2.css` — ganhou `[hidden] { display: none !important }` (§14);
- `vf-components-v2.css` — absorveu o vocabulário de **forma** do `.vf-status`
  (● cheio · ◇ losango · ○ vazado) e ganhou `.vf-metric-row` / `.vf-info`;
- `vf-shell.css` — **perdeu** os guards de `[hidden]` e a correção do
  `.vf-status`, que viviam deliberadamente **fora de `@layer`**.

Trocar guards pontuais fora de camada por uma regra global é uma mudança de
**cascata**, e a Wave 1 a validou apenas visualmente: o readiness dela (§20)
registra que o headless "não roda neste ambiente Windows" e que "nenhuma das
telas alteradas tem `*-shell-ui.test.js` dedicado".

---

## 4. VERIFICAÇÃO DA CASCATA GLOBAL

Três condições precisavam valer. Todas verificadas **no código e por computed
style**, não por leitura:

| # | Condição | Resultado |
|---|---|---|
| 1 | O `[hidden]` novo vence o `display` de autor | `vf-tokens-v2.css` **não usa `@layer`** → a regra é de autor sem camada, com `!important`; vence toda declaração normal, layered ou não |
| 2 | Nenhum `!important` concorrente a derruba | **0** `display:…!important` dentro de `@layer` em todo o Portal. Os únicos `display:block!important` são do bloco de impressão do Diagnóstico, dentro de `@media print`, sobre `#diag-print-block` — que **não carrega `hidden`** no markup e cujo CSS carrega depois do tokens (comportamento idêntico ao de antes) |
| 3 | Toda página que dependia do guard carrega o tokens | **20/20** páginas que carregam `vf-shell.css` também carregam `vf-tokens-v2.css`; **0** páginas órfãs |

Riscos na direção oposta também checados: todas as regras `[hidden]` de CSS de
página são `display:none` (mesma direção — a global as torna redundantes, não
contraditórias), e nenhum CSS de página sobrescreve `.vf-status::before`. No
`vf-shell.css` restaram apenas comentários.

**`.vf-status` por forma:** a regra nova (`vf-components-v2.css:1193`) vence a de
cor (`:1183`) por **ordem no mesmo arquivo**, com a mesma especificidade — o
comentário do código está correto e a saída de `@layer` deixou de ser necessária.

---

## 5. TESTE NOVO DA CONVERGÊNCIA

`Portal/ui-ux-wave1-convergence.test.js` — **32 verificações**, Chrome headless
real (CDP puro, mesmo padrão de `vf-shell-hardening.test.js`), com interceptação
`Fetch` total: **nenhuma requisição sai para a rede** (as páginas do Portal fixam
o host de produção no código).

Cobre por computed style: o `[hidden]` sobre `.vf-card`/`.vf-banner`/
`.vf-shell__main`/`.vf-shell__state`/`.vf-metric-row`; as 3 formas do
`.vf-status` (e que a forma nova **não vazou** para `is-success`); o
`.vf-info__tip` abrindo por teclado e fechando no blur; e nas 4 telas migradas —
render, ausência de erro de console, saída de Bootstrap/`style.css`, tipografia
da Fundação e ausência de overflow em **7 larguras** (1920→360).

**Red-green verificado:** removendo a regra `[hidden]` do `vf-tokens-v2.css`, o
teste fica vermelho em `.vf-banner` e `.vf-metric-row` — exatamente o "banner
fantasma" que a Wave 1 diz ter corrigido. Restaurada, volta a verde.

### Duas armadilhas de medição, documentadas no arquivo

Ambas produzem **falso negativo de acessibilidade** e custaram investigação:

1. **Ler o computed style no mesmo tick do `focus()`.** A `transition` do
   tooltip ainda está em t=0: mede-se `hidden/0` com o `:focus-within` **já
   casando**. Medido: `visible/0.888` em voo, `visible/1` ao fim.
2. **Medir sobre `design-system-lab.html`.** A lab re-renderiza e destrói o nó
   focado no meio da espera. Daí a página de contrato própria (`/ds-probe.html`)
   e o `Emulation.setFocusEmulationEnabled` — sem este último o headless não tem
   foco de janela e `:focus` nunca casa.

O tooltip por teclado da Wave 1 **está correto**; a primeira leitura é que estava
errada.

---

## 6. BUG ENCONTRADO E CORRIGIDO

**Regressão de responsividade em Pessoas (`usuarios.html`), abaixo de 900px.**

Confirmada por comparação direta contra a `main` (worktree em `07134b5`):

| Largura | `origin/main` | Wave 1 (antes do fix) | Depois do fix |
|---|---|---|---|
| 1200px | ok | ok | ok |
| 900px | ok | **+59px** | ok |
| 640px | ok | **+71px** | ok |
| 360px | ok | **+75px** | ok |

Atividade, Callbacks e Clientes passam em toda a faixa — o defeito era só desta
tela. Duas causas, ambas por **omissão**:

1. `.vu-section-hd` é o único container flex de `usuarios-v2.css` **sem
   `flex-wrap`**. O `@media` já mandava `.vu-section-note { flex: 1 0 100% }`
   para jogar a nota na própria linha, mas sem wrap ela fica na **mesma** linha
   com base 100% e `flex-shrink: 0` (medido `left=245 width=699` num documento de
   900px). A intenção já estava escrita; faltava deixar quebrar.
2. O `@media` **não solta a tabela**. `atividade-v2.css` e `callbacks-v2.css` —
   as telas irmãs da mesma onda, que passam em 360px — fazem `table-layout: auto`
   + `width: auto` nas colunas abaixo de 900px. Pessoas ficou com
   `table-layout: fixed` e `.vu-col-actions` em **340px fixos**, que sozinha não
   cabe num viewport de 360.

A correção aplica exatamente o passe que a Wave 1 já fizera nas outras duas
telas. **Nenhum token, nenhuma cor, nenhum layout de desktop mudou.**

Isto fecha o item que o readiness da Wave 1 marcava como
`RESPONSIVIDADE: PARCIAL` — "o ambiente de QA não permitiu redimensionar a janela
abaixo do desktop" (§17). Este ambiente permitiu.

---

## 7. D1–D5

A Wave 1 **não toca `server/**` (0 arquivos)** e não altera nenhum contrato de
API. D1–D5 são contratos cruzados backend↔frontend fechados nas Convergências
#2–#4 e já promovidos à `main`; esta convergência **não os reabre**. O que se
exigiu aqui foi prova de que continuam intactos — via regressão, não via
reanálise:

| | Estado | Evidência nesta convergência |
|---|---|---|
| **D1** — ClienteConta na entrega | herdado, **sem regressão** | `financeiro-entrega-conta`, `financeiro-v3-shell-ui` (24), `fechamentos-api-shell-ui` (12) verdes |
| **D2** — competência do processamento | herdado, **sem regressão** | `fechamentos-api`, `fechamentos-api-shell-ui` verdes |
| **D3** — última sincronização | herdado, **sem regressão** | `carteira-ui` (30) e `vf-shell-ui` (25) verdes |
| **D4** — fechamento duplicado (409) | herdado, **sem regressão** | `NovoFechamento.test.jsx` cobre 409 `ENTREGA_JA_EXISTE` → cancelar/substituir, MELI e Shopee (vitest verde) |
| **D5** — exclusão | **DECISÃO DE PRODUTO** | inalterado; nenhum botão de excluir foi adicionado |

**Migration D4** (`server/sql/migrations/20260828_entregas_cliente_unicidade_p26.sql`):
presente no repo, **NÃO aplicada**, não executada em produção, nenhuma duplicata
apagada, nenhum registro sobrevivente escolhido.

---

## 8. TESTES

Todos rodados nesta máquina, no HEAD `e681117`.

| Camada | Baseline (`main` `07134b5`) | Pós-convergência | Regressões novas |
|---|---|---|---|
| **Backend** (`server/tests`) | 176 arquivos · 172 verdes · 4 vermelhos | **176 · 172 · 4** | **0** |
| **Frontend** (`vitest`) | 11 arquivos · 138 testes | **11 · 138 verdes** | **0** |
| **Headless Portal** | 17 arquivos · 357 verificações | **18 · 389 verificações · 0 vermelhos** | **0** |
| **E2E** (`e2e-jornada-completa`) | 13/13 | **13/13 · 3 execuções consecutivas verdes** | **0** |
| **Builds** (4 ilhas React) | 4/4 | **4/4** | **0** |

Os 4 vermelhos do backend são os baseline conhecidos e **inalterados**:
`basesTiktok`, `designStudioWorkspace`, `designTemplateEngine`, `mlTokenService`.
Nenhuma quinta falha apareceu.

O baseline foi **medido**, não assumido: o prompt de partida citava 161 arquivos
de backend; hoje são 176. O runner do repo (`run-all.js`) para no primeiro
vermelho, o que esconde o quadro — foi usado um runner que roda todos e reporta.

A jornada E2E cobre `Login→Carteira→N97→ML2→Visão→CentralDeVendas→Margem→
Diagnóstico→Ads→Anúncios→Automações→Relatórios→ClientesEContas→Carteira→Extra→
Visão`, passando por **Clientes e Contas**, uma das telas migradas pela Wave 1.

### Infraestrutura — headless em Windows

O readiness da Wave 1 registra "não roda neste ambiente Windows". **Roda.** O
shim documentado na Convergência #3 §9 (`child_process.spawn` via
`NODE_OPTIONS=--require`, reescrevendo `"google-chrome"` → Chrome do Windows e
`/tmp/…` → `os.tmpdir()`) continua válido e foi recriado. Ele **não está no
repo** (é infra de teste local) e **nenhum arquivo de teste foi alterado** para
acomodá-lo. Foi essa premissa desatualizada que deixou a regressão do §6 passar.

---

## 9. `/ME/CONTEXT`, `/ME/PORTFOLIO`, VISÃO, FINANCEIRO, ENTREGAS

Nenhum destes contratos foi tocado (`server/**` intocado). Verificados por
regressão, todos verdes:

- **`/me/context`** — `vf-shell-ui` C1: shell consome o payload novo, expõe
  `getSquads()` sem inventar squad, cai para o endpoint legado em 404 e trata 500
  como `PORTFOLIO_ERROR` sem mascarar.
- **`/me/portfolio`** — `carteira-ui` (30 verificações, P01–P13): agrupamento,
  contas embutidas, status, zero carteira, 1 conta, 2+ contas.
- **Visão** — `visao-shell-ui` (8) verde.
- **Financeiro V3** — `financeiro-v3-shell-ui` (24) + `FinanceiroPage` (17
  vitest) verdes; roteamento V3 confirmado para conta ML **e** Shopee.
- **Entregas** — `financeiro-entrega-conta` e `NovoFechamento` (409 →
  cancelar/substituir) verdes.
- **Autorização / multi-conta** — `vf-shell-ui` S04–S12 (escolha de conta
  obrigatória, conta inativa esmaecida, módulos ML-only colapsando em Shopee,
  Administração só para admin) e o passo 7 do E2E (troca de cliente não mistura
  contexto e **zera o período**).

---

## 10. SEGURANÇA

| Item | Estado |
|---|---|
| `SQUADS_ENFORCEMENT` | **OFF** — padrão quando ausente/vazio (`server/config/squadsEnforcement.js`); a convergência não toca o flag (0 arquivos em `server/**`) |
| **JWT_SECRET** | **CONTRATO APROVADO — 5/5** |
| Migração real de Squads | **NÃO EXECUTADA** |
| Migration de unicidade D4 | **NÃO APLICADA** |
| P2.9 | **NÃO EXECUTADA** |
| Rollout / canário | **NÃO ATIVADO** |
| Correções P2 (IDOR base de custos, lista global de clientes, entrega órfã, vazamento de contagem, isolamento MP por conta) | preservadas — nenhum arquivo de `server/` alterado |

**JWT_SECRET** foi testado por boot real, sem configurar produção, sem trocar
segredo e sem deployar:

| Caso | Esperado | Resultado |
|---|---|---|
| produção sem `JWT_SECRET` | exit 1 | ✅ exit 1, mensagem acionável |
| produção com o segredo de dev | exit 1 | ✅ exit 1 |
| produção com segredo < 32 chars | exit 1 | ✅ exit 1 ("tem 16 caracteres; o mínimo é 32") |
| produção com segredo ≥ 32 chars | passa o gate | ✅ passa |
| desenvolvimento sem `JWT_SECRET` | passa com aviso | ✅ passa, avisa 1× |

O fail-fast ocorre **antes do bind na porta**, como projetado.

---

## 11. QA

QA feito em Chrome headless real dirigido por CDP, com servidor estático do
`Portal/` e fixtures — o mesmo padrão das 17 suítes que já existiam no repo, e o
mesmo que a Wave 1 usou. Inspecionados: console (0 erros nas 4 telas), render,
estados vazios/erro, modais, filtros e 7 breakpoints.

**Limitação declarada:** não há `.env` nem banco nesta máquina, então **não houve
QA contra backend com dados reais**. Isso é aceitável aqui porque a Wave 1 não
toca backend nem contrato de API; seria bloqueador numa convergência com delta de
backend. Nenhuma escrita financeira foi feita em produção — a interceptação
`Fetch` garante que **nenhuma requisição saiu da máquina** (há uma verificação
dedicada a isso: `ok 32`).

---

## 12. DÍVIDAS RESTANTES

Nenhuma bloqueia a promoção. As três primeiras são herdadas da Wave 1 (§24 do
readiness dela); as demais foram observadas nesta convergência.

1. `style.css` continua no repo — saiu do `<head>` de 4 telas, não foi removido.
2. Telas densas (Central de Vendas, Ads, Anúncios, Margem) sem passe de
   densidade — **Wave 2**, decisão de escopo.
3. Tema escuro legado (`financeiro.html`, `fechamento.html`) e
   `venforce-ui-v2.css` com 4 telas standalone.
4. **`API_BASE` fixo no host de produção** em ~20 arquivos `Portal/*.js`
   (`https://venforce-server.onrender.com`). **Pré-existente**, não veio da Wave
   1, e é a razão de todo teste headless precisar interceptar `Fetch`. Vale um
   `meta vf-api-base` uniforme.
5. `atividade.html` usa `id="callbacks-tbody"` — herança de copy-paste da tela de
   Callbacks. **Pré-existente** (a Wave 1 só reindentou) e sem colisão real (são
   documentos distintos), mas confunde quem lê.
6. O shim de headless para Windows **não é versionado**. Toda convergência o
   recria. Um `CHROME_BIN`/`os.tmpdir()` nos próprios testes resolveria de vez —
   e teria evitado o buraco que deixou passar a regressão do §6.
7. Os builds Vite escrevem LF onde o repo tem CRLF: rodar `npm run build` no
   Windows marca 12 arquivos como modificados **sem diferença de conteúdo**
   (verificado byte a byte: só o terminador de linha). Já acontecia na `main`.
   Um `.gitattributes` para `Portal/assets/**` encerraria o ruído.
8. Worktree órfã `.worktrees/convergence-1` ainda registrada (gitignorada).

---

## 13. RESPOSTA FINAL

```
CONVERGÊNCIA #5:               APROVADA

BRANCH:                        integration/v3-convergence-5
BASE MAIN:                     07134b537c794dc6b3952601edd5ea9fbb9bd56a (07134b5)

PESSOA 1:                      frontend/v3-ui-ux-revamp-wave1
                               43816ecef2c6d328fabb1e8b176085182f697ce1 — INTEGRADA: SIM
PESSOA 2:                      nenhuma branch pendente (entrou na main via Convergência #4)

CONFLITOS GIT:                 0 mecânicos, 0 semânticos

D1 (ClienteConta na entrega):  RESOLVIDO (herdado, sem regressão)
D2 (competência):              RESOLVIDO (herdado, sem regressão)
D3 (última sincronização):     RESOLVIDO (herdado, sem regressão)
D4 (fechamento duplicado):     RESOLVIDO (herdado, sem regressão)
D5 (exclusão):                 DECISÃO DE PRODUTO

/ME/CONTEXT:                   APROVADO
/ME/PORTFOLIO:                 APROVADO
VISÃO:                         APROVADA
FINANCEIRO:                    APROVADO
ENTREGAS:                      APROVADAS
AUTORIZAÇÃO:                   APROVADA
MULTI-CONTA:                   APROVADO
PERÍODO:                       APROVADO
DESIGN SYSTEM (cascata):       APROVADO
RESPONSIVIDADE:                APROVADA (1920→360 nas 4 telas migradas)

JWT_SECRET:                    CONTRATO APROVADO (5/5)
SQUADS_ENFORCEMENT:            OFF
MIGRAÇÃO REAL:                 NÃO EXECUTADA
MIGRATION UNICIDADE D4:        NÃO APLICADA EM PRODUÇÃO
P2.9:                          NÃO EXECUTADA

BACKEND TESTS:                 176 arquivos · 172 verdes · 4 baseline · 0 regressões novas
FRONTEND VITEST:               11 arquivos · 138/138
HEADLESS:                      18 arquivos · 389 verificações · 0 vermelhos
E2E:                           13/13 · 3 execuções consecutivas verdes
BUILDS:                        4/4
QA REAL:                       APROVADO (headless real + fixtures; sem banco nesta máquina)

BUGS ENCONTRADOS:              1 — regressão de responsividade em Pessoas
                                   (+59px @900, +71px @640, +75px @360),
                                   confirmada contra a main
BUGS CORRIGIDOS:               1 — o mesmo (e681117)
FALSOS POSITIVOS DESCARTADOS:  1 — tooltip por teclado do .vf-info-dot: a
                                   primeira medição estava errada, não o CSS

COMMITS:                       a2da97c  merge(convergence-5): integra frontend UI/UX Wave 1
                               3bbb744  test(convergence-5): cobre a cascata global em Chrome real
                               e681117  fix(pessoas): corrige regressao de responsividade <900px

PUSH:                          SIM
ÚLTIMO COMMIT DE CÓDIGO:       e6811173dcb4eb34def4f39f8c17f00c2355dc74 (e681117)
HEAD REMOTO DA CONVERGÊNCIA:   o commit docs(convergence-5) acima de e681117
READINESS:                     Squads_migration/VENFORCE_V3_CONVERGENCE_5_READINESS.md

PODE PROMOVER PARA MAIN:       SIM
PRÓXIMO PASSO:                 PR PARA MAIN
```

**MAIN NÃO ALTERADA. NENHUM DEPLOY. `SQUADS_ENFORCEMENT` NÃO LIGADO. P2.9 NÃO
EXECUTADA.**
