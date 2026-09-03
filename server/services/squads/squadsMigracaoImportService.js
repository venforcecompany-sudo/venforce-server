// server/services/squads/squadsMigracaoImportService.js
// VenForce V3 — P2.3 (Migration Tooling).
//
// Importa um PLANO de migração de Squads (JSON) com:
//   - validação estática + contra o banco (dry-run)
//   - execução transacional (tudo ou nada) e idempotente
//   - relatório antes / planejado / depois
//
// NÃO inventa dados. O plano é fornecido pela operação (ver
// Squads_migration/SQUADS_MIGRATION_TEMPLATE.json). Sem plano → nada roda.
//
// Chaves naturais no plano (nunca ids internos frágeis):
//   squad    → slug            ("alpha")
//   usuario  → email OU id     ("fulano@venforce.com" | 42)
//   cliente  → slug OU id      ("cliente-acme" | 7)
//
// Regras herdadas de squadService (mesmas invariantes):
//   - 1 membership por (squad,user); reativar = UPDATE ativo=true
//   - no máx. 1 principal ativo por usuário; 1ª membership vira principal
//   - cliente em no máx. 1 squad ativo; squad diferente = transferência
//     (histórico aditivo, nunca delete)
//   - membership/atribuição para squad INATIVO é recusada (não dá carteira)

const pool = require("../../config/database");
const { ensureSquadsTables, prepararSchemaSquads } = require("./squadsRepository");
const { normalizarSlug } = require("./squadService");
const { auditoria } = require("./squadsMigracaoService");
const { ROLES_ELEGIVEIS_MEMBERSHIP } = require("./rolesInternas");

const FUNCOES_SQUAD = new Set(["membro", "coordenador"]);
const PAPEIS_RESP = new Set(["gestor", "auxiliar", "designer"]);
// Quem PODE receber membership. Fonte canônica única — ver rolesInternas.js.
// INCLUI `admin` deliberadamente: um admin coordenar um Squad é legítimo. Este
// conjunto é diferente do cobrado pela auditoria, e a diferença é intencional.
const ROLES_INTERNAS = ROLES_ELEGIVEIS_MEMBERSHIP.set;

/* ────────────────────────────── helpers ────────────────────────────── */

function ehId(v) {
  return (typeof v === "number" && Number.isInteger(v) && v > 0) ||
    (typeof v === "string" && /^\d+$/.test(v.trim()));
}
function comoId(v) { return Number(String(v).trim()); }
function ehEmail(v) { return typeof v === "string" && v.includes("@"); }
function txt(v) { return String(v ?? "").trim(); }

function novoColetor() {
  const erros = [];
  const avisos = [];
  return {
    erros, avisos,
    erro: (contexto, msg) => erros.push({ contexto, msg }),
    aviso: (contexto, msg) => avisos.push({ contexto, msg }),
  };
}

/* ─────────────────────────── resolução em lote ─────────────────────────── */

