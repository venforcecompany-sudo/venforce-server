# P2.9 — PRE-FLIGHT (preparação do rollout de Squads)

> **Estado:** P2.9 **NÃO EXECUTADO**. `SQUADS_ENFORCEMENT` = **OFF**. Nenhum
> dado real migrado, nenhum banco de produção tocado, nenhum deploy, nenhuma
> alteração de Render/JWT_SECRET.
>
> Este pacote é **só preparação**: elimina agora todo o trabalho de P2.9 que
> **não depende** da Convergência #2. Quando a Convergência #2 for aprovada e
> mergeada, o que resta é: preencher decisões humanas → dry-run → revisar →
> aplicar → validar → canário.

---

## Identificação

| Item | Valor |
|---|---|
| Branch deste pacote | `backend/v3-p2-9-preflight` |
| Base | `backend/v3-squads-auth` @ `6126ee1` (HEAD da Pessoa 2 — **congelada**, usada na Convergência #2; esta branch **não** a altera) |
| Escopo de arquivos | **somente** `Squads_migration/P2_9_PRE_FLIGHT/**` (documentos + queries + template). Zero arquivo de runtime, zero colisão com a Convergência #2. |
| Documento canônico de backend | `Squads_migration/VENFORCE_V3_BACKEND_RELEASE_CANDIDATE.md` (P2.8) |
| Tooling de migração | `server/sql/squads-migrate.js` + `server/services/squads/squadsMigracaoImportService.js` + `squadsMigracaoService.js` (P2.3, já testados) |
| Runbooks-base | `VENFORCE_V3_SQUADS_ROLLOUT_SAFETY.md` (P2.2) · `VENFORCE_V3_SQUADS_DATA_MIGRATION_RUNBOOK.md` (P2.3) |

---

## O que P2.9 precisa para acontecer (visão de 1 tela)

```
[Convergência #2 aprovada e mergeada na main]         ← BLOQUEIA (ver 11_DEPENDENCIAS_CONVERGENCIA_2.md)
        │
        ▼
1. JWT_SECRET definido em produção (>= 32 chars)      ← DECISÃO/AÇÃO HUMANA (ver 06)
2. Deploy do código com SQUADS_ENFORCEMENT=OFF + smoke ← AÇÃO HUMANA
3. Auditoria inicial (read-only)                       ← 04, pronto p/ rodar
4. Mapeamento Cliente→Squad / Usuário→Squad / Responsáveis  ← DECISÃO HUMANA (ver 01, 02, 03)
5. Saneamento de duplicatas financeiras D4 (se houver) ← DECISÃO HUMANA (ver 05)
6. Dry-run do plano (0 erros, avisos revisados)        ← 09, pronto p/ rodar
7. Apply transacional idempotente                      ← AÇÃO HUMANA
8. auditoria().pronto === true                          ← gate objetivo (ver 08)
9. Canário: 1 Squad, observar, expandir                ← 07
```

Tudo que **não** é "decisão/ação humana" ou não depende da Convergência #2 já
está preparado neste pacote.

---

## Índice do pacote

| # | Arquivo | Para quê | Estado |
|---|---|---|---|
| 00 | `00_README.md` | este mapa | — |
| 01 | `01_DADOS_HUMANOS_NECESSARIOS.md` | lista completa dos dados que a operação precisa fornecer (clientes, usuários, responsáveis), com `PENDENTE_HUMANO` onde não sabemos | ✅ pronto |
| 02 | `02_TEMPLATE_MAPEAMENTO.md` + `templates/plano-p2-9.PENDENTE_HUMANO.json` | como preencher o plano no formato **exato** do tooling P2.3 (sem formato paralelo) | ✅ pronto |
| 03 | `03_CHECKLIST_GESTAO.md` | pauta objetiva para a reunião com a gestão — 12 perguntas + como registrar as respostas | ✅ pronto |
| 04 | `04_AUDITORIA_PRE_MIGRACAO.md` + `queries/*.sql` | queries **READ-ONLY** para fotografar o estado atual (clientes, contas, usuários, vínculos, inconsistências) | ✅ pronto (leitura) |
| 05 | `05_AUDITORIA_DUPLICATAS_FINANCEIRO.md` + `queries/d4_*.sql` | auditoria da unicidade D4 de `entregas_cliente` — classifica A/B/C/D, D exige decisão humana | ✅ pronto (leitura) |
| 06 | `06_JWT_DEPLOY_READINESS.md` | checklist de deploy do `JWT_SECRET` (sem tocar produção; sem copiar segredo) | ⚠️ DEPENDE HUMANO |
| 07 | `07_PLANO_CANARIO.md` | fases 0→6 da ativação controlada + sinais de aborto | ✅ pronto (plano) |
| 08 | `08_GO_NO_GO.md` | matriz objetiva: STATUS / EVIDÊNCIA / DONO / AÇÃO por requisito | ✅ pronto (matriz) |
| 09 | `09_DRY_RUN_RUNBOOK.md` | como rodar `--audit` → `--plan` (dry-run) → `--apply` quando os dados estiverem prontos; prova de que o tooling não escreve | ✅ pronto (runbook) |
| 10 | `10_ROLLBACK_CARD.md` | cartão curto e operacional para deixar aberto durante o rollout | ✅ pronto |
| 11 | `11_DEPENDENCIAS_CONVERGENCIA_2.md` | o que a Convergência #2 precisa entregar para P2.9 sair de NO-GO | ✅ pronto |
| 12 | `12_RISCOS_ABERTOS.md` | classificação dos riscos deixados pelo Release Candidate (bloqueia P2.9? severidade? decisão humana?) | ✅ pronto |

---

## Regras deste pacote (não violar)

- **PROIBIDO** nesta fase: `SQUADS_ENFORCEMENT=on`; aplicar migration real de
  Squads; importar memberships/Cliente→Squad reais; inventar responsáveis;
  alterar banco de produção; alterar Render; trocar `JWT_SECRET` de produção;
  deploy; alterar backend em integração.
- Onde não se sabe um valor real: escrever `PENDENTE_HUMANO`. **Nunca inventar.**
- Este pacote **não** faz merge em `main` nem em `backend/v3-squads-auth`.
- Nenhuma query deste pacote escreve. Se houver uma cópia de
  desenvolvimento/staging segura, as queries de leitura (04, 05) podem ser
  executadas lá; **nunca em produção com intenção de escrita**.
