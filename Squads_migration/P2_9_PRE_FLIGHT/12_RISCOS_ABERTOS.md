# 12 — Riscos abertos deixados pelo Release Candidate

> Classificação dos itens registrados em
> `VENFORCE_V3_BACKEND_RELEASE_CANDIDATE.md` §10 e §11.
>
> **Não corrigir nada disto agora.** O objetivo é saber, para cada um:
> bloqueia P2.9? severidade? é decisão humana? precisa ser corrigido antes do
> canário?
>
> **Conclusão geral: nenhum destes bloqueia o rollout de Squads.** Todos são
> ortogonais ao enforcement de carteira (que é sobre *quais clientes um interno
> vê*, não sobre cálculo financeiro / entregas / sync). O único que é
> pré-requisito **do deploy** (não do enforcement) é o `JWT_SECRET`.

---

## Matriz

| # | Risco | Camada | Bloqueia P2.9? | Severidade | Decisão humana? | Corrigir antes do canário? | Nota |
|---|---|---|---|---|---|---|---|
| R1 | **Vazamento cruzado MP com 0 contas ativas** — `resolveMarketplaceAccountContext` não lança com 0 contas; `condicaoContaSql` devolve `null` e nenhuma condição de conta entra na query → imports/runs/payments de todas as contas voltam juntos. Alcançável quando as contas foram desativadas mas os imports persistem. | leitura (Central de Vendas / conciliação MP) | **NÃO** | MÉDIA | **SIM** — o que um cliente sem conta ativa deve ver; fail-closed pode esconder dado legítimo de clientes legados | **NÃO** (não é agravado pelo enforcement; território compartilhado com a Pessoa 1) | mitigação parcial já entregue: o cinto de conta na camada MP (S6/P2.6) impede a mistura sempre que a conta **É** conhecida |
| R2 | **Timezone no sync da Central de Vendas** — `dataPedido = String(order.date_created).slice(0,10)`; janela ao ML com `-03:00` fixo; `.toISOString()` sobre coluna `DATE` pode deslocar 1 dia. Pedido de 01/08 00:30 −03:00 pode virar 31/07. | escrita (sync) | **NÃO** | MÉDIA | **SIM** — precisa janela de validação própria com dado real; mexer às cegas reclassifica competência de pedidos já importados | **NÃO** | não toca carteira nem enforcement |
| R3 | **`summary` da conciliação MP ignora o range** — `paymentsUnique`, `totalPaymentGross/Net`, `postMovementsCount` contam o sync run inteiro, não o intervalo pedido. As linhas respeitam o range; os totais não. | leitura (conciliação MP) | **NÃO** | BAIXA–MÉDIA | **SIM** — mudar números de resumo financeiro sem dado de validação é o tipo de mudança que a missão manda não fazer às cegas | **NÃO** | — |
| R4 | **`resolverBaseTikTokPorId` sem checagem de posse** — base TikTok resolvida por id sem cliente/vínculo. **Diferente de S1**: aqui a ausência é **deliberada e declarada** no próprio código ("seleção manual, sem cliente/vínculo"). | leitura (base TikTok) | **NÃO** | BAIXA | **SIM** — é decisão de produto; mudar quebraria o fluxo TikTok e seus testes | **NÃO** | não há cliente no fluxo → o enforcement de carteira não se aplica |
| R5 | **`despublicarEntrega` não rotaciona `token_publico`** — republicar reativa o **mesmo link antigo**: quem tinha a URL recupera acesso. | leitura pública (Relatório Público) | **NÃO** | MÉDIA | **SIM** — link estável × revogação real | **NÃO** para o enforcement; **SIM** para o time de fechamento saber (não é bug óbvio, é comportamento) | relevante ao rollout só porque o canário observa entregas; registrar na comunicação com o time |
| R6 | **D5 — expor exclusão de entrega** — não feito, corretamente (decisão de produto, como a Pessoa 1 registrou). | frontend | **NÃO** | BAIXA | **SIM** | **NÃO** | — |
| R7 | **`GET /financeiro` lê só as ~24 entregas mais recentes** — competência antiga além da janela fica invisível. `entregas_cliente.periodo` é texto livre → filtro SQL não confiável hoje. | leitura (Financeiro V3) | **NÃO** | BAIXA | **NÃO** — "some sozinho conforme as escritas passam a gravar `YYYY-MM`" | **NÃO** | acelera se o frontend passar a gravar `YYYY-MM` (D1/D2 consumidos) |
| R8 | **`resultado.escopoConta` só vira `true` para entregas novas** | leitura (Financeiro V3) | **NÃO** | BAIXA | **NÃO** | **NÃO** | correto por construção; declarado em `origemClientLevel` |
| R9 | **`JWT_SECRET` — definir derruba todas as sessões** | deploy | **NÃO** ao enforcement; **SIM ao DEPLOY** (item 2 de `08`) | MÉDIA | **SIM** — janela + comunicação com o time | **SIM** — é passo obrigatório do deploy, **antes** de qualquer coisa de Squad (ver `06`) | não voltar ao segredo antigo depois |
| R10 | **Índice único D4 falha se houver duplicatas** | migration opcional | **NÃO** ao enforcement | MÉDIA | **SIM** — classe D (2+ publicadas) exige decisão do dono do dado | **RECOMENDADO** tratar classes A/B/C; **D pode ser adiado** sem travar Squads (ver `05`) | a guarda `409 ENTREGA_JA_EXISTE` funciona sem o índice |

---

## Leitura executiva

- **Bloqueiam o deploy (não o enforcement):** apenas **R9** (`JWT_SECRET`) —
  já é o item 2 de `08` e tem checklist em `06`.
- **Bloqueiam um passo opcional (índice D4):** **R10**, e só a classe D — que
  pode ser adiada. Ver `05`.
- **Todos os demais (R1–R8):** dívidas conhecidas de domínio financeiro / sync
  / entregas. **Nenhuma** é agravada por `SQUADS_ENFORCEMENT=on`. Devem ser
  levadas à gestão como backlog pós-rollout, **não** como pré-condição.
- **Comunicar ao time de fechamento antes do canário:** R5 (link público não
  revoga) e R2 (viés de timezone) — não porque bloqueiam, mas porque o canário
  vai observar as telas financeiras e alguém pode confundir esses
  comportamentos conhecidos com "regressão do Squads".
