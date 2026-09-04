// server/tests/squadsMigracaoImport.test.js
//
// VenForce V3 — P2.3 (Migration Tooling).
//
// Cobre squadsMigracaoImportService:
//   - validarPlano (dry-run): toda a matriz de validação exigida
//       squad inexistente · usuário inexistente · cliente inexistente
//       slug duplicado · membership duplicada · usuário sem principal
//       principal duplicado · cliente sem Squad (atribuir) · cliente em 2 squads
//       cliente em Squad inativo · membership em Squad inativo
//   - importar dry-run não escreve
//   - importar --apply é transacional (erro → ROLLBACK) e idempotente
//   - relatório antes / planejado / depois
//
// Store em memória: implementa os marcadores /* squads:... */ e o SQL cru
// do caminho transacional (INSERT/UPDATE ... ON CONFLICT).

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const pool = require("../config/database");

let checks = 0;
function ok(label, cond) { assert.ok(cond, `FALHOU: ${label}`); checks += 1; console.log(`  ok  ${label}`); }

// ─────────────────────────── store em memória ───────────────────────────

function novoMundo() {
  return {
    squads: [
      { id: 10, slug: "alpha", nome: "Alpha", ativo: true },
      { id: 30, slug: "arquivado", nome: "Arquivado", ativo: false },
    ],
    users: [
      { id: 1, nome: "Ana", email: "ana@vf.com", role: "membro", ativo: true },
      { id: 2, nome: "Bea", email: "bea@vf.com", role: "user", ativo: true },
      { id: 3, nome: "Cadu", email: "cadu@vf.com", role: "membro", ativo: true },
      { id: 9, nome: "Seller", email: "seller@vf.com", role: "seller", ativo: true },
    ],
    clientes: [
      { id: 100, slug: "acme", nome: "Acme", ativo: true },
      { id: 101, slug: "beta-corp", nome: "Beta Corp", ativo: true },
      { id: 102, slug: "gamma", nome: "Gamma", ativo: true },
    ],
    members: [], // {id, squad_id, user_id, is_primary, funcao, ativo}
    history: [], // {id, cliente_id, squad_id, fim_em}
    responsaveis: [], // {id, cliente_id, user_id, papel, ativo}
    _seq: 1000,
  };
}

function snapshot(M) {
  return {
    squads: M.squads.map((o) => ({ ...o })),
    members: M.members.map((o) => ({ ...o })),
    history: M.history.map((o) => ({ ...o })),
    responsaveis: M.responsaveis.map((o) => ({ ...o })),
    _seq: M._seq,
  };
}
function restaurar(M, s) {
  M.squads.length = 0; M.squads.push(...s.squads);
  M.members.length = 0; M.members.push(...s.members);
  M.history.length = 0; M.history.push(...s.history);
  M.responsaveis.length = 0; M.responsaveis.push(...s.responsaveis);
  M._seq = s._seq;
}

