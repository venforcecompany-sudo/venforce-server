# VenForce V3 — Decisões de produto abertas na UX de Squads

Pessoa 1 · branch `frontend/v3-squads-rollout-ux-readiness` · base `fd2671a`

Este documento existe para separar **bug** de **decisão**. Tudo que era regra
determinística quebrada foi corrigido e testado nesta branch (ver
`VENFORCE_V3_PESSOA1_SQUADS_ROLLOUT_UX_READINESS.md`). O que sobrou aqui são
seis escolhas que **mudam o produto** e por isso não podem ser tomadas por um
agente sozinho.

Nenhuma delas bloqueia o P2.9. O frontend funciona hoje em todas as opções A
(o comportamento atual); as opções B/C são evoluções que dependem de alguém
dizer o que o VenForce quer.

Regra de leitura: **A é sempre o que está no código agora.** Escolher A é
uma decisão válida e não exige trabalho nenhum.

---

## D1 — O Squad principal deve FILTRAR a Carteira por padrão?

**Estado atual.** Não. `squadPrincipalId` (quando o backend o envia) faz duas
coisas e só: põe o grupo do squad principal **à frente** da lista e o rotula
`principal`. O filtro nasce em `Todos`, e todos os clientes autorizados
aparecem. Sem `squadPrincipalId`, ninguém é principal — nada é deduzido de
ordem de array, menor id ou função no squad.

**Por que isto é decisão e não bug.** Existem usuários reais em vários squads
(Klayvert em 2/3/6, Micael em 1/5, Fernando em 1/4). Para eles, "abrir já
filtrado no principal" é conveniência ou é esconder metade da carteira —
depende de como a operação realmente trabalha, e isso ninguém no código sabe.

| Opção | O que acontece |
|---|---|
| **A (atual)** | Carteira abre completa; principal só ordena e rotula. |
| **B** | Carteira abre filtrada no principal, **com um aviso explícito e persistente** ("mostrando só Squad 6 · ver todos os N clientes") — filtro visível, nunca silencioso. |
| **C** | Carteira lembra o último filtro usado por usuário (sessão/preferência), com o principal como valor inicial. |

**Recomendação: A por enquanto.** Só vale trocar quando as carteiras reais
estiverem carregadas e alguém medir que os multi-squad realmente sofrem para
achar o cliente. Se for para B, o aviso é obrigatório: filtro invisível é a
única variante inaceitável — o usuário concluiria que perdeu acesso.

**Impacto se mudar.** Baixo e localizado: valor inicial de `squad` em
`carteira.js` + um banner na barra de filtros. Nenhuma mudança de contrato.

**Decisão do usuário:** a Carteira deve abrir completa ou já focada no squad
principal?

---

## D2 — Onde o "Squad 8 · Legado" fica na ordem, e ele deve vir recolhido?

**Estado atual.** Os squads da tela saem nesta ordem: (1) principal, se
houver; (2) demais memberships na ordem que o backend mandou; (3) squads que
aparecem **só nos clientes** e não nas memberships — como o bucket legado —
ordenados por id; (4) o grupo `SEM SQUAD`, sempre por último.

Isso põe o Squad 8 depois dos operacionais **por consequência do id ser 8**,
não por uma regra "legado vai para o fim". Ele renderiza aberto, com o nome
real, e é filtrável como qualquer outro.

**Por que isto é decisão.** A missão proíbe decidir sozinho se o legado
aparece primeiro, por último ou escondido. E há um risco concreto de volume:
se o bucket legado receber muitos clientes antigos, ele passa a dominar a
rolagem de quem só quer trabalhar nos 6 squads operacionais.

| Opção | O que acontece |
|---|---|
| **A (atual)** | Ordem por id; legado aberto, junto dos demais. |
| **B** | Legado fixado no fim explicitamente (regra própria, independente do id) e com o grupo **recolhido** por padrão, com contagem visível ("Squad 8 · Legado · 34 clientes ▸"). |
| **C** | Legado fora da Carteira operacional, numa visão própria de saneamento. |

**Recomendação: A até o mapeamento real existir; reavaliar assim que a
Pessoa 2 disser quantos clientes caem no bucket.** Com poucos clientes, A é o
mais honesto (nada escondido). Passando de algumas dezenas, B fica melhor —
mas aí é uma escolha de produto informada por um número que ainda não existe.
C só se o legado virar um projeto de saneamento com dono.

