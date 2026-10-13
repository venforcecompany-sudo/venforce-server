// server/services/schema/schemaEnsure.js
//
// VenForce V3 — Pós-Convergência #2 / Production Hardening (BLOCO 3/4/17/18).
//
// ───────────────────────────────────────────────────────────────────────────
// O BUG DE PRODUÇÃO QUE ESTE ARQUIVO FECHA
// ───────────────────────────────────────────────────────────────────────────
// `/financeiro-v3.html` (Resultado e Fechamento) quebrava em produção com
//
//     column "cliente_conta_id" does not exist
//
// CAUSA RAIZ: o DDL de `entregas_cliente` — incluindo
// `ADD COLUMN IF NOT EXISTS cliente_conta_id` (V3 P2.6 D1) — vive SÓ dentro do
// handler da rota `GET /setup` em server/index.js, que é `403` em produção
// (`ENABLE_SETUP_ROUTE !== "true"`). A migration
// `sql/migrations/20260828_entregas_cliente_conta_p26.sql` NUNCA foi ligada a
// nenhum runner automático: `squadsRepository.migrationFiles` tem só os 2
// arquivos de Squads, e `ensureCentralVendasTables`/`ensureColunasCustos`/etc.
// não tocam em `entregas_cliente`. O doc da Convergência #2 dizia "coluna
// garantida no boot" — não estava. Ambientes de teste/dev tinham a coluna
// porque criam o schema do zero (ou rodam `/setup`); produção não.
//
// ───────────────────────────────────────────────────────────────────────────
// A CORREÇÃO
// ───────────────────────────────────────────────────────────────────────────
// Um `ensure` aditivo e idempotente, no MESMO padrão de `ensureColunasCustos`
// (server/services/bases/baseCustosService.js:349) — que existe exatamente
// porque `/setup` é desabilitado em produção. Roda no boot
// (server/index.js, junto dos outros `ensure*Tables()`), e a rota `/setup`
// também passa a chamá-lo para não haver duas cópias do DDL divergindo.
//
// GARANTIAS (o `ensure` é seguro em todos estes casos):
//   - banco vazio          → CREATE TABLE IF NOT EXISTS cria `entregas_cliente`
//   - banco legado          → ADD COLUMN IF NOT EXISTS adiciona `cliente_conta_id`
//   - banco já atualizado   → todo comando é IF NOT EXISTS / guardado → no-op
//   - execução repetida     → idempotente + latch `_ensured`
//   - deploy anterior       → idem (nada destrutivo, nenhuma ordem de coluna)
//   - rollback de código    → a coluna é NULLABLE e sem NOT NULL/CHECK; código
//                             antigo simplesmente a ignora
//
// O QUE ESTE ARQUIVO **NÃO** FAZ (deliberado — BLOCO 5):
//   - NÃO cria o índice UNIQUE de D4
//     (`20260828_entregas_cliente_unicidade_p26.sql`). Ele depende de auditoria
//     humana de duplicatas reais; criá-lo numa base com duplicatas FALHA. A
//     unicidade continua garantida na aplicação (409 ENTREGA_JA_EXISTE +
//     substituir:true, em `entregasClienteService.encontrarEntregaDaCompetencia`).
//   - NÃO faz backfill. Entrega antiga fica `cliente_conta_id = NULL` — que é
//     a verdade sobre ela.
//   - NÃO roda migration de Squads nem de `cliente_contas`.

const fs = require("fs");
const path = require("path");
const pool = require("../../config/database");

const migrationsDir = path.join(__dirname, "..", "..", "sql", "migrations");

