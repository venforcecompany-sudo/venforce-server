# Checklist — publicar `feat/pg-reorganizacao` com TODAS as flags desligadas

Nada aqui foi executado em produção. Cada passo marcado **[autorização]** precisa
de aprovação própria. Publicar o código não muda comportamento: as três flags são
opt-in e a migration não está no boot.

## 0. Antes de abrir o PR (local, já verificado)

- [x] Worktree limpa; 12 commits sobre `origin/main` 27e4bbb1; sem upstream (nada no remoto).
- [x] Unitários: `centralVendasPersistenciaEnxuta` (56), `centralVendasCliente360Adapter` (76), `marginRealizado*`, `painelContas*`, `cliente360*`.
- [x] PG18 local: três versões main × enxuta × reuso (175), isolamento entre contas (13), Raio-X (23), unificação (5 arquivos, 68 cenários).
- [x] Migration: idempotente (2×), rollback e reaplicação testados em banco descartável.
- [x] Checagem da tabela de vínculos: erro propaga, negativo nunca cacheado (`centralVendasPedidosCompartilhadosExistencia.test.js`, 20 verificações).
- [ ] Rebase/merge com a `main` atual e rerodar a suíte (`node --test`/scripts `tests/*.test.js`): esperado = as 4 falhas preexistentes (basesTiktok, designStudioWorkspace, meliAnunciosOrdenacaoGlobal, mlTokenService).

## 1. Estado de produção ao publicar (flags ausentes)

| Variável | Valor ao publicar | Efeito |
|---|---|---|
| `CENTRAL_VENDAS_MP_PAYMENTS_COLETA_ENABLED` | ausente | coleta MP continua **ligada** (igual hoje) |
| `CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA` | ausente | grava no formato completo (igual hoje) + medição em `metadata_json` |
| `CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS` / `_CONTAS` | ausentes | nenhuma conta em reuso |

Único efeito visível com tudo desligado: `metadata_json.porCompetencia[].persistencia`
(bytes de JSON e duração) nos runs, e uma consulta `to_regclass` barata por leitura
(positivo em cache permanente, negativo por 60 s) enquanto a tabela não existir.

## 2. Publicação

- [ ] **[autorização]** merge do PR e deploy.
- [ ] Verificar: app sobe; Painel de Contas, Central de Vendas, Cliente 360, Margem e Sentinel abrem para 1 cliente conhecido; sync da noite seguinte conclui.
- [ ] Verificar que o run gravou `persistencia.formato = "completo"` e `gravados` coerente.
- Reversão: redeploy da versão anterior. Não há dependência de schema.

## 3. Migration (só quando for ligar o reuso)

- [ ] **[autorização]** aplicar manualmente `server/sql/migrations/20261111_central_vendas_import_pedidos.sql` (1 tabela + 1 índice, aditiva, sem lock longo, não toca dados existentes).
- [ ] Conferir: `SELECT to_regclass('central_vendas_import_pedidos');` não nulo.
- Rollback (só se nenhum import usa vínculos):
  `SELECT COUNT(*) FROM central_vendas_import_pedidos;` → 0, então `DROP TABLE IF EXISTS central_vendas_import_pedidos;`.
  Se houver vínculos, **não** dropar: tirar as contas de `_CONTAS` (leitores seguem entendendo os vínculos).

## 4. Rollout das flags (cada passo depois de validar o anterior)

1. [ ] **[autorização]** `CENTRAL_VENDAS_SYNC_PERSISTENCIA_ENXUTA=true` — validar `persistencia.diff` e leitores em 1–2 contas conhecidas.
2. [ ] **[autorização]** migration (seção 3) e restart.
3. [ ] **[autorização]** `CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS=true` + `CENTRAL_VENDAS_SYNC_REUSO_CONTAS=<1–2 contas>`.
   Validar na manhã seguinte: `gravados.vinculos > 0`, `gravados.pedidos ≈ novos+alterados`, Painel/Central/Margem/Cliente 360/fechamento da conta idênticos ao dia anterior.
4. [ ] Ampliar a lista; só depois `*`.
5. [ ] Decisão separada: `CENTRAL_VENDAS_MP_PAYMENTS_COLETA_ENABLED=false`.

Reversão de qualquer passo: remover a variável (ou a conta da lista). Imports já gravados continuam legíveis.

## 5. Restrições que continuam valendo

- **Retenção (manual e auto) PROIBIDA para contas com imports vinculados** (`09_RETENCAO_X_REUSO_ESPECIFICACAO.md`). Não ligar `CENTRAL_VENDAS_RETENCAO_AUTO` enquanto: (a) as etapas S1–S4 da retenção não estiverem na `main` e (b) a trava de planilhas legacy não estiver na main (bloqueio 3). Sem a guarda, a FK evita perda de dado, mas o run inteiro para e o export não leva os vínculos.
- **Piloto do reuso (seção 4, passo 3) só com a Etapa 1 da retenção (S3) na `main`.**
- Leituras em produção (`mp_redundancia.sql`, relatório de armazenamento, Raio-X) exigem autorização e janela fora do pico.
- Nenhuma escrita/DELETE/DROP/VACUUM FULL em produção é parte deste PR.
