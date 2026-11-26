# 10 — Componentes financeiros compactos (formato v2)

Branch `feat/central-vendas-persistencia-componentes-v2` (base `origin/main`
f5162f95). Sem push, PR, merge, deploy, migration em produção, mudança de flag
ou exclusão de dados. Medições em **PostgreSQL 18 local** com dados
**sintéticos** gerados pelo **motor real** (`buildMotorFromOrders`) e gravados
pelo **código real** (`persistCentralVendasImport`). Números de produção são os
do diagnóstico read-only de 05/11/2026 (o único disponível nesta missão; não
houve conexão ao banco real).

Etiquetas: **[código]** lido no código · **[medido]** medido no PG local ·
**[prod 05/11]** diagnóstico de produção · **[inferido]**.

---

## 1. Veredito

**GO condicional** para a implementação definitiva do **formato compacto v1
(arrays tipados por pedido)** combinado com o **reuso de pedidos já
existente**, por flag e piloto por conta. As condições estão na §11.

**NO-GO**, por ora: (a) migrar ou apagar o histórico em linhas (fase 4, só
depois da paridade em produção e com autorização explícita); (b) JSONB como
formato canônico (maior, sem tipo, sem ganho de leitura que os arrays não
tenham).

| Mesmo conteúdo (34.500 linhas de pedido, 223.199 componentes, 21 snapshots) | componentes | B/componente | vs. hoje |
|---|---:|---:|---:|
| Hoje, formato completo (main, flags desligadas) | 97,73 MB | 459 | — |
| Hoje, persistência enxuta | 60,18 MB | 283 | −38% |
| JSONB compacto por pedido | 19,25 MB | 90 | −80% |
| Relacional enxuto (1 linha tipada por componente) | 22,81 MB | 107 | −77% |
| **Arrays tipados por pedido (recomendado)** | **11,91 MB** | **56** | **−88%** |
| Reuso de pedidos (já existe) — linhas | 7,80 MB | — | −92% |
| **Reuso + arrays tipados** | **1,55 MB** | 57 | **−98,4%** |

[medido] `scripts/poc-componentes-v2/bench.cjs` (20 noites × 150 pedidos/dia).

---

## 2. Diagnóstico — onde está o crescimento

### 2.1 Duas causas que se multiplicam

1. **Snapshot redundante.** Cada noite grava um import novo com o **mês
   inteiro** [código `centralVendasSyncService` → `persistCentralVendasImport`].
   Na noite *k*, os pedidos dos dias 1..*k* são gravados de novo: o volume do
   mês cresce como 1+2+…+N. No cenário, as 34.500 linhas de pedido são
   **11,5 cópias** de 3.000 pedidos distintos. O crescimento por noite do modo
   completo (MB acumulados) é quadrático: `0,5 1,4 2,6 4,3 … 80,6 89,1 97,7`.
   Com reuso, fica linear: `0,4 0,7 1,0 … 7,4 7,8` [medido].
2. **Armazenamento estrutural.** Cada componente é uma linha de 20 colunas com
   4 índices. Dos **369 B médios por linha** (formato completo) [medido]:
   - `payload_json` = **174 B**: cópia do próprio componente, **sem leitor**
     [código `COMPONENTE_READ_COLUMNS` não o seleciona; nenhum leitor externo o lê];
   - identificação **derivável** do pedido/item = **75 B** (`import_id`,
     `cliente_id`, `cliente_slug`, `marketplace`, `competencia`, `pedido_id`,
     `item_id`, `created_at`, `updated_at`);
   - classificação M6 **derivável** = **14 B** (`escopo`, `efeito`,
     `incluido_no_resultado` são função pura de `(tipo, item)`, em
     `classificarComponenteFinanceiro`);
   - textos curtos repetidos = **33 B** (`tipo`, `fonte`, `confianca`) + `obs`
     (frases fixas do motor, até 150 B).
   Somam-se cabeçalho de tupla (24 B), ponteiro de linha e 4 índices
   (`pkey`, `import(import_id,pedido_id,item_id)`, `pedido_row`, `item_row`):
   **459 B por componente** no total.