// DDL CANÔNICO de `entregas_cliente`. Fonte única: `/setup` (server/index.js) e
// o boot consomem daqui. Mantido byte-a-byte igual ao que `/setup` já criava
// (só extraído para cá) para não mudar o schema de quem já rodou `/setup`.
const ENTREGAS_CLIENTE_DDL = `
  CREATE TABLE IF NOT EXISTS entregas_cliente (
    id SERIAL PRIMARY KEY,
    tipo VARCHAR(50) NOT NULL,
    cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
    cliente_slug VARCHAR(255),
    cliente_nome VARCHAR(255),
    titulo VARCHAR(255) NOT NULL,
    periodo VARCHAR(100),
    status VARCHAR(30) DEFAULT 'rascunho',
    token_publico VARCHAR(120) UNIQUE,
    publicado BOOLEAN DEFAULT FALSE,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    origem_tipo VARCHAR(50),
    origem_id INTEGER,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    published_at TIMESTAMP,
    expires_at TIMESTAMP
  );

  -- V3 P2.6 D1 — operação (ClienteConta) da entrega. Aditiva e NULLABLE.
  ALTER TABLE entregas_cliente ADD COLUMN IF NOT EXISTS cliente_conta_id INTEGER;

  -- FK so quando cliente_contas ja existe (ela vem de uma migration manual,
  -- 20260817_cliente_contas_foundation.sql, que pode nao ter rodado nesta
  -- base). Sem a FK a aplicacao funciona igual -- a integridade referencial e
  -- desejavel, nao obrigatoria para o contrato.
  DO $$
  BEGIN
    IF to_regclass('public.cliente_contas') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_entregas_cliente_conta')
    THEN
      ALTER TABLE entregas_cliente
        ADD CONSTRAINT fk_entregas_cliente_conta
        FOREIGN KEY (cliente_conta_id) REFERENCES cliente_contas(id) ON DELETE SET NULL;
    END IF;
  END
  $$;

  CREATE INDEX IF NOT EXISTS idx_entregas_cliente_cliente_id ON entregas_cliente(cliente_id);
  CREATE INDEX IF NOT EXISTS idx_entregas_cliente_conta_id ON entregas_cliente(cliente_conta_id);
  CREATE INDEX IF NOT EXISTS idx_entregas_cliente_token_publico ON entregas_cliente(token_publico);
  CREATE INDEX IF NOT EXISTS idx_entregas_cliente_tipo ON entregas_cliente(tipo);
  CREATE INDEX IF NOT EXISTS idx_entregas_cliente_created_at ON entregas_cliente(created_at);

  -- Consulta mais quente depois de D1: "a entrega desta operação nesta
  -- competência". Parcial, NÃO-única — a unicidade física é D4 (manual).
  CREATE INDEX IF NOT EXISTS idx_entregas_cliente_conta_periodo
    ON entregas_cliente(cliente_id, cliente_conta_id, periodo)
    WHERE tipo = 'fechamento_mensal';
`;

let _ensured = false;

// Idempotente. `db` injetável para teste (mesmo padrão de squadsRepository).
async function ensureEntregasClienteSchema(db = pool) {
  if (_ensured && db === pool) return;
  await db.query(ENTREGAS_CLIENTE_DDL);
  if (db === pool) _ensured = true;
}

