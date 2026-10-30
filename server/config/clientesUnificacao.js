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
// Só transações READ ONLY (preview). Também define o statement_timeout delas.
function previewTimeoutMs(env = process.env) {
  const raw = String(env.CLIENTES_UNIFICACAO_PREVIEW_TIMEOUT_MS || "");
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(value) && value >= 15000 && value <= 300000
    ? value
    : 120000;
}
// Orçamento global da transação de ESCRITA (execute/rollback). Também define
// o statement_timeout dela. Inválido ou fora da faixa → default seguro.
function executeTimeoutMs(env = process.env) {
  const raw = String(env.CLIENTES_UNIFICACAO_EXECUTE_TIMEOUT_MS || "");
  const value = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(value) && value >= 15000 && value <= 300000
    ? value
    : 120000;
}
module.exports = { flags, enabled, previewTimeoutMs, executeTimeoutMs };