**Impacto se mudar.** B é pequeno (uma regra de ordenação + `<details>` no
cabeçalho de grupo). C é uma tela nova.

**Decisão do usuário:** quantos clientes vão para o Squad 8, e ele é carteira
de trabalho ou fila de saneamento?

---

## D3 — O Shell deve ganhar um seletor global de Squad?

**Estado atual.** Não existe, e isso é deliberado: MASTER_SPEC D5/D7 e §10.6
dizem que squad é **agrupamento e filtro da Carteira**, nunca um passo antes
do Cliente. O contexto operacional canônico continua
`{ clienteId, clienteSlug, clienteContaId }`; Squad não entra nele (D6/D11),
e esta branch prova por teste que trocar o filtro de Squad não encosta em
cliente/conta.

**Por que a pergunta reaparece.** Quando os Squads reais chegarem, vai ser
tentador colocar um seletor de Squad ao lado dos seletores de Cliente e
Operação na barra de contexto. Isso criaria um **segundo nível de contexto** e
obrigaria a responder duas perguntas antes de trabalhar.

| Opção | O que acontece |
|---|---|
| **A (atual)** | Nenhum seletor global; Squad vive na Carteira. |
| **B** | Seletor global que é **só filtro de navegação** (afeta a Carteira e o dropdown de Cliente, nunca o contexto operacional). |
| **C** | Squad vira contexto de primeira classe, com tela "Escolha seu Squad" no login. |

**Recomendação: A, com convicção.** C está explicitamente fora — a missão o
proíbe e o MASTER_SPEC também. B só se aparecer uma dor real de navegação
depois do rollout, e mesmo assim com o cuidado de nunca gravar a escolha como
identidade.

**Impacto se mudar.** B é médio (o Shell passa a ter estado próprio, e todo
dropdown de Cliente precisa respeitá-lo). C é uma reescrita da espinha de
navegação.

**Decisão do usuário:** manter Squad como dimensão da lista, ou promovê-lo a
contexto?

---

## D4 — Depois do rollout, "cliente sem squad" é anomalia ou estado normal?

**Estado atual.** Neutro. Cliente com `squadId: null` cai num grupo próprio
`SEM SQUAD`, sempre por último, sem cor de alerta e sem mensagem de erro. Isso
está certo **hoje**: com `SQUADS_ENFORCEMENT=OFF` esse é o estado normal do
banco, e tratá-lo como falha seria mentir.

Depois do apply da Pessoa 2, a leitura inverte: um cliente sem squad passa a
ser um buraco no mapeamento. Mas **o frontend não tem como saber em que fase
está** — nem `/me/context` nem `/me/portfolio` informam se o enforcement está
ligado.

Relacionado: hoje o seletor de Squad lista só squads reais. Não há como
isolar os clientes **sem** squad, que é exatamente o que alguém conferindo o
mapeamento no dia do rollout ia querer fazer primeiro.

| Opção | O que acontece |
|---|---|
| **A (atual)** | `SEM SQUAD` neutro, sempre, nas duas fases. |
| **B** | `/me/context` passa a expor a fase (`enforcement: "off" \| "canario" \| "on"`) e a Carteira marca `SEM SQUAD` como pendência **só depois do apply** — mais uma opção "Sem squad" no filtro, para isolar o resíduo. |
| **C** | Marcar como anomalia desde já. |

**Recomendação: B — e é a única linha deste documento que pede algo da
Pessoa 2.** Um campo de fase no payload é barato e resolve de vez a
ambiguidade; sem ele, qualquer aviso que o frontend dê ou é prematuro (C) ou
nunca chega (A). A opção "Sem squad" no filtro é útil nas duas fases e pode
vir antes, se você quiser.

**Impacto.** Backend: um campo. Frontend: um rótulo condicional e uma opção
de filtro. Nada estrutural.

**Decisão do usuário:** vale pedir o campo de fase à Pessoa 2? E quer o
filtro "Sem squad" desde já?

---

## D5 — Admin sem membership deve ver a Carteira agrupada por Squad?