async function resolverEntidades(plano, db) {
  const squadSlugs = new Set();
  const userIds = new Set();
  const userEmails = new Set();
  const cliIds = new Set();
  const cliSlugs = new Set();

  for (const s of plano.squads || []) if (txt(s?.slug)) squadSlugs.add(normalizarSlug(s.slug));
  for (const m of plano.membros || []) {
    if (txt(m?.squad)) squadSlugs.add(normalizarSlug(m.squad));
    if (ehId(m?.usuario)) userIds.add(comoId(m.usuario));
    else if (ehEmail(m?.usuario)) userEmails.add(txt(m.usuario).toLowerCase());
  }
  for (const c of plano.clientes || []) {
    if (txt(c?.squad)) squadSlugs.add(normalizarSlug(c.squad));
    if (ehId(c?.cliente)) cliIds.add(comoId(c.cliente));
    else if (txt(c?.cliente)) cliSlugs.add(txt(c.cliente).toLowerCase());
  }
  for (const r of plano.responsaveis || []) {
    if (ehId(r?.usuario)) userIds.add(comoId(r.usuario));
    else if (ehEmail(r?.usuario)) userEmails.add(txt(r.usuario).toLowerCase());
    if (ehId(r?.cliente)) cliIds.add(comoId(r.cliente));
    else if (txt(r?.cliente)) cliSlugs.add(txt(r.cliente).toLowerCase());
  }

  const [squads, users, clientes] = await Promise.all([
    db.query(
      `/* squads:MIG_RESOLVE_SQUADS */
       SELECT id, slug, nome, ativo FROM squads WHERE slug = ANY($1::text[])`,
      [[...squadSlugs]]
    ),
    db.query(
      `/* squads:MIG_RESOLVE_USERS */
       SELECT id, nome, email, role, ativo FROM users
        WHERE id = ANY($1::int[]) OR LOWER(email) = ANY($2::text[])`,
      [[...userIds], [...userEmails]]
    ),
    db.query(
      `/* squads:MIG_RESOLVE_CLIENTES */
       SELECT id, slug, nome, ativo FROM clientes
        WHERE id = ANY($1::int[]) OR LOWER(slug) = ANY($2::text[])`,
      [[...cliIds], [...cliSlugs]]
    ),
  ]);

  const userIdsResolvidos = users.rows.map((u) => u.id);
  const cliIdsResolvidos = clientes.rows.map((c) => c.id);

  const [memberships, vinculos] = await Promise.all([
    userIdsResolvidos.length
      ? db.query(
          `/* squads:MIG_MEMBERSHIPS_EXISTENTES */
           SELECT sm.user_id, sm.squad_id, sm.is_primary, sm.funcao, sm.ativo, s.slug AS squad_slug, s.ativo AS squad_ativo
             FROM squad_members sm JOIN squads s ON s.id = sm.squad_id
            WHERE sm.user_id = ANY($1::int[])`,
          [userIdsResolvidos]
        )
      : { rows: [] },
    cliIdsResolvidos.length
      ? db.query(
          `/* squads:MIG_VINCULOS_EXISTENTES */
           SELECT csh.cliente_id, csh.squad_id, s.slug AS squad_slug, s.ativo AS squad_ativo
             FROM cliente_squad_history csh JOIN squads s ON s.id = csh.squad_id
            WHERE csh.fim_em IS NULL AND csh.cliente_id = ANY($1::int[])`,
          [cliIdsResolvidos]
        )
      : { rows: [] },
  ]);

  const squadPorSlug = new Map(squads.rows.map((s) => [s.slug, s]));
  const userPorId = new Map(users.rows.map((u) => [u.id, u]));
  const userPorEmail = new Map(users.rows.map((u) => [String(u.email).toLowerCase(), u]));
  const cliPorId = new Map(clientes.rows.map((c) => [c.id, c]));
  const cliPorSlug = new Map(clientes.rows.map((c) => [String(c.slug).toLowerCase(), c]));

  return {
    squadPorSlug,
    resolverUser: (ref) => (ehId(ref) ? userPorId.get(comoId(ref)) : userPorEmail.get(txt(ref).toLowerCase())) || null,
    resolverCliente: (ref) => (ehId(ref) ? cliPorId.get(comoId(ref)) : cliPorSlug.get(txt(ref).toLowerCase())) || null,
    membershipsPorUser: agrupar(memberships.rows, "user_id"),
    vinculoPorCliente: new Map(vinculos.rows.map((v) => [v.cliente_id, v])),
  };
}

function agrupar(rows, chave) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[chave])) m.set(r[chave], []);
    m.get(r[chave]).push(r);
  }
  return m;
}

/* ────────────────────────────── validação ────────────────────────────── */