// ───────────────────────────────────────────────────────────────────────────
// FASE 1 — Snapshot de margem PROJETADA (Anúncios ML), fundação de
// persistência para a futura ordenação global por margem. Ver
// docs/AUDITORIA_ANUNCIOS_ML_MARGEM_PROJETADA_GLOBAL_PLANO_TECNICO.md.
//
// Só o ÚLTIMO snapshot por (cliente_id, item_id) — decisão §5.4 do plano:
// margem projetada é reamostragem periódica do mesmo cálculo ao vivo, não um
// fato econômico com valor de auditoria por si (diferente do realizado).
//
// CHAVE NATURAL = (cliente_id, item_id), sem `cliente_conta_id` na UNIQUE:
// `meli_anuncios` já tem `UNIQUE (cliente_id, item_id)` (auditado nesta
// sessão via information_schema — não presumido) e NÃO inclui
// `cliente_conta_id` nessa chave. Ou seja, cada item_id já pertence a no
// máximo 1 linha de `meli_anuncios` (e por extensão, a no máximo 1
// cliente_conta_id). Incluir `cliente_conta_id` na UNIQUE deste snapshot só
// reintroduziria o problema "NULL não é igual a NULL" (2 linhas legado
// coexistindo) sem nenhum ganho de integridade — a coluna aqui é uma cópia
// desnormalizada para filtro de leitura (mesmo padrão de `clausulaConta`),
// nunca parte da chave.
//
// FK COMPOSTA para meli_anuncios(cliente_id, item_id): auditado nesta sessão
// que o índice único que a viabiliza já existe em produção
// (`meli_anuncios_cliente_id_item_id_key`) — a suposição do plano de que "não
// há chave única para referenciar" estava desatualizada/incompleta; corrigida
// aqui. ON DELETE CASCADE é seguro porque `meli_anuncios` nunca tem DELETE no
// código (upsert-only, confirmado por grep) — a linha só desapareceria se o
// próprio anúncio fosse removido do catálogo, e aí o snapshot órfão realmente
// não deveria sobreviver.
//
// GUARDAS via to_regclass (mesmo padrão de ENTREGAS_CLIENTE_DDL): tanto
// `meli_anuncios` (schema criado sob demanda por
// `meliAnunciosService.ensureSchema`, NUNCA chamado no boot) quanto
// `cliente_contas` (migration `auto:false`, aplicação manual) podem não
// existir ainda no instante em que este `ensure` roda no boot — sem a guarda,
// a FK falharia numa base nova/de teste antes de qualquer request tocar
// nessas tabelas.
const ANUNCIOS_MARGEM_PROJETADA_SNAPSHOT_DDL = `
  CREATE TABLE IF NOT EXISTS anuncios_margem_projetada_snapshot (
    id SERIAL PRIMARY KEY,
    cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    cliente_conta_id INTEGER,
    item_id TEXT NOT NULL,
    margin_percent NUMERIC,
    profit NUMERIC,
    computable BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(30),
    preco_atual NUMERIC,
    preco_original NUMERIC,
    faltantes_json JSONB,
    calculado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    origem_job VARCHAR(30) NOT NULL,
    UNIQUE (cliente_id, item_id)
  );

  DO $$
  BEGIN
    IF to_regclass('public.meli_anuncios') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_amps_meli_anuncio')
    THEN
      ALTER TABLE anuncios_margem_projetada_snapshot
        ADD CONSTRAINT fk_amps_meli_anuncio
        FOREIGN KEY (cliente_id, item_id) REFERENCES meli_anuncios(cliente_id, item_id) ON DELETE CASCADE;
    END IF;
  END
  $$;

  DO $$
  BEGIN
    IF to_regclass('public.cliente_contas') IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_amps_cliente_conta')
    THEN
      ALTER TABLE anuncios_margem_projetada_snapshot
        ADD CONSTRAINT fk_amps_cliente_conta
        FOREIGN KEY (cliente_conta_id) REFERENCES cliente_contas(id) ON DELETE SET NULL;
    END IF;
  END
  $$;

  CREATE INDEX IF NOT EXISTS idx_amps_cliente_conta ON anuncios_margem_projetada_snapshot(cliente_id, cliente_conta_id);
  CREATE INDEX IF NOT EXISTS idx_amps_margin_percent ON anuncios_margem_projetada_snapshot(margin_percent);
  CREATE INDEX IF NOT EXISTS idx_amps_calculado_em ON anuncios_margem_projetada_snapshot(calculado_em);
`;

let _ensuredAmps = false;

// Idempotente. `db` injetável para teste (mesmo padrão de ensureEntregasClienteSchema).
// Sem consumidor ainda — a tabela fica vazia até a Fase 2 (job) existir.
async function ensureAnunciosMargemProjetadaSnapshotSchema(db = pool) {
  if (_ensuredAmps && db === pool) return;
  await db.query(ANUNCIOS_MARGEM_PROJETADA_SNAPSHOT_DDL);
  if (db === pool) _ensuredAmps = true;
}

