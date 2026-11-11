# Entrega 2 — Sync noturno: parar de recriar pedidos inalterados

Commits: `109569e4` (persistência enxuta + medição), `44fd802c` (reuso de pedidos),
`fa9bb21e` (rollout por conta). Sem push.
Medições: `sync-noturno/medicao_3_versoes_pg18.json` (principal) e
`sync-noturno/medicao_3_versoes_com_troca_de_lista_pg18.json`.

## Causa (confirmada no código)

1. Cada import é um snapshot completo da competência; os leitores escolhem **um**
   import por (cliente, conta, marketplace, competência) e leem as linhas dele.
2. O noturno do mês corrente sincroniza 01→ontem **toda noite** ⇒ import novo com
   o mês inteiro: 1+2+…+30 = 465 "dias-pedido" gravados para 30 dias reais (~15×).
3. Cada pedido ainda era gravado 3× por import (colunas + 2 JSONs sem leitor).

## Solução escolhida: reuso de pedidos inalterados (variante de A)

Avaliadas:
- **B (segmentos por dia/semana):** descartada. Com 3% de pedidos alterados por
  noite e 40 pedidos/dia, ~70% dos dias têm alguma mudança toda noite (0,97⁴⁰ ≈ 30%
  de dias intactos) ⇒ quase tudo seria regravado.
- **A pura (tabela canônica por pedido):** muda ownership, purge, unificação e
  retenção de uma vez. Reescrita maior que o necessário.
- **Escolhida — A compatível:** o import continua existindo e sendo publicado
  igual; só deixa de copiar pedidos que não mudaram.

Como funciona:
- O manifesto (digest SHA-256 por pedido = pedido + itens + componentes) do
  import vigente da **mesma tupla** diz quais pedidos são idênticos.
- O import novo grava como linhas próprias só **novos e alterados**; os
  inalterados viram uma linha de vínculo em `central_vendas_import_pedidos
  (import_id, pedido_row_id)` (~116 B, contra ~6 KB do pacote pedido+itens+componentes).
- Pedidos de um import = linhas próprias ∪ vinculadas
  (`centralVendasPedidosCompartilhados.js`). Todos os leitores por `import_id`
  foram adaptados e devolvem o **import lido**: Central (período, getLatest,
  detalhe), realizado da Margem, Painel (pedidos, composição, sobreposição),
  Cliente 360. Sentinel não lê essas tabelas.
- **Sem a tabela de vínculos, cada leitor executa o SQL de antes, idêntico.**

O que **não** muda: seleção canônica por competência e cobertura; publicação
candidate→published; isolamento por conta (o reuso só olha a mesma tupla e
filtra `cliente_slug/marketplace/competencia`); imports existentes; planilhas
(nunca entram no reuso); fórmulas.

Alterações legítimas (frete que chega, status, devolução, reembolso, comissão,
resultado, custo) mudam o digest ⇒ o pedido é gravado de novo como versão nova.

Integridade: FK `pedido_row_id` sem CASCADE ⇒ apagar o import **dono** de
linhas que outro import usa falha com 23503 (testado); apagar o cliente inteiro
(purge) passa e não deixa órfão (testado). A unificação conhece a tabela nova
(`centralReferenceScope.js`, PRESERVE_BY_PARENT); seus testes PG (54 cenários) passam.

## Antes × depois — PG 18 local, mesmas 12 noites + fechamento do mês

40 pedidos/dia, 3% dos pedidos antigos mudam por noite, frete atrasado chega na
noite seguinte. Dados sintéticos. Teste `centralVendasPersistenciaEnxuta.postgres.test.js`
(175 verificações). **Não é economia obtida em produção.**

