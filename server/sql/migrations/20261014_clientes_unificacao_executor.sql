-- Infraestrutura apenas. Aplicação MANUAL em cópia/homologação antes de produção.
-- Sem unificação, backfill, movimentação ou alteração de preferências.
BEGIN;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS merged_into_cliente_id integer REFERENCES clientes(id) ON DELETE RESTRICT;
DO $$ BEGIN
  ALTER TABLE clientes ADD CONSTRAINT clientes_merge_not_self CHECK (merged_into_cliente_id IS NULL OR merged_into_cliente_id <> id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_clientes_merged_into ON clientes(merged_into_cliente_id) WHERE merged_into_cliente_id IS NOT NULL;
-- Mapping de legado não pode desaparecer por purge administrativo posterior.
CREATE OR REPLACE FUNCTION clientes_unificacao_preservar_legado() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.merged_into_cliente_id IS NOT NULL THEN RAISE EXCEPTION 'MERGED_CLIENT_DELETE_BLOCKED'; END IF;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS clientes_preservar_legado_unificado ON clientes;
CREATE TRIGGER clientes_preservar_legado_unificado BEFORE DELETE ON clientes FOR EACH ROW EXECUTE FUNCTION clientes_unificacao_preservar_legado();
CREATE TABLE IF NOT EXISTS cliente_unificacoes (
 id bigserial PRIMARY KEY,
 operation_key uuid NOT NULL UNIQUE,
 status text NOT NULL CHECK (status IN ('planned','validated','blocked','executing','completed','failed','rolled_back','rollback_failed')),
 schema_version integer NOT NULL CHECK (schema_version=1),
 cliente_canonico_id integer NOT NULL REFERENCES clientes(id) ON DELETE RESTRICT,
 manifest_json jsonb NOT NULL,
 plan_json jsonb NOT NULL,
 validation_json jsonb NOT NULL,
 before_snapshot_json jsonb,
 after_snapshot_json jsonb,
 rollback_plan_json jsonb,
 plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
 request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
 idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
 requested_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 confirmed_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 error_code text,
 error_message_safe text,
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 finished_at timestamptz,
 rolled_back_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_cliente_unificacoes_history ON cliente_unificacoes(cliente_canonico_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_cliente_unificacoes_status ON cliente_unificacoes(status,id DESC);
CREATE TABLE IF NOT EXISTS cliente_unificacao_events (
 id bigserial PRIMARY KEY,
 operation_id bigint NOT NULL REFERENCES cliente_unificacoes(id) ON DELETE RESTRICT,
 event text NOT NULL,
 actor_user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 safe_details jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION clientes_unificacao_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'MERGE_LEDGER_IMMUTABLE'; END IF;
 IF TG_TABLE_NAME='cliente_unificacao_events' THEN RAISE EXCEPTION 'MERGE_EVENTS_IMMUTABLE'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','before_snapshot_json','after_snapshot_json','rollback_plan_json','error_code','error_message_safe','started_at','finished_at','rolled_back_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','before_snapshot_json','after_snapshot_json','rollback_plan_json','error_code','error_message_safe','started_at','finished_at','rolled_back_at']) THEN
   RAISE EXCEPTION 'MERGE_LEDGER_IMMUTABLE';
 END IF;
 IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at OR
    OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at OR
    OLD.rolled_back_at IS NOT NULL AND NEW.rolled_back_at IS DISTINCT FROM OLD.rolled_back_at THEN RAISE EXCEPTION 'MERGE_TIMESTAMPS_IMMUTABLE'; END IF;
 IF OLD.before_snapshot_json IS NOT NULL AND NEW.before_snapshot_json IS DISTINCT FROM OLD.before_snapshot_json OR
    OLD.after_snapshot_json IS NOT NULL AND NEW.after_snapshot_json IS DISTINCT FROM OLD.after_snapshot_json OR
    OLD.rollback_plan_json IS NOT NULL AND NEW.rollback_plan_json IS DISTINCT FROM OLD.rollback_plan_json THEN RAISE EXCEPTION 'MERGE_SNAPSHOTS_IMMUTABLE'; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
   OLD.status IN ('planned','validated') AND NEW.status IN ('validated','blocked','executing','failed') OR
   OLD.status='executing' AND NEW.status IN ('completed','failed') OR
   OLD.status IN ('completed','rollback_failed') AND NEW.status IN ('rolled_back','rollback_failed')
 ) THEN RAISE EXCEPTION 'MERGE_STATUS_INVALID'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cliente_unificacoes_immutable ON cliente_unificacoes;
CREATE TRIGGER cliente_unificacoes_immutable BEFORE UPDATE OR DELETE ON cliente_unificacoes FOR EACH ROW EXECUTE FUNCTION clientes_unificacao_ledger_guard();
DROP TRIGGER IF EXISTS cliente_unificacao_events_immutable ON cliente_unificacao_events;
CREATE TRIGGER cliente_unificacao_events_immutable BEFORE UPDATE OR DELETE ON cliente_unificacao_events FOR EACH ROW EXECUTE FUNCTION clientes_unificacao_ledger_guard();
DROP TRIGGER IF EXISTS cliente_unificacoes_no_truncate ON cliente_unificacoes;
CREATE TRIGGER cliente_unificacoes_no_truncate BEFORE TRUNCATE ON cliente_unificacoes FOR EACH STATEMENT EXECUTE FUNCTION clientes_unificacao_ledger_guard();
DROP TRIGGER IF EXISTS cliente_unificacao_events_no_truncate ON cliente_unificacao_events;
CREATE TRIGGER cliente_unificacao_events_no_truncate BEFORE TRUNCATE ON cliente_unificacao_events FOR EACH STATEMENT EXECUTE FUNCTION clientes_unificacao_ledger_guard();
COMMIT;