**Estado atual.** Sim — e essa é a mudança de comportamento mais visível
desta branch. O contrato real (`meService.js`) devolve **duas listas
diferentes**: `squads[]` são as *memberships do usuário*, e `clientes[].squad`
é o *squad real do cliente*. O admin tem bypass de carteira e pode ter zero
memberships enquanto enxerga clientes de todos os squads.

Antes, a tela agrupava e filtrava só pelas memberships: para o admin, a
dimensão Squad simplesmente **não existia**, e clientes com squad de verdade
apareciam sob o cabeçalho `SEM SQUAD`. Agora a lista de squads da tela é a
união das memberships com os squads que vêm nos próprios clientes.

**Por que ainda é decisão.** Corrigir o `SEM SQUAD` falso era bug óbvio. Mas
"o admin passa a ver a Carteira agrupada" é uma mudança de experiência que
vale confirmar — inclusive porque, com a carteira inteira da empresa, ele vai
ver todos os grupos de uma vez.

| Opção | O que acontece |
|---|---|
| **A (atual)** | Admin vê agrupado pelos squads reais dos clientes dele, com filtro. |
| **B** | Admin não agrupa (lista corrida), mas o filtro de Squad continua disponível. |
| **C** | Admin ganha uma visão administrativa própria de squads. |

**Recomendação: A.** É a que permite conferir o mapeamento no dia do rollout
sem ferramenta nova, e é a única em que a informação que o backend já manda
não é jogada fora. Se a lista ficar longa demais, D1/D2 são as alavancas.

**Impacto se mudar.** Baixo: uma condição em `squadsDaCarteira()`.

**Decisão do usuário:** confirma que o admin deve ver a carteira agrupada por
squad?

---

## D6 — Cargo no squad (Coordenador/Gestor/Auxiliar/Design) aparece na UI?

**Estado atual.** Não aparece em lugar nenhum. O backend já manda dois campos
próximos disso — `squads[].funcao` em `/me/context` e `papeisDiretos[]` por
cliente em `/me/portfolio` — e o frontend não renderiza nenhum dos dois.

**Por que isto é decisão.** As duas dimensões são diferentes e a UI não pode
confundi-las:

- **membership de squad** (`funcao`) é sobre a carteira que você enxerga;
- **responsabilidade sobre o cliente** (`papeisDiretos`, `responsavelDireto`)
  é sobre organização do trabalho.

Nenhuma das duas é autorização — isso é do backend. Enquanto não houver uma
semântica explícita de o que "Coordenador" muda **numa tela**, mostrar o cargo
seria decoração que os usuários vão interpretar como permissão.

| Opção | O que acontece |
|---|---|
| **A (atual)** | Nada de cargo na UI. `responsavelDireto` continua marcando a linha ("responsável: você") e alimentando a ordenação "Meus clientes primeiro" — isso já existe e está provado por teste. |
| **B** | Mostrar `papeisDiretos` como marca na linha do cliente (ex.: "gestor"), sem nenhum efeito de comportamento. |
| **C** | Cargo passa a mudar a tela (visão de coordenador com carteira do squad inteiro, etc.). |

**Recomendação: A até existir uma pergunta de tela que o cargo responda.** B é
barato e reversível se o time quiser só informação. C exige desenho de produto
próprio e provavelmente contrato novo.

**Impacto.** B é pequeno. C é uma frente de trabalho.

**Decisão do usuário:** cargo é informação, comportamento, ou nada por
enquanto?

---

## Resumo para decidir rápido

| # | Pergunta | Recomendação | Precisa de backend? |
|---|---|---|---|
| D1 | Principal filtra a Carteira? | Não (A) | Não |
| D2 | Onde fica o Squad 8, e recolhido? | Por id, aberto (A) — reavaliar com o volume real | Não |
| D3 | Seletor global de Squad no Shell? | Não (A) | Não |
| D4 | "Sem squad" vira anomalia após o apply? | Sim, mas só com campo de fase (B) | **Sim, 1 campo** |
| D5 | Admin vê agrupado por squad? | Sim (A, já implementado) | Não |
| D6 | Cargo aparece na UI? | Não por enquanto (A) | Não |

Só **D4** depende da Pessoa 2, e mesmo assim não bloqueia nada: o
comportamento atual (A) é correto na fase em que estamos.
