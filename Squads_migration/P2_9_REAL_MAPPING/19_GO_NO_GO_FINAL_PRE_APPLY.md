# 19 — GO / NO-GO final pré-APPLY

> Dois vereditos, deliberadamente separados. **Aplicar a migração** e **ligar o
> enforcement** são decisões diferentes, com bloqueadores diferentes.

| | |
|---|---|
| Branch | `backend/v3-p2-9-real-mapping` |
| `origin/main` | `bb33973` (avançou; **não** integrado ainda) |
| Banco | **NÃO ALTERADO** · `--apply` **NÃO EXECUTADO** |
| `SQUADS_ENFORCEMENT` | **OFF** |

---

# ⛔ APPLY: **NO-GO**

**Motivo único: 4 memberships sem identidade resolvida.**

| bloqueador | assentos | por quê |
|---|---|---|
| **Klayvert** — qual das duas contas? | `squad-2:coordenador`, `squad-3:coordenador`, `squad-6:coordenador` | duas contas ativas, mesmo nome: **#22** `…@vendexcompany.com` × **#35** `…@vendexcompany.com.br`. O documento aprovado define o Squad **principal** dele (Squad 2) mas não a **conta**. A planilha não tem coluna de email |
| **Vinícius** — qual das duas pessoas? | `squad-2:auxiliar2` | **#29** Vinicius Bergo (`admin`) × **#44** Vinicius Dias (`membro`). Duas pessoas distintas, ambas ativas e em uso. O documento não as menciona |

Aplicar assim deixaria **três dos seis Squads sem Coordenador** (2, 3 e 6) e o
Squad 2 com 2 de 5 assentos. A regra de identidade aprovada é explícita: *"se o
email confirmado não resolver exatamente um usuário, bloquear aquela
membership"* — e é isso que o tooling faz, fail-closed.

**Isto é o único NO-GO do APPLY.** Todo o resto está pronto:

| dimensão | estado |
|---|---|
| Mapa Cliente → Squad | ✅ **PRONTO** — 83/83 clientes, cada um em exatamente 1 Squad |
| Plano de consolidação | ✅ **PRONTO** — `PLAN_ONLY`, 11 clusters, 16 aliases, 0 execução |
| Plano de memberships | ⛔ **20 de 24** aplicáveis (4 bloqueadas) |
| Dry-run zero-write | ✅ **APROVADO** — exit 0, 0 erro, **0 aviso**, hash do banco idêntico |
| Invariantes | ✅ **13/13** verdes |
| Testes | ✅ 180/184 (4 vermelhos pré-existentes, sem relação) |
| Grant cruzado | ✅ **não bloqueia APPLY** — o plano não toca em Grant nenhum |

### O que destrava o APPLY

Duas respostas objetivas:

1. **Klayvert é a conta #22 (`…@vendexcompany.com`) ou #35
   (`…@vendexcompany.com.br`)?**
   Evidência disponível, sem decidir por você: **#35 é a única com atividade
   registrada** (8 `activity_logs` entre 05/05 e 06/07, 1 relatório); **#22 tem
   zero atividade** desde a criação em 08/04, mas tem mais vínculos de Base (55
   × 41). Escolher a errada entrega três carteiras de Coordenador a um login
   que a pessoa não usa. *(Se as duas contas forem mesmo da mesma pessoa, vale
   decidir também se a outra deve ser desativada — mas isso é operação
   separada, não faz parte deste APPLY.)*

2. **O "Vinícius" do `squad-2:auxiliar2` é o #29 Vinicius Bergo ou o #44
   Vinicius Dias?**

Respondidas as duas, basta acrescentá-las a
`entrada/decisoes-humanas-aprovadas.json`, regerar o plano com `--decisoes` e
o `_emitivel` vira `true` — sem tocar em código.

### Não bloqueiam o APPLY, mas ficam registrados

- **4 pessoas sem conta** (Caique, Yuri, Carol, Victor): comportamento
  esperado e aprovado. Saem por exclusão explícita, fail-closed, sem bloquear
  as demais. Suas memberships entram numa etapa posterior, depois que as contas
  existirem.