Uma causa não resolve a outra. O reuso tira as cópias, mas cada pedido novo
ou alterado ainda grava ~6 linhas de ~300 B. O formato compacto encolhe cada
pedido gravado, mas não evita regravar o mês inteiro toda noite.

### 2.2 Produção (05/11) [prod 05/11]

| tabela | total | heap | índices | linhas vivas | mortas |
|---|---:|---:|---:|---:|---:|
| central_vendas_componentes | 2.466 MB | 2.061 MB | 404 MB | 4,21 mi | 0,56 mi (11,8%) |
| central_vendas_pedidos | 916 MB | 804 MB | 112 MB | 0,71 mi | — |
| central_vendas_pedido_itens | 867 MB | 732 MB | 135 MB | 0,71 mi | — |

- **615 B por componente** em produção, incluindo inchaço e mortas.
- ≈ 1,0 item por pedido (711.644 pedidos × 712.708 itens) e ≈ 6 componentes
  por pedido.
- `escopo` com `null_frac = 0` (sem linhas pré-M6 a classificar).
- Em 05/11, nem a persistência enxuta nem o reuso existiam: produção estava no
  **formato completo**.

**Extrapolação [inferido]:** com a razão medida arrays/completo (56/459 =
12,2%), o conteúdo atual dos componentes caberia em **≈ 300 MB** (vs.
2.466 MB). `pedidos` + `itens` (1,78 GB) não mudam com o formato compacto. Eles
são **todos** efeito do snapshot redundante, e só o reuso (ou a retenção)
resolve.

> Falta medir em produção: fator de cópias por pedido, volume por conta e
> derivabilidade em dado real. O SQL pronto, somente leitura e amostral, está
> em `server/sql/observabilidade/central_vendas_componentes_v2_medicao.sql`
> (11 seções, para rodar com a role `raiox_ro`).

---

## 3. Mapa de dependências [código]

### Escritores

| onde | o quê |
|---|---|
| `centralVendasRepository.insertComponente` ← `persistCentralVendasImport` | único INSERT de produção, **linha a linha** (1 statement por componente) |
| ← `centralVendasSyncService` (Sync, `orders_api`) | motor API-first: 5 por item + `receita_envio` / `cancelamento_reembolso` por pedido |
| ← `centralVendasImportService` (planilha manual) | motor de planilha (`meliFinanceiroService`): 6 por item |
| `scripts/central-vendas-backfill-escopo-componentes.js` | UPDATE histórico da classificação M6 (execução única) |
| retenção / purge de cliente | só por CASCADE do import |

### Leitores

| leitor | caminho | colunas |
|---|---|---|
| Central de Vendas (tela, KPIs, gráficos, Curva ABC, exportação) | `loadPedidosByImportIds` → `buildPedidoContrato` | `COMPONENTE_READ_COLUMNS` |
| Drawer / detalhe do pedido | `getPedidoDetailByRowId` | idem |
| `getLatestCentralVendasImport` (fechamento de competência) | 2 ramos (com/sem vínculos) | idem |
| Central de Margem — realizado | `loadRealizadoByImportIds` (3 tipos) | `item_row_id, pedido_row_id, tipo, valor` |
| Motor de Margem / evidence adapter / marginSnapshotRead | `getCentralVendasByRange` | idem Central |
| Resgate — detalhe do pedido | `getCentralVendasReadOrderDetail` → contrato | via contrato |
| **Resgate — amostras de frete** | **SQL direto** `resgateLeituraRepository.vendasPorItem` | `valor` por `item_row_id, tipo, fonte` |
| Retenção | contagem/backup CSV **por `import_id`** | `*` |
| Unificação Clientes×Contas | `centralReferenceScope` (PRESERVE_BY_PARENT) | FKs |
| Raio-X | inventário / tamanho | catálogo |
| `scripts/sentinel-e0-paridade.js`, `sql/auditoria/central_vendas_historico_frete_pack.sql` | SQL direto, execução pontual/histórica | `valor, tipo` |

