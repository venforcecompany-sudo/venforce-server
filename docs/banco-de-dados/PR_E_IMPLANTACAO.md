# PR — `feat/pg-reorganizacao` (HEAD `eabaeef2`, 29 commits sobre `origin/main` 3504b1ac)

Verificado em 11/11/2026: worktree limpa, sem upstream (nada no remoto). Merge de teste com `origin/main`
(`3504b1ac`, só `Portal/vf-shell*`) numa worktree descartável: **0 conflitos**; suíte (402 arquivos) =
**4 falhas, todas preexistentes na main** (basesTiktok, designStudioWorkspace, meliAnunciosOrdenacaoGlobal,
mlTokenService); **nenhuma regressão nova**. PG 18 local sobre a árvore mesclada: reuso/3 versões (175),
isolamento por conta (29), trava S3 (25), Raio-X (23 + 57), retenção (11), unificação (68) — todos OK.

## Título
`feat(banco): reorganização do PostgreSQL — reuso de pedidos, trava de retenção e Raio-X visual (flags desligadas)`

## Descrição
**O quê**
- **Sync da Central**: persistência enxuta + reuso de pedidos inalterados por conta (−83% de disco no PG local sintético; estimativa de campo: −73% a −89% da escrita diária). Tudo opt-in.
- **Leitores** (Central, Margem, Painel, Cliente 360) entendem vínculos; sem a tabela rodam o SQL de antes. A checagem de existência propaga erro e nunca cacheia negativo.
- **Retenção**: trava S3 no executor — `apply` (CLI e auto) recusa enquanto houver vínculo de reuso ou se não conseguir verificar. Correção S1/S2/S4 fica com a frente de retenção.
- **Mercado Pago**: flag para desligar a coleta + SQL read-only de redundância.
- **Raio-X**: serviço read-only, métricas de armazenamento e **interface visual local** (`npm run raio-x`), com host efetivo validado e escopo por conta.
- **Docs** em `docs/banco-de-dados/`.

**Não muda em produção no primeiro deploy**: nenhuma flag nova está ligada; a migration é manual e fora do boot;
o Raio-X é script local (nada dele é carregado pelo app); nenhum motor foi alterado.
Único efeito visível: `metadata_json.porCompetencia[].persistencia` nos runs e 1 consulta de catálogo (`to_regclass`)
por leitura enquanto a tabela de vínculos não existir.

## Flags — devem ficar AUSENTES/desligadas no primeiro deploy
| Variável | Primeiro deploy | Observação |
|---|---|---|
| `CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA` | ausente (off) | liga a gravação enxuta |
| `CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS` | ausente (off) | exige a migration |
| `CENTRAL_VENDAS_SYNC_REUSO_CONTAS` | ausente (nenhuma conta) | lista de ids ou `*` |
| `CENTRAL_VENDAS_RETENCAO_AUTO` | ausente (off) | segue desligada |
| `CENTRAL_VENDAS_RETENCAO_APPLY` | ausente | só para execução manual autorizada |
| `CENTRAL_VENDAS_MP_PAYMENTS_COLETA_ENABLED` | **ausente = coleta LIGADA (igual hoje)** | `false` desliga: decisão separada, fora do 1º deploy |

## Ordem de implantação (cada passo com autorização própria)
1. Rebase/merge na `main` → suíte → PR → merge → deploy **com as flags acima ausentes**. Validar telas e o sync noturno (`persistencia.formato = "completo"`).
2. (Opcional) Raio-X `--real` e `mp_redundancia.sql` fora do pico, para medir a base real (ver `raio-x/RAIO_X_VISUAL.md`).
3. `CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA=true`; validar 1–2 contas.
4. Aplicar a migration manualmente → restart → `REUSO_PEDIDOS=true` + `REUSO_CONTAS=<1–2 contas>` (piloto **sem limpeza**).
5. Ampliar contas → `*`.
6. Retenção em contas com reuso só após S1+S2+S4 na `main` (`GUARDA_VINCULOS=true`).
7. Decisão separada: coleta MP off e retenção do MP (`08_`).

Checklist curto e rollback por período: [`CHECKLIST_PUBLICACAO.md`](CHECKLIST_PUBLICACAO.md).
