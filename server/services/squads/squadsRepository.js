// server/services/squads/squadsRepository.js
// Camada de dados de Squads + autorização por carteira (VenForce V3 Fase S).
// Todo o SQL vive aqui, sempre parametrizado. Cada query carrega um marcador
// /* squads:NOME */ para ser mockável nos testes sem Postgres real (mesmo
// padrão de dashboardService `/* dashboard:... */`).
//
// Modelo (docs/CONTEXTO_COMPLETO_SQUADS §5, mission §3/§4):
//   ROLE            = o que o usuário pode fazer globalmente (users.role)
//   SQUAD           = qual carteira operacional o usuário acessa
//   RESPONSABILIDADE = qual Cliente é diretamente daquele profissional
// Squad NÃO é propagado para tabelas operacionais: deriva-se
//   conta -> cliente -> squad  (dados por conta)
//   cliente -> squad            (dados client-level)

const fs = require("fs");
const path = require("path");
const pool = require("../../config/database");

const migrationsDir = path.join(__dirname, "..", "..", "sql", "migrations");
const migrationFiles = [
  "20260827_squads_foundation.sql",       // S — squads/members/history/responsaveis
  "20260828_cliente_responsaveis_p24.sql", // P2.4 — colunas de encerramento/auditoria
];

let _ensured = false;

// Idempotente. Os arquivos de migration são a fonte canônica do schema —
// este boot só os reaplica (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
// EXISTS / índices parciais).
async function ensureSquadsTables(db = pool) {
  if (_ensured && db === pool) return;
  for (const nome of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, nome), "utf8");
    await db.query(sql);
  }
  if (db === pool) _ensured = true;
}

// Tabelas sem as quais nenhuma leitura de Squads faz sentido.
const TABELAS_SQUADS = ["squads", "squad_members", "cliente_squad_history", "cliente_responsaveis"];

/**
 * V3 P2.9 — BLOQUEADOR T-3. Alternativa ZERO-WRITE a `ensureSquadsTables`.
 *
 * `ensureSquadsTables` reaplica as migrations, isto é, executa DDL. Isso é
 * legítimo no boot e no `--apply`, mas transformava o "dry-run" e o `--audit`
 * em operações de ESCRITA — inaceitável contra produção, justamente onde essas
 * operações existem para ser inofensivas.
 *
 * Esta função só PERGUNTA, com `to_regclass` (SELECT puro): as tabelas estão
 * lá? Se não estiverem, quem chamou recebe a lista de ausentes e decide — o
 * que nunca acontece é criar tabela caladamente durante uma simulação.
 *
 * @returns {Promise<{ok: boolean, ausentes: string[]}>}
 */
async function verificarSchemaSquads(db = pool) {
  const { rows } = await db.query(
    `/* squads:SCHEMA_PRESENTE */
     SELECT t AS nome, to_regclass('public.' || t) IS NOT NULL AS existe
       FROM unnest($1::text[]) AS t`,
    [TABELAS_SQUADS]
  );
  const ausentes = rows.filter((r) => !r.existe).map((r) => r.nome);
  return { ok: ausentes.length === 0, ausentes };
}

/**
 * Ponto único de decisão entre "garantir" (escreve DDL) e "verificar" (não
 * escreve nada). Todo caminho de leitura do tooling passa por aqui.
 */
async function prepararSchemaSquads(db = pool, { garantirSchema = true } = {}) {
  if (garantirSchema) {
    await ensureSquadsTables(db);
    return { ok: true, ausentes: [], modo: "GARANTIDO" };
  }
  const r = await verificarSchemaSquads(db);
  return { ...r, modo: "VERIFICADO_ZERO_WRITE" };
}

/* ─────────────────────────── squads ─────────────────────────── */

