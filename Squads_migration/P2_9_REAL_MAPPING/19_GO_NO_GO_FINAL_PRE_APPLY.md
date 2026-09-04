# 19 — GO / NO-GO final pré-APPLY

> Dois vereditos, deliberadamente separados. **Aplicar a migração** e **ligar o
> enforcement** são decisões diferentes, com bloqueadores diferentes. Elas se
> separaram de verdade nesta rodada.

| | |
|---|---|
| Branch | `backend/v3-p2-9-real-mapping` |
| `origin/main` | `bb33973` — **integrada por merge normal**, 0 conflito |
| Banco | **NÃO ALTERADO** · `--apply` **NÃO EXECUTADO** |
| `SQUADS_ENFORCEMENT` | **OFF** |

---

# ✅ APPLY: **GO**

**Nenhum bloqueador restante.**

| dimensão | estado |
|---|---|
| Mapa Cliente → Squad | ✅ **PRONTO** — 83/83 clientes, cada um em exatamente 1 Squad |
| Plano de memberships | ✅ **PRONTO** — 24 de 24 aplicáveis, `_emitivel: true`, `_bloqueios: []` |
| Plano de consolidação | ✅ **PRONTO** — `PLAN_ONLY`, 11 clusters, 16 aliases, 0 execução |
| Dry-run zero-write | ✅ **APROVADO** — exit 0, **0 erro, 0 aviso**, hash do banco idêntico |
| Invariantes | ✅ **13/13** verdes |
| Identidades ambíguas | ✅ **0** |
| Testes | ✅ 181/185 (4 vermelhos pré-existentes, sem relação) |
| Merge da `origin/main` | ✅ hotfix do Fechamento V3 presente e verde |

### O que fechou o APPLY

As três decisões da rodada 2 eliminaram os últimos 4 bloqueios:

| decisão | efeito |
|---|---|
| **Klayvert = #35** (`…@vendexcompany.com.br`) | +3 memberships de Coordenador — squads **2**, **3** e **6**. Principal **squad-2**. A conta **#22 não foi tocada** |
| **Vinícius = #44 Vinicius Dias** | +1 membership — `squad-2:auxiliar2`. A conta admin **#29 não foi usada nem alterada** |
| **Grant Fênix × Eliza: não mexer** | nenhum efeito no APPLY — o plano nunca tocou em Grant. Segue como bloqueador **só de enforcement** |

Os seis Squads têm Coordenador. Nenhum assento ficou vago por ambiguidade.

### O que fica de fora do APPLY, por decisão e sem bloquear

- **4 pessoas sem conta** — Caique (sq2·design), Yuri (sq4·aux2), Carol
  (sq4·design), Victor (sq6·auxiliar). Saem por exclusão explícita e
  fail-closed. Suas memberships entram numa etapa posterior, depois que as
  contas existirem. **0 usuário criado, 0 identidade inventada.**
