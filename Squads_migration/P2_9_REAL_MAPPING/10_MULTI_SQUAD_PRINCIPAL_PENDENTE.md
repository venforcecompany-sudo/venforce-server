# 10 — Multi-Squad e Squad principal pendente

> **A escolha do Squad principal NÃO foi feita.** Não por ordem da planilha,
> não por "primeiro encontrado", não por id. É decisão humana, e o modo estrito
> bloqueia até ela chegar.

## Por que o principal importa

`squad_members.is_primary` define o Squad **principal** de quem está em vários.
No máximo **um** principal ativo por usuário — há índice parcial único no banco.
O principal é o que responde por "o Squad desta pessoa" onde o sistema precisa
de **um** valor.

⚠️ **O tooling escolhe sozinho se ninguém escolher.** O dry-run real emitiu:

```
⚠ [membros] usuário id=24 ficará sem principal explícito — a 1ª membership será auto-promovida a principal.
⚠ [membros] usuário id=28 ficará sem principal explícito — a 1ª membership será auto-promovida a principal.
```

"A 1ª membership" é **a ordem do array no plano**, que vem da ordem da
planilha — exatamente o critério que esta missão proíbe. Por isso o plano marca
essas entradas com `_principalPendente` e o modo estrito recusa emitir.

---

## As 4 pessoas em 2+ Squads

| pessoa | user_id | Squads | papéis | estado |
|---|---|---|---|---|
| `Fernando` | **não resolvido** | squad-1 · squad-4 | auxiliar2 · coordenador | bloqueado antes disso: identidade não resolvida |
| `Klayvert` | **não resolvido** | squad-2 · squad-3 · squad-6 | coordenador · coordenador · coordenador | bloqueado antes disso: identidade não resolvida |
| `Micael` | #24 | squad-1 · squad-5 | coordenador · coordenador | **PENDENTE_SQUAD_PRINCIPAL** |
| `Sophia` | #28 | squad-5 · squad-6 | design · design | **PENDENTE_SQUAD_PRINCIPAL** |

---

## Achado: a lista de multi-Squad estava incompleta

A missão listava **três** pessoas multi-Squad — Klayvert, Micael e Fernando.
O dado real mostra **4**:

**`Sophia` é Design do Squad 5 *e* do Squad 6.** Isso decorre diretamente da
própria decisão de produto desta missão ("Design do Squad 6 = Sophia") somada ao
Design do Squad 5, que já era Sophia. Ela é a **única multi-Squad já resolvida
por identidade** (`#28`), então é também a única, junto com Micael, que chega
até o aviso de auto-promoção no dry-run.

| pessoa | estava na lista da missão? | identidade resolvida? | chega ao aviso de auto-promoção? |
|---|---|---|---|
| `Fernando` | sim | não | não (barrado antes) |
| `Klayvert` | sim | não | não (barrado antes) |
| `Micael` | sim | sim (#24) | **sim** |
| `Sophia` | **não — achado desta fase** | sim (#28) | **sim** |

