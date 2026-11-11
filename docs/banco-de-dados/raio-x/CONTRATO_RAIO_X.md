# Entrega 4 — Raio-X do Cliente (contrato v1)

Commit `7e1eb006`. Serviço: `server/services/raioX/raioXClienteService.js`
(`gerarRaioXCliente`); registro: `raioXRegistro.js`; CLI:
`server/scripts/raio-x-cliente.js`; teste: `tests/raioXCliente.postgres.test.js`
(23 verificações em PG 18 local). Exemplo (dados sintéticos):
`exemplo_raio_x_rapido.json`.

Sem rota HTTP nem tela nesta missão (rota = decisão de permissão). A futura tela
chama o serviço por uma rota admin GET.

## Garantias

- `BEGIN READ ONLY` … `ROLLBACK`; nunca escreve.
- `statement_timeout` por consulta (padrão 3 s) via SAVEPOINT: estouro vira
  `status: "timeout"` só naquele bloco. Orçamento total padrão 20 s.
- Sem varredura do banco: filtros por `cliente_id`/`cliente_slug`/conta ou por
  `import_id`/`sync_run_id` (índices existentes). Tabelas filhas (pedidos, itens,
  componentes, charges, sources) só no modo `detalhado`.
- Nunca seleciona `access_token`/`refresh_token` (teste garante); não loga dados.
- Tamanho por cliente = **estimativa**: linhas do cliente × (`pg_total_relation_size`
  / `reltuples`). Campo `estimativaTamanho.exato = false`.

## Entrada

```js
gerarRaioXCliente({ clienteId } | { clienteSlug }, { detalhado = false, timeoutMs = 3000, orcamentoMs = 20000, db })
```

## Saída (campos de topo)

| Campo | Conteúdo |
|---|---|
| `ok`, `versao` (`raio-x-cliente/v1`), `geradoEm`, `duracaoMs`, `modo`, `limites` | metadados |
| `cliente` | id, nome, slug, ativo |
| `contas[]` | id, marketplace, nome, slug, `externalAccountId` (seller), principal, ativa |
| `grants.mercadoLivre[]` | id, `mlUserId`, principal, status, falhas de refresh, substituído em, expira em (sem token) |
| `tabelas[]` | por tabela do registro: domínio, módulos, classe, origem, `manual`, `reconstruivel`, `identidade` usada, `status` (`ok`/`nao_existe`/`sem_identidade`/`so_no_modo_detalhado`/`timeout`/`erro`), `linhas`, `bytesEstimados`, `periodo {coluna,de,ate}`, `ultimaEscrita` |
| `centralVendas` | `totais` + `porContaCompetencia[]`: vigente (mesma seleção canônica dos leitores), `copiasSuperadas`, `pedidosEmCopiasSuperadas`, `manuaisProtegidos[]`, `candidatesNaoPublicados[]` |
| `syncs` | último run por conta (status, completude, período, erro) + agregados (runs, falhas, runs 7 d, duração mediana) |
| `mercadoPago.porConta[]` | linhas, payments distintos, `copiasPorPayment`, última coleta |
| `inconsistencias[]` | `codigo`, `descricao`, `ocorrencias`: import com conta de outro cliente; slug divergente; import sem conta em cliente com 2+ contas; conta ML sem grant; grant sem conta; run preso > 6 h |
| `fluxo[]` | origem → tabela → módulos (só tabelas com dados) |
| `resumo` | tabelas com dados, linhas, bytes estimados, tabelas manuais com dados, blocos com timeout |

## Como rodar

```bash
RAIO_X_DATABASE_URL=postgres://... node server/scripts/raio-x-cliente.js --cliente <slug|id> [--detalhado] --saida rx.json
```

Não usa `server/.env`. **Use este CLI só contra banco LOCAL**: a validação de destino dele ainda confia em `new URL().hostname` (`?host=` contorna). Para banco remoto use `npm run raio-x -- --real --autorizo-host=<host>` (ver `RAIO_X_VISUAL.md`). Contra produção: leitura, mas exige autorização (carga no banco).

## Limitações conhecidas

- Registro cobre as tabelas com dado de cliente do inventário; tabelas novas
  precisam ser adicionadas a `raioXRegistro.js`.
- `centralVendas` lê `central_vendas_imports` por `cliente_id OR cliente_slug`
  (a tabela não tem índice em `cliente_id`; é pequena — milhares de linhas).
- Contagem de pedidos em cópias superadas usa `resumo_json.pedidosTotal` (declarado), não conta linhas.