**Não leem componentes** (só pedidos/itens): Painel de Contas e Cliente 360
(`centralVendasCliente360Adapter`). O registro do Raio-X diz que o Painel
consome componentes; o código atual não confirma. O Financeiro (fechamento)
não lê a Central de Vendas. **Nenhum leitor usa o `id` do componente nem o
`payload_json` do componente.**

---

## 4. Comparação dos modelos

| critério | 1. Relacional atual + enxuta + reuso | 1b. Relacional enxuto (1 linha tipada) | 2. JSONB por pedido | 3. **Arrays tipados por pedido (híbrido)** | 4. Canônico versionado |
|---|---|---|---|---|---|
| B/componente [medido] | 283 (enxuto) | 107 | 90 | **56** | ≈ 3 com arrays (é o reuso) |
| linhas gravadas | 1 por componente | 1 por componente | 1 por pedido | **1 por pedido** | 1 por versão de pedido |
| índices | 4 | 1 (PK) | 1 (PK) | **1 (PK)** | ≥2 |
| tipo do valor | NUMERIC(14,2) | NUMERIC(14,2) | número JSON (sem typmod) | **NUMERIC(14,2)[]** (cast na gravação, = hoje) | depende |
| NULL ≠ 0, repetidos | sim | sim | sim | **sim** | sim |
| integridade | FKs | FK pedido (+ composta p/ item) | FK pedido; item por construção | FK pedido; CHECK de dimensões; item por construção | FKs, mas sem dono → nova semântica de retenção |
| SQL direto (agregar) | trivial | trivial | `jsonb_array_elements` | `unnest` | — |
| período, 3.000 pedidos [medido] | 154 ms | 208 ms | 219 ms (SQL) / **65 ms (JS)** | 227 ms (SQL) | — |
| detalhe de 1 pedido | 0,5 ms | 1,9 ms | 2,0 / 0,4 ms | 2,0 ms | — |
| agregação por tipo | 11 ms | 11 ms | 24 ms | 19 ms | — |
| escrita de 19.568 componentes | 4.105 ms (linha a linha, código atual) · 489 ms em lote | 220 ms | 68 ms | **112 ms** (código real) | — |
| TOAST | não | não | só em pedidos > 2 kB | só em pedidos > 2 kB | — |
| retenção / purge / reuso | já integrado | CASCADE do pedido | CASCADE do pedido | **CASCADE do pedido** (backup adaptado) | **muda tudo** (sem import dono) |
| esforço / risco | — (já existe) | médio | médio | **médio** | **alto**: todos os leitores, pedidos e itens |

**Por que não o 4 agora:** o reuso (`central_vendas_import_pedidos`) já é a
forma "canônica sem duplicação" no nível do pedido: o import novo só aponta
para a linha inalterada. No cenário, ele leva o mês de 34.500 para 4.363
linhas (−87%). Um armazenamento versionado sem import dono resolveria a trava
retenção×vínculos (doc 09), mas exige reescrever a seleção M4 e todos os
leitores de pedidos/itens. Isso é outra missão, de risco maior, e sem ganho
de espaço adicional relevante sobre reuso + arrays.

**Por que arrays e não JSONB:** os arrays ficaram com 62% do tamanho do JSONB,
porque um número dentro do JSONB carrega cabeçalho de 4 B mais o numeric. Além
disso, o `NUMERIC(14,2)` é aplicado **na gravação**, com o mesmo
arredondamento e o mesmo erro de estouro da coluna atual. Um JSONB aceitaria
`12.345` e só arredondaria na leitura. O caminho rápido de leitura do JSONB
(decodificar em JS, 65 ms) existe igual para os arrays (§10, otimização).

**Por que não o relacional enxuto (1b):** tem quase o dobro do tamanho dos
arrays e continua com 6 linhas por pedido. É a alternativa de menor risco se a
equipe preferir manter "uma linha por componente" a qualquer custo.

---

## 5. Prova de conceito

### 5.1 O que foi construído

