# VENFORCE V3 — Auditoria UI/UX · Wave 1

> Auditoria global do Portal antes da primeira onda de revamp visual.
> Sem decisão de produto, sem toque em backend. Base: `origin/main @ 07134b5` (PR #90 / Convergência #4).

**Autor:** Pessoa 1 (coordenação) · **Branch:** `frontend/v3-ui-ux-revamp-wave1` · **Data:** 2026-09-01

---

## 0. TL;DR

O Portal **já passou da fase caótica**. Existe uma Fundação Global V2 madura
(`vf-tokens-v2.css` + `vf-components-v2.css` + `vf-shell.css`/`vf-shell.js`) e um
documento de design canônico (`DESIGN.md`) com regras nomeadas. **20 páginas já
rodam o Shell V3** e a maioria já usa o vocabulário de componentes da V2 no corpo.

O que resta **não é um redesenho** — é fechar a cauda da adoção e elevar densidade
e hierarquia nas telas densas:

1. **`style.css` (V1, 5.932 linhas) ainda é carregado por ~17 páginas.** Redefine
   `:root` com valores antigos (radius 16px, `--vf-primary-hover` roxo-claro) e
   carrega ~4.000 linhas mortas para a marcação atual.
2. **Cauda de páginas administrativas** (`usuarios`, `atividade`, `callbacks`,
   `ml-tokens`) ainda usa `.vf-card-header` / `.vf-form-group` (V1) e vocabulários
   próprios (`.vf-act-*`).
3. **Densidade e hierarquia** nas telas operacionais densas ainda são herdadas de
   momentos diferentes — não há um "strip de métricas" denso padronizado, nem
   tooltip de métrica, nem um bloco de page-header pronto para as páginas vanilla.
4. **CSS por página** (`css/pages/*-v2.css`, 10.722 linhas) tem gordura: blocos que
   reimplementam componentes que a V2 já tem, e blocos mortos de marcações antigas.

**Wave 1 (aprovada):** doc + endurecimento do Design System + 4–5 telas fundo.

---

## 1. Identificação

| Campo | Valor |
|---|---|
| main base | `origin/main` |
| HEAD base | `07134b537c794dc6b3952601edd5ea9fbb9bd56a` |
| Merge da base | PR #90 — Convergência #4 |
| branch de trabalho | `frontend/v3-ui-ux-revamp-wave1` |
| escopo permitido | `Portal/**`, `frontend-react/**`, CSS, assets, testes frontend, docs UI/UX |
| escopo proibido | `server/**`, schema, migrations, Squads, regras de negócio, contratos |
| baseline React vitest | **138/138 verde** |
| baseline headless Portal | **não roda neste ambiente Windows** — os testes fazem `spawn("google-chrome")` sem entrada no PATH e sem privilégio para symlink. Compensação de QA na §9. |

---

## 2. Método

Para cada tela relevante:

1. Qual a função e a ação principal?
2. Qual informação é primária vs. secundária?
3. O que está visualmente ruim / inconsistente / lento?
4. O que deve permanecer exatamente como está?
5. O que deveria virar componente/padrão global?

Fontes lidas: `DESIGN.md`, `vf-tokens-v2.css`, `vf-components-v2.css`, `vf-shell.css`,
`vf-shell.js` (modelo de navegação), `style.css` (estrutura), `venforce-ui-v2.css`,
todos os `Portal/*.html` (heads + corpos das telas-chave), `frontend-react/src/**`,
`docs/auditoria-frontend/*` (auditoria anterior de 2026-07-02).

---

## 3. Inventário de telas

### 3.1 Operacionais no Shell V3 (`vf-shell.js`)

| Tela | Arquivo | Tech | `style.css` | Vocabulário no corpo | Escopo |
|---|---|---|---|---|---|
| Visão | `visao.html` + ilha React | React | sim (só estados globais) | DS V2 puro | account |
| Financeiro V3 | `financeiro-v3.html` + ilha React | React | sim | DS V2 puro | account |
| Carteira | `carteira.html` (`carteira.js`) | Vanilla | **não** | DS V2 puro (JS-render) | global |
| Central de Vendas | `fechamentos-api.html` | Vanilla | sim | DS V2 (tabs, banner, btn) | account |
| Ads | `ads.html` | Vanilla | sim | DS V2 (toolbar, card, table) | account |
| Anúncios | `anuncios-meli.html` | Vanilla | sim | DS V2 (section, toolbar) | account |
| Margem | `central-margem.html` | Vanilla | sim | DS V2 (tabs, segmented) | client |
| Diagnósticos | `diagnostico-inicial.html` | Vanilla | sim | DS V2 (kpi, segmented, empty) | client |
| Automações | `automacoes.html` | Vanilla | sim | DS V2 (page-header, card, kpi-grid, table-wrap) | account |
| Bases | `bases.html` | Vanilla | sim | DS V2 (section, table, empty) | global |
| Clientes e Contas | `clientes.html` | Vanilla | sim | DS V2 + **13 inline styles** | global |
| Relatórios | `relatorios.html` | Vanilla | sim | DS V2 (toolbar, drawer, field) | global |
| Pessoas | `usuarios.html` | Vanilla | sim | **V1** (`.vf-card-header`, `.vf-form-group`) | global |
| Atividade | `atividade.html` | Vanilla | sim | **V1 + `.vf-act-*`** + 5 inline styles | global |
| Guia do Vendedor | `guia-vendedor.html` | Vanilla | sim | inline `<style>` editorial (~500 ln) | global |
| Ferramentas | `ferramentas.html` | Vanilla | sim | DS V2 (redesign recente) | global |
| Callbacks | `callbacks.html` | Vanilla | sim | **V1** (`.vf-card-header`, `.vf-form-group`) | global |
| Control Center | `control-center.html` | Vanilla | sim | ilha própria `.vfc-` (dark) | global |
| Debug Financeiro | `financeiro-debug.html` | Vanilla | sim | — | global |
| Laboratório UI | `design-system-lab.html` | Vanilla | sim | DS V2 (showroom) | global |

### 3.2 Fora do Shell V3 (legado / standalone / superado)

`dashboard.html` (→ Visão), `financeiro.html` / `fechamento.html` (→ Financeiro V3,
tema escuro `.fc-`), `cliente-360*.html` (→ ilha React), `cliente-operacao.html`,
`criar-anuncios-meli.html`, `promocoes-retorno.html`, `design-templates.html` +
design-studio, `clickup-executivo.html`, `seller.html`, `ml-tokens.html`,
`relatorio-publico.html`, `index.html` (login).

### 3.3 Ilhas React (`frontend-react/`)

Cliente 360, Central de Gestão Full, Visão (F3), Financeiro (F4). Cada ilha tem
`src/styles/*.css` só com layout específico (~47–200 linhas); todos os componentes
(`vf-section`, `vf-kpi`, `vf-banner`, `vf-status`…) vêm inteiros da Fundação V2.
**São a melhor referência de "produto único" que o Portal tem hoje.**

---

## 4. Score visual (1–5, UX operacional pesa mais que estética)

| Tela | Import. | Consist. | Hierarq. | Densid. | Respons. | Feedback | UX | **Maturidade** | **Prioridade** |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Visão (React) | 5 | 5 | 5 | 4 | 4 | 4 | 5 | **alta** | manter |
| Financeiro V3 (React) | 5 | 5 | 4 | 4 | 4 | 5 | 4 | **alta** | manter |
| Carteira | 5 | 5 | 4 | 3 | 4 | 4 | 4 | **alta** | densidade |
| Cliente 360 (React) | 4 | 5 | 4 | 4 | 4 | 4 | 4 | **alta** | manter |
| Shell / Contexto | 5 | 4 | 4 | 4 | 4 | 3 | 4 | **alta** | polish |
| Ferramentas | 3 | 4 | 4 | 4 | 4 | 3 | 4 | **alta** | manter |
| Relatórios | 4 | 4 | 4 | 3 | 3 | 3 | 3 | **média** | Wave 2 |
| Automações | 4 | 4 | 3 | 3 | 3 | 4 | 3 | **média** | Wave 2 |
| Central de Vendas | 5 | 4 | 3 | 3 | 3 | 3 | 3 | **média** | Wave 2 |
| Ads | 4 | 4 | 3 | 3 | 3 | 3 | 3 | **média** | Wave 2 |
| Anúncios | 4 | 4 | 3 | 2 | 3 | 3 | 3 | **média** | Wave 2 |
| Margem | 5 | 4 | 3 | 3 | 3 | 3 | 3 | **média** | Wave 2 |
| Bases | 5 | 4 | 3 | 3 | 3 | 3 | 3 | **média** | Wave 2 |
| Diagnósticos | 4 | 4 | 4 | 3 | 3 | 3 | 3 | **média** | Wave 2 |
| Clientes e Contas | 5 | 3 | 3 | 3 | 3 | 3 | 3 | **média-baixa** | **Wave 1** |
| Pessoas (usuarios) | 4 | 2 | 2 | 2 | 3 | 2 | 3 | **baixa** | **Wave 1** |
| Atividade | 3 | 2 | 2 | 2 | 3 | 2 | 2 | **baixa** | **Wave 1** |
| Callbacks | 2 | 2 | 2 | 2 | 3 | 2 | 2 | **baixa** | Wave 1 (leve) |
| Guia do Vendedor | 3 | 3 | 4 | 3 | 4 | — | 4 | **média** | manter |
| Control Center | 2 | 2 | 3 | 4 | 2 | 3 | 3 | **baixa** | fora de escopo |

**Nota sobre a ordem do brief.** O brief sugeria Shell → Carteira → Visão →
Financeiro → Central de Vendas → Ads → Anúncios → Automações. A auditoria prova
outra ordem: **Visão, Financeiro e Cliente 360 já são as melhores telas** (ilhas
React sobre a V2); **Automações, Relatórios, Ads, Central de Vendas já adotaram os
componentes** — precisam de um passe de densidade/hierarquia, não de migração. As
telas realmente heterogêneas são a **cauda administrativa** (`usuarios`,
`atividade`, `callbacks`) e **`clientes`** (importância crescente com Squads,
§25/§26 do brief). Wave 1 ataca essas + Shell polish + Carteira densidade + o
endurecimento do Design System que destrava todas as ondas seguintes.

---

## 5. Design System — estado atual

### 5.1 O que existe e é canônico (reutilizar, não recriar)

| Camada | Arquivo | Linhas | Papel |
|---|---|:-:|---|
| Tokens | `Portal/css/vf-tokens-v2.css` | 345 | cor, tipografia, spacing (4px), forma (6/10/12px), sombra (só resposta a estado), controles, layout, movimento, camadas, foco, **densidade como atributo** (`data-vf-density="compact"`) |
| Componentes | `Portal/css/vf-components-v2.css` | 2.424 | page-shell/header/section, botões (primary/secondary/ghost/danger + sm/lg/icon + group + loading), campos (input/select/textarea/check/radio/switch/input-group/search), cards, **KPIs** (grid + trend + interactive + warning/danger), tags/badges/**status (dot + texto)**, toolbar/filtros/chips/active-filters, **tabelas** (sort, sticky, row states, compact/comfortable, empty/loading), tabs + segmented, banner/alert/toast, **empty/loading/skeleton/spinner/progress**, modal/drawer, menu/popover/tooltip, dropzone/file-item, utilitários, animações, responsivo |
| Shell | `Portal/css/vf-shell.css` | 580 | grid do shell, sidebar sticky, bloco de contexto sticky, seletor de contexto, navegação (item ativo com faixa), lista densa da Carteira (`.vf-portfolio-list`), chip de operação, responsividade (rail 64px ≤1200, faixa horizontal ≤860, reparenting do contexto) |
| Shell JS | `Portal/vf-shell.js` | 913 | modelo de navegação (8 módulos contextuais + globais + admin), 13 estados de contexto, gating por escopo/marketplace, seletores Cliente/Conta, período |
| Doc canônico | `DESIGN.md` | 254 | North Star ("A Mesa de Conciliação"), regras nomeadas |

### 5.2 Regras nomeadas do `DESIGN.md` (mantidas como lei da Wave 1)

- **The One Accent Rule** — roxo só em ação primária, seleção e marca.
- **The Semantic-Only Color Rule** — verde/laranja/vermelho/azul só codificam estado real do dado.
- **The No-Shadow-At-Rest Rule** — nenhuma superfície tem sombra em repouso.
- **The Numeric-vs-Identifier Rule** — `.num` (Manrope tabular) para dinheiro/quantidade, `.vf-mono` (IBM Plex Mono) para identificadores.
- **The Shared-Contract Rule** — Vanilla e React compartilham tokens/regras, nunca scripts.

### 5.3 Conflitante / duplicado / legado / ausente

| Categoria | Achado |
|---|---|
| **CONFLITANTE** | `style.css` redefine `:root`: `--vf-bg #f8f9fc`, `--vf-text #2d2d2d`, `--vf-radius 16px`, `--vf-radius-sm 10px`, `--vf-primary-hover #9a6ddb` (roxo-claro; V2 usa `#4c2379` escuro). Hoje vence a V2 só pela ordem de carga (`vf-tokens-v2.css` depois). Frágil. |
| **CONFLITANTE** | `vf-shell.css` tem 3 correções **fora de `@layer`** por design (status por forma, guard de `[hidden]`, cor de link Bootstrap) — os próprios comentários pedem migração para `vf-components-v2.css`. |
| **DUPLICADO** | `.vf-card-header` (V1) vs `.vf-card__header` (V2); `.vf-form-group` (V1) vs `.vf-field` (V2); `.vf-table-wrapper` (V1) vs `.vf-table-wrap` (V2); `.vf-act-*` reimplementa kpi/empty/error/loading. |
| **DUPLICADO** | Blocos em `style.css` para marcação que **não existe mais**: `.vf-page-automacoes .vf-auto-config-body/-grid` (a tela nova usa `.vf-auto-config`), `.vf-page-relatorios .vf-drive-sidebar` (a tela nova usa `.vf-report-sidebar`). ~2.000 linhas mortas. |
| **LEGADO** | Tema escuro `.fc-` em `financeiro.html`/`fechamento.html` (superados pelo Financeiro V3). Fora de escopo da Wave 1. |
| **LEGADO** | `venforce-ui-v2.css` (744 ln) — carregado só por 4 telas standalone (`clickup-executivo`, `cliente-360`, `cliente-operacao`, `relatorio-publico`). Fora de escopo. |
| **AUSENTE** | Bloco de **page-header pronto** para páginas vanilla que não têm um `#root` React (hoje cada página remonta `.vf-page-header` na mão, com variações). |
| **AUSENTE** | **Strip de métricas denso** (5+ números numa linha, altura de ~64px) — o `.vf-kpi` atual é ótimo para 3–4 cards, largo demais para 6+. |
| **AUSENTE** | **Tooltip de métrica** — helper para ROAS/TACOS/MC/conciliação/escopoConta. O `.vf-tooltip` existe como visual, falta o padrão de uso (`<button class="vf-info-dot" aria-label>` + texto curto). |
| **AUSENTE** | **Padrão de estado vazio com ação** documentado por contexto (o componente `.vf-empty` existe; falta o vocabulário: título específico + 1 ação real, nunca "Nenhum dado"). |

### 5.4 Antes → Depois (o que a Wave 1 muda no DS)

| Item | Antes | Depois (Wave 1) |
|---|---|---|
| Correções fora de `@layer` do shell | 3 regras órfãs em `vf-shell.css` | migradas para `vf-components-v2.css` (§16 do arquivo), `vf-shell.css` só referencia |
| page-header vanilla | remontado à mão por página | `.vf-page-header` já cobre; documentar o esqueleto no `design-system-lab.html` |
| métricas densas | só `.vf-kpi` (largo) | novo `.vf-metric-row` / `.vf-metric` (denso, tabular, sem card individual) |
| tooltip de métrica | só visual | `.vf-info-dot` (alvo 16px, `aria-describedby`, texto ≤140 car.) |
| tokens | `style.css` compete no `:root` | páginas migradas deixam de carregar `style.css`; `:root` fica só na V2 |

**Zero tokens novos de cor/tipografia.** `.vf-metric-row` e `.vf-info-dot` consomem
tokens existentes.

---

## 6. Padrões definidos para a Wave 1

### Tipografia
Sem mudança. Manrope (display/números), Hanken Grotesk (corpo/controles), IBM Plex
Mono (identificadores). Escala `--vf-fs-*` da V2. `.num` e `.vf-mono` conforme a
Numeric-vs-Identifier Rule.

### Spacing / Radii / Borders
Sem mudança. Múltiplos de 4px (`--vf-sp-*`), radius 6/10/12px, borda 1px + fundo
neutro para separar áreas (nunca sombra em repouso).

### Page header (vanilla)
```
<header class="vf-page-header">
  <div class="vf-page-header__main">
    <p class="vf-page-header__eyebrow">CONTEXTO · SUBCONTEXTO</p>
    <h1 class="vf-page-header__title">Título da tela</h1>
    <p class="vf-page-header__description">Uma linha: o que a tela responde.</p>
  </div>
  <div class="vf-page-header__actions"><!-- ação primária à direita --></div>
</header>
```

### Cards
`.vf-card` + `.vf-card__header/__title/__body/__footer`. `.vf-card--compact` em
telas densas. Nunca `.vf-card-header` (V1).

### Tabelas
`.vf-table-wrap > table.vf-table`. Scroll sempre dentro do wrapper. `.num` nas
colunas numéricas. `.vf-table--compact` em listas longas. Estados de linha por
classe (`row--warning/--danger/--selected`), nunca por `filter`. Cabeçalho
ordenável com `.vf-table__sort`.

### Buttons
`.vf-btn` base + `--primary` / `--secondary` / `--ghost` / `--danger`, tamanhos
`--sm` / `--lg` / `--icon`. `.is-loading` para ação assíncrona (largura não muda).

### Inputs
`.vf-field > .vf-field__label + .vf-input/.vf-select/.vf-textarea + .vf-field__hint`.
Erro em elemento próprio `.vf-field__error` com `role="alert"`. Valor vindo do
contexto do Shell = `.vf-field__value` (sem borda).

### Tabs
`.vf-tabs > .vf-tab` (sublinhado roxo no ativo). `.vf-segmented` para alternância
curta dentro de uma seção.

### States
- **loading** — `.vf-loading-state` (bloco) ou `.vf-skeleton--*` (in-place)
- **empty** — `.vf-empty` com título específico + 1 ação real
- **no results** — mesmo layout, texto "ajuste os filtros" + `.vf-clear-filters`
- **error** — `.vf-banner.is-danger` ou `.vf-empty` com `__icon.is-danger`; código técnico só em `<details>`

### Feedback de ação
Todo botão de ação importante: `clicou → .is-loading → toast/banner de resultado →
o que mudou`. Nunca "botão some, tela parada".

### Densidade
`data-vf-density="compact"` no container das telas-tabela. Não duplicar componente.

---

## 7. Plano da Wave 1

### Fase A — Design System (baixo risco, sem mudança de comportamento)
1. **A1** — migrar as 3 correções fora de `@layer` de `vf-shell.css` → `vf-components-v2.css`.
2. **A2** — adicionar `.vf-metric-row` / `.vf-metric` (strip denso) ao catálogo.
3. **A3** — adicionar `.vf-info-dot` (tooltip de métrica) ao catálogo.
4. **A4** — atualizar `design-system-lab.html` com os 3 padrões + o esqueleto de page-header vanilla.

### Fase B — Telas (ordem de execução)
5. **B1 — Shell / Contexto** — só polish: revisar item ativo, agrupamento da nav,
   hierarquia do bloco de contexto em ≤1200 (reparenting), foco de teclado. Sem rewrite.
6. **B2 — Carteira** — passe de densidade na `.vf-portfolio-list`; afordância de
   busca/ordenação; sem quebrar `carteira.js` nem `carteira-ui.test.js` (P01–P13).
7. **B3 — Atividade** — migrar `.vf-act-*` + `.vf-card-header` + `.vf-form-group` →
   DS; resumo vira `.vf-metric-row`; filtros viram `.vf-toolbar`; estados viram
   `.vf-empty`/`.vf-loading-state`; remover 5 inline styles; **dropar `style.css`**.
8. **B4 — Pessoas (`usuarios.html`)** — migrar V1 → DS; preparar estrutura visual
   para Pessoa / Role / Squad / Responsabilidades / Status (§26 — só UI, sem
   contrato, sem implementar rollout). **Dropar `style.css`**.
9. **B5 — Clientes e Contas** — tornar óbvia a árvore `Cliente ▸ Conta 1 ▸ Conta 2`
   (marketplace, seller, grant, base, status); remover 13 inline styles; §25.
10. **B6 — Callbacks** — migração leve V1 → DS (admin pequeno).

### Fora da Wave 1 (→ Wave 2)
Relatórios, Automações, Central de Vendas, Ads, Anúncios, Margem, Bases,
Diagnósticos (passe de densidade/hierarquia + limpeza `style.css` ↔ `css/pages/`);
tema escuro legado; design-studio; Control Center; ilhas React internas.

### Gate de cada tela
`ANTES (screenshot) → problemas → objetivo → alteração → QA visual 1920/1440/1366/1200
(Claude-in-Chrome) → checagem de contrato DOM contra o `*-shell-ui.test.js` da tela →
commit`. Qualquer achado backend: documentar, não corrigir.

---

## 8. Referências internas (linguagem visual canônica)

| | Tela | O que extrair |
|---|---|---|
| **A** | **Visão (React)** | grid de blocos, `.vf-kpi` em linha, `.vf-status` por forma, empty curto in-bloco, `is-atualizando` (opacity 0.6) |
| **B** | **Carteira** | lista densa vs. card, régua de 1px como moldura, chip de operação como alvo único, grupo com `<small>` de contagem |
| **C** | **Financeiro V3 (React)** | fluxo em tabs (`Resultado → Conciliação → Fechamento → Relatórios → Histórico`), estado de publicação explícito, 409 vira escolha cancelar/substituir |

Delas saem: spacing de seção (`--vf-section-gap`), header de página, header de
seção, tabela densa, botões, badges, tabs, empty states, inputs, filtros,
estrutura `page-shell → page-container → header + seções`.

---

## 9. QA — compensação da ausência de headless

| Camada | Ferramenta | Cobertura |
|---|---|---|
| Lógica React | `vitest` (`frontend-react`) | 138 testes — devem seguir verdes |
| Contrato DOM | leitura dos `Portal/*-shell-ui.test.js` antes de tocar cada tela | IDs, classes e `data-*` que o teste headless assere são preservados |
| Visual + funcional | **Claude-in-Chrome** sobre serve estático local + servidor | render em 1920/1440/1366/1200; overflow, hierarquia, spacing, tabela, sidebar, dropdown, modal, loading, empty, error |
| Higiene | `git diff --check` | whitespace / conflito |

Se o ambiente de CI (Linux, com `google-chrome`) estiver disponível na revisão do
PR, a suíte headless completa roda lá — nada nesta branch a impede.

---

## 10. Dívidas conhecidas que a Wave 1 **não** resolve

- `style.css` continua no repo (só sai do `<head>` das telas migradas).
- ~2.000 linhas mortas em `style.css` para marcações antigas (documentadas, não removidas).
- CSS por página (`css/pages/*-v2.css`) sem passe de gordura.
- Tema escuro legado (`financeiro.html`, `fechamento.html`).
- `venforce-ui-v2.css` e as 4 telas standalone que dependem dele.
- Ilhas React: `src/styles/*.css` não revisado (fora de escopo, já são boas).
- Acessibilidade: foco/contraste fechados só onde a tela for tocada.

---

## 11. server/** esperado

**NENHUM arquivo em `server/**` deve ser tocado nesta branch.** Qualquer bug de
backend encontrado durante a Wave 1 é registrado neste doc (§12) e deixado para a
Pessoa 2 / uma branch de backend.

## 12. Achados de backend durante a auditoria

_(nenhum até agora — atualizar conforme a implementação avança)_