// ───────────────────────────────────────────────────────────────────────────
// Central de Margem — trilha de precificação (margem_precificacao_aplicacoes).
//
// Diferente dos DDLs inline acima, a FONTE é o arquivo versionado
// sql/migrations/20260930_margem_precificacao_aplicacoes.sql (lido daqui).
//
// SERIALIZADO entre instâncias: `CREATE TABLE IF NOT EXISTS` NÃO é seguro sob
// concorrência no Postgres (duas sessões podem passar pelo "não existe" e a
// segunda falha com 23505 em pg_type). Duas instâncias subindo juntas (deploy
// com sobreposição) executariam exatamente isso. Por isso o DDL roda numa
// transação que primeiro pega pg_advisory_xact_lock: a 2ª instância espera a
// 1ª terminar e então encontra tudo criado (IF NOT EXISTS → no-op). O lock é
// de transação (liberado no COMMIT/ROLLBACK), então não vaza em conexão do
// pool. Dentro do processo, chamadas concorrentes compartilham a mesma
// promessa (single-flight); falha não fica memorizada.
const MARGEM_PRECIFICACAO_MIGRATION = "20260930_margem_precificacao_aplicacoes.sql";
const MARGEM_PRECIFICACAO_LOCK_KEY = "vf:schema:margem_precificacao_aplicacoes";
const margemPrecificacaoEmCurso = new WeakMap();

function margemPrecificacaoDdl() {
  return fs.readFileSync(path.join(migrationsDir, MARGEM_PRECIFICACAO_MIGRATION), "utf8");
}

// Runner comum das migrations versionadas aplicadas no boot: BEGIN → advisory
// lock de transação → DDL do arquivo → COMMIT.
async function aplicarMigrationSerializada(db, ddl, lockKey) {
  // Pool real: uma conexão dedicada para a transação inteira. Client/fake de
  // teste (sem connect): a própria `db` é a sessão.
  const usaPool = typeof db.connect === "function" && typeof db.release !== "function";
  const client = usaPool ? await db.connect() : db;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
    await client.query(ddl);
    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) { /* conexão já pode ter caído */ }
    throw err;
  } finally {
    if (usaPool && typeof client.release === "function") client.release();
  }
}

// Single-flight por db: chamadas concorrentes no processo compartilham a
// mesma promessa; falha não fica memorizada.
function singleFlight(emCurso, db, aplicar) {
  const chave = db && typeof db === "object" ? db : pool;
  const atual = emCurso.get(chave);
  if (atual) return atual;
  const promessa = aplicar(chave);
  emCurso.set(chave, promessa);
  promessa.catch(() => emCurso.delete(chave));
  return promessa;
}

async function ensureMargemPrecificacaoSchema(db = pool) {
  return singleFlight(margemPrecificacaoEmCurso, db, (chave) =>
    aplicarMigrationSerializada(chave, margemPrecificacaoDdl(), MARGEM_PRECIFICACAO_LOCK_KEY));
}

// ───────────────────────────────────────────────────────────────────────────
// Promo Snapshot por conta (promo_snapshot_runs/itens/run_lotes/contas).
// Mesmo desenho da trilha de precificação: o .sql versionado é a fonte, o
// boot aplica serializado por advisory lock e os repositórios chamam o mesmo
// runner como proteção.
const PROMO_SNAPSHOT_MIGRATION = "20261001_promo_snapshot_account_sync.sql";
const PROMO_SNAPSHOT_LOCK_KEY = "vf:schema:promo_snapshot_account_sync";
const promoSnapshotEmCurso = new WeakMap();

function promoSnapshotDdl() {
  return fs.readFileSync(path.join(migrationsDir, PROMO_SNAPSHOT_MIGRATION), "utf8");
}

