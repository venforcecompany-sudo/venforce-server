# Entrega 2 — Sync noturno: gravações redundantes

Commit `109569e4` (sem push). Medição: `sync-noturno/medicao_persistencia_enxuta_pg18.json`.

## Por que cada noite recria pedidos/itens/componentes (confirmado no código)

1. **Modelo = snapshot completo por import.** Leitores escolhem **um** import por
   (cliente, conta, marketplace, competência) que cubra o segmento
   (`selecionarMelhorImportPorCompetencia` / `coberturaContemSegmento`) e leem
   suas linhas por `import_id`. Linhas não são compartilháveis entre imports
   (FK `import_id`, `pedido_row_id`).
2. **Noturno do mês corrente = 01→ontem, todas as noites**
   (`calcularPeriodosNoturnos`). A cobertura cresce um dia por noite ⇒ cada noite
   é um import novo com o mês inteiro: em 30 dias, 1+2+…+30 = 465 "dias-pedido"
   gravados para 30 dias reais (~15×). Dias 2–5 (e até 15 para contas
   incompletas) o mês anterior inteiro também é regravado.
3. **Cada pedido era gravado três vezes por import:** colunas; `payload_json` da
   linha (itens/componentes: cópia exata das colunas, **sem leitor**); e
   `central_vendas_imports.payload_json` = o motorPayload **inteiro**, **sem leitor**.
4. Cópias anteriores ficam até a retenção (frente separada) removê-las.

Por isso um "hash mensal" não resolve: no mês corrente a cobertura muda toda
noite, o import nunca é idêntico. E reaproveitar linhas ou mutar o import
publicado quebra garantias reais (o Painel valida snapshots pelos **ids**
vigentes; fechamentos e retenção assumem import imutável).

## Etapa 1 — compatível (implementada)

`CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA=true` (opt-in; **ausente = formato
antigo, byte a byte**). Vale só para imports do Sync (`orders_api` + `sync_run_id`).

| O quê | Antes | Depois |
|---|---|---|
| `pedido_itens.payload_json` / `componentes.payload_json` | objeto inteiro (= colunas) | só **extras** que as colunas não reproduzem (normalmente `{}`); colunas + extras reconstroem o original (`reconstruirItem/Componente`) |
| `imports.payload_json` | motorPayload inteiro | **manifesto**: contagens + digest SHA-256 por pedido |
| `pedidos.payload_json` | completo | **inalterado** (lido por `buildPedidoContrato`) |
| Planilha manual / outras fontes | completo | **inalterado** |
| Leitura, seleção canônica, publicação, retenção, Painel, Margem, Sentinel | — | **nenhuma mudança** |

Sempre (com ou sem flag) o run passa a registrar em
`metadata_json.porCompetencia[].persistencia`: `bytesJsonEstimados`, `duracaoMs`,
e com a flag `diff = {novos, alterados, inalterados, removidos, identico}` contra
o manifesto do import vigente. É o medidor de redundância que a Entrega 5 lê.

## Antes × depois (PG 18 local, 12 noites, 40 pedidos/dia, 3% de mudanças/noite)

Fixtures sintéticas; teste `centralVendasPersistenciaEnxuta.postgres.test.js` (74 verificações).

| Medida | Completo | Enxuto | Diferença |
|---|---:|---:|---:|
| Disco total das 4 tabelas | 14,5 MB | 9,5 MB | **−34%** |
| `central_vendas_componentes` | 8,1 MB | 5,0 MB | −38% |
| `central_vendas_pedido_itens` | 2,5 MB | 1,2 MB | −53% |
| `central_vendas_imports` | 0,8 MB | 0,24 MB | −69% |
| `central_vendas_pedidos` | 3,1 MB | 3,1 MB | 0 (payload lido) |
| JSON gravado na noite 12 | 1,66 MB | 0,30 MB | −82% |
| Tempo de persistência (noite 12) | 694 ms | 734 ms | equivalente |
| Linhas gravadas | iguais | iguais | — |
| Leitura canônica + realizado + resumo financeiro | — | — | **idênticos nas 12 noites** |

Redundância medida pelo manifesto (noites 2–12): 440 novos, 155 alterados,
**2.485 inalterados (81%)**. Em produção o número real sai do relatório
diário (`syncs_escrita_24h`) assim que a flag estiver ligada.

> Teste sintético não prova segurança em produção. Ele prova paridade de leitura
> e ausência de perda no código; o rollout abaixo é gradual por isso.

## Etapa 2 — futura (exige mudança de modelo)

**Cobertura em mosaico:** o import do mês corrente vira segmentos não sobrepostos
(ex.: semanal + "dias recentes"). A cada noite, o manifesto por pedido diz quais
segmentos mudaram; só esses são regravados como imports novos; os demais
continuam vigentes.

- Leitores por intervalo já aceitam vários `importIds`
  (`loadPedidosByImportIds` usa `import_id = ANY` + `data_pedido BETWEEN`).
- A mudar: `selecionarMelhorImportPorCompetencia`/`resolveImportsForRange`
  (devolver o mosaico vigente), `getLatestCentralVendasImport`, dominância da
  retenção, invariante de ids vigentes do Painel, `listarContasComMesIncompleto`.
- Ganho esperado: grava ~(novos + alterados + segmento do dia) em vez do mês
  inteiro — na medição, ~19% das linhas das noites 2–12.
- Pré-requisito: etapa 1 ligada em produção por algumas semanas para medir a
  taxa real de alterados por conta.

## Rollout e reversão

1. Merge: no-op (flag ausente; só a medição de bytes/duração é nova no metadata).
2. Ligar `CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA=true` no Render; acompanhar 2–3
   noites: Painel/Central/Margem/Fechamento-API conferidos em 1–2 contas; relatório
   de armazenamento (`syncs_escrita_24h`).
3. Reverter = remover a env. Imports já gravados enxutos continuam **legíveis**
   (leitores nunca usaram esses JSONs); se um dia for preciso o JSON completo,
   `reconstruirItem/Componente` reconstrói a partir das linhas.
