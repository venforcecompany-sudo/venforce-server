# 11 — O que a Convergência #2 precisa entregar para P2.9

> P2.9 está em **NO-GO** enquanto a Convergência #2 não fecha. Esta lista é o
> gate: quando cada linha estiver ✅, o item 1 e o item 3 de `08_GO_NO_GO.md`
> viram `GO`.
>
> Fontes: `VENFORCE_V3_BACKEND_RELEASE_CANDIDATE.md` §3/§12/§13,
> `VENFORCE_V3_CONVERGENCE_1_READINESS.md`, e os commits de
> `origin/frontend/v3-marathon-pessoa1` (`da44ac7`, não mergeada).

---

## 1. O que a Convergência #2 está integrando

| Origem | Conteúdo | Estado |
|---|---|---|
| `backend/v3-squads-auth` @ `6126ee1` | P2.4 (responsáveis) + P2.5 (Visão período) + P2.6 (Financeiro account/period-aware, D1–D4) + P2.7 (hardening: JWT_SECRET, IDOR base de custos, lista de clientes por carteira, entrega órfã, isolamento MP) + P2.8 (release candidate) | **congelada, em integração** |
| `frontend/v3-marathon-pessoa1` @ `da44ac7` | Bloco C (Carteira/Shell lendo `/me/context` + `/me/portfolio`), F4.2 (publicar/despublicar entrega do V3), F5 (9 telas saem do `layout.js` para o Shell; Ads/Anúncios ML/Automações deixam de escolher Cliente/Conta), fix (período sobrevive à troca de módulo; 403 volta para a Carteira) | **não mergeada** |

Todas as mudanças de contrato do backend são **aditivas** (nenhum campo
removido/renomeado) — RELEASE CANDIDATE §3/§14.

---

## 2. Checklist de entrega da Convergência #2 (para P2.9 sair de NO-GO)

| # | Item | Por que P2.9 precisa | ✅ quando |
|---|---|---|---|
| 1 | **`backend/v3-squads-auth` + `frontend/v3-marathon-pessoa1` mergeados na `main`, sem conflito** | P2.9 opera sobre a `main` deployada; o tooling e o seam de carteira precisam estar lá | PR de Convergência #2 mergeado |
| 2 | **Regressão de backend: 0 novas falhas** (baseline = 4 preexistentes: `basesTiktok`, `designStudioWorkspace`, `designTemplateEngine`, `mlTokenService`) | um seam de carteira com regressão em produção = 403 ou 500 indevidos ao ligar o flag | `TEST_SKIP=<as 4>` → verde |
| 3 | **`/me/context` aprovado** — shell V3 consome de verdade (Bloco C), não o fallback `/operacao/cliente-360/clientes` | com enforcement ON, `/me/context` é a fonte autoritativa da carteira por Squad; o fallback F1 não aplica o mesmo filtro da mesma forma | Bloco C mergeado + smoke: `/me/context` 200 para interno, payload com `clientes` filtrado |
| 4 | **`/me/portfolio` aprovado** — Carteira consome; `pendencias[]` com `{tipo, rotulo, destino}`, `ultimaSincronizacao`, `contas[].ultimaSync` | é a tela que o interno usa para "para quem trabalho"; com enforcement ON ela **tem** que refletir só o Squad | Carteira renderiza `/me/portfolio` real; sem token vazando (há teste) |
| 5 | **Visão aprovada** — ilha React consome `GET /operacao/visao/:cliente?conta=&periodo=`; `400 PERIODO_INVALIDO` tratado; `escopoConta` exibido | Visão é `data-vf-scope="account"` — com enforcement ON, `403 CLIENTE_FORA_DA_CARTEIRA` precisa levar ao estado `FORBIDDEN` do `vf-context` (volta para a Carteira) | smoke: Visão de cliente do Squad = 200; de fora = 403 → Carteira |
| 6 | **Financeiro V3 aprovado** — `GET /financeiro/:cliente?conta=&periodo=YYYY-MM`; `400 PERIODO_OBRIGATORIO`/`PERIODO_INVALIDO`; F4.2 (publicar/despublicar) consumindo os campos novos | idem §5 + o ciclo de entrega precisa registrar `cliente_conta_id` (D1) para o modelo de operação valer | smoke: Financeiro V3 de cliente do Squad = 200; publicar/despublicar OK |
| 7 | **D1 consumido** — o frontend **envia `cliente_conta_id`** ao salvar fechamento/entrega | D1 só tem valor quando o frontend manda a operação; sem isso as entregas novas continuam `cliente_conta_id = NULL` | `POST /entregas-cliente` do V3 inclui `cliente_conta_id` |
| 8 | **D4 consumido** — `409 ENTREGA_JA_EXISTE` tratado no frontend (oferece "substituir") | evita que o operador crie a duplicata que `05` está auditando | fluxo de fechamento do V3 mostra a opção "substituir" no 409 |
| 9 | **D2 consumido** — `POST /fechamentos/financeiro` → resposta traz `competencia { periodoDetectado, divergente, … }`; o frontend **exibe** a competência detectada | não é bloqueante do enforcement, mas é o que impede "Julho lido como Agosto" chegar ao cliente | frontend mostra `competencia.periodoDetectado` / alerta em `divergente` |
| 10 | **D3 consumido** — `ultimaSincronizacao` / `contas[].ultimaSync` usados na Carteira | melhora o sinal de "operação parada" na tela que o canário vai observar | Carteira mostra última sync por conta |
| 11 | **`main` pronta para deploy** — smoke §7.5 do RELEASE CANDIDATE verde com `SQUADS_ENFORCEMENT=OFF` | é o item 3 de `08` | smoke pós-deploy verde |

---

## 3. O que **NÃO** bloqueia P2.9 (aberto, mas fora do caminho crítico)

- **D5** (expor exclusão de entrega) — decisão de produto, sem backend
  pendente. Não afeta carteira.
- **Consumir todos os campos novos de contrato** além dos essenciais
  (`origemClientLevel`, `ambiguidade`, `resultado.escopoConta` na UI) — melhora
  a honestidade da tela, não a segurança.
- **Reconciliação formal do contrato de Visão (RP3) / Financeiro (RP4)** — o
  shape "envelope por bloco" / `composicao[]` sem `sinal`. É dívida de produto;
  o enforcement não depende disso.
- **F5 completo** (todas as telas legadas no Shell) — as telas que ficaram no
  `layout.js` continuam funcionando com o seam de carteira server-side; migrar a
  UI é qualidade, não pré-requisito do enforcement.

---

## 4. Sinal de "pode começar P2.9"

```
[ ] itens 1, 2, 3, 4, 5, 6, 7, 8, 11 da tabela §2 = ✅
[ ] (desejável) itens 9, 10 = ✅
    → itens 1 e 3 de 08_GO_NO_GO.md viram GO
    → o caminho fica: JWT_SECRET (06) + reunião de gestão (03) + runbook (09) + canário (07)
```
