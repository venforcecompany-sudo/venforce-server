# Banco de dados do Venforce — reorganização (nov/2026)

Branch `feat/pg-reorganizacao` (worktree `~/venforce-dev/wt-pg-reorg`, base
`origin/main` 27e4bbb1). Sem push, merge, deploy ou escrita em produção.

## Índice

| # | Entrega | Documento | Código |
|---|---|---|---|
| 1 | Mercado Pago: flag de coleta | [01_MERCADO_PAGO.md](01_MERCADO_PAGO.md) | `af8523cd` |
| 2 | Sync noturno: gravações redundantes, antes/depois, etapa 2 | [02_SYNC_NOTURNO.md](02_SYNC_NOTURNO.md) · [medição](sync-noturno/medicao_persistencia_enxuta_pg18.json) | `109569e4` |
| 3 | Inventário técnico (79 tabelas) | [por domínio](inventario/TABELAS_POR_DOMINIO.md) · [identificadores e FKs](inventario/IDENTIFICADORES_E_RELACIONAMENTOS.md) · [dependências](inventario/MATRIZ_DEPENDENCIAS.md) · [classificação e retenção](inventario/CLASSIFICACAO_E_RETENCAO.md) | docs |
| 4 | Raio-X por cliente (serviço read-only) | [contrato](raio-x/CONTRATO_RAIO_X.md) · [exemplo](raio-x/exemplo_raio_x_rapido.json) | `7e1eb006` |
| 5 | Operação sustentável (métricas) | [05_OPERACAO_SUSTENTAVEL.md](05_OPERACAO_SUSTENTAVEL.md) | `8c681752` |
| — | Snapshots, cache e históricos | [06_SNAPSHOTS_CACHE_HISTORICO.md](06_SNAPSHOTS_CACHE_HISTORICO.md) | — |
| — | Retenção (integração, sem novo sistema) | [07_RETENCAO_INTEGRACAO.md](07_RETENCAO_INTEGRACAO.md) | — |
| — | **Pendências e rollout** | [PENDENCIAS_E_ROLLOUT.md](PENDENCIAS_E_ROLLOUT.md) | — |

Etiquetas de evidência nos documentos: **[código]** confirmado lendo código
(arquivo:linha), **[inferido]**, **[não verificado]**. Nada aqui foi confirmado
no banco de produção (sem acesso nesta missão); medições são em PG 18 local
com dados sintéticos.

## Respostas curtas

- **Que dados temos / de quem / de onde / quem usa:** inventário (3) e, por cliente, Raio-X (4).
- **Por que guardamos e quando dá para remover:** classificação (3), snapshots (06), retenção (07).
- **Quanto ocupam e como crescem:** relatório de armazenamento (5).
- **Como parar de acumular cópias:** coleta MP sob flag (1), persistência enxuta + medição de redundância (2), retenção da outra frente (07), e a etapa 2 (mosaico) para o número de cópias.

## Testes

- Suíte completa (`server/tests/*.test.js`, 396 arquivos): branch com as **mesmas
  4 falhas preexistentes** da main (basesTiktok, designStudioWorkspace,
  meliAnunciosOrdenacaoGlobal, mlTokenService).
- PG 18 local (`CENTRAL_VENDAS_PG_TEST_DATABASE_URL=postgres://vf@127.0.0.1:57651/postgres`):
  `centralVendasPersistenciaEnxuta.postgres.test.js` (74), `raioXCliente.postgres.test.js` (23).
