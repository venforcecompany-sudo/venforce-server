-- 20261119_sentinel_conciliacao_comissao.sql
-- Sentinel — conciliação da COMISSÃO por pedido com o Billing do Mercado Livre (S1). ADITIVA sobre 20261023/20261027.
-- ARQUIVO LOCAL: NÃO aplicada em produção (aplicar exige autorização explícita; ver docs/sentinel/HANDOFF_S1_CONCILIACAO.md).
-- Independente da 20261117 (evidência) e da 20261118 (recálculo): não toca em sentinel_pedidos.
--
-- Idempotente (IF NOT EXISTS) e sem BEGIN próprio: o runner serializado (schemaEnsure.aplicarMigrationSerializada)
-- abre a transação e o advisory lock. Pode rodar N vezes.
--
-- Desenho (compacto; NÃO guarda o JSON do ML):
--   · 1 linha por (conta, pedido) — a MESMA chave de sentinel_pedidos, com FK ON DELETE CASCADE: o purge da Conta/Cliente
--     apaga a conciliação junto (sentinel_pedidos já cascateia), e é impossível conciliar um pedido de outra conta.
--   · Sem cliente_id: o isolamento entre clientes vem da Conta (cada Conta tem um único dono); a unificação de clientes
--     mantém o id da Conta ⇒ nada a mover (registrada como "authoritative" em clientesUnificacao/references.js).
--   · Valores em CENTAVOS INTEIROS; NULL = desconhecido (nunca zero presumido).
--   · `cobrancas`: só [detail_id, subtipo, centavos, documento, na_tarifa] (~60 B/cobrança). `descontos_min`: só o que o
--     conciliador lê de /orders/{id}/discounts (tipo, funding_mode, item, quantidade, total, seller) — reaproveitado nas
--     reconsultas do Billing, sem nova chamada. Nenhum dado de comprador (nickname, payer, endereço).
--   · ≈ 0,6 KB/pedido; só pedidos ELEGÍVEIS (1 item, quantidade 1, pagos, na janela) ganham linha.
--
-- O que NÃO muda: margem, comissão, incidentes, checkpoints e qualquer coluna de sentinel_pedidos.
--
-- ROLLBACK (manual, nunca automático): o código detecta a ausência e suspende a conciliação sozinho.
--   DROP TABLE IF EXISTS sentinel_conciliacao_comissao; DROP TABLE IF EXISTS sentinel_conciliacao_controle;

CREATE TABLE IF NOT EXISTS sentinel_conciliacao_comissao (
  cliente_conta_id            INTEGER NOT NULL,
  pedido_id                   TEXT NOT NULL,
  estado                      TEXT NOT NULL,
  motivos                     TEXT[] NOT NULL DEFAULT '{}',
  contrato_versao             SMALLINT NOT NULL,
  evidencia_versao            SMALLINT NOT NULL,
  fonte                       TEXT NOT NULL DEFAULT 'billing_order_details',
  rebate_incorporado          TEXT NOT NULL DEFAULT 'desconhecido',
  -- centavos (NULL = desconhecido)
  comissao_centavos           INTEGER,  -- comissão OFICIAL do motor (sentinel_pedidos.comissao) no momento da conciliação
  gross_centavos              INTEGER,
  net_centavos                INTEGER,
  rebate_centavos             INTEGER,
  discount_centavos           INTEGER,
  cobrancas_tarifa_centavos   INTEGER,
  rebate_calculado_centavos   INTEGER,  -- parte do ML calculada em /discounts (≠ rebate observado no Billing)
  -- documento financeiro (PROCESSING ≠ definitivo; liquidação nunca é afirmada aqui)
  documento                   TEXT,
  documento_definitivo        BOOLEAN NOT NULL DEFAULT false,
  cobrancas                   JSONB,
  descontos_min               JSONB,
  descontos_consultado_em     TIMESTAMPTZ,
  -- coleta / reconsulta
  pedido_payload_hash         TEXT,     -- hash do pedido conciliado: mudou ⇒ a conciliação é refeita
  status_coleta               TEXT NOT NULL,
  observacoes                 INTEGER NOT NULL DEFAULT 0,  -- observações do Billing bem-sucedidas (limite de reconsultas)
  falhas_consecutivas         INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa_em        TIMESTAMPTZ,
  ultimo_erro                 TEXT,
  observado_em                TIMESTAMPTZ,  -- quando o Billing foi lido pela última vez com sucesso
  criado_em                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pk_sentinel_conciliacao_comissao PRIMARY KEY (cliente_conta_id, pedido_id),
  CONSTRAINT fk_sentinel_conciliacao_pedido FOREIGN KEY (cliente_conta_id, pedido_id)
    REFERENCES sentinel_pedidos (cliente_conta_id, pedido_id) ON DELETE CASCADE,
  CONSTRAINT chk_sentinel_conciliacao_estado CHECK (estado IN ('NAO_CONCILIADO', 'TARIFA_LIQUIDA_COMPROVADA', 'TARIFA_BRUTA_COMPROVADA', 'DIVERGENTE')),
  CONSTRAINT chk_sentinel_conciliacao_status CHECK (status_coleta IN ('concluida', 'reconsultar', 'falha', 'esgotada')),
  CONSTRAINT chk_sentinel_conciliacao_rebate CHECK (rebate_incorporado IN ('comprovado', 'nao_aplicavel', 'nao', 'desconhecido')),
  -- comprovação exige os valores do Billing (barra estado "comprovado" sem número)
  CONSTRAINT chk_sentinel_conciliacao_comprovada CHECK (
    estado NOT IN ('TARIFA_LIQUIDA_COMPROVADA', 'TARIFA_BRUTA_COMPROVADA')
    OR (gross_centavos IS NOT NULL AND net_centavos IS NOT NULL AND rebate_centavos IS NOT NULL AND discount_centavos IS NOT NULL
        AND comissao_centavos IS NOT NULL AND cobrancas_tarifa_centavos IS NOT NULL)),
  CONSTRAINT chk_sentinel_conciliacao_centavos CHECK (
    COALESCE(gross_centavos, 0) >= 0 AND COALESCE(net_centavos, 0) >= 0 AND COALESCE(rebate_centavos, 0) >= 0
    AND COALESCE(discount_centavos, 0) >= 0 AND COALESCE(cobrancas_tarifa_centavos, 0) >= 0),
  CONSTRAINT chk_sentinel_conciliacao_contadores CHECK (observacoes >= 0 AND falhas_consecutivas >= 0)
);

-- Fila de reconsulta por conta (só linhas com próxima tentativa) e leitura por estado.
CREATE INDEX IF NOT EXISTS idx_sentinel_conciliacao_fila
  ON sentinel_conciliacao_comissao (cliente_conta_id, proxima_tentativa_em) WHERE proxima_tentativa_em IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sentinel_conciliacao_estado
  ON sentinel_conciliacao_comissao (cliente_conta_id, estado);

-- Controle GLOBAL do coletor (uma linha por chave). Hoje: 'billing_429' — pausa após HTTP 429 do ML, respeitada por TODA
-- execução (qualquer instância), protegendo o IP compartilhado com o restante do Portal. Sem dado de cliente.
CREATE TABLE IF NOT EXISTS sentinel_conciliacao_controle (
  chave           TEXT PRIMARY KEY,
  pausado_ate     TIMESTAMPTZ,
  ocorrencias     INTEGER NOT NULL DEFAULT 0,
  motivo          TEXT,
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
