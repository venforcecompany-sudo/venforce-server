// server/services/raioX/raioXRegistro.js
//
// Registro das tabelas que guardam dado de um Cliente, para o Raio-X.
// Fonte: auditoria do purge (clienteDependenciasService.TABELAS_DEPENDENTES /
// clientePurgeService) + leitura do código desta missão
// (docs/banco-de-dados/). Cada entrada declara SÓ o que foi confirmado no
// código; a identidade (cliente_id / cliente_conta_id / cliente_slug) é
// DESCOBERTA em tempo de execução pelo information_schema — tabela ou coluna
// ausente no banco vira "nao_existe", nunca erro.
//
// Campos:
//   tabela, dominio, modulos (quem consome — telas/serviços), classe
//   (canonica | derivada | snapshot | cache | historico | auditoria | config),
//   origem (de onde vem o dado), manual (true = digitado/enviado por pessoa:
//   NUNCA apagar sem decisão explícita), reconstruivel (sim | nao | parcial),
//   via (tabela filha sem identidade própria: conta pelo pai — só no modo
//   detalhado, porque pode ser cara).

const R = (tabela, dominio, extra) => ({ tabela, dominio, modulos: [], classe: "canonica", origem: null,
  manual: false, reconstruivel: "nao", via: null, ...extra });

