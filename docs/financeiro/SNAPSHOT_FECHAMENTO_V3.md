# Financeiro V3 — Snapshot de fechamento (contrato atual e desenho escolhido)

Data da auditoria: 13/10/2026 · ref de partida: `origin/main` @ 936fc7d5 (PR #250 já mergeado).

## 1. Contrato ATUAL (antes desta evolução)

| Peça | Onde | O que faz hoje |
|---|---|---|
| Processar | `POST /fechamentos/financeiro` (`controllers/fechamentosFinanceiroController.js`) | Stateless. Multipart (sales, costs, ordersAll, onhold) → motor → `{ summary, detailedRows, unmatchedIds, unmatchedCosts, competencia, costsSource, costsBase, excelBase64, … }`. Nada é persistido (exceto a caixa-preta de incidente, quando dispara). |
| Salvar | `POST /entregas-cliente` (`services/entregasClienteService.js`) | O **frontend** monta `payload_json` (`frontend-react/src/utils/fechamentoPayload.js`) e o servidor grava como veio. |
| Limite de 50 | `fechamentoPayload.js:73` (V3) e `Portal/financeiro.js:835` (legado) | `detailedRows.slice(0, 50)`. O fechamento salvo só tem 50 linhas; o resto é perdido. |
| Duplicidade | `encontrarEntregaDaCompetencia` | 409 `ENTREGA_JA_EXISTE`. `substituir:true` **atualiza no lugar** um rascunho sem token, ou cria uma entrega nova quando a existente já teve link. |
| Imutabilidade | `atualizarEntrega` | Entrega com `token_publico` → 409 `ENTREGA_PUBLICADA_IMUTAVEL` para tipo/título/período/payload/cliente/conta. |
| Publicação | `publicarEntrega` / `despublicarEntrega` | `token_publico` (estável por linha), `publicado`, `published_at` (COALESCE: guarda a 1ª). Sem `publicado_por`. |
| Leitura pública | `GET /public/entregas/:token` → `Portal/relatorio-publico.js` | Reconstrói a apresentação de `payload_json.summary` + `detailedRows` + `unmatchedIds` + `metadados`. |
| "Fechamento salvo" | `GET /financeiro/:cliente` (`services/financeiroVisaoService.js`) | Escolhe 1 entrega da competência (conta > publicada > recente > id) e devolve só `payload_json.cards`. |
| Histórico | `HistoricoTab.jsx` | 12 meses × status da entrega da conta (sem revisões, sem números). |
| Arquivos | `fechamento_incidentes` + `fechamento_incidente_arquivos` (BYTEA, TTL 15 dias) | Só na caixa-preta, só quando há incidente, e temporário. Não existe storage persistente de arquivos de fechamento (sem S3/R2). |
| Auditoria | `activity_logs` (`services/activityLogService.registrarLog`) | Tabela genérica (acao + detalhes TEXT), nunca lança. Reutilizável. |
| Schema | `services/schema/schemaEnsure.js` | Migrations versionadas em `sql/migrations/*.sql`; `auto:true` = aplicada no boot por `ensure*`, serializada por `pg_advisory_xact_lock`, idempotente e aditiva. |

### `detailedRows` — os 3 formatos reais (não há contrato único)

- **MELI** (`meliFinanceiroService`, agregado por anúncio): `# de anúncio`, `Título do anúncio`, `Unidades`, `Venda Total`, `Total (BRL)`, `Preço de custo`, `Preço de custo total`, `Imposto`, `LC`, `MC`, `Cobertura de custo`.
- **Shopee Performance** (por item/model): `ID`, `ID Model`, `Produto`, `Unidades (Pedido pago)`, `Vendas (Pedido pago) (BRL)`, `Custo`, `Imposto`, `LC`, `LC POR ANÚNCIO`, `MC`.
- **Shopee Order.all** (por linha de pedido): `ID do pedido`, `Produto`, `SKU`, `Quantidade`, `Receita bruta`, `Receita líquida`, `CMV`, `Imposto`, `Match de custo`, `ID resolvido pela ponte`, `LC`, `MC`, `Cobertura de custo`, `Status do pedido`.
- **TikTok** (fora da V3): mesmo envelope `{summary, detailedRows}`. O snapshot não depende do formato.

A leitura desses formatos para a tela é `frontend-react/src/utils/financeiro/produtos.js` (`normalizarLinhaProduto`). O motor não é tocado.

### Volume estimado

60 contas ativas × 12 meses × ~2 revisões × ~1.000 linhas (MELI agrega por anúncio; Shopee Order.all é por linha de pedido e chega a ~10–20 mil em conta grande) ≈ **1,5 a 3 milhões de linhas por ano**. Linha ≈ 0,5–1 KB em JSONB. Isso dá uma tabela relacional normal, paginada por `(snapshot_id, ordem)`. Não é caso de particionamento.

## 2. Desenho escolhido (mínimo que traz valor agora)

```
fechamento_snapshots (1 linha por revisão: conta × competência × revisão)
  └── fechamento_snapshot_itens (TODAS as linhas do motor; paginadas no backend)
entregas_cliente.snapshot_id  (apresentação → aponta para a revisão)
activity_logs                 (eventos: snapshot criado, entrega publicada/despublicada/editada)
```

**Não criados, de propósito:**
- `fechamento_snapshot_arquivos`: o manifesto tem no máximo 4 arquivos por revisão e nunca é consultado entre revisões. Fica em `arquivos_json`, uma coluna do snapshot.
- `fechamento_snapshot_eventos`: `activity_logs` já cumpre esse papel.
- Tabela de publicação: a entrega com `token_publico` já é imutável, então `entrega.snapshot_id` + `token_publico` + `published_at` **é** a publicação.
- Configuração por conta: o padrão de cada conta passa a ser lido do último snapshot dela (base, arquivos e ajustes usados). Não há tabela nova.
- Storage de binários: só manifesto (sha256, tamanho, nome, mime). O próximo passo, com storage, fica documentado abaixo.

### Integridade: o "selo" do processamento

O processamento continua stateless. A resposta de `POST /fechamentos/financeiro` ganha um bloco aditivo `processamento`:

```
processamento: { versao, processadoEm, processadoPor, arquivos[manifesto], custos{linhas, sha256}, ajustes, selo }
```

`selo = HMAC-SHA256(chave derivada do JWT_SECRET, JSON canônico de {contexto, summary, detailedRows, unmatched*, competencia, origem dos custos, ajustes, arquivos})`.

Ao salvar, o frontend devolve esses campos como recebeu. O servidor recalcula o selo e só grava se ele bater. Resultado: um snapshot é **sempre** a saída do motor, nunca um número digitado ou alterado no navegador. Isso dispensa gravar no banco a cada processamento, que geraria lixo e exigiria um job de limpeza.

### Revisão

`revisao` = MAX + 1 por (conta, competência), calculada dentro de uma transação com `pg_advisory_xact_lock(conta, competência)`. `UNIQUE (cliente_conta_id, periodo, revisao)` é a última barreira. Contas diferentes nunca compartilham numeração. Revisão nunca é reaproveitada.

### Imutabilidade

O repositório só tem INSERT e SELECT. Além disso, um trigger `BEFORE UPDATE` recusa qualquer UPDATE em `fechamento_snapshots` e `fechamento_snapshot_itens`. DELETE só acontece por CASCADE do purge de cliente.

### Entrega × snapshot

- `entregas_cliente.snapshot_id` é NULLABLE: entrega antiga = NULL e segue funcionando pelo `payload_json`.
- Ao gravar com `snapshot_id`, o servidor confere que o snapshot é do **mesmo cliente, conta e competência** e que `payload_json.summary` é **igual** ao summary do snapshot (409 `SNAPSHOT_DIVERGENTE`). A apresentação (destaques e prioridades) continua editável e não toca nos números.
- `snapshot_id` entra na lista de campos históricos: entrega com link nunca troca de revisão.
- Trocar a revisão de um rascunho só acontece pelo "Substituir" explícito, que é registrado.
- `payload_json` continua com as 50 linhas de amostra para o relatório público, que não muda. A base histórica completa é o snapshot.

### Estados na tela

```
Processamento atual · ainda não salvo          (resultado em memória)
Revisão v2 · salva em 13/10 14:30 · Publicado: v1   (histórico)
```

O bloco histórico é renderizado com os mesmos componentes do resultado ao vivo, mas em modo leitura: sem correção de custo e com produtos paginados no servidor.

## 3. Compatibilidade

- Entrega sem `snapshot_id`: fallback para o bloco atual (`payload_json.cards`), rotulado "fechamento anterior às revisões".
- Legado (`Portal/financeiro.js`): continua igual. Ele ignora o bloco `processamento` e o `snapshot_id`.
- Sem backfill. Entregas antigas não ganham snapshot automaticamente. Um backfill possível no futuro só teria as 50 linhas, por isso ele não é feito.

## 4. TikTok (depois)

O snapshot não depende do marketplace: o `marketplace` está no CHECK (`meli|shopee|tiktok`) e os itens guardam a linha crua. Para fechar TikTok na V3, falta: o seletor de Base TikTok na V3, o formato `tiktok` em `normalizarLinhaProduto` (para status e filtros) e `pendingRows` (Onhold) em `diagnostico_json`, que o snapshot já guarda.

## 5. Arquivos: próximo passo com storage

Hoje fica guardado o manifesto `{tipo, nome_original, sha256, tamanho, mime_type, origem:"upload"}`. Com um storage (R2/S3), basta acrescentar `storage_key` em cada entrada do manifesto e enviar o buffer no processamento. Mas isso exige decisão humana sobre custo, retenção e LGPD, então não foi feito.
