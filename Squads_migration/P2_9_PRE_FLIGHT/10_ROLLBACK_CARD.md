# 10 — ROLLBACK CARD (deixar aberto durante o rollout)

> Cartão operacional. Uma página. Base: `VENFORCE_V3_SQUADS_ROLLOUT_SAFETY.md` §4
> e `VENFORCE_V3_BACKEND_RELEASE_CANDIDATE.md` §8.

---

## REGRA DE OURO

> **Na dúvida: `SQUADS_ENFORCEMENT=off` + restart.**
> É reversível em segundos. **NÃO apaga nenhum dado.** Religar depois = `on` de novo (idempotente).

O rollback do enforcement **nunca**: apaga `squads` / `squad_members` /
`cliente_squad_history` / `cliente_responsaveis` · remove histórico de
transferência · reverte schema · toca `seller_clientes`.

---

## AÇÃO PADRÃO (qualquer problema de carteira)

```
1.  Render → serviço de produção → Environment → SQUADS_ENFORCEMENT = off   (ou remover a var)
2.  Restart do serviço
3.  Confirmar no log de boot:  [squads] enforcement=OFF (SQUADS_ENFORCEMENT=off) | ...
4.  Confirmar: um interno qualquer volta a ver todos os clientes (/me/portfolio)
5.  Só então: auditar a causa. NÃO religar sem auditoria.pronto=true + causa entendida.
```

Tempo alvo: < 2 min do sinal ao `off` aplicado.

---

## POR SINTOMA

| PROBLEMA | AÇÃO |
|---|---|
| **Carteira vazia** — interno que deveria ter clientes vê `NO_PORTFOLIO` / `/me/portfolio` vazio | `SQUADS_ENFORCEMENT=off` + restart. Auditar (`--audit`): o cliente/usuário está no mapa aprovado? Só religar com `pronto:true`. **Critério obrigatório de aborto** (RELEASE CANDIDATE §13). |
| **Cliente no Squad errado** | `off`. Corrigir o vínculo: `POST /squads/:id/clientes` (atribuir/transferir) **ou** re-rodar `squads-migrate.js --plan` com o plano corrigido (idempotente). `--audit` → `pronto:true`. Só então religar. |
| **Usuário sem membership** (interno legítimo ficou de fora) | `off`. **NÃO criar membership "de emergência" sem confirmação humana** de qual Squad é o dele. Corrigir o plano, re-aplicar, auditar, religar. |
| **Squad inativo por engano** | Reativar o Squad (`PATCH /squads/:id/ativo`). A carteira dos membros volta sozinha. Pode nem precisar de `off` se for rápido. |
| **Pico de 403 `CLIENTE_FORA_DA_CARTEIRA`** acima do esperado | `off`. Comparar o log (`[carteira] acesso negado … user=… role=…`) com o mapa Cliente→Squad aprovado. Provável mapeamento incompleto. |
| **5xx nas rotas de carteira** (`/me/*`, `/operacao/*`, `/financeiro`) logo após ligar | `off`. Pode ser tabela de Squad ausente com flag ON (não deveria pós-migração) — checar `ensureSquadsTables` / migration aplicada. |
| **admin ou seller com comportamento diferente de antes** | `off`. O flag **não** deveria tocar admin (bypass) nem seller (`seller_clientes`). Se mudou, é bug — abrir para a Pessoa 2. |
| **Responsável não abre o cliente pelo qual responde** (previsto em `atencao.responsaveisForaDoSquad`) | Se forem poucos: mover o cliente de Squad **ou** a pessoa para o Squad (`POST /squads/:id/membros`), sem `off`. Se forem muitos: `off` e revisar o mapeamento. |
| **`JWT_SECRET` novo derrubou as sessões** | **Comportamento esperado.** Todo mundo refaz login. **NÃO** voltar para o segredo antigo — ele é público. Comunicar, não reverter. |
| **Migração de Squad ficou pela metade** (não deveria — o `--apply` é transacional) | O `--apply` faz `ROLLBACK` total em qualquer erro. Se mesmo assim houver estado parcial: **não reverter schema**. Encerrar vínculos errados (`fim_em`) e re-rodar o plano (idempotente). |

---

## O QUE NÃO FAZER

- ❌ `DROP TABLE` / `DELETE FROM squads*` — o histórico é `append`, e o rollback
  do flag já resolve. `DROP INDEX` / `DROP COLUMN` só com aprovação explícita e
  ciência de que destrói a operação registrada nas entregas criadas pós-deploy
  (RELEASE CANDIDATE §8).
- ❌ Criar membership/vínculo "de emergência" adivinhando o Squad.
- ❌ Voltar ao `JWT_SECRET` antigo.
- ❌ Insistir com `on` sem `auditoria.pronto=true`.

---

## CONTATOS / PLANTÃO (preencher antes do canário)

```
Responsável rollback (acesso Render + autoridade p/ off):  PENDENTE_HUMANO
Backup:                                                    PENDENTE_HUMANO
Dono do dado financeiro (decisões D4):                     PENDENTE_HUMANO
Pessoa 2 (backend / bugs de enforcement):                  PENDENTE_HUMANO
Janela do canário:                                         PENDENTE_HUMANO
```