- `server/scripts/poc-componentes-v2/cenario.js`: cenário determinístico
  alimentado no motor real.
  - ~5% de pedidos multi-item (1–4 itens).
  - Componentes de item e de pedido.
  - Valores ausentes (custo sem base, sale_fee, frete atrasado, receiver.cost)
    e zero legítimo.
  - Envio compartilhado e pack incompleto.
  - Vendas alteradas entre noites: cancelamento, reembolso total/parcial,
    frete que chega no dia seguinte.
  - Full × normal.
- `server/scripts/poc-componentes-v2/layouts.sql` + `bench.cjs`:
  - os 3 modos atuais (completo, enxuto, reuso), cada um em banco descartável;
  - os 3 layouts alternativos montados por **backfill** da tabela atual, o que
    ensaia a migração;
  - medição de tamanho, equivalência linha a linha, leitura, agregação e
    escrita.
- **Implementação real** (por flag, desligada), para provar o contrato com os
  leitores verdadeiros (§6).

### 5.2 Equivalência [medido]

- Os 3 layouts reproduzem **exatamente** a leitura atual (mesmas colunas,
  valores, tipos e ordem) nos 223.199 componentes, em todos os snapshots. Isso
  vale também para a agregação por tipo e para o padrão SQL do Resgate.
- A classificação persistida coincide com a derivada em 100% das linhas.
  Identificação do componente = linha do pedido em 100% (0 divergências).
- Implementação real: `centralVendasPersistenciaEnxuta.postgres.test.js`
  passou de 3 para **5 modos** (completo, enxuto, reuso, **compacto**,
  **reuso_compacto**): **336 verificações OK**.
  - Leitores cobertos, noite a noite: Central (período, `getLatest`,
    detalhe), realizado da Margem, resumo financeiro (`buildPayloadFromRange`),
    Painel de Contas (pedidos, composição, sobreposição) e Cliente 360. Todos
    **idênticos à main**.
  - Inclui uma noite em que a conta sai da lista e grava em linhas (formatos
    misturados no mesmo período).
- `centralVendasComponentesCompactos.postgres.test.js`: **9 casos de borda**,
  banco "linhas" × banco "compacto":
  - arredondamento 12.345 → 12.35, −1.005 → −1.01, −0.005 → −0.01;
  - estouro → 22003 nos dois formatos;
  - NULL × 0;
  - dois `tarifa_venda` no mesmo item;
  - tipo desconhecido → efeito/incluído NULL;
  - `fonte`/`obs` vazias → NULL;
  - pedido sem componente e pedido só com componentes de pedido;
  - mesmo `pedido_id` em duas competências e numa planilha (ordenação entre
    formatos);
  - planilha sempre em linhas;
  - contagem e backup CSV da retenção;
  - CASCADE.

### 5.3 Escrita [medido]

Componentes de um snapshot de 3.000 pedidos (19.568 componentes), em
transação revertida, mediana de 5 a 7 repetições:

| caminho | tempo |
|---|---:|
| **atual**: 1 INSERT por componente (`insertComponente`) | **4.105 ms** |
| atual em lote (mesma tabela, 1 INSERT) | 489 ms |
| relacional enxuto em lote | 220 ms |
| JSONB em lote | 68 ms |
| **arrays, código real** (`montarLinhas` + `gravarCompactos`, dicionário incluso) | **112 ms** |

### 5.4 Tabelas inteiras, teste de 5 modos (12 noites × 40 pedidos/dia + fechamento) [medido]

Todas as tabelas da Central (imports, pedidos, itens, componentes, vínculos,
compactos, dicionário):

| modo | disco | linhas de componente | linhas compactas |
|---|---:|---:|---:|
| completo (main) | 16,71 MB | 21.750 | — |
| enxuto | 10,98 MB | 21.750 | — |
| compacto | 7,14 MB | 2.419¹ | 3.200 |
| reuso | 3,85 MB | 6.165 | — |
| **reuso + compacto** | **2,77 MB** | 390¹ | 955 |

¹ Noite em que a conta saiu da lista de propósito (gravou em linhas), para
provar a leitura de formatos misturados.

