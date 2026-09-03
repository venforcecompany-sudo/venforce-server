// server/tests/squadsAuditoriaVacuidade.test.js
//
// V3 P2.9 — BLOQUEADOR T-4: `auditoria().pronto` podia ser verdadeiro POR
// VACUIDADE.
//
// `pronto` era a conjunção de sete contadores "=== 0". Todos medem DEFEITO:
// cliente sem squad, interno sem membership, principal duplicado, vínculo
// duplicado… Numa base VAZIA não existe defeito algum — logo todos são 0 e
// `pronto` virava `true`.
//
// O que isso significa na prática: `rolloutGateBoot` lê exatamente esse
// booleano para decidir entre LIBERADO e BLOQUEADO. Num banco onde a migração
// de Squads nunca aconteceu, o gate diria LIBERADO e o enforcement subiria com
// carteira nenhuma — todo mundo sem acesso a nada.
//
// A correção acrescenta contadores de PRESENÇA (não-vacuidade). A regra é
// assimétrica de propósito: a vacuidade só pode transformar `true` em `false`,
// nunca o contrário. Um estado que já reprovava continua reprovando.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const { auditoria } = require("../services/squads/squadsMigracaoService");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

/* ─────────────── fake de banco dirigido por marcador ─────────────── */

const VAZIO_TOTAL = {
  AUDIT_CLIENTES: [{ ativos: 0, com_squad_ativo: 0, em_squad_inativo: 0, sem_squad: 0 }],
  AUDIT_CLIENTES_SEM_SQUAD: [],
  AUDIT_CLIENTES_SQUAD_INATIVO: [],
  AUDIT_USUARIOS: [{
    internos: 0, com_membership: 0, sem_membership: 0, apenas_squad_inativo: 0,
    com_multiplas: 0, multi_squad_valido: 0, sem_principal: 0,
  }],
  AUDIT_PRINCIPAL_DUPLICADO: [],
  AUDIT_VINCULOS_DUPLICADOS: [],
  AUDIT_RESPONSAVEL_FORA_DO_SQUAD: [],
  AUDIT_MEMBRO_USUARIO_INATIVO: [],
  AUDIT_TOTAIS_VACUIDADE: [{ squads_ativos: 0, memberships_ativas: 0 }],
};

// Base migrada, íntegra e povoada — o único caso que pode declarar GO.
const SAUDAVEL = {
  ...VAZIO_TOTAL,
  AUDIT_CLIENTES: [{ ativos: 82, com_squad_ativo: 82, em_squad_inativo: 0, sem_squad: 0 }],
  AUDIT_USUARIOS: [{
    internos: 20, com_membership: 20, sem_membership: 0, apenas_squad_inativo: 0,
    com_multiplas: 4, multi_squad_valido: 4, sem_principal: 0,
  }],
  AUDIT_TOTAIS_VACUIDADE: [{ squads_ativos: 7, memberships_ativas: 24 }],
};

function db(respostas) {
  return {
    async query(sql, params) {
      for (const [marca, linhas] of Object.entries(respostas)) {
        if (String(sql).includes(marca)) return { rows: linhas };
      }
      if (/to_regclass/i.test(sql)) {
        const nomes = (params && params[0]) || [];
        return { rows: nomes.map((n) => ({ nome: n, existe: true })) };
      }
      return { rows: [] };
    },
  };
}

const zeroWrite = { garantirSchema: false };

/* ────────────────────────────── testes ────────────────────────────── */

async function testarVacuidadeTotal() {
  console.log("\nT-4 · base completamente vazia");
  const a = await auditoria(db(VAZIO_TOTAL), zeroWrite);
  ok("base vazia NÃO é 'pronto'", a.pronto === false);
  ok("vacuidade é reportada como vazia", a.vacuidade && a.vacuidade.vazio === true);
  ok("vacuidade lista os motivos", (a.vacuidade.motivos || []).length >= 5);
  ok("nenhum contador de DEFEITO acusou nada (é exatamente por isso que passava antes)",
    a.clientesAtivos.semSquad === 0 && a.usuariosInternos.semMembership === 0 &&
    a.integridade.clientesComVinculoDuplicado === 0);
}