| | 1. main | 2. enxuta | 3. reuso |
|---|---:|---:|---:|
| Imports criados | 13 + 1 planilha | igual | igual |
| Pedidos novos (12 noites) | 480 | 480 | 480 |
| Pedidos alterados | 155 | 155 | 155 |
| Inalterados **regravados** | **2.965** | 2.965 | **0** (2.965 vínculos) |
| Linhas de pedido gravadas | 3.600 | 3.600 | **635** |
| Itens gravados | 3.600 | 3.600 | 635 |
| Componentes gravados | 21.750 | 21.750 | 3.842 |
| Disco (tabelas + índices + vínculos) | 16,71 MB | 10,98 MB | **2,78 MB** |
| — componentes | 9,4 MB | 5,8 MB | 1,1 MB |
| — pedidos | 3,5 MB | 3,5 MB | 0,7 MB |
| — itens | 2,9 MB | 1,4 MB | 0,3 MB |
| — vínculos | — | — | 0,33 MB |
| Tempo total de gravação | 5,5 s | 5,4 s | **1,3 s** |
| Leitores atuais e resultado financeiro | referência | idênticos | idênticos |
| Fechamento do mês sem mudança | regrava 480 | regrava 480 | **0 linhas** |

Redução vs main: **−83% de disco**, **−82% de linhas de pedido**, −76% de tempo de gravação.
Com a conta saindo da lista na noite 11 (grava completo) e voltando na 12: 3,86 MB, leitores idênticos.

## Estimativa de redução do crescimento (fundamentada, não medida em produção)

Base: produção em 05/11 tinha 711.644 linhas de pedido para 4.249 MB em
pedidos+itens+componentes (≈ **6,0 KB por pedido**, com índices); vínculo medido
localmente ≈ **116 B**. Por conta e mês, com *d* pedidos/dia e fração *a* de
pedidos antigos alterados por noite:

- main: 465·d pacotes ≈ 2,8·d MB/mês
- reuso: (30 + 435·a)·d pacotes + 435·d vínculos

| *a* (alterados/noite) | Redução das gravações da Central |
|---|---:|
| 3% (teste) | ≈ 89% |
| 10% | ≈ 83% |
| 20% | ≈ 73% |

Ordem de grandeza: ~73 runs/dia em produção × ~739 pedidos por import ≈ 54 mil
pacotes/dia ≈ **320 MB/dia de escrita bruta** na Central hoje (antes da retenção).
Com reuso em todas as contas: ~35–85 MB/dia, conforme *a*. O valor real sai do
relatório diário (`syncs_escrita_24h`: inalterados × alterados × novos) depois de
ligar a flag.

## O que continua crescendo (legitimamente)

- 1 pacote por **pedido novo** e 1 por **alteração real** (versão nova).
- Vínculos: 1 por pedido inalterado por noite (~116 B). Cresce com noites × pedidos
  do mês, mas ~50× menor que a cópia. Fica limitado pelo GC de imports superados (pendência).
- Versões antigas de pedidos alterados ficam no import que as gravou, até a retenção tratá-las.
- `central_vendas_sync_runs/sources` (metadados por run), Sentinel incremental,
  fechamentos/entregas, dados manuais, snapshots de margem (sobrescritos).

## Rollout gradual por conta e reversão

1. Merge: no-op (flags desligadas, migration fora do boot).
2. Aplicar `server/sql/migrations/20261111_central_vendas_import_pedidos.sql` (manual, autorizado) e reiniciar.
3. `CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA=true` (pré-requisito do manifesto) — 1–2 noites.
4. `CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS=true` + `CENTRAL_VENDAS_SYNC_REUSO_CONTAS=<1–2 contas>`.
   Conferir Painel, Central, Margem, Cliente 360 e Fechamento via API dessas contas; relatório diário.
5. Ampliar a lista; depois `*`.
6. Reverter: tirar a conta da lista (ou a flag). Imports já gravados com vínculo **continuam
   legíveis** (leitores sempre entendem vínculos); o próximo import da conta volta a gravar completo.
   A tabela só pode ser removida quando estiver vazia.