- **MM ambíguo**: `MM Importes` (#54) e `MM Comercio` (#107) ficam no Squad 8.
  O Squad 3 não recebe o "MM" da carteira aprovada. É perda de **fidelidade de
  carteira**, reversível movendo o cliente depois — não é risco de dado.
- **JFX (#75)** e o **canônico do cluster `wm`**: sem efeito no APPLY.

---

# ⛔ ENFORCEMENT: **NO-GO**

Dois motivos, independentes entre si.

### 1. O APPLY não aconteceu

`squads` = 0, `squad_members` = 0, `clientes com squad ativo` = 0,
`auditoria.pronto: false`. Ligar o enforcement agora deixaria **todo usuário
interno com carteira vazia (403 em cascata)**. O rollout gate (P2.2) já
bloquearia sozinho: a flag só governa depois que a auditoria de migração
aprova, e o fail-safe é OFF em toda direção de dúvida.

### 2. ⛔ O grant cruzado **Fênix (#102) × Eliza.Market (#105)**

O documento aprovado (§9) declara que não recebeu caso concreto de Grant e
portanto **não decidiu este**. Ele foi reauditado do zero (detalhe completo em
`17`, seção 5):

```
ml_tokens #69   cliente_id=102 (Fenix)         ml_user_id=2661771367  is_primary=false  cliente_conta_id=NULL  valid
ml_tokens #70   cliente_id=105 (Eliza.Market)  ml_user_id=2661771367  is_primary=true   cliente_conta_id=NULL  valid
```

Nenhum dos dois tem `ClienteConta`. O sistema já registrou a pendência sozinho
(`cliente_contas_pendencias`, tipo `ml_user_id_duplicado_entre_clientes`, 4
abertas — este é uma delas, e a única entre clientes sem parentesco).

Grants são resolvidos por `cliente_id`
(`listGrantsByCliente` / `resolveMlGrant` em `server/services/mlTokenService.js`).
No mapa aprovado, **#102 → Squad 6** e **#105 → Squad 8 · Legado**. Com
enforcement ON, o Squad 6 alcança, por um token vivo, a conta ML de um cliente
do Squad 8.

A exposição *absoluta* diminui com o enforcement (hoje, OFF, todo interno
alcança #102). O problema não é o volume: é que a **promessa** do enforcement —
"um Squad só alcança as contas dos seus Clientes" — passaria a ser falsa no
exato momento em que passa a valer. Não se liga um mecanismo de autorização
com uma exceção silenciosa dentro.

**Nada foi movido, removido ou reapontado.** O grant #69 continua onde estava.

### O que destrava o ENFORCEMENT

1. APPLY concluído e auditoria de migração aprovada (fecha o motivo 1).
2. **Uma pergunta objetiva:**

   > **O grant secundário #69 (`ml_user_id` 2661771367) em Fenix
   > Equipamentos1 (#102) deve ser desconectado, ou é intencional?**
   >
   > Ele não tem `ClienteConta`; o mesmo seller já é o grant **primário** de
   > Eliza.Market (#105); os dois clientes vão para Squads diferentes. Se a
   > resposta for "desconectar", é uma correção de dado **separada** deste
   > APPLY, e depois dela o enforcement fica liberado por este item.

3. Preservar a regra de produto aprovada: **Squad principal e Squad ativo não
   são autorização.** A autorização continua sendo determinada pelo backend a
   partir da role e das memberships reais; o Squad ativo é só o recorte de
   carteira da sessão, descartado no próximo login.

---

## Resumo dos dois vereditos

| | APPLY | ENFORCEMENT |
|---|---|---|
| **veredito** | ⛔ **NO-GO** | ⛔ **NO-GO** |
| bloqueador 1 | identidade de **Klayvert** (3 memberships) | APPLY não executado (rollout gate fechado) |
| bloqueador 2 | identidade de **Vinícius** (1 membership) | **grant cruzado #69** Fenix × Eliza |
| o grant cruzado bloqueia? | **NÃO** | **SIM** |
| decisões humanas necessárias | **2** | **1** (+ o APPLY) |
| natureza | conhecimento de negócio | conhecimento de negócio + sequência |

É perfeitamente possível que o APPLY vire GO antes do ENFORCEMENT: as duas
perguntas de identidade são independentes da pergunta do grant.

---

## Estado final, item a item

| item | valor |
|---|---|
| Banco alterado | **NÃO** — hash das 9 tabelas idêntico antes e depois |
| Clientes criados | **0** |
| Clientes deletados | **0** |
| Usuários criados | **0** |
| Identidades inventadas | **0** |
| Grants alterados | **0** |
| Grants perdidos | **0** |
| Bases alteradas | **0** |
| `ClienteConta` movida | **0** |
| Consolidação executada | **0** — tudo `PLAN_ONLY` |
| `--apply` | **NÃO EXECUTADO** |
| `SQUADS_ENFORCEMENT` | **OFF** |
| Frontend | **não tocado** |
| Deploy | **não feito** |