function instalar(M, { failOnHistoryInsert = 0 } = {}) {
  const original = { query: pool.query, connect: pool.connect };
  let historyInserts = 0;

  function run(sql, params = []) {
    const q = String(sql).replace(/\s+/g, " ").trim();

    if (/^(CREATE|ALTER|DROP|DO )/i.test(q)) return { rows: [] };

    // ── resolução em lote ──
    if (q.includes("squads:MIG_RESOLVE_SQUADS")) {
      const slugs = params[0] || [];
      return { rows: M.squads.filter((s) => slugs.includes(s.slug)) };
    }
    if (q.includes("squads:MIG_RESOLVE_USERS")) {
      const ids = params[0] || [], emails = params[1] || [];
      return { rows: M.users.filter((u) => ids.includes(u.id) || emails.includes(String(u.email).toLowerCase())) };
    }
    if (q.includes("squads:MIG_RESOLVE_CLIENTES")) {
      const ids = params[0] || [], slugs = params[1] || [];
      return { rows: M.clientes.filter((c) => ids.includes(c.id) || slugs.includes(String(c.slug).toLowerCase())) };
    }
    if (q.includes("squads:MIG_MEMBERSHIPS_EXISTENTES")) {
      const ids = params[0] || [];
      return {
        rows: M.members.filter((m) => ids.includes(m.user_id)).map((m) => {
          const s = M.squads.find((x) => x.id === m.squad_id);
          return { ...m, squad_slug: s.slug, squad_ativo: s.ativo };
        }),
      };
    }
    if (q.includes("squads:MIG_VINCULOS_EXISTENTES")) {
      const ids = params[0] || [];
      return {
        rows: M.history.filter((h) => h.fim_em === null && ids.includes(h.cliente_id)).map((h) => {
          const s = M.squads.find((x) => x.id === h.squad_id);
          return { cliente_id: h.cliente_id, squad_id: h.squad_id, squad_slug: s.slug, squad_ativo: s.ativo };
        }),
      };
    }

    // ── auditoria ──
    if (q.includes("squads:AUDIT_CLIENTES ")) {
      let ativo = 0, comA = 0, inat = 0, sem = 0;
      for (const c of M.clientes) {
        if (!c.ativo) continue; ativo++;
        const h = M.history.find((x) => x.cliente_id === c.id && x.fim_em === null);
        if (!h) { sem++; continue; }
        const s = M.squads.find((x) => x.id === h.squad_id);
        if (s.ativo) comA++; else inat++;
      }
      return { rows: [{ ativos: ativo, com_squad_ativo: comA, em_squad_inativo: inat, sem_squad: sem }] };
    }
    if (q.includes("squads:AUDIT_CLIENTES_SEM_SQUAD")) {
      return { rows: M.clientes.filter((c) => c.ativo && !M.history.some((h) => h.cliente_id === c.id && h.fim_em === null)) };
    }
    if (q.includes("squads:AUDIT_CLIENTES_SQUAD_INATIVO")) {
      return { rows: M.clientes.filter((c) => {
        const h = M.history.find((x) => x.cliente_id === c.id && x.fim_em === null);
        return h && !M.squads.find((s) => s.id === h.squad_id).ativo;
      }) };
    }
    if (q.includes("squads:AUDIT_USUARIOS")) {
      // P2.9 T-2: este double simula `squads:AUDIT_USUARIOS`, que é a query da
      // AUDITORIA — e a auditoria NÃO cobra admin. A lista aqui estava com
      // `admin` (a do importador), simulando um comportamento que a produção
      // não tem. Hoje é inerte porque nenhuma fixture tem role admin, mas no
      // dia em que tivesse, o double e o gate discordariam em silêncio.
      const ROLES = require("../services/squads/rolesInternas").ROLES_COBRADAS_NA_AUDITORIA.set;
      const internos = M.users.filter((u) => u.ativo && ROLES.has(u.role.toLowerCase()));
      let comM = 0, semM = 0, soInat = 0, multi = 0, multiOk = 0, semP = 0;
      for (const u of internos) {
        const ms = M.members.filter((m) => m.user_id === u.id && m.ativo);
        const ativas = ms.length;
        const principais = ms.filter((m) => m.is_primary).length;
        const emAtivo = ms.filter((m) => M.squads.find((s) => s.id === m.squad_id).ativo).length;
        if (ativas > 0) comM++; else { semM++; continue; }
        if (emAtivo === 0) soInat++;
        if (ativas > 1) multi++;
        if (ativas > 1 && principais === 1 && emAtivo >= 1) multiOk++;
        if (principais === 0) semP++;
      }
      return { rows: [{ internos: internos.length, com_membership: comM, sem_membership: semM, apenas_squad_inativo: soInat, com_multiplas: multi, multi_squad_valido: multiOk, sem_principal: semP }] };
    }
    if (q.includes("squads:AUDIT_PRINCIPAL_DUPLICADO")) return { rows: [] };
    if (q.includes("squads:MIG_TOTAIS")) {
      return { rows: [{
        squads: M.squads.length,
        squads_ativos: M.squads.filter((s) => s.ativo).length,
        memberships_ativas: M.members.filter((m) => m.ativo).length,
        vinculos_ativos: M.history.filter((h) => h.fim_em === null).length,
        responsaveis_ativos: M.responsaveis.filter((r) => r.ativo).length,
      }] };
    }

    // ── apply: SQL cru ──
    if (/^INSERT INTO squads /i.test(q)) {
      const [nome, slug, ativo] = params;
      let s = M.squads.find((x) => x.slug === slug);
      if (s) { s.nome = nome; s.ativo = ativo; }
      else { s = { id: ++M._seq, slug, nome, ativo }; M.squads.push(s); }
      return { rows: [{ id: s.id }] };
    }
    if (/^SELECT id, slug FROM squads WHERE slug = ANY/i.test(q)) {
      const slugs = params[0] || [];
      return { rows: M.squads.filter((s) => slugs.includes(s.slug)).map((s) => ({ id: s.id, slug: s.slug })) };
    }
    if (/^UPDATE squad_members SET is_primary = false/i.test(q)) {
      for (const m of M.members) if (m.user_id === params[0] && m.is_primary) m.is_primary = false;
      return { rows: [] };
    }
    if (/^INSERT INTO squad_members /i.test(q)) {
      const [squad_id, user_id, isPrimary, funcao] = params;
      let m = M.members.find((x) => x.squad_id === squad_id && x.user_id === user_id);
      if (m) { m.ativo = true; m.funcao = funcao; if (isPrimary) m.is_primary = true; }
      else { m = { id: ++M._seq, squad_id, user_id, is_primary: !!isPrimary, funcao, ativo: true }; M.members.push(m); }
      return { rows: [] };
    }
    if (/^SELECT id, squad_id FROM cliente_squad_history WHERE cliente_id = \$1 AND fim_em IS NULL/i.test(q)) {
      const h = M.history.find((x) => x.cliente_id === params[0] && x.fim_em === null);
      return { rows: h ? [{ id: h.id, squad_id: h.squad_id }] : [] };
    }
    if (/^UPDATE cliente_squad_history SET fim_em = NOW\(\) WHERE id = \$1/i.test(q)) {
      const h = M.history.find((x) => x.id === params[0]);
      if (h) h.fim_em = new Date().toISOString();
      return { rows: [] };
    }
    if (/^INSERT INTO cliente_squad_history /i.test(q)) {
      const [cliente_id, squad_id] = params;
      historyInserts += 1;
      if (failOnHistoryInsert && historyInserts === failOnHistoryInsert) {
        throw new Error("falha simulada no lote crítico");
      }
      M.history.push({ id: ++M._seq, cliente_id, squad_id, fim_em: null });
      return { rows: [] };
    }
    if (/^INSERT INTO cliente_responsaveis /i.test(q)) {
      const [cliente_id, user_id, papel] = params;
      let r = M.responsaveis.find((x) => x.cliente_id === cliente_id && x.user_id === user_id && x.papel === papel);
      if (r) { r.ativo = true; r.encerrado_em = null; }
      else M.responsaveis.push({ id: ++M._seq, cliente_id, user_id, papel, ativo: true });
      return { rows: [] };
    }
    // P2.4 — transferência encerra responsáveis sem membership no squad destino.
    if (/^UPDATE cliente_responsaveis cr\s+SET ativo = false/i.test(q)) {
      const [cliente_id, , squad_destino] = params;
      for (const r of M.responsaveis) {
        if (r.cliente_id !== cliente_id || !r.ativo) continue;
        const temAcesso = M.members.some((m) => m.squad_id === squad_destino && m.user_id === r.user_id && m.ativo);
        if (!temAcesso) { r.ativo = false; r.encerrado_em = new Date().toISOString(); r.motivo = "transferencia_squad"; }
      }
      return { rows: [] };
    }

    return { rows: [] };
  }

  pool.query = async (sql, params) => run(sql, params);
  pool.connect = async () => {
    let snap = null;
    return {
      query: async (sql, params) => {
        const q = String(sql).replace(/\s+/g, " ").trim().toUpperCase();
        if (q === "BEGIN") { snap = snapshot(M); return { rows: [] }; }
        if (q === "ROLLBACK") { if (snap) restaurar(M, snap); snap = null; return { rows: [] }; }
        if (q === "COMMIT") { snap = null; return { rows: [] }; }
        return run(sql, params);
      },
      release: () => {},
    };
  };

  return () => { pool.query = original.query; pool.connect = original.connect; };
}

