-- server/scripts/poc-componentes-v2/layouts.sql
--
-- PoC (SÓ PostgreSQL local, dados sintéticos). Três layouts físicos
-- alternativos para central_vendas_componentes, todos com o MESMO conteúdo
-- lógico, montados por backfill a partir da tabela atual (o que também ensaia
-- a migração). Nenhum deles guarda o que já é recuperável pela linha do pedido:
--   import_id, cliente_id, cliente_slug, marketplace, competencia, pedido_id,
--   created_at, updated_at  → central_vendas_pedidos (mesma transação, mesmos valores)
--   item_id                 → central_vendas_pedido_itens via item_row_id
--   escopo/efeito/incluido_no_resultado → função pura de (tipo, item_id)
--                             (classificarComponenteFinanceiro)
--   payload_json            → só os extras que as colunas não reproduzem
--                             (persistência enxuta); nenhum leitor o lê.
-- Textos repetidos (tipo, fonte, confianca, obs) viram id de um dicionário
-- append-only. `ordem` preserva a ordem de inserção (o antigo `id`).

CREATE TABLE IF NOT EXISTS cv_poc_textos (
  id SERIAL PRIMARY KEY,
  texto TEXT NOT NULL UNIQUE
);

-- (2) JSONB compacto por pedido: [[tipo, valor, fonte, confianca, obs, item_row_id], ...]
CREATE TABLE IF NOT EXISTS cv_poc_comp_jsonb (
  pedido_row_id BIGINT PRIMARY KEY REFERENCES central_vendas_pedidos(id) ON DELETE CASCADE,
  componentes JSONB NOT NULL,
  extras JSONB
);

-- (1b) Relacional enxuto: uma linha por componente, só colunas tipadas.
CREATE TABLE IF NOT EXISTS cv_poc_comp_slim (
  pedido_row_id BIGINT NOT NULL REFERENCES central_vendas_pedidos(id) ON DELETE CASCADE,
  item_row_id BIGINT,
  tipo_id INT NOT NULL,
  fonte_id INT,
  confianca_id INT NOT NULL,
  obs_id INT,
  ordem SMALLINT NOT NULL,
  valor NUMERIC(14,2),
  extras JSONB,
  PRIMARY KEY (pedido_row_id, ordem)
);

-- (3) Híbrido tipado por pedido: valores NUMERIC(14,2)[] + códigos INT[]
-- (4 por componente: tipo, fonte, confianca, obs; 0 = NULL) + item_row_ids.
CREATE TABLE IF NOT EXISTS cv_poc_comp_arrays (
  pedido_row_id BIGINT PRIMARY KEY REFERENCES central_vendas_pedidos(id) ON DELETE CASCADE,
  codigos INT[] NOT NULL,
  valores NUMERIC(14,2)[] NOT NULL,
  item_row_ids BIGINT[] NOT NULL,
  extras JSONB
);

-- ---------------------------------------------------------------------------
-- Backfill (o MESMO para os três): ordem = posição pelo id antigo dentro do pedido.
-- extras = payload_json sem as chaves que as colunas já reproduzem (no formato
-- completo, o payload é uma cópia do objeto; no enxuto, já são só os extras).
-- ---------------------------------------------------------------------------
INSERT INTO cv_poc_textos (texto)
SELECT DISTINCT t FROM (
  SELECT tipo AS t FROM central_vendas_componentes
  UNION SELECT fonte FROM central_vendas_componentes WHERE fonte IS NOT NULL
  UNION SELECT confianca FROM central_vendas_componentes
  UNION SELECT obs FROM central_vendas_componentes WHERE obs IS NOT NULL
) s
ON CONFLICT (texto) DO NOTHING;

CREATE TEMP TABLE cv_poc_fonte AS
SELECT c.pedido_row_id, c.item_row_id,
       (ROW_NUMBER() OVER (PARTITION BY c.pedido_row_id ORDER BY c.id))::smallint AS ordem,
       tt.id AS tipo_id, tf.id AS fonte_id, tc.id AS confianca_id, tob.id AS obs_id,
       c.valor,
       NULLIF(c.payload_json - ARRAY['pedidoId','itemId','tipo','valor','fonte','confianca','obs'], '{}'::jsonb) AS extras
  FROM central_vendas_componentes c
  JOIN cv_poc_textos tt ON tt.texto = c.tipo
  JOIN cv_poc_textos tc ON tc.texto = c.confianca
  LEFT JOIN cv_poc_textos tf ON tf.texto = c.fonte
  LEFT JOIN cv_poc_textos tob ON tob.texto = c.obs
 WHERE c.pedido_row_id IS NOT NULL;

INSERT INTO cv_poc_comp_slim (pedido_row_id, item_row_id, tipo_id, fonte_id, confianca_id, obs_id, ordem, valor, extras)
SELECT pedido_row_id, item_row_id, tipo_id, fonte_id, confianca_id, obs_id, ordem, valor, extras
  FROM cv_poc_fonte ORDER BY pedido_row_id, ordem;

INSERT INTO cv_poc_comp_jsonb (pedido_row_id, componentes, extras)
SELECT pedido_row_id,
       jsonb_agg(jsonb_build_array(tipo_id, valor, fonte_id, confianca_id, obs_id, item_row_id) ORDER BY ordem),
       CASE WHEN bool_or(extras IS NOT NULL)
            THEN jsonb_object_agg(ordem::text, extras) FILTER (WHERE extras IS NOT NULL) END
  FROM cv_poc_fonte GROUP BY pedido_row_id ORDER BY pedido_row_id;

INSERT INTO cv_poc_comp_arrays (pedido_row_id, codigos, valores, item_row_ids, extras)
SELECT f.pedido_row_id, c.codigos,
       array_agg(f.valor ORDER BY f.ordem), array_agg(f.item_row_id ORDER BY f.ordem),
       jsonb_object_agg(f.ordem::text, f.extras) FILTER (WHERE f.extras IS NOT NULL)
  FROM cv_poc_fonte f
  JOIN (SELECT g.pedido_row_id, array_agg(u.x ORDER BY g.ordem, u.k) AS codigos
          FROM cv_poc_fonte g
          CROSS JOIN LATERAL (VALUES (1, g.tipo_id), (2, COALESCE(g.fonte_id, 0)), (3, g.confianca_id), (4, COALESCE(g.obs_id, 0))) u(k, x)
         GROUP BY g.pedido_row_id) c ON c.pedido_row_id = f.pedido_row_id
 GROUP BY f.pedido_row_id, c.codigos ORDER BY f.pedido_row_id;

-- ---------------------------------------------------------------------------
-- Camada de compatibilidade: as MESMAS colunas de COMPONENTE_READ_COLUMNS
-- (centralVendasRepository), mesmos tipos. `id` não existe mais por linha:
-- devolvido NULL (nenhum leitor usa o id do componente — ver relatório).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cv_poc_escopo(item_id TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN item_id IS NOT NULL AND item_id <> '' THEN 'item' ELSE 'pedido' END $$;
CREATE OR REPLACE FUNCTION cv_poc_efeito(tipo TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN tipo IN ('receita_produto','receita_envio') THEN 'credito'
              WHEN tipo IN ('tarifa_venda','custo_produto','imposto_interno','frete_seller','cancelamento_reembolso') THEN 'debito' END $$;
CREATE OR REPLACE FUNCTION cv_poc_incluido(tipo TEXT) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN tipo IN ('receita_produto','tarifa_venda','custo_produto','imposto_interno','frete_seller') THEN TRUE
              WHEN tipo IN ('receita_envio','cancelamento_reembolso') THEN FALSE END $$;
