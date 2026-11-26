-- server/sql/migrations/20261126_central_vendas_pedido_componentes.sql
--
-- Componentes financeiros COMPACTOS da Central de Vendas (formato v2).
-- Migration MANUAL (fora do central_vendas_schema.sql do boot), aditiva e
-- reversível: só cria duas tabelas novas e vazias. NÃO toca
-- central_vendas_componentes nem nenhuma linha existente.
--
-- Uma linha POR PEDIDO (central_vendas_pedidos.id) com a composição inteira em
-- arrays tipados, na ordem de gravação (= a ordem do antigo `id`):
--   valores[k]       NUMERIC(14,2) — o mesmo tipo/arredondamento da coluna
--                    `valor` antiga; NULL = ausente (≠ 0)
--   item_row_ids[k]  central_vendas_pedido_itens.id do componente de item;
--                    NULL = componente do pedido (escopo 'pedido')
--   codigos[4k-3..4k] ids do dicionário: tipo, fonte (0 = NULL), confianca,
--                    obs (0 = NULL)
--   extras           {"<k>": {...}} só para chaves que as colunas antigas não
--                    reproduzem (persistência enxuta); NULL quando não há
--   formato          1 = este layout + classificação M6 de
--                    centralVendasComponenteLedger (escopo/efeito/
--                    incluido_no_resultado derivados na leitura). Mudar a
--                    regra de classificação EXIGE formato novo.
-- O que a linha antiga repetia e a linha do pedido já guarda (import_id,
-- cliente_id, cliente_slug, marketplace, competencia, pedido_id, created_at,
-- updated_at) e item_id (linha do item) é recuperado na leitura.
--
-- Ciclo de vida = o do pedido (ON DELETE CASCADE): retenção, purge e reuso de
-- pedidos (central_vendas_import_pedidos) seguem funcionando sem mudança.
-- O dicionário é append-only e compartilhado (só textos de motor: tipo, fonte,
-- confiança e observação); nunca é apagado pela retenção nem pelo purge.
--
-- Rollback (antes de qualquer gravação no formato v2): DROP das duas tabelas.
-- Depois que houver gravação v2: NÃO dropar — desligar a flag de escrita
-- (CENTRAL_VENDAS_COMPONENTES_COMPACTOS) e manter as tabelas; os leitores
-- entendem os dois formatos.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS central_vendas_componente_textos (
  id SERIAL PRIMARY KEY,
  texto TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PK `id` própria (e não pedido_row_id): a Unificação Clientes×Contas
-- (centralReferenceScope.centralPolicyErrors) exige PK de coluna única `id`
-- em toda tabela da Central e usa (id, xmin) no fingerprint do subgrafo;
-- sem isso a tabela viraria CENTRAL_POLICY_DRIFT e bloquearia a unificação.
-- Uma linha por pedido continua garantida pelo UNIQUE (pedido_row_id), que
-- também é o índice das leituras e do CASCADE.
CREATE TABLE IF NOT EXISTS central_vendas_pedido_componentes (
  id BIGSERIAL PRIMARY KEY,
  pedido_row_id BIGINT NOT NULL UNIQUE REFERENCES central_vendas_pedidos(id) ON DELETE CASCADE,
  formato SMALLINT NOT NULL DEFAULT 1,
  codigos INT[] NOT NULL,
  valores NUMERIC(14,2)[] NOT NULL,
  item_row_ids BIGINT[] NOT NULL,
  extras JSONB,
  CONSTRAINT central_vendas_pedido_componentes_formato_chk CHECK (formato = 1),
  CONSTRAINT central_vendas_pedido_componentes_dims_chk CHECK (
    cardinality(valores) >= 1
    AND cardinality(item_row_ids) = cardinality(valores)
    AND cardinality(codigos) = 4 * cardinality(valores)
    AND array_ndims(valores) = 1 AND array_ndims(item_row_ids) = 1 AND array_ndims(codigos) = 1
  )
);

COMMIT;
