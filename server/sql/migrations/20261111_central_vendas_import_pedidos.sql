-- server/sql/migrations/20261111_central_vendas_import_pedidos.sql
--
-- Reuso de pedidos inalterados entre imports do Sync (Central de Vendas).
--
-- Um import em modo reuso grava SÓ os pedidos novos/alterados como linhas
-- próprias (import_id = ele) e referencia os inalterados — linhas já gravadas
-- por um import anterior da MESMA tupla (cliente, conta, marketplace,
-- competência) — por esta tabela. Pedidos do import = linhas próprias ∪
-- linhas vinculadas. Imports sem vínculo (todos os existentes) continuam
-- exatamente como hoje.
--
-- Integridade:
--   - import_id → ON DELETE CASCADE: apagar o import que REFERENCIA só remove
--     os vínculos dele.
--   - pedido_row_id → NO ACTION (padrão): apagar o import DONO de linhas ainda
--     referenciadas por outro import FALHA (foreign_key_violation) — a
--     retenção nunca consegue apagar um pedido que um import vigente usa. Um
--     DELETE que leve dono e referenciador juntos (purge do cliente) passa,
--     porque NO ACTION é checado no fim do comando.
--
-- Aditiva e idempotente. NÃO é aplicada no boot (não está em
-- central_vendas_schema.sql): rodar manualmente, com autorização, ANTES de
-- ligar CENTRAL_VENDAS_SYNC_REUSO_PEDIDOS. Sem esta tabela o código ignora o
-- reuso (grava como antes) e os leitores não consultam vínculos.
--
-- Rollback (só se nenhum import usa vínculos — ver consulta abaixo):
--   SELECT COUNT(*) FROM central_vendas_import_pedidos;  -- precisa ser 0
--   DROP TABLE IF EXISTS central_vendas_import_pedidos;

CREATE TABLE IF NOT EXISTS central_vendas_import_pedidos (
  import_id     BIGINT NOT NULL REFERENCES central_vendas_imports(id) ON DELETE CASCADE,
  pedido_row_id BIGINT NOT NULL REFERENCES central_vendas_pedidos(id),
  PRIMARY KEY (import_id, pedido_row_id)
);

-- Checagem da FK ao apagar pedidos (retenção/purge) e "quem usa esta linha".
CREATE INDEX IF NOT EXISTS idx_central_vendas_import_pedidos_pedido_row
  ON central_vendas_import_pedidos (pedido_row_id);
