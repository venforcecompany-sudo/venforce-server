# 15 — GO / NO-GO pré-apply

```
VEREDITO:  NO-GO
MOTIVO:    decisão humana pendente — não defeito técnico
BANCO:     NÃO ALTERADO      APPLY:  NÃO EXECUTADO
ENFORCEMENT: OFF             DRY-RUN: EXECUTADO, VÁLIDO, ZERO ESCRITA
```

## O que está pronto

| item | estado |
|---|---|
| Inventário real do banco | ✅ extraído, read-only |
| Matriz de referências a `cliente_id` | ✅ 38 colunas, 12 sem FK, 16 CASCADE |
| Os 52 nomes da relação | ✅ 100% classificados |
| Clientes inexistentes | ✅ separados, **0 criados** |
| Clusters legados | ✅ 11 auditados com evidência |
| Grants | ✅ 100% contabilizados · **0 perdidos** |
| Bases | ✅ classificadas por semântica |
| Mapa Cliente→Squad | ✅ 83/83, exatamente 1 Squad cada |
| Squad 8 no tooling | ✅ suportado, validado, sem Squad 7/9 acidental |
| T-2 · roles divergentes | ✅ **RESOLVIDO** |
| T-3 · dry-run com DDL | ✅ **RESOLVIDO**, provado contra produção |
| T-4 · gate por vacuidade | ✅ **RESOLVIDO** |
| Invariantes | ✅ 13/13 verdes |
| Dry-run | ✅ **exit 0**, plano válido, zero escrita |
| Suíte de testes | ✅ 179 arquivos verdes, zero regressão |

---

## ⛔ O que bloqueia o apply

### B1 — Squad principal de quem está em 2+ Squads · **BLOQUEANTE**

| pessoa | user_id | Squads |
|---|---|---|
| `Micael` | #24 | squad-1 · squad-5 |
| `Sophia` | #28 | squad-5 · squad-6 |

Sem decisão, o tooling auto-promove **pela ordem da planilha**. Confirmado pelos
2 avisos do dry-run real.

### B2 — Identidade de 7 pessoas · **BLOQUEANTE para as memberships**

| pessoa | situação |
|---|---|
| `Caique` | **não tem conta no sistema** |
| `Carol` | **não tem conta no sistema** |
| `Fernando` | ambígua entre #5 e #45 |
| `Klayvert` | ambígua entre #22 e #35 |
| `Victor` | ambígua entre #6 |
| `Vinícius` | ambígua entre #29 e #44 |
| `Yuri` | **não tem conta no sistema** |

Consequência: 6 das 24 posições da planilha ficam **sem membership**. Os Squads
funcionam, mas incompletos.

### B3 — Grant cruzado #102 × #105 · **BLOQUEANTE para o enforcement**

Fenix (Squad 6) tem um grant secundário apontando para a conta de marketplace da
Eliza.Market (Squad 8). Ligar o enforcement nesse estado dá ao Squad 6 acesso à
conta de um cliente que não é dele. **É defeito de cadastro, não de mapeamento.**

### B4 — Semântica operacional do Squad 8 · **BLOQUEANTE só para o enforcement**

Com enforcement ON e Squad 8 sem membros, seus 26
clientes ficam acessíveis **apenas para admin**. Correto para os de teste;
provavelmente errado para os reais.

### B5 — Frescor do inventário · **PROCEDIMENTAL**

O banco ganhou um cliente durante esta missão. O plano precisa ser regerado
imediatamente antes do apply.

---

## O que **não** bloqueia

| item | por quê |
|---|---|
| `MM` ambíguo | os dois candidatos vão para o Squad 8 — quarentena reversível, não erro de acesso |
| 5 clientes da relação inexistentes | não foram criados, ficam fora do plano; entram quando forem cadastrados |
| Consolidação de clusters | `PLAN_ONLY` — o mapa de Squad não depende dela, porque o alias **herda** o Squad do canônico |
| `API_KEY_LEGACY_DEPENDENCY` | `callbacks` está vazia: zero uso registrado. Reverificar antes de desativar qualquer registro |
| `responsaveis` vazio | responsabilidade nunca concedeu acesso; não tira permissão de ninguém |

---

## Ordem obrigatória do primeiro apply

O mapa de Squad e a consolidação são **independentes por construção** — o alias
herda o Squad do canônico, então nenhum cliente fica invisível seja qual for a
ordem. Ainda assim:

1. **decidir B1** (3 ou 4 principais) e **B2** (identidades);
2. **regerar** inventário + auditoria + plano — B5;
3. **rodar o dry-run de novo** e conferir que os avisos de auto-promoção sumiram;
4. **aplicar o mapa de Squad** (`--apply`), com `SQUADS_ENFORCEMENT` ainda **OFF**;
5. conferir `auditoria().pronto` — deve deixar de reprovar por vacuidade;
6. **só então** discutir consolidação, B3 e B4;
7. **só depois de tudo isso** considerar ligar o enforcement.

> Aplicar o mapa com enforcement OFF é seguro: cria Squads, memberships e
> vínculos, e **não muda acesso de ninguém**. O momento perigoso é o passo 7.