// Retorna { ok, erros, avisos, plano, entidades, planejado }.
//
// `garantirSchema: false` → modo ZERO-WRITE (P2.9, BLOQUEADOR T-3): não aplica
// DDL, apenas confere o schema com `to_regclass`. Schema ausente vira ERRO, não
// criação silenciosa. O default preserva o comportamento histórico.
async function validarPlano(planoBruto, db = pool, { garantirSchema = true } = {}) {
  const schema = await prepararSchemaSquads(db, { garantirSchema });
  const col = novoColetor();
  if (!schema.ok) {
    col.erro("schema", `schema de Squads ausente (${schema.ausentes.join(", ")}) — rode a migração antes. Modo zero-write não cria tabela.`);
    return { ok: false, erros: col.erros, avisos: col.avisos, plano: planoBruto };
  }

  const plano = planoBruto && typeof planoBruto === "object" ? planoBruto : {};
  for (const campo of ["squads", "membros", "clientes"]) {
    if (plano[campo] !== undefined && !Array.isArray(plano[campo])) {
      col.erro("plano", `"${campo}" deve ser uma lista.`);
    }
  }
  if (plano.responsaveis !== undefined && !Array.isArray(plano.responsaveis)) {
    col.erro("plano", `"responsaveis" deve ser uma lista.`);
  }
  if (plano.versao !== undefined && plano.versao !== 1) {
    col.aviso("plano", `versao=${plano.versao} desconhecida (esperado 1).`);
  }
  if (col.erros.length) return { ok: false, erros: col.erros, avisos: col.avisos, plano };

  const squads = plano.squads || [];
  const membros = plano.membros || [];
  const clientes = plano.clientes || [];
  const responsaveis = plano.responsaveis || [];

  const ent = await resolverEntidades(plano, db);

  // ── squads ──
  const slugsNoPlano = new Set();
  const squadAtivoEfetivo = new Map(); // slug -> bool (estado após aplicar o plano)
  const planejadoSquads = { criar: [], atualizar: [], inalterado: [] };
  for (const [i, s] of squads.entries()) {
    const ctx = `squads[${i}]`;
    const slugCru = txt(s?.slug);
    const nome = txt(s?.nome);
    if (!slugCru) { col.erro(ctx, "slug obrigatório."); continue; }
    if (!nome) { col.erro(ctx, `slug "${slugCru}": nome obrigatório.`); continue; }
    const slug = normalizarSlug(slugCru);
    if (!slug) { col.erro(ctx, `slug "${slugCru}" inválido após normalização.`); continue; }
    if (slug !== slugCru) col.aviso(ctx, `slug "${slugCru}" normalizado para "${slug}".`);
    if (slugsNoPlano.has(slug)) { col.erro(ctx, `slug "${slug}" duplicado no plano.`); continue; }
    slugsNoPlano.add(slug);
    if (s.ativo !== undefined && typeof s.ativo !== "boolean") {
      col.erro(ctx, `slug "${slug}": "ativo" deve ser boolean.`);
    }
    const ativo = s.ativo === undefined ? true : Boolean(s.ativo);
    squadAtivoEfetivo.set(slug, ativo);
    const existente = ent.squadPorSlug.get(slug);
    if (!existente) planejadoSquads.criar.push(slug);
    else if (existente.nome !== nome || existente.ativo !== ativo) planejadoSquads.atualizar.push(slug);
    else planejadoSquads.inalterado.push(slug);
  }
  // squads que existem no DB e não estão no plano: ficam como estão
  for (const [slug, s] of ent.squadPorSlug) {
    if (!squadAtivoEfetivo.has(slug)) squadAtivoEfetivo.set(slug, s.ativo);
  }
  const squadConhecido = (slug) => squadAtivoEfetivo.has(slug);

  // ── membros ──
  const principalPorUser = new Map();   // userId -> qtd principal:true no plano
  const membershipsPlanoPorUser = new Map(); // userId -> Set(slug)
  const planejadoMembros = { criar: 0, reativar: 0, atualizar: 0, inalterado: 0 };
  for (const [i, m] of membros.entries()) {
    const ctx = `membros[${i}]`;
    const slug = normalizarSlug(txt(m?.squad));
    if (!slug || !squadConhecido(slug)) {
      col.erro(ctx, `squad "${txt(m?.squad)}" não existe (nem no plano nem no banco).`);
      continue;
    }
    const user = ent.resolverUser(m?.usuario);
    if (!user) { col.erro(ctx, `usuário "${txt(m?.usuario)}" não encontrado.`); continue; }
    if (!ROLES_INTERNAS.has(String(user.role).toLowerCase())) {
      col.aviso(ctx, `usuário ${user.email} tem role "${user.role}" (não interna) — membership de Squad não faz efeito para essa role.`);
    }
    if (user.ativo === false) col.aviso(ctx, `usuário ${user.email} está inativo.`);
    const funcao = txt(m?.funcao) || "membro";
    if (!FUNCOES_SQUAD.has(funcao)) { col.erro(ctx, `funcao "${funcao}" inválida (membro|coordenador).`); continue; }
    if (m?.principal !== undefined && typeof m.principal !== "boolean") {
      col.erro(ctx, `"principal" deve ser boolean.`); continue;
    }
    if (squadAtivoEfetivo.get(slug) === false) {
      col.erro(ctx, `squad "${slug}" está INATIVO — membership para squad inativo não concede carteira.`);
      continue;
    }
    if (!membershipsPlanoPorUser.has(user.id)) membershipsPlanoPorUser.set(user.id, new Set());
    if (membershipsPlanoPorUser.get(user.id).has(slug)) {
      col.erro(ctx, `membership duplicada no plano: ${user.email} em "${slug}".`);
      continue;
    }
    membershipsPlanoPorUser.get(user.id).add(slug);
    if (m.principal === true) principalPorUser.set(user.id, (principalPorUser.get(user.id) || 0) + 1);

    const existentes = ent.membershipsPorUser.get(user.id) || [];
    const jaTem = existentes.find((e) => e.squad_slug === slug);
    if (!jaTem) planejadoMembros.criar += 1;
    else if (jaTem.ativo === false) planejadoMembros.reativar += 1;
    else if (jaTem.funcao !== funcao) planejadoMembros.atualizar += 1;
    else planejadoMembros.inalterado += 1;
  }
  // principal duplicado no plano
  for (const [uid, qtd] of principalPorUser) {
    if (qtd > 1) col.erro("membros", `usuário id=${uid} marcado como principal em ${qtd} squads no plano.`);
  }
  // usuário sem principal (após plano + DB)
  for (const [uid, slugs] of membershipsPlanoPorUser) {
    const existentes = ent.membershipsPorUser.get(uid) || [];
    const temPrincipalDB = existentes.some((e) => e.ativo && e.is_primary);
    const temPrincipalPlano = (principalPorUser.get(uid) || 0) >= 1;
    const temMembershipAtivaDB = existentes.some((e) => e.ativo);
    if (!temPrincipalPlano && !temPrincipalDB) {
      if (temMembershipAtivaDB || slugs.size >= 1) {
        col.aviso("membros", `usuário id=${uid} ficará sem principal explícito — a 1ª membership será auto-promovida a principal.`);
      }
    }
  }

  // ── clientes ──
  const clienteSquadNoPlano = new Map(); // cliId -> slug
  const planejadoClientes = { atribuir: [], transferir: [], inalterado: [] };
  for (const [i, c] of clientes.entries()) {
    const ctx = `clientes[${i}]`;
    const cli = ent.resolverCliente(c?.cliente);
    if (!cli) { col.erro(ctx, `cliente "${txt(c?.cliente)}" não encontrado.`); continue; }
    if (cli.ativo === false) col.aviso(ctx, `cliente ${cli.slug} está inativo.`);
    const slug = normalizarSlug(txt(c?.squad));
    if (!slug || !squadConhecido(slug)) {
      col.erro(ctx, `squad "${txt(c?.squad)}" não existe (nem no plano nem no banco).`);
      continue;
    }
    if (squadAtivoEfetivo.get(slug) === false) {
      col.erro(ctx, `squad "${slug}" está INATIVO — não é possível atribuir cliente a squad inativo.`);
      continue;
    }
    if (clienteSquadNoPlano.has(cli.id)) {
      const anterior = clienteSquadNoPlano.get(cli.id);
      if (anterior !== slug) col.erro(ctx, `cliente ${cli.slug} aparece em 2 squads no plano ("${anterior}" e "${slug}").`);
      else col.aviso(ctx, `cliente ${cli.slug} repetido no plano para o mesmo squad "${slug}".`);
      continue;
    }
    clienteSquadNoPlano.set(cli.id, slug);
    const vinc = ent.vinculoPorCliente.get(cli.id);
    if (!vinc) planejadoClientes.atribuir.push(cli.slug);
    else if (vinc.squad_slug === slug) planejadoClientes.inalterado.push(cli.slug);
    else {
      planejadoClientes.transferir.push({ cliente: cli.slug, de: vinc.squad_slug, para: slug });
      col.aviso(ctx, `cliente ${cli.slug} será TRANSFERIDO de "${vinc.squad_slug}" para "${slug}" (histórico preservado).`);
    }
  }

  // ── responsaveis (opcional) ──
  const respNoPlano = new Set();
  const planejadoResp = { criar: 0, inalterado: 0 };
  for (const [i, r] of responsaveis.entries()) {
    const ctx = `responsaveis[${i}]`;
    const cli = ent.resolverCliente(r?.cliente);
    if (!cli) { col.erro(ctx, `cliente "${txt(r?.cliente)}" não encontrado.`); continue; }
    const user = ent.resolverUser(r?.usuario);
    if (!user) { col.erro(ctx, `usuário "${txt(r?.usuario)}" não encontrado.`); continue; }
    const papel = txt(r?.papel);
    if (!PAPEIS_RESP.has(papel)) { col.erro(ctx, `papel "${papel}" inválido (gestor|auxiliar|designer).`); continue; }
    const chave = `${cli.id}:${user.id}:${papel}`;
    if (respNoPlano.has(chave)) { col.aviso(ctx, `responsável repetido no plano: ${cli.slug}/${user.email}/${papel}.`); continue; }
    respNoPlano.add(chave);
    planejadoResp.criar += 1; // INSERT ... ON CONFLICT DO UPDATE (idempotente)
  }

  const planejado = {
    squads: planejadoSquads,
    membros: planejadoMembros,
    clientes: planejadoClientes,
    responsaveis: planejadoResp,
  };

  return {
    ok: col.erros.length === 0,
    erros: col.erros,
    avisos: col.avisos,
    plano,
    planejado,
  };
}

