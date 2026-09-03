// server/tests/squadsRolesInternas.test.js
//
// V3 P2.9 — BLOQUEADOR T-2: `ROLES_INTERNAS` existia em 7 lugares, e em dois
// deles com valor DIFERENTE — o importador de migração incluía `admin`, a
// auditoria e a autorização não. Nada documentava a diferença, então parecia
// bug e convidava a uma "limpeza" que teria sido uma regressão grave.
//
// A divergência é INTENCIONAL e as duas respostas são diferentes porque as
// perguntas são diferentes:
//
//   "quem PODE ter membership?"   → inclui admin  (um admin pode coordenar)
//   "de quem se COBRA membership?" → exclui admin  (admin tem bypass)
//
// Se `admin` entrasse no conjunto COBRADO, `auditoria().pronto` exigiria que
// todo admin tivesse membership; como admin naturalmente não tem, o contador
// `semMembership` nunca zeraria e o rollout gate ficaria BLOQUEADO para
// sempre. O enforcement nunca poderia ser ligado.
//
// Este arquivo prova três coisas: (1) existe UMA fonte canônica; (2) a
// divergência está nomeada e é exatamente `admin`; (3) nenhum consumidor
// redefine o conjunto por conta própria.

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost/vf-test";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  ROLES_ELEGIVEIS_MEMBERSHIP,
  ROLES_COBRADAS_NA_AUDITORIA,
  DIVERGENCIA_INTENCIONAL,
} = require("../services/squads/rolesInternas");

let checks = 0;
function ok(label, condition) {
  assert.ok(condition, `FALHOU: ${label}`);
  checks += 1;
  console.log(`  ok  ${label}`);
}

const RAIZ = path.join(__dirname, "..");
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), "utf8");

/** Todos os arquivos que decidem quem é "interno". */
const CONSUMIDORES = [
  "services/squads/squadsMigracaoService.js",
  "services/squads/squadsMigracaoImportService.js",
  "services/squads/authorizationService.js",
  "sql/squads-inventario-readonly.js",
  "sql/squads-preflight-relacao.js",
];

/* ─────────────────────── 1. a divergência é nomeada ─────────────────────── */

function testarDivergencia() {
  console.log("\nT-2 · a divergência é intencional e está nomeada");
  const elegiveis = ROLES_ELEGIVEIS_MEMBERSHIP.set;
  const cobradas = ROLES_COBRADAS_NA_AUDITORIA.set;

  ok("admin PODE ter membership", elegiveis.has("admin"));
  ok("admin NÃO é cobrado pela auditoria", !cobradas.has("admin"));

  const diferenca = [...elegiveis].filter((r) => !cobradas.has(r)).sort();
  ok(`a diferença entre os conjuntos é exatamente ${JSON.stringify(DIVERGENCIA_INTENCIONAL.roles)}`,
    JSON.stringify(diferenca) === JSON.stringify([...DIVERGENCIA_INTENCIONAL.roles].sort()));

  ok("nada é cobrado sem ser elegível (cobradas ⊆ elegíveis)",
    [...cobradas].every((r) => elegiveis.has(r)));

  ok("a divergência carrega o motivo por escrito",
    typeof DIVERGENCIA_INTENCIONAL.motivo === "string" &&
    /bypass/i.test(DIVERGENCIA_INTENCIONAL.motivo) &&
    /pronto|gate|enforcement/i.test(DIVERGENCIA_INTENCIONAL.motivo));

  ok("os conjuntos são imutáveis (ninguém muta a fonte canônica em runtime)",
    Object.isFrozen(ROLES_ELEGIVEIS_MEMBERSHIP) && Object.isFrozen(ROLES_COBRADAS_NA_AUDITORIA) &&
    Object.isFrozen(ROLES_ELEGIVEIS_MEMBERSHIP.lista));

  ok("cada conjunto vem nas duas formas que os consumidores precisam (set e lista)",
    ROLES_ELEGIVEIS_MEMBERSHIP.set instanceof Set && Array.isArray(ROLES_ELEGIVEIS_MEMBERSHIP.lista) &&
    ROLES_COBRADAS_NA_AUDITORIA.set instanceof Set && Array.isArray(ROLES_COBRADAS_NA_AUDITORIA.lista));
}

/* ──────────────── 2. existe UMA definição literal, e é a canônica ──────────────── */

