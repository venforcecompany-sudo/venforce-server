// O projeto não possui parser genérico exportado; a config de Squads tem gate
// próprio. Aqui só "true" explícito habilita, sem compartilhar esse gate.
const enabled = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase() === "true";
function flags(env = process.env) {
  return {
    execute: enabled(env.CLIENTES_UNIFICACAO_EXECUTE_ENABLED),
    rollback: enabled(env.CLIENTES_UNIFICACAO_ROLLBACK_ENABLED),
  };
}
module.exports = { flags, enabled };
