// Políticas auditadas do catálogo de #254. Nunca recebe nomes SQL do manifesto.
const { centralPolicy } = require("./centralReferenceScope");
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
  // Sentinel: pedido guarda cliente_id (FK) + cliente_conta_id; a Conta não
  // muda na unificação, só o dono ⇒ cliente_id vai para o canônico.
  "sentinel_pedidos",
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
  // Sentinel: chaveadas só pela Conta (sem cliente_id); a Conta sobrevive à
  // unificação com o mesmo id ⇒ nada a mover. Eventos seguem o incidente pela
  // FK (mesmo caso de fechamento_incidente_arquivos).
  "sentinel_checkpoints",
  "sentinel_pedido_excecoes",
  "sentinel_incidentes",
  "sentinel_incidente_eventos",
  // Conciliação da comissão (S1, migration 20261119): chaveada só por (Conta, pedido), FK em sentinel_pedidos.
  "sentinel_conciliacao_comissao",
  // Shopee: grant chaveado só pela Conta (sem cliente_id); a Conta sobrevive à
  // unificação com o mesmo id ⇒ o grant segue junto, nada a mover.
  "shopee_grants",
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
  // Central: só o shape auditado em centralReferenceScope; resto bloqueia.
  if (table.startsWith("central_vendas_"))
    return centralPolicy(table)?.strategy || "BLOCKED_UNKNOWN";
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