/** Acha literais do tipo ["user","membro","interno"...] no fonte. */
function literaisDeRoles(fonte) {
  const encontrados = [];
  const re = /\[\s*("(?:user|membro|interno|admin)"|'(?:user|membro|interno|admin)')[^\]]*\]/g;
  let m;
  while ((m = re.exec(fonte)) !== null) {
    const bruto = m[0];
    const roles = (bruto.match(/["'](user|membro|interno|admin)["']/g) || [])
      .map((s) => s.replace(/["']/g, ""));
    if (roles.length >= 3) encontrados.push({ bruto: bruto.replace(/\s+/g, " "), roles });
  }
  return encontrados;
}

function testarFonteUnica() {
  console.log("\nT-2 · uma única definição literal, no módulo canônico");

  const canonico = ler("services/squads/rolesInternas.js");
  const noCanonico = literaisDeRoles(canonico);
  ok(`o módulo canônico define exatamente 2 conjuntos (achou ${noCanonico.length})`,
    noCanonico.length === 2);

  for (const arquivo of CONSUMIDORES) {
    const fonte = ler(arquivo);
    const literais = literaisDeRoles(fonte);
    ok(`${arquivo} não redefine o conjunto por conta própria (achou ${literais.length}: ${literais.map((l) => l.bruto).join(" · ")})`,
      literais.length === 0);
  }
}

function testarConsumidoresImportam() {
  console.log("\nT-2 · todo consumidor importa da fonte canônica");
  for (const arquivo of CONSUMIDORES) {
    const fonte = ler(arquivo);
    ok(`${arquivo} importa rolesInternas`, /require\((?:"|')[^"']*rolesInternas(?:"|')\)/.test(fonte));
  }
}

/* ───────── 3. o comportamento que a divergência protege continua de pé ───────── */

async function testarComportamentoDoGate() {
  console.log("\nT-2 · o gate continua usando o conjunto SEM admin");
  const { auditoria } = require("../services/squads/squadsMigracaoService");

  let rolesUsadas = null;
  const db = {
    async query(sql, params) {
      if (String(sql).includes("AUDIT_USUARIOS")) {
        rolesUsadas = params && params[0];
        return { rows: [{ internos: 20, com_membership: 20, sem_membership: 0, apenas_squad_inativo: 0, com_multiplas: 0, multi_squad_valido: 0, sem_principal: 0 }] };
      }
      if (String(sql).includes("AUDIT_CLIENTES")) {
        return { rows: [{ ativos: 82, com_squad_ativo: 82, em_squad_inativo: 0, sem_squad: 0 }] };
      }
      if (String(sql).includes("AUDIT_TOTAIS_VACUIDADE")) {
        return { rows: [{ squads_ativos: 7, memberships_ativas: 24 }] };
      }
      if (/to_regclass/i.test(sql)) {
        const nomes = (params && params[0]) || [];
        return { rows: nomes.map((n) => ({ nome: n, existe: true })) };
      }
      return { rows: [] };
    },
  };

  const a = await auditoria(db, { garantirSchema: false });
  ok("a query de usuários recebeu a lista canônica", Array.isArray(rolesUsadas));
  ok(`a lista do gate NÃO contém admin (recebeu ${JSON.stringify(rolesUsadas)})`,
    !rolesUsadas.includes("admin"));
  ok("a lista do gate é exatamente ROLES_COBRADAS_NA_AUDITORIA",
    JSON.stringify([...rolesUsadas].sort()) === JSON.stringify([...ROLES_COBRADAS_NA_AUDITORIA.lista].sort()));
  ok("com a lista certa, a base saudável continua liberando", a.pronto === true);
}

async function testarImportadorAceitaAdmin() {
  console.log("\nT-2 · o importador continua ACEITANDO membership de admin");
  const mod = require("../services/squads/squadsMigracaoImportService");
  const plano = {
    versao: 1,
    squads: [{ slug: "alpha", nome: "Alpha", ativo: true }],
    membros: [{ squad: "alpha", usuario: "chefe@empresa.com", funcao: "coordenador", principal: true }],
    clientes: [], responsaveis: [],
  };
  const db = {
    async query(sql, params) {
      if (String(sql).includes("MIG_RESOLVE_SQUADS")) return { rows: [{ id: 1, slug: "alpha", nome: "Alpha", ativo: true }] };
      if (String(sql).includes("MIG_RESOLVE_USERS")) return { rows: [{ id: 7, nome: "Chefe", email: "chefe@empresa.com", role: "admin", ativo: true }] };
      if (/to_regclass/i.test(sql)) {
        const nomes = (params && params[0]) || [];
        return { rows: nomes.map((n) => ({ nome: n, existe: true })) };
      }
      return { rows: [] };
    },
  };
  const r = await mod.validarPlano(plano, db, { garantirSchema: false });
  ok("plano com membership de admin é VÁLIDO", r.ok === true);
  ok("e não gera aviso de role não-interna",
    !(r.avisos || []).some((w) => /role/i.test(w.msg) && /intern/i.test(w.msg)));
}

(async () => {
  testarDivergencia();
  testarFonteUnica();
  testarConsumidoresImportam();
  await testarComportamentoDoGate();
  await testarImportadorAceitaAdmin();
  console.log(`\n✔ squadsRolesInternas: ${checks} verificações OK\n`);
})().catch((e) => { console.error(e); process.exit(1); });
