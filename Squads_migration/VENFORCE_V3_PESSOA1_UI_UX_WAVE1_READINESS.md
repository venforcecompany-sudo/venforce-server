# VENFORCE V3 — UI/UX WAVE 1

> Checkpoint da Pessoa 1. Primeira onda de revamp visual do Portal sobre a
> Fundação Global V2. Sem toque em backend.

## 1. Identificação

| Campo | Valor |
|---|---|
| main base | `origin/main` |
| HEAD base | `07134b537c794dc6b3952601edd5ea9fbb9bd56a` (PR #90 / Convergência #4) |
| branch | `frontend/v3-ui-ux-revamp-wave1` |
| HEAD da branch | `52f5bc5cbcb5dc0f3ce52a06f8861e41ddbac542` |
| commits | 7 (1 doc + 1 design-system + 5 telas) |
| push | SIM — `frontend/v3-ui-ux-revamp-wave1` (NÃO mergeada) |
| escopo tocado | `Portal/**`, `docs/ui-ux/**`, `Squads_migration/` (este arquivo) |
| `server/**` tocado | **NÃO** |

## 2. Objetivo

Elevar o frontend ao nível da arquitetura. Achado da auditoria: o Portal **já
passou da fase caótica** — existe uma Fundação Global V2 madura (tokens +
componentes + Shell V3) adotada por 20 páginas. O trabalho da Wave 1 foi
**consolidar a adoção**, não redesenhar: fechar a cauda de telas ainda em
vocabulário V1, endurecer o Design System e dar um passe de densidade nas telas
operacionais — mantendo 100% da funcionalidade.

## 3. Auditoria inicial

`docs/ui-ux/VENFORCE_V3_UI_UX_AUDIT_WAVE1.md` — inventário das ~40 páginas,
score 1–5 por tela, mapa do Design System (canônico / duplicado / legado /
ausente), referências internas (Visão · Carteira · Financeiro V3), plano da
Wave 1 e reordenação justificada da prioridade do brief.

Diagnóstico em uma frase: **a migração estava ~80% feita**; a inconsistência
restante concentrava-se em (a) `style.css` V1 (5.932 ln) ainda carregado por
~17 páginas, (b) a cauda administrativa (`atividade`, `usuarios`, `callbacks`)
em `.vf-card-header` / `.vf-form-group` / `.vf-act-*`, (c) densidade herdada.

## 4. Score das páginas

Tabela completa na §4 do doc de auditoria. Resumo:

- **Alta maturidade (manter):** Visão, Financeiro V3, Cliente 360 (ilhas React),
  Carteira, Shell, Ferramentas.
- **Média (Wave 2):** Relatórios, Automações, Central de Vendas, Ads, Anúncios,
  Margem, Bases, Diagnósticos — já usam os componentes; falta densidade/hierarquia.
- **Baixa (Wave 1):** Atividade, Pessoas, Callbacks; **Clientes** (média-baixa,
  importância crescente com Squads).

## 5. Design System

### Antes
- `.vf-status` desenhava sempre o mesmo círculo (significado só por cor).
- `[hidden]` do UA perdia para o `display` de qualquer componente de autor —
  `vf-shell.css` tinha guards pontuais fora de `@layer` como paliativo.
- Sem strip de métrica denso (o `.vf-kpi` fica largo a partir de 5 itens).
- Sem padrão de tooltip para métricas pouco óbvias (ROAS/TACOS/MC).

### Depois
- **`.vf-status` por forma** (● cheio = ok · ◇ losango = alerta · ○ vazado = sem
  dado) — §16.4/M8 do DESIGN.md, agora em `vf-components-v2.css §6`.
- **`[hidden] { display: none !important }`** global em `vf-tokens-v2.css §14` —
  fecha o bug para `.vf-banner`, `.vf-card`, `.vf-shell__main`, etc.; guards
  pontuais de `vf-shell.css` removidos.
- **`.vf-metric-row` / `.vf-metric`** — strip denso (`flex: 1 1 0`, Manrope
  tabular 18px, filete de alerta). Consome só tokens existentes.
- **`.vf-info` / `.vf-info-dot` / `.vf-info__tip`** — tooltip de métrica CSS
  puro; abre no hover **e** no `:focus-within` (teclado).
- `design-system-lab.html` ganhou exemplos dos 3 padrões.

**Zero tokens novos de cor ou tipografia. Nenhum terceiro design system.**

## 6. Padrões definidos

Tipografia, Spacing, Radii, Borders, Cards, Tables, Buttons, Inputs, Tabs,
States — **inalterados**; a Wave 1 reforça o uso do que já existe. Detalhe do
esqueleto canônico de cada um na §6 do doc de auditoria.

## 7. Telas alteradas

### 8. Shell
**Auditoria, sem alteração de código.** A casca V3 está madura e 20 telas
dependem dela; nenhuma mudança trouxe ganho que justificasse o risco. As
melhorias de forma do `.vf-status` (bloco de contexto) e o guard de `[hidden]`
(painéis de estado) chegam via Design System.

### 9. Carteira (B2)
- **Problemas:** densidade — poucos clientes por viewport para carteiras grandes.
- **Alterações:** margem de grupo 24→20px; padding de linha 16→12px; hover na
  linha inteira (fundo + cantos suaves) reforçando o alvo.
- **Impacto:** só `carteira-v2.css`. `carteira.js` e o contrato de
  `carteira-ui.test.js` (P01–P13) intactos.
- **QA:** render OK; sem overflow horizontal; skeleton e estados preservados.

### 10. Visão / 11. Financeiro
Não tocadas — são as telas de referência (ilhas React sobre a V2). Verificadas
por regressão: shell e estados (`NO_CLIENT`, `INVALID_ACCOUNT`) renderizam
corretos após as mudanças de Design System.

### Atividade (B3)
- **Problemas:** a tela mais heterogênea — `.vf-act-*` para KPI/empty/error/badge,
  `.vf-card-header` + `.vf-form-group` (V1), Bootstrap sem uso, sem Google Fonts
  (renderizava em Segoe UI), dependência total de `style.css`, prévia de detalhes
  em JSON cru.
- **Alterações:** `.vf-page-header`; resumo → `.vf-metric-row` (~64px/item vs
  ~115px); filtros num `.vf-card` V2 com `.vf-select`; "Aplicar filtros" deixa de
  ser full-width; tabela `.vf-table--compact` com status `.vf-tag`
  is-success/is-danger e ação/IP em `.vf-mono`; estados `.vf-empty` /
  `.vf-loading-state` com "Tentar novamente"; prévia de detalhes vira
  "chave: valor · chave: valor" (JSON completo continua no `<details>`); botão
  "Atualizar" no header; carrega Hanken Grotesk/Manrope; **remove Bootstrap e
  style.css**; novo `css/pages/atividade-v2.css`.
- **Impacto:** `atividade.js` — só renomeia classes nos templates de linha e
  melhora `detalhesPlainText`. Lógica, IDs e listeners preservados.
- **QA:** carrega, 5 linhas, filtro "Refinar" (client-side) funciona, `<details>`
  expande, empty e error renderizam, sem erro de console, sem overflow.

### Pessoas / usuarios (B4)
- **Problemas:** `.vf-page-header` mal montado (descrição parava à direita do
  título), `.vf-card-header` (V1), `.vf-role-pill` / `.vf-status-pill` /
  `.vf-action-btn` próprios, modal e toast V1, Bootstrap, sem Google Fonts.
- **Alterações:** `.vf-page-header` correto; papel via `.vf-tag`
  (is-primary/is-info/is-warning/is-neutral); status via `.vf-status` (Ativo =
  ponto verde, Inativo = ponto neutro); select de papel `.vf-select--sm`; botões
  de linha calmos (`.vf-btn--sm`, "Remover" secundário — o modal confirma); modal
  → `.vf-overlay`/`.vf-modal` (JS alterna `.is-open` + `.vf-no-scroll`); toast
  reestilizado com tokens; título "Usuários" → **"Pessoas"** (alinha com a
  navegação); **remove Bootstrap e style.css**; novo `css/pages/usuarios-v2.css`.
- **Preparação para Squads (§26):** a base visual — agrupamento por papel com
  contagem — já acomoda colunas Squad / Responsabilidades / Status quando o
  contrato existir. **Nenhum dado ou contrato inventado.**
- **Impacto:** `usuarios.js` — renomeia classes nos templates, 3 helpers de
  badge/select, o alternador do modal. Lógica, IDs e listeners preservados.
- **QA:** carrega, 4 seções, modal de remoção abre/fecha (backdrop + ESC), toast
  aparece, ações cabem numa linha, sem erro de console.

### Clientes e Contas (B5)
- **Problemas:** estrutura já era V2; faltava largar `style.css` (+ classe
  `vf-page-dashboard`), `.loading-dots` / `.btn-spinner` V1, ~13 inline styles.
- **Alterações:** deixa de carregar `style.css`; regras `.vf-page-clientes
  .vf-table` migram para `clientes-v2.css`; container → `--wide`; `.vf-spinner`;
  select de base `.vf-select`; linhas sem inline style (`#`/slug em
  `.vf-cli-cell-slug`, contagem em `.vf-cli-cell-muted`); "Inativo" vira status
  neutro; "Excluir" vira secundário calmo.
- **Squads (§25):** a coluna "Contas" mostra a árvore Cliente ▸ Conta por
  marketplace (`ML • 2/2 conectadas` / `Shopee ○ nenhuma`) — o ○ vazado é o novo
  vocabulário de forma do `.vf-status`.
- **Impacto:** `clientes.js` — só troca de classes nos templates de linha.
  Modais, lógica e IDs preservados.
- **QA:** carrega, 3 clientes, expansão de conta abre com os cartões de conta,
  sem erro de console, sem overflow.

### Callbacks (B6)
- **Problemas:** mesma família da Atividade.
- **Alterações:** `.vf-page-header`; filtros em `.vf-card` V2 com `.vf-select`;
  tabela `.vf-table--compact` com status `.vf-status` is-success/is-danger
  (ponto + código); `#`/data/endpoint/IP em `.vf-mono` muted; duração `.num`;
  estados `.vf-empty` / `.vf-loading-state`; **remove Bootstrap e style.css**;
  novo `css/pages/callbacks-v2.css`.
- **Impacto:** `callbacks.js` — só o template de linha e o status.
- **QA:** carrega, 3 linhas, status verde/vermelho corretos, sem erro de console.

### 12. Central de Vendas / 13. Ads / 14. Anúncios / 15. Automações
Não tocadas nesta onda — já adotaram os componentes; precisam de um passe de
densidade/hierarquia (Wave 2). Verificadas por regressão.

## 16. Outras telas tocadas
`design-system-lab.html` (exemplos dos novos padrões).

## 17. Responsividade

Prioridade 1920 / 1440 / 1366 / 1200 verificada visualmente (sem overflow
horizontal em nenhuma tela alterada). O ambiente de QA não permitiu redimensionar
a janela abaixo do desktop; os breakpoints menores das telas alteradas herdam os
`@media` da Fundação V2 (já testados) mais um `@media (max-width: 900px)` por
tela para a tabela colapsar `table-layout`. `.vf-metric-row` colapsa para 2
colunas em ≤640px.

## 18. Acessibilidade

Fechado onde as telas foram tocadas: `role="status"` + `aria-live` nos blocos de
carregamento/feedback; `.vf-info-dot` é `<button>` com `aria-label` e tooltip
que abre no `:focus-within`; `.vf-status` carrega significado por forma além de
cor; modais com `role="dialog"` + `aria-modal` + fechar por ESC e backdrop.

## 19. Antes/depois

Screenshots de QA foram capturados durante a implementação (Claude-in-Chrome
sobre serve local + mock de API). Não commitados — o repo não comporta binários
pesados de screenshot. Local de QA: `frontend/v3-ui-ux-revamp-wave1` servida por
mock; rotas do Shell (`/me/context`, `/me/portfolio`) e das telas alteradas
respondidas por fixture.

## 20. Testes

| Camada | Resultado |
|---|---|
| React `vitest` (`frontend-react`) | **138/138 verde** — baseline e pós-mudança |
| Contrato DOM das telas alteradas | preservado (IDs, classes e `data-*` que o JS de cada tela consome) |
| Headless Portal (`*-shell-ui.test.js`) | **não roda neste ambiente Windows** (spawn de `google-chrome` sem PATH). Nenhuma das telas alteradas tem `*-shell-ui.test.js` dedicado. Em CI Linux a suíte roda. |
| Visual + funcional | Claude-in-Chrome nas 5 telas alteradas + regressão em carteira/visão/automacoes/bases |
| `git diff --check` | limpo |
| `node --check` nos 4 `.js` alterados | OK |

## 21. Regressões

**Nenhuma nova.** As mudanças de Design System (`.vf-status` por forma,
`[hidden]` global, `.vf-metric` flex) foram verificadas em telas não-alteradas
(carteira, bases, visão, automacoes): render correto, estados do shell corretos,
`.vf-status.is-warning` agora losango em Bases ("◆ Sem data") conforme intenção
do DESIGN.md.

## 22. Arquivos alterados

```
docs/ui-ux/VENFORCE_V3_UI_UX_AUDIT_WAVE1.md      (novo)
Portal/css/vf-tokens-v2.css                       ([hidden] global)
Portal/css/vf-components-v2.css                   (.vf-status forma, .vf-metric-row, .vf-info)
Portal/css/vf-shell.css                           (remove guards fora de @layer)
Portal/design-system-lab.html                     (exemplos)
Portal/css/pages/atividade-v2.css                 (novo)
Portal/css/pages/usuarios-v2.css                  (novo)
Portal/css/pages/callbacks-v2.css                 (novo)
Portal/css/pages/clientes-v2.css                  (regras de tabela migradas)
Portal/css/pages/carteira-v2.css                  (densidade)
Portal/atividade.html  Portal/atividade.js
Portal/usuarios.html   Portal/usuarios.js
Portal/callbacks.html  Portal/callbacks.js
Portal/clientes.html   Portal/clientes.js
Squads_migration/VENFORCE_V3_PESSOA1_UI_UX_WAVE1_READINESS.md  (este)
```

## 23. server/**

**NENHUM.**

## 24. Dívidas visuais restantes

- `style.css` continua no repo (só saiu do `<head>` de 4 telas).
- ~2.000 linhas mortas em `style.css` para marcações antigas (documentadas).
- `css/pages/*-v2.css` das telas densas sem passe de gordura.
- Tema escuro legado (`financeiro.html`, `fechamento.html`) — superados pelo
  Financeiro V3.
- `venforce-ui-v2.css` e as 4 telas standalone que dependem dele.
- Cartão de conta dentro da expansão de Clientes: alinhamento de "Principal" /
  status / mono ainda tem folga (Wave 2).
- Infra de teste headless não roda em Windows (fix é da convergência, não daqui).

## 25. Wave 2 recomendada

1. **Central de Vendas / Ads / Anúncios / Margem** — passe de densidade e
   hierarquia; `.vf-metric-row` para os KPIs em linha; `.vf-info-dot` em
   ROAS/TACOS/ACOS/MC; de-dup `style.css` ↔ `css/pages/*-v2.css`.
2. **Relatórios / Automações / Bases / Diagnósticos** — largar `style.css`,
   consolidar os blocos `.vf-page-*` que ainda vivem nele.
3. **Shell** — só se houver decisão de produto: colapso persistente, densidade
   compacta como preferência, seletor de período mais proeminente.
4. **`style.css`** — plano de remoção total (por tela, com QA), depois deletar.
5. **Pessoas** — quando o contrato Squad/Responsabilidades existir, adicionar as
   colunas (a base visual já comporta).
6. Screenshots antes/depois versionados em `docs/ui-ux/wave2/` se o time quiser.

## 26. Readiness

| | |
|---|---|
| DESIGN SYSTEM | **APROVADO** — consolidado, sem terceiro sistema, zero token novo de cor/tipo |
| CORE UI | **PARCIAL** — 5 telas fundo + densidade da Carteira; telas densas ficam para a Wave 2 (por decisão de escopo, não bloqueio) |
| RESPONSIVIDADE | **PARCIAL** — desktop (1920–1200) verificado; abaixo disso herda a V2 + `@media` por tela, não re-testado por limite do ambiente |
| REGRESSÕES | **NÃO** |
| PRONTO PARA MERGE | **SIM** — para a próxima convergência de frontend. Não mergear direto na main. |

---

## Resposta final

**MARATONA UI/UX WAVE 1: CONCLUÍDA (escopo aprovado: doc + DS + 4–5 telas fundo)**

- **BRANCH:** `frontend/v3-ui-ux-revamp-wave1`
- **HEAD:** `52f5bc5cbcb5dc0f3ce52a06f8861e41ddbac542`
- **PUSH:** SIM
- **MAIN BASE:** `origin/main @ 07134b5` (PR #90 / Convergência #4)
- **PÁGINAS AUDITADAS:** ~40 (inventário completo no doc de auditoria)
- **PÁGINAS ALTERADAS:** 5 (atividade, usuarios/pessoas, callbacks, clientes,
  carteira) + design-system-lab
- **DESIGN SYSTEM:** consolidado — `.vf-status` por forma, `[hidden]` global,
  `.vf-metric-row`, `.vf-info-dot`; sem token novo de cor/tipo
- **SHELL:** auditado, não alterado (maduro; risco > ganho)
- **CARTEIRA:** passe de densidade (grupo/linha mais justos + hover de linha)
- **VISÃO / FINANCEIRO:** não tocadas — são a referência
- **CENTRAL DE VENDAS / ADS / ANÚNCIOS / AUTOMAÇÕES:** Wave 2 (já usam a V2)
- **RESPONSIVIDADE:** desktop verificado; menores herdam a V2
- **ACESSIBILIDADE:** fechada nas telas tocadas (status por forma, aria-live,
  modais com ESC/backdrop, info-dot focável)
- **BUGS FUNCIONAIS ENCONTRADOS:** nenhum (frontend); nenhum de backend
- **BUGS VISUAIS ENCONTRADOS:** `[hidden]` perdia para `display` de componente
  de autor (`.vf-banner` fantasma) — **corrigido** globalmente
- **BUGS CORRIGIDOS:** o do `[hidden]`; prévia de detalhes em JSON cru na
  Atividade; header com descrição deslocada em Pessoas
- **VITEST:** 138/138
- **HEADLESS:** não roda no ambiente Windows (infra de teste da convergência)
- **BUILDS:** N/A (as telas alteradas são vanilla; ilhas React não tocadas)
- **REGRESSÕES NOVAS:** NÃO
- **SERVER/** TOCADO:** NÃO
- **ARQUIVO DE AUDITORIA:** `docs/ui-ux/VENFORCE_V3_UI_UX_AUDIT_WAVE1.md`
- **ARQUIVO FINAL:** `Squads_migration/VENFORCE_V3_PESSOA1_UI_UX_WAVE1_READINESS.md`
- **PRONTO PARA MERGE:** SIM (via próxima convergência de frontend)
- **WAVE 2 RECOMENDADA:** telas operacionais densas (Central de Vendas, Ads,
  Anúncios, Margem) + limpeza de `style.css` por tela
- **PRÓXIMO PASSO:** revisão da branch; incluir na próxima convergência de
  frontend junto com o pacote da Pessoa 2 (backend account audit + P2.9)