// ─────────────────────────────── casos ───────────────────────────────

async function run() {
  const svc = require("../services/squads/squadsMigracaoImportService");

  // ── 1. plano válido: dry-run não escreve ──
  {
    const M = novoMundo();
    const restore = instalar(M);
    const plano = {
      versao: 1,
      squads: [{ slug: "beta", nome: "Beta" }],
      membros: [{ squad: "beta", usuario: "ana@vf.com", funcao: "coordenador", principal: true }],
      clientes: [{ cliente: "acme", squad: "beta" }],
    };
    const r = await svc.importar(plano, { dryRun: true });
    ok("dry-run: ok=true", r.ok === true);
    ok("dry-run: aplicado=false", r.aplicado === false);
    ok("dry-run: nada escrito (0 squads novos)", M.squads.length === 2 && M.members.length === 0 && M.history.length === 0);
    ok("dry-run: planejado.squads.criar = [beta]", r.planejado.squads.criar.join() === "beta");
    ok("dry-run: planejado.clientes.atribuir = [acme]", r.planejado.clientes.atribuir.join() === "acme");
    ok("dry-run: relatório tem antes.auditoria", r.antes && r.antes.auditoria && typeof r.antes.auditoria.pronto === "boolean");
    restore();
  }

  // ── 2. matriz de validação ──
  {
    const M = novoMundo();
    const restore = instalar(M);
    const v = await svc.validarPlano({
      squads: [
        { slug: "dup", nome: "D1" },
        { slug: "dup", nome: "D2" },        // slug duplicado
      ],
      membros: [
        { squad: "inexistente", usuario: "ana@vf.com" },       // squad inexistente
        { squad: "alpha", usuario: "fantasma@vf.com" },        // usuário inexistente
        { squad: "arquivado", usuario: "ana@vf.com" },         // membership em squad inativo
        { squad: "alpha", usuario: "bea@vf.com", principal: true },
        { squad: "dup", usuario: "bea@vf.com", principal: true }, // principal duplicado (bea)
        { squad: "alpha", usuario: "cadu@vf.com" },
        { squad: "alpha", usuario: "cadu@vf.com" },            // membership duplicada
      ],
      clientes: [
        { cliente: "nao-existe", squad: "alpha" },             // cliente inexistente
        { cliente: "acme", squad: "alpha" },
        { cliente: "acme", squad: "dup" },                     // cliente em 2 squads no plano
        { cliente: "beta-corp", squad: "arquivado" },          // atribuir a squad inativo
      ],
    });
    const msgs = v.erros.map((e) => e.msg).join(" || ");
    ok("erro: slug duplicado", /slug "dup" duplicado/.test(msgs));
    ok("erro: squad inexistente", /squad "inexistente" não existe/.test(msgs));
    ok("erro: usuário inexistente", /usuário "fantasma@vf.com" não encontrado/.test(msgs));
    ok("erro: membership em squad inativo", /squad "arquivado" está INATIVO/.test(msgs));
    ok("erro: principal duplicado no plano", /principal em 2 squads no plano/.test(msgs));
    ok("erro: membership duplicada", /membership duplicada no plano/.test(msgs));
    ok("erro: cliente inexistente", /cliente "nao-existe" não encontrado/.test(msgs));
    ok("erro: cliente em 2 squads", /aparece em 2 squads no plano/.test(msgs));
    ok("erro: atribuir cliente a squad inativo", /não é possível atribuir cliente a squad inativo/.test(msgs));
    ok("validação falha (ok=false)", v.ok === false);
    restore();
  }

  // ── 3. usuário sem principal → aviso (não erro) + auto-promoção ──
  {
    const M = novoMundo();
    const restore = instalar(M);
    const v = await svc.validarPlano({
      squads: [{ slug: "z", nome: "Z" }],
      membros: [{ squad: "z", usuario: "cadu@vf.com" }], // sem principal:true, sem membership no DB
    });
    ok("sem principal: sem erro", v.ok === true);
    ok("sem principal: emite aviso de auto-promoção", v.avisos.some((a) => /auto-promovida a principal/.test(a.msg)));
    restore();
  }

  // ── 4. cliente já em outro squad → transferência (aviso) ──
  {
    const M = novoMundo();
    M.history.push({ id: 500, cliente_id: 100, squad_id: 10, fim_em: null }); // acme já em alpha
    const restore = instalar(M);
    const v = await svc.validarPlano({
      squads: [{ slug: "novo", nome: "Novo" }],
      clientes: [{ cliente: "acme", squad: "novo" }],
    });
    ok("transferência: sem erro", v.ok === true);
    ok("transferência: planejado.clientes.transferir tem acme", v.planejado.clientes.transferir.some((t) => t.cliente === "acme" && t.de === "alpha" && t.para === "novo"));
    ok("transferência: aviso emitido", v.avisos.some((a) => /será TRANSFERIDO/.test(a.msg)));
    restore();
  }

  // ── 5. apply real: escreve, e é idempotente ──
  {
    const M = novoMundo();
    const restore = instalar(M);
    const plano = {
      versao: 1,
      squads: [{ slug: "ops", nome: "Ops" }],
      membros: [
        { squad: "ops", usuario: "ana@vf.com", funcao: "coordenador", principal: true },
        { squad: "ops", usuario: "bea@vf.com" },
      ],
      clientes: [
        { cliente: "acme", squad: "ops" },
        { cliente: "beta-corp", squad: "ops" },
      ],
      responsaveis: [{ cliente: "acme", usuario: "ana@vf.com", papel: "gestor" }],
    };
    const r1 = await svc.importar(plano, { actorId: 1, dryRun: false });
    ok("apply: aplicado=true", r1.aplicado === true);
    ok("apply: squad 'ops' criado", M.squads.some((s) => s.slug === "ops"));
    ok("apply: 2 memberships ativas", M.members.filter((m) => m.ativo).length === 2);
    ok("apply: ana é principal", M.members.find((m) => m.user_id === 1).is_primary === true);
    ok("apply: bea auto-promovida a principal (1ª membership dela)", M.members.find((m) => m.user_id === 2).is_primary === true);
    ok("apply: 2 vínculos de cliente", M.history.filter((h) => h.fim_em === null).length === 2);
    ok("apply: 1 responsável", M.responsaveis.filter((x) => x.ativo).length === 1);
    ok("apply: depois.auditoria presente", r1.depois && r1.depois.auditoria);

    const squadsN = M.squads.length, membersN = M.members.length, historyN = M.history.length, respN = M.responsaveis.length;
    const r2 = await svc.importar(plano, { actorId: 1, dryRun: false });
    ok("idempotente: 2ª execução aplicada sem erro", r2.aplicado === true);
    ok("idempotente: nº de squads inalterado", M.squads.length === squadsN);
    ok("idempotente: nº de memberships inalterado", M.members.length === membersN);
    ok("idempotente: nº de linhas de histórico inalterado (mesmo squad → no-op)", M.history.length === historyN);
    ok("idempotente: nº de responsáveis inalterado", M.responsaveis.length === respN);
    restore();
  }

  // ── 6. transacional: erro no meio → ROLLBACK, nada escrito ──
  {
    const M = novoMundo();
    const restore = instalar(M, { failOnHistoryInsert: 2 }); // estoura no 2º vínculo
    const r = await svc.importar({
      versao: 1,
      squads: [{ slug: "tx", nome: "Tx" }],
      membros: [{ squad: "tx", usuario: "ana@vf.com", principal: true }],
      clientes: [
        { cliente: "acme", squad: "tx" },
        { cliente: "beta-corp", squad: "tx" },
      ],
    }, { dryRun: false });
    ok("rollback: aplicado=false", r.aplicado === false);
    ok("rollback: erroExecucao reportado", /falha simulada/.test(r.erroExecucao || ""));
    ok("rollback: squad 'tx' NÃO persistido (rollback total)", !M.squads.some((s) => s.slug === "tx"));
    ok("rollback: nenhuma membership persistida", M.members.length === 0);
    ok("rollback: nenhum vínculo de cliente persistido", M.history.length === 0);
    restore();
  }

  // ── 7. P2.4: transferência de squad encerra responsável sem acesso ao destino ──
  {
    const M = novoMundo();
    const restore = instalar(M);
    // estado inicial: acme em alpha; ana (só em alpha) é gestora de acme.
    await svc.importar({
      versao: 1,
      squads: [{ slug: "alpha", nome: "Alpha" }, { slug: "beta", nome: "Beta" }],
      membros: [
        { squad: "alpha", usuario: "ana@vf.com", principal: true },
        { squad: "beta", usuario: "bea@vf.com", principal: true },
      ],
      clientes: [{ cliente: "acme", squad: "alpha" }],
      responsaveis: [{ cliente: "acme", usuario: "ana@vf.com", papel: "gestor" }],
    }, { actorId: 1, dryRun: false });
    ok("P2.4 setup: ana é gestora ativa de acme", M.responsaveis.some((r) => r.cliente_id === 100 && r.user_id === 1 && r.papel === "gestor" && r.ativo));

    // transfere acme para beta e nomeia bea (membro de beta) como gestora.
    const r = await svc.importar({
      versao: 1,
      squads: [{ slug: "beta", nome: "Beta" }],
      clientes: [{ cliente: "acme", squad: "beta" }],
      responsaveis: [{ cliente: "acme", usuario: "bea@vf.com", papel: "gestor" }],
    }, { actorId: 1, dryRun: false });
    ok("P2.4 transfer: aplicado", r.aplicado === true);
    ok("P2.4 transfer: responsabilidade da ana ENCERRADA (sem acesso ao squad destino)",
      M.responsaveis.some((x) => x.cliente_id === 100 && x.user_id === 1 && x.papel === "gestor" && x.ativo === false && x.motivo === "transferencia_squad"));
    ok("P2.4 transfer: bea é a nova gestora ativa de acme",
      M.responsaveis.some((x) => x.cliente_id === 100 && x.user_id === 2 && x.papel === "gestor" && x.ativo === true));
    restore();
  }

  console.log(`\nsquadsMigracaoImport.test.js: ${checks} verificações passaram.`);
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