async function testarCadaRegraIsolada() {
  console.log("\nT-4 · cada regra de vacuidade, isolada");
  const casos = [
    ["nenhum Squad ativo", { AUDIT_TOTAIS_VACUIDADE: [{ squads_ativos: 0, memberships_ativas: 24 }] }],
    ["nenhuma membership ativa", { AUDIT_TOTAIS_VACUIDADE: [{ squads_ativos: 7, memberships_ativas: 0 }] }],
    ["nenhum Cliente ativo", { AUDIT_CLIENTES: [{ ativos: 0, com_squad_ativo: 0, em_squad_inativo: 0, sem_squad: 0 }] }],
    ["nenhum Cliente ativo com Squad ativo", { AUDIT_CLIENTES: [{ ativos: 82, com_squad_ativo: 0, em_squad_inativo: 0, sem_squad: 0 }] }],
    ["nenhum usuário interno ativo", {
      AUDIT_USUARIOS: [{ internos: 0, com_membership: 0, sem_membership: 0, apenas_squad_inativo: 0, com_multiplas: 0, multi_squad_valido: 0, sem_principal: 0 }],
    }],
  ];
  for (const [motivo, override] of casos) {
    const a = await auditoria(db({ ...SAUDAVEL, ...override }), zeroWrite);
    ok(`"${motivo}" sozinho já reprova`, a.pronto === false);
    ok(`"${motivo}" aparece nos motivos`, (a.vacuidade.motivos || []).includes(motivo));
  }
}

async function testarCasoLegitimo() {
  console.log("\nT-4 · o caso legítimo continua liberando");
  const a = await auditoria(db(SAUDAVEL), zeroWrite);
  ok("base migrada, íntegra e povoada → pronto", a.pronto === true);
  ok("e não é considerada vazia", a.vacuidade.vazio === false);
  ok("os números de presença ficam inspecionáveis",
    a.vacuidade.squadsAtivos === 7 && a.vacuidade.membershipsAtivas === 24 &&
    a.vacuidade.clientesAtivos === 82 && a.vacuidade.internosAtivos === 20);
}

async function testarMonotonicidade() {
  console.log("\nT-4 · monotonicidade: a vacuidade só subtrai");
  // Estados que JÁ reprovavam por defeito. Nenhum pode ter virado `pronto`.
  const defeitos = [
    ["cliente sem squad", { AUDIT_CLIENTES: [{ ativos: 82, com_squad_ativo: 80, em_squad_inativo: 0, sem_squad: 2 }] }],
    ["cliente em squad inativo", { AUDIT_CLIENTES: [{ ativos: 82, com_squad_ativo: 80, em_squad_inativo: 2, sem_squad: 0 }] }],
    ["interno sem membership", {
      AUDIT_USUARIOS: [{ internos: 20, com_membership: 18, sem_membership: 2, apenas_squad_inativo: 0, com_multiplas: 0, multi_squad_valido: 0, sem_principal: 0 }],
    }],
    ["interno só em squad inativo", {
      AUDIT_USUARIOS: [{ internos: 20, com_membership: 20, sem_membership: 0, apenas_squad_inativo: 3, com_multiplas: 0, multi_squad_valido: 0, sem_principal: 0 }],
    }],
    ["interno sem principal", {
      AUDIT_USUARIOS: [{ internos: 20, com_membership: 20, sem_membership: 0, apenas_squad_inativo: 0, com_multiplas: 0, multi_squad_valido: 0, sem_principal: 1 }],
    }],
    ["principal duplicado", { AUDIT_PRINCIPAL_DUPLICADO: [{ user_id: 9, principais: 2 }] }],
    ["vínculo duplicado", { AUDIT_VINCULOS_DUPLICADOS: [{ cliente_id: 1, slug: "x", nome: "X", vinculos_abertos: 2, squad_ids: [1, 2] }] }],
  ];
  for (const [nome, override] of defeitos) {
    const a = await auditoria(db({ ...SAUDAVEL, ...override }), zeroWrite);
    ok(`"${nome}" continua reprovando`, a.pronto === false);
  }
  // E o inverso: vacuidade + defeito também reprova (não há como somar dois
  // erros e obter um acerto).
  const a = await auditoria(db({ ...VAZIO_TOTAL, AUDIT_PRINCIPAL_DUPLICADO: [{ user_id: 1, principais: 2 }] }), zeroWrite);
  ok("vazio + defeito continua reprovando", a.pronto === false);
}

async function testarSchemaAusenteNaoLibera() {
  console.log("\nT-4 · schema ausente nunca libera");
  const semSchema = {
    async query(sql, params) {
      if (/to_regclass/i.test(sql)) {
        const nomes = (params && params[0]) || [];
        return { rows: nomes.map((n) => ({ nome: n, existe: false })) };
      }
      return { rows: [] };
    },
  };
  const a = await auditoria(semSchema, zeroWrite);
  ok("schema ausente → pronto false", a.pronto === false);
  ok("schema ausente → erro explícito", typeof a.erro === "string" && /schema/i.test(a.erro));
}

(async () => {
  await testarVacuidadeTotal();
  await testarCadaRegraIsolada();
  await testarCasoLegitimo();
  await testarMonotonicidade();
  await testarSchemaAusenteNaoLibera();
  console.log(`\n✔ squadsAuditoriaVacuidade: ${checks} verificações OK\n`);
})().catch((e) => { console.error(e); process.exit(1); });
