# 13 — Simulação: e se ligássemos o enforcement HOJE?

> **BLOCO M.** Resposta provada por leitura de código, sem ligar flag nenhuma,
> sem tocar banco. `SQUADS_ENFORCEMENT` permanece **OFF**.

---

## 1. Resposta curta

**Nada aconteceria.** O enforcement **não subiria**, e ninguém perderia acesso.

Não porque a flag seria ignorada, mas porque o **rollout gate** (P2.2 §9)
cruza a intenção do operador com o estado real dos dados e, com a migração não
executada, veta a ativação.

```
SQUADS_ENFORCEMENT=on          auditoria().pronto = false
   (intenção)                     (estado dos dados)
        └─────────► GATE = "bloqueado" ◄─────────┘
                          │
                 enforcement efetivo = OFF
```

---

## 2. A cadeia, passo a passo (com código)

**Passo 1 — a flag seria lida como ON.**
`server/config/squadsEnforcement.js:87` — `flagLigada()` aceita
`on|true|1|yes|enabled|enforce`. `"on"` → `true`.

**Passo 2 — a auditoria reprovaria.**
`server/services/squads/squadsMigracaoService.js:149-156`:

```js
const pronto =
  c.sem_squad === 0 && c.em_squad_inativo === 0 &&
  u.sem_membership === 0 && u.apenas_squad_inativo === 0 &&
  u.sem_principal === 0 && principalDuplicado === 0 && vinculoDuplicado === 0;
```

Com `cliente_squad_history` vazio, o `LEFT JOIN` da query de clientes deixa
`csh.cliente_id IS NULL` para **todos** → `sem_squad` = total de clientes
ativos. Com `squad_members` vazio, `sem_membership` = total de internos ativos.
Ambos `> 0` ⇒ **`pronto = false`**.

**Passo 3 — o gate bloquearia.**
`server/services/squads/rolloutGateBoot.js:55-58` chama
`armarGate({ pronto: false, motivo: motivoDaAuditoria(a) })` →
`server/config/squadsEnforcement.js:121-126` define `_gate = "bloqueado"`.

**Passo 4 — o enforcement efetivo continuaria OFF.**
`server/config/squadsEnforcement.js:139-171`:

```js
function isEnforcementEnabled() {
  if (!flagLigada()) return false;
  if (_gate === GATE_NAO_ARMADO || _gate === GATE_LIBERADO) return true;
  if (_gate === GATE_BLOQUEADO && overrideAtivo()) { ...; return true; }
  console.warn(`[squads] SQUADS_ENFORCEMENT pede ON, mas o rollout gate está "${_gate}" — enforcement mantido OFF (fail-safe). ...`);
  return false;
}
```

Sem `SQUADS_ENFORCEMENT_ALLOW_INCOMPLETE=on` (que ninguém setou), cai no último
ramo → **`false`**.

---

## 3. Efeito por papel

| Papel | O que aconteceria | Por quê |
|---|---|---|
| **admin** | **Nada muda.** Vê todos os clientes ativos. | `ehAdmin(user)` faz curto-circuito **antes** de `isEnforcementEnabled()` ser consultado — `authorizationService.js:67-74` e `:127-135`. |
| **interno** (`user`/`membro`/`interno`) | **Nada muda.** Carteira legada completa. | Gate bloqueado ⇒ `isEnforcementEnabled()` = `false` ⇒ o ramo `!isEnforcementEnabled()` devolve todos os clientes ativos — `authorizationService.js:92-99`. **Sem 403 em cascata.** |
| **seller** | **Nada muda.** `seller_clientes`, como sempre. | O caminho seller **nunca chama** `isEnforcementEnabled()` — `authorizationService.js:76-87` e `:137-146`. |
| `shopee_reviewer` / role desconhecida | **Nada muda.** Continua sem carteira operacional (`[]`). | Fallthrough em `authorizationService.js:117-119`. OFF não reabre acesso que nunca existiu. |

**Log que apareceria no boot** (formato de `VENFORCE_V3_SQUADS_ROLLOUT_SAFETY.md` §9.5):

```
[squads] enforcement=OFF (SQUADS_ENFORCEMENT=on, gate=bloqueado) | clientes sem squad=N/N | ...
[squads] ⚠ SQUADS_ENFORCEMENT pede ON, mas o rollout gate está "bloqueado" —
         enforcement permanece OFF. Motivo: N cliente(s) ativo(s) sem Squad;
         M interno(s) sem membership.
```

---

## 4. Veredito

```
SE ENFORCEMENT FOSSE LIGADO HOJE:  NADA MUDA — o gate segura, enforcement fica OFF.
NINGUÉM PERDE ACESSO:              correto, provado por código e por teste.
VEREDITO P2.9:                     NO-GO (por falta do mapeamento humano, não por defeito).
```

Coberto por teste existente: `server/tests/squadsRolloutGate.test.js` §3
("ON + tabelas de Squad vazias → OFF, sem 403 cascata") e §4 ("ON + banco sem
as tabelas → OFF").

---

## 5. ⚠️ Achado não óbvio: o `pronto` pode ser verdadeiro por vacuidade

Vale registrar porque contraria a intuição e **não está documentado em
nenhum artefato anterior**.

A fórmula do `pronto` é composta só de comparações a zero. Se `clientes`
**e** os usuários internos estiverem **ambos vazios**, todos os contadores são
`0` e:

```
pronto = true    ← sem nenhum Squad existir, sem nenhuma migração ter rodado
```

O gate liberaria, e aí sim o enforcement subiria de verdade — com
`squad_members` vazio, todo interno cairia em carteira vazia / 403.

**Isso não é risco em produção** (a base tem clientes e equipe reais), mas **é
risco em qualquer ambiente recém-criado**: staging zerado, base de teste,
primeiro deploy de um ambiente novo. Nesses lugares, `SQUADS_ENFORCEMENT=on`
liga o enforcement de fato.

| | |
|---|---|
| **Severidade** | Baixa em produção · **Média em staging/ambiente novo** |
| **Bloqueia P2.9?** | **Não** |
| **Ação recomendada** | Não ligar a flag em ambiente zerado. Se um dia o gate ganhar endurecimento, exigir `clientesAtivos.total > 0` antes de considerar `pronto`. |
| **Registrado como** | risco **T-4** em `12_ROLLOUT_GATE_ATUAL.md` |

---

## 6. O que NÃO foi feito

- ❌ `SQUADS_ENFORCEMENT` **não** foi setada, exportada ou alterada em lugar nenhum.
- ❌ Nenhum servidor foi iniciado.
- ❌ Nenhuma conexão de banco foi aberta.
- ❌ `SQUADS_ENFORCEMENT_ALLOW_INCOMPLETE` **não** foi tocada.