async function ensurePromoSnapshotSchema(db = pool) {
  return singleFlight(promoSnapshotEmCurso, db, (chave) =>
    aplicarMigrationSerializada(chave, promoSnapshotDdl(), PROMO_SNAPSHOT_LOCK_KEY));
}

// ───────────────────────────────────────────────────────────────────────────
// Financeiro V3 — snapshot do fechamento (fechamento_snapshots / itens +
// entregas_cliente.snapshot_id). Mesmo desenho da trilha de precificação: o
// .sql versionado é a fonte, o boot aplica serializado por advisory lock
// (DEPOIS de ensureEntregasClienteSchema, por causa da coluna nova) e o
// repositório chama o mesmo runner como proteção.
const FECHAMENTO_SNAPSHOTS_MIGRATION = "20261013_fechamento_snapshots.sql";
const FECHAMENTO_SNAPSHOTS_LOCK_KEY = "vf:schema:fechamento_snapshots";
const fechamentoSnapshotsEmCurso = new WeakMap();

function fechamentoSnapshotsDdl() {
  return fs.readFileSync(path.join(migrationsDir, FECHAMENTO_SNAPSHOTS_MIGRATION), "utf8");
}

async function ensureFechamentoSnapshotsSchema(db = pool) {
  return singleFlight(fechamentoSnapshotsEmCurso, db, (chave) =>
    aplicarMigrationSerializada(chave, fechamentoSnapshotsDdl(), FECHAMENTO_SNAPSHOTS_LOCK_KEY));
}