async function listarSquads({ apenasAtivos = false, squadIds = null } = {}, db = pool) {
  const filtros = [];
  const params = [];
  if (apenasAtivos) filtros.push("s.ativo = true");
  if (Array.isArray(squadIds)) {
    params.push(squadIds);
    filtros.push(`s.id = ANY($${params.length}::int[])`);
  }
  const where = filtros.length ? `WHERE ${filtros.join(" AND ")}` : "";
  const { rows } = await db.query(
    `/* squads:LIST */
     SELECT s.id, s.nome, s.slug, s.ativo, s.created_at, s.updated_at,
            (SELECT COUNT(*)::int FROM squad_members sm WHERE sm.squad_id = s.id AND sm.ativo = true) AS membros_ativos,
            (SELECT COUNT(*)::int FROM cliente_squad_history csh WHERE csh.squad_id = s.id AND csh.fim_em IS NULL) AS clientes_ativos
       FROM squads s
       ${where}
      ORDER BY s.nome ASC`,
    params
  );
  return rows;
}

async function obterSquadPorId(id, db = pool) {
  const { rows } = await db.query(
    `/* squads:GET */
     SELECT id, nome, slug, ativo, created_at, updated_at FROM squads WHERE id = $1`,
    [Number(id)]
  );
  return rows[0] || null;
}

async function obterSquadPorSlug(slug, db = pool) {
  const { rows } = await db.query(
    `/* squads:GET_BY_SLUG */
     SELECT id, nome, slug, ativo, created_at, updated_at FROM squads WHERE slug = $1`,
    [String(slug)]
  );
  return rows[0] || null;
}

async function criarSquad({ nome, slug }, db = pool) {
  const { rows } = await db.query(
    `/* squads:INSERT */
     INSERT INTO squads (nome, slug) VALUES ($1, $2)
     RETURNING id, nome, slug, ativo, created_at, updated_at`,
    [nome, slug]
  );
  return rows[0];
}

async function atualizarSquad(id, { nome, slug, ativo }, db = pool) {
  const patches = [];
  const params = [];
  if (nome !== undefined) { params.push(nome); patches.push(`nome = $${params.length}`); }
  if (slug !== undefined) { params.push(slug); patches.push(`slug = $${params.length}`); }
  if (ativo !== undefined) { params.push(Boolean(ativo)); patches.push(`ativo = $${params.length}`); }
  if (!patches.length) return obterSquadPorId(id, db);
  patches.push("updated_at = NOW()");
  params.push(Number(id));
  const { rows } = await db.query(
    `/* squads:UPDATE */
     UPDATE squads SET ${patches.join(", ")} WHERE id = $${params.length}
     RETURNING id, nome, slug, ativo, created_at, updated_at`,
    params
  );
  return rows[0] || null;
}

/* ─────────────────────── squad_members ─────────────────────── */

// Memberships ativas do usuário, com dados do squad. Ordena principal
// primeiro. Filtra squad inativo? NÃO — para /me/context queremos mostrar
// a membership mesmo com squad inativo (com flag). A autorização é que
// filtra squad inativo (resolvePortfolio).
async function membershipsDoUsuario(userId, { apenasSquadAtivo = false } = {}, db = pool) {
  const filtroSquad = apenasSquadAtivo ? "AND s.ativo = true" : "";
  const { rows } = await db.query(
    `/* squads:MEMBERSHIPS_DO_USUARIO */
     SELECT sm.id, sm.squad_id, sm.user_id, sm.is_primary, sm.funcao, sm.ativo,
            s.nome AS squad_nome, s.slug AS squad_slug, s.ativo AS squad_ativo
       FROM squad_members sm
       JOIN squads s ON s.id = sm.squad_id
      WHERE sm.user_id = $1 AND sm.ativo = true ${filtroSquad}
      ORDER BY sm.is_primary DESC, s.nome ASC`,
    [Number(userId)]
  );
  return rows;
}

async function membrosDoSquad(squadId, db = pool) {
  const { rows } = await db.query(
    `/* squads:MEMBROS_DO_SQUAD */
     SELECT sm.id, sm.user_id, sm.is_primary, sm.funcao, sm.ativo,
            sm.created_at, sm.updated_at,
            u.nome AS user_nome, u.email AS user_email, u.role AS user_role
       FROM squad_members sm
       JOIN users u ON u.id = sm.user_id
      WHERE sm.squad_id = $1 AND sm.ativo = true
      ORDER BY sm.is_primary DESC, u.nome ASC`,
    [Number(squadId)]
  );
  return rows;
}

