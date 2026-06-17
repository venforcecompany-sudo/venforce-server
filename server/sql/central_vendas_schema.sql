CREATE TABLE IF NOT EXISTS central_vendas_imports (
  id BIGSERIAL PRIMARY KEY,
  cliente_id BIGINT,
  cliente_slug TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'meli',
  competencia CHAR(7) NOT NULL,
  fonte TEXT NOT NULL DEFAULT 'planilha_vendas',
  status TEXT NOT NULL DEFAULT 'processado',
  confianca TEXT,
  resumo_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS central_vendas_pedidos (
  id BIGSERIAL PRIMARY KEY,
  import_id BIGINT REFERENCES central_vendas_imports(id) ON DELETE CASCADE,
  cliente_id BIGINT,
  cliente_slug TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'meli',
  competencia CHAR(7) NOT NULL,
  pedido_id TEXT NOT NULL,
  pack_id TEXT,
  shipment_id TEXT,
  data_pedido DATE,
  status TEXT,
  confianca TEXT NOT NULL,
  quantidade_itens NUMERIC(14,4),
  faturamento NUMERIC(14,2),
  lucro_contribuicao NUMERIC(14,2),
  resultado NUMERIC(14,2),
  margem_contribuicao_percentual NUMERIC(10,4),
  pendencias_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (import_id, pedido_id)
);

CREATE TABLE IF NOT EXISTS central_vendas_pedido_itens (
  id BIGSERIAL PRIMARY KEY,
  import_id BIGINT REFERENCES central_vendas_imports(id) ON DELETE CASCADE,
  pedido_row_id BIGINT REFERENCES central_vendas_pedidos(id) ON DELETE CASCADE,
  cliente_id BIGINT,
  cliente_slug TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'meli',
  competencia CHAR(7) NOT NULL,
  pedido_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  mlb TEXT,
  sku TEXT,
  titulo TEXT,
  quantidade NUMERIC(14,4),
  valor_unitario NUMERIC(14,2),
  receita_produto NUMERIC(14,2),
  custo_produto NUMERIC(14,2),
  imposto_interno NUMERIC(14,2),
  lucro_contribuicao NUMERIC(14,2),
  resultado NUMERIC(14,2),
  margem_contribuicao_percentual NUMERIC(10,4),
  confianca TEXT NOT NULL,
  pendencias_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (import_id, item_id)
);

CREATE TABLE IF NOT EXISTS central_vendas_componentes (
  id BIGSERIAL PRIMARY KEY,
  import_id BIGINT REFERENCES central_vendas_imports(id) ON DELETE CASCADE,
  pedido_row_id BIGINT REFERENCES central_vendas_pedidos(id) ON DELETE CASCADE,
  item_row_id BIGINT REFERENCES central_vendas_pedido_itens(id) ON DELETE CASCADE,
  cliente_id BIGINT,
  cliente_slug TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'meli',
  competencia CHAR(7) NOT NULL,
  pedido_id TEXT NOT NULL,
  item_id TEXT,
  tipo TEXT NOT NULL,
  valor NUMERIC(14,2),
  fonte TEXT,
  confianca TEXT NOT NULL,
  obs TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_central_vendas_imports_cliente_comp
  ON central_vendas_imports (cliente_slug, competencia, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_central_vendas_pedidos_import
  ON central_vendas_pedidos (import_id, data_pedido, pedido_id);

CREATE INDEX IF NOT EXISTS idx_central_vendas_itens_import
  ON central_vendas_pedido_itens (import_id, pedido_id);

CREATE INDEX IF NOT EXISTS idx_central_vendas_componentes_import
  ON central_vendas_componentes (import_id, pedido_id, item_id);
