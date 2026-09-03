// server/tests/squadsMigracaoAuditoriaY.test.js
//
// V3 P2.8 BLOCO Y — a auditoria de migração precisa detectar tudo que impede
// (ou atrapalha) o rollout, ANTES de qualquer ativação.
//
// P2.3 já cobria: cliente sem Squad, cliente em Squad inativo, usuário interno
// sem membership, usuário só em Squad inativo, múltiplos principais, múltiplas
// memberships. Este arquivo cobre as três detecções que faltavam:
//
//   1. MÚLTIPLOS VÍNCULOS ATIVOS do mesmo cliente — BLOQUEANTE.
//      `cliente_squad_history` modela histórico: o vínculo vigente é a linha
//      com `fim_em IS NULL`, e só pode existir uma. Duas abertas = o cliente
//      pertence a dois Squads ao mesmo tempo e a carteira vira
//      não-determinística. Não se liga enforcement nesse estado.
//
//   2. RESPONSÁVEL POR CLIENTE FORA DO SEU SQUAD — ATENÇÃO, não bloqueante.
//      Não é falha de autorização (responsabilidade nunca concedeu acesso e
//      continua não concedendo). É inconsistência organizacional, e o momento
//      de vê-la é antes do rollout: ao ligar o enforcement, essa pessoa deixa
//      de conseguir abrir justamente o cliente pelo qual responde.
//
//   3. MEMBERSHIP ATIVA DE USUÁRIO DESATIVADO — ATENÇÃO.
//      Não concede acesso (o login já barra), mas infla a contagem de membros
//      e esconde que o Squad pode estar sem gente de verdade.
//
// A auditoria continua NÃO ATRIBUINDO NADA: ela só mostra o que precisa de
// decisão humana.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const pool = require("../config/database");
const squadsRepo = require("../services/squads/squadsRepository");
const { auditoria } = require("../services/squads/squadsMigracaoService");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const LIMPO = {
  AUDIT_CLIENTES: [{ ativos: 3, com_squad_ativo: 3, em_squad_inativo: 0, sem_squad: 0 }],
  AUDIT_CLIENTES_SEM_SQUAD: [],
  AUDIT_CLIENTES_SQUAD_INATIVO: [],
  AUDIT_USUARIOS: [{
    internos: 2, com_membership: 2, sem_membership: 0, apenas_squad_inativo: 0,
    com_multiplas: 0, multi_squad_valido: 0, sem_principal: 0,
  }],
  AUDIT_PRINCIPAL_DUPLICADO: [],
  AUDIT_VINCULOS_DUPLICADOS: [],
  AUDIT_RESPONSAVEL_FORA_DO_SQUAD: [],
  AUDIT_MEMBRO_USUARIO_INATIVO: [],
  // P2.9 T-4: contadores de NÃO-VACUIDADE. O estado LIMPO deste arquivo é uma
  // base povoada e íntegra — precisa de Squad e membership de verdade, senão
  // cai na regra de vacuidade e `pronto` vira false por outro motivo.
  AUDIT_TOTAIS_VACUIDADE: [{ squads_ativos: 2, memberships_ativas: 2 }],
};

async function comAuditoria(overrides, fn) {
  const original = pool.query;
  const originalEnsure = squadsRepo.ensureSquadsTables;
  squadsRepo.ensureSquadsTables = async () => {};
  const fixture = { ...LIMPO, ...overrides };
  const vistas = [];
  pool.query = async (sql) => {
    const q = String(sql);
    const marca = (q.match(/squads:(AUDIT_[A-Z_]+)/) || [])[1];
    vistas.push(marca);
    // ensureSquadsTables reaplica os arquivos de migration (idempotentes) antes
    // de auditar; aqui eles sao no-op.
    if (!marca) {
      if (/CREATE TABLE|ALTER TABLE|CREATE INDEX|^--/m.test(q)) return { rows: [] };
      throw new Error(`Query de auditoria nao mockada: ${q.slice(0, 80)}`);
    }
    if (!(marca in fixture)) throw new Error(`Query de auditoria nao mockada: ${marca}`);
    return { rows: fixture[marca] };
  };
  try { return await fn(vistas); } finally {
    pool.query = original;
    squadsRepo.ensureSquadsTables = originalEnsure;
  }
}