async function obterMembership(squadId, userId, db = pool) {
  const { rows } = await db.query(
    `/* squads:GET_MEMBERSHIP */
     SELECT id, squad_id, user_id, is_primary, funcao, ativo
       FROM squad_members WHERE squad_id = $1 AND user_id = $2`,
    [Number(squadId), Number(userId)]
  );
  return rows[0] || null;
}

// coordenador de um squad específico (para RBAC das APIs admin). Retorna
// true se o usuário tem membership ativa com funcao='coordenador' naquele
// squad (que precisa estar ativo).
async function ehCoordenadorDoSquad(userId, squadId, db = pool) {
  const { rows } = await db.query(
    `/* squads:EH_COORDENADOR */
     SELECT 1
       FROM squad_members sm
       JOIN squads s ON s.id = sm.squad_id AND s.ativo = true
      WHERE sm.user_id = $1 AND sm.squad_id = $2
        AND sm.ativo = true AND sm.funcao = 'coordenador'
      LIMIT 1`,
    [Number(userId), Number(squadId)]
  );
  return rows.length > 0;
}

async function squadsCoordenadosPor(userId, db = pool) {
  const { rows } = await db.query(
    `/* squads:COORDENADOS_POR */
     SELECT sm.squad_id
       FROM squad_members sm
       JOIN squads s ON s.id = sm.squad_id AND s.ativo = true
      WHERE sm.user_id = $1 AND sm.ativo = true AND sm.funcao = 'coordenador'`,
    [Number(userId)]
  );
  return rows.map((r) => r.squad_id);
}

/* ───────────────────── cliente_squad_history ───────────────────── */

async function squadAtivoDoCliente(clienteId, db = pool) {
  const { rows } = await db.query(
    `/* squads:SQUAD_ATIVO_DO_CLIENTE */
     SELECT csh.id, csh.squad_id, csh.inicio_em,
            s.nome AS squad_nome, s.slug AS squad_slug, s.ativo AS squad_ativo
       FROM cliente_squad_history csh
       JOIN squads s ON s.id = csh.squad_id
      WHERE csh.cliente_id = $1 AND csh.fim_em IS NULL`,
    [Number(clienteId)]
  );
  return rows[0] || null;
}

// Squad ativo (id + nome + slug) de vários clientes de uma vez — para
// /me/portfolio e /me/context sem N+1.
async function squadsAtivosDeClientes(clienteIds, db = pool) {
  if (!Array.isArray(clienteIds) || !clienteIds.length) return [];
  const { rows } = await db.query(
    `/* squads:SQUADS_ATIVOS_DE_CLIENTES */
     SELECT csh.cliente_id, csh.squad_id,
            s.nome AS squad_nome, s.slug AS squad_slug, s.ativo AS squad_ativo
       FROM cliente_squad_history csh
       JOIN squads s ON s.id = csh.squad_id
      WHERE csh.fim_em IS NULL AND csh.cliente_id = ANY($1::int[])`,
    [clienteIds]
  );
  return rows;
}

async function clientesDoSquad(squadId, db = pool) {
  const { rows } = await db.query(
    `/* squads:CLIENTES_DO_SQUAD */
     SELECT c.id, c.slug, c.nome, c.ativo,
            csh.inicio_em, csh.alterado_por
       FROM cliente_squad_history csh
       JOIN clientes c ON c.id = csh.cliente_id
      WHERE csh.squad_id = $1 AND csh.fim_em IS NULL
      ORDER BY c.nome ASC`,
    [Number(squadId)]
  );
  return rows;
}

async function historicoDoCliente(clienteId, db = pool) {
  const { rows } = await db.query(
    `/* squads:HISTORICO_DO_CLIENTE */
     SELECT csh.id, csh.squad_id, s.nome AS squad_nome, s.slug AS squad_slug,
            csh.inicio_em, csh.fim_em, csh.alterado_por, csh.motivo,
            u.nome AS alterado_por_nome
       FROM cliente_squad_history csh
       JOIN squads s ON s.id = csh.squad_id
       LEFT JOIN users u ON u.id = csh.alterado_por
      WHERE csh.cliente_id = $1
      ORDER BY csh.inicio_em DESC, csh.id DESC`,
    [Number(clienteId)]
  );
  return rows;
}