Relatório: `componentes-v2/harness_5_modos_padrao.json`. Benchmark dos
layouts: `componentes-v2/bench_layouts_20x150.json`.

---

## 6. Arquitetura recomendada (implementada atrás de flag)

```
central_vendas_pedidos (id) ─┬─< central_vendas_pedido_itens
                             ├─< central_vendas_componentes        (formato antigo: 1 linha/componente, histórico)
                             └─1 central_vendas_pedido_componentes (formato v2: 1 linha/pedido, ON DELETE CASCADE)
                                     codigos INT[]  (4 por componente: tipo, fonte, confiança, obs → dicionário)
                                     valores NUMERIC(14,2)[]   (NULL = ausente)
                                     item_row_ids BIGINT[]     (NULL = componente do pedido)
                                     extras JSONB              (só chaves que as colunas não reproduzem)
                                     formato SMALLINT = 1      (layout + regra de classificação M6 congelada)
central_vendas_componente_textos (id, texto UNIQUE)  — append-only, compartilhado
```

- **Migration manual**: `server/sql/migrations/20261126_central_vendas_pedido_componentes.sql`.
  Aditiva; só cria duas tabelas vazias e não entra no boot.
- **Escrita**: `centralVendasComponentesCompactos.js`, ligada só com
  `CENTRAL_VENDAS_COMPONENTES_COMPACTOS=true` +
  `CENTRAL_VENDAS_COMPONENTES_COMPACTOS_CONTAS=<ids>|*` (ausente = nenhuma)
  e só para imports do Sync (`orders_api` + run). Planilhas manuais continuam
  em linhas.
  - Qualquer componente que a linha antiga representaria diferente mantém o
    **import inteiro** no formato antigo: sem pedido, item sem linha, valor não
    numérico/NaN/Infinity, tipo ou confiança inválidos. Nunca há aproximação.
  - O dicionário é gravado **antes** da transação do import (autocommit,
    ordem fixa). Nenhuma linha nova fica travada durante uma gravação longa,
    o que importa por causa do histórico de 40P01.
  - O import inteiro é gravado em 1 INSERT.
- **Leitura**: todos os leitores do repositório passam por
  `consultarComponentes`.
  - Sem a tabela, executa **a consulta antiga, literal**.
  - Com a tabela, executa um `UNION ALL` dos dois formatos, no mesmo formato
    de linha e na mesma ordem. O desempate é (linha do pedido, id antigo |
    posição): a ordem de gravação, comparável entre formatos.
  - Os leitores entendem os dois formatos **sempre**. Desligar a flag nunca
    deixa import incompleto.
- **Regra de classificação congelada** (`REGRA_FORMATO_1`): um teste a compara
  com o ledger M6. Se o ledger mudar, o teste falha, e a mudança exige
  `formato = 2`. Sem isso, o histórico seria reclassificado na leitura.
- **Retenção** (`centralVendasRetencaoRepository`): conta os compactos por
  import (via pedido). O backup CSV antes do DELETE leva as linhas compactas e
  o dicionário. O DELETE já os remove por CASCADE.
- **Unificação** (`centralReferenceScope`): PRESERVE_BY_PARENT pelo pedido.
- **Raio-X**: as duas tabelas estão no inventário.

---

## 7. Preservação funcional — checklist

| exigência | como | evidência |
|---|---|---|
| composição por pedido e item | posição k = componente; `item_row_ids[k]` | 336 + 9 verificações |
| valor, fonte, obs, confiança | arrays + dicionário | linha a linha idêntica |
| escopo / efeito / incluído | derivados pela regra congelada do formato 1 | teste de regra + 100% coincidente |
| repetidos do mesmo tipo | posições distintas | caso `tarifa_venda` ×2 |
| zero × ausente × desconhecido | NUMERIC NULL × 0; tipo fora da regra → NULL | casos de borda |
| frete compartilhado, packs, claims, devoluções, reembolsos | mesmos componentes do motor | cenário + teste de 5 modos |
| custos, impostos, tarifas, ajustes | idem; tipos novos funcionam (dicionário) | `ajuste_desconhecido` |
| histórico e versões | snapshots intactos; formato antigo continua lido | formatos misturados |
| imports manuais e legados | planilha sempre em linhas | teste |
| filtros, KPIs, gráficos, ABC, exportação, drawer | mesmo contrato (`buildPedidoContrato`) | resumo financeiro e contrato idênticos |
| Financeiro, Cliente 360, Margem, Painel | mesmas funções do repositório | teste de 5 modos |
| fórmulas financeiras | **nenhuma alterada** | diff restrito a persistência/leitura |