/* ────────────────────────────── totais ────────────────────────────── */

async function totaisAtuais(db) {
  const { rows } = await db.query(`/* squads:MIG_TOTAIS */
    SELECT
      (SELECT COUNT(*)::int FROM squads) AS squads,
      (SELECT COUNT(*)::int FROM squads WHERE ativo) AS squads_ativos,
      (SELECT COUNT(*)::int FROM squad_members WHERE ativo) AS memberships_ativas,
      (SELECT COUNT(*)::int FROM cliente_squad_history WHERE fim_em IS NULL) AS vinculos_ativos,
      (SELECT COUNT(*)::int FROM cliente_responsaveis WHERE ativo) AS responsaveis_ativos`);
  return rows[0];
}

async function snapshot(db, { garantirSchema = true } = {}) {
  const [aud, tot] = await Promise.all([auditoria(db, { garantirSchema }), totaisAtuais(db)]);
  return { auditoria: aud, totais: tot };
}

/* ────────────────────────────── execução ────────────────────────────── */

// Aplica o plano numa ÚNICA transação (tudo ou nada) e idempotente.
// { dryRun } default true. Só escreve com { dryRun: false }.
//
// `garantirSchema` (P2.9, T-3): em dry-run, passar `false` torna a operação
// inteira ZERO-WRITE — nem o DDL de schema é emitido. Num `--apply` a garantia
// do schema é escrita legítima e continua acontecendo, independente da flag.
async function importar(planoBruto, { actorId = null, dryRun = true, garantirSchema } = {}, db = pool) {
  const garantir = garantirSchema === undefined ? true : Boolean(garantirSchema);
  // O apply escreve de qualquer forma; recusar o schema ali só quebraria o apply.
  const garantirEfetivo = dryRun ? garantir : true;
  if (garantirEfetivo) await ensureSquadsTables(db);

  const antes = await snapshot(db, { garantirSchema: garantirEfetivo });
  const validacao = await validarPlano(planoBruto, db, { garantirSchema: garantirEfetivo });

  const base = {
    dryRun,
    ok: validacao.ok,
    erros: validacao.erros,
    avisos: validacao.avisos,
    planejado: validacao.planejado,
    antes,
  };

  if (!validacao.ok) return { ...base, aplicado: false, motivo: "plano inválido — nada foi escrito." };
  if (dryRun) return { ...base, aplicado: false, motivo: "dry-run — nada foi escrito." };

  const plano = validacao.plano;
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 1. squads (upsert por slug)
    const squadIdPorSlug = new Map();
    for (const s of plano.squads || []) {
      const slug = normalizarSlug(txt(s.slug));
      const ativo = s.ativo === undefined ? true : Boolean(s.ativo);
      const { rows } = await client.query(
        `INSERT INTO squads (nome, slug, ativo) VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO UPDATE SET nome = EXCLUDED.nome, ativo = EXCLUDED.ativo, updated_at = NOW()
         RETURNING id`,
        [txt(s.nome), slug, ativo]
      );
      squadIdPorSlug.set(slug, rows[0].id);
    }
    // slugs referenciados mas não no plano → buscar id
    const refSlugs = new Set();
    for (const m of plano.membros || []) refSlugs.add(normalizarSlug(txt(m.squad)));
    for (const c of plano.clientes || []) refSlugs.add(normalizarSlug(txt(c.squad)));
    const faltando = [...refSlugs].filter((s) => s && !squadIdPorSlug.has(s));
    if (faltando.length) {
      const { rows } = await client.query(
        `SELECT id, slug FROM squads WHERE slug = ANY($1::text[])`, [faltando]
      );
      for (const r of rows) squadIdPorSlug.set(r.slug, r.id);
    }

    const ent = await resolverEntidades(plano, client);
    const resumo = { squadsCriados: 0, squadsAtualizados: 0, membershipsUpsert: 0, clientesAtribuidos: 0, clientesTransferidos: 0, responsaveisUpsert: 0 };

    // 2. memberships
    const jaTemPrincipal = new Set();
    for (const row of [...ent.membershipsPorUser.values()].flat()) {
      if (row.ativo && row.is_primary) jaTemPrincipal.add(row.user_id);
    }
    for (const m of plano.membros || []) {
      const slug = normalizarSlug(txt(m.squad));
      const squadId = squadIdPorSlug.get(slug);
      const user = ent.resolverUser(m.usuario);
      const funcao = txt(m.funcao) || "membro";
      const seraPrincipal = m.principal === true || !jaTemPrincipal.has(user.id);
      if (seraPrincipal) {
        await client.query(
          `UPDATE squad_members SET is_primary = false, updated_at = NOW()
            WHERE user_id = $1 AND is_primary = true`,
          [user.id]
        );
        jaTemPrincipal.add(user.id);
      }
      await client.query(
        `INSERT INTO squad_members (squad_id, user_id, is_primary, funcao, ativo)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT (squad_id, user_id) DO UPDATE
           SET ativo = true, funcao = EXCLUDED.funcao,
               is_primary = CASE WHEN $3 THEN true ELSE squad_members.is_primary END,
               updated_at = NOW()`,
        [squadId, user.id, seraPrincipal, funcao]
      );
      resumo.membershipsUpsert += 1;
    }

    // 3. clientes → squad (atribuir ou transferir)
    for (const c of plano.clientes || []) {
      const cli = ent.resolverCliente(c.cliente);
      const slug = normalizarSlug(txt(c.squad));
      const squadId = squadIdPorSlug.get(slug);
      const atual = await client.query(
        `SELECT id, squad_id FROM cliente_squad_history
          WHERE cliente_id = $1 AND fim_em IS NULL FOR UPDATE`,
        [cli.id]
      );
      if (!atual.rows.length) {
        await client.query(
          `INSERT INTO cliente_squad_history (cliente_id, squad_id, alterado_por, motivo)
           VALUES ($1, $2, $3, $4)`,
          [cli.id, squadId, actorId, txt(c.motivo) || "migração P2.3"]
        );
        resumo.clientesAtribuidos += 1;
      } else if (atual.rows[0].squad_id !== squadId) {
        await client.query(`UPDATE cliente_squad_history SET fim_em = NOW() WHERE id = $1`, [atual.rows[0].id]);
        await client.query(
          `INSERT INTO cliente_squad_history (cliente_id, squad_id, alterado_por, motivo)
           VALUES ($1, $2, $3, $4)`,
          [cli.id, squadId, actorId, txt(c.motivo) || "transferência P2.3"]
        );
        // P2.4 — transferência encerra responsabilidades de quem não é membro
        // do Squad de destino. Rodam ANTES do passo 4 (responsaveis do plano),
        // que pode reatribuir o novo gestor logo em seguida. NÃO é autorização.
        await client.query(
          `UPDATE cliente_responsaveis cr
              SET ativo = false, encerrado_em = NOW(), encerrado_por = $2,
                  motivo = 'transferencia_squad', updated_at = NOW()
            WHERE cr.cliente_id = $1 AND cr.ativo = true
              AND NOT EXISTS (
                SELECT 1 FROM squad_members sm
                 WHERE sm.squad_id = $3 AND sm.user_id = cr.user_id AND sm.ativo = true
              )`,
          [cli.id, actorId, squadId]
        );
        resumo.clientesTransferidos += 1;
      } // mesmo squad → no-op (idempotente)
    }

    // 4. responsaveis (opcional, upsert)
    for (const r of plano.responsaveis || []) {
      const cli = ent.resolverCliente(r.cliente);
      const user = ent.resolverUser(r.usuario);
      await client.query(
        `INSERT INTO cliente_responsaveis (cliente_id, user_id, papel, ativo, criado_por)
         VALUES ($1, $2, $3, true, $4)
         ON CONFLICT (cliente_id, user_id, papel) DO UPDATE
           SET ativo = true, encerrado_em = NULL, encerrado_por = NULL,
               motivo = NULL, updated_at = NOW()`,
        [cli.id, user.id, txt(r.papel), actorId]
      );
      resumo.responsaveisUpsert += 1;
    }

    await client.query("COMMIT");
    const depois = await snapshot(db);
    console.log(`[squads] migração P2.3 aplicada por user=${actorId}: ${JSON.stringify(resumo)}`);
    return { ...base, aplicado: true, resumo, depois };
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[squads] migração P2.3 revertida (ROLLBACK):", e.message);
    return {
      ...base,
      aplicado: false,
      motivo: "erro durante a execução — ROLLBACK completo, nada foi escrito.",
      erroExecucao: e.message,
    };
  } finally {
    client.release();
  }
}

module.exports = { validarPlano, importar, snapshot };
