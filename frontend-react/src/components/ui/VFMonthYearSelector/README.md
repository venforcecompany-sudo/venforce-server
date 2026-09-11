# VFMonthYearSelector

Seletor de **competência** (mês + ano) da **Fundação Global V2**. Usado em Financeiro V3,
Visão V3, Relatórios e filtros operacionais.

> Diferente do `VFButton`, a Fundação ainda não tem um padrão `.vf-calendar` pronto, então
> este componente **tem CSS próprio** (`VFMonthYearSelector.css`). A regra não muda: só
> `var(--vf-*)` de `Portal/css/vf-tokens-v2.css`, nenhum token novo, nenhuma cor/raio/espaço
> inventado. O visual segue a mesma linguagem do VFCalendar — mesmos raios, sombra de
> popover e tipografia.

Modelo visual aprovado (canvas `/design` — "Espelho do Calendário + Caixa Expansiva").

## Objetivo

Selecionar mês + ano. **Não** seleciona dia, intervalo de datas nem hora.

```
2026-06  →  Junho 2026
```

## Comportamento

- **Sem botão de confirmar/OK.** Clicar num mês já aplica a competência e recolhe o
  popover — é uma escolha única e de baixo risco, diferente de um intervalo de datas.
- **`value` é a fonte da verdade.** Formato `"AAAA-MM"`. Sempre representa uma competência
  válida.
- **Fallback é só proteção.** Se `value` estiver ausente ou for inválido, o componente
  exibe o mês/ano atual (mesma inicialização que o Portal já usa em outras telas) — mas
  isso **nunca** dispara `onChange`. O fallback é puramente visual/defensivo; só o clique
  num mês chama `onChange`.
- Navegar de ano (setas `‹ ›` ou dropdown) só troca a grade visível — não aplica nada
  sozinho.
- Fecha ao clicar fora ou pressionar `Esc`, sem disparar `onChange`.

## API

| Prop        | Tipo                        | Default      | Descrição                                                                 |
| ----------- | --------------------------- | ------------ | -------------------------------------------------------------------------- |
| `value`     | `string` (`"AAAA-MM"`)      | mês atual    | Competência controlada. Ausente/inválido cai no mês atual (sem `onChange`). |
| `onChange`  | `(value: string) => void`   | —            | Chamado com a nova competência assim que um mês é clicado.                 |
| `disabled`  | `boolean`                   | `false`      | Bloqueia a abertura do popover; `onChange` nunca dispara.                  |
| `className` | `string`                    | —            | Classes extras no elemento raiz.                                          |

## Exemplo

```jsx
import { useState } from "react";
import { VFMonthYearSelector } from "@/components/ui";

function FiltroCompetencia() {
  const [competencia, setCompetencia] = useState("2026-06");

  return (
    <VFMonthYearSelector
      value={competencia}
      onChange={setCompetencia}
    />
  );
}
```

## Relação com a Fundação Global V2

| Elemento                  | Tokens usados                                                              |
| -------------------------- | --------------------------------------------------------------------------- |
| Caixa de gatilho           | `--vf-control-h-sm`, `--vf-radius-sm`, `--vf-border-strong`, `--vf-surface` |
| Popover                    | `--vf-radius-lg`, `--vf-shadow-popover`, `--vf-surface`, `--vf-border`      |
| Mês selecionado            | `--vf-primary`, `--vf-text-on-primary`                                     |
| Hover de mês               | `--vf-primary-soft`, `--vf-primary-strong`                                 |
| Dropdown de ano            | `--vf-radius`, `--vf-shadow-popover`, `--vf-primary-soft`                  |
| Disabled                   | `--vf-disabled-bg`, `--vf-text-disabled`, `--vf-border`                    |

## O que este componente **não** faz

- não seleciona dia, hora ou intervalo de datas;
- não tem botão de confirmar/cancelar — a seleção do mês é a única ação;
- não cria token novo — só usa `var(--vf-*)` já existentes;
- não toca backend, API, rotas ou telas existentes.