/* ─────────────────────── cliente_responsaveis ─────────────────────── */

async function responsaveisDeClientes(clienteIds, userId = null, db = pool) {
  if (!Array.isArray(clienteIds) || !clienteIds.length) return [];
  const params = [clienteIds];
  let filtroUser = "";
  if (userId != null) {
    params.push(Number(userId));
    filtroUser = `AND cr.user_id = $${params.length}`;
  }
  const { rows } = await db.query(
    `/* squads:RESPONSAVEIS_DE_CLIENTES */
     SELECT cr.cliente_id, cr.user_id, cr.papel
       FROM cliente_responsaveis cr
      WHERE cr.ativo = true AND cr.cliente_id = ANY($1::int[]) ${filtroUser}`,
    params
  );
  return rows;
}

// Lista os responsáveis de UM cliente (com nome/email do usuário). Por
// padrão só os vigentes; `incluirEncerrados` traz o rastro histórico.
async function listarResponsaveisDoCliente(clienteId, { incluirEncerrados = false } = {}, db = pool) {
  const filtroAtivo = incluirEncerrados ? "" : "AND cr.ativo = true";
  const { rows } = await db.query(
    `/* squads:RESPONSAVEIS_DO_CLIENTE */
     SELECT cr.id, cr.cliente_id, cr.user_id, cr.papel, cr.ativo,
            cr.criado_por, cr.created_at, cr.updated_at,
            cr.encerrado_em, cr.encerrado_por, cr.motivo,
            u.nome AS user_nome, u.email AS user_email, u.role AS user_role
       FROM cliente_responsaveis cr
       JOIN users u ON u.id = cr.user_id
      WHERE cr.cliente_id = $1 ${filtroAtivo}
      ORDER BY cr.ativo DESC, cr.papel ASC, u.nome ASC`,
    [Number(clienteId)]
  );
  return rows;
}

async function obterResponsavel(clienteId, userId, papel, db = pool) {
  const { rows } = await db.query(
    `/* squads:GET_RESPONSAVEL */
     SELECT id, cliente_id, user_id, papel, ativo, criado_por,
            encerrado_em, encerrado_por, motivo
       FROM cliente_responsaveis
      WHERE cliente_id = $1 AND user_id = $2 AND papel = $3`,
    [Number(clienteId), Number(userId), String(papel)]
  );
  return rows[0] || null;
}

// Conta responsáveis vigentes de um papel para um cliente.
async function contarResponsaveisAtivos(clienteId, papel, db = pool) {
  const { rows } = await db.query(
    `/* squads:CONTAR_RESPONSAVEIS_ATIVOS */
     SELECT COUNT(*)::int AS total
       FROM cliente_responsaveis
      WHERE cliente_id = $1 AND papel = $2 AND ativo = true`,
    [Number(clienteId), String(papel)]
  );
  return rows[0] ? rows[0].total : 0;
}

// Insere ou reativa (reusa a linha) um responsável. Limpa o encerramento.
async function upsertResponsavel({ clienteId, userId, papel, criadoPor = null }, db = pool) {
  const { rows } = await db.query(
    `/* squads:UPSERT_RESPONSAVEL */
     INSERT INTO cliente_responsaveis (cliente_id, user_id, papel, ativo, criado_por)
     VALUES ($1, $2, $3, true, $4)
     ON CONFLICT (cliente_id, user_id, papel) DO UPDATE
       SET ativo = true,
           encerrado_em = NULL,
           encerrado_por = NULL,
           motivo = NULL,
           criado_por = COALESCE(cliente_responsaveis.criado_por, EXCLUDED.criado_por),
           updated_at = NOW()
     RETURNING id, cliente_id, user_id, papel, ativo, criado_por, created_at, updated_at`,
    [Number(clienteId), Number(userId), String(papel), criadoPor == null ? null : Number(criadoPor)]
  );
  return rows[0];
}