// ───────────────────────────────────────────────────────────────────────────
// BLOCO 18 — GOVERNANÇA DE MIGRATIONS (inventário legível por máquina)
// ───────────────────────────────────────────────────────────────────────────
// `auto: true`  → aplicada por um `ensure*` no boot (idempotente, aditiva).
// `auto: false` → aplicação MANUAL, exige pré-requisito humano. NUNCA entra
//                 em nenhum runner automático.
const MIGRATIONS_INVENTARIO = [
  {
    arquivo: "20260827_squads_foundation.sql",
    descricao: "squads / squad_members / cliente_squad_history / cliente_responsaveis",
    tipo: "estrutural-aditiva",
    auto: true,
    runner: "squadsRepository.ensureSquadsTables",
    idempotente: true,
    risco: "baixo",
    prerequisito: "nenhum",
    rollback: "DROP das tabelas novas (nenhuma tabela existente é alterada)",
  },
  {
    arquivo: "20260828_cliente_responsaveis_p24.sql",
    descricao: "colunas de encerramento/auditoria em cliente_responsaveis (P2.4)",
    tipo: "aditiva",
    auto: true,
    runner: "squadsRepository.ensureSquadsTables",
    idempotente: true,
    risco: "baixo",
    prerequisito: "20260827_squads_foundation.sql",
    rollback: "DROP COLUMN das colunas novas",
  },
  {
    arquivo: "20260817_cliente_contas_foundation.sql",
    descricao: "cria cliente_contas + backfill determinístico a partir de ml_tokens",
    tipo: "aditiva + backfill",
    auto: false,
    runner: null,
    idempotente: true,
    risco: "médio",
    prerequisito:
      "backup; conferir schema real de ml_tokens/clientes/base_cliente_vinculos; rodar em homologação primeiro",
    rollback:
      "as colunas cliente_conta_id em ml_tokens/base_cliente_vinculos são NULLABLE; " +
      "DROP TABLE cliente_contas CASCADE reverte (perde só o mapeamento de contas)",
  },
  {
    arquivo: "20260828_entregas_cliente_conta_p26.sql",
    descricao:
      "entregas_cliente.cliente_conta_id (D1) — aditiva, NULLABLE, sem backfill, FK guardada",
    tipo: "aditiva",
    auto: true,
    runner: "schemaEnsure.ensureEntregasClienteSchema",
    idempotente: true,
    risco: "baixo",
    prerequisito: "nenhum (FK só se cliente_contas existir)",
    rollback: "DROP COLUMN cliente_conta_id (código antigo já a ignorava)",
    nota:
      "ANTES desta correção não tinha runner nenhum — era o bug de produção. " +
      "O `ensure` replica este SQL inline (ENTREGAS_CLIENTE_DDL).",
  },
  {
    arquivo: "20260828_entregas_cliente_unicidade_p26.sql",
    descricao: "índice UNIQUE parcial (cliente, operação, competência) — D4",
    tipo: "constraint / índice único",
    auto: false,
    runner: null,
    idempotente: true,
    risco: "ALTO",
    prerequisito:
      "auditar duplicatas reais (query no cabeçalho do .sql); decisão humana sobre qual " +
      "linha sobrevive quando houver 2+ publicadas. Criar o índice numa base com duplicatas FALHA.",
    rollback: "DROP INDEX uq_entregas_fechamento_competencia",
    nota:
      "Enquanto o índice não existe, a unicidade é garantida na aplicação " +
      "(409 ENTREGA_JA_EXISTE + substituir:true). NÃO auto-aplicar.",
  },
  {
    arquivo: "20260925_anuncios_margem_projetada_snapshot.sql",
    descricao:
      "cria anuncios_margem_projetada_snapshot — fundação de persistência da margem " +
      "projetada (FASE 1 do plano de ordenação global por margem). Tabela nasce vazia, " +
      "sem consumidor nesta fase.",
    tipo: "estrutural-aditiva",
    auto: true,
    runner: "schemaEnsure.ensureAnunciosMargemProjetadaSnapshotSchema",
    idempotente: true,
    risco: "baixo",
    prerequisito: "nenhum (FKs para meli_anuncios/cliente_contas são guardadas por to_regclass)",
    rollback: "DROP TABLE anuncios_margem_projetada_snapshot (nenhum consumidor depende dela ainda)",
  },
  {
    arquivo: "20261001_cliente_contas_marketplace_tiktok.sql",
    descricao:
      "amplia a CHECK de cliente_contas.marketplace para aceitar 'tiktok' (operação TikTok " +
      "Shop no Painel de Contas, lançamento manual). Não cria nem altera linhas.",
    tipo: "aditiva (constraint)",
    auto: false,
    runner: null,
    idempotente: true,
    risco: "baixo",
    prerequisito: "20260817_cliente_contas_foundation.sql",
    rollback:
      "recriar a CHECK com ('meli','shopee') — só possível enquanto não existir conta 'tiktok'",
    nota:
      "Até rodar, criar conta TikTok responde 409 MARKETPLACE_PENDENTE_MIGRACAO; " +
      "a seção TikTok do Painel aparece vazia.",
  },
  {
    arquivo: MARGEM_PRECIFICACAO_MIGRATION,
    descricao:
      "cria margem_precificacao_aplicacoes (trilha preview→aplicação da Central de Margem: " +
      "fingerprint, claim/lease/fencing, auditoria, refresh durável) + índice parcial " +
      "idx_promo_diag_conta_concluido em promocoes_diagnosticos (Oportunidades)",
    tipo: "estrutural-aditiva",
    auto: true,
    runner: "schemaEnsure.ensureMargemPrecificacaoSchema",
    idempotente: true,
    risco: "baixo",
    prerequisito:
      "nenhum (índice de promocoes_diagnosticos guardado por to_regclass). Serializado por " +
      "pg_advisory_xact_lock: seguro com duas instâncias subindo ao mesmo tempo",
    rollback:
      "DROP TABLE margem_precificacao_aplicacoes; DROP INDEX idx_promo_diag_conta_concluido " +
      "(nenhuma tabela existente é alterada)",
    nota: "O .sql É a fonte do DDL (lido pelo runner), não uma cópia de documentação.",
  },
  {
    arquivo: PROMO_SNAPSHOT_MIGRATION,
    descricao:
      "cria promo_snapshot_runs / promo_snapshot_itens / promo_snapshot_run_lotes / " +
      "promo_snapshot_contas — promoções do ML lidas por conta pelo Promo Snapshot Worker " +
      "(somente leitura no ML), com run ativo único por conta e ponteiro de snapshot atual",
    tipo: "estrutural-aditiva",
    auto: true,
    runner: "schemaEnsure.ensurePromoSnapshotSchema",
    idempotente: true,
    risco: "baixo",
    prerequisito:
      "nenhum (FKs para clientes/cliente_contas guardadas por to_regclass). Serializado por " +
      "pg_advisory_xact_lock: seguro com duas instâncias subindo ao mesmo tempo",
    rollback:
      "DROP TABLE promo_snapshot_itens, promo_snapshot_run_lotes, promo_snapshot_contas, " +
      "promo_snapshot_runs (nenhuma tabela existente é alterada; a Central volta a ler o " +
      "diagnóstico legado)",
    nota: "Sem backfill: promocoes_diagnosticos não tem cliente_conta_id. Cada conta nasce vazia.",
  },
  {
    arquivo: FECHAMENTO_SNAPSHOTS_MIGRATION,
    descricao:
      "cria fechamento_snapshots / fechamento_snapshot_itens (revisões imutáveis do " +
      "fechamento por conta × competência, com TODAS as linhas do motor) e a coluna " +
      "NULLABLE entregas_cliente.snapshot_id (a apresentação aponta para a revisão)",
    tipo: "estrutural-aditiva",
    auto: true,
    runner: "schemaEnsure.ensureFechamentoSnapshotsSchema",
    idempotente: true,
    risco: "baixo",
    prerequisito:
      "nenhum (FK para cliente_contas e coluna em entregas_cliente guardadas por to_regclass). " +
      "Serializado por pg_advisory_xact_lock; no boot roda depois de ensureEntregasClienteSchema",
    rollback:
      "ALTER TABLE entregas_cliente DROP COLUMN snapshot_id; DROP TABLE fechamento_snapshot_itens, " +
      "fechamento_snapshots; DROP FUNCTION fechamento_snapshot_recusar_update (nenhuma linha " +
      "existente é alterada; entregas voltam a ser lidas só pelo payload_json)",
    nota: "Sem backfill: entrega antiga fica snapshot_id NULL e segue lida pelo payload_json.",
  },
];

