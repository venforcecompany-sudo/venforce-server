# Banco de dados do Venforce — reorganização (nov/2026)

Branch `feat/pg-reorganizacao` (worktree `~/venforce-dev/wt-pg-reorg`, base
`origin/main` 27e4bbb1). Sem push, merge, deploy ou escrita em produção.

## Índice

| # | Entrega | Documento | Código |
|---|---|---|---|
| 1 | Mercado Pago: flag de coleta | [01_MERCADO_PAGO.md](01_MERCADO_PAGO.md) | `af8523cd` |
| 2 | Sync noturno: reuso de pedidos inalterados (main × enxuta × reuso) | [02_SYNC_NOTURNO.md](02_SYNC_NOTURNO.md) · [medição 3 versões](sync-noturno/medicao_3_versoes_pg18.json) | `109569e4`, `44fd802c`, `fa9bb21e` |
| 3 | Inventário técnico (79 tabelas) | [por domínio](inventario/TABELAS_POR_DOMINIO.md) · [identificadores e FKs](inventario/IDENTIFICADORES_E_RELACIONAMENTOS.md) · [dependências](inventario/MATRIZ_DEPENDENCIAS.md) · [classificação e retenção](inventario/CLASSIFICACAO_E_RETENCAO.md) | docs |
| 4 | Raio-X por cliente (serviço read-only) + **interface visual local** | [visual](raio-x/RAIO_X_VISUAL.md) · [contrato](raio-x/CONTRATO_RAIO_X.md) · [exemplo](raio-x/exemplo_raio_x_rapido.json) | `7e1eb006` |
| 5 | Operação sustentável (métricas) | [05_OPERACAO_SUSTENTAVEL.md](05_OPERACAO_SUSTENTAVEL.md) | `8c681752` |
| — | Mercado Pago: acumulado e retenção própria | [08_MERCADO_PAGO_ACUMULADO.md](08_MERCADO_PAGO_ACUMULADO.md) | `98cc0328` |
| — | Snapshots, cache e históricos | [06_SNAPSHOTS_CACHE_HISTORICO.md](06_SNAPSHOTS_CACHE_HISTORICO.md) | — |
| — | Retenção (integração, sem novo sistema) | [07_RETENCAO_INTEGRACAO.md](07_RETENCAO_INTEGRACAO.md) | — |
| — | Retenção × reuso: proibição e especificação (S1–S4) | [09_RETENCAO_X_REUSO_ESPECIFICACAO.md](09_RETENCAO_X_REUSO_ESPECIFICACAO.md) | — |
| — | **Pendências e rollout** | [PENDENCIAS_E_ROLLOUT.md](PENDENCIAS_E_ROLLOUT.md) | — |
| — | **Checklist de publicação (flags desligadas)** | [CHECKLIST_PUBLICACAO.md](CHECKLIST_PUBLICACAO.md) | — |

Etiquetas de evidência nos documentos: **[código]** confirmado lendo código
(arquivo:linha), **[inferido]**, **[não verificado]**. Nada aqui foi confirmado
no banco de produção (sem acesso nesta missão); medições são em PG 18 local
com dados sintéticos.

## Respostas curtas

- **Que dados temos / de quem / de onde / quem usa:** inventário (3) e, por cliente, Raio-X (4).
- **Por que guardamos e quando dá para remover:** classificação (3), snapshots (06), retenção (07).
- **Quanto ocupam e como crescem:** relatório de armazenamento (5).
- **Como parar de acumular cópias:** reuso de pedidos inalterados no sync (2) — o import novo só grava novos/alterados; coleta MP sob flag (1) e retenção própria do MP (08).

## Testes

- Suíte completa (`server/tests/*.test.js`, 396 arquivos): branch com as **mesmas
  4 falhas preexistentes** da main (basesTiktok, designStudioWorkspace,
  meliAnunciosOrdenacaoGlobal, mlTokenService).
- PG 18 local (`CENTRAL_VENDAS_PG_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57651/postgres`):
  `centralVendasPersistenciaEnxuta.postgres.test.js` (175, três versões), `raioXCliente.postgres.test.js` (23),
  unificação (54 cenários) com a tabela nova registrada.