async function run() {
  // ------------------------------------------------------- base limpa
  await comAuditoria({}, async (vistas) => {
    const r = await auditoria();
    ok("base limpa: pronto=true", r.pronto === true);
    ok("base limpa: zero vinculo duplicado", r.integridade.clientesComVinculoDuplicado === 0);
    ok("base limpa: zero responsavel fora do Squad", r.atencao.responsaveisForaDoSquad === 0);
    ok("base limpa: zero membership de usuario inativo", r.atencao.membershipsDeUsuarioInativo === 0);
    ok("as tres checagens novas de fato rodam", vistas.includes("AUDIT_VINCULOS_DUPLICADOS")
      && vistas.includes("AUDIT_RESPONSAVEL_FORA_DO_SQUAD")
      && vistas.includes("AUDIT_MEMBRO_USUARIO_INATIVO"));
  });

  // ---------------------------- 1. vinculo duplicado: BLOQUEIA o rollout
  await comAuditoria({
    AUDIT_VINCULOS_DUPLICADOS: [
      { cliente_id: 7, slug: "acme", nome: "Acme", vinculos_abertos: 2, squad_ids: [1, 2] },
    ],
  }, async () => {
    const r = await auditoria();
    ok("cliente em dois Squads abertos e detectado", r.integridade.clientesComVinculoDuplicado === 1);
    ok("...e isso BLOQUEIA: pronto=false", r.pronto === false);
    ok("...e a lista diz quais Squads disputam o cliente", r.integridade.listaVinculoDuplicado[0].squad_ids.join() === "1,2");
  });

  // ------------------- 2. responsavel fora do Squad: ATENCAO, nao bloqueia
  await comAuditoria({
    AUDIT_RESPONSAVEL_FORA_DO_SQUAD: [
      { cliente_id: 3, slug: "n97", nome: "N97", user_id: 20, papel: "gestor", user_nome: "Ana", user_email: "ana@x.com" },
    ],
  }, async () => {
    const r = await auditoria();
    ok("responsavel por cliente fora do seu Squad e detectado", r.atencao.responsaveisForaDoSquad === 1);
    ok("...mas NAO bloqueia o rollout (responsabilidade nunca foi acesso)", r.pronto === true);
    ok("...e a lista identifica pessoa, papel e cliente", r.atencao.listaResponsaveisForaDoSquad[0].papel === "gestor"
      && r.atencao.listaResponsaveisForaDoSquad[0].slug === "n97");
  });

  // --------------------- 3. membership de usuario inativo: ATENCAO
  await comAuditoria({
    AUDIT_MEMBRO_USUARIO_INATIVO: [
      { user_id: 44, squad_id: 1, user_nome: "Ex-funcionario", squad_slug: "squad-a" },
    ],
  }, async () => {
    const r = await auditoria();
    ok("membership ativa de usuario desativado e detectada", r.atencao.membershipsDeUsuarioInativo === 1);
    ok("...mas NAO bloqueia o rollout (o login ja barra)", r.pronto === true);
  });

  // ------------------------------- contrato legado preservado (P2.3)
  await comAuditoria({
    AUDIT_CLIENTES: [{ ativos: 5, com_squad_ativo: 3, em_squad_inativo: 1, sem_squad: 1 }],
    AUDIT_CLIENTES_SEM_SQUAD: [{ id: 9, slug: "orfao", nome: "Orfao" }],
  }, async () => {
    const r = await auditoria();
    ok("chave legada semSquad preservada", r.clientesAtivos.semSquad === 1);
    ok("chave legada comSquad (ativo + inativo) preservada", r.clientesAtivos.comSquad === 4);
    ok("emSquadInativo continua separado (P2.3)", r.clientesAtivos.emSquadInativo === 1);
    ok("cliente sem Squad continua bloqueando", r.pronto === false);
  });

  // ---------------- multiplos problemas somam sem se esconderem
  await comAuditoria({
    AUDIT_VINCULOS_DUPLICADOS: [{ cliente_id: 7, slug: "a", nome: "A", vinculos_abertos: 2, squad_ids: [1, 2] }],
    AUDIT_RESPONSAVEL_FORA_DO_SQUAD: [{ cliente_id: 3, slug: "b", nome: "B", user_id: 20, papel: "auxiliar", user_nome: "X", user_email: "x@y.z" }],
    AUDIT_MEMBRO_USUARIO_INATIVO: [{ user_id: 44, squad_id: 1, user_nome: "Y", squad_slug: "s" }],
  }, async () => {
    const r = await auditoria();
    ok("bloqueante e atencao coexistem sem um esconder o outro",
      r.pronto === false
      && r.integridade.clientesComVinculoDuplicado === 1
      && r.atencao.responsaveisForaDoSquad === 1
      && r.atencao.membershipsDeUsuarioInativo === 1);
  });

  // ----------------------------------- a auditoria NAO escreve nada
  {
    const original = pool.query;
    const originalEnsure = squadsRepo.ensureSquadsTables;
    squadsRepo.ensureSquadsTables = async () => {};
    const sqls = [];
    pool.query = async (sql) => {
      const q = String(sql);
      sqls.push(q);
      const marca = (q.match(/squads:(AUDIT_[A-Z_]+)/) || [])[1];
      return { rows: LIMPO[marca] || [] };
    };
    try {
      await auditoria();
      const escreve = sqls.some((q) => /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i.test(q));
      ok("auditoria e 100% somente-leitura (nenhum INSERT/UPDATE/DELETE)", !escreve);
    } finally {
      pool.query = original;
      squadsRepo.ensureSquadsTables = originalEnsure;
    }
  }

  console.log(`\nsquadsMigracaoAuditoriaY.test.js: ${checks} verificacoes passaram.`);
}

run().catch((err) => { console.error(err); process.exitCode = 1; });