---

## 8. Riscos

| risco | severidade | mitigação |
|---|---|---|
| **Resgate** (`vendasPorItem`) lê componentes por SQL direto: não enxerga compactos (perde amostras de frete) | **alta, bloqueia o piloto** | adaptar antes do piloto; SQL pronto na §12. Mesmo leitor também ignora pedidos **reusados** (`i.import_id = ANY`): achado pré-existente, §13 |
| Leitura do período via SQL +40% (154 → 227 ms / 3.000 pedidos) | média | aceitável no piloto; otimização medida (decodificar em JS: 65 ms) na implementação definitiva |
| Dicionário crescer com textos dinâmicos | baixa (22 textos hoje) | monitorar `COUNT(*)`; obs hoje são frases fixas do motor |
| Regra M6 mudar | média | `formato` + teste que falha |
| Scripts pontuais (`sentinel-e0-paridade`, auditoria de frete pack) não veem compactos | baixa | documentado; só históricos |
| Unificação com a tabela presente | baixa | testes de unificação passam sem a migration; rodar com ela aplicada antes do piloto |
| Ordem bruta entre dois imports gravados em transações intercaladas | desprezível | só a ordem da lista crua; contrato agrupa por linha do pedido |
| Espaço só volta com VACUUM FULL / pg_repack | operacional | fase 4, janela própria |

---

## 9. Plano de migração (incremental e reversível)

| fase | o quê | escrita em produção | reversão |
|---|---|---|---|
| F0 | esta branch: código + testes; flags desligadas; migration só em arquivo | nenhuma | — |
| F1 | medição read-only (`central_vendas_componentes_v2_medicao.sql`) + **paridade read-only** por conta (`scripts/central-vendas-componentes-paridade.js`: codifica e decodifica em memória, compara campo a campo e o contrato) | nenhuma | — |
| F2 | adaptar Resgate (§12); revisão de código; merge e deploy com flags desligadas | nenhuma | revert do código |
| F3 | **migration 20261126** (2 tabelas vazias) — com autorização | DDL aditivo | `DROP` das 2 tabelas (enquanto vazias) |
| F4 | piloto: `..._COMPACTOS=true`, `..._CONTAS=<1 conta>`; de preferência conta já com reuso; acompanhar `metadata_json.porCompetencia[].persistencia.componentes` e paridade diária | imports novos da conta | flag off → próximos imports em linhas; os compactos continuam lidos; **nunca dropar a tabela depois de gravar** |
| F5 | expandir por lotes de contas → `*` | idem | idem |
| F6 | **histórico** (opcional, autorização explícita): backfill import a import (mesmo SQL do `layouts.sql`), paridade por import, backup CSV, DELETE das linhas antigas, depois `pg_repack` | sim | backup CSV + restauração |

Nenhum dado histórico é removido antes da F6. O ganho de F4/F5 é **parar o
crescimento**; a F6 é a que devolve espaço.

---

## 10. Testes