// Soft-delete: encerra o vínculo (não apaga a linha).
async function encerrarResponsavel({ clienteId, userId, papel, encerradoPor = null, motivo = null }, db = pool) {
  const { rows } = await db.query(
    `/* squads:ENCERRAR_RESPONSAVEL */
     UPDATE cliente_responsaveis
        SET ativo = false, encerrado_em = NOW(), encerrado_por = $4,
            motivo = COALESCE($5, motivo), updated_at = NOW()
      WHERE cliente_id = $1 AND user_id = $2 AND papel = $3 AND ativo = true
      RETURNING id, cliente_id, user_id, papel`,
    [Number(clienteId), Number(userId), String(papel), encerradoPor == null ? null : Number(encerradoPor), motivo]
  );
  return rows[0] || null;
}

// Encerra, em lote, as responsabilidades vigentes de um cliente cujo usuário
// NÃO é membro ativo de `squadDestinoId`. Chamado quando o cliente muda de
// Squad: responsabilidade não pode continuar apontando silenciosamente para
// quem perdeu o acesso (mission P2.4 §4). NÃO é autorização — é limpeza
// disparada PELA transferência, nunca o contrário.
async function encerrarResponsaveisSemAcessoAoSquad(clienteId, squadDestinoId, { encerradoPor = null, motivo = "transferencia_squad" } = {}, db = pool) {
  const { rows } = await db.query(
    `/* squads:ENCERRAR_RESPONSAVEIS_SEM_ACESSO */
     UPDATE cliente_responsaveis cr
        SET ativo = false, encerrado_em = NOW(), encerrado_por = $3,
            motivo = $4, updated_at = NOW()
      WHERE cr.cliente_id = $1 AND cr.ativo = true
        AND NOT EXISTS (
          SELECT 1 FROM squad_members sm
           WHERE sm.squad_id = $2 AND sm.user_id = cr.user_id AND sm.ativo = true
        )
      RETURNING cr.user_id, cr.papel`,
    [Number(clienteId), Number(squadDestinoId), encerradoPor == null ? null : Number(encerradoPor), motivo]
  );
  return rows;
}

// O usuário é membro ativo do Squad ativo do cliente? (checagem ESTRUTURAL
// de squad_members — independe do flag SQUADS_ENFORCEMENT). Retorna:
//   { temSquad: false }                       -> cliente sem Squad ativo
//   { temSquad: true, membro: bool, squadId }  -> resultado da checagem
async function usuarioTemAcessoAoSquadDoCliente(clienteId, userId, db = pool) {
  const { rows } = await db.query(
    `/* squads:ACESSO_ESTRUTURAL_AO_SQUAD */
     SELECT csh.squad_id,
            EXISTS (
              SELECT 1 FROM squad_members sm
               WHERE sm.squad_id = csh.squad_id AND sm.user_id = $2 AND sm.ativo = true
            ) AS membro
       FROM cliente_squad_history csh
      WHERE csh.cliente_id = $1 AND csh.fim_em IS NULL`,
    [Number(clienteId), Number(userId)]
  );
  if (!rows.length) return { temSquad: false };
  return { temSquad: true, membro: rows[0].membro === true, squadId: rows[0].squad_id };
}

module.exports = {
  ensureSquadsTables,
  verificarSchemaSquads,
  prepararSchemaSquads,
  TABELAS_SQUADS,
  listarSquads,
  obterSquadPorId,
  obterSquadPorSlug,
  criarSquad,
  atualizarSquad,
  membershipsDoUsuario,
  membrosDoSquad,
  obterMembership,
  ehCoordenadorDoSquad,
  squadsCoordenadosPor,
  squadAtivoDoCliente,
  squadsAtivosDeClientes,
  clientesDoSquad,
  historicoDoCliente,
  responsaveisDeClientes,
  listarResponsaveisDoCliente,
  obterResponsavel,
  contarResponsaveisAtivos,
  upsertResponsavel,
  encerrarResponsavel,
  encerrarResponsaveisSemAcessoAoSquad,
  usuarioTemAcessoAoSquadDoCliente,
  _resetEnsuredParaTeste: () => { _ensured = false; },
};
