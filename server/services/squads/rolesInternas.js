// server/services/squads/rolesInternas.js
// VenForce V3 — P2.9, BLOQUEADOR T-2. Fonte CANÔNICA dos papéis "internos".
//
// ─────────────────────────── o problema ───────────────────────────
//
// A noção de "usuário interno" estava escrita em 7 lugares, e em DOIS deles
// com valor diferente: o importador de migração incluía `admin`, a auditoria
// e a autorização não. Nada documentava a diferença, então parecia bug.
//
// ────────────────────── por que são DOIS conjuntos ──────────────────────
//
// Não é bug: são duas perguntas diferentes, e a resposta certa para uma é a
// resposta errada para a outra.
//
//   "quem PODE ter membership de Squad?"      → inclui admin
//   "de quem se COBRA ter membership?"        → exclui admin
//
// Admin tem bypass de carteira (`authorizationService.ehAdmin` retorna antes
// de qualquer checagem de Squad). Logo:
//
//   • COBRAR membership de admin travaria o rollout PARA SEMPRE. O gate exige
//     `usuariosInternos.semMembership === 0` para declarar `pronto`; como todo
//     admin naturalmente não tem membership, o contador nunca zeraria e o
//     enforcement nunca poderia ser ligado — mesmo com a migração 100% certa.
//
//   • PROIBIR membership de admin seria arbitrário: um admin pode legitimamente
//     coordenar um Squad. Fora do conjunto do importador, o plano só emitiria
//     um aviso inócuo.
//
// Por isso unificar os dois num só seria uma REGRESSÃO, não uma limpeza. O que
// faltava era nomear a diferença — é o que este módulo faz.
//
// ──────────────────────────── consumidores ────────────────────────────
//
//   ELEGIVEIS_MEMBERSHIP    → squadsMigracaoImportService (validação de membros[])
//   COBRADAS_NA_AUDITORIA   → squadsMigracaoService (gate/rollout),
//                             authorizationService (carteira em runtime),
//                             squads-inventario-readonly, squads-preflight-relacao
//
// Cada conjunto é exposto em DUAS formas porque os consumidores precisam de
// ambas: `set` para `.has()` e `lista` para virar `$1::text[]` no Postgres.

function conjunto(nomes) {
  const lista = Object.freeze([...nomes]);
  return Object.freeze({ lista, set: new Set(lista) });
}

/**
 * Quem pode RECEBER membership de Squad. Inclui `admin` deliberadamente:
 * um admin coordenar um Squad é legítimo.
 */
const ROLES_ELEGIVEIS_MEMBERSHIP = conjunto(["user", "membro", "interno", "admin"]);

/**
 * De quem a auditoria de rollout COBRA membership. Exclui `admin`
 * deliberadamente: admin tem bypass, e cobrá-lo travaria o gate para sempre.
 */
const ROLES_COBRADAS_NA_AUDITORIA = conjunto(["user", "membro", "interno"]);

/**
 * A diferença entre os dois conjuntos, explícita e testável. Se um dia alguém
 * "consertar" a divergência unificando os conjuntos, o teste que compara esta
 * constante com a diferença real quebra e explica o porquê.
 */
const DIVERGENCIA_INTENCIONAL = Object.freeze({
  roles: Object.freeze(["admin"]),
  motivo:
    "admin tem bypass de carteira: pode ter membership (elegível), mas não " +
    "se cobra que tenha (auditoria). Cobrar deixaria auditoria().pronto " +
    "permanentemente falso e o enforcement nunca poderia ser ligado.",
});

module.exports = {
  ROLES_ELEGIVEIS_MEMBERSHIP,
  ROLES_COBRADAS_NA_AUDITORIA,
  DIVERGENCIA_INTENCIONAL,
};
