// Políticas auditadas do catálogo de #254. Nunca recebe nomes SQL do manifesto.
const move = [
  "meli_anuncios",
  "meli_user_products",
  "margin_projection_snapshots",
  "anuncios_margem_projetada_snapshot",
  "painel_contas_lancamentos_manuais",
  "painel_contas_lancamentos_manuais_historico",
  "promo_snapshot_contas",
  "promo_snapshot_runs",
  "promo_snapshot_itens",
  "margin_snapshot_runs",
  "meli_anuncio_otimizacoes",
  "diagnosticos_iniciais",
  "cliente_imagens",
  "design_artworks",
  "design_templates",
  "design_client_profiles",
  "ads_acompanhamentos",
  "ads_resumos_mensais",
  "cliente_360_diagnosticos",
  "cliente_360_frete_historico",
  "cliente_360_resumos_mensais",
  "cliente_360_sync_jobs",
  "seller_custos_submissoes",
  "relatorios",
  "entregas_cliente",
  "fechamento_incidentes",
  "promocoes_diagnosticos",
  "margem_precificacao_aplicacoes",
];
const keep = [
  "cliente_squad_history",
  "cliente_responsaveis",
  "seller_clientes",
  "callbacks",
  "scans",
];
const authoritative = [
  "user_bases",
  "custos",
  "design_artwork_versions",
  "design_template_versions",
  "relatorio_itens",
  "promocoes_diagnostico_itens",
  "cliente_360_diagnostico_itens",
  "fechamento_incidente_arquivos",
  "promo_snapshot_run_lotes",
];
const registry = Object.fromEntries([
  ...move.map((t) => [t, "MOVE_TO_CANONICAL"]),
  ...keep.map((t) => [t, "KEEP_AS_LEGACY_ORIGIN"]),
  ...authoritative.map((t) => [t, "ACCOUNT_ALREADY_AUTHORITATIVE"]),
]);
const core = new Set([
  "clientes",
  "cliente_contas",
  "ml_tokens",
  "bases",
  "base_cliente_vinculos",
  "squads",
  "squad_members",
]);
const infrastructure = new Set([
  "cliente_unificacoes",
  "cliente_unificacao_events",
]);
const identityColumns = new Set([
  "cliente_id",
  "cliente_conta_id",
  "cliente_slug",
  "base_id",
  "grant_id",
  "seller_id",
  "ml_user_id",
  "external_account_id",
  "base_slug",
  "conta_ml",
]);
const secretColumns =
  /(?:token|password|senha|secret|api_key|jwt|database_url|payload|metadata|document|identity_json|respostas|diagnostico_gerado|diagnostico_revisado|query_json|conteudo|error_message|erro_mensagem|erro|raw_response|fingerprint_json|calculo_json|gates_json|detalhes|valores_json|resumo_json|observacoes|observacao|feedback_text|checklist|motivo|imagem)/i;
function strategy(table) {
  // Filtros e redundâncias da Central exigem trabalho separado, sem alterar P0.
  if (table.startsWith("central_vendas_")) return "BLOCKED_UNKNOWN";
  return registry[table] || "BLOCKED_UNKNOWN";
}
module.exports = {
  registry,
  core,
  infrastructure,
  identityColumns,
  secretColumns,
  strategy,
};
