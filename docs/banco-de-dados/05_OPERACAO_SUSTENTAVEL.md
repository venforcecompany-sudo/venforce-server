# Entrega 5 — Acompanhar o crescimento

Commit `8c681752`. Consultas: `server/sql/observabilidade/pg_armazenamento.sql`.
Script: `server/scripts/pg-relatorio-armazenamento.js`. Testado em PG 18 local
(todos os blocos sem erro; segunda execução compara com a primeira).

## Como rodar (1× por dia, ou sob demanda)

```bash
PG_METRICAS_DATABASE_URL=postgres://... node server/scripts/pg-relatorio-armazenamento.js --capacidade-gb 10
# grava ~/venforce-backups/pg-metricas/AAAA-MM-DDTHHMMZ.{json,md}
```

Ou `psql "$URL" -f server/sql/observabilidade/pg_armazenamento.sql`.
Não usa `server/.env`; `BEGIN READ ONLY` + `statement_timeout` por bloco.
Rodar contra produção requer autorização (é leitura leve: catálogos + tabelas pequenas).

## O que mede

| Bloco | Mede | Custo |
|---|---|---|
| `banco` | tamanho total | catálogo |
| `tabelas`, `indices` | total/heap/toast/índices, vivas/mortas, inserções acumuladas, último autovacuum | catálogo |
| `espaco_morto` | bytes mortos **estimados** (fração de mortas × heap) | catálogo |
| `central_imports`, `central_copias_superadas`, `central_imports_por_dia` | imports por status/fonte, cópias superadas (aprox.), pedidos gravados por dia | tabela pequena |
| `mp_payments_duplicacao` | linhas × payments distintos (pg_stats) | catálogo |
| `syncs_24h` | runs por status, duração mediana/máx. | tabela pequena |
| `syncs_escrita_24h` | pedidos/bytes gravados e inalterados/alterados/novos por sync (Entrega 2) | tabela pequena |
| `wal_e_reset` | WAL acumulado, `stats_reset` (indício de crash-recovery) | catálogo |

Análise do script: ocupação vs capacidade, limiares **80/90/95%**, crescimento
desde o relatório anterior, por dia, projeção de dias até cada limiar, top 15
tabelas que mais cresceram. Contadores acumulados negativos (stats reset) viram "—".

## Alertas sugeridos (manual, sem ferramenta nova)

- ≥ 80%: rodar o próximo lote de retenção.  ≥ 90%: congelar backfills e
  pedir upgrade de disco.  ≥ 95%: incidente.
- `bytes_mortos_estimados` alto numa tabela sem autovacuum recente: checar
  autovacuum (não `VACUUM FULL`).
- `stats_reset` mudou sem ação humana: investigar crash-recovery.