- **MM ambíguo** — `MM Importes` (#54) e `MM Comercio` (#107) ficam no Squad 8.
  O Squad 3 não recebe o "MM" da carteira aprovada: perda de **fidelidade de
  carteira**, reversível movendo o cliente depois, não risco de dado.
- **JFX (#75)** e o **canônico do cluster `wm`** — sem efeito no APPLY.

### Condições de execução (não são bloqueadores; são o procedimento)

1. **Regerar o plano com inventário fresco imediatamente antes do apply** e
   conferir que a contagem de clientes bate com a do banco no instante da
   execução. Um cliente criado no intervalo ficaria sem Squad.
2. O apply é transacional e idempotente; qualquer falha faz ROLLBACK total.
3. Revisão humana final do plano antes de rodar com `--apply`.

---

# ⛔ ENFORCEMENT: **NO-GO**

Dois motivos, independentes entre si.

### 1. O APPLY ainda não aconteceu

`squads` = 0, `squad_members` = 0, `clientes com squad ativo` = 0,
`auditoria.pronto: false`. Ligar o enforcement agora deixaria **todo usuário
interno com carteira vazia (403 em cascata)**. O rollout gate (P2.2) já
bloquearia sozinho: a flag só governa depois que a auditoria de migração
aprova, e o fail-safe é OFF em toda direção de dúvida.

**Este motivo cai sozinho quando o APPLY rodar.**

### 2. ⛔ O grant cruzado **Fênix (#102) × Eliza.Market (#105)** — mantido por decisão

```
ml_tokens #69   cliente_id=102 (Fenix)         ml_user_id=2661771367  is_primary=false  cliente_conta_id=NULL  valid
ml_tokens #70   cliente_id=105 (Eliza.Market)  ml_user_id=2661771367  is_primary=true   cliente_conta_id=NULL  valid
```

Perguntado se o #69 deveria ser desconectado, o humano respondeu: **na dúvida
operacional, não mexer.** Os dois grants ficam exatamente como estão — não
desconectar, não mover, não alterar. Verificado antes e depois do dry-run.

A classificação da auditoria anterior é **preservada integralmente**:

| | |
|---|---|
| **BLOQUEIA APPLY?** | **NÃO** |
| **BLOQUEIA ENFORCEMENT?** | **SIM** |

Por quê: grants são resolvidos por `cliente_id`
(`listGrantsByCliente` / `resolveMlGrant`, em `server/services/mlTokenService.js`).
No mapa aprovado, **#102 → Squad 6** e **#105 → Squad 8 · Legado**. Com
enforcement ON, o Squad 6 alcança, por um token vivo, a conta ML de um cliente
do Squad 8.

A exposição *absoluta* até diminui com o enforcement (hoje, OFF, todo interno
alcança #102). O problema não é volume: é que a **promessa** do enforcement —
"um Squad só alcança as contas dos seus Clientes" — passaria a ser falsa no
exato momento em que passa a valer.

**Manter o grant é uma decisão consciente de aceitar este bloqueador**, não de
descartá-lo. Enquanto o cruzamento existir, o enforcement fica NO-GO.

### 3. Regra de produto a preservar quando o enforcement for ligado

**Squad principal e Squad ativo não são autorização.** A autorização continua
determinada pelo backend a partir da role e das memberships reais; o Squad
ativo é só o recorte de carteira da sessão, descartado no próximo login.

Uma dívida a acompanhar: **a conta #22 do Klayvert ficará sem Squad**. Com
enforcement OFF é inócuo; quando ligar, quem logar por ela vê carteira vazia.
Por isso o saneamento de #22 é dívida real, não cosmética.

---

## Resumo dos dois vereditos

| | APPLY | ENFORCEMENT |
|---|---|---|
| **veredito** | ✅ **GO** | ⛔ **NO-GO** |
| bloqueadores | **nenhum** | APPLY não executado · **grant cruzado #69** |
| o grant cruzado bloqueia? | **NÃO** | **SIM** |
| decisões humanas pendentes | **0** | **1** — o que fazer com o grant #69 |
| natureza do que falta | procedimento de execução | correção de dado + sequência |

Era exatamente o desfecho previsto como aceitável: **APPLY = GO com
ENFORCEMENT = NO-GO**, separados pelo grant cruzado. Não foi forçado — o
`_emitivel: true` sai do tooling, e os 0 avisos saem do dry-run.

---

## Estado final, item a item

| item | valor |
|---|---|
| Banco alterado | **NÃO** — hash das 9 tabelas idêntico antes e depois |
| Clientes criados | **0** |
| Clientes deletados | **0** |
| Usuários criados | **0** |
| Identidades inventadas | **0** |
| Grants alterados | **0** — #69 e #70 conferidos um a um |
| Grants perdidos | **0** |
| Bases alteradas | **0** |
| `ClienteConta` movida | **0** |
| Consolidação executada | **0** — tudo `PLAN_ONLY` |
| Conta #22 (Klayvert `.com`) | **intacta** — não desativada, não deletada, sem migração |
| Conta #29 (Vinicius Bergo, admin) | **intacta** — não usada, não alterada |
| `role` do Fernando Salgado (#5) | **admin preservado** — o plano não toca `users` |
| `--apply` | **NÃO EXECUTADO** |
| `SQUADS_ENFORCEMENT` | **OFF** |
| Frontend | **não tocado** |
| Deploy | **não feito** |