const REGISTRO = [
  // Clientes e contas
  R("cliente_contas", "Clientes e contas", { modulos: ["Clientes", "todas as telas por conta"], classe: "config", origem: "cadastro (usuário)", manual: true }),
  R("ml_tokens", "Clientes e contas", { modulos: ["sync Central", "Sentinel", "Anúncios", "Margem"], classe: "config", origem: "OAuth Mercado Livre", reconstruivel: "parcial" }),
  R("shopee_grants", "Clientes e contas", { modulos: ["Shopee admin"], classe: "config", origem: "OAuth Shopee", reconstruivel: "parcial" }),
  R("cliente_squad_history", "Squads e permissões", { modulos: ["Squads"], classe: "historico", origem: "usuário", manual: true }),
  R("cliente_responsaveis", "Squads e permissões", { modulos: ["Squads", "Carteira"], classe: "config", origem: "usuário", manual: true }),
  R("seller_clientes", "Squads e permissões", { modulos: ["Portal do seller"], classe: "config", origem: "usuário", manual: true }),

  // Central de Vendas
  R("central_vendas_imports", "Central de Vendas", { modulos: ["Painel de Contas", "Cliente 360", "Central de Margem (realizado)", "Fechamento via API", "Financeiro V3"], classe: "snapshot", origem: "API ML (sync) ou planilha (manual)", reconstruivel: "parcial" }),
  R("central_vendas_pedidos", "Central de Vendas", { classe: "snapshot", origem: "derivado do import", reconstruivel: "parcial", via: { pai: "central_vendas_imports", fk: "import_id" } }),
  R("central_vendas_pedido_itens", "Central de Vendas", { classe: "snapshot", origem: "derivado do import", reconstruivel: "parcial", via: { pai: "central_vendas_imports", fk: "import_id" } }),
  R("central_vendas_componentes", "Central de Vendas", { classe: "snapshot", origem: "derivado do import", reconstruivel: "parcial", via: { pai: "central_vendas_imports", fk: "import_id" } }),
  R("central_vendas_sync_runs", "Central de Vendas", { modulos: ["Painel de Contas (status)", "Control Center"], classe: "auditoria", origem: "worker de sync", reconstruivel: "nao" }),
  R("central_vendas_sync_sources", "Central de Vendas", { classe: "auditoria", origem: "worker de sync", via: { pai: "central_vendas_sync_runs", fk: "sync_run_id" } }),

  // Mercado Pago (conciliação auxiliar)
  R("central_vendas_mp_payments", "Mercado Pago", { modulos: ["Conciliação MP (Financeiro V3)"], classe: "historico", origem: "API Mercado Pago /v1/payments (por run)", reconstruivel: "sim" }),
  R("central_vendas_mp_payment_charges", "Mercado Pago", { modulos: ["Conciliação MP"], classe: "historico", origem: "API Mercado Pago", reconstruivel: "sim", via: { pai: "central_vendas_mp_payments", fk: "mp_payment_row_id" } }),
  R("central_vendas_mp_settlement_reports", "Mercado Pago", { modulos: ["Conciliação MP"], classe: "historico", origem: "Settlement Report MP", reconstruivel: "parcial" }),

  // Painel / Cliente 360 / Financeiro
  R("painel_contas_lancamentos_manuais", "Painel de Contas", { modulos: ["Painel de Contas"], origem: "digitação do usuário", manual: true }),
  R("painel_contas_lancamentos_manuais_historico", "Painel de Contas", { modulos: ["Painel de Contas"], classe: "historico", origem: "digitação do usuário", manual: true }),
  R("cliente_360_resumos_mensais", "Cliente 360", { modulos: ["Cliente 360", "Painel de Contas", "Dashboard"], classe: "snapshot", origem: "derivado (Central/manual)", reconstruivel: "parcial" }),
  R("cliente_360_sync_jobs", "Cliente 360", { classe: "auditoria", origem: "jobs de sync do 360" }),
  R("cliente_360_diagnosticos", "Cliente 360", { modulos: ["Cliente 360"], classe: "derivada", origem: "motor de diagnóstico", reconstruivel: "sim" }),
  R("cliente_360_frete_historico", "Cliente 360", { modulos: ["Cliente 360"], classe: "historico", origem: "derivado" }),
  R("cliente_360_acoes", "Cliente 360", { modulos: ["Placar de Impacto"], origem: "usuário", manual: true }),
  R("entregas_cliente", "Financeiro e fechamentos", { modulos: ["Financeiro", "relatório público", "Cliente 360"], classe: "historico", origem: "fechamento publicado (usuário)", manual: true }),

  // Margem / Promoções / Anúncios / Ads
  R("margin_projection_snapshots", "Central de Margem", { modulos: ["Central de Margem"], classe: "snapshot", origem: "motor de margem (projeção)", reconstruivel: "sim" }),
  R("margin_snapshot_runs", "Central de Margem", { classe: "auditoria", origem: "worker de margem" }),
  R("anuncios_margem_projetada_snapshot", "Central de Margem", { classe: "snapshot", origem: "margem projetada", reconstruivel: "sim" }),
  R("margem_precificacao_aplicacoes", "Central de Margem", { modulos: ["Cockpit de precificação"], classe: "auditoria", origem: "ação do usuário (preço aplicado no ML)", manual: true }),
  R("promo_snapshot_contas", "Promoções", { classe: "snapshot", origem: "API ML promoções", reconstruivel: "sim" }),
  R("promo_snapshot_itens", "Promoções", { modulos: ["Central de Promoções"], classe: "snapshot", origem: "API ML promoções", reconstruivel: "sim" }),
  R("promocoes_diagnosticos", "Promoções", { classe: "derivada", origem: "diagnóstico", reconstruivel: "sim" }),
  R("meli_anuncios", "Anúncios", { modulos: ["Anúncios ML"], classe: "cache", origem: "API ML itens", reconstruivel: "sim" }),
  R("meli_anuncio_otimizacoes", "Anúncios", { classe: "historico", origem: "ação do usuário", manual: true }),
  R("meli_anuncio_publicacoes", "Anúncios", { classe: "historico", origem: "ação do usuário", manual: true }),
  R("ads_resumos_mensais", "Ads", { modulos: ["Ads", "Cliente 360"], classe: "snapshot", origem: "API ML Ads", reconstruivel: "parcial" }),
  R("ads_acompanhamentos", "Ads", { modulos: ["Ads"], origem: "usuário", manual: true }),

  // Sentinel
  R("sentinel_pedidos", "Sentinel", { modulos: ["Pedidos ao vivo"], classe: "historico", origem: "polling ML (incremental)", reconstruivel: "parcial" }),
  R("sentinel_incidentes", "Sentinel", { modulos: ["Pedidos ao vivo"], classe: "historico", origem: "Sentinel" }),
  R("sentinel_checkpoints", "Sentinel", { classe: "config", origem: "Sentinel", reconstruivel: "sim" }),
  R("sentinel_pedido_excecoes", "Sentinel", { origem: "usuário", manual: true }),

  // Custos, relatórios, diagnósticos, design
  R("base_cliente_vinculos", "Custos e bases", { modulos: ["Bases", "sync Central (custo)", "Margem"], classe: "config", origem: "usuário", manual: true }),
  R("seller_custos_submissoes", "Custos e bases", { origem: "seller (planilha)", manual: true }),
  R("relatorios", "Relatórios", { modulos: ["Relatórios"], classe: "historico", origem: "scanner/relatório gerado", reconstruivel: "parcial" }),
  R("diagnosticos_iniciais", "Relatórios", { classe: "historico", origem: "usuário", manual: true }),
  R("design_client_profiles", "Design Studio", { origem: "usuário", manual: true, classe: "config" }),
  R("design_templates", "Design Studio", { origem: "usuário", manual: true }),
  R("design_artworks", "Design Studio", { origem: "usuário", manual: true }),
];

// Ordem de preferência para descobrir colunas (a primeira que existir vence).
const COLUNAS_IDENTIDADE = ["cliente_id", "cliente_conta_id", "cliente_slug"];
const COLUNAS_PERIODO = ["competencia", "data_pedido", "date_from", "data", "created_at"];
const COLUNAS_ULTIMA_ESCRITA = ["updated_at", "sincronizado_em", "finished_at", "created_at"];

module.exports = { REGISTRO, COLUNAS_IDENTIDADE, COLUNAS_PERIODO, COLUNAS_ULTIMA_ESCRITA };
