// server/services/clientes/clienteDependenciasService.js
//
// A auditoria de clientes/contas encontrou um risco crítico: DELETE
// /clientes/:slug é hard delete e mistura CASCADE destrutivo (grants,
// Cliente 360, Seller, Design, diagnósticos, contas) com tabelas SEM FK que
// ficam órfãs (Central de Vendas, Ads, Otimizador ML, anúncios, Relatórios).
// Esta função audita TODAS as tabelas que guardam dado real do Cliente —
// tanto as que o Postgres já cuida sozinho via ON DELETE CASCADE quanto as
// que não têm FK nenhuma — para que o admin veja, antes de decidir, o que
// realmente existe (ver clientePurgeService.js para o que cada grupo exige
// na hora de apagar de verdade).
//
// Deliberadamente FORA desta lista (não conta como "dependência" que trava
// exclusão simples nem aparece no modal): tabelas estruturais que TODO
// cliente tem por contrato (cliente_squad_history, cliente_responsaveis —
// squad é obrigatório desde a missão "Cliente↔Squad") e logs/auditoria de
// infraestrutura com ON DELETE SET NULL (callbacks, fechamento_incidentes)
// — esses sobrevivem à exclusão do cliente com a referência nulificada,
// exatamente como já são desenhados, e não são "dado do cliente" no sentido
// que o admin precisa avaliar antes de excluir.

const pool = require("../../config/database");

// (label exibido, tabela, coluna de identidade do cliente, tipo da coluna)
// tipo "id"   -> filtra por cliente_id (=$1, o id numérico)
// tipo "slug" -> filtra por cliente_slug (=$2, o slug) — tabelas que nunca
//                ganharam cliente_id (ex.: Ads, indexado só por slug)
const TABELAS_DEPENDENTES = [
  ["Contas de marketplace", "cliente_contas", "cliente_id", "id"],
  ["Grants Mercado Livre", "ml_tokens", "cliente_id", "id"],
  ["Vínculos de base", "base_cliente_vinculos", "cliente_id", "id"],
  ["Entregas/fechamentos", "entregas_cliente", "cliente_id", "id"],
  ["Relatórios", "relatorios", "cliente_id", "id"],
  ["Diagnósticos iniciais", "diagnosticos_iniciais", "cliente_id", "id"],
  ["Permissões de seller", "seller_clientes", "cliente_id", "id"],
  ["Custos de seller", "seller_custos_submissoes", "cliente_id", "id"],
  ["Perfil do Design Studio", "design_client_profiles", "cliente_id", "id"],
  ["Templates do Design Studio", "design_templates", "cliente_id", "id"],
  ["Artes do Design Studio", "design_artworks", "cliente_id", "id"],
  ["Catálogo de anúncios ML", "meli_anuncios", "cliente_id", "id"],
  ["Otimizações de anúncios ML", "meli_anuncio_otimizacoes", "cliente_id", "id"],
  ["Publicações de anúncios ML", "meli_anuncio_publicacoes", "cliente_id", "id"],
  ["Imports da Central de Vendas", "central_vendas_imports", "cliente_id", "id"],
  ["Sincronizações da Central de Vendas", "central_vendas_sync_runs", "cliente_id", "id"],
  ["Resumos do Cliente 360", "cliente_360_resumos_mensais", "cliente_id", "id"],
  ["Diagnósticos do Cliente 360", "cliente_360_diagnosticos", "cliente_id", "id"],
  ["Histórico de frete do Cliente 360", "cliente_360_frete_historico", "cliente_id", "id"],
  ["Ações registradas (Placar de Impacto)", "cliente_360_acoes", "cliente_id", "id"],
  ["Diagnósticos de promoções", "promocoes_diagnosticos", "cliente_id", "id"],
  ["Acompanhamento de Ads", "ads_acompanhamentos", "cliente_slug", "slug"],
  ["Resumos mensais de Ads", "ads_resumos_mensais", "cliente_slug", "slug"],
];

async function tabelaExiste(tabela) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1`,
    [tabela]
  );
  return r.rows.length > 0;
}

async function verificarDependenciasCliente(clienteId, clienteSlug) {
  const dependencias = [];
  for (const [label, tabela, coluna, tipo] of TABELAS_DEPENDENTES) {
    const valor = tipo === "slug" ? clienteSlug : clienteId;
    if (valor === undefined || valor === null) continue;
    // eslint-disable-next-line no-await-in-loop
    if (!(await tabelaExiste(tabela))) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await pool.query(`SELECT COUNT(*)::int AS total FROM ${tabela} WHERE ${coluna} = $1`, [valor]);
    const total = r.rows[0]?.total || 0;
    if (total > 0) dependencias.push({ label, tabela, total });
  }
  return dependencias;
}

module.exports = { verificarDependenciasCliente, TABELAS_DEPENDENTES };