| teste | o quê | resultado |
|---|---|---|
| `tests/centralVendasComponentesCompactos.test.js` (novo, unitário) | regra congelada, flag/conta/fonte, elegibilidade, montagem, SQL de união, existência | 8 OK |
| `tests/centralVendasComponentesCompactos.postgres.test.js` (novo, PG) | casos de borda §5.2 | 9 OK |
| `tests/centralVendasPersistenciaEnxuta.postgres.test.js` (estendido) | 5 modos × todos os leitores, noite a noite | 336 OK |
| retenção (`RetencaoPostgres` 11, `RetencaoVolume` 3, `TravaReuso` 25), `ReusoIsolamentoContas` 29, `pgEstabilidadeBoot` 16, unificação (68 cenários) | regressão PG | OK |
| suíte unitária completa (433 arquivos) | regressão | só as **4 falhas preexistentes da main** (basesTiktok, designStudioWorkspace, meliAnunciosOrdenacaoGlobal, mlTokenService) |
| 18 bancos falsos de testes | passam a responder também à pergunta de catálogo da tabela compacta (`ok: false`) | — |

PG local: `CENTRAL_VENDAS_PG_TEST_DATABASE_URL=postgres://vf@127.0.0.1:<porta>/postgres`.
Benchmark: `POC_DATABASE_URL=... node server/scripts/poc-componentes-v2/bench.cjs`.

**Otimização prevista para a implementação definitiva (não feita aqui):**
- ler os arrays crus e decodificar em JS, com o dicionário em cache (é
  append-only);
- manter a ordenação de `pedido_id`/`item_id` no SQL (collation do banco).

O protótipo JSONB medido nesse modo leu o período em 65 ms, contra 154 ms do
formato atual.

---

## 11. Condições do GO

1. Rodar `central_vendas_componentes_v2_medicao.sql` com `raiox_ro`. Confirmar
   em dado real:
   - 0 divergência de identificação/classificação;
   - `payload_com_extras` (Sync);
   - textos distintos de `obs`;
   - fator de cópias por pedido.
2. `central-vendas-componentes-paridade.js` com `PARIDADE_OK` na conta piloto
   (e numa conta grande).
3. Adaptar `resgateLeituraRepository.vendasPorItem` (§12) antes de ligar a
   escrita para qualquer conta usada pelo Resgate.
4. Revisão independente (Codex) do diff do repositório e da retenção.
5. Decidir a ordem: **reuso primeiro** (resolve `pedidos` + `itens`, 1,78 GB)
   e compacto em seguida na mesma conta, ou os dois juntos no piloto.

---

## 12. Resgate — SQL compatível (para a F2)

Substitui a subconsulta de `frete_seller` em `vendasPorItem`, só quando
`tabelaCompactaDisponivel(db)`:

```sql
COALESCE(
  (SELECT c.valor FROM central_vendas_componentes c
    WHERE c.item_row_id = i.id AND c.tipo = 'frete_seller' AND c.fonte = 'shipments_api' LIMIT 1),
  (SELECT u.valor FROM central_vendas_pedido_componentes pc
     CROSS JOIN LATERAL unnest(pc.valores, pc.item_row_ids) WITH ORDINALITY u(valor, item_row_id, ordem)
     JOIN central_vendas_componente_textos tt ON tt.id = pc.codigos[4*u.ordem-3] AND tt.texto = 'frete_seller'
     JOIN central_vendas_componente_textos tf ON tf.id = pc.codigos[4*u.ordem-2] AND tf.texto = 'shipments_api'
    WHERE pc.pedido_row_id = i.pedido_row_id AND u.item_row_id = i.id
    ORDER BY u.ordem LIMIT 1)) AS frete_seller
```

Equivalência deste padrão já medida no benchmark (`resgateIdentico`).

---

## 13. Achados colaterais (não corrigidos, fora do escopo)

- `resgateLeituraRepository.vendasPorItem` filtra `i.import_id = ANY(...)`.
  Com o reuso ligado, **ignora os pedidos vinculados**: o Resgate veria menos
  vendas na conta. Precisa usar `centralVendasPedidosCompartilhados`
  (pré-existente, independe desta branch).
- O inventário do Raio-X lista `central_vendas_componentes` como consumida pelo
  Painel de Contas; o código atual do Painel não lê componentes.
- Escrita atual linha a linha: 1 INSERT por componente. Mesmo sem mudar o
  formato, um INSERT em lote derruba de 4,1 s para 0,5 s por snapshot [medido].
