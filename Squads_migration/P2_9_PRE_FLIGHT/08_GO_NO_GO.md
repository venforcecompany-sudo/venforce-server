# 08 — Matriz GO / NO-GO para P2.9

> **NO-GO se qualquer linha "Bloqueante" não estiver `GO`.** A maioria não é
> verificável hoje — depende da Convergência #2, de dado real e de decisão
> humana. Esta matriz é o gate objetivo que substitui "achamos que dá".
>
> Base: `VENFORCE_V3_BACKEND_RELEASE_CANDIDATE.md` §13.
>
> Legenda STATUS: `GO` · `NO-GO` · `PENDENTE` (aguardando dado/decisão) ·
> `N/A`.

---

## Matriz

| # | Requisito | Bloqueante? | STATUS (2026, pré-flight) | EVIDÊNCIA | DONO | AÇÃO NECESSÁRIA |
|---|---|---|---|---|---|---|
| 1 | **Convergência #2 aprovada e mergeada na `main`** | SIM | `NO-GO` | branch `backend/v3-squads-auth` @ `6126ee1` congelada, em integração; `frontend/v3-marathon-pessoa1` @ `da44ac7` não mergeada | Pessoa 1 + Pessoa 2 (integração) | concluir Convergência #2 (ver `11_DEPENDENCIAS_CONVERGENCIA_2.md`) |
| 2 | **`JWT_SECRET` definida em produção (≥ 32 chars, ≠ dev)** | SIM | `PENDENTE` | regra existe (`server/config/jwtSecret.js`); estado do Render **não verificável do repo** | quem tem acesso ao Render | confirmar/definir no Render + `NODE_ENV=production` (ver `06`) |
| 3 | **Código deployado com `SQUADS_ENFORCEMENT=OFF` e smoke §7.5 verde** | SIM | `NO-GO` (depende de #1, #2) | — | quem faz o deploy | deploy pós-Convergência #2; rodar smoke do RELEASE CANDIDATE §7.5 |
| 4 | **Mapeamento Cliente→Squad revisado por pessoa** (não gerado) | SIM | `PENDENTE` | template pronto (`02`, `templates/plano-p2-9.PENDENTE_HUMANO.json`); dados = `PENDENTE_HUMANO` | gestão da operação | reunião de `03`; preencher `clientes[]` do plano |
| 5 | **Mapeamento Usuário→Squad revisado por pessoa** | SIM | `PENDENTE` | idem | gestão da operação | reunião de `03`; preencher `membros[]` do plano |
| 6 | **Dry-run limpo** (`--plan`, 0 erros, avisos revisados) | SIM | `PENDENTE` | tooling P2.3 testado (`squadsMigracaoImport.test.js`, 39 checks); falta o plano real | Pessoa 2 / operador P2.9 | rodar `09` quando #4/#5 prontos |
| 7 | **`auditoria().pronto === true`** após `--apply` | SIM | `PENDENTE` | gate implementado (`squadsMigracaoService.auditoria`); regra: `semSquad==0 && emSquadInativo==0 && semMembership==0 && apenasEmSquadInativo==0 && semPrincipal==0 && principalDuplicado==0 && vinculoDuplicado==0` | operador P2.9 | pós `--apply`, iterar plano até `pronto:true` |
| 8 | **`auditoria().integridade.clientesComVinculoDuplicado === 0`** | SIM | `PENDENTE` | query `queries/03_inconsistencias.sql` BLOQUEANTE 1 | operador P2.9 | verificar pós-apply; se >0, o rollout **não pode** acontecer |
| 9 | **`auditoria().atencao` revisado** (não precisa ser 0; precisa ser **conhecido**) | SIM (revisão), não (zerar) | `PENDENTE` | `atencao.responsaveisForaDoSquad`, `atencao.membershipsDeUsuarioInativo` | gestão + operador | revisar cada item; aceitar explicitamente ou corrigir antes do canário |
| 10 | **Duplicidade financeira D4 tratada** | NÃO para o enforcement; SIM para o índice D4 | `PENDENTE` | `05` + `queries/d4_*.sql`; classe D exige decisão humana | gestão (dono do dado) | rodar `05`; resolver A/B/C; decidir cada D. **Não bloqueia o rollout de Squads** se a gestão adiar a decisão das entregas |
| 11 | **Plano de canário definido** (qual Squad primeiro, janela, estratégia A/B) | SIM | `PENDENTE` | `07` — plano pronto, falta escolher o Squad e a janela | gestão + Pessoa 2 | `03` pergunta 12 + `07` |
| 12 | **Responsável pelo rollback disponível** (acesso ao Render + autoridade para `SQUADS_ENFORCEMENT=off`, de plantão durante o canário) | SIM | `PENDENTE` | `10_ROLLBACK_CARD.md` pronto | gestão | nomear a pessoa + janela de plantão |
| 13 | **Contador de "403 de carteira/dia"** (sinal nº 2 de aborto do canário) | NÃO (desejável) | `PENDENTE` | RELEASE CANDIDATE §9 — "pré-requisito desejável, não bloqueante" | Pessoa 2 / quem executar P2.9 | trabalho de backend pequeno, fora deste pacote de docs |
| 14 | **Riscos abertos do RELEASE CANDIDATE classificados** | NÃO | `GO` | `12_RISCOS_ABERTOS.md` — nenhum bloqueia P2.9 | Pessoa 2 | — (feito neste pré-flight) |

---

## Resumo por estado

```
GO agora:        14 (riscos classificados — nenhum bloqueia)
NO-GO agora:      1, 3        (dependem da Convergência #2 / deploy)
PENDENTE:         2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13
```

**Nenhum item está intrinsecamente bloqueado** — todos os `PENDENTE` viram `GO`
com: Convergência #2 mergeada + reunião de `03` + execução do runbook `09` +
uma janela de canário. É exatamente o que o pré-flight queria: eliminar tudo
que não depende da Convergência #2.

---

## Ordem de resolução recomendada

```
1. Convergência #2 (itens 1)                         ── Pessoa 1 + Pessoa 2
2. JWT_SECRET no Render (item 2)  ─ paralelo          ── acesso Render
3. reunião de gestão / 03 (itens 4, 5, 9, 10, 11, 12) ── gestão
4. deploy OFF + smoke (item 3)                        ── deploy
5. contador de 403 (item 13) ─ paralelo, desejável   ── Pessoa 2
6. --audit → --plan (dry-run) → --apply (itens 6, 7, 8) ── operador P2.9
7. canário (07)                                       ── plantão
```