// Arquivos que QUALQUER runner automático tem permissão de aplicar. Usado por
// teste para travar o invariante "a unicidade de D4 nunca é auto-aplicada".
const MIGRATIONS_AUTO = MIGRATIONS_INVENTARIO.filter((m) => m.auto).map((m) => m.arquivo);

module.exports = {
  ensureEntregasClienteSchema,
  ENTREGAS_CLIENTE_DDL,
  ensureAnunciosMargemProjetadaSnapshotSchema,
  ANUNCIOS_MARGEM_PROJETADA_SNAPSHOT_DDL,
  ensureMargemPrecificacaoSchema,
  margemPrecificacaoDdl,
  MARGEM_PRECIFICACAO_MIGRATION,
  MARGEM_PRECIFICACAO_LOCK_KEY,
  ensurePromoSnapshotSchema,
  promoSnapshotDdl,
  PROMO_SNAPSHOT_MIGRATION,
  PROMO_SNAPSHOT_LOCK_KEY,
  ensureFechamentoSnapshotsSchema,
  fechamentoSnapshotsDdl,
  FECHAMENTO_SNAPSHOTS_MIGRATION,
  FECHAMENTO_SNAPSHOTS_LOCK_KEY,
  MIGRATIONS_INVENTARIO,
  MIGRATIONS_AUTO,
  migrationsDir,
  _resetEnsuredParaTeste: () => { _ensured = false; },
  _resetAmpsEnsuredParaTeste: () => { _ensuredAmps = false; },
};
